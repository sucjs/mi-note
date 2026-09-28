"use strict";

/**
 * 小米笔记 — PI-Desktop 插件入口。
 *
 * 这个文件只做三件事：
 *   1. 拉起 MiNoteService（登录 / 同步 / 读写 / AI 问答的唯一门面）
 *   2. 把它的能力暴露成命令、Agent 工具、面板通道与侧边栏视图
 *   3. 处理生命周期：注册后台自动同步服务、卸载时停掉定时器
 *
 * 笔记的协议实现全部在 lib/ 下，这里不碰 HTTP 细节。
 *
 * 安全边界（为什么用原生 node 模块而不是宿主 fs API）：
 *   - 网络：登录与同步要按 domain 建会话、要读到响应里的每一个 Set-Cookie，宿主的
 *     pi.net.fetch 把响应头收进普通对象，多个 Set-Cookie 会互相覆盖，做不到。
 *   - 文件：只写插件自己的数据目录（宿主分配），不读也不写用户的任何文件。
 */

const { MiNoteService, SYNC_INTERVAL_MS } = require("./lib/service.js");

/** @type {MiNoteService|null} */
let service = null;
/** 面板与侧边栏视图通过同一条 onPanelInvoke 进来，用面板来源区分事件订阅 */
let lastActiveSurface = null;

const PLUGIN_ID = "local.mi-note";
/*
 * 版本号只从清单里取，不在这里再抄一份。
 * 抄一份的代价是它会和 manifest 悄悄分叉（改清单忘了改这里），
 * 面板上的版本与宿主看到的版本就不一致了。
 */
const PLUGIN_VERSION = require("./manifest.json").version;

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onLoad() {
  service = new MiNoteService({
    getDataPath: () => pi.plugin.getDataPath(),
  });

  registerCommands();
  registerTools();
  registerService();

  // 启动即恢复登录态、预热缓存、起 5 分钟同步定时器。放后台，别拖慢加载。
  void service.start().catch((error) => {
    log(`启动失败：${error?.message ?? error}`);
  });
}

async function onUnload() {
  if (service) service.stop();
  await pi.commands.unregister("mi-note.open");
  await pi.commands.unregister("mi-note.sync");
  await pi.commands.unregister("mi-note.new-note");
  await pi.commands.unregister("mi-note.login");
  for (const name of TOOL_NAMES) await pi.agent.unregisterTool(name);
  try {
    await pi.services.unregister("auto-sync");
  } catch {
    /* 没注册过就算了 */
  }
  service = null;
}

// ── 命令 ────────────────────────────────────────────────────────────────────

function registerCommands() {
  void pi.commands.register({
    id: "mi-note.open",
    title: "小米笔记: 打开面板",
    keywords: ["mi-note", "note", "小米笔记", "笔记"],
    run: async () => {
      await pi.ui.openPanel({ title: "小米笔记" });
    },
  });

  void pi.commands.register({
    id: "mi-note.login",
    title: "小米笔记: 扫码登录",
    keywords: ["mi-note", "login", "登录", "扫码"],
    run: async () => {
      await pi.ui.openPanel({ title: "小米笔记" });
    },
  });

  void pi.commands.register({
    id: "mi-note.sync",
    title: "小米笔记: 立即同步",
    keywords: ["mi-note", "sync", "同步"],
    run: async () => {
      requireService();
      if (!service.loggedIn) {
        await pi.ui.showToast("还没登录小米账号，请先打开面板扫码", "error");
        await pi.ui.openPanel({ title: "小米笔记" });
        return;
      }
      service.requestSync({ full: true });
      await pi.ui.showToast("已开始同步小米笔记");
    },
  });

  void pi.commands.register({
    id: "mi-note.new-note",
    title: "小米笔记: 新建笔记",
    keywords: ["mi-note", "new", "新建"],
    run: async () => {
      await pi.ui.openPanel({ title: "小米笔记" });
      await pi.ui.showToast("在面板里点「新建」即可写新笔记");
    },
  });
}

// ── 后台自动同步服务 ────────────────────────────────────────────────────────

/**
 * 声明式服务：宿主在 onLoad 返回后调用 start()，插件在这里挂定时器。
 *
 * 每 5 分钟一次增量同步是需求的一部分，所以它必须在「面板没打开」时也活着 ——
 * 这正是 resident service 的用途（面板关掉后插件进程仍在）。
 */
function registerService() {
  void pi.services.register({
    id: "auto-sync",
    async start() {
      requireService();
      service.startSyncTimer();
      if (service.loggedIn) {
        // 恢复登录态后的第一轮同步
        service.requestSync({ full: false });
      }
      log(`自动同步已启动，间隔 ${Math.round(SYNC_INTERVAL_MS / 60000)} 分钟`);
    },
    async stop() {
      if (service) service.stop();
    },
  });
}

// ── Agent 工具 ──────────────────────────────────────────────────────────────

const TOOL_NAMES = [
  "list_folders",
  "list_notes",
  "read_note",
  "search_notes",
  "create_note",
  "update_note",
  "delete_note",
  "create_folder",
  "sync_notes",
  "note_status",
];

function registerTools() {
  const register = (tool) => {
    void pi.agent.registerTool(tool).catch((error) => {
      log(`工具 ${tool.name} 注册失败：${error?.message ?? error}`);
    });
  };

  register({
    name: "list_folders",
    description:
      "列出小米云笔记的全部文件夹（含每个文件夹的笔记数量）。回答「我有哪些笔记本」或准备按文件夹筛选时先用它。",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const svc = requireService();
      await requireLogin(svc);
      return svc.listFolders();
    },
  });

  register({
    name: "list_notes",
    description:
      "列出小米云笔记（可按文件夹筛选、按关键词搜索，支持分页）。返回每篇的 id、标题、摘要、文件夹与修改时间。要读全文请接着用 read_note。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: '文件夹 id；省略或传 "0" 表示全部笔记。先用 list_folders 取 id。' },
        query: { type: "string", description: "关键词，匹配标题与正文。" },
        limit: { type: "number", description: "返回条数，默认 50，最大 200。" },
        offset: { type: "number", description: "分页偏移，默认 0。" },
      },
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const result = svc.listNotes({
        folderId: args?.folderId,
        query: args?.query,
        limit: clampNumber(args?.limit, 50, 1, 200),
        offset: clampNumber(args?.offset, 0, 0, 100000),
      });
      return {
        total: result.total,
        returned: result.items.length,
        offset: result.offset,
        notes: result.items.map((item) => ({
          id: item.id,
          title: item.title,
          summary: item.summary,
          folderId: item.folderId,
          folderName: item.folderName,
          modifyDate: item.modifyDate,
          modifyDateText: formatTime(item.modifyDate),
        })),
      };
    },
  });

  register({
    name: "read_note",
    description: "读取一篇小米笔记的完整正文（Markdown）。传入 list_notes 返回的 id。",
    risk: "low",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "笔记 id。" } },
      required: ["id"],
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id 不能为空");
      const note = await svc.getNote(id, { force: true });
      return {
        id: note.id,
        title: note.title,
        folderName: note.folderName,
        markdown: note.markdown,
        createDateText: formatTime(note.createDate),
        modifyDateText: formatTime(note.modifyDate),
      };
    },
  });

  register({
    name: "search_notes",
    description:
      "在所有小米笔记的标题与正文里做关键词搜索，返回命中的笔记与正文片段。适合「我之前记过的关于 X 的内容」。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词。" },
        limit: { type: "number", description: "返回条数，默认 10。" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query 不能为空");
      const limit = clampNumber(args?.limit, 10, 1, 50);
      // 先按标题/正文匹配筛出 id，再用问答用的打分排序取片段
      const listed = svc.listNotes({ query, limit: 200, offset: 0 });
      const hits = svc.repo.searchForAnswer(query, { limit, maxChars: 1200 });
      const byId = new Map(hits.map((hit) => [hit.id, hit]));
      return {
        total: listed.total,
        matches: listed.items.slice(0, limit).map((item) => ({
          id: item.id,
          title: item.title,
          folderName: item.folderName,
          modifyDateText: formatTime(item.modifyDate),
          excerpt: byId.get(item.id)?.excerpt ?? item.summary,
        })),
      };
    },
  });

  register({
    name: "create_note",
    description:
      "新建一篇小米笔记。内容用 Markdown 书写，插件会负责转成小米笔记的格式。默认写入「全部笔记」（根目录）。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "笔记标题。" },
        markdown: { type: "string", description: "正文，Markdown 格式。" },
        folderId: { type: "string", description: "目标文件夹 id，省略则放在根目录。" },
      },
      required: ["markdown"],
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const markdown = String(args?.markdown ?? "");
      if (!markdown.trim() && !String(args?.title ?? "").trim()) {
        throw new Error("标题与正文至少要有一个");
      }
      const created = await svc.createNote({
        title: args?.title,
        markdown,
        folderId: args?.folderId,
      });
      return {
        ok: true,
        id: created?.id,
        title: created?.title,
        folderName: created?.folderName ?? "",
      };
    },
  });

  register({
    name: "update_note",
    description:
      "修改一篇已有小米笔记的正文（传完整的 Markdown，会整体替换）、标题或所属文件夹。改之前建议先用 read_note 读一遍，以免覆盖用户的内容。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "笔记 id。" },
        markdown: { type: "string", description: "新的完整正文（Markdown）。省略则保持原正文不变。" },
        title: { type: "string", description: "新的标题。省略则保持不变。" },
        folderId: { type: "string", description: "移动到该文件夹 id。省略则不移动。" },
      },
      required: ["id"],
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id 不能为空");
      const patch = {};
      if (args?.markdown !== undefined) patch.markdown = String(args.markdown);
      if (args?.title !== undefined) patch.title = String(args.title);
      if (args?.folderId !== undefined) patch.folderId = String(args.folderId);
      if (!Object.keys(patch).length) throw new Error("没有要修改的字段");
      const updated = await svc.updateNote(id, patch);
      return { ok: true, id: updated?.id, title: updated?.title };
    },
  });

  register({
    name: "delete_note",
    description:
      "删除一篇小米笔记。默认移到回收站（可在小米笔记客户端恢复）；只有用户明确要求永久删除时才传 purge=true。",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "笔记 id。" },
        purge: { type: "boolean", description: "true 表示从回收站彻底删除，无法恢复。默认 false。" },
      },
      required: ["id"],
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id 不能为空");
      const purge = args?.purge === true;
      await svc.deleteNote(id, { purge });
      return {
        ok: true,
        id,
        purged: purge,
        note: purge ? "已从回收站彻底删除，无法恢复" : "已移入小米笔记回收站",
      };
    },
  });

  register({
    name: "create_folder",
    description: "新建一个小米笔记文件夹。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文件夹名称。" },
        parentId: { type: "string", description: "父文件夹 id，省略则建在根目录。" },
      },
      required: ["name"],
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const name = String(args?.name ?? "").trim();
      if (!name) throw new Error("name 不能为空");
      const created = await svc.createFolder(name, args?.parentId);
      return { ok: true, id: created.id, name: created.name };
    },
  });

  register({
    name: "sync_notes",
    description:
      "立即从小米云同步笔记（正常情况下插件每 5 分钟自动增量同步一次，刚在手机上改了笔记时可以用它强制刷新）。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "true 表示忽略增量标记、重新拉取全部正文。默认 false。" },
      },
    },
    execute: async (args) => {
      const svc = requireService();
      await requireLogin(svc);
      const jobId = svc.requestSync({ full: args?.full === true });
      const job = await waitForJob(jobId, 100_000);
      if (job.status !== "done") throw new Error(job.error || "同步失败");
      return { ok: true, ...job.result };
    },
  });

  register({
    name: "note_status",
    description:
      "查看小米笔记插件的状态：是否已登录、本地有多少篇笔记、上次同步时间、最近一次错误。用户说「笔记没更新」或「同步不了」时先用它判断原因。",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const svc = requireService();
      const status = svc.status();
      return {
        ...status,
        lastSyncText: status.lastSyncAt ? formatTime(status.lastSyncAt) : "从未同步",
        hint: status.loggedIn
          ? status.needLogin
            ? "登录态已失效，请在小米笔记面板里重新扫码登录"
            : "正常"
          : "还没登录，请打开小米笔记面板扫码",
      };
    },
  });
}

// ── 面板通道 ────────────────────────────────────────────────────────────────

/**
 * 面板与侧边栏视图都走这条通道。
 *
 * 长任务（同步 / 扫码等待 / 问答）一律返回 job id，由调用方轮询 `mn.job.get`，
 * 因为宿主转发这些调用的超时是 30 秒，而它们可能跑好几分钟。
 */
async function onPanelInvoke(channel, payload) {
  try {
    const result = await handlePanelChannel(String(channel ?? ""), payload ?? {});
    return result ?? { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.message ?? String(error),
      needLogin: error?.needLogin === true,
    };
  }
}

async function handlePanelChannel(channel, payload) {
  const svc = requireService();

  // 视图侧请求打开主面板。宿主的面板桥接白名单里没有 ui.openPanel
  // （它只放行 ui.showToast / fs.* / clipboard.* 等一组固定通道），
  // 所以未命中的通道会转发到插件进程，由这里代为执行。
  if (channel === "ui.openPanel") {
    await pi.ui.openPanel({ title: payload.title || "小米笔记" });
    return { ok: true };
  }
  if (channel === "ui.showToast") {
    const message = String(payload.message ?? "");
    if (message) await pi.ui.showToast(message, payload.level);
    return { ok: true };
  }

  switch (channel) {
    case "mn.ping":
      return { ok: true, pluginId: PLUGIN_ID, version: PLUGIN_VERSION };

    case "mn.status":
      return { ok: true, status: svc.status() };

    // ── 登录 ──
    case "mn.login.start": {
      const info = await svc.startLogin();
      // 立刻开始等扫码，让面板拿到 job 后轮询
      info.jobId = svc.submitLoginWait();
      return { ok: true, ...info };
    }
    case "mn.login.cancel":
      svc.closeLogin();
      return { ok: true };
    case "mn.logout":
      await svc.logout();
      return { ok: true };

    // ── 任务与同步 ──
    case "mn.job.get":
      return { ok: true, job: svc.getJob(payload.jobId) };
    case "mn.sync.start":
      return { ok: true, jobId: svc.requestSync({ full: payload.full === true }) };
    case "mn.session.ensure":
      return { ok: true, ...(await svc.ensureSession()) };

    // ── 读 ──
    case "mn.folders.list":
      return { ok: true, ...svc.listFolders() };
    case "mn.notes.list":
      return {
        ok: true,
        ...svc.listNotes({
          folderId: payload.folderId,
          query: payload.query,
          limit: clampNumber(payload.limit, 200, 1, 500),
          offset: clampNumber(payload.offset, 0, 0, 100000),
        }),
      };
    case "mn.note.get": {
      const note = await svc.getNote(payload.id, { force: payload.force === true });
      return { ok: true, note };
    }

    // ── 写 ──
    case "mn.note.create":
      return { ok: true, note: await svc.createNote({ title: payload.title, markdown: payload.markdown, folderId: payload.folderId }) };
    case "mn.note.update":
      return {
        ok: true,
        note: await svc.updateNote(payload.id, {
          markdown: payload.markdown,
          title: payload.title,
          folderId: payload.folderId,
        }),
      };
    case "mn.note.delete":
      return { ok: true, ...(await svc.deleteNote(payload.id, { purge: payload.purge === true })) };
    case "mn.folder.create":
      return { ok: true, folder: await svc.createFolder(payload.name, payload.parentId) };

    // ── AI 问答 ──
    case "mn.models.list":
      return { ok: true, models: await svc.listModels() };
    case "mn.ask.set-model":
      return svc.rememberAskModel(payload.modelKey);
    case "mn.ask.default-model":
      return { ok: true, modelKey: await svc.currentAskModel() };
    case "mn.ask":
      return { ok: true, jobId: svc.submitAsk({ question: payload.question, modelKey: payload.modelKey }) };
    // ── 侧边栏 ↔ 主面板 ──
    case "mn.focus.set":
      return svc.setPendingFocus(payload.id);
    case "mn.focus.consume":
      return { ok: true, ...svc.consumeFocus() };

    // ── 附件 ──
    /*
     * 面板里图片是异步取的：渲染只产出带 fileId 的骨架，再回来要 data URI。
     *
     * 单张图走普通通道即可（宿主转发超时 30 秒）。若将来要一次取很多张，
     * 应改为 job + 轮询（见 mn.sync.start 的写法），否则会撞超时。
     */
    case "mn.attachment.get": {
      const fileId = String(payload.fileId ?? "");
      if (!fileId) return { ok: false, error: "缺少附件 id" };
      const kind = payload.kind === "audio" || payload.kind === "video" ? payload.kind : "image";
      try {
        const result = await svc.getAttachment(fileId, kind);
        return {
          ok: true,
          dataUri: result.dataUri,
          mimeType: result.mimeType,
          bytes: result.bytes,
          from: result.from,
        };
      } catch (error) {
        // 取不到图不该让面板报错：渲染层会降级成文本提示
        return { ok: false, error: error?.message ?? String(error) };
      }
    }

    // ── 剪贴板 ──
    // 侧边栏的「复制全文」走这里：由插件进程写入系统剪贴板，
    // 比页面里的 navigator.clipboard 更可靠（视图是 file:// 沙箱页）。
    case "mn.clipboard.write": {
      const text = String(payload.text ?? "");
      if (!text) return { ok: false, error: "没有可复制的内容" };
      await pi.clipboard.writeText(text);
      return { ok: true, length: text.length };
    }
    default:
      return { ok: false, error: `未知通道：${channel}` };
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function requireService() {
  if (!service) throw new Error("插件尚未就绪，请稍后重试");
  return service;
}

async function requireLogin(svc) {
  if (svc.loggedIn) {
    // 已登录但可能已失效；只在最近失败过时才主动探活，避免每次工具调用都多打一次接口
    if (svc.needLogin) {
      const outcome = await svc.ensureSession();
      if (!outcome.ok) {
        const error = new Error(
          `小米笔记未登录或登录已过期：${outcome.error ?? "请重新扫码"}。请让用户打开「小米笔记」面板扫码登录后重试。`,
        );
        error.needLogin = true;
        throw error;
      }
    }
    return;
  }
  const error = new Error("小米笔记还没有登录。请让用户打开「小米笔记」面板（命令面板搜「小米笔记」）扫码登录后重试。");
  error.needLogin = true;
  throw error;
}

/** 轮询一个 job 直到结束或超时。 */
async function waitForJob(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.getJob(jobId);
    if (!job) throw new Error("任务已丢失");
    if (job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error("任务超时");
    await sleep(400);
  }
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function formatTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  try {
    // 宿主把插件进程的 stdout/stderr 收进 plugin.log，排查问题时有用
    process.stdout.write(`[mi-note] ${message}\n`);
  } catch {
    /* 忽略 */
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke, lastActiveSurface };
