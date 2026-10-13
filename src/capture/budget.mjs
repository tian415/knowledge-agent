import {check,time} from './model.mjs';

export const PERIOD_MS=10*24*60*60*1000;

// Read-only diagnosis and claims share the same window and byte rules.
export function processingBudget(p,{now,maxJobs=3,maxInputBytes=120000}){
 check(time(now)&&Number.isSafeInteger(maxJobs)&&maxJobs>0&&maxJobs<=100&&Number.isSafeInteger(maxInputBytes)&&maxInputBytes>0&&maxInputBytes<=8*1024*1024);
 const start=p.window?Date.parse(p.window.started_at):0;check(!p.window||Date.parse(now)>=start,'CLOCK_REVERSED');
 const window=p.window&&Date.parse(now)-start<PERIOD_MS?p.window:{started_at:now,jobs:0,input_bytes:0};
 const budget={max_jobs:maxJobs,max_input_bytes:maxInputBytes,remaining_jobs:Math.max(0,maxJobs-window.jobs),remaining_input_bytes:Math.max(0,maxInputBytes-window.input_bytes),resets_at:window.jobs?new Date(Date.parse(window.started_at)+PERIOD_MS).toISOString():null};
 return {window,budget,describe(task,bytes){
  const reason=bytes>maxInputBytes?'INPUT_EXCEEDS_LIMIT':window.jobs>=maxJobs||window.input_bytes+bytes>maxInputBytes?'WINDOW_EXHAUSTED':null;
  return {...task,input_bytes:bytes,reason,retry_at:reason==='WINDOW_EXHAUSTED'?budget.resets_at:null};
 }};
}
