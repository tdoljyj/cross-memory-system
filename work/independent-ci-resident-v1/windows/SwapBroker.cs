// CluedCISwapBroker (DRAFT, independent review M2). LocalSystem service, installed and pinned once by
// the Owner's elevated install. It is the only principal that changes the runner service's
// configuration, and it can do exactly one thing: point the runner at one of the INSTALLED,
// hash-allow-listed generic stage helpers, start it once with a nonce, wait for it to stop, and
// point it back at the original binary. It never changes the service account (always
// .\clued-control), the start type, dependencies or the DACL, and it never kills anything.
//
// The resident executor (NT SERVICE\CluedCIResident) talks to it through two directories:
//   broker\requests\<uuid>.json   writable by the resident SID only
//   broker\responses\<uuid>.json  writable by the broker only
// So a compromised resident can at most start a reviewed helper with its own job inputs; it cannot
// reach SYSTEM or run arbitrary code as clued-control. Source v2 S13 makes the helpers generic (they
// read their expected config digest from the request instead of a per-batch compiled literal).
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class SwapBroker : ServiceBase
{
    const string Runner = "actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02";
    const string Original = "\"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe\"";
    static readonly Regex Account = new Regex(@"^(\.|TURING)\\clued-control$", RegexOptions.IgnoreCase);
    static readonly Regex Hex32 = new Regex("^[0-9a-f]{32}$"), Hex64 = new Regex("^[0-9a-f]{64}$"), Uuid = new Regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
    readonly string root, helpersDir, allowListSha;
    Thread worker; volatile bool stopping;

    SwapBroker(string[] a)
    {
        ServiceName = "CluedCISwapBroker"; CanStop = true;
        if (a.Length != 3) throw new ArgumentException("ROOT HELPERS_DIR ALLOW_LIST_SHA");
        root = a[0]; helpersDir = a[1]; allowListSha = a[2];
    }

    DateTime startedAt;
    protected override void OnStart(string[] _) { startedAt = DateTime.UtcNow; worker = new Thread(Loop) { IsBackground = false }; worker.Start(); }
    protected override void OnStop() { stopping = true; } // finishes the current swap first; never kills

    void Loop()
    {
        var req = Path.Combine(root, "broker", "requests");
        var res = Path.Combine(root, "broker", "responses");
        while (!stopping)
        {
            RestoreStoppedHelper();
            foreach (var file in Directory.GetFiles(req, "*.json"))
            {
                var id = Path.GetFileNameWithoutExtension(file);
                var outFile = Path.Combine(res, id + ".json");
                if (!Uuid.IsMatch(id) || File.Exists(outFile)) continue;
                string answer;
                // Exactly-once across crashes and reboots (fourth review, MAJOR 3): a request that
                // already existed when this broker process started, or one that was taken but never
                // answered (the swap was interrupted), is answered as stale and NEVER executed.
                var taken = Path.Combine(res, id + ".taken");
                if (File.Exists(taken)) answer = "{\"ok\":false,\"code\":\"BROKER_REQUEST_INTERRUPTED_NOT_REPEATED\"}";
                else if (File.GetCreationTimeUtc(file) < startedAt) answer = "{\"ok\":false,\"code\":\"BROKER_REQUEST_PREDATES_START\"}";
                else
                {
                    // Create-only, written through to disk, before any effect.
                    using (var t = new FileStream(taken, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.WriteThrough)) { t.WriteByte(1); t.Flush(true); }
                    try { answer = Handle(File.ReadAllBytes(file)); }
                    catch (BrokerRefusal r) { answer = "{\"ok\":false,\"code\":\"" + r.Code + "\"}"; }
                    catch (Exception) { answer = "{\"ok\":false,\"code\":\"BROKER_UNCONFIRMED\"}"; }
                }
                using (var f = new FileStream(outFile, FileMode.CreateNew, FileAccess.Write)) { var b = Encoding.UTF8.GetBytes(answer); f.Write(b, 0, b.Length); f.Flush(true); }
            }
            Thread.Sleep(500);
        }
    }

    // If the runner is STOPPED on one of the installed helper binaries (a crash between stop and
    // restore, or a helper that outlived its deadline and stopped later), put the original back.
    // A running helper is never touched; the account and all other settings are never changed.
    void RestoreStoppedHelper()
    {
        try
        {
            var cfg = Scm.Query(Runner);
            if (cfg.Binary == Original || !Account.IsMatch(cfg.Account)) return;
            if (!cfg.Binary.StartsWith("\"" + helpersDir + "\\controller-formal-stage-", StringComparison.OrdinalIgnoreCase)) return;
            using (var sc = new ServiceController(Runner)) { sc.Refresh(); if (sc.Status != ServiceControllerStatus.Stopped) return; }
            using (var m = new Mutex(false, @"Global\CluedCISwapBrokerV1"))
            {
                if (!m.WaitOne(TimeSpan.FromSeconds(5))) return;
                try { Scm.SetBinaryOnly(Runner, Original); } finally { m.ReleaseMutex(); }
            }
        }
        catch (Exception) { /* reported through the next swap's before-check */ }
    }

    static string Sha(string path)
    {
        using (var s = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var h = SHA256.Create())
            return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
    }

    string Handle(byte[] bytes)
    {
        if (bytes.Length == 0 || bytes.Length > 4096) throw new BrokerRefusal("BROKER_REQUEST_SIZE");
        System.Collections.Generic.Dictionary<string, object> v;
        try { v = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(Encoding.UTF8.GetString(bytes)); } catch { throw new BrokerRefusal("BROKER_REQUEST_SHAPE"); }
        if (v == null || v.Count != 5 || !(v.ContainsKey("contract") && v.ContainsKey("stage") && v.ContainsKey("nonce") && v.ContainsKey("deadline") && v.ContainsKey("configSha256"))
            || (v["contract"] as string) != "clued.independent-ci.swap-broker-request/1") throw new BrokerRefusal("BROKER_REQUEST_SHAPE");
        int stage = Convert.ToInt32(v["stage"]); string nonce = v["nonce"] as string; string config = v["configSha256"] as string;
        DateTime deadline = DateTime.Parse(v["deadline"] as string).ToUniversalTime();
        if (stage < 1 || stage > 8 || nonce == null || !Hex32.IsMatch(nonce) || config == null || !Hex64.IsMatch(config) || deadline > DateTime.UtcNow.AddHours(2)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        // A deadline that is too close is refused too (a request found after a restart is already
        // refused in Loop, before Handle is called).
        if (deadline < DateTime.UtcNow.AddMinutes(2)) throw new BrokerRefusal("BROKER_REQUEST_EXPIRED");
        // The helper path is derived from the stage, never taken from the request; the installed
        // allow-list must name exactly this helper with exactly this hash.
        var allow = Path.Combine(root, "config", "helpers-allow-list.json"); // admin-only, pinned at install
        if (Sha(allow) != allowListSha) throw new BrokerRefusal("BROKER_ALLOW_LIST_CHANGED");
        var name = "controller-formal-stage-" + stage.ToString("00") + "-v2.exe";
        var helper = Path.Combine(helpersDir, name);
        var entry = "{\"name\":\"" + name + "\",\"sha256\":\"" + Sha(helper) + "\"}";
        if (!File.ReadAllText(allow).Contains(entry)) throw new BrokerRefusal("BROKER_HELPER_NOT_ALLOW_LISTED");
        using (var m = new Mutex(false, @"Global\CluedCISwapBrokerV1"))
        {
            if (!m.WaitOne(TimeSpan.FromMinutes(1))) throw new BrokerRefusal("BROKER_BUSY");
            try { return Swap(helper, nonce, config, deadline); } finally { m.ReleaseMutex(); }
        }
    }

    // S12 input contract: the generic helper receives the nonce and the expected digest of the
    // public stage inputs as its two start arguments, and verifies those inputs itself.
    string Swap(string helper, string nonce, string configSha256, DateTime deadline)
    {
        using (var sc = new ServiceController(Runner))
        {
            var before = Scm.Query(Runner);
            if (before.Binary != Original || before.StartType != 3 || !Account.IsMatch(before.Account) || sc.Status != ServiceControllerStatus.Stopped) throw new BrokerRefusal("BROKER_RUNNER_NOT_ORIGINAL_STOPPED");
            Scm.SetBinaryOnly(Runner, "\"" + helper + "\"");
            bool started = false, stoppedInTime = false;
            try
            {
                sc.Start(new[] { nonce, configSha256 }); started = true;
                while (DateTime.UtcNow < deadline) { sc.Refresh(); if (sc.Status == ServiceControllerStatus.Stopped) { stoppedInTime = true; break; } Thread.Sleep(1000); }
            }
            finally
            {
                sc.Refresh();
                // Restore only when the helper has stopped; a still-running helper is left alone and
                // reported (the resident classifies it UNKNOWN and HALTs).
                if (sc.Status == ServiceControllerStatus.Stopped) Scm.SetBinaryOnly(Runner, Original);
            }
            var after = Scm.Query(Runner);
            bool restored = after.Binary == Original && Account.IsMatch(after.Account) && after.StartType == 3;
            return "{\"ok\":" + (started && stoppedInTime && restored ? "true" : "false") + ",\"started\":" + (started ? "true" : "false") + ",\"stoppedInTime\":" + (stoppedInTime ? "true" : "false") + ",\"restored\":" + (restored ? "true" : "false") + ",\"accountUnchanged\":" + (Account.IsMatch(after.Account) ? "true" : "false") + "}";
        }
    }

    public static void Main(string[] args) { Run(new SwapBroker(args)); }
}

sealed class BrokerRefusal : Exception { public readonly string Code; public BrokerRefusal(string code) : base(code) { Code = code; } }

static class Scm
{
    public sealed class Config { public string Binary, Account; public int StartType; }
    const uint SERVICE_NO_CHANGE = 0xffffffff, SC_MANAGER_CONNECT = 1, SERVICE_QUERY_CONFIG = 1, SERVICE_CHANGE_CONFIG = 2;
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenSCManagerW(string m, string d, uint a);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenServiceW(IntPtr h, string n, uint a);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CloseServiceHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ChangeServiceConfigW(IntPtr h, uint type, uint start, uint error, string bin, string group, IntPtr tag, string deps, string account, string password, string display);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryServiceConfigW(IntPtr h, IntPtr buf, int size, out int needed);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct QSC { public uint type, start, error; public string bin, group; public uint tag; public string deps, account, display; }

    static IntPtr Open(string name, uint access, out IntPtr scm)
    {
        scm = OpenSCManagerW(null, null, SC_MANAGER_CONNECT); if (scm == IntPtr.Zero) throw new Win32Exception();
        var h = OpenServiceW(scm, name, access); if (h == IntPtr.Zero) { CloseServiceHandle(scm); throw new Win32Exception(); }
        return h;
    }

    // Binary path only: every other parameter is SERVICE_NO_CHANGE / null, so the account, password,
    // start type, error control, group and dependencies cannot change through this call.
    public static void SetBinaryOnly(string name, string bin)
    {
        IntPtr scm; var h = Open(name, SERVICE_CHANGE_CONFIG, out scm);
        try { if (!ChangeServiceConfigW(h, SERVICE_NO_CHANGE, SERVICE_NO_CHANGE, SERVICE_NO_CHANGE, bin, null, IntPtr.Zero, null, null, null, null)) throw new Win32Exception(); }
        finally { CloseServiceHandle(h); CloseServiceHandle(scm); }
    }

    public static Config Query(string name)
    {
        IntPtr scm; var h = Open(name, SERVICE_QUERY_CONFIG, out scm);
        try
        {
            int need; QueryServiceConfigW(h, IntPtr.Zero, 0, out need);
            var buf = Marshal.AllocHGlobal(need);
            try { if (!QueryServiceConfigW(h, buf, need, out need)) throw new Win32Exception(); var q = (QSC)Marshal.PtrToStructure(buf, typeof(QSC)); return new Config { Binary = q.bin, Account = q.account, StartType = (int)q.start }; }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally { CloseServiceHandle(h); CloseServiceHandle(scm); }
    }
}
