// Offline checks of the CluedCIUpgrader service host (018da927 B2), compiled with UpgraderServiceHost.cs into a scratch directory by
// test-upgrade-windows.ps1 (/main:UpgraderHostPureTests) and run there: UpgraderHostPureTests.exe <scratch directory>.
// The pure parts (argument shapes, command line, environment block, stop gate, stop file, token record) are checked directly; the
// process parts run this same executable as a fake upgrader (--fake-child) through the host's real UpgraderChild: the fixed
// environment, no inherited handle, a stop that is honoured, a stop that is ignored (the job is ended), a grandchild ended with the
// job. No service, SCM handle or host path is used.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class UpgraderHostPureTests
{
    static int n;
    static void Yes(bool ok, string what) { if (!ok) throw new Exception("FAILED:" + what); n++; }
    static bool Refused(Action a, string code) { try { a(); return false; } catch (Exception e) { return e.Message == code; } }

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateEventW(ref SECURITY_ATTRIBUTES sa, bool manual, bool initial, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(IntPtr h, out uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    // The fake upgrader. honour: exits 0 once the stop file is there; ignore: never looks; exit3: exits 3; dump-env: writes its
    // environment; check-handle: writes whether a handle value of the parent is valid here; spawn-grandchild: starts an ignoring
    // grandchild (a plain child of its own, so it is in the job) and writes its pid.
    static int FakeChild(string[] a)
    {
        string mode = a[1];
        if (mode == "exit3") return 3;
        if (mode == "dump-env")
        {
            var names = new System.Collections.Generic.List<string>();
            foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) names.Add(e.Key + "=" + e.Value);
            names.Sort(StringComparer.Ordinal);
            File.WriteAllText(a[2], string.Join("\n", names.ToArray()));
            return 0;
        }
        if (mode == "check-handle")
        {
            uint flags;
            File.WriteAllText(a[3], GetHandleInformation(new IntPtr(long.Parse(a[2])), out flags) ? "present" : "absent");
            return 0;
        }
        if (mode == "spawn-grandchild")
        {
            string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
            var g = Process.Start(new ProcessStartInfo(self, "--fake-child ignore") { UseShellExecute = false, CreateNoWindow = true });
            File.WriteAllText(a[2], g.Id.ToString());
            Thread.Sleep(30000);
            return 7;
        }
        var until = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < until)
        {
            if (mode == "honour" && File.Exists(a[2])) return 0;
            Thread.Sleep(20);
        }
        return 7;
    }

    static bool Alive(int pid) { try { var p = Process.GetProcessById(pid); return !p.HasExited; } catch (ArgumentException) { return false; } }

    public static int Main(string[] a)
    {
        if (a.Length >= 2 && a[0] == "--fake-child") return FakeChild(a);
        // The arguments the SCM would hand the host for a command line (test-upgrade-windows.ps1 passes install's Get-UpgraderBinPath tail).
        if (a.Length >= 1 && a[0] == "--check-args")
        {
            var rest = new string[a.Length - 1]; Array.Copy(a, 1, rest, 0, rest.Length);
            try { var p = UpgraderArgs.Parse(rest); Console.WriteLine("ok|" + p.CommandLine()); return 0; }
            catch (ArgumentException e) { Console.WriteLine(e.Message); return 3; }
        }
        if (a.Length != 1 || !Directory.Exists(a[0])) { Console.WriteLine("{\"status\":\"UPGRADER_HOST_PURE_FAIL\",\"message\":\"usage: <scratch directory>\"}"); return 2; }
        string dir = Path.Combine(a[0], "upgrader-host-pure");
        Directory.CreateDirectory(dir);
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        var children = new System.Collections.Generic.List<UpgraderChild>();
        try
        {
            // 1. Arguments: the six values, in fixed shapes only.
            string root = @"C:\ProgramData\CluedIndependentCI\resident", h1 = new string('a', 64), h2 = new string('b', 64), h3 = new string('c', 64), m = new string('d', 64);
            string node = root + @"\upgrader\runtime\node.exe", entry = root + @"\upgrader\" + m + @"\upgrader\src\upgrader-main.mjs";
            var ok = UpgraderArgs.Parse(new[] { root, h1, node, h2, entry, h3 });
            Yes(ok.ConfigSha == h1 && ok.NodeSha == h2 && ok.EntrySha == h3 && ok.Entry == entry, "args-parse");
            Yes(ok.ConfigFile == root + @"\upgrader\config\upgrader.json" && ok.StopFile == root + @"\upgrade\STOP-REQUESTED" && ok.TokenRecordFile == root + @"\upgrade\upgrader-token.json", "args-derived-paths");
            Yes(ok.CommandLine() == "\"" + node + "\" \"" + entry + "\" --root \"" + root + "\" --config-sha256 " + h1, "command-line");
            var bad = new string[][] {
                new[] { root, h1, node, h2, entry },
                new[] { root, h1, node, h2, entry, h3, "x" },
                new[] { root, h1.ToUpperInvariant(), node, h2, entry, h3 },
                new[] { root, h1, node, h2.Substring(1), entry, h3 },
                new[] { root + "\"", h1, node, h2, entry, h3 },
                new[] { @"ProgramData\resident", h1, @"ProgramData\resident\upgrader\runtime\node.exe", h2, @"ProgramData\resident\upgrader\" + m + @"\upgrader\src\upgrader-main.mjs", h3 },
                new[] { root + @"\..\x", h1, root + @"\..\x\upgrader\runtime\node.exe", h2, root + @"\..\x\upgrader\" + m + @"\upgrader\src\upgrader-main.mjs", h3 },
                new[] { root, h1, root + @"\runtime\node.exe", h2, entry, h3 },
                new[] { root, h1, @"C:\Program Files\nodejs\node.exe", h2, entry, h3 },
                new[] { root, h1, node, h2, root + @"\resident\" + m + @"\src\upgrader-main.mjs", h3 },
                new[] { root, h1, node, h2, root + @"\upgrader\" + m + @"\upgrader\src\service-main.mjs", h3 },
                new[] { root, h1, node, h2, root + @"\upgrader\" + m + @"\src\upgrader-main.mjs", h3 },
                new[] { root, h1, node, h2, root + @"\upgrader\" + m + @"\upgrader\src\..\src\upgrader-main.mjs", h3 },
                new[] { root, h1, node, h2, root + @"\upgrader\" + m + @"\upgrader\src\upgrader-main.mjs" + "\" --x", h3 },
            };
            for (int i = 0; i < bad.Length; i++) { var b = bad[i]; Yes(Refused(() => UpgraderArgs.Parse(b), "UPGRADER_ARGS_REFUSED"), "args-refused-" + i); }
            Yes(Refused(() => UpgraderArgs.Parse(null), "UPGRADER_ARGS_REFUSED"), "args-refused-null");

            // 2. The environment block: three fixed variables, sorted, double-NUL terminated.
            string env = UpgraderArgs.EnvironmentBlock();
            Yes(env == "PATH=C:\\Windows\\System32;C:\\Windows\0SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0", "environment-block");
            Yes(Refused(() => UpgraderChild.Start(self, "\"" + self + "\"", "PATH=x\0", dir), "UPGRADER_ENVIRONMENT_REFUSED"), "environment-must-end-with-double-nul");

            // 3. The stop gate: one stop per process.
            var gate = new UpgraderStopGate();
            Yes(gate.Take() && !gate.Take(), "gate-once");
            gate.Release(); Yes(gate.Take(), "gate-release");
            for (int round = 0; round < 100; round++)
            {
                var g = new UpgraderStopGate(); int wins = 0;
                var barrier = new Barrier(8); var threads = new Thread[8];
                for (int t = 0; t < 8; t++) { threads[t] = new Thread(() => { barrier.SignalAndWait(); if (g.Take()) Interlocked.Increment(ref wins); }); threads[t].Start(); }
                foreach (var t in threads) t.Join();
                if (wins != 1) throw new Exception("FAILED:gate-race-round-" + round);
            }
            Yes(true, "gate-race-100-rounds");

            // 4. The stop file: create-only, an existing request stands, a missing directory throws; a stale one is cleared at start.
            string stop = Path.Combine(dir, "STOP-REQUESTED");
            Yes(UpgraderStopGate.RequestText(42) == "{\"contract\":\"clued.independent-ci.stop-request/1\",\"uptimeMs\":42}\n", "stop-request-text");
            Yes(UpgraderStopGate.TryCreateStopFile(stop, UpgraderStopGate.RequestText(1)), "stop-file-created");
            Yes(!UpgraderStopGate.TryCreateStopFile(stop, UpgraderStopGate.RequestText(2)) && File.ReadAllText(stop).Contains("\"uptimeMs\":1}"), "stop-file-existing-stands");
            bool threw = false; try { UpgraderStopGate.TryCreateStopFile(Path.Combine(dir, @"missing\STOP-REQUESTED"), "x"); } catch (DirectoryNotFoundException) { threw = true; }
            Yes(threw, "stop-file-missing-directory-is-an-error");
            UpgraderStopGate.ClearStale(stop); Yes(!File.Exists(stop), "stale-stop-cleared");
            UpgraderStopGate.ClearStale(stop); Yes(!File.Exists(stop), "stale-stop-clear-is-idempotent");

            // 5. Token record and exit codes.
            Yes(UpgraderTokenPrivileges.Disallowed(new[] { "SeChangeNotifyPrivilege" }, UpgraderServiceHost.AllowedPrivileges).Length == 0, "token-minimal");
            var extra = UpgraderTokenPrivileges.Disallowed(new[] { "SeTcbPrivilege", "SeChangeNotifyPrivilege", "SeImpersonatePrivilege" }, UpgraderServiceHost.AllowedPrivileges);
            Yes(extra.Length == 2 && extra[0] == "SeImpersonatePrivilege" && extra[1] == "SeTcbPrivilege", "token-extra-listed-sorted");
            Yes(UpgraderServiceHost.AllowedPrivileges.Length == 1 && UpgraderServiceHost.AllowedPrivileges[0] == "SeChangeNotifyPrivilege", "allow-list-is-change-notify-only");
            Yes(UpgraderTokenPrivileges.Json(new[] { "SeChangeNotifyPrivilege" }, 7) == "{\"contract\":\"clued.independent-ci.service-token-privileges/1\",\"service\":\"CluedCIUpgrader\",\"pid\":7,\"privileges\":[\"SeChangeNotifyPrivilege\"]}", "token-json");
            Yes(UpgraderTokenPrivileges.Current().Length > 0, "token-readable");
            string rec = Path.Combine(dir, "upgrader-token.json");
            UpgraderStopGate.WriteReplace(rec, "a\n"); UpgraderStopGate.WriteReplace(rec, "b\n");
            Yes(File.ReadAllText(rec) == "b\n" && !File.Exists(rec + ".tmp"), "token-record-replaced");
            Yes(UpgraderStopGate.ServiceExitCode(0) == 0 && UpgraderStopGate.ServiceExitCode(3) == 1064 && UpgraderStopGate.ServiceExitCode(-1) == 1064, "exit-code-mapping");
            Yes(UpgraderServiceHost.StopWaitMilliseconds == 60000, "stop-wait-60s");

            // 6. The real start path: fixed environment only.
            string envFile = Path.Combine(dir, "env.txt");
            var c1 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child dump-env \"" + envFile + "\"", env, dir); children.Add(c1);
            Yes(c1.WaitForExit(20000) && c1.WaitForExitCode() == 0, "dump-env-exit-0");
            Yes(File.ReadAllText(envFile) == "PATH=C:\\Windows\\System32;C:\\Windows\nSystemRoot=C:\\Windows\nWINDIR=C:\\Windows", "child-environment-exactly-fixed:" + File.ReadAllText(envFile).Replace("\n", "|").Replace("\\", "/"));

            // 7. No inherited handle: an inheritable event of this process is not valid in the child.
            var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
            IntPtr ev = CreateEventW(ref sa, true, false, IntPtr.Zero);
            Yes(ev != IntPtr.Zero, "inheritable-event-created");
            string handleFile = Path.Combine(dir, "handle.txt");
            var c2 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child check-handle " + ev.ToInt64() + " \"" + handleFile + "\"", env, dir); children.Add(c2);
            Yes(c2.WaitForExit(20000), "check-handle-ran");
            Yes(File.ReadAllText(handleFile) == "absent", "no-handle-inherited");
            // Control: a child started WITH inheritance sees it, so the check above can tell the difference.
            var control = Process.Start(new ProcessStartInfo(self, "--fake-child check-handle " + ev.ToInt64() + " \"" + handleFile + ".control\"") { UseShellExecute = false, CreateNoWindow = true });
            control.WaitForExit(20000);
            Yes(File.ReadAllText(handleFile + ".control") == "present", "control-inherited-handle-is-seen");
            CloseHandle(ev);

            // 8. Stop: honoured within the wait, ignored -> the job is ended, already exited -> nothing to do.
            string stopH = Path.Combine(dir, "stop-honour");
            var c3 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child honour \"" + stopH + "\"", env, dir); children.Add(c3);
            Thread.Sleep(300);
            var sw = Stopwatch.StartNew();
            Yes(UpgraderStopGate.StopChild(c3, stopH, 20000) == "exited" && sw.ElapsedMilliseconds < 15000 && c3.WaitForExitCode() == 0, "stop-honoured");
            Yes(File.Exists(stopH), "stop-file-written-by-stop");
            string stopI = Path.Combine(dir, "stop-ignore");
            var c4 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child ignore \"" + stopI + "\"", env, dir); children.Add(c4);
            Thread.Sleep(300);
            sw = Stopwatch.StartNew();
            Yes(UpgraderStopGate.StopChild(c4, stopI, 800) == "killed" && c4.HasExited && sw.ElapsedMilliseconds >= 700, "stop-ignored-killed-after-the-wait");
            Yes(c4.WaitForExitCode() == 1, "killed-exit-code-1");
            var c5 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child exit3", env, dir); children.Add(c5);
            Yes(c5.WaitForExitCode() == 3, "own-exit-code");
            Yes(UpgraderStopGate.StopChild(c5, Path.Combine(dir, "stop-none"), 1000) == "not-running" && !File.Exists(Path.Combine(dir, "stop-none")), "stop-after-exit-asks-nothing");
            // A stop file that cannot be written ends the job at once.
            var c6 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child ignore \"" + stopI + "x\"", env, dir); children.Add(c6);
            sw = Stopwatch.StartNew();
            Yes(UpgraderStopGate.StopChild(c6, Path.Combine(dir, @"missing\STOP-REQUESTED"), 20000) == "killed" && sw.ElapsedMilliseconds < 10000, "unwritable-stop-kills-at-once");

            // 9. The job: a grandchild ends with it.
            string gpid = Path.Combine(dir, "grandchild.pid");
            var c7 = UpgraderChild.Start(self, "\"" + self + "\" --fake-child spawn-grandchild \"" + gpid + "\"", env, dir); children.Add(c7);
            var until = DateTime.UtcNow.AddSeconds(20);
            while (!File.Exists(gpid) && DateTime.UtcNow < until) Thread.Sleep(50);
            Thread.Sleep(200);
            int grand = int.Parse(File.ReadAllText(gpid));
            Yes(Alive(grand), "grandchild-started");
            c7.KillJob(); c7.WaitForExit(10000);
            until = DateTime.UtcNow.AddSeconds(10);
            while (Alive(grand) && DateTime.UtcNow < until) Thread.Sleep(50);
            Yes(!Alive(grand), "grandchild-ended-with-the-job");

            Console.WriteLine("{\"status\":\"UPGRADER_HOST_PURE_PASS\",\"assertions\":" + n + "}");
            return 0;
        }
        catch (Exception e)
        {
            Console.WriteLine("{\"status\":\"UPGRADER_HOST_PURE_FAIL\",\"message\":\"" + e.Message.Replace("\\", "/").Replace("\"", "'") + "\"}");
            return 1;
        }
        finally
        {
            foreach (var c in children) { try { c.KillJob(); } catch { } }
        }
    }
}
