import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {check,fail} from './model.mjs';
import {managedTopicBlock} from '../apply/managed-topic.mjs';

const execute=promisify(execFile),digest=value=>createHash('sha256').update(value).digest('hex');
const MAX_BYTES=4*1024*1024;
// No account environment, model downloads, network transport or inherited Python hooks.
const PYTHON_ENTRY=`import socket,sys
original_connect=socket.socket.connect
def local_only(self,address):
 if self.family in (socket.AF_INET,socket.AF_INET6): raise RuntimeError('SEARCH_NETWORK_DISABLED')
 return original_connect(self,address)
socket.socket.connect=local_only
from basic_memory.cli.main import app
sys.argv=['basic-memory']+sys.argv[1:]
app()
`;

export async function searchWithBasicMemory({notes,query,pythonExecutable}){
 check(typeof pythonExecutable==='string'&&path.isAbsolute(pythonExecutable),'SEARCH_UNAVAILABLE');
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'knowledge-search-'));
 try{
  await fs.chmod(root,0o700);const notebook=path.join(root,'notes'),config=path.join(root,'config');
  await fs.mkdir(notebook,{mode:0o700});await fs.mkdir(config,{mode:0o700});
  // Basic Memory may normalize files. Only disposable derived copies are ever indexed.
  for(const note of notes)await fs.writeFile(path.join(notebook,note.id+'.md'),`---\ntitle: ${JSON.stringify(note.title)}\npermalink: ${note.id}\ntype: note\n---\n\n${note.markdown}`,{mode:0o600});
  await fs.writeFile(path.join(config,'config.json'),JSON.stringify({projects:{knowledge:{path:notebook,mode:'local'}},default_project:'knowledge',semantic_search_enabled:false,logfire_enabled:false,logfire_send_to_logfire:false}),{mode:0o600});
  const env={PATH:path.dirname(pythonExecutable)+':/usr/bin:/bin',TMPDIR:root,BASIC_MEMORY_CONFIG_DIR:config,BASIC_MEMORY_HOME:notebook,BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED:'false',BASIC_MEMORY_LOGFIRE_ENABLED:'false',BASIC_MEMORY_LOGFIRE_SEND_TO_LOGFIRE:'false',BASIC_MEMORY_CLOUD_MODE:'false',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',NO_COLOR:'1'};
  const run=args=>execute(pythonExecutable,['-I','-c',PYTHON_ENTRY,...args],{env,cwd:root,timeout:20000,maxBuffer:MAX_BYTES,killSignal:'SIGKILL'});
  await run(['reindex','--search','--project','knowledge']);
  const {stdout}=await run(['tool','search-notes','--project','knowledge','--json','--page-size','30','--compact','--',query]);
  let result;try{result=JSON.parse(stdout);}catch{throw fail('SEARCH_UNAVAILABLE');}
  check(Array.isArray(result.results),'SEARCH_UNAVAILABLE');return result;
 }catch(error){if(['SEARCH_UNAVAILABLE'].includes(error.code))throw error;throw fail('SEARCH_UNAVAILABLE');}
 finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function readNote(vault,relative){
 check(typeof relative==='string'&&!path.isAbsolute(relative),'UNSAFE_PATH');
 const target=path.resolve(vault,relative);check(target.startsWith(vault+path.sep),'UNSAFE_PATH');
 let current=vault;
 for(const part of relative.split('/')){
  check(part!=='.'&&part!=='..'&&part.length>0,'UNSAFE_PATH');current=path.join(current,part);
  let stat;try{stat=await fs.lstat(current);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(!stat.isSymbolicLink(),'UNSAFE_PATH');
 }
 const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat();check(before.isFile()&&before.nlink===1,'UNSAFE_PATH');check(before.size<=MAX_BYTES,'SEARCH_TOO_LARGE');
  const raw=await handle.readFile(),after=await handle.stat();check(raw.length<=MAX_BYTES,'SEARCH_TOO_LARGE');
  check(before.size===after.size&&before.mtimeMs===after.mtimeMs,'STALE_INPUT');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw fail('SOURCE_INVALID');}
 }finally{await handle.close();}
}

export function createPublishedSearch({store,publisher,vaultRoot,pythonExecutable,runSearch=searchWithBasicMemory,reviewedImports=null}){
 let running=false;
 async function snapshot(){
  await store.processingStatus(); // Includes the live source authorization guard.
  const vault=await fs.realpath(vaultRoot);check(vault===path.resolve(vaultRoot),'UNSAFE_PATH');
  const imported=reviewedImports?await reviewedImports.list():{notes:[],excluded:0,reserved_paths:[]};
  const reserved=new Set(imported.reserved_paths??[]);
  const {plans}=await publisher.list(),notes=[];let excluded=0,total=0;
  const paths=[...new Set(plans.filter(p=>p.status==='APPLIED'&&!reserved.has(p.changes[0].relative_path)).map(p=>p.changes[0].relative_path))].sort();
  check(paths.length<=1000,'SEARCH_TOO_LARGE');
  for(const relative of paths){
   const markdown=await readNote(vault,relative);if(markdown===null)continue;
   const matching=plans.filter(p=>p.status==='APPLIED'&&p.changes[0].relative_path===relative).find(p=>{
    const c=p.changes[0];
    try{return ['managed-topic','managed-topic-adopt'].includes(c.operation)?managedTopicBlock(markdown,c.managed_key).text===managedTopicBlock(c.after,c.managed_key).text:markdown===c.after;}catch{return false;}
   });
   if(!matching){excluded++;continue;}
   total+=Buffer.byteLength(markdown);check(total<=MAX_BYTES,'SEARCH_TOO_LARGE');
   notes.push({id:'note-'+digest(relative),title:path.basename(relative,'.md'),relative_path:relative,markdown,topic_id:matching.topic_id,status:matching.stale?'needs_review':'current',manual_changes:markdown!==matching.changes[0].after,hash:digest(markdown)});
  }
  const byPath=new Map(notes.filter(n=>!(imported.reserved_paths??[]).includes(n.relative_path)).map(n=>[n.relative_path,n]));for(const n of imported.notes)byPath.set(n.relative_path,n);
  const combined=[...byPath.values()];check(combined.length<=1000&&combined.reduce((sum,n)=>sum+Buffer.byteLength(n.markdown),0)<=MAX_BYTES,'SEARCH_TOO_LARGE');
  return {notes:combined,excluded:excluded+imported.excluded};
 }
 return {async search(input){
  check(input&&Object.keys(input).length===1&&typeof input.query==='string'&&input.query.trim().length>0&&input.query.length<=200);
  check(!running,'BUSY');running=true;
  try{
   const before=await snapshot();if(!before.notes.length)return {results:[],indexed:0,excluded:before.excluded};
   const found=await runSearch({notes:before.notes,query:input.query.trim(),pythonExecutable});
   check(JSON.stringify(await snapshot())===JSON.stringify(before),'STALE_INPUT');
   check(found&&Array.isArray(found.results),'SEARCH_UNAVAILABLE');
   const byPath=new Map(before.notes.map(n=>[n.id+'.md',n])),seen=new Set(),results=[];
   // Only ranking comes from the engine; content and status come from verified local files.
   for(const row of found.results){const note=byPath.get(row?.file_path);if(!note||seen.has(note.id))continue;seen.add(note.id);const {hash,...result}=note;results.push(result);if(results.length===10)break;}
   return {results,indexed:before.notes.length,excluded:before.excluded};
  }finally{running=false;}
 }};
}
