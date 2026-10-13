import os from 'node:os';
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, readdir, open } from "node:fs/promises";
import path from "node:path";

export const CODE_ROOT = path.resolve(process.env.KNOWLEDGE_AGENT_CODE_ROOT || path.join(os.homedir(), 'Projects'));
export const matchKey = (value) => value.normalize("NFKC").toLowerCase().replace(/[\s-]+/gu, "");
export function repoSlug(directory) {
  const slug = directory.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
  assert(slug, "Directory cannot produce a stable slug");
  return slug;
}

export function tomlName(text, section) {
  let current = "";
  for (const line of text.split(/\r?\n/u)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) { current = header[1].trim(); continue; }
    if (current !== section) continue;
    // Only simple literal names; do not attempt general TOML interpretation.
    const name = line.match(/^\s*name\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/u);
    if (name) return name[1] ?? name[2];
  }
  return null;
}

async function manifestName(repo, filename, warnings) {
  const target = path.join(repo, filename);
  let stat;
  try { stat = await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
    warnings.push({ code: "MANIFEST_SKIPPED", path: target, message: "非普通文件或超过 64KB；未读取" });
    return null;
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const name = filename === "package.json" ? JSON.parse(text).name : tomlName(text, filename === "pyproject.toml" ? "project" : "package");
    return typeof name === "string" && name.trim() && !/[\r\n\0]/u.test(name) ? name.trim() : null;
  } catch (error) {
    warnings.push({ code: "MANIFEST_UNREADABLE", path: target, message: "未取得简单 name 字段；使用目录名" });
    return null;
  } finally { await handle.close(); }
}

export async function discoverCodeProjects() {
  assert(!(await lstat(CODE_ROOT)).isSymbolicLink(), "Code root symlink rejected");
  const projects = [], warnings = [], excluded = [];
  const ids = new Set();
  const children = (await readdir(CODE_ROOT, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    if (child.isSymbolicLink()) { excluded.push({ name: child.name, reason: "symlink; not followed" }); continue; }
    if (!child.isDirectory()) continue;
    const repo = path.join(CODE_ROOT, child.name);
    assert(!(await lstat(repo)).isSymbolicLink(), "Repository changed into symlink");
    let git;
    try { git = await lstat(path.join(repo, ".git")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!git || (!git.isDirectory() && !git.isFile()) || git.isSymbolicLink()) {
      excluded.push({ name: child.name, directory_only: true, reason: "No regular .git directory/file; not a CODE_PROJECT" });
      continue;
    }
    const metadataNames = [];
    for (const filename of ["package.json", "pyproject.toml", "Cargo.toml"]) {
      const name = await manifestName(repo, filename, warnings);
      if (name) metadataNames.push({ file: filename, name });
    }
    const id = repoSlug(child.name);
    assert(!ids.has(id), `Repository slug collision needs review: ${id}`);
    ids.add(id);
    projects.push({ id, name: metadataNames[0]?.name ?? child.name, aliases: [], path: repo, repo_path: repo,
      route_type: "CODE_PROJECT", directory_name: child.name, metadata_names: metadataNames,
      git_marker: git.isDirectory() ? "directory" : "file", knowledge_targets: [] });
  }
  return { projects, warnings, excluded };
}
