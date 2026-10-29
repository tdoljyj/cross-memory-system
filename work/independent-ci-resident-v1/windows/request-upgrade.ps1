<#
.SYNOPSIS
  The Owner's request for an in-place upgrade of this node's resident (018da927 B2, A3; DRAFT). Not elevated.

.DESCRIPTION
  Run in the Owner's own session (no UAC). It writes nothing but ONE request file, created new in the upgrade inbox
  C:\ProgramData\CluedIndependentCI\resident\upgrade\inbox\<13-digit ms>-<12 hex>.json (create-only for the Owner, A6), and prints where
  the upgrader's status is (upgrade\status.json). The upgrader then asks the Grant door; the Owner approves once on the page whose
  link status.json shows (confirmUrl). Nothing is installed by this script.

  Upgrade: the package directory is checked here before anything is written, as the upgrader will check it again: package-manifest.json is
  read once and its SHA-256 must equal -ExpectedPackageManifestSha256; every file it lists is read and hashed again here (no "..", no rooted
  path); the package's node (record\acceptance.json) must be the installed node; its acceptance must be -AcceptanceDecisionRef.
    request-upgrade.ps1 -PackageRoot <dir> -ExpectedPackageManifestSha256 <hex> -AcceptanceDecisionRef <uuid> [-DrainMaxMinutes 10..120] [-Note <text>]
  Cancel (only before the upgrader stages anything):
    request-upgrade.ps1 -Cancel -RequestId <uuid>
#>
[CmdletBinding(DefaultParameterSetName = 'Upgrade')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Upgrade')][string]$PackageRoot,
  [Parameter(Mandatory, ParameterSetName = 'Upgrade')][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPackageManifestSha256,
  [Parameter(Mandatory, ParameterSetName = 'Upgrade')][ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$AcceptanceDecisionRef,
  [Parameter(ParameterSetName = 'Upgrade')][ValidateRange(10, 120)][int]$DrainMaxMinutes = 120,
  [Parameter(ParameterSetName = 'Upgrade')][ValidateLength(0, 500)][string]$Note = '',
  [Parameter(Mandatory, ParameterSetName = 'Cancel')][switch]$Cancel,
  [Parameter(Mandatory, ParameterSetName = 'Cancel')][ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$RequestId
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$RequestContract = 'clued.independent-ci.resident-upgrade-request/1'
$CancelContract = 'clued.independent-ci.resident-upgrade-cancel/1'
$MaxRequestBytes = 2048

function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Get-Field($o, [string]$k) { if (($o -is [pscustomobject]) -and (@($o.PSObject.Properties.Name) -ccontains $k)) { $o.$k } else { $null } }
# A3 packageDirectory: a local absolute path (drive letter), no UNC or device path, no "." or ".." segment, at most 260 characters.
function Test-PackageDirectory([string]$path) {
  if ([string]::IsNullOrEmpty($path) -or $path.Length -gt 260 -or $path -cnotmatch '^[A-Za-z]:\\' -or $path.Contains('/') -or $path.Contains('"')) { return $false }
  @($path.Substring(3).Split('\') | Where-Object { $_ -ceq '.' -or $_ -ceq '..' }).Count -eq 0
}
# R/src/inbox.mjs NAME: 13 digits of milliseconds, a dash, 12 hex.
function Get-InboxName([long]$ms, [string]$hex) {
  if ($ms -lt 1000000000000 -or $ms -gt 9999999999999 -or $hex -cnotmatch '^[0-9a-f]{12}\z') { throw 'INBOX_NAME_REFUSED' }
  ('{0:D13}-{1}.json' -f $ms, $hex)
}
function New-Hex([int]$bytes) { $b = New-Object byte[] $bytes; $r = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $r.GetBytes($b) } finally { $r.Dispose() }; ([BitConverter]::ToString($b)).Replace('-', '').ToLowerInvariant() }
function Get-Now { [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture) }
# The request bytes (A3), keys in the contract's order, UTF-8 without BOM, at most 2 KiB.
function New-UpgradeRequestBytes([string]$requestId, [string]$node, [string]$packageSha, [string]$packageDirectory, [string]$decisionRef, [int]$drainMaxMinutes, [string]$note, [string]$requestedAt, [string]$nonce) {
  if ($drainMaxMinutes -lt 10 -or $drainMaxMinutes -gt 120 -or $note.Length -gt 500 -or $nonce -cnotmatch '^[0-9a-f]{16,32}\z' -or -not (Test-PackageDirectory $packageDirectory)) { throw 'UPGRADE_REQUEST_REFUSED' }
  $body = [ordered]@{ contract = $RequestContract; requestId = $requestId; node = $node; packageManifestSha256 = $packageSha; packageDirectory = $packageDirectory
    acceptanceDecisionRef = $decisionRef; drainMaxMinutes = $drainMaxMinutes; note = $note; requestedAt = $requestedAt; nonce = $nonce }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($body | ConvertTo-Json -Compress))
  if ($bytes.Length -gt $MaxRequestBytes) { throw 'UPGRADE_REQUEST_TOO_LARGE' }
  ,$bytes
}
function New-CancelRequestBytes([string]$requestId, [string]$requestedAt, [string]$nonce) {
  $body = [ordered]@{ contract = $CancelContract; requestId = $requestId; requestedAt = $requestedAt; nonce = $nonce }
  ,((New-Object Text.UTF8Encoding($false)).GetBytes(($body | ConvertTo-Json -Compress)))
}
# One file, created new and written in one go (the inbox is create-only for the Owner: no temporary name, no rename).
function Write-InboxFile([string]$inbox, [byte[]]$bytes) {
  for ($try = 0; $try -lt 5; $try++) {
    $name = Get-InboxName ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) (New-Hex 6)
    $path = Join-Path $inbox $name
    try { $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None') } catch [IO.IOException] { continue }
    try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
    return $path
  }
  throw 'INBOX_NAME_COLLISION'
}
function Read-Once([string]$path, [long]$maximum) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $item.Length -gt $maximum) { throw ('PACKAGE_FILE_REFUSED:' + $path) }
  ,([IO.File]::ReadAllBytes($path))
}
# The installed node (record\acceptance.json, readable by the Owner) and this account must be its Owner.
function Get-InstalledNode {
  $accepted = (New-Object Text.UTF8Encoding($false, $true)).GetString([IO.File]::ReadAllBytes((Join-Path $Root 'record\acceptance.json'))) | ConvertFrom-Json
  $node = Get-Field $accepted 'node'
  if ([string](Get-Field $node 'nodeName') -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z') { throw 'INSTALLED_NODE_UNREADABLE' }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne [string](Get-Field $node 'ownerSid')) { throw 'OWNER_ACCOUNT_REQUIRED' }
  $node
}

$installedNode = Get-InstalledNode
$inbox = Join-Path $Root 'upgrade\inbox'
if (-not (Test-Path -LiteralPath $inbox -PathType Container)) { throw 'UPGRADE_CHANNEL_NOT_INSTALLED' }
if ($Cancel) {
  $file = Write-InboxFile $inbox (New-CancelRequestBytes $RequestId (Get-Now) (New-Hex 16))
  [ordered]@{ status = 'UPGRADE_CANCEL_REQUESTED'; requestId = $RequestId; requestFile = $file; statusFile = (Join-Path $Root 'upgrade\status.json')
    note = 'A cancel is honoured only before the upgrader stages the package; status.json says what happened.' } | ConvertTo-Json
  exit 0
}

$dir = try { [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\') } catch { throw 'PACKAGE_DIRECTORY_REFUSED' }
if (-not (Test-PackageDirectory $dir) -or -not (Test-Path -LiteralPath $dir -PathType Container) -or (((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'PACKAGE_DIRECTORY_REFUSED' }
$manifestBytes = Read-Once (Join-Path $dir 'package-manifest.json') 16MB   # read ONCE: hashed and parsed from the same bytes
if ((Sha256Bytes $manifestBytes) -cne $ExpectedPackageManifestSha256) { throw 'PACKAGE_CHANGED' }
$pkg = (New-Object Text.UTF8Encoding($false, $true)).GetString($manifestBytes) | ConvertFrom-Json
if ((Get-Field $pkg 'contract') -cne 'clued.independent-ci.resident-package/4') { throw 'PACKAGE_CONTRACT_REFUSED' }
# Every listed file again, here: a package that does not hash is never requested.
$count = 0; $total = [long]0; $acceptanceBytes = $null
foreach ($f in @(Get-Field $pkg 'files')) {
  $rel = [string](Get-Field $f 'path')
  if ([string]::IsNullOrEmpty($rel) -or [IO.Path]::IsPathRooted($rel) -or $rel -match '(^|[\\/])\.\.?([\\/]|$)' -or $rel.Contains(':')) { throw ('PACKAGE_SOURCE_PATH_REFUSED:' + $rel) }
  $bytes = Read-Once (Join-Path $dir $rel) 512MB
  if ((Sha256Bytes $bytes) -cne [string](Get-Field $f 'sha256')) { throw ('PACKAGE_FILE_CHANGED:' + $rel) }
  if ((Get-Field $f 'target') -ceq 'record\acceptance.json') { $acceptanceBytes = $bytes }
  $count++; $total += $bytes.Length
}
if ($null -eq $acceptanceBytes) { throw 'PACKAGE_NODE_PROFILE_REQUIRED' }
$packageNode = Get-Field ((New-Object Text.UTF8Encoding($false, $true)).GetString($acceptanceBytes) | ConvertFrom-Json) 'node'
if ([string](Get-Field $packageNode 'nodeName') -cne [string]$installedNode.nodeName) { throw 'NODE_MISMATCH' }
if ([string](Get-Field (Get-Field $pkg 'acceptance') 'decisionRef') -cne $AcceptanceDecisionRef) { throw 'PACKAGE_ACCEPTANCE_MISMATCH' }

$requestId = [guid]::NewGuid().ToString()
$file = Write-InboxFile $inbox (New-UpgradeRequestBytes $requestId $installedNode.nodeName $ExpectedPackageManifestSha256 $dir $AcceptanceDecisionRef $DrainMaxMinutes $Note (Get-Now) (New-Hex 16))
[ordered]@{ status = 'UPGRADE_REQUESTED'; requestId = $requestId; node = $installedNode.nodeName; packageManifestSha256 = $ExpectedPackageManifestSha256; files = $count; bytes = $total
  requestFile = $file; statusFile = (Join-Path $Root 'upgrade\status.json')
  ownerNextStep = 'Watch statusFile: at WAITING_GRANT it shows op.grant.confirmUrl; approve once there. Cancel before staging: request-upgrade.ps1 -Cancel -RequestId ' + $requestId } | ConvertTo-Json
