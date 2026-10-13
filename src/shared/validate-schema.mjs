import assert from 'node:assert/strict';

// Small validator for the JSON Schema subset used by the Router and intake.
export function validateSchema(value, schema, location = 'output') {
  const matches = (type) => type === 'null' ? value === null
    : type === 'integer' ? Number.isInteger(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : typeof value === type;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find(matches);
  assert(type !== undefined, `${location}: invalid type`);
  if (schema.enum) assert(schema.enum.includes(value), `${location}: invalid enum`);
  if (type === 'null') return;
  if (type === 'object') {
    assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort(), `${location}: invalid fields`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchema(value[key], child, `${location}.${key}`);
  } else if (type === 'array') {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${location}: too few items`);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, `${location}: too many items`);
    value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`));
  } else if (type === 'string') {
    if (schema.minLength !== undefined) assert([...value].length >= schema.minLength, `${location}: too short`);
  } else if (type === 'number' || type === 'integer') {
    assert(Number.isFinite(value), `${location}: non-finite number`);
    if (schema.minimum !== undefined) assert(value >= schema.minimum, `${location}: below minimum`);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, `${location}: above maximum`);
  }
}
