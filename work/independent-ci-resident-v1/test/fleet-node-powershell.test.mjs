// The universal node package's node side in CI, part 2 of 2: the offline checks of the two first-install PowerShell scripts
// (rollout/fleet/test/test-bootstrap.ps1, windows/test-first-install-host.ps1) and the step lines of bootstrap.ps1 and the launcher.
// Part 1, rollout/fleet/test in child nodes, is fleet-node-children.test.mjs; the two were one file, fleet-node.test.mjs, split so
// they run side by side (task 3435f8bf, block 2). They run here, in resident-node, which every change under this directory selects
// (ci-required-selection.mjs RESIDENT_AND_SOURCE). They need Windows (Windows PowerShell 5.1, Windows paths): on Linux this file is
// skipped by name.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FLEET_TESTS, POWERSHELL, RES, childEnv, skip, tail } from './fleet-node-fixtures.mjs';

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
// The host preparation's step lines end with at, the UTC time the step ended (Fable ruling 0e418483 section 4): checked, then compared
// without it. A verdict line (status) carries none.
const STEP_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}\+00:00$/;
function hostLine(line) {
  const o = JSON.parse(line);
  if ('status' in o) { assert.ok(!('at' in o), line); return o; }
  assert.match(o.at, STEP_AT, line);
  const { at, ...rest } = o;
  return rest;
}
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
  const parsed = steps.lines.map(hostLine);
  const ats = steps.lines.map(l => Date.parse(JSON.parse(l).at));
  assert.ok(ats.every((t, i) => Number.isFinite(t) && (i === 0 || t >= ats[i - 1])), `step times in order: ${steps.out}`);
  const ok = (name, detail) => ({ name, result: 'ok', rejectCode: null, detail });
  assert.deepEqual(parsed.slice(0, 3), [ok('residue', 'none'), ok('stage', 'C:\\Windows\\Temp\\clued-p1-0123'), ok('residue', ['SERVICE:A', 'SERVICE:B'])], steps.out);
  assert.match(parsed[3].detail, /DirectoryInfo/, steps.out);

  const refused = hostScriptLines(`Enter-Step 'stage'\nStop-Host 'INPUT_MISSING' ([ordered]@{ path = (Join-Path 'C:\\drill\\from' 'x.tar'); found = @(Split-Path -Parent 'C:\\a\\b') })`);
  assert.equal(refused.status, 1, refused.out);
  assert.deepEqual(JSON.parse(refused.lines.at(-1)),
    { status: 'FIRST_INSTALL_HOST_REFUSED', code: 'INPUT_MISSING', detail: { path: 'C:\\drill\\from\\x.tar', found: ['C:\\a'] } }, refused.out);
  // the step it ended, in the step-line shape, just before the verdict
  assert.deepEqual(hostLine(refused.lines.at(-2)),
    { name: 'stage', result: 'failed', rejectCode: 'INPUT_MISSING', detail: null }, refused.out);   // the detail only once: in the verdict

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
  // "heartbeat token and restart code" 2: the restart verdict says which install step asked for it and the installer's own exit code
  const restart = entry(`Enter-Step 'tools'; Exit-Restart 'gh installed' @([ordered]@{ installer = 'msiexec /i gh_2.103.3_windows_amd64.msi'; exit = 3010 })`);
  assert.equal(restart.status, 3, restart.out);
  assert.deepEqual(restart.lines.slice(-2).map(hostLine), [{ name: 'tools', result: 'failed', rejectCode: 'RESTART_THEN_RUN_THE_SAME_COMMAND', detail: null },
    { status: 'RESTART_THEN_RUN_THE_SAME_COMMAND', why: 'gh installed', step: 'tools', installers: [{ installer: 'msiexec /i gh_2.103.3_windows_amd64.msi', exit: 3010 }] }], restart.out);
  const hostText = fs.readFileSync(path.join(RES, 'windows', 'first-install-host.ps1'), 'utf8');
  const restarts = [...hostText.slice(hostText.indexOf('function Invoke-HostPreparation')).matchAll(/Exit-Restart [^\r\n]*/g)].map(m => m[0]);
  assert.equal(restarts.length, 3, restarts.join('\n'));
  for (const r of restarts) assert.match(r, /Exit-Restart '[^']*'.* @\(|Exit-Restart \([^)]*\) @\(|Exit-Restart '[^']*' \$restarts/, `every restart names its installer and exit: ${r}`);
  // a step that ends, then a refusal in the next: one ok line, one failed line, the verdict
  const two = entry(`Enter-Step 'v1-base'; Step 'v1-base' 'present'; Enter-Step 'wsl'; Stop-Host 'WSL_MSI_FAILED' ([ordered]@{ exit = 1603; stderr = '' })`);
  assert.equal(two.status, 1, two.out);
  assert.deepEqual(two.lines.map(hostLine), [{ name: 'v1-base', result: 'ok', rejectCode: null, detail: 'present' },
    { name: 'wsl', result: 'failed', rejectCode: 'WSL_MSI_FAILED', detail: null },
    { status: 'FIRST_INSTALL_HOST_REFUSED', code: 'WSL_MSI_FAILED', detail: { exit: 1603, stderr: '' } }], two.out);
  const other = entry(`Enter-Step 'linux'; throw 'something else said OUTPUT_NOT_PLAIN_DATA:$.x:System.Object'`);
  assert.notEqual(other.status, 0, other.out);
  assert.ok(!other.lines.some(l => l.includes('HOST_OUTPUT_NOT_PLAIN_DATA')), other.out);
  assert.match(other.out, /something else said/);
  const failed = hostLine(other.lines.at(-1));
  assert.deepEqual(failed, { name: 'linux', result: 'failed', rejectCode: null, detail: null }, other.out);

  // the READY verdict's shape: facts is Join-Path's output
  const ready = hostScriptLines(`ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = (Join-Path $FirstDir 'facts.json'); node = 'desk-w-591' })`);
  assert.equal(ready.status, 0, ready.out);
  assert.deepEqual(JSON.parse(ready.lines.at(-1)),
    { status: 'FIRST_INSTALL_HOST_READY', facts: 'C:\\ProgramData\\CluedIndependentCI\\first-install\\facts.json', node: 'desk-w-591' }, ready.out);
});

// The step lines of the three stages of a first install have one shape (Fable ruling 11-19 renew-key, 2.3): {name, result: ok|failed,
// rejectCode, detail}. The host preparation's are checked above; here rollout/fleet/bootstrap.ps1 (the entry) and the launcher template,
// each under Windows PowerShell 5.1 with its real functions.
function psLines(command) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${command}`, 'utf16le').toString('base64')],
    { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 24, windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  return { status: r.status, lines: String(r.stdout ?? '').split(/\r?\n/).filter(l => l.trim()), out: `${tail(r.stdout)}\n${tail(r.stderr, 3000)}` };
}
test('bootstrap.ps1 and the launcher print their step lines in the host preparation\'s shape', { skip, timeout: 900_000 }, () => {
  const BOOT = path.join(RES, 'rollout', 'fleet', 'bootstrap.ps1');
  const entry = psLines(`. ${psLiteral(BOOT)}\nOut-Step 'assets' 'ok' $null @('SHA256SUMS')\nStop-Bootstrap 'prereq' 'PREREQ_NOT_PINNED' @('PREREQ_NOT_PINNED:git')`);
  assert.equal(entry.status, 1, entry.out);
  const [okLine, failedLine, verdict] = entry.lines.map(l => JSON.parse(l));
  assert.deepEqual(okLine, { name: 'assets', result: 'ok', rejectCode: null, detail: ['SHA256SUMS'] }, entry.out);
  assert.deepEqual(failedLine, { name: 'prereq', result: 'failed', rejectCode: 'PREREQ_NOT_PINNED', detail: null }, entry.out);
  assert.deepEqual([verdict.status, verdict.step, verdict.code], ['BOOTSTRAP_REFUSED', 'prereq', 'PREREQ_NOT_PINNED'], entry.out);
  // every step the entry can refuse also prints its ok line when it ends
  const text = fs.readFileSync(BOOT, 'utf8');
  const main = text.slice(text.indexOf('function Invoke-Bootstrap'));
  const refused = [...new Set([...main.matchAll(/Stop-Bootstrap '([a-z-]+)'/g)].map(m => m[1]))];
  assert.ok(refused.length >= 7, refused.join(','));
  // the launcher's step line is printed by Out-LauncherVerdict, with the launcher's own code (Fable ruling 11-20 "first install r4" 5(a))
  assert.match(text, /function Out-LauncherVerdict\(\$v, \$extra\) \{\n[^]*?Out-Step 'launcher' \$\(if \(\$done\)/);
  for (const s of refused) if (s === 'launcher') assert.match(main, /\n\s*Out-LauncherVerdict \$v /, 'bootstrap step launcher prints its line when it ends'); else assert.match(main, new RegExp(`Out-Step '${s}' (?:'ok'|\\$\\(if)`), `bootstrap step ${s} prints its line when it ends`);

  const TPL = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
  const launcher = psLines(`$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
$f = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq 'Write-StepLine' }, $true))
. ([scriptblock]::Create($f[0].Extent.Text))
$r = & { Write-StepLine 'install' 'ok' $null $null; 'the function value' }
Write-StepLine 'launcher' 'failed' 'INSTALL_NOT_COMPLETED' ([ordered]@{ exit = 1 })
'returned: ' + (@($r) -join '|')`);
  assert.equal(launcher.status, 0, launcher.out);
  assert.deepEqual(launcher.lines.slice(0, 2).map(l => JSON.parse(l)), [{ name: 'install', result: 'ok', rejectCode: null, detail: null },
    { name: 'launcher', result: 'failed', rejectCode: 'INSTALL_NOT_COMPLETED', detail: { exit: 1 } }], launcher.out);
  assert.equal(launcher.lines.at(-1), 'returned: the function value', 'a step line never becomes part of a function\'s value');
  const tpl = fs.readFileSync(TPL, 'utf8');
  assert.match(tpl, /\$Done\.add_CollectionChanged\(\{[\s\S]{0,1200}name = \[string\]\$step; result = \$lineResult; rejectCode = \$lineReject; detail = \$lineDetail/, 'every completed launcher step prints its line (failed with its reject code when the step left one: test/launcher-verify-not-passed.test.mjs)');
  assert.match(tpl, /function Stop-Launch\(\[string\]\$code, \$detail\) \{\r?\n  if \(Test-Path -LiteralPath 'function:Write-StepLine'\) \{ Write-StepLine 'launcher' 'failed' \$code \$null \}/, 'a stop prints its line first (its detail is the terminal\'s)');
});
