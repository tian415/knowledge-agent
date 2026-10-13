import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshotText } from '../../src/app/snapshot-text.mjs';
test('plain lines and Markdown checklists become an explicitly local snapshot without inferring action links',()=>{
 const items=parseSnapshotText('- [ ] 验证重复输入\n- [x] 整理会议结论\n考虑下周复用\n');
 assert.deepEqual(items.map(({title,status})=>({title,status})),[{title:'验证重复输入',status:'open'},{title:'整理会议结论',status:'completed'},{title:'考虑下周复用',status:'open'}]);
 assert.ok(items.every(item=>!Object.hasOwn(item,'action_id')));
 assert.equal(parseSnapshotText('考虑下周复用')[0].id,items[2].id);
});
test('empty, duplicate or oversized snapshot text is rejected before a write',()=>{
 for(const text of ['', ' \n ', '同一事项\n同一事项', 'x'.repeat(128*1024+1)])assert.throws(()=>parseSnapshotText(text));
});
