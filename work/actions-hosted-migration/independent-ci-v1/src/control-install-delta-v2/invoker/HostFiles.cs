using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Metadata-only existing files and atomic creation of fixed new public paths.
// Never request READ_DATA on an existing credential; never modify an old ACL.
public static class VerifyInstallFiles {
 const string Root="C:\\ProgramData\\CluedIndependentCI";
 [StructLayout(LayoutKind.Sequential)] struct SA {public uint Length;public IntPtr Descriptor;public int Inherit;}
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateFileW")] static extern SafeFileHandle Open(string p,uint a,uint share,IntPtr sa,uint create,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateDirectoryW")] static extern bool CreateDir(string p,ref SA sa);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint length,uint flags);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint security,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static void NewDirectory(string path,byte[] descriptor) {
  if(!path.StartsWith(Root+"\\",StringComparison.Ordinal)||path.Contains("..")||path.IndexOf(':',2)>=0)throw new IOException("FIXED_NEW_ROOT_REQUIRED");
  var pin=GCHandle.Alloc(descriptor,GCHandleType.Pinned);try{var sa=new SA();sa.Length=(uint)Marshal.SizeOf(sa);sa.Descriptor=pin.AddrOfPinnedObject();if(!CreateDir(path,ref sa))throw new IOException("NEW_PROTECTED_DIRECTORY_REFUSED");}finally{pin.Free();}
 }
 public static SafeFileHandle HoldMetadata(string path,bool directory) {
  var h=Open(path,0x00020080, directory?3u:1u,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  if(h.IsInvalid){h.Dispose();throw new IOException("METADATA_HANDLE_REFUSED");}
  try{var i=Metadata(h);if((i.Attributes&0x400)!=0||directory&&(i.Attributes&0x10)==0||!directory&&((i.Attributes&0x10)!=0||i.Links!=1))throw new IOException("METADATA_TYPE_LINK_REFUSED");ExactPath(h,path);return h;}catch{h.Dispose();throw;}
 }
 public static Info Metadata(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("HANDLE_METADATA_REFUSED");return i;}
 public static void ExactPath(SafeFileHandle h,string path){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,32768,0);if(n==0||n>=32768||!String.Equals(b.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("EXACT_HANDLE_PATH_REFUSED");}
 public static byte[] Security(SafeFileHandle h){IntPtr o,g,d,s,p;if(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p)!=0)throw new IOException("HANDLE_SECURITY_REFUSED");try{uint n=GetSecurityDescriptorLength(p);if(n<20||n>65536)throw new IOException("DESCRIPTOR_SIZE_REFUSED");var b=new byte[n];Marshal.Copy(p,b,0,(int)n);return b;}finally{LocalFree(p);}}
}
