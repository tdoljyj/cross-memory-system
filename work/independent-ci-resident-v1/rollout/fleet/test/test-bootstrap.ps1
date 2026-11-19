<#
  Offline check of rollout/fleet/bootstrap.ps1's pure functions (the asset set and its sums files, the prerequisite manifest, the
  elevated command and the UAC refusal). Nothing on the host is read or changed; the functions are taken from the real script by AST.
    powershell -NoProfile -ExecutionPolicy Bypass -File test-bootstrap.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions   # JavaScriptSerializer (Windows PowerShell 5.1 does not load it by itself)
$here = $PSScriptRoot
$script:n = 0
# Every failed check is named (a failure does not hide the checks after it); the run fails at the end when any did.
$script:failures = New-Object Collections.Generic.List[string]
function Yes([bool]$ok, [string]$what) { if (-not $ok) { $script:failures.Add($what) } else { $script:n++ } }
function Throws([scriptblock]$b, [string]$like, [string]$what) { $m = $null; try { & $b } catch { $m = $_.Exception.Message }; Yes ($null -ne $m -and $m -like $like) ($what + ' (got: ' + $m + ')') }
# A group of checks whose code may not exist yet: an exception fails the group by name, the run goes on.
function Case([string]$what, [scriptblock]$b) { try { & $b } catch { $script:failures.Add($what + ' (threw: ' + $_.Exception.Message + ')') } }

$file = Join-Path (Split-Path -Parent $here) 'bootstrap.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:bootstrap.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @('Get-Key', 'Read-Sha256Sums', 'Get-ReleaseVersion', 'Get-RequiredAssets', 'Test-AssetSet', 'Test-PrereqManifest', 'Get-LastJsonLine', 'Get-ElevatedArguments', 'Test-UacDeclined',
    'Test-SafePath', 'Test-SafeArgument', 'Get-ExtractState', 'Get-StageFailure', 'Test-StageOperator', 'Test-CredentialsToClear',
    'Sha256File', 'Invoke-StageChild', 'Test-ParentAlive', 'Clear-CredentialDirectory', 'Test-FirstInstallCheck', 'Copy-ToWork', 'Test-UnderDirectory', 'Get-LauncherVerdict',
    'Get-NeededPrereqs', 'Expand-Cached', 'ConvertTo-PlainData', 'ConvertTo-JsonLine', 'Out-Result')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); if ($functions.ContainsKey($name)) { . ([scriptblock]::Create($functions[$name])) }
}
# the constants the functions read, from the script itself
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$PrereqContract', '$PrereqNames', '$PowerShellExe', '$WorkParent')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
Yes ($PrereqContract -ceq 'clued.independent-ci.fleet-node-prereq-manifest/1' -and $PrereqNames.Count -eq 7 -and $PrereqNames -ccontains 'wsl') 'constants'
$text = [IO.File]::ReadAllText($file)
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue   # reads lines longer than the default 2,097,152
$h1 = 'a' * 64; $h2 = 'b' * 64; $h3 = 'c' * 64; $img = 'd' * 64
$v = '2026.11.16-1'; $t = 'fleet-node-' + $v

# ---- sums files
$s = Read-Sha256Sums ("$h1  $t.tar`r`n$h2  $t.release.json`n")
Yes ($s.Count -eq 2 -and $s["$t.tar"] -ceq $h1 -and $s["$t.release.json"] -ceq $h2) 'sums:crlf-and-lf'
Throws { Read-Sha256Sums "$h1  a`n$h2  a`n" } 'BOOTSTRAP_SUMS_DUPLICATE:*' 'sums:duplicate'
Throws { Read-Sha256Sums "$h1  sub/a`n" } 'BOOTSTRAP_SUMS_REFUSED:*' 'sums:path-refused'
Throws { Read-Sha256Sums (('A' * 64) + "  a`n") } 'BOOTSTRAP_SUMS_REFUSED:*' 'sums:upper-hex-refused'
Throws { Read-Sha256Sums "$h1 a`n" } 'BOOTSTRAP_SUMS_REFUSED:*' 'sums:one-blank-refused'

# ---- the version, the asset set
Yes ((Get-ReleaseVersion @("$t.tar", "$t.release.json", 'SHA256SUMS')) -ceq $v) 'version'
Throws { Get-ReleaseVersion @('SHA256SUMS') } 'BOOTSTRAP_NOT_ONE_ARCHIVE:0' 'version:none'
Throws { Get-ReleaseVersion @("$t.tar", 'fleet-node-2026.11.16-2.tar') } 'BOOTSTRAP_NOT_ONE_ARCHIVE:2' 'version:two'
$release = [ordered]@{ "$t.tar" = $h1; "$t.release.json" = $h2; "$t.bootstrap.ps1" = $h3; "$t.prereq-manifest.json" = $h1 }
$reinstall = @("$t.tar", "$t.release.json", 'SHA256SUMS', "$t.bootstrap.ps1", "$t.prereq-manifest.json", "$t.acceptance.json")
Yes ((Test-AssetSet $reinstall $release $null $v $false @()).Count -eq 0) 'assets:reinstall-complete'
$c = Test-AssetSet ($reinstall + 'notes.txt') $release $null $v $false @()
Yes ($c.Count -eq 1 -and $c[0] -ceq 'ASSET_NOT_LISTED:notes.txt') 'assets:unlisted-file-refused'
$c = Test-AssetSet ($reinstall | Where-Object { $_ -cne "$t.bootstrap.ps1" }) $release $null $v $false @()
Yes ($c -ccontains "ASSET_LISTED_NOT_PRESENT:$t.bootstrap.ps1" -and $c -ccontains "ASSET_REQUIRED_MISSING:$t.bootstrap.ps1") 'assets:listed-missing-refused'
$c = Test-AssetSet ($reinstall | Where-Object { $_ -cne "$t.acceptance.json" }) $release $null $v $false @()
Yes ($c.Count -eq 1 -and $c[0] -ceq "ASSET_REQUIRED_MISSING:$t.acceptance.json") 'assets:acceptance-required'
Yes ((Test-AssetSet ($reinstall + 'node-v24.21.0-win-x64.zip') $release $null $v $false @('node-v24.21.0-win-x64.zip')).Count -eq 0) 'assets:a-prerequisite-may-lie-there'
$c = Test-AssetSet $reinstall $release $null $v $true @()
Yes ($c -ccontains "ASSET_REQUIRED_MISSING:$t.first-install-kit.json" -and $c -ccontains "ASSET_REQUIRED_MISSING:$t.first-install.SHA256SUMS") 'assets:first-install-needs-the-kit'
$first = [ordered]@{ "$t.first-install-kit.json" = $h2; "role-image-$img.tar.gz" = $h3 }
$all = $reinstall + @("$t.first-install-kit.json", "role-image-$img.tar.gz", "$t.first-install.SHA256SUMS")
Yes ((Test-AssetSet $all $release $first $v $true @()).Count -eq 0) 'assets:first-install-complete'
$c = Test-AssetSet ($all | Where-Object { $_ -cne "role-image-$img.tar.gz" }) $release $first $v $true @()
Yes ($c.Count -eq 1 -and $c[0] -ceq "ASSET_LISTED_NOT_PRESENT:role-image-$img.tar.gz") 'assets:image-missing-refused'
$bad = [ordered]@{ "$t.first-install-kit.json" = $h2; "role-image-$img.tar.gz" = $h3; "$t.tar" = $h1 }
$c = Test-AssetSet $all $release $bad $v $true @()
Yes ($c -ccontains "ASSET_IN_BOTH_SUMS:$t.tar" -and $c -ccontains "FIRST_INSTALL_SUMS_NAMES_OTHER:$t.tar") 'assets:first-sums-names-only-kit-and-images'
$rel2 = [ordered]@{}; foreach ($k in @($release.Keys)) { $rel2[$k] = $release[$k] }; $rel2["role-image-$img.tar.gz"] = $h3
$c = Test-AssetSet $all $rel2 $null $v $true @()
Yes ($c -ccontains "RELEASE_SUMS_NAMES_FIRST_INSTALL_ASSET:role-image-$img.tar.gz") 'assets:release-sums-never-names-an-image'

# ---- the prerequisite manifest: the committed one pins what the drill VM proved (WSL MSI, rootfs, the 16 docker .debs) and refuses
#      the rest until the coordinator pins it (M6, M7)
$committed = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
$c = Test-PrereqManifest $committed
$unpinned = @($c | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' } | ForEach-Object { $_.Substring(18) } | Sort-Object)
Yes ($c.Count -eq 0 -and @($committed['items'] | Where-Object { [string]$_['sha256'] -cnotmatch '^[0-9a-f]{64}$' -or -not ($_['bytes'] -gt 0) -or [string]::IsNullOrEmpty([string]$_['url']) }).Count -eq 0) ('prereq:committed-pins-every-item ' + ($c -join ','))
$wslItem = @($committed['items'] | Where-Object { $_['name'] -ceq 'wsl' })[0]
Yes ($wslItem['sha256'] -ceq 'a3505a50f4cc585551d11d9de824ba4375448d7a68f2e71d3fb315fa986fc754' -and $wslItem['version'] -ceq '2.7.13.0' -and $wslItem['kind'] -ceq 'msi') 'prereq:wsl-msi-pinned'
Yes (@($committed['debs']).Count -eq 16 -and @($committed['debs'] | Where-Object { [string]$_['sha256'] -cnotmatch '^[0-9a-f]{64}$' }).Count -eq 0 -and @($committed['debs'] | Where-Object { $_['package'] -ceq 'docker.io' }).Count -eq 1) 'prereq:16-debs-pinned'
Yes ($null -eq (Get-Key $committed 'aptPins')) 'prereq:no-apt-resolution'
# Measured from the pinned ZIPs, including directory entries and the archive's top-level directory (DESK, 2026-11-17).
# Capture the real extraction destination before any I/O: this checks Windows' default path budget even on a long-path-enabled host.
Case 'cache:default-Windows-path-budget' {
  $measured = @{ node = 125; python = 20; git = 64; 'actions-runner' = 61 }
  function Get-ExtractState([string]$dir, [string]$sourceSha256) { 'absent' }
  function Expand-Archive([string]$LiteralPath, [string]$DestinationPath) { $script:cacheDestination = $DestinationPath; throw 'CACHE_PATH_CAPTURED' }
  foreach ($i in @($committed['items'] | Where-Object { $_['kind'] -ceq 'zip' })) {
    $name = [string]$i['name']; $max = Get-Key $i 'maxEntryPathLength'
    Yes ($measured.ContainsKey($name) -and $max -eq $measured[$name]) ('cache:measured-max-entry:' + $name)
    $script:cacheDestination = $null
    Throws { Expand-Cached 'not-read.zip' $name ([string]$i['sha256']) $measured[$name] } 'CACHE_PATH_CAPTURED' ('cache:capture:' + $name)
    $dest = [string]$script:cacheDestination
    Yes ($dest.Length -gt 0 -and $dest.Length + 1 + $measured[$name] -le 259) ('cache:default-path-at-most-259:' + $name + ':' + ($dest.Length + 1 + $measured[$name]))
    $prefix = Join-Path (Join-Path $WorkParent 'tools') ($name + '-' + ([string]$i['sha256']).Substring(0, 16))
    Yes ($dest -cmatch ('^' + [regex]::Escape($prefix) + '\.p-[0-9a-f]{8}$')) ('cache:short-destination:' + $name)
  }
}
function New-Pinned {
  $m = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
  foreach ($i in @($m['items'])) { if ($null -eq $i['sha256']) { $i['sha256'] = 'e' * 64; $i['bytes'] = 12345 }; if ($null -eq $i['url']) { $i['url'] = 'https://example.invalid/' + $i['fileName'] } }
  $m
}
$m = New-Pinned
Yes ((Test-PrereqManifest $m).Count -eq 0) ('prereq:pinned-passes ' + ((Test-PrereqManifest $m) -join ','))
foreach ($bad in @($null, 0, -1, 1.5, '125', $true, 2147483648L)) {
  $m = New-Pinned; $m['items'][0]['maxEntryPathLength'] = $bad
  Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:node') ('prereq:invalid-zip-max-entry:' + $bad)
}
$m = New-Pinned; [void]$m['items'][0].Remove('maxEntryPathLength')
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:node') 'prereq:missing-zip-max-entry'
$m = New-Pinned; $m['items'][0]['sha256'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:node') 'prereq:null-sha-refused'
$m = New-Pinned; $m['items'][1]['bytes'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:python') 'prereq:null-bytes-refused'
$m = New-Pinned; $m['items'][2]['url'] = 'http://insecure.example/x.zip'
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_URL:git') 'prereq:https-only'
$m = New-Pinned; $m['items'] = @($m['items'] | Select-Object -Skip 1)
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ITEM_NOT_ONCE:node') 'prereq:every-item'
$m = New-Pinned; $m['debs'][3]['sha256'] = $null
Yes ((Test-PrereqManifest $m) -ccontains ('PREREQ_NOT_PINNED:deb:' + $m['debs'][3]['package'])) 'prereq:a-deb-unpinned'
$m = New-Pinned; $m['debs'] = @()
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_DEBS_SHAPE') 'prereq:debs-required'
$m = New-Pinned; $m['debs'][0]['fileName'] = '../x.deb'
Yes ((Test-PrereqManifest $m) -ccontains ('PREREQ_DEB_FILE_NAME:' + $m['debs'][0]['package'])) 'prereq:deb-file-name'
$m = New-Pinned; @($m['items'] | Where-Object { $_['name'] -ceq 'wsl' })[0]['version'] = 'latest'
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_WSL_VERSION') 'prereq:wsl-version-exact'
Yes ((Test-PrereqManifest @{ contract = 'x' }) -ccontains 'PREREQ_MANIFEST_SHAPE') 'prereq:contract'

# ---- the last JSON line, the elevated command, the declined UAC
Yes ((Get-LastJsonLine "noise`r`n{`"status`":`"A`"}`r`n`r`n")['status'] -ceq 'A') 'last-json'
Yes ($null -eq (Get-LastJsonLine "{`"status`":`"A`"}`nnot json")) 'last-json:not-json'
Yes ($null -eq (Get-LastJsonLine '')) 'last-json:empty'
# M3: an elevated run is -File with its arguments one by one, each inside the whitelist: no value ever becomes code
$self = 'C:\ProgramData\CluedBootstrap\abc\fleet-node-1.bootstrap.ps1'
$ea = Get-ElevatedArguments $self @('-Stage', 'host', '-Tar', 'C:\x\fleet-node-1.tar', '-ArchiveSha256', ('a' * 64), '-ExpectedOperatorSid', 'S-1-5-21-1-2-3-1000')
Yes ((@($ea) -join ' ') -ceq ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $self + ' -Stage host -Tar C:\x\fleet-node-1.tar -ArchiveSha256 ' + ('a' * 64) + ' -ExpectedOperatorSid S-1-5-21-1-2-3-1000')) 'elevated:file-and-arguments'
foreach ($bad in @("C:\x';calc;'", 'C:\a b\x.tar', 'C:\x\..\y', '\\server\share\x', 'C:\x\', '$(calc)', 'C:\x"y', '-Stage host')) {
  Throws { Get-ElevatedArguments $self @('-Tar', $bad) } 'BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:*' ('elevated:refused ' + $bad)
}
Throws { Get-ElevatedArguments 'C:\a b\x.ps1' @() } 'BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:*' 'elevated:script-path-refused'
Yes ((Test-SafePath 'C:\ProgramData\CluedBootstrap\x.y_z-1') -and -not (Test-SafePath 'C:\a b') -and -not (Test-SafePath 'C:\x\..\y') -and -not (Test-SafePath 'C:\x\') -and -not (Test-SafePath 'x\y')) 'safe-path'
Yes ((Test-SafeArgument ('a' * 64)) -and (Test-SafeArgument 'S-1-5-21-1-2-3-1000') -and (Test-SafeArgument 'host') -and -not (Test-SafeArgument '') -and -not (Test-SafeArgument 'a;b')) 'safe-argument'
Yes ($text -notmatch 'EncodedCommand' -and $text -notmatch '\[scriptblock\]::Create\(') 'elevated:no-code-built-from-values'
# M2: the accepted inputs are checked non-elevated (install.mjs first-install-check) before the first UAC; P1 gets their pins from it
$main = $text.Substring($text.IndexOf('function Invoke-Bootstrap'))
Yes ($main.IndexOf('first-install-check') -gt 0 -and $main.IndexOf('first-install-check') -lt $main.IndexOf("Invoke-Elevated 'host'")) 'm2:check-before-uac-1'
foreach ($p in @("'-KitSha256', [string]`$chk['kitSha256']", "'-ToolchainNodeSha256', [string]`$chk['toolchainNodeSha256']", "'-RegistrarSha256', [string]`$chk['registrarSha256']", "'-ExpectedOperatorSid', `$operator")) { Yes ($main.Contains($p)) ('m2/m4:host-argument ' + $p) }
Yes ($text -notmatch 'CompanionTaskRegistrar\.cs') 'l2:registrar-pin-not-computed-here'
# M4: the elevated stage refuses another account than the one that started the bootstrap
Yes ($null -eq (Test-StageOperator 'S-1-5-21-1-2-3-1000' 'S-1-5-21-1-2-3-1000')) 'm4:same-operator'
Yes ((Test-StageOperator 'S-1-5-21-1-2-3-1009' 'S-1-5-21-1-2-3-1000') -ceq 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR') 'm4:uac-switched-account'
# L1: an extraction is complete only with its marker naming the source's sha256; anything else is set aside and done again
$tmpx = Join-Path ([IO.Path]::GetTempPath()) ('bootstrap-x-' + [Guid]::NewGuid().ToString('N'))
try {
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'absent') 'l1:absent'
  [void][IO.Directory]::CreateDirectory($tmpx); [IO.File]::WriteAllText((Join-Path $tmpx 'half.txt'), 'x')
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'incomplete') 'l1:no-marker'
  [IO.File]::WriteAllText((Join-Path $tmpx '.bootstrap-complete'), ('b' * 64))
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'incomplete') 'l1:other-source'
  [IO.File]::WriteAllText((Join-Path $tmpx '.bootstrap-complete'), ('a' * 64))
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'complete') 'l1:complete'
} finally { Remove-Item -LiteralPath $tmpx -Recurse -Force -ErrorAction SilentlyContinue }
Case 'cache:expansion-budget-and-full-hash-integrity' {
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $WorkParent = [IO.Path]::GetFullPath((Join-Path $tempParent ('cache-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))))
  $script:cacheExpansions = 0
  function Expand-Archive([string]$LiteralPath, [string]$DestinationPath) {
    $script:cacheExpansions++; $script:cacheDestination = $DestinationPath
    [void][IO.Directory]::CreateDirectory($DestinationPath)
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'payload.txt'), 'extracted')
  }
  try {
    $expected = Join-Path (Join-Path $WorkParent 'tools') ('node-' + $h1.Substring(0, 16))
    $budget = 259 - ($expected.Length + '.p-12345678'.Length + 1)
    $dir = Expand-Cached 'not-read.zip' 'node' $h1 $budget
    Yes ($dir -ceq $expected -and $script:cacheDestination.Length + 1 + $budget -eq 259) 'cache:259-accepted'
    Yes (([IO.File]::ReadAllText((Join-Path $dir '.bootstrap-complete'))) -ceq $h1) 'cache:marker-is-full-sha256'
    Yes ((Expand-Cached 'not-read.zip' 'node' $h1 $budget) -ceq $dir -and $script:cacheExpansions -eq 1) 'cache:complete-reused'
    Throws { Expand-Cached 'not-read.zip' 'node' $h1 ($budget + 1) } 'TOOL_CACHE_PATH_TOO_LONG:*' 'cache:260-refused-before-reuse-or-extraction'
    Yes ($script:cacheExpansions -eq 1 -and (Get-ExtractState $dir $h1) -ceq 'complete') 'cache:overlong-has-no-side-effects'
    $collision = $h1.Substring(0, 16) + ('b' * 48)
    Yes ((Get-ExtractState $dir $collision) -ceq 'incomplete') 'cache:same-prefix-different-full-sha-incomplete'
    $again = Expand-Cached 'not-read.zip' 'node' $collision $budget
    Yes ($again -ceq $dir -and $script:cacheExpansions -eq 2 -and (Get-ExtractState $dir $collision) -ceq 'complete') 'cache:collision-reexpanded'
    $aside = @(Get-ChildItem -LiteralPath (Split-Path -Parent $dir) -Directory | Where-Object { $_.FullName -cne $dir })
    Yes ($aside.Count -eq 1 -and (Get-ExtractState $aside[0].FullName $h1) -ceq 'complete') 'cache:previous-extraction-preserved'
    Throws { Expand-Cached 'not-read.zip' 'python' $h2 } 'PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:python' 'cache:missing-bound-refused'
  } finally {
    if (-not $WorkParent.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or $WorkParent -ceq $tempParent) { throw 'CACHE_TEST_CLEANUP_OUTSIDE_TEMP' }
    Remove-Item -LiteralPath $WorkParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
# L4: a terminating exception of a stage keeps its message in the result
$sf = Get-StageFailure 'host' (New-Object InvalidOperationException('ARCHIVE_CHANGED_BEFORE_ELEVATION'))
Yes ($sf['status'] -ceq 'BOOTSTRAP_STAGE_FAILED' -and $sf['stage'] -ceq 'host' -and $sf['message'] -ceq 'ARCHIVE_CHANGED_BEFORE_ELEVATION' -and $sf['type'] -ceq 'System.InvalidOperationException') 'l4:message-kept'
$stageBody = $text.Substring($text.IndexOf('function Invoke-Stage '))
$stageBody = $stageBody.Substring(0, $stageBody.IndexOf("`nfunction "))
Yes ($stageBody -match 'finally' -and $stageBody -match 'Get-StageFailure' -and $stageBody -match 'Remove-Item -LiteralPath \$stageDir') 'l4:stage-cleans-its-copies'
# L3: the token directory is cleared on every end except a host preparation that left it for the launcher
Yes ((Test-CredentialsToClear 'host' 'FIRST_INSTALL_HOST_READY') -eq $false) 'l3:host-ready-keeps-them-for-the-launcher'
foreach ($st in @('FIRST_INSTALL_HOST_REFUSED', 'BOOTSTRAP_STAGE_FAILED', $null, 'RESTART_THEN_RUN_THE_SAME_COMMAND')) { Yes ((Test-CredentialsToClear 'host' $st) -eq $true) ('l3:host-end-clears ' + $st) }
foreach ($st in @('R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', 'STOPPED', $null)) { Yes ((Test-CredentialsToClear 'launcher' $st) -eq $true) ('l3:launcher-end-clears ' + $st) }
Yes ((Test-CredentialsToClear 'cleanup' $null) -eq $true) 'l3:cleanup'
Yes ($main -match "Invoke-Elevated 'cleanup'") 'l3:a-failed-prepare-or-declined-launcher-clears-them'
Yes (Test-UacDeclined (New-Object InvalidOperationException('x', (New-Object ComponentModel.Win32Exception(1223))))) 'uac:declined'
Yes (-not (Test-UacDeclined (New-Object ComponentModel.Win32Exception(2)))) 'uac:other-error'

# ---- independent review of 29c53c38c (REPORT-api-review-first-install.md)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('bootstrap-review-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($tmp)
$evidence = [ordered]@{}
try {
  # H1: the elevated stage reads its child (P1, the launcher) with stdout and stderr apart. Under $ErrorActionPreference = 'Stop' a line
  # on stderr must neither end the stage nor lose the child's verdict: the launcher prints its terminal and then throws (Stop-Launch).
  $child = Join-Path $tmp 'child.ps1'
  [IO.File]::WriteAllText($child, "param([switch]`$RunApprovedInstall, [switch]`$Grandchild)`r`n`$ErrorActionPreference = 'Stop'`r`n" +
    "[Console]::Error.WriteLine('noise on stderr')`r`n" +
    "if (`$Grandchild) { `$null = cmd.exe /c 'echo grandchild-stderr 1>&2'; '{`"status`":`"FIRST_INSTALL_HOST_READY`"}'; exit 0 }`r`n" +
    "'{`"status`":`"STOPPED`",`"code`":`"LINUX_PHASE_B_NOT_COMPLETED`"}'`r`nthrow 'Stop-Launch: LINUX_PHASE_B_NOT_COMPLETED'`r`n", (New-Object Text.UTF8Encoding($false)))
  $childArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $child)
  Case 'h1:a-launcher-that-stops-keeps-its-terminal' {
    $r = Invoke-StageChild $PowerShellExe ($childArgs + '-RunApprovedInstall') 300
    Yes ($r.exit -eq 1 -and [string](Get-Key $r.last 'status') -ceq 'STOPPED' -and [string](Get-Key $r.last 'code') -ceq 'LINUX_PHASE_B_NOT_COMPLETED') ('h1:terminal-kept exit=' + $r.exit + ' last=' + (ConvertTo-Json $r.last -Compress))
    Yes ([string]$r.stderr -match 'Stop-Launch: LINUX_PHASE_B_NOT_COMPLETED' -and [string]$r.stderr -match 'noise on stderr') ('h1:stderr-kept-apart ' + $r.stderr)
    Yes ([string]$r.stdout -notmatch 'noise on stderr') 'h1:stdout-is-only-stdout'
  }
  Case 'h1:a-grandchild-on-stderr-does-not-end-the-host-stage' {
    $r = Invoke-StageChild $PowerShellExe ($childArgs + '-Grandchild') 300
    Yes ($r.exit -eq 0 -and [string](Get-Key $r.last 'status') -ceq 'FIRST_INSTALL_HOST_READY') ('h1:grandchild exit=' + $r.exit + ' stdout=' + $r.stdout + ' stderr=' + $r.stderr)
  }
  Case 'h1:the-stages-never-merge-stderr-into-the-verdict' {
    Yes ($stageBody -notmatch '2>&1') 'h1:no-2>&1-in-Invoke-Stage'
    Yes (([regex]::Matches($stageBody, 'Invoke-StageChild \$PowerShellExe')).Count -eq 2) 'h1:host-and-launcher-through-Invoke-StageChild'
  }
  # what the pattern H1 replaced does on this host (recorded for the report, not a check): `& powershell -File <child> 2>&1` under Stop
  $old = $null
  try { $ErrorActionPreference = 'Stop'; $o = & $PowerShellExe @($childArgs + '-RunApprovedInstall') 2>&1 | ForEach-Object { [string]$_ }; $old = 'no exception; lines=' + @($o).Count }
  catch { $old = 'threw ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message }
  $evidence['oldPatternLauncherStop'] = $old

  # H2: the host stage keeps the token directory for the launcher only while the bootstrap that started it still waits for it; it
  # sweeps one an earlier run left before P1 runs.
  Case 'h2:ready-but-the-bootstrap-gone-clears' {
    Yes ((Test-CredentialsToClear 'host' 'FIRST_INSTALL_HOST_READY' $false) -eq $true) 'h2:parent-gone-clears'
    Yes ((Test-CredentialsToClear 'host' 'FIRST_INSTALL_HOST_READY' $true) -eq $false) 'h2:parent-waiting-keeps'
    Yes ((Test-CredentialsToClear 'host' 'FIRST_INSTALL_HOST_REFUSED' $true) -eq $true) 'h2:refused-clears'
  }
  Case 'h2:the-parent-is-known-by-pid-and-start-time' {
    $me = Get-Process -Id $PID
    Yes (Test-ParentAlive $PID $me.StartTime.ToUniversalTime().Ticks) 'h2:alive'
    Yes (-not (Test-ParentAlive $PID ($me.StartTime.ToUniversalTime().Ticks + 1))) 'h2:pid-reused-is-not-the-parent'
    Yes (-not (Test-ParentAlive 0 0)) 'h2:no-parent'
  }
  Case 'h2:a-left-directory-is-swept' {
    $cd = Join-Path $tmp 'credentials'; [void][IO.Directory]::CreateDirectory($cd); [IO.File]::WriteAllText((Join-Path $cd 'resident-upgrade.token'), 'x')
    $c = Clear-CredentialDirectory $cd
    Yes ($c.existed -eq $true -and $c.cleared -eq $true -and -not [IO.Directory]::Exists($cd)) 'h2:swept'
    $c = Clear-CredentialDirectory $cd
    Yes ($c.existed -eq $false -and $c.cleared -eq $true) 'h2:nothing-there'
  }
  Case 'h2:the-host-stage-sweeps-first-and-knows-its-parent' {
    $hostPart = $stageBody.Substring($stageBody.IndexOf("if (`$Stage -ceq 'host')"))
    Yes ($hostPart.IndexOf('Clear-CredentialDirectory') -gt 0 -and $hostPart.IndexOf('Clear-CredentialDirectory') -lt $hostPart.IndexOf('Invoke-StageChild')) 'h2:sweep-before-p1'
    Yes ($stageBody -match 'Test-ParentAlive \$ParentProcessId \$ParentStartTicks') 'h2:stage-checks-the-parent'
    Yes ($main.Contains("'-ParentProcessId'") -and $main.Contains("'-ParentStartTicks'")) 'h2:bootstrap-names-itself'
  }

  # M2: the toolchain's node.exe is the fleet's controller runtime before the first UAC (the check P1 can no longer undo)
  $good = [ordered]@{ status = 'FIRST_INSTALL_INPUTS_ACCEPTED'; archiveSha256 = $h1; kitSha256 = $h2; controllerNodeSha256 = $h3; toolchainNodeSha256 = $img; registrarSha256 = $h1 }
  Case 'm2:the-controller-node-before-uac-1' {
    # (the function returns its codes as one array, as Test-AssetSet: used as it is, never wrapped in @() again)
    Yes ((Test-FirstInstallCheck $good $h1 $h2 $h3).Count -eq 0) 'm2:accepted'
    Yes ((Test-FirstInstallCheck $good $h1 $h2 ('9' * 64)) -ccontains 'CONTROLLER_NODE_NOT_THE_FLEETS') 'm2:node-differs'
    Yes ((Test-FirstInstallCheck $good ('9' * 64) $h2 $h3) -ccontains 'ARCHIVE_NOT_THE_CHECKED') 'm2:archive-differs'
    Yes ((Test-FirstInstallCheck $good $h1 $null $h3) -ccontains 'KIT_NOT_THE_LISTED') 'm2:no-kit'
    $bad = [ordered]@{}; foreach ($k in @($good.Keys)) { $bad[$k] = $good[$k] }; $bad['registrarSha256'] = 'x'
    Yes ((Test-FirstInstallCheck $bad $h1 $h2 $h3) -ccontains 'PIN_SHAPE:registrarSha256') 'm2:pin-shape'
    $hostAt = $main.IndexOf("Invoke-Elevated 'host'")
    Yes ($main.IndexOf('Test-FirstInstallCheck') -gt 0 -and $main.IndexOf('Test-FirstInstallCheck') -lt $hostAt -and $main.IndexOf('Sha256File $nodeExe[0]') -lt $hostAt -and $main.IndexOf('Sha256File $nodeExe[0]') -gt 0) 'm2:checked-before-uac-1'
  }

  # M3: what the elevated stage reads is a local copy in the work directory (an elevated token does not see the user's mapped drives)
  Case 'm3:local-copies-for-the-elevated-stage' {
    $src = Join-Path $tmp 'from'; $wd = Join-Path $tmp 'work'; [void][IO.Directory]::CreateDirectory($src); [void][IO.Directory]::CreateDirectory($wd)
    $a = Join-Path $src 'fleet-node-1.tar'; [IO.File]::WriteAllText($a, 'archive bytes')
    $want = Sha256File $a
    $copy = Copy-ToWork $a $wd $want
    Yes ($copy -ceq (Join-Path $wd 'fleet-node-1.tar') -and (Sha256File $copy) -ceq $want) 'm3:copied-and-held-to-its-hash'
    Throws { Copy-ToWork $a (Join-Path $tmp 'work2') ('0' * 64) } 'LOCAL_COPY_NOT_THE_PINNED:*' 'm3:another-hash-refused'
    Yes ((Test-UnderDirectory $copy $wd) -and -not (Test-UnderDirectory $a $wd) -and -not (Test-UnderDirectory ($wd + 'x\y') $wd)) 'm3:under-the-work-directory'
    $hostArgsAt = $main.IndexOf('$hostArgs = @(')
    $hostArgsText = $main.Substring($hostArgsAt, $main.IndexOf("`n", $main.IndexOf("`n", $hostArgsAt) + 1) - $hostArgsAt)
    Yes ($hostArgsText -notmatch "'-Tar', \`$tar\b" -and $hostArgsText -notmatch "'-PrereqManifest', \`$prereqFile\b") ('m3:host-arguments-are-the-copies ' + $hostArgsText)
    Yes ($main -match 'Copy-ToWork \$tar ' -and $main -match 'Copy-ToWork \$prereqFile ') 'm3:tar-and-manifest-copied'
  }

  # M4: a first install is done only when the M5-b switch moved the distribution to the companion (COMPANION_HEADLESS_QUALIFIED)
  Case 'm4:the-companion-switch-counts-for-a-first-install' {
    $term = { param($s, $c) [ordered]@{ status = $s; companionHeadless = [ordered]@{ ran = $true; status = $c } } }
    Yes ((Get-LauncherVerdict $true (& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_QUALIFIED')).status -ceq 'BOOTSTRAP_DONE') 'm4:first-install-done'
    Yes ((Get-LauncherVerdict $true (& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_FELL_BACK')).status -ceq 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE') 'm4:switch-fell-back'
    Yes ((Get-LauncherVerdict $true ([ordered]@{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' })).status -ceq 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE') 'm4:switch-not-reported'
    Yes ((Get-LauncherVerdict $false (& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_FELL_BACK')).status -ceq 'BOOTSTRAP_DONE') 'm4:a-reinstall-as-before'
    Yes ((Get-LauncherVerdict $true (& $term 'PAUSE_NOT_CONFIRMED' 'COMPANION_HEADLESS_QUALIFIED')).status -ceq 'BOOTSTRAP_LAUNCHER_ENDED') 'm4:not-verified'
    # the launcher prints its terminal with ConvertTo-Json: the switch's status is read from it
    $printed = "x`r`n" + ((& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_FAILED') | ConvertTo-Json -Depth 6)
    Yes ((Get-LauncherVerdict $true (Get-LastJsonLine $printed)).status -ceq 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE') 'm4:read-from-the-printed-terminal'
    Yes ($main -match 'Get-LauncherVerdict \$firstInstall') 'm4:the-bootstrap-uses-it'
  }

  # M6: a node with a resident (the reinstall) fetches and needs pinned only what its path runs: node, python, git; never the rootfs,
  # the WSL package, the runner, the Linux toolchain node or the .debs
  Case 'm6:the-reinstall-takes-only-what-it-needs' {
    Yes (((Get-NeededPrereqs $false) -join ',') -ceq 'node,python,git') 'm6:reinstall-needs'
    Yes (((Get-NeededPrereqs $true) -join ',') -ceq ($PrereqNames -join ',')) 'm6:first-install-needs-all'
    $c = Test-PrereqManifest $committed (Get-NeededPrereqs $false) $false
    $u = @($c | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' } | ForEach-Object { $_.Substring(18) } | Sort-Object)
    Yes ($c.Count -eq 0) ('m6:reinstall-committed-pins-pass ' + ($c -join ','))
    $m = New-Pinned; $m['debs'][0]['sha256'] = $null; foreach ($i in @($m['items'])) { if ($i['name'] -ceq 'wsl') { $i['sha256'] = $null } }
    Yes ((Test-PrereqManifest $m (Get-NeededPrereqs $false) $false).Count -eq 0) 'm6:reinstall-ignores-first-install-pins'
    Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:wsl') 'm6:first-install-still-refuses'
    Yes ($main -match 'Get-NeededPrereqs \$firstInstall' -and $main -match 'if \(\$firstInstall\) \{[^\r\n]*debs') 'm6:the-bootstrap-fetches-by-need'
  }

  # The one JSON writer (Fable ruling 11-19 renew-key section 4.4a; the same defect as first-install-host.ps1, drill 3bc571a6 A1): under
  # Windows PowerShell 5.1 the Work directory (Join-Path, :459) is a string in a PSObject shell, and every Out-Result after it (each
  # refusal, the reset result, RESTART_THEN_RUN_THE_SAME_COMMAND, the final verdict) threw a PSParameterizedProperty circular reference
  # instead of printing its line. Every bootstrap output is progress-grade: never an exception, never a change of control flow (the
  # credential clean-up order stays); a value that is not plain data is printed as its type name.
  Case 'json:out-result-prints-the-work-directory' {
    $saved = Get-Variable -Name Work -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    try {
      $script:Work = Join-Path 'C:\ProgramData\CluedBootstrap' 'abc'
      $line = Out-Result 'BOOTSTRAP_DONE' 'launcher' ([ordered]@{ firstInstall = $true; codes = (@('A', 'B') | Where-Object { $_ }); dir = (Split-Path -Parent 'C:\a\b') })
      $o = $js.DeserializeObject($line)
      Yes ($o['status'] -ceq 'BOOTSTRAP_DONE' -and $o['workDir'] -ceq 'C:\ProgramData\CluedBootstrap\abc' -and (@($o['codes']) -join ',') -ceq 'A,B' -and $o['dir'] -ceq 'C:\a') ('json:done ' + $line)
      $odd = Out-Result 'BOOTSTRAP_REFUSED' 'assets' ([ordered]@{ code = 'X'; detail = (Get-Item -LiteralPath $env:SystemRoot) })
      $o = $js.DeserializeObject($odd)
      Yes ($o['code'] -ceq 'X' -and [string]$o['detail'] -clike '*DirectoryInfo*') ('json:not-plain-is-printed-by-type ' + $odd)
      # Codex review of PR-甲 (blocking 2): a verdict of plain data longer than the serializer's default 2,097,152 characters (the
      # stage child's result is read up to 16,777,216) threw instead of printing; the writer's limit is at least the reader's
      $big = 'x' * 2500000
      $long = Out-Result 'BOOTSTRAP_REFUSED' 'host' ([ordered]@{ code = 'LONG'; detail = $big })
      $o = $js.DeserializeObject($long)
      Yes ($null -ne $o -and $o['code'] -ceq 'LONG' -and ([string]$o['detail']).Length -eq 2500000) ('json:longer-than-2M ' + $(if ($long) { $long.Length } else { 'none' }))
    } finally { $script:Work = $saved }
    $inWriter = [regex]::Matches($functions['ConvertTo-JsonLine'], '\.Serialize\(').Count
    Yes ($inWriter -ge 1 -and ([regex]::Matches($text, '\.Serialize\(')).Count -eq $inWriter) 'json:every-serialize-is-in-the-writer'
    # every output of the bootstrap is the progress grade (it never throws)
    $calls = @([regex]::Matches($text, '(?m)^(?!\s*#).*?ConvertTo-JsonLine [^\r\n]*'))
    Yes (@($calls | Where-Object { $_.Value -notmatch '-Progress\b' }).Count -eq 0) ('json:every-call-is-progress ' + (@($calls | Where-Object { $_.Value -notmatch '-Progress\b' } | ForEach-Object { $_.Value }) -join ' | '))
  }
  # bootstrap.ps1 is downloaded on its own (the first hop) and cannot load a file of the package: the writer is a copy of
  # windows/first-install-host.ps1's, held to it character for character.
  Case 'json:the-same-writer-as-first-install-host' {
    $hostFile = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))) 'windows\first-install-host.ps1'
    $hostAst = [Management.Automation.Language.Parser]::ParseFile($hostFile, [ref]$tokens, [ref]$errors)
    foreach ($name in @('ConvertTo-PlainData', 'ConvertTo-JsonLine')) {
      $theirs = @($hostAst.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $name }, $true))
      Yes ($theirs.Count -eq 1 -and $functions.ContainsKey($name) -and $theirs[0].Extent.Text -ceq $functions[$name]) ('json:same-text:' + $name)
    }
  }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:failures.Count) {
  (New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'BOOTSTRAP_PURE_TESTS_FAILED'; checks = $script:n; failures = @($script:failures); evidence = $evidence })
  exit 1
}
(New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'BOOTSTRAP_PURE_TESTS_PASSED'; checks = $script:n; evidence = $evidence })
