import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createKnowledgeWriter, knowledgeReviewHash} from '../../src/apply/knowledge.mjs';
import {managedTopicKey, renderManagedTopic, replaceManagedTopic} from '../../src/apply/managed-topic.mjs';

const key = 'a'.repeat(64);
const input = (content = '# 主题\n\n第一版。\n') => ({operation:'managed-topic', managed_key:key,
 knowledge_layer:'PROJECT_KNOWLEDGE',relative_path:'01-项目沉淀/主题.md',content,candidate_ids:['topic-1']});
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'managed-topic-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const vaultRoot=root+'/vault',dataDir=root+'/writer';
 await fs.mkdir(vaultRoot+'/01-项目沉淀',{recursive:true,mode:0o700});
 return {root,dataDir,vaultRoot,target:vaultRoot+'/01-项目沉淀/主题.md',writer:await createKnowledgeWriter({dataDir,vaultRoot})};
}
async function createApplied(f,content) {
 const plan=await f.writer.prepare({materialId:'revision-1',changes:[input(content)]});
 await f.writer.apply({planId:plan.id,confirmed:true,expectedReviewHash:knowledgeReviewHash(plan)});
 return plan;
}

test('managed block keys are stable and replacement preserves exact surrounding bytes',()=>{
 assert.equal(managedTopicKey('项目','主题'),managedTopicKey('项目','主题'));
 assert.notEqual(managedTopicKey('ab','c'),managedTopicKey('a','bc'));
 const block=renderManagedTopic(key,'第一版\n');
 const prefix='\uFEFF人工开头\r\n',suffix='\r\n人工结尾  \r\n';
 assert.equal(replaceManagedTopic(prefix+block+suffix,key,'第二版\n'),prefix+renderManagedTopic(key,'第二版\n')+suffix);
 for(const bad of ['普通笔记',block+block,block.replace('end','begin'),block.replace(key,'b'.repeat(64))])
  assert.throws(()=>replaceManagedTopic(bad,key,'下一版'),{code:'MERGE_REQUIRED'});
 assert.throws(()=>renderManagedTopic(key,block),{code:'INPUT_INVALID'});
});

test('managed create and update preserve external notes, survive restart and rollback exactly',async t=>{
 const f=await fixture(t),first=await createApplied(f);
 const prefix='\uFEFF我的说明\r\n',suffix='\r\n我的结论  \r\n';
 await fs.writeFile(f.target,prefix+first.changes[0].after+suffix);
 const before=await fs.readFile(f.target);
 const restarted=await createKnowledgeWriter({dataDir:f.dataDir,vaultRoot:f.vaultRoot});
 const next=await restarted.prepare({materialId:'revision-2',changes:[input('# 主题\n\n第二版。\n')]});
 assert.equal(next.changes[0].operation,'managed-topic');
 assert.equal(next.changes[0].before,before.toString());
 assert.equal(next.changes[0].after,prefix+renderManagedTopic(key,input('# 主题\n\n第二版。\n').content)+suffix);
 assert.deepEqual(await fs.readFile(f.target),before);
 await restarted.apply({planId:next.id,confirmed:true,expectedReviewHash:knowledgeReviewHash(next)});
 await restarted.apply({planId:next.id,confirmed:true});
 assert.equal(await fs.readFile(f.target,'utf8'),next.changes[0].after);
 await restarted.rollback({planId:next.id,confirmed:true});
 assert.deepEqual(await fs.readFile(f.target),before);
});

test('ordinary, empty and forged managed notes never create a hidden plan',async t=>{
 const f=await fixture(t);
 for(const body of ['', '人工笔记',renderManagedTopic(key,'伪造标记\n')]) {
  await fs.writeFile(f.target,body);
  await assert.rejects(f.writer.prepare({materialId:'revision-2',changes:[input()]}),{code:'MERGE_REQUIRED'});
  assert.deepEqual(await f.writer.list(),[]);
  assert.equal(await fs.readFile(f.target,'utf8'),body);
 }
});

test('manual changes inside managed block and deleted managed notes require reconciliation',async t=>{
 const f=await fixture(t),first=await createApplied(f);
 await fs.writeFile(f.target,first.changes[0].after.replace('第一版','人工修改'));
 const before=await fs.readFile(f.target);
 await assert.rejects(f.writer.prepare({materialId:'revision-2',changes:[input('新稿\n')]}),{code:'CONFLICT'});
 assert.deepEqual(await fs.readFile(f.target),before);
 assert.equal((await f.writer.list()).length,1);
 await fs.unlink(f.target);
 await assert.rejects(f.writer.prepare({materialId:'revision-2',changes:[input('新稿\n')]}),{code:'CONFLICT'});
});

test('a changed target after preview rejects apply and rollback preserves later manual edits',async t=>{
 const f=await fixture(t);await createApplied(f);
 const next=await f.writer.prepare({materialId:'revision-2',changes:[input('新稿\n')]});
 await fs.appendFile(f.target,'手工补充\r\n');
 const before=await fs.readFile(f.target);
 await assert.rejects(f.writer.apply({planId:next.id,confirmed:true,expectedReviewHash:knowledgeReviewHash(next)}),{code:'CONFLICT'});
 assert.deepEqual(await fs.readFile(f.target),before);
 await assert.rejects(f.writer.rollback({planId:next.id,confirmed:true}),{code:'CONFLICT'});
 assert.deepEqual(await fs.readFile(f.target),before);
});

test('re-preview incorporates outside edits before applying and older preview cannot overwrite them',async t=>{
 const f=await fixture(t);await createApplied(f);
 const request={materialId:'revision-2',changes:[input('新稿\n')]};
 const original=await f.writer.prepare(request);
 await fs.appendFile(f.target,'人工补充\r\n');
 const refreshed=await f.writer.prepare(request);
 assert.notEqual(refreshed.id,original.id);
 assert.ok(refreshed.changes[0].after.endsWith('人工补充\r\n'));
 assert.equal((await f.writer.prepare(request)).id,refreshed.id);
 await f.writer.apply({planId:refreshed.id,confirmed:true});
 await assert.rejects(f.writer.apply({planId:original.id,confirmed:true}),{code:'CONFLICT'});
 assert.equal(await fs.readFile(f.target,'utf8'),refreshed.changes[0].after);
});

test('interrupted managed update is recoverable once and cannot dispatch another update meanwhile',async t=>{
 const f=await fixture(t);await createApplied(f);
 const next=await f.writer.prepare({materialId:'revision-2',changes:[input('新稿\n')]});
 const rename=fs.rename.bind(fs);let injected=false;
 t.mock.method(fs,'rename',async(from,to)=>{await rename(from,to);if(to===f.target&&!injected){injected=true;throw new Error('after rename');}});
 await assert.rejects(f.writer.apply({planId:next.id,confirmed:true}),{code:'APPLY_ERROR'});
 t.mock.restoreAll();
 await assert.rejects(f.writer.prepare({materialId:'revision-3',changes:[input('另一稿\n')]}),{code:'RECOVERY_REQUIRED'});
 await f.writer.apply({planId:next.id,confirmed:true});
 assert.equal(await fs.readFile(f.target,'utf8'),next.changes[0].after);
 assert.equal((await f.writer.prepare({materialId:'revision-2',changes:[input('新稿\n')]})).id,next.id);
});

test('operation and managed key bind review hash; legacy hash is byte compatible',async t=>{
 const f=await fixture(t),plan=await f.writer.prepare({materialId:'revision-1',changes:[input()]});
 assert.notEqual(knowledgeReviewHash(plan),knowledgeReviewHash({...plan,changes:plan.changes.map(c=>({...c,managed_key:'b'.repeat(64)}))}));
 const plain={...input(),relative_path:'01-项目沉淀/旧.md'};delete plain.operation;delete plain.managed_key;
 const old=await f.writer.prepare({materialId:'legacy',changes:[plain]});
 const expected=createHash('sha256').update(JSON.stringify({id:old.id,material_id:old.material_id,vault_root:old.vault_root,
  changes:old.changes.map(({knowledge_layer,relative_path,content,candidate_ids,before,before_hash,after,after_hash})=>({knowledge_layer,relative_path,content,candidate_ids,before,before_hash,after,after_hash}))})).digest('hex');
 assert.equal(knowledgeReviewHash(old),expected);
 await assert.rejects(f.writer.prepare({materialId:'bad',changes:[{...input(),operation:'replace-anything'}]}),{code:'INPUT_INVALID'});
 const file=f.dataDir+'/knowledge-apply/plans/'+plan.id+'.json';
 const corrupt=JSON.parse(await fs.readFile(file,'utf8'));corrupt.changes[0].managed_key='b'.repeat(64);
 await fs.writeFile(file,JSON.stringify(corrupt),{mode:0o600});
 await assert.rejects(f.writer.list(),{code:'STATE_CORRUPT'});
});
