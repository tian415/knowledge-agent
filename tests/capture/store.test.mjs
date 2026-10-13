import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {digest} from '../../src/capture/model.mjs';
import {snapshot,temp} from './helpers.mjs';
test('versioned ingest preserves old text, deduplicates and survives restart/partial absence',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir});const a=snapshot();
 assert.equal((await s.ingest(a)).added,1);
 const bytes=(await fs.stat(dataDir+'/state.json')).size;
 assert.equal((await s.ingest(a)).status,'NO_CHANGE');assert.equal((await fs.stat(dataDir+'/state.json')).size,bytes);
 const b=snapshot();b.messages[0].text='已决定先做原型。';assert.equal((await s.ingest(b)).changed,1);
 await s.ingest({...a,messages:[]});const view=await (await openCaptureStore({dataDir})).view();
 assert.equal(view.sources[0].messages.length,1);assert.equal(view.sources[0].messages[0].versions.length,2);
 assert.equal((await fs.stat(dataDir+'/state.json')).mode&0o777,0o600);
});
test('invalid batches never partially commit',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)});const a=snapshot();
 for(const bad of [{...a,messages:[...a.messages,...a.messages]},{...a,extra:1},{...a,messages:[{...a.messages[0],role:'developer'}]},{...a,completeness:'complete'}])await assert.rejects(s.ingest(bad),{code:'INPUT_INVALID'});
 assert.equal((await s.view()).sources.length,0);
});
test('scope isolates identities while channels do not',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=snapshot();await s.ingest(a);
 await s.ingest({...a,channel:'desktop'});assert.equal((await s.view()).sources.length,1);
 await s.ingest({...a,source:{...a.source,scope:'other'}});assert.equal((await s.view()).sources.length,2);
});
test('coverage changes create observations while timestamps and gap order do not',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=snapshot();a.gaps=['history_not_verified','desktop_unavailable'];await s.ingest(a);
 const reordered={...a,captured_at:'2026-09-20T09:00:00.000Z',gaps:['desktop_unavailable','history_not_verified']};
 assert.equal((await s.ingest(reordered)).status,'NO_CHANGE');assert.equal((await s.view()).sources[0].observations.length,1);
 const complete={...reordered,captured_at:'2026-09-20T10:00:00.000Z',completeness:'complete',gaps:[]};
 assert.equal((await s.ingest(complete)).status,'UPDATED');const view=await s.view();
 assert.equal(view.sources[0].observations.length,2);assert.notEqual(view.sources[0].observations[0].hash,view.sources[0].observations[1].hash);
});
test('legacy order-only observation hashes remain readable',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir});await s.ingest(snapshot());
 const state=JSON.parse(await fs.readFile(dataDir+'/state.json','utf8')),observation=state.sources[0].observations[0];
 observation.hash=digest(observation.order);await fs.writeFile(dataDir+'/state.json',JSON.stringify(state));
 assert.equal((await (await openCaptureStore({dataDir})).view()).sources[0].observations[0].hash,observation.hash);
});
test('unsafe paths, links, permissions and corrupted state fail closed',async t=>{
 const dir=await temp(t);
 await assert.rejects(openCaptureStore({dataDir:dir,protectedRoots:[dir+'/vault']}),{code:'UNSAFE_PATH'});
 await fs.symlink(dir,dir+'-link');t.after(()=>fs.unlink(dir+'-link'));await assert.rejects(openCaptureStore({dataDir:dir+'-link'}),{code:'UNSAFE_PATH'});
 const s=await openCaptureStore({dataDir:dir});await s.ingest(snapshot());await fs.writeFile(dir+'/state.json','{}');
 await assert.rejects(s.ingest(snapshot()),{code:'STATE_CORRUPT'});assert.equal(await fs.readFile(dir+'/state.json','utf8'),'{}');
 await fs.chmod(dir+'/state.json',0o644);await assert.rejects(s.view(),{code:'UNSAFE_PATH'});
});
test('single-writer lock refuses contention and failure preserves prior state',async t=>{
 const dir=await temp(t),s=await openCaptureStore({dataDir:dir});await s.ingest(snapshot());const before=await fs.readFile(dir+'/state.json');
 await fs.writeFile(dir+'/capture.lock','occupied',{mode:0o600});await assert.rejects(s.ingest(snapshot()),{code:'BUSY'});assert.deepEqual(await fs.readFile(dir+'/state.json'),before);
 await fs.unlink(dir+'/capture.lock');
 const results=await Promise.allSettled([s.ingest(snapshot()),s.ingest(snapshot())]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(results.some(r=>r.reason?.code==='BUSY'));
 await fs.link(dir+'/state.json',dir+'/linked');await assert.rejects(s.view(),{code:'UNSAFE_PATH'});
});
test('malformed persisted nested state is rejected and never overwritten',async t=>{
 const dir=await temp(t),s=await openCaptureStore({dataDir:dir});await s.ingest(snapshot());const valid=JSON.parse(await fs.readFile(dir+'/state.json','utf8'));
 for(const corrupt of [v=>v.sources[0].observations=[null],v=>v.sources[0].channels=['invalid'],v=>v.sources[0].review_status='done-ish',v=>v.extra=true,v=>v.sources[0].observations[0].hash='wrong']){
 const v=structuredClone(valid);corrupt(v);const bytes=JSON.stringify(v);await fs.writeFile(dir+'/state.json',bytes);await assert.rejects(s.ingest(snapshot()),{code:'STATE_CORRUPT'});assert.equal(await fs.readFile(dir+'/state.json','utf8'),bytes);
 }
});
