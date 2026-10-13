import {check,fields,text,digest} from './model.mjs';
import {safeRelative,PREFIXES} from '../shared/knowledge-paths.mjs';
import {validateKnowledgeTarget} from '../shared/knowledge-standard.mjs';
export {classificationStandard,renderClassificationGuide} from '../shared/knowledge-standard.mjs';
import {classificationStandard} from '../shared/knowledge-standard.mjs';
export function validateKnowledgeUnits(units,snapshot){
 check(Array.isArray(units)&&units.length<=50);const seen=new Set();
 for(const u of units){
  fields(u,['key','title','knowledge_layer','project','summary','reason','evidence']);
  check(text(u.key,256)&&text(u.title,256)&&Object.hasOwn(PREFIXES,u.knowledge_layer)&&(u.project===null||text(u.project,256))&&text(u.summary,6000)&&text(u.reason,2000));
  const id=JSON.stringify([u.project,u.key]);check(!seen.has(id));seen.add(id);
  check(Array.isArray(u.evidence)&&u.evidence.length>0&&u.evidence.length<=20);
  for(const e of u.evidence){fields(e,['message_id','quote']);check(text(e.quote,4000)&&snapshot.messages.some(m=>m.id===e.message_id&&m.text.includes(e.quote)),'INVALID_EVIDENCE');}
 }
}
export function validateTopicRouting(p,t){
 const route=t.routing;fields(route,['knowledge_layer','units']);check(Object.hasOwn(PREFIXES,route.knowledge_layer)&&Array.isArray(route.units)&&route.units.length>0&&route.units.length<=1500);
 const seen=new Set();
 for(const ref of route.units){fields(ref,['job_id','key']);const id=JSON.stringify(ref);check(!seen.has(id));seen.add(id);
  const unit=p.jobs.find(j=>j.id===ref.job_id)?.result?.knowledge_units?.find(u=>u.key===ref.key&&u.project===t.project);
  check(t.source_ids.includes(ref.job_id)&&unit&&unit.knowledge_layer===route.knowledge_layer&&unit.key===t.key,'ROUTE_MISMATCH');
 }
 check(t.source_ids.every(id=>route.units.some(u=>u.job_id===id)),'ROUTE_MISMATCH');
}
export function routedAnalysis(job,topic){
 if(!topic.routing)return job.result;
 return {knowledge_units:job.result.knowledge_units.filter(u=>u.project===topic.project&&topic.routing.units.some(ref=>ref.job_id===job.id&&ref.key===u.key))};
}
export function previewKnowledgeRoutes(p,input){
 fields(input,['source_ids','targets']);check(Array.isArray(input.source_ids)&&input.source_ids.length>0&&input.source_ids.length<=30&&new Set(input.source_ids).size===input.source_ids.length&&Array.isArray(input.targets));
 const targetIds=new Set(),paths=new Set();
 for(const target of input.targets){fields(target,['project','key','knowledge_layer','relative_path']);check(text(target.project,256)&&text(target.key,256));validateKnowledgeTarget(target);
  const id=JSON.stringify([target.project,target.key]);check(!targetIds.has(id)&&!paths.has(target.relative_path),'TARGET_CONFLICT');targetIds.add(id);paths.add(target.relative_path);
 }
 const groups=new Map(),unresolved=[];
 for(const id of [...input.source_ids].sort()){
  const job=p.jobs.find(j=>j.id===id);check(job&&p.latest[job.source_key]===id&&job.status==='completed','STALE_INPUT');
  if(!job.result.knowledge_units){unresolved.push({job_id:id,reason:'来源尚未按知识点复核'});continue;}
  for(const unit of job.result.knowledge_units){
   const target=input.targets.find(t=>t.project===unit.project&&t.key===unit.key&&t.knowledge_layer===unit.knowledge_layer);
   if(!target){unresolved.push({job_id:id,key:unit.key,title:unit.title,knowledge_layer:unit.knowledge_layer,reason:'需要确认归属或配置既有主题位置'});continue;}
   const groupKey=JSON.stringify([unit.project,unit.key]);let group=groups.get(groupKey);
   if(!group){group={...target,title:unit.title,source_ids:[],units:[],reasons:[]};groups.set(groupKey,group);}
   group.source_ids.push(id);group.units.push({job_id:id,key:unit.key});group.reasons.push(unit.reason);
  }
 }
 const routes=[...groups.values()].map(g=>{
  const old=p.topics?.revisions.find(t=>p.topics.latest['topic_'+digest([t.project,t.key])]===t.id&&t.project===g.project&&t.key===g.key);
  // Never silently replace a theme using only one of its previous conversations.
  if(old?.source_ids.some(id=>!g.source_ids.some(next=>p.jobs.find(j=>j.id===next)?.source_key===p.jobs.find(j=>j.id===id)?.source_key)))unresolved.push({key:g.key,title:g.title,reason:'已有主题还有其他来源；须纳入后再复核，不能丢弃上下文'});
  const routing={knowledge_layer:g.knowledge_layer,units:g.units};
  const registration={project:g.project,key:g.key,title:g.title,recipe:'knowledge-units-v2',source_ids:[...new Set(g.source_ids)].sort(),routing};
  const expectedId='topicrev_'+digest([registration.project,registration.key,registration.title,registration.recipe,registration.source_ids,routing]);
  const feedback=(p.topics?.feedback??[]).filter(f=>f.topic_id===old?.id).at(-1)?.id??null;
  // Direct idempotent registration keeps the same basis; editorial changes and
  // feedback always invalidate a previously reviewed route plan.
  const basis=old&&(old.id!==expectedId||feedback)?{topic_id:old.id,feedback_id:feedback}:null;
  return {target:{project:g.project,key:g.key,knowledge_layer:g.knowledge_layer,relative_path:g.relative_path},reasons:g.reasons,basis,registration};
 });
 const plan={version:classificationStandard.version,routes,unresolved};return {...plan,review_hash:digest(plan)};
}

