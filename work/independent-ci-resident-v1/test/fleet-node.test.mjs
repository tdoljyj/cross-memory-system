// The universal node package's node side in CI: rollout/fleet/test (prepare, the first install, publish, the tar reader) and the
// offline checks of the two first-install PowerShell scripts (rollout/fleet/test/test-bootstrap.ps1, windows/test-first-install-host.ps1).
// No CI suite ran any of them (the resident-fleet-node suite was taken out of the selector again in b596acbc: its selector source is
// pinned and re-pinning needs the whole registry chain). They run here, in resident-node, which every change under this directory
// selects (ci-required-selection.mjs RESIDENT_AND_SOURCE). They need Windows (Windows PowerShell 5.1, Windows paths): on Linux
// this file is skipped by name. Each fleet test file runs in a process of its own, as `node --test <dir>` would run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLEET_TESTS = path.join(RES, 'rollout', 'fleet', 'test');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows = process.platform === 'win32';
const skip = windows ? false : 'the node side of the universal package runs on the Windows host only';
const tail = (s, n = 6000) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''));
// a child of `node --test` must not think it reports to this runner
// and carries the test marker itself (Fable ruling 11-20 "补：止血 PR 第四轮" §4)
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; e.CLUED_UNDER_TEST = '1'; return e; };

// Every child carries the test marker itself (Fable "补：发布工具测试入套件"; ruling 11-20 "补：止血 PR 第四轮" §4), also when
// this file is started without the one entry.
test('the fleet children carry the test marker CLUED_UNDER_TEST=1 whatever this process has', () => {
  const saved = process.env.CLUED_UNDER_TEST;
  delete process.env.CLUED_UNDER_TEST;
  try {
    assert.equal(childEnv().CLUED_UNDER_TEST, '1');
  } finally {
    if (saved !== undefined) process.env.CLUED_UNDER_TEST = saved;
  }
});

const files = windows ? fs.readdirSync(FLEET_TESTS).filter(n => n.endsWith('.test.mjs')).sort() : [];
test('rollout/fleet/test holds the fleet tests this file runs', { skip }, () => {
  assert.ok(files.includes('first-install.test.mjs') && files.includes('install.test.mjs'), files.join(','));
});
for (const name of files) {
  test(`rollout/fleet/test/${name}`, { skip, timeout: 3_600_000 }, () => {
    const r = spawnSync(process.execPath, ['--test', path.join(FLEET_TESTS, name)], { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, timeout: 3_500_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, `${name} failed:\n${tail(r.stdout)}\n${tail(r.stderr, 2000)}`);
  });
}

const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
function powershellFile(script, extra = [], prelude = '') {
  const args = extra.map(arg => /^-[A-Za-z]+$/.test(arg) ? arg : psLiteral(arg));
  const command = `${prelude}\n& ${psLiteral(script)} ${args.join(' ')}
$testExit = $LASTEXITCODE
if ($global:HostProbeCalls.Count) { throw ('PURE_TEST_READ_HOST: ' + ($global:HostProbeCalls -join ', ')) }
exit $testExit`;
  const invocation = prelude
    ? ['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
    : ['-File', script, ...extra];
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...invocation],
    { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: 900_000 });
  assert.ifError(r.error);
  const last = String(r.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  let verdict = null;
  try { verdict = JSON.parse(last); } catch { verdict = null; }
  return { status: r.status, verdict, out: `${tail(r.stdout)}\n${tail(r.stderr, 3000)}` };
}

test('rollout/fleet/test/test-bootstrap.ps1: the bootstrap\'s offline checks pass', { skip, timeout: 900_000 }, () => {
  const r = powershellFile(path.join(FLEET_TESTS, 'test-bootstrap.ps1'));
  assert.equal(r.status, 0, r.out);
  assert.equal(r.verdict?.status, 'BOOTSTRAP_PURE_TESTS_PASSED', r.out);
});

// Model both kinds of runner without inspecting or changing the actual host. An installed service's SID and root ACE exist
// even if sc returns no usable SID (the failure seen on company-win-01). Every attempted probe is recorded and fails the test.
const residentSid = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';
for (const host of ['clean', 'resident-installed', 'resident-installed-sc-unavailable']) {
  test(`windows/test-first-install-host.ps1: offline checks ignore ${host}, none skipped`, { skip, timeout: 900_000 }, t => {
    const installed = host !== 'clean';
    const sddl = 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' + (installed ? `(A;;0x120080;;;${residentSid})` : '');
    const scOutput = host.endsWith('sc-unavailable') ? '[SC] OpenSCManager FAILED 5: Access is denied.'
      : `NAME: CluedCIResident\nSERVICE SID: ${residentSid}`;
    const prelude = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:HostProbeCalls = New-Object Collections.Generic.List[string]
function global:Invoke-FixtureSc { $global:HostProbeCalls.Add('sc.exe'); ${psLiteral(scOutput)} }
Set-Alias -Name 'C:\\Windows\\System32\\sc.exe' -Value Invoke-FixtureSc -Scope Global
Set-Alias -Name sc.exe -Value Invoke-FixtureSc -Scope Global
if ((Get-Command 'C:\\Windows\\System32\\sc.exe').CommandType -ne 'Alias') { throw 'SC_FIXTURE_NOT_INSTALLED' }
function global:Get-Acl {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Path)
  $global:HostProbeCalls.Add('Get-Acl'); [pscustomobject]@{ Sddl = ${psLiteral(sddl)} }
}
function global:Get-Service {
  [CmdletBinding()] param([string[]]$Name)
  $global:HostProbeCalls.Add('Get-Service')
  ${installed ? `[pscustomobject]@{ Name = 'CluedCIResident'; Status = 'Running'; Sid = '${residentSid}' }` : ''}
}`;
    const r = powershellFile(path.join(RES, 'windows', 'test-first-install-host.ps1'), ['-Node', process.execPath], prelude);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.verdict?.status, 'FIRST_INSTALL_HOST_PURE_TESTS_PASSED', r.out);
    assert.equal(r.verdict?.skipped, null, r.out);
    t.diagnostic(JSON.stringify({ host, ...r.verdict, hostProbeCalls: 0 }));
  });
}

// The real windows/first-install-host.ps1 under Windows PowerShell 5.1 (drill 3bc571a6 A1; Fable ruling 11-19 section 2.1): dot-sourced
// (definitions only: its main runs only when the file is invoked), its progress and refusal lines are printed from the values P1 really
// has, cmdlet output (Join-Path, Where-Object, Split-Path), which 5.1 hands over in a PSObject shell. Before the one JSON writer the
// guest stopped at `Step 'stage' $stage` with a PSParameterizedProperty circular reference, and so does this test.
function hostScriptLines(body) {
  const command = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n. ${psLiteral(path.join(RES, 'windows', 'first-install-host.ps1'))}\n${body}`;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 24, windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  return { status: r.status, lines: String(r.stdout ?? '').split(/\r?\n/).filter(l => l.trim()), out: `${tail(r.stdout)}\n${tail(r.stderr, 3000)}` };
}

test('windows/first-install-host.ps1 under Windows PowerShell 5.1: its lines carry cmdlet output', { skip, timeout: 900_000 }, () => {
  const steps = hostScriptLines(`
$stage = Join-Path 'C:\\Windows\\Temp' ('clued-p1-' + '0123')
Step 'residue' 'none'
Step 'stage' $stage
Step 'residue' (@('SERVICE:A', 'SERVICE:B') | Where-Object { $_ })
Step 'odd' (Get-Item -LiteralPath $env:SystemRoot)`);
  assert.equal(steps.status, 0, steps.out);
  const parsed = steps.lines.map(l => JSON.parse(l));
  assert.deepEqual(parsed.slice(0, 3), [{ step: 'residue', result: 'none' }, { step: 'stage', result: 'C:\\Windows\\Temp\\clued-p1-0123' },
    { step: 'residue', result: ['SERVICE:A', 'SERVICE:B'] }], steps.out);
  assert.match(parsed[3].result, /DirectoryInfo/, steps.out);

  const refused = hostScriptLines(`Stop-Host 'INPUT_MISSING' ([ordered]@{ path = (Join-Path 'C:\\drill\\from' 'x.tar'); found = @(Split-Path -Parent 'C:\\a\\b') })`);
  assert.equal(refused.status, 1, refused.out);
  assert.deepEqual(JSON.parse(refused.lines.at(-1)),
    { status: 'FIRST_INSTALL_HOST_REFUSED', code: 'INPUT_MISSING', detail: { path: 'C:\\drill\\from\\x.tar', found: ['C:\\a'] } }, refused.out);

  // a refusal whose detail is not plain data is still one line and exit 1, refused by name with the code it was refusing
  const notPlain = hostScriptLines(`Stop-Host 'INPUT_MISSING' (Get-Item -LiteralPath $env:SystemRoot)`);
  assert.equal(notPlain.status, 1, notPlain.out);
  const v = JSON.parse(notPlain.lines.at(-1));
  assert.equal(v.status, 'FIRST_INSTALL_HOST_REFUSED', notPlain.out);
  assert.equal(v.code, 'HOST_OUTPUT_NOT_PLAIN_DATA', notPlain.out);
  assert.equal(v.detail.code, 'INPUT_MISSING', notPlain.out);

  // Invoke-Host, the script's entry (Codex review of PR-甲, suggestion 1): the real one around a stand-in Invoke-HostPreparation. A verdict
  // that is not plain data is refused by name (exit 1); READY stays exit 0 and RESTART exit 3; any other exception passes through, even one
  // whose text looks like the writer's.
  const entry = body => hostScriptLines(`function Invoke-HostPreparation { ${body} }\nInvoke-Host`);
  const odd = entry(`ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = (Get-Item -LiteralPath $env:SystemRoot) })`);
  assert.equal(odd.status, 1, odd.out);
  const ov = JSON.parse(odd.lines.at(-1));
  assert.deepEqual([ov.status, ov.code, ov.detail.at, ov.detail.type], ['FIRST_INSTALL_HOST_REFUSED', 'HOST_OUTPUT_NOT_PLAIN_DATA', '$.facts', 'System.IO.DirectoryInfo'], odd.out);
  const fine = entry(`ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = (Join-Path $FirstDir 'facts.json') })`);
  assert.equal(fine.status, 0, fine.out);
  assert.equal(JSON.parse(fine.lines.at(-1)).status, 'FIRST_INSTALL_HOST_READY', fine.out);
  const restart = entry(`ConvertTo-JsonLine ([ordered]@{ status = 'RESTART_THEN_RUN_THE_SAME_COMMAND'; why = 'WSL installed' }); exit 3`);
  assert.equal(restart.status, 3, restart.out);
  const other = entry(`throw 'something else said OUTPUT_NOT_PLAIN_DATA:$.x:System.Object'`);
  assert.notEqual(other.status, 0, other.out);
  assert.ok(!other.lines.some(l => l.includes('HOST_OUTPUT_NOT_PLAIN_DATA')), other.out);
  assert.match(other.out, /something else said/);

  // the READY verdict's shape: facts is Join-Path's output
  const ready = hostScriptLines(`ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = (Join-Path $FirstDir 'facts.json'); node = 'desk-w-591' })`);
  assert.equal(ready.status, 0, ready.out);
  assert.deepEqual(JSON.parse(ready.lines.at(-1)),
    { status: 'FIRST_INSTALL_HOST_READY', facts: 'C:\\ProgramData\\CluedIndependentCI\\first-install\\facts.json', node: 'desk-w-591' }, ready.out);
});
