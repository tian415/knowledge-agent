import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {createKnowledgeWriter} from '../../src/apply/knowledge.mjs';
import {managedTopicKey,renderManagedTopic} from '../../src/apply/managed-topic.mjs';
import {createTopicPublisher,readingContent} from '../../src/capture/topic-publish.mjs';
import {snapshot,temp,now} from './helpers.mjs';
import {messageHash} from '../../src/capture/model.mjs';
import {knowledgeReviewHash} from '../../src/apply/knowledge.mjs';
async function setup(t,mode='preview-only'){
 const root=await temp(t),vault=root+'/vault';await fs.mkdir(vault,{mode:0o700});
 const store=await openCaptureStore({dataDir:root+'/capture'}),writer=await createKnowledgeWriter({dataDir:root+'/writer',vaultRoot:vault});
 const snap=snapshot();await store.enqueueProcessing({snapshot:snap,recipe:'v1'});const {job}=await store.claimProcessing({now});const ref={message_id:'m1',quote:snap.messages[0].text};
 await store.finishProcessing({id:job.id,attempt:job.attempt,result:{decision:'draft',markdown:'材料',reason:'依据',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null}});
 await store.registerTopic({project:'p',key:'k',title:'主题',recipe:'v1',source_ids:[job.id]});const topic=await store.claimTopic({now});
 await store.finishTopic({id:topic.id,attempt:topic.attempt,result:{kind:'knowledge',markdown:'# 主题\n\n综合后的方法。',contribution:'综合增加的理解',evidence:[{job_id:job.id,...ref}]}});
 const relative_path='01-项目沉淀/p/主题.md';const publisher=await createTopicPublisher({store,writer,vaultRoot:vault,mode,targets:[{project:'p',key:'k',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path}]});
 return {root,vault,store,writer,publisher,topic,relative_path,snap};
}
const correctedResult=(jobId,body)=>({kind:'knowledge',markdown:`# 主题\n\n${body}`,contribution:'修订后增加的理解',evidence:[{job_id:jobId,message_id:'m1',quote:'先讨论'}]});
async function correct(store,topic,body){
 const state=await store.view(),job=state.processing.jobs[0];
 return store.correctTopic({id:topic.id,title:'主题',result:correctedResult(job.id,body)});
}
test('prepare binds real topic text and evidence without touching vault; production apply disabled',async t=>{
 const {publisher,vault,topic}=await setup(t);const plan=await publisher.prepare({topic_id:topic.id});
 assert.equal(plan.status,'PREPARED');assert.equal(plan.changes[0].before,null);assert.ok(plan.changes[0].after.includes('综合后的方法'));assert.ok(plan.changes[0].after.includes('message_id=m1'));
 assert.equal(plan.changes[0].operation,'managed-topic');assert.match(plan.changes[0].managed_key,/^[a-f0-9]{64}$/u);
 assert.deepEqual(await fs.readdir(vault),[]);
 await assert.rejects(publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true}),{code:'REAL_WRITE_DISABLED'});
});
test('isolated apply requires exact preview, writes once and survives restart of requests',async t=>{
 const {publisher,vault,topic,relative_path}=await setup(t,'isolated');const plan=await publisher.prepare({topic_id:topic.id});
 await assert.rejects(publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:'wrong',confirmed:true}),{code:'CONFIRMATION_REQUIRED'});
 const request={topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};
 assert.equal((await publisher.apply(request)).status,'APPLIED');const before=await fs.readFile(vault+'/'+relative_path,'utf8');
 await publisher.apply(request);assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),before);assert.equal((await publisher.prepare({topic_id:topic.id})).id,plan.id);
});
test('applied managed topic updates its block while preserving manual bytes outside it',async t=>{
 const {publisher,store,vault,topic,relative_path}=await setup(t,'isolated');
 const first=await publisher.prepare({topic_id:topic.id});await publisher.apply({topic_id:topic.id,plan_id:first.id,expected_review_hash:first.review_hash,confirmed:true});
 const applied=await fs.readFile(vault+'/'+relative_path,'utf8'),manual='\ufeff人工前言\r\n'+applied+'\r\n人工结尾';await fs.writeFile(vault+'/'+relative_path,manual);
 const revision=await correct(store,topic,'综合后的方法（第二版）。'),second=await publisher.prepare({topic_id:revision.id});
 assert.equal(second.changes[0].before,manual);assert.ok(second.changes[0].after.startsWith('\ufeff人工前言\r\n'));assert.ok(second.changes[0].after.endsWith('\r\n人工结尾'));
 assert.ok(second.changes[0].after.includes('综合后的方法（第二版）。'));assert.ok(!second.changes[0].after.includes('综合后的方法。'));
 const request={topic_id:revision.id,plan_id:second.id,expected_review_hash:second.review_hash,confirmed:true};assert.equal((await publisher.apply(request)).status,'APPLIED');
 const updated=await fs.readFile(vault+'/'+relative_path,'utf8');await publisher.apply(request);assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),updated);
});
test('source updates reject stale preview and target edits are never overwritten',async t=>{
 const {publisher,store,topic,snap,vault,relative_path}=await setup(t,'isolated');const plan=await publisher.prepare({topic_id:topic.id});
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(vault+'/'+relative_path,'人工笔记');
 const request={topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};await assert.rejects(publisher.apply(request),{code:'CONFLICT'});assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),'人工笔记');
 snap.messages[0].text='已经变化';await store.enqueueProcessing({snapshot:snap,recipe:'v1'});
 await assert.rejects(publisher.apply(request),{code:'STALE_INPUT'});
 assert.equal((await publisher.list()).plans[0].stale,true);
});
test('existing different topic note requires merging instead of appending the whole new draft',async t=>{
 const {publisher,writer,vault,relative_path,topic}=await setup(t);await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(vault+'/'+relative_path,'已有主题内容');
 const before=await fs.readFile(vault+'/'+relative_path);const initialPlans=await writer.list();
 await assert.rejects(publisher.prepare({topic_id:topic.id}),{code:'MERGE_REQUIRED'});
 await assert.rejects(publisher.prepare({topic_id:topic.id}),{code:'MERGE_REQUIRED'});
 assert.deepEqual(await writer.list(),initialPlans);assert.deepEqual(await fs.readFile(vault+'/'+relative_path),before);
});
test('marker text without matching writer history and duplicate managed blocks require manual merge',async t=>{
 const {publisher,vault,relative_path,topic}=await setup(t);const key=managedTopicKey('p','k');await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});
 for(const existing of [renderManagedTopic(key,'冒充的受管理内容'),renderManagedTopic(key,'一')+'\n'+renderManagedTopic(key,'二')]){
  await fs.writeFile(vault+'/'+relative_path,existing);await assert.rejects(publisher.prepare({topic_id:topic.id}),{code:'MERGE_REQUIRED'});assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),existing);
 }
});
test('manual edits inside an applied managed block block later preparation',async t=>{
 const {publisher,store,vault,topic,relative_path}=await setup(t,'isolated');const first=await publisher.prepare({topic_id:topic.id});
 await publisher.apply({topic_id:topic.id,plan_id:first.id,expected_review_hash:first.review_hash,confirmed:true});
 const live=await fs.readFile(vault+'/'+relative_path,'utf8');await fs.writeFile(vault+'/'+relative_path,live.replace('综合后的方法。','人工改过的方法。'));
 const revision=await correct(store,topic,'第二版内容。');await assert.rejects(publisher.prepare({topic_id:revision.id}),{code:'CONFLICT'});
 assert.ok((await fs.readFile(vault+'/'+relative_path,'utf8')).includes('人工改过的方法。'));
});
test('editing the target after an update preview conflicts without overwriting it',async t=>{
 const {publisher,store,vault,topic,relative_path}=await setup(t,'isolated');const first=await publisher.prepare({topic_id:topic.id});
 await publisher.apply({topic_id:topic.id,plan_id:first.id,expected_review_hash:first.review_hash,confirmed:true});
 const revision=await correct(store,topic,'第二版内容。'),plan=await publisher.prepare({topic_id:revision.id});
 const edited=(await fs.readFile(vault+'/'+relative_path,'utf8'))+'\n预览后的人工补充';await fs.writeFile(vault+'/'+relative_path,edited);
 await assert.rejects(publisher.apply({topic_id:revision.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true}),{code:'CONFLICT'});
 assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),edited);
});
test('list keeps matching legacy create-only previews, excludes unrelated plans and marks superseded topics stale',async t=>{
 const {publisher,writer,store,topic,relative_path}=await setup(t);const state=await store.view(),job=state.processing.jobs[0];
 const legacyContent='# 主题\n\n综合后的方法。\n\n## 整理依据\n\n综合增加的理解\n\n### Codex · 测试\n\n> 先讨论，尚未决定。\n';
 const legacy=await writer.prepare({materialId:topic.id,changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path,candidate_ids:[topic.id],content:legacyContent}]});
 await writer.prepare({materialId:'unrelated',changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/别处.md',candidate_ids:['other'],content:'别的计划'}]});
 assert.deepEqual((await publisher.list()).plans.map(p=>p.id),[legacy.id]);
 const revision=await store.correctTopic({id:topic.id,title:'主题',result:correctedResult(job.id,'新版本')});assert.notEqual(revision.id,topic.id);
 const listed=await publisher.list();assert.equal(listed.plans.length,1);assert.equal(listed.plans[0].id,legacy.id);assert.equal(listed.plans[0].stale,true);
});
test('plan identity cannot be swapped and capture lock holds across writer operation',async t=>{
 const {publisher,store,writer,topic,snap,vault,relative_path}=await setup(t,'isolated');
 const other=await writer.prepare({materialId:'unrelated',changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path,content:'别的内容',candidate_ids:[]}]});
 await assert.rejects(publisher.apply({topic_id:topic.id,plan_id:other.id,expected_review_hash:'bad',confirmed:true}),{code:'PLAN_MISMATCH'});
 const wrapped={...writer,prepare:async input=>{await assert.rejects(store.enqueueProcessing({snapshot:snap,recipe:'v2'}),{code:'BUSY'});return writer.prepare(input);}};
 const p=await createTopicPublisher({store,writer:wrapped,vaultRoot:vault,targets:[{project:'p',key:'k',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path}]});await p.prepare({topic_id:topic.id});
});

test('explicit confirmed mode requires preview consent and restores exact bytes with a durable record',async t=>{
 const {publisher,vault,topic,relative_path}=await setup(t,'confirmed');
 const plan=await publisher.prepare({topic_id:topic.id});
 const input={topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash};
 await assert.rejects(publisher.apply(input),{code:'CONFIRMATION_REQUIRED'});
 await publisher.apply({...input,confirmed:true});
 assert.ok((await fs.readFile(vault+'/'+relative_path,'utf8')).includes('综合后的方法'));
 await assert.rejects(publisher.rollback({plan_id:plan.id,expected_review_hash:'wrong',confirmed:true}),{code:'CONFIRMATION_REQUIRED'});
 assert.equal((await publisher.rollback({plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true})).status,'ROLLED_BACK');
 await assert.rejects(fs.stat(vault+'/'+relative_path),{code:'ENOENT'});
 const history=await publisher.list();assert.equal(history.plans[0].status,'ROLLED_BACK');
 assert.equal(history.plans[0].review_hash,plan.review_hash);
});

test('saved topic carries message and analysis version locators for independent provenance',async t=>{
 const {publisher,topic,store}=await setup(t);const plan=await publisher.prepare({topic_id:topic.id});
 const job=(await store.view()).processing.jobs[0];
 assert.ok(plan.changes[0].after.includes(job.id));
 assert.ok(plan.changes[0].after.includes('message_id=m1'));
 assert.match(plan.changes[0].after,/message_hash=[a-f0-9]{64}/u);
});

test('restore can undo a superseded source but refuses subsequent manual edits and unrelated plans',async t=>{
 const {publisher,writer,vault,store,topic,relative_path,snap}=await setup(t,'isolated');
 const plan=await publisher.prepare({topic_id:topic.id});
 await publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});
 const rollback={plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};
 const saved=await fs.readFile(vault+'/'+relative_path,'utf8');await fs.writeFile(vault+'/'+relative_path,saved+'人工修改');
 await assert.rejects(publisher.rollback(rollback),{code:'CONFLICT'});
 assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),saved+'人工修改');
 await fs.writeFile(vault+'/'+relative_path,saved);snap.messages[0].text='来源已改变';await store.enqueueProcessing({snapshot:snap,recipe:'v1'});
 assert.equal((await publisher.rollback(rollback)).status,'ROLLED_BACK');
 const unrelated=await writer.prepare({materialId:'other',changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path,content:'其它内容',candidate_ids:[]}]});
 await assert.rejects(publisher.rollback({plan_id:unrelated.id,expected_review_hash:'bad',confirmed:true}),{code:'PLAN_MISMATCH'});
});

test('reading format keeps the body first and collapses grouped evidence without visible audit IDs',async t=>{
 const {publisher,topic,store}=await setup(t);
 const plan=await publisher.prepare({topic_id:topic.id}),content=plan.changes[0].content;
 assert.ok(content.startsWith('综合后的方法。\n\n'));assert.ok(!/^# /mu.test(content));
 assert.match(content,/<details>\s*<summary>来源（1 段对话）<\/summary>/u);
 const main=content.split('<details>')[0];assert.ok(!main.includes('整理依据'));assert.ok(!main.includes('综合增加的理解'));
 const visible=content.replace(/<!--[\s\S]*?-->/gu,'');
 assert.ok(!visible.includes('message_id='));assert.ok(!visible.includes('message_hash='));assert.ok(!visible.includes('job_'));
 assert.equal((visible.match(/Codex · 测试/gu)??[]).length,1);
 assert.match(visible,/依据已读取内容整理/u);assert.ok(!visible.includes('<blockquote>'));
 assert.ok(content.includes((await store.view()).processing.jobs[0].id));
});

test('source labels and quotes cannot inject HTML or break out of collapsed evidence',async t=>{
 const {store,writer,vault,relative_path}=await setup(t);
 const snap=snapshot();snap.source.conversation_id='unsafe';snap.title='</summary><script>title</script>';snap.url='javascript:alert(1)';
 snap.messages=[{...snap.messages[0],id:'evil-->id',text:'</details><script>alert(1)</script>',source_time:'2026-09-10T08:00:00.000Z'},
  {...snap.messages[0],id:'answer',role:'assistant',text:'同一段对话的补充'}];
 await store.enqueueProcessing({snapshot:snap,recipe:'v1'});const {job}=await store.claimProcessing({now,maxJobs:10});
 const refs=snap.messages.map(m=>({message_id:m.id,quote:m.text}));
 await store.finishProcessing({id:job.id,attempt:job.attempt,result:{decision:'draft',markdown:'内部分析',reason:'依据',coverage:{question:[refs[0]],analysis:[refs[1]],ending:[refs[1]]},usage:null}});
 await store.registerTopic({project:'p',key:'escaped',title:'安全引用',recipe:'v1',source_ids:[job.id]});const topic=await store.claimTopic({now,maxJobs:10});
 await store.finishTopic({id:topic.id,attempt:topic.attempt,result:{kind:'project',project_type:'agreement',markdown:'# 安全引用',contribution:'保留依据',evidence:refs.map(r=>({job_id:job.id,...r}))}});
 const publisher=await createTopicPublisher({store,writer,vaultRoot:vault,targets:[{project:'p',key:'escaped',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path}]});
 const content=(await publisher.prepare({topic_id:topic.id})).changes[0].content;
 assert.equal((content.match(/<details>/gu)??[]).length,1);assert.equal((content.match(/<\/details>/gu)??[]).length,1);
 assert.ok(!content.includes('<script>'));assert.ok(content.includes('&lt;script&gt;'));assert.ok(!content.includes('href="javascript:'));
 assert.match(content,/1 段对话/u);assert.match(content,/2026-09-10/u);assert.ok(!content.includes('<blockquote>'));
 assert.ok(content.includes('message_id=evil--%3Eid'));
});

async function oldLocatedPlan(f){
 const job=(await f.store.view()).processing.jobs[0];
 const content='# 主题\n\n综合后的方法。\n\n## 整理依据\n\n综合增加的理解\n\n### Codex · 测试\n\n> 先讨论，尚未决定。\n\n来源定位：'+job.id+' · message_id=m1 · message_hash='+messageHash(job.snapshot.messages[0])+'\n';
 return f.writer.prepare({materialId:f.topic.id,changes:[{operation:'managed-topic',managed_key:managedTopicKey('p','k'),knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:f.relative_path,candidate_ids:[f.topic.id],content}]});
}
test('an applied located note upgrades formatting without a new semantic revision and preserves manual bytes',async t=>{
 const f=await setup(t,'isolated'),old=await oldLocatedPlan(f),oldHash=knowledgeReviewHash(old);
 await f.publisher.apply({topic_id:f.topic.id,plan_id:old.id,expected_review_hash:oldHash,confirmed:true});
 const original=await fs.readFile(f.vault+'/'+f.relative_path,'utf8');const manual='手写说明\r\n'+original+'\r\n手写结尾';await fs.writeFile(f.vault+'/'+f.relative_path,manual);
 const plan=await f.publisher.prepare({topic_id:f.topic.id});assert.notEqual(plan.id,old.id);assert.equal(plan.changes[0].before,manual);
 await assert.rejects(f.publisher.apply({topic_id:f.topic.id,plan_id:plan.id,expected_review_hash:oldHash,confirmed:true}),{code:'CONFIRMATION_REQUIRED'});
 await f.publisher.apply({topic_id:f.topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});
 const actual=await fs.readFile(f.vault+'/'+f.relative_path,'utf8');assert.ok(actual.startsWith('手写说明\r\n'));assert.ok(actual.endsWith('\r\n手写结尾'));assert.ok(actual.includes('<details>'));
 assert.equal((await f.publisher.prepare({topic_id:f.topic.id})).id,plan.id);
 assert.equal((await f.publisher.list()).plans.length,2);
 await f.publisher.rollback({plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});assert.equal(await fs.readFile(f.vault+'/'+f.relative_path,'utf8'),manual);
});
test('format upgrades still reject moving a published candidate to another file',async t=>{
 const f=await setup(t,'isolated'),old=await oldLocatedPlan(f);
 await f.publisher.apply({topic_id:f.topic.id,plan_id:old.id,expected_review_hash:knowledgeReviewHash(old),confirmed:true});
 const other=await createTopicPublisher({store:f.store,writer:f.writer,vaultRoot:f.vault,targets:[{project:'p',key:'k',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/另一个文件.md'}]});
 await assert.rejects(other.prepare({topic_id:f.topic.id}),{code:'DUPLICATE_CANDIDATE'});
});

test('compact source summary does not dump quotations into reading content',async t=>{
 const {publisher,topic,store}=await setup(t);const job=(await store.view()).processing.jobs[0];
 const result={...correctedResult(job.id,'正文'),source_summaries:[{job_id:job.id,summary:'讨论方案取舍，尚未拍板。'}]};
 const next=await store.correctTopic({id:topic.id,title:'主题',result});
 const content=(await publisher.prepare({topic_id:next.id})).changes[0].content;
 assert.match(content,/讨论方案取舍，尚未拍板。/u);
 assert.ok(!content.includes('<blockquote>'));assert.ok(!content.includes('处引用'));assert.match(content,/核验记录/u);
 assert.ok(content.includes('message_hash='));
});

test('routed knowledge cannot be published through a project-directory mapping',async t=>{
 const {store,writer,vault,topic,relative_path}=await setup(t);
 const state=await store.view(),base=state.processing.topics.revisions[0];
 const wrapped={...store,useCurrentTopic:async(id,fn)=>fn({...base,routing:{knowledge_layer:'ENGINEERING_THINKING',units:[]} },state.processing.jobs)};
 const publisher=await createTopicPublisher({store:wrapped,writer,vaultRoot:vault,targets:[{project:'p',key:'k',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path}]});
 await assert.rejects(publisher.prepare({topic_id:topic.id}),{code:'ROUTE_MISMATCH'});
 assert.deepEqual(await fs.readdir(vault),[]);
});

test('reviewed merge previews ordinary content, binds source and hash, applies once and rolls back',async t=>{
 const {publisher,writer,vault,relative_path,topic}=await setup(t,'isolated');
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});const before='# 旧主题\n\n人工有效内容。\n';await fs.writeFile(vault+'/'+relative_path,before);
 const {createHash}=await import('node:crypto');const sha=s=>createHash('sha256').update(s).digest('hex');
 const input={topic_id:topic.id,expected_before_hash:sha(before),merged_content:before+'\n本次合并后的方法及简洁来源。\n'};
 const plan=await publisher.prepareMerge(input);assert.equal(plan.changes[0].operation,'reviewed-merge');assert.equal(plan.changes[0].after,input.merged_content);
 assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),before);
 const req={topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};
 assert.equal((await publisher.apply(req)).status,'APPLIED');assert.equal((await publisher.apply(req)).status,'APPLIED');
 assert.equal((await publisher.prepareMerge(input)).id,plan.id);
 assert.equal((await publisher.list()).plans[0].stale,false);
 await publisher.rollback({plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),before);
});
test('reviewed merge rejects missing or stale baseline, later edits and changed topic',async t=>{
 const {publisher,store,vault,relative_path,topic}=await setup(t,'isolated');const {createHash}=await import('node:crypto');const sha=s=>createHash('sha256').update(s).digest('hex');
 const input={topic_id:topic.id,expected_before_hash:sha('old'),merged_content:'new'};
 await assert.rejects(publisher.prepareMerge(input),{code:'CONFLICT'});
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(vault+'/'+relative_path,'old');
 await assert.rejects(publisher.prepareMerge({...input,expected_before_hash:sha('other')}),{code:'CONFLICT'});
 const plan=await publisher.prepareMerge(input);await fs.writeFile(vault+'/'+relative_path,'manual');
 const req={topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};await assert.rejects(publisher.apply(req),{code:'CONFLICT'});assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),'manual');
 await correct(store,topic,'revised');await assert.rejects(publisher.apply(req),{code:'STALE_INPUT'});
});
test('reviewed merge remains disabled in preview-only mode',async t=>{
 const {publisher,vault,relative_path,topic}=await setup(t);const {createHash}=await import('node:crypto');
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(vault+'/'+relative_path,'old');
 const plan=await publisher.prepareMerge({topic_id:topic.id,expected_before_hash:createHash('sha256').update('old').digest('hex'),merged_content:'new'});
 await assert.rejects(publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true}),{code:'REAL_WRITE_DISABLED'});
});

test('reviewed merge cannot seize managed notes, inject markers, or omit the review hash',async t=>{
 const {publisher,writer,vault,relative_path,topic}=await setup(t,'isolated');const {createHash}=await import('node:crypto');const sha=s=>createHash('sha256').update(s).digest('hex');
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});
 for(const before of ['<!-- pk:start:p:k -->old<!-- pk:end:p:k -->',renderManagedTopic(managedTopicKey('p','k'),'old')]){
  await fs.writeFile(vault+'/'+relative_path,before);await assert.rejects(publisher.prepareMerge({topic_id:topic.id,expected_before_hash:sha(before),merged_content:'new'}),{code:'MERGE_REQUIRED'});
 }
 await fs.writeFile(vault+'/'+relative_path,'old');
 await assert.rejects(publisher.prepareMerge({topic_id:topic.id,expected_before_hash:sha('old'),merged_content:renderManagedTopic(managedTopicKey('p','k'),'new')}),{code:'INPUT_INVALID'});
 const plan=await publisher.prepareMerge({topic_id:topic.id,expected_before_hash:sha('old'),merged_content:'new'});
 await assert.rejects(writer.apply({planId:plan.id,confirmed:true}),{code:'CONFIRMATION_REQUIRED'});
 assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),'old');
});

test('reviewed merge exposes link checks and refuses lost or missing references at apply',async t=>{
 const {publisher,vault,relative_path,topic}=await setup(t,'isolated');const {createHash}=await import('node:crypto');const sha=s=>createHash('sha256').update(s).digest('hex');
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(vault+'/01-项目沉淀/p/pic.png','image');
 const before='# old\n![图](pic.png)\n';await fs.writeFile(vault+'/'+relative_path,before);
 const plan=await publisher.prepareMerge({topic_id:topic.id,expected_before_hash:sha(before),merged_content:'# new\n![失效](missing.png)\n'});
 assert.equal(plan.link_checks.removed_links.length,1);assert.equal(plan.link_checks.missing_links.length,1);
 await assert.rejects(publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true}),{code:'LINK_REVIEW_REQUIRED'});
 assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),before);
});

test('reviewed merge refuses uncertain prior writes and multi-target shortcut reuse',async t=>{
 const {publisher,writer,root,vault,relative_path,topic}=await setup(t,'isolated');const {createHash}=await import('node:crypto');const sha=s=>createHash('sha256').update(s).digest('hex');
 await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(vault+'/'+relative_path,'old');
 const input={topic_id:topic.id,expected_before_hash:sha('old'),merged_content:'new'},plan=await publisher.prepareMerge(input);
 const file=root+'/writer/knowledge-apply/plans/'+plan.id+'.json';const persisted=JSON.parse(await fs.readFile(file,'utf8'));persisted.status='PARTIAL';persisted.error={code:'WRITE_FAILED',message:'uncertain write'};await fs.writeFile(file,JSON.stringify(persisted),{mode:0o600});
 await assert.rejects(publisher.prepareMerge({...input,merged_content:'another'}),{code:'RECOVERY_REQUIRED'});
 await assert.rejects(writer.prepare({materialId:topic.id,changes:[plan.changes[0],{...plan.changes[0],relative_path:'01-项目沉淀/p/other.md'}]}),{code:'INPUT_INVALID'});
 assert.equal(await fs.readFile(vault+'/'+relative_path,'utf8'),'old');
});

test('older reading preview with inline duplicate title remains bound for explicit apply',async t=>{
 const {store,writer,publisher,topic}=await setup(t,'isolated');
 const old=await store.useCurrentTopic(topic.id,async(current,sources)=>writer.prepare({materialId:current.id,changes:[{operation:'managed-topic',managed_key:managedTopicKey('p','k'),knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/主题.md',candidate_ids:[current.id],content:readingContent(current,sources,{includeTitle:true})}]}));
 const listed=(await publisher.list()).plans.find(p=>p.id===old.id);assert.ok(listed);
 const result=await publisher.apply({topic_id:topic.id,plan_id:old.id,expected_review_hash:listed.review_hash,confirmed:true});assert.equal(result.status,'APPLIED');
});
