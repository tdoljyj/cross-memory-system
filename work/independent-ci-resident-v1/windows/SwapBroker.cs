// CluedCISwapBroker (DESIGN S1, §8.2). LocalSystem service, installed and pinned once by the Owner's
// elevated install. It is the only principal that changes the runner service's configuration, and it
// does exactly one thing: point the runner at the ONE installed generic helper (Source v2 S12), start it
// once with (nonce, configSha256), wait for it to stop, and point it back at the original binary. It
// never changes the account (always .\clued-control), start type, dependencies or DACL, never kills
// anything, and runs nothing that is not the allow-listed helper. The one stop it ever sends is the Owner
// abort of DESIGN §6.5: a single SERVICE_CONTROL_STOP to the runner while it runs the helper of the swap in
// flight, asked for by a stop request bound to exactly that swap (StopRequest); the helper handles it on its
// own (STOP_REQUESTED: it drains the job object it created), and the swap then ends as usual.
//
// Compiled at install together with the installed Source v2 files ResidentScmV2.cs (the reviewed v1
// FixedScm checks: full stable snapshot, mutation mutex, binary-only change, one start, independent PID
// observation) and ScmPidHandshakeV2.cs (the PID ACK event, owner SYSTEM).
//
// The resident executor (NT SERVICE\CluedCIResident) talks to it through two directories:
//   broker\requests\<uuid>.json   writable by the resident SID only
//   broker\responses\<uuid>.json  writable by the broker only (plus <uuid>.taken claim markers)
//   broker\requests\<uuid>.stop   Owner abort: stop request of the swap <uuid>, written by the resident
//   broker\responses\<uuid>.stop.json  the broker's receipt of that stop request (create-only)
// Every request is executed at most once, also across crashes and reboots: a request that predates this
// broker process, or one whose claim marker exists without an answer, is answered and never executed.
using System;
using System.IO;
using System.Runtime.InteropServices;
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
    // C1 config /3 pins the full public node profile and original acceptance bytes.
    // Node identity never adds a mutex or runner-DACL manager (SYSTEM/Administrators only).
    const string ConfigContract = "clued.independent-ci.swap-broker-config/3";
    const int MaxRequestBytes = 4096;
    // Review MAJOR-1: LocalSystem cannot be made unprivileged by DACLs (its SID keeps every SY grant), but its
    // token privileges can be cut to these (`sc privs CluedCISwapBroker SeChangeNotifyPrivilege/SeCreateGlobalPrivilege`):
    // no SeTcb, SeDebug, SeImpersonate, SeAssignPrimaryToken, SeBackup, SeRestore, SeTakeOwnership or SeLoadDriver.
    // The broker only needs DACL-granted SCM access and its own files.
    public static readonly string[] AllowedPrivileges = { "SeChangeNotifyPrivilege", "SeCreateGlobalPrivilege" };
    // Stage caps (Source v2 resident-v2/layout.mjs STAGES_V2) + 180 s margin bound every deadline. Stage 9 is
    // stage R, the hosted relay (free-minutes design S22): the same one generic helper runs it (the helper's
    // own stage table maps 9 to the relay-publisher entry), so broker.json still pins exactly one helper.
    // Stages 1-8, stage R (9) and stage 10 (train maintenance, quota phase 2 step 3c-1), each with its run cap.
    static readonly long[] StageMilliseconds = { 900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000, 900000, 300000 };
    static readonly Regex Hex32 = new Regex("^[0-9a-f]{32}$"), Hex64 = new Regex("^[0-9a-f]{64}$"), Uuid = new Regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
    static readonly Regex Iso = new Regex(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,7})?Z$");
    readonly string root, configSha, profileSha;
    readonly NodeProfilePublicFileV2 heldConfig;
    readonly NodeProfileLeaseV2 heldProfile;
    readonly BrokerConfig installedConfig;
    Thread worker; volatile bool stopping; DateTime startedAt;

    SwapBroker(string[] a)
    {
        ServiceName = "CluedCISwapBroker"; CanStop = true;
        if (a.Length != 3 || !NodeProfileV2.Hash(a[1]) || !NodeProfileV2.Hash(a[2])) throw new ArgumentException("ROOT CONFIG_SHA256 NODE_PROFILE_SHA256");
        NodeProfileV2.RequireRoot(a[0]);root = NodeProfileV2.FixedResidentRoot; configSha = a[1];profileSha=a[2];
        // Bootstrap before dispatcher, token record, restore, mutex, identity or SCM access.
        // These two stable read leases live for the broker process, never one request only.
        heldConfig=NodeProfileV2.ReadBrokerConfig(root,configSha);
        try{
            installedConfig=ParseConfig(heldConfig.Raw,profileSha);
            heldProfile=NodeProfileV2.LoadAccepted(root,installedConfig.AcceptanceSha256,profileSha);
            if(heldProfile.Profile.CanonicalJson!=installedConfig.Node.CanonicalJson)throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        }catch{if(heldProfile!=null)heldProfile.Dispose();heldConfig.Dispose();throw;}
    }

    protected override void OnStart(string[] _)
    {
        var privileges = BrokerTokenPrivileges.Current();
        WriteTokenRecord(Path.Combine(root, "broker", "token.json"), BrokerTokenPrivileges.Json(privileges, System.Diagnostics.Process.GetCurrentProcess().Id));
        if (BrokerTokenPrivileges.Disallowed(privileges, AllowedPrivileges).Length > 0) throw new InvalidOperationException("BROKER_TOKEN_PRIVILEGES_NOT_MINIMAL");
        startedAt = DateTime.UtcNow; worker = new Thread(Loop) { IsBackground = false }; worker.Start();
    }

    // Atomic replace of the small token record (the directory is writable by this service only).
    static void WriteTokenRecord(string path, string json)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, json + "\n");
        if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
    }

    protected override void OnStop() { stopping = true; } // finishes the current swap first; never kills

    internal sealed class BrokerConfig { public string OriginalBinary, StableDigest, HelperName, HelperSha256,AcceptanceSha256;public NodeProfileV2 Node; }

    static string Sha(byte[] b) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(b)).Replace("-", "").ToLowerInvariant(); }
    static string ShaFile(string path) { using (var s = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }

    // Admin-only config, pinned by hash on the broker's own command line (only Administrators can
    // change the service configuration). Read and hashed from the same bytes.
    internal static BrokerConfig ParseConfig(byte[] bytes,string expectedProfileSha256)
    {
        if(bytes==null||bytes.Length==0||bytes.Length>16384||!NodeProfileV2.Hash(expectedProfileSha256))throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        var v = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false,true).GetString(bytes));
        var helper = v != null && v.ContainsKey("helper") ? v["helper"] as Dictionary<string, object> : null;
        if (v == null || v.Count != 7 || !v.ContainsKey("contract") || (v["contract"] as string) != ConfigContract || helper == null || helper.Count != 2
            ||!v.ContainsKey("node")||!v.ContainsKey("nodeProfileSha256")||!v.ContainsKey("acceptanceSha256")||(v["nodeProfileSha256"]as string)!=expectedProfileSha256) throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        var c = new BrokerConfig { OriginalBinary = v.ContainsKey("originalBinary") ? v["originalBinary"] as string : null, StableDigest = v.ContainsKey("stableDigest") ? v["stableDigest"] as string : null,
            HelperName = helper.ContainsKey("name") ? helper["name"] as string : null, HelperSha256 = helper.ContainsKey("sha256") ? helper["sha256"] as string : null,
            AcceptanceSha256=v["acceptanceSha256"]as string};
        if (c.OriginalBinary != "\"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe\"" || !NodeProfileV2.Hash(c.StableDigest)
            || c.HelperName != "controller-formal-generic-v2.exe" || !NodeProfileV2.Hash(c.HelperSha256)||!NodeProfileV2.Hash(c.AcceptanceSha256)) throw new BrokerRefusal("BROKER_CONFIG_CHANGED");
        try{c.Node=NodeProfileV2.FromDictionary(v["node"]as Dictionary<string,object>);if(c.Node.Sha256!=expectedProfileSha256)throw new BrokerRefusal("BROKER_CONFIG_CHANGED");}
        catch(InvalidOperationException){throw new BrokerRefusal("BROKER_CONFIG_CHANGED");}
        return c;
    }
    BrokerConfig LoadConfig(){heldConfig.Revalidate();heldProfile.Revalidate();if(installedConfig.Node.Sha256!=profileSha||NodeProfileV2.Current.Sha256!=profileSha||NodeProfileV2.AcceptanceSha256!=installedConfig.AcceptanceSha256)throw new BrokerRefusal("BROKER_CONFIG_CHANGED");return installedConfig;}

    string HelperBinary(BrokerConfig c) { return "\"" + Path.Combine(root, "helpers", c.HelperName) + "\" --acceptance-sha256 "+c.AcceptanceSha256+" --node-profile-sha256 "+c.Node.Sha256; }

    void Loop()
    {
        var req = Path.Combine(root, "broker", "requests");
        var res = Path.Combine(root, "broker", "responses");
        while (!stopping)
        {
            RestoreStoppedHelper();
            // Review MINOR-2: a transient enumeration failure (sharing violation, a vanished directory) never
            // ends the worker thread; the next pass retries.
            string[] files;
            try { files = Directory.GetFiles(req, "*.json"); } catch (Exception) { Thread.Sleep(2000); continue; }
            foreach (var file in files)
            {
              try
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
                    try { answer = Handle(id, ReadBounded(file)); }
                    catch (BrokerRefusal r) { answer = Refused(id, r.Code); }
                    catch (Exception) { answer = Refused(id, "BROKER_UNCONFIRMED"); }
                }
                var b = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(answer));
                using (var f = new FileStream(outFile, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(b, 0, b.Length); f.Flush(true); }
              }
              catch (Exception) { /* this request is answered on a later pass, or stays visible to the resident as unanswered */ }
            }
            Thread.Sleep(500);
        }
    }

    // Review MINOR-2: the size bound comes before the read; at most MaxRequestBytes + 1 bytes are ever read.
    public static byte[] ReadBounded(string path)
    {
        using (var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.None))
        {
            if (s.Length <= 0 || s.Length > MaxRequestBytes) throw new BrokerRefusal("BROKER_REQUEST_SIZE");
            var buffer = new byte[MaxRequestBytes + 1]; int total = 0, n;
            while ((n = s.Read(buffer, total, buffer.Length - total)) > 0) { total += n; if (total > MaxRequestBytes) throw new BrokerRefusal("BROKER_REQUEST_SIZE"); }
            var bytes = new byte[total]; Array.Copy(buffer, bytes, total); return bytes;
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
        if (bytes.Length == 0 || bytes.Length > MaxRequestBytes) throw new BrokerRefusal("BROKER_REQUEST_SIZE");
        Dictionary<string, object> v;
        try { v = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes)); } catch { throw new BrokerRefusal("BROKER_REQUEST_SHAPE"); }
        if (v == null || v.Count != 5 || !(v.ContainsKey("contract") && v.ContainsKey("stage") && v.ContainsKey("nonce") && v.ContainsKey("deadline") && v.ContainsKey("configSha256"))
            || (v["contract"] as string) != RequestContract) throw new BrokerRefusal("BROKER_REQUEST_SHAPE");
        if (!(v["stage"] is int)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        int stage = (int)v["stage"]; string nonce = v["nonce"] as string; string config = v["configSha256"] as string; string deadlineText = v["deadline"] as string;
        if (stage < 1 || stage > StageMilliseconds.Length || nonce == null || !Hex32.IsMatch(nonce) || config == null || !Hex64.IsMatch(config) || deadlineText == null || !Iso.IsMatch(deadlineText)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        DateTime deadline = DateTime.Parse(deadlineText, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal);
        if (deadline > DateTime.UtcNow.AddMilliseconds(StageMilliseconds[stage - 1] + 180000)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        if (deadline < DateTime.UtcNow.AddMinutes(2)) throw new BrokerRefusal("BROKER_REQUEST_EXPIRED");
        var c = LoadConfig();
        // The helper path is fixed, never taken from the request; its bytes must be the allow-listed ones.
        var helperPath = Path.Combine(root, "helpers", c.HelperName);
        if (ShaFile(helperPath) != c.HelperSha256) throw new BrokerRefusal("BROKER_HELPER_NOT_ALLOW_LISTED");
        return Swap(id, c, stage, nonce, config, deadline);
    }

    // Owner abort (DESIGN §6.5), checked once a second while the helper of this swap runs. Returns true once the
    // stop request is settled (sent, refused or no longer needed), false to look again next second: the helper is still
    // starting or younger than StopRequest.GraceSeconds (StopRequest.Decide), or a read, a status query or the control
    // call failed in a way that may pass (the resident may still be writing the request; a sharing violation; a
    // momentary SCM error). Those are tried for StopAttempts seconds, then settled with a refusal code.
    const int StopAttempts = 10;
    bool TryOwnerStop(string id, int stage, string nonce, string configSha256, DateTime startedHelperAt, ref int attempts)
    {
        var file = Path.Combine(root, "broker", "requests", id + ".stop");
        if (!File.Exists(file)) return false;
        string code;
        try
        {
            StopRequest.Validate(ReadBounded(file), id, nonce, stage, configSha256);
            var s = ResidentScmV2.ReadStatus();
            var decision = StopRequest.Decide(s.State, s.Pid, ResidentScmV2.IndependentStartPid, (DateTime.UtcNow - startedHelperAt).TotalSeconds);
            if (decision == null) return false;
            if (decision != "SEND") code = decision;
            else if (RunnerStop.Send()) code = "STOP_SENT";
            // Not accepted: look again. A control that did reach the helper (an answer lost in a timeout) normally shows as
            // STOP_PENDING or STOPPED next second and settles as HELPER_ALREADY_STOPPING. If the helper's handler was held
            // up past the SCM timeout it may be sent again; that is harmless: the handler only sets its cancelled flag and
            // terminates the same job object it created. Effective once.
            else if (++attempts < StopAttempts) return false;
            else code = "STOP_NOT_ACCEPTED";
        }
        catch (BrokerRefusal r)
        {
            // A request still being written reads as a size or shape refusal for a moment; every other refusal is final.
            if ((r.Code == "BROKER_STOP_SHAPE" || r.Code == "BROKER_REQUEST_SIZE") && ++attempts < StopAttempts) return false;
            code = r.Code == "BROKER_REQUEST_SIZE" ? "BROKER_STOP_SHAPE" : r.Code;
        }
        catch (Exception)
        {
            if (++attempts < StopAttempts) return false;
            code = "BROKER_STOP_UNCONFIRMED";
        }
        try
        {
            var receipt = new Dictionary<string, object> { { "contract", StopRequest.ReceiptContract }, { "requestId", id }, { "code", code }, { "at", DateTime.UtcNow.ToString("o") } };
            var b = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(receipt));
            using (var f = new FileStream(Path.Combine(root, "broker", "responses", id + ".stop.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(b, 0, b.Length); f.Flush(true); }
        }
        catch (Exception) { /* the swap answer and the helper's own receipt remain the evidence */ }
        return true;
    }

    Dictionary<string, object> Swap(string id, BrokerConfig c, int stage, string nonce, string configSha256, DateTime deadline)
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
            // Wait for the helper to stop by itself (it enforces its own deadline and drains its tree), or after the
            // one SERVICE_CONTROL_STOP of an Owner abort of this very swap (TryOwnerStop).
            bool stopped = false, stopSettled = !(bool)r["started"]; int stopAttempts = 0; var startedHelperAt = DateTime.UtcNow;
            while (DateTime.UtcNow < deadline)
            {
                if (ResidentScmV2.ReadStatus().State == 1) { stopped = true; break; }
                if (!stopSettled) stopSettled = TryOwnerStop(id, stage, nonce, configSha256, startedHelperAt, ref stopAttempts);
                Thread.Sleep(1000);
            }
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

    // "--stable-digest": install-time, read-only (see ResidentScmV2.InstallTimeStableDigest); the
    // elevated install pins the printed digest into config\broker.json. Any other argv is the service.
    public static void Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--stable-digest") {
            if(args.Length!=4||!NodeProfileV2.Hash(args[2])||!NodeProfileV2.Hash(args[3]))throw new ArgumentException("--stable-digest ROOT ACCEPTANCE_SHA256 NODE_PROFILE_SHA256");
            using(var profile=NodeProfileV2.LoadAccepted(args[1],args[2],args[3]))Console.Out.WriteLine(ResidentScmV2.InstallTimeStableDigest());return;
        }
        Run(new SwapBroker(args));
    }
}

sealed class BrokerRefusal : Exception { public readonly string Code; public BrokerRefusal(string code) : base(code) { Code = code; } }

// Owner abort (DESIGN §6.5): the stop request the resident writes next to the broker request of the swap in flight.
// Pure (BrokerPureTests): exactly five fields, all equal to THIS swap's values, and a scanner-issuer stage only (the
// stages that publish no check); the resident's own copy of the rule is classify.mjs#ABORTABLE_IN_FLIGHT.
public static class StopRequest
{
    public const string Contract = "clued.independent-ci.swap-broker-stop/1";
    public const string ReceiptContract = "clued.independent-ci.swap-broker-stop-receipt/1";
    public static readonly int[] AbortableStages = { 2, 4, 6 };
    public const double GraceSeconds = 5;
    // Pure: what to do with a valid stop request this second, from the runner's status (state, pid) and the PID this
    // broker observed at the start. null = look again next second (still starting, or inside the grace after the start,
    // which keeps a stop away from the moment the helper creates its job); "SEND" = send the one SERVICE_CONTROL_STOP;
    // anything else settles the request with that code.
    public static string Decide(uint state, uint pid, uint independentPid, double secondsSinceStart)
    {
        if (state == 2 || secondsSinceStart < GraceSeconds) return null;
        if (state == 1 || state == 3) return "HELPER_ALREADY_STOPPING";
        if (state != 4 || pid == 0 || pid != independentPid) return "BROKER_STOP_NOT_THIS_HELPER";
        return "SEND";
    }
    public static void Validate(byte[] bytes, string requestId, string nonce, int stage, string configSha256)
    {
        Dictionary<string, object> v;
        try { v = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes)); } catch { throw new BrokerRefusal("BROKER_STOP_SHAPE"); }
        if (v == null || v.Count != 5 || !(v.ContainsKey("contract") && v.ContainsKey("requestId") && v.ContainsKey("nonce") && v.ContainsKey("stage") && v.ContainsKey("configSha256"))
            || (v["contract"] as string) != Contract || !(v["stage"] is int)) throw new BrokerRefusal("BROKER_STOP_SHAPE");
        if ((v["requestId"] as string) != requestId || (v["nonce"] as string) != nonce || (int)v["stage"] != stage || (v["configSha256"] as string) != configSha256) throw new BrokerRefusal("BROKER_STOP_NOT_THIS_SWAP");
        if (Array.IndexOf(AbortableStages, stage) < 0) throw new BrokerRefusal("BROKER_STOP_STAGE_NOT_ABORTABLE");
    }
}

// The one control the broker may send: SERVICE_CONTROL_STOP to the runner service, through a handle opened with
// SERVICE_STOP | SERVICE_QUERY_STATUS only. LocalSystem holds that right through the runner DACL (SY); the resident
// and every other non-management principal hold none (ResidentScmV2.ValidateServiceSecurity).
static class RunnerStop
{
    [StructLayout(LayoutKind.Sequential)] struct ServiceStatus { public uint Type, State, Accept, Exit, Specific, Check, Hint; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool ControlService(IntPtr service, uint control, out ServiceStatus status);
    [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
    public static bool Send()
    {
        IntPtr manager = OpenSCManagerW(null, null, 1 /* SC_MANAGER_CONNECT */);
        if (manager == IntPtr.Zero) return false;
        try
        {
            IntPtr service = OpenServiceW(manager, ResidentScmV2.Name, 0x20 /* SERVICE_STOP */ | 0x4 /* SERVICE_QUERY_STATUS */);
            if (service == IntPtr.Zero) return false;
            try { ServiceStatus status; return ControlService(service, 1 /* SERVICE_CONTROL_STOP */, out status); }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
}

// Review MAJOR-1: the effective privileges of this process token. The install sets the service's required
// privileges (`sc privs`), so the SCM strips every other privilege; the host re-checks the real token at
// start, refuses to run with anything else, and records what it has for verify and the install receipt.
public static class BrokerTokenPrivileges
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
