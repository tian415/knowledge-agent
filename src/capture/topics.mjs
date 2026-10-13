import {validateTopicRouting,routedAnalysis} from './knowledge-routing.mjs';
import {reviewContract} from './review-contract.mjs';
import {randomUUID} from 'node:crypto';
import {check,fields,text,digest} from './model.mjs';
import {dispatchMetering,editorialMetering} from './usage.mjs';
import {processingBudget} from './budget.mjs';
const empty=()=>({revisions:[],latest:{}});
const topicKey=t=>'topic_'+digest([t.project,t.key]);
const revisionId=t=>'topicrev_'+digest([t.project,t.key,t.title,t.recipe,t.source_ids,...(t.routing?[t.routing]:[])]);
const current=(p,t)=>t.source_ids.every(id=>{const j=p.jobs.find(j=>j.id===id);return j&&p.latest[j.source_key]===id&&j.status==='completed';});
const latestFeedback=(p,id)=>(p.topics?.feedback??[]).filter(f=>f.topic_id===id).at(-1)??null;
const feedbackId=f=>'feedback_'+digest([f.topic_id,f.previous_id,f.action,f.title,f.markdown,f.reason]);
function validateFeedback(f){
 fields(f,['id','topic_id','previous_id','action','title','markdown','reason']);
 check(typeof f.topic_id==='string'&&(f.previous_id===null||typeof f.previous_id==='string'));
 check(['edit','dismiss','reopen'].includes(f.action)&&text(f.reason,4000));
 check(f.action==='edit'?text(f.title,256)&&text(f.markdown,100000):f.title===''&&f.markdown==='');
 check(f.id===feedbackId(f));
}
function validateResult(p,t,r){
 fields(r,['kind','markdown','contribution','evidence',...['project_type','source_summaries'].filter(k=>Object.hasOwn(r,k))]);
 check(!Object.hasOwn(r,'project_type')||(r.kind==='project'&&['agreement','progress','introduction'].includes(r.project_type)));check(['knowledge','project','no_value'].includes(r.kind)&&text(r.contribution,4000));
 check(r.kind==='no_value'?r.markdown==='':text(r.markdown,100000));check(Array.isArray(r.evidence)&&r.evidence.length<=100);
 if(r.source_summaries){
  check(Array.isArray(r.source_summaries)&&r.source_summaries.length===t.source_ids.length);
  const ids=new Set();for(const s of r.source_summaries){fields(s,['job_id','summary']);check(t.source_ids.includes(s.job_id)&&!ids.has(s.job_id)&&text(s.summary,500));ids.add(s.job_id);}
 }
 if(t.routing){
  check(r.kind==='no_value'||r.kind===(t.routing.knowledge_layer==='PROJECT_KNOWLEDGE'?'project':'knowledge'),'ROUTE_MISMATCH');
  check(r.source_summaries,'ROUTING_REQUIRED');
  for(const ref of r.evidence){const job=p.jobs.find(j=>j.id===ref.job_id);check(job&&routedAnalysis(job,t).knowledge_units.some(u=>u.evidence.some(e=>e.message_id===ref.message_id&&e.quote.includes(ref.quote))),'INVALID_EVIDENCE');}
 }
 const represented=new Set();
 for(const ref of r.evidence){fields(ref,['job_id','message_id','quote']);const j=p.jobs.find(j=>j.id===ref.job_id);check(t.source_ids.includes(ref.job_id)&&text(ref.quote,4000)&&j?.snapshot.messages.some(m=>m.id===ref.message_id&&m.text.includes(ref.quote)),'INVALID_EVIDENCE');represented.add(ref.job_id);}
 check(t.source_ids.every(id=>represented.has(id)),'INVALID_EVIDENCE');
}
export function validateTopics(p){
 const ts=p.topics;fields(ts,['revisions','latest',...(Object.hasOwn(ts,'feedback')?['feedback']:[])]);check(Array.isArray(ts.revisions)&&ts.latest&&typeof ts.latest==='object'&&!Array.isArray(ts.latest));const ids=new Set();
 for(const t of ts.revisions){
  fields(t,['id','project','key','title','recipe','source_ids','status','attempt','result',...['metering','execution','routing'].filter(k=>Object.hasOwn(t,k))]);
  check([t.project,t.key,t.title,t.recipe].every(x=>text(x,256))&&Array.isArray(t.source_ids)&&t.source_ids.length>0&&t.source_ids.length<=30&&new Set(t.source_ids).size===t.source_ids.length);
  check(t.source_ids.every(id=>p.jobs.some(j=>j.id===id&&j.status==='completed'))&&new Set(t.source_ids.map(id=>p.jobs.find(j=>j.id===id).source_key)).size===t.source_ids.length);
  if(t.routing)validateTopicRouting(p,t);
  check(t.id===revisionId(t)&&!ids.has(t.id));ids.add(t.id);check(['queued','running','completed','blocked'].includes(t.status));
  check(t.attempt===null||/^[a-f0-9-]{36}$/u.test(t.attempt));
  if(t.status==='queued')check(t.result===null&&t.attempt===null);
  if(t.status==='running')check(t.result===null&&t.attempt!==null);
  if(t.status==='completed'){check(t.attempt!==null);validateResult(p,t,t.result);}
  if(t.status==='blocked'){check(t.attempt!==null);fields(t.result,['reason']);check(text(t.result.reason,4000));}
 }
 for(const [key,id] of Object.entries(ts.latest))check(ts.revisions.some(t=>t.id===id&&topicKey(t)===key));
 check(ts.revisions.every(t=>Object.hasOwn(ts.latest,topicKey(t))));
 if(Object.hasOwn(ts,'feedback')){
  check(Array.isArray(ts.feedback));const heads=new Map(),seen=new Set();
  for(const f of ts.feedback){validateFeedback(f);check(ids.has(f.topic_id)&&!seen.has(f.id)&&f.previous_id===(heads.get(f.topic_id)??null));seen.add(f.id);heads.set(f.topic_id,f.id);}
 }
}
export function registerTopic(p,input){
 fields(input,['project','key','title','recipe','source_ids',...(Object.hasOwn(input,'routing')?['routing']:[])]);const {project,key,title,recipe}=input;
 check([project,key,title,recipe].every(x=>text(x,256))&&Array.isArray(input.source_ids)&&input.source_ids.length>0&&input.source_ids.length<=30&&new Set(input.source_ids).size===input.source_ids.length);
 const source_ids=[...input.source_ids].sort();check(source_ids.every(id=>p.jobs.some(j=>j.id===id&&j.status==='completed'&&p.latest[j.source_key]===id)),'CONTEXT_REQUIRED');
 check(new Set(source_ids.map(id=>p.jobs.find(j=>j.id===id).source_key)).size===source_ids.length);
 const t={project,key,title,recipe,source_ids,...(input.routing?{routing:structuredClone(input.routing)}:{})};if(t.routing)validateTopicRouting(p,t);const id=revisionId(t),ts=p.topics??=empty();
 if(ts.revisions.some(x=>x.id===id)){check(ts.latest[topicKey(t)]===id,'STALE_INPUT');return {status:'NO_CHANGE',id};}
 ts.latest[topicKey(t)]=id;
 ts.revisions.push({id,...t,status:'queued',attempt:null,result:null});return {status:'QUEUED',id};
}
// Topic membership is a semantic decision made by Codex. Once linked, version refresh is deterministic.
export function refreshTopicInputs(p){
 if(!p.topics)return;
 for(const t of p.topics.revisions.filter(t=>p.topics.latest[topicKey(t)]===t.id)){
  if(current(p,t)||t.routing||['dismiss','edit'].includes(latestFeedback(p,t.id)?.action))continue;
  const next=t.source_ids.map(id=>p.latest[p.jobs.find(j=>j.id===id).source_key]);
  if(next.every(id=>p.jobs.find(j=>j.id===id)?.status==='completed'))registerTopic(p,{project:t.project,key:t.key,title:t.title,recipe:t.recipe,source_ids:next});
 }
}
export function topicStatus(p){
 return (p.topics?.revisions??[]).filter(t=>p.topics.latest[topicKey(t)]===t.id).map(t=>({id:t.id,key:t.key,project:t.project,title:t.title,...(t.routing?{routing:t.routing}:{}),status:({edit:'review_required',dismiss:'dismissed'})[latestFeedback(p,t.id)?.action]??(current(p,t)?t.status:'needs_update'),source_stale:!current(p,t),source_count:t.source_ids.length,result:current(p,t)&&t.status==='completed'?t.result:null,feedback:latestFeedback(p,t.id),
  sources:t.source_ids.map(id=>{const j=p.jobs.find(j=>j.id===id);return {id,title:j.snapshot.title,system:j.snapshot.source.system,url:j.snapshot.url,dates:[...new Set(j.snapshot.messages.map(m=>m.source_time?.slice(0,10)).filter(Boolean))].sort(),completeness:j.snapshot.completeness};})}));
}
export function topicQueueInputs(p){
 const ts=p.topics??empty(),inputs=[];
 for(const t of ts.revisions.filter(t=>ts.latest[topicKey(t)]===t.id&&t.status==='queued'&&current(p,t))){
  if(ts.revisions.some(old=>topicKey(old)===topicKey(t)&&old.status==='running'))continue;
  const sources=t.source_ids.map(id=>{const j=p.jobs.find(j=>j.id===id);return {id,title:j.snapshot.title,source:j.snapshot.source,analysis:routedAnalysis(j,t),coverage:j.snapshot.gaps};});
  const previous=ts.revisions.filter(old=>topicKey(old)===topicKey(t)&&old.status==='completed').at(-1)?.result??null;
  const feedback=(ts.feedback??[]).filter(f=>topicKey(ts.revisions.find(r=>r.id===f.topic_id))===topicKey(t)).at(-1)??null;
  const payload={topic:{project:t.project,key:t.key,title:t.title,...(t.routing?{routing:t.routing}:{})},sources,previous,review_contract:reviewContract,...(feedback?{feedback}:{})};
  inputs.push({topic:t,payload,input_bytes:Buffer.byteLength(JSON.stringify(payload))});
 }
 return inputs;
}
export function claimTopic(p,options){
 const ts=p.topics??empty(),{window:w,describe}=processingBudget(p,options),deferred=[];
 for(const {topic:t,payload,input_bytes:bytes} of topicQueueInputs(p)){
  const entry=describe({kind:'topic',id:t.id,title:t.title},bytes);
  if(entry.reason){deferred.push(entry);continue;}
  t.status='running';t.attempt=randomUUID();t.metering=dispatchMetering();w.jobs++;w.input_bytes+=bytes;p.window=w;
  return {status:'CLAIMED',id:t.id,attempt:t.attempt,...structuredClone(payload),input_bytes:bytes};
 }
 return {status:deferred.length?'BUDGET_DEFERRED':ts.revisions.some(t=>t.status==='running')||topicStatus(p).some(t=>['needs_update','blocked','review_required'].includes(t.status))?'ATTENTION_REQUIRED':'NO_WORK',...(deferred.length?{deferred}:{})};
}
export function finishTopic(p,{id,attempt,result}){
 const t=p.topics?.revisions.find(t=>t.id===id);check(t&&t.attempt!==null&&t.attempt===attempt,'ATTEMPT_MISMATCH');
 check(p.topics.latest[topicKey(t)]===id&&current(p,t),'STALE_INPUT');validateResult(p,t,result);
 if(t.status==='completed'){check(digest(t.result)===digest(result),'RESULT_CONFLICT');return {status:'NO_CHANGE'};}
 check(t.status==='running','ATTEMPT_MISMATCH');t.result=structuredClone(result);t.status='completed';return {status:'COMPLETED'};
}
export function deferTopic(p,{id,attempt,reason}){
 const t=p.topics?.revisions.find(t=>t.id===id);check(t&&t.status==='running'&&t.attempt===attempt&&text(reason,4000),'ATTEMPT_MISMATCH');t.status='blocked';t.result={reason};return {status:'CONTEXT_REQUIRED'};
}

function completedCurrentTopic(p,id){
 const t=p?.topics?.revisions.find(t=>t.id===id);
 check(t&&p.topics.latest[topicKey(t)]===id&&current(p,t),'STALE_INPUT');
 check(t.status==='completed'&&t.result.kind!=='no_value','CONTEXT_REQUIRED');return t;
}
export function currentTopic(p,id){
 const t=completedCurrentTopic(p,id),feedback=latestFeedback(p,id);
 check(!feedback||feedback.action==='reopen','REVIEW_REQUIRED');return t;
}
export function topicSources(p,id){
 const t=completedCurrentTopic(p,id);
 return {topic_id:t.id,sources:t.source_ids.map(id=>({id,snapshot:structuredClone(p.jobs.find(j=>j.id===id).snapshot)}))};
}

// Web feedback is an unreviewed proposal, never a replacement for accepted output.
export function recordTopicFeedback(p,input){
 fields(input,['id','expected_feedback_id','action','title','markdown','reason']);
 const f={topic_id:input.id,previous_id:input.expected_feedback_id,action:input.action,title:input.title,markdown:input.markdown,reason:input.reason};f.id=feedbackId(f);validateFeedback(f);
 const previous=latestFeedback(p,input.id);
 const old=p?.topics?.revisions.find(t=>t.id===input.id);
 const restored=old?{...structuredClone(old),recipe:'restore-'+f.id}:null;
 if(previous?.id===f.id&&f.action==='reopen'){
  const id=revisionId(restored);completedCurrentTopic(p,id);return {status:'NO_CHANGE',id:f.id,topic_id:id};
 }
 completedCurrentTopic(p,input.id);
 if(previous?.id===f.id)return {status:'NO_CHANGE',id:f.id};
 check((previous?.id??null)===f.previous_id,'FEEDBACK_CONFLICT');
 (p.topics.feedback??=[]).push(f);
 if(f.action==='reopen'){
  restored.id=revisionId(restored);restored.attempt=randomUUID();restored.metering=editorialMetering();delete restored.execution;
  p.topics.revisions.push(restored);p.topics.latest[topicKey(restored)]=restored.id;
  return {status:'RECORDED',id:f.id,topic_id:restored.id};
 }
 return {status:'RECORDED',id:f.id};
}

// Explicit editorial correction, not a model dispatch. Keep the original revision.
export function correctTopic(p,input){
 fields(input,['id','title','result',...(Object.hasOwn(input,'feedback_id')?['feedback_id']:[])]);check(text(input.title,256));
 const old=p?.topics?.revisions.find(t=>t.id===input.id);check(old,'STALE_INPUT');
 const recipe='correction-'+digest(input),t={project:old.project,key:old.key,title:input.title,recipe,source_ids:[...old.source_ids],...(old.routing?{routing:structuredClone(old.routing)}:{})},id=revisionId(t);
 validateResult(p,t,input.result);
 if(p.topics.latest[topicKey(t)]===id&&current(p,t))return {status:'NO_CHANGE',id};
 completedCurrentTopic(p,input.id);
 check((latestFeedback(p,input.id)?.id??null)===(input.feedback_id??null),'FEEDBACK_CONFLICT');
 p.topics.revisions.push({id,...t,status:'completed',attempt:randomUUID(),metering:editorialMetering(),result:structuredClone(input.result)});
 p.topics.latest[topicKey(t)]=id;return {status:'CORRECTED',id};
}
