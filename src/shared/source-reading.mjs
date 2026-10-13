const html=value=>String(value).replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function sourceUrl(locator){
 const raw=typeof locator==='string'?locator.match(/https?:\/\/[^\s<>]+/u)?.[0]:null;
 try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
// Both entrypoints use this reader-facing view. Full quotes stay in their ledgers.
export function renderSourceSummaries(sources){
 const groups=new Map();
 for(const source of sources){
  const url=sourceUrl(source.url),key=url??source.id;
  if(!key)throw new Error('SOURCE_ID_REQUIRED');
  let g=groups.get(key);if(!g){g={...source,url,dates:[],summaries:[],partial:false};groups.set(key,g);}
  g.dates.push(...(source.dates??[]).filter(d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(d)));
  const summary=source.summary||'本主题的讨论依据；结论状态与适用边界见正文。';
  if(!g.summaries.includes(summary))g.summaries.push(summary);g.partial ||= source.partial===true;
 }
 const body=[...groups.values()].map(g=>{
  const dates=[...new Set(g.dates)].sort(),date=dates.length?' · '+dates[0]+(dates.at(-1)!==dates[0]?'—'+dates.at(-1):''):'';
  const title=/^[a-f0-9-]{36}$/u.test(g.title)?'项目讨论':g.title;
  const link=g.url?` · <a href="${html(g.url)}">打开原对话</a>`:'';
  return `<p><strong>${g.system?html(g.system)+' · ':''}${html(title)}</strong>${date}${link}</p>\n<p>${html(g.summaries.join(' '))}</p>`+(g.partial?'<p>依据已读取内容整理。</p>':'');
 });
 return `<details>\n<summary>来源（${groups.size} 段对话）</summary>\n${body.join('\n')}\n</details>`;
}

// Obsidian renders the filename as its inline title. Only remove a matching
// opening H1; a project overview can retain a more meaningful project heading.
export function readingBody(markdown,fileTitle){
 const match=markdown.match(/^(?:\r?\n)*# ([^\r\n]+)\r?\n(?:\r?\n)*/u);
 return match&&match[1].trim()===fileTitle?markdown.slice(match[0].length).trimEnd():markdown.trimEnd();
}
