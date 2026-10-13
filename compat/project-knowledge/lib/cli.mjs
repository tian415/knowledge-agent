import {classificationStandard} from '../../../src/shared/knowledge-standard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { init, register, doctor, load } from './config.mjs';
import { preview, apply, recover } from './engine.mjs';
import { atomic, encode, json, hash, read, safe } from './files.mjs';

const flags = new Set(['vault','binding','id','name','directory','dashboard','input','out','project','source-id','title','plan','transaction','repo','date','confirm-promotion','confirm']);
const booleans = new Set(['confirm-promotion','confirm']);
function parse(args) {
  const [command = 'help', ...rest] = args; const options = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !flags.has(flag) || Object.hasOwn(options, flag)) throw new Error(`未知或重复参数: ${rest[i]}`);
    if (booleans.has(flag)) options[flag] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error(`参数缺少值: ${flag}`); options[flag] = value; }
  }
  return { command, options };
}
const required = (o, key) => { if (!o[key]) throw new Error(`需要参数 --${key}`); return o[key]; };
function saveOutsideVault(out, result, vault) {
  const target = path.resolve(out);
  if (vault) {
    const base = fs.realpathSync(vault); let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const resolved = path.join(fs.realpathSync(ancestor), path.relative(ancestor, target));
    if (resolved === base || resolved.startsWith(base + path.sep)) throw new Error('预览和输入草稿请保存到知识库外');
  }
  atomic(target, encode(result));
}
function draft(options) {
  const input = required(options, 'input'); const content = fs.readFileSync(input, 'utf8');
  if (!content.trim()) throw new Error('输入为空');
  const id = required(options, 'source-id'); const title = required(options, 'title');
  return { version: 2, mode: 'capture', ...(options.project?{source_project:options.project}:{}), sources: [{ id, kind: 'manual', actor: 'user', title, locator: `input:${path.basename(input)}#sha256=${hash(content)}`, observedAt: options.date??null, scope: '用户提供的 Markdown 文件；仅导入为待整理材料', completeness: 'complete', excerpt: content }], notes: [] };

}
function repoEvidence(options) {
  const repo = required(options, 'repo'); const date = options.date ?? new Date().toISOString().slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 必须为 YYYY-MM-DD');
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } });
  const head = git(['rev-parse','HEAD']).trim();
  const queries = [['status','--short','--branch'], ['diff','--no-ext-diff','--no-textconv'], ['diff','--cached','--no-ext-diff','--no-textconv'], ['log', `--since=${date}T00:00:00`, `--until=${date}T23:59:59`, '--format=%H %aI %s']];
  const observations = queries.map(args => { const output = git(args); return { command: ['git', ...args], output: output.slice(0,40000), truncated: output.length > 40000 }; });
  return { version: 1, head, date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, observations, note: '只读 Git 采集，不含未跟踪文件正文；未运行测试。输出可能含私人信息，仅存私人暂存目录。' };
}
export function main(argv = process.argv.slice(2)) {
  try {
    const { command, options: o } = parse(argv);
    if (command === 'help') { console.log(encode({ name: 'Project Knowledge', version: '0.2.0', commands: {
      init: '--vault <existing-directory>', bind: '--vault <directory> [--binding <local.json>]',
      register: '--id <stable-id> --name <name> --directory <relative> --dashboard <relative.md>',
      rules: '显示共用分类规则，无需 vault', doctor: '[--vault <directory>]', draft: '--input <markdown> [--project <source-context>] [--date <source-date>] --source-id <stable-id> --title <title> --out <proposal.json>',
      preview: '--input <proposal.json> --out <plan.json>', apply: '--plan <plan.json> [--confirm-promotion]',
      recover: '--transaction <id>', unlock: '--confirm (only after confirming no writer is running)',
      'capture-repo': '--repo <directory> --date <YYYY-MM-DD> --out <evidence.json>'
    }})); return; }
    if(command==='rules'){console.log(encode(classificationStandard));return;}
    const binding = o.binding ?? path.join(os.homedir(), '.codex', 'project-knowledge.local.json');
    const vault = o.vault ?? (read(binding) !== null ? json(binding).vault_root : undefined);
    if (command !== 'capture-repo' && !vault) throw new Error('请指定 --vault 或先 bind');
    let result;
    switch (command) {
      case 'init': result = init(vault); break;
      case 'bind': {
        load(vault); const value = encode({ version: 1, vault_root: path.resolve(vault) });
        if (read(binding) !== value) { if (read(binding) !== null) atomic(`${binding}.${Date.now()}.bak`, read(binding)); atomic(binding, value); }
        result = { ok: true, binding, vault }; break;
      }
      case 'register': result = register(vault, { id: required(o,'id'), name: required(o,'name'), directory: required(o,'directory'), dashboard: required(o,'dashboard') }); break;
      case 'doctor': result = doctor(vault); if (!result.ok) process.exitCode = 2; break;
      case 'draft': result = draft(o); saveOutsideVault(required(o,'out'), result, vault); result = { ok: true, proposal: path.resolve(o.out), status: '待整理；没有自动总结或验证内容' }; break;
      case 'preview': {
        const plan = preview(vault, json(required(o,'input'))); saveOutsideVault(required(o,'out'), plan, vault);
        result = { ok: true, plan: path.resolve(o.out), changes: plan.operations.map(({path: p, before, after}) => ({ path:p, action: before === null ? 'create' : 'merge', before, after })), routes:plan.routes, classification_version:plan.classification_version, warnings: plan.warnings, requiresPromotion: plan.requiresPromotion }; break;
      }
      case 'apply': result = apply(vault, json(required(o,'plan')), { confirmPromotion: !!o['confirm-promotion'] }); break;
      case 'recover': result = recover(vault, required(o,'transaction')); break;
      case 'unlock': {
        if (!o.confirm) throw new Error('确认无运行中写入后才可 --confirm 解锁');
        const file = safe(vault, '.project-knowledge/write.lock'); const existing = read(file);
        if (existing !== null) fs.unlinkSync(file); result = { ok:true, unlocked:existing !== null }; break;
      }
      case 'capture-repo': result = repoEvidence(o); saveOutsideVault(required(o,'out'), result, vault); result = {ok:true, evidence:path.resolve(o.out), head:result.head}; break;
      default: throw new Error(`未知命令: ${command}`);
    }
    console.log(encode(result));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
