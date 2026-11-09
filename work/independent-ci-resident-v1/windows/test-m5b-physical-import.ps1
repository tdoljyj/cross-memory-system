<#
Disposable TURING batch-account acceptance. Default: compile only, never execute.
The privileged caller must load this reviewed script through its clean trusted
entry. Execute compiles locked, hash-verified source bytes in a newly protected
ProgramData build root; it never executes a binary from a user-writable folder.
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$Inspect,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$SeedSha256,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedRegistrarSha256,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedHarnessSha256,
  [string]$SourceDirectory = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if ($Execute -and $Inspect) { throw 'CHOOSE_EXECUTE_OR_INSPECT' }
$targetRoot = 'C:\ProgramData\CluedM5bPhysical1109'
$protectedBuildRoot = 'C:\ProgramData\CluedM5bPhysicalBuild1109'
$seed = 'C:\ProgramData\CluedM5bSeed1109\ext4.vhdx'
$trustedSids = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$protectedSddl = 'O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
foreach ($name in [Environment]::GetEnvironmentVariables().Keys) {
  if ([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)') { throw 'RUNTIME_INJECTION_ENVIRONMENT_REFUSED' }
}
function Assert-Plain([string]$Path,[bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PATH_NOT_PLAIN' }
}
function Assert-TrustedAnchor([string]$Path) {
  Assert-Plain $Path $true
  $acl = Get-Acl -LiteralPath $Path
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
  if ($null -eq $raw.Owner -or $trustedSids -cnotcontains $raw.Owner.Value -or $null -eq $raw.DiscretionaryAcl) { throw 'ANCHOR_OWNER_OR_DACL_REFUSED' }
  foreach ($entry in $raw.DiscretionaryAcl) {
    if ($entry -isnot [Security.AccessControl.CommonAce] -or $entry.IsCallback) { throw 'ANCHOR_COMPLEX_ACE_REFUSED' }
    if ([int]$entry.AceQualifier -ne [int][Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$entry.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -or $trustedSids -ccontains $entry.SecurityIdentifier.Value) { continue }
    # Preserve normal Windows create-child/metadata rights. Those do not allow
    # renaming an existing protected child. Never relax a system directory ACL.
    if ($entry.AccessMask -band 0x500d0040) { throw 'ANCHOR_UNTRUSTED_MUTATION_RIGHTS' }
  }
}
function Assert-ProtectedBuild([string]$Path) {
  Assert-Plain $Path $true
  $acl = Get-Acl -LiteralPath $Path
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
  if ($null -eq $raw.Owner -or $raw.Owner.Value -cne 'S-1-5-32-544' -or -not ([int]$raw.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or $raw.DiscretionaryAcl.Count -ne 2) { throw 'BUILD_ACL_REFUSED' }
  $seen = @{}
  foreach ($entry in $raw.DiscretionaryAcl) {
    if ($entry -isnot [Security.AccessControl.CommonAce] -or $entry.IsCallback -or [int]$entry.AceQualifier -ne [int][Security.AccessControl.AceQualifier]::AccessAllowed -or [int]$entry.AceFlags -ne 3 -or $entry.AccessMask -ne 0x1f01ff -or @('S-1-5-18','S-1-5-32-544') -cnotcontains $entry.SecurityIdentifier.Value -or $seen.ContainsKey($entry.SecurityIdentifier.Value)) { throw 'BUILD_ACL_REFUSED' }
    $seen[$entry.SecurityIdentifier.Value] = $true
  }
}
function Test-Entry([string]$Path) {
  $parent = [IO.Path]::GetDirectoryName($Path); $leaf = [IO.Path]::GetFileName($Path)
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($parent)) { if ([string]::Equals([IO.Path]::GetFileName($entry),$leaf,[StringComparison]::OrdinalIgnoreCase)) { return $true } }
  $false
}
if ($Inspect) {
  # Inspect is pure PowerShell and never loads or executes a compiled binary.
  Assert-TrustedAnchor 'C:\'; Assert-TrustedAnchor 'C:\ProgramData'
  Assert-Plain $targetRoot $true
  Assert-Plain (Join-Path $targetRoot 'manifest.json') $false
  $manifest = [IO.File]::ReadAllText((Join-Path $targetRoot 'manifest.json')) | ConvertFrom-Json
  if ($manifest.contract -cne 'clued.m5b.disposable-import-acceptance/1' -or $manifest.root -cne $targetRoot) { throw 'INSPECT_MANIFEST_REFUSED' }
  [ordered]@{ status='INSPECTED'; manifest=$manifest; resultExists=[IO.File]::Exists((Join-Path $targetRoot 'result.json')); effectsExecuted=$false; formalSupervisorQualified=$false } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
if ($Execute) {
  if (-not $SeedSha256 -or -not $ExpectedRegistrarSha256 -or -not $ExpectedHarnessSha256) { throw 'EXACT_SEED_AND_REVIEWED_SOURCE_HASHES_REQUIRED' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'OWNER_APPROVED_ELEVATED_PROCESS_REQUIRED' }
  Assert-TrustedAnchor 'C:\'; Assert-TrustedAnchor 'C:\ProgramData'
  if (Test-Entry $protectedBuildRoot) { throw 'PROTECTED_BUILD_ROOT_EXISTS_NO_RETRY' }
}
$framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$compiler = Join-Path $framework 'csc.exe'
Assert-Plain $compiler $false

# Emit only fixed P/Invoke declarations in memory. No Add-Type/CodeDom compiler
# is launched before the explicitly sanitized compiler process below.
$assemblyName = New-Object Reflection.AssemblyName('CluedM5bNative' + [guid]::NewGuid().ToString('N'))
if ([AppDomain]::CurrentDomain.PSObject.Methods.Name -contains 'DefineDynamicAssembly') { $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run) }
else { $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run) }
$module = $assembly.DefineDynamicModule($assemblyName.Name)
$nativeType = $module.DefineType('FixedNative',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
foreach ($spec in @(
  @{ Name='CreateDirectoryW'; Return=[bool]; Parameters=[type[]]@([string],[IntPtr]) },
  @{ Name='CreateFileW'; Return=[IntPtr]; Parameters=[type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]) },
  @{ Name='GetFileInformationByHandle'; Return=[bool]; Parameters=[type[]]@([IntPtr],[IntPtr]) },
  @{ Name='GetFinalPathNameByHandleW'; Return=[uint32]; Parameters=[type[]]@([IntPtr],[Text.StringBuilder],[uint32],[uint32]) }
)) {
  $method = $nativeType.DefinePInvokeMethod($spec.Name,'kernel32.dll',$spec.Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$spec.Return,$spec.Parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
$native = $nativeType.CreateType()
function Native([string]$Name,[object[]]$Arguments) {
  $unwrapped=New-Object object[] $Arguments.Length
  for ($i=0;$i -lt $Arguments.Length;$i++) { $unwrapped[$i]=if ($null -eq $Arguments[$i]) { $null } else { $Arguments[$i].PSObject.BaseObject } }
  $native.GetMethod($Name).Invoke($null,$unwrapped)
}
function Read-LockedSource([string]$Path) {
  Assert-Plain $Path $false
  # OPEN_REPARSE_POINT: inspect the opened leaf rather than following a raced
  # link. Verify its final path before reading any file content.
  $handle = Native 'CreateFileW' @($Path,[uint32]2147483648,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]0x00200000,[IntPtr]::Zero)
  if ($handle -eq [IntPtr](-1)) { throw 'SOURCE_OPEN_FAILED' }
  $safe = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($handle,$true)
  $stream = $null; $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    if (-not (Native 'GetFileInformationByHandle' @($handle,$information))) { throw 'SOURCE_HANDLE_INFORMATION_FAILED' }
    $attributes = [Runtime.InteropServices.Marshal]::ReadInt32($information)
    if (($attributes -band 0x410) -ne 0) { throw 'SOURCE_OPENED_LINK_OR_DIRECTORY' }
    $final = New-Object Text.StringBuilder(32768)
    $length = Native 'GetFinalPathNameByHandleW' @($handle,$final,[uint32]32768,[uint32]0)
    if ($length -le 0 -or $length -ge 32768 -or -not [string]::Equals($final.ToString(),('\\?\'+[IO.Path]::GetFullPath($Path)),[StringComparison]::OrdinalIgnoreCase)) { throw 'SOURCE_FINAL_PATH_MISMATCH' }
    $stream = New-Object IO.FileStream($safe,[IO.FileAccess]::Read,4096,$false)
    if ($stream.Length -le 0 -or $stream.Length -gt 2097152) { throw 'SOURCE_SIZE_REFUSED' }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) { $read = $stream.Read($bytes,$offset,$bytes.Length-$offset); if ($read -le 0) { throw 'SOURCE_SHORT_READ' }; $offset += $read }
    ,$bytes
  } finally { if ($null -ne $stream) { $stream.Dispose() } else { $safe.Dispose() }; [Runtime.InteropServices.Marshal]::FreeHGlobal($information) }
}
function Hash-Bytes([byte[]]$Bytes) { $sha=[Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() } }
function Write-NewBytes([string]$Path,[byte[]]$Bytes) {
  $file = New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $file.Write($Bytes,0,$Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
if ([string]::IsNullOrEmpty($SourceDirectory)) { $SourceDirectory=$PSScriptRoot }
if ($SourceDirectory -notmatch '^[A-Z]:[\\/]') { throw 'LOCAL_CANONICAL_SOURCE_DIRECTORY_REQUIRED' }
$SourceDirectory=[IO.Path]::GetFullPath($SourceDirectory)
$registrarBytes = Read-LockedSource (Join-Path $SourceDirectory 'CompanionTaskRegistrar.cs')
$harnessBytes = Read-LockedSource (Join-Path $SourceDirectory 'M5bPhysicalImportAcceptance.cs')
$registrarHash = Hash-Bytes $registrarBytes; $harnessHash = Hash-Bytes $harnessBytes
if ($Execute -and ($registrarHash -cne $ExpectedRegistrarSha256 -or $harnessHash -cne $ExpectedHarnessSha256)) { throw 'REVIEWED_SOURCE_SHA256_MISMATCH' }
if ($Execute) {
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($protectedSddl)
  $binary = New-Object byte[] $descriptor.BinaryLength; $descriptor.GetBinaryForm($binary,0)
  $sd = [Runtime.InteropServices.Marshal]::AllocHGlobal($binary.Length); $sa = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try {
    [Runtime.InteropServices.Marshal]::Copy($binary,0,$sd,$binary.Length)
    for ($i=0;$i -lt 24;$i++) { [Runtime.InteropServices.Marshal]::WriteByte($sa,$i,0) }
    [Runtime.InteropServices.Marshal]::WriteInt32($sa,0,24); [Runtime.InteropServices.Marshal]::WriteIntPtr($sa,8,$sd)
    if (-not (Native 'CreateDirectoryW' @($protectedBuildRoot,$sa))) { throw 'PROTECTED_BUILD_ATOMIC_CREATE_FAILED' }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($sa); [Runtime.InteropServices.Marshal]::FreeHGlobal($sd) }
  Assert-ProtectedBuild $protectedBuildRoot; $buildRoot=$protectedBuildRoot
} else {
  # A compile-only output is never executable by this script's execution path.
  $buildRoot=Join-Path ([IO.Path]::GetTempPath()) ('clued-m5b-physical-build-'+[guid]::NewGuid().ToString('N'))
  if (Test-Entry $buildRoot) { throw 'BUILD_PATH_ALREADY_EXISTS' }
  [void][IO.Directory]::CreateDirectory($buildRoot)
}
$registrar=Join-Path $buildRoot 'CompanionTaskRegistrar.cs'; $harness=Join-Path $buildRoot 'M5bPhysicalImportAcceptance.cs'
Write-NewBytes $registrar $registrarBytes; Write-NewBytes $harness $harnessBytes
$exe=Join-Path $buildRoot 'M5bPhysicalImportAcceptance.exe'
function Run-Clean([string]$File,[string]$Arguments,[string]$LogPath,[int]$TimeoutSeconds) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$File; $info.Arguments=$Arguments; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.WorkingDirectory=$buildRoot; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear()
  foreach ($pair in @(
    @('SystemRoot','C:\Windows'),@('WINDIR','C:\Windows'),@('SystemDrive','C:'),@('COMSPEC','C:\Windows\System32\cmd.exe'),
    @('PATH','C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem'),@('TEMP',$buildRoot),@('TMP',$buildRoot),
    @('PSModulePath','C:\Windows\System32\WindowsPowerShell\v1.0\Modules')
  )) { $info.EnvironmentVariables[$pair[0]]=$pair[1] }
  $process=New-Object Diagnostics.Process; $process.StartInfo=$info
  try {
    if (-not $process.Start()) { throw 'CLEAN_PROCESS_NOT_STARTED' }
    $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds*1000)) { try { $process.Kill() } catch {}; throw 'CLEAN_PROCESS_TIMED_OUT_NO_RETRY' }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),2000)) { throw 'CLEAN_PROCESS_OUTPUT_UNKNOWN_NO_RETRY' }
    Write-NewBytes $LogPath ((New-Object Text.UTF8Encoding($false)).GetBytes($stdout.Result+$stderr.Result))
    Write-NewBytes ($LogPath+'.exit') ([Text.Encoding]::ASCII.GetBytes([string]$process.ExitCode))
    $process.ExitCode
  } finally { $process.Dispose() }
}
$references=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xml.dll') | ForEach-Object { '/reference:"'+(Join-Path $framework $_)+'"' }
$compilerArguments='/nologo /noconfig /target:exe /platform:x64 /main:M5bPhysicalImportAcceptance '+($references -join ' ')+' /out:"'+$exe+'" "'+$registrar+'" "'+$harness+'"'
$compileExit=Run-Clean $compiler $compilerArguments (Join-Path $buildRoot 'compile.log') 60
if ($compileExit -ne 0) { Get-Content -LiteralPath (Join-Path $buildRoot 'compile.log'); throw 'PHYSICAL_HARNESS_COMPILE_FAILED' }
$facts=[ordered]@{status='COMPILED_ONLY';buildRoot=$buildRoot;executable=$exe;registrarSha256=$registrarHash;harnessSha256=$harnessHash;executableSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();account='clued-m5b-1109';taskFolder='\CluedM5bPhysical1109';distro='CluedM5bPhysical1109';targetRoot=$targetRoot;seed=$seed;effectsExecuted=$false;formalSupervisorQualified=$false}
if ($Execute) {
  Assert-TrustedAnchor 'C:\'; Assert-TrustedAnchor 'C:\ProgramData'; Assert-ProtectedBuild $buildRoot
  Assert-Plain $exe $false
  $rawExit=Run-Clean $exe ('run-import '+$SeedSha256) (Join-Path $buildRoot 'run-import.log') 900
  $facts.status=if ($rawExit -eq 0) {'RUN_IMPORT_FINISHED'} else {'RUN_IMPORT_FAILED_PRESERVED'}
  $facts.effectsExecuted=$true; $facts['rawExitCode']=$rawExit; $facts['output']=Join-Path $buildRoot 'run-import.log'
  Get-Content -LiteralPath $facts.output
}
$facts | ConvertTo-Json -Depth 4 -Compress
if ($Execute -and $rawExit -ne 0) { exit $rawExit }
