import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';

const signal=(overrides={})=>({key:'repeat-input',action:'验证重复输入',type:'SUGGESTION',status:'PROPOSED',owner:'user',project:'project-a',reason:'助手提出可选验证。',evidence:[{message_id:'a1',quote:'可以验证重复输入。'}],...overrides});
function sample(extra=''){const s=snapshot();s.messages=[{...s.messages[0],text:'我还没有决定是否执行。'+extra},{...s.messages[0],id:'a1',role:'assistant',text:'可以验证重复输入。'}];return s;}
const output=(s,actions)=>({decision:'draft',markdown:'本轮讨论了验证方案。',reason:'需要区分建议与决定。',coverage:Object.fromEntries(['question','analysis','ending'].map(k=>[k,[{message_id:s.messages[0].id,quote:s.messages[0].text}]])),usage:null,actions});
async function analyze(store,s,actions){await store.enqueueProcessing({snapshot:s,recipe:'actions-v1'});const task=await store.claimProcessing({now,maxJobs:30,maxInputBytes:500000});assert.equal(task.status,'CLAIMED');const input={id:task.job.id,attempt:task.job.attempt,result:output(s,actions)};await store.finishProcessing(input);return input;}
const decide=(store,action,decision,extra={})=>store.decideAction({id:action.id,expected_review_hash:action.review_hash,decision,...extra});

test('captured suggestions become formal only after confirmation and repeated analysis creates no duplicate',async t=>{
 const dataDir=await temp(t),store=await openCaptureStore({dataDir}),input=await analyze(store,sample(),[signal()]);
 const before=await fs.readFile(dataDir+'/state.json');let view=await store.actionView({now});
 assert.equal(view.actions.length,1);assert.equal(view.focus.length,0);assert.equal(view.suggestions[0].confirmed,false);
 assert.equal(view.actions[0].material_id,null);assert.match(view.actions[0].id,/^cact_/u);
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 await decide(store,view.actions[0],'accept');
 await store.finishProcessing(input);
 const reopened=await openCaptureStore({dataDir});view=await reopened.actionView({now});
 assert.equal(view.actions.length,1);assert.equal(view.actions[0].status,'OPEN');assert.equal(view.actions[0].formal,true);
 assert.equal(view.suggestions.length,0);assert.equal(view.focus.length,1);
});

test('source versions update signals but preserve human decisions and reject old-page confirmations',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)});await analyze(store,sample(),[signal()]);
 let action=(await store.actionView({now})).actions[0];await decide(store,action,'accept');action=(await store.actionView({now})).actions[0];
 await analyze(store,sample('后来补充了结果。'),[signal({status:'COMPLETED',reason:'新分析报告已经完成，仍需用户确认。'})]);
 let updated=(await store.actionView({now})).actions[0];assert.equal(updated.id,action.id);assert.equal(updated.status,'OPEN');assert.equal(updated.source_status,'COMPLETED');
 await assert.rejects(decide(store,action,'complete'),{code:'STALE_INPUT'});
 await decide(store,updated,'complete');updated=(await store.actionView({now})).actions[0];assert.equal(updated.status,'COMPLETED');
 const source=await store.actionSource({id:updated.id,expected_review_hash:updated.review_hash});assert.equal(source.snapshot.messages[0].text,'我还没有决定是否执行。后来补充了结果。');
});

test('changed or omitted source signals remain traceable and cannot auto-revive dismissed work',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)});await analyze(store,sample(),[signal()]);
 await decide(store,(await store.actionView({now})).actions[0],'dismiss',{reason:'本轮不采用'});
 await store.enqueueProcessing({snapshot:sample('新增上下文。'),recipe:'actions-v1'});
 let view=await store.actionView({now});assert.equal(view.actions[0].stale,true);assert.equal(view.suggestions.length,0);
 await assert.rejects(decide(store,view.actions[0],'accept'),{code:'STALE_INPUT'});
 const task=await store.claimProcessing({now,maxJobs:30});await store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:output(task.job.snapshot,[])});
 view=await store.actionView({now});assert.equal(view.actions.length,1);assert.equal(view.actions[0].stale,true);assert.equal(view.actions[0].status,'DISMISSED');
 await analyze(store,sample('又出现相关说明。'),[signal()]);
 view=await store.actionView({now});assert.equal(view.actions.length,1);assert.equal(view.actions[0].status,'DISMISSED');assert.equal(view.suggestions.length,0);
});

test('deferred suggestions remain hidden until their date; different conversations never merge by title',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)});await analyze(store,sample(),[signal()]);
 await decide(store,(await store.actionView({now})).actions[0],'defer',{until:'2099-01-01'});
 assert.equal((await store.actionView({now})).suggestions.length,0);
 assert.equal((await store.actionView({now:'2099-01-02T00:00:00.000Z'})).suggestions.length,1);
 const other=sample();other.source.conversation_id='other';await analyze(store,other,[signal()]);
 assert.equal((await store.actionView({now})).actions.length,2);
});

test('other people and uncertain owners are not placed into personal focus; commitment requires user evidence',async t=>{
 const store=await openCaptureStore({dataDir:await temp(t)}),s=sample();
 await store.enqueueProcessing({snapshot:s,recipe:'actions-v1'});const task=await store.claimProcessing({now,maxJobs:30});
 await assert.rejects(store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:output(s,[signal({type:'COMMITMENT'})])}),{code:'INVALID_EVIDENCE'});
 await store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:output(s,[signal({type:'FOLLOW_UP',owner:'other'})])});
 assert.equal((await store.actionView({now})).focus.length,0);
 const action=(await store.actionView({now})).actions[0];await decide(store,action,'accept');assert.equal((await store.actionView({now})).focus.length,1);
});

test('invalid signals and corrupted feedback fail closed and leave previous state unchanged',async t=>{
 const dataDir=await temp(t),store=await openCaptureStore({dataDir}),s=sample();await store.enqueueProcessing({snapshot:s,recipe:'actions-v1'});const task=await store.claimProcessing({now,maxJobs:30});
 const before=await fs.readFile(dataDir+'/state.json');
 await assert.rejects(store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:output(s,[signal({evidence:[{message_id:'a1',quote:'不存在'}]})])}),{code:'INVALID_EVIDENCE'});
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 await store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:output(s,[signal()])});
 const action=(await store.actionView({now})).actions[0],valid=await fs.readFile(dataDir+'/state.json');
 await assert.rejects(decide(store,action,'dismiss',{reason:'x'.repeat(4001)}),{code:'INPUT_INVALID'});
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),valid);
 await decide(store,(await store.actionView({now})).actions[0],'accept');
 const state=JSON.parse(await fs.readFile(dataDir+'/state.json','utf8'));state.processing.action_feedback[0].decision='auto-complete';await fs.writeFile(dataDir+'/state.json',JSON.stringify(state));
 await assert.rejects(store.actionView({now}),{code:'STATE_CORRUPT'});
});
