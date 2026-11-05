import {spawn,ChildProcess} from 'node:child_process';
import {openSync,readFileSync,fstatSync,closeSync} from 'node:fs';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {assertRootOwnedInstallHandle215} from './node_install_authority215.mjs';
import {need215,exact215,hash215,assertInstallPlan215} from './install_protocol215.mjs';
const PINS=Object.freeze({"namespace":{"file":"namespace.ps1","sha256":"88a8388c9d3f5c0a814549de0cd4cb8ba7820860fab05f674bbc04b0f30dd4b9","bytes":953},"core":{"file":"core.ps1","sha256":"0401d559c495469f213ef4eaf00b8590c9eea91bba0dc3c58e2983b483e9c3e4","bytes":16573},"enrollment_adapter":{"file":"enrollment_adapter.ps1","sha256":"69cccbbf0899c82ac09f35e163cc782cb2edab385be05e984cf9b14e00956627","bytes":7943},"enrollment_code":{"file":"enrollment_code.py","sha256":"9395b92c4724e498f02f9a138f76a1cb60cb5b6deba351725a1baee5579f7a79","bytes":9991},"xml_helpers":{"file":"xml_helpers.ps1","sha256":"aa5dfe432ce9d6c0f6a1b867c1950b5036ec431056dc30560a1d230a74e6efb5","bytes":10959},"self_helpers":{"file":"self_helpers.ps1","sha256":"c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616","bytes":29883},"definition":{"file":"definition.ps1","sha256":"0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4","bytes":6546},"registration":{"file":"registration.ps1","sha256":"642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb","bytes":896},"identity":{"file":"identity.dll","sha256":"31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8","bytes":15872},"ingress":{"file":"ingress.dll","sha256":"abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb","bytes":13824},"wrapper":{"file":"install_wrapper215.ps1","sha256":"383ab3c34ddc98c43fffa5a3b19269c299033231d0c7ce09b4408e546a33a749","bytes":10751}});
const captures=new WeakSet();
function readFixed215(key){const p=PINS[key];need215(p!==undefined,'INSTALL_FIXED_CAPTURE_KEY');const fd=openSync(new URL('./'+p.file,import.meta.url),'r');try{const s=fstatSync(fd);need215(s.isFile()&&s.nlink===1&&s.size===p.bytes&&s.size>0&&s.size<=1048576,'INSTALL_HELD_SOURCE');const raw=readFileSync(fd),z=fstatSync(fd);need215(s.ino===z.ino&&s.size===z.size&&s.mtimeMs===z.mtimeMs&&hash215(raw)===p.sha256,'INSTALL_SOURCE_DRIFT');return Buffer.from(raw)}finally{closeSync(fd)}}
export function assertCapturedInstall215(v){need215(v!==null&&typeof v==='object'&&captures.has(v),'INSTALL_ACTUAL_OWNED_CAPTURE_REQUIRED')}
// This internal mechanism accepts only the private capability minted by the
// genuine noarg install factory. No callback, receipt JSON or qualification
// handle can replace it. This export itself does not create authority.
export function captureOwnedInstall215(capability){
 assertRootOwnedInstallHandle215(capability);need215(process.platform==='win32','INSTALL_WINDOWS_ONLY');
 const expected={'DESK-W-591':'clued-ci-company-win-01','TURING':'clued-ci-home-win-01'}[hostname()];need215(typeof expected==='string'&&process.env.RUNNER_NAME===expected,'INSTALL_EXACT_EXISTING_RUNNER');
 const wrapper=readFixed215('wrapper'),members={};for(const k of Object.keys(PINS))if(k!=='wrapper')members[k]=readFixed215(k).toString('base64');
 const payload=JSON.stringify({schema:'clued.node-install-capture215/1',members});need215(Buffer.byteLength(payload)<=2097152,'INSTALL_CAPTURE_PAYLOAD_BOUND');
 const code="$script:InstallOwnedStdin215=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$line=$script:InstallOwnedStdin215.ReadLine();if($null-eq $line-or $line.Length-gt 32768){exit 2};$raw=[Convert]::FromBase64String($line);$h=[Security.Cryptography.SHA256]::Create();try{$pin=([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};if($pin-cne '"+PINS.wrapper.sha256+"'){exit 2};. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($raw)));InvokeCapturedInstallStdio215";
 const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{RUNNER_NAME:expected}});
 need215(child instanceof ChildProcess&&Number.isSafeInteger(child.pid)&&child.pid>0,'INSTALL_ACTUAL_CHILDPROCESS');
 let started=false,closed=false,seen=null,stdoutBytes=0,stderrBytes=0,buffer=Buffer.alloc(0),result=null;const errHash=createHash('sha256');let readyResolve,readyReject,doneResolve;
 const captured=new Promise((r,j)=>{readyResolve=r;readyReject=j}),settled=new Promise(r=>{doneResolve=r});
 const timer=setTimeout(()=>{readyReject(Error('INSTALL_CAPTURE_TIMEOUT'));child.stdin.end()},15000);
 child.stdin.on('error',()=>{});child.stderr.on('data',b=>{stderrBytes+=b.length;errHash.update(b);if(stderrBytes>1048576)child.stdin.end()});
 child.stdout.on('data',b=>{
  stdoutBytes+=b.length;buffer=Buffer.concat([buffer,b]);if(buffer.length>65536){readyReject(Error('INSTALL_STDOUT_BOUND'));child.stdin.end();return}
  for(;;){const i=buffer.indexOf(10);if(i<0)break;const raw=buffer.subarray(0,i).toString('utf8');buffer=buffer.subarray(i+1);if(!raw)continue;
   try{const v=JSON.parse(raw);if(!seen){
    exact215(v,['schema','host','ps_pid','ps_start','ps_parent_pid','ps_sid','ps_elevated','node_pid','node_start','node_sid','node_elevated','node_image','source_captured','authority_granted']);
    need215(v.schema==='clued.node-install-self-captured215/1'&&v.ps_pid===child.pid&&v.ps_parent_pid===process.pid&&v.node_pid===process.pid&&v.host===hostname()&&v.ps_sid===v.node_sid&&v.ps_elevated===0&&v.node_elevated===0&&v.source_captured===true&&v.authority_granted===false&&typeof v.ps_start==='string'&&/^[1-9][0-9]{0,18}(?![\s\S])/.test(v.ps_start)&&typeof v.node_start==='string'&&/^[1-9][0-9]{0,18}(?![\s\S])/.test(v.node_start)&&typeof v.node_image==='string','INSTALL_CAPTURE_ACTUAL_PID_CHAIN');
    seen=Object.freeze({...v});clearTimeout(timer);readyResolve({...seen});
   }else{exact215(v,['schema','result']);need215(v.schema==='clued.node-install-self-result215/1'&&result===null,'INSTALL_RESULT_ONCE');result=v.result}
   }catch{readyReject(Error('INSTALL_CHILD_PROTOCOL_REFUSED'));child.stdin.end()}
  }
 });
 child.once('error',()=>{clearTimeout(timer);readyReject(Error('INSTALL_CHILD_START_UNKNOWN'))});
 child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);if(!seen)readyReject(Error('INSTALL_CHILD_EOF_BEFORE_CAPTURE'));doneResolve({exit_code:code,signal,stdout_bytes:stdoutBytes,stderr_bytes:stderrBytes,stderr_sha256:errHash.digest('hex'),result,physical_success:false})});
 child.stdin.write(wrapper.toString('base64')+'\n'+payload+'\n');
 const owned=Object.freeze({child,captured,settled,
  startOnce(plan,selector){assertInstallPlan215(plan);need215(!started&&!closed&&seen,'INSTALL_START_AFTER_CAPTURE_ONCE');need215(plan.row.host===seen.host&&plan.row.expected_sid===seen.ps_sid&&plan.attempt_id===selector?.attempt_id&&plan.actor_packet_sha256===selector?.packet_sha256,'INSTALL_CAPTURE_TARGET_PACKET');started=true;child.stdin.write(JSON.stringify({schema:'clued.node-install-start215/1',plan,selector})+'\n')},
  closeBeforeStart(){need215(!started,'INSTALL_CANNOT_CANCEL_AS_UNSTARTED');child.stdin.end()}
 });captures.add(owned);return owned;
}
export const capturePins215=PINS;
