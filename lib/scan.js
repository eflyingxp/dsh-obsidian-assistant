// dsh-obsidian-assistant — 扫描与子进程。
//
// 两块：
//   1) vault 扫描（today / pick）：生成一段只用 Python 标准库的脚本，经
//      ctx.shell 以 `python3 -` + stdin 执行。扫描逻辑从 0.1.2 原样搬来，
//      只加了两处便宜的前置限制：单文件最多读 200k 字符、结果条数上限。
//   2) 语义检索（related）：调用配置指定的一个脚本，查询文本只作为 argv 参数
//      传入（shell 单引号转义），不拼进命令。
//
// 兼容 DSH 0.1.x 的 shell.run(spec) 与 0.2.x 的 shell.execute(spec).result()。
import { shq, LIMITS } from "./policy.js";

/** 执行一个已 resolve 的 shell spec，返回 {exitCode, stdout:{text}, stderr:{text}}。 */
export async function execShell(shell, spec) {
  if (typeof shell.run === "function") return shell.run(spec);
  const handle = await shell.execute(spec);
  return handle.result();
}

/** 生成 python 扫描脚本（只在标准库下运行）。 */
export function buildScanScript(cfg) {
  const head = 'import json, os, re, random, sys\nCFG = ' + JSON.stringify(cfg) + "\n";
  const body = [
    'vault = CFG["vault"]',
    'skip_dirs = {".obsidian", ".git", ".semantic-index", ".trash", "node_modules"}',
    'skip_prefixes = tuple("wiki/" + d + "/" for d in CFG.get("skip_wiki_subdirs", ["lint"]))',
    'max_read_chars = int(CFG.get("max_read_chars", 200000))',
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
    '        dirs[:] = [d for d in dirs if d not in skip_dirs and not os.path.islink(os.path.join(root, d))]',
    "        for f in files:",
    '            if not f.endswith(".md"): continue',
    '            if os.path.islink(os.path.join(root, f)): continue',
    '            rp = os.path.normpath(os.path.join(rel, f)) if rel != "." else f',
    '            rp = rp.replace(os.sep, "/")',
    "            if rp.startswith(skip_prefixes): continue",
    "            out.append(rp)",
    "    return out",
    "",
    "def read_note(rp):",
    "    p = os.path.join(vault, rp)",
    "    try:",
    '        with open(p, encoding="utf-8", errors="replace") as fh: return fh.read(max_read_chars)',
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
      'print(json.dumps(res[: int(CFG.get("max_entries", 40))], ensure_ascii=False))',
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

/** 运行一次 vault 扫描，返回解析后的结果（可能为 null）。失败抛带中文信息的 Error。 */
export async function runScan({ shell, python, vault, cfg, timeoutMs, stdoutMaxBytes }) {
  const spec = shell.resolve({
    command: shq(python) + " -",
    workdir: vault,
    timeoutMs: timeoutMs || LIMITS.scan.timeoutMs,
    stdoutMaxBytes: stdoutMaxBytes || LIMITS.scan.stdoutMaxBytes,
    stdin: buildScanScript(cfg),
  });
  let result;
  try {
    result = await execShell(shell, spec);
  } catch (error) {
    throw new Error("扫描进程启动失败（" + python + "）：" + String(error && error.message ? error.message : error).slice(0, 200));
  }
  if (!result || result.exitCode !== 0) {
    const stderr = result && result.stderr && result.stderr.text ? result.stderr.text : "";
    throw new Error("扫描失败：" + String(stderr).slice(0, LIMITS.script.stderrTailChars));
  }
  const text = result.stdout && result.stdout.text ? result.stdout.text.trim() : "";
  if (!text) return null;
  const last = text.split("\n").pop();
  try {
    return JSON.parse(last);
  } catch {
    throw new Error("扫描输出不是合法 JSON");
  }
}

/**
 * 运行语义检索脚本。查询文本只作为 argv 参数，经单引号转义后传入。
 * @returns {Promise<Array<{path:string,title:string,score:number,text:string}>>}
 */
export async function runSemanticSearch({ shell, python, script, text, vault, timeoutMs, stdoutMaxBytes }) {
  const command =
    shq(python) + " " + shq(script) + " query " + shq(text) + " --n " + LIMITS.related.maxResults + " --json";
  const spec = shell.resolve({
    command,
    workdir: vault,
    timeoutMs: timeoutMs || LIMITS.script.timeoutMs,
    stdoutMaxBytes: stdoutMaxBytes || LIMITS.script.stdoutMaxBytes,
  });
  let result;
  try {
    result = await execShell(shell, spec);
  } catch (error) {
    throw new Error("语义检索进程启动失败（" + python + "）：" + String(error && error.message ? error.message : error).slice(0, 200));
  }
  if (!result || result.exitCode !== 0) {
    const stderr = result && result.stderr && result.stderr.text ? result.stderr.text : "";
    throw new Error("语义检索失败：" + String(stderr).trim().slice(0, LIMITS.script.stderrTailChars));
  }
  const out = result.stdout && result.stdout.text ? result.stdout.text : "";
  const start = out.indexOf("[");
  if (start < 0) return [];
  try {
    const arr = JSON.parse(out.slice(start));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 执行一个只读探测命令，返回 {ok, detail}；用于健康检查。 */
export async function runProbe({ shell, command, timeoutMs = 15000 }) {
  const spec = shell.resolve({ command, timeoutMs, stdoutMaxBytes: 64 * 1024 });
  let result;
  try {
    result = await execShell(shell, spec);
  } catch (error) {
    return { ok: false, detail: String(error && error.message ? error.message : error).slice(0, 200) };
  }
  const stdout = result && result.stdout && result.stdout.text ? result.stdout.text.trim() : "";
  const stderr = result && result.stderr && result.stderr.text ? result.stderr.text.trim() : "";
  return {
    ok: !!result && result.exitCode === 0,
    detail: (result && result.exitCode !== 0 ? stderr || stdout : stdout).slice(0, 300),
  };
}
