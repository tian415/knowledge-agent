const $=selector=>document.querySelector(selector);
const token=$('meta[name="app-token"]').content;
const demoText='用户：哈希应使用原始字节，不能先清洗原文。\n助手：可以考虑为重复输入增加一次验证。\n用户：先了解这个方案，我还没有决定执行。';
let currentState=null,pendingPlan=null,pendingOperation='apply',toastTimer,fileOriginal=null,fileReadVersion=0,invalidFile=false;
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
async function api(url,input){const response=await fetch(url,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-app-token':token},body:JSON.stringify(input)});const value=await response.json();if(!response.ok||value.status==='ERROR')throw new Error(value.error?.message+' ['+(value.error?.code??response.status)+']');return value;}
function button(text,run,kind='secondary'){const node=el('button',text,'button '+kind);node.type='button';node.addEventListener('click',()=>busy(node,run));return node;}
async function busy(node,run){node.disabled=true;try{await run();}catch(error){toast(error.message);}finally{node.disabled=false;}}
function empty(parent,text){parent.replaceChildren(el('div',text,'empty'));}
const labels={SUGGESTION:'尚未采纳的建议',COMMITMENT:'明确承诺候选',FOLLOW_UP:'跟进候选',SUGGESTED:'待采纳',PROPOSED:'待审核',NEEDS_CONFIRMATION:'待确认',ACCEPTED:'已确认',ACTIVE:'进行中',OPEN:'进行中',COMPLETED:'已完成',CANCELLED:'已取消',SUPERSEDED:'已替代',DEFERRED:'已暂缓',DISMISSED:'已忽略',PREPARED:'待确认保存',APPLIED:'已保存',PARTIAL:'部分完成，需恢复',ROLLED_BACK:'已恢复'};
function showEvidence(parent,evidence){
 if(!evidence)return;const details=el('details');details.append(el('summary','查看来源依据'));
 if(typeof evidence==='string')details.append(el('pre',evidence));
 else for(const quote of evidence){details.append(el('small',quote.message_id?`对话消息：${quote.message_id}`:`原文第 ${quote.line_start}–${quote.line_end} 行`),el('pre',quote.snippet));}
 parent.append(details);
}
function actionCard(action){const node=el('article',undefined,'item');node.append(el('span',labels[action.status]??action.status??'待确认','tag'),el('h3',action.action??action.title),el('p','提取时依据：'+(action.reason??''),'muted'));if(['COMPLETED','CANCELLED','SUPERSEDED','DEFERRED'].includes(action.source_status))node.append(el('p','原文状态信号：'+(labels[action.source_status]??action.source_status)+'；请结合来源核对。','muted'));if(action.type==='SUGGESTION'&&!action.formal)node.append(el('small','建议只有你采纳后才进入正式行动。'));if(action.sync_status)node.append(el('p','关联清单：'+action.primary_source+' · 待手动同步','muted'));showEvidence(node,action.evidence);const controls=el('div',undefined,'actions');
  if(action.capture){
    node.append(el('p',`${action.capture.system==='codex'?'Codex':'ChatGPT'} · ${action.capture.title}${action.related.route_name?' · '+action.related.route_name:''}`,'muted'));
    if(action.owner!=='user'&&!action.formal)node.append(el('p',action.owner==='other'?'来源指向他人的事项，未加入你的关注列表。若采纳，表示你选择承担这项行动。':'责任人尚不明确，未加入你的关注列表。若采纳，表示你选择承担这项行动。','notice'));
    if(action.stale)node.append(el('p','来源已变化或当前分析未再包含这条信号。旧依据和人工决定保留；待重新核对后才能采纳、完成或重开。','notice'));
  }
  const choices=action.status==='OPEN'?[['已完成','complete'],['暂缓一天','defer'],['取消','cancel']]:['COMPLETED','CANCELLED','DISMISSED','DEFERRED'].includes(action.status)?[['重新开启','reopen']]:action.type==='SUGGESTION'?[['采纳 / 确认','accept'],['暂缓一天','defer'],['忽略','dismiss']]:[['采纳 / 确认','accept'],['已完成','complete'],['暂缓一天','defer'],['取消','cancel']];
  for(const [label,decision] of choices){const control=button(label,async()=>{const input={id:action.id,decision};if(action.capture)input.expected_review_hash=action.review_hash;if(decision==='defer')input.until=new Date(Date.now()+86400000).toISOString();await api('/api/actions/decide',input);await refresh();toast('反馈已保存');});control.disabled=Boolean(action.stale&&['accept','complete','reopen'].includes(decision));controls.append(control);}
  controls.append(button(action.capture?'查看对话原文':'打开原始材料',()=>action.capture?openCapturedAction(action):openMaterial(action.material_id)));node.append(controls);return node;
}
function openCapturedAction(action){return navigateWorkbench('source',action.id);}
async function renderCapturedAction(action,epoch){
 const {snapshot,stale}=await api('/api/actions/source',{id:action.id,expected_review_hash:action.review_hash});
 if(epoch!==workbenchRouteEpoch)return;
 const parent=$('#review');parent.hidden=false;parent.replaceChildren(el('h2',snapshot.title),el('p',`${snapshot.messages.length} 条已读消息；${snapshot.completeness==='complete'?'来源声明完整':'仅代表已取得的范围，不是完整历史'}。${stale?'这份依据已有后续变化。':''}`,'muted'));
 for(const message of snapshot.messages)parent.append(el('h3',message.role==='user'?'用户':'助手'),el('pre',message.text));
}
async function refresh(){
 const readEpoch=++workbenchReadEpoch;workbenchLoadState='loading';workbenchLoadError='';currentState=null;
 await renderWorkbenchRoute({focus:false,reload:true});
 try{
  const state=await api('/api/state');if(readEpoch!==workbenchReadEpoch)return;
  currentState=state;const w=state.workspace;renderSnapshots(w);renderProjects(state);
  $('#mode-label').textContent=state.mode==='demo'?'隔离演示 · 模拟结果':'仅本机可访问';$('#demo-fill').hidden=state.mode!=='demo';
  const reviewMode=state.mode==='review'||state.mode==='isolated-review';
  $('#workbench-navigation a[href="#/intake"]').hidden=reviewMode;
  if(reviewMode){$('#notice').hidden=false;$('#notice').textContent=(state.mode==='isolated-review'?'隔离演示，所有内容均为合成样本。':'')+'行动、清单与项目阶段在这里按需处理；笔记变动和草稿审查请使用知识维护导航。';$('#overview-primary').textContent='查看草稿审查';$('#overview-primary').href='/capture/#/review';}else if(state.mode==='demo'){$('#notice').hidden=false;$('#notice').textContent='当前为隔离演示。示例与整理结果均为模拟数据，保存只影响临时 Vault；不能作为真实材料验收证据。';$('#outbound-note').textContent='演示只处理内置示例，不发送真实模型请求。点击“填入演示材料”体验完整流程。';}else if(!state.configured){$('#notice').hidden=false;$('#notice').textContent='尚未配置 DeepSeek。请在启动服务的终端设置 DEEPSEEK_API_KEY 和 DEEPSEEK_MODEL；已有材料与反馈仍可查看。';}
  $('#stats').replaceChildren(...[[state.materials.length,'份材料已收件'],[w.actions.filter(a=>!['COMPLETED','CANCELLED','DISMISSED','DEFERRED'].includes(a.status)).length,'项当前行动与候选'],[(state.projects??w.projects).length,'个项目与学习目标']].map(([n,label])=>{const node=el('div',undefined,'stat');node.append(el('strong',String(n)),el('span',label));return node;}));
  $('#focus').replaceChildren(...w.focus.map(actionCard));if(!w.focus.length)empty($('#focus'),'当前没有已确认的待推进行动。可在“行动与建议”中按需核对。');
  const coverage=w.coverage;$('#coverage').textContent=typeof coverage==='string'?coverage:(coverage?.message??JSON.stringify(coverage));
  const suggestionsIds=new Set(w.suggestions.map(a=>a.id));const archived=a=>['COMPLETED','CANCELLED','DISMISSED','DEFERRED'].includes(a.status);$('#action-archive').replaceChildren(...w.actions.filter(archived).map(actionCard));$('#action-list').replaceChildren(...w.actions.filter(a=>!suggestionsIds.has(a.id)&&!archived(a)&&(a.type!=='SUGGESTION'||a.formal||a.capture&&(a.stale||a.owner!=='user'))).map(actionCard));if(!$('#action-list').children.length)empty($('#action-list'),'当前没有待推进行动；已完成和暂缓的事项保留在下方。');
  $('#suggestions').replaceChildren(...w.suggestions.map(actionCard));if(!w.suggestions.length)empty($('#suggestions'),'暂时没有需要考虑的建议。');
  $('#material-list').replaceChildren(...state.materials.map(material=>{const node=el('article',undefined,'item');const row=el('div',undefined,'section-heading');const text=el('div');text.append(el('h3',material.title),el('small',material.error?'该记录需要检查；其他材料仍可使用。':`${material.source_type} · ${material.knowledge_count} 条知识候选 · ${material.action_count} 条行动候选`));row.append(text,button('查看材料',()=>openMaterial(material.id)));node.append(row);return node;}));if(!state.materials.length)empty($('#material-list'),reviewMode?'当前没有手动提交的材料。日常对话草稿可在“草稿审查”查看。':'当前没有已提交的材料。需要时可从“提交材料”保留原文。');
  $('#plan-list').replaceChildren(...state.plans.map(plan=>{const node=el('article',undefined,'item');node.append(el('span',labels[plan.status]??plan.status,'tag'),el('p',plan.id,'subtle'));const actions=el('div',undefined,'actions');actions.append(button('查看变更',()=>showPlan(plan)));if(['APPLIED','PARTIAL'].includes(plan.status))actions.append(button('恢复本次写入',()=>showPlan(plan,'rollback'),'secondary danger'));node.append(actions);return node;}));if(!state.plans.length)empty($('#plan-list'),'当前没有手动材料的保存记录。主题笔记变动请查看知识维护中的“保存记录”。');
  workbenchLoadState='ready';
  await renderWorkbenchRoute({focus:false,reload:true});
 }catch(error){
  if(readEpoch!==workbenchReadEpoch)return;
  currentState=null;workbenchLoadState='error';workbenchLoadError=error.message;
  await renderWorkbenchRoute({focus:false,reload:true});throw error;
 }
}
function openMaterial(id){return navigateWorkbench('material',id);}
async function renderMaterial(id,epoch){const {material,result}=await api('/api/materials/'+encodeURIComponent(id));if(epoch!==workbenchRouteEpoch)return;const parent=$('#review');parent.hidden=false;parent.replaceChildren(el('h2',material.source_title??'材料审核'));const source=el('details');source.append(el('summary','展开未经修改的原始材料'),el('pre',material.raw_content));parent.append(source);if(!result){parent.append(el('p','材料已接收，但整理尚未成功。请检查配置后手动重新提交；不会自动重试。'));return;}
  parent.append(el('p','逐条勾选要保存的知识，并核对目标文件。未选中的候选不会写入。','muted'));const selections=[];
  result.knowledge_candidates.forEach((candidate,index)=>{const node=el('article',undefined,'candidate');const label=el('label');const checkbox=document.createElement('input');checkbox.type='checkbox';label.append(checkbox,document.createTextNode(candidate.title));node.append(label,el('p',candidate.content),el('p',candidate.reason,'muted'));showEvidence(node,candidate.evidence);const location=el('label','保存位置（相对于 Vault）','path-label');const input=el('input');input.value=candidate.location.target_path??candidate.location.directory+candidate.title.replace(/[\\/:*?"<>|\r\n]/gu,'-').slice(0,70)+'.md';location.append(input);node.append(location);parent.append(node);selections.push({index,checkbox,input});});
  if(!result.knowledge_candidates.length)parent.append(el('p','这份材料没有知识候选；行动仍可独立审核。','muted'));
  else parent.append(button('预览选中知识的具体变更',async()=>{const selected=selections.filter(s=>s.checkbox.checked).map(s=>({index:s.index,relative_path:s.input.value}));if(!selected.length)throw new Error('先选中至少一条知识候选。');showPlan(await api('/api/knowledge/prepare',{material_id:id,selections:selected}));}));
  parent.append(el('h3','行动候选'));for(const candidate of result.action_candidates){const item=el('article',undefined,'candidate');item.append(el('span',labels[candidate.type]??candidate.type,'tag'),el('p',candidate.action),el('p',candidate.reason,'muted'));showEvidence(item,candidate.evidence);parent.append(item);}const actionLink=el('a','前往行动与建议');actionLink.href='#/actions';parent.append(el('p','行动的采纳、暂缓与完成反馈在“行动与建议”中处理。','muted'),actionLink);
}
function showPlan(plan,operation='apply'){
 pendingPlan=plan;pendingOperation=operation;const restoring=operation==='rollback';
 $('#plan-dialog h2').textContent=restoring?'核对本次恢复内容':'核对本次知识变更';
 $('#plan-dialog .muted').textContent=restoring?'确认后将恢复到这次写入之前。若文件已被后续修改，操作会拒绝覆盖。':'确认后才会写入下列文件；如果文件已被你修改，本次操作会拒绝覆盖。';
 $('#plan-preview').replaceChildren();
 for(const change of plan.changes??[]){const node=el('div');node.append(el('h3',change.relative_path));
 const before=restoring?change.after:change.before,after=restoring?change.before:change.after;
 node.append(el('small',restoring?'本次写入内容':'写入前'),el('pre',before===null?'（新文件）':before),el('small',restoring?'恢复后':'写入后'),el('pre',after===null?'（移除本次新建且未经后续修改的文件）':after));$('#plan-preview').append(node);}
 $('#confirm-plan').textContent=restoring?'确认恢复以上内容':'确认应用以上变更';
 $('#confirm-plan').disabled=restoring?!['APPLIED','PARTIAL'].includes(plan.status):['APPLIED','ROLLED_BACK'].includes(plan.status);
 $('#plan-dialog').showModal();
}
$('#confirm-plan').addEventListener('click',()=>busy($('#confirm-plan'),async()=>{
 const operation=pendingOperation;await api('/api/knowledge/'+operation,{planId:pendingPlan.id,confirmed:true,expectedReviewHash:pendingPlan.review_hash});
 $('#plan-dialog').close();await refresh();toast(operation==='rollback'?'恢复操作已完成':'知识已保存，操作记录已保留');
}));
$('#material-form').addEventListener('submit',event=>{event.preventDefault();const button=event.submitter;busy(button,async()=>{if(invalidFile)throw new Error('当前文件尚未成功导入。请重新选择文件或编辑原始内容后再提交。');const fields=new FormData(event.target);const input={raw_content:fileOriginal??fields.get('raw_content'),source_type:fields.get('source_type'),source_title:fields.get('source_title')||null,source_url:fields.get('source_url')||null};toast('正在整理。一次请求，完成后显示预览。');const result=await api('/api/materials',input);await refresh();await openMaterial(result.material_id);toast(result.status==='NO_CHANGE'?'发现相同材料，已复用原结果；没有新增模型请求。':'整理完成，请核对候选与来源。');});});
$('#material-file').addEventListener('change',async event=>{
 const version=++fileReadVersion;fileOriginal=null;invalidFile=true;
 const file=event.target.files[0];
 if(!file){invalidFile=false;$('#file-status').textContent='未选择文件，提交时使用文本框内容。';return;}
 $('#file-status').textContent='正在读取 '+file.name;
 try{
  if(file.size>128*1024)throw new Error('文件超过 128 KiB，请选择较小材料。');
  const bytes=await file.arrayBuffer();let raw;
  try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error('文件不是有效的 UTF-8 文本，请转换编码后重新导入。');}
  if(version!==fileReadVersion)return;
  fileOriginal=raw;invalidFile=false;$('#material-form [name=raw_content]').value=raw;$('#material-form [name=source_title]').value=file.name;
  $('#file-status').textContent=`已读取 ${file.name}（${file.size} 字节），保留原始换行与字节。`;
 }catch(error){if(version!==fileReadVersion)return;$('#file-status').textContent='导入失败，请重新选择文件或编辑文本；当前禁止提交。';toast(error.message);}
});
function useEditedText(){fileReadVersion++;fileOriginal=null;invalidFile=false;$('#material-file').value='';$('#file-status').textContent='提交时使用当前文本框内容。';}
$('#material-form [name=raw_content]').addEventListener('input',useEditedText);
$('#demo-fill').addEventListener('click',()=>{useEditedText();$('#material-form [name=raw_content]').value=demoText;$('#material-form [name=source_title]').value='演示：从原文保留工程原则';});
$('#snapshot-form').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{const form=new FormData(event.target);await api('/api/snapshots',{source:form.get('source'),updated_at:new Date(form.get('updated_at')).toISOString(),...(String(form.get('items')).trim().startsWith('[')&&!/^\[[ xX]\]/u.test(String(form.get('items')).trim())?{items:JSON.parse(form.get('items'))}:{text:form.get('items')})});await refresh();toast('快照已导入，外部清单未修改。');});});
$('#project-form').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{await api('/api/projects',Object.fromEntries(new FormData(event.target)));await refresh();toast('你确认的阶段与证据已保存。');});});
$('#today').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});

function renderProjects(state){
 const parent=$('#project-list');const cards=state.projects??state.workspace.projects;
 parent.replaceChildren(...cards.map(project=>{
  const node=el('article',undefined,'card');
  const kind=project.kind==='learning'?'学习':project.route_type==='CODE_PROJECT'?'代码项目':project.route_type==='KNOWLEDGE_PROJECT'?'知识项目':'项目';
  node.append(el('span',kind,'tag'),el('h3',project.name??project.goal??project.id));
  node.append(el('p',project.stage??'阶段尚未确认'));
  if(project.registry_status&&project.registry_status!=='active')node.append(el('small','登记状态：'+({reference:'参考资料',legacy:'历史项目'}[project.registry_status]??project.registry_status)));
  if(project.goal)node.append(el('p','目标：'+project.goal));
  if(project.blocker)node.append(el('p','当前阻碍：'+project.blocker));
  if(project.next_step)node.append(el('p','下一步：'+project.next_step));
  if(project.confirmed_at)node.append(el('small','确认于 '+new Date(project.confirmed_at).toLocaleString('zh-CN')));
  showEvidence(node,project.evidence);
  node.append(button(project.confirmed?'更新已确认阶段':'确认当前阶段',()=>{
   const form=$('#project-form');form.closest('details').open=true;
   for(const field of ['id','kind','goal','stage','blocker','next_step','evidence'])form.elements[field].value=project[field]??'';
   form.elements.kind.value=project.kind==='learning'?'learning':'project';
   form.scrollIntoView({behavior:'smooth',block:'start'});form.elements.goal.focus();
  }));return node;
 }));
 if(!cards.length)empty(parent,'尚无已登记项目。可在下方确认一个项目或学习目标。');
 if(state.registry_available===false)parent.prepend(el('p','项目目录暂时不可用；已确认的本地阶段仍保留。','notice'));
}
function renderSnapshots(workspace){
 const parent=$('#snapshot-list');parent.replaceChildren();
 for(const snapshot of workspace.snapshots){
  const card=el('article',undefined,'item');const coverage=workspace.coverage.sources.find(source=>source.source===snapshot.source);
  card.append(el('h3',snapshot.source),el('p','快照时间：'+new Date(snapshot.updated_at).toLocaleString('zh-CN')+(coverage?.stale?' · 已超过 7 天，可能过期':''),'muted'));
  card.append(el('small','只关联中心记录，不改变外部清单中的任务。'));
  for(const item of snapshot.items){
   const row=el('div',undefined,'snapshot-row');row.append(el('span',item.title),el('small','快照状态：'+item.status));
   const label=el('label','关联中心行动');const select=el('select');select.append(new Option('尚未关联',''));
   for(const action of workspace.actions)select.append(new Option(action.action,action.id));select.value=item.action_id??'';label.append(select);row.append(label);
   row.append(button('保存关联',async()=>{await api('/api/snapshots/link',{source:snapshot.source,item_id:item.id,action_id:select.value||null});await refresh();toast('关联已保存，外部清单未修改。');}));card.append(row);
  }
  parent.append(card);
 }
}

const workbenchViews={
 overview:{title:'今日工作台',description:'查看已确认的行动，按需核对材料和项目阶段。'},
 actions:{title:'行动与建议',description:'保留来源依据，按需确认、暂缓或完成。'},
 projects:{title:'项目与学习',description:'查看已登记项目；阶段由证据支持，不猜测完成百分比。'},
 materials:{title:'材料记录',description:'手动提交的材料与原文，按需进入详情核对。'},
 intake:{title:'提交材料',description:'保留原文，整理后再决定哪些内容值得保存。'},
 history:{title:'材料保存记录',description:'手动材料的保存与恢复记录；主题笔记变动在知识维护的“保存记录”。'}
};
let workbenchRouteEpoch=0,lastWorkbenchRoute='',workbenchReadEpoch=0,workbenchLoadState='loading',workbenchLoadError='';
function readWorkbenchRoute(){
 const [path,query='']=(location.hash.replace(/^#\/?/u,'')||'overview').split('?'),parts=path.split('/');
 if(parts.length===1&&Object.hasOwn(workbenchViews,path))return {view:path};
 if(parts.length===2&&['material','source'].includes(parts[0])){
  let id;try{id=decodeURIComponent(parts[1]);}catch{return {view:'missing'};}
  if(!/^[A-Za-z0-9_-]+$/u.test(id))return {view:'missing'};
  const from=new URLSearchParams(query).get('from');
  return {view:parts[0],id,from:Object.hasOwn(workbenchViews,from)?from:parts[0]==='source'?'actions':'materials'};
 }
 return {view:'missing'};
}
function navigateWorkbench(view,id){
 const current=readWorkbenchRoute(),from=current.from??(Object.hasOwn(workbenchViews,current.view)?current.view:'materials');
 const hash='#/'+view+(id?'/'+encodeURIComponent(id)+'?from='+encodeURIComponent(from):'');
 if(location.hash!==hash)history.pushState(null,'',hash);
 return renderWorkbenchRoute();
}
async function renderWorkbenchRoute({focus=true,reload=false}={}){
 if(!reload&&lastWorkbenchRoute===location.hash)return;
 lastWorkbenchRoute=location.hash;const epoch=++workbenchRouteEpoch,route=readWorkbenchRoute();
 const status=$('#workbench-load-status');
 if(workbenchLoadState!=='ready'){
  let focusWasInView=false;
  for(const view of document.querySelectorAll('[data-workbench-view]')){if(view.contains(document.activeElement))focusWasInView=true;view.hidden=true;}
  for(const link of document.querySelectorAll('#workbench-navigation a'))link.removeAttribute('aria-current');
  $('#workbench-navigation a[href="#/intake"]').hidden=true;
  $('#review').replaceChildren();if($('#plan-dialog').open)$('#plan-dialog').close();
  const failed=workbenchLoadState==='error',title=failed?'工作台暂不可用':'正在读取工作台';
  $('#page-title').textContent=title;$('#page-description').textContent=failed?'重新读取成功后，将回到当前分区。':'正在核对当前记录与可用功能。';document.title=title+' · 知识中心';
  status.hidden=false;status.setAttribute('role',failed?'alert':'status');
  status.replaceChildren(el('span',failed?'工作台状态读取失败：'+workbenchLoadError+'。':'正在读取工作台状态…'));
  if(failed)status.append(document.createTextNode(' '),button('重新读取',refresh));
  if(focus||focusWasInView)$('#page-title').focus({preventScroll:true});
  return;
 }
 status.hidden=true;status.setAttribute('role','status');status.replaceChildren();
 const reviewMode=['review','isolated-review'].includes(currentState?.mode);
 if(route.view==='intake'&&reviewMode)route.view='missing';
 const detail=['material','source'].includes(route.view),section=detail?'material-detail':Object.hasOwn(workbenchViews,route.view)?route.view:'route-missing';
 const selected=detail?route.from:route.view;
 for(const view of document.querySelectorAll('[data-workbench-view]'))view.hidden=view.id!==section;
 for(const link of document.querySelectorAll('#workbench-navigation a')){
  const active=link.getAttribute('href')==='#/'+selected&&!link.hidden;
  if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
 }
 const title=detail?(route.view==='source'?'对话来源':'材料详情'):workbenchViews[route.view]?.title??'分区暂不可用';
 $('#page-title').textContent=title;$('#page-description').textContent=detail?'核对已有原文与依据，返回后继续原分区。':workbenchViews[route.view]?.description??'可以从左侧导航重新选择一个分区。';
 document.title=title+' · 知识中心';
 if(focus){window.scrollTo(0,0);$('#page-title').focus({preventScroll:true});}
 if(!detail)return;
 const back=$('#detail-back');back.href='#/'+route.from;back.textContent='返回'+workbenchViews[route.from].title;
 const parent=$('#review');parent.replaceChildren(el('p','正在读取记录…','muted'));
 if(!currentState)return;
 try{
  if(route.view==='material')await renderMaterial(route.id,epoch);
  else{
   const action=currentState.workspace.actions.find(item=>item.id===route.id&&item.capture);
   if(!action){parent.replaceChildren(el('h2','未找到这项行动来源'),el('p','该行动可能已不在当前记录中。请返回原分区重新选择。'));return;}
   await renderCapturedAction(action,epoch);
  }
 }catch(error){
  if(epoch!==workbenchRouteEpoch)return;
  parent.replaceChildren(el('h2','记录暂时无法读取'),el('p',error.message,'muted'),button('重新读取',()=>renderWorkbenchRoute({focus:false,reload:true})));
 }
}
function initializeWorkbenchNavigation(){
 const capture=$('#capture-navigation');
 if(capture.querySelector('a[href="/capture/"]')){
  capture.replaceChildren(...[['overview','维护概览'],['review','草稿审查'],['history','保存记录'],['sources','来源与运行']].map(([route,title])=>{const link=el('a',title);link.href='/capture/#/'+route;return link;}));
  $('.brand').href='/capture/#/overview';
 }else capture.hidden=true;
 if(!location.hash)history.replaceState(null,'','#/overview');
 $('.skip-link').addEventListener('click',event=>{event.preventDefault();$('#workbench-main').focus({preventScroll:true});});
 const changed=()=>renderWorkbenchRoute();window.addEventListener('hashchange',changed);window.addEventListener('popstate',changed);
 renderWorkbenchRoute({focus:false});
}
initializeWorkbenchNavigation();
// refresh renders its error and retry control before rejecting to action callers.
refresh().catch(()=>{});
