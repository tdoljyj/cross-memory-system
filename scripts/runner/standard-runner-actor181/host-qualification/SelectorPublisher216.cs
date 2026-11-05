using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace CluedSelectorPublisher216 {
 public sealed class Result {public string Status;public bool DirectoryCreated;public bool FileCreated;public bool Published;public bool ParentAclChanged=false;public bool AutomaticRetry=false;public string PayloadSha256;}
 public sealed class DirectoryLease : IDisposable { internal SafeFileHandle ParentHandle,DirectoryHandle; internal DirectoryLease(SafeFileHandle p,SafeFileHandle d){ParentHandle=p;DirectoryHandle=d;} public void Dispose(){if(DirectoryHandle!=null)DirectoryHandle.Dispose();if(ParentHandle!=null)ParentHandle.Dispose();} }
 public static class Publisher {
  public const string Parent="C:\\ProgramData\\CluedIndependentCI";
  public const string DirectoryPath=Parent+"\\standard-runner-actor";
  public const string FilePath=DirectoryPath+"\\root-node-selector212.json";
  [StructLayout(LayoutKind.Sequential)]struct SA{public int Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
  [StructLayout(LayoutKind.Sequential)]struct FileInfo {public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateDirectory(string path,ref SA security);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder s,uint length,uint flags);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetKernelObjectSecurity(SafeFileHandle h,uint information,byte[] sd,uint length,out uint needed);
  static byte[] HeldSecurity(SafeFileHandle h){uint n;GetKernelObjectSecurity(h,5,null,0,out n);Need(n>0&&n<=65536,"HELD_SECURITY_BOUND");byte[] b=new byte[n];Need(GetKernelObjectSecurity(h,5,b,n,out n),"HELD_SECURITY_READ");return b;}
  static SafeFileHandle HoldDirectory(string path){var h=CreateFile(path,0x20080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);try{Need(!h.IsInvalid,"HELD_DIRECTORY_OPEN");FileInfo i;Need(GetFileInformationByHandle(h,out i)&&(i.Attributes&0x10)!=0&&(i.Attributes&0x400)==0,"HELD_DIRECTORY_NOT_REPARSE");var s=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,s,32768,0);Need(n>0&&n<32768&&String.Equals(s.ToString(),@"\\?\"+path,StringComparison.OrdinalIgnoreCase),"HELD_DIRECTORY_EXACT_PATH");return h;}catch{h.Dispose();throw;}}
  static void OwnElevated(){var thread=WindowsIdentity.GetCurrent(true);if(thread!=null){thread.Dispose();throw new InvalidOperationException("PUBLISH_THREAD_IMPERSONATION_REFUSED");}using(var id=WindowsIdentity.GetCurrent()){Need(id.User.Value!="S-1-5-18"&&new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator),"PUBLISH_OWNED_ELEVATED_RELAY_REQUIRED");}}
  public static DirectoryLease HoldExistingDirectoryForInstall(string targetSid){OwnElevated();Target(targetSid);RequireProtectedParent();SafeFileHandle parent=null,dir=null;try{parent=HoldDirectory(Parent);ValidateParentSecurity(HeldSecurity(parent));NoReparse(DirectoryPath);dir=HoldDirectory(DirectoryPath);Exact(HeldSecurity(dir),targetSid,true);return new DirectoryLease(parent,dir);}catch{if(dir!=null)dir.Dispose();if(parent!=null)parent.Dispose();throw;}}
  static void Need(bool v,string c){if(!v)throw new InvalidOperationException(c);}
  static string Hash(byte[] raw){using(var h=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(h.ComputeHash(raw)).Replace("-","").ToLowerInvariant();}
  static void Target(string sid){Need(sid!=null&&System.Text.RegularExpressions.Regex.IsMatch(sid,"\\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\\z"),"EXACT_RUNNER_SID_REQUIRED");new SecurityIdentifier(sid);}
  static byte[] Security(string sid,bool directory){Target(sid);string flags=directory?"OICI":"",rights=directory?"0x1200a9":"0x120089";var s=new RawSecurityDescriptor("O:BAD:P(A;"+flags+";FA;;;SY)(A;"+flags+";FA;;;BA)(A;"+flags+";"+rights+";;;"+sid+")");byte[] raw=new byte[s.BinaryLength];s.GetBinaryForm(raw,0);return raw;}
  public static byte[] DirectorySecurityBytes(string sid){return Security(sid,true);}
  public static byte[] FileSecurityBytes(string sid){return Security(sid,false);}
  static void Exact(byte[] raw,string sid,bool directory){var s=new RawSecurityDescriptor(raw,0);Need(s.Owner!=null&&s.Owner.Value=="S-1-5-32-544"&&(s.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0&&s.DiscretionaryAcl!=null&&s.DiscretionaryAcl.Count==3,"PUBLISHED_OWNER_PROTECTED_ACL");var want=new System.Collections.Generic.HashSet<string>(new string[]{"S-1-5-18","S-1-5-32-544",sid});foreach(GenericAce g in s.DiscretionaryAcl){var a=g as CommonAce;Need(a!=null&&a.AceQualifier==AceQualifier.AccessAllowed&&a.AceFlags==(directory?(AceFlags.ContainerInherit|AceFlags.ObjectInherit):AceFlags.None)&&want.Remove(a.SecurityIdentifier.Value),"PUBLISHED_CLOSED_ACE");Need(a.AccessMask==(a.SecurityIdentifier.Value==sid?(directory?0x1200a9:0x120089):0x1f01ff),"PUBLISHED_READONLY_TARGET_MASK");}Need(want.Count==0,"PUBLISHED_EXACT_TRUSTEES");}
  static void NoReparse(string path){string p=Path.GetFullPath(path);while(!String.IsNullOrEmpty(p)){Need((File.GetAttributes(p)&FileAttributes.ReparsePoint)==0,"PUBLISH_REPARSE_REFUSED");p=Path.GetDirectoryName(p);}}
  static void ValidateParentSecurity(byte[] raw){var acl=new DirectorySecurity();acl.SetSecurityDescriptorBinaryForm(raw);string owner=acl.GetOwner(typeof(SecurityIdentifier)).Value;Need(owner=="S-1-5-32-544"||owner=="S-1-5-18","PUBLISH_PARENT_ADMIN_OWNER");foreach(FileSystemAccessRule a in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))){if(a.AccessControlType!=AccessControlType.Allow||(a.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;string sid=a.IdentityReference.Value;Need(sid=="S-1-5-18"||sid=="S-1-5-32-544"||(((long)a.FileSystemRights&0x500D0156L)==0),"PUBLISH_PARENT_ORDINARY_WRITE_REFUSED");}}
  static void RequireProtectedParent(){NoReparse(Parent);ValidateParentSecurity(System.IO.Directory.GetAccessControl(Parent,AccessControlSections.Owner|AccessControlSections.Access).GetSecurityDescriptorBinaryForm());}
  public static Result Publish(byte[] payload,string targetSid){
   // This native guard is independent of incoming Host JSON. It neither grants
   // authority nor enables any privilege; actual authorization is the owning
   // Root's fresh Source/Owner/CI gate over the private stdio channel.
   OwnElevated();
   Target(targetSid);Need(payload!=null&&payload.Length>0&&payload.Length<=4096,"PUBLIC_SELECTOR_BOUND");new UTF8Encoding(false,true).GetString(payload);
   RequireProtectedParent();byte[] dir=Security(targetSid,true),file=Security(targetSid,false);IntPtr p=Marshal.AllocHGlobal(dir.Length);var result=new Result{Status="UNKNOWN_PRESERVE_NO_RETRY",PayloadSha256=Hash(payload)};
   try{Marshal.Copy(dir,0,p,dir.Length);var sa=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=p,Inherit=false};if(!CreateDirectory(DirectoryPath,ref sa))throw new Win32Exception(Marshal.GetLastWin32Error());result.DirectoryCreated=true;}finally{Marshal.FreeHGlobal(p);}
   using(var lease=HoldExistingDirectoryForInstall(targetSid)){
   string pending=FilePath+".pending216";var security=new FileSecurity();security.SetSecurityDescriptorBinaryForm(file);
   using(var stream=new FileStream(pending,FileMode.CreateNew,FileSystemRights.Write,FileShare.None,4096,FileOptions.WriteThrough,security)){
    result.FileCreated=true;FileInfo info;Need(GetFileInformationByHandle(stream.SafeFileHandle,out info)&&info.Links==1&&(info.Attributes&0x400)==0,"NEW_SELECTOR_SINGLE_LINK");stream.Write(payload,0,payload.Length);stream.Flush(true);
   }
   NoReparse(pending);Exact(File.GetAccessControl(pending,AccessControlSections.Owner|AccessControlSections.Access).GetSecurityDescriptorBinaryForm(),targetSid,false);Need(Hash(File.ReadAllBytes(pending))==result.PayloadSha256,"NEW_SELECTOR_READBACK");
   // Same-directory Move is atomic, never overwrites/adopts an existing target.
   File.Move(pending,FilePath);NoReparse(FilePath);Exact(File.GetAccessControl(FilePath,AccessControlSections.Owner|AccessControlSections.Access).GetSecurityDescriptorBinaryForm(),targetSid,false);Need(Hash(File.ReadAllBytes(FilePath))==result.PayloadSha256,"PUBLISHED_SELECTOR_READBACK");
   result.Published=true;result.Status="CREATED_PUBLIC_ROOT_LOCATOR_NOT_AUTHORITY";return result;}
  }
 }
}
