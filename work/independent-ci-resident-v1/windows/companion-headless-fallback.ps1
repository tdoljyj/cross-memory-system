<#
.SYNOPSIS
  M5 (DESIGN.md section 65.4.4; review M1): the one-shot SYSTEM task \Clued\CluedCIResidentCompanionFallback runs this INSTALLED copy at
  boot and 16 minutes after a switch began. A pending marker (install\companion-headless-pending.json) older than 15 minutes means the
  switch was cut off (a restart, a closed window, an error after the password was registered): the companion task goes back to the
  interactive token (no password needed) and the marker goes. A younger marker is left alone (the 16-minute trigger comes later).
  Without a marker, or after the roll-back, this task deletes itself. It takes no argument and never sees a password.
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-18') { throw 'SYSTEM_REQUIRED' }
. (Join-Path $PSScriptRoot 'companion-headless.ps1')
$node = (Get-Content -LiteralPath (Join-Path $Root 'record\acceptance.json') -Raw | ConvertFrom-Json).node
$pending = Read-CompanionPending $Root
$did = 'nothing'
if ($null -eq $pending) { Remove-CompanionFallbackTask; $did = 'no-marker' }
elseif (Test-CompanionPendingStale $pending ([DateTimeOffset]::UtcNow)) {
  Stop-CompanionTask
  $tree = Get-CompanionProcessTree $Root
  foreach ($p in @($tree.supervisors)) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue }
  Wait-CompanionTaskNotRunning
  $null = Invoke-CompanionFallback $Root ([string]$node.ownerSid)   # also deletes this task
  try { Start-CompanionTask } catch { }   # the interactive task starts only while the Owner is logged on; else at the next log-on
  $did = 'fell-back'
}
[ordered]@{ contract = 'clued.independent-ci.companion-headless-fallback/1'; did = $did; at = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
