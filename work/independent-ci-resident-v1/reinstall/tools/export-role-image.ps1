<#
.SYNOPSIS
  Once for the fleet (not per node): the local role image every first install loads (contract-placement's `image`, a docker image ID
  and no registry digest) saved from an installed companion node into the release asset role-image-<id>.tar.gz. Run by the agent on
  DESK, ELEVATED (the Owner clicks UAC once); read-only towards docker and the node (`docker image inspect`, `docker save`).
.DESCRIPTION
  Nothing here is new machinery: the root step goes through the companion registrar's root-run exactly as the generic node launcher's
  Linux steps do. The launcher's own functions are taken from reinstall/launcher/template.ps1 (the bytes generate.py pins), the registrar
  is built from this tree's CompanionTaskRegistrar.cs by companion-headless.ps1's own build function (both held to the universal
  manifest's pins, passed in: -RegistrarSha256, -HeadlessSha256), the out directory is made by the launcher's Set-FleetLinuxDirectories.
    1. the root script (Get-RoleImageExportScript): the image is there with exactly this ID; `docker save sha256:<id> | gzip -n` into
       the out directory; its sha256. It changes nothing in docker or on the node.
    2. elevated, the archive is copied (no link followed) into -Destination (a new directory) and checked by its content: the image's
       config inside it hashes to the ID (Test-RoleImageArchive). The ID pins the whole image: docker load holds every layer to the
       config's diff_ids and the first install's Linux B checks the loaded ID. A changed archive therefore cannot pass, whoever wrote it.
    3. one JSON line: status ROLE_IMAGE_EXPORTED, the asset's name, sha256 and size (publish.mjs attach-first-install-kit uploads it).
  The out, in and staging directories are removed at the end, whatever the outcome; the registrar build too.

  powershell -NoProfile -ExecutionPolicy Bypass -File <tree>\work\independent-ci-resident-v1\reinstall\tools\export-role-image.ps1
      -ImageId <64 hex> -RegistrarSha256 <universal manifest: windows/CompanionTaskRegistrar.cs> -HeadlessSha256 <… companion-headless.ps1>
      -Destination <new directory>
  -PureFunctionsOnly: define the functions and return (reinstall/test/test_export_role_image.py).
#>
[CmdletBinding()]
param([string]$ImageId, [string]$RegistrarSha256, [string]$HeadlessSha256, [string]$Destination, [switch]$PureFunctionsOnly)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---- pure functions ----
# The root step's text: read-only towards docker, output only into the out directory (the registrar's fixed environment runs it as root).
function Get-RoleImageExportScript([string]$id, [string]$wslOut) {
  if ($id -cnotmatch '^[0-9a-f]{64}$' -or $wslOut -cnotmatch '^/mnt/[a-z](?:/[A-Za-z0-9._-]+)+$') { throw 'EXPORT_SCRIPT_INPUT_REFUSED' }
  ("#!/bin/bash`n" +
   "# role image export (reinstall/tools/export-role-image.ps1): read-only towards docker; writes only into O`n" +
   "set -euo pipefail`n" +
   "refuse() { echo `"{\`"status\`":\`"REFUSED\`",\`"code\`":\`"`$1\`"}`"; exit 1; }`n" +
   "O=$wslOut`nID=$id`n" +
   "[ `"`$(id -u)`" = 0 ] || refuse ROOT_REQUIRED`n" +
   "[ -d `"`$O`" ] || refuse OUT_DIRECTORY_MISSING`n" +
   "got=`$(docker image inspect --format '{{.Id}}' `"sha256:`$ID`") || refuse IMAGE_NOT_PRESENT`n" +
   "[ `"`$got`" = `"sha256:`$ID`" ] || refuse IMAGE_ID_NOT_THE_REQUESTED`n" +
   "F=`"`$O/role-image-`$ID.tar.gz`"`n" +
   "[ ! -e `"`$F`" ] || refuse ARCHIVE_EXISTS`n" +
   "docker save `"sha256:`$ID`" | gzip -n > `"`$F`" || refuse DOCKER_SAVE_FAILED`n" +
   "echo `"{\`"status\`":\`"ROLE_IMAGE_SAVED\`",\`"sha256\`":\`"`$(sha256sum `"`$F`" | cut -d' ' -f1)\`"}`"`n")
}
function Read-RoleImageExactly($stream, [byte[]]$buffer, [int]$count) {
  $at = 0
  while ($at -lt $count) { $n = $stream.Read($buffer, $at, $count - $at); if ($n -le 0) { return $false }; $at += $n }
  $true
}
# The saved image checked by its own content (docker save, classic or OCI layout: manifest.json names the config; the image ID is the
# config's SHA-256). Streams the gzip once; reads into memory only the manifest and config entries (at most 4 MiB each).
function Test-RoleImageArchive([string]$file, [string]$id) {
  $r = [ordered]@{ ok = $false; code = $null; config = $null; entries = 0 }
  $fs = $null; $gz = $null
  try {
    $fs = [IO.File]::Open($file, 'Open', 'Read', 'Read')
    $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress)
    $h = New-Object byte[] 512; $small = @{}; $long = $null; $skip = New-Object byte[] 65536
    while ($true) {
      if (-not (Read-RoleImageExactly $gz $h 512)) { $r.code = 'TAR_TRUNCATED'; return $r }
      $zero = $true; foreach ($b in $h) { if ($b -ne 0) { $zero = $false; break } }
      if ($zero) { break }
      $name = [Text.Encoding]::ASCII.GetString($h, 0, 100).Split([char]0)[0]
      $prefix = [Text.Encoding]::ASCII.GetString($h, 345, 155).Split([char]0)[0]
      if ($prefix -and [Text.Encoding]::ASCII.GetString($h, 257, 5) -ceq 'ustar') { $name = $prefix + '/' + $name }
      if ($null -ne $long) { $name = $long; $long = $null }
      $sizeText = [Text.Encoding]::ASCII.GetString($h, 124, 12).Trim([char]0, ' ')
      if ($sizeText -cnotmatch '^[0-7]{1,11}$') { $r.code = 'TAR_HEADER_REFUSED'; return $r }
      $size = [Convert]::ToInt64($sizeText, 8); $type = [char]$h[156]
      $padded = [int64]([Math]::Ceiling($size / 512.0) * 512)
      $wanted = ($type -eq 'L') -or ($name -ceq 'manifest.json') -or ($name -cmatch '^(?:blobs/sha256/[0-9a-f]{64}|[0-9a-f]{64}\.json)$')
      if ($wanted -and $size -le 4194304) {
        $data = New-Object byte[] ([int]$padded)
        if (-not (Read-RoleImageExactly $gz $data ([int]$padded))) { $r.code = 'TAR_TRUNCATED'; return $r }
        $bytes = New-Object byte[] ([int]$size); [Array]::Copy($data, $bytes, $size)
        if ($type -eq 'L') { $long = [Text.Encoding]::UTF8.GetString($bytes).TrimEnd([char]0); continue }
        $small[$name] = $bytes
      } else {
        $left = $padded
        while ($left -gt 0) { $n = $gz.Read($skip, 0, [int][Math]::Min($left, $skip.Length)); if ($n -le 0) { $r.code = 'TAR_TRUNCATED'; return $r }; $left -= $n }
      }
      $r.entries++
    }
    if (-not $small.ContainsKey('manifest.json')) { $r.code = 'MANIFEST_MISSING'; return $r }
    $null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
    $js = New-Object Web.Script.Serialization.JavaScriptSerializer
    $m = $js.DeserializeObject((New-Object Text.UTF8Encoding($false, $true)).GetString($small['manifest.json']))
    if (-not ($m -is [Array]) -or @($m).Count -ne 1 -or -not ($m[0] -is [Collections.IDictionary]) -or -not $m[0].ContainsKey('Config')) { $r.code = 'MANIFEST_NOT_ONE_IMAGE'; return $r }
    $config = [string]$m[0]['Config']; $r.config = $config
    if (-not $small.ContainsKey($config)) { $r.code = 'CONFIG_MISSING'; return $r }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $got = ([BitConverter]::ToString($sha.ComputeHash($small[$config]))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($got -cne $id) { $r.code = 'CONFIG_NOT_THE_IMAGE_ID'; return $r }
    $r.ok = $true
    return $r
  } catch { $r.code = 'ARCHIVE_UNREADABLE:' + $_.Exception.GetType().Name; return $r } finally { if ($gz) { $gz.Dispose() }; if ($fs) { $fs.Dispose() } }
}
if ($PureFunctionsOnly) { return }

# ---- the export (elevated) ----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'RUN_ELEVATED' }
foreach ($p in @(@('ImageId', $ImageId), @('RegistrarSha256', $RegistrarSha256), @('HeadlessSha256', $HeadlessSha256))) { if ([string]$p[1] -cnotmatch '^[0-9a-f]{64}$') { throw ('PARAMETER_REFUSED:' + $p[0]) } }
if ($Destination -cnotmatch '^[A-Za-z]:\\[A-Za-z0-9._\\-]+$' -or $Destination.Contains('\..') -or (Test-Path -LiteralPath $Destination)) { throw 'DESTINATION_MUST_BE_A_NEW_DIRECTORY' }
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$U8 = New-Object Text.UTF8Encoding($false); $Strict8 = New-Object Text.UTF8Encoding($false, $true)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object Web.Script.Serialization.JavaScriptSerializer
$Tree = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path   # work\independent-ci-resident-v1 of the unpacked universal tree
$CarryParent = 'C:\ProgramData\CluedIndependentCI'; $ResidentRoot = Join-Path $CarryParent 'resident'
function Stop-Launch([string]$code, $detail) { throw ($code + ' ' + ($detail | ConvertTo-Json -Compress -Depth 4)) }

# the launcher's functions, the bytes generate.py pins (one source: the template generate.py would generate a launcher from)
$templateFile = Join-Path $Tree 'reinstall\launcher\template.ps1'
$pin = @([regex]::Matches([IO.File]::ReadAllText((Join-Path $Tree 'reinstall\launcher\generate.py')), "(?m)^TEMPLATE_SHA = '([0-9a-f]{64})'") | ForEach-Object { $_.Groups[1].Value })
$sha = [Security.Cryptography.SHA256]::Create()
try { $templateSha = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($templateFile)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
if ($pin.Count -ne 1 -or $pin[0] -cne $templateSha) { throw 'TEMPLATE_NOT_THE_REVIEWED_ONE' }
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($templateFile, [ref]$tk, [ref]$er)
if ($er.Count) { throw 'TEMPLATE_PARSE_ERRORS' }
foreach ($name in @('Sha256Bytes', 'Write-New', 'Get-Key', 'Tail', 'Get-FileSha', 'Invoke-FleetProcess', 'ConvertFrom-FleetRootRunLine', 'New-FleetCaptureDirectory',
    'New-FleetRunDirectory', 'Get-FleetScriptPin', 'Read-FleetFileChecked', 'Get-FleetRunOutputDirectory', 'Invoke-FleetLinuxScript', 'Set-FleetLinuxDirectories', 'Remove-FleetRegistrar')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw ('TEMPLATE_FUNCTION_MISSING:' + $name) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}

# the installed companion node: its account, its distribution, its installed resident generation (the registrar's build place)
$read = { param($rel) $Js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes((Join-Path $ResidentRoot $rel)))) }
$account = & $read 'install\companion-account.json'
if ((Get-Key $account 'contract') -cne 'clued.independent-ci.companion-account/1') { throw 'NOT_A_COMPANION_ACCOUNT_NODE' }
$OwnerSid = [string](Get-Key $account 'companionSid')
$FleetDistribution = [string](Get-Key (Get-Key (& $read 'config\policy.json') 'linux') 'distribution')
$installedResident = [string](Get-Key (& $read 'install\install-receipt.json') 'residentManifestSha256')
if ($OwnerSid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or $FleetDistribution -cnotmatch '^[A-Za-z0-9._-]{1,64}$' -or $installedResident -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALLED_NODE_FACTS_REFUSED' }
$FleetCompanionAccount = $true
$ChildEnv = [ordered]@{}; foreach ($k in @('SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT', 'ProgramData', 'ProgramFiles', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA')) { $ChildEnv[$k] = [Environment]::GetEnvironmentVariable($k) }

$hex = [Guid]::NewGuid().ToString('N')
$admin = New-Object Security.AccessControl.DirectorySecurity; $admin.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
$Stage = Join-Path $CarryParent ('role-image-export-stage-' + $hex); [void][IO.Directory]::CreateDirectory($Stage, $admin)
$FleetInDir = Join-Path $CarryParent ('role-image-export-in-' + $hex); [void][IO.Directory]::CreateDirectory($FleetInDir, $admin)
$FleetOutDir = Join-Path $CarryParent ('reinstall-linux-out-' + $hex)
[void][IO.Directory]::CreateDirectory($Destination, $admin)
$Out = Join-Path $Destination 'export-launch'; [void][IO.Directory]::CreateDirectory($Out)
$build = $null; $result = [ordered]@{ status = 'ROLE_IMAGE_EXPORT_REFUSED'; imageId = $ImageId; error = $null }
try {
  Set-FleetLinuxDirectories   # the out directory under the CI root, the companion account may write in it (as for Linux B)
  # the registrar: this tree's sources at the universal manifest's pins, built by companion-headless.ps1's own build function
  $files = [ordered]@{}
  foreach ($x in @(@('companion-headless.ps1', $HeadlessSha256), @('CompanionTaskRegistrar.cs', $RegistrarSha256))) {
    $b = [IO.File]::ReadAllBytes((Join-Path $Tree ('windows\' + $x[0])))
    if ((Sha256Bytes $b) -cne $x[1]) { throw ('TREE_FILE_NOT_THE_PINNED:' + $x[0]) }
    $staged = Join-Path $Stage $x[0]; Write-New $staged $b
    if ((Get-FileSha $staged) -cne $x[1]) { throw ('STAGED_COPY_CHANGED:' + $x[0]) }
    $files[$x[0]] = $staged
  }
  $hast = [Management.Automation.Language.Parser]::ParseInput($U8.GetString([IO.File]::ReadAllBytes($files['companion-headless.ps1'])), [ref]$tk, [ref]$er)
  $want = @('Get-CompanionSha256', 'Invoke-CompanionBinaryCompile', 'Remove-CompanionBuild', 'New-CompanionBuildFromBytes', 'New-CompanionBuildFromPackage')
  $vars = @('$CompanionBuildPrograms', '$CompanionBuildSddl', '$CompanionFramework', '$CompanionCsc')
  $defs = @($hast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $want -ccontains $n.Name }, $false))
  $asg = @($hast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $vars -ccontains $n.Left.Extent.Text }, $false))
  if ($defs.Count -ne $want.Count -or $asg.Count -ne $vars.Count) { throw 'COMPANION_BUILD_FUNCTIONS_NOT_FOUND' }
  foreach ($n in @($asg) + @($defs)) { . ([scriptblock]::Create($n.Extent.Text)) }
  $b2 = New-CompanionBuildFromPackage $ResidentRoot $files['CompanionTaskRegistrar.cs'] $RegistrarSha256 $installedResident
  $build = [ordered]@{ directory = [string]$b2.directory; exe = [string]$b2.registrar.exe }
  # the root step, by root-run, as a launcher's Linux phase
  $wslOut = '/mnt/c/' + $FleetOutDir.Substring(3).Replace('\', '/')
  $FleetScriptA = Join-Path $FleetInDir 'export.sh'; Write-New $FleetScriptA ($U8.GetBytes((Get-RoleImageExportScript $ImageId $wslOut)))
  $FleetScriptASha256 = Get-FileSha $FleetScriptA; $FleetTimeoutA = 3600
  $run = Invoke-FleetLinuxScript 'A' $build.exe
  $last = $(if ($run.stdout) { @(([string]$run.stdout) -split "`r?`n" | Where-Object { $_ }) | Select-Object -Last 1 } else { $null })
  if ($run.outcome -cne 'EXITED' -or $run.exit -ne 0 -or [string]$last -notmatch '"status":"ROLE_IMAGE_SAVED"') { throw ('ROOT_STEP_NOT_COMPLETED ' + ($run | ConvertTo-Json -Compress -Depth 3)) }
  # the archive, copied without following a link, then checked by its content
  $leaf = 'role-image-' + $ImageId + '.tar.gz'; $src = Join-Path $FleetOutDir $leaf; $dst = Join-Path $Destination $leaf
  $attr = [IO.File]::GetAttributes($src)
  if (($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attr -band [IO.FileAttributes]::Directory) -ne 0) { throw 'ARCHIVE_NOT_A_PLAIN_FILE' }
  $in = [IO.File]::Open($src, 'Open', 'Read', 'Read'); $outFile = [IO.File]::Open($dst, 'CreateNew', 'Write', 'None')
  try { $in.CopyTo($outFile) } finally { $outFile.Dispose(); $in.Dispose() }
  $check = Test-RoleImageArchive $dst $ImageId
  if (-not $check.ok) { throw ('ARCHIVE_NOT_THE_IMAGE ' + $check.code) }
  $result = [ordered]@{ status = 'ROLE_IMAGE_EXPORTED'; imageId = $ImageId; asset = $leaf; file = $dst; sha256 = (Get-FileSha $dst); bytes = (New-Object IO.FileInfo($dst)).Length; config = $check.config; error = $null }
} catch { $result.error = $_.Exception.Message } finally {
  Remove-FleetRegistrar $build
  foreach ($d in @($FleetOutDir, $FleetInDir, $Stage)) { try { if ([IO.Directory]::Exists($d)) { [IO.Directory]::Delete($d, $true) } } catch { $result['cleanupError'] = $d } }
}
$result | ConvertTo-Json -Compress
if ($result.status -cne 'ROLE_IMAGE_EXPORTED') { exit 1 }
