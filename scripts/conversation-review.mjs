import fs from 'node:fs/promises';
import path from 'node:path';
import {openCaptureStore} from '../src/capture/store.mjs';
import {readCodexConversation} from '../src/capture/codex.mjs';
import {threadPagesToSnapshot} from '../src/capture/chatgpt-thread.mjs';
import {discoverCodex} from '../src/capture/discovery.mjs';
import {check} from '../src/capture/model.mjs';
const [action,...args]=process.argv.slice(2),options={};
try{
 check(['enqueue','status','claim','finish','read-codex','discover-codex','read-chatgpt','defer','topic-register','topic-claim','topic-finish','topic-defer','topic-correct','route-preview','route-register'].includes(action));
 for(let i=0;i<args.length;i+=2){check(['--data-dir','--input','--project-root','--file','--max-jobs','--max-input-bytes','--sessions-dir'].includes(args[i])&&args[i+1]&&!Object.hasOwn(options,args[i]));options[args[i]]=args[i+1];}
 check(options['--data-dir']&&path.isAbsolute(options['--data-dir']));
 const store=await openCaptureStore({dataDir:options['--data-dir'],protectedRoots:options['--project-root']?[options['--project-root']]:[]});
 async function input(){check(options['--input']&&path.isAbsolute(options['--input']));const stat=await fs.stat(options['--input']);check(stat.isFile()&&stat.size<=16*1024*1024,'INPUT_TOO_LARGE');return JSON.parse(await fs.readFile(options['--input'],'utf8'));}
 let result;
 if(action==='route-preview')result=await store.previewRoutes(await input());
 if(action==='route-register')result=await store.registerRoutes(await input());
 if(action==='read-chatgpt')result=await store.enqueueProcessing({snapshot:threadPagesToSnapshot({pages:await input(),capturedAt:new Date().toISOString()}),recipe:'knowledge-units-v2'});
 if(action==='topic-correct')result=await store.correctTopic(await input());
 if(action==='topic-register')result=await store.registerTopic(await input());
 if(action==='topic-finish')result=await store.finishTopic(await input());
 if(action==='topic-defer')result=await store.deferTopic(await input());
 if(action==='topic-claim')result=await store.claimTopic({now:new Date().toISOString(),...(options['--max-jobs']?{maxJobs:Number(options['--max-jobs'])}:{}),...(options['--max-input-bytes']?{maxInputBytes:Number(options['--max-input-bytes'])}:{})});
 if(action==='enqueue')result=await store.enqueueProcessing(await input());
 if(action==='defer')result=await store.deferProcessing(await input());
 if(action==='finish')result=await store.finishProcessing(await input());
 if(action==='status')result=await store.processingStatus();
 if(action==='claim')result=await store.claimProcessing({now:new Date().toISOString(),...(options['--max-jobs']?{maxJobs:Number(options['--max-jobs'])}:{}),...(options['--max-input-bytes']?{maxInputBytes:Number(options['--max-input-bytes'])}:{})});
 if(action==='discover-codex'){check(options['--sessions-dir']&&options['--project-root']);result=await discoverCodex({sessionsDir:options['--sessions-dir'],projectRoots:[options['--project-root']],store,now:new Date().toISOString()});}
 if(action==='read-codex'){
  check(options['--file']&&options['--project-root']&&path.isAbsolute(options['--project-root']));
  const snapshot=await readCodexConversation({file:options['--file'],projectRoots:[options['--project-root']],capturedAt:new Date().toISOString()});
  result=await store.enqueueProcessing({snapshot,recipe:'knowledge-units-v2'});
 }
 console.log(JSON.stringify(result));
}catch(e){console.error(JSON.stringify({error:e.code??'INPUT_INVALID'}));process.exitCode=1;}
