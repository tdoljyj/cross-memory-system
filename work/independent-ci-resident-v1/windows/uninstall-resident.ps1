<#
.SYNOPSIS
  Owner uninstall of the resident executor (DRAFT). Keeps every piece of evidence.

.DESCRIPTION
  Run the INSTALLED copy. Dry run by default (prints the plan). -Apply (elevated Owner, UAC) needs:
    * no open batch in the ledger, the runner service Stopped/Manual on its original binary, and no
      executor process alive (the instance lock's holder pid is checked: stopping the service never
      kills the executor, so SCM "STOPPED" alone proves nothing);
    * -ExpectedPlanSha256 equal to the plan computed now.
  Steps: stop both services (the resident exits between batches), delete them and the companion task
  (configuration objects, not evidence), confirm the runner service is byte-for-byte what install
  recorded (it was never modified), then rename the whole resident directory to
  resident-uninstalled-<UTC>-<hex>. Ledger, receipts, archives, inbox history, owner requests and
  install records all stay, byte for byte. The Linux half is linux/uninstall-resident-linux.sh.
#>
[CmdletBinding()]
param([switch]$Apply, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPlanSha256)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
$Sc = 'C:\Windows\System32\sc.exe'
$Runner = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02'
function Sha256Text([string]$t) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function ExecutorAlive {
  $h = Join-Path $Root 'state\executor.lock\holder.json'
  if (-not (Test-Path -LiteralPath $h)) { return $false }
  $holderPid = (Get-Content -LiteralPath $h -Raw | ConvertFrom-Json).pid
  return [bool](Get-Process -Id $holderPid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' })
}

$open = @(Get-ChildItem -LiteralPath (Join-Path $Root 'state\ledger') -Directory | Where-Object { -not (Test-Path -LiteralPath (Join-Path $_.FullName '90-terminal.json')) })
$installed = Get-Content -LiteralPath (Join-Path $Root 'install\install-receipt.json') -Raw | ConvertFrom-Json
$qc = & $Sc qc $Runner | Out-String
$plan = [ordered]@{
  contract = 'clued.independent-ci.resident-uninstall-plan/2'
  openBatches = $open.Count
  executorAlive = (ExecutorAlive)
  runnerOriginalStopped = ($qc -match 'C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe') -and ((& $Sc queryex $Runner | Out-String) -match 'STATE\s*:\s*1\s')
  runnerSddlUnchanged = ((& $Sc sdshow $Runner | Out-String).Trim() -ceq $installed.runnerSddlUnchanged)
  renameTo = 'resident-uninstalled-<UTC>-<hex>'
  deletesEvidence = $false
}
$sha = Sha256Text ($plan | ConvertTo-Json -Depth 6)
if (-not $Apply) { [ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = $sha; plan = $plan } | ConvertTo-Json -Depth 8; exit 0 }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
if ($ExpectedPlanSha256 -cne $sha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
if ($plan.openBatches -ne 0) { throw 'UNINSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST' }
if (-not $plan.runnerOriginalStopped) { throw 'RUNNER_SERVICE_NOT_ORIGINAL_STOPPED' }
if (-not $plan.runnerSddlUnchanged) { throw 'RUNNER_SDDL_CHANGED_OWNER_LOOK' }

& $Sc stop CluedCIResident | Out-Null   # the host writes STOP-REQUESTED; the executor exits between batches
$deadline = (Get-Date).AddMinutes(10)
while (ExecutorAlive) { if ((Get-Date) -gt $deadline) { throw 'EXECUTOR_STILL_RUNNING_NOTHING_REMOVED' }; Start-Sleep -Seconds 2 }
& $Sc stop CluedCISwapBroker | Out-Null
& $Sc delete CluedCIResident | Out-Null
& $Sc delete CluedCISwapBroker | Out-Null
Unregister-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -Confirm:$false
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$hex = -join ((1..6) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$target = 'C:\ProgramData\CluedIndependentCI\resident-uninstalled-' + $stamp + '-' + $hex
[IO.Directory]::Move($Root, $target)
$r = Join-Path $target 'install\uninstall-receipt.json'
$f = [IO.File]::Open($r, 'CreateNew', 'Write', 'None'); try { $b = (New-Object Text.UTF8Encoding($false)).GetBytes(([ordered]@{ contract = 'clued.independent-ci.resident-uninstall-receipt/2'; planSha256 = $sha; keptAt = $target; at = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json)); $f.Write($b, 0, $b.Length) } finally { $f.Dispose() }
[ordered]@{ status = 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT'; keptAt = $target } | ConvertTo-Json
