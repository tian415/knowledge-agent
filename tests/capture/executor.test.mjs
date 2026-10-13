import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';
import {runOfflineOnce,recoverExecution} from '../../src/capture/executor.mjs';
const budget={now,maxJobs:10,maxInputBytes:120000};
const settings={driver:'offline-sdk',scenario:'success',timeout_ms:5000};
async function setup(t){const dataDir=await temp(t),store=await openCaptureStore({dataDir});await store.enqueueProcessing({snapshot:snapshot(),recipe:'v1'});return {store,dataDir};}
const run=(store,kind='source',scenario='success',extra={})=>runOfflineOnce({store,kind,budget,settings:{...settings,scenario},...extra});
const binding=r=>({kind:r.kind,id:r.id,attempt:r.attempt,execution_id:r.execution_id});
test('source and topic traverse SDK, persist output and synthetic usage without claiming measured tokens',async t=>{
 const {store,dataDir}=await setup(t);const source=await run(store);assert.equal(source.status,'COMPLETED');
 let status=await store.processingStatus();assert.equal(status.usage.reported_turns,0);assert.equal(status.usage.simulated_turns,1);assert.equal(status.usage.tokens.input_tokens,null);
 const e=await store.executionView(binding(source));assert.equal(e.phase,'finalized');assert.ok(e.prompt_bytes>0);assert.equal(e.settings.driver,'offline-sdk');assert.equal(JSON.parse(e.prompt).input.review_contract.version,'classification-v2');
 await store.registerTopic({project:'p',key:'k',title:'合成主题',recipe:'v1',source_ids:[source.id]});
 const topic=await run(store,'topic');assert.equal(topic.status,'COMPLETED');
 const reopened=await openCaptureStore({dataDir});assert.equal((await recoverExecution({store:reopened,binding:binding(topic)})).status,'NO_CHANGE');
 status=await reopened.processingStatus();assert.equal(status.window.jobs,2);assert.equal(status.usage.simulated_turns,2);
 assert.equal((await run(reopened)).status,'NO_WORK');
});
test('no_value completes; malformed output or invalid evidence keeps usage and never reruns',async t=>{
 for(const scenario of ['no_value','invalid_json','invalid_evidence']){
  const {store}=await setup(t),r=await run(store,'source',scenario);const status=await store.processingStatus();
  assert.equal(status.usage.simulated_turns,1);
  if(scenario==='no_value'){assert.equal(r.status,'COMPLETED');assert.equal(status.jobs[0].decision,'no_value');}
  else{assert.equal(r.status,'EXECUTION_ATTENTION');assert.equal(status.jobs[0].status,'running');assert.equal((await run(store)).status,'ATTENTION_REQUIRED');assert.equal((await recoverExecution({store,binding:binding(r)})).status,'EXECUTION_ATTENTION');}
  assert.equal((await store.processingStatus()).window.jobs,1);
 }
});
test('prepared or started crash never relaunches and binding is checked',async t=>{
 const {store,dataDir}=await setup(t),claim=await store.claimExecution({kind:'source',...budget,settings});
 assert.equal(claim.status,'CLAIMED');
 for(const phase of ['prepared','started']){
  if(phase==='started')await store.startExecution(binding(claim));
  const reopened=await openCaptureStore({dataDir});assert.equal((await recoverExecution({store:reopened,binding:binding(claim)})).status,'EXECUTION_ATTENTION');
  assert.equal((await run(reopened)).status,'ATTENTION_REQUIRED');
 }
 await assert.rejects(store.startExecution(binding(claim)),{code:'EXECUTION_ALREADY_STARTED'});
 await assert.rejects(store.executionView({...binding(claim),attempt:'wrong'}),{code:'ATTEMPT_MISMATCH'});
});
test('usage persisted before finish survives write failure and recovery is idempotent',async t=>{
 const {store,dataDir}=await setup(t),r=await run({...store,completeExecution:async()=>{throw Object.assign(Error(),{code:'EIO'});}});
 assert.equal(r.status,'EXECUTION_ATTENTION');assert.equal((await store.processingStatus()).usage.simulated_turns,1);
 const reopened=await openCaptureStore({dataDir});assert.equal((await recoverExecution({store:reopened,binding:binding(r)})).status,'COMPLETED');
 assert.equal((await recoverExecution({store:reopened,binding:binding(r)})).status,'NO_CHANGE');assert.equal((await reopened.processingStatus()).window.jobs,1);
});
test('event write failure, upstream failure, timeout and abnormal exit do not cause a second launch',async t=>{
 for(const scenario of ['failed','timeout','exit_after_usage','write_failure']){
  const {store}=await setup(t);const wrapped=scenario==='write_failure'?{...store,recordExecutionEvent:async()=>{throw Object.assign(Error(),{code:'EIO'});}}:store;
  const r=await run(wrapped,'source',scenario==='write_failure'?'success':scenario,{settings:{...settings,scenario:scenario==='write_failure'?'success':scenario,timeout_ms:scenario==='timeout'?300:5000}});
  assert.equal(r.status,'EXECUTION_ATTENTION');assert.equal((await run(store)).status,'ATTENTION_REQUIRED');
  const recovery=await recoverExecution({store,binding:binding(r)});
  assert.equal(recovery.status,scenario==='exit_after_usage'?'COMPLETED':'EXECUTION_ATTENTION');
  const status=await store.processingStatus();assert.equal(status.window.jobs,1);assert.equal(status.usage.simulated_turns,scenario==='exit_after_usage'?1:0);
 }
});
test('concurrency, budget refusal, stale input and revoked scope protect the original state',async t=>{
 const {store,dataDir}=await setup(t);const settled=await Promise.allSettled([run(store),run(store)]);
 assert.equal(settled.filter(x=>x.status==='fulfilled'&&x.value.status==='COMPLETED').length,1);assert.equal((await store.processingStatus()).window.jobs,1);
 const second=await setup(t),before=await fs.readFile(second.dataDir+'/state.json');
 assert.equal((await run(second.store,'source','success',{budget:{...budget,maxInputBytes:1}})).status,'BUDGET_DEFERRED');assert.deepEqual(await fs.readFile(second.dataDir+'/state.json'),before);
 const third=await setup(t),wrapped={...third.store,completeExecution:async input=>{const changed=snapshot();changed.messages[0].text='已修改';await third.store.enqueueProcessing({snapshot:changed,recipe:'v1'});return third.store.completeExecution(input);}};
 const r=await run(wrapped);assert.equal(r.error,'STALE_INPUT');assert.equal((await third.store.processingStatus()).usage.simulated_turns,1);
 const guarded=await openCaptureStore({dataDir,authorizeState:()=>{throw Object.assign(Error(),{code:'SOURCE_SCOPE_MISMATCH'});}}).catch(e=>e);assert.equal(guarded.code,'SOURCE_SCOPE_MISMATCH');
});
test('live driver, unknown settings and corrupted execution metadata fail closed',async t=>{
 const {store,dataDir}=await setup(t),before=await fs.readFile(dataDir+'/state.json');
 for(const s of [{...settings,driver:'codex-sdk'},{...settings,executable:'/bin/echo'}])await assert.rejects(run(store,'source','success',{settings:s}));
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 await run(store);const raw=JSON.parse(await fs.readFile(dataDir+'/state.json'));raw.processing.jobs[0].execution.prompt+='tampered';await fs.writeFile(dataDir+'/state.json',JSON.stringify(raw));
 await assert.rejects(store.processingStatus(),{code:'STATE_CORRUPT'});
});

test('synthetic provenance cannot be detached from execution or submitted as real usage',async t=>{
 const {store,dataDir}=await setup(t),r=await run(store),e=await store.executionView(binding(r));
 await assert.rejects(store.recordCodexUsage({...binding(r),event:{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}}),{code:'USAGE_INVALID'});
 const raw=JSON.parse(await fs.readFile(dataDir+'/state.json'));delete raw.processing.jobs[0].execution;await fs.writeFile(dataDir+'/state.json',JSON.stringify(raw));
 await assert.rejects(store.processingStatus(),{code:'STATE_CORRUPT'});
});
test('scope is checked again at start, event write and recovery after another instance changes state',async t=>{
 const {store,dataDir}=await setup(t);let allowed=true;
 const guarded=await openCaptureStore({dataDir,authorizeState:()=>{if(!allowed)throw Object.assign(Error(),{code:'SOURCE_SCOPE_MISMATCH'});}});
 const claim=await guarded.claimExecution({kind:'source',...budget,settings}),b=binding(claim);allowed=false;
 const before=await fs.readFile(dataDir+'/state.json');
 for(const action of [()=>guarded.startExecution(b),()=>guarded.recordExecutionEvent({binding:b,event:{type:'turn.started'}}),()=>recoverExecution({store:guarded,binding:b})])await assert.rejects(action(),{code:'SOURCE_SCOPE_MISMATCH'});
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
});
test('input changed before process start is rejected without launching or recording simulated usage',async t=>{
 const {store}=await setup(t),claim=await store.claimExecution({kind:'source',...budget,settings});
 const changed=snapshot();changed.messages[0].text='new version';await store.enqueueProcessing({snapshot:changed,recipe:'v1'});
 await assert.rejects(store.startExecution(binding(claim)),{code:'STALE_INPUT'});
 assert.equal((await store.processingStatus()).usage.simulated_turns,0);
});
test('completed-event write failure retains output but cannot fabricate usage or replay execution',async t=>{
 const {store}=await setup(t),wrapped={...store,recordExecutionEvent:input=>input.event.type==='turn.completed'?Promise.reject(Object.assign(Error(),{code:'EIO'})):store.recordExecutionEvent(input)};
 const r=await run(wrapped),e=await store.executionView(binding(r));assert.ok(e.output);assert.equal(e.terminal,null);
 assert.equal((await recoverExecution({store,binding:binding(r)})).status,'EXECUTION_ATTENTION');assert.equal((await store.processingStatus()).usage.simulated_turns,0);
 assert.equal((await run(store)).status,'ATTENTION_REQUIRED');
});
test('editorial correction and restoration drop execution identity and never copy synthetic receipts',async t=>{
 const {store}=await setup(t),source=await run(store);
 await store.registerTopic({project:'p',key:'k',title:'主题',recipe:'v1',source_ids:[source.id]});const topic=await run(store,'topic');
 const state=(await store.view()).processing,original=state.topics.revisions.find(t=>t.id===topic.id);
 const corrected=await store.correctTopic({id:topic.id,title:'修订',result:{...original.result,markdown:'人工修订'}});
 const f=await store.recordTopicFeedback({id:corrected.id,expected_feedback_id:null,action:'dismiss',title:'',markdown:'',reason:'忽略'});
 const restored=await store.recordTopicFeedback({id:corrected.id,expected_feedback_id:f.id,action:'reopen',title:'',markdown:'',reason:'恢复'});
 assert.equal((await store.processingStatus()).usage.simulated_turns,2);
 const rev=(await store.view()).processing.topics.revisions.find(t=>t.id===restored.topic_id);assert.equal(rev.execution,undefined);assert.deepEqual(rev.metering.receipts,[]);
 assert.equal((await recoverExecution({store,binding:binding(topic)})).status,'NO_CHANGE');
});
