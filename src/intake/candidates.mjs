import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { validateSchema } from '../shared/validate-schema.mjs';
import { PREFIXES, safeRelative } from '../shared/knowledge-paths.mjs';
import { ROUTE_GROUPS, checkVaultPath } from '../registry/load-registry.mjs';
import { indexLines } from './material.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string', minLength: 1 };
const nullableText = { type: ['string', 'null'] };
const routeSchema = object({
  route_type: { type: ['string', 'null'], enum: [...Object.keys(ROUTE_GROUPS), 'PROJECT_CANDIDATE', null] },
  route_id: nullableText, route_name: nullableText,
});
const evidenceSchema = { type: 'array', minItems: 1, items: object({
  line_start: { type: 'integer', minimum: 1 }, line_end: { type: 'integer', minimum: 1 }, snippet: text,
}) };
export const candidateSchema = object({
  knowledge_candidates: { type: 'array', items: object({
    knowledge_layer: { type: 'string', enum: Object.keys(PREFIXES) }, title: text, content: text, reason: text,
    route: routeSchema, evidence: evidenceSchema,
  }) },
  action_candidates: { type: 'array', items: object({
    action: text, type: { type: 'string', enum: ['COMMITMENT', 'SUGGESTION', 'FOLLOW_UP'] },
    related: routeSchema, reason: text,
    status: { type: 'string', enum: ['PROPOSED', 'NEEDS_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'SUPERSEDED', 'DEFERRED'] },
    evidence: evidenceSchema,
  }) },
});

function entityFor(route, registry) {
  const { route_type: type, route_id: id, route_name: name } = route;
  if (type === null) { assert(id === null && name === null, 'Unassociated route must be all null'); return null; }
  if (type === 'PROJECT_CANDIDATE') {
    assert(id === null && typeof name === 'string' && /\S/u.test(name), 'Project candidate requires null ID and a name');
    return null;
  }
  assert(Object.hasOwn(ROUTE_GROUPS, type), 'Unknown route type');
  const matches = registry[ROUTE_GROUPS[type]].filter(entry => entry.id === id && entry.name === name && entry.route_type === type);
  assert(matches.length === 1, 'Registry type/id/name mismatch or ambiguity');
  return matches[0];
}

export function validateCandidates(output, material, registry) {
  try {
    validateSchema(output, candidateSchema);
    const lines = indexLines(material.raw_content);
    const groups = [output.knowledge_candidates, output.action_candidates];
    for (const candidates of groups) {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        assert(!candidates.slice(0, i).some(other => isDeepStrictEqual(candidate, other)), 'Duplicate candidate');
        entityFor(candidate.route ?? candidate.related, registry);
        for (const field of ['title', 'content', 'action', 'reason']) {
          if (Object.hasOwn(candidate, field)) assert(/\S/u.test(candidate[field]), `Blank ${field}`);
        }
        if (candidate.knowledge_layer === 'PROJECT_KNOWLEDGE') {
          assert(['CODE_PROJECT', 'KNOWLEDGE_PROJECT', 'PROJECT_CANDIDATE'].includes(candidate.route.route_type), 'Project knowledge requires a project route');
        }
        for (const e of candidate.evidence) {
          assert(e.line_end >= e.line_start && e.line_end <= lines.length, 'Invalid evidence range');
          const source = lines.slice(e.line_start - 1, e.line_end).map(line => line.text).join('\n');
          assert.equal(e.snippet, source, 'Evidence must match exact raw lines');
        }
      }
    }
    assert(output.action_candidates.filter(c => c.type === 'SUGGESTION' && c.status === 'PROPOSED').length <= 3, 'At most three proposed suggestions');
    // Acceptance, responsibility and temporal interpretation remain semantic judgments.
    // Identity is added only after the entire output passes; never mutate or filter model output.
    return {
      knowledge_candidates: output.knowledge_candidates.map(c => ({ ...structuredClone(c), material_id: material.material_id })),
      action_candidates: output.action_candidates.map(c => ({ ...structuredClone(c), material_id: material.material_id })),
    };
  } catch (error) {
    throw Object.assign(new Error(`Invalid candidates: ${error.message}`, { cause: error }), { code: 'INVALID_OUTPUT' });
  }
}

export async function attachLocations(output, registry) {
  const knowledge_candidates = [];
  for (const candidate of output.knowledge_candidates) {
    const layer = candidate.knowledge_layer;
    assert(Object.hasOwn(PREFIXES, layer), 'Unknown knowledge layer');
    const directory = PREFIXES[layer];
    // safeRelative validates file paths; this fixed probe only checks the directory prefix.
    // It is never returned as a proposal, opened or created.
    safeRelative(`${directory}__path_check__.md`, layer);
    const entity = entityFor(candidate.route, registry);
    const registered = entity ? candidate.route.route_type === 'CODE_PROJECT'
      ? (entity.knowledge_targets ?? []).map(target => target.dashboard)
      : [entity.dashboard].filter(target => target !== undefined) : [];
    const matching = [];
    for (const target of registered) {
      assert(typeof target === 'string', 'Invalid registered dashboard');
      const targetLayer = Object.keys(PREFIXES).find(key => target.startsWith(PREFIXES[key])) ?? layer;
      safeRelative(target, targetLayer);
      if (targetLayer === layer) matching.push(target);
    }
    const unique = [...new Set(matching)];
    const target_path = unique.length === 1 ? unique[0] : null;
    const reasons = [];
    let review_required = Boolean(entity?.review_required);
    if (review_required) reasons.push('Registry 归属需要确认');
    if (!target_path) {
      review_required = true;
      reasons.push(unique.length > 1 ? '存在多个已登记目标，需确认选择' : '没有该知识层的已登记目标，仅建议固定目录');
    } else reasons.push('建议使用 Registry 唯一匹配目标；未写入');
    // Only metadata checks for this fixed directory and the registered target; no Markdown scan.
    for (const [relative, type] of [[directory, 'directory'], ...(target_path ? [[target_path, 'file']] : [])]) {
      const warning = await checkVaultPath(relative, type);
      if (warning) { review_required = true; reasons.push(`${warning.code}: ${warning.path}；未创建或修复`); }
    }
    knowledge_candidates.push({ ...structuredClone(candidate), location: { directory, target_path, review_required, reason: reasons.join('；') } });
  }
  return { knowledge_candidates, action_candidates: structuredClone(output.action_candidates) };
}
