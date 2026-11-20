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
       (Get-NeededPrereqs). Each file from <dir> when it is there with its pinned hash, else downloaded, then held to sha256 and size;
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
         b. the host preparation ELEVATED (UAC 1): this same file with -Stage host and its arguments one by one (-File, M3), which
            first refuses an elevated account that is not the operator who started this (M4), copies the archive into an admin-only
            directory, checks its sha256, extracts it and runs its windows\first-install-host.ps1. Everything it reads is a local copy
            in the work directory (Copy-ToWork): an elevated token does not see a drive letter the Owner mapped;
         c. install.mjs prepare --from <dir> (not elevated);
       then the launcher ELEVATED (UAC 2): -Stage launcher copies the launcher prepare wrote into an admin-only directory, checks its
       sha256 and runs that copy with -RunApprovedInstall. A first install ends BOOTSTRAP_DONE only when the launcher verified, paused
       and the companion switch passed (Get-LauncherVerdict; else BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE).
  An elevated stage runs its child (P1, the launcher) with stdout and stderr read apart (Invoke-StageChild): a line on stderr never
  ends the stage or loses the child's verdict.
  The first install's token directory (C:\ProgramData\CluedIndependentCI\first-install\credentials) never outlives the run (L3): the
  host stage removes one an earlier run left before P1 starts, and removes it on every end but FIRST_INSTALL_HOST_READY while this
  bootstrap still waits (its process id and start time, -ParentProcessId/-ParentStartTicks; one that gave up or was closed does not:
  H2); the launcher stage removes it on every end, and a prepare that fails or a launcher UAC that is declined is followed by
  -Stage cleanup (one more UAC; declined, the result says CREDENTIALS_LEFT and where, and the next run's host stage removes it).
  -Reset (a first install only, no resident on the host): the host stage runs first-install-host.ps1 -Reset, which removes what this
  host preparation made and nothing else.
  A declined UAC prompt is UAC_DECLINED (nothing elevated ran); an elevated run that has not ended within its limit is
  ELEVATED_RUN_STILL_RUNNING (nothing is killed). A stage's terminating exception is kept in its result with its message (L4) and its
  temporary copies are removed in every case. The last line printed is one JSON object: {status, step, code?, detail?, workDir}.
#>
param([string]$From, [ValidateSet('', 'host', 'launcher', 'cleanup')][string]$Stage = '', [string]$Result, [string]$Tar, [string]$ArchiveSha256,
  [string]$PrereqDirectory, [string]$PrereqManifest, [string]$PrereqManifestSha256, [string]$KitSha256, [string]$ToolchainNodeSha256, [string]$RegistrarSha256,
  [string]$ExpectedOperatorSid, [string]$Launcher, [string]$LauncherSha256, [int]$ParentProcessId = 0, [long]$ParentStartTicks = 0, [string]$Kit, [switch]$Reset)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions   # JavaScriptSerializer (Windows PowerShell 5.1 does not load it by itself)
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$ReceiptFile = 'C:\ProgramData\CluedIndependentCI\resident\install\install-receipt.json'
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
  [ordered]@{ status = 'BOOTSTRAP_STAGE_FAILED'; stage = $stage; message = [string]$exception.Message; type = $exception.GetType().FullName }
}
# M4: the elevated stage runs as the operator who started the bootstrap, or not at all (a UAC prompt answered with another account).
function Test-StageOperator([string]$actualSid, [string]$expectedSid) {
  if ($expectedSid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { return 'EXPECTED_OPERATOR_SID_REQUIRED' }
  if ($actualSid -cne $expectedSid) { return 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR' }
  $null
}
# L3: whether a stage's end clears the token directory: always, but after a host preparation that left it for the launcher.
# H2: and only while the bootstrap that started the host stage still waits for it ($parentAlive): one that gave up (its 4-hour limit,
# ELEVATED_RUN_STILL_RUNNING) or whose window was closed never runs the launcher that would take them.
function Test-CredentialsToClear([string]$stage, [string]$status, [bool]$parentAlive = $true) {
  if ($stage -ceq 'host') { return ($status -cne 'FIRST_INSTALL_HOST_READY' -or -not $parentAlive) }
  $true
}
# H2: the bootstrap that started a stage, by its process id and start time (a reused id is another process).
function Test-ParentAlive([int]$processId, [long]$startTicks) {
  if ($processId -le 0) { return $false }
  $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $false }
  try { $p.StartTime.ToUniversalTime().Ticks -eq $startTicks } catch { $false }
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
# M4: the run's verdict from the launcher's terminal. A first install is done only when the M5-b switch moved the distribution to the
# companion account (companion-headless COMPANION_HEADLESS_QUALIFIED): until then it is the operator's (wsl-first-install), which the
# profile's ownerSid (the companion) does not match. A reinstall's verdict is as before.
# code (Fable ruling 11-20 "first install r4" section 5(a), E5): why the launcher did not end done, as the launcher said it -- a terminal
# that stopped gives its own code, a companion switch not done the switch's code (else its status), no terminal an empty code; a done
# verdict has none. The status words stay as they are; the step line and the result line carry the code (Out-LauncherVerdict), and the
# drill's entry takes it as its stop code from this verdict.
function Get-LauncherVerdict([bool]$firstInstall, $terminal) {
  $ts = [string](Get-Key $terminal 'status')
  $chh = Get-Key $terminal 'companionHeadless'
  $ch = [string](Get-Key $chh 'status')
  if ($ts -cne 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED') {
    $code = Get-Key $terminal 'code'
    return [ordered]@{ status = 'BOOTSTRAP_LAUNCHER_ENDED'; code = $(if ($code -is [string] -and $code.Length) { $code } else { $null }); companionSwitch = $ch; next = $null }
  }
  if ($firstInstall -and $ch -cne 'COMPANION_HEADLESS_QUALIFIED') {
    $chc = Get-Key $chh 'code'
    return [ordered]@{ status = 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE'; code = $(if ($chc -is [string] -and $chc.Length) { $chc } elseif ($ch) { $ch } else { $null }); companionSwitch = $ch
      next = 'installed and verified, but the distribution is still the operator''s: the companion switch (the installed rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory <facts.companionWsl.vhdxDirectory>, elevated) has to pass; see companion-headless-report.json of this launch' }
  }
  [ordered]@{ status = 'BOOTSTRAP_DONE'; companionSwitch = $ch; next = $null }
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
function Stop-Bootstrap([string]$step, [string]$code, $detail) { Out-Step $step 'failed' $code $null; Out-Result 'BOOTSTRAP_REFUSED' $step ([ordered]@{ code = $code; detail = $detail }); exit 1 }
# One elevated stage of this same file (-File, arguments one by one). Returns its exit, its last JSON object and the output file;
# declined: { declined = $true } (the caller decides what follows).
function Invoke-Elevated([string]$step, [string[]]$named, [int]$limitSeconds, [string[]]$switches = @()) {
  $result = Join-Path $script:Work ('elevated-' + $step + '-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $arguments = try { Get-ElevatedArguments $script:Self (@('-Stage', $step, '-Result', $result) + @($script:ParentArgs) + @($named)) $switches } catch { Stop-Bootstrap $step 'ELEVATED_ARGUMENT_REFUSED' ([string]$_.Exception.Message) }
  $p = $null
  try { $p = Start-Process -FilePath $PowerShellExe -ArgumentList $arguments -Verb RunAs -PassThru -WindowStyle Normal }
  catch { if (Test-UacDeclined $_.Exception) { return [ordered]@{ declined = $true; exit = $null; last = $null; output = $null } }; throw }
  if (-not $p.WaitForExit($limitSeconds * 1000)) {
    foreach ($l in @((Read-StageResult $result).lines)) { [Console]::Out.WriteLine($l) }   # what the stage printed so far, as it is (never this function's value)
    Stop-Bootstrap $step 'ELEVATED_RUN_STILL_RUNNING' ([ordered]@{ pid = $p.Id; output = $result; note = 'nothing was killed' })
  }
  $read = Read-StageResult $result
  foreach ($l in @($read.lines)) { [Console]::Out.WriteLine($l) }   # the stage's lines, as they are (the child's step lines, the stage's notes, its verdict)
  if ($step -cne 'cleanup' -and $null -eq $read.last) { Stop-Bootstrap $step 'STAGE_GAVE_NO_VERDICT' ([ordered]@{ exit = $p.ExitCode; output = $result; lines = @($read.lines).Count }) }
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
function Invoke-StageChild([string]$exe, [string[]]$arguments, [int]$limitSeconds, [string]$appendTo = $null) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $false
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
# One prerequisite file into $dest: <From>\<fileName> when it has the pinned hash, else downloaded; held to sha256 and size either way.
function Get-Prereq($item, [string]$dest) {
  $target = Join-Path $dest $item['fileName']
  $local = Join-Path $script:From $item['fileName']
  if ([IO.File]::Exists($local) -and (Sha256File $local) -ceq $item['sha256']) { [IO.File]::Copy($local, $target, $false) }
  else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $item['url'] -OutFile $target -UseBasicParsing
  }
  $len = (Get-Item -LiteralPath $target).Length
  if ((Sha256File $target) -cne $item['sha256'] -or $len -ne [long]$item['bytes']) { Stop-Bootstrap 'prereq' 'PREREQ_HASH_MISMATCH' ([ordered]@{ name = $item['fileName']; bytes = $len }) }
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
function Invoke-Stage {
  $stageDir = $null; $status = $null; $verdict = $null
  $out = if ($Result -and (Test-SafePath $Result)) { $Result } else { $null }   # every line below is appended to it when it is made
  try {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'STAGE_NOT_ELEVATED' }
    $code = Test-StageOperator $me.User.Value $ExpectedOperatorSid
    if ($code) { throw $code }
    if ($Stage -cne 'cleanup') {
      $stageDir = Join-Path 'C:\Windows\Temp' ('clued-bootstrap-' + $Stage + '-' + [Guid]::NewGuid().ToString('N'))
      $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($AdminOnlySddl)
      [void][IO.Directory]::CreateDirectory($stageDir, $ds)
    }
    if ($Stage -ceq 'host') {
      foreach ($p in @($Tar, $PrereqDirectory, $PrereqManifest, $Kit)) { if (-not (Test-SafePath $p)) { throw ('STAGE_ARGUMENT_REFUSED:' + $p) } }
      foreach ($h in @($ArchiveSha256, $PrereqManifestSha256, $KitSha256, $ToolchainNodeSha256, $RegistrarSha256)) { if ($h -cnotmatch '^[0-9a-f]{64}$') { throw 'STAGE_ARGUMENT_REFUSED:sha256' } }
      # H2: tokens an earlier run left (it gave up waiting, its window was closed, its cleanup was declined) never outlive this start:
      # P1 asks for them again and holds them to the fingerprints facts.json records
      $swept = Clear-CredentialDirectory $CredentialDirectory
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ credentialsLeftByAnEarlierRun = $swept.existed; removed = $swept.cleared; directory = $CredentialDirectory }) -Progress)
      if (-not $swept.cleared) { throw ('CREDENTIALS_LEFT_BY_AN_EARLIER_RUN_NOT_REMOVED:' + $CredentialDirectory) }
      $copy = Join-Path $stageDir 'a.tar'
      [IO.File]::Copy($Tar, $copy, $false)
      if ((Sha256File $copy) -cne $ArchiveSha256) { throw 'ARCHIVE_COPY_NOT_THE_ACCEPTED' }
      & $TarExe -x -f $copy -C $stageDir 'tree'
      if ($LASTEXITCODE -ne 0) { throw ('ARCHIVE_EXTRACT_FAILED:' + $LASTEXITCODE) }
      $p1 = Join-Path $stageDir ($Resident.Replace('/', '\') + '\windows\first-install-host.ps1')
      $p1Args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $p1, '-Tree', (Join-Path $stageDir 'tree'), '-PrereqDirectory', $PrereqDirectory,
        '-PrereqManifest', $PrereqManifest, '-PrereqManifestSha256', $PrereqManifestSha256, '-KitSha256', $KitSha256, '-ToolchainNodeSha256', $ToolchainNodeSha256,
        '-RegistrarSha256', $RegistrarSha256, '-ExpectedOperatorSid', $ExpectedOperatorSid, '-Kit', $Kit)   # the kit: P1 holds it to -KitSha256 and reads gh's path from it
      if ($Reset) { $p1Args += '-Reset' }
      $run = Invoke-StageChild $PowerShellExe $p1Args 0 $out
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ child = 'first-install-host.ps1'; exit = $run.exit; stderr = $run.stderr }) -Progress)
      $verdict = Get-StageVerdict $run 'first-install-host.ps1'
      $status = [string](Get-Key $verdict 'status')
    } elseif ($Stage -ceq 'launcher') {
      if (-not (Test-SafePath $Launcher) -or $LauncherSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'STAGE_ARGUMENT_REFUSED:launcher' }
      $copy = Join-Path $stageDir 'launcher.ps1'
      [IO.File]::Copy($Launcher, $copy, $false)
      if ((Sha256File $copy) -cne $LauncherSha256) { throw 'LAUNCHER_CHANGED' }
      $run = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $copy, '-RunApprovedInstall') 0 $out
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ child = 'launcher'; exit = $run.exit; stderr = $run.stderr }) -Progress)
      $verdict = Get-StageVerdict $run 'launcher'
      $status = [string](Get-Key $verdict 'status')
    } else { $status = 'CLEANUP' }
  } catch {
    $f = Get-StageFailure $Stage $_.Exception
    Add-ResultLine $out (ConvertTo-JsonLine $f -Progress); $status = $f.status; $verdict = $f
  } finally {
    if ($stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
    $parentAlive = Test-ParentAlive $ParentProcessId $ParentStartTicks
    if (Test-CredentialsToClear $Stage $status $parentAlive) {
      $c = Clear-CredentialDirectory $CredentialDirectory
      Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ credentialsCleared = $c.cleared; directory = $CredentialDirectory; bootstrapStillWaiting = $parentAlive }) -Progress)
      if ($Stage -ceq 'cleanup') { Add-ResultLine $out (ConvertTo-JsonLine ([ordered]@{ status = $(if ($c.cleared) { 'CREDENTIALS_CLEARED' } else { 'CREDENTIALS_LEFT' }); directory = $CredentialDirectory }) -Progress) }
    }
    # the verdict stays the last object: the child's (or the stage's failure), repeated after the notes
    if ($Stage -cne 'cleanup' -and $null -ne $verdict) { Add-ResultLine $out (ConvertTo-JsonLine $verdict -Progress) }
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
  # H2: every elevated stage knows this process (id and start time): a host preparation that ends after this run gave up never keeps tokens
  $script:ParentArgs = @('-ParentProcessId', [string]$PID, '-ParentStartTicks', [string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks)
  # 1. the asset set and every hash
  $present = @(Get-ChildItem -LiteralPath $script:From -File -Force | ForEach-Object { $_.Name })
  $version = try { Get-ReleaseVersion $present } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null }
  $t = 'fleet-node-' + $version
  $firstInstall = -not [IO.File]::Exists($ReceiptFile)
  if ($Reset -and -not $firstInstall) { Stop-Bootstrap 'arguments' 'RESET_ONLY_WITHOUT_A_RESIDENT' 'this node has an install receipt: it is reinstalled or uninstalled, never reset' }
  Out-Step 'arguments' 'ok' $null ([ordered]@{ firstInstall = $firstInstall; version = $version })
  $sums = try { Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $script:From 'SHA256SUMS'))) } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null }
  $firstSumsFile = Join-Path $script:From "$t.first-install.SHA256SUMS"
  $firstSums = if ([IO.File]::Exists($firstSumsFile)) { try { Read-Sha256Sums ([IO.File]::ReadAllText($firstSumsFile)) } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null } } else { $null }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 16777216
  $prereqFile = Join-Path $script:From "$t.prereq-manifest.json"
  $prereqNamesInDir = @()
  if ([IO.File]::Exists($prereqFile)) {
    try { $pm = $js.DeserializeObject([IO.File]::ReadAllText($prereqFile)); $prereqNamesInDir = @(@(Get-Key $pm 'items') + @(Get-Key $pm 'debs') | Where-Object { $null -ne $_ } | ForEach-Object { [string](Get-Key $_ 'fileName') }) } catch { $prereqNamesInDir = @() }
  }
  $codes = Test-AssetSet $present $sums $firstSums $version $firstInstall $prereqNamesInDir
  if ($codes.Count) { Stop-Bootstrap 'assets' 'ASSET_SET_REFUSED' $codes }
  $all = [ordered]@{}; foreach ($k in @($sums.Keys)) { $all[$k] = $sums[$k] }; if ($null -ne $firstSums) { foreach ($k in @($firstSums.Keys)) { $all[$k] = $firstSums[$k] } }
  foreach ($n in @($all.Keys)) { if ((Sha256File (Join-Path $script:From $n)) -cne $all[$n]) { Stop-Bootstrap 'assets' 'ASSET_HASH_MISMATCH' $n } }
  Out-Step 'assets' 'ok' $null @($all.Keys)
  # 2. the prerequisites
  $m = $js.DeserializeObject([IO.File]::ReadAllText($prereqFile))
  # M6: only what this run's path uses is fetched and must be pinned (a reinstall: node, python, git; a first install: everything)
  $needed = Get-NeededPrereqs $firstInstall
  $pc = Test-PrereqManifest $m $needed $firstInstall
  if ($pc.Count) { Stop-Bootstrap 'prereq' $(if (@($pc | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' }).Count) { 'PREREQ_NOT_PINNED' } else { 'PREREQ_MANIFEST_REFUSED' }) $pc }
  if (-not [IO.Directory]::Exists($WorkParent)) { [void][IO.Directory]::CreateDirectory($WorkParent) }
  $script:Work = Join-Path $WorkParent ([Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($script:Work)
  $pre = Join-Path $script:Work 'prereq'; [void][IO.Directory]::CreateDirectory($pre)
  $tools = [ordered]@{}
  foreach ($i in @($m['items'] | Where-Object { @($needed) -ccontains [string]$_['name'] })) {
    $file = Get-Prereq $i $pre
    if (@('node', 'python', 'git') -ccontains [string]$i['name']) { $tools[[string]$i['name']] = Expand-Cached $file ([string]$i['name']) ([string]$i['sha256']) (Get-Key $i 'maxEntryPathLength') }
  }
  if ($firstInstall) { $debDir = Join-Path $pre 'debs'; [void][IO.Directory]::CreateDirectory($debDir); foreach ($d in @($m['debs'])) { $null = Get-Prereq $d $debDir } }
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
  $prepareArgs = @($install, 'prepare', '--artifact', $tar, '--artifact-sha', $archiveSha, '--acceptance', $acceptance, '--work', (Join-Path $script:Work 'prepare'))
  # 4. a first install: the accepted inputs checked non-elevated, then the host preparation elevated with exactly their pins
  if ($firstInstall) {
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
    $tarLocal = try { Copy-ToWork $tar $hostIn $archiveSha } catch { Stop-Bootstrap 'host' 'LOCAL_COPY_REFUSED' ([string]$_.Exception.Message) }
    $prereqLocal = try { Copy-ToWork $prereqFile $hostIn $sums["$t.prereq-manifest.json"] } catch { Stop-Bootstrap 'host' 'LOCAL_COPY_REFUSED' ([string]$_.Exception.Message) }
    $kitLocal = try { Copy-ToWork (Join-Path $script:From "$t.first-install-kit.json") $hostIn ([string]$chk['kitSha256']) } catch { Stop-Bootstrap 'host' 'LOCAL_COPY_REFUSED' ([string]$_.Exception.Message) }
    foreach ($p in @($tarLocal, $pre, $prereqLocal, $kitLocal)) { if (-not (Test-UnderDirectory $p $script:Work)) { Stop-Bootstrap 'host' 'ELEVATED_INPUT_NOT_LOCAL' $p } }
    $hostArgs = @('-Tar', $tarLocal, '-ArchiveSha256', $archiveSha, '-PrereqDirectory', $pre, '-PrereqManifest', $prereqLocal, '-PrereqManifestSha256', $sums["$t.prereq-manifest.json"],
      '-KitSha256', [string]$chk['kitSha256'], '-ToolchainNodeSha256', [string]$chk['toolchainNodeSha256'], '-RegistrarSha256', [string]$chk['registrarSha256'], '-ExpectedOperatorSid', $operator, '-Kit', $kitLocal)
    $h = Invoke-Elevated 'host' $hostArgs $HostLimitSeconds $(if ($Reset) { @('-Reset') } else { @() })
    if ($h.declined) { Stop-Bootstrap 'host' 'UAC_DECLINED' 'nothing elevated ran; run the same command again to continue' }
    $st = [string](Get-Key $h.last 'status')
    if ($Reset) {
      $resetDone = $st -ceq 'FIRST_INSTALL_HOST_RESET'
      Out-Step 'host' $(if ($resetDone) { 'ok' } else { 'failed' }) $(if ($resetDone) { $null } else { 'BOOTSTRAP_RESET_NOT_DONE' }) $(if ($resetDone) { [ordered]@{ status = $st } } else { $null })
      Out-Result $(if ($resetDone) { 'BOOTSTRAP_RESET_DONE' } else { 'BOOTSTRAP_RESET_NOT_DONE' }) 'host' ([ordered]@{ last = $h.last; output = $h.output }); return
    }
    if ($st -ceq 'RESTART_THEN_RUN_THE_SAME_COMMAND') { Out-Step 'host' 'failed' 'RESTART_THEN_RUN_THE_SAME_COMMAND' $null; Out-Result 'RESTART_THEN_RUN_THE_SAME_COMMAND' 'host' ([ordered]@{ detail = $h.last }); exit 3 }
    if ($h.exit -ne 0 -or $st -cne 'FIRST_INSTALL_HOST_READY') { Stop-Bootstrap 'host' 'HOST_PREPARATION_NOT_DONE' ([ordered]@{ exit = $h.exit; last = $h.last; output = $h.output }) }
    Out-Step 'host' 'ok' $null ([ordered]@{ status = $st })
    $prepareArgs += @('--from', $script:From)
  }
  # 5. prepare (non-elevated), then its launcher elevated; after a first install's host preparation every failure clears the tokens
  $clear = {
    param([string]$why)
    if (-not $firstInstall) { return $null }
    $cl = Invoke-Elevated 'cleanup' @('-ExpectedOperatorSid', $operator) 600
    [ordered]@{ why = $why; credentials = $(if ($cl.declined) { 'CREDENTIALS_LEFT_UAC_DECLINED: ' + $CredentialDirectory } else { [string](Get-Key $cl.last 'status') }) }
  }
  $pr = Invoke-NonElevated $nodeExe[0] $prepareArgs $childEnv
  $ps = [string](Get-Key $pr.last 'status')
  $lch = Get-Key $pr.last 'launcher'
  if ($pr.exit -ne 0 -or @('FLEET_NODE_INSTALL_PREPARED', 'FLEET_NODE_FIRST_INSTALL_PREPARED') -cnotcontains $ps -or -not (Test-SafePath ([string](Get-Key $lch 'path'))) -or [string](Get-Key $lch 'sha256') -cnotmatch '^[0-9a-f]{64}$') {
    Stop-Bootstrap 'prepare' 'PREPARE_REFUSED' ([ordered]@{ exit = $pr.exit; last = $pr.last; stderr = $pr.stderr; cleanup = (& $clear 'prepare') })
  }
  Out-Step 'prepare' 'ok' $null ([ordered]@{ status = $ps })
  $l = Invoke-Elevated 'launcher' @('-Launcher', [string]$lch['path'], '-LauncherSha256', [string]$lch['sha256'], '-ExpectedOperatorSid', $operator) $LauncherLimitSeconds
  if ($l.declined) { Stop-Bootstrap 'launcher' 'UAC_DECLINED' ([ordered]@{ note = 'the launcher did not run; run the same command again'; cleanup = (& $clear 'launcher declined') }) }
  $ls = [string](Get-Key $l.last 'status')
  # M4: a first install is done only with the companion switch passed (Get-LauncherVerdict)
  $v = Get-LauncherVerdict $firstInstall $l.last
  Out-LauncherVerdict $v ([ordered]@{ firstInstall = $firstInstall; prepare = $ps; launcher = $ls; companionSwitch = $v.companionSwitch; next = $v.next
    residueUnchecked = (Get-Key $pr.last 'residueUnchecked'); exit = $l.exit; output = $l.output })
  if ($v.status -cne 'BOOTSTRAP_DONE') { exit 1 }
}

$script:Work = $null; $script:Self = $null; $script:ParentArgs = @()
if ($MyInvocation.InvocationName -ne '.') { if ($Stage) { Invoke-Stage } else { Invoke-Bootstrap } }
