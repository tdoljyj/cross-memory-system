# Exact byte-bound elevated continuation of the single registered-never-run site.
# Parent must load reviewed bytes through its clean trusted bootstrap; never -File
# a user-writable copy. This entry never registers tasks or changes their ACL.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
foreach($name in [Environment]::GetEnvironmentVariables().Keys){
 if([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)'){throw 'REGISTERED_ENTRY_ENVIRONMENT_REFUSED'}
}
$owner='S-1-5-21-1173730660-3877291096-655431861-1001'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if([Environment]::MachineName -cne 'TURING' -or $identity.User.Value -cne $owner -or
 -not [Environment]::Is64BitProcess -or
 -not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'EXACT_ELEVATED_TURING_OWNER_REQUIRED'}
$root='C:\ProgramData\CluedM5bPhysicalReceipt1109'
$buildRoot='C:\ProgramData\CluedM5bPhysicalBuild1109'
$targetRoot='C:\ProgramData\CluedM5bPhysical1109'
$source='C:\w\m5b-r3-recovery-20261109\work\independent-ci-resident-v1\windows\M5bPhysicalImportAcceptance.cs'
$harnessHash='77aca427f11cc9e6dc7201fd66f4898dc96c36ddefdefcb4e85a917b60bc0fe3'
$oldHarnessHash='52ec0731a881a94805778789f9eee3f0c1be9ecaa943cebea536b98a187659de'
$registrarHash='11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b'
$oldExeHash='7bc20b77f0e640309a1a6057eb159cb7894d04fd1c09b20797ab9120475ae403'
$manifestHash='905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb'
$stageHash='b31aa29993c78fbf3177a1a215f52ce42065dcf0df6ddc403127b236e179f5fc'
$diagnosticHash='a1a696d323c5cee006f62499cfffd533728de342e9142b34f1124fcd994f410c'
$trustedSids=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')

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

function Test-Entry([string]$Path) {
  $parent = [IO.Path]::GetDirectoryName($Path); $leaf = [IO.Path]::GetFileName($Path)
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($parent)) { if ([string]::Equals([IO.Path]::GetFileName($entry),$leaf,[StringComparison]::OrdinalIgnoreCase)) { return $true } }
  $false
}

function Assert-CompilerFileAcl([string]$Sddl) {
  $acl = New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
  if ($null -eq $acl.Owner -or $trustedSids -cnotcontains $acl.Owner.Value -or $null -eq $acl.DiscretionaryAcl) { throw 'COMPILER_FILE_OWNER_OR_DACL_REFUSED' }
  foreach ($ace in $acl.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'COMPILER_FILE_COMPLEX_ACE_REFUSED' }
    if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or
        ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0 -or $trustedSids -ccontains $ace.SecurityIdentifier.Value) { continue }
    # File data/append/EA/attribute write, delete, ownership and DACL changes,
    # including their generic write/all forms, must stay inside trusted SIDs.
    if ($ace.AccessMask -band 0x500d0116) { throw 'COMPILER_FILE_UNTRUSTED_MUTATION_RIGHTS' }
  }
}

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

function Open-VerifiedEntry([string]$Path,[bool]$Directory,[switch]$TrustedCompilerInput) {
  if ($TrustedCompilerInput) {
    $allowedCompilerInputs=@('csc.exe','System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xml.dll') | ForEach-Object {'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'+$_}
    if ($Directory -or $allowedCompilerInputs -cnotcontains $Path) { throw 'COMPILER_INPUT_PATH_REFUSED' }
    # Windows servicing uses hard links for these five system files. Their
    # shared file ACL, fixed protected pathname and held read handle prevent
    # untrusted mutation; the ordinary input path still requires one link.
    Assert-CompilerFileAcl ((Get-Acl -LiteralPath $Path).Sddl)
  }
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
       (-not $Directory -and ([Runtime.InteropServices.Marshal]::ReadInt32($information,40) -lt 1 -or
        (-not $TrustedCompilerInput -and [Runtime.InteropServices.Marshal]::ReadInt32($information,40) -ne 1)))){throw 'ENTRY_INPUT_LINK_OR_KIND_REFUSED'}
    $final=New-Object Text.StringBuilder(32768)
    $length=Native 'GetFinalPathNameByHandleW' @($handle,$final,[uint32]32768,[uint32]0)
    if($length -le 0 -or $length -ge 32768 -or -not [string]::Equals($final.ToString(),('\\?\'+[IO.Path]::GetFullPath($Path)),[StringComparison]::OrdinalIgnoreCase)){throw 'ENTRY_INPUT_FINAL_PATH_CHANGED'}
    return ,$safe
  } catch {$safe.Dispose();throw} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($information)}
}

function Open-VerifiedRead([string]$Path,[int64]$Maximum,[switch]$TrustedCompilerInput) {
  $safe=Open-VerifiedEntry $Path $false -TrustedCompilerInput:$TrustedCompilerInput
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

function Write-New([string]$Path,[byte[]]$Data) {$file=[IO.File]::Open($Path,'CreateNew','Write','Read');try{$file.Write($Data,0,$Data.Length);$file.Flush($true)}finally{$file.Dispose()}}

function Json-Bytes($Value) {return ,((New-Object Text.UTF8Encoding($false)).GetBytes(($Value|ConvertTo-Json -Depth 10 -Compress)))}

function Write-NewBytes([string]$Path,[byte[]]$Bytes) {
  $file = New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $file.Write($Bytes,0,$Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}

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

function Assert-Hash([string]$Path,[string]$Expected,[int64]$Maximum=2097152){
 $held=Open-VerifiedRead $Path $Maximum
 try{if((Hash-Stream $held) -cne $Expected){throw ('REGISTERED_ENTRY_HASH_REFUSED:'+ [IO.Path]::GetFileName($Path))};return ,$held}catch{$held.Dispose();throw}
}
function Assert-ReceiptAcl([string]$Sddl){
 $expected='O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$owner+')'
 Assert-ExactDirectoryDacl $Sddl $expected @('S-1-5-32-544') 'REGISTERED_ENTRY_RECEIPT_ACL_REFUSED'
}
function Assert-BuildAcl([string]$Sddl){
 Assert-ExactDirectoryDacl $Sddl 'O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' @('S-1-5-32-544') 'REGISTERED_ENTRY_BUILD_ACL_REFUSED'
}
$held=New-Object 'Collections.Generic.List[IDisposable]'
$started=$false
$prefix=$root+'\registered-resume.'
try{
 Assert-TrustedAnchor 'C:\';Assert-TrustedAnchor 'C:\ProgramData'
 $held.Add((Open-VerifiedEntry 'C:\' $true));$held.Add((Open-VerifiedEntry 'C:\ProgramData' $true))
 $held.Add((Open-VerifiedEntry $root $true));Assert-ReceiptAcl ((Get-Acl -LiteralPath $root).Sddl)
 Write-New ($prefix+'preflight-started.json') (Json-Bytes ([ordered]@{contract='clued.m5b.registered-resume-entry/1';phase='PREFLIGHT';pid=$PID;at=[DateTimeOffset]::UtcNow.ToString('o');harnessSourceSha256=$harnessHash;noAutomaticRetry=$true}))
 $started=$true
 $held.Add((Open-VerifiedEntry $buildRoot $true));Assert-BuildAcl ((Get-Acl -LiteralPath $buildRoot).Sddl)
 # Hold the original immutable inputs and executable files without write/delete sharing.
 $held.Add((Assert-Hash ($buildRoot+'\CompanionTaskRegistrar.cs') $registrarHash))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.cs') $oldHarnessHash))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.exe') $oldExeHash))
 $held.Add((Open-VerifiedEntry $targetRoot $true))
 $held.Add((Assert-Hash ($targetRoot+'\manifest.json') $manifestHash))
 $held.Add((Assert-Hash ($targetRoot+'\bin\M5bPhysicalImportAcceptance.exe') $oldExeHash))
 # stages must be released before the approved continuation appends its own prefix.
 $stage=Assert-Hash ($targetRoot+'\stages.jsonl') $stageHash; $stage.Dispose()
 $held.Add((Assert-Hash ($root+'\task-acl-diagnostic.json') $diagnosticHash))
 $bytes=Read-VerifiedBytes $source 2097152
 if((Hash-Bytes $bytes) -cne $harnessHash){throw 'REGISTERED_ENTRY_REVIEWED_SOURCE_CHANGED'}
 $snapshot=$buildRoot+'\M5bPhysicalImportAcceptance.resume-registered.cs'
 $exe=$buildRoot+'\M5bPhysicalImportAcceptance.resume-registered.exe'
 $receipt=$buildRoot+'\resume-registered.build.json'
 foreach($path in @($snapshot,$exe,($exe+'.config'),$receipt,($prefix+'started.json'),($prefix+'compile.log'),($prefix+'compile.log.exit'),($prefix+'run.log'),($prefix+'run.log.exit'),($prefix+'finished.json'),($prefix+'failure.json'),($targetRoot+'\resume-registered.intent'),($targetRoot+'\resume-registered.result.json'))){
  if(Test-Entry $path){throw 'REGISTERED_ENTRY_EXISTS_NO_RETRY'}
 }
 $framework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
 $compiler=$framework+'csc.exe'
 foreach($directory in @('C:\Windows','C:\Windows\Microsoft.NET','C:\Windows\Microsoft.NET\Framework64',$framework.TrimEnd('\'))){
  $held.Add((Open-VerifiedEntry $directory $true)); Assert-TrustedAnchor $directory
 }
 $referenceNames=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xml.dll')
 foreach($toolFile in @($compiler)+@($referenceNames|ForEach-Object{$framework+$_})){
  $held.Add((Open-VerifiedRead $toolFile 16777216 -TrustedCompilerInput)); Assert-CompilerFileAcl ((Get-Acl -LiteralPath $toolFile).Sddl)
 }
 Write-New ($prefix+'started.json') (Json-Bytes ([ordered]@{contract='clued.m5b.registered-resume-entry/1';status='STARTED';at=[DateTimeOffset]::UtcNow.ToString('o');pid=$PID;operatorSid=$owner;originalManifestSha256=$manifestHash;originalStageAnchorSha256=$stageHash;diagnosticSha256=$diagnosticHash;harnessSourceSha256=$harnessHash;originalMainStillFailed=$true;noAutomaticRetry=$true}))
 $started=$true
 Write-New $snapshot $bytes
 $held.Add((Assert-Hash $snapshot $harnessHash))
 # Reserve the new name with CreateNew. Only BA/SY can write inside this pinned
 # protected root; csc writes this owned reservation, never an unknown old file.
 Write-New $exe (New-Object byte[] 0)
 $references=$referenceNames | ForEach-Object {'/reference:"'+$framework+$_+'"'}
 $arguments='/nologo /noconfig /target:exe /platform:x64 /main:M5bPhysicalImportAcceptance '+($references -join ' ')+' /out:"'+$exe+'" "'+$buildRoot+'\CompanionTaskRegistrar.cs" "'+$snapshot+'"'
 $compileExit=Run-Clean $compiler $arguments ($prefix+'compile.log') 60
 if($compileExit -ne 0){throw 'REGISTERED_ENTRY_COMPILE_FAILED_NO_RETRY'}
 if(Test-Entry ($exe+'.config')){throw 'REGISTERED_ENTRY_EXE_CONFIG_REFUSED'}
 Assert-BuildAcl ((Get-Acl -LiteralPath $buildRoot).Sddl);Assert-ReceiptAcl ((Get-Acl -LiteralPath $root).Sddl)
 $exeHeld=Open-VerifiedRead $exe 2097152
 $held.Add($exeHeld);$executableHash=Hash-Stream $exeHeld
 Write-New $receipt (Json-Bytes ([ordered]@{contract='clued.m5b.registered-resume-build/1';originalManifestSha256=$manifestHash;originalRunId='5653e46c-67e6-4557-9b87-50e10202c7fd';registrarSha256=$registrarHash;harnessSourceSha256=$harnessHash;executableSha256=$executableHash;executableName='M5bPhysicalImportAcceptance.resume-registered.exe'}))
 # Runtime revalidates exact site, registered-never-run task facts and both ACL
 # layers immediately before each Task.Run. This wrapper never rewrites a task.
 $held.Add((Open-VerifiedRead $receipt 16384))
 $exitCode=Run-Clean $exe ('resume-registered '+$manifestHash) ($prefix+'run.log') 900
 $record=[ordered]@{contract='clued.m5b.registered-resume-entry/1';at=[DateTimeOffset]::UtcNow.ToString('o');childExitCode=$exitCode;originalMainStillFailed=$true;harnessSourceSha256=$harnessHash;executableSha256=$executableHash;formalSupervisorQualified=$false;output=($prefix+'run.log');noAutomaticRetry=$true}
 Write-New ($prefix+'finished.json') (Json-Bytes $record)
 $record|ConvertTo-Json -Compress
 if($exitCode -ne 0){throw 'REGISTERED_ENTRY_CHILD_FAILED_PRESERVED_NO_RETRY'}
}catch{
 if($started){
  $failure=$_
  $failureCode=if($failure.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{0,99}$'){$failure.Exception.Message}else{'REGISTERED_ENTRY_UNEXPECTED'}
  try{Write-New ($prefix+'failure.json') (Json-Bytes ([ordered]@{contract='clued.m5b.registered-resume-entry/1';at=[DateTimeOffset]::UtcNow.ToString('o');status='FAILED_PRESERVED_NO_RETRY';code=$failureCode;exceptionType=$failure.Exception.GetType().FullName;hresult=('0x{0:x8}' -f $failure.Exception.HResult);line=$failure.InvocationInfo.ScriptLineNumber;originalMainStillFailed=$true;formalSupervisorQualified=$false}))}catch{}
 }
 throw
}finally{
 for($index=$held.Count-1;$index -ge 0;$index--){$held[$index].Dispose()}
}
