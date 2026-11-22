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
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

function run({ firstInstall, verified = true, paused = true, maintenance = false }) {
  const command = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
$FleetFirstInstall = ${firstInstall ? '$true' : '$null'}; $CompanionMaintenance = ${maintenance ? '$true' : '$false'}
$verify = @{ status = ${verified ? "'RESIDENT_VERIFIED'" : "'R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED'"} }; $pause = @{ confirmed = ${paused ? '$true' : '$false'} }
$script:starts = 0; $script:switches = 0
$fn = { param($name) @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))[0] }
. ([scriptblock]::Create((& $fn 'Get-Key').Extent.Text))
# the real Step-StartCompanion's first statement (a first install steps aside there, as every old-resident step does), then a counter
# for the interactive start it would make
$first = (& $fn 'Step-StartCompanion').Body.EndBlock.Statements[0].Extent.Text
. ([scriptblock]::Create('function Step-StartCompanion { ' + $first + "\`n" + '$script:starts++; @{ started = $false; error = ''interactive token: the account is not logged on'' } }'))
function Step-CompanionHeadless { $script:switches++; @{ ran = $true } }
foreach ($name in @('maintenanceDeferred', 'companion', 'companionHeadless')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq ('$' + $name) }, $true))
  if ($nodes.Count -ne 1) { throw ('ASSIGNMENT_NOT_UNIQUE:' + $name + ':' + $nodes.Count) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
'{"starts":' + $script:starts + ',"switches":' + $script:switches + '}'`;
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

// The continuation of a launch cut off after the install (continue-install.ps1 Step-ContinueAfterInstall) follows the same rule: under
// the first-install plan it does not start the interactive companion task before the switch (Fable ruling 11-19, "包分支两处").
const CONT = path.join(RES, 'reinstall', 'launcher', 'continue-install.ps1');
function cont(firstInstall) {
  const command = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(CONT)}, [ref]$tokens, [ref]$errors)
$fn = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Step-ContinueAfterInstall' }, $true))[0]
$ifs = @($fn.FindAll({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -ceq '$from -gt 3' }, $true))
if ($ifs.Count -ne 1) { throw ('COMPANION_LINE_NOT_ONE:' + $ifs.Count) }
$FleetFirstInstall = ${firstInstall ? '$true' : '$null'}; $from = 4; $r = [ordered]@{}; $script:starts = 0
function Step-StartCompanion { $script:starts++; @{ started = $true } }
. ([scriptblock]::Create($ifs[0].Extent.Text))
'{"starts":' + $script:starts + ',"firstInstallSwitch":' + $(if ($r['companion'].Contains('firstInstallSwitch')) { 'true' } else { 'false' }) + '}'`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}
test('the continuation after the install: a first install does not start the companion first; a reinstall does', { skip, timeout: 300_000 }, () => {
  assert.deepEqual(cont(true), { starts: 0, firstInstallSwitch: true });
  assert.deepEqual(cont(false), { starts: 1, firstInstallSwitch: false });
});

// "包分支两处" A: the first-train wait is not changed; its step line carries when it started and ended and what the new resident's status
// showed meanwhile (executor state and reason, train, node mode and role probe, queue), each change once, so the next drill says what it
// waited for. The real Step-WaitFirstTrain and the progress handler of the template, over a status file in a scratch root.
import fs from 'node:fs';
import os from 'node:os';
test('the first-train wait prints its start, end and the role probe and train it observed', { skip, timeout: 300_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-train-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'state'));
  const status = { contract: 'clued.independent-ci.resident-status/8', writtenAt: new Date().toISOString(), executor: { state: 'IDLE', reason: null },
    train: { enabled: 'on', last: null }, halt: null, node: { name: 'clued-drill', source: 'abcdefabcdef', mode: 'UNCERTAIN', probe: { at: new Date().toISOString(), result: 'uncertain', failures: 1, failingSince: null } },
    queue: { generation: 'abcdefabcdef', live: 0 }, current: null, pending: [] };
  fs.writeFileSync(path.join(root, 'state', 'status.json'), JSON.stringify(status));
  const command = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
foreach ($name in @('Get-Key', 'Parse-Json', 'Wait-Until', 'Test-FirstTrainNotApplicable', 'Step-WaitFirstTrain')) {
  . ([scriptblock]::Create(@($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))[0].Extent.Text))
}
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ResidentRoot = ${psLiteral(root)}; $FirstTrainWaitSeconds = 3; $RunnerQuietWaitSeconds = 30; $NodeName = 'clued-drill'; $CiSourceManifestSha256 = ('a' * 64)
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
  const line = JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
  assert.deepEqual([line.name, line.result, line.rejectCode], ['first-train-not-observed', 'ok', null], r.stdout);
  const d = line.detail;
  assert.ok(d && /Z$/.test(d.startedAt) && /Z$/.test(d.endedAt) && /Z$/.test(d.phase1EndedAt) && d.startedAt <= d.phase1EndedAt && d.phase1EndedAt <= d.endedAt, r.stdout);
  assert.equal(d.runnerQuiet, true, r.stdout);
  assert.equal(d.observations.length, 1, 'an unchanged status is one observation');
  assert.deepEqual({ ...d.observations[0], at: undefined }, { at: undefined, state: 'IDLE', reason: null, trainEnabled: 'on', trainLast: null, halt: false, mode: 'UNCERTAIN',
    probeAt: status.node.probe.at, probeResult: 'uncertain', probeFailures: 1, live: 0 }, r.stdout);
});
