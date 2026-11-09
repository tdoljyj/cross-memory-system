# Creates only one disposable Owner-side Alpine seed and an exported test VHD.
# No existing distribution is stopped, changed, exported or removed.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  if ([string]$entry.Key -match '^(COR_.*|CORECLR_.*|COMPlus_.*|DOTNET_.*)$') { throw 'SEED_CLR_ENVIRONMENT_REFUSED' }
}
if ([Environment]::MachineName -cne 'TURING') { throw 'TURING_ONLY' }
$root = 'C:\ProgramData\CluedM5bSeed1109'
$rootfs = 'C:\w\m5b-r3-input-20261109\alpine-minirootfs-3.23.8-x86_64.tar.gz'
$expected = '56e2810205c17a5dff78cdd7b2c2af4ccdef16f18d765d5bb0f527438b136676'
$client = 'C:\Program Files\WSL\wsl.exe'
$distro = 'CluedM5bSeed1109'
function Plain([string]$path) {
  for ($part = $path; $part; $part = Split-Path -Parent $part) {
    if (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SEED_LINK_REFUSED' }
  }
}
foreach ($path in @($rootfs, $client, 'C:\ProgramData')) { Plain $path }
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
foreach ($path in @('C:\', 'C:\ProgramData', 'C:\Program Files', 'C:\Program Files\WSL', $client)) {
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $path).Sddl)
  if ($trusted -cnotcontains $descriptor.Owner.Value -or $null -eq $descriptor.DiscretionaryAcl) { throw 'SEED_PARENT_OWNER_REFUSED' }
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'SEED_PARENT_ACE_UNKNOWN' }
    if ([int]$ace.AceQualifier -ne [int][Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
    $danger = 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
    if ($path -cne 'C:\') { $danger = $danger -bor 0x10000 }
    if ($path -ceq $client) { $danger = $danger -bor 0x2 -bor 0x4 -bor 0x10 -bor 0x100 }
    if ($trusted -cnotcontains $ace.SecurityIdentifier.Value -and ($ace.AccessMask -band $danger) -ne 0) { throw 'SEED_PARENT_RENAME_OR_WRITE_UNSAFE' }
  }
}
$clientHandle = [IO.File]::Open($client, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
$signature = Get-AuthenticodeSignature -LiteralPath $client
if ([string]$signature.Status -cne 'Valid' -or $signature.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)' -or
    $signature.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'WSL_CLIENT_REFUSED' }
if ((Get-FileHash -LiteralPath $rootfs -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'ROOTFS_HASH_MISMATCH' }
if (Test-Path -LiteralPath $root) { throw 'SEED_ROOT_ALREADY_EXISTS_NO_RETRY' }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
foreach ($registration in @(Get-ChildItem -LiteralPath $key)) {
  if ([string](Get-ItemProperty -LiteralPath $registration.PSPath).DistributionName -ceq $distro) { throw 'SEED_DISTRO_ALREADY_EXISTS' }
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $sid + ')'
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetSecurityDescriptorSddlForm($sddl)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CluedPhysicalSeedDirectory {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static void CreateNew(string path, string sddl) {
    IntPtr descriptor; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      SecurityAttributes attributes = new SecurityAttributes(); attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Descriptor = descriptor;
      if (!CreateDirectory(path, ref attributes)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { LocalFree(descriptor); }
  }
}
'@
[CluedPhysicalSeedDirectory]::CreateNew($root, $sddl)
Plain $root
$rootAcl = Get-Acl -LiteralPath $root
$actualAcl = New-Object Security.AccessControl.RawSecurityDescriptor($rootAcl.Sddl)
$expectedAcl = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
if (@($trusted + $sid) -cnotcontains $actualAcl.Owner.Value -or
    ([int]$actualAcl.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
    $null -eq $actualAcl.DiscretionaryAcl -or $actualAcl.DiscretionaryAcl.Count -ne $expectedAcl.DiscretionaryAcl.Count) { throw 'SEED_ROOT_ACL_READBACK_REFUSED' }
for ($index = 0; $index -lt $expectedAcl.DiscretionaryAcl.Count; $index++) {
  $actualAce = New-Object byte[] $actualAcl.DiscretionaryAcl[$index].BinaryLength
  $expectedAce = New-Object byte[] $expectedAcl.DiscretionaryAcl[$index].BinaryLength
  $actualAcl.DiscretionaryAcl[$index].GetBinaryForm($actualAce, 0)
  $expectedAcl.DiscretionaryAcl[$index].GetBinaryForm($expectedAce, 0)
  if ([Convert]::ToBase64String($actualAce) -cne [Convert]::ToBase64String($expectedAce)) { throw 'SEED_ROOT_ACL_READBACK_REFUSED' }
}
$marker = Join-Path $root 'created.json'
$started = [ordered]@{ contract = 'clued.m5b.physical-seed/1'; distro = $distro; root = $root; inputSha256 = $expected; at = [DateTimeOffset]::UtcNow.ToString('o') }
$file = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($started | ConvertTo-Json -Compress)); $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
# The external download is data only. Hold it against write/delete while
# copying its exact accepted bytes into the protected seed directory.
$protectedRootfs = Join-Path $root 'rootfs.tar.gz'
$incoming = [IO.File]::Open($rootfs, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($hash.ComputeHash($incoming))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
  if ($actual -cne $expected) { throw 'LOCKED_ROOTFS_HASH_MISMATCH' }
  $incoming.Position = 0
  $copy = [IO.File]::Open($protectedRootfs, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $incoming.CopyTo($copy); $copy.Flush($true) } finally { $copy.Dispose() }
} finally { $incoming.Dispose() }
if ((Get-FileHash -LiteralPath $protectedRootfs -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'PROTECTED_ROOTFS_COPY_MISMATCH' }
function Run([string]$stage, [string]$arguments) {
  $process = New-Object Diagnostics.Process
  $process.StartInfo.FileName = $client; $process.StartInfo.Arguments = $arguments
  $process.StartInfo.UseShellExecute = $false; $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true; $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.EnvironmentVariables['WSL_UTF8'] = '1'
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'SEED_OPERATION_TIMEOUT_NO_RETRY' }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 2000)) { throw 'SEED_STREAM_DRAIN_TIMEOUT_NO_RETRY' }
    $result = [ordered]@{ stage = $stage; exitCode = $process.ExitCode; stdout = $stdout.Result; stderr = $stderr.Result; at = [DateTimeOffset]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $root ($stage + '.json')), ($result | ConvertTo-Json -Compress))
    if ($process.ExitCode -ne 0) { throw ('SEED_' + $stage.ToUpperInvariant() + '_FAILED_PRESERVED') }
  } finally { $process.Dispose() }
}
Run 'import' ('--import ' + $distro + ' ' + $root + '\owner-seed ' + $protectedRootfs + ' --version 2')
Run 'probe' ('--distribution ' + $distro + ' --user root --exec /bin/true')
Run 'terminate-seed-only' ('--terminate ' + $distro)
Run 'export' ('--export ' + $distro + ' ' + $root + '\ext4.vhdx --vhd')
$export = Join-Path $root 'ext4.vhdx'
Plain $export
$result = [ordered]@{ status = 'TEST_SEED_EXPORTED'; path = $export; sha256 = (Get-FileHash -LiteralPath $export -Algorithm SHA256).Hash.ToLowerInvariant(); length = (Get-Item -LiteralPath $export).Length; distro = $distro; seedRegistrationRetained = $true; productionDistrosChanged = $false }
[IO.File]::WriteAllText((Join-Path $root 'result.json'), ($result | ConvertTo-Json -Compress))
$result | ConvertTo-Json -Compress
} finally { $clientHandle.Dispose() }
