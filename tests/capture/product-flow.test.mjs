import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {loadRuntimeConfig,openReviewWorkspace,runtimeSummary} from '../../src/capture/runtime.mjs';
import {createCaptureApp} from '../../src/capture/server.mjs';
import {temp,now} from './helpers.mjs';

async function setup(t,kind='knowledge'){
 const root=await temp(t),project=root+'/project',sessions=root+'/sessions',vault=root+'/vault';
 for(const dir of [project,sessions,vault])await fs.mkdir(dir,{mode:0o700});
 const relative='01-项目沉淀/产品演示/原文保真.md';
 const config={schema_version:1,data_dir:root+'/capture',project_roots:[project],codex:{sessions_dir:sessions,max_files:5},chatgpt:{thread_ids:[]},budget:{max_jobs:10,max_input_bytes:120000},preview:{writer_data_dir:root+'/writer',vault_root:vault,targets:[{project:'demo',key:'fidelity',knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:relative}]},write_mode:'confirmed',port:0};
 const file=root+'/config.json';await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
 const ws=await openReviewWorkspace(await loadRuntimeConfig(file));
 const start=async()=>{const app=await createCaptureApp({...ws,runtime:runtimeSummary(config)});const url=await app.listen(0);t.after(()=>app.close());return {app,url,post:async(route,input,headers={})=>fetch(url+route,{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':app.token,...headers},body:JSON.stringify(input)})};};
 const sourceFile=sessions+'/one.jsonl';
 const analyze=async texts=>{
  const log=[{type:'session_meta',payload:{id:'t1',cwd:project}},...texts.map((text,i)=>({type:'response_item',payload:{type:'message',id:'m'+i,role:'user',content:[{type:'input_text',text}]}}))];
  await fs.writeFile(sourceFile,log.map(JSON.stringify).join('\n')+'\n');await ws.refreshCodex();
  const task=await ws.claimProcessing(now),ref={message_id:'m'+(texts.length-1),quote:texts.at(-1)};
  await ws.store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:{decision:'draft',markdown:texts.at(-1),reason:'用户明确的工程规则',coverage:{question:[{message_id:'m0',quote:texts[0]}],analysis:[ref],ending:[ref]},usage:null,knowledge_units:[]}});
  await ws.store.registerTopic({project:'demo',key:'fidelity',title:'原文保真',recipe:'v1',source_ids:[task.job.id]});
  const topic=await ws.claimTopic(now);
  await ws.store.finishTopic({id:topic.id,attempt:topic.attempt,result:{kind,...(kind==='project'?{project_type:'agreement'}:{}),markdown:'# 原文保真\n\n'+texts.at(-1),contribution:'保留工程规则及其适用依据',evidence:[{job_id:task.job.id,...ref}]}});
  return topic;
 };
 return {root,config,ws,start,analyze,target:vault+'/'+relative};
}

test('browser API saves, updates and restores a topic with source/version and manual-edit protection',async t=>{
 const f=await setup(t),first=await f.analyze(['原始字节不能被清洗。']),{post,url}=await f.start();
 const preview=await(await post('/api/topic-preview',{topic_id:first.id})).json();
 const save={topic_id:first.id,plan_id:preview.id,expected_review_hash:preview.review_hash,confirmed:true};
 assert.equal((await post('/api/topic-apply',save,{'x-app-token':'wrong'})).status,403);
 assert.equal((await post('/api/topic-apply',{...save,confirmed:false})).status,400);
 const applied=await post('/api/topic-apply',save);assert.equal(applied.status,200);assert.equal((await applied.json()).status,'APPLIED');
 const original=await fs.readFile(f.target,'utf8');
 await post('/api/topic-apply',save);assert.equal(await fs.readFile(f.target,'utf8'),original);
 const manual='\ufeff我的说明\r\n'+original+'\r\n我的实践记录';await fs.writeFile(f.target,manual);
 const second=await f.analyze(['原始字节不能被清洗。','保留 BOM 和 CRLF，身份由原始字节决定。']);
 assert.equal((await post('/api/topic-apply',save)).status,400);
 const updated=await(await post('/api/topic-preview',{topic_id:second.id})).json();assert.equal(updated.changes[0].before,manual);
 const input={topic_id:second.id,plan_id:updated.id,expected_review_hash:updated.review_hash,confirmed:true};
 assert.equal((await post('/api/topic-apply',input)).status,200);
 const live=await fs.readFile(f.target,'utf8');assert.ok(live.startsWith('\ufeff我的说明\r\n'));assert.ok(live.endsWith('\r\n我的实践记录'));assert.ok(live.includes('保留 BOM 和 CRLF'));
 const stateBefore=await fs.readFile(f.config.data_dir+'/state.json');
 for(const route of ['/api/runtime','/api/processing'])assert.equal((await fetch(url+route)).status,200);
 assert.deepEqual(await fs.readFile(f.config.data_dir+'/state.json'),stateBefore);
 // Reopen the persistent Store and Writer before recovery, as after a restart.
 const restarted=await openReviewWorkspace(f.config),app=await createCaptureApp({...restarted,runtime:runtimeSummary(f.config)}),restartUrl=await app.listen(0);t.after(()=>app.close());
 const rollback=()=>fetch(restartUrl+'/api/topic-rollback',{method:'POST',headers:{origin:restartUrl,'content-type':'application/json','x-app-token':app.token},body:JSON.stringify({plan_id:updated.id,expected_review_hash:updated.review_hash,confirmed:true})});
 await fs.writeFile(f.target,live+'人工新内容');assert.equal((await rollback()).status,409);assert.equal(await fs.readFile(f.target,'utf8'),live+'人工新内容');
 await fs.writeFile(f.target,live);assert.equal((await rollback()).status,200);assert.equal(await fs.readFile(f.target,'utf8'),manual);
 const history=await(await fetch(restartUrl+'/api/topic-previews')).json();assert.ok(history.plans.some(p=>p.id===updated.id&&p.status==='ROLLED_BACK'));
});

test('project agreement routes to its configured project file across source updates and restart',async t=>{
 const f=await setup(t,'project'),first=await f.analyze(['本项目约定集中审核。']);
 const save=async(ws,topic)=>{
  const plan=await ws.publisher.prepare({topic_id:topic.id});
  const request={topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};
  assert.equal((await ws.publisher.apply(request)).status,'APPLIED');
  return request;
 };
 await save(f.ws,first);
 const original=await fs.readFile(f.target,'utf8');await fs.writeFile(f.target,'人工说明\r\n'+original+'\r\n人工尾注');
 const second=await f.analyze(['本项目约定集中审核。','本项目约定集中审核，手动提交仅为补充。']);
 const restarted=await openReviewWorkspace(f.config),request=await save(restarted,second);
 const updated=await fs.readFile(f.target,'utf8');assert.ok(updated.startsWith('人工说明\r\n'));assert.ok(updated.endsWith('\r\n人工尾注'));
 assert.ok(updated.includes('手动提交仅为补充'));assert.equal(updated.split('<!-- knowledge-agent:topic:').length,original.split('<!-- knowledge-agent:topic:').length);
 await restarted.publisher.apply(request);assert.equal(await fs.readFile(f.target,'utf8'),updated);
 const before=await restarted.store.processingStatus();assert.equal((await restarted.refreshCodex()).unchanged,1);
 assert.equal((await restarted.claimProcessing(now)).status,'NO_WORK');assert.equal((await restarted.store.processingStatus()).window.jobs,before.window.jobs);
 assert.deepEqual(await fs.readdir(f.config.preview.vault_root+'/01-项目沉淀/产品演示'),['原文保真.md']);
 const status=await restarted.store.processingStatus();assert.equal(status.topics.length,1);assert.equal(status.topics[0].result.kind,'project');
});
