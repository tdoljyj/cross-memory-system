// New recovery-only trusted entry. No CREATE/START/STOP or SQL port exists here.
import readline from 'node:readline';import crypto from 'node:crypto';
import {prepareTrustedToolMaterial,project} from './recovery-context.mjs';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false}),it=lines[Symbol.asyncIterator]();
const next=async()=>{const x=await it.next();if(x.done||Buffer.byteLength(x.value)>2*1024*1024)throw Error('BOUNDED_RECOVERY_INPUT_REQUIRED');return JSON.parse(x.value);};
const watchdog=setTimeout(()=>{process.stdout.write(JSON.stringify({state:'UNKNOWN',reason:'RECOVERY_PROCESS_DEADLINE',capacity_released:false,automatic_retry:false})+'\n');process.exit(1);},600000);
try{
 process.stdout.write(JSON.stringify({state:'READY_FOR_RECOVERY_INPUT',project})+'\n');
 const material=await next(),prepared=await prepareTrustedToolMaterial(material);if(prepared.kind!=='RESULT_TERMINAL')throw Error('NO_EFFECT_OR_OTHER_ENTRY');
 const challenge=crypto.randomBytes(24).toString('hex');process.stdout.write(JSON.stringify({state:'NEED_FRESH_RESULT_CONTEXT',challenge,project})+'\n');
 const fresh=await next();if(fresh.challenge!==challenge)throw Error('EXACT_LIVE_RECOVERY_CHALLENGE');
 const result=prepared.finishResult(fresh.observation);if(!['FAIL','BLOCKED','STALE'].includes(result.result))throw Error('RECOVERY_CANNOT_PASS');
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){process.stdout.write(JSON.stringify({state:'UNKNOWN',reason:String(e.message),capacity_released:false,automatic_retry:false,qualified:false})+'\n');process.exitCode=1;}
finally{clearTimeout(watchdog);lines.close();}
