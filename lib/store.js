"use strict";

/**
 * 插件私有持久化：凭据 + 笔记缓存。
 *
 * 两个文件都写在插件数据目录（`pi.plugin.getDataPath()`，由宿主为每个插件分配的
 * 私有目录，宿主自身的 fs API 到不了这里）。凭据文件权限收紧到 0600，其他用户
 * 读不到。
 *
 * 注意：这里刻意用原生 node:fs，而不是宿主的 pi.fs.*
 *   - manifest 的 fs.write 语法上禁止整树通配，插件数据目录也不在 workspace 根下；
 *   - 凭据文件属于「插件自己的私有状态」，与工作区文件是两回事。
 * 插件不读工作区里的任何用户文件，只写自己数据目录下的这两个文件。
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const CREDENTIALS_FILE = "credentials.json";
const CACHE_FILE = "notes-cache.json";
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

class Store {
  /**
   * @param {() => Promise<string|null>} resolveDataDir 由宿主注入的数据目录解析器
   */
  constructor(resolveDataDir) {
    this.resolveDataDir = resolveDataDir;
    /** @type {string|null} */
    this.dataDir = null;
  }

  async dir() {
    if (this.dataDir) return this.dataDir;
    const resolved = await this.resolveDataDir();
    if (!resolved) throw new Error("无法解析插件数据目录");
    await fs.mkdir(resolved, { recursive: true });
    this.dataDir = resolved;
    return resolved;
  }

  async pathOf(name) {
    return path.join(await this.dir(), name);
  }

  // ── 凭据 ──────────────────────────────────────────────────────────────────

  async readCredentials() {
    try {
      const file = await this.pathOf(CREDENTIALS_FILE);
      const text = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  async writeCredentials(credentials) {
    const file = await this.pathOf(CREDENTIALS_FILE);
    await writeAtomic(file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  }

  async clearCredentials() {
    try {
      const file = await this.pathOf(CREDENTIALS_FILE);
      await fs.rm(file, { force: true });
    } catch {
      /* 文件不存在即视为已清理 */
    }
  }

  // ── 笔记缓存 ──────────────────────────────────────────────────────────────

  async readCache() {
    try {
      const file = await this.pathOf(CACHE_FILE);
      const stat = await fs.stat(file);
      if (stat.size > MAX_CACHE_BYTES) return null;
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async writeCache(snapshot) {
    const file = await this.pathOf(CACHE_FILE);
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text, "utf8") > MAX_CACHE_BYTES) return;
    await writeAtomic(file, text, { mode: 0o600 });
  }

  async clearCache() {
    try {
      const file = await this.pathOf(CACHE_FILE);
      await fs.rm(file, { force: true });
    } catch {
      /* 同上 */
    }
  }

  // ── 附件缓存 ──────────────────────────────────────────────────────────────
  /*
   * 附件二进制**必须**与 notes-cache.json 分开存。
   *
   * 原因：writeCache 超过 MAX_CACHE_BYTES 时是**静默丢弃**（直接 return，不报错）。
   * 如果把图片以 base64 塞进笔记缓存，一张 3MB 的照片就占 4MB，四张就撑爆 16MB，
   * 后果不只是图片存不下 —— 整个笔记缓存（含所有正文）会从此**永久停止更新**，
   * 而且冷启动时 readCache 又因体积超限返回 null，每次都要全量重拉。
   *
   * 所以：图片按 fileId 单独落盘，缓存里不出现任何二进制。
   */

  /** 附件目录；首次调用时创建。 */
  async attachmentDir() {
    const dir = path.join(await this.dir(), "attachments");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * 读一个已缓存的附件。
   * @param {string} fileId
   * @returns {Promise<Buffer|null>}
   */
  async readAttachment(fileId) {
    try {
      const file = path.join(await this.attachmentDir(), safeAttachmentName(fileId));
      return await fs.readFile(file);
    } catch {
      return null;
    }
  }

  /**
   * 写入附件缓存。
   * @param {string} fileId
   * @param {Buffer} buffer
   */
  async writeAttachment(fileId, buffer) {
    const dir = await this.attachmentDir();
    const file = path.join(dir, safeAttachmentName(fileId));
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, file);
  }

  /**
   * 按最近访问时间把附件缓存压到上限以内。
   *
   * 不设上限的话，一个重度用户几年下来会把数据目录撑到几个 GB。
   * 用 mtime 近似 LRU：读附件时顺手 touch，删除时保留最近用过的。
   *
   * @param {number} maxBytes
   */
  async trimAttachments(maxBytes) {
    try {
      const dir = await this.attachmentDir();
      const names = await fs.readdir(dir);
      const items = [];
      let total = 0;
      for (const name of names) {
        if (name.endsWith(".tmp")) {
          // 上次崩在 rename 之前留下的碎片
          await fs.rm(path.join(dir, name), { force: true });
          continue;
        }
        const stat = await fs.stat(path.join(dir, name));
        items.push({ name, size: stat.size, atime: stat.atimeMs || stat.mtimeMs });
        total += stat.size;
      }
      if (total <= maxBytes) return { removed: 0, total };
      // 最久未用的先删
      items.sort((a, b) => a.atime - b.atime);
      let removed = 0;
      for (const item of items) {
        if (total <= maxBytes) break;
        await fs.rm(path.join(dir, item.name), { force: true });
        total -= item.size;
        removed += 1;
      }
      return { removed, total };
    } catch {
      return { removed: 0, total: 0 };
    }
  }

  /** 读附件时更新访问时间，让 LRU 反映真实使用情况。 */
  async touchAttachment(fileId) {
    try {
      const file = path.join(await this.attachmentDir(), safeAttachmentName(fileId));
      const now = new Date();
      await fs.utimes(file, now, now);
    } catch {
      /* 文件可能已被 LRU 清掉，忽略 */
    }
  }

  async clearAttachments() {
    try {
      const dir = await this.attachmentDir();
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* 目录不存在即视为已清理 */
    }
  }
}

/**
 * 附件 id 来自服务端，理论上可信，但仍不能直接当文件名用：
 * 路径分隔符与 `..` 会造成目录穿越。这里只保留安全字符。
 */
function safeAttachmentName(fileId) {
  const cleaned = String(fileId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  // 去掉可能的前导点（隐藏文件 / ".." 片段）
  const trimmed = cleaned.replace(/^\.+/, "");
  return trimmed || "unnamed";
}

/** 原子写：临时文件 → rename，避免中途崩溃留下半截 JSON。 */
async function writeAtomic(file, content, { mode = 0o600 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, mode);
  } catch {
    /* Windows 上 chmod 语义有限，失败不影响功能 */
  }
}

module.exports = { Store, CREDENTIALS_FILE, CACHE_FILE, safeAttachmentName };
