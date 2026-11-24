// Task 87d330d0 (drill r11, K3): the companion account's import wait, its starts with RunEx(ignore constraints) and the SYSTEM start
// task, run as companion-headless.ps1's real functions in Windows PowerShell 5.1 against a stand-in Task Scheduler. Moved here from
// m5b-reinstall-regressions.test.mjs (first review of K3, item 3: that file is claimed elsewhere); nothing here depends on its other
// tests. Nothing is registered, run, stopped or deleted on this host.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const source = fileURLToPath(new URL('../windows/CompanionTaskRegistrar.cs', import.meta.url));
const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function run(exe, args, extra = {}) {
  const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, ...extra });
  assert.ifError(result.error);
  return result;
}
// one scratch directory per name under one temporary directory, removed after the file
async function scratch(name) {
  if (!headlessTmp) headlessTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-k3-behavior-'));
  const dir = path.join(headlessTmp, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

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
// startRegisterFails: registering CluedCIResidentCompanionStart throws. runExThrows: RunEx throws a COMException 0x80070005.
const fakeScheduler = (seq, { absent = false, readFailAfter = -1, instancesFail = false, runExQueues = false, startRegisterFails = false, runExThrows = false } = {}) => `
$script:ms = 0; $script:runAt = -1; $script:deleted = $false; $script:sleeps = 0
$script:readFailAfter = ${readFailAfter}; $script:instancesFail = ${instancesFail ? '$true' : '$false'}
$script:runExQueues = ${runExQueues ? '$true' : '$false'}; $script:startRegisterFails = ${startRegisterFails ? '$true' : '$false'}; $script:runExThrows = ${runExThrows ? '$true' : '$false'}
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
$script:task | Add-Member -MemberType ScriptMethod -Name RunEx -Value { param($a, $f, $sid, $u)
  if ($script:runExThrows) { [void]$script:log.Add('runex-threw'); throw (Microsoft.PowerShell.Utility\\New-Object Runtime.InteropServices.COMException 'access denied', -2147024891) }
  $script:runAt = $script:ms
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
  $script:registered[$n] = [ordered]@{ principal = $d.Principal; settings = $d.Settings; triggers = @($d.TriggerList); actions = @($d.ActionList); flags = $flags; user = $user; password = $password; logonType = $logonType; sddl = $sddl; setSecurity = @() }
  $t = [pscustomobject]@{ Name = $n }; $t | Add-Member -MemberType ScriptMethod -Name SetSecurityDescriptor -Value { param($sd, $f) $script:registered[$this.Name].setSecurity += ,@($sd, $f) }; $t }
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
  const dir = await scratch(name);
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
  const tools = { dir: await scratch('registrar') };
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
  const tools = { dir: await scratch('registrar') };
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

test('K3 T4 start task: registered after the import and the Owner\'s key are done, before the first start, SYSTEM, boot +30 s and every 15 min, the one PowerShell RunEx(ignore constraints) action, SY and BA only', { skip: !windows, timeout: 240_000 }, async () => {
  const root = await switchRoot('k3-t4');
  const got = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE)) + accountSwitch(root));
  assert.equal(got.failed, null, `log ${got.log.join(',')}`);
  const reg = got.log.indexOf('register:' + START);
  assert.ok(reg >= 0, `not registered: ${got.log.join(',')}`);
  // review K3 item 4: never before the import (a quarter-hour tick would start the companion early and IgnoreNew drop the qualification's
  // start), always before the first start
  assert.ok(reg > got.log.indexOf('delete:CluedCIResidentCompanionWslImport@1000') && reg > got.log.indexOf('remove-key:{g1}') && reg < got.log.indexOf('run-companion'),
    `registered out of place: ${got.log.join(',')}`);
  assert.ok(!got.log.some(l => l.startsWith('delete:' + START)), 'a qualified switch keeps it');
  const st = got.start;
  assert.deepEqual(st.principal, { UserId: 'S-1-5-18', LogonType: 5, RunLevel: 1 });
  // create or update, TASK_DONT_ADD_PRINCIPAL_ACE (0x16), and the DACL set on the task too (an update ignores the SDDL passed; drill r14 A2)
  assert.deepEqual([st.flags, st.user, st.password, st.logonType, st.sddl], [0x16, null, null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)']);
  assert.deepEqual(st.setSecurity, [['D:P(A;;FA;;;SY)(A;;FA;;;BA)', 0x10]]);
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

test('K3 T5 start task: every fall-back deletes it; a failed import never registered it; a failed registration falls back as a failed qualification', { skip: !windows, timeout: 240_000 }, async () => {
  // a failed import (not a maintenance switch): back to the interactive definition, the start task gone after it was registered
  const root = await switchRoot('k3-t5');
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExQueues: true }) + accountSwitch(root));
  assert.equal(got.failed, 'WSL_IMPORT_FAILED:not-started');
  const del = got.log.findIndex(l => l.startsWith('delete:' + START + '@'));
  assert.ok(!got.log.includes('register:' + START) && del > got.log.indexOf('fallback') && got.log.indexOf('fallback') >= 0, `log ${got.log.join(',')}`);
  // a cut-off switch rolled back (Invoke-CompanionStopAndFallback, as rearm, verify and the fall-back task call it)
  const cut = headlessPs(fakeScheduler(R11_QUEUED) + `
function Get-CompanionProcessTree { [ordered]@{ supervisors = @(); children = @() } }
function Register-CompanionTaskInteractive { [void]$script:log.Add('fallback'); ('d' * 64) }
function Remove-CompanionFallbackTask { }
$null = Invoke-CompanionStopAndFallback ${psq(root)} 'S-1-5-21-1-2-3-1001'
[ordered]@{ log = @($script:log) } | ConvertTo-Json -Compress`);
  assert.ok(cut.log.some(l => l.startsWith('delete:' + START + '@')), `log ${cut.log.join(',')}`);
  // the registration fails (after the import and the Owner's key): the failed qualification's fall-back, nothing started, nothing registered
  const root2 = await switchRoot('k3-t5-fail');
  const bad = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE), { startRegisterFails: true }) + accountSwitch(root2));
  assert.equal(bad.failed, 'COMPANION_START_TASK_REGISTER_FAILED', `log ${bad.log.join(',')}`);
  assert.equal(bad.fellBack, true); assert.equal(bad.qualified, false);
  assert.ok(!bad.log.some(l => l === 'run' || l === 'run-companion' || l.startsWith('register:' + START)), bad.log.join(','));
  assert.ok(bad.log.indexOf('stop-and-fallback') > bad.log.indexOf('remove-key:{g1}'), bad.log.join(','));
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

// Review of K3, item 4: the start task fires on its own (boot, every quarter hour, SYSTEM, ignoring constraints). Stand-in: the companion
// task runs one instance at a time (IgnoreNew); the start task starts it once, at the first moment it can: in 'sleep', the first sleep
// after it is registered (the import waits in 500 ms sleeps); in 'register', at once when it is registered. Start-CompanionTask while an
// instance runs is dropped; Stop-CompanionTask ends it.
const startFires = when => `
$script:companionUp = $false; $script:fired = $false
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) $script:sleeps++; $script:ms += $Seconds * 1000 + $Milliseconds; if ($script:ms -gt 1800000) { throw 'FAKE_CLOCK_RUNAWAY' }
  if ('${when}' -ceq 'sleep' -and -not $script:fired -and $script:registered.ContainsKey('CluedCIResidentCompanionStart')) { $script:fired = $true; $script:companionUp = $true; [void]$script:log.Add('start-task-fired') } }
$script:realRegisterStart = \${function:Register-CompanionStartTask}
function Register-CompanionStartTask { & $script:realRegisterStart
  if ('${when}' -ceq 'register' -and -not $script:fired) { $script:fired = $true; $script:companionUp = $true; [void]$script:log.Add('start-task-fired') } }
function Stop-CompanionTask { $script:companionUp = $false; [void]$script:log.Add('stop-companion') }
function Start-CompanionTask { if ($script:companionUp) { [void]$script:log.Add('run-companion-dropped') } else { $script:companionUp = $true; [void]$script:log.Add('run-companion') } }
`;

test('K3 T8 switch: the start task firing on its own never takes the qualification\'s start (registered after the import; stopped and waited before the start)', { skip: !windows, timeout: 240_000 }, async () => {
  for (const when of ['sleep', 'register']) {
    const root = await switchRoot('k3-t8-' + when);
    const got = headlessPs(fakeScheduler(ranAtOnce(IMPORT_DONE)) + accountSwitch(root).replace('\n$r = Invoke-CompanionAccountSwitch', startFires(when) + '\n$r = Invoke-CompanionAccountSwitch'));
    assert.equal(got.failed, null, `${when}: log ${got.log.join(',')}`); assert.equal(got.qualified, true);
    assert.ok(!got.log.includes('run-companion-dropped'), `${when}: the qualification's start was dropped: ${got.log.join(',')}`);
    assert.ok(got.log.includes('run-companion'), `${when}: log ${got.log.join(',')}`);
    // never during the import: the import's RunEx and its task's delete come before the start task exists
    const reg = got.log.indexOf('register:' + START);
    assert.ok(reg > got.log.indexOf('delete:CluedCIResidentCompanionWslImport@1000') && reg > got.log.indexOf('remove-key:{g1}'), `${when}: ${got.log.join(',')}`);
    // whatever it started is stopped before the qualification's start
    assert.ok(got.log.lastIndexOf('stop-companion') > reg && got.log.lastIndexOf('stop-companion') < got.log.indexOf('run-companion'), `${when}: ${got.log.join(',')}`);
  }
});

test('K3 T9 import: a RunEx that throws is run-failed with its HRESULT, the task deleted, never thrown; the switch falls back, the key kept', { skip: !windows, timeout: 240_000 }, async () => {
  const got = headlessPs(fakeScheduler(R11_QUEUED, { runExThrows: true }) + importCall);
  assert.equal(got.r, 'run-failed:0x80070005', `returned ${JSON.stringify(got.r)}; log ${got.log.join(',')}`);
  assert.equal(got.log[0], 'runex-threw'); assert.ok(got.log.some(l => l.startsWith('delete:CluedCIResidentCompanionWslImport@')), got.log.join(','));
  assert.ok(!got.log.some(l => l.startsWith('stop:')), 'nothing ran, nothing to stop');
  assert.equal(got.watch.why, 'run-failed'); assert.equal(got.watch.error, 'COMException:0x80070005'); assert.equal(got.sleeps, 0);
  const root = await switchRoot('k3-t9');
  const sw = headlessPs(fakeScheduler(R11_QUEUED, { runExThrows: true }) + accountSwitch(root));
  assert.equal(sw.failed, 'WSL_IMPORT_FAILED:run-failed:0x80070005', `log ${sw.log.join(',')}`);
  assert.equal(sw.fellBack, true); assert.ok(sw.log.includes('fallback'), sw.log.join(','));
  assert.ok(!sw.log.some(l => l.startsWith('remove-key') || l === 'remove-default' || l === 'run-companion'), sw.log.join(','));
  assert.equal(sw.stage, 'moved'); assert.equal(sw.imported, false);
});
