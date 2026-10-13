import {createHash} from 'node:crypto';

const PREFIX='<!-- knowledge-agent:topic:';
const assert=(ok,code='INPUT_INVALID')=>{if(!ok)throw Object.assign(new Error(code),{code});};
const validKey=key=>typeof key==='string'&&/^[a-f0-9]{64}$/u.test(key);
const markers=key=>[`${PREFIX}v1 ${key} begin -->`,`${PREFIX}v1 ${key} end -->`];

export function managedTopicKey(project,key){
 assert([project,key].every(x=>typeof x==='string'&&x.length>0&&x.length<=256));
 return createHash('sha256').update(JSON.stringify([project,key])).digest('hex');
}

export function renderManagedTopic(key,content){
 assert(validKey(key)&&typeof content==='string'&&content.length>0&&!content.includes(PREFIX));
 const [begin,end]=markers(key);
 return `${begin}\n${content}${content.endsWith('\n')?'':'\n'}${end}\n`;
}

// A single exact block only; never infer a boundary from a heading or similar prose.
export function managedTopicBlock(before,key){
 assert(typeof before==='string'&&validKey(key));
 const [begin,end]=markers(key),start=before.indexOf(begin),finish=before.indexOf(end);
 assert(before.split(PREFIX).length===3&&start>=0&&finish>start&&
  (start===0||before[start-1]==='\n')&&before.slice(start+begin.length,start+begin.length+1)==='\n'&&
  before[finish-1]==='\n'&&before.slice(finish+end.length,finish+end.length+1)==='\n','MERGE_REQUIRED');
 return {start,end:finish+end.length+1,text:before.slice(start,finish+end.length+1)};
}

export function replaceManagedTopic(before,key,content){
 const block=renderManagedTopic(key,content);
 if(before===null)return block;
 const current=managedTopicBlock(before,key);
 return before.slice(0,current.start)+block+before.slice(current.end);
}

// Wrap only an already saved, receipt-proven append. Removing the two new
// marker lines reproduces every original byte; no semantic rendering changes.
export function adoptManagedTopic(before,key,content){
 assert(typeof before==='string'&&typeof content==='string'&&content.length>0&&before.endsWith(content),'CONFLICT');
 assert(!before.includes(PREFIX),'MERGE_REQUIRED');
 assert(content.endsWith('\n'),'MERGE_REQUIRED'); // Never normalize a saved append.
 const prefix=before.slice(0,before.length-content.length);
 assert(prefix.length>0&&prefix.endsWith('\n'),'MERGE_REQUIRED');
 return prefix+renderManagedTopic(key,content);
}
