"use strict";

/**
 * 小米云笔记 API 客户端（i.mi.com）。
 *
 * 端点与协议全部依据 ceynri/mi-note-cli 的实测实现：
 *   读：
 *     GET /note/full/page/?ts=&limit=&syncTag=   笔记 + 文件夹列表（分页，syncTag 增量）
 *     GET /note/note/{id}/?ts=                   单篇详情（含全文）
 *   写（POST x-www-form-urlencoded，body 里额外带 serviceToken）：
 *     POST /note/note                 新建
 *     POST /note/note/{id}            更新（带 tag 做乐观锁）
 *     POST /note/folder               新建文件夹
 *     POST /note/full/{id}/delete     tag=&purge=  删除
 *
 * 删除是两步状态机：normal →(purge=false) 回收站 →(purge=true) 物理删除，不能跳步。
 */

const { CookieJar, encodeForm, request } = require("./http.js");
const { MI_BASE, NOTE_HEADERS } = require("./auth.js");

const PAGE_LIMIT = 200;
const JSON_TIMEOUT = 25_000;
/** 附件二进制可能几 MB，给比 JSON 更宽的超时。 */
const BINARY_TIMEOUT = 45_000;
/** 主机名：serviceToken 所在域（与 auth.js 的 MI_BASE 一致）。 */
const MI_BASE_HOST = "i.mi.com";

class MiNoteApiError extends Error {
  constructor(message, { status = 0, code = 0, needLogin = false, body = "" } = {}) {
    super(message);
    this.name = "MiNoteApiError";
    this.status = status;
    this.code = code;
    this.needLogin = needLogin;
    this.body = body;
  }
}

class MiNoteClient {
  /**
   * @param {object} credentials 凭据（含 cookies / serviceToken）
   */
  constructor(credentials) {
    this.jar = CookieJar.fromJSON(credentials?.cookies ?? []);
    this.serviceToken = String(credentials?.serviceToken ?? "");
    this.userId = String(credentials?.userId ?? "");
    /**
     * jar 变更通知，由仓库注入（`repository.adoptCredentials`）。
     *
     * 这里用回调而不是 `require("./repository.js")`：repository 已经
     * `require` 了本文件，反向再 require 会形成环，Node 在加载期拿到的是
     * 未完成的 `module.exports`（undefined），调用时直接 TypeError。
     * @type {(() => void)|null}
     */
    this.onJarChanged = null;
    /**
     * 401 时的自动重登回调，由仓库注入（`repository.adoptCredentials`）。
     *
     * 同样用回调避免与 repository 形成 require 环。回调应返回**新的凭据**，
     * 或抛错（`needLogin` / `network` 语义由 auth.resolveServiceSession 保证）。
     * @type {(() => Promise<object>)|null}
     */
    this.onUnauthorized = null;
    /**
     * 进行中的重登 promise。
     *
     * 并发去重：同步一轮有几十个请求，凭据失效时它们会几乎同时拿到 401。
     * 若各自都去重登，就会打出一串并发的登录入口请求（极易触发风控），
     * 而且后完成的会把先完成的新凭据覆盖掉。复用同一个 promise 则只重登一次。
     * @type {Promise<object>|null}
     */
    this._reloginPromise = null;
  }

  /**
   * 通知外部「罐子里有新 cookie 了」。
   *
   * 这是旁路副作用：回写凭据失败绝不能把一个已经成功的请求变成失败，
   * 所以整段包在 try 里。
   */
  notifyJarChanged() {
    try {
      if (this.onJarChanged) this.onJarChanged();
    } catch {
      /* 回写失败不影响数据路径 */
    }
  }

  /**
   * 当前生效的 serviceToken。
   *
   * 以 cookie 罐为准：服务端可能在任意响应里滚动 serviceToken，而
   * `this.serviceToken` 只是登录那一刻的快照。若一直用它，请求 body 里带的
   * 会是陈旧令牌，回写到磁盘的也是陈旧值 —— 罐子里的新值反而被忽略。
   * 取不到才退回登录时的值（兼容罐子被清但凭据仍在的边界）。
   */
  get activeServiceToken() {
    return (
      this.jar.get("serviceToken", MI_BASE_HOST) ||
      this.jar.get("serviceToken", "xiaomi.com") ||
      this.serviceToken
    );
  }

  snapshot() {
    return {
      version: 1,
      serviceToken: this.activeServiceToken,
      userId: this.userId,
      cookies: this.jar.toJSON(),
      savedAt: Date.now(),
    };
  }

  // ── 底层请求 ──────────────────────────────────────────────────────────────

  /**
   * 发请求。
   *
   * 401 语义（0.2.7 起）：先尝试**一次**自动重登，成功就用新凭据重试原请求；
   * 重登换不到票才判「登录已失效」，提示用户重新扫码。理由与机制见 auth.js
   * 的 resolveServiceSession。
   *
   * 三条不可动摇的约束：
   *   1. **只重试一次**：避免「401 → 重登 → 又 401」的无限循环；
   *   2. **并发去重**：同轮同步的多个 401 只触发一次重登（见 relogin()）；
   *   3. **网络故障绝不判失效**：attempt() 抛网络错误时是 reject，走不到 401 分支，
   *      语义天然正确 —— 这一点必须保持，否则掉线会逼用户白重扫一次码。
   *
   * @private
   */
  async send(pathOrUrl, { method = "GET", form = null, timeout = JSON_TIMEOUT, expectJson = true, allowRelogin = true } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${MI_BASE}${pathOrUrl}`;
    const baseHeaders = { ...NOTE_HEADERS };
    if (form) {
      baseHeaders["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      baseHeaders["Sec-Fetch-Site"] = "same-origin";
    }

    const attempt = async () => {
      const body = form ? encodeForm({ ...form, serviceToken: this.activeServiceToken }) : null;
      return request(url, {
        method,
        headers: baseHeaders,
        body,
        jar: this.jar,
        timeout,
      });
    };

    let resp = await attempt();
    if (resp.status === 401 && allowRelogin && typeof this.onUnauthorized === "function") {
      let credentials;
      try {
        // 重登失败会抛错（needLogin / network），由调用方按语义处置；这里不吞
        credentials = await this.relogin();
      } catch (error) {
        /*
         * 打上标记：这一次失败已经**走完**重登了。
         *
         * 上层（repository.ensureSession）在 needLogin 时还会再试一次重登，
         * 那是为了覆盖「客户端没挂回调」的边界。但这里已经试过并失败，
         * 不打标记就会对同一个失败连打两轮完全相同的登录请求 ——
         * 面板开着时每 20 秒轮询一次，会把登录接口刷成风控。
         */
        if (error && typeof error === "object") error.reloginAttempted = true;
        throw error;
      }
      if (credentials) {
        // 用新凭据重试一次；allowRelogin:false 保证不会再次进入本分支
        return this.send(pathOrUrl, { method, form, timeout, expectJson, allowRelogin: false });
      }
    }
    /*
     * 401 = 服务端明确判定登录态失效，需要重新扫码。
     * 注意 attempt() 自身可能抛网络错误 —— 那是 reject，不会落到这里，
     * 因此这里的 401 一定来自服务端，不是掉线造成的。
     */
    if (resp.status === 401) {
      throw new MiNoteApiError("登录态已失效，请重新扫码登录", { status: 401, needLogin: true });
    }
    /*
     * 非 401 的响应都可能带来新的 Set-Cookie（滚动的 serviceToken / cUserId 等），
     * http.js 已经把整份 Set-Cookie 写进罐子；这里通知仓库把最新快照落盘。
     * 放在 401 之后：会话已死时的清理型 cookie 不必回写。
     */
    this.notifyJarChanged();
    if (!expectJson) return resp;
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiNoteApiError(`请求失败（HTTP ${resp.status}）：${resp.text.slice(0, 160)}`, {
        status: resp.status,
        body: resp.text,
      });
    }
    return parseEnvelope(resp.text, resp.status);
  }

  /**
   * 触发一次自动重登，并把进行中的 promise 复用给并发调用者。
   *
   * 失败时**不缓存**失败的 promise：下一次 401 应该重新尝试，
   * 否则一次瞬时失败会让后续所有请求都直接判死。
   *
   * @private
   * @returns {Promise<object>} 新的凭据
   */
  relogin() {
    if (this._reloginPromise) return this._reloginPromise;
    const run = Promise.resolve()
      .then(() => this.onUnauthorized())
      .then((credentials) => {
        this.adoptCredentials(credentials);
        return credentials;
      })
      .finally(() => {
        if (this._reloginPromise === run) this._reloginPromise = null;
      });
    this._reloginPromise = run;
    return run;
  }

  /**
   * 用一份新凭据替换当前凭据（重登成功后由 relogin 调用）。
   *
   * 只替换罐子与令牌快照，不动 userId 以外的东西；调用方（仓库）负责落盘。
   * @param {object} credentials
   */
  adoptCredentials(credentials) {
    if (!credentials) return;
    this.jar = CookieJar.fromJSON(credentials.cookies ?? []);
    this.serviceToken = String(credentials.serviceToken ?? "");
    if (credentials.userId) this.userId = String(credentials.userId);
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  /** 取一页笔记/文件夹。 */
  async fetchPage(syncTag = "") {
    const params = new URLSearchParams({ ts: String(Date.now()), limit: String(PAGE_LIMIT) });
    if (syncTag) params.set("syncTag", syncTag);
    const payload = await this.send(`/note/full/page/?${params}`);
    return payload?.data ?? {};
  }

  /**
   * 拉取全部笔记与文件夹（自动翻页）。
   * @param {{onProgress?:(count:number)=>void, maxPages?:number}} [options]
   */
  async fetchAll(options = {}) {
    const maxPages = options.maxPages ?? 100;
    let syncTag = "";
    const entries = [];
    const folders = {};
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.fetchPage(syncTag);
      for (const entry of data.entries ?? []) {
        const id = String(entry?.id ?? "");
        if (!id) continue;
        // 回收站里的条目（status !== "normal"）不进列表
        if (entry.status && entry.status !== "normal") continue;
        entries.push({ ...entry, id });
      }
      for (const folder of data.folders ?? []) {
        if (!folder?.id) continue;
        if (folder.status && folder.status !== "normal") continue;
        folders[String(folder.id)] = { ...folder, id: String(folder.id) };
      }
      options.onProgress?.(entries.length);
      const nextTag = data.syncTag ?? syncTag;
      if (data.lastPage || !nextTag || nextTag === syncTag) break;
      syncTag = nextTag;
      // 轻微间隔，避免连续翻页被风控
      await sleep(260 + Math.random() * 160);
    }
    return { entries, folders, syncTag };
  }

  /** 取单篇详情（含完整 content）。 */
  async getNote(noteId) {
    const payload = await this.send(`/note/note/${encodeURIComponent(String(noteId))}/?ts=${Date.now()}`);
    const entry = payload?.data?.entry;
    if (!entry) throw new MiNoteApiError(`未找到笔记 ${noteId}`);
    return { ...entry, id: String(entry.id ?? noteId) };
  }

  /** 批量取详情，用于同步时补齐正文。 */
  async getNotes(noteIds, { concurrency = 3 } = {}) {
    const ids = [...noteIds];
    const out = new Map();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        try {
          out.set(String(id), await this.getNote(id));
        } catch (error) {
          if (error?.needLogin) throw error;
          // 单篇失败不拖垮整体
        }
        await sleep(120 + Math.random() * 120);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ── 写 ────────────────────────────────────────────────────────────────────

  /** 新建笔记。 */
  async createNote(entry) {
    const payload = await this.send("/note/note", {
      method: "POST",
      form: { entry: JSON.stringify(entry) },
    });
    const created = payload?.data?.entry;
    if (!created) {
      throw new MiNoteApiError(`新建笔记失败：${payload?.description ?? "服务端未返回条目"}`);
    }
    return { ...created, id: String(created.id ?? "") };
  }

  /** 更新笔记（entry 需带最新 tag）。 */
  async updateNote(noteId, entry) {
    const payload = await this.send(`/note/note/${encodeURIComponent(String(noteId))}`, {
      method: "POST",
      form: { entry: JSON.stringify(entry) },
    });
    return payload?.data?.entry ?? { ...entry, id: String(noteId) };
  }

  /**
   * 删除笔记。
   * @param {string} noteId
   * @param {{tag?:string, purge?:boolean}} [options]
   */
  async deleteNote(noteId, options = {}) {
    let tag = options.tag;
    if (!tag) {
      const entry = await this.getNote(noteId);
      tag = entry.tag;
    }
    if (!tag) throw new MiNoteApiError("笔记缺少 tag，无法删除");
    const soft = await this.deleteEntity(noteId, tag, false);
    if (!options.purge) return soft;
    const nextTag = soft?.data?.tag;
    if (!nextTag) throw new MiNoteApiError("软删除未返回新 tag，无法继续永久删除");
    return this.deleteEntity(noteId, nextTag, true);
  }

  async deleteEntity(id, tag, purge) {
    const payload = await this.send(`/note/full/${encodeURIComponent(String(id))}/delete`, {
      method: "POST",
      form: { tag, purge: String(purge) },
    });
    if (payload?.data?.conflict) {
      throw new MiNoteApiError("删除冲突：服务端版本已变化，请刷新后重试");
    }
    return payload;
  }

  /** 新建文件夹。 */
  async createFolder(subject, parentId = "0") {
    const now = Date.now();
    const payload = await this.send("/note/folder", {
      method: "POST",
      form: {
        entry: JSON.stringify({
          subject,
          folderId: String(parentId),
          createDate: now,
          modifyDate: now,
          colorId: 0,
          alertDate: 0,
          alertTag: 0,
          type: "folder",
          setting: { themeId: 0, stickyTime: 0, version: 0 },
        }),
      },
    });
    const created = payload?.data?.entry;
    if (!created) throw new MiNoteApiError(`新建文件夹失败：${payload?.description ?? "未知原因"}`);
    return { ...created, id: String(created.id ?? "") };
  }

  /** 更新文件夹（重命名 / 移动）。 */
  async updateFolder(folderId, patch) {
    const now = Date.now();
    const payload = await this.send(`/note/folder/${encodeURIComponent(String(folderId))}`, {
      method: "POST",
      form: {
        entry: JSON.stringify({
          id: String(folderId),
          ...patch,
          modifyDate: now,
          type: "folder",
        }),
      },
    });
    return payload?.data?.entry ?? { id: String(folderId), ...patch };
  }

  /** 删除文件夹（folder 与 note 共用同一删除端点）。 */
  async deleteFolder(folderId, tag, purge = false) {
    return this.deleteEntity(folderId, tag, purge);
  }

  /** 轻量探活：验证当前凭据是否还有效。 */
  async ping() {
    const payload = await this.send(`/note/full/page/?ts=${Date.now()}&limit=1`);
    return payload?.result === "ok";
  }

  /**
   * 下载笔记里的附件（图片/音频/视频）二进制。
   *
   * 端点只靠 Cookie 鉴权，不需要 serviceToken 参数 —— 而 jar 里已有全套 Cookie。
   * 这里用 expectJson:false 拿原始响应
   * （http.js 本来就返回 Buffer 并自动解压）。
   *
   * @param {string} fileId 附件 id（rawId 中 "." 之后的部分）
   * @param {"note_img"|"note_sound"|"note_video"} [type]
   * @returns {Promise<{buffer:Buffer, contentType:string}>}
   */
  async fetchAttachment(fileId, type = "note_img") {
    const params = new URLSearchParams({
      type,
      fileid: String(fileId),
      ts: String(Date.now()),
    });
    const resp = await this.send(`/file/full?${params.toString()}`, {
      expectJson: false,
      timeout: BINARY_TIMEOUT,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiNoteApiError(`附件下载失败（HTTP ${resp.status}）`, { status: resp.status });
    }
    // 有些错误会以 JSON 包着 200 返回，长度极小的响应基本不是真图片
    const contentType = String(resp.headers["content-type"] || "");
    if (/application\/json/i.test(contentType)) {
      throw new MiNoteApiError("附件不可用（服务端返回了错误信息）", { status: resp.status });
    }
    if (!resp.buffer || resp.buffer.length === 0) {
      throw new MiNoteApiError("附件内容为空", { status: resp.status });
    }
    return { buffer: resp.buffer, contentType };
  }
}

function parseEnvelope(text, status) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new MiNoteApiError(
      `服务端返回了非 JSON 响应（HTTP ${status}）：${text.slice(0, 160)}`,
      { status, body: text },
    );
  }
  if (payload?.result !== "ok") {
    throw new MiNoteApiError(
      `小米接口返回错误：${payload?.description ?? payload?.desc ?? JSON.stringify(payload).slice(0, 160)}`,
      { status, code: Number(payload?.code ?? 0), body: text },
    );
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MiNoteApiError, MiNoteClient, PAGE_LIMIT, parseEnvelope };
