import {validateReviewedRecords,registerReviewedRecord} from './reviewed-import.mjs';
import {previewKnowledgeRoutes} from './knowledge-routing.mjs';
import {prepareExecution,getExecution,startExecution,recordExecutionEvent,stopExecution,validateExecutionSettings} from './execution-state.mjs';
import {recordCodexUsage} from './usage.mjs';
import {registerTopic,claimTopic,finishTopic,deferTopic,currentTopic,correctTopic,recordTopicFeedback,topicSources} from './topics.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {VAULT_PATH} from '../registry/load-registry.mjs';
import {check,fail,fields,time,validateSnapshot,sourceKey,messageHash,digest} from './model.mjs';
import {validateStoredCandidate} from './review.mjs';
import {captureActionView,decideCaptureAction,captureActionSource} from './actions.mjs';
import {emptyProcessing,validateDiscovery,validateProcessing,enqueueProcessing,claimProcessing,finishProcessing,deferProcessing,processingStatus} from './processing.mjs';
const inside=(a,b)=>b===a||b.startsWith(a+path.sep);
const repo=fileURLToPath(new URL('../../',import.meta.url));
const observationHash=(order,completeness,gaps)=>digest([order,completeness,[...new Set(gaps)].sort()]);
export async function openCaptureStore({dataDir,protectedRoots=[],authorizeState}){
 check(typeof dataDir==='string'&&path.isAbsolute(dataDir),'UNSAFE_PATH');const root=path.resolve(dataDir);
 const forbidden=[repo,VAULT_PATH,...protectedRoots].map(p=>path.resolve(p));
 try {const marker=await fs.readFile(path.join(repo,'.git'),'utf8');const gitdir=/^gitdir: (.+)\n?$/u.exec(marker)?.[1];if(gitdir){const common=(await fs.readFile(path.join(gitdir,'commondir'),'utf8')).trim();forbidden.push(path.dirname(path.resolve(gitdir,common)));}}catch(e){if(!['ENOENT','EISDIR'].includes(e.code))throw e;}
 check(!forbidden.some(p=>inside(p,root)||inside(root,p)),'UNSAFE_PATH');
 async function inspect(target){let current=path.parse(target).root;for(const part of target.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);let s;try{s=await fs.lstat(current);}catch(e){if(e.code==='ENOENT')return null;throw e;}check(!s.isSymbolicLink()&&(current===target||s.isDirectory()),'UNSAFE_PATH');if(inside(root,current))check((s.isDirectory()||s.isFile()&&s.nlink===1)&&(s.mode&0o777)===(s.isDirectory()?0o700:0o600),'UNSAFE_PATH');if(current===target)return s;}}
 if(!await inspect(root)){check((await fs.stat(path.dirname(root))).isDirectory(),'UNSAFE_PATH');await fs.mkdir(root,{mode:0o700});}check((await inspect(root)).isDirectory(),'UNSAFE_PATH');
 const file=path.join(root,'state.json'),lock=path.join(root,'capture.lock');
 async function read(){await inspect(root);const st=await inspect(file);if(!st)return {schema_version:1,sources:[],candidates:[]};check(st.isFile(),'UNSAFE_PATH');const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let s;try{const live=await h.stat();check(live.ino===st.ino&&live.dev===st.dev&&live.nlink===1,'UNSAFE_PATH');s=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await h.readFile()));}catch(e){if(e.code==='UNSAFE_PATH')throw e;throw fail('STATE_CORRUPT');}finally{await h.close();}
 try {
  fields(s,['schema_version','sources','candidates',...(Object.hasOwn(s,'processing')?['processing']:[]),...(Object.hasOwn(s,'reviewed_imports')?['reviewed_imports']:[])]);
  if(Object.hasOwn(s,'reviewed_imports'))validateReviewedRecords(s.reviewed_imports);
  if(Object.hasOwn(s,'processing'))validateProcessing(s.processing);
  check(s.schema_version===1&&Array.isArray(s.sources)&&Array.isArray(s.candidates));
  const keys=new Set();
  for(const src of s.sources){
   fields(src,['key','source','messages','observations','channels','latest','review_status']);
   check(src.key===sourceKey(src.source)&&!keys.has(src.key)&&Array.isArray(src.messages)&&Array.isArray(src.observations)&&src.observations.length>0);
   keys.add(src.key);
   check(Array.isArray(src.channels)&&src.channels.length>0&&new Set(src.channels).size===src.channels.length&&src.channels.every(c=>['local_log','web','desktop'].includes(c)));
   check(['not_generated','pending','generated'].includes(src.review_status));
   validateSnapshot(src.latest);check(src.latest.messages.length===0&&sourceKey(src.latest.source)===src.key&&src.channels.includes(src.latest.channel));
   const ids=new Set();
   for(const m of src.messages){
    fields(m,['id','current_hash','versions']);check(!ids.has(m.id)&&Array.isArray(m.versions)&&m.versions.length>0);ids.add(m.id);
    check(m.versions.some(v=>v.hash===m.current_hash));const hashes=new Set();
    for(const v of m.versions){
     fields(v,['hash','message','captured_at']);check(time(v.captured_at)&&!hashes.has(v.hash)&&v.hash===messageHash(v.message)&&v.message.id===m.id);hashes.add(v.hash);
     validateSnapshot({...src.latest,messages:[v.message]});
    }
   }
   for(const o of src.observations){
    fields(o,['hash','order','captured_at','completeness','gaps']);
    check(time(o.captured_at)&&Array.isArray(o.order)&&(o.hash===digest(o.order)||o.hash===observationHash(o.order,o.completeness,o.gaps)));const seen=new Set();
    for(const pair of o.order){check(Array.isArray(pair)&&pair.length===2);const [id,hash]=pair;check(!seen.has(id)&&src.messages.find(m=>m.id===id)?.versions.some(v=>v.hash===hash));seen.add(id);}
    validateSnapshot({...src.latest,captured_at:o.captured_at,completeness:o.completeness,gaps:o.gaps});
   }
  }
  const candidateIds=new Set();
  for(const c of s.candidates){check(!candidateIds.has(c.id));candidateIds.add(c.id);validateStoredCandidate(c,s);}
 }catch{throw fail('STATE_CORRUPT');}await authorizeState?.(s);return s;
 }
 async function mutate(fn){await inspect(root);let h;try{h=await fs.open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if(e.code==='EEXIST')throw fail('BUSY');throw e;}const stamp=randomUUID();let tmp;try{await h.writeFile(stamp);await h.sync();const state=await read();const result=await fn(state);await authorizeState?.(state);tmp=path.join(root,'.'+randomUUID()+'.tmp');const out=await fs.open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await out.writeFile(JSON.stringify(state)+'\n');await out.sync();}finally{await out.close();}await inspect(root);await inspect(file);check(await fs.readFile(lock,'utf8')===stamp,'BUSY');await fs.rename(tmp,file);tmp=null;const d=await fs.open(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{await d.sync();}finally{await d.close();}return result;}finally{await h.close();if(tmp)await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});if(await fs.readFile(lock,'utf8')===stamp)await fs.unlink(lock);}}
 await read();
 return {view:read,
 async registerReviewedImport(input,verify){return mutate(async s=>{await verify?.();return registerReviewedRecord(s,input);});},
 async withReviewedSaveGuard(relative,fn){return mutate(s=>{check(!(s.reviewed_imports??[]).some(r=>r.manifest.notes.some(n=>n.relative_path===relative)),'REVIEWED_SAVE_CONFLICT');return fn();});},
 async reviewedImports(){return structuredClone((await read()).reviewed_imports??[]);},
 async claimExecution({kind,settings,...options}){validateExecutionSettings(settings);check(['source','topic'].includes(kind),'EXECUTION_INVALID');return mutate(s=>{
  const p=s.processing??=emptyProcessing();
  if([...p.jobs,...(p.topics?.revisions??[])].some(j=>j.execution&&j.status==='running'))return {status:'ATTENTION_REQUIRED'};
  const claim=kind==='source'?claimProcessing(p,options):claimTopic(p,options);
  return claim.status==='CLAIMED'?prepareExecution(p,kind,claim,settings):claim;
 });},
 async startExecution(binding){return mutate(s=>startExecution(s.processing,binding));},
 async recordExecutionEvent(input){return mutate(s=>recordExecutionEvent(s.processing,input));},
 async stopExecution(input){return mutate(s=>stopExecution(s.processing,input));},
 async executionView(binding){return structuredClone(getExecution((await read()).processing,binding).execution);},
 async completeExecution(binding){return mutate(s=>{
  const entry=getExecution(s.processing,binding),e=entry.execution;
  if(e.phase==='finalized')return {status:'NO_CHANGE'};
  check(e.terminal==='completed'&&e.output!==null,'EXECUTION_UNCERTAIN');
  let result;try{result=JSON.parse(e.output);}catch{throw fail('EXECUTION_INVALID');}
  const out=(binding.kind==='source'?finishProcessing:finishTopic)(s.processing,{id:binding.id,attempt:binding.attempt,result});
  e.phase='finalized';e.error=null;return out;
 });},
 async useCurrentTopic(id,fn){return mutate(s=>{const t=currentTopic(s.processing,id);return fn(structuredClone(t),structuredClone(t.source_ids.map(id=>s.processing.jobs.find(j=>j.id===id))));});},
 async correctTopic(input){return mutate(s=>correctTopic(s.processing,input));},
 async recordTopicFeedback(input){return mutate(s=>recordTopicFeedback(s.processing,input));},
 async topicSources(id){return topicSources((await read()).processing,id);},
 async actionView(options){return captureActionView((await read()).processing,options);},
 async decideAction(input){return mutate(s=>decideCaptureAction(s.processing,input));},
 async actionSource(input){return captureActionSource((await read()).processing,input);},
 async previewRoutes(input){return previewKnowledgeRoutes((await read()).processing??emptyProcessing(),input);},
 async registerRoutes({expected_hash,...input}){return mutate(s=>{
  const p=s.processing??=emptyProcessing(),plan=previewKnowledgeRoutes(p,input);
  check(plan.review_hash===expected_hash,'ROUTE_CONFLICT');check(plan.unresolved.length===0,'ROUTING_REQUIRED');
  return {status:'REGISTERED',topics:plan.routes.map(route=>{
   const next=route.registration,old=p.topics?.revisions.find(t=>p.topics.latest['topic_'+digest([t.project,t.key])]===t.id&&t.project===next.project&&t.key===next.key);
   if(old&&digest(old.source_ids)===digest(next.source_ids)&&digest(old.routing??null)===digest(next.routing))return {status:'NO_CHANGE',id:old.id};
   return registerTopic(p,next);
  })};
 });},
 async registerTopic(input){return mutate(s=>registerTopic(s.processing??=emptyProcessing(),input));},
 async claimTopic(input){return mutate(s=>claimTopic(s.processing??=emptyProcessing(),input));},
 async finishTopic(input){return mutate(s=>finishTopic(s.processing??=emptyProcessing(),input));},
 async deferTopic(input){return mutate(s=>deferTopic(s.processing??=emptyProcessing(),input));},
 async recordDiscovery(report){validateDiscovery(report);return mutate(s=>{(s.processing??=emptyProcessing()).discovery=structuredClone(report);return {status:"RECORDED"};});},
 async recordCodexUsage(input){return mutate(s=>recordCodexUsage(s.processing??=emptyProcessing(),input));},
 async processingStatus(options){return processingStatus((await read()).processing??emptyProcessing(),options);},
 async enqueueProcessing(input){return mutate(s=>enqueueProcessing(s.processing??=emptyProcessing(),input));},
 async claimProcessing(input){return mutate(s=>claimProcessing(s.processing??=emptyProcessing(),input));},
 async deferProcessing(input){return mutate(s=>deferProcessing(s.processing??=emptyProcessing(),input));},
 async finishProcessing(input){return mutate(s=>finishProcessing(s.processing??=emptyProcessing(),input));},
 async ingest(input){const snap=validateSnapshot(input);return mutate(state=>{
  const key=sourceKey(snap.source);let src=state.sources.find(s=>s.key===key);if(!src){src={key,source:snap.source,messages:[],observations:[],channels:[],latest:null,review_status:'not_generated'};state.sources.push(src);}
  let added=0,changed=0,unchanged=0;for(const m of snap.messages){const hash=messageHash(m);let old=src.messages.find(x=>x.id===m.id);if(!old){old={id:m.id,current_hash:hash,versions:[]};src.messages.push(old);added++;}else if(old.current_hash!==hash){changed++;}else unchanged++;
   if(!old.versions.some(v=>v.hash===hash))old.versions.push({hash,message:m,captured_at:snap.captured_at});old.current_hash=hash;
  }
  const order=snap.messages.map(m=>[m.id,messageHash(m)]),hash=observationHash(order,snap.completeness,snap.gaps),last=src.observations.at(-1),observationChanged=!last||observationHash(last.order,last.completeness,last.gaps)!==hash;
  if(observationChanged)src.observations.push({hash,order,captured_at:snap.captured_at,completeness:snap.completeness,gaps:snap.gaps});
  src.latest={...snap,messages:[]};if(!src.channels.includes(snap.channel))src.channels.push(snap.channel);if(observationChanged)src.review_status='pending';
  let required=0;if(observationChanged)for(const c of state.candidates.filter(c=>c.source_key===key)){c.review_required=true;required++;}
  return {status:observationChanged?'UPDATED':'NO_CHANGE',added,changed,unchanged,review_required:required};
 });},async putReview(batch){const {validateReview}=await import('./review.mjs');return mutate(state=>{const candidates=validateReview(batch,state);let added=0,updated=0;for(const c of candidates){const old=state.candidates.find(x=>x.id===c.id);if(!old){state.candidates.push({...c,source_key:batch.source_key,generator:batch.generator,decision:'pending',review_required:false});added++;}else if(old.review_required||old.observation_hash!==c.observation_hash){const decision=old.decision;Object.assign(old,c,{source_key:batch.source_key,generator:batch.generator,decision,review_required:false});updated++;}}state.sources.find(s=>s.key===batch.source_key).review_status='generated';return {status:added||updated?'UPDATED':'NO_CHANGE',added};});},async decide({candidate_id,decision,...rest}){check(Object.keys(rest).length===0&&['keep','dismiss'].includes(decision));return mutate(state=>{const c=state.candidates.find(x=>x.id===candidate_id);check(c);c.decision=decision;return {status:'UPDATED'};});}};
}
