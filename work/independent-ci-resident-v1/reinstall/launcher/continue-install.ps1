# Source fragment for continue.py (generate.py --fleet-continue), injected into the unchanged package launcher. Defining these functions
# has no effect; only a generated continuation calls one of its Step-Continue* steps, in place of the steps the prior launch already completed.
#
# What every continuation proves first, elevated (Get-ContinuePrior):
#   - the prior launch is not still running (its last progress record names its process and that process's start time);
#   - the progress records this elevated side wrote under the CI root (reinstall-progress-<id>) are exactly the ones the continuation
#     was generated from (the launch directory's copies are the Owner's to change; these are not);
#   - the prior launch's evidence files are byte for byte the ones it was generated from ($ContinuePriorPins);
#   - no installed uninstall-resident.ps1 is running (a launch cut off while its -Apply ran leaves that child process behind).
# Any doubt stops before anything is written outside this run's own directories; nothing is guessed.
# Every continuation also writes into its own launch directory what a later continuation reads (linux-report.json, uninstall-report.json,
# the post-install reports it carried), so that a continuation can be continued in turn from its own launch directory alone.
function Get-ContinueUninstallProcesses {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1'
  @(Get-CimInstance -ClassName Win32_Process | Where-Object { ([string]$_.CommandLine).IndexOf('\windows\uninstall-resident.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; name = [string]$_.Name } })
}
function Get-ContinuePrior($report, [scriptblock]$stop) {
  if (-not $FleetPlanSha256) { & $stop 'CONTINUE_PINS_REFUSED' }
  $alive = $null
  try { $p = Get-Process -Id ([int]$ContinuePriorPid) -ErrorAction Stop; $alive = ($p.StartTime.ToUniversalTime().ToString('o') -ceq $ContinuePriorProcessStart) } catch { $alive = $false }
  $report['priorLaunchStillRunning'] = $alive
  if ($alive) { & $stop 'CONTINUE_PRIOR_LAUNCH_STILL_RUNNING' }
  $report['uninstallProcesses'] = @(Get-ContinueUninstallProcesses)
  if ($report['uninstallProcesses'].Count) { & $stop 'CONTINUE_UNINSTALL_STILL_RUNNING' }
  $id = (Sha256Bytes ($U8.GetBytes(([string]$ContinuePriorRoot).ToLowerInvariant()))).Substring(0, 32)
  $elevated = Join-Path $CarryParent ('reinstall-progress-' + $id)
  $names = @(); try { if ([IO.Directory]::Exists($elevated) -and ([IO.File]::GetAttributes($elevated) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $names = @([IO.Directory]::GetFiles($elevated) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object) } } catch { $names = @() }
  $report['priorProgress'] = $names
  if (($names -join '|') -cne $ContinuePriorProgress) { & $stop 'CONTINUE_PRIOR_PROGRESS_NOT_THE_ELEVATED_RECORD' }
  $prior = [ordered]@{}
  foreach ($name in @($ContinuePriorPins.Keys)) {
    $f = Join-Path $ContinuePriorRoot $name
    $b = try { if ([IO.File]::Exists($f) -and ([IO.File]::GetAttributes($f) -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and (New-Object IO.FileInfo($f)).Length -le 16777216) { [IO.File]::ReadAllBytes($f) } else { $null } } catch { $null }
    $report.priorFiles[$name] = $(if ($null -eq $b) { $null } else { Sha256Bytes $b })
    if ($null -eq $b -or $report.priorFiles[$name] -cne $ContinuePriorPins[$name]) { & $stop 'CONTINUE_PRIOR_EVIDENCE_CHANGED' }
    $prior[$name] = $b
  }
  , $prior
}
# Phase B's evidence and version facts by the launcher's own rules, then staged for verify and kept in this run's output.
function Set-ContinueLinuxOutput($report, [scriptblock]$stop, [byte[]]$evidence, [byte[]]$facts) {
  $codes = Test-FleetLinuxOutput ($Strict8.GetString($evidence)) ($Strict8.GetString($facts))
  if ($codes.Count) { $report.codes = @($codes); Write-Json 'continue-report.json' $report; Stop-Launch $codes[0] $report }
  $staged = Join-Path $Stage 'linux-version-facts.phase-B.json'; Write-New $staged $facts
  Write-New (Join-Path $Out 'linux-live-manifest.txt') $evidence; Write-New (Join-Path $Out 'linux-version-facts.json') $facts
  Write-Json 'linux-report.json' ([ordered]@{ codes = @(); planSha256 = $FleetPlanSha256; versionFactsSha256 = (Sha256Bytes $facts); evidenceSha256 = (Sha256Bytes $evidence); continuedFrom = $ContinuePriorRoot })
  [ordered]@{ factsSource = $staged; factsSha256 = (Sha256Bytes $facts); evidenceSha256 = (Sha256Bytes $evidence); continuedFrom = $ContinuePriorRoot }
}
# A prior run's output (one that ran into the launcher's timeout, or whose output the registrar refused to capture), read as the
# launcher reads a run's: elsewhere out\ itself; on a companion node only what the registrar captured (capture-file: no link followed, one
# name, at most 4 MiB) into a capture directory of THIS continuation, captured-<32hex>\ under the same run directory (the launcher's
# New-FleetCaptureDirectory). A capture is create-only, so a later continuation never meets this
# one's copies; earlier capture directories stay as evidence.
# { bytes; refused }: the captured copy's bytes, or the registrar's refusal code (refused: the capture itself was refused).
function Read-ContinueCaptured([string]$registrar, [string]$source, [string]$directory, [int]$max) {
  $leaf = [IO.Path]::GetFileName($source)
  $c = Invoke-FleetProcess $registrar ('capture-file ' + $source + ' ' + (Join-Path $directory $leaf)) 120
  if ($c.timedOut -or $c.exit -ne 0 -or [string]$c.stdout -notmatch '"code":"FILE_CAPTURED"') {
    $code = $(if ($c.timedOut) { 'REGISTRAR_TIMEOUT' } elseif ([string]$c.stdout -match '"code":"([A-Z0-9_]+)"') { $Matches[1] } else { 'REGISTRAR_OUTPUT_UNREADABLE' })
    return [ordered]@{ bytes = $null; refused = $code }
  }
  [ordered]@{ bytes = (Read-FleetFileChecked $directory $leaf $max); refused = $null }
}
# The prior run's final status line. First whether the run still has a process (Get-FleetRunProcesses): one is there ->
# LINUX_PHASE_STILL_RUNNING_RETRY (the same continuation command again later; nothing of the run is read); the query fails ->
# RUN_PROCESS_QUERY_FAILED (never taken for "none"). None is: its output is read (on a companion node captured first: a refused capture ->
# LINUX_PHASE_OUTPUT_NOT_CAPTURED with the registrar's code); the final status -> on; REFUSED -> $failedCode; anything else ->
# LINUX_PHASE_ENDED_WITHOUT_STATUS (it never will have one: a person looks).
# $capture: $null, or the registrar and this continuation's capture directory (a companion node).
function Get-ContinuePriorRunResult($report, [scriptblock]$stop, [string]$runDirectory, [string]$final, [string]$failedCode, $capture, [string]$label) {
  $processes = $null
  try { $processes = @(Get-FleetRunProcesses $runDirectory) } catch { $report.state['runProcessQuery'] = [string]$_.Exception.Message }
  if ($null -eq $processes) { & $stop 'RUN_PROCESS_QUERY_FAILED' }
  $report.state['runProcesses'] = $processes
  if ($processes.Count) { & $stop 'LINUX_PHASE_STILL_RUNNING_RETRY' }
  $runOut = Join-Path $runDirectory 'out'
  if ($capture) {
    $o = Read-ContinueCaptured $capture.exe (Join-Path $runOut 'stdout.txt') $capture.directory 4194304
    $e = Read-ContinueCaptured $capture.exe (Join-Path $runOut 'stderr.txt') $capture.directory 4194304
    $report.state[$label + 'StderrCaptureRefused'] = $e.refused   # recorded; the status line is stdout's
    if ($o.refused) { $report.state[$label + 'CaptureRefused'] = $o.refused; & $stop 'LINUX_PHASE_OUTPUT_NOT_CAPTURED' }
    $so = $o.bytes; $se = $e.bytes
  } else { $so = Read-FleetFileChecked $runOut 'stdout.txt' 4194304; $se = Read-FleetFileChecked $runOut 'stderr.txt' 4194304 }
  $text = $(if ($null -eq $so) { $null } else { $U8.GetString($so) })
  $last = Parse-LastLine $text
  $report.state[$label + 'Status'] = [string](Get-Key $last 'status')
  if ($report.state[$label + 'Status'] -ceq 'REFUSED') { $report.state[$label + 'Code'] = [string](Get-Key $last 'code'); & $stop $failedCode }
  if ($report.state[$label + 'Status'] -cne $final) { & $stop 'LINUX_PHASE_ENDED_WITHOUT_STATUS' }
  [ordered]@{ text = $text; stderr = $(if ($null -eq $se) { $null } else { $U8.GetString($se) }); last = $last }
}
# The registrar and this continuation's capture directory on a companion node ($null elsewhere); the caller removes the build.
function New-ContinueCapture($report, [scriptblock]$stop, [string]$runDirectory) {
  if (-not $FleetCompanionAccount) { return $null }
  $build = $null; try { $build = New-FleetRegistrar } catch { & $stop 'LINUX_REGISTRAR_BUILD_FAILED' }
  $capture = [ordered]@{ build = $build; exe = $build.exe; directory = $null }
  $script:ContinueCaptureBuild = $build
  $capture.directory = New-FleetCaptureDirectory $runDirectory   # the launcher's own: captured-<32hex>, SYSTEM and Administrators only
  $report.state['captureDirectory'] = $capture.directory
  $capture
}
# The uninstall as this run proved it, in the shape of Step-Uninstall's report (what a later continuation of this run reads).
function Write-ContinueUninstallReport([string]$kept, [string]$uninstallReceiptSha256) {
  Write-Json 'uninstall-report.json' ([ordered]@{ apply = [ordered]@{ status = 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT'; keptAt = $kept }; deletedAndRenamed = $true
    evidence = [ordered]@{ keptAt = $kept; installReceiptSha256 = $InstalledReceiptSha256; uninstallReceiptSha256 = $uninstallReceiptSha256; terminalEvidenceMatches = $true }; continuedFrom = $ContinuePriorRoot })
}

# The prior launch finished Linux (or its phase B ran into the launcher's timeout) and stopped before its uninstall began: the
# installed resident is still there, Linux is (or is becoming) the new package's generation 1. This step replaces the Linux steps only;
# the uninstall preflight, the uninstall and everything after are the launcher's own.
#   - the installed root is there and its install receipt is the reviewed one;
#   - $ContinueLinuxFrom 'prior-launch': B's output as the prior launch checked and saved it, by the same rules again;
#     'out-directory' (the prior launch stopped on B's timeout): B's own stdout, in the prior run directory only this elevated side and
#     the account can reach, must now end with B's final status; then its evidence and facts are read from the out directory and
#     checked. Not finished yet: LINUX_PHASE_STILL_RUNNING_RETRY (run the same continuation command again later). Finished with a
#     refusal: LINUX_PHASE_B_FAILED_AFTER_ITS_TIMEOUT (the node stays paused; a person looks);
#   - the elevated file-lock observation again, and the tokens carried from the live root.
function Step-ContinueBeforeUninstall {
  $report = [ordered]@{ mode = 'before-uninstall'; linuxFrom = $ContinueLinuxFrom; priorRoot = $ContinuePriorRoot; originalLauncherSha256 = $ContinueOriginalLauncherSha256; priorFiles = [ordered]@{}; state = [ordered]@{}; codes = @() }
  $stop = { param([string]$code) $report.codes = @($code); Write-Json 'continue-report.json' $report; Stop-Launch $code $report }
  $prior = Get-ContinuePrior $report $stop
  $report.state['installReceiptSha256'] = Get-FileSha (Join-Path $ResidentRoot 'install\install-receipt.json')
  if (-not [IO.Directory]::Exists($ResidentRoot)) { & $stop 'CONTINUE_NODE_ALREADY_UNINSTALLED' }
  if ($report.state['installReceiptSha256'] -cne $InstalledReceiptSha256) { & $stop 'CONTINUE_INSTALLED_RECEIPT_NOT_AS_REVIEWED' }
  if ($ContinueLinuxFrom -ceq 'prior-launch') { $eb = $prior['linux-live-manifest.txt']; $fb = $prior['linux-version-facts.json'] }
  elseif ($ContinueLinuxFrom -ceq 'out-directory') {
    if ((Split-Path -Parent $ContinueLastRunDirectory) -cne (Join-Path $ResidentRoot 'install') -or (Split-Path -Leaf $ContinueLastRunDirectory) -cnotmatch '^linux-run-[0-9a-f]{32}$') { & $stop 'CONTINUE_PINS_REFUSED' }
    $eb = $null; $fb = $null; $script:ContinueCaptureBuild = $null
    try {
      $capture = New-ContinueCapture $report $stop $ContinueLastRunDirectory
      $b = Get-ContinuePriorRunResult $report $stop $ContinueLastRunDirectory 'LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1' 'LINUX_PHASE_B_FAILED_AFTER_ITS_TIMEOUT' $capture 'phaseB'
      $ef = Get-FleetOutFile ([string](Get-Key $b.last 'evidence')) '^linux-live-manifest\.[0-9]{8}T[0-9]{6}Z\.txt$'
      $ff = Get-FleetOutFile ([string](Get-Key $b.last 'versionFacts')) '^linux-version-facts\.[0-9]{8}T[0-9]{6}Z\.json$'
      if (-not $ef -or -not $ff) { & $stop 'LINUX_OUTPUT_PATHS_NOT_IN_THE_OUT_DIRECTORY' }
      # as Step-LinuxRoot reads them (Read-FleetOutFile): on a companion node captured into this continuation's capture directory
      $run = [ordered]@{ captured = $(if ($capture) { $capture.directory } else { $null }) }; $exe = $(if ($capture) { $capture.exe } else { $null })
      $eb = Read-FleetOutFile ([IO.Path]::GetFileName($ef)) $run $exe 1048576; $fb = Read-FleetOutFile ([IO.Path]::GetFileName($ff)) $run $exe 1048576
    } finally { Remove-FleetRegistrar $script:ContinueCaptureBuild }
    if ($null -eq $eb -or $null -eq $fb) { & $stop 'LINUX_OUTPUT_UNREADABLE' }
  } else { & $stop 'CONTINUE_PINS_REFUSED' }
  $linux = Set-ContinueLinuxOutput $report $stop $eb $fb
  $fileLocks = Step-FileLocks
  $carried = Step-CarryTokens
  Write-Json 'continue-report.json' $report
  $Done.Add('continued-before-uninstall')
  [ordered]@{ carried = $carried; linux = $linux; fileLocks = $fileLocks }
}

# The prior launch completed the uninstall and stopped (or was cut off) before the install completed: Linux is the new package's
# generation 1, the old root is the kept resident-uninstalled-* directory, nothing is installed on the Windows side. This step replaces
# the Linux steps and the uninstall; the install preflight, the install and everything after are the launcher's own.
#   - no resident root, none of the three services; the kept root is the one the prior uninstall reported, a plain directory, the newest
#     resident-uninstalled-*, holding the reviewed install receipt, the prior uninstall's receipt and the pinned terminal evidence;
#   - phase B's output as the prior launch saved it, by the same rules again;
#   - the tokens are carried from the kept root's secrets\ exactly as from a live root (Step-CarryTokens);
#   - the prior run's migrate-acl dry run (before its uninstall) is copied into this run's output, where Step-Preflight reads it.
function Step-ContinueAfterUninstall {
  $report = [ordered]@{ mode = 'after-uninstall'; priorRoot = $ContinuePriorRoot; keptRoot = $ContinueKeptRoot; originalLauncherSha256 = $ContinueOriginalLauncherSha256; priorFiles = [ordered]@{}; keptRoots = @(); state = [ordered]@{}; codes = @() }
  $stop = { param([string]$code) $report.codes = @($code); Write-Json 'continue-report.json' $report; Stop-Launch $code $report }
  if ($ContinueKeptRoot -cnotmatch '\\resident-uninstalled-\d{8}T\d{6}Z-[0-9a-f]{12}$' -or (Split-Path -Parent $ContinueKeptRoot) -cne (Split-Path -Parent $ResidentRoot)) { & $stop 'CONTINUE_PINS_REFUSED' }
  $prior = Get-ContinuePrior $report $stop
  $report.state['residentRootExists'] = ([IO.Directory]::Exists($ResidentRoot) -or [IO.File]::Exists($ResidentRoot))
  $report.state['services'] = @((Get-ScState 'CluedCIResident'), (Get-ScState 'CluedCISwapBroker'), (Get-ScState 'CluedCIUpgrader'))
  if ($report.state['residentRootExists'] -or @($report.state['services'] | Where-Object { -not $_.gone }).Count) { & $stop 'CONTINUE_NODE_NOT_UNINSTALLED' }
  if (-not [IO.Directory]::Exists($ContinueKeptRoot) -or ([IO.File]::GetAttributes($ContinueKeptRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { & $stop 'CONTINUE_KEPT_ROOT_MISSING' }
  $report.keptRoots = @([IO.Directory]::GetDirectories((Split-Path -Parent $ResidentRoot), 'resident-uninstalled-*') | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object { $_ -cmatch '^resident-uninstalled-\d{8}T\d{6}Z-[0-9a-f]{12}$' } | Sort-Object)
  if ($report.keptRoots.Count -eq 0 -or $report.keptRoots[$report.keptRoots.Count - 1] -cne [IO.Path]::GetFileName($ContinueKeptRoot)) { & $stop 'CONTINUE_KEPT_ROOT_NOT_THE_NEWEST' }   # something was uninstalled after the prior launch
  $report.state['installReceiptSha256'] = Get-FileSha (Join-Path $ContinueKeptRoot 'install\install-receipt.json')
  $report.state['uninstallReceiptSha256'] = Get-FileSha (Join-Path $ContinueKeptRoot 'install\uninstall-receipt.json')
  $report.state['terminalEvidenceMatches'] = Test-TerminalEvidence $ContinueKeptRoot
  if ($ContinueUninstallReceiptSha256) { $receiptOk = ($report.state['uninstallReceiptSha256'] -ceq $ContinueUninstallReceiptSha256) }
  else {   # cut off inside the -Apply after its rename: the uninstaller's own receipt must name the plan the prior launch's dry run printed
    $u = try { Parse-Json ($Strict8.GetString([IO.File]::ReadAllBytes((Join-Path $ContinueKeptRoot 'install\uninstall-receipt.json')))) } catch { $null }
    $report.state['uninstallReceiptPlanSha256'] = Get-Key $u 'planSha256'
    $receiptOk = ([string]$ContinueUninstallPlanSha256 -cmatch '^[0-9a-f]{64}$' -and (Get-Key $u 'contract') -ceq 'clued.independent-ci.resident-uninstall-receipt/3' -and
      (Get-Key $u 'planSha256') -ceq $ContinueUninstallPlanSha256 -and (Get-Key $u 'keptAt') -ceq $ContinueKeptRoot)
  }
  if ($report.state['installReceiptSha256'] -cne $InstalledReceiptSha256 -or -not $receiptOk -or -not $report.state['terminalEvidenceMatches']) { & $stop 'CONTINUE_KEPT_ROOT_NOT_THE_PRIOR_UNINSTALLS' }
  $linux = Set-ContinueLinuxOutput $report $stop $prior['linux-live-manifest.txt'] $prior['linux-version-facts.json']
  Write-New (Join-Path $Out 'migrate-acl.dry-run.before-uninstall.stdout.json') $prior['migrate-acl.dry-run.before-uninstall.stdout.json']
  # the tokens: from the kept root, where the uninstall left them (the installer's targets, under the kept root instead of the live one)
  $carried = & {
    $prefix = $ResidentRoot + '\'
    if (-not ([string]$UpgradeTokenTarget).StartsWith($prefix, [StringComparison]::Ordinal) -or ($FleetHeartbeatTokenFingerprint -and -not ([string]$HeartbeatTokenTarget).StartsWith($prefix, [StringComparison]::Ordinal))) { & $stop 'CONTINUE_TOKEN_TARGETS_NOT_UNDER_THE_ROOT' }
    $UpgradeTokenTarget = Join-Path $ContinueKeptRoot ([string]$UpgradeTokenTarget).Substring($prefix.Length)
    if ($FleetHeartbeatTokenFingerprint) { $HeartbeatTokenTarget = Join-Path $ContinueKeptRoot ([string]$HeartbeatTokenTarget).Substring($prefix.Length) }
    Step-CarryTokens
  }
  Write-ContinueUninstallReport $ContinueKeptRoot $report.state['uninstallReceiptSha256']
  Write-Json 'continue-report.json' $report
  $Done.Add('continued-after-uninstall')
  [ordered]@{ carried = $carried; linux = $linux
    parentAcl = [ordered]@{ continuedFrom = $ContinuePriorRoot }; quiesce = [ordered]@{ continuedFrom = $ContinuePriorRoot }
    uninstall = [ordered]@{ keptAt = $ContinueKeptRoot; planSha256 = $null; uninstallReceiptSha256 = $report.state['uninstallReceiptSha256']; haltSha256 = (Get-FileSha (Join-Path $ContinueKeptRoot 'state\HALT.json')); continuedFrom = $ContinuePriorRoot } }
}

# The prior launch stopped INSIDE the uninstall (quiesce done; the installed uninstall's -Apply ran and failed: UNINSTALL_NOT_COMPLETED with
# the evidence resume.py was reviewed for). This step replaces the Linux steps and the uninstall. The uninstall is finished by resume.py's
# reviewed Step-FinishUninstall (finish-uninstall.ps1, injected unchanged; continue.py pins its bytes): every live guard of README 4.1 again
# (three services deleted, companion task and old firewall rule deleted, runner stopped as it was, no process or batch, ledger, PAUSED, HALT,
# install receipt and old uninstaller as pinned, no upgrade op, empty spool, ACL, secret targets and carry shape), then only the rename in
# the same directory and the uninstall receipt of the original plan digest. The install preflight, the install and everything after are
# the launcher's own.
#   - the live root is still there, not renamed, with no uninstall receipt (Step-FinishUninstall proves it again right before it renames);
#   - phase B's output as the prior launch saved it, by the same rules again (verify's facts; also Step-FinishUninstall's facts check);
#   - the tokens: the root is not renamed yet, so they are carried from the LIVE root, BEFORE the rename. A token that is not the receipt's
#     stops with the node exactly as the prior launch left it (the same continuation can be generated and run again).
function Step-ContinueInsideUninstall {
  $report = [ordered]@{ mode = 'inside-uninstall'; priorRoot = $ContinuePriorRoot; originalLauncherSha256 = $ContinueOriginalLauncherSha256; priorFiles = [ordered]@{}; state = [ordered]@{}; codes = @() }
  $stop = { param([string]$code) $report.codes = @($code); Write-Json 'continue-report.json' $report; Stop-Launch $code $report }
  if ($ResumePriorRoot -cne $ContinuePriorRoot -or $ResumeOriginalLauncherSha256 -cne $ContinueOriginalLauncherSha256) { & $stop 'CONTINUE_PINS_REFUSED' }
  $prior = Get-ContinuePrior $report $stop
  $report.state['residentRootExists'] = [IO.Directory]::Exists($ResidentRoot)
  $report.state['uninstallReceiptInRoot'] = [IO.File]::Exists((Join-Path $ResidentRoot 'install\uninstall-receipt.json'))
  if (-not $report.state['residentRootExists'] -or $report.state['uninstallReceiptInRoot']) { & $stop 'CONTINUE_ROOT_RENAMED_OR_RECEIPTED_NOT_THIS_STATE' }
  $linux = Set-ContinueLinuxOutput $report $stop $prior['linux-live-manifest.txt'] $prior['linux-version-facts.json']
  $LinuxVersionFactsSource = $linux.factsSource; $LinuxVersionFactsSha256 = $linux.factsSha256   # read by Step-FinishUninstall's facts check
  $carried = Step-CarryTokens
  $finish = Step-FinishUninstall
  Write-ContinueUninstallReport $finish.uninstall.keptAt $finish.uninstall.uninstallReceiptSha256
  Write-Json 'continue-report.json' $report
  $Done.Add('continued-inside-uninstall')
  [ordered]@{ carried = $carried; linux = $linux; parentAcl = $finish.parentAcl; quiesce = $finish.quiesce; uninstall = $finish.uninstall }
}

# The prior launch completed the install; a later step did not pass, or the launch was cut off after it. This step replaces everything up to
# and including the install: nothing of Linux, the uninstall or the install runs again, and no token is carried (the installer placed them).
# $ContinueAfterInstallFrom (continue.py, from the prior progress records and reports) is the first of first-train, verify, pause,
# companion, rearm, companion-headless that did not pass. From there on the launcher's own lines run; each is repeatable (the first-train
# wait, verify, the companion task (it ignores a second instance), rearm, companion-headless) or checked first (the pause:
# Step-ContinuePauseAfterInstall). The steps before it passed in the prior launch and are proven again here, elevated:
#   - the installed root is the prior launch's install (its receipt is the one the prior launch kept);
#   - first-train: the prior report says runnerQuiet; verify: the prior verify printed RESIDENT_VERIFIED;
#   - pause: state\PAUSED.json still names the prior pause request (otherwise CONTINUE_PRIOR_PAUSE_NO_LONGER_IN_FORCE);
#   - companion: Step-StartCompanion again (a no-op while the companion runs), so that what follows has it running;
#   - rearm: its prior report (nothing after it depends on it).
# Starting at or before the pause with the resident service stopped: started again only when the prior launch stopped it itself (its
# not-verified / not-paused path, recorded as pause-not-confirmed-resident-stopped), which is the state the install leaves; otherwise stop.
function Step-ContinueAfterInstall {
  $report = [ordered]@{ mode = 'after-install'; from = $ContinueAfterInstallFrom; priorRoot = $ContinuePriorRoot; originalLauncherSha256 = $ContinueOriginalLauncherSha256; priorFiles = [ordered]@{}; state = [ordered]@{}; codes = @() }
  $stop = { param([string]$code) $report.codes = @($code); Write-Json 'continue-report.json' $report; Stop-Launch $code $report }
  $from = [Array]::IndexOf([string[]]@('first-train', 'verify', 'pause', 'companion', 'rearm', 'companion-headless'), [string]$ContinueAfterInstallFrom)
  if ($from -lt 0) { & $stop 'CONTINUE_PINS_REFUSED' }
  $prior = Get-ContinuePrior $report $stop
  $readPrior = { param([string]$name) try { Parse-Json ($Strict8.GetString($prior[$name])) } catch { $null } }
  $report.state['installReceiptSha256'] = Get-FileSha (Join-Path $ResidentRoot 'install\install-receipt.json')
  if (-not [IO.Directory]::Exists($ResidentRoot) -or ([IO.File]::GetAttributes($ResidentRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $report.state['installReceiptSha256'] -cne (Sha256Bytes $prior['install-receipt.json'])) { & $stop 'CONTINUE_INSTALL_NOT_THE_PRIOR_LAUNCHS' }
  $kept = [ordered]@{ continuedFrom = $ContinuePriorRoot }
  $r = [ordered]@{ install = [ordered]@{ status = 'RESIDENT_INSTALLED'; receiptSha256 = $report.state['installReceiptSha256']; started = $null; continuedFrom = $ContinuePriorRoot }
    parentAcl = $kept; quiesce = $kept; uninstall = $kept; archive = [ordered]@{ directory = $null; moved = 0; receiptSha256 = $null } }
  $r['linux'] = Set-ContinueLinuxOutput $report $stop $prior['linux-live-manifest.txt'] $prior['linux-version-facts.json']   # verify's facts
  if ($from -gt 0) {
    $t = & $readPrior 'first-train-report.json'
    if ((Get-Key $t 'runnerQuiet') -ne $true) { & $stop 'CONTINUE_PRIOR_STEP_DID_NOT_PASS' }
    $t['continuedFrom'] = $ContinuePriorRoot; $r['train'] = $t
  }
  if ($from -gt 1) {
    if ((Get-Key (& $readPrior 'verify.stdout.json') 'status') -cne 'RESIDENT_VERIFIED') { & $stop 'CONTINUE_PRIOR_STEP_DID_NOT_PASS' }
    $r['verify'] = [ordered]@{ exit = $null; status = 'RESIDENT_VERIFIED'; notOk = @(); continuedFrom = $ContinuePriorRoot }
  }
  if ($from -gt 2) {
    $p = & $readPrior 'pause-report.json'; $want = [string](Get-Key $p 'requestSha256')
    if ((Get-Key $p 'confirmed') -ne $true -or (Get-Key $p 'verified') -ne $true -or $want -cnotmatch '^[0-9a-f]{64}$') { & $stop 'CONTINUE_PRIOR_STEP_DID_NOT_PASS' }
    $pausedFile = Join-Path $ResidentRoot 'state\PAUSED.json'
    $report.state['pausedRequestSha256'] = try { if ([IO.File]::Exists($pausedFile)) { [string](Get-Key (Get-Key (Parse-Json ([IO.File]::ReadAllText($pausedFile))) 'source') 'requestSha256') } else { $null } } catch { $null }
    if ($report.state['pausedRequestSha256'] -cne $want) { & $stop 'CONTINUE_PRIOR_PAUSE_NO_LONGER_IN_FORCE' }
    $r['pause'] = [ordered]@{ verified = $true; confirmed = $true; requestSha256 = $want; continuedFrom = $ContinuePriorRoot }
  }
  if ($from -gt 4) {
    $a = & $readPrior 'rearm-report.json'
    if (-not ((Get-Key $a 'notNeeded') -eq $true -or (Get-Key $a 'cleared') -eq $true)) { & $stop 'CONTINUE_PRIOR_STEP_DID_NOT_PASS' }
    $a['continuedFrom'] = $ContinuePriorRoot; $r['rearm'] = $a
  }
  if ($from -le 2) {
    $svc = Get-ScState 'CluedCIResident'; $report.state['residentService'] = $svc
    if ($svc.gone) { & $stop 'CONTINUE_RESIDENT_SERVICE_MISSING' }
    if ($svc.state -eq 1) {
      if (@(([string]$ContinuePriorProgress).Split('|') | Where-Object { $_ -cmatch '^[0-9]{3}-pause-not-confirmed-resident-stopped\.json$' }).Count -ne 1) { & $stop 'CONTINUE_RESIDENT_STOPPED_NOT_BY_THE_PRIOR_LAUNCH' }
      $report.state['residentStart'] = (& $Sc start CluedCIResident | Out-String).Trim()
      $report.state['residentStarted'] = Wait-Until { (Get-ScState 'CluedCIResident').state -eq 4 } 120
      if (-not $report.state['residentStarted']) { & $stop 'CONTINUE_RESIDENT_NOT_STARTED' }
    }
  }
  # this run's own record of the steps the prior launch passed (a later continuation reads this launch directory only)
  Write-New (Join-Path $Out 'install-receipt.json') $prior['install-receipt.json']
  foreach ($name in @('first-train-report.json', 'verify.stdout.json', 'pause-report.json', 'rearm-report.json')) { if ($prior.Contains($name)) { Write-New (Join-Path $Out $name) $prior[$name] } }
  if ($from -gt 0) { $Done.Add($(if ((Get-Key $r.train 'notApplicable') -eq $true) { 'first-train-not-applicable' } elseif ((Get-Key $r.train 'observed') -eq $true -and (Get-Key $r.train 'halted') -ne $true) { 'first-train' } else { 'first-train-not-observed' })) }
  if ($from -gt 1) { $Done.Add('verify') }
  if ($from -gt 2) { $Done.Add('pause') }
  # a first install (the plan's $FleetFirstInstall) goes to the companion switch without starting the interactive task first, as the main flow
  if ($from -gt 3) { $r['companion'] = $(if ($FleetFirstInstall) { [ordered]@{ started = $false; firstInstallSwitch = $true; error = $null } } else { Step-StartCompanion }) }
  if ($from -gt 4) { $Done.Add($(if ((Get-Key $r.rearm 'notNeeded') -eq $true) { 'rearm-not-needed' } else { 'rearm' })) }
  Write-Json 'continue-report.json' $report
  $Done.Add('continued-after-install')
  $r
}
# The pause, checked first. The request this launcher writes has a fixed body (the contract and the pinned reason), so its SHA-256 is
# fixed too: a pause in force that names it is this step already done, and no second request is written. Anything else: the launcher's
# own Step-PauseAfterInstall, unchanged.
function Step-ContinuePauseAfterInstall([bool]$verified) {
  $want = Sha256Bytes ($U8.GetBytes('{"contract":"clued.independent-ci.resident-pause/1","reason":"' + $PauseReason + '"}'))
  $pausedFile = Join-Path $ResidentRoot 'state\PAUSED.json'
  $named = try { if ([IO.File]::Exists($pausedFile)) { [string](Get-Key (Get-Key (Parse-Json ([IO.File]::ReadAllText($pausedFile))) 'source') 'requestSha256') } else { $null } } catch { $null }
  if (-not ($verified -and $named -ceq $want)) { return (Step-PauseAfterInstall $verified) }
  $r = [ordered]@{ verified = $true; request = $null; requestSha256 = $want; confirmed = $true; alreadyInForce = $true; paused = [ordered]@{ sha256 = (Get-FileSha $pausedFile) }; error = $null }
  Write-Json 'pause-report.json' $r
  $Done.Add('pause')
  $r
}

# Linux phase A ran into the launcher's timeout (nothing was killed). Looked at again, elevated, when the continuation runs: A's own stdout
# in the prior run directory (only this elevated side and the account can write there) must now end with A's final status; then
# everything of the launcher runs as it is (the Windows preflight before Linux, the tokens, the file locks), and Step-LinuxRoot runs B
# (B-resume, the output rules) unchanged: only its phase A is the prior one (B itself checks phaseA.sha256 against the staged bytes) and
# its out directory, made by the prior launch, is checked to be the one it made instead of made again. Not finished yet:
# LINUX_PHASE_STILL_RUNNING_RETRY (the same continuation command again later); finished with a refusal: LINUX_PHASE_A_FAILED_AFTER_ITS_TIMEOUT.
function Step-ContinueAfterATimeout {
  # phase A ran in the prior launch: a stop of this run must not lift the W1 pause (the launcher arms it until A is started)
  if (Test-Path -LiteralPath 'variable:W1Restore') { $W1Restore.armed = $false }
  $report = [ordered]@{ mode = 'a-timeout'; priorRoot = $ContinuePriorRoot; originalLauncherSha256 = $ContinueOriginalLauncherSha256; priorFiles = [ordered]@{}; state = [ordered]@{}; codes = @() }
  $stop = { param([string]$code) $report.codes = @($code); Write-Json 'continue-report.json' $report; Stop-Launch $code $report }
  if ((Split-Path -Parent $ContinueLastRunDirectory) -cne (Join-Path $ResidentRoot 'install') -or (Split-Path -Leaf $ContinueLastRunDirectory) -cnotmatch '^linux-run-[0-9a-f]{32}$') { & $stop 'CONTINUE_PINS_REFUSED' }
  $null = Get-ContinuePrior $report $stop
  $script:ContinueCaptureBuild = $null
  try {
    $capture = New-ContinueCapture $report $stop $ContinueLastRunDirectory
    $a = Get-ContinuePriorRunResult $report $stop $ContinueLastRunDirectory 'PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED' 'LINUX_PHASE_A_FAILED_AFTER_ITS_TIMEOUT' $capture 'phaseA'
  } finally { Remove-FleetRegistrar $script:ContinueCaptureBuild }
  Write-New (Join-Path $Out 'linux-A.stdout.txt') ($U8.GetBytes($a.text))
  Write-Json 'continue-report.json' $report
  $Done.Add('continued-a-timeout')
  [ordered]@{ name = 'A'; directory = $ContinueLastRunDirectory; captured = $(if ($capture) { $capture.directory } else { Join-Path $ContinueLastRunDirectory 'captured' }); outcome = 'EXITED'; exit = 0; code = $null; captureRefused = $null; stdout = $a.text; stderrTail = (Tail $a.stderr); registrarStderr = $null; seconds = $null; continuedFrom = $ContinuePriorRoot }
}
# The out directory the prior launch made (Set-FleetLinuxDirectories): there, plain, owned by Administrators with exactly the protected DACL it was given.
function Test-ContinueLinuxOutDirectory {
  if (-not [IO.Directory]::Exists($FleetInDir) -or ([IO.File]::GetAttributes($FleetInDir) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Launch 'LINUX_DIRECTORY_MISSING' $FleetInDir }
  if ((Split-Path -Parent $FleetOutDir) -cne $CarryParent -or (Split-Path -Leaf $FleetOutDir) -cnotmatch '^reinstall-linux-out-[0-9a-f]{32}$') { Stop-Launch 'LINUX_OUT_DIRECTORY_NOT_UNDER_THE_CI_ROOT' $FleetOutDir }
  if (-not [IO.Directory]::Exists($FleetOutDir) -or ([IO.File]::GetAttributes($FleetOutDir) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Launch 'CONTINUE_LINUX_OUT_DIRECTORY_NOT_THE_PRIOR_LAUNCHS' $FleetOutDir }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' + $(if ($FleetCompanionAccount) { '(A;OICI;0x1301bf;;;' + $OwnerSid + ')' } else { '' }))
  $back = [IO.Directory]::GetAccessControl($FleetOutDir)
  if ($back.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or -not $back.AreAccessRulesProtected -or $back.GetSecurityDescriptorSddlForm('Access') -cne $ds.GetSecurityDescriptorSddlForm('Access')) { Stop-Launch 'CONTINUE_LINUX_OUT_DIRECTORY_NOT_THE_PRIOR_LAUNCHS' $back.GetSecurityDescriptorSddlForm('All') }
}
# Step-LinuxRoot as it is, with two functions it calls replaced for this call only (dynamic scope): phase A is the finished prior run, and
# the out directory is checked to be the prior launch's (the protected ACL Set-FleetLinuxDirectories gave it) instead of made again.
function Step-ContinueLinuxRoot($aRun) {
  $invoke = ${function:Invoke-FleetLinuxScript}
  function Invoke-FleetLinuxScript([string]$name, [string]$registrar) { if ($name -ceq 'A') { $aRun } else { & $invoke $name $registrar } }
  function Set-FleetLinuxDirectories { Test-ContinueLinuxOutDirectory }
  Step-LinuxRoot
}
