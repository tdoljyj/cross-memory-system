<#
Source v2 handle-based Windows formal-spool archive (DESIGN S14, §6.4). Runs as NT SERVICE\CluedCIResident,
NEVER elevated. Rename only: nothing is deleted, overwritten or re-ACLed.

  powershell -NoProfile -NonInteractive -File archive-windows-spool.ps1 -BatchKey <64hex> -Reason <reason>
  stdout: {"verified":true|false,"directory":"<archive dir name>"|null,"moved":<n>|null,"code":null|"<CODE>",...}

Rules (same allow-list as independent-ci-resident-v1/src/archive.mjs, the offline reference):
  - only the bridge protocol records: incoming\result + blocked + challenge-NN, outgoing\issue + response-NN (each as
    .json and .ready.json) and outgoing\active.lock; there is no directory walk, so a junction planted under
    the spool is never followed;
  - every parent (spool, incoming, outgoing) is held by handle without FILE_SHARE_DELETE for the whole run,
    so it cannot be renamed or replaced; every leaf is held with FILE_SHARE_DELETE, moved by name, and its
    identity is re-read from the SAME handle after the move;
  - archive ACL criterion = the reviewed b22 rule (advance-functions.ps1 Archive-AclRights, branch
    claude/hosted-free-minutes-checks 5634c0e4): file id unchanged, owner and group unchanged, and the
    sorted set of plain allow ACEs (SID|mask|qualifier, only the INHERITED flag allowed) unchanged; a
    same-volume move may turn inherited ACEs explicit or reorder them, which is recorded, not refused.
    The set has exactly 4 ACEs on a pre-migration spool and 5 after the S3 migration (resident read);
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
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedNodeProfileSha256
)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$Spool='C:\ProgramData\CluedIndependentCI\formal-spool'
Add-Type -Path (Join-Path $PSScriptRoot 'windows\NodeProfileV2.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class CluedSpoolArchiveV2 {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 // Directory held for the whole run: share read+write but NOT delete, so it cannot be renamed/replaced.
 public static SafeFileHandle HoldDirectory(string path){
  var h=CreateFileW(path,0x20080u,3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);if(h.IsInvalid)throw new IOException("SPOOL_PARENT_HOLD_REFUSED");
  try{Info i;if(!GetFileInformationByHandle(h,out i)||(i.Attributes&0x400)!=0||(i.Attributes&0x10)==0)throw new IOException("SPOOL_PARENT_NOT_A_REAL_DIRECTORY");ExactPath(h,path);return h;}catch{h.Dispose();throw;}
 }
 public static Info Metadata(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("SPOOL_METADATA_REFUSED");return i;}
 public static void ExactPath(SafeFileHandle h,string path){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,32768,0);
  if(n==0||n>=32768||!String.Equals(b.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("SPOOL_PATH_REDIRECTED");}
 public static bool Same(Info a,Info b){return a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow&&a.SizeHigh==b.SizeHigh&&a.SizeLow==b.SizeLow&&a.Links==b.Links;}
}
'@ | Out-Null
$held=New-Object 'Collections.Generic.List[IDisposable]';$result=[ordered]@{verified=$false;directory=$null;moved=$null;code=$null;scope=$null;contract='clued.independent-ci.resident-windows-spool-archive/2'}
function Hash([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Archive-Sddl($Stream){$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access;return $Stream.GetAccessControl().GetSecurityDescriptorSddlForm($sections)}
# b22 criterion (5634c0e4 Archive-AclRights), extended to the post-S3 set of 5.
function Archive-AclRights([string]$Text){
 $d=New-Object Security.AccessControl.RawSecurityDescriptor($Text)
 if($null -eq $d.DiscretionaryAcl -or $d.DiscretionaryAcl.Count -lt 4 -or $d.DiscretionaryAcl.Count -gt 5){throw 'EXACT_FIXED_ACCESS_ACES_REQUIRED'}
 $aces=@();foreach($a in $d.DiscretionaryAcl){
  if($a -isnot [Security.AccessControl.CommonAce] -or $a.IsCallback -or $a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$a.AceFlags -band -bnot 16) -ne 0){throw 'EXACT_FIXED_ALLOW_ACE_REQUIRED'}
  $aces+=($a.SecurityIdentifier.Value+'|'+[string]$a.AccessMask+'|'+[string]$a.AceQualifier)
 }
 return $d.Owner.Value+'|'+$d.Group.Value+'|'+((@($aces|Sort-Object))-join ';')
}
function Read-Held($Stream){if($Stream.Length -gt 1MB){throw 'SPOOL_LEAF_TOO_LARGE'};$Stream.Position=0;$b=New-Object byte[] ([int]$Stream.Length);$at=0;while($at -lt $b.Length){$n=$Stream.Read($b,$at,$b.Length-$at);if($n -lt 1){throw 'SPOOL_LEAF_TRUNCATED'};$at+=$n};$Stream.Position=0;return ,$b}
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
  $f=[IO.File]::Open($l.path,'Open','Read',([IO.FileShare]::Read -bor [IO.FileShare]::Delete));$held.Add($f)
  $m=[CluedSpoolArchiveV2]::Metadata($f.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($f.SafeFileHandle,$l.path)
  if(($m.Attributes -band 0x410) -ne 0 -or $m.Links -ne 1 -or $m.SizeHigh -ne 0 -or $m.SizeLow -gt 1MB){throw 'SPOOL_LEAF_TYPE_LINK_SIZE_REFUSED'}
  $bytes=Read-Held $f;$sddl=Archive-Sddl $f
  $opened+=[pscustomobject]@{leaf=$l;stream=$f;meta=$m;sha256=(Hash $bytes);bytes=$bytes;sddl=$sddl;rights=(Archive-AclRights $sddl)}
 }
 foreach($o in $opened){if($o.leaf.name -like '*.ready.json'){
  $data=@($opened|Where-Object{$_.leaf.folder -ceq $o.leaf.folder -and $_.leaf.name -ceq ($o.leaf.pair+'.json')});$ok=$false
  if($data.Count -eq 1){try{$r=(New-Object Text.UTF8Encoding($false,$true)).GetString($o.bytes)|ConvertFrom-Json;$ok=((@($r.PSObject.Properties.Name|Sort-Object)-join '|') -ceq 'bytes|contract|sha256' -and $r.contract -ceq 'clued.independent-ci.complete-public-file/1' -and $r.bytes -eq $data[0].bytes.Length -and $r.sha256 -ceq $data[0].sha256)}catch{$ok=$false}}
  if(-not $ok){$unbound+=($o.leaf.folder+'/'+$o.leaf.pair)}
 }}
 if($protocolScope){
  if($half.Count){throw 'HALF_PROTOCOL_PAIR_PRESERVED'};if($unbound.Count){throw 'READY_MARKER_BINDING_PRESERVED'};if($remainder.Count){throw 'UNKNOWN_SPOOL_LEAF_PRESERVED'}
 }
 $prefix=if($protocolScope){'archive'}else{'failed'}
 $nonce=([Guid]::NewGuid().ToString('N')).Substring(0,12);$name=$prefix+'-'+$BatchKey.Substring(0,12)+'-'+$Reason+'-'+$nonce;$target=Join-Path $Spool $name
 if([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)){throw 'ARCHIVE_TARGET_EXISTS'}
 # Created with its final protected DACL: management full, this account (the resident in production)
 # modify, clued-control read. The resident's spool ACEs are this-folder-only (S3), so nothing else
 # would let it add files to a directory it just created.
 $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false)
 foreach($p in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($me,'Modify'),@($Node.ControllerSid,'ReadAndExecute'))){$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p[0])),$p[1],'ContainerInherit,ObjectInherit','None','Allow')))}
 [void][IO.Directory]::CreateDirectory($target,$ds);$held.Add([CluedSpoolArchiveV2]::HoldDirectory($target))
 $moved=@();$names=@{}
 foreach($o in $opened){
  $flat=$o.leaf.name;if($names.ContainsKey($flat)){throw 'FLAT_ARCHIVE_NAME_COLLISION'};$names[$flat]=$true
  $dst=Join-Path $target $flat;if([IO.File]::Exists($dst)){throw 'ARCHIVE_LEAF_TARGET_EXISTS'}
  $before=[CluedSpoolArchiveV2]::Metadata($o.stream.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($o.stream.SafeFileHandle,$o.leaf.path)
  if(-not [CluedSpoolArchiveV2]::Same($before,$o.meta)){throw 'ARCHIVE_LEAF_CHANGED_BEFORE_MOVE'}
  [IO.File]::Move($o.leaf.path,$dst)
  $after=[CluedSpoolArchiveV2]::Metadata($o.stream.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($o.stream.SafeFileHandle,$dst);$afterSddl=Archive-Sddl $o.stream
  if(-not [CluedSpoolArchiveV2]::Same($o.meta,$after) -or (Archive-AclRights $afterSddl) -cne $o.rights -or (Hash (Read-Held $o.stream)) -cne $o.sha256){throw 'ARCHIVE_IDENTITY_CHANGED'}
  $moved+=[ordered]@{from=($o.leaf.folder+'/'+$o.leaf.name);to=$flat;bytes=$o.bytes.Length;sha256=$o.sha256;fileIdOwnerGroupAndEffectiveAccessPreserved=$true;inheritanceOrOrderChanged=($afterSddl -cne $o.sddl)}
 }
 $receipt=[ordered]@{contract='clued.independent-ci.resident-windows-spool-archive-receipt/2';batchKey=$BatchKey;reason=$Reason;scope=$result.scope;moved=$moved;halfPairs=$half;unboundReadyMarkers=$unbound;remainderLeftInPlace=$remainder;deletesAnything=$false;at=[DateTimeOffset]::UtcNow.ToString('o')}
 $rb=(New-Object Text.UTF8Encoding($false)).GetBytes(($receipt|ConvertTo-Json -Depth 6)+[char]10);$rf=[IO.File]::Open((Join-Path $target 'archive-receipt.json'),'CreateNew','Write','None');try{$rf.Write($rb,0,$rb.Length);$rf.Flush($true)}finally{$rf.Dispose()}
 $result.verified=$true;$result.directory=$name;$result.moved=$moved.Count;$result['halfPairs']=$half.Count;$result['remainderLeftInPlace']=$remainder.Count
}catch{
 $id=$_.FullyQualifiedErrorId.Split(',')[0];$inner=$_.Exception;while($null -ne $inner.InnerException){$inner=$inner.InnerException}
 $result.code=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}elseif($inner.Message -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$inner.Message}else{'WINDOWS_ARCHIVE_UNCONFIRMED'}
}
finally{for($i=$held.Count-1;$i -ge 0;$i--){$held[$i].Dispose()}}
[Console]::Out.WriteLine(($result|ConvertTo-Json -Compress))
if($result.verified){exit 0}else{exit 2}
