import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProductDemo} from '../src/capture/demo.mjs';
import {createPublishedSearch} from '../src/capture/published-search.mjs';

// Real local search engine; synthetic sources and disposable Vault only.
let demo;
try{
 const [flag,python,...extra]=process.argv.slice(2);
 if(flag!=='--python'||!python||!path.isAbsolute(python)||extra.length)throw Error('Use --python /absolute/venv/bin/python');
 demo=await createProductDemo();
 const search=createPublishedSearch({store:demo.store,publisher:demo.publisher,vaultRoot:demo.config.preview.vault_root,pythonExecutable:python});
 const publish=async()=>{
  const topic=(await demo.store.processingStatus()).topics[0];
  const plan=await demo.publisher.prepare({topic_id:topic.id});
  await demo.publisher.apply({topic_id:plan.topic_id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});return plan;
 };
 assert.equal((await search.search({query:'原文保真'})).results.length,0);
 const plan=await publish(),file=path.join(demo.config.preview.vault_root,plan.changes[0].relative_path),before=await fs.readFile(file);
 const current=await search.search({query:'原文保真'});
 assert.equal(current.results.length,1);assert.equal(current.results[0].status,'current');assert.deepEqual(await fs.readFile(file),before);
 await demo.advance();const stale=await search.search({query:'原文保真'});
 assert.equal(stale.results[0].status,'needs_review');assert.ok(!stale.results[0].markdown.includes('BOM'));
 const update=await publish(),updatedBytes=await fs.readFile(file);
 const updated=await search.search({query:'BOM'});
 assert.equal(updated.results.length,1);assert.equal(updated.results[0].status,'current');assert.ok(updated.results[0].markdown.includes('BOM'));assert.deepEqual(await fs.readFile(file),updatedBytes);
 await demo.publisher.rollback({plan_id:update.id,expected_review_hash:update.review_hash,confirmed:true});
 const restored=await search.search({query:'BOM'});assert.equal(restored.results.length,0);
 console.log(JSON.stringify({status:'PASS',engine:'basic-memory',data:'synthetic',checks:['draft-excluded','published-current','source-change-stale','published-update','rollback-removes-new-content','vault-bytes-unchanged']}));
}catch(error){console.error(JSON.stringify({status:'FAIL',error:error.code??error.message}));process.exitCode=1;}
finally{if(demo)await fs.rm(demo.root,{recursive:true,force:true});}
