import {createHash} from 'node:crypto';
export const fail=code=>Object.assign(new Error(code),{code});
export function check(ok,code='INPUT_INVALID'){if(!ok)throw fail(code);}
export function fields(value,keys){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(value,k)));}
export const text=(v,max=1000)=>typeof v==='string'&&v.length>0&&v.length<=max;
export const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sourceKey=s=>'src_'+digest([s.system,s.scope,s.conversation_id]);
export const messageHash=m=>digest([m.role,m.text,m.text_format]);
export function validateSnapshot(s){
 fields(s,['schema_version','source','channel','title','url','captured_at','completeness','gaps','messages']);
 fields(s.source,['system','scope','conversation_id']);
 check(s.schema_version===1&&['codex','chatgpt'].includes(s.source.system)&&text(s.source.scope,256)&&text(s.source.conversation_id,256));
 check(['local_log','web','desktop'].includes(s.channel)&&text(s.title)&&time(s.captured_at));
 check(s.url===null||text(s.url,2048));
 check(['complete','partial'].includes(s.completeness)&&Array.isArray(s.gaps)&&s.gaps.length<=100&&s.gaps.every(x=>text(x,256))&&(s.completeness==='complete'?s.gaps.length===0:s.gaps.length>0));
 check(Array.isArray(s.messages)&&s.messages.length<=10000);const ids=new Set();let size=0;
 for(const m of s.messages){fields(m,['id','role','text','source_time','text_format']);check(text(m.id,256)&&!ids.has(m.id)&&['user','assistant'].includes(m.role)&&text(m.text,512*1024)&&(m.source_time===null||time(m.source_time))&&['source_text','rendered_text'].includes(m.text_format));ids.add(m.id);size+=Buffer.byteLength(m.text);}
 check(size<=8*1024*1024,'INPUT_TOO_LARGE');return structuredClone(s);
}
