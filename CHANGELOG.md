# Changelog

## [0.2.0] - 2026-11-02

### Added

- 预计算与缓存：插件启动后在后台预计算当天的「那年今天」结果与一封「随机漫步」信，写入插件目录的 `.obsbn-cache.json`（原子写，可随时删除，会自动重建）。面板打开直接读缓存，不再每次全库扫描。
- 异步冷启动与回填：缓存缺失或过期时立即返回 `warming` / `stale + refreshing`，客户端按 `retryInMs` 轮询，后台任务完成后替换结果。
- 两级过滤：先用便宜的程序级前置闸挡掉大多数请求（本地日期、stat-only 的 vault 指纹、文本长度下限、相同查询的 30 分钟缓存），挡不住才进入昂贵一级（python 全库扫描、语义检索子进程、模型摘要）；vault 没变过时不再启动扫描与模型调用。
- 启动自检 `health()`：检查 vault、日记目录、语义脚本、解释器、shell API、缓存可写；面板顶部只在有需要人处理的问题时显示一行提示，健康时不占空间。
- 能力边界 `POLICY.md`：声明可读、可写、查询、子进程与不可信输入边界，以及调用者分型与拒绝策略。
- 配置新增 `python`、`semanticPython`、`warmup` 及对应环境变量 `DSH_OBSIDIAN_PYTHON`、`DSH_OBSIDIAN_SEMANTIC_PYTHON`、`DSH_OBSIDIAN_WARMUP`。扫描只依赖 Python 标准库，语义脚本可单独指定需要 numpy 的解释器。

### Changed

- `today()` / `walk()` 返回新增 `cached`、`stale`、`refreshing`、`warming`、`retryInMs`、`wroteAt`、`error` 字段，客户端按缓存态渲染并轮询。
- `related()` 查询文本超过 1000 字截断，结果上限 3 条，相同查询 30 分钟内命中缓存；未配置语义脚本时返回明确错误。
- `walk()` 失败时返回 `error`；同步的「再来一封」路径另带 `path` / `title` 便于定位，冷启动失败由客户端显示重试提示。
- `read()` 校验收紧：仅 vault 内 `.md`，拒绝绝对路径、`..`、NUL、反斜杠、超长路径与空路径段，realpath 必须仍在 vault 内（防符号链接逃逸）；单文件 512KB、返回正文 6000 字上限。
- `quicknote()` 单条正文上限 4000 字。
- `journalsDir` 为绝对路径或含 `..` 时回退默认值并告警。
- 路径与上限校验集中到 `lib/policy.js`，所有远程方法共用同一套规则。

### Fixed

- 安全：`quicknote` 写日记改用 `O_NOFOLLOW`，目标为符号链接时直接拒绝（旧实现会跟随链接把内容写到 vault 外）；新建文件用 `O_CREAT|O_EXCL` 防并发覆盖。
- 安全：`today` / `walk` 扫描跳过符号链接，与 vault 指纹口径一致；此前 vault 内的链接笔记会读取到链接目标（可能在 vault 外），且目标内容变化不改变指纹，导致缓存长期返回旧内容。
- `journalsDir` 配成绝对路径时不再被去掉前导斜杠当成相对路径，而是按文档回退默认值并告警；`health()` 能把这个配置错误显示在面板上。
- 日志裁剪阈值改用字节数（`Buffer.byteLength`），与 POLICY 的 256KB 口径一致。
- `read()` 去 frontmatter：0.1.2 的 `split("---", 2)` 永远拿不到第三段，frontmatter 从来没有被剥掉，现在正确剥离。
- `quicknote()` 写已有日记改用 `appendFile`，不再整文件读改写，避免覆盖 Obsidian 的并发编辑；日志达到 256KB 且超过 500 行时异步裁剪为最近 200 行。
- `recent()` 改为只读日志尾部最多 256KB，日志变大后不再整文件载入。

## [0.1.2] - 2026-09-24

### Fixed

- 适配 DSH 0.1.7-rc.1 shell API 重构：`shell.run(spec)` 已移除，改为 `shell.execute(spec)` 返回进程句柄、`handle.result()` 取前台结果。新增 `_sh()` 兼容层，自动探测新旧 API，新旧版 DSH 均可运行。修复「那年今天 / 随机漫步 / 找相关笔记」报 `this.ctx.shell.run is not a function` 的问题。

## 0.1.0 (2026-09-20)

首次公开发布。

- 🗓 那年今天：同月同日历史笔记扫描 + LLM 摘要
- ✉️ 随机漫步：随机长笔记 → 「过去寄来的信」
- ⚡ 快速笔记：追加当日日记 + 最近记录
- 🔍 找相关笔记：可配置的语义检索接口
- vault / 日记目录 / 语义检索脚本路径全部可配置（config 或环境变量），去除一切硬编码本机路径

## [0.1.1] - 2026-09-20

### Fixed

- 快速笔记页「最近记录」区块从不显示：客户端 remote 代理漏注册 `recent` 方法，且空列表时静默隐藏。现在补齐 `recent` 调用，空列表也显示区块标题与提示。
