// CluedCIResident service host (DRAFT, compiled once by install-resident.ps1 with the in-box
// .NET Framework csc.exe; its SHA-256 is pinned in the install receipt).
//
// Runs as NT SERVICE\CluedCIResident in Session 0. It starts exactly one pinned node.exe with the
// pinned service-main.mjs and the policy pin from its own command line, a fixed environment and no
// inherited handles. It never kills the executor: on Stop it only asks the executor to stop between
// batches (a STOP-REQUESTED file) and reports how it ended. A running batch always finishes or
// fails closed on its own; SCM stop never interrupts a stage. It asks at most once per process
// (ResidentStopGate): the executor's own exit stops the service without writing STOP-REQUESTED.
using System;
using System.Diagnostics;
using System.IO;
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
            // Exited on its own: stop the service; nobody is left to ask, so nothing is written. During an SCM
            // stop the stopping thread reports STOPPED itself once its wait returns, so Stop() is not called.
            if (stop.ExecutorExited()) Stop();
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

    protected override void OnStop() { RequestStopBetweenBatches(); }
    protected override void OnShutdown() { RequestStopBetweenBatches(); }

    void RequestStopBetweenBatches()
    {
        // ServiceBase.Stop() from the Exited handler re-enters OnStop, and a shutdown can follow a stop: only
        // the first stop of this process asks, and only a running executor (live 2026-10-21: a re-entered
        // OnStop recreated STOP-REQUESTED after the executor had renamed it away, so the next start stopped).
        Process p = child;
        if (!stop.ScmStop(p != null && !p.HasExited)) return;
        // Wait briefly for an idle executor to exit; a busy one keeps running and is found by the
        // instance lock on the next start. Nothing is killed. The exit code is mapped here as well,
        // because STOPPED may be reported before the Exited handler has run.
        if (p != null && p.WaitForExit(20000)) ExitCode = ResidentStopGate.ServiceExitCode(p.ExitCode);
    }

    public static void Main(string[] args) { Run(new ResidentServiceHost(args)); }
}

// The host's stop decisions (stop re-entry fix, Task fe6cd7bc). One stop per host process: whichever comes
// first, an SCM stop or shutdown, or the executor's own exit, takes it. Only an SCM stop that finds the
// executor running writes STOP-REQUESTED, create-only. The executor acknowledges it by renaming it into
// state\locks (service-main.mjs, with a service-stop receipt); the host never renames, deletes or rewrites it.
public sealed class ResidentStopGate
{
    readonly string stopFile;
    int stopping;

    public ResidentStopGate(string stateDirectory) { stopFile = Path.Combine(stateDirectory, "STOP-REQUESTED"); }

    // OnStop / OnShutdown. False when a stop already happened in this process: do nothing. Otherwise ask a
    // running executor to stop between batches and return true (the caller then waits for it).
    public bool ScmStop(bool executorRunning)
    {
        if (Interlocked.Exchange(ref stopping, 1) != 0) return false;
        if (executorRunning) TryCreateStopFile(stopFile);
        return true;
    }

    // The executor exited. True when no stop happened yet: the host must stop the service itself.
    public bool ExecutorExited() { return Interlocked.Exchange(ref stopping, 1) == 0; }

    // An existing file (a stop still pending for an earlier executor) is left exactly as it is.
    public static bool TryCreateStopFile(string path)
    {
        try { using (File.Open(path, FileMode.CreateNew, FileAccess.Write)) { } return true; } catch (IOException) { return false; }
    }

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
