import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openReviewWorkspace,loadRuntimeConfig} from './runtime.mjs';
import {check} from './model.mjs';
export async function createExecutionDemo(kind){
 check(['source','topic'].includes(kind));
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'knowledge-executor-demo-'));
 const project=root+'/project',sessions=root+'/sessions';
 for(const dir of [project,sessions])await fs.mkdir(dir,{mode:0o700});
 const config={schema_version:1,data_dir:root+'/capture',project_roots:[project],codex:{sessions_dir:sessions,max_files:1},chatgpt:{thread_ids:[]},budget:{max_jobs:3,max_input_bytes:120000},preview:null,port:0};
 const configFile=root+'/runtime.json';await fs.writeFile(configFile,JSON.stringify(config)+'\n',{mode:0o600});
 const workspace=await openReviewWorkspace(await loadRuntimeConfig(configFile)),now=new Date().toISOString();
 const snapshot={schema_version:1,source:{system:'codex',scope:'project:'+project,conversation_id:'offline-demo'},channel:'local_log',title:'合成离线执行示例',url:null,captured_at:now,completeness:'complete',gaps:[],messages:[{id:'u1',role:'user',text:'离线测试原文：建议需要人工采纳，不能自动登记为承诺。',source_time:null,text_format:'source_text'}]};
 await workspace.store.enqueueProcessing({snapshot,recipe:'offline-demo-v1'});
 if(kind==='topic'){
  const claim=await workspace.claimProcessing(now),ref={message_id:'u1',quote:snapshot.messages[0].text};
  await workspace.store.finishProcessing({id:claim.job.id,attempt:claim.job.attempt,result:{decision:'draft',markdown:'合成来源结论',reason:'主题演示的确定性前置材料。',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null}});
  await workspace.store.registerTopic({project:'offline-demo',key:'confirmation',title:'合成主题',recipe:'offline-demo-v1',source_ids:[claim.job.id]});
 }
 return {root,config,configFile,store:workspace.store};
}
