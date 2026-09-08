// Only the fixed trusted tool entry may start this process after exact source checks.
import readline from 'node:readline';
import crypto from 'node:crypto';
import {prepareTrustedToolMaterial,project} from './context.mjs';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false}),it=lines[Symbol.asyncIterator]();
const next=async()=>{const x=await it.next();if(x.done||Buffer.byteLength(x.value)>2*1024*1024)throw Error('BOUNDED_STDIN_INPUT_REQUIRED');return JSON.parse(x.value);};
let dispatchMayExist=false;
const watchdog=setTimeout(()=>{process.stdout.write(JSON.stringify({state:dispatchMayExist?'UNKNOWN':'BLOCKED',reason:'VERIFIER_PROCESS_DEADLINE',capacity_released:false,automatic_retry:false})+'\n');process.exit(1);},600000);
try{
 const prepared=await prepareTrustedToolMaterial(await next()),challenge=crypto.randomBytes(24).toString('hex');
 dispatchMayExist=true;
 process.stdout.write(JSON.stringify(prepared.kind==='RESULT_TERMINAL'?{state:'NEED_FRESH_RESULT_CONTEXT',challenge,project}:{state:'NEED_COMMITTED_DISPATCH',challenge,project,intent:prepared.intent,dispatch_key:prepared.dispatch_key})+'\n');
 const fresh=await next();if(fresh.challenge!==challenge)throw Error('EXACT_LIVE_PROCESS_CHALLENGE_REQUIRED');
 process.stdout.write(JSON.stringify(prepared.kind==='RESULT_TERMINAL'?prepared.finishResult(fresh.observation):prepared.finishDispatch(fresh))+'\n');
}catch(e){process.stdout.write(JSON.stringify({state:dispatchMayExist?'UNKNOWN':'BLOCKED',reason:String(e.message),capacity_released:false,automatic_retry:false,qualified:false})+'\n');process.exitCode=1;}
finally{clearTimeout(watchdog);lines.close();}
