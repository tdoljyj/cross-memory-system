# Guest-only entry. Dot sourcing loads pure helpers only; it never prepares this host.
[CmdletBinding()]
param([string]$From, [string]$Kit, [string]$Fake, [string]$Work, [string]$Version)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Get-EntryProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { return $Object[$Name] }
  $p = $Object.PSObject.Properties[$Name]; if ($null -ne $p) { return $p.Value }; return $null
}

# Bootstrap prints a compact terminal JSON object; tolerate the launcher's indented JSON too.
function Read-FirstInstallTerminal([string]$Text) {
  $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() })
  if (-not $lines.Count) { return $null }
  try { return ($lines[-1] | ConvertFrom-Json) } catch { }
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -ceq '{') { try { return (($lines[$i..($lines.Count - 1)] -join "`n") | ConvertFrom-Json) } catch { return $null } }
  }
  return $null
}

# Pure terminal conversion: a zero exit, missing verdict or partial companion switch never becomes success.
function ConvertTo-FirstInstallEntryResult($Terminal, [int]$ExitCode, [string]$Tree, [string]$Node) {
  $status = [string](Get-EntryProperty $Terminal 'status')
  $code = [string](Get-EntryProperty $Terminal 'code')
  $ok = $ExitCode -eq 0 -and $status -ceq 'BOOTSTRAP_DONE' -and $code -ceq '' -and $Tree -and $Node
  if (-not $ok -and -not $code) {
    $code = if ($null -eq $Terminal -or -not $status) { 'DRILL_BOOTSTRAP_NO_VERDICT' }
      elseif ($status -cne 'BOOTSTRAP_DONE') { $status }
      elseif ($ExitCode -ne 0) { 'DRILL_BOOTSTRAP_EXIT_NONZERO' } else { 'DRILL_BOOTSTRAP_TREE_OR_NODE_MISSING' }
  }
  return [ordered]@{ status = $(if ($ok) { 'FIRST_INSTALL_DONE' } else { 'FIRST_INSTALL_STOPPED' });
    stopCode = $(if ($ok) { $null } else { $code }); tree = $Tree; node = $Node }
}

# Fixed names expected by first-install-host.ps1. These refs are synthetic, registered nowhere.
function ConvertTo-FirstInstallPublic($Public) {
  if ([string](Get-EntryProperty $Public 'contract') -cne 'clued.drill.fake-credentials/1') { throw 'DRILL_FAKE_CONTRACT_REFUSED' }
  foreach ($key in @('ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciPrincipalQualificationRef')) {
    $g = [guid]::Empty
    if (-not [guid]::TryParse([string](Get-EntryProperty $Public $key), [ref]$g) -or $g -eq [guid]::Empty) { throw 'DRILL_FAKE_PUBLIC_REFUSED' }
  }
  return [ordered]@{ appKeyId = (Get-EntryProperty $Public 'appKeyId');
    ciPrincipalBindingId = (Get-EntryProperty $Public 'ciPrincipalBindingId');
    ciPrincipalRoleRef = (Get-EntryProperty $Public 'ciPrincipalRoleRef');
    ciPrincipalQualificationRef = (Get-EntryProperty $Public 'ciPrincipalQualificationRef'); heartbeatBindingId = '' }
}

function Assert-FirstInstallGuest {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $machine = Get-CimInstance Win32_ComputerSystem
  if ($env:COMPUTERNAME -cne 'CLUED-DRILL' -or $machine.Model -cne 'Virtual Machine' -or $machine.Manufacturer -cne 'Microsoft Corporation' -or
      $me.Name.Split('\')[-1] -cne 'drill' -or -not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'DRILL_ENTRY_NOT_THE_ELEVATED_GUEST' }
  if ($From -cne 'C:\drill\from' -or $Kit -cne 'C:\drill\kit' -or $Fake -cne 'C:\drill\fake' -or $Work -cne 'C:\drill\work') { throw 'DRILL_ENTRY_GUEST_PATH_REFUSED' }
}

function Assert-FirstInstallRelease {
  $pins = Get-Content -LiteralPath (Join-Path $Kit 'release-pins.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pins.version -cne $Version) { throw 'DRILL_RELEASE_VERSION_MISMATCH' }
  $seen = @{}
  foreach ($f in $pins.files) {
    if ($f.path -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$' -or $f.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($f.path)) { throw 'DRILL_RELEASE_PINS_REFUSED' }
    $seen[$f.path] = $true
    if ((Get-FileHash -LiteralPath (Join-Path $From $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256) { throw 'DRILL_RELEASE_CHANGED_IN_COPY' }
  }
  if (@(Get-ChildItem -LiteralPath $From -Force).Count -ne $seen.Count) { throw 'DRILL_RELEASE_UNLISTED_ASSET' }
}

# This is the README section 5 exception for CLUED-DRILL only. No accepted file is rewritten.
# Load the accepted bootstrap's helpers, keeping its asset/prerequisite/check/prepare/launcher order.
function Invoke-FirstInstallAccepted([string]$Assets, [string]$Payload, [string]$FakeInputs, [string]$Output, [string]$ReleaseVersion) {
  $bootstrap = Join-Path $Assets "fleet-node-$ReleaseVersion.bootstrap.ps1"
  . $bootstrap -From $Assets
  # Helpers normally terminate the bootstrap process. Here the entry owns the single terminal result and cleanup.
  function Stop-Bootstrap([string]$step, [string]$code, $detail) { throw ($code + $(if ($null -ne $detail) { ':' + (@($detail) -join ',') } else { '' })) }
  # Drill-only stand-in for a package defect being fixed (claude/bootstrap-short-tool-cache): the accepted Expand-Cached names its
  # cache <name>-<sha256>.partial-<guid>, which with node.zip's deepest entry passes MAX_PATH on a default Windows (LongPathsEnabled=0).
  # Same behaviour, shorter names; the full sha256 is still the completion mark. Declared in the kit's perNodeSteps, so A10 cannot pass.
  function Expand-Cached([string]$zip, [string]$name, [string]$sha256) {
    $dir = Join-Path (Join-Path $WorkParent 'tools') ($name + '-' + $sha256.Substring(0, 16))
    $state = Get-ExtractState $dir $sha256
    if ($state -ceq 'complete') { return $dir }
    if ($state -ceq 'incomplete') { [IO.Directory]::Move($dir, $dir + '.i-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')) }
    $partial = $dir + '.p-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    Expand-Archive -LiteralPath $zip -DestinationPath $partial
    [IO.File]::WriteAllText((Join-Path $partial '.bootstrap-complete'), $sha256)
    [IO.Directory]::Move($partial, $dir)
    $dir
  }
  $script:From = $Assets
  $measurements = [ordered]@{ host = $null; prepare = $null; launcher = $null }
  $inputCredentials = Join-Path $Output 'credentials'
  $entryTree = ''; $entryNode = ''; $hostStage = $null
  try {
    if ([IO.File]::Exists($ReceiptFile)) { throw 'DRILL_ENTRY_REQUIRES_FIRST_INSTALL' }
    $prefix = 'fleet-node-' + $ReleaseVersion
    $present = @(Get-ChildItem -LiteralPath $Assets -File -Force | ForEach-Object { $_.Name })
    if ((Get-ReleaseVersion $present) -cne $ReleaseVersion) { throw 'DRILL_RELEASE_VERSION_MISMATCH' }
    $sums = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $Assets 'SHA256SUMS')))
    $firstSums = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $Assets "$prefix.first-install.SHA256SUMS")))
    $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 16777216
    $manifestFile = Join-Path $Assets "$prefix.prereq-manifest.json"
    $manifest = $js.DeserializeObject([IO.File]::ReadAllText($manifestFile))
    $drillPrereqFileNames = @(@($manifest['items']) + @($manifest['debs']) | ForEach-Object { [string]$_['fileName'] })
    $ac = Test-AssetSet $present $sums $firstSums $ReleaseVersion $true $drillPrereqFileNames; $ac = @($ac | ForEach-Object { $_ }); if ($ac.Count) { throw ('ASSET_SET_REFUSED:' + ($ac -join ',')) }
    foreach ($set in @($sums, $firstSums)) {
      foreach ($name in @($set.Keys)) { if ((Sha256File (Join-Path $Assets $name)) -cne $set[$name]) { throw 'ASSET_HASH_MISMATCH' } }
    }
    $pc = Test-PrereqManifest $manifest (Get-NeededPrereqs $true) $true; $pc = @($pc | ForEach-Object { $_ }); if ($pc.Count) { throw ('PREREQ_MANIFEST_REFUSED:' + ($pc -join ',')) }
    $script:Work = Join-Path $WorkParent ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:Work)
    $pre = Join-Path $script:Work 'prereq'; [void][IO.Directory]::CreateDirectory($pre)
    $tools = @{}
    foreach ($item in $manifest['items']) {
      # Prefer the injected, release-pinned WSL/rootfs. Get-Prereq still verifies size and sha256.
      $injected = Join-Path $Payload $item['fileName']
      if ([IO.File]::Exists($injected)) {
        if ((Sha256File $injected) -cne $item['sha256'] -or (Get-Item -LiteralPath $injected).Length -ne $item['bytes']) { throw 'DRILL_PREREQ_CHANGED' }
        $file = Join-Path $pre $item['fileName']; [IO.File]::Copy($injected, $file, $false)
      } else { $file = Get-Prereq $item $pre }
      if (@('node', 'python', 'git') -ccontains [string]$item['name']) { $tools[$item['name']] = Expand-Cached $file $item['name'] $item['sha256'] }
    }
    $debDir = Join-Path $pre 'debs'; [void][IO.Directory]::CreateDirectory($debDir)
    foreach ($item in $manifest['debs']) {
      $file = Join-Path $Payload $item['fileName']
      if ((Sha256File $file) -cne $item['sha256'] -or (Get-Item -LiteralPath $file).Length -ne $item['bytes']) { throw 'DRILL_PREREQ_CHANGED' }
      [IO.File]::Copy($file, (Join-Path $debDir $item['fileName']), $false)
    }
    $nodeFiles = @(Get-ChildItem -LiteralPath $tools['node'] -Recurse -Filter node.exe)
    $pyFiles = @(Get-ChildItem -LiteralPath $tools['python'] -Recurse -Filter python.exe)
    $gitFiles = @(Get-ChildItem -LiteralPath $tools['git'] -Recurse -Filter git.exe | Where-Object { $_.Directory.Name -ceq 'cmd' })
    if ($nodeFiles.Count -ne 1 -or $pyFiles.Count -ne 1 -or $gitFiles.Count -ne 1) { throw 'PREREQ_TOOL_NOT_ONE' }
    $entryNode = $nodeFiles[0].FullName
    $childEnv = @{ PATH = $pyFiles[0].DirectoryName + ';' + $gitFiles[0].DirectoryName + ';' + $nodeFiles[0].DirectoryName + ';C:\Windows\System32;C:\Windows'; PSModulePath = $env:PSModulePath }
    $archive = Join-Path $Assets "$prefix.tar"; $archiveHash = $sums["$prefix.tar"]
    $unpack = Join-Path $script:Work 'x'; [void][IO.Directory]::CreateDirectory($unpack)
    & $TarExe -x -f $archive -C $unpack 'tree' 'universal-manifest.json' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'ARCHIVE_EXTRACT_FAILED' }
    $entryTree = Join-Path $unpack 'tree'
    $fleet = Join-Path $entryTree 'work\independent-ci-resident-v1\rollout\fleet'
    $install = Join-Path $fleet 'install.mjs'; $acceptance = Join-Path $Assets "$prefix.acceptance.json"
    $check = Invoke-NonElevated $entryNode @($install, 'first-install-check', '--artifact', $archive, '--artifact-sha', $archiveHash, '--acceptance', $acceptance, '--from', $Assets) $childEnv
    $pins = $check.last
    if ($check.exit -ne 0 -or (Test-FirstInstallCheck $pins $archiveHash $firstSums["$prefix.first-install-kit.json"] (Sha256File $entryNode)).Count) { throw 'FIRST_INSTALL_INPUTS_NOT_ACCEPTED' }
    # Same local-copy boundary as bootstrap; host gets the accepted archive tree, never a repository tree.
    $hostDir = Join-Path $script:Work 'host-inputs'
    $localArchive = Copy-ToWork $archive $hostDir $archiveHash
    $localManifest = Copy-ToWork $manifestFile $hostDir $sums["$prefix.prereq-manifest.json"]
    foreach ($p in @($localArchive, $pre, $localManifest)) { if (-not (Test-UnderDirectory $p $script:Work)) { throw 'ELEVATED_INPUT_NOT_LOCAL' } }
    $swept = Clear-CredentialDirectory $CredentialDirectory
    if (-not $swept.cleared) { throw 'DRILL_CREDENTIAL_CLEANUP_FAILED' }
    $ds = New-Object Security.AccessControl.DirectorySecurity
    $credentialSddl = 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
    $ds.SetSecurityDescriptorSddlForm($credentialSddl)
    $hostStage = Join-Path 'C:\Windows\Temp' ('clued-drill-host-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($hostStage, $ds)
    $hostArchive = Copy-ToWork $localArchive $hostStage $archiveHash
    & $TarExe -x -f $hostArchive -C $hostStage 'tree' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'ARCHIVE_EXTRACT_FAILED' }
    $hostTree = Join-Path $hostStage 'tree'
    if ([IO.Directory]::Exists($inputCredentials)) { throw 'DRILL_CREDENTIAL_INPUT_ALREADY_EXISTS' }
    [void][IO.Directory]::CreateDirectory($inputCredentials, $ds)
    # Compare as the host preparation does (first-install-host.ps1 Test-SddlIs): owner, protected DACL and the same ACE set; the
    # text form Windows returns is normalized and may differ from the string that set it.
    $actualSddl = [IO.Directory]::GetAccessControl($inputCredentials).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')
    $sameAcl = $false
    try {
      $a = New-Object Security.AccessControl.RawSecurityDescriptor($actualSddl); $w = New-Object Security.AccessControl.RawSecurityDescriptor($credentialSddl)
      $key = { param($ace) ([string]$ace.AceQualifier) + '|' + $ace.SecurityIdentifier.Value + '|' + $ace.AccessMask + '|' + ([int]$ace.AceFlags -band 0x0F) }
      $ak = @(foreach ($x in $a.DiscretionaryAcl) { & $key $x }) | Sort-Object; $wk = @(foreach ($x in $w.DiscretionaryAcl) { & $key $x }) | Sort-Object
      $sameAcl = ($a.Owner.Value -ceq $w.Owner.Value) -and (($a.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) -and ((@($ak) -join ';') -ceq (@($wk) -join ';'))
    } catch { $sameAcl = $false }
    if (-not $sameAcl) { throw ('DRILL_CREDENTIAL_INPUT_ACL_REFUSED:' + $actualSddl) }
    foreach ($pair in @(@('app-key.pem', 'app-private-key.pem'), @('ci-admission.token', 'ci-admission.token'), @('resident-upgrade.token', 'resident-upgrade.token'))) {
      [IO.File]::Copy((Join-Path $FakeInputs $pair[0]), (Join-Path $inputCredentials $pair[1]), $false)
    }
    $public = ConvertTo-FirstInstallPublic (Get-Content -LiteralPath (Join-Path $FakeInputs 'public.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
    [IO.File]::WriteAllText((Join-Path $inputCredentials 'public.json'), ($public | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hostScript = Join-Path $hostTree 'work\independent-ci-resident-v1\windows\first-install-host.ps1'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
      $hostRun = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $hostScript, '-Tree', $hostTree,
        '-PrereqDirectory', $pre, '-PrereqManifest', $localManifest, '-PrereqManifestSha256', $sums["$prefix.prereq-manifest.json"],
        '-KitSha256', $pins['kitSha256'], '-ToolchainNodeSha256', $pins['toolchainNodeSha256'], '-RegistrarSha256', $pins['registrarSha256'],
        '-ExpectedOperatorSid', $operatorSid, '-CredentialDirectory', $inputCredentials) $HostLimitSeconds
    } finally { $measurements.host = $watch.Elapsed.TotalSeconds }
    # The host preparation's whole stdout as it printed it: the step record (drill-vm.ps1 Read-DrillFirstInstallSteps reads steps from the
    # complete stdout logs only; host-result.json below keeps only the tail and is read for its verdict line).
    [IO.File]::WriteAllText((Join-Path $Output 'host.stdout.log'), [string]$hostRun.stdout, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $Output 'host-result.json'), (ConvertTo-JsonLine ([ordered]@{ exit = $hostRun.exit; terminal = $hostRun.last; stdoutTail = $(if ($hostRun.stdout) { $t = [string]$hostRun.stdout; $t.Substring([Math]::Max(0, $t.Length - 6000)) } else { $null }); stderrTail = $(if ($hostRun.stderr) { $t = [string]$hostRun.stderr; $t.Substring([Math]::Max(0, $t.Length - 3000)) } else { $null }) })), (New-Object Text.UTF8Encoding($false)))
    if ([string](Get-Key $hostRun.last 'status') -ceq 'RESTART_THEN_RUN_THE_SAME_COMMAND') { throw 'RESTART_THEN_RUN_THE_SAME_COMMAND' }
    if ($hostRun.exit -ne 0 -or [string](Get-Key $hostRun.last 'status') -cne 'FIRST_INSTALL_HOST_READY') { throw 'HOST_PREPARATION_NOT_DONE' }
    $watch.Restart()
    try { $prepared = Invoke-NonElevated $entryNode @($install, 'prepare', '--artifact', $archive, '--artifact-sha', $archiveHash, '--acceptance', $acceptance, '--work', (Join-Path $script:Work 'prepare'), '--from', $Assets) $childEnv }
    finally { $measurements.prepare = $watch.Elapsed.TotalSeconds }
    $drillLauncher = Get-Key $prepared.last 'launcher'
    if ($prepared.exit -ne 0 -or @('FLEET_NODE_INSTALL_PREPARED', 'FLEET_NODE_FIRST_INSTALL_PREPARED') -cnotcontains [string](Get-Key $prepared.last 'status') -or
        -not (Test-SafePath ([string](Get-Key $drillLauncher 'path'))) -or [string](Get-Key $drillLauncher 'sha256') -cnotmatch '^[0-9a-f]{64}$') { throw 'PREPARE_REFUSED' }
    $launcherResult = Join-Path $script:Work ('elevated-launcher-' + [guid]::NewGuid().ToString('N') + '.txt')
    $watch.Restart()
    try { $launch = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Stage', 'launcher', '-Result', $launcherResult,
      '-Launcher', $drillLauncher['path'], '-LauncherSha256', $drillLauncher['sha256'], '-ExpectedOperatorSid', $operatorSid) $LauncherLimitSeconds }
    finally { $measurements.launcher = $watch.Elapsed.TotalSeconds }
    # the launcher stage's result file is its whole printed output (bootstrap.ps1 -Stage launcher): kept as the launcher's complete log
    if ([IO.File]::Exists($launcherResult)) { [IO.File]::Copy($launcherResult, (Join-Path $Output 'launcher.stdout.log'), $true) }
    $terminal = Get-LastJsonLine ([IO.File]::ReadAllText($launcherResult))
    [IO.File]::WriteAllText((Join-Path $Output 'launcher-result.json'), (ConvertTo-JsonLine ([ordered]@{ source = $launcherResult; exit = $launch.exit; terminal = $terminal })), (New-Object Text.UTF8Encoding($false)))
    $verdict = Get-LauncherVerdict $true $terminal
    return (ConvertTo-FirstInstallEntryResult $verdict $(if ($launch.timedOut -or $null -eq $launch.exit) { 1 } else { [int]$launch.exit }) $entryTree $entryNode)
  } finally {
    [IO.File]::WriteAllText((Join-Path $Output 'stage-timings.json'), ($measurements | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    # Both the injected input and the host's transient token directory die on every end.
    foreach ($directory in @($inputCredentials, $CredentialDirectory)) {
      if (-not (Clear-CredentialDirectory $directory).cleared) { throw 'DRILL_CREDENTIAL_CLEANUP_FAILED' }
    }
    if ($hostStage) {
      $resolved = [IO.Path]::GetFullPath($hostStage)
      if (-not $resolved.StartsWith('C:\Windows\Temp\clued-drill-host-', [StringComparison]::OrdinalIgnoreCase)) { throw 'DRILL_HOST_STAGE_PATH_REFUSED' }
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
}

function Invoke-FirstInstallEntry {
  $tree = ''; $node = ''; $result = $null
  try {
    Assert-FirstInstallGuest
    Assert-FirstInstallRelease
    $result = Invoke-FirstInstallAccepted $From $Kit $Fake $Work $Version
  } catch {
    $code = [string]$_.Exception.Message
    # A code may carry its detail after ':' (the accepted helpers' codes); anything else is an exception whose text is kept, cut short.
    if ($code -cnotmatch '^[A-Z][A-Z0-9_]+(:.*)?$') {
      $text = ($code -replace '\s+', ' ').Trim(); if ($text.Length -gt 400) { $text = $text.Substring(0, 400) }
      $code = 'DRILL_FIRST_INSTALL_ENTRY_EXCEPTION:' + $text + ' @' + [string]$_.InvocationInfo.ScriptLineNumber
    }
    $result = [ordered]@{ status = 'FIRST_INSTALL_STOPPED'; stopCode = $code; tree = $tree; node = $node }
  }
  $result | ConvertTo-Json -Depth 8 -Compress
  if ($result.stopCode) { exit 1 }
}
if ($MyInvocation.InvocationName -ne '.') {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  Invoke-FirstInstallEntry
}
