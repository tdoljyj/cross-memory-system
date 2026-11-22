// r9 follow-up (task 0e418483, FABLE-drill-r9-followup sections 1.3 end and 3.2 (1)): what the launcher does once verify did not pass.
//   P1  no pause request is posted and nothing is waited for: the resident is stopped at once, the step keeps its name
//       (pause-not-confirmed-resident-stopped, the name continue-install.ps1 knows), waitSeconds 0, request null. r9 waited the whole
//       420 s for a HALTED executor that never took the request, and the ending was the same either way.
//   P2  verify passed: the request is posted and waited for as before (regression).
//   V1  the verify step's own line says failed, with the verdict as its reject code. It said result: ok beside a terminal that said
//       R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED.
//   V2  verify passed: its line is ok with no reject code, as before (regression).
// Real functions and the real progress handler, taken by AST from reinstall/launcher/template.ps1, run in Windows PowerShell 5.1 on
// directories under TEMP; sc.exe, the executor read and the clock of Wait-Until are stand-ins that record what they were asked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// Every stdout line that is a JSON object, in order: the step lines the launcher prints, then the test's own answer (the last one).
function ps(command) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 240_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return String(r.stdout).split(/\r?\n/).filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
}

const load = (fns, vars) => `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_ERRORS' }
foreach ($name in @(${vars.map(psLiteral).join(', ')})) {
  $a = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Left.Extent.Text -ceq ('$' + $name) }, $false))
  if ($a.Count -ne 1) { throw ('ASSIGNMENT_NOT_ONE:' + $name + ':' + $a.Count) }
  . ([scriptblock]::Create($a[0].Extent.Text))
}
foreach ($name in @(${fns.map(psLiteral).join(', ')})) {
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($f.Count -ne 1) { throw ('FUNCTION_NOT_ONE:' + $name + ':' + $f.Count) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}
`;

// ---------------------------------------------------------------- P1, P2
// The request's DACL is the test account's own (a non-elevated test cannot write the installed one); everything else is the template's.
// Wait-Until is a clock stand-in: it records the seconds it was given and asks the condition once. Before a pause wait it does what the
// executor would do with a request it finds: write PAUSED.json naming that request's sha256.
const pauseScript = (root, verified) => `${load(['Sha256Bytes', 'Get-Key', 'Parse-Json', 'Tail', 'Get-FileSha', 'Find-PauseRequest', 'Step-PauseAfterInstall'], ['U8', 'Js'])}
$ResidentRoot = ${psLiteral(path.join(root, 'resident'))}; $Stage = ${psLiteral(path.join(root, 'stage'))}
foreach ($d in @((Join-Path $ResidentRoot 'requests'), (Join-Path $ResidentRoot 'state'), $Stage)) { [void][IO.Directory]::CreateDirectory($d) }
$PauseWaitSeconds = 420; $PauseReason = 'drill r9 test'
$PauseRequestDacl = 'D:P(A;;FA;;;' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value + ')'
$calls = New-Object Collections.ArrayList; $waits = New-Object Collections.ArrayList; $written = @{}
$Done = New-Object Collections.Generic.List[string]
$Sc = { [void]$calls.Add(('sc ' + ($args -join ' '))); 'SERVICE_NAME: stand-in' }
function Get-ScState([string]$name) { [ordered]@{ name = $name; state = 1 } }
function Test-ExecutorAlive { [ordered]@{ alive = $false } }
function Write-Json([string]$name, $obj) { $written[$name] = $obj }
function Wait-Until([scriptblock]$cond, [int]$seconds) {
  [void]$waits.Add($seconds)
  $pending = @([IO.Directory]::GetFiles((Join-Path $ResidentRoot 'requests')))
  if ($seconds -eq $PauseWaitSeconds -and $pending.Count -eq 1) {
    [IO.File]::WriteAllText((Join-Path $ResidentRoot 'state\\PAUSED.json'), ('{"source":{"requestSha256":"' + (Get-FileSha $pending[0]) + '"}}'))
  }
  [bool](& $cond)
}
$r = Step-PauseAfterInstall $${verified}
[ordered]@{ report = $r; reported = $written.ContainsKey('pause-report.json'); done = @($Done); calls = @($calls); waits = @($waits)
  requests = @([IO.Directory]::GetFiles((Join-Path $ResidentRoot 'requests')) | ForEach-Object { [IO.Path]::GetFileName($_) })
  staged = @([IO.Directory]::GetFiles($Stage) | ForEach-Object { [IO.Path]::GetFileName($_) }) } | ConvertTo-Json -Depth 6 -Compress
`;

test('P1: verify not passed: no pause request is posted and nothing is waited for; the resident is stopped under the same step name', { skip, timeout: 300_000 }, (t) => {
  const got = ps(pauseScript(tempDir(t, 'clued-r9-pause-'), 'false')).at(-1);
  assert.deepEqual(got.requests, [], 'a pause request was posted for a resident whose verify did not pass');
  assert.deepEqual(got.staged, [], 'a pause request was staged');
  assert.equal(got.report.waitSeconds, 0);
  assert.equal(got.report.request, null);
  assert.equal(got.report.requestSha256, null);
  assert.deepEqual(got.waits, [600], 'only the wait for the stopped service: the pause confirmation is not waited for');
  assert.deepEqual(got.calls, ['sc stop CluedCIResident']);
  assert.equal(got.report.residentStopped, true);
  assert.deepEqual([got.report.verified, got.report.confirmed, got.report.error], [false, false, null]);
  assert.deepEqual(got.done, ['pause-not-confirmed-resident-stopped']);
  assert.equal(got.reported, true);
});

test('P2: verify passed: the pause request is posted and its confirmation waited for, as before', { skip, timeout: 300_000 }, (t) => {
  const got = ps(pauseScript(tempDir(t, 'clued-r9-pause-'), 'true')).at(-1);
  assert.equal(got.requests.length, 1);
  assert.equal(got.report.request, got.requests[0]);
  assert.match(got.report.requestSha256, /^[0-9a-f]{64}$/);
  assert.equal(got.report.waitSeconds, 420);
  assert.deepEqual(got.waits, [420]);
  assert.deepEqual([got.report.verified, got.report.confirmed, got.report.error], [true, true, null]);
  assert.deepEqual(got.calls, [], 'a paused, verified resident is not stopped');
  assert.equal(got.report.residentStopped, null);
  assert.deepEqual(got.done, ['pause']);
});

// ---------------------------------------------------------------- V1, V2
// The template's own $Progress, $Done and progress handler (the statement that prints each step's line), and its Step-Verify; the child
// is a stand-in that answers as verify-resident.ps1 prints.
const verifyScript = (verdict) => `${load(['Get-Key', 'Parse-Json', 'Step-Verify'], ['Js', 'Progress', 'Done'])}
$h = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.PipelineAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Extent.Text.StartsWith('$Done.add_CollectionChanged(') }, $false))
if ($h.Count -ne 1) { throw ('PROGRESS_HANDLER_NOT_ONE:' + $h.Count) }
. ([scriptblock]::Create($h[0].Extent.Text))
$ResidentRoot = 'C:\\no-such-root'; $ResidentManifestSha256 = ('a' * 64); $R5c = @{ factsStaged = $null }
function Get-VerifyFactsArgs { , @() }
function Invoke-Child([string]$name, [string]$file, [string[]]$argList) { [ordered]@{ exit = ${verdict.exit}; stdout = ${psLiteral(verdict.stdout)}; stderr = '' } }
$v = Step-Verify ('b' * 64)
[ordered]@{ answer = $true; verify = $v; done = @($Done) } | ConvertTo-Json -Depth 6 -Compress
`;

test('V1: verify not passed: its step line says failed and carries the verdict; it said ok', { skip, timeout: 300_000 }, () => {
  const failed = JSON.stringify({ status: 'RESIDENT_VERIFICATION_FAILED', checks: { 'install-receipt': { ok: true }, 'not-halted': { ok: false, detail: 'HALT.json is there' } } });
  const lines = ps(verifyScript({ exit: 1, stdout: failed }));
  const answer = lines.at(-1), steps = lines.filter(l => l.name === 'verify');
  assert.equal(steps.length, 1, JSON.stringify(lines));
  assert.equal(steps[0].result, 'failed');
  assert.equal(steps[0].rejectCode, 'RESIDENT_VERIFICATION_FAILED');
  assert.deepEqual(steps[0].detail, { status: 'RESIDENT_VERIFICATION_FAILED', exit: 1, notOk: ['not-halted'] });
  // what the launcher and a continuation read is unchanged: the step ran, its verdict is in what it returns
  assert.deepEqual(answer.done, ['verify']);
  assert.deepEqual([answer.verify.status, answer.verify.exit, answer.verify.notOk], ['RESIDENT_VERIFICATION_FAILED', 1, ['not-halted']]);
  // a verify that printed nothing readable is a failure too, under a code of its own
  const silent = ps(verifyScript({ exit: 3, stdout: 'not json' })).filter(l => l.name === 'verify');
  assert.deepEqual(silent.map(l => [l.result, l.rejectCode]), [['failed', 'VERIFY_GAVE_NO_VERDICT']]);
});

test('V2: verify passed: its step line is ok with no reject code, as before', { skip, timeout: 300_000 }, () => {
  const passed = JSON.stringify({ status: 'RESIDENT_VERIFIED', checks: { 'install-receipt': { ok: true }, 'not-halted': { ok: true } } });
  const lines = ps(verifyScript({ exit: 0, stdout: passed }));
  assert.deepEqual(lines.filter(l => l.name === 'verify'), [{ name: 'verify', result: 'ok', rejectCode: null, detail: null }]);
  assert.deepEqual(lines.at(-1).done, ['verify']);
});
