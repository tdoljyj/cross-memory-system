using System;
using System.Collections.Generic;
using System.Text;
using System.Security.Cryptography;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

public static class RenewalTests {
    static RenewalPolicy Policy() {
        return new RenewalPolicy(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,RenewalPolicy.FileName)));
    }
    static Dictionary<string,object> Decode(int status,string json) {
        return RenewalGateway.DecodeResponse(status,json,Policy());
    }
    static void Check(bool yes, string label) { if (!yes) throw new Exception(label); }
    static byte[] PublicBlob(uint magic, int cb, int length) {
        var blob=new byte[length];
        Array.Copy(BitConverter.GetBytes(magic),0,blob,0,4);
        Array.Copy(BitConverter.GetBytes(cb),0,blob,4,4);
        return blob;
    }
    static void TuringKeyAdmission(string fixturePath) {
        var facts=Renewal.Object(File.ReadAllText(fixturePath));
        var header=(Dictionary<string,object>)facts["publicBlob"];
        var publicBlob=PublicBlob(Convert.ToUInt32((string)header["magic"],16),(int)header["cb"],(int)header["length"]);
        var reason=RenewalKey.Admit((bool)facts["isMachineKey"],(CngExportPolicies)(int)facts["exportPolicy"],publicBlob);
        Check(reason==null,"TURING PCP ("+facts["algorithm"]+"): expected ECDSA P-256 public blob to pass, got "+reason);
    }
    static void KeyOpenFailure() {
        bool receiptChecked=false;
        var observation=Renewal.Object(Renewal.Json(RenewalKey.SelfCheck(()=>"S-1-5-18",
            ()=>{receiptChecked=true;},
            provider=>{throw new CryptographicException(provider==RenewalKeyAccessV2.Providers[0]
                ? unchecked((int)0x8028400F) : unchecked((int)0x80090016));})));
        object diagnostic;
        Check(observation.TryGetValue("failure",out diagnostic) && diagnostic!=null,"missing open failure diagnostic");
        var failure=(Dictionary<string,object>)diagnostic;
        Check((string)failure["step"]=="open","failure step");
        var attempts=(System.Collections.IList)failure["attempts"];
        Check(attempts.Count==2,"both provider attempts required");
        var tpm=(Dictionary<string,object>)attempts[0];
        var software=(Dictionary<string,object>)attempts[1];
        Check((string)tpm["provider"]=="tpm" && (string)tpm["hresult"]=="0x8028400F","TPM raw HResult");
        Check((string)software["provider"]=="software" && (string)software["hresult"]=="0x80090016","software raw HResult");
        Check((string)observation["sid"]=="S-1-5-18" && observation["provider"]==null &&
            (string)observation["code"]=="RENEW_IDENTITY_KEY_UNAVAILABLE","failed self-check identity and code");
        Check(!receiptChecked,"receipt checked after failed key open");

        int opens=0;
        observation=Renewal.Object(Renewal.Json(RenewalKey.SelfCheck(()=>"S-1-5-18",()=>{receiptChecked=true;},
            provider=>{opens++;throw new CryptographicException(unchecked((int)0x80090010));})));
        failure=(Dictionary<string,object>)observation["failure"];
        attempts=(System.Collections.IList)failure["attempts"];
        Check(opens==1 && attempts.Count==1 && !receiptChecked,"non-absence must stop provider fallback");
        Check((string)((Dictionary<string,object>)attempts[0])["hresult"]=="0x80090010","denied raw HResult");
    }
    static void KeyAdmissionFacts() {
        var p256=PublicBlob(0x31534345,32,72);
        Check(RenewalKey.Admit(true,CngExportPolicies.None,p256)==null,"ECDSA P-256");
        Check(RenewalKey.Admit(false,CngExportPolicies.None,p256)=="machine-key","user key");
        Check(RenewalKey.Admit(true,CngExportPolicies.AllowExport,p256)=="export-policy","exportable key");
        foreach(var blob in new[]{PublicBlob(0x33534345,48,104),PublicBlob(0x314B4345,32,72),
            PublicBlob(0x31534345,32,71),PublicBlob(0x31534345,31,72),new byte[0],null})
            Check(RenewalKey.Admit(true,CngExportPolicies.None,blob)=="public-blob","unexpected public blob admitted");
    }
    static CngKey EphemeralSoftwareKey(CngAlgorithm algorithm) {
        return CngKey.Create(algorithm,null,new CngKeyCreationParameters{Provider=CngProvider.MicrosoftSoftwareKeyStorageProvider});
    }
    static void SoftwareKeyFacts() {
        foreach(var algorithm in new[]{CngAlgorithm.ECDsaP256,CngAlgorithm.ECDsaP384,CngAlgorithm.ECDiffieHellmanP256}) {
            using(var key=EphemeralSoftwareKey(algorithm)) {
                // Only the real public blob is under test. A temporary user key cannot pass the machine-key check.
                Check(key.IsEphemeral && !key.IsMachineKey,"fixture must remain an ephemeral user key");
                var reason=RenewalKey.Admit(true,CngExportPolicies.None,RenewalKey.ReadPublicBlob(key));
                Check(reason==(algorithm==CngAlgorithm.ECDsaP256?null:"public-blob"),"unexpected software key verdict: "+algorithm);
            }
        }
    }
    static void KeyAdmissionSource(string brokerPath) {
        var keyClass=Regex.Match(File.ReadAllText(brokerPath),
            @"internal sealed class RenewalKey\s*:[\s\S]*?(?=\r?\ninternal sealed class RenewalFiles)");
        Check(keyClass.Success,"RenewalKey class not found");
        Check(!Regex.IsMatch(keyClass.Value,@"\.Algorithm\b|\bCngAlgorithm\."),
            "RenewalKey must not use the provider's algorithm name");
    }
    static void KeyAdmissionFailure() {
        var p256=PublicBlob(0x31534345,32,72);
        Check(RenewalKey.Admit(true,CngExportPolicies.AllowExport,p256)=="export-policy",
            "admit failure must identify export-policy");
        bool receiptChecked=false;
        int opens=0;
        var observation=Renewal.Object(Renewal.Json(RenewalKey.SelfCheck(()=>"S-1-5-18",()=>{receiptChecked=true;},
            provider=>{opens++;return EphemeralSoftwareKey(CngAlgorithm.ECDsaP256);})));
        var failure=(Dictionary<string,object>)observation["failure"];
        Check((string)failure["step"]=="admit" && (string)failure["reason"]=="machine-key","admit diagnostic");
        Check(opens==1 && !receiptChecked,"admit refusal must stop before fallback and receipt");
    }
    static void Denies(Action invoke, string code) {
        try { invoke(); } catch (BrokerRefusal x) { Check(x.Code == code, code); return; }
        throw new Exception("expected refusal: " + code);
    }
    sealed class Fixture : Renewal.Store {
        public string Pending, Token = "clued_bnd_fixture_old", Record;
        public int Break, Writes, Calls;
        public bool InvalidSelf, Committed, BadReadback, FailClear, ChangedInFlight;
        public string Refusal, DiskPin, WireReply;
        public int HttpStatus=409;
        public string IssuedHash;
        public override string Read(string slot) {
            if(BadReadback && slot=="token" && Committed && Token.Trim()!="clued_bnd_fixture_old") return "fixture_readback_mismatch";
            return slot == "intent" ? Pending : slot == "record" ? Record : Token;
        }
        public override void Put(string slot, string value) {
            Writes++;
            if (slot == "intent") Pending = value;
            else if (slot == "record") Record = value;
            else Token = value;
            if (Break == Writes) throw new Exception("fixture interrupt");
        }
        public override void ClearIntent() { if(FailClear) throw new Exception("clear interrupted"); Pending = null; }
    }
    const string Binding = "10000000-0000-4000-8000-000000000001", Next = "10000000-0000-4000-8000-000000000002";
    const string Node = "10000000-0000-4000-8000-000000000003", Receipt = "10000000-0000-4000-8000-000000000004";
    const string Project = "10000000-0000-4000-8000-000000000005";

    // global 安装夹具只替换传输、签名器和磁盘，探询、签名正文、续期、读回和事务均走 Broker 实际入口。
    static void GlobalInstallation(string kind, bool active, string yieldRefusal, bool extendSelf=false, Action<string> observeRoute=null, string scenario=null) {
        var disk = new Fixture();
        string fingerprint = new string('b',64), original = disk.Token;
        var installation = new Dictionary<string,object> {
            {"scope","global"}, {"supabaseUrl","https://fixture.supabase.co"}, {"publishableKey","sb_publishable_fixture"},
            {"ciPrincipalBindingId",Binding}, {"ciTokenPinSha256",Renewal.Pin(original)}
        };
        int discoveries=0, yields=0, renewals=0, selfReads=0;
        bool prior=scenario=="yield-evidence" || scenario=="probe-evidence" || scenario=="prior-superseded" || scenario=="yield-clear-marker" || scenario=="probe-clear-marker";
        if(prior) {
            disk.Break=1;
            try { Run(disk,kind,1,false); } catch(Exception e) { if(e.Message!="fixture interrupt") throw; }
            disk.Break=0;
        }
        string persisted=disk.Pending;
        string signed=null, expiry=Renewal.Stamp(DateTime.UtcNow.AddDays(2)), nextExpiry=Renewal.Stamp(DateTime.UtcNow.AddDays(30));
        var gateway = new RenewalGateway(installation,new string('a',64),kind,fingerprint,
            canonical => { signed=canonical; return "fixture-signature"; }, (url,publishable,raw) => {
            var b=Renewal.Object(raw);
            if(url.EndsWith("/clued_ci_connection_self_v1")) {
                selfReads++;
                Check(Renewal.Str((Dictionary<string,object>)b["p_input"],"scope")=="global","self lost global scope");
                bool fresh=Renewal.Str(b,"p_token_hash")!=Renewal.Digest(original);
                if(prior && fresh) throw new BrokerRefusal("RENEW_GATEWAY_REFUSED");
                var reply = new Dictionary<string,object>{{"status","ok"},{"contract","clued.ci.connection-self/1"},
                    {"binding_id",fresh?Next:Binding},{"connection_expires_at",fresh?nextExpiry:expiry},
                    {"node",new Dictionary<string,object>{{"node_id",Node},{"name","fixture"},{"identity_fingerprint",fingerprint},
                        {"state","active"},{"binding_generation",fresh?2:1},{"rebind_receipt_id",fresh?Receipt:null}}}};
                if(fresh && extendSelf) {
                    reply.Add("future_field", true);
                    ((Dictionary<string,object>)reply["node"]).Add("future_node_field", 42);
                }
                return reply;
            }
            if(observeRoute!=null) observeRoute(url);
            Check(Renewal.Str(b,"signature")=="fixture-signature" && b.Remove("signature") &&
                Renewal.Json(new SortedDictionary<string,object>(b,StringComparer.Ordinal))==signed,"unsigned action");
            bool discovery=b["node_id"]==null, mutation=b["new_token_hash"]!=null;
            bool yielding=Renewal.Str(b,"action")=="yield";
            Check(b.Count==(yielding?11:10) && !b.ContainsKey("to_binding_id"),"request keys");
            if(discovery) {
                discoveries++;
                Check(b["project_id"]==null && b["generation"]==null && b["old_binding_id"]==null && !mutation && !yielding,"global discovery selectors");
            } else Check(Renewal.Str(b,"project_id")==Project && Renewal.Str(b,"node_id")==Node,"unbound write/verification");
            if(prior && discovery && Renewal.Str(b,"old_token_hash")!=Renewal.Digest(original))
                throw new BrokerRefusal("RENEW_PROOF_REFUSED");
            if(scenario=="probe-clear-marker" && discovery || scenario=="yield-clear-marker" && yielding)
                return Decode(409,Renewal.Json(new {status="rejected",error_code="RENEW_GRANT_REVOKED",renewed=false}));
            if(scenario=="probe-evidence" && discovery || scenario=="yield-evidence" && yielding)
                return Decode(409,Renewal.Json(new {status="rejected",error_code=scenario=="yield-evidence"?"CI_ADMISSION_TARGET_HALTED":"RENEW_DISCOVERY_AMBIGUOUS",renewed=false}));
            if(scenario=="prior-superseded") {
                if(discovery) return Decode(409,Renewal.Json(new {status="rejected",error_code="RENEW_REPLACEMENT_UNUSABLE"}));
                Check(mutation && Renewal.Str(b,"new_token_hash")==Renewal.Digest(Renewal.Str(Renewal.Object(persisted),"Token")),
                    "prior resolution changed the staged proof");
                return Decode(409,Renewal.Json(new {status="rejected",error_code="RENEW_SUPERSEDED",renewed=false}));
            }
            if(yielding) {
                yields++;
                Check(kind=="ci" && !mutation && Renewal.Str(b,"old_binding_id")==Binding && Renewal.Number(b,"generation")==1 &&
                    Renewal.Str(b,"old_token_hash")==Renewal.Digest(original),"unbound yield");
                if(yieldRefusal!=null) throw new BrokerRefusal(yieldRefusal);
                var ack=new Dictionary<string,object>{{"status","committed"},{"from_binding_id",Binding},{"to_binding_id",Next},
                    {"receipt_id",Receipt},{"effective_at",Renewal.Stamp(DateTime.UtcNow.AddMinutes(5))}};
                // 审查 N2：让班回执反向校验的负例，每次只坏一个字段。
                if(scenario=="yield-ack-from") ack["from_binding_id"]=Next;
                if(scenario=="yield-ack-to-invalid") ack["to_binding_id"]="not-a-binding";
                if(scenario=="yield-ack-to-self") ack["to_binding_id"]=Binding;
                if(scenario=="yield-ack-receipt") ack["receipt_id"]=null;
                if(scenario=="yield-ack-effective") ack["effective_at"]="2026-13-40T99:99:99Z";
                return ack;
            }
            if(mutation) renewals++;
            bool next=mutation || (!discovery && !yielding && Renewal.Str(b,"old_binding_id")==Next);
            return new Dictionary<string,object>{{"status",mutation?"committed":"ok"},{"project_id",Project},{"node_id",Node},
                {"identity_fingerprint",fingerprint},{"kind",kind},{"binding_id",next?Next:Binding},{"old_binding_id",Binding},
                {"binding_generation",next?2:1},{"connection_expires_at",next?nextExpiry:expiry},
                {"renewal_window_opens_at",scenario=="missing-window"?null:Renewal.Stamp(DateTime.UtcNow.AddHours(scenario=="closed-window"?1:-3))},{"receipt_id",Receipt},{"on_duty",kind=="ci" && active}};
        });
        var confirmation=new Renewal.StandbyConfirmation();
        Func<string,Renewal.Connection> request=id=>gateway.Run(disk,id,confirmation);
        if(prior) {
            bool replaced=scenario=="prior-superseded";
            Denies(()=>request(Guid.NewGuid().ToString()),replaced?"RENEW_SUPERSEDED":
                scenario=="yield-evidence"?"CI_ADMISSION_TARGET_HALTED":scenario=="probe-evidence"?"RENEW_DISCOVERY_AMBIGUOUS":"RENEW_GRANT_REVOKED");
            Check(persisted!=null && disk.Pending==(replaced?null:persisted) && disk.Token==original && disk.Record==null,"unrelated operation cleared intent"); return;
        }
        if(scenario=="missing-window") { Denies(()=>request(Guid.NewGuid().ToString()),"RENEW_CONNECTION_MISMATCH"); return; }
        if(scenario=="closed-window") {
            var old=request(Guid.NewGuid().ToString());
            Check(old.Binding==Binding && old.Outcome==null && yields==0 && renewals==0 && disk.Writes==0,"ignored future server window"); return;
        }
        if(scenario!=null && scenario.StartsWith("yield-ack-")) {
            Denies(()=>request(Guid.NewGuid().ToString()),"RENEW_CONNECTION_MISMATCH");
            Check(yields==1 && renewals==0 && disk.Writes==0 && disk.Token==original && disk.Pending==null && disk.Record==null,
                "bad yield receipt changed local state: "+scenario);
            return;
        }
        if(yieldRefusal!=null) Denies(()=>request(Guid.NewGuid().ToString()),yieldRefusal);
        else {
            var result=request(Guid.NewGuid().ToString());
            if(kind=="ci" && !active) {
                Check(result.Outcome=="confirm-standby" && Renewal.Id(result.ConfirmationId) && disk.Writes==0,"renewed without local drain");
                result=request(result.ConfirmationId);
            }
            Check(active ? result.Outcome=="yielded" : result.Binding==Next,"wrong outcome");
        }
        Check(discoveries>=1 && yields==(active?1:0) && renewals==(active?0:1),"wrong action count");
        Check((kind=="ci")== (selfReads>0),"scope reader");
        if(active) Check(disk.Writes==0 && disk.Token==original && disk.Pending==null,"yield changed live or pending bytes");
    }
    static void StandbyConfirmationIsSingleUse() {
        var book=new Renewal.StandbyConfirmation();
        var old=new Renewal.Connection {Project=Project, Node=Node, Binding=Binding, Generation=1};
        var now=DateTime.UtcNow;
        string hash=new string('a',64);
        Check(!book.Confirm(Guid.NewGuid().ToString(),old,hash,now),"unsolicited confirmation");
        string first=old.ConfirmationId;
        old.Generation++;
        Check(!book.Confirm(first,old,hash,now),"confirmation crossed generation");
        Check(!book.Confirm(old.ConfirmationId,old,hash,now.AddMinutes(2)),"expired confirmation");
        string current=old.ConfirmationId;
        Check(book.Confirm(current,old,hash,now.AddMinutes(2)),"fresh confirmation");
        Check(!book.Confirm(current,old,hash,now.AddMinutes(2)),"replayed confirmation");
    }
    static Renewal.Connection Run(Fixture f, string kind, int days, bool lostReply, bool mayRenewCi=true) {
        var now = DateTime.UtcNow;
        var old = new Renewal.Connection { Project = Project, Node = Node, Binding = Binding, Generation = 1, Expires = now.AddDays(days), WindowOpens = now.AddDays(days-10) };
        var next = new Renewal.Connection { Project = Project, Node = Node, Binding = Next, Generation = 2, Receipt = Receipt, Expires = now.AddDays(30) };
        var context = new Renewal.Context { Kind = kind, Identity = new string('a',64), Fingerprint = new string('b',64) };
        if(f.DiskPin!=null) { context.BaselineBinding=Binding;context.BaselinePin=f.DiskPin; }
        return Renewal.Run(context, f, () => now, hash => {
            if(!f.Committed) {
                if(hash!=Renewal.Digest("clued_bnd_fixture_old")) throw new BrokerRefusal("RENEW_PROOF_REFUSED");
                return old;
            }
            if(hash==f.IssuedHash) return next;
            throw new BrokerRefusal("RENEW_REPLAY_CONFLICT");
        }, (intent, hash) => {
            f.Calls++;
            if(f.ChangedInFlight) f.Pending="different serialized operation";
            if (f.WireReply!=null) Decode(f.HttpStatus,f.WireReply);
            if (f.Refusal!=null) throw new BrokerRefusal(f.Refusal);
            if (f.IssuedHash != null) Check(f.IssuedHash == hash, "retry minted a new token");
            f.IssuedHash = hash;
            f.Committed = true;
            if (lostReply) throw new Exception("lost reply");
            return next;
        }, (hash, reply) => { if (f.InvalidSelf) throw new BrokerRefusal("RENEW_CONNECTION_MISMATCH"); }, (connection,hash) => mayRenewCi);
    }
    // 节点离线交班夹具只接收公开连接记录。旧连接尚有效时已确认待命并提交，
    // 回包丢失后旧令牌已不能探测角色，Broker 必须凭原事务自己恢复。
    static void RecoverCommittedCi() {
        var disk = new Fixture();
        try { Run(disk, "ci", 1, true); } catch(Exception e) { if(e.Message!="lost reply") throw; }
        Check(disk.Committed && disk.Pending!=null && disk.Record==null, "missing committed intent");
        var recovered = Run(disk, "ci", -1, false, false);
        var record = Renewal.Object(disk.Record);
        Check(disk.Pending==null && Renewal.Str(record,"bindingId")==Next &&
            Renewal.Str(record,"tokenPinSha256")==Renewal.Pin(disk.Token), "missing local recovery");
        Console.WriteLine(Renewal.Json(new {bindingId=Renewal.Str(record,"bindingId"),
            generation=Renewal.Number(record,"bindingGeneration"),expiresAt=Renewal.Stamp(recovered.Expires)}));
    }
    static void Review(string[] args) {
        const string original="clued_bnd_fixture_old";
        if(args[0]=="turing-key-admission") { TuringKeyAdmission(args[1]); return; }
        if(args[0]=="key-open-failure") { KeyOpenFailure(); return; }
        if(args[0]=="key-admit-failure") { KeyAdmissionFailure(); return; }
        if(args[0]=="key-admission-facts") { KeyAdmissionFacts(); return; }
        if(args[0]=="key-software-facts") { SoftwareKeyFacts(); return; }
        if(args[0]=="key-admission-source") { KeyAdmissionSource(args[1]); return; }
        if(args[0]=="route") {
            string route=null;
            GlobalInstallation("upgrade",false,null,false,url=>{
                Check(route==null || route==url,"route changed between probe, renewal and verification");
                route=url;
            });
            Console.WriteLine(route); return;
        }
        if(args[0]=="extra-self") { GlobalInstallation("ci",false,null,true); return; }
        if(args[0]=="swap") {
            var result=SwapBroker.Dispatch(Encoding.UTF8.GetBytes("{broken"), k=>{throw new Exception("renew lane");},
                ()=>new Dictionary<string,object>{{"legacy-handler",true}});
            Check((bool)result["legacy-handler"],"not passed to swap handler"); return;
        }
        if(args[0]=="interrupt") {
            var result=SwapBroker.InterruptedRenewal(Node,Encoding.UTF8.GetBytes("{\"kind\":\"ci\"}"));
            Check(Renewal.Str(result,"contract")=="clued.independent-ci.connection-renew-response/1" &&
                Renewal.Str(result,"requestId")==Node && Renewal.Str(result,"kind")=="ci" &&
                Renewal.Str(result,"code")=="RENEW_INTERRUPTED","wrong interruption response"); return;
        }
        if(args[0]=="files") { FileFixture(args[1]); return; }
        if(args[0]=="sid-projection") { SidProjection(); return; }
        if(args[0]=="gateway-scenario") { GlobalInstallation(args[2],true,null,false,null,args[1]); return; }
        if(args[0]=="changed-in-flight") {
            var f=new Fixture{ChangedInFlight=true,WireReply=Renewal.Json(new {status="rejected",error_code="RENEW_GRANT_REVOKED",renewed=false})};
            Denies(()=>Run(f,"upgrade",1,false),"RENEW_GRANT_REVOKED");
            Check(f.Pending=="different serialized operation","cleared another operation"); return;
        }
        if(args[0]=="bad-pending") {
            Denies(()=>Decode(202,Renewal.Json(new {status="pending_approval",request_id=Receipt})),"RENEW_GATEWAY_REFUSED");
            Denies(()=>Decode(202,Renewal.Json(new {status="pending_approval",request_id="invalid",retry_after_seconds=3600})),"RENEW_GATEWAY_REFUSED");
            return;
        }
        if(args[0]=="signature-vector") { SignatureVector(args[1]); return; }
        if(args[0]=="wire-code") {
            int http=int.Parse(args[1]); string code=args[2];
            Denies(()=>Decode(http, args[4]=="empty" ? "" :
                Renewal.Json(new {status="rejected",error_code=code,renewed=false})),args[3]); return;
        }
        if(args[0]=="intent-evidence") {
            string code=args[1], marker=args[2];
            foreach(string kind in new[]{"ci","upgrade"}) {
                var doc=new Dictionary<string,object>{{"status","rejected"},{"error_code",code}};
                if(marker!="absent") doc["renewed"]=marker=="text" ? (object)"false" : marker!="false";
                var f=new Fixture{WireReply=Renewal.Json(doc),HttpStatus=int.Parse(args[4])};
                Denies(()=>Run(f,kind,1,false),args[5]);
                Check((f.Pending==null)==(args[3]=="clear") && f.Calls==1 && f.Token==original && f.Record==null,
                    "persisted replacement evidence "+kind+" "+code+" "+marker);
            }
            return;
        }
        if(args[0]=="wire") { WireResponses(); return; }
        foreach(string kind in new[]{"ci","upgrade"}) {
            var f=new Fixture();
            switch(args[0]) {
            case "clear":
                f.FailClear=true;
                try { Run(f,kind,1,false); } catch(Exception e) { if(e.Message!="clear interrupted") throw; }
                Check(f.Committed && f.Pending!=null && Renewal.Digest(f.Token)==f.IssuedHash,"clear restored revoked token");
                f.FailClear=false; Run(f,kind,1,false);
                Check(f.Pending==null && f.Calls==1,"clear retry submitted again"); break;
            case "readback":
                f.BadReadback=true;
                Denies(()=>Run(f,kind,1,false),"RENEW_READBACK_FAILED");
                Check(f.Pending!=null && Renewal.Digest(f.Token)==f.IssuedHash,"readback restored revoked token"); break;
            case "without-replay":
                RecoverThroughGateway(kind);
                try { Run(f,kind,1,true); } catch(Exception e) { if(e.Message!="lost reply") throw; }
                f.Refusal="RENEW_REPLAY_CONFLICT";
                Run(f,kind,1,false,false);
                Check(f.Pending==null && Renewal.Digest(f.Token)==f.IssuedHash && f.Calls==1,"recovery required replay"); break;
            case "terminal":
                foreach(string code in new[]{"RENEW_GRANT_REJECTED","RENEW_GRANT_REVOKED","RENEW_REPLAY_CONFLICT","RENEW_PROOF_REFUSED","RENEW_PENDING_APPROVAL","RENEW_GATEWAY_UNAVAILABLE"}) {
                    var denied=new Fixture {Refusal=code};
                    Denies(()=>Run(denied,kind,1,false),code);
                    Check(denied.Pending!=null,"intent lifetime: "+code);
                    Check(denied.Token==original && denied.Record==null,"refusal placed credentials");
                } break;
            case "changed-local":
                f.Break=1;
                try { Run(f,kind,1,false); } catch(Exception e) { if(e.Message!="fixture interrupt") throw; }
                f.Token="clued_bnd_other_fixture";
                Denies(()=>Run(f,kind,1,false),"RENEW_INTENT_CHANGED");
                Check(f.Pending!=null && f.Calls==0 && f.Token=="clued_bnd_other_fixture","discovery cleared a persisted intent");
                break;
            case "pin":
                Run(f,"upgrade",1,false);
                Check(f.Record!=null,"missing public upgrade pin");
                var pin=Renewal.Object(f.Record);
                Check(Renewal.Str(pin,"bindingId")==Next && Renewal.Str(pin,"receiptId")==Receipt &&
                    Renewal.Str(pin,"tokenPinSha256")==Renewal.Pin(f.Token),"incorrect public upgrade pin"); return;
            default: throw new Exception("unknown fixture");
            }
        }
    }
    // D1 discovery never returns an upgrade receipt. Reconstruct from the staged hash alone,
    // including a CI Self with additive fields, while every mutation and old-hash request fails.
    static void RecoverThroughGateway(string kind) {
        var disk=new Fixture();
        try { Run(disk,kind,1,true); } catch(Exception e) { if(e.Message!="lost reply") throw; }
        string fingerprint=new string('b',64), expiry=Renewal.Stamp(DateTime.UtcNow.AddDays(30));
        int calls=0;
        var gateway=new RenewalGateway(new Dictionary<string,object>{{"scope","global"},{"supabaseUrl","https://fixture.supabase.co"},
            {"publishableKey","sb_publishable_fixture"},{"ciPrincipalBindingId",Binding},{"ciTokenPinSha256",Renewal.Pin(disk.Token)}},
            new string('a',64),kind,fingerprint,raw=>"fixture",(url,key,raw)=>{
                calls++;
                var request=Renewal.Object(raw);
                if(kind=="ci") {
                    Check(url.EndsWith("/clued_ci_connection_self_v1") && Renewal.Str(request,"p_token_hash")==disk.IssuedHash,"expected new Self only");
                    return new Dictionary<string,object>{{"status","ok"},{"contract","clued.ci.connection-self/1"},{"binding_id",Next},
                        {"connection_expires_at",expiry},{"extra",true},{"node",new Dictionary<string,object>{{"identity_fingerprint",fingerprint},
                        {"node_id",Node},{"binding_generation",2},{"rebind_receipt_id",Receipt},{"future",true}}}};
                }
                Check(request["new_token_hash"]==null && Renewal.Str(request,"old_token_hash")==disk.IssuedHash,"expected new proof only");
                return new Dictionary<string,object>{{"status","ok"},{"kind",kind},{"project_id",Project},{"node_id",Node},
                    {"identity_fingerprint",fingerprint},{"binding_id",Next},{"binding_generation",2},{"connection_expires_at",expiry},
                    {"renewal_window_opens_at",Renewal.Stamp(DateTime.UtcNow)},{"on_duty",false}};
            });
        var c=gateway.Run(disk,null,new Renewal.StandbyConfirmation());
        Check(c.Binding==Next && disk.Pending==null && Renewal.Digest(disk.Token)==disk.IssuedHash && calls>0,"could not roll forward");
        var record=Renewal.Object(disk.Record);
        Check(kind=="ci" ? Renewal.Str(record,"rebindReceiptId")==Receipt : record.ContainsKey("receiptId") && record["receiptId"]==null,
            "invented or lost receipt");
    }
    sealed class DiskCut : Renewal.Store {
        readonly RenewalFiles files;
        readonly string point;
        public DiskCut(RenewalFiles files,string point) {this.files=files; this.point=point;}
        public override string Read(string slot) {return files.Read(slot);}
        public override void Put(string slot,string value) {
            files.Put(slot,value);
            if(slot=="intent" && point=="intent") throw new IOException("fixture cut");
        }
        public override void Place(string record,string token,string oldRecord,string oldToken) {
            files.Place(record,token,oldRecord,oldToken);
            if(point=="token") throw new IOException("fixture cut");
        }
        public override void ClearIntent() {files.ClearIntent();}
    }
    static void FileRecovery(string dir,string kind,string point,string controller,Action<string> parents,
        Func<string,FileSecurity> create,Func<FileSecurity,byte[]> descriptor) {
        string root=Path.Combine(dir,kind+"-"+point,"resident");
        string secrets=Path.Combine(kind=="ci"?Path.GetDirectoryName(root):root,"secrets");
        Directory.CreateDirectory(secrets);
        Directory.CreateDirectory(Path.Combine(root,"install"));
        Func<RenewalFiles> open=()=>new RenewalFiles(root,kind,controller,parents,create,descriptor);
        var files=open();
        const string original="clued_bnd_disk_fixture";
        files.Put("token",original);
        var now=DateTime.UtcNow;
        var old=new Renewal.Connection{Project=Project,Node=Node,Binding=Binding,Generation=1,Expires=now,WindowOpens=now};
        var next=new Renewal.Connection{Project=Project,Node=Node,Binding=Next,Generation=2,Expires=now.AddDays(30),Receipt=Receipt};
        var context=new Renewal.Context{Kind=kind,Identity=new string('a',64),Fingerprint=new string('b',64)};
        string proof=null; int commits=0;
        Action<Renewal.Store,bool> run=(store,first)=>Renewal.Run(context,store,()=>now,hash=>{
            if(proof!=null && hash==proof) return next;
            if(proof==null && hash==Renewal.Digest(original)) return old;
            throw new BrokerRefusal("RENEW_PROOF_REFUSED");
        }, (intent,hash)=>{
            proof=hash; commits++;
            if(first && point=="reply") throw new IOException("fixture cut");
            return next;
        },(hash,c)=>Check(hash==proof && c.Binding==Next,"wrong new proof"),(c,hash)=>true);
        var tokenFile=Path.Combine(secrets,kind=="ci"?"ci-admission.token":"resident-upgrade.token");
        using(point=="record"?File.Open(tokenFile,FileMode.Open,FileAccess.Read,FileShare.Read):null) {
            try { run(new DiskCut(files,point),true); throw new Exception("fault did not fire"); }
            catch(IOException e) { if(e.Message!="fixture cut") throw; }
            catch(BrokerRefusal e) { if(point!="record" || e.Code!="RENEW_ATOMIC_MOVE_FAILED") throw; }
        }
        Check(files.Read("intent")!=null,"missing durable intent");
        var restarted=open();
        run(restarted,false);
        Check(commits==1 && restarted.Read("intent")==null && Renewal.Digest(restarted.Read("token"))==proof &&
            Renewal.Str(Renewal.Object(restarted.Read("record")),"bindingId")==Next,"disk restart failed at "+point);
    }
    // On a refusal from the shared ACL rules (PROFILE_*), say who the fixture ran as, how SDDL writes that SID, and the last
    // descriptor the fixture mapped, so a run on another host shows the refused SID and its rights (task 04f9b91b: on the
    // GitHub-hosted runner this case failed with PROFILE_UNTRUSTED_MUTATION_RIGHT_REFUSED and nothing else).
    static void FileFixture(string dir) {
        string sid=WindowsIdentity.GetCurrent().User.Value, lastMapped="(none yet)";
        try { FileFixture(dir,sid,mapped=>lastMapped=mapped); }
        catch(InvalidOperationException e) {
            if(!e.Message.StartsWith("PROFILE_")) throw;
            var probe=new FileSecurity();
            probe.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;"+sid+")");
            string frame=(new StringReader(e.StackTrace??"").ReadLine()??"").Trim();
            throw new Exception(e.Message+" (fixture: current user "+sid+" reads back in SDDL as "+
                probe.GetSecurityDescriptorSddlForm(AccessControlSections.Access)+"; last mapped descriptor "+lastMapped+"; "+frame+")");
        }
    }
    // Map one account to another in a descriptor's DACL by SID, never by SDDL text: SDDL writes some SIDs as an alias
    // (the built-in Administrator -500, the GitHub-hosted runner's account, as LA; SYSTEM as SY) and others in full, so a
    // text replacement misses whichever spelling it did not name (task 04f9b91b: LA kept FA and the rules refused it).
    static RawSecurityDescriptor ProjectSid(string sddl,SecurityIdentifier from,SecurityIdentifier to) {
        var descriptor=new RawSecurityDescriptor(sddl);
        var acl=descriptor.DiscretionaryAcl;
        for(int i=0;acl!=null && i<acl.Count;i++) {
            var ace=acl[i] as KnownAce;
            if(ace!=null && ace.SecurityIdentifier==from) { ace.SecurityIdentifier=to; acl[i]=ace; }
        }
        return descriptor;
    }
    // Every spelling of the mapped SID is mapped: LA and the full -500 SID to SYSTEM, SY and S-1-5-18 to a user.
    static void SidProjection() {
        var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);
        var la=((KnownAce)new RawSecurityDescriptor("D:(A;;FA;;;LA)").DiscretionaryAcl[0]).SecurityIdentifier;
        Check(la.Value.StartsWith("S-1-5-21-") && la.Value.EndsWith("-500"),"LA is the built-in Administrator: "+la.Value);
        string controller="(A;;FR;;;S-1-5-21-1-2-3-1111)", want="O:SYG:SYD:P(A;;FA;;;BA)(A;;FA;;;SY)"+controller;
        foreach(string user in new[]{"LA",la.Value}) {
            var got=ProjectSid("O:SYG:SYD:P(A;;FA;;;BA)(A;;FA;;;"+user+")"+controller,la,system).GetSddlForm(AccessControlSections.All);
            Check(got==want,"the user written "+user+" was not mapped to SYSTEM: "+got);
        }
        var plain=new SecurityIdentifier("S-1-5-21-1-2-3-1000");
        foreach(string sy in new[]{"SY","S-1-5-18"}) {
            var got=ProjectSid("D:P(A;;FA;;;"+sy+")(A;;FR;;;AU)",system,plain).GetSddlForm(AccessControlSections.All);
            Check(got=="D:P(A;;FA;;;S-1-5-21-1-2-3-1000)(A;;FR;;;AU)","SYSTEM written "+sy+" was not mapped to the user: "+got);
        }
    }
    static void FileFixture(string dir,string sid,Action<string> mappedSeen) {
        string baseDir=Path.Combine(dir,"disk"), root=Path.Combine(baseDir,"resident");
        Directory.CreateDirectory(Path.Combine(baseDir,"secrets"));
        Directory.CreateDirectory(Path.Combine(root,"secrets"));
        Directory.CreateDirectory(Path.Combine(root,"install"));
        string controller="S-1-5-21-1-2-3-1111";
        Action<string> parents=file=>Check(Path.GetFullPath(file).StartsWith(baseDir+Path.DirectorySeparatorChar),"escaped fixture");
        var user=new SecurityIdentifier(sid);
        var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);
        Func<string,FileSecurity> create=sddl=>{
            var security=new FileSecurity();
            // A newly created fixture file belongs to this user. Project SYSTEM to this SID only in the fixture; an owner
            // and group of SYSTEM are left out, so the file gets its creator's defaults.
            var projected=ProjectSid(sddl,system,user);
            if(system.Equals(projected.Owner) && system.Equals(projected.Group)) { projected.Owner=null; projected.Group=null; }
            security.SetSecurityDescriptorSddlForm(projected.GetSddlForm(AccessControlSections.All));
            return security;
        };
        Func<FileSecurity,byte[]> descriptor=security=>{
            var dacl=security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            Check(security.AreAccessRulesProtected,"staging inherited rights");
            var mapped=ProjectSid("O:SYG:SY"+dacl,user,system);
            mappedSeen(mapped.GetSddlForm(AccessControlSections.All));
            var bytes=new byte[mapped.BinaryLength]; mapped.GetBinaryForm(bytes,0); return bytes;
        };
        foreach(string kind in new[]{"ci","upgrade"}) {
            foreach(string cut in new[]{"intent","reply","record","token"})
                FileRecovery(baseDir,kind,cut,controller,parents,create,descriptor);
            var files=new RenewalFiles(root,kind,controller,parents,create,descriptor);
            files.Put("token","old fixture"); files.Put("intent","staged fixture");
            string token=Path.Combine(kind=="ci"?baseDir:root,"secrets",kind=="ci"?"ci-admission.token":"resident-upgrade.token");
            Check(Renewal.FileAccessObservation(token)=="OPEN" && Renewal.FileAccessObservation(token+".absent")=="ABSENT",
                "file access observation");
            string record=kind=="ci"?Path.Combine(baseDir,"secrets","ci-admission.connection.json"):
                Path.Combine(root,"install","resident-upgrade.connection.json");
            using(File.Open(token,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                Denies(()=>files.Place("new pin","new fixture",null,"old fixture"),"RENEW_ATOMIC_MOVE_FAILED");
            }
            Check(files.Read("record")=="new pin" && files.Read("intent")=="staged fixture","second rename rolled back committed pin");
            files.Place("new pin","new fixture","new pin","old fixture");
            Check(files.Read("token")=="new fixture","rename retry");
            var privateAcl=File.GetAccessControl(token+".renew-pending").GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            var tokenAcl=File.GetAccessControl(token).GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            var recordAcl=File.GetAccessControl(record).GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            Check(!privateAcl.Contains(controller) && !privateAcl.Contains(";;;AU)") &&
                tokenAcl.Contains(controller)==(kind=="ci") && !tokenAcl.Contains(";;;AU)"),"private readers");
            Check(kind=="ci" ? recordAcl==tokenAcl : recordAcl.Contains("(A;;FR;;;AU)") && !recordAcl.Contains("(A;;FA;;;BA)"),"record readers");
            files.ClearIntent(); Check(files.Read("intent")==null,"clear on disk");
            // Create a different temporary file with a broad initial descriptor. The real
            // handle reader must reject it even though the bytes themselves are well formed.
            var broad=create("O:SYG:SYD:P(A;;FA;;;SY)(A;;FR;;;AU)");
            using(var wrong=new FileStream(token+".renew-pending",FileMode.CreateNew,FileSystemRights.Write,
                FileShare.None,4096,FileOptions.None,broad)) wrong.WriteByte(42);
            Denies(()=>files.Read("intent"),"RENEW_PRIVATE_ACL_REFUSED");
        }
    }
    static byte[] Unbase64(string s) {
        return Convert.FromBase64String(s.Replace('-','+').Replace('_','/').PadRight((s.Length+3)/4*4,'='));
    }
    static void SignatureVector(string file) {
        var contract=Renewal.Object(File.ReadAllText(file));
        var vector=(Dictionary<string,object>)contract["yield_signature_vector"];
        var request=(Dictionary<string,object>)vector["request"];
        var jwk=(Dictionary<string,object>)vector["public_jwk"];
        Func<string,string> field=k=>Renewal.Str(request,k);
        var body=RenewalGateway.Unsigned(field("project_id"),field("node_id"),field("kind"),field("identity_fingerprint"),
            field("old_binding_id"),Renewal.Number(request,"generation"),field("old_token_hash"),field("new_token_hash"),field("issued_at"),true);
        var bytes=Renewal.Utf8.GetBytes(Renewal.Json(body));
        Check(Convert.ToBase64String(bytes)==Convert.ToBase64String(Renewal.Utf8.GetBytes((string)vector["canonical_utf8"])),"canonical UTF-8");
        var blob=new byte[72]; Array.Copy(BitConverter.GetBytes(0x31534345),blob,4); blob[4]=32;
        Array.Copy(Unbase64((string)jwk["x"]),0,blob,8,32); Array.Copy(Unbase64((string)jwk["y"]),0,blob,40,32);
        var sig=Unbase64(field("signature"));
        using(var key=CngKey.Import(blob,CngKeyBlobFormat.EccPublicBlob))
        using(var ec=new ECDsaCng(key)) {
            Check(sig.Length==64 && ec.VerifyHash(RenewalKey.SignatureHash(Renewal.Json(body)),sig),"raw P-256 signature");
            body.Remove("action");
            Check(!ec.VerifyHash(RenewalKey.SignatureHash(Renewal.Json(body)),sig),"unsigned action accepted");
        }
    }
    static void WireResponses() {
        string fingerprint=new string('b',64), expiry=Renewal.Stamp(DateTime.UtcNow.AddDays(2));
        var ok=new Dictionary<string,object>{{"status","ok"},{"project_id",Project},{"node_id",Node},{"kind","upgrade"},
            {"identity_fingerprint",fingerprint},{"binding_id",Binding},{"binding_generation",1},{"connection_expires_at",expiry},
            {"renewal_window_opens_at",Renewal.Stamp(DateTime.UtcNow)},{"on_duty",false}};
        var commit=new Dictionary<string,object>(ok) {{"old_binding_id",Binding},{"receipt_id",Receipt}};
        commit["status"]="committed"; commit["binding_id"]=Next; commit["binding_generation"]=2;
        var pending=new Dictionary<string,object>{{"status","pending_approval"},{"request_id",Receipt},{"retry_after_seconds",3600}};
        var rejected=new Dictionary<string,object>{{"status","rejected"},{"error_code","RENEW_GRANT_REJECTED"}};
        var doc=ok; int status=200;
        var gateway=new RenewalGateway(new Dictionary<string,object>{{"scope","global"},{"supabaseUrl","https://fixture.supabase.co"},
            {"publishableKey","sb_publishable_fixture"},{"ciPrincipalBindingId",Binding},{"ciTokenPinSha256",new string('a',64)}},
            new string('a',64),"upgrade",fingerprint, raw=>"fixture",(url,key,raw)=>Decode(status,Renewal.Json(doc)));
        string proof=new string('c',64), successor=new string('d',64);
        var intent=new Renewal.Intent{Kind="upgrade",Project=Project,Node=Node,Binding=Binding,Generation=1,OldHash=proof};
        Check(gateway.Probe(proof).Binding==Binding,"D1 discovery");
        doc=commit;
        Check(gateway.Renew(intent,successor).Receipt==Receipt && gateway.Renew(intent,successor).Binding==Next,"D1 prior.result");
        status=202; doc=pending;
        try { gateway.Renew(intent,successor); throw new Exception("expected pending"); }
        catch(BrokerRefusal e) { Check(e.Code=="RENEW_PENDING_APPROVAL" && e.GrantRequestId==Receipt && e.RetryAfterSeconds==3600,"pending evidence"); }
        Denies(()=>gateway.Probe(proof),"RENEW_GATEWAY_REFUSED");
        status=200; Denies(()=>gateway.Renew(intent,successor),"RENEW_GATEWAY_REFUSED");
        status=409; doc=rejected; Denies(()=>gateway.Renew(intent,successor),"RENEW_GRANT_REJECTED");
        status=503; Denies(()=>gateway.Renew(intent,successor),"RENEW_GATEWAY_UNAVAILABLE");
    }
    public static int Main(string[] args) {
        try {
            if(args.Length==1 && args[0]=="--recover-committed-ci") { RecoverCommittedCi(); return 0; }
            if(args.Length>0) { Review(args); return 0; }
            StandbyConfirmationIsSingleUse();
            GlobalInstallation("ci",true,null);
            GlobalInstallation("ci",true,"RENEW_HANDOVER_NO_CANDIDATE");
            GlobalInstallation("ci",false,null);
            GlobalInstallation("upgrade",false,null);
            var staged = new Fixture { Break=1 };
            try { Run(staged,"ci",2,false); } catch(Exception e) { if(e.Message!="fixture interrupt") throw; }
            string saved=staged.Pending;
            staged.Break=0; Run(staged,"ci",2,false,false);
            Check(saved!=null && staged.Pending==saved && staged.Calls==0,"uncommitted intent rotated before standby/drain");
            Run(staged,"ci",2,false);
            Check(staged.Pending==null && staged.Calls==1,"confirmed intent did not resume");
            var committed = new Fixture();
            try { Run(committed,"ci",2,true); } catch(Exception e) { if(e.Message!="lost reply") throw; }
            Run(committed,"ci",2,false,false);
            Check(committed.Pending==null && committed.Token!="clued_bnd_fixture_old","committed intent failed to recover");
            var body=RenewalGateway.Unsigned(Node,Node,"ci",new string('a',64),Binding,1,new string('b',64),null,"2026-11-19T00:00:00.000Z");
            Check(string.Join(",",body.Keys)=="contract,generation,identity_fingerprint,issued_at,kind,new_token_hash,node_id,old_binding_id,old_token_hash,project_id","signed fields");
            Check(Renewal.Json(body).StartsWith("{\"contract\":\"clued.ci-connection-renew/1\",\"generation\":1,") &&
                Renewal.Json(body).Contains("\"new_token_hash\":null"),"canonical probe");
            var discovery=RenewalGateway.Unsigned(Node,null,"upgrade",new string('a',64),null,null,new string('b',64),null,"2026-11-19T00:00:00.000Z");
            Check(discovery.Count==10 && discovery["node_id"]==null && discovery["generation"]==null &&
                discovery["new_token_hash"]==null && discovery["old_binding_id"]==null,"signed cold-start lookup");
            body["signature"]="test-signature";
            Check(body.Count==11 && !Renewal.Json(body).Contains("clued_bnd_"),"wire shape");
            Denies(()=>Renewal.Object("{\"a\":1,\"\\u0061\":2}"),"RENEW_DOCUMENT_REFUSED");
            bool swapped=false;
            Func<Dictionary<string,object>> swap=delegate {swapped=true;return new Dictionary<string,object>{{"ok",true}};};
            Denies(()=>SwapBroker.Dispatch(Encoding.UTF8.GetBytes("{\"kind\":\"ci\"}"),
                kind=>{throw new BrokerRefusal("RENEW_GATEWAY_REFUSED");},swap),"RENEW_GATEWAY_REFUSED");
            var result=SwapBroker.Dispatch(Encoding.UTF8.GetBytes("{\"contract\":\"clued.independent-ci.swap-broker-request/2\",\"stage\":11,\"nonce\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"configSha256\":\""+new string('a',64)+"\",\"deadline\":\"2026-11-19T00:00:00Z\"}"),
                kind=>{throw new Exception("wrong lane");},swap);
            Check(swapped && (bool)result["ok"],"swap after refusal");
            foreach (string kind in new[]{"ci","upgrade"}) {
                Check(Renewal.MatchKind(Encoding.UTF8.GetBytes("{\"kind\":\""+kind+"\"}")) == kind, "kind");
                var early = new Fixture(); Run(early, kind, 11, false);
                Check(early.Writes == 0 && early.Calls == 0, "early");
                foreach(int point in new[]{1,2,3,4}) {
                    var f = new Fixture { Break = point == 4 ? 0 : point };
                    try { Run(f,kind,-1,point == 4); } catch(Exception e) { if (e.Message != "fixture interrupt" && e.Message != "lost reply") throw; }
                    f.Break = 0;
                    if (f.Pending != null) Run(f,kind,-1,false);
                    Check(f.Committed && f.Pending == null && f.Token != "clued_bnd_fixture_old", "recover");
                    Check(f.Record != null, "target count");
                }
                foreach(string refusal in new[]{"RENEW_GATEWAY_REFUSED","RENEW_IDENTITY_KEY_UNAVAILABLE","RENEW_SIGNATURE_INVALID",
                    "RENEW_PROOF_REFUSED","RENEW_AUTHORITY_CHANGED","RENEW_PENDING_APPROVAL","CI_REBIND_DUTY_HANDOVER_REQUIRED",
                    "CI_REBIND_NOT_DRAINED","RENEW_REPLAY_CONFLICT","RENEW_RATE_LIMITED",null}) {
                    var f = new Fixture { Refusal = refusal, InvalidSelf = refusal==null };
                    Denies(()=>Run(f,kind,9,false),refusal??"RENEW_CONNECTION_MISMATCH");
                    Check(f.Record == null && f.Token == "clued_bnd_fixture_old", "refusal changed live bytes");
                }
            }
            foreach(string kind in new[]{"ci","upgrade"}) {
                const string legacy="clued_bnd_fixture_old\r\n";
                var failed=new Fixture{BadReadback=true,Token=legacy};
                Denies(()=>Run(failed,kind,-1,false),"RENEW_READBACK_FAILED");
                Check(Renewal.Digest(failed.Token)==failed.IssuedHash && failed.Record!=null && failed.Pending!=null,"failed readback restored revoked bytes");
                failed.BadReadback=false;Run(failed,kind,-1,false);
                Check(failed.Pending==null && failed.Token!=legacy,"failed readback did not recover");
            }
            var wrongPin=new Fixture{DiskPin=new string('c',64)};
            Denies(()=>Run(wrongPin,"ci",0,false),"RENEW_CURRENT_TOKEN_REFUSED");
            Check(wrongPin.Writes==0 && wrongPin.Calls==0,"baseline mismatch wrote before proof");
            foreach(string raw in new[]{"{}","{\"kind\":\"heartbeat\"}","{\"kind\":\"ci\",\"token\":\"x\"}","{\"kind\":\"ci\",\"kind\":\"upgrade\"}","{\"kind\":1}"})
                Check(Renewal.MatchKind(Encoding.UTF8.GetBytes(raw))==null,"malformed renewal envelope");
            Console.WriteLine("RENEWAL_FIXTURE_PASS"); return 0;
        } catch(Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
