import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createProductDemo} from '../../src/capture/demo.mjs';
import {createPublishedSearch} from '../../src/capture/published-search.mjs';
import {createCaptureApp} from '../../src/capture/server.mjs';
import {loadRuntimeConfig,openReviewWorkspace,runtimeSummary} from '../../src/capture/runtime.mjs';

async function fixture(t,runSearch){
 const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));
 const search=createPublishedSearch({store:demo.store,publisher:demo.publisher,vaultRoot:demo.config.preview.vault_root,pythonExecutable:'/test/python',runSearch});
 const topic=(await demo.store.processingStatus()).topics[0];
 const publish=async()=>{const plan=await demo.publisher.prepare({topic_id:(await demo.store.processingStatus()).topics[0].id});await demo.publisher.apply({topic_id:plan.topic_id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});return plan;};
 return {...demo,search,publish,topic};
}
const matches=async({notes})=>({results:notes.map(n=>({file_path:n.id+'.md'}))});
test('search indexes only published authorized notes and leaves source files and ledger unchanged',async t=>{
 let seen;const d=await fixture(t,async input=>{seen=input;return matches(input);});
 assert.equal((await d.search.search({query:'保真'})).results.length,0);assert.equal(seen,undefined);
 const plan=await d.publish(),file=d.config.preview.vault_root+'/'+plan.changes[0].relative_path;
 await fs.writeFile(d.config.preview.vault_root+'/private.md','not an authorized published topic');
 const original=await fs.readFile(file),ledger=await fs.readFile(d.config.data_dir+'/state.json');
 const result=await d.search.search({query:'保真'});
 assert.equal(result.results.length,1);assert.equal(seen.notes.length,1);
 assert.equal(result.results[0].status,'current');assert.ok(result.results[0].markdown.includes('message_hash='));
 assert.deepEqual(await fs.readFile(file),original);assert.deepEqual(await fs.readFile(d.config.data_dir+'/state.json'),ledger);
});
test('published old versions remain explicitly stale; rollback removes them; drafts never replace search truth',async t=>{
 const d=await fixture(t,matches),plan=await d.publish();await d.advance();
 const old=await d.search.search({query:'保真'});assert.equal(old.results[0].status,'needs_review');assert.ok(!old.results[0].markdown.includes('BOM'));
 await d.publisher.rollback({plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});
 assert.equal((await d.search.search({query:'保真'})).results.length,0);
});
test('manual notes are preserved and marked; altered managed blocks are not falsely trusted',async t=>{
 const d=await fixture(t,matches),plan=await d.publish(),file=d.config.preview.vault_root+'/'+plan.changes[0].relative_path;
 await fs.appendFile(file,'\n我的补充\r\n');let r=await d.search.search({query:'补充'});
 assert.equal(r.results[0].manual_changes,true);assert.ok(r.results[0].markdown.endsWith('我的补充\r\n'));
 await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('原始对话用于追溯','人工改变受管理内容'));
 r=await d.search.search({query:'保真'});assert.equal(r.results.length,0);assert.equal(r.excluded,1);
});
test('backend cannot return external files or stale results after a source change',async t=>{
 const d=await fixture(t,async input=>{await d.advance();return matches(input);});await d.publish();
 await assert.rejects(d.search.search({query:'保真'}),{code:'STALE_INPUT'});
 const other=await fixture(t,async()=>({results:[{file_path:'../../private.md',content:'untrusted'}]}));await other.publish();
 assert.equal((await other.search.search({query:'保真'})).results.length,0);
});
test('input and symlink boundaries fail closed, and source authorization is rechecked',async t=>{
 const d=await fixture(t,matches);
 for(const input of [{query:''},{query:'x',path:'/tmp/other'},{query:'x'.repeat(201)}])await assert.rejects(d.search.search(input),{code:'INPUT_INVALID'});
 const plan=await d.publish(),file=d.config.preview.vault_root+'/'+plan.changes[0].relative_path;
 const saved=await fs.readFile(file);await fs.writeFile(d.root+'/outside.md',saved);await fs.unlink(file);await fs.symlink(d.root+'/outside.md',file);
 await assert.rejects(d.search.search({query:'保真'}),{code:'UNSAFE_PATH'});
 const locked=createPublishedSearch({store:{processingStatus:async()=>{throw Object.assign(Error(),{code:'SOURCE_SCOPE_MISMATCH'});}},publisher:d.publisher,vaultRoot:d.config.preview.vault_root,runSearch:matches});
 await assert.rejects(locked.search({query:'保真'}),{code:'SOURCE_SCOPE_MISMATCH'});
});
test('search route requires session authorization and stays absent when disabled',async t=>{
 const d=await fixture(t,matches);await d.publish();
 const app=await createCaptureApp({store:d.store,publishedSearch:d.search});const url=await app.listen(0);t.after(()=>app.close());
 const post=token=>fetch(url+'/api/published-search',{method:'POST',headers:{origin:url,'content-type':'application/json','x-app-token':token},body:JSON.stringify({query:'保真'})});
 assert.equal((await post('invalid')).status,403);assert.equal((await post(app.token)).status,200);
 const disabled=await createCaptureApp({store:d.store});const other=await disabled.listen(0);t.after(()=>disabled.close());
 assert.equal((await fetch(other+'/api/published-search',{method:'POST',headers:{origin:other,'content-type':'application/json','x-app-token':disabled.token},body:'{"query":"保真"}'})).status,404);
});
test('runtime search is opt-in, requires a local executable and a publishing scope',async t=>{
 const d=await fixture(t,matches);assert.equal(runtimeSummary(d.config).published_search_enabled,false);
 let raw=JSON.parse(await fs.readFile(d.configFile));raw.search={python_executable:process.execPath};
 await fs.writeFile(d.configFile,JSON.stringify(raw));const config=await loadRuntimeConfig(d.configFile);
 assert.equal(runtimeSummary(config).published_search_enabled,true);assert.ok((await openReviewWorkspace(config)).publishedSearch);
 for(const invalid of [{python_executable:'relative'},{python_executable:process.execPath,remote:true}]){
  raw.search=invalid;await fs.writeFile(d.configFile,JSON.stringify(raw));await assert.rejects(loadRuntimeConfig(d.configFile),{code:'CONFIG_INVALID'});
 }
});
