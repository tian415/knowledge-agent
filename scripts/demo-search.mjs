import fs from 'node:fs/promises';
import path from 'node:path';
import {createProductDemo} from '../src/capture/demo.mjs';
import {loadRuntimeConfig,openReviewWorkspace,runtimeSummary} from '../src/capture/runtime.mjs';
import {createProductApp} from '../src/app/product.mjs';

try{
 const [flag,python,...extra]=process.argv.slice(2);
 if(flag!=='--python'||!python||!path.isAbsolute(python)||extra.length)throw Error('Use --python /absolute/venv/bin/python');
 const demo=await createProductDemo();
 const raw=JSON.parse(await fs.readFile(demo.configFile,'utf8'));raw.search={python_executable:python};
 await fs.writeFile(demo.configFile,JSON.stringify(raw)+'\n',{mode:0o600});
 const config=await loadRuntimeConfig(demo.configFile),workspace=await openReviewWorkspace(config);
 const app=await createProductApp({workspace,config,runtime:{...runtimeSummary(config),demo:true,semantic_executor:'simulated_demo'},demoAdvance:demo.advance,loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]})});
 const url=await app.listen(0);console.log(JSON.stringify({status:'SERVING',mode:'synthetic_isolated_search',home:url+'/capture/',config:demo.configFile,private_directory:demo.root}));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}catch(error){console.error(JSON.stringify({error:error.code??'DEMO_FAILED'}));process.exitCode=1;}
