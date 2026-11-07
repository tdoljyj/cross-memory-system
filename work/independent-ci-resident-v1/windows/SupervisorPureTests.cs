// Offline tests of CompanionSupervisor.cs (DESIGN §65.7): back-off, the launch file's rules, reparse points, ACLs, the token rule and the
// environment whitelist. Compiled with the supervisor by test-companion-headless.ps1 (/main:SupervisorPureTests); prints one JSON line.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

public static class SupervisorPureTests {
  static int n = 0;
  static void Ok(bool c, string what) { n++; if (!c) { Console.Out.WriteLine("{\"status\":\"SUPERVISOR_PURE_FAIL\",\"at\":\"" + what + "\"}"); Environment.Exit(1); } }
  static string Refusal(Action a) { try { a(); return null; } catch (SupervisorRefusal r) { return r.Code; } }
  const string Root = @"C:\ProgramData\CluedIndependentCI\resident";
  const string Profile = @"C:\Users\Windows";
  static string H(char c) { return new string(c, 64); }
  static string Launch(string patchKey, string patchValue) {
    Dictionary<string, string> v = new Dictionary<string, string>();
    v["contract"] = "\"clued.independent-ci.companion-launch/1\"";
    v["generation"] = "3";
    v["nodeExe"] = "\"" + (Root + @"\runtime\node.exe").Replace(@"\", @"\\") + "\"";
    v["nodeExeSha256"] = "\"" + H('a') + "\"";
    v["entry"] = "\"" + (Root + @"\resident\" + H('b') + @"\src\companion-main.mjs").Replace(@"\", @"\\") + "\"";
    v["entrySha256"] = "\"" + H('c') + "\"";
    v["configSha256"] = "\"" + H('d') + "\"";
    v["ghConfigDir"] = "\"" + (Profile + @"\AppData\Local\CluedIndependentCI\companion-gh\gh").Replace(@"\", @"\\") + "\"";
    v["homeDir"] = "\"" + (Profile + @"\AppData\Local\CluedIndependentCI\companion-gh\home").Replace(@"\", @"\\") + "\"";
    v["pathDirs"] = "[\"C:\\\\Program Files\\\\GitHub CLI\",\"C:\\\\Program Files\\\\Git\\\\cmd\"]";
    if (patchKey != null) { if (patchValue == null) v.Remove(patchKey); else v[patchKey] = patchValue; }
    List<string> rows = new List<string>();
    foreach (KeyValuePair<string, string> kv in v) rows.Add("\"" + kv.Key + "\":" + kv.Value);
    return "{" + string.Join(",", rows.ToArray()) + "}";
  }
  static string ParseRefusal(string json) { return Refusal(delegate { SupervisorCore.ParseLaunch(json, Root, Profile); }); }

  public static int Main(string[] args) {
    // test-companion-headless.ps1: the launch file PowerShell writes (Get-CompanionLaunchJson) is the one the supervisor accepts.
    if (args.Length == 4 && args[0] == "--parse") {
      string why = Refusal(delegate { SupervisorCore.ParseLaunch(File.ReadAllText(args[1]), args[2], args[3]); });
      Console.Out.WriteLine(why == null ? "LAUNCH_ACCEPTED" : why);
      return why == null ? 0 : 1;
    }
    // back-off: 5, 10, 20, 40, then 60 for ever; a 10-minute run clears it; a new generation never waits
    int[] want = { 5, 10, 20, 40, 60, 60, 60 };
    for (int i = 0; i < want.Length; i++) Ok(SupervisorCore.BackoffSeconds(i + 1) == want[i], "backoff-" + (i + 1));
    Ok(SupervisorCore.BackoffSeconds(1000) == 60, "backoff-never-gives-up");
    Ok(SupervisorCore.NextConsecutive(4, 601) == 1 && SupervisorCore.NextConsecutive(4, 30) == 5, "backoff-cleared-after-10-minutes");
    Ok(SupervisorCore.DelayBeforeStart(true, 3, 3, 4) == 0, "delay-none-when-served");
    Ok(SupervisorCore.DelayBeforeStart(false, 3, 4, 4) == 0, "delay-none-for-new-generation");
    Ok(SupervisorCore.DelayBeforeStart(false, 3, 3, 4) == 40, "delay-backoff-same-generation");
    int k = 0; for (int i = 0; i < 6; i++) k = SupervisorCore.NextConsecutive(k, 1);
    Ok(SupervisorCore.DelayBeforeStart(false, 1, 1, k) == 60, "six-kills-cap-60");

    // token: full elevation, or Administrators enabled (UAC off), refuses; a filtered token (deny-only) and a standard user pass
    Ok(SupervisorCore.IsElevated(2, 0x10), "token-full-refused");
    Ok(SupervisorCore.IsElevated(1, 0xF), "token-uac-off-refused");
    Ok(!SupervisorCore.IsElevated(3, 0x10), "token-limited-deny-only-passes");
    Ok(!SupervisorCore.IsElevated(1, null), "token-standard-user-passes");

    // launch file
    LaunchSpec s = SupervisorCore.ParseLaunch(Launch(null, null), Root, Profile);
    Ok(s.Generation == 3 && s.PathDirs.Length == 2 && s.EntrySha256 == H('c'), "launch-valid");
    Ok(ParseRefusal(Launch("extra", "1")) == "LAUNCH_FILE_KEYS", "launch-extra-key");
    Ok(ParseRefusal(Launch("homeDir", null)) == "LAUNCH_FILE_KEYS", "launch-missing-key");
    Ok(ParseRefusal(Launch("contract", "\"x/1\"")) == "LAUNCH_FILE_CONTRACT", "launch-contract");
    Ok(ParseRefusal(Launch("generation", "0")) == "LAUNCH_FILE_GENERATION", "launch-generation-zero");
    Ok(ParseRefusal(Launch("generation", "\"3\"")) == "LAUNCH_FILE_GENERATION", "launch-generation-string");
    Ok(ParseRefusal(Launch("nodeExe", "\"C:\\\\Temp\\\\node.exe\"")) == "LAUNCH_FILE_NODE", "launch-node-elsewhere");
    Ok(ParseRefusal(Launch("entry", "\"C:\\\\ProgramData\\\\CluedIndependentCI\\\\resident\\\\resident\\\\x\\\\src\\\\companion-main.mjs\"")) == "LAUNCH_FILE_ENTRY", "launch-entry-shape");
    Ok(ParseRefusal(Launch("entry", "\"C:\\\\ProgramData\\\\CluedIndependentCI\\\\resident\\\\resident\\\\" + H('b') + "\\\\src\\\\evil.mjs\"")) == "LAUNCH_FILE_ENTRY", "launch-entry-other-file");
    Ok(ParseRefusal(Launch("entrySha256", "\"" + H('C') + "\"")) == "LAUNCH_FILE_HASH", "launch-hash-upper-case");
    Ok(ParseRefusal(Launch("ghConfigDir", "\"C:\\\\Users\\\\Windows\\\\.config\\\\gh\"")) == "LAUNCH_FILE_GH_CONFIG", "launch-gh-config-elsewhere");
    Ok(ParseRefusal(Launch("homeDir", "\"C:\\\\Users\\\\Other\\\\AppData\\\\Local\\\\CluedIndependentCI\\\\companion-gh\\\\home\"")) == "LAUNCH_FILE_GH_CONFIG", "launch-home-other-profile");
    Ok(ParseRefusal(Launch("pathDirs", "[\"C:\\\\a;C:\\\\b\"]")) == "LAUNCH_FILE_PATH_DIRS", "launch-path-dir-semicolon");
    Ok(ParseRefusal(Launch("pathDirs", "[\"relative\"]")) == "LAUNCH_FILE_PATH_DIRS", "launch-path-dir-relative");
    Ok(ParseRefusal("not json") == "LAUNCH_FILE_NOT_JSON", "launch-not-json");
    Ok(Refusal(delegate { SupervisorCore.ParseLaunch(Launch(null, null), Root, @"C:\Temp\x"); }) == "SUPERVISOR_PROFILE_UNREADABLE", "launch-profile-shape");

    // chain from the root down to the file's parent; nothing outside the root, no ".."
    List<string> chain = SupervisorCore.ChainOf(Root, Root + @"\resident\" + H('b') + @"\src\companion-main.mjs");
    Ok(chain.Count == 4 && chain[0] == Root && chain[3] == Root + @"\resident\" + H('b') + @"\src", "chain-levels");
    Ok(Refusal(delegate { SupervisorCore.ChainOf(Root, @"C:\Temp\x.json"); }) == "LAUNCH_PATH_OUTSIDE_ROOT", "chain-outside-root");
    Ok(Refusal(delegate { SupervisorCore.ChainOf(Root, Root + @"\config\..\x.json"); }) == "LAUNCH_PATH_REFUSED", "chain-dotdot");

    // ACLs: SYSTEM or Administrators own it; nobody else may change it (the Owner read/execute only)
    string owner = "S-1-5-21-1-2-3-1001";
    Func<string, int, bool, KeyValuePair<string, int[]>> ace = (sid, mask, inheritOnly) => new KeyValuePair<string, int[]>(sid, new[] { 1, mask, inheritOnly ? 1 : 0 });
    Ok(SupervisorCore.AclRefusal("S-1-5-32-544", new[] { ace("S-1-5-18", 0x1F01FF, false), ace("S-1-5-32-544", 0x1F01FF, false), ace(owner, 0x1200A9, false) }) == null, "acl-admin-only-passes");
    Ok(SupervisorCore.AclRefusal("S-1-5-18", new[] { ace(owner, 0x1200A9, false) }) == null, "acl-system-owner-passes");
    Ok(SupervisorCore.AclRefusal(owner, new[] { ace(owner, 0x1200A9, false) }) == "LAUNCH_ACL_OWNER", "acl-owner-user-refused");
    Ok(SupervisorCore.AclRefusal("S-1-5-32-544", new[] { ace(owner, 0x1301BF, false) }) == "LAUNCH_ACL_WRITABLE", "acl-owner-modify-refused");
    Ok(SupervisorCore.AclRefusal("S-1-5-32-544", new[] { ace("S-1-1-0", 0x10000000, false) }) == "LAUNCH_ACL_WRITABLE", "acl-generic-all-refused");
    Ok(SupervisorCore.AclRefusal("S-1-5-32-544", new[] { ace(owner, 0x40000, false) }) == "LAUNCH_ACL_WRITABLE", "acl-write-dac-refused");
    Ok(SupervisorCore.AclRefusal("S-1-5-32-544", new[] { ace("S-1-3-0", 0x10000000, true) }) == null, "acl-inherit-only-ignored");
    Ok(SupervisorCore.AclRefusal("S-1-5-32-544", new[] { new KeyValuePair<string, int[]>(owner, new[] { 0, 0x1F01FF, 0 }) }) == null, "acl-deny-ignored");

    // environment whitelist
    Hashtable parent = new Hashtable();
    parent["NODE_OPTIONS"] = "--require C:\\evil.js"; parent["GIT_CONFIG_GLOBAL"] = "C:\\x"; parent["GH_TOKEN"] = "x"; parent["GH_CONFIG_DIR"] = "C:\\other";
    parent["PSModulePath"] = "C:\\m"; parent["Path"] = "C:\\evil"; parent["HOME"] = "C:\\evil"; parent["COR_ENABLE_PROFILING"] = "1";
    parent["USERPROFILE"] = Profile; parent["LOCALAPPDATA"] = Profile + @"\AppData\Local"; parent["SystemRoot"] = @"C:\Windows"; parent["TEMP"] = @"C:\t";
    parent["HTTPS_PROXY"] = "http://p:1"; parent["PROCESSOR_ARCHITECTURE"] = "AMD64"; parent["ProgramFiles(x86)"] = @"C:\Program Files (x86)";
    SortedDictionary<string, string> env = SupervisorCore.ChildEnvironment(parent, s);
    foreach (string bad in new[] { "NODE_OPTIONS", "GIT_CONFIG_GLOBAL", "GH_TOKEN", "PSModulePath", "COR_ENABLE_PROFILING" }) Ok(!env.ContainsKey(bad), "env-drops-" + bad);
    foreach (string good in new[] { "USERPROFILE", "LOCALAPPDATA", "SystemRoot", "TEMP", "HTTPS_PROXY", "PROCESSOR_ARCHITECTURE", "ProgramFiles(x86)" }) Ok(env.ContainsKey(good), "env-keeps-" + good);
    Hashtable redirected = new Hashtable(parent); redirected["SystemRoot"] = @"C:\evil"; redirected["ComSpec"] = @"C:\evil\cmd.exe"; redirected["PATHEXT"] = ".EVIL";
    SortedDictionary<string, string> env2 = SupervisorCore.ChildEnvironment(redirected, s);
    Ok(env2["SystemRoot"] == @"C:\Windows" && env2["ComSpec"] == @"C:\Windows\System32\cmd.exe" && env2["PATHEXT"].StartsWith(".COM;.EXE") && env2["SystemDrive"] == "C:", "env-system-paths-fixed");
    Ok(env["PATH"] == @"C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd", "env-path-reset");
    Ok(env["GH_CONFIG_DIR"] == s.GhConfigDir && env["HOME"] == s.HomeDir, "env-own-gh-login");
    int pathKeys = 0; foreach (string key in env.Keys) if (string.Equals(key, "PATH", StringComparison.OrdinalIgnoreCase)) pathKeys++;
    Ok(pathKeys == 1, "env-one-path");
    string block = SupervisorCore.EnvironmentBlock(env);
    Ok(block.EndsWith("\0\0") && block.IndexOf("NODE_OPTIONS") < 0, "env-block");
    Ok(SupervisorCore.CommandLine(s, Root) == "\"" + Root + "\\runtime\\node.exe\" \"" + s.Entry + "\" --root \"" + Root + "\" --config-sha256 " + H('d'), "command-line");

    // supervisor.json keeps at most 50 exits
    List<Dictionary<string, object>> exits = new List<Dictionary<string, object>>();
    for (int i = 0; i < 60; i++) { Dictionary<string, object> e = new Dictionary<string, object>(); e["i"] = i; exits = SupervisorCore.AppendExit(exits, e); }
    Ok(exits.Count == 50 && (int)exits[0]["i"] == 10, "exits-bounded");

    // a real junction on the way is refused (mklink /J needs no elevation)
    string tmp = Path.Combine(Path.GetTempPath(), "clued-sup-test-" + Guid.NewGuid().ToString("N"));
    string real = Path.Combine(tmp, "real"), fakeRoot = Path.Combine(tmp, "root");
    Directory.CreateDirectory(Path.Combine(real, "x"));
    Directory.CreateDirectory(fakeRoot);
    File.WriteAllText(Path.Combine(real, "x", "f.json"), "{}");
    try {
      Process p = Process.Start(new ProcessStartInfo(@"C:\Windows\System32\cmd.exe", "/d /c mklink /J \"" + Path.Combine(fakeRoot, "config") + "\" \"" + real + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
      p.StandardOutput.ReadToEnd(); p.WaitForExit();
      Ok(p.ExitCode == 0, "junction-made");
      Ok(Refusal(delegate { CluedCompanionSupervisor.AssertNoReparseChain(fakeRoot, Path.Combine(fakeRoot, @"config\x\f.json")); }) == "LAUNCH_PATH_REPARSE_POINT", "junction-refused");
      Directory.CreateDirectory(Path.Combine(fakeRoot, @"plain\x"));
      Ok(Refusal(delegate { CluedCompanionSupervisor.AssertNoReparseChain(fakeRoot, Path.Combine(fakeRoot, @"plain\x\f.json")); }) == null, "plain-directories-pass");
    } finally {
      try { Directory.Delete(Path.Combine(fakeRoot, "config")); } catch { }
      try { Directory.Delete(tmp, true); } catch { }
    }

    Console.Out.WriteLine("{\"status\":\"SUPERVISOR_PURE_PASS\",\"assertions\":" + n + "}");
    return 0;
  }
}
