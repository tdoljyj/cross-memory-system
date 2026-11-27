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

test('P1: verify not passed: no pause request is posted and nothing is waited for; the resident is stopped under the same step name', { skip }, (t) => {
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

test('P2: verify passed: the pause request is posted and its confirmation waited for, as before', { skip }, (t) => {
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

test('V1: verify not passed: its step line says failed and carries the verdict; it said ok', { skip }, () => {
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

test('V2: verify passed: its step line is ok with no reject code, as before', { skip }, () => {
  const passed = JSON.stringify({ status: 'RESIDENT_VERIFIED', checks: { 'install-receipt': { ok: true }, 'not-halted': { ok: true } } });
  const lines = ps(verifyScript({ exit: 0, stdout: passed }));
  // each line also carries when it was printed (task 87d330d0); the step's own fields are as before
  const verify = lines.filter(l => l.name === 'verify');
  assert.ok(verify.every(l => /^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/.test(l.at) && 'ms' in l), JSON.stringify(verify));
  assert.deepEqual(verify.map(({ at, ms, ...rest }) => rest), [{ name: 'verify', result: 'ok', rejectCode: null, detail: null }]);
  assert.deepEqual(lines.at(-1).done, ['verify']);
});

test('旧安装的提升复核必须逐项通过，断点续装只允许独立证明的双端差异', { skip }, () => {
  const [result] = ps(`${load(['Get-Key', 'Parse-Json', 'Test-OldVerifyResult'], ['Js'])}
function Verdict($checks, $exit, $status, $split) {
  $c = @{ stdout = (@{status=$status;checks=$checks} | ConvertTo-Json -Depth 5 -Compress); exit=$exit }
  Test-OldVerifyResult $c $split
}
$checks = @{'install-receipt'=@{ok=$true}; 'paused-as-expected'=@{ok=$true}; 'current-ci-connection'=@{ok=$true}}
$r = @{ pass = (Verdict $checks 0 'RESIDENT_VERIFIED' $false) }
$checks['current-ci-connection'] = @{ok=$false;detail='ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED'}
$r.mismatch = Verdict $checks 1 'RESIDENT_VERIFICATION_FAILED' $false
$checks['verify-inputs'] = @{ok=$false;detail='VERIFY_INPUT_UNREADABLE'}
$r.mixed = Verdict $checks 1 'RESIDENT_VERIFICATION_FAILED' $true
$checks.Remove('verify-inputs'); $checks['current-ci-connection'].ok = 'unreadable'
$r.partial = Verdict $checks 0 'RESIDENT_VERIFIED' $false
$checks['current-ci-connection'].ok = $true; $checks['two-sides-consistent'] = @{ok=$false}
$r.resume = Verdict $checks 1 'RESIDENT_VERIFICATION_FAILED' $true
$r.unproven = Verdict $checks 1 'RESIDENT_VERIFICATION_FAILED' $false
$r | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { pass: true, partial: false, mismatch: false, mixed: false, resume: true, unproven: false });
});

test('旧验证器尝试恢复任务时，只读子进程在调用前退出', { skip }, t => {
  const dir = tempDir(t, 'verify-observe-');
  const child = path.join(dir, 'legacy.ps1'), wrapper = path.join(dir, 'readonly.ps1'), changed = path.join(dir, 'changed');
  fs.writeFileSync(child, `param($ExpectedInstallReceiptSha256,$ExpectPausedSha256)\nfunction Invoke-CompanionStopAndFallback { [IO.File]::WriteAllText(${psLiteral(changed)}, 'changed') }\nInvoke-CompanionStopAndFallback\nexit 0`);
  const [result] = ps(`${load([], [])}
$guard = @($ast.FindAll({param($x) $x -is [Management.Automation.Language.StringConstantExpressionAst] -and $x.Value.StartsWith('param($verify,$receipt,$pause)')},$true))
if ($guard.Count -ne 1) {throw 'GUARD_NOT_FOUND'}
[IO.File]::WriteAllText(${psLiteral(wrapper)}, $guard[0].Value)
& ${psLiteral(POWERSHELL)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${psLiteral(wrapper)} ${psLiteral(child)} r p
@{exit=$LASTEXITCODE} | ConvertTo-Json -Compress`);
  assert.equal(result.exit, 3);
  assert.equal(fs.existsSync(changed), false);
});

test('Linux B 和卸装前，未归属锁须限次重采并停止', { skip }, t => {
  const root = tempDir(t, 'verify-locks-');
  fs.writeFileSync(path.join(root, 'file-locks.ps1'), 'fixture');
  const [result] = ps(`${load(['Read-VerifiedResidentLocks'], ['Js'])}
$Stage = ${psLiteral(root)}; $ResidentRoot = $Stage; $FleetFileLocksSha256 = 'fixture'; $InstalledReceiptSha256 = 'receipt'; $OwnerSid = 'owner'
function Get-FileSha { 'fixture' }; function Write-Json {}; function Tail { '' }; function Start-Sleep {}; function Stop-Launch($code,$report) { throw $code }
$row = @{pid=4; startedFileTime=0; expected=$false; application=''}
$v = @{contract='clued.independent-ci.rehearsal-file-locks/1';status='OBSERVED';coverage='installed-public-binaries-only';fileCount=1;directoryHandlesCovered=$false;secretsEnumerated=$false;unknownProcesses=@();rootProcesses=@();lockers=@($row);external=@($row)}
$script:tries = 0; $script:changes = 0; $r = @{}
function Invoke-Child { $script:tries++; @{exit=0;stdout=($v | ConvertTo-Json -Compress -Depth 6);stderr=''} }
foreach ($phase in @('before-linux-b','before-uninstall')) {
  try { $null = Read-VerifiedResidentLocks $phase; $script:changes++ } catch { $r[$phase]=$_.Exception.Message }
}
$r.tries=$script:tries; $r.changes=$script:changes; $r | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { 'before-linux-b': 'EXTERNAL_RESIDENT_BINARY_LOCK', 'before-uninstall': 'EXTERNAL_RESIDENT_BINARY_LOCK', tries: 6, changes: 0 });
});
