<#
.SYNOPSIS
  M5 (ADR 0022 section 4.4; review M1): the one-shot SYSTEM task \Clued\CluedCIResidentCompanionFallback runs this INSTALLED copy at
  boot and from 16 minutes after a switch began every 15 minutes. A pending marker (install\companion-headless-pending.json) that is
  abandoned (older than 15 minutes AND the switch that wrote it no longer runs: a restart, a closed window, an error after the password
  was registered) is rolled back: the companion task goes back to the interactive token (no password needed) and the marker goes. A
  younger marker, or one whose switch still runs (the credential box may stay open any time), is left for the next run. Without a
  marker, or after the roll-back, this task deletes itself. It takes no argument and never sees a password. What it did is written to
  install\companion-headless-fallback.json (admin-only).
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
$maintenanceHold = $true
try {
  . (Join-Path $PSScriptRoot 'companion-maintenance.ps1')
  $held = Test-CompanionMaintenanceRecoveryHold -Root $Root
  if ($held -is [bool]) { $maintenanceHold = $held }
} catch { $maintenanceHold = $true }
if ($maintenanceHold -or (Test-CompanionPendingMaintenance $pending)) { $did = 'maintenance-manual-recovery-held' }
elseif ($null -eq $pending) { Remove-CompanionFallbackTask; $did = 'no-marker' }
elseif (Test-CompanionPendingAbandoned $pending ([DateTimeOffset]::UtcNow)) {
  $null = Invoke-CompanionStopAndFallback $Root ([string]$node.ownerSid)   # also deletes this task
  try { Start-CompanionTask } catch { }   # the interactive task starts only while the Owner is logged on; else at the next log-on
  $did = 'fell-back'
}
$line = [ordered]@{ contract = 'clued.independent-ci.companion-headless-fallback/1'; did = $did; at = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
try { [IO.File]::WriteAllText((Join-Path $Root 'install\companion-headless-fallback.json'), $line, (New-Object Text.UTF8Encoding($false))) } catch { }
$line
