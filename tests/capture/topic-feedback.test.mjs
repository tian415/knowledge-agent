import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createProductDemo} from '../../src/capture/demo.mjs';
import {openReviewWorkspace} from '../../src/capture/runtime.mjs';
import {createProductApp} from '../../src/app/product.mjs';

async function fixture(t){const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));return demo;}
const feedback=(topic,action='edit',previous=null)=>({id:topic.id,expected_feedback_id:previous,action,title:action==='edit'?'人工修改标题':'',markdown:action==='edit'?'# 人工修改标题\n\n新增说明仍需核对。':'',reason:action==='edit'?'补充说明，请核对原文。':'本轮暂不保留。'});

test('browser edits persist as feedback, block old save and require exact feedback acknowledgment',async t=>{
 const demo=await fixture(t),topic=(await demo.store.processingStatus()).topics[0],plan=await demo.publisher.prepare({topic_id:topic.id});
 const input=feedback(topic),result=await demo.store.recordTopicFeedback(input);
 assert.equal(result.status,'RECORDED');assert.equal((await demo.store.recordTopicFeedback(input)).status,'NO_CHANGE');
 const reopened=await openReviewWorkspace(demo.config),current=(await reopened.store.processingStatus()).topics[0];
 assert.equal(current.status,'review_required');assert.equal(current.feedback.markdown,input.markdown);
 assert.equal(current.result.markdown,topic.result.markdown); // not silently accepted as evidence-backed text
 const sourceBefore=await fs.readFile(demo.config.data_dir+'/state.json');
 const sources=await reopened.store.topicSources(topic.id);
 assert.equal(sources.sources.length,2);
 assert.equal(sources.sources.find(s=>s.snapshot.source.system==='codex').snapshot.messages.length,2);
 assert.deepEqual(await fs.readFile(demo.config.data_dir+'/state.json'),sourceBefore);
 assert.equal((await reopened.claimTopic(new Date().toISOString())).status,'ATTENTION_REQUIRED');
 await assert.rejects(reopened.publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true}),{code:'REVIEW_REQUIRED'});
 assert.equal((await reopened.publisher.list()).plans[0].stale,true);
 const correction={id:topic.id,title:input.title,result:{...topic.result,markdown:input.markdown,contribution:'人工修改已基于原文复核；未添加来源之外的事实。'}};
 await assert.rejects(reopened.store.correctTopic(correction),{code:'FEEDBACK_CONFLICT'});
 const corrected=await reopened.store.correctTopic({...correction,feedback_id:result.id});
 assert.equal(corrected.status,'CORRECTED');assert.equal((await reopened.store.processingStatus()).topics[0].status,'completed');
 await assert.rejects(reopened.publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true}),{code:'STALE_INPUT'});
});

test('stale editor cannot replace newer feedback; dismiss and reopen do not erase history or become permanent exclusion',async t=>{
 const demo=await fixture(t),topic=(await demo.store.processingStatus()).topics[0];
 const oldPlan=await demo.publisher.prepare({topic_id:topic.id});
 const first=await demo.store.recordTopicFeedback(feedback(topic));
 const before=await fs.readFile(demo.config.data_dir+'/state.json');
 await assert.rejects(demo.store.recordTopicFeedback(feedback(topic,'dismiss')),{code:'FEEDBACK_CONFLICT'});
 assert.deepEqual(await fs.readFile(demo.config.data_dir+'/state.json'),before);
 const dismissed=await demo.store.recordTopicFeedback(feedback(topic,'dismiss',first.id));
 assert.equal((await demo.store.processingStatus()).topics[0].status,'dismissed');
 const reopened=await demo.store.recordTopicFeedback(feedback(topic,'reopen',dismissed.id));
 assert.equal((await demo.store.recordTopicFeedback(feedback(topic,'reopen',dismissed.id))).status,'NO_CHANGE');
 const restored=(await demo.store.processingStatus()).topics[0];
 assert.equal(restored.status,'completed');assert.notEqual(restored.id,topic.id);
 await assert.rejects(demo.publisher.apply({topic_id:topic.id,plan_id:oldPlan.id,expected_review_hash:oldPlan.review_hash,confirmed:true}),{code:'STALE_INPUT'});
 await demo.store.recordTopicFeedback(feedback(restored,'dismiss'));
 await demo.advance();
 const updated=(await demo.store.processingStatus()).topics[0];
 assert.equal(updated.status,'completed');assert.equal(updated.feedback,null);
 assert.equal((await demo.store.view()).processing.topics.feedback.length,4);
 await assert.rejects(demo.store.recordTopicFeedback(feedback(topic)),{code:'STALE_INPUT'});
});

test('feedback HTTP is authenticated and cannot directly change accepted topic output',async t=>{
 const demo=await fixture(t),app=await createProductApp({workspace:demo,config:demo.config,runtime:demo.runtime,loadRegistry:async()=>({projects:[],learning_domains:[]})});
 const url=await app.listen(0);t.after(()=>app.close());
 const page=await(await fetch(url+'/capture/')).text(),token=/name="app-token" content="([^"]+)"/u.exec(page)[1];
 const topic=(await demo.store.processingStatus()).topics[0],input=feedback(topic);
 const post=(auth,body)=>fetch(url+'/capture/api/topic-feedback',{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':auth},body:JSON.stringify(body)});
 assert.equal((await post('wrong',input)).status,403);
 assert.equal((await post(token,input)).status,200);
 assert.equal((await post(token,{...input,markdown:'另一个过时编辑'})).status,409);
 assert.equal((await fetch(url+'/capture/api/topic-correct',{method:'POST'})).status,404);
 const sourceRequest=token=>fetch(url+'/capture/api/topic-sources',{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':token},body:JSON.stringify({topic_id:topic.id})});
 assert.equal((await sourceRequest('wrong')).status,403);
 const sourceResponse=await sourceRequest(token);assert.equal(sourceResponse.status,200);
 assert.equal((await sourceResponse.json()).sources.length,2);
 assert.equal((await demo.store.processingStatus()).topics[0].result.markdown,topic.result.markdown);
});
