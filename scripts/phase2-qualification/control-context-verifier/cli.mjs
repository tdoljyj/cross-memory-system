// Root-operated one-shot stdin protocol. No file-based authorization, shell or child effects.
import readline from 'node:readline';
import crypto from 'node:crypto';
import {prepareTrustedToolMaterial,project,sql} from './context.mjs';
import {sha} from './trusted-github.mjs';
// The tool host closes non-PTY stdin. Raw PTY mode retains the channel without echoing materials.
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
const it=lines[Symbol.asyncIterator]();
const next=async()=>{const x=await it.next();if(x.done||Buffer.byteLength(x.value)>2*1024*1024)throw Error('BOUNDED_STDIN_INPUT_REQUIRED');return JSON.parse(x.value);};
const watchdog=setTimeout(()=>{process.stdout.write(JSON.stringify({state:'BLOCKED',reason:'VERIFIER_PROCESS_DEADLINE'})+'\n');process.exit(1);},90000);
try{
 const material=await next();
 const prepared=await prepareTrustedToolMaterial(material);
 const challenge=crypto.randomBytes(24).toString('hex');
 process.stdout.write(JSON.stringify({state:'NEED_FRESH_SQL',challenge,project,query_sha256:sha(sql)})+'\n');
 const fresh=await next();if(fresh.challenge!==challenge)throw Error('EXACT_LIVE_PROCESS_CHALLENGE_REQUIRED');
 const verdict=prepared.finishFresh(fresh.observation);
 process.stdout.write(JSON.stringify(verdict)+'\n');
}catch(e){process.stdout.write(JSON.stringify({state:'BLOCKED',reason:String(e.message),authority_effect:'NONE'})+'\n');process.exitCode=1;}
finally{clearTimeout(watchdog);lines.close();}
