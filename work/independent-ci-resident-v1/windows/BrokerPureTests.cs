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
            Console.WriteLine("{\"status\":\"BROKER_PURE_PASS\",\"assertions\":" + n + "}");
            return 0;
        }
        catch (Exception e) { Console.WriteLine("{\"status\":\"BROKER_PURE_FAIL\",\"message\":\"" + e.Message.Replace("\"", "'") + "\"}"); return 1; }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
