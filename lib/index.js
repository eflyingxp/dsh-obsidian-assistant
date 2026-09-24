// dsh-obsidian-assistant — Host half.
// 提供 'obsbn' Remote 服务：那年今天 / 随机漫步 / 快速笔记 / 相关笔记 / 读原文。
//
// 本机路径全部可配置（cordis.patch.yml 插件行 config，或同名环境变量）：
//   vault          DSH_OBSIDIAN_VAULT     Obsidian vault 绝对路径（必填）
//   journalsDir    DSH_OBSIDIAN_JOURNALS  日记目录（vault 内相对路径，默认 raw/journals）
//   walkDirs                              随机漫步候选目录前缀（默认取 journalsDir）
//   skipWikiSubdirs                       「那年今天」要跳过的 wiki 子目录名（默认 lint）
//   semanticScript DSH_OBSIDIAN_SEMANTIC  语义检索脚本路径（可选；为空则「找相关笔记」禁用）
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 快速笔记日志（不进 vault）：每行一条 {date,time,text}，支撑「最近记录」。
const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "quicknotes.jsonl");

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

// 不依赖 TS 装饰器：手工在原型上标记 Remote 方法（与 typert-protocol 的
// mark() 产出完全相同的 v1 descriptor，走 Gateway 的 conservative SRC 路径）。
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

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function pyConfig(cfg) {
  const head = 'import json, os, re, random, sys\nCFG = ' + JSON.stringify(cfg) + "\n";
  const body = [
    'vault = CFG["vault"]',
    'skip_dirs = {".obsidian", ".git", ".semantic-index", ".trash", "node_modules"}',
    'skip_prefixes = tuple("wiki/" + d + "/" for d in CFG.get("skip_wiki_subdirs", ["lint"]))',
    'date_re = re.compile(r"(\\d{4})[-_](\\d{1,2})[-_](\\d{1,2})")',
    'fm_date_re = re.compile(r"^date:\\s*(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})", re.M)',
    "",
    "def strip_fm(t):",
    '    if t.startswith("---"):',
    '        parts = t.split("---", 2)',
    "        if len(parts) >= 3: return parts[2]",
    "    return t",
    "",
    "def first_text(t):",
    "    t = strip_fm(t)",
    "    lines = []",
    "    for ln in t.splitlines():",
    "        s = ln.strip()",
    '        if not s or s.startswith(("#", "|", "---", "!", ">", "[!")):',
    "            if lines: break",
    "            continue",
    "        lines.append(s)",
    '    return " ".join(lines).strip()',
    "",
    "def walk_files():",
    "    out = []",
    "    for root, dirs, files in os.walk(vault):",
    "        rel = os.path.relpath(root, vault)",
    "        dirs[:] = [d for d in dirs if d not in skip_dirs]",
    "        for f in files:",
    '            if not f.endswith(".md"): continue',
    '            rp = os.path.normpath(os.path.join(rel, f)) if rel != "." else f',
    '            rp = rp.replace(os.sep, "/")',
    "            if rp.startswith(skip_prefixes): continue",
    "            out.append(rp)",
    "    return out",
    "",
    "def read_note(rp):",
    "    p = os.path.join(vault, rp)",
    "    try:",
    '        with open(p, encoding="utf-8", errors="replace") as fh: return fh.read()',
    "    except Exception: return ''",
    "",
    "def guess_title(rp, t):",
    '    m = re.search(r"^#\\s+(.+)", strip_fm(t) or "", re.M)',
    "    if m: return m.group(1).strip()[:80]",
    "    return os.path.splitext(os.path.basename(rp))[0][:80]",
    "",
    "def note_dates(rp, t):",
    "    found = set()",
    "    m = date_re.search(os.path.basename(rp))",
    "    if m: found.add((int(m.group(1)), int(m.group(2)), int(m.group(3))))",
    "    for m in fm_date_re.finditer(t[:800]):",
    "        found.add((int(m.group(1)), int(m.group(2)), int(m.group(3))))",
    "    return found",
    "",
  ].join("\n");

  let tail = "";
  if (cfg.mode === "today") {
    tail = [
      'mm, dd = CFG["mm"], CFG["dd"]',
      'today_skip = tuple("wiki/" + d + "/" for d in CFG.get("skip_wiki_subdirs", ["lint"]))',
      "res = []",
      "for rp in walk_files():",
      "    if rp.startswith(today_skip): continue",
      "    t = read_note(rp)",
      "    if not t: continue",
      "    hit = None",
      "    for (y, m, d) in note_dates(rp, t):",
      '        if m == mm and d == dd and y < CFG["year"]: hit = (y, m, d); break',
      "    if not hit: continue",
      "    body = first_text(t)",
      "    if len(body) < 10: continue",
      '    res.append({"path": rp, "year": hit[0], "title": guess_title(rp, t), "snippet": body[:500]})',
      'res.sort(key=lambda e: -e["year"])',
      "print(json.dumps(res[:40], ensure_ascii=False))",
    ].join("\n");
  } else if (cfg.mode === "pick") {
    tail = [
      'exclude = set(CFG.get("exclude", []))',
      'walk_prefixes = tuple(CFG.get("walk_dirs", ["raw/journals/"]))',
      "pool = []",
      "for rp in walk_files():",
      "    if rp in exclude: continue",
      "    if rp.startswith(walk_prefixes): pool.append(rp)",
      "random.shuffle(pool)",
      "for rp in pool[:400]:",
      "    t = read_note(rp)",
      "    body = strip_fm(t).strip()",
      "    n = len(body)",
      "    if n < 300 or n > 20000: continue",
      '    if body.count("\\n") < 2: continue',
      '    print(json.dumps({"path": rp, "title": guess_title(rp, t), "text": body[:9000]}, ensure_ascii=False))',
      "    break",
    ].join("\n");
  } else {
    tail = 'raise SystemExit("unknown mode")';
  }
  return head + "\n" + body + "\n" + tail + "\n";
}

class ObsbnService extends TypertRemoteService {
  static inject = ["shell"];

  constructor(ctx, config) {
    super(ctx, "obsbn");
    // 配置来源：cordis.patch.yml 插件行 config > 同名环境变量 > 默认值。
    const cfg = config || {};
    this.cfg = {
      vault: cfg.vault || process.env.DSH_OBSIDIAN_VAULT || "",
      journalsDir:
        cfg.journalsDir ||
        process.env.DSH_OBSIDIAN_JOURNALS ||
        "raw/journals",
      walkDirs: Array.isArray(cfg.walkDirs) && cfg.walkDirs.length > 0 ? cfg.walkDirs : null,
      skipWikiSubdirs:
        Array.isArray(cfg.skipWikiSubdirs) && cfg.skipWikiSubdirs.length > 0
          ? cfg.skipWikiSubdirs
          : ["lint"],
      semanticScript:
        cfg.semanticScript || process.env.DSH_OBSIDIAN_SEMANTIC || "",
    };
    if (!this.cfg.walkDirs) {
      this.cfg.walkDirs = [this.cfg.journalsDir.replace(/\/+$/, "") + "/"];
    }
    if (!this.cfg.vault) {
      console.warn(
        "[obsidian-assistant] 未配置 vault 路径。请在 cordis.patch.yml 的插件行 config.vault 填写你的 Obsidian vault 绝对路径，或设置环境变量 DSH_OBSIDIAN_VAULT。"
      );
    }
  }

  _walkDirsSlashes() {
    return this.cfg.walkDirs.map((d) => (d.endsWith("/") ? d : d + "/"));
  }

  // 注意：不要用 #私有方法。Gateway 经 cordis 追踪代理（Proxy）调用 Remote
  // 方法，this 是代理而非原始实例，# 私有成员的品牌检查会抛
  // "Receiver must be an instance of class ObsbnService"。
  // 兼容 DSH 0.1.7-rc.1 的 shell API 重构：旧版 shell.run(spec) 直接返回
  // 结果；新版是 shell.execute(spec) 返回进程句柄，前台结果在句柄的
  // result() 上。字段形状（exitCode/stdout.text/stderr.text）保持不变。
  async _sh(spec) {
    const shell = this.ctx.shell;
    if (typeof shell.run === "function") return shell.run(spec);
    const handle = await shell.execute(spec);
    return handle.result();
  }

  async _runPy(cfg) {
    if (!this.cfg.vault) throw new Error("未配置 vault 路径：请在插件的 cordis.patch.yml config.vault 填写 Obsidian vault 绝对路径（或环境变量 DSH_OBSIDIAN_VAULT），重启后生效。");
    const spec = this.ctx.shell.resolve({
      command: "python3 -",
      workdir: this.cfg.vault,
      timeoutMs: 120000,
      stdoutMaxBytes: 20 * 1024 * 1024,
      stdin: pyConfig(cfg),
    });
    const r = await this._sh(spec);
    if (r.exitCode !== 0) throw new Error("扫描失败: " + r.stderr.text.slice(0, 300));
    const txt = r.stdout.text.trim();
    if (!txt) return null;
    return JSON.parse(txt.split("\n").pop());
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

  _todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return {
      y: d.getFullYear(),
      mm: d.getMonth() + 1,
      dd: d.getDate(),
      file: d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()),
    };
  }

  /** 那年今天：全库扫描同月同日的历史笔记，60 字内摘要。 */
  async today() {
    const { y, mm, dd } = this._todayStr();
    const entries = (await this._runPy({ mode: "today", vault: this.cfg.vault, mm, dd, year: y, skip_wiki_subdirs: this.cfg.skipWikiSubdirs })) || [];
    const longOnes = entries.filter((e) => e.snippet.length > 60);
    if (longOnes.length > 0) {
      try {
        const payload = longOnes.slice(0, 25).map((e, i) => ({ i, title: e.title, text: e.snippet }));
        const out = await this._llmComplete(
          "你是笔记摘要助手。对每条笔记提炼一个不超过60个汉字的摘要，保留核心事实或观点，输出严格的 JSON 数组，形如 [{\"i\":0,\"summary\":\"...\"}]，不要输出其他内容。",
          JSON.stringify(payload),
          2000
        );
        if (out) {
          const arr = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1));
          for (const item of arr) {
            if (item && Number.isInteger(item.i) && typeof item.summary === "string" && longOnes[item.i]) {
              longOnes[item.i].summary = item.summary.slice(0, 80);
            }
          }
        }
      } catch {
        /* LLM 失败则回退为截断 */
      }
    }
    for (const e of entries) {
      if (e.summary === undefined) {
        e.summary = e.snippet.length <= 60 ? e.snippet : e.snippet.slice(0, 57) + "…";
      }
    }
    return { month: mm, day: dd, entries };
  }

  /** 随机漫步：随机挑一篇有内容的长笔记，写一封「过去寄来的信」。 */
  async walk(args) {
    const exclude = args && Array.isArray(args.exclude) ? args.exclude : [];
    const pick = await this._runPy({ mode: "pick", vault: this.cfg.vault, exclude, walk_dirs: this._walkDirsSlashes() });
    if (!pick) return { error: "没有找到合适的笔记，请先多写几篇有内容的长笔记吧。" };
    let letter = null;
    try {
      letter = await this._llmComplete(
        "你是一位知识伙伴。用户会给你一篇他从前的笔记。请以「过去笔记寄来的信」的形式写一段 150~250 字的解读：提炼其中最有价值的认知或洞察，用温暖、真诚、略带陪伴感的口吻说给今天的他听，像朋友来信而不是报告。可以引用笔记里的关键短语（用「」标注）。第一行以「亲爱的：」开头。不要使用 markdown 标题。",
        "笔记标题：" + pick.title + "\n笔记路径：" + pick.path + "\n笔记内容：\n" + pick.text,
        900
      );
    } catch {
      letter = null;
    }
    if (!letter) letter = "（这封信没能生成——模型服务暂时不可用。不过笔记还在，先直接看原文吧。）";
    return { path: pick.path, title: pick.title, letter };
  }

  /** 快速笔记：追加到 raw/journals/当日.md。 */
  async quicknote(args) {
    const text = args && typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return { error: "内容为空" };
    const { file } = this._todayStr();
    const rel = this.cfg.journalsDir.replace(/\/+$/, "") + "/" + file + ".md";
    const abs = join(this.cfg.vault, rel);
    let prev = "";
    try {
      prev = await readFile(abs, "utf8");
    } catch {
      prev = "";
    }
    const stamp = new Date().toTimeString().slice(0, 5);
    const add = "- " + text + "  `" + stamp + "`\n";
    const next = prev.trim() ? prev.replace(/\n*$/, "\n\n") + add : "# " + file + "\n\n" + add;
    await mkdir(join(this.cfg.vault, this.cfg.journalsDir), { recursive: true });
    await writeFile(abs, next, "utf8");
    try {
      await appendFile(LOG_FILE, JSON.stringify({ date: file, time: stamp, text }) + "\n", "utf8");
    } catch {
      /* 日志失败不影响保存 */
    }
    return { path: rel };
  }

  /** 最近添加的快速笔记（最多 3 条，新的在前）。 */
  async recent() {
    let raw = "";
    try {
      raw = await readFile(LOG_FILE, "utf8");
    } catch {
      return { entries: [] };
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o.text === "string" && typeof o.date === "string") {
          entries.push({ date: o.date, time: typeof o.time === "string" ? o.time : "", text: o.text });
        }
      } catch {
        /* 跳过坏行 */
      }
    }
    return { entries: entries.slice(-3).reverse() };
  }

  /** 相关笔记：走可选的语义检索脚本（如 llm-wiki-tana 的 semantic_search.py）。未配置则提示禁用。 */
  async related(args) {
    const text = args && typeof args.text === "string" ? args.text.trim() : "";
    if (text.length < 4) return { results: [] };
    if (!this.cfg.semanticScript) {
      return { error: "「找相关笔记」未启用：需要在插件 config.semanticScript（或环境变量 DSH_OBSIDIAN_SEMANTIC）配置一个向量语义检索脚本。详见 README。" };
    }
    const spec = this.ctx.shell.resolve({
      command: "python3 " + shq(this.cfg.semanticScript) + " query " + shq(text) + " --n 3 --json",
      workdir: this.cfg.vault,
      timeoutMs: 120000,
      stdoutMaxBytes: 2 * 1024 * 1024,
    });
    const r = await this._sh(spec);
    if (r.exitCode !== 0) return { error: "语义检索失败：" + r.stderr.text.slice(0, 200) };
    const out = r.stdout.text;
    const start = out.indexOf("[");
    if (start < 0) return { results: [] };
    let arr = [];
    try {
      arr = JSON.parse(out.slice(start));
    } catch {
      arr = [];
    }
    return {
      results: arr.map((x) => ({
        path: x.path,
        title: x.title,
        score: x.score,
        snippet: String(x.text || "").replace(/\s+/g, " ").slice(0, 160),
      })),
    };
  }

  /** 读原文（限 vault 内相对路径）。 */
  async read(args) {
    const rel = args && typeof args.path === "string" ? args.path : "";
    if (!rel || rel.includes("..")) return { error: "非法路径" };
    let text = "";
    try {
      text = await readFile(join(this.cfg.vault, rel), "utf8");
    } catch {
      return { error: "读取失败" };
    }
    if (text.startsWith("---")) {
      const parts = text.split("---", 2);
      if (parts.length >= 3) text = parts[2];
    }
    return { path: rel, text: text.slice(0, 6000) };
  }
}

for (const m of ["today", "walk", "quicknote", "recent", "related", "read"]) {
  markRemote(ObsbnService.prototype, m);
}

export { ObsbnService as default };
