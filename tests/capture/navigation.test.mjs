import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../../web/capture/runs.js',import.meta.url),'utf8');
const prefix=source.slice(0,source.indexOf('async function refresh(){'));
function api(){
 const context=vm.createContext({URL,URLSearchParams,encodeURIComponent,decodeURIComponent});
 vm.runInContext(prefix+'\nglobalThis.routing={readRoute,routeHref,sourceGroup,exclusionText};',context);
 return context.routing;
}
test('shared detail URLs preserve identity and return destination through a fresh route read',()=>{
 const {readRoute,routeHref}=api();
 const href=routeHref('history','记录 / A?x#1','overview');
 const route=readRoute(href);
 assert.equal(route.view,'history');assert.equal(route.id,'记录 / A?x#1');assert.equal(route.from,'overview');
 assert.equal(readRoute('#/review/topic_123').id,'topic_123');
 assert.equal(readRoute('#/sources/source_123?filter=excluded').filter,'excluded');
});
test('old bookmarks resolve to true views; invalid paths do not choose another record',()=>{
 const {readRoute}=api();
 for(const [old,view] of [['#monitor-home','overview'],['#topic-review','review'],['#history','history'],['#sources','sources']])assert.equal(readRoute(old).view,view);
 assert.equal(readRoute('').view,'overview');
 assert.equal(readRoute('#/history/missing').id,'missing');
 assert.equal(readRoute('#/history/%broken').invalid,true);
 assert.equal(readRoute('#/invented').invalid,true);
 assert.equal(readRoute('#/constructor').invalid,true);
 assert.equal(readRoute('#/overview/unexpected').invalid,true);
 assert.equal(readRoute('#/review/t?from=outside').from,'review');
});

class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.text='';this.className='';this.classList={toggle:(name,on)=>{const values=new Set(this.className.split(' ').filter(Boolean));on?values.add(name):values.delete(name);this.className=[...values].join(' ');}};}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return this.text+this.children.map(x=>x.textContent??x).join('');}
 set innerHTML(_){throw Error('HTML injection is not allowed');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=[];this.text='';this.append(...children);}
 setAttribute(k,v){this.attributes[k]=v;}
 getAttribute(k){return this.attributes[k]??null;}
 removeAttribute(k){delete this.attributes[k];}
 addEventListener(){}
 focus(){this.focused=true;}
 querySelector(selector){return this.children.find(x=>selector.startsWith('.')?x.className?.split(' ').includes(selector.slice(1)):x.tag===selector)??null;}
}
async function browserBoundary(){
 const html=await fs.readFile(new URL('../../web/capture/runs.html',import.meta.url),'utf8');
 const ids=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
 const sections=[...html.matchAll(/<section id="([^"]+)" data-view="([^"]+)"/g)].map(m=>{const node=ids.get(m[1]);node.dataset.view=m[2];return node;});
 const links=[...html.matchAll(/data-view-link="([^"]+)"/g)].map(m=>{const node=new Element('a');node.dataset.viewLink=m[1];return node;});
 const banner=new Element(),requests=[],history=[];
 const window={location:{hash:'#/overview'},history:{pushState(_state,_title,hash){window.location.hash=hash;history.push(hash);}},scrollTo(){}};
 const document={title:'',createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),querySelector:s=>s==='.write-banner'?banner:ids.get(s.slice(1)),querySelectorAll:s=>s==='[data-view]'?sections:s==='[data-view-link]'?links:[]};
 const context=vm.createContext({document,window,URL,URLSearchParams,encodeURIComponent,decodeURIComponent,fetch:async url=>{requests.push(url);throw Error('offline');}});
 vm.runInContext(source.slice(0,source.indexOf('const reload=()=>'))+'\nglobalThis.ui={renderRoute,navigate,refresh,setData(value){pageData=value;loadError=null;}};',context);
 context.ui.setData({runtime:{},plans:[],data:{jobs:[],topics:[]}});
 return {ui:context.ui,window,sections,links,ids,requests,history};
}
test('navigation replaces the active view; history restoration does not push another entry or write data',async()=>{
 const b=await browserBoundary();
 for(const view of ['overview','review','history','sources']){
  b.ui.navigate('#/'+view);
  assert.deepEqual(b.sections.filter(x=>!x.hidden).map(x=>x.dataset.view),[view]);
  assert.deepEqual(b.links.filter(x=>x.getAttribute('aria-current')==='page').map(x=>x.dataset.viewLink),[view]);
 }
 const count=b.history.length;b.window.location.hash='#/review';b.ui.renderRoute(true);
 assert.equal(b.history.length,count);assert.equal(b.ids.get('view-title').textContent,'草稿审查');
 b.ui.navigate('#/history/missing?from=overview');
 assert.match(b.ids.get('save-history').textContent,/记录当前不可用/);
 assert.equal(b.ids.get('detail-back').href,'#/overview');
 assert.deepEqual(b.requests,[]);
});
test('a failed refresh hides previous records and reports unknown state instead of a healthy zero',async()=>{
 const b=await browserBoundary();b.ui.renderRoute();await b.ui.refresh();
 assert.equal(b.sections.filter(x=>!x.hidden).length,0);
 assert.match(b.ids.get('navigation-message').textContent,/当前数据状态未知/);
 assert.equal(b.ids.get('reload').disabled,false);
 assert.deepEqual(b.requests,['api/runtime','api/topic-previews','api/processing']);
});
test('excluded material, ordinary waiting, and actionable exceptions remain distinct',()=>{
 const {sourceGroup}=api();
 assert.equal(sourceGroup({status:'blocked',gaps:['automated_session_excluded']}),'excluded');
 assert.equal(sourceGroup({status:'blocked',reason:'来源上下文缺失'}),'attention');
 assert.equal(sourceGroup({status:'queued'}),'queue');
 assert.equal(sourceGroup({status:'running'}),'queue');
 assert.equal(sourceGroup({status:'completed'}),'normal');
});

test('all four navigation destinations are separate sections, not nested disclosures',async()=>{
 const html=await fs.readFile(new URL('../../web/capture/runs.html',import.meta.url),'utf8');
 for(const view of ['overview','review','history','sources']){
  assert.match(html,new RegExp('href="#/'+view+'"[^>]*data-view-link="'+view+'"'));
  assert.match(html,new RegExp('<section[^>]*data-view="'+view+'"'));
 }
 assert.doesNotMatch(html,/<details[^>]*id="(?:topic-review|history|sources)"/);
 assert.match(html,/id="detail-back"/);
 assert.match(source,/addEventListener\('hashchange'/);
 assert.match(source,/addEventListener\('popstate'/);
});

test('exclusion counts come from the discovery report, not an already-filtered job list',()=>{
 const {exclusionText}=api();assert.match(exclusionText({excluded:7}),/排除 7 项/);assert.match(exclusionText(null),/未知/);assert.match(exclusionText({}),/未知/);
});
