import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadRuntimeConfig,openReviewWorkspace,runtimeSummary} from '../../src/capture/runtime.mjs';
import {snapshot,temp} from './helpers.mjs';

async function fixture(t,overrides={}){
 const root=await temp(t),project=path.join(root,'project'),sessions=path.join(root,'sessions'),vault=path.join(root,'vault');
 await Promise.all([fs.mkdir(project),fs.mkdir(sessions),fs.mkdir(vault)]);
 const config={schema_version:1,data_dir:path.join(root,'capture-state'),project_roots:[project],
  codex:{sessions_dir:sessions,max_files:20},chatgpt:{thread_ids:['thread-1']},
  budget:{max_jobs:2,max_input_bytes:120000},preview:null,port:0,...overrides};
 const file=path.join(root,'runtime.json');await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
 return {root,project,sessions,vault,file,config};
}

test('strict private config loads without creating state and reports honest runtime boundaries',async t=>{
 const {file,config}=await fixture(t);const loaded=await loadRuntimeConfig(file);
 assert.deepEqual(loaded,config);await assert.rejects(fs.stat(config.data_dir),{code:'ENOENT'});
 assert.deepEqual(runtimeSummary(loaded),{
  cadence_days:10,scheduler_enabled:false,semantic_executor:'codex-assisted',jev:'not_connected',vault_write_enabled:false,
  codex:{coverage:'configured_project_roots',enabled:true,max_files:20},
  chatgpt:{coverage:'limited_tool_read_scope_only',configured_thread_ids:1,automatic_reading:false},
  budget:{max_jobs:2,max_input_bytes:120000,enforced_for_claims:true},preview_enabled:false,published_search_enabled:false
 });
});

test('config rejects unknown fields, invalid limits, unsafe file metadata and symlinks',async t=>{
 const {root,file,config}=await fixture(t);
 const rejects=async(value,code='CONFIG_INVALID')=>{await fs.writeFile(file,JSON.stringify(value),{mode:0o600});await assert.rejects(loadRuntimeConfig(file),{code});};
 await rejects({...config,extra:true});
 await rejects({...config,project_roots:[]});
 await rejects({...config,budget:{...config.budget,max_jobs:101}});
 await rejects({...config,codex:{...config.codex,extra:true}});
 await fs.chmod(file,0o644);await assert.rejects(loadRuntimeConfig(file),{code:'CONFIG_UNSAFE'});await fs.chmod(file,0o600);
 const link=path.join(root,'config-link.json');await fs.symlink(file,link);await assert.rejects(loadRuntimeConfig(link),{code:'CONFIG_UNSAFE'});
 const sourceLink=path.join(root,'sessions-link');await fs.symlink(config.codex.sessions_dir,sourceLink);
 await rejects({...config,codex:{...config.codex,sessions_dir:sourceLink}},'UNSAFE_PATH');
});

test('config rejects storage overlap with each other, repository, vault and source roots',async t=>{
 const {file,config,vault}=await fixture(t);
 async function rejects(value){await fs.writeFile(file,JSON.stringify(value),{mode:0o600});await assert.rejects(loadRuntimeConfig(file),{code:'UNSAFE_PATH'});}
 await rejects({...config,data_dir:path.join(config.project_roots[0],'state')});
 await rejects({...config,data_dir:path.resolve('.')});
 await rejects({...config,preview:{writer_data_dir:path.join(config.data_dir,'writer'),vault_root:vault,targets:[]}});
 await rejects({...config,preview:{writer_data_dir:path.join(vault,'writer'),vault_root:vault,targets:[]}});
});

test('workspace wires configured discovery, preview and fixed claim budgets only when explicitly called',async t=>{
 const {file,config,sessions,project,vault}=await fixture(t,{preview:null});
 const preview={writer_data_dir:path.join(path.dirname(config.data_dir),'writer-state'),vault_root:vault,targets:[]};
 await fs.writeFile(file,JSON.stringify({...config,preview}),{mode:0o600});const loaded=await loadRuntimeConfig(file);
 const ws=await openReviewWorkspace(loaded);assert.ok(ws.publisher);assert.equal((await ws.store.processingStatus()).queued,0);
 assert.equal((await ws.claimTopic(new Date('2026-09-21T00:00:00.000Z').toISOString())).status,'NO_WORK');
 const log=[{type:'session_meta',payload:{id:'t1',cwd:project}},{type:'response_item',payload:{type:'message',id:'m1',role:'user',content:[{type:'input_text',text:'仅在显式发现时读取'}]}}].map(JSON.stringify).join('\n')+'\n';
 await fs.writeFile(path.join(sessions,'one.jsonl'),log);
 assert.equal((await ws.refreshCodex()).queued,1);
 const claim=await ws.claimProcessing(new Date('2026-09-21T00:00:00.000Z').toISOString());assert.equal(claim.status,'CLAIMED');
 assert.equal(claim.input_bytes<=config.budget.max_input_bytes,true);
});

test('workspace accepts only explicitly configured ChatGPT thread observations',async t=>{
 const {file}=await fixture(t);const ws=await openReviewWorkspace(await loadRuntimeConfig(file)),allowed=snapshot();
 allowed.source={system:'chatgpt',scope:'account',conversation_id:'thread-1'};allowed.channel='web';allowed.messages[0].text_format='rendered_text';
 assert.equal((await ws.store.ingest(allowed)).status,'UPDATED');
 const outside=structuredClone(allowed);outside.source.conversation_id='thread-outside-config';
 await assert.rejects(ws.store.ingest(outside),{code:'SOURCE_SCOPE_MISMATCH'});
});

test('narrowing configured sources cannot disclose previously collected source content',async t=>{
 const {file,config}=await fixture(t);const ws=await openReviewWorkspace(await loadRuntimeConfig(file)),allowed=snapshot();
 allowed.source={system:'chatgpt',scope:'conversation:thread-1',conversation_id:'thread-1'};
 await ws.store.ingest(allowed);
 await fs.writeFile(file,JSON.stringify({...config,chatgpt:{thread_ids:[]}}));
 await assert.rejects(openReviewWorkspace(await loadRuntimeConfig(file)),{code:'SOURCE_SCOPE_MISMATCH'});
});

test('every live read and locked operation rechecks scope when another instance changes shared state',async t=>{
 const {file,config}=await fixture(t),narrow=await openReviewWorkspace(await loadRuntimeConfig(file));
 const broad=await openReviewWorkspace({...config,chatgpt:{thread_ids:['thread-1','outside']}}),outside=snapshot();
 outside.source={system:'chatgpt',scope:'conversation:outside',conversation_id:'outside'};
 await broad.store.ingest(outside);
 const before=await fs.readFile(config.data_dir+'/state.json');
 for(const action of [()=>narrow.store.recordCodexUsage({}),()=>narrow.store.view(),()=>narrow.store.processingStatus(),()=>narrow.store.actionView(),()=>narrow.store.actionSource({id:'unknown'}),()=>narrow.store.decideAction({id:'unknown'}),()=>narrow.claimProcessing('2026-09-28T00:00:00.000Z'),()=>narrow.claimTopic('2026-09-28T00:00:00.000Z'),()=>narrow.store.useCurrentTopic('unknown',()=>{})])
  await assert.rejects(action(),{code:'SOURCE_SCOPE_MISMATCH'});
 assert.deepEqual(await fs.readFile(config.data_dir+'/state.json'),before);
});

test('writing remains disabled unless an explicit valid save mode is configured',async t=>{
 const {file,config,vault,root}=await fixture(t);
 const preview={writer_data_dir:path.join(root,'writer'),vault_root:vault,targets:[]};
 await fs.writeFile(file,JSON.stringify({...config,preview,write_mode:'confirmed'}));
 const loaded=await loadRuntimeConfig(file);assert.equal(runtimeSummary(loaded).vault_write_enabled,true);
 assert.equal((await (await openReviewWorkspace(loaded)).publisher.list()).mode,'confirmed');
 await fs.writeFile(file,JSON.stringify({...config,preview,write_mode:'automatic'}));
 await assert.rejects(loadRuntimeConfig(file),{code:'CONFIG_INVALID'});
 await fs.writeFile(file,JSON.stringify({...config,write_mode:'confirmed'}));
 await assert.rejects(loadRuntimeConfig(file),{code:'CONFIG_INVALID'});
});
