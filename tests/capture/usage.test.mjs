import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';
const options={now,maxJobs:20,maxInputBytes:120000};
const result=s=>({decision:'draft',markdown:'结论',reason:'新增',coverage:Object.fromEntries(['question','analysis','ending'].map(k=>[k,[{message_id:s.messages[0].id,quote:s.messages[0].text}]])),usage:null});
const event={type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:60,cache_write_input_tokens:10,reasoning_output_tokens:8}};
async function setup(t){const dataDir=await temp(t),s=await openCaptureStore({dataDir});await s.enqueueProcessing({snapshot:snapshot(),recipe:'v1'});const task=(await s.claimProcessing(options)).job;return {s,task,dataDir};}
const receipt=(task,execution_id='run-1')=>({kind:'source',id:task.id,attempt:task.attempt,execution_id,event});
test('claimed unknown usage survives restart; manual result numbers are not executor measurements',async t=>{
 const {s,task,dataDir}=await setup(t);assert.equal((await s.processingStatus()).usage.unknown_attempts,1);
 await s.finishProcessing({id:task.id,attempt:task.attempt,result:{...result(task.snapshot),usage:{input_tokens:999,output_tokens:999}}});
 const usage=(await (await openCaptureStore({dataDir})).processingStatus()).usage;
 assert.equal(usage.reported_turns,0);assert.equal(usage.tokens.input_tokens,null);assert.equal(usage.unknown_attempts,1);
});
test('executor receipt is durable, idempotent, includes stale/blocked attempts and does not add cache or reasoning twice',async t=>{
 const {s,task,dataDir}=await setup(t),input=receipt(task);await s.recordCodexUsage(input);
 assert.equal((await s.recordCodexUsage(input)).status,'NO_CHANGE');
 await assert.rejects(s.recordCodexUsage({...input,event:{...event,usage:{...event.usage,input_tokens:101}}}),{code:'USAGE_CONFLICT'});
 const changed=snapshot();changed.messages[0].text='改变上下文';await s.enqueueProcessing({snapshot:changed,recipe:'v1'});
 await s.deferProcessing({id:task.id,attempt:task.attempt,reason:'执行完成但原文失效'});
 await s.recordCodexUsage({...input,execution_id:'run-2',event:{type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}});
 const usage=(await (await openCaptureStore({dataDir})).processingStatus()).usage;
 assert.equal(usage.reported_turns,2);assert.equal(usage.reported_attempts,1);assert.equal(usage.unknown_attempts,0);
 assert.deepEqual(usage.tokens,{input_tokens:105,output_tokens:22,cached_input_tokens:60,cache_write_input_tokens:10,reasoning_output_tokens:8});
 assert.equal(usage.field_turns.cached_input_tokens,1);assert.equal(usage.field_turns.input_tokens,2);
 const second=(await s.claimProcessing(options)).job;
 await assert.rejects(s.recordCodexUsage({...receipt(second),execution_id:'run-1'}),{code:'USAGE_CONFLICT'});
});
test('topics record executor usage; corrections and restore never duplicate measured receipts',async t=>{
 const {s,task}=await setup(t);await s.finishProcessing({id:task.id,attempt:task.attempt,result:result(task.snapshot)});
 await s.registerTopic({project:'demo',key:'k',title:'主题',recipe:'v1',source_ids:[task.id]});const topic=await s.claimTopic(options);
 const r={kind:'knowledge',markdown:'主题正文',contribution:'综合',evidence:[{job_id:task.id,message_id:task.snapshot.messages[0].id,quote:task.snapshot.messages[0].text}]};
 await s.finishTopic({id:topic.id,attempt:topic.attempt,result:r});
 await s.recordCodexUsage({kind:'topic',id:topic.id,attempt:topic.attempt,execution_id:'topic-run',event});
 const corrected=await s.correctTopic({id:topic.id,title:'修订',result:{...r,markdown:'修订正文'}});
 const feedback=await s.recordTopicFeedback({id:corrected.id,expected_feedback_id:null,action:'dismiss',title:'',markdown:'',reason:'忽略'});
 const restored=await s.recordTopicFeedback({id:corrected.id,expected_feedback_id:feedback.id,action:'reopen',title:'',markdown:'',reason:'恢复'});
 const state=(await s.view()).processing,rev=state.topics.revisions.find(r=>r.id===restored.topic_id);
 await assert.rejects(s.recordCodexUsage({kind:'topic',id:rev.id,attempt:rev.attempt,execution_id:'editorial',event}),{code:'NOT_DISPATCHED'});
 const usage=(await s.processingStatus()).usage;assert.equal(usage.reported_turns,1);assert.equal(usage.dispatched_attempts,2);assert.equal(usage.editorial_revisions,2);assert.equal(usage.unknown_attempts,1);
});
test('invalid or unbound usage leaves state untouched; legacy entries stay unclassified and readable',async t=>{
 const {s,task,dataDir}=await setup(t),before=await fs.readFile(dataDir+'/state.json');
 for(const bad of [{...receipt(task),attempt:'wrong'},{...receipt(task),event:{type:'turn.failed',usage:event.usage}},{...receipt(task),event:{type:'turn.completed',usage:{input_tokens:-1,output_tokens:2}}},{...receipt(task),event:{type:'turn.completed',usage:{input_tokens:1,output_tokens:2,reasoning_output_tokens:3}}}])await assert.rejects(s.recordCodexUsage(bad));
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 const raw=JSON.parse(before);delete raw.processing.jobs[0].metering;await fs.writeFile(dataDir+'/state.json',JSON.stringify(raw));
 const usage=(await s.processingStatus()).usage;assert.equal(usage.legacy_attempts,1);assert.equal(usage.unknown_attempts,1);assert.equal(usage.tokens.output_tokens,null);
 await assert.rejects(s.recordCodexUsage(receipt(task)),{code:'NOT_DISPATCHED'});
});

test('zero is measured, missing detail stays null; corrupt duplicated receipts fail closed',async t=>{
 const {s,task,dataDir}=await setup(t),window=(await s.processingStatus()).window;
 await s.recordCodexUsage({...receipt(task),event:{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}});
 const status=await s.processingStatus();assert.deepEqual(status.window,window);assert.equal(status.usage.tokens.input_tokens,0);assert.equal(status.usage.tokens.cached_input_tokens,null);
 const raw=JSON.parse(await fs.readFile(dataDir+'/state.json'));raw.processing.jobs[0].metering.receipts.push(raw.processing.jobs[0].metering.receipts[0]);
 await fs.writeFile(dataDir+'/state.json',JSON.stringify(raw));const before=await fs.readFile(dataDir+'/state.json');
 await assert.rejects(s.processingStatus(),{code:'STATE_CORRUPT'});assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
});

// Exercise the installed SDK against our own static event emitter, never Codex CLI.
test('installed SDK synthetic cache-write zero remains unknown at the measurement boundary',async t=>{
 const {Codex}=await import('@openai/codex-sdk');
 const {s,task}=await setup(t),root=await temp(t),executable=root+'/fake-codex';
 const raw={type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:60,reasoning_output_tokens:8}};
 await fs.writeFile(executable,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(raw))}));\n`,{mode:0o700});
 const sdk=new Codex({codexPathOverride:executable,env:{}}),thread=sdk.startThread();
 const stream=await thread.runStreamed('Synthetic offline contract test');
 let completed;for await(const event of stream.events)completed=event;
 assert.equal(Object.hasOwn(raw.usage,'cache_write_input_tokens'),false);
 assert.equal(completed.usage.cache_write_input_tokens,0); // SDK 0.153.4 injects this default.
 await s.recordCodexUsage({...receipt(task),event:completed});
 const usage=(await s.processingStatus()).usage;
 assert.equal(usage.tokens.cache_write_input_tokens,null);
 assert.equal(usage.field_turns.cache_write_input_tokens,0);
 assert.equal(usage.tokens.cached_input_tokens,60);
});
