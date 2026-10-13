import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createMaterial, indexLines } from './material.mjs';
import { openStore } from './store.mjs';
import { candidateSchema, validateCandidates, attachLocations } from './candidates.mjs';
import { validateSchema } from '../shared/validate-schema.mjs';
import { PREFIXES, safeRelative } from '../shared/knowledge-paths.mjs';
import { loadRegistry as realRegistry, ROUTE_GROUPS, validateLifecycle } from '../registry/load-registry.mjs';
import { tokenUsage } from './llm-provider.mjs';
import { renderPreview } from './preview.mjs';

const zero = () => ({llm_requests:0,sdk_turns:0,input_bytes:0,elapsed_ms:0,usage:null,underlying_model_requests:null});
const failure = code => Object.assign(new Error(code),{code});
const messages={INPUT_INVALID:'输入参数或编码无效。',INPUT_TOO_LARGE:'输入超过大小限制；未自动截断或分批。',BUSY:'材料目录被锁定；请检查锁记录中的 PID，确认进程结束后再人工处理。',STATE_CORRUPT:'本地记录损坏；已保留现场，未重新整理。',STORAGE_ERROR:'本地保存失败；不标记本次处理成功。',REGISTRY_ERROR:'Registry 不可用或结构无效。',DAILY_LIMIT:'Asia/Shanghai 当日已达到 10 次尝试上限。',MODEL_ERROR:'整理请求失败；未自动重试。',INVALID_OUTPUT:'模型结果或来源证据无效。',UNSAFE_TOOL_USE:'模型工具调用被拒绝。',UNSAFE_PATH:'数据路径不符合安全要求。',PROVIDER_CONFIG_ERROR:'Provider 未配置；请检查环境配置。'};
const dateKey = date => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
function checkedMetrics(m) {
  assert(m && m.llm_requests===1 && m.sdk_turns===0 && m.underlying_model_requests===null);
  assert(Number.isInteger(m.input_bytes)&&m.input_bytes>=0&&Number.isFinite(m.elapsed_ms)&&m.elapsed_ms>=0);
  return {...zero(),llm_requests:1,input_bytes:m.input_bytes,elapsed_ms:m.elapsed_ms,usage:tokenUsage(m.usage)};
}
export function validateCachedResult(saved,material) {
  const output={knowledge_candidates:[],action_candidates:[]};
  const lines=indexLines(material.raw_content);
  if (saved.metrics.llm_requests!==undefined) assert([0,1].includes(saved.metrics.llm_requests));
  for (const group of Object.keys(output)) for (const candidate of saved[group]) {
    const {material_id,location,...raw}=candidate;
    assert.equal(material_id,material.material_id);
    if (group==='knowledge_candidates') {
      assert(location && Object.keys(location).sort().join(',')==='directory,reason,review_required,target_path');
      assert.equal(location.directory,PREFIXES[raw.knowledge_layer]);
      assert(typeof location.reason==='string'&&typeof location.review_required==='boolean');
      if(location.target_path!==null)safeRelative(location.target_path,raw.knowledge_layer);
    } else assert.equal(location,undefined);
    output[group].push(raw);
  }
  validateSchema(output,candidateSchema);
  for (const c of [...output.knowledge_candidates,...output.action_candidates]) for(const e of c.evidence) {
    assert(e.line_end>=e.line_start&&e.line_end<=lines.length);
    assert.equal(e.snippet,lines.slice(e.line_start-1,e.line_end).map(l=>l.text).join('\n'));
  }
}
function registryValid(value) {
  assert(value && value.registry && Array.isArray(value.warnings));
  const ids=new Set();
  for(const [type,group] of Object.entries(ROUTE_GROUPS)) {
    assert(Array.isArray(value.registry[group]));
    for(const entry of value.registry[group]) {
      assert(entry && entry.route_type===type && typeof entry.id==='string'&&entry.id.trim()&&typeof entry.name==='string'&&entry.name.trim());
      assert(!ids.has(entry.id));ids.add(entry.id);
    }
  }
  validateLifecycle(value.registry);
  // Real loader owns full Registry/path validation; never fall back to fixtures.
  return value;
}
async function dailyAttempts(dataDir,now) {
  const dir=path.join(dataDir,'attempts');
  let stat;
  try {stat=await fs.lstat(dir);}catch(e){if(e.code==='ENOENT')return 0;throw e;}
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700)throw failure('STATE_CORRUPT');
  let count=0;
  for(const name of await fs.readdir(dir)) {
    // Interrupted atomic-write temporary files are not committed attempts.
    if(/^\.[0-9a-f-]+\.tmp$/u.test(name))continue;
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/u.test(name))throw failure('STATE_CORRUPT');
    const handle=await fs.open(path.join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const st=await handle.stat();assert(st.isFile()&&st.nlink===1&&(st.mode&0o777)===0o600);
      const value=JSON.parse(await handle.readFile('utf8')),date=new Date(value.started_at);
      assert(value.attempt_id===name.slice(0,-5)&&/^mat_[0-9a-f]{64}$/u.test(value.material_id));
      assert(Number.isFinite(date.getTime())&&date.toISOString()===value.started_at&&value.budget_date===dateKey(date));
      assert(['STARTED','COMPLETED','FAILED'].includes(value.status));
      assert(value.status==='STARTED'?value.details===null:value.details?.status===value.status);
      if(value.budget_date===dateKey(now))count++;
    }catch{throw failure('STATE_CORRUPT');}finally{await handle.close();}
  }
  return count;
}

/** Composition boundary: caller supplies an Organizer already bound to a Provider. */
export async function processMaterial(input,{dataDir,loadRegistry=realRegistry,organize=async()=>{throw failure('PROVIDER_CONFIG_ERROR');},now=()=>new Date()}={}) {
  let material=null,store,locked=false,attempt=null,phase='INPUT_INVALID';
  let result={status:'ERROR',material_id:null,knowledge_candidates:[],action_candidates:[],metrics:zero(),warnings:[],error:null,previous_result_path:null};
  try {
    material=createMaterial(input);result.material_id=material.material_id;
    const received=now();assert(received instanceof Date&&Number.isFinite(received.getTime()));
    phase='STORAGE_ERROR';store=await openStore(dataDir);await store.acquireLock();locked=true;
    await store.saveMaterial(material);await store.addReceipt(material,received);
    const saved=await store.readResult(material.material_id);
    if(saved) {
      try{validateCachedResult(saved,material);}catch{throw failure('STATE_CORRUPT');}
      result.status='NO_CHANGE';result.previous_result_path=path.join(dataDir,'materials',material.material_id,'result.json');
    } else {
      phase='REGISTRY_ERROR';const loaded=registryValid(await loadRegistry());
      result.warnings=loaded.warnings.map(w=>({code:typeof w?.code==='string'?w.code:'REGISTRY_WARNING'}));
      if(Buffer.byteLength(material.raw_content,'utf8')>128*1024)throw failure('INPUT_TOO_LARGE');
      phase='STATE_CORRUPT';if(await dailyAttempts(dataDir,received)>=10)throw failure('DAILY_LIMIT');
      phase='STORAGE_ERROR';attempt=await store.beginAttempt(material.material_id,received);
      phase='MODEL_ERROR';
      const organized=await organize({material,registry:loaded.registry,registry_policy:loaded.registry_policy??{}});
      phase='INVALID_OUTPUT';result.metrics=checkedMetrics(organized.metrics);
      const validated=validateCandidates(organized.output,material,loaded.registry);
      phase='REGISTRY_ERROR';const located=await attachLocations(validated,loaded.registry);
      const success={...result,...located,status:'NEW'};
      const markdown=renderPreview({material,result:success});
      phase='STORAGE_ERROR';await store.saveResult(material.material_id,{material_id:material.material_id,content_hash:material.content_hash,stage:'PREVIEW_READY',...located,markdown,metrics:result.metrics});
      await store.finishAttempt(attempt,{status:'COMPLETED',metrics:result.metrics});
      attempt=null;result=success;
    }
  } catch(error) {
    const code=Object.hasOwn(messages,error?.code)?error.code:phase;
    if(error?.llm_requests===0||error?.llm_requests===1)result.metrics.llm_requests=error.llm_requests;
    result={...result,status:'ERROR',knowledge_candidates:[],action_candidates:[],error:{code,message:messages[code]}};
    if(attempt)try{await store.finishAttempt(attempt,{status:'FAILED',error:result.error,metrics:result.metrics});}catch{result.error={code:'STORAGE_ERROR',message:messages.STORAGE_ERROR};result.warnings.push({code:'ATTEMPT_RECORD_INCOMPLETE'});}
  } finally {
    if(locked)try{await store.releaseLock();}catch{result={...result,status:'ERROR',knowledge_candidates:[],action_candidates:[],error:{code:'STORAGE_ERROR',message:messages.STORAGE_ERROR}};}
  }
  return result;
}
