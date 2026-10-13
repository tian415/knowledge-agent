import {validateKnowledgeUnits} from './knowledge-routing.mjs';
import {reviewContract} from './review-contract.mjs';
import {validateExecutions,executionStatus} from './execution-state.mjs';
import {validateTopics,topicStatus,refreshTopicInputs,topicQueueInputs} from './topics.mjs';
import {randomUUID} from 'node:crypto';
import {check,fields,text,time,digest,sourceKey,validateSnapshot} from './model.mjs';
import {validateActionSignals,validateActionFeedback,captureActionView} from './actions.mjs';
import {dispatchMetering,validateUsageLedger,usageSummary} from './usage.mjs';
import {processingBudget} from './budget.mjs';

export {PERIOD_MS} from './budget.mjs';
export const emptyProcessing=()=>({jobs:[],latest:{},window:null,discovery:null});
// Acquisition time/channel are not semantic changes. Coverage, order, roles and recipe are.
function identity(snapshot,recipe){
 const {captured_at,channel,...content}=snapshot;
 return 'job_'+digest([recipe,content]);
}
function validateResult(result,snapshot){
 fields(result,['decision','markdown','reason','coverage','usage',...['actions','knowledge_units'].filter(k=>Object.hasOwn(result,k))]);
 check(['draft','no_value','needs_context'].includes(result.decision)&&text(result.reason,4000));
 check(typeof result.markdown==='string'&&result.markdown.length<=100000);
 check(result.decision==='draft'?text(result.markdown,100000):result.markdown==='');
 if(result.usage!==null){fields(result.usage,['input_tokens','output_tokens']);check(Object.values(result.usage).every(x=>Number.isSafeInteger(x)&&x>=0));}
 if(Object.hasOwn(result,'knowledge_units')){validateKnowledgeUnits(result.knowledge_units,snapshot);check(result.decision==='draft'||result.knowledge_units.length===0);}
 if(Object.hasOwn(result,'actions'))validateActionSignals(result.actions,snapshot);
 if(result.decision==='needs_context'){check(result.coverage===null&&!(result.actions?.length));return;}
 fields(result.coverage,['question','analysis','ending']);
 for(const refs of Object.values(result.coverage)){
  check(Array.isArray(refs)&&refs.length>0&&refs.length<=20,'CONTEXT_REQUIRED');
  for(const ref of refs){fields(ref,['message_id','quote']);check(text(ref.quote,4000)&&snapshot.messages.some(m=>m.id===ref.message_id&&m.text.includes(ref.quote)),'INVALID_EVIDENCE');}
 }
 // These are auditable assistant judgments, not a proof that a theme was understood.
}
export function validateProcessing(p){
 fields(p,['jobs','latest','window','discovery',...['topics','action_feedback'].filter(k=>Object.hasOwn(p,k))]);if(p.discovery!==null)validateDiscovery(p.discovery);check(Array.isArray(p.jobs)&&p.latest&&typeof p.latest==='object'&&!Array.isArray(p.latest));
 const ids=new Set();
 for(const j of p.jobs){
  fields(j,['id','source_key','recipe','snapshot','status','attempt','result',...['metering','execution'].filter(k=>Object.hasOwn(j,k))]);validateSnapshot(j.snapshot);
  check(text(j.recipe,256)&&j.id===identity(j.snapshot,j.recipe)&&j.source_key===sourceKey(j.snapshot.source)&&!ids.has(j.id));ids.add(j.id);
  check(['queued','running','completed','blocked'].includes(j.status));
  check(j.attempt===null||/^[a-f0-9-]{36}$/u.test(j.attempt));
  if(j.status==='queued')check(j.attempt===null&&j.result===null);
  if(j.status==='running')check(j.attempt!==null&&j.result===null);
  if(['completed','blocked'].includes(j.status)){validateResult(j.result,j.snapshot);check((j.status==='blocked')===(j.result.decision==='needs_context'));if(j.status==='completed')check(j.attempt!==null);}
 }
 for(const [key,id] of Object.entries(p.latest))check(p.jobs.some(j=>j.id===id&&j.source_key===key));
 check(p.jobs.every(j=>Object.hasOwn(p.latest,j.source_key)));
 if(Object.hasOwn(p,'topics'))validateTopics(p);
 validateActionFeedback(p);
 validateUsageLedger(p);
 validateExecutions(p);
 if(p.window!==null){fields(p.window,['started_at','jobs','input_bytes']);check(time(p.window.started_at)&&Number.isSafeInteger(p.window.jobs)&&p.window.jobs>=0&&Number.isSafeInteger(p.window.input_bytes)&&p.window.input_bytes>=0);}
}
export function enqueueProcessing(p,{snapshot:raw,recipe}){
 const snapshot=validateSnapshot(raw);check(text(recipe,256));const id=identity(snapshot,recipe),key=sourceKey(snapshot.source);
 const previous=p.jobs.filter(j=>j.source_key===key&&j.status==='completed').at(-1);
 const observedIds=new Set(snapshot.messages.map(m=>m.id));
 // A smaller partial read cannot supersede analyzed context or stand in for a deletion.
 const contextLost=snapshot.completeness==='partial'&&previous?.snapshot.messages.some(m=>!observedIds.has(m.id));
 // A cached shorter snapshot is historical evidence, not permission to rewind latest.
 if(contextLost&&p.jobs.some(j=>j.id===id))return {status:'CONTEXT_REQUIRED',id,reason:'旧的部分读取缺少当前已分析上下文；已保留较新分析，请补读来源。'};
 p.latest[key]=id;
 if(p.jobs.some(j=>j.id===id))return {status:'NO_CHANGE',id};
 const automated=snapshot.gaps.includes('automated_session_excluded');
 const missing=automated||contextLost||!snapshot.messages.some(m=>m.role==='user')||snapshot.gaps.some(g=>['incomplete_tail','unstable_message_identity','user_context_missing','compaction_or_rollback'].includes(g));
 p.jobs.push({id,source_key:key,recipe,snapshot,status:missing?'blocked':'queued',attempt:null,result:missing?{decision:'needs_context',markdown:'',reason:automated?'自动执行或子代理会话已排除，不作为用户日常对话。旧观察与处理记录保留。':contextLost?'本次仅部分读取，缺少此前已分析的消息；请补读上下文或明确分支范围，不把未读取视为删除。':'消息身份、尾部、用户上下文或压缩回滚记录需要补读核对。',coverage:null,usage:null}:null});
 return {status:missing?'CONTEXT_REQUIRED':'QUEUED',id};
}
export function processingStatus(p,options){
 const current=p.jobs.filter(j=>p.latest[j.source_key]===j.id&&!j.snapshot.gaps.includes('automated_session_excluded'));
 const counts=Object.fromEntries(['queued','running','completed','blocked'].map(s=>[s,current.filter(j=>j.status===s).length]));
 const latestTopics=new Set(Object.values(p.topics?.latest??{}));
 const pending_attempts=[
  ...p.jobs.filter(j=>j.status==='running').map(j=>({kind:'source',id:j.id,attempt:j.attempt,title:j.snapshot.title,stale:p.latest[j.source_key]!==j.id})),
  ...(p.topics?.revisions??[]).filter(t=>t.status==='running').map(t=>({kind:'topic',id:t.id,attempt:t.attempt,title:t.title,
   stale:!latestTopics.has(t.id)||t.source_ids.some(id=>{const j=p.jobs.find(j=>j.id===id);return p.latest[j.source_key]!==id;})}))
 ];
 let queueInfo={};
 if(options){
  const {budget,describe}=processingBudget(p,options);
  const queue=[...sourceQueueInputs(p).map(({job:j,input_bytes})=>describe({kind:'source',id:j.id,title:j.snapshot.title},input_bytes)),...topicQueueInputs(p).map(({topic:t,input_bytes})=>describe({kind:'topic',id:t.id,title:t.title},input_bytes))];
  queueInfo={budget,queue};
 }
 return {...counts,...queueInfo,usage:usageSummary(p),executions:executionStatus(p),topics:topicStatus(p),actions:captureActionView(p).actions,unresolved_attempts:pending_attempts.length,pending_attempts,window:p.window,period_days:10,discovery:p.discovery,
  jobs:current.map(j=>({id:j.id,title:j.snapshot.title,source:j.snapshot.source.system,status:j.status,completeness:j.snapshot.completeness,gaps:j.snapshot.gaps,reason:j.result?.reason??null,decision:j.result?.decision??null,markdown:j.result?.markdown??null,knowledge_units:j.result?.knowledge_units??null,coverage:j.result?.coverage??null,message_count:j.snapshot.messages.length}))};
}
function sourceQueueInputs(p){
 const jobs=p.jobs.filter(j=>p.latest[j.source_key]===j.id&&j.status==='queued'),inputs=[];
 for(const j of jobs){
  // A source with an uncertain in-flight attempt is held until that attempt is reconciled.
  if(p.jobs.some(old=>old.source_key===j.source_key&&old.status==='running'))continue;
  const previous=p.jobs.filter(old=>old.source_key===j.source_key&&old.status==='completed').at(-1)?.result??null;
  const inputBytes=Buffer.byteLength(JSON.stringify({snapshot:j.snapshot,previous,review_contract:reviewContract}));
  inputs.push({job:j,previous,input_bytes:inputBytes});
 }
 return inputs;
}
export function claimProcessing(p,options){
 const {window:w,describe}=processingBudget(p,options),deferred=[];
 for(const {job:j,previous,input_bytes:inputBytes} of sourceQueueInputs(p)){
  const entry=describe({kind:'source',id:j.id,title:j.snapshot.title},inputBytes);
  if(entry.reason){deferred.push(entry);continue;}
  j.status='running';j.attempt=randomUUID();j.metering=dispatchMetering();w.jobs++;w.input_bytes+=inputBytes;p.window=w;
  return {status:'CLAIMED',job:structuredClone(j),previous:structuredClone(previous),review_contract:structuredClone(reviewContract),input_bytes:inputBytes};
 }
 return {status:deferred.length?'BUDGET_DEFERRED':p.jobs.some(j=>j.status==='running')||p.jobs.some(j=>p.latest[j.source_key]===j.id&&j.status==='blocked'&&!j.snapshot.gaps.includes('automated_session_excluded'))?'ATTENTION_REQUIRED':'NO_WORK',...(deferred.length?{deferred}:{})};
}
export function finishProcessing(p,{id,attempt,result}){
 const j=p.jobs.find(j=>j.id===id);check(j&&j.attempt!==null&&j.attempt===attempt,'ATTEMPT_MISMATCH');
 check(p.latest[j.source_key]===id,'STALE_INPUT');validateResult(result,j.snapshot);
 if(j.recipe==='knowledge-units-v2'&&result.decision!=='needs_context')check(Array.isArray(result.knowledge_units),'ROUTING_REQUIRED');
 if(j.status==='completed'||j.status==='blocked'){check(digest(j.result)===digest(result),'RESULT_CONFLICT');return {status:'NO_CHANGE'};}
 check(j.status==='running','ATTEMPT_MISMATCH');j.result=structuredClone(result);j.status=result.decision==='needs_context'?'blocked':'completed';
 refreshTopicInputs(p);
 return {status:j.status==='blocked'?'CONTEXT_REQUIRED':'COMPLETED'};
}

export function validateDiscovery(report){
 fields(report,['at','complete','limited','examined','queued','unchanged','blocked','excluded','errors']);
 check(time(report.at)&&typeof report.complete==='boolean'&&typeof report.limited==='boolean');
 for(const k of ['examined','queued','unchanged','blocked','excluded'])check(Number.isSafeInteger(report[k])&&report[k]>=0);
 check(Array.isArray(report.errors));for(const e of report.errors){fields(e,['file','code']);check(text(e.file,4096)&&text(e.code,256));}
 check(!report.complete||(!report.limited&&report.errors.length===0));
}

export function deferProcessing(p,{id,attempt,reason}){
 const j=p.jobs.find(j=>j.id===id);check(j&&j.status==='running'&&j.attempt===attempt&&text(reason,4000),'ATTEMPT_MISMATCH');
 j.status='blocked';j.result={decision:'needs_context',markdown:'',reason,coverage:null,usage:null};
 return {status:'CONTEXT_REQUIRED'};
}
