import {isDeepStrictEqual} from 'node:util';
import {PREFIXES} from '../shared/knowledge-paths.mjs';
import {check,fields,text,time,digest} from './model.mjs';
const inputFields=['id','kind','stage','title','body','knowledge_layer','evidence','verification'];
export function candidateId(source,c){
 return 'cand_'+digest([source,c.kind,c.stage,c.title,c.body,c.knowledge_layer,
  c.evidence.map(e=>[e.message_id,e.message_hash,e.snippet]),c.verification]);
}
export function validateReview(batch,state,{historical=false,observationHash=null}={}){
 fields(batch,historical?['source_key','generator','candidates']:['source_key','generator','observation_hash','candidates']);
 check(batch.generator==='codex_assisted'&&Array.isArray(batch.candidates)&&batch.candidates.length<=100);
 const src=state.sources.find(s=>s.key===batch.source_key);check(src,'INVALID_EVIDENCE');
 if(!historical)check(batch.observation_hash===src.observations.at(-1)?.hash,'STALE_INPUT');
 const ids=new Set();
 return batch.candidates.map(input=>{
  fields(input,inputFields);const c=structuredClone(input);
  check(['progress','knowledge','confirmation'].includes(c.kind)&&
   ['discussed','decided','implemented','verified','unknown'].includes(c.stage)&&text(c.title,300)&&text(c.body,20000));
  check(c.kind==='knowledge'?Object.hasOwn(PREFIXES,c.knowledge_layer):c.knowledge_layer===null);
  check(Array.isArray(c.evidence)&&c.evidence.length>0&&c.evidence.length<=30);
  for(const e of c.evidence){
   fields(e,['message_id','message_hash','snippet']);const m=src.messages.find(m=>m.id===e.message_id);
   check(text(e.snippet,20000)&&m&&(historical||m.current_hash===e.message_hash)&&
    m.versions.find(v=>v.hash===e.message_hash)?.message.text.includes(e.snippet),'INVALID_EVIDENCE');
  }
  // A source is a union of retained versions, not a continuous conversation.
  // Every evidence set must have coexisted in one observed branch/order.
  const observation=historical
   ?src.observations.find(o=>o.hash===observationHash&&c.evidence.every(e=>o.order.some(([id,hash])=>id===e.message_id&&hash===e.message_hash)))
   :src.observations.at(-1);
  check(observation&&c.evidence.every(e=>observation.order.some(([id,hash])=>id===e.message_id&&hash===e.message_hash)),'INVALID_EVIDENCE');
  const hasUser=observation.order.some(([id,hash])=>src.messages.find(m=>m.id===id)?.versions.find(v=>v.hash===hash)?.message.role==='user');
  check(hasUser||c.kind==='confirmation'&&c.stage==='unknown','CONTEXT_REQUIRED');
  if(c.verification!==null){
   fields(c.verification,['type','checked_at','reference','result']);
   check(c.verification.type==='local_check'&&time(c.verification.checked_at)&&text(c.verification.reference,2000)&&text(c.verification.result,10000));
  }
  check(c.id===candidateId(batch.source_key,c)&&!ids.has(c.id));ids.add(c.id);
  c.proposed_stage=c.stage;
  c.observation_hash=observation.hash;
  c.verification_status=c.verification?'local_check':'not_checked';
  if(c.stage==='verified'&&!c.verification){c.stage='implemented';c.verification_status='reported_unverified';}
  return c;
 });
}
export function validateStoredCandidate(c,state){
 fields(c,[...inputFields,'proposed_stage','observation_hash','verification_status','source_key','generator','decision','review_required']);
 check(['pending','keep','dismiss'].includes(c.decision)&&typeof c.review_required==='boolean');
 const input=Object.fromEntries(inputFields.map(k=>[k,c[k]]));input.stage=c.proposed_stage;
 const [expected]=validateReview({source_key:c.source_key,generator:c.generator,candidates:[input]},state,{historical:true,observationHash:c.observation_hash});
 const actual=Object.fromEntries(Object.keys(expected).map(k=>[k,c[k]]));check(isDeepStrictEqual(actual,expected));
 const src=state.sources.find(s=>s.key===c.source_key);
 if(c.evidence.some(e=>src.messages.find(m=>m.id===e.message_id)?.current_hash!==e.message_hash))check(c.review_required);
}
