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
       target index/manifest (containerd) or config (classic) hashes to the ID (Test-RoleImageArchive). Every descriptor's size and
       digest, config and layer are checked; classic layers are held to the config's diff_ids. Linux B checks the exact loaded ID.
    3. one JSON line: status ROLE_IMAGE_EXPORTED, the asset's name, sha256 and size (publish.mjs prepare uploads it with the kit).
  The out, in and staging directories are removed at the end, whatever the outcome; the registrar build too.

  powershell -NoProfile -ExecutionPolicy Bypass -File <tree>\work\independent-ci-resident-v1\reinstall\tools\export-role-image.ps1
      -ImageId <64 hex> -RegistrarSha256 <universal manifest: windows/CompanionTaskRegistrar.cs> -HeadlessSha256 <sha256 of companion-headless.ps1>
      -Destination <new directory>
  -PureFunctionsOnly: define the functions and return (reinstall/test/test_export_role_image.py).
#>
[CmdletBinding()]
param([string]$ImageId, [string]$RegistrarSha256, [string]$HeadlessSha256, [string]$Destination, [switch]$PureFunctionsOnly)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---- pure functions ----
# A bounded view prevents a nested gzip reader from consuming the next tar member.
# Both stored bytes and uncompressed diff bytes are hashed without staging layers
# on disk. Compile once per PowerShell process; .NET Framework/PS 5.1 only.
if (-not ('RoleImageEntryReader' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
public sealed class RoleImageEntryReader : Stream {
    readonly Stream source;
    readonly SHA256 hash = SHA256.Create();
    readonly byte[] prefix;
    long remaining;
    int at;
    public string sha, diff;
    public byte[] json;
    public readonly bool gzip;
    RoleImageEntryReader(Stream source, long size) {
        this.source = source; remaining = size;
        prefix = new byte[(int)Math.Min(size, 2)];
        for (int i = 0; i < prefix.Length; i++) {
            int b = source.ReadByte(); if (b < 0) throw new InvalidDataException("TAR_TRUNCATED");
            prefix[i] = (byte)b;
        }
        gzip = prefix.Length == 2 && prefix[0] == 31 && prefix[1] == 139;
    }
    static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    public static RoleImageEntryReader ReadEntry(Stream source, long size) {
        var entry = new RoleImageEntryReader(source, size);
        try {
            if (entry.gzip) {
                using (var gz = new GZipStream(entry, CompressionMode.Decompress, true))
                using (var diffHash = SHA256.Create()) { entry.diff = Hex(diffHash.ComputeHash(gz)); }
            }
            bool keep = !entry.gzip && size <= 4194304 && entry.prefix.Length > 0 &&
                (entry.prefix[0] == 123 || entry.prefix[0] == 91 || entry.prefix[0] == 32 || entry.prefix[0] == 10 || entry.prefix[0] == 13 || entry.prefix[0] == 9);
            using (var mem = new MemoryStream()) {
                byte[] buffer = new byte[65536]; int n;
                while ((n = entry.Read(buffer, 0, buffer.Length)) > 0) { if (keep) mem.Write(buffer, 0, n); }
                if (keep) entry.json = mem.ToArray();
            }
            entry.hash.TransformFinalBlock(new byte[0], 0, 0);
            entry.sha = Hex(entry.hash.Hash);
            if (!entry.gzip) entry.diff = entry.sha;
            return entry;
        } finally { entry.hash.Dispose(); }
    }
    public override int Read(byte[] buffer, int offset, int count) {
        count = (int)Math.Min(count, remaining);
        if (count == 0) return 0;
        int n = 0;
        while (at < prefix.Length && n < count) buffer[offset + n++] = prefix[at++];
        if (n < count) {
            int read = source.Read(buffer, offset + n, count - n);
            if (read == 0) throw new InvalidDataException("TAR_TRUNCATED");
            n += read;
        }
        hash.TransformBlock(buffer, offset, n, buffer, offset); remaining -= n; return n;
    }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
'@
}
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
# Validate the complete saved image, not a config mistaken for a containerd image ID.
# No extraction, Docker or Python required. Hash every regular member while streaming;
# retain only JSON metadata (4 MiB/member, 64 MiB total), never large layer bodies.
function Read-RoleImageJson($files, [string]$name, $js) {
  if (-not $files.ContainsKey($name) -or $null -eq $files[$name].json) { throw 'JSON_MEMBER_MISSING_OR_TOO_LARGE' }
  # Prevent PowerShell's pipeline from unwrapping a one-row JSON array.
  return ,($js.DeserializeObject((New-Object Text.UTF8Encoding($false, $true)).GetString($files[$name].json)))
}
function Test-RoleImageConfig($config) {
  if (-not ($config -is [Collections.IDictionary]) -or -not $config.ContainsKey('rootfs') -or
      $config['rootfs']['type'] -cne 'layers' -or -not ($config['rootfs']['diff_ids'] -is [Array])) { throw 'CONFIG_ROOTFS_REFUSED' }
  foreach ($diff in $config['rootfs']['diff_ids']) { if ($diff -isnot [string] -or $diff -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'CONFIG_DIFF_ID_REFUSED' } }
}
function Test-RoleImageDescriptor($desc, $files, $js, $verified, $images, [int]$depth) {
  if ($depth -gt 32 -or -not ($desc -is [Collections.IDictionary]) -or
      $desc['digest'] -isnot [string] -or $desc['digest'] -cnotmatch '^sha256:[0-9a-f]{64}$' -or
      -not ($desc['size'] -is [int] -or $desc['size'] -is [long]) -or $desc['size'] -lt 0) { throw 'OCI_DESCRIPTOR_REFUSED' }
  $name = 'blobs/sha256/' + $desc['digest'].Substring(7)
  if (-not $files.ContainsKey($name)) { throw 'OCI_BLOB_MISSING' }
  if ($files[$name].sha -cne $desc['digest'].Substring(7) -or $files[$name].size -ne $desc['size']) { throw 'OCI_DESCRIPTOR_HASH_OR_SIZE_MISMATCH' }
  $key = $desc['digest'] + ':' + $desc['mediaType']
  if ($verified.ContainsKey($key)) { return }
  # A bounded recursion also rejects cycles; mark verified only after all children.
  switch -CaseSensitive ($desc['mediaType']) {
    { $_ -ceq 'application/vnd.oci.image.index.v1+json' -or $_ -ceq 'application/vnd.docker.distribution.manifest.list.v2+json' } {
      $index = Read-RoleImageJson $files $name $js
      if ($index['schemaVersion'] -ne 2 -or -not ($index['manifests'] -is [Array]) -or $index['manifests'].Count -eq 0) { throw 'OCI_INDEX_REFUSED' }
      foreach ($child in $index['manifests']) {
        if ($child['mediaType'] -cnotin @('application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json')) { throw 'OCI_INDEX_CHILD_MEDIA_TYPE_REFUSED' }
        Test-RoleImageDescriptor $child $files $js $verified $images ($depth + 1)
      }
      break
    }
    { $_ -ceq 'application/vnd.oci.image.manifest.v1+json' -or $_ -ceq 'application/vnd.docker.distribution.manifest.v2+json' } {
      $manifest = Read-RoleImageJson $files $name $js
      if ($manifest['schemaVersion'] -ne 2 -or -not ($manifest['layers'] -is [Array])) { throw 'OCI_MANIFEST_REFUSED' }
      if ($manifest['config']['mediaType'] -cnotin @('application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json')) { throw 'OCI_CONFIG_MEDIA_TYPE_REFUSED' }
      Test-RoleImageDescriptor $manifest['config'] $files $js $verified $images ($depth + 1)
      $cn = 'blobs/sha256/' + $manifest['config']['digest'].Substring(7)
      $config = Read-RoleImageJson $files $cn $js
      Test-RoleImageConfig $config
      if ($config['rootfs']['diff_ids'].Count -ne $manifest['layers'].Count) { throw 'LAYER_COUNT_MISMATCH' }
      $layers = @(); $at = 0
      foreach ($layer in $manifest['layers']) {
        if ($layer['mediaType'] -cnotin @('application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
            'application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip')) { throw 'OCI_LAYER_MEDIA_TYPE_REFUSED' }
        Test-RoleImageDescriptor $layer $files $js $verified $images ($depth + 1)
        $ln = 'blobs/sha256/' + $layer['digest'].Substring(7)
        $compressed = $layer['mediaType'].EndsWith('+gzip') -or $layer['mediaType'].EndsWith('.gzip')
        if ($files[$ln].gzip -ne $compressed) { throw 'LAYER_COMPRESSION_MISMATCH' }
        if (('sha256:' + $files[$ln].diff) -cne $config['rootfs']['diff_ids'][$at]) { throw 'LAYER_DIFF_ID_MISMATCH' }
        $layers += $ln; $at++
      }
      $images[$name] = @{ config = $cn; layers = $layers }
      break
    }
    { $_ -cin @('application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json',
        'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
        'application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip') } { break }
    default { throw 'OCI_MEDIA_TYPE_REFUSED' }
  }
  $verified[$key] = $true
}
function Test-RoleImageArchive([string]$file, [string]$id) {
  $r = [ordered]@{ ok = $false; code = $null; config = $null; entries = 0 }
  $fs = $null; $gz = $null
  try {
    $fs = [IO.File]::Open($file, 'Open', 'Read', 'Read')
    $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress)
    if ($id -cnotmatch '^[0-9a-f]{64}$') { throw 'IMAGE_ID_REFUSED' }
    $h = New-Object byte[] 512; $files = @{}; $names = @{}; $long = $null; $skip = New-Object byte[] 65536; $metadata = 0L
    while ($true) {
      if (-not (Read-RoleImageExactly $gz $h 512)) { $r.code = 'TAR_TRUNCATED'; return $r }
      $zero = $true; foreach ($b in $h) { if ($b -ne 0) { $zero = $false; break } }
      if ($zero) {
        if ($null -ne $long) { throw 'TAR_LONG_NAME_WITHOUT_MEMBER' }
        if (-not (Read-RoleImageExactly $gz $h 512)) { throw 'TAR_TRUNCATED' }
        do {
          foreach ($b in $h) { if ($b -ne 0) { throw 'TAR_TRAILING_CONTENT' } }
          $n = $gz.Read($h, 0, $h.Length)
          if ($n -gt 0 -and $n -lt $h.Length) { [Array]::Clear($h, $n, $h.Length - $n) }
        } while ($n -gt 0)
        break
      }
      $sumText = [Text.Encoding]::ASCII.GetString($h, 148, 8).Trim([char]0, ' ')
      if ($sumText -cnotmatch '^[0-7]{1,7}$') { throw 'TAR_HEADER_REFUSED' }
      $sum = 0; for ($i = 0; $i -lt 512; $i++) { $sum += $(if ($i -ge 148 -and $i -lt 156) { 32 } else { [int]$h[$i] }) }
      if ($sum -ne [Convert]::ToInt64($sumText, 8)) { throw 'TAR_CHECKSUM_MISMATCH' }
      $name = [Text.Encoding]::ASCII.GetString($h, 0, 100).Split([char]0)[0]
      $prefix = [Text.Encoding]::ASCII.GetString($h, 345, 155).Split([char]0)[0]
      if ($prefix -and [Text.Encoding]::ASCII.GetString($h, 257, 5) -ceq 'ustar') { $name = $prefix + '/' + $name }
      if ($null -ne $long) { $name = $long; $long = $null }
      $sizeText = [Text.Encoding]::ASCII.GetString($h, 124, 12).Trim([char]0, ' ')
      if ($sizeText -cnotmatch '^[0-7]{1,11}$') { $r.code = 'TAR_HEADER_REFUSED'; return $r }
      $size = [Convert]::ToInt64($sizeText, 8); $type = [char]$h[156]
      $padded = [int64]([Math]::Ceiling($size / 512.0) * 512)
      if ($type -eq 'L') {
        if ($size -gt 4096) { throw 'TAR_LONG_NAME_REFUSED' }
        $data = New-Object byte[] ([int]$padded)
        if (-not (Read-RoleImageExactly $gz $data ([int]$padded))) { throw 'TAR_TRUNCATED' }
        $long = [Text.Encoding]::UTF8.GetString($data, 0, [int]$size).TrimEnd([char]0); continue
      }
      if ($name -cnotmatch '^[A-Za-z0-9._/-]+$' -or $name.StartsWith('/') -or $name -cmatch '(?:^|/)\.{1,2}(?:/|$)') { throw 'TAR_PATH_REFUSED' }
      if ($names.ContainsKey($name)) { throw 'TAR_DUPLICATE_MEMBER' }; $names[$name] = $true
      if ($type -eq '5' -and $size -eq 0) { continue }
      if ($type -ne '0' -and [int]$type -ne 0) { throw 'TAR_MEMBER_TYPE_REFUSED' }
      $entry = [RoleImageEntryReader]::ReadEntry($gz, $size); $got = $entry.sha
      if ($null -ne $entry.json) { $metadata += $size; if ($metadata -gt 67108864) { throw 'JSON_METADATA_LIMIT' } }
      $files[$name] = @{ sha = $got; diff = $entry.diff; gzip = $entry.gzip; size = $size; json = $entry.json }
      if ($name -cmatch '^blobs/sha256/([0-9a-f]{64})$' -and $got -cne $Matches[1]) { throw 'OCI_BLOB_HASH_MISMATCH' }
      if (-not (Read-RoleImageExactly $gz $skip ([int]($padded - $size)))) { throw 'TAR_TRUNCATED' }
      $r.entries++
      if ($names.Count -gt 100000) { throw 'TAR_MEMBER_LIMIT' }
    }
    $null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
    $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 4194304
    $images = @{}
    if ($files.ContainsKey('index.json') -or $files.ContainsKey('oci-layout')) {
      $layout = Read-RoleImageJson $files 'oci-layout' $js
      if ($layout['imageLayoutVersion'] -cne '1.0.0') { throw 'OCI_LAYOUT_REFUSED' }
      $index = Read-RoleImageJson $files 'index.json' $js
      if ($index['schemaVersion'] -ne 2 -or -not ($index['manifests'] -is [Array]) -or $index['manifests'].Count -ne 1) { throw 'OCI_NOT_ONE_TARGET' }
      $target = $index['manifests'][0]
      if ($target['mediaType'] -cnotin @('application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json')) { throw 'OCI_TARGET_MEDIA_TYPE_REFUSED' }
      Test-RoleImageDescriptor $target $files $js @{} $images 0
      if ($images.Count -eq 0) { throw 'OCI_NO_IMAGE' }
      # Classic Docker may also save an OCI layout, while keeping a config ID.
      # That alternative is unambiguous only for a single verified image.
      if ($target['digest'] -cne ('sha256:' + $id) -and
          -not ($images.Count -eq 1 -and @($images.Values)[0].config -ceq ('blobs/sha256/' + $id))) { throw 'OCI_TARGET_NOT_THE_IMAGE_ID' }
      $r.config = @($images.Values)[0].config
      if ($files.ContainsKey('manifest.json')) {
        $m = Read-RoleImageJson $files 'manifest.json' $js
        if (-not ($m -is [Array]) -or $m.Count -eq 0) { throw 'MANIFEST_NOT_ONE_IMAGE' }
        foreach ($row in $m) {
          $match = $false
          foreach ($image in $images.Values) {
            if ($row['Config'] -ceq $image.config -and ($row['Layers'] -is [Array]) -and $row['Layers'].Count -eq $image.layers.Count) {
              $same = $true; for ($j = 0; $j -lt $image.layers.Count; $j++) { if ($row['Layers'][$j] -cne $image.layers[$j]) { $same = $false } }
              if ($same) { $match = $true }
            }
          }
          if (-not $match) { throw 'DOCKER_OCI_MANIFEST_MISMATCH' }
        }
      }
    } else {
      if (-not $files.ContainsKey('manifest.json')) { throw 'MANIFEST_MISSING' }
      $m = Read-RoleImageJson $files 'manifest.json' $js
      if (-not ($m -is [Array]) -or $m.Count -ne 1 -or -not ($m[0] -is [Collections.IDictionary]) -or -not $m[0].ContainsKey('Config')) { throw 'MANIFEST_NOT_ONE_IMAGE' }
      $config = [string]$m[0]['Config']; $r.config = $config
      if (-not $files.ContainsKey($config)) { throw 'CONFIG_MISSING' }
      if ($files[$config].sha -cne $id) { throw 'CONFIG_NOT_THE_IMAGE_ID' }
      $c = Read-RoleImageJson $files $config $js; Test-RoleImageConfig $c
      if (-not ($m[0]['Layers'] -is [Array]) -or $m[0]['Layers'].Count -ne $c['rootfs']['diff_ids'].Count) { throw 'LAYER_COUNT_MISMATCH' }
      for ($j = 0; $j -lt $m[0]['Layers'].Count; $j++) {
        $layer = [string]$m[0]['Layers'][$j]
        if (-not $files.ContainsKey($layer)) { throw 'LAYER_MISSING' }
        if (('sha256:' + $files[$layer].diff) -cne $c['rootfs']['diff_ids'][$j]) { throw 'LAYER_DIFF_ID_MISMATCH' }
      }
    }
    $r.ok = $true
    return $r
  } catch {
    # PowerShell wraps errors from the streaming .NET reader. Preserve the
    # stable refusal code rather than returning the invocation wrapper text.
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $r.code = $failure.Message; return $r
  } finally { if ($gz) { $gz.Dispose() }; if ($fs) { $fs.Dispose() } }
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
