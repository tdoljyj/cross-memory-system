// Source v2 runner-service primitive of CluedCISwapBroker (DESIGN S1). It is the reviewed v1
// FixedScm.cs (CluedSession0ScmV2) with exactly these changes:
//   - it runs as LocalSystem inside the broker service, not under the Owner's elevated token;
//   - the start passes TWO arguments (nonce, configSha256) to the one installed generic helper (S12);
//   - the PID handshake event is the v2 one (owner SYSTEM, see ScmPidHandshakeV2.cs).
// It keeps every v1 check: the full stable snapshot (type, start, error, tag, account, group,
// dependencies, display name, failure actions and flag, triggers, service DACL digest), the cooperative
// controller mutation mutex (same v1 name and DACL, so a legacy elevated v1 tool and the broker exclude
// each other), binary-path-only ChangeServiceConfigW, exactly one StartServiceW, the independent
// running-PID observation before the ACK, and sticky conflict on any incomplete read.
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class ResidentScmV2 {
 public static string Name {get{return NodeProfileV2.Current.RunnerService;}}
 public static string ControllerSid {get{return NodeProfileV2.Current.ControllerSid;}}
 public static string MutationMutexName {get{return NodeProfileV2.Current.MutationMutex;}}
 // Review MINOR-3: only SYSTEM and Administrators manage the runner service and own/hold the mutation mutex.
 // The Owner's user SID is never trusted here (the live runner DACL has no Owner ACE, and an elevated Owner
 // acts through Administrators anyway); a mutex or service DACL that names it is refused.
 static readonly string[] ManagementSids={"S-1-5-18","S-1-5-32-544"};
 static string[] Management(){return (string[])ManagementSids.Clone();}
 static Mutex mutationMutex;static bool mutexHeld,writable,conflict;static IntPtr fixedManager,fixedService;
 public static bool HasConflict {get{return conflict;}}
 static EventWaitHandle startAck;static bool startConsumed,startCallIssued;static uint independentStartPid;
 public static bool StartCallIssued {get{return startCallIssued;}} public static uint IndependentStartPid {get{return independentStartPid;}}
 [StructLayout(LayoutKind.Sequential)] struct Config {public uint Type,Start,Error;public IntPtr Binary,Group;public uint Tag;public IntPtr Dependencies,Account,Display;}
 [StructLayout(LayoutKind.Sequential)] struct Failure {public uint Reset;public IntPtr Reboot,Command;public uint Count;public IntPtr Actions;}
 [StructLayout(LayoutKind.Sequential)] struct Triggers {public uint Count;public IntPtr Items,Reserved;}
 [StructLayout(LayoutKind.Sequential)] public struct Status {public uint Type,State,Accept,Exit,Specific,Check,Hint,Pid,Flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string a,string b,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr h,string name,uint access);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceConfigW(IntPtr h,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceConfig2W(IntPtr h,uint level,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr h,int level,out Status value,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceObjectSecurity(IntPtr h,uint information,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ChangeServiceConfigW(IntPtr h,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,IntPtr password,string display);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool StartServiceW(IntPtr h,uint count,IntPtr args);
 [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr h);
 public sealed class Snapshot {public string Binary,Account,StableDigest,FailureDigest,ServiceSecurityDigest;public uint Type,Start,Error,FailureCount,FailureReset,TriggerCount;public bool FailureNonCrash,FailureCommandPresent,FailureRebootPresent,NoAutomaticFailureActions;public Status Status;}
 public static bool EmptyFailurePolicy(uint count,bool nonCrash,bool command,bool reboot){return count==0&&!nonCrash&&!command&&!reboot;}
 static void Fail(string code){throw new InvalidOperationException(code);}
 static void SystemIdentity(){using(var i=WindowsIdentity.GetCurrent()){if(Environment.MachineName!=NodeProfileV2.Current.Hostname||i.User.Value!="S-1-5-18")Fail("FIXED_BROKER_SYSTEM_REQUIRED");}}
 static string Hash(string s){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-","").ToLowerInvariant();}
 public static string ValidateMutexSecurity(byte[] bytes){
  var sd=new RawSecurityDescriptor(bytes,0);var management=Management();
  if(sd.Owner==null||Array.IndexOf(management,sd.Owner.Value)<0||sd.DiscretionaryAcl==null||(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0||sd.DiscretionaryAcl.Count!=ManagementSids.Length)Fail("MUTEX_OWNER_OR_PROTECTED_DACL_REFUSED");
  var seen=new System.Collections.Generic.HashSet<string>();
  foreach(GenericAce item in sd.DiscretionaryAcl){var ace=item as CommonAce;
   if(ace==null||ace.IsCallback||ace.AceQualifier!=AceQualifier.AccessAllowed||ace.AceFlags!=AceFlags.None||Array.IndexOf(management,ace.SecurityIdentifier.Value)<0||ace.AccessMask!=(int)MutexRights.FullControl||!seen.Add(ace.SecurityIdentifier.Value))Fail("MUTEX_EXACT_MANAGEMENT_ACL_REFUSED");
  }
  return Hash(sd.GetSddlForm(AccessControlSections.Access|AccessControlSections.Owner));
 }
 static void ValidateHeldMutex(){if(mutationMutex==null||!mutexHeld)Fail("FIXED_MUTEX_NOT_HELD");ValidateMutexSecurity(mutationMutex.GetAccessControl().GetSecurityDescriptorBinaryForm());}
 public static void BeginSession(bool allowEffects){
  SystemIdentity();if(fixedService!=IntPtr.Zero||mutationMutex!=null)Fail("FIXED_SESSION_ALREADY_OPEN");
  var security=new MutexSecurity();security.SetOwner(new SecurityIdentifier("S-1-5-18"));security.SetAccessRuleProtection(true,false);
  foreach(string sid in Management())security.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(sid),MutexRights.FullControl,AccessControlType.Allow));
  bool created;
  try{
   mutationMutex=new Mutex(false,MutationMutexName,out created,security);
   ValidateMutexSecurity(mutationMutex.GetAccessControl().GetSecurityDescriptorBinaryForm());
   try{mutexHeld=mutationMutex.WaitOne(0);}catch(AbandonedMutexException){mutexHeld=true;Fail("ABANDONED_CONTROLLER_MUTEX_REFUSED");}
   if(!mutexHeld)Fail("CONTROLLER_MUTATION_MUTEX_BUSY");ValidateHeldMutex();
   fixedService=Service(1|4|0x20000u|(allowEffects?(2u|0x10u):0u),out fixedManager);writable=allowEffects;conflict=false;startConsumed=false;startCallIssued=false;independentStartPid=0;
  }catch{EndSession();throw;}
 }
 public static void EndSession(){
  if(startAck!=null){startAck.Dispose();startAck=null;}
  if(fixedService!=IntPtr.Zero){CloseServiceHandle(fixedService);fixedService=IntPtr.Zero;}
  if(fixedManager!=IntPtr.Zero){CloseServiceHandle(fixedManager);fixedManager=IntPtr.Zero;}
  writable=false;if(mutationMutex!=null){try{if(mutexHeld)mutationMutex.ReleaseMutex();}finally{mutexHeld=false;mutationMutex.Dispose();mutationMutex=null;}}
 }
 static IntPtr HeldService(bool effect){SystemIdentity();ValidateHeldMutex();if(fixedService==IntPtr.Zero||effect&&!writable)Fail("FIXED_SESSION_HANDLE_REQUIRED");if(effect&&conflict)Fail("STICKY_CONFIG_CONFLICT_RESTORE_WITHHELD");return fixedService;}
 public const uint UntrustedControlMask=0x700d0072u;
 public static string ValidateServiceSecurity(byte[] bytes){
  var sd=new RawSecurityDescriptor(bytes,0);string owner=sd.Owner==null?"":sd.Owner.Value;var management=Management();
  if(Array.IndexOf(management,owner)<0||sd.DiscretionaryAcl==null||sd.DiscretionaryAcl.Count>128)Fail("SERVICE_OWNER_OR_DACL_REFUSED");
  foreach(GenericAce item in sd.DiscretionaryAcl){var ace=item as CommonAce;if(ace==null||ace.IsCallback)Fail("SERVICE_ACE_FORM_REFUSED");if(ace.AceQualifier==AceQualifier.AccessDenied)continue;
   if(ace.AceQualifier!=AceQualifier.AccessAllowed)Fail("SERVICE_ACE_FORM_REFUSED");if((ace.AceFlags&AceFlags.InheritOnly)!=0)continue;
   // The resident SID (and anyone but SY/BA) must have NO control right on the runner service (design §3.1):
   // change-config 0x2, start 0x10, stop 0x20, pause 0x40, DELETE, WRITE_DAC, WRITE_OWNER and generic all/execute/write.
   if(Array.IndexOf(management,ace.SecurityIdentifier.Value)<0&&((uint)ace.AccessMask&UntrustedControlMask)!=0)Fail("SERVICE_UNTRUSTED_CONTROL_ACE_REFUSED");
  }
  return Hash(sd.GetSddlForm(AccessControlSections.Access|AccessControlSections.Owner));
 }
 static string ServiceSecurity(IntPtr h){
  uint needed;QueryServiceObjectSecurity(h,5,IntPtr.Zero,0,out needed);if(needed<20||needed>8192)Fail("SERVICE_SECURITY_SIZE_REFUSED");IntPtr b=Marshal.AllocHGlobal((int)needed);
  try{if(!QueryServiceObjectSecurity(h,5,b,needed,out needed))Fail("SERVICE_SECURITY_QUERY_FAILED");var bytes=new byte[(int)needed];Marshal.Copy(b,bytes,0,bytes.Length);return ValidateServiceSecurity(bytes);}finally{Marshal.FreeHGlobal(b);}
 }
 static string Text(IntPtr p,IntPtr buffer,int length,bool multi){
  if(p==IntPtr.Zero)return "";long offset=p.ToInt64()-buffer.ToInt64();if(offset<0||offset>=length)Fail("SCM_POINTER_BOUNDS_REFUSED");var s=new StringBuilder();bool zero=false;
  for(long i=offset;i+1<length;i+=2){char c=(char)Marshal.ReadInt16(buffer,(int)i);if(c==0){if(!multi||zero)return multi?s.ToString().TrimEnd('\0'):s.ToString();zero=true;s.Append('\0');}else{zero=false;s.Append(c);}if(s.Length>32768)Fail("SCM_STRING_SIZE_REFUSED");}Fail("SCM_STRING_TERMINATOR_REFUSED");return null;
 }
 static IntPtr Buffer(IntPtr service,uint level,bool baseConfig,out int length){
  uint needed;bool ok=baseConfig?QueryServiceConfigW(service,IntPtr.Zero,0,out needed):QueryServiceConfig2W(service,level,IntPtr.Zero,0,out needed);
  if(ok||needed<4||needed>8192)Fail("SCM_CONFIG_SIZE_REFUSED");length=(int)needed;IntPtr b=Marshal.AllocHGlobal(length);
  if(!(baseConfig?QueryServiceConfigW(service,b,needed,out needed):QueryServiceConfig2W(service,level,b,needed,out needed))){Marshal.FreeHGlobal(b);Fail("SCM_CONFIG_QUERY_FAILED");}return b;
 }
 static IntPtr Service(uint access,out IntPtr manager){manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)Fail("SCM_OPEN_FAILED");IntPtr h=OpenService(manager,Name,access);if(h==IntPtr.Zero){CloseServiceHandle(manager);manager=IntPtr.Zero;Fail("FIXED_SERVICE_OPEN_FAILED");}return h;}
 static Status State(IntPtr h){Status s;uint n;if(!QueryServiceStatusEx(h,0,out s,(uint)Marshal.SizeOf(typeof(Status)),out n))Fail("SERVICE_STATUS_QUERY_FAILED");return s;}
 public static Status ReadStatus(){return State(HeldService(false));}
 public static Snapshot ReadSnapshot(){try{return ReadSnapshotCore(HeldService(false));}catch{conflict=true;throw;}}
 // Install-time, read-only: the stable digest the Owner's elevated install, or the in-place upgrader (Task 018da927:
 // upgrade-apply.ps1 Compile runs as LocalSystem), pins into broker.json. It opens the runner service with query
 // rights only (no mutex, no effect); the broker later re-reads the same digest under its own session before every
 // swap, so a wrong pin only refuses swaps. LocalSystem is admitted because it already holds every right the elevated
 // Owner has here; refusing it made every in-place upgrade's Compile fail (op 4c256a7b, RUNNER_STABLE_DIGEST_UNCONFIRMED).
 public static bool InstallTimeIdentityAllowed(string machine,string hostname,string user,bool administrator,string ownerSid){
  return machine==hostname&&(user=="S-1-5-18"||(user==ownerSid&&administrator));
 }
 public static string InstallTimeStableDigest(){
  var node=NodeProfileV2.Current;
  using(var identity=WindowsIdentity.GetCurrent()){if(!InstallTimeIdentityAllowed(Environment.MachineName,node.Hostname,identity.User.Value,new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator),node.OwnerSid))Fail("FIXED_INSTALL_OWNER_REQUIRED");}
  IntPtr manager;IntPtr h=Service(1|4|0x20000u,out manager);
  try{return ReadSnapshotCore(h).StableDigest;}finally{CloseServiceHandle(h);CloseServiceHandle(manager);}
 }
 static Snapshot ReadSnapshotCore(IntPtr h){
  IntPtr b=IntPtr.Zero,f=IntPtr.Zero,flag=IntPtr.Zero,triggers=IntPtr.Zero;
  try{int n;b=Buffer(h,0,true,out n);if(n<Marshal.SizeOf(typeof(Config)))Fail("SCM_BASE_CONFIG_SIZE_REFUSED");var c=(Config)Marshal.PtrToStructure(b,typeof(Config));var o=new Snapshot();o.ServiceSecurityDigest=ServiceSecurity(h);
   o.Binary=Text(c.Binary,b,n,false);o.Account=Text(c.Account,b,n,false);o.Type=c.Type;o.Start=c.Start;o.Error=c.Error;o.Status=State(h);
   string stable=c.Type+"|"+c.Start+"|"+c.Error+"|"+c.Tag+"|"+o.Account+"|"+Hash(Text(c.Group,b,n,false))+"|"+Hash(Text(c.Dependencies,b,n,true))+"|"+Hash(Text(c.Display,b,n,false));
   int fn;f=Buffer(h,2,false,out fn);if(fn<Marshal.SizeOf(typeof(Failure)))Fail("SCM_FAILURE_CONFIG_SIZE_REFUSED");var a=(Failure)Marshal.PtrToStructure(f,typeof(Failure));if(a.Count>32)Fail("FAILURE_ACTION_COUNT_REFUSED");
   string reboot=Text(a.Reboot,f,fn,false),command=Text(a.Command,f,fn,false);o.FailureCount=a.Count;o.FailureReset=a.Reset;o.FailureCommandPresent=command.Length>0;o.FailureRebootPresent=reboot.Length>0;
   var actions=new StringBuilder();if(a.Count>0){long at=a.Actions.ToInt64()-f.ToInt64();if(at<0||at+(long)a.Count*8>fn)Fail("FAILURE_ACTION_BOUNDS_REFUSED");for(int i=0;i<a.Count;i++)actions.Append(Marshal.ReadInt32(f,(int)at+i*8)).Append(',').Append(Marshal.ReadInt32(f,(int)at+i*8+4)).Append(';');}
   int fl;flag=Buffer(h,4,false,out fl);if(fl<4)Fail("FAILURE_FLAG_SIZE_REFUSED");o.FailureNonCrash=Marshal.ReadInt32(flag)!=0;
   o.FailureDigest=Hash(a.Reset+"|"+a.Count+"|"+actions+"|"+o.FailureNonCrash+"|"+Hash(reboot)+"|"+Hash(command));
   o.NoAutomaticFailureActions=EmptyFailurePolicy(a.Count,o.FailureNonCrash,o.FailureCommandPresent,o.FailureRebootPresent);
   int tn;triggers=Buffer(h,8,false,out tn);if(tn<Marshal.SizeOf(typeof(Triggers)))Fail("SCM_TRIGGER_CONFIG_SIZE_REFUSED");var triggerInfo=(Triggers)Marshal.PtrToStructure(triggers,typeof(Triggers));o.TriggerCount=triggerInfo.Count;
   if(triggerInfo.Reserved!=IntPtr.Zero)Fail("SCM_TRIGGER_RESERVED_FIELD_REFUSED");
   o.StableDigest=Hash(stable+"|"+o.FailureDigest+"|"+o.TriggerCount+"|"+o.ServiceSecurityDigest);return o;
  }finally{if(triggers!=IntPtr.Zero)Marshal.FreeHGlobal(triggers);if(flag!=IntPtr.Zero)Marshal.FreeHGlobal(flag);if(f!=IntPtr.Zero)Marshal.FreeHGlobal(f);if(b!=IntPtr.Zero)Marshal.FreeHGlobal(b);}
 }
 public static bool Matches(Snapshot s,string binary,string stable,bool requireStopped){
  if(s.Binary!=binary||s.StableDigest!=stable||s.Type!=16||s.Start!=3||!s.NoAutomaticFailureActions||s.TriggerCount!=0||(s.Account!=".\\clued-control"&&s.Account!=NodeProfileV2.Current.Hostname+"\\clued-control"))return false;
  if(new NTAccount(NodeProfileV2.Current.Hostname,"clued-control").Translate(typeof(SecurityIdentifier)).Value!=ControllerSid)return false;
  return !requireStopped||s.Status.State==1;
 }
 public static void AssertExpected(Snapshot s,string binary,string stable,bool requireStopped){if(!Matches(s,binary,stable,requireStopped)){conflict=true;Fail(requireStopped&&s.Binary==binary?"FIXED_SERVICE_NOT_STOPPED":"EXACT_SERVICE_CONFIG_MISMATCH");}}
 public static void SwitchOnlyBinary(string expectedBinary,string targetBinary,string stable){
  IntPtr h=HeldService(true);AssertExpected(ReadSnapshot(),expectedBinary,stable,true);
  bool changed=ChangeServiceConfigW(h,0xffffffff,0xffffffff,0xffffffff,targetBinary,null,IntPtr.Zero,null,null,IntPtr.Zero,null);
  if(changed)AssertExpected(ReadSnapshot(),targetBinary,stable,true);
  else{var after=ReadSnapshot();AssertExpected(after,after.Binary==targetBinary?targetBinary:expectedBinary,stable,true);Fail("SERVICE_BINARY_CHANGE_FAILED");}
 }
 // Exactly one StartServiceW with (nonce, configSha256); the broker observes the running PID itself
 // and only then signals the helper's wait (v1 semantics, v2 event).
 public static uint StartOnce(string helperBinary,string stable,string nonce,string configSha256,DateTimeOffset authorityExpiry){
  HeldService(true);if(startConsumed)Fail("SINGLE_SCM_START_ALREADY_CONSUMED");startConsumed=true;
  FormalScmPidHandshakeV2.NameForNonce(nonce);if(configSha256==null||configSha256.Length!=64)Fail("FIXED_CONFIG_PIN_REQUIRED");
  foreach(char ch in configSha256)if(!((ch>='0'&&ch<='9')||(ch>='a'&&ch<='f')))Fail("FIXED_CONFIG_PIN_REQUIRED");
  if(authorityExpiry<=DateTimeOffset.UtcNow)Fail("FORMAL_AUTHORITY_EXPIRED_BEFORE_START");
  AssertExpected(ReadSnapshot(),helperBinary,stable,true);startAck=FormalScmPidHandshakeV2.CreateManagementEvent(nonce);
  IntPtr h=HeldService(true),first=IntPtr.Zero,second=IntPtr.Zero,args=IntPtr.Zero;
  try{
   first=Marshal.StringToHGlobalUni(nonce);second=Marshal.StringToHGlobalUni(configSha256);args=Marshal.AllocHGlobal(2*IntPtr.Size);Marshal.WriteIntPtr(args,first);Marshal.WriteIntPtr(args,IntPtr.Size,second);
   AssertExpected(ReadSnapshot(),helperBinary,stable,true);startCallIssued=true;bool started=StartServiceW(h,2,args);
   AssertExpected(ReadSnapshot(),helperBinary,stable,false);if(!started)Fail("FIXED_ONCE_START_FAILED");
   var end=DateTimeOffset.UtcNow.AddMilliseconds(FormalScmPidHandshakeV2.MaximumObservationWaitMilliseconds);if(authorityExpiry<end)end=authorityExpiry;
   while(DateTimeOffset.UtcNow<end){
    var status=ReadStatus();
    if(status.State==4){
     uint observed=FormalScmPidHandshakeV2.ObservedRunningPid(status.State,status.Pid);
     var closest=ReadSnapshot();AssertExpected(closest,helperBinary,stable,false);
     if(closest.Status.State!=4||closest.Status.Pid!=observed)Fail("SCM_PID_CHANGED_BEFORE_ACK");
     FormalScmPidHandshakeV2.ValidateSecurity(startAck.GetAccessControl().GetSecurityDescriptorBinaryForm());
     if(DateTimeOffset.UtcNow>=end)Fail("SCM_PID_OBSERVATION_DEADLINE");
     independentStartPid=observed;if(!startAck.Set())Fail("SCM_PID_ACK_SET_FAILED");return independentStartPid;
    }
    if(status.State!=2)Fail("SCM_STOPPED_OR_UNKNOWN_BEFORE_PID_ACK");
    Thread.Sleep(20);
   }
   Fail("SCM_PID_OBSERVATION_DEADLINE");return 0;
  }finally{if(args!=IntPtr.Zero)Marshal.FreeHGlobal(args);if(first!=IntPtr.Zero)Marshal.FreeHGlobal(first);if(second!=IntPtr.Zero)Marshal.FreeHGlobal(second);}
 }
}
