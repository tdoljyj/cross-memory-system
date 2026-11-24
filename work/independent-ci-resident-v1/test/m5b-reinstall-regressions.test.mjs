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

test('M5-b already-registered retry succeeds only after the real runnable probe and matching registration [needs:non-elevated]', { skip: !windows }, async t => {
  const { result, diagnostic: d, uidFile } = await execute(t, { probeExit: 0, extendedBase: true });
  assert.equal(result.status, 0); assert.equal(d.exitCode, 0);
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
