// All untrusted values are escaped as text, never interpreted as Markdown/HTML.
const text = value => String(value ?? '未知').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|~-]/gu,'\\$&').replace(/\r/gu,'&#13;').replace(/\n/gu,'\n> ');
const field = (name,value) => `${name}: ${text(value)}\n`;
function evidence(candidate) {
  return candidate.evidence.map(e=>`来源 ${text(candidate.material_id)}，行 ${e.line_start}–${e.line_end}\n\n> ${text(e.snippet)}\n`).join('\n');
}
export function renderPreview({material,result}) {
  const out=['# Material Intake Preview\n','## Material\n'];
  for (const key of ['material_id','source_type','source_title','source_url','source_id','captured_at','content_hash']) out.push(field(key,material?.[key]));
  out.push('## Knowledge Candidates\n');
  if (!result.knowledge_candidates?.length) out.push('无新增候选。\n');
  for (const c of result.knowledge_candidates ?? []) {
    out.push(`### ${text(c.title)}\n`,field('内容',c.content),field('理由',c.reason),field('知识层',c.knowledge_layer),
      field('归属',c.route.route_name),field('建议位置',c.location.target_path ?? c.location.directory),
      field('位置理由',c.location.reason),field('需确认',c.location.review_required),evidence(c));
  }
  out.push('## Action Candidates\n');
  if (!result.action_candidates?.length) out.push('无新增候选。\n');
  for (const type of ['COMMITMENT','SUGGESTION','FOLLOW_UP']) {
    const list=(result.action_candidates ?? []).filter(c=>c.type===type);
    if (!list.length) continue;
    out.push(`### ${type}\n`);
    for (const c of list) out.push(field('行动',c.action),field('状态',c.status),
      ['COMPLETED','CANCELLED','SUPERSEDED','DEFERRED'].includes(c.status)?'非待办：已完成、取消、替代或暂缓的事项不作为当前待办。\n':'候选，未创建外部待办。\n',
      field('关联',c.related.route_name),field('理由',c.reason),evidence(c));
  }
  out.push('## Processing\n',`status: ${result.status}\n`,`llm_requests: ${result.metrics?.llm_requests ?? '未知'}\n`);
  if (result.previous_result_path) out.push(field('旧结果路径',result.previous_result_path),'仅复用历史结果；未重新核对 Registry 当前归属。\n');
  if (result.error) out.push(`error: ${/^[A-Z_]+$/u.test(result.error.code) ? result.error.code : text(result.error.code)}\n`,field('说明',result.error.message));
  for (const warning of result.warnings ?? []) out.push(field('提示',typeof warning==='string'?warning:warning.code ?? 'Registry warning'));
  out.push('覆盖仅本次材料；来源完整性未知。未写入知识库，未接入外部清单；未核对其他清单或全部历史。\n');
  return out.join('\n');
}
