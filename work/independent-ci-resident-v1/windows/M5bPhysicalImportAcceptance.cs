// Disposable TURING acceptance harness. Compile in the same assembly as the
// production registrar, with /main:M5bPhysicalImportAcceptance. No production
// CLI, root, task folder, companion account or distribution is changed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;
using Microsoft.Win32;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class M5bPhysicalImportAcceptance {
  public const string Root = @"C:\ProgramData\CluedM5bPhysical1109";
  public const string Seed = @"C:\ProgramData\CluedM5bSeed1109\ext4.vhdx";
  public const string BuildRoot = @"C:\ProgramData\CluedM5bPhysicalBuild1109";
  public const string Account = "clued-m5b-1109";
  public const string FolderName = "CluedM5bPhysical1109";
  public const string Distro = "CluedM5bPhysical1109";
  const string Contract = "clued.m5b.disposable-import-acceptance/1";
  const string HeartbeatName = "TestHeartbeat";
  const string HarnessName = "M5bPhysicalImportAcceptance.exe";
  const string OperatorSid = "S-1-5-21-1173730660-3877291096-655431861-1001";
  const string RegisteredSid = "S-1-5-21-1173730660-3877291096-655431861-1016";
  const string RegisteredRunId = "5653e46c-67e6-4557-9b87-50e10202c7fd";
  const string RegisteredSeedSha256 = "86b75a42423b5af3499442ff08cbfe38a6cfc5bc85c72514e586163601e6ce71";
  const string RegisteredHeartbeatSha256 = "7bc20b77f0e640309a1a6057eb159cb7894d04fd1c09b20797ab9120475ae403";
  const string RegisteredManifestSha256 = "905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb";
  const string RegisteredStagesSha256 = "b31aa29993c78fbf3177a1a215f52ce42065dcf0df6ddc403127b236e179f5fc";
  const string RegisteredSourceSha256 = "52ec0731a881a94805778789f9eee3f0c1be9ecaa943cebea536b98a187659de";
  const string RegisteredRegistrarSha256 = "11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b";
  const string RegisteredImportActionSha256 = "00a7776cf2e053f2d771b1f63a966ea7aa3c009f03dcd815816fcee3433d5661";
  const string RegisteredHeartbeatArgumentsSha256 = "6b20e9b742e448a5040d026ac2543b7e1901731b50790eea284f575bfccba943";
  const string ResumeName = "M5bPhysicalImportAcceptance.resume-registered.exe";
  const string CorrectionName = "M5bPhysicalImportAcceptance.disk-access-correction.exe";
  const string LoggingName = "M5bPhysicalImportAcceptance.logging-blocked.exe";
  const string CorrectionSourceSha256 = "cf04a44ad504bc44d0f043bf69c420b2439879ff928f45a978e78d31bacd02af";
  const string CorrectionExeSha256 = "f3b44379c4c18a1caff34eafdd659d6d718c854cc2900336b73973f3803825f0";
  const string CorrectionId = "797eaaa9-e19e-4d2f-8ddb-727348fea693";
  const string CorrectionIntentSha256 = "2fd519c1e9762df3e177674c739f8414cbb1917fc9cb9a0163f662c83c6660ac";
  const string CorrectionFailureSha256 = "8091c1afe06b09ff1e9d8dea29655fb52529dbecf26fd58d124242b0dee07bef";
  const string CorrectionSnapshotSha256 = "ea6ea58451214b6974aca2437f53fd21abfc4a6c9bfde4c615d8442f7a8bf1d0";
  const string CorrectionStagesSha256 = "15a977379d7eedfaedc8fd80071b69cebd8716f00c36fab7f0cb3ea2e937f7cc";
  const string ReceiptRoot = @"C:\ProgramData\CluedM5bPhysicalReceipt1109";
  const string FailedImportSha256 = "a3a92d4e231c6ff226228b8426139eb937e90e49c53985ea22724c11dea58aae";
  const string FailedResumeExeSha256 = "5e8238559a948de563487650d2cb3e781472f072af788f8edf96516a6ea52f7e";
  const string FailedResumeSourceSha256 = "77aca427f11cc9e6dc7201fd66f4898dc96c36ddefdefcb4e85a917b60bc0fe3";
  const string FailedResumeIntentSha256 = "5815ef0413940a0ee73b01ac4ec1bd6df19d99acd84f106d9e5e8bd5c08efce7";
  const string FailedResumeFailureSha256 = "c04f56a83024f3e7c0eed92e4105c3c24b2b43c2b399921877db1356820ff159";
  const string FailedResumeStagesSha256 = "4641f57b027d146463d60e35e2ef5c50739b70f2f9e88fa527393801f4c74a3a";
  const string FailedResumeBuildSha256 = "9230db280d93807247f9aa643650e62fc7c14e20a489a93e29b6546ecb13fc9e";
  const string PostImportDiagnosticSha256 = "7132c3eb019e0149dc43c484fabec0e2aba7224b6a395fb72e4dbff33fdac81c";
  const string FailedResumeId = "0193d0fe-ff92-4b46-b3cf-97169873ed14";
  static readonly string Target = Root + @"\batch\ext4.vhdx";
  static readonly string Manifest = Root + @"\manifest.json";
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
  static readonly Type Production = typeof(CluedCompanionTaskRegistrar);
  static readonly BindingFlags PrivateStatic = BindingFlags.NonPublic | BindingFlags.Static;
  static string phase = "preflight";
  static string runId;
  static bool rootOwned;
  static bool registeredResume;
  static string stagePrefix = "";
  static string resumeId;
  static bool resumeIntentCreated;
  static bool diskCorrection;
  static bool loggingBlocked;
  sealed class Refusal : Exception { public readonly string Code; public Refusal(string code) { Code=code; } }

  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,IntPtr information);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll", EntryPoint="RtlZeroMemory")] static extern void ZeroMemory(IntPtr p, UIntPtr length);
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct LsaString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LogonData { public uint Size; public Luid LogonId; public LsaString UserName, Domain, AuthenticationPackage; public uint LogonType, Session; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int returned);
  [DllImport("secur32.dll")] static extern uint LsaGetLogonSessionData(ref Luid id, out IntPtr data);
  [DllImport("secur32.dll")] static extern uint LsaFreeReturnBuffer(IntPtr data);

  static object Invoke(string name, params object[] arguments) {
    MethodInfo m = Production.GetMethod(name, PrivateStatic);
    if (m == null) throw new InvalidOperationException("PRODUCTION_HELPER_MISSING");
    try { return m.Invoke(null, arguments); }
    catch (TargetInvocationException e) { throw e.InnerException ?? e; }
  }
  static object Call(object o, string member, params object[] args) { return o.GetType().InvokeMember(member, BindingFlags.InvokeMethod, null, o, args); }
  static object Get(object o, string member) { return o.GetType().InvokeMember(member, BindingFlags.GetProperty, null, o, null); }
  static object Get(object o, string member, object index) { return o.GetType().InvokeMember(member, BindingFlags.GetProperty, null, o, new[] { index }); }
  static void Set(object o, string member, object value) { o.GetType().InvokeMember(member, BindingFlags.SetProperty, null, o, new[] { value }); }
  static Dictionary<string,object> Map(params object[] pairs) {
    Dictionary<string,object> result = new Dictionary<string,object>();
    for (int i=0; i<pairs.Length; i+=2) result[(string)pairs[i]] = pairs[i+1];
    return result;
  }
  static string Hash(Stream stream) { using (SHA256 sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
  static string Hash(string path) { using (FileStream f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) return Hash(f); }
  static string TextHash(string text) { using (SHA256 sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
  static void Require(bool condition, string code) { if (!condition) throw new Refusal(code); }
  static bool TrustedSid(string sid) { return sid=="S-1-5-18" || sid=="S-1-5-32-544" || sid=="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"; }
  static void TrustedParent(string path, bool standardAnchor) {
    Plain(path,true);
    RawSecurityDescriptor d=new RawSecurityDescriptor(Directory.GetAccessControl(path,AccessControlSections.Access|AccessControlSections.Owner).GetSecurityDescriptorBinaryForm(),0);
    Require(d.Owner!=null && TrustedSid(d.Owner.Value) && d.DiscretionaryAcl!=null,"PARENT_OWNER_OR_DACL_REFUSED");
    // Default drive/ProgramData create-child and metadata rights do not permit
    // replacing an existing protected child. Refuse delete/rename/ACL/owner and
    // generic write permissions; a new owned directory uses exact DACL checks.
    int dangerous=standardAnchor?unchecked((int)0x500D0040):unchecked((int)0x500D0156);
    foreach(GenericAce ace in d.DiscretionaryAcl) {
      CommonAce a=ace as CommonAce;
      Require(a!=null && !a.IsCallback,"PARENT_COMPLEX_ACE_REFUSED");
      if(a.AceQualifier!=AceQualifier.AccessAllowed || (a.AceFlags&AceFlags.InheritOnly)!=0 || TrustedSid(a.SecurityIdentifier.Value)) continue;
      Require((a.AccessMask&dangerous)==0,"PARENT_UNTRUSTED_MUTATION_RIGHTS");
    }
  }
  static bool EntryExists(string path) {
    string parent=Path.GetDirectoryName(path), leaf=Path.GetFileName(path);
    foreach(string candidate in Directory.EnumerateFileSystemEntries(parent)) if(string.Equals(Path.GetFileName(candidate),leaf,StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }
  static bool InjectionName(string name) {
    return Regex.IsMatch(name,@"\A(?:COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH\z)",RegexOptions.IgnoreCase);
  }
  static void CheckSchedulerEnvironment() {
    using(RegistryKey k=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")) {
      Require(k!=null,"MACHINE_ENVIRONMENT_UNREADABLE");
      foreach(string name in k.GetValueNames()) Require(!InjectionName(name),"MACHINE_RUNTIME_INJECTION_ENVIRONMENT_REFUSED");
    }
    using(RegistryKey k=Registry.CurrentUser.OpenSubKey("Environment")) {
      if(k!=null) foreach(string name in k.GetValueNames()) Require(!InjectionName(name),"USER_RUNTIME_INJECTION_ENVIRONMENT_REFUSED");
    }
  }
  static void Plain(string path, bool directory) {
    Require(Path.IsPathRooted(path), "PATH_NOT_ABSOLUTE");
    string p=Path.GetFullPath(path);
    Require(p.Equals(path,StringComparison.OrdinalIgnoreCase), "PATH_NOT_CANONICAL");
    Require(directory ? Directory.Exists(p) : File.Exists(p), "PATH_MISSING");
    Require((File.GetAttributes(p)&FileAttributes.ReparsePoint)==0, "PATH_REPARSE_REFUSED");
    for (string parent=Path.GetDirectoryName(p.TrimEnd('\\')); !string.IsNullOrEmpty(parent); parent=Path.GetDirectoryName(parent.TrimEnd('\\'))) {
      Require(Directory.Exists(parent) && (File.GetAttributes(parent)&FileAttributes.ReparsePoint)==0, "ANCESTOR_NOT_PLAIN");
    }
  }
  static string Acl(string sid, bool writable) {
    return "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" + (sid==null ? "" : "(A;OICI;"+(writable?"0x1301bf":"0x1200a9")+";;;"+sid+")");
  }
  static void NewDirectory(string path, string sddl) {
    Require(!Directory.Exists(path) && !File.Exists(path), "DIRECTORY_ALREADY_EXISTS");
    Plain(Path.GetDirectoryName(path),true);
    IntPtr descriptor=IntPtr.Zero; uint size;
    try {
      Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out descriptor,out size), "DIRECTORY_ACL_INVALID");
      SecurityAttributes sa=new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor=descriptor, Inherit=false };
      if (!CreateDirectoryW(path,ref sa)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { if (descriptor!=IntPtr.Zero) LocalFree(descriptor); }
    Plain(path,true);
    CheckAcl(path,sddl);
  }
  static void CheckAcl(string path,string expected) {
    DirectorySecurity actual=Directory.GetAccessControl(path, AccessControlSections.Access|AccessControlSections.Owner);
    RawSecurityDescriptor a=new RawSecurityDescriptor(actual.GetSecurityDescriptorBinaryForm(),0), e=new RawSecurityDescriptor(expected);
    Require(a.Owner.Value=="S-1-5-32-544" && (a.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0 && a.DiscretionaryAcl.Count==e.DiscretionaryAcl.Count,"DIRECTORY_ACL_READBACK_FAILED");
    for(int i=0;i<e.DiscretionaryAcl.Count;i++) {
      CommonAce aa=a.DiscretionaryAcl[i] as CommonAce, ee=e.DiscretionaryAcl[i] as CommonAce;
      Require(aa!=null && aa.AceFlags==ee.AceFlags && aa.AceQualifier==ee.AceQualifier && aa.AccessMask==ee.AccessMask && aa.SecurityIdentifier==ee.SecurityIdentifier,"DIRECTORY_ACL_READBACK_FAILED");
    }
  }
  static void WriteNew(string path, object value) {
    WriteTextNew(path,Json.Serialize(value));
  }
  static void WriteTextNew(string path,string text) {
    byte[] data=new UTF8Encoding(false).GetBytes(text);
    using(FileStream f=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { f.Write(data,0,data.Length); f.Flush(true); }
  }
  static void Stage(string name, object facts) {
    phase=stagePrefix+name;
    if (!rootOwned) return;
    byte[] data=new UTF8Encoding(false).GetBytes(Json.Serialize(Map("phase",phase,"at",DateTimeOffset.UtcNow.ToString("o"),"facts",facts))+"\n");
    using(FileStream f=new FileStream(Root+@"\stages.jsonl",FileMode.Append,FileAccess.Write,FileShare.Read)) { f.Write(data,0,data.Length); f.Flush(true); }
  }
  static string NewAccount() {
    // NetUserAdd is atomic: do not use PrepareAccount's existing-account path.
    // All native operations and random generation are the production helpers.
    IntPtr pw=(IntPtr)Invoke("NewRandomPassword");
    try {
      Type t=Production.GetNestedType("USER_INFO_1",BindingFlags.NonPublic);
      object u=Activator.CreateInstance(t);
      Dictionary<string,object> values=Map("name",Account,"password",pw,"priv",1,"comment","Disposable M5-b physical acceptance "+runId,"flags",0x1|0x40|0x200|0x10000);
      foreach(KeyValuePair<string,object> pair in values) t.GetField(pair.Key).SetValue(u,pair.Value);
      object[] args={null,1,u,0};
      int rc=(int)Invoke("NetUserAdd",args);
      Stage("account-create-result",Map("rawReturnCode",rc,"parameterError",args[3]));
      Require(rc==0,"TEST_ACCOUNT_NOT_CREATED");
    } finally { ZeroMemory(pw,new UIntPtr((uint)((RegistrarCore.RandomPasswordChars+1)*2))); Marshal.FreeHGlobal(pw); }
    string sid=(string)Invoke("SidOf",Environment.MachineName+"\\"+Account);
    Require(RegistrarCore.ValidSid(sid),"TEST_ACCOUNT_SID_UNREADABLE");
    Stage("account-created",Map("sid",sid,"name",Account));
    Type groupType=Production.GetNestedType("LOCALGROUP_MEMBERS_INFO_3",BindingFlags.NonPublic);
    object group=Activator.CreateInstance(groupType); groupType.GetField("domainAndName").SetValue(group,Environment.MachineName+"\\"+Account);
    int grc=(int)Invoke("NetLocalGroupAddMembers",null,Invoke("GroupName","S-1-5-32-545"),3,group,1);
    Stage("account-group-result",Map("rawReturnCode",grc));
    Require(grc==0 || grc==1378,"TEST_ACCOUNT_GROUP_FAILED");
    string[] rights={"SeBatchLogonRight","SeDenyNetworkLogonRight","SeDenyRemoteInteractiveLogonRight","SeDenyInteractiveLogonRight"};
    int rightsCode=(int)Invoke("AddRights",sid,rights); Stage("account-rights-result",Map("rawReturnCode",rightsCode));
    Require(rightsCode==0,"TEST_ACCOUNT_RIGHTS_FAILED");
    Require(Invoke("AccountRefusalOf",sid)==null,"TEST_ACCOUNT_REFUSED");
    List<string> held=(List<string>)Invoke("RightsOf",sid);
    foreach(string right in rights) Require(held.Contains(right),"TEST_ACCOUNT_RIGHTS_READBACK_FAILED");
    List<string> problems=(List<string>)Invoke("HardeningOf",sid,Account,false);
    Require(problems.Count==0,"TEST_ACCOUNT_HARDENING_FAILED");
    StringBuilder profile=new StringBuilder(260);
    int profileCode=(int)Invoke("CreateProfile",sid,Account,profile,(uint)260); Stage("account-profile-result",Map("rawHresult",profileCode));
    Require(profileCode==0,"TEST_PROFILE_NOT_CREATED");
    string profilePath=(string)Invoke("ProfilePath",sid);
    Require(string.Equals(profilePath,@"C:\Users\"+Account,StringComparison.OrdinalIgnoreCase) && string.Equals(profilePath,profile.ToString(),StringComparison.OrdinalIgnoreCase),"TEST_PROFILE_READBACK_FAILED");
    Plain(profilePath,true);
    Stage("account-hardened",Map("sid",sid,"rights",held.ToArray(),"profile",profilePath,"interactiveLogonUsed",false));
    return sid;
  }
  static void AccountAbsent() {
    object[] args={null,Account,1,IntPtr.Zero};
    int rc=(int)Invoke("NetUserGetInfo",args);
    if((IntPtr)args[3]!=IntPtr.Zero) Invoke("NetApiBufferFree",args[3]);
    Require(rc==2221,"TEST_ACCOUNT_EXISTS_OR_LOOKUP_FAILED");
    Require(!EntryExists(@"C:\Users\"+Account),"TEST_PROFILE_PATH_ALREADY_EXISTS");
  }
  static int TaskMask(int value) {
    uint mask=unchecked((uint)value), mapped=mask&0x0fffffff;
    if((mask&0x10000000)!=0) mapped|=0x1f01ff;
    if((mask&0x80000000)!=0) mapped|=0x120089;
    if((mask&0x40000000)!=0) mapped|=0x120116;
    if((mask&0x20000000)!=0) mapped|=0x1200a0;
    return unchecked((int)mapped);
  }
  static object NewFolder(object service) {
    object root=Call(service,"GetFolder",@"\");
    try { Call(service,"GetFolder",@"\"+FolderName); Require(false,"TEST_TASK_FOLDER_EXISTS"); }
    catch(TargetInvocationException e) { Require(e.InnerException!=null && e.InnerException.HResult==unchecked((int)0x80070002),"TASK_FOLDER_LOOKUP_FAILED"); }
    object folder=Call(root,"CreateFolder",FolderName,"D:P(A;;FA;;;SY)(A;;FA;;;BA)");
    Require((string)Get(folder,"Path")==@"\"+FolderName,"TASK_FOLDER_READBACK_FAILED");
    string actualSddl=(string)Call(folder,"GetSecurityDescriptor",7);
    RawSecurityDescriptor acl=new RawSecurityDescriptor(actualSddl);
    Require(acl.Owner!=null && (TrustedSid(acl.Owner.Value) || acl.Owner.Value==WindowsIdentity.GetCurrent().User.Value) && (acl.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0 && acl.DiscretionaryAcl.Count==2,"TASK_FOLDER_ACL_REFUSED");
    HashSet<string> seen=new HashSet<string>();
    foreach(GenericAce ace in acl.DiscretionaryAcl) {
      CommonAce c=ace as CommonAce;
      Require(c!=null && c.AceQualifier==AceQualifier.AccessAllowed && c.AceFlags==AceFlags.None && TaskMask(c.AccessMask)==0x1f01ff && (c.SecurityIdentifier.Value=="S-1-5-18" || c.SecurityIdentifier.Value=="S-1-5-32-544"),"TASK_FOLDER_ACL_REFUSED");
      Require(seen.Add(c.SecurityIdentifier.Value),"TASK_FOLDER_ACL_DUPLICATE");
    }
    Stage("task-folder-readback",Map("actualSddl",actualSddl));
    return folder;
  }
  static string HeartbeatXml(string sid) {
    XmlDocument x=new XmlDocument(); x.LoadXml(RegistrarCore.ImportTaskXml(sid,Distro,Target,0));
    XmlNamespaceManager ns=new XmlNamespaceManager(x.NameTable); ns.AddNamespace("t","http://schemas.microsoft.com/windows/2004/02/mit/task");
    x.SelectSingleNode("//t:Exec/t:Command",ns).InnerText=Root+@"\bin\"+HarnessName;
    x.SelectSingleNode("//t:Exec/t:Arguments",ns).InnerText="heartbeat";
    XmlNode cwd=x.SelectSingleNode("//t:Exec/t:WorkingDirectory",ns); if(cwd!=null) cwd.InnerText=Root+@"\bin";
    x.SelectSingleNode("//t:ExecutionTimeLimit",ns).InnerText="PT3M";
    x.SelectSingleNode("//t:Description",ns).InnerText="Disposable test heartbeat only; not the resident supervisor or a production heartbeat qualification.";
    return x.OuterXml;
  }
  static void CheckTask(object task,string sid,string expectedXml,object folder) {
    string folderPath=(string)Get(folder,"Path");
    string folderSddl=(string)Call(folder,"GetSecurityDescriptor",7);
    string taskPath=(string)Get(task,"Path"), actualSddl=(string)Call(task,"GetSecurityDescriptor",7);
    string caller=WindowsIdentity.GetCurrent().User.Value;
    Stage("task-security-before-validation",Map("name",Get(task,"Path"),"actualSddl",actualSddl,"parentFolderSddl",folderSddl,"callerSid",caller));
    RawSecurityDescriptor observed=new RawSecurityDescriptor(actualSddl);
    Stage("task-security-parsed-before-validation",Map("name",Get(task,"Path"),"ownerSid",observed.Owner==null?null:observed.Owner.Value,"callerSid",caller,"hasDacl",observed.DiscretionaryAcl!=null,"daclProtected",(observed.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0));
    XmlDocument expected=new XmlDocument(); expected.LoadXml(expectedXml);
    XmlNamespaceManager ns=new XmlNamespaceManager(expected.NameTable); ns.AddNamespace("t","http://schemas.microsoft.com/windows/2004/02/mit/task");
    object definition=Get(task,"Definition"), principal=Get(definition,"Principal"), actions=Get(definition,"Actions"), triggers=Get(definition,"Triggers");
    string user=(string)Get(principal,"UserId"); string actualSid=user.StartsWith("S-1-")?user:(string)Invoke("SidOf",user);
    Require(actualSid==sid && (int)Get(principal,"LogonType")==1 && (int)Get(principal,"RunLevel")==0 && (int)Get(actions,"Count")==1 && (int)Get(triggers,"Count")==0,"TASK_PRINCIPAL_OR_TRIGGER_MISMATCH");
    object action=Get(actions,"Item",1);
    Require((string)Get(action,"Path")==expected.SelectSingleNode("//t:Exec/t:Command",ns).InnerText && (string)Get(action,"Arguments")==expected.SelectSingleNode("//t:Exec/t:Arguments",ns).InnerText,"TASK_ACTION_MISMATCH");
    if((observed.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) {
      Require(registeredResume,"TASK_UNPROTECTED_REGISTERED_RESUME_REQUIRED");
      Dictionary<string,object> bound=ReadMap(Manifest);
      string boundHash=Hash(Manifest), bindingRefusal=RegisteredManifestRefusal(bound,boundHash); Require(bindingRefusal==null,bindingRefusal);
      CheckResumeBuild();
      bindingRefusal=RegisteredTaskIdentityRefusal(Environment.MachineName,folderPath,taskPath,sid,boundHash,TextHash((string)Get(action,"Arguments")),Hash(Root+@"\bin\"+HarnessName));
      Require(bindingRefusal==null,bindingRefusal);
    }
    string refusal=TaskSecurityRefusal(actualSddl,sid,caller,(bool)Invoke("Elevated"),folderSddl);
    Require(refusal==null,refusal);
    Stage("task-readback",Map("name",Get(task,"Path"),"sid",actualSid,"logonType",1,"runLevel",0,"actualSddl",actualSddl,"actionSha256",TextHash((string)Get(action,"Path")+"\n"+(string)Get(action,"Arguments")),"xmlSha256",TextHash((string)Get(task,"Xml"))));
  }
  // Pure guard: the fixed elevated Operator is an already trusted admin Owner;
  // the batch principal never becomes a trusted task owner merely by running it.
  static string TaskSecurityRefusal(string actualSddl,string batchSid,string caller,bool elevated,string folderSddl) {
    RawSecurityDescriptor acl=new RawSecurityDescriptor(actualSddl);
    if(acl.Owner==null || acl.Owner.Value==batchSid || (!TrustedSid(acl.Owner.Value) && !(acl.Owner.Value==OperatorSid && caller==OperatorSid && elevated)) || acl.DiscretionaryAcl==null) return "TASK_OWNER_OR_DACL_REFUSED";
    if((acl.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) return ExactSchedulerAclRefusal(acl,batchSid,caller,elevated,folderSddl);
    HashSet<string> full=new HashSet<string>();
    foreach(GenericAce ace in acl.DiscretionaryAcl) {
      CommonAce a=ace as CommonAce; if(a==null || a.IsCallback) return "TASK_COMPLEX_ACE_REFUSED";
      if(a.AceQualifier!=AceQualifier.AccessAllowed || (a.AceFlags&AceFlags.InheritOnly)!=0) continue;
      int mask=TaskMask(a.AccessMask);
      if(a.SecurityIdentifier.Value=="S-1-5-18" || a.SecurityIdentifier.Value=="S-1-5-32-544") { if((mask&0x1f01ff)==0x1f01ff) full.Add(a.SecurityIdentifier.Value); }
      else if((mask&~0x120089)!=0) return "TASK_UNTRUSTED_MUTATION_OR_EXECUTE_RIGHTS";
    }
    return full.Count==2?null:"TASK_TRUSTED_FULL_ACCESS_MISSING";
  }
  // Observed Scheduler shape for these exact two already-registered tasks:
  // BA owns the task, SY/BA have FA and its fixed principal has FR only. This
  // narrow alternative to P requires an independently protected private folder.
  // It never permits general unprotected tasks or changes their permissions.
  static string ExactSchedulerAclRefusal(RawSecurityDescriptor task,string sid,string caller,bool elevated,string folderSddl) {
    if(sid!=RegisteredSid || caller!=OperatorSid || !elevated || task.Owner.Value!="S-1-5-32-544" || (int)task.ControlFlags!=32772 || task.DiscretionaryAcl.Count!=3 || string.IsNullOrEmpty(folderSddl)) return "TASK_OWNER_OR_DACL_REFUSED";
    RawSecurityDescriptor parent;
    try { parent=new RawSecurityDescriptor(folderSddl); } catch { return "TASK_UNPROTECTED_PARENT_UNCONFIRMED"; }
    if(parent.Owner==null || parent.Owner.Value!="S-1-5-32-544" || (parent.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0 || parent.DiscretionaryAcl==null || parent.DiscretionaryAcl.Count!=2) return "TASK_UNPROTECTED_PARENT_UNCONFIRMED";
    HashSet<string> parents=new HashSet<string>();
    foreach(GenericAce raw in parent.DiscretionaryAcl) {
      CommonAce ace=raw as CommonAce;
      if(ace==null || ace.IsCallback || ace.AceQualifier!=AceQualifier.AccessAllowed || ace.AceFlags!=AceFlags.None || TaskMask(ace.AccessMask)!=0x1f01ff || (ace.SecurityIdentifier.Value!="S-1-5-18" && ace.SecurityIdentifier.Value!="S-1-5-32-544") || !parents.Add(ace.SecurityIdentifier.Value)) return "TASK_UNPROTECTED_PARENT_UNCONFIRMED";
    }
    HashSet<string> seen=new HashSet<string>();
    foreach(GenericAce raw in task.DiscretionaryAcl) {
      CommonAce ace=raw as CommonAce;
      if(ace==null || ace.IsCallback || ace.AceQualifier!=AceQualifier.AccessAllowed || ace.AceFlags!=AceFlags.None || !seen.Add(ace.SecurityIdentifier.Value)) return "TASK_SCHEDULER_EXACT_ACL_REFUSED";
      string who=ace.SecurityIdentifier.Value; int mask=TaskMask(ace.AccessMask);
      if(who=="S-1-5-18" || who=="S-1-5-32-544") { if(mask!=0x1f01ff) return "TASK_SCHEDULER_EXACT_ACL_REFUSED"; }
      else if(who!=sid || mask!=0x120089) return "TASK_SCHEDULER_EXACT_ACL_REFUSED";
    }
    return null;
  }
  static string RegisteredTaskIdentityRefusal(string machine,string folder,string task,string sid,string manifestHash,string argumentsHash,string heartbeatHash) {
    string expectedFolder="\\"+FolderName;
    if(machine!="TURING" || folder!=expectedFolder || sid!=RegisteredSid || manifestHash!=RegisteredManifestSha256 || heartbeatHash!=RegisteredHeartbeatSha256) return "TASK_REGISTERED_IDENTITY_REFUSED";
    if(task==expectedFolder+"\\"+RegistrarCore.ImportTaskName && argumentsHash==RegisteredImportActionSha256) return null;
    if(task==expectedFolder+"\\"+HeartbeatName && argumentsHash==RegisteredHeartbeatArgumentsSha256) return null;
    return "TASK_REGISTERED_PATH_OR_ACTION_REFUSED";
  }
  static bool TaskInstanceEnded(Exception error) {
    while(error is TargetInvocationException && error.InnerException!=null) error=error.InnerException;
    return error is COMException && error.HResult==unchecked((int)0x8004130B);
  }
  static int RunTaskOnce(object task,string label,int timeoutSeconds) {
    DateTime began=DateTime.UtcNow;
    Stage(label+"-run-requested",Map("task",Get(task,"Path"),"noAutomaticRetry",true));
    object running=Call(task,"Run",(object)null);
    object instance=null;
    try { instance=Get(running,"InstanceGuid"); }
    catch(Exception e) { if(!TaskInstanceEnded(e)) throw; }
    Stage(label+"-run-accepted",Map("instance",instance));
    Stopwatch watch=Stopwatch.StartNew();
    while(watch.Elapsed.TotalSeconds<timeoutSeconds) {
      // A short-lived task can disappear between Run and Refresh. That exact
      // observation is not its outcome: prove the registered task is finished.
      try { Call(running,"Refresh"); }
      catch(Exception e) { if(!TaskInstanceEnded(e)) throw; }
      int state=(int)Get(task,"State"); DateTime last=(DateTime)Get(task,"LastRunTime");
      if(last.ToUniversalTime()>=began.AddSeconds(-2) && state==3 && (int)Get(Call(task,"GetInstances",0),"Count")==0) {
        int code=(int)Get(task,"LastTaskResult");
        if(code==0x41301 || code==0x41303) { Thread.Sleep(250); continue; }
        Stage(label+"-finished",Map("rawLastTaskResult",code,"state",state,"lastRunTime",last.ToUniversalTime().ToString("o")));
        return code;
      }
      Thread.Sleep(250);
    }
    throw new TimeoutException("TEST_TASK_OUTCOME_UNKNOWN_NO_RETRY");
  }
  static Dictionary<string,object> ReadMap(string path) {
    Plain(path,false); Require(new FileInfo(path).Length<=65536,"RESULT_TOO_LARGE");
    Dictionary<string,object> value=Json.DeserializeObject(File.ReadAllText(path,new UTF8Encoding(false,true))) as Dictionary<string,object>;
    Require(value!=null,"RESULT_NOT_OBJECT"); return value;
  }
  static Dictionary<string,object> Child(Dictionary<string,object> value,string key) { return (Dictionary<string,object>)value[key]; }
  sealed class Capture { public string Output; public Dictionary<string,object> Public; }
  static byte[] Drain(Stream source, out bool truncated) {
    byte[] buffer=new byte[4096]; using(MemoryStream kept=new MemoryStream()) {
      int count; truncated=false;
      while((count=source.Read(buffer,0,buffer.Length))>0) {
        int retain=Math.Min(count,Math.Max(0,16384-(int)kept.Length)); if(retain<count) truncated=true;
        if(retain>0) kept.Write(buffer,0,retain);
      }
      return kept.ToArray();
    }
  }
  static string Decode(byte[] bytes) {
    bool unicode=bytes.Length>=2 && bytes[0]==255 && bytes[1]==254;
    if(!unicode) { int odd=0; for(int i=1;i<Math.Min(64,bytes.Length);i+=2) if(bytes[i]==0) odd++; unicode=odd>=3; }
    if(unicode) return Encoding.Unicode.GetString(bytes).TrimStart('\uFEFF');
    try { return new UTF8Encoding(false,true).GetString(bytes); } catch { return Encoding.GetEncoding(54936).GetString(bytes); }
  }
  static string PublicOutput(string output) {
    string text=Regex.Replace(output,@"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]","");
    text=Regex.Replace(text,@"(?im)^.*(?:token|password|secret|credential|authorization|private[_ -]?key|BEGIN .*PRIVATE KEY).*$","[REDACTED_SENSITIVE_LINE]");
    text=Regex.Replace(text,@"(?i)(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|clued_(?:bnd|hbt|lk)_[A-Za-z0-9_-]+|Bearer\s+\S+)","[REDACTED]");
    text=Regex.Replace(text,@"[A-Za-z0-9_+\/=\-]{48,}","[REDACTED_LONG_VALUE]");
    return text.Length>2048?text.Substring(0,2048):text;
  }
  static ProcessStartInfo CleanProcess(string file,string arguments) {
    ProcessStartInfo info=new ProcessStartInfo(file,arguments) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=Root+@"\bin" };
    info.EnvironmentVariables.Clear();
    info.EnvironmentVariables["SystemRoot"]=@"C:\Windows"; info.EnvironmentVariables["WINDIR"]=@"C:\Windows"; info.EnvironmentVariables["SystemDrive"]="C:";
    info.EnvironmentVariables["PATH"]=@"C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem";
    info.EnvironmentVariables["COMSPEC"]=@"C:\Windows\System32\cmd.exe";
    info.EnvironmentVariables["TEMP"]=Root+@"\results"; info.EnvironmentVariables["TMP"]=Root+@"\results";
    info.EnvironmentVariables["USERPROFILE"]=@"C:\Users\"+Account;
    info.EnvironmentVariables["APPDATA"]=@"C:\Users\"+Account+@"\AppData\Roaming"; info.EnvironmentVariables["LOCALAPPDATA"]=@"C:\Users\"+Account+@"\AppData\Local";
    info.EnvironmentVariables["USERNAME"]=Account; info.EnvironmentVariables["USERDOMAIN"]=Environment.MachineName;
    info.EnvironmentVariables["PSModulePath"]=@"C:\Windows\System32\WindowsPowerShell\v1.0\Modules";
    info.EnvironmentVariables["WSL_UTF8"]="1";
    return info;
  }
  static Capture RunBounded(string file,string arguments,string operation,int timeoutMs) {
    Dictionary<string,object> facts=Map("operation",operation,"startedAt",DateTimeOffset.UtcNow.ToString("o"),"exitCode",null,"stdout","","stderr","","timedOut",false,"truncated",false,"error",null);
    Process process=new Process { StartInfo=CleanProcess(file,arguments) }; Task<byte[]> output=null, error=null; bool outTruncated=false,errTruncated=false;
    string raw="";
    try {
      Require(process.Start(),"BOUNDED_PROCESS_NOT_STARTED");
      output=Task.Factory.StartNew(()=>Drain(process.StandardOutput.BaseStream,out outTruncated));
      error=Task.Factory.StartNew(()=>Drain(process.StandardError.BaseStream,out errTruncated));
      if(!process.WaitForExit(timeoutMs)) { facts["timedOut"]=true; try { process.Kill(); process.WaitForExit(2000); } catch { } }
      facts["exitCode"]=process.HasExited?process.ExitCode:-1;
      bool drained=Task.WaitAll(new Task[] {output,error},1500);
      facts["truncated"]=!drained || outTruncated || errTruncated;
      if(output.Status==TaskStatus.RanToCompletion) { raw=Decode(output.Result); facts["stdout"]=PublicOutput(raw); if(raw.Length>2048) facts["truncated"]=true; }
      if(error.Status==TaskStatus.RanToCompletion) { string stderr=Decode(error.Result); facts["stderr"]=PublicOutput(stderr); if(stderr.Length>2048) facts["truncated"]=true; }
    } catch(Exception e) { facts["error"]=Map("type",e.GetType().Name,"hresult","0x"+e.HResult.ToString("X8")); }
    finally { facts["finishedAt"]=DateTimeOffset.UtcNow.ToString("o"); process.Dispose(); }
    return new Capture { Output=raw, Public=facts };
  }
  static Dictionary<string,object> HeartbeatRegistration(string sid) {
    using(RegistryKey hive=Registry.Users.OpenSubKey(sid)) Require(hive!=null,"HEARTBEAT_USER_HIVE_NOT_LOADED");
    string expectedProfile=@"C:\Users\"+Account;
    Require(string.Equals((string)Invoke("ProfilePath",sid),expectedProfile,StringComparison.OrdinalIgnoreCase) && string.Equals(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),expectedProfile,StringComparison.OrdinalIgnoreCase),"HEARTBEAT_PROFILE_MISMATCH");
    Plain(expectedProfile,true);
    int count=0; string basePath=null; int uid=-1;
    using(RegistryKey lxss=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Lxss")) {
      Require(lxss!=null,"HEARTBEAT_REGISTRATION_MISSING");
      foreach(string name in lxss.GetSubKeyNames()) using(RegistryKey k=lxss.OpenSubKey(name)) {
        if(k!=null && (string)k.GetValue("DistributionName")==Distro) { count++; basePath=k.GetValue("BasePath") as string; uid=Convert.ToInt32(k.GetValue("DefaultUid",-1)); }
      }
    }
    if(basePath!=null && basePath.StartsWith(@"\\?\")) basePath=basePath.Substring(4);
    Require(count==1 && basePath!=null && string.Equals(basePath.TrimEnd('\\'),Path.GetDirectoryName(Target),StringComparison.OrdinalIgnoreCase) && uid==0,"HEARTBEAT_REGISTRATION_MISMATCH");
    return Map("sid",sid,"profileDirectory",expectedProfile,"userHiveLoaded",true,"distro",Distro,"matches",count,"basePath",basePath,"defaultUid",uid);
  }
  static Dictionary<string,object> HeartbeatProbe(string sid) {
    CheckSchedulerEnvironment();
    Dictionary<string,object> before=HeartbeatRegistration(sid);
    string resolver="$ErrorActionPreference='Stop';"+RegistrarCore.MachineWslClientScript+"\ntry { Get-CluedMachineWslClient | ConvertTo-Json -Compress } catch { [Console]::Error.Write($_.Exception.GetType().Name); exit 2 }";
    Capture validation=RunBounded(RegistrarCore.PowerShellExe,"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(resolver)),"second-batch-client-validation",30000);
    WriteNew(Root+@"\results\test-heartbeat-client-validation.json",validation.Public);
    Require(validation.Public["exitCode"]!=null && Convert.ToInt32(validation.Public["exitCode"])==0 && !(bool)validation.Public["timedOut"] && !(bool)validation.Public["truncated"] && validation.Public["error"]==null,"HEARTBEAT_WSL_CLIENT_REFUSED");
    Dictionary<string,object> client=Json.DeserializeObject(validation.Output.Trim()) as Dictionary<string,object>;
    Require(client!=null && client.Count==4 && (string)client["contract"]=="clued.independent-ci.wsl-client/1" && (string)client["path"]==@"C:\Program Files\WSL\wsl.exe" && Regex.IsMatch((string)client["sha256"],@"\A[0-9a-f]{64}\z") && Regex.IsMatch((string)client["signerThumbprint"],@"\A[0-9A-F]{40}\z"),"HEARTBEAT_WSL_CLIENT_FACTS_INVALID");
    Capture probe=RunBounded((string)client["path"],"--distribution "+Distro+" --exec /bin/true","second-batch-wsl-probe",60000);
    WriteNew(Root+@"\results\test-heartbeat-wsl-probe.json",probe.Public);
    Require(probe.Public["exitCode"]!=null && Convert.ToInt32(probe.Public["exitCode"])==0 && !(bool)probe.Public["timedOut"] && !(bool)probe.Public["truncated"] && probe.Public["error"]==null,"HEARTBEAT_WSL_PROBE_FAILED");
    Dictionary<string,object> after=HeartbeatRegistration(sid);
    return Map("client",client,"registrationBefore",before,"registrationAfter",after,"probe",probe.Public);
  }
  static void ValidateImport(DateTime started,string sid) {
    Dictionary<string,object> d=ReadMap(Root+@"\batch\companion-wsl-import-result.json");
    Require((string)d["contract"]=="clued.independent-ci.companion-wsl-import-result/1" && Convert.ToInt32(d["exitCode"])==0 && (string)d["distro"]==Distro && (string)d["vhdx"]==Target,"IMPORT_DIAGNOSTIC_SUBJECT_FAILED");
    Guid parsed; Require(Guid.TryParse((string)d["runId"],out parsed) && DateTimeOffset.Parse((string)d["startedAt"]).UtcDateTime>=started.AddSeconds(-2),"IMPORT_DIAGNOSTIC_STALE");
    Dictionary<string,object> identity=Child(d,"identity"), registration=Child(d,"registration");
    Require((string)identity["sid"]==sid && (bool)identity["userHiveLoaded"] && Convert.ToInt32(registration["matches"])==1 && (bool)registration["basePathMatches"],"IMPORT_IDENTITY_OR_REGISTRATION_FAILED");
    object[] commands=(object[])d["commands"]; string[] phases={"version","status","import","probe"};
    Require(commands.Length==4,"IMPORT_COMMANDS_MISSING");
    for(int i=0;i<4;i++) {
      Dictionary<string,object> c=(Dictionary<string,object>)commands[i];
      Require((string)c["phase"]==phases[i] && c["exitCode"]!=null && Convert.ToInt32(c["exitCode"])==0 && !(bool)c["timedOut"] && c["error"]==null,"IMPORT_COMMAND_FAILED");
    }
    Stage("import-probe-verified",Map("diagnosticSha256",Hash(Root+@"\batch\companion-wsl-import-result.json"),"runId",d["runId"],"identity",identity,"registration",registration));
  }
  static string RegisteredManifestRefusal(Dictionary<string,object> m,string hash) {
    if(hash!=RegisteredManifestSha256 || m.Count!=12 || (string)m["contract"]!=Contract || (string)m["runId"]!=RegisteredRunId || (string)m["machine"]!="TURING" || (string)m["sid"]!=RegisteredSid || (string)m["account"]!=Account || (string)m["root"]!=Root || (string)m["distro"]!=Distro || (string)m["seedSha256"]!=RegisteredSeedSha256 || (string)m["harnessSha256"]!=RegisteredHeartbeatSha256 || (string)m["importActionSha256"]!=RegisteredImportActionSha256 || !(bool)m["testHeartbeatOnly"] || (bool)m["cleanupImplemented"]) return "REGISTERED_MANIFEST_NOT_EXACT_ORIGINAL";
    return null;
  }
  static string RegisteredStageAnchor(byte[] bytes) {
    // The original immutable prefix ends at the exact observed failed record.
    // Later read-only diagnostics may only append explicitly prefixed stages.
    Require(bytes.Length>0 && bytes.Length<=1024*1024,"REGISTERED_STAGES_SIZE_REFUSED");
    int anchor=-1, lines=0;
    for(int i=0;i<bytes.Length;i++) if(bytes[i]==10) {
      Require(++lines<=256,"REGISTERED_STAGES_TOO_MANY_LINES");
      if(anchor<0) using(MemoryStream prefix=new MemoryStream(bytes,0,i+1,false)) if(Hash(prefix)==RegisteredStagesSha256) anchor=i+1;
    }
    Require(anchor>0,"REGISTERED_ORIGINAL_STAGE_ANCHOR_MISSING");
    string original=new UTF8Encoding(false,true).GetString(bytes,0,anchor);
    string[] rows=original.TrimEnd('\r','\n').Split('\n');
    Dictionary<string,object> last=Json.DeserializeObject(rows[rows.Length-1]) as Dictionary<string,object>;
    Require(last!=null && (string)last["phase"]=="failed","REGISTERED_FAILURE_RECORD_MISSING");
    Dictionary<string,object> failure=Child(last,"facts");
    Require((string)failure["status"]=="FAILED_PRESERVED_NO_RETRY" && (string)failure["phase"]=="password-cleared-both-tasks-registered" && (string)failure["code"]=="TASK_OWNER_OR_DACL_REFUSED" && (string)failure["evidenceRoot"]==Root,"REGISTERED_FAILURE_NOT_THE_KNOWN_PHASE");
    string tail=new UTF8Encoding(false,true).GetString(bytes,anchor,bytes.Length-anchor);
    foreach(string row in tail.Split('\n')) {
      if(row.Trim().Length==0) continue;
      Dictionary<string,object> entry=Json.DeserializeObject(row) as Dictionary<string,object>;
      Require(entry!=null && entry["phase"] is string && ((string)entry["phase"]).StartsWith("resume-registered:",StringComparison.Ordinal),"REGISTERED_UNRELATED_STAGE_AFTER_FAILURE");
    }
    return RegisteredStagesSha256;
  }
  static void CheckTaskNeverRun(object task,string label) {
    int result=(int)Get(task,"LastTaskResult"), state=(int)Get(task,"State");
    DateTime last=(DateTime)Get(task,"LastRunTime");
    object instances=Call(task,"GetInstances",0); int count=(int)Get(instances,"Count");
    Stage("registered-task-never-run-readback",Map("name",Get(task,"Path"),"label",label,"lastTaskResult",result,"lastRunTime",last.ToString("o"),"instances",count,"state",state));
    Require(RegisteredNeverRun(result,last,count,state),"REGISTERED_TASK_ALREADY_RUN_OR_STATE_UNKNOWN");
  }
  static bool RegisteredNeverRun(int result,DateTime last,int count,int state) {
    // This host's actual Scheduler sentinel is 1999-11-30, not OLE epoch 0.
    // Accept only that exact midnight combined with all other never-run facts.
    return result==0x41303 && last==new DateTime(1999,11,30,0,0,0) && count==0 && state==3;
  }
  static void CheckRegisteredAccount() {
    Require((string)Invoke("SidOf",Environment.MachineName+"\\"+Account)==RegisteredSid && Invoke("AccountRefusalOf",RegisteredSid)==null,"REGISTERED_ACCOUNT_CHANGED");
    Require(string.Equals((string)Invoke("ProfilePath",RegisteredSid),@"C:\Users\"+Account,StringComparison.OrdinalIgnoreCase),"REGISTERED_PROFILE_CHANGED");
    Plain(@"C:\Users\"+Account,true);
    Require(((List<string>)Invoke("HardeningOf",RegisteredSid,Account,false)).Count==0,"REGISTERED_ACCOUNT_HARDENING_CHANGED");
    List<string> rights=(List<string>)Invoke("RightsOf",RegisteredSid);
    string[] expected={"SeBatchLogonRight","SeDenyInteractiveLogonRight","SeDenyNetworkLogonRight","SeDenyRemoteInteractiveLogonRight"};
    Require(rights.Count==4,"REGISTERED_ACCOUNT_RIGHTS_CHANGED");
    foreach(string right in expected) Require(rights.Contains(right),"REGISTERED_ACCOUNT_RIGHTS_CHANGED");
  }
  static Dictionary<string,object> CheckResumeBuild() {
    if(loggingBlocked) return CheckLoggingBuild();
    if(diskCorrection) return CheckCorrectionBuild();
    Plain(BuildRoot,true); CheckAcl(BuildRoot,Acl(null,false));
    string self=Assembly.GetExecutingAssembly().Location;
    Require(string.Equals(self,BuildRoot+"\\"+ResumeName,StringComparison.OrdinalIgnoreCase),"REGISTERED_RESUME_EXECUTABLE_PATH_REFUSED");
    Plain(self,false);
    string oldSource=BuildRoot+@"\M5bPhysicalImportAcceptance.cs", registrar=BuildRoot+@"\CompanionTaskRegistrar.cs", original=BuildRoot+"\\"+HarnessName;
    foreach(string f in new[]{oldSource,registrar,original,Root+@"\bin\"+HarnessName}) Plain(f,false);
    Require(Hash(oldSource)==RegisteredSourceSha256 && Hash(registrar)==RegisteredRegistrarSha256 && Hash(original)==RegisteredHeartbeatSha256 && Hash(Root+@"\bin\"+HarnessName)==RegisteredHeartbeatSha256,"REGISTERED_ORIGINAL_SOURCE_OR_BINARY_CHANGED");
    Dictionary<string,object> b=ReadMap(BuildRoot+@"\resume-registered.build.json");
    string currentSource=BuildRoot+@"\M5bPhysicalImportAcceptance.resume-registered.cs";
    Plain(currentSource,false);
    Require(b.Count==7 && (string)b["contract"]=="clued.m5b.registered-resume-build/1" && (string)b["originalManifestSha256"]==RegisteredManifestSha256 && (string)b["originalRunId"]==RegisteredRunId && (string)b["registrarSha256"]==RegisteredRegistrarSha256 && (string)b["harnessSourceSha256"]==Hash(currentSource) && Regex.IsMatch((string)b["harnessSourceSha256"],@"\A[0-9a-f]{64}\z") && (string)b["executableSha256"]==Hash(self) && (string)b["executableName"]==ResumeName,"REGISTERED_RESUME_BUILD_RECORD_REFUSED");
    return b;
  }
  static int ResumeRegistered(string manifestHash) {
    Require(Environment.MachineName=="TURING" && WindowsIdentity.GetCurrent().User.Value==OperatorSid && (bool)Invoke("Elevated") && IntPtr.Size==8,"REGISTERED_RESUME_OPERATOR_REFUSED");
    Require(manifestHash==RegisteredManifestSha256,"REGISTERED_MANIFEST_HASH_ARGUMENT_REFUSED");
    TrustedParent(@"C:\",true); TrustedParent(@"C:\ProgramData",true);
    foreach(string directory in new[]{Root,Root+@"\bin",Root+@"\batch",Root+@"\results"}) Plain(directory,true);
    CheckAcl(Root,Acl(RegisteredSid,false)); CheckAcl(Root+@"\bin",Acl(RegisteredSid,false));
    CheckAcl(Root+@"\batch",Acl(RegisteredSid,true)); CheckAcl(Root+@"\results",Acl(RegisteredSid,true));
    Require(!EntryExists(Root+@"\resume-registered.intent") && !EntryExists(Root+@"\resume-registered.result.json") && !EntryExists(Root+@"\result.json"),"REGISTERED_RESUME_INTENT_OR_RESULT_ALREADY_EXISTS");
    Dictionary<string,object> m=ReadMap(Manifest); string failure=RegisteredManifestRefusal(m,Hash(Manifest)); Require(failure==null,failure);
    runId=RegisteredRunId; resumeId=Guid.NewGuid().ToString("D"); stagePrefix="resume-registered:"; rootOwned=true;
    Plain(Root+@"\stages.jsonl",false);
    string stageAnchor=RegisteredStageAnchor(File.ReadAllBytes(Root+@"\stages.jsonl"));
    Dictionary<string,object> build=CheckResumeBuild(); CheckRegisteredAccount(); CheckSchedulerEnvironment();
    Require(!EntryExists(Root+@"\batch\companion-wsl-import-result.json") && Directory.GetFileSystemEntries(Root+@"\results").Length==0,"REGISTERED_CHILD_EVIDENCE_ALREADY_EXISTS");
    Plain(Seed,false); TrustedParent(Path.GetDirectoryName(Seed),false); Plain(Target,false);
    using(FileStream seed=new FileStream(Seed,FileMode.Open,FileAccess.Read,FileShare.None)) Require(seed.Length==79691776 && Hash(seed)==RegisteredSeedSha256,"REGISTERED_SEED_CHANGED");
    using(FileStream target=new FileStream(Target,FileMode.Open,FileAccess.Read,FileShare.None)) Require(target.Length==79691776 && Hash(target)==RegisteredSeedSha256,"REGISTERED_UNRUN_TARGET_CHANGED_OR_IN_USE");
    string importXml=RegistrarCore.ImportTaskXml(RegisteredSid,Distro,Target,0), heartbeatXml=HeartbeatXml(RegisteredSid);
    Require(TextHash(RegistrarCore.ImportArguments(Distro,Target,0))==RegisteredImportActionSha256,"REGISTERED_IMPORT_SOURCE_ACTION_CHANGED");
    Plain(Root+@"\import-task.xml",false); Require(File.ReadAllText(Root+@"\import-task.xml",new UTF8Encoding(false,true))==importXml,"REGISTERED_SAVED_IMPORT_XML_CHANGED");
    object service=Invoke("Service"), folder=Call(service,"GetFolder",@"\"+FolderName);
    string folderSddl=(string)Call(folder,"GetSecurityDescriptor",7);
    Stage("registered-folder-security-before-validation",Map("actualSddl",folderSddl,"resumeId",resumeId));
    RawSecurityDescriptor folderAcl=new RawSecurityDescriptor(folderSddl);
    Require(folderAcl.Owner!=null && (TrustedSid(folderAcl.Owner.Value) || folderAcl.Owner.Value==OperatorSid) && (folderAcl.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0 && folderAcl.DiscretionaryAcl!=null && folderAcl.DiscretionaryAcl.Count==2,"REGISTERED_TASK_FOLDER_CHANGED");
    HashSet<string> seen=new HashSet<string>();
    foreach(GenericAce ace in folderAcl.DiscretionaryAcl) {
      CommonAce a=ace as CommonAce;
      Require(a!=null && !a.IsCallback && a.AceQualifier==AceQualifier.AccessAllowed && a.AceFlags==AceFlags.None && TaskMask(a.AccessMask)==0x1f01ff && (a.SecurityIdentifier.Value=="S-1-5-18" || a.SecurityIdentifier.Value=="S-1-5-32-544") && seen.Add(a.SecurityIdentifier.Value),"REGISTERED_TASK_FOLDER_CHANGED");
    }
    Require((int)Get(Call(folder,"GetTasks",1),"Count")==2 && (int)Get(Call(folder,"GetFolders",0),"Count")==0,"REGISTERED_TASK_FOLDER_INVENTORY_CHANGED");
    object importTask=Call(folder,"GetTask",RegistrarCore.ImportTaskName), heartbeatTask=Call(folder,"GetTask",HeartbeatName);
    CheckTask(importTask,RegisteredSid,importXml,folder); CheckTask(heartbeatTask,RegisteredSid,heartbeatXml,folder);
    CheckTaskNeverRun(importTask,"import"); CheckTaskNeverRun(heartbeatTask,"heartbeat");
    Require(RegistrarCore.MachineWslClientRefusal()==null,"REGISTERED_MACHINE_WSL_CLIENT_REFUSED");
    WriteNew(Root+@"\resume-registered.intent",Map("contract","clued.m5b.registered-phase-continuation/1","resumeId",resumeId,"originalRunId",runId,"originalManifestSha256",manifestHash,"originalStageAnchorSha256",stageAnchor,"sid",RegisteredSid,"operatorSid",OperatorSid,"build",build,"at",DateTimeOffset.UtcNow.ToString("o"),"noAccountPasswordOrTaskRegistrationChanges",true));
    resumeIntentCreated=true;
    CheckTask(importTask,RegisteredSid,importXml,folder); CheckTaskNeverRun(importTask,"import-immediately-before-run");
    DateTime began=DateTime.UtcNow;
    Require(RunTaskOnce(importTask,"import",600)==0,"REGISTERED_IMPORT_TASK_FAILED"); ValidateImport(began,RegisteredSid);
    DateTime heartbeatBegan=DateTime.UtcNow;
    CheckTask(heartbeatTask,RegisteredSid,heartbeatXml,folder); CheckTaskNeverRun(heartbeatTask,"heartbeat-immediately-before-run");
    Require(RunTaskOnce(heartbeatTask,"test-heartbeat",180)==0,"REGISTERED_HEARTBEAT_TASK_FAILED");
    Dictionary<string,object> beat=ReadMap(Root+@"\results\test-heartbeat.json");
    Require((string)beat["runId"]==runId && (string)beat["sid"]==RegisteredSid && Convert.ToInt32(beat["logonType"])==4 && !(bool)beat["administrator"] && (bool)beat["testOnly"] && DateTimeOffset.Parse((string)beat["at"]).UtcDateTime>=heartbeatBegan.AddSeconds(-2),"REGISTERED_TEST_HEARTBEAT_INVALID");
    Dictionary<string,object> wsl=Child(beat,"wsl"), probe=Child(wsl,"probe"), registration=Child(wsl,"registrationAfter");
    Require(Convert.ToInt32(probe["exitCode"])==0 && !(bool)probe["timedOut"] && (string)registration["sid"]==RegisteredSid && (string)registration["distro"]==Distro && string.Equals((string)registration["basePath"],Path.GetDirectoryName(Target),StringComparison.OrdinalIgnoreCase),"REGISTERED_SECOND_BATCH_WSL_PROBE_NOT_BOUND");
    Dictionary<string,object> result=Map("contract",Contract,"status","REGISTERED_PHASE_CONTINUATION_IMPORT_PROBE_TEST_HEARTBEAT_PASS","resumeId",resumeId,"originalRunId",runId,"originalManifestSha256",manifestHash,"originalMainStillFailed",true,"sid",RegisteredSid,"testOnly",true,"formalSupervisorQualified",false,"evidenceRoot",Root);
    WriteNew(Root+@"\resume-registered.result.json",result); Stage("completed",result); Console.WriteLine(Json.Serialize(result)); return 0;
  }
  static FileStream OpenSingleFile(string path,bool correctionAccess) {
    Plain(path,false);
    SafeFileHandle handle=CreateFileW(path,correctionAccess?0x80040000u:0x80000000u,correctionAccess?0u:1u,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(handle.IsInvalid) { handle.Dispose(); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    IntPtr info=Marshal.AllocHGlobal(52);
    try {
      Require(GetFileInformationByHandle(handle,info),"CORRECTION_FILE_INFORMATION_FAILED");
      Require((Marshal.ReadInt32(info)&0x410)==0 && Marshal.ReadInt32(info,40)==1,"CORRECTION_FILE_LINK_OR_KIND_REFUSED");
      StringBuilder final=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(handle,final,32768,0);
      Require(length>0 && length<32768 && string.Equals(final.ToString(),@"\\?\"+path,StringComparison.OrdinalIgnoreCase),"CORRECTION_FILE_FINAL_PATH_REFUSED");
      return new FileStream(handle,FileAccess.Read);
    } catch { handle.Dispose(); throw; } finally { Marshal.FreeHGlobal(info); }
  }
  static void CheckOriginalBuildFiles() {
    string[] paths={BuildRoot+@"\M5bPhysicalImportAcceptance.cs",BuildRoot+@"\CompanionTaskRegistrar.cs",BuildRoot+"\\"+HarnessName,Root+@"\bin\"+HarnessName,BuildRoot+@"\M5bPhysicalImportAcceptance.resume-registered.cs",BuildRoot+"\\"+ResumeName,BuildRoot+@"\resume-registered.build.json"};
    string[] hashes={RegisteredSourceSha256,RegisteredRegistrarSha256,RegisteredHeartbeatSha256,RegisteredHeartbeatSha256,FailedResumeSourceSha256,FailedResumeExeSha256,FailedResumeBuildSha256};
    for(int i=0;i<paths.Length;i++) using(FileStream f=OpenSingleFile(paths[i],false)) Require(Hash(f)==hashes[i],"CORRECTION_OLD_BUILD_CHANGED");
  }
  static Dictionary<string,object> CheckCorrectionBuild() {
    Plain(BuildRoot,true); CheckAcl(BuildRoot,Acl(null,false));
    string self=Assembly.GetExecutingAssembly().Location;
    Require(string.Equals(self,BuildRoot+"\\"+CorrectionName,StringComparison.OrdinalIgnoreCase),"CORRECTION_SELF_PATH_REFUSED");
    CheckOriginalBuildFiles();
    Dictionary<string,object> b=ReadMap(BuildRoot+@"\disk-access-correction.build.json");
    string source=BuildRoot+@"\M5bPhysicalImportAcceptance.disk-access-correction.cs";
    Plain(source,false); Plain(self,false);
    Require(b.Count==8 && (string)b["contract"]=="clued.m5b.disk-access-correction-build/1" && (string)b["originalManifestSha256"]==RegisteredManifestSha256 && (string)b["originalRunId"]==RegisteredRunId && (string)b["registrarSha256"]==RegisteredRegistrarSha256 && (string)b["failedResumeExecutableSha256"]==FailedResumeExeSha256 && (string)b["harnessSourceSha256"]==Hash(source) && Regex.IsMatch((string)b["harnessSourceSha256"],@"\A[0-9a-f]{64}\z") && (string)b["executableSha256"]==Hash(self) && (string)b["executableName"]==CorrectionName,"CORRECTION_BUILD_RECORD_REFUSED");
    return b;
  }
  static string CorrectionFailedTaskRefusal(int result,DateTime last,int state,int instances) {
    return result==3 && last==new DateTime(2026,11,9,21,23,33) && state==3 && instances==0?null:"CORRECTION_IMPORT_NOT_EXACT_KNOWN_FAILURE";
  }
  static void CheckCorrectionFailedTask(object task) {
    int result=(int)Get(task,"LastTaskResult"),state=(int)Get(task,"State"),instances=(int)Get(Call(task,"GetInstances",0),"Count"); DateTime last=(DateTime)Get(task,"LastRunTime");
    string why=CorrectionFailedTaskRefusal(result,last,state,instances); Require(why==null,why);
    Stage("known-import-failure-readback",Map("result",result,"lastRunTime",last.ToString("o"),"state",state,"instances",instances));
  }
  // Before correction the only user ACE must be Modify; ownership must not
  // already confer WRITE_DAC. Only this VHD leaf gains ChangePermissions.
  static string CorrectionDiskAclRefusal(string sddl,bool corrected) {
    RawSecurityDescriptor d;
    try { d=new RawSecurityDescriptor(sddl); } catch { return "CORRECTION_DISK_ACL_UNREADABLE"; }
    if(d.Owner==null || (d.Owner.Value!="S-1-5-32-544" && d.Owner.Value!=OperatorSid) || d.DiscretionaryAcl==null || d.DiscretionaryAcl.Count!=3) return "CORRECTION_DISK_OWNER_OR_ACE_SET_REFUSED";
    if(corrected && (d.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) return "CORRECTION_DISK_NEW_DACL_NOT_PROTECTED";
    HashSet<string> seen=new HashSet<string>();
    foreach(GenericAce raw in d.DiscretionaryAcl) {
      CommonAce a=raw as CommonAce;
      if(a==null || a.IsCallback || a.AceQualifier!=AceQualifier.AccessAllowed || (corrected?a.AceFlags!=AceFlags.None:(a.AceFlags!=AceFlags.None && a.AceFlags!=AceFlags.Inherited)) || !seen.Add(a.SecurityIdentifier.Value)) return "CORRECTION_DISK_ACE_REFUSED";
      string sid=a.SecurityIdentifier.Value;
      if(sid=="S-1-5-18" || sid=="S-1-5-32-544") { if(a.AccessMask!=0x1f01ff) return "CORRECTION_DISK_ADMIN_RIGHTS_CHANGED"; }
      else if(sid!=RegisteredSid || a.AccessMask!=(corrected?0x1701bf:0x1301bf)) return "CORRECTION_DISK_USER_RIGHTS_REFUSED";
    }
    return null;
  }
  static void ArchiveFailedImport() {
    string archive=ReceiptRoot+@"\disk-access-correction.attempt1.import.json";
    Require(!EntryExists(archive),"CORRECTION_ARCHIVE_EXISTS_NO_RETRY");
    using(FileStream input=OpenSingleFile(Root+@"\batch\companion-wsl-import-result.json",false)) {
      Require(input.Length==1863 && Hash(input)==FailedImportSha256,"CORRECTION_FAILED_IMPORT_BYTES_CHANGED"); input.Position=0;
      FileSecurity security=new FileSecurity(); security.SetSecurityDescriptorSddlForm("O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)");
      using(FileStream output=new FileStream(archive,FileMode.CreateNew,FileSystemRights.Write|FileSystemRights.ReadPermissions,FileShare.Read,4096,FileOptions.WriteThrough,security)) { input.CopyTo(output); output.Flush(true); }
    }
    CheckFailedImportArchive();
  }
  static void CheckFailedImportArchive() {
    string archive=ReceiptRoot+@"\disk-access-correction.attempt1.import.json";
    using(FileStream saved=OpenSingleFile(archive,false)) Require(Hash(saved)==FailedImportSha256,"CORRECTION_ARCHIVE_HASH_FAILED");
    RawSecurityDescriptor acl=new RawSecurityDescriptor(File.GetAccessControl(archive).GetSecurityDescriptorBinaryForm(),0);
    Require(acl.Owner.Value=="S-1-5-32-544" && (acl.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0 && acl.DiscretionaryAcl.Count==2,"CORRECTION_ARCHIVE_ACL_FAILED");
    HashSet<string> seen=new HashSet<string>();
    foreach(GenericAce raw in acl.DiscretionaryAcl) { CommonAce a=raw as CommonAce; Require(a!=null && !a.IsCallback && a.AceQualifier==AceQualifier.AccessAllowed && a.AceFlags==AceFlags.None && a.AccessMask==0x1f01ff && (a.SecurityIdentifier.Value=="S-1-5-18" || a.SecurityIdentifier.Value=="S-1-5-32-544") && seen.Add(a.SecurityIdentifier.Value),"CORRECTION_ARCHIVE_ACL_FAILED"); }
  }
  static int DiskAccessCorrection(string manifestHash) {
    Require(Environment.MachineName=="TURING" && WindowsIdentity.GetCurrent().User.Value==OperatorSid && (bool)Invoke("Elevated") && IntPtr.Size==8,"CORRECTION_OPERATOR_REFUSED");
    Require(manifestHash==RegisteredManifestSha256,"CORRECTION_MANIFEST_ARGUMENT_REFUSED");
    TrustedParent(@"C:\",true); TrustedParent(@"C:\ProgramData",true);
    foreach(string directory in new[]{Root,Root+@"\bin",Root+@"\batch",Root+@"\results",ReceiptRoot}) Plain(directory,true);
    CheckAcl(Root,Acl(RegisteredSid,false)); CheckAcl(Root+@"\bin",Acl(RegisteredSid,false)); CheckAcl(Root+@"\batch",Acl(RegisteredSid,true)); CheckAcl(Root+@"\results",Acl(RegisteredSid,true)); CheckAcl(ReceiptRoot,Acl(OperatorSid,false));
    Require(!EntryExists(Root+@"\disk-access-correction.intent") && !EntryExists(Root+@"\disk-access-correction.result.json") && !EntryExists(Root+@"\result.json") && !EntryExists(Root+@"\resume-registered.result.json"),"CORRECTION_ONCE_OR_RESULT_EXISTS");
    Require(Hash(Manifest)==RegisteredManifestSha256 && RegisteredManifestRefusal(ReadMap(Manifest),Hash(Manifest))==null,"CORRECTION_ORIGINAL_MANIFEST_CHANGED");
    string[] anchors={Root+@"\resume-registered.intent",Root+@"\resume-registered.failure."+FailedResumeId+".json",Root+@"\stages.jsonl",ReceiptRoot+@"\post-import-accepted-diagnostic.json"};
    string[] anchorHashes={FailedResumeIntentSha256,FailedResumeFailureSha256,FailedResumeStagesSha256,PostImportDiagnosticSha256};
    for(int i=0;i<anchors.Length;i++) using(FileStream f=OpenSingleFile(anchors[i],false)) Require(Hash(f)==anchorHashes[i],"CORRECTION_FAILURE_ANCHOR_CHANGED");
    Require(Directory.GetFileSystemEntries(Root+@"\results").Length==0,"CORRECTION_HEARTBEAT_EVIDENCE_ALREADY_EXISTS");
    Dictionary<string,object> prior=ReadMap(Root+@"\batch\companion-wsl-import-result.json");
    Require(Hash(Root+@"\batch\companion-wsl-import-result.json")==FailedImportSha256 && (string)prior["runId"]=="963d8a99-dc4a-4930-aa9c-49f231e85d11" && Convert.ToInt32(prior["exitCode"])==3 && prior["registration"]==null,"CORRECTION_NOT_KNOWN_IMPORT_FAILURE");
    Dictionary<string,object> build=CheckCorrectionBuild(); CheckRegisteredAccount(); CheckSchedulerEnvironment();
    string importXml=RegistrarCore.ImportTaskXml(RegisteredSid,Distro,Target,0), heartbeatXml=HeartbeatXml(RegisteredSid);
    Require(TextHash(RegistrarCore.ImportArguments(Distro,Target,0))==RegisteredImportActionSha256,"CORRECTION_IMPORT_SOURCE_CHANGED");
    Plain(Root+@"\import-task.xml",false); Require(File.ReadAllText(Root+@"\import-task.xml",new UTF8Encoding(false,true))==importXml,"CORRECTION_IMPORT_XML_CHANGED");
    object service=Invoke("Service"),folder=Call(service,"GetFolder",@"\"+FolderName);
    Require((int)Get(Call(folder,"GetTasks",1),"Count")==2 && (int)Get(Call(folder,"GetFolders",0),"Count")==0,"CORRECTION_TASK_INVENTORY_CHANGED");
    object importTask=Call(folder,"GetTask",RegistrarCore.ImportTaskName), heartbeatTask=Call(folder,"GetTask",HeartbeatName);
    // Begin prefixed diagnostics only after the exact prior stage bytes bind.
    runId=RegisteredRunId;resumeId=Guid.NewGuid().ToString("D");stagePrefix="disk-access-correction:";rootOwned=true;
    CheckTask(importTask,RegisteredSid,importXml,folder);CheckTask(heartbeatTask,RegisteredSid,heartbeatXml,folder);
    CheckCorrectionFailedTask(importTask);CheckTaskNeverRun(heartbeatTask,"heartbeat-before-correction");
    Require(RegistrarCore.MachineWslClientRefusal()==null,"CORRECTION_MACHINE_WSL_CLIENT_REFUSED");
    using(FileStream disk=OpenSingleFile(Target,true)) {
      string before=disk.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Owner|AccessControlSections.Access);
      string why=CorrectionDiskAclRefusal(before,false);
      Stage("disk-preflight",Map("path",Target,"length",disk.Length,"actualSddl",before,"sha256",Hash(disk),"aclRefusal",why));
      Require(why==null,"CORRECTION_DISK_NOT_EXACT_MISSING_WRITE_DAC");
      Require(disk.Length==79691776,"CORRECTION_DISK_LENGTH_CHANGED");disk.Position=0;Require(Hash(disk)==RegisteredSeedSha256,"CORRECTION_DISK_BYTES_CHANGED_OR_IN_USE");
      ArchiveFailedImport();
      WriteNew(Root+@"\disk-access-correction.intent",Map("contract","clued.m5b.known-failed-import-disk-access-correction/1","correctionId",resumeId,"originalRunId",runId,"failedResumeId",FailedResumeId,"originalManifestSha256",manifestHash,"failedImportSha256",FailedImportSha256,"failedStageAnchorSha256",FailedResumeStagesSha256,"postImportDiagnosticSha256",PostImportDiagnosticSha256,"sid",RegisteredSid,"operatorSid",OperatorSid,"at",DateTimeOffset.UtcNow.ToString("o"),"build",build,"attempt2MayReplaceDiagnosticAtOriginalPath",true,"originalFailuresRemain",true,"maximumImportRuns",1,"maximumHeartbeatRuns",1));
      resumeIntentCreated=true;
      FileSecurity access=new FileSecurity(); access.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1701bf;;;"+RegisteredSid+")",AccessControlSections.Access);
      disk.SetAccessControl(access);
      string after=disk.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Owner|AccessControlSections.Access);
      why=CorrectionDiskAclRefusal(after,true);Require(why==null,why);
      Stage("disk-write-dac-added",Map("path",Target,"beforeSddl",before,"afterSddl",after,"newUserMask",0x1701bf,"onlyThisDataFile",true));
    }
    // Keep the known old import state and the fresh task security checks beside Run.
    CheckTask(importTask,RegisteredSid,importXml,folder);CheckCorrectionFailedTask(importTask);
    DateTime began=DateTime.UtcNow;
    Require(RunTaskOnce(importTask,"attempt2-import",600)==0,"CORRECTION_ATTEMPT2_IMPORT_TASK_FAILED"); ValidateImport(began,RegisteredSid);
    DateTime heartbeatBegan=DateTime.UtcNow;
    CheckTask(heartbeatTask,RegisteredSid,heartbeatXml,folder);CheckTaskNeverRun(heartbeatTask,"heartbeat-immediately-before-run");
    Require(RunTaskOnce(heartbeatTask,"test-heartbeat",180)==0,"CORRECTION_HEARTBEAT_TASK_FAILED");
    Dictionary<string,object> beat=ReadMap(Root+@"\results\test-heartbeat.json");
    Require((string)beat["runId"]==runId && (string)beat["sid"]==RegisteredSid && Convert.ToInt32(beat["logonType"])==4 && !(bool)beat["administrator"] && (bool)beat["testOnly"] && DateTimeOffset.Parse((string)beat["at"]).UtcDateTime>=heartbeatBegan.AddSeconds(-2),"CORRECTION_TEST_HEARTBEAT_INVALID");
    Dictionary<string,object> wsl=Child(beat,"wsl"),probe=Child(wsl,"probe"),registration=Child(wsl,"registrationAfter");
    Require(Convert.ToInt32(probe["exitCode"])==0 && !(bool)probe["timedOut"] && (string)registration["sid"]==RegisteredSid && (string)registration["distro"]==Distro && string.Equals((string)registration["basePath"],Path.GetDirectoryName(Target),StringComparison.OrdinalIgnoreCase),"CORRECTION_SECOND_BATCH_PROBE_NOT_BOUND");
    Dictionary<string,object> result=Map("contract",Contract,"status","KNOWN_FAILED_IMPORT_DISK_ACCESS_CORRECTION_IMPORT_PROBE_TEST_HEARTBEAT_PASS","correctionId",resumeId,"originalRunId",runId,"originalMainStillFailed",true,"originalRegisteredContinuationStillFailed",true,"attempt",2,"sid",RegisteredSid,"testOnly",true,"formalSupervisorQualified",false,"evidenceRoot",Root);
    WriteNew(Root+@"\disk-access-correction.result.json",result);Stage("completed",result);Console.WriteLine(Json.Serialize(result));return 0;
  }
  static Dictionary<string,object> CheckLoggingBuild() {
    Plain(BuildRoot,true); CheckAcl(BuildRoot,Acl(null,false)); CheckOriginalBuildFiles();
    string self=Assembly.GetExecutingAssembly().Location;
    Require(string.Equals(self,BuildRoot+"\\"+LoggingName,StringComparison.OrdinalIgnoreCase),"LOGGING_SELF_PATH_REFUSED");
    using(FileStream f=OpenSingleFile(BuildRoot+@"\M5bPhysicalImportAcceptance.disk-access-correction.cs",false)) Require(Hash(f)==CorrectionSourceSha256,"LOGGING_PRIOR_CORRECTION_SOURCE_CHANGED");
    using(FileStream f=OpenSingleFile(BuildRoot+"\\"+CorrectionName,false)) Require(Hash(f)==CorrectionExeSha256,"LOGGING_PRIOR_CORRECTION_BINARY_CHANGED");
    Dictionary<string,object> old=ReadMap(BuildRoot+@"\disk-access-correction.build.json");
    Require(old.Count==8 && (string)old["contract"]=="clued.m5b.disk-access-correction-build/1" && (string)old["originalManifestSha256"]==RegisteredManifestSha256 && (string)old["originalRunId"]==RegisteredRunId && (string)old["registrarSha256"]==RegisteredRegistrarSha256 && (string)old["failedResumeExecutableSha256"]==FailedResumeExeSha256 && (string)old["harnessSourceSha256"]==CorrectionSourceSha256 && (string)old["executableSha256"]==CorrectionExeSha256 && (string)old["executableName"]==CorrectionName,"LOGGING_PRIOR_CORRECTION_BUILD_CHANGED");
    Dictionary<string,object> b=ReadMap(BuildRoot+@"\logging-blocked.build.json");
    string source=BuildRoot+@"\M5bPhysicalImportAcceptance.logging-blocked.cs";Plain(source,false);Plain(self,false);
    Require(b.Count==9 && (string)b["contract"]=="clued.m5b.logging-blocked-build/1" && (string)b["originalManifestSha256"]==RegisteredManifestSha256 && (string)b["originalRunId"]==RegisteredRunId && (string)b["registrarSha256"]==RegisteredRegistrarSha256 && (string)b["failedResumeExecutableSha256"]==FailedResumeExeSha256 && (string)b["failedCorrectionExecutableSha256"]==CorrectionExeSha256 && (string)b["harnessSourceSha256"]==Hash(source) && Regex.IsMatch((string)b["harnessSourceSha256"],@"\A[0-9a-f]{64}\z") && (string)b["executableSha256"]==Hash(self) && (string)b["executableName"]==LoggingName,"LOGGING_BUILD_RECORD_REFUSED");
    return b;
  }
  static string LoggingBlockedTaskRefusal(int result,DateTime last,int state,int instances) {
    return result==7 && last==new DateTime(2026,11,9,21,49,9) && state==3 && instances==0?null:"LOGGING_IMPORT_NOT_EXACT_KNOWN_BLOCKED_RUN";
  }
  static void CheckLoggingBlockedTask(object task) {
    int result=(int)Get(task,"LastTaskResult"),state=(int)Get(task,"State"),instances=(int)Get(Call(task,"GetInstances",0),"Count");DateTime last=(DateTime)Get(task,"LastRunTime");
    string why=LoggingBlockedTaskRefusal(result,last,state,instances);Require(why==null,why);
    Stage("logging-blocked-task-readback",Map("result",result,"lastRunTime",last.ToString("o"),"state",state,"instances",instances));
  }
  static string LoggingDiskAclRefusal(string sddl) {
    string why=CorrectionDiskAclRefusal(sddl,true);if(why!=null) return why;
    return new RawSecurityDescriptor(sddl).Owner.Value=="S-1-5-32-544"?null:"LOGGING_DISK_OWNER_CHANGED";
  }
  static int LoggingBlockedContinuation(string manifestHash) {
    Require(Environment.MachineName=="TURING" && WindowsIdentity.GetCurrent().User.Value==OperatorSid && (bool)Invoke("Elevated") && IntPtr.Size==8,"LOGGING_OPERATOR_REFUSED");
    Require(manifestHash==RegisteredManifestSha256,"LOGGING_MANIFEST_ARGUMENT_REFUSED");
    TrustedParent(@"C:\",true);TrustedParent(@"C:\ProgramData",true);
    foreach(string directory in new[]{Root,Root+@"\bin",Root+@"\batch",Root+@"\results",ReceiptRoot}) Plain(directory,true);
    CheckAcl(Root,Acl(RegisteredSid,false));CheckAcl(Root+@"\bin",Acl(RegisteredSid,false));CheckAcl(Root+@"\batch",Acl(RegisteredSid,true));CheckAcl(Root+@"\results",Acl(RegisteredSid,true));CheckAcl(ReceiptRoot,Acl(OperatorSid,false));
    foreach(string f in new[]{Root+@"\logging-blocked.intent",Root+@"\logging-blocked.result.json",Root+@"\result.json",Root+@"\resume-registered.result.json",Root+@"\disk-access-correction.result.json"}) Require(!EntryExists(f),"LOGGING_ONCE_OR_RESULT_EXISTS");
    Require(Hash(Manifest)==RegisteredManifestSha256 && RegisteredManifestRefusal(ReadMap(Manifest),Hash(Manifest))==null,"LOGGING_ORIGINAL_MANIFEST_CHANGED");
    string[] anchors={Root+@"\resume-registered.intent",Root+@"\resume-registered.failure."+FailedResumeId+".json",Root+@"\disk-access-correction.intent",Root+@"\disk-access-correction.failure."+CorrectionId+".json",Root+@"\stages.jsonl",ReceiptRoot+@"\disk-access-correction.snapshot.json"};
    string[] hashes={FailedResumeIntentSha256,FailedResumeFailureSha256,CorrectionIntentSha256,CorrectionFailureSha256,CorrectionStagesSha256,CorrectionSnapshotSha256};
    for(int i=0;i<anchors.Length;i++) using(FileStream f=OpenSingleFile(anchors[i],false)) Require(Hash(f)==hashes[i],"LOGGING_PRIOR_ATTEMPT_ANCHOR_CHANGED");
    Require(Directory.GetFileSystemEntries(Root+@"\results").Length==0,"LOGGING_HEARTBEAT_EVIDENCE_ALREADY_EXISTS");
    // The old diagnostic remains attempt 1. Its protected archive must already
    // exist; this mode neither changes its permissions nor creates a new copy.
    CheckFailedImportArchive();
    using(FileStream old=OpenSingleFile(Root+@"\batch\companion-wsl-import-result.json",false)) {
      Require(old.Length==1863 && Hash(old)==FailedImportSha256,"LOGGING_OLD_IMPORT_DIAGNOSTIC_CHANGED");
      Require(old.GetAccessControl().GetOwner(typeof(SecurityIdentifier)).Value==RegisteredSid,"LOGGING_OLD_IMPORT_DIAGNOSTIC_OWNER_CHANGED");
    }
    Dictionary<string,object> build=CheckLoggingBuild();CheckRegisteredAccount();CheckSchedulerEnvironment();
    string importXml=RegistrarCore.ImportTaskXml(RegisteredSid,Distro,Target,0),heartbeatXml=HeartbeatXml(RegisteredSid);
    Require(TextHash(RegistrarCore.ImportArguments(Distro,Target,0))==RegisteredImportActionSha256,"LOGGING_IMPORT_SOURCE_CHANGED");
    Plain(Root+@"\import-task.xml",false);Require(File.ReadAllText(Root+@"\import-task.xml",new UTF8Encoding(false,true))==importXml,"LOGGING_IMPORT_XML_CHANGED");
    object service=Invoke("Service"),folder=Call(service,"GetFolder",@"\"+FolderName);
    Require((int)Get(Call(folder,"GetTasks",1),"Count")==2 && (int)Get(Call(folder,"GetFolders",0),"Count")==0,"LOGGING_TASK_INVENTORY_CHANGED");
    object importTask=Call(folder,"GetTask",RegistrarCore.ImportTaskName),heartbeatTask=Call(folder,"GetTask",HeartbeatName);
    runId=RegisteredRunId;resumeId=Guid.NewGuid().ToString("D");stagePrefix="logging-blocked:";rootOwned=true;
    CheckTask(importTask,RegisteredSid,importXml,folder);CheckTask(heartbeatTask,RegisteredSid,heartbeatXml,folder);CheckLoggingBlockedTask(importTask);CheckTaskNeverRun(heartbeatTask,"heartbeat-before-logging-continuation");
    Require(RegistrarCore.MachineWslClientRefusal()==null,"LOGGING_MACHINE_WSL_CLIENT_REFUSED");
    using(FileStream disk=OpenSingleFile(Target,false)) {
      string sddl=disk.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Owner|AccessControlSections.Access),why=LoggingDiskAclRefusal(sddl);
      Require(why==null,why);Require(disk.Length==79691776 && Hash(disk)==RegisteredSeedSha256,"LOGGING_DISK_BYTES_CHANGED_OR_IN_USE");
      Stage("disk-readonly-preflight",Map("path",Target,"length",disk.Length,"actualSddl",sddl,"sha256",RegisteredSeedSha256,"noAclChanges",true));
    }
    WriteNew(Root+@"\logging-blocked.intent",Map("contract","clued.m5b.known-logging-blocked-continuation/1","loggingId",resumeId,"originalRunId",runId,"originalManifestSha256",manifestHash,"priorCorrectionId",CorrectionId,"priorCorrectionIntentSha256",CorrectionIntentSha256,"priorCorrectionFailureSha256",CorrectionFailureSha256,"priorSnapshotSha256",CorrectionSnapshotSha256,"oldImportDiagnosticSha256",FailedImportSha256,"sid",RegisteredSid,"operatorSid",OperatorSid,"at",DateTimeOffset.UtcNow.ToString("o"),"build",build,"originalFailuresRemain",true,"maximumImportTaskRuns",1,"maximumHeartbeatRuns",1,"noAclAccountPasswordOrTaskRegistrationChanges",true));resumeIntentCreated=true;
    CheckTask(importTask,RegisteredSid,importXml,folder);CheckLoggingBlockedTask(importTask);
    DateTime began=DateTime.UtcNow;
    Require(RunTaskOnce(importTask,"logging-continuation-import",600)==0,"LOGGING_IMPORT_TASK_FAILED");ValidateImport(began,RegisteredSid);
    DateTime heartbeatBegan=DateTime.UtcNow;
    CheckTask(heartbeatTask,RegisteredSid,heartbeatXml,folder);CheckTaskNeverRun(heartbeatTask,"heartbeat-immediately-before-run");
    Require(RunTaskOnce(heartbeatTask,"test-heartbeat",180)==0,"LOGGING_HEARTBEAT_TASK_FAILED");
    Dictionary<string,object> beat=ReadMap(Root+@"\results\test-heartbeat.json");
    Require((string)beat["runId"]==runId && (string)beat["sid"]==RegisteredSid && Convert.ToInt32(beat["logonType"])==4 && !(bool)beat["administrator"] && (bool)beat["testOnly"] && DateTimeOffset.Parse((string)beat["at"]).UtcDateTime>=heartbeatBegan.AddSeconds(-2),"LOGGING_TEST_HEARTBEAT_INVALID");
    Dictionary<string,object> wsl=Child(beat,"wsl"),probe=Child(wsl,"probe"),registration=Child(wsl,"registrationAfter");
    Require(Convert.ToInt32(probe["exitCode"])==0 && !(bool)probe["timedOut"] && (string)registration["sid"]==RegisteredSid && (string)registration["distro"]==Distro && string.Equals((string)registration["basePath"],Path.GetDirectoryName(Target),StringComparison.OrdinalIgnoreCase),"LOGGING_SECOND_BATCH_PROBE_NOT_BOUND");
    Dictionary<string,object> result=Map("contract",Contract,"status","KNOWN_LOGGING_BLOCKED_CONTINUATION_IMPORT_PROBE_TEST_HEARTBEAT_PASS","loggingId",resumeId,"originalRunId",runId,"originalMainStillFailed",true,"originalRegisteredContinuationStillFailed",true,"originalDiskAccessCorrectionStillFailed",true,"sid",RegisteredSid,"testOnly",true,"formalSupervisorQualified",false,"evidenceRoot",Root);
    WriteNew(Root+@"\logging-blocked.result.json",result);Stage("completed",result);Console.WriteLine(Json.Serialize(result));return 0;
  }
  static int Execute(string seedHash) {
    Require(Environment.MachineName.Equals("TURING",StringComparison.OrdinalIgnoreCase),"MACHINE_REFUSED");
    Require((bool)Invoke("Elevated") && IntPtr.Size==8,"ELEVATED_X64_REQUIRED");
    Require(System.Text.RegularExpressions.Regex.IsMatch(seedHash,@"\A[0-9a-f]{64}\z"),"SEED_SHA256_INVALID");
    Require(RegistrarCore.ValidVhdx(Target) && RegistrarCore.ValidDistro(Distro),"FIXED_IMPORT_ARGUMENTS_INVALID");
    TrustedParent(@"C:\",true); TrustedParent(@"C:\ProgramData",true);
    Require(!EntryExists(Root),"TEST_ROOT_ALREADY_EXISTS_NO_RETRY");
    AccountAbsent(); Plain(Seed,false); TrustedParent(Path.GetDirectoryName(Seed),false);
    CheckSchedulerEnvironment();
    string selfPath=Assembly.GetExecutingAssembly().Location;
    Require(string.Equals(Path.GetDirectoryName(selfPath),BuildRoot,StringComparison.OrdinalIgnoreCase),"HARNESS_BUILD_PATH_REFUSED");
    CheckAcl(BuildRoot,Acl(null,false)); Plain(selfPath,false);
    Require(RegistrarCore.MachineWslClientRefusal()==null,"MACHINE_WSL_CLIENT_REFUSED");
    object service=Invoke("Service");
    // Validate the folder's absence before any persistent test effect.
    try { Call(service,"GetFolder",@"\"+FolderName); Require(false,"TEST_TASK_FOLDER_EXISTS"); }
    catch(TargetInvocationException e) { Require(e.InnerException!=null && e.InnerException.HResult==unchecked((int)0x80070002),"TASK_FOLDER_LOOKUP_FAILED"); }
    using(FileStream seed=new FileStream(Seed,FileMode.Open,FileAccess.Read,FileShare.None)) {
      Require(seed.Length>=1024*1024 && seed.Length<=2L*1024*1024*1024,"SEED_SIZE_REFUSED");
      Require(Hash(seed)==seedHash,"SEED_SHA256_MISMATCH"); seed.Position=0;
      runId=Guid.NewGuid().ToString("D"); NewDirectory(Root,Acl(null,false)); rootOwned=true;
      Stage("root-created",Map("runId",runId,"seed",Seed,"seedSha256",seedHash));
      string sid=NewAccount();
      DirectorySecurity rootAcl=new DirectorySecurity(); rootAcl.SetSecurityDescriptorSddlForm(Acl(sid,false)); Directory.SetAccessControl(Root,rootAcl); CheckAcl(Root,Acl(sid,false));
      NewDirectory(Root+@"\batch",Acl(sid,true)); NewDirectory(Root+@"\results",Acl(sid,true)); NewDirectory(Root+@"\bin",Acl(sid,false));
      using(FileStream target=new FileStream(Target,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { seed.CopyTo(target); target.Flush(true); }
      Require(Hash(Target)==seedHash,"TARGET_COPY_SHA256_MISMATCH");
      string self=Assembly.GetExecutingAssembly().Location, executable=Root+@"\bin\"+HarnessName;
      Plain(self,false); File.Copy(self,executable,false); Require(Hash(self)==Hash(executable),"HARNESS_COPY_SHA256_MISMATCH");
      string importXml=RegistrarCore.ImportTaskXml(sid,Distro,Target,0), heartbeatXml=HeartbeatXml(sid);
      WriteTextNew(Root+@"\import-task.xml",importXml);
      WriteNew(Manifest,Map("contract",Contract,"runId",runId,"machine",Environment.MachineName,"sid",sid,"account",Account,"root",Root,"distro",Distro,"seedSha256",seedHash,"harnessSha256",Hash(executable),"importActionSha256",TextHash(RegistrarCore.ImportArguments(Distro,Target,0)),"testHeartbeatOnly",true,"cleanupImplemented",false));
      object folder=NewFolder(service), importDef=Call(service,"NewTask",0), heartbeatDef=Call(service,"NewTask",0);
      Set(importDef,"XmlText",importXml); Set(heartbeatDef,"XmlText",heartbeatXml);
      IntPtr pw=IntPtr.Zero,bstr=IntPtr.Zero;
      try {
        pw=(IntPtr)Invoke("NewRandomPassword");
        // Allocate the BSTR without ever making a managed password string.
        bstr=(IntPtr)Invoke("SysAllocStringLen",pw,(uint)RegistrarCore.RandomPasswordChars);
        Require(bstr!=IntPtr.Zero,"PASSWORD_BSTR_ALLOCATION_FAILED");
        object[] set={null,Account,1003,pw,0}; int passwordCode=(int)Invoke("NetUserSetInfo",set);
        Stage("password-set-result",Map("rawReturnCode",passwordCode,"parameterError",set[4])); Require(passwordCode==0,"TEST_PASSWORD_NOT_SET");
        string qualified=Environment.MachineName+"\\"+Account;
        int importCode=(int)Invoke("RegisterWithPassword",folder,importDef,RegistrarCore.ImportTaskName,qualified,bstr,RegistrarCore.ImportTaskSddl);
        Stage("import-registration-result",Map("rawHresult",importCode)); Require(importCode==0,"IMPORT_TASK_REGISTRATION_FAILED");
        int heartbeatCode=(int)Invoke("RegisterWithPassword",folder,heartbeatDef,HeartbeatName,qualified,bstr,RegistrarCore.ImportTaskSddl);
        Stage("heartbeat-registration-result",Map("rawHresult",heartbeatCode)); Require(heartbeatCode==0,"HEARTBEAT_TASK_REGISTRATION_FAILED");
      } finally {
        if(bstr!=IntPtr.Zero) { ZeroMemory(bstr,new UIntPtr((uint)(RegistrarCore.RandomPasswordChars*2))); Marshal.FreeBSTR(bstr); }
        if(pw!=IntPtr.Zero) { ZeroMemory(pw,new UIntPtr((uint)((RegistrarCore.RandomPasswordChars+1)*2))); Marshal.FreeHGlobal(pw); }
      }
      Stage("password-cleared-both-tasks-registered",null);
      object importTask=Call(folder,"GetTask",RegistrarCore.ImportTaskName), heartbeatTask=Call(folder,"GetTask",HeartbeatName);
      CheckTask(importTask,sid,importXml,folder); CheckTask(heartbeatTask,sid,heartbeatXml,folder);
      DateTime began=DateTime.UtcNow;
      Require(RunTaskOnce(importTask,"import",600)==0,"IMPORT_TASK_FAILED"); ValidateImport(began,sid);
      DateTime heartbeatBegan=DateTime.UtcNow;
      CheckTask(heartbeatTask,sid,heartbeatXml,folder);
      Require(RunTaskOnce(heartbeatTask,"test-heartbeat",180)==0,"HEARTBEAT_TASK_FAILED");
      Dictionary<string,object> beat=ReadMap(Root+@"\results\test-heartbeat.json");
      Require((string)beat["runId"]==runId && (string)beat["sid"]==sid && Convert.ToInt32(beat["logonType"])==4 && !(bool)beat["administrator"] && (bool)beat["testOnly"],"TEST_HEARTBEAT_INVALID");
      Require(DateTimeOffset.Parse((string)beat["at"]).UtcDateTime>=heartbeatBegan.AddSeconds(-2),"TEST_HEARTBEAT_STALE");
      Dictionary<string,object> wsl=Child(beat,"wsl"), probe=Child(wsl,"probe"), registration=Child(wsl,"registrationAfter");
      Require(Convert.ToInt32(probe["exitCode"])==0 && !(bool)probe["timedOut"] && (string)registration["sid"]==sid && (string)registration["distro"]==Distro && string.Equals((string)registration["basePath"],Path.GetDirectoryName(Target),StringComparison.OrdinalIgnoreCase),"SECOND_BATCH_WSL_PROBE_NOT_BOUND");
      Dictionary<string,object> result=Map("contract",Contract,"status","ISOLATED_IMPORT_PROBE_TEST_HEARTBEAT_PASS","runId",runId,"sid",sid,"testOnly",true,"formalSupervisorQualified",false,"evidenceRoot",Root);
      WriteNew(Root+@"\result.json",result); Stage("completed",result); Console.WriteLine(Json.Serialize(result)); return 0;
    }
  }
  static int Heartbeat() {
    Require(IntPtr.Size==8 && Environment.MachineName.Equals("TURING",StringComparison.OrdinalIgnoreCase),"HEARTBEAT_HOST_REFUSED");
    Plain(Root,true); Dictionary<string,object> m=ReadMap(Manifest);
    Require((string)m["contract"]==Contract && (string)m["root"]==Root && (string)m["account"]==Account,"HEARTBEAT_MANIFEST_REFUSED");
    WindowsIdentity identity=WindowsIdentity.GetCurrent(); string sid=identity.User.Value;
    Require(sid==(string)m["sid"] && !new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator),"HEARTBEAT_IDENTITY_REFUSED");
    Require(string.Equals(Assembly.GetExecutingAssembly().Location,Root+@"\bin\"+HarnessName,StringComparison.OrdinalIgnoreCase) && Hash(Assembly.GetExecutingAssembly().Location)==(string)m["harnessSha256"],"HEARTBEAT_SOURCE_REFUSED");
    IntPtr statistics=Marshal.AllocHGlobal(256), data=IntPtr.Zero; int got;
    try {
      Require(GetTokenInformation(identity.Token,10,statistics,256,out got),"HEARTBEAT_TOKEN_UNREADABLE");
      Luid id=(Luid)Marshal.PtrToStructure(new IntPtr(statistics.ToInt64()+8),typeof(Luid));
      Require(LsaGetLogonSessionData(ref id,out data)==0 && data!=IntPtr.Zero,"HEARTBEAT_LOGON_UNREADABLE");
      LogonData logon=(LogonData)Marshal.PtrToStructure(data,typeof(LogonData)); Require(logon.LogonType==4,"HEARTBEAT_NOT_BATCH_LOGON");
      Plain(Root+@"\results",true);
      Dictionary<string,object> wsl=HeartbeatProbe(sid);
      WriteNew(Root+@"\results\test-heartbeat.json",Map("contract","clued.m5b.test-heartbeat/1","runId",m["runId"],"at",DateTimeOffset.UtcNow.ToString("o"),"sid",sid,"logonType",logon.LogonType,"sessionId",logon.Session,"administrator",false,"wsl",wsl,"testOnly",true,"formalSupervisorQualified",false));
      return 0;
    } finally { if(data!=IntPtr.Zero) LsaFreeReturnBuffer(data); Marshal.FreeHGlobal(statistics); identity.Dispose(); }
  }
  [STAThread] public static int Main(string[] args) {
    try {
      Require((bool)Invoke("SetDefaultDllDirectories",(uint)0x800),"SYSTEM_DLL_SEARCH_REQUIRED");
      if(args.Length==1 && args[0]=="heartbeat") return Heartbeat();
      if(args.Length==2 && args[0]=="run-import") return Execute(args[1]);
      if(args.Length==2 && args[0]=="resume-registered") { registeredResume=true; return ResumeRegistered(args[1]); }
      if(args.Length==2 && args[0]=="disk-access-correction") { diskCorrection=true; registeredResume=true; return DiskAccessCorrection(args[1]); }
      if(args.Length==2 && args[0]=="logging-blocked") { loggingBlocked=true; registeredResume=true; return LoggingBlockedContinuation(args[1]); }
      Console.WriteLine("{\"status\":\"ARGUMENTS_REFUSED\"}"); return 2;
    } catch(Exception e) {
      while(e is TargetInvocationException && e.InnerException!=null) e=e.InnerException;
      Dictionary<string,object> error=Map("status","FAILED_PRESERVED_NO_RETRY","phase",phase,"code",e is Refusal?((Refusal)e).Code:null,"exceptionType",e.GetType().Name,"hresult","0x"+e.HResult.ToString("X8"),"evidenceRoot",Root);
      if(registeredResume) {
        error["status"]=loggingBlocked?"KNOWN_LOGGING_BLOCKED_CONTINUATION_FAILED_PRESERVED_NO_RETRY":diskCorrection?"KNOWN_FAILED_IMPORT_DISK_ACCESS_CORRECTION_FAILED_PRESERVED_NO_RETRY":"REGISTERED_PHASE_CONTINUATION_FAILED_PRESERVED_NO_RETRY";
        error["originalRunId"]=RegisteredRunId; error["originalManifestSha256"]=RegisteredManifestSha256;
        error["originalMainStillFailed"]=true; error["resumeId"]=resumeId; error["resumeIntentCreated"]=resumeIntentCreated;
        if(diskCorrection || loggingBlocked) error["originalRegisteredContinuationStillFailed"]=true;
        if(loggingBlocked) error["originalDiskAccessCorrectionStillFailed"]=true;
      }
      if(e is System.ComponentModel.Win32Exception) error["nativeErrorCode"]=((System.ComponentModel.Win32Exception)e).NativeErrorCode;
      // No exception text, command environment or password can enter the log.
      try { Stage("failed",error); } catch { }
      if(registeredResume && rootOwned) { try { WriteNew(Root+(loggingBlocked?@"\logging-blocked.failure.":diskCorrection?@"\disk-access-correction.failure.":@"\resume-registered.failure.")+(resumeId??Guid.NewGuid().ToString("D"))+".json",error); } catch { } }
      if(args.Length==1 && args[0]=="heartbeat") {
        try {
          Dictionary<string,object> m=ReadMap(Manifest);
          if((string)m["contract"]==Contract && WindowsIdentity.GetCurrent().User.Value==(string)m["sid"]) {
            Plain(Root+@"\results",true); WriteNew(Root+@"\results\test-heartbeat-failure.json",error);
          }
        } catch { }
      }
      Console.WriteLine(Json.Serialize(error)); return 1;
    }
  }
}
