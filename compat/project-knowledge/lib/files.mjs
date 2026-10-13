import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const pathKey = value => value.normalize('NFC').toLowerCase();
export const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export const json = file => { const text = read(file); if (text === null) throw new Error(`文件不存在: ${file}`); return JSON.parse(text); };
export function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value)) throw new Error('必须是安全相对路径');
  if (value.split('/').some(p => !p || p === '.' || p === '..' || /[<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error('非法相对路径');
  return value;
}
export function safe(vault, rel) {
  relative(rel); const root = fs.realpathSync(vault); let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接 symbolic link: ${rel}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return current;
}
export function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    if (read(file) !== text) throw new Error(`读回不一致: ${file}`);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export const encode = value => `${JSON.stringify(value, null, 2)}\n`;
export function lock(vault, fn) {
  const file = safe(vault, '.project-knowledge/write.lock');
  let fd; try { fd = fs.openSync(file, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('写入锁存在；确认没有运行中的写入后执行 unlock'); throw e; }
  fs.writeFileSync(fd, encode({ pid: process.pid, createdAt: new Date().toISOString() })); fs.closeSync(fd);
  try { return fn(); } finally { fs.unlinkSync(file); }
}
