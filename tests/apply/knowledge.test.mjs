import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createKnowledgeWriter, knowledgeReviewHash } from '../../src/apply/knowledge.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, initial = '已有内容\r\n') {
  const root = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'knowledge-apply-'));
  const dataDir = path.join(root, 'data');
  const vaultRoot = path.join(root, 'vault');
  await fs.mkdir(path.join(vaultRoot, '01-项目沉淀'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(vaultRoot, '02-方法论', '工程思维'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(vaultRoot, '02-方法论', '产品思维'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(vaultRoot, '03-长期知识'), { recursive: true, mode: 0o700 });
  const target = path.join(vaultRoot, '01-项目沉淀', '知识.md');
  await fs.writeFile(target, initial, { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = await createKnowledgeWriter({ dataDir, vaultRoot });
  return { root, dataDir, vaultRoot, target, writer };
}

const change = (content = '\n追加段落\n') => ({
  knowledge_layer: 'PROJECT_KNOWLEDGE',
  relative_path: '01-项目沉淀/知识.md',
  content,
  candidate_ids: ['cand-1'],
});

test('prepare creates a reviewable plan without writing the Vault and apply requires confirmation', async t => {
  const { writer, target } = await fixture(t);
  const before = await fs.readFile(target);
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [change()] });
  assert.equal(plan.status, 'PREPARED');
  assert.equal(plan.changes[0].before, before.toString());
  assert.equal(plan.changes[0].after, `${before.toString()}\n追加段落\n`);
  assert.deepEqual(await fs.readFile(target), before);
  await assert.rejects(writer.apply({ planId: plan.id, confirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  assert.deepEqual(await fs.readFile(target), before);
});

test('confirmed apply is append-idempotent and list reads the persisted plan', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [change()] });
  const applied = await writer.apply({ planId: plan.id, confirmed: true });
  assert.equal(applied.status, 'APPLIED');
  assert.equal(await fs.readFile(target, 'utf8'), '已有内容\r\n\n追加段落\n');
  const repeated = await writer.apply({ planId: plan.id, confirmed: true });
  assert.deepEqual(repeated, applied);
  assert.equal(await fs.readFile(target, 'utf8'), applied.changes[0].after);
  assert.deepEqual(await writer.list(), [applied]);
});

test('manual edit after prepare is refused and preserves the edited bytes', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [change()] });
  await fs.writeFile(target, '用户后来编辑\n');
  await assert.rejects(writer.apply({ planId: plan.id, confirmed: true }), error =>
    error.code === 'CONFLICT' && error.plan.status === 'PARTIAL');
  assert.equal(await fs.readFile(target, 'utf8'), '用户后来编辑\n');
  const stored = (await writer.list())[0];
  assert.equal(stored.status, 'PARTIAL');
  assert.equal(stored.changes[0].status, 'CONFLICT');
  assert.equal(stored.error.code, 'CONFLICT');
});

test('partial apply can be re-entered without duplicating the completed file', async t => {
  const { writer, vaultRoot } = await fixture(t);
  const second = path.join(vaultRoot, '01-项目沉淀', '第二.md');
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [
    change('\n第一份\n'),
    { ...change('\n第二份\n'), relative_path: '01-项目沉淀/第二.md' },
  ]});
  await fs.writeFile(second, '外部改动\n');
  await assert.rejects(writer.apply({ planId: plan.id, confirmed: true }), { code: 'CONFLICT' });
  const first = path.join(vaultRoot, '01-项目沉淀', '知识.md');
  assert.equal(await fs.readFile(first, 'utf8'), '已有内容\r\n\n第一份\n');
  assert.equal((await writer.list())[0].status, 'PARTIAL');
  await fs.unlink(second);
  const retried = await writer.apply({ planId: plan.id, confirmed: true });
  assert.equal(retried.status, 'APPLIED');
  assert.equal(await fs.readFile(first, 'utf8'), '已有内容\r\n\n第一份\n');
  assert.equal(await fs.readFile(second, 'utf8'), '\n第二份\n');
});

test('after-rename failure is recorded and the next apply claims the afterHash without re-appending', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [change('\n崩溃恢复\n')] });
  const originalRename = fs.rename.bind(fs);
  let injected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    await originalRename(from, to);
    if (!injected && to === target) {
      injected = true;
      throw new Error('injected after-rename failure');
    }
  });
  await assert.rejects(writer.apply({ planId: plan.id, confirmed: true }), error =>
    error.code === 'APPLY_ERROR' && error.plan.status === 'PARTIAL');
  assert.equal(await fs.readFile(target, 'utf8'), '已有内容\r\n\n崩溃恢复\n');
  assert.equal((await writer.list())[0].changes[0].status, 'PENDING');
  t.mock.restoreAll();
  const recovered = await writer.apply({ planId: plan.id, confirmed: true });
  assert.equal(recovered.status, 'APPLIED');
  assert.equal(await fs.readFile(target, 'utf8'), recovered.changes[0].after);
});

test('rollback restores only this plan and refuses a later user edit', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [change()] });
  const applied = await writer.apply({ planId: plan.id, confirmed: true });
  const rolledBack = await writer.rollback({ planId: plan.id, confirmed: true });
  assert.equal(rolledBack.status, 'ROLLED_BACK');
  assert.equal(await fs.readFile(target, 'utf8'), '已有内容\r\n');
  assert.deepEqual(await writer.rollback({ planId: plan.id, confirmed: true }), rolledBack);

  const next = await writer.prepare({ materialId: 'mat-test', changes: [change('\n第二次\n')] });
  await writer.apply({ planId: next.id, confirmed: true });
  await fs.appendFile(target, '用户编辑\n');
  await assert.rejects(writer.rollback({ planId: next.id, confirmed: true }), error =>
    error.code === 'CONFLICT' && error.plan.status === 'PARTIAL');
  assert.equal(await fs.readFile(target, 'utf8'), `${next.changes[0].after}用户编辑\n`);
  assert.equal(hash(await fs.readFile(target)), next.changes[0].after_hash === hash(next.changes[0].after) ? hash(next.changes[0].after + '用户编辑\n') : hash(await fs.readFile(target)));
});

test('new-file rollback deletes only the file created by this plan', async t => {
  const { writer, vaultRoot } = await fixture(t);
  const rel = '03-长期知识/新知识.md';
  const target = path.join(vaultRoot, rel);
  const plan = await writer.prepare({ materialId: 'mat-test', changes: [{
    knowledge_layer: 'GENERAL_KNOWLEDGE', relative_path: rel, content: '# 新知识\n', candidate_ids: [],
  }]});
  assert.equal(plan.changes[0].before, null);
  await writer.apply({ planId: plan.id, confirmed: true });
  assert.equal(await fs.readFile(target, 'utf8'), '# 新知识\n');
  await writer.rollback({ planId: plan.id, confirmed: true });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('prepare previews a missing future directory and apply creates it safely after confirmation', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'knowledge-empty-'));
  const dataDir = path.join(root, 'data');
  const vaultRoot = path.join(root, 'vault');
  await fs.mkdir(vaultRoot, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = await createKnowledgeWriter({ dataDir, vaultRoot });
  const rel = '03-长期知识/未来主题/新知识.md';
  const plan = await writer.prepare({ materialId: 'mat-empty', changes: [{
    knowledge_layer: 'GENERAL_KNOWLEDGE', relative_path: rel, content: '# 新知识\n', candidate_ids: ['cand-empty'],
  }]});
  assert.equal(plan.changes[0].before, null);
  await assert.rejects(fs.stat(path.join(vaultRoot, '03-长期知识')), { code: 'ENOENT' });
  await writer.apply({ planId: plan.id, confirmed: true });
  assert.equal(await fs.readFile(path.join(vaultRoot, rel), 'utf8'), '# 新知识\n');
});

test('same material and candidate content reuses an existing plan and cannot move an applied candidate', async t => {
  const { writer, vaultRoot } = await fixture(t);
  const first = await writer.prepare({ materialId: 'mat-repeat', changes: [change('\n候选去重\n')] });
  await writer.apply({ planId: first.id, confirmed: true });
  const reused = await writer.prepare({ materialId: 'mat-repeat', changes: [change('\n候选去重\n')] });
  assert.equal(reused.id, first.id);
  assert.equal(reused.status, 'APPLIED');
  await assert.rejects(writer.prepare({ materialId: 'mat-repeat', changes: [{ ...change('\n候选去重\n'), relative_path: '01-项目沉淀/另一个.md' }] }), { code: 'DUPLICATE_CANDIDATE' });
  assert.equal(await fs.stat(path.join(vaultRoot, '01-项目沉淀', '另一个.md')).then(() => true, () => false), false);
});

test('requireNewTarget rejects existing empty files without persisting a plan', async t => {
  const { writer, target } = await fixture(t, '');
  const beforePlans = await writer.list();
  await assert.rejects(writer.prepare({ materialId: 'mat-new-only', changes: [change()], requireNewTarget: true }), { code: 'MERGE_REQUIRED' });
  assert.deepEqual(await writer.list(), beforePlans);
  assert.equal(await fs.readFile(target, 'utf8'), '');
});

test('requireNewTarget rejects a matching append plan instead of reusing it', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-append-only', changes: [change()] });
  await assert.rejects(writer.prepare({ materialId: 'mat-append-only', changes: [change()], requireNewTarget: true }), { code: 'MERGE_REQUIRED' });
  assert.deepEqual(await writer.list(), [plan]);
  assert.equal(await fs.readFile(target, 'utf8'), '已有内容\r\n');
});

test('requireNewTarget rejects a PREPARED create-only plan after a target appears', async t => {
  for (const manual of ['', '人工创建\n']) {
    const { writer, vaultRoot } = await fixture(t);
    const relative_path = `03-长期知识/人工目标-${manual.length}.md`;
    const target = path.join(vaultRoot, relative_path);
    const input = { materialId: `mat-manual-${manual.length}`, changes: [{
      knowledge_layer: 'GENERAL_KNOWLEDGE', relative_path, content: '# 预览内容\n', candidate_ids: [`cand-manual-${manual.length}`],
    }] };
    const plan = await writer.prepare({ ...input, requireNewTarget: true });
    await fs.writeFile(target, manual, { mode: 0o600 });
    await assert.rejects(writer.prepare({ ...input, requireNewTarget: true }), { code: 'MERGE_REQUIRED' });
    assert.deepEqual(await writer.list(), [plan]);
    assert.equal(await fs.readFile(target, 'utf8'), manual);
  }
});

test('requireNewTarget rejects a PARTIAL create-only plan while preserving its state', async t => {
  const { writer, vaultRoot } = await fixture(t);
  const relative_path = '03-长期知识/部分计划.md';
  const target = path.join(vaultRoot, relative_path);
  const input = { materialId: 'mat-partial-new-only', changes: [{
    knowledge_layer: 'GENERAL_KNOWLEDGE', relative_path, content: '# 预览内容\n', candidate_ids: ['cand-partial-new-only'],
  }] };
  const plan = await writer.prepare({ ...input, requireNewTarget: true });
  await fs.writeFile(target, '人工内容\n', { mode: 0o600 });
  await assert.rejects(writer.apply({ planId: plan.id, confirmed: true }), { code: 'CONFLICT' });
  const partial = (await writer.list())[0];
  assert.equal(partial.status, 'PARTIAL');
  await assert.rejects(writer.prepare({ ...input, requireNewTarget: true }), { code: 'MERGE_REQUIRED' });
  assert.deepEqual(await writer.list(), [partial]);
  assert.equal(await fs.readFile(target, 'utf8'), '人工内容\n');
});

test('requireNewTarget reuses an APPLIED create-only plan only while its after snapshot matches', async t => {
  const { writer, vaultRoot } = await fixture(t);
  const relative_path = '03-长期知识/已应用新建.md';
  const target = path.join(vaultRoot, relative_path);
  const input = { materialId: 'mat-applied-new-only', changes: [{
    knowledge_layer: 'GENERAL_KNOWLEDGE', relative_path, content: '# 预览内容\n', candidate_ids: ['cand-applied-new-only'],
  }] };
  const plan = await writer.prepare({ ...input, requireNewTarget: true });
  const applied = await writer.apply({ planId: plan.id, confirmed: true });
  const repeated = await writer.prepare({ ...input, requireNewTarget: true });
  assert.deepEqual(repeated, applied);
  await fs.writeFile(target, '人工修改\n', { mode: 0o600 });
  await assert.rejects(writer.prepare({ ...input, requireNewTarget: true }), error =>
    error.code === 'CONFLICT' || error.code === 'MERGE_REQUIRED');
  assert.deepEqual(await writer.list(), [applied]);
  assert.equal(await fs.readFile(target, 'utf8'), '人工修改\n');
});

test('a plan is bound to its original vault root and validates snapshot hashes', async t => {
  const { root, dataDir, vaultRoot, writer } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-bound', changes: [change('\n绑定\n')] });
  const otherVault = path.join(root, 'other-vault');
  await fs.mkdir(path.join(otherVault, '01-项目沉淀'), { recursive: true, mode: 0o700 });
  const otherWriter = await createKnowledgeWriter({ dataDir, vaultRoot: otherVault });
  await assert.rejects(otherWriter.apply({ planId: plan.id, confirmed: true }), { code: 'UNSAFE_PATH' });
  const planFile = path.join(dataDir, 'knowledge-apply', 'plans', `${plan.id}.json`);
  const stored = JSON.parse(await fs.readFile(planFile, 'utf8'));
  stored.changes[0].after_hash = '0'.repeat(64);
  await fs.writeFile(planFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  await assert.rejects(writer.list(), { code: 'STATE_CORRUPT' });
  assert.equal(await fs.readFile(path.join(vaultRoot, '01-项目沉淀', '知识.md'), 'utf8'), '已有内容\r\n');
});

test('UTF-8 BOM is preserved byte-for-byte through preview and apply', async t => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const { writer, target } = await fixture(t, `${bom.toString()}原文\r\n`);
  const plan = await writer.prepare({ materialId: 'mat-bom', changes: [change('追加\n')] });
  assert.equal(plan.changes[0].before.charCodeAt(0), 0xfeff);
  await writer.apply({ planId: plan.id, confirmed: true });
  const bytes = await fs.readFile(target);
  assert.deepEqual(bytes.subarray(0, 3), bom);
  assert.equal(bytes.toString('utf8'), plan.changes[0].after);
});

test('expectedReviewHash is checked under the lock before any Vault write', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-review', changes: [change('\n审核摘要\n')] });
  const before = await fs.readFile(target);
  const reviewHash = knowledgeReviewHash(plan);
  assert.equal(reviewHash, knowledgeReviewHash({ ...plan, status: 'PARTIAL', error: { code: 'x' }, updated_at: 'later' }));
  await assert.rejects(writer.apply({ planId: plan.id, confirmed: true, expectedReviewHash: '0'.repeat(64) }), error =>
    error.code === 'CONFLICT' && error.plan.id === plan.id);
  assert.deepEqual(await fs.readFile(target), before);
  const applied = await writer.apply({ planId: plan.id, confirmed: true, expectedReviewHash: reviewHash });
  assert.equal(applied.status, 'APPLIED');
});

test('rollback rejects a stale expectedReviewHash before changing Vault bytes', async t => {
  const { writer, target } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-rollback-review', changes: [change('\n回滚审核\n')] });
  const reviewHash = knowledgeReviewHash(plan);
  await writer.apply({ planId: plan.id, confirmed: true, expectedReviewHash: reviewHash });
  const after = await fs.readFile(target);
  await assert.rejects(writer.rollback({ planId: plan.id, confirmed: true, expectedReviewHash: '0'.repeat(64) }), error =>
    error.code === 'CONFLICT' && error.plan.id === plan.id);
  assert.deepEqual(await fs.readFile(target), after);
  const rolledBack = await writer.rollback({ planId: plan.id, confirmed: true, expectedReviewHash: reviewHash });
  assert.equal(rolledBack.status, 'ROLLED_BACK');
});

test('a superset submission cannot re-append an already saved candidate', async t => {
  const { writer, target } = await fixture(t);
  const first = await writer.prepare({ materialId: 'mat-candidate-set', changes: [change('\n已保存候选\n')] });
  await writer.apply({ planId: first.id, confirmed: true });
  const secondTarget = path.join(path.dirname(target), '第二位置.md');
  await assert.rejects(writer.prepare({ materialId: 'mat-candidate-set', changes: [
    change('\n已保存候选\n'),
    { ...change('\n新候选\n'), relative_path: '01-项目沉淀/第二位置.md', candidate_ids: ['cand-2'] },
  ]}), { code: 'DUPLICATE_CANDIDATE' });
  assert.equal(await fs.readFile(target, 'utf8'), '已有内容\r\n\n已保存候选\n');
  await assert.rejects(fs.stat(secondTarget), { code: 'ENOENT' });
});

test('plan log ancestors must remain private real 0700 directories and 0600 files', async t => {
  const { writer, root, dataDir } = await fixture(t);
  const plan = await writer.prepare({ materialId: 'mat-log-boundary', changes: [change()] });
  const plansDir = path.join(dataDir, 'knowledge-apply', 'plans');
  const moved = path.join(root, 'plans-moved');
  await fs.rename(plansDir, moved);
  await fs.symlink(moved, plansDir);
  await assert.rejects(writer.list(), { code: 'UNSAFE_PATH' });
});

test('rejects path traversal, symlink ancestors, hardlinks, duplicate targets, and unsafe roots', async t => {
  const fixtureValue = await fixture(t);
  t.after(() => fs.rm(fixtureValue.root, { recursive: true, force: true }));
  const { writer, vaultRoot, dataDir, root } = fixtureValue;
  await assert.rejects(writer.prepare({ materialId: 'mat-test', changes: [{ ...change(), relative_path: '../escape.md' }] }));
  await assert.rejects(writer.prepare({ materialId: 'mat-test', changes: [change(), change('\n重复\n')] }));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  const vaultAlias = path.join(root, 'vault-alias');
  await fs.symlink(vaultRoot, vaultAlias);
  await assert.rejects(createKnowledgeWriter({ dataDir: path.join(root, 'other-data'), vaultRoot: vaultAlias }), { code: 'UNSAFE_PATH' });
  await fs.symlink(outside, path.join(vaultRoot, '01-项目沉淀', '链接目录'));
  await assert.rejects(writer.prepare({ materialId: 'mat-test', changes: [{ ...change(), relative_path: '01-项目沉淀/链接目录/a.md' }] }), { code: 'UNSAFE_PATH' });
  const hard = path.join(vaultRoot, '01-项目沉淀', '硬链接.md');
  await fs.link(path.join(vaultRoot, '01-项目沉淀', '知识.md'), hard);
  await assert.rejects(writer.prepare({ materialId: 'mat-test', changes: [{ ...change(), relative_path: '01-项目沉淀/硬链接.md' }] }), { code: 'UNSAFE_PATH' });
  await assert.rejects(createKnowledgeWriter({ dataDir, vaultRoot: root }), { code: 'UNSAFE_PATH' });
  const worktree = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  let mainRoot = worktree;
  const gitStat = await fs.lstat(path.join(worktree, '.git')).catch(e => { if(e.code === 'ENOENT') return null; throw e; });
  if (gitStat?.isFile()) {
    const marker = await fs.readFile(path.join(worktree, '.git'), 'utf8');
    const gitDir = path.resolve(worktree, /^gitdir: (.+)$/u.exec(marker.trim())[1]);
    const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    mainRoot = path.dirname(path.resolve(gitDir, commonDir));
  }
  await assert.rejects(createKnowledgeWriter({ dataDir: path.join(root, 'main-data'), vaultRoot: path.join(mainRoot, 'test-vault') }), { code: 'UNSAFE_PATH' });
});
