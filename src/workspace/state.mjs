import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStore } from '../intake/store.mjs';
import { applyActionDecision } from './action-feedback.mjs';

const VERSION = 1;
const ACTION_TYPES = new Set(['COMMITMENT', 'SUGGESTION', 'FOLLOW_UP']);
const SOURCE_STATUSES = new Set(['PROPOSED', 'NEEDS_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'SUPERSEDED', 'DEFERRED']);
const DECISIONS = new Set(['accept', 'complete', 'defer', 'dismiss', 'cancel', 'reopen']);
const ACTION_STATUSES = new Set(['NEEDS_CONFIRMATION', 'SUGGESTED', 'OPEN', 'COMPLETED', 'DEFERRED', 'DISMISSED', 'CANCELLED']);
const TERMINAL_SOURCE_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'SUPERSEDED', 'DEFERRED']);
const SNAPSHOT_STALE_DAYS = 7;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message, code = 'INPUT_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function requireText(value, name) {
  if (typeof value !== 'string' || !/\S/u.test(value)) fail(`${name} must be a non-blank string`);
  return value;
}

function optionalText(value, name) {
  if (value === undefined || value === null || (typeof value === 'string' && !/\S/u.test(value))) return null;
  return requireText(value, name);
}

function clone(value) {
  return structuredClone(value);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function actionId(candidate, materialId) {
  const identity = stable({
    material_id: materialId,
    action: candidate.action,
    type: candidate.type,
    related: candidate.related ?? null,
  });
  return `act_${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

function validDate(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) fail(`${name} must be a valid date`);
  return value;
}

function stateTemplate() {
  return { version: VERSION, actions: [], projects: [], snapshots: [] };
}

function validateAction(value) {
  if (!object(value)) fail('Invalid action state', 'STATE_CORRUPT');
  const keys = ['id', 'material_id', 'action', 'type', 'reason', 'related', 'evidence', 'source_status', 'status', 'confirmed', 'formal', 'feedback', 'until', 'primary_source', 'sync_status'];
  if (Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail('Unknown action state fields', 'STATE_CORRUPT');
  if (typeof value.id !== 'string' || !/^act_[a-f0-9]{64}$/u.test(value.id)) fail('Invalid action ID', 'STATE_CORRUPT');
  if (typeof value.material_id !== 'string' || !/^mat_[a-f0-9]{64}$/u.test(value.material_id)) fail('Invalid action material ID', 'STATE_CORRUPT');
  requireText(value.action, 'action');
  if (!ACTION_TYPES.has(value.type) || !SOURCE_STATUSES.has(value.source_status) || !ACTION_STATUSES.has(value.status)) fail('Invalid action enum', 'STATE_CORRUPT');
  requireText(value.reason, 'reason');
  if (!object(value.related) || !Array.isArray(value.evidence)) fail('Invalid action source', 'STATE_CORRUPT');
  if (typeof value.confirmed !== 'boolean' || typeof value.formal !== 'boolean') fail('Invalid action confirmation', 'STATE_CORRUPT');
  if (value.feedback !== null) {
    if (!object(value.feedback) || !DECISIONS.has(value.feedback.decision) || (value.feedback.reason !== null && typeof value.feedback.reason !== 'string')) fail('Invalid action feedback', 'STATE_CORRUPT');
    validDate(value.feedback.until, 'feedback.until');
  }
  validDate(value.until, 'until');
  if (value.primary_source !== null && typeof value.primary_source !== 'string') fail('Invalid primary source', 'STATE_CORRUPT');
  if (value.sync_status !== null && value.sync_status !== 'PENDING_SYNC') fail('Invalid sync status', 'STATE_CORRUPT');
  return value;
}

function validateProject(value) {
  if (!object(value)) fail('Invalid project state', 'STATE_CORRUPT');
  const keys = ['id', 'kind', 'goal', 'stage', 'blocker', 'next_step', 'evidence', 'confirmed', 'confirmed_at'];
  if (Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail('Unknown project state fields', 'STATE_CORRUPT');
  requireText(value.id, 'project.id');
  if (!['project', 'learning'].includes(value.kind)) fail('Invalid project kind', 'STATE_CORRUPT');
  for (const field of ['goal', 'stage', 'evidence']) requireText(value[field], `project.${field}`);
  for (const field of ['blocker', 'next_step']) {
    if (value[field] !== null) requireText(value[field], `project.${field}`);
  }
  if (value.confirmed !== true) fail('Project confirmation state is invalid', 'STATE_CORRUPT');
  validDate(value.confirmed_at, 'project.confirmed_at', { required: true });
  return value;
}

function validateSnapshot(value) {
  if (!object(value)) fail('Invalid snapshot state', 'STATE_CORRUPT');
  const keys = ['source', 'updated_at', 'items', 'primary_source', 'sync_status'];
  if (Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail('Unknown snapshot state fields', 'STATE_CORRUPT');
  requireText(value.source, 'snapshot.source');
  validDate(value.updated_at, 'snapshot.updated_at', { required: true });
  if (!Array.isArray(value.items) || value.primary_source !== value.source || value.sync_status !== 'PENDING_SYNC') fail('Invalid snapshot metadata', 'STATE_CORRUPT');
  const itemIds = new Set();
  const actionIds = new Set();
  for (const item of value.items) {
    if (!object(item)) fail('Invalid snapshot item', 'STATE_CORRUPT');
    const itemKeys = Object.keys(item).sort();
    if (!(itemKeys.join('\0') === 'id\0status\0title' || itemKeys.join('\0') === 'action_id\0id\0status\0title')) fail('Unknown snapshot item fields', 'STATE_CORRUPT');
    requireText(item.id, 'snapshot.item.id'); requireText(item.title, 'snapshot.item.title'); requireText(item.status, 'snapshot.item.status');
    if (itemIds.has(item.id)) fail('Duplicate snapshot item ID', 'STATE_CORRUPT');
    itemIds.add(item.id);
    if (Object.hasOwn(item, 'action_id')) {
      if (typeof item.action_id !== 'string' || !/^(?:act|cact)_[a-f0-9]{64}$/u.test(item.action_id)) fail('Invalid snapshot action ID', 'STATE_CORRUPT');
      if (actionIds.has(item.action_id)) fail('Duplicate snapshot action ID', 'STATE_CORRUPT');
      actionIds.add(item.action_id);
    }
  }
  return value;
}

function validateState(value, externalIds = new Set()) {
  try {
    if (!object(value) || value.version !== VERSION || !Array.isArray(value.actions) || !Array.isArray(value.projects) || !Array.isArray(value.snapshots)) fail('Invalid workspace state', 'STATE_CORRUPT');
    const keys = ['version', 'actions', 'projects', 'snapshots'];
    if (Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail('Unknown workspace state fields', 'STATE_CORRUPT');
    const actionIds = new Set();
    for (const action of value.actions) { validateAction(action); if (actionIds.has(action.id)) fail('Duplicate action ID', 'STATE_CORRUPT'); actionIds.add(action.id); }
    const projectIds = new Set();
    for (const project of value.projects) { validateProject(project); if (projectIds.has(project.id)) fail('Duplicate project ID', 'STATE_CORRUPT'); projectIds.add(project.id); }
    const sources = new Set();
    const linkedActions = new Set();
    for (const snapshot of value.snapshots) {
      validateSnapshot(snapshot);
      if (sources.has(snapshot.source)) fail('Duplicate snapshot source', 'STATE_CORRUPT');
      sources.add(snapshot.source);
      for (const item of snapshot.items) if (item.action_id) {
        if (!actionIds.has(item.action_id) && !externalIds.has(item.action_id)) fail('Snapshot action does not exist', item.action_id.startsWith('cact_') ? 'SOURCE_SCOPE_MISMATCH' : 'STATE_CORRUPT');
        if (linkedActions.has(item.action_id)) fail('Action has multiple snapshot primaries', 'STATE_CORRUPT');
        linkedActions.add(item.action_id);
      }
    }
    return value;
  } catch (error) {
    if (['STATE_CORRUPT','SOURCE_SCOPE_MISMATCH'].includes(error.code)) throw error;
    throw Object.assign(new Error(`Invalid workspace state: ${error.message}`), { code: 'STATE_CORRUPT', cause: error });
  }
}

async function readBytes(file) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail('Unsafe workspace state file', 'UNSAFE_PATH');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.ino !== stat.ino || current.dev !== stat.dev || (current.mode & 0o777) !== 0o600) fail('Workspace state changed during read', 'UNSAFE_PATH');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function readState(file, externalIds) {
  const bytes = await readBytes(file);
  if (bytes === null) return { state: stateTemplate(), before: null };
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('Invalid workspace JSON', 'STATE_CORRUPT'); }
  return { state: validateState(value, externalIds), before: bytes };
}

async function atomicStateWrite(file, value, before) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temp = path.join(path.dirname(file), `.${randomUUID()}.workspace.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const current = await readBytes(file);
    if (before === null ? current !== null : current === null || !current.equals(before)) fail('Workspace state changed before write', 'STATE_CHANGED');
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
    const after = await readBytes(file);
    if (after === null || !after.equals(bytes)) fail('Workspace state read-back mismatch', 'STATE_CORRUPT');
  } finally {
    if (handle) await handle.close();
    try { await fs.unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function candidateToAction(candidate, materialId) {
  if (!object(candidate)) fail('Invalid action candidate');
  if (Object.hasOwn(candidate, 'material_id') && candidate.material_id !== materialId) fail('Candidate material ID mismatch');
  requireText(candidate.action, 'candidate.action');
  if (!ACTION_TYPES.has(candidate.type) || !SOURCE_STATUSES.has(candidate.status)) fail('Invalid candidate action enum');
  requireText(candidate.reason, 'candidate.reason');
  if (!Object.hasOwn(candidate, 'related') || !object(candidate.related) || !Array.isArray(candidate.evidence)) fail('Invalid candidate source');
  const suggestion = candidate.type === 'SUGGESTION';
  return {
    id: actionId(candidate, materialId), material_id: materialId, action: candidate.action, type: candidate.type,
    reason: candidate.reason, related: clone(candidate.related), evidence: clone(candidate.evidence), source_status: candidate.status,
    status: suggestion ? 'SUGGESTED' : 'NEEDS_CONFIRMATION', confirmed: false, formal: false, feedback: null, until: null,
    primary_source: null, sync_status: null,
  };
}

function due(action, now) {
  if (!action.until) return false;
  return new Date(action.until).getTime() <= now.getTime();
}

function reconcileSnapshotLinks(state, externalIds) {
  const links = new Map();
  for (const snapshot of state.snapshots) for (const item of snapshot.items) if (item.action_id) {
    if (!state.actions.some(action => action.id === item.action_id) && !externalIds.has(item.action_id)) fail(`Unknown action: ${item.action_id}`, 'NOT_FOUND');
    const previous = links.get(item.action_id);
    if (previous && (previous.source !== snapshot.source || previous.item_id !== item.id)) fail('Action already has a snapshot primary', 'CONFLICT');
    links.set(item.action_id, { source: snapshot.source, item_id: item.id });
  }
  for (const action of state.actions) {
    const link = links.get(action.id);
    action.primary_source = link?.source ?? null;
    action.sync_status = link ? 'PENDING_SYNC' : null;
  }
}

function formatView(state, nowValue) {
  const now = nowValue === undefined ? new Date() : (nowValue instanceof Date ? nowValue : new Date(nowValue));
  if (!Number.isFinite(now.getTime())) fail('now must be a valid date');
  const actions = state.actions.map(clone);
  const suggestions = state.actions.filter(action => !action.formal && action.type === 'SUGGESTION' &&
    (action.status === 'SUGGESTED' || (action.status === 'DEFERRED' && due(action, now)))).slice(0, 3).map(clone);
  const focus = actions.filter(action => (action.type !== 'SUGGESTION' || action.formal) &&
    (action.confirmed || !TERMINAL_SOURCE_STATUSES.has(action.source_status)) &&
    (['NEEDS_CONFIRMATION', 'OPEN'].includes(action.status) || (action.status === 'DEFERRED' && due(action, now)))).slice(0, 3).map(clone);
  const coveredSnapshots = state.snapshots.map(snapshot => ({
    source: snapshot.source,
    updated_at: snapshot.updated_at,
    covered: true,
    stale: now.getTime() - new Date(snapshot.updated_at).getTime() > SNAPSHOT_STALE_DAYS * 24 * 60 * 60 * 1000,
    item_count: snapshot.items.length,
  }));
  return {
    actions, focus, suggestions, projects: state.projects.map(clone), snapshots: state.snapshots.map(clone),
    coverage: {
      external_list_connected: false,
      stale_after_days: SNAPSHOT_STALE_DAYS,
      message: state.snapshots.length ? '已导入外部清单快照；中心尚未登记外部实时清单，不能据此声称外部没有遗漏。' : '外部清单尚未接入，中心尚未登记，不能据此声称外部没有遗漏。',
      sources: coveredSnapshots,
    },
  };
}

export async function openWorkspace({ dataDir, externalActionIds }) {
  const store = await openStore(dataDir);
  const file = path.join(path.resolve(dataDir), 'workspace.json');

  async function withLock(mutator) {
    await store.acquireLock();
    try {
      const externalIds = new Set(await externalActionIds?.() ?? []);
      if ([...externalIds].some(id => typeof id !== 'string' || !/^cact_[a-f0-9]{64}$/u.test(id))) fail('Invalid external action identity');
      const loaded = await readState(file, externalIds);
      const result = await mutator(loaded.state, loaded.before, externalIds);
      if (result?.write) {
        validateState(result.state, externalIds);
        await atomicStateWrite(file, result.state, loaded.before);
      }
      return result?.value;
    } finally {
      await store.releaseLock();
    }
  }

  return {
    async ingestResult(result) {
      return withLock(async (state, before, externalIds) => {
        if (!object(result) || typeof result.material_id !== 'string' || !Array.isArray(result.knowledge_candidates) || !Array.isArray(result.action_candidates)) fail('Invalid persisted result');
        for (const candidate of result.action_candidates) {
          const incoming = candidateToAction(candidate, result.material_id);
          const existing = state.actions.find(action => action.id === incoming.id);
          if (existing) {
            existing.source_status = incoming.source_status;
            existing.action = incoming.action; existing.type = incoming.type; existing.reason = incoming.reason;
            existing.related = incoming.related; existing.evidence = incoming.evidence; existing.material_id = incoming.material_id;
          } else state.actions.push(incoming);
        }
        reconcileSnapshotLinks(state, externalIds);
        return { write: true, state, value: formatView(state) };
      });
    },

    async decide({ id, decision, reason, until }) {
      return withLock(async state => {
        requireText(id, 'id');
        if (!DECISIONS.has(decision)) fail(`Unsupported decision: ${decision}`);
        const action = state.actions.find(entry => entry.id === id);
        if (!action) fail(`Unknown action: ${id}`, 'NOT_FOUND');
        applyActionDecision(action, { decision, reason, until });
        return { write: true, state, value: formatView(state) };
      });
    },

    async importSnapshot({ source, updated_at, items }) {
      return withLock(async (state, before, externalIds) => {
        requireText(source, 'source');
        validDate(updated_at, 'updated_at', { required: true });
        if (!Array.isArray(items)) fail('items must be an array');
        const existingSnapshot = state.snapshots.find(snapshot => snapshot.source === source);
        if (existingSnapshot && Date.parse(updated_at) < Date.parse(existingSnapshot.updated_at)) fail('Snapshot is older than the current imported list', 'CONFLICT');
        const existingItems = new Map((existingSnapshot?.items ?? []).map(item => [item.id, item]));
        const itemIds = new Set();
        const actionIds = new Set();
        const normalized = items.map(item => {
          if (!object(item)) fail('Invalid snapshot item');
          const allowed = Object.keys(item).sort();
          if (!(allowed.join('\0') === 'id\0status\0title' || allowed.join('\0') === 'action_id\0id\0status\0title')) fail('Invalid snapshot item fields');
          const normalizedItem = { id: requireText(item.id, 'item.id'), title: requireText(item.title, 'item.title'), status: requireText(item.status, 'item.status') };
          if (itemIds.has(normalizedItem.id)) fail('Duplicate snapshot item ID');
          itemIds.add(normalizedItem.id);
          if (Object.hasOwn(item, 'action_id')) {
            const actionId = requireText(item.action_id, 'item.action_id');
            if (!/^(?:act|cact)_[a-f0-9]{64}$/u.test(actionId)) fail('Invalid snapshot action ID');
            if (actionIds.has(actionId)) fail('Duplicate snapshot action ID');
            actionIds.add(actionId);
            normalizedItem.action_id = actionId;
          } else if (existingItems.get(normalizedItem.id)?.action_id) {
            const preserved = existingItems.get(normalizedItem.id).action_id;
            if (actionIds.has(preserved)) fail('Duplicate snapshot action ID');
            actionIds.add(preserved);
            normalizedItem.action_id = preserved;
          }
          return normalizedItem;
        });
        for (const item of normalized) if (item.action_id) {
          if (!state.actions.some(action => action.id === item.action_id) && !externalIds.has(item.action_id)) fail(`Unknown action: ${item.action_id}`, 'NOT_FOUND');
          for (const snapshot of state.snapshots) if (snapshot.source !== source && snapshot.items.some(existing => existing.action_id === item.action_id)) fail('Action already has a snapshot primary', 'CONFLICT');
        }
        const snapshot = { source, updated_at, items: normalized, primary_source: source, sync_status: 'PENDING_SYNC' };
        state.snapshots = [...state.snapshots.filter(entry => entry.source !== source), snapshot];
        reconcileSnapshotLinks(state, externalIds);
        return { write: true, state, value: formatView(state) };
      });
    },

    async linkSnapshotItem({ source, item_id, action_id } = {}) {
      return withLock(async (state, before, externalIds) => {
        if (typeof source !== 'string' || !/\S/u.test(source) || typeof item_id !== 'string' || !/\S/u.test(item_id) || action_id === undefined) fail('Snapshot link target not found', 'NOT_FOUND');
        const snapshot = state.snapshots.find(entry => entry.source === source);
        const item = snapshot?.items.find(entry => entry.id === item_id);
        if (!snapshot || !item) fail('Snapshot link target not found', 'NOT_FOUND');
        if (action_id === null) delete item.action_id;
        else {
          const action = state.actions.find(entry => entry.id === action_id);
          if (!action && !externalIds.has(action_id)) fail('Snapshot link action not found', 'NOT_FOUND');
          for (const candidate of state.snapshots) for (const other of candidate.items) {
            if (candidate.source !== source || other.id !== item_id) if (other.action_id === action_id) fail('Action already has a snapshot primary', 'CONFLICT');
          }
          item.action_id = action_id;
        }
        reconcileSnapshotLinks(state, externalIds);
        return { write: true, state, value: formatView(state) };
      });
    },

    async confirmProject({ id, kind, goal, stage, blocker, next_step, evidence }) {
      return withLock(async state => {
        const project = {
          id: requireText(id, 'id'), kind, goal: requireText(goal, 'goal'), stage: requireText(stage, 'stage'),
          blocker: optionalText(blocker, 'blocker'), next_step: optionalText(next_step, 'next_step'), evidence: requireText(evidence, 'evidence'),
          confirmed: true, confirmed_at: new Date().toISOString(),
        };
        if (!['project', 'learning'].includes(kind)) fail('kind must be project or learning');
        state.projects = [...state.projects.filter(entry => entry.id !== project.id), project];
        return { write: true, state, value: formatView(state) };
      });
    },

    async view({ now } = {}) {
      return withLock(async state => ({ write: false, value: formatView(state, now) }));
    },
  };
}
