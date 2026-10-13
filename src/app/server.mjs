import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { processMaterial, validateCachedResult } from '../intake/process-material.mjs';
import { openStore } from '../intake/store.mjs';
import { createMaterial } from '../intake/material.mjs';
import { organize } from '../intake/organize.mjs';
import { createDeepSeekProvider } from '../intake/providers/deepseek.mjs';
import { loadRegistry as realRegistry } from '../registry/load-registry.mjs';
import { safeRelative } from '../shared/knowledge-paths.mjs';
import { parseSnapshotText } from './snapshot-text.mjs';
import { projectCards } from './project-view.mjs';

const fail = code => Object.assign(new Error(code), {code});
const requireValue = (value, code='INPUT_INVALID') => { if (!value) throw fail(code); };
const staticFiles = {'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const cleanTitle = text => text.replace(/[\r\n]/gu,' ').replace(/[\\`*_[\]<>#]/gu,'');

export async function createApp({dataDir,vaultRoot,loadRegistry=realRegistry,organizer,mode='live',captureApp,captureStore,materialProcessingEnabled=true,knowledgeWriteEnabled=true}={}) {
  const {openWorkspace}=await import('../workspace/state.mjs');
  const {createKnowledgeWriter,knowledgeReviewHash}=await import('../apply/knowledge.mjs');
  const store=await openStore(dataDir);
  const workspace=await openWorkspace({dataDir,...(captureStore?{externalActionIds:async()=>(await captureStore.actionView({})).actions.map(a=>a.id)}:{})});
  const writer=await createKnowledgeWriter({dataDir,vaultRoot});
  const reviewed = plan => ({...plan,review_hash:knowledgeReviewHash(plan)});
  const token=randomBytes(32).toString('hex');
  let origin=null,mutating=false;
  const runOrganizer=organizer??(input=>organize(input,{provider:createDeepSeekProvider()}));

  async function savedMaterial(id) {
    requireValue(/^mat_[0-9a-f]{64}$/u.test(id));
    const material=await store.readMaterial(id),result=await store.readResult(id);
    if(result) { try {validateCachedResult(result,material);} catch {throw fail('STATE_CORRUPT');} }
    return {material,result};
  }
  async function state() {
    const materials=[];
    for (const id of await store.listMaterialIds()) {
      try {
        const {material,result}=await savedMaterial(id);
        materials.push({id,title:material.source_title??'未命名材料',source_type:material.source_type,stage:result?.stage??'待重新处理',knowledge_count:result?.knowledge_candidates.length??0,action_count:result?.action_candidates.length??0});
      } catch(error) {
        // Contain a single damaged record, preserving it for diagnosis. Never replace or reprocess it.
        materials.push({id,title:'材料记录需要检查',source_type:null,stage:'ERROR',knowledge_count:null,action_count:null,error:{code:error?.code==='UNSAFE_PATH'?'UNSAFE_PATH':'STATE_CORRUPT'}});
      }
    }
    let view=await workspace.view({});
    if(captureStore){
      const captured=await captureStore.actionView({});
      for(const action of captured.actions){
        const snapshot=view.snapshots.find(s=>s.items.some(item=>item.action_id===action.id));
        if(snapshot){action.primary_source=snapshot.source;action.sync_status='PENDING_SYNC';}
      }
      view={...view,actions:[...view.actions,...captured.actions],focus:[...view.focus,...captured.focus].slice(0,3),suggestions:[...view.suggestions,...captured.suggestions].slice(0,3)};
    }
    let registered=null,registry_available=true;
    try {registered=(await loadRegistry()).registry;}catch {registry_available=false;}
    return {mode,configured:materialProcessingEnabled&&(mode==='demo'||Boolean(process.env.DEEPSEEK_API_KEY&&process.env.DEEPSEEK_MODEL)),vaultRoot,workspace:view,projects:projectCards(registered,view.projects),registry_available,materials,plans:(await writer.list()).filter(plan=>/^mat_[a-f0-9]{64}$/u.test(plan.material_id)).map(reviewed)};
  }
  async function body(req) {
    requireValue(req.headers['content-type']?.split(';')[0]==='application/json');
    const chunks=[];let size=0;
    for await(const chunk of req) {size+=chunk.length;requireValue(size<=1024*1024,'INPUT_TOO_LARGE');chunks.push(chunk);}
    try {const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));requireValue(value&&typeof value==='object'&&!Array.isArray(value));return value;} catch(error) {throw error.code?error:fail('INPUT_INVALID');}
  }
  async function mutate(url,input) {
    if(url==='/api/materials') {
      requireValue(materialProcessingEnabled,'PROCESSING_DISABLED');
      const allowed=['raw_content','source_type','source_title','source_url','source_id','captured_at'];
      requireValue(Object.keys(input).every(key=>allowed.includes(key)));
      requireValue(typeof input.raw_content==='string'&&Buffer.byteLength(input.raw_content)<=128*1024,'INPUT_TOO_LARGE');
      createMaterial(input);
      const response=await processMaterial(input,{dataDir,loadRegistry,organize:runOrganizer});
      if(response.status!=='ERROR') {
        const {result}=await savedMaterial(response.material_id);
        await workspace.ingestResult(result);
      }
      return response;
    }
    if(url==='/api/actions/decide'){
      if(typeof input.id==='string'&&input.id.startsWith('cact_')){requireValue(captureStore,'NOT_FOUND');return captureStore.decideAction(input);}
      return workspace.decide(input);
    }
    if(url==='/api/actions/source'){requireValue(captureStore,'NOT_FOUND');return captureStore.actionSource(input);}
    if(url==='/api/snapshots')return workspace.importSnapshot(Object.hasOwn(input,'text')?{source:input.source,updated_at:input.updated_at,items:parseSnapshotText(input.text)}:input);
    if(url==='/api/snapshots/link')return workspace.linkSnapshotItem(input);
    if(url==='/api/projects')return workspace.confirmProject(input);
    if(url==='/api/knowledge/prepare') {
      const {result}=await savedMaterial(input.material_id);
      requireValue(result&&Array.isArray(input.selections)&&input.selections.length>0&&input.selections.length<=100);
      const indices=new Set(),changes=new Map();
      for(const selection of input.selections) {
        requireValue(Number.isInteger(selection.index)&&!indices.has(selection.index));indices.add(selection.index);
        const c=result.knowledge_candidates[selection.index];requireValue(c);
        const relative=safeRelative(selection.relative_path,c.knowledge_layer);
        const evidence=c.evidence.map(e=>`- 原文第 ${e.line_start}–${e.line_end} 行\n${e.snippet.split('\n').map(line=>'> '+line).join('\n')}`).join('\n');
        const content=`\n\n## ${cleanTitle(c.title)}\n\n${c.content}\n\n来源材料：\`${c.material_id}\`\n\n${evidence}\n`;
        let change=changes.get(relative);
        if(!change) {change={knowledge_layer:c.knowledge_layer,relative_path:relative,content:'',candidate_ids:[]};changes.set(relative,change);}
        change.content+=content;change.candidate_ids.push(`${c.material_id}:knowledge:${selection.index}`);
      }
      return reviewed(await writer.prepare({materialId:input.material_id,changes:[...changes.values()]}));
    }
    if(url==='/api/knowledge/apply'||url==='/api/knowledge/rollback'){
      requireValue(knowledgeWriteEnabled,'REAL_WRITE_DISABLED');
      requireValue(typeof input.expectedReviewHash==='string'&&/^[0-9a-f]{64}$/u.test(input.expectedReviewHash),'CONFIRMATION_REQUIRED');
      const plan=(await writer.list()).find(p=>p.id===input.planId);
      requireValue(plan&&/^mat_[a-f0-9]{64}$/u.test(plan.material_id),'INPUT_INVALID');
      return reviewed(await writer[url.endsWith('apply')?'apply':'rollback'](input));
    }
    throw fail('NOT_FOUND');
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
    try {
      requireValue(origin&&req.headers.host===new URL(origin).host,'FORBIDDEN');
      requireValue(!req.headers.origin||req.headers.origin===origin,'FORBIDDEN');
      requireValue(!['cross-site'].includes(req.headers['sec-fetch-site']),'FORBIDDEN');
      const url=new URL(req.url,origin);requireValue(!url.search,'NOT_FOUND');
      if(captureApp&&url.pathname.startsWith('/capture/')){req.url=url.pathname.slice('/capture'.length);return captureApp.handle(req,res);}
      if(req.method==='GET') {
        if(Object.hasOwn(staticFiles,url.pathname)) {
          const [name,type]=staticFiles[url.pathname];let content=await fs.readFile(new URL('../../web/'+name,import.meta.url),'utf8');
          if(name==='index.html')content=content.replace('{{SESSION_TOKEN}}',token).replace('{{CAPTURE_NAV}}',captureApp?'<a href="/capture/">◎　主题整理与知识保存</a>':'');
          return send(200,content,type);
        }
        if(url.pathname==='/api/state')return send(200,await state());
        if(/^\/api\/materials\/mat_[0-9a-f]{64}$/u.test(url.pathname))return send(200,await savedMaterial(url.pathname.split('/').at(-1)));
        throw fail('NOT_FOUND');
      }
      requireValue(req.method==='POST','NOT_FOUND');
      requireValue(req.headers.origin===origin&&req.headers['x-app-token']===token,'FORBIDDEN');
      requireValue(!mutating,'BUSY');mutating=true;
      try {const input=await body(req);return send(200,await mutate(url.pathname,input));} finally {mutating=false;}
    } catch(error) {
      const known=['FORBIDDEN','BUSY','NOT_FOUND','INPUT_INVALID','INPUT_TOO_LARGE','STATE_CORRUPT','UNSAFE_PATH','CONFLICT','CONFIRMATION_REQUIRED','STORAGE_ERROR','DUPLICATE_CANDIDATE','TARGET_MISSING','REAL_WRITE_DISABLED','PROCESSING_DISABLED','STALE_INPUT','SOURCE_SCOPE_MISMATCH'];
      const code=known.includes(error?.code)?error.code:(error?.name==='AssertionError'?'INPUT_INVALID':'OPERATION_FAILED');
      const messages={CONFLICT:'文件、预览或清单快照已有较新版本，已拒绝覆盖。请核对当前内容和来源时间。',DUPLICATE_CANDIDATE:'所选候选已经保存或存在于另一计划，请仅选择尚未保存的候选。',CONFIRMATION_REQUIRED:'请重新打开具体变更预览，再确认保存。',BUSY:'当前有操作进行中，请稍后再试。',UNSAFE_PATH:'目标路径含不允许的目录或链接，已停止写入。',STATE_CORRUPT:'本地记录不完整或已损坏，已保留现场。'};
      messages.STALE_INPUT='来源或反馈已经变化，请刷新后核对当前行动；未覆盖已有决定。';
      messages.SOURCE_SCOPE_MISMATCH='当前状态含配置范围之外的来源，已停止读取；请核对运行范围。';
      send(code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:['BUSY','CONFLICT','STALE_INPUT'].includes(code)?409:400,{error:{code,message:messages[code]??'操作未完成，已保留现有数据。请检查输入或打开终端查看配置。'}});
    }
  });
  server.requestTimeout=135000;
  return {token,async listen(port=3210){requireValue(Number.isInteger(port)&&port>=0&&port<=65535);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;captureApp?.attach(origin);return origin;},async close(){server.closeIdleConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
