import fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app/server.mjs';
import { organize } from '../src/intake/organize.mjs';
import { VAULT_PATH } from '../src/registry/load-registry.mjs';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_MARKER = { type: 'knowledge-agent-demo', version: 1 };
const demoMarkerText = `${JSON.stringify(DEMO_MARKER)}\n`;
export const demoText = '用户：哈希应使用原始字节，不能先清洗原文。\n助手：可以考虑为重复输入增加一次验证。\n用户：先了解这个方案，我还没有决定执行。';
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const fail = message => { throw new Error(message); };
async function lstatOrNull(target) { try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export async function protectedRootsFor(codeRoot = CODE_ROOT) {
  const roots = [path.resolve(codeRoot)];
  try {
    const gitPath = path.join(path.resolve(codeRoot), '.git');
    const gitStat = await lstatOrNull(gitPath);
    if (gitStat?.isFile()) {
      const marker = await fs.readFile(gitPath, 'utf8'); const match = /^gitdir: (.+)$/u.exec(marker.trim());
      if (match) { const gitDir = path.resolve(codeRoot, match[1]); const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim(); roots.push(path.dirname(path.resolve(gitDir, commonDir))); }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return roots;
}
async function assertNoSymlinkAncestors(target) {
  const resolved = path.resolve(target); const parsed = path.parse(resolved); let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = await lstatOrNull(current); if (!stat) break; if (stat.isSymbolicLink()) fail('演示目录含 symlink 祖先'); }
}
function assertPrivateDirectory(stat, message = '目录权限不安全') { if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail(message); }
async function writeMarker(root) {
  const handle = await fs.open(path.join(root, 'demo.json'), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(demoMarkerText); await handle.sync(); } finally { await handle.close(); }
}
async function validateMarker(root) {
  const marker = path.join(root, 'demo.json'); const stat = await lstatOrNull(marker);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail('demo marker 不安全');
  let value; try { value = JSON.parse(await fs.readFile(marker, 'utf8')); } catch { fail('demo marker 无效'); }
  if (JSON.stringify(value) !== JSON.stringify(DEMO_MARKER)) fail('demo marker 无效');
}
async function prepareDemoRoot(inputRoot) {
  if (!path.isAbsolute(inputRoot)) fail('demo-dir 必须是绝对路径');
  const root = path.resolve(inputRoot); const sensitive = new Set(['/','/private','/tmp','/private/tmp','/var','/private/var','/Users','/Applications','/Library']);
  if (sensitive.has(root)) fail('demo-dir 不能是系统根目录');
  for (const protectedRoot of await protectedRootsFor()) if (inside(protectedRoot, root) || inside(root, protectedRoot)) fail('demo-dir 不能位于代码目录');
  await assertNoSymlinkAncestors(root);
  const existing = await lstatOrNull(root);
  if (existing) { assertPrivateDirectory(existing); const marker = await lstatOrNull(path.join(root, 'demo.json')); if (marker) await validateMarker(root); else if ((await fs.readdir(root)).length !== 0) fail('未知非空目录拒绝作为 demo-dir'); else await writeMarker(root); }
  else { const parent = await lstatOrNull(path.dirname(root)); assertPrivateDirectory(parent, 'demo-dir 父目录不安全'); await fs.mkdir(root, { mode: 0o700 }); await writeMarker(root); }
  for (const name of ['data', 'vault']) { const target = path.join(root, name); const stat = await lstatOrNull(target); if (stat) assertPrivateDirectory(stat, `demo ${name} 目录不安全`); else await fs.mkdir(target, { mode: 0o700 }); }
  return { root, dataDir: path.join(root, 'data'), vaultRoot: path.join(root, 'vault') };
}
async function rejectDemoMarkerAncestor(dataDir) {
  await assertNoSymlinkAncestors(dataDir); let current = path.resolve(dataDir);
  while (true) { const marker = path.join(current, 'demo.json'); const stat = await lstatOrNull(marker); if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) { let value = null; try { value = JSON.parse(await fs.readFile(marker, 'utf8')); } catch {} if (JSON.stringify(value) === JSON.stringify(DEMO_MARKER)) fail('正式模式拒绝使用 demo 数据目录'); } const parent = path.dirname(current); if (parent === current) break; current = parent; }
}
function parseArgs(argv) {
  if (argv.includes('--help')) { if (argv.length !== 1) fail('--help 不能与其它参数混用'); process.stdout.write('个人知识中心\n node scripts/start-app.mjs [--demo] [--demo-dir 绝对路径] [--data-dir 私有绝对路径] [--vault-root Vault绝对路径] [--port 3210]\n演示模式使用隔离目录和模拟整理，不调用模型网络。\n'); return null; }
  const options = {}; const valueFlags = new Set(['--port','--data-dir','--vault-root','--demo-dir']);
  for (let index = 0; index < argv.length; index += 1) { const arg = argv[index]; const key = arg === '--demo' ? 'demo' : arg; if (Object.hasOwn(options, key)) fail('启动参数重复'); if (arg === '--demo') { options.demo = true; continue; } if (!valueFlags.has(arg)) fail('启动参数无效'); const value = argv[index + 1]; if (!value || value.startsWith('--')) fail('启动参数缺少值'); options[arg] = value; index += 1; }
  if (options.demo && (options['--data-dir'] || options['--vault-root'])) fail('--demo 不能搭配外部数据路径'); if (options['--demo-dir'] && (options['--data-dir'] || options['--vault-root'])) fail('--demo-dir 不能搭配外部数据路径'); if (options['--port'] !== undefined && (!/^\d+$/u.test(options['--port']) || Number(options['--port']) > 65535)) fail('端口无效'); return options;
}
function demoSettings() {
  return {
    mode: 'demo',
    loadRegistry: async () => ({ registry: { code_projects: [], knowledge_projects: [], topics: [] }, warnings: [] }),
    organizer: input => organize(input, { provider: { async generateJson() {
      if (input.material.raw_content !== demoText) throw Object.assign(new Error('演示只处理内置示例'), { code: 'INPUT_INVALID', llm_requests: 0 });
      const none = { route_type: null, route_id: null, route_name: null };
      return { text: JSON.stringify({
        knowledge_candidates: [{ knowledge_layer: 'ENGINEERING_THINKING', title: '让重复判断尊重原始字节', content: '材料身份应基于原始字节计算。清洗、换行转换或 Unicode 归一化可能改变材料身份；原文保留与知识提炼应分开处理。', reason: '这是用户明确提出的工程约束。', route: none, evidence: [{ line_start: 1, line_end: 1, snippet: demoText.split('\n')[0] }] }],
        action_candidates: [{ action: '验证相同原文再次提交时复用已有结果', type: 'SUGGESTION', status: 'PROPOSED', reason: '助手给出了建议，用户尚未采纳。', related: none, evidence: [{ line_start: 2, line_end: 3, snippet: demoText.split('\n').slice(1).join('\n') }] }],
      }), usage: null, llm_requests: 1 };
    } } }),
  };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); if (!options) return null; const demo = Boolean(options.demo || options['--demo-dir']); let dataDir = options['--data-dir'] ?? path.join(os.homedir(), 'Library', 'Application Support', 'knowledge-agent'); let vaultRoot = options['--vault-root'] ?? VAULT_PATH; let settings = {};
  if (demo) { const prepared = options['--demo-dir'] ? await prepareDemoRoot(options['--demo-dir']) : await prepareDemoRoot(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'knowledge-agent-demo-'))); dataDir = prepared.dataDir; vaultRoot = prepared.vaultRoot; settings = demoSettings(); process.stdout.write(`隔离演示目录：${prepared.root}\n`); } else await rejectDemoMarkerAncestor(dataDir);
  const app = await createApp({ dataDir, vaultRoot, ...settings }); const url = await app.listen(options['--port'] === undefined ? 3210 : Number(options['--port'])); app.origin = url; process.stdout.write(`个人知识中心：${url}\n模式：${demo ? '隔离演示（模拟整理）' : '正式本地服务'}\n数据目录：${dataDir}\n`); return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(app => { if (!app) return; for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0))); }).catch(() => { process.stderr.write('启动失败：检查端口、私有数据路径、Vault 路径或 --help。\n'); process.exitCode = 1; });
}
