import {createHash} from 'node:crypto';import fs from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';
import {check,fail,validateSnapshot,time,text} from './model.mjs';
// Known harness wrappers are excluded from user facts. Unbalanced wrappers quarantine the message.
function userText(raw,gaps){let value=raw;for(const tag of ['environment_context','permissions instructions','skills_instructions','app-context','recommended_plugins','INSTRUCTIONS']){const start='<'+tag+'>';if(value.includes(start)){const end='</'+tag+'>';if(!value.includes(end)){gaps.add('injected_message_quarantined');return null;}value=value.replace(new RegExp('<'+tag+'>[\\s\\S]*?</'+tag+'>','gu'),'');gaps.add('environment_injection_excluded');}}
 const internal=/<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/gu;
 if(internal.test(value)){value=value.replace(internal,'');gaps.add('environment_injection_excluded');}
 if(/<\/?codex_internal_context\b/u.test(value)){gaps.add('injected_message_quarantined');return null;}
 if(/^\s*# AGENTS\.md instructions/u.test(value)){gaps.add('injected_message_quarantined');return null;}
 return value.trim()?value:null;
}
export async function readCodexConversation({file,projectRoots,capturedAt,maxBytes=32*1024*1024,compactionReview}){
 check(path.isAbsolute(file)&&Array.isArray(projectRoots)&&projectRoots.length>0&&projectRoots.every(path.isAbsolute)&&time(capturedAt));
 if(compactionReview!==undefined)check(compactionReview&&Object.keys(compactionReview).length===2&&Object.hasOwn(compactionReview,'expected_file_sha256')&&Object.hasOwn(compactionReview,'expected_message_ids')&&typeof compactionReview.expected_file_sha256==='string'&&/^[a-f0-9]{64}$/u.test(compactionReview.expected_file_sha256)&&Array.isArray(compactionReview.expected_message_ids)&&compactionReview.expected_message_ids.length>0&&compactionReview.expected_message_ids.every(id=>text(id,256))&&new Set(compactionReview.expected_message_ids).size===compactionReview.expected_message_ids.length,'CONTEXT_REQUIRED');
 let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);check(!(await fs.lstat(current)).isSymbolicLink(),'UNSAFE_PATH');}
 const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const gaps=new Set(['history_not_verified','branch_unknown']);let meta=null,buffer=Buffer.alloc(0),total=0;const messages=[];const ids=new Set();const originalHash=createHash('sha256'),compactions=[];let rollback=false;
 function line(bytes){let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('SOURCE_INVALID');}check(row&&typeof row==='object','SOURCE_INVALID');const p=row.payload;
 if(row.type==='session_meta'){check(!meta&&p&&text(p.id,256)&&typeof p.cwd==='string','SOURCE_INVALID');check(projectRoots.some(root=>path.resolve(root)===path.resolve(p.cwd)),'SOURCE_SCOPE_MISMATCH');meta=p;if(p.forked_from_id)gaps.add('forked_history');if(p.source==='exec'||p.source&&typeof p.source==='object'&&Object.hasOwn(p.source,'subagent'))gaps.add('automated_session_excluded');return;}
 if(gaps.has('automated_session_excluded'))return;
 if(row.type==='thread_rollback'||p?.type==='thread_rollback')rollback=true;
 if(row.type==='compacted'||p?.type==='context_compacted')compactions.push(messages.length);
 if(rollback||compactions.length)gaps.add('compaction_or_rollback');
 if(row.type!=='response_item'||p?.type!=='message')return;
 if(['system','developer','tool'].includes(p.role))return;
 check(['user','assistant'].includes(p.role),'SOURCE_INVALID');
 if(p.role==='assistant'&&p.phase!=='final_answer'){gaps.add('nonfinal_assistant_excluded');return;}
 if(!text(p.id,256)){gaps.add('unstable_message_identity');return;}
 check(Array.isArray(p.content),'SOURCE_INVALID');const blocks=[];for(const part of p.content){if(['input_text','output_text'].includes(part.type)){check(typeof part.text==='string','SOURCE_INVALID');const value=p.role==='user'?userText(part.text,gaps):part.text;if(value)blocks.push(value);}else gaps.add('attachment_or_nontext_not_read');}
 if(!blocks.length)return;check(!ids.has(p.id),'SOURCE_INVALID');ids.add(p.id);messages.push({id:p.id,role:p.role,text:blocks.join('\n'),source_time:time(row.timestamp)?row.timestamp:null,text_format:'source_text'});
 }
 try{const before=await h.stat();check(before.isFile(),'UNSAFE_PATH');check(before.size<=maxBytes,'SOURCE_TOO_LARGE');for await(const chunk of h.createReadStream({autoClose:false})){originalHash.update(chunk);total+=chunk.length;check(total<=maxBytes,'SOURCE_TOO_LARGE');buffer=Buffer.concat([buffer,chunk]);let index;while((index=buffer.indexOf(10))!==-1){const bytes=buffer.subarray(0,index);buffer=buffer.subarray(index+1);line(bytes);}check(buffer.length<=4*1024*1024,'SOURCE_TOO_LARGE');}const after=await h.stat();check(after.ino===before.ino&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'SOURCE_CHANGED');const live=await fs.lstat(file);check(!live.isSymbolicLink()&&live.ino===before.ino&&live.dev===before.dev,'SOURCE_CHANGED');}finally{await h.close();}
 if(buffer.length){
  // A stable, complete JSON value is a record even without a trailing newline.
  // Only decoding/parsing failure is a partial tail; invalid records still fail closed.
  let complete=false;try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));complete=true;}catch{}
  if(complete)line(buffer);else gaps.add('incomplete_tail');
 }
 check(meta,'SOURCE_INVALID');
 if(messages.length&&!messages.some(m=>m.role==='user'))gaps.add('user_context_missing');
 if(compactionReview!==undefined){
  check(originalHash.digest('hex')===compactionReview.expected_file_sha256,'SOURCE_CHANGED');
  check(!rollback&&compactions.length>0&&compactions.every(position=>position>0&&position<messages.length)&&!['incomplete_tail','unstable_message_identity','user_context_missing'].some(gap=>gaps.has(gap)),'CONTEXT_REQUIRED');
  check(JSON.stringify(messages.map(message=>message.id))===JSON.stringify(compactionReview.expected_message_ids),'SOURCE_CHANGED');
  gaps.delete('compaction_or_rollback');gaps.add('compaction_originals_reviewed');
 }
 return validateSnapshot({schema_version:1,source:{system:'codex',scope:'project:'+path.resolve(meta.cwd),conversation_id:meta.id},channel:'local_log',title:meta.id,url:null,captured_at:capturedAt,completeness:'partial',gaps:[...gaps],messages});
}
