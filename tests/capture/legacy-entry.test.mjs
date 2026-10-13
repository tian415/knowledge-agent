import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init,register} from '../../compat/project-knowledge/lib/config.mjs';
import {preview,apply,recover} from '../../compat/project-knowledge/lib/engine.mjs';
import {hash,encode} from '../../compat/project-knowledge/lib/files.mjs';

function fixture(t){
 const vault=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'entry-test-'));t.after(()=>fs.rmSync(vault,{recursive:true,force:true}));
 init(vault);register(vault,{id:'fresh',name:'商店',directory:'01-项目沉淀/商店',dashboard:'00-首页.md'});register(vault,{id:'general',name:'通用',directory:'03-长期知识/通用知识',dashboard:'索引.md'});
 const sources=[{id:'raw-1',kind:'chat',actor:'assistant',title:'同一聊天',locator:'https://chatgpt.com/c/example · 消息 secret-id',observedAt:'2026-09-08',scope:'部分对话',completeness:'partial',excerpt:'PRIVATE FULL QUOTE',summary:'讨论组件和项目约束。'}];
 const note=(id,project,layer,p)=>({id,project,knowledge_layer:layer,path:p,reason:'按知识点性质归属',title:path.basename(p,'.md'),kind:'engineering',sections:[{heading:'判断',body:'待验证的建议。',status:'proposed',sources:['raw-1']}]});
 const proposal={version:2,mode:'capture',sources,notes:[note('case','fresh','PROJECT_KNOWLEDGE','01-项目沉淀/商店/案例.md'),note('concept','general','GENERAL_KNOWLEDGE','03-长期知识/通用知识/概念.md'),note('method','general','ENGINEERING_THINKING','02-方法论/工程思维/方法.md')]};
 return {vault,proposal};
}
test('legacy entry routes one proposal across categories, retains evidence privately and is idempotent',t=>{
 const {vault,proposal}=fixture(t);const plan=preview(vault,proposal);
 assert.equal(plan.routes.length,3);assert.equal(plan.classification_version,'knowledge-routing-v2');
 assert.equal(plan.requiresPromotion,true);assert.throws(()=>apply(vault,plan),/confirm-promotion/);
 for(const op of plan.operations){assert.ok(!/^# /mu.test(op.after));assert.ok(op.after.includes('https://chatgpt.com/c/example'));assert.ok(op.after.includes('讨论组件和项目约束'));assert.ok(!op.after.includes('PRIVATE FULL QUOTE'));assert.ok(!op.after.includes('secret-id'));}
 const result=apply(vault,plan,{confirmPromotion:true});assert.equal(result.written.length,3);
 const saved=JSON.parse(fs.readFileSync(path.join(vault,'.project-knowledge/transactions',result.transaction+'.json')));
 assert.equal(saved.plan.proposal.sources[0].excerpt,'PRIVATE FULL QUOTE');
 assert.equal(preview(vault,proposal).operations.length,0);
});
test('new preview cannot silently use the old whole-project proposal',t=>{
 const {vault,proposal}=fixture(t);proposal.version=1;proposal.project='fresh';proposal.notes=[{...proposal.notes[0],path:'案例.md'}];
 assert.throws(()=>preview(vault,proposal),/ROUTING_REVIEW_REQUIRED/);
});
test('category mismatch, missing reason and project escape are rejected before writes',t=>{
 const {vault,proposal}=fixture(t);
 for(const modify of [p=>p.notes[1].path='01-项目沉淀/商店/错误.md',p=>delete p.notes[0].reason,p=>p.notes[0].path='01-项目沉淀/其他/错误.md']){const bad=structuredClone(proposal);modify(bad);assert.throws(()=>preview(vault,bad));}
 assert.ok(!fs.existsSync(path.join(vault,proposal.notes[0].path)));
});
test('manual bytes survive updates and edits after preview reject entire batch',t=>{
 const {vault,proposal}=fixture(t);apply(vault,preview(vault,proposal),{confirmPromotion:true});const file=path.join(vault,proposal.notes[0].path);
 fs.appendFileSync(file,'\n人工结尾\r\n');proposal.notes[0].sections[0].body='更新建议';const plan=preview(vault,proposal);assert.ok(plan.operations[0].after.endsWith('人工结尾\r\n'));
 const other=path.join(vault,proposal.notes[1].path);const before=fs.readFileSync(other,'utf8');fs.appendFileSync(file,'新编辑');
 assert.throws(()=>apply(vault,plan,{confirmPromotion:true}),/conflict/);assert.equal(fs.readFileSync(other,'utf8'),before);
});
test('v1 pending recovery remains valid without allowing fresh v1 previews',t=>{
 const {vault,proposal}=fixture(t);const config=fs.readFileSync(path.join(vault,'.project-knowledge/config.json'),'utf8');
 const legacy={version:1,project:'fresh',mode:'capture',sources:proposal.sources,notes:[{...proposal.notes[0],path:'历史.md'}]};
 const base={version:1,vaultId:JSON.parse(config).vaultId,configHash:hash(config),project:'fresh',proposal:legacy,stateBefore:null,stateAfter:encode({version:1,notes:{}}),operations:[{path:'01-项目沉淀/商店/历史.md',before:null,after:'历史原文'}],warnings:[],requiresPromotion:false};
 const id='history-recovery';fs.mkdirSync(path.join(vault,'.project-knowledge/transactions'),{recursive:true});fs.writeFileSync(path.join(vault,'.project-knowledge/transactions',id+'.json'),encode({version:1,id,status:'pending',promotionConfirmed:false,plan:{...base,digest:hash(base)}}));
 assert.equal(recover(vault,id).written.length,1);assert.equal(fs.readFileSync(path.join(vault,base.operations[0].path),'utf8'),'历史原文');
});
test('existing ordinary note requires reviewed merge instead of appending a duplicate theme',t=>{
 const {vault,proposal}=fixture(t);const target=path.join(vault,proposal.notes[0].path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'原有有效知识');
 assert.throws(()=>preview(vault,proposal),/MERGE_REQUIRED/);assert.equal(fs.readFileSync(target,'utf8'),'原有有效知识');
});
test('section headings cannot inject markup through the compact status summary',t=>{
 const {vault,proposal}=fixture(t);proposal.notes[0].sections[0].heading='<img src=x onerror=alert(1)>';
 const plan=preview(vault,proposal);assert.ok(!plan.operations[0].after.includes('<img'));
});

test('project overview retains a meaningful heading when its filename is generic',t=>{
 const {vault,proposal}=fixture(t);proposal.notes=[{...proposal.notes[0],path:'01-项目沉淀/商店/00-项目概览.md',title:'商店业务约束'}];
 assert.match(preview(vault,proposal).operations[0].after,/^# 商店业务约束$/mu);
});
