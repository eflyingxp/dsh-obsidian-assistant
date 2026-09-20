# dsh-obsidian-assistant · Obsidian 小助理

一个 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) web 界面的伴读插件：在 `dsh web` 页面右下角挂一个 📝 悬浮面板，陪你翻自己的 Obsidian 笔记。

## 功能

| 功能 | 说明 |
| --- | --- |
| 🗓 那年今天 | 全库扫描文件名 `YYYY-M-D` / `YYYY_M_D` 或 frontmatter `date:` 中同月同日的历史笔记，由当前默认模型生成 60 字内摘要 |
| ✉️ 随机漫步 | 从你的日记/笔记目录随机挑一篇长笔记，让模型写一封 150~250 字「过去寄来的信」，可「再来一封」 |
| ⚡ 快速笔记 | 随手记一条，自动追加到 `raw/journals/YYYY-MM-DD.md`（带时间戳）；附带「最近记录」 |
| 🔍 找相关笔记 | （可选）接一个本地向量语义检索脚本，为快速笔记找相关历史笔记 |

模型摘要/写信使用 DSH 当前会话的默认模型；模型不可用时自动降级为截断摘要/直接看原文。

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
```

### 方式二：环境变量

| 环境变量 | 对应 config | 说明 |
| --- | --- | --- |
| `DSH_OBSIDIAN_VAULT` | `vault` | vault 绝对路径（必填二选一） |
| `DSH_OBSIDIAN_JOURNALS` | `journalsDir` | 日记目录，默认 `raw/journals` |
| `DSH_OBSIDIAN_SEMANTIC` | `semanticScript` | 语义检索脚本路径（可选） |

config 优先于环境变量。

### 「找相关笔记」（可选）

这个功能需要一个向量语义检索脚本，接口约定为：

```bash
python3 /path/to/semantic_search.py query "检索文本" --n 3 --json
# 输出包含 JSON 数组：[{ path, title, score, text }, ...]
```

不配置也不影响其他三个功能。

## 注意

- 快速笔记的「最近记录」日志写在插件目录的 `quicknotes.jsonl`，已在 `.gitignore` 中排除，不会泄露你的笔记内容。
- 「那年今天」「随机漫步」会读取 vault 内 `.md` 文件（自动跳过 `.obsidian`、`.git`、`.trash` 等目录），数据全程只在本机处理。

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
