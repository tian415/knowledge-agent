import {candidateId} from '../../src/capture/review.mjs';
import {sourceKey,messageHash} from '../../src/capture/model.mjs';
import http from 'node:http';
import {test} from 'node:test';import assert from 'node:assert/strict';import {createCaptureApp} from '../../src/capture/server.mjs';import {openCaptureStore} from '../../src/capture/store.mjs';import {snapshot,temp} from './helpers.mjs';
test('loopback routes enforce host/origin/token, size and expose no writer',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)});const app=await createCaptureApp({store,refreshCodex:()=>store.ingest(snapshot())});const url=await app.listen(0);t.after(()=>app.close());
 const post=(route,body,headers={})=>fetch(url+route,{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':app.token,...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 assert.equal((await fetch(url+'/api/state')).status,200);
 const forged=await new Promise((resolve,reject)=>{http.get(url+'/api/state',{headers:{host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(forged,403);
 assert.equal((await post('/api/refresh/codex',{}, {origin:'https://evil.invalid'})).status,403);
 assert.equal((await post('/api/refresh/codex',{}, {'x-app-token':'bad'})).status,403);
 assert.equal((await post('/api/refresh/codex',{file:'/etc/passwd'})).status,400);
 assert.equal((await post('/api/refresh/codex',{})).status,200);
 assert.equal((await post('/api/reviews','x'.repeat(1024*1024+1))).status,413);
 for(const route of ['/api/knowledge/apply','/api/unknown','/../package.json'])assert.equal((await fetch(url+route)).status,404);
 assert.equal((await fetch(url+'/api/state',{method:'DELETE'})).status,405);
 const page=await fetch(url);assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));assert.ok((await page.text()).includes('最近进展'));
 assert.equal((await fetch(url+'/project.html')).status,404);
 const state=await (await fetch(url+'/api/state')).json();assert.equal(state.sources.length,1);assert.ok(state.metrics.message_versions===1);
});
test('live run page reads persisted results without exposing raw snapshots or adding write actions',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)});await store.enqueueProcessing({snapshot:snapshot(),recipe:'v1'});
 const app=await createCaptureApp({store,refreshCodex:()=>{}}),url=await app.listen(0);t.after(()=>app.close());
 assert.equal((await fetch(url+'/runs.html')).status,200);
 const response=await fetch(url+'/api/processing');assert.equal(response.status,200);const state=await response.json();assert.equal(state.queued,1);assert.ok(!JSON.stringify(state).includes(snapshot().messages[0].text));
 assert.equal((await fetch(url+'/runs.js')).status,200);
});
test('topic preview is authenticated and never exposes an apply route',async t=>{
 let calls=0;const store=await openCaptureStore({dataDir:await temp(t)});
 const app=await createCaptureApp({store,publisher:{prepare:async input=>{calls++;return input;},list:async()=>({mode:'preview-only',plans:[]})}}),url=await app.listen(0);t.after(()=>app.close());
 const page=await(await fetch(url+'/runs.html')).text();assert.ok(page.includes(app.token));
 const post=(token)=>fetch(url+'/api/topic-preview',{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':token},body:JSON.stringify({topic_id:'test'})});
 assert.equal((await post('bad')).status,403);assert.equal(calls,0);assert.equal((await post(app.token)).status,200);assert.equal(calls,1);
 assert.equal((await fetch(url+'/api/topic-previews')).status,200);
 assert.equal((await fetch(url+'/api/topic-apply',{method:'POST'})).status,404);
});

test('authenticated stale review submissions cannot clear the latest-context warning',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)}),s=snapshot();await store.ingest(s);
 const source_key=sourceKey(s.source),observation_hash=(await store.view()).sources[0].observations.at(-1).hash;
 const c={kind:'confirmation',stage:'unknown',title:'合成候选',body:'尚未决定',knowledge_layer:null,
  evidence:[{message_id:'m1',message_hash:messageHash(s.messages[0]),snippet:'尚未决定'}],verification:null};
 const batch={source_key,observation_hash,generator:'codex_assisted',candidates:[{...c,id:candidateId(source_key,c)}]};
 const app=await createCaptureApp({store}),url=await app.listen(0);t.after(()=>app.close());
 const post=()=>fetch(url+'/api/reviews',{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':app.token},body:JSON.stringify(batch)});
 assert.equal((await post()).status,200);
 s.messages.push({...s.messages[0],id:'m2',text:'撤回之前的决定。'});await store.ingest(s);
 const before=await store.view(),response=await post();
 assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:{code:'STALE_INPUT'}});
 assert.deepEqual(await store.view(),before);assert.equal(before.candidates[0].review_required,true);
});

test('runtime summary is read-only and preview conflicts use actionable error codes',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)});
 const runtime={configured:true,cadence_days:10,scheduler_enabled:false,semantic_executor:'codex-assisted',jev:'not_connected',vault_write_enabled:false};
 const app=await createCaptureApp({store,runtime,publisher:{prepare:async()=>{throw Object.assign(new Error('private path must not leak'),{code:'CONFLICT'});},list:async()=>({plans:[]})}});
 const url=await app.listen(0);t.after(()=>app.close());
 assert.deepEqual(await(await fetch(url+'/api/runtime')).json(),runtime);
 const response=await fetch(url+'/api/topic-preview',{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':app.token},body:JSON.stringify({topic_id:'test'})});
 assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:{code:'CONFLICT'}});
 assert.equal((await fetch(url+'/api/runtime',{method:'POST'})).status,404);
});
