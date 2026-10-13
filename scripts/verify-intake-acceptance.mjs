import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMaterial, indexLines } from '../src/intake/material.mjs';
import { validateCachedResult } from '../src/intake/process-material.mjs';

const idPattern = /^mat_[a-f0-9]{64}$/u;
const attemptPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const expectedChecks = Object.freeze({
  A: ['selective_knowledge', 'decision_supported', 'suggestion_not_commitment', 'reversal_respected', 'engineering_context_preserved', 'project_state_not_inflated', 'all_evidence_valid'],
  B: ['zero_new_candidates', 'zero_llm_requests', 'same_material_id', 'result_unchanged'],
  C: ['zero_commitments', 'all_evidence_valid', 'no_external_task_created'],
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorCode = code => ({ code: typeof code === 'string' && /^[A-Z0-9_]+$/u.test(code) ? code : 'INVALID_EVIDENCE' });

function fail(code = 'INVALID_EVIDENCE') { throw Object.assign(new Error(code), errorCode(code)); }
function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--data-dir', '--review'].includes(name) || Object.hasOwn(args, name)) fail('INPUT_INVALID');
    const value = argv[++index];
    if (typeof value !== 'string' || value.startsWith('--')) fail('INPUT_INVALID');
    args[name] = value;
  }
  if (!args['--data-dir'] || !args['--review']) fail('INPUT_INVALID');
  return args;
}

function assertAbsoluteSafe(value, code = 'UNSAFE_PATH') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(code);
  const root = path.parse(value).root;
  if (value.slice(root.length).split(path.sep).filter(Boolean).includes('..')) fail(code);
  return value;
}

async function statSafe(target, expected) {
  assertAbsoluteSafe(target);
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); } catch { fail('MISSING_EVIDENCE'); }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
    if (index < parts.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH');
    if (index === parts.length - 1) {
      if (expected === 'dir' && (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)) fail('UNSAFE_PATH');
      if (expected === 'file' && (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)) fail('UNSAFE_PATH');
    }
  }
  return statSafeResult(target);
}
async function statSafeResult(target) { return fs.lstat(target); }
async function readBytes(target) {
  const before = await statSafe(target, 'file');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const during = await handle.stat();
    if (!during.isFile() || during.nlink !== 1 || during.ino !== before.ino || during.dev !== before.dev || (during.mode & 0o777) !== 0o600) fail('UNSAFE_PATH');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function readJson(target) {
  let bytes;
  try { bytes = await readBytes(target); } catch (error) { if (error?.code) throw error; fail('MISSING_EVIDENCE'); }
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_EVIDENCE'); }
}
async function sha256(target) { return createHash('sha256').update(await readBytes(target)).digest('hex'); }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split('/').includes('..') || value.split('\\').includes('..') || value.startsWith('/')) fail('UNSAFE_PATH');
  return value;
}
function under(root, relative) { safeRelative(relative); return path.join(root, ...relative.split('/')); }
function metricsValid(metrics) {
  return object(metrics) && metrics.llm_requests === 1 && metrics.sdk_turns === 0 && metrics.underlying_model_requests === null &&
    Number.isInteger(metrics.input_bytes) && metrics.input_bytes >= 0 && Number.isFinite(metrics.elapsed_ms) && metrics.elapsed_ms >= 0 &&
    (metrics.usage === null || object(metrics.usage));
}
function materialValid(material) {
  if (!object(material) || typeof material.raw_content !== 'string') return false;
  try {
    const identity = createMaterial(material);
    return identity.material_id === material.material_id && identity.content_hash === material.content_hash && idPattern.test(material.material_id);
  } catch { return false; }
}
function evidenceValid(result, material) {
  if (!object(result) || !Array.isArray(result.knowledge_candidates) || !Array.isArray(result.action_candidates)) return false;
  const lines = indexLines(material.raw_content);
  for (const candidate of [...result.knowledge_candidates, ...result.action_candidates]) {
    if (!object(candidate) || candidate.material_id !== material.material_id || !Array.isArray(candidate.evidence) || candidate.evidence.length === 0) return false;
    for (const item of candidate.evidence) {
      if (!object(item) || !Number.isInteger(item.line_start) || !Number.isInteger(item.line_end) || item.line_start < 1 || item.line_end < item.line_start || item.line_end > lines.length) return false;
      const source = lines.slice(item.line_start - 1, item.line_end).map(line => line.text).join('\n');
      if (item.snippet !== source) return false;
    }
  }
  return true;
}
function manualReview(item, caseName) {
  const names = expectedChecks[caseName];
  const checks = object(item.checks) ? item.checks : {};
  const allTrue = names.every(name => checks[name] === true) && Object.keys(checks).every(name => names.includes(name));
  const reviewer = typeof item.reviewer === 'string' && /\S/u.test(item.reviewer);
  const reviewedAt = typeof item.reviewed_at === 'string' && Number.isFinite(Date.parse(item.reviewed_at));
  return { pass: allTrue && reviewer && reviewedAt, checks: Object.fromEntries(names.map(name => [name, checks[name] === true])), reviewer, reviewed_at: reviewedAt };
}
function baseCaseReport(item, caseName) {
  const manual = manualReview(item, caseName);
  return { case: caseName, mechanical: { pass: false, checks: {} }, manual, errors: [] };
}

async function readMaterialResult(root, materialId) {
  if (typeof materialId !== 'string' || !idPattern.test(materialId)) fail('INVALID_REVIEW');
  const material = await readJson(path.join(root, 'materials', materialId, 'material.json'));
  const result = await readJson(path.join(root, 'materials', materialId, 'result.json'));
  return { material, result };
}
function resultValid(result, material) {
  if (!(object(result) && result.stage === 'PREVIEW_READY' && result.material_id === material.material_id && result.content_hash === material.content_hash && metricsValid(result.metrics) && evidenceValid(result, material))) return false;
  try { validateCachedResult(result, material); return true; } catch { return false; }
}
async function attemptChecks(root, item, material, result) {
  if (!Array.isArray(item.attempt_ids) || item.attempt_ids.length !== 1 || new Set(item.attempt_ids).size !== item.attempt_ids.length) return false;
  for (const id of item.attempt_ids) {
    if (typeof id !== 'string' || !attemptPattern.test(id)) return false;
    const attempt = await readJson(path.join(root, 'attempts', `${id}.json`));
    if (!object(attempt) || attempt.attempt_id !== id || attempt.material_id !== material.material_id || attempt.status !== 'COMPLETED' || !object(attempt.details) || attempt.details.status !== 'COMPLETED' || !isDeepStrictEqual(attempt.details.metrics, result.metrics)) return false;
  }
  return true;
}
async function verifyNewCase(root, item, caseName, usedAttempts) {
  const report = baseCaseReport(item, caseName);
  try {
    const { material, result } = await readMaterialResult(root, item.material_id);
    report.mechanical.checks.material_hash = materialValid(material) && material.material_id === item.material_id;
    report.mechanical.checks.result_preview_ready = resultValid(result, material);
    report.mechanical.checks.metrics = metricsValid(result.metrics);
    report.mechanical.checks.exact_evidence = evidenceValid(result, material);
    report.mechanical.checks.attempts_completed = await attemptChecks(root, item, material, result);
    report.mechanical.checks.attempts_unique = Array.isArray(item.attempt_ids) && item.attempt_ids.every(id => !usedAttempts.has(id));
    for (const id of item.attempt_ids ?? []) usedAttempts.add(id);
    if (caseName === 'C') report.mechanical.checks.zero_commitments = result.action_candidates.filter(candidate => candidate.type === 'COMMITMENT').length === 0;
    report.mechanical.pass = Object.values(report.mechanical.checks).every(Boolean);
    if (!report.mechanical.pass) report.errors.push('mechanical_check_failed');
    return { material, result, report };
  } catch (error) {
    report.errors.push(error?.code === 'MISSING_EVIDENCE' ? 'missing_evidence' : 'mechanical_check_failed');
    return { material: null, result: null, report };
  }
}

function inventoryShape(value) {
  if (!object(value)) return false;
  return Object.entries(value).every(([name, hash]) => typeof name === 'string' && hashPattern.test(hash) && /^(?:attempts|materials|receipts)\/[^/]+(?:\/[^/]+)*$/u.test(name) && !name.split('/').includes('..'));
}
async function verifyB(root, item, reviewPath) {
  const report = baseCaseReport(item, 'B');
  try {
    if (typeof item.material_id !== 'string' || !idPattern.test(item.material_id)) fail('INVALID_REVIEW');
    if (typeof item.evidence_dir !== 'string') fail('MISSING_EVIDENCE');
    const evidenceDir = path.isAbsolute(item.evidence_dir) ? assertAbsoluteSafe(item.evidence_dir) : path.join(path.dirname(reviewPath), safeRelative(item.evidence_dir));
    await statSafe(evidenceDir, 'dir');
    const before = await readJson(path.join(evidenceDir, 'before.json'));
    const after = await readJson(path.join(evidenceDir, 'after.json'));
    const execution = await readJson(path.join(evidenceDir, 'execution.json'));
    const stdout = (await readBytes(path.join(evidenceDir, 'stdout.md'))).toString('utf8');
    const resultPath = path.join(root, 'materials', item.material_id, 'result.json');
    const materialPath = path.join(root, 'materials', item.material_id, 'material.json');
    const resultHash = await sha256(resultPath);
    const material = await readJson(materialPath);
    const beforeFiles = inventoryShape(before.files) ? before.files : null;
    const afterFiles = inventoryShape(after.files) ? after.files : null;
    const oldNames = beforeFiles ? Object.keys(beforeFiles) : [];
    const newNames = afterFiles ? Object.keys(afterFiles) : [];
    const added = newNames.filter(name => !Object.hasOwn(beforeFiles ?? {}, name));
    const unchanged = Boolean(beforeFiles && afterFiles && oldNames.length > 0 && oldNames.every(name => afterFiles[name] === beforeFiles[name]));
    const currentHashes = afterFiles ? await Promise.all(Object.entries(afterFiles).map(async ([name, hash]) => (await sha256(under(root, name))) === hash)) : [];
    const receiptBefore = Array.isArray(before.receipts) ? before.receipts : [];
    const receiptAfter = Array.isArray(after.receipts) ? after.receipts : [];
    const receiptAdded = receiptAfter.filter(name => !receiptBefore.includes(name));
    const evidenceAttemptIds = Array.isArray(after.attempts) ? after.attempts.map(name => typeof name === 'string' && name.startsWith('attempts/') && name.endsWith('.json') ? name.slice('attempts/'.length, -'.json'.length) : '') : [];
    const listedAttemptIds = Array.isArray(item.attempt_ids) ? item.attempt_ids : [];
    const requiredFiles = [`attempts/${listedAttemptIds[0] ?? ''}.json`, `materials/${item.material_id}/material.json`, `materials/${item.material_id}/result.json`];
    const attemptsListed = listedAttemptIds.length === 1 && new Set(listedAttemptIds).size === 1 && listedAttemptIds.every(id => attemptPattern.test(id)) && Array.isArray(before.attempts) && Array.isArray(after.attempts) && before.attempts.length === 1 && after.attempts.length === 1 && isDeepStrictEqual([...new Set(evidenceAttemptIds)].sort(), [...new Set(listedAttemptIds)].sort());
    const requiredFilesPresent = Boolean(beforeFiles && afterFiles && requiredFiles.every(name => Object.hasOwn(beforeFiles, name) && Object.hasOwn(afterFiles, name)));
    report.mechanical.checks.evidence_files = Boolean(requiredFilesPresent && before.material_id === item.material_id && after.material_id === item.material_id && before.result_sha256 === after.result_sha256 && after.result_sha256 === resultHash && before.sample_sha256 === material.content_hash && after.sample_sha256 === material.content_hash);
    report.mechanical.checks.execution_boundary = object(execution) && execution.cli_exit_code === 0 && execution.unexpected_error === false && execution.fetch_boundary_attempts === 0 && execution.real_network_requests === 0;
    report.mechanical.checks.stdout_no_change = /^status:\s*NO_CHANGE\s*$/mu.test(stdout) && /^llm_requests:\s*0\s*$/mu.test(stdout) && /New knowledge\/action candidates:\s*0\s*\/\s*0/u.test(stdout);
    report.mechanical.checks.state_diff = attemptsListed && unchanged && added.length === 1 && added[0].startsWith('receipts/') && receiptAfter.length === receiptBefore.length + 1 && receiptAdded.length === 1 && receiptAdded[0] === added[0] && before.attempts?.join('\n') === after.attempts?.join('\n') && currentHashes.every(Boolean);
    report.mechanical.pass = Object.values(report.mechanical.checks).every(Boolean);
    if (!report.mechanical.pass) report.errors.push('mechanical_check_failed');
  } catch (error) { report.errors.push(error?.code === 'MISSING_EVIDENCE' ? 'missing_evidence' : 'mechanical_check_failed'); }
  return report;
}

async function main(argv = process.argv.slice(2)) {
  let report;
  try {
    const args = parseArgs(argv);
    if (args.help) { process.stdout.write('Usage: node scripts/verify-intake-acceptance.mjs --data-dir <private-store> --review <private-review.json>\n'); return 0; }
    const dataDir = assertAbsoluteSafe(args['--data-dir']);
    await statSafe(dataDir, 'dir');
    const reviewPath = assertAbsoluteSafe(args['--review']);
    await statSafe(reviewPath, 'file');
    const review = await readJson(reviewPath);
    if (!object(review) || !Array.isArray(review.cases)) fail('INVALID_REVIEW');
    const byCase = new Map();
    for (const item of review.cases) {
      if (!object(item) || !['A', 'B', 'C'].includes(item.case) || byCase.has(item.case)) fail('INVALID_REVIEW');
      byCase.set(item.case, item);
    }
    report = { status: 'INCOMPLETE', mechanical: { pass: true }, manual: { pass: true }, cases: [], errors: [] };
    for (const name of ['A', 'B', 'C']) if (!byCase.has(name)) { report.errors.push(`missing_case_${name}`); report.mechanical.pass = false; report.manual.pass = false; }
    const usedAttempts = new Set();
    const a = byCase.get('A');
    if (a) {
      const checked = await verifyNewCase(dataDir, a, 'A', usedAttempts);
      report.cases.push(checked.report);
      if (!checked.report.mechanical.pass) report.mechanical.pass = false;
      if (!checked.report.manual.pass) report.manual.pass = false;
    }
    const b = byCase.get('B');
    if (b) {
      let checked;
      if (a && b.material_id !== a.material_id) {
        checked = baseCaseReport(b, 'B');
        checked.errors.push('material_id_mismatch');
        report.errors.push('case_B_material_id_mismatch');
      } else checked = await verifyB(dataDir, b, reviewPath);
      report.cases.push(checked);
      if (!checked.mechanical.pass) report.mechanical.pass = false;
      if (!checked.manual.pass) report.manual.pass = false;
    }
    const c = byCase.get('C');
    if (c) {
      const cRoot = c.data_dir === undefined ? dataDir : assertAbsoluteSafe(c.data_dir);
      await statSafe(cRoot, 'dir');
      if (a && c.material_id === a.material_id) { report.errors.push('case_C_material_id_reused'); report.mechanical.pass = false; }
      const checked = await verifyNewCase(cRoot, c, 'C', usedAttempts);
      report.cases.push(checked.report);
      if (!checked.report.mechanical.pass) report.mechanical.pass = false;
      if (!checked.report.manual.pass) report.manual.pass = false;
    }
    for (const item of report.cases) if (item.errors.length) report.errors.push(`${item.case}:${item.errors[0]}`);
    report.status = report.mechanical.pass && report.manual.pass && report.errors.length === 0 ? 'PASS' : 'INCOMPLETE';
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    const code = error?.code ?? 'INCOMPLETE';
    report = { status: 'INCOMPLETE', mechanical: { pass: false }, manual: { pass: false }, cases: [], errors: [errorCode(code).code] };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
export { main };
