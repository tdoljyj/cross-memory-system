// CluedCIResident service host (DRAFT, compiled once by install-resident.ps1 with the in-box
// .NET Framework csc.exe; its SHA-256 is pinned in the install receipt).
//
// Runs as NT SERVICE\CluedCIResident in Session 0. It starts exactly one pinned node.exe with the
// pinned service-main.mjs and the policy pin from its own command line, a fixed environment and no
// inherited handles. It never kills the executor: on Stop it only asks the executor to stop between
// batches (a STOP-REQUESTED file) and reports how it ended. A running batch always finishes or
// fails closed on its own; SCM stop never interrupts a stage. It asks at most once per process, and
// never at shutdown or when the executor exited on its own (ResidentStopGate).
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Threading;

public sealed class ResidentServiceHost : ServiceBase
{
    const string Name = "CluedCIResident";
    // Review MAJOR-1: the only privilege the resident needs (`sc privs CluedCIResident SeChangeNotifyPrivilege`).
    public static readonly string[] AllowedPrivileges = { "SeChangeNotifyPrivilege" };
    readonly string root, policySha, nodeExe, entry, nodeSha, entrySha;
    readonly ResidentStopGate stop;
    Process child;

    internal ResidentServiceHost(string[] a)
    {
        ServiceName = Name; CanStop = true; CanShutdown = true; AutoLog = true;
        if (a.Length != 6) throw new ArgumentException("ROOT POLICY_SHA NODE NODE_SHA ENTRY ENTRY_SHA");
        root = a[0]; policySha = a[1]; nodeExe = a[2]; nodeSha = a[3]; entry = a[4]; entrySha = a[5];
        stop = new ResidentStopGate(Path.Combine(root, "state"));
    }

    static string Sha(string path)
    {
        using (var s = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
    }

    protected override void OnStart(string[] ignored)
    {
        // The real token, not the configuration: refuse to start with any privilege beyond the allow-list,
        // and record what the token holds (state\service-token.json; verify-resident.ps1 and the install
        // receipt compare it).
        var privileges = ResidentTokenPrivileges.Current();
        WriteTokenRecord(Path.Combine(root, "state", "service-token.json"), ResidentTokenPrivileges.Json(privileges, Process.GetCurrentProcess().Id));
        if (ResidentTokenPrivileges.Disallowed(privileges, AllowedPrivileges).Length > 0) throw new InvalidOperationException("RESIDENT_TOKEN_PRIVILEGES_NOT_MINIMAL");
        // Refuse to start on any drift of the runtime or the entry point.
        if (Sha(nodeExe) != nodeSha || Sha(entry) != entrySha) throw new InvalidOperationException("RESIDENT_RUNTIME_PIN_CHANGED");
        var psi = new ProcessStartInfo(nodeExe, "\"" + entry + "\" --root \"" + root + "\" --policy-sha256 " + policySha)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
            RedirectStandardInput = false, RedirectStandardOutput = false, RedirectStandardError = false,
        };
        psi.EnvironmentVariables.Clear();
        psi.EnvironmentVariables["SystemRoot"] = @"C:\Windows";
        psi.EnvironmentVariables["WINDIR"] = @"C:\Windows";
        psi.EnvironmentVariables["PATH"] = @"C:\Windows\System32;C:\Windows";
        Watch(Process.Start(psi));
    }

    // The handler is attached before events are enabled, so an executor that exits at once is still seen.
    internal void Watch(Process p)
    {
        child = p;
        p.Exited += (s, e) =>
        {
            ExitCode = ResidentStopGate.ServiceExitCode(p.ExitCode);
            // Exited on its own: stop the service; nobody is left to ask, so nothing is written. When a stop or
            // a shutdown took the stop first, the service is already stopping there, so Stop() is not called.
            if (stop.Take()) Stop();
        };
        p.EnableRaisingEvents = true;
    }


    // Atomic replace of the small token record (the directory is writable by this service only).
    static void WriteTokenRecord(string path, string json)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, json + "\n");
        if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
    }

    protected override void OnStop()
    {
        // Only the first stop of this process asks, and only a running executor (live 2026-10-21: the Exited
        // handler's Stop() re-entered OnStop and recreated STOP-REQUESTED after the executor had renamed it
        // away, so the next start stopped at once). The stop is taken before the executor is looked at:
        // HasExited and WaitForExit run a pending Exited handler on this thread, which then finds it taken.
        Process p = child;
        if (stop.Take() && p != null && !p.HasExited)
        {
            // A request that throws (no file created, for any reason but "already there") fails this stop, as
            // before. Nothing was created, so the stop is given back and a retried stop asks again. An executor
            // that exits in that moment finds the stop still taken: the service stays RUNNING until that retry.
            try { stop.Request(); } catch { stop.Release(); throw; }
        }
        // Wait briefly for an idle executor to exit; a busy one keeps running and is found by the
        // instance lock on the next start. Nothing is killed. The exit code is mapped here as well,
        // because STOPPED may be reported before the Exited handler has run.
        if (p != null && p.WaitForExit(20000)) ExitCode = ResidentStopGate.ServiceExitCode(p.ExitCode);
    }

    // Shutdown asks for nothing. Windows ends every process within seconds (WaitToKillServiceTimeout, 5 s on
    // TURING), usually before an idle executor (15 s rest) looks for a stop, and a STOP-REQUESTED left behind
    // would make the first start after the reboot stop with exit 0, so without the failure restart. The next
    // start runs crash recovery instead, as after any other end of the executor.
    protected override void OnShutdown() { stop.Take(); }

    public static void Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--replace-status") {
            try { Environment.ExitCode = StatusReplacement.Publish(args[1]); }
            catch (UnauthorizedAccessException) { Environment.ExitCode = 5; }
            catch (IOException e) { Environment.ExitCode = e.HResult & 0xffff; }
            return;
        }
        Run(new ResidentServiceHost(args));
    }
}

// The host's stop decisions (stop re-entry fix, Task fe6cd7bc). One stop per host process: whichever comes
// first, an SCM stop, a shutdown or the executor's own exit, takes it. Only an SCM stop that takes it and
// finds the executor running writes STOP-REQUESTED, create-only. The executor acknowledges it by renaming it
// into state\locks (service-main.mjs, with a service-stop receipt); the host never renames, deletes or
// rewrites it.
public sealed class ResidentStopGate
{
    readonly string stopFile;
    int taken;

    public ResidentStopGate(string stateDirectory) { stopFile = Path.Combine(stateDirectory, "STOP-REQUESTED"); }

    // True for the first caller of this process, and again for the next one after Release().
    public bool Take() { return Interlocked.Exchange(ref taken, 1) == 0; }

    // Only after a failed request, which created no file.
    public void Release() { Interlocked.Exchange(ref taken, 0); }

    // Ask the executor to stop between batches. The request carries the milliseconds since this boot. Uptime
    // starts again at every boot, so a request that records more uptime than the machine has now was written
    // before a reboot and asked no executor of this boot (Task d80fd886, F2); one written early in an earlier
    // boot cannot be told apart. An executor that only checks that the file exists ignores the content.
    public bool Request() { return TryCreateStopFile(stopFile, RequestText(GetTickCount64())); }

    public static string RequestText(ulong uptimeMs)
    {
        return "{\"contract\":\"clued.independent-ci.stop-request/1\",\"uptimeMs\":" + uptimeMs + "}\n";
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] internal static extern ulong GetTickCount64();

    // Written through to disk: stops are rare, and a request cut by a power loss would lose its boot record.
    public static bool TryCreateStopFile(string path, string text) { return TryCreateStopFile(path, text, (f, b) => { f.Write(b, 0, b.Length); f.Flush(true); }); }

    // An existing file (a stop still pending for an earlier executor) is left exactly as it is. Only "already
    // there" counts as asked: any other failure to create the file (a missing directory, a full disk) is thrown,
    // so the stop fails visibly instead of reporting STOPPED while the executor was never asked (Task d80fd886,
    // F3). Once the file exists the request stands, even if its content could not be written: an empty or cut
    // request is honoured like one without content. An empty file is also the normal state between CreateNew and
    // the write, so a reader must never treat an empty or unreadable request as stale. The file is shared for read
    // and delete, so the executor can read and rename it while the host still holds it.
    internal static bool TryCreateStopFile(string path, string text, Action<FileStream, byte[]> write)
    {
        FileStream f;
        try { f = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read | FileShare.Delete); }
        catch (IOException e)
        {
            if (AlreadyThere(e)) return false;
            throw;
        }
        try { using (f) write(f, System.Text.Encoding.ASCII.GetBytes(text)); } catch (Exception) { /* the request stands */ }
        return true;
    }

    // ERROR_FILE_EXISTS, which CREATE_NEW reports, and ERROR_ALREADY_EXISTS (kept defensively), as HRESULTs.
    public static bool AlreadyThere(IOException e) { return (uint)e.HResult == 0x80070050u || (uint)e.HResult == 0x800700B7u; }

    public static int ServiceExitCode(int executorExitCode) { return executorExitCode == 0 ? 0 : 1064; }
}

// Review MAJOR-1: the effective privileges of this process token. The install sets the service's required
// privileges (`sc privs`), so the SCM strips every other privilege; the host re-checks the real token at
// start, refuses to run with anything else, and records what it has for verify and the install receipt.
public static class ResidentTokenPrivileges
{
    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(System.IntPtr process, uint access, out System.IntPtr token);
    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(System.IntPtr token, int cls, System.IntPtr info, int length, out int needed);
    [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeNameW(string system, ref long luid, System.Text.StringBuilder name, ref int length);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern System.IntPtr GetCurrentProcess();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(System.IntPtr h);

    public static string[] Current()
    {
        System.IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8 /* TOKEN_QUERY */, out token)) throw new System.InvalidOperationException("TOKEN_QUERY_FAILED");
        try
        {
            int needed; GetTokenInformation(token, 3 /* TokenPrivileges */, System.IntPtr.Zero, 0, out needed);
            if (needed < 4 || needed > 65536) throw new System.InvalidOperationException("TOKEN_PRIVILEGES_SIZE");
            System.IntPtr buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, 3, buffer, needed, out needed)) throw new System.InvalidOperationException("TOKEN_PRIVILEGES_QUERY_FAILED");
                int count = System.Runtime.InteropServices.Marshal.ReadInt32(buffer);
                if (count < 0 || 4 + count * 12 > needed) throw new System.InvalidOperationException("TOKEN_PRIVILEGES_SHAPE");
                var names = new System.Collections.Generic.List<string>();
                for (int i = 0; i < count; i++)
                {
                    long luid = System.Runtime.InteropServices.Marshal.ReadInt64(buffer, 4 + i * 12);
                    var name = new System.Text.StringBuilder(128); int length = name.Capacity;
                    if (!LookupPrivilegeNameW(null, ref luid, name, ref length)) throw new System.InvalidOperationException("TOKEN_PRIVILEGE_NAME_FAILED");
                    names.Add(name.ToString());
                }
                names.Sort(System.StringComparer.Ordinal);
                return names.ToArray();
            }
            finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    // Pure: the privileges present that the allow-list does not name (sorted).
    public static string[] Disallowed(string[] present, string[] allowed)
    {
        var extra = new System.Collections.Generic.List<string>();
        foreach (var p in present) if (System.Array.IndexOf(allowed, p) < 0) extra.Add(p);
        extra.Sort(System.StringComparer.Ordinal);
        return extra.ToArray();
    }

    public static string Json(string[] privileges, int pid)
    {
        var parts = new string[privileges.Length];
        for (int i = 0; i < privileges.Length; i++) parts[i] = "\"" + privileges[i] + "\"";
        return "{\"contract\":\"clued.independent-ci.service-token-privileges/1\",\"pid\":" + pid + ",\"privileges\":[" + string.Join(",", parts) + "]}";
    }
}

// One-shot fallback for the resident's status file. The only argument is a nonce. The installed
// host's own location determines both names. No SCM operation or extra privilege is involved.
internal static class StatusReplacement
{
    const uint DeleteAccess = 0x10000, ShareAll = 7, OpenExisting = 3, OpenReparsePoint = 0x00200000;
    const int FileRenameInfoEx = 22;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RenameInfo { public uint Flags; public IntPtr Root; public uint NameBytes; public char FirstChar; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint length);

    public static int Publish(string nonce)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(nonce, @"\A[0-9a-f]{12}\z")) return 87;
        var bin = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
        if (!String.Equals(bin.Name, "bin", StringComparison.OrdinalIgnoreCase) || bin.Parent == null) return 87;
        string state = Path.Combine(bin.Parent.FullName, "state"), target = Path.Combine(state, "status.json");
        string source = target + "." + nonce + ".tmp";
        if ((File.GetAttributes(state) & FileAttributes.ReparsePoint) != 0) return 5;
        // Respect every external reader's delete-sharing decision before requesting POSIX replacement.
        using (var reader = CreateFileW(target, DeleteAccess, ShareAll, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero)) {
            if (reader.IsInvalid) return Marshal.GetLastWin32Error();
            using (var tmp = CreateFileW(source, DeleteAccess, ShareAll, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero)) {
                if (tmp.IsInvalid) return Marshal.GetLastWin32Error();
                byte[] name = Encoding.Unicode.GetBytes(target);
                int offset = Marshal.OffsetOf(typeof(RenameInfo), "FirstChar").ToInt32();
                int size = Math.Max(Marshal.SizeOf(typeof(RenameInfo)), offset + name.Length + 2);
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try {
                    var info = new RenameInfo { Flags = 3, NameBytes = (uint)name.Length }; // REPLACE_IF_EXISTS | POSIX_SEMANTICS
                    Marshal.StructureToPtr(info, buffer, false);
                    Marshal.Copy(name, 0, IntPtr.Add(buffer, offset), name.Length);
                    Marshal.WriteInt16(buffer, offset + name.Length, 0);
                    return SetFileInformationByHandle(tmp, FileRenameInfoEx, buffer, (uint)size) ? 0 : Marshal.GetLastWin32Error();
                } finally { Marshal.FreeHGlobal(buffer); }
            }
        }
    }
}
