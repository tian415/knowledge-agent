import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processMaterial } from '../src/intake/process-material.mjs';
import { organize } from '../src/intake/organize.mjs';
import { createDeepSeekProvider } from '../src/intake/providers/deepseek.mjs';
import { renderPreview } from '../src/intake/preview.mjs';
import { createMaterial } from '../src/intake/material.mjs';

const help=`# Material Intake\n\n用法：node scripts/material-intake.mjs (--file <UTF8文件> | --stdin) --data-dir <私有绝对路径>\n\n可选：--source-type text|chatgpt|codex --source-title --source-url --source-id --captured-at（均接受一个值）。\n\n新材料将向 DeepSeek（DEEPSEEK_BASE_URL，默认 https://api.deepseek.com）上传原文及最小 Registry 上下文；仅提交获授权上传的材料。DEEPSEEK_API_KEY、DEEPSEEK_MODEL 从环境读取。有效重复材料不调用模型，不需要密钥。\n\n不写知识库、不创建待办、不采集聊天。输入最大 128 KiB，完整 prompt 最大 256 KiB；每日最多 10 次尝试，失败计数，不自动重试。\n`;
const valueArgs=new Set(['--file','--data-dir','--source-type','--source-title','--source-url','--source-id','--captured-at']);
function parse(argv) {
 const args={};
 for(let i=0;i<argv.length;i++) {
  const name=argv[i];if(Object.hasOwn(args,name))throw new Error();
  if(name==='--stdin')args[name]=true;
  else if(valueArgs.has(name)&&typeof argv[i+1]==='string'&&!argv[i+1].startsWith('--'))args[name]=argv[++i];
  else throw new Error();
 }
 if(Boolean(args['--stdin'])===Boolean(args['--file'])||!args['--data-dir']||!path.isAbsolute(args['--data-dir']))throw new Error();
 return args;
}
export async function main(argv=process.argv.slice(2)) {
 if(argv.length===1&&argv[0]==='--help'){process.stdout.write(help);return 0;}
 let material=null,result;
 try {
  const args=parse(argv);
  const bytes=args['--file']?await fs.readFile(args['--file']):Buffer.concat(await Array.fromAsync(process.stdin));
  const input={raw_content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),source_type:args['--source-type']??'text'};
  for(const name of ['source-title','source-url','source-id','captured-at'])input[name.replaceAll('-','_')]=args['--'+name]??null;
  material=createMaterial(input);
  result=await processMaterial(input,{dataDir:args['--data-dir'],organize:args=>organize(args,{provider:createDeepSeekProvider()})});
 }catch{
  result={status:'ERROR',knowledge_candidates:[],action_candidates:[],metrics:{llm_requests:0},warnings:[],error:{code:'INPUT_INVALID',message:'参数、文件读取或 UTF-8 编码无效。'}};
 }
 process.stdout.write(renderPreview({material,result}));return result.status==='ERROR'?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
