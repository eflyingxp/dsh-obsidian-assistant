// dsh-obsidian-assistant — Host half.
// 提供 'obsbn' Remote 服务：那年今天 / 随机漫步 / 快速笔记 / 相关笔记 / 读原文 / 自检。
//
// 0.2.0 的三条主线：
//   1) 预计算 + 缓存：today / walk 的结果按「本地日期 + vault 指纹」缓存，
//      每天只扫一次、只调一次模型；面板打开直接取缓存。
//   2) 土版异步：冷启动时先返回 warming，后台扫描，面板轮询取结果，
//      旧缓存则先展示旧结果再后台刷新（stale-while-revalidate）。
//   3) 边界与自检：所有路径/尺寸/查询上限集中在 lib/policy.js；
//      health() 只读检查 vault、日记目录、语义脚本、解释器、shell API、缓存可写。
//
// 本机路径全部可配置（cordis.patch.yml 插件行 config，或同名环境变量）：
//   vault           DSH_OBSIDIAN_VAULT             Obsidian vault 绝对路径（必填）
//   journalsDir     DSH_OBSIDIAN_JOURNALS          日记目录（vault 内相对路径，默认 raw/journals）
//   walkDirs                                        随机漫步候选目录前缀（默认取 journalsDir）
//   skipWikiSubdirs                                 「那年今天」要跳过的 wiki 子目录名（默认 lint）
//   semanticScript  DSH_OBSIDIAN_SEMANTIC          语义检索脚本路径（可选；为空则「找相关笔记」禁用）
//   python          DSH_OBSIDIAN_PYTHON            扫描解释器（默认 python3，只依赖标准库）
//   semanticPython  DSH_OBSIDIAN_SEMANTIC_PYTHON   语义脚本解释器（默认同 python，需 numpy）
//   warmup          DSH_OBSIDIAN_WARMUP            启动后预计算（默认 true；false 关闭）
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { mkdir, readFile, writeFile, appendFile, stat, open, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { VaultPolicy, LIMITS, PolicyError, sanitizeExclude, stripFrontmatter } from "./policy.js";
import { vaultFingerprint } from "./fingerprint.js";
import { CacheStore } from "./cache.js";
import { Health } from "./health.js";
import { runScan, runSemanticSearch } from "./scan.js";

/** 插件目录：用于快速笔记日志与缓存文件（不进 vault、不进 git）。 */
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 快速笔记日志（不进 vault）：每行一条 {date,time,text}，支撑「最近记录」。
 *  默认在插件目录；测试或多实例场景可用 config.logFile 覆盖。 */
const DEFAULT_LOG_FILE = join(PLUGIN_DIR, "quicknotes.jsonl");

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** 启动后多久开始预计算（等 llm / agentDefaultModel 服务就绪）。 */
const WARMUP_DELAY_MS = 4000;

/** 不依赖 TS 装饰器：手工在原型上标记 Remote 方法（与 typert-protocol 的
 *  mark() 产出完全相同的 v1 descriptor，走 Gateway 的 conservative SRC 路径）。 */
function markRemote(prototype, method) {
  const prev = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value;
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        ...(prev?.methods ?? []),
        Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) }),
      ]),
    }),
  });
}

function parseBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off", ""].includes(v)) return false;
  }
  return fallback;
}

function errorMessage(error) {
  if (error instanceof PolicyError) return error.message;
  if (error && typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function fallbackSummary(entry) {
  const snippet = typeof entry.snippet === "string" ? entry.snippet : "";
  return snippet.length <= 60 ? snippet : snippet.slice(0, 57) + "…";
}

class ObsbnService extends TypertRemoteService {
  static inject = ["shell"];

  constructor(ctx, config) {
    super(ctx, "obsbn");
    const cfg = config || {};
    const env = process.env;
    const vault = String(cfg.vault || env.DSH_OBSIDIAN_VAULT || "").trim();
    const python = String(cfg.python || env.DSH_OBSIDIAN_PYTHON || "python3").trim() || "python3";
    const semPython =
      String(cfg.semanticPython || env.DSH_OBSIDIAN_SEMANTIC_PYTHON || python).trim() || python;
    const policy = new VaultPolicy(vault, cfg.journalsDir || env.DSH_OBSIDIAN_JOURNALS || "raw/journals");

    this.cfg = {
      vault,
      journalsDir: policy.journalsDir,
      walkDirs:
        Array.isArray(cfg.walkDirs) && cfg.walkDirs.length > 0
          ? cfg.walkDirs.map((d) => String(d)).filter(Boolean)
          : null,
      skipWikiSubdirs:
        Array.isArray(cfg.skipWikiSubdirs) && cfg.skipWikiSubdirs.length > 0
          ? cfg.skipWikiSubdirs.map((d) => String(d))
          : ["lint"],
      semanticScript: String(cfg.semanticScript || env.DSH_OBSIDIAN_SEMANTIC || "").trim(),
      python,
      semanticPython: semPython,
      warmup: parseBool(cfg.warmup, parseBool(env.DSH_OBSIDIAN_WARMUP, true)),
    };
    if (!this.cfg.walkDirs) {
      this.cfg.walkDirs = [this.cfg.journalsDir.replace(/\/+$/, "") + "/"];
    }
    this.policy = policy;
    this.logFile = String(cfg.logFile || env.DSH_OBSIDIAN_LOG || DEFAULT_LOG_FILE);
    const cacheDir = String(cfg.cacheDir || env.DSH_OBSIDIAN_CACHE_DIR || PLUGIN_DIR);
    this.cacheStore = new CacheStore(cacheDir);
    this.healthChecker = new Health({
      cfg: this.cfg,
      shell: this.ctx.shell,
      pluginDir: PLUGIN_DIR,
      journalsDirWarning: policy.journalsDirWarning,
      cacheWritable: () => this.cacheStore.writable,
    });
    /** @type {Map<string, object>} 后台任务登记表：today / walk / today-summary / related:<hash> */
    this._jobs = new Map();
    /** @type {Map<string, Promise>} 语义检索同名查询去重 */
    this._relatedInflight = new Map();
    this._sigCache = null;
    this._healthCache = null;
    /** 原始实例引用：Gateway 用追踪代理调用方法，延迟任务必须落在原始实例上，
     *  否则回调可能落到已释放的调用上下文。 */
    this._self = this;

    if (!this.cfg.vault) {
      console.warn(
        "[obsidian-assistant] 未配置 vault 路径。请在 cordis.patch.yml 的插件行 config.vault 填写 Obsidian vault 绝对路径，或设置环境变量 DSH_OBSIDIAN_VAULT。"
      );
    }
    if (policy.journalsDirWarning) {
      console.warn("[obsidian-assistant] journalsDir 配置非法（" + policy.journalsDirWarning + "），已回退为 " + policy.journalsDir);
    }

    if (this.cfg.warmup && this.cfg.vault) {
      const self = this._self;
      this._warmTimer = setTimeout(() => {
        self._warm().catch((error) => {
          console.warn("[obsidian-assistant] 预计算失败：" + errorMessage(error));
        });
      }, WARMUP_DELAY_MS);
      this._warmTimer.unref?.();
    }
  }

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  _walkDirsSlashes() {
    return this.cfg.walkDirs.map((d) => (d.endsWith("/") ? d : d + "/"));
  }

  _todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const dayKey = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    return { y: d.getFullYear(), mm: d.getMonth() + 1, dd: d.getDate(), file: dayKey, dayKey };
  }

  _llmReady() {
    try {
      const llm = this.ctx.get("llm");
      const sel = this.ctx.get("agentDefaultModel");
      if (llm === undefined || sel === undefined) return false;
      const s = sel.currentSelection();
      return !!(s && s.provider && s.model);
    } catch {
      return false;
    }
  }

  async _llmComplete(system, user, maxTokens) {
    const llm = this.ctx.get("llm");
    const sel = this.ctx.get("agentDefaultModel");
    if (llm === undefined || sel === undefined) return null;
    const s = sel.currentSelection();
    if (!s || !s.provider || !s.model) return null;
    let text = "";
    const stream = llm.stream({
      provider: s.provider,
      model: s.model,
      system,
      maxTokens: maxTokens || 1500,
      messages: [
        {
          id: "obbn-" + Date.now(),
          role: "user",
          content: [{ type: "text", text: user }],
          source: { kind: "tool" },
        },
      ],
    });
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") text += chunk.text;
    }
    return text.trim() || null;
  }

  /** vault 指纹（带 60s 内存缓存）。失败返回空串，调用方按「不可信」处理。 */
  async _vaultSig(force = false) {
    if (!this.cfg.vault) return "";
    const now = Date.now();
    if (!force && this._sigCache && now - this._sigCache.at < LIMITS.cache.sigTtlMs) {
      return this._sigCache.sig;
    }
    try {
      const fp = await vaultFingerprint(this.cfg.vault, { skipWikiSubdirs: this.cfg.skipWikiSubdirs });
      this._sigCache = { sig: fp.sig, at: now };
      return fp.sig;
    } catch (error) {
      console.warn("[obsidian-assistant] 计算 vault 指纹失败：" + errorMessage(error));
      return "";
    }
  }

  /** 缓存是否仍可信：10 分钟内直接信任；之后比指纹。 */
  async _cacheTrustworthy(hit) {
    if (!hit) return false;
    if (Date.now() - Number(hit.at || 0) < LIMITS.cache.trustMs) return true;
    const sig = await this._vaultSig();
    return !!sig && sig === hit.sig;
  }

  // ---------------------------------------------------------------------------
  // 后台任务登记（去重，任意时刻同一任务至多一个在跑）
  // ---------------------------------------------------------------------------

  _job(name) {
    return this._jobs.get(name) || null;
  }

  _jobRecentError(name, windowMs = 60000) {
    const job = this._jobs.get(name);
    return !!(job && !job.running && job.error && Date.now() - job.errorAt < windowMs);
  }

  _ensureJob(name, factory) {
    const existing = this._jobs.get(name);
    if (existing && existing.running) return existing;
    const job = {
      name,
      running: true,
      startedAt: Date.now(),
      finishedAt: 0,
      error: null,
      errorAt: 0,
      promise: null,
    };
    job.promise = Promise.resolve()
      .then(factory)
      .then(
        (value) => {
          job.running = false;
          job.finishedAt = Date.now();
          job.error = null;
          job.value = value;
          return value;
        },
        (error) => {
          job.running = false;
          job.finishedAt = Date.now();
          job.error = errorMessage(error);
          job.errorAt = job.finishedAt;
          console.warn("[obsidian-assistant] " + name + " 任务失败：" + job.error);
          return null;
        }
      );
    this._jobs.set(name, job);
    return job;
  }

  // ---------------------------------------------------------------------------
  // 那年今天
  // ---------------------------------------------------------------------------

  /** 那年今天：优先返回缓存；冷启动先返回 warming，后台扫描完成后由面板轮询取。 */
  async today() {
    const { mm, dd, dayKey } = this._todayStr();
    if (!this.cfg.vault) {
      return { month: mm, day: dd, entries: [], error: "未配置 vault 路径，无法扫描笔记。" };
    }
    const self = this._self;
    await this.cacheStore.load();
    const hit = this.cacheStore.getToday();
    if (hit && hit.dateKey === dayKey && (await this._cacheTrustworthy(hit))) {
      const payload = {
        month: mm,
        day: dd,
        entries: this._materializeEntries(hit),
        cached: true,
        wroteAt: hit.at,
      };
      // 缓存里只有截断摘要（生成时模型没就绪）时，后台补一次摘要。
      if (!hit.summarized && this._llmReady() && !this._jobRecentError("today-summary")) {
        this._ensureJob("today-summary", () => self._summarizeTodayCache(dayKey));
        payload.refreshing = true;
        payload.retryInMs = 1500;
      }
      return payload;
    }
    if (hit && hit.dateKey === dayKey) {
      // 旧缓存先给，后台再刷新（stale-while-revalidate）。
      if (!this._jobRecentError("today")) {
        this._ensureJob("today", () => self._refreshToday(dayKey));
      }
      return {
        month: mm,
        day: dd,
        entries: this._materializeEntries(hit),
        cached: true,
        stale: true,
        refreshing: !this._jobRecentError("today"),
        retryInMs: 1200,
        wroteAt: hit.at,
      };
    }
    if (this._jobRecentError("today")) {
      return { month: mm, day: dd, entries: [], error: this._job("today").error, retryInMs: 0 };
    }
    const running = this._job("today");
    if (!running || !running.running) {
      this._ensureJob("today", () => self._refreshToday(dayKey));
    }
    return { month: mm, day: dd, entries: [], warming: true, retryInMs: 1200 };
  }

  _materializeEntries(hit) {
    const entries = Array.isArray(hit.entries) ? hit.entries : [];
    return entries.map((entry) => ({
      path: String(entry.path || ""),
      year: Number(entry.year) || 0,
      title: String(entry.title || ""),
      snippet: String(entry.snippet || ""),
      summary: typeof entry.summary === "string" && entry.summary ? entry.summary : fallbackSummary(entry),
    }));
  }

  /** 后台任务：扫描 + 摘要 + 写缓存。 */
  async _refreshToday(dayKey) {
    // 用触发任务的 dayKey 解析日期，避免跨零点时任务目标漂移。
    const [y, mm, dd] = String(dayKey).split("-").map(Number);
    const sig = await this._vaultSig(true);
    const scanned = await this._scanToday(mm, dd, y);
    const entries = (Array.isArray(scanned) ? scanned : []).slice(0, LIMITS.today.maxEntries).map((entry) => ({
      path: String(entry.path || ""),
      year: Number(entry.year) || 0,
      title: String(entry.title || ""),
      snippet: String(entry.snippet || ""),
      summary: fallbackSummary(entry),
    }));
    let summarized = entries.length === 0;
    if (entries.some((entry) => entry.snippet.length > 60) && this._llmReady()) {
      const withSummaries = await this._summarizeEntries(entries);
      if (withSummaries) {
        entries.splice(0, entries.length, ...withSummaries);
        summarized = true;
      }
    }
    const cacheEntry = { dateKey: dayKey, sig, at: Date.now(), entries, summarized };
    await this.cacheStore.setToday(cacheEntry);
    return cacheEntry;
  }

  async _scanToday(mm, dd, year) {
    const result = await runScan({
      shell: this.ctx.shell,
      python: this.cfg.python,
      vault: this.cfg.vault,
      cfg: {
        mode: "today",
        vault: this.cfg.vault,
        mm,
        dd,
        year,
        skip_wiki_subdirs: this.cfg.skipWikiSubdirs,
        max_entries: LIMITS.today.maxEntries,
        max_read_chars: LIMITS.scan.maxReadChars,
      },
    });
    return Array.isArray(result) ? result : [];
  }

  /** 用当前默认模型给长笔记生成 60 字内摘要；失败返回 null（调用方保留截断摘要）。 */
  async _summarizeEntries(entries) {
    const longOnes = entries
      .map((entry, i) => ({ i, title: entry.title, text: entry.snippet }))
      .filter((item) => item.text.length > 60)
      .slice(0, 25);
    if (longOnes.length === 0) return entries;
    try {
      const out = await this._llmComplete(
        "你是笔记摘要助手。对每条笔记提炼一个不超过60个汉字的摘要，保留核心事实或观点，输出严格的 JSON 数组，形如 [{\"i\":0,\"summary\":\"...\"}]，不要输出其他内容。",
        JSON.stringify(longOnes),
        2000
      );
      if (!out) return null;
      const start = out.indexOf("[");
      const end = out.lastIndexOf("]");
      if (start < 0 || end < start) return null;
      const arr = JSON.parse(out.slice(start, end + 1));
      if (!Array.isArray(arr)) return null;
      const next = entries.map((entry) => Object.assign({}, entry));
      for (const item of arr) {
        if (item && Number.isInteger(item.i) && typeof item.summary === "string" && longOnes.some((x) => x.i === item.i)) {
          next[item.i].summary = item.summary.slice(0, 80);
        }
      }
      return next;
    } catch {
      return null;
    }
  }

  /** 后台任务：给已有缓存补摘要（预计算时模型没就绪的补救）。 */
  async _summarizeTodayCache(dayKey) {
    const hit = this.cacheStore.getToday();
    if (!hit || hit.dateKey !== dayKey || hit.summarized) return hit;
    const withSummaries = await this._summarizeEntries(this._materializeEntries(hit));
    if (!withSummaries) throw new Error("模型摘要暂时不可用");
    const next = Object.assign({}, hit, { entries: withSummaries, summarized: true });
    await this.cacheStore.setToday(next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // 随机漫步
  // ---------------------------------------------------------------------------

  /** 随机漫步：exclude 为空时用当天预生成的信；非空（再来一封）同步生成。 */
  async walk(args) {
    const exclude = sanitizeExclude(args && args.exclude);
    if (!this.cfg.vault) return { error: "未配置 vault 路径，无法随机漫步。" };
    const self = this._self;
    const { dayKey } = this._todayStr();
    await this.cacheStore.load();
    if (exclude.length === 0) {
      const hit = this.cacheStore.getWalk();
      if (hit && hit.dateKey === dayKey && (await this._cacheTrustworthy(hit))) {
        return { path: hit.path, title: hit.title, letter: hit.letter, cached: true, wroteAt: hit.at };
      }
      if (hit && hit.dateKey === dayKey) {
        if (!this._jobRecentError("walk")) {
          this._ensureJob("walk", () => self._refreshWalk(dayKey, []));
        }
        return {
          path: hit.path,
          title: hit.title,
          letter: hit.letter,
          cached: true,
          stale: true,
          refreshing: !this._jobRecentError("walk"),
          retryInMs: 1200,
          wroteAt: hit.at,
        };
      }
      if (this._jobRecentError("walk")) {
        return { error: this._job("walk").error, retryInMs: 0 };
      }
      const running = this._job("walk");
      if (!running || !running.running) {
        this._ensureJob("walk", () => self._refreshWalk(dayKey, []));
      }
      return { warming: true, retryInMs: 1200 };
    }
    // 「再来一封」：用户明确要一封新的，同步生成。
    try {
      const pick = await this._pickNote(exclude);
      if (!pick) return { error: "没有找到合适的笔记，请先多写几篇有内容的长笔记吧。" };
      const letter = await this._writeLetter(pick);
      if (!letter) return { path: pick.path, title: pick.title, letter: "", error: "模型服务暂时不可用，没能生成这封信。稍后重试即可。" };
      return { path: pick.path, title: pick.title, letter };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** 后台任务：挑一篇 + 写一封信 + 写缓存。 */
  async _refreshWalk(dayKey, exclude) {
    const sig = await this._vaultSig(true);
    const pick = await this._pickNote(exclude);
    if (!pick) throw new Error("没有找到合适的笔记，请先多写几篇有内容的长笔记吧。");
    const letter = await this._writeLetter(pick);
    if (!letter) throw new Error("模型服务暂时不可用，没能生成这封信。稍后重试即可。");
    if (exclude.length === 0) {
      await this.cacheStore.setWalk({
        dateKey: dayKey,
        sig,
        at: Date.now(),
        path: pick.path,
        title: pick.title,
        letter,
      });
    }
    return { path: pick.path, title: pick.title, letter };
  }

  async _pickNote(exclude) {
    const result = await runScan({
      shell: this.ctx.shell,
      python: this.cfg.python,
      vault: this.cfg.vault,
      cfg: {
        mode: "pick",
        vault: this.cfg.vault,
        exclude,
        walk_dirs: this._walkDirsSlashes(),
        max_read_chars: LIMITS.scan.maxReadChars,
      },
    });
    return result && typeof result === "object" ? result : null;
  }

  async _writeLetter(pick) {
    try {
      return await this._llmComplete(
        "你是一位知识伙伴。用户会给你一篇他从前的笔记。请以「过去笔记寄来的信」的形式写一段 150~250 字的解读：提炼其中最有价值的认知或洞察，用温暖、真诚、略带陪伴感的口吻说给今天的他听，像朋友来信而不是报告。可以引用笔记里的关键短语（用「」标注）。第一行以「亲爱的：」开头。不要使用 markdown 标题。",
        "笔记标题：" + pick.title + "\n笔记路径：" + pick.path + "\n笔记内容：\n" + pick.text,
        900
      );
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 快速笔记
  // ---------------------------------------------------------------------------

  /** 快速笔记：追加到 <journalsDir>/当日.md。 */
  async quicknote(args) {
    const text = args && typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return { error: "内容为空" };
    if (text.length > LIMITS.write.maxTextChars) {
      return { error: "内容过长（上限 " + LIMITS.write.maxTextChars + " 字）" };
    }
    if (text.includes("\0")) return { error: "内容包含非法字符" };
    if (!this.cfg.vault) return { error: "未配置 vault 路径，无法保存快速笔记。" };
    const { file } = this._todayStr();
    const stamp = new Date().toTimeString().slice(0, 5);
    const add = "- " + text + "  `" + stamp + "`\n";
    let target;
    try {
      // 逐段校验并创建日记目录：任何一段是符号链接都拒绝，避免在 vault 外留下空目录。
      await this.policy.ensureDir(this.cfg.journalsDir);
      target = await this.policy.writeTarget(file);
      await this.policy.assertContained(target.abs);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    // O_NOFOLLOW：日记文件若是符号链接，直接 ELOOP 拒绝，绝不跟随到 vault 外。
    // 新文件用 O_CREAT|O_EXCL 防并发覆盖；已有文件用 O_APPEND 防覆盖 Obsidian 的并发编辑。
    const noFollow = constants.O_NOFOLLOW;
    let handle = null;
    try {
      try {
        handle = await open(target.abs, constants.O_WRONLY | constants.O_APPEND | noFollow);
        await handle.writeFile("\n" + add, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") {
          try {
            handle = await open(target.abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow);
            await handle.writeFile("# " + file + "\n\n" + add, "utf8");
          } catch (error2) {
            if (error2 && error2.code === "EEXIST") {
              // 与并发写入撞车：退化为追加。
              handle = await open(target.abs, constants.O_WRONLY | constants.O_APPEND | noFollow);
              await handle.writeFile("\n" + add, "utf8");
            } else {
              throw error2;
            }
          }
        } else if (error && error.code === "ELOOP") {
          throw new PolicyError("path-invalid", "目标日记文件是符号链接，出于安全考虑拒绝写入");
        } else {
          throw error;
        }
      }
    } catch (error) {
      return { error: "保存失败：" + errorMessage(error) };
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* 关闭失败不影响已写入内容 */
        }
      }
    }
    try {
      await appendFile(this.logFile, JSON.stringify({ date: file, time: stamp, text }) + "\n", "utf8");
    } catch {
      /* 日志失败不影响保存 */
    }
    this._maybeTrimLog().catch(() => {});
    return { path: target.rel };
  }

  /** 日志过大时裁剪到最近若干行（best-effort，失败忽略）。 */
  async _maybeTrimLog() {
    let raw;
    try {
      raw = await readFile(this.logFile, "utf8");
    } catch {
      return;
    }
    if (Buffer.byteLength(raw, "utf8") < LIMITS.write.logTrimAfterBytes) return;
    const lines = raw.split("\n").filter((line) => line.trim());
    if (lines.length <= LIMITS.write.logTrimAfterLines) return;
    const keep = lines.slice(-LIMITS.write.logKeepLines).join("\n") + "\n";
    const tmp = this.logFile + ".tmp";
    await writeFile(tmp, keep, "utf8");
    await rename(tmp, this.logFile);
  }

  /** 最近添加的快速笔记（最多 3 条，新的在前）。 */
  async recent() {
    const raw = await this._readLogTail();
    const entries = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o.text === "string" && typeof o.date === "string") {
          entries.push({
            date: o.date,
            time: typeof o.time === "string" ? o.time : "",
            text: o.text.slice(0, LIMITS.write.maxTextChars),
          });
        }
      } catch {
        /* 跳过坏行 */
      }
    }
    return { entries: entries.slice(-3).reverse() };
  }

  /** 只读日志尾部，避免日志变长后每次读全文件。 */
  async _readLogTail() {
    const maxBytes = LIMITS.write.logTrimAfterBytes;
    try {
      const st = await stat(this.logFile);
      if (st.size <= maxBytes) return await readFile(this.logFile, "utf8");
      const handle = await open(this.logFile, "r");
      try {
        const length = Math.min(maxBytes, st.size);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, st.size - length);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const firstBreak = text.indexOf("\n");
        return firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
      } finally {
        await handle.close();
      }
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // 相关笔记（可选语义检索）
  // ---------------------------------------------------------------------------

  /** 相关笔记：便宜前置闸（长度/缓存/去重）→ 语义脚本 → 缓存结果。 */
  async related(args) {
    let text = args && typeof args.text === "string" ? args.text.trim() : "";
    if (text.length < LIMITS.related.minQueryChars) return { results: [] };
    if (text.length > LIMITS.related.maxQueryChars) text = text.slice(0, LIMITS.related.maxQueryChars);
    if (!this.cfg.semanticScript) {
      return {
        error:
          "「找相关笔记」未启用：需要在插件 config.semanticScript（或环境变量 DSH_OBSIDIAN_SEMANTIC）配置一个向量语义检索脚本。详见 README。",
      };
    }
    if (!this.cfg.vault) return { error: "未配置 vault 路径，无法检索相关笔记。" };
    const key = sha1(text);
    await this.cacheStore.load();
    const hit = this.cacheStore.getRelated(key);
    if (hit) return { results: hit.results, cached: true };
    const inflight = this._relatedInflight.get(key);
    if (inflight) return inflight;
    const self = this._self;
    const promise = self._runRelated(text, key).finally(() => self._relatedInflight.delete(key));
    this._relatedInflight.set(key, promise);
    return promise;
  }

  async _runRelated(text, key) {
    try {
      try {
        const st = await stat(this.cfg.semanticScript);
        if (!st.isFile()) throw new Error("不是文件");
      } catch {
        return {
          error:
            "语义检索脚本不存在：" +
            this.cfg.semanticScript +
            "。请把 config.semanticScript 改成当前实际路径，或清空该配置。",
        };
      }
      const arr = await runSemanticSearch({
        shell: this.ctx.shell,
        python: this.cfg.semanticPython,
        script: this.cfg.semanticScript,
        text,
        vault: this.cfg.vault,
      });
      const results = (Array.isArray(arr) ? arr : []).slice(0, LIMITS.related.maxResults).map((x) => ({
        path: String(x && x.path ? x.path : ""),
        title: String(x && x.title ? x.title : ""),
        score: x && typeof x.score === "number" ? x.score : null,
        snippet: String((x && x.text) || "").replace(/\s+/g, " ").slice(0, 160),
      }));
      await this.cacheStore.setRelated(key, results);
      return { results };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // 读原文
  // ---------------------------------------------------------------------------

  /** 读原文：仅 vault 内 .md，realpath 防逃逸，去 frontmatter，限长返回。 */
  async read(args) {
    const rel = args && typeof args.path === "string" ? args.path : "";
    if (!rel) return { error: "非法路径" };
    if (!this.cfg.vault) return { error: "未配置 vault 路径。" };
    let target;
    try {
      target = await this.policy.resolveRead(rel);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    let text;
    try {
      text = await readFile(target.abs, "utf8");
    } catch {
      return { error: "读取失败" };
    }
    text = stripFrontmatter(text).slice(0, LIMITS.read.maxChars);
    return { path: target.rel, text };
  }

  // ---------------------------------------------------------------------------
  // 启动自检
  // ---------------------------------------------------------------------------

  /** 只读自检：健康时面板不显示任何东西；有问题时给一条可行动提示。 */
  async health() {
    const now = Date.now();
    if (this._healthCache) {
      const ttl = this._healthCache.result.ok ? 60000 : 15000;
      if (now - this._healthCache.at < ttl) return this._healthCache.result;
    }
    let result;
    try {
      result = await this.healthChecker.check();
    } catch (error) {
      result = {
        ok: false,
        checkedAt: Date.now(),
        problems: [
          {
            id: "health",
            severity: "error",
            title: "自检本身失败",
            detail: errorMessage(error),
            fix: "把这条错误信息发给插件作者；其余功能可能仍可用。",
          },
        ],
        info: [],
        checks: [],
      };
    }
    this._healthCache = { at: now, result };
    return result;
  }

  // ---------------------------------------------------------------------------
  // 预计算
  // ---------------------------------------------------------------------------

  /** 启动后预计算：今日结果 + 一封信。缓存仍新鲜时跳过扫描。
   *  是否调度本函数由构造函数的 warmup 决定，这里不再重复判断。 */
  async _warm() {
    if (!this.cfg.vault) return;
    const self = this._self;
    await self.cacheStore.load();
    const { dayKey } = self._todayStr();

    const todayHit = self.cacheStore.getToday();
    const todayFresh = todayHit && todayHit.dateKey === dayKey && (await self._cacheTrustworthy(todayHit));
    if (!todayFresh) {
      const todayJob = self._ensureJob("today", () => self._refreshToday(dayKey));
      await todayJob.promise;
    }
    const hit = self.cacheStore.getToday();
    if (hit && hit.dateKey === dayKey && !hit.summarized && self._llmReady()) {
      const retry = setTimeout(() => {
        self._ensureJob("today-summary", () => self._summarizeTodayCache(dayKey));
      }, 5000);
      retry.unref?.();
    }

    const walkHit = self.cacheStore.getWalk();
    const walkFresh = walkHit && walkHit.dateKey === dayKey && (await self._cacheTrustworthy(walkHit));
    if (!walkFresh) {
      const walkJob = self._ensureJob("walk", () => self._refreshWalk(dayKey, []));
      await walkJob.promise;
    }
  }
}

for (const m of ["today", "walk", "quicknote", "recent", "related", "read", "health"]) {
  markRemote(ObsbnService.prototype, m);
}

export { ObsbnService as default };
