import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {temp,snapshot} from './helpers.mjs';
const exec=promisify(execFile);
test('CLI hands full source to Codex only on claim and persists completed result',async t=>{
 const root=await temp(t),dataDir=root+'/private',input=root+'/input.json',finish=root+'/finish.json';
 await fs.writeFile(input,JSON.stringify({snapshot:snapshot(),recipe:'v1'}));
 const run=async(action,extra=[])=>JSON.parse((await exec(process.execPath,['scripts/conversation-review.mjs',action,'--data-dir',dataDir,...extra])).stdout);
 assert.equal((await run('enqueue',['--input',input])).status,'QUEUED');
 assert.ok(!JSON.stringify(await run('status')).includes(snapshot().messages[0].text));
 const task=await run('claim');assert.equal(task.status,'CLAIMED');
 const ref={message_id:'m1',quote:snapshot().messages[0].text};
 await fs.writeFile(finish,JSON.stringify({id:task.job.id,attempt:task.job.attempt,result:{decision:'no_value',markdown:'',reason:'仅为测试，无新增知识',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null}}));
 assert.equal((await run('finish',['--input',finish])).status,'COMPLETED');
 await run('enqueue',['--input',input]);assert.equal((await run('claim')).status,'NO_WORK');
});
