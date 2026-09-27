"use strict";

/**
 * 业务编排：把 auth / client / repository 串成面板与 Agent 工具都用的门面。
 *
 * 一条重要的架构约束：宿主对面板通道的转发超时是 30 秒，而全量同步与模型问答都
 * 可能远超这个时间。所以凡是可能长跑的操作都不在请求里等结果，而是提交成一个
 * job（立即拿到 id），由面板轮询 `mn.job.get` 取进度与结果。短操作（读列表、
 * 取单篇）才同步返回。
 */

const { QrLoginSession, silentRefresh } = require("./auth.js");
const { NoteRepository } = require("./repository.js");
const { Store } = require("./store.js");

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const JOB_TTL_MS = 10 * 60 * 1000;
const MAX_JOBS = 40;
/** 交给模型的笔记片段总量上限，避免一次问答把上下文塞爆。 */
const ASK_CONTEXT_CHARS = 24_000;

const ASK_SYSTEM_PROMPT = [
  "你是「小米笔记」助手，只依据下面提供的用户笔记片段回答问题。",
  "",
  "规则：",
  "1. 只使用笔记里的信息，不要编造。笔记里没有的内容，明确说「笔记里没有提到」。",
  "2. 每条结论后面用「（来自《笔记标题》）」标注来源标题。",
  "3. 如果多篇笔记信息冲突，把冲突如实指出，不要擅自选一个。",
  "4. 用中文回答，简洁直接；分点陈述优于长段落。",
].join("\n");

class MiNoteService {
  /**
   * @param {{getDataPath:() => Promise<string>}} host
   */
  constructor(host) {
    this.host = host;
    this.store = new Store(() => host.getDataPath());
    this.repo = new NoteRepository({ store: this.store });
    this.repo.refreshHook = (credentials) => this.silentRefresh(credentials);

    this.syncTimer = null;
    this.syncStarted = false;

    /** @type {Map<string, {id:string,kind:string,status:string,progress:object,result:any,error:string,createdAt:number}>} */
    this.jobs = new Map();
    /** @type {QrLoginSession|null} */
    this.loginSession = null;
    /** 侧边栏请求「在主面板打开某篇」时挂起的目标，由面板取走 */
    this.pendingFocus = null;
    /** 未登录/续期失败时置位，面板据此提示 */
    this.needLogin = false;
    /** 最近一次同步失败原因（面板顶部提示用） */
    this.lastSyncError = null;
    /** 事件订阅者（面板/视图长连接轮询用，这里只做记录） */
    this.listeners = new Set();
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /** 启动：恢复凭据 + 预热缓存 + 起同步定时器。 */
  async start({ autoSync = true } = {}) {
    try {
      await this.repo.restore();
    } catch {
      /* 没有凭据就是未登录，正常状态 */
    }
    if (this.repo.loggedIn) {
      try {
        await this.repo.warmFromCache();
      } catch {
        /* 缓存损坏不影响后续同步 */
      }
    }
    if (autoSync) this.startSyncTimer();
    if (this.repo.loggedIn) {
      // 首轮同步不阻塞启动
      this.submitJob("sync", (job) => this.runSync(job));
    }
    return this.status();
  }

  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.syncStarted = false;
    this.closeLogin();
  }

  /** 每 5 分钟一次增量同步。 */
  startSyncTimer() {
    if (this.syncStarted) return;
    this.syncStarted = true;
    this.syncTimer = setInterval(() => {
      if (!this.repo.loggedIn) return;
      if (this.repo.syncing) return;
      this.submitJob("sync", (job) => this.runSync(job, { quiet: true }));
    }, SYNC_INTERVAL_MS);
    // 定时器不应阻止插件进程退出
    if (typeof this.syncTimer.unref === "function") this.syncTimer.unref();
  }

  // ── 任务机制 ──────────────────────────────────────────────────────────────

  /**
   * 提交一个后台任务，立即返回 job id。
   * @param {string} kind
   * @param {(job:object) => Promise<any>} runner
   */
  submitJob(kind, runner) {
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const job = {
      id,
      kind,
      status: "running",
      progress: {},
      result: null,
      error: "",
      createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.pruneJobs();

    void Promise.resolve()
      .then(() => runner(job))
      .then((result) => {
        job.result = result ?? null;
        job.status = "done";
      })
      .catch((error) => {
        job.error = error?.message ?? String(error);
        job.status = "failed";
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.emit("job", { id: job.id, kind: job.kind, status: job.status });
      });

    return id;
  }

  getJob(id) {
    const job = this.jobs.get(String(id ?? ""));
    if (!job) return null;
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
    };
  }

  pruneJobs() {
    if (this.jobs.size <= MAX_JOBS) return;
    const all = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (all.length > MAX_JOBS) {
      const victim = all.shift();
      if (victim) this.jobs.delete(victim.id);
    }
  }

  pruneExpiredJobs() {
    const now = Date.now();
    for (const [id, job] of [...this.jobs]) {
      if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) this.jobs.delete(id);
    }
  }

  emit(event, payload) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event, payload);
      } catch {
        /* 订阅者自己的问题不应影响主流程 */
      }
    }
  }

  // ── 登录 ──────────────────────────────────────────────────────────────────

  get loggedIn() {
    return this.repo.loggedIn;
  }

  /** 生成新二维码（旧会话作废）。 */
  async startLogin() {
    this.closeLogin();
    const session = new QrLoginSession();
    const info = await session.create();
    this.loginSession = session;
    return {
      qrDataUri: `data:image/png;base64,${info.qrPng.toString("base64")}`,
      expiresAt: info.expiresAt,
      expiresInSeconds: info.expiresInSeconds,
    };
  }

  closeLogin() {
    if (this.loginSession) {
      this.loginSession.close();
      this.loginSession = null;
    }
  }

  /**
   * 等用户扫码确认 → 换 serviceToken → 首次同步。整体作为 job 跑。
   * @returns {string} job id
   */
  submitLoginWait() {
    const session = this.loginSession;
    if (!session) throw new Error("二维码已失效，请重新获取");
    return this.submitJob("login", async (job) => {
      job.progress = { phase: "waiting" };
      const outcome = await session.poll();
      if (outcome.status !== "confirmed") {
        if (outcome.status === "expired") throw new Error("二维码已过期，请重新获取");
        throw new Error("已取消");
      }
      job.progress = { phase: "settling" };
      const credentials = await session.settle(outcome.location, outcome.userId);
      await this.repo.saveCredentials(credentials);
      this.needLogin = false;
      this.closeLogin();
      job.progress = { phase: "syncing" };
      const result = await this.runSync(job);
      return { userId: this.repo.userId, synced: result };
    });
  }

  /** 使用长效票据静默续期。 */
  async silentRefresh(credentials) {
    try {
      const next = await silentRefresh(credentials);
      this.needLogin = false;
      return next;
    } catch (error) {
      this.needLogin = true;
      throw error;
    }
  }

  async logout() {
    this.closeLogin();
    await this.repo.logout();
    this.needLogin = false;
    this.lastSyncError = null;
    return { ok: true };
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  async runSync(job, { quiet = false } = {}) {
    const result = await this.repo.sync({
      full: false,
      onProgress: (info) => {
        job.progress = info;
      },
    });
    this.needLogin = false;
    this.lastSyncError = null;
    if (!quiet) this.emit("synced", result);
    return result;
  }

  /** 手动触发同步（返回 job id）。 */
  requestSync({ full = false } = {}) {
    if (!this.repo.loggedIn) throw new Error("尚未登录");
    return this.submitJob("sync", async (job) => {
      const result = await this.repo.sync({
        full,
        onProgress: (info) => {
          job.progress = info;
        },
      });
      this.needLogin = false;
      this.lastSyncError = null;
      this.emit("synced", result);
      return result;
    });
  }

  /** 确保可用的会话；必要时静默续期。 */
  async ensureSession() {
    const outcome = await this.repo.ensureSession();
    this.needLogin = !outcome.ok;
    return outcome;
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  status() {
    this.pruneExpiredJobs();
    return {
      ...this.repo.status(),
      needLogin: this.needLogin,
      lastSyncError: this.lastSyncError,
      syncIntervalMs: SYNC_INTERVAL_MS,
      pendingFocus: this.pendingFocus,
    };
  }

  listFolders() {
    return this.repo.listFolders();
  }

  listNotes(options) {
    return this.repo.listNotes(options);
  }

  /** 取笔记正文；本地没有正文时按需从云端补一次。 */
  async getNote(noteId, { force = false } = {}) {
    const local = this.repo.getNote(noteId);
    if (!local) throw new Error(`未找到笔记 ${noteId}`);
    if (force || !local.rawMarkdownAvailable) {
      await this.repo.loadNoteFresh(noteId);
      return this.repo.getNote(noteId);
    }
    return local;
  }

  // ── 写 ────────────────────────────────────────────────────────────────────

  async createNote(input) {
    const created = await this.repo.createNote(input);
    this.emit("notes-changed", { action: "create", id: created?.id });
    return created;
  }

  async updateNote(noteId, patch) {
    const updated = await this.repo.updateNote(noteId, patch);
    this.emit("notes-changed", { action: "update", id: String(noteId) });
    return updated;
  }

  async deleteNote(noteId, options) {
    const result = await this.repo.deleteNote(noteId, options);
    this.emit("notes-changed", { action: "delete", id: String(noteId) });
    return result;
  }

  async createFolder(name, parentId) {
    const created = await this.repo.createFolder(name, parentId);
    this.emit("notes-changed", { action: "folder", id: created.id });
    return created;
  }

  // ── 焦点传递（侧边栏 → 主面板定位） ────────────────────────────────────────

  setPendingFocus(noteId) {
    this.pendingFocus = noteId ? String(noteId) : null;
    return { ok: true, pendingFocus: this.pendingFocus };
  }

  /** 面板取走待定位目标（取走即清空）。 */
  consumeFocus() {
    const focus = this.pendingFocus;
    this.pendingFocus = null;
    return { focus };
  }

  // ── AI 问答 ───────────────────────────────────────────────────────────────

  /**
   * 用宿主已登录的模型回答关于笔记的问题。
   *
   * 走 `pi.agent.complete`：模型由宿主代调，插件只拿到文本，永远看不到 API 密钥。
   * 上下文只放检索命中的片段，不是全部笔记。
   *
   * @param {{question:string, modelKey?:string, limit?:number}} input
   */
  async ask(input) {
    const question = String(input?.question ?? "").trim();
    if (!question) throw new Error("问题不能为空");
    if (!this.repo.notes.size) throw new Error("本地还没有笔记，请先同步");

    const hits = this.repo.searchForAnswer(question, { limit: input?.limit ?? 8, maxChars: 3000 });
    const matched = hits.length ? hits : this.repo.recentNotes(6, 1500);
    const usedFallback = hits.length === 0;

    const modelKey = await this.pickModelKey(input?.modelKey);
    const context = buildContext(usedFallback, matched, ASK_CONTEXT_CHARS);
    const completion = await pi.agent.complete({
      modelKey,
      system: ASK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${question}\n\n---\n\n${context}` }],
    });
    const answer = String(completion?.text ?? "").trim();
    if (!answer) throw new Error("模型没有返回内容");
    return {
      answer,
      modelKey: completion?.modelKey ?? modelKey,
      usedFallback,
      sources: matched.map((item) => ({
        id: item.id,
        title: item.title,
        folderName: item.folderName,
        modifyDate: item.modifyDate,
      })),
    };
  }

  /**
   * 选一个已登录可用的模型。
   * 优先级：本次指定 → 插件设置里的 askModel → 宿主的默认模型 → 列表第一个。
   */
  async pickModelKey(preferred) {
    const models = await pi.models.list();
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("宿主没有可用的模型，请先在 PI-Desktop 里登录一个模型");
    }
    const usable = (key) => {
      const trimmed = String(key ?? "").trim();
      return trimmed && models.some((m) => m.key === trimmed) ? trimmed : null;
    };
    const explicit = usable(preferred);
    if (explicit) return explicit;

    // 面板没指定时回落到设置项里记住的模型
    try {
      const settings = await pi.plugin.getSettings();
      const saved = usable(settings?.askModel);
      if (saved) return saved;
    } catch {
      /* 读不到设置就当没配 */
    }

    return (models.find((m) => m.isDefault) ?? models[0]).key;
  }

  /** 读设置里记住的问答模型（没配就返回空串，由面板回落到宿主默认）。 */
  async currentAskModel() {
    try {
      const settings = await pi.plugin.getSettings();
      return String(settings?.askModel ?? "");
    } catch {
      return "";
    }
  }

  /** 记住用户选的问答模型（面板切换下拉框时调用）。 */
  async rememberAskModel(modelKey) {
    const key = String(modelKey ?? "").trim();
    if (!key) return { ok: false };
    try {
      await pi.plugin.setSettings({ askModel: key });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** 供面板填充模型下拉框。 */
  async listModels() {
    try {
      const models = await pi.models.list();
      return (Array.isArray(models) ? models : []).map((m) => ({
        key: m.key,
        label: m.label ?? m.key,
        providerName: m.providerName ?? "",
        isDefault: m.isDefault === true,
      }));
    } catch {
      return [];
    }
  }

  /** 问答（异步 job 版，绕开面板 30 秒超时）。 */
  submitAsk(input) {
    return this.submitJob("ask", (job) => {
      job.progress = { phase: "asking" };
      return this.ask(input);
    });
  }
}

/** 把命中的笔记拼成给模型的上下文（超长时按顺序裁剪）。 */
function buildContext(usedFallback, items, maxChars) {
  const blocks = [];
  let used = 0;
  for (const item of items) {
    const header = usedFallback
      ? `《${item.title}》`
      : `《${item.title}》${item.folderName ? `（文件夹：${item.folderName}）` : ""}`;
    const block = `${header}\n${item.excerpt}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used;
      if (room > 200) blocks.push(`${block.slice(0, room)}…`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  const prefix = usedFallback
    ? "（没有找到与问题直接相关的笔记，下面是最近更新的几篇，供参考或说明「没有提到」）"
    : "";
  return [prefix, blocks.join("\n\n---\n\n")].filter(Boolean).join("\n\n");
}

module.exports = { MiNoteService, SYNC_INTERVAL_MS, JOB_TTL_MS };
