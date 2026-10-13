import path from 'node:path';
import fs from 'node:fs/promises';
import {createKnowledgeWriter} from '../src/apply/knowledge.mjs';
import {createTopicPublisher} from '../src/capture/topic-publish.mjs';
import {openCaptureStore} from '../src/capture/store.mjs';import {readCodexConversation} from '../src/capture/codex.mjs';import {createCaptureApp} from '../src/capture/server.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--data-dir','--project-root','--codex-file','--port','--preview-config'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Usage: --data-dir ABS --project-root ABS --codex-file ABS [--port N]');options[args[i]]=args[i+1];}
for(const key of ['--data-dir','--project-root','--codex-file'])if(!options[key]||!path.isAbsolute(options[key]))throw Error(key+' must be explicit and absolute');
const store=await openCaptureStore({dataDir:options['--data-dir'],protectedRoots:[options['--project-root']]});
let publisher;
if(options['--preview-config']){
 const config=JSON.parse(await fs.readFile(options['--preview-config'],'utf8'));
 const writer=await createKnowledgeWriter({dataDir:config.writer_data_dir,vaultRoot:config.vault_root});
 publisher=await createTopicPublisher({store,writer,vaultRoot:config.vault_root,targets:config.targets});
}
const app=await createCaptureApp({store,publisher,refreshCodex:async()=>store.ingest(await readCodexConversation({file:options['--codex-file'],projectRoots:[options['--project-root']],capturedAt:new Date().toISOString()}))});
console.log('Capture prototype: '+await app.listen(Number(options['--port']??0)));console.log('Private state: '+options['--data-dir']);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
