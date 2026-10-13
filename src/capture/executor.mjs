import {validateExecutionSettings,executionError} from './execution-state.mjs';
import {offlineEvents} from './offline-driver.mjs';
const bind=r=>({kind:r.kind,id:r.id,attempt:r.attempt,execution_id:r.execution_id});
async function attention(store,binding,error){
 const code=executionError(error?.code);await store.stopExecution({binding,error:code});
 return {status:'EXECUTION_ATTENTION',...binding,error:code};
}
export async function recoverExecution({store,binding}){
 const e=await store.executionView(binding);
 if(e.phase==='finalized')return {status:'NO_CHANGE',...binding};
 if(e.terminal!=='completed'||e.output===null)return {status:'EXECUTION_ATTENTION',...binding,error:e.error??'EXECUTION_UNCERTAIN'};
 try{return {...await store.completeExecution(binding),...binding};}
 catch(error){return attention(store,binding,error);}
}
export async function runOfflineOnce({store,kind,budget,settings}){
 validateExecutionSettings(settings);
 const claim=await store.claimExecution({kind,...budget,settings});if(claim.status!=='CLAIMED')return claim;
 const binding=bind(claim);
 // Commit started before the only possible spawn. Re-entry never resumes execution.
 let execution;
 try{
  execution=await store.startExecution(binding);
  for await(const event of offlineEvents(execution))await store.recordExecutionEvent({binding,event});
 }catch(error){return attention(store,binding,error);}
 return recoverExecution({store,binding});
}
