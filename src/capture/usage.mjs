import {check,fields,text,digest} from './model.mjs';
const tokenFields=['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'];
const entries=p=>[...p.jobs,...(p.topics?.revisions??[])];
export const dispatchMetering=()=>({origin:'dispatch',receipts:[]});
export const editorialMetering=()=>({origin:'editorial',receipts:[]});
function validateUsage(usage){
 fields(usage,tokenFields);
 for(const key of tokenFields)check(usage[key]===null||Number.isSafeInteger(usage[key])&&usage[key]>=0,'USAGE_INVALID');
 check(usage.input_tokens!==null&&usage.output_tokens!==null,'USAGE_INVALID');
 for(const key of ['cached_input_tokens','cache_write_input_tokens'])check(usage[key]===null||usage[key]<=usage.input_tokens,'USAGE_INVALID');
 check(usage.reasoning_output_tokens===null||usage.reasoning_output_tokens<=usage.output_tokens,'USAGE_INVALID');
}
export function validateMetering(entry){
 if(!Object.hasOwn(entry,'metering'))return; // Historical state is not evidence of an executor call.
 const m=entry.metering;fields(m,['origin','receipts']);
 check(['dispatch','editorial'].includes(m.origin)&&entry.attempt!==null&&Array.isArray(m.receipts));
 if(m.origin==='editorial')check(entry.status==='completed'&&m.receipts.length===0);
 for(const receipt of m.receipts){fields(receipt,['execution_id','provider','usage']);check(text(receipt.execution_id,256)&&['codex-sdk','codex-sdk-offline'].includes(receipt.provider));validateUsage(receipt.usage);
  check(receipt.provider==='codex-sdk-offline'?entry.execution?.settings.driver==='offline-sdk'&&entry.execution.id===receipt.execution_id:!entry.execution,'USAGE_INVALID');
 }
}
export function validateUsageLedger(p){
 const seen=new Set();
 for(const entry of entries(p)){
  validateMetering(entry);
  for(const r of entry.metering?.receipts??[]){check(!seen.has(r.execution_id),'USAGE_CONFLICT');seen.add(r.execution_id);}
 }
 // Refuse unsafe integer accumulation rather than silently rounding counts.
 usageSummary(p);
}
// Executor-only ingress. The caller must bind one actual SDK run to one claimed
// attempt and a durable execution_id. No CLI/HTTP result submission exposes this.
// This validates attribution and shape, not cryptographic provider authenticity.
export function recordCodexUsage(p,input){
 fields(input,['kind','id','attempt','execution_id','event',...(Object.hasOwn(input,'synthetic')?['synthetic']:[])]);
 check(!Object.hasOwn(input,'synthetic')||input.synthetic===true,'USAGE_INVALID');
 check(['source','topic'].includes(input.kind)&&text(input.execution_id,256),'USAGE_INVALID');
 const entry=(input.kind==='source'?p.jobs:p.topics?.revisions??[]).find(e=>e.id===input.id);
 check(entry&&entry.attempt!==null&&entry.attempt===input.attempt,'ATTEMPT_MISMATCH');
 check(entry.metering?.origin==='dispatch','NOT_DISPATCHED');
 fields(input.event,['type','usage']);check(input.event.type==='turn.completed','USAGE_INVALID');
 const raw=input.event.usage;
 check(raw&&typeof raw==='object'&&!Array.isArray(raw),'USAGE_INVALID');
 fields(raw,['input_tokens','output_tokens',...tokenFields.slice(2).filter(k=>Object.hasOwn(raw,k))]);
 const usage=Object.fromEntries(tokenFields.map(k=>[k,raw[k]??null]));validateUsage(usage);
 check(input.synthetic===true?entry.execution?.settings.driver==='offline-sdk'&&entry.execution.id===input.execution_id:!entry.execution,'USAGE_INVALID');
 const receipt={execution_id:input.execution_id,provider:input.synthetic?'codex-sdk-offline':'codex-sdk',usage};
 for(const other of entries(p))for(const old of other.metering?.receipts??[])if(old.execution_id===receipt.execution_id){
  check(other===entry&&digest(old)===digest(receipt),'USAGE_CONFLICT');return {status:'NO_CHANGE'};
 }
 entry.metering.receipts.push(receipt);validateUsageLedger(p);return {status:'RECORDED'};
}
export function usageSummary(p){
 const summary={scope:'all_attempts',dispatched_attempts:0,legacy_attempts:0,editorial_revisions:0,reported_attempts:0,unknown_attempts:0,reported_turns:0,simulated_attempts:0,simulated_turns:0,
  tokens:Object.fromEntries(tokenFields.map(k=>[k,null])),field_turns:Object.fromEntries(tokenFields.map(k=>[k,0]))};
 for(const entry of entries(p)){
  if(entry.attempt===null)continue;
  if(entry.execution?.settings.driver==='offline-sdk'){summary.simulated_attempts++;summary.simulated_turns+=(entry.metering?.receipts??[]).filter(r=>r.provider==='codex-sdk-offline').length;continue;}
  if(entry.metering?.origin==='editorial'){summary.editorial_revisions++;continue;}
  if(entry.metering?.origin==='dispatch')summary.dispatched_attempts++;else summary.legacy_attempts++;
  const receipts=entry.metering?.receipts??[];
  if(receipts.length)summary.reported_attempts++;else summary.unknown_attempts++;
  for(const receipt of receipts){
   summary.reported_turns++;
   // SDK 0.153.4 synthesizes cache_write_input_tokens=0 when absent.
   // Preserve the received value in the receipt, but do not claim that ambiguous
   // zero as measured coverage. A genuine zero is conservatively unknown too.
   for(const key of tokenFields)if(receipt.usage[key]!==null&&!(key==='cache_write_input_tokens'&&receipt.usage[key]===0)){
    const value=(summary.tokens[key]??0)+receipt.usage[key];check(Number.isSafeInteger(value),'USAGE_OVERFLOW');
    summary.tokens[key]=value;summary.field_turns[key]++;
   }
  }
 }
 return summary;
}
