import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function validateCapturedAt(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  assert(match, 'captured_at must be ISO datetime with timezone');
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  assert(m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1], 'Invalid calendar date');
  assert(Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60, 'Invalid clock time');
  assert(offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60), 'Invalid timezone');
  assert(Number.isFinite(Date.parse(value)), 'Invalid captured_at');
}

export function createMaterial(input) {
  const { raw_content, source_type, source_title = null, source_url = null, source_id = null, captured_at = null } = input;
  assert(typeof raw_content === 'string' && /\S/u.test(raw_content), 'raw_content must be nonblank text');
  // Reject lone surrogates rather than silently replacing them during UTF-8 encoding.
  assert(Buffer.from(raw_content, 'utf8').toString('utf8') === raw_content, 'raw_content must encode losslessly as UTF-8');
  assert(['chatgpt', 'codex', 'text'].includes(source_type), 'Invalid source_type');
  for (const [key, value] of Object.entries({source_title, source_url, source_id, captured_at})) {
    assert(value === null || typeof value === 'string', `${key} must be string or null`);
  }
  if (source_url !== null) {
    assert(/^https?:\/\//u.test(source_url) && !/\s/u.test(source_url), 'Invalid source_url');
    const url = new URL(source_url);
    assert(['http:', 'https:'].includes(url.protocol) && url.hostname, 'Invalid source_url');
  }
  if (captured_at !== null) validateCapturedAt(captured_at);
  const content_hash = createHash('sha256').update(Buffer.from(raw_content, 'utf8')).digest('hex');
  return { material_id: `mat_${content_hash}`, source_type, source_title, source_url, source_id, captured_at, raw_content, content_hash };
}

export function indexLines(raw_content) {
  assert(typeof raw_content === 'string', 'raw_content must be text');
  return raw_content.split('\n').map((text, index) => ({ line_index: index + 1, text }));
}
