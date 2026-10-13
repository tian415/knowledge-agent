// Static synthetic event emitter. No model imports, filesystem reads, or network.
let input='';
for await(const chunk of process.stdin)input+=chunk;
const {prompt,scenario}=JSON.parse(input),payload=JSON.parse(prompt);
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(scenario==='timeout'){await new Promise(resolve=>setTimeout(resolve,60000));process.exit(0);}
if(scenario==='failed'){emit({type:'turn.failed',error:{message:'Synthetic failure'}});process.exit(0);}
let result;
if(payload.kind==='source'){
 const first=payload.input.snapshot.messages[0],last=payload.input.snapshot.messages.at(-1);
 const ref=m=>({message_id:m.id,quote:scenario==='invalid_evidence'?'synthetic missing quote':m.text});
 result={decision:scenario==='no_value'?'no_value':'draft',markdown:scenario==='no_value'?'':'离线合成结果，不代表模型生成质量。',reason:'仅验证单次执行合同。',coverage:{question:[ref(first)],analysis:[ref(first)],ending:[ref(last)]},usage:null,knowledge_units:[]};
}else{
 result={kind:scenario==='no_value'?'no_value':'knowledge',markdown:scenario==='no_value'?'':'离线合成主题，不代表真实知识。',contribution:'仅验证主题执行合同。',evidence:payload.input.source_snapshots.map(({id,snapshot})=>({job_id:id,message_id:snapshot.messages[0].id,quote:scenario==='invalid_evidence'?'synthetic missing quote':snapshot.messages[0].text}))};
}
emit({type:'item.completed',item:{id:'synthetic-output',type:'agent_message',text:scenario==='invalid_json'?'not json':JSON.stringify(result)}});
emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:50,reasoning_output_tokens:5}});
if(scenario==='exit_after_usage')process.exitCode=1;
