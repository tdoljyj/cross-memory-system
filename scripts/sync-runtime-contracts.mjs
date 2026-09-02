#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2);
if(!args.includes('--verify')){
  process.stderr.write(`${JSON.stringify({ok:false,code:'VERIFY_ONLY_MODE_REQUIRED',message:'v15 G1 exposes a deterministic verify-only forward path; runtime mirroring is deferred until an applicable runtime package.'})}\n`);
  process.exit(1);
}
const manifestIndex=args.indexOf('--manifest');
if(manifestIndex<0||!args[manifestIndex+1]){
  process.stderr.write(`${JSON.stringify({ok:false,code:'ARGUMENT_ERROR',message:'--manifest is required'})}\n`);
  process.exit(1);
}
const here=dirname(fileURLToPath(import.meta.url));
const verifier=resolve(here,'verify-generated-artifacts.mjs');
const forwarded=['--manifest',args[manifestIndex+1]];
for(const key of ['--expected-memory-tree','--bom']){const index=args.indexOf(key);if(index>=0&&args[index+1])forwarded.push(key,args[index+1]);}
if(args.includes('--allow-dirty'))forwarded.push('--allow-dirty');
try{process.stdout.write(execFileSync(process.execPath,[verifier,...forwarded],{encoding:'utf8'}));}
catch(error){process.stdout.write(error.stdout||'');process.stderr.write(error.stderr||'');process.exit(error.status||1);}
