const status=document.querySelector('#runtime-status'),button=document.querySelector('#discover-current');
try{
 const response=await fetch('api/runtime');if(!response.ok)throw Error();
 const runtime=await response.json();
 if(new URL(document.baseURI).pathname==='/capture/'){
  const link=document.createElement('a');link.href='/#overview';link.textContent='行动与项目';link.className='workbench-link';document.querySelector('#secondary-tools').append(link);
 }
 const sources=[];
 if(runtime.codex?.enabled)sources.push('已配置 Codex 项目范围');
 if(runtime.chatgpt?.configured_thread_ids>0)sources.push(`已配置 ${runtime.chatgpt.configured_thread_ids} 段 ChatGPT 对话，由 Codex 工具读取`);
 status.textContent=`${runtime.demo?'隔离演示：使用合成内容，不调用外部模型。 ':''}${sources.length?sources.join('；'):'来源以启动配置为准'}。整理由 Codex 辅助执行；${runtime.vault_write_enabled?'新写入需要逐次确认':'已保存笔记可读，当前新写入关闭（preview-only）'}。`;
 button.hidden=!runtime.codex?.enabled;
 if(runtime.demo){
  const next=document.createElement('button');next.textContent='演示：新增一段对话';button.after(next);
  next.addEventListener('click',async()=>{
   next.disabled=true;
   try{
    const response=await fetch('api/demo/advance',{method:'POST',headers:{'content-type':'application/json','x-app-token':document.querySelector('meta[name="app-token"]').content},body:'{}'});
    if(!response.ok)throw Error();
    status.textContent='已生成第二版合成主题。点击预览，查看新增对话如何更新同一篇笔记。';window.dispatchEvent(new Event('knowledge-refresh'));
   }catch{status.textContent='演示更新未完成，请核对处理记录。';}
  });
 }
 button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='正在检查已配置的项目来源…';
  try{
   const response=await fetch('api/refresh/codex',{method:'POST',headers:{'content-type':'application/json','x-app-token':document.querySelector('meta[name="app-token"]').content},body:'{}'});
   const report=await response.json();if(!response.ok)throw Error(report.error?.code);
   status.textContent=`检查 ${report.examined} 份日志，新增待整理 ${report.queued}，未变化 ${report.unchanged}，待核对 ${report.blocked}。${report.complete?'范围仅限已配置目录和项目。':'来源发现有缺口，请核对处理记录。'}此操作只读取来源，尚未生成新草稿。`;
   window.dispatchEvent(new Event('knowledge-refresh'));
  }catch(e){status.textContent=e.message==='BUSY'?'已有处理正在进行，请稍后刷新。':'读取未完成，请核对配置与本地服务；系统没有自动重试。';}
  finally{button.disabled=false;}
 });
}catch{status.textContent='运行配置状态读取失败；请检查本地服务。';button.hidden=true;}
