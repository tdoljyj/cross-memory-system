# Source fragment for resume.py, injected into the unchanged reinstall launcher.
# Defining these functions has no effects. Only the reviewed launcher calls them.
function Complete-PartialUninstallRename([string]$root, [string]$target, [string]$planSha, [string]$priorSha) {
  if ($planSha -cnotmatch '^[0-9a-f]{64}$' -or $priorSha -cnotmatch '^[0-9a-f]{64}$') { throw 'RESUME_RECEIPT_PINS_REQUIRED' }
  $root = [IO.Path]::GetFullPath($root); $target = [IO.Path]::GetFullPath($target)
  if ([IO.Path]::GetFileName($root) -cne 'resident' -or [IO.Path]::GetDirectoryName($root) -cne [IO.Path]::GetDirectoryName($target) -or
      [IO.Path]::GetFileName($target) -cnotmatch '^resident-uninstalled-\d{8}T\d{6}Z-[0-9a-f]{12}$') { throw 'RESUME_RENAME_TARGET_REFUSED' }
  foreach ($directory in @([IO.Path]::GetDirectoryName($root), $root, (Join-Path $root 'install'))) {
    if (-not [IO.Directory]::Exists($directory) -or ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RESUME_RENAME_DIRECTORY_NOT_PLAIN' }
  }
  if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target) -or [IO.File]::Exists((Join-Path $root 'install\uninstall-receipt.json'))) { throw 'RESUME_ALREADY_RENAMED_OR_RECEIPTED' }
  [IO.Directory]::Move($root, $target)
  $receipt = [ordered]@{ contract = 'clued.independent-ci.resident-uninstall-receipt/3'; planSha256 = $planSha; keptAt = $target
    at = [DateTimeOffset]::UtcNow.ToString('o'); continuation = [ordered]@{ contract = 'clued.independent-ci.resume-uninstall-evidence/1'; priorTerminalSha256 = $priorSha } }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($receipt | ConvertTo-Json -Depth 6))
  $file = [IO.File]::Open((Join-Path $target 'install\uninstall-receipt.json'), 'CreateNew', 'Write', 'None')
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
  $receipt
}

function Step-FinishUninstall {
  if ($ResidentRoot -cne 'C:\ProgramData\CluedIndependentCI\resident') { Stop-Launch 'RESUME_ROOT_NOT_THE_FIXED_TARGET' $null }
  $prior = [ordered]@{}
  $directory = New-Object IO.DirectoryInfo($ResumePriorRoot)
  while ($null -ne $directory) {
    if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Launch 'RESUME_PRIOR_DIRECTORY_NOT_PLAIN' $null }
    $directory = $directory.Parent
  }
  foreach ($name in $ResumePriorPins.Keys) {
    $file = Join-Path $ResumePriorRoot $name
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (New-Object IO.FileInfo($file)).Length -gt 16777216) { Stop-Launch 'RESUME_PRIOR_FILE_NOT_PLAIN' $name }
    $bytes = [IO.File]::ReadAllBytes($file)
    if ((Sha256Bytes $bytes) -cne $ResumePriorPins[$name]) { Stop-Launch 'RESUME_PRIOR_FILE_CHANGED' $name }
    $prior[$name] = $bytes
  }
  $terminal = Parse-Json ($Strict8.GetString($prior['terminal.json']))
  if ((Get-Key $terminal 'contract') -cne 'clued.independent-ci.source-v2-windows-launch-terminal/1' -or
      (Get-Key $terminal 'status') -cne 'STOPPED' -or (Get-Key $terminal 'code') -cne 'UNINSTALL_NOT_COMPLETED' -or
      (Get-Key $terminal 'sourceSha') -cne $SourceSha -or (Get-Key $terminal 'packageHead') -cne $PackageHead) { Stop-Launch 'RESUME_PRIOR_SUBJECT_CHANGED' $null }
  $detail = Get-Key $terminal 'detail'; $dry = Get-Key $detail 'dryRun'; $plan = Get-Key $dry 'plan'
  if ((Get-Key $dry 'planSha256') -cne $ResumeUninstallPlanSha256 -or -not (Test-UninstallPlan $plan) -or
      (Get-Key $plan 'executorAlive') -ne $false) { Stop-Launch 'RESUME_PRIOR_PLAN_CHANGED' $null }
  $before = Parse-Json ($Strict8.GetString($prior['uninstall-preflight-report.json']))
  $acl = Parse-LastLine ($Strict8.GetString($prior['migrate-acl.dry-run.before-uninstall.stdout.json']))
  $parent = Parse-Json ($Strict8.GetString($prior['parent-acl-report.json']))
  $quiesce = Parse-Json ($Strict8.GetString($prior['quiesce-report.json']))
  if (@(Get-Key $before 'codes').Count -ne 0 -or (Get-Key $before 'installedReceiptSha256') -cne $InstalledReceiptSha256 -or
      (Get-Key $before 'installedUninstallSha256') -cne $InstalledUninstallSha256 -or
      (Get-Key $acl 'status') -cne 'SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN' -or
      (Get-Key $parent 'error') -or (Get-Key $parent 'now') -cne $ParentSddlBefore -or
      (Get-Key $quiesce 'residentStopped') -ne $true -or (Get-Key $quiesce 'brokerStopped') -ne $true -or
      (Get-Key $quiesce 'noProcessUnderRoot') -ne $true) { Stop-Launch 'RESUME_PRIOR_PREFLIGHT_OR_QUIESCE_REFUSED' $null }

  foreach ($path in @('C:\ProgramData', $ParentAclPath, $ResidentRoot, (Join-Path $ResidentRoot 'install'), (Join-Path $ResidentRoot 'state'))) {
    if (-not [IO.Directory]::Exists($path) -or ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Launch 'RESUME_INSTALLED_DIRECTORY_NOT_PLAIN' $null }
  }
  if ((Get-FileSha (Join-Path $ResidentRoot 'install\install-receipt.json')) -cne $InstalledReceiptSha256 -or
      (Get-FileSha $InstalledUninstall) -cne $InstalledUninstallSha256 -or
      (Get-FileSha (Join-Path $ResidentRoot 'state\HALT.json')) -cne $InstalledHaltSha256 -or
      (Get-FileSha (Join-Path $ResidentRoot 'state\PAUSED.json')) -cne $InstalledPausedSha256 -or
      -not (Test-TerminalEvidence $ResidentRoot) -or [IO.File]::Exists((Join-Path $ResidentRoot 'install\uninstall-receipt.json'))) { Stop-Launch 'RESUME_INSTALLED_EVIDENCE_CHANGED' $null }
  if ((Get-Acl -LiteralPath $ParentAclPath).Sddl -cne $ParentSddlBefore -or -not (Get-RunnerState).ok -or
      (Test-ExecutorAlive).alive -or @(Get-ProcessesUnderRoot).Count) { Stop-Launch 'RESUME_HOST_NOT_QUIET_AS_REVIEWED' $null }
  $quiet = Test-OldRootQuiet; $carry = Test-CurrentRootCarryShape; $secrets = Test-SecretsAsVerify
  if (@($quiet.codes).Count -or @($carry.codes).Count -or @($secrets.codes).Count) { Stop-Launch 'RESUME_LIVE_PREFLIGHT_REFUSED' $null }
  $upgradeFile = Join-Path $ResidentRoot 'upgrade\status.json'
  if ([IO.File]::Exists($upgradeFile)) {
    if (([IO.File]::GetAttributes($upgradeFile) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Launch 'RESUME_UPGRADE_STATE_REFUSED' $null }
    $upgrade = Parse-Json ([IO.File]::ReadAllText($upgradeFile))
    if ($null -eq $upgrade -or $null -ne (Get-Key $upgrade 'op')) { Stop-Launch 'RESUME_UPGRADE_STATE_REFUSED' $null }
  }
  $services = @((Get-ScState 'CluedCIResident'), (Get-ScState 'CluedCISwapBroker'), (Get-ScState 'CluedCIUpgrader'))
  if (@($services | Where-Object { $_.nativeExit -ne 1060 -or -not $_.gone }).Count) { Stop-Launch 'RESUME_SERVICES_NOT_ABSENT' $null }
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1'
  if (@(Get-CimInstance Win32_Service -Filter "Name='CluedCIResident' OR Name='CluedCISwapBroker' OR Name='CluedCIUpgrader'").Count) { Stop-Launch 'RESUME_CIM_SERVICES_NOT_ABSENT' $null }
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
  if (@(Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction SilentlyContinue).Count) { Stop-Launch 'RESUME_COMPANION_TASK_PRESENT' $null }
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'
  if (@(Get-NetFirewallRule -Name 'CluedCIResident-BlockOutbound' -ErrorAction SilentlyContinue).Count) { Stop-Launch 'RESUME_OLD_FIREWALL_RULE_PRESENT' $null }
  $found = Get-SpoolLeftovers $Spool; $remainder = Get-SpoolRemainder $Spool $found
  if ($found.Count -or $remainder.Count) { Stop-Launch 'RESUME_SPOOL_NOT_EMPTY' $null }
  # Retain the real original pre-uninstall proof for the unchanged post-rename
  # ACL and carry-forward preflight. No service/configuration action is repeated.
  foreach ($name in @('uninstall-preflight-report.json', 'migrate-acl.dry-run.before-uninstall.stdout.json', 'parent-acl-report.json', 'quiesce-report.json')) {
    Write-New (Join-Path $Out $name) $prior[$name]
  }
  $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $hex = -join ((1..6) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
  $target = Join-Path $ParentAclPath ('resident-uninstalled-' + $stamp + '-' + $hex)
  $receipt = Complete-PartialUninstallRename $ResidentRoot $target $ResumeUninstallPlanSha256 $ResumePriorPins['terminal.json']
  if (-not (Test-TerminalEvidence $target) -or
      (Get-FileSha (Join-Path $target 'install\install-receipt.json')) -cne $InstalledReceiptSha256 -or
      (Get-FileSha (Join-Path $target 'state\HALT.json')) -cne $InstalledHaltSha256 -or
      (Get-FileSha (Join-Path $target 'state\PAUSED.json')) -cne $InstalledPausedSha256) { Stop-Launch 'RESUME_KEPT_EVIDENCE_CHANGED' $null }
  $receiptBytes = [IO.File]::ReadAllBytes((Join-Path $target 'install\uninstall-receipt.json'))
  Write-New (Join-Path $Out 'uninstall-receipt.json') $receiptBytes
  $uninstall = [ordered]@{ keptAt = $target; planSha256 = $ResumeUninstallPlanSha256; uninstallReceiptSha256 = Sha256Bytes $receiptBytes; haltSha256 = $InstalledHaltSha256 }
  Write-Json 'finish-uninstall-report.json' ([ordered]@{ status = 'PRIOR_UNINSTALL_RENAME_FINISHED_NO_SERVICE_OPERATION_REPEATED'
    originalLauncherSha256 = $ResumeOriginalLauncherSha256; priorTerminalSha256 = $ResumePriorPins['terminal.json']; uninstall = $uninstall; services = $services })
  $Done.Add('uninstall-finish-only')
  [ordered]@{ uninstall = $uninstall; parentAcl = $parent; quiesce = $quiesce }
}
