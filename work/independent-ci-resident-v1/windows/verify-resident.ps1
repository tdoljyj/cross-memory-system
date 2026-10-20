<#
.SYNOPSIS
  Read-only verification of an installed resident executor (DRAFT). Writes nothing.

.DESCRIPTION
  Run the INSTALLED copy (C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\).
  Re-derives every pin of the install receipt (admin-only install\ directory) and compares it with
  the live host: package hashes, both services (account, start type, SID type, failure actions,
  DACL), the runner service byte-for-byte unchanged (SDDL, binary, account), the companion task
  (principal, LeastPrivilege, trigger), the receipt chain and the HALT / PAUSE latches.
  Prints one JSON verdict; exit 0 only if every check passes. Elevated for the complete check
  (service DACLs need READ_CONTROL); a non-elevated run reports those as unreadable and exits 2.
#>
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedInstallReceiptSha256)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
$Sc = 'C:\Windows\System32\sc.exe'
$Runner = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02'
$checks = [ordered]@{}
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Record([string]$name, $ok, $detail = $null) { $script:checks[$name] = [ordered]@{ ok = $ok; detail = $detail } }

$receiptFile = Join-Path $Root 'install\install-receipt.json'
Record 'install-receipt' ((Sha256File $receiptFile) -ceq $ExpectedInstallReceiptSha256)
$receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
foreach ($s in @($receipt.sourceManifestSha256, $receipt.residentManifestSha256)) { if ($s -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALL_RECEIPT_SHAPE_REFUSED' } }

$qc = & $Sc qc CluedCIResident | Out-String
Record 'resident-account' ($qc -match 'SERVICE_START_NAME\s*:\s*NT SERVICE\\CluedCIResident')
Record 'resident-start-type' ($qc -match 'START_TYPE\s*:\s*2\s')
Record 'resident-sid-type' ((& $Sc qsidtype CluedCIResident | Out-String) -match 'SERVICE_SID_TYPE\s*:\s*UNRESTRICTED')
Record 'resident-host-pin' ((Sha256File (Join-Path $Root 'bin\ResidentServiceHost.exe')) -ceq $receipt.ResidentServiceHostSha256)
$bq = & $Sc qc CluedCISwapBroker | Out-String
Record 'broker-account' ($bq -match 'SERVICE_START_NAME\s*:\s*LocalSystem')
Record 'broker-host-pin' ((Sha256File (Join-Path $Root 'bin\SwapBroker.exe')) -ceq $receipt.SwapBrokerSha256)
$runnerSddl = try { (& $Sc sdshow $Runner | Out-String).Trim() } catch { 'unreadable' }
Record 'runner-sddl-unchanged' $(if ($runnerSddl -eq 'unreadable') { 'unreadable' } else { $runnerSddl -ceq $receipt.runnerSddlUnchanged })
$rq = & $Sc qc $Runner | Out-String
Record 'runner-original-and-controller' (($rq -match 'C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe') -and ($rq -match 'SERVICE_START_NAME\s*:\s*(\.|TURING)\\clued-control'))

foreach ($m in @('config\source-installed-manifest.json', 'config\resident-installed-manifest.json')) {
  $man = Get-Content -LiteralPath (Join-Path $Root $m) -Raw | ConvertFrom-Json
  $base = if ($man.root -ceq 'source') { Join-Path $Root ('source\' + $receipt.sourceManifestSha256) } else { Join-Path $Root ('resident\' + $receipt.residentManifestSha256) }
  $bad = @($man.files | Where-Object { (Sha256File (Join-Path $base $_.path)) -cne $_.sha256 })
  Record ('package:' + $m) ($bad.Count -eq 0) $bad.Count
}

$task = Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction SilentlyContinue
Record 'companion-task-present' ($null -ne $task)
if ($task) { Record 'companion-task-not-elevated' ($task.Principal.RunLevel -eq 'Limited') }
Record 'not-halted' (-not (Test-Path -LiteralPath (Join-Path $Root 'state\HALT.json')))
Record 'not-paused' (-not (Test-Path -LiteralPath (Join-Path $Root 'state\PAUSED.json')))
$node = Join-Path $Root 'runtime\node.exe'
$verifier = Join-Path $Root ('resident\' + $receipt.residentManifestSha256 + '\tools\verify-receipts.mjs')
# node is started with a cleared, fixed environment (no NODE_OPTIONS or other user variables) so an
# elevated verify never hands the admin token to code chosen through the Owner's environment (review M1).
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $node; $psi.Arguments = '"' + $verifier + '" "' + (Join-Path $Root 'state\receipts') + '"'
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $Root
$psi.EnvironmentVariables.Clear(); foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('WINDIR', 'C:\Windows'), @('PATH', 'C:\Windows\System32'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
$proc = [Diagnostics.Process]::Start($psi); $chain = $proc.StandardOutput.ReadToEnd(); $proc.WaitForExit()
Record 'receipt-chain' ($proc.ExitCode -eq 0) ($chain.Trim())

$allOk = -not ($checks.Values | Where-Object { $_.ok -ne $true })
$unreadable = [bool]($checks.Values | Where-Object { $_.ok -eq 'unreadable' })
[ordered]@{ status = if ($allOk) { 'RESIDENT_VERIFIED' } elseif ($unreadable) { 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED' } else { 'RESIDENT_VERIFICATION_FAILED' }; checks = $checks } | ConvertTo-Json -Depth 6
exit $(if ($allOk) { 0 } elseif ($unreadable) { 2 } else { 1 })
