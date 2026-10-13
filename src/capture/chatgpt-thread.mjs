import {check,text,validateSnapshot} from './model.mjs';

// Adapter for Codex app read_thread responses, not its retrieval summaries.
// Caller must follow every returned cursor. This proves page coverage only,
// not access to hidden memory, deleted turns, attachments or alternate branches.
export function threadPagesToSnapshot({pages,capturedAt}){
 check(Array.isArray(pages)&&pages.length>0&&pages.length<=1000);
 const first=pages[0].response;check(first?.thread?.kind==='chatgpt'&&text(first.thread.id,256));
 let expected=null;const turns=[],gaps=new Set(['hidden_memory_not_read','alternate_branches_not_verified','message_timestamps_not_read']);
 for(let n=0;n<pages.length;n++){
  const {requested_cursor,response:p}=pages[n];check(requested_cursor===expected,'SOURCE_INCOMPLETE');
  check(p?.thread?.id===first.thread.id&&p.thread.kind==='chatgpt','SOURCE_SCOPE_MISMATCH');
  check(p.page?.order==='newest_first'&&typeof p.page.hasMore==='boolean'&&Array.isArray(p.turns),'SOURCE_INCOMPLETE');
  check(!p.truncated,'SOURCE_TRUNCATED');
  turns.push(...p.turns);expected=p.page.nextCursor;
  if(p.page.hasMore)check(text(expected,256)&&n<pages.length-1,'SOURCE_INCOMPLETE');
  else check(expected===null&&n===pages.length-1,'SOURCE_INCOMPLETE');
  if(p.attachments?.length)gaps.add('attachment_or_nontext_not_read');
 }
 const messages=[];
 for(const turn of turns.reverse()){
  check(Array.isArray(turn.items)&&!turn.truncated,'SOURCE_TRUNCATED');
  for(const item of turn.items){
   check(!item.truncated,'SOURCE_TRUNCATED');
   if(!['userMessage','agentMessage'].includes(item.type)){gaps.add('nonmessage_items_not_read');continue;}
   check(text(item.id,256),'SOURCE_INVALID');let body;
   if(item.type==='agentMessage'){check(typeof item.text==='string','SOURCE_INVALID');body=item.text;}
   else {check(Array.isArray(item.content),'SOURCE_INVALID');const blocks=[];for(const block of item.content){check(!block.truncated,'SOURCE_TRUNCATED');if(block.type==='text'){check(typeof block.text==='string','SOURCE_INVALID');blocks.push(block.text);}else gaps.add('attachment_or_nontext_not_read');}body=blocks.join('\n');}
   if(!body){gaps.add('empty_message_not_read');continue;}
   messages.push({id:item.id,role:item.type==='userMessage'?'user':'assistant',text:body,source_time:null,text_format:'source_text'});
  }
 }
 return validateSnapshot({schema_version:1,source:{system:'chatgpt',scope:'conversation:'+first.thread.id,conversation_id:first.thread.id},channel:'desktop',title:first.thread.title,url:'https://chatgpt.com/c/'+first.thread.id,captured_at:capturedAt,completeness:'partial',gaps:[...gaps],messages});
}
