import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createProductApp} from '../../src/app/product.mjs';
import {createProductDemo} from '../../src/capture/demo.mjs';

test('one local product serves topic review and action workspace with separate session tokens and one writer store',async t=>{
 const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));
 const app=await createProductApp({workspace:demo,config:demo.config,runtime:demo.runtime,demoAdvance:demo.advance,loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]})});
 const origin=await app.listen(0);t.after(()=>app.close());
 const dashboard=await(await fetch(origin)).text();assert.ok(dashboard.includes('/capture/'));
 const topicPage=await(await fetch(origin+'/capture/')).text();assert.ok(topicPage.includes('<base href="/capture/">'));
 const mainToken=dashboard.match(/name="app-token" content="([a-f0-9]+)"/u)[1],topicToken=topicPage.match(/name="app-token" content="([a-f0-9]+)"/u)[1];assert.notEqual(mainToken,topicToken);
 assert.equal((await fetch(origin+'/capture/runs.js')).status,200);
 const before=await(await fetch(origin+'/api/state')).json();assert.equal(before.configured,false);
 const topic=(await demo.store.processingStatus()).topics[0];
 const post=async(route,body,token)=>fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json','x-app-token':token},body:JSON.stringify(body)});
 assert.equal((await post('/capture/api/topic-preview',{topic_id:topic.id},mainToken)).status,403);
 const plan=await(await post('/capture/api/topic-preview',{topic_id:topic.id},topicToken)).json();assert.ok(plan.review_hash);
 // The generic writer endpoint must not bypass the topic's current-source check.
 const bypass=await post('/api/knowledge/apply',{planId:plan.id,confirmed:true,expectedReviewHash:plan.review_hash},mainToken);assert.equal(bypass.status,400);
 assert.equal((await post('/capture/api/topic-apply',{topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true},topicToken)).status,200);
 const after=await(await fetch(origin+'/api/state')).json();assert.equal(after.plans.length,0);
 assert.equal((await(await fetch(origin+'/capture/api/topic-previews')).json()).plans[0].status,'APPLIED');
});

test('preview-only product also denies legacy material writer routes',async t=>{
 const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));
 const config={...demo.config,write_mode:'preview-only'};
 const app=await createProductApp({workspace:demo,config,runtime:{...demo.runtime,vault_write_enabled:false},loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]})});
 const origin=await app.listen(0);t.after(()=>app.close());const page=await(await fetch(origin)).text(),token=page.match(/name="app-token" content="([a-f0-9]+)"/u)[1];
 const response=await fetch(origin+'/api/knowledge/apply',{method:'POST',headers:{origin,'content-type':'application/json','x-app-token':token},body:JSON.stringify({planId:'anything',confirmed:true,expectedReviewHash:'0'.repeat(64)})});
 assert.equal((await response.json()).error.code,'REAL_WRITE_DISABLED');
});

test('capture action appears in the main workspace, requires its displayed version and never invokes material processing',async t=>{
 const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));
 const app=await createProductApp({workspace:demo,config:demo.config,runtime:demo.runtime,loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]})});
 const url=await app.listen(0);t.after(()=>app.close());const page=await(await fetch(url)).text(),token=page.match(/name="app-token" content="([a-f0-9]+)"/u)[1];
 const post=(route,body,auth=token)=>fetch(url+route,{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':auth},body:JSON.stringify(body)});
 const read=async()=>await(await fetch(url+'/api/state')).json();
 let state=await read();assert.equal(state.workspace.actions.length,1);assert.equal(state.materials.length,0);assert.equal(state.configured,false);
 let action=state.workspace.actions[0];assert.equal(action.type,'SUGGESTION');assert.equal(action.formal,false);
 const input={id:action.id,expected_review_hash:action.review_hash,decision:'accept'};
 assert.equal((await post('/api/actions/decide',input,'invalid')).status,403);
 assert.equal((await post('/api/actions/decide',{...input,expected_review_hash:'wrong'})).status,409);
 assert.equal((await post('/api/actions/decide',input)).status,200);
 assert.equal((await post('/api/actions/decide',input)).status,200);
 state=await read();action=state.workspace.actions[0];assert.equal(action.status,'OPEN');assert.equal(state.materials.length,0);
 assert.equal((await post('/api/snapshots',{source:'demo-list',updated_at:new Date().toISOString(),items:[{id:'todo-1',title:'验证原文保真',status:'open'}]})).status,200);
 assert.equal((await post('/api/snapshots/link',{source:'demo-list',item_id:'todo-1',action_id:action.id})).status,200);
 assert.equal((await read()).workspace.actions[0].primary_source,'demo-list');
 const source=await post('/api/actions/source',{id:action.id,expected_review_hash:action.review_hash});assert.equal(source.status,200);assert.equal((await source.json()).snapshot.messages.length,2);
 await demo.advance();assert.equal((await post('/api/actions/decide',{id:action.id,expected_review_hash:action.review_hash,decision:'complete'})).status,409);
 state=await read();assert.equal(state.workspace.actions.length,1);assert.equal(state.workspace.actions[0].status,'OPEN');
 action=state.workspace.actions[0];assert.equal((await post('/api/actions/decide',{id:action.id,expected_review_hash:action.review_hash,decision:'complete'})).status,200);
 assert.equal((await read()).workspace.actions[0].status,'COMPLETED');
 assert.equal((await read()).workspace.snapshots[0].items[0].action_id,action.id);
});
