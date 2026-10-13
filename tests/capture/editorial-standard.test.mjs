import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {openCaptureStore} from '../../src/capture/store.mjs';
import {snapshot,temp,now} from './helpers.mjs';
import {readingBody} from '../../src/shared/source-reading.mjs';
import {readingContent} from '../../src/capture/topic-publish.mjs';
import {renderClassificationGuide} from '../../src/shared/knowledge-standard.mjs';

test('source claims and legacy rules expose the same admission and title standard',async t=>{
 const store=await openCaptureStore({dataDir:(await temp(t))+'/capture'});
 await store.enqueueProcessing({snapshot:snapshot(),recipe:'knowledge-units-v2'});
 const claim=await store.claimProcessing({now});
 const legacy=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"import {main} from './compat/project-knowledge/lib/cli.mjs';process.argv=['node','pk','rules'];main();"],{encoding:'utf8'}));
 assert.deepEqual(claim.review_contract.classification,legacy);
 assert.match(legacy.admission,/篮球闲聊/);
 assert.match(legacy.admission,/认真学习/);
 assert.match(legacy.admission,/篇数配额/);
 assert.match(legacy.titles,/直白具体/);
 assert.match(legacy.writing,/首段直接/);assert.match(legacy.writing,/真实问题/);assert.match(legacy.writing,/表格/);assert.match(legacy.writing,/不套固定模板/);
 assert.equal(claim.review_contract.writing,legacy.writing);
 const guide=renderClassificationGuide();assert.ok(guide.includes(legacy.admission));assert.ok(guide.includes(legacy.titles));assert.ok(guide.includes(legacy.writing));assert.match(guide,/本次明确授权/);assert.match(guide,/逐项核对/);assert.match(guide,/不扩展为自动写入/);
});

test('reading drops only a matching opening title and preserves project names and code',()=>{
 assert.equal(readingBody('# Agent 组件\n\n## 机制\n\n内容','Agent 组件'),'## 机制\n\n内容');
 assert.equal(readingBody('# 示例商店\n\n范围','00-项目概览'),'# 示例商店\n\n范围');
 assert.equal(readingBody('```md\n# Agent 组件\n```','Agent 组件'),'```md\n# Agent 组件\n```');
 const topic={title:'原主题',result:{markdown:'# Agent 组件\n\n内容',evidence:[]}};
 for(const option of ['03-长期知识/Agent 组件.md',{relativePath:'03-长期知识/Agent 组件.md'}])assert.ok(readingContent(topic,[],option).startsWith('内容\n'));
});
