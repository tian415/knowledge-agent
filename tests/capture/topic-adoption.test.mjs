import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {createKnowledgeWriter} from '../../src/apply/knowledge.mjs';
import {createTopicPublisher} from '../../src/capture/topic-publish.mjs';
import {createPublishedSearch} from '../../src/capture/published-search.mjs';
import {temp,snapshot,now} from './helpers.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const original='\ufeff人工说明\r\n<!-- pk:begin:p:k -->\n旧框架，仍由人工维护。\n<!-- pk:end:p:k -->\n';
async function setup(t,mode='isolated'){
 const root=await temp(t),vault=root+'/vault';await fs.mkdir(vault,{mode:0o700});
 const store=await openCaptureStore({dataDir:root+'/capture'}),writer=await createKnowledgeWriter({dataDir:root+'/writer',vaultRoot:vault});
 let snap=snapshot();snap.messages[0].text='决定：先用AI草稿和店员审核，暂不开放自动支付。理由：称重规则未验证。未决：缺货替代。行动：验证一店试点。';
 async function synthesize(updated=false){
  await store.enqueueProcessing({snapshot:snap,recipe:'v1'});const {job}=await store.claimProcessing({now,maxJobs:20});const ref={message_id:snap.messages.at(-1).id,quote:snap.messages.at(-1).text};
  await store.finishProcessing({id:job.id,attempt:job.attempt,result:{decision:'draft',markdown:ref.quote,reason:'明确标注的机制夹具，不是真实用户决定',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null}});
  await store.registerTopic({project:'p',key:'k',title:'测试夹具：下单边界',recipe:'v1',source_ids:[job.id]});const topic=await store.claimTopic({now,maxJobs:20});
  if(updated){assert.ok(topic.previous.markdown.includes('暂不开放自动支付'));assert.ok(topic.review_contract.continuity.includes('被替代'));}
  await store.finishTopic({id:topic.id,attempt:topic.attempt,result:{kind:'project',project_type:'agreement',markdown:'# 测试夹具：下单边界\n\n'+(updated?'当前决定：允许顾客确认金额后调用支付；程序核验金额与权限。\n理由：称重和支付回调已在夹具中验证。\n被替代：此前“暂不开放自动支付”失效；店员审核仍保留。\n未决：缺货替代。\n行动：运行支付回归。':ref.quote),contribution:'人工编写的预期综合正文；程序只验证流程和证据',evidence:[{job_id:job.id,...ref}]}});return topic;
 }
 const topic=await synthesize();const relative_path='01-项目沉淀/p/主题.md',file=vault+'/'+relative_path;await fs.mkdir(vault+'/01-项目沉淀/p',{recursive:true});await fs.writeFile(file,original);
 const targets=[{project:'p',key:'k',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path}];
 const publisher=await createTopicPublisher({store,writer,vaultRoot:vault,mode,targets});
 const advance=async()=>{snap.messages.push({id:'m2',role:'user',text:'更新决定：称重规则与支付回调验证后，允许顾客确认金额后调用支付；取代暂不开放自动支付，程序仍核验金额和权限。缺货替代待定，下一步运行支付回归。',source_time:null,text_format:'source_text'});return synthesize(true);};
 return {root,vault,store,writer,publisher,topic,file,targets,advance};
}
const request=p=>({topic_id:p.topic_id,plan_id:p.id,expected_review_hash:p.review_hash,confirmed:true});
test('receipt-proven adoption wraps saved suffix exactly, excludes plain append from search, updates and rolls back without duplicate content',async t=>{
 const d=await setup(t),content='\n\n# 已经确认保存的补充\n\n助手建议未被采纳。\n';
 const receipt=await d.writer.prepare({materialId:d.topic.id,changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/主题.md',candidate_ids:[d.topic.id],content}]});
 const {knowledgeReviewHash}=await import('../../src/apply/knowledge.mjs');
 await assert.rejects(d.publisher.prepareAdoption({topic_id:d.topic.id,source_plan_id:receipt.id,expected_before_hash:hash(original)}),{code:'MERGE_REQUIRED'});
 await d.writer.apply({planId:receipt.id,expectedReviewHash:knowledgeReviewHash(receipt),confirmed:true});const saved=await fs.readFile(d.file,'utf8');
 const search=createPublishedSearch({store:d.store,publisher:d.publisher,vaultRoot:d.vault,runSearch:async({notes})=>({results:notes.map(n=>({file_path:n.id+'.md'}))})});assert.equal((await search.search({query:'补充'})).results.length,0);
 const input={topic_id:d.topic.id,source_plan_id:receipt.id,expected_before_hash:hash(saved)};
 await assert.rejects(d.publisher.prepareAdoption({...input,source_plan_id:'missing'}),{code:'MERGE_REQUIRED'});
 await assert.rejects(d.publisher.prepareAdoption({...input,expected_before_hash:hash(original)}),{code:'CONFLICT'});
 for(const value of [null,'short',42])await assert.rejects(d.publisher.prepareAdoption({...input,expected_before_hash:value}),{code:'INPUT_INVALID'});
 await assert.rejects(d.publisher.prepareAdoption({...input,take_all:true}),{code:'INPUT_INVALID'});
 const plan=await d.publisher.prepareAdoption(input);assert.notEqual(knowledgeReviewHash(plan),knowledgeReviewHash({...plan,changes:[{...plan.changes[0],source_plan_id:plan.id}]}));assert.equal(plan.changes[0].operation,'managed-topic-adopt');assert.equal(plan.changes[0].source_plan_id,receipt.id);assert.equal(plan.changes[0].content,content);assert.ok(plan.changes[0].after.startsWith(original));assert.equal(plan.changes[0].after.replace(/^<!-- knowledge-agent:topic:v1 .* (begin|end) -->\n/gm,''),saved);assert.equal(await fs.readFile(d.file,'utf8'),saved);
 await d.publisher.apply(request(plan));await d.publisher.apply(request(plan));assert.equal((await d.publisher.prepareAdoption(input)).id,plan.id);assert.equal((await search.search({query:'补充'})).results[0].topic_id,d.topic.id);
 const next=await d.advance(),update=await d.publisher.prepare({topic_id:next.id});await d.publisher.apply(request(update));const updated=await fs.readFile(d.file,'utf8');assert.ok(updated.startsWith(original));assert.ok(updated.includes('被替代：此前'));assert.ok(!updated.includes('已经确认保存的补充')); // replaced, not appended twice
 await d.publisher.rollback({plan_id:update.id,expected_review_hash:update.review_hash,confirmed:true});assert.equal(await fs.readFile(d.file,'utf8'),plan.changes[0].after);
 await d.publisher.rollback({plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});assert.equal(await fs.readFile(d.file,'utf8'),saved);assert.equal((await search.search({query:'补充'})).results.length,0);
});

test('adoption rejects another topic receipt and altered targets before any ownership plan is created',async t=>{
 const d=await setup(t),{knowledgeReviewHash}=await import('../../src/apply/knowledge.mjs');
 const receipt=await d.writer.prepare({materialId:'another-topic',changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/主题.md',candidate_ids:['another-topic'],content:'\n另一个主题的内容\n'}]});await d.writer.apply({planId:receipt.id,expectedReviewHash:knowledgeReviewHash(receipt),confirmed:true});const before=await fs.readFile(d.file,'utf8');
 await assert.rejects(d.publisher.prepareAdoption({topic_id:d.topic.id,source_plan_id:receipt.id,expected_before_hash:hash(before)}),{code:'MERGE_REQUIRED'});assert.equal((await d.writer.list()).length,1);assert.equal(await fs.readFile(d.file,'utf8'),before);
});


test('saved append without trailing newline cannot be silently normalized during adoption',async t=>{
 const d=await setup(t),{knowledgeReviewHash}=await import('../../src/apply/knowledge.mjs');
 const receipt=await d.writer.prepare({materialId:d.topic.id,changes:[{knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/p/主题.md',candidate_ids:[d.topic.id],content:'\n无结尾换行'}]});await d.writer.apply({planId:receipt.id,expectedReviewHash:knowledgeReviewHash(receipt),confirmed:true});const before=await fs.readFile(d.file,'utf8');
 await assert.rejects(d.publisher.prepareAdoption({topic_id:d.topic.id,source_plan_id:receipt.id,expected_before_hash:hash(before)}),{code:'MERGE_REQUIRED'});assert.equal(await fs.readFile(d.file,'utf8'),before);assert.equal((await d.writer.list()).length,1);
});


test('CLI adoption preview binds the configured target and receipt while preview-only refuses save',async t=>{
 const {createProductDemo}=await import('../../src/capture/demo.mjs'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{knowledgeReviewHash}=await import('../../src/apply/knowledge.mjs');const exec=promisify(execFile),d=await createProductDemo();t.after(()=>fs.rm(d.root,{recursive:true,force:true}));
 const relative=d.config.preview.targets[0].relative_path,file=d.config.preview.vault_root+'/'+relative;await fs.mkdir(file.slice(0,file.lastIndexOf('/')),{recursive:true});await fs.writeFile(file,original);const topic=(await d.store.processingStatus()).topics[0];
 const writer=await createKnowledgeWriter({dataDir:d.config.preview.writer_data_dir,vaultRoot:d.config.preview.vault_root});const receipt=await writer.prepare({materialId:topic.id,changes:[{knowledge_layer:d.config.preview.targets[0].knowledge_layer,relative_path:relative,candidate_ids:[topic.id],content:'\n保存过的正文。\n'}]});await writer.apply({planId:receipt.id,expectedReviewHash:knowledgeReviewHash(receipt),confirmed:true});const before=await fs.readFile(file,'utf8');
 const config={...d.config,write_mode:'preview-only'};await fs.writeFile(d.configFile,JSON.stringify(config));const input=d.root+'/adoption-input.json';await fs.writeFile(input,JSON.stringify({topic_id:topic.id,source_plan_id:receipt.id,expected_before_hash:hash(before)}),{mode:0o600});
 const plan=JSON.parse((await exec(process.execPath,['scripts/knowledge-workspace.mjs','topic-adoption-preview','--config',d.configFile,'--input',input])).stdout);assert.equal(plan.status,'PREPARED');assert.equal(plan.changes[0].operation,'managed-topic-adopt');assert.equal(await fs.readFile(file,'utf8'),before);
 const {openReviewWorkspace}=await import('../../src/capture/runtime.mjs');const ws=await openReviewWorkspace(config);await assert.rejects(ws.publisher.apply(request(plan)),{code:'REAL_WRITE_DISABLED'});
});
