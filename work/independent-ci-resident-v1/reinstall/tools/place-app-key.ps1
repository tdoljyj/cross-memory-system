# Replace this node's GitHub App private key file (C:\ProgramData\CluedControl\trusted\controller-checks-app.pem) with a new key the
# Owner downloaded from GitHub, for a record-only reinstall (README section 8b). The Owner runs it, ELEVATED, on the node; no Agent ever
# sees the key. Nothing is written unless the new key's fingerprint equals the one GitHub shows for the new key.
#   1. The new file is read once into memory (at most 16 KiB) and fingerprinted by the package's own pinned runtime\node.exe and
#      tools\secret-fingerprint.mjs (the formula install-resident.ps1 and the runtime use: base64 SHA-256 of the public key's SPKI DER),
#      fed on stdin from a fresh admin-only work directory. The result is compared with -ExpectedFingerprint ("SHA256:" prefix allowed).
#   2. The old file is renamed in place to controller-checks-app.pem.retired-<UTC> (kept, never deleted); its ACL must be the one the
#      installer gives a secret file (SYSTEM and Administrators full, the controller account read).
#   3. The new file is created (create-only) with exactly that ACL from the first moment, read back and fingerprinted again.
#   4. Read-only: names (never contents) of files under C:\ProgramData\CluedControl, other than key files, that still mention the old
#      key id or fingerprint.
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
function Sha256Bytes([byte[]]$b) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
function Dacl([string]$s) { $i = $s.IndexOf('D:'); if ($i -lt 0) { '' } else { $s.Substring($i) } }

$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'RUN_ELEVATED' }
$want = $ExpectedFingerprint.Trim(); if ($want.StartsWith('SHA256:', [StringComparison]::Ordinal)) { $want = $want.Substring(7) }
if ($want -cnotmatch '^[A-Za-z0-9+/]{43}=$') { throw 'EXPECTED_FINGERPRINT_SHAPE' }

# The package's runtime\node.exe and resident\<sha>\tools\secret-fingerprint.mjs, checked against the named package manifest.
$pmBytes = [IO.File]::ReadAllBytes((Join-Path $Package 'package-manifest.json'))
if ((Sha256Bytes $pmBytes) -cne $PackageSha256) { throw 'PACKAGE_NOT_THE_NAMED_ONE' }
$pm = [Text.Encoding]::UTF8.GetString($pmBytes) | ConvertFrom-Json
function Read-PackageFile([string]$target) {
  $e = @($pm.files | Where-Object { $_.target -ceq $target }); if ($e.Count -ne 1) { throw ('PACKAGE_FILE_MISSING:' + $target) }
  $b = [IO.File]::ReadAllBytes((Join-Path $Package $e[0].path)); if ((Sha256Bytes $b) -cne $e[0].sha256) { throw ('PACKAGE_FILE_CHANGED:' + $target) }
  ,$b
}
$toolTarget = @($pm.files | Where-Object { $_.target -cmatch '^resident\\[0-9a-f]{64}\\tools\\secret-fingerprint\.mjs\z' })
if ($toolTarget.Count -ne 1) { throw 'PACKAGE_SECRET_TOOL_REQUIRED' }
$nodeBytes = Read-PackageFile 'runtime\node.exe'; $toolBytes = Read-PackageFile $toolTarget[0].target

function Get-AppKeyFingerprint([byte[]]$key) {
  $work = Join-Path $env:SystemRoot ('Temp\clued-keyfp-' + [Guid]::NewGuid().ToString('N'))
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($work, $ds)
  try {
    $node = Join-Path $work 'node.exe'; $tool = Join-Path $work 'secret-fingerprint.mjs'
    [IO.File]::WriteAllBytes($node, $nodeBytes); [IO.File]::WriteAllBytes($tool, $toolBytes)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $node; $psi.Arguments = '"' + $tool + '" app-key'; $psi.WorkingDirectory = $work
    $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $proc = [Diagnostics.Process]::Start($psi)
    $proc.StandardInput.BaseStream.Write($key, 0, $key.Length); $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEnd(); [void]$proc.StandardError.ReadToEnd(); $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { return $null }
    $r = $out | ConvertFrom-Json
    if ($r.kind -cne 'app-key') { return $null }
    $r.fingerprint
  } finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

$item = Get-Item -LiteralPath $NewKeyFile -Force
if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 16384) { throw 'NEW_KEY_FILE_REFUSED' }
$new = [IO.File]::ReadAllBytes($item.FullName)
$old = $null
try {
  $newFp = Get-AppKeyFingerprint $new
  if ($null -eq $newFp) { throw 'NEW_KEY_NOT_AN_RSA_PRIVATE_KEY' }
  if ($newFp -cne $want) { throw ('NEW_KEY_FINGERPRINT_IS_NOT_THE_EXPECTED_ONE:' + $newFp) }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'OLD_KEY_FILE_MISSING' }
  $oldAcl = Get-Acl -LiteralPath $Target
  $want_sec = New-Object Security.AccessControl.FileSecurity; $want_sec.SetSecurityDescriptorSddlForm($Sddl)
  if ((Dacl $oldAcl.Sddl) -cne (Dacl $want_sec.GetSecurityDescriptorSddlForm('Access'))) { throw ('OLD_KEY_ACL_NOT_THE_INSTALLERS:' + $oldAcl.Sddl) }
  $old = [IO.File]::ReadAllBytes($Target)
  $oldFp = Get-AppKeyFingerprint $old
  if ($oldFp -ceq $newFp) { throw 'NEW_KEY_IS_THE_INSTALLED_ONE' }
  $retired = $Target + '.retired-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  Rename-Item -LiteralPath $Target -NewName (Split-Path -Leaf $retired)
  $f = New-Object IO.FileStream($Target, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $want_sec)
  try { $f.Write($new, 0, $new.Length); $f.Flush($true) } finally { $f.Dispose() }
  $back = [IO.File]::ReadAllBytes($Target)
  try { if ((Sha256Bytes $back) -cne (Sha256Bytes $new)) { throw 'NEW_KEY_READBACK_MISMATCH' }; $placedFp = Get-AppKeyFingerprint $back } finally { [Array]::Clear($back, 0, $back.Length) }
  if ($placedFp -cne $newFp) { throw 'NEW_KEY_READBACK_FINGERPRINT_MISMATCH' }
  $newAcl = Get-Acl -LiteralPath $Target
  if ((Dacl $newAcl.Sddl) -cne (Dacl $want_sec.GetSecurityDescriptorSddlForm('Access')) -or $newAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') { throw ('NEW_KEY_ACL_READBACK_MISMATCH:' + $newAcl.Sddl) }
} finally {
  [Array]::Clear($new, 0, $new.Length); if ($null -ne $old) { [Array]::Clear($old, 0, $old.Length) }
}

# Read-only: other CluedControl files that still name the old key (paths only).
$needles = @($oldFp) + $(if ($OldKeyId) { @($OldKeyId) } else { @() })
$mentions = @(Get-ChildItem -LiteralPath 'C:\ProgramData\CluedControl' -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -le 5MB -and $_.Name -notmatch '\.(pem|token|key)$|\.pem\.retired-' } |
  Where-Object { $t = [IO.File]::ReadAllText($_.FullName); @($needles | Where-Object { $t.Contains($_) }).Count -gt 0 } | ForEach-Object { $_.FullName })
[ordered]@{ status = 'APP_KEY_PLACED'; target = $Target; newFingerprint = $newFp; retired = $retired; retiredFingerprint = $oldFp
  sddl = $newAcl.Sddl; controlFilesNamingTheOldKey = $mentions } | ConvertTo-Json -Depth 3
