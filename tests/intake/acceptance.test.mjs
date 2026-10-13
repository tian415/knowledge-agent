import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createMaterial } from '../../src/intake/material.mjs';

const script = path.resolve('scripts/verify-intake-acceptance.mjs');
const A_CHECKS = {
  selective_knowledge: true,
  decision_supported: true,
  suggestion_not_commitment: true,
  reversal_respected: true,
  engineering_context_preserved: true,
  project_state_not_inflated: true,
  all_evidence_valid: true,
};
const B_CHECKS = {
  zero_new_candidates: true,
  zero_llm_requests: true,
  same_material_id: true,
  result_unchanged: true,
};
const C_CHECKS = { zero_commitments: true, all_evidence_valid: true, no_external_task_created: true };

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
async function sha256(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function storeFixture(t, { commitment = true, rawSuffix = '' } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'intake-acceptance-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const raw = `User: 我决定先验证${rawSuffix}。\nAssistant: 这是一个建议。`;
  const material = createMaterial({ raw_content: raw, source_type: 'text' });
  const materialFile = path.join(root, 'materials', material.material_id, 'material.json');
  const resultFile = path.join(root, 'materials', material.material_id, 'result.json');
  await writeJson(materialFile, material);
  const evidence = [{ line_start: 1, line_end: 1, snippet: `User: 我决定先验证${rawSuffix}。` }];
  const result = {
    material_id: material.material_id,
    content_hash: material.content_hash,
    stage: 'PREVIEW_READY',
    knowledge_candidates: [{
      material_id: material.material_id,
      knowledge_layer: 'ENGINEERING_THINKING', title: '验证', content: '先验证', reason: '保留依据',
      route: { route_type: null, route_id: null, route_name: null }, evidence,
      location: { directory: '02-方法论/工程思维/', target_path: null, review_required: true, reason: 'synthetic' },
    }],
    action_candidates: commitment ? [{
      material_id: material.material_id, action: '验证', type: 'COMMITMENT', status: 'PROPOSED',
      reason: '用户决定', related: { route_type: null, route_id: null, route_name: null }, evidence,
    }] : [],
    markdown: '# preview',
    metrics: { llm_requests: 1, sdk_turns: 0, input_bytes: 12, elapsed_ms: 1, usage: null, underlying_model_requests: null },
  };
  await writeJson(resultFile, result);
  const attemptId = randomUUID();
  await writeJson(path.join(root, 'attempts', `${attemptId}.json`), {
    attempt_id: attemptId, material_id: material.material_id, started_at: '2026-09-10T01:00:00.000Z',
    budget_date: '2026-09-10', status: 'COMPLETED', details: { status: 'COMPLETED', metrics: result.metrics },
  });
  await writeJson(path.join(root, 'receipts', 'receipt-before.json'), { material_id: material.material_id });
  return { root, material, result, attemptId, materialFile, resultFile };
}

async function inventory(store, fixture, receipts = ['receipts/receipt-before.json']) {
  const files = {};
  const names = [
    `attempts/${fixture.attemptId}.json`,
    `materials/${fixture.material.material_id}/material.json`,
    `materials/${fixture.material.material_id}/result.json`,
    ...receipts,
  ];
  for (const name of names) files[name] = await sha256(path.join(store, name));
  return files;
}
async function makeReview(t, { includeC = true, manual = true, forged = false } = {}) {
  const a = await storeFixture(t);
  const c = await storeFixture(t, { commitment: false, rawSuffix: '另一份材料' });
  const beforeFiles = await inventory(a.root, a);
  const before = {
    material_id: a.material.material_id,
    result_path: a.resultFile,
    result_sha256: await sha256(a.resultFile),
    sample_sha256: a.material.content_hash,
    attempts: [`attempts/${a.attemptId}.json`],
    receipts: ['receipts/receipt-before.json'],
    files: beforeFiles,
  };
  await writeJson(path.join(a.root, 'receipts', 'receipt-after.json'), { material_id: a.material.material_id });
  const afterFiles = await inventory(a.root, a, ['receipts/receipt-before.json', 'receipts/receipt-after.json']);
  const after = { ...before, receipts: [...before.receipts, 'receipts/receipt-after.json'], files: afterFiles };
  const evidenceDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'intake-acceptance-evidence-'));
  await fs.chmod(evidenceDir, 0o700);
  t.after(() => fs.rm(evidenceDir, { recursive: true, force: true }));
  await writeJson(path.join(evidenceDir, 'before.json'), before);
  await writeJson(path.join(evidenceDir, 'after.json'), after);
  await writeJson(path.join(evidenceDir, 'execution.json'), { cli_exit_code: 0, unexpected_error: false, fetch_boundary_attempts: 0, real_network_requests: 0 });
  const stdout = '# Material Intake Preview\nstatus: NO_CHANGE\nllm_requests: 0\nNew knowledge/action candidates: 0 / 0\n';
  await fs.writeFile(path.join(evidenceDir, 'stdout.md'), stdout, { mode: 0o600 });
  if (forged) {
    const broken = { ...a.result, knowledge_candidates: [{ ...a.result.knowledge_candidates[0], evidence: [{ ...a.result.knowledge_candidates[0].evidence[0], snippet: 'forged' }] }] };
    await writeJson(a.resultFile, broken);
  }
  const reviewer = manual ? 'tester' : '';
  const reviewedAt = manual ? '2026-09-12T10:00:00.000Z' : '';
  const cases = [
    { case: 'A', material_id: a.material.material_id, attempt_ids: [a.attemptId], checks: manual ? A_CHECKS : { ...A_CHECKS, all_evidence_valid: false }, reviewer, reviewed_at: reviewedAt },
    { case: 'B', material_id: a.material.material_id, attempt_ids: [a.attemptId], evidence_dir: evidenceDir, checks: B_CHECKS, reviewer, reviewed_at: reviewedAt },
  ];
  if (includeC) cases.push({ case: 'C', material_id: c.material.material_id, data_dir: c.root, attempt_ids: [c.attemptId], checks: C_CHECKS, reviewer, reviewed_at: reviewedAt });
  const review = path.join(evidenceDir, 'review.json');
  await writeJson(review, { cases });
  return { review, a, c };
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: path.resolve('.') });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('acceptance verifier passes complete deterministic A/B/C synthetic evidence', async t => {
  const f = await makeReview(t);
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.cases.map(c => c.case), ['A', 'B', 'C']);
  assert.equal(report.cases[0].mechanical.pass, true);
  assert.equal(report.cases[0].manual.pass, true);
});

test('acceptance verifier fails closed for missing case or incomplete manual review', async t => {
  const missing = await makeReview(t, { includeC: false });
  const missingResult = await run(['--data-dir', missing.a.root, '--review', missing.review]);
  assert.equal(missingResult.code, 1);
  assert.match(missingResult.stdout, /missing_case_C/);
  const incomplete = await makeReview(t, { manual: false });
  const incompleteResult = await run(['--data-dir', incomplete.a.root, '--review', incomplete.review]);
  assert.equal(incompleteResult.code, 1);
  assert.match(incompleteResult.stdout, /manual/);
});

test('acceptance verifier rejects forged exact-line evidence', async t => {
  const f = await makeReview(t, { forged: true });
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /evidence/);
  assert.doesNotMatch(result.stdout, /User:|Assistant:|先验证/);
});

test('acceptance verifier rejects B evidence with network or new-attempt drift', async t => {
  const f = await makeReview(t);
  const executionFile = path.join(path.dirname(f.review), 'execution.json');
  await writeJson(executionFile, { cli_exit_code: 0, unexpected_error: false, fetch_boundary_attempts: 1, real_network_requests: 0 });
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fetch|mechanical/);
});

test('acceptance verifier requires exactly one completed attempt for A and C', async t => {
  const f = await makeReview(t);
  const review = JSON.parse(await fs.readFile(f.review, 'utf8'));
  const duplicateId = randomUUID();
  await writeJson(path.join(f.a.root, 'attempts', `${duplicateId}.json`), {
    attempt_id: duplicateId, material_id: f.a.material.material_id, started_at: '2026-09-10T02:00:00.000Z',
    budget_date: '2026-09-10', status: 'COMPLETED', details: { status: 'COMPLETED', metrics: f.a.result.metrics },
  });
  review.cases.find(item => item.case === 'A').attempt_ids.push(duplicateId);
  await writeJson(f.review, review);
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /attempts_completed|mechanical/);
});

test('acceptance verifier applies the persisted candidate schema', async t => {
  const f = await makeReview(t);
  const result = { ...f.c.result, knowledge_candidates: [{ ...f.c.result.knowledge_candidates[0] }] };
  delete result.knowledge_candidates[0].title;
  await writeJson(f.c.resultFile, result);
  const check = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(check.code, 1);
  const report = JSON.parse(check.stdout);
  assert.equal(report.cases.find(item => item.case === 'C').mechanical.checks.result_preview_ready, false);
});

test('acceptance verifier requires B to reuse A material identity', async t => {
  const f = await makeReview(t);
  const review = JSON.parse(await fs.readFile(f.review, 'utf8'));
  review.cases.find(item => item.case === 'B').material_id = f.c.material.material_id;
  await writeJson(f.review, review);
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /case_B_material_id_mismatch/);
});

test('acceptance verifier compares both B sample hashes to current material', async t => {
  const f = await makeReview(t);
  const afterFile = path.join(path.dirname(f.review), 'after.json');
  const after = JSON.parse(await fs.readFile(afterFile, 'utf8'));
  after.sample_sha256 = '0'.repeat(64);
  await writeJson(afterFile, after);
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cases.find(item => item.case === 'B').mechanical.checks.evidence_files, false);
});

test('acceptance verifier requires B inventories to name material, result, and attempt files', async t => {
  const f = await makeReview(t);
  const afterFile = path.join(path.dirname(f.review), 'after.json');
  const after = JSON.parse(await fs.readFile(afterFile, 'utf8'));
  delete after.files[`materials/${f.a.material.material_id}/result.json`];
  await writeJson(afterFile, after);
  const result = await run(['--data-dir', f.a.root, '--review', f.review]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cases.find(item => item.case === 'B').mechanical.checks.evidence_files, false);
});
