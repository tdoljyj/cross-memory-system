<#
M5-b DESK recovery, once: the HALT FAILURE_ARCHIVE_UNCONFIRMED (windowsArchiveCode EXACT_FIXED_ACCESS_ACES_REQUIRED) of
batch 31080af4... (PR #1061). The installed archiver accepts only 4/5 fixed ACEs, the M5-b outgoing leaves carry six
(clued-companion read added), so the installed owner re-arm refuses at its own archive and HALT stays.

ONE elevated step of the Owner (DESK-W-591\Windows, the install's operator). Without -Run or -Preflight it does nothing.
  1 read-only checks: exact machine, account, elevated 64-bit Windows PowerShell 5.1, no CLR/profiler override environment;
    the live HALT is byte for byte the reviewed one and names exactly this batch and code; the installed generation and its
    rearm-resident.ps1 are the reviewed ones; the service pins the reviewed node profile; the resident service is running;
    the reviewed Source archiver and NodeProfileV2.cs have the pinned SHA-256.
  2 those two files are staged into a new admin-only directory (owner Administrators, SYSTEM/Administrators only, kept as
    evidence) and hashed again there; the child gets a fixed environment with TEMP inside that directory.
  3 the staged archiver archives the failure scene, rename only, reason owner-m5b-recovery: every leaf moves through its own
    held handle, the new failed-* directory grants modify to NT SERVICE\CluedCIResident (never the caller). Nothing is
    deleted, overwritten or re-ACLed; HALT, ledger and state are not touched.
  4 only after a verified archive whose receipt names this batch and moved the three reviewed outgoing leaves, and with the
    HALT still the reviewed bytes: the INSTALLED rearm-resident.ps1 -Request Rearm (the normal owner re-arm). The service
    then proves quiescence on both hosts, runs its own installed archive (nothing is left: it verifies with moved 0),
    archives the Linux side, marks the ledger entry archived and clears HALT by compare-and-swap. This script does not wait.
Every result goes to recovery.json in the staging directory and to stdout. -Preflight runs only step 1, not elevated.

Launch (elevated Windows PowerShell 5.1; hash-checked bytes run from memory, never -File a user-writable copy):
  C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command "$b=[IO.File]::ReadAllBytes('<SourceRoot>\work\independent-ci-resident-v1\windows\recover-m5b-archive-reviewed.ps1');$s=[Security.Cryptography.SHA256]::Create();if(([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant() -cne '<sha256 of this file>'){throw 'RECOVERY_SCRIPT_HASH_REFUSED'};& ([ScriptBlock]::Create((New-Object Text.UTF8Encoding($false,$true)).GetString($b))) -SourceRoot '<SourceRoot>' -Run"
#>
[CmdletBinding()]
param([ValidatePattern('^[A-Z]:\\[A-Za-z0-9._\\-]+$')][string]$SourceRoot, [switch]$Run, [switch]$Preflight)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (-not $Run -and -not $Preflight) { '{"status":"DISABLED"}'; return }
if ($Run -and $Preflight) { throw 'ONE_MODE_ONLY' }
if (-not $SourceRoot) { throw 'SOURCE_ROOT_REQUIRED' }
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
foreach ($name in [Environment]::GetEnvironmentVariables().Keys) {
  if ([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)') { throw 'RECOVERY_ENVIRONMENT_REFUSED' }
}

#region pins (reviewed; DESK-W-591 only)
$Machine = 'DESK-W-591'
$OwnerSid = 'S-1-5-21-858977881-4031698862-3006450925-1000'
$BatchKey = '31080af4ceb1122c31997aa41903b91f8445941ba168833be21609aa896c9178'
$HaltSha256 = '1523b55a286b677a0d11bcbd1af1d8af6aa459eb4298871f0037dcda57e31a52'
$NodeProfileSha256 = '560489f43eb1642047af6bda8754acd484740a8806797e8f6e7bbf0d9d8e2354'
$InstalledResidentManifest = '2a9f66f063ff2e71a1d7a12603b1545dd2c6d60368074b5383ff106f16d6728e'
$InstalledRearmSha256 = '57e274e26abc3962104a233804a8ff7b5bd0b7db66ac93ffb45ea0ea5ad2774c'
$Staged = [ordered]@{
  'archive-windows-spool.ps1' = @('work\actions-hosted-migration\independent-ci-v1\src\resident-v2\archive-windows-spool.ps1', '238608b9298e03b249e1f042bd695b774a4a6ad51322bee6bf827f25b8527d93')
  'windows\NodeProfileV2.cs'  = @('work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows\NodeProfileV2.cs', 'a6c771510b7fb819cd1ff54eb1cf9f5f1a5b3d5c420a217aafb25f5df8df2085')
}
$Reason = 'owner-m5b-recovery'
$SceneLeaves = @('outgoing/issue.json', 'outgoing/issue.ready.json', 'outgoing/active.lock')
#endregion pins

$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$Spool = 'C:\ProgramData\CluedIndependentCI\formal-spool'
$StageParent = 'C:\ProgramData\CluedIndependentCI\resident-launch-m5b-recovery'
$StageSddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$PS = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$U8 = New-Object Text.UTF8Encoding($false)
$Strict8 = New-Object Text.UTF8Encoding($false, $true)
$Done = New-Object Collections.Generic.List[string]
$Report = [ordered]@{ contract = 'clued.independent-ci.m5b-archive-recovery/1'; mode = $(if ($Run) { 'run' } else { 'preflight' }); batchKey = $BatchKey; haltSha256 = $HaltSha256; status = $null; code = $null; completed = $Done; stage = $null; archive = $null; archiveReceipt = $null; rearm = $null; rollback = $null; at = [DateTimeOffset]::UtcNow.ToString('o') }
function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Write-New([string]$path, [byte[]]$bytes) { $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() } }
function Read-Json([string]$path) { $Strict8.GetString([IO.File]::ReadAllBytes($path)) | ConvertFrom-Json }
# Each stop says what is true now; nothing here is undone automatically (rename-only effects stay as evidence).
$Rollback = [ordered]@{
  preflight = 'NOTHING_CHANGED'
  stage     = 'NOTHING_CHANGED_OUTSIDE_THE_ADMIN_ONLY_STAGING_DIRECTORY'
  archive   = 'HALT_AND_LEDGER_UNTOUCHED_NO_REARM_REQUESTED_SCENE_LEAVES_ARE_WHERE_THE_ARCHIVE_RECEIPT_OR_SPOOL_SHOWS'
  rearm     = 'SCENE_ARCHIVED_HALT_UNTOUCHED_RUN_THE_INSTALLED_REARM_AGAIN'
}
function Stop-Recovery([string]$code, [string]$phase) {
  $Report.status = 'STOPPED'; $Report.code = $code; $Report.rollback = $Rollback[$phase]
  if ($Report.stage) { try { Write-New (Join-Path $Report.stage 'recovery.json') ($U8.GetBytes(($Report | ConvertTo-Json -Depth 8))) } catch { } }
  $Report | ConvertTo-Json -Depth 8
  exit 1
}
function Get-ChildEnv([string]$tmp) {
  [ordered]@{
    SystemRoot = 'C:\Windows'; windir = 'C:\Windows'; SystemDrive = 'C:'; ComSpec = 'C:\Windows\System32\cmd.exe'
    PATH = 'C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0'
    PATHEXT = '.COM;.EXE;.BAT;.CMD'; PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
    TEMP = $tmp; TMP = $tmp; APPDATA = (Join-Path $tmp 'appdata'); LOCALAPPDATA = (Join-Path $tmp 'localappdata')
    ProgramData = 'C:\ProgramData'; ALLUSERSPROFILE = 'C:\ProgramData'; PUBLIC = 'C:\Users\Public'
    ProgramFiles = 'C:\Program Files'; 'ProgramFiles(x86)' = 'C:\Program Files (x86)'; ProgramW6432 = 'C:\Program Files'
    CommonProgramFiles = 'C:\Program Files\Common Files'; 'CommonProgramFiles(x86)' = 'C:\Program Files (x86)\Common Files'; CommonProgramW6432 = 'C:\Program Files\Common Files'
    COMPUTERNAME = $Machine; USERNAME = [string]$env:USERNAME; USERDOMAIN = [string]$env:USERDOMAIN; USERPROFILE = [string]$env:USERPROFILE
    OS = 'Windows_NT'; PROCESSOR_ARCHITECTURE = 'AMD64'; NUMBER_OF_PROCESSORS = [string]$env:NUMBER_OF_PROCESSORS
  }
}
function Invoke-Child([string]$name, [string]$file, [string[]]$argList, [string]$tmp) {
  foreach ($a in @($file) + $argList) { if ($a -match '[\s"]') { Stop-Recovery 'CHILD_ARGUMENT_REFUSED' $name } }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $PS
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $file + ' ' + ($argList -join ' ')
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = $tmp
  $psi.EnvironmentVariables.Clear()
  $envs = Get-ChildEnv $tmp; foreach ($k in $envs.Keys) { $psi.EnvironmentVariables[$k] = $envs[$k] }
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit()
  $r = [pscustomobject]@{ exit = $p.ExitCode; stdout = [string]$o.Result; stderr = [string]$e.Result }
  Write-New (Join-Path $Report.stage ($name + '.stdout.txt')) ($U8.GetBytes($r.stdout))
  Write-New (Join-Path $Report.stage ($name + '.stderr.txt')) ($U8.GetBytes($r.stderr))
  $r
}
function Last-Json([string]$text) { $l = @($text -split "`r?`n" | Where-Object { $_.Trim() }); if ($l.Count -eq 0) { return $null }; try { $l[$l.Count - 1] | ConvertFrom-Json } catch { $null } }
function Assert-Halt {
  $p = Join-Path $Root 'state\HALT.json'
  if (-not [IO.File]::Exists($p)) { return 'HALT_ABSENT' }
  $b = [IO.File]::ReadAllBytes($p); if ((Sha256Bytes $b) -cne $HaltSha256) { return 'HALT_CHANGED_SINCE_REVIEW' }
  $h = $Strict8.GetString($b) | ConvertFrom-Json
  if ($h.code -cne 'FAILURE_ARCHIVE_UNCONFIRMED' -or $h.clearedOnlyBy -cne 'owner-rearm' -or $h.facts.key -cne $BatchKey -or $h.facts.windowsArchiveCode -cne 'EXACT_FIXED_ACCESS_ACES_REQUIRED') { return 'HALT_NOT_THE_REVIEWED_SCENE' }
  return $null
}

# 1 read-only checks
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ([Environment]::MachineName -cne $Machine -or $identity.User.Value -cne $OwnerSid -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5) { Stop-Recovery 'EXACT_DESK_OWNER_WINDOWS_POWERSHELL_5_REQUIRED' 'preflight' }
if ($Run -and -not $elevated) { Stop-Recovery 'ELEVATED_OWNER_TOKEN_REQUIRED' 'preflight' }
if ($Preflight -and $elevated) { Stop-Recovery 'PREFLIGHT_RUNS_NOT_ELEVATED' 'preflight' }
$account = Read-Json (Join-Path $Root 'install\companion-account.json')
if ([string]$account.operatorSid -cne $OwnerSid) { Stop-Recovery 'OWNER_IS_NOT_THE_INSTALL_OPERATOR' 'preflight' }
$haltCode = Assert-Halt; if ($haltCode) { Stop-Recovery $haltCode 'preflight' }
$installed = Read-Json (Join-Path $Root 'install\install-receipt.json')
if ([string]$installed.residentManifestSha256 -cne $InstalledResidentManifest) { Stop-Recovery 'INSTALLED_GENERATION_CHANGED_SINCE_REVIEW' 'preflight' }
$rearm = Join-Path $Root ('resident\' + $InstalledResidentManifest + '\windows\rearm-resident.ps1')
if ((Sha256Bytes ([IO.File]::ReadAllBytes($rearm))) -cne $InstalledRearmSha256) { Stop-Recovery 'INSTALLED_REARM_CHANGED_SINCE_REVIEW' 'preflight' }
if ([string](Read-Json (Join-Path $Root 'config\policy.json')).nodeProfileSha256 -cne $NodeProfileSha256) { Stop-Recovery 'NODE_PROFILE_PIN_CHANGED_SINCE_REVIEW' 'preflight' }
if ((Get-Service -Name 'CluedCIResident').Status -ne 'Running') { Stop-Recovery 'RESIDENT_SERVICE_NOT_RUNNING' 'preflight' }
# The installed archive still refuses six-ACE leaves, so no new batch may start between the re-arm and the upgrade that
# installs the hardened archiver: the Owner's own intake hold (rearm-tool.mjs request-intake-pause, unelevated, just before
# this step) must be waiting in requests\ (write-only for the Owner, so only the elevated run can see it). The service takes
# it in the same tick that clears HALT, before any scheduling.
function Test-OwnerIntakePause {
  $now = [DateTimeOffset]::UtcNow
  foreach ($f in @([IO.Directory]::GetFiles((Join-Path $Root 'requests'), '*.json') | Select-Object -First 256)) {
    try {
      if ((New-Object IO.FileInfo($f)).Length -gt 16384) { continue }
      $q = Read-Json $f
      if ($q.contract -ceq 'clued.independent-ci.resident-intake-pause/1' -and $q.holder -ceq 'owner' -and [int]$q.minutes -ge 60) {
        $age = $now - [DateTimeOffset]::Parse([string]$q.requestedAt, [Globalization.CultureInfo]::InvariantCulture)
        if ($age.TotalMinutes -ge -5 -and $age.TotalMinutes -le 30) { return $true }
      }
    } catch { }
  }
  $false
}
if ($Run -and -not (Test-OwnerIntakePause)) { Stop-Recovery 'OWNER_INTAKE_PAUSE_REQUEST_REQUIRED' 'preflight' }
$buffers = [ordered]@{}
foreach ($name in $Staged.Keys) {
  $b = [IO.File]::ReadAllBytes((Join-Path $SourceRoot $Staged[$name][0]))
  if ((Sha256Bytes $b) -cne $Staged[$name][1]) { Stop-Recovery 'SOURCE_ARCHIVER_NOT_THE_REVIEWED_BYTES' 'preflight' }
  $buffers[$name] = $b
}
$Done.Add('preflight')
if ($Preflight) { $Report.status = 'PREFLIGHT_PASS'; $Report | ConvertTo-Json -Depth 8; exit 0 }

# 2 admin-only staging (kept)
try {
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($StageSddl)
  if ([IO.File]::Exists($StageParent)) { throw 'STAGING_PARENT_IS_A_FILE' }
  if (-not [IO.Directory]::Exists($StageParent)) { [void][IO.Directory]::CreateDirectory($StageParent, $ds) }
  if (([IO.File]::GetAttributes($StageParent) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'STAGING_PARENT_REPARSE_REFUSED' }
  if ([IO.Directory]::GetAccessControl($StageParent).GetSecurityDescriptorSddlForm('Owner,Access') -cne $ds.GetSecurityDescriptorSddlForm('Owner,Access')) { throw 'STAGING_ACL_READBACK_MISMATCH' }
  $dir = Join-Path $StageParent ([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  if ([IO.Directory]::Exists($dir) -or [IO.File]::Exists($dir)) { throw 'STAGING_DIRECTORY_EXISTS' }
  [void][IO.Directory]::CreateDirectory($dir); $Report.stage = $dir
  foreach ($sub in @('windows', 'tmp', 'tmp\appdata', 'tmp\localappdata')) { [void][IO.Directory]::CreateDirectory((Join-Path $dir $sub)) }
  foreach ($name in $buffers.Keys) {
    $p = Join-Path $dir $name; Write-New $p $buffers[$name]
    if ((Sha256Bytes ([IO.File]::ReadAllBytes($p))) -cne $Staged[$name][1]) { throw 'STAGED_COPY_CHANGED' }
    if ([IO.File]::GetAccessControl($p).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') { throw 'STAGED_COPY_OWNER_NOT_ADMINISTRATORS' }
  }
} catch { $m = [string]$_.Exception.Message; Stop-Recovery $(if ($m -cmatch '^[A-Z][A-Z0-9_]{1,79}$') { $m } else { 'STAGING_FAILED' }) 'stage' }
$Done.Add('stage')
$tmp = Join-Path $dir 'tmp'

# 3 the archive (rename only)
$haltCode = Assert-Halt; if ($haltCode) { Stop-Recovery $haltCode 'stage' }
$a = Invoke-Child 'archive' (Join-Path $dir 'archive-windows-spool.ps1') @('-BatchKey', $BatchKey, '-Reason', $Reason, '-ExpectedNodeProfileSha256', $NodeProfileSha256) $tmp
$v = Last-Json $a.stdout; $Report.archive = [ordered]@{ exit = $a.exit; result = $v }
if ($a.exit -ne 0 -or $null -eq $v -or $v.verified -ne $true -or [string]$v.directory -cnotmatch ('^failed-' + $BatchKey.Substring(0, 12) + '-' + $Reason + '-[0-9a-f]{12}$')) { Stop-Recovery 'RECOVERY_ARCHIVE_UNCONFIRMED' 'archive' }
$receipt = Read-Json (Join-Path (Join-Path $Spool $v.directory) 'archive-receipt.json'); $Report.archiveReceipt = $receipt
$from = @($receipt.moved | ForEach-Object { [string]$_.from })
if ($receipt.batchKey -cne $BatchKey -or $receipt.reason -cne $Reason -or $receipt.deletesAnything -ne $false -or @($SceneLeaves | Where-Object { $from -cnotcontains $_ }).Count -ne 0 -or @($receipt.moved | Where-Object { $_.fileIdOwnerGroupAndEffectiveAccessPreserved -ne $true }).Count -ne 0) { Stop-Recovery 'RECOVERY_ARCHIVE_NOT_THE_REVIEWED_SCENE' 'archive' }
$Done.Add('archive')

# 4 the installed owner re-arm request
$haltCode = Assert-Halt; if ($haltCode) { Stop-Recovery $haltCode 'rearm' }
$r = Invoke-Child 'rearm' $rearm @('-Request', 'Rearm', '-ExpectedHaltSha256', $HaltSha256, '-Reason', ('m5b-owner-recovery-archived-' + $v.directory)) $tmp
$w = Last-Json $r.stdout; $Report.rearm = [ordered]@{ exit = $r.exit; result = $w }
if ($r.exit -ne 0 -or $null -eq $w -or $w.status -cne 'REARM_REQUESTED_SERVICE_WILL_VERIFY') { Stop-Recovery 'REARM_REQUEST_UNCONFIRMED' 'rearm' }
$Done.Add('rearm-requested')
$Report.status = 'ARCHIVED_AND_REARM_REQUESTED'
Write-New (Join-Path $dir 'recovery.json') ($U8.GetBytes(($Report | ConvertTo-Json -Depth 8)))
$Report | ConvertTo-Json -Depth 8
exit 0
