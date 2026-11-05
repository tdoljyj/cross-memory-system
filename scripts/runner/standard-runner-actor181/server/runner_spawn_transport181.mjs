import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';

const wrapperPin='e39091d524ada1f0631c05eb8a91f417d76689196a4953801955c663a67f240f';
const pins=Object.freeze({runner_entry:'aae77e546853bbb3c87b9d21a4b96537779d4860f48ef09d256fc9982ab56bd8',actor:'c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616',identity:'31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8',definition:'0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4',registration:'642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb',observer_os:'c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a',local_pipe:'0fc2bc75b9ff8696e60d8999dc5867ec1dffbacd66479c60f781e0629cef6932',provider_client:'5b53a5861e7708594c5c37343ea001c0d838cfdb8b0a15ff9008e35e2f236f3a'});
const hash=b=>createHash('sha256').update(b).digest('hex');
const requireValue=(ok,code)=>{if(!ok)throw Error(code)};

// Internal mechanical ABI for the already admitted protected Node Source.
// This export does not resolve authority or approve/dispatch a CI job.
export function spawnCapturedRunner181({wrapperBytes,captures}) {
 requireValue(process.platform==='win32','WINDOWS_ONLY');
 const fixedRows=Object.freeze({'DESK-W-591':'clued-ci-company-win-01','TURING':'clued-ci-home-win-01'});
 const runnerName=fixedRows[hostname()];requireValue(typeof runnerName==='string'&&process.env.RUNNER_NAME===runnerName,'OWN_NODE_RUNNER_NAME_NOT_FIXED_ROW');
 requireValue(Buffer.isBuffer(wrapperBytes)&&hash(wrapperBytes)===wrapperPin,'WRAPPER_RAW_PIN');
 const descriptors=Object.getOwnPropertyDescriptors(captures??{});
 requireValue(Object.keys(descriptors).sort().join('|')===Object.keys(pins).sort().join('|'),'EXACT_CAPTURED_MEMBERS');
 const captured={};
 for(const key of Object.keys(pins)) {
  const d=descriptors[key];requireValue('value' in d&&Buffer.isBuffer(d.value)&&d.value.length>0&&d.value.length<=1048576,'CAPTURE_VALUE');
  const bytes=Buffer.from(d.value);requireValue(hash(bytes)===pins[key],'CAPTURE_RAW_PIN');captured[key]=bytes.toString('base64');
 }
 const payload=JSON.stringify({schema:'clued.node-owned-runner-capture181/1',captures:captured});requireValue(Buffer.byteLength(payload)<=2097152,'CAPTURE_PAYLOAD_BOUND');
 const code="$script:OwnedRunnerStdin181=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$line=$script:OwnedRunnerStdin181.ReadLine();if($null-eq $line-or $line.Length-gt 20000){throw 'WRAPPER_BOUND'};$raw=[Convert]::FromBase64String($line);$sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($actual-cne '"+wrapperPin+"'){throw 'WRAPPER_PIN'};. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($raw)));$null=InvokeRunnerPipeStdio181"; const encoded=Buffer.from(code,'utf16le').toString('base64');
 const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{RUNNER_NAME:runnerName}});
 let started=false,terminal=false,stdoutBytes=0,stderrBytes=0,buffer=Buffer.alloc(0),metadata;
 const stderrHash=createHash('sha256');
 let readyResolve,readyReject,exitResolve;
 const captureReady=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
 const settled=new Promise(resolve=>{exitResolve=resolve});
 const timer=setTimeout(()=>{readyReject(Error('CAPTURE_READY_TIMEOUT'));child.stdin.end();},15000);
 child.stderr.on('data',b=>{stderrBytes+=b.length;stderrHash.update(b)});
 child.stdout.on('data',b=>{
  stdoutBytes+=b.length;
  if(metadata)return;
  buffer=Buffer.concat([buffer,b]);
  if(buffer.length>16384){readyReject(Error('CAPTURE_READY_BOUND'));child.stdin.end();return;}
  const lf=buffer.indexOf(10);if(lf<0)return;
  try {
   const m=JSON.parse(buffer.subarray(0,lf).toString('utf8'));
   const keys=['schema','host','ps_pid','ps_start','ps_parent_pid','ps_sid','ps_elevated','node_pid','node_start','node_sid','node_elevated','node_image','source_captured','authority_granted','runner_name'];
   requireValue(m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).sort().join('|')===keys.sort().join('|'),'CAPTURE_READY_CLOSED');
   requireValue(m.schema==='clued.node-owned-ps-capture-ready181/1'&&m.ps_pid===child.pid&&m.ps_parent_pid===process.pid&&m.node_pid===process.pid,'ACTUAL_CHILDPROCESS_PID_CHAIN');
   requireValue(typeof m.ps_start==='string'&&/^[1-9][0-9]{0,18}$/.test(m.ps_start)&&typeof m.node_start==='string'&&/^[1-9][0-9]{0,18}$/.test(m.node_start),'FILETIME_DECIMAL_STRING');
   requireValue(m.source_captured===true&&m.authority_granted===false&&typeof m.ps_sid==='string'&&m.ps_sid===m.node_sid&&Number.isInteger(m.ps_elevated)&&Number.isInteger(m.node_elevated)&&typeof m.node_image==='string'&&typeof m.host==='string','CAPTURE_METADATA_TYPES');
   requireValue(m.runner_name===runnerName,'ACTUAL_PS_RUNNER_NAME_NOT_FIXED_ROW');metadata=Object.freeze({...m});buffer=Buffer.alloc(0);clearTimeout(timer);readyResolve({...metadata});
  } catch {readyReject(Error('CAPTURE_READY_REFUSED'));child.stdin.end();}
 });
 child.once('error',()=>{clearTimeout(timer);readyReject(Error('OWNED_CHILD_START_FAILED'))});
 child.once('close',(exitCode,signal)=>{terminal=true;clearTimeout(timer);if(!metadata)readyReject(Error('OWNED_CHILD_EXIT_BEFORE_CAPTURE'));exitResolve({exit_code:exitCode,signal,stdout_bytes:stdoutBytes,stderr_bytes:stderrBytes,stderr_sha256:stderrHash.digest('hex'),qualification:false})});
 child.stdin.on('error',()=>{});
 child.stdin.write(Buffer.from(wrapperBytes).toString('base64')+'\n'+payload+'\n');
 return Object.freeze({child,node_pid:process.pid,captureReady,settled,
  startOnce(binding){requireValue(!started&&!terminal&&metadata,'START_AFTER_ACTUAL_CAPTURE_ONCE');requireValue(binding&&typeof binding==='object'&&!Array.isArray(binding),'START_BINDING_OBJECT');
   const keys=['attempt_id','node_pid','node_start','node_image','relay_pid','relay_start','relay_sid'];requireValue(Object.keys(binding).sort().join('|')===keys.sort().join('|'),'START_BINDING_CLOSED');
   requireValue(binding.node_pid===process.pid&&binding.node_start===metadata.node_start&&binding.node_image===metadata.node_image,'ACTUAL_NODE_METADATA_BINDING');
   requireValue(typeof binding.attempt_id==='string'&&/^[0-9a-f]{32}$/.test(binding.attempt_id)&&Number.isInteger(binding.relay_pid)&&binding.relay_pid>0&&typeof binding.relay_start==='string'&&/^[1-9][0-9]{0,18}$/.test(binding.relay_start)&&typeof binding.relay_sid==='string','START_BINDING_PRIMITIVES');
   started=true;child.stdin.write(JSON.stringify({schema:'clued.node-owned-runner-start181/1',binding})+'\n');
  },
  closeBeforeStart(){requireValue(!started,'CANNOT_CANCEL_AS_UNATTEMPTED_AFTER_START');child.stdin.end();}
 });
}
