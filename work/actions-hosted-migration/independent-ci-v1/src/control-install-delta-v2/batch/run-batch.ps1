
[CmdletBinding()]
param([switch]$RunOnce,[string]$ReviewedManifestSha256,[string]$OwnerApprovedManifestSha256,[switch]$OwnerApprovesFixedEightStages,[switch]$OwnerAcceptsCooperativeAdminWindow)
Set-StrictMode -Version 2.0;$ErrorActionPreference='Stop'
$ExpectedBatchBindingSha256=$null
$CandidateRoot=$PSScriptRoot;$Root='C:\ProgramData\CluedIndependentCI';$Source=Join-Path $Root 'source';$State=Join-Path $Root 'state';$IndependentRoot=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $CandidateRoot));$MigrationRoot=Split-Path -Parent $IndependentRoot
$OriginalBinary='"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"';$ExpectedStable='1f3595231dad355084f441e8b84b978e2204346f6b294009ff004aa5f07f59e0'
$workStream=$null;$held=New-Object 'Collections.Generic.List[IDisposable]';$packageHeld=New-Object 'Collections.Generic.List[IDisposable]';$PayloadBytes=@{};$lockedDirectories=@{};$AllowedCreatePaths=@{};$stage='UNBOUND_BATCH_GUARD';$child=$null;$worker=$null;$terminal=$true;$code=2;$BridgeManifestSha256='4c628b391810f05a6df694a2ad0395242c27124ffdddeae75190be3d2977b6cb'
$receipt=[ordered]@{contract='clued.independent-ci.fixed-eight-stage-batch-receipt/1';state='DISABLED';current_stage=$stage;actual_host_read=$false;effects_started=$false;creation_attempted_path=$null;created_files=@();created_directories=@();protected_backups=@();replaced_public_files=@();stages=@();source_installations=0;stage_invocations=0;scm_starts=0;qualification_issued=$false;automatic_retry_allowed=$false;private_bytes_read_by_batch=$false;failure_code=$null;actual_sid=$null;controller_sid=$null;service_logon_name=$null;service_logon_resolved_sid=$null;service_state=$null;service_start_mode=$null;elevated=$false}
function Hash([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Save-BatchProgress{if($null -ne $workStream){$receipt.current_stage=$stage;$b=(New-Object Text.UTF8Encoding($false)).GetBytes(($receipt|ConvertTo-Json -Depth 12)+[char]10);$workStream.Position=0;$workStream.Write($b,0,$b.Length);$workStream.SetLength($b.Length);$workStream.Flush($true)}}
function Start-PublicChild([string]$Exe,[string]$Arguments){$psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=$Exe;$psi.Arguments=$Arguments;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.EnvironmentVariables.Clear();foreach($p in @(@('SystemRoot','C:\Windows'),@('WINDIR','C:\Windows'),@('PATH','C:\Windows\System32;C:\Windows'),@('COMPUTERNAME','TURING'),@('OS','Windows_NT'),@('USERPROFILE','C:\Users\17531'),@('LOCALAPPDATA','C:\Users\17531\AppData\Local'))){$psi.EnvironmentVariables[$p[0]]=$p[1]};$p=New-Object Diagnostics.Process;$p.StartInfo=$psi;if(-not $p.Start()){throw 'FIXED_CHILD_START_UNCONFIRMED'};$p.StandardInput.Close();return [pscustomobject]@{process=$p;stdout=[BatchChildIO]::Read($p.StandardOutput,4MB);stderr=[BatchChildIO]::Read($p.StandardError,65536)}}
function Finish-PublicChild($Record){if(-not $Record.process.HasExited){throw 'CHILD_TERMINAL_UNCONFIRMED'};$Record.process.WaitForExit();if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Record.stdout,$Record.stderr),5000)){throw 'CHILD_OUTPUT_UNCONFIRMED'};$out=$Record.stdout.GetAwaiter().GetResult();$err=$Record.stderr.GetAwaiter().GetResult();if($err.Length -gt 0 -or $Record.process.ExitCode -ne 0){throw 'FIXED_PUBLIC_CHILD_REFUSED'};return $out}
function Read-SealedWork([string]$Path,[string]$Expected,[int]$Maximum=16MB){
 if($Expected -cnotmatch '\A[a-f0-9]{64}\z'){throw 'EXACT_PACKAGE_FILE_PIN_REQUIRED'}
 $item=Get-Item -LiteralPath $Path -Force;while($null -ne $item){if(($item.Attributes -band 1024) -ne 0){throw 'PACKAGE_REPARSE_REFUSED'};$item=if($item -is [IO.DirectoryInfo]){$item.Parent}else{$item.Directory}}
 $f=[IO.File]::Open($Path,'Open','Read','Read');$packageHeld.Add($f)
 if($f.Length -lt 1 -or $f.Length -gt $Maximum){throw 'PACKAGE_SOURCE_BOUND_REQUIRED'};$b=New-Object byte[] ([int]$f.Length);$at=0;while($at -lt $b.Length){$n=$f.Read($b,$at,$b.Length-$at);if($n -lt 1){throw 'PACKAGE_SOURCE_TRUNCATED'};$at+=$n};if((Hash $b) -cne $Expected){throw 'SEALED_PACKAGE_SOURCE_CHANGED'};return ,$b
}
function Assert-SealedStage($Row){
 $dir=Join-Path $CandidateRoot $Row.directory;$raw=Read-SealedWork (Join-Path $dir 'work-manifest.json') $Row.workManifestSha256 2MB;$wm=$u.GetString($raw)|ConvertFrom-Json
 $names=@('invoke-control.ps1','continue-fixed.ps1','ContinuationFiles.cs','invoke-functions.ps1','invoke-io.ps1','FixedScm.cs','ScmPidHandshake.cs','HostFiles.cs','FormalRepairFiles.cs','host-baseline.ps1','restore-functions.ps1','runtime-pins.json','deployment-pins.json','prior-installed.json','binding.json')
 if($wm.contract -cne 'clued.independent-ci.formal-fixed-invocation-work/1' -or $wm.effectsAuthorized -ne $false -or (@($wm.files.PSObject.Properties.Name|Sort-Object)-join '|') -cne (($names|Sort-Object)-join '|')){throw 'EXACT_STAGE_SOURCE_CLOSURE_REQUIRED'}
 $parts=@{};foreach($n in $names){$parts[$n]=Read-SealedWork (Join-Path $dir $n) $wm.files.$n 2MB}
 $sb=$u.GetString($parts['binding.json'])|ConvertFrom-Json;if($sb.role -cne $Row.entryRole -or $sb.helperSha256 -cne $Row.helperSha256 -or (Hash $parts['binding.json']) -cne $wm.bindingSha256){throw 'EXACT_STAGE_BINDING_REQUIRED'}
 $raw=Read-SealedWork (Join-Path $dir 'inputs/payload-manifest.json') $sb.payloadManifestSha256 2MB;$pm=$u.GetString($raw)|ConvertFrom-Json
 $fixed=@('installation.json','acceptance.json','source-manifest.json','formal-service-entry.json','control-check-jobs.json','signers.json','all-check-jobs.json','work-admission-job.json','formal-job.json','acceptance-subject.json');if($Row.entryRole -ceq 'check-publisher'){$fixed+='inbox/job.json'}
 if((@($pm.files.PSObject.Properties.Name|Sort-Object)-join '|') -cne (($fixed|Sort-Object)-join '|')){throw 'EXACT_STAGE_INPUT_CLOSURE_REQUIRED'}
 foreach($n in $fixed){$r=$pm.files.$n;$b=Read-SealedWork (Join-Path $dir ('inputs/'+$n)) $r.sha256 2MB;if($b.Length -ne $r.bytes){throw 'STAGE_INPUT_SIZE_CHANGED'}}
 $null=Read-SealedWork (Join-Path $dir ('inputs/'+$Row.helper)) $Row.helperSha256 4MB
 if(@($pm.sourceFiles).Count -ne 84 -or (Hash $parts['deployment-pins.json']) -cne '10d38b438d4e154c7e21c8c5e0798c87726e65c94204b301996f42ebae683080'){throw 'FIXED_STAGE_84_SOURCE_REQUIRED'}
 $pins=$u.GetString($parts['deployment-pins.json'])|ConvertFrom-Json
 foreach($r in $pins.runtimeFiles){$found=@($pm.sourceFiles|Where-Object{$_.path -ceq $r.path -and $_.sha256 -ceq $r.sha256 -and $_.bytes -eq $r.bytes});if($found.Count -ne 1){throw 'STAGE_DEPLOYMENT_CLOSURE_CHANGED'};$b=Read-SealedWork (Join-Path $dir ('inputs/source/'+$r.sha256+'.bin')) $r.sha256;if($b.Length -ne $r.bytes){throw 'STAGE_SOURCE_SIZE_CHANGED'}}
 return $parts
}
function Assert-WorkerFact([string]$Text,[string]$IssueSha,[string]$ResultSha){
 $v=$Text|ConvertFrom-Json
 if((@($v.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'automaticRetryAllowed|checksWritten|cleanupConfirmed|issueSha256|qualificationIssued|resultSha256|status' -or $v.status -cne 'ACTUAL_SIGNED_ROLE_RESULT_EMITTED' -or $v.cleanupConfirmed -ne $true -or $v.checksWritten -ne $false -or $v.qualificationIssued -ne $false -or $v.automaticRetryAllowed -ne $false -or $IssueSha -cnotmatch '\A[a-f0-9]{64}\z' -or $ResultSha -cnotmatch '\A[a-f0-9]{64}\z' -or $v.issueSha256 -cne $IssueSha -or $v.resultSha256 -cne $ResultSha){throw 'ACTUAL_WORKER_CLEANUP_PROOF_REQUIRED'}
}
function Complete-ActualWorker($Record){
 $text=Finish-PublicChild $Record;$issue=Read-ReadyPair 'outgoing' 'issue';$result=Read-ReadyPair 'incoming' 'result';Assert-WorkerFact $text (Hash $issue) (Hash $result)
}
function Relay([string]$Mode,[int]$Sequence=0){
 $script='C:\Users\17531\AppData\Local\Temp\codex-actions-hosted-stagec-20261018\work\actions-hosted-migration\independent-ci-v1\worker\protected-job-bridge-v3\relay-public.ps1';$args='-NoProfile -NonInteractive -File "'+$script+'" -Mode '+$Mode+' -Sequence '+$Sequence+' -ExpectedBundleSha256 '+$BridgeManifestSha256
 $r=Start-PublicChild 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' $args
 if(-not $r.process.WaitForExit(40000)){while(-not $r.process.WaitForExit(1000)){};throw 'RELAY_UNKNOWN_TERMINAL_PRESERVED'};$r.process.WaitForExit()
 if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($r.stdout,$r.stderr),5000)){throw 'RELAY_OUTPUT_UNCONFIRMED'};$out=$r.stdout.GetAwaiter().GetResult();$err=$r.stderr.GetAwaiter().GetResult();if($err.Length -gt 0){throw 'FIXED_RELAY_STDERR_REFUSED'};$v=$out|ConvertFrom-Json
 if($r.process.ExitCode -eq 0 -and $v.status -ceq 'PUBLIC_RECORD_TRANSFERRED' -and $v.terminalConfirmed -eq $true){return $true}
 if($null -ne $v.childError -and $v.childError.reason -ceq 'ENOENT' -and $v.terminalConfirmed -eq $true){return $false};throw 'FIXED_RELAY_REFUSED_NO_RETRY'
}
try{
 if(-not $RunOnce -or $ExpectedBatchBindingSha256 -cnotmatch '\A[a-f0-9]{64}\z'){throw 'FIXED_BATCH_DISABLED_BEFORE_HOST'}
 $mb=[IO.File]::ReadAllBytes((Join-Path $CandidateRoot 'batch-manifest.json'));$mh=Hash $mb;if($mh -cne $ReviewedManifestSha256 -or $mh -cne $OwnerApprovedManifestSha256 -or -not $OwnerApprovesFixedEightStages -or -not $OwnerAcceptsCooperativeAdminWindow){throw 'EXACT_COMPLETE_BATCH_APPROVAL_REQUIRED'}
 $m=(New-Object Text.UTF8Encoding($false,$true)).GetString($mb)|ConvertFrom-Json
 foreach($n in @('run-batch.ps1','advance-functions.ps1','FormalStageFiles.cs','linux-archive.py','batch-binding.json')){$f=[IO.File]::Open((Join-Path $CandidateRoot $n),'Open','Read','Read');$packageHeld.Add($f);$b=New-Object byte[] ([int]$f.Length);$null=$f.Read($b,0,$b.Length);if((Hash $b) -cne $m.files.$n){throw 'FIXED_BATCH_SOURCE_CHANGED'};$PayloadBytes[$n]=$b}
 if((Hash $PayloadBytes.'batch-binding.json') -cne $ExpectedBatchBindingSha256){throw 'EXACT_BATCH_BINDING_REQUIRED'};$u=New-Object Text.UTF8Encoding($false,$true);$binding=$u.GetString($PayloadBytes.'batch-binding.json')|ConvertFrom-Json
 $fixedRoles=@('work-admission','scanner-issuer','check-publisher','scanner-issuer','check-publisher','scanner-issuer','check-publisher','control-checks');$fixedJobRoles=@('work-admission','gitleaks','gitleaks','trivy','trivy','contract-placement','contract-placement','control-admission');$fixedTimes=@(900000,2700000,900000,1800000,900000,600000,900000,900000)
 if($binding.contract -cne 'clued.independent-ci.fixed-six-check-bound-batch/1' -or @($binding.stages).Count -ne 8 -or $binding.starts -ne 8 -or $binding.maximumStops -ne 8 -or $binding.sourceInstallations -ne 0 -or $binding.sourceCount -ne 84 -or $binding.automaticRetryAllowed -ne $false){throw 'EXACT_FIXED_EIGHT_STAGE_BATCH_REQUIRED'}
 $firstParts=$null;for($i=0;$i -lt 8;$i++){$r=$binding.stages[$i];$num=$i+1;if($r.number -ne $num -or $r.directory -cne ('stage-'+$num.ToString('00')) -or $r.helper -cne ('controller-formal-stage-'+$num.ToString('00')+'-v1.exe') -or $r.entryRole -cne $fixedRoles[$i] -or $r.jobRole -cne $fixedJobRoles[$i] -or $r.runMilliseconds -ne $fixedTimes[$i] -or $r.linuxWorker -ne ($num -cin @(2,4,6))){throw 'FIXED_STAGE_ORDER_REQUIRED'};$parts=Assert-SealedStage $r;if($num -eq 1){$firstParts=$parts}}
 $first=Join-Path $CandidateRoot 'stage-01'
 foreach($n in @('invoke-io.ps1','invoke-functions.ps1','host-baseline.ps1','restore-functions.ps1')){. ([scriptblock]::Create($u.GetString($firstParts[$n])))}
 function Save-Progress{Save-BatchProgress}
 . ([scriptblock]::Create($u.GetString($PayloadBytes.'advance-functions.ps1')))
 foreach($n in @('FixedScm.cs','ScmPidHandshake.cs','HostFiles.cs','FormalRepairFiles.cs')){$PayloadBytes[$n]=$firstParts[$n]}
 Add-Type -TypeDefinition ($u.GetString($PayloadBytes.'FixedScm.cs')+[char]10+$u.GetString($PayloadBytes.'ScmPidHandshake.cs'));Add-Type -TypeDefinition ($u.GetString($PayloadBytes.'HostFiles.cs')+[char]10+$u.GetString($PayloadBytes.'FormalRepairFiles.cs')+[char]10+$u.GetString($PayloadBytes.'FormalStageFiles.cs'))
 Add-Type -TypeDefinition 'using System;using System.IO;using System.Text;using System.Threading.Tasks;public static class BatchChildIO{public static async Task<string> Read(TextReader r,int max){var b=new char[4096];var s=new StringBuilder();bool over=false;for(;;){int n=await r.ReadAsync(b,0,b.Length);if(n==0){if(over)throw new IOException("PUBLIC_CHILD_OUTPUT_BOUND");return s.ToString();}if(s.Length+n>max)over=true;if(!over)s.Append(b,0,n);}}}'
 $bridgeRoot='C:\Users\17531\AppData\Local\Temp\codex-actions-hosted-stagec-20261018\work\actions-hosted-migration\independent-ci-v1\worker\protected-job-bridge-v3';$bridge=$u.GetString((Read-SealedWork (Join-Path $bridgeRoot 'manifest.json') $BridgeManifestSha256 65536))|ConvertFrom-Json
 foreach($p in $bridge.runtimeFiles.PSObject.Properties){$null=Read-SealedWork (Join-Path $bridgeRoot $p.Name) $p.Value.sha256 1MB};$lastIssuer=$null
 # Freeze the complete WORK ancestor chains before any Host inspection/effect.
 # Stage readers consume only files locked above; no mutable directory redirect.
 $parentPaths=@{};foreach($h in @($packageHeld)){if($h -is [IO.FileStream]){for($p=Split-Path -Parent $h.Name;$p;$p=Split-Path -Parent $p){$parentPaths[$p]=$true}}}
 foreach($p in @($parentPaths.Keys|Sort-Object Length,{$_})){$h=[VerifyInstallFiles]::HoldMetadata($p,$true);$packageHeld.Add($h)}
 foreach($h in @($packageHeld)){if($h -is [IO.FileStream]){[VerifyInstallFiles]::ExactPath($h.SafeFileHandle,$h.Name);$i=[VerifyInstallFiles]::Metadata($h.SafeFileHandle);if(($i.Attributes -band 0x410) -ne 0 -or $i.Links -ne 1){throw 'SINGLE_LINK_SEALED_PACKAGE_REQUIRED'}}}
 foreach($definition in (Get-BaselineDefinitions)){. ([scriptblock]::Create($definition))};foreach($definition in (Get-ReviewedHelpers)){. ([scriptblock]::Create($definition))};$script:originalManifest=Assert-ReviewedBundle
 $receipt.state='RUNNING_FIXED_EIGHT_STAGES';$progress=Join-Path $CandidateRoot 'batch-receipt.json';$workStream=[IO.File]::Open($progress,'CreateNew','Write','Read');Save-Progress

 foreach($row in $binding.stages){
  $stage='STAGE_'+$row.number.ToString('00')+'_'+$row.name;Save-Progress
  if([DateTimeOffset]::UtcNow.AddMilliseconds([long]$row.runMilliseconds+180000) -gt [DateTimeOffset]::Parse($binding.validUntil) -or [DateTimeOffset]::UtcNow.AddMilliseconds([long]$row.runMilliseconds+180000) -gt [DateTimeOffset]::Parse($binding.claim.expiresAt)){throw 'FULL_NEXT_STAGE_AUTHORITY_WINDOW_REQUIRED'}
  if($row.number -eq 8){$request=[ordered]@{contract='clued.independent-ci.await-owner-queue/1';claim=$binding.claim;jobId=$row.jobId;acceptedSubjectSha256=$binding.acceptedSubjectSha256;nativeTicketIssued=$false;markerIsAuthority=$false};$qb=$u.GetBytes(($request|ConvertTo-Json -Depth 8));$qf=[IO.File]::Open((Join-Path $CandidateRoot 'native-queue-request.json'),'CreateNew','Write','Read');try{$qf.Write($qb,0,$qb.Length);$qf.Flush($true)}finally{$qf.Dispose()};$wait=[DateTimeOffset]::UtcNow.AddMinutes(5);$gate=Join-Path $CandidateRoot 'native-queue-ready.json';while(-not [IO.File]::Exists($gate)){if([DateTimeOffset]::UtcNow -ge $wait){throw 'ACTUAL_OWNER_QUEUE_TRIGGER_MISSING'};Start-Sleep -Milliseconds 250};$g=Parse-Public (Read-PublicWork $gate 4096);if($g.claimId -cne $binding.claim.claimId -or $g.jobId -cne $row.jobId -or $g.acceptedSubjectSha256 -cne $binding.acceptedSubjectSha256 -or $g.receiptRef -cnotmatch '\A[a-f0-9-]{36}\z'){throw 'EXACT_OWNER_QUEUE_TRIGGER_REQUIRED'}}
  if($row.entryRole -ceq 'scanner-issuer' -and $null -ne $lastIssuer){Archive-WindowsProtocol $lastIssuer.jobId;$py=$u.GetString($PayloadBytes.'linux-archive.py');$encoded=[Convert]::ToBase64String($u.GetBytes($py));$args='--distribution Ubuntu-24.04 --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/python3.12 -c "import base64;exec(base64.b64decode('''+$encoded+'''))" '+$lastIssuer.jobId;$a=Start-PublicChild 'C:\Windows\System32\wsl.exe' $args;if(-not $a.process.WaitForExit(30000)){while(-not $a.process.WaitForExit(1000)){};throw 'LINUX_ARCHIVE_TERMINAL_UNKNOWN'};$v=(Finish-PublicChild $a)|ConvertFrom-Json;if($v.status -cne 'EXACT_PUBLIC_PROTOCOL_ARCHIVED' -or $v.jobId -cne $lastIssuer.jobId){throw 'LINUX_PROTOCOL_ARCHIVE_UNCONFIRMED'}}
  Prepare-StageInputs $row
  $dir=Join-Path $CandidateRoot $row.directory;$mode='ActivateOnce';$args='-NoProfile -NonInteractive -File "'+(Join-Path $dir 'invoke-control.ps1')+'" -Mode '+$mode+' -ReviewedManifestSha256 '+$row.workManifestSha256+' -OwnerApprovedManifestSha256 '+$row.workManifestSha256+' -OwnerApprovesFormalInvocation -OwnerAcceptsCooperativeAdminWindow'
  $child=Start-PublicChild 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' $args;$terminal=$false;$receipt.stage_invocations++;Save-Progress
  if($row.linuxWorker){
   $deadline=[DateTimeOffset]::UtcNow.AddMilliseconds([long]$row.runMilliseconds+120000);$ready=Join-Path $Root 'formal-spool/outgoing/issue.ready.json';while(-not [IO.File]::Exists($ready)){if($child.process.HasExited -or [DateTimeOffset]::UtcNow -ge $deadline){throw 'ACTUAL_ISSUE_NOT_PUBLISHED'};Start-Sleep -Milliseconds 100};if(-not (Relay 'SendIssue')){throw 'ISSUE_TRANSFER_UNCONFIRMED'}
   $worker=Start-PublicChild 'C:\Windows\System32\wsl.exe' '--distribution Ubuntu-24.04 --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /opt/actions-runner/externals/node24/bin/node /opt/clued-independent-ci/source/work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/linux-worker.mjs --run'
   $sequence=1;$result=$false;while(-not $result){if([DateTimeOffset]::UtcNow -ge $deadline){throw 'FORMAL_BRIDGE_STAGE_DEADLINE'};$result=Relay 'ReceiveResult';if($result){break};if($sequence -le 32 -and (Relay 'ReceiveChallenge' $sequence)){$response=Join-Path $Root ('formal-spool/outgoing/response-'+$sequence.ToString('00')+'.ready.json');$responseDeadline=[DateTimeOffset]::UtcNow.AddSeconds(30);while(-not [IO.File]::Exists($response)){if($child.process.HasExited -or [DateTimeOffset]::UtcNow -ge $responseDeadline){throw 'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED'};Start-Sleep -Milliseconds 100};if(-not (Relay 'SendResponse' $sequence)){throw 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED'};$sequence++};Start-Sleep -Milliseconds 100}
   if(-not $worker.process.WaitForExit(30000)){throw 'FORMAL_WORKER_TERMINAL_UNCONFIRMED'};Complete-ActualWorker $worker;$worker=$null;$lastIssuer=$row
  }
  if(-not $child.process.WaitForExit([int]([long]$row.runMilliseconds+180000))){throw 'STAGE_INVOKER_TERMINAL_UNCONFIRMED'};$terminal=$true;$text=Finish-PublicChild $child;$fact=$text|ConvertFrom-Json
  if($fact.state -cne 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' -or $fact.complete_original_readback -ne $true -or $fact.original_binary_restored -ne $true -or $fact.tree_cleanup_confirmed -ne $true -or $fact.tree_active_processes -ne 0 -or $fact.root_exit_confirmed -ne $true -or $fact.manifest_sha256 -cne $row.workManifestSha256 -or $fact.scm_start_call_issued -ne $true -or $fact.configuration_conflict_detected -ne $false){throw 'ACTUAL_PREVIOUS_STAGE_TERMINAL_REQUIRED'}
  $receipt.scm_starts++;$receipt.stages+= [ordered]@{number=$row.number;name=$row.name;manifestSha256=$row.workManifestSha256;nativeReceiptSha256=$fact.native_receipt_sha256;scmPid=$fact.scm_helper_pid;rootExit=$true;tree0=$true;originalManualStopped=$true};Save-Progress;$child=$null
 }
 $receipt.state='FIXED_EIGHT_STAGES_COMPLETED_NO_MERGE_OR_QUALIFICATION';$code=0
}catch{$receipt.state='STOPPED_REFUSED_OR_UNKNOWN_NO_AUTOMATIC_RETRY';$id=$_.FullyQualifiedErrorId.Split(',')[0];$receipt.failure_code=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}else{'FIXED_BATCH_UNCONFIRMED'}}
finally{
 # Never kill an unknown WSL/process tree or proceed to another stage. Existing
 # child invoker owns its one Stop and full original service restoration.
 if(($null -ne $child -and -not $terminal) -or $null -ne $worker){
  $receipt.state='UNKNOWN_CHILD_OR_WORKER_RETAINED_NO_RETRY';try{Save-BatchProgress}catch{}
  if($null -ne $child){while(-not $child.process.WaitForExit(1000)){}}
  if($null -ne $worker){while(-not $worker.process.WaitForExit(1000)){};try{Complete-ActualWorker $worker;$worker=$null}catch{$receipt.state='UNKNOWN_WORKER_CLEANUP_LOCKS_RETAINED_NO_RETRY';try{Save-BatchProgress}catch{};while($true){Start-Sleep -Seconds 5}}}
 }
 Save-BatchProgress;if($null -ne $workStream){$workStream.Dispose()};foreach($h in $held){$h.Dispose()};foreach($h in $packageHeld){$h.Dispose()};$receipt|ConvertTo-Json -Depth 12
}
exit $code
