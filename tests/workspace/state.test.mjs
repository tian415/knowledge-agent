import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openWorkspace } from '../../src/workspace/state.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'workspace-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const result = (overrides = {}) => ({
  material_id: 'mat_' + '1'.repeat(64),
  knowledge_candidates: [],
  action_candidates: [{
    action: '整理行动反馈',
    type: 'COMMITMENT',
    status: 'PROPOSED',
    reason: '用户明确决定',
    related: { route_type: null, route_id: null, route_name: null },
    evidence: [{ line_start: 1, line_end: 1, snippet: '用户明确决定' }],
  }],
  ...overrides,
});

const suggestion = (overrides = {}) => ({
  action: '每周回顾一个结果',
  type: 'SUGGESTION',
  status: 'PROPOSED',
  reason: '可减少遗漏',
  related: { route_type: null, route_id: null, route_name: null },
  evidence: [{ line_start: 1, line_end: 1, snippet: '可减少遗漏' }],
  ...overrides,
});

test('capture snapshot links require an authorized external identity on every read and survive other material writes',async t=>{
 const dataDir=await fixture(t),id='cact_'+'a'.repeat(64);let permitted=[id];
 const workspace=await openWorkspace({dataDir,externalActionIds:async()=>permitted});
 await workspace.importSnapshot({source:'known-list',updated_at:'2026-09-28T00:00:00Z',items:[{id:'item',title:'验证原文',status:'open'}]});
 await assert.rejects(workspace.linkSnapshotItem({source:'known-list',item_id:'item',action_id:'cact_'+'b'.repeat(64)}),{code:'NOT_FOUND'});
 await workspace.linkSnapshotItem({source:'known-list',item_id:'item',action_id:id});
 await workspace.ingestResult(result());assert.equal((await workspace.view()).snapshots[0].items[0].action_id,id);
 const before=await fs.readFile(path.join(dataDir,'workspace.json'));permitted=[];
 await assert.rejects(workspace.view(),{code:'SOURCE_SCOPE_MISMATCH'});
 assert.deepEqual(await fs.readFile(path.join(dataDir,'workspace.json')),before);
 permitted=[id];await workspace.linkSnapshotItem({source:'known-list',item_id:'item',action_id:null});
 assert.equal((await workspace.view()).snapshots[0].items[0].action_id,undefined);
});

// Cross-material suggestions intentionally keep material-scoped IDs here. A future duplicate_of hint
// must remain review-only and must not merge or inherit feedback until an explicit product contract exists.

test('persistent action identity survives restart and duplicate ingestion', async t => {
  const dataDir = await fixture(t);
  const first = await openWorkspace({ dataDir });
  await first.ingestResult(result());
  const initial = await first.view({ now: '2026-09-12T00:00:00Z' });
  assert.equal(initial.actions.length, 1);
  const id = initial.actions[0].id;

  await first.ingestResult(result());
  const restarted = await openWorkspace({ dataDir });
  const after = await restarted.view({ now: '2026-09-12T00:00:00Z' });
  assert.equal(after.actions.length, 1);
  assert.equal(after.actions[0].id, id);
  assert.equal((await fs.stat(path.join(dataDir, 'workspace.json'))).mode & 0o777, 0o600);
});

test('manual feedback survives repeated model results and does not revive a dismissed action', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const id = (await workspace.view()).actions[0].id;
  await workspace.decide({ id, decision: 'dismiss', reason: '当前不做' });
  await workspace.ingestResult(result({ action_candidates: [{ ...result().action_candidates[0], status: 'COMPLETED' }] }));
  const action = (await workspace.view()).actions[0];
  assert.equal(action.status, 'DISMISSED');
  assert.equal(action.source_status, 'COMPLETED');
  assert.equal(action.feedback.reason, '当前不做');
});

test('suggestions stay separate until explicitly accepted and model completion is unconfirmed', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result({ action_candidates: [suggestion({ status: 'COMPLETED' })] }));
  let current = await workspace.view();
  assert.equal(current.actions.length, 1);
  assert.equal(current.suggestions.length, 1);
  assert.equal(current.suggestions[0].source_status, 'COMPLETED');
  assert.equal(current.suggestions[0].status, 'SUGGESTED');
  assert.equal(current.suggestions[0].confirmed, false);

  const id = current.suggestions[0].id;
  await workspace.decide({ id, decision: 'accept', reason: '现在采用' });
  current = await workspace.view();
  assert.equal(current.suggestions.length, 0);
  assert.equal(current.actions.length, 1);
  assert.equal(current.actions[0].status, 'OPEN');
  assert.equal(current.actions[0].confirmed, true);
});

test('an accepted suggestion remains a formal confirmed action through later feedback', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result({ action_candidates: [suggestion()] }));
  const id = (await workspace.view()).suggestions[0].id;
  await workspace.decide({ id, decision: 'accept' });
  await workspace.decide({ id, decision: 'defer' });
  let action = (await workspace.view()).actions.find(entry => entry.id === id);
  assert.equal(action.formal, true);
  assert.equal(action.confirmed, true);
  await workspace.decide({ id, decision: 'reopen' });
  action = (await workspace.view()).actions.find(entry => entry.id === id);
  assert.equal(action.status, 'OPEN');
  assert.equal(action.formal, true);
  assert.equal(action.confirmed, true);
});

test('deferred suggestions are hidden until the explicit date and then return', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result({ action_candidates: [suggestion()] }));
  const id = (await workspace.view()).suggestions[0].id;
  await workspace.decide({ id, decision: 'defer', until: '2026-09-20' });
  assert.equal((await workspace.view({ now: '2026-09-19T00:00:00Z' })).suggestions.length, 0);
  assert.equal((await workspace.view({ now: '2026-09-20T00:00:00Z' })).suggestions.length, 1);
});

test('an indefinitely deferred suggestion stays hidden until a date is supplied', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result({ action_candidates: [suggestion()] }));
  const id = (await workspace.view()).suggestions[0].id;
  await workspace.decide({ id, decision: 'defer' });
  assert.equal((await workspace.view({ now: '2099-01-01T00:00:00Z' })).suggestions.length, 0);
});

test('model terminal statuses do not enter focus before user confirmation', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  for (const source_status of ['COMPLETED', 'CANCELLED', 'SUPERSEDED', 'DEFERRED']) {
    await workspace.ingestResult(result({
      action_candidates: [{ ...result().action_candidates[0], action: `终态 ${source_status}`, source_status, status: source_status }],
    }));
  }
  assert.equal((await workspace.view()).focus.length, 0);
});

test('projects require explicit evidence, preserve unknown optional fields as null, and never infer percentage progress', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await assert.rejects(workspace.confirmProject({ id: 'p1', kind: 'project', goal: '交付', stage: '进行中', blocker: '无', next_step: '验证', evidence: '' }));
  await workspace.confirmProject({ id: 'p1', kind: 'project', goal: '交付', stage: '进行中', blocker: '', next_step: '', evidence: '用户确认' });
  const project = (await workspace.view()).projects[0];
  assert.equal(project.id, 'p1');
  assert.equal(project.blocker, null);
  assert.equal(project.next_step, null);
  assert.equal(project.confirmed, true);
  assert.match(project.confirmed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.equal(new Date(project.confirmed_at).toISOString(), project.confirmed_at);
  assert.equal(Object.hasOwn(project, 'percent'), false);
});

test('snapshot import replaces the same source, links only by stable action_id, and stays pending sync', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({
    source: 'todo-app', updated_at: '2026-09-12T01:00:00Z',
    items: [{ id: 't1', title: '同名但不关联', status: 'open' }],
  });
  await workspace.importSnapshot({
    source: 'todo-app', updated_at: '2026-09-12T02:00:00Z',
    items: [{ id: 't2', title: '明确关联', status: 'done', action_id: actionId }],
  });
  const current = await workspace.view();
  assert.equal(current.snapshots.length, 1);
  assert.equal(current.snapshots[0].items[0].id, 't2');
  assert.equal(current.snapshots[0].primary_source, 'todo-app');
  assert.equal(current.snapshots[0].sync_status, 'PENDING_SYNC');
  assert.equal(current.actions[0].primary_source, 'todo-app');
  assert.equal(current.actions[0].sync_status, 'PENDING_SYNC');
  assert.match(current.coverage.message, /尚未登记/);
});

test('invalid or duplicate snapshot links are rejected before state replacement', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 't1', title: '旧', status: 'open' }] });
  const file = path.join(dataDir, 'workspace.json');
  const before = await fs.readFile(file);
  await assert.rejects(workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T02:00:00Z', items: [{ id: 't2', title: '坏链接', status: 'open', action_id: 'bad' }] }));
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T02:00:00Z', items: [{ id: 't2', title: '重复', status: 'open' }, { id: 't2', title: '重复', status: 'done' }] }));
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await workspace.view()).snapshots[0].items[0].id, 't1');
});

test('coverage reports imported source and marks snapshots older than seven days stale', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-01T00:00:00Z', items: [{ id: 't1', title: '覆盖', status: 'open' }] });
  const coverage = (await workspace.view({ now: '2026-09-10T00:00:01Z' })).coverage;
  assert.equal(coverage.external_list_connected, false);
  assert.equal(coverage.stale_after_days, 7);
  assert.equal(coverage.sources[0].source, 'todo-app');
  assert.equal(coverage.sources[0].covered, true);
  assert.equal(coverage.sources[0].stale, true);
  assert.match(coverage.message, /已导入/);
});

test('links an existing snapshot item to an existing action and can explicitly unlink it', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 't1', title: '行动', status: 'open' }] });
  await workspace.linkSnapshotItem({ source: 'todo-app', item_id: 't1', action_id: actionId });
  let action = (await workspace.view()).actions[0];
  assert.equal(action.primary_source, 'todo-app');
  assert.equal(action.sync_status, 'PENDING_SYNC');
  await workspace.linkSnapshotItem({ source: 'todo-app', item_id: 't1', action_id: null });
  action = (await workspace.view()).actions[0];
  assert.equal(action.primary_source, null);
  assert.equal(action.sync_status, null);
});

test('linking unknown snapshot or action entities returns NOT_FOUND', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 't1', title: '行动', status: 'open' }] });
  await assert.rejects(workspace.linkSnapshotItem({ source: 'missing', item_id: 't1', action_id: actionId }), { code: 'NOT_FOUND' });
  await assert.rejects(workspace.linkSnapshotItem({ source: 'todo-app', item_id: 'missing', action_id: actionId }), { code: 'NOT_FOUND' });
  await assert.rejects(workspace.linkSnapshotItem({ source: 'todo-app', item_id: 't1', action_id: 'act_' + 'f'.repeat(64) }), { code: 'NOT_FOUND' });
});

test('one action cannot be primary-linked across sources and conflict keeps old bytes', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({ source: 'one', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 'a', title: '行动', status: 'open' }] });
  await workspace.importSnapshot({ source: 'two', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 'b', title: '行动', status: 'open' }] });
  await workspace.linkSnapshotItem({ source: 'one', item_id: 'a', action_id: actionId });
  const file = path.join(dataDir, 'workspace.json');
  const before = await fs.readFile(file);
  await assert.rejects(workspace.linkSnapshotItem({ source: 'two', item_id: 'b', action_id: actionId }), { code: 'CONFLICT' });
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(workspace.importSnapshot({ source: 'two', updated_at: '2026-09-12T02:00:00Z', items: [{ id: 'b', title: '行动', status: 'open', action_id: actionId }] }), { code: 'CONFLICT' });
  assert.deepEqual(await fs.readFile(file), before);
});

test('same-source refresh preserves an item mapping and disappearing items are unlinked', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 't1', title: '行动', status: 'open' }] });
  await workspace.linkSnapshotItem({ source: 'todo-app', item_id: 't1', action_id: actionId });
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T02:00:00Z', items: [{ id: 't1', title: '行动更新', status: 'done' }, { id: 't2', title: '新增', status: 'open' }] });
  let state = await workspace.view();
  assert.equal(state.snapshots[0].items.find(item => item.id === 't1').action_id, actionId);
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T03:00:00Z', items: [{ id: 't2', title: '新增', status: 'open' }] });
  state = await workspace.view();
  assert.equal(state.actions[0].primary_source, null);
  assert.equal(state.actions[0].sync_status, null);
});

test('reingesting a result does not remove a manually established snapshot mapping', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  const persisted = result();
  await workspace.ingestResult(persisted);
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-12T01:00:00Z', items: [{ id: 't1', title: '行动', status: 'open', action_id: actionId }] });
  await workspace.ingestResult({ ...persisted, action_candidates: [{ ...persisted.action_candidates[0], status: 'COMPLETED' }] });
  const action = (await workspace.view()).actions[0];
  assert.equal(action.source_status, 'COMPLETED');
  assert.equal(action.primary_source, 'todo-app');
  assert.equal(action.sync_status, 'PENDING_SYNC');
});

test('corrupt or linked workspace state fails closed without replacement', async t => {
  const dataDir = await fixture(t);
  const workspace = await openWorkspace({ dataDir });
  await workspace.view();
  const file = path.join(dataDir, 'workspace.json');
  await fs.writeFile(file, '{', { mode: 0o600 });
  await assert.rejects(workspace.view(), { code: 'STATE_CORRUPT' });
  assert.equal(await fs.readFile(file, 'utf8'), '{');
});

test('older external snapshots cannot erase newer items or their manual action links', async t => {
  const dataDir = await fixture(t), workspace = await openWorkspace({ dataDir });
  await workspace.ingestResult(result());
  const actionId = (await workspace.view()).actions[0].id;
  await workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-21T02:00:00Z',
    items: [{ id: 'current', title: '最近清单', status: 'open', action_id: actionId }] });
  const file = path.join(dataDir, 'workspace.json'), before = await fs.readFile(file);
  await assert.rejects(workspace.importSnapshot({ source: 'todo-app', updated_at: '2026-09-20T02:00:00Z', items: [] }), { code: 'CONFLICT' });
  assert.deepEqual(await fs.readFile(file), before);
  const current = await (await openWorkspace({ dataDir })).view();
  assert.equal(current.snapshots[0].items[0].action_id, actionId);
  assert.equal(current.actions[0].primary_source, 'todo-app');
  await workspace.importSnapshot({ source: 'other-list', updated_at: '2026-09-01T00:00:00Z', items: [] });
  assert.equal((await workspace.view()).snapshots.length, 2);
});
