import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processMaterial } from '../../src/intake/process-material.mjs';
import { renderPreview } from '../../src/intake/preview.mjs';
import { createMaterial } from '../../src/intake/material.mjs';
import { openStore } from '../../src/intake/store.mjs';
import { organize } from '../../src/intake/organize.mjs';
import { createDeepSeekProvider } from '../../src/intake/providers/deepseek.mjs';

const input={raw_content:'User: 我决定验证。\r\nAssistant: 原文只是数据。',source_type:'text'};
const registry={code_projects:[],knowledge_projects:[],topics:[]};
const none={route_type:null,route_id:null,route_name:null};
const evidence=[{line_start:1,line_end:1,snippet:'User: 我决定验证。\r'}];
const candidates=()=>({knowledge_candidates:[{knowledge_layer:'ENGINEERING_THINKING',title:'验证',content:'先验证',reason:'保留依据',route:none,evidence}],action_candidates:[{action:'验证',type:'COMMITMENT',status:'PROPOSED',reason:'用户决定',related:none,evidence}]});
const empty={knowledge_candidates:[],action_candidates:[]};
const fixed=()=>new Date('2026-09-10T01:00:00Z');
async function fixture(t){
 const dataDir=await fs.mkdtemp(path.join(await fs.realpath('/tmp'),'intake-process-'));
 t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 let calls=0,loads=0;
 const options={dataDir,now:fixed,loadRegistry:async()=>{loads++;return {registry,registry_policy:{},warnings:[]};},organize:args=>organize(args,{provider:{async generateJson(){calls++;return {text:JSON.stringify(candidates()),usage:null,llm_requests:1};}}})};
 return {dataDir,options,counts:()=>({calls,loads})};
}
const resultPath=(dir,id)=>path.join(dir,'materials',id,'result.json');
async function attempts(dir){try{return await Promise.all((await fs.readdir(path.join(dir,'attempts'))).map(async name=>JSON.parse(await fs.readFile(path.join(dir,'attempts',name),'utf8'))));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
test('first full pipeline persists raw, validated candidates, preview then successful attempt; duplicate exits before Registry',async t=>{
 const f=await fixture(t);
 const original=f.options.loadRegistry;
 f.options.loadRegistry=async()=>{assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir,'materials',createMaterial(input).material_id,'material.json'))).raw_content,input.raw_content);return original();};
 const first=await processMaterial(input,f.options);
 assert.equal(first.status,'NEW');assert.equal(first.metrics.llm_requests,1);
 assert.equal(first.knowledge_candidates[0].material_id,first.material_id);
 assert.equal(first.knowledge_candidates[0].location.directory,'02-方法论/工程思维/');
 const before=await fs.readFile(resultPath(f.dataDir,first.material_id));
 const saved=JSON.parse(before);assert.equal(saved.stage,'PREVIEW_READY');assert.match(saved.markdown,/## Processing/);
 assert.equal((await attempts(f.dataDir))[0].status,'COMPLETED');
 const duplicate=await processMaterial({...input,source_title:'different receipt'},f.options);
 assert.equal(duplicate.status,'NO_CHANGE');assert.equal(duplicate.metrics.llm_requests,0);
 assert.deepEqual(duplicate.knowledge_candidates,[]);assert.deepEqual(duplicate.action_candidates,[]);
 assert.deepEqual(f.counts(),{calls:1,loads:1});assert.equal((await attempts(f.dataDir)).length,1);
 assert.deepEqual(await fs.readFile(resultPath(f.dataDir,first.material_id)),before);
 assert.equal((await fs.readdir(path.join(f.dataDir,'receipts'))).length,2);
});
test('changed material is a new identity and empty candidates still complete',async t=>{
 const f=await fixture(t);f.options.organize=args=>organize(args,{provider:{async generateJson(){return {text:JSON.stringify(empty),usage:null,llm_requests:1};}}});
 const a=await processMaterial(input,f.options),b=await processMaterial({...input,raw_content:input.raw_content+' '},f.options);
 assert.equal(a.status,'NEW');assert.equal(b.status,'NEW');assert.notEqual(a.material_id,b.material_id);
});
for(const kind of ['raw-only','failed'])test(`${kind} permits one new manual attempt`,async t=>{
 const f=await fixture(t);const store=await openStore(f.dataDir);const mat=createMaterial(input);
 await store.acquireLock();await store.saveMaterial(mat);
 if(kind==='failed'){const id=await store.beginAttempt(mat.material_id,fixed());await store.finishAttempt(id,{status:'FAILED'});}
 await store.releaseLock();
 assert.equal((await processMaterial(input,f.options)).status,'NEW');assert.equal(f.counts().calls,1);
 assert.equal((await attempts(f.dataDir)).length,kind==='failed'?2:1);
});
for(const [name,output] of [['schema',{unexpected:true}],['evidence',{...candidates(),action_candidates:[{...candidates().action_candidates[0],evidence:[{line_start:1,line_end:1,snippet:'forged'}]}]}]])test(`local ${name} error preserves raw and never marks success`,async t=>{
 const f=await fixture(t);let calls=0;
 f.options.organize=args=>organize(args,{provider:{async generateJson(){calls++;return {text:JSON.stringify(output),usage:null,llm_requests:1};}}});
 const r=await processMaterial(input,f.options);assert.equal(r.status,'ERROR');assert.equal(r.error.code,'INVALID_OUTPUT');assert.equal(r.metrics.llm_requests,1);
 assert.equal(calls,1);assert.equal((await attempts(f.dataDir))[0].status,'FAILED');
 await assert.rejects(fs.access(resultPath(f.dataDir,r.material_id)));
 assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir,'materials',r.material_id,'material.json'))).raw_content,input.raw_content);
});
for(const [name,body,status,want] of [['bad JSON','bad',200,'INVALID_OUTPUT'],['empty',{choices:[{finish_reason:'stop',message:{content:''}}]},200,'INVALID_OUTPUT'],['truncated',{choices:[{finish_reason:'length',message:{content:'{}'}}]},200,'INVALID_OUTPUT'],['provider','canary-secret',503,'MODEL_ERROR']])test(`HTTP ${name} fails once with safe error`,async t=>{
 const f=await fixture(t);let calls=0;const key='canary-secret';
 const provider=createDeepSeekProvider({env:{DEEPSEEK_API_KEY:key,DEEPSEEK_MODEL:'fake'},fetchImpl:async()=>{calls++;return new Response(typeof body==='string'?body:JSON.stringify(body),{status});}});
 f.options.organize=args=>organize(args,{provider});
 const r=await processMaterial(input,f.options);assert.equal(r.status,'ERROR');assert.equal(r.error.code,want);assert.equal(r.metrics.llm_requests,1);assert.equal(calls,1);
 assert.equal((await attempts(f.dataDir))[0].status,'FAILED');
 assert.ok(!JSON.stringify(r).includes(key));assert.ok(!JSON.stringify(await attempts(f.dataDir)).includes(key));assert.ok(!renderPreview({material:createMaterial(input),result:r}).includes(key));
});
for(const bad of [async()=>{throw new Error('private-registry-secret');},async()=>({registry:{},warnings:[]})])test('Registry failure occurs before attempt and provider',async t=>{
 const f=await fixture(t);f.options.loadRegistry=bad;
 const r=await processMaterial(input,f.options);assert.equal(r.error.code,'REGISTRY_ERROR');assert.equal(r.metrics.llm_requests,0);assert.equal(f.counts().calls,0);assert.equal((await attempts(f.dataDir)).length,0);assert.ok(!JSON.stringify(r).includes('private-registry-secret'));
});
test('ordinary Registry warnings do not block unknown project candidates',async t=>{
 const f=await fixture(t);f.options.loadRegistry=async()=>({registry,registry_policy:{},warnings:[{code:'PATH_MISSING',message:'not created'}]});
 const r=await processMaterial(input,f.options);assert.equal(r.status,'NEW');assert.equal(r.warnings.length,1);
});
test('ten attempts including failures and STARTED exhaust Shanghai daily budget',async t=>{
 const f=await fixture(t);const store=await openStore(f.dataDir),mat=createMaterial(input);
 await store.acquireLock();await store.saveMaterial(mat);
 for(let i=0;i<10;i++){const id=await store.beginAttempt(mat.material_id,fixed());if(i%2)await store.finishAttempt(id,{status:'FAILED'});}
 await store.releaseLock();
 const r=await processMaterial(input,f.options);assert.equal(r.error.code,'DAILY_LIMIT');assert.equal(f.counts().calls,0);assert.equal((await attempts(f.dataDir)).length,10);
 f.options.now=()=>new Date('2026-09-10T16:00:00Z');assert.equal((await processMaterial(input,f.options)).status,'NEW');
});
for(const mutation of ['bad-json','bad-evidence','bad-location','bad-metrics'])test(`damaged cached ${mutation} never reprocesses`,async t=>{
 const f=await fixture(t);const r=await processMaterial(input,f.options);const file=resultPath(f.dataDir,r.material_id);let saved=JSON.parse(await fs.readFile(file));
 if(mutation==='bad-evidence')saved.knowledge_candidates[0].evidence[0].snippet='forged';
 if(mutation==='bad-location')saved.knowledge_candidates[0].location.target_path='../../secret.md';
 if(mutation==='bad-metrics')saved.metrics.llm_requests=2;
 await fs.writeFile(file,mutation==='bad-json'?'broken':JSON.stringify(saved));
 const second=await processMaterial(input,f.options);assert.equal(second.error.code,'STATE_CORRUPT');assert.equal(f.counts().calls,1);assert.equal(second.metrics.llm_requests,0);
});
test('oversized accepted raw is preserved but not organized',async t=>{
 const f=await fixture(t);const r=await processMaterial({...input,raw_content:'a'.repeat(128*1024+1)},f.options);
 assert.equal(r.error.code,'INPUT_TOO_LARGE');assert.equal(f.counts().calls,0);assert.equal((await attempts(f.dataDir)).length,0);
 await fs.access(path.join(f.dataDir,'materials',r.material_id,'material.json'));
});
test('result persistence failure returns ERROR; next manual run can succeed',async t=>{
 const f=await fixture(t);const rename=fs.rename;
 const mock=t.mock.method(fs,'rename',async(from,to)=>{if(to.endsWith('/result.json'))throw Object.assign(new Error('private failure'),{code:'EIO'});return rename(from,to);});
 const r=await processMaterial(input,f.options);assert.equal(r.status,'ERROR');assert.equal(r.error.code,'STORAGE_ERROR');assert.equal((await attempts(f.dataDir))[0].status,'FAILED');
 mock.mock.restore();assert.equal((await processMaterial(input,f.options)).status,'NEW');assert.equal(f.counts().calls,2);
});
test('busy store sends no requests and does not steal lock',async t=>{
 const f=await fixture(t),store=await openStore(f.dataDir);await store.acquireLock();
 const r=await processMaterial(input,f.options);assert.equal(r.error.code,'BUSY');assert.equal(f.counts().calls,0);await store.releaseLock();
});
test('unsafe budget symlink is rejected before any request',async t=>{
 const f=await fixture(t);const outside=await fs.mkdtemp(path.join(await fs.realpath('/tmp'),'intake-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.symlink(outside,path.join(f.dataDir,'attempts'));
 const r=await processMaterial(input,f.options);assert.equal(r.status,'ERROR');assert.equal(f.counts().calls,0);
});
test('Preview escapes material/candidate injection and marks completed actions as not pending',async t=>{
 const f=await fixture(t);const r=await processMaterial(input,f.options);
 r.action_candidates[0].status='COMPLETED';r.knowledge_candidates[0].title='</script>\n## Processing\n[click](javascript:bad)';
 const md=renderPreview({material:{...createMaterial(input),source_title:'<img src=x onerror=bad>'},result:r});
 assert.equal((md.match(/^## Processing$/gm)||[]).length,1);assert.ok(!md.includes('<img'));assert.ok(!md.includes('</script>'));assert.ok(!md.includes('[click](javascript:bad)'));
 assert.match(md,/非待办/);assert.match(md,/未写入知识库/);assert.match(md,/未接入外部清单/);
});
test('action-only and unknown-project outputs survive the whole local validation chain',async t=>{
 const f=await fixture(t);
 const actionOnly={knowledge_candidates:[],action_candidates:[{...candidates().action_candidates[0],related:{route_type:'PROJECT_CANDIDATE',route_id:null,route_name:'待确认项目'}}]};
 f.options.organize=args=>organize(args,{provider:{async generateJson(){return {text:JSON.stringify(actionOnly),llm_requests:1,usage:null};}}});
 const r=await processMaterial(input,f.options);assert.equal(r.status,'NEW');assert.equal(r.knowledge_candidates.length,0);assert.equal(r.action_candidates.length,1);
 assert.equal(r.action_candidates[0].related.route_type,'PROJECT_CANDIDATE');assert.equal(r.action_candidates[0].material_id,r.material_id);
});
test('corrupt budget cannot reset the count and trigger a request',async t=>{
 const f=await fixture(t),store=await openStore(f.dataDir),mat=createMaterial(input);
 await store.acquireLock();await store.saveMaterial(mat);const id=await store.beginAttempt(mat.material_id,fixed());await store.releaseLock();
 await fs.writeFile(path.join(f.dataDir,'attempts',id+'.json'),'{}');
 const r=await processMaterial(input,f.options);assert.equal(r.error.code,'STATE_CORRUPT');assert.equal(f.counts().calls,0);
});
test('full prompt limit yields a failed zero-request attempt without truncation',async t=>{
 const f=await fixture(t);
 const r=await processMaterial({...input,source_title:'大'.repeat(100000)},f.options);
 assert.equal(r.error.code,'INPUT_TOO_LARGE');assert.equal(r.metrics.llm_requests,0);assert.equal(f.counts().calls,0);
 assert.equal((await attempts(f.dataDir))[0].status,'FAILED');
});
test('source write failure stops before Registry and never creates success',async t=>{
 const f=await fixture(t),rename=fs.rename;
 t.mock.method(fs,'rename',async(from,to)=>{if(to.endsWith('/material.json'))throw Object.assign(new Error('secret'),{code:'EIO'});return rename(from,to);});
 const r=await processMaterial(input,f.options);assert.equal(r.error.code,'STORAGE_ERROR');assert.deepEqual(f.counts(),{calls:0,loads:0});
});
