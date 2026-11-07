// CluedCompanionSupervisor.exe (DESIGN §65.4.2, M5): the fixed action of the companion task "\Clued\CluedCIResidentCompanion".
//
//   CluedCompanionSupervisor.exe "C:\ProgramData\CluedIndependentCI\resident"
//
// Compiled by install-resident.ps1 into the admin-only bin\ (/noconfig, full reference paths, winexe), like the job host (§24). It
// carries no generation hash: the generation it starts is named by config\companion-launch.json, which only the installer and the
// upgrade channel write (atomically). It:
//   1. refuses an elevated token (SUPERVISOR_ELEVATED_TOKEN_REFUSED): a task set to "highest privileges" never runs the companion
//      with an administrator token;
//   2. reads the launch file through a handle that does not follow reparse points, after checking that no directory from the root to
//      it is a junction or symbolic link and that only SYSTEM and Administrators may change it; node.exe and companion-main.mjs are
//      opened the same way with FILE_SHARE_READ only, hashed through those handles and kept open until the child has started;
//   3. starts node with a whitelisted environment (no NODE_*, GIT_*, GH_* or PSModulePath of the task's environment; PATH set to the
//      system directories and the launch file's directories; GH_CONFIG_DIR and HOME set to the companion's own gh login), in a job
//      object of its own (KILL_ON_JOB_CLOSE), without a window;
//   4. restarts it after 5, 10, 20, 40 s and then every 60 s, never giving up; a run of 10 minutes clears the back-off, and a new
//      generation in the launch file starts at once (the upgrade channel ends the child and waits up to 90 s for the new one).
// supervisor.json in the Owner's %LOCALAPPDATA%\CluedIndependentCI is for people only (at most 50 exits); nothing decides on it.
// Only system DLLs are loaded (SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)).
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public sealed class SupervisorRefusal : Exception {
  public readonly string Code;
  public SupervisorRefusal(string code) : base(code) { Code = code; }
}

public sealed class LaunchSpec {
  public int Generation;
  public string NodeExe, NodeExeSha256, Entry, EntrySha256, ConfigSha256, GhConfigDir, HomeDir;
  public string[] PathDirs;
}

// Everything that decides, without touching the host: SupervisorPureTests.cs runs these.
public static class SupervisorCore {
  public const string FixedRoot = @"C:\ProgramData\CluedIndependentCI\resident";
  public const string LaunchContract = "clued.independent-ci.companion-launch/1";
  public static readonly string[] LaunchKeys = { "contract", "generation", "nodeExe", "nodeExeSha256", "entry", "entrySha256", "configSha256", "ghConfigDir", "homeDir", "pathDirs" };
  static readonly Regex Hex64 = new Regex(@"\A[0-9a-f]{64}\z");
  static readonly Regex Profile = new Regex(@"\AC:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z");
  static readonly Regex PathDir = new Regex(@"\A[A-Z]:\\[^;""%<>|*?\r\n\t\0]{1,200}\z");

  // Back-off after the n-th exit in a row (n >= 1): 5, 10, 20, 40, then 60 seconds for ever.
  public static int BackoffSeconds(int consecutiveExits) {
    if (consecutiveExits <= 0) return 0;
    if (consecutiveExits >= 5) return 60;
    return 5 << (consecutiveExits - 1);
  }
  public const int StableRunSeconds = 600;
  public static int NextConsecutive(int consecutiveExits, double ranSeconds) { return ranSeconds >= StableRunSeconds ? 1 : consecutiveExits + 1; }
  // The wait before the next start: none when the wait for the last exit was already served (a first start, a wait already slept)
  // or the launch file names a new generation; else the back-off.
  public static int DelayBeforeStart(bool waitServed, int lastGeneration, int generation, int consecutiveExits) {
    if (waitServed || generation != lastGeneration) return 0;
    return BackoffSeconds(consecutiveExits);
  }

  // The token rule: elevationType 2 (TokenElevationTypeFull) refuses; so does an Administrators group that is enabled and not
  // deny-only (UAC off). adminsAttributes null: the token has no Administrators group (a standard user).
  public const uint SeGroupEnabled = 0x4, SeGroupUseForDenyOnly = 0x10;
  public static bool IsElevated(int elevationType, uint? adminsAttributes) {
    if (elevationType == 2) return true;
    if (adminsAttributes.HasValue && (adminsAttributes.Value & SeGroupEnabled) != 0 && (adminsAttributes.Value & SeGroupUseForDenyOnly) == 0) return true;
    return false;
  }

  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as string : null; }
  static bool SamePath(string a, string b) { return a != null && b != null && string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }

  // The launch file, parsed and checked against the root and this user's profile. Refusal codes only, never the text.
  public static LaunchSpec ParseLaunch(string json, string root, string userProfile) {
    Dictionary<string, object> d;
    try { d = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; } catch { throw new SupervisorRefusal("LAUNCH_FILE_NOT_JSON"); }
    if (d == null || d.Count != LaunchKeys.Length) throw new SupervisorRefusal("LAUNCH_FILE_KEYS");
    foreach (string k in LaunchKeys) if (!d.ContainsKey(k)) throw new SupervisorRefusal("LAUNCH_FILE_KEYS");
    if (Str(d, "contract") != LaunchContract) throw new SupervisorRefusal("LAUNCH_FILE_CONTRACT");
    if (!(d["generation"] is int) || (int)d["generation"] < 1) throw new SupervisorRefusal("LAUNCH_FILE_GENERATION");
    LaunchSpec s = new LaunchSpec();
    s.Generation = (int)d["generation"];
    s.NodeExe = Str(d, "nodeExe"); s.Entry = Str(d, "entry");
    s.NodeExeSha256 = Str(d, "nodeExeSha256"); s.EntrySha256 = Str(d, "entrySha256"); s.ConfigSha256 = Str(d, "configSha256");
    s.GhConfigDir = Str(d, "ghConfigDir"); s.HomeDir = Str(d, "homeDir");
    if (!SamePath(s.NodeExe, root + @"\runtime\node.exe")) throw new SupervisorRefusal("LAUNCH_FILE_NODE");
    if (s.Entry == null || !Regex.IsMatch(s.Entry, @"\A" + Regex.Escape(root) + @"\\resident\\[0-9a-f]{64}\\src\\companion-main\.mjs\z")) throw new SupervisorRefusal("LAUNCH_FILE_ENTRY");
    foreach (string h in new[] { s.NodeExeSha256, s.EntrySha256, s.ConfigSha256 }) if (h == null || !Hex64.IsMatch(h)) throw new SupervisorRefusal("LAUNCH_FILE_HASH");
    if (userProfile == null || !Profile.IsMatch(userProfile)) throw new SupervisorRefusal("SUPERVISOR_PROFILE_UNREADABLE");
    string gh = userProfile + @"\AppData\Local\CluedIndependentCI\companion-gh";
    if (!SamePath(s.GhConfigDir, gh + @"\gh") || !SamePath(s.HomeDir, gh + @"\home")) throw new SupervisorRefusal("LAUNCH_FILE_GH_CONFIG");
    object[] dirs = d["pathDirs"] as object[];
    if (dirs == null) { ArrayList al = d["pathDirs"] as ArrayList; if (al != null) dirs = al.ToArray(); }
    if (dirs == null || dirs.Length > 8) throw new SupervisorRefusal("LAUNCH_FILE_PATH_DIRS");
    s.PathDirs = new string[dirs.Length];
    for (int i = 0; i < dirs.Length; i++) {
      string p = dirs[i] as string;
      if (p == null || !PathDir.IsMatch(p)) throw new SupervisorRefusal("LAUNCH_FILE_PATH_DIRS");
      s.PathDirs[i] = p;
    }
    return s;
  }

  // The directories from the root down to the file's parent, root first: each must be a real directory (no reparse point).
  public static List<string> ChainOf(string root, string file) {
    if (!file.StartsWith(root + @"\", StringComparison.OrdinalIgnoreCase)) throw new SupervisorRefusal("LAUNCH_PATH_OUTSIDE_ROOT");
    List<string> chain = new List<string>();
    chain.Add(root);
    string rest = file.Substring(root.Length + 1);
    string[] parts = rest.Split('\\');
    string at = root;
    for (int i = 0; i < parts.Length - 1; i++) {
      if (parts[i].Length == 0 || parts[i] == "." || parts[i] == "..") throw new SupervisorRefusal("LAUNCH_PATH_REFUSED");
      at = at + @"\" + parts[i];
      chain.Add(at);
    }
    return chain;
  }

  // The access mask bits that change an object or what is in it.
  public const int WriteMask = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;
  public static readonly string[] TrustedSids = { "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
  public static bool Trusted(string sid) { return Array.IndexOf(TrustedSids, sid) >= 0; }
  // owner: the object's owner SID; aces: (sid, allow, mask, inheritOnly). Only SYSTEM or Administrators own it, and no allow entry
  // that applies to the object gives anyone else a right that changes it.
  public static string AclRefusal(string owner, IEnumerable<KeyValuePair<string, int[]>> aces) {
    if (owner != "S-1-5-18" && owner != "S-1-5-32-544") return "LAUNCH_ACL_OWNER";
    foreach (KeyValuePair<string, int[]> a in aces) {
      bool allow = a.Value[0] == 1, inheritOnly = a.Value[2] == 1;
      if (!allow || inheritOnly || Trusted(a.Key)) continue;
      if ((a.Value[1] & WriteMask) != 0) return "LAUNCH_ACL_WRITABLE";
    }
    return null;
  }

  // Which variables of the task's environment the child keeps (names compared case-insensitively).
  static readonly string[] KeepExact = { "SystemRoot", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
    "USERNAME", "USERDOMAIN", "COMPUTERNAME", "TEMP", "TMP", "ProgramData", "NUMBER_OF_PROCESSORS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "OS" };
  public static bool KeepVariable(string name) {
    if (string.IsNullOrEmpty(name)) return false;
    foreach (string k in KeepExact) if (string.Equals(name, k, StringComparison.OrdinalIgnoreCase)) return true;
    if (name.StartsWith("ProgramFiles", StringComparison.OrdinalIgnoreCase) || name.StartsWith("CommonProgramFiles", StringComparison.OrdinalIgnoreCase) || name.StartsWith("ProgramW6432", StringComparison.OrdinalIgnoreCase)) return true;
    if (name.StartsWith("PROCESSOR_", StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }
  public static readonly string[] SystemPath = { @"C:\Windows\System32", @"C:\Windows", @"C:\Windows\System32\Wbem", @"C:\Windows\System32\WindowsPowerShell\v1.0" };
  // The child's whole environment: the kept variables of `parent`, PATH, GH_CONFIG_DIR and HOME. Sorted (CreateProcess wants it so).
  public static SortedDictionary<string, string> ChildEnvironment(IDictionary parent, LaunchSpec spec) {
    SortedDictionary<string, string> env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (DictionaryEntry e in parent) {
      string k = e.Key as string, v = e.Value as string;
      if (k == null || v == null || k.IndexOf('=') >= 0 || v.IndexOf('\0') >= 0 || !KeepVariable(k)) continue;
      env[k] = v;
    }
    List<string> path = new List<string>(SystemPath);
    path.AddRange(spec.PathDirs);
    env["PATH"] = string.Join(";", path.ToArray());
    env["GH_CONFIG_DIR"] = spec.GhConfigDir;
    env["HOME"] = spec.HomeDir;
    return env;
  }
  public static string EnvironmentBlock(SortedDictionary<string, string> env) {
    StringBuilder b = new StringBuilder();
    foreach (KeyValuePair<string, string> kv in env) b.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
    b.Append('\0');
    return b.ToString();
  }
  // "<node>" "<entry>" --root "<root>" --config-sha256 <sha>: the command line upgrade-apply.ps1 Test-CompanionCommandLine accepts.
  public static string CommandLine(LaunchSpec s, string root) {
    return "\"" + s.NodeExe + "\" \"" + s.Entry + "\" --root \"" + root + "\" --config-sha256 " + s.ConfigSha256;
  }

  // supervisor.json: the newest exits (at most 50), for people only.
  public static List<Dictionary<string, object>> AppendExit(List<Dictionary<string, object>> exits, Dictionary<string, object> exit) {
    List<Dictionary<string, object>> o = new List<Dictionary<string, object>>(exits ?? new List<Dictionary<string, object>>());
    o.Add(exit);
    while (o.Count > 50) o.RemoveAt(0);
    return o;
  }
}

// The host side: the token, the files, the child.
public static class CluedCompanionSupervisor {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetDefaultDllDirectories(uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFileAttributesW(string name);
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION { public uint Attributes; public long Created, Accessed, Written; public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string reserved, desktop, title; public int x, y, xSize, ySize, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, string env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  const uint GENERIC_READ = 0x80000000, FILE_SHARE_READ = 1, OPEN_EXISTING = 3, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400, INVALID_ATTRIBUTES = 0xFFFFFFFF;

  public static int Main(string[] args) {
    try { SetDefaultDllDirectories(0x800); } catch { }
    string root = args.Length == 1 ? args[0] : null;
    if (root == null || !string.Equals(root, SupervisorCore.FixedRoot, StringComparison.OrdinalIgnoreCase)) { Record(null, "SUPERVISOR_ARGS_REFUSED", null); return 2; }
    root = SupervisorCore.FixedRoot;
    string refusal = TokenRefusal();
    if (refusal != null) { Record(null, refusal, null); return 3; }
    IntPtr job = NewKillOnCloseJob();
    if (job == IntPtr.Zero) { Record(null, "SUPERVISOR_JOB_FAILED", null); return 3; }
    int lastGeneration = 0, consecutive = 0;
    bool waitServed = true;
    List<Dictionary<string, object>> exits = new List<Dictionary<string, object>>();
    for (;;) {
      LaunchSpec spec = null;
      List<FileStream> held = new List<FileStream>();
      try {
        spec = OpenLaunch(root, held);
      } catch (SupervisorRefusal r) {
        foreach (FileStream f in held) f.Dispose();
        consecutive += 1;
        Record(exits, r.Code, null);
        Thread.Sleep(SupervisorCore.BackoffSeconds(consecutive) * 1000);
        waitServed = true;
        continue;
      } catch (Exception) {
        foreach (FileStream f in held) f.Dispose();
        consecutive += 1;
        Record(exits, "LAUNCH_UNREADABLE", null);
        Thread.Sleep(SupervisorCore.BackoffSeconds(consecutive) * 1000);
        waitServed = true;
        continue;
      }
      int delay = SupervisorCore.DelayBeforeStart(waitServed, lastGeneration, spec.Generation, consecutive);
      if (delay > 0) {
        // The files are read again after the wait (they may change meanwhile); the wait for this exit is then served.
        foreach (FileStream f in held) f.Dispose();
        Thread.Sleep(delay * 1000);
        waitServed = true;
        continue;
      }
      waitServed = false;
      lastGeneration = spec.Generation;
      DateTime started = DateTime.UtcNow;
      uint exitCode;
      string startFailure = null;
      try { exitCode = RunChild(job, spec, root, held); }
      catch (SupervisorRefusal r) { startFailure = r.Code; exitCode = 0xFFFFFFFF; }
      finally { foreach (FileStream f in held) f.Dispose(); }
      double ran = (DateTime.UtcNow - started).TotalSeconds;
      consecutive = SupervisorCore.NextConsecutive(consecutive, ran);
      Dictionary<string, object> e = new Dictionary<string, object>();
      e["at"] = DateTime.UtcNow.ToString("o"); e["exitCode"] = (long)exitCode; e["ranSeconds"] = (long)ran; e["generation"] = spec.Generation;
      if (startFailure != null) e["failure"] = startFailure;
      exits = SupervisorCore.AppendExit(exits, e);
      Record(exits, null, spec.Generation);
      // The next round reads the launch file again: a new generation starts at once (DelayBeforeStart), the same one after the back-off.
    }
  }

  // ---- token ----
  static string TokenRefusal() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return "SUPERVISOR_TOKEN_UNREADABLE";
    try {
      IntPtr buf = Marshal.AllocHGlobal(4); int got;
      int elevationType;
      try {
        if (!GetTokenInformation(token, 18, buf, 4, out got)) return "SUPERVISOR_TOKEN_UNREADABLE";
        elevationType = Marshal.ReadInt32(buf);
      } finally { Marshal.FreeHGlobal(buf); }
      uint? admins = null;
      GetTokenInformation(token, 2, IntPtr.Zero, 0, out got);
      if (got <= 0 || got > 1 << 20) return "SUPERVISOR_TOKEN_UNREADABLE";
      IntPtr groups = Marshal.AllocHGlobal(got);
      try {
        if (!GetTokenInformation(token, 2, groups, got, out got)) return "SUPERVISOR_TOKEN_UNREADABLE";
        int count = Marshal.ReadInt32(groups);
        int size = IntPtr.Size * 2;   // SID_AND_ATTRIBUTES: PSID, DWORD (padded)
        for (int i = 0; i < count; i++) {
          IntPtr entry = new IntPtr(groups.ToInt64() + IntPtr.Size + (long)i * size);
          IntPtr sid = Marshal.ReadIntPtr(entry);
          uint attributes = (uint)Marshal.ReadInt32(new IntPtr(entry.ToInt64() + IntPtr.Size));
          if (new SecurityIdentifier(sid).Value == "S-1-5-32-544") admins = attributes;
        }
      } finally { Marshal.FreeHGlobal(groups); }
      return SupervisorCore.IsElevated(elevationType, admins) ? "SUPERVISOR_ELEVATED_TOKEN_REFUSED" : null;
    } finally { CloseHandle(token); }
  }

  // ---- files ----
  // A real directory: present, a directory, not a junction or symbolic link (SupervisorPureTests.cs runs this on a real junction).
  public static void AssertNoReparse(string dir) {
    uint a = GetFileAttributesW(dir);
    if (a == INVALID_ATTRIBUTES || (a & ATTR_DIRECTORY) == 0) throw new SupervisorRefusal("LAUNCH_PATH_MISSING");
    if ((a & ATTR_REPARSE) != 0) throw new SupervisorRefusal("LAUNCH_PATH_REPARSE_POINT");
  }
  public static void AssertNoReparseChain(string root, string file) { foreach (string dir in SupervisorCore.ChainOf(root, file)) AssertNoReparse(dir); }
  static void AssertRealDirectory(string dir) {
    AssertNoReparse(dir);
    AssertAcl(Directory.GetAccessControl(dir, AccessControlSections.Owner | AccessControlSections.Access));
  }
  static void AssertAcl(FileSystemSecurity sec) {
    string owner = sec.GetOwner(typeof(SecurityIdentifier)).Value;
    List<KeyValuePair<string, int[]>> aces = new List<KeyValuePair<string, int[]>>();
    foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
      aces.Add(new KeyValuePair<string, int[]>(r.IdentityReference.Value, new[] { r.AccessControlType == AccessControlType.Allow ? 1 : 0, (int)r.FileSystemRights, (r.PropagationFlags & PropagationFlags.InheritOnly) != 0 ? 1 : 0 }));
    string why = SupervisorCore.AclRefusal(owner, aces);
    if (why != null) throw new SupervisorRefusal(why);
  }
  // One file under the root: every directory on the way checked, opened without following a reparse point, FILE_SHARE_READ only.
  static FileStream OpenChecked(string root, string file) {
    foreach (string dir in SupervisorCore.ChainOf(root, file)) AssertRealDirectory(dir);
    SafeFileHandle h = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (h.IsInvalid) throw new SupervisorRefusal("LAUNCH_FILE_UNOPENED");
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(h, out info) || (info.Attributes & (ATTR_REPARSE | ATTR_DIRECTORY)) != 0) { h.Dispose(); throw new SupervisorRefusal("LAUNCH_FILE_REPARSE_POINT"); }
    FileStream s = new FileStream(h, FileAccess.Read);
    try { AssertAcl(File.GetAccessControl(file, AccessControlSections.Owner | AccessControlSections.Access)); } catch { s.Dispose(); throw; }
    return s;
  }
  static string Sha256(FileStream s) {
    s.Position = 0;
    using (SHA256 h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
  }
  static LaunchSpec OpenLaunch(string root, List<FileStream> held) {
    string launchPath = root + @"\config\companion-launch.json";
    string json;
    using (FileStream l = OpenChecked(root, launchPath)) {
      if (l.Length < 2 || l.Length > 8192) throw new SupervisorRefusal("LAUNCH_FILE_SIZE");
      byte[] b = new byte[l.Length]; int at = 0;
      while (at < b.Length) { int n = l.Read(b, at, b.Length - at); if (n <= 0) throw new SupervisorRefusal("LAUNCH_FILE_SIZE"); at += n; }
      try { json = new UTF8Encoding(false, true).GetString(b); } catch { throw new SupervisorRefusal("LAUNCH_FILE_NOT_UTF8"); }
    }
    LaunchSpec spec = SupervisorCore.ParseLaunch(json, root, Environment.GetEnvironmentVariable("USERPROFILE"));
    FileStream node = OpenChecked(root, spec.NodeExe); held.Add(node);
    if (Sha256(node) != spec.NodeExeSha256) throw new SupervisorRefusal("LAUNCH_NODE_HASH");
    FileStream entry = OpenChecked(root, spec.Entry); held.Add(entry);
    if (Sha256(entry) != spec.EntrySha256) throw new SupervisorRefusal("LAUNCH_ENTRY_HASH");
    return spec;
  }

  // ---- job and child ----
  static IntPtr NewKillOnCloseJob() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: BasicLimitInformation.LimitFlags at offset 16 (x64: two LARGE_INTEGERs first).
    int size = IntPtr.Size == 8 ? 144 : 112;
    IntPtr info = Marshal.AllocHGlobal(size);
    try {
      for (int i = 0; i < size; i++) Marshal.WriteByte(info, i, 0);
      Marshal.WriteInt32(info, 16, 0x2000);   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no BREAKAWAY_OK
      if (!SetInformationJobObject(job, 9, info, size)) { CloseHandle(job); return IntPtr.Zero; }
    } finally { Marshal.FreeHGlobal(info); }
    return job;
  }
  static uint RunChild(IntPtr job, LaunchSpec spec, string root, List<FileStream> held) {
    string env = SupervisorCore.EnvironmentBlock(SupervisorCore.ChildEnvironment(Environment.GetEnvironmentVariables(), spec));
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW; no handle inherited.
    if (!CreateProcessW(spec.NodeExe, new StringBuilder(SupervisorCore.CommandLine(spec, root)), IntPtr.Zero, IntPtr.Zero, false, 0x4 | 0x400 | 0x08000000, env, @"C:\Windows\System32", ref si, out pi))
      throw new SupervisorRefusal("CHILD_CREATE_FAILED");
    try {
      if (!AssignProcessToJobObject(job, pi.process)) { TerminateProcess(pi.process, 1); throw new SupervisorRefusal("CHILD_JOB_FAILED"); }
      if (ResumeThread(pi.thread) == 0xFFFFFFFF) { TerminateProcess(pi.process, 1); throw new SupervisorRefusal("CHILD_RESUME_FAILED"); }
      // The child runs the bytes that were hashed: the handles are released only now.
      foreach (FileStream f in held) f.Dispose();
      held.Clear();
      WaitForSingleObject(pi.process, 0xFFFFFFFF);
      uint code;
      return GetExitCodeProcess(pi.process, out code) ? code : 0xFFFFFFFF;
    } finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
  }

  // ---- supervisor.json (people only) ----
  static void Record(List<Dictionary<string, object>> exits, string refusal, int? generation) {
    try {
      string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CluedIndependentCI");
      Directory.CreateDirectory(dir);
      Dictionary<string, object> v = new Dictionary<string, object>();
      v["contract"] = "clued.independent-ci.companion-supervisor/1";
      v["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
      v["sessionId"] = System.Diagnostics.Process.GetCurrentProcess().SessionId;
      v["at"] = DateTime.UtcNow.ToString("o");
      v["generation"] = generation;
      v["lastRefusal"] = refusal;
      v["exits"] = exits ?? new List<Dictionary<string, object>>();
      string file = Path.Combine(dir, "supervisor.json"), tmp = file + ".tmp";
      File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(v), new UTF8Encoding(false));
      if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
    } catch { }
  }
}
