import {inspectMergeLinks} from './merge-links.mjs';
import {renderSourceSummaries,readingBody} from '../shared/source-reading.mjs';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const contentHash=s=>createHash('sha256').update(s).digest('hex');
import path from 'node:path';
import os from 'node:os';
import {check,messageHash} from './model.mjs';
import {knowledgeReviewHash} from '../apply/knowledge.mjs';
import {managedTopicKey,replaceManagedTopic,adoptManagedTopic} from '../apply/managed-topic.mjs';
import {safeRelative} from '../shared/knowledge-paths.mjs';

const escapeHtml=value=>String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const sourceTitle=source=>/^[a-f0-9-]{36}$/u.test(source.title)?'项目讨论':source.title;
function sourceLink(url){
 try{const parsed=new URL(url);return ['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password?` · <a href="${escapeHtml(parsed.href)}">打开原对话</a>`:'';}catch{return '';}
}
function legacyReadingContent(topic,sources){
 const groups=[];
 for(const {id,snapshot:source} of sources){
  const refs=topic.result.evidence.filter(ref=>ref.job_id===id);if(!refs.length)continue;
  const quotes=refs.map(ref=>{
   const message=source.messages.find(m=>m.id===ref.message_id);
   const label=(message.role==='user'?'用户':'助手')+(message.source_time?' · '+message.source_time.slice(0,10):'');
   // Keep exact version locators in the Markdown, hidden from normal reading.
   const locator=`<!-- source-ref ${id} message_id=${encodeURIComponent(ref.message_id)} message_hash=${messageHash(message)} -->`;
   return `<p><strong>${label}</strong></p>\n<blockquote><p>${escapeHtml(ref.quote).replace(/\n/gu,'<br>')}</p></blockquote>\n${locator}`;
  }).join('\n');
  const coverage=source.completeness==='complete'?'来源声明完整':'仅包含已读取的部分对话';
  groups.push(`<p><strong>${source.source.system==='chatgpt'?'ChatGPT':'Codex'} · ${escapeHtml(sourceTitle(source))}</strong>${sourceLink(source.url)}</p>\n<p>${coverage}</p>\n${quotes}`);
 }
 return topic.result.markdown.trimEnd()+`\n\n<details>\n<summary>查看来源（${groups.length} 段对话，${topic.result.evidence.length} 处引用）</summary>\n${groups.join('\n')}\n</details>\n`;
}

function previousReadingContent(topic,sources){
 const groups=[],locators=[];
 for(const {id,snapshot:source} of sources){
  const refs=topic.result.evidence.filter(ref=>ref.job_id===id);if(!refs.length)continue;
  const dates=[...new Set(refs.map(ref=>source.messages.find(m=>m.id===ref.message_id)?.source_time?.slice(0,10)).filter(Boolean))].sort();
  const date=dates.length?' · '+dates[0]+(dates.at(-1)!==dates[0]?'—'+dates.at(-1):''):'';
  const summary=topic.result.source_summaries?.find(s=>s.job_id===id)?.summary??'本主题的讨论依据；结论状态与适用边界见正文。';
  groups.push(`<p><strong>${source.source.system==='chatgpt'?'ChatGPT':'Codex'} · ${escapeHtml(sourceTitle(source))}</strong>${date}${sourceLink(source.url)}</p>\n<p>${escapeHtml(summary)}</p>`+(source.completeness==='partial'?'<p>依据已读取内容整理。</p>':''));
  for(const ref of refs){const m=source.messages.find(m=>m.id===ref.message_id);locators.push(`<!-- source-ref ${id} message_id=${encodeURIComponent(ref.message_id)} message_hash=${messageHash(m)} -->`);}
 }
 return topic.result.markdown.trimEnd()+`\n\n<details>\n<summary>来源（${groups.length} 段对话）</summary>\n${groups.join('\n')}\n</details>\n<!-- 核验记录：逐字依据保留在知识中心来源账本；以下为版本定位。 -->\n${locators.join('\n')}\n`;
}

export function readingContent(topic,sources,options={}){
 const {relativePath,fileTitle=relativePath?path.posix.basename(relativePath,'.md'):topic.title,includeTitle=false}=typeof options==='string'?{relativePath:options}:options;
 const summaries=[],locators=[];
 for(const {id,snapshot:source} of sources){
  const refs=topic.result.evidence.filter(ref=>ref.job_id===id);if(!refs.length)continue;
  summaries.push({id,title:source.title,system:source.source.system==='chatgpt'?'ChatGPT':'Codex',url:source.url,dates:refs.map(ref=>source.messages.find(m=>m.id===ref.message_id)?.source_time?.slice(0,10)),summary:topic.result.source_summaries?.find(s=>s.job_id===id)?.summary,partial:source.completeness==='partial'});
  for(const ref of refs){const m=source.messages.find(m=>m.id===ref.message_id);locators.push(`<!-- source-ref ${id} message_id=${encodeURIComponent(ref.message_id)} message_hash=${messageHash(m)} -->`);}
 }
 return (includeTitle?topic.result.markdown.trimEnd():readingBody(topic.result.markdown,fileTitle))+'\n\n'+renderSourceSummaries(summaries)+'\n<!-- 核验记录：逐字依据保留在知识中心来源账本；以下为版本定位。 -->\n'+locators.join('\n')+'\n';
}

export async function createTopicPublisher({store,writer,vaultRoot,mode='preview-only',targets}){
 check(['preview-only','isolated','confirmed'].includes(mode));
 const vault=await fs.realpath(vaultRoot),tmp=await fs.realpath(os.tmpdir());
 const isolated=()=>vault.startsWith('/private/tmp/')||vault.startsWith(tmp+path.sep);
 check(mode!=='isolated'||isolated(),'REAL_WRITE_DISABLED');
 check(Array.isArray(targets));
 const mappings=structuredClone(targets);
 for(const t of mappings){safeRelative(t.relative_path,t.knowledge_layer);check(mappings.filter(x=>x.project===t.project&&x.key===t.key).length===1);}
 function change(topic,sources,{format='reading'}={}){
  const target=mappings.find(t=>t.project===topic.project&&t.key===topic.key);check(target,'TARGET_REQUIRED');
  if(topic.routing)check(target.knowledge_layer===topic.routing.knowledge_layer,'ROUTE_MISMATCH');
  check(topic.result.kind!=='project'||target.knowledge_layer==='PROJECT_KNOWLEDGE','PLAN_MISMATCH');
  const evidence=topic.result.evidence.map(ref=>{
   const source=sources.find(j=>j.id===ref.job_id).snapshot;
   const title=/^[a-f0-9-]{36}$/u.test(source.title)?'项目讨论':source.title;
   const locator=format==='legacy'?'':`\n\n来源定位：${ref.job_id} · message_id=${ref.message_id} · message_hash=${messageHash(source.messages.find(m=>m.id===ref.message_id))}`;
   return `### ${source.source.system==='chatgpt'?'ChatGPT':'Codex'} · ${title}\n\n${ref.quote.split('\n').map(line=>'> '+line).join('\n')}${locator}`;
  }).join('\n\n');
  return {operation:'managed-topic',managed_key:managedTopicKey(topic.project,topic.key),knowledge_layer:target.knowledge_layer,relative_path:target.relative_path,candidate_ids:[topic.id],content:format==='reading'?readingContent(topic,sources,{fileTitle:path.posix.basename(target.relative_path,'.md')}):format==='reading-v3'?readingContent(topic,sources,{includeTitle:true}):format==='reading-v2'?previousReadingContent(topic,sources):format==='reading-v1'?legacyReadingContent(topic,sources):topic.result.markdown.trimEnd()+'\n\n## 整理依据\n\n'+topic.result.contribution+'\n\n'+evidence+'\n'};
 }
 async function protectSaved(relative){const imports=await store.reviewedImports?.()??[];check(!imports.some(r=>r.manifest.notes.some(n=>n.relative_path===relative)),'REVIEWED_SAVE_CONFLICT');}
 const sameBase=(actual,expected)=>actual.relative_path===expected.relative_path&&actual.knowledge_layer===expected.knowledge_layer&&actual.content===expected.content&&JSON.stringify(actual.candidate_ids)===JSON.stringify(expected.candidate_ids);
 function recognized(plan){
  if(!plan.material_id?.startsWith('topicrev_')||plan.changes?.length!==1)return false;
  const actual=plan.changes[0],target=mappings.find(t=>t.relative_path===actual.relative_path&&t.knowledge_layer===actual.knowledge_layer);
  if(!target||JSON.stringify(actual.candidate_ids)!==JSON.stringify([plan.material_id])||typeof actual.content!=='string')return false;
  if(actual.operation==='reviewed-merge')return actual.before!==null&&actual.expected_before_hash===contentHash(actual.before)&&actual.after===actual.content&&typeof actual.source_content_hash==='string';
  if(['managed-topic','managed-topic-adopt'].includes(actual.operation)){
   if(actual.managed_key!==managedTopicKey(target.project,target.key))return false;
   try{return actual.after===(actual.operation==='managed-topic-adopt'?adoptManagedTopic:replaceManagedTopic)(actual.before,actual.managed_key,actual.content);}catch{return false;}
  }
  return actual.operation===undefined&&actual.managed_key===undefined&&actual.before===null&&actual.after===actual.content;
 }
 async function bind(plan,topic,sources,{history=false}={}){
  const c=change(topic,sources);
  check(plan.vault_root===vault&&plan.material_id===topic.id&&plan.changes.length===1,'PLAN_MISMATCH');
  const actual=plan.changes[0];
  if(actual.operation==='reviewed-merge'){
   check(actual.relative_path===c.relative_path&&actual.knowledge_layer===c.knowledge_layer&&JSON.stringify(actual.candidate_ids)===JSON.stringify(c.candidate_ids)&&actual.source_content_hash===contentHash(c.content)&&actual.before!==null&&actual.expected_before_hash===contentHash(actual.before)&&actual.after===actual.content,'PLAN_MISMATCH');
  }else if(actual.operation==='managed-topic-adopt'){
   const receipt=(await writer.list()).find(p=>p.id===actual.source_plan_id),old=receipt?.changes?.[0];
   check(receipt?.status==='APPLIED'&&receipt.material_id===topic.id&&receipt.changes.length===1&&old.operation===undefined&&old.before!==null&&old.after===actual.before&&old.content===actual.content&&old.relative_path===c.relative_path&&old.knowledge_layer===c.knowledge_layer&&JSON.stringify(old.candidate_ids)===JSON.stringify(c.candidate_ids),'PLAN_MISMATCH');
  }else check(sameBase(actual,c)||['reading-v3','reading-v2','reading-v1','located','legacy'].some(format=>sameBase(actual,change(topic,sources,{format}))),'PLAN_MISMATCH');
  if(['managed-topic','managed-topic-adopt'].includes(actual.operation)){
   check(actual.managed_key===c.managed_key,'PLAN_MISMATCH');
   let after;try{after=(actual.operation==='managed-topic-adopt'?adoptManagedTopic:replaceManagedTopic)(actual.before,c.managed_key,actual.content);}catch{check(false,'PLAN_MISMATCH');}
   check(actual.after===after,'PLAN_MISMATCH');
  }else if(actual.operation!=='reviewed-merge')check(actual.operation===undefined&&actual.managed_key===undefined&&actual.before===null&&actual.after===actual.content,'PLAN_MISMATCH');
  check(history||plan.status!=='ROLLED_BACK','PLAN_MISMATCH');
  const link_checks=actual.operation==='reviewed-merge'?await inspectMergeLinks({vaultRoot:vault,relativePath:actual.relative_path,before:actual.before,after:actual.after}):undefined;
  return {...plan,topic_id:topic.id,review_hash:knowledgeReviewHash(plan),...(link_checks?{link_checks}:{})};
 }
 return {
  writeEnabled:mode==='confirmed'||mode==='isolated',
  async prepareAdoption({topic_id,source_plan_id,expected_before_hash}){
   check(arguments[0]&&Object.keys(arguments[0]).length===3);
   check(typeof expected_before_hash==='string'&&/^[a-f0-9]{64}$/u.test(expected_before_hash));
   return store.useCurrentTopic(topic_id,async(topic,sources)=>{
    await protectSaved(change(topic,sources).relative_path);
    const old=(await writer.list()).find(p=>p.id===source_plan_id);
    check(old?.status==='APPLIED'&&old.material_id===topic.id&&old.changes.length===1,'MERGE_REQUIRED');
    return bind(await writer.prepare({materialId:topic.id,changes:[{...change(topic,sources),operation:'managed-topic-adopt',content:old.changes[0].content,source_plan_id,expected_before_hash}]}),topic,sources);
   });
  },
  async prepareMerge({topic_id,expected_before_hash,merged_content}){
   check(arguments[0]&&Object.keys(arguments[0]).length===3);
   check(typeof expected_before_hash==='string'&&/^[a-f0-9]{64}$/u.test(expected_before_hash)&&typeof merged_content==='string'&&merged_content.trim().length>0,'INPUT_INVALID');
   return store.useCurrentTopic(topic_id,async(topic,sources)=>{
    const c=change(topic,sources);await protectSaved(c.relative_path);
    const raw={operation:'reviewed-merge',knowledge_layer:c.knowledge_layer,relative_path:c.relative_path,candidate_ids:c.candidate_ids,content:merged_content,expected_before_hash,source_content_hash:contentHash(c.content)};
    return bind(await writer.prepare({materialId:topic.id,changes:[raw]}),topic,sources);
   });
  },
  async prepare({topic_id}){return store.useCurrentTopic(topic_id,async(topic,sources)=>{const c=change(topic,sources);await protectSaved(c.relative_path);return bind(await writer.prepare({materialId:topic.id,changes:[c]}),topic,sources);});},
  async apply({topic_id,plan_id,expected_review_hash,confirmed}){
   check(mode==='confirmed'||mode==='isolated'&&isolated(),'REAL_WRITE_DISABLED');
   return store.useCurrentTopic(topic_id,async(topic,sources)=>{
    await protectSaved(change(topic,sources).relative_path);
    const plan=(await writer.list()).find(p=>p.id===plan_id);check(plan,'NOT_FOUND');const bound=await bind(plan,topic,sources);
    check(confirmed===true&&expected_review_hash===bound.review_hash,'CONFIRMATION_REQUIRED');
    if(bound.link_checks)check(bound.link_checks.removed_links.length===0&&bound.link_checks.missing_links.length===0,'LINK_REVIEW_REQUIRED');
    return writer.apply({planId:plan_id,confirmed:true,expectedReviewHash:expected_review_hash});
   });
  },
  async rollback({plan_id,expected_review_hash,confirmed}){
   check(mode==='confirmed'||mode==='isolated'&&isolated(),'REAL_WRITE_DISABLED');
   const plan=(await writer.list()).find(p=>p.id===plan_id);check(plan,'NOT_FOUND');
   check(plan.vault_root===vault&&recognized(plan),'PLAN_MISMATCH');
   return store.withReviewedSaveGuard(plan.changes[0].relative_path,async()=>{
    check(confirmed===true&&expected_review_hash===knowledgeReviewHash(plan),'CONFIRMATION_REQUIRED');
    return writer.rollback({planId:plan_id,confirmed:true,expectedReviewHash:expected_review_hash});
   });
  },
  async list(){
   const plans=[];
   for(const plan of await writer.list()){
    if(!recognized(plan))continue;
    try{plans.push(await store.useCurrentTopic(plan.material_id,async(t,s)=>({...await bind(plan,t,s,{history:true}),stale:false})));}
    catch(e){if(['STALE_INPUT','REVIEW_REQUIRED'].includes(e.code))plans.push({...plan,topic_id:plan.material_id,review_hash:knowledgeReviewHash(plan),stale:true,invalidation:e.code});else if(e.code!=='PLAN_MISMATCH'&&e.code!=='TARGET_REQUIRED')throw e;}
   }
   return {mode,plans};
  }
 };
}
