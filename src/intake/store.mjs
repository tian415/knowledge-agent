import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createMaterial } from './material.mjs';
import { VAULT_PATH } from '../registry/load-registry.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const idPattern = /^mat_[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function requireThat(ok, message, code = 'STATE_CORRUPT') {
  if (!ok) throw Object.assign(new Error(message), { code });
}
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
function materialId(id) { requireThat(typeof id === 'string' && idPattern.test(id), 'Invalid material ID', 'INPUT_INVALID'); return id; }
function attemptId(id) { requireThat(typeof id === 'string' && uuidPattern.test(id), 'Invalid attempt ID', 'INPUT_INVALID'); return id; }
function timestamp(now) {
  requireThat(now instanceof Date && Number.isFinite(now.getTime()), 'Expected valid Date', 'INPUT_INVALID');
  return now.toISOString();
}
const budgetDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
function validateMaterial(value, id) {
  try {
    requireThat(isDeepStrictEqual(createMaterial(value), value) && value.material_id === id, 'Material identity/hash mismatch');
  } catch (error) { throw Object.assign(new Error(`Invalid material: ${error.message}`), { code: 'STATE_CORRUPT' }); }
  return value;
}
// Storage envelope only. Candidate semantics/evidence are validated by the caller, not the store.
function validateResult(value, material) {
  requireThat(object(value) && value.stage === 'PREVIEW_READY' && value.material_id === material.material_id && value.content_hash === material.content_hash, 'Invalid result identity/stage');
  requireThat(Array.isArray(value.knowledge_candidates) && Array.isArray(value.action_candidates) &&
    value.knowledge_candidates.every(object) && value.action_candidates.every(object) &&
    typeof value.markdown === 'string' && value.markdown.length > 0 && object(value.metrics), 'Incomplete result envelope');
  const m = value.metrics;
  requireThat(Number.isInteger(m.sdk_turns) && m.sdk_turns >= 0 && m.sdk_turns <= 1 &&
    Number.isInteger(m.input_bytes) && m.input_bytes >= 0 && Number.isFinite(m.elapsed_ms) && m.elapsed_ms >= 0 &&
    (m.usage === null || object(m.usage)) && m.underlying_model_requests === null, 'Invalid result metrics');
  return value;
}
function validateAttempt(value, id) {
  requireThat(object(value) && value.attempt_id === id && idPattern.test(value.material_id) &&
    ['STARTED', 'COMPLETED', 'FAILED'].includes(value.status), 'Invalid attempt identity/status');
  const date = new Date(value.started_at);
  requireThat(Number.isFinite(date.getTime()) && date.toISOString() === value.started_at && budgetDate(date) === value.budget_date, 'Invalid attempt budget date');
  requireThat(value.status === 'STARTED' ? value.details === null : object(value.details) && value.details.status === value.status, 'Invalid attempt details');
  return value;
}

export async function openStore(dataDir) {
  requireThat(typeof dataDir === 'string' && path.isAbsolute(dataDir), 'dataDir must be absolute', 'UNSAFE_PATH');
  const root = path.resolve(dataDir);
  const forbiddenRoots = [path.resolve(repo), VAULT_PATH];
  // A linked worktree also protects the original checkout, without invoking git or scanning it.
  try {
    const marker = await fs.lstat(path.join(repo, '.git'));
    if (marker.isFile()) {
      const gitPath = path.join(repo, '.git');
    const gitStat = await fs.lstat(gitPath);
    requireThat(!gitStat.isSymbolicLink(), 'Git marker cannot be a symlink', 'UNSAFE_PATH');
    const text = gitStat.isFile() ? await fs.readFile(gitPath, 'utf8') : '';
      const match = /^gitdir: (.+)\n?$/u.exec(text);
      requireThat(match, 'Invalid worktree git marker', 'UNSAFE_PATH');
      const gitDir = path.resolve(repo, match[1]);
      const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
      forbiddenRoots.push(path.dirname(path.resolve(gitDir, common)));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  requireThat(!forbiddenRoots.some(p => inside(p, root)), 'dataDir is inside repo or Vault', 'UNSAFE_PATH');

  async function inspect(target) {
    let current = path.parse(target).root;
    const parts = target.slice(current.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      requireThat(!stat.isSymbolicLink(), `Symlink rejected: ${current}`, 'UNSAFE_PATH');
      if (i < parts.length - 1) requireThat(stat.isDirectory(), `Non-directory ancestor: ${current}`, 'UNSAFE_PATH');
      if (inside(root, current)) {
        requireThat(stat.isDirectory() || (stat.isFile() && stat.nlink === 1), `Unsafe file: ${current}`, 'UNSAFE_PATH');
        requireThat((stat.mode & 0o777) === (stat.isDirectory() ? 0o700 : 0o600), `Unsafe permissions: ${current}`, 'UNSAFE_PATH');
      }
      if (i === parts.length - 1) return stat;
    }
    return fs.lstat(target);
  }
  async function directory(target) {
    requireThat(inside(root, target), 'Directory outside dataDir', 'UNSAFE_PATH');
    const existing = await inspect(target);
    if (existing) { requireThat(existing.isDirectory(), 'Expected directory', 'UNSAFE_PATH'); return; }
    const parent = path.dirname(target);
    if (target !== root) await directory(parent);
    // Do not recursively create arbitrary ancestors outside the private root.
    else requireThat((await inspect(parent))?.isDirectory(), 'dataDir parent must exist', 'UNSAFE_PATH');
    await fs.mkdir(target, { mode: 0o700 });
    requireThat((await inspect(target))?.isDirectory(), 'Directory creation failed', 'UNSAFE_PATH');
  }
  async function read(target) {
    const stat = await inspect(target);
    if (!stat) return null;
    requireThat(stat.isFile() && stat.nlink === 1, 'Expected single-link regular file', 'UNSAFE_PATH');
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      requireThat(current.isFile() && current.nlink === 1 && current.ino === stat.ino && current.dev === stat.dev && (current.mode & 0o777) === 0o600, 'File changed during open', 'UNSAFE_PATH');
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async function json(target) {
    const bytes = await read(target);
    if (bytes === null) return null;
    try { const value = JSON.parse(bytes.toString('utf8')); requireThat(object(value), 'State must be a JSON object'); return value; }
    catch { throw Object.assign(new Error(`Invalid JSON: ${target}`), { code: 'STATE_CORRUPT' }); }
  }
  await directory(root);
  let ownedLock = null;
  const lockPath = path.join(root, 'intake.lock');
  async function locked() {
    requireThat(ownedLock && isDeepStrictEqual(await json(lockPath), ownedLock), 'Store lock not held', 'BUSY');
  }
  async function atomic(target, value, before = null) {
    await locked();
    await directory(path.dirname(target));
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const temp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await locked();
      const current = await read(target);
      requireThat(current === null ? before === null : before !== null && current.equals(before), 'State changed before rename');
      await fs.rename(temp, target);
      const dir = await fs.open(path.dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
      const after = await read(target);
      requireThat(after !== null && after.equals(bytes), 'State read-back mismatch');
    } finally {
      if (handle) await handle.close();
      // Remove only this invocation's temporary file, never corrupt state or stale locks.
      try { await fs.unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const materialFile = id => path.join(root, 'materials', materialId(id), 'material.json');
  const resultFile = id => path.join(root, 'materials', materialId(id), 'result.json');
  async function loadMaterial(id) {
    const value = await json(materialFile(id));
    requireThat(value !== null, 'Material missing');
    return validateMaterial(value, id);
  }
  return {
    async readMaterial(id) { return loadMaterial(id); },
    async listMaterialIds() {
      const dir = path.join(root, 'materials');
      const stat = await inspect(dir);
      if (!stat) return [];
      requireThat(stat.isDirectory(), 'Invalid materials directory');
      const ids = await fs.readdir(dir);
      // Only enumerate names here. Reading each record validates every ancestor,
      // so callers can diagnose one unsafe entry without following its link.
      for (const id of ids) materialId(id);
      return ids.sort();
    },
    async acquireLock() {
      requireThat(!ownedLock, 'Store already holds lock', 'BUSY');
      const stat = await inspect(lockPath);
      if (stat) {
        const old = await json(lockPath);
        throw Object.assign(new Error(`Store busy; lock PID ${old?.pid ?? 'unknown'}; verify process before manual removal`), { code: 'BUSY' });
      }
      const lock = { pid: process.pid, token: randomUUID(), created_at: new Date().toISOString() };
      let handle;
      try { handle = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('Store busy; concurrent lock acquisition'), { code: 'BUSY' }); throw error; }
      try { await handle.writeFile(JSON.stringify(lock)); await handle.sync(); ownedLock = lock; }
      finally { await handle.close(); }
    },
    async releaseLock() {
      if (!ownedLock) return;
      const actual = await json(lockPath);
      if (actual !== null) {
        requireThat(isDeepStrictEqual(actual, ownedLock), 'Lock ownership changed; preserved', 'BUSY');
        await fs.unlink(lockPath);
      }
      ownedLock = null;
    },
    async saveMaterial(material) {
      await locked(); validateMaterial(material, material.material_id);
      const file = materialFile(material.material_id), existing = await json(file);
      if (existing !== null) {
        validateMaterial(existing, material.material_id);
        requireThat(existing.raw_content === material.raw_content, 'Immutable material mismatch');
        return;
      }
      await atomic(file, material);
    },
    async addReceipt(material, receivedAt) {
      await locked(); validateMaterial(material, material.material_id); await loadMaterial(material.material_id);
      const id = randomUUID();
      const { material_id, source_type, source_title, source_url, source_id, captured_at } = material;
      await atomic(path.join(root, 'receipts', `${id}.json`), { receipt_id: id, material_id, source_type, source_title, source_url, source_id, captured_at, received_at: timestamp(receivedAt) });
      return id;
    },
    async readResult(id) {
      const material = await loadMaterial(id);
      const value = await json(resultFile(id));
      return value === null ? null : validateResult(value, material);
    },
    async saveResult(id, result) {
      await locked(); const material = await loadMaterial(id); validateResult(result, material);
      const file = resultFile(id), existing = await json(file);
      if (existing !== null) {
        validateResult(existing, material);
        requireThat(isDeepStrictEqual(existing, result), 'Successful result already exists'); return;
      }
      await atomic(file, result);
    },
    async beginAttempt(id, now) {
      await locked(); await loadMaterial(id); const started_at = timestamp(now), attempt_id = randomUUID();
      await atomic(path.join(root, 'attempts', `${attempt_id}.json`), { attempt_id, material_id: id, started_at, budget_date: budgetDate(now), status: 'STARTED', details: null });
      return attempt_id;
    },
    async finishAttempt(id, details) {
      await locked(); attemptId(id);
      requireThat(object(details) && ['COMPLETED', 'FAILED'].includes(details.status), 'Invalid attempt completion', 'INPUT_INVALID');
      const file = path.join(root, 'attempts', `${id}.json`), before = await read(file);
      requireThat(before !== null, 'Attempt missing');
      const value = validateAttempt(await json(file), id);
      const updated = { ...value, status: details.status, details };
      if (value.status !== 'STARTED') { requireThat(isDeepStrictEqual(value, updated), 'Attempt already finished'); return; }
      await atomic(file, updated, before);
    },
  };
}
