import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {temp} from './helpers.mjs';
const exec=promisify(execFile),script='scripts/knowledge-workspace.mjs';

test('init creates a private local workspace without reading sources and target setup needs no JSON editing',async t=>{
 const root=await temp(t),project=root+'/project',sessions=root+'/sessions',workspace=root+'/workspace';await fs.mkdir(project);await fs.mkdir(sessions);
 await fs.writeFile(sessions+'/broken.jsonl','do not read during setup');
 const result=JSON.parse((await exec(process.execPath,[script,'init','--directory',workspace,'--project-root',project,'--sessions-dir',sessions,'--chatgpt-thread','chat-1'])).stdout);
 const file=result.config,config=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(config.write_mode,'preview-only');assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(workspace)).mode&0o777,0o700);
 await assert.rejects(fs.stat(config.data_dir+'/state.json'),{code:'ENOENT'});
 const prior=await fs.readFile(file);
 await assert.rejects(exec(process.execPath,[script,'init','--directory',workspace,'--project-root',project]),e=>JSON.parse(e.stderr).error==='WORKSPACE_EXISTS');
 assert.deepEqual(await fs.readFile(file),prior);
 const args=[script,'target','--config',file,'--project','p','--key','k','--layer','ENGINEERING_THINKING','--path','02-方法论/工程思维/原则.md'];
 assert.equal(JSON.parse((await exec(process.execPath,args)).stdout).status,'CONFIG_UPDATED');
 assert.equal(JSON.parse((await fs.readFile(file,'utf8'))).preview.targets.length,1);
 assert.equal(JSON.parse((await exec(process.execPath,args)).stdout).status,'NO_CHANGE');
 const saved=await fs.readFile(file);
 const unsafe=[...args];unsafe[unsafe.length-1]='../escape.md';await assert.rejects(exec(process.execPath,unsafe),e=>e.code===1);assert.deepEqual(await fs.readFile(file),saved);
 const overlap=root+'/project/runtime';await assert.rejects(exec(process.execPath,[script,'init','--directory',overlap,'--project-root',project]),e=>e.code===1);await assert.rejects(fs.stat(overlap),{code:'ENOENT'});
});
