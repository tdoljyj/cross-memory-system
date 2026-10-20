// One actual PS5 process holds the same checked Source/configuration handles.
// Public data only. No caller can inject a child, reader, context or lease.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const leases=new WeakSet(),fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const MAX=8388608,CONTROLLER='S-1-5-21-1173730660-3877291096-655431861-1015';
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
function bytes(v){check(typeof v==='string'&&v.length<=1398104,'HELD_SOURCE_DOCUMENT_BOUND');const b=Buffer.from(v,'base64');check(b.toString('base64')===v&&b.length<=1048576,'HELD_SOURCE_DOCUMENT_BOUND');return b;}
export function decodeHeldSource(raw,now=Date.now()){
  check(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=MAX,'HELD_SOURCE_OUTPUT_BOUND');let v;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail('HELD_SOURCE_JSON_REFUSED');}
  check(exact(v,['contract','controllerSid','expiresAt','documents','sourceHashes','policyBase64'])&&v.contract==='clued.independent-ci.held-source-bytes/1'&&v.controllerSid===CONTROLLER&&Date.parse(v.expiresAt)>now,'HELD_SOURCE_RECORD_REFUSED');
  check(exact(v.documents,['installation.json','acceptance.json','source-manifest.json','signers.json']),'HELD_SOURCE_DOCUMENTS_REFUSED');
  const documents=Object.fromEntries(Object.entries(v.documents).map(([k,x])=>[k,bytes(x)]));
  check(v.sourceHashes&&Object.getPrototypeOf(v.sourceHashes)===Object.prototype&&Object.keys(v.sourceHashes).length>0&&Object.keys(v.sourceHashes).length<=10000,'HELD_SOURCE_PINS_REFUSED');
  for(const[p,s]of Object.entries(v.sourceHashes))check(typeof p==='string'&&!p.startsWith('/')&&!/[\\:\x00-\x1f]/.test(p)&&p.split('/').every(v=>v&&v!=='.'&&v!=='..')&&/^[a-f0-9]{64}$/.test(s),'HELD_SOURCE_PINS_REFUSED');
  const policy=bytes(v.policyBase64);check(v.sourceHashes['config/merge-admission-policy.json']===hash(policy),'HELD_POLICY_BYTES_CHANGED');
  return{documents,sourceHashes:new Map(Object.entries(v.sourceHashes)),policyText:new TextDecoder('utf-8',{fatal:true}).decode(policy),expiresAt:v.expiresAt};
}
export async function openHeldSource(){
  check(process.platform==='win32','ACTUAL_WINDOWS_HELD_SOURCE_REQUIRED');
  const helper=fileURLToPath(new URL('./hold-source.ps1',import.meta.url));
  const temp='C:\\ProgramData\\CluedIndependentCI\\state\\temp';
  const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',helper],{windowsHide:true,shell:false,env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',HOME:temp,USERPROFILE:temp,TEMP:temp,TMP:temp},stdio:['pipe','pipe','pipe']});
  let invalid=false,closing=false,settled=false;const parts=[];let count=0;
  const lease=await new Promise((resolve,reject)=>{
    const bad=()=>{invalid=true;if(!settled){settled=true;clearTimeout(timer);child.stdin.end();reject(Object.assign(new Error('HELD_SOURCE_PROCESS_UNCONFIRMED'),{code:'HELD_SOURCE_PROCESS_UNCONFIRMED'}));}};
    const timer=setTimeout(bad,20000);
    child.once('error',bad);child.once('exit',()=>{if(!closing)bad();});child.stderr.on('data',bad);child.stdin.on('error',bad);
    child.stdout.on('data',b=>{if(settled){bad();return;}count+=b.length;if(count>MAX){bad();return;}parts.push(b);const all=Buffer.concat(parts);if(!all.includes(10))return;
      try{const end=all.indexOf(10);check(end===all.length-1,'HELD_SOURCE_EXTRA_OUTPUT_REFUSED');const data=decodeHeldSource(all.subarray(0,end));settled=true;clearTimeout(timer);
        const item=Object.freeze({get data(){check(!invalid&&!closing&&child.exitCode===null&&Date.now()<Date.parse(data.expiresAt),'HELD_SOURCE_LEASE_LOST');return data;},
          assertLive(){check(!invalid&&!closing&&child.exitCode===null&&Date.now()<Date.parse(data.expiresAt),'HELD_SOURCE_LEASE_LOST');},
          async close(){if(closing)return;closing=true;child.stdin.end('RELEASE\n');await new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}child.once('exit',resolve);});}
        });leases.add(item);resolve(item);
      }catch{bad();}
    });
  });return lease;
}
export function takeHeldSource(lease){check(leases.has(lease),'ACTUAL_HELD_SOURCE_LEASE_REQUIRED');lease.assertLive();return lease;}
