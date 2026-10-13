import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processMaterial } from '../../src/intake/process-material.mjs';
const cli=fileURLToPath(new URL('../../scripts/material-intake.mjs',import.meta.url));
const input={raw_content:'User: 原始材料\r\n',source_type:'text'};
function run(args,stdin){return spawnSync(process.execPath,[cli,...args],{input:stdin,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME},timeout:5000});}
test('help works without keys or material; invalid arguments return Markdown ERROR',()=>{
 const help=run(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/file/);assert.match(help.stdout,/DeepSeek/);
 for(const args of [[],['--stdin','--file','x','--data-dir','/x'],['--apply'],['--stdin','--data-dir'],['--stdin','--data-dir','/x','--unknown']]){
  const r=run(args,'data');assert.equal(r.status,1);assert.match(r.stdout,/ERROR/);assert.ok(!r.stderr.includes('Error:'));
 }
});
test('CLI file and stdin use cached NO_CHANGE without key or Registry; UTF8 failure is explicit',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath('/tmp'),'intake-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'state'),file=path.join(root,'raw.txt');await fs.writeFile(file,input.raw_content);
 const seeded=await processMaterial(input,{dataDir,loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]}),organize:async()=>({output:{knowledge_candidates:[],action_candidates:[]},metrics:{llm_requests:1,sdk_turns:0,input_bytes:10,elapsed_ms:1,usage:null,underlying_model_requests:null}})});
 assert.equal(seeded.status,'NEW');
 for(const [args,stdin] of [[['--file',file],undefined],[['--stdin'],input.raw_content]]){
  const r=run([...args,'--data-dir',dataDir],stdin);assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/NO_CHANGE/);assert.match(r.stdout,/llm_requests: 0/);assert.match(r.stdout,/无新增候选/);
 }
 const invalid=run(['--stdin','--data-dir',dataDir],Buffer.from([0xff]));assert.equal(invalid.status,1);assert.match(invalid.stdout,/INPUT_INVALID/);
});
