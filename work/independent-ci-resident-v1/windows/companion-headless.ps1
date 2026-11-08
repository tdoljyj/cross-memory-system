<#
.SYNOPSIS
  M5 (ADR 0022): the companion without the Owner's log-on. Functions only; dot-sourced from the INSTALLED copy by
  rearm-resident.ps1 (-CompanionHeadless, -CompanionCredential, -CompanionInteractive), verify-resident.ps1 and
  companion-headless-fallback.ps1 (the SYSTEM task that rolls a cut-off switch back).
  install-resident.ps1 and upgrade-apply.ps1 carry the functions they need as their own text, held identical to these by
  test-companion-headless.ps1 (an elevated script never dot-sources a file from a user-writable package directory).

  The password never passes through this file: it is typed only into the Windows credential box on the secure desktop that
  bin\CluedCompanionTaskRegistrar.exe shows, and goes from there to the Task Scheduler (CompanionTaskRegistrar.cs). What comes back
  here is a code.
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
# The registrar with a cleared, fixed environment (no profiler, no COMPlus_ knob of the Owner's session reaches it). Returns its stdout.
# The registrar's parent is this process: it checks that the pending marker names this process (pid and start time) right before it
# hands the password over (review round 3), so the marker must be written by this same process (Write-CompanionPending uses $PID).
function Invoke-CompanionRegistrar([string]$root, [string[]]$arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $root 'bin\CluedCompanionTaskRegistrar.exe'
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
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts\Microsoft.PowerShell.LocalAccounts.psd1' -ErrorAction SilentlyContinue
  $user = try { Get-LocalUser -SID ([string]$node.ownerSid) -ErrorAction Stop } catch { $null }
  if ($null -eq $user) { $refusals += 'COMPANION_HEADLESS_OWNER_NOT_LOCAL' }
  elseif ([string]$user.PrincipalSource -ceq 'MicrosoftAccount') { $refusals += 'COMPANION_HEADLESS_MSA_UNSUPPORTED' }
  # The companion's own gh login: presence only (the companion checks the shape itself and fails closed); nothing here reads the token.
  $gh = Get-CompanionGhDirs ([string]$node.ownerProfileDirectory)
  $hosts = Join-Path $gh.gh 'hosts.yml'; $gitconfig = Join-Path $gh.home '.gitconfig'
  $ghReady = (Test-Path -LiteralPath $hosts -PathType Leaf) -and (Test-Path -LiteralPath $gitconfig -PathType Leaf)
  if (-not $ghReady) { $refusals += 'COMPANION_GH_CONFIG_MISSING' }
  foreach ($exe in @('bin\CluedCompanionSupervisor.exe', 'bin\CluedCompanionTaskRegistrar.exe', 'config\companion-launch.json')) { if (-not (Test-Path -LiteralPath (Join-Path $root $exe) -PathType Leaf)) { $refusals += ('COMPANION_HEADLESS_NOT_INSTALLED:' + $exe) } }
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
function Get-ProcessTokenFacts([string]$root, [int]$processId) {
  $out = Invoke-CompanionRegistrar $root @('token-facts', [string]$processId)
  try { $out | ConvertFrom-Json } catch { $null }
}
# One look: $null when everything holds, else the first check that does not. since: when the switch began (UTC).
function Test-CompanionQualifiedOnce([string]$root, [string]$ownerSid, [DateTimeOffset]$since) {
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
    $f = Get-ProcessTokenFacts $root ([int]$p[0].ProcessId)
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
function Wait-CompanionQualified([string]$root, [string]$ownerSid, [DateTimeOffset]$since, [int]$seconds = $CompanionQualifySeconds) {
  $until = [DateTime]::UtcNow.AddSeconds($seconds); $why = 'not-started'
  while ([DateTime]::UtcNow -lt $until) {
    $why = Test-CompanionQualifiedOnce $root $ownerSid $since
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
  # Review round 2 MINOR 1: the fall-back task first (a marker never exists without it), then the marker.
  Register-CompanionFallbackTask $root ([string](Get-Content -LiteralPath (Join-Path $root 'install\install-receipt.json') -Raw | ConvertFrom-Json).residentManifestSha256)
  Write-CompanionPending $root $mode $ownerSid
  $reg = Invoke-CompanionRegistrar $root @('register-password', $root)
  $result.registrar = try { ($reg | ConvertFrom-Json).code } catch { 'REGISTRAR_OUTPUT_UNREADABLE' }
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
  $why = Wait-CompanionQualified $root $ownerSid $since
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
}
