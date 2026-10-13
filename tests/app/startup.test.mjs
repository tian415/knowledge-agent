import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main, demoText, protectedRootsFor } from '../../scripts/start-app.mjs';

async function tempRoot(prefix) {
  return fs.mkdtemp(path.join(await fs.realpath('/tmp'), prefix));
}

async function state(origin) {
  return (await fetch(`${origin}/api/state`)).json();
}

async function post(origin, token, url, body) {
  return fetch(`${origin}${url}`, { method: 'POST', headers: {
    'content-type': 'application/json', origin, 'x-app-token': token,
  }, body: JSON.stringify(body) });
}

test('explicit demo-dir creates a marked private demo and restores materials and feedback after restart', { timeout: 5000 }, async t => {
  const parent = await tempRoot('knowledge-startup-');
  const demoDir = path.join(parent, 'demo');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const first = await main(['--demo-dir', demoDir, '--port', '0']);
  let firstClosed = false;
  t.after(async () => { if (!firstClosed) { firstClosed = true; await first.close(); } });
  const origin = first.origin;
  const firstState = await state(origin);
  assert.equal(firstState.mode, 'demo');
  const materialResponse = await post(origin, first.token, '/api/materials', { raw_content: demoText, source_type: 'text' });
  assert.equal(materialResponse.status, 200);
  const material = await materialResponse.json();
  const afterMaterial = await state(origin);
  const action = afterMaterial.workspace.actions[0];
  assert(action?.id);
  const decided = await post(origin, first.token, '/api/actions/decide', { id: action.id, decision: 'accept', reason: '演示验证' });
  assert.equal(decided.status, 200);
  await first.close();
  firstClosed = true;

  const second = await main(['--demo-dir', demoDir, '--port', '0']);
  t.after(() => second.close());
  const restored = await state(second.origin);
  assert.equal(restored.mode, 'demo');
  assert(restored.materials.some(item => item.id === material.material_id));
  assert.equal(restored.workspace.actions.find(item => item.id === action.id)?.feedback?.decision, 'accept');
  const marker = JSON.parse(await fs.readFile(path.join(demoDir, 'demo.json'), 'utf8'));
  assert.deepEqual(marker, { type: 'knowledge-agent-demo', version: 1 });
  for (const relative of ['data', 'vault']) assert.equal((await fs.lstat(path.join(demoDir, relative))).mode & 0o777, 0o700);
  assert.equal((await fs.lstat(path.join(demoDir, 'demo.json'))).mode & 0o777, 0o600);
});

test('demo-dir rejects unknown non-empty roots and symlink roots without overwriting', async t => {
  const parent = await tempRoot('knowledge-startup-boundary-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const unknown = path.join(parent, 'unknown');
  await fs.mkdir(unknown, { mode: 0o700 });
  await fs.writeFile(path.join(unknown, 'keep.txt'), 'keep', { mode: 0o600 });
  await assert.rejects(main(['--demo-dir', unknown, '--port', '0']), /启动参数|demo|目录|marker/u);
  assert.equal(await fs.readFile(path.join(unknown, 'keep.txt'), 'utf8'), 'keep');
  const real = path.join(parent, 'real'); await fs.mkdir(real, { mode: 0o700 });
  const alias = path.join(parent, 'alias'); await fs.symlink(real, alias);
  await assert.rejects(main(['--demo-dir', alias, '--port', '0']));
});

test('formal mode rejects a data-dir inside a demo root and demo rejects external overrides', async t => {
  const parent = await tempRoot('knowledge-startup-formal-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const demoDir = path.join(parent, 'demo');
  const demo = await main(['--demo-dir', demoDir, '--port', '0']);
  await demo.close();
  await assert.rejects(main(['--data-dir', path.join(demoDir, 'data'), '--vault-root', path.join(parent, 'vault'), '--port', '0']));
  await assert.rejects(main(['--demo', '--demo-dir', path.join(parent, 'other'), '--data-dir', path.join(parent, 'data'), '--port', '0']));
});

test('argument parser rejects duplicates and mixed help without starting a server', async () => {
  await assert.rejects(main(['--demo', '--demo']));
  await assert.rejects(main(['--port', '0', '--port', '0']));
  await assert.rejects(main(['--help', '--port', '0']));
  await assert.rejects(main(['--demo', '--data-dir', path.join('/private/tmp', 'ignored'), '--port', '0']));
});

test('ordinary checkout .git directory is tolerated while its root remains protected', async t => {
  const root = await tempRoot('knowledge-checkout-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'), { mode: 0o700 });
  const roots = await protectedRootsFor(root);
  assert.deepEqual(roots, [root]);
});

test('embedded main calls do not accumulate process signal listeners', async t => {
  const parent = await tempRoot('knowledge-signal-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
  const first = await main(['--demo-dir', path.join(parent, 'one'), '--port', '0']);
  const second = await main(['--demo-dir', path.join(parent, 'two'), '--port', '0']);
  t.after(async () => { await first.close(); await second.close(); });
  assert.equal(process.listenerCount('SIGINT'), before.int);
  assert.equal(process.listenerCount('SIGTERM'), before.term);
});
