import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../src/shared/validate-schema.mjs';
import { PREFIXES, safeRelative } from '../../src/shared/knowledge-paths.mjs';

test('nullable enum still validates non-null values and null membership', () => {
  const schema = {type:['string','null'],enum:['YES',null],minLength:1};
  validateSchema(null,schema); validateSchema('YES',schema);
  for (const value of ['NO','',3,{}]) assert.throws(()=>validateSchema(value,schema));
  assert.throws(()=>validateSchema(null,{type:['string','null'],enum:['YES']}));
});
test('integer bounds apply including nullable integers', () => {
  const schema={type:['integer','null'],minimum:1,maximum:3};
  for (const n of [null,1,3]) validateSchema(n,schema);
  for (const n of [0,4,1.5,NaN,Infinity,'1']) assert.throws(()=>validateSchema(n,schema));
});
test('nested strict fields, array limits and string length', () => {
  const schema={type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',minItems:1,maxItems:2,items:{type:'string',minLength:1}}}};
  validateSchema({items:['a']},schema);
  for (const value of [{},{items:[]},{items:['']},{items:['a','b','c']},{items:['a'],extra:true},{items:[1]}]) assert.throws(()=>validateSchema(value,schema));
});
test('number validation preserves confidence constraints', () => {
  const schema={type:'number',minimum:0,maximum:1};
  validateSchema(0.5,schema);
  for(const n of [-1,2,NaN,Infinity]) assert.throws(()=>validateSchema(n,schema));
});
test('four knowledge layer paths remain accepted', () => {
  assert.deepEqual(PREFIXES,{PROJECT_KNOWLEDGE:'01-项目沉淀/',ENGINEERING_THINKING:'02-方法论/工程思维/',PRODUCT_THINKING:'02-方法论/产品思维/',GENERAL_KNOWLEDGE:'03-长期知识/'});
  for(const [layer,prefix] of Object.entries(PREFIXES)) assert.equal(safeRelative(`${prefix}候选.md`,layer),`${prefix}候选.md`);
});
test('rejects traversal, noncanonical, cross-layer and system paths', () => {
  for(const bad of ['../a.md','/tmp/a.md','01-项目沉淀/../a.md','01-项目沉淀/./a.md','01-项目沉淀//a.md','01-项目沉淀\\a.md','01-项目沉淀/a\0.md','01-项目沉淀/a.txt',...['附件','模板','90-系统','.obsidian','.project-knowledge'].map(x=>`01-项目沉淀/${x}/a.md`)]) assert.throws(()=>safeRelative(bad,'PROJECT_KNOWLEDGE'),bad);
  assert.throws(()=>safeRelative('01-项目沉淀/a.md','ENGINEERING_THINKING'));
});
test('legacy modules re-export the same pure functions without running their mains', async () => {
  const router=await import('../../scripts/dual-layer-router-test.mjs');
  const writer=await import('../../scripts/real-writer-preview.mjs');
  assert.equal(router.validateSchema,validateSchema);
  assert.equal(writer.safeRelative,safeRelative);
  assert.equal(writer.PREFIXES,PREFIXES);
  validateSchema({should_persist:false,route_type:'NO_KNOWLEDGE',route_id:null,route_name:null,knowledge_types:[],title:'',distilled_content:'',confidence:0},router.contextSchema);
});
