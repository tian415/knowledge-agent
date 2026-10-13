import http from 'node:http';import fs from 'node:fs/promises';import {randomBytes} from 'node:crypto';
import {check,fail} from './model.mjs';import {validateChatgptObservation} from './chatgpt.mjs';
const files={'/monitor.css':['monitor.css','text/css'],'/runs.html':['runs.html','text/html'],'/runs.js':['runs.js','text/javascript'],'/runtime.js':['runtime.js','text/javascript'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
export async function createCaptureApp({store,refreshCodex,publisher,publishedSearch,runtime,demoAdvance}){
 const token=randomBytes(32).toString('hex');let origin,base='/';
 async function body(req){check(req.headers['content-type']?.split(';')[0]==='application/json');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;check(size<=1024*1024,'INPUT_TOO_LARGE');chunks.push(chunk);}try{const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));check(input&&typeof input==='object'&&!Array.isArray(input));return input;}catch(e){throw e.code?e:fail('INPUT_INVALID');}}
 const routes={
  '/api/refresh/codex':async input=>{check(Object.keys(input).length===0);return refreshCodex();},
  '/api/observations/chatgpt':input=>store.ingest(validateChatgptObservation(input)),
  '/api/reviews':input=>store.putReview(input),
  '/api/decisions':input=>store.decide(input),
  '/api/topic-feedback':input=>store.recordTopicFeedback(input),
  '/api/topic-sources':input=>{check(Object.keys(input).length===1&&typeof input.topic_id==='string');return store.topicSources(input.topic_id);}
 };
 if(publishedSearch)routes['/api/published-search']=input=>publishedSearch.search(input);
 if(runtime?.demo&&demoAdvance)routes['/api/demo/advance']=input=>{check(Object.keys(input).length===0);return demoAdvance();};
 if(publisher)routes['/api/topic-preview']=input=>{check(Object.keys(input).length===1&&typeof input.topic_id==='string');return publisher.prepare(input);};
 if(publisher?.writeEnabled){
  const planInput=(input,topic)=>{
   const keys=['plan_id','expected_review_hash','confirmed',...(topic?['topic_id']:[])];
   check(Object.keys(input).length===keys.length&&keys.every(key=>Object.hasOwn(input,key)));
   check(typeof input.plan_id==='string'&&(!topic||typeof input.topic_id==='string'));
   check(input.confirmed===true&&typeof input.expected_review_hash==='string'&&/^[a-f0-9]{64}$/u.test(input.expected_review_hash),'CONFIRMATION_REQUIRED');
   return input;
  };
  routes['/api/topic-apply']=input=>publisher.apply(planInput(input,true));
  routes['/api/topic-rollback']=input=>publisher.rollback(planInput(input,false));
 }
 const server=http.createServer(async(req,res)=>{
  const send=(status,value,type='application/json')=>{res.writeHead(status,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(type==='application/json'?JSON.stringify(value):value);};
  try{check(origin&&req.headers.host===new URL(origin).host&&(!req.headers.origin||req.headers.origin===origin)&&req.headers['sec-fetch-site']!=='cross-site','FORBIDDEN');const url=new URL(req.url,origin);check(!url.search,'NOT_FOUND');
   if(req.method==='GET'){
    if(Object.hasOwn(files,url.pathname)){const [file,type]=runtime&&url.pathname==='/'?files['/runs.html']:files[url.pathname];let page=await fs.readFile(new URL('../../web/capture/'+file,import.meta.url),'utf8');if(file==='index.html'||file==='runs.html')page=page.replace('{{SESSION_TOKEN}}',token);if(type==='text/html')page=page.replace('<head>','<head><base href="'+base+'">').replaceAll('href="/style.css"','href="style.css"').replaceAll('src="/runs.js"','src="runs.js"').replaceAll('src="/runtime.js"','src="runtime.js"');return send(200,page,type);}
    if(url.pathname==='/api/runtime')return send(200,runtime??{configured:false,cadence_days:10,scheduler_enabled:false,semantic_executor:'codex-assisted',jev:'not_connected',vault_write_enabled:false});
    if(url.pathname==='/api/topic-previews')return send(200,publisher?await publisher.list():{mode:'unconfigured',plans:[]});
    if(url.pathname==='/api/processing')return send(200,await store.processingStatus());
    if(url.pathname==='/api/state'){const state=await store.view();const versions=state.sources.flatMap(s=>s.messages.flatMap(m=>m.versions));return send(200,{...state,metrics:{message_versions:versions.length,text_bytes:versions.reduce((n,v)=>n+Buffer.byteLength(v.message.text),0),state_bytes:Buffer.byteLength(JSON.stringify(state)+'\n')}});}throw fail('NOT_FOUND');
   }
   check(req.method==='POST','METHOD_NOT_ALLOWED');check(Object.hasOwn(routes,url.pathname),'NOT_FOUND');check(req.headers.origin===origin&&req.headers['x-app-token']===token,'FORBIDDEN');return send(200,await routes[url.pathname](await body(req)));
  }catch(e){const code=['FORBIDDEN','NOT_FOUND','METHOD_NOT_ALLOWED','INPUT_TOO_LARGE','INPUT_INVALID','INVALID_EVIDENCE','CONTEXT_REQUIRED','BUSY','STATE_CORRUPT','UNSAFE_PATH','SOURCE_INVALID','SOURCE_TOO_LARGE','SOURCE_CHANGED','SOURCE_SCOPE_MISMATCH','TARGET_REQUIRED','MERGE_REQUIRED','STALE_INPUT','PLAN_MISMATCH','CONFLICT','RECOVERY_REQUIRED','CONFIRMATION_REQUIRED','REAL_WRITE_DISABLED','REVIEW_REQUIRED','FEEDBACK_CONFLICT','SEARCH_UNAVAILABLE','SEARCH_TOO_LARGE'].includes(e.code)?e.code:'OPERATION_FAILED';send(({FORBIDDEN:403,NOT_FOUND:404,METHOD_NOT_ALLOWED:405,INPUT_TOO_LARGE:413,BUSY:409,CONFLICT:409,RECOVERY_REQUIRED:409,REVIEW_REQUIRED:409,FEEDBACK_CONFLICT:409})[code]??400,{error:{code}});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 return {token,attach(url){check(/^http:\/\/127\.0\.0\.1:\d+$/u.test(url));origin=url;base='/capture/';},handle(req,res){server.emit('request',req,res);},async listen(port=0){check(Number.isInteger(port)&&port>=0&&port<=65535);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;return origin;},async close(){server.closeIdleConnections();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
