const decisions=new Set(['accept','complete','defer','dismiss','cancel','reopen']);
const fail=message=>{throw Object.assign(new Error(message),{code:'INPUT_INVALID'});};
// Shared human decision rules. Callers own identity, version checks and persistence.
export function applyActionDecision(action,{decision,reason,until}){
 if(!decisions.has(decision))fail('Unsupported action decision');
 const wasFormal=action.formal;
 let deferUntil=null;
 if(decision==='defer'&&until!==undefined&&until!==null&&until!==''){
  if(typeof until!=='string'||!Number.isFinite(Date.parse(until)))fail('Invalid deferral date');
  deferUntil=until;
 }
 if(reason!==undefined&&reason!==null&&(typeof reason!=='string'||!/\S/u.test(reason)))fail('Invalid feedback reason');
 action.feedback={decision,reason:reason??null,until:deferUntil};action.until=deferUntil;
 if(decision==='accept'){action.status='OPEN';action.confirmed=true;action.formal=true;}
 else if(decision==='complete')action.status='COMPLETED';
 else if(decision==='defer')action.status='DEFERRED';
 else if(decision==='dismiss')action.status='DISMISSED';
 else if(decision==='cancel')action.status='CANCELLED';
 else {action.status=action.type==='SUGGESTION'&&!wasFormal?'SUGGESTED':'OPEN';action.until=null;action.feedback.until=null;}
 if(decision!=='accept'){
  if(wasFormal||action.type!=='SUGGESTION'){action.formal=true;action.confirmed=true;}
  else {action.formal=false;action.confirmed=false;}
 }
 return action;
}
