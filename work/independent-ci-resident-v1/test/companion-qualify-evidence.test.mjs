// Drill r10 (task 87d330d0, 2026-11-24): the first install stopped on COMPANION_HEADLESS_QUALIFICATION_FAILED:supervisor-process with the
// companion's password task in state 2 (queued) and lastTaskResult 0, and the result could not say whether the elevated side had counted
// no supervisor or two, nor what the Task Scheduler held. A failed qualification now carries, in the switch's result (rearm's stdout,
// which the launcher keeps as companion-headless.stdout.json):
//   Q1  every look's supervisor count and the last look's supervisors and children (pid, parent, session, start)
//   Q2  the task's run facts (state, last and next run, last result, missed runs) and each instance it holds, and the memory
//   Q3  taken before the roll-back stops anything, on both switches (the account switch and the Owner's), and kept through rearm's JSON
//   Q4  nothing when the qualification held; never a throw when the Task Scheduler or CIM cannot be read
//   Q5  (review of 36a20badc S1) the qualification's Run, watched: the task's run facts just before and just after it, and the instance
//       Run returned; a Run that throws is still COMPANION_TASK_RUN_FAILED, watched all the same
//   Q6  (review S4) evidence that cannot be taken on a look leaves that look uncounted (-1) and never changes the verdict
// companion-headless.ps1's real functions, dot-sourced in Windows PowerShell 5.1; the Task Scheduler, CIM and every process are stood in
// (nothing is stopped, started or registered).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const opts = { skip: !windows, timeout: 240_000 };
const headless = fileURLToPath(new URL('../windows/companion-headless.ps1', import.meta.url));
const rearm = fileURLToPath(new URL('../windows/rearm-resident.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-qualify-evidence-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;

function ps(body) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; $ErrorActionPreference = 'Stop'
. ${q(headless)}
${body}`;
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 200_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}

// A resident root as far as the qualification reads it: the launch file and the install receipt.
function root(name) {
  const dir = path.join(tmp, name);
  for (const d of ['config', 'install']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'companion-launch.json'), JSON.stringify({ configSha256: 'c'.repeat(64), entry: 'C:\\x\\companion-main.mjs', nodeExe: 'C:\\x\\node.exe' }));
  fs.writeFileSync(path.join(dir, 'install', 'install-receipt.json'), JSON.stringify({ residentManifestSha256: 'a'.repeat(64) }));
  return dir;
}

const SID = 'S-1-5-21-1-2-3-1001';
// The stand-ins every switch below uses: $script:supervisors is what Win32_Process holds once the task was run; the log keeps the order.
const stubs = `
$script:log = New-Object Collections.ArrayList
$script:ran = $false
$CompanionQualifySeconds = 1
function Start-Sleep { [Threading.Thread]::Sleep(60) }
function Stop-Process { [void]$script:log.Add('stop-process') }
function Get-CompanionProcessTree { [ordered]@{ supervisors = $(if ($script:ran) { @($script:supervisors) } else { @() }); children = @() } }
function Get-CompanionTaskRunFacts { [void]$script:log.Add('run-facts'); [ordered]@{ state = 2; enabled = $true; lastRunTime = $null; nextRunTime = '2026-11-24T09:45:00.0000000+00:00'; lastTaskResult = 0; numberOfMissedRuns = 0
  instances = @([ordered]@{ instanceGuid = '{11111111-2222-3333-4444-555555555555}'; state = 2; enginePid = 0; currentAction = '' }) } }
function Get-CompanionMemoryFacts { [ordered]@{ totalVisibleKb = 8388608; freePhysicalKb = 409600; totalVirtualKb = 9437184; freeVirtualKb = 512000 } }
function Get-CompanionTaskFacts { [ordered]@{ exists = $true; mode = 'password'; problems = @(); state = 2; lastTaskResult = 0; logonType = 1 } }
function Invoke-CompanionStopAndFallback { [void]$script:log.Add('stop-and-fallback'); [ordered]@{ fellBack = $true } }
function Invoke-CompanionFallback { [void]$script:log.Add('fallback'); [ordered]@{ fellBack = $true } }
function Stop-CompanionTask { [void]$script:log.Add('stop-task') }
function Wait-CompanionTaskNotRunning { }
function Start-CompanionTask { [void]$script:log.Add('run'); $script:ran = $true; $script:CompanionLastRun = [ordered]@{ instanceGuid = '{22222222-0000-0000-0000-000000000001}'; state = 2; enginePid = 0 } }
function Register-CompanionFallbackTask { [void]$script:log.Add('fallback-task') }
function Remove-CompanionFallbackTask { [void]$script:log.Add('fallback-task-removed') }
function Write-CompanionPending { [void]$script:log.Add('pending') }
function New-CompanionBuild { [ordered]@{ directory = 'C:\\none'; generation = ('a' * 64); registrar = [ordered]@{ exe = 'registrar.exe'; sourceSha256 = ('b' * 64); sha256 = ('c' * 64) } } }
function Remove-CompanionBuild { }
function Invoke-CompanionRegistrar { [void]$script:log.Add('registrar'); '{"code":"REGISTERED"}' }
`;
const sup = (pid, session = 0) => `[pscustomobject]@{ ProcessId = ${pid}; ParentProcessId = 700; SessionId = ${session}; CreationDate = [datetime]'2026-11-24T09:40:00Z' }`;
const accountSwitch = r => `
function Get-CompanionRelayParentsProblem { $null }
function Read-CompanionWslRecord { $null }
function Get-CompanionAccountFacts { $null }
function Get-CompanionDomainCredsDisabled { 0 }
function Get-LockoutPolicy { $null }
function Get-CompanionAccountPreflight { [ordered]@{ refusals = @() } }
function Invoke-CompanionWslMove { [void]$script:log.Add('move'); [ordered]@{ stage = 'forgotten'; target = 'D:\\w\\ext4.vhdx'; ownerRegistration = $null } }
$r = Invoke-CompanionAccountSwitch ${q(r)} ([pscustomobject]@{ ownerSid = '${SID}'; wslDistribution = 'CluedResident-Linux' }) 'D:\\w' 'account'`;
const ownerSwitch = r => `
function Get-CompanionHeadlessPreflight { [ordered]@{ refusals = @() } }
$r = Invoke-CompanionHeadless ${q(r)} ([pscustomobject]@{ ownerSid = '${SID}' }) 'headless'`;
// What rearm-resident.ps1 prints (its own depth), read back.
const printed = `$out = [ordered]@{ status = 'COMPANION_HEADLESS_FELL_BACK'; result = $r } | ConvertTo-Json -Depth 6 | ConvertFrom-Json
[ordered]@{ failed = $r.failed; fellBack = $r.fellBack; log = @($script:log); printed = $out.result } | ConvertTo-Json -Depth 10 -Compress`;

test('Q1 Q2 Q3: none counted: the account switch says 0 at every look, the queued instance and the memory, before the roll-back', opts, () => {
  const got = ps(`${stubs}$script:supervisors = @()\n${accountSwitch(root('q1-none'))}\n${printed}`);
  assert.equal(got.failed, 'COMPANION_HEADLESS_QUALIFICATION_FAILED:supervisor-process');
  assert.equal(got.fellBack, true);
  const e = got.printed.qualification;
  assert.ok(e, 'the result carries the qualification\'s evidence');
  assert.equal(e.why, 'supervisor-process');
  assert.ok(e.looks >= 2, `looks: ${e.looks}`);
  assert.deepEqual(e.supervisorCounts.split(',').map(Number), Array(e.looks).fill(0));
  assert.deepEqual(e.supervisors, []);
  assert.deepEqual(e.children, []);
  assert.deepEqual([e.task.state, e.task.lastTaskResult, e.task.instances.length, e.task.instances[0].state, e.task.instances[0].instanceGuid],
    [2, 0, 1, 2, '{11111111-2222-3333-4444-555555555555}']);
  assert.equal(e.memory.freePhysicalKb, 409600);
  assert.ok(!Number.isNaN(Date.parse(e.at)));
  // the task was read just before and just after the Run, and again before the roll-back stopped it
  const run = got.log.indexOf('run');
  assert.deepEqual(got.log.slice(run - 1, run + 2), ['run-facts', 'run', 'run-facts'], got.log.join(' '));
  assert.ok(got.log.lastIndexOf('run-facts') > run + 1 && got.log.lastIndexOf('run-facts') < got.log.indexOf('stop-and-fallback'), got.log.join(' '));
  // Q5: the watched Run, kept through rearm's JSON
  const w = got.printed.taskRun;
  assert.deepEqual(w.returned, { instanceGuid: '{22222222-0000-0000-0000-000000000001}', state: 2, enginePid: 0 });
  assert.deepEqual([w.before.state, w.before.instances[0].instanceGuid, w.after.instances[0].instanceGuid, w.runError], [2, '{11111111-2222-3333-4444-555555555555}', '{11111111-2222-3333-4444-555555555555}', null]);
});

test('Q1 Q3: two counted: the Owner\'s switch names both supervisors, their sessions and starts', opts, () => {
  const got = ps(`${stubs}$script:supervisors = @(${sup(4242, 0)}, ${sup(4343, 1)})\n${ownerSwitch(root('q1-two'))}\n${printed}`);
  assert.equal(got.failed, 'COMPANION_HEADLESS_QUALIFICATION_FAILED:supervisor-process');
  const e = got.printed.qualification;
  assert.deepEqual(e.supervisorCounts.split(',').map(Number), Array(e.looks).fill(2));
  assert.deepEqual(e.supervisors, [
    { pid: 4242, parentPid: 700, sessionId: 0, created: '2026-11-24T09:40:00.0000000+00:00' },
    { pid: 4343, parentPid: 700, sessionId: 1, created: '2026-11-24T09:40:00.0000000+00:00' }]);
  assert.ok(got.log.indexOf('run-facts') < got.log.indexOf('stop-and-fallback'), got.log.join(' '));
  assert.ok(!got.log.includes('stop-process') || got.log.indexOf('stop-process') < got.log.indexOf('run'), 'nothing is stopped between the run and the evidence');
});

test('Q1: a look that stops before counting is -1, and the counts follow the looks as they change', opts, () => {
  const dir = root('q1-change');
  const got = ps(`${stubs}
$script:n = 0
function Get-CompanionProcessTree { $script:n++; if ($script:n -eq 2) { Remove-Item -LiteralPath ${q(path.join(dir, 'config', 'companion-launch.json'))} }
  [ordered]@{ supervisors = $(if ($script:n -le 1) { @() } else { @(${sup(5001)}, ${sup(5002)}) }); children = @() } }
$r = Wait-CompanionQualified ${q(dir)} '${SID}' ([DateTimeOffset]::UtcNow) 1
$e = Get-CompanionQualifyEvidence
[ordered]@{ why = $r; counts = $e.supervisorCounts; supervisors = $e.supervisors; children = $e.children } | ConvertTo-Json -Compress`);
  assert.equal(got.why, 'launch-file');
  const counts = got.counts.split(',').map(Number);
  assert.deepEqual(counts.slice(0, 2), [0, 2]);
  assert.ok(counts.slice(2).every(c => c === -1), got.counts);
  // the last look stopped at the launch file before it counted: it names no supervisors and no children (null, not an empty list)
  assert.deepEqual([got.supervisors, got.children], [null, null]);
});

test('Q4: a qualification that held leaves no evidence, and an earlier failure\'s evidence does not survive into it', opts, () => {
  const got = ps(`${stubs}
$script:CompanionQualifyEvidence = [ordered]@{ why = 'stale' }
function Test-CompanionQualifiedOnce { $null }
$r = Wait-CompanionQualified 'C:\\none' '${SID}' ([DateTimeOffset]::UtcNow) 5
[ordered]@{ why = $r; evidence = (Get-CompanionQualifyEvidence); log = @($script:log) } | ConvertTo-Json -Compress`);
  assert.deepEqual(got, { why: null, evidence: null, log: [] });
});

test('Q2 Q4: the task\'s run facts as the Task Scheduler gives them; an unreadable task or memory is a code, never a throw', opts, () => {
  const got = ps(`
$inst = @([pscustomobject]@{ InstanceGuid = '{AAAAAAAA-0000-0000-0000-000000000001}'; State = 2; EnginePID = 0; CurrentAction = '' },
          [pscustomobject]@{ InstanceGuid = '{AAAAAAAA-0000-0000-0000-000000000002}'; State = 4; EnginePID = 812; CurrentAction = 'C:\\x\\CluedCompanionSupervisor.exe' })
$task = [pscustomobject]@{ State = 2; Enabled = $true; LastRunTime = [datetime]'1899-12-30T00:00:00'; NextRunTime = [datetime]::new(2026, 11, 24, 9, 45, 0, [DateTimeKind]::Utc); LastTaskResult = 267011; NumberOfMissedRuns = 3 }
$task | Add-Member -MemberType ScriptMethod -Name GetInstances -Value { param($flags) $script:flags = $flags; $inst }
$folder = [pscustomobject]@{}; $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($name) $script:asked = $name; $task }
$svc = [pscustomobject]@{}; $svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) $script:askedFolder = $p; $folder }
$facts = Get-CompanionTaskRunFacts { $svc }
$broken = Get-CompanionTaskRunFacts { throw (New-Object Runtime.InteropServices.COMException 'gone') }
$mem = Get-CompanionMemoryFacts { [pscustomobject]@{ TotalVisibleMemorySize = 8388608; FreePhysicalMemory = 1024; TotalVirtualMemorySize = 9437184; FreeVirtualMemory = 2048 } }
$noMem = Get-CompanionMemoryFacts { throw (New-Object UnauthorizedAccessException 'denied') }
[ordered]@{ facts = $facts; broken = $broken; mem = $mem; noMem = $noMem; asked = @($script:askedFolder, $script:asked, $script:flags) } | ConvertTo-Json -Depth 6 -Compress`);
  assert.deepEqual(got.asked, ['\\Clued', 'CluedCIResidentCompanion', 0], 'the companion task, every instance (flags 0)');
  assert.deepEqual(got.facts, { state: 2, enabled: true, lastRunTime: null, nextRunTime: '2026-11-24T09:45:00.0000000+00:00', lastTaskResult: 267011, numberOfMissedRuns: 3,
    instances: [{ instanceGuid: '{AAAAAAAA-0000-0000-0000-000000000001}', state: 2, enginePid: 0, currentAction: '' },
      { instanceGuid: '{AAAAAAAA-0000-0000-0000-000000000002}', state: 4, enginePid: 812, currentAction: 'C:\\x\\CluedCompanionSupervisor.exe' }] });
  assert.deepEqual(got.broken, { error: 'TASK_RUN_FACTS_UNREADABLE:COMException' });
  assert.deepEqual(got.mem, { totalVisibleKb: 8388608, freePhysicalKb: 1024, totalVirtualKb: 9437184, freeVirtualKb: 2048 });
  assert.deepEqual(got.noMem, { error: 'MEMORY_FACTS_UNREADABLE:UnauthorizedAccessException' });
});

test('Q5: Start-CompanionTask keeps the instance Run returned; a Run that throws is still COMPANION_TASK_RUN_FAILED, and watched', opts, () => {
  const got = ps(`
$running = [pscustomobject]@{ InstanceGuid = '{33333333-0000-0000-0000-000000000003}'; State = 2; EnginePID = 0 }
$task = [pscustomobject]@{}; $task | Add-Member -MemberType ScriptMethod -Name Run -Value { param($a) $script:runArg = $a; if ($script:refuse) { throw 'refused' }; $running }
$tf = [pscustomobject]@{}; $tf | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n) $script:runTask = $n; $task }
$svc = [pscustomobject]@{}; $svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
$svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) $tf }
function New-Object { $svc }
$script:refuse = $false
$ok = Watch-CompanionTaskRun { Start-CompanionTask }
$script:refuse = $true
$refused = Watch-CompanionTaskRun { Start-CompanionTask }
[ordered]@{ ok = $ok; refused = $refused; task = $script:runTask } | ConvertTo-Json -Depth 6 -Compress`);
  assert.equal(got.task, 'CluedCIResidentCompanion');
  assert.deepEqual(got.ok.returned, { instanceGuid: '{33333333-0000-0000-0000-000000000003}', state: 2, enginePid: 0 });
  assert.equal(got.ok.runError, null);
  // the Task Scheduler is stood in by New-Object here: its run facts are then a code, never a throw
  assert.match(got.ok.before.error, /^TASK_RUN_FACTS_UNREADABLE:/);
  assert.equal(got.refused.returned, null, 'an earlier Run\'s instance is not kept');
  assert.match(got.refused.runError, /refused/);
  assert.ok(got.refused.before && got.refused.after);

  // the switch: a Run that throws is COMPANION_TASK_RUN_FAILED as before, and the result carries the watch
  const sw = ps(`${stubs}$script:supervisors = @()
function Start-CompanionTask { [void]$script:log.Add('run'); throw 'BOOM' }
${accountSwitch(root('q5-throw'))}
[ordered]@{ runError = $r.runError; failed = $r.failed; taskRun = $r.taskRun } | ConvertTo-Json -Depth 6 -Compress`);
  assert.equal(sw.runError, 'COMPANION_TASK_RUN_FAILED');
  assert.equal(sw.failed, 'COMPANION_HEADLESS_QUALIFICATION_FAILED:supervisor-process');
  assert.deepEqual([sw.taskRun.runError, sw.taskRun.returned, sw.taskRun.before.state, sw.taskRun.after.state], ['BOOM', null, 2, 2]);
});

test('Q6: evidence that cannot be taken leaves the look uncounted and the verdict as it was', opts, () => {
  const got = ps(`${stubs}$script:ran = $true; $script:supervisors = @(${sup(4242)})
function Get-CompanionProcessFacts { throw 'facts broke' }
$r = Wait-CompanionQualified ${q(root('q6'))} '${SID}' ([DateTimeOffset]::UtcNow) 1
$e = Get-CompanionQualifyEvidence
[ordered]@{ why = $r; counts = $e.supervisorCounts; supervisors = $e.supervisors } | ConvertTo-Json -Compress`);
  // one supervisor: the look goes on to the companion child (none here), as without the evidence
  assert.equal(got.why, 'companion-process');
  assert.ok(got.counts.split(',').every(c => c === '-1'), got.counts);
  assert.equal(got.supervisors, null);
});

test('Q3: rearm prints the switch\'s result at the depth the evidence was checked at', opts, () => {
  assert.match(fs.readFileSync(rearm, 'utf8'), /^\s*\$out \| ConvertTo-Json -Depth 6$/m);
});
