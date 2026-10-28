# Source v2 controller read lease (port of protected-job-bridge-v3/hold-source.ps1). One fixed process
# holds the checked handles of the claim-free install record (resident\record\*) and of every accepted
# Source file under this script's own installed Source root, prints their bytes/hashes once, and keeps
# the handles until the controller releases the lease (stdin "RELEASE"), stdin closes, or the lease
# expires. No secret, caller path, write permission, admission result or qualification is created here.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true)
$Root='C:\ProgramData\CluedIndependentCI'
$Record=Join-Path $Root 'resident\record'
$Source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..')).TrimEnd('\')
# The controller is the one of the record's pinned node profile (acceptance.json `node`, design §9 C1): the four
# admin-only record files are read (handles held) before the identity check, and no Source file before it.
$Controller=$null
$MaxLeaseHours=4
$Held=New-Object 'Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
$Opened=@{};$ReadCache=@{};$code=2
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class CluedRecordLease {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool ReadFile(SafeFileHandle h,byte[] b,uint n,out uint read,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetFilePointerEx(SafeFileHandle h,long n,out long p,uint method);
 [DllImport("advapi32.dll",SetLastError=true)]static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint i,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
 [DllImport("advapi32.dll")]static extern uint GetSecurityDescriptorLength(IntPtr p);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);
 [StructLayout(LayoutKind.Sequential)]public struct Info{public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 public static SafeFileHandle Open(string path,bool read){
  var h=CreateFileW(path,read?0x80020000u:0x20000u,read?1u:3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
  if(h.IsInvalid)throw new IOException("SOURCE_HANDLE_REFUSED");
  try{Info i;if(!GetFileInformationByHandle(h,out i)||(i.Attributes&0x400)!=0||(read?((i.Attributes&0x10)!=0||i.Links!=1):(i.Attributes&0x10)==0))throw new IOException("SOURCE_TYPE_REFUSED");
   var p=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,p,32768,0);
   if(n==0||n>=32768||!String.Equals(p.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("SOURCE_PATH_CHANGED");return h;
  }catch{h.Dispose();throw;}
 }
 public static byte[] Security(SafeFileHandle h){IntPtr o,g,d,s,sd;if(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out sd)!=0)throw new IOException("SOURCE_DACL_REFUSED");try{uint n=GetSecurityDescriptorLength(sd);if(n==0||n>1048576)throw new IOException("SOURCE_DACL_BOUND");var b=new byte[n];Marshal.Copy(sd,b,0,(int)n);return b;}finally{LocalFree(sd);}}
 public static byte[] Read(SafeFileHandle h){
  Info before;if(!GetFileInformationByHandle(h,out before)||(before.Attributes&0x410)!=0||before.Links!=1||before.SizeHigh!=0||before.SizeLow>4194304)throw new IOException("SOURCE_BYTES_BOUND");
  long at;if(!SetFilePointerEx(h,0,out at,0))throw new IOException("SOURCE_SEEK_REFUSED");
  var result=new byte[before.SizeLow];var chunk=new byte[65536];int offset=0;uint n;
  while(offset<result.Length){uint wanted=(uint)Math.Min(chunk.Length,result.Length-offset);if(!ReadFile(h,chunk,wanted,out n,IntPtr.Zero)||n==0)throw new IOException("SOURCE_READ_INCOMPLETE");Buffer.BlockCopy(chunk,0,result,offset,(int)n);offset+=(int)n;}
  if(!ReadFile(h,chunk,1,out n,IntPtr.Zero)||n!=0)throw new IOException("SOURCE_BYTES_CHANGED");
  Info after;if(!GetFileInformationByHandle(h,out after)||after.Attributes!=before.Attributes||after.Links!=1||after.Volume!=before.Volume||after.IndexHigh!=before.IndexHigh||after.IndexLow!=before.IndexLow||after.SizeHigh!=before.SizeHigh||after.SizeLow!=before.SizeLow||after.WriteHigh!=before.WriteHigh||after.WriteLow!=before.WriteLow)throw new IOException("SOURCE_IDENTITY_CHANGED");return result;
 }
}
'@ | Out-Null
function Hash([byte[]]$b){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
$Admins=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$Write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
$Replace=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
function Hold-Read([string]$File,[string]$ProtectedRoot){
 $target=[IO.Path]::GetFullPath($File);$boundary=[IO.Path]::GetFullPath($ProtectedRoot).TrimEnd('\')
 if($target -cnotmatch '^[A-Za-z]:\\' -or $target.Substring(2).Contains(':') -or -not $target.StartsWith($boundary+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'SOURCE_FIXED_ROOT_REQUIRED'}
 $chain=New-Object 'Collections.Generic.List[string]';for($p=$target;;$p=[IO.Path]::GetDirectoryName($p)){$chain.Insert(0,$p);if($p -eq [IO.Path]::GetPathRoot($p)){break}}
 foreach($p in $chain){
  if($Opened.ContainsKey($p)){continue}
  $leaf=$p -ieq $target;$h=[CluedRecordLease]::Open($p,$leaf);$Held.Add($h)
  $security=[CluedRecordLease]::Security($h);$raw=New-Object Security.AccessControl.RawSecurityDescriptor($security,0);if($null -eq $raw.DiscretionaryAcl){throw 'SOURCE_NULL_DACL_REFUSED'}
  $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetSecurityDescriptorBinaryForm($security);if($Admins -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'SOURCE_OWNER_REFUSED'}
  $rights=$Replace;if($p -ieq $Root -or $p.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){$rights=$Write}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue};if(($rule.FileSystemRights -band $rights) -ne 0 -and $Admins -notcontains $rule.IdentityReference.Value){throw 'SOURCE_WRITABLE_ANCESTOR_REFUSED'}}
  $Opened[$p]=$h
 }
 if(-not $ReadCache.ContainsKey($target)){$ReadCache[$target]=[CluedRecordLease]::Read($Opened[$target])};return ,$ReadCache[$target]
}
try{
 if($Source -cnotmatch '^C:\\ProgramData\\CluedIndependentCI\\resident\\source\\[0-9a-f]{64}$'){throw 'INSTALLED_SOURCE_ROOT_REQUIRED'}
 $documents=[ordered]@{};foreach($name in @('installation.json','acceptance.json','source-manifest.json','signers.json')){$documents[$name]=[Convert]::ToBase64String((Hold-Read (Join-Path $Record $name) $Root))}
 $utf8=New-Object Text.UTF8Encoding($false,$true);$config=$utf8.GetString([Convert]::FromBase64String($documents['installation.json']))|ConvertFrom-Json;$acceptanceBytes=[Convert]::FromBase64String($documents['acceptance.json']);$accepted=$utf8.GetString($acceptanceBytes)|ConvertFrom-Json
 if((Hash $acceptanceBytes) -cne $config.acceptanceSha256 -or $accepted.sourceFiles -isnot [Array] -or $accepted.sourceFiles.Count -lt 1 -or $accepted.sourceFiles.Count -gt 10000){throw 'SOURCE_ACCEPTANCE_BYTES_REFUSED'}
 $Controller=[string]$accepted.node.controllerSid
 if($Controller -cnotmatch '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z' -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $Controller){throw 'EXACT_CONTROLLER_REQUIRED'}
 # validUntil null = until Source change or uninstall; the lease itself is always bounded.
 $expiry=[DateTimeOffset]::UtcNow.AddHours($MaxLeaseHours)
 if($null -ne $accepted.validUntil){$until=[DateTimeOffset]::Parse([string]$accepted.validUntil);if($until -le [DateTimeOffset]::UtcNow){throw 'SOURCE_ACCEPTANCE_EXPIRED'};if($until -lt $expiry){$expiry=$until}}
 $hashes=[ordered]@{};foreach($pin in $accepted.sourceFiles){
  if((@($pin.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'path|sha256' -or $pin.path -isnot [string] -or $pin.path -cmatch '[\\:\x00-\x1f]' -or $pin.path.StartsWith('/') -or @($pin.path.Split('/')|Where-Object{$_ -ceq '' -or $_ -ceq '.' -or $_ -ceq '..'}).Count -gt 0 -or $pin.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $hashes.Contains($pin.path)){throw 'SOURCE_PIN_REFUSED'}
  $b=Hold-Read (Join-Path $Source $pin.path.Replace('/','\')) $Root;$actual=Hash $b;if($actual -cne $pin.sha256){throw 'SOURCE_BYTES_CHANGED'};$hashes[$pin.path]=$actual
 }
 $policy=Hold-Read (Join-Path $Source 'config\merge-admission-policy.json') $Root
 [Console]::Out.WriteLine(([ordered]@{contract='clued.independent-ci.held-record-bytes/1';controllerSid=$Controller;sourceRoot=$Source;expiresAt=$expiry.ToString('o');documents=$documents;sourceHashes=$hashes;policyBase64=[Convert]::ToBase64String($policy)}|ConvertTo-Json -Depth 8 -Compress));[Console]::Out.Flush()
 $release=[Console]::In.ReadLineAsync()
 while(-not $release.Wait(250)){if([DateTimeOffset]::UtcNow -ge $expiry){throw 'SOURCE_LEASE_EXPIRED'}}
 $line=$release.GetAwaiter().GetResult();if($null -ne $line -and $line -cne 'RELEASE'){throw 'SOURCE_RELEASE_REFUSED'};$code=0
}catch{[Console]::Error.WriteLine('HELD_RECORD_REFUSED')}
finally{foreach($h in $Held){$h.Dispose()}}
exit $code
