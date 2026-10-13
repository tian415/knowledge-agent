import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {openCaptureStore} from '../../src/capture/store.mjs';import {candidateId} from '../../src/capture/review.mjs';import {sourceKey,messageHash,digest} from '../../src/capture/model.mjs';import {snapshot,temp} from './helpers.mjs';
const candidate=(s=snapshot())=>({kind:'knowledge',stage:'discussed',title:'知识候选',body:'讨论与决定应区分',knowledge_layer:'PRODUCT_THINKING',evidence:[{message_id:'m1',message_hash:messageHash(s.messages[0]),snippet:'尚未决定'}],verification:null});
function batch(s,c,observation_hash){const source_key=sourceKey(s.source);return {source_key,generator:'codex_assisted',observation_hash,candidates:[{...c,id:candidateId(source_key,c)}]};}
async function currentBatch(store,s=snapshot(),c=candidate(s)){const source_key=sourceKey(s.source),view=await store.view(),src=view.sources.find(x=>x.key===source_key);return batch(s,c,src.observations.at(-1).hash);}
test('exact evidence, source, version and stable ID validation is atomic',async t=>{const store=await openCaptureStore({dataDir:await temp(t)});await store.ingest(snapshot());
 for(const change of [c=>c.evidence[0].snippet='invented',c=>c.evidence[0].message_hash='a'.repeat(64),c=>c.evidence[0].message_id='other']){const c=candidate();change(c);await assert.rejects(store.putReview(await currentBatch(store,snapshot(),c)),{code:'INVALID_EVIDENCE'});}
 const missing=await currentBatch(store);delete missing.observation_hash;await assert.rejects(store.putReview(missing),{code:'INPUT_INVALID'});
 const b=await currentBatch(store);b.candidates[0].id='arbitrary';await assert.rejects(store.putReview(b),{code:'INPUT_INVALID'});const duplicate=await currentBatch(store);duplicate.candidates.push(duplicate.candidates[0]);await assert.rejects(store.putReview(duplicate),{code:'INPUT_INVALID'});assert.equal((await store.view()).candidates.length,0);
 assert.equal((await store.putReview(await currentBatch(store))).added,1);
});
test('feedback survives repeated generation; edit flags review and does not erase keep',async t=>{const store=await openCaptureStore({dataDir:await temp(t)});await store.ingest(snapshot());const b=await currentBatch(store);await store.putReview(b);await store.decide({candidate_id:b.candidates[0].id,decision:'keep'});assert.equal((await store.putReview(b)).status,'NO_CHANGE');
 const edited=snapshot();edited.messages[0].text='已决定。';assert.equal((await store.ingest(edited)).review_required,1);const c=(await store.view()).candidates[0];assert.equal(c.decision,'keep');assert.equal(c.review_required,true);await assert.rejects(store.putReview(b),{code:'STALE_INPUT'});await assert.rejects(store.decide({candidate_id:c.id,decision:'commit'}),{code:'INPUT_INVALID'});
});
test('new context flags retained feedback and same candidate can be reviewed again',async t=>{
 const dataDir=await temp(t),store=await openCaptureStore({dataDir}),first=snapshot();await store.ingest(first);const b=await currentBatch(store,first);await store.putReview(b);await store.decide({candidate_id:b.candidates[0].id,decision:'keep'});
 const next=snapshot();next.messages.push({...next.messages[0],id:'m2',text:'撤回前面的讨论结论，不采用。'});assert.equal((await store.ingest(next)).review_required,1);
 let view=await store.view(),stored=view.candidates[0],latest=view.sources[0].observations.at(-1);
 assert.equal(view.sources[0].review_status,'pending');assert.equal(stored.decision,'keep');assert.equal(stored.review_required,true);assert.notEqual(stored.observation_hash,latest.hash);
 const before=await fs.readFile(dataDir+'/state.json');await assert.rejects(store.putReview(b),{code:'STALE_INPUT'});await assert.rejects(store.putReview({...b,candidates:[]}),{code:'STALE_INPUT'});assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 const refreshed=await currentBatch(store,next,candidate(first));assert.equal((await store.putReview(refreshed)).status,'UPDATED');view=await store.view();stored=view.candidates[0];
 assert.equal(stored.decision,'keep');assert.equal(stored.review_required,false);assert.equal(stored.observation_hash,view.sources[0].observations.at(-1).hash);
});
test('coverage-only changes require review while dismiss feedback survives',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)}),first=snapshot();await store.ingest(first);const b=await currentBatch(store,first);await store.putReview(b);await store.decide({candidate_id:b.candidates[0].id,decision:'dismiss'});
 const complete={...first,captured_at:'2026-09-20T09:00:00.000Z',completeness:'complete',gaps:[]};
 assert.equal((await store.ingest(complete)).review_required,1);let view=await store.view();
 assert.equal(view.sources[0].review_status,'pending');assert.equal(view.candidates[0].decision,'dismiss');assert.equal(view.candidates[0].review_required,true);
 assert.equal((await store.putReview(await currentBatch(store,complete,candidate(first)))).status,'UPDATED');assert.equal((await store.ingest({...complete,captured_at:'2026-09-20T10:00:00.000Z'})).status,'NO_CHANGE');
 view=await store.view();assert.equal(view.candidates[0].decision,'dismiss');assert.equal(view.candidates[0].review_required,false);
});
test('new reviews require evidence in the latest observation and preserve cross-branch rejection',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)}),a=snapshot();await store.ingest(a);await store.ingest({...a,messages:[]});
 await assert.rejects(store.putReview(await currentBatch(store,a)),{code:'INVALID_EVIDENCE'});
});
test('legacy candidate observation hashes remain readable without rewriting',async t=>{
 const dataDir=await temp(t),store=await openCaptureStore({dataDir});await store.ingest(snapshot());await store.putReview(await currentBatch(store));
 const state=JSON.parse(await fs.readFile(dataDir+'/state.json','utf8')),observation=state.sources[0].observations[0],legacy=digest(observation.order);
 observation.hash=legacy;state.candidates[0].observation_hash=legacy;await fs.writeFile(dataDir+'/state.json',JSON.stringify(state));
 const reopened=await openCaptureStore({dataDir});assert.equal((await reopened.ingest(snapshot())).status,'NO_CHANGE');const view=await reopened.view();
 assert.equal(view.sources[0].observations.length,1);assert.equal(view.candidates[0].observation_hash,legacy);assert.equal(view.candidates[0].review_required,false);
});
test('claimed verification without local check is visibly downgraded; explicit checks stay bound',async t=>{const store=await openCaptureStore({dataDir:await temp(t)});await store.ingest(snapshot());const c={...candidate(),kind:'progress',stage:'verified',knowledge_layer:null};await store.putReview(await currentBatch(store,snapshot(),c));let v=(await store.view()).candidates[0];assert.equal(v.stage,'implemented');assert.equal(v.verification_status,'reported_unverified');
 const checked={...c,verification:{type:'local_check',checked_at:'2026-09-20T08:00:00.000Z',reference:'node --test tests/capture/store.test.mjs',result:'5 tests passed'}};await store.putReview(await currentBatch(store,snapshot(),checked));v=(await store.view()).candidates[1];assert.equal(v.stage,'verified');assert.equal(v.verification.result,'5 tests passed');
});
test('failed generation leaves collected source retryable and knowledge layer independent of tool',async t=>{const store=await openCaptureStore({dataDir:await temp(t)});await store.ingest(snapshot());const b=await currentBatch(store);b.generator='provider';await assert.rejects(store.putReview(b));assert.equal((await store.view()).sources[0].review_status,'pending');await store.putReview(await currentBatch(store));assert.equal((await store.view()).sources[0].review_status,'generated');assert.equal((await store.view()).candidates[0].knowledge_layer,'PRODUCT_THINKING');});
test('evidence from mutually exclusive snapshots cannot form one candidate',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)}),a=snapshot(),b=snapshot();a.messages.push({...a.messages[0],id:'branchA',text:'方案 A'});b.messages.push({...b.messages[0],id:'branchB',text:'方案 B'});await store.ingest(a);await store.ingest(b);
 const c=candidate();c.evidence=[{message_id:'branchA',message_hash:messageHash(a.messages[1]),snippet:'方案 A'},{message_id:'branchB',message_hash:messageHash(b.messages[1]),snippet:'方案 B'}];await assert.rejects(store.putReview(await currentBatch(store,b,c)),{code:'INVALID_EVIDENCE'});assert.equal((await store.view()).candidates.length,0);
});
test('assistant-only source can only produce explicit unknown confirmations',async t=>{
 const s=snapshot();s.messages[0].role='assistant';const store=await openCaptureStore({dataDir:await temp(t)});await store.ingest(s);await assert.rejects(store.putReview(await currentBatch(store,s,candidate(s))),{code:'CONTEXT_REQUIRED'});
 const c={...candidate(s),kind:'confirmation',stage:'unknown',knowledge_layer:null};await store.putReview(await currentBatch(store,s,c));assert.equal((await store.view()).candidates[0].stage,'unknown');
});
test('corrupt candidate fields fail closed on reopen and mutation',async t=>{
 const dataDir=await temp(t),store=await openCaptureStore({dataDir});await store.ingest(snapshot());await store.putReview(await currentBatch(store));const fs=await import('node:fs/promises');const v=JSON.parse(await fs.readFile(dataDir+'/state.json','utf8'));v.candidates[0].stage='invented';const raw=JSON.stringify(v);await fs.writeFile(dataDir+'/state.json',raw);await assert.rejects(store.decide({candidate_id:v.candidates[0].id,decision:'keep'}),{code:'STATE_CORRUPT'});assert.equal(await fs.readFile(dataDir+'/state.json','utf8'),raw);
});
