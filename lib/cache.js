// dsh-obsidian-assistant — 本地缓存。
//
// 缓存只落在插件目录（与 quicknotes.jsonl 同级），不进 vault、不进 git。
// 三块内容：
//   today   ：当天「那年今天」结果（含模型摘要），按本地日期 + vault 指纹失效
//   walk    ：当天预生成的一封信，按本地日期 + vault 指纹失效
//   related ：相同查询的语义检索结果，按查询哈希 + TTL 失效
//
// 写盘用 tmp + rename，避免进程中断留下半个 JSON。缓存写失败只降级为内存
// 缓存并告警一次，绝不影响主流程。
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "./policy.js";

const CACHE_VERSION = 2;

function emptyData() {
  return { version: CACHE_VERSION, updatedAt: 0, today: null, walk: null, related: {} };
}

export class CacheStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, ".obsbn-cache.json");
    this.tmp = this.file + ".tmp";
    this.data = emptyData();
    this.loaded = false;
    this.writable = true;
    this._writeChain = Promise.resolve();
    this._loadPromise = null;
    this._warned = false;
  }

  /** 读缓存；损坏、超限、版本不符都退回空缓存。
   *  并发调用共享同一个加载 Promise，避免第二个调用者拿到尚未填充的空对象。 */
  async load() {
    if (this.loaded) return this.data;
    if (!this._loadPromise) {
      this._loadPromise = this._loadFromDisk().then(() => {
        this.loaded = true;
        return this.data;
      });
    }
    return this._loadPromise;
  }

  async _loadFromDisk() {
    try {
      const st = await stat(this.file);
      if (st.size > LIMITS.cache.maxFileBytes) {
        console.warn("[obsidian-assistant] 缓存文件异常大，已忽略：" + this.file);
        return;
      }
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === CACHE_VERSION && typeof parsed === "object") {
        this.data = Object.assign(emptyData(), parsed);
        if (!this.data.related || typeof this.data.related !== "object") this.data.related = {};
      }
    } catch {
      // 首次运行没有缓存文件，属于正常情况。
    }
  }

  /** 串行写盘；失败后降级为内存缓存。 */
  async flush() {
    if (!this.writable) return false;
    this.data.updatedAt = Date.now();
    const body = JSON.stringify(this.data);
    this._writeChain = this._writeChain.then(async () => {
      if (!this.writable) return false;
      try {
        await writeFile(this.tmp, body, "utf8");
        await rename(this.tmp, this.file);
        return true;
      } catch (error) {
        this.writable = false;
        if (!this._warned) {
          this._warned = true;
          console.warn("[obsidian-assistant] 缓存写盘失败，本次运行退化为内存缓存：" + String(error && error.message ? error.message : error));
        }
        return false;
      }
    });
    return this._writeChain;
  }

  getToday() {
    return this.data.today && typeof this.data.today === "object" ? this.data.today : null;
  }

  async setToday(entry) {
    this.data.today = entry;
    await this.flush();
  }

  getWalk() {
    return this.data.walk && typeof this.data.walk === "object" ? this.data.walk : null;
  }

  async setWalk(entry) {
    this.data.walk = entry;
    await this.flush();
  }

  /** 取一条相关笔记缓存；过期或不存在返回 null。 */
  getRelated(key) {
    const table = this.data.related || {};
    const hit = table[key];
    if (!hit || !Array.isArray(hit.results)) return null;
    if (Date.now() - Number(hit.at || 0) > LIMITS.related.cacheTtlMs) return null;
    return hit;
  }

  /** 写一条相关笔记缓存，并按最近使用时间裁到上限。 */
  async setRelated(key, results) {
    const table = this.data.related || (this.data.related = {});
    table[key] = { at: Date.now(), results };
    const keys = Object.keys(table);
    if (keys.length > LIMITS.related.cacheMaxEntries) {
      keys
        .sort((a, b) => Number(table[a].at || 0) - Number(table[b].at || 0))
        .slice(0, keys.length - LIMITS.related.cacheMaxEntries)
        .forEach((old) => {
          delete table[old];
        });
    }
    await this.flush();
  }
}
