<#
Source v2 handle-based Windows formal-spool archive (DESIGN S14, §6.4). Runs as NT SERVICE\CluedCIResident.
Nothing in it depends on the caller's identity: the new directory grants modify to the fixed resident SID,
never to the caller, and every leaf is moved through its own held handle. (An elevated run is still not an
approved route: a caller must first prove two-host quiescence the way the service's re-arm does.)
-ExactSceneSha256 (optional; the service never passes it) binds the run to one exact scene: the SHA-256 of
the ordinal-sorted "folder/name|bytes|sha256" lines (LF-joined, UTF-8) of every protocol leaf found. Any other,
extra, replaced or unknown leaf refuses before the destination exists; after the moves the moved set must be
that same set and no protocol leaf may be left, else the receipt is written and the run reports unverified.
Rename only: nothing is deleted, overwritten or re-ACLed.

  powershell -NoProfile -NonInteractive -File archive-windows-spool.ps1 -BatchKey <64hex> -Reason <reason>
  stdout: {"verified":true|false,"directory":"<archive dir name>"|null,"moved":<n>|null,"code":null|"<CODE>",...}

Rules (same allow-list as independent-ci-resident-v1/src/archive.mjs, the offline reference):
  - only the bridge protocol records: incoming\result + blocked + challenge-NN, outgoing\issue + response-NN (each as
    .json and .ready.json) and outgoing\active.lock; there is no directory walk, so a junction planted under
    the spool is never followed;
  - every parent (spool, incoming, outgoing) is held by handle without FILE_SHARE_DELETE for the whole run,
    so it cannot be renamed or replaced; every leaf is held with DELETE access and WITHOUT FILE_SHARE_DELETE
    (nobody else can rename, replace or delete it while held), renamed through that SAME handle into the held
    destination directory handle (FileRenameInformation, never replacing), and its identity is re-read from
    the same handle after the move; no source or destination name is resolved again for the move;
  - archive ACL criterion = the reviewed b22 rule (advance-functions.ps1 Archive-AclRights, branch
    claude/hosted-free-minutes-checks 5634c0e4): file id unchanged, owner and group unchanged, and the
    sorted set of plain allow ACEs (SID|mask|qualifier, only the INHERITED flag allowed) unchanged; a
    same-volume move may turn inherited ACEs explicit or reorder them, which is recorded, not refused.
    The legacy set has 4/5 ACEs. M5-b's six-ACE set must match the exact direction-specific
    management/controller/companion/operator/resident roles, with the operator bound to the protected install record;
  - destinations are FLAT leaf names in one new directory <spool>\archive|failed-<key12>-<reason>-<nonce>
    (lesson b28: a nested "runs/" destination broke a whole archive);
  - effect journals (outgoing\<64hex>.json), observations.jsonl, lock/tmp files of the journal, earlier
    archive directories and .bak names are never touched; for a completed scope (success-close,
    between-roles-4/6) any OTHER leaf, a half pair or a ready marker that does not bind its data refuses
    (nothing moved); for a failure scope they are archived as found (half pairs too) and reported.
#>
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$BatchKey,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,39}$')][string]$Reason,
  [string]$OfflineFixtureSpool,
  [string]$OfflineFixtureNodeProfileBase64,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedNodeProfileSha256,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ExactSceneSha256
)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$Spool='C:\ProgramData\CluedIndependentCI\formal-spool'
$ResidentSid='S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'   # NT SERVICE\CluedCIResident
# Who gets modify on the new archive directory: always the resident service in production, whoever runs it
# (the service itself, or the elevated Owner recovery); only the explicit TEMP fixture mode grants its own caller.
function Get-ArchiveWriterSid{if($OfflineFixtureSpool){return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value};return $ResidentSid}
Add-Type -Path (Join-Path $PSScriptRoot 'windows\NodeProfileV2.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class CluedSpoolArchiveV2 {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint f,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 // Directory held for the whole run: share read+write but NOT delete, so it cannot be renamed/replaced.
 public static SafeFileHandle HoldDirectory(string path){
  var h=CreateFileW(path,0x20080u,3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);if(h.IsInvalid)throw new IOException("SPOOL_PARENT_HOLD_REFUSED");
  try{Info i;if(!GetFileInformationByHandle(h,out i)||(i.Attributes&0x400)!=0||(i.Attributes&0x10)==0)throw new IOException("SPOOL_PARENT_NOT_A_REAL_DIRECTORY");ExactPath(h,path);return h;}catch{h.Dispose();throw;}
 }
 public static Info Metadata(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("SPOOL_METADATA_REFUSED");return i;}
 public static SafeFileHandle HoldAccountFile(string path){
  var h=CreateFileW(path,0x80020080u,1u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new IOException("COMPANION_ACCOUNT_RECORD_UNREADABLE");}
  try{var i=Metadata(h);if((i.Attributes&0x410)!=0||i.Links!=1||i.SizeHigh!=0||i.SizeLow==0||i.SizeLow>4096)throw new IOException("COMPANION_ACCOUNT_RECORD_TYPE_REFUSED");ExactPath(h,path);return h;}catch{h.Dispose();throw;}
 }
 public static byte[] Security(SafeFileHandle h){IntPtr o,g,d,s,p;if(GetSecurityInfo(h,1,7,out o,out g,out d,out s,out p)!=0)throw new IOException("COMPANION_ACCOUNT_RECORD_ACL_UNREADABLE");try{uint n=GetSecurityDescriptorLength(p);if(n<20||n>65536)throw new IOException("COMPANION_ACCOUNT_RECORD_ACL_BOUND");var b=new byte[n];Marshal.Copy(p,b,0,(int)n);return b;}finally{LocalFree(p);}}
 public static bool Stable(Info a,Info b){return a.Attributes==b.Attributes&&a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow&&a.CreatedHigh==b.CreatedHigh&&a.CreatedLow==b.CreatedLow&&((a.Attributes&0x10)!=0||Same(a,b)&&a.WriteHigh==b.WriteHigh&&a.WriteLow==b.WriteLow);}
 public static void ExactPath(SafeFileHandle h,string path){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,32768,0);
  if(n==0||n>=32768||!String.Equals(b.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("SPOOL_PATH_REDIRECTED");}
 public static bool Same(Info a,Info b){return a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow&&a.SizeHigh==b.SizeHigh&&a.SizeLow==b.SizeLow&&a.Links==b.Links;}
 [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle h,out IoStatus io,IntPtr info,uint length,int infoClass);
 [StructLayout(LayoutKind.Sequential)] struct IoStatus {public IntPtr Status,Information;}
 // Leaf: GENERIC_READ|DELETE, shared for READ only (no write, no delete/rename by anyone else), reparse point not followed.
 public static SafeFileHandle HoldLeaf(string path){var h=CreateFileW(path,0x80010000u,1u,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new IOException("SPOOL_LEAF_HOLD_REFUSED");}return h;}
 // Same-handle move: FILE_RENAME_INFORMATION {ReplaceIfExists=FALSE, RootDirectory=the held destination, FileName=flat leaf}.
 public static void RenameInto(SafeFileHandle leaf,SafeFileHandle directory,string name){
  if(String.IsNullOrEmpty(name)||name.Length>64||name.IndexOfAny(new char[]{'\\','/',':'})>=0)throw new IOException("ARCHIVE_LEAF_NAME_REFUSED");
  int at=2*IntPtr.Size,size=at+4+2*name.Length+2;IntPtr b=Marshal.AllocHGlobal(size);bool added=false;
  try{
   for(int i=0;i<size;i++)Marshal.WriteByte(b,i,0);
   directory.DangerousAddRef(ref added);Marshal.WriteIntPtr(b,IntPtr.Size,directory.DangerousGetHandle());Marshal.WriteInt32(b,at,2*name.Length);Marshal.Copy(name.ToCharArray(),0,IntPtr.Add(b,at+4),name.Length);
   IoStatus io;if(NtSetInformationFile(leaf,out io,b,(uint)size,10)!=0)throw new IOException("ARCHIVE_HANDLE_RENAME_REFUSED");
  }finally{if(added)directory.DangerousRelease();Marshal.FreeHGlobal(b);}
 }
}
'@ | Out-Null
$held=New-Object 'Collections.Generic.List[IDisposable]';$result=[ordered]@{verified=$false;directory=$null;moved=$null;code=$null;scope=$null;contract='clued.independent-ci.resident-windows-spool-archive/2'}
function Hash([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Archive-Sddl($Stream){$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access;$raw=New-Object Security.AccessControl.RawSecurityDescriptor([CluedSpoolArchiveV2]::Security($Stream.SafeFileHandle),0);return $raw.GetSddlForm($sections)}
# b22 identity criterion; raw handle descriptors preserve duplicate/unsupported ACEs for refusal.
# Only the established M5-b outgoing six-role set extends the legacy 4/5 shapes.
function Archive-AclRights([string]$Text,[string]$Folder){
 $d=New-Object Security.AccessControl.RawSecurityDescriptor($Text)
 if($null -eq $d.DiscretionaryAcl -or $d.DiscretionaryAcl.Count -lt 4 -or $d.DiscretionaryAcl.Count -gt 6){throw 'EXACT_FIXED_ACCESS_ACES_REQUIRED'}
 $aces=@();foreach($a in $d.DiscretionaryAcl){
  if($a -isnot [Security.AccessControl.CommonAce] -or $a.IsCallback -or $a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$a.AceFlags -band -bnot 16) -ne 0){throw 'EXACT_FIXED_ALLOW_ACE_REQUIRED'}
  $aces+=($a.SecurityIdentifier.Value+'|'+[string]$a.AccessMask+'|'+[string]$a.AceQualifier)
 }
 if($d.DiscretionaryAcl.Count -eq 6){
  if($Folder -cne 'outgoing'){throw 'EXACT_M5B_ARCHIVE_ROLES_REQUIRED'}
  $operator=Get-TrustedArchiveOperator
  $resident=$ResidentSid
  if(@('S-1-5-18','S-1-5-32-544',$Node.ControllerSid,$Node.OwnerSid,$operator,$resident|Sort-Object -Unique).Count -ne 6){throw 'EXACT_M5B_ARCHIVE_ROLES_REQUIRED'}
  if(@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',$Node.ControllerSid) -notcontains $d.Owner.Value){throw 'EXACT_M5B_ARCHIVE_OWNER_REQUIRED'}
  $want=@('S-1-5-18|2032127|AccessAllowed','S-1-5-32-544|2032127|AccessAllowed',($Node.ControllerSid+'|1245631|AccessAllowed'),($Node.OwnerSid+'|1179817|AccessAllowed'),($operator+'|1179817|AccessAllowed'),($resident+'|1179785|AccessAllowed'))
  if(((@($aces|Sort-Object))-join ';') -cne ((@($want|Sort-Object))-join ';')){throw 'EXACT_M5B_ARCHIVE_ROLES_REQUIRED'}
 }
 return $d.Owner.Value+'|'+$d.Group.Value+'|'+((@($aces|Sort-Object))-join ';')
}
function Scene-Sha256($Items){[string[]]$l=@($Items|ForEach-Object{[string]$_.from+'|'+[string]$_.bytes+'|'+[string]$_.sha256});[Array]::Sort($l,[StringComparer]::Ordinal);return Hash ((New-Object Text.UTF8Encoding($false)).GetBytes(($l -join [string][char]10)))}
function Protocol-LeavesPresent{$n=@();foreach($folder in @('incoming','outgoing')){foreach($x in $allow[$folder]){foreach($y in @($x+'.json',$x+'.ready.json')){if([IO.File]::Exists((Join-Path (Join-Path $Spool $folder) $y))){$n+=($folder+'/'+$y)}}}};if([IO.File]::Exists((Join-Path $Spool 'outgoing\active.lock'))){$n+='outgoing/active.lock'};return ,$n}
function Read-Held($Stream){if($Stream.Length -gt 1MB){throw 'SPOOL_LEAF_TOO_LARGE'};$Stream.Position=0;$b=New-Object byte[] ([int]$Stream.Length);$at=0;while($at -lt $b.Length){$n=$Stream.Read($b,$at,$b.Length-$at);if($n -lt 1){throw 'SPOOL_LEAF_TRUNCATED'};$at+=$n};$Stream.Position=0;return ,$b}
# Only the already installed, admin-written identity record supplies the additional reader.
# The explicit offline mode derives the same leaf beneath the fixture's TEMP parent; no path/SID input is accepted.
$accountLease=@();$archiveOperator=$null
function Assert-ArchiveAccountAcl([byte[]]$Bytes,[string]$Path){
 if(-not $OfflineFixtureSpool){[NodeProfilePublicFileV2]::ValidateBootstrapAcl($Bytes,$Path);return}
 $fixtureRoot=[IO.Path]::GetFullPath((Split-Path -Parent $Spool)).TrimEnd('\')
 # Outside the explicit TEMP fixture, no production metadata is trusted or consumed.
 if(-not [string]::Equals($Path,$fixtureRoot,[StringComparison]::OrdinalIgnoreCase) -and -not $Path.StartsWith($fixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)){return}
 $sd=New-Object Security.AccessControl.RawSecurityDescriptor($Bytes,0)
 $managers=@('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
 if($null -eq $sd.Owner -or $managers -notcontains $sd.Owner.Value -or $null -eq $sd.DiscretionaryAcl){throw 'COMPANION_ACCOUNT_RECORD_ACL_REFUSED'}
 foreach($a in $sd.DiscretionaryAcl){
  if($a -isnot [Security.AccessControl.CommonAce] -or $a.IsCallback){throw 'COMPANION_ACCOUNT_RECORD_ACL_REFUSED'}
  if($a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and ([int]$a.AceFlags -band 8) -eq 0 -and $managers -notcontains $a.SecurityIdentifier.Value -and ([int]$a.AccessMask -band 0x500d0156) -ne 0){throw 'COMPANION_ACCOUNT_RECORD_ACL_REFUSED'}
 }
}
function Assert-ArchiveAccountStable{
 foreach($entry in $script:accountLease){
  [CluedSpoolArchiveV2]::ExactPath($entry.handle,$entry.path)
  if(-not [CluedSpoolArchiveV2]::Stable($entry.meta,[CluedSpoolArchiveV2]::Metadata($entry.handle))){throw 'COMPANION_ACCOUNT_RECORD_CHANGED'}
  $now=[CluedSpoolArchiveV2]::Security($entry.handle);Assert-ArchiveAccountAcl $now $entry.path
  if([Convert]::ToBase64String($now) -cne $entry.acl){throw 'COMPANION_ACCOUNT_RECORD_CHANGED'}
 }
}
function Get-TrustedArchiveOperator{
 if($null -ne $script:archiveOperator){Assert-ArchiveAccountStable;return $script:archiveOperator}
 $root=if($OfflineFixtureSpool){Join-Path (Split-Path -Parent $Spool) 'resident'}else{'C:\ProgramData\CluedIndependentCI\resident'}
 $record=Join-Path $root 'install\companion-account.json'
 $chain=New-Object 'Collections.Generic.List[string]';for($p=[IO.Path]::GetDirectoryName($record);$p;$p=[IO.Path]::GetDirectoryName($p)){$chain.Insert(0,$p)}
 foreach($p in @($chain)+@($record)){
  $h=if($p -ceq $record){[CluedSpoolArchiveV2]::HoldAccountFile($p)}else{[CluedSpoolArchiveV2]::HoldDirectory($p)};$held.Add($h)
  $acl=[CluedSpoolArchiveV2]::Security($h);Assert-ArchiveAccountAcl $acl $p
  $script:accountLease+=,[pscustomobject]@{path=$p;handle=$h;meta=[CluedSpoolArchiveV2]::Metadata($h);acl=[Convert]::ToBase64String($acl)}
 }
 $stream=New-Object IO.FileStream($h,[IO.FileAccess]::Read);$held.Add($stream)
 $bytes=Read-Held $stream
 try{$text=(New-Object Text.UTF8Encoding($false,$true)).GetString($bytes);if($text.Contains('\')){throw 'COMPANION_ACCOUNT_RECORD_REFUSED'};$a=$text|ConvertFrom-Json}catch{throw 'COMPANION_ACCOUNT_RECORD_REFUSED'}
 $keys=@($a.PSObject.Properties.Name|Sort-Object)
 if(($keys -join '|') -cne 'companionSid|contract|operatorSid' -or $a.contract -isnot [string] -or $a.contract -cne 'clued.independent-ci.companion-account/1' -or $a.companionSid -isnot [string] -or $a.companionSid -cne $Node.OwnerSid -or $a.operatorSid -isnot [string] -or $a.operatorSid -cnotmatch '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}$' -or $a.operatorSid -ceq $a.companionSid){throw 'COMPANION_ACCOUNT_RECORD_REFUSED'}
 foreach($key in @('contract','companionSid','operatorSid')){if(@([regex]::Matches($text,('(?:\{|,)\s*"'+$key+'"\s*:'))).Count -ne 1){throw 'COMPANION_ACCOUNT_RECORD_REFUSED'}}
 Assert-ArchiveAccountStable;$script:archiveOperator=[string]$a.operatorSid;return $script:archiveOperator
}
try{
 if($OfflineFixtureSpool){
  # Offline tests only: a fixture spool must live under this process's own temp directory.
  $t=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\');$f=[IO.Path]::GetFullPath($OfflineFixtureSpool).TrimEnd('\')
  if(-not $f.StartsWith($t+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED'};$Spool=$f
  if(-not $OfflineFixtureNodeProfileBase64 -or $OfflineFixtureNodeProfileBase64.Length -gt 4096){throw 'OFFLINE_NODE_PROFILE_REQUIRED'}
  $profileBytes=[Convert]::FromBase64String($OfflineFixtureNodeProfileBase64)
  if($profileBytes.Length -gt 4096 -or [Convert]::ToBase64String($profileBytes) -cne $OfflineFixtureNodeProfileBase64){throw 'OFFLINE_NODE_PROFILE_REQUIRED'}
  $fixtureProfile=(New-Object Text.UTF8Encoding($false,$true)).GetString($profileBytes)|ConvertFrom-Json
  $map=New-Object 'Collections.Generic.Dictionary[string,object]';foreach($property in $fixtureProfile.PSObject.Properties){$map.Add($property.Name,$property.Value)}
  $Node=[NodeProfileV2]::FromDictionary($map)
 }else{
  if($OfflineFixtureNodeProfileBase64){throw 'OFFLINE_NODE_PROFILE_WITHOUT_FIXTURE_REFUSED'}
  $nodeLease=[NodeProfileV2]::LoadProtectedProfile('C:\ProgramData\CluedIndependentCI\resident',$ExpectedNodeProfileSha256);$held.Add($nodeLease);$Node=$nodeLease.Profile
 }
 $protocolScope=$Reason -ceq 'success-close' -or $Reason -cmatch '^between-roles-[46]$'
 $result.scope=if($protocolScope){'completed-protocol'}else{'failure-scene'}
 $incoming=Join-Path $Spool 'incoming';$outgoing=Join-Path $Spool 'outgoing'
 foreach($d in @($Spool,$incoming,$outgoing)){$held.Add([CluedSpoolArchiveV2]::HoldDirectory($d))}
 $seq=1..32|ForEach-Object{$_.ToString('00')}
 $allow=[ordered]@{incoming=@('result','blocked')+@($seq|ForEach-Object{'challenge-'+$_});outgoing=@('issue')+@($seq|ForEach-Object{'response-'+$_})}
 $leaves=@();$half=@();$unbound=@()
 foreach($folder in @('incoming','outgoing')){
  $dir=Join-Path $Spool $folder
  foreach($n in $allow[$folder]){
   $data=Join-Path $dir ($n+'.json');$ready=Join-Path $dir ($n+'.ready.json');$a=[IO.File]::Exists($data);$b=[IO.File]::Exists($ready)
   if($a -ne $b){$half+=($folder+'/'+$n)}
   if($a){$leaves+=[pscustomobject]@{folder=$folder;name=($n+'.json');path=$data;pair=$n}}
   if($b){$leaves+=[pscustomobject]@{folder=$folder;name=($n+'.ready.json');path=$ready;pair=$n}}
  }
 }
 $lock=Join-Path $outgoing 'active.lock';if([IO.File]::Exists($lock)){$leaves+=[pscustomobject]@{folder='outgoing';name='active.lock';path=$lock;pair=$null}}
 # Remainder: everything that is NOT an allow-listed record must be a kept kind (journals, archives).
 $known=@{};foreach($l in $leaves){$known[$l.path.ToLowerInvariant()]=$true}
 $keep='^(?:[0-9a-f]{64}\.json(?:\.lock|\.[0-9a-f-]{36}\.tmp)?|observations\.jsonl|active\.lock\.clued-[a-z0-9-]+\.bak)$'
 $remainder=@()
 foreach($folder in @('incoming','outgoing')){foreach($e in [IO.Directory]::GetFileSystemEntries((Join-Path $Spool $folder))){if(-not $known.ContainsKey($e.ToLowerInvariant())){$leaf=[IO.Path]::GetFileName($e);if($folder -ceq 'incoming' -or $leaf -cnotmatch $keep){$remainder+=($folder+'/'+$leaf)}}}}
 foreach($e in [IO.Directory]::GetFileSystemEntries($Spool)){$leaf=[IO.Path]::GetFileName($e);if($leaf -cnotin @('incoming','outgoing') -and $leaf -cnotmatch '^(?:archive|failed|completed)-[A-Za-z0-9-]+$'){$remainder+=$leaf}}
 # Open every leaf by handle (share delete), check type/link/size/path, capture identity and ACL rights.
 $opened=@()
 foreach($l in $leaves){
  $lh=[CluedSpoolArchiveV2]::HoldLeaf($l.path);$held.Add($lh);$f=New-Object IO.FileStream($lh,[IO.FileAccess]::Read);$held.Add($f)
  $m=[CluedSpoolArchiveV2]::Metadata($f.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($f.SafeFileHandle,$l.path)
  if(($m.Attributes -band 0x410) -ne 0 -or $m.Links -ne 1 -or $m.SizeHigh -ne 0 -or $m.SizeLow -gt 1MB){throw 'SPOOL_LEAF_TYPE_LINK_SIZE_REFUSED'}
  $bytes=Read-Held $f;$sddl=Archive-Sddl $f
  $opened+=[pscustomobject]@{leaf=$l;stream=$f;meta=$m;sha256=(Hash $bytes);bytes=$bytes;sddl=$sddl;rights=(Archive-AclRights $sddl $l.folder)}
 }
 foreach($o in $opened){if($o.leaf.name -like '*.ready.json'){
  $data=@($opened|Where-Object{$_.leaf.folder -ceq $o.leaf.folder -and $_.leaf.name -ceq ($o.leaf.pair+'.json')});$ok=$false
  if($data.Count -eq 1){try{$r=(New-Object Text.UTF8Encoding($false,$true)).GetString($o.bytes)|ConvertFrom-Json;$ok=((@($r.PSObject.Properties.Name|Sort-Object)-join '|') -ceq 'bytes|contract|sha256' -and $r.contract -ceq 'clued.independent-ci.complete-public-file/1' -and $r.bytes -eq $data[0].bytes.Length -and $r.sha256 -ceq $data[0].sha256)}catch{$ok=$false}}
  if(-not $ok){$unbound+=($o.leaf.folder+'/'+$o.leaf.pair)}
 }}
 if($ExactSceneSha256){
  $found=Scene-Sha256 @($opened|ForEach-Object{[pscustomobject]@{from=($_.leaf.folder+'/'+$_.leaf.name);bytes=$_.bytes.Length;sha256=$_.sha256}})
  $result['sceneSha256']=$found
  if($found -cne $ExactSceneSha256){throw 'EXACT_SCENE_MISMATCH_NOTHING_MOVED'};if($remainder.Count){throw 'EXACT_SCENE_UNKNOWN_LEAF_NOTHING_MOVED'}
 }
 if($protocolScope){
  if($half.Count){throw 'HALF_PROTOCOL_PAIR_PRESERVED'};if($unbound.Count){throw 'READY_MARKER_BINDING_PRESERVED'};if($remainder.Count){throw 'UNKNOWN_SPOOL_LEAF_PRESERVED'}
 }
 Assert-ArchiveAccountStable
 $prefix=if($protocolScope){'archive'}else{'failed'}
 $nonce=([Guid]::NewGuid().ToString('N')).Substring(0,12);$name=$prefix+'-'+$BatchKey.Substring(0,12)+'-'+$Reason+'-'+$nonce;$target=Join-Path $Spool $name
 if([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)){throw 'ARCHIVE_TARGET_EXISTS'}
 # Created with its final protected DACL: management full, the resident service modify (fixed SID, not the
 # caller: an elevated Owner recovery gives the directory the same roles as the service would), clued-control
 # read. The resident's spool ACEs are this-folder-only (S3), so nothing else would let it add files to it.
 $writer=Get-ArchiveWriterSid;$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false)
 foreach($p in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($writer,'Modify'),@($Node.ControllerSid,'ReadAndExecute'))){$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p[0])),$p[1],'ContainerInherit,ObjectInherit','None','Allow')))}
 [void][IO.Directory]::CreateDirectory($target,$ds);$targetHandle=[CluedSpoolArchiveV2]::HoldDirectory($target);$held.Add($targetHandle)
 $moved=@();$names=@{}
 foreach($o in $opened){
  Assert-ArchiveAccountStable
  $flat=$o.leaf.name;if($names.ContainsKey($flat)){throw 'FLAT_ARCHIVE_NAME_COLLISION'};$names[$flat]=$true
  $dst=Join-Path $target $flat;if([IO.File]::Exists($dst)){throw 'ARCHIVE_LEAF_TARGET_EXISTS'}
  $before=[CluedSpoolArchiveV2]::Metadata($o.stream.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($o.stream.SafeFileHandle,$o.leaf.path)
  if(-not [CluedSpoolArchiveV2]::Same($before,$o.meta)){throw 'ARCHIVE_LEAF_CHANGED_BEFORE_MOVE'}
  [CluedSpoolArchiveV2]::RenameInto($o.stream.SafeFileHandle,$targetHandle,$flat)
  $after=[CluedSpoolArchiveV2]::Metadata($o.stream.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($o.stream.SafeFileHandle,$dst);$afterSddl=Archive-Sddl $o.stream
  if(-not [CluedSpoolArchiveV2]::Same($o.meta,$after) -or (Archive-AclRights $afterSddl $o.leaf.folder) -cne $o.rights -or (Hash (Read-Held $o.stream)) -cne $o.sha256){throw 'ARCHIVE_IDENTITY_CHANGED'}
  $moved+=[ordered]@{from=($o.leaf.folder+'/'+$o.leaf.name);to=$flat;bytes=$o.bytes.Length;sha256=$o.sha256;fileIdOwnerGroupAndEffectiveAccessPreserved=$true;inheritanceOrOrderChanged=($afterSddl -cne $o.sddl)}
 }
 $exactAfter=$null
 if($ExactSceneSha256){$exactAfter=[ordered]@{expected=$ExactSceneSha256;moved=(Scene-Sha256 @($moved|ForEach-Object{[pscustomobject]$_}));protocolLeavesLeft=(Protocol-LeavesPresent)}}
 $receipt=[ordered]@{contract='clued.independent-ci.resident-windows-spool-archive-receipt/2';batchKey=$BatchKey;reason=$Reason;scope=$result.scope;moved=$moved;halfPairs=$half;unboundReadyMarkers=$unbound;remainderLeftInPlace=$remainder;deletesAnything=$false;at=[DateTimeOffset]::UtcNow.ToString('o')}
 if($null -ne $exactAfter){$receipt['exactScene']=$exactAfter}
 $rb=(New-Object Text.UTF8Encoding($false)).GetBytes(($receipt|ConvertTo-Json -Depth 6)+[char]10);$rf=[IO.File]::Open((Join-Path $target 'archive-receipt.json'),'CreateNew','Write','None');try{$rf.Write($rb,0,$rb.Length);$rf.Flush($true)}finally{$rf.Dispose()}
 $result.directory=$name;$result.moved=$moved.Count
 # The receipt is on disk first, so a scene that changed during the run stays documented.
 if($null -ne $exactAfter -and ($exactAfter.moved -cne $ExactSceneSha256 -or @($exactAfter.protocolLeavesLeft).Count -ne 0)){throw 'EXACT_SCENE_CHANGED_DURING_ARCHIVE'}
 $result.verified=$true;$result.moved=$moved.Count;$result['halfPairs']=$half.Count;$result['remainderLeftInPlace']=$remainder.Count
}catch{
 $id=$_.FullyQualifiedErrorId.Split(',')[0];$inner=$_.Exception;while($null -ne $inner.InnerException){$inner=$inner.InnerException}
 $result.code=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}elseif($inner.Message -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$inner.Message}else{'WINDOWS_ARCHIVE_UNCONFIRMED'}
}
finally{for($i=$held.Count-1;$i -ge 0;$i--){$held[$i].Dispose()}}
[Console]::Out.WriteLine(($result|ConvertTo-Json -Compress))
if($result.verified){exit 0}else{exit 2}
