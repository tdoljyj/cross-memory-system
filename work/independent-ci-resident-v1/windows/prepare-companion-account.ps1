<#
.SYNOPSIS
  M5-b (ADR 0023) step P, BEFORE the reinstall, once per node: the companion's own non-administrator local account. Run by the Owner in
  his own ELEVATED window (one UAC). Nothing is typed: the account's password is random and known to nobody (the switch sets a new one).

.DESCRIPTION
  One run does, in this order, and writes everything it did and saw into one JSON log (never a secret):
    1. builds CluedCompanionTaskRegistrar.exe from CompanionTaskRegistrar.cs next to this script, with install's recipe, in a new
       folder only SYSTEM and Administrators can touch (removed at the end);
    2. registrar prepare-account <name>: the local account (random password, Users only, password never expires, cannot be changed by
       the account), SeBatchLogonRight (the password task's batch logon), SeDenyNetworkLogonRight and SeDenyRemoteInteractiveLogonRight,
       and its profile (C:\Users\<name>). An existing account is only checked (local, enabled, not an administrator);
    3. hides the account from the sign-in screen (Winlogon\SpecialAccounts\UserList\<name> = 0);
    4. the account's own .wslconfig (its WSL VM is its own; the values are this script's parameters), only if it has none;
    5. the companion's GitHub token into the account's profile, in a child process (the token never passes through this script): the
       Owner's existing companion token when there is a classic one (companion-gh-login.ps1 -CopyFromOwner), else from the clipboard
       (-Login), then -Check; skipped when neither holds a classic token (then run that step alone later, also elevated);
    6. read-only facts for the Agent: the account's facts (registrar account-facts), the scheduled tasks whose principal is one of the
       local service accounts (clued-runner, clued-control, the new account), the user-rights lines that name them (secedit export into a
       protected temporary folder), and this user's WSL registrations.
  Exit 0 and status COMPANION_ACCOUNT_PREPARED: send the log's nodeProfile lines (ownerSid, ownerProfileDirectory) to the Agent; they go
  into config\node-profile.<node>.json for the reinstall.

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File prepare-companion-account.ps1 -LogDirectory <folder> -RegistrarSha256 <sha>
      [-AccountName clued-companion] [-WslMemory 16GB -WslProcessors 8 -WslSwap 4GB]
  -RegistrarSha256: the SHA-256 the commit's resident manifest pins for windows/CompanionTaskRegistrar.cs (the Agent gives it with the
  command); the source next to this script is compiled only when it has exactly that hash (review r1 m12).
  -Plan: not elevated, read-only: prints what a run would do (no registrar, no change).
  The roll-back is remove-companion-account.ps1.
#>
[CmdletBinding()]
param([ValidatePattern('^[a-z][a-z0-9-]{2,19}$')][string]$AccountName = 'clued-companion',
  [Parameter(Mandatory)][string]$LogDirectory,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$RegistrarSha256,
  [ValidatePattern('^[0-9]{1,3}GB$')][string]$WslMemory = '16GB', [ValidateRange(1, 64)][int]$WslProcessors = 8, [ValidatePattern('^[0-9]{1,3}GB$')][string]$WslSwap = '4GB',
  [switch]$Plan)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$Framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$Csc = $Framework + 'csc.exe'
$PrepSddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$ServiceAccounts = @('clued-runner', 'clued-control')

# The .wslconfig of the companion's account (pure).
function Get-CompanionWslConfig([string]$memory, [int]$processors, [string]$swap) { "[wsl2]`r`nmemory=$memory`r`nprocessors=$processors`r`nswap=$swap`r`n" }
# Install's compile recipe for the registrar (install-resident.ps1 Invoke-CompanionSupervisorCompile; test-companion-headless.ps1 holds
# the command line identical).
function Invoke-PrepCompile([string]$compiler, [string]$fw, [string]$exe, [string]$cs) {
  & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $exe) $cs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'PREP_COMPILE_FAILED' }
}
# The registrar with a cleared, fixed environment (as companion-headless.ps1 Invoke-CompanionRegistrar). Returns its stdout.
function Invoke-PrepRegistrar([string]$exe, [string[]]$arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.EnvironmentVariables.Clear()
  foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('windir', 'C:\Windows'), @('SystemDrive', 'C:'), @('PATH', 'C:\Windows\System32;C:\Windows'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  $o.Trim()
}
function New-PrepDirectory {
  $dir = Join-Path 'C:\Windows\Temp' ('clued-prep-' + [Guid]::NewGuid().ToString('N'))
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($PrepSddl)
  [void][IO.Directory]::CreateDirectory($dir, $ds)
  $dir
}
# Scheduled tasks whose principal is one of the given SIDs: path, name, logon type, run level, state, last result, actions (read-only;
# elevated sees every task).
function Get-TasksOf([string[]]$sids) {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $out = New-Object Collections.ArrayList
  $walk = $null
  $walk = {
    param($folder)
    foreach ($t in @($folder.GetTasks(1))) {
      $uid = [string]$t.Definition.Principal.UserId
      $sid = try { if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { $null }
      if ($sids -ccontains $sid) {
        [void]$out.Add([ordered]@{ path = [string]$t.Path; principal = $uid; sid = $sid; logonType = [int]$t.Definition.Principal.LogonType; runLevel = [int]$t.Definition.Principal.RunLevel
          state = [int]$t.State; enabled = [bool]$t.Enabled; lastTaskResult = ('0x{0:X8}' -f ([int64]$t.LastTaskResult -band 0xFFFFFFFFL)); lastRun = ([DateTime]$t.LastRunTime).ToString('o')
          actions = @(foreach ($a in $t.Definition.Actions) { if ($a.Type -eq 0) { [string]$a.Path + ' ' + [string]$a.Arguments } }) })
      }
    }
    foreach ($f in @($folder.GetFolders(0))) { & $walk $f }
  }
  & $walk ($svc.GetFolder('\'))
  ,$out.ToArray()
}
# The user-rights lines (secedit /export) that name one of the SIDs or names given; elevated; exported into a protected folder.
function Get-RightsNaming([string[]]$sids, [string[]]$names) {
  $dir = New-PrepDirectory
  try {
    $cfg = Join-Path $dir 'rights.inf'
    $null = & 'C:\Windows\System32\SecEdit.exe' /export /areas USER_RIGHTS /cfg $cfg /quiet
    if ($LASTEXITCODE -ne 0) { return 'unreadable' }
    @(([IO.File]::ReadAllText($cfg) -split "`r?`n") | Where-Object { $line = $_; $_ -match '^\s*Se\w+\s*=' -and @(@($sids + $names) | Where-Object { $line.Contains($_) }).Count })
  } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$log = [ordered]@{ contract = 'clued.independent-ci.companion-account-prepare/1'; status = $null; host = [Environment]::MachineName; by = $me.User.Value; at = [DateTimeOffset]::UtcNow.ToString('o')
  account = $AccountName; plan = $Plan.IsPresent; steps = [ordered]@{}; nodeProfile = $null; facts = [ordered]@{} }
if ($Plan) {
  if ($elevated) { throw 'PLAN_RUNS_NOT_ELEVATED' }
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts'
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  $log.status = 'PLAN_ONLY_NOTHING_CHANGED'
  $log.steps = [ordered]@{ account = $(if ($existing) { 'exists: checked only (' + $existing.SID.Value + ')' } else { 'created with a random password nobody learns' })
    rights = 'SeBatchLogonRight; SeDenyNetworkLogonRight, SeDenyRemoteInteractiveLogonRight'; profile = ('C:\Users\' + $AccountName + ' (CreateProfile)')
    signInScreen = 'hidden'; wslconfig = (Get-CompanionWslConfig $WslMemory $WslProcessors $WslSwap); token = 'the Owner''s existing companion token (companion-gh-login.ps1 -CopyFromOwner), else the clipboard (-Login); child process' }
  $log | ConvertTo-Json -Depth 6
  exit 0
}
if (-not $elevated) { throw 'RUN_ELEVATED_IN_YOUR_OWN_WINDOW' }
if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) { [void][IO.Directory]::CreateDirectory($LogDirectory) }
$logFile = Join-Path $LogDirectory ('companion-account-prepare.' + [Environment]::MachineName + '.' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json')
$build = $null
try {
  # 1. The registrar, from the source next to this script, built in a protected folder.
  # Review r1 m12: read once; compiled only when the bytes have the hash the commit's manifest pins (and those very bytes are compiled).
  $src = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'CompanionTaskRegistrar.cs'))
  $sha = [Security.Cryptography.SHA256]::Create()
  $srcSha = ([BitConverter]::ToString($sha.ComputeHash($src))).Replace('-', '').ToLowerInvariant()
  $log.steps.registrar = [ordered]@{ sourceSha256 = $srcSha; pinned = $RegistrarSha256 }
  if ($srcSha -cne $RegistrarSha256) { throw 'REGISTRAR_SOURCE_NOT_THE_PINNED_ONE' }
  $build = New-PrepDirectory
  $cs = Join-Path $build 'CompanionTaskRegistrar.cs'; $exe = Join-Path $build 'CluedCompanionTaskRegistrar.exe'
  $f = [IO.File]::Open($cs, 'CreateNew', 'Write', 'None'); try { $f.Write($src, 0, $src.Length); $f.Flush($true) } finally { $f.Dispose() }
  Push-Location $build; try { Invoke-PrepCompile $Csc $Framework $exe $cs } finally { Pop-Location }
  # 2. The account, its rights and its profile.
  $prep = (Invoke-PrepRegistrar $exe @('prepare-account', $AccountName)) | ConvertFrom-Json
  $log.steps.account = $prep
  if ([string]$prep.code -cne 'ACCOUNT_PREPARED') { throw ('ACCOUNT_NOT_PREPARED:' + [string]$prep.code) }
  $sid = [string]$prep.sid; $profileDir = [string]$prep.profileDirectory
  if ($profileDir -cnotmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z') { throw 'PROFILE_DIRECTORY_REFUSED' }
  # 3. Not on the sign-in screen (it never signs in interactively; the root shell uses its own logon).
  $ul = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  if (-not (Test-Path -LiteralPath $ul)) { $null = New-Item -Path $ul -Force }
  $null = New-ItemProperty -LiteralPath $ul -Name $AccountName -PropertyType DWord -Value 0 -Force
  $log.steps.signInScreen = 'hidden'
  # 4. Its own WSL VM's limits.
  $wslcfg = Join-Path $profileDir '.wslconfig'
  if (Test-Path -LiteralPath $wslcfg) { $log.steps.wslconfig = 'kept-existing' }
  else { [IO.File]::WriteAllText($wslcfg, (Get-CompanionWslConfig $WslMemory $WslProcessors $WslSwap), (New-Object Text.UTF8Encoding($false))); $log.steps.wslconfig = 'written' }
  # 5. The token (a child process reads the clipboard; nothing of it here), then the read-only check.
  $ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; $gl = Join-Path $PSScriptRoot 'companion-gh-login.ps1'
  # The Owner's existing companion token first (copied inside the child, -CopyFromOwner); else the clipboard (-Login).
  $copy = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gl -CopyFromOwner -ProfileDirectory $profileDir -AccountSid $sid 2>&1 | Out-String
  $copyStatus = if ($copy -match '"status":\s*"([A-Z_]+)"') { $Matches[1] } else { 'UNREADABLE' }
  if ($copyStatus -ceq 'COMPANION_GH_LOGIN_COPIED') { $log.steps.tokenLogin = [ordered]@{ source = 'owner-existing-token'; exit = 0; status = $copyStatus } }
  else {
    $login = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gl -Login -ProfileDirectory $profileDir -AccountSid $sid 2>&1 | Out-String
    $log.steps.tokenLogin = [ordered]@{ source = 'clipboard'; ownerTokenCopy = $copyStatus; exit = $LASTEXITCODE; status = $(if ($login -match '"status":\s*"([A-Z_]+)"') { $Matches[1] } elseif ($login -match '(CLIPBOARD_IS_NOT_A_CLASSIC_TOKEN|[A-Z][A-Z_]{8,})') { $Matches[1] } else { 'UNREADABLE' }) }
  }
  $check = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gl -Check -ProfileDirectory $profileDir -AccountSid $sid 2>&1 | Out-String
  $log.steps.tokenCheck = [ordered]@{ exit = $LASTEXITCODE; status = $(if ($check -match '"status":\s*"([A-Za-z_:,-]+)"') { $Matches[1] } else { 'UNREADABLE' }) }
  # 6. Facts for the Agent (read-only).
  $log.facts.account = (Invoke-PrepRegistrar $exe @('account-facts', $sid)) | ConvertFrom-Json
  # Review r1 m5: the account as the switch will check it (hidden now included)
  if (@($log.facts.account.hardening).Count) { throw ('ACCOUNT_NOT_HARDENED:' + (@($log.facts.account.hardening) -join ',')) }
  $sids = @($sid) + @($ServiceAccounts | ForEach-Object { try { (New-Object Security.Principal.NTAccount([Environment]::MachineName, $_)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $null } } | Where-Object { $_ })
  $log.facts.tasks = Get-TasksOf $sids
  $log.facts.userRights = Get-RightsNaming $sids (@($AccountName) + $ServiceAccounts)
  $log.facts.ownerWslRegistrations = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath; [ordered]@{ guid = $_.PSChildName; name = [string]$p.DistributionName; basePath = [string]$p.BasePath } })
  $log.nodeProfile = [ordered]@{ ownerSid = $sid; ownerProfileDirectory = $profileDir }
  $log.status = if ($log.steps.tokenCheck.status -ceq 'COMPANION_GH_LOGIN_READY') { 'COMPANION_ACCOUNT_PREPARED' } else { 'COMPANION_ACCOUNT_PREPARED_TOKEN_PENDING' }
} catch {
  $log.status = 'COMPANION_ACCOUNT_NOT_PREPARED'
  $why = [string]$_.Exception.Message
  $log.error = if ($why -cmatch '^[A-Z][A-Z0-9_:,]{0,160}\z') { $why } else { $_.Exception.GetType().Name }
} finally {
  if ($build) { Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText($logFile, ($log | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
}
[ordered]@{ status = $log.status; log = $logFile; nodeProfile = $log.nodeProfile } | ConvertTo-Json -Depth 4
exit $(if ($log.status -like 'COMPANION_ACCOUNT_PREPARED*') { 0 } else { 1 })
