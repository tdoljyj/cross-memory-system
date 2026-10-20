# Unbound public Source. No elevation, credentials, arbitrary command or provider.
[CmdletBinding()]
param([ValidateSet('Prepare','InspectBaseline','RunOnce','ActivateOnce','InstallOnly')][string]$Mode='Prepare',
 [string]$ReviewedManifestSha256,[string]$OwnerApprovedManifestSha256,
 [switch]$ContinueWithFixedBatch,[switch]$OwnerApprovesFormalInvocation,[switch]$OwnerAcceptsCooperativeAdminWindow)
Set-StrictMode -Version 2.0;$ErrorActionPreference='Stop'
$ExpectedBindingSha256=$null
$CandidateRoot=$PSScriptRoot;$PackageSourceRoot=Split-Path -Parent $CandidateRoot;if((Split-Path -Leaf $CandidateRoot) -ceq 'bound-invoker'){$PackageSourceRoot=Split-Path -Parent $CandidateRoot};$IndependentRoot=Split-Path -Parent (Split-Path -Parent $PackageSourceRoot);$MigrationRoot=Split-Path -Parent $IndependentRoot
$Root='C:\ProgramData\CluedIndependentCI';$Source=Join-Path $Root 'source';$State=Join-Path $Root 'state'
$HelperPath=Join-Path $Root 'controller-formal-control-v1.exe';$HelperBinary='"'+$HelperPath+'"'
$held=New-Object 'Collections.Generic.List[IDisposable]';$lockedDirectories=@{};$PayloadBytes=@{};$AllowedCreatePaths=@{};$oldReads=@{}
$continuationChild=$null;$continuationTerminal=$true;$packageHeld=New-Object 'Collections.Generic.List[IDisposable]';$fixedSession=$false;$workStream=$null;$exitCode=0;$stage='UNBOUND_FORMAL_SOURCE_GUARD'
$receipt=[ordered]@{contract='clued.independent-ci.formal-fixed-invocation/1';mode=$Mode;state='NOT_EXECUTED';manifest_sha256=$null;binding_sha256=$null;current_stage=$null;observed_at=[DateTimeOffset]::UtcNow.ToString('o');completed_at=$null;failure_stage=$null;failure_code=$null;restore_failure_code=$null;actual_host_read=$false;effects_started=$false;cooperative_mutex_acquired=$false;atomic_os_cas_claimed=$false;created_files=@();creation_attempted_path=$null;protected_backups=@();replaced_public_files=@();replace_attempted_path=$null;complete_public_repair_readback=$false;binary_change_attempted=$false;binary_switched=$false;scm_start_attempted=$false;scm_start_returned=$false;scm_helper_pid=$null;bounded_stop_attempted=$false;binary_restore_attempted=$false;original_binary_restored=$false;complete_original_readback=$false;configuration_conflict_detected=$false;tree_cleanup_confirmed=$false;tree_active_processes=$null;root_exit_confirmed=$false;native_receipt_sha256=$null;formal_child_completed=$false;partial_objects_preserved=$false;private_bytes_read_by_invoker=$false;qualification_issued=$false;host_qualified=$false;ci_principal_qualified=$false;publisher_qualified=$false;checks_outcome='RUNTIME_OWNS_READBACK_UNKNOWN_UNTIL_OBSERVED'}
foreach($f in @('actual_sid','controller_sid','service_logon_name','service_logon_resolved_sid','service_state','service_start_mode')){$receipt[$f]=$null};$receipt['elevated']=$false;$receipt['created_directories']=@();$receipt['scm_start_call_issued']=$false;$receipt['observed_installed_file_metadata']=@()
try{
 # This compiled constant is checked before any file read, receipt creation,
 # Add-Type, baseline helper, identity lookup, mutex or Host access in ALL modes.
 if($ExpectedBindingSha256 -isnot [string] -or $ExpectedBindingSha256.Length -ne 64 -or $ExpectedBindingSha256 -cnotmatch '\A[a-f0-9]{64}\z'){throw 'FORMAL_BINDING_UNBOUND_BEFORE_HOST'}
 $names=@('invoke-control.ps1','continue-fixed.ps1','ContinuationFiles.cs','invoke-functions.ps1','invoke-io.ps1','FixedScm.cs','ScmPidHandshake.cs','HostFiles.cs','FormalRepairFiles.cs','host-baseline.ps1','restore-functions.ps1','runtime-pins.json','deployment-pins.json','prior-installed.json','binding.json')
 # Only fixed WORK files. Review pins below cover the actually executing script.
 $manifestBytes=[IO.File]::ReadAllBytes((Join-Path $CandidateRoot 'work-manifest.json'));$sha=[Security.Cryptography.SHA256]::Create();try{$manifestHash=([BitConverter]::ToString($sha.ComputeHash($manifestBytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 if($ReviewedManifestSha256 -cne $manifestHash){throw 'EXACT_REVIEWED_INVOKER_MANIFEST_REQUIRED'}
 $m=((New-Object Text.UTF8Encoding($false,$true)).GetString($manifestBytes)|ConvertFrom-Json)
 if($m.contract -cne 'clued.independent-ci.formal-fixed-invocation-work/1' -or $m.effectsAuthorized -ne $false -or @($m.files.PSObject.Properties).Count -ne $names.Count -or @(Compare-Object ($names|Sort-Object) (@($m.files.PSObject.Properties.Name)|Sort-Object) -CaseSensitive).Count){throw 'EXACT_CLOSED_INVOKER_FILES_REQUIRED'}
 foreach($name in $names){$s=[IO.File]::Open((Join-Path $CandidateRoot $name),'Open','Read','Read');$held.Add($s);if($s.Length -lt 1 -or $s.Length -gt 2MB){throw 'WORK_SOURCE_SIZE_REFUSED'};$b=New-Object byte[] ([int]$s.Length);$at=0;while($at -lt $b.Length){$n=$s.Read($b,$at,$b.Length-$at);if($n -lt 1){throw 'WORK_SOURCE_TRUNCATED'};$at+=$n};$sha=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($sha.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($h -cne $m.files.$name){throw 'WORK_SOURCE_PIN_REFUSED'};$PayloadBytes[$name]=$b}
 $u=New-Object Text.UTF8Encoding($false,$true)
 foreach($name in @('invoke-io.ps1','invoke-functions.ps1','host-baseline.ps1','restore-functions.ps1','continue-fixed.ps1')){. ([ScriptBlock]::Create($u.GetString($PayloadBytes[$name])))}
 if($Mode -ceq 'RunOnce'){throw 'TWO_STAGE_INSTALL_ONLY_THEN_ACTIVATE_REQUIRED'}
 Assert-CompiledBinding;$binding=Parse-Public $PayloadBytes.'binding.json';Assert-BoundInputs $binding
 $receipt.manifest_sha256=$manifestHash;$receipt.binding_sha256=$ExpectedBindingSha256
 # Additional helpers are extracted from exact predecessor public WORK pins;
 # definitions are loaded, never the predecessor installer/main block.
 foreach($definition in (Get-BaselineDefinitions)){. ([ScriptBlock]::Create($definition))};foreach($definition in (Get-ReviewedHelpers)){. ([ScriptBlock]::Create($definition))};$originalManifest=Assert-ReviewedBundle
 $dir=Join-Path $CandidateRoot 'receipts';if(-not (Test-Path -LiteralPath $dir)){[void][IO.Directory]::CreateDirectory($dir)};Work-NoReparse $dir;$workStream=[IO.File]::Open((Join-Path $dir ($Mode+'-'+[Guid]::NewGuid().ToString('N')+'.json')),'CreateNew','Write','Read');Save-Progress
 if($Mode -ceq 'Prepare'){$receipt.state='BOUND_WORK_PREPARED_NO_HOST_READ'}else{
  if($OwnerApprovedManifestSha256 -cne $manifestHash -or -not $OwnerApprovesFormalInvocation -or -not $OwnerAcceptsCooperativeAdminWindow){throw 'FRESH_SPECIFIC_FORMAL_OWNER_APPROVAL_REQUIRED'}
  Assert-FormalWindow;$stage='EXACT_ELEVATED_OWNER';Assert-OwnerEnvironment
  Add-Type -TypeDefinition ($u.GetString($PayloadBytes.'HostFiles.cs')+[char]10+$u.GetString($PayloadBytes.'FormalRepairFiles.cs')+[char]10+$u.GetString($PayloadBytes.'ContinuationFiles.cs'));Add-Type -TypeDefinition ($u.GetString($PayloadBytes.'FixedScm.cs')+[char]10+$u.GetString($PayloadBytes.'ScmPidHandshake.cs'))
  $stage='FIXED_COOPERATIVE_MUTEX';[CluedSession0ScmV2]::BeginFixedSession($Mode -cin @('RunOnce','ActivateOnce','InstallOnly'));$fixedSession=$true;$receipt.cooperative_mutex_acquired=$true
  $stage='FULL_ORIGINAL_BASELINE';$null=Assert-CurrentOriginalHost $originalManifest;$stage='ALL_FIXED_PUBLIC_SOURCE_TARGETS';Assert-AllTargetsBeforeEffects
  if($Mode -ceq 'InspectBaseline'){$receipt.state='FORMAL_BOUND_ORIGINAL_STOPPED_INSPECTED_NO_HOST_WRITE'}else{
   if($Mode -ceq 'RunOnce' -or $Mode -ceq 'InstallOnly'){$stage='STAGE_FIXED_PUBLIC_PAYLOAD';Assert-FormalWindow;Install-FixedPublicAndSource}
   if($Mode -ceq 'InstallOnly'){if(-not $ContinueWithFixedBatch){throw 'FIXED_TWO_STAGE_CONTINUATION_REQUIRED'};Invoke-FixedReceiptContinuation;$receipt.state='TWO_STAGE_INSTALL_AND_FIXED_BATCH_COMPLETED';return}
   $stage='CLOSEST_FULL_ORIGINAL_BASELINE';$null=Assert-CurrentOriginalHost $originalManifest
   try{
    $stage='ONE_BINARY_SWITCH';Assert-FormalWindow;$receipt.binary_change_attempted=$true;Save-Progress;[CluedSession0ScmV2]::SwitchOnlyBinary($OriginalBinary,$HelperBinary,$ExpectedStable);$receipt.binary_switched=$true;Save-Progress
    $nonce=[Guid]::NewGuid().ToString('N');$receipt['public_nonce']=$nonce
    $stage='SINGLE_START';Assert-FormalWindow;$receipt.scm_start_attempted=$true;Save-Progress
    try{$receipt.scm_helper_pid=[CluedSession0ScmV2]::StartFixedOnce($HelperBinary,$ExpectedStable,$nonce,$AuthorityExpiry);$receipt.scm_start_returned=$true}
    finally{$receipt.scm_start_call_issued=[CluedSession0ScmV2]::StartCallIssued;if([CluedSession0ScmV2]::IndependentStartPid -gt 0){$receipt.scm_helper_pid=[CluedSession0ScmV2]::IndependentStartPid};Save-Progress}
    $stage='FINITE_WAIT';if(-not (Wait-FixedStopped ([int][Math]::Max(1,[Math]::Floor(($InvocationDeadline-[DateTimeOffset]::UtcNow).TotalSeconds))))){throw 'FORMAL_SINGLE_ACTIVATION_DEADLINE'}
    $stage='CHECK_WHOLE_TREE_PUBLIC_RECEIPT';Read-FormalNativeReceipt $nonce
   }catch{$receipt.failure_stage=$stage;$receipt.failure_code=Safe-Code $_}
   finally{Restore-FixedOriginal $originalManifest}
   if($null -ne $receipt.restore_failure_code){$receipt.state='PARTIAL_RESTORE_REQUIRED_NO_RETRY';$exitCode=42}elseif($null -ne $receipt.failure_code){$receipt.state='FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED';$exitCode=41}else{$receipt.state='FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION'}
  }
 }
}catch{
 $receipt.failure_stage=$stage;$id=$_.FullyQualifiedErrorId.Split(',')[0];$receipt.failure_code=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}else{'FORMAL_INVOCATION_UNCONFIRMED'}
 if($receipt.effects_started){$receipt.state='PARTIAL_PUBLIC_FILES_PRESERVED_NO_RETRY';$receipt.partial_objects_preserved=$true;$exitCode=41}else{$receipt.state='REFUSED_NO_HOST_WRITE';$exitCode=40}
}finally{
 # Unknown terminal/cleanup retains all Source/config/parent handles and the
 # cooperative session. No second Start/Stop, deletion or automatic repair.
 # Only read-only observation can resolve the unknown; otherwise Owner recovery
 # must explicitly handle this live process and preserved receipt.
 if($receipt.scm_start_call_issued -and (-not $receipt.complete_original_readback -or -not $receipt.tree_cleanup_confirmed)){
  $receipt.state='UNKNOWN_TERMINAL_LOCKS_RETAINED_NO_RETRY';if($null -ne $workStream){try{Save-Progress}catch{}}
  while($true){Start-Sleep -Seconds 5;try{$s=[CluedSession0ScmV2]::ReadStatus();if($s.State -eq 1){try{Read-FormalNativeReceipt $nonce}catch{};try{$null=Assert-CurrentOriginalHost $originalManifest;$receipt.original_binary_restored=$true;$receipt.complete_original_readback=$true}catch{};if($receipt.complete_original_readback -and $receipt.tree_cleanup_confirmed){break}}}catch{}}
 }
 if($null -ne $continuationChild -and -not $continuationTerminal){$receipt.state='UNKNOWN_CONTINUATION_LOCKS_RETAINED';try{Save-Progress}catch{};while($true){try{$null=$continuationChild.WaitForExit(1000)}catch{Start-Sleep -Seconds 1};Start-Sleep -Seconds 1}}
 foreach($h in $packageHeld){$h.Dispose()}
 if($fixedSession){$receipt.configuration_conflict_detected=[CluedSession0ScmV2]::HasConflict;[CluedSession0ScmV2]::EndFixedSession()}
 $receipt.completed_at=[DateTimeOffset]::UtcNow.ToString('o');if($null -ne $workStream){try{Save-Progress}catch{$exitCode=43};$workStream.Dispose()}
 for($i=$held.Count-1;$i -ge 0;$i--){$held[$i].Dispose()};$receipt|ConvertTo-Json -Depth 8
}
exit $exitCode
