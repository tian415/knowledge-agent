import fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { openStore } from '../intake/store.mjs';
import { safeRelative } from '../shared/knowledge-paths.mjs';
import { managedTopicBlock, renderManagedTopic, replaceManagedTopic, adoptManagedTopic } from './managed-topic.mjs';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const managedOperation = value => ['managed-topic','managed-topic-adopt'].includes(value);
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LAYERS = new Set(['PROJECT_KNOWLEDGE', 'ENGINEERING_THINKING', 'PRODUCT_THINKING', 'GENERAL_KNOWLEDGE']);
const PLAN_DIR_NAME = path.join('knowledge-apply', 'plans');
const STATUS = new Set(['PREPARED', 'APPLIED', 'PARTIAL', 'ROLLED_BACK']);
const CHANGE_STATUS = new Set(['PENDING', 'APPLIED', 'CONFLICT', 'ROLLED_BACK']);

const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export function knowledgeReviewHash(plan) {
  const summary = {
    id: plan.id,
    material_id: plan.material_id,
    vault_root: plan.vault_root,
    changes: (plan.changes || []).map(({ knowledge_layer, relative_path, content, candidate_ids,
      before, before_hash, after, after_hash, operation, managed_key, expected_before_hash, source_plan_id, source_content_hash }) => ({ knowledge_layer, relative_path, content, candidate_ids,
      before, before_hash, after, after_hash, ...(operation === undefined ? {} : { operation, managed_key, ...(expected_before_hash === undefined ? {} : { expected_before_hash }), ...(source_plan_id === undefined ? {} : { source_plan_id }), ...(source_content_hash === undefined ? {} : { source_content_hash }) }) })),
  };
  return hash(Buffer.from(JSON.stringify(summary), 'utf8'));
}

function fail(message, code = 'INPUT_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function requireThat(condition, message, code = 'INPUT_INVALID') {
  if (!condition) fail(message, code);
}

function serialError(error) {
  return { code: error?.code || 'APPLY_ERROR', message: String(error?.message || error) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateMaterialId(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !value.includes('/') && !value.includes('\\') && !value.includes('\0'), 'Invalid materialId');
  return value;
}

function validatePlanId(value) {
  requireThat(typeof value === 'string' && PLAN_ID.test(value), 'Invalid planId');
  return value;
}

async function lstatOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertNoSymlinkAncestors(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    requireThat(stat && !stat.isSymbolicLink(), `Symlink ancestor rejected: ${current}`, 'UNSAFE_PATH');
  }
}

async function assertVaultRoot(vaultRoot, dataDir) {
  requireThat(typeof vaultRoot === 'string' && path.isAbsolute(vaultRoot), 'vaultRoot must be absolute', 'UNSAFE_PATH');
  const root = path.resolve(vaultRoot);
  const data = path.resolve(dataDir);
  const sensitive = new Set(['/','/private','/tmp','/private/tmp','/var','/private/var','/etc','/System','/Users','/Applications','/Library']);
  requireThat(!sensitive.has(root), 'Sensitive system root rejected', 'UNSAFE_PATH');
  const protectedRoots = [CODE_ROOT];
  try {
    const gitPath = path.join(CODE_ROOT, '.git');
    const gitStat = await fs.lstat(gitPath);
    requireThat(!gitStat.isSymbolicLink(), 'Git marker cannot be a symlink', 'UNSAFE_PATH');
    const marker = gitStat.isFile() ? await fs.readFile(gitPath, 'utf8') : '';
    const match = /^gitdir: (.+)$/u.exec(marker.trim());
    if (match) {
      const gitDir = path.resolve(CODE_ROOT, match[1]);
      const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
      protectedRoots.push(path.dirname(path.resolve(gitDir, commonDir)));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  requireThat(!protectedRoots.some(protectedRoot => inside(protectedRoot, root) || inside(root, protectedRoot)), 'vaultRoot overlaps code root', 'UNSAFE_PATH');
  requireThat(!inside(data, root) && !inside(root, data), 'vaultRoot overlaps dataDir', 'UNSAFE_PATH');
  await assertNoSymlinkAncestors(root);
  const stat = await lstatOrNull(root);
  requireThat(stat?.isDirectory() && !stat.isSymbolicLink(), 'vaultRoot must be an existing real directory', 'UNSAFE_PATH');
  return root;
}

async function inspectVaultTarget(vaultRoot, target) {
  requireThat(inside(vaultRoot, target), 'Target outside vaultRoot', 'UNSAFE_PATH');
  const rootStat = await lstatOrNull(vaultRoot);
  requireThat(rootStat?.isDirectory() && !rootStat.isSymbolicLink(), 'Vault root changed', 'UNSAFE_PATH');
  const relative = path.relative(vaultRoot, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = vaultRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await lstatOrNull(current);
    if (!stat) {
      return { exists: false, parent: path.dirname(target) };
    }
    requireThat(!stat.isSymbolicLink(), 'Symlink ancestor or target rejected', 'UNSAFE_PATH');
    if (index < parts.length - 1) requireThat(stat.isDirectory(), 'Target ancestor is not a directory', 'UNSAFE_PATH');
    else requireThat(stat.isFile() && stat.nlink === 1, 'Target must be a single-link regular file', 'UNSAFE_PATH');
  }
  return { exists: true, stat: rootStat };
}

async function readVaultTarget(vaultRoot, target) {
  const inspected = await inspectVaultTarget(vaultRoot, target);
  if (!inspected.exists) return null;
  let handle;
  try { handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const opened = await handle.stat();
    requireThat(opened.isFile() && opened.nlink === 1, 'Target changed to unsafe file', 'UNSAFE_PATH');
    const bytes = await handle.readFile();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('Target is not valid UTF-8', 'UNSAFE_PATH'); }
    requireThat(Buffer.from(text, 'utf8').equals(bytes), 'Target UTF-8 is not canonical', 'UNSAFE_PATH');
    return { text, bytes, hash: hash(bytes), dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777 };
  } finally { await handle.close(); }
}

async function mkdirVaultParents(vaultRoot, target) {
  requireThat(inside(vaultRoot, target), 'Target parent outside vaultRoot', 'UNSAFE_PATH');
  const relative = path.relative(vaultRoot, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = vaultRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (stat) {
      requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'Target parent is unsafe', 'UNSAFE_PATH');
      continue;
    }
    await fs.mkdir(current, { mode: 0o700 });
    const made = await lstatOrNull(current);
    requireThat(made?.isDirectory() && !made.isSymbolicLink(), 'Target parent creation failed', 'UNSAFE_PATH');
  }
}

async function ensureDataDirectory(dataRoot, target) {
  requireThat(inside(dataRoot, target), 'Private state path escaped dataDir', 'UNSAFE_PATH');
  const relative = path.relative(dataRoot, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = dataRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await lstatOrNull(current);
    if (!stat) {
      requireThat(index === parts.length - 1, 'Private state parent missing', 'STATE_CORRUPT');
      return null;
    }
    requireThat(!stat.isSymbolicLink(), 'Private state symlink rejected', 'UNSAFE_PATH');
    if (index < parts.length - 1) requireThat(stat.isDirectory(), 'Private state ancestor is not a directory', 'STATE_CORRUPT');
    else requireThat(stat.isFile() && stat.nlink === 1, 'Private state file unsafe', 'STATE_CORRUPT');
  }
  return true;
}

async function mkdirPrivate(dataRoot, target) {
  requireThat(inside(dataRoot, target), 'Private directory escaped dataDir', 'UNSAFE_PATH');
  const relative = path.relative(dataRoot, target);
  const parts = relative ? relative.split(path.sep) : [];
  let current = dataRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (stat) {
      requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700, 'Private directory unsafe', 'UNSAFE_PATH');
      continue;
    }
    await fs.mkdir(current, { mode: 0o700 });
    const made = await lstatOrNull(current);
    requireThat(made?.isDirectory() && !made.isSymbolicLink(), 'Private directory creation failed', 'STATE_CORRUPT');
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, C.O_RDONLY | C.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeVaultAtomically(vaultRoot, target, expected, after) {
  const current = await readVaultTarget(vaultRoot, target);
  if (expected === null) requireThat(current === null, 'Target changed since preparation', 'CONFLICT');
  else requireThat(current?.hash === expected.hash && current.text === expected.text, 'Target changed since preparation', 'CONFLICT');
  await mkdirVaultParents(vaultRoot, path.dirname(target));
  const parentStat = await lstatOrNull(path.dirname(target));
  requireThat(parentStat?.isDirectory() && !parentStat.isSymbolicLink(), 'Target parent is unsafe', 'UNSAFE_PATH');
  const mode = expected?.mode || 0o600;
  const temp = path.join(path.dirname(target), `.${randomUUID()}.knowledge.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    const bytes = Buffer.from(after, 'utf8');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const checked = await readVaultTarget(vaultRoot, target);
    if (expected === null) requireThat(checked === null, 'Target changed during write', 'CONFLICT');
    else requireThat(checked?.hash === expected.hash && checked.text === expected.text, 'Target changed during write', 'CONFLICT');
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
    const result = await readVaultTarget(vaultRoot, target);
    requireThat(result?.hash === hash(bytes) && result.text === after, 'Vault read-back mismatch', 'WRITE_FAILED');
    return result;
  } finally {
    if (handle) await handle.close();
    try { await fs.unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function deleteCreatedFile(vaultRoot, target, afterHash) {
  const current = await readVaultTarget(vaultRoot, target);
  requireThat(current?.hash === afterHash, 'Created target changed; refusing delete', 'CONFLICT');
  const stat = await lstatOrNull(target);
  requireThat(stat?.isFile() && stat.nlink === 1 && !stat.isSymbolicLink(), 'Created target is unsafe', 'UNSAFE_PATH');
  await fs.unlink(target);
  await syncDirectory(path.dirname(target));
  requireThat(await readVaultTarget(vaultRoot, target) === null, 'Delete read-back failed', 'WRITE_FAILED');
}

function validateChange(raw) {
  requireThat(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid change');
  requireThat(LAYERS.has(raw.knowledge_layer), 'Invalid knowledge layer');
  let relative_path;
  try { relative_path = safeRelative(raw.relative_path, raw.knowledge_layer); }
  catch { fail('Invalid knowledge path', 'UNSAFE_PATH'); }
  requireThat(typeof raw.content === 'string' && raw.content.length > 0, 'content must be a non-empty string');
  requireThat(Array.isArray(raw.candidate_ids) && raw.candidate_ids.every(id => typeof id === 'string' && id.length > 0), 'Invalid candidate_ids');
  if(raw.operation==='reviewed-merge'){
    requireThat(!raw.content.includes('<!-- knowledge-agent:topic:')&&!raw.content.includes('<!-- pk:'),'Reviewed merge cannot introduce ownership markers');
    requireThat(raw.managed_key===undefined&&raw.source_plan_id===undefined,'Reviewed merge cannot claim managed ownership');
    requireThat([raw.expected_before_hash,raw.source_content_hash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v)),'Reviewed merge requires baseline and source hashes');
  } else if (raw.operation !== undefined) {
    requireThat(managedOperation(raw.operation), 'Invalid operation');
    if (raw.operation === 'managed-topic-adopt') requireThat(typeof raw.expected_before_hash === 'string' && /^[a-f0-9]{64}$/u.test(raw.expected_before_hash), 'Initial append requires the reviewed target hash');
    else requireThat(raw.expected_before_hash === undefined, 'Initial hash requires explicit initialization');
    if(raw.operation==='managed-topic-adopt') requireThat(typeof raw.source_plan_id==='string'&&PLAN_ID.test(raw.source_plan_id),'Adoption requires a saved append receipt');
    else requireThat(raw.source_plan_id===undefined,'Receipt requires explicit adoption');
    renderManagedTopic(raw.managed_key, raw.content);
  } else requireThat(raw.managed_key === undefined && raw.expected_before_hash === undefined && raw.source_plan_id === undefined, 'managed metadata requires an operation');
  return { knowledge_layer: raw.knowledge_layer, relative_path, content: raw.content, candidate_ids: [...raw.candidate_ids],
    ...(raw.operation === undefined ? {} : { operation: raw.operation, managed_key: raw.managed_key, ...(raw.expected_before_hash === undefined ? {} : {expected_before_hash:raw.expected_before_hash}), ...(raw.source_plan_id === undefined ? {} : {source_plan_id:raw.source_plan_id}), ...(raw.source_content_hash === undefined ? {} : {source_content_hash:raw.source_content_hash}) }) };
}

function validatePlan(value) {
  requireThat(value && typeof value === 'object' && PLAN_ID.test(value.id), 'Invalid knowledge plan', 'STATE_CORRUPT');
  requireThat(typeof value.material_id === 'string' && value.material_id.length > 0 &&
    typeof value.vault_root === 'string' && path.isAbsolute(value.vault_root) &&
    STATUS.has(value.status) && Array.isArray(value.changes) && value.changes.length > 0, 'Invalid knowledge plan status', 'STATE_CORRUPT');
  for (const change of value.changes) {
    requireThat(change && LAYERS.has(change.knowledge_layer) && typeof change.relative_path === 'string' &&
      CHANGE_STATUS.has(change.status) && typeof change.content === 'string' && Array.isArray(change.candidate_ids) &&
      change.candidate_ids.every(id => typeof id === 'string') && typeof change.after === 'string' &&
      typeof change.after_hash === 'string' && /^[a-f0-9]{64}$/u.test(change.after_hash) &&
      (change.before === null || typeof change.before === 'string') &&
      (change.before_hash === null || /^[a-f0-9]{64}$/u.test(change.before_hash)), 'Invalid knowledge plan change', 'STATE_CORRUPT');
    try { safeRelative(change.relative_path, change.knowledge_layer); }
    catch { fail('Invalid knowledge plan path', 'STATE_CORRUPT'); }
    const expectedBeforeHash = change.before === null ? null : hash(Buffer.from(change.before, 'utf8'));
    let expectedAfter;
    try {
      validateChange(change);
      if (['managed-topic-adopt','reviewed-merge'].includes(change.operation)) requireThat(change.expected_before_hash === expectedBeforeHash, 'Initial snapshot mismatch');
      expectedAfter = change.operation === 'reviewed-merge' ? change.content : change.operation === 'managed-topic-adopt' ? adoptManagedTopic(change.before,change.managed_key,change.content) : change.operation === 'managed-topic' ? replaceManagedTopic(change.before, change.managed_key, change.content) : `${change.before ?? ''}${change.content}`;
    } catch { fail('Invalid managed change', 'STATE_CORRUPT'); }
    requireThat(change.before_hash === expectedBeforeHash && change.after === expectedAfter &&
      change.after_hash === hash(Buffer.from(change.after, 'utf8')), 'Knowledge plan snapshot hash mismatch', 'STATE_CORRUPT');
  }
  return value;
}

export async function createKnowledgeWriter({ dataDir, vaultRoot }) {
  requireThat(typeof dataDir === 'string' && path.isAbsolute(dataDir), 'dataDir must be absolute', 'UNSAFE_PATH');
  const dataRoot = path.resolve(dataDir);
  const vault = await assertVaultRoot(vaultRoot, dataRoot);
  const store = await openStore(dataRoot);
  const plansDir = path.join(dataRoot, PLAN_DIR_NAME);

  async function withLock(operation) {
    await store.acquireLock();
    try { return await operation(); }
    finally { await store.releaseLock(); }
  }

  async function assertPlanDirectory() {
    let current = dataRoot;
    for (const part of PLAN_DIR_NAME.split(path.sep)) {
      current = path.join(current, part);
      const stat = await lstatOrNull(current);
      requireThat(stat?.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700,
        'Plan directory unsafe', 'UNSAFE_PATH');
    }
  }

  async function assertPlanFile(file) {
    await assertPlanDirectory();
    const stat = await lstatOrNull(file);
    requireThat(stat?.isFile() && stat.nlink === 1 && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600,
      'Plan file missing or unsafe', 'NOT_FOUND');
  }

  async function savePlan(plan, expectedBytes = null) {
    validatePlan(plan);
    await mkdirPrivate(dataRoot, plansDir);
    await assertPlanDirectory();
    const file = path.join(plansDir, `${plan.id}.json`);
    const current = await lstatOrNull(file);
    if (current) {
      requireThat(current.isFile() && current.nlink === 1 && !current.isSymbolicLink() && (current.mode & 0o777) === 0o600, 'Plan file unsafe', 'STATE_CORRUPT');
      if (expectedBytes) {
        const actual = await fs.readFile(file);
        requireThat(actual.equals(expectedBytes), 'Plan changed concurrently', 'BUSY');
      }
    } else requireThat(expectedBytes === null, 'Plan disappeared concurrently', 'BUSY');
    const bytes = jsonBytes(plan);
    const temp = path.join(plansDir, `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temp, file);
      await syncDirectory(plansDir);
      const actual = await fs.readFile(file);
      requireThat(actual.equals(bytes), 'Plan read-back mismatch', 'STATE_CORRUPT');
    } finally {
      if (handle) await handle.close();
      try { await fs.unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return bytes;
  }

  async function loadPlan(planId) {
    validatePlanId(planId);
    const file = path.join(plansDir, `${planId}.json`);
    const directory = await lstatOrNull(plansDir);
    requireThat(directory, 'Plan missing', 'NOT_FOUND');
    await assertPlanFile(file);
    try {
      const plan = validatePlan(JSON.parse((await fs.readFile(file)).toString('utf8')));
      requireThat(path.resolve(plan.vault_root) === vault, 'Plan belongs to a different vaultRoot', 'UNSAFE_PATH');
      return plan;
    }
    catch (error) { if (error.code) throw error; fail('Invalid knowledge plan JSON', 'STATE_CORRUPT'); }
  }

  function checkReviewHash(plan, expectedReviewHash) {
    if (expectedReviewHash === undefined) return;
    requireThat(typeof expectedReviewHash === 'string' && /^[a-f0-9]{64}$/u.test(expectedReviewHash), 'Invalid expectedReviewHash');
    if (expectedReviewHash !== knowledgeReviewHash(plan)) {
      throw Object.assign(new Error('Review plan changed since preview'), { code: 'CONFLICT', plan: clone(plan) });
    }
  }

  async function failPlan(plan, change, error) {
    if (change && change.status !== 'ROLLED_BACK') change.status = error.code === 'CONFLICT' ? 'CONFLICT' : 'PENDING';
    plan.status = 'PARTIAL';
    plan.error = serialError(error);
    await savePlan(plan);
    const wrapped = Object.assign(new Error(plan.error.message), plan.error, { plan: clone(plan) });
    throw wrapped;
  }

  async function prepare({ materialId, changes, requireNewTarget = false }) {
    validateMaterialId(materialId);
    requireThat(Array.isArray(changes) && changes.length > 0, 'changes must be a non-empty array');
    requireThat(typeof requireNewTarget === 'boolean', 'requireNewTarget must be boolean');
    requireThat(!changes.some(c => managedOperation(c?.operation)||c?.operation==='reviewed-merge') || changes.length === 1, 'Managed topics require one target per plan');
    return withLock(async () => {
      const existingPlans = [];
      const planDirectory = await lstatOrNull(plansDir);
      if (planDirectory?.isDirectory() && !planDirectory.isSymbolicLink()) {
        for (const name of (await fs.readdir(plansDir)).filter(name => name.endsWith('.json'))) {
          existingPlans.push(await loadPlan(name.slice(0, -5)));
        }
      }
      const seen = new Set();
      let candidateOverlap = false;
      const prepared = [];
      for (const raw of changes) {
        const value = validateChange(raw);
        requireThat(!seen.has(value.relative_path), 'Multiple changes for one target are not supported', 'INPUT_INVALID');
        seen.add(value.relative_path);
        const sameMaterial = existingPlans.filter(plan => plan.material_id === materialId && plan.status !== 'ROLLED_BACK');
        const candidateIds = new Set(value.candidate_ids);
        for (const oldPlan of sameMaterial) {
          for (const old of oldPlan.changes) {
            const overlap = old.candidate_ids.some(id => candidateIds.has(id));
            // A new rendering of the same owned block is an update. Reusing the
            // candidate at another path, layer or managed key remains a duplicate.
            const sameManagedTarget = managedOperation(value.operation) && managedOperation(old.operation) &&
              old.managed_key === value.managed_key && old.relative_path === value.relative_path && old.knowledge_layer === value.knowledge_layer;
            const provenAppend = value.operation === 'managed-topic-adopt' && oldPlan.id === value.source_plan_id;
            const sameReviewedTarget=value.operation==='reviewed-merge'&&old.operation==='reviewed-merge'&&old.relative_path===value.relative_path&&old.knowledge_layer===value.knowledge_layer;
            if (overlap && !sameManagedTarget && !provenAppend && !sameReviewedTarget) candidateOverlap = true;
          }
        }
        const target = path.join(vault, value.relative_path);
        const before = await readVaultTarget(vault, target);
        let after;
        if(value.operation==='reviewed-merge'){
          requireThat(!requireNewTarget,'Reviewed merge needs an existing note','MERGE_REQUIRED');
          requireThat(!existingPlans.some(p=>p.status==='PARTIAL'&&p.error?.code!=='CONFLICT'&&p.changes.some(c=>c.relative_path===value.relative_path)),'An uncertain write must be reconciled first','RECOVERY_REQUIRED');
          const applied=existingPlans.find(p=>p.status==='APPLIED'&&p.material_id===materialId&&p.changes.length===1&&p.changes[0].operation==='reviewed-merge'&&p.changes[0].relative_path===value.relative_path&&p.changes[0].knowledge_layer===value.knowledge_layer&&p.changes[0].content===value.content&&p.changes[0].expected_before_hash===value.expected_before_hash&&p.changes[0].source_content_hash===value.source_content_hash&&JSON.stringify(p.changes[0].candidate_ids)===JSON.stringify(value.candidate_ids));
          if(applied){requireThat(before?.hash===applied.changes[0].after_hash&&before.text===applied.changes[0].after,'Merged note was edited','CONFLICT');return clone(applied);}
          requireThat(before!==null&&before.hash===value.expected_before_hash,'Reviewed note changed or missing','CONFLICT');
          requireThat(!before.text.includes('<!-- knowledge-agent:topic:')&&!before.text.includes('<!-- pk:'),'Managed note requires its owning writer','MERGE_REQUIRED');
          after=value.content;
        } else if (value.operation === 'managed-topic-adopt') {
          requireThat(!requireNewTarget,'Initial ownership requires an existing target','MERGE_REQUIRED');
          const related = existingPlans.filter(p => p.changes.some(c => c.relative_path === value.relative_path && managedOperation(c.operation) && c.managed_key === value.managed_key));
          requireThat(!related.some(p => p.status === 'PARTIAL' && p.error?.code !== 'CONFLICT'), 'An uncertain write must be reconciled first', 'RECOVERY_REQUIRED');
          const applied = related.find(p => p.status === 'APPLIED' && p.material_id === materialId && p.changes.length === 1 && p.changes[0].operation === value.operation && p.changes[0].content === value.content && p.changes[0].expected_before_hash === value.expected_before_hash && p.changes[0].source_plan_id === value.source_plan_id && JSON.stringify(p.changes[0].candidate_ids) === JSON.stringify(value.candidate_ids));
          if (applied) {
            requireThat(before?.hash === applied.changes[0].after_hash && before.text === applied.changes[0].after, 'Target changed after initial append', 'CONFLICT');
            return clone(applied);
          }
          requireThat(!related.some(p => p.status === 'APPLIED'), 'Already owned target cannot be initialized again', 'MERGE_REQUIRED');
          requireThat(before?.hash === value.expected_before_hash, 'Reviewed target changed before initialization', 'CONFLICT');
          {
            const receipt=existingPlans.find(p=>p.id===value.source_plan_id);
            requireThat(receipt&&receipt.status==='APPLIED'&&receipt.material_id===materialId&&receipt.changes.length===1,'Applied append receipt required','MERGE_REQUIRED');
            const old=receipt.changes[0];
            requireThat(old.operation===undefined&&old.relative_path===value.relative_path&&old.knowledge_layer===value.knowledge_layer&&old.before!==null&&old.after===before.text&&old.after_hash===before.hash&&old.content===value.content&&JSON.stringify(old.candidate_ids)===JSON.stringify(value.candidate_ids),'Append receipt does not prove this exact suffix','PLAN_MISMATCH');
            after=adoptManagedTopic(before.text,value.managed_key,value.content);
          }
        } else if (value.operation === 'managed-topic') {
          const related = existingPlans.filter(p => p.changes.some(c => c.relative_path === value.relative_path &&
            managedOperation(c.operation) && c.managed_key === value.managed_key));
          requireThat(!related.some(p => p.status === 'PARTIAL' && p.error?.code !== 'CONFLICT'),
            'An uncertain write must be reconciled first', 'RECOVERY_REQUIRED');
          const applied = related.filter(p => p.status === 'APPLIED').sort((a, b) => b.created_at.localeCompare(a.created_at));
          if (before === null) requireThat(applied.length === 0, 'Previously managed target was removed', 'CONFLICT');
          else {
            const block = managedTopicBlock(before.text, value.managed_key).text;
            requireThat(applied.length > 0, 'No applied plan proves ownership of this block', 'MERGE_REQUIRED');
            // Timestamp ties with different content are ambiguous, so fail closed.
            const latest = applied.filter(p => p.created_at === applied[0].created_at);
            requireThat(latest.every(p => {
              const previous = p.changes.find(c => c.relative_path === value.relative_path);
              return block === renderManagedTopic(previous.managed_key, previous.content);
            }), 'Managed block was changed; preserve manual edits', 'CONFLICT');
          }
          after = replaceManagedTopic(before?.text ?? null, value.managed_key, value.content);
        } else after = (before?.text || '') + value.content;
        const afterBytes = Buffer.from(after, 'utf8');
        prepared.push({ ...value, before: before?.text ?? null, before_hash: before?.hash ?? null,
          after, after_hash: hash(afterBytes), status: 'PENDING' });
      }
      const matchingPlans = existingPlans.filter(plan => plan.material_id === materialId && plan.status !== 'ROLLED_BACK' &&
        plan.changes.length === prepared.length && prepared.every(next => plan.changes.some(old =>
          old.knowledge_layer === next.knowledge_layer && old.relative_path === next.relative_path &&
          old.operation === next.operation && old.managed_key === next.managed_key &&
          old.expected_before_hash === next.expected_before_hash && old.source_content_hash === next.source_content_hash &&
          old.content === next.content && old.candidate_ids.length === next.candidate_ids.length &&
          old.candidate_ids.every(id => next.candidate_ids.includes(id)))));
      const isManaged = managedOperation(prepared[0].operation);
      const matchingSnapshot = plan => prepared.every(next => plan.changes.some(old => old.relative_path === next.relative_path &&
        (plan.status === 'APPLIED' ? next.before === old.after && next.before_hash === old.after_hash : next.before === old.before && next.before_hash === old.before_hash)));
      const samePlan = (isManaged && matchingPlans.find(matchingSnapshot)) || matchingPlans[0];
      if (samePlan) {
        if (requireNewTarget) {
          if (samePlan.changes.some(change => change.before !== null)) fail('Target already has content; merge is required', 'MERGE_REQUIRED');
          if (samePlan.status === 'APPLIED') {
            const matchesAfter = samePlan.changes.every(change => {
              const current = prepared.find(next => next.relative_path === change.relative_path);
              return current?.before === change.after && current.before_hash === change.after_hash;
            });
            if (!matchesAfter) fail('Target changed after application', 'CONFLICT');
          } else if (prepared.some(change => change.before !== null)) {
            fail('Target already has content; merge is required', 'MERGE_REQUIRED');
          }
        }
        if (!isManaged || matchingSnapshot(samePlan)) return clone(samePlan);
        requireThat(samePlan.status === 'PREPARED' || samePlan.status === 'PARTIAL' && samePlan.error?.code === 'CONFLICT',
          'Target changed after application', 'CONFLICT');
        // Re-preview a proven block against newly edited surrounding text. The old
        // preview retains its old before hash and cannot authorize this new target.
      }
      if (requireNewTarget && prepared.some(change => change.before !== null)) fail('Target already has content; merge is required', 'MERGE_REQUIRED');
      if (candidateOverlap && !(isManaged && samePlan)) fail('Candidate was already applied or planned at another target', 'DUPLICATE_CANDIDATE');
      const now = new Date().toISOString();
      const plan = { id: randomUUID(), material_id: materialId, vault_root: vault, status: 'PREPARED', changes: prepared,
        error: null, created_at: now, updated_at: now };
      await savePlan(plan);
      return clone(plan);
    });
  }

  async function apply({ planId, confirmed, expectedReviewHash }) {
    validatePlanId(planId);
    requireThat(confirmed === true, 'Explicit confirmation is required', 'CONFIRMATION_REQUIRED');
    return withLock(async () => {
      const plan = await loadPlan(planId);
      if(plan.changes.some(c=>c.operation==='reviewed-merge'))requireThat(typeof expectedReviewHash==='string','Reviewed merge requires its exact preview hash','CONFIRMATION_REQUIRED');
      checkReviewHash(plan, expectedReviewHash);
      if (plan.status === 'ROLLED_BACK') return clone(plan);
      if (plan.status === 'APPLIED') {
        try {
          for (const change of plan.changes) {
            const current = await readVaultTarget(vault, path.join(vault, change.relative_path));
            requireThat(current?.hash === change.after_hash && current.text === change.after,
              'Target changed after application', 'CONFLICT');
          }
        } catch (error) {
          await failPlan(plan, plan.changes.find(change => change.status === 'APPLIED'), error);
        }
        return clone(plan);
      }
      let appliedCount = 0;
      try {
        for (const change of plan.changes) {
          const target = path.join(vault, change.relative_path);
          const current = await readVaultTarget(vault, target);
          if (current?.hash === change.after_hash && current.text === change.after) {
            change.status = 'APPLIED';
            appliedCount += 1;
            continue;
          }
          if (change.status === 'APPLIED' && current?.hash !== change.after_hash) {
            fail('Target changed after application', 'CONFLICT');
          }
          const expected = change.before === null ? null : { text: change.before, hash: change.before_hash };
          await writeVaultAtomically(vault, target, expected, change.after);
          change.status = 'APPLIED';
          appliedCount += 1;
          plan.updated_at = new Date().toISOString();
          await savePlan(plan);
        }
      } catch (error) {
        await failPlan(plan, plan.changes.find(change => change.status === 'PENDING' || change.status === 'CONFLICT'), error);
      }
      plan.status = appliedCount === plan.changes.length ? 'APPLIED' : 'PARTIAL';
      plan.error = null;
      plan.updated_at = new Date().toISOString();
      await savePlan(plan);
      return clone(plan);
    });
  }

  async function rollback({ planId, confirmed, expectedReviewHash }) {
    validatePlanId(planId);
    requireThat(confirmed === true, 'Explicit confirmation is required', 'CONFIRMATION_REQUIRED');
    return withLock(async () => {
      const plan = await loadPlan(planId);
      if(plan.changes.some(c=>c.operation==='reviewed-merge'))requireThat(typeof expectedReviewHash==='string','Reviewed merge requires its exact preview hash','CONFIRMATION_REQUIRED');
      checkReviewHash(plan, expectedReviewHash);
      if (plan.status === 'ROLLED_BACK') return clone(plan);
      try {
        for (const change of plan.changes) {
          if (change.status === 'ROLLED_BACK') continue;
          const target = path.join(vault, change.relative_path);
          const current = await readVaultTarget(vault, target);
          const before = change.before === null ? null : { text: change.before, hash: change.before_hash };
          if (before === null && current === null) { change.status = 'ROLLED_BACK'; continue; }
          if (before && current?.hash === before.hash && current.text === before.text) { change.status = 'ROLLED_BACK'; continue; }
          requireThat(current?.hash === change.after_hash && current.text === change.after, 'Target changed after application; refusing rollback', 'CONFLICT');
          if (before === null) await deleteCreatedFile(vault, target, change.after_hash);
          else await writeVaultAtomically(vault, target, current, before.text);
          change.status = 'ROLLED_BACK';
          plan.updated_at = new Date().toISOString();
          await savePlan(plan);
        }
      } catch (error) {
        await failPlan(plan, plan.changes.find(change => change.status !== 'ROLLED_BACK'), error);
      }
      plan.status = 'ROLLED_BACK';
      plan.error = null;
      plan.updated_at = new Date().toISOString();
      await savePlan(plan);
      return clone(plan);
    });
  }

  async function list() {
    return withLock(async () => {
      const stat = await lstatOrNull(plansDir);
      if (!stat) return [];
      await assertPlanDirectory();
      const names = (await fs.readdir(plansDir)).filter(name => name.endsWith('.json')).sort();
      const plans = [];
      for (const name of names) {
        requireThat(PLAN_ID.test(name.slice(0, -5)), 'Unsafe plan filename', 'STATE_CORRUPT');
        plans.push(clone(await loadPlan(name.slice(0, -5))));
      }
      return plans;
    });
  }

  return { prepare, apply, rollback, list };
}
