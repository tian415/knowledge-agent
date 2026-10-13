import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {temp} from './helpers.mjs';
const exec=promisify(execFile),script='scripts/knowledge-workspace.mjs';

async function fixture(t){
 const root=await temp(t),project=path.join(root,'project'),sessions=path.join(root,'sessions');await fs.mkdir(project);await fs.mkdir(sessions);
 const data=path.join(root,'state'),config={schema_version:1,data_dir:data,project_roots:[project],codex:{sessions_dir:sessions,max_files:20},chatgpt:{thread_ids:[]},budget:{max_jobs:1,max_input_bytes:120000},preview:null,port:0};
 const file=path.join(root,'runtime.json');await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
 const run=async action=>JSON.parse((await exec(process.execPath,[script,action,'--config',file])).stdout);
 return {root,project,sessions,data,file,run};
}

test('doctor is read-only, status contains no source body, and discover is explicit',async t=>{
 const {project,sessions,data,run}=await fixture(t);
 const text='正文不得出现在状态输出';const log=[{type:'session_meta',payload:{id:'t1',cwd:project}},{type:'response_item',payload:{type:'message',id:'m1',role:'user',content:[{type:'input_text',text}]}}].map(JSON.stringify).join('\n')+'\n';await fs.writeFile(path.join(sessions,'one.jsonl'),log);
 const doctor=await run('doctor');assert.equal(doctor.status,'READY');assert.equal(doctor.runtime.scheduler_enabled,false);await assert.rejects(fs.stat(data),{code:'ENOENT'});
 assert.equal((await run('discover')).queued,1);const status=await run('status');assert.equal(status.processing.queued,1);assert.ok(!JSON.stringify(status).includes(text));
 const claim=await run('claim');assert.equal(claim.status,'CLAIMED');assert.equal((await run('claim')).status,'ATTENTION_REQUIRED');
});

test('serve starts loopback without automatic discovery',async t=>{
 const {project,sessions,data,file}=await fixture(t);const log=[{type:'session_meta',payload:{id:'t1',cwd:project}},{type:'response_item',payload:{type:'message',id:'m1',role:'user',content:[{type:'input_text',text:'未显式读取'}]}}].map(JSON.stringify).join('\n')+'\n';await fs.writeFile(path.join(sessions,'one.jsonl'),log);
 const child=spawn(process.execPath,[script,'serve','--config',file],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGTERM'));let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 const line=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('serve timeout: '+stderr)),5000);child.stdout.on('data',chunk=>{out+=chunk;if(out.includes('\n')){clearTimeout(timer);resolve(out.split('\n')[0]);}});child.once('exit',code=>reject(Error('serve exited '+code+': '+stderr)));});
 const started=JSON.parse(line);assert.equal(started.status,'SERVING');assert.match(started.url,/^http:\/\/127\.0\.0\.1:\d+$/u);
 const status=await (await fetch(started.url+'/api/processing')).json();assert.equal(status.queued,0);assert.ok(!JSON.stringify(started).includes('未显式读取'));assert.ok(await fs.stat(data));
});

test('CLI has deterministic errors and requires one absolute private config',async t=>{
 const {file}=await fixture(t);
 for(const args of [['claim','--summary'],['status','--summary','extra'],['status','--summary','--summary']]){
  await assert.rejects(exec(process.execPath,[script,args[0],'--config',file,...args.slice(1)]),error=>error.code===1&&JSON.parse(error.stderr).error==='INPUT_INVALID');
 }
 await fs.chmod(file,0o644);
 await assert.rejects(exec(process.execPath,[script,'doctor','--config',file]),error=>error.code===1&&JSON.parse(error.stderr).error==='CONFIG_UNSAFE');
 await assert.rejects(exec(process.execPath,[script,'doctor','--config','relative.json']),error=>error.code===1&&JSON.parse(error.stderr).error==='CONFIG_PATH_REQUIRED');
});

test('one configured CLI completes source and topic work without switching to an unscoped store',async t=>{
 const {root,file,run}=await fixture(t);
 const config=JSON.parse(await fs.readFile(file,'utf8'));config.chatgpt.thread_ids=['chat-1'];config.budget.max_jobs=3;await fs.mkdir(root+'/vault');config.preview={writer_data_dir:root+'/writer',vault_root:root+'/vault',targets:[{project:'demo',key:'source-fidelity',knowledge_layer:'ENGINEERING_THINKING',relative_path:'02-方法论/工程思维/原文保真.md'}]};await fs.writeFile(file,JSON.stringify(config));
 const payload=path.join(root,'request.json');
 const send=async(action,input)=>{await fs.writeFile(payload,JSON.stringify(input),{mode:0o600});return JSON.parse((await exec(process.execPath,[script,action,'--config',file,'--input',payload])).stdout);};
 const pages=[{requested_cursor:null,response:{thread:{id:'chat-1',kind:'chatgpt',title:'原文与提炼'},page:{order:'newest_first',hasMore:false,nextCursor:null},turns:[{items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'保留原文，提炼另存。'}]}]}]}}];
 assert.equal((await send('read-chatgpt',pages)).status,'QUEUED');
 const task=await run('claim'),ref={message_id:'u1',quote:'保留原文，提炼另存。'};
 assert.equal((await send('finish',{id:task.job.id,attempt:task.job.attempt,result:{decision:'draft',markdown:'保留原文身份',reason:'已说明约束',coverage:{question:[ref],analysis:[ref],ending:[ref]},usage:null,knowledge_units:[{key:'source-fidelity',title:'原文保真',project:'demo',knowledge_layer:'ENGINEERING_THINKING',summary:'保留原文，提炼另存',reason:'跨项目工程方法',evidence:[ref]}]}})).status,'COMPLETED');
 const routes=await send('route-preview',{source_ids:[task.job.id]});assert.equal(routes.routes.length,1);
 await send('route-register',{source_ids:[task.job.id],expected_hash:routes.review_hash});
 const topic=await run('topic-claim');assert.equal(topic.status,'CLAIMED');
 await send('topic-finish',{id:topic.id,attempt:topic.attempt,result:{kind:'knowledge',markdown:'# 原文保真\n原始材料和提炼产物分开保存。',contribution:'说明两类数据职责',evidence:[{job_id:task.job.id,...ref}],source_summaries:[{job_id:task.job.id,summary:'讨论原文保真与提炼产物的区别。'}]}});

 const {createHash}=await import('node:crypto');const target=root+'/vault/'+config.preview.targets[0].relative_path;
 await fs.mkdir(path.dirname(target),{recursive:true});const old='# 人工原文\n';await fs.writeFile(target,old);
 const merge=await send('topic-merge-preview',{topic_id:topic.id,expected_before_hash:createHash('sha256').update(old).digest('hex'),merged_content:old+'\n合并后的知识与来源。\n'});
 assert.equal(merge.status,'PREPARED');assert.ok(merge.link_checks);
 const save={topic_id:topic.id,plan_id:merge.id,expected_review_hash:merge.review_hash,confirmed:true};
 await assert.rejects(send('topic-save',save),e=>JSON.parse(e.stderr).error==='REAL_WRITE_DISABLED');
 config.write_mode='confirmed';await fs.writeFile(file,JSON.stringify(config));
 assert.equal((await send('topic-save',save)).status,'APPLIED');assert.equal((await send('topic-save',save)).status,'APPLIED');
 assert.equal((await send('topic-restore',{plan_id:merge.id,expected_review_hash:merge.review_hash,confirmed:true})).status,'ROLLED_BACK');assert.equal(await fs.readFile(target,'utf8'),old);
 const full=await run('status');assert.equal(full.processing.topics[0].result.kind,'knowledge');
 const stateFile=path.join(config.data_dir,'state.json'),unchanged=await fs.readFile(stateFile);
 const summary=JSON.parse((await exec(process.execPath,[script,'status','--config',file,'--summary'])).stdout);
 assert.equal(summary.mode,'summary');assert.deepEqual(summary.runtime,full.runtime);
 assert.deepEqual(summary.processing.budget,full.processing.budget);
 assert.deepEqual(summary.processing.window,full.processing.window);
 assert.equal(summary.processing.completed,1);
 assert.deepEqual(summary.processing.usage,full.processing.usage);
 assert.equal(summary.processing.usage.unknown_attempts,2);
 assert.equal(summary.processing.usage.tokens.input_tokens,null);
 assert.deepEqual(summary.processing.decisions,{draft:1});
 assert.deepEqual(summary.processing.topics,{total:1,by_status:{completed:1},by_kind:{knowledge:1}});
 assert.equal(summary.processing.actions,0);
 for(const secret of ['原文与提炼','原文保真','保留原文','提炼产物'])assert.ok(!JSON.stringify(summary).includes(secret),secret);
 for(const field of ['markdown','coverage','quote'])assert.ok(!JSON.stringify(summary.processing).includes(field),field);
 assert.ok(Buffer.byteLength(JSON.stringify(summary))<Buffer.byteLength(JSON.stringify(full)));
 assert.deepEqual(await fs.readFile(stateFile),unchanged);
 await send('read-chatgpt',pages);assert.equal((await run('claim')).status,'NO_WORK');
 const before=await fs.readFile(path.join(config.data_dir,'state.json'));
 pages[0].response.thread.id='outside';
 await assert.rejects(send('read-chatgpt',pages),e=>JSON.parse(e.stderr).error==='SOURCE_SCOPE_MISMATCH');
 assert.deepEqual(await fs.readFile(path.join(config.data_dir,'state.json')),before);
 await assert.rejects(exec(process.execPath,[script,'claim','--config',file,'--input',payload]),e=>e.code===1);
 config.chatgpt.thread_ids=[];await fs.writeFile(file,JSON.stringify(config));
 await assert.rejects(exec(process.execPath,[script,'status','--config',file,'--summary']),e=>JSON.parse(e.stderr).error==='SOURCE_SCOPE_MISMATCH');
});

test('summary retains budget blockers and recovery identity without conversation titles or writes',async t=>{
 const {project,sessions,data,file,run}=await fixture(t);
 for(const id of ['one','two']){
  const log=[{type:'session_meta',payload:{id,cwd:project}},{type:'response_item',payload:{type:'message',id:'m1',role:'user',content:[{type:'input_text',text:'私密正文与标题'+id}]}}].map(JSON.stringify).join('\n')+'\n';
  await fs.writeFile(path.join(sessions,id+'.jsonl'),log);
 }
 await run('discover');const claim=await run('claim');
 const before=await fs.readFile(path.join(data,'state.json'));
 const summary=JSON.parse((await exec(process.execPath,[script,'status','--config',file,'--summary'])).stdout).processing;
 assert.equal(summary.queued,1);assert.equal(summary.running,1);assert.equal(summary.unresolved_attempts,1);
 assert.deepEqual(summary.pending_attempts,[{kind:'source',id:claim.job.id,attempt:claim.job.attempt,stale:false}]);
 assert.deepEqual(summary.queue,{total:1,ready:0,by_reason:{WINDOW_EXHAUSTED:1}});
 assert.equal(summary.budget.remaining_jobs,0);assert.equal(summary.window.jobs,1);
 assert.equal(summary.discovery.queued,2);assert.equal(summary.discovery.errors,0);
 assert.ok(!JSON.stringify(summary).includes('私密正文'));
 assert.deepEqual(await fs.readFile(path.join(data,'state.json')),before);
});
