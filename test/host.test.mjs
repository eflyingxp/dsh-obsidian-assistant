// obsbn v0.2 主机侧测试：用假 ctx + 假 shell（真实 python 子进程）+ 假模型，
// 覆盖缓存/预计算、指纹失效、并发去重、边界校验与自检。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import ObsbnService from "../lib/index.js";
import { isSafeRelPath, stripFrontmatter, sanitizeExclude, normalizeRelDir, shq } from "../lib/policy.js";

const DATE = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return { y: d.getFullYear(), mm: p(d.getMonth() + 1), dd: p(d.getDate()) };
})();

const dirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** 假 shell：把 spec.command 交给 /bin/sh 执行，stdin 透传，记录调用。 */
function makeMockShell() {
  const calls = [];
  const exec = (spec) =>
    new Promise((resolve) => {
      calls.push({ command: spec.command, workdir: spec.workdir });
      const child = spawn("/bin/sh", ["-c", spec.command], { cwd: spec.workdir });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", () => resolve({ exitCode: 127, stdout: { text: stdout }, stderr: { text: stderr || "spawn failed" } }));
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: { text: stdout }, stderr: { text: stderr } }));
      child.stdin.end(spec.stdin || "");
    });
  return {
    calls,
    resolve: (request) => Object.assign({ timeoutMs: 120000, stdoutMaxBytes: 20 * 1024 * 1024 }, request),
    execute: async (spec) => ({ result: async () => exec(spec) }),
  };
}

/** 假模型：摘要请求返回合法 JSON，写信请求返回一段信。 */
function makeMockLlm() {
  return {
    stream: ({ system, messages }) => {
      const user = messages[0].content[0].text;
      let text = "亲爱的：这是一封测试信。";
      if (system.includes("笔记摘要助手")) {
        const payload = JSON.parse(user);
        text = JSON.stringify(payload.map((item) => ({ i: item.i, summary: "摘要" + item.i })));
      }
      return (async function* () {
        yield { type: "text-delta", text };
      })();
    },
  };
}

function makeMockModel() {
  return { currentSelection: () => ({ provider: "mock", model: "mock" }) };
}

function makeCtx({ shell, llm, model }) {
  return {
    reflect: { provide: () => {} },
    shell,
    get(name) {
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return model;
      return undefined;
    },
  };
}

async function makeService(options = {}) {
  const cacheDir = options.cacheDir || (await tempDir("obsbn-cache-"));
  const logFile = options.logFile || join(cacheDir, "quicknotes.jsonl");
  const shell = options.shell || makeMockShell();
  const llm = "llm" in options ? options.llm : makeMockLlm();
  const model = llm ? makeMockModel() : undefined;
  const ctx = options.ctx || makeCtx({ shell, llm, model });
  const config = Object.assign(
    {
      vault: options.vault,
      journalsDir: "raw/journals",
      walkDirs: ["raw/journals/"],
      warmup: false,
      cacheDir,
      logFile,
      semanticScript: options.semanticScript || "",
      python: "python3",
      semanticPython: "python3",
    },
    options.config || {}
  );
  const service = new ObsbnService(ctx, config);
  if (service._warmTimer) clearTimeout(service._warmTimer);
  return { service, shell, cacheDir, logFile };
}

/** 造一个最小 vault：两篇同月同日 + 一篇随机漫步候选 + 若干应被跳过的文件。 */
async function makeVault() {
  const vault = await tempDir("obsbn-vault-");
  await mkdir(join(vault, "raw/journals"), { recursive: true });
  await mkdir(join(vault, "wiki/lint"), { recursive: true });
  await mkdir(join(vault, ".trash"), { recursive: true });
  await writeFile(
    join(vault, "raw/journals", `2019-${DATE.mm}-${DATE.dd}.md`),
    "# 2019 的今天\n\n今天重读《原则》，记下一条：把决策写成可复用的规则，比记住单个结论更重要。写作是把想法压成结构的过程。\n",
    "utf8"
  );
  await writeFile(
    join(vault, "wiki/记忆.md"),
    "---\ntitle: 记忆\ndate: 2021-" + DATE.mm + "-" + DATE.dd + "\n---\n\n那年今天在 wiki 里记了一段关于记忆与复盘的思考，这段正文超过六十个字符，用来验证 frontmatter 日期识别与摘要生成是否正常工作。\n",
    "utf8"
  );
  await writeFile(join(vault, "wiki/lint", `2020-${DATE.mm}-${DATE.dd}.md`), "# 应被跳过\n\n" + "内容".repeat(30) + "\n", "utf8");
  await writeFile(join(vault, ".trash", `2018-${DATE.mm}-${DATE.dd}.md`), "# 回收站\n\n" + "内容".repeat(30) + "\n", "utf8");
  await writeFile(
    join(vault, "raw/journals/随记.md"),
    "# 随记\n\n第一段：关于长期主义的随手记录，内容足够长，用来做随机漫步的候选。\n\n第二段：继续写一些观察和想法。\n\n第三段：凑够长笔记的门槛，确保会被挑选。\n" + "补充内容。".repeat(60) + "\n",
    "utf8"
  );
  await writeFile(
    join(vault, "raw/journals/随记二.md"),
    "# 随记二\n\n第一段：另一篇够长的候选笔记，用于验证「再来一封」能换一篇。\n\n第二段：内容继续。\n\n第三段：满足随机漫步的筛选条件。\n" + "更多内容。".repeat(60) + "\n",
    "utf8"
  );
  await writeFile(join(vault, "raw/journals/普通.md"), "# 普通\n\n短笔记。\n", "utf8");
  return vault;
}

function futureNote(vault) {
  return writeFile(
    join(vault, "raw/journals", `2015-${DATE.mm}-${DATE.dd}.md`),
    "# 2015 的今天\n\n这是之后补写的一篇同月同日笔记，用来验证 vault 指纹变化后缓存会失效并重新扫描，正文也超过六十个字符。\n",
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("policy：相对路径校验与 frontmatter 剥离", () => {
  assert.equal(isSafeRelPath("wiki/记忆.md"), true);
  assert.equal(isSafeRelPath("../secret.md"), false);
  assert.equal(isSafeRelPath("/etc/passwd"), false);
  assert.equal(isSafeRelPath("a//b.md"), false);
  assert.equal(isSafeRelPath("a/./b.md"), false);
  assert.equal(isSafeRelPath("a\\b.md"), false);
  assert.equal(isSafeRelPath("a/\0b.md"), false);
  assert.equal(isSafeRelPath(42), false);
  assert.equal(stripFrontmatter("---\ntitle: x\n---\n\n正文"), "\n正文");
  assert.equal(stripFrontmatter("没有 frontmatter"), "没有 frontmatter");
  assert.deepEqual(sanitizeExclude(["a.md", "../x", "b.md", 42]), ["a.md", "b.md"]);
  assert.equal(normalizeRelDir("raw/journals", "fallback").ok, true);
  assert.equal(normalizeRelDir("../evil", "fallback").dir, "fallback");
  assert.equal(normalizeRelDir("../evil", "fallback").ok, false);
});

// ---------------------------------------------------------------------------
// today：冷启动 → 缓存 → 指纹失效 → 并发去重
// ---------------------------------------------------------------------------

test("today：冷启动 warming，完成后缓存命中且不再起子进程", async () => {
  const vault = await makeVault();
  const { service, shell } = await makeService({ vault });
  const first = await service.today();
  assert.equal(first.warming, true);
  assert.deepEqual(first.entries, []);
  await service._job("today").promise;
  const callsAfterScan = shell.calls.length;
  assert.equal(callsAfterScan, 1);

  const second = await service.today();
  assert.equal(second.cached, true);
  assert.equal(second.warming, undefined);
  assert.equal(second.entries.length, 2);
  assert.deepEqual(
    second.entries.map((e) => e.year),
    [2021, 2019]
  );
  assert.ok(second.entries.every((e) => e.summary && e.summary.length > 0));
  assert.equal(shell.calls.length, callsAfterScan);
});

test("today：vault 变化后指纹失效，先给旧结果再后台刷新", async () => {
  const vault = await makeVault();
  const { service, shell } = await makeService({ vault });
  await service.today();
  await service._job("today").promise;
  const callsAfterScan = shell.calls.length;

  // 把缓存时间调老，强制走指纹校验。
  service.cacheStore.data.today.at = Date.now() - 11 * 60 * 1000;
  service._sigCache = null;
  await futureNote(vault);

  const stale = await service.today();
  assert.equal(stale.stale, true);
  assert.equal(stale.refreshing, true);
  assert.equal(stale.entries.length, 2);
  await service._job("today").promise;
  const fresh = await service.today();
  assert.equal(fresh.entries.length, 3);
  assert.ok(shell.calls.length > callsAfterScan);
});

test("today：并发请求只启动一次扫描", async () => {
  const vault = await makeVault();
  const { service, shell } = await makeService({ vault });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => service.today()));
  assert.ok(results.every((r) => r.warming === true));
  await service._job("today").promise;
  assert.equal(shell.calls.length, 1);
  const cached = await service.today();
  assert.equal(cached.cached, true);
  assert.equal(cached.entries.length, 2);
});

test("today：没有模型时回退截断摘要，且标记未摘要", async () => {
  const vault = await makeVault();
  const { service } = await makeService({ vault, llm: undefined });
  await service.today();
  await service._job("today").promise;
  const hit = service.cacheStore.getToday();
  assert.equal(hit.summarized, false);
  const result = await service.today();
  assert.ok(result.entries.every((e) => e.summary.includes("…") || e.summary.length <= 60));
});

test("cache：并发加载不会把已有缓存误判为空", async () => {
  const vault = await makeVault();
  const cacheDir = await tempDir("obsbn-cache-");
  const logFile = join(cacheDir, "quicknotes.jsonl");
  const first = await makeService({ vault, cacheDir, logFile });
  await first.service.today();
  await first.service._job("today").promise;

  // 新实例 = 新的 CacheStore，并发两个 today() 共享同一次磁盘加载。
  const second = await makeService({ vault, cacheDir, logFile });
  const [a, b] = await Promise.all([second.service.today(), second.service.today()]);
  assert.equal(a.cached, true);
  assert.equal(b.cached, true);
});

// ---------------------------------------------------------------------------
// walk：预生成、缓存、再来一封
// ---------------------------------------------------------------------------

test("walk：首次 warming，完成后缓存命中；exclude 非空同步生成", async () => {
  const vault = await makeVault();
  const { service, shell } = await makeService({ vault });
  const first = await service.walk({ exclude: [] });
  assert.equal(first.warming, true);
  await service._job("walk").promise;
  const cached = await service.walk({ exclude: [] });
  assert.equal(cached.cached, true);
  assert.ok(cached.letter.includes("亲爱的"));
  const callsAfterWarm = shell.calls.length;

  const another = await service.walk({ exclude: [cached.path] });
  assert.equal(another.cached, undefined);
  assert.ok(another.letter.includes("亲爱的"));
  assert.notEqual(another.path, cached.path);
  assert.equal(shell.calls.length > callsAfterWarm, true);
});

test("walk：模型不可用时任务失败，后续返回中文错误", async () => {
  const vault = await makeVault();
  const { service } = await makeService({ vault, llm: undefined });
  await service.walk({ exclude: [] });
  await service._job("walk").promise;
  const result = await service.walk({ exclude: [] });
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

// ---------------------------------------------------------------------------
// read / quicknote 边界
// ---------------------------------------------------------------------------

test("read：去 frontmatter、拒绝越界、绝对路径、非 md、超大文件与符号链接逃逸", async () => {
  const vault = await makeVault();
  const { service } = await makeService({ vault });

  const ok = await service.read({ path: "wiki/记忆.md" });
  assert.equal(ok.error, undefined);
  assert.ok(!ok.text.startsWith("---"));
  assert.ok(ok.text.includes("记忆与复盘"));

  for (const bad of ["../outside.md", "/tmp/absolute.md", "wiki/记忆.txt", "no-such.md"]) {
    const result = await service.read({ path: bad });
    assert.ok(result.error, "应拒绝：" + bad);
  }

  await writeFile(join(vault, "raw/journals/big.md"), "x".repeat(600 * 1024), "utf8");
  const big = await service.read({ path: "raw/journals/big.md" });
  assert.ok(big.error && big.error.includes("上限"));

  const outside = await tempDir("obsbn-outside-");
  const secret = join(outside, "secret.md");
  await writeFile(secret, "# secret", "utf8");
  await symlink(secret, join(vault, "raw/journals/link.md"));
  const escaped = await service.read({ path: "raw/journals/link.md" });
  assert.ok(escaped.error && escaped.error.includes("超出 vault"));
});

test("quicknote：首次创建、再次追加、超长拒绝、非法输入拒绝", async () => {
  const vault = await makeVault();
  const { service, logFile } = await makeService({ vault });
  const first = await service.quicknote({ text: "第一条快速笔记" });
  assert.ok(first.path && first.path.startsWith("raw/journals/"));
  const abs = join(vault, first.path);

  const second = await service.quicknote({ text: "第二条快速笔记" });
  assert.equal(second.path, first.path);
  const body = await readFile(abs, "utf8");
  assert.ok(body.includes("第一条快速笔记"));
  assert.ok(body.includes("第二条快速笔记"));
  assert.equal(body.split("第一条快速笔记").length, 2);

  assert.ok((await service.quicknote({ text: "   " })).error);
  assert.ok((await service.quicknote({ text: "x".repeat(4001) })).error);
  assert.ok((await service.quicknote({ text: "ok\0bad" })).error);

  const log = await readFile(logFile, "utf8");
  assert.equal(log.trim().split("\n").length, 2);
});

test("recent：只返回最近 3 条且新的在前", async () => {
  const vault = await makeVault();
  const { service } = await makeService({ vault });
  for (const text of ["一", "二", "三", "四"]) await service.quicknote({ text });
  const recent = await service.recent();
  assert.equal(recent.entries.length, 3);
  assert.deepEqual(
    recent.entries.map((e) => e.text),
    ["四", "三", "二"]
  );
});

// ---------------------------------------------------------------------------
// related：长度闸、缓存、去重、脚本错误
// ---------------------------------------------------------------------------

async function makeSemanticScript(queryResult) {
  const dir = await tempDir("obsbn-sem-");
  const script = join(dir, "semantic.py");
  await writeFile(
    script,
    [
      "import sys, json",
      "args = sys.argv[1:]",
      "query = args[args.index('query') + 1] if 'query' in args else ''",
      "print(json.dumps(" + JSON.stringify([Object.assign({}, queryResult)]) + "))",
    ].join("\n"),
    "utf8"
  );
  return script;
}

test("related：短文本直接返回、相同查询走缓存、长查询截断到 1000 字", async () => {
  const vault = await makeVault();
  const script = await makeSemanticScript({ path: "wiki/记忆.md", title: "记忆", score: 0.9, text: "命中" });
  const { service, shell } = await makeService({ vault, semanticScript: script });

  const tooShort = await service.related({ text: "abc" });
  assert.deepEqual(tooShort.results, []);
  assert.equal(shell.calls.length, 0);

  const first = await service.related({ text: "教练 洞察" });
  assert.equal(first.error, undefined);
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].title, "记忆");
  const callsAfterFirst = shell.calls.length;

  const second = await service.related({ text: "教练 洞察" });
  assert.equal(second.cached, true);
  assert.equal(shell.calls.length, callsAfterFirst);

  const longText = "长".repeat(2000);
  const longResult = await service.related({ text: longText });
  assert.equal(longResult.error, undefined);
  const command = shell.calls[shell.calls.length - 1].command;
  assert.ok(command.length < 4000, "查询文本应被截断后再进命令");
});

test("related：脚本不存在与脚本执行失败都返回可行动错误", async () => {
  const vault = await makeVault();
  const { service: missing } = await makeService({ vault, semanticScript: "/tmp/definitely-not-exists-semantic.py" });
  const missingResult = await missing.related({ text: "教练 洞察" });
  assert.ok(missingResult.error.includes("语义检索脚本不存在"));

  const dir = await tempDir("obsbn-bad-sem-");
  const badScript = join(dir, "bad.py");
  await writeFile(badScript, "import sys\nsys.exit(3)\n", "utf8");
  const { service: broken } = await makeService({ vault, semanticScript: badScript });
  const brokenResult = await broken.related({ text: "教练 洞察" });
  assert.ok(brokenResult.error.includes("语义检索失败"));
});

// ---------------------------------------------------------------------------
// 符号链接：写入拒绝、扫描跳过、指纹稳定
// ---------------------------------------------------------------------------

test("quicknote：目标日记是符号链接时拒绝写入，vault 外文件不被创建或修改", async () => {
  const vault = await makeVault();
  const outside = await tempDir("obsbn-link-out-");
  const outsideNew = join(outside, "created-by-plugin.md");
  const outsideExisting = join(outside, "existing.md");
  await writeFile(outsideExisting, "原始内容", "utf8");

  const dayFile = `${DATE.y}-${DATE.mm}-${DATE.dd}.md`;
  const target = join(vault, "raw/journals", dayFile);
  await symlink(outsideNew, target); // 悬空链接：旧实现会跟随并创建外部文件
  const { service } = await makeService({ vault });
  const result = await service.quicknote({ text: "不应该写出去" });
  assert.ok(result.error && result.error.includes("符号链接"), "应拒绝符号链接目标");
  await assert.rejects(stat(outsideNew), "vault 外文件不应被创建");

  await rm(target);
  await symlink(outsideExisting, target); // 指向已存在的外部文件
  const again = await service.quicknote({ text: "也不该追加" });
  assert.ok(again.error, "指向已存在外部文件的符号链接也应被拒绝");
  assert.equal(await readFile(outsideExisting, "utf8"), "原始内容");
});

test("today：扫描跳过符号链接笔记，外部文件变动不影响 vault 指纹", async () => {
  const vault = await makeVault();
  const outside = await tempDir("obsbn-link-note-");
  const outsideNote = join(outside, "2017-old.md");
  const outsideContent = "# 外部笔记\n\n这是 vault 之外的敏感内容，不应该出现在面板里。\n";
  await writeFile(outsideNote, outsideContent, "utf8");
  const linkPath = join(vault, "raw/journals", `2017-${DATE.mm}-${DATE.dd}.md`);
  await symlink(outsideNote, linkPath);

  const { service } = await makeService({ vault });
  const sigBefore = await service._vaultSig(true);
  await service.today();
  await service._job("today").promise;
  const result = await service.today();
  assert.equal(result.entries.length, 2, "符号链接笔记不应计入今日结果");
  assert.ok(!result.entries.some((e) => e.path.includes("2017-")));

  await writeFile(outsideNote, outsideContent + "追加一段外部内容。\n", "utf8");
  const sigAfter = await service._vaultSig(true);
  assert.equal(sigAfter, sigBefore, "vault 外文件变动不应改变指纹");
});

test("quicknote：journalsDir 中间目录是符号链接时拒绝，且不会在 vault 外建目录", async () => {
  const vault = await tempDir("obsbn-vault-linkdir-");
  const outside = await tempDir("obsbn-outside-dir-");
  await symlink(outside, join(vault, "raw"));
  const { service } = await makeService({ vault });
  const result = await service.quicknote({ text: "不应创建外部目录" });
  assert.ok(result.error, "中间目录是符号链接时应拒绝写入");
  await assert.rejects(stat(join(outside, "journals")), "不应在 vault 外创建 journals 目录");
});

// ---------------------------------------------------------------------------
// journalsDir 配置非法与缓存损坏
// ---------------------------------------------------------------------------

test("journalsDir：绝对路径配置被拒绝并回退，健康检查可见，写入不越界", async () => {
  const vault = await makeVault();
  const outsideDir = await tempDir("obsbn-evil-journals-");
  const { service } = await makeService({
    vault,
    config: { journalsDir: join(outsideDir, "evil") },
  });
  assert.equal(service.policy.journalsDir, "raw/journals");
  const saved = await service.quicknote({ text: "回退路径写入" });
  assert.equal(saved.error, undefined);
  assert.ok(saved.path.startsWith("raw/journals/"));
  const health = await service.health();
  assert.ok(health.problems.some((p) => p.id === "journals" && p.severity === "warn"));
  await assert.rejects(stat(join(outsideDir, "evil")), "不应在 vault 外创建日记目录");
});

test("cache：损坏或超大的缓存文件安全回退，不影响 today", async () => {
  const vault = await makeVault();
  const cacheDir = await tempDir("obsbn-badcache-");
  await writeFile(join(cacheDir, ".obsbn-cache.json"), "{这不是合法 JSON", "utf8");
  const first = await makeService({ vault, cacheDir });
  const warming = await first.service.today();
  assert.equal(warming.warming, true);
  await first.service._job("today").promise;
  const cached = await first.service.today();
  assert.equal(cached.entries.length, 2);

  await writeFile(join(cacheDir, ".obsbn-cache.json"), "x".repeat(3 * 1024 * 1024), "utf8");
  const second = await makeService({ vault, cacheDir });
  const result = await second.service.today();
  assert.ok(result.warming === true || result.cached === true);
  if (result.warming) await second.service._job("today").promise;
  const entries = await second.service.today();
  assert.equal(entries.entries.length, 2);
});

// ---------------------------------------------------------------------------
// health：健康/缺 vault/坏语义脚本
// ---------------------------------------------------------------------------

test("health：健康 vault 返回 ok，未配置语义只进 info", async () => {
  const vault = await makeVault();
  const { service } = await makeService({ vault });
  const health = await service.health();
  assert.equal(health.ok, true);
  assert.deepEqual(health.problems, []);
  assert.ok(health.info.some((i) => i.id === "semantic"));
  assert.ok(health.checks.some((c) => c.id === "shell" && c.ok));
});

test("health：vault 不存在时报 error，语义脚本丢失时报 warn", async () => {
  const missingVault = await tempDir("obsbn-novault-");
  const { service } = await makeService({ vault: missingVault, config: { vault: join(missingVault, "nope") } });
  const health = await service.health();
  assert.equal(health.ok, false);
  assert.ok(health.problems.some((p) => p.id === "vault" && p.severity === "error"));

  const vault = await makeVault();
  const { service: badSem } = await makeService({ vault, semanticScript: join(vault, "missing-script.py") });
  const semHealth = await badSem.health();
  assert.equal(semHealth.ok, false);
  assert.ok(semHealth.problems.some((p) => p.id === "semantic" && p.severity === "warn"));
});

// ---------------------------------------------------------------------------
// 预计算：跨进程缓存复用（模拟重启）
// ---------------------------------------------------------------------------

test("warm：预计算今日与一封信；重启后直接命中缓存不再扫描", async () => {
  const vault = await makeVault();
  const cacheDir = await tempDir("obsbn-cache-");
  const logFile = join(cacheDir, "quicknotes.jsonl");
  const first = await makeService({ vault, cacheDir, logFile });
  await first.service._warm();
  assert.ok(first.service.cacheStore.getToday());
  assert.ok(first.service.cacheStore.getWalk());

  const second = await makeService({ vault, cacheDir, logFile });
  const today = await second.service.today();
  assert.equal(today.cached, true);
  assert.equal(today.entries.length, 2);
  const walk = await second.service.walk({ exclude: [] });
  assert.equal(walk.cached, true);
  assert.equal(second.shell.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 子进程命令拼装（防注入）
// ---------------------------------------------------------------------------

test("shq：单引号文本不会被 shell 解释", async () => {
  const shell = makeMockShell();
  const evil = "'; echo pwned; '";
  const spec = { command: "printf '%s' " + shq(evil), workdir: "/tmp" };
  const result = await shell.execute(shell.resolve(spec)).then((h) => h.result());
  assert.equal(result.stdout.text, evil);
});
