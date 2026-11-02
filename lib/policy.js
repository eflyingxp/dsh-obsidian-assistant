// dsh-obsidian-assistant — 能力边界（Policy）。
//
// 这里是 obsbn 对外的「法令」：所有远程方法的可读范围、可写范围、查询上限都
// 在这一个文件里定义并由各方法强制执行。原则来自 Super-agent 原型
// docs/002-authorization：消息、评论、引用的文档只是决策的输入，不能改变权限。
// 换句话说，笔记正文再怎么写，也扩大不了这里的边界。
//
// 调用者分型：
//   - 面板 UI：当前唯一调用者，可信，但仍走同一套校验。
//   - DSH Agent（未来）：参数不可信，必须依赖本文件的限制。
//   - 第三方：不支持，也不承诺兼容。
import { stat, lstat, mkdir, realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute, sep } from "node:path";

/** 所有硬上限。改这里等于改能力边界，必须同步 POLICY.md 与 CHANGELOG。 */
export const LIMITS = Object.freeze({
  read: Object.freeze({
    /** 单篇笔记最大字节数，超过直接拒绝，避免读进超大文件。 */
    maxFileBytes: 512 * 1024,
    /** 返回给调用者的最大字符数。 */
    maxChars: 6000,
    /** 只允许读 Markdown。 */
    extension: ".md",
    /** 路径字符串长度上限。 */
    maxPathChars: 500,
  }),
  write: Object.freeze({
    /** 单条快速笔记最大字符数。 */
    maxTextChars: 4000,
    /** 快速笔记日志超过该行数时裁剪。 */
    logTrimAfterLines: 500,
    /** 裁剪后保留最近多少行。 */
    logKeepLines: 200,
    /** 日志文件超过该字节数才考虑裁剪。 */
    logTrimAfterBytes: 256 * 1024,
  }),
  related: Object.freeze({
    /** 小于该长度不触发语义检索（便宜的前置闸）。 */
    minQueryChars: 4,
    /** 查询文本上限，超出只取前 N 字。 */
    maxQueryChars: 1000,
    /** 结果条数上限（写死，调用者不能改）。 */
    maxResults: 3,
    /** 相同查询的缓存时间。 */
    cacheTtlMs: 30 * 60 * 1000,
    /** 缓存最多保留多少条查询。 */
    cacheMaxEntries: 50,
  }),
  walk: Object.freeze({
    /** 「再来一封」排除列表上限（只作数据用，不拼命令）。 */
    maxExclude: 50,
  }),
  today: Object.freeze({
    /** 今日结果条数上限。 */
    maxEntries: 40,
  }),
  scan: Object.freeze({
    /** python 扫描子进程超时。 */
    timeoutMs: 120 * 1000,
    /** python 扫描 stdout 上限。 */
    stdoutMaxBytes: 20 * 1024 * 1024,
    /** 单篇笔记参与扫描时最多读取的字符数（够 frontmatter + 首段 + 摘要）。 */
    maxReadChars: 200 * 1000,
  }),
  script: Object.freeze({
    /** 语义检索子进程超时。 */
    timeoutMs: 120 * 1000,
    /** 语义检索 stdout 上限。 */
    stdoutMaxBytes: 2 * 1024 * 1024,
    /** 错误信息里保留的 stderr 字符数。 */
    stderrTailChars: 300,
  }),
  cache: Object.freeze({
    /** 缓存写入后在该时间内直接信任，不再算 vault 指纹。 */
    trustMs: 10 * 60 * 1000,
    /** vault 指纹内存缓存时间。 */
    sigTtlMs: 60 * 1000,
    /** 缓存文件大小上限，超过视为损坏。 */
    maxFileBytes: 2 * 1024 * 1024,
  }),
});

/** POSIX shell 单引号转义：把任意字符串安全地变成一个 argv 参数。 */
export function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function errorMessageOf(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

/** 边界拒绝错误：带稳定 code，方便调用方区分「越界」与「内部错误」。 */
export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

/** 规范化 vault 内的相对目录（用于 journalsDir）。非法时返回 fallback。
 *  注意：必须先判断绝对路径/盘符，再去掉首尾斜杠；否则 "/tmp/x" 会被
 *  悄悄变成 "tmp/x" 混进 vault 内，边界就不成立了。 */
export function normalizeRelDir(dir, fallback) {
  const original = typeof dir === "string" ? dir.trim() : "";
  if (!original) return { dir: fallback, ok: false, reason: "路径为空" };
  if (isAbsolute(original) || /^[A-Za-z]:/.test(original)) {
    return { dir: fallback, ok: false, reason: "不能是绝对路径" };
  }
  const raw = original.replace(/^\/+|\/+$/g, "");
  if (!raw) return { dir: fallback, ok: false, reason: "路径为空" };
  if (!isSafeRelPath(raw)) return { dir: fallback, ok: false, reason: "不是 vault 内的合法相对目录" };
  return { dir: raw, ok: true, reason: "" };
}

/** 判断一个字符串是否是安全的 vault 内相对路径。
 *
 * 规则：非空、不超长、不含 NUL 与反斜杠、不是绝对路径、不是盘符路径、
 * 分段中不能有 ".." 或 "." 或空段（连续斜杠）。只做字符串层面的判断，
 * 真实的符号链接逃逸由 VaultPolicy 的 realpath 校验兜底。
 */
export function isSafeRelPath(rel, maxChars = LIMITS.read.maxPathChars) {
  if (typeof rel !== "string") return false;
  if (!rel || rel.length > maxChars) return false;
  if (rel.includes("\0") || rel.includes("\\")) return false;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  const segments = rel.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return false;
  }
  return true;
}

/** 去掉 Markdown frontmatter 后的正文（0.1.2 的 split 写法永远剥不掉，这里是修复版）。 */
export function stripFrontmatter(text) {
  if (typeof text !== "string") return "";
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * 绑定一个 vault 的策略实例：负责把「相对路径」变成「确认在 vault 内的绝对路径」。
 */
export class VaultPolicy {
  constructor(vault, journalsDir, fallbackJournalsDir = "raw/journals") {
    this.vault = typeof vault === "string" ? vault.trim() : "";
    const normalized = normalizeRelDir(journalsDir, fallbackJournalsDir);
    this.journalsDir = normalized.dir;
    this.journalsDirWarning = normalized.ok ? "" : normalized.reason;
    /** realpath(vault) 的内存缓存；vault 被移动后重启即恢复。 */
    this.realVault = null;
  }

  get configured() {
    return !!this.vault;
  }

  /** 取 vault 的真实路径；不存在或不是目录时抛 PolicyError。 */
  async vaultRealpath() {
    if (this.realVault) return this.realVault;
    if (!this.vault) throw new PolicyError("vault-missing", "未配置 vault 路径");
    let st;
    try {
      st = await stat(this.vault);
    } catch {
      throw new PolicyError("vault-missing", "vault 路径不存在：" + this.vault);
    }
    if (!st.isDirectory()) throw new PolicyError("vault-missing", "vault 路径不是目录：" + this.vault);
    try {
      this.realVault = await realpath(this.vault);
    } catch {
      this.realVault = this.vault;
    }
    return this.realVault;
  }

  /** 校验 target 的真实路径仍在 vault 之内（防符号链接逃逸）。 */
  async assertContained(absPath) {
    const realVault = await this.vaultRealpath();
    let real;
    try {
      real = await realpath(absPath);
    } catch {
      // 目标还不存在（例如刚 mkdir 的父目录下新文件）：退而校验父目录。
      real = await realpath(join(absPath, "..")).catch(() => "");
    }
    if (!real) throw new PolicyError("path-escape", "无法解析目标路径");
    if (real !== realVault && !real.startsWith(realVault + sep)) {
      throw new PolicyError("path-escape", "目标路径超出 vault 范围");
    }
    return real;
  }

  /** read() 用：校验并返回 vault 内 Markdown 的绝对路径。 */
  async resolveRead(rel) {
    if (!isSafeRelPath(rel)) throw new PolicyError("path-invalid", "非法路径");
    if (!rel.toLowerCase().endsWith(LIMITS.read.extension)) {
      throw new PolicyError("path-invalid", "只允许读取 .md 文件");
    }
    await this.vaultRealpath();
    const abs = join(this.vault, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new PolicyError("path-missing", "文件不存在");
    }
    if (!st.isFile()) throw new PolicyError("path-invalid", "目标不是文件");
    if (st.size > LIMITS.read.maxFileBytes) {
      throw new PolicyError("too-large", "文件超过 " + Math.round(LIMITS.read.maxFileBytes / 1024) + "KB 上限");
    }
    await this.assertContained(abs);
    return { abs, rel };
  }

  /**
   * 逐段创建并校验 journalsDir：任何一段是符号链接或同名文件都直接拒绝，
   * 避免「先 mkdir 后校验」在 vault 外留下空目录（TOCTOU 与链接逃逸）。
   * @param {string} relDir 已通过 normalizeRelDir 的 vault 内相对目录
   * @returns {Promise<string>} 确认在 vault 内的真实目录绝对路径
   */
  async ensureDir(relDir) {
    if (!isSafeRelPath(relDir)) throw new PolicyError("path-invalid", "日记目录非法");
    const realVault = await this.vaultRealpath();
    let current = realVault;
    for (const segment of relDir.split("/")) {
      current = join(current, segment);
      let entryStat;
      try {
        entryStat = await lstat(current);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          await mkdir(current);
          continue;
        }
        throw new PolicyError("path-invalid", "无法创建日记目录：" + errorMessageOf(error));
      }
      if (entryStat.isSymbolicLink()) {
        throw new PolicyError("path-escape", "日记目录路径中包含符号链接，拒绝写入");
      }
      if (!entryStat.isDirectory()) {
        throw new PolicyError("path-invalid", "日记目录路径中存在同名文件，无法创建目录");
      }
    }
    await this.assertContained(current);
    return current;
  }

  /** quicknote 用：返回当日日记的绝对路径与相对路径；只允许 journalsDir 下的日期文件名。
   *  dateFileName 接受 "YYYY-MM-DD" 或 "YYYY-MM-DD.md"，其余一律拒绝。 */
  async writeTarget(dateFileName) {
    const raw = String(dateFileName || "");
    const fileName = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + ".md" : raw;
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(fileName)) {
      throw new PolicyError("path-invalid", "日记文件名非法");
    }
    await this.vaultRealpath();
    const relDir = this.journalsDir;
    const rel = relDir + "/" + fileName;
    const abs = join(this.vault, relDir, fileName);
    try {
      await this.assertContained(abs);
    } catch (error) {
      if (error && error.code === "path-escape") throw error;
      // 文件尚不存在时 realpath 失败：确保父目录仍在 vault 内。
      const parent = join(this.vault, relDir);
      await this.assertContained(parent);
    }
    return { abs, rel };
  }

  /** 供健康检查用：判断目录是否可写（不创建、不写盘）。 */
  async canWriteDir(absDir) {
    try {
      await access(absDir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** 对 walk(exclude) 的参数做清洗：只保留合法的相对路径，截断到上限。 */
export function sanitizeExclude(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!isSafeRelPath(item)) continue;
    out.push(item);
    if (out.length >= LIMITS.walk.maxExclude) break;
  }
  return out;
}
