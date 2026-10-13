import { createHash } from 'node:crypto';
export function parseSnapshotText(text) {
  const invalid=()=>{throw Object.assign(new Error('清单需要包含至少一行，且同一快照内不能重复。'),{code:'INPUT_INVALID'});};
  if(typeof text!=='string'||Buffer.byteLength(text)>128*1024)invalid();
  const seen=new Set(),items=[];
  for(const line of text.split(/\r?\n/u)) {
    const trimmed=line.trim();if(!trimmed)continue;
    const match=/^(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/u.exec(trimmed);
    const title=match?match[2]:trimmed.replace(/^[-*]\s+/u,'');
    if(!title.trim()||seen.has(title))invalid();seen.add(title);
    items.push({id:'local_'+createHash('sha256').update(title).digest('hex'),title,status:match&&match[1]!==' '?'completed':'open'});
  }
  if(items.length===0||items.length>500)invalid();return items;
}
