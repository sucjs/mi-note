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

module.exports = { Store, CREDENTIALS_FILE, CACHE_FILE };
