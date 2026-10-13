import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../../web/capture/runs.js',import.meta.url),'utf8');
const context=vm.createContext({URL,encodeURIComponent});
vm.runInContext(source.slice(0,source.indexOf('async function refresh(){'))+'\nglobalThis.monitor={monitorAttention,changeSections,obsidianLink,usageText,sourceCaption};',context);
const {monitorAttention,changeSections,obsidianLink,usageText,sourceCaption}=context.monitor;
test('normal queues and explicitly excluded automated sessions do not become alerts',()=>{
 const result=monitorAttention({jobs:[{status:'queued',title:'普通队列'},{status:'blocked',title:'排除会话',gaps:['automated_session_excluded'],reason:'自动执行或子代理会话已排除，不作为用户日常对话。'},{status:'blocked',id:'need',title:'缺少上下文',gaps:['partial'],reason:'需要补读'}],topics:[],pending_attempts:[],queue:[{reason:'WINDOW_EXHAUSTED',title:'正常等待'}]},[]);
 assert.equal(result.length,1);assert.equal(result[0].title,'缺少上下文');
});
test('unfinished attempts, partial writes and changed feedback remain actionable',()=>{
 const result=monitorAttention({jobs:[],topics:[{id:'t',status:'review_required',title:'改稿'}],pending_attempts:[{id:'s',title:'未收到结果'}],queue:[]},[{id:'p',status:'PARTIAL',changes:[{relative_path:'a.md'}]}]);
 assert.equal(result.length,3);
});
test('sections describe actual changed text and marker adoption is named accurately',()=>{
 assert.equal(changeSections({before:'# 原标题\n\n## 章节一\n旧内容\n\n## 章节二\n未改',after:'# 原标题\n\n## 章节一\n新内容\n\n## 章节二\n未改'}).join('、'),'章节一');
 assert.equal(changeSections({operation:'managed-topic-adopt',before:'# 标题\n正文',after:'# 标题\n<!-- marker -->\n正文'}).join('、'),'接管已保存补充，正文未改写');
});
test('Obsidian URI safely encodes local note paths and rejects traversal',()=>{
 const url=obsidianLink('/Users/test/笔记库','01-项目/订单 & 价格.md');
 assert.equal(new URL(url).searchParams.get('path'),'/Users/test/笔记库/01-项目/订单 & 价格.md');
 assert.equal(obsidianLink('/Users/test/笔记库','../private.md'),null);
 assert.equal(obsidianLink('/Users/test/笔记库','/etc/passwd'),null);
});
test('missing or partial token reports never imply zero cost',()=>{
 assert.match(usageText(null),/未知/);
 assert.match(usageText({reported_turns:0,unknown_attempts:12,tokens:{input_tokens:null,output_tokens:null}}),/未知/);
 assert.match(usageText({reported_turns:1,unknown_attempts:2,tokens:{input_tokens:30,output_tokens:10}}),/2.*未知/);
});

test('monitoring page and scoped CSS load without creating writer plans',async t=>{
 const {createProductDemo}=await import('../../src/capture/demo.mjs');
 const {createProductApp}=await import('../../src/app/product.mjs');
 const demo=await createProductDemo();t.after(()=>fs.rm(demo.root,{recursive:true,force:true}));
 const app=await createProductApp({workspace:demo,config:{...demo.config,write_mode:'preview-only'},runtime:{...demo.runtime,vault_write_enabled:false},loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]})});
 const origin=await app.listen(0);t.after(()=>app.close());
 const before=(await demo.publisher.list()).plans.length;
 const page=await(await fetch(origin+'/capture/')).text();
 assert.match(page,/最近笔记变动/);assert.match(page,/<section id="topic-review" data-view="review" hidden/);assert.doesNotMatch(page,/<details id="topic-review"/);
 const css=await fetch(origin+'/capture/monitor.css');assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);
 for(const endpoint of ['runtime','processing','topic-previews'])assert.equal((await fetch(origin+'/capture/api/'+endpoint)).status,200);
 assert.equal((await demo.publisher.list()).plans.length,before);
});

test('opaque conversation IDs have a readable caption without inventing a discussion title',()=>{assert.equal(sourceCaption('00000000-0000-4000-8000-000000000001'),'Codex 项目讨论');assert.equal(sourceCaption('真实对话标题'),'真实对话标题');});
test('adoption identifies the saved section when its content heading is available',()=>{assert.equal(changeSections({operation:'managed-topic-adopt',content:'# 商店下单 AI 客服补充\n正文'}).join('、'),'商店下单 AI 客服补充');});
