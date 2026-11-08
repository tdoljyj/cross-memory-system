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
  const string Owner = "S-1-5-21-1173730660-3877291096-655431861-1001";

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
    Ok(RegistrarCore.QualifiedAccount("Windows", "", "DESK-W-591") == @"DESK-W-591\Windows", "account-bare-user");
    Ok(RegistrarCore.QualifiedAccount(@"DESK-W-591\Windows", "", "X") == @"DESK-W-591\Windows", "account-qualified");
    Ok(RegistrarCore.QualifiedAccount("Windows", "OTHER", "X") == @"OTHER\Windows", "account-domain");
    Ok(RegistrarCore.QualifiedAccount("", "", "X") == null, "account-empty");
    Ok(RegistrarCore.OwnerSidFromAcceptance("{\"node\":{\"ownerSid\":\"" + Owner + "\"}}") == Owner, "owner-sid-from-record");
    Ok(RegistrarCore.OwnerSidFromAcceptance("{\"node\":{\"ownerSid\":\"S-1-5-18\"}}") == null, "owner-sid-shape");
    Ok(RegistrarCore.OwnerSidFromAcceptance("{}") == null, "owner-sid-missing");

    // the compiled program: not elevated it refuses every mode but the read-only vtable self-test, which must pass
    if (args.Length == 1) {
      Func<string, string> run = a => { Process p = Process.Start(new ProcessStartInfo(args[0], a) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true }); string o = p.StandardOutput.ReadToEnd(); p.WaitForExit(); return o.Trim() + "|" + p.ExitCode; };
      string v = run("vtable-selftest");
      Ok(v.StartsWith("{\"contract\":\"clued.independent-ci.companion-registrar/1\",\"code\":\"VTABLE_OK\"") && v.EndsWith("|0"), "vtable-slots-path-and-gettask");
      // Never "register-password <the real root>" here: run elevated, that would open the credential box. Another root is refused
      // before any box, elevated (REGISTRAR_ARGS_REFUSED) or not (REGISTRAR_ELEVATION_REQUIRED).
      string bad = run("register-password C:\\Temp");
      Ok(bad.IndexOf("REGISTRAR_ELEVATION_REQUIRED") > 0 || bad.IndexOf("REGISTRAR_ARGS_REFUSED") > 0, "register-refuses-other-root");
    }

    Console.Out.WriteLine("{\"status\":\"REGISTRAR_PURE_PASS\",\"assertions\":" + n + "}");
    return 0;
  }
}
