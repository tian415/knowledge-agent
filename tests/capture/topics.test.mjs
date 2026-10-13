import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';
async function source(s,id,body='先讨论，尚未决定。'){
 const a=snapshot();a.source.conversation_id=id;a.messages[0].text=body;await s.enqueueProcessing({snapshot:a,recipe:'v1'});
 const {job}=await s.claimProcessing({now,maxJobs:20,maxInputBytes:120000});const ref={message_id:'m1',quote:body};
 await s.finishProcessing({id:job.id,attempt:job.attempt,result:{decision:'draft',markdown:'内部材料分析',reason:'相关讨论',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null}});return job.id;
}
const spec=ids=>({project:'p',key:'topic-a',title:'同一问题的知识更新',recipe:'synthesis-v1',source_ids:ids});
const output=ids=>({kind:'knowledge',markdown:'# 同一问题的知识更新\n\n合并后得到的方法。',contribution:'将讨论关联成一个可复用的方法，而非逐条复述。',evidence:ids.map(job_id=>({job_id,message_id:'m1',quote:'先讨论'}))});
test('topic combines sources, deduplicates membership order and survives restart',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),ids=[await source(s,'a'),await source(s,'b')];
 const registered=await s.registerTopic(spec(ids));assert.equal((await s.registerTopic(spec([...ids].reverse()))).status,'NO_CHANGE');
 const task=await s.claimTopic({now,maxJobs:20});assert.equal(task.status,'CLAIMED');assert.equal(task.sources.length,2);
 await s.finishTopic({id:registered.id,attempt:task.attempt,result:output(ids)});
 const reopened=await openCaptureStore({dataDir});assert.equal((await reopened.claimTopic({now,maxJobs:20})).status,'NO_WORK');
 const view=await reopened.processingStatus();assert.equal(view.topics.length,1);assert.equal(view.topics[0].source_count,2);assert.equal(view.topics[0].result.kind,'knowledge');
});
test('changed input invalidates only linked topics and stale finish cannot overwrite',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=await source(s,'a'),b=await source(s,'b');
 await s.registerTopic(spec([a]));await s.registerTopic({...spec([b]),key:'unrelated'});
 const task=await s.claimTopic({now,maxJobs:20});
 const newA=await source(s,'a','先讨论，新增条件。');
 await assert.rejects(s.finishTopic({id:task.id,attempt:task.attempt,result:output([a])}),{code:'STALE_INPUT'});
 const view=await s.processingStatus();assert.equal(view.topics.find(x=>x.key==='topic-a').status,'queued');assert.equal(view.topics.find(x=>x.key==='unrelated').status,'queued');
 await s.registerTopic(spec([newA]));assert.equal((await s.claimTopic({now,maxJobs:20})).topic.key,'unrelated');
});
test('topic evidence must cover each source; project output and no-value do not become knowledge',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),ids=[await source(s,'a'),await source(s,'b')];await s.registerTopic(spec(ids));const task=await s.claimTopic({now,maxJobs:20});
 await assert.rejects(s.finishTopic({id:task.id,attempt:task.attempt,result:output([ids[0]])}),{code:'INVALID_EVIDENCE'});
 await s.finishTopic({id:task.id,attempt:task.attempt,result:{...output(ids),kind:'project'}});
 assert.equal((await s.processingStatus()).topics[0].result.kind,'project');
});
test('topic budget shares source budget and uncertain attempts are not redispatched',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),id=await source(s,'a');await s.registerTopic(spec([id]));
 assert.equal((await s.claimTopic({now,maxJobs:1})).status,'BUDGET_DEFERRED');
 const task=await s.claimTopic({now,maxJobs:2});assert.equal(task.status,'CLAIMED');assert.equal((await s.claimTopic({now,maxJobs:20})).status,'ATTENTION_REQUIRED');
});

test('topic queue uses its full claim payload for budget diagnosis, and reads do not spend the budget',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),id=await source(s,'a');await s.registerTopic(spec([id]));
 const before=await fs.readFile(dataDir+'/state.json'),budget={now,maxJobs:20,maxInputBytes:10};
 const view=await s.processingStatus(budget);assert.equal(view.queue.length,1);assert.equal(view.queue[0].kind,'topic');
 assert.equal(view.queue[0].reason,'INPUT_EXCEEDS_LIMIT');assert.equal(view.queue[0].retry_at,null);
 assert.deepEqual((await s.claimTopic(budget)).deferred,view.queue);
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 const task=await s.claimTopic({...budget,maxInputBytes:120000});assert.equal(task.input_bytes,view.queue[0].input_bytes);
});
test('invalid memberships and corrupt topic results fail closed',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),id=await source(s,'a');
 await assert.rejects(s.registerTopic(spec(['fake'])),{code:'CONTEXT_REQUIRED'});
 await assert.rejects(s.registerTopic(spec([id,id])),{code:'INPUT_INVALID'});
 await s.registerTopic(spec([id]));const raw=JSON.parse(await fs.readFile(dataDir+'/state.json','utf8'));raw.processing.topics.revisions[0].id='wrong';await fs.writeFile(dataDir+'/state.json',JSON.stringify(raw));
 await assert.rejects(s.processingStatus(),{code:'STATE_CORRUPT'});
});
test('source changes immediately hide old theme and no-value is a reusable terminal result',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),id=await source(s,'a');await s.registerTopic(spec([id]));const task=await s.claimTopic({now,maxJobs:20});
 const result={...output([id]),kind:'no_value',markdown:''};await s.finishTopic({id:task.id,attempt:task.attempt,result});
 assert.equal((await s.finishTopic({id:task.id,attempt:task.attempt,result})).status,'NO_CHANGE');assert.equal((await s.claimTopic({now,maxJobs:20})).status,'NO_WORK');
 const changed=snapshot();changed.source.conversation_id='a';changed.messages[0].text='新内容';await s.enqueueProcessing({snapshot:changed,recipe:'v1'});
 const view=await s.processingStatus();assert.equal(view.topics[0].status,'needs_update');assert.equal(view.topics[0].result,null);
});
test('concurrent topic claims dispatch once; explicit deferral closes uncertain attempt',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),id=await source(s,'a');await s.registerTopic(spec([id]));
 const results=await Promise.allSettled([s.claimTopic({now,maxJobs:20}),s.claimTopic({now,maxJobs:20})]);
 const claimed=results.filter(r=>r.status==='fulfilled'&&r.value.status==='CLAIMED');assert.equal(claimed.length,1);
 const {id:topicId,attempt}=claimed[0].value;await s.deferTopic({id:topicId,attempt,reason:'待核对已有结果，不自动重试'});
 assert.equal((await s.claimTopic({now,maxJobs:20})).status,'ATTENTION_REQUIRED');
});
test('explicit correction versions classification without redispatch and invalidates old preview',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),ids=[await source(s,'a')];await s.registerTopic(spec(ids));const task=await s.claimTopic({now,maxJobs:20});await s.finishTopic({id:task.id,attempt:task.attempt,result:output(ids)});
 const before=(await s.processingStatus()).window;
 const input={id:task.id,title:'本项目的整理约定',result:{...output(ids),kind:'project',project_type:'agreement',markdown:'# 本项目的整理约定\n\n这是预期行为。'}};
 const corrected=await s.correctTopic(input);assert.notEqual(corrected.id,task.id);assert.equal((await s.correctTopic(input)).status,'NO_CHANGE');
 const status=await s.processingStatus();assert.equal(status.topics[0].result.project_type,'agreement');assert.deepEqual(status.window,before);
 await assert.rejects(s.useCurrentTopic(task.id,()=>{}),{code:'STALE_INPUT'});
 assert.equal((await s.view()).processing.topics.revisions.length,2);
 await assert.rejects(s.correctTopic({...input,id:corrected.id,result:{...input.result,kind:'knowledge'}}),{code:'INPUT_INVALID'});
});

test('stale running topic attempts remain visible and recoverable without redispatch',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),id=await source(s,'a');
 await s.registerTopic(spec([id]));const task=await s.claimTopic({now,maxJobs:20});
 await source(s,'a','先讨论，新条件已出现。');
 const reopened=await openCaptureStore({dataDir});
 const view=await reopened.processingStatus();
 assert.equal(view.unresolved_attempts,1);
 assert.deepEqual(view.pending_attempts.map(a=>({kind:a.kind,id:a.id,attempt:a.attempt,stale:a.stale})),
  [{kind:'topic',id:task.id,attempt:task.attempt,stale:true}]);
 assert.equal((await reopened.claimTopic({now,maxJobs:20})).status,'ATTENTION_REQUIRED');
 await reopened.deferTopic({id:task.id,attempt:task.attempt,reason:'旧输入已变化，保留旧尝试并明确停止。'});
 assert.equal((await reopened.processingStatus()).unresolved_attempts,0);
 assert.deepEqual((await reopened.processingStatus()).pending_attempts,[]);
 assert.equal((await reopened.claimTopic({now,maxJobs:20})).status,'CLAIMED');
});

test('topic claim receives the same classification contract and allows zero knowledge',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),ids=[await source(s,'classification')];
 await s.registerTopic(spec(ids));const task=await s.claimTopic({now,maxJobs:20});
 assert.equal(task.review_contract?.version,'classification-v2');
 assert.match(task.review_contract.no_value,/零条/);assert.match(task.review_contract.evidence,/历史/);
 await s.finishTopic({id:task.id,attempt:task.attempt,result:{...output(ids),kind:'project',project_type:'progress',markdown:'# 历史验收记录'}});
 assert.equal((await s.processingStatus()).topics[0].result.kind,'project');
});

for(const action of ['dismiss','edit'])test(`source refresh preserves ${action} feedback without registering another topic`,async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),id=await source(s,'feedback-refresh');
 await s.registerTopic(spec([id]));const task=await s.claimTopic({now,maxJobs:20});await s.finishTopic({id:task.id,attempt:task.attempt,result:output([id])});
 const recorded=await s.recordTopicFeedback({id:task.id,expected_feedback_id:null,action,title:action==='edit'?'人工标题':'',markdown:action==='edit'?'# 人工标题\n\n待复核的人工补充。':'',reason:'保留本次人工决定。'});
 const changed=snapshot();changed.source.conversation_id='feedback-refresh';changed.messages[0].text='先讨论，新增条件。';await s.enqueueProcessing({snapshot:changed,recipe:'v2'});
 let state=await s.processingStatus();assert.equal(state.topics[0].status,action==='dismiss'?'dismissed':'review_required');assert.equal(state.topics[0].source_stale,true);assert.equal(state.topics[0].result,null);
 const {job}=await s.claimProcessing({now,maxJobs:20,maxInputBytes:120000});const ref={message_id:'m1',quote:changed.messages[0].text};
 await s.finishProcessing({id:job.id,attempt:job.attempt,result:{decision:'draft',markdown:'新材料',reason:'新增条件',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null}});
 const reopened=await openCaptureStore({dataDir});state=await reopened.processingStatus();
 assert.equal(state.topics[0].id,task.id);assert.equal(state.topics[0].status,action==='dismiss'?'dismissed':'review_required');assert.equal(state.topics[0].feedback.id,recorded.id);assert.equal(state.topics[0].source_stale,true);
 assert.equal((await reopened.view()).processing.topics.revisions.length,1);assert.equal((await reopened.claimTopic({now,maxJobs:20})).status,action==='dismiss'?'NO_WORK':'ATTENTION_REQUIRED');
 await assert.rejects(reopened.useCurrentTopic(task.id,()=>{}),{code:'STALE_INPUT'});
});
