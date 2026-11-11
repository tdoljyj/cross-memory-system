# Real Native self/owned-child checks plus closed-state and bounded-buffer tests. No production process scan, Task, SCM, WSL or UAC.
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'recover-m5b-archive-reviewed.ps1';$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'OWNER_TEST_PARSE_REFUSED'}
foreach($f in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
$pins=Get-RecoveryPins 'turing-b2ea'
$buffers=@{archive=[IO.File]::ReadAllBytes((Join-Path $repo 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\archive-windows-spool.ps1'));native=[IO.File]::ReadAllBytes((Join-Path $repo 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows\NodeProfileV2.cs'))}
if((Recovery-Hash $buffers.archive) -cne $pins.archiver -or (Recovery-Hash $buffers.native) -cne $pins.native){throw 'OWNER_TEST_PIN_REFUSED'}
Initialize-RecoveryNative @{buffers=$buffers}
$count=0;function Yes([bool]$ok,[string]$label){if(-not $ok){throw ('OWNER_TEST_FAILED:'+ $label)};$script:count++}
$self=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$f=[RecoveryReadOnly]::ProcessOwner([uint32]$PID)
Yes ($f.Status -ceq 'OWNER' -and $f.Sid -ceq $self) 'actual-current-process-token-user'
$flags=[Reflection.BindingFlags]'NonPublic,Static';$type=[RecoveryReadOnly]
$openFail=$type.GetMethod('OpenFailure',$flags);$waitFail=$type.GetMethod('FailedOwnerWait',$flags);$decode=$type.GetMethod('DecodeTokenUser',$flags)
Yes ($openFail.Invoke($null,[object[]]@([uint32]1234,[int]5)).Status -ceq 'UNKNOWN') 'open-access-denied-does-not-mean-gone'
Yes ($openFail.Invoke($null,[object[]]@([uint32]1234,[int]87)).Status -ceq 'GONE') 'only-fixed-flags-positive-pid-87-is-current-gone'
Yes ($openFail.Invoke($null,[object[]]@([uint32]0,[int]87)).Status -ceq 'UNKNOWN') 'invalid-zero-pid-is-not-gone'
Yes ($waitFail.Invoke($null,[object[]]@([uint32]258)).Status -ceq 'UNKNOWN') 'unreadable-live-wait-timeout-unknown'
Yes ($waitFail.Invoke($null,[object[]]@([uint32]::MaxValue)).Status -ceq 'UNKNOWN') 'wait-failed-unknown'
Yes ($waitFail.Invoke($null,[object[]]@([uint32]0)).Status -ceq 'GONE') 'only-signaled-process-handle-gone'
Yes ([RecoveryReadOnly]::ProcessOwnerFromHandle($null).Status -ceq 'UNKNOWN') 'null-handle-not-quiet'
$invalid=New-Object RecoveryProcessHandle;try{Yes ([RecoveryReadOnly]::ProcessOwnerFromHandle($invalid).Status -ceq 'UNKNOWN') 'invalid-handle-not-quiet'}finally{$invalid.Dispose()}
$memory=[Runtime.InteropServices.Marshal]::AllocHGlobal(128)
try{
 $zero=New-Object byte[] 128;[Runtime.InteropServices.Marshal]::Copy($zero,0,$memory,128);$sidPointer=[IntPtr]::Add($memory,16);[Runtime.InteropServices.Marshal]::WriteIntPtr($memory,$sidPointer)
 $sidObject=New-Object Security.Principal.SecurityIdentifier($self);$sidBytes=New-Object byte[] $sidObject.BinaryLength;$sidObject.GetBinaryForm($sidBytes,0);[Runtime.InteropServices.Marshal]::Copy($sidBytes,0,$sidPointer,$sidBytes.Length)
 Yes ($decode.Invoke($null,[object[]]@($memory,[uint32]128)) -ceq $self) 'actual-sid-bytes-with-bounded-token-user-pointer'
 foreach($bad in @([IntPtr]::Add($memory,-1),[IntPtr]::Add($memory,4),[IntPtr]::Add($memory,124))){[Runtime.InteropServices.Marshal]::WriteIntPtr($memory,$bad);Yes ($null -eq $decode.Invoke($null,[object[]]@($memory,[uint32]128))) 'out-of-buffer-or-header-overlap-pointer-refused'}
 [Runtime.InteropServices.Marshal]::WriteIntPtr($memory,$sidPointer);[Runtime.InteropServices.Marshal]::WriteByte($sidPointer,1,16);Yes ($null -eq $decode.Invoke($null,[object[]]@($memory,[uint32]128))) 'subauthority-count-bound'
 [Runtime.InteropServices.Marshal]::Copy($sidBytes,0,$sidPointer,$sidBytes.Length);[Runtime.InteropServices.Marshal]::WriteByte($sidPointer,0,0);Yes ($null -eq $decode.Invoke($null,[object[]]@($memory,[uint32]128))) 'invalid-sid-revision-refused'
 Yes ($null -eq $decode.Invoke($null,[object[]]@([IntPtr]::Zero,[uint32]128))) 'null-buffer-refused'
}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($memory)}
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('m5b-owner-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($scratch)
$child=$null;$held=$null
try{
 $script="[Console]::Out.WriteLine('READY');[void][Console]::In.ReadLine();exit 0"
 $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';$psi.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script));$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.EnvironmentVariables.Clear()
 foreach($p in @(@('SystemRoot','C:\Windows'),@('WINDIR','C:\Windows'),@('PATH','C:\Windows\System32'),@('PSModulePath','C:\Windows\System32\WindowsPowerShell\v1.0\Modules'),@('TEMP',$scratch),@('TMP',$scratch))){$psi.EnvironmentVariables[$p[0]]=$p[1]}
 $child=[Diagnostics.Process]::Start($psi);$ownChildPid=[uint32]$child.Id;$ready=$child.StandardOutput.ReadLineAsync();Yes ($ready.Wait(5000) -and $ready.Result -ceq 'READY') 'controlled-own-child-ready'
 $f=[RecoveryReadOnly]::ProcessOwner([uint32]$child.Id);Yes ($f.Status -ceq 'OWNER' -and $f.Sid -ceq $self) 'actual-live-child-token-user'
 $errorCode=0;$held=[RecoveryReadOnly]::OpenProcessForOwner([uint32]$child.Id,[ref]$errorCode);Yes ($null -ne $held -and -not $held.IsInvalid -and $errorCode -eq 0) 'actual-same-process-handle-held'
 $f=[RecoveryReadOnly]::ProcessOwnerFromHandle($held);Yes ($f.Status -ceq 'OWNER' -and $f.Sid -ceq $self) 'held-live-instance-owner'
 $child.StandardInput.WriteLine('EXIT');$child.StandardInput.Flush();Yes ($child.WaitForExit(5000) -and $child.ExitCode -eq 0) 'child-exits-naturally-no-kill'
 Yes ([RecoveryReadOnly]::ProcessOwnerFromHandle($held).Status -ceq 'GONE') 'same-held-instance-signaled-after-natural-exit'
 $held.Dispose();Yes ([RecoveryReadOnly]::ProcessOwnerFromHandle($held).Status -ceq 'UNKNOWN') 'disposed-handle-remains-unknown'
 # The Process object still retains its own Windows handle; do not mistake a later PID lookup for the held-instance proof above.
}finally{if($null -ne $held){$held.Dispose()};if($null -ne $child){try{$child.StandardInput.Dispose();if(-not $child.HasExited){$null=$child.WaitForExit(5000)}}finally{$child.Dispose()}}}
# A later PID lookup is only an observation: other handles may retain the exited object, or the PID may be reused.
# The same-instance exit proof is the signaled held handle above, not this later lookup.
$gonePid=[uint32]$ownChildPid;$openError=0;$fresh=[RecoveryReadOnly]::OpenProcessForOwner($gonePid,[ref]$openError)
try{$laterPidObservation=[ordered]@{openSucceeded=($null -ne $fresh);error=$openError;status=if($null -ne $fresh){[RecoveryReadOnly]::ProcessOwnerFromHandle($fresh).Status}else{$openFail.Invoke($null,[object[]]@($gonePid,$openError)).Status};provesEarlierInstance=$false}}finally{if($null -ne $fresh){$fresh.Dispose()}}
$absentError=0;$absent=[RecoveryReadOnly]::OpenProcessForOwner([uint32]::MaxValue,[ref]$absentError)
try{Yes ($null -eq $absent -and $absentError -eq 87) 'actual-unallocated-pid-open-invalid-parameter';Yes ($openFail.Invoke($null,[object[]]@([uint32]::MaxValue,$absentError)).Status -ceq 'GONE') 'current-open-87-policy-without-historical-pid-inference'}finally{if($null -ne $absent){$absent.Dispose()}}
# Routing tests use isolated ports, not PPL claims: an unknown Native result still needs the original real-success SID contract.
$actualOwners=${function:Read-RecoveryProcessOwnerSids}
& {
 function Get-CimInstance{[CmdletBinding()]param([string]$ClassName,[string[]]$Property);@([pscustomobject]@{ProcessId=$PID})}
 function Read-RecoveryNativeProcessOwner{[pscustomobject]@{Status='UNKNOWN';Sid=$null}}
 function Invoke-CimMethod{[CmdletBinding()]param($InputObject,[string]$MethodName);[pscustomobject]@{ReturnValue=0;Sid=$self}}
 Yes ((& $actualOwners).Count -eq 1) 'native-unknown-cim-real-sid-contract-fallback'
 function Invoke-CimMethod{[CmdletBinding()]param($InputObject,[string]$MethodName);throw 'FIXTURE_UNREADABLE'}
 $refused=$false;try{& $actualOwners|Out-Null}catch{$refused=$_.FullyQualifiedErrorId -ceq 'RECOVERY_PROCESS_UNKNOWN'};Yes $refused 'native-unknown-and-cim-unreadable-refuse'
 function Read-RecoveryNativeProcessOwner{[pscustomobject]@{Status='GONE';Sid=$null}}
 Yes ((& $actualOwners).Count -eq 0) 'native-proven-gone-does-not-call-unreadable-cim'
}
[ordered]@{status='RECOVERY_PROCESS_OWNER_TEMP_PASS';assertions=$count;realSelfAndOwnedChild=$true;laterPidObservation=$laterPidObservation;actualPplRead=$false;productionProcessScan=$false;taskScmWslUac=$false;sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
