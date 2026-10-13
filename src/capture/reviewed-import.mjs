import {createHash} from 'node:crypto';
import {check,fields,text,time,digest,sourceKey,validateSnapshot} from './model.mjs';
import {safeRelative} from '../shared/knowledge-paths.mjs';
import {readNote} from './published-search.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const id=x=>text(x,256);
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/u.test(x);
export function validateReviewedManifest(m){
 fields(m,['version','batch_id','reviewed_at','sources','notes']);check(m.version===1&&id(m.batch_id)&&time(m.reviewed_at));
 check(Array.isArray(m.sources)&&m.sources.length>0&&m.sources.length<=1000&&Array.isArray(m.notes)&&m.notes.length>0&&m.notes.length<=1000);
 const sources=new Map();for(const s of m.sources){check(id(s.id)&&!sources.has(s.id));
  if(s.kind==='conversation'){fields(s,['id','kind','snapshot']);validateSnapshot(s.snapshot);}
  else{fields(s,['id','kind','title','locator','text','sha256','original_kind','actor','completeness']);check(s.kind==='excerpt'&&text(s.title)&&text(s.locator,8192)&&text(s.text,8*1024*1024)&&s.sha256===hash(s.text)&&['document','chat'].includes(s.original_kind)&&['user','assistant'].includes(s.actor)&&['complete','partial'].includes(s.completeness));}
  sources.set(s.id,s);
 }
 const paths=new Set(),ids=new Set();for(const n of m.notes){
  fields(n,['id','project','key','title','knowledge_layer','relative_path','content_hash','receipt','evidence','source_summaries']);check(id(n.id)&&!ids.has(n.id)&&id(n.project)&&id(n.key)&&text(n.title)&&sha(n.content_hash));ids.add(n.id);safeRelative(n.relative_path,n.knowledge_layer);check(!paths.has(n.relative_path));paths.add(n.relative_path);
  fields(n.receipt,['kind','id']);check(['writer','pk'].includes(n.receipt.kind)&&uuid(n.receipt.id));check(Array.isArray(n.evidence)&&n.evidence.length>0&&n.evidence.length<=1000);
  const referenced=new Set();for(const e of n.evidence){fields(e,['source_id','message_id','quote']);const s=sources.get(e.source_id);check(s&&text(e.quote,128*1024),'EVIDENCE_INVALID');const body=s.kind==='conversation'?s.snapshot.messages.find(x=>x.id===e.message_id)?.text:e.message_id===null?s.text:null;check(typeof body==='string'&&body.includes(e.quote),'EVIDENCE_INVALID');referenced.add(e.source_id);}
  check(Array.isArray(n.source_summaries)&&n.source_summaries.length===referenced.size);const summaries=new Set();for(const s of n.source_summaries){fields(s,['source_id','summary']);check(referenced.has(s.source_id)&&!summaries.has(s.source_id)&&text(s.summary,10000));summaries.add(s.source_id);}
 }return m;
}
function feedback(state,n){const p=state.processing?.topics;return (p?.feedback??[]).filter(f=>{const t=p.revisions.find(t=>t.id===f.topic_id);return t?.project===n.project&&t?.key===n.key;}).at(-1);}
export function reviewedBaseline(state,manifest){
 const p=state.processing;return {sources:manifest.sources.filter(s=>s.kind==='conversation').map(s=>{const key=sourceKey(s.snapshot.source);return [key,{job:p?.latest?.[key]??null,observation:state.sources.find(s=>s.key===key)?.observations.at(-1)?.hash??null}];}),topics:manifest.notes.map(n=>{const key='topic_'+digest([n.project,n.key]);return [key,p?.topics?.latest?.[key]??null];}),feedback:manifest.notes.map(n=>[n.id,feedback(state,n)??null])};
}
export function validateReviewedRecords(records){
 check(Array.isArray(records)&&records.length<=1000);const ids=new Set();for(const r of records){fields(r,['manifest_hash','manifest','imported_at','baseline','review_hash']);validateReviewedManifest(r.manifest);check(sha(r.review_hash)&&r.manifest_hash===digest(r.manifest)&&!ids.has(r.manifest.batch_id)&&time(r.imported_at));ids.add(r.manifest.batch_id);fields(r.baseline,['sources','topics','feedback']);check(['sources','topics','feedback'].every(k=>Array.isArray(r.baseline[k])));}
}
export function registerReviewedRecord(state,{manifest,expected_state_hash}){
 validateReviewedManifest(manifest);const existing=state.reviewed_imports?.find(r=>r.manifest.batch_id===manifest.batch_id),manifest_hash=digest(manifest);
 if(existing){check(existing.manifest_hash===manifest_hash,'IMPORT_CONFLICT');return {status:'NO_CHANGE',batch_id:manifest.batch_id,notes:manifest.notes.length};}
 check(expected_state_hash===digest(state),'STALE_INPUT');for(const n of manifest.notes)check(!['dismiss','edit'].includes(feedback(state,n)?.action),'REVIEW_REQUIRED');
 const record={manifest_hash,review_hash:digest([manifest_hash,expected_state_hash]),manifest:structuredClone(manifest),imported_at:new Date().toISOString(),baseline:reviewedBaseline(state,manifest)};(state.reviewed_imports??=[]).push(record);return {status:'IMPORTED',batch_id:manifest.batch_id,notes:manifest.notes.length,sources:manifest.sources.length};
}
export function createReviewedImports({store,writer,vaultRoot,authorizedHashes=[]}){
 const allowed=new Set(authorizedHashes);
 function authorize(manifest){validateReviewedManifest(manifest);check(allowed.has(digest(manifest)),'SOURCE_SCOPE_MISMATCH');}
 async function verify(n,plans){
  const markdown=await readNote(vaultRoot,n.relative_path);check(markdown!==null&&hash(markdown)===n.content_hash,'SAVED_NOTE_CHANGED');
  if(n.receipt.kind==='writer'){const p=plans.find(p=>p.id===n.receipt.id);check(p?.status==='APPLIED'&&p.changes.some(c=>c.relative_path===n.relative_path&&c.knowledge_layer===n.knowledge_layer&&c.after===markdown&&c.after_hash===n.content_hash),'RECEIPT_INVALID');}
  else{let receipt;try{receipt=JSON.parse(await readNote(vaultRoot,'.project-knowledge/transactions/'+n.receipt.id+'.json'));}catch(e){if(e.code==='UNSAFE_PATH')throw e;check(false,'RECEIPT_INVALID');}const {digest:expected,...plan}=receipt?.plan??{};check(receipt?.id===n.receipt.id&&receipt.status==='completed'&&expected===digest(plan)&&plan.operations?.some(o=>o.path===n.relative_path&&o.after===markdown)&&plan.routes?.some(r=>r.relative_path===n.relative_path&&r.knowledge_layer===n.knowledge_layer),'RECEIPT_INVALID');}
  return markdown;
 }
 async function preview({manifest}){authorize(manifest);const state=await store.view(),plans=await writer.list();for(const n of manifest.notes){check(!['dismiss','edit'].includes(feedback(state,n)?.action),'REVIEW_REQUIRED');await verify(n,plans);}const manifest_hash=digest(manifest),state_hash=digest(state);return {manifest_hash,state_hash,review_hash:digest([manifest_hash,state_hash]),notes:manifest.notes.map(n=>({id:n.id,path:n.relative_path,content_hash:n.content_hash,receipt:n.receipt})),sources:manifest.sources.length,claims:0,note_writes:0};}
 return {preview,async apply({manifest,expected_review_hash,confirmed}){
  check(confirmed===true,'CONFIRMATION_REQUIRED');const p=await preview({manifest});const state=await store.view(),old=state.reviewed_imports?.find(r=>r.manifest_hash===p.manifest_hash);
  // A repeat still verifies every current saved file and receipt; it never refreshes the baseline.
  if(old){check(expected_review_hash===old.review_hash||expected_review_hash===p.review_hash,'STALE_INPUT');return {status:'NO_CHANGE',batch_id:manifest.batch_id,notes:manifest.notes.length};}
  check(expected_review_hash===p.review_hash,'STALE_INPUT');return store.registerReviewedImport({manifest,expected_state_hash:p.state_hash},async()=>{const plans=await writer.list();for(const n of manifest.notes)await verify(n,plans);});
 },async list(){
  const state=await store.view(),plans=await writer.list(),latest=new Map();let excluded=0;
  for(const r of state.reviewed_imports??[]){authorize(r.manifest);for(const n of r.manifest.notes)latest.set(n.relative_path,{r,n});}
  const notes=[];for(const {r,n} of latest.values()){
   if(feedback(state,n)?.action==='dismiss'){excluded++;continue;}
   let markdown;try{markdown=await verify(n,plans);}catch(e){if(['SAVED_NOTE_CHANGED','RECEIPT_INVALID'].includes(e.code)){excluded++;continue;}throw e;}
   const baseline=reviewedBaseline(state,r.manifest),stale=digest(baseline)!==digest(r.baseline);notes.push({id:'note-'+hash(n.relative_path),title:n.title,relative_path:n.relative_path,markdown,topic_id:n.id,status:stale?'needs_review':'current',manual_changes:false,hash:hash(markdown),origin:'reviewed_saved_import',source_batch_id:r.manifest.batch_id,source_ids:[...new Set(n.evidence.map(e=>e.source_id))]});
  }return {notes,excluded,reserved_paths:[...latest.keys()]};
 },async status(){const state=await store.view();for(const r of state.reviewed_imports??[])authorize(r.manifest);return {batches:(state.reviewed_imports??[]).map(r=>({id:r.manifest.batch_id,manifest_hash:r.manifest_hash,notes:r.manifest.notes.map(n=>({id:n.id,path:n.relative_path,source_ids:[...new Set(n.evidence.map(e=>e.source_id))]})),sources:r.manifest.sources.length,imported_at:r.imported_at})),origin:'reviewed_saved_import',model_claims:0};},async source({batch_id,source_id}){const r=(await store.view()).reviewed_imports?.find(r=>r.manifest.batch_id===batch_id);check(r,'NOT_FOUND');authorize(r.manifest);const s=r.manifest.sources.find(s=>s.id===source_id);check(s,'NOT_FOUND');return structuredClone(s);}};
}
