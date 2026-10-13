import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {readCodexConversation} from './codex.mjs';
import {check,time} from './model.mjs';

// Enumerate metadata locally; only authorized project bodies enter the queue/model.
// Rescan rather than advancing a lossy cursor. Failed files are retried on the next scan.
export async function discoverCodex({sessionsDir,projectRoots,store,now,maxFiles=5000}){
 check(path.isAbsolute(sessionsDir)&&Array.isArray(projectRoots)&&projectRoots.length>0&&projectRoots.every(path.isAbsolute)&&time(now));
 check(Number.isSafeInteger(maxFiles)&&maxFiles>0&&maxFiles<=10000);
 const report={at:now,complete:true,limited:false,examined:0,queued:0,unchanged:0,blocked:0,excluded:0,errors:[]};
 const error=(file,e)=>{report.complete=false;report.errors.push({file,code:e.code??'SOURCE_INVALID'});};
 let entries=0;
 async function walk(dir,depth=0){
  if(report.limited)return;
  if(depth>10){error(dir,{code:'DEPTH_LIMIT'});return;}
  let items;try{items=await fs.readdir(dir,{withFileTypes:true});}catch(e){error(dir,e);return;}
  for(const item of items.sort((a,b)=>a.name.localeCompare(b.name))){
   const file=path.join(dir,item.name);
   if(++entries>maxFiles*10){report.limited=true;report.complete=false;return;}
   if(item.isSymbolicLink()){error(file,{code:'UNSAFE_PATH'});continue;}
   if(item.isDirectory()){await walk(file,depth+1);if(report.limited)return;continue;}
   if(!item.name.endsWith('.jsonl'))continue;
   if(report.examined>=maxFiles){report.limited=true;report.complete=false;return;}
   report.examined++;
   try{
    const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let meta;
    try{check((await h.stat()).isFile(),'UNSAFE_PATH');const buf=Buffer.alloc(65536);const {bytesRead}=await h.read(buf,0,buf.length,0);const end=buf.subarray(0,bytesRead).indexOf(10);check(end>=0,'SOURCE_INVALID');meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,end)));}finally{await h.close();}
    check(meta.type==='session_meta'&&typeof meta.payload?.cwd==='string','SOURCE_INVALID');
    if(!projectRoots.some(root=>path.resolve(root)===path.resolve(meta.payload.cwd))){report.excluded++;continue;}
    const snapshot=await readCodexConversation({file,projectRoots,capturedAt:now});
    const result=await store.enqueueProcessing({snapshot,recipe:'knowledge-units-v2'});
    if(snapshot.gaps.includes('automated_session_excluded')){report.excluded++;continue;}
    if(result.status==='QUEUED')report.queued++;else if(result.status==='NO_CHANGE')report.unchanged++;else report.blocked++;
   }catch(e){error(file,e);}
  }
 }
 try{
  let current=path.parse(sessionsDir).root;
  for(const part of sessionsDir.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current);check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_PATH');}
  await walk(sessionsDir);
 }catch(e){error(sessionsDir,e);}
 await store.recordDiscovery(report);
 return report;
}
