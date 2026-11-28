<#
.SYNOPSIS
  The one node entry of the universal node package (Release asset fleet-node-<v>.bootstrap.ps1): first install, reinstall, the same
  command on every node, no node argument.

    powershell -NoProfile -ExecutionPolicy Bypass -File <dir>\fleet-node-<v>.bootstrap.ps1 -From <dir> [-Reset]

.DESCRIPTION
  Run by the Owner in a NORMAL (not elevated) window, with the system's own Windows PowerShell 5.1. <dir> holds one version's Release
  assets (a USB stick, a share, a synced folder: only the hashes count); its path, like every path this script hands to an elevated
  process, is letters, digits, '.', '_', '-' and '\' only (a path with a blank or any other character is refused, never quoted):
    fleet-node-<v>.tar, fleet-node-<v>.release.json, SHA256SUMS, fleet-node-<v>.bootstrap.ps1, fleet-node-<v>.prereq-manifest.json,
    fleet-node-<v>.acceptance.json (the Owner's acceptance; install.mjs validates it as a whole)
    and, for a first install, fleet-node-<v>.first-install-kit.json, role-image-<64hex>.tar.gz (each local role image the kit names)
    and fleet-node-<v>.first-install.SHA256SUMS (over those two kinds; uploaded by publish.mjs prepare).
  Every file in <dir> must be listed in exactly one of the two sums files with its hash (the acceptance, the two sums files and the
  prerequisite files the manifest names excepted); a listed file that is missing, an unlisted file, or a hash that differs refuses.

  Steps, each judged by the last JSON object of what it ran:
    1. the asset set and every hash (Test-AssetSet, Read-Sha256Sums);
    2. the prerequisite manifest (Test-PrereqManifest): every item this run uses pinned (PREREQ_NOT_PINNED otherwise: nothing is fetched
       unpinned). A node with a resident (the reinstall) uses node, python and git only; a first install all seven and the .debs
       (Get-NeededPrereqs). Each file from <dir> when it is there with its pinned hash, else downloaded with bounded retries and
       Range resume where supported, then held to sha256 and size;
       node, python and git expanded once into C:\ProgramData\CluedBootstrap\tools\<name>-<sha256-first-16> (complete only with its full-sha256 marker; a
       cut-off expansion is set aside and done again: Get-ExtractState);
    3. the archive's tree/ (Windows' own tar.exe, which cannot write a name outside ASCII: the package builder refuses such a path,
       universal.mjs UNIVERSAL_TREE_PATH_NOT_ASCII; install.mjs checks its own bytes against the archive, so the tool is not trusted);
    4. a node with C:\ProgramData\CluedIndependentCI\resident\install\install-receipt.json: install.mjs prepare, then the launcher;
       a node without it (a first install):
         a. install.mjs first-install-check, NOT elevated: the acceptance, the archive's and the kit's sha256 held to it, the kit read
            whole, every role image asset there; its output (kit sha256, toolchain node sha256, the registrar's pin in the archive's
            resident manifest, the images) is all the host preparation is given (M2, L2); the toolchain's node.exe must be the kit's
            controller runtime (Test-FirstInstallCheck: CONTROLLER_NODE_NOT_THE_FLEETS before any UAC);
         b. one elevated stage copies the checked assets and pinned tools to an admin-only directory, verifies them again, and
            runs host preparation, package preparation and the launcher under the same operator and install lock. The token
            staging directory is cleaned in that stage before host preparation and after its final verdict.
       The legacy reinstall launcher is elevated separately from its non-elevated preparation.
  An elevated stage reads child stdout and stderr separately so it can retain the final verdict.
  -Reset (a first install only, no resident on the host): the install stage runs first-install-host.ps1 -Reset, which removes what this
  host preparation made and nothing else.
  A declined UAC prompt is UAC_DECLINED (nothing elevated ran); an elevated run that has not ended within its limit is
  ELEVATED_RUN_STILL_RUNNING (nothing is killed). A stage's terminating exception is kept in its result with its message (L4) and its
  temporary copies are removed in every case. The last line printed is one JSON object: {status, step, code?, detail?, workDir}.
#>
param([string]$From, [ValidateSet('', 'install')][string]$Stage = '', [string]$Result, [string]$Tar, [string]$ArchiveSha256,
  [string]$PrereqDirectory, [string]$PrereqManifest, [string]$PrereqManifestSha256, [string]$KitSha256, [string]$ToolchainNodeSha256, [string]$RegistrarSha256,
  [string]$ExpectedOperatorSid, [string]$Kit,
  [ValidateSet('Install','Retire','Rollback')][string]$Action = 'Install',
  [ValidateSet('Fresh','Probe','Reinstall','Retire','Rollback')][string]$LifecycleMode = 'Probe',
  [string]$PreviewReceipt, [switch]$ZeroNodeConsent,
  [string]$AcceptanceFile, [string]$AcceptanceSha256, [string]$FirstInstallSums, [string]$FirstInstallSumsSha256, [switch]$Reset,
  [ValidatePattern('^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')][string]$ReinstallOperation)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions   # JavaScriptSerializer (Windows PowerShell 5.1 does not load it by itself)
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$CredentialDirectory = 'C:\ProgramData\CluedIndependentCI\first-install\credentials'
$WorkParent = 'C:\ProgramData\CluedBootstrap'
$PowerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$TarExe = 'C:\Windows\System32\tar.exe'
$Resident = 'tree/work/independent-ci-resident-v1'
$PrereqContract = 'clued.independent-ci.fleet-node-prereq-manifest/1'
$PrereqNames = @('node', 'python', 'git', 'ubuntu-rootfs', 'actions-runner', 'linux-node', 'wsl', 'gh', 'git-for-windows')
$AdminOnlySddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$HostLimitSeconds = 4 * 3600      # P1: Windows features, WSL, accounts, the distribution, docker in it
$LauncherLimitSeconds = 6 * 3600  # Linux A (1800 s) + B (7200 s) + first-train wait + verify, with margin

# ------------------------------------------------------------------ pure functions (test/test-bootstrap.ps1 runs them)
# A key of a parsed JSON object, or $null when it is not one (Dictionary's indexer throws on a missing key).
function Get-Key($d, [string]$k) { if ($d -is [Collections.IDictionary] -and ([Collections.IDictionary]$d).Contains($k)) { $d[$k] } else { $null } }
# A sums file: "<64 lower hex>  <name>" per line (LF or CRLF), a plain file name only (no path, no duplicate). An ordered map
# name -> hash; throws BOOTSTRAP_SUMS_REFUSED:<line> on anything else.
function Read-Sha256Sums([string]$text) {
  $map = [ordered]@{}
  foreach ($line in @($text -split "`r?`n")) {
    if ($line -ceq '') { continue }
    if ($line -cnotmatch '^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+~-]{0,200})$') { throw ('BOOTSTRAP_SUMS_REFUSED:' + $line) }
    if ($map.Contains($Matches[2])) { throw ('BOOTSTRAP_SUMS_DUPLICATE:' + $Matches[2]) }
    $map[$Matches[2]] = $Matches[1]
  }
  $map
}
# The version from the one fleet-node-<v>.tar among the names; throws when there is not exactly one.
function Get-ReleaseVersion([string[]]$names) {
  $v = @($names | Where-Object { $_ -cmatch '^fleet-node-([A-Za-z0-9][A-Za-z0-9._+-]{0,88})\.tar$' } | ForEach-Object { $_.Substring(11, $_.Length - 15) })
  if ($v.Count -ne 1) { throw ('BOOTSTRAP_NOT_ONE_ARCHIVE:' + $v.Count) }
  $v[0]
}
# What must be there for a version: the release's own assets always, the first-install assets for a first install.
function Get-RequiredAssets([string]$version, [bool]$firstInstall) {
  $t = 'fleet-node-' + $version
  $r = @("$t.tar", "$t.release.json", 'SHA256SUMS', "$t.bootstrap.ps1", "$t.prereq-manifest.json", "$t.acceptance.json")
  if ($firstInstall) { $r += @("$t.first-install-kit.json", "$t.first-install.SHA256SUMS") }
  , $r
}
# The asset set: every present file listed (in one sums file), every listed file present, every required one there. $prereqFiles:
# the prerequisite file names the manifest allows to lie in the directory (checked by their own pins later). Returns the codes.
function Test-AssetSet([string[]]$present, $sums, $firstSums, [string]$version, [bool]$firstInstall, [string[]]$prereqFiles) {
  $codes = @()
  $t = 'fleet-node-' + $version
  $free = @('SHA256SUMS', "$t.acceptance.json", "$t.first-install.SHA256SUMS") + @($prereqFiles)
  $listed = @{}
  foreach ($k in @($sums.Keys)) { $listed[$k] = 'release' }
  if ($null -ne $firstSums) { foreach ($k in @($firstSums.Keys)) { if ($listed.ContainsKey($k)) { $codes += ('ASSET_IN_BOTH_SUMS:' + $k) } else { $listed[$k] = 'first-install' } } }
  foreach ($n in @($present)) { if (-not $listed.ContainsKey($n) -and $free -cnotcontains $n) { $codes += ('ASSET_NOT_LISTED:' + $n) } }
  foreach ($n in @($listed.Keys)) { if (@($present) -cnotcontains $n) { $codes += ('ASSET_LISTED_NOT_PRESENT:' + $n) } }
  foreach ($n in (Get-RequiredAssets $version $firstInstall)) { if (@($present) -cnotcontains $n) { $codes += ('ASSET_REQUIRED_MISSING:' + $n) } }
  if ($null -ne $firstSums) { foreach ($k in @($firstSums.Keys)) { if ($k -cne "$t.first-install-kit.json" -and $k -cnotmatch '^role-image-[0-9a-f]{64}\.tar\.gz$') { $codes += ('FIRST_INSTALL_SUMS_NAMES_OTHER:' + $k) } } }
  foreach ($k in @($sums.Keys)) { if ($k -cmatch '^role-image-' -or $k -ceq "$t.first-install-kit.json") { $codes += ('RELEASE_SUMS_NAMES_FIRST_INSTALL_ASSET:' + $k) } }
  , @($codes | Sort-Object -Unique)
}
# The prerequisite manifest: exactly the seven items, each pinned (sha256 and bytes), an https URL, a plain file name, a known kind;
# the WSL package with its exact version; the docker closure as .deb files, each pinned (the drill VM's set, installed by dpkg from
# these files only: no apt resolution anywhere). Returns the codes; PREREQ_NOT_PINNED:<name> for what a coordinator has not pinned yet.
#   M6: $needed are the items this run fetches (Get-NeededPrereqs): only those must be pinned; the .debs only when $debsNeeded (a first
#   install). Every item's shape is checked whatever the run.
function Test-PrereqManifest($m, [string[]]$needed = $PrereqNames, [bool]$debsNeeded = $true) {
  $codes = @()
  if ((Get-Key $m 'contract') -cne $PrereqContract -or $null -eq (Get-Key $m 'items')) { return , @('PREREQ_MANIFEST_SHAPE') }
  $names = @()
  foreach ($i in @($m['items'])) {
    if ($i -isnot [Collections.IDictionary]) { $codes += 'PREREQ_ITEM_SHAPE'; continue }
    $name = [string](Get-Key $i 'name'); $names += $name
    if ($PrereqNames -cnotcontains $name) { $codes += ('PREREQ_UNKNOWN_ITEM:' + $name) }
    $b = Get-Key $i 'bytes'
    $pinned = ([string](Get-Key $i 'sha256') -cmatch '^[0-9a-f]{64}$') -and ($b -is [int] -or $b -is [long]) -and [long]$b -gt 0
    if (-not $pinned -and @($needed) -ccontains $name) { $codes += ('PREREQ_NOT_PINNED:' + $name) }
    # (an item not pinned yet may not name its URL either: the coordinator names both)
    if (($pinned -or $null -ne (Get-Key $i 'url')) -and [string](Get-Key $i 'url') -cnotmatch '^https://[A-Za-z0-9.-]+/[^\s"''`]+$') { $codes += ('PREREQ_URL:' + $name) }
    if ([string](Get-Key $i 'fileName') -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$') { $codes += ('PREREQ_FILE_NAME:' + $name) }
    if (@('zip', 'exe', 'msi', 'wsl', 'tar.gz', 'tar.xz') -cnotcontains [string](Get-Key $i 'kind')) { $codes += ('PREREQ_KIND:' + $name) }
    if ((Get-Key $i 'kind') -ceq 'zip') {
      $max = Get-Key $i 'maxEntryPathLength'
      if (-not (($max -is [int] -or $max -is [long]) -and $max -gt 0 -and $max -le [int]::MaxValue)) { $codes += ('PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:' + $name) }
    }
    if ($name -ceq 'wsl' -and [string](Get-Key $i 'version') -cnotmatch '^\d+\.\d+\.\d+\.\d+$') { $codes += 'PREREQ_WSL_VERSION' }
  }
  foreach ($n in $PrereqNames) { if (@($names | Where-Object { $_ -ceq $n }).Count -ne 1) { $codes += ('PREREQ_ITEM_NOT_ONCE:' + $n) } }
  if (-not $debsNeeded) { return , @($codes) }
  $debs = @(Get-Key $m 'debs' | Where-Object { $null -ne $_ })
  if ($debs.Count -lt 1) { $codes += 'PREREQ_DEBS_SHAPE' }
  foreach ($d in $debs) {
    $pkg = [string](Get-Key $d 'package')
    if ($pkg -cnotmatch '^[a-z0-9][a-z0-9.+-]{0,100}$' -or [string](Get-Key $d 'version') -cnotmatch '^[A-Za-z0-9.+:~-]{1,100}$') { $codes += ('PREREQ_DEB_SHAPE:' + $pkg); continue }
    if ([string](Get-Key $d 'fileName') -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}\.deb$') { $codes += ('PREREQ_DEB_FILE_NAME:' + $pkg) }
    if ([string](Get-Key $d 'url') -cnotmatch '^https?://[A-Za-z0-9.-]+/[^\s"''`]+\.deb$') { $codes += ('PREREQ_DEB_URL:' + $pkg) }   # by its sha256: the archive serves http
    $b = Get-Key $d 'bytes'
    if ([string](Get-Key $d 'sha256') -cnotmatch '^[0-9a-f]{64}$' -or -not (($b -is [int] -or $b -is [long]) -and [long]$b -gt 0)) { $codes += ('PREREQ_NOT_PINNED:deb:' + $pkg) }
  }
  , @($codes)
}
# The last JSON object a child printed: its last line when that parses, else the text from the last line that begins with '{' (the
# launcher prints its terminal as an indented object). $null when there is none.
function Get-LastJsonLine([string]$text) {
  if ($null -eq $text) { return $null }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 16777216
  $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { return $null }
  $o = $null
  try { $o = $js.DeserializeObject($lines[$lines.Count - 1]) } catch { $o = $null }
  if ($o -isnot [Collections.IDictionary]) {
    $at = -1; for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -ceq '{') { $at = $i; break } }
    if ($at -ge 0) { try { $o = $js.DeserializeObject((@($lines[$at..($lines.Count - 1)]) -join "`n")) } catch { $o = $null } }
  }
  if ($o -is [Collections.IDictionary]) { $o } else { $null }
}
# M3: a path handed on is a drive path of letters, digits, '.', '_', '-' only (no blank, no quote, no '..', no trailing '\').
function Test-SafePath([string]$p) { $p -cmatch '^[A-Za-z]:(?:\\[A-Za-z0-9_-][A-Za-z0-9._-]*)+$' -and ($p.Split('\') -cnotcontains '..') }
# M3: any other argument value: a word of letters, digits, '.', '_', '-', ':' or '\'; one with ':' or '\' must be a safe path.
function Test-SafeArgument([string]$v) {
  if ($v -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:\\-]{0,500}$') { return $false }
  if ($v.Contains('\') -or $v.Contains(':')) { return (Test-SafePath $v) }
  $true
}
# M3: the elevated command line: -File <this script> and named arguments one by one (pairs), every value inside the whitelist. No value
# is ever part of code text; Start-Process joins them with blanks and none can hold one.
function Get-ElevatedArguments([string]$scriptFile, [string[]]$named, [string[]]$switches = @()) {
  if (-not (Test-SafePath $scriptFile)) { throw ('BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:' + $scriptFile) }
  $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $scriptFile)
  if (@($named).Count % 2) { throw 'BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:pairs' }
  for ($i = 0; $i -lt @($named).Count; $i += 2) {
    if ($named[$i] -cnotmatch '^-[A-Z][A-Za-z0-9]{1,40}$') { throw ('BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:' + $named[$i]) }
    if (-not (Test-SafeArgument $named[$i + 1])) { throw ('BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:' + $named[$i + 1]) }
    $a += @($named[$i], $named[$i + 1])
  }
  foreach ($s in @($switches)) { if ($s -cnotmatch '^-[A-Z][A-Za-z0-9]{1,40}$') { throw ('BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:' + $s) }; $a += $s }
  , $a
}
# True when an exception is the UAC prompt declined (ERROR_CANCELLED 1223), however PowerShell wrapped it.
function Test-UacDeclined($err) {
  $e = $err
  while ($null -ne $e) { if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { return $true }; $e = $e.InnerException }
  $false
}
# L1: an expansion is complete only when its marker holds the sha256 of what was expanded.
function Get-ExtractState([string]$dir, [string]$sourceSha256) {
  if (-not [IO.Directory]::Exists($dir)) { return 'absent' }
  $marker = Join-Path $dir '.bootstrap-complete'
  if ([IO.File]::Exists($marker) -and ([IO.File]::ReadAllText($marker)).Trim() -ceq $sourceSha256) { 'complete' } else { 'incomplete' }
}
# L4: a stage's terminating exception, kept with its message and type.
function Get-StageFailure([string]$stage, $exception) {
  $message = [string]$exception.Message
  $code = if ($message -cmatch '^([A-Z][A-Z0-9_]+)(?::|$)') { $Matches[1] } else { 'BOOTSTRAP_STAGE_FAILED' }
  [ordered]@{ status = 'BOOTSTRAP_STAGE_FAILED'; stage = $stage; code = $code; message = $message; type = $exception.GetType().FullName }
}
# M4: the elevated stage runs as the operator who started the bootstrap, or not at all (a UAC prompt answered with another account).
function Test-StageOperator([string]$actualSid, [string]$expectedSid) {
  if ($expectedSid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { return 'EXPECTED_OPERATOR_SID_REQUIRED' }
  if ($actualSid -cne $expectedSid) { return 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR' }
  $null
}

function Assert-FleetDeliveryTrust([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  $acl = Get-Acl -LiteralPath $path
  $manager = @('S-1-5-18','S-1-5-32-544')
  $sid = [Security.Principal.SecurityIdentifier]
  # Include generic rights in addition to the concrete write and delete rights.
  $mutation = 0x500d0156
  $unsafe = @($acl.GetAccessRules($true, $true, $sid) | Where-Object {
    $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -cnotin $manager -and
      ([int]$_.FileSystemRights -band $mutation)
  })
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $acl.GetOwner($sid).Value -cnotin $manager -or $unsafe.Count) { throw 'FLEET_REINSTALL_ROOT_REFUSED' }
}
# H2: the token directory removed: what was there and whether it is gone.
function Clear-CredentialDirectory([string]$dir) {
  $existed = [IO.Directory]::Exists($dir); $cleared = $true
  if ($existed) { try { [IO.Directory]::Delete($dir, $true) } catch { $cleared = $false } }
  [ordered]@{ existed = $existed; cleared = ($cleared -and -not [IO.Directory]::Exists($dir)) }
}
# M2: install.mjs first-install-check's answer held to what this run checked itself, before the first UAC: its status, the archive, the
# kit the first-install sums list, the shape of every pin it hands on, and the toolchain's node.exe = the fleet's controller runtime
# (prepare refuses another one: FIRST_INSTALL_CONTROLLER_NODE_NOT_THE_FLEETS, but only after the host preparation changed the machine).
function Test-FirstInstallCheck($chk, [string]$archiveSha, [string]$kitSha, [string]$nodeSha) {
  $codes = @()
  if ([string](Get-Key $chk 'status') -cne 'FIRST_INSTALL_INPUTS_ACCEPTED') { $codes += 'STATUS' }
  if ([string](Get-Key $chk 'archiveSha256') -cne $archiveSha) { $codes += 'ARCHIVE_NOT_THE_CHECKED' }
  if (-not $kitSha -or [string](Get-Key $chk 'kitSha256') -cne $kitSha) { $codes += 'KIT_NOT_THE_LISTED' }
  foreach ($k in @('kitSha256', 'toolchainNodeSha256', 'controllerNodeSha256', 'registrarSha256')) { if ([string](Get-Key $chk $k) -cnotmatch '^[0-9a-f]{64}$') { $codes += ('PIN_SHAPE:' + $k) } }
  if ([string](Get-Key $chk 'controllerNodeSha256') -cne $nodeSha) { $codes += 'CONTROLLER_NODE_NOT_THE_FLEETS' }
  , @($codes)
}
# M3: a file the elevated stage reads, copied into the work directory (a local disk) and held to its hash: an elevated token does not see
# the drive letters the Owner mapped (no EnableLinkedConnections), so nothing elevated reads -From.
function Copy-ToWork([string]$source, [string]$dir, [string]$sha256) {
  if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
  $to = Join-Path $dir ([IO.Path]::GetFileName($source))
  [IO.File]::Copy($source, $to, $false)
  if ((Sha256File $to) -cne $sha256) { [IO.File]::Delete($to); throw ('LOCAL_COPY_NOT_THE_PINNED:' + [IO.Path]::GetFileName($source)) }
  $to
}
function Test-UnderDirectory([string]$path, [string]$dir) {
  $d = [IO.Path]::GetFullPath($dir).TrimEnd('\') + '\'
  [IO.Path]::GetFullPath($path).StartsWith($d, [StringComparison]::OrdinalIgnoreCase)
}
# M4: the run's verdict from the launcher's terminal. A first install is done only when the node confirmed its role (below) and the M5-b
# switch moved the distribution to the companion account (companion-headless COMPANION_HEADLESS_QUALIFIED): until then it is the operator's
# (wsl-first-install), which the profile's ownerSid (the companion) does not match. A reinstall's verdict is as before.
# Order: a launcher that did not end verified and paused; then the role (a refused or unconfirmed role is the root cause, so it is the
# verdict even when the switch did not pass too, PLAN-launcher-role-review-m1m2-20261124 2); then the switch. Every verdict keeps the
# switch's status in companionSwitch.
# code (Fable ruling 11-20 "first install r4" section 5(a), E5): why the launcher did not end done, as the launcher said it -- a terminal
# that stopped gives its own code, a role not confirmed FIRST_INSTALL_ROLE_UNAUTHORIZED or FIRST_INSTALL_ROLE_UNCONFIRMED, a companion
# switch not done the switch's status, no terminal an empty code; a done verdict has none. The status words: BOOTSTRAP_LAUNCHER_ENDED,
# BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED, BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE, BOOTSTRAP_DONE; the step line and the
# result line carry the code (Out-LauncherVerdict), and the drill's entry takes it as its stop code from this verdict.
function Get-LauncherVerdict([bool]$firstInstall, $terminal) {
  $ts = [string](Get-Key $terminal 'status')
  $chh = Get-Key $terminal 'companionHeadless'
  $ch = [string](Get-Key $chh 'status')
  if ($ts -cne 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED') {
    $code = Get-Key $terminal 'code'
    return [ordered]@{ status = 'BOOTSTRAP_LAUNCHER_ENDED'; code = $(if ($code -is [string] -and $code.Length) { $code } else { $null }); companionSwitch = $ch; next = $null }
  }
  # FABLE-drill-role-probe-20261124 3.2 (task 87d330d0): a first install whose node never confirmed its role is not done. The launcher's
  # terminal role is its first-train wait's: unauthorized (the service refused the node's CI token), unconfirmed (no definite answer in
  # the wait), not-held or held; a terminal without one is unconfirmed. A reinstall's verdict is as before.
  $role = [string](Get-Key $terminal 'role')
  if ($firstInstall -and $role -cne 'held' -and $role -cne 'not-held') {
    $unauthorized = $role -ceq 'unauthorized'
    return [ordered]@{ status = 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED'; code = $(if ($unauthorized) { 'FIRST_INSTALL_ROLE_UNAUTHORIZED' } else { 'FIRST_INSTALL_ROLE_UNCONFIRMED' }); companionSwitch = $ch
      next = $(if ($unauthorized) { 'installed, verified and paused, but the service refused this node''s CI token (ROLE_PROBE_CONNECTION_UNAUTHORIZED): the token is revoked, expired or not registered; give a valid one and run the same first-install command again' }
        else { 'installed, verified and paused, but the node''s role probe gave no definite answer within the first-train wait; run the same first-install command again; see first-train-report.json of this launch' }) }
  }
  if ($firstInstall -and $ch -cne 'COMPANION_HEADLESS_QUALIFIED') {
    return [ordered]@{ status = 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE'; code = $(if ($ch) { $ch } else { $null }); companionSwitch = $ch
      next = 'installed and verified, but the distribution is still the operator''s: the companion switch (the installed rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory <facts.companionWsl.vhdxDirectory>, elevated) has to pass; see companion-headless-report.json of this launch' }
  }
  [ordered]@{ status = 'BOOTSTRAP_DONE'; companionSwitch = $ch; next = $null }
}

function Get-InstallStageVerdict($terminal) {
  if ((Get-Key $terminal 'bootstrapPhase') -ceq 'launcher' -and (Get-Key $terminal 'status') -cne 'BOOTSTRAP_STAGE_FAILED') {
    $result = Get-LauncherVerdict $true $terminal
  } else {
    $code = Get-Key $terminal 'code'
    if (-not $code) { $code = Get-Key $terminal 'status' }
    $result = [ordered]@{ status = 'HOST_PREPARATION_NOT_DONE'; code = $code; message = (Get-Key $terminal 'message') }
  }
  foreach ($key in @('evidenceDirectory','evidenceError','stagingDirectory')) {
    $value = Get-Key $terminal $key
    if ($value) { $result[$key] = $value }
  }
  $result
}

function New-BootstrapFailureDirectory {
  # The normal bootstrap work parent is user writable. Keep elevated evidence
  # under a separate, checked Administrator/SYSTEM directory.
  $root = 'C:\ProgramData\CluedBootstrapFailures'
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm($AdminOnlySddl)
  $item = [IO.Directory]::CreateDirectory($root, $ds)
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'BOOTSTRAP_EVIDENCE_ROOT_REFUSED' }
  $acl = Get-Acl -LiteralPath $root
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin @('S-1-5-18','S-1-5-32-544') -or
      $rules.Count -ne 2 -or @($rules | Where-Object { $_.IdentityReference.Value -cnotin @('S-1-5-18','S-1-5-32-544') -or
        $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count) { throw 'BOOTSTRAP_EVIDENCE_ROOT_REFUSED' }
  $target = Join-Path $root ([guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($target, $ds)
  $target
}

function Copy-BootstrapEvidence($item, [string]$target) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'BOOTSTRAP_EVIDENCE_REPARSE_POINT' }
  if ($item.PSIsContainer) {
    [void][IO.Directory]::CreateDirectory($target)
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
      Copy-BootstrapEvidence $child (Join-Path $target $child.Name)
    }
  } else {
    [IO.File]::Copy($item.FullName, $target, $false)
  }
}

function Complete-InstallStageVerdict($terminal, [string]$stageDir) {
  if ($null -eq $terminal -or -not $stageDir -or (Get-Key $terminal 'status') -ceq 'FLEET_LIFECYCLE_COMPLETE' -or
      (Get-InstallStageVerdict $terminal).status -ceq 'BOOTSTRAP_DONE') { return $terminal }
  try {
    $work = Join-Path $stageDir 'prepare'
    if (-not [IO.Directory]::Exists($work)) { return $terminal }
    if (([IO.File]::GetAttributes($work) -band [IO.FileAttributes]::ReparsePoint)) { throw 'BOOTSTRAP_EVIDENCE_REPARSE_POINT' }
    $items = @(Get-ChildItem -LiteralPath $work -Force | Where-Object {
      ($_.PSIsContainer -and $_.Name -clike 'launch-*') -or (-not $_.PSIsContainer -and $_.Name -ceq 'install-plan.json')
    })
    if ($items.Count) {
      $saved = New-BootstrapFailureDirectory
      foreach ($item in $items) { Copy-BootstrapEvidence $item (Join-Path $saved $item.Name) }
      $terminal['evidenceDirectory'] = $saved
    }
  } catch {
    $terminal['evidenceError'] = [string]$_.Exception.Message
    $terminal['stagingDirectory'] = $stageDir
  }
  $terminal
}
# M6: what a run fetches: a first install everything; a node with a resident (the reinstall: prepare, rehearse.py, generate.py) node,
# python and git only, never the rootfs, the WSL package, the runner, the Linux toolchain node or the .debs.
function Get-NeededPrereqs([bool]$firstInstall) { if ($firstInstall) { , @($PrereqNames) } else { , @('node', 'python', 'git') } }

# ------------------------------------------------------------------ host actions
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); $f = [IO.File]::OpenRead($p); try { (-join ($s.ComputeHash($f) | ForEach-Object { $_.ToString('x2') })) } finally { $f.Dispose(); $s.Dispose() } }
# The JSON writer (Fable ruling 11-19 renew-key section 4.4a): windows/first-install-host.ps1's two functions, character for character
# (this file is downloaded on its own and cannot load a file of the package; test-bootstrap.ps1 holds the two texts equal). Under
# Windows PowerShell 5.1 the Work directory (Join-Path) is a string in a PSObject shell, which the bare serializer refused with a
# PSParameterizedProperty circular reference: every result after the assets step (each refusal, the reset result,
# RESTART_THEN_RUN_THE_SAME_COMMAND, the final verdict) became an exception. Every output here uses -Progress: it never throws and never
# changes the control flow (the credential clean-up order stays); a value that is not plain data is printed as its type name (the status
# and code of every result are literals of this script; the rest is diagnosis).
function ConvertTo-PlainData($value, [bool]$progress, [string]$at = '$', [int]$depth = 0) {
  if ($null -eq $value) { return $null }
  $v = $value.PSObject.BaseObject
  $t = $v.GetType()
  if ($v -is [string] -or $v -is [bool]) { return $v }
  $tc = [int][Type]::GetTypeCode($t)
  if ($t.IsPrimitive -and -not $t.IsEnum -and $tc -ge 5 -and $tc -le 14 -or $v -is [decimal]) { return $v }   # SByte..Double, Decimal
  if ($depth -lt 32) {
    if ($v -is [Collections.IDictionary]) {
      $o = [ordered]@{}
      foreach ($k in @($v.Keys)) {
        $key = if ($null -ne $k) { $k.PSObject.BaseObject } else { $null }
        if ($key -isnot [string]) { $o = $null; break }
        $r = ConvertTo-PlainData $v[$k] $progress ($at + '.' + $key) ($depth + 1)
        if ($null -ne $r) { $r = $r.PSObject.BaseObject }   # an array a function returns comes back in a shell again
        $o[$key] = $r
      }
      if ($null -ne $o) { return $o }
    } elseif ($v -is [Collections.IEnumerable]) {
      $items = @(foreach ($x in $v) { , $x })
      $a = New-Object object[] $items.Count
      for ($i = 0; $i -lt $items.Count; $i++) {
        $r = ConvertTo-PlainData $items[$i] $progress ($at + '[' + $i + ']') ($depth + 1)
        if ($null -ne $r) { $r = $r.PSObject.BaseObject }
        $a[$i] = $r
      }
      return , $a
    }
  }
  if ($progress) { return ('<not plain data: ' + $t.FullName + '>') }
  $e = New-Object InvalidOperationException ('OUTPUT_NOT_PLAIN_DATA:' + $at + ':' + $t.FullName)
  $e.Data['OutputNotPlainData'] = $true   # the mark a caller recognizes the refusal by (never its text alone)
  throw $e
}
function ConvertTo-JsonLine($value, [switch]$Progress) {
  $plain = ConvertTo-PlainData $value $Progress.IsPresent
  if ($null -ne $plain) { $plain = $plain.PSObject.BaseObject }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $js.MaxJsonLength = [int]::MaxValue   # not the default 2,097,152: at least what a reader takes (bootstrap reads a stage child up to 16,777,216)
  if (-not $Progress) { return $js.Serialize($plain) }
  try { $js.Serialize($plain) } catch {
    # progress never throws: a line that cannot be written is replaced by one that keeps its status, step and code and names why
    $kept = [ordered]@{}
    if ($plain -is [Collections.IDictionary]) { foreach ($k in @('status', 'step', 'code', 'name', 'result', 'rejectCode')) { if ($plain.Contains($k) -and $plain[$k] -is [string]) { $kept[$k] = $plain[$k] } } }
    $kept['notWritten'] = [string]$_.Exception.GetType().FullName
    $js.Serialize($kept)
  }
}
function Out-Result([string]$status, [string]$step, $extra) {
  $r = [ordered]@{ status = $status; step = $step; workDir = $script:Work }
  if ($null -ne $extra) { foreach ($k in @($extra.Keys)) { $r[$k] = $extra[$k] } }
  ConvertTo-JsonLine $r -Progress
}
# The step lines (an aid), the shape windows/first-install-host.ps1 and the launcher print: {name, result: ok|failed, rejectCode, detail}.
# One per step of this run that ends; a refusal prints its step as failed before the verdict. Never throws.
function Out-Step([string]$name, [string]$result, $rejectCode, $detail) {
  try { ConvertTo-JsonLine ([ordered]@{ name = $name; result = $result; rejectCode = $rejectCode; detail = $detail }) -Progress }
  catch { ConvertTo-JsonLine ([ordered]@{ name = $name; result = $result; rejectCode = $(if ($rejectCode -is [string]) { $rejectCode } else { $null }); detail = '<not printable>' }) -Progress }
}
# The launcher's verdict as the run's last two lines (Get-LauncherVerdict): its step, failed with the launcher's code (the status when there
# is none), and the result, which carries that code beside the status as Stop-Bootstrap's result does; a done verdict has no code.
function Out-LauncherVerdict($v, $extra) {
  $done = $v.status -ceq 'BOOTSTRAP_DONE'
  $code = Get-Key $v 'code'
  Out-Step 'launcher' $(if ($done) { 'ok' } else { 'failed' }) $(if ($done) { $null } elseif ($code) { $code } else { $v.status }) $(if ($done) { [ordered]@{ launcher = $extra['launcher']; companionSwitch = $v.companionSwitch; exit = $extra['exit'] } } else { $null })
  $r = [ordered]@{}
  if (([Collections.IDictionary]$v).Contains('code')) { $r['code'] = $code }
  foreach ($k in @($extra.Keys)) { $r[$k] = $extra[$k] }
  Out-Result $v.status 'launcher' $r
}

function Out-InstallStageResult($stage, $verdict) {
  if ($verdict.status -ceq 'HOST_PREPARATION_NOT_DONE') {
    Out-Step 'host' 'failed' $verdict.code $stage.last
    Out-Result $verdict.status 'host' ([ordered]@{ code = $verdict.code; message = $verdict.message; last = $stage.last; exit = $stage.exit; output = $stage.output;
      evidenceDirectory = (Get-Key $verdict 'evidenceDirectory'); evidenceError = (Get-Key $verdict 'evidenceError'); stagingDirectory = (Get-Key $verdict 'stagingDirectory') })
    return
  }
  Out-LauncherVerdict $verdict ([ordered]@{ firstInstall = $true; launcher = (Get-Key $stage.last 'status'); companionSwitch = $verdict.companionSwitch; next = $verdict.next;
    exit = $stage.exit; output = $stage.output; evidenceDirectory = (Get-Key $verdict 'evidenceDirectory'); evidenceError = (Get-Key $verdict 'evidenceError');
    stagingDirectory = (Get-Key $verdict 'stagingDirectory') })
}
function Stop-Bootstrap([string]$step, [string]$code, $detail) {
  if ($script:ReinstallClaimed) { try { Write-FleetReinstallClaim $ReinstallOperation 'FAILED' $code } catch {} }
  elseif ($script:ReinstallPreflight) { try { Write-FleetReinstallClaim $ReinstallOperation 'PREFLIGHT' $code } catch {} }
  Out-Step $step 'failed' $code $null
  Out-Result 'BOOTSTRAP_REFUSED' $step ([ordered]@{ code = $code; detail = $detail })
  exit 1
}
# One elevated stage of this same file (-File, arguments one by one). Returns its exit, its last JSON object and the output file;
# declined: { declined = $true } (the caller decides what follows).
function Invoke-Elevated([string]$step, [string[]]$named, [int]$limitSeconds, [string[]]$switches = @()) {
  $result = Join-Path $script:Work ('elevated-' + $step + '-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $arguments = try { Get-ElevatedArguments $script:Self (@('-Stage', $step, '-Result', $result) + @($named)) $switches } catch { Stop-Bootstrap $step 'ELEVATED_ARGUMENT_REFUSED' ([string]$_.Exception.Message) }
  $p = $null
  $launch = $null
  if ($script:ReinstallPreflight) {
    try {
      $launch = Request-FleetReinstallLaunchPermit $script:ReinstallPreflight
      if (-not (Test-FleetInteractiveDesktop)) { throw 'FLEET_WAITING_FOR_OWNER_SESSION' }
      $null = Get-FleetReinstallDelivery $script:ReinstallPreflight.operatorSid $ReinstallOperation
      Assert-FleetReinstallLaunchPermit $script:ReinstallPreflight $launch
      $spent = Join-Path $FleetDeliveryRoot ('claims\' + $ReinstallOperation + '.spent.json')
      Write-FleetOperatorRecord $spent @{ operationId = $ReinstallOperation; nonce = $launch.nonce } -Create
      $script:ReinstallClaimed = $true
      Write-FleetReinstallClaim $ReinstallOperation 'PENDING_UAC' ''
      Assert-FleetReinstallLaunchPermit $script:ReinstallPreflight $launch
    } catch {
      $code = [string]$_.Exception.Message
      if ($code -cnotmatch '^[A-Z][A-Z0-9_]{1,79}$') { $code = 'FLEET_REINSTALL_PERMIT_REFUSED' }
      Stop-Bootstrap $step $code $null
    }
  }
  try { $p = Start-Process -FilePath $PowerShellExe -ArgumentList $arguments -Verb RunAs -PassThru -WindowStyle Normal }
  catch { if (Test-UacDeclined $_.Exception) { return [ordered]@{ declined = $true; exit = $null; last = $null; output = $null } }; throw }
  finally {
    if ($launch) {
      try { Write-FleetOperatorRecord (Join-Path $FleetDeliveryRoot ('claims\' + $ReinstallOperation + '.launched.json')) @{
        operationId = $ReinstallOperation; nonce = $launch.nonce
      } } catch { }
    }
  }
  if ($script:ReinstallClaimed) { try { Write-FleetReinstallClaim $ReinstallOperation 'INSTALLING' $null } catch {} }
  if (-not $p.WaitForExit($limitSeconds * 1000)) {
    foreach ($l in @((Read-StageResult $result).lines)) { [Console]::Out.WriteLine($l) }   # what the stage printed so far, as it is (never this function's value)
    Stop-Bootstrap $step 'ELEVATED_RUN_STILL_RUNNING' ([ordered]@{ pid = $p.Id; output = $result; note = 'nothing was killed' })
  }
  if ($launch) { $script:ReinstallFinished = $true }
  $read = Read-StageResult $result
  foreach ($l in @($read.lines)) { [Console]::Out.WriteLine($l) }   # the stage's lines, as they are (the child's step lines, the stage's notes, its verdict)
  if ($null -eq $read.last) { Stop-Bootstrap $step 'STAGE_GAVE_NO_VERDICT' ([ordered]@{ exit = $p.ExitCode; output = $result; lines = @($read.lines).Count }) }
  [ordered]@{ declined = $false; exit = $p.ExitCode; last = $read.last; output = $result }
}
function Invoke-NonElevated([string]$exe, [string[]]$arguments, [hashtable]$envAdd) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  foreach ($k in @($envAdd.Keys)) { $psi.EnvironmentVariables[$k] = $envAdd[$k] }
  $proc = [Diagnostics.Process]::Start($psi)
  $o = $proc.StandardOutput.ReadToEndAsync(); $e = $proc.StandardError.ReadToEndAsync()
  $proc.WaitForExit()
  [ordered]@{ exit = $proc.ExitCode; last = (Get-LastJsonLine $o.Result); stderr = $(if ($e.Result.Length -gt 600) { $e.Result.Substring($e.Result.Length - 600) } else { $e.Result }) }
}
# H1: a child of an elevated stage (P1, the launcher), stdout and stderr read apart as Invoke-NonElevated reads them: a line on stderr (the
# launcher's Stop-Launch rethrown, an unhandled exception, any tool below it) stays text and never becomes a PowerShell error, which under
# $ErrorActionPreference = 'Stop' ended the stage and lost the child's verdict (`& powershell ... 2>&1`). The child shares this stage's
# console (CreateNoWindow off: P1's dialogs keep the window they had) and its own stdin. $limitSeconds 0: wait for it to end.
# Defect 0e004509: stdout is read line by line as the child prints it, and each line is appended to $appendTo (the stage's output file)
# and flushed at once, so a child still running at the limit, or one that ends without a verdict, leaves every line it printed on disk
# and in stdout here (ReadToEndAsync held them all until the child's end). At the limit: timedOut, the lines so far, nothing killed.
function Invoke-StageChild([string]$exe, [string[]]$arguments, [int]$limitSeconds, [string]$appendTo = $null, [hashtable]$envAdd = @{}) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $false
  foreach ($k in $envAdd.Keys) { $psi.EnvironmentVariables[$k] = $envAdd[$k] }
  $proc = [Diagnostics.Process]::Start($psi)
  $e = $proc.StandardError.ReadToEndAsync()
  $out = New-Object Text.StringBuilder
  $deadline = if ($limitSeconds -gt 0) { [DateTime]::UtcNow.AddSeconds($limitSeconds) } else { [DateTime]::MaxValue }
  $read = $proc.StandardOutput.ReadLineAsync()
  while ($true) {
    if ($read.Wait(250)) {
      $line = $read.Result
      if ($null -eq $line) { break }   # the end of stdout: the child (and anything that held its stdout) is done
      [void]$out.Append($line).Append("`n"); Add-ResultLine $appendTo $line
      $read = $proc.StandardOutput.ReadLineAsync()
    } elseif ([DateTime]::UtcNow -gt $deadline -and -not $proc.HasExited) {
      return [ordered]@{ exit = $null; timedOut = $true; pid = $proc.Id; stdout = $out.ToString(); stderr = $null; last = [ordered]@{ status = 'STAGE_CHILD_STILL_RUNNING'; pid = $proc.Id; note = 'nothing was killed' } }
    }
  }
  $proc.WaitForExit()
  $err = [string]$e.Result
  [ordered]@{ exit = $proc.ExitCode; timedOut = $false; pid = $proc.Id; stdout = $out.ToString(); stderr = $(if ($err.Length -gt 4000) { $err.Substring($err.Length - 4000) } else { $err }); last = (Get-LastJsonLine $out.ToString()) }
}
# One line appended to a stage's output file and flushed to disk (the outer run reads the file while the stage runs: shared for reading).
function Add-ResultLine([string]$path, [string]$line) {
  if (-not $path) { return }
  $b = (New-Object Text.UTF8Encoding($false)).GetBytes($line + "`r`n")
  $f = New-Object IO.FileStream($path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $f.Write($b, 0, $b.Length); $f.Flush($true) } finally { $f.Dispose() }
}
# A child's verdict is the last object it printed that has a status; a step line ({name, result, ...}) or nothing is no verdict:
# STAGE_CHILD_PRINTED_NO_VERDICT, by name (the lines it printed are in the stage's output file already).
function Get-StageVerdict($run, [string]$child) {
  if ($run.last -is [Collections.IDictionary] -and [string](Get-Key $run.last 'status')) { return $run.last }
  [ordered]@{ status = 'STAGE_CHILD_PRINTED_NO_VERDICT'; child = $child; exit = $run.exit; timedOut = $run.timedOut }
}
# The outer run's reading of a stage's output file: every line, and the verdict (the last object with a status) or $null.
function Read-StageResult([string]$path) {
  $text = if ($path -and [IO.File]::Exists($path)) { $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { (New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding($false)))).ReadToEnd() } finally { $fs.Dispose() } } else { $null }
  $last = Get-LastJsonLine $text
  [ordered]@{ lines = @(([string]$text) -split "`r?`n" | Where-Object { $_ -ne '' }); last = $(if ($last -is [Collections.IDictionary] -and [string](Get-Key $last 'status')) { $last } else { $null }) }
}
# One HTTP attempt. The response headers and each pending read share the download's deadline and have a 30 s timeout.
function Receive-Prereq($item, [string]$partial, [long]$offset, [Diagnostics.Stopwatch]$clock, [int]$limitMs) {
  $expected = [long]$item['bytes']
  $request = [Net.WebRequest]::Create([string]$item['url'])
  $request.UserAgent = 'fleet-node-bootstrap'
  $request.MaximumAutomaticRedirections = 5
  if ($offset -gt 0) { $request.AddRange($offset) }
  $response = $null
  try {
    try {
      $wait = [int][Math]::Min(30000, $limitMs - $clock.ElapsedMilliseconds)
      if ($wait -le 0) { return @{ state = 'retry'; reason = 'deadline' } }
      $pending = $request.GetResponseAsync()
      if (-not $pending.Wait($wait)) { return @{ state = 'retry'; reason = 'timeout' } }
      $response = $pending.Result
    }
    catch {
      $failure = $_.Exception
      while ($failure -is [Management.Automation.MethodInvocationException] -or $failure -is [AggregateException]) {
        $failure = $failure.InnerException
      }
      if ($failure -is [Net.WebException]) {
        $response = $failure.Response
        if ($null -ne $response) {
          $status = [int]$response.StatusCode
          if ($status -eq 416 -and $offset -gt 0) { return @{ state = 'restart'; reason = 'HTTP_416' } }
          $state = if ($status -ge 500 -and $status -lt 600) { 'retry' } else { 'refused' }
          return @{ state = $state; reason = "HTTP_$status" }
        }
        $state = if ($failure.Status -in @('TrustFailure', 'SecureChannelFailure', 'ProtocolError')) { 'refused' } else { 'retry' }
        return @{ state = $state; reason = [string]$failure.Status }
      }
      if ($failure -is [IO.IOException] -or $failure -is [TimeoutException]) {
        return @{ state = 'retry'; reason = $failure.GetType().Name }
      }
      throw
    }
    $status = [int]$response.StatusCode
    $length = $response.ContentLength
    if ($status -eq 200) {
      # The server ignored Range, or this is the first GET. Discard the old fragment before writing the full response.
      [IO.File]::Delete($partial)
      $offset = 0
      if ($length -lt 0) { $length = $expected }
      $mode = [IO.FileMode]::CreateNew
    } elseif ($status -eq 206) {
      if ($offset -eq 0 -or $response.Headers['Content-Range'] -cne "bytes ${offset}-$($expected - 1)/$expected" -or
          ($length -ge 0 -and $length -ne ($expected - $offset))) { return @{ state = 'restart'; reason = 'CONTENT_RANGE' } }
      $mode = [IO.FileMode]::Append
      $length = $expected - $offset
    } else { return @{ state = 'refused'; reason = "HTTP_$status" } }
    if ($length -gt ($expected - $offset)) { return @{ state = 'length'; bytes = ($offset + $length) } }
    $stream = $response.GetResponseStream()
    $file = [IO.File]::Open($partial, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $buffer = New-Object byte[] 65536
      $received = $offset
      while ($true) {
        $wait = [int][Math]::Min(30000, $limitMs - $clock.ElapsedMilliseconds)
        if ($wait -le 0) { return @{ state = 'retry'; reason = 'deadline' } }
        try {
          $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
          if (-not $read.Wait($wait)) { return @{ state = 'retry'; reason = 'timeout' } }
          $count = $read.Result
        } catch { return @{ state = 'retry'; reason = 'interrupted_body' } }
        if ($count -eq 0) { break }
        $received += $count
        if ($received -gt $expected) { return @{ state = 'length'; bytes = $received } }
        $file.Write($buffer, 0, $count)
      }
      if ($received -lt ($offset + $length)) { return @{ state = 'retry'; reason = 'short_body' } }
      return @{ state = 'complete' }
    } finally { $file.Dispose() }
  } finally {
    $request.Abort()
    if ($null -ne $response) { $response.Close() }
  }
}

# Local and downloaded bytes both have to match the pin before this file can be used.
function Get-Prereq($item, [string]$dest, [scriptblock]$waitBeforeRetry = { param($milliseconds) Start-Sleep -Milliseconds $milliseconds }) {
  $target = Join-Path $dest $item['fileName']
  $local = Join-Path $script:From $item['fileName']
  $partial = $target + '.part'
  if ($script:ReinstallPreflight -and [IO.File]::Exists($target)) {
    if ((Get-Item -LiteralPath $target).Length -eq [long]$item['bytes'] -and (Sha256File $target) -ceq $item['sha256']) { return $target }
    [IO.File]::Delete($target)
  }
  try {
    [IO.File]::Delete($partial)
    if ([IO.File]::Exists($local) -and (Sha256File $local) -ceq $item['sha256']) {
      [IO.File]::Copy($local, $partial, $false)
      $len = (Get-Item -LiteralPath $partial).Length
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $clock = [Diagnostics.Stopwatch]::StartNew()
      $limitMs = 30 * 60 * 1000
      $maxAttempts = 5
      $attempts = 0
      $download = @{ state = 'retry'; reason = 'deadline' }
      while ($attempts -lt $maxAttempts -and $clock.ElapsedMilliseconds -lt $limitMs) {
        $offset = if ([IO.File]::Exists($partial)) { (Get-Item -LiteralPath $partial).Length } else { 0 }
        if ($offset -ge [long]$item['bytes']) { [IO.File]::Delete($partial); $offset = 0 }
        $attempts++
        $download = Receive-Prereq $item $partial $offset $clock $limitMs
        if ($download.state -notin @('retry', 'restart')) { break }
        if ($download.state -eq 'restart') { [IO.File]::Delete($partial) }
        if ($attempts -ge $maxAttempts) { break }
        $delay = [int](1000 * [Math]::Pow(2, $attempts - 1))
        if ($clock.ElapsedMilliseconds + $delay -ge $limitMs) { $download.reason = 'deadline'; break }
        & $waitBeforeRetry $delay
      }
      if ($download.state -ne 'complete' -and $download.state -ne 'length') {
        $code = if ($download.state -eq 'refused') { 'PREREQ_DOWNLOAD_REFUSED' } else { 'PREREQ_DOWNLOAD_RETRY_EXHAUSTED' }
        Stop-Bootstrap 'prereq' $code ([ordered]@{ name = $item['fileName']; attempts = $attempts; reason = $download.reason })
      }
      $len = if ($download.state -eq 'length') { $download.bytes } else { (Get-Item -LiteralPath $partial).Length }
    }
    if ($len -ne [long]$item['bytes'] -or (Sha256File $partial) -cne $item['sha256']) {
      Stop-Bootstrap 'prereq' 'PREREQ_HASH_MISMATCH' ([ordered]@{ name = $item['fileName']; bytes = $len })
    }
    [IO.File]::Move($partial, $target)
  } finally {
    [IO.File]::Delete($partial)
  }
  $target
}
# L1: a zip expanded once per sha256 into the tools cache: into a new directory, marked complete, then renamed into place; a directory
# found incomplete (a cut-off run) is renamed aside, kept, and the expansion done again.
function Expand-Cached([string]$zip, [string]$name, [string]$sha256, $maxEntryPathLength) {
  if (-not (($maxEntryPathLength -is [int] -or $maxEntryPathLength -is [long]) -and $maxEntryPathLength -gt 0 -and $maxEntryPathLength -le [int]::MaxValue)) { throw ('PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:' + $name) }
  $dir = Join-Path (Join-Path $WorkParent 'tools') ($name + '-' + $sha256.Substring(0, 16))
  $partial = $dir + '.p-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  # Windows' default MAX_PATH includes the terminating NUL. Count the actual temporary prefix, archive root and completion marker.
  $longestPathLength = $partial.Length + 1 + [Math]::Max([long]$maxEntryPathLength, '.bootstrap-complete'.Length)
  if ($longestPathLength -gt 259) { throw ('TOOL_CACHE_PATH_TOO_LONG:' + $name + ':' + $longestPathLength + '>259:' + $partial) }
  $state = Get-ExtractState $dir $sha256
  if ($state -ceq 'complete') { return $dir }
  if ($state -ceq 'incomplete') { [IO.Directory]::Move($dir, $dir + '.i-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)) }
  Expand-Archive -LiteralPath $zip -DestinationPath $partial
  [IO.File]::WriteAllText((Join-Path $partial '.bootstrap-complete'), $sha256)
  [IO.Directory]::Move($partial, $dir)
  $dir
}

# ------------------------------------------------------------------ the elevated stages (this file, -Stage)
function Get-FleetSealedInstallPins($delivery, [string]$residentTree) {
  $tag = 'fleet-node-' + $delivery.targetFingerprint.version
  $assets = Get-FleetReinstallAssetDirectory $delivery
  $sums = Join-Path $assets "$tag.first-install.SHA256SUMS"
  $kit = Join-Path $assets "$tag.first-install-kit.json"
  $accept = Join-Path $assets "$tag.acceptance.json"
  $operation = Split-Path -Parent $assets
  foreach ($file in @((Split-Path -Parent $operation), $operation, $assets, $sums, $kit, $accept)) { Assert-FleetDeliveryTrust $file }
  if ((Sha256File $accept) -cne $delivery.targetFingerprint.acceptance_sha256) { throw 'FLEET_REINSTALL_SUBJECT_CHANGED' }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 16777216
  $a = $js.DeserializeObject([IO.File]::ReadAllText($accept))
  $kitSha = [string](Get-Key $a 'firstInstallKitSha256')
  $first = Read-Sha256Sums ([IO.File]::ReadAllText($sums))
  if ($kitSha -cnotmatch '^[0-9a-f]{64}$' -or (Sha256File $kit) -cne $kitSha -or $first["$tag.first-install-kit.json"] -cne $kitSha) {
    throw 'FIRST_INSTALL_KIT_CHANGED'
  }
  $manifest = Join-Path $residentTree 'rollout\fleet\prereq-manifest.json'
  $pins = $js.DeserializeObject([IO.File]::ReadAllText($kit))
  $out = @{ manifestSha = (Sha256File $manifest); firstSumsSha = (Sha256File $sums); kitSha = $kitSha
    controllerSha = (Get-Key (Get-Key $pins 'record') 'controllerNodeSha256') }
  foreach ($hash in $out.Values) { if ($hash -cnotmatch '^[0-9a-f]{64}$') { throw 'PROTECTED_INSTALL_INPUTS_REFUSED' } }
  $out
}

function Get-ProtectedInstallInputs([string]$stageDir, $sealed = $null) {
  $assets = Join-Path $stageDir 'assets'
  $accept = Copy-ToWork $AcceptanceFile $assets $AcceptanceSha256
  $sumsCopy = Copy-ToWork $FirstInstallSums $assets $(if ($sealed) { $sealed.firstSumsSha } else { $FirstInstallSumsSha256 })
  $first = Read-Sha256Sums ([IO.File]::ReadAllText($sumsCopy))
  $assetDir = Split-Path -Parent $FirstInstallSums
  foreach ($name in $first.Keys) {
    if ($name -cne [IO.Path]::GetFileName($Kit) -and $name -cnotmatch '^role-image-[0-9a-f]{64}\.tar\.gz$') { throw 'FIRST_INSTALL_ASSET_NAME_REFUSED' }
    $null = Copy-ToWork (Join-Path $assetDir $name) $assets $first[$name]
  }
  if ($first[[IO.Path]::GetFileName($Kit)] -cne $(if ($sealed) { $sealed.kitSha } else { $KitSha256 })) { throw 'FIRST_INSTALL_KIT_CHANGED' }

  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $pm = Copy-ToWork $PrereqManifest $stageDir $(if ($sealed) { $sealed.manifestSha } else { $PrereqManifestSha256 })
  $tools = @{}
  $manifest = $js.DeserializeObject([IO.File]::ReadAllText($pm))
  if ($sealed -and (Test-PrereqManifest $manifest (Get-NeededPrereqs $true) $true).Count) { throw 'PREREQ_MANIFEST_REFUSED' }
  foreach ($item in @($manifest['items'])) {
    $name = [string]$item['name']
    if (@('node','git','python') -cnotcontains $name) { continue }
    if ($item['fileName'] -cnotmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*\.zip$') { throw 'FIRST_INSTALL_TOOL_NAME_REFUSED' }
    $zip = Copy-ToWork (Join-Path $PrereqDirectory $item['fileName']) $stageDir $item['sha256']
    $toolDir = Join-Path $stageDir $name
    Expand-Archive -LiteralPath $zip -DestinationPath $toolDir
    $exe = @(Get-ChildItem -LiteralPath $toolDir -Recurse -File -Filter ($name + '.exe') | Where-Object { $name -cne 'git' -or $_.Directory.Name -ceq 'cmd' })
    if ($exe.Count -ne 1) { throw 'FIRST_INSTALL_TOOL_NOT_ONE' }
    $tools[$name] = $exe[0].FullName
  }
  if ($tools.Count -ne 3) { throw 'FIRST_INSTALL_TOOLS_MISSING' }
  if ($sealed -and (Sha256File $tools['node']) -cne $sealed.controllerSha) { throw 'CONTROLLER_NODE_NOT_THE_FLEETS' }
  $path = (@('node','git','python') | ForEach-Object { Split-Path -Parent $tools[$_] }) -join ';'
  [ordered]@{ assets = $assets; acceptance = $accept; node = $tools['node']; prereqManifest = $pm
    environment = @{ PATH = ($path + ';C:\Windows\System32;C:\Windows'); PSModulePath = $env:PSModulePath; NODE_OPTIONS = ''; NODE_PATH = '' } }
}

function Invoke-FirstInstallLauncher([string]$stageDir, [string]$archive, [string]$entry, $inputFiles, [string]$out, [scriptblock]$BeforeLaunch) {
  $work = Join-Path $stageDir 'prepare'
  $run = Invoke-StageChild $inputFiles.node @($entry, 'prepare', '--artifact', $archive, '--artifact-sha', $ArchiveSha256,
    '--acceptance', $inputFiles.acceptance, '--work', $work, '--from', $inputFiles.assets) 0 $out $inputFiles.environment
  $prepared = Get-StageVerdict $run 'install.mjs'
  if ($run.exit -ne 0 -or (Get-Key $prepared 'status') -cne 'FLEET_NODE_FIRST_INSTALL_PREPARED') { return $prepared }
  $launcher = Get-Key $prepared 'launcher'
  $file = Join-Path $work 'launcher.ps1'
  if ((Get-Key $launcher 'path') -cne $file -or (Get-Key $launcher 'sha256') -cne (Sha256File $file)) { throw 'LAUNCHER_CHANGED' }
  if ($BeforeLaunch) { & $BeforeLaunch }
  $run = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $file, '-RunApprovedInstall') 0 $out $inputFiles.environment
  $verdict = Get-StageVerdict $run 'launcher'
  if ($run.exit -ne 0 -and (Get-Key $verdict 'status') -ceq 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED') { throw 'LAUNCHER_EXIT_CONFLICT' }
  $verdict
}

function Get-FleetNewInstall($context, [string]$resultFile) {
  Assert-FleetLocalPath $resultFile
  $terminal = (Read-StageResult $resultFile).last
  if ((Get-LauncherVerdict $true $terminal).status -cne 'BOOTSTRAP_DONE') { return }
  $package = Get-Key $terminal 'installedPackage'
  if ((Get-Key $package 'archiveSha256') -cne $context.archiveSha256 -or
      (Get-Key $package 'ciSourceManifestSha256') -cne $context.sourceSha256 -or
      (Get-Key $package 'commit') -cne $context.commit -or (Get-Key $package 'version') -cne $context.version) { return }
  $receiptSha = Get-Key (Get-Key $terminal 'install') 'receiptSha256'
  $started = [DateTimeOffset]::MinValue
  if ($receiptSha -cnotmatch '^[0-9a-f]{64}$' -or -not [DateTimeOffset]::TryParse([string](Get-Key $terminal 'at'), [ref]$started)) { return }
  $receipt = Join-Path $FleetResources.ciRoot 'resident\install\install-receipt.json'
  Assert-FleetLocalPath $receipt
  if (-not [IO.File]::Exists($receipt) -or (Sha256File $receipt) -cne $receiptSha) { return }
  $running = @(Get-FleetServices | Where-Object { $_.Name -iin $FleetResources.services -and $_.State -ieq 'Running' -and $_.ProcessId -gt 0 })
  if ($running.Count -ne $FleetResources.services.Count) { return }
  @{
    sourceSha256 = $context.sourceSha256; receiptSha256 = $receiptSha
    startedAt = $started.ToUniversalTime().ToString('o'); localVerification = 'RESIDENT_VERIFIED_AND_COMPANION_QUALIFIED'
  }
}

function Write-FleetDeliveryResult([string]$path, $delivery, [string]$phase, [string]$code, [string]$receiptSha, [string]$returnReceiptId = '') {
  Write-FleetJournalJson $path @{
    contract = 'clued.independent-ci.fleet-reinstall-result/1'; operationId = $delivery.operationId
    grantId = $delivery.grantId; requestSha256 = $delivery.requestSha256; sourceSha256 = $delivery.sourceSha256
    nodeId = $delivery.nodeId; bindingGeneration = $delivery.bindingGeneration
    phase = $phase; receiptSha256 = $receiptSha; returnReceiptId = $returnReceiptId; code = $code; pid = $PID; at = [DateTimeOffset]::UtcNow.ToString('o')
  }
}

function Confirm-FleetDeliveryComplete([string]$path, $delivery, $progress, $installProof) {
  $evidence = Get-Key $progress 'completion'
  if ($progress.step -cne 'complete' -or (Get-FleetProgressMaintenanceId $progress) -cne $delivery.operationId -or
      (Get-Key $evidence 'grantId') -cne $delivery.grantId -or (Get-Key $evidence 'nodeId') -cne $delivery.nodeId -or
      (Get-Key $evidence 'sourceSha256') -cne $delivery.sourceSha256 -or $progress.bindingId -cne $delivery.bindingId -or
      $progress.bindingGeneration -ne $delivery.bindingGeneration -or
      (Get-Key $evidence 'receiptSha256') -cne $installProof.receiptSha256 -or
      $evidence.returnReceiptId -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'FLEET_REINSTALL_RESULT_REFUSED' }
  Write-FleetDeliveryResult $path $delivery 'COMPLETE' '' $installProof.receiptSha256 $evidence.returnReceiptId
  $back = Read-FleetConnectionJson $path
  if ($back.phase -cne 'COMPLETE' -or $back.operationId -cne $delivery.operationId -or $back.grantId -cne $delivery.grantId -or
      $back.requestSha256 -cne $delivery.requestSha256 -or $back.sourceSha256 -cne $delivery.sourceSha256 -or
      $back.nodeId -cne $delivery.nodeId -or $back.bindingGeneration -ne $delivery.bindingGeneration -or
      $back.receiptSha256 -cne $installProof.receiptSha256 -or $back.returnReceiptId -cne $evidence.returnReceiptId) {
    throw 'FLEET_REINSTALL_RESULT_WRITE_FAILED'
  }
}

function Invoke-Stage {
  $stageDir = $null; $status = $null; $verdict = $null
  $lock = $null; $locked = $false; $clearCredentials = $false
  $delivery = $null; $resultDelivery = $null; $deliveryResult = $null; $completionDue = $false
  $out = if ($Result -and (Test-SafePath $Result)) { $Result } else { $null }   # every line below is appended to it when it is made
  try {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'STAGE_NOT_ELEVATED' }
    $code = Test-StageOperator $me.User.Value $ExpectedOperatorSid
    if ($code) { throw $code }
    $mutexAcl = [Security.AccessControl.MutexSecurity]::new()
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
      $rule = [Security.AccessControl.MutexAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow')
      $mutexAcl.AddAccessRule($rule)
    }
    $created = $false
    $lock = [Threading.Mutex]::new($false, 'Global\CluedIndependentCI.PackageLifecycle', [ref]$created, $mutexAcl)
    try { $locked = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'FLEET_INSTALL_ALREADY_RUNNING' }
    if ($ReinstallOperation) {
      if ($Reset -or $Action -cne 'Install' -or $LifecycleMode -cne 'Reinstall' -or $env:CLUED_UNDER_TEST -or $env:NODE_TEST_CONTEXT) {
        throw 'FLEET_REINSTALL_ARGUMENT_REFUSED'
      }
      Assert-FleetDeliveryTrust 'C:\ProgramData\CluedFleetDelivery'
      Assert-FleetDeliveryTrust 'C:\ProgramData\CluedFleetDelivery\interactive.ps1'
      . 'C:\ProgramData\CluedFleetDelivery\interactive.ps1'
      $delivery = Get-FleetReinstallDelivery $me.User.Value $ReinstallOperation
      if ($ArchiveSha256 -cne $delivery.targetFingerprint.archive_sha256 -or $AcceptanceSha256 -cne $delivery.targetFingerprint.acceptance_sha256 -or
          $PSCommandPath -cne (Join-Path (Get-FleetReinstallAssetDirectory $delivery) ('fleet-node-' + $delivery.targetFingerprint.version + '.bootstrap.ps1')) -or
          (Sha256File $PSCommandPath) -cne $delivery.bootstrapSha256) { throw 'FLEET_REINSTALL_SUBJECT_CHANGED' }
      $deliveryResult = Join-Path (Split-Path -Parent (Get-FleetReinstallAssetDirectory $delivery)) 'result.json'
      $resultDelivery = $delivery
    }
    $stageDir = Join-Path 'C:\Windows\Temp' ('cb-' + [Guid]::NewGuid().ToString('N'))
    $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($AdminOnlySddl)
    [void][IO.Directory]::CreateDirectory($stageDir, $ds)
    if ($Stage -ceq 'install') {
      foreach ($p in @($Tar, $PrereqDirectory, $PrereqManifest, $Kit, $AcceptanceFile, $FirstInstallSums)) { if (-not (Test-SafePath $p)) { throw ('STAGE_ARGUMENT_REFUSED:' + $p) } }
      foreach ($h in @($ArchiveSha256, $PrereqManifestSha256, $KitSha256, $ToolchainNodeSha256, $RegistrarSha256, $AcceptanceSha256, $FirstInstallSumsSha256)) { if ($h -cnotmatch '^[0-9a-f]{64}$') { throw 'STAGE_ARGUMENT_REFUSED:sha256' } }
      $copy = Join-Path $stageDir 'a.tar'
      [IO.File]::Copy($Tar, $copy, $false)
      if ((Sha256File $copy) -cne $ArchiveSha256) { throw 'ARCHIVE_COPY_NOT_THE_ACCEPTED' }
      & $TarExe -x -f $copy -C $stageDir 'tree'
      if ($LASTEXITCODE -ne 0) { throw ('ARCHIVE_EXTRACT_FAILED:' + $LASTEXITCODE) }
      $residentTree = Join-Path $stageDir $Resident.Replace('/', '\')
      $entry = Join-Path $residentTree 'rollout\fleet\install.mjs'
      $sealed = if ($delivery) { Get-FleetSealedInstallPins $delivery $residentTree } else { $null }
      if ($sealed) {
        $PrereqManifestSha256 = $sealed.manifestSha; $KitSha256 = $sealed.kitSha
      }
      $protected = Get-ProtectedInstallInputs $stageDir $sealed
      $check = Invoke-StageChild $protected.node @($entry, 'first-install-check', '--artifact', $copy, '--artifact-sha', $ArchiveSha256,
        '--acceptance', $protected.acceptance, '--from', $protected.assets) 0 $out $protected.environment
      $codes = Test-FirstInstallCheck $check.last $ArchiveSha256 $KitSha256 (Sha256File $protected.node)
      if ($check.exit -ne 0 -or $codes.Count) { throw 'PROTECTED_INSTALL_INPUTS_REFUSED' }
      if ($sealed) {
        $ToolchainNodeSha256 = Get-Key $check.last 'toolchainNodeSha256'
        $RegistrarSha256 = Get-Key $check.last 'registrarSha256'
      }
      . (Join-Path $residentTree 'rollout\fleet\package-lifecycle.ps1')
      $context = New-FleetContext $protected.acceptance $ArchiveSha256 $ExpectedOperatorSid $Action
      $context.ownerUac = $true
      if ($delivery) {
        if ($context.sourceSha256 -cne $delivery.sourceSha256 -or $context.grantId -cne $delivery.grantId -or
            $context.version -cne $delivery.targetFingerprint.version) { throw 'FLEET_REINSTALL_SUBJECT_CHANGED' }
        $context.reinstallOperation = $ReinstallOperation
      }
      if ($sealed) { $PrereqManifest = $protected.prereqManifest; $Kit = Join-Path $protected.assets ([IO.Path]::GetFileName($Kit)) }
      $p1 = Join-Path $residentTree 'windows\first-install-host.ps1'
      $p1Args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $p1, '-Tree', (Join-Path $stageDir 'tree'), '-PrereqDirectory', $PrereqDirectory,
        '-PrereqManifest', $PrereqManifest, '-PrereqManifestSha256', $PrereqManifestSha256, '-KitSha256', $KitSha256, '-ToolchainNodeSha256', $ToolchainNodeSha256,
        '-RegistrarSha256', $RegistrarSha256, '-ExpectedOperatorSid', $ExpectedOperatorSid, '-Kit', $Kit)
      $facts = Get-FleetInventory
      $journalRoot = $FleetResources.journalRoot
      $progressFile = Join-Path $journalRoot 'operation.json'
      $progress = $null
      Assert-FleetLocalPath $journalRoot
      if ($null -ne (Get-FleetPathItem $journalRoot)) {
        Assert-FleetJournalRoot $journalRoot
        $progress = Read-FleetProgress $progressFile $context -ArchiveStaleFresh -RetargetReinstall
        if ($null -eq $progress) {
          if ([IO.Directory]::Exists($journalRoot) -and @(Get-ChildItem -LiteralPath $journalRoot -Force -ErrorAction Stop).Count -eq 0) {
            [IO.Directory]::Delete($journalRoot)
          }
          if ($null -eq (Get-FleetPathItem $journalRoot) -and -not $delivery) {
            $verdict = @{ status = 'FLEET_LIFECYCLE_RESELECT' }
            return
          }
        }
      }
      $freshOutput = $null
      if ($null -ne $progress -and $progress.mode -ceq 'Fresh') {
        $freshOutput = Join-Path $journalRoot ('launcher-' + $progress.operationId + '.jsonl')
        Assert-FleetLocalPath $freshOutput
        if ($progress.step -ceq 'launcher') {
          $terminal = (Read-StageResult $freshOutput).last
          $terminalStatus = Get-Key $terminal 'status'
          $launcherTerminal = (Get-Key $terminal 'contract') -ceq 'clued.independent-ci.source-v2-windows-launch-terminal/1' -and
            $terminalStatus -cin @('STOPPED','R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED','PAUSE_NOT_CONFIRMED','R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED')
          # Old journals could already say launcher when prepare refused.
          if ($terminalStatus -ceq 'FLEET_NODE_INSTALL_REFUSED' -or
              ($launcherTerminal -and (Get-LauncherVerdict $true $terminal).status -cne 'BOOTSTRAP_DONE')) {
            $progress.step = 'install'
            Write-FleetProgress $progressFile $progress
          }
        }
      }
      if ($null -ne $progress -and $progress.mode -ceq 'Fresh' -and $progress.step -cin @('launcher','verify') -and -not $Reset) {
        if (-not (Get-FleetNewInstall $context $freshOutput)) {
          if (-not $PreviewReceipt) { throw 'FLEET_REINSTALL_REQUIRES_PREVIEW' }
          # The fresh lane has no server maintenance operation. Keep its
          # operation ID, and commit the clean-reinstall intent before retrying.
          $progress.mode = 'Reinstall'
          $progress.step = 'intent'
          $progress['previewReceipt'] = $PreviewReceipt
          $progress['zeroNodeConsent'] = $ZeroNodeConsent.IsPresent
          Write-FleetProgress $progressFile $progress
        }
      }
      $mode = Get-FleetLifecycleMode $Action $facts $progress
      if ($mode -ceq 'InspectUpgrade') { $mode = 'Reinstall' }
      if ($delivery -and ($mode -cne 'Reinstall' -or ($progress -and (Get-FleetProgressMaintenanceId $progress) -cne $ReinstallOperation))) {
        throw 'FLEET_REINSTALL_MODE_CHANGED'
      }
      if ($null -eq $progress -and $mode -ceq 'Reinstall' -and $LifecycleMode -cne 'Reinstall' -and -not $PreviewReceipt) {
        throw 'FLEET_REINSTALL_REQUIRES_PREVIEW'
      }
      if ($mode -ceq 'Probe') { throw 'FLEET_LOCAL_INVENTORY_INCOMPLETE' }
      if ($Reset -and $mode -cne 'Fresh' -and -not ($null -ne $progress -and $progress.mode -ceq 'Fresh' -and $progress.step -ceq 'install')) {
        throw 'RESET_ONLY_WITHOUT_A_RESIDENT'
      }
      if ($mode -cnotin @('Fresh') -and ($null -eq $progress -or $progress.mode -cne 'Fresh')) {
        Assert-FleetJournalRoot $FleetResources.journalRoot
        if ($Action -cne 'Install') { throw 'FLEET_MAINTENANCE_ACTION_REFUSED' }
        $kitCopy = Join-Path $protected.assets ([IO.Path]::GetFileName($Kit))
        # The protected kit was checked above against the accepted digest and embeds the Source manifest.
        $kitJson = New-Object Web.Script.Serialization.JavaScriptSerializer -Property @{ MaxJsonLength = [int]::MaxValue }
        $kitRecord = Get-Key ($kitJson.DeserializeObject([IO.File]::ReadAllText($kitCopy))) 'record'
        $fingerprintTool = Join-Path $residentTree 'tools\secret-fingerprint.mjs'
        $carriedSite = $null
        if ($progress) {
          $priorCarry = Get-FleetCarryDirectory $progress
          if ($null -ne (Get-FleetPathItem $priorCarry)) {
            Assert-FleetJournalRoot $priorCarry
            $carriedSite = Get-Key (Read-FleetConnectionJson (Join-Path $priorCarry 'metadata.json')) 'rpcSite'
          }
        }
        $context.nodeConnection = Connect-FleetMaintenance $kitRecord $carriedSite $protected.node $fingerprintTool
        $context.bindingId = $context.nodeConnection.bindingId
        $context.bindingGeneration = $context.nodeConnection.generation
        if ($delivery -and ($context.bindingId -cne $delivery.bindingId -or $context.bindingGeneration -ne $delivery.bindingGeneration -or
            $context.nodeConnection.nodeId -cne $delivery.nodeId)) { throw 'FLEET_REINSTALL_BINDING_CHANGED' }
        if (-not $delivery -and -not $env:CLUED_UNDER_TEST -and -not $env:NODE_TEST_CONTEXT) {
          # An explicitly restarted bootstrap can finish the very same operation
          # after the old resident and its probe have already been removed.
          $resultRoot = 'C:\ProgramData\CluedFleetDelivery'
          $pending = try {
            Assert-FleetDeliveryTrust $resultRoot
            $pendingFile = Join-Path $resultRoot 'pending.json'
            Assert-FleetDeliveryTrust $pendingFile
            Read-FleetConnectionJson $pendingFile
          } catch { $null }
          if ($pending -and (Get-Key $pending 'contract') -ceq 'clued.independent-ci.fleet-reinstall/1' -and
              (Get-Key $pending 'operationId') -cmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -and
              (-not $progress -or (Get-Key $pending 'operationId') -ceq (Get-FleetProgressMaintenanceId $progress)) -and
              (Get-Key $pending 'requestSha256') -cmatch '^[0-9a-f]{64}$' -and
              (Get-Key $pending 'operatorSid') -ceq $context.operatorSid -and (Get-Key $pending 'grantId') -ceq $context.grantId -and
              (Get-Key $pending 'sourceSha256') -ceq $context.sourceSha256 -and (Get-Key $pending 'nodeId') -ceq $context.nodeConnection.nodeId -and
              (Get-Key $pending 'bindingGeneration') -eq $context.bindingGeneration -and (Get-Key $pending 'bindingId') -ceq $context.bindingId -and
              (Get-Key (Get-Key $pending 'targetFingerprint') 'archive_sha256') -ceq $context.archiveSha256 -and
              (Get-Key (Get-Key $pending 'targetFingerprint') 'acceptance_sha256') -ceq $context.acceptanceSha256) {
            $resultDelivery = $pending
            $deliveryResult = Join-Path $resultRoot ($pending.requestSha256 + '\' + $pending.operationId + '\result.json')
            Assert-FleetLocalPath $deliveryResult
            Assert-FleetDeliveryTrust (Split-Path -Parent $deliveryResult)
            $context.reinstallOperation = $pending.operationId
            $context.reinstallResume = $null -ne $progress
          }
        }
        $preview = Invoke-FleetMaintenance -Phase 'preview' -Context $context
        if (-not $preview.ok) { throw $preview.code }
        if ($PreviewReceipt -and $PreviewReceipt -cne $preview.previewReceipt) { throw 'FLEET_MAINTENANCE_PREVIEW_REFUSED' }
        if ($delivery -and ($context.nodeConnection.nodeId -cne $delivery.nodeId -or ($preview.healthyPeers -gt 0) -ne $delivery.hasPeer)) {
          throw 'FLEET_REINSTALL_PREVIEW_CHANGED'
        }
        if ($preview.healthyPeers -eq 0 -and (-not $PreviewReceipt -or -not $ZeroNodeConsent)) {
          # After a partial cleanup the low-privilege Broker projection can
          # be absent. Return this read-only result for a new, informed UAC.
          $verdict = @{ status = 'FLEET_LIFECYCLE_PREVIEW_REQUIRED'; preview = $preview }
          return
        }
        $context.previewReceipt = $preview.previewReceipt
        $context.zeroNodeConsent = $ZeroNodeConsent.IsPresent -and $PreviewReceipt -ceq $preview.previewReceipt
        if ($deliveryResult) { Write-FleetDeliveryResult $deliveryResult $resultDelivery 'INSTALLING' '' '' }
        $connectionFile = Join-Path $stageDir 'preserved-connection.json'
        $context.preflightCleanup = {
          param($ctx)
          foreach ($feature in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) {
            if ((Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction Stop).State -ne 'Enabled') { throw 'FLEET_WINDOWS_FEATURE_NOT_READY' }
          }
        }
        $context.checkConnection = {
          param($ctx, $carry)
          $connection = Get-FleetPreservedConnection $ctx $carry $protected.node $fingerprintTool
          if ($null -eq $connection -or (Get-Key (Get-Key $connection 'nodeRecord') 'ciPrincipalBindingId') -cne $ctx.bindingId) {
            throw 'FLEET_PRESERVED_BINDING_REFUSED'
          }
          $record = [ordered]@{}
          foreach ($key in @('appKeyId','appPublicKeySha256Base64','ciPrincipalBindingId','ciPrincipalQualificationRef','ciPrincipalRoleRef','ciTokenPinSha256')) {
            $record[$key] = Get-Key (Get-Key $connection 'nodeRecord') $key
            if ($record[$key] -isnot [string] -and $record[$key] -isnot [int] -and $record[$key] -isnot [long]) { throw 'FLEET_PRESERVED_CONNECTION_SHAPE_REFUSED' }
          }
          $upgradePin = Get-Key (Get-Key $connection 'upgradeToken') 'fingerprint'
          $heartbeat = Get-Key $connection 'heartbeatToken'
          $heartbeatProjection = if ($heartbeat) {
            @{ bindingId = Get-Key $heartbeat 'bindingId'; fingerprint = Get-Key $heartbeat 'fingerprint' }
          }
          if ($upgradePin -cnotmatch '^[0-9a-f]{64}$' -or ($heartbeat -and ($heartbeatProjection.fingerprint -cnotmatch '^[0-9a-f]{64}$' -or
              $heartbeatProjection.bindingId -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'))) { throw 'FLEET_PRESERVED_CONNECTION_SHAPE_REFUSED' }
          [IO.File]::WriteAllText($connectionFile, (ConvertTo-JsonLine -Progress @{
            nodeRecord = $record; upgradeToken = @{fingerprint = $upgradePin}; heartbeatToken = $heartbeatProjection
          }))
          $args = $p1Args + @('-PreservedConnectionFile', $connectionFile, '-PreservedCarrierDirectory', $carry, '-PreservedNodeExe', $protected.node, '-CheckPreservedConnection')
          $run = Invoke-StageChild $PowerShellExe $args 0 $out $protected.environment
          $answer = Get-StageVerdict $run 'first-install-host.ps1'
          if ($run.exit -ne 0 -or (Get-Key $answer 'status') -cne 'PRESERVED_CONNECTION_CARRIERS_VERIFIED') {
            throw ('FLEET_PRESERVED_CONNECTION_CHECK_FAILED:' + (Get-Key $answer 'code'))
          }
          $connection.rpcSite = @{ scope=$ctx.nodeConnection.scope; supabaseUrl=$ctx.nodeConnection.supabaseUrl; publishableKey=$ctx.nodeConnection.publishableKey }
          Write-FleetJournalJson (Join-Path $carry 'metadata.json') $connection
        }
        $context.observeInstall = {
          param($ctx)
          Get-FleetNewInstall $ctx (Join-Path $FleetResources.journalRoot ('launcher-' + $ctx.operationId + '.jsonl'))
        }
        $context.install = {
          param($ctx)
          $carry = Get-FleetCarryDirectory $ctx
          & $ctx.checkConnection $ctx $carry
          $args = $p1Args + @('-PreservedConnectionFile', $connectionFile, '-PreservedCarrierDirectory', $carry, '-PreservedNodeExe', $protected.node)
          $run = Invoke-StageChild $PowerShellExe $args 0 $out $protected.environment
          $answer = Get-StageVerdict $run 'first-install-host.ps1'
          if ($run.exit -ne 0 -or (Get-Key $answer 'status') -cne 'FIRST_INSTALL_HOST_READY') {
            throw ('FLEET_HOST_PREPARATION_FAILED:' + (Get-Key $answer 'code'))
          }
          $localResult = Join-Path $FleetResources.journalRoot ('launcher-' + $ctx.operationId + '.jsonl')
          Assert-FleetLocalPath $localResult
          [IO.File]::Delete($localResult)
          $terminal = Invoke-FirstInstallLauncher $stageDir $copy $entry $protected $localResult
          $proof = Get-FleetNewInstall $ctx $localResult
          if (-not $proof) {
            $result = Get-LauncherVerdict $true $terminal
            throw ('FLEET_LOCAL_INSTALL_NOT_VERIFIED:' + $result['code'])
          }
          $proof
        }
        $verdict = Invoke-FleetLifecycle $context $mode $progressFile ${function:Get-FleetStepState} ${function:Invoke-FleetStep}
        $status = $verdict.status
        if ($resultDelivery -and $status -ceq 'FLEET_LIFECYCLE_COMPLETE') {
          $completionDue = $true
          $installProof = & $context.observeInstall $context
          if (-not $installProof) { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
          Confirm-FleetDeliveryComplete $deliveryResult $resultDelivery (Read-FleetProgress $progressFile $context) $installProof
        }
        if ($context.mode -ceq 'Reinstall') {
          $carry = Get-FleetCarryDirectory $context
          Assert-FleetLocalPath $carry
          foreach ($name in $FleetResources.stagedTokens.Values) {
            $file = Join-Path $carry $name
            Assert-FleetLocalPath $file
            [IO.File]::Delete($file)
            [IO.File]::Delete($file + '.pending')
          }
          if ([IO.Directory]::Exists($carry)) { [IO.Directory]::Delete($carry) }
          [IO.File]::Delete((Join-Path $FleetResources.journalRoot ('launcher-' + $context.operationId + '.jsonl')))
          [IO.File]::Delete($progressFile)
          [IO.Directory]::Delete($FleetResources.journalRoot)
        }
        return
      }
      $protectedOutput = $out
      if (-not $Reset) {
        Assert-FleetJournalRoot $FleetResources.journalRoot
        if ($null -eq $progress) { $progress = New-FleetProgress $context 'Fresh' }
        $protectedOutput = Join-Path $FleetResources.journalRoot ('launcher-' + $progress.operationId + '.jsonl')
        Assert-FleetLocalPath $protectedOutput
        if ($progress.step -cin @('launcher','verify','complete')) {
          $verdict = (Read-StageResult $protectedOutput).last
          if ((Get-LauncherVerdict $true $verdict).status -cne 'BOOTSTRAP_DONE') { throw 'FLEET_INSTALL_RESULT_UNCONFIRMED' }
          $verdict['bootstrapPhase'] = 'launcher'
          $progress.step = 'complete'
          Write-FleetProgress $progressFile $progress
          [IO.File]::Delete($progressFile)
          [IO.File]::Delete($protectedOutput)
          [IO.Directory]::Delete($FleetResources.journalRoot)
          return
        }
        $progress.step = 'install'
        Write-FleetProgress $progressFile $progress
      }
      $clearCredentials = $true
      $swept = Clear-CredentialDirectory $CredentialDirectory
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ credentialsLeftByAnEarlierRun = $swept.existed; removed = $swept.cleared; directory = $CredentialDirectory }) -Progress)
      if (-not $swept.cleared) { throw ('CREDENTIALS_LEFT_BY_AN_EARLIER_RUN_NOT_REMOVED:' + $CredentialDirectory) }
      if ($Reset) { $p1Args += '-Reset' }
      $run = Invoke-StageChild $PowerShellExe $p1Args 0 $out $protected.environment
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ child = 'first-install-host.ps1'; exit = $run.exit; stderr = $run.stderr }) -Progress)
      $verdict = Get-StageVerdict $run 'first-install-host.ps1'
      $status = [string](Get-Key $verdict 'status')
      if ($Reset -and $run.exit -eq 0 -and $status -ceq 'FIRST_INSTALL_HOST_RESET' -and $null -ne $progress) {
        [IO.File]::Delete($freshOutput)
        [IO.File]::Delete($progressFile)
        [IO.Directory]::Delete($FleetResources.journalRoot)
      }
      if ($run.exit -eq 0 -and $status -ceq 'FIRST_INSTALL_HOST_READY' -and -not $Reset) {
        $verdict = Invoke-FirstInstallLauncher $stageDir $copy $entry $protected $protectedOutput -BeforeLaunch {
          [IO.File]::Delete($protectedOutput)
          $progress.step = 'launcher'
          Write-FleetProgress $progressFile $progress
        }
        if ($progress.step -ceq 'launcher') { $verdict['bootstrapPhase'] = 'launcher' }
        $status = [string](Get-Key $verdict 'status')
        if ((Get-LauncherVerdict $true $verdict).status -ceq 'BOOTSTRAP_DONE') {
          $progress.step = 'complete'
          Write-FleetProgress $progressFile $progress
          [IO.File]::Delete($progressFile)
          [IO.File]::Delete($protectedOutput)
          [IO.Directory]::Delete($FleetResources.journalRoot)
        }
      }
    }
  } catch {
    $f = Get-StageFailure $Stage $_.Exception
    Add-ResultLine $out (ConvertTo-JsonLine $f -Progress); $status = $f.status; $verdict = $f
  } finally {
    if ($clearCredentials) {
      $c = Clear-CredentialDirectory $CredentialDirectory
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ credentialsCleared = $c.cleared; directory = $CredentialDirectory }) -Progress)
      if (-not $c.cleared) { $verdict = [ordered]@{ status = 'BOOTSTRAP_STAGE_FAILED'; code = 'CREDENTIAL_STAGING_CLEANUP_FAILED' } }
    }
    $verdict = Complete-InstallStageVerdict $verdict $stageDir
    if ($deliveryResult -and -not $completionDue -and (Get-Command Write-FleetJournalJson -ErrorAction SilentlyContinue)) {
      try {
        Write-FleetDeliveryResult $deliveryResult $resultDelivery 'FAILED' (Get-Key $verdict 'code') ''
      } catch {
        $verdict = @{ status = 'BOOTSTRAP_STAGE_FAILED'; code = 'FLEET_REINSTALL_RESULT_WRITE_FAILED' }
      }
    }
    if ($stageDir -and -not (Get-Key $verdict 'stagingDirectory')) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($locked) { $lock.ReleaseMutex() }
    if ($lock) { $lock.Dispose() }
    # the verdict stays the last object: the child's (or the stage's failure), repeated after the notes
    if ($null -ne $verdict) { Add-ResultLine $out (ConvertTo-JsonLine $verdict -Progress) }
  }
}

# ------------------------------------------------------------------ the non-elevated entry
function Invoke-Bootstrap {
  if (-not $From -or -not [IO.Directory]::Exists($From)) { Stop-Bootstrap 'arguments' 'FROM_DIRECTORY_MISSING' $From }
  $script:From = [IO.Path]::GetFullPath($From).TrimEnd('\')
  $script:Self = $PSCommandPath
  foreach ($p in @($script:From, $script:Self)) { if (-not (Test-SafePath $p)) { Stop-Bootstrap 'arguments' 'PATH_NOT_ALLOWED' ([ordered]@{ path = $p; allowed = 'a drive path of letters, digits, ".", "_", "-" only: copy the assets to such a folder' }) } }
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ((New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-Bootstrap 'arguments' 'RUN_NOT_ELEVATED' 'run this in a normal window: it asks for UAC itself where it must' }
  $operator = $id.User.Value
  $delivery = $null
  if ($ReinstallOperation) {
    if ($Reset -or $Action -cne 'Install' -or $env:CLUED_UNDER_TEST -or $env:NODE_TEST_CONTEXT) { Stop-Bootstrap 'arguments' 'FLEET_REINSTALL_ARGUMENT_REFUSED' $null }
    Assert-FleetDeliveryTrust 'C:\ProgramData\CluedFleetDelivery'
    Assert-FleetDeliveryTrust 'C:\ProgramData\CluedFleetDelivery\interactive.ps1'
    . 'C:\ProgramData\CluedFleetDelivery\interactive.ps1'
    $delivery = Get-FleetReinstallDelivery $operator $ReinstallOperation
    if ($script:From -cne (Get-FleetReinstallAssetDirectory $delivery) -or
        $script:Self -cne (Join-Path $script:From ('fleet-node-' + $delivery.targetFingerprint.version + '.bootstrap.ps1')) -or
        (Sha256File $script:Self) -cne $delivery.bootstrapSha256) { Stop-Bootstrap 'arguments' 'FLEET_REINSTALL_SUBJECT_CHANGED' $null }
    $lockFile = Join-Path $FleetDeliveryRoot ('claims\' + $ReinstallOperation + '.preflight.lock')
    $script:ReinstallPreflightLock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not (Test-FleetPreflightDue $ReinstallOperation)) { Stop-Bootstrap 'arguments' 'FLEET_REINSTALL_ALREADY_CLAIMED' $null }
    $script:ReinstallPreflight = $delivery
    Write-FleetReinstallClaim $ReinstallOperation 'PREFLIGHT' ''
  }
  # 1. the asset set and every hash
  $present = @(Get-ChildItem -LiteralPath $script:From -File -Force | ForEach-Object { $_.Name })
  $version = try { Get-ReleaseVersion $present } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null }
  $t = 'fleet-node-' + $version
  if ($Reset -and $Action -cne 'Install') { Stop-Bootstrap 'arguments' 'RESET_ACTION_REFUSED' $null }
  Out-Step 'arguments' 'ok' $null ([ordered]@{ action = $Action; version = $version })
  $sums = try { Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $script:From 'SHA256SUMS'))) } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null }
  $firstSumsFile = Join-Path $script:From "$t.first-install.SHA256SUMS"
  $firstSums = if ([IO.File]::Exists($firstSumsFile)) { try { Read-Sha256Sums ([IO.File]::ReadAllText($firstSumsFile)) } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null } } else { $null }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 16777216
  $prereqFile = Join-Path $script:From "$t.prereq-manifest.json"
  $prereqNamesInDir = @()
  if ([IO.File]::Exists($prereqFile)) {
    try { $pm = $js.DeserializeObject([IO.File]::ReadAllText($prereqFile)); $prereqNamesInDir = @(@(Get-Key $pm 'items') + @(Get-Key $pm 'debs') | Where-Object { $null -ne $_ } | ForEach-Object { [string](Get-Key $_ 'fileName') }) } catch { $prereqNamesInDir = @() }
  }
  $codes = Test-AssetSet $present $sums $firstSums $version $false $prereqNamesInDir
  if ($codes.Count) { Stop-Bootstrap 'assets' 'ASSET_SET_REFUSED' $codes }
  $all = [ordered]@{}; foreach ($k in @($sums.Keys)) { $all[$k] = $sums[$k] }; if ($null -ne $firstSums) { foreach ($k in @($firstSums.Keys)) { $all[$k] = $firstSums[$k] } }
  foreach ($n in @($all.Keys)) { if ((Sha256File (Join-Path $script:From $n)) -cne $all[$n]) { Stop-Bootstrap 'assets' 'ASSET_HASH_MISMATCH' $n } }
  Out-Step 'assets' 'ok' $null @($all.Keys)
  # 2. the prerequisites
  $m = $js.DeserializeObject([IO.File]::ReadAllText($prereqFile))
  # Download the controller tools before selecting the installation lane.
  $needed = Get-NeededPrereqs $false
  $pc = Test-PrereqManifest $m $needed $false
  if ($pc.Count) { Stop-Bootstrap 'prereq' $(if (@($pc | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' }).Count) { 'PREREQ_NOT_PINNED' } else { 'PREREQ_MANIFEST_REFUSED' }) $pc }
  if (-not [IO.Directory]::Exists($WorkParent)) { [void][IO.Directory]::CreateDirectory($WorkParent) }
  $script:Work = if ($delivery) { Get-FleetPreflightDirectory $WorkParent $ReinstallOperation } else { Join-Path $WorkParent ([Guid]::NewGuid().ToString('N')) }
  [void][IO.Directory]::CreateDirectory($script:Work)
  $pre = Join-Path $script:Work 'prereq'; [void][IO.Directory]::CreateDirectory($pre)
  $tools = [ordered]@{}
  foreach ($i in @($m['items'] | Where-Object { @($needed) -ccontains [string]$_['name'] })) {
    $file = Get-Prereq $i $pre
    if (@('node', 'python', 'git') -ccontains [string]$i['name']) { $tools[[string]$i['name']] = Expand-Cached $file ([string]$i['name']) ([string]$i['sha256']) (Get-Key $i 'maxEntryPathLength') }
  }
  $nodeExe = @(Get-ChildItem -LiteralPath $tools['node'] -Recurse -Filter node.exe | ForEach-Object { $_.FullName })
  $pyExe = @(Get-ChildItem -LiteralPath $tools['python'] -Recurse -Filter python.exe | ForEach-Object { $_.FullName })
  $gitExe = @(Get-ChildItem -LiteralPath $tools['git'] -Recurse -Filter git.exe | Where-Object { $_.Directory.Name -ceq 'cmd' } | ForEach-Object { $_.FullName })
  if ($nodeExe.Count -ne 1 -or $pyExe.Count -ne 1 -or $gitExe.Count -ne 1) { Stop-Bootstrap 'prereq' 'PREREQ_TOOL_NOT_ONE' ([ordered]@{ node = $nodeExe.Count; python = $pyExe.Count; git = $gitExe.Count }) }
  Out-Step 'prereq' 'ok' $null @($needed)
  $path = (Split-Path -Parent $pyExe[0]) + ';' + (Split-Path -Parent $gitExe[0]) + ';' + (Split-Path -Parent $nodeExe[0]) + ';C:\Windows\System32;C:\Windows'
  $childEnv = @{ PATH = $path; PSModulePath = $env:PSModulePath }
  # 3. the archive's tree (a new work directory every run: never a half one)
  $tar = Join-Path $script:From "$t.tar"
  $x = Join-Path $script:Work 'x'; [void][IO.Directory]::CreateDirectory($x)
  & $TarExe -x -f $tar -C $x 'tree' 'universal-manifest.json'
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap 'unpack' 'ARCHIVE_EXTRACT_FAILED' $LASTEXITCODE }
  Out-Step 'unpack' 'ok' $null $null
  $install = Join-Path $x ($Resident.Replace('/', '\') + '\rollout\fleet\install.mjs')
  $acceptance = Join-Path $script:From "$t.acceptance.json"
  $archiveSha = $sums["$t.tar"]
  $lifecycle = Join-Path (Split-Path -Parent $install) 'package-lifecycle.ps1'
  if (-not [IO.File]::Exists($lifecycle)) { Stop-Bootstrap 'unpack' 'FLEET_PACKAGE_LIFECYCLE_MISSING' $null }
  . $lifecycle
  $hostInputs = $null
  $reselected = $false
  $protectedPreview = $null
  while ($true) {
    $facts = Get-FleetInventory
    $mode = Get-FleetLifecycleMode $Action $facts $null
    if ($Action -ceq 'Install' -and (Test-FleetProgressHint)) { $mode = 'Probe' }
    if ($delivery) { $mode = 'Reinstall' }
    if ($Reset -and $mode -ceq 'InspectUpgrade') { Stop-Bootstrap 'arguments' 'RESET_ONLY_WITHOUT_A_RESIDENT' $null }
    if ($mode -ceq 'InspectUpgrade') {
      $upgrade = Join-Path (Split-Path -Parent $install) 'upgrade.mjs'
      $u = Invoke-NonElevated $nodeExe[0] @($upgrade, '--artifact', $tar, '--artifact-sha', $archiveSha, '--acceptance', $acceptance,
        '--work', (Join-Path $script:Work 'upgrade')) $childEnv
      $upgradeStatus = [string](Get-Key $u.last 'status')
      $abandonedUpgrade = $false
      if ($upgradeStatus -ceq 'FLEET_NODE_UPGRADE_IN_PROGRESS') {
        try { $abandonedUpgrade = -not (Test-FleetUpgradeInProgress $u.last) }
        catch { Stop-Bootstrap 'upgrade' 'FLEET_UPGRADER_HEARTBEAT_UNKNOWN' $null }
      }
      if ($u.exit -eq 0 -and -not $abandonedUpgrade -and $upgradeStatus -cin @('FLEET_NODE_ALREADY_AT_THIS_PACKAGE','FLEET_NODE_UPGRADE_IN_PROGRESS','FLEET_NODE_UPGRADE_REQUESTED')) {
        Out-Step 'upgrade' 'ok' $null $upgradeStatus
        Out-Result $upgradeStatus 'upgrade' $u.last
        return
      }
      if (-not $abandonedUpgrade -and $upgradeStatus -cne 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL' -and (Get-Key $u.last 'code') -cne 'NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH') {
        Stop-Bootstrap 'upgrade' 'FLEET_UPGRADE_REFUSED' $u.last
      }
      Out-Step 'upgrade' 'ok' $null 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL'
      $mode = 'Reinstall'
    }
    if ($null -eq $hostInputs) {
      # Install and clean reinstall share these pinned host assets across a reselect.
      $codes = Test-AssetSet $present $sums $firstSums $version $true $prereqNamesInDir
      if ($codes.Count) { Stop-Bootstrap 'assets' 'ASSET_SET_REFUSED' $codes }
      $pc = Test-PrereqManifest $m (Get-NeededPrereqs $true) $true
      if ($pc.Count) { Stop-Bootstrap 'prereq' 'PREREQ_MANIFEST_REFUSED' $pc }
      foreach ($i in @($m['items'] | Where-Object { $needed -cnotcontains [string]$_['name'] })) { $null = Get-Prereq $i $pre }
      $debDir = Join-Path $pre 'debs'; [void][IO.Directory]::CreateDirectory($debDir)
      foreach ($d in @($m['debs'])) { $null = Get-Prereq $d $debDir }
      $c = Invoke-NonElevated $nodeExe[0] @($install, 'first-install-check', '--artifact', $tar, '--artifact-sha', $archiveSha, '--acceptance', $acceptance, '--from', $script:From) $childEnv
      $chk = $c.last
      # M2: the toolchain's node.exe is the fleet's controller runtime, checked here before the first UAC (not first in prepare, after P1)
      $kitListed = $(if ($null -ne $firstSums) { [string]$firstSums["$t.first-install-kit.json"] } else { $null })
      $fc = Test-FirstInstallCheck $chk $archiveSha $kitListed (Sha256File $nodeExe[0])
      if ($c.exit -ne 0 -or $fc.Count) {
        Stop-Bootstrap 'first-install-check' $(if ($fc -ccontains 'CONTROLLER_NODE_NOT_THE_FLEETS') { 'CONTROLLER_NODE_NOT_THE_FLEETS' } else { 'FIRST_INSTALL_INPUTS_NOT_ACCEPTED' }) ([ordered]@{ codes = $fc; exit = $c.exit; last = $chk; stderr = $c.stderr })
      }
      Out-Step 'first-install-check' 'ok' $null $null
      # M3: the elevated stage reads local copies only (the archive and the manifest copied into the work directory, held to their hashes;
      # the prerequisites are there already): an elevated token does not see a drive letter the Owner mapped
      $hostIn = Join-Path $script:Work 'host-inputs'
      $acceptHash = Sha256File $acceptance
      $sumsHash = Sha256File $firstSumsFile
      $kitFile = Join-Path $script:From "$t.first-install-kit.json"
      if ($delivery) {
        $tarLocal = $tar; $prereqLocal = $prereqFile; $kitLocal = $kitFile
        $acceptLocal = $acceptance; $sumsLocal = $firstSumsFile
      } else {
        $tarLocal = try { Copy-ToWork $tar $hostIn $archiveSha } catch { Stop-Bootstrap 'host' 'LOCAL_COPY_REFUSED' ([string]$_.Exception.Message) }
        $prereqLocal = try { Copy-ToWork $prereqFile $hostIn $sums["$t.prereq-manifest.json"] } catch { Stop-Bootstrap 'host' 'LOCAL_COPY_REFUSED' ([string]$_.Exception.Message) }
        $kitLocal = try { Copy-ToWork $kitFile $hostIn ([string]$chk['kitSha256']) } catch { Stop-Bootstrap 'host' 'LOCAL_COPY_REFUSED' ([string]$_.Exception.Message) }
        $acceptLocal = Copy-ToWork $acceptance $hostIn $acceptHash
        $sumsLocal = Copy-ToWork $firstSumsFile $hostIn $sumsHash
        foreach ($name in $firstSums.Keys) {
          if ($name -cne "$t.first-install-kit.json") { $null = Copy-ToWork (Join-Path $script:From $name) $hostIn $firstSums[$name] }
        }
        foreach ($p in @($tarLocal, $pre, $prereqLocal, $kitLocal)) { if (-not (Test-UnderDirectory $p $script:Work)) { Stop-Bootstrap 'host' 'ELEVATED_INPUT_NOT_LOCAL' $p } }
      }
      $hostInputs = @('-Tar', $tarLocal, '-ArchiveSha256', $archiveSha, '-PrereqDirectory', $pre, '-PrereqManifest', $prereqLocal, '-PrereqManifestSha256', $sums["$t.prereq-manifest.json"],
        '-KitSha256', [string]$chk['kitSha256'], '-ToolchainNodeSha256', [string]$chk['toolchainNodeSha256'], '-RegistrarSha256', [string]$chk['registrarSha256'], '-ExpectedOperatorSid', $operator, '-Kit', $kitLocal,
        '-AcceptanceFile', $acceptLocal, '-AcceptanceSha256', $acceptHash, '-FirstInstallSums', $sumsLocal, '-FirstInstallSumsSha256', $sumsHash)
    }
    $hostArgs = $hostInputs + @('-Action', $Action, '-LifecycleMode', $mode)
    $switches = @()
    if ($Reset) { $switches += '-Reset' }
    if ($mode -cin @('Probe','Reinstall','Retire','Rollback') -and -not $Reset) {
      $context = New-FleetContext $acceptLocal $archiveSha $operator $Action
      $preview = if ($delivery) {
        $latest = Get-FleetReinstallDelivery $operator $ReinstallOperation
        if ($latest.hasPeer -ne $delivery.hasPeer -or $context.archiveSha256 -cne $latest.targetFingerprint.archive_sha256 -or
            $context.acceptanceSha256 -cne $latest.targetFingerprint.acceptance_sha256 -or $context.grantId -cne $latest.grantId) {
          Stop-Bootstrap 'host' 'FLEET_REINSTALL_PREVIEW_CHANGED' $null
        }
        New-FleetMaintenancePreview $context $latest.hasPeer
      } elseif ($protectedPreview) { $protectedPreview } else { Invoke-FleetMaintenance -Phase 'preview' -Context $context }
      if ($preview.ok -eq $true) {
        Assert-FleetPreview $preview $context
        $hostArgs += @('-PreviewReceipt', $preview.previewReceipt)
        if ($preview.healthyPeers -eq 0) {
          Write-Host 'CI will be unavailable until the new installation passes service verification. Continue at the Windows UAC prompt to consent.'
          $switches += '-ZeroNodeConsent'
        }
      } elseif ($mode -cne 'Probe' -and -not ($mode -ceq 'Reinstall' -and $preview.code -ceq 'FLEET_MAINTENANCE_PREVIEW_UNKNOWN')) {
        Stop-Bootstrap 'host' $preview.code $null
      }
    }
    if ($delivery) {
      if (-not (Test-FleetInteractiveDesktop)) { Stop-Bootstrap 'host' 'FLEET_WAITING_FOR_OWNER_SESSION' $null }
      $hostArgs += @('-ReinstallOperation', $ReinstallOperation)
      Write-Host ('Preparing clean reinstall of ' + $context.version + ' on ' + $context.machine + '.')
    }
    $h = Invoke-Elevated 'install' $hostArgs ($HostLimitSeconds + $LauncherLimitSeconds + 5400) $switches
    if ($h.declined) { Stop-Bootstrap 'host' 'UAC_DECLINED' 'nothing elevated ran; run the same command again to continue' }
    $st = [string](Get-Key $h.last 'status')
    if ($delivery -and $st -cne 'FLEET_LIFECYCLE_COMPLETE') {
      $code = [string](Get-Key $h.last 'code')
      if ($code -cnotmatch '^[A-Z][A-Z0-9_]{1,79}$') { $code = 'FLEET_REINSTALL_STAGE_UNCONFIRMED' }
      Stop-Bootstrap 'host' $code $h.last
    }
    if ($st -ceq 'FLEET_LIFECYCLE_PREVIEW_REQUIRED') {
      if ($protectedPreview) { Stop-Bootstrap 'host' 'FLEET_MAINTENANCE_PREVIEW_REFUSED' $null }
      $protectedPreview = Get-Key $h.last 'preview'
      if (-not $protectedPreview) { Stop-Bootstrap 'host' 'FLEET_MAINTENANCE_PREVIEW_REFUSED' $null }
      continue
    }
    if ($st -ceq 'FLEET_LIFECYCLE_RESELECT') {
      if ($reselected) { Stop-Bootstrap 'host' 'FLEET_LIFECYCLE_RESELECT_REPEATED' $h.last }
      $reselected = $true
      continue
    }
    if ($st -ceq 'FLEET_LIFECYCLE_COMPLETE') { Out-Result $st 'host' $h.last; return }
    if ($Reset) {
      $resetDone = $st -ceq 'FIRST_INSTALL_HOST_RESET'
      Out-Step 'host' $(if ($resetDone) { 'ok' } else { 'failed' }) $(if ($resetDone) { $null } else { 'BOOTSTRAP_RESET_NOT_DONE' }) $(if ($resetDone) { [ordered]@{ status = $st } } else { $null })
      Out-Result $(if ($resetDone) { 'BOOTSTRAP_RESET_DONE' } else { 'BOOTSTRAP_RESET_NOT_DONE' }) 'host' ([ordered]@{ last = $h.last; output = $h.output }); return
    }
    if ($st -ceq 'RESTART_THEN_RUN_THE_SAME_COMMAND') { Out-Step 'host' 'failed' 'RESTART_THEN_RUN_THE_SAME_COMMAND' $null; Out-Result 'RESTART_THEN_RUN_THE_SAME_COMMAND' 'host' ([ordered]@{ detail = $h.last }); exit 3 }
    $v = Get-InstallStageVerdict $h.last
    Out-InstallStageResult $h $v
    if ($v.status -cne 'BOOTSTRAP_DONE') { exit 1 }
    return
  }
}

$script:Work = $null; $script:Self = $null; $script:ReinstallClaimed = $false
$script:ReinstallPreflight = $null; $script:ReinstallPreflightLock = $null; $script:ReinstallFinished = $false
if ($MyInvocation.InvocationName -ne '.') {
  if ($Stage) { Invoke-Stage }
  else {
    try { Invoke-Bootstrap }
    catch {
      if (-not $script:ReinstallPreflight) { throw }
      $code = [string]$_.Exception.Message
      if ($code -cnotmatch '^[A-Z][A-Z0-9_]{1,79}$') { $code = 'FLEET_REINSTALL_PREFLIGHT_FAILED' }
      Stop-Bootstrap 'host' $code $null
    } finally {
      if ($script:ReinstallPreflightLock) { $script:ReinstallPreflightLock.Dispose() }
      if ($script:ReinstallFinished) { Remove-FleetPreflightWork $WorkParent $ReinstallOperation $ReinstallOperation }
    }
  }
}
