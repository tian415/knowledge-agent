import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildBackfillInventory} from '../../src/capture/backfill-inventory.mjs';
import {sourceKey} from '../../src/capture/model.mjs';
const source={system:'chatgpt',scope:'conversation:c1',conversation_id:'c1'};
const config={chatgpt:{thread_ids:['c1','c2']},codex:null,project_roots:[],preview:{targets:[{project:'p',key:'a',knowledge_layer:'GENERAL_KNOWLEDGE',relative_path:'03-长期知识/a.md'}]}};
function state(recipe='knowledge-units-v2') {const key=sourceKey(source);return {sources:[],processing:{jobs:[{id:'j',source_key:key,recipe,status:'completed',snapshot:{source,title:'真实讨论',completeness:'partial',gaps:['incomplete_tail'],messages:[]},result:{decision:'draft',knowledge_units:[{key:"unit"}]}}],latest:{[key]:'j'},topics:{revisions:[],latest:{}}}};}
test('partial does not claim complete; no manifest means historical coverage unknown',()=>{const out=buildBackfillInventory({config,state:state()});assert.equal(out.history_coverage,'unknown');assert.equal(out.sources[0].completeness,'partial');assert.deepEqual(out.sources[0].gaps,['incomplete_tail']);assert.equal(out.sources[1].status,'unread');});
test('manifest exposes authorized unread sources and rejects unauthorized sources',()=>{const out=buildBackfillInventory({config,state:state(),manifest:{sources:[{source:{...source,conversation_id:'c2',scope:'conversation:c2'},title:'未读'}]}});assert.equal(out.history_coverage,'manifest_only');assert.equal(out.sources.find(s=>s.source.conversation_id==='c2').status,'unread');assert.throws(()=>buildBackfillInventory({config,state:state(),manifest:{sources:[{source:{...source,conversation_id:'outside'},title:'越界'}]}}),{code:'SOURCE_SCOPE_MISMATCH'});});
test('old recipe needs reorganization and no_value is explicit skip',()=>{assert.equal(buildBackfillInventory({config,state:state('project-analysis-v1')}).sources[0].status,'legacy_recipe');const s=state();s.processing.jobs[0].result.decision='no_value';assert.equal(buildBackfillInventory({config,state:s}).sources[0].status,'no_value');});
function withTopic(){const s=state();s.processing.topics={revisions:[{id:'t',project:'p',key:'a',title:'主题',source_ids:['j'],status:'completed',routing:{units:[{job_id:'j',key:'unit'}]},result:{kind:'knowledge'}}],latest:{k:'t'},feedback:[]};return s;}
test('dismissed feedback stays dismissed and review feedback is not save-ready',()=>{const s=withTopic();s.processing.topics.feedback=[{topic_id:'t',action:'dismiss'}];assert.equal(buildBackfillInventory({config,state:s}).sources[0].status,'dismissed');s.processing.topics.feedback[0].action='edit';assert.equal(buildBackfillInventory({config,state:s}).sources[0].status,'awaiting_topic');});
test('saved requires verified receipt; one saved topic cannot hide an unfinished topic',()=>{const s=withTopic();assert.equal(buildBackfillInventory({config,state:s}).sources[0].status,'organized_unwritten');assert.equal(buildBackfillInventory({config,state:s,saveProofs:{t:{verified:true,plan_id:'plan'}}}).sources[0].status,'saved');s.processing.topics.revisions.push({id:'t2',source_ids:['j'],status:'queued'});s.processing.topics.latest.b='t2';assert.equal(buildBackfillInventory({config,state:s,saveProofs:{t:{verified:true}}}).sources[0].status,'awaiting_topic');});
test('source needs_context and stale topic override optimistic saved flags',()=>{const s=withTopic();s.processing.jobs[0].status='blocked';s.processing.jobs[0].result.decision='needs_context';assert.equal(buildBackfillInventory({config,state:s,saveProofs:{t:{verified:true}}}).sources[0].status,'needs_context');});

test('automated exclusion is explicit and does not create work to reopen',()=>{const s=state();s.processing.jobs[0].snapshot.gaps=['automated_session_excluded'];s.processing.jobs[0].status='blocked';assert.equal(buildBackfillInventory({config,state:s}).sources[0].status,'excluded');});

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {readBackfillInventory,writeBackfillInventory} from '../../src/capture/backfill-inventory.mjs';
import {snapshot,now} from './helpers.mjs';
import {readingContent} from '../../src/capture/topic-publish.mjs';
import {renderManagedTopic,managedTopicKey} from '../../src/apply/managed-topic.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
async function liveFixture(t,{recipe='knowledge-units-v2'}={}){
 const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'inventory-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const name of ['project','vault','capture','writer'])await fs.mkdir(path.join(dir,name),{mode:0o700});
 const store=await openCaptureStore({dataDir:path.join(dir,'capture')});const snap=snapshot();snap.source={system:"chatgpt",scope:"conversation:c1",conversation_id:"c1"};
 const ref={message_id:snap.messages[0].id,quote:snap.messages[0].text};
 await store.enqueueProcessing({snapshot:snap,recipe});const {job}=await store.claimProcessing({now});
 await store.finishProcessing({id:job.id,attempt:job.attempt,result:{decision:'draft',markdown:'内部材料',reason:'保留知识',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null,knowledge_units:[{key:'a',title:'主题',knowledge_layer:'GENERAL_KNOWLEDGE',project:'p',summary:'通用知识',reason:'可复用',evidence:[ref]}]}});
 const targets=[{project:'p',key:'a',knowledge_layer:'GENERAL_KNOWLEDGE',relative_path:'03-长期知识/a.md'}];
 const input={source_ids:[job.id],targets};if(recipe==='knowledge-units-v2'){const routes=await store.previewRoutes(input);await store.registerRoutes({...input,expected_hash:routes.review_hash});}else await store.registerTopic({project:'p',key:'a',title:'主题',recipe:'topic-v1',source_ids:[job.id]});const claim=await store.claimTopic({now,maxJobs:10});
 await store.finishTopic({id:claim.id,attempt:claim.attempt,result:{kind:'knowledge',markdown:'# 笔记',contribution:'补充',evidence:[{job_id:job.id,...ref}],source_summaries:[{job_id:job.id,summary:'讨论可复用的知识。'}]}});
 const runtime={schema_version:1,data_dir:path.join(dir,'capture'),project_roots:[path.join(dir,'project')],codex:null,chatgpt:{thread_ids:[snap.source.conversation_id]},budget:{max_jobs:10,max_input_bytes:200000},preview:{writer_data_dir:path.join(dir,'writer'),vault_root:path.join(dir,'vault'),targets},write_mode:'preview-only',port:0};
 const configPath=path.join(dir,'runtime.json');await fs.writeFile(configPath,JSON.stringify(runtime),{mode:0o600});
 const state=await store.view(),topic=state.processing.topics.revisions[0];
 return {dir,configPath,runtime,state,topic,store};
}
test('real readonly reader verifies receipt/current bytes and detects changed or missing saved target',async t=>{
 const f=await liveFixture(t);const statePath=path.join(f.runtime.data_dir,'state.json'),before=await fs.readFile(statePath);
 const content=readingContent(f.topic,f.state.processing.jobs),after='# 完整合并结果\n';
 const relative_path=f.runtime.preview.targets[0].relative_path,file=path.join(f.runtime.preview.vault_root,relative_path);
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,after);
 const plans=path.join(f.runtime.preview.writer_data_dir,'knowledge-apply','plans');await fs.mkdir(plans,{recursive:true,mode:0o700});
 const receipt={id:'00000000-0000-0000-0000-000000000000',status:'APPLIED',material_id:f.topic.id,vault_root:f.runtime.preview.vault_root,changes:[{operation:'reviewed-merge',before:'原有内容',before_hash:sha('原有内容'),expected_before_hash:sha('原有内容'),content:after,status:'APPLIED',relative_path,knowledge_layer:'GENERAL_KNOWLEDGE',candidate_ids:[f.topic.id],after,after_hash:sha(after),source_content_hash:sha(content)}]};
 const receiptPath=path.join(plans,receipt.id+'.json');await fs.writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});
 assert.equal((await readBackfillInventory({configPath:f.configPath})).inventory.sources[0].status,'saved');
 await fs.writeFile(file,after+'人工修改');const changed=(await readBackfillInventory({configPath:f.configPath})).inventory.sources[0];assert.equal(changed.status,'organized_unwritten');assert.equal(changed.topics[0].save_proof.reason,'current_target_changed');
 await fs.writeFile(file,after);receipt.changes[0].source_content_hash=sha('旧来源');await fs.writeFile(receiptPath,JSON.stringify(receipt));assert.equal((await readBackfillInventory({configPath:f.configPath})).inventory.sources[0].status,'organized_unwritten');
 assert.deepEqual(await fs.readFile(statePath),before);assert.deepEqual(await fs.readdir(f.runtime.data_dir),['state.json']);
});
test('current runtime authorization guards existing ledger and output cannot enter protected trees',async t=>{
 const f=await liveFixture(t);const {config,inventory}=await readBackfillInventory({configPath:f.configPath});
 await assert.rejects(writeBackfillInventory({config,inventory,out:path.join(f.runtime.preview.vault_root,'preview')}),{code:'UNSAFE_PATH'});
 f.runtime.chatgpt.thread_ids=[];await fs.writeFile(f.configPath,JSON.stringify(f.runtime));await assert.rejects(readBackfillInventory({configPath:f.configPath}),{code:'SOURCE_SCOPE_MISMATCH'});
});

test('no_value topic needs no receipt and is not a pending write',()=>{const s=withTopic();s.processing.topics.revisions[0].result.kind='no_value';assert.equal(buildBackfillInventory({config,state:s}).sources[0].status,'no_value');});


test('legacy recipe with real persisted dismiss feedback stays dismissed',async t=>{
 const f=await liveFixture(t,{recipe:'project-analysis-v1'});
 await f.store.recordTopicFeedback({id:f.topic.id,expected_feedback_id:null,action:'dismiss',title:'',markdown:'',reason:'重复旧主题，已合并整理。'});
 const before=await fs.readFile(path.join(f.runtime.data_dir,'state.json'));
 const out=(await readBackfillInventory({configPath:f.configPath})).inventory.sources[0];assert.equal(out.status,'dismissed');assert.equal(out.topics[0].status,'dismissed');
 assert.deepEqual(await fs.readFile(path.join(f.runtime.data_dir,'state.json')),before);
});
test('matching current hash cannot prove unrelated managed content or key belongs to current topic',async t=>{
 const f=await liveFixture(t),content=readingContent(f.topic,f.state.processing.jobs),key=managedTopicKey(f.topic.project,f.topic.key);
 const relative_path=f.runtime.preview.targets[0].relative_path,file=path.join(f.runtime.preview.vault_root,relative_path),plans=path.join(f.runtime.preview.writer_data_dir,'knowledge-apply','plans');
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.mkdir(plans,{recursive:true,mode:0o700});
 const c={operation:'managed-topic',managed_key:key,status:'APPLIED',relative_path,knowledge_layer:'GENERAL_KNOWLEDGE',candidate_ids:[f.topic.id],before:null,content,after:renderManagedTopic(key,content)};c.after_hash=sha(c.after);
 const r={id:'00000000-0000-0000-0000-000000000001',status:'APPLIED',material_id:f.topic.id,vault_root:f.runtime.preview.vault_root,changes:[c]},receiptPath=path.join(plans,r.id+'.json');
 const save=async()=>{c.after_hash=sha(c.after);await fs.writeFile(file,c.after);await fs.writeFile(receiptPath,JSON.stringify(r),{mode:0o600});return (await readBackfillInventory({configPath:f.configPath})).inventory.sources[0].status;};
 assert.equal(await save(),'saved');
 c.content='不属于该主题的内容';c.after=renderManagedTopic(key,c.content);assert.equal(await save(),'organized_unwritten');
 c.content=content;c.managed_key=managedTopicKey('other','topic');c.after=renderManagedTopic(c.managed_key,content);assert.equal(await save(),'organized_unwritten');
});
test('reviewed merge requires exact content and original target hash binding',async t=>{
 const f=await liveFixture(t),content=readingContent(f.topic,f.state.processing.jobs),after='# 合并',relative_path=f.runtime.preview.targets[0].relative_path,file=path.join(f.runtime.preview.vault_root,relative_path),plans=path.join(f.runtime.preview.writer_data_dir,'knowledge-apply','plans');
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.mkdir(plans,{recursive:true,mode:0o700});await fs.writeFile(file,after);
 const c={operation:'reviewed-merge',before:'原文',expected_before_hash:sha('原文'),content:after,after,after_hash:sha(after),source_content_hash:sha(content),status:'APPLIED',relative_path,knowledge_layer:'GENERAL_KNOWLEDGE',candidate_ids:[f.topic.id]};
 const r={id:'00000000-0000-0000-0000-000000000002',status:'APPLIED',material_id:f.topic.id,vault_root:f.runtime.preview.vault_root,changes:[c]},receiptPath=path.join(plans,r.id+'.json');
 const read=async()=>{await fs.writeFile(receiptPath,JSON.stringify(r),{mode:0o600});return (await readBackfillInventory({configPath:f.configPath})).inventory.sources[0].status;};
 assert.equal(await read(),'saved');c.content='另一个结果';assert.equal(await read(),'organized_unwritten');c.content=after;c.expected_before_hash=sha('另一份原文');assert.equal(await read(),'organized_unwritten');
});

test('stale sources preserve real dismiss/edit feedback in inventory and do not reopen work',async t=>{
 for(const action of ['dismiss','edit']){
  const f=await liveFixture(t,{recipe:'project-analysis-v1'});
  await f.store.recordTopicFeedback({id:f.topic.id,expected_feedback_id:null,action,title:action==='edit'?'人工修订':'',markdown:action==='edit'?'# 人工修订':'',reason:'保留人工反馈。'});
  const changed=structuredClone(f.state.processing.jobs[0].snapshot);changed.messages[0].text+=' 新来源内容';await f.store.enqueueProcessing({snapshot:changed,recipe:'project-analysis-v1'});
  const before=await fs.readFile(path.join(f.runtime.data_dir,'state.json'));
  const out=(await readBackfillInventory({configPath:f.configPath})).inventory.sources[0];
  assert.equal(out.status,action==='dismiss'?'dismissed':'awaiting_topic');assert.equal(out.topics[0].status,action==='dismiss'?'dismissed':'review_required');assert.equal(out.topics[0].source_stale,true);
  assert.equal(out.topics[0].id,f.topic.id);assert.deepEqual(await fs.readFile(path.join(f.runtime.data_dir,'state.json')),before);
 }
});
