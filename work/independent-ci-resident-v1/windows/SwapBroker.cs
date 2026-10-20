// CluedCISwapBroker (DESIGN S1, §8.2). LocalSystem service, installed and pinned once by the Owner's
// elevated install. It is the only principal that changes the runner service's configuration, and it
// does exactly one thing: point the runner at the ONE installed generic helper (Source v2 S12), start it
// once with (nonce, configSha256), wait for it to stop, and point it back at the original binary. It
// never changes the account (always .\clued-control), start type, dependencies or DACL, never stops or
// kills anything, and runs nothing that is not the allow-listed helper.
//
// Compiled at install together with the installed Source v2 files ResidentScmV2.cs (the reviewed v1
// FixedScm checks: full stable snapshot, mutation mutex, binary-only change, one start, independent PID
// observation) and ScmPidHandshakeV2.cs (the PID ACK event, owner SYSTEM).
//
// The resident executor (NT SERVICE\CluedCIResident) talks to it through two directories:
//   broker\requests\<uuid>.json   writable by the resident SID only
//   broker\responses\<uuid>.json  writable by the broker only (plus <uuid>.taken claim markers)
// Every request is executed at most once, also across crashes and reboots: a request that predates this
// broker process, or one whose claim marker exists without an answer, is answered and never executed.
using System;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public sealed class SwapBroker : ServiceBase
{
    const string RequestContract = "clued.independent-ci.swap-broker-request/2";
    const string ResponseContract = "clued.independent-ci.swap-broker-response/2";
    const string ConfigContract = "clued.independent-ci.swap-broker-config/1";
    // Stage caps (Source v2 resident-v2/layout.mjs STAGES_V2) + 180 s margin bound every deadline.
    static readonly long[] StageMilliseconds = { 900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000 };
    static readonly Regex Hex32 = new Regex("^[0-9a-f]{32}$"), Hex64 = new Regex("^[0-9a-f]{64}$"), Uuid = new Regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
    static readonly Regex Iso = new Regex(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,7})?Z$");
    readonly string root, configSha;
    Thread worker; volatile bool stopping; DateTime startedAt;

    SwapBroker(string[] a)
    {
        ServiceName = "CluedCISwapBroker"; CanStop = true;
        if (a.Length != 2 || !Hex64.IsMatch(a[1])) throw new ArgumentException("ROOT CONFIG_SHA256");
        root = a[0]; configSha = a[1];
    }

    protected override void OnStart(string[] _) { startedAt = DateTime.UtcNow; worker = new Thread(Loop) { IsBackground = false }; worker.Start(); }
    protected override void OnStop() { stopping = true; } // finishes the current swap first; never kills

    sealed class BrokerConfig { public string OwnerSid, OriginalBinary, StableDigest, HelperName, HelperSha256; }

    static string Sha(byte[] b) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(b)).Replace("-", "").ToLowerInvariant(); }
    static string ShaFile(string path) { using (var s = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }

    // Admin-only config, pinned by hash on the broker's own command line (only Administrators can
    // change the service configuration). Read and hashed from the same bytes.
    BrokerConfig LoadConfig()
    {
        var bytes = File.ReadAllBytes(Path.Combine(root, "config", "broker.json"));
        if (bytes.Length == 0 || bytes.Length > 16384 || Sha(bytes) != configSha) throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        var v = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
        var helper = v != null && v.ContainsKey("helper") ? v["helper"] as Dictionary<string, object> : null;
        if (v == null || v.Count != 5 || (v["contract"] as string) != ConfigContract || helper == null || helper.Count != 2) throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        var c = new BrokerConfig { OwnerSid = v["ownerSid"] as string, OriginalBinary = v["originalBinary"] as string, StableDigest = v["stableDigest"] as string,
            HelperName = helper["name"] as string, HelperSha256 = helper["sha256"] as string };
        if (c.OwnerSid == null || !Regex.IsMatch(c.OwnerSid, @"^S-1-5-21-\d+-\d+-\d+-\d+$") || c.OriginalBinary == null || c.StableDigest == null || !Hex64.IsMatch(c.StableDigest)
            || c.HelperName != "controller-formal-generic-v2.exe" || c.HelperSha256 == null || !Hex64.IsMatch(c.HelperSha256)) throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        ResidentScmV2.OwnerSid = c.OwnerSid;
        return c;
    }

    string HelperBinary(BrokerConfig c) { return "\"" + Path.Combine(root, "helpers", c.HelperName) + "\""; }

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
                Dictionary<string, object> answer;
                var taken = Path.Combine(res, id + ".taken");
                if (File.Exists(taken)) answer = Refused(id, "BROKER_REQUEST_INTERRUPTED_NOT_REPEATED");
                else if (File.GetCreationTimeUtc(file) < startedAt) answer = Refused(id, "BROKER_REQUEST_PREDATES_START");
                else
                {
                    // Create-only, written through to disk, before any effect.
                    using (var t = new FileStream(taken, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.WriteThrough)) { t.WriteByte(1); t.Flush(true); }
                    try { answer = Handle(id, File.ReadAllBytes(file)); }
                    catch (BrokerRefusal r) { answer = Refused(id, r.Code); }
                    catch (Exception) { answer = Refused(id, "BROKER_UNCONFIRMED"); }
                }
                var b = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(answer));
                using (var f = new FileStream(outFile, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(b, 0, b.Length); f.Flush(true); }
            }
            Thread.Sleep(500);
        }
    }

    static Dictionary<string, object> Response(string id)
    {
        return new Dictionary<string, object> { { "contract", ResponseContract }, { "requestId", id }, { "ok", false }, { "code", null }, { "started", false }, { "startCallIssued", false },
            { "helperPid", null }, { "stoppedInTime", false }, { "restored", false }, { "accountUnchanged", false }, { "stableBefore", false }, { "stableAfter", false }, { "configurationConflict", false } };
    }
    // A refusal before any effect: the runner was not touched; restored/stable mean "still original".
    Dictionary<string, object> Refused(string id, string code)
    {
        var r = Response(id); r["code"] = code;
        try { var c = LoadConfig(); bool original = OriginalStopped(c, false); r["restored"] = original; r["accountUnchanged"] = original; r["stableBefore"] = original; r["stableAfter"] = original; }
        catch (Exception) { }
        return r;
    }

    bool OriginalStopped(BrokerConfig c, bool alreadyInSession)
    {
        if (!alreadyInSession) ResidentScmV2.BeginSession(false);
        try { return ResidentScmV2.Matches(ResidentScmV2.ReadSnapshot(), c.OriginalBinary, c.StableDigest, true); }
        finally { if (!alreadyInSession) ResidentScmV2.EndSession(); }
    }

    // If the runner is STOPPED on the installed helper (a crash between stop and restore, or a helper
    // that outlived its deadline and stopped later), put the original back. A running helper is never
    // touched; nothing but the binary path is ever changed.
    void RestoreStoppedHelper()
    {
        try
        {
            var c = LoadConfig(); var helper = HelperBinary(c);
            ResidentScmV2.BeginSession(true);
            try
            {
                var s = ResidentScmV2.ReadSnapshot();
                if (ResidentScmV2.Matches(s, helper, c.StableDigest, true)) ResidentScmV2.SwitchOnlyBinary(helper, c.OriginalBinary, c.StableDigest);
            }
            finally { ResidentScmV2.EndSession(); }
        }
        catch (Exception) { /* busy mutex or not on the helper: reported through the next swap's before-check */ }
    }

    Dictionary<string, object> Handle(string id, byte[] bytes)
    {
        if (bytes.Length == 0 || bytes.Length > 4096) throw new BrokerRefusal("BROKER_REQUEST_SIZE");
        Dictionary<string, object> v;
        try { v = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes)); } catch { throw new BrokerRefusal("BROKER_REQUEST_SHAPE"); }
        if (v == null || v.Count != 5 || !(v.ContainsKey("contract") && v.ContainsKey("stage") && v.ContainsKey("nonce") && v.ContainsKey("deadline") && v.ContainsKey("configSha256"))
            || (v["contract"] as string) != RequestContract) throw new BrokerRefusal("BROKER_REQUEST_SHAPE");
        if (!(v["stage"] is int)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        int stage = (int)v["stage"]; string nonce = v["nonce"] as string; string config = v["configSha256"] as string; string deadlineText = v["deadline"] as string;
        if (stage < 1 || stage > 8 || nonce == null || !Hex32.IsMatch(nonce) || config == null || !Hex64.IsMatch(config) || deadlineText == null || !Iso.IsMatch(deadlineText)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        DateTime deadline = DateTime.Parse(deadlineText, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal);
        if (deadline > DateTime.UtcNow.AddMilliseconds(StageMilliseconds[stage - 1] + 180000)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        if (deadline < DateTime.UtcNow.AddMinutes(2)) throw new BrokerRefusal("BROKER_REQUEST_EXPIRED");
        var c = LoadConfig();
        // The helper path is fixed, never taken from the request; its bytes must be the allow-listed ones.
        var helperPath = Path.Combine(root, "helpers", c.HelperName);
        if (ShaFile(helperPath) != c.HelperSha256) throw new BrokerRefusal("BROKER_HELPER_NOT_ALLOW_LISTED");
        return Swap(id, c, nonce, config, deadline);
    }

    Dictionary<string, object> Swap(string id, BrokerConfig c, string nonce, string configSha256, DateTime deadline)
    {
        var r = Response(id); var helper = HelperBinary(c);
        try { ResidentScmV2.BeginSession(true); }
        // Another controller tool holds the mutation mutex: nothing was changed by this request, but the
        // runner state is not known to this broker either (the resident re-reads it and HALTs).
        catch (Exception) { r["code"] = "BROKER_BUSY"; return r; }
        bool switched = false;
        try
        {
            if (!ResidentScmV2.Matches(ResidentScmV2.ReadSnapshot(), c.OriginalBinary, c.StableDigest, true)) { r["code"] = "BROKER_RUNNER_NOT_ORIGINAL_STOPPED"; return r; }
            r["stableBefore"] = true;
            ResidentScmV2.SwitchOnlyBinary(c.OriginalBinary, helper, c.StableDigest); switched = true;
            try { r["helperPid"] = (long)ResidentScmV2.StartOnce(helper, c.StableDigest, nonce, configSha256, new DateTimeOffset(deadline, TimeSpan.Zero)); r["started"] = true; }
            catch (Exception) { r["code"] = "BROKER_PID_HANDSHAKE_UNCONFIRMED"; }
            finally { r["startCallIssued"] = ResidentScmV2.StartCallIssued; if (ResidentScmV2.IndependentStartPid > 0) r["helperPid"] = (long)ResidentScmV2.IndependentStartPid; }
            // Wait for the helper to stop by itself (it enforces its own deadline and drains its tree).
            bool stopped = false;
            while (DateTime.UtcNow < deadline) { if (ResidentScmV2.ReadStatus().State == 1) { stopped = true; break; } Thread.Sleep(1000); }
            if (!stopped && ResidentScmV2.ReadStatus().State == 1) stopped = true;
            r["stoppedInTime"] = stopped;
            if (!stopped) { if (r["code"] == null) r["code"] = "BROKER_HELPER_NOT_STOPPED_IN_TIME"; return r; }
            ResidentScmV2.SwitchOnlyBinary(helper, c.OriginalBinary, c.StableDigest); switched = false;
            bool after = ResidentScmV2.Matches(ResidentScmV2.ReadSnapshot(), c.OriginalBinary, c.StableDigest, true);
            r["restored"] = after; r["accountUnchanged"] = after; r["stableAfter"] = after;
            if (!after && r["code"] == null) r["code"] = "BROKER_ORIGINAL_NOT_RESTORED";
            if (r["code"] == null && (bool)r["started"]) r["ok"] = true;
            return r;
        }
        catch (Exception)
        {
            if (r["code"] == null) r["code"] = switched ? "BROKER_ORIGINAL_NOT_RESTORED" : "BROKER_UNCONFIRMED";
            return r;
        }
        finally
        {
            r["configurationConflict"] = ResidentScmV2.HasConflict;
            if ((bool)r["configurationConflict"]) { r["ok"] = false; if (r["code"] == null) r["code"] = "BROKER_CONFIGURATION_CONFLICT"; }
            ResidentScmV2.EndSession();
        }
    }

    public static void Main(string[] args) { Run(new SwapBroker(args)); }
}

sealed class BrokerRefusal : Exception { public readonly string Code; public BrokerRefusal(string code) : base(code) { Code = code; } }
