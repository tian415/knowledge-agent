import path from 'node:path';
import {loadRuntimeConfig,openReviewWorkspace,runtimeSummary,processingSummary,readReviewInput} from '../src/capture/runtime.mjs';
import {createProductApp} from '../src/app/product.mjs';
import {fail} from '../src/capture/model.mjs';
import {runSetup} from '../src/capture/setup.mjs';

const inputActions={'saved-import-preview':null,'saved-import-apply':null,'saved-import-source':null,'topic-save':null,'topic-restore':null,'topic-preview':null,'topic-merge-preview':null,'route-preview':null,'route-register':null,'finish':'finishProcessing','defer':'deferProcessing','topic-register':'registerTopic','topic-finish':'finishTopic','topic-defer':'deferTopic','topic-correct':'correctTopic','read-chatgpt':null,'search':null,'topic-adoption-preview':null};
function parse(argv){
 const [action,flag,file,inputFlag,inputFile,...rest]=argv;
 if(!['doctor','serve','discover','status','saved-import-status','claim','topic-claim',...Object.keys(inputActions)].includes(action))throw fail('ACTION_REQUIRED');
 if(flag!=='--config'||typeof file!=='string'||!path.isAbsolute(file))throw fail('CONFIG_PATH_REQUIRED');
 if(Object.hasOwn(inputActions,action)){
  if(inputFlag!=='--input'||typeof inputFile!=='string'||!path.isAbsolute(inputFile)||rest.length)throw fail('INPUT_PATH_REQUIRED');
 }else if(inputFlag!==undefined&&!(action==='status'&&inputFlag==='--summary'&&inputFile===undefined&&rest.length===0))throw fail('INPUT_INVALID');
 return {action,file,inputFile,summary:action==='status'&&inputFlag==='--summary'};
}

try{
 if(['init','target'].includes(process.argv[2])){
  console.log(JSON.stringify(await runSetup(process.argv[2],process.argv.slice(3))));
 }else{
 const {action,file,inputFile,summary}=parse(process.argv.slice(2)),config=await loadRuntimeConfig(file),runtime=runtimeSummary(config);
 const input=inputFile?await readReviewInput(inputFile):null;
 if(action==='doctor')console.log(JSON.stringify({status:'READY',runtime}));
 else {
  const workspace=await openReviewWorkspace(config);let result;
  if(action==='discover')result=await workspace.refreshCodex();
  if(action==='status'){
   const processing=await workspace.store.processingStatus();
   const imported=workspace.reviewedImports?await workspace.reviewedImports.status():null;
   result={...(imported?.batches.length?{reviewed_imports:{batches:imported.batches.length,notes:imported.batches.reduce((n,b)=>n+b.notes.length,0),sources:imported.batches.reduce((n,b)=>n+b.sources,0),origin:imported.origin,model_claims:0}}:{}),...(summary?{mode:'summary'}:{}),runtime,processing:summary?processingSummary(processing):processing};
  }
  if(action==='claim')result=await workspace.claimProcessing(new Date().toISOString());
  if(action==='topic-claim')result=await workspace.claimTopic(new Date().toISOString());
  if(action.startsWith('saved-import-')){if(!workspace.reviewedImports)throw fail('TARGET_REQUIRED');result=await workspace.reviewedImports[{'saved-import-preview':'preview','saved-import-apply':'apply','saved-import-source':'source','saved-import-status':'status'}[action]](input);}
  else if(action==='read-chatgpt')result=await workspace.readChatgpt(input);
  else if(action==='route-preview'){if(!config.preview)throw fail('TARGET_REQUIRED');result=await workspace.store.previewRoutes({...input,targets:config.preview.targets});}
  else if(action==='route-register'){if(!config.preview)throw fail('TARGET_REQUIRED');result=await workspace.store.registerRoutes({...input,targets:config.preview.targets});}
  else if(action==='search'){if(!workspace.publishedSearch)throw fail('SEARCH_UNAVAILABLE');result=await workspace.publishedSearch.search(input);}
  else if(['topic-save','topic-restore','topic-preview'].includes(action)){if(!workspace.publisher)throw fail('TARGET_REQUIRED');result=await workspace.publisher[{'topic-save':'apply','topic-restore':'rollback','topic-preview':'prepare'}[action]](input);}
  else if(action==='topic-merge-preview'){if(!workspace.publisher)throw fail('TARGET_REQUIRED');result=await workspace.publisher.prepareMerge(input);}
  else if(action==='topic-adoption-preview'){if(!workspace.publisher)throw fail('TARGET_REQUIRED');result=await workspace.publisher.prepareAdoption(input);}
  else if(Object.hasOwn(inputActions,action))result=await workspace.store[inputActions[action]](input);
  if(action==='serve'){
   const app=await createProductApp({workspace,config,runtime});
   const url=await app.listen(config.port);console.log(JSON.stringify({status:'SERVING',url,home:config.preview?url+'/capture/':url,runtime}));
   for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
  }else console.log(JSON.stringify(result));
 }
 }
}catch(error){console.error(JSON.stringify({error:error?.code??'OPERATION_FAILED'}));process.exitCode=1;}
