import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectMergeLinks} from '../../src/capture/merge-links.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'merge-links-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const vault=path.join(root,'vault');
  await fs.mkdir(vault);
  await fs.mkdir(path.join(vault,'01-项目沉淀','鲜食项目','图示'),{recursive:true});
  await fs.mkdir(path.join(vault,'附件'),{recursive:true});
  return {root,vault,note:'01-项目沉淀/鲜食项目/主题 笔记.md'};
}

test('reports missing image and classifies existing project and general attachments',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/鲜食项目/图示/流程图.png'),'x');
  await fs.writeFile(path.join(f.vault,'附件/通用图.png'),'x');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'![旧图](图示/缺失图.png) ![新图](图示/流程图.png) ![通用](../../附件/通用图.png)'});
  assert.equal(result.missing_links.length,1);
  assert.equal(result.missing_links[0].target,'图示/缺失图.png');
  assert.deepEqual(result.attachments.map(x=>[x.path,x.exists,x.owner]),[
    ['01-项目沉淀/鲜食项目/图示/流程图.png',true,'project'],['附件/通用图.png',true,'general']
  ]);
});

test('reports links removed by a merge',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/鲜食项目/保留.md'),'# keep');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'[[保留]] and [说明](保留.md#段落)',after:'只有文字'});
  assert.equal(result.removed_links.length,2);
});

test('rejects vault escape in target and linked path',async t=>{
  const f=await fixture(t);
  await assert.rejects(inspectMergeLinks({vaultRoot:f.vault,relativePath:'../outside.md',before:'',after:''}),{code:'PATH_OUTSIDE_VAULT'});
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'[越界](../../../../outside.md)'});
  assert.equal(result.missing_links.length,1);
  assert.equal(result.missing_links[0].safe,false);
});

test('decodes relative links with spaces, URL encoding and fragments',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/鲜食项目/目标 文件.md'),'# target');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'[空格](目标 文件.md#x) [编码](目标%20文件.md#y)'});
  assert.deepEqual(result.missing_links,[]);
});

test('finds incoming links from index and homepage markdown',async t=>{
  const f=await fixture(t);
  const target='01-项目沉淀/鲜食项目/主题 笔记.md';
  await fs.mkdir(path.join(f.vault,'00-索引'),{recursive:true});
  await fs.writeFile(path.join(f.vault,'00-索引','00-知识库首页.md'),'[[01-项目沉淀/鲜食项目/主题 笔记]]\n[[主题 笔记]]\n[主题](../01-项目沉淀/鲜食项目/主题%20笔记.md)');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:target,before:'',after:'#主题'});
  assert.equal(result.incoming_indexes.length,1);
  assert.equal(result.incoming_indexes[0].path,'00-索引/00-知识库首页.md');
  assert.equal(result.incoming_indexes[0].links.length,3);
});

test('does not follow symlinks or read private management directories',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.vault,'.obsidian'),{recursive:true});
  await fs.writeFile(path.join(f.vault,'.obsidian','00-索引.md'),'[[主题 笔记]]');
  await fs.writeFile(path.join(f.root,'outside.md'),'[[主题 笔记]]');
  await fs.symlink(path.join(f.root,'outside.md'),path.join(f.vault,'01-项目沉淀/鲜食项目/跳转.md'));
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'[外链](跳转.md)'});
  assert.equal(result.missing_links.length,1);
  assert.equal(result.missing_links[0].safe,false);
  assert.deepEqual(result.incoming_indexes,[]);
  assert.ok(result.warnings.some(w=>w.includes('符号链接')));
});

test('a missing directory wiki path is not rescued by another folder basename match',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.vault,'01-项目沉淀/其他项目'),{recursive:true});
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/其他项目/同名.md'),'# 同名');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'[[不存在/同名]]'});
  assert.equal(result.missing_links.length,1);
  assert.equal(result.missing_links[0].safe,true);
  assert.ok(result.warnings.every(w=>!w.includes('匹配到多个')));
});

test('resolves a unique basename wiki image embed and project-relative wiki image paths',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.vault,'附件','唯一图.png'),'x');
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/鲜食项目/图示/项目图.png'),'x');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'![[唯一图.png]] ![[图示/项目图.png]]'});
  assert.deepEqual(result.missing_links,[]);
  assert.deepEqual(result.attachments.map(x=>x.path).sort(),[
    '01-项目沉淀/鲜食项目/图示/项目图.png','附件/唯一图.png'
  ]);
});

test('recognizes 00 overview pages as index sources',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.vault,'01-项目沉淀/鲜食项目'),{recursive:true});
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/鲜食项目/00-项目概览.md'),'[[主题 笔记]]');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'#主题'});
  assert.equal(result.incoming_indexes.length,1);
  assert.equal(result.incoming_indexes[0].path,'01-项目沉淀/鲜食项目/00-项目概览.md');
});

test('resolves extensionless vault-root and project-relative directory wiki note links',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.vault,'02-方法论/工程思维'),{recursive:true});
  await fs.writeFile(path.join(f.vault,'02-方法论/工程思维/何时使用小模型分流.md'),'# 通用方法');
  await fs.mkdir(path.join(f.vault,'01-项目沉淀/鲜食项目/图示'),{recursive:true});
  await fs.writeFile(path.join(f.vault,'01-项目沉淀/鲜食项目/图示/项目说明.md'),'# 项目说明');
  const result=await inspectMergeLinks({vaultRoot:f.vault,relativePath:f.note,before:'',after:'[[02-方法论/工程思维/何时使用小模型分流]] [[图示/项目说明]]'});
  assert.deepEqual(result.missing_links,[]);
});
