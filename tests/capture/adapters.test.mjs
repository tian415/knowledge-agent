import {createHash} from 'node:crypto';import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {readCodexConversation} from '../../src/capture/codex.mjs';import {validateChatgptObservation} from '../../src/capture/chatgpt.mjs';import {openCaptureStore} from '../../src/capture/store.mjs';import {snapshot,temp,now} from './helpers.mjs';
const meta={type:'session_meta',payload:{id:'t1',cwd:'/project'}};
const msg=(id,role,text,phase)=>({type:'response_item',payload:{id,type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}});
async function read(dir,records,tail=''){const file=dir+'/log.jsonl';await fs.writeFile(file,records.map(JSON.stringify).join('\n')+'\n'+tail);return readCodexConversation({file,projectRoots:['/project'],capturedAt:now});}
test('Codex selects final public text once, excludes injected/tool/reasoning and defers tail',async t=>{
 const dir=await temp(t),s=await read(dir,[meta,msg('u1','user','用户要求'),msg('s','system','secret'),msg('d','developer','secret'),msg('a','assistant','完成','final_answer'),msg('r','assistant','thinking','analysis'),msg('c','assistant','进行中','commentary'),{type:'event_msg',payload:{type:'user_message',message:'用户要求'}},msg('e','user','<environment_context>injected</environment_context>'),msg('u2','user','<environment_context>injected</environment_context>\n真实问题')],'{"type":');
 assert.deepEqual(s.messages.map(m=>m.text),['用户要求','完成','\n真实问题']);assert.ok(s.gaps.includes('incomplete_tail'));assert.equal(s.completeness,'partial');
});
test('malformed complete lines, invalid UTF8, project mismatch, symlink and limits reject',async t=>{
 const dir=await temp(t),file=dir+'/log.jsonl';await fs.writeFile(file,JSON.stringify(meta)+'\nBAD\n');await assert.rejects(readCodexConversation({file,projectRoots:['/project'],capturedAt:now}),{code:'SOURCE_INVALID'});
 await fs.writeFile(file,Buffer.from([255,10]));await assert.rejects(readCodexConversation({file,projectRoots:['/project'],capturedAt:now}),{code:'SOURCE_INVALID'});
 await read(dir,[meta]);await assert.rejects(readCodexConversation({file,projectRoots:['/other'],capturedAt:now}),{code:'SOURCE_SCOPE_MISMATCH'});
 await assert.rejects(readCodexConversation({file,projectRoots:['/project'],capturedAt:now,maxBytes:2}),{code:'SOURCE_TOO_LARGE'});
 await fs.symlink(file,dir+'/link');await assert.rejects(readCodexConversation({file:dir+'/link',projectRoots:['/project'],capturedAt:now}),{code:'UNSAFE_PATH'});
});
test('append, replacement, truncation and fork retain versions without claiming continuous history',async t=>{
 const dir=await temp(t),s=await openCaptureStore({dataDir:dir+'/store'});const a=await read(dir,[meta,msg('u1','user','first')]);await s.ingest(a);assert.equal((await s.ingest(a)).status,'NO_CHANGE');
 assert.equal((await s.ingest(await read(dir,[meta,msg('u1','user','first'),msg('u2','user','next')]))).added,1);
 assert.equal((await s.ingest(await read(dir,[meta,msg('u1','user','edited')]))).changed,1);assert.equal((await s.view()).sources[0].messages.length,2);
 await s.ingest(await read(dir,[{...meta,payload:{...meta.payload,id:'fork'}},msg('u1','user','edited')]));assert.equal((await s.view()).sources.length,2);
});
test('missing IDs and compaction stay partial without manufacturing stable message identity',async t=>{const out=await read(await temp(t),[meta,msg(undefined,'user','missing'),{type:'compacted',payload:{message:'summary'}}]);assert.equal(out.messages.length,0);assert.ok(out.gaps.includes('unstable_message_identity'));assert.ok(out.gaps.includes('compaction_or_rollback'));});
test('ChatGPT enforces exact observed identity, rendered text, partial and domain',()=>{
 const a={...snapshot(),source:{system:'chatgpt',scope:'chrome-selection',conversation_id:'t1'},channel:'web',url:'https://chatgpt.com/c/t1',messages:[{...snapshot().messages[0],text_format:'rendered_text'}]};assert.deepEqual(validateChatgptObservation(a),a);
 for(const bad of [{...a,url:'https://example.invalid/c/t1'},{...a,url:'https://chatgpt.com/c/t2'},{...a,completeness:'complete',gaps:[]},{...a,channel:'desktop'},{...a,messages:snapshot().messages}])assert.throws(()=>validateChatgptObservation(bad),{code:'INPUT_INVALID'});
});
test('unknown Codex role rejects the whole source instead of silently dropping content',async t=>{await assert.rejects(read(await temp(t),[meta,msg('m','future_public_role','new public content')]),{code:'SOURCE_INVALID'});});
test('exec and subagent sessions do not turn automation prompts into user conversations',async t=>{
 const dir=await temp(t),store=await openCaptureStore({dataDir:dir+'/store'});
 const previous=await read(dir,[meta,msg('u1','user','自动执行指令')]);
 await store.enqueueProcessing({snapshot:previous,recipe:'v1'});
 for(const source of ['exec',{subagent:{thread_spawn:{parent_thread_id:'parent'}}},{subagent:{other:'guardian'}}]){
  const s=await read(dir,[{...meta,payload:{...meta.payload,source}},msg('u1','user','自动执行指令'),msg('a1','assistant','模拟结果','final_answer')]);
  assert.deepEqual(s.messages,[]);assert.ok(s.gaps.includes('automated_session_excluded'));
  await store.enqueueProcessing({snapshot:s,recipe:'v1'});
  assert.equal((await store.claimProcessing({now})).status,'NO_WORK');
  assert.equal((await store.processingStatus()).jobs.length,0);
 }
 assert.ok((await store.view()).processing.jobs.some(j=>j.snapshot.messages[0]?.text==='自动执行指令'));
 const interactive=await read(dir,[{...meta,payload:{...meta.payload,source:'vscode'}},msg('u1','user','我的真实问题')]);
 assert.deepEqual(interactive.messages.map(m=>m.text),['我的真实问题']);
});
test('assistant-only ChatGPT observations explicitly carry missing user context',()=>{const a={...snapshot(),source:{system:'chatgpt',scope:'sample',conversation_id:'t1'},channel:'web',url:'https://chatgpt.com/c/t1',messages:[{...snapshot().messages[0],role:'assistant',text_format:'rendered_text'}]};assert.ok(validateChatgptObservation(a).gaps.includes('user_context_missing'));});
test('source append after streamed EOF is rejected instead of accepting a stale snapshot',async t=>{
 const dir=await temp(t),file=dir+'/log.jsonl';await fs.writeFile(file,[meta,msg('u1','user','first')].map(JSON.stringify).join('\n')+'\n');
 const original=fs.open.bind(fs);
 t.mock.method(fs,'open',async(...args)=>{
  const h=await original(...args);if(args[0]===file){const stream=h.createReadStream.bind(h);h.createReadStream=opts=>(async function*(){for await(const chunk of stream(opts))yield chunk;await fs.appendFile(file,JSON.stringify(msg('u2','user','new message'))+'\n');})();}return h;
 });
 await assert.rejects(readCodexConversation({file,projectRoots:['/project'],capturedAt:now}),{code:'SOURCE_CHANGED'});
});

test('complete final JSONL record without a newline remains readable and processable',async t=>{
 const dir=await temp(t),file=dir+'/log.jsonl';
 await fs.writeFile(file,[meta,msg('u1','user','最后一个完整问题')].map(JSON.stringify).join('\n'));
 const s=await readCodexConversation({file,projectRoots:['/project'],capturedAt:now});
 assert.deepEqual(s.messages.map(m=>m.text),['最后一个完整问题']);
 assert.ok(!s.gaps.includes('incomplete_tail'));
 const store=await openCaptureStore({dataDir:dir+'/store'});
 assert.equal((await store.enqueueProcessing({snapshot:s,recipe:'v1'})).status,'QUEUED');
});
test('complete but invalid final record rejects instead of masquerading as an incomplete tail',async t=>{
 const dir=await temp(t),file=dir+'/log.jsonl';
 await fs.writeFile(file,JSON.stringify(meta)+'\n'+JSON.stringify(msg('bad','future_public_role','invalid role')));
 await assert.rejects(readCodexConversation({file,projectRoots:['/project'],capturedAt:now}),{code:'SOURCE_INVALID'});
});

const compact={type:'compacted',payload:{message:'这是压缩摘要，不是原文。'}};
async function reviewedFixture(t,records,tail=''){
 const dir=await temp(t),file=dir+'/review.jsonl',bytes=Buffer.from(records.map(JSON.stringify).join('\n')+'\n'+tail);await fs.writeFile(file,bytes);
 const input={file,projectRoots:['/project'],capturedAt:now};
 const compactionReview={expected_file_sha256:createHash('sha256').update(bytes).digest('hex'),expected_message_ids:records.filter(r=>r.type==='response_item'&&r.payload.type==='message'&&(r.payload.role==='user'||r.payload.role==='assistant'&&r.payload.phase==='final_answer')).map(r=>r.payload.id)};
 return {input,compactionReview};
}
test('compaction review requires exact original byte hash and retained message order, keeps partial',async t=>{
 const {input,compactionReview}=await reviewedFixture(t,[meta,msg('u1','user','原始问题'),compact,msg('a1','assistant','原始答复','final_answer'),{type:'event_msg',payload:{type:'context_compacted'}},msg('u2','user','后续问题')]);
 const ordinary=await readCodexConversation(input);assert.ok(ordinary.gaps.includes('compaction_or_rollback'));
 const store=await openCaptureStore({dataDir:(await temp(t))+'/store'});assert.equal((await store.enqueueProcessing({snapshot:ordinary,recipe:'v1'})).status,'CONTEXT_REQUIRED');
 const reviewed=await readCodexConversation({...input,compactionReview});assert.equal(reviewed.completeness,'partial');assert.ok(reviewed.gaps.includes('compaction_originals_reviewed'));assert.ok(!reviewed.gaps.includes('compaction_or_rollback'));assert.ok(reviewed.gaps.includes('history_not_verified'));assert.ok(reviewed.gaps.includes('branch_unknown'));assert.deepEqual(reviewed.messages,ordinary.messages);assert.equal((await store.enqueueProcessing({snapshot:reviewed,recipe:'v1'})).status,'QUEUED');
 await assert.rejects(readCodexConversation({...input,compactionReview:{...compactionReview,expected_file_sha256:'0'.repeat(64)}}),{code:'SOURCE_CHANGED'});
 for(const expected_message_ids of [['u1','u2','a1'],['u1','a1'],['u1','a1','u2','extra']])await assert.rejects(readCodexConversation({...input,compactionReview:{...compactionReview,expected_message_ids}}),{code:'SOURCE_CHANGED'});
});
test('compaction review refuses rollback, missing original context, identity uncertainty and partial tail',async t=>{
 for(const records of [
  [meta,compact,msg('u1','user','只有后文')],
  [meta,msg('u1','user','只有前文'),compact],
  [meta,msg('u1','user','前文'),compact,{type:'compacted',payload:{message:'只有摘要，没有后文'}}],
  [meta,msg('u1','user','前文'),compact,msg('a1','assistant','后文','final_answer'),{type:'thread_rollback',payload:{}}],
  [meta,msg('u1','user','前文'),compact,msg('a1','assistant','后文','final_answer'),{type:'event_msg',payload:{type:'thread_rollback'}}],
  [meta,msg('a1','assistant','前文','final_answer'),compact,msg('a2','assistant','后文','final_answer')],
  [meta,msg('u1','user','前文'),compact,msg('a1','assistant','后文','final_answer'),msg(undefined,'user','未知ID')],
  [meta,msg('u1','user','无compaction')]
 ]){
  const {input,compactionReview}=await reviewedFixture(t,records);await assert.rejects(readCodexConversation({...input,compactionReview}),{code:'CONTEXT_REQUIRED'});
 }
 const {input,compactionReview}=await reviewedFixture(t,[meta,msg('u1','user','前文'),compact,msg('a1','assistant','后文','final_answer')],'{"type":');await assert.rejects(readCodexConversation({...input,compactionReview}),{code:'CONTEXT_REQUIRED'});
});

test('Codex internal goal wrappers with attributes are excluded, unbalanced wrappers quarantined, exterior bytes preserved',async t=>{
 const out=await read(await temp(t),[meta,msg('goal','user','<codex_internal_context source="goal">\n自动目标上下文\n</codex_internal_context>'),msg('broken','user','<codex_internal_context source="goal">未闭合'),msg('mixed','user','\ufeff真实问题\r\n<codex_internal_context source="goal">内部目标</codex_internal_context>\r\n  用户补充  ')]);
 assert.deepEqual(out.messages.map(m=>({id:m.id,text:m.text})),[{id:'mixed',text:'\ufeff真实问题\r\n\r\n  用户补充  '}]);assert.ok(out.gaps.includes('environment_injection_excluded'));assert.ok(out.gaps.includes('injected_message_quarantined'));
});
