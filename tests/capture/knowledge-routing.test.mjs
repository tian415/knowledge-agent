import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';
const ref={message_id:'m1',quote:'先讨论，尚未决定。'};
const unit=(key,layer,project)=>({key,title:key,knowledge_layer:layer,project,summary:'保留适用条件与未确认状态',reason:'按内容而非聊天目录归类',evidence:[ref]});
const targets=[{project:'p',key:'ordering',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/下单.md'},{project:'general-knowledge',key:'execution',knowledge_layer:'ENGINEERING_THINKING',relative_path:'02-方法论/工程思维/执行边界.md'}];
async function setup(t,units){
 const store=await openCaptureStore({dataDir:(await temp(t))+'/capture'});
 await store.enqueueProcessing({snapshot:snapshot(),recipe:'knowledge-units-v2'});
 const {job}=await store.claimProcessing({now});
 const result={decision:'draft',markdown:'内部材料',reason:'存在多个去向',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null,knowledge_units:units};
 return {store,job,result};
}
test('one source routes independently into project and reusable method; unresolved units block batch registration',async t=>{
 const {store,job,result}=await setup(t,[unit('ordering','PROJECT_KNOWLEDGE','p'),unit('execution','ENGINEERING_THINKING','general-knowledge')]);
 await store.finishProcessing({id:job.id,attempt:job.attempt,result});
 const input={source_ids:[job.id],targets};
 const plan=await store.previewRoutes(input);assert.equal(plan.routes.length,2);assert.deepEqual(plan.unresolved,[]);
 assert.equal((await store.processingStatus()).topics.length,0);
 const registered=await store.registerRoutes({...input,expected_hash:plan.review_hash});assert.equal(registered.topics.length,2);
 const claim=await store.claimTopic({now,maxJobs:10});
 assert.equal(claim.sources[0].analysis.knowledge_units.length,1);assert.ok(!Object.hasOwn(claim.sources[0].analysis,'markdown'));
 assert.equal(claim.topic.routing.knowledge_layer,'PROJECT_KNOWLEDGE');
 const pending=await store.previewRoutes({...input,targets:targets.slice(0,1)});assert.equal(pending.unresolved.length,1);
 await assert.rejects(store.registerRoutes({...input,targets:targets.slice(0,1),expected_hash:pending.review_hash}),{code:'ROUTING_REQUIRED'});
 assert.equal((await store.registerRoutes({...input,expected_hash:plan.review_hash})).topics[0].status,'NO_CHANGE');
 const source=(await store.view()).processing.jobs[0].snapshot;source.messages[0].text+='新信息';await store.enqueueProcessing({snapshot:source,recipe:'knowledge-units-v2'});
 await assert.rejects(store.previewRoutes(input),{code:'STALE_INPUT'});
});
test('source units validate evidence, category, duplicates and v2 requires explicit split review',async t=>{
 const {store,job,result}=await setup(t,[unit('execution','ENGINEERING_THINKING','general-knowledge')]);
 const finish=r=>store.finishProcessing({id:job.id,attempt:job.attempt,result:r});
 const missing=structuredClone(result);delete missing.knowledge_units;await assert.rejects(finish(missing),{code:'ROUTING_REQUIRED'});
 const invalid=structuredClone(result);invalid.knowledge_units[0].evidence[0].quote='不存在';await assert.rejects(finish(invalid),{code:'INVALID_EVIDENCE'});
 const duplicate=structuredClone(result);duplicate.knowledge_units.push(duplicate.knowledge_units[0]);await assert.rejects(finish(duplicate));
 await finish(result);
 const plan=await store.previewRoutes({source_ids:[job.id],targets});
 await assert.rejects(store.registerRoutes({source_ids:[job.id],targets,expected_hash:'wrong'}),{code:'ROUTE_CONFLICT'});
 assert.equal((await store.processingStatus()).topics.length,0);
});
test('routed result cannot change category or cite an unselected unit',async t=>{
 const {store,job,result}=await setup(t,[unit('execution','ENGINEERING_THINKING','general-knowledge')]);
 await store.finishProcessing({id:job.id,attempt:job.attempt,result});const input={source_ids:[job.id],targets};const plan=await store.previewRoutes(input);
 await store.registerRoutes({...input,expected_hash:plan.review_hash});const claim=await store.claimTopic({now,maxJobs:10});
 const output={kind:'project',markdown:'# 错误归属',contribution:'错误',evidence:[{job_id:job.id,...ref}],source_summaries:[{job_id:job.id,summary:'讨论执行边界，尚未确认。'}]};
 await assert.rejects(store.finishTopic({id:claim.id,attempt:claim.attempt,result:output}),{code:'ROUTE_MISMATCH'});
 output.kind='knowledge';await store.finishTopic({id:claim.id,attempt:claim.attempt,result:output});
 assert.equal((await store.processingStatus()).topics[0].routing.knowledge_layer,'ENGINEERING_THINKING');
});

test('rerouting updated source keeps stale draft invalid and accepts explicitly reviewed new units',async t=>{
 const {store,job,result}=await setup(t,[unit('execution','ENGINEERING_THINKING','general-knowledge')]);
 await store.finishProcessing({id:job.id,attempt:job.attempt,result});
 let input={source_ids:[job.id],targets},plan=await store.previewRoutes(input);await store.registerRoutes({...input,expected_hash:plan.review_hash});
 const topic=await store.claimTopic({now,maxJobs:10});
 const changed=snapshot();changed.messages[0].text+=' 新的限制';await store.enqueueProcessing({snapshot:changed,recipe:'knowledge-units-v2'});
 assert.equal((await store.processingStatus()).topics[0].status,'needs_update');
 const next=await store.claimProcessing({now,maxJobs:10});await store.finishProcessing({id:next.job.id,attempt:next.job.attempt,result});
 input={source_ids:[next.job.id],targets};plan=await store.previewRoutes(input);assert.deepEqual(plan.unresolved,[]);
 await store.registerRoutes({...input,expected_hash:plan.review_hash});
 await assert.rejects(store.finishTopic({id:topic.id,attempt:topic.attempt,result:{kind:'knowledge',markdown:'旧结果',contribution:'旧',evidence:[{job_id:job.id,...ref}],source_summaries:[{job_id:job.id,summary:'旧'}]}}),{code:'STALE_INPUT'});
});

test('route preview expires after editorial correction and fresh repetition preserves corrected revision',async t=>{
 const {store,job,result}=await setup(t,[unit('execution','ENGINEERING_THINKING','general-knowledge')]);
 await store.finishProcessing({id:job.id,attempt:job.attempt,result});
 const input={source_ids:[job.id],targets};let plan=await store.previewRoutes(input);await store.registerRoutes({...input,expected_hash:plan.review_hash});
 const claim=await store.claimTopic({now,maxJobs:10});
 const output={kind:'knowledge',markdown:'# 原稿',contribution:'保留边界',evidence:[{job_id:job.id,...ref}],source_summaries:[{job_id:job.id,summary:'方案讨论'}]};
 await store.finishTopic({id:claim.id,attempt:claim.attempt,result:output});
 plan=await store.previewRoutes(input);
 const corrected=await store.correctTopic({id:claim.id,title:'人工纠正标题',result:{...output,markdown:'# 人工纠正'}});
 await assert.rejects(store.registerRoutes({...input,expected_hash:plan.review_hash}),{code:'ROUTE_CONFLICT'});
 const fresh=await store.previewRoutes(input);await store.registerRoutes({...input,expected_hash:fresh.review_hash});
 assert.equal((await store.processingStatus()).topics[0].id,corrected.id);
 assert.equal((await store.processingStatus()).topics[0].result.markdown,'# 人工纠正');
 const beforeFeedback=await store.previewRoutes(input);
 await store.recordTopicFeedback({id:corrected.id,expected_feedback_id:null,action:'dismiss',title:'',markdown:'',reason:'人工暂不收录'});
 await assert.rejects(store.registerRoutes({...input,expected_hash:beforeFeedback.review_hash}),{code:'ROUTE_CONFLICT'});
 const afterFeedback=await store.previewRoutes(input);await store.registerRoutes({...input,expected_hash:afterFeedback.review_hash});
 assert.equal((await store.processingStatus()).topics[0].status,'dismissed');
 await assert.rejects(store.registerTopic(plan.routes[0].registration),{code:'STALE_INPUT'});
 assert.equal((await store.processingStatus()).topics[0].id,corrected.id);
});
