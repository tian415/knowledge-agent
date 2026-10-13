import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Codex} from '@openai/codex-sdk';
import {validateExecutionSettings} from './execution-state.mjs';
import {fail} from './model.mjs';
export async function* offlineEvents(execution){
 validateExecutionSettings(execution.settings);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'knowledge-offline-sdk-'));
 const child=new URL('./offline-child.mjs',import.meta.url).href;
 const executable=path.join(root,'emitter.mjs');
 const controller=new AbortController();let expired=false,timer;
 try{
  // Absolute local Node and bundled source only; no user-supplied executable/env.
  await fs.writeFile(executable,`#!${process.execPath}\nimport ${JSON.stringify(child)};\n`,{mode:0o700});
  const codex=new Codex({codexPathOverride:executable,env:{}});
  const thread=codex.startThread();
  timer=setTimeout(()=>{expired=true;controller.abort();},execution.settings.timeout_ms);
  const stream=await thread.runStreamed(JSON.stringify({prompt:execution.prompt,scenario:execution.settings.scenario}),{signal:controller.signal});
  for await(const event of stream.events)yield event;
 }catch(error){if(expired)throw fail('EXECUTION_TIMEOUT');throw error;}
 // SDK iterator cleanup already kills its child and removes listeners. Aborting
 // again here can emit an unhandled AbortError after those listeners are gone.
 finally{clearTimeout(timer);await fs.rm(root,{recursive:true,force:true});}
}
