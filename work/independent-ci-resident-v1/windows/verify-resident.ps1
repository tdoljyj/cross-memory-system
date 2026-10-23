<#
.SYNOPSIS
  Read-only verification of an installed resident executor (DRAFT). Writes nothing.

.DESCRIPTION
  Run the INSTALLED copy (C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\).
  Re-derives every pin of the install receipt (admin-only install\ directory) and compares it with
  the live host: package hashes, both services (account, start type, SID type, failure actions,
  DACL as recorded at install, required privileges via `sc qprivs`, the effective token privileges each host
  recorded at start, the broker's binary path with its config-hash argument and broker.json against that
  hash, the broker's failure actions, the resident's outbound firewall block and the firewall being on),
  the runner service byte-for-byte unchanged (SDDL, binary, account), the companion task
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
# Resident quota redesign phase 1: the carried-forward executed heads the install listed, and the resident's backfill of
# them (no batch runs before it; state\executed-heads\BACKFILL-COMPLETE.json once done).
$backfillManifest = Join-Path $Root 'install\backfill-manifest.json'
Record 'backfill-manifest' ((Test-Path -LiteralPath $backfillManifest -PathType Leaf) -and ((Sha256File $backfillManifest) -ceq [string]$receipt.backfillManifestSha256))
$marker = Join-Path $Root 'state\executed-heads\BACKFILL-COMPLETE.json'
$until = [DateTime]::UtcNow.AddSeconds(90)   # right after an install the first tick may still be running it
while (-not (Test-Path -LiteralPath $marker -PathType Leaf) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Seconds 3 }
$markerDetail = if (Test-Path -LiteralPath $marker -PathType Leaf) { try { $m = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json; 'published ' + $m.published + ', unreadable ' + $m.unreadable } catch { 'marker unreadable' } } else { $null }
Record 'executed-heads-backfilled' (Test-Path -LiteralPath $marker -PathType Leaf) $markerDetail

$qc = & $Sc qc CluedCIResident | Out-String
Record 'resident-account' ($qc -match 'SERVICE_START_NAME\s*:\s*NT SERVICE\\CluedCIResident')
Record 'resident-start-type' ($qc -match 'START_TYPE\s*:\s*2\s')
Record 'resident-sid-type' ((& $Sc qsidtype CluedCIResident | Out-String) -match 'SERVICE_SID_TYPE\s*:\s*UNRESTRICTED')
Record 'resident-host-pin' ((Sha256File (Join-Path $Root 'bin\ResidentServiceHost.exe')) -ceq $receipt.ResidentServiceHostSha256)
$bq = & $Sc qc CluedCISwapBroker | Out-String
Record 'broker-account' ($bq -match 'SERVICE_START_NAME\s*:\s*LocalSystem')
Record 'broker-host-pin' ((Sha256File (Join-Path $Root 'bin\SwapBroker.exe')) -ceq $receipt.SwapBrokerSha256)
# ---- Privilege boundary (independent review of PR-A: MAJOR-1, MINOR-4, MINOR-5) ----
$ResidentPrivileges = @('SeChangeNotifyPrivilege')
$BrokerPrivileges = @('SeChangeNotifyPrivilege', 'SeCreateGlobalPrivilege')
function ConvertFrom-ScPrivs([string]$text) {
  $names = @(foreach ($line in ($text -split "`r?`n")) { if ($line -match '^\s*(?:PRIVILEGES\s*)?:\s*(Se[A-Za-z]+Privilege)\s*$') { $Matches[1] } })
  @($names | Sort-Object -CaseSensitive)
}
function Test-ExactPrivileges($have, $want) { (@($have | Sort-Object -CaseSensitive) -join '/') -ceq (@($want | Sort-Object -CaseSensitive) -join '/') }
# A host's own token record: the privileges it holds are a subset of the allow-list (SeChangeNotify at least).
function Test-TokenRecord([string]$json, $allowed) {
  try { $v = $json | ConvertFrom-Json } catch { return $false }
  if ($null -eq $v -or $v.contract -cne 'clued.independent-ci.service-token-privileges/1') { return $false }
  $have = @($v.privileges); ($have -ccontains 'SeChangeNotifyPrivilege') -and (@($have | Where-Object { $allowed -cnotcontains $_ }).Count -eq 0)
}
# `sc qc` of the broker: exactly "<Root>\bin\SwapBroker.exe" "<Root>" <broker.json SHA-256>.
function Test-BrokerBinaryPath([string]$qcText, [string]$root, [string]$configSha) {
  if ($configSha -cnotmatch '^[0-9a-f]{64}$' -or $qcText -notmatch 'BINARY_PATH_NAME\s*:\s*(.+?)\s*(\r?\n|$)') { return $false }
  $Matches[1] -ceq ('"' + (Join-Path $root 'bin\SwapBroker.exe') + '" "' + $root + '" ' + $configSha)
}
# sc.exe sdshow also prints the SACL ("S:...") when the caller may read it (elevated) and not otherwise;
# every service-descriptor comparison uses the DACL section alone, so both views agree.
function Get-DaclPart([string]$sd) { $t = ([string]$sd).Trim(); $i = $t.IndexOf('D:'); if ($i -lt 0) { return $t }; $t = $t.Substring($i); $j = $t.IndexOf('S:'); if ($j -ge 0) { $t = $t.Substring(0, $j) }; $t }
function Test-ScSddl([string]$sdshow, [string]$want) { -not [string]::IsNullOrEmpty($want) -and (Get-DaclPart $sdshow) -ceq $want }
function Get-ScText([string[]]$scArgs) { $t = & $Sc @scArgs | Out-String; if ($LASTEXITCODE -ne 0) { 'unreadable' } else { $t } }
foreach ($pair in @(@('CluedCIResident', 'resident', $ResidentPrivileges), @('CluedCISwapBroker', 'broker', $BrokerPrivileges))) {
  $p = Get-ScText @('qprivs', $pair[0], '8192')
  Record ($pair[1] + '-required-privileges') $(if ($p -eq 'unreadable') { 'unreadable' } else { Test-ExactPrivileges (ConvertFrom-ScPrivs $p) $pair[2] })
  $d = Get-ScText @('sdshow', $pair[0])
  Record ($pair[1] + '-service-dacl') $(if ($d -eq 'unreadable') { 'unreadable' } else { Test-ScSddl $d $receipt.($pair[1] + 'Sddl') })
}
Record 'broker-binary-path-and-config-pin' (Test-BrokerBinaryPath $bq $Root $receipt.brokerConfigSha256)
Record 'broker-config-hash' ((Sha256File (Join-Path $Root 'config\broker.json')) -ceq $receipt.brokerConfigSha256)
Record 'broker-failure-actions' ((Get-ScText @('qfailure', 'CluedCISwapBroker', '8192')) -match 'RESTART')
foreach ($pair in @(@('state\service-token.json', $ResidentPrivileges, 'resident'), @('broker\token.json', $BrokerPrivileges, 'broker'))) {
  $f = Join-Path $Root $pair[0]
  Record ($pair[2] + '-effective-token-privileges') $(if (Test-Path -LiteralPath $f) { Test-TokenRecord (Get-Content -LiteralPath $f -Raw) $pair[1] } else { 'unreadable' })
}
try {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'
  $rule = Get-NetFirewallRule -Name 'CluedCIResident-BlockOutbound' -ErrorAction Stop; $filter = $rule | Get-NetFirewallServiceFilter
  Record 'resident-outbound-blocked' ([string]$rule.Direction -ceq 'Outbound' -and [string]$rule.Action -ceq 'Block' -and [string]$rule.Enabled -ceq 'True' -and $filter.Service -ceq 'CluedCIResident')
  Record 'firewall-enabled' (@(Get-NetFirewallProfile | Where-Object { [string]$_.Enabled -cne 'True' }).Count -eq 0)
} catch { Record 'resident-outbound-blocked' $false }

$runnerSddl = try { Get-DaclPart (& $Sc sdshow $Runner | Out-String) } catch { 'unreadable' }
Record 'runner-sddl-unchanged' $(if ($runnerSddl -eq 'unreadable') { 'unreadable' } else { $runnerSddl -ceq $receipt.runnerSddlUnchanged })
$rq = & $Sc qc $Runner | Out-String
Record 'runner-original-and-controller' (($rq -match 'C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe') -and ($rq -match 'SERVICE_START_NAME\s*:\s*(\.|TURING)\\clued-control'))

foreach ($m in @('config\source-installed-manifest.json', 'config\resident-installed-manifest.json')) {
  $man = Get-Content -LiteralPath (Join-Path $Root $m) -Raw | ConvertFrom-Json
  # Source v2 installs the CI Source under source\<ciSourceManifestSha256>, the hash of the installed record's
  # source-manifest.json (the package's sourceManifestSha256 names the file list, not the directory).
  $base = if ($man.root -ceq 'source') { Join-Path $Root ('source\' + (Sha256File (Join-Path $Root 'record\source-manifest.json'))) } else { Join-Path $Root ('resident\' + $receipt.residentManifestSha256) }
  $bad = @($man.files | Where-Object { (Sha256File (Join-Path $base $_.path)) -cne $_.sha256 })
  Record ('package:' + $m) ($bad.Count -eq 0) $bad.Count
}

# The companion task runs the installed node copy under the in-box conhost.exe --headless, so it has no console
# window the Owner could close (install-resident.ps1 Get-CompanionAction).
function Test-CompanionAction([string]$execute, [string]$arguments, [string]$root, [string]$residentSha) {
  $want = '--headless "' + (Join-Path $root 'runtime\node.exe') + '" "' + (Join-Path $root ('resident\' + $residentSha + '\src\companion-main.mjs')) + '" --root "' + $root + '" --config-sha256 '
  ($execute -ceq 'C:\Windows\System32\conhost.exe') -and $arguments.StartsWith($want, [StringComparison]::Ordinal) -and ($arguments.Substring($want.Length) -cmatch '^[0-9a-f]{64}$')
}
$task = Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction SilentlyContinue
Record 'companion-task-present' ($null -ne $task)
if ($task) {
  Record 'companion-task-not-elevated' ($task.Principal.RunLevel -eq 'Limited')
  $actions = @($task.Actions)
  Record 'companion-task-windowless' (($actions.Count -eq 1) -and (Test-CompanionAction ([string]$actions[0].Execute) ([string]$actions[0].Arguments) $Root $receipt.residentManifestSha256))
}
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
