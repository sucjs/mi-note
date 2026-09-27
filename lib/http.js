"use strict";

/**
 * 极简 HTTP 客户端 + Cookie 罐。
 *
 * 为什么不用宿主 pi.net.fetch：
 *   宿主把响应头收集进普通对象（`res.headers.forEach`），多个 Set-Cookie 会互相
 *   覆盖。小米扫码登录恰恰依赖「一次响应里多个 Set-Cookie」建立会话，因此登录与
 *   续期必须走插件进程自己的 socket，才能拿到完整的 Set-Cookie 列表。
 *
 * 只用 node 内置模块，插件不依赖任何 npm 包。
 */

const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── Cookie 罐 ───────────────────────────────────────────────────────────────

/** 域名是否覆盖（RFC6265 的简化实现：host-only 精确匹配，Domain 后缀匹配）。 */
function domainMatches(host, cookieDomain, hostOnly) {
  const h = String(host || "").toLowerCase();
  const d = String(cookieDomain || "").toLowerCase().replace(/^\./, "");
  if (!d) return false;
  if (hostOnly) return h === d;
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(requestPath, cookiePath) {
  const p = cookiePath && cookiePath.startsWith("/") ? cookiePath : "/";
  if (p === "/") return true;
  const rp = requestPath && requestPath.startsWith("/") ? requestPath : "/";
  return rp === p || rp.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function isExpired(entry, now) {
  if (!entry.expires) return false;
  return entry.expires <= now;
}

class CookieJar {
  constructor(entries = []) {
    /** @type {Map<string, {name:string, value:string, domain:string, path:string, hostOnly:boolean, expires:number|null}>} */
    this.store = new Map();
    for (const entry of entries) {
      if (!entry || !entry.name) continue;
      this.store.set(`${entry.domain}|${entry.path || "/"}|${entry.name}`, {
        name: String(entry.name),
        value: String(entry.value ?? ""),
        domain: String(entry.domain || "").toLowerCase(),
        path: entry.path || "/",
        hostOnly: entry.hostOnly !== false,
        expires: typeof entry.expires === "number" ? entry.expires : null,
      });
    }
  }

  static fromJSON(list) {
    return new CookieJar(Array.isArray(list) ? list : []);
  }

  toJSON() {
    return [...this.store.values()];
  }

  clone() {
    return CookieJar.fromJSON(this.toJSON());
  }

  clear() {
    this.store.clear();
  }

  /** 解析一行 Set-Cookie，写入罐中。 */
  setCookieLine(line, requestUrl) {
    if (!line || typeof line !== "string") return;
    const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
    const parts = line.split(";");
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return;

    let domain = url.hostname.toLowerCase();
    let hostOnly = true;
    let path = defaultPath(url.pathname);
    let expires = null;

    for (const raw of parts) {
      const attr = raw.trim();
      if (!attr) continue;
      const i = attr.indexOf("=");
      const key = (i >= 0 ? attr.slice(0, i) : attr).trim().toLowerCase();
      const val = i >= 0 ? attr.slice(i + 1).trim() : "";
      if (key === "domain" && val) {
        domain = val.toLowerCase().replace(/^\./, "");
        hostOnly = false;
      } else if (key === "path" && val) {
        path = val;
      } else if (key === "max-age") {
        const seconds = Number(val);
        if (Number.isFinite(seconds)) {
          expires = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
        }
      } else if (key === "expires" && expires === null) {
        const ts = Date.parse(val);
        if (Number.isFinite(ts)) expires = ts;
      }
    }

    const storeKey = `${domain}|${path}|${name}`;
    if (expires !== null && expires !== 0 && expires <= Date.now()) {
      this.store.delete(storeKey);
      return;
    }
    if (expires === 0) {
      this.store.delete(storeKey);
      // 显式删除也可能针对另一条 path，一并清理同名项
      for (const [k, entry] of [...this.store]) {
        if (entry.name === name) this.store.delete(k);
      }
      return;
    }
    this.store.set(storeKey, { name, value, domain, path, hostOnly, expires });
  }

  /** 应用一个响应里的全部 Set-Cookie。 */
  applySetCookie(setCookieHeaders, requestUrl) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const line of list) this.setCookieLine(line, requestUrl);
  }

  /** 某个主机可用 cookie 中，某名字取值（更具体的 path 优先）。 */
  get(name, host, requestPath = "/") {
    const best = this.find(name, host, requestPath);
    return best ? best.value : null;
  }

  find(name, host, requestPath = "/") {
    const now = Date.now();
    const candidates = [];
    for (const entry of this.store.values()) {
      if (entry.name !== name) continue;
      if (isExpired(entry, now)) continue;
      if (!domainMatches(host, entry.domain, entry.hostOnly)) continue;
      if (!pathMatches(requestPath, entry.path)) continue;
      candidates.push(entry);
    }
    candidates.sort((a, b) => b.path.length - a.path.length);
    return candidates[0] ?? null;
  }

  has(name, host, requestPath = "/") {
    return this.find(name, host, requestPath) !== null;
  }

  /** 拼出某个请求应带的 Cookie 头。 */
  cookieHeader(host, requestPath = "/") {
    const now = Date.now();
    const picked = new Map();
    for (const entry of this.store.values()) {
      if (isExpired(entry, now)) continue;
      if (!domainMatches(host, entry.domain, entry.hostOnly)) continue;
      if (!pathMatches(requestPath, entry.path)) continue;
      const prev = picked.get(entry.name);
      if (!prev || entry.path.length > prev.path.length) picked.set(entry.name, entry);
    }
    return [...picked.values()].map((e) => `${e.name}=${e.value}`).join("; ");
  }

  /** 手工写入一个 cookie（用于把 JSON 里带回来的长效票据塞进罐子）。 */
  set(name, value, { domain, host, path = "/", hostOnly = true, expires = null } = {}) {
    const d = String(domain || host || "").toLowerCase().replace(/^\./, "");
    if (!d) return;
    this.store.set(`${d}|${path}|${name}`, {
      name,
      value: String(value ?? ""),
      domain: d,
      path,
      hostOnly: domain ? false : hostOnly,
      expires,
    });
  }

  /** 摘出某域名下的全部 cookie 名值对（调试/导出用）。 */
  listFor(host) {
    const out = {};
    for (const entry of this.store.values()) {
      if (!domainMatches(host, entry.domain, entry.hostOnly)) continue;
      out[entry.name] = entry.value;
    }
    return out;
  }
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith("/")) return "/";
  const idx = pathname.lastIndexOf("/");
  if (idx <= 0) return "/";
  return pathname.slice(0, idx);
}

// ── 请求 ────────────────────────────────────────────────────────────────────

function decompress(buffer, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (!enc || enc === "identity") return buffer;
    if (enc.includes("br")) return zlib.brotliDecompressSync(buffer);
    if (enc.includes("gzip")) return zlib.gunzipSync(buffer);
    if (enc.includes("deflate")) return zlib.inflateSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

/**
 * 发一次请求（不跟随重定向）。
 * @returns {Promise<{status:number, headers:object, buffer:Buffer, text:string, url:string}>}
 */
function requestOnce(urlStr, options = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeout = 20000,
    jar = null,
    sendUserAgent = true,
    signal = null,
  } = options;

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (error) {
      reject(new Error(`无效 URL：${urlStr}`));
      return;
    }
    const lib = url.protocol === "http:" ? http : https;
    /** @type {Record<string,string>} */
    const finalHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) finalHeaders[key] = String(value);
    }
    if (sendUserAgent && !finalHeaders["User-Agent"] && !finalHeaders["user-agent"]) {
      finalHeaders["User-Agent"] = DEFAULT_UA;
    }
    if (!finalHeaders["Accept-Encoding"] && !finalHeaders["accept-encoding"]) {
      finalHeaders["Accept-Encoding"] = "gzip, deflate, br";
    }
    if (jar) {
      const cookie = jar.cookieHeader(url.hostname, url.pathname);
      if (cookie) finalHeaders.Cookie = cookie;
    }

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: finalHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (jar) jar.applySetCookie(res.headers["set-cookie"], url);
          let buffer = Buffer.concat(chunks);
          buffer = decompress(buffer, res.headers["content-encoding"]);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer,
            text: buffer.toString("utf8"),
            url: urlStr,
          });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时（${timeout}ms）：${urlStr}`));
    });
    // 中止支持：长轮询要能被「取消登录」立刻打断，而不是干等超时
    if (signal) {
      const onAbort = () => req.destroy(abortError());
      if (signal.aborted) {
        req.destroy(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/** 中止标记：调用方据此区分「被取消」与「真失败」。 */
function abortError() {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  error.aborted = true;
  return error;
}

/** 手动跟随重定向（每次都带上罐子里的 cookie）。 */
async function request(urlStr, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = urlStr;
  let response = null;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    response = await requestOnce(current, options);
    const status = response.status;
    if (status < 300 || status > 399) return response;
    const location = response.headers?.location;
    if (!location) return response;
    current = new URL(location, current).toString();
  }
  return response;
}

function encodeForm(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/** 可读的错误对象：把 HTTP 状态与响应片段带出来。 */
class HttpError extends Error {
  constructor(message, { status = 0, code = "", body = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

module.exports = {
  CookieJar,
  DEFAULT_UA,
  HttpError,
  encodeForm,
  request,
  requestOnce,
};
