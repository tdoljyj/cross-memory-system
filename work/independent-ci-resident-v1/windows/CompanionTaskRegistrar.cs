// CluedCompanionTaskRegistrar.exe (ADR 0022 §4.4, M5): the only place the Owner's Windows password ever is.
//
//   CluedCompanionTaskRegistrar.exe register-password "C:\ProgramData\CluedIndependentCI\resident"
//       Elevated only. Shows the Windows credential box on the SECURE desktop (CredUIPromptForWindowsCredentials with
//       CREDUIWIN_SECURE_PROMPT: the desktop of UAC, which a medium-integrity process can neither draw on nor read), the user name
//       pre-filled with the Owner; the account given must resolve (LookupAccountName) to the node profile's ownerSid. The password is
//       unpacked into a fixed unmanaged buffer, copied into a BSTR, and handed as VARIANT(BSTR) straight to
//       ITaskFolder::RegisterTaskDefinition(..., TASK_LOGON_PASSWORD, sddl) through the interface's own vtable (never a managed string);
//       the buffer, the BSTR and the packed credential are zeroed right after. Nothing of it reaches PowerShell, a file, a plan, a receipt,
//       a log, an environment variable or a command line. The output is one line of JSON with a code only: REGISTERED,
//       CREDENTIAL_NOT_GIVEN, ACCOUNT_MISMATCH, LOGON_REJECTED, ...
//   CluedCompanionTaskRegistrar.exe token-facts <pid>
//       Elevated only. The real token of one process, for rearm-resident.ps1's qualification (read from the elevated side, never the
//       process's own report): user SID, elevation type, whether Administrators is deny-only, session id and image path.
//   M5-b (ADR 0023), the companion's own non-administrator local account (the node profile's ownerSid); elevated only; no password
//   is ever typed or shown: each mode draws a new random one in an unmanaged buffer and zeroes it at the end.
//   CluedCompanionTaskRegistrar.exe prepare-account <name>
//       Before the reinstall: creates the local account (random password, Users only), grants SeBatchLogonRight and denies network
//       and remote-desktop logon, creates its profile. An existing account is only checked. Prints its SID and profile directory.
//   CluedCompanionTaskRegistrar.exe register-account "C:\ProgramData\CluedIndependentCI\resident" [<distro> <ext4.vhdx>]
//       Sets a new random password on the account (NetUserSetInfo 1003) and registers the companion password task with it (and,
//       with distro and vhdx, the one-shot task that runs wsl --import-in-place as the account). Refused unless the account is local,
//       enabled, not an administrator and not the caller, and unless the switch that started it holds the pending marker.
//   CluedCompanionTaskRegistrar.exe root-shell "C:\ProgramData\CluedIndependentCI\resident"
//       A new random password for the account and its existing password task, then wsl.exe --distribution <D> --user root in a new
//       console as the account: the Owner's way into the resident distribution's root.
//   CluedCompanionTaskRegistrar.exe root-run "C:\ProgramData\CluedIndependentCI\resident" <scriptPath> <sha256hex> <outDir> <timeoutSeconds>
//       One pinned root script in the resident distribution as the companion account (a reinstall's Linux steps; no console). The
//       script is <root>\install\linux-run-<32hex>\script.sh and outDir is that directory's out\ (both made by the elevated caller: the
//       directory admin-only, out\ writable by the account). root-shell's checks, then the script's SHA-256, then a new random password
//       for the account and its task, then cmd.exe /d /c ""wsl.exe" --distribution <the profile's> --user root --exec /usr/bin/env -i
//       PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc <the script's /mnt path> > out\stdout.txt 2> out\stderr.txt"
//       (LOGON_WITH_PROFILE, CREATE_NO_WINDOW). Stdout is exactly one line: ROOT_RUN_EXITED <code>, ROOT_RUN_TIMEOUT (the process is
//       left running, never killed) or ROOT_RUN_REFUSED <CODE>; stderr repeats a refusal as the usual JSON with its detail.
//       When the script has exited, its two output files are captured for the caller: each is opened WITHOUT following a link
//       (FILE_FLAG_OPEN_REPARSE_POINT), must be a plain file with one name (no reparse point, no directory, link count 1) of at most
//       4 MiB, and those bytes are written, create-only, into <directory>\captured\ (SYSTEM and Administrators only, made by the caller).
//       The caller reads captured\ and never out\, which the account can write.
//   CluedCompanionTaskRegistrar.exe write-probe "C:\ProgramData\CluedIndependentCI\resident" <probeDir> <timeoutSeconds>
//       The same path with no Linux in it, before a reinstall changes anything: <probeDir> is <root>\install\linux-run-<32hex>-probe,
//       laid out and protected exactly as a real run directory; root-run's checks and password change, then, as the account,
//       cmd.exe /d /c "echo x> out\stdout.txt 2> out\stderr.txt", the same wait and the same capture. Proves on this node that the
//       account can write the two files the caller made for it. The same one stdout line.
//       A capture that is refused does not hide the exit code: stdout is then two lines, ROOT_RUN_EXITED <code> and
//       CAPTURE_REFUSED <CODE> (the caller reads nothing and may capture again later with capture-file).
//   CluedCompanionTaskRegistrar.exe capture-file <source> <destination>
//       One file the account could write, captured the same way (no link followed, one name, at most 4 MiB), create-only, under the same
//       leaf name. Source: C:\ProgramData\CluedIndependentCI\reinstall-linux-out-<32hex>\<leaf> (a Linux step's output), or
//       <root>\install\linux-run-<32hex>\out\stdout.txt | stderr.txt (a run's own output, e.g. of a run that outlived its launcher).
//       Destination: <root>\install\linux-run-<32hex>\captured\<leaf> or ...\captured-<32hex>\<leaf> (a new capture directory the
//       elevated caller made); for a run's own output, in that same run directory. The destination directory must be there, plain,
//       owned by Administrators with a protected DACL of SYSTEM and Administrators only.
//   CluedCompanionTaskRegistrar.exe account-facts <sid>
//       Read-only facts of the account: local, enabled, administrator, rights held directly, profile directory.
//   CluedCompanionTaskRegistrar.exe grant-service-logon <sid>
//       Elevated only. SeServiceLogonRight for one local account (the first install's clued-control), by the account-rights interface:
//       the same grant prepare-account gives the companion its batch logon with (GrantRights), never by writing back the security policy
//       (Fable renew-key ruling, supplement "service logon grant"). RIGHT_GRANTED, or RIGHT_NOT_GRANTED with the step it stopped in and
//       the system's raw status: "resolve" (not a local account), "open:<NTSTATUS>:<win32>" (LsaOpenPolicy), "grant:<NTSTATUS>:<win32>"
//       (LsaAddAccountRights). The caller reads the account's rights back (account-facts) before it counts the grant.
//   CluedCompanionTaskRegistrar.exe vtable-selftest
//       Read-only: proves the vtable slots this program calls by reading the root folder's Path (slot 8) and asking for a task that
//       does not exist (GetTask, slot 13). RegistrarPureTests.cs runs it offline.
//
// Compiled by install-resident.ps1 into the admin-only bin\ (/noconfig, full reference paths, winexe: the codes go to stdout).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class RegistrarCore {
  public const string FixedRoot = @"C:\ProgramData\CluedIndependentCI\resident";
  public const string TaskFolder = @"\Clued";
  public const string TaskName = "CluedCIResidentCompanion";
  public const string Contract = "clued.independent-ci.companion-registrar/1";
  static readonly Regex Sid = new Regex(@"\AS-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z");
  public static bool ValidSid(string s) { return s != null && Sid.IsMatch(s); }
  // The task's protection (ADR 0022 §4.1): SYSTEM and Administrators full, the Owner read only (no execute: the Owner's session
  // cannot Run it again and again to lock the account; the notifier can still read State and LastTaskResult).
  public static string TaskSddl(string ownerSid) { return "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;" + ownerSid + ")"; }
  public static string SupervisorPath(string root) { return root + @"\bin\CluedCompanionSupervisor.exe"; }
  public static string SupervisorArguments(string root) { return "\"" + root + "\""; }
  static string X(string s) { return System.Security.SecurityElement.Escape(s); }
  // The password task (ADR 0022 §4.1): a boot trigger 30 s after start and a time trigger repeated every 15 minutes for ever; no
  // log-on trigger, no restart on failure (the supervisor restarts the child); IgnoreNew; no time limit; never stopped on battery.
  public static string PasswordTaskXml(string root, string ownerSid) {
    if (!ValidSid(ownerSid)) throw new ArgumentException("OWNER_SID_INVALID");
    return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
      + "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
      + "<RegistrationInfo><Description>Clued CI resident companion (supervisor). ADR 0022.</Description></RegistrationInfo>"
      + "<Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>"
      + "<TimeTrigger><Enabled>true</Enabled><StartBoundary>2026-01-01T00:00:00</StartBoundary><Repetition><Interval>PT15M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger></Triggers>"
      + "<Principals><Principal id=\"Author\"><UserId>" + X(ownerSid) + "</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>"
      + "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
      + "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>"
      + "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>"
      + "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>"
      + "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>"
      + "<Actions Context=\"Author\"><Exec><Command>" + X(SupervisorPath(root)) + "</Command><Arguments>" + X(SupervisorArguments(root)) + "</Arguments></Exec></Actions>"
      + "</Task>";
  }
  // HRESULTs of RegisterTaskDefinition -> the code printed. The Task Scheduler checks the password when it registers a password task.
  public static string RegisterCode(int hr) {
    switch ((uint)hr) {
      case 0: return "REGISTERED";
      case 0x8007052E: return "LOGON_REJECTED";
      case 0x8007052F: return "LOGON_REJECTED_ACCOUNT_RESTRICTION";
      case 0x80070530: return "LOGON_REJECTED_LOGON_HOURS";
      case 0x80070531: return "LOGON_REJECTED_WORKSTATION";
      case 0x80070701: return "LOGON_REJECTED_ACCOUNT_EXPIRED";
      case 0x80070773: return "LOGON_REJECTED_PASSWORD_MUST_CHANGE";
      case 0x80070532: return "LOGON_REJECTED_PASSWORD_EXPIRED";
      case 0x80070533: return "LOGON_REJECTED_ACCOUNT_DISABLED";
      case 0x80070569: return "LOGON_REJECTED_RIGHT_NOT_GRANTED";
      case 0x80070775: return "LOGON_REJECTED_ACCOUNT_LOCKED";
      case 0x80070005: return "REGISTER_ACCESS_DENIED";
      default: return "REGISTER_FAILED";
    }
  }
  // The account the credential box returned, as "DOMAIN\user" (or a bare user, read as this computer's).
  public static string QualifiedAccount(string user, string domain, string machine) {
    if (string.IsNullOrEmpty(user)) return null;
    if (user.IndexOf('\\') >= 0) return user;
    if (user.IndexOf('@') >= 0) return user;   // a UPN: LookupAccountName resolves it, and a Microsoft account is then refused by SID
    return (string.IsNullOrEmpty(domain) ? machine : domain) + "\\" + user;
  }
  // The output: a code, and at most a hex HRESULT or a task XML hash. Never text from the box.
  public static string Output(string code, string detail) {
    Dictionary<string, object> v = new Dictionary<string, object>();
    v["contract"] = Contract; v["code"] = code;
    if (detail != null && Regex.IsMatch(detail, @"\A[0-9A-Za-z_.:-]{1,80}\z")) v["detail"] = detail;
    return new JavaScriptSerializer().Serialize(v);
  }
  public static string Sha256Text(string t) {
    using (SHA256 h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(t))).Replace("-", "").ToLowerInvariant();
  }
  // Review round 3: the password is handed over only while the switch that started this program still runs and still holds its
  // pending marker (install\companion-headless-pending.json): the marker's pid is this program's parent and its start time matches.
  // Otherwise a fall-back may already have run (the switch ended while the box was open), and a password task would be left with no
  // marker and no fall-back task. null: matches; else the code.
  public static string PendingRefusal(string markerJson, int parentPid, string parentStartUtc) {
    if (markerJson == null) return "PENDING_MARKER_MISSING";
    Dictionary<string, object> d;
    try { d = new JavaScriptSerializer().DeserializeObject(markerJson) as Dictionary<string, object>; } catch { return "PENDING_MARKER_UNREADABLE"; }
    object pid, start, contract;
    if (d == null || !d.TryGetValue("contract", out contract) || (contract as string) != "clued.independent-ci.companion-headless-pending/1") return "PENDING_MARKER_UNREADABLE";
    if (!d.TryGetValue("pid", out pid) || !(pid is int) || (int)pid != parentPid) return "PENDING_MARKER_NOT_THIS_SWITCH";
    if (!d.TryGetValue("processStart", out start) || parentStartUtc == null || (start as string) != parentStartUtc) return "PENDING_MARKER_NOT_THIS_SWITCH";
    return null;
  }
  // 2026-11-08 (30th DESK): the detail of REGISTRAR_UNEXPECTED, "step:ExceptionType:0xHRESULT": the step RegisterPassword was in
  // ("main" outside it), the exception's short type name and HRESULT (an InvokeMember wrapper is unwrapped). Never the message, never an
  // input. Steps register and readback are from the password's hand-over on; every earlier step is before it.
  public static string UnexpectedDetail(Exception e) {
    string step = "main";
    RegistrarStepException se = e as RegistrarStepException;
    if (se != null) { if (se.Step != null && Regex.IsMatch(se.Step, @"\A[a-z]{1,16}\z")) step = se.Step; e = se.Cause; }
    while (e is System.Reflection.TargetInvocationException && e.InnerException != null) e = e.InnerException;
    if (e == null) return step + ":none:0x00000000";
    string type = Regex.Replace(e.GetType().Name, "[^A-Za-z0-9_]", "");
    if (type.Length == 0) type = "unknown";
    if (type.Length > 40) type = type.Substring(0, 40);
    return step + ":" + type + ":0x" + e.HResult.ToString("X8");
  }
  // 2026-11-08 (30th DESK, live switch at 07:00Z): CredUnPackAuthenticationBufferW with CRED_PACK_PROTECTED_CREDENTIALS failed with
  // GetLastError 775 for the buffer the secure-desktop box returned; with flags 0 the same buffer unpacked and the registration succeeded.
  // So the protected unpack is tried first and, failing with 775 only, the plain one; any other error is final.
  public static bool UnpackRetryPlain(int protectedError) { return protectedError == 775; }
  // The detail of CREDENTIAL_UNPACK_FAILED: the error numbers of both tries, nothing else (review L1: not even the packed buffer's size,
  // from which the password's length could be inferred). Never the user name, the domain or the password.
  public static string UnpackDetail(int protectedError, bool retried, int plainError) {
    return "protected:" + protectedError + ":plain:" + (retried ? plainError.ToString() : "skipped");
  }
  // CRED_PROTECTION_TYPE: CredUnprotected (0) is the only kind the plain unpack may hand over (review L2: anything else would be the
  // protected form, never the password).
  public static bool PlainUnpackUsable(bool checkedOk, int protectionType) { return checkedOk && protectionType == 0; }
  // ---- M5-b (ADR 0023): the companion runs as its own non-administrator local account (the node profile's ownerSid) ----
  // Its password is never typed and never known to anyone: register-account draws a new random one, sets it on the account
  // (NetUserSetInfo level 1003, an administrator may) and hands the same buffer to the Task Scheduler; then it is zeroed.
  public const int RandomPasswordChars = 32;
  public const string ImportTaskName = "CluedCIResidentCompanionWslImport";
  public const string ImportTaskSddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)";
  public const string WslExe = @"C:\Program Files\WSL\wsl.exe";
  public const string MachineWslClientScript = @"# Shared with RegistrarCore.MachineWslClientScript; tests hold the resolver identical.
# Definitions only. No WSL command, installation or account change occurs here.
function Get-CluedMachineWslClient {
  try { foreach ($m in @('Management', 'Security', 'Utility')) { Import-Module ('C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.' + $m + '\Microsoft.PowerShell.' + $m + '.psd1') -ErrorAction Stop } } catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  $p = 'C:\Program Files\WSL\wsl.exe'
  foreach ($v in @('C:\', 'C:\Program Files', 'C:\Program Files\WSL', $p)) {
    try { $i = Microsoft.PowerShell.Management\Get-Item -LiteralPath $v -Force -ErrorAction Stop }
    catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { throw 'WSL_MACHINE_CLIENT_MISSING' }; throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
    if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($v -ceq $p -and $i.PSIsContainer) -or ($v -cne $p -and -not $i.PSIsContainer)) { throw 'WSL_MACHINE_CLIENT_NOT_PLAIN' }
  }
  try { $s = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop }
  catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  if ([string]$s.Status -cne 'Valid') { throw 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID' }
  $c = $s.SignerCertificate
  if ($null -eq $c -or $c.Subject -cnotmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)' -or
      $c.Subject -cnotmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)' -or
      $c.Thumbprint -cnotmatch '^[0-9A-Fa-f]{40}$') { throw 'WSL_MACHINE_CLIENT_PUBLISHER_INVALID' }
  try { $h = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash }
  catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  if ($h -cnotmatch '^[0-9A-Fa-f]{64}$') { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  [pscustomobject]@{ contract = 'clued.independent-ci.wsl-client/1'; path = $p; sha256 = $h.ToLowerInvariant(); signerThumbprint = $c.Thumbprint.ToUpperInvariant() }
}
";
  const string PwUpper = "ABCDEFGHJKLMNPQRSTUVWXYZ", PwLower = "abcdefghijkmnopqrstuvwxyz", PwDigits = "23456789", PwSymbols = "!#%+-.:=?@^_~";
  public static string PasswordAlphabet { get { return PwUpper + PwLower + PwDigits + PwSymbols; } }
  // One random byte -> one password character, by rejection (bytes 210..255 are dropped, so every character of the 70 is as likely):
  // the alphabet index, or -1 for a dropped byte.
  public static int PasswordIndex(byte b) { int n = PasswordAlphabet.Length; return b < n * (256 / n) ? b % n : -1; }
  // 1 upper, 2 lower, 4 digit, 8 symbol; a password is used only when its classes add up to 15 (Windows complexity is then met
  // whatever the local policy asks).
  public static int PasswordClass(char c) {
    if (PwUpper.IndexOf(c) >= 0) return 1; if (PwLower.IndexOf(c) >= 0) return 2; if (PwDigits.IndexOf(c) >= 0) return 4; if (PwSymbols.IndexOf(c) >= 0) return 8;
    return 0;
  }
  static readonly Regex Distro = new Regex(@"\A[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z");
  static readonly Regex Vhdx = new Regex(@"\A[A-Z]:\\(?:[A-Za-z0-9._-]{1,64}\\){1,15}ext4\.vhdx\z");
  static readonly Regex AccountName = new Regex(@"\A[a-z][a-z0-9-]{2,19}\z");
  public static bool ValidDistro(string s) { return s != null && Distro.IsMatch(s); }
  public static bool ValidVhdx(string s) { return s != null && Vhdx.IsMatch(s) && s.IndexOf(@"\..\", StringComparison.Ordinal) < 0 && s.IndexOf(@"\.\", StringComparison.Ordinal) < 0; }
  public static bool ValidAccountName(string s) { return s != null && AccountName.IsMatch(s); }
  // The companion account must be a local account of this computer, enabled, not an administrator (directly or through a group)
  // and not the account running this program (the Owner). null: usable; else the code.
  public static string AccountRefusal(string accountDomain, string machine, bool enabled, bool administrator, bool isCaller) {
    if (!string.Equals(accountDomain, machine, StringComparison.OrdinalIgnoreCase)) return "COMPANION_ACCOUNT_NOT_LOCAL";
    if (isCaller) return "COMPANION_ACCOUNT_IS_THE_CALLER";
    if (administrator) return "COMPANION_ACCOUNT_IS_ADMINISTRATOR";
    if (!enabled) return "COMPANION_ACCOUNT_DISABLED";
    return null;
  }
  // The one-shot task that registers the moved distribution for the companion account (wsl --import-in-place, which only registers
  // the existing ext4.vhdx: nothing is copied or unpacked). On demand only: no trigger; the same random password as the companion task.
  // Review r1 m1/m11: its action is ImportScript as -EncodedCommand (no quoting through cmd or the task XML): exit 0 only when the
  // distribution is registered for the account and runs; an import that fails because a cut-off earlier run already registered it is
  // accepted when the distribution then starts; the Owner's DefaultUid is written back (it was 1000 on TURING; import-in-place gives 0).
  public static string ImportScript(string distro, string vhdx, long defaultUid) {
    if (!ValidDistro(distro) || !ValidVhdx(vhdx) || defaultUid < 0 || defaultUid > 4294967295L) throw new ArgumentException("IMPORT_ARGUMENTS_INVALID");
    // WSL parses its leading options from the raw command line, unlike a CRT
    // argv consumer: quoting "--version" makes it a Linux command. Every token
    // below is fixed or passes the no-whitespace/no-quote Distro/Vhdx grammar,
    // so join the validated tokens without quotes. FileName remains separate.
    // Fixed commands, bounded streams and an atomic result under the already
    // protected VHDX directory. This file is diagnostic only, never a grant or
    // the success verdict used to remove the Owner's registration.
    string script = @"$ErrorActionPreference = 'Stop'
$wsl = $null
__WSL_CLIENT__
$distro = '__DISTRO__'; $vhdx = '__VHDX__'; $defaultUid = __UID__
$directory = [IO.Path]::GetDirectoryName($vhdx)
$diagnosticPath = [IO.Path]::Combine($directory, 'companion-wsl-import-result.json')
$record = [ordered]@{ contract = 'clued.independent-ci.companion-wsl-import-result/1'; runId = [guid]::NewGuid().ToString('D')
  startedAt = [DateTimeOffset]::UtcNow.ToString('o'); finishedAt = $null; phase = 'starting'; exitCode = $null
  distro = $distro; vhdx = $vhdx; defaultUid = $defaultUid; identity = $null; file = $null; commands = @(); registration = $null; client = $null; refusal = $null; error = $null }
$diagnosticSid = ''
function Get-ImportDiagnosticAcl {
  if ($script:diagnosticSid -cnotmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$') { throw 'DIAGNOSTIC_OWNER_UNCONFIRMED' }
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FR;;;SY)(A;;FR;;;BA)(A;;0x1301bf;;;' + $script:diagnosticSid + ')'), [Security.AccessControl.AccessControlSections]::Access)
  $acl
}
function Assert-ImportDiagnosticAcl($acl) {
  $actual = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  $want = New-Object Security.AccessControl.RawSecurityDescriptor((Get-ImportDiagnosticAcl).GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $actual.Owner -or $actual.Owner.Value -cne $script:diagnosticSid -or ($actual.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or $actual.DiscretionaryAcl.Count -ne 3) { throw 'DIAGNOSTIC_ACL_REFUSED' }
  for ($i = 0; $i -lt 3; $i++) {
    $a = $actual.DiscretionaryAcl[$i]; $w = $want.DiscretionaryAcl[$i]
    if ($a.AceType -ne $w.AceType -or $a.AceFlags -ne $w.AceFlags -or $a.AccessMask -ne $w.AccessMask -or $a.SecurityIdentifier.Value -cne $w.SecurityIdentifier.Value) { throw 'DIAGNOSTIC_ACL_REFUSED' }
  }
}
function Protect-ImportDiagnostic([string]$path) {
  $owner = ([IO.File]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Owner)).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -cne $script:diagnosticSid) { throw 'DIAGNOSTIC_OWNER_UNCONFIRMED' }
  [IO.File]::SetAccessControl($path, (Get-ImportDiagnosticAcl))
  Assert-ImportDiagnosticAcl ([IO.File]::GetAccessControl($path))
}
function Write-ImportDiagnostic {
  foreach ($path in @($directory, $diagnosticPath)) {
    if ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) {
      if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'DIAGNOSTIC_REPARSE_REFUSED' }
    }
  }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($script:record | ConvertTo-Json -Depth 7 -Compress))
  if ($bytes.Length -gt 65536) { throw 'DIAGNOSTIC_SIZE_REFUSED' }
  $tmp = $diagnosticPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $rights = [Security.AccessControl.FileSystemRights]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::ReadPermissions)
    $stream = New-Object IO.FileStream($tmp, [IO.FileMode]::CreateNew, $rights, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, (Get-ImportDiagnosticAcl))
    try { Assert-ImportDiagnosticAcl ($stream.GetAccessControl()); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($diagnosticPath)) { Protect-ImportDiagnostic $diagnosticPath; [IO.File]::Replace($tmp, $diagnosticPath, [NullString]::Value) }
    else { [IO.File]::Move($tmp, $diagnosticPath) }
    Protect-ImportDiagnostic $diagnosticPath
  } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function Convert-ImportOutput($reader) {
  $bytes = $reader.bytes.ToArray(); $unicode = $false
  if ($bytes.Length -ge 2) {
    $unicode = ($bytes[0] -eq 255 -and $bytes[1] -eq 254)
    if (-not $unicode) {
      $nullOdd = 0
      for ($i = 1; $i -lt [Math]::Min(64, $bytes.Length); $i += 2) { if ($bytes[$i] -eq 0) { $nullOdd++ } }
      $unicode = ($nullOdd -ge 3)
    }
  }
  # Strict UTF8 first; GB18030 also decodes the GBK bytes observed from legacy WSL.
  $text = if ($unicode) { [Text.Encoding]::Unicode.GetString($bytes) } else { try { (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) } catch { [Text.Encoding]::GetEncoding(54936).GetString($bytes) } }
  if ($text.Length -gt 1024) { $reader.truncated = $true }
  $text = $text.TrimStart([char]0xFEFF) -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', ''
  $text = $text -replace '(?im)^.*(?:token|password|secret|credential|authorization|private[_ -]?key|BEGIN .*PRIVATE KEY).*$', '[REDACTED_SENSITIVE_LINE]'
  $text = $text -replace '(?i)(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|clued_(?:bnd|hbt|lk)_[A-Za-z0-9_-]+|Bearer\s+\S+)', '[REDACTED]'
  $text = $text -replace '[A-Za-z0-9_+\/=\-]{48,}', '[REDACTED_LONG_VALUE]'
  if ($text.Length -gt 1024) { $reader.truncated = $true; $text = $text.Substring(0, 1024) }
  $text
}
function Invoke-ImportWsl([string]$phase, [string[]]$arguments, [int]$timeoutMs) {
  $script:record.phase = $phase; Write-ImportDiagnostic
  $entry = [ordered]@{ phase = $phase; exitCode = $null; stdout = ''; stderr = ''; truncated = $false; timedOut = $false; error = $null }
  $process = New-Object Diagnostics.Process
  $process.StartInfo = New-Object Diagnostics.ProcessStartInfo
  $process.StartInfo.FileName = $wsl
  $process.StartInfo.Arguments = $arguments -join ' '
  $process.StartInfo.UseShellExecute = $false; $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.WorkingDirectory = $directory
  $process.StartInfo.RedirectStandardOutput = $true; $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.EnvironmentVariables['WSL_UTF8'] = '1'
  $readers = @(); $watch = [Diagnostics.Stopwatch]::StartNew(); $exitSeen = $null
  try {
    if (-not $process.Start()) { throw 'WSL_PROCESS_NOT_STARTED' }
    foreach ($stream in @($process.StandardOutput.BaseStream, $process.StandardError.BaseStream)) {
      $reader = [ordered]@{ stream = $stream; buffer = (New-Object byte[] 4096); bytes = (New-Object IO.MemoryStream); pending = $null; ended = $false; truncated = $false }
      $reader.pending = $stream.BeginRead($reader.buffer, 0, $reader.buffer.Length, $null, $null)
      $readers += $reader
    }
    while ($true) {
      foreach ($reader in $readers) {
        if (-not $reader.ended -and $reader.pending.IsCompleted) {
          $count = $reader.stream.EndRead($reader.pending)
          if ($count -eq 0) { $reader.ended = $true; continue }
          $keep = [Math]::Min($count, [Math]::Max(0, 16384 - [int]$reader.bytes.Length))
          if ($keep -gt 0) { $reader.bytes.Write($reader.buffer, 0, $keep) }
          if ($keep -lt $count) { $reader.truncated = $true }
          $reader.pending = $reader.stream.BeginRead($reader.buffer, 0, $reader.buffer.Length, $null, $null)
        }
      }
      if ($process.HasExited) {
        if ($null -eq $exitSeen) { $exitSeen = $watch.ElapsedMilliseconds }
        if (($readers[0].ended -and $readers[1].ended) -or $watch.ElapsedMilliseconds - $exitSeen -gt 1000) { break }
      }
      if ($watch.ElapsedMilliseconds -ge $timeoutMs) {
        $entry.timedOut = $true
        try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { }
        break
      }
      [Threading.Thread]::Sleep(10)
    }
    $entry.exitCode = if ($process.HasExited -and -not $entry.timedOut) { $process.ExitCode } else { -1 }
  } catch {
    $entry.error = [ordered]@{ type = $_.Exception.GetType().Name; hresult = ('0x{0:X8}' -f $_.Exception.HResult) }
    $entry.exitCode = -1
  } finally {
    if ($readers.Count -eq 2) {
      $entry.stdout = Convert-ImportOutput $readers[0]; $entry.stderr = Convert-ImportOutput $readers[1]
      $entry.truncated = [bool]($readers[0].truncated -or $readers[1].truncated -or -not $readers[0].ended -or -not $readers[1].ended)
    }
    foreach ($reader in $readers) { $reader.stream.Dispose(); $reader.bytes.Dispose() }
    $process.Dispose(); $watch.Stop()
    $script:record.commands += $entry
    Write-ImportDiagnostic
  }
  $entry
}
$code = 6
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $script:diagnosticSid = $sid
  $hive = [Microsoft.Win32.Registry]::Users.OpenSubKey($sid)
  try { $record.identity = [ordered]@{ sid = $sid; profileDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile); userHiveLoaded = ($null -ne $hive) } }
  finally { if ($null -ne $hive) { $hive.Dispose() } }
  try {
    $v = [IO.File]::Open($vhdx, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { $record.file = [ordered]@{ readable = $true; hresult = $null } } finally { $v.Dispose() }
  } catch { $record.file = [ordered]@{ readable = $false; hresult = ('0x{0:X8}' -f $_.Exception.HResult) } }
  Write-ImportDiagnostic
  $record.phase = 'client-validation'
  try { $record.client = Get-CluedMachineWslClient; $wsl = [string]$record.client.path }
  catch { $record.refusal = if ($_.Exception.Message -cmatch '^WSL_MACHINE_CLIENT_[A-Z_]+$') { $_.Exception.Message } else { 'WSL_MACHINE_CLIENT_UNREADABLE' }; $code = 8; throw }
  $null = Invoke-ImportWsl 'version' @('--version') 15000
  $null = Invoke-ImportWsl 'status' @('--status') 15000
  $import = Invoke-ImportWsl 'import' @('--import-in-place', $distro, $vhdx) 120000
  $probe = Invoke-ImportWsl 'probe' @('--distribution', $distro, '--exec', '/bin/true') 120000
  if ($probe.exitCode -ne 0) { $code = 3 }
  else {
    $record.phase = 'registration'
    $k = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | Where-Object { [string](Get-ItemProperty -LiteralPath $_.PSPath).DistributionName -ceq $distro })
    $sameBase = $false
    if ($k.Count -eq 1) {
      $registered = Get-ItemProperty -LiteralPath $k[0].PSPath
      $base = ([string]$registered.BasePath) -replace '^\\\\\?\\', ''
      $sameBase = [string]::Equals($base.TrimEnd('\'), $directory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    }
    $record.registration = [ordered]@{ matches = $k.Count; basePathMatches = $sameBase }
    if ($k.Count -ne 1 -or -not $sameBase) { $code = 4 }
    else {
      $record.phase = 'default_uid'
      try { Set-ItemProperty -LiteralPath $k[0].PSPath -Name 'DefaultUid' -Value $defaultUid -Type DWord; $code = 0; $record.phase = 'complete' }
      catch { $code = 5; $record.error = [ordered]@{ type = $_.Exception.GetType().Name; hresult = ('0x{0:X8}' -f $_.Exception.HResult) } }
    }
  }
} catch { $record.error = [ordered]@{ type = $_.Exception.GetType().Name; hresult = ('0x{0:X8}' -f $_.Exception.HResult) } }
finally {
  $record.exitCode = $code; $record.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  try { Write-ImportDiagnostic } catch { $code = 7; [Console]::Error.WriteLine('WSL_IMPORT_DIAGNOSTICS_UNWRITABLE') }
}
exit $code
";
    // Fixed source only: drop indentation to retain the Win32 EncodedCommand limit, including the maximum validated VHDX path.
    script = Regex.Replace(script.Replace("__WSL_CLIENT__", MachineWslClientScript), @"(?m)^[ \t]+", "");
    script = Regex.Replace(script, @"(?m)^#[^\r\n]*(?:\r?\n|$)", "");
    // Short fixed-local spellings keep the generated action below Win32's 32767-character limit. No input is code.
    foreach (string[] pair in new string[][] {
      new string[] { "$script:record", "$script:r" }, new string[] { "$record", "$r" },
      new string[] { "$script:diagnosticSid", "$script:ds" }, new string[] { "$diagnosticPath", "$dp" }, new string[] { "$diagnosticSid", "$ds" },
      new string[] { "$directory", "$dir" }, new string[] { "$readers", "$rr" }, new string[] { "$reader", "$rd" },
      new string[] { "$process", "$proc" }, new string[] { "$timeoutMs", "$ms" }, new string[] { "$entry", "$e" },
      new string[] { "$count", "$n" }, new string[] { "$keep", "$kp" }, new string[] { "$phase", "$ph" }, new string[] { "$path", "$pt" }, new string[] { "$bytes", "$b" }, new string[] { "$text", "$t" }, new string[] { "$registered", "$reg" }, new string[] { "$sameBase", "$same" }, new string[] { "$unicode", "$uni" },
      new string[] { "$nullOdd", "$odd" }, new string[] { "$defaultUid", "$uid" }, new string[] { "$arguments", "$av" },
      new string[] { "$watch", "$sw" }, new string[] { "$exitSeen", "$ex" }, new string[] { "$stream", "$st" },
      new string[] { "$owner", "$ow" }, new string[] { "$rights", "$fr" }, new string[] { "$actual", "$ac" }, new string[] { "$want", "$wa" },
      new string[] { "Invoke-ImportWsl", "Invoke-IW" }, new string[] { "Convert-ImportOutput", "Convert-IO" }, new string[] { "Get-ImportDiagnosticAcl", "Get-DiagAcl" }, new string[] { "Assert-ImportDiagnosticAcl", "Assert-DiagAcl" },
      new string[] { "Protect-ImportDiagnostic", "Protect-Diag" }, new string[] { "Write-ImportDiagnostic", "Write-Diag" }
    }) script = script.Replace(pair[0], pair[1]);
    return script.Replace("__DISTRO__", distro).Replace("__VHDX__", vhdx)
      .Replace("__UID__", defaultUid.ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
  public const string PowerShellExe = @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
  // Same read-only trust check as the account's import program. In particular a
  // root-shell refusal happens before drawing or changing any account password.
  public static string MachineWslClientRefusal() {
    string command = MachineWslClientScript + "\ntry { $null = Get-CluedMachineWslClient; [Console]::Out.Write('WSL_MACHINE_CLIENT_VALID') } catch { $c = $_.Exception.Message; if ($c -cnotmatch '^WSL_MACHINE_CLIENT_[A-Z_]+$') { $c = 'WSL_MACHINE_CLIENT_UNREADABLE' }; [Console]::Out.Write($c); exit 2 }";
    System.Diagnostics.ProcessStartInfo info = new System.Diagnostics.ProcessStartInfo(PowerShellExe,
      "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command)));
    info.UseShellExecute = false; info.CreateNoWindow = true; info.WorkingDirectory = @"C:\Windows\System32";
    info.RedirectStandardOutput = true; info.RedirectStandardError = true;
    using (System.Diagnostics.Process process = new System.Diagnostics.Process()) {
      process.StartInfo = info;
      try {
        if (!process.Start()) return "WSL_MACHINE_CLIENT_UNREADABLE";
        System.Threading.Tasks.Task<string> output = process.StandardOutput.ReadToEndAsync(), errors = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30000)) { try { process.Kill(); process.WaitForExit(2000); } catch { } return "WSL_MACHINE_CLIENT_UNREADABLE"; }
        if (!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { output, errors }, 2000)) return "WSL_MACHINE_CLIENT_UNREADABLE";
        string code = output.Result.Trim();
        if (process.ExitCode == 0 && code == "WSL_MACHINE_CLIENT_VALID") return null;
        return Regex.IsMatch(code, @"\AWSL_MACHINE_CLIENT_[A-Z_]+\z") ? code : "WSL_MACHINE_CLIENT_UNREADABLE";
      } catch { return "WSL_MACHINE_CLIENT_UNREADABLE"; }
    }
  }
  public static string ImportArguments(string distro, string vhdx, long defaultUid) {
    return "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(ImportScript(distro, vhdx, defaultUid)));
  }
  public static string ImportTaskXml(string accountSid, string distro, string vhdx, long defaultUid) {
    if (!ValidSid(accountSid)) throw new ArgumentException("ACCOUNT_SID_INVALID");
    string arguments = ImportArguments(distro, vhdx, defaultUid);
    return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
      + "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
      + "<RegistrationInfo><Description>Clued CI: one-shot WSL registration of the resident distribution for the companion account. ADR 0023.</Description></RegistrationInfo>"
      + "<Principals><Principal id=\"Author\"><UserId>" + X(accountSid) + "</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>"
      + "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
      + "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable>"
      + "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>"
      + "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>"
      + "<ExecutionTimeLimit>PT30M</ExecutionTimeLimit><Priority>7</Priority></Settings>"
      + "<Actions Context=\"Author\"><Exec><Command>" + X(PowerShellExe) + "</Command><Arguments>" + X(arguments) + "</Arguments></Exec></Actions>"
      + "</Task>";
  }
  // Review r1 M2: the definition a failed password registration falls back to (no password needed): the companion account's
  // interactive token at its log-on (it never logs on interactively, so the task never runs and never tries a stale password), the
  // supervisor's fixed action; the same as Register-CompanionTaskInteractive (companion-headless.ps1).
  public static string InteractiveTaskXml(string root, string accountSid) {
    if (!ValidSid(accountSid)) throw new ArgumentException("ACCOUNT_SID_INVALID");
    return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
      + "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
      + "<RegistrationInfo><Description>Clued CI resident companion (supervisor), parked: interactive token. ADR 0023.</Description></RegistrationInfo>"
      + "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + X(accountSid) + "</UserId></LogonTrigger></Triggers>"
      + "<Principals><Principal id=\"Author\"><UserId>" + X(accountSid) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>"
      + "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
      + "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable>"
      + "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>"
      + "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>"
      + "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>"
      + "<Actions Context=\"Author\"><Exec><Command>" + X(SupervisorPath(root)) + "</Command><Arguments>" + X(SupervisorArguments(root)) + "</Arguments></Exec></Actions>"
      + "</Task>";
  }
  // Review r1 m5: what the companion account must look like besides local / enabled / not an administrator: a member of Users only,
  // its password never expires and it cannot change it, network and remote-desktop logon denied, hidden from the sign-in screen.
  public const int UfPasswdCantChange = 0x40, UfDontExpirePasswd = 0x10000;
  public static List<string> HardeningProblems(IEnumerable<string> groups, string usersGroup, int flags, IEnumerable<string> rights, bool hidden) {
    List<string> o = new List<string>();
    List<string> g = new List<string>(groups ?? new string[0]);
    if (g.Count != 1 || !string.Equals(g[0], usersGroup, StringComparison.OrdinalIgnoreCase)) o.Add("GROUPS_NOT_USERS_ONLY");
    if ((flags & UfDontExpirePasswd) == 0) o.Add("PASSWORD_EXPIRES");
    if ((flags & UfPasswdCantChange) == 0) o.Add("PASSWORD_CHANGEABLE");
    List<string> r = new List<string>(rights ?? new string[0]);
    if (!r.Contains("SeDenyNetworkLogonRight")) o.Add("NETWORK_LOGON_NOT_DENIED");
    if (!r.Contains("SeDenyRemoteInteractiveLogonRight")) o.Add("RDP_LOGON_NOT_DENIED");
    if (!hidden) o.Add("NOT_HIDDEN");
    return o;
  }
  // ---- root-run: one pinned root script as the companion account ----
  // The arguments: "root-run"; the fixed root; <root>\install\linux-run-<32hex>\script.sh; its SHA-256 (lower-case hex); that
  // directory's out\; a timeout of 1..86400 seconds in plain digits. Paths are compared as written (ordinal): no other spelling, no
  // "..", no blank or quote can reach the command line. null: refused.
  public const int RootRunMaxSeconds = 86400;
  static readonly Regex RootRunScript = new Regex(@"\A\\install\\linux-run-[0-9a-f]{32}\\script\.sh\z");
  static readonly Regex Sha256Hex = new Regex(@"\A[0-9a-f]{64}\z");
  public static RootRunRequest ParseRootRun(string[] args) {
    if (args == null || args.Length != 6) return null;
    foreach (string a in args) if (a == null) return null;
    if (args[0] != "root-run" || !string.Equals(args[1], FixedRoot, StringComparison.OrdinalIgnoreCase)) return null;
    string script = args[2], outDir = args[4];
    if (!script.StartsWith(FixedRoot, StringComparison.Ordinal) || !RootRunScript.IsMatch(script.Substring(FixedRoot.Length))) return null;
    string dir = script.Substring(0, script.Length - @"\script.sh".Length);
    if (!string.Equals(outDir, dir + @"\out", StringComparison.Ordinal)) return null;
    if (!Sha256Hex.IsMatch(args[3])) return null;
    if (!Regex.IsMatch(args[5], @"\A[1-9][0-9]{0,4}\z")) return null;
    int seconds = int.Parse(args[5], System.Globalization.CultureInfo.InvariantCulture);
    if (seconds > RootRunMaxSeconds) return null;
    string wsl = WslPath(script);
    if (wsl == null) return null;
    return new RootRunRequest(script, args[3], dir, outDir, seconds, wsl, false);
  }
  // write-probe <root> <root>\install\linux-run-<32hex>-probe <1..600 seconds>: a run directory in everything but its name, no script.
  static readonly Regex ProbeDirectory = new Regex(@"\A\\install\\linux-run-[0-9a-f]{32}-probe\z");
  public static RootRunRequest ParseWriteProbe(string[] args) {
    if (args == null || args.Length != 4) return null;
    foreach (string a in args) if (a == null) return null;
    if (args[0] != "write-probe" || !string.Equals(args[1], FixedRoot, StringComparison.OrdinalIgnoreCase)) return null;
    if (!args[2].StartsWith(FixedRoot, StringComparison.Ordinal) || !ProbeDirectory.IsMatch(args[2].Substring(FixedRoot.Length))) return null;
    if (!Regex.IsMatch(args[3], @"\A[1-9][0-9]{0,2}\z") || int.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture) > 600) return null;
    return new RootRunRequest(null, null, args[2], args[2] + @"\out", int.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture), null, true);
  }
  // The probe's command: one fixed byte to the same two files, by the same redirection as a real run; no WSL.
  public static string ProbeCommandLine(RootRunRequest run) {
    if (run == null || !run.Probe) throw new ArgumentException("ROOT_RUN_ARGUMENTS_INVALID");
    return "cmd.exe /d /c \"echo x> " + run.OutDirectory + @"\stdout.txt 2> " + run.OutDirectory + @"\stderr.txt" + "\"";
  }
  // What a captured output file must be, from its handle (opened without following a link): a plain file with exactly one name, at
  // most max bytes. null: capturable; else the code. (FILE_ATTRIBUTE_DIRECTORY 0x10, FILE_ATTRIBUTE_REPARSE_POINT 0x400.)
  public const long CaptureMaxBytes = 4L << 20;
  public static string CaptureRefusal(uint attributes, uint links, ulong size, long max) {
    if ((attributes & 0x400) != 0) return "ROOT_RUN_OUTPUT_IS_A_LINK";
    if ((attributes & 0x10) != 0) return "ROOT_RUN_OUTPUT_IS_A_DIRECTORY";
    if (links != 1) return "ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME";
    if (max < 0 || size > (ulong)max) return "ROOT_RUN_OUTPUT_TOO_LARGE";
    return null;
  }
  // capture-file <source> <destination>: <CI root>\reinstall-linux-out-<32hex>\<leaf> into <root>\install\linux-run-<32hex>\captured\<leaf>,
  // the same plain leaf name on both sides. null: refused; else { source, destination }.
  public const string CiRoot = @"C:\ProgramData\CluedIndependentCI";
  static readonly Regex CaptureSource = new Regex(@"\A\\reinstall-linux-out-[0-9a-f]{32}\\([A-Za-z0-9][A-Za-z0-9._-]{0,118}[A-Za-z0-9])\z");
  static readonly Regex CaptureRunSource = new Regex(@"\A\\install\\linux-run-([0-9a-f]{32})\\out\\(stdout\.txt|stderr\.txt)\z");
  static readonly Regex CaptureDestination = new Regex(@"\A\\install\\linux-run-([0-9a-f]{32})\\captured(?:-[0-9a-f]{32})?\\([A-Za-z0-9][A-Za-z0-9._-]{0,118}[A-Za-z0-9])\z");
  // The second source: a run's own stdout.txt / stderr.txt (the run may have outlived the launcher that started it), into a capture
  // directory of that same run directory. null: refused; else { source, destination }.
  public static string[] ParseCaptureFile(string[] args) {
    if (args == null || args.Length != 3 || args[0] != "capture-file" || args[1] == null || args[2] == null) return null;
    if (!args[2].StartsWith(FixedRoot, StringComparison.Ordinal)) return null;
    Match d = CaptureDestination.Match(args[2].Substring(FixedRoot.Length));
    if (!d.Success || d.Groups[2].Value.Contains("..")) return null;
    if (args[1].StartsWith(FixedRoot, StringComparison.Ordinal)) {
      Match r = CaptureRunSource.Match(args[1].Substring(FixedRoot.Length));
      if (!r.Success || r.Groups[1].Value != d.Groups[1].Value || r.Groups[2].Value != d.Groups[2].Value) return null;
      return new[] { args[1], args[2] };
    }
    if (!args[1].StartsWith(CiRoot, StringComparison.Ordinal)) return null;
    Match s = CaptureSource.Match(args[1].Substring(CiRoot.Length));
    if (!s.Success || s.Groups[1].Value != d.Groups[2].Value) return null;
    return new[] { args[1], args[2] };
  }
  // Where a capture is written: owned by Administrators, a protected DACL, and nobody in it but SYSTEM and Administrators (allow
  // entries only). null: as required; else the code.
  public static string CaptureDirectoryRefusal(string ownerSid, bool daclProtected, IEnumerable<string> allowSids, int denyEntries) {
    int n = 0;
    foreach (string sid in allowSids ?? new string[0]) { n++; if (sid != "S-1-5-18" && sid != "S-1-5-32-544") return "ROOT_RUN_CAPTURE_DIRECTORY_NOT_ADMIN_ONLY"; }
    return ownerSid == "S-1-5-32-544" && daclProtected && n > 0 && denyEntries == 0 ? null : "ROOT_RUN_CAPTURE_DIRECTORY_NOT_ADMIN_ONLY";
  }
  // root-run / write-probe: the second stdout line when the output could not be captured (the first is still ROOT_RUN_EXITED <code>).
  public static string RootRunCaptureRefused(string code) { return "CAPTURE_REFUSED " + (code != null && Regex.IsMatch(code, @"\A[A-Z][A-Z0-9_]{0,79}\z") ? code : "REGISTRAR_UNEXPECTED"); }
  // root-run / write-probe only over a companion task whose action is the one this program registers: one action, the supervisor of
  // this root with the fixed argument. Anything else is another definition than the reviewed one: nothing is changed. null: as expected.
  public static string RootRunActionRefusal(int actions, string path, string arguments, string root) {
    return actions == 1 && string.Equals(path, SupervisorPath(root), StringComparison.Ordinal) && arguments == SupervisorArguments(root) ? null : "ROOT_RUN_TASK_DEFINITION_DIFFERS";
  }
  // C:\a\b -> /mnt/c/a/b, for a path of letters, digits, '.', '_', '-' and '\' only (nothing a shell or cmd.exe reads as more).
  public static string WslPath(string windowsPath) {
    if (windowsPath == null || !Regex.IsMatch(windowsPath, @"\A[A-Za-z]:(?:\\[A-Za-z0-9._-]+)+\z")) return null;
    // no "." or ".." component, and none ending in '.' (Win32 drops a trailing dot or blank: "a." would be another name than the one checked)
    foreach (string part in windowsPath.Substring(3).Split('\\')) if (part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal)) return null;
    return "/mnt/" + char.ToLowerInvariant(windowsPath[0]) + windowsPath.Substring(2).Replace('\\', '/');
  }
  public const string CmdExe = @"C:\Windows\System32\cmd.exe";
  // The command line CreateProcessWithLogonW gets (application: CmdExe). Every token is fixed or passed ParseRootRun / ValidDistro.
  public static string RootRunCommandLine(string distro, RootRunRequest run) {
    if (!ValidDistro(distro) || run == null) throw new ArgumentException("ROOT_RUN_ARGUMENTS_INVALID");
    return "cmd.exe /d /c \"\"" + WslExe + "\" --distribution " + distro + " --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc "
      + run.WslScript + " > " + run.OutDirectory + @"\stdout.txt 2> " + run.OutDirectory + @"\stderr.txt" + "\"";
  }
  // The companion task a process may be started over. root-shell: only this account's password definition. root-run also accepts this
  // account's parked definition (interactive token): an earlier root-run whose registration failed leaves exactly that (RegistrarFlow
  // parks at once), and the next root-run then sets a new password and registers the password definition again, so it heals itself.
  // null: usable; else the code.
  public static string AccountTaskRefusal(int logonType, bool sameAccount, bool rootRun) {
    return sameAccount && (logonType == 1 || (rootRun && logonType == 3)) ? null : "COMPANION_TASK_NOT_PASSWORD";
  }
  // root-run's one stdout line. A refusal carries a code of capitals, digits and '_' only (anything else becomes REGISTRAR_UNEXPECTED).
  public static string RootRunExited(uint code) { return "ROOT_RUN_EXITED " + code.ToString(System.Globalization.CultureInfo.InvariantCulture); }
  public const string RootRunTimeout = "ROOT_RUN_TIMEOUT";
  public static string RootRunRefused(string code) { return "ROOT_RUN_REFUSED " + (code != null && Regex.IsMatch(code, @"\A[A-Z][A-Z0-9_]{0,79}\z") ? code : "REGISTRAR_UNEXPECTED"); }
  // The node profile's WSL distribution from record\acceptance.json.
  public static string DistroFromAcceptance(string json) {
    Dictionary<string, object> d = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
    object node; if (d == null || !d.TryGetValue("node", out node)) return null;
    Dictionary<string, object> n = node as Dictionary<string, object>; if (n == null) return null;
    object v; return n.TryGetValue("wslDistribution", out v) && ValidDistro(v as string) ? (string)v : null;
  }
  // The node profile's owner SID from record\acceptance.json (admin-only; the install wrote it).
  public static string OwnerSidFromAcceptance(string json) {
    Dictionary<string, object> d = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
    object node; Dictionary<string, object> n;
    if (d == null || !d.TryGetValue("node", out node) || (n = node as Dictionary<string, object>) == null) return null;
    object sid; return n.TryGetValue("ownerSid", out sid) && ValidSid(sid as string) ? (string)sid : null;
  }
}

// Review r1 M2/M5: the order of the account modes once the random password exists, with the host's calls passed in (the pure tests pass
// fakes). The password goes on the account first; from then on any failed registration parks the companion task on its interactive
// definition at once, so no definition is left holding the old password (each trigger would be a failed logon and could lock the account).
public static class RegistrarFlow {
  public static string PasswordFlow(Func<int> setPassword, Func<int> registerTask, Func<int> registerImport, Func<bool> park, out string detail) {
    int nrc = setPassword();
    if (nrc != 0) { detail = nrc.ToString(); return "ACCOUNT_PASSWORD_NOT_SET"; }
    int hr = registerTask();
    if (hr != 0) { bool parked = park(); detail = "0x" + hr.ToString("X8") + (parked ? ":parked" : ":park-failed"); return RegistrarCore.RegisterCode(hr); }
    if (registerImport != null) {
      int hr2 = registerImport();
      if (hr2 != 0) { bool parked = park(); detail = "0x" + hr2.ToString("X8") + (parked ? ":parked" : ":park-failed"); return "IMPORT_" + RegistrarCore.RegisterCode(hr2); }
    }
    detail = null; return "REGISTERED";
  }
}

// root-run's checked arguments (RegistrarCore.ParseRootRun).
public sealed class RootRunRequest {
  public readonly string ScriptPath, Sha256, Directory, OutDirectory, CapturedDirectory, WslScript;
  public readonly int TimeoutSeconds;
  public readonly bool Probe;   // write-probe: no script, no WSL
  public RootRunRequest(string scriptPath, string sha256, string directory, string outDirectory, int timeoutSeconds, string wslScript, bool probe) {
    ScriptPath = scriptPath; Sha256 = sha256; Directory = directory; OutDirectory = outDirectory; CapturedDirectory = directory + @"\captured"; TimeoutSeconds = timeoutSeconds; WslScript = wslScript; Probe = probe;
  }
}

// An exception in RegisterPassword, with the step it was in (RegistrarCore.UnexpectedDetail prints the step, never the message).
public sealed class RegistrarStepException : Exception {
  public readonly string Step;
  public readonly Exception Cause;
  public RegistrarStepException(string step, Exception cause) : base("REGISTRAR_STEP") { Step = step; Cause = cause; }
}

[StructLayout(LayoutKind.Sequential)]
public struct ComVariant {
  public ushort vt, r1, r2, r3;
  public IntPtr p1, p2;
  public static ComVariant Bstr(IntPtr b) { ComVariant v = new ComVariant(); v.vt = 8; v.p1 = b; return v; }
  public static ComVariant Empty() { return new ComVariant(); }
}

public static class CluedCompanionTaskRegistrar {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetDefaultDllDirectories(uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct CREDUI_INFO { public int cbSize; public IntPtr hwndParent; public string pszMessageText, pszCaptionText; public IntPtr hbmBanner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)] static extern int CredUIPromptForWindowsCredentialsW(ref CREDUI_INFO info, int authError, ref uint package, IntPtr inBuf, uint inSize, out IntPtr outBuf, out uint outSize, ref bool save, uint flags);
  [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredPackAuthenticationBufferW(uint flags, string user, string password, IntPtr packed, ref uint size);
  // 2026-11-08 (30th DESK): credui.dll exports CredUnPackAuthenticationBufferW (capital P); without the EntryPoint every password typed
  // ended in EntryPointNotFoundException (REGISTRAR_UNEXPECTED). test-companion-headless.ps1 binds every import of every program.
  [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredUnPackAuthenticationBufferW")] static extern bool CredUnpackAuthenticationBufferW(uint flags, IntPtr buf, uint size, StringBuilder user, ref uint userLen, StringBuilder domain, ref uint domainLen, IntPtr password, ref uint passwordLen);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CredIsProtectedW(IntPtr credentials, out int protectionType);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  [DllImport("oleaut32.dll")] static extern IntPtr SysAllocStringLen(IntPtr s, uint len);
  [DllImport("oleaut32.dll")] static extern void SysFreeString(IntPtr b);
  [DllImport("oleaut32.dll")] static extern uint SysStringByteLen(IntPtr b);
  [DllImport("kernel32.dll", EntryPoint = "RtlZeroMemory")] static extern void ZeroMemory(IntPtr p, UIntPtr len);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupAccountNameW(string system, string account, byte[] sid, ref uint sidLen, StringBuilder domain, ref uint domainLen, out int use);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION { public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);
  // M5-b (ADR 0023): the companion account.
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct USER_INFO_1 { public string name; public IntPtr password; public int passwordAge, priv; public string homeDir, comment; public int flags; public string scriptPath; }
  [StructLayout(LayoutKind.Sequential)] struct USER_INFO_1_OUT { public IntPtr name, password; public int passwordAge, priv; public IntPtr homeDir, comment; public int flags; public IntPtr scriptPath; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct LOCALGROUP_MEMBERS_INFO_3 { public string domainAndName; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory, ObjectName; public int Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserAdd(string server, int level, ref USER_INFO_1 buf, out int parmErr);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserSetInfo(string server, string user, int level, ref IntPtr buf, out int parmErr);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buf);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserGetLocalGroups(string server, string user, int level, int flags, out IntPtr buf, int prefMax, out int read, out int total);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetLocalGroupAddMembers(string server, string group, int level, ref LOCALGROUP_MEMBERS_INFO_3 buf, int count);
  [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buf);
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attributes, int access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LSA_UNICODE_STRING[] rights, int count);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out int count);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr p);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateProfile(string sid, string user, StringBuilder path, uint chars);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithLogonW(string user, string domain, IntPtr password, int logonFlags, string application, StringBuilder commandLine, int creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  // Review r1: m4 random bytes straight into unmanaged memory; m3 the unbuffered re-read; m5 the roll-back of prepare-account.
  [DllImport("bcrypt.dll")] static extern int BCryptGenRandom(IntPtr algorithm, IntPtr buffer, int count, int flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, IntPtr buffer, int toRead, out int read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protect);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFree(IntPtr address, UIntPtr size, uint type);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, LSA_UNICODE_STRING[] rights, int count);   // BOOLEAN: one byte (review r2 n6)
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserDel(string server, string user);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeleteProfileW(string sid, string path, string machine);
  // root-run: wait for the script's cmd.exe and read its exit code.
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  // the capture: a file's attributes, size and link count from its handle
  // Pack = 4: the native struct has no padding after FileAttributes (FILETIME is two DWORDs, 4-aligned); without it the CLR aligns the
  // longs to 8 and every later field reads 4 bytes off (NumberOfLinks read FileIndexHigh: every capture refused as another name).
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct BY_HANDLE_FILE_INFORMATION { public uint FileAttributes; public long CreationTime, LastAccessTime, LastWriteTime; public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION info);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetPathFn(IntPtr self, out IntPtr bstr);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetTaskFn(IntPtr self, IntPtr bstrPath, out IntPtr task);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int RegisterTaskDefinitionFn(IntPtr self, IntPtr bstrPath, IntPtr definition, int flags, ComVariant userId, ComVariant password, int logonType, ComVariant sddl, out IntPtr task);
  static readonly Guid IidTaskFolder = new Guid("8cfac062-a080-4c15-9a88-aa7c2af80dfc");
  static readonly Guid IidTaskDefinition = new Guid("f5bc8fc5-536d-4f77-b852-fbc1356fdeb6");
  // ITaskFolder : IDispatch (taskschd.idl): IUnknown 0-2, IDispatch 3-6, Name 7, Path 8, GetFolder 9, GetFolders 10, CreateFolder 11,
  // DeleteFolder 12, GetTask 13, GetTasks 14, DeleteTask 15, RegisterTask 16, RegisterTaskDefinition 17.
  const int SlotPath = 8, SlotGetTask = 13, SlotRegisterTaskDefinition = 17;
  static T Slot<T>(IntPtr itf, int slot) where T : class {
    IntPtr vtbl = Marshal.ReadIntPtr(itf);
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size), typeof(T)) as T;
  }
  static object Call(object o, string name, params object[] a) { return o.GetType().InvokeMember(name, System.Reflection.BindingFlags.InvokeMethod, null, o, a); }
  static object Get(object o, string name) { return o.GetType().InvokeMember(name, System.Reflection.BindingFlags.GetProperty, null, o, null); }
  static void Set(object o, string name, object v) { o.GetType().InvokeMember(name, System.Reflection.BindingFlags.SetProperty, null, o, new[] { v }); }
  static object Service() { object s = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true)); Call(s, "Connect"); return s; }
  static IntPtr Qi(object rcw, Guid iid) {
    IntPtr unk = Marshal.GetIUnknownForObject(rcw), itf;
    try { if (Marshal.QueryInterface(unk, ref iid, out itf) != 0) throw new InvalidOperationException("QI"); } finally { Marshal.Release(unk); }
    return itf;
  }

  // root-run prints exactly one stdout line in its own form; a refusal's usual JSON (with its detail) goes to stderr.
  static bool rootRunOutput = false;
  static void Print(string code, string detail) {
    if (rootRunOutput) { Console.Out.WriteLine(RegistrarCore.RootRunRefused(code)); try { Console.Error.WriteLine(RegistrarCore.Output(code, detail)); } catch { } return; }
    Console.Out.WriteLine(RegistrarCore.Output(code, detail));
  }

  [STAThread]
  static int Main(string[] args) {
    try { SetDefaultDllDirectories(0x800); } catch { }
    try {
      if (args.Length == 1 && args[0] == "vtable-selftest") return VtableSelfTest();
      if (args.Length == 2 && args[0] == "file-sha256" && Regex.IsMatch(args[1], @"\A[A-Za-z]:\\")) return FileSha256Unbuffered(args[1]);
      if (args.Length >= 1 && (args[0] == "root-run" || args[0] == "write-probe")) rootRunOutput = true;   // from here on stdout is one ROOT_RUN_* line
      if (!Elevated()) { Print("REGISTRAR_ELEVATION_REQUIRED", null); return 2; }
      if (rootRunOutput) {
        RootRunRequest run = args[0] == "write-probe" ? RegistrarCore.ParseWriteProbe(args) : RegistrarCore.ParseRootRun(args);
        if (run == null) { Print("REGISTRAR_ARGS_REFUSED", null); return 2; }
        return RegisterAccount(RegistrarCore.FixedRoot, null, null, -1, false, run);
      }
      if (args.Length == 2 && args[0] == "register-password" && string.Equals(args[1], RegistrarCore.FixedRoot, StringComparison.OrdinalIgnoreCase)) return RegisterPassword(RegistrarCore.FixedRoot);
      int pid;
      if (args.Length == 2 && args[0] == "token-facts" && int.TryParse(args[1], out pid) && pid > 0) return TokenFacts(pid);
      // M5-b (ADR 0023).
      long uidArg = -1;
      if ((args.Length == 2 || (args.Length == 5 && long.TryParse(args[4], out uidArg) && uidArg >= 0 && uidArg <= 4294967295L)) && args[0] == "register-account" && string.Equals(args[1], RegistrarCore.FixedRoot, StringComparison.OrdinalIgnoreCase))
        return RegisterAccount(RegistrarCore.FixedRoot, args.Length == 5 ? args[2] : null, args.Length == 5 ? args[3] : null, uidArg, false, null);
      if (args.Length == 2 && args[0] == "root-shell" && string.Equals(args[1], RegistrarCore.FixedRoot, StringComparison.OrdinalIgnoreCase)) return RegisterAccount(RegistrarCore.FixedRoot, null, null, -1, true, null);
      if (args.Length == 2 && args[0] == "remove-account" && RegistrarCore.ValidAccountName(args[1])) return RemoveAccount(args[1]);
      if (args.Length == 2 && args[0] == "prepare-account" && RegistrarCore.ValidAccountName(args[1])) return PrepareAccount(args[1]);
      if (args.Length == 2 && args[0] == "account-facts" && RegistrarCore.ValidSid(args[1])) return AccountFacts(args[1]);
      if (args.Length == 2 && args[0] == "grant-service-logon" && RegistrarCore.ValidSid(args[1])) return GrantServiceLogon(args[1]);
      if (args.Length == 3 && args[0] == "capture-file") {
        string[] pair = RegistrarCore.ParseCaptureFile(args);
        if (pair == null) { Print("REGISTRAR_ARGS_REFUSED", null); return 2; }
        string captureWhy = CaptureOne(pair[0], pair[1]);
        if (captureWhy != null) { Print(captureWhy, null); return 1; }
        Print("FILE_CAPTURED", null); return 0;
      }
      Print("REGISTRAR_ARGS_REFUSED", null); return 2;
    } catch (Exception e) { Print("REGISTRAR_UNEXPECTED", RegistrarCore.UnexpectedDetail(e)); return 1; }
  }

  static bool Elevated() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return false;
    try {
      IntPtr b = Marshal.AllocHGlobal(4); int got;
      try { return GetTokenInformation(token, 18, b, 4, out got) && Marshal.ReadInt32(b) == 2; } finally { Marshal.FreeHGlobal(b); }
    } finally { CloseHandle(token); }
  }

  static string SidOf(string account) {
    uint sidLen = 0, domLen = 0; int use;
    LookupAccountNameW(null, account, null, ref sidLen, null, ref domLen, out use);
    if (sidLen == 0 || sidLen > 256 || domLen > 1024) return null;
    byte[] sid = new byte[sidLen]; StringBuilder dom = new StringBuilder((int)domLen + 1);
    if (!LookupAccountNameW(null, account, sid, ref sidLen, dom, ref domLen, out use)) return null;
    return new SecurityIdentifier(sid, 0).Value;
  }

  // 2026-11-08 (30th DESK): step names the part RegisterPasswordSteps is in, so an unexpected exception says where it happened
  // (REGISTRAR_UNEXPECTED, detail step:ExceptionType:0xHRESULT) without saying what: acceptance, owner, service, folder, definition,
  // prefill, prompt, unpack, account, pending (all before the hand-over), register, readback (from the hand-over on).
  static int RegisterPassword(string root) {
    string step = "acceptance";
    try { return RegisterPasswordSteps(root, ref step); } catch (Exception e) { throw new RegistrarStepException(step, e); }
  }
  static int RegisterPasswordSteps(string root, ref string step) {
    step = "acceptance";
    string ownerSid = RegistrarCore.OwnerSidFromAcceptance(System.IO.File.ReadAllText(root + @"\record\acceptance.json", new UTF8Encoding(false, true)));
    if (ownerSid == null) { Print("NODE_PROFILE_UNREADABLE", null); return 2; }
    step = "owner";
    string ownerAccount = new SecurityIdentifier(ownerSid).Translate(typeof(NTAccount)).Value;
    // The definition first (no secret in it), through the scripting interface; the folder's vtable only for the one call with the password.
    step = "service";
    object svc = Service();
    step = "folder";
    object folder;
    try { folder = Call(svc, "GetFolder", RegistrarCore.TaskFolder); } catch { Print("TASK_FOLDER_MISSING", null); return 2; }
    step = "definition";
    object def = Call(svc, "NewTask", 0);
    Set(def, "XmlText", RegistrarCore.PasswordTaskXml(root, ownerSid));

    const uint CRED_PACK_PROTECTED_CREDENTIALS = 0x1, CREDUIWIN_IN_CRED_ONLY = 0x20, CREDUIWIN_SECURE_PROMPT = 0x1000;
    IntPtr inBuf = IntPtr.Zero, outBuf = IntPtr.Zero, pw = IntPtr.Zero, bstr = IntPtr.Zero, pFolder = IntPtr.Zero, pDef = IntPtr.Zero, pTask = IntPtr.Zero;
    uint inSize = 0, outSize = 0;
    const int PwChars = 512;
    try {
      step = "prefill";
      CredPackAuthenticationBufferW(0, ownerAccount, "", IntPtr.Zero, ref inSize);
      if (inSize == 0 || inSize > 65536) { Print("CREDENTIAL_PREFILL_FAILED", null); return 1; }
      inBuf = Marshal.AllocCoTaskMem((int)inSize);
      if (!CredPackAuthenticationBufferW(0, ownerAccount, "", inBuf, ref inSize)) { Print("CREDENTIAL_PREFILL_FAILED", null); return 1; }
      CREDUI_INFO ui = new CREDUI_INFO();
      ui.cbSize = Marshal.SizeOf(typeof(CREDUI_INFO));
      ui.pszCaptionText = "Clued companion";
      ui.pszMessageText = "Enter your own Windows password for " + ownerAccount + ". The Task Scheduler keeps it for the companion task (ADR 0022). This box is on the secure desktop: you started this yourself and approved UAC.";
      step = "prompt";
      uint package = 0; bool save = false;
      int rc = CredUIPromptForWindowsCredentialsW(ref ui, 0, ref package, inBuf, inSize, out outBuf, out outSize, ref save, CREDUIWIN_IN_CRED_ONLY | CREDUIWIN_SECURE_PROMPT);
      if (rc == 1223) { Print("CREDENTIAL_NOT_GIVEN", null); return 3; }
      if (rc != 0 || outBuf == IntPtr.Zero) { Print("CREDENTIAL_PROMPT_FAILED", "0x" + rc.ToString("X")); return 1; }
      step = "unpack";
      StringBuilder user = new StringBuilder(514), domain = new StringBuilder(514);
      uint userLen = 513, domainLen = 513, pwLen = PwChars;
      pw = Marshal.AllocHGlobal(PwChars * 2);
      ZeroMemory(pw, new UIntPtr(PwChars * 2));
      // 2026-11-08 (30th DESK): the protected unpack (CRED_PACK_PROTECTED_CREDENTIALS) failed with GetLastError 775 for the buffer the
      // secure-desktop box returned, and flags 0 unpacked it (RegistrarCore.UnpackRetryPlain). Only the error numbers are ever printed,
      // never a length or a byte of the credential.
      bool unpacked = CredUnpackAuthenticationBufferW(CRED_PACK_PROTECTED_CREDENTIALS, outBuf, outSize, user, ref userLen, domain, ref domainLen, pw, ref pwLen);
      int protectedError = unpacked ? 0 : Marshal.GetLastWin32Error(), plainError = 0;
      bool retried = false;
      if (!unpacked && RegistrarCore.UnpackRetryPlain(protectedError)) {
        retried = true;
        user.Length = 0; domain.Length = 0; userLen = 513; domainLen = 513; pwLen = PwChars;
        ZeroMemory(pw, new UIntPtr(PwChars * 2));
        unpacked = CredUnpackAuthenticationBufferW(0, outBuf, outSize, user, ref userLen, domain, ref domainLen, pw, ref pwLen);
        plainError = unpacked ? 0 : Marshal.GetLastWin32Error();
      }
      if (!unpacked || pwLen == 0 || pwLen > PwChars) {
        Print("CREDENTIAL_UNPACK_FAILED", RegistrarCore.UnpackDetail(protectedError, retried, plainError)); return 1;
      }
      if (retried) {
        // Review L2: what the plain unpack returned must be the password itself, not its protected form. CredIsProtectedW reads up to
        // the NUL: the buffer is zeroed and pwLen < PwChars leaves one at the end.
        int protection = -1;
        bool usable = pwLen < PwChars && RegistrarCore.PlainUnpackUsable(CredIsProtectedW(pw, out protection), protection);
        if (!usable) { Print("CREDENTIAL_STILL_PROTECTED", null); return 1; }
      }
      step = "account";
      string account = RegistrarCore.QualifiedAccount(user.ToString(), domain.ToString(), Environment.MachineName);
      string sid = account == null ? null : SidOf(account);
      if (sid == null || sid != ownerSid) { Print("ACCOUNT_MISMATCH", null); return 2; }
      // Review round 3: only while the switch that started us still holds its marker (checked after the box, right before the hand-over).
      step = "pending";
      string pendingWhy = CurrentPendingRefusal(root);
      if (pendingWhy != null) { Print(pendingWhy, null); return 2; }
      step = "register";
      // pwLen counts the terminating NUL when there is one.
      uint chars = pwLen;
      if (chars > 0 && Marshal.ReadInt16(pw, (int)(chars - 1) * 2) == 0) chars -= 1;
      if (chars == 0) { Print("PASSWORD_EMPTY_REFUSED", null); return 2; }
      bstr = SysAllocStringLen(pw, chars);
      ZeroMemory(pw, new UIntPtr(PwChars * 2));
      if (bstr == IntPtr.Zero) { Print("REGISTER_FAILED", "BSTR"); return 1; }
      pFolder = Qi(folder, IidTaskFolder);
      pDef = Qi(def, IidTaskDefinition);
      IntPtr name = Marshal.StringToBSTR(RegistrarCore.TaskName), user2 = Marshal.StringToBSTR(ownerAccount), sddl = Marshal.StringToBSTR(RegistrarCore.TaskSddl(ownerSid));
      int hr;
      try {
        hr = Slot<RegisterTaskDefinitionFn>(pFolder, SlotRegisterTaskDefinition)(pFolder, name, pDef, 6, ComVariant.Bstr(user2), ComVariant.Bstr(bstr), 1, ComVariant.Bstr(sddl), out pTask);
      } finally { Marshal.FreeBSTR(name); Marshal.FreeBSTR(user2); Marshal.FreeBSTR(sddl); }
      ZeroMemory(bstr, new UIntPtr(chars * 2)); SysFreeString(bstr); bstr = IntPtr.Zero;
      string code = RegistrarCore.RegisterCode(hr);
      if (hr != 0) { Print(code, "0x" + hr.ToString("X8")); return 1; }
      // Read back through the scripting interface: the password logon, the Owner, not elevated, the one fixed action.
      step = "readback";
      object task = Call(folder, "GetTask", RegistrarCore.TaskName);
      object d2 = Get(task, "Definition"), pr = Get(d2, "Principal"), acts = Get(d2, "Actions");
      object a = (int)Get(acts, "Count") == 1 ? Get(acts, "Item", 1) : null;
      string uid = (string)Get(pr, "UserId");
      string uidSid = uid != null && uid.StartsWith("S-1-") ? uid : SidOf(uid);
      if ((int)Get(pr, "LogonType") != 1 || (int)Get(pr, "RunLevel") != 0 || uidSid != ownerSid || a == null
        || !string.Equals((string)Get(a, "Path"), RegistrarCore.SupervisorPath(root), StringComparison.Ordinal) || (string)Get(a, "Arguments") != RegistrarCore.SupervisorArguments(root)) {
        Print("REGISTER_READBACK_MISMATCH", null); return 1;
      }
      Print("REGISTERED", RegistrarCore.Sha256Text((string)Get(task, "Xml")));
      return 0;
    } finally {
      if (pw != IntPtr.Zero) { ZeroMemory(pw, new UIntPtr(PwChars * 2)); Marshal.FreeHGlobal(pw); }
      // Review MINOR 3: a BSTR still held here (an exception between its allocation and the call) is zeroed before it is freed.
      if (bstr != IntPtr.Zero) { ZeroMemory(bstr, new UIntPtr(SysStringByteLen(bstr))); SysFreeString(bstr); }
      if (outBuf != IntPtr.Zero) { ZeroMemory(outBuf, new UIntPtr(outSize)); CoTaskMemFree(outBuf); }
      if (inBuf != IntPtr.Zero) { ZeroMemory(inBuf, new UIntPtr(inSize)); Marshal.FreeCoTaskMem(inBuf); }
      if (pTask != IntPtr.Zero) Marshal.Release(pTask);
      if (pDef != IntPtr.Zero) Marshal.Release(pDef);
      if (pFolder != IntPtr.Zero) Marshal.Release(pFolder);
    }
  }
  // ---- M5-b (ADR 0023): the companion's own non-administrator account ----
  static string GroupName(string wellKnownSid) { string n = new SecurityIdentifier(wellKnownSid).Translate(typeof(NTAccount)).Value; int i = n.IndexOf('\\'); return i >= 0 ? n.Substring(i + 1) : n; }
  static string[] SplitAccount(string sid) {
    try { string a = new SecurityIdentifier(sid).Translate(typeof(NTAccount)).Value; int i = a.IndexOf('\\'); return i < 0 ? null : new[] { a.Substring(0, i), a.Substring(i + 1) }; } catch { return null; }
  }
  // Administrators directly or through any local group (LG_INCLUDE_INDIRECT); an unreadable answer counts as one (fail closed).
  static bool IsAdministrator(string user) {
    IntPtr buf; int read, total;
    if (NetUserGetLocalGroups(null, user, 0, 1, out buf, -1, out read, out total) != 0) return true;
    try {
      string admins = GroupName("S-1-5-32-544");
      for (int i = 0; i < read; i++) if (string.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, i * IntPtr.Size)), admins, StringComparison.OrdinalIgnoreCase)) return true;
      return false;
    } finally { NetApiBufferFree(buf); }
  }
  static int EnabledState(string user) {   // 1 enabled, 0 disabled, -1 unreadable
    IntPtr buf; if (NetUserGetInfo(null, user, 1, out buf) != 0) return -1;
    try { USER_INFO_1_OUT u = (USER_INFO_1_OUT)Marshal.PtrToStructure(buf, typeof(USER_INFO_1_OUT)); return (u.flags & 0x2) == 0 ? 1 : 0; } finally { NetApiBufferFree(buf); }
  }
  static string AccountRefusalOf(string sid) {
    string[] a = SplitAccount(sid); if (a == null) return "COMPANION_ACCOUNT_MISSING";
    int en = EnabledState(a[1]); if (en < 0) return "COMPANION_ACCOUNT_MISSING";
    return RegistrarCore.AccountRefusal(a[0], Environment.MachineName, en == 1, IsAdministrator(a[1]), sid == WindowsIdentity.GetCurrent().User.Value);
  }
  static string ProfilePath(string sid) {
    try {
      using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid)) {
        object v = k == null ? null : k.GetValue("ProfileImagePath"); return v == null ? null : Environment.ExpandEnvironmentVariables((string)v);
      }
    } catch { return null; }
  }
  static IntPtr OpenLsa(int access) {
    LSA_OBJECT_ATTRIBUTES oa = new LSA_OBJECT_ATTRIBUTES(); oa.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES)); IntPtr h;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, access, out h);
    if (st != 0) throw new InvalidOperationException("LSA_OPEN:" + LsaNtStatusToWinError(st));
    return h;
  }
  static byte[] SidBytes(string sid) { SecurityIdentifier s = new SecurityIdentifier(sid); byte[] b = new byte[s.BinaryLength]; s.GetBinaryForm(b, 0); return b; }
  // The one grant of account rights in the package (prepare-account's batch logon, grant-service-logon's service logon): the step it
  // stopped in (open, grant) and the system's raw NTSTATUS, 0 when done.
  static uint GrantRights(string sid, string[] rights, out string step) {
    step = "open";
    LSA_OBJECT_ATTRIBUTES oa = new LSA_OBJECT_ATTRIBUTES(); oa.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES)); IntPtr h;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, 0x10 | 0x800, out h);   // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES
    if (st != 0) return st;
    step = "grant";
    LSA_UNICODE_STRING[] r = new LSA_UNICODE_STRING[rights.Length];
    try {
      for (int i = 0; i < rights.Length; i++) { r[i].Buffer = Marshal.StringToHGlobalUni(rights[i]); r[i].Length = (ushort)(rights[i].Length * 2); r[i].MaximumLength = (ushort)(rights[i].Length * 2 + 2); }
      return LsaAddAccountRights(h, SidBytes(sid), r, r.Length);
    } finally { foreach (LSA_UNICODE_STRING s in r) if (s.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(s.Buffer); LsaClose(h); }
  }
  // prepare-account's use, as before: a policy that does not open throws (LSA_OPEN), a grant that fails returns its win32 code
  static int AddRights(string sid, string[] rights) {
    string step; uint st = GrantRights(sid, rights, out step);
    if (st != 0 && step == "open") throw new InvalidOperationException("LSA_OPEN:" + LsaNtStatusToWinError(st));
    return LsaNtStatusToWinError(st);
  }
  // grant-service-logon <sid>: one local account's SeServiceLogonRight by GrantRights; the step and the raw status when it is not done.
  static int GrantServiceLogon(string sid) {
    string[] a = SplitAccount(sid);
    if (a == null || !string.Equals(a[0], Environment.MachineName, StringComparison.OrdinalIgnoreCase)) { Print("RIGHT_NOT_GRANTED", "resolve"); return 1; }
    string step; uint st = GrantRights(sid, new[] { "SeServiceLogonRight" }, out step);
    if (st != 0) { Print("RIGHT_NOT_GRANTED", step + ":0x" + st.ToString("X8") + ":" + LsaNtStatusToWinError(st)); return 1; }
    Print("RIGHT_GRANTED", null); return 0;
  }
  static List<string> RightsOf(string sid) {
    IntPtr h = OpenLsa(0x800 | 0x1), p; int count; List<string> o = new List<string>();   // POLICY_LOOKUP_NAMES | POLICY_VIEW_LOCAL_INFORMATION
    try {
      uint st = LsaEnumerateAccountRights(h, SidBytes(sid), out p, out count);
      if (st == 0xC0000034) return o;   // STATUS_OBJECT_NAME_NOT_FOUND: no right held directly
      if (st != 0) throw new InvalidOperationException("LSA_RIGHTS:" + LsaNtStatusToWinError(st));
      try {
        int size = Marshal.SizeOf(typeof(LSA_UNICODE_STRING));
        for (int i = 0; i < count; i++) { LSA_UNICODE_STRING s = (LSA_UNICODE_STRING)Marshal.PtrToStructure(new IntPtr(p.ToInt64() + (long)i * size), typeof(LSA_UNICODE_STRING)); o.Add(Marshal.PtrToStringUni(s.Buffer, s.Length / 2)); }
      } finally { LsaFreeMemory(p); }
      return o;
    } finally { LsaClose(h); }
  }
  // A new random password in an unmanaged, NUL-terminated buffer of RandomPasswordChars characters (never a managed string). The caller
  // zeroes and frees it.
  static IntPtr NewRandomPassword() {
    int n = RegistrarCore.RandomPasswordChars; string alphabet = RegistrarCore.PasswordAlphabet;
    const int RandomBytes = 256;
    UIntPtr bytes = new UIntPtr((uint)((n + 1) * 2));
    IntPtr pw = Marshal.AllocHGlobal((n + 1) * 2), r = Marshal.AllocHGlobal(RandomBytes);
    try {
      for (int attempt = 0; attempt < 64; attempt++) {
        ZeroMemory(pw, bytes);
        int at = 0, classes = 0;
        while (at < n) {
          if (BCryptGenRandom(IntPtr.Zero, r, RandomBytes, 2) != 0) throw new InvalidOperationException("RANDOM_SOURCE");   // BCRYPT_USE_SYSTEM_PREFERRED_RNG
          for (int i = 0; i < RandomBytes && at < n; i++) { int k = RegistrarCore.PasswordIndex(Marshal.ReadByte(r, i)); if (k < 0) continue; classes |= RegistrarCore.PasswordClass(alphabet[k]); Marshal.WriteInt16(pw, at * 2, (short)alphabet[k]); at++; }
        }
        if (classes == 15) { IntPtr done = pw; pw = IntPtr.Zero; return done; }
      }
      throw new InvalidOperationException("RANDOM_PASSWORD");
    } finally {
      ZeroMemory(r, new UIntPtr(RandomBytes)); Marshal.FreeHGlobal(r);
      if (pw != IntPtr.Zero) { ZeroMemory(pw, bytes); Marshal.FreeHGlobal(pw); }
    }
  }
  // RegisterTaskDefinition with a password, through the folder's own vtable (the password only as VARIANT(BSTR)).
  static int RegisterWithPassword(object folder, object def, string taskName, string account, IntPtr bstr, string sddl) {
    IntPtr pFolder = Qi(folder, IidTaskFolder);
    try {
      IntPtr pDef = Qi(def, IidTaskDefinition), pTask = IntPtr.Zero;
      IntPtr name = Marshal.StringToBSTR(taskName), user = Marshal.StringToBSTR(account), sd = Marshal.StringToBSTR(sddl);
      try { return Slot<RegisterTaskDefinitionFn>(pFolder, SlotRegisterTaskDefinition)(pFolder, name, pDef, 6, ComVariant.Bstr(user), ComVariant.Bstr(bstr), 1, ComVariant.Bstr(sd), out pTask); }
      finally { Marshal.FreeBSTR(name); Marshal.FreeBSTR(user); Marshal.FreeBSTR(sd); if (pTask != IntPtr.Zero) Marshal.Release(pTask); Marshal.Release(pDef); }
    } finally { Marshal.Release(pFolder); }
  }
  // Review r1 M2: the companion task back on the account's interactive definition (no password; RegistrarCore.InteractiveTaskXml),
  // through the scripting interface. true when it is registered.
  static bool ParkTask(object svc, object folder, string root, string sid, string account) {
    try {
      object def = Call(svc, "NewTask", 0);
      Set(def, "XmlText", RegistrarCore.InteractiveTaskXml(root, sid));
      Call(folder, "RegisterTaskDefinition", RegistrarCore.TaskName, def, 6, account, null, 3, RegistrarCore.TaskSddl(sid));
      return true;
    } catch { return false; }
  }

  // register-account <root> [<distro> <vhdx>]: the companion task for the node profile's ownerSid (the companion account), with a new
  // random password set on that account first; with distro and vhdx also the one-shot import task (same password). root-shell <root>:
  // a new random password for the account and the existing password task, then wsl.exe --distribution <the profile's> --user root in a
  // new console as that account (the Owner's way into root after M5-b; nobody knows the password, so there is no runas).
  // root-run <root> <script> <sha256> <outDir> <timeout>: root-shell's checks and password change, then the pinned script instead of a
  // console (run != null): its SHA-256 is checked before anything changes; the wait never kills.
  // Steps: acceptance, account, wslclient, script, service, folder, definition, pending, random, setpassword, register, import, shell, run, readback.
  static int RegisterAccount(string root, string distro, string vhdx, long defaultUid, bool rootShell, RootRunRequest run) {
    string step = "acceptance";
    try { return RegisterAccountSteps(root, distro, vhdx, defaultUid, rootShell, run, ref step); } catch (Exception e) { throw new RegistrarStepException(step, e); }
  }
  // The script as the caller reads it now: a plain file in a plain directory with a plain out\ beside it, and the pinned bytes. null: as
  // pinned; else the code.
  // One file, opened without following a link, checked from its handle (RegistrarCore.CaptureRefusal) and copied, create-only, to the
  // destination (a directory only SYSTEM and Administrators can write). null: captured; else the code. Nothing of a refused file is read.
  static string CaptureOne(string source, string destination) {
    try {
      string directory = System.IO.Path.GetDirectoryName(destination);
      if (!System.IO.Directory.Exists(directory) || (System.IO.File.GetAttributes(directory) & System.IO.FileAttributes.ReparsePoint) != 0) return "ROOT_RUN_CAPTURE_DIRECTORY_NOT_ADMIN_ONLY";
      System.Security.AccessControl.DirectorySecurity sd = System.IO.Directory.GetAccessControl(directory);
      List<string> allow = new List<string>(); int deny = 0;
      foreach (System.Security.AccessControl.FileSystemAccessRule rule in sd.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        if (rule.AccessControlType == System.Security.AccessControl.AccessControlType.Allow) allow.Add(rule.IdentityReference.Value); else deny++;
      }
      string directoryWhy = RegistrarCore.CaptureDirectoryRefusal(sd.GetOwner(typeof(SecurityIdentifier)).Value, sd.AreAccessRulesProtected, allow, deny);
      if (directoryWhy != null) return directoryWhy;
    } catch (System.IO.IOException) { return "ROOT_RUN_CAPTURE_DIRECTORY_NOT_ADMIN_ONLY"; } catch (UnauthorizedAccessException) { return "ROOT_RUN_CAPTURE_DIRECTORY_NOT_ADMIN_ONLY"; }
    const uint GenericRead = 0x80000000, ShareAll = 0x7, OpenExisting = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
    IntPtr h = CreateFileW(source, GenericRead, ShareAll, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "ROOT_RUN_OUTPUT_UNREADABLE";
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(h, out info)) return "ROOT_RUN_OUTPUT_UNREADABLE";
      string why = RegistrarCore.CaptureRefusal(info.FileAttributes, info.NumberOfLinks, ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow, RegistrarCore.CaptureMaxBytes);
      if (why != null) return why;
      using (Microsoft.Win32.SafeHandles.SafeFileHandle safe = new Microsoft.Win32.SafeHandles.SafeFileHandle(h, false))
      using (System.IO.FileStream input = new System.IO.FileStream(safe, System.IO.FileAccess.Read))
      using (System.IO.MemoryStream held = new System.IO.MemoryStream()) {
        byte[] buffer = new byte[65536]; int n;
        while ((n = input.Read(buffer, 0, buffer.Length)) > 0) { held.Write(buffer, 0, n); if (held.Length > RegistrarCore.CaptureMaxBytes) return "ROOT_RUN_OUTPUT_TOO_LARGE"; }
        try {
          using (System.IO.FileStream output = new System.IO.FileStream(destination, System.IO.FileMode.CreateNew, System.IO.FileAccess.Write, System.IO.FileShare.None)) { held.WriteTo(output); output.Flush(true); }
        } catch (System.IO.IOException) { return "ROOT_RUN_CAPTURE_NOT_WRITTEN"; } catch (UnauthorizedAccessException) { return "ROOT_RUN_CAPTURE_NOT_WRITTEN"; }
      }
      return null;
    } catch (System.IO.IOException) { return "ROOT_RUN_OUTPUT_UNREADABLE"; } catch (UnauthorizedAccessException) { return "ROOT_RUN_OUTPUT_UNREADABLE"; }
    finally { CloseHandle(h); }
  }
  static string RootRunScriptRefusal(RootRunRequest run) {
    try {
      foreach (string p in new[] { run.Directory, run.OutDirectory, run.CapturedDirectory }) {
        if (!System.IO.Directory.Exists(p)) return "ROOT_RUN_DIRECTORY_MISSING";
        if ((System.IO.File.GetAttributes(p) & System.IO.FileAttributes.ReparsePoint) != 0) return "ROOT_RUN_PATH_REPARSE_REFUSED";
      }
      if (run.Probe) return null;   // no script: the command is fixed
      if (!System.IO.File.Exists(run.ScriptPath)) return "ROOT_RUN_SCRIPT_MISSING";
      if ((System.IO.File.GetAttributes(run.ScriptPath) & System.IO.FileAttributes.ReparsePoint) != 0) return "ROOT_RUN_PATH_REPARSE_REFUSED";
      byte[] bytes = System.IO.File.ReadAllBytes(run.ScriptPath);
      using (SHA256 h = SHA256.Create()) {
        if (BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant() != run.Sha256) return "ROOT_RUN_SCRIPT_SHA256_MISMATCH";
      }
      return null;
    } catch (System.IO.IOException) { return "ROOT_RUN_SCRIPT_UNREADABLE"; } catch (UnauthorizedAccessException) { return "ROOT_RUN_SCRIPT_UNREADABLE"; }
  }
  static int RegisterAccountSteps(string root, string distro, string vhdx, long defaultUid, bool rootShell, RootRunRequest run, ref string step) {
    bool asAccount = rootShell || run != null;   // both start a process as the account over its existing password task
    step = "acceptance";
    string acceptance = System.IO.File.ReadAllText(root + @"\record\acceptance.json", new UTF8Encoding(false, true));
    string sid = RegistrarCore.OwnerSidFromAcceptance(acceptance), nodeDistro = RegistrarCore.DistroFromAcceptance(acceptance);
    if (sid == null || nodeDistro == null) { Print("NODE_PROFILE_UNREADABLE", null); return 2; }
    if (distro != null && (distro != nodeDistro || !RegistrarCore.ValidVhdx(vhdx))) { Print("IMPORT_ARGUMENTS_REFUSED", null); return 2; }
    step = "account";
    string why = AccountRefusalOf(sid);
    if (why != null) { Print(why, null); return 2; }
    string[] acct = SplitAccount(sid);
    string account = acct[0] + "\\" + acct[1];
    if (asAccount || distro != null) {
      step = "wslclient";
      string clientWhy = RegistrarCore.MachineWslClientRefusal();
      if (clientWhy != null) { Print(clientWhy, null); return 2; }
    }
    if (run != null) {
      step = "script";
      string scriptWhy = RootRunScriptRefusal(run);
      if (scriptWhy != null) { Print(scriptWhy, null); return 2; }
    }
    step = "service";
    object svc = Service();
    step = "folder";
    object folder;
    try { folder = Call(svc, "GetFolder", RegistrarCore.TaskFolder); } catch { Print("TASK_FOLDER_MISSING", null); return 2; }
    step = "definition";
    if (asAccount) {
      // Only over this account's password task that is already there (a switch qualified it), never while a switch runs.
      if (System.IO.File.Exists(root + @"\install\companion-headless-pending.json")) { Print("COMPANION_SWITCH_IN_PROGRESS", null); return 2; }
      object t0;
      try { t0 = Call(folder, "GetTask", RegistrarCore.TaskName); } catch { Print("COMPANION_TASK_MISSING", null); return 2; }
      object p0 = Get(Get(t0, "Definition"), "Principal");
      string u0 = (string)Get(p0, "UserId"); string u0Sid = u0 != null && u0.StartsWith("S-1-") ? u0 : SidOf(u0);
      string taskWhy = RegistrarCore.AccountTaskRefusal((int)Get(p0, "LogonType"), u0Sid == sid, run != null);
      if (taskWhy != null) { Print(taskWhy, null); return 2; }
      if (run != null) {
        // the installed task's action must be the one this program registers, before the password or the definition is touched
        object a0s = Get(Get(t0, "Definition"), "Actions"); int a0n = (int)Get(a0s, "Count"); object a0 = a0n == 1 ? Get(a0s, "Item", 1) : null;
        string actionWhy = RegistrarCore.RootRunActionRefusal(a0n, a0 == null ? null : (string)Get(a0, "Path"), a0 == null ? null : (string)Get(a0, "Arguments"), root);
        if (actionWhy != null) { Print(actionWhy, null); return 2; }
      }
    }
    object def = Call(svc, "NewTask", 0);
    Set(def, "XmlText", RegistrarCore.PasswordTaskXml(root, sid));
    object importDef = null;
    if (distro != null) { importDef = Call(svc, "NewTask", 0); Set(importDef, "XmlText", RegistrarCore.ImportTaskXml(sid, distro, vhdx, defaultUid)); }
    if (!asAccount) {
      // As register-password: only while the switch that started this program still holds its marker.
      step = "pending";
      string pendingWhy = CurrentPendingRefusal(root);
      if (pendingWhy != null) { Print(pendingWhy, null); return 2; }
    }
    int chars = RegistrarCore.RandomPasswordChars;
    IntPtr pw = IntPtr.Zero, bstr = IntPtr.Zero;
    try {
      step = "random";
      pw = NewRandomPassword();
      bstr = SysAllocStringLen(pw, (uint)chars);
      if (bstr == IntPtr.Zero) { Print("REGISTER_FAILED", "BSTR"); return 1; }
      step = "setpassword";
      IntPtr password = pw, bpassword = bstr;
      string detail;
      // Review r1 M2: once the account has the new password, a registration that fails parks the task at once (RegistrarFlow).
      string code = RegistrarFlow.PasswordFlow(
        () => { IntPtr info = password; int parmErr; return NetUserSetInfo(null, acct[1], 1003, ref info, out parmErr); },   // USER_INFO_1003
        () => RegisterWithPassword(folder, def, RegistrarCore.TaskName, account, bpassword, RegistrarCore.TaskSddl(sid)),
        importDef == null ? (Func<int>)null : () => RegisterWithPassword(folder, importDef, RegistrarCore.ImportTaskName, account, bpassword, RegistrarCore.ImportTaskSddl),
        () => ParkTask(svc, folder, root, sid, account), out detail);
      ZeroMemory(bstr, new UIntPtr((uint)(chars * 2))); SysFreeString(bstr); bstr = IntPtr.Zero;
      if (code != "REGISTERED") {
        // root-shell: the companion task is no longer on the stored password; say so plainly.
        if (asAccount && code != "ACCOUNT_PASSWORD_NOT_SET") code = (run != null ? "ROOT_RUN" : "ROOT_SHELL") + (detail != null && detail.EndsWith(":parked") ? "_TASK_NOT_UPDATED_PARKED" : "_TASK_NOT_UPDATED_PARK_FAILED");
        Print(code, detail); return 1;
      }
      if (run != null) {
        // The task just registered, read back before anything runs: this account's password logon, not elevated, the one fixed action.
        step = "readback";
        object rt = Call(folder, "GetTask", RegistrarCore.TaskName);
        object rd = Get(rt, "Definition"), rp = Get(rd, "Principal"), ra = Get(rd, "Actions");
        object r1 = (int)Get(ra, "Count") == 1 ? Get(ra, "Item", 1) : null;
        string ru = (string)Get(rp, "UserId");
        string ruSid = ru != null && ru.StartsWith("S-1-") ? ru : SidOf(ru);
        if ((int)Get(rp, "LogonType") != 1 || (int)Get(rp, "RunLevel") != 0 || ruSid != sid || r1 == null
          || !string.Equals((string)Get(r1, "Path"), RegistrarCore.SupervisorPath(root), StringComparison.Ordinal) || (string)Get(r1, "Arguments") != RegistrarCore.SupervisorArguments(root)) {
          Print("ROOT_RUN_READBACK_MISMATCH", null); return 1;
        }
        step = "run";
        STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        StringBuilder cmd = new StringBuilder(run.Probe ? RegistrarCore.ProbeCommandLine(run) : RegistrarCore.RootRunCommandLine(nodeDistro, run));
        bool ok = CreateProcessWithLogonW(acct[1], acct[0], pw, 1, RegistrarCore.CmdExe, cmd, 0x08000000, IntPtr.Zero, @"C:\Windows\System32", ref si, out pi);   // LOGON_WITH_PROFILE, CREATE_NO_WINDOW
        int err = ok ? 0 : Marshal.GetLastWin32Error();
        // The wait can be long: the password leaves this process now, not at the end.
        ZeroMemory(pw, new UIntPtr((uint)((chars + 1) * 2)));
        if (!ok) { Print("ROOT_RUN_NOT_STARTED", err.ToString()); return 1; }
        try {
          CloseHandle(pi.hThread);
          uint waited = WaitForSingleObject(pi.hProcess, (uint)run.TimeoutSeconds * 1000u);
          // A timeout is reported and nothing else: the script may be past a step that must finish; the caller stops and a person looks.
          if (waited == 0x102) { Console.Out.WriteLine(RegistrarCore.RootRunTimeout); return 3; }
          uint exit;
          if (waited != 0 || !GetExitCodeProcess(pi.hProcess, out exit)) { Print("ROOT_RUN_EXIT_UNREADABLE", Marshal.GetLastWin32Error().ToString()); return 1; }
          // What the process wrote, for the caller: never by following a link, never a file with another name, into captured\ only.
          foreach (string leaf in new[] { "stdout.txt", "stderr.txt" }) {
            string captureWhy = CaptureOne(run.OutDirectory + "\\" + leaf, run.CapturedDirectory + "\\" + leaf);
            // The exit code is still the answer to "did it run"; the caller is told that the output is not there to read.
            if (captureWhy != null) { Console.Out.WriteLine(RegistrarCore.RootRunExited(exit)); Console.Out.WriteLine(RegistrarCore.RootRunCaptureRefused(captureWhy)); return 0; }
          }
          Console.Out.WriteLine(RegistrarCore.RootRunExited(exit)); return 0;
        } finally { CloseHandle(pi.hProcess); }
      }
      if (rootShell) {
        step = "shell";
        STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpTitle = "Clued resident root shell: " + nodeDistro;
        PROCESS_INFORMATION pi;
        StringBuilder cmd = new StringBuilder("\"" + RegistrarCore.WslExe + "\" --distribution " + nodeDistro + " --user root");
        bool ok = CreateProcessWithLogonW(acct[1], acct[0], pw, 1, RegistrarCore.WslExe, cmd, 0x10, IntPtr.Zero, @"C:\Windows\System32", ref si, out pi);   // LOGON_WITH_PROFILE, CREATE_NEW_CONSOLE
        int err = ok ? 0 : Marshal.GetLastWin32Error();
        if (!ok) { Print("ROOT_SHELL_NOT_STARTED", err.ToString()); return 1; }
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        Print("ROOT_SHELL_STARTED", pi.dwProcessId.ToString()); return 0;
      }
      step = "readback";
      object task = Call(folder, "GetTask", RegistrarCore.TaskName);
      object d2 = Get(task, "Definition"), pr = Get(d2, "Principal"), acts = Get(d2, "Actions");
      object a = (int)Get(acts, "Count") == 1 ? Get(acts, "Item", 1) : null;
      string uid = (string)Get(pr, "UserId");
      string uidSid = uid != null && uid.StartsWith("S-1-") ? uid : SidOf(uid);
      if ((int)Get(pr, "LogonType") != 1 || (int)Get(pr, "RunLevel") != 0 || uidSid != sid || a == null
        || !string.Equals((string)Get(a, "Path"), RegistrarCore.SupervisorPath(root), StringComparison.Ordinal) || (string)Get(a, "Arguments") != RegistrarCore.SupervisorArguments(root)) {
        Print("REGISTER_READBACK_MISMATCH", null); return 1;
      }
      Print("REGISTERED", RegistrarCore.Sha256Text((string)Get(task, "Xml")));
      return 0;
    } finally {
      if (bstr != IntPtr.Zero) { ZeroMemory(bstr, new UIntPtr(SysStringByteLen(bstr))); SysFreeString(bstr); }
      if (pw != IntPtr.Zero) { ZeroMemory(pw, new UIntPtr((uint)((chars + 1) * 2))); Marshal.FreeHGlobal(pw); }
    }
  }

  // prepare-account <name> (before the reinstall, ADR 0023 step P): the local account, created with a random password nobody learns
  // (register-account sets a new one anyway), a member of Users only, with SeBatchLogonRight (the password task's batch logon) and
  // SeDenyNetworkLogonRight / SeDenyRemoteInteractiveLogonRight, and its profile (CreateProfile, so C:\Users\<name> exists before the
  // first logon). An existing account is checked, never changed except for the group, the rights and the profile. Prints the SID and
  // the profile directory.
  static int PrepareAccount(string name) {
    string step = "lookup";
    try { return PrepareAccountSteps(name, ref step); } catch (Exception e) { throw new RegistrarStepException(step, e); }
  }
  static int PrepareAccountSteps(string name, ref string step) {
    string machine = Environment.MachineName;
    step = "lookup";
    string sid = SidOf(machine + "\\" + name);
    bool created = false;
    if (sid == null) {
      step = "random";
      IntPtr pw = NewRandomPassword();
      try {
        step = "create";
        USER_INFO_1 u = new USER_INFO_1();
        u.name = name; u.password = pw; u.priv = 1;   // USER_PRIV_USER
        u.comment = "Clued CI resident companion (ADR 0023): runs the companion task only; random password known to nobody";
        u.flags = 0x1 | 0x40 | 0x200 | 0x10000;   // UF_SCRIPT | UF_PASSWD_CANT_CHANGE | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD
        int parmErr;
        int rc = NetUserAdd(null, 1, ref u, out parmErr);
        u.password = IntPtr.Zero;
        if (rc != 0) { Print("ACCOUNT_NOT_CREATED", rc.ToString()); return 1; }
      } finally { ZeroMemory(pw, new UIntPtr((uint)((RegistrarCore.RandomPasswordChars + 1) * 2))); Marshal.FreeHGlobal(pw); }
      created = true;
      sid = SidOf(machine + "\\" + name);
      if (sid == null) { Print("ACCOUNT_NOT_RESOLVED", null); return 1; }
    }
    step = "check";
    string why = AccountRefusalOf(sid);
    if (why != null) { Print(why, null); return 2; }
    step = "users";
    LOCALGROUP_MEMBERS_INFO_3 m = new LOCALGROUP_MEMBERS_INFO_3(); m.domainAndName = machine + "\\" + name;
    int grc = NetLocalGroupAddMembers(null, GroupName("S-1-5-32-545"), 3, ref m, 1);
    if (grc != 0 && grc != 1378) { Print("ACCOUNT_USERS_GROUP_FAILED", grc.ToString()); return 1; }   // 1378: already a member
    step = "rights";
    int lrc = AddRights(sid, new[] { "SeBatchLogonRight", "SeDenyNetworkLogonRight", "SeDenyRemoteInteractiveLogonRight" });
    if (lrc != 0) { Print("ACCOUNT_RIGHTS_FAILED", lrc.ToString()); return 1; }
    step = "profile";
    StringBuilder path = new StringBuilder(260);   // CreateProfile: cchProfilePath must not exceed MAX_PATH (260); 261 fails with RPC_X_BAD_STUB_DATA 0x800706F7 (DESK 2026-11-08)
    int hr = CreateProfile(sid, name, path, 260);
    if (hr != 0 && (uint)hr != 0x800700B7) { Print("PROFILE_NOT_CREATED", "0x" + hr.ToString("X8")); return 1; }   // ERROR_ALREADY_EXISTS
    // Review r1 m5: an account that was already there must also be Users only, password never expiring and not changeable by it, with
    // network and remote-desktop logon denied (the sign-in screen is the script's step, so it is not counted here).
    step = "hardening";
    List<string> problems = HardeningOf(sid, name, true);
    problems.Remove("NOT_HIDDEN");
    if (problems.Count > 0) { string pd = string.Join(".", problems.ToArray()).ToLowerInvariant().Replace('_', '-'); Print("ACCOUNT_NOT_HARDENED", pd.Length > 80 ? pd.Substring(0, 80) : pd); return 2; }
    Dictionary<string, object> v = new Dictionary<string, object>();
    v["contract"] = RegistrarCore.Contract; v["code"] = "ACCOUNT_PREPARED"; v["sid"] = sid; v["account"] = machine + "\\" + name; v["created"] = created;
    v["profileDirectory"] = ProfilePath(sid);
    Console.Out.WriteLine(new JavaScriptSerializer().Serialize(v));
    return 0;
  }

  // Review r1 m5: RegistrarCore.HardeningProblems over the live facts: the direct local groups, the account flags, the rights held directly
  // and the sign-in screen's UserList value.
  static List<string> HardeningOf(string sid, string name, bool withHidden) {
    List<string> groups = new List<string>();
    IntPtr buf; int read, total;
    if (NetUserGetLocalGroups(null, name, 0, 0, out buf, -1, out read, out total) == 0) {
      try { for (int i = 0; i < read; i++) groups.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, i * IntPtr.Size))); } finally { NetApiBufferFree(buf); }
    } else groups.Add("?");
    int flags = 0; IntPtr ub;
    if (NetUserGetInfo(null, name, 1, out ub) == 0) { try { flags = ((USER_INFO_1_OUT)Marshal.PtrToStructure(ub, typeof(USER_INFO_1_OUT))).flags; } finally { NetApiBufferFree(ub); } }
    bool hidden = false;
    try {
      using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList")) {
        object v = k == null ? null : k.GetValue(name); hidden = v is int && (int)v == 0;
      }
    } catch { hidden = false; }
    return RegistrarCore.HardeningProblems(groups, GroupName("S-1-5-32-545"), flags, RightsOf(sid), withHidden ? hidden : true);
  }

  // file-sha256 <path>: the SHA-256 of a file read with FILE_FLAG_NO_BUFFERING (review r1 m3: the copy's target is hashed from the disk,
  // not from the cache that just wrote it). Read-only, with the caller's own token; no elevation needed.
  static int FileSha256Unbuffered(string path) {
    const uint GenericRead = 0x80000000, ShareRead = 0x1, OpenExisting = 3, NoBuffering = 0x20000000, SequentialScan = 0x08000000;
    IntPtr h = CreateFileW(path, GenericRead, ShareRead, IntPtr.Zero, OpenExisting, NoBuffering | SequentialScan, IntPtr.Zero);
    if (h == new IntPtr(-1)) { Print("FILE_UNREADABLE", Marshal.GetLastWin32Error().ToString()); return 1; }
    const int Chunk = 4 << 20;   // a multiple of every sector size; VirtualAlloc gives page-aligned memory
    IntPtr mem = VirtualAlloc(IntPtr.Zero, new UIntPtr(Chunk), 0x3000, 0x04);   // MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE
    try {
      if (mem == IntPtr.Zero) { Print("FILE_UNREADABLE", "alloc"); return 1; }
      byte[] managed = new byte[Chunk]; long length = 0;
      using (SHA256 sha = SHA256.Create()) {
        while (true) {
          int got;
          if (!ReadFile(h, mem, Chunk, out got, IntPtr.Zero)) { Print("FILE_UNREADABLE", Marshal.GetLastWin32Error().ToString()); return 1; }
          if (got == 0) break;
          Marshal.Copy(mem, managed, 0, got); sha.TransformBlock(managed, 0, got, null, 0); length += got;
        }
        sha.TransformFinalBlock(managed, 0, 0);
        Dictionary<string, object> v = new Dictionary<string, object>();
        v["contract"] = RegistrarCore.Contract; v["code"] = "FILE_SHA256"; v["sha256"] = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant(); v["length"] = length;
        Console.Out.WriteLine(new JavaScriptSerializer().Serialize(v));
        return 0;
      }
    } finally { if (mem != IntPtr.Zero) VirtualFree(mem, UIntPtr.Zero, 0x8000); CloseHandle(h); }
  }

  // remove-account <name> (review r1 m5, the roll-back of prepare-account; remove-companion-account.ps1): only an account
  // prepare-account made (its comment), never an administrator or the caller, never while the companion task names it. Its rights
  // (SeBatchLogonRight and the two denials), its profile (with it its registry, so its WSL registrations and .wslconfig) and the account.
  static int RemoveAccount(string name) {
    string step = "lookup";
    try { return RemoveAccountSteps(name, ref step); } catch (Exception e) { throw new RegistrarStepException(step, e); }
  }
  static int RemoveAccountSteps(string name, ref string step) {
    string sid = SidOf(Environment.MachineName + "\\" + name);
    if (sid == null) { Print("ACCOUNT_ABSENT", null); return 0; }
    step = "check";
    string why = AccountRefusalOf(sid);
    if (why == "COMPANION_ACCOUNT_IS_ADMINISTRATOR" || why == "COMPANION_ACCOUNT_IS_THE_CALLER" || why == "COMPANION_ACCOUNT_NOT_LOCAL") { Print(why, null); return 2; }
    IntPtr ub; string comment = null;
    if (NetUserGetInfo(null, name, 1, out ub) == 0) { try { comment = Marshal.PtrToStringUni(((USER_INFO_1_OUT)Marshal.PtrToStructure(ub, typeof(USER_INFO_1_OUT))).comment); } finally { NetApiBufferFree(ub); } }
    if (comment == null || !comment.StartsWith("Clued CI resident companion (ADR 0023)", StringComparison.Ordinal)) { Print("ACCOUNT_NOT_MADE_BY_PREPARE", null); return 2; }
    step = "task";
    try {
      object t = Call(Call(Service(), "GetFolder", RegistrarCore.TaskFolder), "GetTask", RegistrarCore.TaskName);
      string u = (string)Get(Get(Get(t, "Definition"), "Principal"), "UserId");
      if ((u != null && u.StartsWith("S-1-") ? u : SidOf(u)) == sid) { Print("ACCOUNT_STILL_USED_BY_THE_COMPANION_TASK", null); return 2; }
    } catch (System.Reflection.TargetInvocationException) { }   // no folder or no task: nothing uses it
    step = "rights";
    IntPtr h = OpenLsa(0x10 | 0x800);
    string[] rights = { "SeBatchLogonRight", "SeDenyNetworkLogonRight", "SeDenyRemoteInteractiveLogonRight" };
    LSA_UNICODE_STRING[] r = new LSA_UNICODE_STRING[rights.Length];
    int lrc;
    try {
      for (int i = 0; i < rights.Length; i++) { r[i].Buffer = Marshal.StringToHGlobalUni(rights[i]); r[i].Length = (ushort)(rights[i].Length * 2); r[i].MaximumLength = (ushort)(rights[i].Length * 2 + 2); }
      uint st = LsaRemoveAccountRights(h, SidBytes(sid), false, r, r.Length);
      lrc = st == 0xC0000034 ? 0 : LsaNtStatusToWinError(st);   // STATUS_OBJECT_NAME_NOT_FOUND: none left
    } finally { foreach (LSA_UNICODE_STRING x in r) if (x.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(x.Buffer); LsaClose(h); }
    if (lrc != 0) { Print("ACCOUNT_RIGHTS_NOT_REMOVED", lrc.ToString()); return 1; }
    step = "profile";
    string profile = ProfilePath(sid);
    if (profile != null && !DeleteProfileW(sid, null, null)) { int e = Marshal.GetLastWin32Error(); if (e != 2) { Print("PROFILE_NOT_REMOVED", e.ToString()); return 1; } }
    step = "delete";
    int drc = NetUserDel(null, name);
    if (drc != 0) { Print("ACCOUNT_NOT_REMOVED", drc.ToString()); return 1; }
    Print("ACCOUNT_REMOVED", null); return 0;
  }

  // account-facts <sid>: read-only facts of the companion account for the switch's preflight and verify.
  static int AccountFacts(string sid) {
    Dictionary<string, object> v = new Dictionary<string, object>();
    v["contract"] = RegistrarCore.Contract; v["code"] = "ACCOUNT_FACTS"; v["sid"] = sid;
    string[] a = SplitAccount(sid);
    v["exists"] = a != null && EnabledState(a[1]) >= 0;
    if ((bool)v["exists"]) {
      v["local"] = string.Equals(a[0], Environment.MachineName, StringComparison.OrdinalIgnoreCase);
      v["enabled"] = EnabledState(a[1]) == 1;
      v["administrator"] = IsAdministrator(a[1]);
      v["isCaller"] = sid == WindowsIdentity.GetCurrent().User.Value;
      v["rights"] = RightsOf(sid).ToArray();
      v["profileDirectory"] = ProfilePath(sid);
      v["refusal"] = AccountRefusalOf(sid);
      v["hardening"] = HardeningOf(sid, a[1], true).ToArray();   // review r1 m5
    }
    Console.Out.WriteLine(new JavaScriptSerializer().Serialize(v));
    return 0;
  }

  static string CurrentPendingRefusal(string root) {
    string marker = null;
    try { string f = root + @"\install\companion-headless-pending.json"; if (System.IO.File.Exists(f)) marker = System.IO.File.ReadAllText(f, new UTF8Encoding(false, true)); } catch { return "PENDING_MARKER_UNREADABLE"; }
    PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION(); int got;
    if (NtQueryInformationProcess(GetCurrentProcess(), 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out got) != 0) return "PARENT_UNREADABLE";
    int ppid = (int)pbi.InheritedFromUniqueProcessId.ToInt64();
    string start = null;
    try { start = System.Diagnostics.Process.GetProcessById(ppid).StartTime.ToUniversalTime().ToString("o"); } catch { start = null; }
    return RegistrarCore.PendingRefusal(marker, ppid, start);
  }
  static object Get(object o, string name, object index) { return o.GetType().InvokeMember(name, System.Reflection.BindingFlags.GetProperty, null, o, new[] { index }); }

  static int VtableSelfTest() {
    object svc = Service();
    object root = Call(svc, "GetFolder", @"\");
    IntPtr p = Qi(root, IidTaskFolder);
    try {
      IntPtr b;
      int hr = Slot<GetPathFn>(p, SlotPath)(p, out b);
      string path = hr == 0 ? Marshal.PtrToStringBSTR(b) : null;
      if (hr == 0) Marshal.FreeBSTR(b);
      IntPtr name = Marshal.StringToBSTR("clued-no-such-task-" + Guid.NewGuid().ToString("N")), t;
      int hr2;
      try { hr2 = Slot<GetTaskFn>(p, SlotGetTask)(p, name, out t); } finally { Marshal.FreeBSTR(name); }
      if (hr2 == 0 && t != IntPtr.Zero) Marshal.Release(t);
      bool ok = path == @"\" && (uint)hr2 == 0x80070002;
      Print(ok ? "VTABLE_OK" : "VTABLE_MISMATCH", "0x" + hr2.ToString("X8"));
      return ok ? 0 : 1;
    } finally { Marshal.Release(p); }
  }

  static int TokenFacts(int pid) {
    IntPtr proc = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (proc == IntPtr.Zero) { Print("PROCESS_UNREADABLE", null); return 1; }
    IntPtr token = IntPtr.Zero;
    try {
      StringBuilder image = new StringBuilder(1024); int size = image.Capacity;
      string imagePath = QueryFullProcessImageNameW(proc, 0, image, ref size) ? image.ToString() : null;
      if (!OpenProcessToken(proc, 0x0008, out token)) { Print("TOKEN_UNREADABLE", null); return 1; }
      int got;
      IntPtr b = Marshal.AllocHGlobal(4);
      int elevationType, session;
      try {
        if (!GetTokenInformation(token, 18, b, 4, out got)) { Print("TOKEN_UNREADABLE", null); return 1; }
        elevationType = Marshal.ReadInt32(b);
        if (!GetTokenInformation(token, 12, b, 4, out got)) { Print("TOKEN_UNREADABLE", null); return 1; }   // TokenSessionId
        session = Marshal.ReadInt32(b);
      } finally { Marshal.FreeHGlobal(b); }
      GetTokenInformation(token, 1, IntPtr.Zero, 0, out got);   // TokenUser
      IntPtr u = Marshal.AllocHGlobal(Math.Max(got, 16)); string userSid;
      try { if (!GetTokenInformation(token, 1, u, got, out got)) { Print("TOKEN_UNREADABLE", null); return 1; } userSid = new SecurityIdentifier(Marshal.ReadIntPtr(u)).Value; } finally { Marshal.FreeHGlobal(u); }
      GetTokenInformation(token, 2, IntPtr.Zero, 0, out got);   // TokenGroups
      if (got <= 0 || got > 1 << 20) { Print("TOKEN_UNREADABLE", null); return 1; }
      IntPtr g = Marshal.AllocHGlobal(got); long admins = -1;
      try {
        if (!GetTokenInformation(token, 2, g, got, out got)) { Print("TOKEN_UNREADABLE", null); return 1; }
        int count = Marshal.ReadInt32(g);
        for (int i = 0; i < count; i++) {
          IntPtr e = new IntPtr(g.ToInt64() + IntPtr.Size + (long)i * IntPtr.Size * 2);
          if (new SecurityIdentifier(Marshal.ReadIntPtr(e)).Value == "S-1-5-32-544") admins = (uint)Marshal.ReadInt32(new IntPtr(e.ToInt64() + IntPtr.Size));
        }
      } finally { Marshal.FreeHGlobal(g); }
      Dictionary<string, object> v = new Dictionary<string, object>();
      v["contract"] = RegistrarCore.Contract; v["code"] = "TOKEN_FACTS"; v["pid"] = pid; v["userSid"] = userSid; v["elevationType"] = elevationType;
      v["adminsPresent"] = admins >= 0; v["adminsDenyOnly"] = admins >= 0 && (admins & 0x10) != 0 && (admins & 0x4) == 0;
      v["sessionId"] = session; v["imagePath"] = imagePath;
      Console.Out.WriteLine(new JavaScriptSerializer().Serialize(v));
      return 0;
    } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(proc); }
  }
}
