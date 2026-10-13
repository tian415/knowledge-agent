import {classificationStandard,validateKnowledgeTarget} from '../../../src/shared/knowledge-standard.mjs';
import {renderSourceSummaries,sourceUrl} from '../../../src/shared/source-reading.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { load, configPath, statePath, pending } from './config.mjs';
import { safe, relative, hash, read, json, encode, atomic, lock, pathKey } from './files.mjs';

const labels = { 'user-stated': '用户陈述', proposed: 'AI 建议', uncertain: '待验证', verified: '已验证事实' };
const kinds = new Set(['overview', 'thinking', 'engineering', 'daily', 'weekly', 'candidate', 'decision', 'knowledge', 'runbook']);
const longTerm = new Set(['decision', 'knowledge', 'runbook']);
function text(value, field) { if (typeof value !== 'string' || !value.trim() || value.includes('<!-- pk:')) throw new Error(`字段无效: ${field}`); }
export function validate(proposal) {
  if (![1,2].includes(proposal?.version) || !['capture', 'daily', 'weekly', 'promote'].includes(proposal.mode) || !Array.isArray(proposal.sources) || !Array.isArray(proposal.notes) || !proposal.notes.length) throw new Error('提案结构无效');
  const sources = new Map();
  for (const s of proposal.sources) {
    for (const key of ['id', 'title', 'locator', 'scope', 'excerpt']) text(s[key], `source.${key}`);
    if (sources.has(s.id) || !['chat', 'repository', 'command', 'document', 'manual'].includes(s.kind) || !['user', 'assistant', 'tool'].includes(s.actor) || !['complete', 'partial'].includes(s.completeness)) throw new Error('来源重复或类型无效');
    if (!(proposal.version===2&&s.observedAt===null) && !/^\d{4}-\d{2}-\d{2}/.test(s.observedAt)) throw new Error('证据日期无效'); sources.set(s.id, s);
  }
  const ids = new Set(); const paths = new Set();
  for (const n of proposal.notes) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(n.id) || ids.has(proposal.version===2?`${n.project}:${n.id}`:n.id) || !kinds.has(n.kind)) throw new Error('笔记 ID 重复或类型无效');
    text(n.title, 'note.title'); relative(n.path);
    if (!n.path.endsWith('.md') || n.path.split('/').some(p => p.startsWith('.')) || paths.has(pathKey(n.path))) throw new Error('笔记路径非法或重复');
    ids.add(proposal.version===2?`${n.project}:${n.id}`:n.id); paths.add(pathKey(n.path));
    if(proposal.version===2){text(n.reason,'note.reason');validateKnowledgeTarget({project:n.project,key:n.id,knowledge_layer:n.knowledge_layer,relative_path:n.path});}
    if (longTerm.has(n.kind) && proposal.mode !== 'promote') throw new Error('长期知识仅能以 promote 模式处理');
    if (proposal.mode === 'daily' && !['overview', 'daily', 'candidate'].includes(n.kind)) throw new Error('daily 只能更新总览、日复盘和候选');
    if (proposal.mode === 'weekly' && !['overview', 'weekly', 'candidate'].includes(n.kind)) throw new Error('weekly 只能更新总览、周复盘和候选');
    if (!Array.isArray(n.sections) || !n.sections.length) throw new Error('笔记需要有来源的 sections');
    for (const section of n.sections) {
      text(section.heading, 'section.heading'); text(section.body, 'section.body');
      if (section.images !== undefined) {
        if (!Array.isArray(section.images) || section.images.length > 4) throw new Error('每节最多四张本地图');
        for (const img of section.images) {
          relative(img.path); text(img.alt, 'image.alt');
          if (!img.path.endsWith('.png') || img.path.split('/').some(p => p.startsWith('.')) || /[\[\]\r\n]/.test(img.alt)) throw new Error('仅支持明确指定的本地 PNG 图');
        }
      }
      if (!Object.hasOwn(labels, section.status) || !Array.isArray(section.sources) || !section.sources.length || section.sources.some(id => !sources.has(id))) throw new Error('状态或来源引用无效');
      if (section.status === 'verified' && !section.sources.some(id => { const s = sources.get(id); return ['repository', 'command'].includes(s.kind) && s.actor === 'tool' && s.completeness === 'complete'; })) throw new Error('已验证事实必须引用完整的仓库或命令证据 evidence');
      if (section.status === 'user-stated' && !section.sources.some(id => sources.get(id).actor === 'user')) throw new Error('用户陈述必须引用用户来源');
    }
  }
  return sources;
}
function imageSnapshot(vault, proposal, project) {
  const result = {};
  for (const note of proposal.notes) for (const section of note.sections) for (const img of section.images ?? []) {
    const owner=proposal.version===2?project.projects.find(p=>p.id===note.project):project;
    if(!owner)throw new Error('项目未注册');
    const rel = `${owner.directory}/${img.path}`;
    const bytes = fs.readFileSync(safe(vault, rel));
    if (bytes.length > 5 * 1024 * 1024 || bytes.length < 16 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12,16).toString() !== 'IHDR') throw new Error('图示必须是 5 MB 内的 PNG 文件');
    result[rel] = hash(bytes.toString('base64'));
  }
  return result;
}
function render(note, sources, key, project) {
  // Free text never embeds content; images come only from explicit checked local assets.
  const clean = value => value.replace(/</g, '&lt;').replace(/!\[/g, '\\![');
  const refs = [...new Set(note.sections.flatMap(s => s.sources))];
  const chatOnly = refs.every(id => ['chat','manual'].includes(sources.get(id).kind));
  const block = [`<!-- pk:start:${key} -->`, ...(note.title===path.posix.basename(note.path,'.md')?[]:[`# ${clean(note.title)}`, '']), chatOnly ? '*讨论整理 · 实现情况未核验*' : '*各节证据状态见文末来源*', ''];
  for (const s of note.sections) {
    block.push(`## ${clean(s.heading)}`, '', clean(s.body), '');
    for (const img of s.images ?? []) {
      const local = path.posix.relative(path.posix.dirname(note.path), note.project?`${project.directory}/${img.path}`:img.path);
      const url = local.split('/').map(encodeURIComponent).join('/');
      block.push(`![${clean(img.alt)}](${url})`, '');
    }
  }
  const summaries=refs.map(id=>{const s=sources.get(id);return {id,title:s.title,url:sourceUrl(s.locator),dates:s.observedAt?[s.observedAt.slice(0,10)]:[],summary:s.summary,partial:s.completeness==='partial'};});
  block.push('内容状态：'+note.sections.map(s=>`${clean(s.heading)}（${labels[s.status]}）`).join('；')+'。','',renderSourceSummaries(summaries));
  return `${block.join('\n')}\n<!-- pk:end:${key} -->`;
}
function getBlock(content, key) {
  const start = `<!-- pk:start:${key} -->`, end = `<!-- pk:end:${key} -->`;
  const i = content.indexOf(start), j = content.indexOf(end);
  if (i < 0 && j < 0) return null;
  if (i < 0 || j < i || content.indexOf(start, i + start.length) >= 0 || content.indexOf(end, j + end.length) >= 0) throw new Error('笔记管理标记损坏');
  return content.slice(i, j + end.length);
}
export function preview(vault, proposal) {
  const unfinished = pending(vault); if (unfinished.length) throw new Error(`请先恢复 recover: ${unfinished.join(', ')}`);
  if(proposal?.version!==2)throw new Error('ROUTING_REVIEW_REQUIRED: 按知识点填写 v2 notes 的 project、knowledge_layer、完整 path 与 reason，再预览。旧事务仍可 recover。');
  const config = load(vault);
  const sources = validate(proposal);
  const assets = imageSnapshot(vault, proposal, config);
  const stateBefore = read(safe(vault, statePath));
  const state = stateBefore === null ? { version: 1, notes: {} } : JSON.parse(stateBefore);
  if (state.version !== 1 || !state.notes || Array.isArray(state.notes)) throw new Error('状态结构无效');
  const operations = []; const warnings = []; const routes=[];
  for (const note of proposal.notes) {
    const project=config.projects.find(p=>p.id===note.project);if(!project)throw new Error('项目未注册');
    const target=validateKnowledgeTarget({project:note.project,key:note.id,knowledge_layer:note.knowledge_layer,relative_path:note.path},{projectDirectory:project.directory});
    routes.push({...target,reason:note.reason});
    if (note.kind === 'overview' && note.path !== `${project.directory}/${project.dashboard}`) throw new Error('总览必须映射到项目唯一入口');
    const key = `${project.id}:${note.id}`; const rel = note.path;
    const before = read(safe(vault, rel)); const old = state.notes[key];
    if (old && old.path !== rel) throw new Error('已有笔记 ID 的路径变化，需要显式迁移');
    if (Object.entries(state.notes).some(([k, v]) => k !== key && pathKey(v.path) === pathKey(rel))) throw new Error('目标已属于另一笔记');
    const current = getBlock(before ?? '', key);
    if (old && (!current || hash(current) !== old.blockHash)) throw new Error(`管理区有手工修改或丢失，先合并 manual conflict: ${rel}`);
    if (!old && current) throw new Error('发现没有状态记录的管理区，需要人工恢复');
    if(!old&&!current&&before!==null&&before.trim())throw new Error(`MERGE_REQUIRED: 已有普通笔记须先审阅合并，不能重复追加: ${rel}`);
    const block = render(note, sources, key, project);
    const after = current ? before.replace(current, block) : `${before === null ? '' : before + '\n\n'}${block}\n`;
    const fingerprint = hash({ note, sources: note.sections.flatMap(s => s.sources).map(id => sources.get(id)) });
    state.notes[key] = { path: rel, blockHash: hash(block), fingerprint };
    if (before !== after) operations.push({ path: rel, before, after });
    if (after.length > 5000) warnings.push(`${rel}: 篇幅较长，请检查来源摘录和可读性`);
  }
  for (const s of sources.values()) if (s.completeness === 'partial') warnings.push(`来源 ${s.id} 不完整；不得推断缺失内容`);
  const plan = { version: 1, vaultId: config.vaultId, configHash: hash(read(safe(vault, configPath))), project: null, classification_version:classificationStandard.version, routes, proposal, stateBefore, stateAfter: encode(state), operations, warnings, ...(Object.keys(assets).length ? {assets} : {}), requiresPromotion: proposal.notes.some(n => longTerm.has(n.kind)||n.knowledge_layer!=='PROJECT_KNOWLEDGE') };
  return { ...plan, digest: hash(plan) };
}
function integrity(plan) {
  const { digest, ...rest } = plan; if (hash(rest) !== digest) throw new Error('提案校验失败');
}
function finish(vault, journal) {
  const { plan } = journal; integrity(plan); const config = load(vault);
  if (config.vaultId !== plan.vaultId || hash(read(safe(vault, configPath))) !== plan.configHash) throw new Error('知识库配置冲突');
  validate(plan.proposal);
  const project = plan.proposal.version===2?config:config.projects.find(p => p.id === plan.project); if (!project) throw new Error('未知项目');
  if (hash(imageSnapshot(vault, plan.proposal, project)) !== hash(plan.assets ?? {})) throw new Error('图示在预览后变化 conflict');
  const state = read(safe(vault, statePath)); if (state !== plan.stateBefore && state !== plan.stateAfter) throw new Error('处理状态 conflict');
  for (const op of plan.operations) {
    if(plan.proposal.version===2){
      const note=plan.proposal.notes.find(n=>n.path===op.path),owner=note&&config.projects.find(p=>p.id===note.project);
      if(!owner)throw new Error('事务路径越界');
      validateKnowledgeTarget({project:note.project,key:note.id,knowledge_layer:note.knowledge_layer,relative_path:op.path},{projectDirectory:owner.directory});
    }else if (!op.path.startsWith(project.directory + '/') || !op.path.endsWith('.md')) throw new Error('事务路径越界');
    const current = read(safe(vault, op.path)); if (current !== op.before && current !== op.after) throw new Error(`文件冲突 conflict: ${op.path}`);
  }
  for (const op of plan.operations) {
    const file = safe(vault, op.path); const current = read(file);
    if (current === op.after) continue;
    if (current !== op.before) throw new Error(`文件冲突 conflict: ${op.path}`);
    atomic(file, op.after);
  }
  atomic(safe(vault, statePath), plan.stateAfter);
  journal.status = 'completed'; atomic(safe(vault, `.project-knowledge/transactions/${journal.id}.json`), encode(journal));
  return { ok: true, transaction: journal.id, written: plan.operations.map(o => o.path), warnings: plan.warnings };
}
export function apply(vault, plan, options = {}) {
  integrity(plan);
  if (plan.requiresPromotion && !options.confirmPromotion) throw new Error('长期知识需要明确确认 --confirm-promotion');
  return lock(vault, () => {
    const fresh = preview(vault, plan.proposal);
    if (fresh.digest !== plan.digest) throw new Error('预览后文件或状态变化，冲突 conflict，请重新预览');
    if (!plan.operations.length && plan.stateBefore === plan.stateAfter) return { ok: true, written: [], noop: true, warnings: plan.warnings };
    const journal = { version: 1, id: randomUUID(), status: 'pending', promotionConfirmed: !!options.confirmPromotion, plan };
    atomic(safe(vault, `.project-knowledge/transactions/${journal.id}.json`), encode(journal));
    return finish(vault, journal);
  });
}
export function recover(vault, id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('事务 ID 无效');
  return lock(vault, () => {
    const journal = json(safe(vault, `.project-knowledge/transactions/${id}.json`));
    if (journal.id !== id || journal.version !== 1) throw new Error('事务结构无效');
    integrity(journal.plan);
    if (journal.status === 'completed') return { ok: true, written: [], noop: true };
    if (journal.plan.requiresPromotion && !journal.promotionConfirmed) throw new Error('事务缺少长期知识确认');
    return finish(vault, journal);
  });
}
