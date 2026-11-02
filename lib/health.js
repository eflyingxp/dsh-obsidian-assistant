// dsh-obsidian-assistant — 启动自检（微型 Watchdog，无模型）。
//
// 只回答一个问题：这东西现在能不能用、哪里需要人处理。
// 面板只在 problems 非空时占一行；健康时不占空间（原型 Philosophy：
// 「面板只显示需要人处理的东西」）。
//
// 检查分两类：
//   - 同步的 fs 检查：vault / 日记目录 / 语义脚本 / 缓存目录可写
//   - 子进程探测：python 解释器、语义脚本 status；结果单独缓存 10 分钟，
//     避免每次打开面板都起进程
import { stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { runProbe } from "./scan.js";
import { normalizeRelDir, shq } from "./policy.js";

/** 子进程探测结果缓存时长。 */
const PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * 健康检查器。与 ObsbnService 解耦，方便测试。
 */
export class Health {
  /**
   * @param {object} options
   * @param {object} options.cfg 已归一化的插件配置
   * @param {object} options.shell ctx.shell
   * @param {string} options.pluginDir 插件目录（缓存可写性的判断依据）
   * @param {() => boolean} options.cacheWritable 缓存当前是否还能写
   */
  constructor({ cfg, shell, pluginDir, journalsDirWarning, cacheWritable }) {
    this.cfg = cfg;
    this.shell = shell;
    this.pluginDir = pluginDir;
    /** 启动时 journalsDir 归一化的告警；cfg 里已是回退后的值，所以必须单独传。 */
    this.journalsDirWarning = typeof journalsDirWarning === "string" ? journalsDirWarning : "";
    this.cacheWritable = cacheWritable;
    this.probes = new Map();
  }

  /** 带缓存地跑一个探测命令（同一个进程内 10 分钟内不重复跑）。 */
  async probe(id, command) {
    const now = Date.now();
    const cached = this.probes.get(id);
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.result;
    let result;
    try {
      result = await runProbe({ shell: this.shell, command });
    } catch (error) {
      result = { ok: false, detail: String(error && error.message ? error.message : error).slice(0, 200) };
    }
    this.probes.set(id, { at: now, result });
    return result;
  }

  /** 执行全部检查，返回面板可消费的结构。永不抛错。 */
  async check() {
    const checks = [];
    const problems = [];
    const info = [];
    const push = (id, ok, detail) => checks.push({ id, ok, detail });

    // 1. vault 路径
    let vaultOk = false;
    if (!this.cfg.vault) {
      push("vault", false, "未配置");
      problems.push({
        id: "vault",
        severity: "error",
        title: "没有配置 vault 路径",
        detail: "插件不知道去哪里读笔记，所有功能都不可用。",
        fix: "在插件 cordis.patch.yml 的 config.vault 填 Obsidian vault 绝对路径，或设置环境变量 DSH_OBSIDIAN_VAULT，然后重启 DSH。",
      });
    } else {
      try {
        const st = await stat(this.cfg.vault);
        if (!st.isDirectory()) throw new Error("不是目录");
        await access(this.cfg.vault, constants.R_OK);
        vaultOk = true;
        push("vault", true, this.cfg.vault);
      } catch (error) {
        push("vault", false, this.cfg.vault + "（" + String(error && error.message ? error.message : error) + "）");
        problems.push({
          id: "vault",
          severity: "error",
          title: "vault 路径不可用",
          detail: this.cfg.vault + "：" + String(error && error.message ? error.message : error),
          fix: "确认 vault 目录仍然存在且可读（外置磁盘是否挂载、是否被移动），再重启 DSH。",
        });
      }
    }

    // 2. 日记目录
    const journals = normalizeRelDir(this.cfg.journalsDir, "raw/journals");
    const journalsInvalid = this.journalsDirWarning || (journals.ok ? "" : journals.reason);
    if (journalsInvalid) {
      push("journals", false, "配置非法：" + journalsInvalid);
      problems.push({
        id: "journals",
        severity: "warn",
        title: "journalsDir 配置非法，已回退默认值",
        detail: "配置值必须是以 vault 为根的相对目录（不能用绝对路径或 ..）：" + journalsInvalid + "。当前回退为 " + journals.dir + "。",
        fix: "把 config.journalsDir 改成 vault 内的相对目录，例如 raw/journals。",
      });
    } else if (vaultOk) {
      const absJournals = join(this.cfg.vault, journals.dir);
      let exists = true;
      try {
        const st = await stat(absJournals);
        if (!st.isDirectory()) exists = false;
      } catch {
        exists = false;
      }
      if (exists) {
        let writable = true;
        try {
          await access(absJournals, constants.W_OK);
        } catch {
          writable = false;
        }
        push("journals", writable, writable ? journals.dir : journals.dir + "（不可写）");
        if (!writable) {
          problems.push({
            id: "journals",
            severity: "error",
            title: "日记目录不可写",
            detail: absJournals + " 存在但不可写，快速笔记无法保存。",
            fix: "检查该目录权限，或修改 config.journalsDir 指向可写目录。",
          });
        }
      } else {
        let writable = false;
        try {
          await access(this.cfg.vault, constants.W_OK);
          writable = true;
        } catch {
          writable = false;
        }
        push("journals", writable, writable ? journals.dir + "（不存在，保存时会自动创建）" : journals.dir + "（不存在且 vault 不可写）");
        if (writable) {
          info.push({ id: "journals", title: "日记目录尚未创建", detail: "首次保存快速笔记时会自动创建 " + journals.dir });
        } else {
          problems.push({
            id: "journals",
            severity: "error",
            title: "日记目录不可写",
            detail: "vault 不可写，快速笔记无法保存。",
            fix: "检查 vault 目录权限，或换一个有写权限的 vault。",
          });
        }
      }
    }

    // 3. shell API 代际
    const shellGen =
      typeof this.shell?.run === "function"
        ? { generation: "run", label: "shell.run（0.1.x）" }
        : typeof this.shell?.execute === "function"
          ? { generation: "execute", label: "shell.execute（0.2.x）" }
          : { generation: "missing", label: "不可用" };
    if (shellGen.generation === "missing") {
      push("shell", false, shellGen.label);
      problems.push({
        id: "shell",
        severity: "error",
        title: "shell 服务不可用",
        detail: "插件需要 ctx.shell 才能启动 python 扫描进程。",
        fix: "确认 DSH 版本与 profile 完整（shell 插件已加载），或把插件降级到与 DSH 匹配的版本。",
      });
    } else {
      push("shell", true, shellGen.label);
    }

    // 4. python 解释器
    const python = this.cfg.python || "python3";
    const pyProbe = await this.probe("python", shq(python) + " -c " + shq("import sys; print(sys.version.split()[0])"));
    if (pyProbe.ok) {
      push("python", true, python + " " + pyProbe.detail);
    } else {
      push("python", false, python + "：" + pyProbe.detail);
      problems.push({
        id: "python",
        severity: "error",
        title: "python 解释器不可用",
        detail: "扫描需要 " + python + "，当前调用失败：" + pyProbe.detail,
        fix: "确认 python3 在 PATH 上，或把插件 config.python 指向可用的解释器（例如 /opt/homebrew/bin/python3）。",
      });
    }

    // 5. 语义检索（未配置只算 info，不算问题）
    if (!this.cfg.semanticScript) {
      push("semantic", true, "未配置（功能关闭）");
      info.push({
        id: "semantic",
        title: "「找相关笔记」未启用",
        detail: "配置 config.semanticScript（或环境变量 DSH_OBSIDIAN_SEMANTIC）后可用，其余功能不受影响。",
      });
    } else {
      let scriptOk = false;
      try {
        const st = await stat(this.cfg.semanticScript);
        if (!st.isFile()) throw new Error("不是文件");
        await access(this.cfg.semanticScript, constants.R_OK);
        scriptOk = true;
        push("semantic", true, this.cfg.semanticScript);
      } catch (error) {
        push("semantic", false, this.cfg.semanticScript + "（" + String(error && error.message ? error.message : error) + "）");
        problems.push({
          id: "semantic",
          severity: "warn",
          title: "语义检索脚本不存在",
          detail: "配置的路径打不开：" + this.cfg.semanticScript,
          fix: "把 config.semanticScript 改成当前实际脚本路径（例如 ~/.agents/skills/llm-wiki-tana/scripts/semantic_search.py），或清空该配置改用其他功能。",
        });
      }
      if (scriptOk) {
        const semanticPython = this.cfg.semanticPython || python;
        const probe = await this.probe("semantic", shq(semanticPython) + " " + shq(this.cfg.semanticScript) + " status");
        if (probe.ok) {
          push("semantic-python", true, semanticPython);
        } else {
          push("semantic-python", false, semanticPython + "：" + probe.detail);
          problems.push({
            id: "semantic-python",
            severity: "warn",
            title: "语义检索依赖不可用",
            detail:
              "用 " +
              semanticPython +
              " 运行语义脚本失败：" +
              probe.detail +
              "（常见原因：解释器缺 numpy、语义索引未建立、脚本环境已随 Python 升级失效）。",
            fix: "确认 semanticPython 指向带 numpy 的解释器并已建立 .semantic-index；也可以清空 config.semanticScript，面板其余功能不受影响。",
          });
        }
      }
    }

    // 6. 缓存目录可写性
    let cacheOk = false;
    try {
      await access(this.pluginDir, constants.W_OK);
      cacheOk = typeof this.cacheWritable === "function" ? this.cacheWritable() : true;
    } catch {
      cacheOk = false;
    }
    if (cacheOk) {
      push("cache", true, this.pluginDir);
    } else {
      push("cache", false, this.pluginDir);
      problems.push({
        id: "cache",
        severity: "warn",
        title: "插件目录不可写，缓存退化",
        detail: "无法写 " + this.pluginDir + "/.obsbn-cache.json，预计算仍在内存里生效，但重启后丢失。",
        fix: "给插件目录写权限，或接受每次重启后首次打开面板慢一点。",
      });
    }

    return {
      ok: problems.length === 0,
      checkedAt: Date.now(),
      problems,
      info,
      checks,
    };
  }
}
