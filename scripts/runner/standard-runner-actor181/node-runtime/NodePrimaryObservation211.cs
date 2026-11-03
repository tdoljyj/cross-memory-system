using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
namespace CluedNodeObservation211 {
 public sealed class Observation {
  public int process_id {get;set;} public string creation_file_time {get;set;}
  public string sid {get;set;} public string image {get;set;} public string host {get;set;}
  public bool elevated {get;set;} public bool thread_impersonation {get;set;}
  public bool enabled_or_deny_only_admin_sid {get;set;} public bool primary_token_observed {get;set;}
  public int thread_count {get;set;} public string token_id {get;set;}
 }
 public static class Reader {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr a,peb,b,c,pid,parent; }
  [StructLayout(LayoutKind.Sequential)] struct Group {public IntPtr sid;public uint attributes;}
  [StructLayout(LayoutKind.Sequential)] struct Groups {public uint count;public Group first;}
  [StructLayout(LayoutKind.Sequential)] struct ThreadEntry {public uint size,usage,id,owner;public int priority,delta;public uint flags;}
  [StructLayout(LayoutKind.Sequential)] struct Luid {public uint low;public int high;public override string ToString(){return high.ToString("x8")+low.ToString("x8");}}
  [StructLayout(LayoutKind.Sequential)] struct Statistics {public Luid id,auth;public long expires;public int type,level;public uint charged,available,groups,privileges;public Luid modified;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long start,out long end,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder value,ref uint size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int kind,ref Basic basic,int size,out int needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint rights,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenThreadToken(IntPtr thread,uint rights,bool self,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int needed);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool Thread32First(IntPtr snapshot,ref ThreadEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool Thread32Next(IntPtr snapshot,ref ThreadEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenThread(uint rights,bool inherit,uint id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr thread);
  static void Need(bool v,string c){if(!v)throw new InvalidOperationException(c);}
  static IntPtr Info(IntPtr token,int kind,out int length){GetTokenInformation(token,kind,IntPtr.Zero,0,out length);Need(length>0&&length<=1048576,"TOKEN_INFORMATION_BOUND");IntPtr p=Marshal.AllocHGlobal(length);int returned;if(!GetTokenInformation(token,kind,p,length,out returned)){Marshal.FreeHGlobal(p);throw new Win32Exception(Marshal.GetLastWin32Error());}Need(returned<=length,"TOKEN_INFORMATION_LENGTH");return p;}
  static int Integer(IntPtr token,int kind){int n;IntPtr p=Info(token,kind,out n);try{Need(n==4,"TOKEN_INTEGER_LENGTH");return Marshal.ReadInt32(p);}finally{Marshal.FreeHGlobal(p);}}
  static string TokenId(IntPtr token){int n;IntPtr p=Info(token,10,out n);try{Need(n>=Marshal.SizeOf(typeof(Statistics)),"TOKEN_STATISTICS_LENGTH");var s=(Statistics)Marshal.PtrToStructure(p,typeof(Statistics));Need(s.type==1,"PRIMARY_TOKEN_REQUIRED");return s.id.ToString();}finally{Marshal.FreeHGlobal(p);}}
  static string TokenVersion(IntPtr token){int n;IntPtr p=Info(token,10,out n);try{Need(n>=Marshal.SizeOf(typeof(Statistics)),"TOKEN_STATISTICS_LENGTH");var s=(Statistics)Marshal.PtrToStructure(p,typeof(Statistics));Need(s.type==1,"PRIMARY_TOKEN_REQUIRED");return s.id.ToString()+"/"+s.modified.ToString();}finally{Marshal.FreeHGlobal(p);}}
  static bool AdminGroup(IntPtr token){int n;IntPtr p=Info(token,2,out n);try{uint count=unchecked((uint)Marshal.ReadInt32(p));int offset=(int)Marshal.OffsetOf(typeof(Groups),"first"),size=Marshal.SizeOf(typeof(Group));Need(count<=4096&&offset+(long)count*size<=n,"TOKEN_GROUPS_BOUND");bool found=false;for(int i=0;i<count;i++){var g=(Group)Marshal.PtrToStructure(IntPtr.Add(p,offset+i*size),typeof(Group));long s=g.sid.ToInt64(),lo=p.ToInt64();Need(s>=lo&&s+8<=lo+n,"TOKEN_GROUP_SID_BOUND");int sidBytes=8+Marshal.ReadByte(g.sid,1)*4;Need(s+sidBytes<=lo+n,"TOKEN_GROUP_SID_LENGTH");if(new SecurityIdentifier(g.sid).Value=="S-1-5-32-544"&&(g.attributes&0x14)!=0)found=true;}return found;}finally{Marshal.FreeHGlobal(p);}}
  static List<uint> Threads(int pid){IntPtr snapshot=CreateToolhelp32Snapshot(4,0);if(snapshot==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());try{var result=new List<uint>();var e=new ThreadEntry{size=(uint)Marshal.SizeOf(typeof(ThreadEntry))};if(!Thread32First(snapshot,ref e))throw new Win32Exception(Marshal.GetLastWin32Error());do{if(e.owner==(uint)pid)result.Add(e.id);e.size=(uint)Marshal.SizeOf(typeof(ThreadEntry));}while(Thread32Next(snapshot,ref e));Need(Marshal.GetLastWin32Error()==18,"THREAD_ENUMERATION_INCOMPLETE");Need(result.Count>0&&result.Count<=1024,"NODE_THREAD_BOUND");result.Sort();return result;}finally{CloseHandle(snapshot);}}
  static bool Same(List<uint> a,List<uint> b){if(a.Count!=b.Count)return false;for(int i=0;i<a.Count;i++)if(a[i]!=b[i])return false;return true;}
  public static Observation ReadOwnParent(int expectedPid,string expectedImage){
   Need(expectedPid>0&&!String.IsNullOrEmpty(expectedImage),"PARENT_SELECTOR_REQUIRED");
   int length;var own=new Basic();Need(NtQueryInformationProcess(Process.GetCurrentProcess().Handle,0,ref own,Marshal.SizeOf(typeof(Basic)),out length)==0&&own.parent.ToInt64()==expectedPid,"ONLY_ACTUAL_PARENT_ALLOWED");
   IntPtr process=OpenProcess(0x101000,false,expectedPid);if(process==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
   try{Need(WaitForSingleObject(process,0)==258,"PARENT_NOT_LIVE");long start,end,kernel,user;Need(GetProcessTimes(process,out start,out end,out kernel,out user),"PARENT_CREATION_UNKNOWN");uint cap=32768;var image=new StringBuilder((int)cap);Need(QueryFullProcessImageName(process,0,image,ref cap)&&String.Equals(image.ToString(),expectedImage,StringComparison.OrdinalIgnoreCase)&&System.IO.Path.GetFileName(image.ToString()).Equals("node.exe",StringComparison.OrdinalIgnoreCase),"PARENT_IMAGE_MISMATCH");
    IntPtr token;if(!OpenProcessToken(process,8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
    try{string tokenId=TokenId(token),version=TokenVersion(token);Need(Integer(token,8)==1,"PRIMARY_TOKEN_REQUIRED");bool elevated=Integer(token,20)!=0,admin=AdminGroup(token),impersonation=false;string sid;using(var identity=new WindowsIdentity(token))sid=identity.User.Value;
     var threads=Threads(expectedPid);foreach(uint id in threads){IntPtr thread=OpenThread(0x0800,false,id);if(thread==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());try{Need(GetProcessIdOfThread(thread)==(uint)expectedPid,"THREAD_OWNER_CHANGED");IntPtr impersonationToken;if(OpenThreadToken(thread,8,true,out impersonationToken)){CloseHandle(impersonationToken);impersonation=true;}else Need(Marshal.GetLastWin32Error()==1008,"THREAD_TOKEN_UNKNOWN");}finally{CloseHandle(thread);}}
     Need(Same(threads,Threads(expectedPid))&&WaitForSingleObject(process,0)==258,"NODE_IDENTITY_CHANGED_DURING_READ");
     IntPtr fresh;if(!OpenProcessToken(process,8,out fresh))throw new Win32Exception(Marshal.GetLastWin32Error());try{Need(Integer(fresh,8)==1&&TokenId(fresh)==tokenId&&TokenVersion(fresh)==version,"NODE_PRIMARY_TOKEN_CHANGED_DURING_READ");}finally{CloseHandle(fresh);}
     return new Observation{process_id=expectedPid,creation_file_time=start.ToString(System.Globalization.CultureInfo.InvariantCulture),sid=sid,image=image.ToString(),host=Environment.MachineName,elevated=elevated,thread_impersonation=impersonation,enabled_or_deny_only_admin_sid=admin,primary_token_observed=true,thread_count=threads.Count,token_id=tokenId};
    }finally{CloseHandle(token);}
   }finally{CloseHandle(process);}
  }
 }
}
