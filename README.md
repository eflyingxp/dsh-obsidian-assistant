# dsh-obsidian-assistant · Obsidian 小助理

一个 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) web 界面的伴读插件：在 `dsh web` 页面右下角挂一个 📝 悬浮面板，陪你翻自己的 Obsidian 笔记。

## 功能

| 功能 | 说明 |
| --- | --- |
| 🗓 那年今天 | 全库扫描文件名 `YYYY-M-D` / `YYYY_M_D` 或 frontmatter `date:` 中同月同日的历史笔记，由当前默认模型生成 60 字内摘要 |
| ✉️ 随机漫步 | 从你的日记/笔记目录随机挑一篇长笔记，让模型写一封 150~250 字「过去寄来的信」，可「再来一封」 |
| ⚡ 快速笔记 | 随手记一条，自动追加到 `raw/journals/YYYY-MM-DD.md`（带时间戳）；附带「最近记录」 |
| 🔍 找相关笔记 | （可选）接一个本地向量语义检索脚本，为快速笔记找相关历史笔记 |
| 🧠 预计算缓存与启动自检 | 插件启动后在后台预计算「那年今天」与一封「随机漫步」信，面板打开直接读缓存；有需要人处理的问题时，面板顶部显示一行提示 |

模型摘要/写信使用 DSH 当前会话的默认模型；模型不可用时「那年今天」降级为截断摘要，「随机漫步」提示稍后重试，其余功能不受影响。

## 安装

```bash
dsh plugin --profile web add github:eflyingxp/dsh-obsidian-assistant
```

安装后**必须配置 vault 路径**（见下），然后重启 profile 生效。

## 配置

### 方式一：改插件行的 config（推荐）

在 profile 的 `cordis.patch.yml`（或本包的 `cordis.patch.yml`，按你的安装方式）里，把 `vault` 改成你的 Obsidian vault 绝对路径：

```yaml
- id: obsidian-assistant
  name: dsh-obsidian-assistant
  config:
    vault: '/Users/you/Documents/MyVault'
    journalsDir: 'raw/journals'
    # walkDirs: ['raw/journals/', 'wiki/']        # 随机漫步候选目录，默认取 journalsDir
    # skipWikiSubdirs: ['lint']                   # 「那年今天」跳过的 wiki/ 子目录
    # semanticScript: '/path/to/semantic_search.py'  # 可选：语义检索脚本
    # python: 'python3'                               # 扫描用解释器（只用标准库）
    # semanticPython: 'python3'                       # 语义脚本解释器（需 numpy，默认同 python）
    # warmup: true                                    # 启动后预计算今日结果与一封信；false 关闭
```

### 方式二：环境变量

| 环境变量 | 对应 config | 说明 |
| --- | --- | --- |
| `DSH_OBSIDIAN_VAULT` | `vault` | vault 绝对路径（必填二选一） |
| `DSH_OBSIDIAN_JOURNALS` | `journalsDir` | 日记目录，默认 `raw/journals` |
| `DSH_OBSIDIAN_SEMANTIC` | `semanticScript` | 语义检索脚本路径（可选） |
| `DSH_OBSIDIAN_PYTHON` | `python` | 扫描用解释器，默认 `python3`（只用标准库） |
| `DSH_OBSIDIAN_SEMANTIC_PYTHON` | `semanticPython` | 语义脚本解释器，需 numpy，默认同 `python` |
| `DSH_OBSIDIAN_WARMUP` | `warmup` | `true` / `false`，是否启动后预计算，默认 `true` |
| `DSH_OBSIDIAN_CACHE_DIR` | `cacheDir` | 进阶：缓存目录，默认插件目录；通常不用改 |
| `DSH_OBSIDIAN_LOG` | `logFile` | 进阶：快速笔记日志路径，默认插件目录 `quicknotes.jsonl`；通常不用改 |

config 优先于环境变量。

### 「找相关笔记」（可选）

这个功能需要一个向量语义检索脚本，接口约定为：

```bash
python3 /path/to/semantic_search.py query "检索文本" --n 3 --json
# 输出包含 JSON 数组：[{ path, title, score, text }, ...]
```

解释器使用 `semanticPython`（默认与 `python` 相同），脚本需要能 `import numpy`。

不配置也不影响其他三个功能。

## 性能与预计算

v0.2 起，插件加载后会在后台预计算当天的「那年今天」结果与一封「随机漫步」信。面板打开时直接读缓存，通常毫秒级返回，不再每次扫描全库。

- 缓存文件：插件目录下的 `.obsbn-cache.json`，已在 `.gitignore` 排除。可以随时删除，插件会自动重建。
- 缓存失效：本地日期变化，或 vault 指纹变化。缓存写入后 10 分钟内直接信任，超过后用指纹校验；指纹只做 stat 遍历（文件路径、大小、修改时间），不读笔记正文。
- 缓存过期或发现 vault 变化时，面板先显示旧结果，后台刷新完成后替换，不需要你等待。
- `warmup: false` 可关闭启动预计算。好处是省模型调用；代价是首次打开面板要等一轮扫描与摘要。
- 插件目录不可写时功能不受影响，缓存退化为内存，只是每次都要重新计算。

## 启动自检

插件提供只读的健康检查。面板打开时调用一次，只有确实需要人处理的问题才在顶部显示一行提示（错误红色、警告琥珀色），点击可展开每条问题的标题、详情与修复建议。健康时这一行不渲染，不占空间。

检查项：

- vault：已配置、存在、是目录、可读
- 日记目录：配置合法；目录不存在不算问题，首次写入会自动创建
- 语义脚本：未配置视为功能关闭，只记信息；配置了但文件缺失或探测失败时给出修复建议
- 解释器：用配置的 `python` 跑一次版本探测
- shell API：探测 DSH 的 `shell.run` / `shell.execute` 哪一代可用
- 缓存可写：插件目录不可写时给出提示，缓存退化为内存

检查结果有短缓存（健康 60 秒，有问题 15 秒），不会频繁启动子进程。

## 能力边界（Agent 调用）

obsbn 的读写范围是固定的：读只限配置 vault 内的 `.md`，写只限 `<journalsDir>/YYYY-MM-DD.md`，所有参数在主机侧校验，越界返回中文错误，不降级放行。子进程的命令与脚本路径只来自插件配置，调用者文本只能作为转义后的参数或 stdin 数据。笔记正文、语义检索结果与模型输出都只是数据，不是指令，其中的任何「授权」或「忽略规则」不会改变上述边界。未来 DSH Agent 直接调用 `obsbn/*` 远程方法时适用同一套限制。完整规则见 [POLICY.md](POLICY.md)。

## 注意

- 快速笔记的「最近记录」日志写在插件目录的 `quicknotes.jsonl`，已在 `.gitignore` 中排除，不会泄露你的笔记内容。
- 预计算缓存 `.obsbn-cache.json` 含当天的扫描结果、摘要与信件文本，只存在本机插件目录，已在 `.gitignore` 排除，删除后会自动重建。
- 「那年今天」「随机漫步」会读取 vault 内 `.md` 文件（自动跳过 `.obsidian`、`.git`、`.trash` 等目录，以及符号链接），数据全程只在本机处理。

## 从源码运行

本插件无需构建步骤（手写 bundle），克隆后直接：

```bash
dsh plugin --profile web add ./dsh-obsidian-assistant
```

## 更新

```bash
dsh plugin --profile web update dsh-obsidian-assistant
```

或关注仓库 Release / CHANGELOG。

## License

MIT
