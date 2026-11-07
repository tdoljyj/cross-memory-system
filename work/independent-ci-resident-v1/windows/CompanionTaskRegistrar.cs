// CluedCompanionTaskRegistrar.exe (DESIGN §65.4.4, M5): the only place the Owner's Windows password ever is.
//
//   CluedCompanionTaskRegistrar.exe register-password "C:\ProgramData\CluedIndependentCI\resident"
//       Elevated only. Shows the Windows credential box on the SECURE desktop (CredUIPromptForWindowsCredentials with
//       CREDUIWIN_SECURE_PROMPT: the desktop of UAC, which a medium-integrity process can neither draw on nor read), the user name
//       pre-filled with the Owner; the account given must resolve (LookupAccountName) to the node profile's ownerSid. The password is
//       unpacked into a fixed unmanaged buffer, copied into a BSTR, and handed as VARIANT(BSTR) straight to
//       ITaskFolder::RegisterTaskDefinition(..., TASK_LOGON_PASSWORD, sddl) through the interface's own vtable (never a managed string);
//       the buffer, the BSTR and the packed credential are zeroed right after. Nothing of it reaches PowerShell, a file, a plan, a receipt,
//       a log, an environment variable or a command line. The output is one line of JSON with a code only: REGISTERED,
//       CREDENTIAL_NOT_GIVEN, ACCOUNT_MISMATCH, LOGON_REJECTED, ...
//   CluedCompanionTaskRegistrar.exe token-facts <pid>
//       Elevated only. The real token of one process, for rearm-resident.ps1's qualification (read from the elevated side, never the
//       process's own report): user SID, elevation type, whether Administrators is deny-only, session id and image path.
//   CluedCompanionTaskRegistrar.exe vtable-selftest
//       Read-only: proves the vtable slots this program calls by reading the root folder's Path (slot 8) and asking for a task that
//       does not exist (GetTask, slot 13). RegistrarPureTests.cs runs it offline.
//
// Compiled by install-resident.ps1 into the admin-only bin\ (/noconfig, full reference paths, winexe: the codes go to stdout).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class RegistrarCore {
  public const string FixedRoot = @"C:\ProgramData\CluedIndependentCI\resident";
  public const string TaskFolder = @"\Clued";
  public const string TaskName = "CluedCIResidentCompanion";
  public const string Contract = "clued.independent-ci.companion-registrar/1";
  static readonly Regex Sid = new Regex(@"\AS-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z");
  public static bool ValidSid(string s) { return s != null && Sid.IsMatch(s); }
  // The task's protection (DESIGN §65.4.1): SYSTEM and Administrators full, the Owner read only (no execute: the Owner's session
  // cannot Run it again and again to lock the account; the notifier can still read State and LastTaskResult).
  public static string TaskSddl(string ownerSid) { return "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;" + ownerSid + ")"; }
  public static string SupervisorPath(string root) { return root + @"\bin\CluedCompanionSupervisor.exe"; }
  public static string SupervisorArguments(string root) { return "\"" + root + "\""; }
  static string X(string s) { return System.Security.SecurityElement.Escape(s); }
  // The password task (DESIGN §65.4.1): a boot trigger 30 s after start and a time trigger repeated every 15 minutes for ever; no
  // log-on trigger, no restart on failure (the supervisor restarts the child); IgnoreNew; no time limit; never stopped on battery.
  public static string PasswordTaskXml(string root, string ownerSid) {
    if (!ValidSid(ownerSid)) throw new ArgumentException("OWNER_SID_INVALID");
    return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
      + "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
      + "<RegistrationInfo><Description>Clued CI resident companion (supervisor). DESIGN 65.</Description></RegistrationInfo>"
      + "<Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>"
      + "<TimeTrigger><Enabled>true</Enabled><StartBoundary>2026-01-01T00:00:00</StartBoundary><Repetition><Interval>PT15M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger></Triggers>"
      + "<Principals><Principal id=\"Author\"><UserId>" + X(ownerSid) + "</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>"
      + "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
      + "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>"
      + "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>"
      + "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>"
      + "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>"
      + "<Actions Context=\"Author\"><Exec><Command>" + X(SupervisorPath(root)) + "</Command><Arguments>" + X(SupervisorArguments(root)) + "</Arguments></Exec></Actions>"
      + "</Task>";
  }
  // HRESULTs of RegisterTaskDefinition -> the code printed. The Task Scheduler checks the password when it registers a password task.
  public static string RegisterCode(int hr) {
    switch ((uint)hr) {
      case 0: return "REGISTERED";
      case 0x8007052E: return "LOGON_REJECTED";
      case 0x8007052F: return "LOGON_REJECTED_ACCOUNT_RESTRICTION";
      case 0x80070530: return "LOGON_REJECTED_LOGON_HOURS";
      case 0x80070531: return "LOGON_REJECTED_WORKSTATION";
      case 0x80070701: return "LOGON_REJECTED_ACCOUNT_EXPIRED";
      case 0x80070773: return "LOGON_REJECTED_PASSWORD_MUST_CHANGE";
      case 0x80070532: return "LOGON_REJECTED_PASSWORD_EXPIRED";
      case 0x80070533: return "LOGON_REJECTED_ACCOUNT_DISABLED";
      case 0x80070569: return "LOGON_REJECTED_RIGHT_NOT_GRANTED";
      case 0x80070775: return "LOGON_REJECTED_ACCOUNT_LOCKED";
      case 0x80070005: return "REGISTER_ACCESS_DENIED";
      default: return "REGISTER_FAILED";
    }
  }
  // The account the credential box returned, as "DOMAIN\user" (or a bare user, read as this computer's).
  public static string QualifiedAccount(string user, string domain, string machine) {
    if (string.IsNullOrEmpty(user)) return null;
    if (user.IndexOf('\\') >= 0) return user;
    if (user.IndexOf('@') >= 0) return user;   // a UPN: LookupAccountName resolves it, and a Microsoft account is then refused by SID
    return (string.IsNullOrEmpty(domain) ? machine : domain) + "\\" + user;
  }
  // The output: a code, and at most a hex HRESULT or a task XML hash. Never text from the box.
  public static string Output(string code, string detail) {
    Dictionary<string, object> v = new Dictionary<string, object>();
    v["contract"] = Contract; v["code"] = code;
    if (detail != null && Regex.IsMatch(detail, @"\A[0-9A-Za-z_.:-]{1,80}\z")) v["detail"] = detail;
    return new JavaScriptSerializer().Serialize(v);
  }
  public static string Sha256Text(string t) {
    using (SHA256 h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(t))).Replace("-", "").ToLowerInvariant();
  }
  // The node profile's owner SID from record\acceptance.json (admin-only; the install wrote it).
  public static string OwnerSidFromAcceptance(string json) {
    Dictionary<string, object> d = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
    object node; Dictionary<string, object> n;
    if (d == null || !d.TryGetValue("node", out node) || (n = node as Dictionary<string, object>) == null) return null;
    object sid; return n.TryGetValue("ownerSid", out sid) && ValidSid(sid as string) ? (string)sid : null;
  }
}

[StructLayout(LayoutKind.Sequential)]
public struct ComVariant {
  public ushort vt, r1, r2, r3;
  public IntPtr p1, p2;
  public static ComVariant Bstr(IntPtr b) { ComVariant v = new ComVariant(); v.vt = 8; v.p1 = b; return v; }
  public static ComVariant Empty() { return new ComVariant(); }
}

public static class CluedCompanionTaskRegistrar {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetDefaultDllDirectories(uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct CREDUI_INFO { public int cbSize; public IntPtr hwndParent; public string pszMessageText, pszCaptionText; public IntPtr hbmBanner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)] static extern int CredUIPromptForWindowsCredentialsW(ref CREDUI_INFO info, int authError, ref uint package, IntPtr inBuf, uint inSize, out IntPtr outBuf, out uint outSize, ref bool save, uint flags);
  [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredPackAuthenticationBufferW(uint flags, string user, string password, IntPtr packed, ref uint size);
  [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredUnpackAuthenticationBufferW(uint flags, IntPtr buf, uint size, StringBuilder user, ref uint userLen, StringBuilder domain, ref uint domainLen, IntPtr password, ref uint passwordLen);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  [DllImport("oleaut32.dll")] static extern IntPtr SysAllocStringLen(IntPtr s, uint len);
  [DllImport("oleaut32.dll")] static extern void SysFreeString(IntPtr b);
  [DllImport("oleaut32.dll")] static extern uint SysStringByteLen(IntPtr b);
  [DllImport("kernel32.dll", EntryPoint = "RtlZeroMemory")] static extern void ZeroMemory(IntPtr p, UIntPtr len);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupAccountNameW(string system, string account, byte[] sid, ref uint sidLen, StringBuilder domain, ref uint domainLen, out int use);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, int coinit);
  [DllImport("ole32.dll")] static extern int CoInitializeSecurity(IntPtr sd, int auth, IntPtr svc, IntPtr reserved, int authnLevel, int impLevel, IntPtr authList, int caps, IntPtr reserved3);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetPathFn(IntPtr self, out IntPtr bstr);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetTaskFn(IntPtr self, IntPtr bstrPath, out IntPtr task);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int RegisterTaskDefinitionFn(IntPtr self, IntPtr bstrPath, IntPtr definition, int flags, ComVariant userId, ComVariant password, int logonType, ComVariant sddl, out IntPtr task);
  static readonly Guid IidTaskFolder = new Guid("8cfac062-a080-4c15-9a88-aa7c2af80dfc");
  static readonly Guid IidTaskDefinition = new Guid("f5bc8fc5-536d-4f77-b852-fbc1356fdeb6");
  // ITaskFolder : IDispatch (taskschd.idl): IUnknown 0-2, IDispatch 3-6, Name 7, Path 8, GetFolder 9, GetFolders 10, CreateFolder 11,
  // DeleteFolder 12, GetTask 13, GetTasks 14, DeleteTask 15, RegisterTask 16, RegisterTaskDefinition 17.
  const int SlotPath = 8, SlotGetTask = 13, SlotRegisterTaskDefinition = 17;
  static T Slot<T>(IntPtr itf, int slot) where T : class {
    IntPtr vtbl = Marshal.ReadIntPtr(itf);
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size), typeof(T)) as T;
  }
  static object Call(object o, string name, params object[] a) { return o.GetType().InvokeMember(name, System.Reflection.BindingFlags.InvokeMethod, null, o, a); }
  static object Get(object o, string name) { return o.GetType().InvokeMember(name, System.Reflection.BindingFlags.GetProperty, null, o, null); }
  static void Set(object o, string name, object v) { o.GetType().InvokeMember(name, System.Reflection.BindingFlags.SetProperty, null, o, new[] { v }); }
  static object Service() { object s = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true)); Call(s, "Connect"); return s; }
  static IntPtr Qi(object rcw, Guid iid) {
    IntPtr unk = Marshal.GetIUnknownForObject(rcw), itf;
    try { if (Marshal.QueryInterface(unk, ref iid, out itf) != 0) throw new InvalidOperationException("QI"); } finally { Marshal.Release(unk); }
    return itf;
  }

  static void Print(string code, string detail) { Console.Out.WriteLine(RegistrarCore.Output(code, detail)); }

  [STAThread]
  static int Main(string[] args) {
    try { SetDefaultDllDirectories(0x800); } catch { }
    try {
      if (args.Length == 1 && args[0] == "vtable-selftest") return VtableSelfTest();
      if (!Elevated()) { Print("REGISTRAR_ELEVATION_REQUIRED", null); return 2; }
      if (args.Length == 2 && args[0] == "register-password" && string.Equals(args[1], RegistrarCore.FixedRoot, StringComparison.OrdinalIgnoreCase)) return RegisterPassword(RegistrarCore.FixedRoot);
      int pid;
      if (args.Length == 2 && args[0] == "token-facts" && int.TryParse(args[1], out pid) && pid > 0) return TokenFacts(pid);
      Print("REGISTRAR_ARGS_REFUSED", null); return 2;
    } catch (Exception) { Print("REGISTRAR_UNEXPECTED", null); return 1; }
  }

  static bool Elevated() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return false;
    try {
      IntPtr b = Marshal.AllocHGlobal(4); int got;
      try { return GetTokenInformation(token, 18, b, 4, out got) && Marshal.ReadInt32(b) == 2; } finally { Marshal.FreeHGlobal(b); }
    } finally { CloseHandle(token); }
  }

  static string SidOf(string account) {
    uint sidLen = 0, domLen = 0; int use;
    LookupAccountNameW(null, account, null, ref sidLen, null, ref domLen, out use);
    if (sidLen == 0 || sidLen > 256 || domLen > 1024) return null;
    byte[] sid = new byte[sidLen]; StringBuilder dom = new StringBuilder((int)domLen + 1);
    if (!LookupAccountNameW(null, account, sid, ref sidLen, dom, ref domLen, out use)) return null;
    return new SecurityIdentifier(sid, 0).Value;
  }

  static int RegisterPassword(string root) {
    string ownerSid = RegistrarCore.OwnerSidFromAcceptance(System.IO.File.ReadAllText(root + @"\record\acceptance.json", new UTF8Encoding(false, true)));
    if (ownerSid == null) { Print("NODE_PROFILE_UNREADABLE", null); return 2; }
    string ownerAccount = new SecurityIdentifier(ownerSid).Translate(typeof(NTAccount)).Value;
    // The definition first (no secret in it), through the scripting interface; the folder's vtable only for the one call with the password.
    object svc = Service();
    object folder;
    try { folder = Call(svc, "GetFolder", RegistrarCore.TaskFolder); } catch { Print("TASK_FOLDER_MISSING", null); return 2; }
    object def = Call(svc, "NewTask", 0);
    Set(def, "XmlText", RegistrarCore.PasswordTaskXml(root, ownerSid));

    const uint CRED_PACK_PROTECTED_CREDENTIALS = 0x1, CREDUIWIN_IN_CRED_ONLY = 0x20, CREDUIWIN_SECURE_PROMPT = 0x1000;
    IntPtr inBuf = IntPtr.Zero, outBuf = IntPtr.Zero, pw = IntPtr.Zero, bstr = IntPtr.Zero, pFolder = IntPtr.Zero, pDef = IntPtr.Zero, pTask = IntPtr.Zero;
    uint inSize = 0, outSize = 0;
    const int PwChars = 512;
    try {
      CredPackAuthenticationBufferW(0, ownerAccount, "", IntPtr.Zero, ref inSize);
      if (inSize == 0 || inSize > 65536) { Print("CREDENTIAL_PREFILL_FAILED", null); return 1; }
      inBuf = Marshal.AllocCoTaskMem((int)inSize);
      if (!CredPackAuthenticationBufferW(0, ownerAccount, "", inBuf, ref inSize)) { Print("CREDENTIAL_PREFILL_FAILED", null); return 1; }
      CREDUI_INFO ui = new CREDUI_INFO();
      ui.cbSize = Marshal.SizeOf(typeof(CREDUI_INFO));
      ui.pszCaptionText = "Clued companion";
      ui.pszMessageText = "Enter your own Windows password for " + ownerAccount + ". The Task Scheduler keeps it for the companion task (DESIGN 65). This box is on the secure desktop: you started this yourself and approved UAC.";
      uint package = 0; bool save = false;
      int rc = CredUIPromptForWindowsCredentialsW(ref ui, 0, ref package, inBuf, inSize, out outBuf, out outSize, ref save, CREDUIWIN_IN_CRED_ONLY | CREDUIWIN_SECURE_PROMPT);
      if (rc == 1223) { Print("CREDENTIAL_NOT_GIVEN", null); return 3; }
      if (rc != 0 || outBuf == IntPtr.Zero) { Print("CREDENTIAL_PROMPT_FAILED", "0x" + rc.ToString("X")); return 1; }
      StringBuilder user = new StringBuilder(514), domain = new StringBuilder(514);
      uint userLen = 513, domainLen = 513, pwLen = PwChars;
      pw = Marshal.AllocHGlobal(PwChars * 2);
      ZeroMemory(pw, new UIntPtr(PwChars * 2));
      if (!CredUnpackAuthenticationBufferW(CRED_PACK_PROTECTED_CREDENTIALS, outBuf, outSize, user, ref userLen, domain, ref domainLen, pw, ref pwLen) || pwLen == 0 || pwLen > PwChars) {
        Print("CREDENTIAL_UNPACK_FAILED", null); return 1;
      }
      string account = RegistrarCore.QualifiedAccount(user.ToString(), domain.ToString(), Environment.MachineName);
      string sid = account == null ? null : SidOf(account);
      if (sid == null || sid != ownerSid) { Print("ACCOUNT_MISMATCH", null); return 2; }
      // pwLen counts the terminating NUL when there is one.
      uint chars = pwLen;
      if (chars > 0 && Marshal.ReadInt16(pw, (int)(chars - 1) * 2) == 0) chars -= 1;
      if (chars == 0) { Print("PASSWORD_EMPTY_REFUSED", null); return 2; }
      bstr = SysAllocStringLen(pw, chars);
      ZeroMemory(pw, new UIntPtr(PwChars * 2));
      if (bstr == IntPtr.Zero) { Print("REGISTER_FAILED", "BSTR"); return 1; }
      pFolder = Qi(folder, IidTaskFolder);
      pDef = Qi(def, IidTaskDefinition);
      IntPtr name = Marshal.StringToBSTR(RegistrarCore.TaskName), user2 = Marshal.StringToBSTR(ownerAccount), sddl = Marshal.StringToBSTR(RegistrarCore.TaskSddl(ownerSid));
      int hr;
      try {
        hr = Slot<RegisterTaskDefinitionFn>(pFolder, SlotRegisterTaskDefinition)(pFolder, name, pDef, 6, ComVariant.Bstr(user2), ComVariant.Bstr(bstr), 1, ComVariant.Bstr(sddl), out pTask);
      } finally { Marshal.FreeBSTR(name); Marshal.FreeBSTR(user2); Marshal.FreeBSTR(sddl); }
      ZeroMemory(bstr, new UIntPtr(chars * 2)); SysFreeString(bstr); bstr = IntPtr.Zero;
      string code = RegistrarCore.RegisterCode(hr);
      if (hr != 0) { Print(code, "0x" + hr.ToString("X8")); return 1; }
      // Read back through the scripting interface: the password logon, the Owner, not elevated, the one fixed action.
      object task = Call(folder, "GetTask", RegistrarCore.TaskName);
      object d2 = Get(task, "Definition"), pr = Get(d2, "Principal"), acts = Get(d2, "Actions");
      object a = (int)Get(acts, "Count") == 1 ? Get(acts, "Item", 1) : null;
      string uid = (string)Get(pr, "UserId");
      string uidSid = uid != null && uid.StartsWith("S-1-") ? uid : SidOf(uid);
      if ((int)Get(pr, "LogonType") != 1 || (int)Get(pr, "RunLevel") != 0 || uidSid != ownerSid || a == null
        || !string.Equals((string)Get(a, "Path"), RegistrarCore.SupervisorPath(root), StringComparison.Ordinal) || (string)Get(a, "Arguments") != RegistrarCore.SupervisorArguments(root)) {
        Print("REGISTER_READBACK_MISMATCH", null); return 1;
      }
      Print("REGISTERED", RegistrarCore.Sha256Text((string)Get(task, "Xml")));
      return 0;
    } finally {
      if (pw != IntPtr.Zero) { ZeroMemory(pw, new UIntPtr(PwChars * 2)); Marshal.FreeHGlobal(pw); }
      // Review MINOR 3: a BSTR still held here (an exception between its allocation and the call) is zeroed before it is freed.
      if (bstr != IntPtr.Zero) { ZeroMemory(bstr, new UIntPtr(SysStringByteLen(bstr))); SysFreeString(bstr); }
      if (outBuf != IntPtr.Zero) { ZeroMemory(outBuf, new UIntPtr(outSize)); CoTaskMemFree(outBuf); }
      if (inBuf != IntPtr.Zero) { ZeroMemory(inBuf, new UIntPtr(inSize)); Marshal.FreeCoTaskMem(inBuf); }
      if (pTask != IntPtr.Zero) Marshal.Release(pTask);
      if (pDef != IntPtr.Zero) Marshal.Release(pDef);
      if (pFolder != IntPtr.Zero) Marshal.Release(pFolder);
    }
  }
  static object Get(object o, string name, object index) { return o.GetType().InvokeMember(name, System.Reflection.BindingFlags.GetProperty, null, o, new[] { index }); }

  static int VtableSelfTest() {
    object svc = Service();
    object root = Call(svc, "GetFolder", @"\");
    IntPtr p = Qi(root, IidTaskFolder);
    try {
      IntPtr b;
      int hr = Slot<GetPathFn>(p, SlotPath)(p, out b);
      string path = hr == 0 ? Marshal.PtrToStringBSTR(b) : null;
      if (hr == 0) Marshal.FreeBSTR(b);
      IntPtr name = Marshal.StringToBSTR("clued-no-such-task-" + Guid.NewGuid().ToString("N")), t;
      int hr2;
      try { hr2 = Slot<GetTaskFn>(p, SlotGetTask)(p, name, out t); } finally { Marshal.FreeBSTR(name); }
      if (hr2 == 0 && t != IntPtr.Zero) Marshal.Release(t);
      bool ok = path == @"\" && (uint)hr2 == 0x80070002;
      Print(ok ? "VTABLE_OK" : "VTABLE_MISMATCH", "0x" + hr2.ToString("X8"));
      return ok ? 0 : 1;
    } finally { Marshal.Release(p); }
  }

  static int TokenFacts(int pid) {
    IntPtr proc = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (proc == IntPtr.Zero) { Print("PROCESS_UNREADABLE", null); return 1; }
    IntPtr token = IntPtr.Zero;
    try {
      StringBuilder image = new StringBuilder(1024); int size = image.Capacity;
      string imagePath = QueryFullProcessImageNameW(proc, 0, image, ref size) ? image.ToString() : null;
      if (!OpenProcessToken(proc, 0x0008, out token)) { Print("TOKEN_UNREADABLE", null); return 1; }
      int got;
      IntPtr b = Marshal.AllocHGlobal(4);
      int elevationType, session;
      try {
        if (!GetTokenInformation(token, 18, b, 4, out got)) { Print("TOKEN_UNREADABLE", null); return 1; }
        elevationType = Marshal.ReadInt32(b);
        if (!GetTokenInformation(token, 12, b, 4, out got)) { Print("TOKEN_UNREADABLE", null); return 1; }   // TokenSessionId
        session = Marshal.ReadInt32(b);
      } finally { Marshal.FreeHGlobal(b); }
      GetTokenInformation(token, 1, IntPtr.Zero, 0, out got);   // TokenUser
      IntPtr u = Marshal.AllocHGlobal(Math.Max(got, 16)); string userSid;
      try { if (!GetTokenInformation(token, 1, u, got, out got)) { Print("TOKEN_UNREADABLE", null); return 1; } userSid = new SecurityIdentifier(Marshal.ReadIntPtr(u)).Value; } finally { Marshal.FreeHGlobal(u); }
      GetTokenInformation(token, 2, IntPtr.Zero, 0, out got);   // TokenGroups
      if (got <= 0 || got > 1 << 20) { Print("TOKEN_UNREADABLE", null); return 1; }
      IntPtr g = Marshal.AllocHGlobal(got); long admins = -1;
      try {
        if (!GetTokenInformation(token, 2, g, got, out got)) { Print("TOKEN_UNREADABLE", null); return 1; }
        int count = Marshal.ReadInt32(g);
        for (int i = 0; i < count; i++) {
          IntPtr e = new IntPtr(g.ToInt64() + IntPtr.Size + (long)i * IntPtr.Size * 2);
          if (new SecurityIdentifier(Marshal.ReadIntPtr(e)).Value == "S-1-5-32-544") admins = (uint)Marshal.ReadInt32(new IntPtr(e.ToInt64() + IntPtr.Size));
        }
      } finally { Marshal.FreeHGlobal(g); }
      Dictionary<string, object> v = new Dictionary<string, object>();
      v["contract"] = RegistrarCore.Contract; v["code"] = "TOKEN_FACTS"; v["pid"] = pid; v["userSid"] = userSid; v["elevationType"] = elevationType;
      v["adminsPresent"] = admins >= 0; v["adminsDenyOnly"] = admins >= 0 && (admins & 0x10) != 0 && (admins & 0x4) == 0;
      v["sessionId"] = session; v["imagePath"] = imagePath;
      Console.Out.WriteLine(new JavaScriptSerializer().Serialize(v));
      return 0;
    } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(proc); }
  }
}
