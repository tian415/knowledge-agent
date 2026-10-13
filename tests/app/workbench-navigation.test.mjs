import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html=await fs.readFile(new URL('../../web/index.html',import.meta.url),'utf8');
const script=await fs.readFile(new URL('../../web/app.js',import.meta.url),'utf8');

// A small DOM boundary executes the shipped script and its actual HTML. Network
// reads are supplied here; no test invokes the application server or a Writer.
class Element {
 constructor(tag,document){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.attrs={};this.listeners={};this.hidden=false;this.text='';}
 get id(){return this.attrs.id??'';} set id(v){this.attrs.id=v;}
 get className(){return this.attrs.class??'';} set className(v){this.attrs.class=v;}
 get classList(){return {toggle:(name,on)=>{const names=new Set(this.className.split(/\s+/).filter(Boolean));if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');},contains:name=>this.className.split(/\s+/).includes(name)};}
 get textContent(){return this.text+this.children.map(c=>c.textContent).join('');} set textContent(v){this.text=String(v);this.children=[];}
 get href(){return this.attrs.href??'';} set href(v){this.attrs.href=v;}
 get hash(){return this.href.includes('#')?'#'+this.href.split('#')[1]:'';}
 get dataset(){return Object.fromEntries(Object.entries(this.attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));}
 get elements(){return Object.fromEntries(this.querySelectorAll('[name]').map(n=>[n.attrs.name,n]));}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='hidden')this.hidden=true;if(k==='content')this.content=String(v);}
 getAttribute(k){return this.attrs[k]??null;} removeAttribute(k){delete this.attrs[k];if(k==='hidden')this.hidden=false;}
 append(...nodes){for(let node of nodes){if(typeof node==='string'){const text=new Element('#text',this.ownerDocument);text.text=node;node=text;}node.remove();node.parentElement=this;this.children.push(node);}}
 prepend(...nodes){const old=[...this.children];this.children=[];this.append(...nodes,...old);}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text='';this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
 contains(node){return node===this||this.children.some(c=>c.contains(node));}
 matches(selector){
  const attrs=[...selector.matchAll(/\[([^\s=\]^]+)(\^?=)?["']?([^"'\]]*)["']?\]/g)];
  for(const [,key,operator,value] of attrs){if(!(key in this.attrs))return false;if(operator==='='&&this.attrs[key]!==value)return false;if(operator==='^='&&!this.attrs[key].startsWith(value))return false;}
  const plain=selector.replace(/\[[^\]]+\]/g,'');const id=plain.match(/#([\w-]+)/)?.[1];if(id&&this.id!==id)return false;
  for(const [,name] of plain.matchAll(/\.([\w-]+)/g))if(!this.classList.contains(name))return false;
  const tag=plain.match(/^[\w-]+/)?.[0];return !tag||tag.toUpperCase()===this.tagName;
 }
 querySelectorAll(selector){
  const parts=selector.replace(/>/g,' ').trim().split(/\s+/);const all=[];const visit=n=>{for(const c of n.children){all.push(c);visit(c);}};visit(this);
  return all.filter(node=>{if(!node.matches(parts.at(-1)))return false;let parent=node.parentElement;for(let i=parts.length-2;i>=0;i--){while(parent&&!parent.matches(parts[i]))parent=parent.parentElement;if(!parent)return false;parent=parent.parentElement;}return true;});
 }
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 closest(s){for(let node=this;node;node=node.parentElement)if(node.matches(s))return node;return null;}
 addEventListener(type,listener){(this.listeners[type]??=[]).push(listener);}
 focus(){this.ownerDocument.activeElement=this;} blur(){this.ownerDocument.activeElement=this.ownerDocument.querySelector('body');}
 scrollIntoView(){} showModal(){this.open=true;} close(){this.open=false;}
}
function documentFor(integrated){
 const document=new Element('#document');document.ownerDocument=document;document.createElement=tag=>new Element(tag,document);document.createTextNode=text=>{const n=document.createElement('#text');n.text=String(text);return n;};document.getElementById=id=>document.querySelector('#'+id);
 const stack=[document],source=html.replace('{{CAPTURE_NAV}}',integrated?'<a href="/capture/">主题整理与知识保存</a>':'').replace('{{SESSION_TOKEN}}','main-token');
 for(const token of source.match(/<[^>]+>|[^<]+/g)){
  if(token.startsWith('<!'))continue;if(token.startsWith('</')){stack.pop();continue;}
  if(token.startsWith('<')){const tag=token.match(/^<([\w-]+)/)[1],node=document.createElement(tag);for(const [,key,value] of token.slice(tag.length+1,-1).matchAll(/([\w-]+)(?:="([^"]*)")?/g))node.setAttribute(key,value??'');stack.at(-1).append(node);if(!['meta','link','input','br','hr','img'].includes(tag))stack.push(node);}
  else stack.at(-1).append(document.createTextNode(token));
 }
 document.activeElement=document.querySelector('body');return document;
}
const action={id:'cact_example',action:'核对来源',status:'OPEN',type:'COMMITMENT',capture:{system:'codex',title:'示例讨论'},related:{},review_hash:'version-one',owner:'user'};
const state=()=>({mode:'review',configured:false,materials:[],plans:[],projects:[],workspace:{projects:[],snapshots:[],actions:[action],suggestions:[],focus:[action],coverage:{message:'当前范围',sources:[]}}});
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
async function page(hash='#/overview',{integrated=true,sourceRead,stateRead,mode='review'}={}){
 const document=documentFor(integrated),listeners={},requests=[],location={hash},stack=[hash];let position=0;
 const history={pushState(_state,_title,next){location.hash=next;stack.splice(++position);stack.push(next);},replaceState(_state,_title,next){location.hash=next;stack[position]=next;}};
 const window={location,history,scrollTo(){},addEventListener(type,listener){(listeners[type]??=[]).push(listener);}};
 const context=vm.createContext({document,window,location,history,URLSearchParams,URL,encodeURIComponent,decodeURIComponent,Option:function(text,value){const n=document.createElement('option');n.textContent=text;n.value=value;return n;},setTimeout:()=>1,clearTimeout(){},fetch:async(url,options={})=>{requests.push({url,options});let value;if(url==='/api/state'){value=stateRead?await stateRead():state();if(!stateRead)value.mode=mode;}else if(url.startsWith('/api/materials/'))value={material:{source_title:'示例材料',raw_content:'原始内容'},result:null};else if(url==='/api/actions/source')value=sourceRead?await sourceRead():{snapshot:{title:'示例讨论',messages:[{role:'user',text:'示例原文'}],completeness:'partial'},stale:false};else throw Error('Unexpected request '+url);return {ok:true,json:async()=>value};}});
 vm.runInContext(script,context);await flush();
 const fire=async(type)=>{for(const listener of listeners[type]??[])listener({});await flush();};
 return {document,requests,location,context,async go(next){history.pushState(null,'',next);await fire('hashchange');},async back(){location.hash=stack[--position];await fire('popstate');},async forward(){location.hash=stack[++position];await fire('popstate');},run(code){return vm.runInContext(code,context);}};
}
const visible=p=>p.document.querySelectorAll('[data-workbench-view]').filter(n=>!n.hidden).map(n=>n.id);
const selected=p=>p.document.querySelectorAll('nav a[aria-current="page"]').map(n=>n.getAttribute('href'));

test('deep-linked sections are exclusive and browser back/forward restores one selection',async()=>{
 const p=await page('#/actions');assert.deepEqual(visible(p),['actions']);assert.deepEqual(selected(p),['#/actions']);
 await p.go('#/projects');assert.deepEqual(visible(p),['projects']);assert.deepEqual(selected(p),['#/projects']);
 await p.back();assert.deepEqual(visible(p),['actions']);assert.deepEqual(selected(p),['#/actions']);
 await p.forward();assert.deepEqual(visible(p),['projects']);
 assert.ok(p.requests.every(r=>!r.options.method),'section navigation must remain read-only');
});
test('integrated workbench exposes the same four monitor routes without selecting them',async()=>{
 const p=await page('#/overview');const links=p.document.querySelectorAll('#capture-navigation a');
 assert.deepEqual(links.map(n=>n.href),['/capture/#/overview','/capture/#/review','/capture/#/history','/capture/#/sources']);
 assert.deepEqual(selected(p),['#/overview']);assert.equal(p.document.querySelector('.brand').href,'/capture/#/overview');
 const standalone=await page('#actions',{integrated:false,mode:'demo'});assert.deepEqual(visible(standalone),['actions']);assert.deepEqual(selected(standalone),['#/actions']);
});
test('material details keep their origin in the URL and survive refresh',async()=>{
 const p=await page('#/actions');await p.run("openMaterial('mat_example')");await flush();
 assert.deepEqual(visible(p),['material-detail']);assert.match(p.location.hash,/material\/mat_example.*from=actions/);
 assert.equal(p.document.querySelector('#detail-back').href,'#/actions');assert.match(p.document.querySelector('#review').textContent,/示例材料/);
 const restored=await page(p.location.hash);assert.deepEqual(visible(restored),['material-detail']);assert.equal(restored.document.querySelector('#detail-back').href,'#/actions');
 await p.go(p.document.querySelector('#detail-back').href);assert.deepEqual(visible(p),['actions']);
});
test('source details retain action version and use only the existing source-read endpoint',async()=>{
 const p=await page('#/overview');assert.ok(p.requests.every(r=>!r.options.method));
 await p.run('openCapturedAction(currentState.workspace.actions[0])');await flush();
 assert.deepEqual(visible(p),['material-detail']);assert.equal(p.document.querySelector('#detail-back').href,'#/overview');
 const read=p.requests.find(r=>r.url==='/api/actions/source');assert.deepEqual(JSON.parse(read.options.body),{id:action.id,expected_review_hash:'version-one'});assert.equal(read.options.headers['x-app-token'],'main-token');
 const restored=await page(p.location.hash);assert.match(restored.document.querySelector('#review').textContent,/示例原文/);
 assert.ok(p.requests.every(r=>!r.url.includes('/knowledge/')));
});
test('leaving a view moves keyboard focus out of its hidden controls',async()=>{
 const p=await page('#/projects');const field=p.document.querySelector('#project-form [name="goal"]');field.focus();await p.go('#/actions');
 assert.ok(!p.document.querySelector('#projects').contains(p.document.activeElement));assert.equal(p.document.activeElement.id,'page-title');
});
test('unknown routes and disabled intake do not reveal unrelated content or trigger operations',async()=>{
 const p=await page('#/does-not-exist');assert.deepEqual(visible(p),['route-missing']);assert.deepEqual(selected(p),[]);
 await p.go('#/intake');assert.deepEqual(visible(p),['route-missing']);assert.equal(p.document.querySelector('#workbench-navigation a[href="#/intake"]').hidden,true);
 assert.ok(p.requests.every(r=>!r.options.method));
});
test('a late source response cannot replace the current section',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});const p=await page('#/actions',{sourceRead:()=>waiting});
 p.run('openCapturedAction(currentState.workspace.actions[0])');await flush();await p.go('#/projects');
 release({snapshot:{title:'迟到的详情',messages:[],completeness:'partial'},stale:false});await flush();
 assert.deepEqual(visible(p),['projects']);assert.deepEqual(selected(p),['#/projects']);assert.doesNotMatch(p.document.querySelector('#review').textContent,/迟到/);
});
test('pending state read keeps intake and every business section hidden until the mode is known',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});const p=await page('#/intake',{stateRead:()=>waiting});
 assert.deepEqual(visible(p),[]);assert.deepEqual(selected(p),[]);
 const status=p.document.querySelector('#workbench-load-status');assert.equal(status.hidden,false);assert.match(status.textContent,/正在读取/);
 assert.equal(p.document.querySelector('#workbench-navigation a[href="#/intake"]').hidden,true);
 release(state());await flush();assert.deepEqual(visible(p),['route-missing']);assert.equal(status.hidden,true);
 assert.ok(p.requests.every(r=>r.url==='/api/state'&&!r.options.method));
});
test('a route changed while the state read is pending is restored only after success',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});const p=await page('#/projects',{stateRead:()=>waiting});
 await p.go('#/actions');assert.deepEqual(visible(p),[]);
 release(state());await flush();assert.deepEqual(visible(p),['actions']);assert.deepEqual(selected(p),['#/actions']);
});
test('failed state reads hide forms and details; the visible retry recovers the current route',async()=>{
 for(const hash of ['#/intake','#/source/cact_example?from=actions']){
  let attempts=0;const p=await page(hash,{stateRead:async()=>{if(++attempts===1)throw Error('状态服务不可用');return state();}});
  assert.deepEqual(visible(p),[]);assert.deepEqual(selected(p),[]);
  const status=p.document.querySelector('#workbench-load-status');assert.equal(status.hidden,false);assert.equal(status.getAttribute('role'),'alert');assert.match(status.textContent,/读取失败/);
  assert.doesNotMatch(p.document.querySelector('#review').textContent,/正在读取/);
  assert.ok(p.requests.every(r=>r.url==='/api/state'&&!r.options.method));
  const retry=status.querySelector('button');assert.ok(retry);assert.equal(retry.textContent,'重新读取');
  for(const listener of retry.listeners.click)await listener({currentTarget:retry});await flush();
  assert.equal(attempts,2);assert.equal(status.hidden,true);
  assert.deepEqual(visible(p),hash.includes('/source/')?['material-detail']:['route-missing']);
  if(hash.includes('/source/'))assert.match(p.document.querySelector('#review').textContent,/示例原文/);
 }
});
test('a failed later refresh removes previously available business controls',async()=>{
 let attempts=0;const p=await page('#/projects',{stateRead:async()=>{if(++attempts>1)throw Error('刷新失败');return state();}});
 assert.deepEqual(visible(p),['projects']);
 await assert.rejects(p.run('refresh()'),/刷新失败/);assert.deepEqual(visible(p),[]);assert.deepEqual(selected(p),[]);
 await p.go('#/actions');assert.deepEqual(visible(p),[]);assert.match(p.document.querySelector('#workbench-load-status').textContent,/读取失败/);
});
