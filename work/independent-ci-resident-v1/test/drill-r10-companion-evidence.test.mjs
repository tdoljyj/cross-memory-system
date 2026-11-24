// Drill r10 (task 87d330d0, 2026-11-24): the companion's password task stayed queued (state 2) for the whole qualification and the failure
// snapshot could not say why. The kit entry's side of what the next failure brings back:
//   G1  on the guest, before the first install, the Task Scheduler's Operational log is switched on (it is off on a clean Windows), and
//       what happened is recorded; never a throw
//   G2  the snapshot carries that log's events for the companion's tasks, the companion account's logons (4624) and refused logons (4625)
//       by their named fields only, the guest's memory, its WSL, Hyper-V worker, supervisor and node processes and the WslService service;
//       at most 50 items of 300 characters each, a part that cannot be read named with its error, never taking the others with it
//   G3  that account is counted within the snapshot's 1 MiB, before any file, and a reader that throws leaves the files read
//   G4  the list brings back the companion switch's full answer, the companion's install records and the companion account's supervisor.json
// The entry's real functions, dot-sourced (definitions only) in Windows PowerShell 5.1; every log, CIM class and service is stood in, except
// where a query's own text is put to the local event log or WMI to show it is accepted (read-only, no match needed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const opts = { skip: !windows, timeout: 240_000 };
const entryScript = fileURLToPath(new URL('../drill/first-install-entry.ps1', import.meta.url));
const listFile = fileURLToPath(new URL('../drill/guest-failure-files.json', import.meta.url));
const hostScript = fileURLToPath(new URL('../windows/first-install-host.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-r10-companion-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function ps(expr) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(entryScript)}; ConvertTo-Json -Depth 8 -Compress -InputObject $(${expr})`;
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 200_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}
const SINCE = "([DateTimeOffset]'2026-11-24T08:51:23Z')";
const noMatch = "{ param($x) throw (New-Object Management.Automation.ErrorRecord((New-Object Exception 'none'), 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand', 'ObjectNotFound', $null)) }";
const denied = "{ param($x) throw (New-Object UnauthorizedAccessException 'denied') }";

test('G1: the Operational log is switched on when it is off, left as it is when on, and a refusal is recorded, never thrown', opts, () => {
  const got = ps(`
    function Config($on) { $c = [pscustomobject]@{ IsEnabled = $on; saved = 0 }; $c | Add-Member -MemberType ScriptMethod -Name SaveChanges -Value { $this.saved++ }; $c }
    $off = Config $false; $on = Config $true
    $a = Enable-EntryTaskSchedulerLog { $off }; $b = Enable-EntryTaskSchedulerLog { $on }; $c = Enable-EntryTaskSchedulerLog { throw (New-Object UnauthorizedAccessException 'denied') }
    [ordered]@{ untouched = $script:EntryTaskLog; name = $script:EntryTaskSchedulerLogName; a = $a; off = @($off.IsEnabled, $off.saved); b = $b; on = @($on.IsEnabled, $on.saved); c = $c }`);
  assert.deepEqual(got.untouched, { state: 'not-asked', enabledBefore: null, error: null }, 'nothing is asked by loading the entry');
  assert.equal(got.name, 'Microsoft-Windows-TaskScheduler/Operational');
  assert.deepEqual([got.a, got.off], [{ state: 'enabled', enabledBefore: false, error: null }, [true, 1]]);
  assert.deepEqual([got.b, got.on], [{ state: 'enabled', enabledBefore: true, error: null }, [true, 0]]);
  assert.deepEqual(got.c, { state: 'not-enabled', enabledBefore: null, error: 'denied' });
  // by default the log's own configuration, by that name
  assert.match(fs.readFileSync(entryScript, 'utf8'), /function Enable-EntryTaskSchedulerLog\(\[scriptblock\]\$Config = \{ New-Object Diagnostics\.Eventing\.Reader\.EventLogConfiguration \$script:EntryTaskSchedulerLogName \}\)/);
});

test('G2: the companion tasks\' events: since the entry started, at most 50 of 300 characters, none found is empty, a refusal is named', opts, () => {
  const got = ps(`$script:asked = $null
    $events = 1..60 | ForEach-Object { [pscustomobject]@{ TimeCreated = [datetime]'2026-11-24T09:40:00Z'; Id = 100 + $_; ActivityId = $(if ($_ -eq 1) { [guid]'0b5e2f3a-1111-2222-3333-444455556666' } else { $null })
      Message = ("Task Scheduler queued instance $_ of the task " + ('y' * 400)) } }
    $read = Read-EntryTaskEvents ${SINCE} 50 { param($x) $script:asked = $x; $events }
    [ordered]@{ asked = $script:asked; read = $read; none = (Read-EntryTaskEvents ${SINCE} 50 ${noMatch}); denied = (Read-EntryTaskEvents ${SINCE} 50 ${denied}) }`);
  assert.equal(got.asked, "*[System[TimeCreated[@SystemTime>='2026-11-24T08:51:23.000Z']]] and *[EventData[" +
    ['CluedCIResidentCompanion', 'CluedCIResidentCompanionWslImport', 'CluedCIResidentCompanionFallback', 'CluedCIResidentNotifier'].map(t => `Data[@Name='TaskName']='\\Clued\\${t}'`).join(' or ') + ']]');
  assert.equal(got.read.state, 'read');
  assert.equal(got.read.items.length, 50);
  assert.deepEqual({ ...got.read.items[0], message: undefined }, { at: '2026-11-24T09:40:00.0000000+00:00', id: 101, activityId: '0b5e2f3a-1111-2222-3333-444455556666', message: undefined });
  assert.equal(got.read.items[1].activityId, null);
  assert.ok(got.read.items.every(e => e.message.length === 300) && got.read.items[0].message.startsWith('Task Scheduler queued instance 1 '));
  assert.deepEqual(got.none, { state: 'read', error: null, items: [] });
  assert.deepEqual(got.denied, { state: 'unreadable', error: 'denied', items: [] });
});

test('G2: the companion account\'s logons and refused logons, by their named fields only', opts, () => {
  const ev = (id, data) => `$(& { $e = [pscustomobject]@{ TimeCreated = [datetime]'2026-11-24T09:40:01Z'; Id = ${id}; xmlText = ${q(`<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventID>${id}</EventID></System><EventData>${Object.entries(data).map(([k, v]) => `<Data Name="${k}">${v}</Data>`).join('')}</EventData></Event>`)} }
    $e | Add-Member -MemberType ScriptMethod -Name ToXml -Value { $this.xmlText }; $e })`;
  const got = ps(`$script:asked = $null
    $logon = ${ev(4624, { SubjectUserSid: 'S-1-5-18', SubjectUserName: 'CLUED-DRILL$', TargetUserSid: 'S-1-5-21-1-2-3-1002', TargetUserName: 'clued-companion', TargetLogonId: '0x2a6f1', LogonType: '4', LogonProcessName: 'Advapi  ', AuthenticationPackageName: 'Negotiate', ProcessName: 'C:\\Windows\\System32\\svchost.exe', IpAddress: '-', ElevatedToken: '%%1843' })}
    $refused = ${ev(4625, { TargetUserSid: 'S-1-0-0', TargetUserName: 'clued-companion', Status: '0xc000006d', SubStatus: '0xc000006a', FailureReason: '%%2313', LogonType: '4', IpAddress: '-' })}
    $read = Read-EntryLogonEvents ${SINCE} 50 { param($x) $script:asked = $x; $logon; $refused }
    [ordered]@{ asked = $script:asked; read = $read; none = (Read-EntryLogonEvents ${SINCE} 50 ${noMatch}); denied = (Read-EntryLogonEvents ${SINCE} 50 ${denied}) }`);
  assert.equal(got.asked, "*[System[(EventID=4624 or EventID=4625) and TimeCreated[@SystemTime>='2026-11-24T08:51:23.000Z']]] and *[EventData[Data[@Name='TargetUserName']='clued-companion']]");
  assert.deepEqual(got.read, { state: 'read', error: null, items: [
    { at: '2026-11-24T09:40:01.0000000+00:00', id: 4624, TargetUserSid: 'S-1-5-21-1-2-3-1002', TargetUserName: 'clued-companion', TargetLogonId: '0x2a6f1', LogonType: '4',
      LogonProcessName: 'Advapi', AuthenticationPackageName: 'Negotiate', ProcessName: 'C:\\Windows\\System32\\svchost.exe' },
    { at: '2026-11-24T09:40:01.0000000+00:00', id: 4625, TargetUserSid: 'S-1-0-0', TargetUserName: 'clued-companion', Status: '0xc000006d', SubStatus: '0xc000006a', FailureReason: '%%2313', LogonType: '4' }] });
  assert.deepEqual(got.none, { state: 'read', error: null, items: [] });
  assert.deepEqual(got.denied, { state: 'unreadable', error: 'denied', items: [] });
  // the account is the one the host creates
  assert.match(fs.readFileSync(hostScript, 'utf8'), /\$CompanionAccountName = 'clued-companion'/);
});

test('G2: both event queries are accepted by the event log as written (put to the Application log: read-only, no match needed)', opts, () => {
  const got = ps(`@((Get-EntryTaskEventsXPath ${SINCE}), (Get-EntryLogonEventsXPath ${SINCE}) | ForEach-Object {
    try { [void](Get-WinEvent -LogName Application -FilterXPath $_ -MaxEvents 1 -ErrorAction Stop); 'accepted' }
    catch { if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'accepted' } else { [string]$_.Exception.Message } } })`);
  assert.deepEqual(got, ['accepted', 'accepted']);
});

test('G2: the memory, the processes (sorted, at most 50) and the WslService service, each with its own error', opts, () => {
  const got = ps(`$script:filter = $null
    $procs = @([pscustomobject]@{ Name = 'vmmemWSL'; ProcessId = 9000; ParentProcessId = 4; SessionId = 0; CreationDate = [datetime]'2026-11-24T09:00:00Z'; WorkingSetSize = 2147483648 },
      [pscustomobject]@{ Name = 'CluedCompanionSupervisor.exe'; ProcessId = 812; ParentProcessId = 1200; SessionId = 0; CreationDate = [datetime]'2026-11-24T09:40:05Z'; WorkingSetSize = 10485760 }) +
      @(1..60 | ForEach-Object { [pscustomobject]@{ Name = 'node.exe'; ProcessId = 7000 - $_; ParentProcessId = 812; SessionId = 0; CreationDate = $null; WorkingSetSize = 1024 } })
    [ordered]@{
      memory = (Read-EntryGuestMemory { [pscustomobject]@{ TotalVisibleMemorySize = 8388608; FreePhysicalMemory = 204800; TotalVirtualMemorySize = 9437184; FreeVirtualMemory = 307200 } })
      noMemory = (Read-EntryGuestMemory { throw (New-Object UnauthorizedAccessException 'denied') })
      processes = (Read-EntryGuestProcesses 50 { param($f) $script:filter = $f; $procs })
      noProcesses = (Read-EntryGuestProcesses 50 { param($f) throw (New-Object UnauthorizedAccessException 'denied') })
      filter = $script:filter
      wsl = (Read-EntryWslService { [pscustomobject]@{ Status = 'Running'; StartType = 'Automatic' } })
      noWsl = (Read-EntryWslService { throw (New-Object InvalidOperationException 'no WslService') })
      wqlAccepted = $(try { [void]@(Get-CimInstance -ClassName Win32_Process -Filter (Get-EntryGuestProcessFilter) -ErrorAction Stop); $true } catch { [string]$_.Exception.Message }) }`);
  assert.deepEqual(got.memory, { state: 'read', error: null, totalVisibleKb: 8388608, freePhysicalKb: 204800, totalVirtualKb: 9437184, freeVirtualKb: 307200 });
  assert.deepEqual(got.noMemory, { state: 'unreadable', error: 'denied' });
  assert.equal(got.filter, ['wsl.exe', 'wslhost.exe', 'wslservice.exe', 'wslrelay.exe', 'vmmem', 'vmmemWSL', 'vmwp.exe', 'CluedCompanionSupervisor.exe', 'node.exe'].map(n => `Name='${n}'`).join(' OR '));
  assert.equal(got.wqlAccepted, true, 'WMI accepts the filter as written');
  assert.equal(got.processes.state, 'read');
  assert.equal(got.processes.items.length, 50);
  assert.deepEqual(got.processes.items[0], { name: 'CluedCompanionSupervisor.exe', pid: 812, parentPid: 1200, sessionId: 0, created: '2026-11-24T09:40:05.0000000+00:00', workingSetKb: 10240 });
  assert.deepEqual(got.processes.items.slice(1, 3).map(p => [p.name, p.pid, p.created]), [['node.exe', 6940, null], ['node.exe', 6941, null]]);
  assert.deepEqual(got.noProcesses, { state: 'unreadable', error: 'denied', items: [] });
  assert.deepEqual(got.wsl, { state: 'read', error: null, status: 'Running', startType: 'Automatic' });
  assert.deepEqual(got.noWsl, { state: 'unreadable', error: 'no WslService' });
});

test('G2: the guest reader puts the parts together, with the entry\'s start, the limit and what G1 recorded', opts, () => {
  const got = ps(`$script:calls = New-Object Collections.ArrayList
    function Read-EntryTaskEvents([DateTimeOffset]$Since, [int]$Max) { [void]$script:calls.Add("tasks $($Since.ToString('o')) $Max"); 'T' }
    function Read-EntryLogonEvents([DateTimeOffset]$Since, [int]$Max) { [void]$script:calls.Add("logons $($Since.ToString('o')) $Max"); 'L' }
    function Read-EntryGuestMemory { 'M' }
    function Read-EntryGuestProcesses([int]$Max) { [void]$script:calls.Add("processes $Max"); 'P' }
    function Read-EntryWslService { 'W' }
    $script:EntryTaskLog = [ordered]@{ state = 'enabled'; enabledBefore = $false; error = $null }
    $g = & $script:EntryFailureGuestReader ${SINCE} 50
    [ordered]@{ keys = @($g.Keys); guest = $g; calls = @($script:calls) }`);
  assert.deepEqual(got.keys, ['taskSchedulerLog', 'taskEvents', 'logons', 'memory', 'processes', 'wslService']);
  assert.deepEqual(got.guest, { taskSchedulerLog: { state: 'enabled', enabledBefore: false, error: null }, taskEvents: 'T', logons: 'L', memory: 'M', processes: 'P', wslService: 'W' });
  assert.deepEqual(got.calls, ['tasks 2026-11-24T08:51:23.0000000+00:00 50', 'logons 2026-11-24T08:51:23.0000000+00:00 50', 'processes 50']);
});

test('G3: the guest\'s account is in the snapshot and counted within its 1 MiB before any file; a reader that throws leaves the files read', opts, () => {
  const ci = path.join(tmp, 'g3', 'ci');
  for (const n of ['a', 'b', 'c']) write(path.join(ci, 'big', `${n}.json`), n.repeat(60_000));
  const list = path.join(tmp, 'g3', 'list.json');
  write(list, JSON.stringify({ contract: 'clued.drill.guest-failure-files/1', files: [{ root: 'ci', path: 'big\\*.json' }] }));
  const run = (name, reader) => {
    const out = path.join(tmp, 'g3', name); fs.mkdirSync(out, { recursive: true });
    ps(`Write-EntryFailureSnapshot ${q(out)} ${q(list)} @{ ci = ${q(ci)} } ${SINCE} ([ordered]@{ status = 'FIRST_INSTALL_STOPPED'; stopCode = 'LAUNCHER_STOPPED:COMPANION' }) { param($s, $m) @() } ${reader}`);
    const file = path.join(out, 'resident-failure-snapshot.json');
    return { s: JSON.parse(fs.readFileSync(file, 'utf8')), size: fs.statSync(file).size };
  };
  const small = run('small', "{ param($s, $m) [ordered]@{ taskSchedulerLog = [ordered]@{ state = 'enabled' }; asked = @($s.ToString('o'), $m) } }");
  assert.deepEqual(small.s.guest, { taskSchedulerLog: { state: 'enabled' }, asked: ['2026-11-24T08:51:23.0000000+00:00', 50] });
  assert.deepEqual(small.s.files.map(f => f.state), ['read', 'read', 'read']);
  // a guest account of 900 000 characters leaves room for two of the three files
  const large = run('large', "{ param($s, $m) [ordered]@{ blob = ('G' * 900000) } }");
  assert.deepEqual(large.s.files.map(f => f.state), ['read', 'read', 'over-total-limit']);
  assert.ok(large.size <= 1048576, `the snapshot is ${large.size} bytes`);
  const thrown = run('thrown', "{ param($s, $m) throw 'guest reader broke' }");
  assert.deepEqual(thrown.s.guest, { state: 'unreadable', error: 'guest reader broke' });
  assert.deepEqual(thrown.s.files.map(f => f.state), ['read', 'read', 'read']);
});

test('G4: the list brings back the companion switch\'s answer, its install records and the companion account\'s supervisor.json', opts, () => {
  const root = path.join(tmp, 'g4');
  const ci = path.join(root, 'ci'), work = path.join(root, 'work'), users = path.join(root, 'Users');
  write(path.join(work, 'prepare', 'launch-20261124T085123Z', 'companion-headless.stdout.json'), '{"status":"COMPANION_HEADLESS_FELL_BACK","result":{"qualification":{"supervisorCounts":"0,0"}}}');
  write(path.join(ci, 'resident', 'install', 'companion-headless-pending.json'), '{"mode":"account"}');
  write(path.join(ci, 'resident', 'install', 'companion-account.json'), '{"companionSid":"S-1-5-21-1-2-3-1002"}');
  write(path.join(ci, 'resident', 'install', 'companion-build-0123', 'x.json'), '{"code":"NOT-A-RECORD"}');
  write(path.join(users, 'clued-companion', 'AppData', 'Local', 'CluedIndependentCI', 'supervisor.json'), '{"code":"SUPERVISOR_TOKEN_REFUSED"}');
  write(path.join(users, 'clued-companion.CLUED-DRILL', 'AppData', 'Local', 'CluedIndependentCI', 'supervisor.json'), '{"code":"SUPERVISOR_CHILD_EXITED"}');
  write(path.join(users, 'Owner', 'AppData', 'Local', 'CluedIndependentCI', 'supervisor.json'), '{"code":"NOT-THE-COMPANION"}');
  const out = path.join(root, 'out'); fs.mkdirSync(out, { recursive: true });
  ps(`Write-EntryFailureSnapshot ${q(out)} ${q(listFile)} @{ ci = ${q(ci)}; work = ${q(work)}; users = ${q(users)} } ${SINCE} ([ordered]@{ status = 'FIRST_INSTALL_STOPPED'; stopCode = 'x' }) { param($s, $m) @() } { param($s, $m) [ordered]@{} }`);
  const s = JSON.parse(fs.readFileSync(path.join(out, 'resident-failure-snapshot.json'), 'utf8'));
  const read = s.files.filter(f => f.state === 'read').map(f => [f.root, path.relative({ ci, work, users }[f.root], f.path), JSON.parse(f.text)]);
  assert.deepEqual(read.filter(r => r[1].includes('companion') || r[1].includes('supervisor')), [
    ['work', 'prepare\\launch-20261124T085123Z\\companion-headless.stdout.json', { status: 'COMPANION_HEADLESS_FELL_BACK', result: { qualification: { supervisorCounts: '0,0' } } }],
    ['ci', 'resident\\install\\companion-account.json', { companionSid: 'S-1-5-21-1-2-3-1002' }],
    ['ci', 'resident\\install\\companion-headless-pending.json', { mode: 'account' }],
    ['users', 'clued-companion\\AppData\\Local\\CluedIndependentCI\\supervisor.json', { code: 'SUPERVISOR_TOKEN_REFUSED' }],
    ['users', 'clued-companion.CLUED-DRILL\\AppData\\Local\\CluedIndependentCI\\supervisor.json', { code: 'SUPERVISOR_CHILD_EXITED' }]]);
  assert.doesNotMatch(JSON.stringify(s), /NOT-THE-COMPANION|NOT-A-RECORD/, 'no other account\'s profile, nothing inside a build directory');
  // on the guest the profiles are C:\Users
  assert.equal(ps('$script:EntryFailureRoots.users'), 'C:\\Users');
});
