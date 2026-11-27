// K3 (task 87d330d0, 2026-11-24; FABLE-drill-companion-k3-20261124 sections 1, 2.1, 9 T7-T9): on the drill guest a task whose principal
// is not a service account is held by a start constraint outside its XML: a plain Run (and its own time trigger) leaves it queued
// (325 -> 110 -> 325, state 2), while RunEx with TASK_RUN_IGNORE_CONSTRAINTS (2) starts it in 0.4 s. So every start of the companion's
// tasks ignores the constraints, and a SYSTEM task (\Clued\CluedCIResidentCompanionStart, one fixed PowerShell line calling the same
// RunEx(2): companion-headless.ps1 $CompanionStartTaskAction) starts it on boot and every 15 minutes. This file holds:
//   T7  no PowerShell file of the resident starts a task with a plain Run, Start-ScheduledTask or schtasks /Run without /I, except the
//       listed places (each says why); every RunEx of a product file is RunEx($null, 2, 0, $null)
//   T8  the reinstall launcher's Start-CompanionTask starts the companion task with RunEx($null, 2, 0, $null) and nothing else
//   T9  the uninstall deletes the start task before it stops the companion; verify-resident.ps1 requires the start task (exact shape)
//       only under the password definition, and run as SYSTEM (the upgrade channel's VERIFY) adds a missing or wrong one first; the
//       action it expects is companion-headless.ps1's $CompanionStartTaskAction itself, and what Register-CompanionStartTask registers
//       reads back with no problem (review r1 item 2: verify expected schtasks while the switch registered PowerShell)
// T8 and T9 run the scripts' real functions (taken by name from the parsed file) in Windows PowerShell 5.1; the Task Scheduler is stood
// in by a fake Schedule.Service whose Run always queues (the guest's sequence) and whose RunEx starts only with flags 2. Nothing is
// started, stopped or registered on this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const opts = { skip: !windows };
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-run-ignores-constraints-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const rel = p => path.relative(RES, p).split(path.sep).join('/');

// ---- T7: the static list ----
function ps1Files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ps1Files(p, out);
    else if (/\.ps1$/i.test(e.name)) out.push(p);
  }
  return out;
}
// What starts a task: a COM Run (not RunEx), the ScheduledTasks cmdlet (it has no ignore-constraints switch), schtasks /Run without /I.
const STARTS = [
  { kind: 'Run', hit: line => /\.Run\s*\(/.test(line) },
  { kind: 'Start-ScheduledTask', hit: line => /Start-ScheduledTask/i.test(line) },
  { kind: 'schtasks /Run without /I', hit: line => /schtasks/i.test(line) && /[\s"']\/Run\b/i.test(line) && !/\s\/I\b/i.test(line) },
];
// The only places allowed: file, a text the line holds, how many lines of the file hold it, and why it is not a companion start.
const ALLOWED = [
  { file: 'rollout/fleet/package-lifecycle.ps1', text: "Start-ScheduledTask -TaskPath '\\' -TaskName $taskName -ErrorAction Stop", count: 1,
    why: 'one-shot S4U WSL cleanup as the distribution owner; its settings allow battery operation and the caller waits for this exact task result' },
  { file: 'windows/install-resident.ps1', text: '$null = $t.Run($null)', count: 1, why: 'a SYSTEM one-shot task; SYSTEM tasks are not held (guest control sys1)' },
  { file: 'windows/test-upgrade-system.ps1', text: '$null = $task.Run($null)', count: 1, why: 'a SYSTEM one-shot task of the upgrade system test' },
  { file: 'windows/upgrade-apply.ps1', text: '{ try { $null = $task.Run($null); $ranTask = $true }', count: 1,
    why: 'frozen channel (design section 6, open item): restarts the companion task with a plain Run; not changed in this batch' },
  { file: 'windows/test-upgrade-windows.ps1', text: '`$task.Run(`$null)', count: 1, why: 'asserts the frozen upgrade-apply.ps1 text above' },
  { file: 'windows/test-companion-headless.ps1', text: "'icacls', 'reg.exe', '.Run(')", count: 1, why: 'the read-only probe list: asserts .Run( is absent' },
  { file: 'drill/first-install-entry.ps1', text: "if ($it.run -ceq 'run-ignore-constraints') { [void]$t.RunEx(", count: 1,
    why: 'the drill probe: a plain Run paired with RunEx(2) on purpose' },
  { file: 'windows/replace-heartbeat-token.ps1', text: 'restart is done from an elevated window: Stop-ScheduledTask then Start-ScheduledTask', count: 1,
    why: 'text for a person (help), not a start; open item: should name a start that ignores the constraints' },
  { file: 'windows/replace-heartbeat-token.ps1', text: "companionRestartHow = $(if ($plan.companionRestartNeeded) { 'elevated window: Stop-ScheduledTask, then Start-ScheduledTask", count: 1,
    why: 'text for a person (result field), not a start; same open item' },
];
const SITES = ps1Files(RES).flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) =>
  STARTS.filter(s => s.hit(line)).map(s => ({ file: rel(file), line: i + 1, kind: s.kind, text: line.trim() }))));

test('T7: a task is started with a plain Run, Start-ScheduledTask or schtasks /Run without /I only at the listed places', () => {
  const stray = SITES.filter(s => !ALLOWED.some(a => a.file === s.file && s.text.includes(a.text)));
  assert.deepEqual(stray.map(s => `${s.file}:${s.line} ${s.kind}: ${s.text}`), [],
    'K3: start the companion\'s tasks with RunEx($null, 2, 0, $null) (or schtasks /Run /I); a place that is not a companion start goes on the list with why');
  for (const a of ALLOWED) {
    const lines = fs.readFileSync(path.join(RES, a.file), 'utf8').split(/\r?\n/).filter(l => l.includes(a.text)).length;
    assert.equal(lines, a.count, `the allowed place ${a.file} "${a.text}" is still there exactly ${a.count} time(s) (else take it off the list)`);
  }
});

test('T7: every RunEx of a product script ignores the constraints with no session and no user: RunEx($null, 2, 0, $null)', () => {
  const product = ps1Files(RES).filter(f => { const r = rel(f); return !r.startsWith('drill/') && !/(^|\/)test-[^/]*\.ps1$/i.test(r) && !/(^|\/)test\//.test(r); });
  const bad = product.flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) =>
    [...line.matchAll(/\.RunEx\s*\(([^)]*)\)/g)].filter(m => m[1].replace(/\s+/g, '') !== '$null,2,0,$null').map(m => `${rel(file)}:${i + 1} ${m[0]}`)));
  assert.deepEqual(bad, []);
});

// ---- T8, T9: the real functions against stand-ins ----
// Loads the named functions (names) and top-level variable assignments (vars) of scripts by their parse trees (none of a script's body
// runs), then runs body; the last line of stdout is JSON.
function psLoad(loads, body) {
  const load = ({ script, names = [], vars = [] }) => `$ast = [Management.Automation.Language.Parser]::ParseFile(${q(script)}, [ref]$null, [ref]$null)
foreach ($v in @(${vars.map(q).join(', ')})) {
  $found = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq ('$' + $v) }, $true))
  if ($found.Count -ne 1) { [Console]::Out.WriteLine((ConvertTo-Json -Compress ([ordered]@{ missing = ('$' + $v); found = $found.Count; script = ${q(rel(script))} }))); exit 0 }
  . ([scriptblock]::Create($found[0].Extent.Text))
}
foreach ($name in @(${names.map(q).join(', ')})) {
  $found = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($found.Count -ne 1) { [Console]::Out.WriteLine((ConvertTo-Json -Compress ([ordered]@{ missing = $name; found = $found.Count; script = ${q(rel(script))} }))); exit 0 }
  . ([scriptblock]::Create($found[0].Extent.Text))
}`;
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; $ErrorActionPreference = 'Stop'
${loads.map(load).join('\n')}
${body}`;
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(got.missing, undefined, `${got.missing} is defined exactly once in ${got.script} (found ${got.found})`);
  return got;
}
const ps = (script, names, body) => psLoad([{ script, names }], body);

test('重装取快照时阻止任务重触发，卸载前中止后恢复启用状态', opts, () => {
  const launcher = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
  const got = ps(launcher, ['Step-Quiesce', 'Stop-CompanionTask', 'Start-CompanionTask'], `
Set-StrictMode -Version 2.0
$helpers = @('Test-CompanionTaskActive', 'Disable-CompanionTaskTriggers', 'Restore-CompanionTaskTriggers')
foreach ($fn in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in $helpers }, $true)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}
$restore = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Restore-CompanionTaskTriggers' }, $true))
function New-FakeTask([string]$name, [bool]$enabled) {
  $task = [pscustomobject]@{ Name = $name; Enabled = $enabled; State = 4 }
  $task | Add-Member ScriptMethod GetInstances { param($flags) @{ Count = [int]($this.State -in @(2, 4)) } }
  $task | Add-Member ScriptMethod Stop { param($flags) $this.State = 3 }
  $task | Add-Member ScriptMethod RunEx { param($params, $flags, $session, $user) if ($this.Enabled) { $this.State = 4 } }
  $task
}
$prefix = 'CluedCIResidentCompanion'
$script:main = New-FakeTask $prefix $true
$script:k3 = New-FakeTask ($prefix + 'Start') $true
$script:fallback = New-FakeTask ($prefix + 'Fallback') $false
$script:folder = [pscustomobject]@{ Tasks = @{ $main.Name = $main; $k3.Name = $k3; $fallback.Name = $fallback } }
$folder | Add-Member ScriptMethod GetTask { param($name) $this.Tasks[$name] }
function New-Object([string]$ComObject) {
  if ($ComObject -cne 'Schedule.Service') { throw 'UNEXPECTED_COM_OBJECT' }
  $svc = [pscustomobject]@{}
  $svc | Add-Member ScriptMethod Connect {}
  $svc | Add-Member ScriptMethod GetFolder { param($name) $script:folder }
  $svc
}
function Import-Module {}  # baseline: Stop-CompanionTask uses the ScheduledTasks cmdlet
function Stop-ScheduledTask { $script:main.Stop(0) }
$FleetFirstInstall = $false; $FleetPlanSha256 = 'reviewed'; $Sc = { 'stopped' }
$Done = [Collections.Generic.List[string]]::new()
$CompanionTaskRestore = [ordered]@{ disabled = [Collections.Generic.List[object]]::new(); restart = $false; uninstallStarted = $false }
$script:spawned = $false
$script:beforeSnapshot = $null
function Get-ScState { @{ gone = $false; state = 1 } }
function Test-ExecutorAlive { @{ alive = $false } }
function Write-Json {}
function Wait-Until([scriptblock]$cond, [int]$seconds) { [bool](& $cond) }
function Stop-Launch([string]$code, $detail) { throw $code }
function Read-VerifiedResidentLocks([string]$phase) {
  $script:beforeSnapshot = @($main.Enabled, $main.State, $k3.Enabled, $k3.State, $fallback.Enabled, $fallback.State)
  # A trigger accepted here can start an instance just after the enumerated PID list was taken.
  $script:spawned = $main.Enabled -or $k3.Enabled -or $k3.State -eq 4 -or $fallback.Enabled -or $fallback.State -eq 4
  @{ rootProcesses = @() }
}
function Get-ProcessesUnderRoot { if ($script:spawned) { @{ pid = 12345 } } }
$failure = $null
try {
  $null = Step-Quiesce
  Stop-Launch 'UNINSTALL_PLAN_REFUSED' $null
} catch { $failure = $_.Exception.Message }
finally {
  if ($restore.Count -eq 1) { . ([scriptblock]::Create($restore[0].Extent.Text)) }
}
[ordered]@{ failure = $failure; spawned = $spawned; snapshot = $beforeSnapshot; beforeExit = @($main.Enabled, $k3.Enabled, $fallback.Enabled); mainRunning = ($main.State -eq 4) } | ConvertTo-Json -Compress`);
  assert.equal(got.spawned, false, '快照后的重触发不应启动旧实例');
  assert.deepEqual(got.snapshot, [false, 4, false, 3, false, 3], '主任务实例保留到身份核验，两个辅助入口已停稳');
  assert.equal(got.failure, 'UNINSTALL_PLAN_REFUSED');
  assert.deepEqual(got.beforeExit, [true, true, false], '中止时仅恢复原本启用的任务');
  assert.equal(got.mainRunning, true, '中止时恢复原本运行的主任务');
});
// The fake Task Scheduler: Run always queues (state 2, engine 0, the guest's sequence); RunEx runs only with flags 2. Every call is logged,
// RunEx with its arguments ($null shown as null). The cmdlets that would reach the real one are stood in and logged too.
const FAKE_SCHEDULER = `
$global:K3Log = New-Object Collections.ArrayList
$global:K3Task = [pscustomobject]@{ State = 3 }
$global:K3Task | Add-Member -MemberType ScriptMethod -Name Run -Value { param($p) [void]$global:K3Log.Add('run'); [pscustomobject]@{ InstanceGuid = '{q}'; State = 2; EnginePID = 0 } }
$global:K3Task | Add-Member -MemberType ScriptMethod -Name RunEx -Value { param($p, $f, $s, $u)
  $n = { param($v) if ($null -eq $v) { 'null' } elseif ([string]$v -ceq '') { 'empty' } else { [string]$v } }
  [void]$global:K3Log.Add('runex params=' + (& $n $p) + ' flags=' + $f + ' session=' + $s + ' user=' + (& $n $u))
  if ($f -band 2) { [pscustomobject]@{ InstanceGuid = '{r}'; State = 4; EnginePID = 4242 } } else { [pscustomobject]@{ InstanceGuid = '{q}'; State = 2; EnginePID = 0 } } }
$global:K3Folder = [pscustomobject]@{}
$global:K3Folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n) [void]$global:K3Log.Add('task:' + $n); $global:K3Task }
$global:K3Svc = [pscustomobject]@{}
$global:K3Svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { [void]$global:K3Log.Add('connect') }
$global:K3Svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) [void]$global:K3Log.Add('folder:' + $p); $global:K3Folder }
function New-Object { [void]$global:K3Log.Add('new-object:' + ($args -join ' ')); $global:K3Svc }
function Import-Module { }
function Start-ScheduledTask { [void]$global:K3Log.Add('start-scheduledtask') }
function Stop-ScheduledTask { [void]$global:K3Log.Add('stop-scheduledtask') }
`;

test('T8: the reinstall launcher starts the companion task with RunEx($null, 2, 0, $null), never a plain Run or Start-ScheduledTask', opts, () => {
  const got = ps(path.join(RES, 'reinstall', 'launcher', 'template.ps1'), ['Start-CompanionTask'], `${FAKE_SCHEDULER}
Start-CompanionTask
[ordered]@{ log = @($global:K3Log) } | ConvertTo-Json -Compress`);
  assert.deepEqual(got.log, ['new-object:-ComObject Schedule.Service', 'connect', 'folder:\\Clued', 'task:CluedCIResidentCompanion',
    'runex params=null flags=2 session=0 user=null']);
});

test('T9: the uninstall deletes the start task (when there is one) before it stops and deletes the companion task', () => {
  const text = fs.readFileSync(path.join(RES, 'windows', 'uninstall-resident.ps1'), 'utf8');
  const del = text.indexOf("Unregister-ScheduledTask -TaskPath '\\Clued\\' -TaskName 'CluedCIResidentCompanionStart' -Confirm:$false");
  const guard = text.indexOf("if (Get-ScheduledTask -TaskPath '\\Clued\\' -TaskName 'CluedCIResidentCompanionStart' -ErrorAction SilentlyContinue)");
  const stop = text.indexOf("Stop-ScheduledTask -TaskPath '\\Clued\\' -TaskName 'CluedCIResidentCompanion' -ErrorAction Stop");
  const unregister = text.indexOf("Unregister-ScheduledTask -TaskPath '\\Clued\\' -TaskName 'CluedCIResidentCompanion' -Confirm:$false");
  assert.ok(guard > 0 && del > guard, 'the start task is deleted only when it exists (an interactive-definition node has none)');
  assert.ok(stop > 0 && del < stop && stop < unregister, 'deleted before the companion is stopped, so nothing starts it again meanwhile');
  assert.ok(del < text.indexOf('[IO.Directory]::Move($Root'));
});

// verify-resident.ps1: the shape (pure), the reader (fake Schedule.Service) and the check (reader and Register-CompanionStartTask stood in).
const VERIFY = path.join(RES, 'windows', 'verify-resident.ps1');
const HEADLESS = path.join(RES, 'windows', 'companion-headless.ps1');
// The start task's action has one source: companion-headless.ps1 $CompanionStartTaskAction (verify dot-sources that file).
const ACTION = { script: HEADLESS, vars: ['CompanionStartTaskAction'] };
const GOOD = `[ordered]@{ exists = $true; readable = $true; userSid = 'S-1-5-18'; logonType = 5; runLevel = 1; enabled = $true
  triggers = @([ordered]@{ type = 8; delay = 'PT30S'; interval = ''; duration = ''; enabled = $true }, [ordered]@{ type = 1; delay = ''; interval = 'PT15M'; duration = ''; enabled = $true })
  startWhenAvailable = $true; multipleInstances = 2; disallowOnBatteries = $false; stopOnBatteries = $false; executionTimeLimit = 'PT1M'
  actions = @([ordered]@{ type = 0; path = [string]$CompanionStartTaskAction.path; arguments = [string]$CompanionStartTaskAction.arguments })
  dacl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)' }`;

test('T9: the start task\'s shape: SYSTEM, highest, boot +30 s and every 15 minutes, IgnoreNew, one minute, companion-headless.ps1\'s action, SY and BA only', opts, () => {
  const got = psLoad([ACTION, { script: VERIFY, names: ['Get-CompanionStartTaskProblems'] }], `
$good = ${GOOD}
$cases = [ordered]@{}
$cases.good = @(Get-CompanionStartTaskProblems $good)
$cases.absent = @(Get-CompanionStartTaskProblems ([ordered]@{ exists = $false; readable = $true }))
$cases.unreadable = @(Get-CompanionStartTaskProblems ([ordered]@{ exists = $null; readable = $false }))
$edits = [ordered]@{
  principal = { param($f) $f.userSid = 'S-1-5-21-1-2-3-1001' }; 'logon-type' = { param($f) $f.logonType = 1 }; 'run-level' = { param($f) $f.runLevel = 0 }
  disabled = { param($f) $f.enabled = $false }
  'triggers-boot-delay' = { param($f) $f.triggers[0].delay = 'PT0S' }; 'triggers-interval' = { param($f) $f.triggers[1].interval = 'PT1H' }
  'triggers-duration' = { param($f) $f.triggers[1].duration = 'P1D' }; 'triggers-extra' = { param($f) $f.triggers += [ordered]@{ type = 9; delay = ''; interval = ''; duration = ''; enabled = $true } }
  'triggers-off' = { param($f) $f.triggers[0].enabled = $false }
  'start-when-available' = { param($f) $f.startWhenAvailable = $false }; 'multiple-instances' = { param($f) $f.multipleInstances = 0 }
  batteries = { param($f) $f.stopOnBatteries = $true }; 'time-limit' = { param($f) $f.executionTimeLimit = 'PT0S' }
  'action-arguments' = { param($f) $f.actions[0].arguments = '/Run /I /TN "\\Clued\\CluedCIResidentCompanion"' }
  'action-path' = { param($f) $f.actions[0].path = 'C:\\Windows\\System32\\schtasks.exe' }; 'action-two' = { param($f) $f.actions += $f.actions[0] }
  sddl = { param($f) $f.dacl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)' }; 'sddl-unprotected' = { param($f) $f.dacl = 'D:(A;;FA;;;SY)(A;;FA;;;BA)' }
  'sddl-spelled' = { param($f) $f.dacl = 'D:P(A;;0x1f01ff;;;SY)(A;;0x1f01ff;;;BA)' }
}
foreach ($k in $edits.Keys) { $f = ${GOOD}; & $edits[$k] $f; $cases[$k] = @(Get-CompanionStartTaskProblems $f) }
$cases | ConvertTo-Json -Depth 4 -Compress`);
  assert.deepEqual(got.good, []);
  assert.deepEqual(got.absent, ['absent']);
  assert.deepEqual(got.unreadable, ['unreadable']);
  const expect = { principal: 'principal', 'logon-type': 'logon-type', 'run-level': 'run-level', disabled: 'disabled', 'triggers-boot-delay': 'triggers',
    'triggers-interval': 'triggers', 'triggers-duration': 'triggers', 'triggers-extra': 'triggers', 'triggers-off': 'triggers', 'start-when-available': 'start-when-available',
    'multiple-instances': 'multiple-instances', batteries: 'batteries', 'time-limit': 'time-limit', 'action-arguments': 'action', 'action-path': 'action',
    'action-two': 'action', sddl: 'sddl', 'sddl-unprotected': 'sddl' };
  for (const [k, v] of Object.entries(expect)) assert.deepEqual(got[k], [v], k);
  assert.deepEqual(got['sddl-spelled'], [], 'the same ACEs spelled as a mask (as the Task Scheduler may read them back) pass');
});

test('T9: the start task is read from \\Clued\\CluedCIResidentCompanionStart; not found is absent, access denied is unreadable', opts, () => {
  const got = psLoad([ACTION, { script: VERIFY, names: ['Read-CompanionStartTaskFacts', 'Get-CompanionStartTaskProblems'] }], `
function New-Trigger($type, $delay, $interval) { $t = [pscustomobject]@{ Type = $type; Delay = $delay; Enabled = $true; Repetition = [pscustomobject]@{ Interval = $interval; Duration = '' } }; $t }
$def = [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = 'S-1-5-18'; LogonType = 5; RunLevel = 1 }
  Settings = [pscustomobject]@{ Enabled = $true; StartWhenAvailable = $true; MultipleInstances = 2; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false; ExecutionTimeLimit = 'PT1M' }
  Triggers = @((New-Trigger 8 'PT30S' ''), (New-Trigger 1 '' 'PT15M'))
  Actions = @([pscustomobject]@{ Type = 0; Path = [string]$CompanionStartTaskAction.path; Arguments = [string]$CompanionStartTaskAction.arguments }) }
$task = [pscustomobject]@{ Definition = $def; Enabled = $true }
$task | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptor -Value { param($i) 'O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)' }
$folder = [pscustomobject]@{}
$folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n) $script:asked = $n
  if ($script:mode -ceq 'notFound') { throw ([Runtime.InteropServices.COMException]::new('not found', -2147024894)) }
  if ($script:mode -ceq 'denied') { throw ([Runtime.InteropServices.COMException]::new('denied', -2147024891)) }
  $task }
$svc = [pscustomobject]@{}; $svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
$svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) $script:folderAsked = $p; $folder }
function New-Object { if ($args -contains '-ComObject') { $svc } else { Microsoft.PowerShell.Utility\\New-Object @args } }
$r = [ordered]@{}
foreach ($m in @('present', 'notFound', 'denied')) { $script:mode = $m; $f = Read-CompanionStartTaskFacts; $r[$m] = @(Get-CompanionStartTaskProblems $f) }
$r.folder = $script:folderAsked; $r.task = $script:asked
$r | ConvertTo-Json -Depth 4 -Compress`);
  assert.equal(got.folder, '\\Clued');
  assert.equal(got.task, 'CluedCIResidentCompanionStart');
  assert.deepEqual(got.present, []);
  assert.deepEqual(got.notFound, ['absent']);
  assert.deepEqual(got.denied, ['unreadable']);
});

// Review r1 item 2: the definition companion-headless.ps1 Register-CompanionStartTask (its real function) registers, read back by verify's
// reader, has no problem: else every switched node fails verify, and the SYSTEM VERIFY re-registers it and still fails (STILL:action).
// Drill r14 A2 (task 87d330d0, 2026-11-25): the fake Task Scheduler keeps a task's DACL as the guest's does. Registered without
// TASK_DONT_ADD_PRINCIPAL_ACE (0x10), an SDDL lacking the principal's read (A;;FR;;;<principal>) is stored without P and with that ACE
// appended (flags 6: D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;SY), verify read sddl); with 0x10 a protected one is stored as D:PAI(...). An update
// of an existing task ignores the SDDL passed; SetSecurityDescriptor(sddl, flags) stores it by the same rule.
const DACL_SCHEDULER = `
$script:registered = $null; $script:tasks = @{}
# A fresh task definition with the Task Scheduler's defaults; Triggers and Actions keep what Create made (Items).
function New-FakeDefinition {
  $tr = [pscustomobject]@{ Items = [Collections.ArrayList]::new() }
  $tr | Add-Member -MemberType ScriptMethod -Name Create -Value { param($type) $t = [pscustomobject]@{ Type = $type; Delay = ''; Enabled = $true; StartBoundary = ''; Repetition = [pscustomobject]@{ Interval = ''; Duration = '' } }; [void]$this.Items.Add($t); $t }
  $ac = [pscustomobject]@{ Items = [Collections.ArrayList]::new() }
  $ac | Add-Member -MemberType ScriptMethod -Name Create -Value { param($type) $a = [pscustomobject]@{ Type = $type; Path = ''; Arguments = '' }; [void]$this.Items.Add($a); $a }
  [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = ''; LogonType = 0; RunLevel = 0 }
    Settings = [pscustomobject]@{ Enabled = $true; StartWhenAvailable = $false; MultipleInstances = 2; DisallowStartIfOnBatteries = $true; StopIfGoingOnBatteries = $true; ExecutionTimeLimit = 'PT72H' }
    Triggers = $tr; Actions = $ac }
}
function Get-FakeStoredDacl([string]$sddl, [int]$flags, [string]$principal) {
  $m = [regex]::Match($sddl, '^D:([A-Z]*)(\\(.*\\))$'); if (-not $m.Success) { throw ('FAKE_SDDL_UNEXPECTED:' + $sddl) }
  $aces = $m.Groups[2].Value; $own = '(A;;FR;;;' + $principal + ')'
  if (($flags -band 0x10) -or $aces.Contains($own)) { $(if ($m.Groups[1].Value.Contains('P')) { 'D:PAI' } else { 'D:AI' }) + $aces } else { 'D:' + $aces + $own }
}
function New-FakeTask([string]$name) {
  $t = [pscustomobject]@{ Name = $name; Definition = $script:tasks[$name].definition; Enabled = $true }
  $t | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptor -Value { param($i) 'O:BAG:SY' + [string]$script:tasks[$this.Name].dacl }
  $t | Add-Member -MemberType ScriptMethod -Name SetSecurityDescriptor -Value { param($sddl, $flags) $e = $script:tasks[$this.Name]; $e.dacl = Get-FakeStoredDacl $sddl $flags $e.principal }
  $t
}
$folder = [pscustomobject]@{}
$folder | Add-Member -MemberType ScriptMethod -Name RegisterTaskDefinition -Value { param($name, $def, $flags, $user, $password, $logonType, $sddl)
  $read = [pscustomobject]@{ Principal = $def.Principal; Settings = $def.Settings; Triggers = @($def.Triggers.Items); Actions = @($def.Actions.Items) }
  $script:registered = [ordered]@{ name = $name; flags = $flags; logonType = $logonType; sddl = $sddl; definition = $read }
  if ($script:tasks.ContainsKey($name)) { $script:tasks[$name].definition = $read }
  else { $p = $(if ([string]$def.Principal.UserId -ceq 'S-1-5-18') { 'SY' } else { [string]$def.Principal.UserId })
    $script:tasks[$name] = [ordered]@{ definition = $read; principal = $p; dacl = (Get-FakeStoredDacl $sddl $flags $p) } }
  New-FakeTask $name }
$folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n)
  if (-not $script:tasks.ContainsKey($n)) { throw ([Runtime.InteropServices.COMException]::new('not found', -2147024894)) }
  New-FakeTask $n }
$svc = [pscustomobject]@{}
$svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
$svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) if ($p -cne '\\Clued') { throw 'UNEXPECTED_FOLDER' }; $folder }
$svc | Add-Member -MemberType ScriptMethod -Name NewTask -Value { param($f) New-FakeDefinition }
function New-Object { $svc }
`;
const START_LOADS = [{ script: HEADLESS, names: ['Register-CompanionStartTask'], vars: ['CompanionStartTaskName', 'CompanionStartTaskSddl', 'CompanionStartTaskAction'] },
  { script: VERIFY, names: ['Read-CompanionStartTaskFacts', 'Get-CompanionStartTaskProblems', 'Test-CompanionStartTask'] }];
test('T9: what Register-CompanionStartTask registers passes verify\'s start-task check', opts, () => {
  const got = psLoad(START_LOADS, DACL_SCHEDULER + `
$before = @(Get-CompanionStartTaskProblems (Read-CompanionStartTaskFacts))
Register-CompanionStartTask
$after = @(Get-CompanionStartTaskProblems (Read-CompanionStartTaskFacts))
[ordered]@{ before = $before; after = $after; name = $script:registered.name; logonType = $script:registered.logonType; dacl = $script:tasks[$script:registered.name].dacl
  action = [ordered]@{ path = $script:registered.definition.Actions[0].Path; arguments = $script:registered.definition.Actions[0].Arguments } } | ConvertTo-Json -Depth 4 -Compress`);
  assert.deepEqual(got.before, ['absent']);
  assert.equal(got.name, 'CluedCIResidentCompanionStart');
  assert.equal(got.logonType, 5);
  assert.deepEqual(got.after, [], `verify reads what the switch registered (action ${JSON.stringify(got.action)}, DACL ${got.dacl}) with no problem`);
});

// Drill r14 A2: a start task registered the old way (flags 6) has D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;SY); the SYSTEM VERIFY's repair
// (Test-CompanionStartTask calling Register-CompanionStartTask on the existing task) corrects it, not STILL:sddl.
test('T9: a start task with the old DACL is corrected by verify\'s SYSTEM repair (drill r14 A2)', opts, () => {
  const got = psLoad(START_LOADS, DACL_SCHEDULER + `
$seed = New-FakeDefinition
$seed.Principal.UserId = 'S-1-5-18'; $seed.Principal.LogonType = 5; $seed.Principal.RunLevel = 1
$b = $seed.Triggers.Create(8); $b.Delay = 'PT30S'
$t = $seed.Triggers.Create(1); $t.StartBoundary = '2026-01-01T00:00:00'; $t.Repetition.Interval = 'PT15M'
$seed.Settings.MultipleInstances = 2; $seed.Settings.ExecutionTimeLimit = 'PT1M'; $seed.Settings.StartWhenAvailable = $true
$seed.Settings.DisallowStartIfOnBatteries = $false; $seed.Settings.StopIfGoingOnBatteries = $false
$a = $seed.Actions.Create(0); $a.Path = $CompanionStartTaskAction.path; $a.Arguments = $CompanionStartTaskAction.arguments
$null = $folder.RegisterTaskDefinition('CluedCIResidentCompanionStart', $seed, 6, $null, $null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)')
$r = [ordered]@{ seeded = $script:tasks['CluedCIResidentCompanionStart'].dacl; before = @(Get-CompanionStartTaskProblems (Read-CompanionStartTaskFacts)) }
$r.check = Test-CompanionStartTask 'password' $true
$r.dacl = $script:tasks['CluedCIResidentCompanionStart'].dacl
$r.after = @(Get-CompanionStartTaskProblems (Read-CompanionStartTaskFacts))
$r | ConvertTo-Json -Depth 4 -Compress`);
  assert.equal(got.seeded, 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;SY)', 'the fake stores the old way as the guest did');
  assert.deepEqual(got.before, ['sddl']);
  assert.deepEqual(got.check, { ok: true, detail: 'ADDED:sddl' }, `the repair leaves the DACL ${got.dacl}`);
  assert.deepEqual(got.after, []);
});

test('T9: verify requires the start task only under the password definition; as SYSTEM it adds a missing or wrong one first, by hand it only reports', opts, () => {
  const got = psLoad([ACTION, { script: VERIFY, names: ['Test-CompanionStartTask', 'Get-CompanionStartTaskProblems'] }], `
$script:log = New-Object Collections.ArrayList
$good = ${GOOD}
function Read-CompanionStartTaskFacts { [void]$script:log.Add('read'); if ($script:reads.Count) { $f = $script:reads[0]; $script:reads = @($script:reads | Select-Object -Skip 1); $f } else { $good } }
function Register-CompanionStartTask { [void]$script:log.Add('register'); if ($script:registerThrows) { throw 'COMPANION_START_TASK_REGISTER_FAILED' } }
$absent = [ordered]@{ exists = $false; readable = $true }
$denied = [ordered]@{ exists = $null; readable = $false }
$wrong = ${GOOD}; $wrong.actions[0].arguments = '/Run /TN "\\Clued\\CluedCIResidentCompanion"'
function Case([string]$mode, [bool]$asSystem, $reads, [bool]$registerThrows = $false) {
  $script:log.Clear(); $script:reads = @($reads); $script:registerThrows = $registerThrows
  $r = Test-CompanionStartTask $mode $asSystem
  [ordered]@{ ok = $r.ok; detail = $r.detail; log = @($script:log) }
}
[ordered]@{
  interactive = Case 'interactive' $true @($absent)
  other = Case 'other' $true @($absent)
  present = Case 'password' $false @($good)
  handAbsent = Case 'password' $false @($absent)
  handWrong = Case 'password' $false @($wrong)
  handDenied = Case 'password' $false @($denied)
  systemAbsent = Case 'password' $true @($absent, $good)
  systemWrong = Case 'password' $true @($wrong, $good)
  systemStillWrong = Case 'password' $true @($absent, $wrong)
  systemRegisterFails = Case 'password' $true @($absent) $true
} | ConvertTo-Json -Depth 5 -Compress`);
  assert.deepEqual(got.interactive, { ok: true, detail: null, log: [] }, 'the interactive definition starts on log-on: no start task required, nothing read');
  assert.deepEqual(got.other, { ok: true, detail: null, log: [] }, 'an unknown definition fails companion-task already');
  assert.deepEqual(got.present, { ok: true, detail: null, log: ['read'] });
  assert.deepEqual(got.handAbsent, { ok: false, detail: 'absent', log: ['read'] }, 'by hand: reported, never written');
  assert.deepEqual(got.handWrong, { ok: false, detail: 'action', log: ['read'] });
  assert.deepEqual(got.handDenied, { ok: 'unreadable', detail: 'unreadable', log: ['read'] }, 'not elevated: asks for an elevated run');
  assert.deepEqual(got.systemAbsent, { ok: true, detail: 'ADDED:absent', log: ['read', 'register', 'read'] }, 'the upgrade channel adds it, then reads it back');
  assert.deepEqual(got.systemWrong, { ok: true, detail: 'ADDED:action', log: ['read', 'register', 'read'] });
  assert.deepEqual(got.systemStillWrong, { ok: false, detail: 'STILL:action', log: ['read', 'register', 'read'] });
  assert.equal(got.systemRegisterFails.ok, false);
  assert.match(got.systemRegisterFails.detail, /^COMPANION_START_TASK_REGISTER_FAILED/);
  assert.deepEqual(got.systemRegisterFails.log, ['read', 'register']);
});

test('T9: verify records companion-start-task from the companion task\'s mode, as SYSTEM only when run by the upgrade channel', () => {
  const text = fs.readFileSync(VERIFY, 'utf8');
  const facts = text.indexOf('$companionTask = Get-CompanionTaskFacts $Root $companionOwnerSid');
  const check = text.indexOf("$companionStart = Test-CompanionStartTask ([string]$companionTask.mode) ($verifyIdentity.User.Value -ceq 'S-1-5-18')");
  const record = text.indexOf("Record 'companion-start-task' $companionStart.ok $companionStart.detail");
  assert.ok(facts > 0 && check > facts && record > check);
});
