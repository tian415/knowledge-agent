#!/usr/bin/env node
import {readBackfillInventory,writeBackfillInventory} from '../src/capture/backfill-inventory.mjs';
const args=process.argv.slice(2),options={};
try{
 for(let i=0;i<args.length;i+=2){if(!['--config','--manifest','--out'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Usage: node scripts/backfill-inventory.mjs --config ABS --out NEW_ABS_DIRECTORY [--manifest ABS]');options[args[i]]=args[i+1];}
 if(!options['--config']||!options['--out'])throw new Error('--config and --out required');
 const {config,inventory}=await readBackfillInventory({configPath:options['--config'],manifestPath:options['--manifest']??null});
 const out=await writeBackfillInventory({config,inventory,out:options['--out']});
 console.log(JSON.stringify({out,history_coverage:inventory.history_coverage,counts:inventory.counts},null,2));
}catch(e){console.error(e.code??e.message);process.exitCode=1;}
