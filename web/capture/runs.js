const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const labels={queued:'等待整理',running:'等待整理结果',completed:'已整理',blocked:'需要补读或核对',needs_update:'相关对话有变化，等待更新',review_required:'改稿等待内容复核',dismissed:'本轮已忽略'};
let writeEnabled=false,searchEpoch=0,pageData=null,loadError=null,refreshVersion=0;
const errors={MERGE_REQUIRED:'现有笔记需要人工合并，未覆盖任何内容。',CONFLICT:'笔记已被修改，已拒绝覆盖。请先核对当前文件。',RECOVERY_REQUIRED:'上次写入需要核对，请查看保存记录。',STALE_INPUT:'相关对话已变化，请先更新主题并重新预览。',TARGET_REQUIRED:'尚未配置这个主题的笔记位置。',CONFIRMATION_REQUIRED:'确认已失效，请重新预览并勾选确认。',BUSY:'另一个操作正在进行，请稍后重试。',REAL_WRITE_DISABLED:'当前运行配置只允许预览。',NOT_FOUND:'当前服务尚未配置这项操作。'};
async function post(route,input){
 const response=await fetch(route.replace(/^\//u,''),{method:'POST',headers:{'content-type':'application/json','x-app-token':document.querySelector('meta[name="app-token"]').content},body:JSON.stringify(input)});
 const result=await response.json();if(!response.ok)throw Error(result.error?.code);return result;
}
errors.FEEDBACK_CONFLICT='反馈已被更新，请刷新后再修改；本次内容未覆盖新反馈。';
errors.REVIEW_REQUIRED='这份草稿已有改稿或忽略反馈，请先完成复核并重新预览。';
function feedbackControls(card,topic){
 const feedback=topic.feedback;
 const send=async(action,values,button,message)=>{
  button.disabled=true;
  try{
   await post('api/topic-feedback',{id:topic.id,expected_feedback_id:feedback?.id??null,action,title:'',markdown:'',reason:action==='dismiss'?'用户选择本轮忽略。':'用户恢复原草稿，保留先前反馈。',...values});
   document.querySelector('#action-status').textContent=({edit:'改稿已保存，等待 Codex 核对内容。旧保存确认已失效。',dismiss:'本轮已忽略，原稿和反馈记录保留。',reopen:'已恢复原草稿，请重新核对保存预览。'})[action];
   await refresh();
  }catch(e){message.textContent=errors[e.message]??'反馈未保存，请保留输入并检查本地服务。';button.disabled=false;}
 };
 if(topic.status!=='dismissed'){
  const editor=el('details'),form=el('form'),message=el('p');editor.className='topic-editor';editor.append(el('summary','修改内容'));
  const field=(caption,tag,value,max)=>{const label=el('label',caption),input=el(tag);input.value=value;input.required=true;input.maxLength=max;label.append(input);form.append(label);return input;};
  const title=field('草稿标题','input',feedback?.action==='edit'?feedback.title:topic.title,256);
  const markdown=field('草稿正文','textarea',feedback?.action==='edit'?feedback.markdown:topic.result.markdown,100000);markdown.rows=10;
  const reason=field('修改说明','textarea',feedback?.action==='edit'?feedback.reason:'',4000);reason.rows=2;
  form.append(el('p','提交后由 Codex 核对新增主张与原文。改稿不会直接写入笔记，也不会被标为已验证内容。'));
  const submit=el('button','提交改稿，等待复核');submit.type='submit';form.append(submit,message);
  form.addEventListener('submit',event=>{event.preventDefault();send('edit',{title:title.value,markdown:markdown.value,reason:reason.value},submit,message);});editor.append(form);card.append(editor);
 }
 const controls=el('div'),message=el('p');controls.className='actions topic-secondary-actions';
 if(topic.status!=='dismissed'){
  const dismiss=el('button','本轮忽略');dismiss.addEventListener('click',()=>send('dismiss',{},dismiss,message));controls.append(dismiss);
 }
 if(feedback&&['edit','dismiss'].includes(feedback.action)){
  const reopen=el('button',feedback.action==='edit'?'放弃改稿，恢复原草稿':'恢复原草稿');reopen.addEventListener('click',()=>send('reopen',{},reopen,message));controls.append(reopen);
 }
 const more=el('details');more.className='topic-options';more.append(el('summary','更多操作'),controls,message);card.append(more);
}
function confirmAction(parent,plan,restore=false){
 if(!writeEnabled||(!restore&&(plan.status==='APPLIED'||plan.status==='ROLLED_BACK'||plan.stale)))return;
 const form=el('form'),label=el('label'),check=el('input');check.type='checkbox';check.required=true;
 const initializes=!restore&&plan.changes?.[0]?.operation==='managed-topic-adopt';
 label.append(check,document.createTextNode(initializes?' 我已核对原文与新增区块，确认仅将指定补充区块交给此主题维护':restore?' 我已核对恢复范围，确认撤销这次写入':' 我已核对目标与正文，确认保存本次变更'));
 const button=el('button',restore?'确认恢复本次写入':'确认保存到笔记'),message=el('p');button.type='submit';
 if(initializes)form.append(el('p','接管已保存的追加内容：只增加管理标记，不重复追加或改写正文；旧 pk 区块仍由人工维护。'));
 form.append(el('p',`目标知识库：${plan.vault_root}`),label,el('br'),button,message);
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(!check.checked)return;button.disabled=true;
  try{
   const input={plan_id:plan.id,expected_review_hash:plan.review_hash,confirmed:true};if(!restore)input.topic_id=plan.topic_id;
   const result=await post(restore?'/api/topic-rollback':'/api/topic-apply',input);
   if(result.status!==(restore?'ROLLED_BACK':'APPLIED'))throw Error('RECOVERY_REQUIRED');
   document.querySelector('#action-status').textContent=restore?'已恢复这次写入，恢复记录已保留。':'已保存到笔记，变更与来源记录已保留。';
   await refresh();
  }catch(e){message.textContent=errors[e.message]??'操作未完成，请核对保存记录；系统未自动重试。';button.disabled=false;}
 });parent.append(form);
}
// Construct text nodes only; neither source HTML nor Markdown can execute code.
function renderInline(parent,text){
 const pattern=/`([^`]+)`|\*\*([^*]+)\*\*/gu;let end=0;
 for(const match of text.matchAll(pattern)){
  if(match.index>end)parent.append(document.createTextNode(text.slice(end,match.index)));
  const node=el(match[1]!==undefined?'code':'strong');
  if(match[1]!==undefined)node.textContent=match[1];else renderInline(node,match[2]);
  parent.append(node);end=match.index+match[0].length;
 }
 if(end<text.length)parent.append(document.createTextNode(text.slice(end)));
}
function renderText(parent,markdown){
 let list=null,listTag=null,fence=false,code=[];
 for(const line of markdown.split('\n')){
  if(/^\s*```/u.test(line)){
   if(fence){const pre=el('pre');pre.append(el('code',code.join('\n')));parent.append(pre);fence=false;code=[];}
   else {fence=true;list=null;}
   continue;
  }
  if(fence){code.push(line);continue;}
  if(/^<!-- knowledge-agent:topic:v1 [a-f0-9]{64} (begin|end) -->$/u.test(line))continue;
  if(!line.trim()){list=null;continue;}
  const item=line.match(/^(?:[-*] |\d+\. )(.*)$/u);
  if(item){const tag=/^\d/u.test(line)?'ol':'ul';if(!list||listTag!==tag){list=el(tag);listTag=tag;parent.append(list);}const li=el('li');renderInline(li,item[1]);list.append(li);continue;}
  list=null;
  if(/^---+$/u.test(line)){parent.append(el('hr'));continue;}
  const heading=line.match(/^(#{1,3}) (.*)$/u);
  const node=el(heading?'h'+Math.min(heading[1].length+1,4):line.startsWith('> ')?'blockquote':'p');
  renderInline(node,heading?heading[2]:line.startsWith('> ')?line.slice(2):line);parent.append(node);
 }
 if(fence){const pre=el('pre');pre.append(el('code',code.join('\n')));parent.append(pre);}
}
function changedLines(before,after){
 const left=(before??'').split('\n'),right=after.split('\n');let start=0;
 while(start<left.length&&start<right.length&&left[start]===right[start])start++;
 let leftEnd=left.length,rightEnd=right.length;
 while(leftEnd>start&&rightEnd>start&&left[leftEnd-1]===right[rightEnd-1]){leftEnd--;rightEnd--;}
 return {removed:left.slice(start,leftEnd).join('\n'),added:right.slice(start,rightEnd).join('\n')};
}
function renderPreview(preview,plan){
 preview.replaceChildren(el('p',plan.status==='APPLIED'?'此版本已保存。':plan.status==='ROLLED_BACK'?'此写入已恢复。':'本次变更预览，尚未保存。'));
 for(const change of plan.changes){
  const updating=change.before!==null;preview.append(el('p',`${updating?'更新':'新建'}笔记：${change.relative_path}`));
  if(updating){
   const before=el('details');before.append(el('summary','修改前'));renderText(before,change.before);preview.append(before);
   const delta=changedLines(change.before,change.after),difference=el('details');difference.open=true;difference.append(el('summary','本次行变化'));
   if(delta.removed){difference.append(el('h4','移除或替换'));difference.append(el('pre',delta.removed));}
   if(delta.added){difference.append(el('h4','新增或替换'));difference.append(el('pre',delta.added));}
   preview.append(difference);
  }
  const after=el('details');after.open=!updating;after.append(el('summary',updating?'修改后':'将保存的完整内容'));renderText(after,change.after);preview.append(after);
 }
 confirmAction(preview,plan);
}
function topicCard(topic){
 const card=el('article');card.className='card topic-card';
 const meta=el('div'),count=el('span',`${topic.source_count} 段来源`),state=el('span',labels[topic.status]??topic.status);
 meta.className='topic-meta';state.className='topic-state';meta.append(count,state);card.append(meta);
 const body=el('div');body.className='topic-body';renderText(body,topic.result.markdown);card.append(body);
 if(['review_required','dismissed'].includes(topic.status)){
  const note=el('p',labels[topic.status]+'。这份原稿暂不可保存。');note.className='warning';card.append(note);
  if(topic.feedback?.action==='edit'){
   const proposal=el('details');proposal.open=true;proposal.append(el('summary','待复核改稿'),el('p',topic.feedback.reason));renderText(proposal,topic.feedback.markdown);card.append(proposal);
  }
 }
 const evidence=el('details');evidence.className='topic-evidence';evidence.append(el('summary','查看来源'));
 const layerNames={PROJECT_KNOWLEDGE:'项目沉淀',ENGINEERING_THINKING:'工程方法',PRODUCT_THINKING:'产品方法',GENERAL_KNOWLEDGE:'长期知识'};
 if(topic.routing)card.append(el('p',`分类：${layerNames[topic.routing.knowledge_layer]} · ${topic.routing.units.length} 个知识点来源`));
 for(const source of topic.sources){
  evidence.append(el('h3',/^[a-f0-9-]{36}$/u.test(source.title)?'Codex 项目讨论':source.title));
  evidence.append(el('p',`${source.system==='chatgpt'?'ChatGPT':'Codex'} · ${source.completeness==='complete'?'来源声明完整':'基于已读取的对话范围'}`));
  const summary=topic.result.source_summaries?.find(s=>s.job_id===source.id)?.summary;
  if(summary)evidence.append(el('p',summary));
  if(source.dates?.length)evidence.append(el('p',source.dates[0]+(source.dates.at(-1)!==source.dates[0]?'—'+source.dates.at(-1):'')));
  try{const url=new URL(source.url);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){const link=el('a','打开原对话');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';evidence.append(link);}}catch{}
 }
 const audit=el('details');audit.append(el('summary','核验记录'),el('p',topic.result.contribution));
 for(const ref of topic.result.evidence)audit.append(el('blockquote',ref.quote));
 evidence.append(audit);
 const readSources=el('button','查看本主题完整已读原文'),sourcePanel=el('div');
 readSources.addEventListener('click',async()=>{
  readSources.disabled=true;
  try{
   const data=await post('api/topic-sources',{topic_id:topic.id});sourcePanel.replaceChildren();
   for(const {snapshot:s} of data.sources){
    const source=el('details');source.open=true;source.append(el('summary',`${s.source.system==='chatgpt'?'ChatGPT':'Codex'} · ${s.title}`));
    source.append(el('p',`${s.messages.length} 条已读消息；${s.completeness==='complete'?'来源声明完整':'只代表已取得的范围，不代表完整历史'}。`));
    for(const message of s.messages){source.append(el('h4',message.role==='user'?'用户':'助手'),el('pre',message.text));}
    sourcePanel.append(source);
   }
  }catch(e){sourcePanel.replaceChildren(el('p',errors[e.message]??'原文读取失败，请核对本地服务。'));readSources.disabled=false;}
 });evidence.append(readSources,sourcePanel);
 card.append(evidence);
 feedbackControls(card,topic);
 if(topic.status!=='completed')return card;
 const button=el('button','查看保存预览'),preview=el('div');button.className='primary-button';preview.className='save-preview';
 button.addEventListener('click',async()=>{
  button.disabled=true;preview.replaceChildren(el('p','正在核对目标笔记…'));
  try{
   const plan=await post('/api/topic-preview',{topic_id:topic.id});
   renderPreview(preview,plan);
  }catch(e){preview.replaceChildren(el('p',({MERGE_REQUIRED:'现有笔记不是可安全更新的受管理版本，需要人工合并或恢复后再预览。',CONFLICT:'笔记中的受管理内容已被人工修改，请先核对并恢复或改为人工合并。',RECOVERY_REQUIRED:'上次写入结果需要先核对和恢复，暂不能生成新预览。',STALE_INPUT:'相关对话已变化，请先更新主题。',TARGET_REQUIRED:'尚未配置这个主题的笔记位置。',NOT_FOUND:'当前服务尚未配置保存预览。'})[e.message]??'预览失败，请检查本地服务。'));}
  finally{button.disabled=false;}
 });card.append(button,preview);return card;
}
function topicKind(topic){return ({agreement:'项目约定',progress:'项目进度',introduction:'项目介绍'})[topic.result?.project_type]??(topic.result?.kind==='knowledge'?'知识草稿':'项目记录');}
function obsidianLink(vault,relative){
 if(typeof vault!=='string'||!vault.startsWith('/')||typeof relative!=='string'||relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(x=>!x||x==='.'||x==='..'))return null;
 return 'obsidian://open?path='+encodeURIComponent(vault.replace(/\/$/u,'')+'/'+relative);
}
function changeSections(change){
 if(change.operation==='managed-topic-adopt'){const heading=change.content?.match(/^#{1,6}\s+(.+)$/mu);return [heading?heading[1]:'接管已保存补充，正文未改写'];}
 const left=(change.before??'').split('\n'),right=(change.after??'').split('\n');let start=0,l=left.length,r=right.length;
 while(start<l&&start<r&&left[start]===right[start])start++;
 while(l>start&&r>start&&left[l-1]===right[r-1]){l--;r--;}
 const names=[];
 for(const [lines,end] of [[right,r],[left,l]]){
  let heading='';for(let i=0;i<end;i++){const m=lines[i].match(/^#{1,6}\s+(.+)$/u);if(m)heading=m[1];if(i>=start&&lines[i].trim()&&!lines[i].startsWith('<!--')&&heading&&!names.includes(heading))names.push(heading);}
 }
 return names.length?names:['文件内容变动'];
}
function sourceCaption(title){return /^[a-f0-9-]{36}$/u.test(title??'')?'Codex 项目讨论':title??'来源记录';}
function usageText(usage){
 if(!usage||!usage.reported_turns)return '整理用量未知，尚无可信回合回报。';
 return `已回报 ${usage.reported_turns} 回合：输入 ${usage.tokens?.input_tokens??'未知'}、输出 ${usage.tokens?.output_tokens??'未知'} token；${usage.unknown_attempts??0} 次尝试用量未知。回报小计不是完整费用。`;
}
function monitorAttention(data,plans){
 const items=[];
 for(const p of plans)if(p.status==='PARTIAL')items.push({title:'写入结果需要核对',detail:p.changes?.[0]?.relative_path??'',target:'history',record:p.id});
 for(const a of data.pending_attempts??[])items.push({title:a.title,detail:'尚未收到处理结果；核对已有结果后再决定下一步。',target:'sources'});
 for(const t of data.topics??[])if(['review_required','needs_update'].includes(t.status))items.push({title:t.title,detail:labels[t.status],target:'topic-review',topic:t.id});
 for(const j of data.jobs??[])if(j.status==='blocked'&&!j.gaps?.includes('automated_session_excluded')&&!j.reason?.includes('自动执行或子代理会话已排除'))items.push({title:j.title,detail:j.reason??'来源范围需要核对。',target:'sources',source:j.id});
 for(const q of data.queue??[])if(q.reason==='INPUT_EXCEEDS_LIMIT')items.push({title:q.title,detail:'单份材料超过输入上限；等待下一周期不能解决。',target:'sources'});
 return items;
}
const viewNames={overview:'维护概览',review:'草稿审查',history:'保存记录',sources:'来源与运行'};
const viewDescriptions={overview:'笔记发生了什么，哪些地方需要留意。',review:'按需核对草稿；阅读已保存笔记无需经过这里。',history:'先看文件与章节的变化，需要时再查看保存与恢复范围。',sources:'分开查看正常队列、需要核对和已排除的材料。'};
function readRoute(hash){
 const legacy={'#monitor-home':'overview','#topic-review':'review','#history':'history','#sources':'sources'};
 if(!hash||legacy[hash])return {view:legacy[hash]??'overview',id:null,from:legacy[hash]??'overview',filter:'all'};
 try{
  const [path,query='']=hash.replace(/^#\//u,'').split('?'),parts=path.split('/'),view=parts[0],id=parts[1]?decodeURIComponent(parts[1]):null,params=new URLSearchParams(query);
  if(!hash.startsWith('#/')||!Object.hasOwn(viewNames,view)||parts.length>2||(view==='overview'&&id))return {view:'overview',id:null,from:'overview',filter:'all',invalid:true};
  const from=Object.hasOwn(viewNames,params.get('from'))?params.get('from'):view;
  const filter=['all','attention','queue','normal','excluded'].includes(params.get('filter'))?params.get('filter'):'all';
  return {view,id,from,filter};
 }catch{return {view:'overview',id:null,from:'overview',filter:'all',invalid:true};}
}
function routeHref(view,id=null,from=view,filter='all'){
 const query=new URLSearchParams();if(id&&from!==view)query.set('from',from);if(filter!=='all')query.set('filter',filter);
 return '#/'+view+(id?'/'+encodeURIComponent(id):'')+(query.size?'?'+query:'');
}
function routeLink(caption,view,id=null,from=view,filter='all'){
 const link=el('a',caption);link.href=routeHref(view,id,from,filter);link.className='text-action';return link;
}
function navigate(href,record=true){
 if(record&&window.location.hash!==href)window.history.pushState(null,'',href);
 renderRoute(true);
}
function sourceGroup(job){
 if(job.gaps?.includes('automated_session_excluded')||job.reason?.includes('自动执行或子代理会话已排除'))return 'excluded';
 return job.status==='blocked'?'attention':['queued','running','needs_update'].includes(job.status)?'queue':'normal';
}
function exclusionText(discovery){return Number.isInteger(discovery?.excluded)&&discovery.excluded>=0?`最近一次来源检查排除 ${discovery.excluded} 项`:'最近一次来源检查的排除数量未知';}
function recordDate(value){const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}):'时间未记录';}
function missingRecord(parent,view){const box=el('div');box.className='monitor-empty';box.append(el('h2','这条记录当前不可用'),el('p','链接对应的记录不在当前读取范围内。可以返回列表核对；没有切换到其他记录。'),routeLink('返回'+viewNames[view],view));parent.append(box);}
function listRow(title,detail,state,link){
 const row=el('article'),main=el('div'),heading=el('h2');row.className='record-row';main.className='record-row-main';heading.append(link);main.append(heading,el('p',detail));const badge=el('span',state);badge.className='event-state';row.append(main,badge);return row;
}
function renderTopicBrowser(topics,results,route){
 results.replaceChildren();document.querySelector('#topic-count').textContent=`${topics.filter(t=>t.status!=='dismissed').length} 个主题`;
 if(route.id){
  const topic=topics.find(t=>t.id===route.id);if(!topic){missingRecord(results,'review');return;}
  document.querySelector('#view-title').textContent=topic.title;
  if(topic.result)results.append(topicCard(topic));
  else results.append(el('p',`${labels[topic.status]??topic.status}。现有来源仍保留，等待核对后继续。`));
  return;
 }
 if(!topics.length){results.append(el('p','当前没有主题草稿。整理结果会出现在这里；浏览页面不会触发整理。'));return;}
 const dismissed=el('details');dismissed.className='dismissed-topics';dismissed.append(el('summary',`本轮已忽略（${topics.filter(t=>t.status==='dismissed').length}）`));
 for(const topic of topics){
  const row=listRow(topic.title,`${topic.project} / ${topicKind(topic)} · ${topic.source_count??0} 段来源`,labels[topic.status]??topic.status,routeLink(topic.title,'review',topic.id));
  (topic.status==='dismissed'?dismissed:results).append(row);
 }
 if(topics.some(t=>t.status==='dismissed'))results.append(dismissed);
}
function renderHistory(plans,parent,route){
 parent.replaceChildren();
 const statuses={PREPARED:'仅预览',APPLIED:'已保存',PARTIAL:'需核对',ROLLED_BACK:'已恢复'};
 if(!route.id){
  if(!plans.length){parent.append(el('p','当前没有保存或预览记录。草稿不会被计作保存成功。'));return;}
  for(const plan of [...plans].sort((a,b)=>(b.updated_at??'').localeCompare(a.updated_at??''))){
   const paths=(plan.changes??[]).map(c=>c.relative_path);const title=paths[0]?.split('/').at(-1)??'保存记录';
   const row=listRow(title,`${paths.join('、')} · ${recordDate(plan.updated_at)}`,statuses[plan.status]??plan.status,routeLink(title,'history',plan.id));
   const sections=el('p',(plan.changes??[]).flatMap(changeSections).join(' / '));sections.className='record-sections';row.querySelector('.record-row-main').append(sections);parent.append(row);
  }
  return;
 }
 const plan=plans.find(p=>p.id===route.id);if(!plan){missingRecord(parent,'history');return;}
 document.querySelector('#view-title').textContent=plan.changes?.[0]?.relative_path.split('/').at(-1)??'保存详情';
 const article=el('article');article.className='record-detail';article.append(el('p',`${statuses[plan.status]??plan.status} · ${recordDate(plan.updated_at)}`));
 if(plan.stale){const note=el('p','相关草稿或来源已更新。此处保留这次保存记录，不代表最新草稿已写入。');note.className='warning';article.append(note);}
 for(const change of plan.changes??[]){
  article.append(el('h2',changeSections(change).join(' / ')),el('p',change.relative_path));
  const uri=obsidianLink(plan.vault_root,change.relative_path);if(uri&&plan.status==='APPLIED'){const read=el('a','在 Obsidian 阅读');read.href=uri;read.className='primary-link';article.append(read);}
  if(change.operation==='managed-topic-adopt')article.append(el('p','本次仅增加主题管理标记，已保存的补充正文没有重复追加或重写。'));
  else {
   const delta=changedLines(change.before,change.after);
   for(const [label,text,css] of [['移除或替换',delta.removed,'diff-removed'],['新增或替换',delta.added,'diff-added']])if(text){const block=el('div');block.className='change-block';const pre=el('pre',text);pre.className=css;block.append(el('h3',label),pre);article.append(block);}
  }
  const complete=el('details');complete.append(el('summary','查看本次保存的完整内容'));renderText(complete,change.after??'');article.append(complete);
 }
 if(['APPLIED','PARTIAL'].includes(plan.status)){
  const restore=el('details');restore.append(el('summary','查看恢复范围'),el('p','恢复前会再次核对笔记是否已有人工修改。展开这里只展示范围。'));
  for(const change of plan.changes??[])restore.append(el('h3',change.relative_path),el('pre',change.before??'此文件由本次操作新建；恢复会删除该文件，前提是它未被后续修改。'));
  confirmAction(restore,plan,true);article.append(restore);
 }else if(plan.status==='PREPARED')confirmAction(article,plan);
 parent.append(article);
}
function renderSources(data,parent,route){
 parent.replaceChildren();const jobs=data.jobs??[];
 if(route.id){
  const job=jobs.find(j=>j.id===route.id);if(!job){missingRecord(parent,'sources');return;}
  document.querySelector('#view-title').textContent=sourceCaption(job.title);
  const article=el('article');article.className='record-detail';article.append(el('p',`${job.source==='chatgpt'?'ChatGPT':'Codex'} · ${sourceGroup(job)==='excluded'?'已排除':labels[job.status]??job.status}`),el('h2','本次读取范围'),el('p',`${job.message_count??0} 条消息；${job.completeness==='complete'?'来源声明完整':'仅代表已取得的范围，不是完整历史'}。`));
  if(job.reason)article.append(el('p',job.reason));
  if(job.knowledge_units?.length){const points=el('section');points.append(el('h3','知识点去向'));
   const names={PROJECT_KNOWLEDGE:'项目沉淀',ENGINEERING_THINKING:'工程方法',PRODUCT_THINKING:'产品方法',GENERAL_KNOWLEDGE:'长期知识'};
   for(const unit of job.knowledge_units)points.append(el('h4',unit.title),el('p',`${names[unit.knowledge_layer]} · ${unit.project??'归属待确认'}`),el('p',unit.reason));article.append(points);}
  if(job.markdown){const result=el('details');result.append(el('summary','查看已有处理结果'));renderText(result,job.markdown);article.append(result);}
  if(job.gaps?.length){const gaps=el('details');gaps.append(el('summary','查看范围诊断'),el('p',job.gaps.join(' / ')));article.append(gaps);}
  article.append(el('p','此页只读取已有记录；没有重新采集、整理或写入。'));parent.append(article);return;
 }
 const filters=el('nav');filters.className='source-filters';filters.setAttribute('aria-label','筛选来源');
 for(const [key,title] of [['all','全部'],['attention','需核对'],['queue','正常队列'],['normal','已处理'],['excluded','排除情况']]){
  const count=key==='excluded'?'':key==='all'?jobs.length:jobs.filter(j=>sourceGroup(j)===key).length;
  const link=routeLink(`${title} ${count}`,'sources',null,'sources',key);if(route.filter===key)link.setAttribute('aria-current','true');filters.append(link);
 }parent.append(filters);
 if(route.filter==='excluded'){parent.append(el('h2',exclusionText(data.discovery)),el('p','此数量来自最近一次来源检查，包含范围外来源和自动会话；不计入正常队列或异常。接口未提供逐项排除明细。'));if(data.discovery?.at)parent.append(el('p','检查记录时间：'+recordDate(data.discovery.at)));return;}
 const selected=jobs.filter(j=>route.filter==='all'||sourceGroup(j)===route.filter);
 if(!selected.length)parent.append(el('p','当前分类没有来源记录。'));
 for(const job of selected){
  const group=sourceGroup(job),caption=sourceCaption(job.title),state=group==='excluded'?'已排除':labels[job.status]??job.status;
  const row=listRow(caption,`${job.source==='chatgpt'?'ChatGPT':'Codex'} · ${job.message_count??0} 条已读消息`,state,routeLink(caption,'sources',job.id,'sources',route.filter));
  if(group==='attention'&&job.reason)row.querySelector('.record-row-main').append(el('p',job.reason));parent.append(row);
 }
 if(data.discovery&&!data.discovery.complete){const note=el('p','来源发现尚有缺口，不能视为所有对话已覆盖。');note.className='warning';parent.append(note);}
 for(const attempt of data.pending_attempts??[]){const note=el('p',`「${attempt.title}」尚未收到处理结果。核对已有结果后再决定下一步，系统不会自动重做。`);note.className='warning';parent.append(note);}
 for(const item of data.queue??[])if(item.reason){const note=el('p',`「${item.title}」：${item.reason==='INPUT_EXCEEDS_LIMIT'?'单份输入超过当前上限；等待下一周期不能解决，需要核对分段范围。':'本周期额度不足，尚未派发；自动周期未启用时不会自行继续。'}`);note.className='warning';parent.append(note);}
}
function renderRoute(focus=false){
 const route=readRoute(window.location.hash),title=document.querySelector('#view-title'),description=document.querySelector('#view-description'),message=document.querySelector('#navigation-message'),back=document.querySelector('#detail-back');
 title.textContent=viewNames[route.view];description.textContent=viewDescriptions[route.view];description.hidden=Boolean(route.id);
 document.querySelectorAll('[data-view]').forEach(section=>{section.hidden=section.dataset.view!==route.view||Boolean(loadError)||Boolean(route.invalid)||!pageData;});
 document.querySelectorAll('[data-view-link]').forEach(link=>{const active=link.dataset.viewLink===route.view;link.classList.toggle('nav-current',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
 back.hidden=!route.id&&!route.invalid;back.href=routeHref(route.from,null,route.from,route.from==='sources'?route.filter:'all');back.textContent='返回'+viewNames[route.from];
 message.hidden=Boolean(pageData)&&!loadError&&!route.invalid;
 message.textContent=loadError?`${loadError} 当前数据状态未知，请点击刷新重试。`:route.invalid?'这个页面地址无法识别，请从左侧选择分区。':!pageData?'正在读取当前记录…':'';
 document.querySelector('.write-banner').hidden=Boolean(route.id)||!['overview','review'].includes(route.view);
 if(pageData&&!loadError&&!route.invalid){
  if(route.view==='review')renderTopicBrowser(pageData.data.topics??[],document.querySelector('#run-results'),route);
  if(route.view==='history')renderHistory(pageData.plans,document.querySelector('#save-history'),route);
  if(route.view==='sources')renderSources(pageData.data,document.querySelector('#run-coverage'),route);
 }
 const readingLink=document.querySelector('#open-obsidian');readingLink.hidden=route.view!=='overview'||!readingLink.getAttribute('href');
 document.querySelector('#source-context').hidden=Boolean(route.id);
 document.querySelector('#review-intro').hidden=Boolean(route.id);
 document.title=title.textContent+' · 知识中心';
 if(focus){title.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
}
function renderMonitor(runtime,data,plans){
 const feed=document.querySelector('#note-activity'),attention=document.querySelector('#attention-list'),connection=document.querySelector('#connection-info'),scope=document.querySelector('#scope-summary');
 feed.replaceChildren();attention.replaceChildren();connection.replaceChildren();scope.replaceChildren();
 const applied=plans.filter(p=>['APPLIED','ROLLED_BACK','PARTIAL'].includes(p.status)).sort((a,b)=>(b.updated_at??'').localeCompare(a.updated_at??''));
 const topLink=document.querySelector('#open-obsidian');topLink.hidden=true;
 for(const plan of applied.slice(0,5)){
  const entry=el('article');entry.className='note-event';
  const head=el('div');head.className='note-event-head';
  const marker=el('span',plan.status==='PARTIAL'?'!':plan.status==='ROLLED_BACK'?'↶':'▤');marker.className='file-symbol';marker.setAttribute('aria-hidden','true');
  const name=el('div');name.className='note-name';name.append(el('h3',plan.changes[0].relative_path.split('/').at(-1)));
  const path=el('p',plan.changes[0].relative_path.split('/').slice(0,-1).join(' / '));path.className='file-location';name.append(path);
  const state=el('span',({APPLIED:'已保存',ROLLED_BACK:'已恢复',PARTIAL:'需核对'})[plan.status]);state.className='event-state'+(plan.status==='PARTIAL'?' caution':'');head.append(marker,name,state);entry.append(head);
  const time=el('p');time.className='event-time';
  const date=Date.parse(plan.updated_at);time.textContent=Number.isFinite(date)?new Date(date).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}):'时间未记录';entry.append(time);
  for(const change of plan.changes){
   const sections=el('div');sections.className='changed-sections';for(const section of changeSections(change))sections.append(el('span',section));entry.append(sections);
   if(change.operation==='managed-topic-adopt'){const note=el('p','为已保存的补充添加管理标记；原正文保留。');note.className='event-description';entry.append(note);}
   if(plan.stale){const note=el('p','相关草稿或来源已变化，保存记录仍保留。');note.className='event-description';entry.append(note);}
   const actions=el('div');actions.className='event-actions';
   const uri=obsidianLink(plan.vault_root,change.relative_path);
   if(uri){const link=el('a','在 Obsidian 阅读');link.href=uri;link.className='obsidian-link';actions.append(link);if(topLink.hidden&&plan.status==='APPLIED'){topLink.href=uri;topLink.hidden=false;}}
   actions.append(routeLink('查看这次变化','history',plan.id,'overview'));entry.append(actions);
  }
  feed.append(entry);
 }
 if(!applied.length){const empty=el('div');empty.className='monitor-empty';empty.append(el('h3','还没有已保存笔记的变动'),el('p','草稿和预览不会记作保存成功。已有主题可以按需查看。'),routeLink('查看草稿','review'));feed.append(empty);}
 const issues=monitorAttention(data,plans);document.querySelector('#attention-count').textContent=issues.length?`${issues.length} 项`:'暂无';
 function issueNode(item){const row=el('div');row.className='attention-item';row.append(el('h3',sourceCaption(item.title)),el('p',item.detail),routeLink('查看记录',item.target==='topic-review'?'review':item.target,item.topic??item.record??item.source??null,'overview'));return row;}
 for(const item of issues.slice(0,3))attention.append(issueNode(item));
 if(issues.length>3){const more=el('details');more.append(el('summary',`其他 ${issues.length-3} 项来源或处理记录`));for(const item of issues.slice(3))more.append(issueNode(item));attention.append(more);}
 if(!issues.length){const clean=el('div');clean.className='attention-clear';clean.append(el('span','✓'),el('p','当前记录没有待核对异常。'),el('small','仅基于工作区记录，不代表全笔记库实时检查。'));attention.append(clean);}
 const mode=document.querySelector('#write-status');mode.textContent=runtime.vault_write_enabled?'逐次确认写入':'新写入关闭';
 document.querySelector('#monitor-write-note').textContent=runtime.vault_write_enabled?'已保存笔记可读；新写入仍需逐次明确确认。':'已保存笔记可直接阅读；新内容只生成草稿和预览。';
 const pairs=[['整理方式','Codex 辅助执行'],['自动周期',runtime.scheduler_enabled?'已启用':'未启用'],['Jev 服务',runtime.jev==='not_connected'?'未连接':'状态以配置为准'],['笔记检索',runtime.published_search_enabled?'本地关键词检索':'未启用'],['写入模式',runtime.vault_write_enabled?'逐次确认':'preview-only']];
 const dl=el('dl');for(const [a,b] of pairs)dl.append(el('dt',a),el('dd',b));connection.append(dl);
 const saved=plans.filter(p=>p.status==='APPLIED');if(saved[0]){const vault=el('p',saved[0].vault_root);vault.className='vault-path';connection.append(el('p','当前记录对应的笔记库'),vault);}
 connection.append(el('p','连接状态来自当前服务配置，不代表 Obsidian 双向同步。'));
 const groups=[['来源',`${data.jobs?.length??0} 段当前材料，${runtime.chatgpt?.configured_thread_ids??0} 段授权 ChatGPT 对话`],['覆盖',data.discovery&&!data.discovery.complete?'来源发现有缺口':'按当前已读取范围展示'],['队列',`${data.queued??0} 段等待整理，${data.running??0} 段等待结果`],['本周期',`${data.window?.jobs??0} 次派发，${data.window?.input_bytes??0} 输入字节`]];
 for(const [a,b] of groups){const row=el('div');row.append(el('span',a),el('strong',b));scope.append(row);}
 document.querySelector('#usage-summary').textContent=usageText(data.usage);
 document.querySelector('#budget-note').textContent='派发次数与输入字节是程序预算，不是模型额度或费用。';
 const jobs=data.jobs??[];document.querySelector('#overview-source-summary').textContent=`正常队列 ${jobs.filter(j=>sourceGroup(j)==='queue').length} 段 · 需核对 ${jobs.filter(j=>sourceGroup(j)==='attention').length} 段。${exclusionText(data.discovery)}。${runtime.scheduler_enabled?'自动周期已启用。':'自动周期未启用。'}`;
 document.querySelector('#monitor-updated').textContent='页面读取于 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+'；没有触发整理或写入';
}

async function refresh(){
 const version=++refreshVersion;searchEpoch++;
 const searchResults=document.querySelector('#published-search-results'),searchStatus=document.querySelector('#published-search-status');
 if(searchStatus.textContent){searchResults.replaceChildren();searchStatus.textContent='页面状态已刷新，请重新查询已保存笔记。';}
 const reloadButton=document.querySelector('#reload');reloadButton.disabled=true;document.querySelector('#workspace-content').setAttribute('aria-busy','true');
 try{
  const responses=await Promise.all(['runtime','topic-previews','processing'].map(name=>fetch('api/'+name)));
  for(const response of responses)if(!response.ok)throw Error((await response.json()).error?.code);
  const [runtime,history,data]=await Promise.all(responses.map(response=>response.json()));if(version!==refreshVersion)return;
  writeEnabled=runtime.vault_write_enabled===true;pageData={runtime,plans:history.plans,data};loadError=null;
  document.querySelector('#published-search').hidden=!runtime.published_search_enabled;
  renderMonitor(runtime,data,history.plans);renderRoute();
 }catch(error){if(version!==refreshVersion)return;writeEnabled=false;loadError=errors[error.message]??'读取失败，请检查本地服务。';renderRoute();}
 finally{if(version===refreshVersion){reloadButton.disabled=false;document.querySelector('#workspace-content').setAttribute('aria-busy','false');}}
}
const reload=()=>{document.querySelector('#action-status').textContent='';return refresh();};
document.querySelector('#published-search-form').addEventListener('submit',async event=>{
 event.preventDefault();const epoch=searchEpoch,form=event.currentTarget,button=form.querySelector('button'),status=document.querySelector('#published-search-status'),results=document.querySelector('#published-search-results');
 button.disabled=true;results.replaceChildren();status.textContent='正在核对并检索已保存笔记…';
 try{
  const data=await post('api/published-search',{query:form.elements.query.value});
  if(epoch!==searchEpoch)return;
  status.textContent=`本次检索 ${data.indexed} 篇已保存笔记，显示 ${data.results.length} 条结果。${data.excluded?'另有 '+data.excluded+' 篇内容变化，需要先核对。':''}`;
  for(const note of data.results){const card=el('article');card.className='card';card.append(el('h3',note.title),el('p',note.relative_path),el('p',note.status==='needs_review'?'已保存的旧版本：相关草稿或来源已变化，依据待复核。':'已保存版本；证据状态在本次检索时已核对。'));
   if(note.origin==='reviewed_saved_import')card.append(el('p','人工审核保存后导入；正文与原保存回执一致。'));
   if(note.manual_changes)card.append(el('p','包含人工补充；人工内容未被自动验证。'));
   const detail=el('details');detail.append(el('summary','阅读笔记与来源定位'));renderText(detail,note.markdown);card.append(detail);results.append(card);
  }
 }catch(e){if(epoch!==searchEpoch)return;status.textContent=({SEARCH_UNAVAILABLE:'本地检索组件不可用，请检查已配置的 Basic Memory 环境。未调用远程模型。',SEARCH_TOO_LARGE:'已保存内容超过本次检索范围，请先缩小独立知识库范围。',STALE_INPUT:'检索期间来源或笔记有变化，请重新查询。'})[e.message]??errors[e.message]??'查询未完成，请检查本地服务。';}
 finally{button.disabled=false;}
});
document.querySelector('#reload').addEventListener('click',reload);
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();document.querySelector('#workspace-content').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});});
document.addEventListener('click',event=>{
 const link=event.target.closest?.('a[href^="#/"]');if(!link||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 event.preventDefault();navigate(link.getAttribute('href'));
});
window.addEventListener('popstate',()=>renderRoute(true));
window.addEventListener('hashchange',()=>renderRoute(true));
window.addEventListener('knowledge-refresh',reload);
const initialRoute=readRoute(window.location.hash);
if(!initialRoute.invalid&&!window.location.hash.startsWith('#/'))window.history.replaceState(null,'',routeHref(initialRoute.view));
renderRoute();await refresh();
