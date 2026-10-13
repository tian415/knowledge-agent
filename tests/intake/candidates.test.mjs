import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateSchema, validateCandidates, attachLocations } from '../../src/intake/candidates.mjs';
import { createMaterial } from '../../src/intake/material.mjs';
import { PREFIXES } from '../../src/shared/knowledge-paths.mjs';

const material=createMaterial({source_type:'text',raw_content:'User: 我决定做验证。 \r\nAssistant: 哈希用于识别输入变化，不保证正确。\nUser: 后来取消了。\n'});
const registry={
  code_projects:[{id:'app',name:'App',route_type:'CODE_PROJECT',status:'active',repo_path:'/Users/example/app',knowledge_targets:[{dashboard:'01-项目沉淀/app/概览.md',path:'01-项目沉淀/app'}]}],
  knowledge_projects:[{id:'learning',name:'Learning',route_type:'KNOWLEDGE_PROJECT',dashboard:'01-项目沉淀/learning/概览.md',status:'active'}],
  topics:[{id:'general',name:'General',route_type:'TOPIC',dashboard:'03-长期知识/general/概览.md',status:'active'}]
};
const route={route_type:'CODE_PROJECT',route_id:'app',route_name:'App'};
const none={route_type:null,route_id:null,route_name:null};
const unknown={route_type:'PROJECT_CANDIDATE',route_id:null,route_name:'New Project'};
const evidence=()=>[{line_start:1,line_end:1,snippet:'User: 我决定做验证。 \r'}];
const knowledge=(extra={})=>({knowledge_layer:'PROJECT_KNOWLEDGE',title:'验证决定',content:'用户决定做验证',reason:'保留决策依据',route:{...route},evidence:evidence(),...extra});
const action=(extra={})=>({action:'做验证',type:'COMMITMENT',related:{...route},reason:'用户明确决定',status:'PROPOSED',evidence:evidence(),...extra});
const output=(k=[],a=[])=>({knowledge_candidates:k,action_candidates:a});
const validate=value=>validateCandidates(value,material,registry);

test('strict root allows independent empty knowledge/action arrays',()=>{
  for(const value of [output(),output([knowledge()]),output([],[action()])])assert.doesNotThrow(()=>validate(value));
  for(const value of [{knowledge_candidates:[]},{action_candidates:[]},{...output(),extra:true}])assert.throws(()=>validate(value));
  assert.deepEqual(candidateSchema.required,['knowledge_candidates','action_candidates']);
  assert.equal(candidateSchema.additionalProperties,false);
});
test('schema has no model-controlled paths or source metadata at any depth',()=>{
  function check(schema){for(const key of Object.keys(schema.properties??{}))assert(!['target_path','directory','location','material_id','source_url','source_id','captured_at'].includes(key));for(const child of Object.values(schema.properties??{}))check(child);if(schema.items)check(schema.items);}
  check(candidateSchema);
  for(const field of ['target_path','directory','location','material_id','source_url'])assert.throws(()=>validate(output([knowledge({[field]:'invented'})])));
});
test('known Registry route requires matching type/id/name in both candidate kinds',()=>{
  for(const entity of [...registry.code_projects,...registry.knowledge_projects,...registry.topics]){
    const r={route_type:entity.route_type,route_id:entity.id,route_name:entity.name};
    assert.doesNotThrow(()=>validate(output([knowledge({knowledge_layer:'GENERAL_KNOWLEDGE',route:r})],[action({related:r})])));
  }
  for(const r of [{...route,route_name:'Wrong'},{...route,route_id:'wrong'},{...route,route_type:'KNOWLEDGE_PROJECT'}]){
    assert.throws(()=>validate(output([knowledge({route:r})])));assert.throws(()=>validate(output([],[action({related:r})])));
  }
});
test('unknown projects remain candidates and null association is coherent',()=>{
  assert.doesNotThrow(()=>validate(output([knowledge({route:unknown})],[action({related:unknown})])));
  assert.doesNotThrow(()=>validate(output([knowledge({knowledge_layer:'ENGINEERING_THINKING',route:none})],[action({related:none})])));
  for(const r of [{...unknown,route_id:'app'},{...unknown,route_name:' '},{...none,route_id:'app'},{...none,route_name:'App'}])assert.throws(()=>validate(output([],[action({related:r})])));
  assert.throws(()=>validate(output([knowledge({route:none})])));
  assert.throws(()=>validate(output([knowledge({route:{route_type:'TOPIC',route_id:'general',route_name:'General'}})])));
});
test('all four knowledge layers are allowed and required text is nonblank',()=>{
  for(const knowledge_layer of Object.keys(PREFIXES))assert.doesNotThrow(()=>validate(output([knowledge({knowledge_layer})])));
  for(const field of ['title','content','reason'])for(const value of ['',' \n'])assert.throws(()=>validate(output([knowledge({[field]:value})])));
  assert.throws(()=>validate(output([knowledge({knowledge_layer:'NEW_CATEGORY'})])));
  const concept=knowledge({knowledge_layer:'ENGINEERING_THINKING',route:none,title:'哈希',content:'本次用哈希识别输入变化，但哈希不能证明知识正确。'});
  assert.doesNotThrow(()=>validate(output([concept])));
});
test('exact multiline evidence preserves LF, CR and spaces',()=>{
  const e=[{line_start:1,line_end:2,snippet:material.raw_content.split('\n').slice(0,2).join('\n')}];
  assert.doesNotThrow(()=>validate(output([knowledge({evidence:e})])));
});
for(const [name,e] of [
  ['zero',[{line_start:0,line_end:1,snippet:'x'}]],
  ['out of bounds',[{line_start:1,line_end:99,snippet:'x'}]],
  ['reversed',[{line_start:2,line_end:1,snippet:'x'}]],
  ['fraction',[{line_start:1.5,line_end:2,snippet:'x'}]],
  ['space removed',[{line_start:1,line_end:1,snippet:'User: 我决定做验证。\r'}]],
  ['character changed',[{line_start:1,line_end:1,snippet:'User: 我决定做测试。 \r'}]],
  ['CR removed',[{line_start:1,line_end:1,snippet:'User: 我决定做验证。 '}]],
  ['empty',[]]
])test(`invalid evidence ${name} rejects the whole output`,()=>{
  assert.throws(()=>validate(output([knowledge(),knowledge({title:'bad',evidence:e})])),{code:'INVALID_OUTPUT'});
  assert.throws(()=>validate(output([],[action({evidence:e})])),{code:'INVALID_OUTPUT'});
});
test('Unicode-normalized near quotes are rejected',()=>{
  const m=createMaterial({source_type:'text',raw_content:'e\u0301'});
  assert.throws(()=>validateCandidates(output([knowledge({evidence:[{line_start:1,line_end:1,snippet:'é'}]})]),m,registry));
});
test('validated candidates receive actual material identity without mutating model output',()=>{
  const value=output([knowledge()],[action()]);const before=structuredClone(value);const validated=validate(value);
  assert.deepEqual(value,before);
  assert.equal(validated.knowledge_candidates[0].material_id,material.material_id);
  assert.equal(validated.action_candidates[0].material_id,material.material_id);
});
test('action types and statuses are validated without pretending to infer acceptance',()=>{
  for(const status of ['PROPOSED','NEEDS_CONFIRMATION','COMPLETED','CANCELLED','SUPERSEDED','DEFERRED'])assert.doesNotThrow(()=>validate(output([],[action({status})])));
  assert.doesNotThrow(()=>validate(output([],[action({type:'FOLLOW_UP',status:'NEEDS_CONFIRMATION'})])));
  for(const extra of [{type:'TODO'},{status:'OVERDUE'},{action:' '},{reason:''}])assert.throws(()=>validate(output([],[action(extra)])));
});
test('PROPOSED suggestions may number zero through three; fourth is rejected',()=>{
  const suggestions=Array.from({length:4},(_,i)=>action({action:`建议 ${i}`,type:'SUGGESTION'}));
  for(const n of [0,1,2,3])assert.doesNotThrow(()=>validate(output([],suggestions.slice(0,n))));
  assert.throws(()=>validate(output([],suggestions)));
  assert.doesNotThrow(()=>validate(output([],[...suggestions.slice(0,3),{...suggestions[3],status:'DEFERRED'}])));
});
test('exact duplicate candidates are rejected, not silently dropped',()=>{
  assert.throws(()=>validate(output([knowledge(),knowledge()])));
  assert.throws(()=>validate(output([],[action(),action()])));
});
test('unique code knowledge target supplies path, never repo_path',async()=>{
  const value=validate(output([knowledge()],[action()]));const before=structuredClone(value);
  const attached=await attachLocations(value,registry);
  assert.equal(attached.knowledge_candidates[0].location.target_path,'01-项目沉淀/app/概览.md');
  assert.equal(attached.knowledge_candidates[0].location.directory,PREFIXES.PROJECT_KNOWLEDGE);
  assert.deepEqual(attached.action_candidates,value.action_candidates);
  assert(!Object.hasOwn(attached.action_candidates[0],'location'));assert.deepEqual(value,before);
  const noTarget=structuredClone(registry);noTarget.code_projects[0].knowledge_targets=[];
  assert.equal((await attachLocations(value,noTarget)).knowledge_candidates[0].location.target_path,null);
});
test('multiple targets yield review, not an arbitrary selection',async()=>{
  const r=structuredClone(registry);r.code_projects[0].knowledge_targets.push({dashboard:'01-项目沉淀/app/另一概览.md'});
  const {location}= (await attachLocations(validate(output([knowledge()])),r)).knowledge_candidates[0];
  assert.equal(location.target_path,null);assert.equal(location.review_required,true);
});
test('unknown projects and unassociated knowledge get only fixed layer directories',async()=>{
  for(const layer of Object.keys(PREFIXES)){
    const value=validate(output([knowledge({knowledge_layer:layer,route:unknown})]));
    const {location}=(await attachLocations(value,registry)).knowledge_candidates[0];
    assert.equal(location.directory,PREFIXES[layer]);assert.equal(location.target_path,null);assert.equal(location.review_required,true);
  }
});
test('knowledge-project and topic use matching registered dashboard',async()=>{
  for(const [entity,layer] of [[registry.knowledge_projects[0],'PROJECT_KNOWLEDGE'],[registry.topics[0],'GENERAL_KNOWLEDGE']]){
    const r={route_type:entity.route_type,route_id:entity.id,route_name:entity.name};
    const {location}=(await attachLocations(validate(output([knowledge({knowledge_layer:layer,route:r})])),registry)).knowledge_candidates[0];
    assert.equal(location.target_path,entity.dashboard);
  }
});
test('unmatched layer falls back; dangerous Registry paths are rejected',async()=>{
  const value=validate(output([knowledge({knowledge_layer:'ENGINEERING_THINKING'})]));
  assert.equal((await attachLocations(value,registry)).knowledge_candidates[0].location.target_path,null);
  for(const dashboard of ['../escape.md','/tmp/escape.md','01-项目沉淀/.obsidian/a.md','01-项目沉淀/../a.md']){
    const r=structuredClone(registry);r.code_projects[0].knowledge_targets=[{dashboard}];
    await assert.rejects(attachLocations(validate(output([knowledge()])),r));
  }
});
test('unverified or missing targets require review without creating a directory',async()=>{
  const {location}=(await attachLocations(validate(output([knowledge()])),registry)).knowledge_candidates[0];
  assert.equal(location.review_required,true);assert(location.reason.length>0);
});
