import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/intake/store.mjs';
import { createMaterial } from '../../src/intake/material.mjs';
import { VAULT_PATH } from '../../src/registry/load-registry.mjs';

const material = createMaterial({ raw_content: 'User: 原文\r\n\nAssistant: 回答\n', source_type: 'text' });
const result = () => ({ material_id: material.material_id, content_hash: material.content_hash,
  stage: 'PREVIEW_READY', knowledge_candidates: [], action_candidates: [], markdown: '# Preview\n',
  metrics: { sdk_turns: 1, input_bytes: 40, elapsed_ms: 1, usage: null, underlying_model_requests: null } });
const materialPath = root => path.join(root, 'materials', material.material_id, 'material.json');
const resultPath = root => path.join(root, 'materials', material.material_id, 'result.json');
const readJSON = async p => JSON.parse(await fs.readFile(p, 'utf8'));
async function fixture(t) {
  // realpath avoids macOS /var and /tmp aliases; every write is in this temporary tree.
  const root = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'intake-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore(root);
  await store.acquireLock();
  t.after(() => store.releaseLock());
  return {root,store};
}

test('material round trips exactly; repeat saves are immutable and raw-only has no result', async t => {
  const {root,store}=await fixture(t);
  await store.saveMaterial(material);
  const before=await fs.readFile(materialPath(root));
  assert.deepEqual(await readJSON(materialPath(root)),material);
  assert.equal((await readJSON(materialPath(root))).raw_content,material.raw_content);
  await store.saveMaterial(material);
  await store.saveMaterial({...material,source_title:'second source'});
  assert.deepEqual(await fs.readFile(materialPath(root)),before);
  assert.equal(await store.readResult(material.material_id),null);
  await assert.rejects(store.saveMaterial({...material,raw_content:'different'}));
  assert.deepEqual(await fs.readFile(materialPath(root)),before);
});
test('receipts retain independent metadata without overwriting first source', async t => {
  const {root,store}=await fixture(t); await store.saveMaterial(material);
  const a=await store.addReceipt(material,new Date('2026-09-10T00:00:00Z'));
  const b=await store.addReceipt({...material,source_type:'codex',source_title:'second',source_id:'provided'},new Date('2026-09-10T01:00:00Z'));
  assert.notEqual(a,b);
  const receipts=await Promise.all((await fs.readdir(path.join(root,'receipts'))).map(n=>readJSON(path.join(root,'receipts',n))));
  assert.equal(receipts.length,2);
  assert(receipts.some(x=>x.source_title===null && x.source_type==='text'));
  assert(receipts.some(x=>x.source_title==='second' && x.source_id==='provided' && x.received_at==='2026-09-10T01:00:00.000Z'));
  assert(receipts.every(x=>x.material_id===material.material_id));
  assert.equal((await readJSON(materialPath(root))).source_title,null);
});
test('complete result round trips; successful result cannot be overwritten', async t => {
  const {root,store}=await fixture(t); await store.saveMaterial(material);
  await store.saveResult(material.material_id,result());
  assert.deepEqual(await store.readResult(material.material_id),result());
  const before=await fs.readFile(resultPath(root));
  await store.saveResult(material.material_id,result());
  await assert.rejects(store.saveResult(material.material_id,{...result(),markdown:'changed'}));
  assert.deepEqual(await fs.readFile(resultPath(root)),before);
});
for (const [name,content] of [['JSON','{'],['null','null'],['hash',JSON.stringify({...material,content_hash:'0'.repeat(64)})]]) {
  test(`corrupt material ${name} is rejected and retained`,async t=>{
    const {root,store}=await fixture(t); await store.saveMaterial(material);
    await fs.writeFile(materialPath(root),content);
    await assert.rejects(store.readResult(material.material_id),{code:'STATE_CORRUPT'});
    await assert.rejects(store.saveMaterial(material),{code:'STATE_CORRUPT'});
    assert.equal(await fs.readFile(materialPath(root),'utf8'),content);
  });
}
for (const [name,content] of [['JSON','{'],['null','null'],['identity',JSON.stringify({...result(),material_id:'mat_'+'0'.repeat(64)})],['structure',JSON.stringify({stage:'PREVIEW_READY'})]]) {
  test(`corrupt result ${name} is rejected and retained`,async t=>{
    const {root,store}=await fixture(t); await store.saveMaterial(material);
    await fs.writeFile(resultPath(root),content,{mode:0o600});
    await assert.rejects(store.readResult(material.material_id),{code:'STATE_CORRUPT'});
    await assert.rejects(store.saveResult(material.material_id,result()),{code:'STATE_CORRUPT'});
    assert.equal(await fs.readFile(resultPath(root),'utf8'),content);
  });
}
test('invalid result is rejected before a success file is created',async t=>{
  const {root,store}=await fixture(t); await store.saveMaterial(material);
  for(const invalid of [{...result(),content_hash:'wrong'},{...result(),stage:'STARTED'},{...result(),markdown:null},{...result(),knowledge_candidates:null},{...result(),metrics:null},{...result(),metrics:{}},{...result(),metrics:{...result().metrics,sdk_turns:2}}]) await assert.rejects(store.saveResult(material.material_id,invalid));
  await assert.rejects(fs.stat(resultPath(root)),{code:'ENOENT'});
});
test('lock contention rejects, release permits reacquisition, nonowner cannot unlock',async t=>{
  const {root,store}=await fixture(t); const other=await openStore(root);
  await assert.rejects(other.acquireLock(),{code:'BUSY'});
  await other.releaseLock(); await assert.rejects(other.acquireLock(),{code:'BUSY'});
  await store.releaseLock(); await other.acquireLock(); await other.releaseLock();
});
test('stale lock is retained regardless of timestamp and reports PID',async t=>{
  const {root,store}=await fixture(t); await store.releaseLock();
  const text=JSON.stringify({pid:123456789,token:'old',created_at:'2000-01-01T00:00:00Z'});
  await fs.writeFile(path.join(root,'intake.lock'),text,{mode:0o600});
  await assert.rejects(store.acquireLock(),e=>e.code==='BUSY' && e.message.includes('123456789'));
  assert.equal(await fs.readFile(path.join(root,'intake.lock'),'utf8'),text);
});
test('repo and Vault roots and descendants are rejected without writes',async()=>{
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  for(const root of [repo,path.join(repo,'private-store'),VAULT_PATH,path.join(VAULT_PATH,'private-store')]) await assert.rejects(openStore(root),{code:'UNSAFE_PATH'});
});
test('symlink ancestor and symlink material are rejected',async t=>{
  const {root,store}=await fixture(t); const outside=path.join(root,'outside'); await fs.mkdir(outside,{mode:0o700});
  await fs.symlink(outside,path.join(root,'alias'));
  await assert.rejects(openStore(path.join(root,'alias','data')),{code:'UNSAFE_PATH'});
  await store.saveMaterial(material); const file=materialPath(root);
  await fs.rename(file,path.join(outside,'material.json')); await fs.symlink(path.join(outside,'material.json'),file);
  await assert.rejects(store.readResult(material.material_id),{code:'UNSAFE_PATH'});
});
for(const kind of ['directory','hardlink']) {
  test(`nonregular or multiple-link material (${kind}) is rejected`,async t=>{
    const {root,store}=await fixture(t); await store.saveMaterial(material);
    if(kind==='directory') {await fs.unlink(materialPath(root));await fs.mkdir(materialPath(root),{mode:0o700});}
    else await fs.link(materialPath(root),path.join(root,'second-link'));
    await assert.rejects(store.readResult(material.material_id),{code:'UNSAFE_PATH'});
  });
}
test('created directories are 0700 and files are 0600; unsafe IDs cannot address paths',async t=>{
  const {root,store}=await fixture(t); await store.saveMaterial(material);
  await store.addReceipt(material,new Date()); await store.beginAttempt(material.material_id,new Date());
  await store.saveResult(material.material_id,result());
  async function check(p) {const st=await fs.lstat(p); assert.equal(st.mode & 0o777,st.isDirectory()?0o700:0o600,p);if(st.isDirectory())for(const n of await fs.readdir(p))await check(path.join(p,n));}
  await check(root);
  for(const id of ['../escape','/tmp/escape','mat_bad']) await assert.rejects(store.readResult(id));
  await assert.rejects(store.finishAttempt('../escape',{status:'FAILED'}));
});
test('attempts are independent, persisted before completion and budget dates use Shanghai',async t=>{
  const {root,store}=await fixture(t); await store.saveMaterial(material);
  const a=await store.beginAttempt(material.material_id,new Date('2026-09-10T15:59:59Z'));
  const b=await store.beginAttempt(material.material_id,new Date('2026-09-10T16:00:00Z'));
  assert.notEqual(a,b);
  const get=id=>readJSON(path.join(root,'attempts',`${id}.json`));
  assert.equal((await get(a)).status,'STARTED'); assert.equal((await get(a)).budget_date,'2026-09-10');
  assert.equal((await get(b)).budget_date,'2026-09-11');
  await store.finishAttempt(a,{status:'FAILED',error:{code:'STORAGE_ERROR',message:'failed to save'}});
  await store.finishAttempt(b,{status:'COMPLETED',metrics:{sdk_turns:1}});
  await store.saveResult(material.material_id,result());
  assert.equal((await get(a)).details.error.code,'STORAGE_ERROR'); assert.equal((await get(b)).status,'COMPLETED');
  assert.equal((await fs.readdir(path.join(root,'attempts'))).filter(n=>n.endsWith('.json')).length,2);
  // Every attempt, including failed attempts, has one countable budget_date. Store imposes no daily limit.
  for(let i=0;i<11;i++)await store.beginAttempt(material.material_id,new Date('2026-09-10T16:00:00Z'));
  const all=await Promise.all((await fs.readdir(path.join(root,'attempts'))).map(n=>readJSON(path.join(root,'attempts',n))));
  assert.equal(all.filter(a=>a.budget_date==='2026-09-11').length,12);
});
test('corrupt attempt cannot be overwritten by finishAttempt',async t=>{
  const {root,store}=await fixture(t);await store.saveMaterial(material);
  const id=await store.beginAttempt(material.material_id,new Date());const file=path.join(root,'attempts',`${id}.json`);
  await fs.writeFile(file,'{');await assert.rejects(store.finishAttempt(id,{status:'FAILED'}),{code:'STATE_CORRUPT'});
  assert.equal(await fs.readFile(file,'utf8'),'{');
});
test('atomic result uses synced same-directory temp, then rename and read-back',async t=>{
  const {root,store}=await fixture(t);await store.saveMaterial(material);
  const originalOpen=fs.open.bind(fs),originalRename=fs.rename.bind(fs);
  let synced=false,renamed=false,readBack=false;
  t.mock.method(fs,'open',async(p,...args)=>{
    const h=await originalOpen(p,...args);
    if(String(p).endsWith('.tmp')) {const sync=h.sync.bind(h);h.sync=async()=>{await sync();synced=true;};}
    if(p===resultPath(root) && renamed)readBack=true;
    return h;
  });
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===resultPath(root)) {
      assert.equal(path.dirname(from),path.dirname(to));assert(synced);
      await assert.rejects(fs.stat(to),{code:'ENOENT'});assert.deepEqual(await readJSON(from),result());
      await originalRename(from,to);renamed=true;
    } else await originalRename(from,to);
  });
  await store.saveResult(material.material_id,result());assert(renamed&&readBack);
  assert.equal((await fs.readdir(path.dirname(resultPath(root)))).filter(n=>n.endsWith('.tmp')).length,0);
});
for(const phase of ['sync','rename']) {
  test(`${phase} failure leaves raw intact and no success result; manual retry works`,async t=>{
    const {root,store}=await fixture(t);await store.saveMaterial(material);
    const before=await fs.readFile(materialPath(root));
    const originalOpen=fs.open.bind(fs);
    if(phase==='rename')t.mock.method(fs,'rename',async()=>{throw new Error('injected rename failure');});
    else t.mock.method(fs,'open',async(p,...args)=>{const h=await originalOpen(p,...args);if(String(p).endsWith('.tmp'))h.sync=async()=>{throw new Error('injected sync failure');};return h;});
    await assert.rejects(store.saveResult(material.material_id,result()),/injected/);
    assert.equal(await store.readResult(material.material_id),null);assert.deepEqual(await fs.readFile(materialPath(root)),before);
    t.mock.restoreAll();await store.saveResult(material.material_id,result());assert.deepEqual(await store.readResult(material.material_id),result());
  });
}

test('read-back detects post-rename corruption and preserves diagnostic file',async t=>{
  const {root,store}=await fixture(t);await store.saveMaterial(material);
  const rename=fs.rename.bind(fs);
  t.mock.method(fs,'rename',async(from,to)=>{await rename(from,to);if(to===resultPath(root))await fs.writeFile(to,'{');});
  await assert.rejects(store.saveResult(material.material_id,result()),{code:'STATE_CORRUPT'});
  t.mock.restoreAll();
  assert.equal(await fs.readFile(resultPath(root),'utf8'),'{');
  await assert.rejects(store.readResult(material.material_id),{code:'STATE_CORRUPT'});
});
