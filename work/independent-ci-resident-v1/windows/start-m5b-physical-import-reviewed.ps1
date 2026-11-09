# Exact byte-bound elevated entry for the disposable TURING test. Launched by
# the Agent after the Owner's UAC; never load code from a writable source path.
[CmdletBinding()]
param([switch]$ResumePreflightFailure)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
foreach ($name in [Environment]::GetEnvironmentVariables().Keys) {
  if ([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)') { throw 'ENTRY_ENVIRONMENT_REFUSED' }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$owner = 'S-1-5-21-1173730660-3877291096-655431861-1001'
if ([Environment]::MachineName -cne 'TURING' -or $identity.User.Value -cne $owner -or
    -not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'EXACT_ELEVATED_TURING_OWNER_REQUIRED' }
$sources = 'C:\w\m5b-r3-recovery-20261109\work\independent-ci-resident-v1\windows'
$source = Join-Path $sources 'test-m5b-physical-import.ps1'
$sourceHash = 'd9d4d6a7bf83d153f7b629e9c42d521f14cb2ac0bd8c8f862a8af56f58cf40c8'
$root = 'C:\ProgramData\CluedM5bPhysicalReceipt1109'
$targetRoot = 'C:\ProgramData\CluedM5bPhysical1109'
$seedHash = '86b75a42423b5af3499442ff08cbfe38a6cfc5bc85c72514e586163601e6ce71'
$registrarHash = '11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b'
$harnessHash = '52ec0731a881a94805778789f9eee3f0c1be9ecaa943cebea536b98a187659de'
function Hash-Bytes([byte[]]$bytes) { $hash = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() } }
$assemblyName = New-Object Reflection.AssemblyName('CluedPhysicalEntry' + [guid]::NewGuid().ToString('N'))
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule($assemblyName.Name)
$builder = $module.DefineType('EntryNative', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
foreach ($spec in @(
  @{ Name='CreateDirectoryW'; Return=[bool]; Parameters=[type[]]@([string],[IntPtr]) },
  @{ Name='CreateFileW'; Return=[IntPtr]; Parameters=[type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]) },
  @{ Name='GetFileInformationByHandle'; Return=[bool]; Parameters=[type[]]@([IntPtr],[IntPtr]) },
  @{ Name='GetFinalPathNameByHandleW'; Return=[uint32]; Parameters=[type[]]@([IntPtr],[Text.StringBuilder],[uint32],[uint32]) }
)) {
  $method=$builder.DefinePInvokeMethod($spec.Name,'kernel32.dll',$spec.Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$spec.Return,$spec.Parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
$native = $builder.CreateType()
function Native([string]$name,[object[]]$arguments) {
  $unwrapped=New-Object object[] $arguments.Length
  for($index=0;$index -lt $arguments.Length;$index++){ $unwrapped[$index]=if($null -eq $arguments[$index]){$null}else{$arguments[$index].PSObject.BaseObject} }
  $native.GetMethod($name).Invoke($null,$unwrapped)
}
$handle=Native 'CreateFileW' @($source,[uint32]2147483648,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]0x00200000,[IntPtr]::Zero)
if($handle -eq [IntPtr](-1)){throw 'ENTRY_SOURCE_OPEN_FAILED'}
$safe=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($handle,$true)
$information=[Runtime.InteropServices.Marshal]::AllocHGlobal(52);$inputFile=$null
try {
  if(-not (Native 'GetFileInformationByHandle' @($handle,$information))){throw 'ENTRY_SOURCE_INFORMATION_FAILED'}
  if(([Runtime.InteropServices.Marshal]::ReadInt32($information) -band 0x410) -ne 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($information,40) -ne 1){throw 'ENTRY_SOURCE_LINK_OR_DIRECTORY_REFUSED'}
  $final=New-Object Text.StringBuilder(32768)
  $length=Native 'GetFinalPathNameByHandleW' @($handle,$final,[uint32]32768,[uint32]0)
  if($length -le 0 -or $length -ge 32768 -or -not [string]::Equals($final.ToString(),('\\?\'+[IO.Path]::GetFullPath($source)),[StringComparison]::OrdinalIgnoreCase)){throw 'ENTRY_SOURCE_FINAL_PATH_CHANGED'}
  $inputFile=New-Object IO.FileStream($safe,[IO.FileAccess]::Read,4096,$false)
  if ($inputFile.Length -le 0 -or $inputFile.Length -gt 1048576) { throw 'ENTRY_SOURCE_SIZE_REFUSED' }
  $bytes = New-Object byte[] ([int]$inputFile.Length); $offset = 0
  while ($offset -lt $bytes.Length) { $count = $inputFile.Read($bytes, $offset, $bytes.Length - $offset); if ($count -le 0) { throw 'ENTRY_SOURCE_SHORT_READ' }; $offset += $count }
  if ((Hash-Bytes $bytes) -cne $sourceHash) { throw 'ENTRY_SOURCE_HASH_CHANGED' }
} finally { if($null -ne $inputFile){$inputFile.Dispose()}else{$safe.Dispose()};[Runtime.InteropServices.Marshal]::FreeHGlobal($information) }
# Parse only the exact reviewed bytes. Load its read-only anchor guards and
# fixed in-memory P/Invoke declarations, not its main execution sequence.
$text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'ENTRY_REVIEWED_SOURCE_PARSE_FAILED' }
$trustedSids = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
foreach ($name in @('Assert-Plain', 'Assert-TrustedAnchor', 'Test-Entry')) {
  $function = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $_.Name -ceq $name })
  if ($function.Count -ne 1) { throw 'ENTRY_REVIEWED_FUNCTION_NOT_UNIQUE' }
  . ([scriptblock]::Create($function[0].Extent.Text))
}

$seedRoot = 'C:\ProgramData\CluedM5bSeed1109'
$seedFile = $seedRoot+'\ext4.vhdx'
$seedLength = 79691776L
$rootfsInputHash = '56e2810205c17a5dff78cdd7b2c2af4ccdef16f18d765d5bb0f527438b136676'
$buildRoot = 'C:\ProgramData\CluedM5bPhysicalBuild1109'
$exe = $buildRoot+'\M5bPhysicalImportAcceptance.exe'
$executableHash = '7bc20b77f0e640309a1a6057eb159cb7894d04fd1c09b20797ab9120475ae403'
function Assert-ExactDirectoryDacl([string]$Sddl,[string]$Expected,[string[]]$AllowedOwners,[string]$Code) {
  try { $have=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl); $want=New-Object Security.AccessControl.RawSecurityDescriptor($Expected) } catch { throw $Code }
  if($null -eq $have.Owner -or $AllowedOwners -cnotcontains $have.Owner.Value -or
      ([int]$have.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
      $null -eq $have.DiscretionaryAcl -or $have.DiscretionaryAcl.Count -ne $want.DiscretionaryAcl.Count){throw $Code}
  for($index=0;$index -lt $want.DiscretionaryAcl.Count;$index++){
    $left=New-Object byte[] $have.DiscretionaryAcl[$index].BinaryLength; $right=New-Object byte[] $want.DiscretionaryAcl[$index].BinaryLength
    $have.DiscretionaryAcl[$index].GetBinaryForm($left,0);$want.DiscretionaryAcl[$index].GetBinaryForm($right,0)
    if([Convert]::ToBase64String($left) -cne [Convert]::ToBase64String($right)){throw $Code}
  }
}
function Assert-SeedDirectoryDacl([string]$Sddl) {
  $full='O:'+$owner+'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;'+$owner+')'
  try { Assert-ExactDirectoryDacl $Sddl $full @($owner,'S-1-5-18','S-1-5-32-544') 'ENTRY_SEED_ACL_REFUSED'; return } catch { }
  Assert-ExactDirectoryDacl $Sddl $seedSddl @('S-1-5-32-544') 'ENTRY_SEED_ACL_REFUSED'
}
function Open-VerifiedEntry([string]$Path,[bool]$Directory) {
  Assert-Plain $Path $Directory
  $flags=[uint32]0x00200000;if($Directory){$flags=[uint32]0x02200000}
  $handle=Native 'CreateFileW' @($Path,[uint32]2147483648,[uint32]1,[IntPtr]::Zero,[uint32]3,$flags,[IntPtr]::Zero)
  if($handle -eq [IntPtr](-1)){throw 'ENTRY_INPUT_OPEN_FAILED'}
  $safe=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($handle,$true)
  $information=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    if(-not (Native 'GetFileInformationByHandle' @($handle,$information))){throw 'ENTRY_INPUT_INFORMATION_FAILED'}
    $attributes=[Runtime.InteropServices.Marshal]::ReadInt32($information)
    if(($attributes -band 0x400) -ne 0 -or (($attributes -band 0x10) -ne 0) -ne $Directory -or
       (-not $Directory -and [Runtime.InteropServices.Marshal]::ReadInt32($information,40) -ne 1)){throw 'ENTRY_INPUT_LINK_OR_KIND_REFUSED'}
    $final=New-Object Text.StringBuilder(32768)
    $length=Native 'GetFinalPathNameByHandleW' @($handle,$final,[uint32]32768,[uint32]0)
    if($length -le 0 -or $length -ge 32768 -or -not [string]::Equals($final.ToString(),('\\?\'+[IO.Path]::GetFullPath($Path)),[StringComparison]::OrdinalIgnoreCase)){throw 'ENTRY_INPUT_FINAL_PATH_CHANGED'}
    return ,$safe
  } catch {$safe.Dispose();throw} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($information)}
}
function Open-VerifiedRead([string]$Path,[int64]$Maximum) {
  $safe=Open-VerifiedEntry $Path $false
  try {
    $stream=New-Object IO.FileStream($safe,[IO.FileAccess]::Read,4096,$false)
    if($stream.Length -lt 0 -or $stream.Length -gt $Maximum){$stream.Dispose();throw 'ENTRY_INPUT_SIZE_REFUSED'}
    return ,$stream
  }catch{$safe.Dispose();throw}
}
function Read-VerifiedBytes([string]$Path,[int64]$Maximum=1048576) {
  $stream=Open-VerifiedRead $Path $Maximum
  try {$memory=New-Object IO.MemoryStream;try{$stream.CopyTo($memory);return ,$memory.ToArray()}finally{$memory.Dispose()}}finally{$stream.Dispose()}
}
function Hash-Stream($Stream) {
  $Stream.Position=0;$hash=[Security.Cryptography.SHA256]::Create()
  try { $result=([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-','').ToLowerInvariant();$Stream.Position=0;$result }finally{$hash.Dispose()}
}
function Convert-EntryJson([byte[]]$Bytes) {
  [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $parser=New-Object Web.Script.Serialization.JavaScriptSerializer;$parser.MaxJsonLength=1048576
  $value=$parser.DeserializeObject((New-Object Text.UTF8Encoding($false,$true)).GetString($Bytes))
  if($value -isnot [Collections.IDictionary]){throw 'ENTRY_JSON_OBJECT_REQUIRED'}
  return ,$value
}
function Assert-MapFields($Value,$Expected,[string]$Code) {
  if($Value -isnot [Collections.IDictionary]){throw $Code}
  foreach($key in $Expected.Keys){
    if(@($Value.Keys) -cnotcontains $key){throw $Code}
    $want=$Expected[$key];$have=$Value[$key]
    if($want -is [string]){if($have -isnot [string] -or $have -cne $want){throw $Code}}
    elseif($want -is [bool]){if($have -isnot [bool] -or $have -ne $want){throw $Code}}
    elseif($want -is [int]){if($have -isnot [int] -or $have -ne $want){throw $Code}}
    else{throw 'ENTRY_EXPECTATION_TYPE_REFUSED'}
  }
}
function Assert-SeedMarker($Marker) {
  Assert-MapFields $Marker @{contract='clued.m5b.physical-seed/1';distro='CluedM5bSeed1109';root=$seedRoot;inputSha256=$rootfsInputHash} 'ENTRY_SEED_MARKER_REFUSED'
}
function Assert-OriginalPreflightFailure($Started,$Finished,[object[]]$Lines) {
  if($Lines.Count -ne 2){throw 'ENTRY_RETRY_STDOUT_NOT_EXACT_PREFLIGHT'}
  Assert-MapFields $Started @{status='STARTED';psSha256=$sourceHash;registrarSha256=$registrarHash;harnessSha256=$harnessHash;seedSha256=$seedHash} 'ENTRY_RETRY_STARTED_SUBJECT_REFUSED'
  Assert-MapFields $Finished @{contract='clued.m5b.physical-entry/1';childExitCode=1;targetRoot=$targetRoot;formalSupervisorQualified=$false;evidenceStatus='EVIDENCE_ROOT_ABSENT'} 'ENTRY_RETRY_FINISHED_NOT_PREFLIGHT_FAILURE'
  Assert-MapFields $Lines[0] @{status='FAILED_PRESERVED_NO_RETRY';phase='preflight';code='PARENT_OWNER_OR_DACL_REFUSED';exceptionType='Refusal';hresult='0x80131500';evidenceRoot=$targetRoot} 'ENTRY_RETRY_FAILURE_NOT_EXACT_PREFLIGHT'
  Assert-MapFields $Lines[1] @{status='RUN_IMPORT_FAILED_PRESERVED';buildRoot=$buildRoot;executable=$exe;registrarSha256=$registrarHash;harnessSha256=$harnessHash;executableSha256=$executableHash;account='clued-m5b-1109';taskFolder='\CluedM5bPhysical1109';distro='CluedM5bPhysical1109';targetRoot=$targetRoot;seed=$seedFile;effectsExecuted=$true;formalSupervisorQualified=$false;rawExitCode=1;output=($buildRoot+'\run-import.log')} 'ENTRY_RETRY_COMPILED_SUBJECT_REFUSED'
}
function New-ReceiptDirectory {
  if(Test-Entry $root){throw 'ENTRY_RECEIPT_ROOT_EXISTS_NO_RETRY'}
  $descriptor=New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  $binary=New-Object byte[] $descriptor.BinaryLength;$descriptor.GetBinaryForm($binary,0)
  $sd=[Runtime.InteropServices.Marshal]::AllocHGlobal($binary.Length);$sa=[Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try {
    [Runtime.InteropServices.Marshal]::Copy($binary,0,$sd,$binary.Length)
    for($index=0;$index -lt 24;$index++){[Runtime.InteropServices.Marshal]::WriteByte($sa,$index,0)}
    [Runtime.InteropServices.Marshal]::WriteInt32($sa,0,24);[Runtime.InteropServices.Marshal]::WriteIntPtr($sa,8,$sd)
    if(-not (Native 'CreateDirectoryW' @($root,$sa))){throw 'ENTRY_RECEIPT_ATOMIC_CREATE_FAILED'}
  }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($sa);[Runtime.InteropServices.Marshal]::FreeHGlobal($sd)}
}
function Write-New([string]$Path,[byte[]]$Data) {$file=[IO.File]::Open($Path,'CreateNew','Write','Read');try{$file.Write($Data,0,$Data.Length);$file.Flush($true)}finally{$file.Dispose()}}
function Json-Bytes($Value) {return ,((New-Object Text.UTF8Encoding($false)).GetBytes(($Value|ConvertTo-Json -Depth 10 -Compress)))}
function Open-ValidatedSeed {
  Assert-TrustedAnchor 'C:\';Assert-TrustedAnchor 'C:\ProgramData'
  $heldDirectory=Open-VerifiedEntry $seedRoot $true;$heldSeed=$null
  try {
    $before=(Get-Acl -LiteralPath $seedRoot).Sddl;Assert-SeedDirectoryDacl $before
    $createdBytes=Read-VerifiedBytes (Join-Path $seedRoot 'created.json') 16384
    Assert-SeedMarker (Convert-EntryJson $createdBytes)
    $heldSeed=Open-VerifiedRead $seedFile 2147483648
    if($heldSeed.Length -ne $seedLength -or (Hash-Stream $heldSeed) -cne $seedHash){throw 'ENTRY_SEED_BYTES_REFUSED'}
    return [pscustomobject]@{directory=$heldDirectory;seed=$heldSeed;beforeSddl=$before;createdSha256=(Hash-Bytes $createdBytes)}
  }catch{if($null -ne $heldSeed){$heldSeed.Dispose()};$heldDirectory.Dispose();throw}
}
function Protect-ValidatedSeedDirectory($Guard) {
  Assert-SeedDirectoryDacl ((Get-Acl -LiteralPath $seedRoot).Sddl)
  $security=New-Object Security.AccessControl.DirectorySecurity
  $security.SetSecurityDescriptorSddlForm($seedSddl,([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access))
  # Only this new test directory is addressed. No child is visited, no global
  # anchor ACL changes and no VHD data is written. Windows may tighten inherited
  # child ACEs when the inheritable directory DACL is tightened.
  (Get-Item -LiteralPath $seedRoot -Force).SetAccessControl($security)
  $after=(Get-Acl -LiteralPath $seedRoot).Sddl
  Assert-ExactDirectoryDacl $after $seedSddl @('S-1-5-32-544') 'ENTRY_SEED_HARDENING_READBACK_REFUSED'
  return $after
}

Assert-TrustedAnchor 'C:\'; Assert-TrustedAnchor 'C:\ProgramData'
$sddl='O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$owner+')'
$seedSddl='O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$owner+')'
$buildSddl='O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$receiptHeld=$null;$buildHeld=$null;$executableHeld=$null;$seedGuard=$null
try {
  $prefix=if($ResumePreflightFailure){'retry-preflight.'}else{''}
  if($ResumePreflightFailure){
    if(-not (Test-Entry $root)){throw 'ENTRY_RETRY_RECEIPT_ROOT_MISSING'}
    $receiptHeld=Open-VerifiedEntry $root $true
    Assert-ExactDirectoryDacl ((Get-Acl -LiteralPath $root).Sddl) $sddl @('S-1-5-32-544') 'ENTRY_RETRY_RECEIPT_ACL_REFUSED'
    if(Test-Entry $targetRoot){throw 'ENTRY_RETRY_TARGET_EXISTS_NO_RETRY'}
    $startedBytes=Read-VerifiedBytes (Join-Path $root 'started.json')
    $finishedBytes=Read-VerifiedBytes (Join-Path $root 'finished.json')
    $originalOutput=Read-VerifiedBytes (Join-Path $root 'stdout.log')
    if((Read-VerifiedBytes (Join-Path $root 'stderr.log')).Length -ne 0){throw 'ENTRY_RETRY_ORIGINAL_STDERR_NOT_EMPTY'}
    $nonempty=@((New-Object Text.UTF8Encoding($false,$true)).GetString($originalOutput) -split '\r?\n' | Where-Object { $_.Length -gt 0 })
    $lines=@();foreach($line in $nonempty){$lines+=,(Convert-EntryJson ((New-Object Text.UTF8Encoding($false)).GetBytes($line)))}
    Assert-OriginalPreflightFailure (Convert-EntryJson $startedBytes) (Convert-EntryJson $finishedBytes) $lines
    if((Hash-Bytes (Read-VerifiedBytes (Join-Path $root 'reviewed-entry.ps1'))) -cne $sourceHash){throw 'ENTRY_RETRY_REVIEWED_SNAPSHOT_CHANGED'}
    $buildHeld=Open-VerifiedEntry $buildRoot $true
    Assert-ExactDirectoryDacl ((Get-Acl -LiteralPath $buildRoot).Sddl) $buildSddl @('S-1-5-32-544') 'ENTRY_RETRY_BUILD_ACL_REFUSED'
    if((Hash-Bytes (Read-VerifiedBytes (Join-Path $buildRoot 'CompanionTaskRegistrar.cs') 2097152)) -cne $registrarHash -or
       (Hash-Bytes (Read-VerifiedBytes (Join-Path $buildRoot 'M5bPhysicalImportAcceptance.cs') 2097152)) -cne $harnessHash){throw 'ENTRY_RETRY_PROTECTED_SOURCE_CHANGED'}
    $executableHeld=Open-VerifiedRead $exe 2097152
    if((Hash-Stream $executableHeld) -cne $executableHash){throw 'ENTRY_RETRY_EXECUTABLE_CHANGED'}
  }else{
    New-ReceiptDirectory
    $receiptHeld=Open-VerifiedEntry $root $true
    Assert-ExactDirectoryDacl ((Get-Acl -LiteralPath $root).Sddl) $sddl @('S-1-5-32-544') 'ENTRY_RECEIPT_ACL_REFUSED'
    $snapshot=Join-Path $root 'reviewed-entry.ps1';Write-New $snapshot $bytes
    Write-New (Join-Path $root 'started.json') (Json-Bytes ([ordered]@{status='STARTED';pid=$PID;at=[DateTimeOffset]::UtcNow.ToString('o');psSha256=$sourceHash;registrarSha256=$registrarHash;harnessSha256=$harnessHash;seedSha256=$seedHash}))
  }
  $seedGuard=Open-ValidatedSeed
  if($ResumePreflightFailure){
    # Exactly one retry of this completed, known no-effect preflight refusal.
    # CreateNew never clears the once marker or any first-attempt evidence.
    Write-New (Join-Path $root 'retry-preflight.started.json') (Json-Bytes ([ordered]@{status='STARTED_PREFLIGHT_FAILURE_RETRY';pid=$PID;at=[DateTimeOffset]::UtcNow.ToString('o');originalFinishedSha256=(Hash-Bytes $finishedBytes);originalStdoutSha256=(Hash-Bytes $originalOutput);psSha256=$sourceHash;registrarSha256=$registrarHash;harnessSha256=$harnessHash;executableSha256=$executableHash;seedSha256=$seedHash;seedLength=$seedLength;seedCreatedSha256=$seedGuard.createdSha256}))
  }
  $seedAfter=Protect-ValidatedSeedDirectory $seedGuard
  Write-New (Join-Path $root ($prefix+'seed-hardening.json')) (Json-Bytes ([ordered]@{path=$seedRoot;beforeSddl=$seedGuard.beforeSddl;afterSddl=$seedAfter;createdSha256=$seedGuard.createdSha256;seedSha256=$seedHash;seedLength=$seedLength;recursiveOperation=$false;fileDataWritten=$false;at=[DateTimeOffset]::UtcNow.ToString('o')}))
  # The harness itself takes an exclusive Seed handle and hashes it again
  # before creating its test root/account/tasks. Do not block its exclusive open.
  $seedGuard.seed.Dispose()
  if(Test-Entry $targetRoot){throw 'ENTRY_TARGET_EXISTS_BEFORE_START_NO_RETRY'}
  $info=New-Object Diagnostics.ProcessStartInfo
  if($ResumePreflightFailure){
    # Reuse only the protected, held, byte-bound binary from the exact failed
    # attempt. The PS compile entry would correctly refuse the existing build.
    $info.FileName=$exe;$info.Arguments='run-import '+$seedHash
  }else{
    $info.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+$snapshot+' -Execute -SourceDirectory '+$sources+' -SeedSha256 '+$seedHash+' -ExpectedRegistrarSha256 '+$registrarHash+' -ExpectedHarnessSha256 '+$harnessHash
  }
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory='C:\Windows\System32';$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear()
  foreach($entry in @(@('SystemRoot','C:\Windows'),@('windir','C:\Windows'),@('SystemDrive','C:'),@('PATH','C:\Windows\System32;C:\Windows'),@('PSModulePath',$env:PSModulePath),@('USERPROFILE','C:\Users\17531'),@('TEMP',$root),@('TMP',$root))){$info.EnvironmentVariables[$entry[0]]=$entry[1]}
  $process=New-Object Diagnostics.Process;$process.StartInfo=$info
  $stdout=[IO.File]::Open((Join-Path $root ($prefix+'stdout.log')),'CreateNew','Write','Read');$stderr=[IO.File]::Open((Join-Path $root ($prefix+'stderr.log')),'CreateNew','Write','Read')
  try {
    if(-not $process.Start()){throw 'ENTRY_CHILD_NOT_STARTED'}
    Write-New (Join-Path $root ($prefix+'child.json')) (Json-Bytes ([ordered]@{pid=$process.Id;at=[DateTimeOffset]::UtcNow.ToString('o');resumePreflightFailure=[bool]$ResumePreflightFailure}))
    $outTask=$process.StandardOutput.BaseStream.CopyToAsync($stdout);$errTask=$process.StandardError.BaseStream.CopyToAsync($stderr)
    if($ResumePreflightFailure){
      if(-not $process.WaitForExit(900000)){try{$process.Kill()}catch{};throw 'ENTRY_RETRY_CHILD_TIMEOUT_NO_RETRY'}
    }else{$process.WaitForExit()}
    if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask,$errTask),5000)){throw 'ENTRY_CHILD_OUTPUT_INCOMPLETE'}
    $stdout.Flush($true);$stderr.Flush($true)
    $report=[ordered]@{contract='clued.m5b.physical-entry/1';childExitCode=$process.ExitCode;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');targetRoot=$targetRoot;formalSupervisorQualified=$false;resumePreflightFailure=[bool]$ResumePreflightFailure}
  # A failed child may have refused an attacker-precreated root. Establish
  # actual administrator ownership and protected write authority before reads.
  $evidenceTrusted=$false
  if(Test-Path -LiteralPath $targetRoot){
    try {
      Assert-Plain $targetRoot $true;Assert-TrustedAnchor 'C:\';Assert-TrustedAnchor 'C:\ProgramData'
      $evidenceAcl=New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $targetRoot).Sddl)
      if($evidenceAcl.Owner.Value -cne 'S-1-5-32-544' -or ([int]$evidenceAcl.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or $null -eq $evidenceAcl.DiscretionaryAcl){throw 'EVIDENCE_ROOT_UNTRUSTED'}
      $seen=@{};$readers=0
      foreach($ace in $evidenceAcl.DiscretionaryAcl){
        if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or [int]$ace.AceQualifier -ne 0 -or [int]$ace.AceFlags -ne 3){throw 'EVIDENCE_ROOT_UNTRUSTED'}
        $principal=$ace.SecurityIdentifier.Value
        if(@('S-1-5-18','S-1-5-32-544') -ccontains $principal){if($ace.AccessMask -ne 0x1f01ff -or $seen.ContainsKey($principal)){throw 'EVIDENCE_ROOT_UNTRUSTED'};$seen[$principal]=$true}
        elseif($principal -cmatch '^S-1-5-21-1173730660-3877291096-655431861-[0-9]+$' -and $ace.AccessMask -eq 0x1200a9 -and $readers -eq 0){$readers++}
        else{throw 'EVIDENCE_ROOT_UNTRUSTED'}
      }
      if($seen.Count -ne 2 -or $readers -gt 1){throw 'EVIDENCE_ROOT_UNTRUSTED'}
      $evidenceTrusted=$true
    }catch{$report['evidenceStatus']='EVIDENCE_ROOT_UNTRUSTED_NO_CONTENT_READ'}
  }else{$report['evidenceStatus']='EVIDENCE_ROOT_ABSENT'}
  foreach ($name in @('manifest.json','result.json','stages.jsonl')) {
    $path=Join-Path $targetRoot $name
    if ($evidenceTrusted -and (Test-Path -LiteralPath $path)) { Assert-Plain $targetRoot $true; Write-New (Join-Path $root ($prefix+'harness.'+$name)) (Read-VerifiedBytes $path 1048576) }
  }
    Write-New (Join-Path $root ($prefix+'finished.json')) (Json-Bytes $report)
  }finally{$stdout.Dispose();$stderr.Dispose();$process.Dispose()}
}finally{
  if($null -ne $seedGuard){$seedGuard.seed.Dispose();$seedGuard.directory.Dispose()}
  if($null -ne $executableHeld){$executableHeld.Dispose()}
  if($null -ne $buildHeld){$buildHeld.Dispose()}
  if($null -ne $receiptHeld){$receiptHeld.Dispose()}
}

