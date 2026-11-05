import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
const file=new URL('./NodePrimaryObservation211.cs',import.meta.url);
const sha=b=>createHash('sha256').update(b).digest('hex');
const SOURCE_SHA256='a4ee0b66382d693ce3fc0bc7cf0e007ed36b9902fda12f2bed6bbdadffe808bc';
export const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// Read-only own-parent observation. No credentials, token duplication, target
// ACL changes, registration or authority are performed by this component.
export async function readActualNodePrimary211(){
 if(arguments.length!==0||process.platform!=='win32')throw Error('OWN_WINDOWS_NODE_ONLY');
 let fd,raw;try{const a=fs.lstatSync(file);if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1||a.size<1||a.size>65536)throw Error();fd=fs.openSync(file,'r');const b=fs.fstatSync(fd);raw=fs.readFileSync(fd);const z=fs.fstatSync(fd),last=fs.lstatSync(file);for(const s of [a,z,last])if(s.dev!==b.dev||s.ino!==b.ino||s.size!==b.size||s.mtimeMs!==b.mtimeMs||s.ctimeMs!==b.ctimeMs||s.nlink!==1||!s.isFile())throw Error();if(sha(raw)!==SOURCE_SHA256)throw Error();}catch{throw Error('READER_SOURCE_REFUSED');}finally{if(fd!==undefined)fs.closeSync(fd);}
 const pin=SOURCE_SHA256;
 const bootstrap=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$stage='INPUT';try{$line=[Console]::In.ReadLine();if($null-eq $line-or $line.Length-gt 100000){throw 'INPUT_BOUND'};$q=$line|ConvertFrom-Json;$raw=[Convert]::FromBase64String($q.source);$h=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};if($actual-cne '${pin}'){throw 'SOURCE_HASH'};$stage='COMPILE';Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($raw));$stage='QUERY';$r=[CluedNodeObservation211.Reader]::ReadOwnParent([int]$q.pid,[string]$q.image);$r|ConvertTo-Json -Compress}catch{$e=$_.Exception;while($null-ne $e.InnerException){$e=$e.InnerException};$code=if($e-is [ComponentModel.Win32Exception]){$e.NativeErrorCode}else{0};[ordered]@{status='NODE_PRIMARY_OBSERVATION_REFUSED';stage=$stage;win32=$code}|ConvertTo-Json -Compress;exit 2}`;
 const p=spawn(PS,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 return new Promise((resolve,reject)=>{let out=Buffer.alloc(0),err=0,closed=false;const fail=()=>{if(!closed){closed=true;p.stdin.destroy();try{p.kill();}catch{}reject(Error('NODE_PRIMARY_OBSERVATION_REFUSED'));}};const timer=setTimeout(fail,20000);
 p.stdout.on('data',b=>{out=Buffer.concat([out,b]);if(out.length>8192)fail();});p.stderr.on('data',b=>{err+=b.length;if(err>65536)fail();});p.on('error',fail);p.stdin.on('error',fail);
 p.on('close',code=>{clearTimeout(timer);if(closed)return;closed=true;try{const q=JSON.parse(out.toString('utf8'));if(code!==0||err!==0){const stage=['INPUT','COMPILE','QUERY'].includes(q.stage)?q.stage:'TRANSPORT';throw Error('NODE_PRIMARY_OBSERVATION_REFUSED_'+stage+'_'+(Number.isInteger(q.win32)?q.win32:0)+'_ERRBYTES_'+err);}if(q.process_id!==process.pid||q.image.toLowerCase()!==process.execPath.toLowerCase()||typeof q.creation_file_time!=='string'||!/^[1-9][0-9]{0,19}$/.test(q.creation_file_time)||!Number.isInteger(q.thread_count)||q.thread_count<1||q.primary_token_observed!==true||typeof q.thread_impersonation!=='boolean'||typeof q.enabled_or_deny_only_admin_sid!=='boolean'||typeof q.elevated!=='boolean')throw Error('NODE_PRIMARY_PROJECTION_REFUSED');resolve(Object.freeze(q));}catch(e){reject(Error(/^NODE_PRIMARY_[A-Z0-9_]+$/.test(e.message)?e.message:'NODE_PRIMARY_OBSERVATION_REFUSED'));}});
 p.stdin.end(JSON.stringify({source:raw.toString('base64'),pid:process.pid,image:process.execPath})+'\n');
 });
}
