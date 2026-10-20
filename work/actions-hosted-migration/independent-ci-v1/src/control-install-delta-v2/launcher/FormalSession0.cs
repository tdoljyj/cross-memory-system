using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// One SCM activation -> one fixed Node process. No installer, dispatcher loop,
// credential API, network probe, worker launcher, output capture or desktop API.
public static class CluedWindowsFormalEntry {
 public const string ServiceName="actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02";
 public const uint MaximumRunMilliseconds=2700000;
 public static string CommandForRole(string role){return FormalPublicBoundary.CommandForRole(role);}
 [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void MainDelegate(uint argc,IntPtr argv);
 [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate uint HandlerDelegate(uint control,uint type,IntPtr data,IntPtr context);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Table {public string Name;public MainDelegate Main;}
 [StructLayout(LayoutKind.Sequential)] struct ServiceStatus {public uint Type,State,Accept,Exit,Specific,Check,Hint;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public uint Size;public string Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public ushort Show,Reserved2;public IntPtr ReservedBytes,Input,Output,Error;}
 [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup Basic;public IntPtr Attributes;}
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process,Thread;public uint Pid,Tid;}
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit {public long PerProcess,PerJob;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong A,B,C,D,E,F;}
 [StructLayout(LayoutKind.Sequential)] struct Limits {public BasicLimit Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
 [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public uint Size;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool StartServiceCtrlDispatcherW(Table[] table);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr RegisterServiceCtrlHandlerExW(string name,HandlerDelegate callback,IntPtr context);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetServiceStatus(IntPtr handle,ref ServiceStatus status);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string directory,ref StartupEx startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits data,uint length);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint exit);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint exit);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint length,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FormalPublicBoundary.Info info);
 static readonly MainDelegate ServiceMain=RunService;static readonly HandlerDelegate Handler=Control;static readonly object Gate=new object();
 static IntPtr statusHandle,jobHandle;static bool cancelled;static ServiceStatus status;static uint checkpoint;
 static void Fail(string code){throw new InvalidOperationException(code);}
 public static bool ValidNonce(string n){if(n==null||n.Length!=32)return false;foreach(char c in n)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 public static string SafeFailure(string s){if(s==null||s.Length<2||s.Length>80)return "ONE_SHOT_OPERATION_UNCONFIRMED";foreach(char c in s)if(!((c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'))return "ONE_SHOT_OPERATION_UNCONFIRMED";return s;}
 static void Report(uint state,uint failure){lock(Gate){status.Type=16;status.State=state;status.Accept=state==4?1u:0u;status.Exit=failure==0?0u:1066u;status.Specific=failure;status.Check=(state==2||state==3)?++checkpoint:0;status.Hint=state==2?120000u:state==3?10000u:0u;if(!SetServiceStatus(statusHandle,ref status))Fail("SCM_STATUS_UNCONFIRMED");}}
 static void Check(){lock(Gate){if(cancelled)Fail("STOP_REQUESTED");}if(status.State==2)Report(2,0);}
 static uint Control(uint control,uint type,IntPtr data,IntPtr context){if(control==1){lock(Gate){if(status.State==1)return 0;cancelled=true;try{Report(3,0);}catch{}if(jobHandle!=IntPtr.Zero)TerminateJobObject(jobHandle,92);}return 0;}if(control==4)return 0;return 120;}
 static void AssertIdentity(IntPtr token,bool own){using(var i=token==IntPtr.Zero?WindowsIdentity.GetCurrent():new WindowsIdentity(token)){bool service=false;foreach(var g in i.Groups){if(g.Value=="S-1-5-32-544")Fail("ADMIN_GROUP_REFUSED");if(g.Value=="S-1-5-6")service=true;}if(i.User.Value!=FormalPublicBoundary.Controller||!service||Environment.MachineName!="TURING")Fail("FIXED_SERVICE_IDENTITY_REQUIRED");}if(own&&Process.GetCurrentProcess().SessionId!=0)Fail("SCM_SESSION_ZERO_REQUIRED");}
 public static string ChildEnvironment(){var rows=new[]{"HOME=C:\\ProgramData\\CluedIndependentCI\\state\\temp","CLUED_EXECUTION_PROVIDER=independent-control-checks-v1","PATH=C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs","SystemRoot=C:\\Windows","TEMP=C:\\ProgramData\\CluedIndependentCI\\state\\temp","TMP=C:\\ProgramData\\CluedIndependentCI\\state\\temp","USERPROFILE=C:\\ProgramData\\CluedIndependentCI\\state\\temp","WINDIR=C:\\Windows"};Array.Sort(rows,StringComparer.OrdinalIgnoreCase);return String.Join("\0",rows)+"\0\0";}
 static IntPtr NullHandle(uint access){var security=new SecurityAttributes{Size=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};var h=CreateFileW("NUL",access,3,ref security,3,0,IntPtr.Zero);if(h==new IntPtr(-1))Fail("NUL_HANDLE_UNCONFIRMED");return h;}
 static void Child(FormalPublicBoundary boundary,out uint pid,out bool timeout,out bool exitKnown,out uint actualExit,out bool cleanupConfirmed,out string cleanupFailure,out uint activeProcesses){
  IntPtr job=IntPtr.Zero,environment=IntPtr.Zero,token=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;bool initialized=false,assigned=false;Exception primary=null;ProcessInfo p=new ProcessInfo();pid=0;timeout=false;exitKnown=false;actualExit=uint.MaxValue;cleanupConfirmed=false;cleanupFailure=null;activeProcesses=uint.MaxValue;
  try{
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)Fail("CHILD_JOB_CREATE_FAILED");var limits=new Limits();limits.Basic.Flags=0x2000|8;limits.Basic.Active=8;
   if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))))Fail("CHILD_JOB_LIMIT_FAILED");
   lock(Gate){if(cancelled)Fail("STOP_REQUESTED");jobHandle=job;}
   input=NullHandle(0x80000000);output=NullHandle(0x40000000);IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);if(size==IntPtr.Zero)Fail("CHILD_ATTRIBUTE_SIZE_FAILED");
   attributes=Marshal.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(attributes,1,0,ref size))Fail("CHILD_ATTRIBUTE_INIT_FAILED");initialized=true;
   handles=Marshal.AllocHGlobal(2*IntPtr.Size);Marshal.WriteIntPtr(handles,input);Marshal.WriteIntPtr(handles,IntPtr.Size,output);
   if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(2*IntPtr.Size),IntPtr.Zero,IntPtr.Zero))Fail("CHILD_HANDLE_ALLOWLIST_FAILED");
   environment=Marshal.StringToHGlobalUni(ChildEnvironment());var start=new StartupEx();start.Basic.Size=(uint)Marshal.SizeOf(typeof(StartupEx));start.Basic.Flags=0x100|1;start.Basic.Show=0;start.Basic.Input=input;start.Basic.Output=output;start.Basic.Error=output;start.Attributes=attributes;
   // Inherit only the two NUL handles; never any public lock or credential handle.
   if(!CreateProcessW(FormalPublicBoundary.Node,new StringBuilder(boundary.Command),IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x400|4|0x80000,environment,"C:\\Windows\\System32",ref start,out p))Fail("FIXED_CHILD_CREATE_FAILED");
   pid=p.Pid;if(!OpenProcessToken(p.Process,8,out token))Fail("CHILD_TOKEN_QUERY_FAILED");AssertIdentity(token,false);if(Process.GetProcessById((int)p.Pid).SessionId!=0)Fail("CHILD_SESSION_ZERO_REQUIRED");
   if(!AssignProcessToJobObject(job,p.Process))Fail("CHILD_JOB_ASSIGN_FAILED");assigned=true;Check();if(ResumeThread(p.Thread)==0xffffffff)Fail("CHILD_RESUME_FAILED");
   uint waited=WaitForSingleObject(p.Process,boundary.RemainingRunMilliseconds());if(waited==258)timeout=true;else if(waited!=0)Fail("CHILD_WAIT_UNCONFIRMED");
  }catch(Exception error){primary=error;}
  finally{
   // Keep the job and all public boundaries until a checked termination,
   // root exit and accounting.ActiveProcesses==0 are observed, or the bounded
   // cleanup attempt fails explicitly. Stopped alone is never cleanup proof.
   bool direct=true;if(p.Process!=IntPtr.Zero&&!assigned&&WaitForSingleObject(p.Process,0)!=0)direct=TerminateProcess(p.Process,91);
   if(job!=IntPtr.Zero)cleanupConfirmed=FixedFormalJobCleanup.Drain(job,p.Process,timeout?90u:cancelled?92u:91u,10000,out actualExit,out exitKnown,out activeProcesses)&&direct;
   else cleanupConfirmed=p.Process==IntPtr.Zero;
   if(!cleanupConfirmed)cleanupFailure="CHILD_TREE_CLEANUP_UNCONFIRMED";
   lock(Gate){jobHandle=IntPtr.Zero;}if(job!=IntPtr.Zero)CloseHandle(job);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process);if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(token!=IntPtr.Zero)CloseHandle(token);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(input!=IntPtr.Zero)CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);
  }
  if(primary!=null)throw primary;
 }
 static void Receipt(string nonce,string failure,bool identity,FormalPublicBoundary boundary,uint pid,uint exit,bool timeout,bool exitKnown,bool cleanupConfirmed,string cleanupFailure,uint activeProcesses){
  string path=FormalPublicBoundary.State+"\\windows-formal-entry-"+nonce+".json";var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier(FormalPublicBoundary.Controller));
  foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(FormalPublicBoundary.Controller),FileSystemRights.Read|FileSystemRights.Write,AccessControlType.Allow));
  var receipt=new Dictionary<string,object>{{"contract","clued.independent-ci.windows-formal-entry-receipt/1"},{"nonce",nonce},{"state",failure==null&&cleanupConfirmed?"FIXED_CHILD_COMPLETED":"FIXED_CHILD_REFUSED"},{"failure_code",failure},{"actual_sid",identity?FormalPublicBoundary.Controller:"UNVERIFIED"},{"service_pid",Process.GetCurrentProcess().Id},{"session_id",Process.GetCurrentProcess().SessionId},{"node_pid",pid},{"node_exit_code",exitKnown?(object)exit:null},{"timed_out",timeout},{"stop_requested",cancelled},{"tree_cleanup_confirmed",cleanupConfirmed},{"tree_cleanup_failure_code",cleanupFailure},{"tree_active_processes",activeProcesses==uint.MaxValue?null:(object)activeProcesses},{"root_exit_confirmed",exitKnown},{"entry_role",boundary.SelectedRole},{"entry_sha256",boundary.EntryHash},{"config_sha256",boundary.ConfigHash},{"acceptance_sha256",boundary.AcceptanceHash},{"source_manifest_sha256",boundary.SourceManifestHash},{"stdout_captured",false},{"private_bytes_read_by_helper",false},{"host_qualification",false},{"ci_principal_qualification",false}};
  byte[] bytes=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(receipt)+"\n");using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.ReadData|FileSystemRights.WriteData|FileSystemRights.ReadAttributes|FileSystemRights.ReadPermissions,FileShare.Read,4096,FileOptions.WriteThrough,acl)){
   FormalPublicBoundary.Info i;var final=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(f.SafeFileHandle,final,32768,0);if(!GetFileInformationByHandle(f.SafeFileHandle,out i)||i.Links!=1||(i.Attributes&0x410)!=0||n==0||n>=32768||!String.Equals(final.ToString(),"\\\\?\\"+path,StringComparison.OrdinalIgnoreCase))Fail("PUBLIC_RECEIPT_HANDLE_UNCONFIRMED");f.Write(bytes,0,bytes.Length);f.Flush(true);
  }
 }
 static void RunService(uint argc,IntPtr argv){
  string nonce=null,failure=null,cleanupFailure=null;bool identity=false,ready=false,timeout=false,exitKnown=false,cleanupConfirmed=false;uint pid=0,exit=uint.MaxValue,scmFailure=0,activeProcesses=uint.MaxValue;var boundary=new FormalPublicBoundary(Check);
  statusHandle=RegisterServiceCtrlHandlerExW(ServiceName,Handler,IntPtr.Zero);if(statusHandle==IntPtr.Zero)return;
  try{Report(2,0);if(argc!=2)Fail("EXACT_ONE_NONCE_REQUIRED");string name=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv));nonce=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,IntPtr.Size));if(name!=ServiceName||!ValidNonce(nonce))Fail("FIXED_SERVICE_ARGUMENTS_REQUIRED");AssertIdentity(IntPtr.Zero,true);identity=true;boundary.Validate();ready=true;Check();Report(4,0);FormalScmPidHandshake.WaitForIndependentObservation(nonce,boundary.RuntimeDeadlineUtc,delegate{Check();boundary.RemainingRunMilliseconds();});Child(boundary,out pid,out timeout,out exitKnown,out exit,out cleanupConfirmed,out cleanupFailure,out activeProcesses);Check();if(!cleanupConfirmed)Fail("CHILD_TREE_CLEANUP_UNCONFIRMED");if(timeout)Fail("FIXED_CHILD_TIMEOUT");if(exit!=0)Fail("FIXED_NODE_EXIT_NONZERO");}
  catch(InvalidOperationException e){failure=SafeFailure(e.Message);scmFailure=failure=="SERVICE_ENTRY_PINS_UNBOUND"?10u:failure=="STOP_REQUESTED"?92u:failure=="FIXED_CHILD_TIMEOUT"?90u:failure=="FIXED_NODE_EXIT_NONZERO"?30u:ready?31u:20u;}catch{failure="ONE_SHOT_OPERATION_UNCONFIRMED";scmFailure=1;}
  finally{
   if(cleanupFailure!=null){if(failure==null)failure=cleanupFailure;scmFailure=96;}
   // Only a fully locked, verified state parent may receive public bytes. A
   // preflight refusal is exposed by SCM nonzero status, never a success receipt.
   if(ready)try{Receipt(nonce,failure,identity,boundary,pid,exit,timeout,exitKnown,cleanupConfirmed,cleanupFailure,activeProcesses);}catch{scmFailure=93;}
   boundary.Dispose();try{Report(1,scmFailure);}catch{}
  }
 }
 public static int Main(string[] args){if(args.Length!=0)return 94;return StartServiceCtrlDispatcherW(new[]{new Table{Name=ServiceName,Main=ServiceMain},new Table()})?0:95;}
}

// Narrow native cleanup primitive used by this fixed child and local fixtures.
// It accepts existing handles only; it cannot select a command, path or identity.
public static class FixedFormalJobCleanup {
 [StructLayout(LayoutKind.Sequential)] public struct Accounting {public long User,Kernel,PeriodUser,PeriodKernel;public uint Faults,TotalProcesses,ActiveProcesses,TerminatedProcesses;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,out uint returned);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 public static bool Drain(IntPtr job,IntPtr root,uint code,uint maximumWait,out uint exit,out bool exitKnown,out uint active){
  exit=uint.MaxValue;exitKnown=false;active=uint.MaxValue;if(job==IntPtr.Zero||job==new IntPtr(-1)||maximumWait>10000)return false;
  bool terminated=TerminateJobObject(job,code);var timer=Stopwatch.StartNew();
  do{
   Accounting info;uint returned;if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),out returned)||returned!=(uint)Marshal.SizeOf(typeof(Accounting)))return false;
   active=info.ActiveProcesses;if(root!=IntPtr.Zero&&WaitForSingleObject(root,0)==0){uint value;if(GetExitCodeProcess(root,out value)){exit=value;exitKnown=true;}}
   if(active==0&&(root==IntPtr.Zero||exitKnown))return terminated;
   if(timer.ElapsedMilliseconds>=maximumWait)break;Thread.Sleep(20);
  }while(true);return false;
 }
}
