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
foreach ($name in @('Get-Key', 'Read-Sha256Sums', 'Get-ReleaseVersion', 'Get-RequiredAssets', 'Test-AssetSet', 'Test-PrereqManifest', 'Get-LastJsonLine', 'Get-ElevatedArguments', 'Test-UacDeclined')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name]))
}
# the constants the functions read, from the script itself
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$PrereqContract', '$PrereqNames', '$AptPackages')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
Yes ($PrereqContract -ceq 'clued.independent-ci.fleet-node-prereq-manifest/1' -and $PrereqNames.Count -eq 6 -and $AptPackages.Count -eq 4) 'constants'
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

# ---- the prerequisite manifest: the committed one is honest (nothing pinned yet), a pinned one passes
$committed = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
$c = Test-PrereqManifest $committed
Yes (@($c | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' }).Count -eq 10 -and @($c | Where-Object { $_ -like 'PREREQ_ITEM_NOT_ONCE:*' -or $_ -ceq 'PREREQ_MANIFEST_SHAPE' }).Count -eq 0) ('prereq:committed-refuses-unpinned ' + ($c -join ','))
function New-Pinned {
  $m = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
  foreach ($i in @($m['items'])) { $i['sha256'] = 'e' * 64; $i['bytes'] = 12345; if ($null -eq $i['url']) { $i['url'] = 'https://example.invalid/' + $i['fileName'] } }
  foreach ($k in @($AptPackages)) { $m['aptPins'][$k] = '1.2.3-0ubuntu1' }
  $m
}
$m = New-Pinned
Yes ((Test-PrereqManifest $m).Count -eq 0) 'prereq:pinned-passes'
$m = New-Pinned; $m['items'][0]['sha256'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:node') 'prereq:null-sha-refused'
$m = New-Pinned; $m['items'][1]['bytes'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:python') 'prereq:null-bytes-refused'
$m = New-Pinned; $m['items'][2]['url'] = 'http://insecure.example/x.zip'
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_URL:git') 'prereq:https-only'
$m = New-Pinned; $m['items'] = @($m['items'] | Select-Object -Skip 1)
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ITEM_NOT_ONCE:node') 'prereq:every-item'
$m = New-Pinned; $m['aptPins']['git'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:apt:git') 'prereq:apt-pins'
$m = New-Pinned; $m['aptPins']['curl'] = '1'
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_APT_PINS_SHAPE') 'prereq:apt-pins-exactly-four'
Yes ((Test-PrereqManifest @{ contract = 'x' }) -ccontains 'PREREQ_MANIFEST_SHAPE') 'prereq:contract'

# ---- the last JSON line, the elevated command, the declined UAC
Yes ((Get-LastJsonLine "noise`r`n{`"status`":`"A`"}`r`n`r`n")['status'] -ceq 'A') 'last-json'
Yes ($null -eq (Get-LastJsonLine "{`"status`":`"A`"}`nnot json")) 'last-json:not-json'
Yes ($null -eq (Get-LastJsonLine '')) 'last-json:empty'
$ea = Get-ElevatedArguments "Write-Output 'x'" 'C:\ProgramData\CluedBootstrap\abc\elevated-host.txt'
$decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ea[4]))
Yes ($ea[3] -ceq '-EncodedCommand' -and $decoded.Contains("Write-Output 'x'") -and $decoded.Contains("Out-File -LiteralPath 'C:\ProgramData\CluedBootstrap\abc\elevated-host.txt'")) 'elevated:encoded'
Throws { Get-ElevatedArguments 'x' "C:\a b\r.txt" } 'BOOTSTRAP_RESULT_PATH_REFUSED' 'elevated:path-refused'
Yes (Test-UacDeclined (New-Object InvalidOperationException('x', (New-Object ComponentModel.Win32Exception(1223))))) 'uac:declined'
Yes (-not (Test-UacDeclined (New-Object ComponentModel.Win32Exception(2)))) 'uac:other-error'
# the elevated command, really run (not elevated): its output lands in the result file
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('bootstrap-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($tmp)
try {
  $res = Join-Path $tmp 'out.txt'
  $p = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList (Get-ElevatedArguments "'{`"status`":`"OK`"}'" $res) -PassThru -Wait -WindowStyle Hidden
  Yes ($p.ExitCode -eq 0 -and (Get-LastJsonLine ([IO.File]::ReadAllText($res)))['status'] -ceq 'OK') 'elevated:wrapper-writes-its-output'
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }

'{"status":"BOOTSTRAP_PURE_TESTS_PASSED","checks":' + $script:n + '}'
