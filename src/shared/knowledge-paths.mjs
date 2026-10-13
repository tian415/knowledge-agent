import assert from "node:assert/strict";
import path from "node:path";

export const PREFIXES = { PROJECT_KNOWLEDGE: "01-项目沉淀/", ENGINEERING_THINKING: "02-方法论/工程思维/", PRODUCT_THINKING: "02-方法论/产品思维/", GENERAL_KNOWLEDGE: "03-长期知识/" };
const forbidden = new Set(["附件", "模板", "90-系统", ".obsidian", ".project-knowledge"]);

export function safeRelative(value, layer) {
  assert(typeof value === "string" && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0"), "Invalid path");
  const parts = value.split("/");
  assert(!parts.some((part) => part === ".." || forbidden.has(part)), "Forbidden path component");
  const normalized = path.posix.normalize(value);
  assert(PREFIXES[layer] && normalized.startsWith(PREFIXES[layer]) && normalized.endsWith(".md"), "Wrong knowledge layer path");
  assert.equal(normalized, value, "Use canonical relative paths");
  return normalized;
}
