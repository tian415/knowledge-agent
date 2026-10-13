import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadRuntimeConfig,openReviewWorkspace,runtimeSummary} from './runtime.mjs';

// Deliberately synthetic: deterministic example output, never an AI quality claim.
export async function createProductDemo(){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'knowledge-product-demo-'));
 const project=root+'/example-project',sessions=root+'/sessions',vault=root+'/notebook';
 for(const dir of [project,sessions,vault])await fs.mkdir(dir,{mode:0o700});
 const config={schema_version:1,data_dir:root+'/capture',project_roots:[project],codex:{sessions_dir:sessions,max_files:10},chatgpt:{thread_ids:['demo-chatgpt']},budget:{max_jobs:10,max_input_bytes:120000},preview:{writer_data_dir:root+'/writer',vault_root:vault,targets:[{project:'演示项目',key:'source-fidelity',knowledge_layer:'ENGINEERING_THINKING',relative_path:'02-方法论/工程思维/原文保真与增量整理.md'}]},write_mode:'confirmed',port:0};
 const configFile=root+'/runtime.json';await fs.writeFile(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const workspace=await openReviewWorkspace(await loadRuntimeConfig(configFile));
 const texts=['原始材料不要清洗，提炼后的知识单独保存。','同一份材料重复读取时，不应再调用模型或生成一份笔记。'];
 const writeLog=()=>fs.writeFile(sessions+'/example.jsonl',[{type:'session_meta',payload:{id:'demo-codex',cwd:project}},...texts.map((text,i)=>({type:'response_item',payload:{type:'message',id:'demo-message-'+i,role:'user',content:[{type:'input_text',text}]}}))].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 async function analyzeNext(){
  const task=await workspace.claimProcessing(new Date().toISOString());
  if(task.status!=='CLAIMED')throw Error('Demo source unexpectedly unavailable');
  const messages=task.job.snapshot.messages,first=messages[0],last=messages.at(-1);
  const actions=task.job.snapshot.source.system==='codex'?[{key:'verify-source-fidelity',action:'验证原文保真和重复读取',type:'SUGGESTION',status:'PROPOSED',owner:'user',project:'演示项目',reason:'根据合成材料提出的验证建议，尚未采纳。',evidence:[{message_id:first.id,quote:first.text},{message_id:last.id,quote:last.text}]}]:[];
  await workspace.store.finishProcessing({id:task.job.id,attempt:task.job.attempt,result:{decision:'draft',markdown:last.text,reason:'合成演示中明确的规则，用于验证工程链路。',coverage:{question:[{message_id:first.id,quote:first.text}],analysis:[{message_id:last.id,quote:last.text}],ending:[{message_id:last.id,quote:last.text}]},usage:null,knowledge_units:[{key:'source-fidelity',title:'原文保真与增量整理',knowledge_layer:'ENGINEERING_THINKING',project:'演示项目',summary:last.text,reason:'合成示例的跨项目工程边界',evidence:[{message_id:last.id,quote:last.text}]}],actions}});
  return {job_id:task.job.id,message_id:last.id,quote:last.text};
 }
 await writeLog();await workspace.refreshCodex();let codexRef=await analyzeNext();
 const chatText='网页只展示当前已读取的内容，不能把部分读取说成全部历史。';
 await workspace.readChatgpt([{requested_cursor:null,response:{thread:{kind:'chatgpt',id:'demo-chatgpt',title:'来源完整性（合成演示）'},page:{order:'newest_first',hasMore:false,nextCursor:null},turns:[{items:[{type:'userMessage',id:'chat-u1',content:[{type:'text',text:chatText}]}]}]}}]);
 const chatRef=await analyzeNext();
 async function synthesize(updated){
  await workspace.store.registerTopic({project:'演示项目',key:'source-fidelity',title:'原文保真与增量整理',recipe:'demo-v1',source_ids:[codexRef.job_id,chatRef.job_id]});
  const topic=await workspace.claimTopic(new Date().toISOString());
  if(topic.status!=='CLAIMED')throw Error('Demo topic unexpectedly unavailable');
  await workspace.store.finishTopic({id:topic.id,attempt:topic.attempt,result:{kind:'knowledge',markdown:'# 原文保真与增量整理\n\n原始对话用于追溯，主题笔记用于复用。两者应分开保存。\n\n- 用原始内容识别重复输入，避免反复分析和重复写入。\n- 展示实际读取范围，部分读取不能推断消息被删除。\n- 后续对话变化时更新已有主题，保留人工补充。'+(updated?'\n- BOM、CRLF 等原始字节也属于身份的一部分，不做隐式归一化。':''),contribution:updated?'新增字节级边界，将保真规则具体落实到 BOM 和 CRLF；旧结论仍保留。':'把内容身份与来源覆盖结合，说明什么时候应跳过、什么时候需要重新核对。',evidence:[codexRef,chatRef]}});
 }
 await synthesize(false);let advanced=false,advancing=false;
 const advance=async()=>{
  if(advanced)return {status:'NO_CHANGE'};
  if(advancing)throw Object.assign(Error('BUSY'),{code:'BUSY'});
  advancing=true;
  try{texts.push('保留 BOM 和 CRLF，避免归一化改变原始字节身份。');await writeLog();await workspace.refreshCodex();codexRef=await analyzeNext();await synthesize(true);advanced=true;return {status:'UPDATED'};}
  finally{advancing=false;}
 };
 return {...workspace,root,config,configFile,advance,runtime:{...runtimeSummary(config),demo:true,semantic_executor:'simulated_demo'}};
}
