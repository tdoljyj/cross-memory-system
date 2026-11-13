// Offline tests of CompanionTaskRegistrar.cs (ADR 0022 §7): the task definition it registers, the codes it prints (and nothing else),
// the account check, and the vtable slots it calls (read-only). Compiled with the registrar by test-companion-headless.ps1
// (/main:RegistrarPureTests); prints one JSON line.
using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Xml;

public static class RegistrarPureTests {
  static int n = 0;
  static void Ok(bool c, string what) { n++; if (!c) { Console.Out.WriteLine("{\"status\":\"REGISTRAR_PURE_FAIL\",\"at\":\"" + what + "\"}"); Environment.Exit(1); } }
  const string Root = @"C:\ProgramData\CluedIndependentCI\resident";
  const string Owner = "S-1-5-21-20-21-22-1001";

  public static int Main(string[] args) {
    // the definition: password logon, LUA, boot + every 15 minutes, no log-on trigger, no restart on failure, IgnoreNew, fixed action
    XmlDocument x = new XmlDocument();
    x.LoadXml(RegistrarCore.PasswordTaskXml(Root, Owner));
    XmlNamespaceManager ns = new XmlNamespaceManager(x.NameTable); ns.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task");
    Func<string, string> at = q => { XmlNode node = x.SelectSingleNode(q, ns); return node == null ? null : node.InnerText; };
    Ok(at("/t:Task/t:Principals/t:Principal/t:LogonType") == "Password", "xml-password-logon");
    Ok(at("/t:Task/t:Principals/t:Principal/t:RunLevel") == "LeastPrivilege", "xml-lua");
    Ok(at("/t:Task/t:Principals/t:Principal/t:UserId") == Owner, "xml-owner");
    Ok(at("/t:Task/t:Triggers/t:BootTrigger/t:Delay") == "PT30S", "xml-boot-30s");
    Ok(at("/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Interval") == "PT15M", "xml-every-15m");
    Ok(x.SelectSingleNode("/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Duration", ns) == null, "xml-repeat-indefinitely");
    Ok(x.SelectSingleNode("/t:Task/t:Triggers/t:LogonTrigger", ns) == null, "xml-no-logon-trigger");
    Ok(x.SelectNodes("/t:Task/t:Triggers/*", ns).Count == 2, "xml-two-triggers");
    Ok(x.SelectSingleNode("/t:Task/t:Settings/t:RestartOnFailure", ns) == null, "xml-no-restart-on-failure");
    Ok(at("/t:Task/t:Settings/t:MultipleInstancesPolicy") == "IgnoreNew", "xml-ignore-new");
    Ok(at("/t:Task/t:Settings/t:StartWhenAvailable") == "true" && at("/t:Task/t:Settings/t:ExecutionTimeLimit") == "PT0S", "xml-start-when-available-no-limit");
    Ok(at("/t:Task/t:Settings/t:DisallowStartIfOnBatteries") == "false" && at("/t:Task/t:Settings/t:StopIfGoingOnBatteries") == "false", "xml-batteries");
    Ok(at("/t:Task/t:Actions/t:Exec/t:Command") == Root + @"\bin\CluedCompanionSupervisor.exe" && at("/t:Task/t:Actions/t:Exec/t:Arguments") == "\"" + Root + "\"", "xml-fixed-action");
    Ok(x.SelectNodes("/t:Task/t:Actions/*", ns).Count == 1, "xml-one-action");
    Ok(RegistrarCore.PasswordTaskXml(Root, Owner).IndexOf("Password<", StringComparison.Ordinal) > 0 && RegistrarCore.PasswordTaskXml(Root, Owner).IndexOf("<Password>", StringComparison.Ordinal) < 0, "xml-holds-no-password");
    bool threw = false; try { RegistrarCore.PasswordTaskXml(Root, "S-1-5-18"); } catch (ArgumentException) { threw = true; }
    Ok(threw, "xml-owner-sid-shape");
    Ok(RegistrarCore.TaskSddl(Owner) == "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;" + Owner + ")", "sddl-owner-read-only");

    // review round 3: the password only while the switch that started the registrar still holds its marker
    string mk = "{\"contract\":\"clued.independent-ci.companion-headless-pending/1\",\"pid\":4242,\"processStart\":\"2026-11-07T12:00:00.0000000Z\"}";
    Ok(RegistrarCore.PendingRefusal(mk, 4242, "2026-11-07T12:00:00.0000000Z") == null, "pending-this-switch");
    Ok(RegistrarCore.PendingRefusal(null, 4242, "2026-11-07T12:00:00.0000000Z") == "PENDING_MARKER_MISSING", "pending-missing");
    Ok(RegistrarCore.PendingRefusal(mk, 4243, "2026-11-07T12:00:00.0000000Z") == "PENDING_MARKER_NOT_THIS_SWITCH", "pending-other-parent");
    Ok(RegistrarCore.PendingRefusal(mk, 4242, "2026-11-07T12:00:01.0000000Z") == "PENDING_MARKER_NOT_THIS_SWITCH", "pending-pid-reused");
    Ok(RegistrarCore.PendingRefusal(mk, 4242, null) == "PENDING_MARKER_NOT_THIS_SWITCH", "pending-parent-gone");
    Ok(RegistrarCore.PendingRefusal("{}", 4242, "x") == "PENDING_MARKER_UNREADABLE", "pending-shape");
    // codes only
    Ok(RegistrarCore.RegisterCode(0) == "REGISTERED", "code-registered");
    Ok(RegistrarCore.RegisterCode(unchecked((int)0x8007052E)) == "LOGON_REJECTED", "code-logon-rejected");
    Ok(RegistrarCore.RegisterCode(unchecked((int)0x80070775)) == "LOGON_REJECTED_ACCOUNT_LOCKED", "code-locked");
    Ok(RegistrarCore.RegisterCode(unchecked((int)0x80070530)) == "LOGON_REJECTED_LOGON_HOURS" && RegistrarCore.RegisterCode(unchecked((int)0x80070773)) == "LOGON_REJECTED_PASSWORD_MUST_CHANGE", "code-design-list");
    Ok(RegistrarCore.RegisterCode(unchecked((int)0x80041318)) == "REGISTER_FAILED", "code-other");
    Ok(RegistrarCore.Output("ACCOUNT_MISMATCH", null) == "{\"contract\":\"clued.independent-ci.companion-registrar/1\",\"code\":\"ACCOUNT_MISMATCH\"}", "output-code-only");
    Ok(RegistrarCore.Output("REGISTER_FAILED", "my secret password!") .IndexOf("secret") < 0, "output-drops-free-text");
    Ok(RegistrarCore.Output("REGISTER_FAILED", "0x8007052E").IndexOf("0x8007052E") > 0, "output-keeps-hresult");

    // 2026-11-08 (30th DESK): REGISTRAR_UNEXPECTED names the step and the exception's type and HRESULT, never its message or any input
    string ud = RegistrarCore.UnexpectedDetail(new RegistrarStepException("service", new COMException("my secret password!", unchecked((int)0x80004005))));
    Ok(ud == "service:COMException:0x80004005", "unexpected-step-type-hresult:" + ud);
    Ok(RegistrarCore.Output("REGISTRAR_UNEXPECTED", ud).IndexOf("\"detail\":\"service:COMException:0x80004005\"") > 0, "unexpected-detail-kept-by-output");
    ud = RegistrarCore.UnexpectedDetail(new RegistrarStepException("definition", new TargetInvocationException(new UnauthorizedAccessException("secret"))));
    Ok(ud == "definition:UnauthorizedAccessException:0x80070005", "unexpected-unwraps-invoke-member:" + ud);
    ud = RegistrarCore.UnexpectedDetail(new InvalidOperationException("secret"));
    Ok(ud == "main:InvalidOperationException:0x80131509", "unexpected-outside-a-step:" + ud);
    ud = RegistrarCore.UnexpectedDetail(new RegistrarStepException(null, new IdentityNotMappedException("secret")));
    Ok(ud == "main:IdentityNotMappedException:0x80131501" && ud.IndexOf("secret") < 0, "unexpected-no-step-no-message:" + ud);
    ud = RegistrarCore.UnexpectedDetail(new RegistrarStepException("prompt", null));
    Ok(ud == "prompt:none:0x00000000", "unexpected-no-cause:" + ud);
    Ok(RegistrarCore.Output("REGISTRAR_UNEXPECTED", RegistrarCore.UnexpectedDetail(new RegistrarStepException("readback", new ArgumentOutOfRangeException()))).IndexOf("readback:ArgumentOutOfRangeException:0x80131502") > 0, "unexpected-detail-fits-output");

    // 2026-11-08 (30th DESK, live switch): the protected unpack failed with 775 and flags 0 worked; only 775 falls back to the plain unpack
    Ok(RegistrarCore.UnpackRetryPlain(775), "unpack-775-retries-plain");
    Ok(!RegistrarCore.UnpackRetryPlain(0) && !RegistrarCore.UnpackRetryPlain(122) && !RegistrarCore.UnpackRetryPlain(87) && !RegistrarCore.UnpackRetryPlain(1783), "unpack-other-errors-final");
    Ok(RegistrarCore.UnpackDetail(775, true, 87) == "protected:775:plain:87", "unpack-detail-error-numbers-only");
    Ok(RegistrarCore.UnpackDetail(122, false, 0) == "protected:122:plain:skipped", "unpack-detail-not-retried");
    Ok(RegistrarCore.Output("CREDENTIAL_UNPACK_FAILED", RegistrarCore.UnpackDetail(-2147483647, true, 2147483647)).IndexOf("\"detail\":\"protected:-2147483647:plain:2147483647\"") > 0, "unpack-detail-fits-output");
    // review L2: the plain unpack's result is used only when CredIsProtectedW says it is not protected
    Ok(RegistrarCore.PlainUnpackUsable(true, 0), "plain-unpack-unprotected-usable");
    Ok(!RegistrarCore.PlainUnpackUsable(true, 1) && !RegistrarCore.PlainUnpackUsable(true, 2) && !RegistrarCore.PlainUnpackUsable(true, 3) && !RegistrarCore.PlainUnpackUsable(false, 0), "plain-unpack-protected-or-unchecked-refused");

    // the account: DOMAIN\user, a bare user read as this computer's
    Ok(RegistrarCore.QualifiedAccount("Windows", "", "NODE-A") == @"NODE-A\Windows", "account-bare-user");
    Ok(RegistrarCore.QualifiedAccount(@"NODE-A\Windows", "", "X") == @"NODE-A\Windows", "account-qualified");
    Ok(RegistrarCore.QualifiedAccount("Windows", "OTHER", "X") == @"OTHER\Windows", "account-domain");
    Ok(RegistrarCore.QualifiedAccount("", "", "X") == null, "account-empty");
    Ok(RegistrarCore.OwnerSidFromAcceptance("{\"node\":{\"ownerSid\":\"" + Owner + "\"}}") == Owner, "owner-sid-from-record");
    Ok(RegistrarCore.OwnerSidFromAcceptance("{\"node\":{\"ownerSid\":\"S-1-5-18\"}}") == null, "owner-sid-shape");
    Ok(RegistrarCore.OwnerSidFromAcceptance("{}") == null, "owner-sid-missing");

    // M5-b (ADR 0023): the companion account's random password, its checks and the one-shot import task
    string alphabet = RegistrarCore.PasswordAlphabet;
    Ok(alphabet.Length == 70 && RegistrarCore.RandomPasswordChars >= 24, "password-alphabet-and-length");
    int[] seen = new int[alphabet.Length]; int dropped = 0;
    for (int b = 0; b < 256; b++) { int k = RegistrarCore.PasswordIndex((byte)b); if (k < 0) dropped++; else seen[k]++; }
    bool even = true; foreach (int c in seen) if (c != seen[0]) even = false;
    Ok(even && seen[0] == 3 && dropped == 256 - 210, "password-bytes-map-evenly-by-rejection");
    int classes = 0; foreach (char c in alphabet) { int k = RegistrarCore.PasswordClass(c); Ok(k == 1 || k == 2 || k == 4 || k == 8, "password-char-has-one-class:" + c); classes |= k; }
    Ok(classes == 15 && RegistrarCore.PasswordClass('"') == 0 && RegistrarCore.PasswordClass(' ') == 0 && alphabet.IndexOf('"') < 0 && alphabet.IndexOf('\'') < 0 && alphabet.IndexOf('<') < 0 && alphabet.IndexOf('&') < 0, "password-four-classes-no-quote-or-markup");
    Ok(RegistrarCore.AccountRefusal("NODE-A", "NODE-A", true, false, false) == null, "account-local-user-usable");
    Ok(RegistrarCore.AccountRefusal("OTHER", "NODE-A", true, false, false) == "COMPANION_ACCOUNT_NOT_LOCAL", "account-not-local");
    Ok(RegistrarCore.AccountRefusal("NODE-A", "NODE-A", true, true, false) == "COMPANION_ACCOUNT_IS_ADMINISTRATOR", "account-administrator-refused");
    Ok(RegistrarCore.AccountRefusal("NODE-A", "NODE-A", true, false, true) == "COMPANION_ACCOUNT_IS_THE_CALLER", "account-the-owner-refused");
    Ok(RegistrarCore.AccountRefusal("NODE-A", "NODE-A", false, false, false) == "COMPANION_ACCOUNT_DISABLED", "account-disabled-refused");
    Ok(RegistrarCore.ValidAccountName("clued-companion") && !RegistrarCore.ValidAccountName("Administrator") && !RegistrarCore.ValidAccountName("a b") && !RegistrarCore.ValidAccountName("x"), "account-name-shape");
    Ok(RegistrarCore.ValidVhdx(@"D:\clued-resident\wsl\CluedResident-Linux\ext4.vhdx") && RegistrarCore.ValidVhdx(@"C:\clued-resident\wsl\Ubuntu-24.04\ext4.vhdx"), "vhdx-shape");
    Ok(!RegistrarCore.ValidVhdx(@"D:\x\..\y\ext4.vhdx") && !RegistrarCore.ValidVhdx(@"D:\a b\ext4.vhdx") && !RegistrarCore.ValidVhdx(@"D:\x\other.vhdx") && !RegistrarCore.ValidVhdx("D:\\x\\\"ext4.vhdx") && !RegistrarCore.ValidVhdx(@"\\server\x\ext4.vhdx"), "vhdx-refused");
    Ok(RegistrarCore.DistroFromAcceptance("{\"node\":{\"wslDistribution\":\"CluedResident-Linux\"}}") == "CluedResident-Linux" && RegistrarCore.DistroFromAcceptance("{\"node\":{\"wslDistribution\":\"a b\"}}") == null, "distro-from-record");
    XmlDocument ix = new XmlDocument();
    ix.LoadXml(RegistrarCore.ImportTaskXml(Owner, "CluedResident-Linux", @"D:\clued-resident\wsl\CluedResident-Linux\ext4.vhdx", 1000));
    XmlNamespaceManager ins = new XmlNamespaceManager(ix.NameTable); ins.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task");
    Ok(ix.SelectSingleNode("//t:Principal/t:LogonType", ins).InnerText == "Password" && ix.SelectSingleNode("//t:Principal/t:RunLevel", ins).InnerText == "LeastPrivilege" && ix.SelectSingleNode("//t:Principal/t:UserId", ins).InnerText == Owner, "import-task-password-lua-account");
    Ok(ix.SelectSingleNode("//t:Triggers", ins) == null, "import-task-on-demand-only");
    string iargs = ix.SelectSingleNode("//t:Exec/t:Arguments", ins).InnerText;
    Ok(ix.SelectSingleNode("//t:Exec/t:Command", ins).InnerText == @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" && iargs.StartsWith("-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "), "import-task-action-encoded");
    string iscript = System.Text.Encoding.Unicode.GetString(Convert.FromBase64String(iargs.Substring(iargs.LastIndexOf(' ') + 1)));
    Ok(iscript == RegistrarCore.ImportScript("CluedResident-Linux", @"D:\clued-resident\wsl\CluedResident-Linux\ext4.vhdx", 1000), "import-task-script-decodes");
    // review r1 m1: exit 0 only when registered and running; an import that fails is accepted when the distribution then starts (a re-run)
    Ok(iscript.Contains("$distro = 'CluedResident-Linux'; $vhdx = 'D:\\clued-resident\\wsl\\CluedResident-Linux\\ext4.vhdx'") && iscript.Contains("$import = Invoke-IW 'import' @('--import-in-place', $distro, $vhdx) 120000") && iscript.Contains("$probe = Invoke-IW 'probe' @('--distribution', $distro, '--exec', '/bin/true') 120000") && iscript.Contains("if ($probe.exitCode -ne 0) { $code = 3 }"), "import-script-allows-already-registered-only-if-it-runs");
    // review r1 m11: the Owner's DefaultUid written back
    Ok(iscript.Contains("$uid = 1000") && iscript.Contains("-Name 'DefaultUid' -Value $uid -Type DWord") && iscript.Contains("if ($k.Count -ne 1 -or -not $same) { $code = 4 }") && RegistrarCore.ImportScript("D", @"D:\a\ext4.vhdx", 0).Contains("$uid = 0"), "import-script-default-uid");
    Ok(iscript.Contains("clued.independent-ci.companion-wsl-import-result/1") && iscript.Contains("companion-wsl-import-result.json") && iscript.Contains("[IO.File]::Replace($tmp, $dp, [NullString]::Value)") && iscript.Contains("$r.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')"), "import-diagnostic-fixed-atomic-result");
    Ok(iscript.Contains("$proc.StartInfo.UseShellExecute = $false") && iscript.Contains("$proc.StartInfo.RedirectStandardOutput = $true; $proc.StartInfo.RedirectStandardError = $true") && iscript.Contains("16384 - [int]$rd.bytes.Length") && iscript.Contains("$b.Length -gt 65536"), "import-diagnostic-bounded-fixed-process-capture");
    Ok(iscript.Contains("$proc.StartInfo.Arguments = $av -join ' '") && !iscript.Contains("$av -join '\" \"'"), "import-wsl-options-unquoted-under-validated-token-grammar");
    Ok(iscript.Contains("[REDACTED_SENSITIVE_LINE]") && iscript.Contains("[REDACTED_LONG_VALUE]") && iscript.Contains("[Text.Encoding]::Unicode.GetString($b)") && !iscript.Contains("GetEnvironmentVariables"), "import-diagnostic-no-secret-environment-dump");
    Ok(RegistrarCore.WslExe == @"C:\Program Files\WSL\wsl.exe" && iscript.Contains("$r.client = Get-CluedMachineWslClient") && iscript.Contains("$code = 8; throw") && iscript.Contains("WSL_MACHINE_CLIENT_SIGNATURE_INVALID"), "import-validates-machine-wide-client-before-command");
    string maxVhdx = @"C:\"; for (int i = 0; i < 15; i++) maxVhdx += new string('a', 64) + @"\"; maxVhdx += "ext4.vhdx";
    Ok(RegistrarCore.ImportArguments(new string('a', 64), maxVhdx, 4294967295L).Length + RegistrarCore.PowerShellExe.Length + 3 < 32767, "import-diagnostic-action-fits-win32-command-line-at-max-input");
    Ok(ix.SelectSingleNode("//t:ExecutionTimeLimit", ins).InnerText == "PT30M" && RegistrarCore.ImportTaskSddl == "D:P(A;;FA;;;SY)(A;;FA;;;BA)", "import-task-limit-and-admin-only");
    threw = false; try { RegistrarCore.ImportTaskXml(Owner, "x y", @"D:\a\ext4.vhdx", 0); } catch (ArgumentException) { threw = true; }
    bool threw2 = false; try { RegistrarCore.ImportScript("D", @"D:\a\ext4.vhdx", -1); } catch (ArgumentException) { threw2 = true; }
    Ok(threw && threw2, "import-task-refuses-bad-distro-or-uid");
    // review r1 M2: the parked definition (interactive token of the account at its log-on, the fixed action, no restart)
    XmlDocument px = new XmlDocument(); px.LoadXml(RegistrarCore.InteractiveTaskXml(Root, Owner));
    XmlNamespaceManager pns = new XmlNamespaceManager(px.NameTable); pns.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task");
    Ok(px.SelectSingleNode("//t:Principal/t:LogonType", pns).InnerText == "InteractiveToken" && px.SelectSingleNode("//t:LogonTrigger/t:UserId", pns).InnerText == Owner && px.SelectSingleNode("//t:BootTrigger", pns) == null && px.SelectSingleNode("//t:RestartOnFailure", pns) == null
      && px.SelectSingleNode("//t:Exec/t:Command", pns).InnerText == Root + @"\bin\CluedCompanionSupervisor.exe" && px.SelectSingleNode("//t:MultipleInstancesPolicy", pns).InnerText == "IgnoreNew", "parked-definition-interactive-no-password");
    // review r1 M2/M5: the order once the password exists, with fakes for every host call
    System.Collections.Generic.List<string> calls = new System.Collections.Generic.List<string>(); string det;
    string fc = RegistrarFlow.PasswordFlow(() => { calls.Add("set"); return 0; }, () => { calls.Add("task"); return unchecked((int)0x8007052E); }, () => { calls.Add("import"); return 0; }, () => { calls.Add("park"); return true; }, out det);
    Ok(fc == "LOGON_REJECTED" && det == "0x8007052E:parked" && string.Join(",", calls.ToArray()) == "set,task,park", "password-flow-register-fails-parks");
    calls.Clear(); fc = RegistrarFlow.PasswordFlow(() => { calls.Add("set"); return 0; }, () => { calls.Add("task"); return 0; }, () => { calls.Add("import"); return unchecked((int)0x80070005); }, () => { calls.Add("park"); return false; }, out det);
    Ok(fc == "IMPORT_REGISTER_ACCESS_DENIED" && det == "0x80070005:park-failed" && string.Join(",", calls.ToArray()) == "set,task,import,park", "password-flow-import-fails-parks");
    calls.Clear(); fc = RegistrarFlow.PasswordFlow(() => { calls.Add("set"); return 2245; }, () => { calls.Add("task"); return 0; }, null, () => { calls.Add("park"); return true; }, out det);
    Ok(fc == "ACCOUNT_PASSWORD_NOT_SET" && det == "2245" && string.Join(",", calls.ToArray()) == "set", "password-flow-password-not-set-touches-nothing");
    calls.Clear(); fc = RegistrarFlow.PasswordFlow(() => { calls.Add("set"); return 0; }, () => { calls.Add("task"); return 0; }, null, () => { calls.Add("park"); return true; }, out det);
    Ok(fc == "REGISTERED" && det == null && string.Join(",", calls.ToArray()) == "set,task", "password-flow-registered-no-park");
    // review r1 m5: the account's hardening
    Ok(RegistrarCore.HardeningProblems(new[] { "Users" }, "Users", 0x10040 | 0x201, new[] { "SeBatchLogonRight", "SeDenyNetworkLogonRight", "SeDenyRemoteInteractiveLogonRight" }, true).Count == 0, "hardening-ok");
    Ok(string.Join(",", RegistrarCore.HardeningProblems(new[] { "Users", "Remote Desktop Users" }, "Users", 0x201, new[] { "SeBatchLogonRight" }, false).ToArray()) == "GROUPS_NOT_USERS_ONLY,PASSWORD_EXPIRES,PASSWORD_CHANGEABLE,NETWORK_LOGON_NOT_DENIED,RDP_LOGON_NOT_DENIED,NOT_HIDDEN", "hardening-every-problem");
    Ok(RegistrarCore.HardeningProblems(new string[0], "Users", 0x10040, new[] { "SeDenyNetworkLogonRight", "SeDenyRemoteInteractiveLogonRight" }, true)[0] == "GROUPS_NOT_USERS_ONLY", "hardening-no-group");

    // root-run: one pinned root script as the companion account. Only <root>\install\linux-run-<32hex>\script.sh with that directory's
    // out\, a lower-case SHA-256 and a timeout of 1..86400 s in plain digits; one stdout line.
    string runId = "0123456789abcdef0123456789abcdef", runDir = Root + @"\install\linux-run-" + runId, runSha = new string('a', 64);
    Func<string, string, string, string, string, RootRunRequest> rr = (root, script, sha, outDir, timeout) => RegistrarCore.ParseRootRun(new[] { "root-run", root, script, sha, outDir, timeout });
    RootRunRequest rq = rr(Root, runDir + @"\script.sh", runSha, runDir + @"\out", "5400");
    Ok(rq != null && rq.ScriptPath == runDir + @"\script.sh" && rq.Directory == runDir && rq.OutDirectory == runDir + @"\out" && rq.Sha256 == runSha && rq.TimeoutSeconds == 5400
      && rq.WslScript == "/mnt/c/ProgramData/CluedIndependentCI/resident/install/linux-run-" + runId + "/script.sh", "root-run-arguments-accepted");
    Ok(rr(Root.ToLowerInvariant(), runDir + @"\script.sh", runSha, runDir + @"\out", "1") != null && rr(Root, runDir + @"\script.sh", runSha, runDir + @"\out", "86400") != null, "root-run-root-any-case-and-timeout-bounds");
    Ok(rr(@"C:\Temp", runDir + @"\script.sh", runSha, runDir + @"\out", "60") == null && rr(Root, @"C:\Temp\install\linux-run-" + runId + @"\script.sh", runSha, @"C:\Temp\install\linux-run-" + runId + @"\out", "60") == null, "root-run-refuses-another-root");
    foreach (string bad in new[] { Root + @"\install\linux-run-" + runId.ToUpperInvariant() + @"\script.sh", Root + @"\install\linux-run-" + runId.Substring(1) + @"\script.sh", Root + @"\install\linux-run-" + runId + @"\other.sh",
        Root + @"\install\linux-run-" + runId + @"\..\linux-run-" + runId + @"\script.sh", Root + @"\install\linux-run-" + runId + @"\sub\script.sh", Root + @"\state\linux-run-" + runId + @"\script.sh",
        Root.ToLowerInvariant() + @"\install\linux-run-" + runId + @"\script.sh", runDir + "\\script.sh ", runDir + "\\script.sh\" & calc" })
      Ok(rr(Root, bad, runSha, runDir + @"\out", "60") == null, "root-run-refuses-script-path:" + bad);
    foreach (string bad in new[] { runDir, runDir + @"\out\", runDir + @"\OUT", Root + @"\install\linux-run-" + new string('f', 32) + @"\out", runDir + @"\out\..\out", @"D:\w\out" })
      Ok(rr(Root, runDir + @"\script.sh", runSha, bad, "60") == null, "root-run-refuses-out-directory:" + bad);
    foreach (string bad in new[] { "", runSha.Substring(1), runSha.ToUpperInvariant(), runSha + "a", new string('g', 64) })
      Ok(rr(Root, runDir + @"\script.sh", bad, runDir + @"\out", "60") == null, "root-run-refuses-sha256:" + bad);
    foreach (string bad in new[] { "", "0", "-1", "060", "86401", "100000", "1e3", " 60", "60 ", "+60", "9999999999" })
      Ok(rr(Root, runDir + @"\script.sh", runSha, runDir + @"\out", bad) == null, "root-run-refuses-timeout:" + bad);
    Ok(RegistrarCore.ParseRootRun(new[] { "root-run", Root, runDir + @"\script.sh", runSha, runDir + @"\out" }) == null && RegistrarCore.ParseRootRun(new[] { "root-run", Root, runDir + @"\script.sh", runSha, runDir + @"\out", "60", "x" }) == null
      && RegistrarCore.ParseRootRun(new[] { "root-shell", Root, runDir + @"\script.sh", runSha, runDir + @"\out", "60" }) == null && RegistrarCore.ParseRootRun(null) == null, "root-run-refuses-argument-count-or-mode");
    Ok(RegistrarCore.WslPath(@"D:\w\fleet\linux-in") == "/mnt/d/w/fleet/linux-in" && RegistrarCore.WslPath(@"C:\a b\c") == null && RegistrarCore.WslPath(@"C:\a\..\b") == null && RegistrarCore.WslPath(@"C:\a\.\b") == null
      && RegistrarCore.WslPath(@"\\server\share\x") == null && RegistrarCore.WslPath(@"C:\a\b\") == null && RegistrarCore.WslPath("C:\\a\\$(id)") == null && RegistrarCore.WslPath("C:\\a\\b;c") == null && RegistrarCore.WslPath(null) == null, "wsl-path-plain-components-only");
    Ok(RegistrarCore.WslPath(@"C:\a.\b") == null && RegistrarCore.WslPath(@"C:\a\b.") == null && RegistrarCore.WslPath(@"C:\a\b..c\d") == "/mnt/c/a/b..c/d" && RegistrarCore.WslPath(@"C:\a\b \c") == null, "wsl-path-no-component-ending-in-a-dot-or-blank");
    // the task a process may be started over: root-shell only the password definition; root-run also the parked one (it heals it)
    Ok(RegistrarCore.AccountTaskRefusal(1, true, false) == null && RegistrarCore.AccountTaskRefusal(1, true, true) == null && RegistrarCore.AccountTaskRefusal(3, true, true) == null, "account-task-password-or-parked-for-root-run");
    Ok(RegistrarCore.AccountTaskRefusal(3, true, false) == "COMPANION_TASK_NOT_PASSWORD" && RegistrarCore.AccountTaskRefusal(1, false, true) == "COMPANION_TASK_NOT_PASSWORD" && RegistrarCore.AccountTaskRefusal(3, false, true) == "COMPANION_TASK_NOT_PASSWORD"
      && RegistrarCore.AccountTaskRefusal(2, true, true) == "COMPANION_TASK_NOT_PASSWORD" && RegistrarCore.AccountTaskRefusal(5, true, true) == "COMPANION_TASK_NOT_PASSWORD", "account-task-refused-other-account-or-logon-type");
    Ok(rq.CapturedDirectory == runDir + @"\captured" && !rq.Probe, "root-run-captured-directory-beside-out");
    // write-probe: a run directory in everything but its name; the fixed echo, no WSL; 1..600 s
    string probeDir = Root + @"\install\linux-run-" + runId + "-probe";
    RootRunRequest pq = RegistrarCore.ParseWriteProbe(new[] { "write-probe", Root, probeDir, "60" });
    Ok(pq != null && pq.Probe && pq.Directory == probeDir && pq.OutDirectory == probeDir + @"\out" && pq.CapturedDirectory == probeDir + @"\captured" && pq.ScriptPath == null && pq.TimeoutSeconds == 60, "write-probe-arguments-accepted");
    Ok(RegistrarCore.ProbeCommandLine(pq) == "cmd.exe /d /c \"echo x> " + probeDir + @"\out\stdout.txt 2> " + probeDir + @"\out\stderr.txt" + "\"" && RegistrarCore.ProbeCommandLine(pq).IndexOf("wsl", StringComparison.OrdinalIgnoreCase) < 0, "write-probe-command-fixed-no-wsl");
    foreach (string[] bad in new[] { new[] { "write-probe", Root, runDir, "60" }, new[] { "write-probe", Root, probeDir + @"\out", "60" }, new[] { "write-probe", @"C:\Temp", probeDir, "60" }, new[] { "write-probe", Root, probeDir, "0" },
        new[] { "write-probe", Root, probeDir, "601" }, new[] { "write-probe", Root, probeDir, "6e1" }, new[] { "write-probe", Root, probeDir.ToUpperInvariant(), "60" }, new[] { "root-run", Root, probeDir, "60" }, new[] { "write-probe", Root, probeDir } })
      Ok(RegistrarCore.ParseWriteProbe(bad) == null, "write-probe-refuses:" + string.Join(" ", bad));
    threw = false; try { RegistrarCore.ProbeCommandLine(rq); } catch (ArgumentException) { threw = true; }
    Ok(threw && RegistrarCore.ParseRootRun(new[] { "root-run", Root, probeDir + @"\script.sh", runSha, probeDir + @"\out", "60" }) == null, "probe-and-run-directories-never-mixed");
    // the capture: a plain file with exactly one name, at most the limit; from the handle's facts
    Ok(RegistrarCore.CaptureRefusal(0x20, 1, 0, RegistrarCore.CaptureMaxBytes) == null && RegistrarCore.CaptureRefusal(0x80, 1, (ulong)RegistrarCore.CaptureMaxBytes, RegistrarCore.CaptureMaxBytes) == null && RegistrarCore.CaptureMaxBytes == 4194304, "capture-plain-file-within-the-limit");
    Ok(RegistrarCore.CaptureRefusal(0x420, 1, 0, 100) == "ROOT_RUN_OUTPUT_IS_A_LINK" && RegistrarCore.CaptureRefusal(0x410, 1, 0, 100) == "ROOT_RUN_OUTPUT_IS_A_LINK" && RegistrarCore.CaptureRefusal(0x10, 1, 0, 100) == "ROOT_RUN_OUTPUT_IS_A_DIRECTORY"
      && RegistrarCore.CaptureRefusal(0x20, 2, 0, 100) == "ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME" && RegistrarCore.CaptureRefusal(0x20, 0, 0, 100) == "ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME"
      && RegistrarCore.CaptureRefusal(0x20, 1, 101, 100) == "ROOT_RUN_OUTPUT_TOO_LARGE" && RegistrarCore.CaptureRefusal(0x20, 1, 1UL << 40, 100) == "ROOT_RUN_OUTPUT_TOO_LARGE", "capture-refuses-link-directory-second-name-or-size");
    string outRoot = RegistrarCore.CiRoot + @"\reinstall-linux-out-" + runId, facts = "linux-version-facts.20261112T100000Z.json";
    string[] cf = RegistrarCore.ParseCaptureFile(new[] { "capture-file", outRoot + @"\" + facts, runDir + @"\captured\" + facts });
    Ok(cf != null && cf[0] == outRoot + @"\" + facts && cf[1] == runDir + @"\captured\" + facts && RegistrarCore.CiRoot == @"C:\ProgramData\CluedIndependentCI", "capture-file-arguments-accepted");
    foreach (string[] bad in new[] { new[] { outRoot + @"\" + facts, runDir + @"\captured\other.json" }, new[] { outRoot + @"\sub\" + facts, runDir + @"\captured\" + facts }, new[] { outRoot + @"\" + facts, runDir + @"\out\" + facts },
        new[] { @"D:\w\linux-out\" + facts, runDir + @"\captured\" + facts }, new[] { outRoot + @"\" + facts, Root + @"\secrets\" + facts }, new[] { outRoot + @"\a..b", runDir + @"\captured\a..b" }, new[] { outRoot + @"\a b", runDir + @"\captured\a b" },
        new[] { Root + @"\secrets\resident-upgrade.token", runDir + @"\captured\resident-upgrade.token" }, new[] { outRoot + @"\" + facts + ".", runDir + @"\captured\" + facts + "." } })
      Ok(RegistrarCore.ParseCaptureFile(new[] { "capture-file", bad[0], bad[1] }) == null, "capture-file-refuses:" + bad[0] + ">" + bad[1]);
    // capture-file's second source: a run's own stdout.txt / stderr.txt, into captured\ or a new captured-<32hex>\ of that SAME run directory
    string newCapture = runDir + @"\captured-" + new string('9', 32);
    Ok(RegistrarCore.ParseCaptureFile(new[] { "capture-file", runDir + @"\out\stdout.txt", newCapture + @"\stdout.txt" }) != null && RegistrarCore.ParseCaptureFile(new[] { "capture-file", runDir + @"\out\stderr.txt", runDir + @"\captured\stderr.txt" }) != null
      && RegistrarCore.ParseCaptureFile(new[] { "capture-file", outRoot + @"\" + facts, newCapture + @"\" + facts }) != null, "capture-file-run-output-and-new-capture-directory");
    string otherRun = Root + @"\install\linux-run-" + new string('8', 32);
    foreach (string[] bad in new[] { new[] { runDir + @"\out\stdout.txt", otherRun + @"\captured\stdout.txt" }, new[] { runDir + @"\out\stdout.txt", newCapture + @"\stderr.txt" }, new[] { runDir + @"\out\other.txt", newCapture + @"\other.txt" },
        new[] { runDir + @"\script.sh", newCapture + @"\script.sh" }, new[] { runDir + @"\captured\stdout.txt", newCapture + @"\stdout.txt" }, new[] { runDir + @"\out\stdout.txt", runDir + @"\captured-9\stdout.txt" },
        new[] { runDir + @"\out\stdout.txt", runDir + @"\out\stdout.txt" }, new[] { runDir + @"-probe\out\stdout.txt", runDir + @"-probe\captured\stdout.txt" }, new[] { Root + @"\secrets\stdout.txt", newCapture + @"\stdout.txt" },
        new[] { runDir + @"\out\sub\stdout.txt", newCapture + @"\stdout.txt" }, new[] { runDir + @"\out\stdout.txt", newCapture + @"\sub\stdout.txt" } })
      Ok(RegistrarCore.ParseCaptureFile(new[] { "capture-file", bad[0], bad[1] }) == null, "capture-file-refuses-run-output:" + bad[0] + ">" + bad[1]);
    // where a capture is written: Administrators' own, protected, SYSTEM and Administrators only
    Ok(RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", true, new[] { "S-1-5-18", "S-1-5-32-544" }, 0) == null && RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", true, new[] { "S-1-5-32-544" }, 0) == null, "capture-directory-admin-only");
    Ok(RegistrarCore.CaptureDirectoryRefusal(Owner, true, new[] { "S-1-5-18", "S-1-5-32-544" }, 0) != null && RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", false, new[] { "S-1-5-18", "S-1-5-32-544" }, 0) != null
      && RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", true, new[] { "S-1-5-18", "S-1-5-32-544", Owner }, 0) != null && RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", true, new[] { "S-1-5-32-545" }, 0) != null
      && RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", true, new string[0], 0) != null && RegistrarCore.CaptureDirectoryRefusal("S-1-5-32-544", true, new[] { "S-1-5-18" }, 1) != null
      && RegistrarCore.CaptureDirectoryRefusal(null, true, null, 0) == "ROOT_RUN_CAPTURE_DIRECTORY_NOT_ADMIN_ONLY", "capture-directory-refuses-other-owner-inheritance-or-anyone-else");
    Ok(RegistrarCore.RootRunCaptureRefused("ROOT_RUN_OUTPUT_IS_A_LINK") == "CAPTURE_REFUSED ROOT_RUN_OUTPUT_IS_A_LINK" && RegistrarCore.RootRunCaptureRefused("free text\nROOT_RUN_EXITED 0") == "CAPTURE_REFUSED REGISTRAR_UNEXPECTED", "capture-refused-line-is-a-code-only");
    // root-run only over the task this program registers: one action, the supervisor of this root
    Ok(RegistrarCore.RootRunActionRefusal(1, Root + @"\bin\CluedCompanionSupervisor.exe", "\"" + Root + "\"", Root) == null, "root-run-task-action-as-registered");
    Ok(RegistrarCore.RootRunActionRefusal(2, Root + @"\bin\CluedCompanionSupervisor.exe", "\"" + Root + "\"", Root) == "ROOT_RUN_TASK_DEFINITION_DIFFERS" && RegistrarCore.RootRunActionRefusal(1, @"C:\other.exe", "\"" + Root + "\"", Root) == "ROOT_RUN_TASK_DEFINITION_DIFFERS"
      && RegistrarCore.RootRunActionRefusal(1, Root + @"\bin\CluedCompanionSupervisor.exe", "x", Root) == "ROOT_RUN_TASK_DEFINITION_DIFFERS" && RegistrarCore.RootRunActionRefusal(0, null, null, Root) == "ROOT_RUN_TASK_DEFINITION_DIFFERS"
      && RegistrarCore.RootRunActionRefusal(1, (Root + @"\bin\CluedCompanionSupervisor.exe").ToUpperInvariant(), "\"" + Root + "\"", Root) == "ROOT_RUN_TASK_DEFINITION_DIFFERS", "root-run-task-action-differs-refused");
    string runCmd = RegistrarCore.RootRunCommandLine("CluedResident-Linux", rq);
    Ok(runCmd == "cmd.exe /d /c \"\"C:\\Program Files\\WSL\\wsl.exe\" --distribution CluedResident-Linux --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc "
      + "/mnt/c/ProgramData/CluedIndependentCI/resident/install/linux-run-" + runId + "/script.sh > " + runDir + @"\out\stdout.txt 2> " + runDir + @"\out\stderr.txt" + "\"", "root-run-command-line:" + runCmd);
    Ok(RegistrarCore.CmdExe == @"C:\Windows\System32\cmd.exe" && runCmd.IndexOf(runSha) < 0 && runCmd.Split('"').Length == 5, "root-run-command-line-fixed-shell-and-quotes");
    threw = false; try { RegistrarCore.RootRunCommandLine("a b", rq); } catch (ArgumentException) { threw = true; }
    threw2 = false; try { RegistrarCore.RootRunCommandLine("CluedResident-Linux", null); } catch (ArgumentException) { threw2 = true; }
    Ok(threw && threw2, "root-run-command-line-refuses-bad-distro-or-request");
    Ok(RegistrarCore.RootRunExited(0) == "ROOT_RUN_EXITED 0" && RegistrarCore.RootRunExited(1) == "ROOT_RUN_EXITED 1" && RegistrarCore.RootRunExited(4294967295u) == "ROOT_RUN_EXITED 4294967295" && RegistrarCore.RootRunTimeout == "ROOT_RUN_TIMEOUT", "root-run-lines-exited-and-timeout");
    Ok(RegistrarCore.RootRunRefused("ROOT_RUN_SCRIPT_SHA256_MISMATCH") == "ROOT_RUN_REFUSED ROOT_RUN_SCRIPT_SHA256_MISMATCH" && RegistrarCore.RootRunRefused("my secret\nROOT_RUN_EXITED 0") == "ROOT_RUN_REFUSED REGISTRAR_UNEXPECTED"
      && RegistrarCore.RootRunRefused(null) == "ROOT_RUN_REFUSED REGISTRAR_UNEXPECTED" && RegistrarCore.RootRunRefused("lower") == "ROOT_RUN_REFUSED REGISTRAR_UNEXPECTED", "root-run-refusal-line-is-a-code-only");

    // the compiled program: not elevated it refuses every mode but the read-only vtable self-test, which must pass
    if (args.Length == 1) {
      Func<string, string> run = a => { Process p = Process.Start(new ProcessStartInfo(args[0], a) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true }); string o = p.StandardOutput.ReadToEnd(); p.WaitForExit(); return o.Trim() + "|" + p.ExitCode; };
      string v = run("vtable-selftest");
      Ok(v.StartsWith("{\"contract\":\"clued.independent-ci.companion-registrar/1\",\"code\":\"VTABLE_OK\"") && v.EndsWith("|0"), "vtable-slots-path-and-gettask");
      // Never "register-password <the real root>" here: run elevated, that would open the credential box. Another root is refused
      // before any box, elevated (REGISTRAR_ARGS_REFUSED) or not (REGISTRAR_ELEVATION_REQUIRED).
      string bad = run("register-password C:\\Temp");
      Ok(bad.IndexOf("REGISTRAR_ELEVATION_REQUIRED") > 0 || bad.IndexOf("REGISTRAR_ARGS_REFUSED") > 0, "register-refuses-other-root");
      // M5-b: the same for the account modes; never a real account name or the real root (elevated they would act)
      foreach (string a in new[] { "register-account C:\\Temp", "root-shell C:\\Temp", "prepare-account X", "account-facts S-1-5-18", "remove-account X", "register-account C:\\Temp a b c" }) {
        string r = run(a);
        Ok(r.IndexOf("REGISTRAR_ELEVATION_REQUIRED") > 0 || r.IndexOf("REGISTRAR_ARGS_REFUSED") > 0, "account-mode-refuses-bad-arguments:" + a);
      }
      // root-run: one ROOT_RUN_* line and nothing else on stdout, whatever is refused. Never the real root with a well-formed request
      // (elevated, that would change the account's password): another root, or a malformed request for the real one.
      foreach (string a in new[] { "write-probe", "write-probe C:\\Temp C:\\Temp\\install\\linux-run-" + runId + "-probe 60", "write-probe \"" + Root + "\" x 0" }) {
        string r = run(a);
        Ok(r == "ROOT_RUN_REFUSED REGISTRAR_ELEVATION_REQUIRED|2" || r == "ROOT_RUN_REFUSED REGISTRAR_ARGS_REFUSED|2", "write-probe-refuses-in-the-one-line-form:" + a + ":" + r);
      }
      { string r = run("capture-file C:\\Temp\\a C:\\Temp\\b"); Ok(r.IndexOf("REGISTRAR_ELEVATION_REQUIRED") > 0 || r.IndexOf("REGISTRAR_ARGS_REFUSED") > 0, "capture-file-refuses-other-paths:" + r); }
      foreach (string a in new[] { "root-run", "root-run C:\\Temp C:\\Temp\\install\\linux-run-" + runId + "\\script.sh " + runSha + " C:\\Temp\\install\\linux-run-" + runId + "\\out 60", "root-run \"" + Root + "\" x y z 0" }) {
        string r = run(a);
        Ok(r == "ROOT_RUN_REFUSED REGISTRAR_ELEVATION_REQUIRED|2" || r == "ROOT_RUN_REFUSED REGISTRAR_ARGS_REFUSED|2", "root-run-refuses-in-its-own-one-line-form:" + a + ":" + r);
      }
      // review r1 m3: file-sha256 reads unbuffered with the caller's token (no elevation) and gives the file's real hash
      string fh = run("file-sha256 \"" + args[0] + "\"");
      string want; using (System.Security.Cryptography.SHA256 h = System.Security.Cryptography.SHA256.Create()) want = BitConverter.ToString(h.ComputeHash(System.IO.File.ReadAllBytes(args[0]))).Replace("-", "").ToLowerInvariant();
      Ok(fh.IndexOf("\"code\":\"FILE_SHA256\"") > 0 && fh.IndexOf("\"sha256\":\"" + want + "\"") > 0 && fh.EndsWith("|0"), "file-sha256-unbuffered:" + fh);
    }

    Console.Out.WriteLine("{\"status\":\"REGISTRAR_PURE_PASS\",\"assertions\":" + n + "}");
    return 0;
  }
}
