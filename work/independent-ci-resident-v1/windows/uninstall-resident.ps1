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
  (configuration objects, not evidence), stop the companion's node process (its task runs it under
  conhost --headless, and ending the task does not end node), confirm the runner service is byte-for-byte what install
  recorded (it was never modified), then rename the whole resident directory to
  resident-uninstalled-<UTC>-<hex>. Ledger, receipts, archives, inbox history, owner requests and
  install records all stay, byte for byte. The Linux half is linux/uninstall-resident-linux.sh.
  The upgrade channel (018da927): CluedCIUpgrader is stopped first (its host ends the upgrader at a step boundary, at most 60 s) and
  deleted with the other two; an upgrade that is RUNNING or ROLLING_BACK (upgrade\status.json) refuses the uninstall. Its journal,
  generations, archive and token stay inside the renamed directory.
  M5 (ADR 0022 section 4.4): the companion task's running instance is stopped first (the supervisor, and with its job object the
  companion), then both tasks are deleted (\Clued\CluedCIResidentCompanion and \Clued\CluedCIResidentNotifier); the password the Task
  Scheduler stored for the companion task is deleted with it.
#>
[CmdletBinding()]
param([switch]$Apply, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPlanSha256)
# M5-b (ADR 0023) review r2 n7: the stage of an unfinished move of the resident distribution, or $null (no move, qualified, restored);
# 'unreadable' when the record cannot be read.
function Get-CompanionWslUnfinished([string]$root) {
  $f = Join-Path $root 'install\companion-wsl.json'
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  $r = try { Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { $null }
  if ($null -eq $r -or -not ($r.PSObject.Properties.Name -ccontains 'stage')) { return 'unreadable' }
  if (@('qualified', 'restored') -ccontains [string]$r.stage) { return $null }
  [string]$r.stage
}
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
$Sc = 'C:\Windows\System32\sc.exe'
# This node's runner service: the installed record's node profile (record\acceptance.json `node`, admin-only, validated by
# the install; design section 9 C1), held to its fixed shape before it reaches sc.exe.
$Runner = [string](([IO.File]::ReadAllText((Join-Path $Root 'record\acceptance.json'), (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json).node.runnerService)
if ($Runner -cnotmatch '^actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\z') { throw 'INSTALLED_NODE_PROFILE_REFUSED' }
function Sha256Text([string]$t) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
# The upgrade op the upgrader reports (upgrade\status.json, A5): only RUNNING and ROLLING_BACK have side effects in flight.
function Get-UpgradeOpState {
  $f = Join-Path $Root 'upgrade\status.json'
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  try {
    $s = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
    $op = if (@($s.PSObject.Properties.Name) -ccontains 'op') { $s.op } else { $null }
    if ($null -eq $op) { return $null }
    if (@($op.PSObject.Properties.Name) -ccontains 'state') { return [string]$op.state } else { return 'unreadable' }
  } catch { return 'unreadable' }
}
function ExecutorAlive {
  $h = Join-Path $Root 'state\executor.lock\holder.json'
  if (-not (Test-Path -LiteralPath $h)) { return $false }
  $holderPid = (Get-Content -LiteralPath $h -Raw | ConvertFrom-Json).pid
  return [bool](Get-Process -Id $holderPid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' })
}

$open = @(Get-ChildItem -LiteralPath (Join-Path $Root 'state\ledger') -Directory | Where-Object { -not (Test-Path -LiteralPath (Join-Path $_.FullName '90-terminal.json')) })
# sc.exe sdshow also prints the SACL ("S:...") when the caller may read it (elevated) and not otherwise;
# every service-descriptor comparison uses the DACL section alone, so both views agree.
function Get-DaclPart([string]$sd) { $t = ([string]$sd).Trim(); $i = $t.IndexOf('D:'); if ($i -lt 0) { return $t }; $t = $t.Substring($i); $j = $t.IndexOf('S:'); if ($j -ge 0) { $t = $t.Substring(0, $j) }; $t }
$installed = Get-Content -LiteralPath (Join-Path $Root 'install\install-receipt.json') -Raw | ConvertFrom-Json
$qc = & $Sc qc $Runner | Out-String
$plan = [ordered]@{
  contract = 'clued.independent-ci.resident-uninstall-plan/3'   # /3 (018da927): the upgrader
  openBatches = $open.Count
  upgraderService = [bool](Get-Service -Name 'CluedCIUpgrader' -ErrorAction SilentlyContinue)
  upgradeOpState = (Get-UpgradeOpState)
  executorAlive = (ExecutorAlive)
  runnerOriginalStopped = ($qc -match 'C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe') -and ((& $Sc queryex $Runner | Out-String) -match 'STATE\s*:\s*1\s')
  runnerSddlUnchanged = ((Get-DaclPart (& $Sc sdshow $Runner | Out-String)) -ceq $installed.runnerSddlUnchanged)
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
if (@('RUNNING', 'ROLLING_BACK', 'unreadable') -ccontains $plan.upgradeOpState) { throw 'UNINSTALL_REQUIRES_NO_RUNNING_UPGRADE' }
# M5-b review r2 n7: the move of the resident distribution keeps its stages in install\companion-wsl.json; the uninstall renames install\
# away with the rest, so it never runs while a move is half done (qualified or restored only), before anything is changed.
$wslUnfinished = Get-CompanionWslUnfinished $Root
if ($null -ne $wslUnfinished) { throw ('COMPANION_WSL_MOVE_UNFINISHED:' + $wslUnfinished) }

# The upgrader first, so nothing starts an upgrade step while the services go: its host asks it to stop at a step boundary and ends its
# job after 60 s (UpgraderServiceHost.cs); every step is journaled and is never repeated blindly.
if ($plan.upgraderService) {
  & $Sc stop CluedCIUpgrader | Out-Null
  $deadline = (Get-Date).AddSeconds(120)
  while ((& $Sc queryex CluedCIUpgrader | Out-String) -notmatch 'STATE\s*:\s*1\s') { if ((Get-Date) -gt $deadline) { throw 'UPGRADER_STILL_RUNNING_NOTHING_REMOVED' }; Start-Sleep -Seconds 2 }
}

& $Sc stop CluedCIResident | Out-Null   # the host writes STOP-REQUESTED; the executor exits between batches
$deadline = (Get-Date).AddMinutes(10)
while (ExecutorAlive) { if ((Get-Date) -gt $deadline) { throw 'EXECUTOR_STILL_RUNNING_NOTHING_REMOVED' }; Start-Sleep -Seconds 2 }
& $Sc stop CluedCISwapBroker | Out-Null
& $Sc delete CluedCIResident | Out-Null
& $Sc delete CluedCISwapBroker | Out-Null
if ($plan.upgraderService) { & $Sc delete CluedCIUpgrader | Out-Null }
# M5: end the supervisor's instance first (its job object ends the companion), then delete both tasks; the companion task's stored
# password goes with its definition.
try { Stop-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction Stop } catch { }
Unregister-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -Confirm:$false
if (Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanionFallback' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanionFallback' -Confirm:$false }
if (Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentNotifier' -ErrorAction SilentlyContinue) {
  try { Stop-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentNotifier' -ErrorAction Stop } catch { }
  Unregister-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentNotifier' -Confirm:$false
}
# The companion runs as conhost --headless -> node (install-resident.ps1 Get-CompanionAction); ending or
# unregistering its task ends conhost, not node. With both services stopped only the companion can still run
# the installed node copy, so every such process is stopped before the resident directory is renamed. The companion's
# job hosts (bin\CluedCompanionJobHost.exe, DESIGN §24) end with node's job, but asynchronously: they are waited for too.
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1'
$installed = @((Join-Path $Root 'bin\CluedCompanionSupervisor.exe'), (Join-Path $Root 'runtime\node.exe'), (Join-Path $Root 'bin\CluedCompanionJobHost.exe'), (Join-Path $Root 'upgrader\runtime\node.exe'))
$until = (Get-Date).AddSeconds(30)
do {
  $left = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe' OR Name='CluedCompanionJobHost.exe' OR Name='CluedCompanionSupervisor.exe'" | Where-Object { $p = [string]$_.ExecutablePath; @($installed | Where-Object { [string]::Equals($p, $_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 })
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($left.Count) { Start-Sleep -Milliseconds 500 }
} while ($left.Count -and (Get-Date) -lt $until)
if ($left.Count) { throw 'COMPANION_STILL_RUNNING_RESIDENT_NOT_RENAMED' }
# The resident's outbound block (review MINOR-5) is configuration of the deleted service, not evidence.
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'
Get-NetFirewallRule -Name 'CluedCIResident-BlockOutbound' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$hex = -join ((1..6) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$target = 'C:\ProgramData\CluedIndependentCI\resident-uninstalled-' + $stamp + '-' + $hex
[IO.Directory]::Move($Root, $target)
$r = Join-Path $target 'install\uninstall-receipt.json'
$f = [IO.File]::Open($r, 'CreateNew', 'Write', 'None'); try { $b = (New-Object Text.UTF8Encoding($false)).GetBytes(([ordered]@{ contract = 'clued.independent-ci.resident-uninstall-receipt/3'; planSha256 = $sha; keptAt = $target; at = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json)); $f.Write($b, 0, $b.Length) } finally { $f.Dispose() }
[ordered]@{ status = 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT'; keptAt = $target } | ConvertTo-Json
