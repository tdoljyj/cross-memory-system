import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const wrapperPin='eeabca53245fec8cc5b872da58c4ab0c64932cb88da05d2e29c0ac5fc73d15c2';
const pins=Object.freeze({observer_entry:'6d2ae34fc7bc390708120e1b3f653fa49c49ac1ae9f7a61f77ddf08daa27f079',actor:'c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616',observer_core:'017d894f54a7bef4fae447b7e3b04d0c0faa29011efafb5b1e603b185d2ff95c',observer_os:'c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a',identity_dll:'31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8',definition:'0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4',registration:'642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb'});
const hash=b=>createHash('sha256').update(b).digest('hex');
const need=(value,code)=>{if(!value)throw Error(code)};
// Called only by the accepted Root-owned elevated bootstrap. This method does
// not acquire UAC or accept credentials; an ordinary process can capture/preview
// but the production held identity and original r2 factory still refuse it.
export function buildCapturedBAObserverLaunch181({wrapperBytes,captures}) {
 need(process.platform==='win32','WINDOWS_ONLY');need(Buffer.isBuffer(wrapperBytes),'WRAPPER_BYTES');const wrapper=Buffer.from(wrapperBytes);need(hash(wrapper)===wrapperPin,'BA_WRAPPER_PIN');
 const entries=Object.getOwnPropertyDescriptors(captures??{});need(Object.keys(entries).sort().join('|')===Object.keys(pins).sort().join('|'),'BA_EXACT_SOURCE_MEMBERS');const copy={};
 for(const key of Object.keys(pins)){const d=entries[key];need('value'in d&&Buffer.isBuffer(d.value)&&d.value.length>0&&d.value.length<=1048576,'BA_SOURCE_BOUND');const bytes=Buffer.from(d.value);need(hash(bytes)===pins[key],'BA_SOURCE_PIN');copy[key]=bytes.toString('base64');}
 const payload=JSON.stringify({schema:'clued.root-owned-ba-capture181/1',captures:copy});need(Buffer.byteLength(payload)<=2097152,'BA_PAYLOAD_BOUND');
 const script="$ProgressPreference='SilentlyContinue';$script:OwnedBAStdin181=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$line=$script:OwnedBAStdin181.ReadLine();if($null-eq $line-or $line.Length-gt 30000){throw 'BA_WRAPPER_BOUND'};$raw=[Convert]::FromBase64String($line);$sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($actual-cne '"+wrapperPin+"'){throw 'BA_WRAPPER_PIN'};$owner=New-Module {param($bytes,$reader)$script:OwnedBAStdin181=$reader;. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($bytes)));Export-ModuleMember -Function @()} -ArgumentList $raw,$script:OwnedBAStdin181;$result=& $owner {InvokeBAObserverStdio181};exit $result.exit_code";
 const bootstrapBytes=Buffer.from(script,'utf16le');
 return Object.freeze({executable:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',arguments:Object.freeze(['-NoProfile','-NonInteractive','-EncodedCommand',bootstrapBytes.toString('base64')]),encoded_bootstrap:bootstrapBytes.toString('base64'),bootstrap_sha256:hash(bootstrapBytes),stdin_prefix:wrapper.toString('base64')+'\n'+payload+'\n',wrapper_sha256:wrapperPin});
}
export function spawnCapturedBAObserver181(input) {
 const launch=buildCapturedBAObserverLaunch181(input);
 const child=spawn(launch.executable,launch.arguments,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{}}); let metadata,started=false,terminal=false,buffer=Buffer.alloc(0),stdoutBytes=0,stderrBytes=0,totalMessages=0;const stderrHash=createHash('sha256');const messages=[],waiters=[];let readyResolve,readyReject,exitResolve;
 const captureReady=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});const settled=new Promise(resolve=>{exitResolve=resolve});
 const timer=setTimeout(()=>{readyReject(Error('BA_CAPTURE_TIMEOUT'));child.stdin.end()},15000);
 child.stdout.on('data',b=>{stdoutBytes+=b.length;buffer=Buffer.concat([buffer,b]);if(buffer.length>32768){readyReject(Error('BA_STDOUT_BOUND'));child.stdin.end();return}let lf;
  while((lf=buffer.indexOf(10))>=0){const raw=buffer.subarray(0,lf).toString('utf8').replace(/\r$/,'');buffer=buffer.subarray(lf+1);if(!raw)continue;
   try{need(Buffer.byteLength(raw)<=16384,'BA_LINE_BOUND');const m=JSON.parse(raw);if(!metadata){const keys=['schema','host','ba_pid','ba_start','ba_sid','ba_elevated','parent_pid','source_capture_sha256','authority_granted'];need(m&&Object.keys(m).sort().join('|')===keys.sort().join('|'),'BA_CAPTURE_CLOSED');need(m.schema==='clued.root-owned-ba-capture-ready181/1'&&m.ba_pid===child.pid&&m.parent_pid===process.pid&&typeof m.ba_start==='string'&&/^[1-9][0-9]{0,18}$/.test(m.ba_start)&&typeof m.ba_sid==='string'&&Number.isInteger(m.ba_elevated)&&m.source_capture_sha256==='17c85ea6052ce15f4d501316247009ff374aebc435841e016fabd609fd7d12e3'&&m.authority_granted===false,'BA_ACTUAL_CAPTURE_CHILD');metadata=Object.freeze({...m});clearTimeout(timer);readyResolve({...metadata});}
    else{totalMessages++;need(totalMessages<=256,'BA_MESSAGE_COUNT');if(waiters.length)waiters.shift()(raw);else messages.push(raw);}
   }catch{readyReject(Error('BA_CAPTURE_OR_OUTPUT_REFUSED'));child.stdin.end();}
  }
 });
 child.stderr.on('data',b=>{stderrBytes+=b.length;stderrHash.update(b)});child.stdin.on('error',()=>{});
 child.once('error',()=>{clearTimeout(timer);readyReject(Error('BA_CHILD_START_FAILED'))});
 child.once('close',(exitCode,signal)=>{terminal=true;clearTimeout(timer);if(!metadata)readyReject(Error('BA_EXIT_BEFORE_CAPTURE'));for(const resolve of waiters)resolve(null);waiters.length=0;exitResolve({exit_code:exitCode,signal,stdout_bytes:stdoutBytes,stderr_bytes:stderrBytes,stderr_sha256:stderrHash.digest('hex'),qualification:false})});
 child.stdin.write(launch.stdin_prefix);
 return Object.freeze({child,captureReady,settled,
  nextMessage(){if(messages.length)return Promise.resolve(messages.shift());if(terminal)return Promise.resolve(null);return new Promise(resolve=>waiters.push(resolve));},
  startOnce(binding){need(metadata&&!started&&!terminal,'BA_START_ONCE_AFTER_CAPTURE');need(binding&&typeof binding==='object'&&!Array.isArray(binding),'BA_BINDING_OBJECT');need(binding.ba_pid===child.pid&&binding.ba_start===metadata.ba_start&&binding.ba_sid===metadata.ba_sid&&binding.ba_pid!==binding.relay_pid,'BA_OWNED_CHILD_AND_DISTINCT_RELAY');started=true;child.stdin.write(JSON.stringify({schema:'clued.root-owned-ba-observer-start181/1',binding})+'\n');},
  replyFromOwnedRoot(rawJSONLine){need(started&&!terminal&&typeof rawJSONLine==='string'&&!/[\r\n]/.test(rawJSONLine)&&Buffer.byteLength(rawJSONLine)<=16384,'BA_ROOT_REPLY_LINE');child.stdin.write(rawJSONLine+'\n');},
  closeBeforeStart(){need(!started,'BA_NO_UNATTEMPTED_RESET');child.stdin.end();}
 });
}
