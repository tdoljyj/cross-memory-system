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
# The registrar's ValidVhdx (CompanionTaskRegistrar.cs), here for the directory: a drive, 1 to 7 plain names.
$CompanionVhdxDirPattern = '^[A-Z]:\\(?:[A-Za-z0-9._-]{1,64}\\){0,6}[A-Za-z0-9._-]{1,64}\z'

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
# inherited, nothing for the Owner's session.
function Get-CompanionVhdxSddl([string]$companionSid) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $companionSid + ')' }
# The current user's WSL registrations (HKCU Lxss): guid, name, base path (the \\?\ prefix dropped), default uid, flags, version.
function Get-WslRegistrations {
  $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (-not (Test-Path -LiteralPath $base)) { return @() }
  @(Get-ChildItem -LiteralPath $base | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath
    $names = @($p.PSObject.Properties.Name)
    [ordered]@{ guid = $_.PSChildName; name = $(if ($names -contains 'DistributionName') { [string]$p.DistributionName } else { $null })
      basePath = $(if ($names -contains 'BasePath') { ([string]$p.BasePath) -replace '^\\\\\?\\', '' } else { $null })
      defaultUid = $(if ($names -contains 'DefaultUid') { [int64]$p.DefaultUid } else { $null }); flags = $(if ($names -contains 'Flags') { [int64]$p.Flags } else { $null })
      version = $(if ($names -contains 'Version') { [int64]$p.Version } else { $null }) }
  })
}
# What the move has to do (pure). registration: the Owner's registration of the distribution or $null; sourceExists: its ext4.vhdx is
# there; targetDir: where it goes; targetExists: ext4.vhdx is already there. action: move (sameVolume: a rename, else a copy), forget
# (the file is already in the target, only the Owner's registration goes: a move cut off after the file, or a distribution registered
# there already), done (moved and forgotten earlier), or refuse with the code.
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
  [ordered]@{ action = 'move'; code = $null; sameVolume = ($src.Substring(0, 2) -ieq $targetDir.Substring(0, 2)) }
}
function Get-CompanionFileSha256([string]$path) { $s = [Security.Cryptography.SHA256]::Create(); $f = [IO.File]::OpenRead($path); try { ([BitConverter]::ToString($s.ComputeHash($f))).Replace('-', '').ToLowerInvariant() } finally { $f.Dispose(); $s.Dispose() } }
# Copies source to target (CreateNew) hashing what it reads, then hashes the target as written; returns both hashes and the length.
function Copy-CompanionFileVerified([string]$source, [string]$target) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $in = New-Object IO.FileStream($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None, 4194304)
  try {
    $out = New-Object IO.FileStream($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4194304, [IO.FileOptions]::WriteThrough)
    try {
      $buf = New-Object byte[] 4194304
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { [void]$sha.TransformBlock($buf, 0, $n, $null, 0); $out.Write($buf, 0, $n) }
      [void]$sha.TransformFinalBlock($buf, 0, 0); $out.Flush($true)
    } finally { $out.Dispose() }
    $length = $in.Length
  } finally { $in.Dispose() }
  $read = ([BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant(); $sha.Dispose()
  [ordered]@{ sourceSha256 = $read; targetSha256 = (Get-CompanionFileSha256 $target); length = $length }
}
# The vhdx is free: opened with no sharing (the distribution no longer runs). At most $seconds.
function Wait-CompanionVhdxFree([string]$path, [int]$seconds = 120) {
  $until = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    try { $f = [IO.File]::Open($path, 'Open', 'ReadWrite', 'None'); $f.Dispose(); return $true } catch { Start-Sleep -Seconds 2 }
  } while ([DateTime]::UtcNow -lt $until)
  $false
}
# Moves the Owner's registration of the distribution to the companion account's side (elevated, as the Owner): the distribution is
# stopped (wsl --terminate, this one only), ext4.vhdx goes to targetDir (a rename on the same volume; otherwise a copy hashed on both
# sides, then the source is deleted: that is where C: gets its space back), folder and file get Get-CompanionVhdxSddl, and the Owner's
# registration key is removed (its values kept in the result) WITHOUT wsl --unregister, which would delete the file.
# The registration for the companion account is the import task's (register-account). Returns the record; throws a WSL_* code.
function Invoke-CompanionWslMove([string]$distro, [string]$targetDir, [string]$companionSid) {
  $reg = @(Get-WslRegistrations | Where-Object { $_.name -ceq $distro })
  if ($reg.Count -gt 1) { throw 'WSL_REGISTRATION_AMBIGUOUS' }
  $r = if ($reg.Count) { $reg[0] } else { $null }
  $source = if ($r) { Join-Path ([string]$r.basePath) 'ext4.vhdx' } else { $null }
  $target = Join-Path $targetDir 'ext4.vhdx'
  $plan = Get-CompanionWslMovePlan $r ([bool]($source -and (Test-Path -LiteralPath $source -PathType Leaf))) $targetDir (Test-Path -LiteralPath $target -PathType Leaf)
  $out = [ordered]@{ action = $plan.action; distro = $distro; source = $source; target = $target; registration = $r; copy = $null; at = [DateTimeOffset]::UtcNow.ToString('o') }
  if ($plan.action -ceq 'refuse') { throw $plan.code }
  if ($plan.action -ceq 'done') { return $out }
  $null = & 'C:\Windows\System32\wsl.exe' --terminate $distro 2>&1
  if (Test-Path -LiteralPath $source -PathType Leaf) { if (-not (Wait-CompanionVhdxFree $source)) { throw 'WSL_VHDX_STILL_IN_USE' } }
  $sddl = Get-CompanionVhdxSddl $companionSid
  if (Test-Path -LiteralPath $targetDir) {
    if (((Get-Item -LiteralPath $targetDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'WSL_TARGET_IS_A_LINK' }
  } else {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $targetDir))
    $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($sddl)
    [void][IO.Directory]::CreateDirectory($targetDir, $ds)
  }
  if ($plan.action -ceq 'move') {
    if ($plan.sameVolume) { [IO.File]::Move($source, $target) }
    else {
      $out.copy = Copy-CompanionFileVerified $source $target
      if ($out.copy.sourceSha256 -cne $out.copy.targetSha256) { Remove-Item -LiteralPath $target -Force; throw 'WSL_COPY_HASH_MISMATCH' }
      Remove-Item -LiteralPath $source -Force
    }
  }
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access)
  (Get-Item -LiteralPath $targetDir -Force).SetAccessControl($ds)
  $fs = New-Object Security.AccessControl.FileSecurity; $fs.SetSecurityDescriptorSddlForm($sddl.Replace('(A;OICI;', '(A;;'), [Security.AccessControl.AccessControlSections]::Access)
  (Get-Item -LiteralPath $target -Force).SetAccessControl($fs)
  if ($null -ne $r) {
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    $default = try { [string](Get-ItemProperty -LiteralPath $lxss -Name 'DefaultDistribution' -ErrorAction Stop).DefaultDistribution } catch { $null }
    $out.ownerDefaultWas = $default
    Remove-Item -LiteralPath (Join-Path $lxss ([string]$r.guid)) -Recurse -Force
    if ($default -ceq [string]$r.guid) { Remove-ItemProperty -LiteralPath $lxss -Name 'DefaultDistribution' -Force }
  }
  $out
}
# Runs the one-shot import task once and deletes it: its last result (wsl.exe's exit code), 'timeout' or 'not-registered'. At most
# 10 minutes.
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
function Read-CompanionWslRecord([string]$root) {
  $f = Join-Path $root $CompanionWslFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { $null }
}
function Write-CompanionWslRecord([string]$root, $record) {
  $f = Join-Path $root $CompanionWslFile
  $tmp = $f + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($tmp, ($record | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $f) { [IO.File]::Replace($tmp, $f, [NullString]::Value) } else { [IO.File]::Move($tmp, $f) }
}
# The registrar's account-facts for the companion account.
function Get-CompanionAccountFacts([string]$root, [string]$sid, [string]$registrar) {
  try { (Invoke-CompanionRegistrar $root @('account-facts', $sid) $registrar) | ConvertFrom-Json } catch { $null }
}
# Read-only preflight of the account switch (pure over the facts): the account (local, enabled, not an administrator, not the caller,
# SeBatchLogonRight held directly and not denied, its profile is the node profile's), its own gh configuration in that profile, the
# installed supervisor and launch file, no injection variable, the target's shape.
function Get-CompanionAccountPreflight([string]$root, $node, $facts, [string]$vhdxDir) {
  $refusals = @()
  if ($null -eq $facts -or [string]$facts.code -cne 'ACCOUNT_FACTS' -or -not $facts.exists) { $refusals += 'COMPANION_ACCOUNT_MISSING' }
  else {
    if ($null -ne $facts.refusal) { $refusals += [string]$facts.refusal }
    if (@($facts.rights) -cnotcontains 'SeBatchLogonRight') { $refusals += 'COMPANION_ACCOUNT_BATCH_LOGON_RIGHT_MISSING' }
    if (@($facts.rights) -ccontains 'SeDenyBatchLogonRight') { $refusals += 'COMPANION_ACCOUNT_BATCH_LOGON_DENIED' }
    if (-not [string]::Equals([string]$facts.profileDirectory, [string]$node.ownerProfileDirectory, [StringComparison]::OrdinalIgnoreCase)) { $refusals += 'COMPANION_ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE' }
  }
  $gh = Get-CompanionGhDirs ([string]$node.ownerProfileDirectory)
  $ghReady = (Test-Path -LiteralPath (Join-Path $gh.gh 'hosts.yml') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $gh.home '.gitconfig') -PathType Leaf)
  if (-not $ghReady) { $refusals += 'COMPANION_GH_CONFIG_MISSING' }
  foreach ($exe in @('bin\CluedCompanionSupervisor.exe', 'config\companion-launch.json')) { if (-not (Test-Path -LiteralPath (Join-Path $root $exe) -PathType Leaf)) { $refusals += ('COMPANION_HEADLESS_NOT_INSTALLED:' + $exe) } }
  $inject = @(Get-InjectVariables)
  if ($inject.Count) { $refusals += ('COMPANION_HEADLESS_INJECTION_VARIABLES:' + ($inject -join ',')) }
  if ($vhdxDir -cnotmatch $CompanionVhdxDirPattern) { $refusals += 'WSL_TARGET_REFUSED' }
  [ordered]@{ refusals = $refusals; account = $facts; companionGhConfig = $ghReady }
}
# The account switch (rearm-resident.ps1 -CompanionAccount, the reinstall's last step; again with -CompanionCredential): elevated, by
# the operator. The same marker, fall-back task, registrar build and qualification as Invoke-CompanionHeadless; between the marker and
# the registrar the distribution moves (first time only); the registrar sets a new random password and registers the task (and the
# import task, which then runs once). No password is ever typed. Not qualified: the task goes back to the interactive definition of the
# companion account (which never logs on interactively: the companion stays off, the services defer, nothing is burned).
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
  if (-not $vhdxDir -and $null -ne $wslRecord) { $vhdxDir = Split-Path -Parent ([string]$wslRecord.target) }
  if (-not $vhdxDir) { $result.failed = 'WSL_VHDX_DIRECTORY_REQUIRED'; return $result }
  $build = $null
  try { $build = New-CompanionBuild $root } catch { $why = [string]$_.Exception.Message; $result.failed = 'COMPANION_BUILD_FAILED:' + $(if ($why -cmatch '^COMPANION_BUILD_[A-Z_]{1,60}\z') { $why } else { 'UNEXPECTED' }) }
  if ($null -eq $build) { return $result }
  $result.build = [ordered]@{ generation = $build.generation; registrarSourceSha256 = $build.registrar.sourceSha256; registrarSha256 = $build.registrar.sha256 }
  try {
    $result.preflight = Get-CompanionAccountPreflight $root $node (Get-CompanionAccountFacts $root $sid $build.registrar.exe) $vhdxDir
    if (@($result.preflight.refusals).Count) { $result.failed = 'PREFLIGHT'; return $result }
    Register-CompanionFallbackTask $root ([string](Get-Content -LiteralPath (Join-Path $root 'install\install-receipt.json') -Raw | ConvertFrom-Json).residentManifestSha256)
    Write-CompanionPending $root $mode $sid
    # Whatever runs now (an instance of an earlier definition) ends before the distribution stops.
    Stop-CompanionTask
    foreach ($p in @((Get-CompanionProcessTree $root).supervisors)) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue }
    Wait-CompanionTaskNotRunning
    try { $result.wsl = Invoke-CompanionWslMove $distro $vhdxDir $sid } catch {
      $why = [string]$_.Exception.Message
      $result.failed = 'COMPANION_WSL_MOVE_FAILED:' + $(if ($why -cmatch '^WSL_[A-Z_]{1,60}\z') { $why } else { 'UNEXPECTED' })
      $null = Invoke-CompanionFallback $root $sid; $result.fellBack = $true
      return $result
    }
    $vhdx = Join-Path $vhdxDir 'ext4.vhdx'
    $imported = ($null -ne $wslRecord) -and [string]$wslRecord.target -ceq $vhdx -and [bool]$wslRecord.imported
    $registrarArgs = if ($imported) { @('register-account', $root) } else { @('register-account', $root, $distro, $vhdx) }
    $reg = Invoke-CompanionRegistrar $root $registrarArgs $build.registrar.exe
    $code = try { [string]($reg | ConvertFrom-Json).code } catch { 'REGISTRAR_OUTPUT_UNREADABLE' }
    $result.registrar = if ($code -cmatch '^[A-Z][A-Z0-9_]{0,63}\z') { $code } else { 'REGISTRAR_OUTPUT_UNREADABLE' }
    if ($result.registrar -ceq 'REGISTRAR_UNEXPECTED') { $d = try { [string]($reg | ConvertFrom-Json).detail } catch { $null }; if ($d -cmatch '^[a-z]{1,16}:[A-Za-z0-9_]{1,40}:0x[0-9A-F]{8}\z') { $result.registrarDetail = $d } }
    if ($result.registrar -cne 'REGISTERED') {
      $null = Invoke-CompanionFallback $root $sid
      $result.fellBack = $true; $result.failed = $result.registrar
      return $result
    }
    # The distribution is registered for the account by the account. A re-run after an import that did happen fails here harmlessly
    # (the name exists): the qualification below is what counts.
    if (-not $imported) { $result.importResult = Invoke-CompanionWslImportTask }
    $since = [DateTimeOffset]::UtcNow
    try { Start-CompanionTask } catch { $result.runError = 'COMPANION_TASK_RUN_FAILED' }
    $why = Wait-CompanionQualified $root $sid $since -registrar $build.registrar.exe
    $result.task = Get-CompanionTaskFacts $root $sid
    if ($null -eq $why -and $result.task.mode -ceq 'password') {
      Write-CompanionWslRecord $root ([ordered]@{ contract = $CompanionWslContract; distro = $distro; target = $vhdx; imported = $true; companionSid = $sid; at = [DateTimeOffset]::UtcNow.ToString('o'); move = $result.wsl })
      Remove-Item -LiteralPath (Join-Path $root $CompanionPendingFile) -Force -ErrorAction SilentlyContinue
      Remove-CompanionFallbackTask
      $result.qualified = $true
      return $result
    }
    $result.failed = 'COMPANION_HEADLESS_QUALIFICATION_FAILED:' + $(if ($why) { $why } else { 'task-' + $result.task.mode })
    $null = Invoke-CompanionStopAndFallback $root $sid
    $result.fellBack = $true
    $result
  } finally { Remove-CompanionBuild $build.directory }
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
# verify-resident.ps1 on an M5-b node (pure over the facts): the account exists, is enabled and is not a direct member of Administrators
# (the switch's registrar also checks indirect membership), its profile is the node profile's, and the operator holds no explicit
# entry that can write formal-spool\incoming (Source v2 accepts only the node profile's ownerSid there). $null when all hold.
function Get-CompanionAccountProblem($node, $record, $user, [string[]]$administrators, [string]$profilePath, [string]$incomingSddl) {
  if ($null -eq $user) { return 'ACCOUNT_MISSING' }
  if (-not [bool]$user.Enabled) { return 'ACCOUNT_DISABLED' }
  if (@($administrators) -ccontains [string]$record.companionSid) { return 'ACCOUNT_IS_ADMINISTRATOR' }
  if (-not [string]::Equals($profilePath, [string]$node.ownerProfileDirectory, [StringComparison]::OrdinalIgnoreCase)) { return 'ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE' }
  if (-not $incomingSddl) { return 'SPOOL_ACL_UNREADABLE' }
  $raw = try { New-Object Security.AccessControl.RawSecurityDescriptor($incomingSddl) } catch { return 'SPOOL_ACL_UNREADABLE' }
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  foreach ($a in $raw.DiscretionaryAcl) {
    if ($a -is [Security.AccessControl.CommonAce] -and $a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $a.SecurityIdentifier.Value -ceq [string]$record.operatorSid -and ($a.AccessMask -band $write) -ne 0) { return 'SPOOL_INCOMING_WRITABLE_BY_THE_OWNER' }
  }
  $null
}
function Get-CompanionAccountVerify([string]$root, $node, $record) {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts' -ErrorAction SilentlyContinue
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1' -ErrorAction SilentlyContinue
  $user = try { Get-LocalUser -SID ([string]$record.companionSid) -ErrorAction Stop } catch { $null }
  $admins = try { @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value }) } catch { @([string]$record.companionSid) }   # unreadable: refused
  $profilePath = try { [string](Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='" + [string]$record.companionSid + "'") -ErrorAction Stop).LocalPath } catch { $null }
  $incoming = try { (Get-Acl -LiteralPath 'C:\ProgramData\CluedIndependentCI\formal-spool\incoming').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) } catch { $null }
  Get-CompanionAccountProblem $node $record $user $admins $profilePath $incoming
}
