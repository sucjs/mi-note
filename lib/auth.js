"use strict";

/**
 * 小米账号登录：扫码登录。
 *
 * 为什么是扫码：账号密码登录会撞上图形验证码 / 两步验证，而那些流程无法在插件里
 * 无人值守完成。扫码登录把「确认」留在用户手机上，插件只负责长轮询结果，因此不受
 * 验证码与 2FA 影响，也不需要用户手工复制任何 Cookie。
 *
 * 协议（全部实证过）：
 *   1. GET https://i.mi.com/api/user/login?followUp=…   → 拿到 account.xiaomi.com 的
 *      serviceLogin 地址（带 i.mi.com 的 callback/sign）
 *   2. GET 该地址（跟随 302）                            → /fe/service/login?qs=…&callback=…
 *   3. GET https://account.xiaomi.com/longPolling/loginUrl?<qs/callback/sid…>
 *      → { qr（二维码图片 URL）, lp（长轮询 URL）, timeout: 300, loginUrl }
 *   4. GET qr → PNG 字节，交给面板显示
 *   5. GET lp → 阻塞直到用户在手机上确认，返回 200 + JSON { location, userId, … }
 *   6. GET location（带 Cookie 罐）→ 响应里 Set-Cookie 含 serviceToken
 *
 * 不做自动续期（0.2.6 起移除）。
 *
 * 曾经尝试过：带着长效票据 passToken 再走一次 serviceLogin 换新的 serviceToken。
 * 实测走不通 —— 无人交互时该接口只返回图形/短信验证的挑战字段（notificationUrl、
 * captchaUrl、pwd、securityStatus），并且只给「登录前」的临时密钥 psecurity，
 * 从不给正式的 ssecurity。而 serviceToken 本身是会话 Cookie（无 expires），
 * 实测寿命约 40 分钟，到期只能重新扫码。
 * 留着一套必然失败、还会在掉线时误报「登录已失效」的续期代码没有意义，
 * 因此删掉：会话失效时如实提示用户重新扫码登录。
 */

const { CookieJar, encodeForm, request } = require("./http.js");

const ACCOUNT_BASE = "https://account.xiaomi.com";
const MI_BASE = "https://i.mi.com";
const SID = "i.mi.com";
const QR_SIZE = 300;
/** 长轮询单次请求超时：服务端 300s 有效期内会挂起连接，这里给足余量。 */
const POLL_TIMEOUT_MS = 35_000;

/** 面板显示用的请求头，模拟 note web 端。 */
const NOTE_HEADERS = {
  Referer: `${MI_BASE}/note/h5`,
  Origin: MI_BASE,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

function stripJsonPrefix(text) {
  const marker = "&&&START&&&";
  const idx = text.indexOf(marker);
  const body = idx >= 0 ? text.slice(idx + marker.length) : text;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`小米账号返回了非 JSON 响应：${body.slice(0, 120)}`);
  }
}

function isXiaomiSuccess(payload) {
  return payload?.result === "ok" || payload?.code === 0;
}

/**
 * 扫码登录会话。
 *
 * 生命周期：create() 拿二维码 → poll() 等用户确认 → 成功后 settle() 用 location 换
 * serviceToken。过期后由面板调用 create() 重新获取。
 */
class QrLoginSession {
  constructor() {
    this.jar = new CookieJar();
    /** @type {{loginUrl:string, qr:string, lp:string, expiresAt:number}|null} */
    this.ticket = null;
    this.createdAt = 0;
    this.closed = false;
    /** @type {AbortController|null} 长轮询进行中的中止控制器 */
    this.abortController = null;
  }

  get expired() {
    return !this.ticket || Date.now() >= this.ticket.expiresAt;
  }

  /**
   * 第 1~3 步：拿到二维码与其长轮询地址。
   * @returns {Promise<{qrPng:Buffer, expiresAt:number, expiresInSeconds:number}>}
   */
  async create() {
    // 步骤 1：问 i.mi.com 要登录入口
    const followUp = `${MI_BASE}/note/h5#/`;
    const loginProbe = await request(
      `${MI_BASE}/api/user/login?followUp=${encodeURIComponent(followUp)}&_locale=zh_CN`,
      { jar: this.jar, headers: NOTE_HEADERS, timeout: 20_000 },
    );
    let loginUrl = "";
    try {
      const payload = JSON.parse(loginProbe.text);
      loginUrl = payload?.data?.loginUrl ?? "";
    } catch {
      loginUrl = "";
    }
    if (!loginUrl) {
      throw new Error(
        `未能获取小米登录入口（HTTP ${loginProbe.status}）：${loginProbe.text.slice(0, 160)}`,
      );
    }

    // 步骤 2：跟随跳转，最终落在 /fe/service/login，其 query 就是扫码所需参数
    const landed = await request(loginUrl, {
      jar: this.jar,
      headers: { ...NOTE_HEADERS, Accept: "text/html,application/xhtml+xml" },
      timeout: 20_000,
    });
    const landedUrl = landed.url || loginUrl;
    const params = extractLoginParams(landedUrl);

    // 步骤 3：要二维码
    const query = new URLSearchParams({
      _qrsize: String(QR_SIZE),
      qs: params.qs,
      callback: params.callback,
      sid: params.sid || SID,
      _hasLogo: "false",
      _locale: params._locale || "zh_CN",
      _dc: String(Date.now()),
    });
    if (params.serviceParam) query.set("serviceParam", params.serviceParam);
    if (params._group) query.set("_group", params._group);

    const qrResp = await request(`${ACCOUNT_BASE}/longPolling/loginUrl?${query}`, {
      jar: this.jar,
      headers: NOTE_HEADERS,
      timeout: 20_000,
    });
    const payload = stripJsonPrefix(qrResp.text);
    if (!isXiaomiSuccess(payload) || !payload.lp || !payload.qr) {
      throw new Error(
        `获取二维码失败：${payload.description || payload.desc || qrResp.text.slice(0, 160)}`,
      );
    }

    // timeout 由服务端给出（实测 300 秒 = 5 分钟）；给 10 秒余量避免边界抖动
    const ttlSeconds = Number(payload.timeout) > 0 ? Number(payload.timeout) : 300;
    const expiresAt = Date.now() + Math.max(30, ttlSeconds - 10) * 1000;

    const png = await request(payload.qr, { jar: this.jar, timeout: 20_000 });
    if (png.status !== 200 || !png.buffer.length) {
      throw new Error(`下载二维码图片失败（HTTP ${png.status}）`);
    }

    this.ticket = {
      loginUrl: String(payload.loginUrl ?? ""),
      qr: String(payload.qr),
      lp: String(payload.lp),
      expiresAt,
    };
    this.createdAt = Date.now();
    this.closed = false;

    return {
      qrPng: png.buffer,
      expiresAt,
      expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000),
    };
  }

  /**
   * 第 5 步：长轮询等用户扫码确认。
   *
   * 服务端在用户还没扫码时挂起连接：HTTP 200 才代表已确认（响应体里带 location）。
   * 连接被服务端提前断开（400/其它）只是这一轮没有结果，继续轮询即可，直到过期。
   *
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<{status:"pending"|"confirmed"|"expired", location?:string, userId?:string}>}
   */
  async poll(options = {}) {
    if (!this.ticket) return { status: "expired" };
    let idleRounds = 0;
    // 用自己的 controller 让 close() 能立刻打断挂在服务端的长连接，
    // 不必干等这一轮的 35 秒超时；外部传入的 signal 一并接入。
    const controller = new AbortController();
    this.abortController = controller;
    const external = options.signal;
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      while (!this.closed) {
        if (this.expired) return { status: "expired" };
        if (controller.signal.aborted) return { status: "pending" };
        try {
          const resp = await request(this.ticket.lp, {
            jar: this.jar,
            headers: NOTE_HEADERS,
            timeout: POLL_TIMEOUT_MS,
            signal: controller.signal,
          });
          if (resp.status === 200 && resp.text.trim()) {
            const payload = stripJsonPrefix(resp.text);
            if (payload?.location) {
              return {
                status: "confirmed",
                location: String(payload.location),
                userId: String(payload.userId ?? ""),
              };
            }
            // 200 但没 location：服务端返回了错误体，视为这一轮无效
            idleRounds += 1;
          } else {
            idleRounds += 1;
          }
        } catch (error) {
          if (error?.aborted || controller.signal.aborted || this.closed) {
            return { status: "pending" };
          }
          // 超时/断连都只是「还没有结果」，短暂退避后继续，避免打满服务端
          idleRounds += 1;
          if (idleRounds > 3) {
            await sleep(600);
            idleRounds = 0;
          }
        }
      }
      return { status: "pending" };
    } finally {
      if (external) external.removeEventListener("abort", onExternalAbort);
      if (this.abortController === controller) this.abortController = null;
    }
  }

  /**
   * 第 6 步：用 location 换 serviceToken，返回可持久化的凭据。
   * @returns {Promise<object>} 序列化后的凭据
   */
  async settle(location, fallbackUserId = "") {
    const resp = await request(location, {
      jar: this.jar,
      headers: { ...NOTE_HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      timeout: 20_000,
    });
    return this.snapshot(resp.status, fallbackUserId);
  }

  /**
   * 从当前罐子读出凭据。serviceToken 缺失即视为登录失败。
   * @returns {object}
   */
  snapshot(httpStatus = 0, fallbackUserId = "") {
    const serviceToken = this.jar.get("serviceToken", MI_BASE_HOST) ||
      this.jar.get("serviceToken", "xiaomi.com") ||
      this.jar.get("serviceToken", "i.mi.com");
    if (!serviceToken) {
      throw new Error(
        `登录未完成：未拿到 serviceToken（HTTP ${httpStatus}）。请重新扫码。`,
      );
    }
    const userId =
      this.jar.get("userId", MI_BASE_HOST) ||
      this.jar.get("userId", "xiaomi.com") ||
      fallbackUserId;
    return {
      version: 1,
      serviceToken,
      userId: String(userId || ""),
      cookies: this.jar.toJSON(),
      savedAt: Date.now(),
    };
  }

  close() {
    this.closed = true;
    // 立刻打断挂在服务端的长轮询连接，用户点「稍后再说」不必等超时
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        /* 已经中止过就无所谓 */
      }
      this.abortController = null;
    }
  }
}

const MI_BASE_HOST = "i.mi.com";

/** 从 /fe/service/login 的 URL 里取出扫码要用的参数。 */
function extractLoginParams(landedUrl) {
  let url;
  try {
    url = new URL(landedUrl);
  } catch {
    throw new Error(`登录跳转地址无法解析：${landedUrl}`);
  }
  const sp = url.searchParams;
  const qs = sp.get("qs") ?? "";
  const callback = sp.get("callback") ?? "";
  // 某些落地页把参数塞在 qs 里而非顶层，兜底解析一次
  if (!callback && qs) {
    const inner = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    return {
      qs: sp.get("qs") ?? "",
      callback: inner.get("callback") ?? "",
      sid: inner.get("sid") ?? sp.get("sid") ?? SID,
      _locale: inner.get("_locale") ?? sp.get("_locale") ?? "zh_CN",
      _group: inner.get("_group") ?? sp.get("_group") ?? "",
      serviceParam: sp.get("serviceParam") ?? "",
    };
  }
  return {
    qs,
    callback,
    sid: sp.get("sid") || SID,
    _locale: sp.get("_locale") || "zh_CN",
    _group: sp.get("_group") || "",
    serviceParam: sp.get("serviceParam") || "",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ACCOUNT_BASE,
  MI_BASE,
  NOTE_HEADERS,
  QrLoginSession,
  SID,
  encodeForm,
  extractLoginParams,
  stripJsonPrefix,
};
