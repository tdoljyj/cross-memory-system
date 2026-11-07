<#
.SYNOPSIS
  The Windows execution face of the in-place upgrade channel (018da927 B2; DRAFT). FROZEN with the channel.

.DESCRIPTION
  Installed by install-resident.ps1 at C:\ProgramData\CluedIndependentCI\resident\upgrader\<upgrader manifest SHA-256>\windows\ and run
  only from there, by the CluedCIUpgrader service (LocalSystem; upgrader/src/windows-port.mjs). It changes only with a full reinstall: a
  package that changes it, the compile recipe, the layout, an ACL or the protocol is refused by the upgrader
  (UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL), and a rollback is always executed by this same frozen copy.

  It takes no path and no command string. Every action reads the op's white-listed plan (upgrader/src/plan.mjs),
  upgrade\ops\<OpId>\010-accept.plan.json, and only if its SHA-256 equals -PlanSha256. What it touches is derived from that plan, from
  the staged package (upgrade\staged\<pkg>\package-manifest.json, by the plan's package hash), from the generation records
  generations\g<N>\generation.json and from fixed names. Each action prints ONE line of JSON (contract
  clued.independent-ci.upgrade-apply-result/1: ok, code and the action's own fields at the top level) and exits
    0  done (or found already done: replayed),
    2  refused before any side effect (input, plan, generation record, live files not those of the generation, verify failed),
    1  failed after a side effect may have happened: the caller re-observes (ReadScm) before it retries or rolls back.

    -Action ReadScm               resident, broker, upgrader and runner services ({ exists, state: running | stopped | ..., processId,
                                  binPath }; runner adds originalBinary) and companionTask ({ exists, path, arguments, state }), each
                                  matched against the from and to generations (from | to | neither).
    -Action Compile               the two service hosts, the generic helper and the companion job host with exactly the install recipe
                                  (Invoke-CompileRecipe, the same function as install-resident.ps1), from the staged or content-addressed
                                  sources whose hashes the staged package manifest gives, and the broker configuration: all into
                                  upgrade\staged\<pkg>\compiled\{bin,helpers,config} (each created with the live directory's DACL);
                                  compiled\compile.json last, create-only. Run again: re-observed (replayed); an earlier op's compiled\
                                  (a rolled-back op of the same package) is set aside by rename and compiled again.
    -Action StopServices          stops the resident, waits until its executor has exited by itself (never killed), then the broker.
    -Action SwitchScm -Generation N       both binary paths of generation N, read back. N = the plan's toGeneration: from the plan and
                                  compile.json (generations\g<N>\generation.json, once written, must agree); N = fromGeneration: from its
                                  generation record. The files the command lines pin must already be in place. First, generation N's
                                  resident\<sha> and source\<sha> get their live parent's inheritance back (Repair-GenerationContentAcl: a
                                  rename out of upgrade\staged keeps the staged ACEs); the result carries contentAcl { repaired, resident, source }.
    -Action WriteCompanionLaunch -Generation N   M5 (DESIGN.md section 65.4.4): generation N's config\companion-launch.json, replaced
                                  atomically, and the notifier task registered again for N. The companion task itself is NEVER
                                  registered here (it may hold the Owner's password, which this channel does not have): a task whose
                                  definition is neither the password one nor the interactive one is reported (companionTask.needsOwner,
                                  COMPANION_TASK_NEEDS_OWNER) and the upgrade goes on.
    -Action RestartCompanion      ends the companion's node and job hosts of the installed copy (not the task: the supervisor starts the
                                  generation the launch file names at once), runs the task only when no supervisor runs, and waits up to
                                  90 s for the new companion.
    -Action StartServices         starts the broker, then the resident.
    -Action Verify -Generation N [-ExpectPausedSha256 <sha>]   runs generation N's installed verify-resident.ps1 against the receipt
                                  upgrade\current.json names (N must be current), once its hash is the one generation N's
                                  config\resident-installed-manifest.json (the plan's slot hash) pins.

    -Recover -OpId <id> [-Apply]  the Owner's emergency entry (scheme C), elevated: dry run by default. -Apply stops the upgrader, the
                                  resident (waiting for its executor) and the broker, then points both binary paths and the companion
                                  launch file at the generation upgrade\current.json names, if its files are in place, and starts nothing.
                                  The resident stays paused; what was done is written to upgrade\ops\<OpId>\recover-<UTC>.json.
#>
[CmdletBinding()]
param(
  [ValidateSet('ReadScm', 'Compile', 'StopServices', 'SwitchScm', 'WriteCompanionLaunch', 'RestartCompanion', 'StartServices', 'Verify')][string]$Action,
  [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$OpId,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$PlanSha256,
  [ValidateRange(1, 999999)][int]$Generation,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectPausedSha256,
  [switch]$Recover,
  [switch]$Apply
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'

$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$InstalledCopy = '^C:\\ProgramData\\CluedIndependentCI\\resident\\upgrader\\[0-9a-f]{64}\\windows\\upgrade-apply\.ps1\z'
$ResultContract = 'clued.independent-ci.upgrade-apply-result/1'
$PlanContract = 'clued.independent-ci.resident-upgrade-plan/1'
$CompileContract = 'clued.independent-ci.upgrade-compile/1'
$ServiceName = 'CluedCIResident'
$BrokerName = 'CluedCISwapBroker'
$UpgraderName = 'CluedCIUpgrader'
$TaskName = 'CluedCIResidentCompanion'
$PowerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$OriginalBinary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'
$Sc = 'C:\Windows\System32\sc.exe'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$GenericHelper = 'controller-formal-generic-v2.exe'
$CompanionJobHost = 'CluedCompanionJobHost.exe'
$SourceV2Windows = 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'
$SourceV2Files = @('ResidentScmV2.cs', 'ScmPidHandshakeV2.cs', 'NodeProfileV2.cs', 'FormalPublicBoundaryV2.cs', 'FormalSession0V2.cs')
# The plan's slots (upgrader/src/plan.mjs PACKAGE_SLOTS, GENERATED_SLOTS, RECEIPT_SLOT): exactly these, nothing else.
$PackageSlots = @('config\policy.json', 'config\companion.json', 'config\resident-installed-manifest.json', 'config\source-installed-manifest.json',
  'record\installation.json', 'record\acceptance.json', 'record\source-manifest.json', 'record\signers.json', 'record\record-manifest.json',
  'bin\ResidentServiceHost.cs', 'bin\SwapBroker.cs', 'runtime\node.exe')
$GeneratedSlots = @('bin\ResidentServiceHost.exe', 'bin\SwapBroker.exe', 'bin\CluedCompanionJobHost.exe', 'helpers\controller-formal-generic-v2.exe', 'config\broker.json')
$ReceiptSlot = 'install\install-receipt.json'
$script:Touched = $false

# ---- Shared with install-resident.ps1 (test-upgrade-windows.ps1 holds the copies identical) ----
function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Sha256Text([string]$t) { Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($t)) }
function Sha256File([string]$p) { Sha256Bytes ([IO.File]::ReadAllBytes($p)) }
function Invoke-Sc([string]$failureCode, [string[]]$scArgs) {
  $out = & $Sc @scArgs | Out-String
  if ($LASTEXITCODE -ne 0) { throw ($failureCode + ':' + $LASTEXITCODE) }
  $out
}
function Get-DaclPart([string]$sd) { $t = ([string]$sd).Trim(); $i = $t.IndexOf('D:'); if ($i -lt 0) { return $t }; $t = $t.Substring($i); $j = $t.IndexOf('S:'); if ($j -ge 0) { $t = $t.Substring(0, $j) }; $t }
function Assert-ServiceBinary([string]$name, [string]$want) {
  $qc = Invoke-Sc 'SERVICE_QC_FAILED' @('qc', $name, '8192')
  $have = if ($qc -match 'BINARY_PATH_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  if ($have -cne $want) { throw ('SERVICE_BINARY_PATH_READBACK_MISMATCH:' + $name) }
}
function Write-New([string]$path, [byte[]]$bytes) {
  $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}
$NodeProfileKeys = @('contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'controllerSid', 'runnerService', 'mutationMutex', 'wslDistribution')
function Assert-NodeProfile($n) {
  $names = @(if ($n -is [pscustomobject]) { $n.PSObject.Properties.Name })
  if ($names.Count -ne $NodeProfileKeys.Count -or @($NodeProfileKeys | Where-Object { $names -cnotcontains $_ -or $n.$_ -isnot [string] }).Count -ne 0 -or
    $n.contract -cne 'clued.independent-ci.node-profile/1') { throw 'NODE_PROFILE_FIELDS_REQUIRED' }
  $sid = '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-([0-9]{1,10})\z'
  $rid = if ($n.controllerSid -cmatch $sid) { $Matches[1] } else { $null }
  if ($n.nodeName -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z' -or
    $n.hostname -cnotmatch '^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?\z' -or $n.ownerSid -cnotmatch $sid -or $null -eq $rid -or [long]$rid -lt 1000 -or $n.ownerSid -ceq $n.controllerSid -or
    $n.ownerProfileDirectory -cnotmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z' -or
    $n.runnerService -cnotmatch '^actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\z' -or
    $n.mutationMutex -cne ('Global\CluedControlControllerMutationV1-' + $n.hostname + '-' + $rid) -or
    $n.wslDistribution -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z') { throw 'NODE_PROFILE_INVALID' }
}
function ConvertTo-NodeProfileCanonical($n) {
  Assert-NodeProfile $n
  [string[]]$keys=$NodeProfileKeys.Clone();[Array]::Sort($keys,[StringComparer]::Ordinal)
  $rows=@(foreach($key in $keys) { ($key | ConvertTo-Json -Compress)+':'+($n.$key | ConvertTo-Json -Compress) })
  return '{'+($rows -join ',')+'}'
}
# The two service command lines (install-resident.ps1 step 'services'; the generation records hold exactly these strings).
function Get-ResidentBinPath([string]$root, [string]$policySha, [string]$nodeSha, [string]$residentSha, [string]$entrySha) {
  '"' + (Join-Path $root 'bin\ResidentServiceHost.exe') + '" "' + $root + '" ' + $policySha + ' "' + (Join-Path $root 'runtime\node.exe') + '" ' + $nodeSha + ' "' + (Join-Path $root ('resident\' + $residentSha + '\src\service-main.mjs')) + '" ' + $entrySha
}
function Get-BrokerBinPath([string]$root, [string]$brokerConfigSha, [string]$nodeProfileSha) {
  '"' + (Join-Path $root 'bin\SwapBroker.exe') + '" "' + $root + '" ' + $brokerConfigSha + ' ' + $nodeProfileSha
}
# Config /3 of the broker (install-resident.ps1 step 'broker-config').
function Get-BrokerConfigJson([string]$helperSha, [string]$stable, [string]$nodeCanonical, [string]$nodeProfileSha, [string]$acceptanceSha) {
  '{"contract":"clued.independent-ci.swap-broker-config/3","helper":{"name":"' + $GenericHelper + '","sha256":"' + $helperSha + '"},"originalBinary":' + ($OriginalBinary | ConvertTo-Json -Compress) + ',"stableDigest":"' + $stable + '","node":' + $nodeCanonical + ',"nodeProfileSha256":"' + $nodeProfileSha + '","acceptanceSha256":"' + $acceptanceSha + '"}'
}
# The compile recipe (install-resident.ps1 step 'service-hosts'): the two service hosts and the companion job host into $binOut, the ONE
# generic helper into $helpersOut, with the in-box compiler, full reference paths and the caller's directory never used. Returns the hashes.
function Invoke-CompileRecipe([string]$compiler, [string]$fw, [string]$binOut, [string]$helpersOut, [string]$residentHostCs, [string]$brokerCs, [string]$v2, [string]$jobHostCs) {
  $hashes = [ordered]@{}
  Push-Location $binOut
  try {
    foreach ($pair in @(@('ResidentServiceHost', @("/reference:$($fw)System.dll", "/reference:$($fw)System.ServiceProcess.dll"), $residentHostCs, @()),
                        @('SwapBroker', @("/reference:$($fw)System.dll", "/reference:$($fw)System.Core.dll", "/reference:$($fw)System.ServiceProcess.dll", "/reference:$($fw)System.Web.Extensions.dll"), $brokerCs,
                          @((Join-Path $v2 'ResidentScmV2.cs'), (Join-Path $v2 'ScmPidHandshakeV2.cs'), (Join-Path $v2 'NodeProfileV2.cs'))))) {
      $exe = Join-Path $binOut ($pair[0] + '.exe')
      & $compiler /nologo /noconfig /target:exe /optimize+ ("/out:" + $exe) $pair[1] $pair[2] $pair[3] | Out-Null
      if ($LASTEXITCODE -ne 0) { throw ('SERVICE_HOST_COMPILE_FAILED:' + $pair[0]) }
      $hashes[($pair[0] + 'Sha256')] = Sha256File $exe
    }
    $helper = Join-Path $helpersOut $GenericHelper
    & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ /main:CluedWindowsFormalEntryV2 "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $helper) (Join-Path $v2 'FormalPublicBoundaryV2.cs') (Join-Path $v2 'FormalSession0V2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') (Join-Path $v2 'NodeProfileV2.cs') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GENERIC_HELPER_COMPILE_FAILED' }
    $hashes.genericHelperSha256 = Sha256File $helper
    # The companion's job host (DESIGN §24), with the generic helper's flags (winexe: never a console window of its own).
    $jobHost = Join-Path $binOut $CompanionJobHost
    & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" ("/out:" + $jobHost) $jobHostCs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'COMPANION_JOB_HOST_COMPILE_FAILED' }
    $hashes.companionJobHostSha256 = Sha256File $jobHost
  } finally { Pop-Location }
  $hashes
}
# ---- Shared with install-resident.ps1 and upgrade-apply.ps1 (test-companion-headless.ps1 holds the copies identical) ----
# The companion task's fixed action (DESIGN 65.4.2): the supervisor, with the root and nothing else.
function Get-SupervisorAction([string]$root) { [ordered]@{ path = (Join-Path $root 'bin\CluedCompanionSupervisor.exe'); arguments = ('"' + $root + '"') } }
# The task's protection: SYSTEM and Administrators full, the Owner read only (DESIGN 65.4.1).
function Get-CompanionTaskSddl([string]$ownerSid) { "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;$ownerSid)" }
# The companion child's arguments after node.exe, as the supervisor builds them (CompanionSupervisor.cs CommandLine); the generation
# records keep this string as companionTaskArguments.
function Get-CompanionLaunchArguments([string]$root, [string]$residentSha, [string]$configSha) {
  '"' + (Join-Path $root ('resident\' + $residentSha + '\src\companion-main.mjs')) + '" --root "' + $root + '" --config-sha256 ' + $configSha
}
# The companion's own gh login (Owner decision): <profile>\AppData\Local\CluedIndependentCI\companion-gh\{gh,home}.
function Get-CompanionGhDirs([string]$profileDir) {
  $base = Join-Path $profileDir 'AppData\Local\CluedIndependentCI\companion-gh'
  [ordered]@{ base = $base; gh = (Join-Path $base 'gh'); home = (Join-Path $base 'home') }
}
# The directories the child's PATH adds to the system ones: gh's (companion.json ghExe) and Git for Windows' cmd (build-bundle.ps1 $Git).
function Get-CompanionPathDirs([string]$ghExe) { @((Split-Path -Parent $ghExe), 'C:\Program Files\Git\cmd') }
# config\companion-launch.json, the one input of the supervisor (contract clued.independent-ci.companion-launch/1), keys in this order.
function Get-CompanionLaunchJson([string]$root, [int]$generation, [string]$nodeSha, [string]$residentSha, [string]$entrySha, [string]$configSha, [string]$profileDir, [string[]]$pathDirs) {
  foreach ($h in @($nodeSha, $residentSha, $entrySha, $configSha)) { if ($h -cnotmatch '^[0-9a-f]{64}\z') { throw 'COMPANION_LAUNCH_HASH_REFUSED' } }
  if ($generation -lt 1) { throw 'COMPANION_LAUNCH_GENERATION_REFUSED' }
  $gh = Get-CompanionGhDirs $profileDir
  $q = { param([string]$s) ConvertTo-Json -InputObject $s -Compress }
  '{"contract":' + (& $q 'clued.independent-ci.companion-launch/1') + ',"generation":' + $generation + ',"nodeExe":' + (& $q (Join-Path $root 'runtime\node.exe')) +
  ',"nodeExeSha256":"' + $nodeSha + '","entry":' + (& $q (Join-Path $root ('resident\' + $residentSha + '\src\companion-main.mjs'))) + ',"entrySha256":"' + $entrySha +
  '","configSha256":"' + $configSha + '","ghConfigDir":' + (& $q $gh.gh) + ',"homeDir":' + (& $q $gh.home) + ',"pathDirs":[' + ((@($pathDirs) | ForEach-Object { & $q $_ }) -join ',') + ']}'
}
# Atomic replace in config\ (the temporary file inherits config\'s DACL; ReplaceFile keeps the replaced file's): a reader sees the old
# file or the new one, never a part. Returns the SHA-256 of the bytes written.
function Write-CompanionLaunch([string]$root, [string]$json) {
  $dest = Join-Path $root 'config\companion-launch.json'
  $tmp = $dest + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
  $f = New-Object IO.FileStream($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
  if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($tmp, $dest, [NullString]::Value) } else { [IO.File]::Move($tmp, $dest) }
  $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
}
# The notifier task (DESIGN 65.4.3): the Owner's interactive token, not elevated, at log-on, one instance; no password, so the upgrade
# channel registers it again for every generation.
function Get-NotifierAction([string]$root, [string]$residentSha) {
  [ordered]@{ path = 'C:\Windows\System32\conhost.exe'
    arguments = '--headless "' + (Join-Path $root 'runtime\node.exe') + '" "' + (Join-Path $root ('resident\' + $residentSha + '\src\notifier-main.mjs')) + '" --root "' + $root + '"' }
}
function Register-NotifierTask([string]$root, [string]$ownerSid, [string]$residentSha) {
  $ca = Get-NotifierAction $root $residentSha
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = try { $svc.GetFolder('\Clued') } catch { $svc.GetFolder('\').CreateFolder('Clued') }
  $def = $svc.NewTask(0)
  $def.Principal.UserId = $ownerSid; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $t = $def.Triggers.Create(9); $t.UserId = $ownerSid
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT0S'; $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $def.Settings.RestartCount = 3; $def.Settings.RestartInterval = 'PT1M'
  $a = $def.Actions.Create(0); $a.Path = $ca.path; $a.Arguments = $ca.arguments
  $null = $folder.RegisterTaskDefinition('CluedCIResidentNotifier', $def, 6, $null, $null, 3, "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$ownerSid)")
  $t = $folder.GetTask('CluedCIResidentNotifier')
  $act = if ($t.Definition.Actions.Count -eq 1) { $t.Definition.Actions.Item(1) } else { $null }
  if (($t.Definition.Principal.RunLevel -ne 0) -or $null -eq $act -or $act.Path -cne $ca.path -or $act.Arguments -cne $ca.arguments) { throw 'NOTIFIER_TASK_READBACK_MISMATCH' }
  $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t.Xml)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
}
# What the companion task is now: mode 'password' (DESIGN 65.4.1, exactly), 'interactive' (the install's first registration or the
# fall-back, exactly), 'other' (anything else: problems names what differs), or absent. Read-only; the Owner can read it (FR).
function Get-CompanionTaskFacts([string]$root, [string]$ownerSid) {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $task = try { $svc.GetFolder('\Clued').GetTask('CluedCIResidentCompanion') } catch { $null }
  if ($null -eq $task) { return [ordered]@{ exists = $false; mode = 'absent'; problems = @('absent'); state = $null; lastTaskResult = $null; logonType = $null; xmlSha256 = $null } }
  $d = $task.Definition; $p = @()
  $uid = [string]$d.Principal.UserId
  $uidSid = try { if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { $null }
  if ($uidSid -cne $ownerSid) { $p += 'principal' }
  if ($d.Principal.RunLevel -ne 0) { $p += 'run-level' }
  $ca = Get-SupervisorAction $root
  $act = if ($d.Actions.Count -eq 1) { $d.Actions.Item(1) } else { $null }
  if ($null -eq $act -or [string]$act.Path -cne $ca.path -or [string]$act.Arguments -cne $ca.arguments) { $p += 'action' }
  $sd = try { [string]$task.GetSecurityDescriptor(4) } catch { $null }   # DACL_SECURITY_INFORMATION
  $dacl = if ($sd) { $i = $sd.IndexOf('D:'); if ($i -ge 0) { $sd.Substring($i) } else { $sd } } else { $null }
  if ($dacl -cne (Get-CompanionTaskSddl $ownerSid)) { $p += 'sddl' }
  $sdOwner = try { $o = [string]$task.GetSecurityDescriptor(1); if ($o -match '^O:([A-Z]{2}|S-1-[0-9-]+)') { $Matches[1] } else { $null } } catch { $null }   # OWNER_SECURITY_INFORMATION: a fact
  if ($d.Settings.MultipleInstances -ne 2) { $p += 'multiple-instances' }
  if ([string]$d.Settings.ExecutionTimeLimit -cne 'PT0S') { $p += 'time-limit' }
  if ($d.Settings.DisallowStartIfOnBatteries -or $d.Settings.StopIfGoingOnBatteries) { $p += 'batteries' }
  if ($d.Settings.RestartCount -ne 0) { $p += 'restart-on-failure' }
  $triggers = @(foreach ($t in $d.Triggers) { $t })
  $types = @($triggers | ForEach-Object { [int]$_.Type }) | Sort-Object
  $mode = 'other'
  if ($d.Principal.LogonType -eq 1) {
    $boot = @($triggers | Where-Object { $_.Type -eq 8 }); $time = @($triggers | Where-Object { $_.Type -eq 1 })
    $ok = ($types -join ',') -ceq '1,8' -and [string]$boot[0].Delay -ceq 'PT30S' -and [string]$time[0].Repetition.Interval -ceq 'PT15M' -and [string]$time[0].Repetition.Duration -ceq '' -and $d.Settings.StartWhenAvailable
    if (-not $ok) { $p += 'triggers' }
    if ($p.Count -eq 0) { $mode = 'password' }
  } elseif ($d.Principal.LogonType -eq 3) {
    if (($types -join ',') -cne '9') { $p += 'triggers' }
    if ($p.Count -eq 0) { $mode = 'interactive' }
  } else { $p += 'logon-type' }
  $s = [Security.Cryptography.SHA256]::Create()
  $xmlSha = try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$task.Xml)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
  [ordered]@{ exists = $true; mode = $mode; problems = $p; state = [int]$task.State; lastTaskResult = ([int64]$task.LastTaskResult -band 0xFFFFFFFFL); logonType = [int]$d.Principal.LogonType; xmlSha256 = $xmlSha; sdOwner = $sdOwner }
}

# ---- Own helpers ----
function Get-Field($o, [string]$k) { if (($o -is [pscustomobject]) -and (@($o.PSObject.Properties.Name) -ccontains $k)) { $o.$k } else { $null } }
function Test-Int($v) { ($v -is [int]) -or ($v -is [long]) }
function Test-Hex($v) { ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
# The command lines back to their parts; $null for anything that is not exactly the formula (round trip through the formula).
function ConvertFrom-ResidentBinPath([string]$root, [string]$binPath) {
  $e = [regex]::Escape($root)
  if ($binPath -cnotmatch ('^"' + $e + '\\bin\\ResidentServiceHost\.exe" "' + $e + '" ([0-9a-f]{64}) "' + $e + '\\runtime\\node\.exe" ([0-9a-f]{64}) "' + $e + '\\resident\\([0-9a-f]{64})\\src\\service-main\.mjs" ([0-9a-f]{64})\z')) { return $null }
  $p = [ordered]@{ policySha256 = $Matches[1]; nodeSha256 = $Matches[2]; residentManifestSha256 = $Matches[3]; entrySha256 = $Matches[4] }
  if ((Get-ResidentBinPath $root $p.policySha256 $p.nodeSha256 $p.residentManifestSha256 $p.entrySha256) -cne $binPath) { return $null }
  $p
}
function ConvertFrom-BrokerBinPath([string]$root, [string]$binPath) {
  $e = [regex]::Escape($root)
  if ($binPath -cnotmatch ('^"' + $e + '\\bin\\SwapBroker\.exe" "' + $e + '" ([0-9a-f]{64}) ([0-9a-f]{64})\z')) { return $null }
  $p = [ordered]@{ brokerConfigSha256 = $Matches[1]; nodeProfileSha256 = $Matches[2] }
  if ((Get-BrokerBinPath $root $p.brokerConfigSha256 $p.nodeProfileSha256) -cne $binPath) { return $null }
  $p
}
# M5: the companion's arguments after node.exe (Get-CompanionLaunchArguments), as the generation records keep them.
function ConvertFrom-CompanionArguments([string]$root, [string]$arguments) {
  $e = [regex]::Escape($root)
  if ($arguments -cnotmatch ('^"' + $e + '\\resident\\([0-9a-f]{64})\\src\\companion-main\.mjs" --root "' + $e + '" --config-sha256 ([0-9a-f]{64})\z')) { return $null }
  $p = [ordered]@{ residentManifestSha256 = $Matches[1]; companionConfigSha256 = $Matches[2] }
  if ((Get-CompanionLaunchArguments $root $p.residentManifestSha256 $p.companionConfigSha256) -cne $arguments) { return $null }
  $p
}
# sc queryex: the state in lower case (running, stopped, start_pending, ...), as the upgrader reads it.
function ConvertFrom-ScState([string]$text) {
  $names = @{ 1 = 'stopped'; 2 = 'start_pending'; 3 = 'stop_pending'; 4 = 'running'; 5 = 'continue_pending'; 6 = 'pause_pending'; 7 = 'paused' }
  $state = if ($text -match 'STATE\s*:\s*([0-9]+)') { [int]$Matches[1] } else { 0 }
  $procId = if ($text -match 'PID\s*:\s*([0-9]+)') { [int]$Matches[1] } else { $null }
  [ordered]@{ state = $(if ($names.ContainsKey($state)) { $names[$state] } else { 'unknown' }); processId = $procId }
}
function ConvertFrom-ScBinPath([string]$text) { if ($text -match 'BINARY_PATH_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null } }
# A companion node process of the installed copy: its command line names the installed node.exe, companion-main.mjs and
# --root <root>, whole tokens from the start. conhost --headless starts node with the task's arguments quoted only where
# needed, so on this root (no space) the real command line has no quotes (op 8e3b3e1b, Task 42fe5ae4: the quoted-only
# form matched no companion, the restart never found its new process and the rollback started one more every minute).
# Each path is accepted quoted or bare.
function Test-CompanionCommandLine([string]$commandLine, [string]$root) {
  $e = [regex]::Escape($root)
  $node = $e + '\\runtime\\node\.exe'; $main = $e + '\\resident\\[0-9a-f]{64}\\src\\companion-main\.mjs'
  [string]$commandLine -cmatch ('\A(?:"' + $node + '"|' + $node + ') (?:"' + $main + '"|' + $main + ') --root (?:"' + $e + '"|' + $e + ') --config-sha256 [0-9a-f]{64}\s*\z')
}
# One file, read once: a regular file (no directory, no link), 1..$maximum bytes, unchanged while read.
function Read-SmallFile([string]$path, [int]$maximum, [string]$code) {
  $item = try { Get-Item -LiteralPath $path -Force -ErrorAction Stop } catch { $null }
  if ($null -eq $item) { throw ($code + '_MISSING') }
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw ($code + '_REFUSED') }
  $s = [IO.File]::Open($path, 'Open', 'Read', 'Read')
  try {
    if ($s.Length -lt 1 -or $s.Length -gt $maximum) { throw ($code + '_REFUSED') }
    $bytes = New-Object byte[] ([int]$s.Length); $at = 0
    while ($at -lt $bytes.Length) { $n = $s.Read($bytes, $at, $bytes.Length - $at); if ($n -lt 1) { throw ($code + '_CHANGED') }; $at += $n }
    if ($s.ReadByte() -ne -1) { throw ($code + '_CHANGED') }
  } finally { $s.Dispose() }
  return ,$bytes
}
function ConvertFrom-StrictJson([byte[]]$bytes, [string]$code) {
  try { (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) | ConvertFrom-Json } catch { throw ($code + '_UNREADABLE') }
}
# Every directory from $root (exclusive) down to $dir (inclusive) exists and is no link.
function Assert-NoLinkChain([string]$root, [string]$dir) {
  if (-not $dir.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'PATH_OUTSIDE_ROOT' }
  $c = $root
  foreach ($seg in $dir.Substring($root.Length + 1).Split('\')) {
    $c = Join-Path $c $seg
    $item = try { Get-Item -LiteralPath $c -Force -ErrorAction Stop } catch { $null }
    if ($null -eq $item -or -not $item.PSIsContainer) { throw ('DIRECTORY_MISSING:' + $seg) }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('LINK_REFUSED:' + $seg) }
  }
}
# A package-relative path (package manifest `path`, plan slot `from`): forward slashes, plain names, no "." or "..".
function Test-PackagePath($p) { ($p -is [string]) -and ($p -cmatch '^[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)*\z') -and @($p.Split('/') | Where-Object { $_ -ceq '.' -or $_ -ceq '..' }).Count -eq 0 }

# ---- The plan (upgrader/src/plan.mjs buildPlan; A4 010-accept.plan.json) ----
function Assert-UpgradePlan($p, [string]$opId) {
  if ($p -isnot [pscustomobject]) { throw 'UPGRADE_PLAN_REFUSED:shape' }
  if ((Get-Field $p 'contract') -cne $PlanContract) { throw 'UPGRADE_PLAN_REFUSED:contract' }
  if ((Get-Field $p 'opId') -cne $opId) { throw 'UPGRADE_PLAN_REFUSED:opId' }
  $node = Get-Field $p 'node'
  if ($node -isnot [string] -or $node -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z') { throw 'UPGRADE_PLAN_REFUSED:node' }
  if (-not (Test-Hex (Get-Field $p 'packageManifestSha256'))) { throw 'UPGRADE_PLAN_REFUSED:packageManifestSha256' }
  $from = Get-Field $p 'fromGeneration'; $to = Get-Field $p 'toGeneration'
  if (-not (Test-Int $from) -or -not (Test-Int $to) -or $from -lt 1 -or $to -ne $from + 1) { throw 'UPGRADE_PLAN_REFUSED:generations' }
  $cur = Get-Field $p 'current'
  foreach ($k in @('residentManifestSha256', 'ciSourceManifestSha256', 'policySha256')) { if (-not (Test-Hex (Get-Field $cur $k))) { throw ('UPGRADE_PLAN_REFUSED:current.' + $k) } }
  $t = Get-Field $p 'target'
  foreach ($k in @('residentManifestSha256', 'ciSourceManifestSha256', 'policySha256', 'companionConfigSha256', 'nodeSha256', 'residentEntrySha256', 'companionEntrySha256', 'nodeProfileSha256')) {
    if (-not (Test-Hex (Get-Field $t $k))) { throw ('UPGRADE_PLAN_REFUSED:target.' + $k) }
  }
  # What may change outside the files: the two binary paths and the task's arguments, nothing else.
  $scm = Get-Field $p 'scm'
  if ($scm -isnot [pscustomobject] -or (@($scm.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'broker,resident' -or $scm.resident -cne 'binPath' -or $scm.broker -cne 'binPath' -or (Get-Field $p 'companionTask') -cne 'arguments') { throw 'UPGRADE_PLAN_REFUSED:scm' }
  # The slots: exactly the white list, each once, by its kind.
  $slots = @(Get-Field $p 'slots')   # a function's output unrolls a one-element array: @() collects it again
  $want = @($PackageSlots + $GeneratedSlots + @($ReceiptSlot) | Sort-Object)
  $have = @($slots | ForEach-Object { [string](Get-Field $_ 'target') } | Sort-Object)
  if (($have -join '|') -cne ($want -join '|')) { throw 'UPGRADE_PLAN_REFUSED:slots' }
  foreach ($s in $slots) {
    $kind = Get-Field $s 'kind'; $target = Get-Field $s 'target'
    $ok = if ($PackageSlots -ccontains $target) { $kind -ceq 'package' -and (Test-Hex (Get-Field $s 'sha256')) -and (Test-PackagePath (Get-Field $s 'from')) }
      elseif ($GeneratedSlots -ccontains $target) { $kind -ceq 'generated' } else { $kind -ceq 'receipt' }
    if (-not $ok) { throw ('UPGRADE_PLAN_REFUSED:slot:' + $target) }
  }
  # The target's pins are the package slots' own hashes.
  foreach ($pair in @(@('config\policy.json', 'policySha256'), @('config\companion.json', 'companionConfigSha256'), @('runtime\node.exe', 'nodeSha256'))) {
    if (@($slots | Where-Object { $_.target -ceq $pair[0] })[0].sha256 -cne (Get-Field $t $pair[1])) { throw ('UPGRADE_PLAN_REFUSED:target.' + $pair[1]) }
  }
  foreach ($d in @(Get-Field $p 'dirs')) {
    $kind = Get-Field $d 'kind'
    $ok = (($kind -ceq 'resident') -and (Get-Field $d 'sha256') -ceq $t.residentManifestSha256) -or (($kind -ceq 'source') -and (Get-Field $d 'sha256') -ceq $t.ciSourceManifestSha256)
    if (-not $ok) { throw 'UPGRADE_PLAN_REFUSED:dirs' }
  }
}
function Read-UpgradePlan([string]$root, [string]$opId, [string]$planSha) {
  $dir = Join-Path $root ('upgrade\ops\' + $opId)
  Assert-NoLinkChain $root $dir
  $bytes = Read-SmallFile (Join-Path $dir '010-accept.plan.json') 16777216 'UPGRADE_PLAN'
  if ((Sha256Bytes $bytes) -cne $planSha) { throw 'UPGRADE_PLAN_SHA_MISMATCH' }
  $plan = ConvertFrom-StrictJson $bytes 'UPGRADE_PLAN'
  Assert-UpgradePlan $plan $opId
  $plan
}
function Find-PlanSlot($plan, [string]$target) {
  $hit = @($plan.slots | Where-Object { $_.target -ceq $target })
  if ($hit.Count -ne 1) { throw ('UPGRADE_PLAN_SLOT_MISSING:' + $target) }
  $hit[0]
}
# The staged package (stage-windows wrote it from the package it read once): its manifest by the plan's hash.
function Read-StagedManifest([string]$root, $plan) {
  $dir = Join-Path $root ('upgrade\staged\' + $plan.packageManifestSha256)
  Assert-NoLinkChain $root $dir
  $bytes = Read-SmallFile (Join-Path $dir 'package-manifest.json') 16777216 'STAGED_PACKAGE'
  if ((Sha256Bytes $bytes) -cne $plan.packageManifestSha256) { throw 'STAGED_PACKAGE_CHANGED' }
  [ordered]@{ dir = $dir; manifest = (ConvertFrom-StrictJson $bytes 'STAGED_PACKAGE') }
}
# One compile input by its install target: the staged copy (package path) or, once placed, the content-addressed live copy; the one whose
# bytes hash to the package manifest's entry. Returns its path.
function Find-CompileInput([string]$root, $staged, [string]$target) {
  $hit = @(@($staged.manifest.files) | Where-Object { $_.target -ceq $target })
  if ($hit.Count -ne 1 -or -not (Test-PackagePath $hit[0].path) -or -not (Test-Hex $hit[0].sha256)) { throw ('COMPILE_INPUT_NOT_IN_PACKAGE:' + $target) }
  foreach ($candidate in @((Join-Path $staged.dir $hit[0].path.Replace('/', '\')), (Join-Path $root $target))) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and -not $item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and (Sha256File $candidate) -ceq $hit[0].sha256) { return $candidate }
  }
  throw ('COMPILE_INPUT_NOT_THE_PLAN:' + $target)
}
function Read-CompileRecord([string]$root, $plan) {
  $file = Join-Path $root ('upgrade\staged\' + $plan.packageManifestSha256 + '\compiled\compile.json')
  $done = ConvertFrom-StrictJson (Read-SmallFile $file 1048576 'COMPILE_RECORD') 'COMPILE_RECORD'
  if ((Get-Field $done 'contract') -cne $CompileContract -or (Get-Field $done 'opId') -cne $plan.opId -or (Get-Field $done 'packageManifestSha256') -cne $plan.packageManifestSha256 -or
    -not (Test-Hex (Get-Field $done 'brokerConfigSha256'))) { throw 'COMPILE_RECORD_OTHER_OP' }
  $done
}

# ---- Generations (A6: generations\g<N>\generation.json; the to generation's record is written by the upgrader after the switch) ----
function ConvertTo-GenerationView([string]$root, [int]$g, $r, [string]$nodeProfileSha) {
  if ((Get-Field $r 'generation') -ne $g -or -not (Test-Int (Get-Field $r 'generation'))) { throw 'GENERATION_RECORD_REFUSED:generation' }
  if (-not (Test-Hex (Get-Field $r 'packageManifestSha256'))) { throw 'GENERATION_RECORD_REFUSED:packageManifestSha256' }
  $res = ConvertFrom-ResidentBinPath $root ([string](Get-Field $r 'residentBinPath'))
  if ($null -eq $res) { throw 'GENERATION_RECORD_REFUSED:residentBinPath' }
  $bro = ConvertFrom-BrokerBinPath $root ([string](Get-Field $r 'brokerBinPath'))
  if ($null -eq $bro -or $bro.nodeProfileSha256 -cne $nodeProfileSha) { throw 'GENERATION_RECORD_REFUSED:brokerBinPath' }
  $com = ConvertFrom-CompanionArguments $root ([string](Get-Field $r 'companionTaskArguments'))
  if ($null -eq $com -or $com.residentManifestSha256 -cne $res.residentManifestSha256) { throw 'GENERATION_RECORD_REFUSED:companionTaskArguments' }
  [ordered]@{ generation = $g; record = $r; resident = $res; broker = $bro; companion = $com }
}
function Read-GenerationRecord([string]$root, [int]$g, [string]$nodeProfileSha) {
  $dir = Join-Path $root ('generations\g' + $g)
  Assert-NoLinkChain $root $dir
  $r = ConvertFrom-StrictJson (Read-SmallFile (Join-Path $dir 'generation.json') 65536 'GENERATION_RECORD') 'GENERATION_RECORD'
  if (-not (Test-Hex (Get-Field $r 'filesSha256'))) { throw 'GENERATION_RECORD_REFUSED:filesSha256' }
  ConvertTo-GenerationView $root $g $r $nodeProfileSha
}
# Generation N of a plan: the from generation by its record (it must be the plan's current); the to generation by the plan and the
# compile record (the same formulas as the install), and by its record too once the upgrader wrote it (they must agree).
function Get-PlanGeneration($plan, [int]$g) {
  $t = $plan.target
  if ($g -eq $plan.toGeneration) {
    $done = Read-CompileRecord $Root $plan
    $r = [pscustomobject][ordered]@{ generation = $g; packageManifestSha256 = $plan.packageManifestSha256
      residentBinPath = (Get-ResidentBinPath $Root $t.policySha256 $t.nodeSha256 $t.residentManifestSha256 $t.residentEntrySha256)
      brokerBinPath = (Get-BrokerBinPath $Root $done.brokerConfigSha256 $t.nodeProfileSha256)
      companionTaskArguments = (Get-CompanionLaunchArguments $Root $t.residentManifestSha256 $t.companionConfigSha256) }
    $gen = ConvertTo-GenerationView $Root $g $r $t.nodeProfileSha256
    if (Test-Path -LiteralPath (Join-Path $Root ('generations\g' + $g + '\generation.json'))) {
      $kept = Read-GenerationRecord $Root $g $t.nodeProfileSha256
      foreach ($k in @('packageManifestSha256', 'residentBinPath', 'brokerBinPath', 'companionTaskArguments')) { if ($kept.record.$k -cne $r.$k) { throw 'GENERATION_RECORD_NOT_THE_PLAN' } }
    }
    return $gen
  }
  if ($g -ne $plan.fromGeneration) { throw 'UPGRADE_APPLY_GENERATION_REFUSED' }
  $gen = Read-GenerationRecord $Root $g $t.nodeProfileSha256
  if ($gen.resident.residentManifestSha256 -cne $plan.current.residentManifestSha256 -or $gen.resident.policySha256 -cne $plan.current.policySha256) { throw 'GENERATION_RECORD_NOT_THE_PLAN' }
  $gen
}
# The live files a generation's command lines pin are the ones in place now (the switch comes after the files were placed).
function Assert-GenerationInPlace([string]$root, $gen, [switch]$Companion) {
  $pins = @(@('runtime\node.exe', $gen.resident.nodeSha256), @(('resident\' + $gen.resident.residentManifestSha256 + '\src\service-main.mjs'), $gen.resident.entrySha256),
    @('config\policy.json', $gen.resident.policySha256), @('config\broker.json', $gen.broker.brokerConfigSha256))
  if ($Companion) { $pins = @(@('runtime\node.exe', $gen.resident.nodeSha256), @('config\companion.json', $gen.companion.companionConfigSha256)) }
  foreach ($pin in $pins) {
    $file = Join-Path $root $pin[0]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Sha256File $file) -cne $pin[1]) { throw ('GENERATION_FILES_NOT_IN_PLACE:' + $pin[0]) }
  }
  if ($Companion -and -not (Test-Path -LiteralPath (Join-Path $root ('resident\' + $gen.companion.residentManifestSha256 + '\src\companion-main.mjs')) -PathType Leaf)) { throw 'GENERATION_FILES_NOT_IN_PLACE:companion-main.mjs' }
}
# The node profile of the installed record (validated; the profile is pinned for the life of the channel).
function Get-LiveNode([string]$root, [string]$nodeProfileSha) {
  $accepted = ConvertFrom-StrictJson (Read-SmallFile (Join-Path $root 'record\acceptance.json') 4194304 'INSTALLED_RECORD') 'INSTALLED_RECORD'
  $node = Get-Field $accepted 'node'
  $canonical = ConvertTo-NodeProfileCanonical $node
  if ((Sha256Text $canonical) -cne $nodeProfileSha) { throw 'NODE_PROFILE_CHANGED' }
  [ordered]@{ node = $node; canonical = $canonical }
}
function Read-CurrentRecord([string]$root) {
  $cur = ConvertFrom-StrictJson (Read-SmallFile (Join-Path $root 'upgrade\current.json') 65536 'CURRENT_RECORD') 'CURRENT_RECORD'
  if ((Get-Field $cur 'contract') -cne 'clued.independent-ci.resident-generation/1' -or -not (Test-Int (Get-Field $cur 'generation')) -or
    -not (Test-Hex (Get-Field $cur 'residentManifestSha256')) -or -not (Test-Hex (Get-Field $cur 'installReceiptSha256'))) { throw 'CURRENT_RECORD_REFUSED' }
  $cur
}

# ---- The content-addressed directories' ACLs (PR-1 review M2) ----
# resident\<sha> and source\<sha> are moved in from upgrade\staged\ by one rename each (generations.mjs placeDirs), and a rename keeps the
# security descriptor: the tree would keep what it inherited under upgrade\ and miss, for one, .\clued-control's read on source\. Every item
# of such a tree must hold exactly what its live parent passes down: not protected, no explicit ACE, the parent's inheritable ACEs (SID and
# mask) and nothing else. Test-ContentAcl is shared with verify-resident.ps1 (one text, held identical by test-upgrade-windows.ps1).
function Get-InheritableAceKeys([string]$parentSddl, [int]$flag) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($parentSddl)
  (@(foreach ($a in $raw.DiscretionaryAcl) { if (([int]$a.AceFlags -band $flag) -ne 0) { $a.SecurityIdentifier.Value + '|' + $a.AccessMask } }) | Sort-Object -Unique) -join ','
}
function Test-ItemAcl($item, [string]$wantDir, [string]$wantFile) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link' }
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $item.FullName).Sddl)
  if (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) { return 'protected' }
  if (@($raw.DiscretionaryAcl | Where-Object { ([int]$_.AceFlags -band 0x10) -eq 0 }).Count -ne 0) { return 'explicit' }
  $have = (@(foreach ($a in $raw.DiscretionaryAcl) { $a.SecurityIdentifier.Value + '|' + $a.AccessMask }) | Sort-Object -Unique) -join ','
  if ($have -cne $(if ($item.PSIsContainer) { $wantDir } else { $wantFile })) { return 'aces' }
  'ok'
}
# 'ok', or the first reason with the item's path under $dir.
function Test-ContentAcl([string]$dir) {
  $parent = (Get-Acl -LiteralPath (Split-Path -Parent $dir)).Sddl
  $wantDir = Get-InheritableAceKeys $parent 2; $wantFile = Get-InheritableAceKeys $parent 1
  foreach ($i in @(@(Get-Item -LiteralPath $dir -Force) + @(Get-ChildItem -LiteralPath $dir -Recurse -Force))) {
    $why = Test-ItemAcl $i $wantDir $wantFile
    if ($why -cne 'ok') { return ($why + ':' + $i.FullName.Substring($dir.Length).TrimStart('\')) }
  }
  'ok'
}
# Inheritance back on, explicit ACEs off (only the DACL section is written); on a directory Windows passes the parent's inheritable ACEs
# down the whole tree again.
function Reset-InheritedAcl([string]$path, [bool]$container) {
  $sec = if ($container) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $sec.SetSecurityDescriptorSddlForm('D:', [Security.AccessControl.AccessControlSections]::Access)
  $sec.SetAccessRuleProtection($false, $false)
  if ($container) { [IO.Directory]::SetAccessControl($path, $sec) } else { [IO.File]::SetAccessControl($path, $sec) }
}
# Returns how many items were reset (0: already right); refuses a link; reads the result back.
function Repair-ContentAcl([string]$dir) {
  $parent = (Get-Acl -LiteralPath (Split-Path -Parent $dir)).Sddl
  $wantDir = Get-InheritableAceKeys $parent 2; $wantFile = Get-InheritableAceKeys $parent 1
  $n = 0
  $top = Get-Item -LiteralPath $dir -Force
  $why = Test-ItemAcl $top $wantDir $wantFile
  if ($why -ceq 'link') { throw 'LINK_REFUSED:content' }
  if ($why -cne 'ok') { Reset-InheritedAcl $dir $true; $n++ }
  foreach ($i in @(Get-ChildItem -LiteralPath $dir -Recurse -Force)) {
    $why = Test-ItemAcl $i $wantDir $wantFile
    if ($why -ceq 'link') { throw 'LINK_REFUSED:content' }
    if ($why -cne 'ok') { Reset-InheritedAcl $i.FullName ([bool]$i.PSIsContainer); $n++ }
  }
  if ((Test-ContentAcl $dir) -cne 'ok') { throw 'CONTENT_ACL_READBACK_MISMATCH' }
  $n
}
# Generation N's resident\<sha> and source\<sha>: the to generation's from the plan's target, the from generation's from its current.
function Repair-GenerationContentAcl([string]$root, $plan, $gen) {
  $sourceSha = if ($gen.generation -eq $plan.toGeneration) { $plan.target.ciSourceManifestSha256 } else { $plan.current.ciSourceManifestSha256 }
  $out = [ordered]@{ repaired = 0; resident = 0; source = 0 }
  foreach ($pair in @(@('resident', $gen.resident.residentManifestSha256), @('source', $sourceSha))) {
    $dir = Join-Path $root ($pair[0] + '\' + $pair[1])
    Assert-NoLinkChain $root $dir
    $n = Repair-ContentAcl $dir
    $out[$pair[0]] = $n; $out.repaired += $n
  }
  $out
}

# ---- The host: services, executor, companion ----
function Get-ServiceFacts([string]$name) {
  $q = & $Sc queryex $name | Out-String
  if ($LASTEXITCODE -eq 1060) { return [ordered]@{ exists = $false; state = 'absent'; processId = $null; binPath = $null } }
  if ($LASTEXITCODE -ne 0) { throw ('SERVICE_QUERY_FAILED:' + $LASTEXITCODE) }
  $s = ConvertFrom-ScState $q
  [ordered]@{ exists = $true; state = $s.state; processId = $s.processId; binPath = (ConvertFrom-ScBinPath (Invoke-Sc 'SERVICE_QC_FAILED' @('qc', $name, '8192'))) }
}
function Invoke-ScAllowing([string]$failureCode, [int[]]$allowed, [string[]]$scArgs) {
  $null = & $Sc @scArgs | Out-String
  if ($allowed -notcontains $LASTEXITCODE) { throw ($failureCode + ':' + $LASTEXITCODE) }
}
function Wait-ServiceState([string]$name, [string]$state, [int]$seconds, [string]$code) {
  $until = [DateTime]::UtcNow.AddSeconds($seconds)
  while ((Get-ServiceFacts $name).state -cne $state) { if ([DateTime]::UtcNow -gt $until) { throw $code }; Start-Sleep -Milliseconds 500 }
}
# The executor holds state\executor.lock while it runs; stopping the service never kills it (it exits between batches).
function Test-ExecutorAlive([string]$root) {
  $h = Join-Path $root 'state\executor.lock\holder.json'
  if (-not (Test-Path -LiteralPath $h)) { return $false }
  $holder = try { Get-Content -LiteralPath $h -Raw | ConvertFrom-Json } catch { return $true }   # being written: alive
  $holderPid = Get-Field $holder 'pid'
  if (-not (Test-Int $holderPid)) { return $true }
  return [bool](Get-Process -Id $holderPid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' })
}
# M5: what the companion runs is named by the launch file (the supervisor reads it): path is its node.exe, arguments the companion's
# arguments derived from it (Get-CompanionLaunchArguments: the form the generation records keep), state the task's state. A launch
# file that does not parse or does not fit the formula reads as arguments $null (matches neither generation).
function Get-CompanionLaunchFacts([string]$root) {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $task = try { $svc.GetFolder('\Clued').GetTask($TaskName) } catch { $null }
  $file = Join-Path $root 'config\companion-launch.json'
  $l = if (Test-Path -LiteralPath $file -PathType Leaf) { try { ConvertFrom-StrictJson (Read-SmallFile $file 8192 'COMPANION_LAUNCH') 'COMPANION_LAUNCH' } catch { $null } } else { $null }
  $launchArgs = $null; $gen = $null
  if ($null -ne $l -and (Get-Field $l 'contract') -ceq 'clued.independent-ci.companion-launch/1' -and ([string](Get-Field $l 'entry')) -cmatch ('^' + [regex]::Escape($root) + '\\resident\\([0-9a-f]{64})\\src\\companion-main\.mjs\z') -and (Test-Hex (Get-Field $l 'configSha256'))) {
    $launchArgs = Get-CompanionLaunchArguments $root $Matches[1] (Get-Field $l 'configSha256'); $gen = Get-Field $l 'generation'
  }
  [ordered]@{ exists = ($null -ne $task -and $null -ne $launchArgs); path = $(if ($null -ne $launchArgs) { Join-Path $root 'runtime\node.exe' } else { $null }); arguments = $launchArgs; state = $(if ($task) { [int]$task.State } else { $null }); launchGeneration = $gen }
}
function Get-CompanionProcesses([string]$root) {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1'
  $node = Join-Path $root 'runtime\node.exe'; $jobHost = Join-Path $root ('bin\' + $CompanionJobHost)
  @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe' OR Name='CluedCompanionJobHost.exe'" | Where-Object {
      $p = [string]$_.ExecutablePath
      ([string]::Equals($p, $node, [StringComparison]::OrdinalIgnoreCase) -and (Test-CompanionCommandLine ([string]$_.CommandLine) $root)) -or [string]::Equals($p, $jobHost, [StringComparison]::OrdinalIgnoreCase) })
}
function Get-Match([string]$have, $fromValue, $toValue) { if ($null -ne $toValue -and $have -ceq $toValue) { 'to' } elseif ($null -ne $fromValue -and $have -ceq $fromValue) { 'from' } else { 'neither' } }

# ---- The actions ----
function Invoke-ReadScm($plan) {
  $from = try { (Get-PlanGeneration $plan $plan.fromGeneration).record } catch { $null }
  $to = try { (Get-PlanGeneration $plan $plan.toGeneration).record } catch { $null }
  $pick = { param($rec, [string]$k) if ($null -ne $rec) { $rec.$k } else { $null } }
  $live = Get-LiveNode $Root $plan.target.nodeProfileSha256
  $r = Get-ServiceFacts $ServiceName; $b = Get-ServiceFacts $BrokerName; $u = Get-ServiceFacts $UpgraderName; $c = Get-CompanionLaunchFacts $Root
  $runner = Get-ServiceFacts ([string]$live.node.runnerService)
  $r.matches = Get-Match $r.binPath (& $pick $from 'residentBinPath') (& $pick $to 'residentBinPath')
  $b.matches = Get-Match $b.binPath (& $pick $from 'brokerBinPath') (& $pick $to 'brokerBinPath')
  $c.matches = if ($null -eq $c.arguments) { 'neither' } else { Get-Match $c.arguments (& $pick $from 'companionTaskArguments') (& $pick $to 'companionTaskArguments') }
  [ordered]@{ resident = $r; broker = $b; upgrader = [ordered]@{ exists = $u.exists; state = $u.state }
    runner = [ordered]@{ exists = $runner.exists; state = $runner.state; originalBinary = ($runner.binPath -ceq $OriginalBinary) }
    companionTask = $c; executorAlive = (Test-ExecutorAlive $Root); fromRecord = ($null -ne $from); toRecord = ($null -ne $to) }
}
function Invoke-Compile($plan) {
  $t = $plan.target
  $out = Join-Path $Root ('upgrade\staged\' + $plan.packageManifestSha256 + '\compiled')
  $record = Join-Path $out 'compile.json'
  $staged = Read-StagedManifest $Root $plan
  $asideOther = $false
  if (Test-Path -LiteralPath $out) {
    # Compiled for an earlier op of the same package (it was rolled back or withdrawn after staging): set aside, compiled again for this op.
    $earlier = if (Test-Path -LiteralPath $record -PathType Leaf) { try { ConvertFrom-StrictJson (Read-SmallFile $record 1048576 'COMPILE_RECORD') 'COMPILE_RECORD' } catch { $null } } else { $null }
    $asideOther = ($null -ne $earlier) -and ((Get-Field $earlier 'opId') -cne $plan.opId)
  }
  if ((Test-Path -LiteralPath $out) -and -not $asideOther) {
    if (Test-Path -LiteralPath $record -PathType Leaf) {
      # Already compiled for this op: re-observe every output.
      $done = Read-CompileRecord $Root $plan
      foreach ($f in @($done.files)) { $p = Join-Path $out $f.path; if (-not (Test-Path -LiteralPath $p -PathType Leaf) -or (Sha256File $p) -cne $f.sha256) { throw ('COMPILE_OUTPUT_CHANGED:' + $f.path) } }
      return [ordered]@{ replayed = $true; compileRecordSha256 = (Sha256File $record); brokerConfigSha256 = $done.brokerConfigSha256; files = @($done.files) }
    }
  }
  # The inputs, each the bytes the package manifest names: the two hosts from their plan slots, the job host and the Source v2 C# files.
  $residentHost = Find-CompileInput $Root $staged 'bin\ResidentServiceHost.cs'
  $broker = Find-CompileInput $Root $staged 'bin\SwapBroker.cs'
  foreach ($pair in @(@($residentHost, 'bin\ResidentServiceHost.cs'), @($broker, 'bin\SwapBroker.cs'))) { if ((Sha256File $pair[0]) -cne (Find-PlanSlot $plan $pair[1]).sha256) { throw ('COMPILE_INPUT_NOT_THE_PLAN:' + $pair[1]) } }
  $jobHost = Find-CompileInput $Root $staged ('resident\' + $t.residentManifestSha256 + '\windows\CompanionJobHost.cs')
  $v2Files = @(foreach ($f in $SourceV2Files) { Find-CompileInput $Root $staged ('source\' + $t.ciSourceManifestSha256 + '\' + $SourceV2Windows + '\' + $f) })
  $v2 = Split-Path -Parent $v2Files[0]
  if (@($v2Files | Where-Object { (Split-Path -Parent $_) -cne $v2 }).Count -ne 0) { throw 'COMPILE_INPUT_SOURCE_SPLIT' }
  if (Test-Path -LiteralPath $out) {
    # An attempt cut before its record, or an earlier op's output: set aside by rename (nothing is deleted), compiled again.
    $script:Touched = $true
    $why = if ($asideOther) { '.op-' + [string](Get-Field $earlier 'opId') } else { '.abandoned' }
    if ($why -cnotmatch '^\.(?:abandoned|op-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\z') { $why = '.op-other' }
    [IO.Directory]::Move($out, $out + $why + '-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
  }
  $script:Touched = $true
  [void][IO.Directory]::CreateDirectory($out)
  # Each output directory is created with the DACL of the live directory its files will go to (helpers\ grants .\clued-control).
  foreach ($sub in @('bin', 'helpers', 'config')) {
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetSecurityDescriptorSddlForm((Get-Acl -LiteralPath (Join-Path $Root $sub)).Sddl)
    $null = [IO.Directory]::CreateDirectory((Join-Path $out $sub), $sec)
    if ((Get-DaclPart (Get-Acl -LiteralPath (Join-Path $out $sub)).Sddl) -cne (Get-DaclPart (Get-Acl -LiteralPath (Join-Path $Root $sub)).Sddl)) { throw ('COMPILE_OUTPUT_ACL_MISMATCH:' + $sub) }
  }
  $hashes = Invoke-CompileRecipe $Csc $Fw (Join-Path $out 'bin') (Join-Path $out 'helpers') $residentHost $broker $v2 $jobHost
  # The broker configuration of the new generation: the runner's stable digest (read-only, with the just-compiled broker, against the
  # installed record), the new helper pin and the new record's acceptance.
  $live = Get-LiveNode $Root $t.nodeProfileSha256
  $stable = (& (Join-Path $out 'bin\SwapBroker.exe') --stable-digest $Root (Sha256File (Join-Path $Root 'record\acceptance.json')) $t.nodeProfileSha256 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $stable -cnotmatch '^[0-9a-f]{64}$') { throw 'RUNNER_STABLE_DIGEST_UNCONFIRMED' }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((Get-BrokerConfigJson $hashes.genericHelperSha256 $stable $live.canonical $t.nodeProfileSha256 (Find-PlanSlot $plan 'record\acceptance.json').sha256))
  Write-New (Join-Path $out 'config\broker.json') $bytes
  $files = @(foreach ($rel in $GeneratedSlots) { [ordered]@{ path = $rel; sha256 = (Sha256File (Join-Path $out $rel)) } })
  $done = [ordered]@{ contract = $CompileContract; opId = $plan.opId; packageManifestSha256 = $plan.packageManifestSha256; residentManifestSha256 = $t.residentManifestSha256
    ciSourceManifestSha256 = $t.ciSourceManifestSha256; ResidentServiceHostSha256 = $hashes.ResidentServiceHostSha256; SwapBrokerSha256 = $hashes.SwapBrokerSha256; genericHelperSha256 = $hashes.genericHelperSha256
    companionJobHostSha256 = $hashes.companionJobHostSha256; brokerConfigSha256 = (Sha256Bytes $bytes); runnerStableDigest = $stable; files = $files; at = [DateTimeOffset]::UtcNow.ToString('o') }
  Write-New $record ((New-Object Text.UTF8Encoding($false)).GetBytes(($done | ConvertTo-Json -Depth 5 -Compress)))
  [ordered]@{ replayed = $false; compileRecordSha256 = (Sha256File $record); brokerConfigSha256 = $done.brokerConfigSha256; files = $files }
}
function Invoke-StopServices {
  $before = [ordered]@{ resident = (Get-ServiceFacts $ServiceName).state; broker = (Get-ServiceFacts $BrokerName).state }
  $script:Touched = $true
  # 1062: not started; 1061: already stopping. The host writes STOP-REQUESTED; the executor exits between batches by itself.
  Invoke-ScAllowing 'RESIDENT_STOP_FAILED' @(0, 1061, 1062) @('stop', $ServiceName)
  $until = [DateTime]::UtcNow.AddSeconds(600)
  while (((Get-ServiceFacts $ServiceName).state -cne 'stopped') -or (Test-ExecutorAlive $Root)) { if ([DateTime]::UtcNow -gt $until) { throw 'RESIDENT_STOP_TIMEOUT' }; Start-Sleep -Seconds 2 }
  Invoke-ScAllowing 'BROKER_STOP_FAILED' @(0, 1061, 1062) @('stop', $BrokerName)
  Wait-ServiceState $BrokerName 'stopped' 120 'BROKER_STOP_TIMEOUT'
  [ordered]@{ replayed = ($before.resident -ceq 'stopped' -and $before.broker -ceq 'stopped'); before = $before; executorAlive = $false }
}
function Invoke-SwitchScm($plan, [int]$g) {
  $gen = Get-PlanGeneration $plan $g
  Assert-GenerationInPlace $Root $gen
  foreach ($name in @($ServiceName, $BrokerName)) { if ((Get-ServiceFacts $name).state -cne 'stopped') { throw ('SERVICES_NOT_STOPPED:' + $name) } }
  # The content-addressed directories of generation N first (M2 of the PR-1 review): before any service can run code from them.
  $script:Touched = $true
  $acl = Repair-GenerationContentAcl $Root $plan $gen
  $did = [ordered]@{}
  foreach ($pair in @(@($ServiceName, $gen.record.residentBinPath, 'resident', 'RESIDENT'), @($BrokerName, $gen.record.brokerBinPath, 'broker', 'BROKER'))) {
    $have = (Get-ServiceFacts $pair[0]).binPath
    if ($have -cne $pair[1]) {
      $script:Touched = $true
      # Windows PowerShell 5.1 does not escape embedded quotes for a native command line: \" (as install-resident.ps1).
      $null = Invoke-Sc ($pair[3] + '_SERVICE_CONFIG_FAILED') @('config', $pair[0], 'binPath=', $pair[1].Replace('"', '\"'))
    }
    Assert-ServiceBinary $pair[0] $pair[1]
    $did[$pair[2]] = [ordered]@{ changed = ($have -cne $pair[1]); binPath = $pair[1] }
  }
  [ordered]@{ replayed = (-not $did.resident.changed -and -not $did.broker.changed -and $acl.repaired -eq 0); generation = $g; resident = $did.resident; broker = $did.broker; contentAcl = $acl }
}
# M5 (DESIGN.md section 65.4.4): generation N's launch file, replaced atomically; the notifier task for N. Never the companion task.
function Invoke-WriteCompanionLaunch($plan, [int]$g) {
  $gen = Get-PlanGeneration $plan $g
  Assert-GenerationInPlace $Root $gen -Companion
  $live = Get-LiveNode $Root $plan.target.nodeProfileSha256
  $entry = Join-Path $Root ('resident\' + $gen.companion.residentManifestSha256 + '\src\companion-main.mjs')
  $entrySha = Sha256File $entry
  if ($g -eq $plan.toGeneration -and $entrySha -cne $plan.target.companionEntrySha256) { throw 'GENERATION_FILES_NOT_IN_PLACE:companion-main.mjs' }
  $companionConfig = ConvertFrom-StrictJson (Read-SmallFile (Join-Path $Root 'config\companion.json') 65536 'COMPANION_CONFIG') 'COMPANION_CONFIG'
  $ghExe = [string](Get-Field $companionConfig 'ghExe')
  if ($ghExe -cnotmatch '^[A-Z]:\\[^"''\r\n;]+\\gh\.exe\z') { throw 'COMPANION_CONFIG_GH_EXE_REFUSED' }
  $json = Get-CompanionLaunchJson $Root $g $gen.resident.nodeSha256 $gen.companion.residentManifestSha256 $entrySha $gen.companion.companionConfigSha256 ([string]$live.node.ownerProfileDirectory) (Get-CompanionPathDirs $ghExe)
  $file = Join-Path $Root 'config\companion-launch.json'
  $same = (Test-Path -LiteralPath $file -PathType Leaf) -and ([IO.File]::ReadAllText($file) -ceq $json)
  $script:Touched = $true
  $launchSha = if ($same) { Sha256File $file } else { Write-CompanionLaunch $Root $json }
  $notifier = Register-NotifierTask $Root ([string]$live.node.ownerSid) $gen.companion.residentManifestSha256
  $task = Get-CompanionTaskFacts $Root ([string]$live.node.ownerSid)
  $needsOwner = @('password', 'interactive') -cnotcontains $task.mode
  [ordered]@{ replayed = $same; generation = $g; launchSha256 = $launchSha; companionTaskArguments = (Get-CompanionLaunchArguments $Root $gen.companion.residentManifestSha256 $gen.companion.companionConfigSha256)
    notifierTaskXmlSha256 = $notifier; companionTask = [ordered]@{ mode = $task.mode; needsOwner = $needsOwner; note = $(if ($needsOwner) { 'COMPANION_TASK_NEEDS_OWNER' } else { $null }) } }
}
# Ends the companion's node and job hosts of the installed copy, never the supervisor or the task: the supervisor starts the generation
# the launch file names at once. No supervisor running (the task is not running): SYSTEM runs the task (a password task runs without
# the password; an interactive one only while the Owner is logged on). Then up to 90 s for the new companion.
function Invoke-RestartCompanion {
  $c = Get-CompanionLaunchFacts $Root
  $parts = if ($null -ne $c.arguments) { ConvertFrom-CompanionArguments $Root $c.arguments } else { $null }
  if ($null -eq $parts) { throw 'COMPANION_LAUNCH_REFUSED' }
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $task = try { $svc.GetFolder('\Clued').GetTask($TaskName) } catch { $null }
  if ($null -eq $task) { throw 'COMPANION_TASK_MISSING' }
  $script:Touched = $true
  # Every companion process there is now (the generation being replaced, and one of the new generation the supervisor may already
  # have started): ended once; then only new processes count.
  $stopped = New-Object System.Collections.ArrayList
  foreach ($p in @(Get-CompanionProcesses $Root)) { [void]$stopped.Add([int]$p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $until = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $left = @(Get-CompanionProcesses $Root | Where-Object { $stopped -contains [int]$_.ProcessId })
    if ($left.Count) { Start-Sleep -Milliseconds 500 }
  } while ($left.Count -and [DateTime]::UtcNow -lt $until)
  if ($left.Count) { throw 'COMPANION_STILL_RUNNING' }
  $supervisor = Join-Path $Root 'bin\CluedCompanionSupervisor.exe'
  $running = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='CluedCompanionSupervisor.exe'" | Where-Object { [string]::Equals([string]$_.ExecutablePath, $supervisor, [StringComparison]::OrdinalIgnoreCase) })
  $ranTask = $false
  if ($running.Count -eq 0) { try { $null = $task.Run($null); $ranTask = $true } catch { throw 'COMPANION_TASK_RUN_FAILED' } }
  $marker = '--config-sha256 ' + $parts.companionConfigSha256
  $until = [DateTime]::UtcNow.AddSeconds(90); $new = $null
  while ($null -eq $new -and [DateTime]::UtcNow -lt $until) {
    $new = @(Get-CompanionProcesses $Root | Where-Object { ([string]$_.CommandLine).Contains($marker) -and ([string]$_.CommandLine).Contains('\resident\' + $parts.residentManifestSha256 + '\') -and $stopped -notcontains [int]$_.ProcessId }) | Select-Object -First 1
    if ($null -eq $new) { Start-Sleep -Milliseconds 500 }
  }
  if ($null -eq $new) { throw 'COMPANION_NOT_STARTED' }
  [ordered]@{ replayed = $false; stoppedProcessIds = @($stopped | Sort-Object -Unique); processId = [int]$new.ProcessId; residentManifestSha256 = $parts.residentManifestSha256; ranTask = $ranTask }
}
function Invoke-StartServices {
  $before = [ordered]@{ broker = (Get-ServiceFacts $BrokerName).state; resident = (Get-ServiceFacts $ServiceName).state }
  $script:Touched = $true
  # 1056: already running.
  Invoke-ScAllowing 'BROKER_SERVICE_START_FAILED' @(0, 1056) @('start', $BrokerName)
  Wait-ServiceState $BrokerName 'running' 60 'BROKER_START_TIMEOUT'
  Invoke-ScAllowing 'RESIDENT_SERVICE_START_FAILED' @(0, 1056) @('start', $ServiceName)
  Wait-ServiceState $ServiceName 'running' 60 'RESIDENT_START_TIMEOUT'
  [ordered]@{ replayed = ($before.broker -ceq 'running' -and $before.resident -ceq 'running'); brokerProcessId = (Get-ServiceFacts $BrokerName).processId; residentProcessId = (Get-ServiceFacts $ServiceName).processId }
}
# Generation N's own installed verify-resident.ps1 (resident\<its resident sha>\windows\), against the receipt upgrade\current.json names.
# Read-only; a failed verify is a refusal (exit 2) naming the first check that failed.
function Invoke-Verify($plan, [int]$g, [string]$pausedSha) {
  if ($g -ne $plan.fromGeneration -and $g -ne $plan.toGeneration) { throw 'UPGRADE_APPLY_GENERATION_REFUSED' }
  $cur = Read-CurrentRecord $Root
  $residentSha = if ($g -eq $plan.toGeneration) { $plan.target.residentManifestSha256 } else { $plan.current.residentManifestSha256 }
  if ($cur.generation -ne $g -or $cur.residentManifestSha256 -cne $residentSha) { throw 'CURRENT_NOT_THE_GENERATION' }
  if ((Sha256File (Join-Path $Root 'install\install-receipt.json')) -cne $cur.installReceiptSha256) { throw 'INSTALL_RECEIPT_NOT_CURRENT' }
  $script = Join-Path $Root ('resident\' + $residentSha + '\windows\verify-resident.ps1')
  Assert-NoLinkChain $Root (Split-Path -Parent $script)
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'VERIFY_SCRIPT_MISSING' }
  # Run as SYSTEM only the reviewed bytes: the live config\resident-installed-manifest.json must be generation N's (the plan's slot hash:
  # new for the to generation, old for the from generation) and it must pin this verify-resident.ps1.
  $slot = Find-PlanSlot $plan 'config\resident-installed-manifest.json'
  $wantManifest = if ($g -eq $plan.toGeneration) { $slot.sha256 } else { Get-Field $slot 'oldSha256' }
  $manifestBytes = Read-SmallFile (Join-Path $Root 'config\resident-installed-manifest.json') 16777216 'RESIDENT_MANIFEST'
  if (-not (Test-Hex $wantManifest) -or (Sha256Bytes $manifestBytes) -cne $wantManifest) { throw 'RESIDENT_MANIFEST_NOT_THE_GENERATION' }
  $pin = @(@((ConvertFrom-StrictJson $manifestBytes 'RESIDENT_MANIFEST').files) | Where-Object { $_.path -ceq 'windows/verify-resident.ps1' })
  if ($pin.Count -ne 1 -or -not (Test-Hex $pin[0].sha256) -or (Sha256Bytes (Read-SmallFile $script 4194304 'VERIFY_SCRIPT')) -cne $pin[0].sha256) { throw 'VERIFY_SCRIPT_NOT_THE_GENERATION' }
  $verifyArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-ExpectedInstallReceiptSha256', $cur.installReceiptSha256)
  if ($pausedSha) { $verifyArgs += @('-ExpectPausedSha256', $pausedSha) }
  $text = & $PowerShellExe @verifyArgs | Out-String
  $exit = $LASTEXITCODE
  $v = try { $text | ConvertFrom-Json } catch { $null }
  $checks = Get-Field $v 'checks'
  $failed = @(if ($null -ne $checks) { foreach ($p in $checks.PSObject.Properties) { if ((Get-Field $p.Value 'ok') -ne $true) { $p.Name } } })
  if ($exit -ne 0 -or $null -eq $v -or (Get-Field $v 'status') -cne 'RESIDENT_VERIFIED') { throw ('VERIFY_FAILED:' + $(if ($failed.Count) { $failed[0] } else { 'exit-' + $exit })) }
  [ordered]@{ replayed = $false; generation = $g; verified = $v.status; installReceiptSha256 = $cur.installReceiptSha256; checks = @($checks.PSObject.Properties).Count }
}
# The Owner's emergency entry (scheme C). Dry run unless -Apply.
function Invoke-Recover([string]$opId, [bool]$apply) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
  if (-not $opId) { throw 'UPGRADE_APPLY_ARGUMENTS_REQUIRED' }
  $dir = Join-Path $Root ('upgrade\ops\' + $opId)
  Assert-NoLinkChain $Root $dir
  $planBytes = Read-SmallFile (Join-Path $dir '010-accept.plan.json') 16777216 'UPGRADE_PLAN'
  $plan = ConvertFrom-StrictJson $planBytes 'UPGRADE_PLAN'
  Assert-UpgradePlan $plan $opId
  $g = [int](Read-CurrentRecord $Root).generation
  $gen = Get-PlanGeneration $plan $g
  Assert-GenerationInPlace $Root $gen
  Assert-GenerationInPlace $Root $gen -Companion
  $journal = @(Get-ChildItem -LiteralPath $dir -File -Force | Where-Object { $_.Name -cmatch '^[0-9]{3}-[a-z0-9-]+(?:\.(?:intent|result|plan))?\.json\z' } | Sort-Object Name | ForEach-Object { $_.Name })
  $r = Get-ServiceFacts $ServiceName; $b = Get-ServiceFacts $BrokerName; $u = Get-ServiceFacts $UpgraderName; $c = Get-CompanionLaunchFacts $Root
  $todo = @()
  if ($u.exists -and $u.state -cne 'stopped') { $todo += 'stop-upgrader' }
  if ($r.state -cne 'stopped' -or (Test-ExecutorAlive $Root)) { $todo += 'stop-resident' }
  if ($b.state -cne 'stopped') { $todo += 'stop-broker' }
  if ($r.binPath -cne $gen.record.residentBinPath -or $b.binPath -cne $gen.record.brokerBinPath) { $todo += 'switch-scm' }
  if ($c.arguments -cne $gen.record.companionTaskArguments) { $todo += 'write-companion-launch' }
  $srcSha = if ($g -eq $plan.toGeneration) { $plan.target.ciSourceManifestSha256 } else { $plan.current.ciSourceManifestSha256 }
  if ((Test-ContentAcl (Join-Path $Root ('resident\' + $gen.resident.residentManifestSha256))) -cne 'ok' -or (Test-ContentAcl (Join-Path $Root ('source\' + $srcSha))) -cne 'ok') { $todo += 'repair-content-acl' }
  $view = [ordered]@{ mode = $(if ($apply) { 'apply' } else { 'dry-run' }); planSha256 = (Sha256Bytes $planBytes); currentGeneration = $g; lastJournalEntry = $(if ($journal.Count) { $journal[-1] } else { $null })
    services = [ordered]@{ resident = $r.state; broker = $b.state; upgrader = $u.state }; todo = $todo; startsAnything = $false }
  if (-not $apply) { return $view }
  $script:Touched = $true
  if ($todo -ccontains 'stop-upgrader') { Invoke-ScAllowing 'UPGRADER_STOP_FAILED' @(0, 1061, 1062) @('stop', $UpgraderName); Wait-ServiceState $UpgraderName 'stopped' 120 'UPGRADER_STOP_TIMEOUT' }
  $null = Invoke-StopServices
  if ($todo -ccontains 'repair-content-acl') { $null = Repair-GenerationContentAcl $Root $plan $gen }
  if ($todo -ccontains 'switch-scm') { $null = Invoke-SwitchScm $plan $g }
  if ($todo -ccontains 'write-companion-launch') { $null = Invoke-WriteCompanionLaunch $plan $g }
  $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $note = [ordered]@{ contract = 'clued.independent-ci.upgrade-owner-recover/1'; opId = $opId; planSha256 = $view.planSha256; generation = $g; did = $todo; by = $me.User.Value; at = [DateTimeOffset]::UtcNow.ToString('o') }
  Write-New (Join-Path $dir ('recover-' + $stamp + '.json')) ((New-Object Text.UTF8Encoding($false)).GetBytes(($note | ConvertTo-Json -Compress)))
  $view.recordedAs = 'recover-' + $stamp + '.json'
  $view
}

# One line: the envelope, then the action's own fields at the top level (the upgrader reads them there: windows-port.mjs).
function Write-Result([bool]$ok, [string]$code, $detail) {
  $line = [ordered]@{ contract = $ResultContract; action = $(if ($Recover) { 'Recover' } else { $Action }); ok = $ok; code = $code; opId = $(if ($OpId) { $OpId } else { $null })
    planSha256 = $(if ($PlanSha256) { $PlanSha256 } else { $null }); generation = $(if ($Generation) { $Generation } else { $null }) }
  if ($detail -is [Collections.IDictionary]) { foreach ($k in @($detail.Keys)) { if (@('contract', 'action', 'ok', 'code') -cnotcontains $k) { $line[$k] = $detail[$k] } } }
  [Console]::Out.WriteLine(($line | ConvertTo-Json -Depth 8 -Compress))
}
# A fixed code and, at most, a short id-like suffix: never free text.
function Get-FailureCode([string]$message) {
  $code = $message; $suffix = $null
  $i = $message.IndexOf(':'); if ($i -gt 0) { $code = $message.Substring(0, $i); $suffix = $message.Substring($i + 1) }
  if ($code -cnotmatch '^[A-Z][A-Z0-9_]{2,80}\z') { return [ordered]@{ code = 'UPGRADE_APPLY_UNEXPECTED'; detail = $null } }
  [ordered]@{ code = $code; detail = $(if ($null -ne $suffix -and $suffix -cmatch '^[A-Za-z0-9_.\\-]{1,200}\z') { $suffix } else { $null }) }
}

try {
  if (-not ([IO.Path]::GetFullPath($PSCommandPath) -match $InstalledCopy)) { throw 'RUN_THE_INSTALLED_COPY' }
  if ($Recover) {
    if ($Action -or $PlanSha256 -or $Generation -or $ExpectPausedSha256) { throw 'UPGRADE_APPLY_ARGUMENTS_REFUSED' }
    $detail = Invoke-Recover $OpId ([bool]$Apply)
  } else {
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-18') { throw 'UPGRADE_APPLY_SYSTEM_REQUIRED' }
    if (-not $Action -or -not $OpId -or -not $PlanSha256) { throw 'UPGRADE_APPLY_ARGUMENTS_REQUIRED' }
    if ($Apply -or ($ExpectPausedSha256 -and $Action -cne 'Verify')) { throw 'UPGRADE_APPLY_ARGUMENTS_REFUSED' }
    $needsGeneration = @('SwitchScm', 'WriteCompanionLaunch', 'Verify') -ccontains $Action
    if ($needsGeneration -ne [bool]$Generation) { throw 'UPGRADE_APPLY_GENERATION_REFUSED' }
    $plan = Read-UpgradePlan $Root $OpId $PlanSha256
    $detail = if ($Action -ceq 'ReadScm') { Invoke-ReadScm $plan }
      elseif ($Action -ceq 'Compile') { Invoke-Compile $plan }
      elseif ($Action -ceq 'StopServices') { Invoke-StopServices }
      elseif ($Action -ceq 'SwitchScm') { Invoke-SwitchScm $plan $Generation }
      elseif ($Action -ceq 'WriteCompanionLaunch') { Invoke-WriteCompanionLaunch $plan $Generation }
      elseif ($Action -ceq 'RestartCompanion') { Invoke-RestartCompanion }
      elseif ($Action -ceq 'StartServices') { Invoke-StartServices }
      else { Invoke-Verify $plan $Generation $ExpectPausedSha256 }
  }
  Write-Result $true $null $detail
  exit 0
} catch {
  $f = Get-FailureCode ([string]$_.Exception.Message)
  Write-Result $false $f.code $(if ($null -ne $f.detail) { [ordered]@{ at = $f.detail } } else { $null })
  exit $(if ($script:Touched) { 1 } else { 2 })
}
