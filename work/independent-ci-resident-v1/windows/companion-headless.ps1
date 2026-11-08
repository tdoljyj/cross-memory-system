<#
.SYNOPSIS
  M5 (ADR 0022): the companion without the Owner's log-on. Functions only; dot-sourced from the INSTALLED copy by
  rearm-resident.ps1 (-CompanionHeadless, -CompanionCredential, -CompanionInteractive), verify-resident.ps1 and
  companion-headless-fallback.ps1 (the SYSTEM task that rolls a cut-off switch back).
  install-resident.ps1 and upgrade-apply.ps1 carry the functions they need as their own text, held identical to these by
  test-companion-headless.ps1 (an elevated script never dot-sources a file from a user-writable package directory).

  The password never passes through this file: it is typed only into the Windows credential box on the secure desktop that the
  registrar shows (built for each switch from this generation's CompanionTaskRegistrar.cs: New-CompanionBuild), and goes
  from there to the Task Scheduler (CompanionTaskRegistrar.cs). What comes back here is a code.
#>
Set-StrictMode -Version 2.0

$CompanionTaskName = 'CluedCIResidentCompanion'
$NotifierTaskName = 'CluedCIResidentNotifier'
$CompanionLaunchContract = 'clued.independent-ci.companion-launch/1'
$CompanionPendingContract = 'clued.independent-ci.companion-headless-pending/1'
$CompanionPendingFile = 'install\companion-headless-pending.json'
$CompanionPendingStaleMinutes = 15
$CompanionQualifySeconds = 480
# LastTaskResult values that mean the password logon was refused (ADR 0022 section 4.3), as unsigned 32-bit numbers.
$CompanionLogonFailureCodes = @(0x8007052EL, 0x8007052FL, 0x80070530L, 0x80070531L, 0x80070532L, 0x80070533L, 0x80070569L, 0x80070701L, 0x80070773L, 0x80070775L)   # L: int64, positive (a bare 0x8... literal is a negative Int32)
$CompanionFallbackTaskName = 'CluedCIResidentCompanionFallback'
# The programs each switch builds for itself from this generation's pinned sources (New-CompanionBuild), with install's recipe:
# name -> (source in the resident manifest, program). Only the registrar: the supervisor stays the install's (bin\).
$CompanionBuildPrograms = [ordered]@{ registrar = @('windows/CompanionTaskRegistrar.cs', 'CluedCompanionTaskRegistrar.exe') }
$CompanionBuildSddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$CompanionFramework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$CompanionCsc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
# Variables that make a .NET or node process load foreign code (DESIGN.md section 14 R10; the reinstall launcher's Step-HostHygiene).
$CompanionInjectVariables = '^(COR_ENABLE_PROFILING|COR_PROFILER|COR_PROFILER_PATH(_32|_64)?|CORECLR_.*|COMPlus_.*|DOTNET_.*|NODE_OPTIONS)$'

# ---- Shared with install-resident.ps1 and upgrade-apply.ps1 (test-companion-headless.ps1 holds the copies identical) ----
# The companion task's fixed action (ADR 0022 section 4.2): the supervisor, with the root and nothing else.
function Get-SupervisorAction([string]$root) { [ordered]@{ path = (Join-Path $root 'bin\CluedCompanionSupervisor.exe'); arguments = ('"' + $root + '"') } }
# The task's protection: SYSTEM and Administrators full, the Owner read only (ADR 0022 section 4.1).
function Get-CompanionTaskSddl([string]$ownerSid) { "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;$ownerSid)" }
# The task's DACL as read back is Get-CompanionTaskSddl's, compared as a security descriptor, not as text: protected (P), and the same
# ACEs in the same order (type, flags, rights, SID; each ACE's binary form). Other control bits (AI, AR) are ignored: 2026-11-08, the
# 29th DESK reinstall failed verify on companion-task because the Task Scheduler reads a protected DACL back as D:PAI(...) and a
# D:P(...) cannot be stored at all (flag 0x10 keeps P and adds AI; flag 0 drops P and adds a principal ACE).
# The frozen upgrade channel's copy of Get-CompanionTaskFacts (upgrade-apply.ps1) still compares the text; there it only notes
# COMPANION_TASK_NEEDS_OWNER and never blocks an upgrade.
function Test-CompanionTaskDacl([string]$dacl, [string]$ownerSid) {
  if (-not $dacl) { return $false }
  try {
    $want = [Security.AccessControl.RawSecurityDescriptor]::new((Get-CompanionTaskSddl $ownerSid))
    $have = [Security.AccessControl.RawSecurityDescriptor]::new($dacl)
  } catch { return $false }
  if (([int]$have.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { return $false }
  $a = $want.DiscretionaryAcl; $b = $have.DiscretionaryAcl
  if ($null -eq $b -or $b.Count -ne $a.Count) { return $false }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = [byte[]]::new($a[$i].BinaryLength); $a[$i].GetBinaryForm($x, 0)
    $y = [byte[]]::new($b[$i].BinaryLength); $b[$i].GetBinaryForm($y, 0)
    if ([Convert]::ToBase64String($x) -cne [Convert]::ToBase64String($y)) { return $false }
  }
  $true
}
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
# The companion task with the Owner's interactive token (the install's first registration, and the fall-back that needs no password):
# at log-on, not elevated, the supervisor's fixed action, IgnoreNew, no time limit, no restart on failure. Read back; returns the XML hash.
function Register-CompanionTaskInteractive([string]$root, [string]$ownerSid) {
  $ca = Get-SupervisorAction $root
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = try { $svc.GetFolder('\Clued') } catch { $svc.GetFolder('\').CreateFolder('Clued') }
  $def = $svc.NewTask(0)
  $def.Principal.UserId = $ownerSid; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $t = $def.Triggers.Create(9); $t.UserId = $ownerSid
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT0S'; $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $a = $def.Actions.Create(0); $a.Path = $ca.path; $a.Arguments = $ca.arguments
  $null = $folder.RegisterTaskDefinition('CluedCIResidentCompanion', $def, 6, $null, $null, 3, (Get-CompanionTaskSddl $ownerSid))
  $t = $folder.GetTask('CluedCIResidentCompanion')
  $uid = $t.Definition.Principal.UserId
  $uidSid = if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value }
  $act = if ($t.Definition.Actions.Count -eq 1) { $t.Definition.Actions.Item(1) } else { $null }
  if (($t.Definition.Principal.RunLevel -ne 0) -or ($t.Definition.Principal.LogonType -ne 3) -or ($uidSid -cne $ownerSid) -or $null -eq $act -or $act.Path -cne $ca.path -or $act.Arguments -cne $ca.arguments) { throw 'COMPANION_TASK_READBACK_MISMATCH' }
  $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t.Xml)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
}
# The notifier task (ADR 0022 section 4.3): the Owner's interactive token, not elevated, at log-on, one instance; no password, so the upgrade
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
# What the companion task is now: mode 'password' (ADR 0022 section 4.1, exactly), 'interactive' (the install's first registration or the
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
  if (-not (Test-CompanionTaskDacl $dacl $ownerSid)) { $p += 'sddl' }
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
function Test-CompanionLogonFailure($lastTaskResult) { $null -ne $lastTaskResult -and $CompanionLogonFailureCodes -contains ([int64]$lastTaskResult -band 0xFFFFFFFFL) }

# ---- Lockout margin (ADR 0022 section 4.1): net accounts, read without elevation ----
# The lines are in a fixed order (threshold, duration, window are the 6th to 8th); a threshold that is not a number is "Never" (0).
function ConvertFrom-NetAccounts([string]$text) {
  $lines = @(($text -split "`r?`n") | Where-Object { $_ -match ':' })
  if ($lines.Count -lt 9) { return $null }
  $last = { param([string]$l) ($l.Substring($l.LastIndexOf(':') + 1)).Trim() }
  $t = & $last $lines[5]; $d = & $last $lines[6]; $w = & $last $lines[7]
  if ($d -notmatch '^[0-9]+$' -or $w -notmatch '^[0-9]+$') { return $null }
  [ordered]@{ threshold = $(if ($t -match '^[0-9]+$') { [int]$t } else { 0 }); durationMinutes = [int]$d; windowMinutes = [int]$w }
}
function Test-LockoutMargin($policy) {
  if ($null -eq $policy) { return $false }
  ($policy.threshold -eq 0) -or ($policy.threshold -ge 6 -and $policy.windowMinutes -lt 15)
}
function Get-LockoutPolicy { ConvertFrom-NetAccounts ((& 'C:\Windows\System32\net.exe' accounts) | Out-String) }

# ---- The pending marker (admin-only install\): written before the password, removed only after the elevated side qualified ----
function Read-CompanionPending([string]$root) {
  $f = Join-Path $root $CompanionPendingFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  try { $v = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { return [pscustomobject]@{ contract = $null; startedAt = $null; mode = $null; unreadable = $true } }
  $v
}
function Test-CompanionPendingStale($pending, [DateTimeOffset]$now) {
  if ($null -eq $pending) { return $false }
  $at = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$pending.startedAt, [ref]$at)) { return $true }
  ($now - $at).TotalMinutes -gt $CompanionPendingStaleMinutes
}
# The switch that wrote the marker is still running: its process (pid and start time from the marker) is still there. Review round 2:
# the credential box may stay open for any time, so age alone never rolls back a switch that is still in progress.
function Test-CompanionPendingOwnerAlive($pending) {
  if ($null -eq $pending -or -not (@($pending.PSObject.Properties.Name) -ccontains 'pid') -or -not (@($pending.PSObject.Properties.Name) -ccontains 'processStart')) { return $false }
  $p = Get-Process -Id ([int]$pending.pid) -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $false }
  $start = try { $p.StartTime.ToUniversalTime().ToString('o') } catch { $null }
  $start -ceq [string]$pending.processStart
}
# Abandoned: older than 15 minutes AND the switch that wrote it has ended (window closed, restart, error). Only then is it rolled back.
function Test-CompanionPendingAbandoned($pending, [DateTimeOffset]$now) { (Test-CompanionPendingStale $pending $now) -and -not (Test-CompanionPendingOwnerAlive $pending) }
function Write-CompanionPending([string]$root, [string]$mode, [string]$ownerSid) {
  $me = Get-Process -Id $PID
  $body = [ordered]@{ contract = $CompanionPendingContract; mode = $mode; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); by = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    pid = $PID; processStart = $me.StartTime.ToUniversalTime().ToString('o')
    fallback = [ordered]@{ logonType = 'InteractiveToken'; trigger = 'AtLogOn'; principal = $ownerSid; action = (Get-SupervisorAction $root); sddl = (Get-CompanionTaskSddl $ownerSid) } }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($body | ConvertTo-Json -Depth 5 -Compress))
  $f = [IO.File]::Open((Join-Path $root $CompanionPendingFile), 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}
# Back to the interactive token (no password needed), then the marker goes. Elevated only (the task and install\ are admin-only).
function Invoke-CompanionFallback([string]$root, [string]$ownerSid) {
  $xml = Register-CompanionTaskInteractive $root $ownerSid
  Remove-Item -LiteralPath (Join-Path $root $CompanionPendingFile) -Force -ErrorAction SilentlyContinue
  Remove-CompanionFallbackTask
  [ordered]@{ fellBack = $true; taskXmlSha256 = $xml }
}
# Review round 2 MINOR 5: every roll-back first ends the running instance and waits until it no longer counts as running.
function Invoke-CompanionStopAndFallback([string]$root, [string]$ownerSid) {
  Stop-CompanionTask
  $tree = Get-CompanionProcessTree $root
  foreach ($p in @($tree.supervisors)) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue }
  Wait-CompanionTaskNotRunning
  Invoke-CompanionFallback $root $ownerSid
}
# Review M1: a cut-off switch (a restart, a closed window, an error after the password was registered) is rolled back without anyone:
# before the marker, a SYSTEM task is registered that runs the installed companion-headless-fallback.ps1 at boot and from 16 minutes
# after the start every 15 minutes. That script rolls back only an abandoned marker (older than 15 minutes and its switch no longer
# running), then deletes this task; a qualified switch deletes it at once. No password: SYSTEM and the interactive definition need none.
function Register-CompanionFallbackTask([string]$root, [string]$residentSha) {
  $script = Join-Path $root ('resident\' + $residentSha + '\windows\companion-headless-fallback.ps1')
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'COMPANION_FALLBACK_SCRIPT_MISSING' }
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = $svc.GetFolder('\Clued')
  $def = $svc.NewTask(0)
  $def.Principal.UserId = 'S-1-5-18'; $def.Principal.LogonType = 5; $def.Principal.RunLevel = 1
  $t = $def.Triggers.Create(1); $t.StartBoundary = [DateTime]::Now.AddMinutes($CompanionPendingStaleMinutes + 1).ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
  $t.Repetition.Interval = 'PT15M'
  $b = $def.Triggers.Create(8); $b.Delay = 'PT2M'
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT10M'; $def.Settings.StartWhenAvailable = $true
  $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $a = $def.Actions.Create(0); $a.Path = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $a.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
  $null = $folder.RegisterTaskDefinition($CompanionFallbackTaskName, $def, 6, $null, $null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)')
}
function Remove-CompanionFallbackTask {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  try { $svc.GetFolder('\Clued').DeleteTask($CompanionFallbackTaskName, 0) } catch { }
}
# The fall-back task is there and has not failed: never run (0x41303), running (0x41301) or its last run succeeded (0).
function Test-CompanionFallbackTask {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  try { $t = $svc.GetFolder('\Clued').GetTask($CompanionFallbackTaskName); @(0L, 0x41301L, 0x41303L) -contains ([int64]$t.LastTaskResult -band 0xFFFFFFFFL) } catch { $false }
}
# Review M2: names of variables that would load foreign code into the registrar (a .NET program), in this process or in the Owner's
# HKCU\Environment. The registrar is started with a cleared environment anyway (Invoke-CompanionRegistrar).
function Get-InjectVariables {
  $names = @(Get-ChildItem Env: | Where-Object { $_.Name -match $CompanionInjectVariables } | ForEach-Object { $_.Name })
  $hkcu = try { @((Get-Item -LiteralPath 'HKCU:\Environment' -ErrorAction Stop).GetValueNames() | Where-Object { $_ -match $CompanionInjectVariables }) } catch { @() }
  @($names + $hkcu | Sort-Object -Unique)
}
# ---- The registrar of this generation (2026-11-08, 30th DESK) ----
# bin\CluedCompanionTaskRegistrar.exe is compiled once by the install and the upgrade channel never replaces it, so a fix to
# CompanionTaskRegistrar.cs never reached an installed node: the 30th DESK's registrar imported CredUnpackAuthenticationBufferW (credui.dll
# exports CredUnPackAuthenticationBufferW), and every password typed ended in REGISTRAR_UNEXPECTED. A switch therefore builds the
# registrar for itself from THIS generation's source: install\install-receipt.json names the generation; config\resident-installed-manifest.json
# must hash to it (the generation's name is that manifest's SHA-256) and pin windows/CompanionTaskRegistrar.cs; the source is read once,
# its bytes must have the pinned hash, and exactly those bytes are written into a new directory under the admin-only install\ (SYSTEM and
# Administrators only, protected) and compiled there with install's recipe (Invoke-CompanionSupervisorCompile; test-companion-headless.ps1
# holds the command line identical). The switch uses that program for register-password and token-facts and deletes the directory when
# it ends; a directory left by a switch that was cut off is deleted by the next one. bin\'s registrar stays for the read-only probe; the
# supervisor stays bin\'s.
function Get-CompanionSha256([byte[]]$bytes) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Invoke-CompanionBinaryCompile([string]$compiler, [string]$fw, [string]$exe, [string]$cs) {
  & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $exe) $cs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'COMPANION_BUILD_COMPILE_FAILED' }
}
function Remove-CompanionBuild([string]$dir) {
  $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [IO.Directory]::Delete($dir, $false); return }   # the link only
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}
# Returns directory, generation, and per program (the registrar) its exe, source hash and program hash. Throws a COMPANION_BUILD_*
# code; nothing is left behind then.
function New-CompanionBuild([string]$root, [string]$dacl = $CompanionBuildSddl) {
  $gen = [string](Get-Content -LiteralPath (Join-Path $root 'install\install-receipt.json') -Raw | ConvertFrom-Json).residentManifestSha256
  if ($gen -cnotmatch '^[0-9a-f]{64}\z') { throw 'COMPANION_BUILD_RECEIPT_REFUSED' }
  $manifestBytes = [IO.File]::ReadAllBytes((Join-Path $root 'config\resident-installed-manifest.json'))
  if ((Get-CompanionSha256 $manifestBytes) -cne $gen) { throw 'COMPANION_BUILD_MANIFEST_NOT_THE_GENERATION' }
  $manifest = try { (New-Object Text.UTF8Encoding($false, $true)).GetString($manifestBytes) | ConvertFrom-Json } catch { throw 'COMPANION_BUILD_MANIFEST_UNREADABLE' }
  $sources = [ordered]@{}
  foreach ($name in @($CompanionBuildPrograms.Keys)) {
    $rel = $CompanionBuildPrograms[$name][0]
    $pin = @(@($manifest.files) | Where-Object { $null -ne $_ -and [string]$_.path -ceq $rel })
    if ($pin.Count -ne 1 -or [string]$pin[0].sha256 -cnotmatch '^[0-9a-f]{64}\z') { throw 'COMPANION_BUILD_SOURCE_NOT_PINNED' }
    $bytes = [IO.File]::ReadAllBytes((Join-Path $root ('resident\' + $gen + '\' + $rel.Replace('/', '\'))))
    if ((Get-CompanionSha256 $bytes) -cne [string]$pin[0].sha256) { throw 'COMPANION_BUILD_SOURCE_NOT_THE_GENERATION' }
    $sources[$name] = $bytes
  }
  # Never two switches at once (the marker), so any build directory still here is a cut-off switch's.
  foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $root 'install') -Force -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer -and $_.Name -cmatch '^companion-build-[0-9a-f]{32}\z' })) { Remove-CompanionBuild $d.FullName }
  $dir = Join-Path $root ('install\companion-build-' + [guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $dir) { throw 'COMPANION_BUILD_DIRECTORY_EXISTS' }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm($dacl)
  $null = [IO.Directory]::CreateDirectory($dir, $ds)
  try {
    $build = [ordered]@{ directory = $dir; generation = $gen }
    foreach ($name in @($CompanionBuildPrograms.Keys)) {
      $cs = Join-Path $dir (Split-Path -Leaf $CompanionBuildPrograms[$name][0])
      $bytes = $sources[$name]
      $f = [IO.File]::Open($cs, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
      $exe = Join-Path $dir $CompanionBuildPrograms[$name][1]
      Push-Location $dir
      try { Invoke-CompanionBinaryCompile $CompanionCsc $CompanionFramework $exe $cs } finally { Pop-Location }
      if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'COMPANION_BUILD_COMPILE_FAILED' }
      $build[$name] = [ordered]@{ exe = $exe; sourceSha256 = (Get-CompanionSha256 $bytes); sha256 = (Get-CompanionSha256 ([IO.File]::ReadAllBytes($exe))) }
    }
    $build
  } catch { Remove-CompanionBuild $dir; throw }
}
# The registrar with a cleared, fixed environment (no profiler, no COMPlus_ knob of the Owner's session reaches it). Returns its stdout.
# The registrar's parent is this process: it checks that the pending marker names this process (pid and start time) right before it
# hands the password over (review round 3), so the marker must be written by this same process (Write-CompanionPending uses $PID).
# exe: the switch passes its own build (New-CompanionBuild); bin\'s copy otherwise.
function Invoke-CompanionRegistrar([string]$root, [string[]]$arguments, [string]$exe = (Join-Path $root 'bin\CluedCompanionTaskRegistrar.exe')) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = (($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.EnvironmentVariables.Clear()
  foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('windir', 'C:\Windows'), @('SystemDrive', 'C:'), @('PATH', 'C:\Windows\System32'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  $out
}

# ---- Preflight (read-only) ----
function Get-CompanionHeadlessPreflight([string]$root, $node) {
  $refusals = @()
  $lsa = try { (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name 'DisableDomainCreds' -ErrorAction Stop).DisableDomainCreds } catch { 0 }
  if ([int]$lsa -ne 0) { $refusals += 'COMPANION_HEADLESS_DOMAIN_CREDS_DISABLED' }
  $lock = Get-LockoutPolicy
  if (-not (Test-LockoutMargin $lock)) { $refusals += 'COMPANION_LOCKOUT_MARGIN_INSUFFICIENT' }
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts' -ErrorAction SilentlyContinue
  $user = try { Get-LocalUser -SID ([string]$node.ownerSid) -ErrorAction Stop } catch { $null }
  if ($null -eq $user) { $refusals += 'COMPANION_HEADLESS_OWNER_NOT_LOCAL' }
  elseif ([string]$user.PrincipalSource -ceq 'MicrosoftAccount') { $refusals += 'COMPANION_HEADLESS_MSA_UNSUPPORTED' }
  # The companion's own gh login: presence only (the companion checks the shape itself and fails closed); nothing here reads the token.
  $gh = Get-CompanionGhDirs ([string]$node.ownerProfileDirectory)
  $hosts = Join-Path $gh.gh 'hosts.yml'; $gitconfig = Join-Path $gh.home '.gitconfig'
  $ghReady = (Test-Path -LiteralPath $hosts -PathType Leaf) -and (Test-Path -LiteralPath $gitconfig -PathType Leaf)
  if (-not $ghReady) { $refusals += 'COMPANION_GH_CONFIG_MISSING' }
  foreach ($exe in @('bin\CluedCompanionSupervisor.exe', 'bin\CluedCompanionTaskRegistrar.exe', 'config\companion-launch.json')) { if (-not (Test-Path -LiteralPath (Join-Path $root $exe) -PathType Leaf)) { $refusals += ('COMPANION_HEADLESS_NOT_INSTALLED:' + $exe) } }
  if (-not (Test-Path -LiteralPath $CompanionCsc -PathType Leaf)) { $refusals += 'COMPANION_HEADLESS_COMPILER_MISSING' }   # the switch builds its registrar
  $inject = @(Get-InjectVariables)
  if ($inject.Count) { $refusals += ('COMPANION_HEADLESS_INJECTION_VARIABLES:' + ($inject -join ',')) }
  [ordered]@{ refusals = $refusals; disableDomainCreds = [int]$lsa; lockout = $lock
    owner = $(if ($user) { [ordered]@{ principalSource = [string]$user.PrincipalSource; passwordRequired = [bool]$user.PasswordRequired; passwordExpires = $(if ($user.PasswordExpires) { ([DateTime]$user.PasswordExpires).ToString('o') } else { $null }) } } else { $null })
    companionGhConfig = $ghReady }
}

# ---- Qualification, from the elevated side (ADR 0022 section 4.4 step 5): never the companion's own report alone ----
function Get-CompanionProcessTree([string]$root) {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1'
  $sup = Join-Path $root 'bin\CluedCompanionSupervisor.exe'; $node = Join-Path $root 'runtime\node.exe'
  $all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='CluedCompanionSupervisor.exe' OR Name='node.exe'")
  $sups = @($all | Where-Object { [string]::Equals([string]$_.ExecutablePath, $sup, [StringComparison]::OrdinalIgnoreCase) })
  $children = @($all | Where-Object { [string]::Equals([string]$_.ExecutablePath, $node, [StringComparison]::OrdinalIgnoreCase) -and (@($sups | ForEach-Object { [int]$_.ProcessId }) -contains [int]$_.ParentProcessId) })
  [ordered]@{ supervisors = $sups; children = $children }
}
function Get-ProcessTokenFacts([string]$root, [int]$processId, [string]$registrar = (Join-Path $root 'bin\CluedCompanionTaskRegistrar.exe')) {
  $out = Invoke-CompanionRegistrar $root @('token-facts', [string]$processId) $registrar
  try { $out | ConvertFrom-Json } catch { $null }
}
# One look: $null when everything holds, else the first check that does not. since: when the switch began (UTC).
function Test-CompanionQualifiedOnce([string]$root, [string]$ownerSid, [DateTimeOffset]$since, [string]$registrar = (Join-Path $root 'bin\CluedCompanionTaskRegistrar.exe')) {
  $launch = try { Get-Content -LiteralPath (Join-Path $root 'config\companion-launch.json') -Raw | ConvertFrom-Json } catch { return 'launch-file' }
  $tree = Get-CompanionProcessTree $root
  if (@($tree.supervisors).Count -ne 1) { return 'supervisor-process' }
  $child = @($tree.children | Where-Object { ([string]$_.CommandLine).Contains('--config-sha256 ' + [string]$launch.configSha256) -and ([string]$_.CommandLine).Contains([string]$launch.entry) })
  if ($child.Count -ne 1) { return 'companion-process' }
  # Review B1: the heartbeat and the Linux fact must come from THIS child: written after it started (an older instance kept writing both).
  $childStart = [DateTimeOffset]::new([DateTime]$child[0].CreationDate)
  if ($childStart -lt $since) { return 'companion-process-older-than-the-switch' }
  $since = $childStart
  foreach ($p in @(@($tree.supervisors[0], (Join-Path $root 'bin\CluedCompanionSupervisor.exe')), @($child[0], [string]$launch.nodeExe))) {
    $f = Get-ProcessTokenFacts $root ([int]$p[0].ProcessId) $registrar
    if ($null -eq $f -or $f.code -cne 'TOKEN_FACTS') { return 'token-unreadable' }
    if ($f.userSid -cne $ownerSid) { return 'token-user' }
    if ($f.elevationType -eq 2 -or ($f.adminsPresent -and -not $f.adminsDenyOnly)) { return 'token-elevated' }
    if ($f.sessionId -ne 0) { return 'session-not-0' }
    if (-not [string]::Equals([string]$f.imagePath, [string]$p[1], [StringComparison]::OrdinalIgnoreCase)) { return 'image-path' }
  }
  $hb = try { (Get-Content -LiteralPath (Join-Path $root 'mailbox\responses\heartbeat.json') -Raw | ConvertFrom-Json).at } catch { $null }
  if (-not ($hb -is [long] -or $hb -is [int]) -or $hb -lt $since.ToUnixTimeMilliseconds()) { return 'heartbeat' }
  # A Linux fact written since: the companion ran the root tool in WSL from session 0 (version facts, DESIGN 34; refreshed at its start).
  $facts = Join-Path $root 'upgrade\mailbox\responses\version-facts.json'
  if (-not (Test-Path -LiteralPath $facts -PathType Leaf) -or (Get-Item -LiteralPath $facts).LastWriteTimeUtc -lt $since.UtcDateTime) { return 'linux-facts' }
  $null
}
function Wait-CompanionQualified([string]$root, [string]$ownerSid, [DateTimeOffset]$since, [int]$seconds = $CompanionQualifySeconds, [string]$registrar = (Join-Path $root 'bin\CluedCompanionTaskRegistrar.exe')) {
  $until = [DateTime]::UtcNow.AddSeconds($seconds); $why = 'not-started'
  while ([DateTime]::UtcNow -lt $until) {
    $why = Test-CompanionQualifiedOnce $root $ownerSid $since $registrar
    if ($null -eq $why) { return $null }
    Start-Sleep -Seconds 10
  }
  $why
}
# Ends the companion processes of this root (node children and job hosts), not the task: the supervisor starts the child again.
function Stop-CompanionChildren([string]$root) {
  $tree = Get-CompanionProcessTree $root
  foreach ($p in @($tree.children)) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue }
  @($tree.children | ForEach-Object { [int]$_.ProcessId })
}
# Stops the task's running instance (the supervisor, and with its job the companion). Elevated.
function Stop-CompanionTask {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $task = try { $svc.GetFolder('\Clued').GetTask('CluedCIResidentCompanion') } catch { $null }
  if ($null -ne $task) { try { $task.Stop(0) } catch { } }
}
# Review MINOR 2: until the task's instance no longer counts as running (IgnoreNew would drop the next Run), at most 30 s.
function Wait-CompanionTaskNotRunning {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $until = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $until) {
    $state = try { [int]$svc.GetFolder('\Clued').GetTask('CluedCIResidentCompanion').State } catch { 0 }
    if ($state -ne 4) { return }
    Start-Sleep -Milliseconds 500
  }
}
function Start-CompanionTask {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $null = $svc.GetFolder('\Clued').GetTask('CluedCIResidentCompanion').Run($null)
}

# The whole switch: -CompanionHeadless (mode 'headless') and -CompanionCredential (mode 'credential') are the same steps; the
# credential mode is the one to use after the Owner changed the Windows password. Elevated only. Returns the result object.
function Invoke-CompanionHeadless([string]$root, $node, [string]$mode) {
  $ownerSid = [string]$node.ownerSid
  $result = [ordered]@{ mode = $mode; preflight = $null; registrar = $null; qualified = $false; failed = $null; fellBack = $false; task = $null }
  $pending = Read-CompanionPending $root
  if ($null -ne $pending) {
    # Another switch is still running (its window is open): never two at once.
    if (Test-CompanionPendingOwnerAlive $pending) { $result.failed = 'COMPANION_HEADLESS_SWITCH_IN_PROGRESS'; return $result }
    # An earlier switch was cut off (window closed, restart): back to the interactive token first, never left unqualified.
    $null = Invoke-CompanionStopAndFallback $root $ownerSid
    $result.earlierPendingFellBack = $true
  }
  $result.preflight = Get-CompanionHeadlessPreflight $root $node
  if (@($result.preflight.refusals).Count) { $result.failed = 'PREFLIGHT'; return $result }
  # 2026-11-08 (30th DESK): this generation's registrar, built for this switch (New-CompanionBuild), never bin\'s. Before the fall-back
  # task and the marker: a build that fails changes nothing.
  $build = $null
  try { $build = New-CompanionBuild $root } catch { $why = [string]$_.Exception.Message; $result.failed = 'COMPANION_BUILD_FAILED:' + $(if ($why -cmatch '^COMPANION_BUILD_[A-Z_]{1,60}\z') { $why } else { 'UNEXPECTED' }) }
  if ($null -eq $build) { return $result }
  $result.build = [ordered]@{ generation = $build.generation; registrarSourceSha256 = $build.registrar.sourceSha256; registrarSha256 = $build.registrar.sha256 }
  try {
    # Review round 2 MINOR 1: the fall-back task first (a marker never exists without it), then the marker.
    Register-CompanionFallbackTask $root ([string](Get-Content -LiteralPath (Join-Path $root 'install\install-receipt.json') -Raw | ConvertFrom-Json).residentManifestSha256)
    Write-CompanionPending $root $mode $ownerSid
    $reg = Invoke-CompanionRegistrar $root @('register-password', $root) $build.registrar.exe
    # The registrar's code (a fixed code, never text); for REGISTRAR_UNEXPECTED also where it stopped (step:ExceptionType:0xHRESULT), for
    # CREDENTIAL_UNPACK_FAILED the two unpack error numbers; each kept only in exactly that shape.
    $code = try { [string]($reg | ConvertFrom-Json).code } catch { 'REGISTRAR_OUTPUT_UNREADABLE' }
    $result.registrar = if ($code -cmatch '^[A-Z][A-Z0-9_]{0,63}\z') { $code } else { 'REGISTRAR_OUTPUT_UNREADABLE' }
    $detailShape = @{ REGISTRAR_UNEXPECTED = '^[a-z]{1,16}:[A-Za-z0-9_]{1,40}:0x[0-9A-F]{8}\z'; CREDENTIAL_UNPACK_FAILED = '^protected:-?[0-9]{1,10}:plain:(-?[0-9]{1,10}|skipped)\z' }
    if ($detailShape.ContainsKey($result.registrar)) {
      $detail = try { [string]($reg | ConvertFrom-Json).detail } catch { $null }
      if ($detail -cmatch $detailShape[$result.registrar]) { $result.registrarDetail = $detail }
    }
    if ($result.registrar -cne 'REGISTERED') {
      # Nothing was changed (or a refused registration left the old definition): back to the known interactive definition anyway.
      $null = Invoke-CompanionFallback $root $ownerSid
      $result.fellBack = $true; $result.failed = $result.registrar
      return $result
    }
    # The old instance (the interactive session's supervisor, and with its job the companion) ends; the password task is then run from
    # the elevated side (IgnoreNew would ignore a Run while an instance still counts as running).
    Stop-CompanionTask
    $tree = Get-CompanionProcessTree $root
    foreach ($p in @($tree.supervisors)) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue }
    Wait-CompanionTaskNotRunning
    # Review B1: from here on; the old instance has ended, so nothing it wrote counts.
    $since = [DateTimeOffset]::UtcNow
    try { Start-CompanionTask } catch { $result.runError = 'COMPANION_TASK_RUN_FAILED' }
    $why = Wait-CompanionQualified $root $ownerSid $since -registrar $build.registrar.exe
    $result.task = Get-CompanionTaskFacts $root $ownerSid
    if ($null -eq $why -and $result.task.mode -ceq 'password') {
      Remove-Item -LiteralPath (Join-Path $root $CompanionPendingFile) -Force -ErrorAction SilentlyContinue
      Remove-CompanionFallbackTask
      $result.qualified = $true
      return $result
    }
    $result.failed = 'COMPANION_HEADLESS_QUALIFICATION_FAILED:' + $(if ($why) { $why } else { 'task-' + $result.task.mode })
    $null = Invoke-CompanionStopAndFallback $root $ownerSid
    # The interactive task runs in the Owner's session (it is there: he started this); without a session it starts at the next log-on.
    try { Start-CompanionTask } catch { }
    $result.fellBack = $true
    $result
  } finally { Remove-CompanionBuild $build.directory }
}

# ==== M5-b (ADR 0023): the companion as its own non-administrator local account ====
# On such a node the node profile's ownerSid / ownerProfileDirectory are the companion account's (the account the companion, the relay
# and the incoming spool writer run as: Source prepare-record.mjs), so everything above (the task, its SDDL, the launch file, the
# qualification's token check) already names that account; the Owner is the install's operator, recorded by the install in
# install\companion-account.json. The account's password is random and known to nobody (CompanionTaskRegistrar.cs register-account).
$CompanionAccountFile = 'install\companion-account.json'
$CompanionAccountContract = 'clued.independent-ci.companion-account/1'
$CompanionWslFile = 'install\companion-wsl.json'
$CompanionWslContract = 'clued.independent-ci.companion-wsl/1'
$CompanionImportTaskName = 'CluedCIResidentCompanionWslImport'
$CompanionSidPattern = '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z'
# The registrar's ValidVhdx (CompanionTaskRegistrar.cs), here for the directory: a drive, 1 to 15 plain names.
$CompanionVhdxDirPattern = '^[A-Z]:\\(?:[A-Za-z0-9._-]{1,64}\\){0,14}[A-Za-z0-9._-]{1,64}\z'

# $null when this node's companion runs as the Owner (no record); else the record, checked against the node profile (throws if it
# does not fit: never guess who the Owner is).
function Read-CompanionAccountRecord([string]$root, $node) {
  $f = Join-Path $root $CompanionAccountFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  $a = (New-Object Text.UTF8Encoding($false, $true)).GetString([IO.File]::ReadAllBytes($f)) | ConvertFrom-Json
  if (-not (Test-CompanionAccountRecord $a $node)) { throw 'COMPANION_ACCOUNT_RECORD_REFUSED' }
  $a
}
function Test-CompanionAccountRecord($a, $node) {
  $names = @(if ($a -is [pscustomobject]) { $a.PSObject.Properties.Name })
  ($names.Count -eq 3) -and ($names -ccontains 'contract') -and ($names -ccontains 'companionSid') -and ($names -ccontains 'operatorSid') -and
    [string]$a.contract -ceq $CompanionAccountContract -and [string]$a.companionSid -ceq [string]$node.ownerSid -and [string]$a.companionSid -cmatch $CompanionSidPattern -and
    [string]$a.operatorSid -cmatch $CompanionSidPattern -and [string]$a.operatorSid -cne [string]$a.companionSid
}
# Who may run the elevated companion modes and the Owner's requests: the operator on an M5-b node, the profile's ownerSid otherwise.
function Get-CompanionOperatorSid([string]$root, $node) { $a = Read-CompanionAccountRecord $root $node; if ($null -eq $a) { [string]$node.ownerSid } else { [string]$a.operatorSid } }

# The moved ext4.vhdx and its folder: SYSTEM and Administrators full, the companion account modify (WSL opens it as that user), nothing
# inherited, nothing for the Owner's session. Missing parents of the folder are created SYSTEM / Administrators full, Users read.
$CompanionVhdxParentSddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
function Get-CompanionVhdxSddl([string]$companionSid) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $companionSid + ')' }
# The current user's WSL registrations (Lxss): guid, name, base path (the \\?\ prefix dropped), default uid and every value of the key
# (review r1 M4: VhdFileName, PackageFamilyName, KernelCommandLine, DefaultEnvironment, Flavor, OsVersion, ... all of them).
$CompanionLxssKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
function Get-WslRegistrations {
  if (-not (Test-Path -LiteralPath $CompanionLxssKey)) { return @() }
  @(Get-ChildItem -LiteralPath $CompanionLxssKey | ForEach-Object {
    $key = $_
    $values = [ordered]@{}
    foreach ($n in @($key.GetValueNames())) { $v = $key.GetValue($n, $null, 'DoNotExpandEnvironmentNames'); $values[$(if ($n) { $n } else { '(default)' })] = $(if ($v -is [byte[]]) { [Convert]::ToBase64String($v) } else { $v }) }
    [ordered]@{ guid = $key.PSChildName; name = $(if ($values.Contains('DistributionName')) { [string]$values['DistributionName'] } else { $null })
      basePath = $(if ($values.Contains('BasePath')) { ([string]$values['BasePath']) -replace '^\\\\\?\\', '' } else { $null })
      defaultUid = $(if ($values.Contains('DefaultUid')) { [int64]$values['DefaultUid'] } else { $null }); values = $values }
  })
}
# The registry steps of the move, each its own function (the offline tests replace them). The export is reg.exe's own full copy of the
# key (every value with its type), written to the admin-only install\ before anything changes.
function Export-CompanionLxssKey([string]$guid, [string]$file) {
  $null = & 'C:\Windows\System32\reg.exe' export ('HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\' + $guid) $file /y 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'WSL_OWNER_REGISTRATION_NOT_EXPORTED' }
}
function Import-CompanionLxssKey([string]$file) { $null = & 'C:\Windows\System32\reg.exe' import $file 2>&1; if ($LASTEXITCODE -ne 0) { throw 'WSL_OWNER_REGISTRATION_NOT_IMPORTED' } }
function Remove-CompanionLxssKey([string]$guid) { Remove-Item -LiteralPath (Join-Path $CompanionLxssKey $guid) -Recurse -Force }
function Get-CompanionLxssDefault { try { [string](Get-ItemProperty -LiteralPath $CompanionLxssKey -Name 'DefaultDistribution' -ErrorAction Stop).DefaultDistribution } catch { $null } }
function Remove-CompanionLxssDefault { Remove-ItemProperty -LiteralPath $CompanionLxssKey -Name 'DefaultDistribution' -Force }
function Invoke-CompanionWslTerminate([string]$distro) { $null = & 'C:\Windows\System32\wsl.exe' --terminate $distro 2>&1 }
function Test-CompanionSameVolume([string]$a, [string]$b) { [string]::Equals([IO.Path]::GetPathRoot($a), [IO.Path]::GetPathRoot($b), [StringComparison]::OrdinalIgnoreCase) }
function Get-CompanionDirSddl([string]$path) { (Get-Acl -LiteralPath $path).Sddl }
function New-CompanionProtectedDirectory([string]$path, [string]$sddl) { $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($sddl); [void][IO.Directory]::CreateDirectory($path, $ds) }
function Set-CompanionVhdxAcl([string]$dir, [string]$file, [string]$companionSid) {
  $sddl = Get-CompanionVhdxSddl $companionSid
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access)
  (Get-Item -LiteralPath $dir -Force).SetAccessControl($ds)
  $fs = New-Object Security.AccessControl.FileSecurity; $fs.SetSecurityDescriptorSddlForm($sddl.Replace('(A;OICI;', '(A;;'), [Security.AccessControl.AccessControlSections]::Access)
  (Get-Item -LiteralPath $file -Force).SetAccessControl($fs)
}
# The file moved back on a roll-back gets its folder's inherited ACL again (only the DACL).
function Set-CompanionOwnerFileAcl([string]$file) {
  $fs = New-Object Security.AccessControl.FileSecurity; $fs.SetSecurityDescriptorSddlForm('D:', [Security.AccessControl.AccessControlSections]::Access)
  (Get-Item -LiteralPath $file -Force).SetAccessControl($fs)
}
# Review r1 M1 (pure): a folder on the way to the vhdx is safe when its owner is SYSTEM, Administrators or TrustedInstaller and no entry
# that applies to the folder itself (inherit-only ones do not) gives anyone else DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER or
# GENERIC_ALL. A drive root cannot be deleted or renamed, so DELETE alone is not counted there (D:\ gives Authenticated Users modify
# on itself). $null, 'unreadable', 'owner' or 'ace:<sid>'.
$CompanionTrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Get-CompanionDirAclProblem([string]$sddl, [bool]$isRoot) {
  $raw = try { New-Object Security.AccessControl.RawSecurityDescriptor($sddl) } catch { return 'unreadable' }
  if ($null -eq $raw.Owner -or $CompanionTrustedSids -cnotcontains $raw.Owner.Value) { return 'owner' }
  if ($null -eq $raw.DiscretionaryAcl) { return 'unreadable' }
  $danger = 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000
  if (-not $isRoot) { $danger = $danger -bor 0x10000 }
  foreach ($a in $raw.DiscretionaryAcl) {
    if (-not ($a -is [Security.AccessControl.CommonAce]) -or $a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
    if (([int]$a.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
    if ($CompanionTrustedSids -ccontains $a.SecurityIdentifier.Value) { continue }
    if (($a.AccessMask -band $danger) -ne 0) { return ('ace:' + $a.SecurityIdentifier.Value) }
  }
  $null
}
# Every folder from the drive root down to the vhdx's folder: an existing one must be a real folder (no link) and safe; a missing one is
# created protected and read back (CreateDirectory does not apply a DACL to a folder someone created meanwhile). Returns the created ones.
function Assert-CompanionVhdxParents([string]$targetDir) {
  $chain = @(); for ($d = $targetDir; $d; $d = Split-Path -Parent $d) { $chain = @($d) + $chain }
  $created = @()
  foreach ($d in $chain) {
    $isRoot = ([IO.Path]::GetPathRoot($d).TrimEnd('\') -ieq $d.TrimEnd('\'))
    if (Test-Path -LiteralPath $d) {
      if (-not $isRoot -and ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'WSL_TARGET_PARENT_IS_A_LINK' }
      if ($null -ne (Get-CompanionDirAclProblem (Get-CompanionDirSddl $d) $isRoot)) { throw 'WSL_TARGET_PARENT_UNSAFE' }
    } else {
      New-CompanionProtectedDirectory $d $CompanionVhdxParentSddl
      if (((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $null -ne (Get-CompanionDirAclProblem (Get-CompanionDirSddl $d) $false)) { throw 'WSL_TARGET_PARENT_READBACK_MISMATCH' }
      $created += $d
    }
  }
  ,$created
}
# What the move has to do (pure). registration: the Owner's registration of the distribution or $null; sourceExists: its ext4.vhdx is
# there; targetDir: where it goes; targetExists: ext4.vhdx is already there. action: move, forget (the file is already in the target),
# done, or refuse with the code. sameVolume: Test-CompanionSameVolume.
function Get-CompanionWslMovePlan($registration, [bool]$sourceExists, [string]$targetDir, [bool]$targetExists) {
  if ($targetDir -cnotmatch $CompanionVhdxDirPattern -or $targetDir.Contains('\..') -or $targetDir.Contains('\.\')) { return [ordered]@{ action = 'refuse'; code = 'WSL_TARGET_REFUSED' } }
  if ($null -eq $registration) {
    if ($targetExists) { return [ordered]@{ action = 'done'; code = $null } }
    return [ordered]@{ action = 'refuse'; code = 'WSL_DISTRIBUTION_NOT_FOUND' }
  }
  $src = [string]$registration.basePath
  if ($src -cnotmatch '^[A-Za-z]:\\') { return [ordered]@{ action = 'refuse'; code = 'WSL_SOURCE_REFUSED' } }
  if ([string]::Equals($src.TrimEnd('\'), $targetDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    if ($targetExists) { return [ordered]@{ action = 'forget'; code = $null } }
    return [ordered]@{ action = 'refuse'; code = 'WSL_SOURCE_MISSING' }
  }
  if ($sourceExists -and $targetExists) { return [ordered]@{ action = 'refuse'; code = 'WSL_TARGET_EXISTS' } }
  if (-not $sourceExists -and $targetExists) { return [ordered]@{ action = 'forget'; code = $null } }
  if (-not $sourceExists) { return [ordered]@{ action = 'refuse'; code = 'WSL_SOURCE_MISSING' } }
  [ordered]@{ action = 'move'; code = $null; sameVolume = (Test-CompanionSameVolume $src $targetDir) }
}
function Get-CompanionFileSha256([string]$path) { $s = [Security.Cryptography.SHA256]::Create(); $f = [IO.File]::OpenRead($path); try { ([BitConverter]::ToString($s.ComputeHash($f))).Replace('-', '').ToLowerInvariant() } finally { $f.Dispose(); $s.Dispose() } }
# Review r1 m3: the copy's target hashed from the disk, not from the cache that just wrote it: the registrar of this switch reads it with
# FILE_FLAG_NO_BUFFERING (file-sha256). $CompanionRegistrarExe is set by the switch.
$CompanionRegistrarExe = $null
function Get-CompanionFileSha256Unbuffered([string]$path) {
  if (-not $script:CompanionRegistrarExe) { throw 'WSL_HASH_TOOL_MISSING' }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:CompanionRegistrarExe; $psi.Arguments = 'file-sha256 "' + $path + '"'
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = 'C:\Windows\System32'
  # Review r2 n5: the same cleared, fixed environment as Invoke-CompanionRegistrar (no profiler or COMPlus_ knob reaches it).
  $psi.EnvironmentVariables.Clear()
  foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('windir', 'C:\Windows'), @('SystemDrive', 'C:'), @('PATH', 'C:\Windows\System32;C:\Windows'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
  $p = [Diagnostics.Process]::Start($psi); $o = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  $v = try { $o | ConvertFrom-Json } catch { $null }
  if ($null -eq $v -or [string]$v.code -cne 'FILE_SHA256' -or [string]$v.sha256 -cnotmatch '^[0-9a-f]{64}\z') { throw 'WSL_HASH_UNREADABLE' }
  [string]$v.sha256
}
# Review r1 M3: copies source to partial (CreateNew, write-through) hashing what it reads, then hashes partial from the disk; any
# exception deletes partial (never a half file under the final name). progress: called with the bytes copied so far after each chunk.
function Copy-CompanionFileVerified([string]$source, [string]$partial, [scriptblock]$progress) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $in = New-Object IO.FileStream($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None, 4194304)
    try {
      $out = New-Object IO.FileStream($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4194304, [IO.FileOptions]::WriteThrough)
      try {
        $buf = New-Object byte[] 4194304; $done = 0L
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
          [void]$sha.TransformBlock($buf, 0, $n, $null, 0); $out.Write($buf, 0, $n); $done += $n
          if ($progress) { & $progress $done }
        }
        [void]$sha.TransformFinalBlock($buf, 0, 0); $out.Flush($true)
      } finally { $out.Dispose() }
      $length = $in.Length
    } finally { $in.Dispose() }
    $read = ([BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()
    [ordered]@{ sourceSha256 = $read; targetSha256 = (Get-CompanionFileSha256Unbuffered $partial); length = $length }
  } catch {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    throw
  } finally { $sha.Dispose() }
}
# The vhdx is free: opened with no sharing (the distribution no longer runs). At most $seconds.
function Wait-CompanionVhdxFree([string]$path, [int]$seconds = 120) {
  $until = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    try { $f = [IO.File]::Open($path, 'Open', 'ReadWrite', 'None'); $f.Dispose(); return $true } catch { Start-Sleep -Seconds 2 }
  } while ([DateTime]::UtcNow -lt $until)
  $false
}
function Read-CompanionWslRecord([string]$root) {
  $f = Join-Path $root $CompanionWslFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { $null }
}
function Write-CompanionWslRecord([string]$root, $record) {
  $f = Join-Path $root $CompanionWslFile
  $tmp = $f + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($tmp, ($record | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $f) { [IO.File]::Replace($tmp, $f, [NullString]::Value) } else { [IO.File]::Move($tmp, $f) }
}
function Set-CompanionWslStage($record, [string]$stage) { if ($record -is [Collections.IDictionary]) { $record['stage'] = $stage } else { $record.stage = $stage } }
# The move (review r1 M4), as stages kept in install\companion-wsl.json (admin-only) so a cut-off switch resumes and a roll-back finds
# everything: exported (the Owner's full registration key, reg.exe's own copy, in install\ and its values in the record) -> moved
# (ext4.vhdx in targetDir, protected) -> imported (the account's import task returned 0) -> forgotten (the Owner's key removed) ->
# qualified. This function does exported and moved; nothing of the Owner's registration is removed here. Returns the record.
function Invoke-CompanionWslMove([string]$root, [string]$distro, [string]$targetDir, [string]$companionSid) {
  $target = Join-Path $targetDir 'ext4.vhdx'; $partial = $target + '.partial'
  $existing = Read-CompanionWslRecord $root
  $record = if ($null -ne $existing) { $existing } else { [ordered]@{ contract = $CompanionWslContract; distro = $distro; target = $target; companionSid = $companionSid; stage = 'new'; imported = $false } }
  if ([string]$record.target -cne $target -or [string]$record.distro -cne $distro) { throw 'WSL_RECORD_IS_ANOTHER_MOVE' }
  if (@('moved', 'imported', 'forgotten', 'qualified') -ccontains [string]$record.stage -and (Test-Path -LiteralPath $target -PathType Leaf)) { return $record }
  # Review r2 n4: cut after the copy was verified (stage 'copied', with its hash): the copy is finished from the record, never copied again.
  if ([string]$record.stage -ceq 'copied') {
    $want = [string]$record.copy.targetSha256
    if (-not (Test-Path -LiteralPath $target -PathType Leaf) -and (Test-Path -LiteralPath $partial -PathType Leaf)) {
      if ((Get-CompanionFileSha256Unbuffered $partial) -cne $want) { throw 'WSL_COPY_HASH_MISMATCH' }
      [IO.File]::Move($partial, $target)
    } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
      if ((Get-CompanionFileSha256Unbuffered $target) -cne $want) { throw 'WSL_TARGET_NOT_THE_COPY' }
    } else { throw 'WSL_COPY_MISSING' }
    if ($record.source -and (Test-Path -LiteralPath ([string]$record.source) -PathType Leaf)) { Remove-Item -LiteralPath ([string]$record.source) -Force }
    Set-CompanionVhdxAcl $targetDir $target $companionSid
    $record = ConvertTo-CompanionOrdered $record
    $record.stage = 'moved'; $record.imported = $false; $record.movedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-CompanionWslRecord $root $record
    return $record
  }
  $reg = @(Get-WslRegistrations | Where-Object { $_.name -ceq $distro })
  if ($reg.Count -gt 1) { throw 'WSL_REGISTRATION_AMBIGUOUS' }
  $r = if ($reg.Count) { $reg[0] } else { $null }
  $source = if ($r) { Join-Path ([string]$r.basePath) 'ext4.vhdx' } elseif ($existing) { [string]$existing.source } else { $null }
  $plan = Get-CompanionWslMovePlan $r ([bool]($source -and (Test-Path -LiteralPath $source -PathType Leaf))) $targetDir (Test-Path -LiteralPath $target -PathType Leaf)
  if ($plan.action -ceq 'refuse') { throw $plan.code }
  # 1. exported: before anything changes
  if ($null -ne $r -and -not ($record.PSObject.Properties.Name -ccontains 'ownerExport' -or ($record -is [Collections.IDictionary] -and $record.Contains('ownerExport')))) {
    $file = Join-Path $root ('install\companion-wsl-owner-' + ([string]$r.guid).Trim('{}') + '.reg')
    Export-CompanionLxssKey ([string]$r.guid) $file
    $record = [ordered]@{ contract = $CompanionWslContract; distro = $distro; target = $target; companionSid = $companionSid; stage = 'exported'; imported = $false
      source = $source; ownerRegistration = $r; ownerExport = $file; ownerDefaultDistribution = (Get-CompanionLxssDefault); at = [DateTimeOffset]::UtcNow.ToString('o') }
    Write-CompanionWslRecord $root $record
  }
  # 2. moved
  if ($plan.action -ceq 'move' -or $plan.action -ceq 'forget') {
    Invoke-CompanionWslTerminate $distro
    if ($source -and (Test-Path -LiteralPath $source -PathType Leaf)) { if (-not (Wait-CompanionVhdxFree $source)) { throw 'WSL_VHDX_STILL_IN_USE' } }
    $created = Assert-CompanionVhdxParents $targetDir
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }   # a cut-off copy of this move (its own name, in its own folder)
    $copy = $null
    if ($plan.action -ceq 'move') {
      if ($plan.sameVolume) { [IO.File]::Move($source, $target) }
      else {
        $copy = Copy-CompanionFileVerified $source $partial
        if ($copy.sourceSha256 -cne $copy.targetSha256) { Remove-Item -LiteralPath $partial -Force; throw 'WSL_COPY_HASH_MISMATCH' }
        # Review r2 n4: 'copied' with the hash before the rename and the delete, so a cut between them resumes (above).
        $record = ConvertTo-CompanionOrdered $record
        $record.stage = 'copied'; $record.copy = $copy; $record.source = $source
        Write-CompanionWslRecord $root $record
        [IO.File]::Move($partial, $target)
        Remove-Item -LiteralPath $source -Force
      }
    }
    Set-CompanionVhdxAcl $targetDir $target $companionSid
    $record = ConvertTo-CompanionOrdered $record
    $record.stage = 'moved'; $record.imported = $false; $record.copy = $copy; $record.parentsCreated = $created; $record.movedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-CompanionWslRecord $root $record
  }
  $record
}
function ConvertTo-CompanionOrdered($o) {
  if ($o -is [Collections.IDictionary]) { $h = [ordered]@{}; foreach ($k in $o.Keys) { $h[$k] = $o[$k] }; return $h }
  $h = [ordered]@{}; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }; $h
}
# After the account's import returned 0 (review r1 M4): the Owner's registration key goes, and the default distribution when it named it.
function Remove-CompanionOwnerRegistration([string]$root, $record) {
  $record = ConvertTo-CompanionOrdered $record
  $guid = if ($record.Contains('ownerRegistration') -and $null -ne $record.ownerRegistration) { [string]$record.ownerRegistration.guid } else { $null }
  if ($guid) {
    $still = @(Get-WslRegistrations | Where-Object { $_.guid -ceq $guid -and $_.name -ceq [string]$record.distro })
    if ($still.Count) { Remove-CompanionLxssKey $guid }
    if ((Get-CompanionLxssDefault) -ceq $guid) { Remove-CompanionLxssDefault }
  }
  $record.stage = 'forgotten'; $record.forgottenAt = [DateTimeOffset]::UtcNow.ToString('o')
  Write-CompanionWslRecord $root $record
  $record
}
# Runs the one-shot import task once and deletes it: its last result (the import script's exit code), 'timeout' or 'not-registered'.
function Invoke-CompanionWslImportTask {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = $svc.GetFolder('\Clued')
  $task = try { $folder.GetTask($CompanionImportTaskName) } catch { $null }
  if ($null -eq $task) { return 'not-registered' }
  try {
    $before = $task.LastRunTime
    $null = $task.Run($null)
    $until = [DateTime]::UtcNow.AddMinutes(10)
    do { Start-Sleep -Seconds 2; $t = $folder.GetTask($CompanionImportTaskName) } while ([DateTime]::UtcNow -lt $until -and ([int]$t.State -eq 4 -or $t.LastRunTime -eq $before))
    if ([int]$t.State -eq 4) { try { $t.Stop(0) } catch { }; return 'timeout' }
    ([int64]$t.LastTaskResult -band 0xFFFFFFFFL)
  } finally { try { $folder.DeleteTask($CompanionImportTaskName, 0) } catch { } }
}
# The registrar's account-facts for the companion account.
function Get-CompanionAccountFacts([string]$root, [string]$sid, [string]$registrar) {
  try { (Invoke-CompanionRegistrar $root @('account-facts', $sid) $registrar) | ConvertFrom-Json } catch { $null }
}
function Get-CompanionDomainCredsDisabled { try { [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name 'DisableDomainCreds' -ErrorAction Stop).DisableDomainCreds } catch { 0 } }
# Read-only preflight of the account switch (pure over the facts): the account (local, enabled, not an administrator, not the caller,
# SeBatchLogonRight held directly and not denied, hardened (review r1 m5), its profile is the node profile's), its own gh configuration,
# the installed supervisor and launch file, no injection variable, the target's shape, and (review r1 m2) stored domain credentials
# allowed and the lockout margin: all before anything irreversible.
function Get-CompanionAccountPreflight([string]$root, $node, $facts, [string]$vhdxDir, [int]$disableDomainCreds, $lockout) {
  $refusals = @()
  if ($disableDomainCreds -ne 0) { $refusals += 'COMPANION_HEADLESS_DOMAIN_CREDS_DISABLED' }
  if (-not (Test-LockoutMargin $lockout)) { $refusals += 'COMPANION_LOCKOUT_MARGIN_INSUFFICIENT' }
  if ($null -eq $facts -or [string]$facts.code -cne 'ACCOUNT_FACTS' -or -not $facts.exists) { $refusals += 'COMPANION_ACCOUNT_MISSING' }
  else {
    if ($null -ne $facts.refusal) { $refusals += [string]$facts.refusal }
    if (@($facts.rights) -cnotcontains 'SeBatchLogonRight') { $refusals += 'COMPANION_ACCOUNT_BATCH_LOGON_RIGHT_MISSING' }
    if (@($facts.rights) -ccontains 'SeDenyBatchLogonRight') { $refusals += 'COMPANION_ACCOUNT_BATCH_LOGON_DENIED' }
    $hard = @($(if ($facts.PSObject.Properties.Name -ccontains 'hardening') { @($facts.hardening) } else { 'UNKNOWN' }) | Where-Object { $_ })
    if ($hard.Count) { $refusals += ('COMPANION_ACCOUNT_NOT_HARDENED:' + ($hard -join ',')) }
    if (-not [string]::Equals([string]$facts.profileDirectory, [string]$node.ownerProfileDirectory, [StringComparison]::OrdinalIgnoreCase)) { $refusals += 'COMPANION_ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE' }
  }
  $gh = Get-CompanionGhDirs ([string]$node.ownerProfileDirectory)
  $ghReady = (Test-Path -LiteralPath (Join-Path $gh.gh 'hosts.yml') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $gh.home '.gitconfig') -PathType Leaf)
  if (-not $ghReady) { $refusals += 'COMPANION_GH_CONFIG_MISSING' }
  foreach ($exe in @('bin\CluedCompanionSupervisor.exe', 'config\companion-launch.json')) { if (-not (Test-Path -LiteralPath (Join-Path $root $exe) -PathType Leaf)) { $refusals += ('COMPANION_HEADLESS_NOT_INSTALLED:' + $exe) } }
  $inject = @(Get-InjectVariables)
  if ($inject.Count) { $refusals += ('COMPANION_HEADLESS_INJECTION_VARIABLES:' + ($inject -join ',')) }
  if ($vhdxDir -cnotmatch $CompanionVhdxDirPattern) { $refusals += 'WSL_TARGET_REFUSED' }
  [ordered]@{ refusals = $refusals; account = $facts; companionGhConfig = $ghReady; disableDomainCreds = $disableDomainCreds; lockout = $lockout }
}
# The account switch (rearm-resident.ps1 -CompanionAccount, the reinstall's last step; again with -CompanionCredential): elevated, by
# the operator. The same marker, fall-back task, registrar build and qualification as Invoke-CompanionHeadless. In between, the stages of
# Invoke-CompanionWslMove, then the registrar (a new random password, the task, the import task with the Owner's DefaultUid), the import
# (exit 0 or WSL_IMPORT_FAILED:<code>), only then the Owner's registration key goes. A run that was cut off resumes from the record
# (no -WslVhdxDirectory needed). Not qualified: the task goes back to the account's interactive definition (the companion stays off).
function Invoke-CompanionAccountSwitch([string]$root, $node, [string]$vhdxDir, [string]$mode) {
  $sid = [string]$node.ownerSid; $distro = [string]$node.wslDistribution
  $result = [ordered]@{ mode = $mode; preflight = $null; wsl = $null; importResult = $null; registrar = $null; qualified = $false; failed = $null; fellBack = $false; task = $null }
  $pending = Read-CompanionPending $root
  if ($null -ne $pending) {
    if (Test-CompanionPendingOwnerAlive $pending) { $result.failed = 'COMPANION_HEADLESS_SWITCH_IN_PROGRESS'; return $result }
    $null = Invoke-CompanionStopAndFallback $root $sid
    $result.earlierPendingFellBack = $true
  }
  $wslRecord = Read-CompanionWslRecord $root
  if ($null -ne $wslRecord) {
    $recordDir = Split-Path -Parent ([string]$wslRecord.target)
    if ($vhdxDir -and -not [string]::Equals($vhdxDir.TrimEnd('\'), $recordDir, [StringComparison]::OrdinalIgnoreCase)) { $result.failed = 'WSL_VHDX_DIRECTORY_NOT_THE_RECORDED_ONE'; return $result }
    $vhdxDir = $recordDir
  }
  if (-not $vhdxDir) { $result.failed = 'WSL_VHDX_DIRECTORY_REQUIRED'; return $result }
  $build = $null
  try { $build = New-CompanionBuild $root } catch { $why = [string]$_.Exception.Message; $result.failed = 'COMPANION_BUILD_FAILED:' + $(if ($why -cmatch '^COMPANION_BUILD_[A-Z_]{1,60}\z') { $why } else { 'UNEXPECTED' }) }
  if ($null -eq $build) { return $result }
  $result.build = [ordered]@{ generation = $build.generation; registrarSourceSha256 = $build.registrar.sourceSha256; registrarSha256 = $build.registrar.sha256 }
  $script:CompanionRegistrarExe = $build.registrar.exe
  try {
    $result.preflight = Get-CompanionAccountPreflight $root $node (Get-CompanionAccountFacts $root $sid $build.registrar.exe) $vhdxDir (Get-CompanionDomainCredsDisabled) (Get-LockoutPolicy)
    if (@($result.preflight.refusals).Count) { $result.failed = 'PREFLIGHT'; return $result }
    Register-CompanionFallbackTask $root ([string](Get-Content -LiteralPath (Join-Path $root 'install\install-receipt.json') -Raw | ConvertFrom-Json).residentManifestSha256)
    Write-CompanionPending $root $mode $sid
    # Whatever runs now (an instance of an earlier definition) ends before the distribution stops.
    Stop-CompanionTask
    foreach ($p in @((Get-CompanionProcessTree $root).supervisors)) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue }
    Wait-CompanionTaskNotRunning
    try { $record = Invoke-CompanionWslMove $root $distro $vhdxDir $sid; $result.wsl = $record } catch {
      $why = [string]$_.Exception.Message
      $result.failed = 'COMPANION_WSL_MOVE_FAILED:' + $(if ($why -cmatch '^WSL_[A-Z_]{1,60}\z') { $why } else { 'UNEXPECTED' })
      $null = Invoke-CompanionFallback $root $sid; $result.fellBack = $true
      return $result
    }
    $vhdx = Join-Path $vhdxDir 'ext4.vhdx'
    $needImport = @('imported', 'forgotten', 'qualified') -cnotcontains [string]$record.stage
    $uid = 0L
    if ($null -ne $record.ownerRegistration -and $null -ne $record.ownerRegistration.values) { $v = $record.ownerRegistration.values; $u = if ($v -is [Collections.IDictionary]) { $v['DefaultUid'] } else { $v.DefaultUid }; if ($null -ne $u) { $uid = [int64]$u } }
    $registrarArgs = if ($needImport) { @('register-account', $root, $distro, $vhdx, [string]$uid) } else { @('register-account', $root) }
    $reg = Invoke-CompanionRegistrar $root $registrarArgs $build.registrar.exe
    $code = try { [string]($reg | ConvertFrom-Json).code } catch { 'REGISTRAR_OUTPUT_UNREADABLE' }
    $result.registrar = if ($code -cmatch '^[A-Z][A-Z0-9_]{0,63}\z') { $code } else { 'REGISTRAR_OUTPUT_UNREADABLE' }
    $d = try { [string]($reg | ConvertFrom-Json).detail } catch { $null }
    if ($d -cmatch '^[a-z]{1,16}:[A-Za-z0-9_]{1,40}:0x[0-9A-F]{8}\z|^0x[0-9A-F]{8}:(parked|park-failed)\z') { $result.registrarDetail = $d }
    if ($result.registrar -cne 'REGISTERED') {
      $null = Invoke-CompanionFallback $root $sid
      $result.fellBack = $true; $result.failed = $result.registrar
      return $result
    }
    if ($needImport) {
      $result.importResult = Invoke-CompanionWslImportTask
      if (-not (($result.importResult -is [long] -or $result.importResult -is [int]) -and [int64]$result.importResult -eq 0)) {
        $result.failed = 'WSL_IMPORT_FAILED:' + [string]$result.importResult
        $null = Invoke-CompanionFallback $root $sid; $result.fellBack = $true
        return $result
      }
      $record = ConvertTo-CompanionOrdered $record; $record.stage = 'imported'; $record.imported = $true; $record.importedAt = [DateTimeOffset]::UtcNow.ToString('o')
      Write-CompanionWslRecord $root $record
    }
    if ([string]$record.stage -ceq 'imported') {
      try { $record = Remove-CompanionOwnerRegistration $root $record } catch {
        $result.failed = 'COMPANION_WSL_FORGET_FAILED'
        $null = Invoke-CompanionFallback $root $sid; $result.fellBack = $true
        return $result
      }
    }
    $since = [DateTimeOffset]::UtcNow
    try { Start-CompanionTask } catch { $result.runError = 'COMPANION_TASK_RUN_FAILED' }
    $why = Wait-CompanionQualified $root $sid $since -registrar $build.registrar.exe
    $result.task = Get-CompanionTaskFacts $root $sid
    if ($null -eq $why -and $result.task.mode -ceq 'password') {
      $record = ConvertTo-CompanionOrdered $record; $record.stage = 'qualified'; $record.qualifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
      Write-CompanionWslRecord $root $record
      $result.wsl = $record
      Remove-Item -LiteralPath (Join-Path $root $CompanionPendingFile) -Force -ErrorAction SilentlyContinue
      Remove-CompanionFallbackTask
      $result.qualified = $true
      return $result
    }
    $result.failed = 'COMPANION_HEADLESS_QUALIFICATION_FAILED:' + $(if ($why) { $why } else { 'task-' + $result.task.mode })
    $null = Invoke-CompanionStopAndFallback $root $sid
    $result.fellBack = $true
    $result
  } finally { $script:CompanionRegistrarExe = $null; Remove-CompanionBuild $build.directory }
}
# rearm-resident.ps1 -CompanionWslRestore (review r1 M4): back to where the move started. The task is parked first (the account's
# companion stops, so its WSL VM lets the file go); ext4.vhdx goes back to the recorded source (a rename on one volume, else the same
# verified copy through a .partial); the Owner's registration key comes back from its export when it is gone. The account's own
# registration then names a missing file and is harmless (remove-companion-account.ps1 deletes it with the account's profile).
function Invoke-CompanionWslRestore([string]$root, $node) {
  $result = [ordered]@{ restored = $false; failed = $null; record = $null }
  # Review r2 n3: never while a switch is running (its window is open).
  $pending = Read-CompanionPending $root
  if ($null -ne $pending -and (Test-CompanionPendingOwnerAlive $pending)) { $result.failed = 'COMPANION_HEADLESS_SWITCH_IN_PROGRESS'; return $result }
  $record = Read-CompanionWslRecord $root
  if ($null -eq $record) { $result.failed = 'WSL_NOTHING_TO_RESTORE'; return $result }
  $record = ConvertTo-CompanionOrdered $record; $result.record = $record
  if (-not $record.Contains('source') -or -not $record.source -or -not $record.Contains('ownerExport')) { $result.failed = 'WSL_RECORD_INCOMPLETE'; return $result }
  # Review r2 N1: the copy back is hashed from the disk by this generation's registrar (file-sha256), built here as the switch does.
  $build = $null
  try { $build = New-CompanionBuild $root } catch { $why = [string]$_.Exception.Message; $result.failed = 'COMPANION_BUILD_FAILED:' + $(if ($why -cmatch '^COMPANION_BUILD_[A-Z_]{1,60}\z') { $why } else { 'UNEXPECTED' }); return $result }
  $script:CompanionRegistrarExe = $build.registrar.exe
  $null = Invoke-CompanionStopAndFallback $root ([string]$node.ownerSid)
  $source = [string]$record.source; $target = [string]$record.target
  try {
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      # Review r2 n2: the account's own WSL VM may still hold the file; the Owner cannot stop it. The task is parked (above), so after a
      # restart nothing starts that VM: WSL_VHDX_STILL_IN_USE means restart, then run -CompanionWslRestore again (runbook 9.5, T13).
      if (-not (Wait-CompanionVhdxFree $target 300)) { throw 'WSL_VHDX_STILL_IN_USE' }
      if (Test-Path -LiteralPath $source) { throw 'WSL_SOURCE_EXISTS' }
      [void][IO.Directory]::CreateDirectory((Split-Path -Parent $source))
      if (Test-CompanionSameVolume $source $target) { [IO.File]::Move($target, $source) }
      else {
        $partial = $source + '.partial'
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        $copy = Copy-CompanionFileVerified $target $partial
        if ($copy.sourceSha256 -cne $copy.targetSha256) { Remove-Item -LiteralPath $partial -Force; throw 'WSL_COPY_HASH_MISMATCH' }
        [IO.File]::Move($partial, $source)
        Remove-Item -LiteralPath $target -Force
      }
      Set-CompanionOwnerFileAcl $source
    } elseif (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'WSL_VHDX_MISSING' }
    $guid = if ($null -ne $record.ownerRegistration) { [string]$record.ownerRegistration.guid } else { $null }
    if ($guid -and @(Get-WslRegistrations | Where-Object { $_.guid -ceq $guid }).Count -eq 0) { Import-CompanionLxssKey ([string]$record.ownerExport) }
    $record.stage = 'restored'; $record.restoredAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-CompanionWslRecord $root $record
    $result.restored = $true
  } catch { $why = [string]$_.Exception.Message; $result.failed = $(if ($why -cmatch '^WSL_[A-Z_]{1,60}\z') { $why } else { 'WSL_RESTORE_UNEXPECTED' }) }
  finally { $script:CompanionRegistrarExe = $null; Remove-CompanionBuild $build.directory }
  $result
}
# rearm-resident.ps1 -CompanionRootShell: a root shell in the resident distribution as the companion account (the registrar sets a new
# random password on the account and on its password task, then opens wsl.exe in a new console). Returns the registrar's code.
function Invoke-CompanionRootShell([string]$root) {
  $build = New-CompanionBuild $root
  try {
    $out = Invoke-CompanionRegistrar $root @('root-shell', $root) $build.registrar.exe
    try { [string]($out | ConvertFrom-Json).code } catch { 'REGISTRAR_OUTPUT_UNREADABLE' }
  } finally { Remove-CompanionBuild $build.directory }
}
# Review r1 m6: the members of a local group as SIDs, read through ADSI (WinNT provider) member by member; Get-LocalGroupMember throws on
# an orphaned or Entra ID member. $null when the group or any member cannot be read (the callers refuse, never guess).
# Shared with install-resident.ps1 and verify-resident.ps1 (test-companion-headless.ps1 holds the copies identical).
function Get-GroupMemberSids([string]$groupSid) {
  try {
    $name = (New-Object Security.Principal.SecurityIdentifier($groupSid)).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    $group = [ADSI]('WinNT://' + [Environment]::MachineName + '/' + $name + ',group')
    $out = New-Object Collections.ArrayList
    foreach ($m in @($group.psbase.Invoke('Members'))) {
      $bytes = $m.GetType().InvokeMember('objectSid', 'GetProperty', $null, $m, $null)
      [void]$out.Add((New-Object Security.Principal.SecurityIdentifier([byte[]]$bytes, 0)).Value)
    }
    ,([string[]]$out.ToArray())
  } catch { $null }
}
function Get-AdministratorSids { Get-GroupMemberSids 'S-1-5-32-544' }
# verify-resident.ps1 on an M5-b node (pure over the facts): the account exists, is enabled, is not a member of Administrators (an
# unreadable group is its own problem, never "administrator"), is hardened (review r1 m5), its profile is the node profile's, and the
# operator holds no explicit entry that can write formal-spool\incoming. $null when all hold.
function Get-CompanionAccountProblem($node, $record, $user, $administrators, [string]$profilePath, [string]$incomingSddl, $hardening) {
  if ($null -eq $user) { return 'ACCOUNT_MISSING' }
  if (-not [bool]$user.Enabled) { return 'ACCOUNT_DISABLED' }
  if ($null -eq $administrators) { return 'ADMINISTRATORS_UNREADABLE' }
  if (@($administrators) -ccontains [string]$record.companionSid) { return 'ACCOUNT_IS_ADMINISTRATOR' }
  $hard = @(@($hardening) | Where-Object { $_ })
  if ($hard.Count) { return ('ACCOUNT_NOT_HARDENED:' + ($hard -join ',')) }
  if (-not [string]::Equals($profilePath, [string]$node.ownerProfileDirectory, [StringComparison]::OrdinalIgnoreCase)) { return 'ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE' }
  if (-not $incomingSddl) { return 'SPOOL_ACL_UNREADABLE' }
  $raw = try { New-Object Security.AccessControl.RawSecurityDescriptor($incomingSddl) } catch { return 'SPOOL_ACL_UNREADABLE' }
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  foreach ($a in $raw.DiscretionaryAcl) {
    if ($a -is [Security.AccessControl.CommonAce] -and $a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $a.SecurityIdentifier.Value -ceq [string]$record.operatorSid -and ($a.AccessMask -band $write) -ne 0) { return 'SPOOL_INCOMING_WRITABLE_BY_THE_OWNER' }
  }
  $null
}
# Review r1 m5 for verify (it may run as SYSTEM, which the registrar refuses): the account's direct groups and flags through ADSI, the
# sign-in screen's UserList value; the rights only when secedit can be read (elevated), otherwise they are not counted.
function Get-CompanionAccountHardening([string]$sid, [bool]$canReadRights) {
  $o = @()
  try {
    $acc = (New-Object Security.Principal.SecurityIdentifier($sid)).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    $u = [ADSI]('WinNT://' + [Environment]::MachineName + '/' + $acc + ',user')
    $groups = @(@($u.psbase.Invoke('Groups')) | ForEach-Object { $_.GetType().InvokeMember('Name', 'GetProperty', $null, $_, $null) })
    $users = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    if ($groups.Count -ne 1 -or $groups[0] -ine $users) { $o += 'GROUPS_NOT_USERS_ONLY' }
    $flags = [int]$u.UserFlags.Value
    if (($flags -band 0x10000) -eq 0) { $o += 'PASSWORD_EXPIRES' }
    if (($flags -band 0x40) -eq 0) { $o += 'PASSWORD_CHANGEABLE' }
    $hidden = try { (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList' -Name $acc -ErrorAction Stop).$acc -eq 0 } catch { $false }
    if (-not $hidden) { $o += 'NOT_HIDDEN' }
    if ($canReadRights) {
      $dir = Join-Path 'C:\Windows\Temp' ('clued-rights-' + [Guid]::NewGuid().ToString('N'))
      try {
        $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'); [void][IO.Directory]::CreateDirectory($dir, $ds)
        $cfg = Join-Path $dir 'rights.inf'
        $null = & 'C:\Windows\System32\SecEdit.exe' /export /areas USER_RIGHTS /cfg $cfg /quiet
        $inf = [IO.File]::ReadAllText($cfg)
        foreach ($pair in @(@('SeDenyNetworkLogonRight', 'NETWORK_LOGON_NOT_DENIED'), @('SeDenyRemoteInteractiveLogonRight', 'RDP_LOGON_NOT_DENIED'))) {
          $line = @(($inf -split "`r?`n") | Where-Object { $_ -match ('^\s*' + $pair[0] + '\s*=') })
          if ($line.Count -eq 0 -or -not ($line[0].Contains('*' + $sid) -or ($line[0] -split '[=,]' | ForEach-Object { $_.Trim() }) -icontains $acc)) { $o += $pair[1] }
        }
      } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } catch { $o += 'UNREADABLE' }
  ,$o
}
function Get-CompanionAccountVerify([string]$root, $node, $record, [bool]$elevated) {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts' -ErrorAction SilentlyContinue
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1' -ErrorAction SilentlyContinue
  $user = try { Get-LocalUser -SID ([string]$record.companionSid) -ErrorAction Stop } catch { $null }
  $profilePath = try { [string](Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='" + [string]$record.companionSid + "'") -ErrorAction Stop).LocalPath } catch { $null }
  $incoming = try { (Get-Acl -LiteralPath 'C:\ProgramData\CluedIndependentCI\formal-spool\incoming').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) } catch { $null }
  Get-CompanionAccountProblem $node $record $user (Get-AdministratorSids) $profilePath $incoming (Get-CompanionAccountHardening ([string]$record.companionSid) $elevated)
}
