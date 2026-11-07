# Source v2 copy of protected-job-bridge-v3/formal-spool-acl.ps1 (DESIGN S3): the resident service SID's exact
# migrated grants are allowed and the 'blocked' record names are fixed spool leaves. Metadata only.
# bf57ff10 P2 A' (2026-11-07): -LiteralTarget may name up to 8 fixed spool paths joined by '|', a character no Windows
# path can contain, so one helper process serves a whole relay transfer or mailbox read (it was one process per path:
# 0.43 s each). Every path is checked in the given order by the unchanged per-path code below, exactly as a lone target
# was; the first refusal of any path refuses the call (exit 2), and exit 0 means every path passed. The handles of every
# checked chain stay held until this process ends, as one target's did. A single path behaves as before.
param([Parameter(Mandatory=$true)][string]$LiteralTarget, [Parameter(Mandatory=$true)][string]$ProtectedRoot, [switch]$AllowControllerWrite,
  [switch]$RelayReadOutgoing, [switch]$ReadFile, [string]$SecretRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedNodeProfileSha256)
$ErrorActionPreference = 'Stop'
$NodeLease=$null
Add-Type -Path (Join-Path $PSScriptRoot '..\..\src\resident-v2\windows\NodeProfileV2.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
# Source v2 (DESIGN S3): NT SERVICE\CluedCIResident holds exactly the masks resident-v2/acl-model.json adds
# (list/traverse + add-subdirectory on the spool, list/traverse + delete-child on incoming/outgoing, read on
# their files). Those exact grants are the only extra allowance; any other right for it, or any other SID, is
# still WRITABLE_ANCESTOR_REFUSED. The resident can archive (rename) records, never create one.
$ResidentSid = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
# Hold every ancestor against rename/replacement. Read only the handle whose
# owner/DACL/type/path have actually been checked; return no diagnostics/bytes on refusal.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CluedRuntimeRead {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint i,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  public static SafeFileHandle Open(string path,bool read) {
    var h=CreateFileW(path,read ? 0x80020000u : 0x20000u,read ? 1u : 3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
    if(h.IsInvalid) throw new IOException("HANDLE_UNCONFIRMED");
    try {
      Info i; if(!GetFileInformationByHandle(h,out i) || (i.Attributes & 0x400)!=0) throw new IOException("REPARSE_REFUSED");
      var final=new StringBuilder(32768); var count=GetFinalPathNameByHandleW(h,final,32768,0);
      if(count==0 || count>=32768 || !String.Equals(final.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new IOException("PATH_CHANGED");
      return h;
    } catch { h.Dispose(); throw; }
  }
  public static byte[] Security(SafeFileHandle h) {
    IntPtr o,g,d,s,sd; if(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out sd)!=0) throw new IOException("DACL_UNCONFIRMED");
    try { uint n=GetSecurityDescriptorLength(sd); if(n==0 || n>1048576) throw new IOException("DACL_SIZE");
      var b=new byte[n]; Marshal.Copy(sd,b,0,(int)n); return b;
    } finally { LocalFree(sd); }
  }
  public static byte[] Read(SafeFileHandle h) {
    Info before; if(!GetFileInformationByHandle(h,out before) || (before.Attributes & 0x410)!=0 || before.Links!=1 || before.SizeHigh!=0 || before.SizeLow>1048576) throw new IOException("FILE_TYPE_REFUSED");
    using(var stream=new FileStream(h,FileAccess.Read)) {
      var b=new byte[before.SizeLow]; int pos=0;
      while(pos<b.Length) { int n=stream.Read(b,pos,b.Length-pos); if(n==0) throw new IOException("READ_INCOMPLETE"); pos+=n; }
      if(stream.ReadByte()!=-1) throw new IOException("FILE_CHANGED");
      Info after; if(!GetFileInformationByHandle(h,out after) || after.Links!=1 || after.SizeHigh!=before.SizeHigh || after.SizeLow!=before.SizeLow || after.WriteHigh!=before.WriteHigh || after.WriteLow!=before.WriteLow) throw new IOException("FILE_CHANGED");
      return b;
    }
  }
}
'@ | Out-Null
$held = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
try {
  $NodeLease=[NodeProfileV2]::LoadProtectedProfile('C:\ProgramData\CluedIndependentCI\resident',$ExpectedNodeProfileSha256)
  $ControllerSid=$NodeLease.Profile.ControllerSid;$OwnerSid=$NodeLease.Profile.OwnerSid
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $targets = $LiteralTarget.Split([char]'|')
  if ($targets.Count -lt 1 -or $targets.Count -gt 8) { throw 'FIXED_SPOOL_TARGET_COUNT_REQUIRED' }
  foreach ($oneTarget in $targets) {
  if ([string]::IsNullOrEmpty($oneTarget)) { throw 'FIXED_SPOOL_TARGET_REQUIRED' }
  $target = [IO.Path]::GetFullPath($oneTarget)
  if ($target -cnotmatch '^[A-Za-z]:\\' -or $target.Substring(2).Contains(':')) { throw 'LOCAL_FIXED_PATH_REQUIRED' }
  $protected = [IO.Path]::GetFullPath($ProtectedRoot).TrimEnd('\')
  if ($target -ine $protected -and -not $target.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'PROTECTED_ROOT_REQUIRED' }
  # This helper is exclusively for the fixed, controller-written public spool.
  # Owner-writable results are untrusted signed input and never use this mode.
  $spool = 'C:\ProgramData\CluedIndependentCI\formal-spool'
  $outgoing=Join-Path $spool 'outgoing';$incoming=Join-Path $spool 'incoming'
  $leaves=@('issue.json','issue.ready.json','result.json','result.ready.json','blocked.json','blocked.ready.json','active.lock','observations.jsonl')
  foreach($i in 1..32){$n=$i.ToString('00');$leaves+=@(('challenge-'+$n+'.json'),('challenge-'+$n+'.ready.json'),('response-'+$n+'.json'),('response-'+$n+'.ready.json'))}
  $controller = $AllowControllerWrite -and -not $RelayReadOutgoing -and $currentSid -ceq $ControllerSid
  $relay = $RelayReadOutgoing -and -not $AllowControllerWrite -and $currentSid -ceq $OwnerSid
  if ((-not $controller -and -not $relay) -or $ReadFile -or $protected -ine $spool) { throw 'FIXED_PUBLIC_SPOOL_REQUIRED' }
  # Owner relay is metadata-only and cannot request arbitrary files/secrets.
  if ($relay -and $target -ine $spool -and $target -ine $outgoing -and $target -ine $incoming -and [IO.Path]::GetDirectoryName($target) -ine $outgoing) { throw 'FIXED_RELAY_PUBLIC_PATH_REQUIRED' }
  if ($target -ine $spool -and $target -ine $outgoing -and $target -ine $incoming -and
    (([IO.Path]::GetDirectoryName($target) -ine $outgoing -and [IO.Path]::GetDirectoryName($target) -ine $incoming) -or $leaves -notcontains [IO.Path]::GetFileName($target))) { throw 'FIXED_PUBLIC_SPOOL_LEAF_REQUIRED' }
  if ($ReadFile) {
    if ($currentSid -cne $ControllerSid -or $AllowControllerWrite) { throw 'EXACT_CONTROLLER_REQUIRED' }
    $secret = [IO.Path]::GetFullPath($SecretRoot).TrimEnd('\')
    if (-not $target.StartsWith($secret+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'SECRET_BOUNDARY_REQUIRED' }
  }
  $chain = New-Object 'System.Collections.Generic.List[string]'
  for ($cursor=$target; ; $cursor=[IO.Path]::GetDirectoryName($cursor)) {
    $chain.Insert(0,$cursor)
    if ($cursor -eq [IO.Path]::GetPathRoot($cursor)) { break }
  }
  $admins = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  # OS ancestors may let users create unrelated siblings; replacement of the
  # existing protected child still requires these mutation/delete rights.
  $replaceRights = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  foreach ($item in $chain) {
    $isLeaf = [string]::Equals($item,$target,[StringComparison]::OrdinalIgnoreCase)
    $h = [CluedRuntimeRead]::Open($item,($ReadFile -and $isLeaf)); $held.Add($h)
    $security = [CluedRuntimeRead]::Security($h)
    $raw = New-Object Security.AccessControl.RawSecurityDescriptor($security,0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'NULL_DACL_REFUSED' }
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetSecurityDescriptorBinaryForm($security)
    $allowedWrite = $admins
    if ($item -ieq $outgoing -or ([IO.Path]::GetDirectoryName($item) -ieq $outgoing -and $leaves -contains [IO.Path]::GetFileName($item))) { $allowedWrite += $ControllerSid }
    # Incoming public challenges/results may be imported by the existing Owner
    # relay. They are untrusted input, never Native verdicts or Source config.
    if ($item -ieq $incoming -or ([IO.Path]::GetDirectoryName($item) -ieq $incoming -and $leaves -contains [IO.Path]::GetFileName($item))) { $allowedWrite += $OwnerSid }
    if ($allowedWrite -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'OWNER_REFUSED' }
    $private = $ReadFile -and ($item -ieq $secret -or $item.StartsWith($secret+'\',[StringComparison]::OrdinalIgnoreCase))
    $residentMask = 0
    if ($item -ieq $spool) { $residentMask = 0x1200a5 }
    elseif ($item -ieq $outgoing -or $item -ieq $incoming) { $residentMask = 0x1200e1 }
    elseif (([IO.Path]::GetDirectoryName($item) -ieq $outgoing -or [IO.Path]::GetDirectoryName($item) -ieq $incoming) -and $leaves -contains [IO.Path]::GetFileName($item)) { $residentMask = 0x120089 }
    $rights = $replaceRights
    if ($item -ieq $protected -or $item.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)) { $rights = $writeRights }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
      $sid = $rule.IdentityReference.Value
      $granted = [int]$rule.FileSystemRights
      if ($sid -ceq $ResidentSid -and $residentMask -ne 0 -and ($granted -band (-bnot $residentMask)) -eq 0) { $granted = 0 }
      if (($granted -band [int]$rights) -ne 0 -and $allowedWrite -notcontains $sid) { throw 'WRITABLE_ANCESTOR_REFUSED' }
      if ($private -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0 -and $admins -notcontains $sid -and $sid -cne $ControllerSid) { throw 'SECRET_READER_REFUSED' }
    }
  }
  }
  if ($ReadFile) { [Console]::Out.Write([Convert]::ToBase64String([CluedRuntimeRead]::Read($held[$held.Count-1]))) }
  exit 0
} catch { exit 2 }
finally { foreach ($handle in $held) { $handle.Dispose() }; if($null -ne $NodeLease){$NodeLease.Dispose()} }
