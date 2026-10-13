import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
export const now='2026-09-20T08:00:00.000Z';
export const snapshot=()=>({schema_version:1,source:{system:'codex',scope:'project',conversation_id:'t1'},channel:'local_log',title:'测试',url:null,captured_at:now,completeness:'partial',gaps:['history_not_verified'],messages:[{id:'m1',role:'user',text:'先讨论，尚未决定。',source_time:null,text_format:'source_text'}]});
export async function temp(t){const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'capture-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
