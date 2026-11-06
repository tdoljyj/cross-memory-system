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

  Residual, unchanged from today: any elevated .NET process of the Owner (including this one and the
  per-batch UAC launch it replaces) inherits the Owner's environment, e.g. COR_ENABLE_PROFILING;
  DESIGN.md §14 R10.
#>
[CmdletBinding()]
param([ValidateSet('Rearm', 'Resume', 'Abort', 'ReleaseBreaker')][string]$Request, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedHaltSha256, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPausedSha256, [ValidateLength(1, 200)][string]$Reason,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$BatchKey, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedLedgerEntrySha256)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
$installed = Get-Content -LiteralPath (Join-Path $Root 'install\install-receipt.json') -Raw | ConvertFrom-Json
if ($installed.residentManifestSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALL_RECEIPT_SHAPE_REFUSED' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

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
