import {spawn,ChildProcess} from 'node:child_process';
import {readFileSync,openSync,fstatSync,lstatSync,closeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {request212,reply212,validateSelector212,exact212,need212,clone212,sha212} from './protocol212.mjs';
import {waitForSelector212} from './selector-wait212.mjs';
const SELECTOR='C:/ProgramData/CluedIndependentCI/standard-runner-actor/root-node-selector212.json';
const PINS={broker:'77f46d2d87ccae6e71160e16048b3b32d5357e409b8c8cce1e8f05c4da89d3a1',native:'abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb',identity:'31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8'};
const handles=new WeakSet(),captureHandles=new WeakSet();
export function assertRootOwnedLaunchHandle212(v){need212(v!==null&&(typeof v==='object'||typeof v==='function')&&handles.has(v),'ROOT_OWNED_NATIVE_INVOCATION_NOT_ATTACHED');}
export function assertRootOwnedCaptureHandle212(v){need212(v!==null&&(typeof v==='object'||typeof v==='function')&&captureHandles.has(v),'ROOT_OWNED_NATIVE_INVOCATION_NOT_ATTACHED');}
function heldRead(path,pin,max){const fd=openSync(path,'r');try{const a=fstatSync(fd);need212(a.isFile()&&a.nlink===1&&a.size>0&&a.size<=max,'NODE_SOURCE_FILE');const b=readFileSync(fd),z=fstatSync(fd);need212(a.ino===z.ino&&a.size===z.size&&a.mtimeMs===z.mtimeMs&&(!pin||sha212(b)===pin),'NODE_SOURCE_DRIFT');return b;}finally{closeSync(fd)}}
function publicCopy(v){const s=JSON.stringify(v,(k,value)=>k==='owned'?undefined:value);need212(Buffer.byteLength(s)<=12000,'NODE_BODY_BOUND');return JSON.parse(s);}
// No parameters, CLI switches, callback, supplied provider or environment route.
// The selector is only a protected-host locator. It cannot mint a handle: the
// exact captured child must prove its kernel Root peer and consume a genuine
// current Root reply from the existing M1/Source/CI chains first.
export async function resolveRootOwnedInvocation(){
 if(arguments.length!==0)throw Error('PROVIDER_ARGUMENTS_REFUSED');
 let selector;try{selector=await waitForSelector212(()=>{const s=lstatSync(SELECTOR);need212(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'NODE_SELECTOR_FILE');return validateSelector212(JSON.parse(heldRead(SELECTOR,null,4096).toString('utf8')))})}catch{throw Error('PHYSICAL_OWNER_PACKET_MISSING_NO_LAUNCH')}
 const broker=heldRead(new URL('./node_broker212.ps1',import.meta.url),PINS.broker,65536),native=heldRead(new URL('./NodeIngressPipe212.dll',import.meta.url),PINS.native,65536),identity=heldRead(new URL('./WindowsAccountIdentity181.dll',import.meta.url),PINS.identity,65536);
 const code="$r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$l=$r.ReadLine();if($null-eq $l-or $l.Length-gt 131072){exit 2};$b=[Convert]::FromBase64String($l);$s=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()};if($h-cne '"+PINS.broker+"'){exit 2};$script:NodeBrokerReader212=$r;. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($b)))";
 const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{}});
 need212(child instanceof ChildProcess&&Number.isSafeInteger(child.pid),'NODE_REAL_BROKER_CHILD');
 const queue=[],waiters=[];let closed=false,busy=false,seq=0,stderr=0,lines=0;
 child.stderr.on('data',b=>{stderr+=b.length;if(stderr>65536){closed=true;child.stdin.end()}});child.stdin.on('error',()=>{});
 const rl=createInterface({input:child.stdout});rl.on('line',line=>{if(++lines>2048||Buffer.byteLength(line)>16384){closed=true;child.stdin.end();return};if(waiters.length)waiters.shift()(line);else queue.push(line)});
 child.once('close',()=>{closed=true;for(const w of waiters)w(null);waiters.length=0});child.once('error',()=>{closed=true;for(const w of waiters)w(null);waiters.length=0});
 const next=()=>new Promise((resolve,reject)=>{if(queue.length){resolve(queue.shift());return}if(closed){reject(Error('NODE_BROKER_CLOSED'));return}const w=line=>{clearTimeout(t);line===null?reject(Error('NODE_BROKER_CLOSED')):resolve(line)};const t=setTimeout(()=>{closed=true;child.stdin.end();reject(Error('NODE_BROKER_TIMEOUT_NO_RETRY'))},20000);waiters.push(w)});
 child.stdin.write(broker.toString('base64')+'\n'+JSON.stringify({schema:'clued.node-ingress-broker-capture212/1',identity:identity.toString('base64'),native:native.toString('base64'),selector})+'\n');
 try{
  const ready=JSON.parse(await next());exact212(ready,['schema','broker_pid','broker_start','node_pid','node_start','node_sid','root_pid','root_start','root_sid','root_elevated','packet_sha256','authority_granted']);
  need212(ready.schema==='clued.node-ingress-broker-ready212/1'&&ready.broker_pid===child.pid&&ready.node_pid===process.pid&&ready.root_pid===selector.root_pid&&ready.root_start===selector.root_start&&ready.root_sid===selector.root_sid&&ready.root_elevated===1&&ready.packet_sha256===selector.packet_sha256&&ready.authority_granted===false,'NODE_ACTUAL_KERNEL_ROOT_PEER');
  async function call(operation,body){need212(!closed&&!busy,'NODE_CONCURRENT_OR_CLOSED');busy=true;try{const q=request212(++seq,randomBytes(16).toString('hex'),operation,publicCopy(body));child.stdin.write(JSON.stringify(q)+'\n');return reply212(await next(),q)}catch{closed=true;child.stdin.end();throw Error('NODE_ROOT_REFUSED_OR_UNKNOWN_NO_RETRY')}finally{busy=false}}
  const opened=await call('Open',{selector,actual_node:{pid:process.pid,start:ready.node_start,sid:ready.node_sid},broker:{pid:child.pid,start:ready.broker_start}});
  exact212(opened,['status','packet_sha256','owner_receipt_id','source_acceptance_ref','accepted_rows']);need212(opened.status==='EXACT_SOURCE_OWNER_CI_CURRENT'&&opened.packet_sha256===selector.packet_sha256&&opened.owner_receipt_id===selector.owner_receipt_id&&opened.source_acceptance_ref===selector.source_acceptance_ref&&Array.isArray(opened.accepted_rows)&&opened.accepted_rows.length>0&&opened.accepted_rows.length<=128,'NODE_OPEN_THREE_CHAIN_BINDING');
  let readyHandle=null,captureHandle=null;
  return Object.freeze({
   acceptedRows:()=>clone212(opened.accepted_rows),
   requireAcceptedSource:q=>call('AcceptedSource',q),bindNativeInvocation:q=>call('BindInvocation',q),requireCurrent:q=>call('Current',q),
   requireOwnedLiveObserver:q=>call('ObserverReady',q),requireOwnedLiveObserverPhase:q=>call('ObserverPhase',q),
   async requireOwnedCaptureReady(q){const v=await call('Current',{row:q.row,binding:q.binding,phase:'observer-ready'});exact212(v,['status','binding_ref','fence','execution_epoch','phase']);need212(v.status==='CURRENT'&&v.binding_ref===q.binding.binding_ref&&v.fence===q.binding.fence&&v.execution_epoch===q.binding.execution_epoch&&v.phase==='observer-ready','NODE_CAPTURE_CURRENT_REFUSED');if(!captureHandle){captureHandle=Object.freeze({kind:'PRIVATE_ROOT_OWNED_CAPTURE212'});captureHandles.add(captureHandle)}return captureHandle},
   async requireOwnedLaunchReady(q){const v=await call('LaunchReady',{row:q.row,binding:q.binding});exact212(v,['status','packet_sha256']);need212(v.status==='OWNED_BA_WAITING_AND_LOCAL_EFFECT_PERMITTED'&&v.packet_sha256===selector.packet_sha256,'NODE_LAUNCH_REFUSED');if(!readyHandle){readyHandle=Object.freeze({kind:'PRIVATE_ROOT_OWNED_LAUNCH212'});handles.add(readyHandle)}return readyHandle},
   bindActualCapturedChild:async q=>{need212(q.owned?.child instanceof ChildProcess&&q.metadata?.ps_pid===q.owned.child.pid&&q.metadata.ps_parent_pid===process.pid,'NODE_ACTUAL_SELF_CHILD');return call('BindCapturedSelf',{row:q.row,binding:q.binding,metadata:q.metadata})},
   async awaitActualNativeProof(q){const until=Date.now()+140000;while(Date.now()<until){const v=await call('ProofStatus',{row:q.row,binding:q.binding});if(v.status==='PENDING_NATIVE_PROOF'){await new Promise(r=>setTimeout(r,500));continue}return v}closed=true;child.stdin.end();throw Error('NODE_PROOF_TIMEOUT_NO_RETRY')},
   reopenAndValidateExactProof:q=>call('ReopenProof',q),
   close(){closed=true;child.stdin.end()},physical_permission_from_json:false
  });
 }catch(error){closed=true;child.stdin.end();throw error}
}
export const readiness=Object.freeze({nativeNodeSession:'IMPLEMENTED_REQUIRES_GENUINE_ROOT_SELECTOR_AND_PEER',actualNodeTokenReader:'LOCAL_REVIEWED_READER_EXTERNAL',ownedBAProvider:'JOINT_RUNTIME211_REQUIRED',physicalOwnerPacket:null,qualification:false});
