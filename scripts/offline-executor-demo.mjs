import fs from 'node:fs/promises';
import path from 'node:path';
import {createExecutionDemo} from '../src/capture/execution-demo.mjs';
import {runOfflineOnce,recoverExecution} from '../src/capture/executor.mjs';
import {scenarios} from '../src/capture/execution-state.mjs';
import {loadRuntimeConfig,openReviewWorkspace,processingSummary,readReviewInput} from '../src/capture/runtime.mjs';
import {check} from '../src/capture/model.mjs';
try{
 const args=process.argv.slice(2);let store,configFile,directory,recoveryFile,result;
 if(args[0]==='recover'){
  check(args.length===5&&args[1]==='--config'&&path.isAbsolute(args[2])&&args[3]==='--input'&&path.isAbsolute(args[4]));
  configFile=args[2];recoveryFile=args[4];const config=await loadRuntimeConfig(configFile);store=(await openReviewWorkspace(config)).store;
  result=await recoverExecution({store,binding:await readReviewInput(recoveryFile)});
 }else{
  const [kind,scenario='success']=args;check(args.length>=1&&args.length<=2&&['source','topic'].includes(kind)&&scenarios.includes(scenario));
  const demo=await createExecutionDemo(kind);store=demo.store;directory=demo.root;configFile=demo.configFile;
  result=await runOfflineOnce({store,kind,budget:{now:new Date().toISOString(),maxJobs:demo.config.budget.max_jobs,maxInputBytes:demo.config.budget.max_input_bytes},settings:{driver:'offline-sdk',scenario,timeout_ms:scenario==='timeout'?500:5000}});
  recoveryFile=directory+'/recovery.json';
  await fs.writeFile(recoveryFile,JSON.stringify({kind:result.kind,id:result.id,attempt:result.attempt,execution_id:result.execution_id})+'\n',{mode:0o600});
 }
 console.log(JSON.stringify({mode:'synthetic_offline',directory,config:configFile,recovery_file:recoveryFile,result,processing:processingSummary(await store.processingStatus())}));
}catch(e){console.error(JSON.stringify({error:e.code??'OPERATION_FAILED'}));process.exitCode=1;}
