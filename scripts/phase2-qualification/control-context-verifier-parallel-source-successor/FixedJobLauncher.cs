// Windows 10+ native job-list creation. No installed library or native binary is added.
// The fixed PowerShell entry supplies fixed executable/arguments, never request fields.
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class FixedJobLauncher {
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinimumWorkingSet,MaximumWorkingSet;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT Basic;public IO_COUNTERS IO;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUser,TotalKernel,PeriodUser,PeriodKernel;public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public uint cb;public IntPtr reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,reservedSize;public IntPtr reservedData,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO Startup;public IntPtr Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr Process,Thread;public uint ProcessId,ThreadId; }
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limits,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING data,uint length,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESSINFO process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 static void Require(bool ok,string context){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),context);}
 static void CleanHandle(ref IntPtr h){if(h!=IntPtr.Zero&&h!=new IntPtr(-1)){CloseHandle(h);h=IntPtr.Zero;}}
 // This method is invoked only by the separately pinned fixed launcher. No stdin command API.
 public static int Run(string executable,string fixedCommand,string workingDirectory) {
  IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobArray=IntPtr.Zero,handleArray=IntPtr.Zero;
  IntPtr[] handles=new IntPtr[3];PROCESSINFO pi=new PROCESSINFO();bool initialized=false;
  try {
   job=CreateJobObjectW(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"CreateJobObject");
   EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway or silent-breakaway flag.
   Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))),"Job kill-on-close limit");
   for(int i=0;i<3;i++){IntPtr source=GetStdHandle(-10-i);Require(source!=IntPtr.Zero&&source!=new IntPtr(-1),"Standard pipe handle");Require(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),out handles[i],0,true,2),"Duplicate exact standard handle");}
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);Require(size!=IntPtr.Zero,"Attribute sizing");
   list=Marshal.AllocHGlobal(size);Require(InitializeProcThreadAttributeList(list,2,0,ref size),"Attribute initialization");initialized=true;
   handleArray=Marshal.AllocHGlobal(3*IntPtr.Size);for(int i=0;i<3;i++)Marshal.WriteIntPtr(handleArray,i*IntPtr.Size,handles[i]);
   Require(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handleArray,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Exact inherited handle list");
   jobArray=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobArray,job);
   Require(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000d),jobArray,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Atomic creation job list");
   STARTUPINFOEX startup=new STARTUPINFOEX();startup.Startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX));startup.Startup.flags=0x100;startup.Startup.input=handles[0];startup.Startup.output=handles[1];startup.Startup.error=handles[2];startup.Attributes=list;
   // JOB_LIST attaches at process creation. There is no unassigned-child interval,
   // including if the launcher dies between CreateProcess and ResumeThread.
   Require(CreateProcessW(executable,new StringBuilder(fixedCommand),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,workingDirectory,ref startup,out pi),"Create suspended worker atomically in job");
   bool inside;Require(IsProcessInJob(pi.Process,job,out inside)&&inside,"Exact worker job membership before resume");
   Require(ResumeThread(pi.Thread)!=0xffffffff,"Resume contained worker");
   Require(WaitForSingleObject(pi.Process,0xffffffff)==0,"Wait for contained worker");
   uint code;Require(GetExitCodeProcess(pi.Process,out code),"Worker exit code");
   // Also reap any descendant retained after a normal/error worker exit.
   Require(TerminateJobObject(job,1),"Terminate remaining fixed worker subtree");
   ACCOUNTING accounting;bool empty=false;
   for(int i=0;i<300;i++){Require(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero),"Job active process read");if(accounting.ActiveProcesses==0){empty=true;break;}Thread.Sleep(10);}
   if(!empty)throw new InvalidOperationException("JOB_SUBTREE_TERMINATION_NOT_CONFIRMED");
   return unchecked((int)code);
  } finally {
   // OS handle closure also covers abrupt launcher termination. The job handle is
   // deliberately not inheritable and absent from the child's HANDLE_LIST.
   if(job!=IntPtr.Zero){TerminateJobObject(job,1);CleanHandle(ref job);}
   CleanHandle(ref pi.Thread);CleanHandle(ref pi.Process);for(int i=0;i<3;i++)CleanHandle(ref handles[i]);
   if(initialized)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(jobArray!=IntPtr.Zero)Marshal.FreeHGlobal(jobArray);if(handleArray!=IntPtr.Zero)Marshal.FreeHGlobal(handleArray);
  }
 }
}
