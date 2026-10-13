import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../../src/app/server.mjs';
import { organize } from '../../src/intake/organize.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'knowledge-app-test-'));
  const vaultRoot = path.join(root, 'vault'); await fs.mkdir(vaultRoot);
  let calls = 0;
  const app = await createApp({dataDir:path.join(root,'data'),vaultRoot,loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]}),organizer:input=>organize(input,{provider:{async generateJson({messages}) {
    calls++; const {material}=JSON.parse(messages[1].content); const first=material.raw_content.split('\n')[0];
    const evidence=[{line_start:1,line_end:1,snippet:first}],none={route_type:null,route_id:null,route_name:null};
    return {text:JSON.stringify({knowledge_candidates:[{knowledge_layer:'ENGINEERING_THINKING',title:'保留原文',content:'哈希使用原始字节。',reason:'工程依据',route:none,evidence}],action_candidates:[{action:'考虑验证',type:'SUGGESTION',status:'PROPOSED',reason:'建议',related:none,evidence}]}),usage:null,llm_requests:1};
  }}})});
  const origin=await app.listen(0);
  t.after(async()=>{await app.close(); await fs.rm(root,{recursive:true,force:true});});
  const post=(url,body,headers={})=>fetch(origin+url,{method:'POST',headers:{'content-type':'application/json',origin,'x-app-token':app.token,...headers},body:JSON.stringify(body)});
  return {root,vaultRoot,app,origin,post,calls:()=>calls};
}
test('loopback API refuses cross-site, missing-token and forged-host requests before any model work',async t=>{
  const f=await setup(t);
  assert.equal((await f.post('/api/materials',{raw_content:'hi'}, {origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.post('/api/materials',{raw_content:'hi'}, {'x-app-token':''})).status,403);
  const status=await new Promise((resolve,reject)=>{const req=http.get(f.origin+'/api/state',{headers:{host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(status,403);assert.equal(f.calls(),0);
});
test('new input and duplicate preserve raw bytes; refresh makes no model requests and suggestions require acceptance',async t=>{
  const f=await setup(t),input={raw_content:'用户：可以如何验证？\r\n AI 建议  \n',source_type:'chatgpt'};
  const first=await (await f.post('/api/materials',input)).json(); assert.equal(first.status,'NEW');
  const saved=await (await fetch(f.origin+'/api/materials/'+first.material_id)).json();assert.equal(saved.material.raw_content,input.raw_content);
  assert.equal((await (await f.post('/api/materials',input)).json()).status,'NO_CHANGE');
  let state=await (await fetch(f.origin+'/api/state')).json();
  assert.equal(state.workspace.actions.length,1);assert.equal(state.workspace.focus.length,0);
  await fetch(f.origin+'/api/state'); assert.equal(f.calls(),1);
  const id=state.workspace.actions[0].id;
  assert.equal((await f.post('/api/actions/decide',{id,decision:'accept'})).status,200);
  state=await (await fetch(f.origin+'/api/state')).json();assert.equal(state.workspace.focus.length,1);
});
test('server prepares only stored candidates, requires concrete confirmation and applies without duplicating',async t=>{
  const f=await setup(t);const first=await (await f.post('/api/materials',{raw_content:'只保留来源',source_type:'text'})).json();
  const prepared=await f.post('/api/knowledge/prepare',{material_id:first.material_id,selections:[{index:0,relative_path:'02-方法论/工程思维/字节.md'}]});
  assert.equal(prepared.status,200);const plan=await prepared.json();assert.ok(plan.id);
  assert.deepEqual(await fs.readdir(f.vaultRoot),[]);
  assert.notEqual((await f.post('/api/knowledge/apply',{planId:plan.id,confirmed:false})).status,200);
  assert.equal((await f.post('/api/knowledge/apply',{planId:plan.id,confirmed:true,expectedReviewHash:plan.review_hash})).status,200);
  const file=path.join(f.vaultRoot,'02-方法论/工程思维/字节.md');const content=await fs.readFile(file,'utf8');
  assert.match(content,/哈希使用原始字节/);assert.ok(content.includes(first.material_id));
  assert.equal((await f.post('/api/knowledge/apply',{planId:plan.id,confirmed:true,expectedReviewHash:plan.review_hash})).status,200);
  assert.equal(await fs.readFile(file,'utf8'),content);
  assert.notEqual((await f.post('/api/knowledge/prepare',{material_id:first.material_id,selections:[{index:9,relative_path:'03-长期知识/a.md'}]})).status,200);
});
test('an apply request must bind the exact reviewed plan digest',async t=>{
  const f=await setup(t);const first=await (await f.post('/api/materials',{raw_content:'需要核对具体保存内容',source_type:'text'})).json();
  const plan=await (await f.post('/api/knowledge/prepare',{material_id:first.material_id,selections:[{index:0,relative_path:'02-方法论/工程思维/审核.md'}]})).json();
  assert.notEqual((await f.post('/api/knowledge/apply',{planId:plan.id,confirmed:true})).status,200);
  assert.notEqual((await f.post('/api/knowledge/apply',{planId:plan.id,confirmed:true,expectedReviewHash:'0'.repeat(64)})).status,200);
  assert.deepEqual(await fs.readdir(f.vaultRoot),[]);
  assert.equal(typeof plan.review_hash,'string');
  assert.equal((await f.post('/api/knowledge/apply',{planId:plan.id,confirmed:true,expectedReviewHash:plan.review_hash})).status,200);
});
test('one corrupt material is diagnosed without hiding healthy materials or existing action feedback',async t=>{
 const f=await setup(t);
 const one=await (await f.post('/api/materials',{raw_content:'第一份完整原文',source_type:'text'})).json();
 const two=await (await f.post('/api/materials',{raw_content:'另一份完整原文',source_type:'text'})).json();
 const file=path.join(f.root,'data','materials',one.material_id,'material.json');
 await fs.writeFile(file,'{broken',{mode:0o600});
 const response=await fetch(f.origin+'/api/state');assert.equal(response.status,200);
 const state=await response.json();assert.equal(state.materials.length,2);
 assert.equal(state.materials.find(item=>item.id===one.material_id).error.code,'STATE_CORRUPT');
 assert.equal(state.materials.find(item=>item.id===two.material_id).stage,'PREVIEW_READY');
 assert.equal(state.workspace.actions.length,2);assert.equal(await fs.readFile(file,'utf8'),'{broken');
 const action=state.workspace.actions.find(a=>a.material_id===two.material_id);
 assert.equal((await f.post('/api/actions/decide',{id:action.id,decision:'accept'})).status,200);
 assert.equal(f.calls(),2);
});
test('a linked material directory is diagnosed without following it or blocking healthy feedback',async t=>{
 const f=await setup(t);
 const one=await (await f.post('/api/materials',{raw_content:'健康材料',source_type:'text'})).json();
 const unsafe='mat_'+'f'.repeat(64),external=path.join(f.root,'outside');
 await fs.mkdir(external,{mode:0o700});await fs.writeFile(path.join(external,'sentinel'),'unchanged');
 await fs.symlink(external,path.join(f.root,'data','materials',unsafe));
 const response=await fetch(f.origin+'/api/state');assert.equal(response.status,200);
 const state=await response.json();assert.equal(state.materials.find(x=>x.id===unsafe).error.code,'UNSAFE_PATH');
 assert.equal(state.materials.find(x=>x.id===one.material_id).stage,'PREVIEW_READY');
 assert.equal(await fs.readFile(path.join(external,'sentinel'),'utf8'),'unchanged');
 assert.equal((await f.post('/api/actions/decide',{id:state.workspace.actions[0].id,decision:'accept'})).status,200);
});
test('snapshot text can link to an action and retain the manual link when refreshed through HTTP',async t=>{
 const f=await setup(t);await f.post('/api/materials',{raw_content:'快照关联依据',source_type:'text'});
 const action=(await (await fetch(f.origin+'/api/state')).json()).workspace.actions[0];
 const input={source:'本地演示清单',updated_at:'2026-09-12T08:00:00.000Z',text:'- [ ] 验证重复提交'};
 assert.equal((await f.post('/api/snapshots',input)).status,200);
 let state=await (await fetch(f.origin+'/api/state')).json();const item=state.workspace.snapshots[0].items[0];
 assert.equal((await f.post('/api/snapshots/link',{source:input.source,item_id:item.id,action_id:action.id})).status,200);
 assert.equal((await f.post('/api/snapshots',{...input,text:'- [x] 验证重复提交'})).status,200);
 state=await (await fetch(f.origin+'/api/state')).json();
 assert.equal(state.workspace.snapshots[0].items[0].action_id,action.id);
 assert.equal(state.workspace.actions[0].status,'SUGGESTED');assert.equal(state.workspace.actions[0].primary_source,input.source);assert.equal(f.calls(),1);
});
