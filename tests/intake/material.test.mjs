import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMaterial, indexLines } from '../../src/intake/material.mjs';
const make = (raw_content, metadata = {}) => createMaterial({ raw_content, source_type: 'text', ...metadata });

test('identity uses exact UTF-8 content, independently of metadata', () => {
  const raw = ' User: 你好\r\nAssistant: 好的\n';
  const a = make(raw);
  const b = make(raw, { source_type: 'codex', source_title: '标题', source_url: 'https://example.com/chat', source_id: 'provided', captured_at: '2026-09-10T10:00:00+08:00' });
  const hash = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
  assert.equal(a.raw_content, raw);
  assert.equal(a.content_hash, hash);
  assert.equal(a.material_id, `mat_${hash}`);
  assert.equal(b.material_id, a.material_id);
  assert.equal(b.source_id, 'provided');
  assert.equal(b.captured_at, '2026-09-10T10:00:00+08:00');
});
for (const [label, raw] of [['one character', '你好乙'], ['space', '你好甲 '], ['CRLF', '你好甲\r\n'], ['LF', '你好甲\n']]) {
  test(`${label} changes hash and id`, () => {
    assert.notEqual(make(raw).content_hash, make('你好甲').content_hash);
    assert.notEqual(make(raw).material_id, make('你好甲').material_id);
  });
}
test('CRLF differs from LF; Unicode is not normalized', () => {
  assert.notEqual(make('a\r\nb').material_id, make('a\nb').material_id);
  assert.notEqual(make('é').material_id, make('e\u0301').material_id);
});
test('unknown metadata stays null and material has exactly eight fields', () => {
  const m = make('text', { source_title: null, source_url: null, source_id: null, captured_at: null });
  assert.deepEqual(Object.keys(m).sort(), ['material_id','source_type','source_title','source_url','source_id','captured_at','raw_content','content_hash'].sort());
  for (const key of ['source_title','source_url','source_id','captured_at']) {
    assert.equal(m[key], null); assert.equal(make('text')[key], null);
  }
});
test('rejects blank, non-string and lossy UTF-8 inputs', () => {
  for (const raw of ['', ' \r\n\t', null, 12, Buffer.from([0xff]), '\ud800', '\udc00']) assert.throws(() => make(raw));
  assert.equal(make('😀').raw_content, '😀');
});
test('rejects invalid source types and metadata types', () => {
  for (const source_type of ['file', '', null]) assert.throws(() => make('a', { source_type }));
  for (const key of ['source_title','source_url','source_id','captured_at']) assert.throws(() => make('a', { [key]: 123 }));
});
test('accepts only explicit http(s) URLs without changing them', () => {
  for (const url of ['https://example.com/a?q=1', 'http://example.com']) assert.equal(make('a', { source_url: url }).source_url, url);
  for (const url of ['', 'example.com', 'file:///tmp/a', 'javascript:alert(1)', 'https://', ' https://example.com', 'https://exa mple.com']) assert.throws(() => make('a', { source_url: url }));
});
test('requires real calendar dates and explicit timezone', () => {
  for (const date of ['2024-02-29T12:30:00Z', '2026-09-10T10:00:00.123+08:00']) assert.equal(make('a', { captured_at: date }).captured_at, date);
  for (const date of ['', 'yesterday', '2026-09-10', '2026-09-10T10:00:00', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-10T24:00:00Z', '2026-09-10T10:00:00+25:00']) assert.throws(() => make('a', { captured_at: date }), date);
});
test('line indices preserve CR, empty lines and trailing newline exactly', () => {
  const raw = '甲\r\n\n乙\n';
  assert.deepEqual(indexLines(raw), [{line_index:1,text:'甲\r'},{line_index:2,text:''},{line_index:3,text:'乙'},{line_index:4,text:''}]);
  assert.equal(indexLines(raw).map(x => x.text).join('\n'), raw);
  assert.deepEqual(indexLines(''), [{line_index:1,text:''}]);
});
