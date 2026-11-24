// Execute the registrar's actual generated import program against a bounded
// fake WSL executable and an isolated registry adapter. No task, account, real
// distribution or production path is created, queried or changed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const windows = process.platform === 'win32';
const source = fileURLToPath(new URL('../windows/CompanionTaskRegistrar.cs', import.meta.url));
const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const secret = ['ghp', '_', '0123456789'.repeat(3), '012345'].join(''); // fixture only: assembled at runtime so secret scanners do not flag a literal
let fixturePromise;

test('the reinstall generator pin accepts the committed reviewed launcher template', async () => {
  const generator = await fs.readFile(new URL('../reinstall/launcher/generate.py', import.meta.url), 'utf8');
  const template = await fs.readFile(new URL('../reinstall/launcher/template.ps1', import.meta.url), 'utf8');
  const pins = [...generator.matchAll(/^TEMPLATE_SHA = '([0-9a-f]{64})'/gm)];
  assert.equal(pins.length, 1, 'one explicit reviewed-template pin');
  // Python text-mode reading in generate.py normalizes Windows line endings.
  const actual = createHash('sha256').update(template.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
  assert.equal(actual, pins[0][1], 'template changes must update their reviewed generator pin in the same delivery');
});

test('M5-b VM management bounds inherited output after an exited client', { skip: !windows }, () => {
  const script = fileURLToPath(new URL('../windows/test-m5b-wsl-release.ps1', import.meta.url));
  const result = run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InheritedPipeProbe'], { timeout: 6000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const facts = JSON.parse(result.stdout.trim());
  assert.equal(facts.boundedInheritedPipe, true);
  assert.equal(facts.actualWslCalls, 0);
  assert.ok(facts.elapsedMs < 4000);
});
after(async () => {
  if (!fixturePromise) return;
  const tools = await fixturePromise;
  const expected = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(tools.dir).startsWith(expected) && path.basename(tools.dir).startsWith('clued-m5b-import-'));
  await fs.rm(tools.dir, { recursive: true, force: true });
});

function run(exe, args, extra = {}) {
  const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, ...extra });
  assert.ifError(result.error);
  return result;
}

async function fixture() {
  if (!fixturePromise) fixturePromise = (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-m5b-import-'));
    const csc = path.join(framework, 'csc.exe');
    const dumpSource = path.join(dir, 'Dump.cs'), dump = path.join(dir, 'dump.exe');
    await fs.writeFile(dumpSource, 'public static class Dump { public static int Main(string[] a) { System.Console.Write(a[0] == "--validator" ? RegistrarCore.MachineWslClientScript : RegistrarCore.ImportScript("M5TestDistro", a[0], 1000)); return 0; } }');
    const refs = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map(n => `/reference:${path.join(framework, n)}`);
    const compiled = run(csc, ['/nologo', '/noconfig', '/target:exe', '/main:Dump', ...refs, `/out:${dump}`, source, dumpSource]);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const fakeSource = path.join(dir, 'FakeWsl.cs'), fake = path.join(dir, 'fake-wsl.exe');
    await fs.writeFile(fakeSource, `using System;
public static class FakeWsl {
  public static int Main(string[] a) {
    if (Environment.GetEnvironmentVariable("FAKE_UTF16") == "1") Console.OutputEncoding = System.Text.Encoding.Unicode;
    if (Environment.GetEnvironmentVariable("FAKE_GBK") == "1") Console.OutputEncoding = System.Text.Encoding.GetEncoding(936);
    string step = a[0] == "--import-in-place" ? "IMPORT" : a[0] == "--distribution" ? "PROBE" : "INFO";
    if (step == "PROBE" && Environment.GetEnvironmentVariable("FAKE_HANG") == "1") System.Threading.Thread.Sleep(10000);
    Console.WriteLine("WSL fixture " + step + " \\u7248\\u672c\\u6d4b\\u8bd5");
    if (step != "INFO") {
      Console.Error.WriteLine("Error code: Wsl/Service/RegisterDistro/0x80070005");
      Console.Error.WriteLine("GH_TOKEN=${secret}");
      Console.Write(new string('x', 9000));
    }
    int code; return Int32.TryParse(Environment.GetEnvironmentVariable("FAKE_" + step + "_EXIT"), out code) ? code : 0;
  }
}`);
    const builtFake = run(csc, ['/nologo', '/noconfig', '/target:exe', `/out:${fake}`, fakeSource]);
    assert.equal(builtFake.status, 0, builtFake.stdout + builtFake.stderr);
    return { dir, dump, fake };
  })();
  return fixturePromise;
}

// The program writes its diagnostic only into a file the current user owns (windows/CompanionTaskRegistrar.cs, exit 7
// otherwise); an elevated administrator's new files are owned by Administrators. So every test that reads the diagnostic
// needs a standard user, says so in its name, and does not run on a host that cannot give one (CLUED_CI_HOST_LACKS;
// task 04f9b91b: all eight exited 7 on the elevated GitHub-hosted Windows runner).
async function execute(t, { importExit = 9, probeExit = 7, registered = true, wrongBase = false,
  extendedBase = false, utf16 = false, gbk = false, hang = false, stale = false, weakOldAcl = false, clientRefusal = false } = {}) {
  const tools = await fixture(), dir = await fs.mkdtemp(path.join(tools.dir, 'run-'));
  const vhdx = path.join(dir, 'ext4.vhdx'), uidFile = path.join(dir, 'uid.txt');
  await fs.writeFile(vhdx, 'offline fixture; never imported');
  const dumped = run(tools.dump, [vhdx]);
  assert.equal(dumped.status, 0, dumped.stdout + dumped.stderr);
  // Substitute only the trust transport. The shared resolver has its own negative
  // tests below; the complete generated lifecycle/diagnostic program stays real.
  assert.ok(dumped.stdout.includes("$p = 'C:\\Program Files\\WSL\\wsl.exe'"));
  assert.ok(dumped.stdout.includes('$r.client = Get-CluedMachineWslClient'));
  let program = dumped.stdout.replace('$r.client = Get-CluedMachineWslClient', '$r.client = Get-FixtureWslClient');
  if (hang) program = program.replace("$distro, '--exec', '/bin/true') 120000", "$distro, '--exec', '/bin/true') 300");
  const adapter = `
function Get-FixtureWslClient {
  if ($env:FAKE_CLIENT_REFUSAL -eq '1') { throw 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID' }
  [pscustomobject]@{ contract = 'clued.independent-ci.wsl-client/1'; path = '${tools.fake}'; sha256 = ('a'*64); signerThumbprint = ('B'*40) }
}
function global:Get-ChildItem { param([string]$LiteralPath)
  if ($LiteralPath -eq 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss') {
    if ($env:FAKE_REGISTERED -eq '1') { [pscustomobject]@{ PSPath = 'HKCU:\\Fixture\\one' } }; return
  }; throw 'UNEXPECTED_FIXTURE_REGISTRY_READ'
}
function global:Get-ItemProperty { param([string]$LiteralPath)
  if ($LiteralPath -ne 'HKCU:\\Fixture\\one') { throw 'UNEXPECTED_FIXTURE_REGISTRY_READ' }
  [pscustomobject]@{ DistributionName = 'M5TestDistro'; BasePath = $env:FAKE_REG_BASE; VhdFileName = 'ext4.vhdx' }
}
function global:Set-ItemProperty { param([string]$LiteralPath,[string]$Name,$Value,[string]$Type)
  if ($LiteralPath -ne 'HKCU:\\Fixture\\one' -or $Name -ne 'DefaultUid' -or $Type -ne 'DWord') { throw 'UNEXPECTED_FIXTURE_REGISTRY_WRITE' }
  [IO.File]::WriteAllText($env:FAKE_UID_FILE,[string]$Value)
}
`;
  const script = path.join(dir, 'import.ps1');
  const oldAcl = weakOldAcl ? `
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$weak = New-Object Security.AccessControl.FileSecurity
$weak.SetSecurityDescriptorSddlForm(('D:P(A;;FR;;;WD)(A;;FA;;;' + $sid + ')'),[Security.AccessControl.AccessControlSections]::Access)
[IO.File]::SetAccessControl($env:FAKE_OUTPUT_PATH,$weak)
$raw = New-Object Security.AccessControl.RawSecurityDescriptor(([IO.File]::GetAccessControl($env:FAKE_OUTPUT_PATH)).GetSecurityDescriptorBinaryForm(),0)
if (@($raw.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier.Value -eq 'S-1-1-0' }).Count -ne 1) { throw 'OLD_WEAK_ACL_NOT_CREATED' }
` : '';
  await fs.writeFile(script, adapter + oldAcl + program, 'utf8');
  const output = path.join(dir, 'companion-wsl-import-result.json');
  if (stale) await fs.writeFile(output, JSON.stringify({ runId: 'stale', exitCode: 0 }));
  const result = run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, FAKE_IMPORT_EXIT: String(importExit), FAKE_PROBE_EXIT: String(probeExit),
      FAKE_REGISTERED: registered ? '1' : '0', FAKE_REG_BASE: wrongBase ? 'C:\\wrong' : (extendedBase ? '\\\\?\\' : '') + dir,
      FAKE_UID_FILE: uidFile, FAKE_OUTPUT_PATH: output, FAKE_UTF16: utf16 ? '1' : '0', FAKE_GBK: gbk ? '1' : '0', FAKE_CLIENT_REFUSAL: clientRefusal ? '1' : '0', FAKE_HANG: hang ? '1' : '0' },
  });
  assert.equal(await fs.stat(output).then(() => true, () => false), true,
    `a failed import must retain its diagnostic result; exit=${result.status}`);
  const bytes = await fs.readFile(output);
  assert.ok(bytes.length <= 64 * 1024);
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), false, 'UTF-8 without BOM');
  assert.ok(!bytes.toString('utf8').includes(secret), 'no fixture token in diagnostic output');
  assert.ok(!(result.stdout + result.stderr).includes(secret), 'no fixture token printed to console');
  return { result, diagnostic: JSON.parse(bytes.toString('utf8')), uidFile, output };
}

test('M5-b import failure records bounded separate exit/output and exact subject [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d, uidFile } = await execute(t);
  assert.equal(result.status, 3);
  assert.equal(d.contract, 'clued.independent-ci.companion-wsl-import-result/1');
  assert.equal(d.distro, 'M5TestDistro');
  assert.equal(d.exitCode, 3);
  assert.ok(Date.parse(d.finishedAt) >= Date.parse(d.startedAt));
  const imported = d.commands.find(c => c.phase === 'import'), probe = d.commands.find(c => c.phase === 'probe');
  assert.equal(imported.exitCode, 9); assert.equal(probe.exitCode, 7);
  assert.match(imported.stderr, /0x80070005/);
  assert.equal(imported.truncated, true);
  assert.equal(await fs.stat(uidFile).then(() => true, () => false), false, 'failed imports do not rewrite DefaultUid');
});

// T8 (task 87d330d0): success is the program's own exit code 0x434C4901, which no queued, cancelled or stopped instance and no Task
// Scheduler status can produce; the diagnostic keeps the logical code 0 (complete).
test('M5-b already-registered retry succeeds only after the real runnable probe and matching registration [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d, uidFile } = await execute(t, { probeExit: 0, extendedBase: true });
  assert.equal(result.status, IMPORT_DONE, `the process exit code is the success code, not ${result.status}`); assert.equal(d.exitCode, 0); assert.equal(d.phase, 'complete');
  assert.equal(d.commands.find(c => c.phase === 'import').exitCode, 9);
  assert.equal(d.commands.find(c => c.phase === 'probe').exitCode, 0);
  assert.equal(d.registration.matches, 1); assert.equal(d.registration.basePathMatches, true);
  assert.equal(await fs.readFile(uidFile, 'utf8'), '1000');
});

test('M5-b diagnostic capture decodes UTF16 WSL output and replaces a stale success result [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d } = await execute(t, { utf16: true, stale: true });
  assert.equal(result.status, 3); assert.notEqual(d.runId, 'stale');
  assert.match(d.commands.find(c => c.phase === 'version').stdout, /版本测试/);
  assert.match(d.commands.find(c => c.phase === 'import').stderr, /0x80070005/);
  assert.ok(!JSON.stringify(d).includes('\\u0000'));
});

test('M5-b a stuck own WSL command is bounded and leaves a diagnostic timeout [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d, uidFile } = await execute(t, { hang: true });
  assert.equal(result.status, 3);
  const probe = d.commands.find(c => c.phase === 'probe');
  assert.equal(probe.timedOut, true); assert.equal(probe.exitCode, -1);
  assert.equal(await fs.stat(uidFile).then(() => true, () => false), false);
});

test('M5-b diagnostic file has explicit protected reader ACL after replacing a weak old result [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, output } = await execute(t, { stale: true, weakOldAcl: true });
  assert.equal(result.status, 3);
  const inspect = `
$acl = [IO.File]::GetAccessControl($env:FAKE_OUTPUT_PATH)
$raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
[ordered]@{ current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; owner = $raw.Owner.Value
  protected = (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0)
  aces = @($raw.DiscretionaryAcl | ForEach-Object { [ordered]@{ sid = $_.SecurityIdentifier.Value; mask = $_.AccessMask; type = [string]$_.AceType; flags = [string]$_.AceFlags } })
} | ConvertTo-Json -Depth 4 -Compress
`;
  const actual = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', inspect], {
    env: { ...process.env, FAKE_OUTPUT_PATH: output },
  });
  assert.equal(actual.status, 0, actual.stdout + actual.stderr);
  const acl = JSON.parse(actual.stdout);
  assert.equal(acl.owner, acl.current); assert.equal(acl.protected, true);
  assert.deepEqual(acl.aces, [
    { sid: 'S-1-5-18', mask: 0x120089, type: 'AccessAllowed', flags: 'None' },
    { sid: 'S-1-5-32-544', mask: 0x120089, type: 'AccessAllowed', flags: 'None' },
    { sid: acl.current, mask: 0x1301bf, type: 'AccessAllowed', flags: 'None' },
  ], 'only SYSTEM/Administrators read and the current account modify; no inherited Everyone or Users');
});

test('M5-b import success still requires a runnable distribution; missing or wrong-path registration is refused [needs:non-elevated]', { skip: !windows }, async t => {
  const badProbe = await execute(t, { importExit: 0, probeExit: 7 });
  assert.equal(badProbe.result.status, 3);
  for (const patch of [{ registered: false }, { wrongBase: true }]) {
    const bad = await execute(t, { importExit: 0, probeExit: 0, ...patch });
    assert.equal(bad.result.status, 4);
    assert.equal(await fs.stat(bad.uidFile).then(() => true, () => false), false);
  }
});

test('M5-b invalid machine client leaves a protected refusal and runs no WSL command [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d, uidFile } = await execute(t, { clientRefusal: true });
  assert.equal(result.status, 8); assert.equal(d.exitCode, 8);
  assert.equal(d.refusal, 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID');
  assert.deepEqual(d.commands, []);
  assert.equal(await fs.stat(uidFile).then(() => true, () => false), false);
});

test('M5-b diagnostic capture decodes explicit non-ASCII GBK bytes independent of OS code page [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d } = await execute(t, { gbk: true });
  assert.equal(result.status, 3);
  assert.match(d.commands[0].stdout, /\u7248\u672c\u6d4b\u8bd5/);
  assert.ok(!d.commands[0].stdout.includes('\uFFFD'));
});


test('shared machine WSL validator is identical in Registrar and refuses unsafe fixed-path facts', { skip: !windows }, async () => {
  const tools = await fixture();
  const helper = await fs.readFile(new URL('../windows/wsl-client.ps1', import.meta.url), 'utf8');
  assert.equal(run(tools.dump, ['--validator']).stdout.replace(/\r\n/g, '\n'), helper.replace(/\r\n/g, '\n'));
  const management = (await fs.readFile(new URL('../windows/companion-headless.ps1', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const embedded = management.match(/^# begin shared machine WSL client[^\n]*\n([\s\S]*?)^# end shared machine WSL client/m);
  assert.ok(embedded, 'management contains a marked shared resolver');
  assert.equal(embedded[1].trim(), helper.replace(/\r\n/g, '\n').trim(), 'management trust resolver must match package and Registrar');
  assert.ok(!helper.includes('param('), 'resolver has no configurable executable path');
  const isolated = helper.replaceAll('Microsoft.PowerShell.Management\\Get-Item', 'Get-FixtureItem')
    .replaceAll('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature', 'Get-FixtureSignature')
    .replaceAll('Microsoft.PowerShell.Utility\\Get-FileHash', 'Get-FixtureHash');
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
function Get-FixtureItem { param([string]$LiteralPath, [switch]$Force, $ErrorAction)
  $script:seen.Add($LiteralPath)
  if ($script:c.kind -eq 'missing' -and $LiteralPath -eq $script:c.path) { Write-Error 'fixture missing' -Category ObjectNotFound -ErrorAction Stop }
  if ($script:c.kind -eq 'unreadable' -and $LiteralPath -eq $script:c.path) { throw 'fixture denied' }
  $dir = $LiteralPath -cne 'C:\Program Files\WSL\wsl.exe'
  if ($script:c.kind -eq 'wrongkind' -and $LiteralPath -eq $script:c.path) { $dir = -not $dir }
  [pscustomobject]@{ Attributes = $(if ($script:c.kind -eq 'reparse' -and $LiteralPath -eq $script:c.path) { [IO.FileAttributes]::ReparsePoint } else { [IO.FileAttributes]::Normal }); PSIsContainer = $dir }
}
function Get-FixtureSignature { param([string]$LiteralPath, $ErrorAction)
  if ($LiteralPath -cne 'C:\Program Files\WSL\wsl.exe') { throw 'UNEXPECTED_SIGNATURE_PATH' }
  [pscustomobject]@{ Status = $(if ($script:c.kind -eq 'signature') { 'HashMismatch' } else { 'Valid' }); SignerCertificate = [pscustomobject]@{
    Subject = $(switch ($script:c.kind) { 'cn' { 'CN=Microsoft Corporation Evil, O=Microsoft Corporation, C=US' }; 'org' { 'CN=Microsoft Corporation, O=Microsoft Corporation Evil, C=US' }; default { 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' } });
    Thumbprint = $(if ($script:c.kind -eq 'thumb') { 'INVALID' } else { '0123456789abcdef0123456789abcdef01234567' }) }
  }
}
function Get-FixtureHash { param([string]$LiteralPath, [string]$Algorithm, $ErrorAction)
  if ($LiteralPath -cne 'C:\Program Files\WSL\wsl.exe' -or $Algorithm -cne 'SHA256') { throw 'UNEXPECTED_HASH_PATH' }
  [pscustomobject]@{ Hash = $(if ($script:c.kind -eq 'hash') { 'INVALID' } else { 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789' }) }
}
$cases = @(@{ kind = 'valid'; path = ''; want = '' })
foreach ($p in @('C:\', 'C:\Program Files', 'C:\Program Files\WSL', 'C:\Program Files\WSL\wsl.exe')) {
  foreach ($k in @('reparse', 'wrongkind', 'missing', 'unreadable')) {
    $cases += @{ kind = $k; path = $p; want = $(switch ($k) { 'reparse' { 'WSL_MACHINE_CLIENT_NOT_PLAIN' }; 'wrongkind' { 'WSL_MACHINE_CLIENT_NOT_PLAIN' }; 'missing' { 'WSL_MACHINE_CLIENT_MISSING' }; default { 'WSL_MACHINE_CLIENT_UNREADABLE' } }) }
  }
}
foreach ($k in @('signature','cn','org','thumb','hash')) {
  $cases += @{ kind = $k; path = ''; want = $(switch ($k) { 'signature' { 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID' }; 'hash' { 'WSL_MACHINE_CLIENT_UNREADABLE' }; default { 'WSL_MACHINE_CLIENT_PUBLISHER_INVALID' } }) }
}
$results = foreach ($script:c in $cases) {
  $script:seen = New-Object 'Collections.Generic.List[string]'
  $actual = ''; $value = $null
  try { $value = Get-CluedMachineWslClient } catch { $actual = $_.Exception.Message }
  if ($actual -cne $script:c.want) { throw ('CASE_FAILED:' + $script:c.kind + ':' + $script:c.path + ':' + $actual) }
  if ($value) {
    if (($value.PSObject.Properties.Name -join ',') -cne 'contract,path,sha256,signerThumbprint' -or
        $value.contract -cne 'clued.independent-ci.wsl-client/1' -or $value.path -cne 'C:\Program Files\WSL\wsl.exe' -or
        $value.sha256 -cne 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' -or
        $value.signerThumbprint -cne '0123456789ABCDEF0123456789ABCDEF01234567') { throw 'VALID_METADATA_WRONG' }
    if (($script:seen -join '|') -cne 'C:\|C:\Program Files|C:\Program Files\WSL|C:\Program Files\WSL\wsl.exe') { throw 'ANCESTOR_ORDER_WRONG' }
  }
  [pscustomobject]@{ kind = $script:c.kind; path = $script:c.path; refusal = $actual }
}
$results | ConvertTo-Json -Compress
`;
  const script = path.join(tools.dir, 'validator-cases.ps1');
  await fs.writeFile(script, isolated + harness);
  const checked = run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const cases = JSON.parse(checked.stdout);
  assert.equal(cases.length, 22);
  assert.equal(cases.filter(c => c.refusal === '').length, 1, 'rotated valid Microsoft signer is accepted');
});

test('root-shell trust validation precedes password generation and account mutation', async () => {
  const code = await fs.readFile(source, 'utf8');
  const flow = code.slice(code.indexOf('static int RegisterAccountSteps('), code.indexOf('static int RegisterAccountSteps(') + 7000);
  const verified = flow.indexOf('RegistrarCore.MachineWslClientRefusal()');
  assert.ok(verified > 0);
  for (const mutation of ['NewRandomPassword()', 'NetUserAdd(', 'NetUserSetInfo(', 'Call(svc, "NewTask"']) {
    const index = flow.indexOf(mutation);
    if (index >= 0) assert.ok(verified < index, mutation);
  }
});

// ---- Task 87d330d0, line A (drill r11, judgement 2): the import's success is the import program's own exit code, never the Task
// Scheduler's default 0. Invoke-CompanionWslImportTask took "LastRunTime changed, state 2 (queued)" two seconds after Run for an end,
// read the LastTaskResult 0 an instance that never ran leaves, deleted the import task under the queued instance, and the switch then
// recorded imported and removed the Owner's WSL registration. companion-headless.ps1's real functions run in Windows PowerShell 5.1
// against a stand-in Task Scheduler (New-Object -ComObject Schedule.Service, Start-Sleep and Get-Date are stood in: a fake clock that
// a sleep advances, so 120 and 600 seconds pass without waiting). Nothing is registered, run, stopped or deleted on this host.
const headless = fileURLToPath(new URL('../windows/companion-headless.ps1', import.meta.url));
const IMPORT_DONE = 0x434C4901; // RegistrarCore.ImportDoneExitCode / $CompanionImportDoneExitCode (1129072897)
const psq = s => `'${String(s).replace(/'/g, "''")}'`;
let headlessTmp;
after(async () => { if (headlessTmp) await fs.rm(headlessTmp, { recursive: true, force: true }); });

function headlessPs(body) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'
. ${psq(headless)}
${body}`;
  const r = run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { timeout: 180_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}

// The stand-in Task Scheduler. $script:seq answers, for the milliseconds since Run, the task's State, its LastTaskResult and its
// instances (State, EnginePID); before Run the task is ready (3), never run, last result 0x41303. The log keeps Run, Stop and Delete
// with the fake milliseconds since Run. The import's clock (Get-CompanionMonotonicMs) is the fake one; readFailAfter: from that many ms
// after Run every GetTask throws; instancesFail: GetInstances always throws.
// K3 (task 87d330d0, drill r11 repro): Run always queues (State 2, an instance 2 with no engine, LastTaskResult 0: what the guest showed);
// only RunEx with flag 2 (ignore constraints) follows $script:seq, and with runExQueues not even that. The companion task
// (CluedCIResidentCompanion) is the same stand-in. NewTask and RegisterTaskDefinition keep what was registered ($script:registered);
// startRegisterFails: registering CluedCIResidentCompanionStart throws.
const fakeScheduler = (seq, { absent = false, readFailAfter = -1, instancesFail = false, runExQueues = false, startRegisterFails = false } = {}) => `
$script:ms = 0; $script:runAt = -1; $script:deleted = $false; $script:sleeps = 0
$script:readFailAfter = ${readFailAfter}; $script:instancesFail = ${instancesFail ? '$true' : '$false'}
$script:runExQueues = ${runExQueues ? '$true' : '$false'}; $script:startRegisterFails = ${startRegisterFails ? '$true' : '$false'}
$script:queuedSeq = { param($t) @{ state = 2; result = 0; inst = @(,@(2, 0)) } }
$script:effective = $script:queuedSeq
$script:registered = @{}
function Get-CompanionMonotonicMs { [double]$script:ms }
$script:log = New-Object Collections.ArrayList
$script:epoch = [DateTime]::new(2026, 11, 24, 12, 16, 20, [DateTimeKind]::Utc)
$script:seq = { param($t) ${seq} }
function Get-Date { $script:epoch.AddMilliseconds($script:ms) }
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) $script:sleeps++; $script:ms += $Seconds * 1000 + $Milliseconds; if ($script:ms -gt 1800000) { throw 'FAKE_CLOCK_RUNAWAY' } }
function Get-FakeNow { $script:ms - $script:runAt }
$script:task = [pscustomobject]@{}
$script:task | Add-Member -MemberType ScriptProperty -Name State -Value { if ($script:runAt -lt 0) { 3 } else { [int](& $script:effective (Get-FakeNow)).state } }
$script:task | Add-Member -MemberType ScriptProperty -Name LastRunTime -Value { if ($script:runAt -lt 0) { [DateTime]'1899-12-30T00:00:00' } else { $script:epoch.AddMilliseconds($script:runAt) } }
$script:task | Add-Member -MemberType ScriptProperty -Name LastTaskResult -Value { if ($script:runAt -lt 0) { 267011 } else { (& $script:effective (Get-FakeNow)).result } }
$script:task | Add-Member -MemberType ScriptMethod -Name GetInstances -Value { param($flags) if ($script:runAt -lt 0) { return }
  if ($script:instancesFail) { throw (Microsoft.PowerShell.Utility\\New-Object Runtime.InteropServices.COMException 'instances unreadable') }
  foreach ($i in @((& $script:effective (Get-FakeNow)).inst)) { [pscustomobject]@{ InstanceGuid = '{95BCDEC3-0000-4000-8000-000000000001}'; State = $i[0]; EnginePID = $i[1] } } }
$script:task | Add-Member -MemberType ScriptMethod -Name Run -Value { param($a) $script:runAt = $script:ms; $script:effective = $script:queuedSeq; [void]$script:log.Add('run')
  [pscustomobject]@{ InstanceGuid = '{95BCDEC3-0000-4000-8000-000000000001}'; State = 2; EnginePID = 0 } }
$script:task | Add-Member -MemberType ScriptMethod -Name RunEx -Value { param($a, $f, $sid, $u) $script:runAt = $script:ms
  [void]$script:log.Add('runex flags=' + $f + ' session=' + $sid + ' user=' + $(if ($null -eq $u) { '$null' } else { "'" + $u + "'" }) + ' params=' + $(if ($null -eq $a) { '$null' } else { 'set' }))
  if ((([int]$f) -band 2) -and -not $script:runExQueues) { $script:effective = $script:seq; [pscustomobject]@{ InstanceGuid = '{95BCDEC3-0000-4000-8000-000000000001}'; State = 4; EnginePID = 4242 } }
  else { $script:effective = $script:queuedSeq; [pscustomobject]@{ InstanceGuid = '{95BCDEC3-0000-4000-8000-000000000001}'; State = 2; EnginePID = 0 } } }
$script:task | Add-Member -MemberType ScriptMethod -Name Stop -Value { param($f) [void]$script:log.Add('stop:' + $f + '@' + (Get-FakeNow)) }
$script:folder = [pscustomobject]@{}
$script:folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n)
  if ($script:runAt -ge 0 -and $script:readFailAfter -ge 0 -and (Get-FakeNow) -ge $script:readFailAfter) { throw (Microsoft.PowerShell.Utility\\New-Object Runtime.InteropServices.COMException 'task unreadable') }
  if ($n -ceq 'CluedCIResidentCompanion') { return $script:task }
  if (${absent ? '$true' : '$false'} -or $script:deleted -or $n -cne 'CluedCIResidentCompanionWslImport') { throw (Microsoft.PowerShell.Utility\\New-Object Runtime.InteropServices.COMException 'not found') }; $script:task }
$script:folder | Add-Member -MemberType ScriptMethod -Name DeleteTask -Value { param($n, $f) if ($n -ceq 'CluedCIResidentCompanionWslImport') { $script:deleted = $true }; [void]$script:log.Add('delete:' + $n + '@' + (Get-FakeNow)) }
$script:folder | Add-Member -MemberType ScriptMethod -Name RegisterTaskDefinition -Value { param($n, $d, $flags, $user, $password, $logonType, $sddl)
  if ($script:startRegisterFails -and $n -ceq 'CluedCIResidentCompanionStart') { throw (Microsoft.PowerShell.Utility\\New-Object Runtime.InteropServices.COMException 'access denied') }
  [void]$script:log.Add('register:' + $n)
  $script:registered[$n] = [ordered]@{ principal = $d.Principal; settings = $d.Settings; triggers = @($d.TriggerList); actions = @($d.ActionList); flags = $flags; user = $user; password = $password; logonType = $logonType; sddl = $sddl } }
$script:svc = [pscustomobject]@{}
$script:svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
$script:svc | Add-Member -MemberType ScriptMethod -Name NewTask -Value { param($f)
  $d = [pscustomobject]@{ Principal = @{}; Settings = @{}; TriggerList = (Microsoft.PowerShell.Utility\\New-Object Collections.ArrayList); ActionList = (Microsoft.PowerShell.Utility\\New-Object Collections.ArrayList); Triggers = $null; Actions = $null }
  $d.Triggers = [pscustomobject]@{ list = $d.TriggerList }; $d.Triggers | Add-Member -MemberType ScriptMethod -Name Create -Value { param($type) $x = @{ Type = $type; Repetition = @{} }; [void]$this.list.Add($x); $x }
  $d.Actions = [pscustomobject]@{ list = $d.ActionList }; $d.Actions | Add-Member -MemberType ScriptMethod -Name Create -Value { param($type) $x = @{ Type = $type }; [void]$this.list.Add($x); $x }
  $d }
$script:svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) if ($p -cne '\\Clued') { throw 'UNEXPECTED_FOLDER' }; $script:folder }
function New-Object { param([Parameter(Position = 0)][string]$TypeName, [Parameter(Position = 1)][object[]]$ArgumentList, [string]$ComObject)
  if ($ComObject) { if ($ComObject -cne 'Schedule.Service') { throw 'UNEXPECTED_COM' }; return $script:svc }
  if ($null -eq $ArgumentList) { Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName } else { Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList } }
`;
// Drill r11 as the Task Scheduler showed it: after Run the task is queued (2), LastRunTime is now, LastTaskResult 0, one instance queued
// with no engine, and that stays so.
const R11_QUEUED = `@{ state = 2; result = 0; inst = @(,@(2, 0)) }`;
// The one start the import and the companion task may get (K3): RunEx, ignore constraints, no session, no user, no parameters.
const RUNEX = 'runex flags=2 session=0 user=$null params=$null';
// Started at once (the guest's RunEx: running within a few hundred ms), ended at 1 s with the given last result.
const ranAtOnce = code => `if ($t -lt 1000) { @{ state = 4; result = 267009; inst = @(,@(4, 4242)) } } else { @{ state = 3; result = ${code}; inst = @() } }`;
// Queued 3 s, running until 5 s, then ended with the given last result.
const queuedThenRan = code => `if ($t -lt 3000) { @{ state = 2; result = 0; inst = @(,@(2, 0)) } } elseif ($t -lt 5000) { @{ state = 4; result = 267009; inst = @(,@(4, 4242)) } } else { @{ state = 3; result = ${code}; inst = @() } }`;
const importCall = `$r = Invoke-CompanionWslImportTask
$watch = Get-Variable -Name CompanionImportWatch -Scope Script -ValueOnly -ErrorAction SilentlyContinue
[ordered]@{ r = $r; type = $(if ($null -eq $r) { $null } else { $r.GetType().Name }); log = @($script:log); sleeps = $script:sleeps; watch = $watch } | ConvertTo-Json -Depth 8 -Compress`;

// The account switch up to the import (relay parents, build, preflight, registrar and qualification stood in); the record is the real
// install\companion-wsl.json in a scratch root, written by the real Write-CompanionWslRecord.
async function switchRoot(name) {
  if (!headlessTmp) headlessTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-m5b-import-wait-'));
  const dir = path.join(headlessTmp, name);
  await fs.mkdir(path.join(dir, 'install'), { recursive: true });
  await fs.writeFile(path.join(dir, 'install', 'install-receipt.json'), JSON.stringify({ residentManifestSha256: 'a'.repeat(64) }));
  return dir;
}
const accountSwitch = root => `
function Get-CompanionRelayParentsProblem { $null }
function New-CompanionBuild { [ordered]@{ directory = 'C:\\none'; generation = ('a' * 64); registrar = [ordered]@{ exe = 'registrar.exe'; sourceSha256 = ('b' * 64); sha256 = ('c' * 64) } } }
function Remove-CompanionBuild { }
function Get-CompanionAccountFacts { $null }
function Get-CompanionDomainCredsDisabled { 0 }
function Get-LockoutPolicy { $null }
function Get-CompanionAccountPreflight { [ordered]@{ refusals = @() } }
function Register-CompanionFallbackTask { [void]$script:log.Add('fallback-task') }
function Remove-CompanionFallbackTask { [void]$script:log.Add('fallback-task-removed') }
function Write-CompanionPending { }
function Stop-CompanionTask { }
function Get-CompanionProcessTree { [ordered]@{ supervisors = @(); children = @() } }
function Wait-CompanionTaskNotRunning { }
function Invoke-CompanionWslMove([string]$root) { $rec = [ordered]@{ contract = $CompanionWslContract; stage = 'moved'; imported = $false; distro = 'CluedResident-Linux'; target = 'D:\\clued-resident\\wsl\\CluedResident-Linux\\ext4.vhdx'
  ownerRegistration = [ordered]@{ guid = '{g1}'; values = [ordered]@{ DefaultUid = 1000 } } }; Write-CompanionWslRecord $root $rec; $rec }
function Invoke-CompanionRegistrar { [void]$script:log.Add('registrar'); '{"code":"REGISTERED"}' }
function Get-WslRegistrations { @([ordered]@{ guid = '{g1}'; name = 'CluedResident-Linux' }) }
function Remove-CompanionLxssKey([string]$guid) { [void]$script:log.Add('remove-key:' + $guid) }
function Get-CompanionLxssDefault { '{g1}' }
function Remove-CompanionLxssDefault { [void]$script:log.Add('remove-default') }
function Register-CompanionTaskInteractive { [void]$script:log.Add('fallback'); ('d' * 64) }
function Invoke-CompanionStopAndFallback { [void]$script:log.Add('stop-and-fallback'); [ordered]@{ fellBack = $true } }
function Get-CompanionTaskRunFacts { [ordered]@{ state = 3 } }
function Start-CompanionTask { [void]$script:log.Add('run-companion') }
function Wait-CompanionQualified { $null }
function Get-CompanionTaskFacts { [ordered]@{ mode = 'password'; problems = @() } }
$r = Invoke-CompanionAccountSwitch ${psq(root)} ([pscustomobject]@{ ownerSid = 'S-1-5-21-1-2-3-1001'; wslDistribution = 'CluedResident-Linux' }) 'D:\\clued-resident\\wsl\\CluedResident-Linux' 'account'
$record = Read-CompanionWslRecord ${psq(root)}
[ordered]@{ failed = $r.failed; fellBack = $r.fellBack; qualified = $r.qualified; importResult = $r.importResult; importWatch = $r['importWatch']
  log = @($script:log); stage = [string]$record.stage; imported = [bool]$record.imported; start = $script:registered['CluedCIResidentCompanionStart'] } | ConvertTo-Json -Depth 8 -Compress`;

test('T1 import (drill r11): an instance queued for 120 s is not-started, stopped, and its task deleted; no exit code is read', { skip: !windows, timeout: 240_000 }, () => {
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExQueues: true }) + importCall);
  assert.equal(got.r, 'not-started', `drill r11 sequence returned ${JSON.stringify(got.r)} (${got.type}); log ${got.log.join(',')}`);
  assert.deepEqual(got.log.slice(1), ['stop:0@120000', 'delete:CluedCIResidentCompanionWslImport@120000'], 'stopped at 120 s, then the task deleted');
  assert.equal(got.sleeps, 240, 'a read every 500 ms on the fake clock, no real wait');
  assert.equal(got.watch.startedAfterMs, null); assert.equal(got.watch.endedAfterMs, null);
  assert.deepEqual(got.watch.returned, { instanceGuid: '{95BCDEC3-0000-4000-8000-000000000001}', state: 2, enginePid: 0 });
  assert.deepEqual(got.watch.transitions, [{ ms: 500, state: 2, lastTaskResult: 0, instances: [{ state: 2, enginePid: 0 }] }], 'one entry: nothing changed after it');
});

test('T1 import: the Task Scheduler, the sleep and the clock can be handed in (no stand-in commands)', { skip: !windows, timeout: 240_000 }, () => {
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExQueues: true }) + `
function New-Object { throw 'STAND_IN_NOT_HANDED_IN:New-Object' }
function Start-Sleep { throw 'STAND_IN_NOT_HANDED_IN:Start-Sleep' }
function Get-Date { throw 'STAND_IN_NOT_HANDED_IN:Get-Date' }
function Get-CompanionMonotonicMs { throw 'STAND_IN_NOT_HANDED_IN:Get-CompanionMonotonicMs' }
$script:clock = 0
$r = Invoke-CompanionWslImportTask -Service { $script:svc } -Sleep { $script:clock += 500; $script:ms = $script:clock; if ($script:clock -gt 1800000) { throw 'FAKE_CLOCK_RUNAWAY' } } -Now { $script:clock }
[ordered]@{ r = $r; log = @($script:log) } | ConvertTo-Json -Compress`);
  assert.equal(got.r, 'not-started');
  assert.deepEqual(got.log.slice(1), ['stop:0@120000', 'delete:CluedCIResidentCompanionWslImport@120000']);
});

test('T2 switch (drill r11): not-started fails the import, keeps the Owner registration and the record at moved, and falls back', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('t2');
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExQueues: true }) + accountSwitch(root));
  assert.equal(got.failed, 'WSL_IMPORT_FAILED:not-started', `log ${got.log.join(',')}`);
  assert.ok(!got.log.some(l => l.startsWith('remove-key') || l === 'remove-default'), `the Owner's registration was removed: ${got.log.join(',')}`);
  assert.equal(got.stage, 'moved'); assert.equal(got.imported, false);
  assert.ok(got.log.includes('fallback') && got.fellBack === true, 'back to the interactive definition');
  assert.ok(got.log.indexOf('stop:0@120000') >= 0 && got.log.indexOf('stop:0@120000') < got.log.indexOf('delete:CluedCIResidentCompanionWslImport@120000'));
  assert.equal(got.importWatch.startedAfterMs, null, 'the watch travels in the switch result');
});

test('T3 import: queued 3 s, then ran and ended with the program\'s own code: success, started after 3 s; the switch removes the key after', { skip: !windows, timeout: 240_000 }, async () => {
  const got = headlessPs(fakeScheduler(queuedThenRan(IMPORT_DONE)) + importCall);
  assert.equal(got.r, IMPORT_DONE, `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.equal(got.type, 'Int64');
  assert.equal(got.watch.startedAfterMs, 3000); assert.equal(got.watch.endedAfterMs, 5000);
  assert.deepEqual(got.watch.transitions.map(x => [x.ms, x.state, x.lastTaskResult]), [[500, 2, 0], [3000, 4, 267009], [5000, 3, IMPORT_DONE]]);
  assert.deepEqual(got.log, [RUNEX, 'delete:CluedCIResidentCompanionWslImport@5000'], 'nothing stopped');
  const root = await switchRoot('t3');
  const sw = headlessPs(fakeScheduler(queuedThenRan(IMPORT_DONE)) + accountSwitch(root));
  assert.equal(sw.failed, null, `log ${sw.log.join(',')}`); assert.equal(sw.qualified, true);
  assert.equal(sw.stage, 'qualified'); assert.equal(sw.imported, true);
  assert.ok(sw.log.indexOf('delete:CluedCIResidentCompanionWslImport@5000') < sw.log.indexOf('remove-key:{g1}'), sw.log.join(','));
  assert.equal(sw.importWatch.startedAfterMs, 3000);
});

test('T4 switch: an import task never seen running whose last result is 0 (what a queued instance leaves) is not-started, never an import; the key kept', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('t4');
  const got = headlessPs(fakeScheduler(`if ($t -lt 1000) { @{ state = 2; result = 0; inst = @(,@(2, 0)) } } else { @{ state = 3; result = 0; inst = @() } }`) + accountSwitch(root));
  assert.equal(got.failed, 'WSL_IMPORT_FAILED:not-started', `log ${got.log.join(',')}`);
  assert.ok(!got.log.some(l => l.startsWith('remove-key')), got.log.join(','));
  assert.equal(got.stage, 'moved'); assert.equal(got.imported, false); assert.equal(got.fellBack, true);
});

test('T5 switch: the program\'s failure code 3 is WSL_IMPORT_FAILED:3, the key kept', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('t5');
  const got = headlessPs(fakeScheduler(`if ($t -lt 1000) { @{ state = 4; result = 267009; inst = @(,@(4, 99)) } } else { @{ state = 3; result = 3; inst = @() } }`) + accountSwitch(root));
  assert.equal(got.failed, 'WSL_IMPORT_FAILED:3', `log ${got.log.join(',')}`);
  assert.ok(!got.log.some(l => l.startsWith('remove-key')));
  assert.equal(got.stage, 'moved'); assert.equal(got.imported, false);
});

test('T6 import: an instance that keeps running is stopped at 600 s (timeout); a missing task is not-registered', { skip: !windows, timeout: 240_000 }, () => {
  const got = headlessPs(fakeScheduler(`@{ state = 4; result = 267009; inst = @(,@(4, 77)) }`) + importCall);
  assert.equal(got.r, 'timeout', `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.deepEqual(got.log, [RUNEX, 'stop:0@600000', 'delete:CluedCIResidentCompanionWslImport@600000']);
  assert.equal(got.watch.startedAfterMs, 500);
  const none = headlessPs(fakeScheduler(R11_QUEUED, { absent: true }) + importCall);
  assert.equal(none.r, 'not-registered'); assert.deepEqual(none.log, []);
});

test('T7 the import success code is one value: RegistrarCore.ImportDoneExitCode, $CompanionImportDoneExitCode, 0x434C4901', { skip: !windows }, async () => {
  const tools = await fixture();
  const constSource = path.join(tools.dir, 'DoneCode.cs'), constExe = path.join(tools.dir, 'done-code.exe');
  await fs.writeFile(constSource, 'public static class DoneCode { public static int Main() { System.Console.Write(RegistrarCore.ImportDoneExitCode); return 0; } }');
  const refs = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map(n => `/reference:${path.join(framework, n)}`);
  const compiled = run(path.join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/main:DoneCode', ...refs, `/out:${constExe}`, source, constSource]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const cs = Number(run(constExe, []).stdout.trim());
  const ps1 = headlessPs('[ordered]@{ code = [int64]$CompanionImportDoneExitCode } | ConvertTo-Json -Compress').code;
  assert.equal(cs, IMPORT_DONE); assert.equal(ps1, IMPORT_DONE);
});

test('T7 RegistrarPureTests.cs: the registrar\'s pure checks pass, among them the import program\'s exit codes', { skip: !windows }, async () => {
  const tools = await fixture();
  const pure = path.join(tools.dir, 'registrar-pure.exe');
  const refs = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Xml.dll'].map(n => `/reference:${path.join(framework, n)}`);
  const compiled = run(path.join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/main:RegistrarPureTests', ...refs, `/out:${pure}`, source,
    fileURLToPath(new URL('../windows/RegistrarPureTests.cs', import.meta.url))]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const out = run(pure, [], { timeout: 60_000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /"status":"REGISTRAR_PURE_PASS"/);
});

// Review after the first pass (task 87d330d0): the clock, a failed read, and instances that cannot be read.

test('R1 import: the wait runs on a monotonic clock; a wall-clock step of 200 s neither stops nor times the import', { skip: !windows, timeout: 240_000 }, () => {
  // the wall clock steps 200 s forward 1 s after Run (a time sync); the import's own clock does not
  const jump = `
function Get-Date { $j = if ($script:runAt -ge 0 -and (Get-FakeNow) -ge 1000) { 200000 } else { 0 }; $script:epoch.AddMilliseconds($script:ms + $j) }
`;
  const got = headlessPs(fakeScheduler(queuedThenRan(IMPORT_DONE)) + jump + importCall);
  assert.equal(got.r, IMPORT_DONE, `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.equal(got.watch.startedAfterMs, 3000); assert.equal(got.watch.endedAfterMs, 5000);
  assert.deepEqual(got.log, [RUNEX, 'delete:CluedCIResidentCompanionWslImport@5000']);
  // the clock itself: Stopwatch milliseconds, never the wall clock
  const clock = headlessPs(`function Get-Date { throw 'WALL_CLOCK_READ' }
$a = Get-CompanionMonotonicMs; Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 300; $b = Get-CompanionMonotonicMs
[ordered]@{ type = $a.GetType().Name; d = $b - $a } | ConvertTo-Json -Compress`);
  assert.equal(clock.type, 'Double');
  assert.ok(clock.d >= 250 && clock.d < 30000, `300 ms on the monotonic clock read ${clock.d} ms`);
});

test('R2 import: a failed read while waiting stops the instance, deletes the task and is unreadable; the switch falls back, the key kept', { skip: !windows, timeout: 240_000 }, async () => {
  const got = headlessPs(fakeScheduler(R11_QUEUED, { readFailAfter: 1500 }) + importCall);
  assert.equal(got.r, 'unreadable', `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.deepEqual(got.log, [RUNEX, 'stop:0@1500', 'delete:CluedCIResidentCompanionWslImport@1500'], 'stopped, then the task deleted');
  assert.equal(got.watch.why, 'unreadable'); assert.equal(got.watch.error, 'COMException:0x80004005', 'the innermost exception, not PowerShell\'s wrapper');
  assert.equal(got.watch.endedAfterMs, null);
  const root = await switchRoot('r2');
  const sw = headlessPs(fakeScheduler(R11_QUEUED, { readFailAfter: 1500 }) + accountSwitch(root));
  assert.equal(sw.failed, 'WSL_IMPORT_FAILED:unreadable', `log ${sw.log.join(',')}`);
  assert.ok(!sw.log.some(l => l.startsWith('remove-key') || l === 'remove-default'), `the Owner's registration was removed: ${sw.log.join(',')}`);
  assert.equal(sw.stage, 'moved'); assert.equal(sw.imported, false);
  assert.ok(sw.log.includes('fallback') && sw.fellBack === true, 'back to the interactive definition');
  assert.ok(sw.log.indexOf('stop:0@1500') >= 0 && sw.log.indexOf('stop:0@1500') < sw.log.indexOf('delete:CluedCIResidentCompanionWslImport@1500'), sw.log.join(','));
  assert.equal(sw.importWatch.why, 'unreadable');
});

test('R3 import: instances never readable: ended (not queued, not running, run, the program\'s success code) is success; anything else as before, and the watch says why', { skip: !windows, timeout: 240_000 }, async () => {
  const ran = `if ($t -lt 1000) { @{ state = 2; result = 0; inst = @(,@(2, 0)) } } elseif ($t -lt 2000) { @{ state = 4; result = 267009; inst = @(,@(4, 4242)) } } else { @{ state = 3; result = ${IMPORT_DONE}; inst = @() } }`;
  const got = headlessPs(fakeScheduler(ran, { instancesFail: true }) + importCall);
  assert.equal(got.r, IMPORT_DONE, `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  // started is read from the instances only, never the task's State (repro 2026-11-24): unreadable instances, no start seen
  assert.equal(got.watch.startedAfterMs, null); assert.equal(got.watch.endedAfterMs, 2000);
  assert.equal(got.watch.why, 'ended:instances-unreadable'); assert.equal(got.watch.instancesUnreadable, 4);
  assert.deepEqual(got.watch.transitions.map(x => [x.ms, x.state, x.lastTaskResult, x.instances]), [[500, 2, 0, null], [1000, 4, 267009, null], [2000, 3, IMPORT_DONE, null]]);
  assert.deepEqual(got.log, [RUNEX, 'delete:CluedCIResidentCompanionWslImport@2000']);
  const root = await switchRoot('r3');
  const sw = headlessPs(fakeScheduler(ran, { instancesFail: true }) + accountSwitch(root));
  assert.equal(sw.failed, null, `log ${sw.log.join(',')}`); assert.equal(sw.imported, true);
  // queued all along: not-started, and why
  const queued = headlessPs(fakeScheduler(R11_QUEUED, { instancesFail: true }) + importCall);
  assert.equal(queued.r, 'not-started');
  assert.equal(queued.watch.why, 'not-started:instances-unreadable');
  assert.deepEqual(queued.log, [RUNEX, 'stop:0@120000', 'delete:CluedCIResidentCompanionWslImport@120000']);
  // ended with a failure code: never success, as before (not-started, nothing seen running), and why
  const failed = headlessPs(fakeScheduler(`if ($t -lt 1000) { @{ state = 2; result = 0; inst = @(,@(2, 0)) } } else { @{ state = 3; result = 3; inst = @() } }`, { instancesFail: true }) + importCall);
  assert.equal(failed.r, 'not-started');
  assert.equal(failed.watch.why, 'not-started:instances-unreadable');
  // instances readable: the watch says ended
  const plain = headlessPs(fakeScheduler(queuedThenRan(IMPORT_DONE)) + importCall);
  assert.equal(plain.watch.why, 'ended'); assert.equal(plain.watch.instancesUnreadable, 0);
});

// K3 (FABLE-drill-companion-k3-20261124.md, task 87d330d0): every start of the companion account's tasks ignores constraints (RunEx flag
// 2), and a SYSTEM task \Clued\CluedCIResidentCompanionStart starts the password definition at boot and every 15 minutes.
const START = 'CluedCIResidentCompanionStart';

test('K3 T1 import: the import task is started with RunEx(ignore constraints) and ends with the program\'s code; no plain Run', { skip: !windows, timeout: 240_000 }, () => {
  const got = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE)) + importCall);
  assert.equal(got.r, IMPORT_DONE, `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.deepEqual(got.log, [RUNEX, 'delete:CluedCIResidentCompanionWslImport@1000'], 'one RunEx, flag 2, session 0, user $null; no Run');
  assert.equal(got.watch.startedAfterMs, 500); assert.equal(got.watch.why, 'ended');
});

test('K3 T2 switch: with RunEx the import runs, the record goes through imported to qualified and the watch has the start', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('k3-t2');
  const got = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE)) + accountSwitch(root));
  assert.equal(got.failed, null, `log ${got.log.join(',')}`); assert.equal(got.qualified, true);
  assert.equal(got.stage, 'qualified'); assert.equal(got.imported, true);
  assert.equal(got.importResult, IMPORT_DONE); assert.equal(got.importWatch.startedAfterMs, 500);
  assert.ok(got.log.indexOf('delete:CluedCIResidentCompanionWslImport@1000') < got.log.indexOf('remove-key:{g1}'), got.log.join(','));
  assert.ok(!got.log.includes('run'), 'no plain Run');
});

test('K3 T3 Start-CompanionTask: the companion task is started with RunEx(ignore constraints); the instance it returned is kept', { skip: !windows, timeout: 240_000 }, () => {
  const got = headlessPs(fakeScheduler(ranAtOnce(0)) + `
Start-CompanionTask
[ordered]@{ last = $script:CompanionLastRun; log = @($script:log) } | ConvertTo-Json -Depth 4 -Compress`);
  assert.deepEqual(got.log, [RUNEX], 'one RunEx, no Run');
  assert.deepEqual(got.last, { instanceGuid: '{95BCDEC3-0000-4000-8000-000000000001}', state: 4, enginePid: 4242 });
});

test('K3 T4 start task: registered before the first start, SYSTEM, boot +30 s and every 15 min, the one schtasks /Run /I action, SY and BA only', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('k3-t4');
  const got = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE)) + accountSwitch(root));
  assert.equal(got.failed, null, `log ${got.log.join(',')}`);
  const reg = got.log.indexOf('register:' + START);
  assert.ok(reg >= 0, `not registered: ${got.log.join(',')}`);
  assert.ok(reg < got.log.indexOf(RUNEX) && reg < got.log.indexOf('run-companion'), `registered after a start: ${got.log.join(',')}`);
  assert.ok(!got.log.some(l => l.startsWith('delete:' + START)), 'a qualified switch keeps it');
  const st = got.start;
  assert.deepEqual(st.principal, { UserId: 'S-1-5-18', LogonType: 5, RunLevel: 1 });
  assert.deepEqual([st.flags, st.user, st.password, st.logonType, st.sddl], [6, null, null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)']);
  assert.deepEqual(st.triggers, [{ Type: 8, Delay: 'PT30S', Repetition: {} }, { Type: 1, StartBoundary: '2026-01-01T00:00:00', Repetition: { Interval: 'PT15M' } }]);
  assert.deepEqual(st.settings, { MultipleInstances: 2, ExecutionTimeLimit: 'PT1M', StartWhenAvailable: true, DisallowStartIfOnBatteries: false, StopIfGoingOnBatteries: false });
  // the one fixed PowerShell line (repro 2026-11-24: schtasks /Run /I was not shown to start it while the constraint holds)
  assert.deepEqual(st.actions, [{ Type: 0, Path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    Arguments: `-NoProfile -NonInteractive -Command "$s = New-Object -ComObject 'Schedule.Service'; $s.Connect(); $null = $s.GetFolder('\\Clued').GetTask('CluedCIResidentCompanion').RunEx($null, 2, 0, $null)"` }]);
  // no parameters, idempotent (create or update), a failure is the one code
  const again = headlessPs(fakeScheduler(R11_QUEUED) + `Register-CompanionStartTask; Register-CompanionStartTask
$failed = try { $script:startRegisterFails = $true; Register-CompanionStartTask; 'NO_THROW' } catch { $_.Exception.Message }
[ordered]@{ log = @($script:log); failed = $failed } | ConvertTo-Json -Compress`);
  assert.deepEqual(again.log, ['register:' + START, 'register:' + START]);
  assert.equal(again.failed, 'COMPANION_START_TASK_REGISTER_FAILED');
  // the headless switch (-CompanionHeadless, -CompanionCredential) registers it too: after register-password, before the first start
  const text = await fs.readFile(headless, 'utf8');
  const body = text.slice(text.indexOf('function Invoke-CompanionHeadless('), text.indexOf('# ==== M5-b'));
  const pw = body.indexOf("'register-password'"), st2 = body.indexOf('Register-CompanionStartTask'), first = body.indexOf('Start-CompanionTask');
  assert.ok(pw > 0 && st2 > pw && st2 < first, 'Invoke-CompanionHeadless: register-password, then the start task, then the first start');
});

test('K3 T5 start task: every fall-back deletes it; a failed registration falls back with nothing half left', { skip: !windows, timeout: 240_000 }, async () => {
  // a failed import (not a maintenance switch): back to the interactive definition, the start task gone after it was registered
  const root = await switchRoot('k3-t5');
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExQueues: true }) + accountSwitch(root));
  assert.equal(got.failed, 'WSL_IMPORT_FAILED:not-started');
  const reg = got.log.indexOf('register:' + START), del = got.log.findIndex(l => l.startsWith('delete:' + START + '@'));
  assert.ok(reg >= 0 && del > reg && got.log.indexOf('fallback') >= 0, `log ${got.log.join(',')}`);
  // a cut-off switch rolled back (Invoke-CompanionStopAndFallback, as rearm, verify and the fall-back task call it)
  const cut = headlessPs(fakeScheduler(R11_QUEUED) + `
function Get-CompanionProcessTree { [ordered]@{ supervisors = @(); children = @() } }
function Register-CompanionTaskInteractive { [void]$script:log.Add('fallback'); ('d' * 64) }
function Remove-CompanionFallbackTask { }
$null = Invoke-CompanionStopAndFallback ${psq(root)} 'S-1-5-21-1-2-3-1001'
[ordered]@{ log = @($script:log) } | ConvertTo-Json -Compress`);
  assert.ok(cut.log.some(l => l.startsWith('delete:' + START + '@')), `log ${cut.log.join(',')}`);
  // the registration fails: the switch's failure path, nothing started, the Owner's registration kept, the start task not left
  const root2 = await switchRoot('k3-t5-fail');
  const bad = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE), { startRegisterFails: true }) + accountSwitch(root2));
  assert.equal(bad.failed, 'COMPANION_START_TASK_REGISTER_FAILED', `log ${bad.log.join(',')}`);
  assert.equal(bad.fellBack, true); assert.equal(bad.qualified, false);
  assert.ok(!bad.log.some(l => l.startsWith('runex') || l === 'run' || l === 'run-companion' || l.startsWith('remove-key')), bad.log.join(','));
  assert.ok(bad.log.includes('fallback') && bad.log.some(l => l.startsWith('delete:' + START + '@')), bad.log.join(','));
  assert.equal(bad.stage, 'moved'); assert.equal(bad.imported, false);
});

test('K3 T6 switch: a RunEx that queues too is still not-started at 120 s, the Owner\'s registration kept', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('k3-t6');
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExQueues: true }) + accountSwitch(root));
  assert.equal(got.failed, 'WSL_IMPORT_FAILED:not-started', `log ${got.log.join(',')}`);
  assert.ok(!got.log.some(l => l.startsWith('remove-key') || l === 'remove-default'), got.log.join(','));
  assert.equal(got.stage, 'moved'); assert.equal(got.imported, false);
});

test('K3 T7 import: started is an instance running or with an engine, never the task\'s State; a stale queued instance does not hide the end', { skip: !windows, timeout: 240_000 }, () => {
  // RunEx starts a new instance next to an older queued one; when it ends the task is back to State 2 (repro 2026-11-24)
  const stale = `if ($t -lt 2000) { @{ state = 4; result = 267009; inst = @(@(2, 0), @(4, 4242)) } } else { @{ state = 2; result = ${IMPORT_DONE}; inst = @(,@(2, 0)) } }`;
  const got = headlessPs(fakeScheduler(stale) + importCall);
  assert.equal(got.r, IMPORT_DONE, `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.equal(got.watch.startedAfterMs, 500); assert.equal(got.watch.endedAfterMs, 2000); assert.equal(got.watch.why, 'ended');
  assert.deepEqual(got.log, [RUNEX, 'delete:CluedCIResidentCompanionWslImport@2000']);
  // the task says running (4) but no instance runs or has an engine: never started, so not-started at 120 s
  const ghost = headlessPs(fakeScheduler(`@{ state = 4; result = 0; inst = @(,@(2, 0)) }`) + importCall);
  assert.equal(ghost.r, 'not-started', `returned ${JSON.stringify(ghost.r)}; log ${ghost.log.join(',')}`);
  assert.equal(ghost.watch.startedAfterMs, null);
  assert.deepEqual(ghost.log, [RUNEX, 'stop:0@120000', 'delete:CluedCIResidentCompanionWslImport@120000']);
  // ended fast (between two looks) with a failure code: an end, the code reported
  const fast = headlessPs(fakeScheduler(`if ($t -lt 400) { @{ state = 4; result = 267009; inst = @(,@(4, 7)) } } else { @{ state = 3; result = 3; inst = @() } }`) + importCall);
  assert.equal(fast.r, 3); assert.equal(fast.watch.startedAfterMs, null); assert.equal(fast.watch.endedAfterMs, 500);
});
