import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {temp,now} from './helpers.mjs';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {discoverCodex} from '../../src/capture/discovery.mjs';
const log=(cwd,id='t1')=>[
 {type:'session_meta',payload:{id,cwd}},
 {type:'response_item',payload:{type:'message',id:'m1',role:'user',content:[{type:'input_text',text:'项目比较的目标是什么？'}]}},
 {type:'response_item',payload:{type:'message',id:'m2',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'比较采集与整理的职责。'}]}}
].map(x=>JSON.stringify(x)).join('\n')+'\n';
test('discovers scoped conversations automatically; rescans retain dedup and expose failures',async t=>{
 const root=await temp(t),sessions=root+'/sessions',store=await openCaptureStore({dataDir:root+'/state'});await fs.mkdir(sessions,{mode:0o700});
 await fs.writeFile(sessions+'/one.jsonl',log('/allowed'));
 await fs.writeFile(sessions+'/excluded.jsonl',log('/other','other'));
 const scan=()=>discoverCodex({sessionsDir:sessions,projectRoots:['/allowed'],store,now,maxFiles:100});
 let report=await scan();assert.equal(report.queued,1);assert.equal(report.excluded,1);assert.equal(report.complete,true);
 report=await scan();assert.equal(report.queued,0);assert.equal(report.unchanged,1);
 await fs.writeFile(sessions+'/broken.jsonl','not json\n');report=await scan();assert.equal(report.complete,false);assert.equal(report.errors.length,1);
 assert.equal((await store.processingStatus()).discovery.complete,false);
 await fs.writeFile(sessions+'/broken.jsonl',log('/allowed','repaired'));report=await scan();assert.equal(report.queued,1);assert.equal(report.complete,true);
});
test('file cap and symlinks are visible gaps, never silently completed',async t=>{
 const root=await temp(t),sessions=root+'/sessions',store=await openCaptureStore({dataDir:root+'/state'});await fs.mkdir(sessions,{mode:0o700});
 await fs.writeFile(sessions+'/one.jsonl',log('/allowed'));await fs.writeFile(sessions+'/two.jsonl',log('/allowed','t2'));
 let report=await discoverCodex({sessionsDir:sessions,projectRoots:['/allowed'],store,now,maxFiles:1});assert.equal(report.complete,false);assert.equal(report.limited,true);
 await fs.symlink(sessions+'/one.jsonl',sessions+'/link.jsonl');report=await discoverCodex({sessionsDir:sessions,projectRoots:['/allowed'],store,now});assert.equal(report.complete,false);assert.ok(report.errors.some(e=>e.code==='UNSAFE_PATH'));
});
test('automatic runs are counted as exclusions and invalidate old queued observations without deleting them',async t=>{
 const root=await temp(t),sessions=root+'/sessions',store=await openCaptureStore({dataDir:root+'/state'});await fs.mkdir(sessions);
 const file=sessions+'/one.jsonl';await fs.writeFile(file,log('/allowed'));
 const scan=()=>discoverCodex({sessionsDir:sessions,projectRoots:['/allowed'],store,now});
 assert.equal((await scan()).queued,1);
 const rows=log('/allowed').trimEnd().split('\n').map(JSON.parse);rows[0].payload.source='exec';
 await fs.writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
 const report=await scan();assert.equal(report.excluded,1);assert.equal(report.queued,0);assert.equal(report.blocked,0);
 assert.equal((await store.claimProcessing({now})).status,'NO_WORK');
 assert.equal((await store.view()).processing.jobs.length,2);
});
