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
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }
function Throws([scriptblock]$b, [string]$like, [string]$what) { $m = $null; try { & $b } catch { $m = $_.Exception.Message }; Yes ($null -ne $m -and $m -like $like) ($what + ' (got: ' + $m + ')') }

$file = Join-Path (Split-Path -Parent $here) 'bootstrap.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:bootstrap.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @('Get-Key', 'Read-Sha256Sums', 'Get-ReleaseVersion', 'Get-RequiredAssets', 'Test-AssetSet', 'Test-PrereqManifest', 'Get-LastJsonLine', 'Get-ElevatedArguments', 'Test-UacDeclined',
    'Test-SafePath', 'Test-SafeArgument', 'Get-ExtractState', 'Get-StageFailure', 'Test-StageOperator', 'Test-CredentialsToClear')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name]))
}
# the constants the functions read, from the script itself
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$PrereqContract', '$PrereqNames')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
Yes ($PrereqContract -ceq 'clued.independent-ci.fleet-node-prereq-manifest/1' -and $PrereqNames.Count -eq 7 -and $PrereqNames -ccontains 'wsl') 'constants'
$text = [IO.File]::ReadAllText($file)
$js = New-Object Web.Script.Serialization.JavaScriptSerializer
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
Yes (($unpinned -join ',') -ceq 'actions-runner,git,linux-node,node,python' -and @($c | Where-Object { $_ -notlike 'PREREQ_NOT_PINNED:*' }).Count -eq 0) ('prereq:committed-pins-the-drill-set ' + ($c -join ','))
$wslItem = @($committed['items'] | Where-Object { $_['name'] -ceq 'wsl' })[0]
Yes ($wslItem['sha256'] -ceq 'a3505a50f4cc585551d11d9de824ba4375448d7a68f2e71d3fb315fa986fc754' -and $wslItem['version'] -ceq '2.7.13.0' -and $wslItem['kind'] -ceq 'msi') 'prereq:wsl-msi-pinned'
Yes (@($committed['debs']).Count -eq 16 -and @($committed['debs'] | Where-Object { [string]$_['sha256'] -cnotmatch '^[0-9a-f]{64}$' }).Count -eq 0 -and @($committed['debs'] | Where-Object { $_['package'] -ceq 'docker.io' }).Count -eq 1) 'prereq:16-debs-pinned'
Yes ($null -eq (Get-Key $committed 'aptPins')) 'prereq:no-apt-resolution'
function New-Pinned {
  $m = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
  foreach ($i in @($m['items'])) { if ($null -eq $i['sha256']) { $i['sha256'] = 'e' * 64; $i['bytes'] = 12345 }; if ($null -eq $i['url']) { $i['url'] = 'https://example.invalid/' + $i['fileName'] } }
  $m
}
$m = New-Pinned
Yes ((Test-PrereqManifest $m).Count -eq 0) ('prereq:pinned-passes ' + ((Test-PrereqManifest $m) -join ','))
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
'{"status":"BOOTSTRAP_PURE_TESTS_PASSED","checks":' + $script:n + '}'
