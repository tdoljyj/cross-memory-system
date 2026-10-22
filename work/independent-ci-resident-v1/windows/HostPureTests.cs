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
    // STOP-REQUESTED, renames it into state\locks\stop-<ms>-<pid> and exits 0 ("ack"; "ack-then-go" exits only
    // once GO appears). The other modes exit on their own.
    static int FakeExecutor(string state, string mode)
    {
        string stopFile = Path.Combine(state, "STOP-REQUESTED"), go = Path.Combine(state, "GO");
        if (mode == "exit3") return 3;
        bool acknowledged = false;
        var until = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < until)
        {
            if ((mode == "ack" || mode == "ack-then-go") && !acknowledged && File.Exists(stopFile))
            {
                long ms = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                File.Move(stopFile, Path.Combine(state, "locks", "stop-" + ms + "-" + Process.GetCurrentProcess().Id));
                acknowledged = true;
                if (mode == "ack") return 0;
            }
            if (mode == "ack-then-go" && acknowledged && File.Exists(go)) return 0;
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

    // The uptimeMs field of a stop request (RequestText).
    static ulong UptimeIn(string text)
    {
        var m = System.Text.RegularExpressions.Regex.Match(text, "\"uptimeMs\":([0-9]{1,20})\\}");
        if (!m.Success) throw new Exception("FAILED:stop-request-shape:" + text);
        return ulong.Parse(m.Groups[1].Value);
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
        // A short directory of its own, not the caller's scratch: under a deep scratch path the fake executor's
        // rename target (...\state\locks\stop-<ms>-<pid>) is longer than .NET Framework paths may be (MAX_PATH,
        // 260 with the terminator).
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
            // The acknowledged request names this boot (F2): milliseconds since boot, no later than now.
            string asked = File.ReadAllText(Directory.GetFiles(locks, "stop-*")[0]);
            Yes(asked.StartsWith("{\"contract\":\"clued.independent-ci.stop-request/1\",\"uptimeMs\":") && UptimeIn(asked) <= ResidentStopGate.GetTickCount64(), "scm-stop-request-names-this-boot:" + asked.Trim());
            Yes(host.ExitCode == 0 && State(host) == 1, "scm-stop-exit-0-stopped");
            host.Stop(); Shutdown(host);
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")) && Directory.GetFiles(locks).Length == 1, "scm-stop-later-stop-and-shutdown-write-nothing");

            // 1b. A second stop while the executor has acknowledged but still runs: only the gate keeps the file
            //     from coming back here. The second stop waits for the exit like the first.
            host = Host(Case(dir, "second-stop", out state, out locks));
            p = Fake(state, "ack-then-go"); host.Watch(p); after = After(p);
            var firstHost = host; var first = new Thread(() => firstHost.Stop()); first.Start();
            var until = DateTime.UtcNow.AddSeconds(10);
            while (Directory.GetFiles(locks, "stop-*").Length == 0 && DateTime.UtcNow < until) Thread.Sleep(20);
            Yes(Directory.GetFiles(locks, "stop-*").Length == 1 && !p.HasExited, "second-stop-acknowledged-still-running");
            string goFile = Path.Combine(state, "GO");
            using (new Timer(_ => File.WriteAllText(goFile, ""), null, 500, Timeout.Infinite))
            {
                host.Stop();
                Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")) && Directory.GetFiles(locks, "stop-*").Length == 1, "second-stop-writes-nothing");
                Yes(p.HasExited, "second-stop-waited-for-the-exit");
            }
            Yes(first.Join(30000) && after.WaitOne(10000), "second-stop-first-stop-returned");
            Shutdown(host);
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")) && host.ExitCode == 0 && State(host) == 1, "second-stop-exit-0-stopped");

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

            // 3. Shutdown asks for nothing and returns at once: Windows ends the executor within seconds anyway, and a
            //    file left behind would stop the first start after the reboot. It takes the one stop, so the
            //    executor's later exit does not stop the service itself and a later stop writes nothing.
            host = Host(Case(dir, "shutdown", out state, out locks));
            p = Fake(state, "exit3-on-go"); host.Watch(p); after = After(p);
            clock = Stopwatch.StartNew();
            Shutdown(host);
            Yes(clock.ElapsedMilliseconds < 2000 && !File.Exists(Path.Combine(state, "STOP-REQUESTED")), "shutdown-writes-nothing-and-returns");
            File.WriteAllText(Path.Combine(state, "GO"), "");
            Yes(after.WaitOne(30000), "shutdown-exited-handler-ran");
            Yes(host.ExitCode == 1064 && State(host) != 1, "shutdown-then-exit-does-not-stop-again");
            host.Stop();
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")) && host.ExitCode == 1064 && State(host) == 1, "shutdown-later-stop-writes-nothing");

            // 4. An executor that exits before the host watches it is still seen (handler attached before events).
            host = Host(Case(dir, "early-exit", out state, out locks));
            p = Fake(state, "exit3"); p.WaitForExit();
            host.Watch(p);
            until = DateTime.UtcNow.AddSeconds(10);
            while (State(host) != 1 && DateTime.UtcNow < until) Thread.Sleep(20);
            Yes(State(host) == 1 && host.ExitCode == 1064, "early-exit-seen");
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "early-exit-writes-no-stop");

            // 4b. An SCM stop after the executor exited but before the threadpool raised Exited (held off here by
            //     holding the Process lock, under which Process raises it). HasExited in OnStop then runs the
            //     handler on the stopping thread. The stop is already taken: the handler leaves STOP_PENDING (3)
            //     to the stopping thread instead of stopping the service itself, and nothing is written.
            host = Host(Case(dir, "stop-after-exit", out state, out locks));
            p = Fake(state, "exit3"); p.WaitForExit();
            var handledHost = host; int stateWhenHandled = -1;
            lock (p)
            {
                host.Watch(p);
                p.Exited += (s, e) => stateWhenHandled = State(handledHost);
                host.Stop();
            }
            Yes(stateWhenHandled == 3, "stop-after-exit-handler-did-not-stop-the-service:" + stateWhenHandled);
            Yes(!File.Exists(Path.Combine(state, "STOP-REQUESTED")), "stop-after-exit-writes-no-stop");
            Yes(host.ExitCode == 1064 && State(host) == 1, "stop-after-exit-1064-stopped");

            // 4c. The threadpool is already raising Exited (held in a handler subscribed before the host's) when an
            //     SCM stop reports STOPPED: the stopping thread maps the exit code itself.
            host = Host(Case(dir, "stop-during-exited", out state, out locks));
            p = Fake(state, "exit3-on-go");
            var inExited = new ManualResetEvent(false); var release = new ManualResetEvent(false);
            p.Exited += (s, e) => { inExited.Set(); release.WaitOne(30000); };
            host.Watch(p); after = After(p);
            File.WriteAllText(Path.Combine(state, "GO"), "");
            Yes(inExited.WaitOne(30000), "stop-during-exited-raising");
            host.Stop();
            Yes(host.ExitCode == 1064 && State(host) == 1 && !File.Exists(Path.Combine(state, "STOP-REQUESTED")), "stop-during-exited-maps-exit-code");
            release.Set();
            Yes(after.WaitOne(10000) && host.ExitCode == 1064, "stop-during-exited-handler-then-ran");

            // 4d. A request that fails other than "already there" (STOP-REQUESTED is a directory) fails the stop
            //     visibly, as before, and gives the stop back, so a retried stop asks again.
            host = Host(Case(dir, "request-fails", out state, out locks));
            Directory.CreateDirectory(Path.Combine(state, "STOP-REQUESTED"));
            p = Fake(state, "ack"); host.Watch(p); after = After(p);
            string refused = null;
            try { host.Stop(); } catch (Exception e) { refused = e.GetType().Name; }
            Yes(refused != null && State(host) != 1 && !p.HasExited, "request-fails-stop-refused:" + refused);
            Directory.Delete(Path.Combine(state, "STOP-REQUESTED"));
            host.Stop();
            bool handled = after.WaitOne(10000); int acks = Directory.GetFiles(locks, "stop-*").Length;
            Yes(handled && acks == 1 && host.ExitCode == 0 && State(host) == 1, "request-fails-retry-asks-again:" + handled + "/" + acks + "/" + host.ExitCode + "/" + State(host) + "/" + File.Exists(Path.Combine(state, "STOP-REQUESTED")));

            // 4e. An IOException other than "already there" (here the state directory is gone) no longer counts as
            //     asked (Task d80fd886, F3): the stop fails visibly instead of waiting 20 s and reporting STOPPED with
            //     an executor that was never asked; a retried stop asks again.
            host = Host(Case(dir, "state-missing", out state, out locks));
            Directory.Delete(state, true);
            p = Fake(state, "ack"); host.Watch(p); after = After(p);
            clock = Stopwatch.StartNew(); refused = null;
            try { host.Stop(); } catch (Exception e) { refused = e.GetType().Name; }
            Yes(refused == "DirectoryNotFoundException" && clock.ElapsedMilliseconds < 5000 && State(host) != 1 && !p.HasExited, "state-missing-stop-refused:" + refused);
            Directory.CreateDirectory(locks);
            host.Stop();
            Yes(after.WaitOne(10000) && Directory.GetFiles(locks, "stop-*").Length == 1 && host.ExitCode == 0 && State(host) == 1, "state-missing-retry-asks-again");

            // 5. The gate on its own.
            Case(dir, "gate", out state, out locks);
            string stopFile = Path.Combine(state, "STOP-REQUESTED");
            var gate = new ResidentStopGate(state);
            Yes(gate.Take() && !gate.Take() && !gate.Take(), "gate-first-caller-only");
            gate.Release();
            Yes(gate.Take() && !gate.Take(), "gate-given-back-after-a-failed-request");
            ulong before = ResidentStopGate.GetTickCount64();
            Yes(!File.Exists(stopFile) && gate.Request() && File.Exists(stopFile), "gate-request-creates");
            ulong written = UptimeIn(File.ReadAllText(stopFile));
            Yes(written >= before && written <= ResidentStopGate.GetTickCount64() && File.ReadAllText(stopFile) == ResidentStopGate.RequestText(written), "gate-request-uptime:" + written);
            Yes(ResidentStopGate.RequestText(123) == "{\"contract\":\"clued.independent-ci.stop-request/1\",\"uptimeMs\":123}\n", "gate-request-text");
            File.Delete(stopFile);
            // A stop still pending for an earlier executor is never truncated, renamed or rewritten.
            File.WriteAllText(stopFile, "earlier");
            Yes(!new ResidentStopGate(state).Request() && File.ReadAllText(stopFile) == "earlier", "gate-existing-stop-untouched");
            Yes(!ResidentStopGate.TryCreateStopFile(stopFile, "x") && File.ReadAllText(stopFile) == "earlier", "gate-create-only");
            File.Delete(stopFile);
            // Only "already there" counts as asked; other IOExceptions are thrown (F3).
            string missingDirectory = null;
            try { ResidentStopGate.TryCreateStopFile(Path.Combine(state, "no-such-directory", "STOP-REQUESTED"), "x"); } catch (IOException e) { missingDirectory = e.GetType().Name; }
            Yes(missingDirectory == "DirectoryNotFoundException", "gate-missing-directory-thrown:" + missingDirectory);
            Yes(ResidentStopGate.AlreadyThere(new IOException("x", unchecked((int)0x80070050))) && ResidentStopGate.AlreadyThere(new IOException("x", unchecked((int)0x800700B7)))
                && !ResidentStopGate.AlreadyThere(new IOException("x", unchecked((int)0x80070070))) && !ResidentStopGate.AlreadyThere(new IOException("x", unchecked((int)0x80070020))), "gate-already-there-codes");
            // Once the file is created the request stands, even if its content cannot be written: a failure there
            // must not give the stop back, or a retry would create a second request after the executor took the first.
            Yes(ResidentStopGate.TryCreateStopFile(stopFile, "x", (f, b) => { throw new IOException("disk full"); }) && File.Exists(stopFile) && new FileInfo(stopFile).Length == 0, "gate-created-but-unwritten-stands");
            File.Delete(stopFile);
            // Shared for read and delete: the executor can read and rename the request while the host still holds it.
            bool readAndRenamedWhileHeld = false;
            Yes(ResidentStopGate.TryCreateStopFile(stopFile, "x", (f, b) =>
            {
                f.Write(b, 0, b.Length); f.Flush();
                using (var r = new FileStream(stopFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { }
                File.Move(stopFile, stopFile + ".taken");
                readAndRenamedWhileHeld = true;
            }) && readAndRenamedWhileHeld && File.ReadAllText(stopFile + ".taken") == "x" && !File.Exists(stopFile), "gate-request-renamable-while-held");
            File.Delete(stopFile + ".taken");
            // Racing callers: exactly one takes the stop.
            for (int round = 0; round < 200; round++)
            {
                var g = new ResidentStopGate(state); int wins = 0;
                var barrier = new Barrier(8); var threads = new Thread[8];
                for (int t = 0; t < 8; t++)
                {
                    threads[t] = new Thread(() => { barrier.SignalAndWait(); if (g.Take()) Interlocked.Increment(ref wins); });
                    threads[t].Start();
                }
                foreach (var t in threads) t.Join();
                if (wins != 1) throw new Exception("FAILED:gate-race-round-" + round);
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
