# Opt-in one-UAC account maintenance. Dot-sourcing defines functions only.
# Host authorization/GitHub evidence is explicitly a trusted Owner/Root Host
# statement, never an independent machine proof. Local facts are read here.
function ConvertFrom-CompanionMaintenanceJson([byte[]]$Bytes) {
  [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $parser=New-Object Web.Script.Serialization.JavaScriptSerializer;$parser.MaxJsonLength=1048576
  $value=$parser.DeserializeObject((New-Object Text.UTF8Encoding($false,$true)).GetString($Bytes))
  if($value -isnot [Collections.IDictionary]){throw 'MAINTENANCE_JSON_OBJECT_REQUIRED'}
  return ,$value
}
function Get-CompanionMaintenanceHash([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function ConvertTo-CompanionMaintenanceBytes($Value) {return ,([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Value -Depth 30 -Compress)))}
function Get-CompanionMaintenanceField($Value,[string]$Name) {
  if($Value -isnot [Collections.IDictionary] -or @($Value.Keys) -cnotcontains $Name){throw ('MAINTENANCE_FIELD_REQUIRED:'+ $Name)}
  return ,$Value[$Name]
}
function Assert-CompanionMaintenanceEqual($Actual,$Expected,[string]$Code) {
  if($null -eq $Expected){if($null -ne $Actual){throw $Code};return}
  if($Expected -is [Collections.IDictionary]){
    if($Actual -isnot [Collections.IDictionary] -or $Actual.Count -ne $Expected.Count){throw $Code}
    foreach($key in $Expected.Keys){if(@($Actual.Keys) -cnotcontains $key){throw $Code};Assert-CompanionMaintenanceEqual $Actual[$key] $Expected[$key] $Code};return
  }
  if($Expected -is [Array]){
    if($Actual -isnot [Array] -or $Actual.Count -ne $Expected.Count){throw $Code}
    for($i=0;$i -lt $Expected.Count;$i++){Assert-CompanionMaintenanceEqual $Actual[$i] $Expected[$i] $Code};return
  }
  if($Expected -is [string]){if($Actual -isnot [string] -or $Actual -cne $Expected){throw $Code};return}
  if($Expected -is [bool]){if($Actual -isnot [bool] -or $Actual -ne $Expected){throw $Code};return}
  if($Expected -is [int] -or $Expected -is [long]){if(($Actual -isnot [int] -and $Actual -isnot [long]) -or $Actual -ne $Expected){throw $Code};return}
  throw 'MAINTENANCE_EXPECTATION_TYPE_REFUSED'
}
function Assert-CompanionMaintenanceFields($Actual,$Expected,[string]$Code) {
  foreach($key in $Expected.Keys){Assert-CompanionMaintenanceEqual (Get-CompanionMaintenanceField $Actual $key) $Expected[$key] $Code}
}
function Assert-CompanionMaintenanceFresh($Value,[DateTimeOffset]$Now) {
  $created=Get-CompanionMaintenanceField $Value 'createdAt';$expires=Get-CompanionMaintenanceField $Value 'expiresAt'
  if($created -isnot [string] -or $expires -isnot [string]){throw 'MAINTENANCE_TIME_INVALID'}
  $start=[DateTimeOffset]::ParseExact($created,'o',[Globalization.CultureInfo]::InvariantCulture)
  $end=[DateTimeOffset]::ParseExact($expires,'o',[Globalization.CultureInfo]::InvariantCulture)
  if($end -le $start -or ($end-$start).TotalSeconds -gt 120 -or $start -gt $Now -or $end -le $Now -or ($Now-$start).TotalSeconds -gt 120){throw 'MAINTENANCE_AUTHORITY_EXPIRED'}
}
function Assert-CompanionMaintenanceNames($Names,[string]$Code) {
  if($Names -isnot [Array] -or $Names.Count -gt 256){throw $Code};$seen=@{}
  foreach($name in $Names){if($name -isnot [string] -or $name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\z' -or $seen.ContainsKey($name.ToLowerInvariant())){throw $Code};$seen[$name.ToLowerInvariant()]=$true}
}
function Assert-CompanionMaintenanceSubject($Subject) {
  foreach($key in @('packageManifestSha256','ciSourceManifestSha256','residentManifestSha256','installReceiptSha256','rearmSha256')){
    $v=Get-CompanionMaintenanceField $Subject $key;if($v -isnot [string] -or $v -cnotmatch '^[0-9a-f]{64}\z'){throw 'MAINTENANCE_SUBJECT_HASH_INVALID'}
  }
  foreach($key in @('node','runnerService','wslDistribution')){$v=Get-CompanionMaintenanceField $Subject $key;if($v -isnot [string] -or $v -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\z'){throw 'MAINTENANCE_SUBJECT_NAME_INVALID'}}
  foreach($key in @('operatorSid','companionSid')){if((Get-CompanionMaintenanceField $Subject $key) -cnotmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z'){throw 'MAINTENANCE_OPERATOR_INVALID'}}
  foreach($key in @('vhdxPath','targetVhdxPath','runnerBinary','runnerSddl')){if((Get-CompanionMaintenanceField $Subject $key) -isnot [string] -or $Subject[$key].Length -eq 0){throw 'MAINTENANCE_SUBJECT_FIELD_INVALID'}}
  foreach($key in @('vhdxPath','targetVhdxPath')){if($Subject[$key] -cnotmatch '^[A-Z]:\\[^\r\n"<>|]*\\ext4\.vhdx\z'){throw 'MAINTENANCE_VHD_PATH_INVALID'}}
}
function Assert-CompanionMaintenanceHost($Evidence,$Challenge,[DateTimeOffset]$Now,[switch]$RequireInventory) {
  Assert-CompanionMaintenanceFields $Evidence @{contract='clued.companion-maintenance.host/1';trust='OWNER_ROOT_HOST_ATTESTATION';operationId=$Challenge.operationId;nonce=$Challenge.nonce;pid=$Challenge.pid;processStartedAt=$Challenge.processStartedAt;phase=$Challenge.phase;subject=$Challenge.subject;pausedSha256=$Challenge.pausedSha256;coveredWsl=$Challenge.coveredWsl} 'MAINTENANCE_HOST_SUBJECT_MISMATCH'
  Assert-CompanionMaintenanceFresh $Evidence $Now
  $grant=Get-CompanionMaintenanceField $Evidence 'grant'
  Assert-CompanionMaintenanceFields $grant @{current=$true;status='granted';subject=$Challenge.subject;coveredWsl=$Challenge.coveredWsl;services=@('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker');actions=@('service.stop','service.start','wsl.shutdown','companion.account-switch')} 'MAINTENANCE_CURRENT_GRANT_REQUIRED'
  foreach($key in @('id','version','receiptRef')){$v=Get-CompanionMaintenanceField $grant $key;if($v -isnot [string] -or $v.Length -lt 1 -or $v.Length -gt 500){throw 'MAINTENANCE_GRANT_RECEIPT_REQUIRED'}}
  Assert-CompanionMaintenanceFresh $grant $Now
  if($RequireInventory){
    $inventory=Get-CompanionMaintenanceField $Evidence 'github'
    Assert-CompanionMaintenanceFields $inventory @{complete=$true;paginationComplete=$true;allAffectedRepositoriesCovered=$true;wholeVmAllUsersCovered=$true;runnerInventoryComplete=$true;nonterminalRuns=@();coveredWsl=$Challenge.coveredWsl} 'MAINTENANCE_GITHUB_UNKNOWN_OR_ACTIVE'
    Assert-CompanionMaintenanceFresh $inventory $Now
    $repos=Get-CompanionMaintenanceField $inventory 'repositories'
    if($repos -isnot [Array] -or $repos.Count -eq 0 -or $repos.Count -gt 256){throw 'MAINTENANCE_GITHUB_REPOSITORIES_REQUIRED'}
    $repoSeen=@{};foreach($repo in $repos){if($repo -isnot [string] -or $repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\z' -or $repoSeen.ContainsKey($repo.ToLowerInvariant())){throw 'MAINTENANCE_GITHUB_REPOSITORIES_REQUIRED'};$repoSeen[$repo.ToLowerInvariant()]=$true}
    $reads=Get-CompanionMaintenanceField $inventory 'repositoryInventories';if($reads -isnot [Array] -or $reads.Count -ne $repos.Count){throw 'MAINTENANCE_GITHUB_READ_EVIDENCE_REQUIRED'}
    $readSeen=@{};foreach($read in $reads){
      Assert-CompanionMaintenanceFields $read @{paginationComplete=$true;nonterminalRuns=@()} 'MAINTENANCE_GITHUB_UNKNOWN_OR_ACTIVE'
      if($read.repository -isnot [string] -or -not $repoSeen.ContainsKey($read.repository.ToLowerInvariant()) -or $readSeen.ContainsKey($read.repository.ToLowerInvariant()) -or $read.pagesRead -isnot [int] -or $read.pagesRead -lt 1 -or $read.totalCount -isnot [int] -or $read.totalCount -lt 0 -or $read.evidenceRef -isnot [string] -or $read.evidenceRef.Length -eq 0){throw 'MAINTENANCE_GITHUB_READ_EVIDENCE_REQUIRED'};$readSeen[$read.repository.ToLowerInvariant()]=$true
    }
    $runners=Get-CompanionMaintenanceField $inventory 'runnerHolds'
    if($runners -isnot [Array] -or $runners.Count -eq 0 -or $runners.Count -gt 512){throw 'MAINTENANCE_RUNNER_HOLDS_REQUIRED'}
    $runnerIds=Get-CompanionMaintenanceField $inventory 'affectedRunnerIds';if($runnerIds -isnot [Array] -or $runnerIds.Count -ne $runners.Count){throw 'MAINTENANCE_RUNNER_HOLDS_INCOMPLETE'}
    $covered=@{};$runnerSeen=@{};foreach($runner in $runners){
      Assert-CompanionMaintenanceFields $runner @{acceptsNewJobs=$false;activeJobs=@();holdActive=$true} 'MAINTENANCE_RUNNER_NOT_HELD'
      foreach($key in @('runnerId','evidenceRef','holdMechanism')){if((Get-CompanionMaintenanceField $runner $key) -isnot [string] -or $runner[$key].Length -eq 0){throw 'MAINTENANCE_RUNNER_HOLD_EVIDENCE_REQUIRED'}}
      if($runnerIds -cnotcontains $runner.runnerId -or $runnerSeen.ContainsKey($runner.runnerId)){throw 'MAINTENANCE_RUNNER_HOLDS_INCOMPLETE'};$runnerSeen[$runner.runnerId]=$true
      $wsl=Get-CompanionMaintenanceField $runner 'wsl';if($wsl -isnot [string] -or $Challenge.coveredWsl -cnotcontains $wsl){throw 'MAINTENANCE_RUNNER_WSL_UNCOVERED'};$covered[$wsl]=$true
    }
    foreach($wsl in $Challenge.coveredWsl){if(-not $covered.ContainsKey($wsl)){throw 'MAINTENANCE_RUNNER_WSL_UNCOVERED'}}
  }
}
function Assert-CompanionMaintenanceAcl([string]$Sddl,[string]$OwnerSid,[switch]$PrivateDrop,[switch]$Anchor,[switch]$InheritedFile,[switch]$AllowReadOnlyOthers) {
  $raw=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
  $trusted=@('S-1-5-18','S-1-5-32-544');if($Anchor){$trusted+=,'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'};if($PrivateDrop){$trusted+=,$OwnerSid}
  if($null -eq $raw.Owner -or $trusted -cnotcontains $raw.Owner.Value -or $null -eq $raw.DiscretionaryAcl){throw 'MAINTENANCE_PATH_OWNER_REFUSED'}
  if(-not $Anchor -and -not $InheritedFile -and ([int]$raw.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0){throw 'MAINTENANCE_PATH_DACL_NOT_PROTECTED'}
  foreach($ace in $raw.DiscretionaryAcl){
    if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback){throw 'MAINTENANCE_COMPLEX_ACE_REFUSED'}
    if([int]$ace.AceQualifier -ne 0 -or ([int]$ace.AceFlags -band 8)){continue}
    $sid=$ace.SecurityIdentifier.Value
    if($trusted -ccontains $sid){continue}
    $danger=if($Anchor){0x500d0040}else{0x500d0156}
    if(($ace.AccessMask -band $danger) -ne 0){throw 'MAINTENANCE_PATH_EXTERNAL_WRITE_REFUSED'}
    if(-not $Anchor -and -not $AllowReadOnlyOthers -and $sid -cne $OwnerSid){throw 'MAINTENANCE_PATH_EXTERNAL_READER_REFUSED'}
  }
}
function Initialize-CompanionMaintenanceNative {
  if($null -ne (Get-Variable -Name CompanionMaintenanceNative -Scope Script -ErrorAction SilentlyContinue)){return}
  $name=New-Object Reflection.AssemblyName('CompanionMaintenance'+[guid]::NewGuid().ToString('N'))
  $asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly($name,[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$asm.DefineDynamicModule($name.Name);$builder=$module.DefineType('MaintenanceNative',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  foreach($spec in @(@{name='CreateDirectoryW';returns=[bool];parameters=[type[]]@([string],[IntPtr])},@{name='CreateFileW';returns=[IntPtr];parameters=[type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])},@{name='GetFileInformationByHandle';returns=[bool];parameters=[type[]]@([IntPtr],[IntPtr])},@{name='GetFinalPathNameByHandleW';returns=[uint32];parameters=[type[]]@([IntPtr],[Text.StringBuilder],[uint32],[uint32])})){
    $method=$builder.DefinePInvokeMethod($spec.name,'kernel32.dll',$spec.name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$spec.returns,$spec.parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  };$script:CompanionMaintenanceNative=$builder.CreateType()
}
function Invoke-CompanionMaintenanceNative([string]$Name,[object[]]$Arguments) {
  Initialize-CompanionMaintenanceNative;$raw=New-Object object[] $Arguments.Length
  for($i=0;$i -lt $Arguments.Length;$i++){$raw[$i]=if($null -eq $Arguments[$i]){$null}else{$Arguments[$i].PSObject.BaseObject}}
  $script:CompanionMaintenanceNative.GetMethod($Name).Invoke($null,$raw)
}
function Open-CompanionMaintenanceEntry([string]$Path,[bool]$Directory,[switch]$MetadataOnly,[switch]$Live,[switch]$SystemConsoleImage) {
  $full=[IO.Path]::GetFullPath($Path);if($full -cnotmatch '^[A-Z]:\\' -or $full.StartsWith('\\') -or $full.Substring(2).Contains(':')){throw 'MAINTENANCE_PATH_SHAPE_REFUSED'}
  if($SystemConsoleImage -and ($Directory -or -not [string]::Equals($full,'C:\Windows\System32\conhost.exe',[StringComparison]::OrdinalIgnoreCase))){throw 'MAINTENANCE_SYSTEM_IMAGE_PATH_REFUSED'}
  $walk=$full;while($walk){$item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MAINTENANCE_REPARSE_REFUSED'};$parent=[IO.Path]::GetDirectoryName($walk.TrimEnd('\'));if($parent -eq $walk){break};$walk=$parent}
  $flags=[uint32]0x00200000;if($Directory){$flags=[uint32]0x02200000}
  # Static Source bytes deny write/delete sharing. Directory handles allow
  # child atomic publication but deny moving the directory itself. Live file
  # observations allow replacement and prove identity again after the read.
  $access=[uint32]2147483648;$share=[uint32]1
  if($Directory){$share=[uint32]3}
  if($Live){$share=[uint32]7}
  if($MetadataOnly){$access=[uint32]0x80;$share=[uint32]7}
  $handle=Invoke-CompanionMaintenanceNative 'CreateFileW' @($full,$access,$share,[IntPtr]::Zero,[uint32]3,$flags,[IntPtr]::Zero)
  if($handle -eq [IntPtr](-1)){throw 'MAINTENANCE_OPEN_FAILED'};$safe=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($handle,$true)
  $info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try{
    if(-not (Invoke-CompanionMaintenanceNative 'GetFileInformationByHandle' @($handle,$info))){throw 'MAINTENANCE_INFORMATION_FAILED'}
    $attr=[Runtime.InteropServices.Marshal]::ReadInt32($info)
    $links=[Runtime.InteropServices.Marshal]::ReadInt32($info,40)
    if(($attr -band 0x400) -ne 0 -or (($attr -band 0x10) -ne 0) -ne $Directory -or (-not $Directory -and ($links -lt 1 -or ($links -ne 1 -and -not $SystemConsoleImage)))){throw 'MAINTENANCE_LINK_OR_KIND_REFUSED'}
    $final=New-Object Text.StringBuilder(32768);$length=Invoke-CompanionMaintenanceNative 'GetFinalPathNameByHandleW' @($handle,$final,[uint32]32768,[uint32]0)
    if($length -le 0 -or $length -ge 32768 -or -not [string]::Equals($final.ToString(),('\\?\'+$full),[StringComparison]::OrdinalIgnoreCase)){throw 'MAINTENANCE_FINAL_PATH_REFUSED'}
    return ,$safe
  }catch{$safe.Dispose();throw}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}
}
function Get-CompanionMaintenanceHandleState($Handle,[switch]$SystemConsoleImage) {
  $info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try{
    if(-not (Invoke-CompanionMaintenanceNative 'GetFileInformationByHandle' @($Handle.DangerousGetHandle(),$info))){throw 'MAINTENANCE_INFORMATION_FAILED'}
    $links=[Runtime.InteropServices.Marshal]::ReadInt32($info,40)
    if(([Runtime.InteropServices.Marshal]::ReadInt32($info) -band 0x410) -ne 0 -or $links -lt 1 -or ($links -ne 1 -and -not $SystemConsoleImage)){throw 'MAINTENANCE_LINK_OR_KIND_REFUSED'}
    return ((@(0,20,24,28,32,36,40,44,48)|ForEach-Object{[Runtime.InteropServices.Marshal]::ReadInt32($info,$_).ToString([Globalization.CultureInfo]::InvariantCulture)}) -join ':')
  }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}
}
function Read-CompanionMaintenanceStreamBytes($Stream,[int]$Maximum) {
  if($Stream.Length -gt $Maximum){throw 'MAINTENANCE_FILE_TOO_LARGE'}
  $memory=New-Object IO.MemoryStream;$buffer=New-Object byte[] 4096
  try{while(($count=$Stream.Read($buffer,0,[Math]::Min($buffer.Length,$Maximum-[int]$memory.Length+1))) -gt 0){$memory.Write($buffer,0,$count);if($memory.Length -gt $Maximum){throw 'MAINTENANCE_FILE_TOO_LARGE'}};return ,$memory.ToArray()}finally{$memory.Dispose()}
}
function Read-CompanionMaintenanceBytes([string]$Path,[int]$Maximum=1048576,[switch]$Live,[string]$OwnerSid,[switch]$PrivateDrop,[switch]$AllowReadOnlyOthers,[switch]$MachineImage,[switch]$SystemConsoleImage) {
  if($MachineImage -and @('C:\Program Files\WSL\wsl.exe','C:\Program Files\WSL\wslhost.exe','C:\Windows\System32\conhost.exe') -inotcontains $Path){throw 'MAINTENANCE_SYSTEM_IMAGE_PATH_REFUSED'}
  if($SystemConsoleImage -and -not $MachineImage){throw 'MAINTENANCE_SYSTEM_IMAGE_PATH_REFUSED'}
  $safe=Open-CompanionMaintenanceEntry $Path $false -Live:$Live -SystemConsoleImage:$SystemConsoleImage;$stream=$null
  try{
    $stream=New-Object IO.FileStream($safe,[IO.FileAccess]::Read,4096,$false)
    if($MachineImage){Assert-CompanionMaintenanceMachineImageAcl ($stream.GetAccessControl().GetSecurityDescriptorSddlForm('All'))}
    $acl=$null;if($OwnerSid){$acl=$stream.GetAccessControl().GetSecurityDescriptorSddlForm('All');Assert-CompanionMaintenanceAcl $acl $OwnerSid -PrivateDrop:$PrivateDrop -InheritedFile -AllowReadOnlyOthers:$AllowReadOnlyOthers}
    $before=Get-CompanionMaintenanceHandleState $safe -SystemConsoleImage:$SystemConsoleImage
    $bytes=Read-CompanionMaintenanceStreamBytes $stream $Maximum
    if($Live){
      $stream.Position=0;$again=Read-CompanionMaintenanceStreamBytes $stream $Maximum
      try{$after=Get-CompanionMaintenanceHandleState $safe -SystemConsoleImage:$SystemConsoleImage}catch{throw 'MAINTENANCE_LIVE_READ_CHANGED'}
      if($bytes.Length -ne $again.Length -or (Get-CompanionMaintenanceHash $bytes) -cne (Get-CompanionMaintenanceHash $again) -or $after -cne $before){throw 'MAINTENANCE_LIVE_READ_CHANGED'}
      $current=Open-CompanionMaintenanceEntry $Path $false -MetadataOnly
      try{if((Get-CompanionMaintenanceHandleState $current) -cne $before){throw 'MAINTENANCE_LIVE_READ_CHANGED'}}finally{$current.Dispose()}
      if($OwnerSid -and $stream.GetAccessControl().GetSecurityDescriptorSddlForm('All') -cne $acl){throw 'MAINTENANCE_LIVE_ACL_CHANGED'}
    }
    return ,$bytes
  }finally{if($stream){$stream.Dispose()}else{$safe.Dispose()}}
}
function Write-CompanionMaintenanceNew([string]$Path,$Value) {
  $bytes=ConvertTo-CompanionMaintenanceBytes $Value;$f=[IO.File]::Open($Path,'CreateNew','Write','Read');try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
}
function New-CompanionMaintenanceDirectory([string]$Path,[string]$Sddl) {
  $descriptor=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl);$binary=New-Object byte[] $descriptor.BinaryLength;$descriptor.GetBinaryForm($binary,0)
  $sd=[Runtime.InteropServices.Marshal]::AllocHGlobal($binary.Length);$sa=[Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try{[Runtime.InteropServices.Marshal]::Copy($binary,0,$sd,$binary.Length);for($i=0;$i -lt 24;$i++){[Runtime.InteropServices.Marshal]::WriteByte($sa,$i,0)};[Runtime.InteropServices.Marshal]::WriteInt32($sa,0,24);[Runtime.InteropServices.Marshal]::WriteIntPtr($sa,8,$sd);if(-not (Invoke-CompanionMaintenanceNative 'CreateDirectoryW' @($Path,$sa))){throw 'MAINTENANCE_DIRECTORY_ATOMIC_CREATE_REFUSED'}}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($sa);[Runtime.InteropServices.Marshal]::FreeHGlobal($sd)}
}
function Get-CompanionMaintenanceLatchDirectory($Subject) {
  $path='C:\ProgramData\CluedCompanionMaintenance'
  foreach($anchor in @('C:\','C:\ProgramData')){Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $anchor).Sddl '' -Anchor}
  if(-not (Test-Path -LiteralPath $path)){
    New-CompanionMaintenanceDirectory $path ('O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$Subject.operatorSid+')')
  }
  $held=Open-CompanionMaintenanceEntry $path $true
  try{Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $path).Sddl $Subject.operatorSid;return $path}finally{$held.Dispose()}
}
function Assert-CompanionMaintenanceNoPending([string]$Directory) {
  # A new nonce, evidence directory, source generation or process cannot
  # bypass a previous unresolved operation. Only successful finalization (or
  # a separately reviewed recovery) removes this fixed active latch.
  if(Test-Path -LiteralPath (Join-Path $Directory 'active.json')){throw 'MAINTENANCE_PREVIOUS_OPERATION_UNRESOLVED'}
}
function Start-CompanionMaintenanceLatch([string]$Directory,$Subject,[string]$OperationId,[string]$EvidenceDirectory) {
  $path=Join-Path $Directory 'active.json'
  Write-CompanionMaintenanceNew $path @{contract='clued.companion-maintenance.active/1';machine=[Environment]::MachineName;root='C:\ProgramData\CluedIndependentCI\resident';operationId=$OperationId;subject=$Subject;evidenceDirectory=$EvidenceDirectory;at=[DateTimeOffset]::UtcNow.ToString('o')}
  return @{path=$path;sha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $path))}
}
function Assert-CompanionMaintenanceLatch($Context) {
  $directory=Get-CompanionMaintenanceLatchDirectory $Context.subject;$path=Join-Path $directory 'active.json'
  if($Context.latch.path -cne $path){throw 'MAINTENANCE_ACTIVE_LATCH_SUBJECT_CHANGED'}
  $bytes=Read-CompanionMaintenanceBytes $path -OwnerSid $Context.subject.operatorSid
  if((Get-CompanionMaintenanceHash $bytes) -cne $Context.latch.sha256){throw 'MAINTENANCE_ACTIVE_LATCH_CHANGED'}
  Assert-CompanionMaintenanceFields (ConvertFrom-CompanionMaintenanceJson $bytes) @{contract='clued.companion-maintenance.active/1';machine=[Environment]::MachineName;root=$Context.root;operationId=$Context.operationId;subject=$Context.subject;evidenceDirectory=$Context.evidenceDirectory} 'MAINTENANCE_ACTIVE_LATCH_SUBJECT_CHANGED'
}
function Complete-CompanionMaintenanceLatch($Context,$Restore) {
  Assert-CompanionMaintenanceLatch $Context
  if(@($Restore.Keys) -contains 'manualRecoveryRequired'){throw 'MAINTENANCE_LATCH_COMPLETION_REFUSED'}
  Assert-CompanionMaintenanceEqual (Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'restore.json')) $Restore 'MAINTENANCE_LATCH_RESTORE_PROOF_MISMATCH'
  $started=Get-CompanionMaintenanceField $Restore 'actionStarted';$qualified=Get-CompanionMaintenanceField $Restore 'actionQualified'
  if($started -isnot [bool] -or $qualified -isnot [bool]){throw 'MAINTENANCE_LATCH_COMPLETION_REFUSED'}
  if($started){
    if(-not $qualified){throw 'MAINTENANCE_LATCH_COMPLETION_REFUSED'}
    $acceptedFile=Join-Path $Context.evidenceDirectory 'accepted.json';$contextSha=Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $acceptedFile)
    $answer=Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'action.result.json')
    Assert-CompanionMaintenanceFields $answer @{operationId=$Context.operationId;contextSha256=$contextSha} 'MAINTENANCE_ACTION_RESULT_MISMATCH'
    $null=Assert-CompanionMaintenanceActionOutcome $Context $contextSha $answer.answer
  }elseif((Test-Path -LiteralPath (Join-Path $Context.evidenceDirectory 'action.started.json')) -or (Test-Path -LiteralPath (Join-Path $Context.evidenceDirectory 'shutdown.intent.json'))){throw 'MAINTENANCE_LATCH_COMPLETION_REFUSED'}
  $null=Assert-CompanionMaintenanceSource $Context.root $Context.subject
  if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Context.root+'\state\PAUSED.json') -Live)) -cne $Context.pausedSha256){throw 'MAINTENANCE_LATCH_COMPLETION_REFUSED'}
  foreach($before in $Context.services){$current=Get-CompanionMaintenanceService $before.name;if($current.configSha256 -cne $before.configSha256 -or ($before.originallyRunning -and ($current.state -cne 'Running' -or $current.pid -le 0)) -or (-not $before.originallyRunning -and ($current.state -cne 'Stopped' -or $current.pid -ne 0))){throw 'MAINTENANCE_LATCH_FINAL_SERVICE_STATE_UNKNOWN'}}
  $directory=[IO.Path]::GetDirectoryName($Context.latch.path)
  Write-CompanionMaintenanceNew (Join-Path $directory ('completed.'+$Context.operationId+'.json')) @{contract='clued.companion-maintenance.completed/1';operationId=$Context.operationId;latchSha256=$Context.latch.sha256;finalized=$true;restore=$Restore;at=[DateTimeOffset]::UtcNow.ToString('o')}
  # File.Move is create-only at the destination and preserves the old latch.
  # A crash before this move keeps active.json and requires an explicit audit.
  Move-CompanionMaintenanceLatch $Context.latch.path (Join-Path $directory ('history.'+$Context.operationId+'.json'))
}
function Move-CompanionMaintenanceLatch([string]$Source,[string]$Destination){[IO.File]::Move($Source,$Destination)}
function Get-CompanionMaintenanceDirectoryEntries([string]$Directory){return ,@([IO.Directory]::EnumerateFileSystemEntries($Directory))}
function Test-CompanionMaintenanceRecoveryHold([string]$Root) {
  try{
    if($Root -cne 'C:\ProgramData\CluedIndependentCI\resident'){return $true}
    foreach($anchor in @('C:\','C:\ProgramData')){Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $anchor).Sddl '' -Anchor}
    $directory='C:\ProgramData\CluedCompanionMaintenance'
    $entries=Get-CompanionMaintenanceDirectoryEntries 'C:\ProgramData'
    if(@($entries|Where-Object{[string]::Equals([IO.Path]::GetFileName($_),'CluedCompanionMaintenance',[StringComparison]::OrdinalIgnoreCase)}).Count -eq 0){return $false}
    $held=Open-CompanionMaintenanceEntry $directory $true
    try{
      Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $directory).Sddl '' -AllowReadOnlyOthers
      $files=@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)
      $history=@{};$completed=@{}
      foreach($file in $files){
        if($file.Name -ieq 'active.json' -or $file.PSIsContainer){return $true}
        if($file.Name -cmatch '^history\.([0-9a-f]{64})\.json\z'){$history[$Matches[1]]=$file.FullName}
        elseif($file.Name -cmatch '^completed\.([0-9a-f]{64})\.json\z'){$completed[$Matches[1]]=$file.FullName}
        else{return $true}
      }
      if($history.Count -ne $completed.Count){return $true}
      foreach($id in $history.Keys){
        if(-not $completed.ContainsKey($id)){return $true}
        $bytes=Read-CompanionMaintenanceBytes $history[$id] -OwnerSid 'S-1-5-18' -AllowReadOnlyOthers
        $record=ConvertFrom-CompanionMaintenanceJson $bytes
        Assert-CompanionMaintenanceFields $record @{contract='clued.companion-maintenance.active/1';machine=[Environment]::MachineName;root=$Root;operationId=$id} 'MAINTENANCE_HISTORY_UNKNOWN'
        $done=ConvertFrom-CompanionMaintenanceJson (Read-CompanionMaintenanceBytes $completed[$id] -OwnerSid 'S-1-5-18' -AllowReadOnlyOthers)
        Assert-CompanionMaintenanceFields $done @{contract='clued.companion-maintenance.completed/1';operationId=$id;latchSha256=(Get-CompanionMaintenanceHash $bytes);finalized=$true} 'MAINTENANCE_HISTORY_UNKNOWN'
        if(@($done.restore.Keys) -contains 'manualRecoveryRequired'){return $true}
      };return $false
    }finally{$held.Dispose()}
  }catch{return $true}
}
function Read-CompanionMaintenanceJson([string]$Path,[switch]$Live){ConvertFrom-CompanionMaintenanceJson (Read-CompanionMaintenanceBytes $Path -Live:$Live)}
function Assert-CompanionMaintenanceIdentity($Subject) {
  Assert-CompanionMaintenanceSubject $Subject
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if($identity.User.Value -cne $Subject.operatorSid -or -not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MAINTENANCE_ELEVATED_OPERATOR_REQUIRED'}
}
function Assert-CompanionMaintenanceMachineImageAcl([string]$Sddl) {
  $raw=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
  $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if($null -eq $raw.Owner -or $trusted -cnotcontains $raw.Owner.Value -or $null -eq $raw.DiscretionaryAcl){throw 'MAINTENANCE_MACHINE_IMAGE_OWNER_REFUSED'}
  foreach($ace in $raw.DiscretionaryAcl){if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback){throw 'MAINTENANCE_MACHINE_IMAGE_ACL_REFUSED'};if([int]$ace.AceQualifier -eq 0 -and -not ([int]$ace.AceFlags -band 8) -and $trusted -cnotcontains $ace.SecurityIdentifier.Value -and ($ace.AccessMask -band 0x500d0156)){throw 'MAINTENANCE_MACHINE_IMAGE_ACL_REFUSED'}}
}
function Get-CompanionMaintenanceMachineImage([ValidateSet('client','host','console')][string]$Kind) {
  $client=if($Kind -ceq 'client'){'C:\Program Files\WSL\wsl.exe'}elseif($Kind -ceq 'host'){'C:\Program Files\WSL\wslhost.exe'}else{'C:\Windows\System32\conhost.exe'}
  $console=$Kind -ceq 'console';$held=Open-CompanionMaintenanceEntry $client $false -SystemConsoleImage:$console
  try{
    $anchors=if($console){@('C:\','C:\Windows','C:\Windows\System32')}else{@('C:\','C:\Program Files','C:\Program Files\WSL')}
    foreach($path in $anchors){Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $path).Sddl '' -Anchor}
    $signature=Get-AuthenticodeSignature -LiteralPath $client -ErrorAction Stop
    $publisher=if($console){'Microsoft Windows'}else{'Microsoft Corporation'}
    if([string]$signature.Status -cne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cnotmatch ('(?:^|,\s*)CN='+[regex]::Escape($publisher)+'(?:,|$)') -or $signature.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)' -or $signature.SignerCertificate.Thumbprint -cnotmatch '^[0-9A-Fa-f]{40}\z'){throw 'MAINTENANCE_MACHINE_WSL_PUBLISHER_REFUSED'}
    return @{path=$client;sha256=(Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $client 134217728 -MachineImage -SystemConsoleImage:$console));signerThumbprint=$signature.SignerCertificate.Thumbprint.ToUpperInvariant()}
  }finally{$held.Dispose()}
}
function Get-CompanionMaintenanceWslClient {
  $client=Get-CompanionMaintenanceMachineImage 'client';$client.host=Get-CompanionMaintenanceMachineImage 'host';$client.console=Get-CompanionMaintenanceMachineImage 'console';return $client
}
function Get-CompanionMaintenanceWsl {
  # Management only: never run a distribution. Rebind the shared observation
  # through a held static handle immediately before this fixed invocation.
  $facts=Get-CompanionMaintenanceWslClient;$client=$facts.path;$held=Open-CompanionMaintenanceEntry $client $false
  try{
    if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $client 134217728)) -cne $facts.sha256){throw 'MAINTENANCE_MACHINE_WSL_CHANGED'}
    $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$client;$info.Arguments='--list --running --quiet';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory='C:\Windows\System32';$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=[Text.Encoding]::Unicode;$info.StandardErrorEncoding=[Text.Encoding]::Unicode
    $info.EnvironmentVariables.Clear();foreach($pair in @(@('SystemRoot','C:\Windows'),@('windir','C:\Windows'),@('PATH','C:\Windows\System32;C:\Windows'),@('USERPROFILE',$env:USERPROFILE))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $p=New-Object Diagnostics.Process;$p.StartInfo=$info
    try{if(-not $p.Start()){throw 'MAINTENANCE_WSL_INVENTORY_UNKNOWN'};$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(45000)){try{$p.Kill()}catch{};throw 'MAINTENANCE_WSL_INVENTORY_UNKNOWN'};if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($out,$err),2000) -or $p.ExitCode -ne 0){throw 'MAINTENANCE_WSL_INVENTORY_UNKNOWN'};$value=[string]$out.Result;if($value.Length -gt 32768 -or ([string]$err.Result).Length -gt 0){throw 'MAINTENANCE_WSL_INVENTORY_UNKNOWN'}
      $names=@();foreach($line in ($value -split '\r?\n')){$name=$line.Trim([char]0xFEFF).Trim();if($name){$names+=,$name}};Assert-CompanionMaintenanceNames $names 'MAINTENANCE_WSL_INVENTORY_UNKNOWN';return ,$names
    }finally{$p.Dispose()}
  }finally{$held.Dispose()}
}
# H1, one rule for every child a package script starts (first-install-host.ps1's own; test/native-child.test.mjs holds every copy the same
# text and no package .ps1 merging a stream into its output): stdout, stderr and the exit code read apart; never an error from stderr.
function Invoke-NativeChild([string]$exe, [string[]]$arguments, [int]$seconds = 3600, [Text.Encoding]$encoding = (New-Object Text.UTF8Encoding($false)), [bool]$shareConsole = $false, [byte[]]$stdin = $null) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = ($null -ne $stdin); $psi.CreateNoWindow = (-not $shareConsole)
  $psi.StandardOutputEncoding = $encoding; $psi.StandardErrorEncoding = $encoding
  # Windows PowerShell 5.1 (.NET Framework) opens a redirected stdin as a StreamWriter in Console.InputEncoding and writes that
  # encoding's preamble at once: on a UTF-8 console (code page 65001) the child reads a BOM before $stdin (run 44705707829). While the
  # child starts, Console's cached input encoding (what its getter returns) is a UTF-8 without one; .NET Core has no such field and
  # writes no preamble. Our bytes go to the base stream, so the writer's encoding is otherwise unused.
  $cie = if ($psi.RedirectStandardInput) { [Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static') } else { $null }
  $was = if ($null -ne $cie) { $cie.GetValue($null) } else { $null }
  if ($null -ne $cie) { $cie.SetValue($null, (New-Object Text.UTF8Encoding($false))) }
  try { $p = [Diagnostics.Process]::Start($psi) } finally { if ($null -ne $cie) { $cie.SetValue($null, $was) } }
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if ($null -ne $stdin) { try { $p.StandardInput.BaseStream.Write($stdin, 0, $stdin.Length); $p.StandardInput.BaseStream.Flush() } finally { $p.StandardInput.Close() } }   # a secret: never a command line
  if (-not $p.WaitForExit($seconds * 1000)) { return [ordered]@{ exit = $null; stdout = ''; stderr = ''; timedOut = $true } }
  $p.WaitForExit()   # the asynchronous reads end with the child
  $tail = { param($t) $t = ([string]$t) -replace "`0", ''; if ($t.Length -gt 1500) { $t.Substring($t.Length - 1500) } else { $t } }
  [ordered]@{ exit = $p.ExitCode; stdout = ([string]$o.Result -replace "`0", ''); stderr = (& $tail $e.Result); timedOut = $false }
}
function Get-CompanionMaintenanceService([string]$Name) {
  if($Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\z'){throw 'MAINTENANCE_SERVICE_NAME_REFUSED'}
  $rows=@(Get-CimInstance -ClassName Win32_Service -Filter ("Name='"+$Name+"'") -ErrorAction Stop)
  if($rows.Count -ne 1 -or @('Running','Stopped') -cnotcontains [string]$rows[0].State){throw 'MAINTENANCE_SERVICE_STATE_UNKNOWN'};$s=$rows[0]
  if(([string]$s.State -ceq 'Running' -and [long]$s.ProcessId -le 0) -or ([string]$s.State -ceq 'Stopped' -and [long]$s.ProcessId -ne 0)){throw 'MAINTENANCE_SERVICE_PID_UNKNOWN'}
  $config=[ordered]@{name=$Name;binary=[string]$s.PathName;account=[string]$s.StartName;startMode=[string]$s.StartMode;type=[string]$s.ServiceType;errorControl=[string]$s.ErrorControl;desktopInteract=[bool]$s.DesktopInteract;sc=@()}
  foreach($command in @('qc','qfailure','qfailureflag','qsidtype','qprivs','sdshow')){
    $run=Invoke-NativeChild 'C:\Windows\System32\sc.exe' @($command,$Name) 120 ([Console]::OutputEncoding);if($run.exit -ne 0){throw 'MAINTENANCE_SERVICE_CONFIG_UNREADABLE'}
    # the lines as PowerShell's own capture gave them: one per line, the last line's terminator making no empty line
    $output=@([string]$run.stdout -split "`r?`n");if($output[$output.Count-1] -ceq ''){$output=@(if($output.Count -gt 1){$output[0..($output.Count-2)]})};$config.sc+=,[string]($output -join "`n")
  }
  return @{name=$Name;state=[string]$s.State;pid=[long]$s.ProcessId;config=$config;configSha256=(Get-CompanionMaintenanceHash (ConvertTo-CompanionMaintenanceBytes $config));stoppedByOperation=$false;originallyRunning=([string]$s.State -ceq 'Running')}
}
function Get-CompanionMaintenanceProcesses([string]$Root,$TrackedProcesses=@()) {
  $all=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate -ErrorAction Stop);$found=@();$ids=@{}
  foreach($process in $TrackedProcesses){$ids[[string]$process.pid]=$true}
  foreach($process in $all){$image=[string]$process.ExecutablePath;if($image -and $image.StartsWith($Root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){$ids[[string]$process.ProcessId]=$true}}
  do{$added=$false;foreach($process in $all){if($ids.ContainsKey([string]$process.ParentProcessId) -and -not $ids.ContainsKey([string]$process.ProcessId)){$ids[[string]$process.ProcessId]=$true;$added=$true}}}while($added)
  foreach($process in $all){if($ids.ContainsKey([string]$process.ProcessId)){$found+=,@{pid=[long]$process.ProcessId;parent=[long]$process.ParentProcessId;image=[string]$process.ExecutablePath;createdAt=([DateTimeOffset]$process.CreationDate).ToString('o')}}}
  return ,$found
}
function Assert-CompanionMaintenanceQuietValue($Status,$Upgrade,$Runner,[string]$PausedHash,[string]$ExpectedPausedHash,[switch]$Stopped) {
  if($PausedHash -cnotmatch '^[0-9a-f]{64}\z' -or $PausedHash -cne $ExpectedPausedHash){throw 'MAINTENANCE_PAUSED_CHANGED'}
  if((Get-CompanionMaintenanceField $Status 'contract') -cnotmatch '^clued\.independent-ci\.resident-status/[5-8]\z'){throw 'MAINTENANCE_STATUS_UNKNOWN'}
  Assert-CompanionMaintenanceFields $Status @{current=$null;halt=$null;paused=$true} 'MAINTENANCE_CURRENT_OR_HALT_ACTIVE'
  $executor=Get-CompanionMaintenanceField $Status 'executor';$state=Get-CompanionMaintenanceField $executor 'state'
  if(@('PAUSED','IDLE','STOPPED') -cnotcontains $state){throw 'MAINTENANCE_EXECUTOR_NOT_IDLE'}
  $train=Get-CompanionMaintenanceField $Status 'train';if((Get-CompanionMaintenanceField $train 'enabled') -cnotin @('off','shadow','on')){throw 'MAINTENANCE_TRAIN_UNKNOWN'}
  if(@($train.Keys) -ccontains 'running' -and $train.running -ne $false){throw 'MAINTENANCE_TRAIN_ACTIVE'}
  Assert-CompanionMaintenanceFields $Upgrade @{contract='clued.independent-ci.resident-upgrade-status/1';op=$null} 'MAINTENANCE_UPGRADE_ACTIVE_OR_UNKNOWN'
  if($Runner.state -cne 'Stopped' -or $Runner.pid -ne 0){throw 'MAINTENANCE_RUNNER_NOT_STOPPED'}
}
function Assert-CompanionMaintenanceSource([string]$Root,$Subject) {
  if($Root -cne 'C:\ProgramData\CluedIndependentCI\resident'){throw 'MAINTENANCE_ROOT_REFUSED'}
  $receiptBytes=Read-CompanionMaintenanceBytes ($Root+'\install\install-receipt.json') -Live
  if((Get-CompanionMaintenanceHash $receiptBytes) -cne $Subject.installReceiptSha256){throw 'MAINTENANCE_RECEIPT_CHANGED'}
  $receipt=ConvertFrom-CompanionMaintenanceJson $receiptBytes
  Assert-CompanionMaintenanceFields $receipt @{packageManifestSha256=$Subject.packageManifestSha256;residentManifestSha256=$Subject.residentManifestSha256} 'MAINTENANCE_INSTALLED_SUBJECT_CHANGED'
  $current=Read-CompanionMaintenanceJson ($Root+'\upgrade\current.json') -Live
  Assert-CompanionMaintenanceFields $current @{contract='clued.independent-ci.resident-generation/1';packageManifestSha256=$Subject.packageManifestSha256;residentManifestSha256=$Subject.residentManifestSha256;ciSourceManifestSha256=$Subject.ciSourceManifestSha256;installReceiptSha256=$Subject.installReceiptSha256} 'MAINTENANCE_CURRENT_GENERATION_CHANGED'
  $source=Read-CompanionMaintenancePublishedSlot $Root 'record\source-manifest.json' $Subject.ciSourceManifestSha256
  $installedSourceBytes=Read-CompanionMaintenancePublishedSlot $Root 'config\source-installed-manifest.json' (Get-CompanionMaintenanceField $receipt 'sourceManifestSha256')
  $installedSource=ConvertFrom-CompanionMaintenanceJson $installedSourceBytes
  Assert-CompanionMaintenanceFields $installedSource @{contract='clued.independent-ci.resident-installed-manifest/1';root='source'} 'MAINTENANCE_SOURCE_MANIFEST_UNKNOWN'
  Assert-CompanionMaintenanceManifestFiles ($Root+'\source\'+$Subject.ciSourceManifestSha256) $installedSource
  Assert-CompanionMaintenanceRegisteredConfigs $Root $receipt
  $acceptance=ConvertFrom-CompanionMaintenanceJson (Read-CompanionMaintenancePublishedSlot $Root 'record\acceptance.json' (Get-CompanionMaintenanceField $receipt 'acceptanceSha256'));if($acceptance.node.nodeName -cne $Subject.node -or $acceptance.node.wslDistribution -cne $Subject.wslDistribution -or $acceptance.node.runnerService -cne $Subject.runnerService -or $acceptance.node.ownerSid -cne $Subject.companionSid -or [Environment]::MachineName -cne $acceptance.node.hostname){throw 'MAINTENANCE_NODE_CHANGED'}
  Assert-CompanionMaintenanceFields (Read-CompanionMaintenanceJson ($Root+'\install\companion-account.json')) @{contract='clued.independent-ci.companion-account/1';operatorSid=$Subject.operatorSid;companionSid=$Subject.companionSid} 'MAINTENANCE_INSTALLED_OPERATOR_CHANGED'
  $manifestBytes=Read-CompanionMaintenancePublishedSlot $Root 'config\resident-installed-manifest.json' $Subject.residentManifestSha256
  $manifest=ConvertFrom-CompanionMaintenanceJson $manifestBytes;$seen=@{}
  foreach($entry in (Get-CompanionMaintenanceField $manifest 'files')){
    if($entry.path -isnot [string] -or $entry.path -cnotmatch '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\z' -or $entry.path.Split('/') -contains '..' -or $seen.ContainsKey($entry.path)){throw 'MAINTENANCE_MANIFEST_PATH_REFUSED'};$seen[$entry.path]=$true
    if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Root+'\resident\'+$Subject.residentManifestSha256+'\'+$entry.path.Replace('/','\')))) -cne $entry.sha256){throw 'MAINTENANCE_INSTALLED_FILE_CHANGED'}
  }
  if(-not $seen.ContainsKey('windows/companion-maintenance.ps1') -or -not $seen.ContainsKey('windows/rearm-resident.ps1')){throw 'MAINTENANCE_HELPER_NOT_PACKAGED'}
  if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Root+'\resident\'+$Subject.residentManifestSha256+'\windows\rearm-resident.ps1'))) -cne $Subject.rearmSha256){throw 'MAINTENANCE_REARM_CHANGED'}
  return ,$receipt
}
function Assert-CompanionMaintenanceRegisteredConfigs([string]$Root,$Receipt) {
  foreach($binding in @(@{path='config\policy.json';hash=(Get-CompanionMaintenanceField $Receipt 'policySha256')},@{path='config\companion.json';hash=(Get-CompanionMaintenanceField $Receipt 'companionConfigSha256')},@{path='config\broker.json';hash=(Get-CompanionMaintenanceField $Receipt 'brokerConfigSha256')},@{path='upgrader\config\upgrader.json';hash=(Get-CompanionMaintenanceField $Receipt.upgrader 'configSha256')})){
    $null=Read-CompanionMaintenancePublishedSlot $Root $binding.path $binding.hash
  }
}
function Read-CompanionMaintenancePublishedSlot([string]$Root,[string]$Relative,[string]$ExpectedHash) {
  # These eight generation/config slots are replaceable PackageSlots. Their
  # bytes remain hash-bound, but observing them must not deny atomic publish.
  if(@('record\source-manifest.json','config\source-installed-manifest.json','config\resident-installed-manifest.json','record\acceptance.json','config\policy.json','config\companion.json','config\broker.json','upgrader\config\upgrader.json') -cnotcontains $Relative -or $ExpectedHash -cnotmatch '^[0-9a-f]{64}\z'){throw 'MAINTENANCE_PUBLISHED_SLOT_UNKNOWN'}
  $bytes=Read-CompanionMaintenanceBytes (Join-Path $Root $Relative) 4194304 -Live
  if((Get-CompanionMaintenanceHash $bytes) -cne $ExpectedHash){throw 'MAINTENANCE_REGISTERED_CONFIG_CHANGED'}
  return ,$bytes
}
function Assert-CompanionMaintenanceManifestFiles([string]$Directory,$Manifest) {
  $files=Get-CompanionMaintenanceField $Manifest 'files';if($files -isnot [Array] -or $files.Count -eq 0 -or $files.Count -gt 10000){throw 'MAINTENANCE_SOURCE_MANIFEST_UNKNOWN'};$seen=@{}
  foreach($entry in $files){
    if($entry.path -isnot [string] -or $entry.path -cnotmatch '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\z' -or $entry.path.Split('/') -contains '..' -or $entry.path.Split('/') -contains '.' -or $seen.ContainsKey($entry.path.ToLowerInvariant()) -or $entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}\z'){throw 'MAINTENANCE_MANIFEST_PATH_REFUSED'};$seen[$entry.path.ToLowerInvariant()]=$true
    $bytes=Read-CompanionMaintenanceBytes (Join-Path $Directory $entry.path.Replace('/','\')) 33554432
    if(($entry.bytes -isnot [int] -and $entry.bytes -isnot [long]) -or $bytes.Length -ne $entry.bytes -or (Get-CompanionMaintenanceHash $bytes) -cne $entry.sha256){throw 'MAINTENANCE_ACTUAL_SOURCE_CHANGED'}
  }
  $actual=@{};$todo=@(@{path=$Directory;relative=''})
  while($todo.Count){$item=$todo[0];$todo=@($todo|Select-Object -Skip 1);$held=Open-CompanionMaintenanceEntry $item.path $true
    try{foreach($child in @(Get-ChildItem -LiteralPath $item.path -Force -ErrorAction Stop)){
      if($child.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MAINTENANCE_MANIFEST_PATH_REFUSED'}
      $relative=if($item.relative){$item.relative+'/'+$child.Name}else{$child.Name}
      if($child.PSIsContainer){if(@($seen.Keys|Where-Object{$_.StartsWith($relative.ToLowerInvariant()+'/',[StringComparison]::Ordinal)}).Count -eq 0){throw 'MAINTENANCE_UNREGISTERED_SOURCE_ENTRY'};$todo+=,@{path=$child.FullName;relative=$relative}}
      else{if(-not $seen.ContainsKey($relative.ToLowerInvariant()) -or $actual.ContainsKey($relative.ToLowerInvariant())){throw 'MAINTENANCE_UNREGISTERED_SOURCE_ENTRY'};$actual[$relative.ToLowerInvariant()]=$true}
    }}finally{$held.Dispose()}
  };if($actual.Count -ne $seen.Count){throw 'MAINTENANCE_ACTUAL_SOURCE_CHANGED'}
}
function Get-CompanionMaintenanceFallback([string]$Root,$Subject) {
  $service=New-Object -ComObject 'Schedule.Service';$service.Connect()
  try{$task=$service.GetFolder('\Clued').GetTask('CluedCIResidentCompanionFallback')}catch{if(($_.Exception.HResult -band 0xffff) -in @(2,3)){return @{present=$false}};throw 'MAINTENANCE_FALLBACK_STATE_UNKNOWN'}
  $definition=$task.Definition;$expected='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$Root+'\resident\'+$Subject.residentManifestSha256+'\windows\companion-headless-fallback.ps1"'
  $principal=[string]$definition.Principal.UserId
  if(-not $principal.StartsWith('S-1-')){try{$principal=(New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value}catch{throw 'MAINTENANCE_FALLBACK_CONFIGURATION_UNKNOWN'}}
  if($principal -cne 'S-1-5-18' -or $definition.Principal.LogonType -ne 5 -or $definition.Principal.RunLevel -ne 1 -or $definition.Actions.Count -ne 1 -or [string]$definition.Actions.Item(1).Path -cne 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or [string]$definition.Actions.Item(1).Arguments -cne $expected){throw 'MAINTENANCE_FALLBACK_CONFIGURATION_UNKNOWN'}
  return @{present=$true}
}
function Get-CompanionMaintenanceLocal([string]$Root,$Subject,[string]$PausedHash,[switch]$Stopped,$TrackedProcesses=@(),$ExpectedPending=$null,$AllowedProcesses=@()) {
  $null=Assert-CompanionMaintenanceSource $Root $Subject
  $pendingPath=$Root+'\install\companion-headless-pending.json';$pendingPresent=Test-Path -LiteralPath $pendingPath
  if($pendingPresent){if($null -eq $ExpectedPending){throw 'MAINTENANCE_PREVIOUS_COMPANION_PENDING'};Assert-CompanionMaintenanceFields (Read-CompanionMaintenanceJson $pendingPath -Live) $ExpectedPending 'MAINTENANCE_PENDING_OPERATION_MISMATCH'}
  $fallback=Get-CompanionMaintenanceFallback $Root $Subject
  if($fallback.present -and (-not $pendingPresent -or $null -eq $ExpectedPending)){throw 'MAINTENANCE_PREVIOUS_FALLBACK_OPERATION'}
  $status=Read-CompanionMaintenanceJson ($Root+'\state\status.json') -Live;$upgrade=Read-CompanionMaintenanceJson ($Root+'\upgrade\status.json') -Live
  if(-not $Stopped){$written=[DateTimeOffset]::Parse((Get-CompanionMaintenanceField $status 'writtenAt'),[Globalization.CultureInfo]::InvariantCulture);$age=([DateTimeOffset]::UtcNow-$written).TotalSeconds;if($age -lt 0 -or $age -gt 120){throw 'MAINTENANCE_LOCAL_STATUS_STALE'}}
  if(Test-Path -LiteralPath ($Root+'\state\HALT.json')){throw 'MAINTENANCE_HALT_PRESENT'}
  $paused=Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Root+'\state\PAUSED.json') -Live)
  $runner=Get-CompanionMaintenanceService $Subject.runnerService
  $sddl=$runner.config.sc[-1].Trim();$dacl=$sddl.IndexOf('D:');if($dacl -ge 0){$sddl=$sddl.Substring($dacl)};$sacl=$sddl.IndexOf('S:');if($sacl -ge 0){$sddl=$sddl.Substring(0,$sacl)}
  if($runner.config.binary -cne $Subject.runnerBinary -or $sddl -cne $Subject.runnerSddl){throw 'MAINTENANCE_RUNNER_CONFIG_CHANGED'}
  Assert-CompanionMaintenanceQuietValue $status $upgrade $runner $paused $PausedHash -Stopped:$Stopped
  foreach($directory in @(@{path=($Root+'\state\ledger');terminal='90-terminal.json';outcomes=@('COMPLETED','FAILED_CLEAN','NOT_ADMITTED','NOT_EXECUTED','IGNORED')},@{path=($Root+'\upgrade\ops');terminal='900-terminal.json';outcomes=@('SUCCEEDED','SUCCEEDED_STILL_PAUSED','ROLLED_BACK_PAUSED','REFUSED','GRANT_REJECTED','GRANT_EXPIRED','CANCELLED','STALE')})){
    $held=Open-CompanionMaintenanceEntry $directory.path $true
    try{foreach($entry in @(Get-ChildItem -LiteralPath $directory.path -Force -ErrorAction Stop)){
      if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MAINTENANCE_JOURNAL_UNKNOWN'}
      $terminal=Read-CompanionMaintenanceJson (Join-Path $entry.FullName $directory.terminal)
      if($directory.outcomes -cnotcontains (Get-CompanionMaintenanceField $terminal 'outcome')){throw 'MAINTENANCE_JOURNAL_NONTERMINAL_OR_UNKNOWN'}
      if($directory.terminal -ceq '90-terminal.json'){
        if($entry.Name -cnotmatch '^[0-9a-f]{64}\z' -or (Get-CompanionMaintenanceField $terminal 'key') -cne $entry.Name){throw 'MAINTENANCE_LEDGER_SUBJECT_UNKNOWN'}
      }else{Assert-CompanionMaintenanceFields $terminal @{contract='clued.independent-ci.resident-upgrade-journal/1';opId=$entry.Name;seq=900;step='terminal';kind='terminal'} 'MAINTENANCE_UPGRADE_JOURNAL_UNKNOWN'}
    }}finally{$held.Dispose()}
  }
  # Requests are retained by this broker. Each one must have its own completed
  # response; an unanswered/taken-only request is not an idle broker.
  $requests=$Root+'\broker\requests';$held=Open-CompanionMaintenanceEntry $requests $true
  try{foreach($request in @(Get-ChildItem -LiteralPath $requests -Force -ErrorAction Stop)){
    if($request.PSIsContainer -or $request.Name -cnotmatch '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json\z'){throw 'MAINTENANCE_BROKER_REQUESTS_UNKNOWN'}
    $response=Read-CompanionMaintenanceJson ($Root+'\broker\responses\'+$request.Name)
    Assert-CompanionMaintenanceFields $response @{contract='clued.independent-ci.swap-broker-response/2';requestId=$Matches[1];restored=$true;accountUnchanged=$true;stableAfter=$true;configurationConflict=$false} 'MAINTENANCE_BROKER_REQUESTS_PENDING'
  }}finally{$held.Dispose()}
  $processes=Get-CompanionMaintenanceProcesses $Root $TrackedProcesses
  if($Stopped){$processes=Assert-CompanionMaintenanceAllowedProcesses $Root $processes $AllowedProcesses $Subject}
  return @{pausedSha256=$paused;statusSha256=(Get-CompanionMaintenanceHash (ConvertTo-CompanionMaintenanceBytes $status));processes=$processes;runner=$runner}
}
function Assert-CompanionMaintenanceAllowedProcesses([string]$Root,$Processes,$Allowed,$Subject) {
  if($Allowed.Count -eq 0){if($Processes.Count -ne 0){throw 'MAINTENANCE_LOCAL_PROCESSES_REMAIN'};return ,@()}
  $client=Get-CompanionMaintenanceWslClient;$null=Get-CompanionMaintenanceTreeRoles $Root $Allowed $client
  # A currently busy short-lived lane is never admitted as an allowed process.
  # Obtain a fresh, bounded quiet observation, then compare every persisted
  # identity/token/client/command field with the qualification proof.
  $again=Get-CompanionMaintenanceVerifiedCompanionTree $Root $Subject ([DateTimeOffset]::MinValue)
  foreach($process in $again){$expected=@($Allowed|Where-Object{$_.pid -eq $process.pid});if($expected.Count -ne 1){throw 'MAINTENANCE_QUALIFIED_PROCESS_CHANGED'};Assert-CompanionMaintenanceEqual $process $expected[0] 'MAINTENANCE_QUALIFIED_PROCESS_CHANGED'}
  return ,$again
}
function Get-CompanionMaintenanceKeepaliveCommand([string]$Client,[string]$Distribution) {
  if($Distribution -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\z' -or $Client -match '["\r\n\x00]'){throw 'MAINTENANCE_KEEPALIVE_COMMAND_UNKNOWN'}
  $exe=if($Client.Contains(' ')){'"'+$Client+'"'}else{$Client}
  # This is Node/libuv's actual shell:false command for companion.mjs argv.
  # Require bare leading options too: quoted flags have different WSL-native
  # semantics even when CommandLineToArgvW would produce the same arguments.
  return ($exe+' --distribution '+$Distribution+' --exec /bin/sleep infinity')
}
function Get-CompanionMaintenanceProcessCommand($Process) {
  $rows=@(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+[long]$Process.pid) -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate,CommandLine -ErrorAction Stop)
  if($rows.Count -ne 1 -or [long]$rows[0].ParentProcessId -ne $Process.parent -or [string]$rows[0].ExecutablePath -cne $Process.image -or ([DateTimeOffset]$rows[0].CreationDate).ToString('o') -cne $Process.createdAt -or $rows[0].CommandLine -isnot [string] -or $rows[0].CommandLine.Length -gt 32768){throw 'MAINTENANCE_KEEPALIVE_PROCESS_CHANGED'}
  return [string]$rows[0].CommandLine
}
function Get-CompanionMaintenanceTargetRegistration($Subject) {
  $key='Registry::HKEY_USERS\'+$Subject.companionSid+'\Software\Microsoft\Windows\CurrentVersion\Lxss';$matches=@()
  foreach($child in @(Get-ChildItem -LiteralPath $key -ErrorAction Stop)){
    $value=Get-ItemProperty -LiteralPath $child.PSPath -ErrorAction Stop
    if($value.DistributionName -ceq $Subject.wslDistribution){
      $guid=[guid]::Empty;if(-not [guid]::TryParse($child.PSChildName,[ref]$guid) -or $value.BasePath -isnot [string]){throw 'MAINTENANCE_TARGET_REGISTRATION_UNKNOWN'}
      $base=([string]$value.BasePath) -replace '^\\\\\?\\','';$vhd=[IO.Path]::GetFullPath((Join-Path $base 'ext4.vhdx'))
      if(-not [string]::Equals($vhd,$Subject.targetVhdxPath,[StringComparison]::OrdinalIgnoreCase)){throw 'MAINTENANCE_TARGET_REGISTRATION_CHANGED'}
      $matches+=,@{distroId=$guid.ToString('B').ToLowerInvariant();companionSid=$Subject.companionSid;distribution=$Subject.wslDistribution;vhdxPath=$Subject.targetVhdxPath}
    }
  };if($matches.Count -ne 1){throw 'MAINTENANCE_TARGET_REGISTRATION_UNKNOWN'};return $matches[0]
}
function Assert-CompanionMaintenanceHostCommand([string]$Command,$Registration) {
  $uuid='\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}'
  $pattern='^ --distro-id (?<distro>'+ $uuid +') --vm-id (?<vm>'+ $uuid +') --handle (?<handle>[1-9][0-9]{0,9}) --event (?<event>[1-9][0-9]{0,9}) --parent (?<parent>[1-9][0-9]{0,9})\z'
  if($Command -cnotmatch $pattern){throw 'MAINTENANCE_WSLHOST_COMMAND_UNKNOWN'}
  if(([guid]$Matches.distro).ToString('B').ToLowerInvariant() -cne $Registration.distroId){throw 'MAINTENANCE_WSLHOST_DISTRO_MISMATCH'}
  $values=@([long]$Matches.handle,[long]$Matches.event,[long]$Matches.parent)
  if(@($values|Select-Object -Unique).Count -ne 3 -or @($values|Where-Object{$_ -gt [uint32]::MaxValue}).Count){throw 'MAINTENANCE_WSLHOST_HANDLES_UNKNOWN'}
}
function Get-CompanionMaintenanceTreeRoles([string]$Root,$Processes,$Client) {
  $supervisor=@($Processes|Where-Object{$_.image -ceq ($Root+'\bin\CluedCompanionSupervisor.exe')});$child=@($Processes|Where-Object{$_.image -ceq ($Root+'\runtime\node.exe')});$keepalive=@($Processes|Where-Object{$_.image -ceq $Client.path});$hostProcess=@($Processes|Where-Object{$_.image -ceq $Client.host.path});$consoles=@($Processes|Where-Object{[string]::Equals($_.image,$Client.console.path,[StringComparison]::OrdinalIgnoreCase)})
  if($supervisor.Count -ne 1 -or $child.Count -ne 1 -or $keepalive.Count -ne 1 -or $hostProcess.Count -ne 1 -or $consoles.Count -gt 3 -or $Processes.Count -ne (4+$consoles.Count) -or $child[0].parent -ne $supervisor[0].pid -or $keepalive[0].parent -ne $child[0].pid -or $hostProcess[0].parent -ne $keepalive[0].pid -or @($Processes|ForEach-Object{$_.pid}|Select-Object -Unique).Count -ne $Processes.Count){throw 'MAINTENANCE_QUALIFIED_PROCESSES_UNKNOWN'}
  $parents=@($child[0],$keepalive[0],$hostProcess[0]);$seen=@{}
  foreach($console in $consoles){if(@($parents|Where-Object{$_.pid -eq $console.parent}).Count -ne 1 -or $seen.ContainsKey([string]$console.parent)){throw 'MAINTENANCE_CONSOLE_PARENT_UNKNOWN'};$seen[[string]$console.parent]=$true}
  foreach($process in @($child[0],$keepalive[0],$hostProcess[0])+$consoles){$parent=@($Processes|Where-Object{$_.pid -eq $process.parent})[0];if([DateTimeOffset]::Parse($process.createdAt) -lt [DateTimeOffset]::Parse($parent.createdAt)){throw 'MAINTENANCE_QUALIFIED_PROCESS_TOO_OLD'}}
  return @{supervisor=$supervisor[0];companion=$child[0];keepalive=$keepalive[0];host=$hostProcess[0];consoles=$consoles}
}
function Start-CompanionMaintenanceTreeClock {return [Diagnostics.Stopwatch]::StartNew()}
function Wait-CompanionMaintenanceTreeSample {Start-Sleep -Milliseconds 250}
function Get-CompanionMaintenanceTokenFacts([string]$Root,[long]$ProcessId,$Receipt) {
  if($ProcessId -le 0){throw 'MAINTENANCE_QUALIFIED_PID_UNKNOWN'}
  $exe=$Root+'\bin\CluedCompanionTaskRegistrar.exe';$held=Open-CompanionMaintenanceEntry $exe $false
  try{
    if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $exe)) -cne $Receipt.companionRegistrarSha256){throw 'MAINTENANCE_TOKEN_READER_NOT_PINNED'}
    $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$exe;$info.Arguments='token-facts '+$ProcessId;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory='C:\Windows\System32';$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear();foreach($pair in @(@('SystemRoot','C:\Windows'),@('windir','C:\Windows'),@('PATH','C:\Windows\System32;C:\Windows'))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $process=New-Object Diagnostics.Process;$process.StartInfo=$info
    try{if(-not $process.Start()){throw 'MAINTENANCE_TOKEN_UNREADABLE'};$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();if(-not $process.WaitForExit(15000)){try{$process.Kill()}catch{};throw 'MAINTENANCE_TOKEN_UNREADABLE'};if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),2000) -or $process.ExitCode -ne 0 -or $stdout.Result.Length -gt 32768 -or $stderr.Result.Length -ne 0){throw 'MAINTENANCE_TOKEN_UNREADABLE'};return (ConvertFrom-CompanionMaintenanceJson ([Text.Encoding]::UTF8.GetBytes($stdout.Result)))}finally{$process.Dispose()}
  }finally{$held.Dispose()}
}
function Get-CompanionMaintenanceVerifiedCompanionTree([string]$Root,$Subject,[DateTimeOffset]$Since) {
  $receipt=Assert-CompanionMaintenanceSource $Root $Subject;$client=Get-CompanionMaintenanceWslClient;$registration=Get-CompanionMaintenanceTargetRegistration $Subject;$clock=Start-CompanionMaintenanceTreeClock
  while($true){
    $processes=Get-CompanionMaintenanceProcesses $Root
    if(@($processes|Where-Object{$_.image -ceq ($Root+'\bin\CluedCompanionSupervisor.exe')}).Count -ne 1 -or @($processes|Where-Object{$_.image -ceq ($Root+'\runtime\node.exe')}).Count -ne 1 -or @($processes|Where-Object{$_.image -ceq $client.path}).Count -gt 1 -or @($processes|Where-Object{$_.image -ceq $client.host.path}).Count -gt 1){throw 'MAINTENANCE_QUALIFIED_PROCESSES_UNKNOWN'}
    $consoleCount=@($processes|Where-Object{[string]::Equals($_.image,$client.console.path,[StringComparison]::OrdinalIgnoreCase)}).Count
    if($consoleCount -gt 3){throw 'MAINTENANCE_CONSOLE_PARENT_UNKNOWN'}
    if($processes.Count -eq (4+$consoleCount) -and @($processes|Where-Object{$_.image -ceq $client.path}).Count -eq 1 -and @($processes|Where-Object{$_.image -ceq $client.host.path}).Count -eq 1){break}
    if($clock.Elapsed.TotalSeconds -ge 30){throw 'MAINTENANCE_QUALIFIED_PROCESSES_NOT_QUIET'}
    Wait-CompanionMaintenanceTreeSample
  }
  $roles=Get-CompanionMaintenanceTreeRoles $Root $processes $client
  $verified=@();foreach($process in $processes){
    if([DateTimeOffset]::Parse($process.createdAt,[Globalization.CultureInfo]::InvariantCulture) -lt $Since){throw 'MAINTENANCE_QUALIFIED_PROCESS_TOO_OLD'}
    $role=if($process.pid -eq $roles.keepalive.pid){'keepalive'}elseif($process.pid -eq $roles.host.pid){'host'}elseif($process.pid -eq $roles.companion.pid){'companion'}elseif($process.pid -eq $roles.supervisor.pid){'supervisor'}else{'console'}
    $hash=Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $process.image 134217728 -MachineImage:($role -in @('keepalive','host','console')) -SystemConsoleImage:($role -ceq 'console'))
    $expectedHash=if($role -ceq 'keepalive'){$client.sha256}elseif($role -ceq 'host'){$client.host.sha256}elseif($role -ceq 'console'){$client.console.sha256}elseif($role -ceq 'companion'){$receipt.upgrader.nodeSha256}else{$receipt.companionSupervisorSha256}
    if($hash -cne $expectedHash){throw 'MAINTENANCE_QUALIFIED_IMAGE_CHANGED'}
    $token=Get-CompanionMaintenanceTokenFacts $Root $process.pid $receipt
    Assert-CompanionMaintenanceFields $token @{code='TOKEN_FACTS';pid=$process.pid;userSid=$Subject.companionSid;sessionId=0} 'MAINTENANCE_QUALIFIED_TOKEN_CHANGED'
    if($token.imagePath -isnot [string] -or -not [string]::Equals($token.imagePath,$process.image,[StringComparison]::OrdinalIgnoreCase)){throw 'MAINTENANCE_QUALIFIED_TOKEN_CHANGED'}
    if(($token.elevationType -isnot [int] -and $token.elevationType -isnot [long]) -or $token.elevationType -eq 2 -or $token.adminsPresent -isnot [bool] -or $token.adminsDenyOnly -isnot [bool] -or ($token.adminsPresent -and -not $token.adminsDenyOnly)){throw 'MAINTENANCE_QUALIFIED_TOKEN_CHANGED'}
    $item=$process.Clone();$item.imageSha256=$hash;$item.token=$token;$item.role=$role
    if($role -ceq 'keepalive'){
      $command=Get-CompanionMaintenanceProcessCommand $process
      if($command -cne (Get-CompanionMaintenanceKeepaliveCommand $client.path $Subject.wslDistribution)){throw 'MAINTENANCE_KEEPALIVE_COMMAND_UNKNOWN'}
      $item.keepaliveCommandLine=$command;$item.wslClient=$client
    }elseif($role -ceq 'host'){
      $command=Get-CompanionMaintenanceProcessCommand $process;Assert-CompanionMaintenanceHostCommand $command $registration;$item.hostCommandLine=$command;$item.registration=$registration
    }elseif($role -ceq 'console'){
      $command=Get-CompanionMaintenanceProcessCommand $process
      if(-not [string]::Equals($command,'\??\C:\Windows\System32\conhost.exe 0x4',[StringComparison]::OrdinalIgnoreCase)){throw 'MAINTENANCE_CONSOLE_COMMAND_UNKNOWN'}
      $item.consoleCommandLine=$command;$item.consoleImage=$client.console
    };$verified+=,$item
  }
  $after=Get-CompanionMaintenanceProcesses $Root
  if($after.Count -ne $processes.Count){throw 'MAINTENANCE_QUALIFIED_PROCESS_CHANGED'}
  foreach($process in $after){$before=@($processes|Where-Object{$_.pid -eq $process.pid});if($before.Count -ne 1){throw 'MAINTENANCE_QUALIFIED_PROCESS_CHANGED'};Assert-CompanionMaintenanceEqual $process $before[0] 'MAINTENANCE_QUALIFIED_PROCESS_CHANGED'}
  Assert-CompanionMaintenanceEqual (Get-CompanionMaintenanceTargetRegistration $Subject) $registration 'MAINTENANCE_TARGET_REGISTRATION_CHANGED'
  Assert-CompanionMaintenanceEqual (Get-CompanionMaintenanceWslClient) $client 'MAINTENANCE_MACHINE_WSL_CHANGED'
  return ,$verified
}
function Get-CompanionMaintenanceRegisteredVhd([string]$Distribution) {
  if($Distribution -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\z'){throw 'MAINTENANCE_DISTRO_NAME_REFUSED'}
  $found=@(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction Stop|ForEach-Object{Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop}|Where-Object{$_.DistributionName -ceq $Distribution})
  if($found.Count -ne 1 -or $found[0].BasePath -isnot [string]){throw 'MAINTENANCE_WSL_REGISTRATION_UNKNOWN'}
  $base=[string]$found[0].BasePath;if($base.StartsWith('\\?\')){$base=$base.Substring(4)}
  $path=[IO.Path]::GetFullPath((Join-Path $base 'ext4.vhdx'));$held=Open-CompanionMaintenanceEntry $path $false -MetadataOnly;try{return $path}finally{$held.Dispose()}
}
function Assert-CompanionMaintenanceServices($Services,[switch]$Stopped) {
  if($Services -isnot [Array] -or $Services.Count -ne 3){throw 'MAINTENANCE_SERVICE_BASELINE_UNKNOWN'}
  $expected=@('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker')
  for($i=0;$i -lt 3;$i++){
    $before=$Services[$i];if($before.name -cne $expected[$i] -or $before.originallyRunning -isnot [bool] -or $before.stoppedByOperation -isnot [bool]){throw 'MAINTENANCE_SERVICE_BASELINE_UNKNOWN'}
    $now=Get-CompanionMaintenanceService $before.name
    if($now.configSha256 -cne $before.configSha256){throw 'MAINTENANCE_SERVICE_CONFIG_CHANGED'}
    if($Stopped -and ($now.state -cne 'Stopped' -or $now.pid -ne 0)){throw 'MAINTENANCE_SERVICE_RESTARTED'}
  }
}
function Send-CompanionMaintenanceServiceStop([string]$Name) {
  $controller=New-Object ServiceProcess.ServiceController($Name);try{$controller.Stop()}finally{$controller.Dispose()}
}
function Wait-CompanionMaintenanceServiceStopped($Baseline,[int]$Seconds) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  while($timer.Elapsed.TotalSeconds -lt $Seconds){
    # Pending is expected only during the SCM stop wait. Configuration and the
    # final stopped PID are rechecked with the full reader before proceeding.
    $controller=New-Object ServiceProcess.ServiceController($Baseline.name)
    try{$controller.Refresh();if($controller.Status -eq [ServiceProcess.ServiceControllerStatus]::Stopped){$now=Get-CompanionMaintenanceService $Baseline.name;if($now.configSha256 -cne $Baseline.configSha256 -or $now.pid -ne 0){throw 'MAINTENANCE_SERVICE_STOP_CONFIG_CHANGED'};return}}finally{$controller.Dispose()}
    Start-Sleep -Milliseconds 500
  };throw 'MAINTENANCE_NATURAL_STOP_TIMEOUT'
}
function Stop-CompanionMaintenanceService($Baseline,[int]$Seconds) {
  $now=Get-CompanionMaintenanceService $Baseline.name
  if($now.configSha256 -cne $Baseline.configSha256 -or $now.state -cne $Baseline.state -or $now.pid -ne $Baseline.pid){throw 'MAINTENANCE_SERVICE_CHANGED_BEFORE_STOP'}
  if($now.state -ceq 'Stopped'){return}
  Send-CompanionMaintenanceServiceStop $Baseline.name;$Baseline.stoppedByOperation=$true
  Wait-CompanionMaintenanceServiceStopped $Baseline $Seconds
}
function Get-CompanionMaintenanceRestorePlan($Services,$Current) {
  $plan=@();if($Services.Count -ne 3 -or $Current.Count -ne 3){throw 'MAINTENANCE_RESTORE_BASELINE_UNKNOWN'}
  for($i=2;$i -ge 0;$i--){$before=$Services[$i];$now=$Current[$i]
    if($before.name -cne $now.name -or $before.configSha256 -cne $now.configSha256){throw 'MAINTENANCE_RESTORE_CONFIG_CHANGED'}
    if($before.stoppedByOperation -isnot [bool] -or $before.originallyRunning -isnot [bool]){throw 'MAINTENANCE_RESTORE_BASELINE_UNKNOWN'}
    if(-not $before.stoppedByOperation -and ($now.state -cne $before.state -or $now.pid -ne $before.pid)){throw 'MAINTENANCE_RESTORE_STATE_CHANGED'}
    if($before.stoppedByOperation -and $before.originallyRunning){if($now.state -cne 'Stopped' -or $now.pid -ne 0){throw 'MAINTENANCE_RESTORE_STATE_CHANGED'};$plan+=,$before.name}
  };return ,$plan
}
function Restore-CompanionMaintenanceServices([string]$Root,$Subject,[string]$PausedHash,$Services,$Authority,$AuthorityChallenge,[string]$EvidenceDirectory) {
  $null=Assert-CompanionMaintenanceSource $Root $Subject
  if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Root+'\state\PAUSED.json') -Live)) -cne $PausedHash){throw 'MAINTENANCE_RESTORE_PAUSED_CHANGED'}
  $current=@();foreach($service in $Services){$current+=,(Get-CompanionMaintenanceService $service.name)}
  $plan=Get-CompanionMaintenanceRestorePlan $Services $current
  foreach($name in $plan){
    Assert-CompanionMaintenanceHost $Authority $AuthorityChallenge ([DateTimeOffset]::UtcNow) -RequireInventory
    $null=Assert-CompanionMaintenanceSource $Root $Subject
    if((Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Root+'\state\PAUSED.json') -Live)) -cne $PausedHash){throw 'MAINTENANCE_RESTORE_PAUSED_CHANGED'}
    # Re-read immediately before each start, including services restarted
    # earlier in this restore. Never change startup type, Source or PAUSED.
    $before=@($Services|Where-Object{$_.name -ceq $name})[0];$now=Get-CompanionMaintenanceService $name
    if($now.configSha256 -cne $before.configSha256 -or $now.state -cne 'Stopped' -or $now.pid -ne 0){throw 'MAINTENANCE_RESTORE_STATE_CHANGED'}
    Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory ('restore.'+$name+'.intent.json')) @{service=$name;before=$now;grantId=$Authority.grant.id;at=[DateTimeOffset]::UtcNow.ToString('o')}
    Start-CompanionMaintenanceService $name
    $now=Get-CompanionMaintenanceService $name;if($now.configSha256 -cne $before.configSha256 -or $now.state -cne 'Running' -or $now.pid -le 0){throw 'MAINTENANCE_RESTORE_NOT_CONFIRMED'}
    Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory ('restore.'+$name+'.result.json')) @{service=$name;after=$now;at=[DateTimeOffset]::UtcNow.ToString('o')}
  };return @{restored=$plan;pausedPreserved=$true}
}
function Start-CompanionMaintenanceService([string]$Name){$controller=New-Object ServiceProcess.ServiceController($Name);try{$controller.Start();$controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(60))}finally{$controller.Dispose()}}
function Read-CompanionMaintenanceHostFile([string]$Directory,[string]$Name,[string]$OwnerSid) {
  $held=Open-CompanionMaintenanceEntry $Directory $true
  try{
    Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $Directory).Sddl $OwnerSid -PrivateDrop
    $file=Join-Path $Directory $Name
    return ,(Read-CompanionMaintenanceBytes $file -Live -OwnerSid $OwnerSid -PrivateDrop)
  }finally{$held.Dispose()}
}
function Wait-CompanionMaintenanceHost([string]$HostDrop,[string]$Name,$Challenge,[switch]$RequireInventory) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  while($timer.Elapsed.TotalSeconds -lt 120){
    if(Test-Path -LiteralPath (Join-Path $HostDrop $Name)){
      $bytes=Read-CompanionMaintenanceHostFile $HostDrop $Name $Challenge.subject.operatorSid
      $evidence=ConvertFrom-CompanionMaintenanceJson $bytes;Assert-CompanionMaintenanceHost $evidence $Challenge ([DateTimeOffset]::UtcNow) -RequireInventory:$RequireInventory
      return @{value=$evidence;bytes=$bytes;sha256=(Get-CompanionMaintenanceHash $bytes)}
    };Start-Sleep -Milliseconds 500
  };throw 'MAINTENANCE_HOST_ATTESTATION_TIMEOUT'
}
function Read-CompanionMaintenanceContext([string]$ContextFile,[string]$ExpectedContextSha256,[switch]$AllowExpired) {
  if($ExpectedContextSha256 -cnotmatch '^[0-9a-f]{64}\z' -or [IO.Path]::GetFileName($ContextFile) -cne 'accepted.json'){throw 'MAINTENANCE_CONTEXT_SUBJECT_REQUIRED'}
  $parent=[IO.Path]::GetDirectoryName($ContextFile);$held=Open-CompanionMaintenanceEntry $parent $true
  try{
    # Owner read is allowed, Owner write/ownership is not. An accepted file
    # remains administrator-owned even though its input came from the Host.
    $operator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $parent).Sddl $operator
    Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $ContextFile).Sddl $operator -InheritedFile
    $bytes=Read-CompanionMaintenanceBytes $ContextFile;$context=ConvertFrom-CompanionMaintenanceJson $bytes
    Assert-CompanionMaintenanceIdentity $context.subject
    if((Get-CompanionMaintenanceHash $bytes) -cne $ExpectedContextSha256){throw 'MAINTENANCE_CONTEXT_HASH_CHANGED'}
    Assert-CompanionMaintenanceFields $context @{contract='clued.companion-maintenance.context/1';root='C:\ProgramData\CluedIndependentCI\resident'} 'MAINTENANCE_CONTEXT_SCHEMA_REFUSED'
    if($context.operationId -cnotmatch '^[0-9a-f]{64}\z' -or $context.nonce -cnotmatch '^[0-9a-f]{64}\z' -or $context.evidenceDirectory -cne $parent){throw 'MAINTENANCE_CONTEXT_IDENTITY_REFUSED'}
    $process=Get-Process -Id $context.pid -ErrorAction Stop
    if(([DateTimeOffset]$process.StartTime).ToUniversalTime().ToString('o') -cne $context.processStartedAt){throw 'MAINTENANCE_PARENT_PROCESS_CHANGED'}
    if($process.HasExited -or -not [string]::Equals([string]$process.Path,'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',[StringComparison]::OrdinalIgnoreCase)){throw 'MAINTENANCE_PARENT_IMAGE_CHANGED'}
    # A completion may record an old operation after its start authority
    # expired. That historical validation never authorizes another effect.
    $checkAt=if($AllowExpired){[DateTimeOffset]::ParseExact($context.createdAt,'o',[Globalization.CultureInfo]::InvariantCulture)}else{[DateTimeOffset]::UtcNow}
    Assert-CompanionMaintenanceFresh $context $checkAt
    Assert-CompanionMaintenanceHost $context.host $context.challenge $checkAt -RequireInventory
    Assert-CompanionMaintenanceFields $context.challenge @{operationId=$context.operationId;nonce=$context.nonce;pid=$context.pid;processStartedAt=$context.processStartedAt;subject=$context.subject;pausedSha256=$context.pausedSha256;coveredWsl=$context.coveredWsl;phase='after-stop'} 'MAINTENANCE_CONTEXT_CHALLENGE_CHANGED'
    Assert-CompanionMaintenanceLatch $context
    return ,$context
  }finally{$held.Dispose()}
}
function Test-CompanionMaintenanceVhdFree([string]$Path) {
  $held=Open-CompanionMaintenanceEntry $Path $false -MetadataOnly;$held.Dispose()
  try{$file=[IO.File]::Open($Path,'Open','ReadWrite','None');try{return $true}finally{$file.Dispose()}}catch [IO.IOException]{if(($_.Exception.HResult -band 0xffff) -in @(32,33)){return $false};throw}
}
function Assert-CompanionMaintenanceEntry([string]$Root,[string]$TargetVhdxPath,[string]$CompanionSid,[string]$ContextFile,[string]$ExpectedContextSha256) {
  $context=Read-CompanionMaintenanceContext $ContextFile $ExpectedContextSha256
  Assert-CompanionMaintenanceEqual $Root $context.root 'MAINTENANCE_ENTRY_ROOT_MISMATCH'
  Assert-CompanionMaintenanceEqual $TargetVhdxPath $context.subject.targetVhdxPath 'MAINTENANCE_ENTRY_TARGET_MISMATCH'
  Assert-CompanionMaintenanceEqual $CompanionSid $context.subject.companionSid 'MAINTENANCE_ENTRY_ACCOUNT_MISMATCH'
  if((Get-CompanionMaintenanceRegisteredVhd $context.subject.wslDistribution) -cne $context.subject.vhdxPath){throw 'MAINTENANCE_ENTRY_SOURCE_REGISTRATION_CHANGED'}
  $null=Get-CompanionMaintenanceLocal $Root $context.subject $context.pausedSha256 -Stopped -TrackedProcesses $context.trackedProcesses -ExpectedPending @{maintenanceOperationId=$context.operationId;maintenanceContextSha256=$ExpectedContextSha256}
  Assert-CompanionMaintenanceServices $context.services -Stopped
  foreach($distro in (Get-CompanionMaintenanceWsl)){if($context.coveredWsl -cnotcontains $distro){throw 'MAINTENANCE_WSL_SCOPE_CHANGED'}}
  foreach($name in @('release.accepted.json','shutdown.intent.json','shutdown.result.json')){if(Test-Path -LiteralPath (Join-Path $context.evidenceDirectory $name)){throw 'MAINTENANCE_ENTRY_ONCE_STATE_EXISTS'}}
  Write-CompanionMaintenanceNew (Join-Path $context.evidenceDirectory 'account-switch.entry.json') @{operationId=$context.operationId;contextSha256=$ExpectedContextSha256;pid=$PID;targetVhdxPath=$TargetVhdxPath;companionSid=$CompanionSid;at=[DateTimeOffset]::UtcNow.ToString('o')}
  return ,$context
}
function Assert-CompanionMaintenanceShutdownGuard([string]$Path,[string]$ContextFile,[string]$ExpectedContextSha256) {
  $context=Read-CompanionMaintenanceContext $ContextFile $ExpectedContextSha256
  if($Path -cne $context.subject.vhdxPath){throw 'MAINTENANCE_VHD_SUBJECT_CHANGED'}
  if((Get-CompanionMaintenanceRegisteredVhd $context.subject.wslDistribution) -cne $Path){throw 'MAINTENANCE_WSL_REGISTRATION_CHANGED'}
  $null=Get-CompanionMaintenanceLocal $context.root $context.subject $context.pausedSha256 -Stopped -TrackedProcesses $context.trackedProcesses -ExpectedPending @{maintenanceOperationId=$context.operationId;maintenanceContextSha256=$ExpectedContextSha256}
  Assert-CompanionMaintenanceServices $context.services -Stopped
  $running=Get-CompanionMaintenanceWsl;foreach($distro in $running){if($context.coveredWsl -cnotcontains $distro){throw 'MAINTENANCE_WSL_SCOPE_CHANGED'}}
  foreach($name in @('release.accepted.json','shutdown.intent.json','shutdown.result.json')){if(Test-Path -LiteralPath (Join-Path $context.evidenceDirectory $name)){throw 'MAINTENANCE_RELEASE_ONCE_STATE_EXISTS'}}
  # Authority is checked even if the VHD is already free. A free disk does not
  # authorize stopping/restoring services or account migration.
  $free=Test-CompanionMaintenanceVhdFree $Path
  Assert-CompanionMaintenanceHost $context.host $context.challenge ([DateTimeOffset]::UtcNow) -RequireInventory
  Write-CompanionMaintenanceNew (Join-Path $context.evidenceDirectory 'release.accepted.json') @{operationId=$context.operationId;contextSha256=$ExpectedContextSha256;path=$Path;vhdAlreadyFree=[bool]$free;at=[DateTimeOffset]::UtcNow.ToString('o')}
  if($free){return @{operationId=$context.operationId;intentFile=$null;vmShutdownRequired=$false;exclusiveFileConfirmed=$true}}
  $intent=Join-Path $context.evidenceDirectory 'shutdown.intent.json'
  Write-CompanionMaintenanceNew $intent @{contract='clued.companion-maintenance.shutdown-intent/1';operationId=$context.operationId;contextSha256=$ExpectedContextSha256;path=$Path;runningBefore=$running;at=[DateTimeOffset]::UtcNow.ToString('o');command='wsl.exe --shutdown'}
  return @{operationId=$context.operationId;intentFile=$intent;vmShutdownRequired=$true;exclusiveFileConfirmed=$false}
}
function Complete-CompanionMaintenanceShutdown([string]$ContextFile,[string]$ExpectedContextSha256,$Result) {
  # Completion records the actual result even when authority expires while
  # waiting for WSL. Expiry never permits a second shutdown.
  $parent=[IO.Path]::GetDirectoryName($ContextFile);$operator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $parent).Sddl $operator
  Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $ContextFile).Sddl $operator -InheritedFile
  $bytes=Read-CompanionMaintenanceBytes $ContextFile
  if((Get-CompanionMaintenanceHash $bytes) -cne $ExpectedContextSha256){throw 'MAINTENANCE_CONTEXT_HASH_CHANGED'}
  $context=ConvertFrom-CompanionMaintenanceJson $bytes;Assert-CompanionMaintenanceIdentity $context.subject
  Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $parent).Sddl $context.subject.operatorSid
  $intent=Read-CompanionMaintenanceJson (Join-Path $parent 'shutdown.intent.json')
  Assert-CompanionMaintenanceFields $intent @{contract='clued.companion-maintenance.shutdown-intent/1';operationId=$context.operationId;contextSha256=$ExpectedContextSha256;path=$context.subject.vhdxPath;command='wsl.exe --shutdown'} 'MAINTENANCE_SHUTDOWN_INTENT_MISMATCH'
  $resultPath=Join-Path $parent 'shutdown.result.json'
  Write-CompanionMaintenanceNew $resultPath @{contract='clued.companion-maintenance.shutdown-result/1';operationId=$context.operationId;result=$Result;at=[DateTimeOffset]::UtcNow.ToString('o')}
  Assert-CompanionMaintenanceFields $Result @{completed=$true;exitCode=0} 'MAINTENANCE_SHUTDOWN_FAILED_OR_UNKNOWN'
  $running=Get-CompanionMaintenanceWsl;if($running.Count -ne 0){throw 'MAINTENANCE_WSL_STILL_RUNNING'}
  $timer=[Diagnostics.Stopwatch]::StartNew();$free=$false
  while($timer.Elapsed.TotalSeconds -lt 120){if(Test-CompanionMaintenanceVhdFree $context.subject.vhdxPath){$free=$true;break};Start-Sleep -Milliseconds 500}
  if(-not $free){throw 'MAINTENANCE_VHD_STILL_IN_USE'}
  $completion=@{completed=$true;exclusiveFileConfirmed=$true;operationId=$context.operationId;resultFile=$resultPath;contextSha256=$ExpectedContextSha256;at=[DateTimeOffset]::UtcNow.ToString('o')}
  Write-CompanionMaintenanceNew (Join-Path $parent 'shutdown.completed.json') $completion
  return $completion
}
function Assert-CompanionMaintenanceQualifiedRecord($Record,$Context,[DateTimeOffset]$Since) {
  Assert-CompanionMaintenanceFields $Record @{contract='clued.independent-ci.companion-wsl/1';distro=$Context.subject.wslDistribution;source=$Context.subject.vhdxPath;target=$Context.subject.targetVhdxPath;companionSid=$Context.subject.companionSid;stage='qualified';imported=$true} 'MAINTENANCE_NEW_WSL_NOT_QUALIFIED'
  $at=[DateTimeOffset]::Parse((Get-CompanionMaintenanceField $Record 'qualifiedAt'),[Globalization.CultureInfo]::InvariantCulture)
  if($at -lt $Since -or $at -gt [DateTimeOffset]::UtcNow){throw 'MAINTENANCE_QUALIFICATION_NOT_THIS_ACTION'}
}
function Complete-CompanionMaintenanceQualification([string]$ContextFile,[string]$ExpectedContextSha256,[DateTimeOffset]$QualifiedSince,$TaskFacts) {
  $context=Read-CompanionMaintenanceContext $ContextFile $ExpectedContextSha256 -AllowExpired
  $started=Read-CompanionMaintenanceJson (Join-Path $context.evidenceDirectory 'action.started.json')
  Assert-CompanionMaintenanceFields $started @{operationId=$context.operationId;contextSha256=$ExpectedContextSha256} 'MAINTENANCE_ACTION_START_MISMATCH'
  $since=[DateTimeOffset]::Parse($started.at,[Globalization.CultureInfo]::InvariantCulture)
  if($QualifiedSince -lt $since -or $QualifiedSince -gt [DateTimeOffset]::UtcNow){throw 'MAINTENANCE_QUALIFICATION_NOT_THIS_ACTION'}
  if(Test-Path -LiteralPath ($context.root+'\install\companion-headless-pending.json')){throw 'MAINTENANCE_QUALIFICATION_PENDING_REMAINS'}
  $task=ConvertFrom-CompanionMaintenanceJson (ConvertTo-CompanionMaintenanceBytes $TaskFacts)
  Assert-CompanionMaintenanceFields $task @{exists=$true;mode='password';problems=@();logonType=1} 'MAINTENANCE_PASSWORD_TASK_NOT_QUALIFIED'
  $recordBytes=Read-CompanionMaintenanceBytes ($context.root+'\install\companion-wsl.json') -Live -OwnerSid $context.subject.operatorSid
  $record=ConvertFrom-CompanionMaintenanceJson $recordBytes;Assert-CompanionMaintenanceQualifiedRecord $record $context $since
  $heartbeat=Read-CompanionMaintenanceJson ($context.root+'\mailbox\responses\heartbeat.json') -Live
  $at=Get-CompanionMaintenanceField $heartbeat 'at';if(($at -isnot [int] -and $at -isnot [long]) -or $at -lt $QualifiedSince.ToUnixTimeMilliseconds()){throw 'MAINTENANCE_NEW_HEARTBEAT_UNCONFIRMED'}
  $factsBytes=Read-CompanionMaintenanceBytes ($context.root+'\upgrade\mailbox\responses\version-facts.json') -Live
  $facts=ConvertFrom-CompanionMaintenanceJson $factsBytes
  Assert-CompanionMaintenanceFields $facts @{contract='clued.independent-ci.linux-version-facts/1';ciSourceManifestSha256=$context.subject.ciSourceManifestSha256;pinsOk=$true} 'MAINTENANCE_NEW_LINUX_FACTS_UNCONFIRMED'
  if([DateTimeOffset]::Parse($facts.observedAt,[Globalization.CultureInfo]::InvariantCulture) -lt $QualifiedSince){throw 'MAINTENANCE_NEW_LINUX_FACTS_UNCONFIRMED'}
  $target=Open-CompanionMaintenanceEntry $context.subject.targetVhdxPath $false -MetadataOnly;$target.Dispose()
  $qualifiedProcesses=Get-CompanionMaintenanceVerifiedCompanionTree $context.root $context.subject $QualifiedSince
  $proof=@{contract='clued.companion-maintenance.qualification/1';operationId=$context.operationId;contextSha256=$ExpectedContextSha256;qualified=$true;recordSha256=(Get-CompanionMaintenanceHash $recordBytes);qualifiedSince=$QualifiedSince.ToString('o');task=$task;qualifiedProcesses=$qualifiedProcesses;heartbeatAt=$at;linuxFactsSha256=(Get-CompanionMaintenanceHash $factsBytes);at=[DateTimeOffset]::UtcNow.ToString('o')}
  Write-CompanionMaintenanceNew (Join-Path $context.evidenceDirectory 'qualification.result.json') $proof
  return $proof
}
function Assert-CompanionMaintenanceActionOutcome($Context,[string]$ContextSha256,$Answer) {
  $answerValue=ConvertFrom-CompanionMaintenanceJson (ConvertTo-CompanionMaintenanceBytes $Answer)
  Assert-CompanionMaintenanceFields $answerValue @{exit=0} 'MAINTENANCE_ACTION_FAILED_OR_UNKNOWN'
  if($answerValue.stdout -isnot [string]){throw 'MAINTENANCE_ACTION_FAILED_OR_UNKNOWN'}
  $output=ConvertFrom-CompanionMaintenanceJson ([Text.Encoding]::UTF8.GetBytes($answerValue.stdout))
  Assert-CompanionMaintenanceFields $output @{status='COMPANION_HEADLESS_QUALIFIED'} 'MAINTENANCE_ACTION_FAILED_OR_UNKNOWN'
  Assert-CompanionMaintenanceFields $output.result @{qualified=$true;failed=$null;fellBack=$false} 'MAINTENANCE_ACTION_FAILED_OR_UNKNOWN'
  $started=Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'action.started.json')
  Assert-CompanionMaintenanceFields $started @{operationId=$Context.operationId;contextSha256=$ContextSha256} 'MAINTENANCE_ACTION_START_MISMATCH'
  $since=[DateTimeOffset]::Parse($started.at,[Globalization.CultureInfo]::InvariantCulture)
  $proof=Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'qualification.result.json')
  Assert-CompanionMaintenanceFields $proof @{contract='clued.companion-maintenance.qualification/1';operationId=$Context.operationId;contextSha256=$ContextSha256;qualified=$true} 'MAINTENANCE_QUALIFICATION_PROOF_REQUIRED'
  $recordBytes=Read-CompanionMaintenanceBytes ($Context.root+'\install\companion-wsl.json') -Live -OwnerSid $Context.subject.operatorSid
  $record=ConvertFrom-CompanionMaintenanceJson $recordBytes;Assert-CompanionMaintenanceQualifiedRecord $record $Context $since
  Assert-CompanionMaintenanceEqual $record $output.result.wsl 'MAINTENANCE_QUALIFIED_RESULT_NOT_ACTUAL_RECORD'
  if((Get-CompanionMaintenanceHash $recordBytes) -cne $proof.recordSha256){throw 'MAINTENANCE_QUALIFIED_RECORD_CHANGED'}
  if(Test-Path -LiteralPath ($Context.root+'\install\companion-headless-pending.json')){throw 'MAINTENANCE_QUALIFICATION_PENDING_REMAINS'}
  $release=Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'release.accepted.json')
  Assert-CompanionMaintenanceFields $release @{operationId=$Context.operationId;contextSha256=$ContextSha256;path=$Context.subject.vhdxPath} 'MAINTENANCE_RELEASE_PROOF_REQUIRED'
  if($release.vhdAlreadyFree -isnot [bool]){throw 'MAINTENANCE_RELEASE_PROOF_REQUIRED'}
  if(-not $release.vhdAlreadyFree -or (Test-Path -LiteralPath (Join-Path $Context.evidenceDirectory 'shutdown.intent.json'))){
    $intent=Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'shutdown.intent.json')
    Assert-CompanionMaintenanceFields $intent @{operationId=$Context.operationId;contextSha256=$ContextSha256;path=$Context.subject.vhdxPath} 'MAINTENANCE_SHUTDOWN_INTENT_MISMATCH'
    $completion=Read-CompanionMaintenanceJson (Join-Path $Context.evidenceDirectory 'shutdown.completed.json')
    Assert-CompanionMaintenanceFields $completion @{operationId=$Context.operationId;contextSha256=$ContextSha256;completed=$true;exclusiveFileConfirmed=$true} 'MAINTENANCE_SHUTDOWN_COMPLETION_REQUIRED'
  }
  return ,$proof
}
function Get-CompanionMaintenanceServiceObservations($Services) {
  $observed=@();foreach($service in $Services){try{$observed+=,(Get-CompanionMaintenanceService $service.name)}catch{$observed+=,@{name=$service.name;state='UNKNOWN';code=$_.Exception.Message}}};return ,$observed
}
function Invoke-CompanionMaintenanceRecovery([string]$Root,$Subject,[string]$PausedHash,$Services,[string]$HostDrop,[string]$EvidenceDirectory,$Challenge,[bool]$ActionStarted,[bool]$ActionSucceeded,$Context,[string]$ContextSha256,$Answer) {
  try{
    $allowed=@()
    if($ActionStarted){if(-not $ActionSucceeded){throw 'MAINTENANCE_ACTION_FAILED_UNKNOWN_KEEP_STOPPED'};$proof=Assert-CompanionMaintenanceActionOutcome $Context $ContextSha256 $Answer;$allowed=Get-CompanionMaintenanceField $proof 'qualifiedProcesses'}
    elseif(Test-Path -LiteralPath (Join-Path $EvidenceDirectory 'shutdown.intent.json')){throw 'MAINTENANCE_UNEXPECTED_SHUTDOWN_INTENT_KEEP_STOPPED'}
    $null=Get-CompanionMaintenanceLocal $Root $Subject $PausedHash -Stopped -TrackedProcesses $Context.trackedProcesses -AllowedProcesses $allowed
    $stopped=@($Services|Where-Object{$_.stoppedByOperation -eq $true})
    if($stopped.Count -eq 0){$current=Get-CompanionMaintenanceServiceObservations $Services;$null=Get-CompanionMaintenanceRestorePlan $Services $current;return @{restored=@();noServicesStopped=$true;pausedPreserved=$true;actionStarted=$ActionStarted;actionQualified=$ActionSucceeded}}
    $restoreChallenge=ConvertFrom-CompanionMaintenanceJson (ConvertTo-CompanionMaintenanceBytes $Challenge);$restoreChallenge.phase='before-restore'
    $nonce=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($nonce)}finally{$rng.Dispose()};$restoreChallenge.nonce=([BitConverter]::ToString($nonce)).Replace('-','').ToLowerInvariant()
    Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'restore-authority.request.json') $restoreChallenge
    $authority=Wait-CompanionMaintenanceHost $HostDrop ($Challenge.operationId+'.restore.json') $restoreChallenge -RequireInventory
    Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'restore-authority.accepted.json') $authority.value
    if($ActionStarted){$proof=Assert-CompanionMaintenanceActionOutcome $Context $ContextSha256 $Answer;$allowed=Get-CompanionMaintenanceField $proof 'qualifiedProcesses'}
    $null=Get-CompanionMaintenanceLocal $Root $Subject $PausedHash -Stopped -TrackedProcesses $Context.trackedProcesses -AllowedProcesses $allowed
    $restored=Restore-CompanionMaintenanceServices $Root $Subject $PausedHash $Services $authority.value $restoreChallenge $EvidenceDirectory
    $restored.actionStarted=$ActionStarted;$restored.actionQualified=$ActionSucceeded
    return $restored
  }catch{return @{restored=@();manualRecoveryRequired=$true;code=$_.Exception.Message;actionStarted=$ActionStarted;actionSucceeded=$ActionSucceeded;observedServices=(Get-CompanionMaintenanceServiceObservations $Services);stoppedByOperation=@($Services|Where-Object{$_.stoppedByOperation -eq $true}|ForEach-Object{$_.name})}}
}
function Invoke-CompanionMaintenanceCore([string]$Root,$ExpectedSubject,[string]$HostDrop,[string]$EvidenceDirectory,[scriptblock]$Action) {
  Assert-CompanionMaintenanceIdentity $ExpectedSubject
  if($null -eq $Action){throw 'MAINTENANCE_ACTION_REQUIRED'}
  $null=Assert-CompanionMaintenanceSource $Root $ExpectedSubject
  $latchDirectory=Get-CompanionMaintenanceLatchDirectory $ExpectedSubject
  Assert-CompanionMaintenanceNoPending $latchDirectory
  $paused=Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes ($Root+'\state\PAUSED.json') -Live)
  $local=Get-CompanionMaintenanceLocal $Root $ExpectedSubject $paused
  $tracked=$local.processes;$running=Get-CompanionMaintenanceWsl;if($running -cnotcontains $ExpectedSubject.wslDistribution){$running+=,$ExpectedSubject.wslDistribution}
  $services=@();foreach($name in @('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker')){$services+=,(Get-CompanionMaintenanceService $name)}
  $receipt=Read-CompanionMaintenanceJson ($Root+'\install\install-receipt.json') -Live
  if($services[0].config.binary -cne $receipt.upgrader.binaryPath -or $services[1].config.binary -cne $receipt.residentBinaryPath -or $services[2].config.binary -cne $receipt.brokerBinaryPath){throw 'MAINTENANCE_SERVICE_BINARY_NOT_INSTALLED'}
  $dropHeld=Open-CompanionMaintenanceEntry $HostDrop $true
  try{Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $HostDrop).Sddl $ExpectedSubject.operatorSid -PrivateDrop}finally{$dropHeld.Dispose()}
  if(Test-Path -LiteralPath $EvidenceDirectory){throw 'MAINTENANCE_EVIDENCE_EXISTS_NO_RETRY'}
  $parent=[IO.Path]::GetDirectoryName($EvidenceDirectory);$parentHeld=Open-CompanionMaintenanceEntry $parent $true
  try{
    Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $parent).Sddl $ExpectedSubject.operatorSid
    $sddl='O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$ExpectedSubject.operatorSid+')'
    New-CompanionMaintenanceDirectory $EvidenceDirectory $sddl
  }finally{$parentHeld.Dispose()}
  $held=Open-CompanionMaintenanceEntry $EvidenceDirectory $true
  try{
    Assert-CompanionMaintenanceAcl (Get-Acl -LiteralPath $EvidenceDirectory).Sddl $ExpectedSubject.operatorSid
    $random=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($random);$operation=([BitConverter]::ToString($random)).Replace('-','').ToLowerInvariant();$rng.GetBytes($random);$nonce=([BitConverter]::ToString($random)).Replace('-','').ToLowerInvariant()}finally{$rng.Dispose()}
    $challenge=@{operationId=$operation;nonce=$nonce;pid=$PID;processStartedAt=([DateTimeOffset](Get-Process -Id $PID).StartTime).ToUniversalTime().ToString('o');subject=$ExpectedSubject;pausedSha256=$paused;coveredWsl=$running;phase='before-stop'}
    Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'authorization.request.json') $challenge
    $initial=Wait-CompanionMaintenanceHost $HostDrop ($operation+'.authorization.json') $challenge
    Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'authorization.accepted.json') $initial.value
    $latch=Start-CompanionMaintenanceLatch $latchDirectory $ExpectedSubject $operation $EvidenceDirectory
    $context=@{root=$Root;subject=$ExpectedSubject;operationId=$operation;evidenceDirectory=$EvidenceDirectory;trackedProcesses=$tracked;latch=$latch;pausedSha256=$paused;services=$services}
    $restore=$null;$failure=$null;$answer=$null;$contextSha=$null;$actionStarted=$false;$actionSucceeded=$false
    try{
      $null=Get-CompanionMaintenanceLocal $Root $ExpectedSubject $paused
      Assert-CompanionMaintenanceHost $initial.value $challenge ([DateTimeOffset]::UtcNow)
      Stop-CompanionMaintenanceService $services[0] 180
      Assert-CompanionMaintenanceHost $initial.value $challenge ([DateTimeOffset]::UtcNow)
      Stop-CompanionMaintenanceService $services[1] 600
      # No force-kill tail: refusal leaves the original PAUSED and Source intact.
      $null=Get-CompanionMaintenanceLocal $Root $ExpectedSubject $paused -TrackedProcesses $tracked
      Assert-CompanionMaintenanceHost $initial.value $challenge ([DateTimeOffset]::UtcNow)
      Stop-CompanionMaintenanceService $services[2] 120
      $null=Get-CompanionMaintenanceLocal $Root $ExpectedSubject $paused -Stopped -TrackedProcesses $tracked
      Assert-CompanionMaintenanceServices $services -Stopped
      $challenge.phase='after-stop';Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'attestation.request.json') $challenge
      $accepted=Wait-CompanionMaintenanceHost $HostDrop ($operation+'.attestation.json') $challenge -RequireInventory
      $null=Get-CompanionMaintenanceLocal $Root $ExpectedSubject $paused -Stopped -TrackedProcesses $tracked
      Assert-CompanionMaintenanceServices $services -Stopped
      $now=[DateTimeOffset]::UtcNow;$context=@{contract='clued.companion-maintenance.context/1';root=$Root;subject=$ExpectedSubject;operationId=$operation;nonce=$nonce;pid=$PID;processStartedAt=$challenge.processStartedAt;createdAt=$now.ToString('o');expiresAt=$accepted.value.expiresAt;pausedSha256=$paused;services=$services;trackedProcesses=$tracked;coveredWsl=$running;challenge=$challenge;host=$accepted.value;hostSha256=$accepted.sha256;evidenceDirectory=$EvidenceDirectory;latch=$latch}
      $contextFile=Join-Path $EvidenceDirectory 'accepted.json';Write-CompanionMaintenanceNew $contextFile $context
      $contextSha=Get-CompanionMaintenanceHash (Read-CompanionMaintenanceBytes $contextFile)
      Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'action.started.json') @{operationId=$operation;contextSha256=$contextSha;at=[DateTimeOffset]::UtcNow.ToString('o')}
      $actionStarted=$true
      $answer=& $Action $contextFile $contextSha
      Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'action.result.json') @{operationId=$operation;contextSha256=$contextSha;answer=$answer;at=[DateTimeOffset]::UtcNow.ToString('o')}
      $null=Assert-CompanionMaintenanceActionOutcome $context $contextSha $answer
      $actionSucceeded=$true
    }catch{$failure=$_}finally{
      $restore=Invoke-CompanionMaintenanceRecovery $Root $ExpectedSubject $paused $services $HostDrop $EvidenceDirectory $challenge $actionStarted $actionSucceeded $context $contextSha $answer
      Write-CompanionMaintenanceNew (Join-Path $EvidenceDirectory 'restore.json') $restore
      if(@($restore.Keys) -notcontains 'manualRecoveryRequired'){Complete-CompanionMaintenanceLatch $context $restore}
    }
    if($null -ne $failure){throw $failure};if(@($restore.Keys) -contains 'manualRecoveryRequired'){throw 'MAINTENANCE_SERVICE_RESTORE_UNCONFIRMED'}
    return $answer
  }finally{$held.Dispose()}
}
function Invoke-CompanionMaintenance([string]$Root,$ExpectedSubject,[string]$HostDrop,[string]$EvidenceDirectory,[scriptblock]$Action) {
  Assert-CompanionMaintenanceIdentity $ExpectedSubject
  # One account switch can own this machine-wide WSL maintenance interval.
  # A second invocation cannot mint another evidence directory/nonce while
  # the first one is draining or restoring services.
  $security=New-Object Security.AccessControl.MutexSecurity
  $security.SetSecurityDescriptorSddlForm('O:BAG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)')
  $created=$false;$mutex=[Threading.Mutex]::new($false,'Global\Clued.CompanionMaintenance.v1',[ref]$created,$security);$owned=$false
  try{
    Assert-CompanionMaintenanceAcl ($mutex.GetAccessControl().GetSecurityDescriptorSddlForm('All')) ''
    try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$mutex.ReleaseMutex();throw 'MAINTENANCE_PREVIOUS_OWNER_INTERRUPTED'}
    if(-not $owned){throw 'MAINTENANCE_OTHER_OPERATION_ACTIVE'}
    return (Invoke-CompanionMaintenanceCore -Root $Root -ExpectedSubject $ExpectedSubject -HostDrop $HostDrop -EvidenceDirectory $EvidenceDirectory -Action $Action)
  }finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
}
