import os from 'node:os';
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ROOT, discoverCodeProjects, matchKey } from "./discover-code-projects.mjs";

export const VAULT_PATH = path.resolve(process.env.KNOWLEDGE_AGENT_VAULT_ROOT || path.join(os.homedir(), 'Documents', 'KnowledgeVault'));
export const LEGACY_CONFIG_PATH = path.join(VAULT_PATH, ".project-knowledge/config.json");
const projectPath = fileURLToPath(new URL("../../", import.meta.url));
const overridesPath = path.join(projectPath, "config/registry-overrides.json");
export const ROUTE_GROUPS = {
  CODE_PROJECT: "code_projects",
  KNOWLEDGE_PROJECT: "knowledge_projects",
  TOPIC: "topics",
};
const has = (object, key) => Object.hasOwn(object, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Declarative contract for future Router integration; no routing is executed here.
export const REGISTRY_POLICY = {
  status: { active: "当前持续推进或积累，正常参与路由", reference: "历史参考；仅聊天明确属于它时匹配",
    legacy: "默认不接收新相关聊天；明确研究旧系统本身时仍允许匹配" },
  supersession: "legacy 有 superseded_by 且新聊天明显属于新系统时优先新系统；明确复盘旧系统仍归旧项目",
  examples: { "新的 ChatGPT → Obsidian 自动化讨论": "knowledge-agent", "复盘旧项目知识工作流的历史实现": "project-knowledge" },
  manual_overrides: "只保存已人工确认的事实，不是所有项目必须人工维护的主 Registry；人工事实优先于机器推测",
  future_design: "Auto Discovery + Auto Registry + Manual Overrides；新 repo 自动发现，聊天可形成 Candidate 并自动建议晋升，活跃度可自动维护，仅高风险或歧义进入 Review Queue；本阶段不实现这些自动化",
};
const STATUSES = ["active", "reference", "legacy"];
function validateMetadata(extra) {
  if (has(extra, "status")) assert(STATUSES.includes(extra.status), "Invalid status");
  if (has(extra, "superseded_by")) {
    assert(extra.superseded_by === null || (typeof extra.superseded_by === "string" && extra.superseded_by.trim()), "Invalid superseded_by");
    if (extra.superseded_by !== null) assert.equal(extra.status, "legacy", "Only legacy entities can be superseded");
  }
  if (has(extra, "description")) assert.equal(typeof extra.description, "string");
}
function lifecycle(extra) {
  return { status: extra.status ?? "active", superseded_by: extra.superseded_by ?? null,
    ...(extra.description ? { description: extra.description } : {}) };
}

export function validateLifecycle(registry) {
  const entries = Object.values(registry).flat();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    validateMetadata(entry);
    const visited = new Set([entry.id]);
    let next = entry.superseded_by;
    while (next) {
      assert(byId.has(next), `Unknown superseded_by: ${next}`);
      assert(!visited.has(next), "Supersession cycle or self-reference");
      visited.add(next);
      next = byId.get(next).superseded_by;
    }
  }
}

export function normalizeVaultPath(value) {
  assert(typeof value === "string" && value.trim() && !/[\\\0]/u.test(value), "Invalid Vault path");
  assert(!path.win32.isAbsolute(value) || path.posix.isAbsolute(value), "Windows absolute path rejected");
  const absolute = path.resolve(VAULT_PATH, value);
  const relative = path.relative(VAULT_PATH, absolute);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative), "Path escapes Vault or targets its root");
  return relative;
}

// Metadata checks only; never follow symlinks, list directories, or read Markdown.
export async function checkVaultPath(relative, expectedType = "directory") {
  const normalized = normalizeVaultPath(relative);
  let target = VAULT_PATH;
  let rootStat;
  try { rootStat = await lstat(target); }
  catch (error) {
    if (error.code === "ENOENT") return { code: "PATH_MISSING", path: normalized, message: "Vault 尚未配置或不存在；未创建或修复" };
    throw error;
  }
  assert(!rootStat.isSymbolicLink(), "Vault root symlink rejected");
  assert(rootStat.isDirectory(), "Vault root must be a directory");
  const parts = normalized.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    let stat;
    try { stat = await lstat(target); }
    catch (error) {
      if (error.code === "ENOENT") return { code: "PATH_MISSING", path: normalized, message: "路径不存在；未创建或修复" };
      throw error;
    }
    assert(!stat.isSymbolicLink(), `Symlink rejected: ${normalized}`);
    const shouldBeDirectory = index < parts.length - 1 || expectedType === "directory";
    if (!(shouldBeDirectory ? stat.isDirectory() : stat.isFile())) {
      return { code: "PATH_TYPE_MISMATCH", path: normalized, message: "目标类型不符；未修改" };
    }
  }
  return null;
}

export async function readLegacyConfig() {
  assert.equal(await checkVaultPath(".project-knowledge/config.json", "file"), null, "Legacy config unavailable");
  const handle = await open(LEGACY_CONFIG_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size <= 1024 * 1024, "Legacy config exceeds size limit");
    const bytes = await handle.readFile();
    return { config: JSON.parse(bytes.toString("utf8")), bytes,
      metadata: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev } };
  } finally { await handle.close(); }
}

export function mergeRegistry(legacy, overrides) {
  assert(isObject(legacy) && legacy.version === 1 && Array.isArray(legacy.projects), "Unsupported legacy schema");
  assert(isObject(overrides) && isObject(overrides.projects) && isObject(overrides.topics), "Invalid overrides");
  assert(Object.keys(overrides).every((key) => ["projects", "topics", "code_projects"].includes(key)), "Unknown override section");
  assert(isObject(overrides.code_projects ?? {}), "Invalid code overrides");
  for (const extra of Object.values(overrides.code_projects ?? {})) {
    assert(isObject(extra) && Object.keys(extra).every((key) => ["route_type", "status", "superseded_by", "description"].includes(key)), "Invalid code metadata override");
    if (has(extra, "route_type")) assert.equal(extra.route_type, "CODE_PROJECT");
    validateMetadata(extra);
  }
  const legacyIds = new Set();
  for (const entry of legacy.projects) {
    assert(isObject(entry) && typeof entry.id === "string" && entry.id.trim() &&
      typeof entry.name === "string" && entry.name.trim(), "Invalid legacy identity");
    assert(!legacyIds.has(entry.id), `Duplicate legacy id: ${entry.id}`);
    legacyIds.add(entry.id);
  }
  // Both namespaces are metadata overlays keyed by existing legacy id, not new project lists.
  for (const [group, entries] of Object.entries({ projects: overrides.projects, topics: overrides.topics })) {
    for (const [id, extra] of Object.entries(entries)) {
      assert(legacyIds.has(id), `Override references unknown legacy id: ${id}`);
      assert(!(has(overrides.projects, id) && has(overrides.topics, id)), `Duplicate override: ${id}`);
      assert(isObject(extra) && Object.keys(extra).every((key) =>
        ["route_type", "aliases", "router_id", "review_required", "code_project_id", "source_paths", "status", "superseded_by", "description"].includes(key)), "Overrides cannot replace legacy name or path");
      validateMetadata(extra);
      if (has(extra, "route_type")) assert(has(ROUTE_GROUPS, extra.route_type), "Invalid route_type");
      if (group === "topics" && has(extra, "route_type")) assert.equal(extra.route_type, "TOPIC");
      if (has(extra, "aliases")) assert(Array.isArray(extra.aliases) && extra.aliases.every((alias) => typeof alias === "string" && alias.trim()), "Invalid aliases");
      if (has(extra, "review_required")) assert.equal(typeof extra.review_required, "boolean");
      if (has(extra, "router_id")) assert(typeof extra.router_id === "string" && extra.router_id.trim(), "Invalid router_id");
      if (has(extra, "code_project_id")) assert(typeof extra.code_project_id === "string" && extra.code_project_id.trim(), "Invalid code_project_id");
      if (has(extra, "source_paths")) assert(Array.isArray(extra.source_paths) && extra.source_paths.every((source) =>
        typeof source === "string" && path.isAbsolute(source) && path.dirname(path.resolve(source)) === CODE_ROOT), "Source paths must be direct local learning directories");
    }
  }
  const registry = { code_projects: [], knowledge_projects: [], topics: [] };
  const warnings = [];
  const ids = new Set();
  for (const entry of legacy.projects) {
    const extra = has(overrides.projects, entry.id) ? overrides.projects[entry.id] :
      has(overrides.topics, entry.id) ? overrides.topics[entry.id] : {};
    const explicitType = extra.route_type ?? (has(overrides.topics, entry.id) ? "TOPIC" : null);
    const routeType = explicitType ?? "KNOWLEDGE_PROJECT";
    const id = extra.router_id ?? entry.id;
    assert(!ids.has(id), `Duplicate Router id: ${id}`);
    ids.add(id);
    const directory = normalizeVaultPath(entry.directory);
    assert(typeof entry.dashboard === "string" && entry.dashboard && !path.isAbsolute(entry.dashboard) &&
      !entry.dashboard.includes("\\") && !entry.dashboard.split("/").includes(".."), "Invalid legacy dashboard");
    const dashboard = normalizeVaultPath(path.join(directory, entry.dashboard));
    const review = !explicitType || extra.review_required === true;
    registry[ROUTE_GROUPS[routeType]].push({ id, legacy_id: entry.id, name: entry.name,
      aliases: [...new Set(extra.aliases ?? [])], path: directory, route_type: routeType, ...lifecycle(extra),
      dashboard, review_required: review, source_paths: (extra.source_paths ?? []).map((source) => path.resolve(source)),
      ...(extra.code_project_id ? { code_project_id: extra.code_project_id } : {}) });
    if (review) warnings.push({ code: "TYPE_REVIEW_REQUIRED", legacy_id: entry.id,
      message: explicitType ? "类型仍需后续确认" : "类型未确认；暂按 KNOWLEDGE_PROJECT，不推断代码仓库或主题归属" });
  }
  return { registry, warnings, legacy_project_count: legacy.projects.length,
    code_overrides: overrides.code_projects ?? {}, registry_policy: REGISTRY_POLICY };
}

export function unifyRegistry(legacy, discovery) {
  // Registry principle: folder location is only supporting evidence. Confirmed learning,
  // research and Agent-tool experiments remain knowledge projects/topics; only actual
  // software repositories/projects are CODE_PROJECT. Human classification takes priority.
  const learningSources = new Set(Object.values(legacy.registry).flat()
    .filter((entry) => !entry.review_required && entry.route_type !== "CODE_PROJECT")
    .flatMap((entry) => entry.source_paths ?? []));
  const registry = { code_projects: structuredClone(discovery.projects.filter((entry) => !learningSources.has(entry.repo_path))), knowledge_projects: [], topics: [] };
  for (const entry of registry.code_projects) Object.assign(entry, lifecycle(legacy.code_overrides?.[entry.id] ?? {}));
  const auto_merged = [], explicit_merged = [], potential_matches = [], legacy_entities = [];
  const warnings = [...discovery.warnings];
  for (const id of Object.keys(legacy.code_overrides ?? {})) {
    if (!registry.code_projects.some((entry) => entry.id === id)) warnings.push({ code: "CODE_OVERRIDE_NOT_DISCOVERED", message: `已确认代码项目当前未发现：${id}` });
  }
  const legacyEntries = Object.values(legacy.registry).flat();
  const codeKeys = (code) => [code.id, code.name, code.directory_name, ...(code.metadata_names ?? []).map((entry) => entry.name)].filter(Boolean).map(matchKey);
  for (const original of legacyEntries) {
    const entry = structuredClone(original);
    const keys = [entry.id, entry.legacy_id, entry.name, path.basename(entry.path)].map(matchKey);
    const exact = registry.code_projects.filter((code) => codeKeys(code).some((key) => keys.includes(key)));
    let target;
    if (entry.code_project_id) {
      target = registry.code_projects.find((code) => code.id === entry.code_project_id);
      assert(target, `Explicit code mapping not discovered: ${entry.code_project_id}`);
    } else if (entry.route_type !== "TOPIC" && (entry.review_required || entry.route_type === "CODE_PROJECT") && exact.length === 1) target = exact[0];
    if (target) {
      target.knowledge_targets.push({ legacy_id: entry.legacy_id, name: entry.name, path: entry.path, dashboard: entry.dashboard, ...lifecycle(entry) });
      // Only aliases explicitly configured by the user are propagated.
      target.aliases = [...new Set([...target.aliases, ...entry.aliases])];
      const match = { legacy_id: entry.legacy_id, legacy_name: entry.name, code_id: target.id, code_name: target.name };
      (entry.code_project_id ? explicit_merged : auto_merged).push(match);
      legacy_entities.push({ ...match, route_type: "CODE_PROJECT", review_required: false });
      continue;
    }
    // A prefix relation only raises a review candidate; never adds an alias or merges.
    const potential = registry.code_projects.filter((code) => codeKeys(code).some((key) =>
      keys.some((other) => Math.min(key.length, other.length) >= 4 && (key.startsWith(other) || other.startsWith(key)))));
    for (const code of potential) potential_matches.push({ legacy_id: entry.legacy_id, legacy_name: entry.name,
      code_id: code.id, code_name: code.name, directory_name: code.directory_name, is_code_project: true, review_required: true });
    const directoryCandidates = discovery.excluded.filter((candidate) => candidate.directory_only &&
      !(entry.source_paths ?? []).includes(path.join(CODE_ROOT, candidate.name)) &&
      keys.some((key) => {
        const other = matchKey(candidate.name);
        return Math.min(key.length, other.length) >= 4 && (key.startsWith(other) || other.startsWith(key));
      }));
    for (const candidate of directoryCandidates) potential_matches.push({ legacy_id: entry.legacy_id, legacy_name: entry.name,
      code_id: null, code_name: null, directory_name: candidate.name, is_code_project: false,
      reason: "仅目录名称候选，没有 .git，不注册为 CODE_PROJECT", review_required: true });
    if (potential.length || directoryCandidates.length) entry.review_required = true;
    if (entry.route_type === "CODE_PROJECT") {
      entry.route_type = "KNOWLEDGE_PROJECT";
      entry.review_required = true;
      warnings.push({ code: "UNCONFIRMED_CODE_PROJECT", legacy_id: entry.legacy_id, message: "没有唯一的 Git repo 对应，保留为待确认知识项目" });
    }
    if (registry.code_projects.some((code) => code.id === entry.id)) {
      entry.id = `legacy:${entry.legacy_id}`;
      entry.review_required = true;
      warnings.push({ code: "ID_COLLISION_REVIEW", legacy_id: entry.legacy_id, message: "未确认同一实体，使用 legacy 命名空间避免重复 ID" });
    }
    registry[ROUTE_GROUPS[entry.route_type]].push(entry);
    legacy_entities.push({ legacy_id: entry.legacy_id, legacy_name: entry.name, route_type: entry.route_type,
      review_required: entry.review_required });
  }
  const mergedIds = new Set([...auto_merged, ...explicit_merged].map((entry) => entry.legacy_id));
  warnings.push(...legacy.warnings.filter((warning) => warning.code !== "TYPE_REVIEW_REQUIRED" || !mergedIds.has(warning.legacy_id)));
  const ids = Object.values(registry).flat().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "Unified Registry ID collision");
  validateLifecycle(registry);
  return { registry, warnings, legacy_project_count: legacy.legacy_project_count, auto_merged, explicit_merged,
    potential_matches, legacy_entities, review_required: legacy_entities.filter((entry) => entry.review_required), excluded: discovery.excluded,
    registry_policy: REGISTRY_POLICY };
}

export async function loadRegistry({ includeCodeProjects = true } = {}) {
  const { config } = await readLegacyConfig();
  assert(!(await lstat(path.join(projectPath, "config"))).isSymbolicLink(), "Overrides directory symlink rejected");
  const handle = await open(overridesPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let overrides;
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size <= 1024 * 1024, "Invalid overrides file");
    overrides = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  const result = mergeRegistry(config, overrides);
  for (const entry of Object.values(result.registry).flat()) {
    for (const [target, type] of [[entry.path, "directory"], [entry.dashboard, "file"]]) {
      const warning = await checkVaultPath(target, type);
      if (warning) result.warnings.push({ ...warning, legacy_id: entry.legacy_id });
    }
  }
  return includeCodeProjects ? unifyRegistry(result, await discoverCodeProjects()) : result;
}
