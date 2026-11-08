<#
.SYNOPSIS
  M5-b (ADR 0023) review r1 m5: the roll-back of prepare-companion-account.ps1. Run by the Owner in his own ELEVATED window (one UAC).

.DESCRIPTION
  Builds the registrar from CompanionTaskRegistrar.cs next to this script (only with the pinned hash, as prepare does), then:
    1. registrar remove-account <name>: refused unless prepare-account made the account (its comment), it is not an administrator or the
       caller, and the companion task does not name it (reinstall back to the Owner's account first, ADR 0023 section 9); then its rights
       go (LsaRemoveAccountRights: SeBatchLogonRight, SeDenyNetworkLogonRight, SeDenyRemoteInteractiveLogonRight), its profile
       (DeleteProfile: C:\Users\<name>, with it its registry, so its WSL registrations and its .wslconfig) and the account;
    2. the sign-in screen's UserList value of the name.
  The resident distribution's ext4.vhdx is never touched (it is not in the profile; rearm-resident.ps1 -CompanionWslRestore moves it back).
  Writes one JSON log; no secret is involved.

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File remove-companion-account.ps1 -LogDirectory <folder> -RegistrarSha256 <sha> [-AccountName clued-companion]
  -Plan: not elevated, read-only: what a run would do.
#>
[CmdletBinding()]
param([ValidatePattern('^[a-z][a-z0-9-]{2,19}$')][string]$AccountName = 'clued-companion',
  [Parameter(Mandatory)][string]$LogDirectory,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$RegistrarSha256,
  [switch]$Plan)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$Framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$Csc = $Framework + 'csc.exe'
$UserList = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'

function Invoke-PrepCompile([string]$compiler, [string]$fw, [string]$exe, [string]$cs) {
  & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $exe) $cs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'PREP_COMPILE_FAILED' }
}
function Invoke-PrepRegistrar([string]$exe, [string[]]$arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.EnvironmentVariables.Clear()
  foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('windir', 'C:\Windows'), @('SystemDrive', 'C:'), @('PATH', 'C:\Windows\System32;C:\Windows'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
  $p = [Diagnostics.Process]::Start($psi); $o = $p.StandardOutput.ReadToEnd(); $p.WaitForExit(); $o.Trim()
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$log = [ordered]@{ contract = 'clued.independent-ci.companion-account-remove/1'; status = $null; host = [Environment]::MachineName; by = $me.User.Value; at = [DateTimeOffset]::UtcNow.ToString('o'); account = $AccountName; steps = [ordered]@{} }
if ($Plan) {
  if ($elevated) { throw 'PLAN_RUNS_NOT_ELEVATED' }
  $log.status = 'PLAN_ONLY_NOTHING_CHANGED'
  $log.steps = [ordered]@{ refusedWhen = 'not made by prepare-account; an administrator or this user; named by the companion task'
    removes = 'SeBatchLogonRight, SeDenyNetworkLogonRight, SeDenyRemoteInteractiveLogonRight; the profile (registry, WSL registrations, .wslconfig); the account; the UserList value'
    keeps = 'the resident distribution''s ext4.vhdx (rearm-resident.ps1 -CompanionWslRestore)' }
  $log | ConvertTo-Json -Depth 4
  exit 0
}
if (-not $elevated) { throw 'RUN_ELEVATED_IN_YOUR_OWN_WINDOW' }
if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) { [void][IO.Directory]::CreateDirectory($LogDirectory) }
$logFile = Join-Path $LogDirectory ('companion-account-remove.' + [Environment]::MachineName + '.' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json')
$build = $null
try {
  $src = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'CompanionTaskRegistrar.cs'))
  $sha = [Security.Cryptography.SHA256]::Create()
  if (([BitConverter]::ToString($sha.ComputeHash($src))).Replace('-', '').ToLowerInvariant() -cne $RegistrarSha256) { throw 'REGISTRAR_SOURCE_NOT_THE_PINNED_ONE' }
  $build = Join-Path 'C:\Windows\Temp' ('clued-prep-' + [Guid]::NewGuid().ToString('N'))
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'); [void][IO.Directory]::CreateDirectory($build, $ds)
  $cs = Join-Path $build 'CompanionTaskRegistrar.cs'; $exe = Join-Path $build 'CluedCompanionTaskRegistrar.exe'
  $f = [IO.File]::Open($cs, 'CreateNew', 'Write', 'None'); try { $f.Write($src, 0, $src.Length); $f.Flush($true) } finally { $f.Dispose() }
  Push-Location $build; try { Invoke-PrepCompile $Csc $Framework $exe $cs } finally { Pop-Location }
  $rm = (Invoke-PrepRegistrar $exe @('remove-account', $AccountName)) | ConvertFrom-Json
  $log.steps.account = $rm
  if (@('ACCOUNT_REMOVED', 'ACCOUNT_ABSENT') -cnotcontains [string]$rm.code) { throw ('ACCOUNT_NOT_REMOVED:' + [string]$rm.code) }
  if ((Get-Item -LiteralPath $UserList -ErrorAction SilentlyContinue) -and @((Get-Item -LiteralPath $UserList).GetValueNames()) -ccontains $AccountName) { Remove-ItemProperty -LiteralPath $UserList -Name $AccountName -Force }
  $log.steps.signInScreen = 'value removed'
  $log.status = 'COMPANION_ACCOUNT_REMOVED'
} catch {
  $log.status = 'COMPANION_ACCOUNT_NOT_REMOVED'
  $why = [string]$_.Exception.Message
  $log.error = if ($why -cmatch '^[A-Z][A-Z0-9_:,]{0,160}\z') { $why } else { $_.Exception.GetType().Name }
} finally {
  if ($build) { Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText($logFile, ($log | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}
[ordered]@{ status = $log.status; log = $logFile } | ConvertTo-Json
exit $(if ($log.status -ceq 'COMPANION_ACCOUNT_REMOVED') { 0 } else { 1 })
