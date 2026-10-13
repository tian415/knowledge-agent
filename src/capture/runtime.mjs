import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCaptureStore} from './store.mjs';
import {discoverCodex} from './discovery.mjs';
import {threadPagesToSnapshot} from './chatgpt-thread.mjs';
import {createTopicPublisher} from './topic-publish.mjs';
import {createKnowledgeWriter} from '../apply/knowledge.mjs';
import {VAULT_PATH} from '../registry/load-registry.mjs';
import {safeRelative} from '../shared/knowledge-paths.mjs';
import {fail} from './model.mjs';
import {createReviewedImports} from './reviewed-import.mjs';
import {createPublishedSearch} from './published-search.mjs';

const REPO_ROOT=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const MAX_CONFIG_BYTES=64*1024;
const LAYERS=new Set(['PROJECT_KNOWLEDGE','ENGINEERING_THINKING','PRODUCT_THINKING','GENERAL_KNOWLEDGE']);
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
const overlaps=(a,b)=>inside(a,b)||inside(b,a);
const requireValue=(ok,code='CONFIG_INVALID')=>{if(!ok)throw fail(code);};
const exact=(value,keys)=>requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)));

async function inspectPath(target,{mustExist=false,directory=true}={}){
 requireValue(typeof target==='string'&&path.isAbsolute(target),'UNSAFE_PATH');
 const resolved=path.resolve(target),root=path.parse(resolved).root;let current=root,final=null;
 for(const part of resolved.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);let stat;
  try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT'){final=null;break;}throw error;}
  requireValue(!stat.isSymbolicLink(),'UNSAFE_PATH');final=stat;
 }
 requireValue(!mustExist||final,'CONFIG_UNAVAILABLE');
 if(!final){
  let parent;try{parent=await fs.lstat(path.dirname(resolved));}catch(error){if(error.code==='ENOENT')throw fail('CONFIG_UNAVAILABLE');throw error;}
  requireValue(parent.isDirectory()&&!parent.isSymbolicLink(),'UNSAFE_PATH');
 }
 if(final&&directory)requireValue(final.isDirectory(),'UNSAFE_PATH');
 return resolved;
}

function validateTarget(target){
 exact(target,['project','key','knowledge_layer','relative_path']);
 requireValue(typeof target.project==='string'&&target.project.length>0&&target.project.length<=256);
 requireValue(typeof target.key==='string'&&target.key.length>0&&target.key.length<=256&&LAYERS.has(target.knowledge_layer));
 try{safeRelative(target.relative_path,target.knowledge_layer);}catch{throw fail('CONFIG_INVALID');}
 return structuredClone(target);
}

function validateShape(raw){
 exact(raw,['schema_version','data_dir','project_roots','codex','chatgpt','budget','preview','port',...(Object.hasOwn(raw??{},'write_mode')?['write_mode']:[]),...(Object.hasOwn(raw??{},'search')?['search']:[]),...(Object.hasOwn(raw??{},'reviewed_imports')?['reviewed_imports']:[])]);requireValue(raw.schema_version===1);
 if(raw.reviewed_imports!==undefined)requireValue(Array.isArray(raw.reviewed_imports)&&raw.reviewed_imports.length<=1000&&new Set(raw.reviewed_imports).size===raw.reviewed_imports.length&&raw.reviewed_imports.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/u.test(h))&&raw.preview!==null);
 if(raw.search!==undefined&&raw.search!==null){exact(raw.search,['python_executable']);requireValue(raw.preview!==null&&typeof raw.search.python_executable==='string'&&path.isAbsolute(raw.search.python_executable));}
 requireValue(raw.write_mode===undefined||['preview-only','confirmed'].includes(raw.write_mode));
 requireValue(raw.write_mode!=='confirmed'||raw.preview!==null);
 requireValue(Array.isArray(raw.project_roots)&&raw.project_roots.length>0&&raw.project_roots.length<=100);
 requireValue(raw.project_roots.every(value=>typeof value==='string'&&path.isAbsolute(value)));
 exact(raw.chatgpt,['thread_ids']);requireValue(Array.isArray(raw.chatgpt.thread_ids)&&raw.chatgpt.thread_ids.length<=1000);
 requireValue(raw.chatgpt.thread_ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=256));
 requireValue(new Set(raw.chatgpt.thread_ids).size===raw.chatgpt.thread_ids.length);
 exact(raw.budget,['max_jobs','max_input_bytes']);
 requireValue(Number.isSafeInteger(raw.budget.max_jobs)&&raw.budget.max_jobs>0&&raw.budget.max_jobs<=100);
 requireValue(Number.isSafeInteger(raw.budget.max_input_bytes)&&raw.budget.max_input_bytes>0&&raw.budget.max_input_bytes<=8*1024*1024);
 requireValue(Number.isInteger(raw.port)&&raw.port>=0&&raw.port<=65535);
 if(raw.codex!==null){exact(raw.codex,['sessions_dir','max_files']);requireValue(typeof raw.codex.sessions_dir==='string'&&path.isAbsolute(raw.codex.sessions_dir));requireValue(Number.isSafeInteger(raw.codex.max_files)&&raw.codex.max_files>0&&raw.codex.max_files<=10000);}
 if(raw.preview!==null){
  exact(raw.preview,['writer_data_dir','vault_root','targets']);
  requireValue(typeof raw.preview.writer_data_dir==='string'&&path.isAbsolute(raw.preview.writer_data_dir)&&typeof raw.preview.vault_root==='string'&&path.isAbsolute(raw.preview.vault_root));
  requireValue(Array.isArray(raw.preview.targets)&&raw.preview.targets.length<=1000);raw.preview.targets.forEach(validateTarget);
  const ids=raw.preview.targets.map(target=>JSON.stringify([target.project,target.key]));requireValue(new Set(ids).size===ids.length);
 }
 requireValue(typeof raw.data_dir==='string'&&path.isAbsolute(raw.data_dir));
 return structuredClone(raw);
}

async function readPrivateConfig(file){
 requireValue(typeof file==='string'&&path.isAbsolute(file),'CONFIG_PATH_REQUIRED');
 const resolved=path.resolve(file),root=path.parse(resolved).root;let current=root;
 for(const part of resolved.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')throw fail('CONFIG_NOT_FOUND');throw error;}
  requireValue(!stat.isSymbolicLink(),'CONFIG_UNSAFE');
 }
 let before;try{before=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')throw fail('CONFIG_NOT_FOUND');throw error;}
 requireValue(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=MAX_CONFIG_BYTES,'CONFIG_UNSAFE');
 let handle;try{
  handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const live=await handle.stat();
  requireValue(live.ino===before.ino&&live.dev===before.dev&&live.nlink===1&&live.size<=MAX_CONFIG_BYTES,'CONFIG_UNSAFE');
  const bytes=await handle.readFile();let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('CONFIG_INVALID');}
  try{return JSON.parse(text);}catch{throw fail('CONFIG_INVALID');}
 }finally{await handle?.close();}
}

export async function loadRuntimeConfig(file){
 const config=validateShape(await readPrivateConfig(file));
 const declaredStores=[path.resolve(config.data_dir),...(config.preview?[path.resolve(config.preview.writer_data_dir)]:[])];
 const declaredSources=[REPO_ROOT,path.resolve(VAULT_PATH),...config.project_roots.map(root=>path.resolve(root))];
 if(config.codex)declaredSources.push(path.resolve(config.codex.sessions_dir));
 if(config.preview)declaredSources.push(path.resolve(config.preview.vault_root));
 requireValue(declaredStores.every(store=>declaredSources.every(source=>!overlaps(store,source))),'UNSAFE_PATH');
 requireValue(declaredStores.length<2||!overlaps(declaredStores[0],declaredStores[1]),'UNSAFE_PATH');
 config.data_dir=await inspectPath(config.data_dir);
 config.project_roots=await Promise.all(config.project_roots.map(root=>inspectPath(root,{mustExist:true})));
 requireValue(new Set(config.project_roots).size===config.project_roots.length);
 if(config.codex)config.codex.sessions_dir=await inspectPath(config.codex.sessions_dir,{mustExist:true});
 if(config.preview){config.preview.writer_data_dir=await inspectPath(config.preview.writer_data_dir);config.preview.vault_root=await inspectPath(config.preview.vault_root,{mustExist:true});}
 const sourceRoots=[REPO_ROOT,path.resolve(VAULT_PATH),...config.project_roots];
 if(config.codex)sourceRoots.push(config.codex.sessions_dir);
 if(config.preview)sourceRoots.push(config.preview.vault_root);
 const stores=[config.data_dir,...(config.preview?[config.preview.writer_data_dir]:[])];
 requireValue(stores.every(store=>sourceRoots.every(source=>!overlaps(store,source))),'UNSAFE_PATH');
 requireValue(stores.length<2||!overlaps(stores[0],stores[1]),'UNSAFE_PATH');
 if(config.search){try{requireValue((await fs.stat(config.search.python_executable)).isFile(),'SEARCH_UNAVAILABLE');await fs.access(config.search.python_executable,constants.X_OK);}catch{throw fail('SEARCH_UNAVAILABLE');}}
 return config;
}

export async function readReviewInput(file){
 await inspectPath(file,{mustExist:true,directory:false});
 const st=await fs.lstat(file);
 requireValue(st.isFile()&&st.nlink===1&&(st.mode&0o777)===0o600,'INPUT_UNSAFE');
 requireValue(st.size<=16*1024*1024,'INPUT_TOO_LARGE');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const live=await handle.stat();requireValue(live.ino===st.ino&&live.dev===st.dev&&live.nlink===1&&(live.mode&0o777)===0o600,'INPUT_UNSAFE');
  requireValue(live.size<=16*1024*1024,'INPUT_TOO_LARGE');
  const bytes=await handle.readFile();requireValue(bytes.length<=16*1024*1024,'INPUT_TOO_LARGE');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('INPUT_INVALID');}
 }finally{await handle.close();}
}

export function runtimeSummary(config){
 return {cadence_days:10,scheduler_enabled:false,semantic_executor:'codex-assisted',jev:'not_connected',vault_write_enabled:config.write_mode==='confirmed',
  codex:{coverage:config.codex?'configured_project_roots':'unconfigured',enabled:config.codex!==null,max_files:config.codex?.max_files??null},
  chatgpt:{coverage:'limited_tool_read_scope_only',configured_thread_ids:config.chatgpt.thread_ids.length,automatic_reading:false},
  budget:{...config.budget,enforced_for_claims:true},preview_enabled:config.preview!==null,published_search_enabled:!!config.search};
}

// Routine agent checks need counts and recovery IDs, not prior drafts and quotes.
// Project only an already-authorized status; never read the Store around its scope guard.
export function processingSummary(status){
 const countBy=(items,key)=>Object.fromEntries([...new Set(items.map(key).filter(value=>value!==null))].map(value=>[value,items.filter(item=>key(item)===value).length]));
 const {queued,running,completed,blocked,budget,window,period_days,unresolved_attempts}=status;
 const discovery=status.discovery===null?null:{
  ...Object.fromEntries(['at','complete','limited','examined','queued','unchanged','blocked','excluded'].map(key=>[key,status.discovery[key]])),
  errors:status.discovery.errors.length
 };
 return {queued,running,completed,blocked,budget,window,period_days,unresolved_attempts,usage:status.usage,executions:status.executions,
  pending_attempts:status.pending_attempts.map(({kind,id,attempt,stale})=>({kind,id,attempt,stale})),
  queue:{total:status.queue.length,ready:status.queue.filter(item=>item.reason===null).length,by_reason:countBy(status.queue,item=>item.reason)},
  decisions:countBy(status.jobs,item=>item.decision),
  topics:{total:status.topics.length,by_status:countBy(status.topics,item=>item.status),by_kind:countBy(status.topics,item=>item.result?.kind??null)},
  actions:status.actions.length,discovery};
}

export async function openReviewWorkspace(config){
 const protectedRoots=[...config.project_roots,...(config.codex?[config.codex.sessions_dir]:[]),...(config.preview?[config.preview.vault_root]:[])];
 const chatgptThreads=new Set(config.chatgpt.thread_ids);
 const allowedSource=source=>source?.system==='chatgpt'?chatgptThreads.has(source.conversation_id):source?.system==='codex'&&config.codex!==null&&config.project_roots.some(root=>source.scope==='project:'+root);
 const authorizedImports=new Set(config.reviewed_imports??[]);
 const authorizeState=state=>requireValue((state.reviewed_imports??[]).every(r=>authorizedImports.has(r.manifest_hash))&&state.sources.every(s=>allowedSource(s.source))&&(state.processing?.jobs??[]).every(j=>allowedSource(j.snapshot.source)),'SOURCE_SCOPE_MISMATCH');
 const rawStore=await openCaptureStore({dataDir:config.data_dir,protectedRoots,authorizeState});
 const budget={maxJobs:config.budget.max_jobs,maxInputBytes:config.budget.max_input_bytes};
 const store={...rawStore,processingStatus:()=>rawStore.processingStatus({now:new Date().toISOString(),...budget}),async ingest(snapshot){requireValue(snapshot?.source?.system==='chatgpt'&&chatgptThreads.has(snapshot.source.conversation_id),'SOURCE_SCOPE_MISMATCH');return rawStore.ingest(snapshot);}};
 let publisher=null,reviewedImports=null;
 if(config.preview){
  const writer=await createKnowledgeWriter({dataDir:config.preview.writer_data_dir,vaultRoot:config.preview.vault_root});
  reviewedImports=createReviewedImports({store:rawStore,writer,vaultRoot:config.preview.vault_root,authorizedHashes:config.reviewed_imports??[]});
  publisher=await createTopicPublisher({store:rawStore,writer,vaultRoot:config.preview.vault_root,targets:config.preview.targets,mode:config.write_mode??'preview-only'});
 }
 const refreshCodex=async()=>{requireValue(config.codex!==null,'SOURCE_UNCONFIGURED');return discoverCodex({sessionsDir:config.codex.sessions_dir,projectRoots:config.project_roots,store:rawStore,now:new Date().toISOString(),maxFiles:config.codex.max_files});};
 const readChatgpt=async pages=>{
  const snapshot=threadPagesToSnapshot({pages,capturedAt:new Date().toISOString()});
  requireValue(allowedSource(snapshot.source),'SOURCE_SCOPE_MISMATCH');
  return rawStore.enqueueProcessing({snapshot,recipe:'knowledge-units-v2'});
 };
 const publishedSearch=config.search&&publisher?createPublishedSearch({store,publisher,reviewedImports,vaultRoot:config.preview.vault_root,pythonExecutable:config.search.python_executable}):null;
 return {store,publisher,reviewedImports,publishedSearch,refreshCodex,readChatgpt,claimProcessing:now=>store.claimProcessing({now,...budget}),claimTopic:now=>store.claimTopic({now,...budget})};
}
