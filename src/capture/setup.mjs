import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {protectedRootsFor} from '../../scripts/start-app.mjs';
import {loadRuntimeConfig} from './runtime.mjs';
import {VAULT_PATH} from '../registry/load-registry.mjs';
import {safeRelative} from '../shared/knowledge-paths.mjs';
import {check} from './model.mjs';
const inside=(a,b)=>b===a||b.startsWith(a+path.sep);

async function plainDirectory(value,{missing=false}={}){
 check(typeof value==='string'&&path.isAbsolute(value),'UNSAFE_PATH');
 const target=path.resolve(value);let current=path.parse(target).root;
 for(const part of target.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try{const s=await fs.lstat(current);check(s.isDirectory()&&!s.isSymbolicLink(),'UNSAFE_PATH');}
  catch(e){if(e.code==='ENOENT'&&missing&&current===target)return target;throw e;}
 }
 return target;
}

export async function initializeWorkspace({directory,projectRoots,sessionsDir=null,chatgptThreads=[],vaultRoot=null}){
 check(Array.isArray(projectRoots)&&projectRoots.length>0&&new Set(projectRoots).size===projectRoots.length,'CONFIG_INVALID');
 const root=await plainDirectory(directory,{missing:true});
 try{await fs.lstat(root);throw Object.assign(Error('WORKSPACE_EXISTS'),{code:'WORKSPACE_EXISTS'});}catch(e){if(e.code!=='ENOENT')throw e;}
 const projects=await Promise.all(projectRoots.map(p=>plainDirectory(p)));
 const sessions=sessionsDir?await plainDirectory(sessionsDir):null,vault=vaultRoot?await plainDirectory(vaultRoot):null;
 const protectedRoots=[...await protectedRootsFor(),VAULT_PATH,...projects,...(sessions?[sessions]:[]),...(vault?[vault]:[])].map(p=>path.resolve(p));
 check(!protectedRoots.some(p=>inside(p,root)||inside(root,p)),'UNSAFE_PATH');
 check(Array.isArray(chatgptThreads)&&chatgptThreads.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&new Set(chatgptThreads).size===chatgptThreads.length,'CONFIG_INVALID');
 await fs.mkdir(root,{mode:0o700});
 const notebook=vault??root+'/notebook';if(!vault)await fs.mkdir(notebook,{mode:0o700});
 const config={schema_version:1,data_dir:root+'/capture',project_roots:projects,codex:sessions?{sessions_dir:sessions,max_files:10000}:null,chatgpt:{thread_ids:chatgptThreads},budget:{max_jobs:3,max_input_bytes:120000},preview:{writer_data_dir:root+'/writer',vault_root:notebook,targets:[]},write_mode:'preview-only',port:3217};
 const file=root+'/runtime.json';await fs.writeFile(file,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
 await loadRuntimeConfig(file);
 return {status:'INITIALIZED',config:file,write_mode:'preview-only',sources_read:false};
}

export async function configureTarget({file,project,key,layer,relativePath}){
 const config=await loadRuntimeConfig(file);check(config.preview,'TARGET_REQUIRED');
 check([project,key].every(x=>typeof x==='string'&&x.length>0&&x.length<=256),'CONFIG_INVALID');
 try{safeRelative(relativePath,layer);}catch{check(false,'CONFIG_INVALID');}
 const target={project,key,knowledge_layer:layer,relative_path:relativePath};
 const lock=file+'.lock',stamp=randomUUID();let h;
 try{h=await fs.open(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch(e){if(e.code==='EEXIST')check(false,'BUSY');throw e;}
 let tmp;
 try{
  await h.writeFile(stamp);await h.sync();
  const current=await loadRuntimeConfig(file),original=await fs.readFile(file);
  const old=current.preview.targets.find(t=>t.project===project&&t.key===key);
  if(old&&JSON.stringify(old)===JSON.stringify(target))return {status:'NO_CHANGE'};
  check(!current.preview.targets.some(t=>(t.project!==project||t.key!==key)&&t.relative_path===relativePath),'TARGET_CONFLICT');
  // Moving a saved topic needs an explicit migration, not a configuration shortcut.
  check(!old,'TARGET_CONFLICT');
  current.preview.targets.push(target);
  tmp=path.join(path.dirname(file),'.runtime-'+randomUUID()+'.json');
  const out=await fs.open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await out.writeFile(JSON.stringify(current,null,2)+'\n');await out.sync();}finally{await out.close();}
  await loadRuntimeConfig(tmp);await loadRuntimeConfig(file);
  check((await fs.readFile(file)).equals(original),'CONFLICT');
  await fs.rename(tmp,file);tmp=null;
  const dir=await fs.open(path.dirname(file),constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
  return {status:'CONFIG_UPDATED',restart_required:true};
 }finally{
  await h.close();if(tmp)await fs.unlink(tmp);
  if(await fs.readFile(lock,'utf8')===stamp)await fs.unlink(lock);
 }
}

export async function runSetup(action,args){
 const flags={};
 const allowed=action==='init'?['--directory','--project-root','--sessions-dir','--chatgpt-thread','--vault-root']:['--config','--project','--key','--layer','--path'];
 for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];check(allowed.includes(name)&&typeof value==='string'&&value.length>0&&!value.startsWith('--'),'INPUT_INVALID');
  if(action==='init'&&['--project-root','--chatgpt-thread'].includes(name))(flags[name]??=[]).push(value);
  else{check(!Object.hasOwn(flags,name),'INPUT_INVALID');flags[name]=value;}
 }
 if(action==='init')return initializeWorkspace({directory:flags['--directory'],projectRoots:flags['--project-root'],sessionsDir:flags['--sessions-dir']??null,chatgptThreads:flags['--chatgpt-thread']??[],vaultRoot:flags['--vault-root']??null});
 return configureTarget({file:flags['--config'],project:flags['--project'],key:flags['--key'],layer:flags['--layer'],relativePath:flags['--path']});
}
