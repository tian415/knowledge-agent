import {reviewContract} from '../../src/capture/review-contract.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';
const input=()=>({snapshot:snapshot(),recipe:'analysis-v1'});
const result=s=>({decision:'draft',markdown:'测试分析',reason:'有新增价值',coverage:{question:[{message_id:s.messages[0].id,quote:s.messages[0].text}],analysis:[{message_id:s.messages[0].id,quote:s.messages[0].text}],ending:[{message_id:s.messages.at(-1).id,quote:s.messages.at(-1).text}]},usage:null});
const claim=s=>s.claimProcessing({now,maxJobs:3,maxInputBytes:120000});
test('same input is processed once across restart and capture time changes',async t=>{
 const dataDir=await temp(t);let s=await openCaptureStore({dataDir});const a=input();const queued=await s.enqueueProcessing(a);
 const task=await claim(s);assert.equal(task.status,'CLAIMED');assert.equal(task.job.id,queued.id);
 await s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:result(a.snapshot)});
 s=await openCaptureStore({dataDir});await s.enqueueProcessing({...a,snapshot:{...a.snapshot,captured_at:'2026-09-21T08:00:00.000Z'}});
 assert.equal((await claim(s)).status,'NO_WORK');assert.equal((await s.processingStatus()).completed,1);
});
test('only changed source is dispatched; previous result is available, stale result rejected',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=input();await s.enqueueProcessing(a);let task=await claim(s);
 await s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:result(a.snapshot)});
 const b=structuredClone(a);b.snapshot.messages.push({...b.snapshot.messages[0],id:'m2',text:'补充比较结论。'});await s.enqueueProcessing(b);task=await claim(s);
 assert.equal(task.job.snapshot.messages.length,2);assert.equal(task.previous.markdown,'测试分析');
 const c=structuredClone(b);c.snapshot.messages[1].text='再次修正。';await s.enqueueProcessing(c);
 await assert.rejects(s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:result(b.snapshot)}),{code:'STALE_INPUT'});
});
test('coverage and recipe changes invalidate; role/order/branch remain part of identity',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=input();const first=await s.enqueueProcessing(a);
 const b=structuredClone(a);b.snapshot.gaps.push('incomplete_tail');assert.notEqual((await s.enqueueProcessing(b)).id,first.id);
 assert.notEqual((await s.enqueueProcessing({...a,recipe:'v2'})).id,first.id);
});
test('budget is durable, queued work resumes after ten days without truncation',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir});await s.enqueueProcessing(input());
 assert.equal((await s.claimProcessing({now,maxJobs:1,maxInputBytes:1})).status,'BUDGET_DEFERRED');
 const task=await s.claimProcessing({now,maxJobs:1,maxInputBytes:120000});assert.equal(task.status,'CLAIMED');
 const b=input();b.snapshot.source.conversation_id='t2';await s.enqueueProcessing(b);
 const reopened=await openCaptureStore({dataDir});assert.equal((await reopened.claimProcessing({now,maxJobs:1,maxInputBytes:120000})).status,'BUDGET_DEFERRED');
 assert.equal((await reopened.claimProcessing({now:'2026-09-30T08:00:00.000Z',maxJobs:1,maxInputBytes:120000})).status,'CLAIMED');
});

test('budget diagnostics distinguish an oversized source from a spent window without consuming or truncating work',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),a=input();
 a.snapshot.messages[0].text='完整上下文，不可截断。'.repeat(100);await s.enqueueProcessing(a);
 const before=await fs.readFile(dataDir+'/state.json'),budget={now,maxJobs:1,maxInputBytes:100};
 const view=await s.processingStatus(budget);assert.equal(view.queue[0].reason,'INPUT_EXCEEDS_LIMIT');
 assert.equal(view.queue[0].input_bytes,Buffer.byteLength(JSON.stringify({snapshot:a.snapshot,previous:null,review_contract:reviewContract})));
 assert.equal(view.queue[0].retry_at,null);assert.equal(view.budget.remaining_jobs,1);
 assert.deepEqual((await s.claimProcessing(budget)).deferred,view.queue);
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 const task=await s.claimProcessing({...budget,maxInputBytes:120000});
 assert.equal(task.job.snapshot.messages[0].text,a.snapshot.messages[0].text);
 const b=input();b.snapshot.source.conversation_id='next';await s.enqueueProcessing(b);
 const pending=await s.processingStatus({...budget,maxInputBytes:120000});
 assert.equal(pending.queue[0].reason,'WINDOW_EXHAUSTED');assert.equal(pending.queue[0].retry_at,'2026-09-30T08:00:00.000Z');
 const next=await s.processingStatus({...budget,now:'2026-09-30T08:00:00.000Z',maxInputBytes:120000});
 assert.equal(next.queue[0].reason,null);assert.equal(next.budget.remaining_jobs,1);
});
test('interrupted claims are not automatically retried, even in next cycle; repeat completion is idempotent',async t=>{
 const dataDir=await temp(t);let s=await openCaptureStore({dataDir});await s.enqueueProcessing(input());const task=await claim(s);s=await openCaptureStore({dataDir});
 assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');
 assert.equal((await s.claimProcessing({now:'2026-10-10T08:00:00.000Z',maxJobs:3,maxInputBytes:120000})).status,'ATTENTION_REQUIRED');
 const finish={id:task.job.id,attempt:task.job.attempt,result:result(task.job.snapshot)};await s.finishProcessing(finish);
 assert.equal((await s.finishProcessing(finish)).status,'NO_CHANGE');
 await assert.rejects(s.finishProcessing({...finish,result:{...finish.result,markdown:'different'}}),{code:'RESULT_CONFLICT'});
});
test('missing context stays blocked; invalid evidence and corrupted processing state fail closed',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir});await s.enqueueProcessing(input());const task=await claim(s);
 const bad=result(task.job.snapshot);bad.coverage.question[0].quote='不存在的内容';
 await assert.rejects(s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:bad}),{code:'INVALID_EVIDENCE'});
 await s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:{decision:'needs_context',markdown:'',reason:'缺少比较开头',coverage:null,usage:null}});
 assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');assert.equal((await s.processingStatus()).blocked,1);
 const raw=JSON.parse(await fs.readFile(dataDir+'/state.json','utf8'));raw.processing.jobs[0].id='wrong';await fs.writeFile(dataDir+'/state.json',JSON.stringify(raw));
 await assert.rejects(s.processingStatus(),{code:'STATE_CORRUPT'});
});
test('concurrent claim returns at most one copy and changed source scope isolates jobs',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)});await s.enqueueProcessing(input());
 const out=await Promise.allSettled([claim(s),claim(s)]);assert.equal(out.filter(x=>x.status==='fulfilled'&&x.value.status==='CLAIMED').length,1);
 const b=input();b.snapshot.source.scope='other';await s.enqueueProcessing(b);assert.equal((await claim(s)).status,'CLAIMED');
});
test('explicitly defer uncertain stale attempt without rerunning it, then process updated input',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)});await s.enqueueProcessing(input());const task=await claim(s);
 const b=input();b.snapshot.messages[0].text='更正原来的决定。';await s.enqueueProcessing(b);
 assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');
 await s.deferProcessing({id:task.job.id,attempt:task.job.attempt,reason:'结果未保存，旧输入已变化，停止旧尝试。'});
 assert.equal((await claim(s)).status,'CLAIMED');
});
test('known compaction blocks dispatch; limited nontext coverage stays visible on a completed topic draft',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=input();a.snapshot.gaps.push('compaction_or_rollback');
 assert.equal((await s.enqueueProcessing(a)).status,'CONTEXT_REQUIRED');assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');
 const b=input();b.snapshot.gaps.push('attachment_or_nontext_not_read');await s.enqueueProcessing(b);const task=await claim(s);
 await s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:result(b.snapshot)});
 const status=await s.processingStatus();assert.equal(status.jobs[0].completeness,'partial');assert.ok(status.jobs[0].gaps.includes('attachment_or_nontext_not_read'));
});

test('stale running source attempts expose recovery identity without raw conversation text',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=input();
 await s.enqueueProcessing(a);const task=await claim(s);
 const b=input();b.snapshot.messages[0].text='已经修改的来源';await s.enqueueProcessing(b);
 const view=await s.processingStatus();
 assert.equal(view.pending_attempts.length,1);
 assert.deepEqual(view.pending_attempts[0],{kind:'source',id:task.job.id,attempt:task.job.attempt,title:a.snapshot.title,stale:true});
 assert.ok(!JSON.stringify(view.pending_attempts).includes(a.snapshot.messages[0].text));
 assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');
});

test('partial refresh missing analyzed messages blocks synthesis until context is restored',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=input();
 a.snapshot.messages.push({...a.snapshot.messages[0],id:'m2',text:'后续的结论依赖前面的限制。'});
 await s.enqueueProcessing(a);const original=await claim(s);
 await s.finishProcessing({id:original.job.id,attempt:original.job.attempt,result:result(a.snapshot)});
 const partial=structuredClone(a);partial.snapshot.messages.shift();
 assert.equal((await s.enqueueProcessing(partial)).status,'CONTEXT_REQUIRED');
 assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');
 const extended=structuredClone(partial);extended.snapshot.messages.push({...extended.snapshot.messages[0],id:'m3',text:'另一条新增消息。'});
 assert.equal((await s.enqueueProcessing(extended)).status,'CONTEXT_REQUIRED');
 assert.equal((await claim(s)).status,'ATTENTION_REQUIRED');
 const restored=structuredClone(a);restored.snapshot.messages.push(extended.snapshot.messages[1]);
 assert.equal((await s.enqueueProcessing(restored)).status,'QUEUED');
 const task=await claim(s);assert.equal(task.job.snapshot.messages.length,3);
 assert.equal((await s.view()).processing.jobs.find(j=>j.id===original.job.id).status,'completed');
});

test('replaying an already analyzed shorter partial cannot roll back the current source',async t=>{
 const dataDir=await temp(t),s=await openCaptureStore({dataDir}),short=input();
 await s.enqueueProcessing(short);let task=await claim(s);
 await s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:result(short.snapshot)});
 const long=structuredClone(short);long.snapshot.messages.push({...long.snapshot.messages[0],id:'m2',text:'更新后的结论必须保留。'});
 await s.enqueueProcessing(long);task=await claim(s);
 await s.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:result(long.snapshot)});
 const before=await fs.readFile(dataDir+'/state.json');
 assert.equal((await s.enqueueProcessing(short)).status,'CONTEXT_REQUIRED');
 assert.deepEqual(await fs.readFile(dataDir+'/state.json'),before);
 const current=(await s.processingStatus()).jobs[0];
 assert.equal(current.id,task.job.id);assert.equal(current.message_count,2);assert.equal(current.status,'completed');
});

test('source claim carries classification criteria before synthesis and budgets their bytes',async t=>{
 const s=await openCaptureStore({dataDir:await temp(t)}),a=input();await s.enqueueProcessing(a);
 const task=await claim(s);assert.equal(task.review_contract?.version,'classification-v2');
 assert.match(task.review_contract.knowledge,/适用条件/);assert.match(task.review_contract.project,/历史验收/);
 assert.equal(task.input_bytes,Buffer.byteLength(JSON.stringify({snapshot:a.snapshot,previous:null,review_contract:task.review_contract})));
});
