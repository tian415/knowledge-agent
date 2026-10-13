import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, encode, json, read, relative, safe, lock, pathKey, hash } from './files.mjs';

export const configPath = '.project-knowledge/config.json';
export const statePath = '.project-knowledge/state.json';
export function load(vault) {
  const config = json(safe(vault, configPath));
  if (config.version !== 1 || typeof config.vaultId !== 'string' || !Array.isArray(config.projects)) throw new Error('配置版本或结构无效');
  const ids = new Set(); const dirs = [];
  for (const p of config.projects) {
    validateProject(p); const key = pathKey(p.directory); if (ids.has(p.id) || dirs.some(d => d === key || d.startsWith(key + '/') || key.startsWith(d + '/'))) throw new Error('项目 ID 或目录重复/重叠');
    ids.add(p.id); dirs.push(key); safe(vault, p.directory); safe(vault, `${p.directory}/${p.dashboard}`);
  }
  return config;
}
function validateProject(p) {
  if (!p || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim()) throw new Error('项目需要稳定英文 id 与非空 name');
  relative(p.directory); relative(p.dashboard);
  if (p.directory.split('/').some(s => s.startsWith('.')) || !p.dashboard.endsWith('.md')) throw new Error('项目目录不可隐藏；总览必须为 Markdown');
}
export function init(vault) {
  if (!fs.statSync(vault).isDirectory()) throw new Error('知识库目录不存在');
  if (read(safe(vault, configPath)) !== null) return load(vault);
  const config = { version: 1, vaultId: randomUUID(), projects: [] };
  atomic(safe(vault, configPath), encode(config)); return config;
}
export function register(vault, project) {
  validateProject(project);
  return lock(vault, () => {
    const config = load(vault); const old = config.projects.find(p => p.id === project.id);
    if (old) { if (JSON.stringify(old) === JSON.stringify(project)) return old; throw new Error('项目已存在且映射不同；请先审阅配置迁移'); }
    const key = pathKey(project.directory);
    if (config.projects.some(p => {const d = pathKey(p.directory); return d === key || d.startsWith(key + '/') || key.startsWith(d + '/');})) throw new Error('项目目录重复/重叠');
    safe(vault, project.directory); safe(vault, `${project.directory}/${project.dashboard}`);
    config.projects.push(project); atomic(safe(vault, configPath), encode(config)); return project;
  });
}
export function pending(vault) {
  const dir = safe(vault, '.project-knowledge/transactions'); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => {
    const j = json(safe(vault, `.project-knowledge/transactions/${n}`));
    if (j.version !== 1 || !['pending','completed'].includes(j.status) || n !== `${j.id}.json` || !j.plan) throw new Error('事务结构损坏');
    const {digest,...plan} = j.plan; if (digest !== hash(plan)) throw new Error('事务内容损坏');
    return j;
  }).filter(j => j.status === 'pending').map(j => j.id);
}
export function doctor(vault) {
  const config = load(vault); const state = read(safe(vault, statePath));
  if (state !== null && (JSON.parse(state).version !== 1 || typeof JSON.parse(state).notes !== 'object')) throw new Error('状态损坏');
  const transactions = pending(vault);
  return { ok: transactions.length === 0 && !fs.existsSync(safe(vault, '.project-knowledge/write.lock')), vault: path.resolve(vault), vaultId: config.vaultId, projects: config.projects, pendingTransactions: transactions, writeLocked: fs.existsSync(safe(vault, '.project-knowledge/write.lock')) };
}
