# Byte-bound continuation of the exact diagnostics-publication-blocked run, once only.
# Parent must load reviewed bytes through its clean trusted bootstrap; never -File
# a user-writable copy. This entry never registers tasks or changes their ACL.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
foreach($name in [Environment]::GetEnvironmentVariables().Keys){
 if([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)'){throw 'LOGGING_ENTRY_ENVIRONMENT_REFUSED'}
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
$harnessHash='766bae28b8539b4c10df30ec83b310fc49f42d313ffead35abb494b402c17f9d'
$oldHarnessHash='52ec0731a881a94805778789f9eee3f0c1be9ecaa943cebea536b98a187659de'
$registrarHash='11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b'
$oldExeHash='7bc20b77f0e640309a1a6057eb159cb7894d04fd1c09b20797ab9120475ae403'
$manifestHash='905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb'
$stageHash='15a977379d7eedfaedc8fd80071b69cebd8716f00c36fab7f0cb3ea2e937f7cc'
$diagnosticHash='ea6ea58451214b6974aca2437f53fd21abfc4a6c9bfde4c615d8442f7a8bf1d0'
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
  $share=[uint32]1;if($Directory){$share=[uint32]3}
  $handle=Native 'CreateFileW' @($Path,[uint32]2147483648,$share,[IntPtr]::Zero,[uint32]3,$flags,[IntPtr]::Zero)
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
 try{if((Hash-Stream $held) -cne $Expected){throw ('LOGGING_ENTRY_HASH_REFUSED:'+ [IO.Path]::GetFileName($Path))};return ,$held}catch{$held.Dispose();throw}
}
function Assert-ReceiptAcl([string]$Sddl){
 $expected='O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$owner+')'
 Assert-ExactDirectoryDacl $Sddl $expected @('S-1-5-32-544') 'LOGGING_ENTRY_RECEIPT_ACL_REFUSED'
}
function Assert-BuildAcl([string]$Sddl){
 Assert-ExactDirectoryDacl $Sddl 'O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' @('S-1-5-32-544') 'LOGGING_ENTRY_BUILD_ACL_REFUSED'
}


function Public-String([string]$Text){
 $Text=[regex]::Replace($Text,'(?im)^.*(?:password|secret|credential|authorization|private[_ -]?key|BEGIN .*PRIVATE KEY|access[_-]?token|refresh[_-]?token|bearer\s+).*$','[REDACTED_SENSITIVE_LINE]')
 $Text=[regex]::Replace($Text,'(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b','[REDACTED_TOKEN]')
 if($Text.Length -gt 131072){return ($Text.Substring(0,131072)+'[TRUNCATED]')}
 $Text
}

function Public-Value($Value,[int]$Depth=0){
 if($Depth -gt 30){return '[DEPTH_LIMIT]'}
 if($null -eq $Value){return $null}
 if($Value -is [string]){return (Public-String $Value)}
 if($Value -is [Collections.IDictionary]){
  $copy=[ordered]@{}
  foreach($key in $Value.Keys){
   if([string]$key -imatch '^(?:password|pwd|secret|token|access_token|refresh_token|authorization|credential|private_?key|cookie|api_?key)$'){$copy[$key]='[REDACTED]'}
   else{$copy[$key]=Public-Value $Value[$key] ($Depth+1)}
  }
  return $copy
 }
 if($Value -is [Management.Automation.PSCustomObject]){
  $copy=[ordered]@{}
  foreach($property in $Value.PSObject.Properties){
   if($property.Name -imatch '^(?:password|pwd|secret|token|access_token|refresh_token|authorization|credential|private_?key|cookie|api_?key)$'){$copy[$property.Name]='[REDACTED]'}
   else{$copy[$property.Name]=Public-Value $property.Value ($Depth+1)}
  }
  return $copy
 }
 if($Value -is [Collections.IEnumerable]){
  $array=@(foreach($item in $Value){Public-Value $item ($Depth+1)})
  return ,$array
 }
 $Value
}

function File-Facts([string]$Path,[bool]$JsonLines=$false){
 if(-not (Test-Entry $Path)){return [ordered]@{path=$Path;exists=$false}}
 $bytes=Read-VerifiedBytes $Path 2097152
 $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($bytes)
 $facts=[ordered]@{path=$Path;exists=$true;length=$bytes.Length;sha256=(Hash-Bytes $bytes)}
 if($JsonLines){
  $facts['jsonLines']=@(foreach($line in [regex]::Split($text,'\r?\n')){if($line.Length){Public-Value ($line|ConvertFrom-Json)}})
 }else{
  try{$facts['json']=Public-Value ($text|ConvertFrom-Json)}catch{$facts['parseErrorType']=$_.Exception.GetType().FullName;$facts['filteredText']=Public-String $text}
 }
 $facts
}

function Read-FileMetadata([string]$Path){
 Assert-Plain $Path $false
 # READ_CONTROL|READ_ATTRIBUTES only; share current VM data IO, never deletion.
 $pointer=Native 'CreateFileW' @($Path,[uint32]0x20080,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]0x00200000,[IntPtr]::Zero)
 if($pointer -eq [IntPtr](-1)){throw 'LOGGING_SNAPSHOT_METADATA_OPEN_FAILED'}
 $safe=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($pointer,$true)
 $information=[Runtime.InteropServices.Marshal]::AllocHGlobal(52);$stream=$null
 try{
  if(-not (Native 'GetFileInformationByHandle' @($pointer,$information))){throw 'LOGGING_SNAPSHOT_METADATA_FAILED'}
  if(([Runtime.InteropServices.Marshal]::ReadInt32($information) -band 0x410) -ne 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($information,40) -ne 1){throw 'LOGGING_SNAPSHOT_METADATA_LINK_REFUSED'}
  $final=New-Object Text.StringBuilder(32768)
  $length=Native 'GetFinalPathNameByHandleW' @($pointer,$final,[uint32]32768,[uint32]0)
  if($length -le 0 -or $length -ge 32768 -or -not [string]::Equals($final.ToString(),('\\?\'+[IO.Path]::GetFullPath($Path)),[StringComparison]::OrdinalIgnoreCase)){throw 'LOGGING_SNAPSHOT_METADATA_PATH_REFUSED'}
  $stream=New-Object IO.FileStream($safe,[IO.FileAccess]::Read,4096,$false)
  $sddl=$stream.GetAccessControl().GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')
  $high=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($information,32);$low=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($information,36)
  [ordered]@{path=$Path;length=([uint64]$high*4294967296+[uint64]$low);sddl=$sddl;links=1;metadataOnly=$true}
 }finally{if($null -ne $stream){$stream.Dispose()}else{$safe.Dispose()};[Runtime.InteropServices.Marshal]::FreeHGlobal($information)}
}
function Snapshot-File([string]$Path,[bool]$Lines=$false){
 try{File-Facts $Path $Lines}catch{[ordered]@{path=$Path;readErrorType=$_.Exception.GetType().FullName;hresult=('0x{0:X8}' -f $_.Exception.HResult)}}
}
function Export-LoggingSnapshot {
 $snapshotHeld=New-Object 'Collections.Generic.List[IDisposable]'
 $report=[ordered]@{contract='clued.m5b.logging-blocked-snapshot/1';observedAt=[DateTimeOffset]::UtcNow.ToString('o');pid=$PID;originalMainStillFailed=$true;originalRegisteredContinuationStillFailed=$true;originalDiskAccessCorrectionStillFailed=$true;formalSupervisorQualified=$false;tasks=@();files=@()}
 try{
  # Read task metadata regardless of the child result, without Run or Refresh.
  try{
   $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$folder=$scheduler.GetFolder('\CluedM5bPhysical1109')
   $report['folderPath']=$folder.Path;$report['folderSddl']=$folder.GetSecurityDescriptor(7)
   foreach($name in @('CluedCIResidentCompanionWslImport','TestHeartbeat')){
    try{
     $task=$folder.GetTask($name)
     $actions=@(foreach($action in $task.Definition.Actions){[ordered]@{path=$action.Path;argumentsSha256=(Hash-Bytes ([Text.Encoding]::UTF8.GetBytes([string]$action.Arguments)))}})
     $report.tasks+=[ordered]@{name=$name;path=$task.Path;sddl=$task.GetSecurityDescriptor(7);principal=$task.Definition.Principal.UserId;logonType=$task.Definition.Principal.LogonType;runLevel=$task.Definition.Principal.RunLevel;state=$task.State;lastTaskResult=$task.LastTaskResult;lastRunTime=$task.LastRunTime.ToString('o');instances=$task.GetInstances(0).Count;triggers=$task.Definition.Triggers.Count;actions=$actions}
    }catch{$report.tasks+=[ordered]@{name=$name;errorType=$_.Exception.GetType().FullName;hresult=('0x{0:X8}' -f $_.Exception.HResult)}}
   }
  }catch{$report['schedulerErrorType']=$_.Exception.GetType().FullName}
  try{
   Assert-TrustedAnchor 'C:\';Assert-TrustedAnchor 'C:\ProgramData'
   foreach($path in @($targetRoot,($targetRoot+'\bin'),($targetRoot+'\batch'),($targetRoot+'\results'))){
    $snapshotHeld.Add((Open-VerifiedEntry $path $true))
    $mask=if($path -ceq ($targetRoot+'\batch') -or $path -ceq ($targetRoot+'\results')){'0x1301bf'}else{'0x1200a9'}
    $expected='O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;'+$mask+';;;S-1-5-21-1173730660-3877291096-655431861-1016)'
    Assert-ExactDirectoryDacl ((Get-Acl -LiteralPath $path).Sddl) $expected @('S-1-5-32-544') 'LOGGING_SNAPSHOT_DIRECTORY_REFUSED'
   }
   foreach($name in @('manifest.json','resume-registered.intent','resume-registered.result.json','disk-access-correction.intent','disk-access-correction.result.json','logging-blocked.intent','logging-blocked.result.json')){$report.files+=Snapshot-File ($targetRoot+'\'+$name)}
   $report.files+=Snapshot-File ($targetRoot+'\stages.jsonl') $true
   $report.files+=Snapshot-File ($targetRoot+'\batch\companion-wsl-import-result.json')
   foreach($name in @('test-heartbeat.json','test-heartbeat-failure.json','test-heartbeat-client-validation.json','test-heartbeat-wsl-probe.json')){$report.files+=Snapshot-File ($targetRoot+'\results\'+$name)}
   $entries=@();$entryCount=0
   foreach($path in [IO.Directory]::EnumerateFileSystemEntries($targetRoot)){
    if(++$entryCount -gt 100){throw 'LOGGING_SNAPSHOT_TOO_MANY_ROOT_ENTRIES'}
    $name=[IO.Path]::GetFileName($path);$attributes=[IO.File]::GetAttributes($path)
    $entries+=[ordered]@{name=(Public-String $name);reparsePoint=(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)}
    if($name -cmatch '^(?:resume-registered|disk-access-correction|logging-blocked)\.failure\.[0-9a-f-]{36}\.json$'){$report.files+=Snapshot-File $path}
   }
   $report['rootEntries']=$entries
   try{$report['disk']=Read-FileMetadata ($targetRoot+'\batch\ext4.vhdx')}catch{$report['diskMetadataErrorType']=$_.Exception.GetType().FullName;$report['diskMetadataHresult']=('0x{0:X8}' -f $_.Exception.HResult)}
  }catch{$report['fileCollectionErrorType']=$_.Exception.GetType().FullName;$report['fileCollectionHresult']=('0x{0:X8}' -f $_.Exception.HResult)}
  $report['finishedAt']=[DateTimeOffset]::UtcNow.ToString('o')
  $data=(New-Object Text.UTF8Encoding($false)).GetBytes(($report|ConvertTo-Json -Depth 40 -Compress))
  if($data.Length -gt 4194304){throw 'LOGGING_SNAPSHOT_TOO_LARGE'}
  Assert-ReceiptAcl ((Get-Acl -LiteralPath $root).Sddl)
  Write-New ($prefix+'snapshot.json') $data
 }finally{for($i=$snapshotHeld.Count-1;$i -ge 0;$i--){$snapshotHeld[$i].Dispose()}}
}
$held=New-Object 'Collections.Generic.List[IDisposable]'
$started=$false
$prefix=$root+'\logging-blocked.'
try{
 Assert-TrustedAnchor 'C:\';Assert-TrustedAnchor 'C:\ProgramData'
 $held.Add((Open-VerifiedEntry 'C:\' $true));$held.Add((Open-VerifiedEntry 'C:\ProgramData' $true))
 $held.Add((Open-VerifiedEntry $root $true));Assert-ReceiptAcl ((Get-Acl -LiteralPath $root).Sddl)
 Write-New ($prefix+'preflight-started.json') (Json-Bytes ([ordered]@{contract='clued.m5b.logging-blocked-entry/1';phase='PREFLIGHT';pid=$PID;at=[DateTimeOffset]::UtcNow.ToString('o');harnessSourceSha256=$harnessHash;noAutomaticRetry=$true}))
 $started=$true
 $held.Add((Open-VerifiedEntry $buildRoot $true));Assert-BuildAcl ((Get-Acl -LiteralPath $buildRoot).Sddl)
 $held.Add((Assert-Hash ($buildRoot+'\CompanionTaskRegistrar.cs') $registrarHash))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.cs') $oldHarnessHash))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.exe') $oldExeHash))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.resume-registered.cs') '77aca427f11cc9e6dc7201fd66f4898dc96c36ddefdefcb4e85a917b60bc0fe3'))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.resume-registered.exe') '5e8238559a948de563487650d2cb3e781472f072af788f8edf96516a6ea52f7e'))
 $held.Add((Assert-Hash ($buildRoot+'\resume-registered.build.json') '9230db280d93807247f9aa643650e62fc7c14e20a489a93e29b6546ecb13fc9e'))
 foreach($name in @('','\bin','\batch','\results')){$held.Add((Open-VerifiedEntry ($targetRoot+$name) $true))}
 $held.Add((Assert-Hash ($targetRoot+'\manifest.json') $manifestHash))
 $held.Add((Assert-Hash ($targetRoot+'\bin\M5bPhysicalImportAcceptance.exe') $oldExeHash))
 $held.Add((Assert-Hash ($targetRoot+'\resume-registered.intent') '5815ef0413940a0ee73b01ac4ec1bd6df19d99acd84f106d9e5e8bd5c08efce7'))
 $held.Add((Assert-Hash ($targetRoot+'\resume-registered.failure.0193d0fe-ff92-4b46-b3cf-97169873ed14.json') 'c04f56a83024f3e7c0eed92e4105c3c24b2b43c2b399921877db1356820ff159'))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.disk-access-correction.cs') 'cf04a44ad504bc44d0f043bf69c420b2439879ff928f45a978e78d31bacd02af'))
 $held.Add((Assert-Hash ($buildRoot+'\M5bPhysicalImportAcceptance.disk-access-correction.exe') 'f3b44379c4c18a1caff34eafdd659d6d718c854cc2900336b73973f3803825f0'))
 $held.Add((Open-VerifiedRead ($buildRoot+'\disk-access-correction.build.json') 16384))
 $held.Add((Assert-Hash ($targetRoot+'\disk-access-correction.intent') '2fd519c1e9762df3e177674c739f8414cbb1917fc9cb9a0163f662c83c6660ac'))
 $held.Add((Assert-Hash ($targetRoot+'\disk-access-correction.failure.797eaaa9-e19e-4d2f-8ddb-727348fea693.json') '8091c1afe06b09ff1e9d8dea29655fb52529dbecf26fd58d124242b0dee07bef'))
 $stage=Assert-Hash ($targetRoot+'\stages.jsonl') $stageHash;$stage.Dispose()
 $held.Add((Assert-Hash ($root+'\disk-access-correction.snapshot.json') $diagnosticHash))
 $bytes=Read-VerifiedBytes $source 2097152
 if((Hash-Bytes $bytes) -cne $harnessHash){throw 'LOGGING_ENTRY_REVIEWED_SOURCE_CHANGED'}
 $snapshot=$buildRoot+'\M5bPhysicalImportAcceptance.logging-blocked.cs'
 $exe=$buildRoot+'\M5bPhysicalImportAcceptance.logging-blocked.exe'
 $receipt=$buildRoot+'\logging-blocked.build.json'
 foreach($path in @($snapshot,$exe,($exe+'.config'),$receipt,($prefix+'started.json'),($prefix+'compile.log'),($prefix+'compile.log.exit'),($prefix+'run.log'),($prefix+'run.log.exit'),($prefix+'finished.json'),($prefix+'failure.json'),($prefix+'snapshot.json'),($prefix+'snapshot-failure.json'),($targetRoot+'\logging-blocked.intent'),($targetRoot+'\logging-blocked.result.json'))){
  if(Test-Entry $path){throw 'LOGGING_ENTRY_EXISTS_NO_RETRY'}
 }
 $framework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\';$compiler=$framework+'csc.exe'
 foreach($directory in @('C:\Windows','C:\Windows\Microsoft.NET','C:\Windows\Microsoft.NET\Framework64',$framework.TrimEnd('\'))){$held.Add((Open-VerifiedEntry $directory $true));Assert-TrustedAnchor $directory}
 $referenceNames=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xml.dll')
 foreach($toolFile in @($compiler)+@($referenceNames|ForEach-Object{$framework+$_})){$held.Add((Open-VerifiedRead $toolFile 16777216 -TrustedCompilerInput));Assert-CompilerFileAcl ((Get-Acl -LiteralPath $toolFile).Sddl)}
 Write-New ($prefix+'started.json') (Json-Bytes ([ordered]@{contract='clued.m5b.logging-blocked-entry/1';status='STARTED';pid=$PID;operatorSid=$owner;at=[DateTimeOffset]::UtcNow.ToString('o');originalManifestSha256=$manifestHash;failedStageAnchorSha256=$stageHash;postImportDiagnosticSha256=$diagnosticHash;harnessSourceSha256=$harnessHash;originalMainStillFailed=$true;originalRegisteredContinuationStillFailed=$true;originalDiskAccessCorrectionStillFailed=$true;noAutomaticRetry=$true}))
 Write-New $snapshot $bytes;$held.Add((Assert-Hash $snapshot $harnessHash))
 Write-New $exe (New-Object byte[] 0)
 $references=$referenceNames|ForEach-Object{'/reference:"'+$framework+$_+'"'}
 $arguments='/nologo /noconfig /target:exe /platform:x64 /main:M5bPhysicalImportAcceptance '+($references -join ' ')+' /out:"'+$exe+'" "'+$buildRoot+'\CompanionTaskRegistrar.cs" "'+$snapshot+'"'
 $compileExit=Run-Clean $compiler $arguments ($prefix+'compile.log') 60
 if($compileExit -ne 0){throw 'LOGGING_ENTRY_COMPILE_FAILED_NO_RETRY'}
 if(Test-Entry ($exe+'.config')){throw 'LOGGING_ENTRY_EXE_CONFIG_REFUSED'}
 Assert-BuildAcl ((Get-Acl -LiteralPath $buildRoot).Sddl);Assert-ReceiptAcl ((Get-Acl -LiteralPath $root).Sddl)
 $exeHeld=Open-VerifiedRead $exe 2097152;$held.Add($exeHeld);$executableHash=Hash-Stream $exeHeld
 Write-New $receipt (Json-Bytes ([ordered]@{contract='clued.m5b.logging-blocked-build/1';originalManifestSha256=$manifestHash;originalRunId='5653e46c-67e6-4557-9b87-50e10202c7fd';registrarSha256=$registrarHash;failedResumeExecutableSha256='5e8238559a948de563487650d2cb3e781472f072af788f8edf96516a6ea52f7e';failedCorrectionExecutableSha256='f3b44379c4c18a1caff34eafdd659d6d718c854cc2900336b73973f3803825f0';harnessSourceSha256=$harnessHash;executableSha256=$executableHash;executableName='M5bPhysicalImportAcceptance.logging-blocked.exe'}))
 $held.Add((Open-VerifiedRead $receipt 16384))
 $exitCode=Run-Clean $exe ('logging-blocked '+$manifestHash) ($prefix+'run.log') 900
 $record=[ordered]@{contract='clued.m5b.logging-blocked-entry/1';at=[DateTimeOffset]::UtcNow.ToString('o');childExitCode=$exitCode;originalMainStillFailed=$true;originalRegisteredContinuationStillFailed=$true;originalDiskAccessCorrectionStillFailed=$true;harnessSourceSha256=$harnessHash;executableSha256=$executableHash;formalSupervisorQualified=$false;output=($prefix+'run.log');noAutomaticRetry=$true}
 Write-New ($prefix+'finished.json') (Json-Bytes $record);$record|ConvertTo-Json -Compress
 if($exitCode -ne 0){throw 'LOGGING_ENTRY_CHILD_FAILED_PRESERVED_NO_RETRY'}
}catch{
 if($started){
  $failure=$_
  $failureCode=if($failure.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{0,99}$'){$failure.Exception.Message}else{'LOGGING_ENTRY_UNEXPECTED'}
  try{Write-New ($prefix+'failure.json') (Json-Bytes ([ordered]@{contract='clued.m5b.logging-blocked-entry/1';at=[DateTimeOffset]::UtcNow.ToString('o');status='FAILED_PRESERVED_NO_RETRY';code=$failureCode;exceptionType=$failure.Exception.GetType().FullName;hresult=('0x{0:x8}' -f $failure.Exception.HResult);line=$failure.InvocationInfo.ScriptLineNumber;originalMainStillFailed=$true;originalRegisteredContinuationStillFailed=$true;originalDiskAccessCorrectionStillFailed=$true;formalSupervisorQualified=$false}))}catch{}
 }
 throw
}finally{
 # Collect actual post-action facts even for nonzero/unknown child outcomes.
 # Never re-run the child or its tasks because collection failed.
 if($started){
  try{Export-LoggingSnapshot}catch{
   try{Write-New ($prefix+'snapshot-failure.json') (Json-Bytes ([ordered]@{status='SNAPSHOT_FAILED_PRESERVED';exceptionType=$_.Exception.GetType().FullName;hresult=('0x{0:X8}' -f $_.Exception.HResult);noAutomaticRetry=$true}))}catch{}
  }
 }
 for($index=$held.Count-1;$index -ge 0;$index--){$held[$index].Dispose()}
}