# Source v2 copy of protected-job-bridge-v3/relay-public.ps1 (DESIGN S7, S10, S12). See the notes below.
param(
  [Parameter(Mandatory=$true)][ValidateSet('SendIssue','SendResponse','ReceiveChallenge','ReceiveResult','ReceiveBlocked')][string]$Mode,
  [ValidateRange(0,32)][int]$Sequence=0,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedBundleSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedNodeProfileSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
# BEGIN fixed machine WSL validator (identical to resident/windows/wsl-client.ps1).
function Get-CluedMachineWslClient {
  try { foreach ($m in @('Management', 'Security', 'Utility')) { Import-Module ('C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.' + $m + '\Microsoft.PowerShell.' + $m + '.psd1') -ErrorAction Stop } } catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  $p = 'C:\Program Files\WSL\wsl.exe'
  foreach ($v in @('C:\', 'C:\Program Files', 'C:\Program Files\WSL', $p)) {
    try { $i = Microsoft.PowerShell.Management\Get-Item -LiteralPath $v -Force -ErrorAction Stop }
    catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { throw 'WSL_MACHINE_CLIENT_MISSING' }; throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
    if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($v -ceq $p -and $i.PSIsContainer) -or ($v -cne $p -and -not $i.PSIsContainer)) { throw 'WSL_MACHINE_CLIENT_NOT_PLAIN' }
  }
  try { $s = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop }
  catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  if ([string]$s.Status -cne 'Valid') { throw 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID' }
  $c = $s.SignerCertificate
  if ($null -eq $c -or $c.Subject -cnotmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)' -or
      $c.Subject -cnotmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)' -or
      $c.Thumbprint -cnotmatch '^[0-9A-Fa-f]{40}$') { throw 'WSL_MACHINE_CLIENT_PUBLISHER_INVALID' }
  try { $h = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash }
  catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  if ($h -cnotmatch '^[0-9A-Fa-f]{64}$') { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  [pscustomobject]@{ contract = 'clued.independent-ci.wsl-client/1'; path = $p; sha256 = $h.ToLowerInvariant(); signerThumbprint = $c.Thumbprint.ToUpperInvariant() }
}
# END fixed machine WSL validator.
# Public bytes only. This entry never starts a worker or grants an admission.
# Source v2 (DESIGN S7, S10, S12): run by the resident companion as the Owner from the installed, admin-only
# copy resident\source\<sha>\...\protected-job-bridge-v4 (the directory name is the accepted CI Source
# manifest hash; the bundle pin below binds the exact bytes); the Linux half runs under the pinned toolchain
# node, the same Node the role-v3 policies and the worker unit require.
$FixedSourcePattern='^C:\\ProgramData\\CluedIndependentCI\\resident\\source\\[0-9a-f]{64}\\work\\actions-hosted-migration\\independent-ci-v1\\worker\\protected-job-bridge-v4$'
$FixedSource=[IO.Path]::GetFullPath($PSScriptRoot)
$LinuxEntry='/opt/clued-independent-ci/source-v2/work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/relay-record.mjs'
$LinuxNode='/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node'
$Spool='C:\ProgramData\CluedIndependentCI\formal-spool'
$Max=1048576;$Held=New-Object 'System.Collections.Generic.List[System.IDisposable]'
$proc=$null;$started=$false;$terminal=$false;$code=2
$result=[ordered]@{contract='clued.independent-ci.formal-public-relay-receipt/2';status='BLOCKED';mode=$Mode;sequence=$Sequence;bundleSha256=$ExpectedBundleSha256;processId=$null;exitCode=$null;terminalConfirmed=$false;automaticRetryAllowed=$false;taskStarted=$false;qualificationIssued=$false;failureCode=$null;childError=$null;record=$null}
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Text; using System.Threading.Tasks;
using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class CluedFormalRelayIO {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 public static SafeFileHandle Hold(string p) {
   var h=CreateFileW(p,0x20000,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid) throw new IOException("PUBLIC_PARENT_LOCK_REQUIRED"); return h;
 }
 public static async Task<string> Read(TextReader r,int maximum) {
   var s=new StringBuilder();var b=new char[4096];bool over=false;
   for(;;){int n=await r.ReadAsync(b,0,b.Length);if(n==0){if(over)throw new IOException("PUBLIC_OUTPUT_BOUND");return s.ToString();}
     if(s.Length+n>maximum)over=true;if(!over)s.Append(b,0,n);}
 }
}
'@ | Out-Null
function Hash-Bytes([byte[]]$b){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Hold-Parents([string]$Path){
  $paths=New-Object 'System.Collections.Generic.List[string]';$p=[IO.Path]::GetFullPath($Path)
  while($p){$paths.Insert(0,$p);$p=[IO.Path]::GetDirectoryName($p.TrimEnd('\'))}
  foreach($p in $paths){$h=[CluedFormalRelayIO]::Hold($p);$Held.Add($h);$i=Get-Item -LiteralPath $p -Force;if(-not $i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PUBLIC_PARENT_BOUNDARY_REQUIRED'}}
}
function Read-Public([string]$Path,[int]$Limit){
  $f=New-Object IO.FileStream($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$Held.Add($f)
  $i=Get-Item -LiteralPath $Path -Force;if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -lt 1 -or $f.Length -gt $Limit){throw 'PUBLIC_INPUT_BOUNDARY_REQUIRED'}
  $b=New-Object byte[] ([int]$f.Length);$o=0;while($o -lt $b.Length){$n=$f.Read($b,$o,$b.Length-$o);if($n -le 0){throw 'PUBLIC_INPUT_TRUNCATED'};$o+=$n};return ,$b
}
function Json-Public([byte[]]$b){return (New-Object Text.UTF8Encoding($false,$true)).GetString($b)|ConvertFrom-Json}
function New-Public([string]$Path,[byte[]]$Bytes){$h=New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$h.Write($Bytes,0,$Bytes.Length);$h.Flush($true)}finally{$h.Dispose()}}
function Check-Spool([string[]]$Targets){
  # Separate metadata-only helper, pinned and locked above. Never reads bytes.
  # bf57ff10 P2 A' (2026-11-07): one helper process for every path of this transfer (it was one per path: 3 for a
  # Receive, 5 for a Send, 0.43 s each). The helper checks each path exactly as a lone target and refuses the call when
  # any one is refused; '|' joins them because no Windows path contains it, and a path that did is refused here.
  if($Targets.Count -lt 1 -or $Targets.Count -gt 8 -or @($Targets|Where-Object{$_ -isnot [string] -or $_.Length -lt 1 -or $_.Contains('|')}).Count -ne 0){throw 'FORMAL_SPOOL_ACL_REFUSED'}
  & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -File (Join-Path $FixedSource 'formal-spool-acl.ps1') -LiteralTarget ($Targets -join '|') -ProtectedRoot $Spool -RelayReadOutgoing -ExpectedNodeProfileSha256 $ExpectedNodeProfileSha256
  if($LASTEXITCODE -ne 0){throw 'FORMAL_SPOOL_ACL_REFUSED'}
}
function Safe-ChildError([string]$Text){
  if($Text.Length -lt 1 -or $Text.Length -gt 4096){return $null}
  try{$v=$Text|ConvertFrom-Json}catch{return $null}
  if((@($v.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'qualificationIssued|reason|stage|status|taskStarted' -or $v.status -cne 'BLOCKED' -or $v.taskStarted -ne $false -or $v.qualificationIssued -ne $false){return $null}
  $stages=@('OPERATION','CONTEXT','STDIN','TRANSPORT','PACKET','BINDING','RECORD','COMPLETE')
  $reasons=@('FIXED_FORMAL_RELAY_OPERATION_REQUIRED','FIXED_FORMAL_RELAY_SEQUENCE_REQUIRED','FORMAL_RELAY_BYTES_BOUND','FORMAL_RELAY_TRANSPORT_BOUND','FORMAL_RELAY_TRANSPORT_JSON','FORMAL_RELAY_TRANSPORT_CHANGED','FORMAL_RELAY_FILE_BOUND','FORMAL_RELAY_FILE_CHANGED','FORMAL_RELAY_READY_CHANGED','FORMAL_RELAY_STDIN_TIMEOUT','FORMAL_RELAY_ISSUER_CONTEXT_CHANGED','FORMAL_RELAY_SEQUENCE_CHANGED','FORMAL_RELAY_UNCONFIRMED','ENOENT','EEXIST','EACCES','EPERM','ENOTDIR','EISDIR','ELOOP','ENOSPC','EDQUOT','EROFS','EIO','EBUSY','EMFILE','ENFILE','ENAMETOOLONG','EINVAL','EINTR','EPIPE',
    'BRIDGE_ISSUE_EXPIRED','BRIDGE_CHALLENGE_EXPIRED','BRIDGE_RESPONSE_EXPIRED','BRIDGE_BLOCKED_TIME_INVALID','EAGAIN','ENOMEM','ETIMEDOUT','FORMAL_RELAY_CODE_UNLISTED')
  # 2026-11-04 (PR #992): a refusal whose code was not listed here was dropped (childError null), so nobody could tell
  # which check had refused. A fixed-form code of the fixed child is now reported as FORMAL_RELAY_CODE_UNLISTED: the same
  # shape, no new text, and companion.mjs still treats it as final.
  if(-not($stages -ccontains $v.stage) -or $v.reason -isnot [string] -or $v.reason -cnotmatch '^[A-Z][A-Z0-9_]{1,79}$'){return $null}
  if(-not($reasons -ccontains $v.reason)){$v.reason='FORMAL_RELAY_CODE_UNLISTED'}
  return [pscustomobject][ordered]@{status='BLOCKED';reason=$v.reason;stage=$v.stage;taskStarted=$false;qualificationIssued=$false}
}
try{
  if($FixedSource -cnotmatch $FixedSourcePattern){throw 'FIXED_SOURCE_LOCATION_REQUIRED'}
  Add-Type -Path (Join-Path $FixedSource '..\..\src\resident-v2\windows\NodeProfileV2.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
  $nodeLease=[NodeProfileV2]::LoadProtectedProfile('C:\ProgramData\CluedIndependentCI\resident',$ExpectedNodeProfileSha256);$Held.Add($nodeLease);$Node=$nodeLease.Profile
  if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $Node.OwnerSid -or [Environment]::MachineName -cne $Node.Hostname){throw 'FIXED_OWNER_ENDPOINT_REQUIRED'}
  $sequenced=$Mode -ceq 'SendResponse' -or $Mode -ceq 'ReceiveChallenge'
  if(($sequenced -and $Sequence -eq 0) -or (-not $sequenced -and $Sequence -ne 0)){throw 'FIXED_RELAY_SEQUENCE_REQUIRED'}
  Hold-Parents $FixedSource
  $mb=Read-Public (Join-Path $FixedSource 'manifest.json') 65536
  if((Hash-Bytes $mb) -cne $ExpectedBundleSha256){throw 'ACCEPTED_BUNDLE_CHANGED'}
  $m=Json-Public $mb
  $names=@('boundary.mjs','protocol.mjs','mailbox.mjs','windows-issuer.mjs','linux-worker.mjs','signed-result.mjs','relay-record.mjs','relay-public.ps1','formal-spool-acl.ps1','issue-job.mjs')
  if($m.contract -cne 'clued.independent-ci.protected-job-bridge-source/4' -or (@($m.runtimeFiles.PSObject.Properties.Name|Sort-Object)-join '|') -cne (($names|Sort-Object)-join '|')){throw 'EXACT_BRIDGE_SOURCE_REQUIRED'}
  foreach($name in $names){$b=Read-Public (Join-Path $FixedSource $name) $Max;if($b.Length -ne $m.runtimeFiles.$name.bytes -or (Hash-Bytes $b) -cne $m.runtimeFiles.$name.sha256){throw 'ACCEPTED_SOURCE_CHANGED'}}
  $send=$Mode.StartsWith('Send');$suffix=$Sequence.ToString('00')
  $name=switch($Mode){'SendIssue'{'issue'}'SendResponse'{'response-'+$suffix}'ReceiveChallenge'{'challenge-'+$suffix}'ReceiveResult'{'result'}'ReceiveBlocked'{'blocked'}}
  $operation=switch($Mode){'SendIssue'{'--import-issue'}'SendResponse'{'--import-response '+$Sequence}'ReceiveChallenge'{'--export-challenge '+$Sequence}'ReceiveResult'{'--export-result'}'ReceiveBlocked'{'--export-blocked'}}
  # The same paths as before, in the same order (spool, outgoing, incoming, then a Send's record and its ready marker),
  # checked by one helper call after the three parent locks and before any record byte is read.
  $aclTargets=@($Spool,(Join-Path $Spool 'outgoing'),(Join-Path $Spool 'incoming'))
  if($send){$file=Join-Path (Join-Path $Spool 'outgoing') ($name+'.json');$ready=Join-Path (Join-Path $Spool 'outgoing') ($name+'.ready.json');$aclTargets+=@($file,$ready)}
  Hold-Parents $Spool;Hold-Parents (Join-Path $Spool 'outgoing');Hold-Parents (Join-Path $Spool 'incoming');Check-Spool $aclTargets
  $inputText='';$raw=$null
  if($send){
    $raw=Read-Public $file $Max;$r=Json-Public (Read-Public $ready 4096)
    if((@($r.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'bytes|contract|sha256' -or $r.contract -cne 'clued.independent-ci.complete-public-file/1' -or $r.bytes -ne $raw.Length -or $r.sha256 -cne (Hash-Bytes $raw)){throw 'PUBLIC_READY_CHANGED'}
    $inputText=@{bytes=$raw.Length;sha256=(Hash-Bytes $raw);base64=[Convert]::ToBase64String($raw)}|ConvertTo-Json -Compress
  }else{foreach($leaf in @($name+'.json',$name+'.ready.json')){if(Test-Path -LiteralPath (Join-Path (Join-Path $Spool 'incoming') $leaf)){throw 'EXISTING_RECORD_PRESERVED_NO_RETRY'}}}
  $utf8=New-Object Text.UTF8Encoding($false,$true);$ib=$utf8.GetBytes($inputText);if($ib.Length -gt 1399000){throw 'PUBLIC_STDIN_BOUND'}
  # Standalone relay execution has the same trust gate as companion startup.
  # The validator is part of this accepted, self-pinned Source file, with no path parameter.
  $WslClient=Get-CluedMachineWslClient
  $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=[string]$WslClient.path
  $psi.Arguments='--distribution '+$Node.WslDistribution+' --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C '+$LinuxNode+' '+$LinuxEntry+' '+$operation
  $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.EnvironmentVariables.Clear()
  foreach($p in @(@('SystemRoot','C:\Windows'),@('WINDIR','C:\Windows'),@('PATH','C:\Windows\System32;C:\Windows'),@('USERPROFILE',$Node.OwnerProfileDirectory),@('LOCALAPPDATA',(Join-Path $Node.OwnerProfileDirectory 'AppData\Local')))){$psi.EnvironmentVariables[$p[0]]=$p[1]}
  $proc=New-Object Diagnostics.Process;$proc.StartInfo=$psi;$previous=[Console]::InputEncoding
  try{[Console]::InputEncoding=$utf8;if(-not $proc.Start()){throw 'PUBLIC_START_UNCONFIRMED'};$started=$true;$result.processId=$proc.Id}finally{[Console]::InputEncoding=$previous}
  $ot=[CluedFormalRelayIO]::Read($proc.StandardOutput,1399000);$et=[CluedFormalRelayIO]::Read($proc.StandardError,4096)
  $stdin=$proc.StandardInput.BaseStream;$wt=$stdin.WriteAsync($ib,0,$ib.Length);if(-not $wt.Wait(5000)){throw 'PUBLIC_STDIN_UNCERTAIN_NO_RETRY'};[void]($wt.GetAwaiter().GetResult());$stdin.Dispose()
  # The finally block waits for the child in any case; this bound only decides whether a slow child that did finish
  # counts. 90 s of the companion's 120 s per relay call (RELAY_TIMEOUT_MS; Task 576231fa: a relay call sometimes takes 25-45 s).
  if(-not $proc.WaitForExit(90000)){throw 'PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED'}
  $proc.WaitForExit();$terminal=$true;$result.exitCode=$proc.ExitCode
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($ot,$et),5000)){throw 'PUBLIC_OUTPUT_UNCONFIRMED_NO_RETRY'}
  $stdout=$ot.GetAwaiter().GetResult();$stderr=$et.GetAwaiter().GetResult()
  if($stderr.Length -gt 0){$result.childError=Safe-ChildError $stderr;throw 'PUBLIC_CHILD_REFUSED_NO_RETRY'}
  if($proc.ExitCode -ne 0){throw 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY'}
  $v=$stdout|ConvertFrom-Json
  if($send){if($v.status -cne 'FORMAL_PUBLIC_RECORD_IMPORTED' -or $v.bytes -ne $raw.Length -or $v.sha256 -cne (Hash-Bytes $raw) -or $v.taskStarted -ne $false -or $v.qualificationIssued -ne $false){throw 'PUBLIC_IMPORT_UNCONFIRMED_NO_RETRY'}}
  else{
    if((@($v.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'base64|bytes|sha256' -or $v.bytes -lt 1 -or $v.bytes -gt $Max -or $v.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'PUBLIC_RECORD_TRANSPORT_BOUND'}
    $raw=[Convert]::FromBase64String($v.base64);if([Convert]::ToBase64String($raw) -cne $v.base64 -or $raw.Length -ne $v.bytes -or (Hash-Bytes $raw) -cne $v.sha256){throw 'PUBLIC_RECORD_BYTES_CHANGED'}
    # Complete data is fsynced first. Only a create-new ready marker publishes
    # it to the controller. An incomplete attempt is preserved, never retried.
    $dir=Join-Path $Spool 'incoming';New-Public (Join-Path $dir ($name+'.json')) $raw
    $marker='{"bytes":'+$raw.Length+',"contract":"clued.independent-ci.complete-public-file/1","sha256":"'+(Hash-Bytes $raw)+'"}'
    New-Public (Join-Path $dir ($name+'.ready.json')) ($utf8.GetBytes($marker))
  }
  $result.record=[ordered]@{name=$name;bytes=$raw.Length;sha256=(Hash-Bytes $raw)};$result.status='PUBLIC_RECORD_TRANSFERRED';$code=0
}catch{$id=$_.FullyQualifiedErrorId.Split(',')[0];$result.failureCode=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}else{'PUBLIC_TRANSFER_UNCONFIRMED'}}
finally{
  if($started -and -not $terminal){$result.status='UNCERTAIN_LOCKS_RETAINED_NO_RETRY';[Console]::Error.WriteLine('PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED');while(-not $terminal){try{if($proc.WaitForExit(1000)){$terminal=$true;$result.exitCode=$proc.ExitCode}}catch{Start-Sleep -Milliseconds 1000}}}
  $result.terminalConfirmed=$terminal;foreach($h in $Held){$h.Dispose()};if($null -ne $proc){$proc.Dispose()};$result|ConvertTo-Json -Depth 8
}
exit $code
