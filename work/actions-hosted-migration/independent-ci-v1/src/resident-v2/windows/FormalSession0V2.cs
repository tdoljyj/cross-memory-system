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

// Source v2 generic stage helper (DESIGN S12): one SCM activation -> one fixed Node process. It is the
// reviewed v1 FormalSession0.cs with these changes only:
//   - the service is started with exactly TWO arguments (nonce, configSha256), by CluedCISwapBroker;
//   - the boundary is FormalPublicBoundaryV2 (no compiled per-batch constant);
//   - the child command passes --stage <nonce> --config-sha256 <sha> to the v2 entry;
//   - the receipt (contract /2) also binds the entry's outcome record by its SHA-256 and grants the
//     resident read access to it, so the resident can classify the ending (S11);
//   - a refusal before the boundary is ready (no receipt, the SCM exit code only) also writes one Application
//     event under the service name, best effort: the code, the path being opened, the stage (r13 PR-2).
// No installer, dispatcher loop, credential API, network probe, worker launcher, output capture or
// desktop API. The job object still drains the whole tree before any receipt claims cleanup.
public static class CluedWindowsFormalEntryV2 {
 public static string ServiceName {get{return NodeProfileV2.Current.RunnerService;}}
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
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint exit);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint length,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FormalPublicBoundaryV2.Info info);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr RegisterEventSourceW(string server,string source);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DeregisterEventSource(IntPtr log);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReportEventW(IntPtr log,ushort type,ushort category,uint id,IntPtr user,ushort count,uint size,string[] strings,IntPtr data);
 static readonly MainDelegate ServiceMain=RunService;static readonly HandlerDelegate Handler=Control;static readonly object Gate=new object();
 static IntPtr statusHandle,jobHandle;static bool cancelled;static ServiceStatus status;static uint checkpoint;
 static void Fail(string code){throw new InvalidOperationException(code);}
 // A refusal before ready leaves no receipt (only a validated boundary may write one), so the SCM exit code is all the resident sees.
 // One Application event says which check refused, at which path, in which stage. The source is the service name, unregistered:
 // RegisterEventSourceW/ReportEventW need no registration and no administrator (EventLog.WriteEntry would create the source and
 // throw); the Application log grants write to SERVICE (SU), which AssertIdentity requires. Best effort: a write that fails is
 // not retried and changes nothing, neither the exit code nor the receipt rule. The writer is a field only so the pure tests can
 // stand it in.
 internal static Func<string,string,bool> PreflightEventWriter=WriteApplicationEvent;
 static bool WriteApplicationEvent(string source,string text){IntPtr log=RegisterEventSourceW(null,source);if(log==IntPtr.Zero)return false;
  try{return ReportEventW(log,1,0,20,IntPtr.Zero,1,0,new[]{text},IntPtr.Zero);}finally{DeregisterEventSource(log);}}
 public static bool ReportRefusedBeforeReady(bool ready,string failure,FormalPublicBoundaryV2 boundary){
  if(ready||failure==null)return false;
  try{return PreflightEventWriter(ServiceName,"formal helper refused before ready: code="+failure+" path="+(boundary.LastOpenPath??"none")+" stage="+boundary.Stage);}catch{return false;}
 }
 public static string SafeFailure(string s){if(s==null||s.Length<2||s.Length>80)return "ONE_SHOT_OPERATION_UNCONFIRMED";foreach(char c in s)if(!((c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'))return "ONE_SHOT_OPERATION_UNCONFIRMED";return s;}
 static void Report(uint state,uint failure){lock(Gate){status.Type=16;status.State=state;status.Accept=state==4?1u:0u;status.Exit=failure==0?0u:1066u;status.Specific=failure;status.Check=(state==2||state==3)?++checkpoint:0;status.Hint=state==2?120000u:state==3?10000u:0u;if(!SetServiceStatus(statusHandle,ref status))Fail("SCM_STATUS_UNCONFIRMED");}}
 static void Check(){lock(Gate){if(cancelled)Fail("STOP_REQUESTED");}if(status.State==2)Report(2,0);}
 static uint Control(uint control,uint type,IntPtr data,IntPtr context){if(control==1){lock(Gate){if(status.State==1)return 0;cancelled=true;try{Report(3,0);}catch{}if(jobHandle!=IntPtr.Zero)TerminateJobObject(jobHandle,92);}return 0;}if(control==4)return 0;return 120;}
 static void AssertIdentity(IntPtr token,bool own){using(var i=token==IntPtr.Zero?WindowsIdentity.GetCurrent():new WindowsIdentity(token)){bool service=false;foreach(var g in i.Groups){if(g.Value=="S-1-5-32-544")Fail("ADMIN_GROUP_REFUSED");if(g.Value=="S-1-5-6")service=true;}if(i.User.Value!=FormalPublicBoundaryV2.Controller||!service||Environment.MachineName!=NodeProfileV2.Current.Hostname)Fail("FIXED_SERVICE_IDENTITY_REQUIRED");}if(own&&Process.GetCurrentProcess().SessionId!=0)Fail("SCM_SESSION_ZERO_REQUIRED");}
 public static string ChildEnvironment(){var t=FormalPublicBoundaryV2.Temp;var rows=new[]{"HOME="+t,"CLUED_EXECUTION_PROVIDER=independent-ci-resident-v2","PATH=C:\\Windows\\System32;C:\\Windows;"+FormalPublicBoundaryV2.Resident+"\\runtime","SystemRoot=C:\\Windows","TEMP="+t,"TMP="+t,"USERPROFILE="+t,"WINDIR=C:\\Windows"};Array.Sort(rows,StringComparer.OrdinalIgnoreCase);return String.Join("\0",rows)+"\0\0";}
 static IntPtr NullHandle(uint access){var security=new SecurityAttributes{Size=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};var h=CreateFileW("NUL",access,3,ref security,3,0,IntPtr.Zero);if(h==new IntPtr(-1))Fail("NUL_HANDLE_UNCONFIRMED");return h;}
 static void Child(FormalPublicBoundaryV2 boundary,out uint pid,out bool timeout,out bool exitKnown,out uint actualExit,out bool cleanupConfirmed,out string cleanupFailure,out uint activeProcesses){
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
   if(!CreateProcessW(FormalPublicBoundaryV2.Node,new StringBuilder(boundary.Command),IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x400|4|0x80000,environment,"C:\\Windows\\System32",ref start,out p))Fail("FIXED_CHILD_CREATE_FAILED");
   pid=p.Pid;if(!OpenProcessToken(p.Process,8,out token))Fail("CHILD_TOKEN_QUERY_FAILED");AssertIdentity(token,false);if(Process.GetProcessById((int)p.Pid).SessionId!=0)Fail("CHILD_SESSION_ZERO_REQUIRED");
   if(!AssignProcessToJobObject(job,p.Process))Fail("CHILD_JOB_ASSIGN_FAILED");assigned=true;Check();if(ResumeThread(p.Thread)==0xffffffff)Fail("CHILD_RESUME_FAILED");
   uint waited=WaitForSingleObject(p.Process,boundary.RemainingRunMilliseconds());if(waited==258)timeout=true;else if(waited!=0)Fail("CHILD_WAIT_UNCONFIRMED");
  }catch(Exception error){primary=error;}
  finally{
   bool direct=true;if(p.Process!=IntPtr.Zero&&!assigned&&WaitForSingleObject(p.Process,0)!=0)direct=TerminateProcess(p.Process,91);
   if(job!=IntPtr.Zero)cleanupConfirmed=FixedFormalJobCleanup.Drain(job,p.Process,timeout?90u:cancelled?92u:91u,10000,out actualExit,out exitKnown,out activeProcesses)&&direct;
   else cleanupConfirmed=p.Process==IntPtr.Zero;
   if(!cleanupConfirmed)cleanupFailure="CHILD_TREE_CLEANUP_UNCONFIRMED";
   lock(Gate){jobHandle=IntPtr.Zero;}if(job!=IntPtr.Zero)CloseHandle(job);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process);if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(token!=IntPtr.Zero)CloseHandle(token);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(input!=IntPtr.Zero)CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);
  }
  if(primary!=null)throw primary;
 }
 // The entry's own outcome record (written by the child, as clued-control) bound by hash. Absent or
 // not a plain single-link file = null (the resident then treats the ending as outcome-missing).
 public static string OutcomeSha256(string nonce){
  string path=FormalPublicBoundaryV2.Receipts+"\\outcome-"+nonce+".json";
  try{using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){FormalPublicBoundaryV2.Info i;var final=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(f.SafeFileHandle,final,32768,0);
   if(!GetFileInformationByHandle(f.SafeFileHandle,out i)||i.Links!=1||(i.Attributes&0x410)!=0||n==0||n>=32768||!String.Equals(final.ToString(),"\\\\?\\"+path,StringComparison.OrdinalIgnoreCase)||f.Length<1||f.Length>65536)return null;
   using(var sha=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(sha.ComputeHash(f)).Replace("-","").ToLowerInvariant();}}catch{return null;}
 }
 static void Receipt(string nonce,string failure,bool identity,FormalPublicBoundaryV2 boundary,uint pid,uint exit,bool timeout,bool exitKnown,bool cleanupConfirmed,string cleanupFailure,uint activeProcesses){
  string path=FormalPublicBoundaryV2.Receipts+"\\windows-formal-entry-"+nonce+".json";var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier(FormalPublicBoundaryV2.Controller));
  foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
  acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(FormalPublicBoundaryV2.Controller),FileSystemRights.Read|FileSystemRights.Write,AccessControlType.Allow));
  acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(FormalPublicBoundaryV2.ResidentSid),FileSystemRights.Read,AccessControlType.Allow));
  var receipt=new Dictionary<string,object>{{"contract","clued.independent-ci.windows-formal-entry-receipt/2"},{"nonce",nonce},{"state",failure==null&&cleanupConfirmed?"FIXED_CHILD_COMPLETED":"FIXED_CHILD_REFUSED"},{"failure_code",failure},{"actual_sid",identity?FormalPublicBoundaryV2.Controller:"UNVERIFIED"},{"service_pid",Process.GetCurrentProcess().Id},{"session_id",Process.GetCurrentProcess().SessionId},{"node_pid",pid},{"node_exit_code",exitKnown?(object)exit:null},{"timed_out",timeout},{"stop_requested",cancelled},{"tree_cleanup_confirmed",cleanupConfirmed},{"tree_cleanup_failure_code",cleanupFailure},{"tree_active_processes",activeProcesses==uint.MaxValue?null:(object)activeProcesses},{"root_exit_confirmed",exitKnown},{"entry_role",boundary.SelectedRole},{"stage",boundary.Stage},{"entry_sha256",boundary.EntryHash},{"config_sha256",boundary.ConfigHash},{"acceptance_sha256",boundary.AcceptanceHash},{"source_manifest_sha256",boundary.SourceManifestHash},{"outcome_sha256",OutcomeSha256(nonce)},{"stdout_captured",false},{"private_bytes_read_by_helper",false},{"host_qualification",false},{"ci_principal_qualification",false}};
  byte[] bytes=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(receipt)+"\n");using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.ReadData|FileSystemRights.WriteData|FileSystemRights.ReadAttributes|FileSystemRights.ReadPermissions,FileShare.Read,4096,FileOptions.WriteThrough,acl)){
   FormalPublicBoundaryV2.Info i;var final=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(f.SafeFileHandle,final,32768,0);if(!GetFileInformationByHandle(f.SafeFileHandle,out i)||i.Links!=1||(i.Attributes&0x410)!=0||n==0||n>=32768||!String.Equals(final.ToString(),"\\\\?\\"+path,StringComparison.OrdinalIgnoreCase))Fail("PUBLIC_RECEIPT_HANDLE_UNCONFIRMED");f.Write(bytes,0,bytes.Length);f.Flush(true);
  }
 }
 // Use the identity of the actual, validated role-probe service. Only a public observation is written.
 static void ObserveRenewalKey() {
  string target=Path.Combine(FormalPublicBoundaryV2.Receipts,"renew-key-controller.json");
  string tmp=target+"."+Guid.NewGuid().ToString("N");
  try {
   var bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(RenewalKeyAccessV2.Observation()));
   using(var f=new FileStream(tmp,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {f.Write(bytes,0,bytes.Length);f.Flush(true);}
   if(File.Exists(target)) File.Replace(tmp,target,null);else File.Move(tmp,target);
  } catch { /* The original role probe and its receipt are independent. */ }
  finally {try {File.Delete(tmp);}catch{}}
 }
 static void RunService(uint argc,IntPtr argv){
  string nonce=null,config=null,failure=null,cleanupFailure=null;bool identity=false,ready=false,timeout=false,exitKnown=false,cleanupConfirmed=false;uint pid=0,exit=uint.MaxValue,scmFailure=0,activeProcesses=uint.MaxValue;var boundary=new FormalPublicBoundaryV2(Check);
  statusHandle=RegisterServiceCtrlHandlerExW(ServiceName,Handler,IntPtr.Zero);if(statusHandle==IntPtr.Zero)return;
  try{Report(2,0);if(argc!=3)Fail("EXACT_NONCE_AND_CONFIG_REQUIRED");string name=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv));nonce=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,IntPtr.Size));config=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,2*IntPtr.Size));
   if(name!=ServiceName||!FormalPublicBoundaryV2.ValidNonce(nonce)||!FormalPublicBoundaryV2.Hash(config))Fail("FIXED_SERVICE_ARGUMENTS_REQUIRED");AssertIdentity(IntPtr.Zero,true);identity=true;boundary.Validate(nonce,config);ready=true;Check();Report(4,0);
   FormalScmPidHandshakeV2.WaitForIndependentObservation(nonce,boundary.RuntimeDeadlineUtc,delegate{Check();boundary.RemainingRunMilliseconds();});
   Child(boundary,out pid,out timeout,out exitKnown,out exit,out cleanupConfirmed,out cleanupFailure,out activeProcesses);Check();if(!cleanupConfirmed)Fail("CHILD_TREE_CLEANUP_UNCONFIRMED");if(timeout)Fail("FIXED_CHILD_TIMEOUT");if(exit!=0)Fail("FIXED_NODE_EXIT_NONZERO");}
  catch(InvalidOperationException e){failure=SafeFailure(e.Message);scmFailure=failure=="STOP_REQUESTED"?92u:failure=="FIXED_CHILD_TIMEOUT"?90u:failure=="FIXED_NODE_EXIT_NONZERO"?30u:ready?31u:20u;}catch{failure="ONE_SHOT_OPERATION_UNCONFIRMED";scmFailure=1;}
  finally{
   if(cleanupFailure!=null){if(failure==null)failure=cleanupFailure;scmFailure=96;}
   // Only a fully validated boundary may write a receipt; a preflight refusal is the SCM exit code.
   if(ready && identity && boundary.Stage==11) ObserveRenewalKey();
   if(ready)try{Receipt(nonce,failure,identity,boundary,pid,exit,timeout,exitKnown,cleanupConfirmed,cleanupFailure,activeProcesses);}catch{scmFailure=93;}
   ReportRefusedBeforeReady(ready,failure,boundary);
   boundary.Dispose();try{Report(1,scmFailure);}catch{}
  }
 }
 public static int Main(string[] args){
  NodeProfileLeaseV2 bootstrap=null;
  try{var pins=NodeProfileV2.HelperBootstrapPins(args);bootstrap=NodeProfileV2.LoadAccepted(NodeProfileV2.FixedResidentRoot,pins[0],pins[1]);
   return StartServiceCtrlDispatcherW(new[]{new Table{Name=ServiceName,Main=ServiceMain},new Table()})?0:95;
  }catch{return 94;}finally{if(bootstrap!=null)bootstrap.Dispose();}
 }
}

// Narrow native cleanup primitive (unchanged from v1 FormalSession0.cs).
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
