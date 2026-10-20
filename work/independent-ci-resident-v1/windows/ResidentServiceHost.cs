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
