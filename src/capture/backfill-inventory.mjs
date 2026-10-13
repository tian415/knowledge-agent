import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sourceKey,check} from './model.mjs';
import {openCaptureStore} from './store.mjs';
import {loadRuntimeConfig} from './runtime.mjs';
import {safeRelative} from '../shared/knowledge-paths.mjs';
import {readingContent} from './topic-publish.mjs';
import {renderManagedTopic,managedTopicKey,replaceManagedTopic,adoptManagedTopic} from '../apply/managed-topic.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
export const inventoryStatusLabels={excluded:'自动会话已排除',unread:'未读取',unprocessed:'未处理',processing:'处理中',needs_context:'需补上下文',legacy_recipe:'旧配方需重新整理',awaiting_classification:'待分类',awaiting_topic:'待主题整理或复核',organized_unwritten:'已整理但未写入',saved:'已保存并核实当前文件',dismissed:'已人工忽略',no_value:'无新增沉淀价值'};
function allowed(config,source){return source?.system==='chatgpt'?config.chatgpt.thread_ids.includes(source.conversation_id):source?.system==='codex'&&config.codex!==null&&config.project_roots.some(root=>source.scope==='project:'+root);}
export function buildBackfillInventory({config,state,manifest=null,saveProofs={}}){
 const p=state.processing??{jobs:[],latest:{}},ts=p.topics??{revisions:[],latest:{}};
 const known=new Map();
 const add=(source,title)=>{check(allowed(config,source),'SOURCE_SCOPE_MISMATCH');const key=sourceKey(source);if(!known.has(key))known.set(key,{source:structuredClone(source),title});};
 for(const s of state.sources??[])add(s.source,s.latest?.title??s.source.conversation_id);
 for(const j of p.jobs)add(j.snapshot.source,j.snapshot.title);
 if(manifest!==null){check(manifest&&Array.isArray(manifest.sources)&&manifest.sources.length<=10000,'MANIFEST_INVALID');for(const s of manifest.sources){check(typeof s.title==='string'&&s.title.length>0&&typeof s.source?.scope==='string'&&typeof s.source?.conversation_id==='string','MANIFEST_INVALID');add(s.source,s.title);}}
 for(const id of config.chatgpt.thread_ids)add({system:'chatgpt',scope:'conversation:'+id,conversation_id:id},id);
 const sources=[];
 for(const [key,knownSource] of known){
  const job=p.jobs.find(j=>j.id===p.latest[key]);
  const latestTopics=ts.revisions.filter(t=>Object.values(ts.latest).includes(t.id)&&job&&t.source_ids.some(id=>p.jobs.find(j=>j.id===id)?.source_key===key));
  const topics=latestTopics.map(t=>{const feedback=(ts.feedback??[]).filter(f=>f.topic_id===t.id).at(-1);const current=t.source_ids.every(id=>{const j=p.jobs.find(j=>j.id===id);return j&&p.latest[j.source_key]===id&&j.status==='completed';});const status=({dismiss:'dismissed',edit:'review_required'})[feedback?.action]??(current?t.status:'needs_update');const target=config.preview?.targets.find(m=>m.project===t.project&&m.key===t.key);return {id:t.id,title:t.title,project:t.project,key:t.key,status,source_stale:!current,result_kind:current?t.result?.kind??null:null,relative_path:target?.relative_path??null,save_proof:saveProofs[t.id]??{verified:false,reason:'no_verified_receipt'}};});
  let status='unread';
  if(job){
   if(job.snapshot.gaps?.includes('automated_session_excluded'))status='excluded';
   else if(topics.length>0&&topics.every(t=>t.status==='dismissed'))status='dismissed';
   else if(topics.some(t=>t.status==='review_required'))status='awaiting_topic';
   else if(job.status==='blocked'||job.result?.decision==='needs_context')status='needs_context';
   else if(job.recipe!=='knowledge-units-v2')status='legacy_recipe';
   else if(job.status==='queued')status='unprocessed';
   else if(job.status==='running')status='processing';
   else if(job.result?.decision==='no_value')status='no_value';
   else {
    const units=job.result?.knowledge_units??[];
    const routed=new Set(latestTopics.flatMap(t=>(t.routing?.units??[]).filter(u=>u.job_id===job.id).map(u=>u.key)));
    if(!units.length||units.some(u=>!routed.has(u.key)))status='awaiting_classification';
    else if(topics.some(t=>!['completed','dismissed'].includes(t.status)))status='awaiting_topic';
    else if(topics.every(t=>t.status==='dismissed'))status='dismissed';
    else if(topics.every(t=>t.status==='dismissed'||t.result_kind==='no_value'))status='no_value';
    else if(topics.filter(t=>t.status!=='dismissed'&&t.result_kind!=='no_value').every(t=>t.save_proof.verified===true))status='saved';
    else status='organized_unwritten';
   }
  }
  const captured=(state.sources??[]).find(s=>s.key===key)?.latest;
  if(!job&&captured)status='unprocessed';
  sources.push({source_key:key,...knownSource,title:job?.snapshot.title??knownSource.title,status,status_label:inventoryStatusLabels[status],job_id:job?.id??null,recipe:job?.recipe??null,completeness:job?.snapshot.completeness??captured?.completeness??'unknown',gaps:job?.snapshot.gaps??captured?.gaps??[],captured_at:job?.snapshot.captured_at??captured?.captured_at??null,topics});
 }
 return {schema_version:1,history_coverage:manifest?'manifest_only':'unknown',coverage_note:manifest?'仅覆盖显式清单、当前授权来源及已采集账本；清单不证明全部历史。':'未提供历史候选清单，全部历史覆盖情况未知。',sources,counts:Object.fromEntries(Object.keys(inventoryStatusLabels).map(status=>[status,sources.filter(s=>s.status===status).length]))};
}
async function safeRead(file,{privateFile=false}={}){
 let current=path.parse(file).root;
 for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const st=await fs.lstat(current);check(!st.isSymbolicLink(),'UNSAFE_PATH');}
 const before=await fs.lstat(file);check(before.isFile()&&before.nlink===1&&(!privateFile||(before.mode&0o777)===0o600),'UNSAFE_PATH');
 const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const now=await h.stat();check(now.ino===before.ino&&now.dev===before.dev,'UNSAFE_PATH');return await h.readFile();}finally{await h.close();}
}
function receiptContentBound(change,topic,content){
 try{
  if(change.operation==='reviewed-merge')return change.content===change.after&&typeof change.before==='string'&&change.expected_before_hash===hash(Buffer.from(change.before,'utf8'))&&change.source_content_hash===hash(Buffer.from(content,'utf8'));
  if(['managed-topic','managed-topic-adopt'].includes(change.operation)){
   const key=managedTopicKey(topic.project,topic.key);
   if(change.managed_key!==key||change.content!==content||!change.after.includes(renderManagedTopic(key,content)))return false;
   const expected=(change.operation==='managed-topic-adopt'?adoptManagedTopic:replaceManagedTopic)(change.before,key,content);
   return change.after===expected;
  }
  // Only the historical creation case can be proved without managed ownership.
  return change.operation===undefined&&change.before===null&&change.content===content&&change.after===content;
 }catch{return false;}
}
export async function readBackfillInventory({configPath,manifestPath=null}){
 const config=await loadRuntimeConfig(configPath);
 let state={sources:[]};
 try{await fs.lstat(config.data_dir);const store=await openCaptureStore({dataDir:config.data_dir,protectedRoots:[...config.project_roots,...(config.codex?[config.codex.sessions_dir]:[]),...(config.preview?[config.preview.vault_root]:[])],authorizeState:s=>check((s.sources??[]).every(x=>allowed(config,x.source))&&(s.processing?.jobs??[]).every(j=>allowed(config,j.snapshot.source)),'SOURCE_SCOPE_MISMATCH')});state=await store.view();}catch(e){if(e.code!=='ENOENT')throw e;}
 const manifest=manifestPath?JSON.parse(await safeRead(path.resolve(manifestPath),{privateFile:true})):null;
 // Validate scope before inspecting any output receipt or Vault target.
 buildBackfillInventory({config,state,manifest});
 const saveProofs={},p=state.processing,ts=p?.topics;
 if(config.preview&&ts){
  const plansDir=path.join(config.preview.writer_data_dir,'knowledge-apply','plans');let names=[];
  try{names=await fs.readdir(plansDir);}catch(e){if(e.code!=='ENOENT')throw e;}
  const receipts=[];
  for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/u.test(n))){receipts.push(JSON.parse(await safeRead(path.join(plansDir,name),{privateFile:true})));}
  for(const t of ts.revisions.filter(t=>Object.values(ts.latest).includes(t.id))){
   const target=config.preview.targets.find(m=>m.project===t.project&&m.key===t.key);
   if(!target||t.status!=='completed'||!t.result||t.result.kind==='no_value')continue;
   const jobs=t.source_ids.map(id=>p.jobs.find(j=>j.id===id));if(jobs.some(j=>!j||p.latest[j.source_key]!==j.id||j.status!=='completed'))continue;
   const receipt=receipts.filter(r=>r.status==='APPLIED'&&r.material_id===t.id&&r.vault_root===config.preview.vault_root&&r.changes?.length===1).at(-1),c=receipt?.changes[0];
   if(!c)continue;
   let reason='receipt_binding_mismatch';
   const content=readingContent(t,jobs);
   if(c.status==='APPLIED'&&c.relative_path===target.relative_path&&c.knowledge_layer===target.knowledge_layer&&JSON.stringify(c.candidate_ids)===JSON.stringify([t.id])&&typeof c.after==='string'&&c.after_hash===hash(Buffer.from(c.after,'utf8'))&&receiptContentBound(c,t,content)){
    safeRelative(c.relative_path,c.knowledge_layer);const file=path.join(config.preview.vault_root,c.relative_path);check(inside(config.preview.vault_root,file),'UNSAFE_PATH');
    try{const bytes=await safeRead(file);if(hash(bytes)===c.after_hash){saveProofs[t.id]={verified:true,plan_id:receipt.id,after_hash:c.after_hash};continue;}reason='current_target_changed';}catch(e){if(e.code!=='ENOENT')throw e;reason='current_target_missing';}
   }
   saveProofs[t.id]={verified:false,plan_id:receipt.id,reason};
  }
 }
 return {config,inventory:buildBackfillInventory({config,state,manifest,saveProofs})};
}
export function renderBackfillInventory(inventory){
 const clean=value=>String(value??'').replace(/[|\r\n]/gu,' ');
 return '# 历史聊天处理清单\n\n'+inventory.coverage_note+'\n\n| 来源 | 状态 | 读取覆盖 | 已有主题 |\n|---|---|---|---|\n'+inventory.sources.map(s=>`| ${clean(s.title)} | ${s.status_label} | ${s.completeness}${s.gaps.length?'：'+clean(s.gaps.join('、')):''} | ${s.topics.map(t=>clean(t.relative_path??t.title)+'（'+clean(t.status)+'）').join('；')||'—'} |`).join('\n')+'\n\n只读检查，不改变处理队列、人工忽略记录或 Obsidian 文件。\n';
}
export async function writeBackfillInventory({config,inventory,out}){
 check(typeof out==='string'&&path.isAbsolute(out),'UNSAFE_PATH');const dir=path.resolve(out);
 const protectedRoots=[fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/u,""),config.data_dir,...config.project_roots,...(config.codex?[config.codex.sessions_dir]:[]),...(config.preview?[config.preview.vault_root,config.preview.writer_data_dir]:[])];
 check(!protectedRoots.some(root=>inside(root,dir)||inside(dir,root)),'UNSAFE_PATH');
 let parent=path.parse(dir).root;for(const part of path.dirname(dir).slice(parent.length).split(path.sep).filter(Boolean)){parent=path.join(parent,part);const st=await fs.lstat(parent);check(st.isDirectory()&&!st.isSymbolicLink(),'UNSAFE_PATH');}
 await fs.mkdir(dir,{mode:0o700});
 await fs.writeFile(path.join(dir,'inventory.json'),JSON.stringify(inventory,null,2)+'\n',{mode:0o600,flag:'wx'});
 await fs.writeFile(path.join(dir,'inventory.md'),renderBackfillInventory(inventory),{mode:0o600,flag:'wx'});
 return dir;
}
