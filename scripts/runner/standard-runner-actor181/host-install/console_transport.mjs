import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {createHash} from 'node:crypto';
const ENTRY_SHA='0092a0385a6c57aecaf76de3b1553cac5e61b49c12bd87b833eba2391bb8abcf';const FRAME_SHA='49aed67063bfd6db704f135ceea6744b5db7045075cda8a73c7506e775e8740f';
const hash=b=>createHash('sha256').update(b).digest('hex');const need=(v,c)=>{if(v!==true)throw Error(c)};
// Mechanical console adapter only. The Host's real three-chain factory must
// authorize its captured launch; this export cannot mint M1/CI/local permission.
export async function runCapturedRootConsole214({entryBytes,captureBytes,consoleFrameBytes}){
 for(const b of [entryBytes,captureBytes,consoleFrameBytes])need(Buffer.isBuffer(b)&&b.length>0&&b.length<=262144,'CAPTURED_CONSOLE_BYTES_ONLY');
 const entry=Buffer.from(entryBytes),cap=Buffer.from(captureBytes),frame=Buffer.from(consoleFrameBytes);need(hash(entry)===ENTRY_SHA&&hash(frame)===FRAME_SHA,'CAPTURED_ROOT_CONSOLE_SOURCE_PIN');
 const {makeConsoleEmitter}=await import('data:text/javascript;base64,'+frame.toString('base64'));const emit=makeConsoleEmitter();
 const code="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{$r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$line=$r.ReadLine();if($null-eq $line-or $line.Length-gt 131072){exit 2};$b=[Convert]::FromBase64String($line);$h=[Security.Cryptography.SHA256]::Create();try{$s=([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};if($s-cne '"+ENTRY_SHA+"'){exit 2};. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($b)));$line=$r.ReadLine();if($null-eq $line-or $line.Length-gt 349528){exit 2};$q=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($line))|ConvertFrom-Json;InvokeCapturedRootOwnedSupervisor214 $q $r;exit 0}catch{[Console]::Out.WriteLine('{\"schema\":\"clued.root-supervisor-terminal-refusal214/1\",\"status\":\"UNKNOWN_PRESERVE_NO_RETRY\"}');exit 2}";
 const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:\\Windows'}});
 let stdout=0,stderr=0,lines=0,closed=false;const errHash=createHash('sha256');
 const fail=()=>{if(!closed){closed=true;child.stdin.end();process.exitCode=2}};
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 const input=createInterface({input:process.stdin});input.on('line',line=>{if(Buffer.byteLength(line)>16384||++lines>2048||closed){fail();return}child.stdin.write(line+'\n')});input.once('close',()=>child.stdin.end());input.once('error',fail);child.stdin.on('error',fail);
 const output=createInterface({input:child.stdout});output.on('line',line=>{stdout+=Buffer.byteLength(line)+1;if(stdout>8388608||Buffer.byteLength(line)>16384){fail();return}try{emit(line)}catch{fail()}});
 child.stderr.on('data',b=>{stderr+=b.length;errHash.update(b);if(stderr>1048576)fail()});child.once('error',fail);
 child.stdin.write(entry.toString('base64')+'\n'+cap.toString('base64')+'\n');
 await new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;input.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();process.exitCode=code===0&&signal===null?0:2;resolve()}));
 return Object.freeze({status:process.exitCode===0?'OWNED_CONSOLE_EXIT0_NOT_QUALIFICATION':'UNKNOWN_PRESERVE_NO_RETRY',stdout_bytes:stdout,stderr_bytes:stderr,stderr_sha256:errHash.digest('hex'),qualification:false});
}
