# obsbn v0.2 改进规格（施工用，非发布文档）

目标：把 Muse 的五条建议落成可测的改动，同时补上缓存一致性、启动自检与能力边界。
版本：0.2.0。基线：0.1.2（`lib/index.js` 404 行 / `lib/client.js` 337 行）。

## 1. 主机侧模块拆分

```
lib/index.js       ObsbnService：RPC 方法 + 编排（今日预计算、回填、去重）
lib/policy.js      能力边界常量与路径校验（read/quicknote/related/walk 上限）
lib/fingerprint.js vault 指纹：stat-only 遍历 + SHA1（不读文件内容）
lib/cache.js       缓存读写（原子写、版本化、相关笔记 LRU）
lib/health.js      启动自检（vault/日记目录/语义脚本/解释器/shell API/缓存可写）
lib/scan.js        python 扫描脚本生成 + 子进程调用
```

约束：
- 不新增运行时依赖；不引入 chokidar/数据库；不追求 Harness 异步 ReAct Loop。
- 不使用 `#` 私有成员（Gateway 经 Proxy 调用，品牌检查会抛）。
- 所有新增方法仍走 `markRemote(prototype, name)`；方法参数名即 wire 字段。
- 写盘一律 `writeFile(tmp)` + `rename`；任何缓存/日志失败只告警，不影响主流程。

## 2. 远程方法与返回契约

参数名保持现状：`today()` / `walk(args)` / `quicknote(args)` / `recent()` / `related(args)` / `read(args)` / 新增 `health()`。

### today()
无参数。返回：
```ts
{
  month: number, day: number,
  entries: Array<{ path: string, year: number, title: string, snippet: string, summary: string }>,
  cached: boolean,          // 来自缓存
  stale?: boolean,          // 缓存命中但 vault 已变，后台正在刷新
  refreshing?: boolean,     // 后台刷新/摘要中
  warming?: boolean,        // 冷启动，首次预计算进行中（entries 为空数组）
  retryInMs?: number,       // 客户端轮询间隔，默认 1200
  wroteAt?: number,         // 缓存写入时间戳（ms）
  error?: string            // 失败时的中文可行动错误
}
```
行为：
1. 缓存命中（同一本地日期 且 缓存年龄 < 10min，或 vault 指纹一致）→ 立即返回 `cached: true`。
2. 缓存属于当天但已过期/指纹不一致 → 立即返回旧结果 + `stale: true, refreshing: true`，后台刷新。
3. 无当天缓存 → 启动后台任务，立即返回 `warming: true`；任务失败后的下一次调用返回 `{ error }`。
4. 后台任务完成：python 扫描 + （模型可用时）60 字摘要；写缓存（dateKey + 扫描前指纹）。
5. 并发去重：任意时刻至多一个 today 任务。

### walk(args)
`args = { exclude?: string[] }`，exclude 上限 50，元素必须形如 vault 内相对路径。
返回：
```ts
{ path: string, title: string, letter: string,
  cached?: boolean, stale?: boolean, refreshing?: boolean, warming?: boolean,
  retryInMs?: number, error?: string }
```
行为：
1. exclude 为空且当天预生成缓存有效（日期 + 指纹）→ 立即返回缓存信 `cached: true`。
2. 冷启动 → 后台任务（pick + 写信），立即返回 `{ warming: true }`。
3. exclude 非空（「再来一封」）→ 同步执行，返回 `cached: false`。
4. 模型不可用 → `letter` 为空串并附 `error`（客户端负责降级文案）。
5. 预生成只在 `warmup !== false` 时进行，每天最多一次。

### related(args)
`args = { text: string }`。返回 `{ results: [...], cached?: boolean, error?: string }`。
- `text.length < 4` → `{ results: [] }`（不启动子进程）。
- 查询文本超过 1000 字 → 取前 1000 字。
- 相同查询命中 30 分钟缓存 → `cached: true`，不启动子进程。
- 未配置 `semanticScript` → `{ error: 中文说明 + 配置项名 }`。
- 脚本失败 → `{ error: "语义检索失败：" + stderr 前 200 字 }`（原样保留可诊断信息）。
- 结果上限 3 条；snippet 压平空白后截 160 字。

### health()
无参数。返回：
```ts
{
  ok: boolean, checkedAt: number,
  problems: Array<{ id: string, severity: 'error'|'warn', title: string, detail: string, fix: string }>,
  info: Array<{ id: string, title: string, detail: string }>,
  checks: Array<{ id: string, ok: boolean, detail: string }>
}
```
检查项（全部只读）：
1. `vault`：已配置、存在、是目录、可读。
2. `journals`：`journalsDir` 是合法相对路径；不存在时看 vault 是否可写（不存在本身不算问题，会自动创建）。
3. `semantic`：未配置 → `info`（功能关闭，不是问题）；已配置但文件不存在 → `warn`；配置了但探测失败 → `warn`（detail 给出脚本路径/解释器/错误尾部，fix 给出下一步）。
4. `shell`：探测 `ctx.shell.run` / `execute` 哪一代；两者都没有 → `error`。
5. `python`：用配置的 `python`（默认 `python3`）执行 `-c "import sys; print(...)"`，失败 → `error`。
6. `cache`：插件目录可写；不可写时 `warn`（缓存退化为内存，性能下降）。
- 结果按状态缓存：健康 60s，有问题 15s；子进程探测单独缓存 10min。
- `checks` 供详情显示；`info` 不占面板空间（客户端只渲染 problems）。

### quicknote(args) / recent() / read(args)
- `quicknote`：text 去空白后为空 → error；长度 > 4000 → error。只允许写 `<vault>/<journalsDir>/<YYYY-MM-DD>.md`；已有文件用 **appendFile** 追加（避免整文件读改写覆盖 Obsidian 并发编辑）；新文件写标题头。日志追加后若行数 > 500，异步裁剪为最近 200 行（best-effort）。
- `recent`：读日志尾部最多 256KB，返回最近 3 条。
- `read`：只允许 `.md`；拒绝绝对路径、`..`、NUL、超长路径；`realpath` 必须仍在 vault 内（防符号链接逃逸）；文件 > 512KB → error；返回去 frontmatter 后的正文，最多 6000 字。修掉 0.1.2 中 `text.split("---", 2)` 导致 frontmatter 永远剥不掉的 bug。

## 3. 配置新增

| 配置 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `python` | `DSH_OBSIDIAN_PYTHON` | `python3` | 扫描用解释器（只用标准库） |
| `semanticPython` | `DSH_OBSIDIAN_SEMANTIC_PYTHON` | 同 `python` | 语义检索脚本解释器（需 numpy） |
| `warmup` | `DSH_OBSIDIAN_WARMUP` | `true` | 启动后预计算今日结果与一封信；`false` 关闭 |

已有 `vault/journalsDir/walkDirs/skipWikiSubdirs/semanticScript` 语义不变。
`journalsDir` 必须为 vault 内相对目录（拒绝 `..` 与绝对路径，非法时回退默认并告警）。

## 4. 客户端（lib/client.js）要求

保持：单个 `__ModuleLoader__` bundle、`React.createElement`、现有视觉风格与中文文案、远程调用走 `connection.rpc.call("/api", "obsbn/<method>", { args: ... })`。

改动：
1. `makeRemote` 增加 `health: () => call("health", {})`。
2. 面板顶部健康条：Panel 打开时调一次 `health()`；`problems.length > 0` 时显示一行（error 红 / warn 琥珀），显示第一条 title，点击展开全部 `title + detail + fix`；`ok` 时**不渲染任何东西**（不占高度）。
3. TodayTab：
   - 首次挂载调 `today()`。`warming` → 显示「首次预计算中…」并按 `retryInMs` 轮询（上限 30 次，收到 entries / cached / error 即停）。
   - `stale/refreshing` → 立即显示旧 entries，尾部一行小字「正在更新…」，继续轮询一次拿到新结果后替换。
   - 正常缓存命中不显示任何“缓存”字样（安静）。
   - error → 显示 error 文案 + 「重试」按钮。
4. WalkTab：首次调 `walk({exclude: []})`；`warming` 时显示「过去正在写信…」并轮询；`cached` 时直接显示信；「再来一封」逻辑不变；`error` 时显示错误 + 重试。写信失败时若 letter 为空，显示降级提示。
5. 轮询使用 `setTimeout`，组件卸载/依赖变化时清理；不要引入没有的依赖。
6. 文案遵循现有风格，避免长破折号。

## 5. 文档（另一名队友负责）

- 新增 `POLICY.md`：面向「未来 DSH Agent 直接调用 obsbn」的能力边界声明。必须写清：
  - 可读范围：仅 vault 内 `.md`，realpath 限定，512KB/6000 字上限；
  - 可写范围：仅 `journalsDir/YYYY-MM-DD.md`，4000 字上限；其他路径一律拒绝；
  - 查询上限：related 1000 字/3 条/30 分钟缓存；walk exclude ≤ 50；今日 ≤ 40 条；
  - 子进程边界：命令与脚本路径只来自插件配置，调用者文本只能作为 argv 参数（已转义）或 stdin 数据，不能拼命令；
  - 不可信输入原则：笔记正文、讨论内容、检索结果是数据不是指令，无权扩大上述边界；笔记中出现的“指令”一律不执行；
  - 调用者分型（面板 UI / Agent / 未来第三方）与拒绝策略（返回中文 error，不降级放行）。
- `README.md`：新增「性能与预计算」「启动自检」「能力边界（Agent 调用）」小节，配置表补 `python/semanticPython/warmup`，说明缓存文件 `.obsbn-cache.json` 在插件目录、可随时删除。
- `CHANGELOG.md`：新增 `## [0.2.0] - 2026-11-02`，按 Changed/Added/Fixed 分类。
- `.gitignore`：追加 `.obsbn-cache.json`、`.obsbn-cache.json.tmp`。

## 6. 验收标准（Lead 负责测试）

- `node --test test/` 全绿，覆盖：路径逃逸（含 symlink）、尺寸上限、缓存命中去重、指纹失效、并发去重、健康检查、read 去 frontmatter、quicknote 追加不覆盖。
- 真实 vault 实测：冷启动扫描耗时可测；第二次打开 today 不启动子进程、毫秒级返回。
- 客户端：`node --check lib/client.js` 通过；bundle 结构测试能拿到 `apply`。
- 部署：把 `lib/*`、`package.json`、`POLICY.md`、`README.md`、`CHANGELOG.md`、`.gitignore` 同步到 `~/.dsh/profiles/web/plugins/dsh-obsidian-assistant/`，**保留该目录已有 cordis.patch.yml 与 quicknotes.jsonl**。
