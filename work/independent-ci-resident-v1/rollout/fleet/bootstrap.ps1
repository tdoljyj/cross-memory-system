<#
.SYNOPSIS
  The one node entry of the universal node package (Release asset fleet-node-<v>.bootstrap.ps1): first install, reinstall, the same
  command on every node, no node argument.

    powershell -NoProfile -ExecutionPolicy Bypass -File <dir>\fleet-node-<v>.bootstrap.ps1 -From <dir>

.DESCRIPTION
  Run by the Owner in a NORMAL (not elevated) window, with the system's own Windows PowerShell 5.1. <dir> holds one version's Release
  assets (a USB stick, a share, a synced folder: only the hashes count):
    fleet-node-<v>.tar, fleet-node-<v>.release.json, SHA256SUMS, fleet-node-<v>.bootstrap.ps1, fleet-node-<v>.prereq-manifest.json,
    fleet-node-<v>.acceptance.json (the Owner's acceptance; install.mjs prepare validates it as a whole)
    and, for a first install, fleet-node-<v>.first-install-kit.json, role-image-<64hex>.tar.gz (each local role image the kit names)
    and fleet-node-<v>.first-install.SHA256SUMS (over those two kinds; publish.mjs attach-first-install-kit).
  Every file in <dir> must be listed in exactly one of the two sums files with its hash (the acceptance and the two sums files
  themselves excepted); a listed file that is missing, an unlisted file, or a hash that differs refuses before anything else.
  Optional prerequisite downloads may also be in <dir> under their manifest file names (then they are taken from there, by hash).

  Steps, each judged by the last line of JSON of what it ran:
    1. the asset set and every hash (Test-AssetSet, Read-Sha256Sums);
    2. the prerequisite manifest (contract clued.independent-ci.fleet-node-prereq-manifest/1): every item pinned (a null sha256 or
       bytes refuses with PREREQ_NOT_PINNED: nothing is ever fetched unpinned); node, python and git fetched into a new work directory
       C:\ProgramData\CluedBootstrap\<32hex>\ (from <dir> when a file of that name and hash is there, else downloaded) and checked by
       sha256 and size; each zip expanded. The work directory is not under C:\ProgramData\CluedIndependentCI: that folder, its owner and
       ACL are made by the elevated host preparation (first-install-host.ps1), never by this non-elevated process;
    3. the archive's tree/ (Windows' own tar.exe; install.mjs then checks its own bytes against the archive, OWN_MODULES, so the
       extracting tool is not trusted for content);
    4. a node with C:\ProgramData\CluedIndependentCI\resident\install\install-receipt.json: install.mjs prepare (non-elevated, the
       existing arguments), then its runCommand ELEVATED (one UAC);
       a node without it: the host preparation ELEVATED (UAC 1: windows\first-install-host.ps1 run from a copy of the archive the elevated
       process extracted itself into an admin-only directory after checking the archive's sha256), then install.mjs prepare --from <dir>
       (non-elevated), then the runCommand ELEVATED (UAC 2). A Windows feature that needs a restart stops after step 4's first part with
       RESTART_THEN_RUN_THE_SAME_COMMAND: done steps are only checked on the next run.
  A declined UAC prompt is reported as UAC_DECLINED (nothing elevated ran); an elevated run that has not ended within its limit is
  reported as ELEVATED_RUN_STILL_RUNNING (nothing is killed). The elevated child's output goes to a file in the work directory and is
  read back here; this script prints one JSON line at the end: {status, step, code?, detail?, workDir}.
#>
param([string]$From)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions   # JavaScriptSerializer (Windows PowerShell 5.1 does not load it by itself)
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$CiRoot = 'C:\ProgramData\CluedIndependentCI'
$ReceiptFile = 'C:\ProgramData\CluedIndependentCI\resident\install\install-receipt.json'
$WorkParent = 'C:\ProgramData\CluedBootstrap'
$PowerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$TarExe = 'C:\Windows\System32\tar.exe'
$Resident = 'tree/work/independent-ci-resident-v1'
$PrereqContract = 'clued.independent-ci.fleet-node-prereq-manifest/1'
$PrereqNames = @('node', 'python', 'git', 'ubuntu-rootfs', 'actions-runner', 'linux-node')
$AptPackages = @('containerd', 'docker.io', 'git', 'python3.12')
$HostLimitSeconds = 4 * 3600      # P1: Windows features, accounts, the distribution import, docker in it
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
    if ($line -cnotmatch '^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]{0,200})$') { throw ('BOOTSTRAP_SUMS_REFUSED:' + $line) }
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
# The prerequisite manifest: exactly the five items, each pinned (sha256 and bytes), an https URL, a plain file name, a known kind.
# Returns the codes; PREREQ_NOT_PINNED:<name> for an item a coordinator has not pinned yet (the manifest says so in `pending`).
function Test-PrereqManifest($m) {
  $codes = @()
  if ((Get-Key $m 'contract') -cne $PrereqContract -or $null -eq (Get-Key $m 'items')) { return , @('PREREQ_MANIFEST_SHAPE') }
  $names = @()
  foreach ($i in @($m['items'])) {
    if ($i -isnot [Collections.IDictionary]) { $codes += 'PREREQ_ITEM_SHAPE'; continue }
    $name = [string](Get-Key $i 'name'); $names += $name
    if ($PrereqNames -cnotcontains $name) { $codes += ('PREREQ_UNKNOWN_ITEM:' + $name) }
    if ([string](Get-Key $i 'url') -cnotmatch '^https://[A-Za-z0-9.-]+/[^\s"''`]+$') { $codes += ('PREREQ_URL:' + $name) }
    if ([string](Get-Key $i 'fileName') -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$') { $codes += ('PREREQ_FILE_NAME:' + $name) }
    if (@('zip', 'exe', 'tar.gz', 'tar.xz') -cnotcontains [string](Get-Key $i 'kind')) { $codes += ('PREREQ_KIND:' + $name) }
    $b = Get-Key $i 'bytes'
    $pinned = ([string](Get-Key $i 'sha256') -cmatch '^[0-9a-f]{64}$') -and ($b -is [int] -or $b -is [long]) -and [long]$b -gt 0
    if (-not $pinned) { $codes += ('PREREQ_NOT_PINNED:' + $name) }
  }
  foreach ($n in $PrereqNames) { if (@($names | Where-Object { $_ -ceq $n }).Count -ne 1) { $codes += ('PREREQ_ITEM_NOT_ONCE:' + $n) } }
  # the resident distribution's apt packages (linux/first-host-prep.sh): exactly these four, each an exact version
  $apt = Get-Key $m 'aptPins'
  if ($apt -isnot [Collections.IDictionary] -or (@($apt.Keys | Sort-Object) -join ',') -cne ($AptPackages -join ',')) { $codes += 'PREREQ_APT_PINS_SHAPE' }
  else { foreach ($k in $AptPackages) { if ([string]$apt[$k] -cnotmatch '^[A-Za-z0-9.+:~-]{1,100}$') { $codes += ('PREREQ_NOT_PINNED:apt:' + $k) } } }
  , @($codes)
}
# The last non-empty line of a child's output, parsed as JSON (a dictionary), else $null.
function Get-LastJsonLine([string]$text) {
  if ($null -eq $text) { return $null }
  $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { return $null }
  try { $o = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($lines[$lines.Count - 1]) } catch { return $null }
  if ($o -is [Collections.IDictionary]) { $o } else { $null }
}
# The elevated command: a PowerShell scriptblock text, run with -EncodedCommand (no quoting through the shell). It writes every line it
# produces to $resultFile (UTF-8) so the non-elevated caller can read it.
function Get-ElevatedArguments([string]$scriptText, [string]$resultFile) {
  if ($resultFile -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9._\\-]+$') { throw 'BOOTSTRAP_RESULT_PATH_REFUSED' }
  $wrapped = "`$ErrorActionPreference = 'Stop'; & { " + $scriptText + " } *>&1 | ForEach-Object { [string]`$_ } | Out-File -LiteralPath '" + $resultFile + "' -Encoding utf8"
  @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapped)))
}
# True when an exception is the UAC prompt declined (ERROR_CANCELLED 1223), however PowerShell wrapped it.
function Test-UacDeclined($err) {
  $e = $err
  while ($null -ne $e) { if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { return $true }; $e = $e.InnerException }
  $false
}

# ------------------------------------------------------------------ host actions
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); $f = [IO.File]::OpenRead($p); try { (-join ($s.ComputeHash($f) | ForEach-Object { $_.ToString('x2') })) } finally { $f.Dispose(); $s.Dispose() } }
function Out-Result([string]$status, [string]$step, $extra) {
  $r = [ordered]@{ status = $status; step = $step; workDir = $script:Work }
  if ($null -ne $extra) { foreach ($k in @($extra.Keys)) { $r[$k] = $extra[$k] } }
  ((New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize($r))
}
function Stop-Bootstrap([string]$step, [string]$code, $detail) { Out-Result 'BOOTSTRAP_REFUSED' $step ([ordered]@{ code = $code; detail = $detail }); exit 1 }
function Invoke-Elevated([string]$step, [string]$scriptText, [int]$limitSeconds) {
  $result = Join-Path $script:Work ('elevated-' + $step + '-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $p = $null
  try { $p = Start-Process -FilePath $PowerShellExe -ArgumentList (Get-ElevatedArguments $scriptText $result) -Verb RunAs -PassThru -WindowStyle Normal }
  catch { if (Test-UacDeclined $_.Exception) { Stop-Bootstrap $step 'UAC_DECLINED' 'nothing elevated ran; run the same command again to continue' }; throw }
  if (-not $p.WaitForExit($limitSeconds * 1000)) { Stop-Bootstrap $step 'ELEVATED_RUN_STILL_RUNNING' ([ordered]@{ pid = $p.Id; output = $result; note = 'nothing was killed' }) }
  $text = if ([IO.File]::Exists($result)) { [IO.File]::ReadAllText($result) } else { $null }
  [ordered]@{ exit = $p.ExitCode; last = (Get-LastJsonLine $text); output = $result }
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
# One prerequisite into $dest: <From>\<fileName> when it has the pinned hash, else downloaded; checked by sha256 and size either way.
function Get-Prereq($item, [string]$dest) {
  $target = Join-Path $dest $item['fileName']
  $local = Join-Path $From $item['fileName']
  if ([IO.File]::Exists($local) -and (Sha256File $local) -ceq $item['sha256']) { [IO.File]::Copy($local, $target, $false) }
  else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $item['url'] -OutFile $target -UseBasicParsing
  }
  $len = (Get-Item -LiteralPath $target).Length
  if ((Sha256File $target) -cne $item['sha256'] -or $len -ne [long]$item['bytes']) { Stop-Bootstrap 'prereq' 'PREREQ_HASH_MISMATCH' ([ordered]@{ name = $item['name']; bytes = $len }) }
  $target
}

function Invoke-Bootstrap {
  if (-not $From -or -not [IO.Directory]::Exists($From)) { Stop-Bootstrap 'arguments' 'FROM_DIRECTORY_MISSING' $From }
  $script:From = [IO.Path]::GetFullPath($From)
  $id = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-Bootstrap 'arguments' 'RUN_NOT_ELEVATED' 'run this in a normal window: it asks for UAC itself where it must' }
  # 1. the asset set and every hash
  $present = @(Get-ChildItem -LiteralPath $From -File -Force | ForEach-Object { $_.Name })
  $version = try { Get-ReleaseVersion $present } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null }
  $t = 'fleet-node-' + $version
  $firstInstall = -not [IO.File]::Exists($ReceiptFile)
  $sums = try { Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $From 'SHA256SUMS'))) } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null }
  $firstSumsFile = Join-Path $From "$t.first-install.SHA256SUMS"
  $firstSums = if ([IO.File]::Exists($firstSumsFile)) { try { Read-Sha256Sums ([IO.File]::ReadAllText($firstSumsFile)) } catch { Stop-Bootstrap 'assets' ([string]$_.Exception.Message) $null } } else { $null }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $prereqFile = Join-Path $From "$t.prereq-manifest.json"
  $prereqNamesInDir = @()
  if ([IO.File]::Exists($prereqFile)) { try { $prereqNamesInDir = @(Get-Key $js.DeserializeObject([IO.File]::ReadAllText($prereqFile)) 'items' | ForEach-Object { [string](Get-Key $_ 'fileName') }) } catch { $prereqNamesInDir = @() } }
  $codes = Test-AssetSet $present $sums $firstSums $version $firstInstall $prereqNamesInDir
  if ($codes.Count) { Stop-Bootstrap 'assets' 'ASSET_SET_REFUSED' $codes }
  $all = [ordered]@{}; foreach ($k in @($sums.Keys)) { $all[$k] = $sums[$k] }; if ($null -ne $firstSums) { foreach ($k in @($firstSums.Keys)) { $all[$k] = $firstSums[$k] } }
  foreach ($n in @($all.Keys)) { if ((Sha256File (Join-Path $From $n)) -cne $all[$n]) { Stop-Bootstrap 'assets' 'ASSET_HASH_MISMATCH' $n } }
  # 2. the prerequisites
  $m = $js.DeserializeObject([IO.File]::ReadAllText($prereqFile))
  $pc = Test-PrereqManifest $m
  if ($pc.Count) { Stop-Bootstrap 'prereq' $(if (@($pc | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' }).Count) { 'PREREQ_NOT_PINNED' } else { 'PREREQ_MANIFEST_REFUSED' }) $pc }
  if (-not [IO.Directory]::Exists($WorkParent)) { [void][IO.Directory]::CreateDirectory($WorkParent) }
  $script:Work = Join-Path $WorkParent ([Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($script:Work)
  $pre = Join-Path $script:Work 'prereq'; [void][IO.Directory]::CreateDirectory($pre)
  $tools = [ordered]@{}
  foreach ($i in @($m['items'])) {
    $file = Get-Prereq $i $pre
    $tools[$i['name']] = $file
    if ($i['kind'] -ceq 'zip' -and @('node', 'python', 'git') -ccontains [string]$i['name']) {
      $x = Join-Path $script:Work ('tool-' + $i['name']); Expand-Archive -LiteralPath $file -DestinationPath $x
      $tools[$i['name'] + 'Dir'] = $x
    }
  }
  $nodeExe = @(Get-ChildItem -LiteralPath $tools['nodeDir'] -Recurse -Filter node.exe | ForEach-Object { $_.FullName })
  $pyExe = @(Get-ChildItem -LiteralPath $tools['pythonDir'] -Recurse -Filter python.exe | ForEach-Object { $_.FullName })
  $gitExe = @(Get-ChildItem -LiteralPath $tools['gitDir'] -Recurse -Filter git.exe | Where-Object { $_.Directory.Name -ceq 'cmd' } | ForEach-Object { $_.FullName })
  if ($nodeExe.Count -ne 1 -or $pyExe.Count -ne 1 -or $gitExe.Count -ne 1) { Stop-Bootstrap 'prereq' 'PREREQ_TOOL_NOT_ONE' ([ordered]@{ node = $nodeExe.Count; python = $pyExe.Count; git = $gitExe.Count }) }
  $path = (Split-Path -Parent $pyExe[0]) + ';' + (Split-Path -Parent $gitExe[0]) + ';' + (Split-Path -Parent $nodeExe[0]) + ';C:\Windows\System32;C:\Windows'
  # 3. the archive's tree
  $tar = Join-Path $From "$t.tar"
  $x = Join-Path $script:Work 'x'; [void][IO.Directory]::CreateDirectory($x)
  & $TarExe -x -f $tar -C $x 'tree' 'universal-manifest.json'
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap 'unpack' 'ARCHIVE_EXTRACT_FAILED' $LASTEXITCODE }
  $install = Join-Path $x ($Resident.Replace('/', '\') + '\rollout\fleet\install.mjs')
  $acceptance = Join-Path $From "$t.acceptance.json"
  $archiveSha = $sums["$t.tar"]
  $prepareArgs = @($install, 'prepare', '--artifact', $tar, '--artifact-sha', $archiveSha, '--acceptance', $acceptance, '--work', (Join-Path $script:Work 'prepare'))
  # 4. a first install: the host preparation, elevated, from the archive the elevated process checks and extracts itself
  if ($firstInstall) {
    $kit = Join-Path $From "$t.first-install-kit.json"
    $p1 = "`$ErrorActionPreference='Stop'; `$tar='$tar'; `$want='$archiveSha'; " +
      "`$s=[Security.Cryptography.SHA256]::Create(); `$f=[IO.File]::OpenRead(`$tar); try { `$h=-join (`$s.ComputeHash(`$f) | ForEach-Object { `$_.ToString('x2') }) } finally { `$f.Dispose() }; " +
      "if (`$h -cne `$want) { throw 'ARCHIVE_CHANGED_BEFORE_ELEVATION' }; " +
      "`$stage=Join-Path 'C:\Windows\Temp' ('clued-first-install-' + [Guid]::NewGuid().ToString('N')); `$ds=New-Object Security.AccessControl.DirectorySecurity; `$ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'); [void][IO.Directory]::CreateDirectory(`$stage, `$ds); " +
      "Copy-Item -LiteralPath `$tar -Destination (Join-Path `$stage 'a.tar'); " +
      "`$f=[IO.File]::OpenRead((Join-Path `$stage 'a.tar')); try { `$h=-join (`$s.ComputeHash(`$f) | ForEach-Object { `$_.ToString('x2') }) } finally { `$f.Dispose() }; if (`$h -cne `$want) { throw 'ARCHIVE_COPY_CHANGED' }; " +
      "& '$TarExe' -x -f (Join-Path `$stage 'a.tar') -C `$stage 'tree'; if (`$LASTEXITCODE -ne 0) { throw 'ARCHIVE_EXTRACT_FAILED' }; " +
      "& (Join-Path `$stage '" + $Resident.Replace('/', '\') + "\windows\first-install-host.ps1') -Tree (Join-Path `$stage 'tree') -PrereqDirectory '$pre' -PrereqManifest '$prereqFile' -PrereqManifestSha256 '" + $sums["$t.prereq-manifest.json"] + "' -Kit '$kit' -KitSha256 '" + $firstSums["$t.first-install-kit.json"] + "'"
    $h = Invoke-Elevated 'host' $p1 $HostLimitSeconds
    $st = if ($null -ne $h.last -and $h.last.ContainsKey('status')) { [string]$h.last['status'] } else { $null }
    if ($st -ceq 'RESTART_THEN_RUN_THE_SAME_COMMAND') { Out-Result 'RESTART_THEN_RUN_THE_SAME_COMMAND' 'host' ([ordered]@{ detail = $h.last }); exit 3 }
    if ($h.exit -ne 0 -or $st -cne 'FIRST_INSTALL_HOST_READY') { Stop-Bootstrap 'host' 'HOST_PREPARATION_NOT_DONE' ([ordered]@{ exit = $h.exit; last = $h.last; output = $h.output }) }
    $prepareArgs += @('--from', $From)
  }
  # 5. prepare (non-elevated), then its launcher elevated
  $pr = Invoke-NonElevated $nodeExe[0] $prepareArgs @{ PATH = $path; PSModulePath = $env:PSModulePath }
  $ps = if ($null -ne $pr.last -and $pr.last.ContainsKey('status')) { [string]$pr.last['status'] } else { $null }
  if ($pr.exit -ne 0 -or @('FLEET_NODE_INSTALL_PREPARED', 'FLEET_NODE_FIRST_INSTALL_PREPARED') -cnotcontains $ps -or -not $pr.last.ContainsKey('runCommand')) {
    Stop-Bootstrap 'prepare' 'PREPARE_REFUSED' ([ordered]@{ exit = $pr.exit; last = $pr.last; stderr = $pr.stderr })
  }
  $l = Invoke-Elevated 'launcher' ([string]$pr.last['runCommand']) $LauncherLimitSeconds
  $ls = if ($null -ne $l.last -and $l.last.ContainsKey('status')) { [string]$l.last['status'] } else { $null }
  Out-Result $(if ($ls -ceq 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED') { 'BOOTSTRAP_DONE' } else { 'BOOTSTRAP_LAUNCHER_ENDED' }) 'launcher' ([ordered]@{ firstInstall = $firstInstall; prepare = $ps; launcher = $ls; exit = $l.exit; output = $l.output })
  if ($ls -cne 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED') { exit 1 }
}

$script:Work = $null
if ($MyInvocation.InvocationName -ne '.') { Invoke-Bootstrap }
