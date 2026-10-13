import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createProductDemo} from '../../src/capture/demo.mjs';
import {createKnowledgeWriter} from '../../src/apply/knowledge.mjs';
import {createReviewedImports} from '../../src/capture/reviewed-import.mjs';
import {createTopicPublisher} from '../../src/capture/topic-publish.mjs';
import {createPublishedSearch} from '../../src/capture/published-search.mjs';
import {openReviewWorkspace,loadRuntimeConfig} from '../../src/capture/runtime.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../../src/capture/model.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const d=await createProductDemo();t.after(()=>fs.rm(d.root,{recursive:true,force:true}));const state=await d.store.view(),topic=state.processing.topics.revisions.at(-1),plan=await d.publisher.prepare({topic_id:topic.id});await d.publisher.apply({topic_id:topic.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});
 const c=plan.changes[0],sources=topic.source_ids.map(id=>({id,kind:'conversation',snapshot:state.processing.jobs.find(j=>j.id===id).snapshot}));
 const manifest={version:1,batch_id:'reviewed-test',reviewed_at:new Date().toISOString(),sources,notes:[{id:'saved-test',project:topic.project,key:topic.key,title:topic.title,knowledge_layer:c.knowledge_layer,relative_path:c.relative_path,content_hash:hash(c.after),receipt:{kind:'writer',id:plan.id},evidence:topic.result.evidence.map(({job_id,...e})=>({source_id:job_id,...e})),source_summaries:sources.map(s=>({source_id:s.id,summary:'合成已审核来源'}))}]};
 d.config.reviewed_imports=[digest(manifest)];await fs.writeFile(d.configFile,JSON.stringify(d.config));const workspace=await openReviewWorkspace(await loadRuntimeConfig(d.configFile));
 const writer=await createKnowledgeWriter({dataDir:d.config.preview.writer_data_dir,vaultRoot:d.config.preview.vault_root});const imports=createReviewedImports({store:workspace.store,writer,vaultRoot:d.config.preview.vault_root,authorizedHashes:[digest(manifest)]});const preview=await imports.preview({manifest});
 const apply=()=>imports.apply({manifest,expected_review_hash:preview.review_hash,confirmed:true});return {...d,...workspace,topic,plan,manifest,imports,preview,apply};
}
test('reviewed saved import preserves source identity, bytes, budget and supports native search and replay',async t=>{
 const d=await fixture(t),before=await d.store.view(),file=d.config.preview.vault_root+'/'+d.plan.changes[0].relative_path,raw=await fs.readFile(file);
 assert.equal((await d.apply()).status,'IMPORTED');assert.equal((await d.apply()).status,'NO_CHANGE');const after=await d.store.view();assert.deepEqual(after.processing,before.processing);assert.deepEqual(after.sources,before.sources);assert.deepEqual(after.reviewed_imports[0].manifest.sources,d.manifest.sources);assert.deepEqual(await fs.readFile(file),raw);
 const search=createPublishedSearch({store:d.store,publisher:d.publisher,reviewedImports:d.imports,vaultRoot:d.config.preview.vault_root,runSearch:async({notes})=>({results:notes.map(n=>({file_path:n.id+'.md'}))})});const out=await search.search({query:'保真'});assert.equal(out.results.length,1);assert.equal(out.results[0].origin,'reviewed_saved_import');assert.equal(out.results[0].markdown,raw.toString());assert.ok(out.results[0].source_batch_id);
 await assert.rejects(d.publisher.prepare({topic_id:d.topic.id}),{code:'REVIEWED_SAVE_CONFLICT'});
 await assert.rejects(d.publisher.apply({topic_id:d.topic.id,plan_id:d.plan.id,expected_review_hash:d.plan.review_hash,confirmed:true}),{code:'REVIEWED_SAVE_CONFLICT'});
 await assert.rejects(d.publisher.rollback({plan_id:d.plan.id,expected_review_hash:d.plan.review_hash,confirmed:true}),{code:'REVIEWED_SAVE_CONFLICT'});
 const next=structuredClone(d.manifest.sources[0].snapshot);next.messages[0].text+='新上下文';await d.store.enqueueProcessing({snapshot:next,recipe:'test-new'});assert.equal((await search.search({query:'保真'})).results[0].status,'needs_review');
});
test('changed files, invalid quotes, forged receipts and missing approval fail before registration',async t=>{
 const d=await fixture(t),base=await d.store.view();await assert.rejects(d.imports.apply({manifest:d.manifest,expected_review_hash:d.preview.review_hash,confirmed:false}),{code:'CONFIRMATION_REQUIRED'});
 for(const change of [m=>m.notes[0].evidence[0].quote+='not present',m=>m.notes[0].receipt.id='00000000-0000-0000-0000-000000000000',m=>m.notes[0].relative_path='../escape.md']){const m=structuredClone(d.manifest);change(m);const imports=createReviewedImports({store:d.store,writer:await createKnowledgeWriter({dataDir:d.config.preview.writer_data_dir,vaultRoot:d.config.preview.vault_root}),vaultRoot:d.config.preview.vault_root,authorizedHashes:[digest(m)]});await assert.rejects(imports.preview({manifest:m}));}
 await fs.appendFile(d.config.preview.vault_root+'/'+d.plan.changes[0].relative_path,'人工新稿');await assert.rejects(d.apply(),{code:'SAVED_NOTE_CHANGED'});assert.deepEqual(await d.store.view(),base);
});
test('imports exclude changed saved files, reject stale previews and require exact batch authorization',async t=>{
 const d=await fixture(t);const no=createReviewedImports({store:d.store,writer:null,vaultRoot:d.config.preview.vault_root,authorizedHashes:[]});await assert.rejects(no.preview({manifest:d.manifest}),{code:'SOURCE_SCOPE_MISMATCH'});
 await d.advance();await assert.rejects(d.apply(),{code:'STALE_INPUT'});
 const preview=await d.imports.preview({manifest:d.manifest});await d.imports.apply({manifest:d.manifest,expected_review_hash:preview.review_hash,confirmed:true});await fs.appendFile(d.config.preview.vault_root+'/'+d.plan.changes[0].relative_path,'modified');const list=await d.imports.list();assert.equal(list.notes.length,0);assert.equal(list.excluded,1);
 const search=createPublishedSearch({store:d.store,publisher:d.publisher,reviewedImports:d.imports,vaultRoot:d.config.preview.vault_root,runSearch:async({notes})=>({results:notes.map(n=>({file_path:n.id+'.md'}))})});assert.equal((await search.search({query:'保真'})).indexed,0);
});

test('native CLI imports once, exposes exact sources and fails closed when authorization is revoked',async t=>{
 const d=await fixture(t),execute=promisify(execFile),input=d.root+'/input.json';
 const call=async(action,value)=>{const args=['scripts/knowledge-workspace.mjs',action,'--config',d.configFile];if(value){await fs.writeFile(input,JSON.stringify(value),{mode:0o600});args.push('--input',input);}return JSON.parse((await execute(process.execPath,args)).stdout);};
 const p=await call('saved-import-preview',{manifest:d.manifest});assert.equal(p.note_writes,0);
 assert.equal((await call('saved-import-apply',{manifest:d.manifest,expected_review_hash:p.review_hash,confirmed:true})).status,'IMPORTED');
 await assert.rejects(d.imports.apply({manifest:d.manifest,expected_review_hash:'fake',confirmed:true}),{code:'STALE_INPUT'});
 assert.equal((await call('saved-import-status')).batches.length,1);
 assert.deepEqual(await call('saved-import-source',{batch_id:d.manifest.batch_id,source_id:d.manifest.sources[0].id}),d.manifest.sources[0]);
 const config={...d.config,reviewed_imports:[]};await assert.rejects(openReviewWorkspace(config),{code:'SOURCE_SCOPE_MISMATCH'});
});
test('PK completed receipt binds exact bytes, digest and declared layer',async t=>{
 const d=await fixture(t),m=structuredClone(d.manifest),n=m.notes[0];n.receipt={kind:'pk',id:'00000000-0000-0000-0000-000000000001'};
 const after=await fs.readFile(d.config.preview.vault_root+'/'+n.relative_path,'utf8');const plan={operations:[{path:n.relative_path,after}],routes:[{relative_path:n.relative_path,knowledge_layer:n.knowledge_layer}]};
 const file=d.config.preview.vault_root+'/.project-knowledge/transactions/'+n.receipt.id+'.json';await fs.mkdir(d.config.preview.vault_root+'/.project-knowledge/transactions',{recursive:true});const receipt={id:n.receipt.id,status:'completed',plan:{...plan,digest:digest(plan)}};await fs.writeFile(file,JSON.stringify(receipt));
 const imports=createReviewedImports({store:d.store,writer:await createKnowledgeWriter({dataDir:d.config.preview.writer_data_dir,vaultRoot:d.config.preview.vault_root}),vaultRoot:d.config.preview.vault_root,authorizedHashes:[digest(m)]});assert.equal((await imports.preview({manifest:m})).notes.length,1);
 receipt.plan.operations[0].after+='tampered';await fs.writeFile(file,JSON.stringify(receipt));await assert.rejects(imports.preview({manifest:m}),{code:'RECEIPT_INVALID'});
});

test('rollback holds the capture lock through Writer and cannot race a reviewed import',async t=>{
 const d=await fixture(t),writer=await createKnowledgeWriter({dataDir:d.config.preview.writer_data_dir,vaultRoot:d.config.preview.vault_root});let checked=false;
 const publisher=await createTopicPublisher({store:d.store,writer:{...writer,async rollback(input){await assert.rejects(d.apply(),{code:'BUSY'});checked=true;return writer.rollback(input);}},vaultRoot:d.config.preview.vault_root,targets:d.config.preview.targets,mode:'confirmed'});
 await publisher.rollback({plan_id:d.plan.id,expected_review_hash:d.plan.review_hash,confirmed:true});assert.equal(checked,true);assert.equal((await d.store.view()).reviewed_imports,undefined);await assert.rejects(d.apply(),{code:'SAVED_NOTE_CHANGED'});
});
