import {waitOnlyEnoent218} from './selector_wait218.mjs';
import {spawn,ChildProcess} from 'node:child_process';
import {readFileSync,openSync,fstatSync,closeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {INSTALL_PURPOSE,INSTALL_ROLE,INSTALL_OWNER_PHASE,assertInstallPlan215,need215,exact215} from './install_protocol215.mjs';
import {request212,reply212,validateSelector212,exact212,need212,clone212,sha212} from './protocol212.mjs';
const SELECTOR='C:/ProgramData/CluedIndependentCI/standard-runner-actor/root-node-install-selector215.json';
const PINS={broker:'cb8e77757c9924abe7b7a82859fa27506937c8db5def05659d9ed58e3eb81485',native:'abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb',identity:'31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8'};
const installHandles=new WeakSet();
export function assertRootOwnedInstallHandle215(v){need212(v!==null&&(typeof v==='object'||typeof v==='function')&&installHandles.has(v),'ROOT_OWNED_NATIVE_INVOCATION_NOT_ATTACHED');}
function heldRead(path,pin,max){const fd=openSync(path,'r');try{const a=fstatSync(fd);need212(a.isFile()&&a.nlink===1&&a.size>0&&a.size<=max,'NODE_SOURCE_FILE');const b=readFileSync(fd),z=fstatSync(fd);need212(a.ino===z.ino&&a.size===z.size&&a.mtimeMs===z.mtimeMs&&(!pin||sha212(b)===pin),'NODE_SOURCE_DRIFT');return b;}finally{closeSync(fd)}}
function publicCopy(v){const s=JSON.stringify(v,(k,value)=>k==='owned'?undefined:value);need212(Buffer.byteLength(s)<=12000,'NODE_BODY_BOUND');return JSON.parse(s);}
// No parameters, CLI switches, callback, supplied provider or environment route.
// The selector is only a protected-host locator. It cannot mint a handle: the
// exact captured child must prove its kernel Root peer and consume a genuine
// current Root reply from the existing M1/Source/CI chains first.
export async function resolveRootOwnedInstallation215(){
 if(arguments.length!==0)throw Error('PROVIDER_ARGUMENTS_REFUSED');
 let selector;try{selector=validateSelector212(JSON.parse((await waitOnlyEnoent218(()=>heldRead(SELECTOR,null,4096))).toString('utf8')))}catch{throw Error('PHYSICAL_OWNER_PACKET_MISSING_NO_LAUNCH')}
 const broker=heldRead(new URL('./node_broker212.ps1',import.meta.url),PINS.broker,65536),native=heldRead(new URL('./ingress.dll',import.meta.url),PINS.native,65536),identity=heldRead(new URL('./identity.dll',import.meta.url),PINS.identity,65536);
 const code="$r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$l=$r.ReadLine();if($null-eq $l-or $l.Length-gt 131072){exit 2};$b=[Convert]::FromBase64String($l);$s=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()};if($h-cne '"+PINS.broker+"'){exit 2};$script:NodeBrokerReader212=$r;. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($b)))";
 const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{}});
 need212(child instanceof ChildProcess&&Number.isSafeInteger(child.pid),'NODE_REAL_BROKER_CHILD');
 const queue=[],waiters=[];let closed=false,busy=false,seq=0,stderr=0,lines=0;
 child.stderr.on('data',b=>{stderr+=b.length;if(stderr>65536){closed=true;child.stdin.end()}});child.stdin.on('error',()=>{});
 const rl=createInterface({input:child.stdout});rl.on('line',line=>{if(++lines>2048||Buffer.byteLength(line)>16384){closed=true;child.stdin.end();return};if(waiters.length)waiters.shift()(line);else queue.push(line)});
 child.once('close',()=>{closed=true;for(const w of waiters)w(null);waiters.length=0});child.once('error',()=>{closed=true;for(const w of waiters)w(null);waiters.length=0});
 const next=()=>new Promise((resolve,reject)=>{if(queue.length){resolve(queue.shift());return}if(closed){reject(Error('NODE_BROKER_CLOSED'));return}const w=line=>{clearTimeout(t);line===null?reject(Error('NODE_BROKER_CLOSED')):resolve(line)};const t=setTimeout(()=>{closed=true;child.stdin.end();reject(Error('NODE_BROKER_TIMEOUT_NO_RETRY'))},90000);waiters.push(w)});
 child.stdin.write(broker.toString('base64')+'\n'+JSON.stringify({schema:'clued.node-ingress-broker-capture212/1',identity:identity.toString('base64'),native:native.toString('base64'),selector})+'\n');
 try{
  const ready=JSON.parse(await next());exact212(ready,['schema','broker_pid','broker_start','node_pid','node_start','node_sid','root_pid','root_start','root_sid','root_elevated','packet_sha256','authority_granted']);
  need212(ready.schema==='clued.node-ingress-broker-ready212/1'&&ready.broker_pid===child.pid&&ready.node_pid===process.pid&&ready.root_pid===selector.root_pid&&ready.root_start===selector.root_start&&ready.root_sid===selector.root_sid&&ready.root_elevated===1&&ready.packet_sha256===selector.packet_sha256&&ready.authority_granted===false,'NODE_ACTUAL_KERNEL_ROOT_PEER');
  async function call(operation,body){need212(!closed&&!busy,'NODE_CONCURRENT_OR_CLOSED');busy=true;try{const q=request212(++seq,randomBytes(16).toString('hex'),operation,publicCopy(body));child.stdin.write(JSON.stringify(q)+'\n');return reply212(await next(),q)}catch{closed=true;child.stdin.end();throw Error('NODE_ROOT_REFUSED_OR_UNKNOWN_NO_RETRY')}finally{busy=false}}
  const opened=await call('Open',{selector,actual_node:{pid:process.pid,start:ready.node_start,sid:ready.node_sid},broker:{pid:child.pid,start:ready.broker_start}});
  exact215(opened,['status','purpose','role','owner_phase','plan','qualification_index_sha256']);
  need215(opened.status==='EXACT_INSTALL_SOURCE_OWNER_CI_QUALIFICATION_CURRENT'&&opened.purpose===INSTALL_PURPOSE&&opened.role===INSTALL_ROLE&&opened.owner_phase===INSTALL_OWNER_PHASE,'INSTALL_DISTINCT_OWNER_PURPOSE_REQUIRED');
  const plan=assertInstallPlan215(opened.plan);need215(plan.actor_packet_sha256===selector.packet_sha256&&plan.attempt_id===selector.attempt_id&&plan.owner_receipt_id===selector.owner_receipt_id&&plan.source_acceptance_ref===selector.source_acceptance_ref&&typeof opened.qualification_index_sha256==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(opened.qualification_index_sha256),'INSTALL_OPEN_EXACT_PACKET_AND_REAL_QUALIFICATION');
  const capability=Object.freeze({kind:'PRIVATE_ROOT_OWNED_INSTALL215'});installHandles.add(capability);
  let bound=false,launched=false;
  return Object.freeze({
   capability,plan:()=>clone212(plan),selector:()=>clone212(selector),
   async bindActualInstallSelf(owned,metadata){need215(!bound&&owned?.child instanceof ChildProcess&&metadata?.ps_pid===owned.child.pid&&metadata.ps_parent_pid===process.pid,'INSTALL_ACTUAL_NODE_OWNED_SELF');
    const v=await call('BindCapturedSelf',{stage:'INSTALL',purpose:INSTALL_PURPOSE,attempt_id:plan.attempt_id,actor_packet_sha256:plan.actor_packet_sha256,metadata});
    exact215(v,['status','attempt_id','actor_packet_sha256']);need215(v.status==='ACTUAL_INSTALL_SELF_BOUND'&&v.attempt_id===plan.attempt_id&&v.actor_packet_sha256===plan.actor_packet_sha256,'INSTALL_SELF_NOT_BOUND');bound=true;
   },
   async launchInstallOnce(){need215(bound&&!launched,'INSTALL_CAPTURE_BEFORE_LAUNCH_ONCE');const v=await call('LaunchReady',{stage:'INSTALL',purpose:INSTALL_PURPOSE,attempt_id:plan.attempt_id,actor_packet_sha256:plan.actor_packet_sha256});exact215(v,['status','attempt_id','actor_packet_sha256']);need215(v.status==='DIRECT_ROOT_INSTALL_SELF_PORT_READY'&&v.attempt_id===plan.attempt_id&&v.actor_packet_sha256===plan.actor_packet_sha256,'INSTALL_DIRECT_ROOT_PORT_NOT_READY');launched=true;return {plan:clone212(plan),selector:clone212(selector)}},
   async reopenInstalledProof(outcome){need215(launched,'INSTALL_PROOF_BEFORE_LAUNCH');const v=await call('ReopenProof',{stage:'INSTALL',purpose:INSTALL_PURPOSE,attempt_id:plan.attempt_id,actor_packet_sha256:plan.actor_packet_sha256,outcome});exact215(v,['status','attempt_id','actor_packet_sha256','worker_pid','worker_instance_guid','registered_xml_sha256']);need215(v.status==='INSTALLED_WORKER_INDEPENDENTLY_REOPENED'&&v.attempt_id===plan.attempt_id&&v.actor_packet_sha256===plan.actor_packet_sha256,'INSTALL_PROOF_NOT_REOPENED');return clone212(v)},
   close(){closed=true;child.stdin.end()},physical_permission_from_json:false
  });
 }catch(error){closed=true;child.stdin.end();throw error}
}
export const readiness=Object.freeze({purpose:INSTALL_PURPOSE,role:INSTALL_ROLE,ownerPhase:INSTALL_OWNER_PHASE,requiresActualRootPeer:true,requiresActualSealedQualification:true,physicalOwnerPacket:null,qualification:false});
