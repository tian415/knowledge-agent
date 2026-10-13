import {createProductDemo} from '../src/capture/demo.mjs';
import {createProductApp} from '../src/app/product.mjs';
try{
 const args=process.argv.slice(2);
 if(args.length!==0&&(args.length!==2||args[0]!=='--port'||!/^\d+$/u.test(args[1])||Number(args[1])>65535))throw Error('Use --port 0..65535');
 const demo=await createProductDemo(),app=await createProductApp({workspace:demo,config:demo.config,runtime:demo.runtime,demoAdvance:demo.advance,loadRegistry:async()=>({registry:{code_projects:[],knowledge_projects:[],topics:[]},warnings:[]})});
 const url=await app.listen(args.length?Number(args[1]):0);
 console.log(JSON.stringify({status:'SERVING',mode:'synthetic_isolated_demo',url,home:url+'/capture/',private_directory:demo.root,config:demo.configFile}));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}catch(e){console.error(JSON.stringify({error:e.code??'DEMO_FAILED'}));process.exitCode=1;}
