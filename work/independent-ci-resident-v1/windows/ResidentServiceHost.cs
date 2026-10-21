// CluedCIResident service host (DRAFT, compiled once by install-resident.ps1 with the in-box
// .NET Framework csc.exe; its SHA-256 is pinned in the install receipt).
//
// Runs as NT SERVICE\CluedCIResident in Session 0. It starts exactly one pinned node.exe with the
// pinned service-main.mjs and the policy pin from its own command line, a fixed environment and no
// inherited handles. It never kills the executor: on Stop it only asks the executor to stop between
// batches (a STOP-REQUESTED file) and reports how it ended. A running batch always finishes or
// fails closed on its own; SCM stop never interrupts a stage.
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;

public sealed class ResidentServiceHost : ServiceBase
{
    const string Name = "CluedCIResident";
    // Review MAJOR-1: the only privilege the resident needs (`sc privs CluedCIResident SeChangeNotifyPrivilege`).
    public static readonly string[] AllowedPrivileges = { "SeChangeNotifyPrivilege" };
    readonly string root, policySha, nodeExe, entry, nodeSha, entrySha;
    Process child;

    ResidentServiceHost(string[] a)
    {
        ServiceName = Name; CanStop = true; CanShutdown = true; AutoLog = true;
        if (a.Length != 6) throw new ArgumentException("ROOT POLICY_SHA NODE NODE_SHA ENTRY ENTRY_SHA");
        root = a[0]; policySha = a[1]; nodeExe = a[2]; nodeSha = a[3]; entry = a[4]; entrySha = a[5];
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
        child = Process.Start(psi);
        child.EnableRaisingEvents = true;
        child.Exited += (s, e) => { ExitCode = child.ExitCode == 0 ? 0 : 1064; Stop(); };
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
        try { using (File.Open(Path.Combine(root, "state", "STOP-REQUESTED"), FileMode.CreateNew, FileAccess.Write)) { } } catch (IOException) { }
        // Wait briefly for an idle executor to exit; a busy one keeps running and is found by the
        // instance lock on the next start. Nothing is killed.
        if (child != null) child.WaitForExit(20000);
    }

    public static void Main(string[] args) { Run(new ResidentServiceHost(args)); }
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
