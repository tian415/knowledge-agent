import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function skillBundle(){
 const files=new Map();
 for(const name of ['cli','config','engine','files']){
  const content=await fs.readFile(path.join(root,'compat/project-knowledge/lib',name+'.mjs'),'utf8');
  files.set('scripts/lib/'+name+'.mjs',content.replaceAll("'../../../src/shared/","'../shared/"));
 }
 for(const name of ['knowledge-paths','knowledge-standard','source-reading'])files.set('scripts/shared/'+name+'.mjs',await fs.readFile(path.join(root,'src/shared',name+'.mjs'),'utf8'));
 for(const name of ['SKILL.md','references/contract.md','references/reading-layout.md'])files.set(name,await fs.readFile(path.join(root,'compat/project-knowledge',name),'utf8'));
 files.set('scripts/pk.mjs',"#!/usr/bin/env node\nimport {main} from './lib/cli.mjs';\nmain();\n");
 return files;
}
// Explicit installation only. The bundle is self-contained; private bindings and
// unrelated installed skill files are never copied, reset, or removed.
async function installBundle(destination,files){
 if(!path.isAbsolute(destination))throw new Error('Absolute destination required');
 for(let p=destination;p!=='/';p=path.dirname(p)){try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('Symbolic destination');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const backup=destination+'.backup-'+new Date().toISOString().replace(/[:.]/g,'-'),changed=[];
 const previous=new Map();
 for(const [rel,body] of files){const file=path.join(destination,rel);for(let p=file;p.startsWith(destination);p=path.dirname(p)){try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('Symbolic destination');}catch(e){if(e.code!=='ENOENT')throw e;}}
  let old=null;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}previous.set(rel,old);if(old===body)continue;
  if(old!==null){await fs.mkdir(path.dirname(path.join(backup,rel)),{recursive:true,mode:0o700});await fs.writeFile(path.join(backup,rel),old,{mode:0o600});}changed.push(rel);
 }
 for(const rel of changed){const file=path.join(destination,rel);let now=null;try{now=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(now!==previous.get(rel))throw new Error('Install conflict: '+rel);
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,files.get(rel),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}
 }
 for(const [rel,body] of files)if(sha(await fs.readFile(path.join(destination,rel)))!==sha(body))throw new Error('Install verification failed');
 return {destination,changed,backup:changed.some(rel=>previous.get(rel)!==null)?backup:null,files:Object.fromEntries([...files].map(([rel,body])=>[rel,sha(body)]))};
}
export async function installProjectKnowledge(destination){return installBundle(destination,await skillBundle());}
export async function installDailyBridge(destination){
 const files=new Map([['scripts/pk.mjs',"#!/usr/bin/env node\nimport {main} from '../../project-knowledge/scripts/lib/cli.mjs';\nmain();\n"],['SKILL.md',await fs.readFile(path.join(root,'compat/daily-dev-retrospective/SKILL.md'),'utf8')]]);
 for(const name of ['contract.md','reading-layout.md'])files.set('references/'+name,await fs.readFile(path.join(root,'compat/project-knowledge/references',name),'utf8'));
 return installBundle(destination,files);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]!=='--destination'||!process.argv[3])throw new Error('Use --destination /absolute/skill/path');
 const installer=process.argv[4]==='--daily-bridge'?installDailyBridge:installProjectKnowledge;
 console.log(JSON.stringify(await installer(path.resolve(process.argv[3])),null,2));
}
