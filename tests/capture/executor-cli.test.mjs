import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),script='scripts/offline-executor-demo.mjs';
const call=async args=>JSON.parse((await exec(process.execPath,[script,...args])).stdout);
test('offline demo source/topic command and recovery use persistent production store without model execution',async t=>{
 for(const kind of ['source','topic']){
  const r=await call([kind]);t.after(()=>fs.rm(r.directory,{recursive:true,force:true}));
  assert.equal(r.mode,'synthetic_offline');assert.equal(r.result.status,'COMPLETED');assert.equal(r.processing.usage.reported_turns,0);assert.equal(r.processing.usage.simulated_turns,1);
  const before=await fs.readFile(r.directory+'/capture/state.json');
  const recovered=await call(['recover','--config',r.config,'--input',r.recovery_file]);assert.equal(recovered.result.status,'NO_CHANGE');
  assert.deepEqual(await fs.readFile(r.directory+'/capture/state.json'),before);
  assert.ok(!JSON.stringify(r.processing).includes('离线测试原文'));
  for(const key of ['prompt','output','markdown'])assert.equal(Object.hasOwn(r.processing.executions[0],key),false);
 }
});
test('interrupted command recovery reuses result and exposes unresolved failures without a second dispatch',async t=>{
 const r=await call(['source','exit_after_usage']);t.after(()=>fs.rm(r.directory,{recursive:true,force:true}));assert.equal(r.result.status,'EXECUTION_ATTENTION');
 const recovered=await call(['recover','--config',r.config,'--input',r.recovery_file]);assert.equal(recovered.result.status,'COMPLETED');assert.equal(recovered.processing.window.jobs,1);assert.equal(recovered.processing.usage.simulated_turns,1);
});
test('demo CLI refuses live mode, executable overrides and arbitrary production configs before setup',async()=>{
 for(const args of [['live'],['source','--config','/private/runtime.json'],['source','success','--executable','/bin/echo']])await assert.rejects(exec(process.execPath,[script,...args]),e=>JSON.parse(e.stderr).error==='INPUT_INVALID');
});
