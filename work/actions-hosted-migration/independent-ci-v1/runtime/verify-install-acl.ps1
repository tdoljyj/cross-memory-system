param([Parameter(Mandatory=$true)][string]$LiteralTarget, [Parameter(Mandatory=$true)][string]$ProtectedRoot, [switch]$AllowControllerWrite,
  [switch]$ReadFile, [string]$SecretRoot, [string]$ControllerSid)
$ErrorActionPreference = 'Stop'
# The controller account is the caller's pinned node profile controllerSid (resident active/standby design v0.4
# section 9 C1; Source v2: record acceptance `node`, passed by runtime/protected-files.mjs), never a constant here.
# A secret read or a controller-writable check without it, or with anything but that exact shape (\z and [0-9]: .NET's
# `$` and `\d` would also take a trailing newline and non-ASCII digits), exits 3; a plain ancestor check does not use it.
if (($ReadFile -or $AllowControllerWrite) -and $ControllerSid -cnotmatch '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z') { exit 3 }
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
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $target = [IO.Path]::GetFullPath($LiteralTarget)
  if ($target -cnotmatch '^[A-Za-z]:\\' -or $target.Substring(2).Contains(':')) { throw 'LOCAL_FIXED_PATH_REQUIRED' }
  $protected = [IO.Path]::GetFullPath($ProtectedRoot).TrimEnd('\')
  if ($target -ine $protected -and -not $target.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'PROTECTED_ROOT_REQUIRED' }
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
    if ($AllowControllerWrite -and $isLeaf -and $currentSid -ceq $ControllerSid) { $allowedWrite += $ControllerSid }
    if ($allowedWrite -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'OWNER_REFUSED' }
    $private = $ReadFile -and ($item -ieq $secret -or $item.StartsWith($secret+'\',[StringComparison]::OrdinalIgnoreCase))
    $rights = $replaceRights
    if ($item -ieq $protected -or $item.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)) { $rights = $writeRights }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
      $sid = $rule.IdentityReference.Value
      if (($rule.FileSystemRights -band $rights) -ne 0 -and $allowedWrite -notcontains $sid) { throw 'WRITABLE_ANCESTOR_REFUSED' }
      if ($private -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0 -and $admins -notcontains $sid -and $sid -cne $ControllerSid) { throw 'SECRET_READER_REFUSED' }
    }
  }
  if ($ReadFile) { [Console]::Out.Write([Convert]::ToBase64String([CluedRuntimeRead]::Read($held[$held.Count-1]))) }
  exit 0
} catch { exit 2 }
finally { foreach ($handle in $held) { $handle.Dispose() } }
