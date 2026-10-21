// Offline checks of the resident service host's stop handling (Task fe6cd7bc: stop re-entry), compiled with
// ResidentServiceHost.cs into a scratch directory by test-resident-windows.ps1 (/main:HostPureTests). They drive
// the real ResidentServiceHost (Watch, Stop, OnShutdown) against a temporary state directory, with this same
// executable started as a fake executor (--fake-executor). No service, SCM handle or host path is used.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;

public static class HostPureTests
{
    static int n;
    static void Yes(bool ok, string what) { if (!ok) throw new Exception("FAILED:" + what); n++; }

    // The executor's side of the stop contract, as service-main.mjs does it: at a safe point it finds
    // STOP-REQUESTED, renames it into state\locks\stop-<ms>-<pid> and exits 0. Other modes exit on their own.
    static int FakeExecutor(string state, string mode)
    {
        string stopFile = Path.Combine(state, "STOP-REQUESTED"), go = Path.Combine(state, "GO");
        if (mode == "exit3") return 3;
        var until = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < until)
        {
            if (mode == "ack" && File.Exists(stopFile))
            {
                long ms = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                File.Move(stopFile, Path.Combine(state, "locks", "stop-" + ms + "-" + Process.GetCurrentProcess().Id));
                return 0;
            }
            if (mode == "exit3-on-go" && File.Exists(go)) return 3;
            Thread.Sleep(20);
        }
        return 7;
    }

    static string self;
    static readonly System.Collections.Generic.List<Process> started = new System.Collections.Generic.List<Process>();

    static Process Fake(string state, string mode)
    {
        var p = Process.Start(new ProcessStartInfo(self, "--fake-executor \"" + state + "\" " + mode) { UseShellExecute = false, CreateNoWindow = true });
        started.Add(p);
        return p;
    }

    static ResidentServiceHost Host(string root)
    {
        string sha = new string('a', 64);
        var host = new ResidentServiceHost(new[] { root, sha, Path.Combine(root, "node.exe"), sha, Path.Combine(root, "service-main.mjs"), sha });
        host.AutoLog = false;   // no event log source outside the installed service
        return host;
    }

    // Set after the host's own Exited handler: handlers run in subscription order, so once this is set the
    // host's handler (and any Stop() it made) has finished.
    static ManualResetEvent After(Process p) { var seen = new ManualResetEvent(false); p.Exited += (s, e) => seen.Set(); return seen; }

    static void Shutdown(ResidentServiceHost host) { typeof(ServiceBase).GetMethod("OnShutdown", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(host, null); }

    // ServiceBase's own status (1 = STOPPED): proves that Stop() ran, since it reports STOPPED only after OnStop.
    static int State(ResidentServiceHost host)
    {
        var f = typeof(ServiceBase).GetField("status", BindingFlags.Instance | BindingFlags.NonPublic);
        if (f == null) throw new Exception("SERVICE_STATUS_FIELD_MISSING");
        object status = f.GetValue(host);
        var cs = status.GetType().GetField("currentState");
        if (cs == null) throw new Exception("SERVICE_STATUS_STATE_MISSING");
        return (int)cs.GetValue(status);
    }

    static string Case(string dir, string name, out string state, out string locks)
    {
        string root = Path.Combine(dir, name);
        state = Path.Combine(root, "state"); locks = Path.Combine(state, "locks");
        Directory.CreateDirectory(locks);
        return root;
    }

    public static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--fake-executor") return FakeExecutor(args[1], args[2]);
        self = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.Combine(Path.GetTempPath(), "clued-host-pure-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string state, locks;

            // 1. The live bug (2026-10-21 15:51Z): an SCM stop, the executor acknowledges and exits, and the
            //    Exited handler's Stop() re-entered OnStop and recreated STOP-REQUESTED.
            var host = Host(Case(dir, "scm-stop", out state, out locks));
            Yes(State(host) != 1, "fresh-host-not-stopped");
            var p = Fake(state, "ack"); host.Watch(p); var after = After(p);
            var clock = Stopwatch.StartNew();
            host.Stop();
            Yes(clock.ElapsedMilliseconds < 15000, "scm-stop-acknowledged-before-the-20s-wait");
            Yes(after.WaitOne(10000), "scm-stop-exited-handler-ran");
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "scm-stop-not-recreated-after-acknowledgement");
            Yes(Directory.GetFiles(locks, "stop-*").Length == 1, "scm-stop-acknowledged-once");
            Yes(host.ExitCode == 0 && State(host) == 1, "scm-stop-exit-0-stopped");
            host.Stop(); Shutdown(host);
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")) && Directory.GetFiles(locks).Length == 1, "scm-stop-later-stop-and-shutdown-write-nothing");

            // 2. The executor exits on its own (exit 3): the service stops with 1064 and nothing is written, so the
            //    failure restart runs recovery instead of stopping at once.
            host = Host(Case(dir, "own-exit", out state, out locks));
            p = Fake(state, "exit3-on-go"); host.Watch(p); after = After(p);
            File.WriteAllText(Path.Combine(state, "GO"), "");
            Yes(after.WaitOne(30000), "own-exit-exited-handler-ran");
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "own-exit-writes-no-stop");
            Yes(host.ExitCode == 1064 && State(host) == 1, "own-exit-1064-stopped");
            host.Stop(); Shutdown(host);
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "own-exit-later-stop-and-shutdown-write-nothing");

            // 3. Shutdown first takes the one stop just like OnStop; a later stop writes nothing.
            host = Host(Case(dir, "shutdown", out state, out locks));
            p = Fake(state, "ack"); host.Watch(p); after = After(p);
            Shutdown(host);
            Yes(after.WaitOne(10000), "shutdown-exited-handler-ran");
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")) && Directory.GetFiles(locks, "stop-*").Length == 1, "shutdown-acknowledged-once-not-recreated");
            Yes(host.ExitCode == 0, "shutdown-exit-0");
            host.Stop();
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "shutdown-later-stop-writes-nothing");

            // 4. An executor that exits before the host watches it is still seen (handler attached before events).
            host = Host(Case(dir, "early-exit", out state, out locks));
            p = Fake(state, "exit3"); p.WaitForExit();
            host.Watch(p);
            var until = DateTime.UtcNow.AddSeconds(10);
            while (State(host) != 1 && DateTime.UtcNow < until) Thread.Sleep(20);
            Yes(State(host) == 1 && host.ExitCode == 1064, "early-exit-seen");
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "early-exit-writes-no-stop");

            // 4b. An SCM stop that comes after the executor exited but before its Exited handler ran (here: the
            //     handler is never attached) takes the stop and writes nothing: nobody is left to read it.
            host = Host(Case(dir, "stop-after-exit", out state, out locks));
            p = Fake(state, "exit3"); p.WaitForExit();
            typeof(ResidentServiceHost).GetField("child", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(host, p);
            host.Stop();
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "stop-after-exit-writes-no-stop");
            Yes(host.ExitCode == 1064 && State(host) == 1, "stop-after-exit-1064-stopped");

            // 5. The gate on its own.
            Case(dir, "gate", out state, out locks);
            string stopFile = Path.Combine(state, "STOP-REQUESTED");
            var gate = new ResidentStopGate(state);
            Yes(gate.ScmStop(false) && !File.Exists(stopFile), "gate-executor-gone-writes-nothing");
            Yes(!gate.ScmStop(true) && !File.Exists(stopFile), "gate-second-stop-refused");
            Yes(!gate.ExecutorExited(), "gate-exit-after-stop-no-second-stop");
            // A stop still pending for an earlier executor is never truncated, renamed or rewritten.
            File.WriteAllText(stopFile, "earlier");
            Yes(new ResidentStopGate(state).ScmStop(true) && File.ReadAllText(stopFile) == "earlier", "gate-existing-stop-untouched");
            Yes(!ResidentStopGate.TryCreateStopFile(stopFile) && File.ReadAllText(stopFile) == "earlier", "gate-create-only");
            File.Delete(stopFile);
            Yes(ResidentStopGate.TryCreateStopFile(stopFile) && new FileInfo(stopFile).Length == 0, "gate-creates-empty");
            File.Delete(stopFile);
            // Racing stops and exits: exactly one wins, and only a winning SCM stop writes the file.
            for (int round = 0; round < 200; round++)
            {
                var g = new ResidentStopGate(state); int wins = 0, scmWins = 0;
                var barrier = new Barrier(8); var threads = new Thread[8];
                for (int t = 0; t < 8; t++)
                {
                    bool scm = t % 2 == 0;
                    threads[t] = new Thread(() => { barrier.SignalAndWait(); if (scm ? g.ScmStop(true) : g.ExecutorExited()) { Interlocked.Increment(ref wins); if (scm) Interlocked.Increment(ref scmWins); } });
                    threads[t].Start();
                }
                foreach (var t in threads) t.Join();
                if (wins != 1 || File.Exists(stopFile) != (scmWins == 1)) throw new Exception("FAILED:gate-race-round-" + round);
                if (File.Exists(stopFile)) File.Delete(stopFile);
            }
            Yes(true, "gate-race-200-rounds");
            Yes(ResidentStopGate.ServiceExitCode(0) == 0 && ResidentStopGate.ServiceExitCode(3) == 1064 && ResidentStopGate.ServiceExitCode(4) == 1064 && ResidentStopGate.ServiceExitCode(-1) == 1064, "exit-code-mapping");

            Console.WriteLine("{\"status\":\"HOST_PURE_PASS\",\"assertions\":" + n + "}");
            return 0;
        }
        catch (Exception e)
        {
            string m = e is TargetInvocationException && e.InnerException != null ? e.InnerException.Message : e.Message;
            Console.WriteLine("{\"status\":\"HOST_PURE_FAIL\",\"message\":\"" + m.Replace("\\", "/").Replace("\"", "'") + "\"}");
            return 1;
        }
        finally
        {
            foreach (var p in started) { try { if (!p.HasExited) p.Kill(); } catch { } }
            try { Directory.Delete(dir, true); } catch { }
        }
    }
}
