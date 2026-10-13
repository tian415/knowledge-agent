import {test} from 'node:test';
import assert from 'node:assert/strict';
import {threadPagesToSnapshot} from '../../src/capture/chatgpt-thread.mjs';
import {now} from './helpers.mjs';
const page=(hasMore=false,nextCursor=null)=>({thread:{id:'chat1',kind:'chatgpt',title:'项目比较'},page:{order:'newest_first',hasMore,nextCursor},turns:[{id:'u1',items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'比较两种方案'}]},{id:'a1',type:'agentMessage',text:'两种方案职责不同'}]}]});
test('full tool messages preserve order and source, never use preview summary',()=>{
 const p=page();p.thread.preview='无关的尾部同步摘要';const s=threadPagesToSnapshot({pages:[{requested_cursor:null,response:p}],capturedAt:now});
 assert.deepEqual(s.messages.map(m=>m.id),['u1','a1']);assert.equal(s.messages[0].text,'比较两种方案');assert.equal(s.completeness,'partial');
});
test('missing older pages, truncation and mismatched page cursors are rejected',()=>{
 const convert=p=>threadPagesToSnapshot({pages:p,capturedAt:now});
 assert.throws(()=>convert([{requested_cursor:null,response:page(true,'u1')}]),{code:'SOURCE_INCOMPLETE'});
 const p=page();p.turns[0].items[1].truncated=true;assert.throws(()=>convert([{requested_cursor:null,response:p}]),{code:'SOURCE_TRUNCATED'});
 assert.throws(()=>convert([{requested_cursor:'wrong',response:page()}]),{code:'SOURCE_INCOMPLETE'});
});
test('pagination restores older turns first; duplicate IDs and foreign conversation rejected',()=>{
 const newest=page(true,'u2');newest.turns[0].id='u2';newest.turns[0].items[0].id='u2';newest.turns[0].items[1].id='a2';
 const pages=[{requested_cursor:null,response:newest},{requested_cursor:'u2',response:page()}];
 const s=threadPagesToSnapshot({pages,capturedAt:now});assert.deepEqual(s.messages.map(m=>m.id),['u1','a1','u2','a2']);
 pages[1].response.thread.id='other';assert.throws(()=>threadPagesToSnapshot({pages,capturedAt:now}),{code:'SOURCE_SCOPE_MISMATCH'});
});
