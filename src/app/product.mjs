import {createApp} from './server.mjs';
import {createCaptureApp} from '../capture/server.mjs';

// Shared Writer data directory means one lock and one history across both views.
// Each view may apply only its own kind of plan, preserving source checks.
export async function createProductApp({workspace,config,runtime,demoAdvance,loadRegistry}){
 const publisher=workspace.publisher?{...workspace.publisher,writeEnabled:config.write_mode==='confirmed'&&workspace.publisher.writeEnabled}:null;
 const captureApp=await createCaptureApp({...workspace,publisher,runtime,demoAdvance});
 if(!config.preview)return captureApp;
 return createApp({dataDir:config.preview.writer_data_dir,vaultRoot:config.preview.vault_root,
  captureApp,captureStore:workspace.store,materialProcessingEnabled:false,knowledgeWriteEnabled:config.write_mode==='confirmed',...(loadRegistry?{loadRegistry}:{}),mode:runtime.demo?'isolated-review':'review'});
}
