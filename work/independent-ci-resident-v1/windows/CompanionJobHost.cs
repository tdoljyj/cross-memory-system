using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Companion job host (DESIGN §24, Task 8e1f07d3). Compiled once at install into bin\CluedCompanionJobHost.exe (admin-only,
// read and run by the Owner). The companion starts every child through it:
//   CluedCompanionJobHost.exe <nonce: 32 hex> <time limit ms> <absolute application> [arguments...]
// The host creates ONE child suspended and directly inside a job object of its own (PROC_THREAD_ATTRIBUTE_JOB_LIST: the
// child is never outside that job, not even before it runs), checks that it is there and only then lets it run, so the
// child and every process it starts belong to that job and nothing else does (no breakaway is allowed). When the child has exited
// or has outlived the time limit, the host terminates that job and waits until no process of it is left: the principle of
// the generic helper (FormalSession0V2.cs), which only ever ends and drains the job object it created itself. No process
// outside the job is looked at or touched, and no process tree is walked.
// The child inherits exactly three handles: NUL as stdin and the host's own stdout and stderr, so the companion reads the
// child's output unchanged. The host's report is the last line it writes on stderr:
//   clued-job-host <nonce> {"contract":"clued.independent-ci.companion-job-host-report/1",...}
// The host exits with the child's exit code when the child ended on its own, 121 when it outlived the limit, 120 when no
// child ran and 122 otherwise; the companion reads the report, not the code. The job closes with the host
// (KILL_ON_JOB_CLOSE), so a host that is itself ended takes every process of its job with it.
public static class CluedCompanionJobHost {
 public const string Contract="clued.independent-ci.companion-job-host-report/1";
 public const uint MinTimeout=1000,MaxTimeout=3600000,DrainWait=30000;
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public uint Size;public string Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public ushort Show,Reserved2;public IntPtr ReservedBytes,Input,Output,Error;}
 [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup Basic;public IntPtr Attributes;}
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process,Thread;public uint Pid,Tid;}
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit {public long PerProcess,PerJob;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong A,B,C,D,E,F;}
 [StructLayout(LayoutKind.Sequential)] struct Limits {public BasicLimit Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
 [StructLayout(LayoutKind.Sequential)] struct Accounting {public long User,Kernel,PeriodUser,PeriodKernel;public uint Faults,TotalProcesses,ActiveProcesses,TerminatedProcesses;}
 [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public uint Size;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string directory,ref StartupEx startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exit);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
 static void Fail(string code){throw new InvalidOperationException(code);}
 public static string SafeFailure(string s){if(s==null||s.Length<2||s.Length>80)return "JOB_HOST_UNCONFIRMED";foreach(char c in s)if(!((c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'))return "JOB_HOST_UNCONFIRMED";return s;}

 // One argument for CreateProcess, quoted so that CommandLineToArgvW (and the C runtime) give back exactly the same string:
 // the rule libuv applies when the companion's node starts a child directly.
 public static string Quote(string a){
  if(a.Length>0&&a.IndexOfAny(new[]{' ','\t','\n','\v','"'})<0)return a;
  var sb=new StringBuilder("\"");
  for(int i=0;;i++){
   int slashes=0;while(i<a.Length&&a[i]=='\\'){i++;slashes++;}
   if(i==a.Length){sb.Append('\\',slashes*2);break;}
   if(a[i]=='"'){sb.Append('\\',slashes*2+1);sb.Append('"');}else{sb.Append('\\',slashes);sb.Append(a[i]);}
  }
  return sb.Append('"').ToString();
 }
 public static bool ValidNonce(string s){if(s==null||s.Length!=32)return false;foreach(char c in s)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 public static bool ValidTimeout(string s,out uint ms){ms=0;if(s==null||s.Length<1||s.Length>7)return false;foreach(char c in s)if(c<'0'||c>'9')return false;ms=uint.Parse(s);return ms>=MinTimeout&&ms<=MaxTimeout;}
 public static bool ValidApplication(string s){return s!=null&&s.Length>=4&&s.Length<=260&&((s[0]>='A'&&s[0]<='Z')||(s[0]>='a'&&s[0]<='z'))&&s[1]==':'&&s[2]=='\\'&&s.IndexOf('"')<0&&s.IndexOf('\0')<0;}
 // The exact child command line, or null when it cannot be one (CreateProcess takes at most 32767 characters).
 public static string CommandLine(string[] args,int first){
  var sb=new StringBuilder();
  for(int i=first;i<args.Length;i++){if(args[i].IndexOf('\0')>=0)return null;if(i>first)sb.Append(' ');sb.Append(Quote(args[i]));}
  return sb.Length<32767?sb.ToString():null;
 }
 static string Num(uint? v){return v.HasValue?v.Value.ToString():"null";}
 public static string Report(string nonce,bool started,string failure,uint? pid,bool timedOut,uint? exit,uint? leftover,uint? active,uint? total,bool treeZero){
  return "clued-job-host "+(ValidNonce(nonce)?nonce:"-")+" {\"contract\":\""+Contract+"\",\"started\":"+(started?"true":"false")+",\"failure\":"+(failure==null?"null":"\""+failure+"\"")+
   ",\"childPid\":"+Num(pid)+",\"timedOut\":"+(timedOut?"true":"false")+",\"exitCode\":"+Num(exit)+",\"leftover\":"+Num(leftover)+",\"activeProcesses\":"+Num(active)+
   ",\"totalProcesses\":"+Num(total)+",\"treeZero\":"+(treeZero?"true":"false")+"}";
 }
 static bool Query(IntPtr job,out Accounting info){uint returned;return QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),out returned)&&returned==(uint)Marshal.SizeOf(typeof(Accounting));}
 // Terminate the job and wait until it has no process left (and the child's exit code is known). Only this job.
 static bool Drain(IntPtr job,IntPtr child,uint code,out uint exit,out bool exitKnown,out uint active,out uint total){
  exit=0;exitKnown=false;active=uint.MaxValue;total=uint.MaxValue;
  TerminateJobObject(job,code);var start=Environment.TickCount;var again=start;
  for(;;){
   Accounting info;if(!Query(job,out info))return false;active=info.ActiveProcesses;total=info.TotalProcesses;
   if(!exitKnown&&WaitForSingleObject(child,0)==0&&GetExitCodeProcess(child,out exit))exitKnown=true;
   // The proof is the kernel's own count of the job's live processes, read after the job was terminated.
   if(active==0&&exitKnown)return true;
   var now=Environment.TickCount;if(unchecked((uint)(now-start))>=DrainWait)return false;
   // A process that joined while the job was being terminated is ended by terminating the job once more.
   if(active>0&&unchecked((uint)(now-again))>=500){TerminateJobObject(job,code);again=now;}
   Thread.Sleep(20);
  }
 }
 static IntPtr Inheritable(IntPtr h,uint access){
  if(h!=IntPtr.Zero&&h!=new IntPtr(-1)&&SetHandleInformation(h,1,1))return h;
  var security=new SecurityAttributes{Size=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};
  var nul=CreateFileW("NUL",access,3,ref security,3,0,IntPtr.Zero);if(nul==new IntPtr(-1))Fail("NUL_HANDLE_UNCONFIRMED");return nul;
 }
 static void WriteReport(string line){
  try{var h=GetStdHandle(-12);if(h==IntPtr.Zero||h==new IntPtr(-1))return;using(var s=new FileStream(new SafeFileHandle(h,false),FileAccess.Write)){var b=new UTF8Encoding(false).GetBytes("\n"+line+"\n");s.Write(b,0,b.Length);s.Flush();}}catch{}
 }

 public static int Main(string[] args){
  string nonce=args.Length>0?args[0]:null,failure=null;bool started=false,timedOut=false,treeZero=false,exitKnown=false,attributesReady=false;
  uint timeout=0,exit=0,leftover=uint.MaxValue,active=uint.MaxValue,total=uint.MaxValue;uint? pid=null;
  IntPtr job=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,jobs=IntPtr.Zero;ProcessInfo p=new ProcessInfo();
  IntPtr stdOut=GetStdHandle(-11),stdErr=GetStdHandle(-12);
  try{
   if(args.Length<3||!ValidNonce(nonce)||!ValidTimeout(args[1],out timeout)||!ValidApplication(args[2]))Fail("JOB_HOST_ARGUMENTS_REFUSED");
   string command=CommandLine(args,2);if(command==null)Fail("JOB_HOST_ARGUMENTS_REFUSED");
   job=CreateJobObjectW(IntPtr.Zero,null);if(job==IntPtr.Zero)Fail("JOB_CREATE_FAILED");
   // KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION (a crashing child ends at once instead of waiting in error reporting
   // until the limit, as it did under the node job it was started in before); no BREAKAWAY_OK, no SILENT_BREAKAWAY_OK.
   var limits=new Limits();limits.Basic.Flags=0x2000|0x400;
   if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))))Fail("JOB_LIMIT_FAILED");
   input=Inheritable(IntPtr.Zero,0x80000000);
   output=Inheritable(stdOut,0x40000000);error=Inheritable(stdErr,0x40000000);
   var list=output==error?new[]{input,output}:new[]{input,output,error};
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);if(size==IntPtr.Zero)Fail("CHILD_ATTRIBUTE_SIZE_FAILED");
   attributes=Marshal.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(attributes,2,0,ref size))Fail("CHILD_ATTRIBUTE_INIT_FAILED");attributesReady=true;
   handles=Marshal.AllocHGlobal(list.Length*IntPtr.Size);for(int i=0;i<list.Length;i++)Marshal.WriteIntPtr(handles,i*IntPtr.Size,list[i]);
   if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(list.Length*IntPtr.Size),IntPtr.Zero,IntPtr.Zero))Fail("CHILD_HANDLE_ALLOWLIST_FAILED");
   jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);
   if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))Fail("CHILD_JOB_LIST_FAILED");
   var start=new StartupEx();start.Basic.Size=(uint)Marshal.SizeOf(typeof(StartupEx));start.Basic.Flags=0x100|1;start.Basic.Show=0;start.Basic.Input=input;start.Basic.Output=output;start.Basic.Error=error;start.Attributes=attributes;
   // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW; the environment and
   // the current directory are the host's own, which the companion set exactly as it did for a direct child.
   if(!CreateProcessW(args[2],new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,4|0x400|0x80000|0x08000000,IntPtr.Zero,null,ref start,out p))Fail("CHILD_CREATE_FAILED");
   pid=p.Pid;
   // The child has not run a single instruction yet: unless the kernel says it is in the job, it is ended here, never resumed.
   bool inJob;if(!IsProcessInJob(p.Process,job,out inJob)||!inJob){TerminateProcess(p.Process,120);WaitForSingleObject(p.Process,5000);Fail("CHILD_JOB_UNCONFIRMED");}
   if(ResumeThread(p.Thread)==0xffffffff)Fail("CHILD_RESUME_FAILED");
   started=true;
   uint waited=WaitForSingleObject(p.Process,timeout);
   if(waited==258)timedOut=true;else if(waited!=0)Fail("CHILD_WAIT_UNCONFIRMED");
   Accounting before;if(Query(job,out before))leftover=before.ActiveProcesses;
  }catch(InvalidOperationException e){failure=SafeFailure(e.Message);}catch{failure="JOB_HOST_UNCONFIRMED";}
  finally{
   // Whatever happened, a job that holds a process is terminated and drained before the host reports anything.
   if(job!=IntPtr.Zero&&p.Process!=IntPtr.Zero)treeZero=Drain(job,p.Process,timedOut?90u:91u,out exit,out exitKnown,out active,out total);
   else if(job!=IntPtr.Zero){Accounting none;if(Query(job,out none)){active=none.ActiveProcesses;total=none.TotalProcesses;treeZero=active==0;}}
   if(attributesReady)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);
   if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process);if(input!=IntPtr.Zero)CloseHandle(input);
   if(output!=IntPtr.Zero&&output!=stdOut)CloseHandle(output);if(error!=IntPtr.Zero&&error!=stdErr&&error!=output)CloseHandle(error);
  }
  WriteReport(Report(nonce,started,failure,pid,timedOut,exitKnown?(uint?)exit:null,leftover==uint.MaxValue?null:(uint?)leftover,active==uint.MaxValue?null:(uint?)active,total==uint.MaxValue?null:(uint?)total,treeZero));
  if(job!=IntPtr.Zero)CloseHandle(job);
  if(!started)return 120;
  if(timedOut)return 121;
  return failure==null&&exitKnown?unchecked((int)exit):122;
 }
}
