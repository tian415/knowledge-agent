import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCards } from '../../src/app/project-view.mjs';
test('Registry membership never becomes confirmed progress and manual status wins',()=>{
 const registry={code_projects:[{id:'ka',name:'知识中心',route_type:'CODE_PROJECT',status:'active',repo_path:'/private/never-return'}],knowledge_projects:[{id:'lab',name:'工具实验',route_type:'KNOWLEDGE_PROJECT',status:'reference'}],topics:[{id:'topic',name:'普通主题'}]};
 const manual=[{id:'ka',kind:'project',goal:'跑通入口',stage:'已验证',blocker:null,next_step:'试用',evidence:'用户核验记录',confirmed:true,confirmed_at:'2026-09-12T08:00:00.000Z'}];
 const cards=projectCards(registry,manual);
 assert.equal(cards.length,2);assert.equal(cards[0].name,'知识中心');assert.equal(cards[0].stage,'已验证');assert.equal(cards[0].confirmed,true);
 assert.equal(cards[1].stage,null);assert.equal(cards[1].confirmed,false);assert.equal(cards[1].registry_status,'reference');
 assert.ok(!JSON.stringify(cards).includes('/private/never-return'));
});
test('user-created learning cards survive when Registry is unavailable',()=>{
 const manual=[{id:'learn-hash',kind:'learning',goal:'理解哈希',stage:'已实践',evidence:'手动验证两份文件',confirmed:true,confirmed_at:'2026-09-12T08:00:00.000Z'}];
 const cards=projectCards(null,manual);assert.equal(cards.length,1);assert.equal(cards[0].id,'learn-hash');assert.equal(cards[0].kind,'learning');
});
