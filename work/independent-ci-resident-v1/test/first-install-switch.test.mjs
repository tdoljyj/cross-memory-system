// A first install goes from the verified, confirmed pause straight to the companion account switch (Fable ruling 11-19 renew-key,
// "补：对路八处" 3). The install registers the companion's first task with the companion account's interactive token, which an account
// that never logs on cannot run: Step-StartCompanion reports not started, and the switch (which replaces that task and qualifies the
// companion in session 0 itself) never ran: BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE. A reinstall is unchanged. The launcher
// template's own assignments, run under Windows PowerShell 5.1 with the two steps replaced by counters.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
const CONT = path.join(RES, 'reinstall', 'launcher', 'continue-install.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

function run({ firstInstall, verified = true, paused = true, maintenance = false, afterInstall = false }) {
  const command = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
$FleetFirstInstall = ${firstInstall ? '$true' : '$null'}; $CompanionMaintenance = ${maintenance ? '$true' : '$false'}
$verify = @{ status = ${verified ? "'RESIDENT_VERIFIED'" : "'R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED'"} }; $pause = @{ confirmed = ${paused ? '$true' : '$false'} }
$afterInstall = ${afterInstall ? '$true' : '$false'}
$script:starts = 0; $script:switches = 0
$script:steps = @()
$fn = { param($name) @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))[0] }
. ([scriptblock]::Create((& $fn 'Get-Key').Extent.Text))
# the real Step-StartCompanion's first statement (a first install steps aside there, as every old-resident step does), then a counter
# for the interactive start it would make
$first = (& $fn 'Step-StartCompanion').Body.EndBlock.Statements[0].Extent.Text
. ([scriptblock]::Create('function Step-StartCompanion { ' + $first + "\`n" + '$script:starts++; $script:steps += ''start''; @{ started = $afterInstall } }'))
function Step-CompanionHeadless { $script:switches++; $script:steps += 'switch'; @{ ran = $true } }
$statements = @()
if ($afterInstall) {
  $cont = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(CONT)}, [ref]$tokens, [ref]$errors)
  $helper = @($cont.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Step-ContinueAfterInstall' }, $true))
  if ($helper.Count -ne 1) { throw 'CONTINUATION_NOT_UNIQUE' }
  $early = $helper[0].Find({ param($n) $n -is [Management.Automation.Language.CommandAst] -and
    $n.GetCommandName() -cin @('Step-StartCompanion', 'Start-CompanionTask', 'Step-CompanionHeadless') }, $true)
  if ($early) { throw 'CONTINUATION_TOUCHES_COMPANION_BEFORE_CONNECTION_CHECK' }
  $gate = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and
    $n.GetCommandName() -ceq 'Confirm-FleetCiAfterInstall' }, $true))
  if ($gate.Count -ne 1) { throw 'CONNECTION_CHECK_NOT_UNIQUE' }
  $statement = $gate[0].Parent.Parent.Parent
  if ($statement -isnot [Management.Automation.Language.IfStatementAst]) { throw 'CONNECTION_CHECK_NOT_GUARDED' }
  $statements += $statement
  $install = @{ receiptSha256 = 'receipt-digest' }
  $pause.requestSha256 = 'pause-digest'
}
function Confirm-FleetCiAfterInstall($receipt, $pauseDigest) {
  if ($receipt -cne 'receipt-digest' -or $pauseDigest -cne 'pause-digest') { throw 'CONNECTION_CHECK_INPUTS_CHANGED' }
  $script:steps += 'connection'
}
foreach ($name in @('maintenanceDeferred', 'companion', 'companionHeadless')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq ('$' + $name) }, $true))
  if ($nodes.Count -ne 1) { throw ('ASSIGNMENT_NOT_UNIQUE:' + $name + ':' + $nodes.Count) }
  $statements += $nodes[0]
}
foreach ($statement in ($statements | Sort-Object { $_.Extent.StartOffset })) {
  . ([scriptblock]::Create($statement.Extent.Text))
}
$result = @{ starts = $script:starts; switches = $script:switches }
if ($afterInstall) { $result.steps = $script:steps }
ConvertTo-Json -InputObject $result -Compress`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}

test('a first install: verified and paused, the switch runs without the interactive companion start', { skip, timeout: 300_000 }, () => {
  assert.deepEqual(run({ firstInstall: true }), { starts: 0, switches: 1 });
});
test('a first install not verified or not paused: neither the start nor the switch', { skip, timeout: 300_000 }, () => {
  assert.deepEqual(run({ firstInstall: true, paused: false }), { starts: 0, switches: 0 });
  assert.deepEqual(run({ firstInstall: true, verified: false }), { starts: 0, switches: 0 });
});
test('a reinstall is unchanged: the companion is started first, and a start that failed keeps the switch from running', { skip, timeout: 300_000 }, () => {
  assert.deepEqual(run({ firstInstall: false }), { starts: 1, switches: 0 });
  assert.deepEqual(run({ firstInstall: false, paused: false }), { starts: 0, switches: 0 });
});

// continue.py keeps the connection gate and companion steps in the generated launcher's main flow.
test('the continuation after the install: a first install does not start the companion first; a reinstall does', { skip, timeout: 300_000 }, () => {
  assert.deepEqual(run({ firstInstall: true, afterInstall: true }), { starts: 0, switches: 1, steps: ['connection', 'switch'] });
  assert.deepEqual(run({ firstInstall: false, afterInstall: true }), { starts: 1, switches: 1, steps: ['connection', 'start', 'switch'] });
});

// "包分支两处" A: the first-train wait is not changed; its step line carries when it started and ended and what the new resident's status
// showed meanwhile (executor state and reason, train, node mode and role probe, queue), each change once, so the next drill says what it
// waited for. The real Step-WaitFirstTrain and the progress handler of the template, over a status file in a scratch root.
import fs from 'node:fs';
import os from 'node:os';
function waitFirstTrain(t, status, waitSeconds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-train-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state', 'status.json'), JSON.stringify(status));
  const command = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
foreach ($f in @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
    ($n.Name -cin @('Read-StatusBytes', 'Get-Key', 'Parse-Json', 'Wait-Until', 'Write-StepStart', 'Step-WaitFirstTrain') -or $n.Name -cmatch '^(Test|Get)-FirstTrain') }, $false))) {
  . ([scriptblock]::Create($f.Extent.Text))
}
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$LaunchClock = [Diagnostics.Stopwatch]::StartNew()
$ResidentRoot = ${psLiteral(root)}; $FirstTrainWaitSeconds = ${waitSeconds}; $RunnerQuietWaitSeconds = 30; $NodeName = 'clued-drill'; $CiSourceManifestSha256 = ('a' * 64)
function Get-RunnerState { [ordered]@{ flags = [ordered]@{ originalBinary = $true; stoppedPid0 = $true } } }
function Write-Json([string]$name, $obj) { }
$Progress = @{ out = $null; elevated = $null; count = 0; pins = $null }
$Done = New-Object Collections.ObjectModel.ObservableCollection[string]
foreach ($s in @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('$Done.add_CollectionChanged(') })) { . ([scriptblock]::Create($s.Extent.Text)) }
$null = Step-WaitFirstTrain`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = String(r.stdout).trim().split(/\r?\n/);
  return { line: JSON.parse(lines.at(-1)), lines, stdout: r.stdout };
}
const fixtureStatus = (patch = {}) => {
  const now = new Date().toISOString();
  return { contract: 'clued.independent-ci.resident-status/8', writtenAt: now, executor: { state: 'IDLE', reason: null },
    train: { enabled: 'on', last: null }, halt: null, node: { name: 'clued-drill', source: 'abcdefabcdef', mode: 'UNCERTAIN', probe: { at: now, result: 'uncertain', failures: 1, failingSince: null } },
    queue: { generation: 'abcdefabcdef', live: 0 }, current: null, pending: [], notices: [], ...patch };
};
test('the first-train wait prints its start, end and the role probe and train it observed', { skip, timeout: 300_000 }, (t) => {
  const status = fixtureStatus();
  const { line, stdout } = waitFirstTrain(t, status, 3);
  const r = { stdout };
  assert.deepEqual([line.name, line.result, line.rejectCode], ['first-train-not-observed', 'ok', null], r.stdout);
  const d = line.detail;
  assert.ok(d && /Z$/.test(d.startedAt) && /Z$/.test(d.endedAt) && /Z$/.test(d.phase1EndedAt) && d.startedAt <= d.phase1EndedAt && d.phase1EndedAt <= d.endedAt, r.stdout);
  assert.equal(d.runnerQuiet, true, r.stdout);
  assert.equal(d.observations.length, 1, 'an unchanged status is one observation');
  assert.deepEqual({ ...d.observations[0], at: undefined }, { at: undefined, state: 'IDLE', reason: null, trainEnabled: 'on', trainLast: null, halt: false, mode: 'UNCERTAIN',
    probeAt: status.node.probe.at, probeResult: 'uncertain', probeFailures: 1, live: 0 }, r.stdout);
  // FABLE-drill-role-probe-20261124 3.2: a plain uncertain answer at the end of the wait is no confirmed role
  assert.equal(d.role, 'unconfirmed', r.stdout);
});

// FABLE-drill-role-probe-20261124 3.2 / PR-1: the service refused this node's token (the role-probe-connection notice, executor.mjs
// report). Before the fix the wait ran its whole phase 1 for it (the drill of 20261123T201433Z: 1505 s) and ended first-train-not-observed,
// ok. Now the poll that sees the refusal ends phase 1, and the step line says failed with the refusal's code. 3.3: the step's start is a line
// of its own before it. The notice and the probe are placed 20 s ahead so that they are not older than the step's own start.
test('a refused token ends the first-train wait at once, as a failed step that names the refusal', { skip, timeout: 300_000 }, (t) => {
  const ahead = new Date(Date.now() + 20_000).toISOString();
  const status = fixtureStatus({ writtenAt: ahead, notices: [{ key: `role-probe-connection:${Date.parse(ahead)}`, kind: 'role-probe-connection', pr: null, headSha: null,
    code: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED', at: ahead, until: null }] });
  status.node.source = 'a'.repeat(12);   // the harness's $CiSourceManifestSha256 (this node's Source), as the refusal is held to it
  status.node.probe.at = ahead; status.node.probe.failingSince = ahead;
  const { line, lines, stdout } = waitFirstTrain(t, status, 60);
  assert.deepEqual([line.name, line.result, line.rejectCode], ['first-train-role-unauthorized', 'failed', 'ROLE_PROBE_CONNECTION_UNAUTHORIZED'], stdout);
  const d = line.detail;
  assert.equal(d.role, 'unauthorized', stdout);
  assert.ok(Date.parse(d.phase1EndedAt) - Date.parse(d.startedAt) < 20_000, `phase 1 ended on the first poll, not after its 60 s: ${stdout}`);
  assert.equal(d.runnerQuiet, true, 'the runner-quiet phase still ran');
  const started = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && o.started === 'Step-WaitFirstTrain');
  assert.equal(started.length, 1, stdout);
  assert.ok(/Z$|[+-]\d\d:\d\d$/.test(started[0].at) && Number.isInteger(started[0].ms), stdout);
  assert.ok(!('name' in started[0]) && !('result' in started[0]), 'a start line is no step line (the drill counts name+result lines as steps)');
});

// PLAN-launcher-role-review-m1m2-20261124 1 (review M-1): the notice is held to the run of failures it belongs to (the same status's
// probe.failingSince), not to the step's start. The executor sends it once per run of failures, at the first refusal, which can come before
// the launcher's step started (drill 16: the first probe only 12 s after it). Before the fix such a notice never counted: phase 1 waited
// its whole length and ended first-train-not-observed, role unconfirmed. The probe must still have answered since the step started.
test('a refusal noticed before the step started, in the current run of failures, still ends the wait at once', { skip, timeout: 300_000 }, (t) => {
  const ahead = new Date(Date.now() + 20_000).toISOString();
  const before = new Date(Date.now() - 30_000).toISOString();   // before the step's start (the step starts after this status is written)
  const status = fixtureStatus({ writtenAt: ahead, notices: [{ key: `role-probe-connection:${Date.parse(before)}`, kind: 'role-probe-connection', pr: null, headSha: null,
    code: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED', at: before, until: null }] });
  status.node.source = 'a'.repeat(12);
  status.node.probe = { at: ahead, result: 'uncertain', failures: 2, failingSince: before };
  const { line, stdout } = waitFirstTrain(t, status, 60);
  assert.deepEqual([line.name, line.result, line.rejectCode], ['first-train-role-unauthorized', 'failed', 'ROLE_PROBE_CONNECTION_UNAUTHORIZED'], stdout);
  const d = line.detail;
  assert.equal(d.role, 'unauthorized', stdout);
  assert.ok(Date.parse(d.phase1EndedAt) - Date.parse(d.startedAt) < 20_000, `phase 1 ended on the first poll, not after its 60 s: ${stdout}`);
  assert.equal(d.runnerQuiet, true, 'the runner-quiet phase still ran');
});

// The counter-cases (review M1 still holds; green before and after the fix): none of them ends phase 1 early.
test('a refusal of an earlier run of failures, a probe older than the step, no failingSince or another code keeps the wait', { skip, timeout: 300_000 }, (t) => {
  const ahead = new Date(Date.now() + 20_000).toISOString();
  const ago = s => new Date(Date.now() - s * 1000).toISOString();
  const refused = (noticeAt, probe, code = 'ROLE_PROBE_CONNECTION_UNAUTHORIZED') => {
    const status = fixtureStatus({ writtenAt: ahead, notices: [{ key: `role-probe-connection:${Date.parse(noticeAt)}`, kind: 'role-probe-connection', pr: null, headSha: null,
      code, at: noticeAt, until: null }] });
    status.node.source = 'a'.repeat(12);
    status.node.probe = { at: ahead, result: 'uncertain', failures: 2, failingSince: ago(30), ...probe };
    return status;
  };
  const cases = {
    // the notice of an earlier run of failures (a held or not-held answer since cleared failingSince; this run started later)
    'notice-before-failing-since': refused(ago(120), { failingSince: ago(30) }),
    'probe-before-step': refused(ago(30), { at: ago(10) }),
    'failing-since-null': refused(ago(30), { failingSince: null }),
    'failing-since-not-a-time': refused(ago(30), { failingSince: 'yesterday' }),
    'another-code': refused(ago(30), {}, 'ROLE_PROBE_UNCERTAIN'),
  };
  for (const [name, status] of Object.entries(cases)) {
    const { line, stdout } = waitFirstTrain(t, status, 3);
    assert.deepEqual([name, line.name, line.result, line.rejectCode, line.detail.role], [name, 'first-train-not-observed', 'ok', null, 'unconfirmed'], stdout);
  }
});

// PR-1, the place that decides FIRST_INSTALL_DONE (rollout/fleet/bootstrap.ps1 Get-LauncherVerdict, which the drill's entry turns into
// FIRST_INSTALL_DONE or its stop code): a first install whose launcher did not confirm the node's role (held or not-held) is not done.
// Before the fix every verified, paused and switched first install was BOOTSTRAP_DONE whatever the role.
const BOOTSTRAP = path.join(RES, 'rollout', 'fleet', 'bootstrap.ps1');
const ENTRY = path.join(RES, 'drill', 'first-install-entry.ps1');
test('a first install is done only with a confirmed role; a refused or unconfirmed one stops with its own code', { skip, timeout: 300_000 }, () => {
  const command = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
$load = { param($file, [string[]]$names)
  $tokens = $null; $errors = $null; $a = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  foreach ($name in $names) { . ([scriptblock]::Create(@($a.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))[0].Extent.Text)) }
  foreach ($name in $names) { Set-Item -Path ('function:global:' + $name) -Value (Get-Item -LiteralPath ('function:' + $name)).ScriptBlock } }
& $load ${psLiteral(BOOTSTRAP)} @('Get-Key', 'Get-LauncherVerdict')
& $load ${psLiteral(ENTRY)} @('Get-EntryProperty', 'ConvertTo-FirstInstallEntryResult')
$out = @()
$Q = 'COMPANION_HEADLESS_QUALIFIED'; $F = 'COMPANION_HEADLESS_FELL_BACK'
foreach ($c in @(@($true, 'unauthorized', $Q), @($true, 'unconfirmed', $Q), @($true, $null, $Q), @($true, 'not-held', $Q), @($true, 'held', $Q), @($false, 'unauthorized', $Q), @($false, $null, $Q),
    @($true, 'unauthorized', $F), @($true, 'unconfirmed', $F), @($true, $null, $F), @($true, 'not-held', $F), @($false, 'unauthorized', $F))) {
  $term = [ordered]@{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED'; companionHeadless = [ordered]@{ ran = $true; status = $c[2] } }
  if ($null -ne $c[1]) { $term['role'] = $c[1] }
  $v = Get-LauncherVerdict $c[0] $term
  $e = ConvertTo-FirstInstallEntryResult $v $(if ($v.status -ceq 'BOOTSTRAP_DONE') { 0 } else { 1 }) 'C:\t' 'C:\n.exe'
  $out += ,([ordered]@{ first = $c[0]; role = $c[1]; sw = $c[2]; status = $v.status; code = (Get-Key $v 'code'); entry = $e.status; stopCode = $e.stopCode; companionSwitch = $v.companionSwitch })
}
ConvertTo-Json -InputObject $out -Compress`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const got = JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1)).map(x => [x.first, x.role, x.sw, x.status, x.code, x.entry, x.stopCode, x.companionSwitch]);
  const Q = 'COMPANION_HEADLESS_QUALIFIED', F = 'COMPANION_HEADLESS_FELL_BACK';
  assert.deepEqual(got, [
    [true, 'unauthorized', Q, 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED', 'FIRST_INSTALL_ROLE_UNAUTHORIZED', 'FIRST_INSTALL_STOPPED', 'FIRST_INSTALL_ROLE_UNAUTHORIZED', Q],
    [true, 'unconfirmed', Q, 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', 'FIRST_INSTALL_STOPPED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', Q],
    [true, null, Q, 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', 'FIRST_INSTALL_STOPPED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', Q],
    [true, 'not-held', Q, 'BOOTSTRAP_DONE', null, 'FIRST_INSTALL_DONE', null, Q],
    [true, 'held', Q, 'BOOTSTRAP_DONE', null, 'FIRST_INSTALL_DONE', null, Q],
    // a reinstall's verdict is as before
    [false, 'unauthorized', Q, 'BOOTSTRAP_DONE', null, 'FIRST_INSTALL_DONE', null, Q],
    [false, null, Q, 'BOOTSTRAP_DONE', null, 'FIRST_INSTALL_DONE', null, Q],
    // PLAN-launcher-role-review-m1m2-20261124 2 (review M-2): the role is judged before the companion switch, so a refused or unconfirmed
    // role is the stop code even when the switch did not pass too; the switch's status stays in companionSwitch. Before the fix these three
    // were BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE and the refusal appeared in no verdict.
    [true, 'unauthorized', F, 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED', 'FIRST_INSTALL_ROLE_UNAUTHORIZED', 'FIRST_INSTALL_STOPPED', 'FIRST_INSTALL_ROLE_UNAUTHORIZED', F],
    [true, 'unconfirmed', F, 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', 'FIRST_INSTALL_STOPPED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', F],
    [true, null, F, 'BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', 'FIRST_INSTALL_STOPPED', 'FIRST_INSTALL_ROLE_UNCONFIRMED', F],
    // a confirmed role with the switch not passed is the switch's, as before; a reinstall is unchanged
    [true, 'not-held', F, 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE', F, 'FIRST_INSTALL_STOPPED', F, F],
    [false, 'unauthorized', F, 'BOOTSTRAP_DONE', null, 'FIRST_INSTALL_DONE', null, F],
  ], r.stdout);
});

// PR-1: the launcher's terminal carries the first-train wait's role (unauthorized, unconfirmed, not-held, held), the template's own
// terminal assignment evaluated with the step results in place.
test('the launcher terminal carries the role the first-train wait found', { skip, timeout: 300_000 }, () => {
  const command = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
$nodes = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$terminal' })
if ($nodes.Count -ne 1) { throw ('TERMINAL_ASSIGNMENT_NOT_ONE:' + $nodes.Count) }
$Done = @('install'); $verify = [ordered]@{ status = 'RESIDENT_VERIFIED' }; $pause = [ordered]@{ confirmed = $true }
$out = @()
foreach ($role in @('unauthorized', 'unconfirmed', 'not-held', 'held')) {
  $train = [ordered]@{ role = $role }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
  $out += ,([ordered]@{ status = $terminal.status; role = $terminal['role'] })
}
ConvertTo-Json -InputObject $out -Compress`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1)), ['unauthorized', 'unconfirmed', 'not-held', 'held'].map(role => ({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', role })), r.stdout);
});
