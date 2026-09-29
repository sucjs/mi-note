"use strict";

/**
 * 笔记仓库：把「小米云 + 凭据 + 本地缓存」收成一个对象，供面板与 Agent 工具共用。
 *
 * 职责：
 *   - 凭据持久化（写在插件数据目录，见 store.js）
 *   - 增量同步：按 syncTag + modifyDate 判断哪些笔记需要重取正文，避免每次全量拉
 *   - 统一视图模型：列表项、正文（Markdown）、文件夹树
 *   - 写操作后本地即时更新 + 下一次同步对齐
 */

const {
  extractSnippet,
  fromImportedMarkdown,
  markdownToXml,
  summarize,
  titleFromMarkdown,
  xmlToMarkdown,
} = require("./converter.js");
const { MiNoteClient } = require("./client.js");
const { isNetworkError } = require("./http.js");

const DEFAULT_FOLDER_ID = "0";
/** 附件缓存上限：独立于笔记缓存，超限按 LRU 裁剪。 */
const ATTACHMENT_CACHE_BYTES = 200 * 1024 * 1024;

class NoteRepository {
  /**
   * @param {object} deps
   * @param {object} deps.store 持久化（credentials / cache）
   */
  constructor({ store } = {}) {
    this.store = store;
    /** @type {MiNoteClient|null} */
    this.client = null;
    /** @type {object|null} 当前凭据 */
    this.credentials = null;

    /** @type {Map<string, object>} 笔记元数据（来自列表接口，含 modifyDate/tag） */
    this.notes = new Map();
    /** @type {Map<string, string>} 笔记正文（Markdown） */
    this.bodies = new Map();
    /** @type {Map<string, object>} 文件夹 */
    this.folders = new Map();
    /** @type {Map<string, {dataUri:string, mimeType:string, bytes:number}>} 附件内存缓存 */
    this.attachments = new Map();
    this.syncTag = "";
    this.lastSyncAt = null;
    this.lastError = null;
    /** 同步状态（面板据此显式提示） */
    this.syncing = false;
    this._syncPromise = null;
    /**
     * 只拿到 snippet、还没补齐全文的笔记 id。
     * 单轮取正文有上限，超出的部分 modifyDate 又不会再变，
     * 靠它记住欠账，下一轮优先补齐。
     * @type {Set<string>}
     */
    this.snippetOnly = new Set();
    /**
     * 磁盘缓存写入节流句柄。
     *
     * writeCache 会把**整份**缓存（所有笔记正文）序列化后原子写一次。
     * 有了面板自动保存后，用户每打几个字就会触发一次 updateNote，
     * 若每次都整份重写磁盘，1.5 秒一次的频率会持续占用磁盘。
     * 所以写盘改成节流：短时间内多次改动只在最后一次真正落盘，
     * 需要立刻落盘时（同步完成 / 关闭插件）调用 flushCacheWrite()。
     */
    this._cacheTimer = null;
    this._cachePending = false;
  }

  /** 节流地把缓存写到磁盘（默认 10 秒合并窗口）。 */
  scheduleCacheWrite(delayMs = 10_000) {
    this._cachePending = true;
    if (this._cacheTimer) return;
    this._cacheTimer = setTimeout(() => {
      this._cacheTimer = null;
      if (!this._cachePending) return;
      this._cachePending = false;
      void this.store.writeCache(this.serialize()).catch(() => {
        /* 缓存写失败不影响内存态，下一轮同步会再写 */
      });
    }, delayMs);
  }

  /** 立刻把待写的缓存落盘（同步完成、插件卸载前调用）。 */
  async flushCacheWrite() {
    if (this._cacheTimer) {
      clearTimeout(this._cacheTimer);
      this._cacheTimer = null;
    }
    if (!this._cachePending) return;
    this._cachePending = false;
    try {
      await this.store.writeCache(this.serialize());
    } catch {
      /* 同上 */
    }
  }

  // ── 登录状态 ──────────────────────────────────────────────────────────────

  get loggedIn() {
    return Boolean(this.credentials?.serviceToken);
  }

  get userId() {
    return String(this.credentials?.userId ?? "");
  }

  /** 从磁盘恢复凭据并建立客户端（插件启动时调用）。 */
  async restore() {
    const saved = await this.store.readCredentials();
    if (!saved?.serviceToken) return false;
    this.adoptCredentials(saved);
    return true;
  }

  /** 用一份凭据（重新）建立客户端。 */
  adoptCredentials(credentials) {
    this.credentials = credentials;
    this.client = new MiNoteClient(credentials);
  }

  /** 保存新凭据（扫码登录完成后调用）。 */
  async saveCredentials(credentials) {
    this.adoptCredentials(credentials);
    await this.store.writeCredentials(credentials);
  }

  /** 清空登录态（退出登录）。 */
  async logout() {
    this.credentials = null;
    this.client = null;
    this.notes.clear();
    this.bodies.clear();
    this.folders.clear();
    this.attachments.clear();
    this.syncTag = "";
    this.lastSyncAt = null;
    await this.store.clearCredentials();
    await this.store.clearCache();
    // 附件是二进制内容，退出登录后不该继续留在磁盘上
    await this.store.clearAttachments();
  }

  /**
   * 探活：验证凭据是否仍有效（只探测，不续期）。
   *
   * 返回值里的 `network: true` 表示「这次失败是网络问题，凭据未必失效」——
   * 调用方据此区分提示文案，不要把网断说成登录失效。
   *
   * 0.2.6 起不再尝试静默续期：小米的续期接口在无人交互时只给验证挑战，
   * 换不到新 serviceToken（详见 auth.js 顶部说明）。失效就如实上报，由用户重新扫码。
   *
   * @returns {Promise<{ok:boolean, network?:boolean, error?:string}>}
   */
  async ensureSession() {
    if (!this.client) return { ok: false, error: "尚未登录" };
    try {
      await this.client.ping();
      return { ok: true };
    } catch (error) {
      if (isNetworkError(error)) return { ok: false, network: true, error: error.message };
      // 只有客户端明确判定的认证失败才算「登录已失效」，服务端 5xx 之类如实回报
      if (error?.needLogin) return { ok: false, error: "登录态已失效，请重新扫码登录" };
      return { ok: false, error: error.message };
    }
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  /**
   * 增量同步。
   *
   * 「增量」体现在两处：
   *   1. 列表接口带 syncTag，服务端只回变化过的条目；
   *   2. 正文只在 modifyDate 变了（或本地还没有）时才逐篇拉取。
   *
   * @param {{full?:boolean, withBodies?:boolean, onProgress?:(info:object)=>void}} [options]
   */
  async sync(options = {}) {
    if (!this.client) throw new Error("尚未登录");
    if (this._syncPromise) return this._syncPromise;
    this._syncPromise = this._doSync(options).finally(() => {
      this._syncPromise = null;
      this.syncing = false;
    });
    this.syncing = true;
    return this._syncPromise;
  }

  async _doSync(options) {
    const full = options.full === true;
    const withBodies = options.withBodies !== false;
    try {
      const list = await this.client.fetchAll({
        onProgress: (count) => options.onProgress?.({ phase: "list", count }),
      });

      const nextFolders = new Map();
      for (const [id, folder] of Object.entries(list.folders)) nextFolders.set(id, folder);
      this.folders = nextFolders;

      const previous = this.notes;
      const nextNotes = new Map();
      for (const entry of list.entries) {
        const before = previous.get(entry.id);
        nextNotes.set(entry.id, entry);
        // 云端条目可能带 content/snippet；先据此更新正文
        if (typeof entry.content === "string" && entry.content) {
          this.bodies.set(
            entry.id,
            xmlToMarkdown(entry.content, { files: filesOf(entry), withAttachmentPlaceholders: true }),
          );
          this.snippetOnly.delete(entry.id);
        } else if (!this.bodies.has(entry.id) && entry.snippet) {
          // 只有 snippet 时先垫一条可用正文，但记下来：它是摘要不是全文，
          // 下一轮同步必须优先补齐，否则这篇会永远停在摘要上。
          this.bodies.set(entry.id, xmlToMarkdown(entry.snippet, { files: filesOf(entry) }));
          this.snippetOnly.add(entry.id);
        }
      }

      // 列表接口通常只给 snippet，正文需要逐篇取
      if (withBodies) {
        // 需要取正文的两类：
        //   1. 新出现或 modifyDate 变了的（含 full 重拉）
        //   2. 上次只拿到 snippet、还没补齐全文的 —— 这类 modifyDate 没变，
        //      不特别照顾就会永远停在摘要上（超过单轮上限时尤其明显）
        const need = [];
        for (const entry of list.entries) {
          const before = previous.get(entry.id);
          const changed = full || !before || before.modifyDate !== entry.modifyDate;
          if (changed || this.snippetOnly.has(entry.id)) need.push(entry.id);
        }
        // 先补历史欠账，再按修改时间取新的，保证积压不会一直排在队尾
        need.sort((a, b) => {
          const aPending = this.snippetOnly.has(a) ? 1 : 0;
          const bPending = this.snippetOnly.has(b) ? 1 : 0;
          return bPending - aPending;
        });
        const limited = need.slice(0, options.maxDetails ?? 400);
        if (limited.length) {
          options.onProgress?.({ phase: "bodies", total: limited.length, done: 0 });
          let done = 0;
          const details = await this.client.getNotes(limited, { concurrency: 3 });
          for (const [id, detail] of details) {
            nextNotes.set(id, detail);
            this.bodies.set(
              id,
              xmlToMarkdown(detail.content ?? detail.snippet ?? "", {
                files: filesOf(detail),
                withAttachmentPlaceholders: true,
              }),
            );
            // 拿到真正的 content 才算补齐；只有 snippet 就继续记着欠账。
            if (typeof detail.content === "string" && detail.content) {
              this.snippetOnly.delete(id);
            } else {
              this.snippetOnly.add(id);
            }
            done += 1;
            options.onProgress?.({ phase: "bodies", total: limited.length, done });
          }
        }
      }

      // 清掉云端已删除的本地残留（正文缓存与欠账标记都要清）
      for (const id of [...this.bodies.keys()]) {
        if (!nextNotes.has(id)) {
          this.bodies.delete(id);
          this.snippetOnly.delete(id);
        }
      }
      for (const id of [...this.snippetOnly]) {
        if (!nextNotes.has(id)) this.snippetOnly.delete(id);
      }

      this.notes = nextNotes;
      this.syncTag = list.syncTag || this.syncTag;
      this.lastSyncAt = Date.now();
      this.lastError = null;
      // 同步是低频重操作，直接落盘（顺便把之前节流的待写内容一并写掉）
      this._cachePending = true;
      await this.flushCacheWrite();
      return {
        ok: true,
        notes: this.notes.size,
        folders: this.folders.size,
        at: this.lastSyncAt,
      };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  /** 从磁盘缓存快速预热（面板先有内容可显示，再等同步完成）。 */
  async warmFromCache() {
    const cached = await this.store.readCache();
    if (!cached) return false;
    try {
      this.folders = new Map((cached.folders ?? []).map((f) => [String(f.id), f]));
      this.notes = new Map((cached.notes ?? []).map((n) => [String(n.id), n]));
      this.bodies = new Map((cached.bodies ?? []).map((b) => [String(b.id), String(b.markdown ?? "")]));
      // 恢复欠账标记：插件重启后仍要把没补齐的正文取回来
      this.snippetOnly = new Set((cached.snippetOnly ?? []).map(String));
      this.syncTag = String(cached.syncTag ?? "");
      this.lastSyncAt = typeof cached.lastSyncAt === "number" ? cached.lastSyncAt : null;
      return this.notes.size > 0;
    } catch {
      return false;
    }
  }

  serialize() {
    return {
      version: 1,
      syncTag: this.syncTag,
      lastSyncAt: this.lastSyncAt,
      folders: [...this.folders.values()],
      notes: [...this.notes.values()],
      bodies: [...this.bodies.entries()].map(([id, markdown]) => ({ id, markdown })),
      snippetOnly: [...this.snippetOnly],
    };
  }

  // ── 读取视图 ──────────────────────────────────────────────────────────────

  /** 文件夹列表（含每个文件夹的笔记数）。 */
  listFolders() {
    const counts = new Map();
    for (const note of this.notes.values()) {
      const key = String(note.folderId ?? DEFAULT_FOLDER_ID);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const list = [...this.folders.values()].map((folder) => ({
      id: String(folder.id),
      name: String(folder.subject ?? "未命名文件夹"),
      parentId: String(folder.folderId ?? DEFAULT_FOLDER_ID),
      count: counts.get(String(folder.id)) ?? 0,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    return {
      root: {
        id: DEFAULT_FOLDER_ID,
        name: "全部笔记",
        count: this.notes.size,
      },
      folders: list,
    };
  }

  /**
   * 笔记列表。
   * @param {{folderId?:string, query?:string, limit?:number, offset?:number}} [options]
   */
  listNotes(options = {}) {
    const folderId = options.folderId ? String(options.folderId) : "";
    const query = String(options.query ?? "").trim().toLowerCase();
    let items = [...this.notes.values()];
    if (folderId && folderId !== DEFAULT_FOLDER_ID) {
      items = items.filter((note) => String(note.folderId ?? DEFAULT_FOLDER_ID) === folderId);
    }
    if (query) {
      items = items.filter((note) => {
        const title = this.titleOf(note).toLowerCase();
        const body = (this.bodies.get(note.id) ?? "").toLowerCase();
        return title.includes(query) || body.includes(query);
      });
    }
    items.sort((a, b) => Number(b.modifyDate ?? 0) - Number(a.modifyDate ?? 0));

    const total = items.length;
    const offset = Math.max(0, Number(options.offset ?? 0));
    const limit = Math.max(1, Math.min(Number(options.limit ?? 200), 500));
    const page = items.slice(offset, offset + limit);

    const resolved = new Map();
    for (const note of page) {
      resolved.set(String(note.folderId ?? DEFAULT_FOLDER_ID), this.folderName(note.folderId));
    }

    return {
      total,
      offset,
      limit,
      items: page.map((note) => ({
        id: String(note.id),
        title: this.titleOf(note),
        summary: this.summaryOf(note),
        folderId: String(note.folderId ?? DEFAULT_FOLDER_ID),
        folderName: this.folderName(note.folderId),
        createDate: Number(note.createDate ?? 0),
        modifyDate: Number(note.modifyDate ?? 0),
        colorId: Number(note.colorId ?? 0),
        hasBody: this.bodies.has(String(note.id)),
      })),
    };
  }

  titleOf(note) {
    const extra = parseExtraInfo(note?.extraInfo);
    const fromExtra = String(extra.title ?? "").trim();
    if (fromExtra) return fromExtra;
    const subject = String(note?.subject ?? "").trim();
    if (subject) return subject;
    const body = this.bodies.get(String(note?.id)) ?? "";
    const fromBody = titleFromMarkdown(body);
    if (fromBody) return fromBody;
    return `未命名笔记 ${String(note?.id ?? "").slice(-6)}`;
  }

  summaryOf(note) {
    const id = String(note?.id ?? "");
    const body = this.bodies.get(id) ?? "";
    if (body) return summarize(body, 90);
    const fromSnippet = xmlToMarkdown(String(note?.snippet ?? ""), { files: filesOf(note) });
    return summarize(fromSnippet, 90);
  }

  folderName(folderId) {
    const id = String(folderId ?? DEFAULT_FOLDER_ID);
    if (id === DEFAULT_FOLDER_ID) return "";
    return String(this.folders.get(id)?.subject ?? "");
  }

  hasNote(noteId) {
    return this.notes.has(String(noteId));
  }

  /** 取一篇笔记（元数据 + Markdown 正文）。 */
  getNote(noteId) {
    const id = String(noteId);
    const meta = this.notes.get(id);
    if (!meta) return null;
    return {
      id,
      title: this.titleOf(meta),
      markdown: this.bodies.get(id) ?? "",
      folderId: String(meta.folderId ?? DEFAULT_FOLDER_ID),
      folderName: this.folderName(meta.folderId),
      createDate: Number(meta.createDate ?? 0),
      modifyDate: Number(meta.modifyDate ?? 0),
      rawMarkdownAvailable: this.bodies.has(id),
    };
  }

  /**
   * 取一个附件的二进制，并转成 data URI 供面板 <img src> 使用。
   *
   * 三级来源：内存缓存 → 磁盘缓存 → 云端下载。
   * 磁盘缓存与笔记缓存**分开**（见 store.js 的说明）：图片绝不能进 notes-cache.json，
   * 那个文件有 16MB 上限且超限是静默丢弃，会把整个笔记缓存一起搞坏。
   *
   * @param {string} fileId
   * @param {"image"|"audio"|"video"} [kind]
   * @returns {Promise<{dataUri:string, mimeType:string, bytes:number, from:string}>}
   */
  async getAttachment(fileId, kind = "image") {
    const id = String(fileId);
    const cacheKey = `${kind}:${id}`;

    const memory = this.attachments.get(cacheKey);
    if (memory) {
      void this.store.touchAttachment(cacheKey);
      return { ...memory, from: "memory" };
    }

    let buffer = await this.store.readAttachment(cacheKey);
    if (buffer && buffer.length) {
      void this.store.touchAttachment(cacheKey);
      const mimeType = sniffMimeType(buffer, kind);
      const entry = { dataUri: toDataUri(buffer, mimeType), mimeType, bytes: buffer.length };
      this.attachments.set(cacheKey, entry);
      return { ...entry, from: "disk" };
    }

    if (!this.client) throw new Error("尚未登录，无法下载附件");
    const type = kind === "audio" ? "note_sound" : kind === "video" ? "note_video" : "note_img";
    const result = await this.client.fetchAttachment(id, type);
    buffer = result.buffer;
    const mimeType = normalizeMimeType(result.contentType, buffer, kind);
    await this.store.writeAttachment(cacheKey, buffer);
    const entry = { dataUri: toDataUri(buffer, mimeType), mimeType, bytes: buffer.length };
    this.attachments.set(cacheKey, entry);
    // 后台裁剪，别让下载路径被清理拖慢
    void this.store.trimAttachments(ATTACHMENT_CACHE_BYTES).catch(() => {});
    return { ...entry, from: "network" };
  }

  /** 退出登录时清掉附件缓存（二进制可能包含隐私内容）。 */
  async clearAttachments() {
    this.attachments.clear();
    await this.store.clearAttachments();
  }

  /** 强制从云端取最新正文（编辑前调用，避免拿缓存覆盖别人的改动）。 */
  async loadNoteFresh(noteId) {
    if (!this.client) throw new Error("尚未登录");
    const detail = await this.client.getNote(noteId);
    this.notes.set(String(detail.id), detail);
    const markdown = xmlToMarkdown(detail.content ?? detail.snippet ?? "", {
      files: filesOf(detail),
    });
    this.bodies.set(String(detail.id), markdown);
    // 这次是从云端现取的：拿到 content 就算补齐，否则继续记着欠账。
    if (typeof detail.content === "string" && detail.content) {
      this.snippetOnly.delete(String(detail.id));
    } else {
      this.snippetOnly.add(String(detail.id));
    }
    return {
      id: String(detail.id),
      title: this.titleOf(detail),
      markdown,
      folderId: String(detail.folderId ?? DEFAULT_FOLDER_ID),
      folderName: this.folderName(detail.folderId),
      createDate: Number(detail.createDate ?? 0),
      modifyDate: Number(detail.modifyDate ?? 0),
    };
  }

  // ── 写入 ──────────────────────────────────────────────────────────────────

  /**
   * 新建笔记。
   * @param {{title?:string, markdown?:string, folderId?:string}} input
   */
  async createNote(input) {
    if (!this.client) throw new Error("尚未登录");
    const markdown = String(input.markdown ?? "");
    const title = String(input.title ?? "").trim() || titleFromMarkdown(markdown);
    const xml = markdownToXml(markdown);
    const now = Date.now();
    const entry = {
      colorId: 0,
      folderId: String(input.folderId ?? DEFAULT_FOLDER_ID) || DEFAULT_FOLDER_ID,
      createDate: now,
      modifyDate: now,
      content: xml,
      alertDate: 0,
      setting: { themeId: 0, stickyTime: 0, version: 0 },
      extraInfo: buildExtraInfo(title),
      snippet: extractSnippet(xml),
      subject: title,
    };
    const created = await this.client.createNote(entry);
    const id = String(created.id);
    this.notes.set(id, created);
    this.bodies.set(id, markdown);
    this.scheduleCacheWrite();
    return this.getNote(id);
  }

  /**
   * 更新笔记正文 / 标题 / 所属文件夹。
   * @param {string} noteId
   * @param {{markdown?:string, title?:string, folderId?:string}} patch
   */
  async updateNote(noteId, patch) {
    if (!this.client) throw new Error("尚未登录");
    const id = String(noteId);
    // 更新前必取最新 tag（乐观锁），否则会撞冲突
    const current = await this.client.getNote(id);
    // 没传 markdown 时表示「只改标题 / 文件夹」：必须原样回写云端已有的正文。
    // 不能拿本地缓存或 snippet 代答 —— 本地正文可能是截断的摘要（同步上限、
    // 单篇详情失败都会导致），一旦把它写回去，服务的全文就永久丢了。
    let xml;
    let nextMarkdown;
    if (patch.markdown !== undefined) {
      nextMarkdown = String(patch.markdown);
      xml = markdownToXml(nextMarkdown);
    } else {
      xml = typeof current.content === "string" && current.content
        ? current.content
        : String(current.snippet ?? "");
      nextMarkdown = null;
    }
    const now = Date.now();
    const nextTitle = patch.title !== undefined
      ? String(patch.title).trim()
      : this.titleOf(current);
    const entry = {
      id,
      tag: current.tag,
      status: current.status,
      createDate: current.createDate ?? now,
      modifyDate: now,
      colorId: current.colorId ?? 0,
      content: xml,
      setting: current.setting ?? { themeId: 0, stickyTime: 0, version: 0 },
      folderId: String(patch.folderId ?? current.folderId ?? DEFAULT_FOLDER_ID) || DEFAULT_FOLDER_ID,
      alertDate: current.alertDate ?? 0,
      extraInfo: buildExtraInfo(nextTitle, current.extraInfo),
      subject: nextTitle,
      snippet: extractSnippet(xml),
    };
    const updated = await this.client.updateNote(id, entry);
    this.notes.set(id, { ...current, ...updated, id, content: xml });
    // 只更新标题时（nextMarkdown 为 null）不动本地正文 —— 它可能就是摘要，
    // 拿它覆盖真实正文会让本地缓存从此撒谎。正文改动过才刷新缓存。
    if (nextMarkdown !== null) {
      this.bodies.set(id, nextMarkdown);
    } else if (!this.bodies.has(id)) {
      this.bodies.set(id, xmlToMarkdown(xml, { files: filesOf(current) }));
    }
    // 自动保存会高频走到这里，用节流写盘（10 秒合并窗口）
    this.scheduleCacheWrite();
    return this.getNote(id);
  }

  /** 删除笔记（purge=false 进回收站；purge=true 彻底删除）。 */
  async deleteNote(noteId, { purge = false } = {}) {
    if (!this.client) throw new Error("尚未登录");
    const id = String(noteId);
    const meta = this.notes.get(id);
    await this.client.deleteNote(id, { tag: meta?.tag, purge });
    this.notes.delete(id);
    this.bodies.delete(id);
    // 删除要立即反映到磁盘缓存，避免重启后被删的笔记又冒出来
    this._cachePending = true;
    await this.flushCacheWrite();
    return { ok: true, id };
  }

  /** 新建文件夹。 */
  async createFolder(name, parentId = DEFAULT_FOLDER_ID) {
    if (!this.client) throw new Error("尚未登录");
    const created = await this.client.createFolder(String(name).trim(), String(parentId));
    this.folders.set(String(created.id), created);
    this._cachePending = true;
    await this.flushCacheWrite();
    return { id: String(created.id), name: String(created.subject ?? name) };
  }

  // ── 批量导入 ──────────────────────────────────────────────────────────────

  /**
   * 批量导入外部 Markdown 文件。
   *
   * 文件内容由**面板**读好传进来（`<input type="file">` / 拖拽拿到的 File 对象），
   * 插件进程完全不碰用户文件系统 —— 这样「不读也不写你的工作区文件」这条对外
   * 承诺依然成立，manifest 也不需要新增任何 fs.* 权限。
   *
   * 几个刻意的设计：
   *   - **单篇失败不中断**：导入 200 篇时不该因为第 3 篇标题过长被服务端拒绝
   *     就整批作废。失败的逐条记下来，最后一并回报。
   *   - **文件夹按 (parentId, name) 复用**：同名目录只建一次。否则递归导入一个
   *     项目目录会在云端生成几十个重名文件夹。
   *   - **顺序执行 + 轻微间隔**：并发写会撞服务端风控（与 fetchAll 翻页同理）。
   *
   * @param {{
   *   items: Array<{name:string, markdown:string, dirs?:string[]}>,
   *   folderId?:string,
   *   keepStructure?:boolean,
   *   onProgress?:(info:{done:number,total:number,title:string})=>void,
   *   maxItems?:number
   * }} input
   * @returns {Promise<{created:number, failed:Array<{name:string,error:string}>, foldersCreated:number, skipped:number}>}
   */
  async importNotes(input = {}) {
    if (!this.client) throw new Error("尚未登录");
    const items = Array.isArray(input.items) ? input.items : [];
    const keepStructure = input.keepStructure === true;
    const rootFolderId = String(input.folderId ?? DEFAULT_FOLDER_ID) || DEFAULT_FOLDER_ID;
    const maxItems = Number.isFinite(input.maxItems) ? Number(input.maxItems) : 500;

    const failed = [];
    let created = 0;
    let foldersCreated = 0;

    if (items.length > maxItems) {
      for (const item of items.slice(maxItems)) {
        failed.push({ name: String(item?.name ?? ""), error: `超出单次上限（${maxItems} 篇），未导入` });
      }
    }
    const todo = items.slice(0, maxItems);
    const total = todo.length;

    /*
     * 文件夹索引：`${parentId}\u0000${name}` → folderId。
     * 先灌入已有文件夹，这样「导入到一个已有同名文件夹」不会重复建。
     */
    const folderIndex = new Map();
    const indexKey = (parentId, name) => `${parentId}\u0000${String(name).trim().toLowerCase()}`;
    for (const folder of this.folders.values()) {
      const parent = String(folder.folderId ?? DEFAULT_FOLDER_ID);
      folderIndex.set(indexKey(parent, String(folder.subject ?? "")), String(folder.id));
    }

    /** 按需（递归）建出 dirs 对应的文件夹，返回叶子 folderId。 */
    const ensureFolderPath = async (dirs) => {
      let parentId = rootFolderId;
      for (const rawName of dirs) {
        const name = String(rawName ?? "").trim();
        if (!name) continue;
        const key = indexKey(parentId, name);
        const existing = folderIndex.get(key);
        if (existing) {
          parentId = existing;
          continue;
        }
        const made = await this.createFolder(name, parentId);
        folderIndex.set(key, made.id);
        foldersCreated += 1;
        parentId = made.id;
      }
      return parentId;
    };

    let done = 0;
    for (const item of todo) {
      const name = String(item?.name ?? "");
      const markdown = String(item?.markdown ?? "");
      try {
        // 空文件也允许导入：用户可能先建好标题占位，之后再填
        const parsed = fromImportedMarkdown({ name, markdown });
        const dirs = keepStructure && Array.isArray(item?.dirs) ? item.dirs : [];
        const targetFolderId = dirs.length ? await ensureFolderPath(dirs) : rootFolderId;

        const note = await this.createNote({
          title: parsed.title,
          markdown: parsed.markdown,
          folderId: targetFolderId,
        });
        created += 1;
        done += 1;
        input.onProgress?.({ done, total, title: note?.title ?? parsed.title });
      } catch (error) {
        done += 1;
        failed.push({ name, error: error?.message ?? String(error) });
        input.onProgress?.({ done, total, title: name });
        // 凭据失效就别再往下试了，后面每一篇都会以同样的理由失败
        if (error?.needLogin) break;
      }
      // 顺序写 + 间隔，避免撞服务端风控
      await sleep(140 + Math.random() * 120);
    }

    // 导入会新增笔记与文件夹，缓存立刻落盘，免得重启后看不到
    this._cachePending = true;
    await this.flushCacheWrite();

    return { created, failed, foldersCreated, skipped: items.length - todo.length };
  }

  // ── 供 AI 问答使用的检索 ───────────────────────────────────────────────────

  /**
   * 选出与问题最相关的笔记片段。
   *
   * 纯本地打分：标题命中权重更高，正文按命中次数累加，再做一次长度归一，
   * 这样长笔记不会仅因为篇幅大就压倒短但更相关的笔记。
   *
   * @param {string} question
   * @param {{limit?:number, maxChars?:number}} [options]
   */
  searchForAnswer(question, options = {}) {
    const terms = tokenize(question);
    const limit = options.limit ?? 8;
    const maxChars = options.maxChars ?? 3000;
    const scored = [];
    for (const note of this.notes.values()) {
      const id = String(note.id);
      const title = this.titleOf(note).toLowerCase();
      const body = this.bodies.get(id) ?? "";
      const lower = body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!term) continue;
        if (title.includes(term)) score += 8;
        let from = 0;
        let hits = 0;
        while (hits < 12) {
          const at = lower.indexOf(term, from);
          if (at < 0) break;
          hits += 1;
          from = at + term.length;
        }
        score += hits * 2;
      }
      if (score <= 0) continue;
      score += Math.min(4, Math.log2(body.length + 2));
      scored.push({ note, score, body });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ note, body }) => ({
      id: String(note.id),
      title: this.titleOf(note),
      folderName: this.folderName(note.folderId),
      modifyDate: Number(note.modifyDate ?? 0),
      excerpt: clip(body, maxChars),
    }));
  }

  /** 无检索词命中时的兜底：最近的若干篇。 */
  recentNotes(limit = 6, maxChars = 1500) {
    const items = [...this.notes.values()]
      .sort((a, b) => Number(b.modifyDate ?? 0) - Number(a.modifyDate ?? 0))
      .slice(0, limit);
    return items.map((note) => ({
      id: String(note.id),
      title: this.titleOf(note),
      folderName: this.folderName(note.folderId),
      modifyDate: Number(note.modifyDate ?? 0),
      excerpt: clip(this.bodies.get(String(note.id)) ?? "", maxChars),
    }));
  }

  /** 面板状态快照。 */
  status() {
    return {
      loggedIn: this.loggedIn,
      userId: this.userId,
      noteCount: this.notes.size,
      folderCount: this.folders.size,
      lastSyncAt: this.lastSyncAt,
      syncing: this.syncing,
      lastError: this.lastError,
    };
  }
}

function filesOf(entry) {
  const raw = entry?.setting?.data ?? entry?.files ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((file) => {
    const rawId = String(file.rawId ?? file.fileId ?? file.digest ?? "");
    const dot = rawId.indexOf(".");
    const fileId = dot >= 0 ? rawId.slice(dot + 1) : rawId;
    const mimeType = String(file.mimeType ?? "");
    return {
      rawId,
      fileId,
      mimeType,
      // 服务端不一定给名字；不给时用 id 尾部当占位标签，总比空着强
      name: String(file.name ?? file.fileName ?? "") || fileId.slice(-8),
      size: Number(file.size ?? 0),
      // img / audio / video：按 mime 归类，决定下载时用哪个 type 参数
      kind: mimeType.startsWith("audio/")
        ? "audio"
        : mimeType.startsWith("video/")
          ? "video"
          : "image",
    };
  });
}

/** 按二进制头部魔数猜类型：服务端有时不给 content-type。 */
function sniffMimeType(buffer, kind) {
  const b = buffer;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 6 && b.slice(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (b.length >= 12 && b.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 4 && b.slice(0, 4).toString("latin1") === "RIFF") return "audio/wav";
  if (b.length >= 4 && b.slice(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (b.length >= 12 && b.slice(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  return kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "image/jpeg";
}

/** 优先信任服务端的 content-type，不可用时退回魔数嗅探。 */
function normalizeMimeType(contentType, buffer, kind) {
  const raw = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (raw && raw !== "application/octet-stream" && raw !== "text/plain") return raw;
  return sniffMimeType(buffer, kind);
}

/** Buffer → data URI。面板是 file:// 沙箱页，data URI 比 file:// 路径稳。 */
function toDataUri(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function parseExtraInfo(raw) {  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 保留原有 extraInfo 字段，只覆盖标题。 */
function buildExtraInfo(title, existing) {
  const base = parseExtraInfo(existing);
  const merged = {
    note_content_type: base.note_content_type ?? "common",
    title: title || base.title,
    web_images: base.web_images,
    mind_content: base.mind_content,
    mind_content_plain_text: base.mind_content_plain_text,
  };
  const entries = Object.entries(merged).filter(([, value]) => value !== undefined && value !== "");
  if (!entries.length) return undefined;
  return JSON.stringify(Object.fromEntries(entries));
}

/** 中文按字（双字）切、英文按词切，够用且不需要分词库。 */
function tokenize(text) {
  const value = String(text ?? "").toLowerCase();
  const terms = new Set();
  for (const word of value.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word);
  const cjk = value.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length <= 3) {
      terms.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) terms.add(run.slice(i, i + 2));
  }
  return [...terms].slice(0, 60);
}

function clip(text, maxChars) {
  const value = String(text ?? "");
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/** 定时器封装：批量导入每篇之间的间隔用它，便于阅读也便于测试。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { DEFAULT_FOLDER_ID, NoteRepository, buildExtraInfo, filesOf, tokenize };
