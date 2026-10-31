// CluedCIUpgrader service host (018da927 B2; DRAFT). Compiled once by install-resident.ps1 (step upgrader-host) with the in-box
// .NET Framework csc.exe from upgrader\bin\UpgraderServiceHost.cs; its SHA-256 is pinned in the install receipt (/6, upgrader.hostSha256).
// FROZEN with the upgrade channel: it changes only with a full reinstall (a package that changes it is refused by the upgrader with
// UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL).
//
// Runs as LocalSystem in Session 0 with the required privileges cut to SeChangeNotifyPrivilege (`sc privs`). It starts exactly one
// pinned node.exe (upgrader\runtime\node.exe) with the pinned upgrader-main.mjs and the config pin from its own command line
// (ROOT CONFIG_SHA NODE NODE_SHA ENTRY ENTRY_SHA), a fixed environment, no inherited handle (CreateProcessW, bInheritHandles FALSE)
// and inside a job object that ends with the host (kill on job close), so nothing the upgrader started outlives the service.
// At start it records the privileges its own token holds (upgrade\upgrader-token.json) and refuses to run with any other.
// On Stop it asks the upgrader to stop at its next step boundary (upgrade\STOP-REQUESTED, create-only) and ends the job after at most
// 60 s: every step of the upgrader is journaled and is re-observed on the next start (A4), so ending it is safe.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class UpgraderServiceHost : ServiceBase
{
    public const string Name = "CluedCIUpgrader";
    public static readonly string[] AllowedPrivileges = { "SeChangeNotifyPrivilege" };
    public const int StopWaitMilliseconds = 60000;
    public const int ShutdownWaitMilliseconds = 5000;
    readonly UpgraderArgs args;
    readonly UpgraderStopGate gate = new UpgraderStopGate();
    UpgraderChild child;

    internal UpgraderServiceHost(string[] a)
    {
        ServiceName = Name; CanStop = true; CanShutdown = true; AutoLog = true;
        args = UpgraderArgs.Parse(a);
    }

    static string Sha(string path)
    {
        using (var s = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
    }

    protected override void OnStart(string[] ignored)
    {
        // The real token, not the configuration: record it, then refuse anything beyond the allow-list.
        var privileges = UpgraderTokenPrivileges.Current();
        UpgraderStopGate.WriteReplace(args.TokenRecordFile, UpgraderTokenPrivileges.Json(privileges, System.Diagnostics.Process.GetCurrentProcess().Id) + "\n");
        if (UpgraderTokenPrivileges.Disallowed(privileges, AllowedPrivileges).Length > 0) throw new InvalidOperationException("UPGRADER_TOKEN_PRIVILEGES_NOT_MINIMAL");
        // Refuse to start on any drift of the runtime, the entry point or the configuration.
        if (Sha(args.NodeExe) != args.NodeSha || Sha(args.Entry) != args.EntrySha || Sha(args.ConfigFile) != args.ConfigSha) throw new InvalidOperationException("UPGRADER_RUNTIME_PIN_CHANGED");
        // A stop request left by an earlier host process (a crash, a shutdown) asked no upgrader of this process.
        UpgraderStopGate.ClearStale(args.StopFile);
        child = UpgraderChild.Start(args.NodeExe, args.CommandLine(), UpgraderArgs.EnvironmentBlock(), args.Root);
        var c = child;
        var watcher = new Thread(() =>
        {
            int code = c.WaitForExitCode();
            ExitCode = UpgraderStopGate.ServiceExitCode(code);
            // Exited on its own: stop the service (a non-zero exit is a failure, so the SCM's restart applies).
            if (gate.Take()) Stop();
        });
        watcher.IsBackground = true;
        watcher.Start();
    }

    protected override void OnStop() { End(StopWaitMilliseconds, true); }

    protected override void OnShutdown() { End(ShutdownWaitMilliseconds, false); }

    void End(int waitMs, bool more)
    {
        var c = child;
        if (c == null || !gate.Take()) return;   // never started, or the upgrader already exited on its own
        if (more) { try { RequestAdditionalTime(waitMs + 15000); } catch (InvalidOperationException) { } }
        UpgraderStopGate.StopChild(c, args.StopFile, waitMs);
        if (c.HasExited) ExitCode = UpgraderStopGate.ServiceExitCode(c.WaitForExitCode());
    }

    public static void Main(string[] a) { Run(new UpgraderServiceHost(a)); }
}

// The six command-line values of the service, held to fixed shapes: NODE is ROOT\upgrader\runtime\node.exe and ENTRY is
// ROOT\upgrader\<64 hex>\upgrader\src\upgrader-main.mjs (the copy keeps the repository's layout, upgrader\src, src and windows, so the
// upgrader's relative imports resolve inside it: tools/build-package.mjs upgraderCopy), so the host never runs anything outside the
// admin-only upgrader directory.
public sealed class UpgraderArgs
{
    public string Root, ConfigSha, NodeExe, NodeSha, Entry, EntrySha;
    static readonly Regex Hex = new Regex("^[0-9a-f]{64}$");
    static readonly Regex RootShape = new Regex(@"^[A-Za-z]:\\(?:[A-Za-z0-9_.-]+\\)*[A-Za-z0-9_.-]+$");

    public static UpgraderArgs Parse(string[] a)
    {
        if (a == null || a.Length != 6) throw new ArgumentException("UPGRADER_ARGS_REFUSED");
        var r = new UpgraderArgs { Root = a[0], ConfigSha = a[1], NodeExe = a[2], NodeSha = a[3], Entry = a[4], EntrySha = a[5] };
        if (!RootShape.IsMatch(r.Root) || r.Root.Contains("..") || !Hex.IsMatch(r.ConfigSha) || !Hex.IsMatch(r.NodeSha) || !Hex.IsMatch(r.EntrySha)) throw new ArgumentException("UPGRADER_ARGS_REFUSED");
        if (!string.Equals(r.NodeExe, r.Root + @"\upgrader\runtime\node.exe", StringComparison.Ordinal)) throw new ArgumentException("UPGRADER_ARGS_REFUSED");
        string prefix = r.Root + @"\upgrader\";
        if (!r.Entry.StartsWith(prefix, StringComparison.Ordinal) || !Regex.IsMatch(r.Entry.Substring(prefix.Length), @"^[0-9a-f]{64}\\upgrader\\src\\upgrader-main\.mjs$")) throw new ArgumentException("UPGRADER_ARGS_REFUSED");
        return r;
    }

    public string ConfigFile { get { return Root + @"\upgrader\config\upgrader.json"; } }
    public string StopFile { get { return Root + @"\upgrade\STOP-REQUESTED"; } }
    public string TokenRecordFile { get { return Root + @"\upgrade\upgrader-token.json"; } }

    // B1 upgrader-main: main({argv}) with --root and --config-sha256 (the config hash is checked again there).
    public string CommandLine() { return "\"" + NodeExe + "\" \"" + Entry + "\" --root \"" + Root + "\" --config-sha256 " + ConfigSha; }

    // The whole environment of the upgrader: nothing of the service account's environment is passed on. Sorted, as Windows expects.
    public static string EnvironmentBlock() { return "PATH=C:\\Windows\\System32;C:\\Windows\0SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0"; }
}

// One stop per host process (as ResidentStopGate): whichever comes first, an SCM stop, a shutdown or the upgrader's own exit, takes it.
public sealed class UpgraderStopGate
{
    int taken;
    public bool Take() { return Interlocked.Exchange(ref taken, 1) == 0; }
    public void Release() { Interlocked.Exchange(ref taken, 0); }

    public static string RequestText(ulong uptimeMs) { return "{\"contract\":\"clued.independent-ci.stop-request/1\",\"uptimeMs\":" + uptimeMs + "}\n"; }
    [DllImport("kernel32.dll")] internal static extern ulong GetTickCount64();

    // Create-only. An existing request stands as it is (false); any other failure is thrown.
    public static bool TryCreateStopFile(string path, string text)
    {
        FileStream f;
        try { f = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read | FileShare.Delete); }
        catch (IOException e) { if ((uint)e.HResult == 0x80070050u || (uint)e.HResult == 0x800700B7u) return false; throw; }
        using (f) { byte[] b = Encoding.ASCII.GetBytes(text); f.Write(b, 0, b.Length); f.Flush(true); }
        return true;
    }

    public static void ClearStale(string path) { if (File.Exists(path)) File.Delete(path); }

    // Ask, wait at most waitMs, then end the whole job. Returns how it ended: not-running | exited | killed.
    public static string StopChild(UpgraderChild c, string stopFile, int waitMs)
    {
        if (c.HasExited) return "not-running";
        bool asked;
        try { TryCreateStopFile(stopFile, RequestText(GetTickCount64())); asked = true; } catch (Exception) { asked = false; }
        if (asked && c.WaitForExit(waitMs)) return "exited";
        c.KillJob();
        c.WaitForExit(10000);
        return "killed";
    }

    // Small records in the upgrade directory: temporary file, then replace.
    public static void WriteReplace(string path, string text)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, text);
        if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
    }

    public static int ServiceExitCode(int childExitCode) { return childExitCode == 0 ? 0 : 1064; }
}

// The upgrader process: started suspended, put into a kill-on-close job, then resumed. No handle is inherited.
public sealed class UpgraderChild
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, string env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr sa, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    IntPtr process, job;
    public int Pid;

    public static UpgraderChild Start(string app, string commandLine, string environment, string directory)
    {
        if (environment == null || !environment.EndsWith("\0\0", StringComparison.Ordinal)) throw new ArgumentException("UPGRADER_ENVIRONMENT_REFUSED");
        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) throw new InvalidOperationException("UPGRADER_JOB_CREATE_FAILED");
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags follows the two LARGE_INTEGER limits.
        int size = IntPtr.Size == 8 ? 144 : 112;
        IntPtr info = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(info, i, 0);
            Marshal.WriteInt32(info, 16, (int)JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, size)) { CloseHandle(job); throw new InvalidOperationException("UPGRADER_JOB_LIMIT_FAILED"); }
        }
        finally { Marshal.FreeHGlobal(info); }
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        // bInheritHandles FALSE: the upgrader gets no handle of this host (no pipe, no file, no service handle).
        if (!CreateProcessW(app, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment, directory, ref si, out pi))
        { CloseHandle(job); throw new InvalidOperationException("UPGRADER_START_FAILED:" + Marshal.GetLastWin32Error()); }
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(job);
            throw new InvalidOperationException("UPGRADER_JOB_ASSIGN_FAILED");
        }
        ResumeThread(pi.hThread); CloseHandle(pi.hThread);
        return new UpgraderChild { process = pi.hProcess, job = job, Pid = pi.dwProcessId };
    }

    public bool WaitForExit(int ms) { return WaitForSingleObject(process, (uint)ms) == 0; }
    public bool HasExited { get { return WaitForExit(0); } }
    public int WaitForExitCode() { WaitForSingleObject(process, 0xFFFFFFFF); int code; return GetExitCodeProcess(process, out code) ? code : -1; }
    public void KillJob() { TerminateJobObject(job, 1); }
}

// The effective privileges of this process token (as ResidentTokenPrivileges; a copy, so the frozen host compiles alone).
public static class UpgraderTokenPrivileges
{
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int length, out int needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeNameW(string system, ref long luid, StringBuilder name, ref int length);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static string[] Current()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8 /* TOKEN_QUERY */, out token)) throw new InvalidOperationException("TOKEN_QUERY_FAILED");
        try
        {
            int needed; GetTokenInformation(token, 3 /* TokenPrivileges */, IntPtr.Zero, 0, out needed);
            if (needed < 4 || needed > 65536) throw new InvalidOperationException("TOKEN_PRIVILEGES_SIZE");
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, 3, buffer, needed, out needed)) throw new InvalidOperationException("TOKEN_PRIVILEGES_QUERY_FAILED");
                int count = Marshal.ReadInt32(buffer);
                if (count < 0 || 4 + count * 12 > needed) throw new InvalidOperationException("TOKEN_PRIVILEGES_SHAPE");
                var names = new System.Collections.Generic.List<string>();
                for (int i = 0; i < count; i++)
                {
                    long luid = Marshal.ReadInt64(buffer, 4 + i * 12);
                    var name = new StringBuilder(128); int length = name.Capacity;
                    if (!LookupPrivilegeNameW(null, ref luid, name, ref length)) throw new InvalidOperationException("TOKEN_PRIVILEGE_NAME_FAILED");
                    names.Add(name.ToString());
                }
                names.Sort(StringComparer.Ordinal);
                return names.ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    public static string[] Disallowed(string[] present, string[] allowed)
    {
        var extra = new System.Collections.Generic.List<string>();
        foreach (var p in present) if (Array.IndexOf(allowed, p) < 0) extra.Add(p);
        extra.Sort(StringComparer.Ordinal);
        return extra.ToArray();
    }

    public static string Json(string[] privileges, int pid)
    {
        var parts = new string[privileges.Length];
        for (int i = 0; i < privileges.Length; i++) parts[i] = "\"" + privileges[i] + "\"";
        return "{\"contract\":\"clued.independent-ci.service-token-privileges/1\",\"service\":\"CluedCIUpgrader\",\"pid\":" + pid + ",\"privileges\":[" + string.Join(",", parts) + "]}";
    }
}
