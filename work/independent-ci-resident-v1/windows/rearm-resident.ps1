<#
.SYNOPSIS
  Owner re-arm after an UNKNOWN failure latched HALT, Owner resume after a pause, and Owner abort of the
  current batch (DRAFT). The one remaining UAC of the normal lifecycle besides install, upgrade and uninstall
  (Owner Decision 0d84ddbb item 4).

.DESCRIPTION
  Run the INSTALLED copy, always as:
    powershell.exe -NoProfile -NonInteractive -File C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\rearm-resident.ps1 ...

  Without -Request it only inspects, NOT elevated: it refuses to run elevated, so the node process
  it starts never holds an admin token.

  With -Request Rearm, Resume or Abort (elevated) it starts NO other program: the request is
  written in this script, as exactly one create-only JSON file in the admin-only owner\ directory,
  with its own time and nonce. Nothing else happens: no archive, no ledger write, no rename (review
  X1, M1). The service then proves quiescence on both hosts, archives every failed-unknown scene not
  archived yet (rename only, with its own limited rights) and clears HALT by compare-and-swap; a
  stale digest or missing quiescence is refused and recorded. Failed heads stay burned.

  -Request Abort -BatchKey <key> -ExpectedLedgerEntrySha256 <sha> -Reason <text> (DESIGN 6.5): the key
  and the SHA-256 of that batch's latest ledger record exactly as the inspection (abortTargets) printed
  them. The service honours it only at a safe point: it stops a running scanner-issuer stage through the
  broker and the helper's own stop path, proves quiescence on both hosts, archives the scene rename-only
  and records FAILED_CLEAN OWNER_ABORTED. It never publishes or retracts a check and never kills a
  process; when quiescence cannot be proven the batch HALTs as before and needs a re-arm.

  -Request ReleaseBreaker -Reason <text> (generation 10, DESIGN 53.4): the run queue's circuit breaker is open (inspect shows it under
  `breaker`) and the Owner knows the fault is gone (for example the network is back). The service makes the breaker's trial due now and
  records the request with its reason in the receipts (owner-request, kind breaker-release). It never closes the breaker: one trial
  batch must still get past the place that failed. A breaker that is not open refuses the request (BREAKER_NOT_OPEN), so a late or
  repeated request changes nothing.

  M5 (ADR 0022 section 4.4), the companion's log-on; elevated, the Owner's own account only, one at a time:
    -CompanionHeadless     switch the companion task to the password logon (the reinstall's last step, or to do it again). A read-only
                           preflight first; then an admin-only pending marker (install\companion-headless-pending.json); then
                           the registrar (built for this switch from this generation's pinned CompanionTaskRegistrar.cs with install's
                           recipe, in a new admin-only directory deleted afterwards) shows the Windows credential box on the SECURE
                           desktop (the password goes from there to the Task Scheduler and nowhere else: never into this script); then
                           the task is run and the
                           elevated side checks for up to 8 minutes the real tokens of the supervisor and the companion (not elevated,
                           Administrators deny-only, session 0, the launch file's images), a heartbeat and a Linux fact written since.
                           Passed: the marker goes. Not passed (or cut off: a marker older than 15 minutes is rolled back by the next
                           run of this script or of verify-resident.ps1): back to the interactive token, no password needed,
                           COMPANION_HEADLESS_QUALIFICATION_FAILED with the check that failed.
    -CompanionCredential   the same, after the Owner changed the Windows password (only the stored password changes).
    -CompanionInteractive  back to the interactive token by hand (the stored password is deleted with the old definition).
  M5-b (ADR 0023), the companion as its own non-administrator account (the node profile's ownerSid; the Owner is the install's operator,
  install\companion-account.json); elevated, the operator only; NO password is typed anywhere:
    -CompanionAccount -WslVhdxDirectory <dir>   the reinstall's last step: the same marker, fall-back task and qualification as
                           -CompanionHeadless; in between the resident distribution moves from the Owner's WSL registration to the
                           account's (ext4.vhdx into <dir>, the Owner's registration key removed without deleting the file) and the
                           registrar sets a new random password on the account and registers the task with it (and the one-shot
                           wsl --import-in-place task, run once as the account). Again later: without -WslVhdxDirectory.
    -CompanionCredential   on such a node: only a new random password (the account's and the task's).
    -CompanionRootShell    a root shell in the resident distribution, in a new console, as the account (a new random password first).
    -CompanionWslRestore   back to where the move started (review r1 M4): the task parked, ext4.vhdx back to the recorded source, the
                           Owner's registration key re-imported from its export in install\ when it is gone.
    -CompanionInteractive  parks the task on the account's interactive definition (the companion stops: nobody logs on as it).
  A notification never asks for the password: type it only into the box on the secure desktop, after you started this yourself.

  Residual, unchanged from today: any elevated .NET process of the Owner (including this one and the
  per-batch UAC launch it replaces) inherits the Owner's environment, e.g. COR_ENABLE_PROFILING;
  DESIGN.md §14 R10.
#>
[CmdletBinding()]
param([ValidateSet('Rearm', 'Resume', 'Abort', 'ReleaseBreaker')][string]$Request, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedHaltSha256, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPausedSha256, [ValidateLength(1, 200)][string]$Reason,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$BatchKey, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedLedgerEntrySha256,
  [switch]$CompanionHeadless, [switch]$CompanionCredential, [switch]$CompanionInteractive, [switch]$CompanionAccount, [switch]$CompanionRootShell, [switch]$CompanionWslRestore,
  [ValidatePattern('^[A-Z]:\\[A-Za-z0-9._\\-]+$')][string]$WslVhdxDirectory, [switch]$CompanionWslVmShutdown)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ($CompanionWslVmShutdown -and -not $CompanionAccount) { throw 'WSL_VM_SHUTDOWN_ONLY_WITH_COMPANION_ACCOUNT' }
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
$installed = Get-Content -LiteralPath (Join-Path $Root 'install\install-receipt.json') -Raw | ConvertFrom-Json
if ($installed.residentManifestSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALL_RECEIPT_SHAPE_REFUSED' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# M5: the companion's log-on (ADR 0022 section 4.4). The functions are the installed copy's companion-headless.ps1, next to this one.
$companionModes = @(@($CompanionHeadless, 'headless'), @($CompanionCredential, 'credential'), @($CompanionInteractive, 'interactive'), @($CompanionAccount, 'account'), @($CompanionRootShell, 'root-shell'), @($CompanionWslRestore, 'wsl-restore') | Where-Object { $_[0] })
if ($companionModes.Count -gt 0) {
  if ($companionModes.Count -ne 1 -or $Request) { throw 'ONE_COMPANION_MODE_ONLY' }
  if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
  . (Join-Path $PSScriptRoot 'companion-headless.ps1')
  $node = (Get-Content -LiteralPath (Join-Path $Root 'record\acceptance.json') -Raw | ConvertFrom-Json).node
  if ([string]$node.ownerSid -cnotmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z') { throw 'OWNER_ACCOUNT_REQUIRED' }
  # M5-b (ADR 0023): on a node whose companion runs as its own account the Owner is the install's operator (install\companion-account.json).
  $accountNode = $null -ne (Read-CompanionAccountRecord $Root $node)
  if ($me.User.Value -cne (Get-CompanionOperatorSid $Root $node)) { throw 'OWNER_ACCOUNT_REQUIRED' }
  $mode = $companionModes[0][1]
  if ($WslVhdxDirectory -and $mode -cne 'account') { throw 'WSL_VHDX_DIRECTORY_ONLY_WITH_COMPANION_ACCOUNT' }
  # The Owner's own password (ADR 0022) is not the way on an M5-b node, and the account modes need one.
  if ($accountNode -and $mode -ceq 'headless') { throw 'COMPANION_ACCOUNT_NODE_USE_COMPANION_ACCOUNT' }
  if (-not $accountNode -and @('account', 'root-shell', 'wsl-restore') -ccontains $mode) { throw 'COMPANION_ACCOUNT_NOT_INSTALLED' }
  if ($accountNode -and $mode -ceq 'credential') { $mode = 'account' }   # a new random password; the distribution stays where it is
  $out = if ($mode -ceq 'wsl-restore') {
    $r = Invoke-CompanionWslRestore $Root $node
    [ordered]@{ status = $(if ($r.restored) { 'COMPANION_WSL_RESTORED' } else { 'COMPANION_WSL_NOT_RESTORED' }); result = $r }
  } elseif ($mode -ceq 'root-shell') {
    $code = Invoke-CompanionRootShell $Root
    [ordered]@{ status = $code }
  } elseif ($mode -ceq 'account') {
    $r = Invoke-CompanionAccountSwitch $Root $node $WslVhdxDirectory $(if ($CompanionCredential) { 'credential' } else { 'account' }) -AllowWslVmShutdown:$CompanionWslVmShutdown
    [ordered]@{ status = $(if ($r.qualified) { 'COMPANION_HEADLESS_QUALIFIED' } elseif ($r.failed -ceq 'PREFLIGHT') { 'COMPANION_HEADLESS_PREFLIGHT_REFUSED' } elseif ($r.fellBack) { 'COMPANION_HEADLESS_FELL_BACK' } else { 'COMPANION_HEADLESS_FAILED' }); result = $r }
  } elseif ($mode -ceq 'interactive') {
    $r = Invoke-CompanionStopAndFallback $Root ([string]$node.ownerSid)
    try { Start-CompanionTask } catch { }
    [ordered]@{ status = 'COMPANION_INTERACTIVE'; task = (Get-CompanionTaskFacts $Root ([string]$node.ownerSid)) }
  } else {
    $r = Invoke-CompanionHeadless $Root $node $mode
    [ordered]@{ status = $(if ($r.qualified) { 'COMPANION_HEADLESS_QUALIFIED' } elseif ($r.failed -ceq 'PREFLIGHT') { 'COMPANION_HEADLESS_PREFLIGHT_REFUSED' } elseif ($r.fellBack) { 'COMPANION_HEADLESS_FELL_BACK' } else { 'COMPANION_HEADLESS_FAILED' }); result = $r }
  }
  $out | ConvertTo-Json -Depth 6
  exit $(if (@('COMPANION_HEADLESS_QUALIFIED', 'COMPANION_INTERACTIVE', 'ROOT_SHELL_STARTED', 'COMPANION_WSL_RESTORED') -ccontains $out.status) { 0 } else { 1 })
}

if (-not $Request) {
  if ($elevated) { throw 'INSPECT_RUNS_NOT_ELEVATED' }
  $node = Join-Path $Root 'runtime\node.exe'
  $tool = Join-Path $Root ('resident\' + $installed.residentManifestSha256 + '\tools\rearm-tool.mjs')
  & $node $tool inspect --root $Root
  exit $LASTEXITCODE
}

if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
$hex = -join ((1..8) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$now = [DateTimeOffset]::UtcNow
$body = if ($Request -eq 'Rearm') {
  if (-not $ExpectedHaltSha256 -or -not $Reason) { throw 'REVIEWED_HALT_AND_REASON_REQUIRED' }
  [ordered]@{ by = $me.User.Value; contract = 'clued.independent-ci.resident-owner-rearm/1'; haltSha256 = $ExpectedHaltSha256; nonce = $hex; reason = $Reason; requestedAt = $now.ToString('o') }
} elseif ($Request -eq 'Abort') {
  if (-not $BatchKey -or -not $ExpectedLedgerEntrySha256 -or -not $Reason) { throw 'REVIEWED_BATCH_LEDGER_ENTRY_AND_REASON_REQUIRED' }
  # ValidatePattern ignores case; the service accepts lower-case hex only.
  if ($BatchKey -cnotmatch '^[0-9a-f]{64}$' -or $ExpectedLedgerEntrySha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'LOWER_CASE_HEX_REQUIRED' }
  [ordered]@{ batchKey = $BatchKey; by = $me.User.Value; contract = 'clued.independent-ci.resident-owner-abort/1'; ledgerEntrySha256 = $ExpectedLedgerEntrySha256; nonce = $hex; reason = $Reason; requestedAt = $now.ToString('o') }
} elseif ($Request -eq 'ReleaseBreaker') {
  if (-not $Reason) { throw 'BREAKER_RELEASE_REASON_REQUIRED' }
  [ordered]@{ by = $me.User.Value; contract = 'clued.independent-ci.resident-owner-breaker-release/1'; nonce = $hex; reason = $Reason; requestedAt = $now.ToString('o') }
} else {
  if (-not $ExpectedPausedSha256) { throw 'REVIEWED_PAUSE_REQUIRED' }
  [ordered]@{ by = $me.User.Value; contract = 'clued.independent-ci.resident-owner-resume/1'; nonce = $hex; pausedSha256 = $ExpectedPausedSha256; requestedAt = $now.ToString('o') }
}
$name = $now.ToUnixTimeMilliseconds().ToString().PadLeft(13, '0') + '-' + $hex.Substring(0, 12) + '.json'
$file = Join-Path (Join-Path $Root 'owner') $name
$bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($body | ConvertTo-Json -Compress))
$f = [IO.File]::Open($file, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
[ordered]@{ status = ($Request.ToUpperInvariant() + '_REQUESTED_SERVICE_WILL_VERIFY'); file = $file } | ConvertTo-Json -Compress
