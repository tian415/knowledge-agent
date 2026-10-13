import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createProductDemo} from '../../src/capture/demo.mjs';

test('isolated product demo reuses production workflow for two sources, saved update and duplicate no-op',async t=>{
 const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));
 const status=await demo.store.processingStatus();assert.equal(status.completed,2);assert.equal(status.topics.length,1);assert.equal(status.topics[0].source_count,2);
 const first=status.topics[0],plan=await demo.publisher.prepare({topic_id:first.id});
 assert.equal(plan.changes[0].before,null);assert.equal((await fs.stat(demo.configFile)).mode&0o777,0o600);
 await demo.publisher.apply({topic_id:first.id,plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true});
 assert.equal((await demo.advance()).status,'UPDATED');
 const after=await demo.store.processingStatus();assert.notEqual(after.topics[0].id,first.id);
 const updated=await demo.publisher.prepare({topic_id:after.topics[0].id});assert.ok(updated.changes[0].before);assert.ok(updated.changes[0].after.includes('BOM'));
 const before=await fs.readFile(demo.config.data_dir+'/state.json');assert.equal((await demo.advance()).status,'NO_CHANGE');assert.deepEqual(await fs.readFile(demo.config.data_dir+'/state.json'),before);
 assert.equal(demo.runtime.demo,true);assert.equal(demo.runtime.semantic_executor,'simulated_demo');
});
