// Offline checks of CluedCISwapBroker's pure parts (review MINOR-2), compiled with SwapBroker.cs and the
// Source v2 SCM files into a scratch directory by test-broker.ps1 (/main:BrokerPureTests). Touches only a
// temporary directory; no service, SCM handle or host path is used.
using System;
using System.IO;

public static class BrokerPureTests
{
    static int n;
    static void Yes(bool ok, string what) { if (!ok) throw new Exception("FAILED:" + what); n++; }
    static void Refused(Action a, string code, string what)
    {
        try { a(); } catch (BrokerRefusal r) { Yes(r.Code == code, what + ":" + r.Code); return; }
        throw new Exception("NOT_REFUSED:" + what);
    }
    public static int Main(string[] args)
    {
        string dir = Path.Combine(Path.GetTempPath(), "clued-broker-pure-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string ok = Path.Combine(dir, "ok.json"), big = Path.Combine(dir, "big.json"), empty = Path.Combine(dir, "empty.json");
            File.WriteAllBytes(ok, new byte[4096]); File.WriteAllBytes(big, new byte[4097]); File.WriteAllBytes(empty, new byte[0]);
            Yes(SwapBroker.ReadBounded(ok).Length == 4096, "bounded-at-limit");
            Refused(() => SwapBroker.ReadBounded(big), "BROKER_REQUEST_SIZE", "over-limit-before-read");
            Refused(() => SwapBroker.ReadBounded(empty), "BROKER_REQUEST_SIZE", "empty");
            // A huge file is refused from its length alone: nothing near its size is ever allocated.
            string huge = Path.Combine(dir, "huge.json");
            using (var f = new FileStream(huge, FileMode.CreateNew)) f.SetLength(512L * 1024 * 1024);
            Refused(() => SwapBroker.ReadBounded(huge), "BROKER_REQUEST_SIZE", "huge");
            // MAJOR-1: the token check (pure part and a real read of this test process's token)
            var mine = BrokerTokenPrivileges.Current();
            Yes(Array.IndexOf(mine, "SeChangeNotifyPrivilege") >= 0, "token-read");
            Yes(BrokerTokenPrivileges.Disallowed(new[] { "SeChangeNotifyPrivilege" }, ResidentServiceHost.AllowedPrivileges).Length == 0, "resident-minimal");
            Yes(string.Join(",", BrokerTokenPrivileges.Disallowed(new[] { "SeImpersonatePrivilege", "SeChangeNotifyPrivilege", "SeCreateGlobalPrivilege" }, ResidentServiceHost.AllowedPrivileges)) == "SeCreateGlobalPrivilege,SeImpersonatePrivilege", "resident-extra");
            Yes(BrokerTokenPrivileges.Disallowed(new[] { "SeChangeNotifyPrivilege", "SeCreateGlobalPrivilege" }, SwapBroker.AllowedPrivileges).Length == 0, "broker-minimal");
            Yes(string.Join(",", BrokerTokenPrivileges.Disallowed(new[] { "SeTcbPrivilege", "SeDebugPrivilege", "SeChangeNotifyPrivilege" }, SwapBroker.AllowedPrivileges)) == "SeDebugPrivilege,SeTcbPrivilege", "broker-extra");
            Yes(ResidentTokenPrivileges.Json(new[] { "SeChangeNotifyPrivilege" }, 7) == "{\"contract\":\"clued.independent-ci.service-token-privileges/1\",\"pid\":7,\"privileges\":[\"SeChangeNotifyPrivilege\"]}", "token-json");
            // Owner abort (DESIGN §6.5): a stop request is honoured only for exactly this swap and a scanner-issuer stage.
            string id = "0a1b2c3d-0000-4000-8000-000000000001", nonce = new string('a', 32), config = new string('c', 64);
            Func<string, byte[]> utf8 = t => System.Text.Encoding.UTF8.GetBytes(t);
            Func<string, int, string, string, string> stop = (rid, st, nn, cf) => "{\"contract\":\"" + StopRequest.Contract + "\",\"requestId\":\"" + rid + "\",\"nonce\":\"" + nn + "\",\"stage\":" + st + ",\"configSha256\":\"" + cf + "\"}";
            StopRequest.Validate(utf8(stop(id, 2, nonce, config)), id, nonce, 2, config); n++;
            Refused(() => StopRequest.Validate(utf8(stop(id, 2, nonce, config)), "0a1b2c3d-0000-4000-8000-000000000002", nonce, 2, config), "BROKER_STOP_NOT_THIS_SWAP", "stop-other-request");
            Refused(() => StopRequest.Validate(utf8(stop(id, 2, new string('b', 32), config)), id, nonce, 2, config), "BROKER_STOP_NOT_THIS_SWAP", "stop-other-nonce");
            Refused(() => StopRequest.Validate(utf8(stop(id, 4, nonce, config)), id, nonce, 2, config), "BROKER_STOP_NOT_THIS_SWAP", "stop-other-stage");
            Refused(() => StopRequest.Validate(utf8(stop(id, 2, nonce, new string('d', 64))), id, nonce, 2, config), "BROKER_STOP_NOT_THIS_SWAP", "stop-other-config");
            Refused(() => StopRequest.Validate(utf8(stop(id, 3, nonce, config)), id, nonce, 3, config), "BROKER_STOP_STAGE_NOT_ABORTABLE", "stop-publisher-stage");
            Refused(() => StopRequest.Validate(utf8(stop(id, 8, nonce, config)), id, nonce, 8, config), "BROKER_STOP_STAGE_NOT_ABORTABLE", "stop-control-stage");
            Refused(() => StopRequest.Validate(utf8(stop(id, 2, nonce, config).Replace("}", ",\"extra\":1}")), id, nonce, 2, config), "BROKER_STOP_SHAPE", "stop-extra-key");
            Refused(() => StopRequest.Validate(utf8(stop(id, 2, nonce, config).Replace(StopRequest.Contract, "clued.independent-ci.swap-broker-stop/2")), id, nonce, 2, config), "BROKER_STOP_SHAPE", "stop-contract");
            Refused(() => StopRequest.Validate(utf8("{\"contract\":"), id, nonce, 2, config), "BROKER_STOP_SHAPE", "stop-torn");
            // The one-second decision of TryOwnerStop: 2 START_PENDING, 4 RUNNING, 3 STOP_PENDING, 1 STOPPED.
            Yes(StopRequest.Decide(4, 77, 77, 4.9) == null, "decide-grace");
            Yes(StopRequest.Decide(2, 0, 77, 60) == null, "decide-start-pending");
            Yes(StopRequest.Decide(4, 77, 77, 5) == "SEND", "decide-send");
            Yes(StopRequest.Decide(4, 78, 77, 60) == "BROKER_STOP_NOT_THIS_HELPER", "decide-other-pid");
            Yes(StopRequest.Decide(4, 0, 0, 60) == "BROKER_STOP_NOT_THIS_HELPER", "decide-no-pid");
            Yes(StopRequest.Decide(3, 77, 77, 60) == "HELPER_ALREADY_STOPPING", "decide-stop-pending");
            Yes(StopRequest.Decide(1, 0, 77, 60) == "HELPER_ALREADY_STOPPING", "decide-stopped");
            Yes(StopRequest.Decide(7, 77, 77, 60) == "BROKER_STOP_NOT_THIS_HELPER", "decide-paused");
            Console.WriteLine("{\"status\":\"BROKER_PURE_PASS\",\"assertions\":" + n + "}");
            return 0;
        }
        catch (Exception e) { Console.WriteLine("{\"status\":\"BROKER_PURE_FAIL\",\"message\":\"" + e.Message.Replace("\"", "'") + "\"}"); return 1; }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
