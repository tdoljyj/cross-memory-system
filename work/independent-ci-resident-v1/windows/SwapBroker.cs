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
using System.Security.AccessControl;
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
    // Stage caps (Source v2 resident-v2/layout.mjs STAGES_V2) + 180 s margin bound every deadline: stages 1-8 and the
    // maintenance stages 10-12. Stage 9 is a reserved number (the hosted relay, removed; DESIGN §76): cap 0, never runnable.
    static readonly long[] StageMilliseconds = { 900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000, 0, 300000, 60000, 300000 };
    public static bool RuntimeStageValid(int stage) { return stage >= 1 && stage <= StageMilliseconds.Length && StageMilliseconds[stage - 1] > 0; }
    static readonly Regex Hex32 = new Regex("^[0-9a-f]{32}$"), Hex64 = new Regex("^[0-9a-f]{64}$"), Uuid = new Regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
    static readonly Regex Iso = new Regex(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,7})?Z$");
    readonly string root, configSha, profileSha;
    readonly NodeProfilePublicFileV2 heldConfig;
    readonly NodeProfileLeaseV2 heldProfile;
    readonly BrokerConfig installedConfig;
    Thread worker; volatile bool stopping; DateTime startedAt;
    readonly ManualResetEvent stopped=new ManualResetEvent(false);

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
        WritePublicRecord(Path.Combine(root, "broker", "token.json"), BrokerTokenPrivileges.Json(privileges, System.Diagnostics.Process.GetCurrentProcess().Id));
        if (BrokerTokenPrivileges.Disallowed(privileges, AllowedPrivileges).Length > 0) throw new InvalidOperationException("BROKER_TOKEN_PRIVILEGES_NOT_MINIMAL");
        new Thread(delegate() {
            DateTime nextProbe=DateTime.MinValue;
            while(!stopping) {
                var observation=RenewalKey.SelfCheck(() => {
                    using(var id=System.Security.Principal.WindowsIdentity.GetCurrent()) return id.User.Value;
                }, () => RenewalGateway.ActiveReceipt(root));
                try { WritePublicRecord(Path.Combine(root,"broker","renew-key.json"),Renewal.Json(observation)); } catch(Exception) { }
                if(observation["provider"]!=null && DateTime.UtcNow>=nextProbe && Interlocked.CompareExchange(ref renewalBusy,1,0)==0) {
                    try {
                        foreach(string kind in new[]{"ci","upgrade"}) ObserveConnection(kind);
                        nextProbe=DateTime.UtcNow.AddDays(1);
                    } finally {Interlocked.Exchange(ref renewalBusy,0);}
                }
                if(stopped.WaitOne(TimeSpan.FromMinutes(10))) return;
            }
        }) {IsBackground=true}.Start();
        startedAt = DateTime.UtcNow; worker = new Thread(Loop) { IsBackground = false }; worker.Start();
    }

    // Atomic replace of the small token record (the directory is writable by this service only).
    internal static void WritePublicRecord(string path, string json)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, json + "\n");
        if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
    }

    protected override void OnStop() { stopping = true; stopped.Set(); } // finishes the current swap first; never kills

    internal sealed class BrokerConfig { public string OriginalBinary, StableDigest, HelperName, HelperSha256,AcceptanceSha256;public NodeProfileV2 Node; }

    static string Sha(byte[] b) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(b)).Replace("-", "").ToLowerInvariant(); }
    internal static string ShaFile(string path) { using (var s = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }

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

    // M2a (DESIGN 65.3.6): poll constants. Request intake 500 -> 100 ms and stop watch 1000 -> 200 ms cut about 1.2 s from
    // every swap. RestoreStoppedHelper (an SCM session per pass) keeps its old 500 ms cadence so the SCM query rate is unchanged;
    // only the cheap directory listing runs faster. The loop stays one thread; requests are still handled one at a time.
    public const int RequestPollMs = 100, StopPollMs = 200, RestoreIntervalMs = 500;

    void Loop()
    {
        var req = Path.Combine(root, "broker", "requests");
        var res = Path.Combine(root, "broker", "responses");
        var sinceRestore = System.Diagnostics.Stopwatch.StartNew(); bool firstPass = true;
        while (!stopping)
        {
            if (firstPass || sinceRestore.ElapsedMilliseconds >= RestoreIntervalMs) { firstPass = false; RestoreStoppedHelper(); sinceRestore.Restart(); }
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
                if (!Uuid.IsMatch(id) || id==renewalRequestId || File.Exists(outFile)) continue;
                Dictionary<string, object> answer;
                var taken = Path.Combine(res, id + ".taken");
                if (File.Exists(taken)) {
                    try { answer = InterruptedRenewal(id,ReadBounded(file)); } catch { answer = null; }
                    if(answer==null) answer = Refused(id,"BROKER_REQUEST_INTERRUPTED_NOT_REPEATED");
                }
                else if (File.GetCreationTimeUtc(file) < startedAt) answer = Refused(id, "BROKER_REQUEST_PREDATES_START");
                else
                {
                    // Create-only, written through to disk, before any effect.
                    using (var t = new FileStream(taken, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.WriteThrough)) { t.WriteByte(1); t.Flush(true); }
                    try {
                        var bytes=ReadBounded(file);
                        answer=Dispatch(bytes,kind=>StartRenewal(id,kind,outFile),()=>Handle(id,bytes));
                        if(answer==null) continue;
                    }
                    catch (BrokerRefusal r) { answer = Refused(id, r.Code); }
                    catch (Exception) { answer = Refused(id, "BROKER_UNCONFIRMED"); }
                }
                var b = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(answer));
                using (var f = new FileStream(outFile, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(b, 0, b.Length); f.Flush(true); }
              }
              catch (Exception) { /* this request is answered on a later pass, or stays visible to the resident as unanswered */ }
            }
            Thread.Sleep(RequestPollMs);
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


    internal static Dictionary<string,object> Dispatch(byte[] bytes,Action<string> schedule,Func<Dictionary<string,object>> swap) {
        string kind=Renewal.MatchKind(bytes);
        if(kind==null) return swap();
        schedule(kind); return null;
    }
    internal static Dictionary<string,object> InterruptedRenewal(string id,byte[] bytes) {
        string kind=Renewal.MatchKind(bytes);
        if(kind==null) return null;
        return new Dictionary<string,object>{{"contract",RenewResponse},{"requestId",id},{"kind",kind},{"code","RENEW_INTERRUPTED"}};
    }
    void ObserveConnection(string kind) {
        string code=null;Renewal.Connection result=null;
        try {
            var config=LoadConfig();
            using(var key=RenewalKey.Open()) {
                var store=new RenewalFiles(root,kind,config.Node.ControllerSid);
                var gateway=RenewalGateway.Open(root,config,kind,key);
                // Only a previously admitted request can leave an intent. After a restart the old
                // token may already be revoked, making a fresh local role probe impossible.
                if(store.Read("intent")!=null)
                    result=gateway.Run(store,null,standbyConfirmation);
                else result=gateway.Probe(Renewal.Digest(Renewal.Token(store.Read("token"))));
            }
        } catch(BrokerRefusal refusal) {code=refusal.Code;}catch {code="RENEW_UNAVAILABLE";}
        try {WritePublicRecord(Path.Combine(root,"broker","renew-"+kind+".json"),Renewal.Json(new {
            at=Renewal.Stamp(DateTime.UtcNow),code=code,bindingId=result==null?null:result.Binding,expiresAt=result==null?null:Renewal.Stamp(result.Expires),
            renewalWindowOpensAt=result==null?null:result.WindowStamp,onDuty=kind=="ci" && result!=null && result.OnDuty
        }));} catch {}
    }
    int renewalBusy;
    readonly Renewal.StandbyConfirmation standbyConfirmation = new Renewal.StandbyConfirmation();
    volatile string renewalRequestId;
    const string RenewResponse="clued.independent-ci.connection-renew-response/1";
    void StartRenewal(string id,string kind,string outFile) {
        // Slow HTTPS or a TPM failure cannot occupy the SCM swap worker. Only one journal writer at a time.
        if(Interlocked.CompareExchange(ref renewalBusy,1,0)!=0) {
            WritePublicRecord(outFile,Renewal.Json(new {contract=RenewResponse,requestId=id,kind=kind,code="RENEW_BUSY"}));
            return;
        }
        try {
            renewalRequestId=id;
            new Thread(delegate() {
                string code="RENEW_UNAVAILABLE";BrokerRefusal rejection=null;Renewal.Connection result=null;
                try {
                    var config=LoadConfig();
                    using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent()) Renewal.Require(identity.IsSystem,"RENEW_IDENTITY_KEY_UNAVAILABLE");
                    using(var key=RenewalKey.Open()) {
                        var gateway=RenewalGateway.Open(root,config,kind,key);
                        result=gateway.Run(new RenewalFiles(root,kind,config.Node.ControllerSid),id,standbyConfirmation);
                    }
                    code=null;
                } catch(BrokerRefusal refusal) {code=refusal.Code;rejection=refusal;}
                catch(CryptographicException) {code="RENEW_IDENTITY_KEY_UNAVAILABLE";}
                catch(Exception) {code="RENEW_UNAVAILABLE";}
                try {
                    WritePublicRecord(outFile,Renewal.Json(new {contract=RenewResponse,requestId=id,kind=kind,code=code,
                        outcome=result==null?null:result.Outcome,confirmationId=result==null?null:result.ConfirmationId,
                        effectiveAt=result==null?null:result.EffectiveAt,renewalWindowOpensAt=result==null?null:result.WindowStamp,
                        grantRequestId=rejection==null?null:rejection.GrantRequestId,retryAfterSeconds=rejection==null?null:rejection.RetryAfterSeconds,
                        bindingId=result==null?null:result.Binding,expiresAt=result==null?null:Renewal.Stamp(result.Expires)}));
                } catch(Exception) { /* A new daily request recovers through the private intent. */ }
                finally {renewalRequestId=null;Interlocked.Exchange(ref renewalBusy,0);}
            }) { IsBackground=true }.Start();
        } catch {renewalRequestId=null;Interlocked.Exchange(ref renewalBusy,0);throw;}
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
        if (!RuntimeStageValid(stage) || nonce == null || !Hex32.IsMatch(nonce) || config == null || !Hex64.IsMatch(config) || deadlineText == null || !Iso.IsMatch(deadlineText)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        DateTime deadline = DateTime.Parse(deadlineText, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal);
        if (deadline > DateTime.UtcNow.AddMilliseconds(StageMilliseconds[stage - 1] + 180000)) throw new BrokerRefusal("BROKER_REQUEST_FIELDS");
        if (deadline < DateTime.UtcNow.AddMinutes(2)) throw new BrokerRefusal("BROKER_REQUEST_EXPIRED");
        var c = LoadConfig();
        // The helper path is fixed, never taken from the request; its bytes must be the allow-listed ones.
        var helperPath = Path.Combine(root, "helpers", c.HelperName);
        if (ShaFile(helperPath) != c.HelperSha256) throw new BrokerRefusal("BROKER_HELPER_NOT_ALLOW_LISTED");
        return Swap(id, c, stage, nonce, config, deadline);
    }

    // Owner abort (DESIGN §6.5), checked every StopPollMs (200 ms) while the helper of this swap runs. Returns true once the
    // stop request is settled (sent, refused or no longer needed), false to look again on the next poll: the helper is still
    // starting or younger than StopRequest.GraceSeconds (StopRequest.Decide), or a read, a status query or the control
    // call failed in a way that may pass (the resident may still be writing the request; a sharing violation; a
    // momentary SCM error). Those are tried for StopAttempts polls (10 s), then settled with a refusal code.
    const int StopAttempts = 50; // 50 x StopPollMs (200 ms) = the same 10 s window as the former 10 x 1 s
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
                Thread.Sleep(StopPollMs);
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
        if(args.Length==1 && args[0]=="--renew-key-check") {
            Console.WriteLine(Renewal.Json(RenewalKeyAccessV2.Observation()));return;
        }
        if(args.Length==1 && args[0]=="--renew-companion-check") {
            var v=RenewalKeyAccessV2.Observation();
            foreach(string name in new[]{"ci-admission.token","ci-admission.connection.json"}) {
                string path=Path.Combine(Path.GetDirectoryName(NodeProfileV2.FixedResidentRoot),"secrets",name);
                v[name]=Renewal.FileAccessObservation(path);
            }
            Console.WriteLine(Renewal.Json(v));return;
        }
        if (args.Length > 0 && args[0] == "--stable-digest") {
            if(args.Length!=4||!NodeProfileV2.Hash(args[2])||!NodeProfileV2.Hash(args[3]))throw new ArgumentException("--stable-digest ROOT ACCEPTANCE_SHA256 NODE_PROFILE_SHA256");
            using(var profile=NodeProfileV2.LoadAccepted(args[1],args[2],args[3]))Console.Out.WriteLine(ResidentScmV2.InstallTimeStableDigest());return;
        }
        Run(new SwapBroker(args));
    }
}


// Both production adapters below are fixed by the installation. The resident can select only a lane.
internal static class Renewal
{
    internal sealed class Connection {
        public string Project, Node, Binding, Receipt, Outcome, ConfirmationId, EffectiveAt;
        public bool OnDuty;
        public long Generation;
        public DateTime Expires;
        public DateTime? WindowOpens;
        public string WindowStamp { get { return WindowOpens.HasValue ? Stamp(WindowOpens.Value) : null; } }
    }
    internal sealed class Context {
        public string Kind, Identity, Fingerprint, BaselineBinding, BaselinePin;
    }
    // 两次投递的正文都只有 kind。常驻确认待命且排空后才回投此编号，过期或 Broker 重启须重新探询。
    internal sealed class StandbyConfirmation {
        string id, project, node, binding, hash;
        long generation;
        DateTime until;
        internal bool Confirm(string requestId, Connection old, string currentHash, DateTime now) {
            bool confirmed = id != null && requestId == id && now < until && project == old.Project &&
                node == old.Node && binding == old.Binding && generation == old.Generation && hash == currentHash;
            id = null;
            if (confirmed) return true;
            id = Guid.NewGuid().ToString("D");
            project = old.Project; node = old.Node; binding = old.Binding; generation = old.Generation;
            hash = currentHash; until = now.AddMinutes(2);
            old.Outcome = "confirm-standby"; old.ConfirmationId = id;
            return false;
        }
    }
    internal sealed class Intent {
        public string Kind, Identity, Fingerprint, Project, Node, Binding, OldHash, Token, Previous, At;
        public long Generation;
        public string Receipt;
    }
    internal abstract class Store {
        public abstract string Read(string slot);
        public abstract void Put(string slot, string value);
        public virtual void Place(string record,string token,string oldRecord,string oldToken) {
            if(record!=null && oldRecord!=record) Put("record",record);
            if(oldToken!=token) Put("token",token);
        }
        public abstract void ClearIntent();
    }
    internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false,true);
    internal static string Digest(string value) { return NodeProfileV2.HashBytes(Utf8.GetBytes(value)); }
    internal static string Pin(string token) { return Digest("clued.independent-ci.ci-binding-pin/1\0" + token); }
    internal static string Base64Url(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_'); }
    internal static bool Id(string value) { Guid g; return value != null && Guid.TryParseExact(value,"D",out g) && value == g.ToString("D") && g != Guid.Empty; }
    internal static void Require(bool ok, string code) { if (!ok) throw new BrokerRefusal(code); }
    internal static string Stamp(DateTime t) { return t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",System.Globalization.CultureInfo.InvariantCulture); }
    static string NewToken() {
        var bytes = new byte[32];
        try { using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); return "clued_bnd_" + Base64Url(bytes); }
        finally { Array.Clear(bytes,0,bytes.Length); }
    }
    internal static string MatchKind(byte[] raw) {
        // A single literal field. Refuse duplicate keys before JavaScriptSerializer could collapse them.
        var m = Regex.Match(Encoding.UTF8.GetString(raw), @"\A[ \t\r\n]*\{[ \t\r\n]*""kind""[ \t\r\n]*:[ \t\r\n]*""(ci|upgrade)""[ \t\r\n]*\}[ \t\r\n]*\z");
        return m.Success ? m.Groups[1].Value : null;
    }
    internal static string FileAccessObservation(string path) {
        try { using(File.Open(path,FileMode.Open,FileAccess.Read,FileShare.Read)) return "OPEN"; }
        catch(FileNotFoundException) { return "ABSENT"; }
        catch(DirectoryNotFoundException) { return "ABSENT"; }
        catch(UnauthorizedAccessException) { return "DENIED"; }
        catch(IOException) { return "UNKNOWN"; }
        catch(System.Security.SecurityException) { return "UNKNOWN"; }
    }
    internal static string Token(string raw) {
        string t = raw == null ? "" : raw.Trim(' ','\t','\n','\r','\v','\f');
        Require(Regex.IsMatch(t,@"\Aclued_bnd_[a-zA-Z0-9_-]{8,480}\z"),"RENEW_CURRENT_TOKEN_REFUSED");
        return t;
    }
    internal static string Json(object value) { return new JavaScriptSerializer().Serialize(value); }
    internal static Dictionary<string,object> Object(string text) {
        var serializer=new JavaScriptSerializer { MaxJsonLength=262144, RecursionLimit=24 };
        var value=serializer.Deserialize<Dictionary<string,object>>(text);
        Require(value!=null,"RENEW_DOCUMENT_REFUSED");
        // The Framework decoder accepts duplicate members. Count decoded property names in each object.
        var objects=new Stack<HashSet<string>>();
        for(int i=0;i<text.Length;i++) {
            char ch=text[i];
            if(ch=='{') objects.Push(new HashSet<string>(StringComparer.Ordinal));
            else if(ch=='}') objects.Pop();
            else if(ch=='"') {
                int start=i;
                while(++i<text.Length && text[i]!='"') if(text[i]=='\\') i++;
                int next=i+1;while(next<text.Length && char.IsWhiteSpace(text[next])) next++;
                if(next<text.Length && text[next]==':')
                    Require(objects.Peek().Add(serializer.Deserialize<string>(text.Substring(start,i-start+1))),"RENEW_DOCUMENT_REFUSED");
            } else if(ch=='\'') throw new BrokerRefusal("RENEW_DOCUMENT_REFUSED");
        }
        return value;
    }
    internal static string Str(Dictionary<string,object> d, string k) {
        object v; return d != null && d.TryGetValue(k,out v) ? v as string : null;
    }
    internal static long Number(Dictionary<string,object> d,string k) {
        object n; if(d==null || !d.TryGetValue(k,out n) || !(n is int || n is long)) return -1;
        long value=Convert.ToInt64(n);return value<=9007199254740991L ? value : -1;
    }
    internal static DateTime Expires(string text) {
        DateTimeOffset d;
        Require(text != null && Regex.IsMatch(text,@"\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)\z"),"RENEW_CONNECTION_MISMATCH");
        if(!DateTimeOffset.TryParse(text,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out d))
            throw new BrokerRefusal("RENEW_CONNECTION_MISMATCH");
        return d.UtcDateTime;
    }

    static bool WindowOpen(Connection old,DateTime now) {
        Require(old.WindowOpens.HasValue && old.WindowOpens.Value<=old.Expires,"RENEW_CONNECTION_MISMATCH");
        return now>=old.WindowOpens.Value;
    }
    internal static Connection Run(Context ctx, Store store, Func<DateTime> clock, Func<string,Connection> probe,
        Func<Intent,string,Connection> renew, Action<string,Connection> verify, Func<Connection,string,bool> prepareCi,
        Func<Intent,string,Connection> recover=null)
    {
        string raw = store.Read("intent");
        string originalToken=store.Read("token");
        string actual = raw==null ? Token(originalToken) : originalToken.Trim();
        string record = store.Read("record");
        string recordHash = record == null ? null : Digest(record);
        string currentHash = Digest(actual);
        Intent intent;
        Connection next=null;
        if (raw == null) {
            var old = probe(currentHash);
            Require(Id(old.Project) && Id(old.Node) && Id(old.Binding) && old.Generation > 0,"RENEW_CONNECTION_MISMATCH");
            if(ctx.Kind == "ci") {
                if(record != null) {
                    var previous=Object(record);
                    var sorted=new SortedDictionary<string,object>(previous,StringComparer.Ordinal);
                    Require(previous.Count==8 && previous.ContainsKey("previousSha256") && Json(sorted)==record &&
                        (previous["previousSha256"]==null || NodeProfileV2.Hash(Str(previous,"previousSha256"))) &&
                        Id(Str(previous,"rebindReceiptId")) && Stamp(Expires(Str(previous,"activatedAt")))==Str(previous,"activatedAt") &&
                        Str(previous,"contract")=="clued.independent-ci.ci-connection/1" && Str(previous,"baseNodeIdentitySha256")==ctx.Identity &&
                        Str(previous,"bindingId")==old.Binding && Number(previous,"bindingGeneration")==old.Generation && Str(previous,"tokenPinSha256")==Pin(actual),
                        "RENEW_CURRENT_TOKEN_REFUSED");
                } else if(ctx.BaselineBinding!=null) {
                    Require(old.Binding==ctx.BaselineBinding && Pin(actual)==ctx.BaselinePin,"RENEW_CURRENT_TOKEN_REFUSED");
                }
            }
            if(!WindowOpen(old,clock())) return old;
            if (ctx.Kind == "ci" && !prepareCi(old,currentHash)) return old;
            intent = new Intent { Kind=ctx.Kind, Identity=ctx.Identity, Project=old.Project, Fingerprint=ctx.Fingerprint,
                Node=old.Node, Binding=old.Binding, Generation=old.Generation, OldHash=currentHash,
                Token=NewToken(), Previous=recordHash, At=Stamp(clock()) };
            // The only copy enabling recovery after the server commits must reach durable storage first.
            raw=Json(intent);
            store.Put("intent",raw);
        } else {
            intent = new JavaScriptSerializer().Deserialize<Intent>(raw);
            Require(intent!=null && intent.Kind==ctx.Kind && intent.Identity==ctx.Identity && intent.Fingerprint==ctx.Fingerprint &&
                Id(intent.Project) && Id(intent.Node) && Id(intent.Binding) && intent.Generation>0 && NodeProfileV2.Hash(intent.OldHash) &&
                (intent.Previous==null || NodeProfileV2.Hash(intent.Previous)) && Stamp(Expires(intent.At))==intent.At &&
                Token(intent.Token)==intent.Token && (intent.Receipt==null || Id(intent.Receipt)),"RENEW_INTENT_CHANGED");
            // The staged random value identifies this attempt. An authenticated successor can finish a
            // lost reply or partial placement even when the old proof can no longer be replayed.
            try { next=recover==null ? probe(Digest(intent.Token)) : recover(intent,Digest(intent.Token)); }
            catch(BrokerRefusal e) { if(e.Code!="RENEW_PROOF_REFUSED") throw; }
            if(next==null) {
                Require(intent.Receipt==null,"RENEW_INTENT_CHANGED");
                Require(currentHash==intent.OldHash && recordHash==intent.Previous,"RENEW_INTENT_CHANGED");
                Connection old=null;
                try { old=probe(intent.OldHash); }
                catch(BrokerRefusal refusal) {
                    // D1 found immutable history for the old binding. Only replaying the exact
                    // staged replacement distinguishes a superseded attempt from an unusable successor.
                    if(refusal.Code!="RENEW_REPLACEMENT_UNUSABLE") throw;
                }
                if(old!=null) {
                    Require(old.Project==intent.Project && old.Node==intent.Node && old.Binding==intent.Binding &&
                        old.Generation==intent.Generation,"RENEW_INTENT_CHANGED");
                    if(!WindowOpen(old,clock()) || (ctx.Kind=="ci" && !prepareCi(old,currentHash))) return old;
                }
            }
        }
        string nextHash=Digest(intent.Token);
        bool recovered=next!=null;
        if(!recovered) {
            try { next=renew(intent,nextHash); }
            catch(BrokerRefusal e) {
                // Only this synchronous replacement used the hashes and generation in raw.
                // Discovery, verification and yield refusals never enter this handler.
                if(e.ConfirmedNotRenewed && store.Read("intent")==raw) store.ClearIntent();
                throw;
            }
        }
        Require(next.Project==intent.Project && next.Node==intent.Node && Id(next.Binding) && next.Binding!=intent.Binding &&
            next.Generation==intent.Generation+1 && next.Expires>clock(),"RENEW_CONNECTION_MISMATCH");
        if(recovered && ctx.Kind=="upgrade" && next.Receipt==null) next.Receipt=intent.Receipt;
        Require(Id(next.Receipt) || (recovered && ctx.Kind=="upgrade" && next.Receipt==null),"RENEW_CONNECTION_MISMATCH");
        Require(intent.Receipt==null || intent.Receipt==next.Receipt,"RENEW_CONNECTION_MISMATCH");
        verify(nextHash,next);
        if(ctx.Kind=="upgrade" && intent.Receipt==null && next.Receipt!=null) {
            // Discovery has no upgrade receipt in D1. Retain a received receipt across subsequent disk faults.
            intent.Receipt=next.Receipt;
            store.Put("intent",Json(intent));
        }
        string nextRecord=null;
        if(ctx.Kind=="ci") {
            nextRecord=Json(new SortedDictionary<string,object>(StringComparer.Ordinal) {
                {"contract","clued.independent-ci.ci-connection/1"},{"activatedAt",intent.At},{"baseNodeIdentitySha256",ctx.Identity},
                {"bindingGeneration",next.Generation},{"bindingId",next.Binding},{"previousSha256",intent.Previous},
                {"rebindReceiptId",next.Receipt},{"tokenPinSha256",Pin(intent.Token)}
            });
        } else {
            nextRecord=Json(new SortedDictionary<string,object>(StringComparer.Ordinal) {
                {"contract","clued.independent-ci.upgrade-connection/1"},{"baseNodeIdentitySha256",ctx.Identity},
                {"bindingGeneration",next.Generation},{"bindingId",next.Binding},{"receiptId",next.Receipt},{"tokenPinSha256",Pin(intent.Token)}
            });
        }
        // The old binding is already revoked. A failed rename, readback or journal removal
        // leaves a recoverable prefix of the new files; never republish the old bytes.
        store.Place(nextRecord,intent.Token,record,originalToken);
        Require(store.Read("token")==intent.Token && store.Read("record")==nextRecord,"RENEW_READBACK_FAILED");
        store.ClearIntent();
        return next;
    }
}

internal sealed class RenewalKey : IDisposable
{

    readonly CngKey key;
    internal readonly string Fingerprint, Provider;
    RenewalKey(CngKey value, string provider) {
        key=value; Provider=provider;
        var blob=key.Export(CngKeyBlobFormat.EccPublicBlob);
        Renewal.Require(Admit(key.IsMachineKey,key.Algorithm.Algorithm,key.ExportPolicy,blob)==null,"RENEW_IDENTITY_KEY_UNAVAILABLE");
        var x=new byte[32];var y=new byte[32];Array.Copy(blob,8,x,0,32);Array.Copy(blob,40,y,0,32);
        Fingerprint=Renewal.Digest("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\""+Renewal.Base64Url(x)+"\",\"y\":\""+Renewal.Base64Url(y)+"\"}");
    }

    internal static string Admit(bool isMachineKey, string algorithmName, CngExportPolicies exportPolicy, byte[] publicBlob) {
        return isMachineKey && algorithmName==CngAlgorithm.ECDsaP256.Algorithm && exportPolicy==CngExportPolicies.None &&
            publicBlob.Length==72 && BitConverter.ToUInt32(publicBlob,0)==0x31534345 && BitConverter.ToUInt32(publicBlob,4)==32
            ? null : "RENEW_IDENTITY_KEY_UNAVAILABLE";
    }

    internal static Dictionary<string,object> SelfCheck(Func<string> identify, Action checkReceipt, Func<string,CngKey> open=null) {
        string sid=null, provider=null;
        try {
            string identity=identify();
            using(var key=Open(open)) {
                sid=identity;
                if(sid=="S-1-5-18") {
                    checkReceipt();
                    key.Sign("clued.ci.renew-key-selfcheck/1");
                    provider=key.Provider;
                }
            }
        } catch(Exception) { /* report only the refusal */ }
        return new Dictionary<string,object> {
            {"at",Renewal.Stamp(DateTime.UtcNow)},{"sid",sid},{"provider",provider},
            {"code",provider==null?"RENEW_IDENTITY_KEY_UNAVAILABLE":null}
        };
    }

    internal static RenewalKey Open(Func<string,CngKey> open=null) {
        if(open==null) open=provider=>CngKey.Open(RenewalKeyAccessV2.Name,new CngProvider(provider),RenewalKeyAccessV2.Flags);
        foreach(string provider in RenewalKeyAccessV2.Providers) {
            CngKey key;
            try { key=open(provider); }
            catch(CryptographicException e) { if(RenewalKeyAccessV2.Absent(e.HResult)) continue; break; }
            try { return new RenewalKey(key,provider); } catch { key.Dispose(); break; }
        }
        throw new BrokerRefusal("RENEW_IDENTITY_KEY_UNAVAILABLE");
    }

    [DllImport("ncrypt.dll")]
    static extern int NCryptSignHash(Microsoft.Win32.SafeHandles.SafeNCryptKeyHandle key,IntPtr padding,
        byte[] digest,int size,byte[] signature,int capacity,out int used,int flags);
    internal static byte[] SignatureHash(string canonical) {
        using(var sha=SHA256.Create()) return sha.ComputeHash(Renewal.Utf8.GetBytes(canonical));
    }
    internal string Sign(string canonical) {
        byte[] hash=SignatureHash(canonical);
        byte[] signature=new byte[64];int length;
        // SignHash on .NET Framework passes zero native flags. Keep the hardware operation itself silent.
        using(var handle=key.Handle)
            Renewal.Require(NCryptSignHash(handle,IntPtr.Zero,hash,hash.Length,signature,signature.Length,out length,0x40)==0 &&
                length==64,"RENEW_IDENTITY_KEY_UNAVAILABLE");
        using(var verify=CngKey.Import(key.Export(CngKeyBlobFormat.EccPublicBlob),CngKeyBlobFormat.EccPublicBlob))
        using(var ec=new ECDsaCng(verify)) Renewal.Require(ec.VerifyHash(hash,signature),"RENEW_IDENTITY_KEY_UNAVAILABLE");
        return Renewal.Base64Url(signature);
    }
    public void Dispose() { key.Dispose(); }
}

internal sealed class RenewalFiles : Renewal.Store
{
    readonly Action<string> checkParents;
    readonly Func<string,FileSecurity> forCreation;
    readonly Func<FileSecurity,byte[]> descriptorOf;
    readonly string dir, file, controller, publicPin;
    readonly bool ci;
    static FileSecurity ForCreation(string sddl) {
        var security=new FileSecurity();
        security.SetSecurityDescriptorSddlForm(sddl);
        return security;
    }
    static byte[] DescriptorOf(FileSecurity security) { return security.GetSecurityDescriptorBinaryForm(); }
    internal RenewalFiles(string root,string kind,string sid) : this(root,kind,sid,CheckParents,ForCreation,DescriptorOf) {}
    internal RenewalFiles(string root,string kind,string sid,Action<string> parents,
        Func<string,FileSecurity> create,Func<FileSecurity,byte[]> descriptor) {
        checkParents=parents; forCreation=create; descriptorOf=descriptor;
        ci=kind=="ci";controller=sid;
        publicPin=Path.Combine(root,"install","resident-upgrade.connection.json");
        dir=Path.Combine(ci ? Path.GetDirectoryName(root) : root,"secrets");
        file=Path.Combine(dir,ci ? "ci-admission.token" : "resident-upgrade.token");
        if(ci) {
            checkParents(file);
            try {File.GetAttributes(Path.Combine(dir,"ci-admission.connection.json.pending"));throw new BrokerRefusal("RENEW_PRIOR_ACTIVATION_PENDING");}
            catch(FileNotFoundException) { /* No outstanding activation from the previous generation. */ }
        }
    }
    string Target(string slot) {
        if(slot=="intent") return file+".renew-pending";
        if(slot=="token") return file;
        if(slot=="record") return ci ? Path.Combine(dir,"ci-admission.connection.json") : publicPin;
        throw new BrokerRefusal("RENEW_PRIVATE_PATH_REFUSED");
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
        public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
    }
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle h,out Info info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool MoveFileExW(string source,string target,int flags);
    internal static void CheckParents(string file) {
        for(var d=Path.GetDirectoryName(file);d!=null;d=Path.GetDirectoryName(d)) {
            var attr=File.GetAttributes(d);
            Renewal.Require((attr&(FileAttributes.Directory|FileAttributes.ReparsePoint))==FileAttributes.Directory,"RENEW_PRIVATE_PATH_REFUSED");
            NodeProfilePublicFileV2.ValidateBootstrapAcl(Directory.GetAccessControl(d).GetSecurityDescriptorBinaryForm(),d);
        }
    }
    internal static string ReadProtected(string file,int max,bool optional,string reader,bool secret) {
        return ReadProtected(file,max,optional,reader,secret,CheckParents,DescriptorOf);
    }
    static string ReadProtected(string file,int max,bool optional,string reader,bool secret,Action<string> checkParents,Func<FileSecurity,byte[]> descriptorOf) {
        checkParents(file);
        try {
            var attr=File.GetAttributes(file);
            Renewal.Require((attr&(FileAttributes.Directory|FileAttributes.ReparsePoint))==0,"RENEW_PRIVATE_PATH_REFUSED");
            using(var f=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                Info info;
                Renewal.Require(GetFileInformationByHandle(f.SafeFileHandle,out info) && info.Links==1 && f.Length>0 && f.Length<=max,"RENEW_PRIVATE_PATH_REFUSED");
                var descriptor=descriptorOf(f.GetAccessControl());
                NodeProfilePublicFileV2.ValidateBootstrapAcl(descriptor,file);
                if(secret) {
                    var acl=new RawSecurityDescriptor(descriptor,0);
                    bool reads=false;
                    foreach(System.Security.AccessControl.CommonAce ace in acl.DiscretionaryAcl) {
                        if(ace.AceQualifier!=System.Security.AccessControl.AceQualifier.AccessAllowed ||
                           ((uint)ace.AccessMask&0x90000001u)==0) continue;
                        string sid=ace.SecurityIdentifier.Value;
                        Renewal.Require(sid=="S-1-5-18" || sid=="S-1-5-32-544" || sid==reader,"RENEW_PRIVATE_ACL_REFUSED");
                        if(sid==reader) reads=true;
                    }
                    Renewal.Require(reader==null || reads,"RENEW_PRIVATE_ACL_REFUSED");
                }
                var data=new byte[(int)f.Length];
                try {
                    int n=0;while(n<data.Length) { int read=f.Read(data,n,data.Length-n);if(read==0) throw new EndOfStreamException(); n+=read; }
                    return Renewal.Utf8.GetString(data);
                } finally { Array.Clear(data,0,data.Length); }
            }
        } catch(FileNotFoundException) { if(optional) return null;throw; }
    }
    public override string Read(string slot) {
        return ReadProtected(Target(slot),slot=="intent"?8192:4096,slot!="token",ci&&slot!="intent"?controller:null,ci||slot!="record",checkParents,descriptorOf);
    }
    string Stage(string slot,string value) {
        string path=Target(slot), tmp=path+".renew-new",reader=ci&&slot!="intent"?controller:null;
        checkParents(path);
        bool publicRecord=!ci && slot=="record";
        var security=forCreation(publicRecord ? "O:SYG:SYD:P(A;;FA;;;SY)(A;;FR;;;BA)(A;;FR;;;AU)"
            : "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)"+(reader==null?"":"(A;;FR;;;"+reader+")"));
        // Only administrators can replace children here. A torn staging write contains no remote commit by itself.
        if(File.Exists(tmp)) File.Delete(tmp);
        var bytes=Renewal.Utf8.GetBytes(value);
        try {
            using(var f=new FileStream(tmp,FileMode.CreateNew,System.Security.AccessControl.FileSystemRights.Write,
                FileShare.None,4096,FileOptions.WriteThrough,security)) { f.Write(bytes,0,bytes.Length);f.Flush(true); }
            Renewal.Require(ReadProtected(tmp,8192,false,reader,!publicRecord,checkParents,descriptorOf)==value,"RENEW_READBACK_FAILED");
            return tmp;
        } catch { File.Delete(tmp);throw; }
        finally { Array.Clear(bytes,0,bytes.Length); }
    }
    void Publish(string staged,string slot) {
        Renewal.Require(MoveFileExW(staged,Target(slot),9),"RENEW_ATOMIC_MOVE_FAILED");
    }
    public override void Put(string slot,string value) {
        string staged=Stage(slot,value);
        try {Publish(staged,slot);} finally {File.Delete(staged);}
    }
    public override void Place(string record,string token,string oldRecord,string oldToken) {
        string stagedRecord=null,stagedToken=null;
        try {
            string originalToken=Read("token");
            Renewal.Require(originalToken==oldToken && Read("record")==oldRecord,"RENEW_INTENT_CHANGED");
            if(record!=oldRecord) stagedRecord=Stage("record",record);
            if(originalToken!=token) stagedToken=Stage("token",token);
            if(stagedRecord!=null) Publish(stagedRecord,"record");
            if(stagedToken!=null) Publish(stagedToken,"token");
        } finally {
            if(stagedToken!=null) File.Delete(stagedToken);
            if(stagedRecord!=null) File.Delete(stagedRecord);
        }
    }
    public override void ClearIntent() { File.Delete(Target("intent")); }
}

internal sealed class RenewalPolicy
{
    internal const string FileName="ci-connection-renew.contract.json";
    readonly HashSet<string> codes=new HashSet<string>(StringComparer.Ordinal);
    internal RenewalPolicy(string json) {
        const string error="RENEW_CONTRACT_REFUSED";
        var doc=Renewal.Object(json);
        object value;
        var clear=doc.TryGetValue("clear_intent",out value) ? value as Dictionary<string,object> : null;
        Renewal.Require(Renewal.Str(doc,"contract")=="clued.ci-connection-renew/1" && clear!=null &&
            Renewal.Str(clear,"operation")=="replacement" && clear.TryGetValue("requires_renewed_false",out value) && Equals(value,true) &&
            clear.TryGetValue("requires_same_serialized_intent",out value) && Equals(value,true),error);
        var list=clear.TryGetValue("codes",out value) ? value as System.Collections.IList : null;
        Renewal.Require(list!=null && list.Count>0,error);
        foreach(object item in list) {
            string code=item as string;
            Renewal.Require(code!=null && Regex.IsMatch(code,@"\A[A-Z_]{3,80}\z") && codes.Add(code),error);
        }
    }
    internal bool CanClear(string code) { return codes.Contains(code); }
}

internal sealed class RenewalGateway
{
    const string Route="https://kooyumi.pixelgrav.com/v1/ci/node/renew";
    readonly string rpc, publicKey, scope;
    readonly Func<string,string> sign;
    readonly Func<string,string,string,Dictionary<string,object>> post;
    internal readonly Renewal.Context Context;
    internal static RenewalGateway Open(string root,SwapBroker.BrokerConfig config,string kind,RenewalKey key) {
        RenewalPolicy policy;
        var receipt=ActiveReceipt(root,out policy);
        var raw=RenewalFiles.ReadProtected(Path.Combine(root,@"record\installation.json"),262144,false,null,false);
        Renewal.Require(Renewal.Digest(raw)==Renewal.Str(receipt,"installationSha256"),"RENEW_INSTALL_CHANGED");
        var installation=Renewal.Object(raw);
        Renewal.Require(Renewal.Str(receipt,"acceptanceSha256")==config.AcceptanceSha256 && Renewal.Str(installation,"acceptanceSha256")==config.AcceptanceSha256 &&
            Renewal.Str(receipt,"nodeProfileSha256")==config.Node.Sha256,"RENEW_INSTALL_CHANGED");
        return new RenewalGateway(installation,Renewal.Str(receipt,"nodeIdentitySha256"),kind,key.Fingerprint,key.Sign,
            (url,publishable,body)=>Post(url,publishable,body,policy));
    }
    internal RenewalGateway(Dictionary<string,object> installation,string identity,string kind,string fingerprint,
        Func<string,string> sign,Func<string,string,string,Dictionary<string,object>> post) {
        this.sign=sign;this.post=post;
        scope=Renewal.Str(installation,"scope");
        rpc=Renewal.Str(installation,"supabaseUrl");publicKey=Renewal.Str(installation,"publishableKey");
        Renewal.Require((scope=="global" || (scope!=null && scope.StartsWith("project:",StringComparison.Ordinal) && Renewal.Id(scope.Substring(8)))) &&
            rpc!=null && Regex.IsMatch(rpc,@"\Ahttps://[a-z0-9]+\.supabase\.co\z") && publicKey!=null &&
            Regex.IsMatch(publicKey,@"\Asb_publishable_[A-Za-z0-9_-]+\z"),"RENEW_INSTALL_CHANGED");
        Context=new Renewal.Context {Kind=kind,Identity=identity,Fingerprint=fingerprint,
            BaselineBinding=Renewal.Str(installation,"ciPrincipalBindingId"),BaselinePin=Renewal.Str(installation,"ciTokenPinSha256")};
        Renewal.Require(NodeProfileV2.Hash(Context.Identity) && NodeProfileV2.Hash(Context.BaselinePin) && Renewal.Id(Context.BaselineBinding),"RENEW_INSTALL_CHANGED");
    }
    internal static Dictionary<string,object> ActiveReceipt(string root) {
        RenewalPolicy policy;
        return ActiveReceipt(root,out policy);
    }
    static Dictionary<string,object> ActiveReceipt(string root,out RenewalPolicy policy) {
        string pointer=RenewalFiles.ReadProtected(Path.Combine(root,@"upgrade\current.json"),16384,false,null,false);
        var current=Renewal.Object(pointer);
        string raw=RenewalFiles.ReadProtected(Path.Combine(root,@"install\install-receipt.json"),262144,false,null,false);
        Renewal.Require(Renewal.Digest(raw)==Renewal.Str(current,"installReceiptSha256"),"RENEW_GENERATION_NOT_PINNED");
        var receipt=Renewal.Object(raw);
        policy=CheckGeneration(root,current,receipt);
        return receipt;
    }
    internal static RenewalPolicy CheckGeneration(string root,Dictionary<string,object> current,Dictionary<string,object> receipt) {
        string digest=Renewal.Str(current,"residentManifestSha256");
        string binary=Path.Combine(root,"bin","SwapBroker.exe");
        Renewal.Require(NodeProfileV2.Hash(digest) && Renewal.Str(receipt,"residentManifestSha256")==digest &&
            String.Equals(typeof(SwapBroker).Assembly.Location,binary,StringComparison.OrdinalIgnoreCase) &&
            SwapBroker.ShaFile(binary)==Renewal.Str(receipt,"SwapBrokerSha256"),"RENEW_GENERATION_NOT_PINNED");
        string raw=RenewalFiles.ReadProtected(Path.Combine(root,"config","resident-installed-manifest.json"),262144,false,null,false);
        Renewal.Require(Renewal.Digest(raw)==digest,"RENEW_GENERATION_NOT_PINNED");
        var manifest=new JavaScriptSerializer().DeserializeObject(raw) as Dictionary<string,object>;
        var rows=manifest["files"] as object[];
        string expected=null, contractHash=null;
        foreach(var row in rows) {
            var entry=row as Dictionary<string,object>;
            if(Renewal.Str(entry,"path")=="windows/"+RenewalPolicy.FileName) {
                Renewal.Require(contractHash==null,"RENEW_GENERATION_NOT_PINNED");
                contractHash=Renewal.Str(entry,"sha256");
                Renewal.Require(NodeProfileV2.Hash(contractHash),"RENEW_GENERATION_NOT_PINNED");
            }
            if(Renewal.Str(entry,"path")!="windows/SwapBroker.cs") continue;
            Renewal.Require(expected==null,"RENEW_GENERATION_NOT_PINNED");
            expected=Renewal.Str(entry,"sha256");
        }
        Renewal.Require(NodeProfileV2.Hash(expected) && SwapBroker.ShaFile(Path.Combine(root,"bin","SwapBroker.cs"))==expected &&
            SwapBroker.ShaFile(Path.Combine(root,"resident",digest,"windows","SwapBroker.cs"))==expected,"RENEW_GENERATION_NOT_PINNED");
        string contract=RenewalFiles.ReadProtected(Path.Combine(root,"resident",digest,"windows",RenewalPolicy.FileName),16384,false,null,false);
        Renewal.Require(Renewal.Digest(contract)==contractHash,"RENEW_GENERATION_NOT_PINNED");
        return new RenewalPolicy(contract);
    }
    const string SelfContract="clued.ci.connection-self/1";
    Dictionary<string,object> Self(string hash) {
        var reply=post(rpc+"/rest/v1/rpc/clued_ci_connection_self_v1",publicKey,
            Renewal.Json(new { p_token_hash=hash, p_input=new {scope=scope} }));
        Renewal.Require(Renewal.Str(reply,"status")=="ok" && Renewal.Str(reply,"contract")==SelfContract &&
            reply.ContainsKey("node") && Renewal.Id(Renewal.Str(reply,"binding_id")),"RENEW_CONNECTION_MISMATCH");
        Renewal.Expires(Renewal.Str(reply,"connection_expires_at"));return reply;
    }
    static Dictionary<string,object> Child(Dictionary<string,object> doc,string field) {
        object v;return doc.TryGetValue(field,out v)?v as Dictionary<string,object>:null;
    }
    internal static SortedDictionary<string,object> Unsigned(string project,string node,string kind,string fingerprint,string binding,
        long? generation,string oldHash,string next,string issued,bool yieldDuty=false) {
        var body=new SortedDictionary<string,object>(StringComparer.Ordinal) {
            {"contract","clued.ci-connection-renew/1"},{"project_id",project},{"node_id",node},{"kind",kind},{"identity_fingerprint",fingerprint},
            {"old_binding_id",binding},{"old_token_hash",oldHash},{"generation",generation},{"new_token_hash",next},{"issued_at",issued}
        };
        if(yieldDuty) body.Add("action","yield");
        return body;
    }
    Dictionary<string,object> Call(string project,string node,string binding,long? generation,string hash,string next,bool yieldDuty=false) {
        var body=Unsigned(project,node,Context.Kind,Context.Fingerprint,binding,generation,hash,next,Renewal.Stamp(DateTime.UtcNow),yieldDuty);
        body["signature"]=sign(Renewal.Json(body));
        Dictionary<string,object> reply;
        try { reply=post(Route,null,Renewal.Json(body)); }
        catch(BrokerRefusal e) {
            if(next==null && e.Code=="RENEW_PENDING_APPROVAL") throw new BrokerRefusal("RENEW_GATEWAY_REFUSED");
            throw;
        }
        Renewal.Require(Renewal.Str(reply,"status")==(next==null && !yieldDuty?"ok":"committed"),"RENEW_GATEWAY_REFUSED");
        return reply;
    }
    static Dictionary<string,object> Post(string url,string publishable,string body,RenewalPolicy policy) {
        // Old Framework application defaults may offer only TLS 1.0. Preserve the OS default when available.
        if((int)System.Net.ServicePointManager.SecurityProtocol!=0)
            System.Net.ServicePointManager.SecurityProtocol=System.Net.SecurityProtocolType.Tls12;
        var request=System.Net.WebRequest.CreateHttp(url);
        request.Method="POST";request.AllowAutoRedirect=false;request.UseDefaultCredentials=false;
        request.Timeout=10000;request.ReadWriteTimeout=10000;request.ContentType="application/json";
        if(publishable!=null) {request.Headers["apikey"]=publishable;request.Headers["Authorization"]="Bearer "+publishable;}
        var data=Renewal.Utf8.GetBytes(body);
        try {
            using(var send=request.GetRequestStream())send.Write(data,0,data.Length);
            System.Net.HttpWebResponse res;
            try {res=(System.Net.HttpWebResponse)request.GetResponse();}
            catch(System.Net.WebException e) {res=e.Response as System.Net.HttpWebResponse;if(res==null)throw new BrokerRefusal("RENEW_GATEWAY_UNAVAILABLE");}
            using(res) {
                if((int)res.StatusCode==503) throw new BrokerRefusal("RENEW_GATEWAY_UNAVAILABLE");
                using(var stream=res.GetResponseStream()) {
                    byte[] bytes=new byte[16385];int n=0;
                    while(n<bytes.Length) {int count=stream.Read(bytes,n,bytes.Length-n);if(count==0)break;n+=count;}
                    Renewal.Require(n>0 && n<bytes.Length,"RENEW_GATEWAY_REFUSED");
                    return DecodeResponse((int)res.StatusCode,Renewal.Utf8.GetString(bytes,0,n),policy);
                }
            }
        } catch(BrokerRefusal){throw;}catch{throw new BrokerRefusal("RENEW_GATEWAY_UNAVAILABLE");}
        finally {request.Abort();}
    }
    internal static Dictionary<string,object> DecodeResponse(int status,string json,RenewalPolicy policy) {
        if(status==503) throw new BrokerRefusal("RENEW_GATEWAY_UNAVAILABLE");
        var doc=Renewal.Object(json);
        if(status==202) {
            long seconds=Renewal.Number(doc,"retry_after_seconds");
            string id=Renewal.Str(doc,"request_id");
            Renewal.Require(Renewal.Str(doc,"status")=="pending_approval" && Renewal.Id(id) && seconds>0 && seconds<=Int32.MaxValue,"RENEW_GATEWAY_REFUSED");
            throw new BrokerRefusal("RENEW_PENDING_APPROVAL",false,id,(int)seconds);
        }
        if(status!=200) {
            string code=Renewal.Str(doc,"error_code");
            Renewal.Require(Renewal.Str(doc,"status")=="rejected","RENEW_GATEWAY_REFUSED");
            // The original code passes through in the gateway's one shape (review N1): no copy of the server's code table here.
            // Clearing an intent still depends on the installed contract's clear_intent.codes only.
            Renewal.Require(code!=null && Regex.IsMatch(code,@"\A[A-Z_]{3,80}\z"),"RENEW_GATEWAY_REFUSED");
            object renewed;
            if(status==409 && policy.CanClear(code))
                throw new BrokerRefusal(code,doc.TryGetValue("renewed",out renewed) && Equals(renewed,false));
            throw new BrokerRefusal(code);
        }
        return doc;
    }
    Dictionary<string,object> CiNode(string hash,out Dictionary<string,object> self) {
        self=Self(hash);
        var n=Child(self,"node");
        Renewal.Require(n!=null && Renewal.Str(n,"identity_fingerprint")==Context.Fingerprint &&
            Renewal.Id(Renewal.Str(n,"node_id")) && Renewal.Number(n,"binding_generation")>0,"RENEW_CONNECTION_MISMATCH");
        return n;
    }
    internal Renewal.Connection Probe(string hash) {
        // Sign the original null selectors. The gateway resolves the node from the
        // registered public key and the old binding from its proof, even after expiry.
        var r=Call(null,null,null,null,hash,null);
        string node=Renewal.Str(r,"node_id");
        Renewal.Require(Renewal.Id(node) && Renewal.Str(r,"identity_fingerprint")==Context.Fingerprint &&
            Renewal.Id(Renewal.Str(r,"project_id")) && Renewal.Str(r,"kind")==Context.Kind,"RENEW_CONNECTION_MISMATCH");
        var result=Parse(r,node);
        ReadProbeFields(r,result);
        if(Context.Kind=="ci" && result.Expires>DateTime.UtcNow) {
            Dictionary<string,object> self;
            var n=CiNode(hash,out self);
            Renewal.Require(Renewal.Str(n,"node_id")==node && Renewal.Str(self,"binding_id")==result.Binding &&
                Renewal.Number(n,"binding_generation")==result.Generation && Renewal.Expires(Renewal.Str(self,"connection_expires_at"))==result.Expires,
                "RENEW_CONNECTION_MISMATCH");
            result.Receipt=Renewal.Str(n,"rebind_receipt_id");
        }
        return result;
    }
    void ReadProbeFields(Dictionary<string,object> reply,Renewal.Connection connection) {
        connection.WindowOpens=Renewal.Expires(Renewal.Str(reply,"renewal_window_opens_at"));
        object duty;
        Renewal.Require(connection.WindowOpens<=connection.Expires && reply.TryGetValue("on_duty",out duty) &&
            duty is bool && (Context.Kind=="ci" || !(bool)duty),"RENEW_CONNECTION_MISMATCH");
        connection.OnDuty=(bool)reply["on_duty"];
    }
    static Renewal.Connection Parse(Dictionary<string,object> reply,string node) {
        Renewal.Require(Renewal.Id(node) && Renewal.Str(reply,"node_id")==node && Renewal.Id(Renewal.Str(reply,"binding_id")) &&
            Renewal.Number(reply,"binding_generation")>0,"RENEW_CONNECTION_MISMATCH");
        return new Renewal.Connection {Project=Renewal.Str(reply,"project_id"),Node=node,Binding=Renewal.Str(reply,"binding_id"),Generation=Renewal.Number(reply,"binding_generation"),
            Expires=Renewal.Expires(Renewal.Str(reply,"connection_expires_at")),Receipt=Renewal.Str(reply,"receipt_id")};
    }
    internal Renewal.Connection Renew(Renewal.Intent intent,string next) {
        var r=Call(intent.Project,intent.Node,intent.Binding,intent.Generation,intent.OldHash,next);
        Renewal.Require(Renewal.Str(r,"identity_fingerprint")==Context.Fingerprint && Renewal.Str(r,"old_binding_id")==intent.Binding &&
            Renewal.Str(r,"project_id")==intent.Project && Renewal.Str(r,"kind")==Context.Kind,"RENEW_CONNECTION_MISMATCH");
        return Parse(r,intent.Node);
    }
    internal void Verify(string hash,Renewal.Connection c) {
        if(Context.Kind=="ci") {
            Dictionary<string,object> self;
            var n=CiNode(hash,out self);
            Renewal.Require(Renewal.Str(self,"binding_id")==c.Binding && Renewal.Str(n,"node_id")==c.Node &&
                Renewal.Number(n,"binding_generation")==c.Generation && Renewal.Str(n,"rebind_receipt_id")==c.Receipt &&
                Renewal.Expires(Renewal.Str(self,"connection_expires_at"))==c.Expires,"RENEW_CONNECTION_MISMATCH");
        } else {
            var confirmation=Call(c.Project,c.Node,c.Binding,c.Generation,hash,null);
            Renewal.Require(Renewal.Str(confirmation,"project_id")==c.Project && Renewal.Str(confirmation,"kind")==Context.Kind &&
                Renewal.Str(confirmation,"identity_fingerprint")==Context.Fingerprint,"RENEW_CONNECTION_MISMATCH");
            var probe=Parse(confirmation,c.Node);
            ReadProbeFields(confirmation,probe); c.WindowOpens=probe.WindowOpens;
            Renewal.Require(probe.Binding==c.Binding && probe.Generation==c.Generation && probe.Expires==c.Expires,"RENEW_CONNECTION_MISMATCH");
        }
    }
    Renewal.Connection Recover(Renewal.Intent intent,string hash) {
        if(Context.Kind=="upgrade") return Probe(hash);
        Dictionary<string,object> self;
        Dictionary<string,object> node;
        try { node=CiNode(hash,out self); }
        catch(BrokerRefusal e) {
            // An unissued staged credential cannot use Self. Signed discovery distinguishes
            // missing proof from a gateway outage before we retry an uncommitted request.
            if(e.Code!="RENEW_GATEWAY_REFUSED") throw;
            return Probe(hash);
        }
        return new Renewal.Connection {Project=intent.Project,Node=Renewal.Str(node,"node_id"),
            Binding=Renewal.Str(self,"binding_id"),Generation=Renewal.Number(node,"binding_generation"),
            Receipt=Renewal.Str(node,"rebind_receipt_id"),Expires=Renewal.Expires(Renewal.Str(self,"connection_expires_at"))};
    }
    internal Renewal.Connection Run(Renewal.Store store,string requestId,Renewal.StandbyConfirmation confirmation) {
        return Renewal.Run(Context,store,()=>DateTime.UtcNow,Probe,Renew,Verify,(old,hash)=>{
            // 定时巡检可恢复服务端已提交的事务。新让班与尚未提交的续期都由邮箱驱动。
            if(requestId==null) return false;
            Renewal.Require(Renewal.Id(requestId),"RENEW_REQUEST_REFUSED");
            if(!old.OnDuty) return confirmation.Confirm(requestId,old,hash,DateTime.UtcNow);
            Renewal.Require(old.Expires>DateTime.UtcNow,"RENEW_HANDOVER_CONNECTION_INACTIVE");
            var ack=Call(old.Project,old.Node,old.Binding,old.Generation,hash,null,true);
            string target=Renewal.Str(ack,"to_binding_id");
            Renewal.Require(Renewal.Str(ack,"from_binding_id")==old.Binding && Renewal.Id(target) && target!=old.Binding &&
                Renewal.Id(Renewal.Str(ack,"receipt_id")),"RENEW_CONNECTION_MISMATCH");
            old.EffectiveAt=Renewal.Stamp(Renewal.Expires(Renewal.Str(ack,"effective_at")));
            old.Outcome="yielded";
            return false;
        },Recover);
    }
}
sealed class BrokerRefusal : Exception {
    public readonly string Code, GrantRequestId;
    public readonly bool ConfirmedNotRenewed;
    public readonly int? RetryAfterSeconds;
    public BrokerRefusal(string code,bool confirmedNotRenewed=false,string grantRequestId=null,int? retryAfterSeconds=null) : base(code) {
        Code=code; ConfirmedNotRenewed=confirmedNotRenewed; GrantRequestId=grantRequestId; RetryAfterSeconds=retryAfterSeconds;
    }
}

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
