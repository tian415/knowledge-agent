import fs from 'node:fs/promises';
import path from 'node:path';

const imageExtensions=new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif','.bmp']);
const privateDirectories=new Set(['.obsidian','.git','.trash','.project-knowledge','.knowledge-agent']);

function inside(root,target){const rel=path.relative(root,target);return rel===''||(!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel));}
function posix(value){return value.split(path.sep).join('/');}
function normalizeTarget(value){
 let target=String(value??'').trim();
 if(target.startsWith('<')&&target.endsWith('>'))target=target.slice(1,-1);
 target=target.replace(/\\([()\\ ])/gu,'$1');
 try{target=decodeURIComponent(target);}catch{}
 return target;
}
function parseLinks(text){
 const links=[];
 for(const match of text.matchAll(/!?\[\[([^\]]+)\]\]/gu)){
  const body=match[1].split('|',1)[0].trim();
  if(body)links.push({raw:body,target:body.split('#',1)[0],kind:'wiki',image:match[0].startsWith('!')});
 }
 // Parentheses are captured as a whole so ordinary destinations containing spaces work.
 for(const match of text.matchAll(/!?\[[^\]]*\]\(([^\n]*?)\)/gu)){
  let dest=match[1].trim();
  if(dest.startsWith('<')){const end=dest.indexOf('>');if(end>=0)dest=dest.slice(0,end+1);}
  else dest=dest.replace(/\s+["'][^"']*["']\s*$/u,'').trim();
  if(dest)links.push({raw:dest,target:dest,kind:'markdown',image:match[0].startsWith('!')});
 }
 return links;
}
function isExternal(target){return /^(?:https?:|mailto:|data:|tel:|\/\/)/iu.test(target);}
function isImage(target,image){return image||imageExtensions.has(path.extname(target).toLowerCase());}
function isIndexFile(rel){return /^00-.*\.md$/u.test(path.basename(rel));}
function sameResolved(a,b){return path.normalize(a)===path.normalize(b);}

async function walkMarkdown(root){
 const files=[],warnings=[];
 async function visit(dir){
  let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){warnings.push(`无法读取目录 ${posix(path.relative(root,dir))}: ${error.code??error.message}`);return;}
  for(const entry of entries){
   const full=path.join(dir,entry.name),rel=posix(path.relative(root,full));
   if(entry.isSymbolicLink()){warnings.push(`跳过符号链接 ${rel}`);continue;}
   if(entry.isDirectory()){if(entry.name.startsWith('.')||privateDirectories.has(entry.name))continue;await visit(full);continue;}
   if(entry.isFile()&&!entry.name.startsWith('.'))files.push(rel);
  }
 }
 await visit(root);return {files,markdownFiles:files.filter(rel=>path.extname(rel).toLowerCase()==='.md'),warnings};
}

async function inspectPath(root,relative){
 const normalized=path.normalize(relative),full=path.resolve(root,normalized);
 if(!inside(root,full))return {safe:false,exists:false,full,relative:posix(normalized),reason:'越界'};
 let current=root;
 for(const part of path.relative(root,full).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try{const stat=await fs.lstat(current);if(stat.isSymbolicLink())return {safe:false,exists:false,full,relative:posix(normalized),reason:'符号链接'};}
  catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return {safe:true,exists:false,full,relative:posix(normalized)};throw error;}
 }
 try{const stat=await fs.lstat(full);return {safe:true,exists:stat.isFile(),full,relative:posix(normalized)};}
 catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return {safe:true,exists:false,full,relative:posix(normalized)};throw error;}
}

function projectPrefix(relativePath){const parts=relativePath.split('/');return parts[0]==='01-项目沉淀'&&parts.length>=3?`${parts[0]}/${parts[1]}/`:null;}
function attachmentOwner(rel,project){
 if(project&&rel.startsWith(project))return 'project';
 if(rel.startsWith('附件/')||rel.includes('/通用知识/附件/')||rel.includes('/通用/附件/'))return 'general';
 return 'other';
}

/** Read-only link and index checks for a proposed merge. No content is changed. */
export async function inspectMergeLinks({vaultRoot,relativePath,before,after}){
 if(typeof vaultRoot!=='string'||!path.isAbsolute(vaultRoot))throw new TypeError('vaultRoot must be an absolute path');
 const root=path.resolve(vaultRoot),rootStat=await fs.lstat(root);
 if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Object.assign(new Error('Vault root must be a real directory'),{code:'INVALID_VAULT_ROOT'});
 const target=path.resolve(root,relativePath);
 if(!inside(root,target))throw Object.assign(new Error('Target path is outside vault'),{code:'PATH_OUTSIDE_VAULT'});
 const targetRel=posix(path.relative(root,target));
 const targetSafety=await inspectPath(root,targetRel);
 if(!targetSafety.safe)throw Object.assign(new Error(`Unsafe target path: ${targetSafety.reason}`),{code:'UNSAFE_TARGET_PATH'});

 const {files,markdownFiles,warnings}=await walkMarkdown(root),removed_links=[],missing_links=[],attachments=[],incoming_indexes=[];
 const prior=parseLinks(String(before??'')),next=parseLinks(String(after??''));
 const identity=link=>`${link.kind}:${normalizeTarget(link.target).split('#',1)[0]}`;
 const afterIdentities=new Set(next.map(identity));
 for(const link of prior)if(!afterIdentities.has(identity(link)))removed_links.push({kind:link.kind,target:link.target});

 const markdownByStem=new Map();
 for(const rel of markdownFiles){const stem=path.basename(rel,'.md').toLocaleLowerCase();markdownByStem.set(stem,[...(markdownByStem.get(stem)??[]),rel]);}
 const targetStem=path.basename(targetRel,'.md').toLocaleLowerCase();
 if(!(markdownByStem.get(targetStem)??[]).includes(targetRel))markdownByStem.set(targetStem,[...(markdownByStem.get(targetStem)??[]),targetRel]);
 const filesByName=new Map();
 for(const rel of files){const name=path.basename(rel).toLocaleLowerCase();filesByName.set(name,[...(filesByName.get(name)??[]),rel]);}
 const resolveLink=async(link,sourceRel)=>{
  let raw=normalizeTarget(link.target);
  if(isExternal(raw)||raw.startsWith('#'))return {external:true};
  raw=raw.split('#',1)[0];if(!raw)return {external:true};
  let candidate=link.kind==='wiki'
   ?path.resolve(root,raw.replace(/^\//u,''))
   :path.resolve(root,path.dirname(path.join(root,sourceRel)),raw);
  if(link.kind==='wiki'&&!path.extname(candidate))candidate+='.md';
  if(!inside(root,candidate))return {safe:false,exists:false,relative:raw,reason:'越界'};
  let resolved=await inspectPath(root,path.relative(root,candidate));
  if(!resolved.safe)return resolved;
  if(!resolved.exists&&link.kind==='wiki'){
   if(raw.includes('/')){
    // Obsidian links with a directory are normally vault-relative. Also accept
    // a short path relative to the current note directory, as used by project notes.
    let local=path.resolve(root,path.dirname(path.join(root,sourceRel)),raw);
    if(!path.extname(local))local+='.md';
    if(!inside(root,local))return {safe:false,exists:false,relative:raw,reason:'越界'};
    if(local!==candidate){const localInfo=await inspectPath(root,path.relative(root,local));if(!localInfo.safe)return localInfo;if(localInfo.exists)return localInfo;}
   }else{
    const basename=path.basename(raw).toLocaleLowerCase();
    const matches=path.extname(raw)?(filesByName.get(basename)??[]):(markdownByStem.get(basename.replace(/\.md$/iu,''))??[]);
    if(matches.length===1){const unique=await inspectPath(root,matches[0]);return unique;}
    if(matches.length>1){warnings.push(`Wiki 链接“${link.target}” basename 匹配到多个文件: ${matches.join(', ')}`);return {safe:true,exists:false,relative:raw,ambiguous:true};}
  }
  }
  return resolved;
 };

 for(const link of next){
  const resolved=await resolveLink(link,targetRel);
  if(resolved.external)continue;
  if(!resolved.safe){missing_links.push({target:link.target,safe:false,reason:resolved.reason});continue;}
  if(!resolved.exists){missing_links.push({target:link.target,safe:true,ambiguous:Boolean(resolved.ambiguous)});continue;}
  const dest=resolved.relative??posix(path.relative(root,resolved.full));
  if(isImage(link.target,link.image))attachments.push({path:dest,exists:true,owner:attachmentOwner(dest,projectPrefix(targetRel))});
 }

 for(const indexRel of markdownFiles.filter(isIndexFile)){
  const safety=await inspectPath(root,indexRel);if(!safety.safe||!safety.exists)continue;
  let content;try{content=await fs.readFile(safety.full,'utf8');}catch{continue;}
  const incoming=[];
  for(const link of parseLinks(content)){
   const raw=normalizeTarget(link.target);if(isExternal(raw)||raw.startsWith('#'))continue;
   const clean=raw.split('#',1)[0];if(!clean)continue;
   const candidates=[];
   if(link.kind==='wiki'){
    let rootCandidate=path.resolve(root,clean.replace(/^\//u,''));
    if(!path.extname(rootCandidate))rootCandidate+='.md';
    candidates.push(rootCandidate);
    if(clean.includes('/'))candidates.push(path.resolve(root,path.dirname(path.join(root,indexRel)),clean+(path.extname(clean)?'':'.md')));
    else{
     const matches=markdownByStem.get(path.basename(clean).replace(/\.md$/iu,'').toLocaleLowerCase())??[];
     if(matches.length===1)candidates.push(path.resolve(root,matches[0]));
     else if(matches.length>1)warnings.push(`索引中的 Wiki 链接“${link.target}” basename 匹配多个笔记，无法确认入链`);
    }
   }else candidates.push(path.resolve(root,path.dirname(path.join(root,indexRel)),clean));
   for(const candidate of candidates){
    if(!inside(root,candidate)||!sameResolved(candidate,target))continue;
    const resolved=await inspectPath(root,path.relative(root,candidate));
    if(resolved.safe){incoming.push({kind:link.kind,target:link.target});break;}
   }
  }
  if(incoming.length)incoming_indexes.push({path:indexRel,links:incoming});
 }
 return {removed_links,missing_links,attachments,incoming_indexes,warnings:[...new Set(warnings)]};
}
