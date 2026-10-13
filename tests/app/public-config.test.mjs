import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const registry=new URL('../../src/registry/load-registry.mjs',import.meta.url).href;
const discovery=new URL('../../src/registry/discover-code-projects.mjs',import.meta.url).href;
const run=(vault,code,script)=>execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,KNOWLEDGE_AGENT_VAULT_ROOT:vault,KNOWLEDGE_AGENT_CODE_ROOT:code}});
test('public config uses explicit roots and diagnoses an absent Vault without creating it',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'public-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const vault=root+'/not-created',code=root+'/projects';
 const data=JSON.parse(run(vault,code,`import {VAULT_PATH,checkVaultPath} from ${JSON.stringify(registry)};import {CODE_ROOT} from ${JSON.stringify(discovery)};console.log(JSON.stringify({vault:VAULT_PATH,code:CODE_ROOT,warning:await checkVaultPath('01-项目沉淀/demo')}));`));
 assert.equal(data.vault,vault);assert.equal(data.code,code);assert.equal(data.warning.code,'PATH_MISSING');await assert.rejects(fs.stat(vault),{code:'ENOENT'});
});
test('missing-root diagnostics retain symlink and non-directory Vault protection',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'public-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(root+'/real');await fs.symlink(root+'/real',root+'/alias');await fs.writeFile(root+'/file','keep');
 for(const vault of [root+'/alias',root+'/file']){
  const out=run(vault,root+'/projects',`import {checkVaultPath} from ${JSON.stringify(registry)};try{await checkVaultPath('01-项目沉淀/demo');console.log('UNEXPECTED');}catch(e){console.log(e.message);}`);
  assert.match(out,/symlink rejected|must be a directory/);assert.doesNotMatch(out,/UNEXPECTED/);
 }
 assert.equal(await fs.readFile(root+'/file','utf8'),'keep');
});
