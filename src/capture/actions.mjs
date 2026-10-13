import {check,fields,text,digest,messageHash} from './model.mjs';
import {applyActionDecision} from '../workspace/action-feedback.mjs';

const types=['COMMITMENT','SUGGESTION','FOLLOW_UP'];
const statuses=['PROPOSED','NEEDS_CONFIRMATION','COMPLETED','CANCELLED','SUPERSEDED','DEFERRED'];
const terminal=new Set(['COMPLETED','CANCELLED','SUPERSEDED','DEFERRED']);
const identity=(source,key)=>'cact_'+digest([source,key]);
const feedbackId=f=>'af_'+digest([f.action_id,f.source_job_id,f.observed_job_id,f.previous_id,f.decision,f.reason,f.until]);
const reviewHash=(id,sourceJob,observedJob,signal,previous)=>digest([id,sourceJob,observedJob,signal,previous]);
const signalFor=(p,jobId,actionId)=>p.jobs.find(j=>j.id===jobId)?.result?.actions?.find(a=>identity(p.jobs.find(j=>j.id===jobId).source_key,a.key)===actionId);

export function validateActionSignals(actions,snapshot){
 check(Array.isArray(actions)&&actions.length<=100);const keys=new Set();
 for(const a of actions){
  fields(a,['key','action','type','status','owner','project','reason','evidence']);
  check(text(a.key,256)&&!keys.has(a.key)&&text(a.action,2000)&&text(a.reason,4000));keys.add(a.key);
  check(types.includes(a.type)&&statuses.includes(a.status)&&['user','other','unknown'].includes(a.owner)&&(a.project===null||text(a.project,256)));
  check(Array.isArray(a.evidence)&&a.evidence.length>0&&a.evidence.length<=20,'INVALID_EVIDENCE');
  let userEvidence=false;
  for(const e of a.evidence){
   fields(e,['message_id','quote']);const message=snapshot.messages.find(m=>m.id===e.message_id);
   check(message&&text(e.quote,4000)&&message.text.includes(e.quote),'INVALID_EVIDENCE');
   if(message.role==='user')userEvidence=true;
  }
  if(a.type==='COMMITMENT'&&a.owner==='user')check(userEvidence,'INVALID_EVIDENCE');
 }
}

export function validateActionFeedback(p){
 if(!Object.hasOwn(p,'action_feedback'))return;
 check(Array.isArray(p.action_feedback));const heads=new Map(),ids=new Set();
 for(const f of p.action_feedback){
  fields(f,['id','action_id','source_job_id','observed_job_id','previous_id','review_hash','decision','reason','until']);
  const job=p.jobs.find(j=>j.id===f.source_job_id),observed=p.jobs.find(j=>j.id===f.observed_job_id),signal=signalFor(p,f.source_job_id,f.action_id);
  check(job?.status==='completed'&&observed?.source_key===job.source_key&&signal&&!ids.has(f.id));
  check(f.previous_id===(heads.get(f.action_id)??null)&&f.id===feedbackId(f)&&f.review_hash===reviewHash(f.action_id,job.id,observed.id,signal,f.previous_id));
  check(f.reason===null||text(f.reason,4000));
  const probe=applyActionDecision({type:signal.type,formal:false},{decision:f.decision,reason:f.reason,until:f.until});
  check(probe.until===f.until);heads.set(f.action_id,f.id);ids.add(f.id);
 }
}

// A derived view over the existing ledger: no second ingestion or material-ID impersonation.
export function captureActionView(p,{now=new Date().toISOString()}={}){
 const at=Date.parse(now);check(Number.isFinite(at));
 const rows=new Map();
 for(const job of p?.jobs??[]){
  if(job.status!=='completed')continue;
  for(const signal of job.result.actions??[])rows.set(identity(job.source_key,signal.key),{job,signal});
 }
 // A revisited cached source may be older in insertion order but is authoritative for this observation.
 for(const job of p?.jobs??[]){
  if(p.latest[job.source_key]!==job.id||job.status!=='completed')continue;
  for(const signal of job.result.actions??[])rows.set(identity(job.source_key,signal.key),{job,signal});
 }
 const actions=[];
 for(const [id,{job,signal}] of rows){
  const observed=p.latest[job.source_key],events=(p.action_feedback??[]).filter(f=>f.action_id===id);
  const state={type:signal.type,status:signal.type==='SUGGESTION'?'SUGGESTED':'NEEDS_CONFIRMATION',formal:false,confirmed:false,feedback:null,until:null};
  for(const event of events){state.type=signalFor(p,event.source_job_id,id).type;applyActionDecision(state,event);}
  state.type=signal.type;
  actions.push({...state,id,material_id:null,action:signal.action,reason:signal.reason,owner:signal.owner,related:{route_type:signal.project?'project':null,route_id:signal.project,route_name:signal.project},source_status:signal.status,
   capture:{source_key:job.source_key,job_id:job.id,key:signal.key,title:job.snapshot.title,system:job.snapshot.source.system,completeness:job.snapshot.completeness},stale:observed!==job.id,
   evidence:signal.evidence.map(e=>({...e,message_hash:messageHash(job.snapshot.messages.find(m=>m.id===e.message_id)),snippet:e.quote})),
   review_hash:reviewHash(id,job.id,observed,signal,events.at(-1)?.id??null),primary_source:null,sync_status:null});
 }
 const due=a=>a.until!==null&&Date.parse(a.until)<=at;
 const personal=a=>a.formal||a.owner==='user';
 return {actions,
  suggestions:actions.filter(a=>!a.stale&&personal(a)&&!a.formal&&a.type==='SUGGESTION'&&(a.status==='SUGGESTED'||a.status==='DEFERRED'&&due(a))).slice(0,3),
  focus:actions.filter(a=>!a.stale&&personal(a)&&(a.type!=='SUGGESTION'||a.formal)&&(a.confirmed||!terminal.has(a.source_status))&&(['OPEN','NEEDS_CONFIRMATION'].includes(a.status)||a.status==='DEFERRED'&&due(a))).slice(0,3)};
}

export function decideCaptureAction(p,input){
 fields(input,['id','expected_review_hash','decision',...['reason','until'].filter(k=>Object.hasOwn(input,k))]);
 check(typeof input.id==='string'&&typeof input.expected_review_hash==='string');
 const action=captureActionView(p).actions.find(a=>a.id===input.id);check(action,'NOT_FOUND');
 const previous=(p.action_feedback??[]).filter(f=>f.action_id===input.id).at(-1)??null;
 const reviewed=applyActionDecision({...action},input);
 check(reviewed.feedback.reason===null||text(reviewed.feedback.reason,4000));
 if(previous&&previous.review_hash===input.expected_review_hash&&previous.decision===input.decision&&previous.reason===reviewed.feedback.reason&&previous.until===reviewed.until&&previous.source_job_id===action.capture.job_id&&previous.observed_job_id===p.latest[action.capture.source_key])return {status:'NO_CHANGE'};
 check(input.expected_review_hash===action.review_hash,'STALE_INPUT');
 check(!action.stale||['defer','dismiss','cancel'].includes(input.decision),'STALE_INPUT');
 const f={action_id:action.id,source_job_id:action.capture.job_id,observed_job_id:p.latest[action.capture.source_key],previous_id:previous?.id??null,review_hash:action.review_hash,decision:input.decision,reason:reviewed.feedback.reason,until:reviewed.until};f.id=feedbackId(f);
 (p.action_feedback??=[]).push(f);return {status:'RECORDED'};
}

export function captureActionSource(p,{id,expected_review_hash,...extra}){
 check(Object.keys(extra).length===0);const action=captureActionView(p).actions.find(a=>a.id===id);check(action,'NOT_FOUND');check(action.review_hash===expected_review_hash,'STALE_INPUT');
 return {stale:action.stale,snapshot:structuredClone(p.jobs.find(j=>j.id===action.capture.job_id).snapshot)};
}
