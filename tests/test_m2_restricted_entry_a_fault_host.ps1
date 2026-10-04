# Run with pwsh -NoProfile -File tests/test_m2_restricted_entry_a_fault_host.ps1.
# No Hyper-V, registry, focus, screenshots or keys are accessed. Python children only print/exit.
$ErrorActionPreference='Stop'
trap { Write-Host $_.ScriptStackTrace; throw $_ }
. (Join-Path $PSScriptRoot '../kernel/host/m2-restricted-entry-a-fault-host.ps1')
Set-StrictMode -Version Latest
$script:HarmlessTestPython='C:\Users\Windows\AppData\Local\Programs\Python\Python312\python.exe'
# Test-only executable for print/exit children. Production Get-M2FaultConstants stays pinned to Program Files.
$script:checks=0
function Assert($Condition,[string]$Message) { if(!$Condition) { throw "ASSERT: $Message" }; $script:checks++ }
function Denies([scriptblock]$Action,[string]$Message) {
    $denied=$false; try { & $Action|Out-Null } catch { $denied=$true }
    Assert $denied $Message
}
function New-FakeProcess($ExitCode,[switch]$GetterError,[switch]$Timeout,[switch]$HandleError) {
    $value=[pscustomobject]@{events=[Collections.Generic.List[string]]::new();code=$ExitCode;getter_error=[bool]$GetterError;timed_out=[bool]$Timeout;handle_error=[bool]$HandleError;StandardOutput=[IO.StringReader]::new('out');StandardError=[IO.StringReader]::new('')}
    $value|Add-Member ScriptProperty Handle { $this.events.Add('handle'); if($this.handle_error){throw 'handle-error'}; [IntPtr]123 }
    $value|Add-Member ScriptProperty ExitCode { $this.events.Add('exit'); if($this.getter_error){throw 'getter-error'}; $this.code }
    $value|Add-Member ScriptMethod WaitForExit { param($milliseconds) $this.events.Add('wait'); !$this.timed_out }
    $value
}
function New-HarmlessPythonProcess([int]$Code,[string]$Text='harmless') {
    $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$script:HarmlessTestPython
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    foreach($argument in @('-I','-S','-c',"import sys; print('$Text'); sys.exit($Code)")) { $psi.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$psi; Assert ($process.Start()) 'harmless Python starts'; $process
}
$python=$script:HarmlessTestPython
Assert (Test-Path -LiteralPath $python) 'explicit harmless test Python available'
# Compile declarations only; do not call any native method. FILETIME alignment must match Windows ABI.
Initialize-M2FaultNative
Assert ([Runtime.InteropServices.Marshal]::SizeOf([type][M2FaultNative+FileInfo]) -eq 52) 'native file identity structure size'
Assert ([Runtime.InteropServices.Marshal]::OffsetOf([type][M2FaultNative+FileInfo],'volume').ToInt32() -eq 28) 'native file identity volume offset'
foreach($code in @(0,7)) {
    $child=New-HarmlessPythonProcess $code
    try {
        $result=Wait-M2FaultProcess $child
        Assert ($result.bridge_exit_code -is [int] -and $result.bridge_exit_code -eq $code) 'actual numeric child ExitCode'
        Assert ($result.stdout.Trim() -eq 'harmless') 'actual redirected stdout collected'
        Assert ($result.execution_state -eq 'UNKNOWN') 'exit never guest STOPPED'
        Assert ($result.bridge_status -eq $(if($code -eq 0){'BRIDGE_EXITED_ZERO'}else{'BRIDGE_FAILED'})) 'actual zero/nonzero classification'
    } finally { $child.Dispose() }
}
foreach($case in @(@{code=0},@{code=5},@{code=$null},@{code=0;GetterError=$true},@{code=0;Timeout=$true},@{code=0;HandleError=$true})) {
    $parameters=@{ExitCode=$case.code}; foreach($key in @('GetterError','Timeout','HandleError')) { if($case.ContainsKey($key)) { $parameters[$key]=$case[$key] } }
    $fake=New-FakeProcess @parameters; $result=Wait-M2FaultProcess $fake
    Assert ($fake.events[0] -eq 'handle') 'handle before any wait/exit'
    if(!$case.ContainsKey('HandleError')) { Assert ($fake.events[1] -eq 'wait') 'bounded wait second' }
    if($null -eq $case.code -or $case.ContainsKey('GetterError') -or $case.ContainsKey('Timeout') -or $case.ContainsKey('HandleError')) { Assert ($result.bridge_status -eq 'UNKNOWN') 'null/getter/timeout/handle fail closed' }
    if($case.ContainsKey('Timeout')) { Assert (!$fake.events.Contains('exit')) 'timeout never reads ExitCode' }
}
Denies { Wait-M2FaultProcess (New-FakeProcess 0) 30001 } 'timeout cannot be widened'
function New-TestBatchSummary {
    $rows=@()
    foreach($case in @('timeout','revoke','disconnect')) {
        $leader=@{pid=100;start_ticks=200;pgid=100;session=100;uid=1001;gid=1001;state='S'}
        $member=@{pid=101;start_ticks=201;pgid=100;session=100;uid=1001;gid=1001;state='S'}
        $binding=@{boot_id='00000000-0000-4000-8000-000000000001';leader=$leader}
        $rows+=@{schema='m2-a-fault-case-observation-v1';case=$case;request_id=('m2-fault-20261004-'+$case+'-01');qualification='NOT_ISSUED';scenario_status='CONFIRMED_OBSERVATIONS';execution_state='STOPPED';trigger_actual=$case;stop_elapsed_seconds=0.01;trigger_to_observation_seconds=0.02;before=@{binding=$binding;members=@($leader,$member);tracked=@();complete=$true;reason=''};after=@{binding=$binding;members=@();tracked=@($null,$null);complete=$true;reason=''};native_proof=@{scope='entire_cgroup';cgroup_empty=$true;leader_reaped=$true;identity_unchanged=$true}}
    }
    @{schema='m2-a-fault-batch-observation-v1';batch_status='OBSERVATIONS_COMPLETE';qualification='NOT_ISSUED';cases=$rows}
}
$validSummary=(New-TestBatchSummary)|ConvertTo-Json -Compress -Depth 20
$validAudit='{"qualification":"NOT_ISSUED","host_events":[{"case":"revoke","action":"revoke-sent","host_monotonic":1.0},{"case":"disconnect","action":"actual-socket-close","host_monotonic":2.0}]}'
$output=[pscustomobject]@{bridge_status='BRIDGE_EXITED_ZERO';bridge_exit_code=0;stdout=$validSummary;stderr=$validAudit}
Assert ((Assert-M2FaultBatchOutput $output).qualification -eq 'NOT_ISSUED') 'validated observation still unqualified'
Assert ($output.host_audit.host_events.Count -eq 2) 'trusted stderr audit preserved separately'
$output.stdout='{"execution_state":"STOPPED"}'; Denies { Assert-M2FaultBatchOutput $output } 'transport output cannot claim observed batch'
$output.stdout=$validSummary.Replace('NOT_ISSUED','PASS'); Denies { Assert-M2FaultBatchOutput $output } 'qualification PASS rejected'
$output.stdout=$validSummary; $output.bridge_exit_code=$null; Denies { Assert-M2FaultBatchOutput $output } 'null exit rejected even valid stdout'
$output.bridge_exit_code=0
foreach($audit in @('','not-json',($validAudit+"`n"+$validAudit),$validAudit.Replace('actual-socket-close','retry-socket'),$validAudit.Replace('2.0','0.5'),$validAudit.Replace('1.0','true'),$validAudit.Replace('NOT_ISSUED','PASS'))) {
    $output.stderr=$audit; Denies { Assert-M2FaultBatchOutput $output } 'malformed/duplicate/foreign/nonmonotonic stderr rejected'
}
$output.stderr=$validAudit; $output.stdout='prefix'+$validSummary
Denies { Assert-M2FaultBatchOutput $output } 'arbitrary stdout prefix rejected'
$output.stdout=$validSummary+"`n"+$validSummary; Denies { Assert-M2FaultBatchOutput $output } 'multiple stdout summaries rejected'
foreach($change in @('extra-key','case-id','proof','time-type','time-bound')) {
    $summary=New-TestBatchSummary
    switch($change) {
        'extra-key' { $summary.role='Agent' }
        'case-id' { $summary.cases[2].request_id='other' }
        'proof' { $summary.cases[0].native_proof.cgroup_empty='true' }
        'time-type' { $summary.cases[1].stop_elapsed_seconds=$false }
        'time-bound' { $summary.cases[1].trigger_to_observation_seconds=0.1 }
    }
    $output.stdout=$summary|ConvertTo-Json -Compress -Depth 20
    Denies { Assert-M2FaultBatchOutput $output } "closed summary $change rejected"
}
Denies { Assert-M2FaultFiniteNumber ([double]::NaN) 0 0.1 } 'NaN rejected'
Denies { Assert-M2FaultFiniteNumber ([double]::PositiveInfinity) 0 ([double]::PositiveInfinity) } 'infinity rejected'
foreach($stderr in @($validAudit,'malformed trusted audit')) {
    # Real harmless fixed Python child prints summary+audit, never imports or starts the bridge.
    $stdout64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($validSummary))
    $stderr64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($stderr))
    $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$script:HarmlessTestPython; $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $code="import base64,sys; sys.stdout.write(base64.b64decode('$stdout64').decode()); sys.stderr.write(base64.b64decode('$stderr64').decode()); sys.exit(0)"
    foreach($argument in @('-B','-I','-S','-c',$code)) { $psi.ArgumentList.Add($argument) }
    $child=[Diagnostics.Process]::new(); $child.StartInfo=$psi
    try {
        Assert ($child.Start()) 'real summary/audit harmless child starts'
        $observed=Wait-M2FaultProcess $child
        Assert ($observed.bridge_status -eq 'BRIDGE_EXITED_ZERO' -and $observed.bridge_exit_code -is [int] -and $observed.bridge_exit_code -eq 0) 'stderr audit does not turn numeric zero into process failure'
        if($stderr -ceq $validAudit) {
            Assert ((Assert-M2FaultBatchOutput $observed).batch_status -eq 'OBSERVATIONS_COMPLETE') 'real child summary plus trusted stderr succeeds'
            Assert ($observed.host_audit.host_events[1].action -eq 'actual-socket-close' -and $observed.execution_state -eq 'UNKNOWN') 'audit retained, transport does not claim guest STOPPED'
        } else { Denies { Assert-M2FaultBatchOutput $observed } 'real child malformed stderr denied after numeric zero' }
    } finally { $child.Dispose() }
}
Denies { ConvertFrom-M2FaultJson ([Text.Encoding]::UTF8.GetBytes('{"a":1,"a":2}')) } 'duplicate JSON denied'
Denies { ConvertFrom-M2FaultJson ([Text.Encoding]::UTF8.GetBytes('{"a":{"b":1,"b":2}}')) } 'nested duplicate JSON denied'
$profile=New-M2FaultProfile ('a'*64); Assert-M2FaultProfile $profile ('a'*64); $script:checks++
$profile['role']='Agent'; Denies { Assert-M2FaultProfile $profile ('a'*64) } 'profile role injection denied'
$profile=New-M2FaultProfile ('a'*64); $profile.request_ids.timeout='other'; Denies { Assert-M2FaultProfile $profile ('a'*64) } 'request ID immutable'
foreach($name in @('Install-M2FaultHost','Invoke-M2FaultHost','Remove-M2FaultHost')) {
    $parameters=(Get-Command $name).Parameters
    foreach($forbidden in @('Command','Role','Root','AgentMode','VmId','Python')) { Assert (!$parameters.ContainsKey($forbidden)) "$name has no arbitrary $forbidden" }
}
Denies { Install-M2FaultHost -ExactZip 'C:\invalid.zip' -ApprovedSha256 ('a'*64) -RuntimePackage 'C:\invalid-runtime.zip' -ApprovedRuntimePackageSha256 ('c'*64) } 'install denies missing Owner approval before any native operation'
Denies { Invoke-M2FaultHost -ApprovedSha256 ('a'*64) -ApprovedReceiptSha256 ('b'*64) -ApprovedRuntimePackageSha256 ('c'*64) } 'run denies missing Owner approval'
Denies { Remove-M2FaultHost -ApprovedSha256 ('a'*64) -ApprovedReceiptSha256 ('b'*64) -ApprovedRuntimePackageSha256 ('c'*64) } 'cleanup denies missing Owner approval'

# Package bytes: actual ZIP I/O; ACL boundary alone replaced so test never needs elevation.
$originalPrivate=(Get-Command Assert-M2FaultPrivatePath).ScriptBlock
function Assert-M2FaultPrivatePath([string]$Path) { if(!(Test-Path -LiteralPath $Path)) { throw 'TEST_PATH_MISSING' } }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('m2-fault-host-tests-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($testRoot)
function New-TestZip([string]$Name,[string]$Mutation='') {
    $members=@{}; foreach($member in (Get-M2FaultConstants).Members|Where-Object { $_ -ne 'manifest.json' }) { $members[$member]=[Text.Encoding]::UTF8.GetBytes('fixture-'+$member) }
    $hashes=@{}; foreach($member in $members.Keys) { $hashes[$member]=Get-M2FaultHash $members[$member] }
    if($Mutation -eq 'hash') { $hashes['fault_bridge.py']='0'*64 }
    if($Mutation -eq 'open-manifest') { $hashes['unexpected.py']='0'*64 }
    $members['manifest.json']=[Text.Encoding]::UTF8.GetBytes((@{schema='m2-a-fault-package-v1';files=$hashes}|ConvertTo-Json -Depth 5))
    if($Mutation -eq 'extra') { $members['../escape.py']=[byte[]]@(1) }
    if($Mutation -eq 'missing') { $members.Remove('management.py') }
    $path=Join-Path $testRoot $Name; $stream=[IO.File]::Create($path); $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
    try {
        foreach($member in $members.Keys) {
            $entry=$zip.CreateEntry($member); $entry.ExternalAttributes=[int]0x81240000
            if($Mutation -eq 'symlink' -and $member -eq 'fault_bridge.py') { $entry.ExternalAttributes=[int]0xA1FF0000 }
            $writer=$entry.Open(); try { $writer.Write($members[$member],0,$members[$member].Length) } finally { $writer.Dispose() }
        }
        if($Mutation -eq 'duplicate') { $entry=$zip.CreateEntry('fault_bridge.py'); $entry.ExternalAttributes=[int]0x81240000; $writer=$entry.Open(); $writer.Dispose() }
    } finally { $zip.Dispose(); $stream.Dispose() }
    @{path=$path;sha=Get-M2FaultHash ([IO.File]::ReadAllBytes($path))}
}
try {
    $package=New-TestZip 'valid.zip'; $validated=Read-M2FaultPackage $package.path $package.sha
    Assert ($validated.Payload.Count -eq 9) 'actual closed nine-member package accepted'
    Assert ((Get-M2FaultHash $validated.Payload['fault_bridge.py']) -eq $validated.Manifest.files['fault_bridge.py']) 'extracted bytes equal approved snapshot member'
    Denies { Read-M2FaultPackage $package.path ('0'*64) } 'exact ZIP approval mismatch denied'
    foreach($mutation in @('hash','open-manifest','extra','missing','symlink','duplicate')) {
        $package=New-TestZip ($mutation+'.zip') $mutation
        Denies { Read-M2FaultPackage $package.path $package.sha } "package $mutation rejected"
    }
} finally {
    Set-Item Function:Assert-M2FaultPrivatePath $originalPrivate
    $resolved=[IO.Path]::GetFullPath($testRoot); $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if(!$resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'm2-fault-host-tests-*') { throw 'TEST_CLEANUP_PATH_INVALID' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

# Deterministic window bindings; native entry points are never called.
$binding=@{hwnd=111;pid=222;process_name='vmconnect';process_start_utc=123456;session_id=1;desktop='Default';title='m2-isolation-probe on DESK-W-591 - Virtual Machine Connection'}
$script:observation=$binding.Clone(); $script:observation.foreground_hwnd=111; $script:observation.foreground_pid=222
$observe={param($hwnd) $script:observation.Clone()}; $script:sets=0
$direct={param($hwnd) $script:sets++; $script:observation.foreground_hwnd=111; $script:observation.foreground_pid=222; $true}
$focus=Set-M2FaultBoundForeground $binding $observe $direct
Assert (!$focus.direct_set_called -and $script:sets -eq 0) 'already foreground skips SetForegroundWindow'
$script:observation.foreground_hwnd=999; $script:observation.foreground_pid=998
$focus=Set-M2FaultBoundForeground $binding $observe $direct
Assert ($focus.direct_set_called -and $focus.direct_set_return -and $script:sets -eq 1) 'exactly one directSet plus actual foreground observation'
$script:observation.foreground_hwnd=999; $script:observation.foreground_pid=998
$failedSet={param($hwnd) $script:sets++; $false}
Denies { Set-M2FaultBoundForeground $binding $observe $failedSet } 'failed foreground observation aborts'
Assert ($script:sets -eq 2) 'failed focus never loops or steals focus'
$script:observation.foreground_hwnd=111; $script:observation.foreground_pid=222
foreach($key in @('hwnd','pid','process_start_utc','session_id','desktop','title','process_name')) {
    $changed=$script:observation.Clone(); $changed[$key]=if($changed[$key] -is [string]){'changed'}else{777}
    Denies { Assert-M2FaultWindowBinding $binding $changed -RequireForeground } "$key change invalidates window binding"
}
$screenshot=@{bytes=[byte[]]@(1,2,3);captured_utc=[DateTime]::UtcNow.ToString('o');binding=$binding.Clone()}
$confirmation=@{approved=$true;screenshot_sha256=Get-M2FaultHash $screenshot.bytes;captured_utc=$screenshot.captured_utc;binding=$binding.Clone()}
Assert-M2FaultRootConfirmation $binding $script:observation $screenshot $confirmation; $script:checks++
$confirmation.screenshot_sha256='0'*64; Denies { Assert-M2FaultRootConfirmation $binding $script:observation $screenshot $confirmation } 'root confirmation tied to actual screenshot bytes'
$confirmation.screenshot_sha256=Get-M2FaultHash $screenshot.bytes
$old=$screenshot.captured_utc; $screenshot.captured_utc=[DateTime]::UtcNow.AddSeconds(-40).ToString('o'); $confirmation.captured_utc=$screenshot.captured_utc
Denies { Assert-M2FaultRootConfirmation $binding $script:observation $screenshot $confirmation } 'stale root screenshot denied'
$screenshot.captured_utc=$old; $confirmation.captured_utc=$old
$confirmation.approved=$false; Denies { Assert-M2FaultRootConfirmation $binding $script:observation $screenshot $confirmation } 'title alone cannot authorize root'
$confirmation.approved=$true; $script:keys=[Collections.Generic.List[string]]::new()
$send={param($key) $script:keys.Add($key)}
Send-M2FaultFixedGuestCommand -Binding $binding -Screenshot $screenshot -OwnerConfirmation $confirmation -Observe $observe -SendKey $send -Summarize
Assert (($script:keys -join '') -ceq ((Get-M2FaultConstants).GuestSummary+'{ENTER}')) 'only fixed readonly guest summary sent'
$script:keys.Clear(); $lost={param($key) $script:keys.Add($key); $script:observation.foreground_hwnd=999 }
Denies { Send-M2FaultFixedGuestCommand -Binding $binding -Screenshot $screenshot -OwnerConfirmation $confirmation -Observe $observe -SendKey $lost } 'focus stolen after key halts before next key'
Assert ($script:keys.Count -eq 1) 'no blind second key after focus loss'
# Same foreground identity stays valid while root confirmation expires during typing.
$script:observation.foreground_hwnd=111
$originalClock=(Get-Command Get-M2FaultUtcNow).ScriptBlock
$script:clock=[DateTimeOffset]::Parse($screenshot.captured_utc)
function Get-M2FaultUtcNow { $script:clock }
try {
    foreach($expireAfter in @(3,(Get-M2FaultConstants).GuestSummary.Length)) {
        $script:keys.Clear(); $script:clock=[DateTimeOffset]::Parse($screenshot.captured_utc); $script:expireAfter=$expireAfter
        $expireDuringTyping={param($key) $script:keys.Add($key); if($script:keys.Count -eq $script:expireAfter) { $script:clock=$script:clock.AddSeconds(31) } }
        Denies { Send-M2FaultFixedGuestCommand -Binding $binding -Screenshot $screenshot -OwnerConfirmation $confirmation -Observe $observe -SendKey $expireDuringTyping -Summarize } 'root confirmation expiring during typing aborts'
        Assert ($script:keys.Count -eq $expireAfter -and !$script:keys.Contains('{ENTER}')) 'no next key or Enter after root confirmation expires'
        Assert ($script:observation.hwnd -eq 111 -and $script:observation.foreground_hwnd -eq 111 -and $script:observation.foreground_pid -eq 222) 'expiry denied despite unchanged window/foreground binding'
    }
} finally { Set-Item Function:Get-M2FaultUtcNow $originalClock }
# Cleanup all-or-deny and post-failure single-delete behavior, entirely mocked.
$savedFunctions=@{}
foreach($name in @('Assert-M2FaultOwner','Assert-M2FaultVm','Read-M2FaultReceipt','Add-M2FaultAudit','Remove-Item','Remove-M2FaultRuntimeDirectory','Test-Path','Get-Acl')) { $command=Get-Command $name; $savedFunctions[$name]=if($command.CommandType -eq 'Function'){$command.ScriptBlock}else{$null} }
$script:deletes=[Collections.Generic.List[string]]::new(); $script:auditEvents=[Collections.Generic.List[string]]::new()
$script:receiptError=$true; $script:postPresent=$false
$c=Get-M2FaultConstants
$script:cleanupReceipt=@{stage='retained-stage';files=@(@{path=(Join-Path $c.Root 'fault_bridge.py')},@{path=(Join-Path $c.Root 'fault-profile.json')},@{path=(Join-Path $c.Root 'runtime-manifest.json')});runtime_files=@(foreach($name in Get-M2FaultRuntimeMembers){@{path=(Join-Path $c.Runtime $name)}});runtime_directory=@{path=$c.Runtime};guid=@{path=$c.RegistryParent+'\'+$c.ServiceId};registry_parent_dacl='unchanged'}
function Assert-M2FaultOwner { param([switch]$OwnerApproved) }
function Assert-M2FaultVm { @{Id=(Get-M2FaultConstants).VmId} }
function Read-M2FaultReceipt { param($ApprovedSha256,$ApprovedReceiptSha256,$ApprovedRuntimePackageSha256) if($script:receiptError){throw 'FILE_IDENTITY_CHANGED'}; $script:cleanupReceipt }
function Add-M2FaultAudit { param($Stage,$Record) $script:auditEvents.Add($Record.event) }
function Remove-Item { param($LiteralPath,[switch]$Force,$ErrorAction) $script:deletes.Add($LiteralPath) }
function Remove-M2FaultRuntimeDirectory { $script:deletes.Add((Get-M2FaultConstants).Runtime) }
function Test-Path { param($LiteralPath) $script:postPresent }
function Get-Acl { param($LiteralPath) [pscustomobject]@{Sddl='unchanged'} }
try {
    Denies { Remove-M2FaultHost -ApprovedSha256 ('a'*64) -ApprovedReceiptSha256 ('b'*64) -ApprovedRuntimePackageSha256 ('c'*64) -OwnerApproved } 'any identity preassert failure prevents deletion'
    Assert ($script:deletes.Count -eq 0 -and $script:auditEvents.Count -eq 0) 'all targets validated before first delete'
    $script:receiptError=$false; $script:postPresent=$true
    Denies { Remove-M2FaultHost -ApprovedSha256 ('a'*64) -ApprovedReceiptSha256 ('b'*64) -ApprovedRuntimePackageSha256 ('c'*64) -OwnerApproved } 'independent read postassert failure reported'
    Assert ($script:deletes.Count -eq 42) 'exactly 3 host files +37 runtime files +1 empty runtime directory +1 GUID, no postassert retry'
    Assert (!$script:deletes.Contains('retained-stage')) 'stage receipt and audit retained'
    $script:deletes.Clear(); $script:auditEvents.Clear(); $script:postPresent=$false
    $clean=Remove-M2FaultHost -ApprovedSha256 ('a'*64) -ApprovedReceiptSha256 ('b'*64) -ApprovedRuntimePackageSha256 ('c'*64) -OwnerApproved
    Assert ($clean.status -eq 'CLEANUP_READ_POST_CONFIRMED' -and !$clean.dvd_changed) 'independent read post success, existing DVD untouched'
    Assert ($script:deletes.Count -eq 42 -and $script:auditEvents[-1] -eq 'cleanup-read-post-confirmed') 'cleanup audit appended after post confirmation'
} finally {
    foreach($name in $savedFunctions.Keys) { if($savedFunctions[$name]){Set-Item ("Function:"+$name) $savedFunctions[$name]}else{Microsoft.PowerShell.Management\Remove-Item ("Function:"+$name)} }
}
"PASS: $script:checks checks; harmless fixed Python exit 0/nonzero, mocked lifecycle/focus, actual ZIP validation; zero VM/registry/window operations."
