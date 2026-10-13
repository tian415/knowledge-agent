import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekProvider } from '../../src/intake/providers/deepseek.mjs';
const key='synthetic-canary-secret';
const env={DEEPSEEK_API_KEY:key,DEEPSEEK_MODEL:'test-model'};
const messages=[{role:'system',content:'Return JSON only'},{role:'user',content:'data'}];
const content='{"knowledge_candidates":[],"action_candidates":[]}';
const envelope=(extra={})=>({choices:[{finish_reason:'stop',message:{role:'assistant',content}}],usage:null,...extra});
const request=provider=>provider.generateJson({messages,signal:new AbortController().signal});
const safe=(e,code,count=1)=>e.code===code&&e.llm_requests===count&&!e.message.includes(key)&&!JSON.stringify(e).includes(key)&&!e.cause;

test('single configurable JSON request disables tools, strips response metadata and usage secrets',async()=>{
 let calls=0;
 const provider=createDeepSeekProvider({env:{...env,DEEPSEEK_BASE_URL:'https://example.invalid/v1/'},fetchImpl:async(url,options)=>{
  calls++; assert.equal(String(url),'https://example.invalid/v1/chat/completions');
  assert.equal(options.method,'POST'); assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,`Bearer ${key}`);
  const body=JSON.parse(options.body);
  assert.equal(body.model,'test-model'); assert.deepEqual(body.messages,messages);
  assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.tool_choice,'none');assert.equal(body.stream,false);
  assert.ok(!('tools' in body)&&!('functions' in body)); assert.ok(!options.body.includes(key));
  return new Response(JSON.stringify(envelope({secret:key,usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10,extra:key}})));
 }});
 assert.equal(calls,0);
 const result=await request(provider);
 assert.equal(calls,1);
 assert.deepEqual(result,{text:content,usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10},llm_requests:1});
});
test('default API root and missing usage are normalized without probing network',async()=>{
 const provider=createDeepSeekProvider({env,fetchImpl:async url=>{
  assert.equal(String(url),'https://api.deepseek.com/chat/completions');
  const body=envelope();delete body.usage;return new Response(JSON.stringify(body));
 }});
 assert.equal((await request(provider)).usage,null);
});
for(const config of [{},{DEEPSEEK_MODEL:'x'},{DEEPSEEK_API_KEY:key},{...env,DEEPSEEK_API_KEY:' '},...['http://example.invalid','https://u:p@example.invalid','https://example.invalid/?key=x','https://example.invalid/#x','bad'].map(url=>({...env,DEEPSEEK_BASE_URL:url}))]) {
 test('invalid configuration fails before any HTTP '+JSON.stringify(Object.keys(config)),()=>{
  let calls=0;
  assert.throws(()=>createDeepSeekProvider({env:config,fetchImpl:()=>{calls++;}}),e=>safe(e,'PROVIDER_CONFIG_ERROR',0));
  assert.equal(calls,0);
 });
}
for(const status of [301,401,429,500,503])test(`HTTP ${status} is sanitized and never retried`,async()=>{
 let calls=0;
 const provider=createDeepSeekProvider({env,fetchImpl:async()=>{calls++;return new Response(key,{status});}});
 await assert.rejects(request(provider),e=>safe(e,'MODEL_ERROR'));assert.equal(calls,1);
});
const bad=[['bad envelope','broken','INVALID_OUTPUT'],['empty choices',{choices:[]},'INVALID_OUTPUT'],['multiple choices',{choices:[...envelope().choices,...envelope().choices]},'INVALID_OUTPUT'],['null content',{choices:[{finish_reason:'stop',message:{content:null}}]},'INVALID_OUTPUT'],['blank',{choices:[{finish_reason:'stop',message:{content:' '}}]},'INVALID_OUTPUT'],['truncated',{choices:[{finish_reason:'length',message:{content}}]},'INVALID_OUTPUT'],['tool',{choices:[{finish_reason:'tool_calls',message:{content,tool_calls:[{function:{name:'shell'}}]}}]},'UNSAFE_TOOL_USE'],['legacy function',{choices:[{finish_reason:'stop',message:{content,function_call:{name:'shell'}}}]},'UNSAFE_TOOL_USE']];
for(const [name,body,code] of bad)test(`${name} fails closed without second HTTP`,async()=>{
 let calls=0;const provider=createDeepSeekProvider({env,fetchImpl:async()=>{calls++;return new Response(typeof body==='string'?body:JSON.stringify(body));}});
 await assert.rejects(request(provider),e=>safe(e,code));assert.equal(calls,1);
});
test('network exception is sanitized without retry',async()=>{
 let calls=0;const provider=createDeepSeekProvider({env,fetchImpl:async()=>{calls++;throw new Error(key);}});
 await assert.rejects(request(provider),e=>safe(e,'MODEL_ERROR'));assert.equal(calls,1);
});
for(const phase of ['headers','body'])test(`cancellation covers ${phase} without retry`,async()=>{
 const controller=new AbortController();let calls=0;let started;
 const ready=new Promise(r=>{started=r;});
 const provider=createDeepSeekProvider({env,fetchImpl:async(url,{signal})=>{
  calls++;
  const stall=()=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error(key)),{once:true});started();});
  return phase==='headers'?stall():{ok:true,json:stall};
 }});
 const pending=provider.generateJson({messages,signal:controller.signal});
 const rejection=assert.rejects(pending,e=>safe(e,'MODEL_ERROR'));
 await ready;controller.abort();await rejection;assert.equal(calls,1);
});
test('already cancelled call sends zero requests',async()=>{
 let calls=0;const controller=new AbortController();controller.abort();
 const provider=createDeepSeekProvider({env,fetchImpl:async()=>{calls++;}});
 await assert.rejects(provider.generateJson({messages,signal:controller.signal}),e=>safe(e,'MODEL_ERROR',0));assert.equal(calls,0);
});
test('upstream content echoing the environment key is never returned',async()=>{
 let calls=0;
 const provider=createDeepSeekProvider({env,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({leak:key})}}]}));}});
 await assert.rejects(request(provider),e=>safe(e,'INVALID_OUTPUT'));assert.equal(calls,1);
});
