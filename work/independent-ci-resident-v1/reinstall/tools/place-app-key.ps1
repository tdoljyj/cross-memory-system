# Replace this node's GitHub App private key file (C:\ProgramData\CluedControl\trusted\controller-checks-app.pem) with a new key the
# Owner downloaded from GitHub, for a record-only reinstall (README section 8b). The Owner runs it, ELEVATED, on the node; no Agent ever
# sees the key. Nothing is changed unless the new key's fingerprint equals both the one GitHub shows and the reinstall package's record.
#   1. The new file (no reparse point, at most 16 KiB, read once under one handle) is fingerprinted by the package's own pinned
#      runtime\node.exe and tools\secret-fingerprint.mjs (the formula install-resident.ps1 and the runtime use: base64 SHA-256 of the
#      public key's SPKI DER), run like install-resident.ps1 Get-SecretFingerprint: from a fresh admin-only directory under
#      C:\Windows\Temp, with a cleared environment (no NODE_OPTIONS or other inherited variable), the key on stdin.
#   2. The fingerprint must equal -ExpectedFingerprint ("SHA256:" prefix allowed) and the package record's appPublicKeySha256Base64.
#   3. The old file's ACL must be the installer's secret-file ACL (SYSTEM and Administrators full, the controller account read).
#   4. The new key is written create-only beside it (controller-checks-app.pem.new-<UTC>) with that ACL from the first moment, read back
#      and fingerprinted again; then the old file is renamed to controller-checks-app.pem.retired-<UTC> (kept, never deleted) and the
#      new one renamed into place. If the second rename fails, the old file is renamed back.
#   5. Read-only: names (never contents) of files under C:\ProgramData\CluedControl, other than key files, that still mention the old
#      key's fingerprint or -OldKeyId.
# Prints one JSON verdict: fingerprints and paths only. The downloaded file is left where it is; delete it yourself afterwards.
#   powershell -NoProfile -ExecutionPolicy Bypass -File place-app-key.ps1 -NewKeyFile <downloaded .pem> -ExpectedFingerprint <SHA256:...>
#       -Package <reinstall package dir> -PackageSha256 <its package-manifest.json sha256> -ControllerSid <S-1-5-21-...> [-OldKeyId 4918220]
param([Parameter(Mandatory)][string]$NewKeyFile, [Parameter(Mandatory)][string]$ExpectedFingerprint,
      [Parameter(Mandatory)][string]$Package, [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$PackageSha256,
      [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$ControllerSid, [ValidatePattern('^\d{1,12}$')][string]$OldKeyId = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Target = 'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem'
$Sddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $ControllerSid + ')'   # install-resident.ps1 Get-SecretFileSddl
$Utc = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
function Sha256Bytes([byte[]]$b) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
function Dacl([string]$s) { $i = $s.IndexOf('D:'); if ($i -lt 0) { '' } else { $s.Substring($i) } }

$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'RUN_ELEVATED' }
$want = $ExpectedFingerprint.Trim(); if ($want.StartsWith('SHA256:', [StringComparison]::Ordinal)) { $want = $want.Substring(7) }
if ($want -cnotmatch '^[A-Za-z0-9+/]{43}=$') { throw 'EXPECTED_FINGERPRINT_SHAPE' }

# The package: its manifest by sha, then runtime\node.exe, resident\<sha>\tools\secret-fingerprint.mjs and record\installation.json.
$pmBytes = [IO.File]::ReadAllBytes((Join-Path $Package 'package-manifest.json'))
if ((Sha256Bytes $pmBytes) -cne $PackageSha256) { throw 'PACKAGE_NOT_THE_NAMED_ONE' }
$pm = [Text.Encoding]::UTF8.GetString($pmBytes) | ConvertFrom-Json
function Read-PackageFile([string]$target) {
  $e = @($pm.files | Where-Object { $_.target -ceq $target }); if ($e.Count -ne 1) { throw ('PACKAGE_FILE_MISSING:' + $target) }
  if ($e[0].path -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($e[0].path)) { throw ('PACKAGE_PATH_REFUSED:' + $target) }
  $b = [IO.File]::ReadAllBytes((Join-Path $Package $e[0].path)); if ((Sha256Bytes $b) -cne $e[0].sha256) { throw ('PACKAGE_FILE_CHANGED:' + $target) }
  ,$b
}
$toolTarget = @($pm.files | Where-Object { $_.target -cmatch '^resident\\[0-9a-f]{64}\\tools\\secret-fingerprint\.mjs\z' })
if ($toolTarget.Count -ne 1) { throw 'PACKAGE_SECRET_TOOL_REQUIRED' }
$nodeBytes = Read-PackageFile 'runtime\node.exe'; $toolBytes = Read-PackageFile $toolTarget[0].target
$inst = [Text.Encoding]::UTF8.GetString((Read-PackageFile 'record\installation.json')) | ConvertFrom-Json
if ($inst.appPublicKeySha256Base64 -cne $want) { throw ('PACKAGE_RECORD_IS_NOT_THIS_KEY:' + $inst.appPublicKeySha256Base64) }

# install-resident.ps1 New-SecretWorkDirectory + Get-SecretFingerprint, for this script.
function New-WorkDirectory {
  $dir = Join-Path 'C:\Windows\Temp' ('clued-keyfp-' + [Guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $dir) { throw 'WORK_DIRECTORY_EXISTS' }
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($dir, $ds)
  $back = Get-Acl -LiteralPath $dir
  if ((Dacl $back.Sddl) -cne (Dacl $ds.GetSecurityDescriptorSddlForm('Access')) -or $back.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') { throw 'WORK_DIRECTORY_ACL' }
  $dir
}
function Get-AppKeyFingerprint([byte[]]$key) {
  $work = New-WorkDirectory
  $proc = $null
  try {
    $node = Join-Path $work 'node.exe'; $tool = Join-Path $work 'secret-fingerprint.mjs'
    foreach ($w in @(@($node, $nodeBytes), @($tool, $toolBytes))) {
      $f = New-Object IO.FileStream($w[0], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); try { $f.Write($w[1], 0, $w[1].Length) } finally { $f.Dispose() }
    }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $node; $psi.Arguments = '"' + $tool + '" app-key'; $psi.WorkingDirectory = 'C:\Windows\System32'
    $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables.Clear()   # no NODE_OPTIONS, NODE_PATH or any other inherited variable reaches the process holding the key
    $psi.EnvironmentVariables['SystemRoot'] = 'C:\Windows'; $psi.EnvironmentVariables['WINDIR'] = 'C:\Windows'; $psi.EnvironmentVariables['PATH'] = 'C:\Windows\System32'
    $proc = [Diagnostics.Process]::Start($psi)
    try { $proc.StandardInput.BaseStream.Write($key, 0, $key.Length) } finally { $proc.StandardInput.Close() }
    $outTask = $proc.StandardOutput.ReadToEndAsync(); $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(60000)) { try { $proc.Kill() } catch {}; return $null }
    $out = $outTask.Result; [void]$errTask.Result
    if ($proc.ExitCode -ne 0) { return $null }
    $r = $out | ConvertFrom-Json
    if ($r.kind -cne 'app-key') { return $null }
    [string]$r.fingerprint
  } finally {
    if ($null -ne $proc) { $proc.Dispose() }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Read-KeyFile([string]$path) {   # install-resident.ps1 Read-SecretSource
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'NEW_KEY_FILE_REFUSED' }
  $s = [IO.File]::Open($item.FullName, 'Open', 'Read', 'Read')
  try {
    if ($s.Length -lt 1 -or $s.Length -gt 16384) { throw 'NEW_KEY_FILE_REFUSED' }
    $bytes = New-Object byte[] ([int]$s.Length); $at = 0
    while ($at -lt $bytes.Length) { $n = $s.Read($bytes, $at, $bytes.Length - $at); if ($n -lt 1) { throw 'NEW_KEY_FILE_REFUSED' }; $at += $n }
    if ($s.ReadByte() -ne -1) { throw 'NEW_KEY_FILE_REFUSED' }
  } finally { $s.Dispose() }
  ,$bytes
}

$secSddl = New-Object Security.AccessControl.FileSecurity; $secSddl.SetSecurityDescriptorSddlForm($Sddl)
$wantDacl = Dacl $secSddl.GetSecurityDescriptorSddlForm('Access')
$staged = $Target + '.new-' + $Utc; $retired = $Target + '.retired-' + $Utc
$new = Read-KeyFile $NewKeyFile
$old = $null
try {
  $newFp = Get-AppKeyFingerprint $new
  if ($null -eq $newFp) { throw 'NEW_KEY_NOT_AN_RSA_PRIVATE_KEY' }
  if ($newFp -cne $want) { throw ('NEW_KEY_FINGERPRINT_IS_NOT_THE_EXPECTED_ONE:' + $newFp) }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'OLD_KEY_FILE_MISSING' }
  $oldAcl = Get-Acl -LiteralPath $Target
  if ((Dacl $oldAcl.Sddl) -cne $wantDacl) { throw ('OLD_KEY_ACL_NOT_THE_INSTALLERS:' + $oldAcl.Sddl) }
  $old = [IO.File]::ReadAllBytes($Target)
  $oldFp = Get-AppKeyFingerprint $old
  if ($null -eq $oldFp) { $oldFp = '' }
  if ($oldFp -ceq $newFp) { throw 'NEW_KEY_IS_THE_INSTALLED_ONE' }
  # The new key beside the old one, create-only with the final ACL, read back and fingerprinted before anything is renamed.
  $f = New-Object IO.FileStream($staged, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $secSddl)
  try { $f.Write($new, 0, $new.Length); $f.Flush($true) } finally { $f.Dispose() }
  $back = [IO.File]::ReadAllBytes($staged)
  try { if ((Sha256Bytes $back) -cne (Sha256Bytes $new)) { throw ('NEW_KEY_READBACK_MISMATCH; staged file left at ' + $staged) }; $stagedFp = Get-AppKeyFingerprint $back } finally { [Array]::Clear($back, 0, $back.Length) }
  if ($stagedFp -cne $newFp) { throw ('NEW_KEY_READBACK_FINGERPRINT_MISMATCH; staged file left at ' + $staged) }
  $sa = Get-Acl -LiteralPath $staged
  if ((Dacl $sa.Sddl) -cne $wantDacl -or $sa.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or $sa.GetGroup([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') {
    throw ('NEW_KEY_ACL_READBACK_MISMATCH; staged file left at ' + $staged + ': ' + $sa.Sddl)
  }
  # The swap: old aside (kept), new into place; on failure the old one goes back.
  [IO.File]::Move($Target, $retired)
  try { [IO.File]::Move($staged, $Target) }
  catch { [IO.File]::Move($retired, $Target); throw ('SWAP_FAILED_OLD_KEY_RESTORED; staged file left at ' + $staged) }
  $placed = [IO.File]::ReadAllBytes($Target)
  try { $placedFp = Get-AppKeyFingerprint $placed } finally { [Array]::Clear($placed, 0, $placed.Length) }
  if ($placedFp -cne $newFp) { throw ('PLACED_KEY_FINGERPRINT_MISMATCH; old key kept at ' + $retired) }
  $newAcl = Get-Acl -LiteralPath $Target
  if ((Dacl $newAcl.Sddl) -cne $wantDacl) { throw ('PLACED_KEY_ACL_MISMATCH; old key kept at ' + $retired + ': ' + $newAcl.Sddl) }
} finally {
  [Array]::Clear($new, 0, $new.Length); if ($null -ne $old) { [Array]::Clear($old, 0, $old.Length) }
}

# Read-only: other CluedControl files that still name the old key (paths only); unreadable ones are listed as such.
$needles = @(@($oldFp, $OldKeyId) | Where-Object { $_ })
$mentions = @(); $unreadable = @()
foreach ($file in @(Get-ChildItem -LiteralPath 'C:\ProgramData\CluedControl' -Recurse -File -Force -Attributes !ReparsePoint -ErrorAction SilentlyContinue)) {
  if ($file.Length -gt 5MB -or $file.Name -match '\.(pem|token|key)$|\.pem\.(retired|new)-') { continue }
  try { $t = [IO.File]::ReadAllText($file.FullName) } catch { $unreadable += $file.FullName; continue }
  if (@($needles | Where-Object { $t.Contains($_) }).Count -gt 0) { $mentions += $file.FullName }
}
[ordered]@{ status = 'APP_KEY_PLACED'; target = $Target; newFingerprint = $newFp; recordAppKeyId = $inst.appKeyId; retired = $retired; retiredFingerprint = $oldFp
  sddl = $newAcl.Sddl; controlFilesNamingTheOldKey = $mentions; controlFilesUnreadable = $unreadable } | ConvertTo-Json -Depth 3
