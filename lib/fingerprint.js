// dsh-obsidian-assistant — vault 指纹。
//
// 目的：判断「上次扫描之后 vault 有没有变过」。这是两级过滤里的第一级：
// 只用 stat（路径 + mtime + size）算一个指纹，不读文件内容，比全库重读便宜
// 一个数量级（本机 1.1 万篇实测约 200ms，python 全读约 0.4~1.2s）。
//
// 目录与文件过滤规则必须与 lib/scan.js 里的 python 扫描保持一致，否则会出现
// 「指纹说没变、扫描其实漏读了文件」的假命中。
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** 扫描时跳过的目录名，与 python 侧 skip_dirs 保持一致。 */
const SKIP_DIRS = new Set([".obsidian", ".git", ".semantic-index", ".trash", "node_modules"]);

/** 安全上限：恶意或异常大的 vault 不至于把指纹计算拖死。 */
const MAX_FILES = 200000;

/**
 * 递归收集 vault 内所有 .md 相对路径（不读内容）。
 * @param {string} vault vault 绝对路径
 * @param {{skipWikiSubdirs?: string[]}} options 跳过 wiki 子目录（与 today 扫描一致）
 * @returns {Promise<string[]>} 排序后的相对路径
 */
async function collectMarkdown(vault, options = {}) {
  const skipPrefixes = (options.skipWikiSubdirs || ["lint"]).map((d) => "wiki/" + String(d).replace(/^\/+|\/+$/g, "") + "/");
  const files = [];

  async function walk(absDir, relDir) {
    let dir;
    try {
      dir = await opendir(absDir);
    } catch {
      return;
    }
    for await (const entry of dir) {
      if (files.length >= MAX_FILES) return;
      const rel = relDir ? relDir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(absDir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (skipPrefixes.some((prefix) => rel.startsWith(prefix))) continue;
        files.push(rel);
      }
    }
  }

  await walk(vault, "");
  files.sort();
  return files;
}

/**
 * 计算 vault 指纹。
 * @param {string} vault vault 绝对路径
 * @param {{skipWikiSubdirs?: string[]}} options
 * @returns {Promise<{sig: string, files: number, bytes: number, truncated: boolean}>}
 */
export async function vaultFingerprint(vault, options = {}) {
  const files = await collectMarkdown(vault, options);
  const hash = createHash("sha1");
  let bytes = 0;
  for (const rel of files) {
    let st;
    try {
      st = await stat(join(vault, rel));
    } catch {
      continue;
    }
    bytes += st.size;
    hash.update(rel);
    hash.update("\0");
    hash.update(String(st.mtimeMs));
    hash.update("\0");
    hash.update(String(st.size));
    hash.update("\n");
  }
  return {
    sig: hash.digest("hex"),
    files: files.length,
    bytes,
    truncated: files.length >= MAX_FILES,
  };
}
