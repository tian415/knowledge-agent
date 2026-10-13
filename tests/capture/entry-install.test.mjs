import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {installProjectKnowledge,installDailyBridge} from '../../scripts/install-project-knowledge.mjs';
import {classificationStandard} from '../../src/capture/knowledge-routing.mjs';
import {renderSourceSummaries} from '../../src/shared/source-reading.mjs';

test('installed old command uses the same rules and creates an unrouted full-source draft',async t=>{
 const root=await fs.mkdtemp((await fs.realpath(os.tmpdir()))+'/skill-entry-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const destination=root+'/project-knowledge';await installProjectKnowledge(destination);const cli=destination+'/scripts/pk.mjs';
 const run=args=>JSON.parse(execFileSync(process.execPath,[cli,...args],{encoding:'utf8'}));
 assert.deepEqual(run(['rules']),classificationStandard);
 await installDailyBridge(root+'/daily-dev-retrospective');
 assert.deepEqual(JSON.parse(execFileSync(process.execPath,[root+'/daily-dev-retrospective/scripts/pk.mjs','rules'],{encoding:'utf8'})),classificationStandard);
 const vault=root+'/vault';await fs.mkdir(vault);run(['init','--vault',vault]);
 const input=root+'/source.md',raw='保留完整材料\r\n'+('多类别讨论。'.repeat(300));await fs.writeFile(input,raw);
 const out=root+'/draft.json';run(['draft','--vault',vault,'--input',input,'--project','fresh','--source-id','chat-1','--title','讨论','--out',out]);
 const draft=JSON.parse(await fs.readFile(out));assert.equal(draft.version,2);assert.deepEqual(draft.notes,[]);assert.equal(draft.sources[0].excerpt,raw);assert.equal(draft.sources[0].observedAt,null);assert.equal(draft.source_project,'fresh');
 assert.deepEqual((await installProjectKnowledge(destination)).changed,[]);
});
test('shared sources group messages by conversation, keep distinct conversations and escape text',()=>{
 const base={title:'讨论 <script>',dates:['2026-09-08'],summary:'边界 <img>',partial:true};
 const html=renderSourceSummaries([{...base,id:'a',url:'https://chatgpt.com/c/one'}, {...base,id:'b',url:'https://chatgpt.com/c/one',dates:['2026-09-09']},{...base,id:'c',url:'https://chatgpt.com/c/two'},{...base,id:'d',url:'javascript:alert(1)',dates:[]}]);
 assert.ok(html.includes('来源（3 段对话）'));assert.ok(html.includes('2026-09-08—2026-09-09'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('javascript:'));assert.ok(html.includes('&lt;img&gt;'));
});
