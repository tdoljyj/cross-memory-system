// Drill r12 (task 87d330d0, FABLE-drill-companion-queued-20261124 2.3, line B): the companion account's task instance stayed queued and no
// process started; r11's snapshot could not tell why. What the next failure brings back from the guest, in one round:
//   T9   the snapshot's second layer (the scheduler's whole Operational log, the User Profile Service log, the Application and System
//        errors, the companion account's logon sessions in the Security log, the loaded hives, its ProfileList entry, whether its
//        NTUSER.DAT is held, the Windows build, the logon sessions, the power state, six services, the running tasks, the account's
//        processes); a reader that throws leaves that part unreadable, the others read, the entry's result unchanged
//   T10  the probe tasks P1-P5 in \CluedDrillProbe\ (SYSTEM, the entry's account by S4U, the companion by S4U, the same ignoring the
//        constraints, a new account by password): each ran, queued, failed:<event> or logon-refused; a registration that throws, a run
//        past 60 seconds and a removal that fails never throw, and the snapshot is written
//   T11  no password in the snapshot (the probe account's password is a sentinel here); the snapshot stays within 1 MiB
//   T12  a first install that ends done runs no probe and writes no snapshot; stage-timings.json carries the companion switch's
//        importWatch as companionImport
// The entry's real functions, dot-sourced (definitions only) in Windows PowerShell 5.1. The Task Scheduler, the accounts, the logs, the
// registry, WMI and the services are stood in: this machine's tasks and accounts are never touched (the real probe refuses any machine
// but the drill guest, and that refusal is held here with the stand-ins untouched).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const opts = { skip: !windows, timeout: 240_000 };
const PROBES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const entryScript = fileURLToPath(new URL('../drill/first-install-entry.ps1', import.meta.url));
const listFile = fileURLToPath(new URL('../drill/guest-failure-files.json', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-r12-queued-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// The snippet goes in a file (UTF-8 with a BOM for 5.1), not on the command line: the stand-ins outgrow -EncodedCommand's 32K characters.
let snippets = 0;
function ps(expr) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(entryScript)}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`;
  const file = path.join(tmp, `snippet-${++snippets}.ps1`);
  fs.writeFileSync(file, '﻿' + command, 'utf8');
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 200_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}
const W = "([DateTimeOffset]'2026-11-24T12:00:00Z')";
const SENTINEL = 'PROBE-PASSWORD-SENTINEL-7f3a9c';
const EVIDENCE_KEYS = ['schedulerAll', 'profileService', 'applicationProfile', 'systemEvents', 'securityLogons', 'hiveKeys', 'profileList', 'ntuserDat', 'osVersion',
  'logonSessions', 'power', 'services', 'runningTasks', 'companionProcesses'];

// Every primitive the second layer reads through, stood in: the event logs, the registry, the accounts, files, WMI, services, the
// scheduler's running tasks and the processes. $script:asked records what each was asked.
const evidenceStandIns = `
  $script:asked = New-Object Collections.ArrayList; $script:eventsBroken = $false; $script:eventCount = $null; $script:eventText = $null   # the entry runs strict
  function New-FakeEvent($id, $log, $message) { $e = [pscustomobject]@{ TimeCreated = [datetime]'2026-11-24T12:05:00Z'; Id = $id; LevelDisplayName = 'Information'; Level = 4
      ProviderName = ('provider of ' + $log); ThreadId = 1234; ActivityId = [guid]'0b5e2f3a-1111-2222-3333-444455556666'; Message = $message
      xmlText = ('<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><EventData><Data Name="TargetUserName">clued-companion</Data><Data Name="TargetLogonId">0x2a6f1</Data><Data Name="SubjectUserName">CLUED-DRILL$</Data><Data Name="SubjectLogonId">0x3e7</Data><Data Name="LogonType">4</Data><Data Name="IpAddress">-</Data></EventData></Event>') }
    $e | Add-Member -MemberType ScriptMethod -Name ToXml -Value { $this.xmlText }; $e }
  function Get-EntryWinEvents([string]$LogName, [string]$XPath, [int]$Max) { [void]$script:asked.Add(@('events', $LogName, $XPath, $Max))
    if ($script:eventsBroken) { throw (New-Object UnauthorizedAccessException 'events denied') }
    $n = $(if ($null -ne $script:eventCount) { $script:eventCount } else { 2 })
    @($(if ($n -gt 0) { 1..$n }) | ForEach-Object { New-FakeEvent (100 + $_) $LogName $(if ($script:eventText) { $script:eventText } else { 'event ' + $_ + ' of ' + $LogName }) } | Select-Object -First $Max) }
  function Get-EntryHiveNames { [void]$script:asked.Add(@('hives')); @('.DEFAULT', 'S-1-5-18', 'S-1-5-21-1-2-3-1002', 'clued-p1-0123456789abcdef0123456789abcdef') }
  function Get-EntryAccountSid([string]$Name) { [void]$script:asked.Add(@('sid', $Name)); 'S-1-5-21-1-2-3-1002' }
  function Get-EntryRegistryValues([string]$SubKey, [string[]]$Names) { [void]$script:asked.Add(@('registry', $SubKey, ($Names -join ',')))
    $v = [ordered]@{}; foreach ($n in $Names) { $v[$n] = $(switch ($n) { 'State' { 0 } 'RefCount' { 1 } 'Flags' { 0 } 'ProfileImagePath' { 'C:\\Users\\clued-companion' } 'CurrentBuild' { '26100' } 'UBR' { 2314 } 'DisplayVersion' { '24H2' } 'EditionID' { 'Professional' } }) }; $v }
  function Test-EntryFileShareRead([string]$Path) { [void]$script:asked.Add(@('share', $Path)); [ordered]@{ opened = $false; error = 'The process cannot access the file because it is being used by another process.' } }
  function Get-EntryCim([string]$Class) { [void]$script:asked.Add(@('cim', $Class))
    switch ($Class) {
      'Win32_LogonSession' { @([pscustomobject]@{ LogonId = '999'; LogonType = 0; StartTime = [datetime]'2026-11-24T11:00:00Z' }, [pscustomobject]@{ LogonId = '173809'; LogonType = 4; StartTime = [datetime]'2026-11-24T12:06:00Z' }, [pscustomobject]@{ LogonId = '5000'; LogonType = 4; StartTime = $null }) }
      'Win32_LoggedOnUser' { @([pscustomobject]@{ Antecedent = [pscustomobject]@{ Name = 'clued-companion' }; Dependent = [pscustomobject]@{ LogonId = '173809' } }, [pscustomobject]@{ Antecedent = [pscustomobject]@{ Name = 'SYSTEM' }; Dependent = [pscustomobject]@{ LogonId = '999' } }) }
      'Win32_Battery' { @() }
      default { throw ('not stood in: ' + $Class) } } }
  function Get-EntryAcLine { 'Online' }
  function Get-EntryServiceFacts([string]$Name) { if ($Name -ceq 'TimeBrokerSvc') { throw (New-Object InvalidOperationException 'no such service') }; [ordered]@{ status = 'Running'; startType = 'Automatic' } }
  function Get-EntryRunningTasks { @(1..60 | ForEach-Object { [pscustomobject]@{ Path = ('\\Clued\\Task' + $_); State = 4; EnginePID = 4000 + $_ } }) }
  function Get-EntryAccountProcesses([string]$Account) { [void]$script:asked.Add(@('processes', $Account)); @(1..25 | ForEach-Object { [pscustomobject]@{ Name = 'cmd'; Id = 600 + $_; SessionId = 0; StartTime = [datetime]'2026-11-24T12:06:01Z' } }) }`;

test('T9: the second layer: every part read through its own reader, in the 15 minutes before the snapshot, each bounded', opts, () => {
  const got = ps(`${evidenceStandIns}
    $e = Read-EntryEvidence ${W}
    [ordered]@{ keys = @($e.Keys); e = $e; asked = @($script:asked | ForEach-Object { ,@($_) }); window = $script:EntryEvidenceWindowMinutes }`);
  assert.equal(got.window, 15);
  assert.deepEqual(got.keys, EVIDENCE_KEYS);
  for (const k of EVIDENCE_KEYS) assert.equal(got.e[k].state, 'read', `${k}: ${JSON.stringify(got.e[k])}`);
  const since = "TimeCreated[@SystemTime>='2026-11-24T12:00:00.000Z']";
  const events = got.asked.filter(a => a[0] === 'events').map(a => [a[1], a[2], a[3]]);
  assert.deepEqual(events, [
    ['Microsoft-Windows-TaskScheduler/Operational', `*[System[${since}]]`, 500],
    ['Microsoft-Windows-User Profile Service/Operational', `*[System[${since}]]`, 150],
    ['Application', `*[System[Provider[@Name='Microsoft-Windows-User Profiles Service'] or ((Level=1 or Level=2 or Level=3) and ${since})]]`, 100],
    ['System', `*[System[${since} and ((Level=1 or Level=2 or Level=3) or (Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=1) or Provider[@Name='Microsoft-Windows-Kernel-Power'])]]`, 100],
    ['Security', `*[System[(EventID=4624 or EventID=4625 or EventID=4634 or EventID=4647 or EventID=4648 or EventID=4672) and ${since}]] and *[EventData[Data[@Name='TargetUserName']='clued-companion' or Data[@Name='SubjectUserName']='clued-companion']]`, 100]]);
  // an event: time, id, level, provider, thread, activity, 300 characters of its message
  assert.deepEqual(got.e.schedulerAll.items[0], { at: '2026-11-24T12:05:00.0000000+00:00', id: 101, level: 'Information', provider: 'provider of Microsoft-Windows-TaskScheduler/Operational',
    threadId: 1234, activityId: '0b5e2f3a-1111-2222-3333-444455556666', message: 'event 1 of Microsoft-Windows-TaskScheduler/Operational' });
  // a Security event: its named fields only, with the logon id it is paired by
  assert.deepEqual(got.e.securityLogons.items[0], { at: '2026-11-24T12:05:00.0000000+00:00', id: 101, TargetUserName: 'clued-companion', TargetLogonId: '0x2a6f1', LogonType: '4',
    SubjectUserName: 'CLUED-DRILL$', SubjectLogonId: '0x3e7' });
  assert.deepEqual(got.e.hiveKeys, { state: 'read', error: null, names: ['.DEFAULT', 'S-1-5-18', 'S-1-5-21-1-2-3-1002', 'clued-p1-0123456789abcdef0123456789abcdef'], cluedP1: ['clued-p1-0123456789abcdef0123456789abcdef'] });
  assert.deepEqual(got.e.profileList, { state: 'read', error: null, sid: 'S-1-5-21-1-2-3-1002', present: true, values: { State: 0, RefCount: 1, Flags: 0, ProfileImagePath: 'C:\\Users\\clued-companion' } });
  assert.deepEqual(got.e.ntuserDat, { state: 'read', error: null, path: 'C:\\Users\\clued-companion\\NTUSER.DAT', opened: false, openError: 'The process cannot access the file because it is being used by another process.' });
  assert.deepEqual(got.e.osVersion, { state: 'read', error: null, values: { CurrentBuild: '26100', UBR: 2314, DisplayVersion: '24H2', EditionID: 'Professional' } });
  assert.deepEqual(got.e.logonSessions, { state: 'read', error: null, byType: { 0: 1, 4: 2 }, companion: [{ logonId: '173809', type: 4, start: '2026-11-24T12:06:00.0000000+00:00' }] });
  assert.deepEqual(got.e.power, { state: 'read', error: null, batteries: 0, acLine: 'Online' });
  assert.deepEqual(got.e.services.items.map(s => [s.name, s.status, s.error]), [['Schedule', 'Running', null], ['ProfSvc', 'Running', null], ['UserManager', 'Running', null],
    ['SystemEventsBroker', 'Running', null], ['TimeBrokerSvc', null, 'no such service'], ['seclogon', 'Running', null]]);
  assert.equal(got.e.runningTasks.items.length, 50);
  assert.deepEqual(got.e.runningTasks.items[0], { path: '\\Clued\\Task1', state: 4, enginePid: 4001 });
  assert.equal(got.e.companionProcesses.items.length, 20);
  assert.deepEqual(got.e.companionProcesses.items[0], { name: 'cmd', pid: 601, sessionId: 0, start: '2026-11-24T12:06:01.0000000+00:00' });
  assert.deepEqual(got.asked.filter(a => ['sid', 'share', 'processes'].includes(a[0])), [['sid', 'clued-companion'], ['share', 'C:\\Users\\clued-companion\\NTUSER.DAT'], ['processes', 'clued-companion']]);
  assert.deepEqual(got.asked.filter(a => a[0] === 'registry').map(a => a[1]), ['SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-21-1-2-3-1002', 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion']);
});

test('T9: a reader that throws leaves its part unreadable and every other part read; a log that cannot be read takes only the log parts', opts, () => {
  const got = ps(`${evidenceStandIns}
    $one = [ordered]@{}
    foreach ($k in @($script:EntryEvidenceReaders.Keys)) {
      $readers = [ordered]@{}; foreach ($j in @($script:EntryEvidenceReaders.Keys)) { $readers[$j] = $script:EntryEvidenceReaders[$j] }
      $readers[$k] = [scriptblock]::Create("throw 'reader $k broke'")
      $e = Read-EntryEvidence ${W} $readers
      $one[$k] = @($e.Keys | ForEach-Object { $_ + '=' + $e[$_].state + $(if ($e[$_].error) { ':' + $e[$_].error } else { '' }) })
    }
    $script:eventsBroken = $true
    $logs = Read-EntryEvidence ${W}
    $script:eventsBroken = $false; $script:eventCount = 0
    $none = Read-EntryEvidence ${W}
    [ordered]@{ one = $one; logs = @($logs.Keys | ForEach-Object { $_ + '=' + $logs[$_].state }); logError = $logs.schedulerAll.error; none = $none.schedulerAll }`);
  assert.deepEqual(Object.keys(got.one), EVIDENCE_KEYS);
  for (const k of EVIDENCE_KEYS) {
    assert.deepEqual(got.one[k], EVIDENCE_KEYS.map(j => j === k ? `${j}=unreadable:reader ${k} broke` : `${j}=read`), k);
  }
  const logParts = ['schedulerAll', 'profileService', 'applicationProfile', 'systemEvents', 'securityLogons'];
  assert.deepEqual(got.logs, EVIDENCE_KEYS.map(j => `${j}=${logParts.includes(j) ? 'unreadable' : 'read'}`));
  assert.equal(got.logError, 'events denied');
  assert.deepEqual(got.none, { state: 'read', error: null, items: [] });
});

test('T9: the event queries are accepted by the event log as written (put to the Application log: read-only, no match needed)', opts, () => {
  const got = ps(`$xs = New-Object Collections.ArrayList
    function Get-EntryWinEvents([string]$LogName, [string]$XPath, [int]$Max) { [void]$xs.Add($XPath); @() }
    function Get-EntryAccountSid { throw 'x' }; function Get-EntryHiveNames { @() }; function Get-EntryRegistryValues { $null }; function Test-EntryFileShareRead { @{} }
    function Get-EntryCim { @() }; function Get-EntryAcLine { 'x' }; function Get-EntryServiceFacts { @{} }; function Get-EntryRunningTasks { @() }; function Get-EntryAccountProcesses { @() }
    $null = Read-EntryEvidence ${W}
    @($xs | ForEach-Object { try { [void](Get-WinEvent -LogName Application -FilterXPath $_ -MaxEvents 1 -ErrorAction Stop); 'accepted' }
      catch { if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'accepted' } else { [string]$_.Exception.Message } } })`);
  assert.deepEqual(got, ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
});

// The Task Scheduler stood in: a service with \Clued (holding the companion's definition, whose Settings the probes take) and the probe
// folder, made and removed. Each probe task behaves by its plan: ran (running at once, ready two seconds later, result 0), queued (state 2,
// one instance queued, no engine, result 0: the default a queued instance reads), failed (ready again, result 0x80070002), logon-refused
// (the registration refused 0x80070569), register-throws. The clock moves only when the probe sleeps.
const COMPANION_XML = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>S-1-5-21-1-2-3-1002</UserId><LogonType>Password</LogonType></Principal></Principals><Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Priority>5</Priority><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable></Settings><Actions Context="Author"><Exec><Command>C:\\ProgramData\\CluedIndependentCI\\supervisor.exe</Command></Exec></Actions></Task>`;
const fakeScheduler = ({ plan, companionXml = COMPANION_XML, failDelete = false, step = 1, guard = true }) => `
  $script:probeFake = [pscustomobject]@{ plan = ${'@{' + Object.entries(plan).map(([k, v]) => `${k} = '${v}'`).join('; ') + '}'}; log = (New-Object Collections.ArrayList); xml = @{}; tasks = @{}; tick = 0
    companionXml = ${companionXml === null ? '$null' : q(companionXml)}; probeFolder = $false; failDelete = $${failDelete} }
  $script:clock = [DateTimeOffset]'2026-11-24T12:20:00Z'
  $script:accounts = New-Object Collections.ArrayList
  function Get-FakePhase($t) {
    if ($null -eq $t.runAt) { return 'before' }
    $age = $script:probeFake.tick - $t.runAt
    switch ($t.b) { 'ran' { if ($age -lt 2) { 'running' } else { 'done' } } 'failed' { 'done' } default { if ($t.stopped) { 'done' } else { 'queued' } } } }
  function New-FakeTask($name, $b) {
    $t = [pscustomobject]@{ name = $name; b = $b; runAt = $null; stopped = $false }
    $t | Add-Member -MemberType ScriptProperty -Name State -Value { @{ before = 3; queued = 2; running = 4; done = 3 }[(Get-FakePhase $this)] }
    $t | Add-Member -MemberType ScriptProperty -Name LastTaskResult -Value { $p = Get-FakePhase $this; if ($p -ceq 'before') { 267011 } elseif ($p -ceq 'done' -and $this.b -ceq 'failed') { 2147942402 } else { 0 } }
    $t | Add-Member -MemberType ScriptMethod -Name GetInstances -Value { param($f) $p = Get-FakePhase $this
      if ($p -ceq 'queued') { ,@([pscustomobject]@{ State = 2; EnginePID = 0 }) } elseif ($p -ceq 'running') { ,@([pscustomobject]@{ State = 4; EnginePID = 4242 }) } else { ,@() } }
    $t | Add-Member -MemberType ScriptMethod -Name Run -Value { param($a) [void]$script:probeFake.log.Add('run ' + $this.name); $this.runAt = $script:probeFake.tick; [pscustomobject]@{} }
    $t | Add-Member -MemberType ScriptMethod -Name RunEx -Value { param($a, $flags, $session, $user) [void]$script:probeFake.log.Add('runex ' + $this.name + ' flags=' + $flags + $(if ($null -ne $user) { " user='" + $user + "'" })); $this.runAt = $script:probeFake.tick; [pscustomobject]@{} }
    $t | Add-Member -MemberType ScriptMethod -Name Stop -Value { param($f) [void]$script:probeFake.log.Add('stop ' + $this.name); $this.stopped = $true }
    $t }
  function New-FakeFolder($path) {
    $f = [pscustomobject]@{ path = $path }
    $f | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n) [void]$script:probeFake.log.Add('get-task ' + $this.path + '\\' + $n)
      if ($this.path -ceq '\\Clued' -and $n -ceq 'CluedCIResidentCompanion' -and $null -ne $script:probeFake.companionXml) { return [pscustomobject]@{ Xml = $script:probeFake.companionXml } }
      throw (New-Object IO.FileNotFoundException 'The system cannot find the file specified.') }
    $f | Add-Member -MemberType ScriptMethod -Name CreateFolder -Value { param($n) [void]$script:probeFake.log.Add('create-folder ' + $n); $script:probeFake.probeFolder = $true; New-FakeFolder ('\\' + $n) }
    $f | Add-Member -MemberType ScriptMethod -Name DeleteFolder -Value { param($n, $flags) [void]$script:probeFake.log.Add('delete-folder ' + $n); if ($script:probeFake.failDelete) { throw 'folder removal refused' }; $script:probeFake.probeFolder = $false }
    $f | Add-Member -MemberType ScriptMethod -Name RegisterTask -Value { param($n, $xml, $flags, $user, $password, $logonType)
      [void]$script:probeFake.log.Add(('register {0} flags={1} user={2} password={3} logon={4}' -f $n, $flags, $user, $(if ($null -eq $password -or '' -eq $password) { 'none' } elseif ($password -ceq ${q(SENTINEL)}) { 'sentinel' } else { 'other' }), $logonType))
      $script:probeFake.xml[$n] = $xml
      $b = $script:probeFake.plan[$n]
      if ($b -ceq 'logon-refused') { throw (New-Object Runtime.InteropServices.COMException(('Logon type not granted to the user with password ' + $password), -2147023511)) }
      if ($b -ceq 'register-throws') { throw (New-Object InvalidOperationException ('registration broke ' + $password)) }
      $t = New-FakeTask $n $b; $script:probeFake.tasks[$n] = $t; $t }
    $f | Add-Member -MemberType ScriptMethod -Name DeleteTask -Value { param($n, $flags) [void]$script:probeFake.log.Add('delete-task ' + $n); if ($script:probeFake.failDelete) { throw 'task removal refused' } }
    $f }
  $script:service = [pscustomobject]@{}
  $script:service | Add-Member -MemberType ScriptMethod -Name Connect -Value { [void]$script:probeFake.log.Add('connect') }
  $script:service | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) [void]$script:probeFake.log.Add('get-folder ' + $p)
    if ($p -ceq '\\CluedDrillProbe' -and -not $script:probeFake.probeFolder) { throw (New-Object IO.FileNotFoundException 'The system cannot find the file specified.') }
    New-FakeFolder $p }
  $script:probeAccounts = @{ New = { param($n, $p) [void]$script:accounts.Add('new ' + $n + ' ' + $(if ($p -ceq ${q(SENTINEL)}) { 'sentinel' } else { 'other' })) }; Remove = { param($n) [void]$script:accounts.Add('remove ' + $n) } }
  $script:probeEvents = { param($taskPath, $since) [void]$script:probeFake.log.Add('events ' + $taskPath + ' ' + $since.ToString('o'))
    switch ($taskPath) { '\\CluedDrillProbe\\P1' { if ($script:probeFake.plan['P1'] -ceq 'ran') { @(100, 129, 102) } else { @() } } default { if ($script:probeFake.plan[$taskPath.Split('\\')[-1]] -ceq 'failed') { @(100, 101) } else { @() } } } }
  ${guard ? 'function Test-EntryProbeHost { $true }' : '# the real Test-EntryProbeHost'}
  $script:EntryProbeRunner = { Invoke-EntryProbes -Service $script:service -Accounts $script:probeAccounts -Sleep { $script:probeFake.tick++; $script:clock = $script:clock.AddSeconds(${step}) } -Now { $script:clock } -NewPassword { ${q(SENTINEL)} } -Events $script:probeEvents -EntryUser 'CLUED-DRILL\\drill' }`;

test('T10: five probes, each its own answer: ran, queued, failed:<event>, ran ignoring the constraints, logon-refused', opts, () => {
  const got = ps(`${fakeScheduler({ plan: { P1: 'ran', P2: 'queued', P3: 'failed', P4: 'ran', P5: 'logon-refused', P6: 'logon-refused' } })}
    $r = & $script:EntryProbeRunner
    [ordered]@{ r = $r; log = @($script:probeFake.log); xml = $script:probeFake.xml; accounts = @($script:accounts); folder = $script:probeFake.probeFolder }`);
  const r = got.r;
  assert.equal(r.state, 'run');
  assert.equal(r.settings, 'companion');
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.probes.map(p => [p.id, p.principal, p.logon, p.run, p.outcome]), [
    ['P1', 'system', 'service-account', 'run', 'ran'], ['P2', 'entry', 's4u', 'run', 'queued'], ['P3', 'companion', 's4u', 'run', 'failed:101'],
    ['P4', 'companion', 's4u', 'run-ignore-constraints', 'ran'], ['P5', 'probe-account', 'password', 'run', 'logon-refused'],
    ['P6', 'probe-account', 'password', 'run-ignore-constraints', 'logon-refused']]);
  assert.deepEqual(r.probes.map(p => p.registered), ['ok', 'ok', 'ok', 'ok', 'failed', 'failed']);
  assert.equal(r.probes[4].hresult, '0x80070569');
  assert.deepEqual(r.probes.map(p => p.startedSeen), [true, false, false, true, false, false]);
  assert.deepEqual(r.probes[0].events, [100, 129, 102]);
  assert.deepEqual(r.probes[1].instances, [{ state: 2, enginePid: 0 }], 'the queued one: its instance as last read');
  assert.equal(r.probes[1].lastTaskResult, '0x00000000');
  const log = got.log.filter(l => !l.startsWith('events ') && !l.startsWith('get-'));
  assert.deepEqual(log, ['connect', 'create-folder CluedDrillProbe',
    'register P1 flags=6 user=SYSTEM password=none logon=5', 'register P2 flags=6 user=CLUED-DRILL\\drill password=none logon=2',
    `register P3 flags=6 user=${process.env.COMPUTERNAME ?? ''}\\clued-companion password=none logon=2`,
    `register P4 flags=6 user=${process.env.COMPUTERNAME ?? ''}\\clued-companion password=none logon=2`,
    `register P5 flags=6 user=${process.env.COMPUTERNAME ?? ''}\\clued-drill-probe password=sentinel logon=1`,
    `register P6 flags=6 user=${process.env.COMPUTERNAME ?? ''}\\clued-drill-probe password=sentinel logon=1`,
    'run P1', 'run P2', 'run P3', 'runex P4 flags=2',
    'stop P2', 'delete-task P1', 'delete-task P2', 'delete-task P3', 'delete-task P4', 'delete-folder CluedDrillProbe']);
  assert.ok(got.log.includes('get-task \\Clued\\CluedCIResidentCompanion'), 'the companion\'s own definition was read for its Settings');
  assert.equal(got.folder, false, 'the probe folder is gone');
  assert.deepEqual(got.accounts, ['remove clued-drill-probe', 'new clued-drill-probe sentinel', 'remove clued-drill-probe']);
  // the queued probe kept the full 30 seconds of watching; the clock only moves when the probe sleeps
  assert.equal(r.watchedSeconds, 30);
  // every task: cmd.exe /c exit 0; P1 the default settings as SYSTEM, the others the companion's Settings
  for (const id of PROBES) assert.match(got.xml[id], /<Exec><Command>C:\\Windows\\System32\\cmd\.exe<\/Command><Arguments>\/c exit 0<\/Arguments><\/Exec>/, id);
  assert.match(got.xml.P1, /<UserId>S-1-5-18<\/UserId>/);
  assert.doesNotMatch(got.xml.P1, /<Priority>5<\/Priority>/);
  for (const id of ['P2', 'P3', 'P4', 'P5', 'P6']) assert.match(got.xml[id], /<Settings><DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>.*<Priority>5<\/Priority>/, id);
  assert.match(got.xml.P3, /<LogonType>S4U<\/LogonType>/);
  assert.match(got.xml.P5, /<LogonType>Password<\/LogonType>/);
  assert.match(got.xml.P6, /<LogonType>Password<\/LogonType>/);
  assert.ok(!JSON.stringify(got.r).includes(SENTINEL), 'the password the refusal echoed is not in the answer');
  for (const id of PROBES) assert.ok(!got.xml[id].includes(SENTINEL), `no password in ${id}'s definition`);
});

test('T10: a registration that throws, no companion definition, removals that fail and a run past 60 seconds: answered, never thrown', opts, () => {
  const broken = ps(`${fakeScheduler({ plan: { P1: 'ran', P2: 'register-throws', P3: 'queued', P4: 'queued', P5: 'ran', P6: 'ran' }, companionXml: null, failDelete: true })}
    $r = & $script:EntryProbeRunner
    [ordered]@{ r = $r; accounts = @($script:accounts) }`);
  assert.equal(broken.r.state, 'run');
  assert.equal(broken.r.settings, 'default');
  assert.deepEqual(broken.r.probes.map(p => [p.id, p.registered, p.outcome]), [['P1', 'ok', 'ran'], ['P2', 'failed', 'not-registered'], ['P3', 'ok', 'queued'], ['P4', 'ok', 'queued'], ['P5', 'ok', 'ran'], ['P6', 'ok', 'ran']]);
  assert.match(broken.r.probes[1].error, /registration broke/);
  assert.match(broken.r.cleanup.tasks, /task removal refused/);
  assert.match(broken.r.cleanup.folder, /folder removal refused/);
  assert.equal(broken.r.cleanup.account, 'removed');
  assert.ok(!JSON.stringify(broken.r).includes(SENTINEL));

  // five seconds a tick: the 60-second limit cuts the watching, what was seen is kept and everything is still removed
  const slow = ps(`${fakeScheduler({ plan: { P1: 'queued', P2: 'queued', P3: 'queued', P4: 'queued', P5: 'queued', P6: 'queued' }, step: 5 })}
    $r = & $script:EntryProbeRunner
    [ordered]@{ r = $r; log = @($script:probeFake.log); accounts = @($script:accounts) }`);
  assert.equal(slow.r.timedOut, true);
  assert.ok(slow.r.watchedSeconds < 60, `watched ${slow.r.watchedSeconds}`);
  assert.deepEqual(slow.r.probes.map(p => p.outcome), ['queued', 'queued', 'queued', 'queued', 'queued', 'queued']);
  assert.deepEqual(slow.log.filter(l => /^(stop|delete)/.test(l)), [...PROBES.map(p => 'stop ' + p), ...PROBES.map(p => 'delete-task ' + p), 'delete-folder CluedDrillProbe']);
  assert.deepEqual(slow.accounts.at(-1), 'remove clued-drill-probe');

  // a scheduler that cannot even be reached: the probes are failed, by name, never a throw
  const unreachable = ps(`function Test-EntryProbeHost { $true }
    $svc = [pscustomobject]@{}; $svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { throw 'scheduler unreachable' }
    Invoke-EntryProbes -Service $svc -Accounts @{ New = { throw 'x' }; Remove = { } } -Sleep { } -Now { [DateTimeOffset]::UtcNow } -NewPassword { ${q(SENTINEL)} } -Events { @() }`);
  assert.equal(unreachable.state, 'failed');
  assert.match(unreachable.error, /scheduler unreachable/);
});

test('T10: off the drill guest the probe does nothing at all, the stand-ins untouched', opts, () => {
  const got = ps(`${fakeScheduler({ plan: { P1: 'ran', P2: 'ran', P3: 'ran', P4: 'ran', P5: 'ran', P6: 'ran' }, guard: false })}
    $r = & $script:EntryProbeRunner
    [ordered]@{ r = $r; log = @($script:probeFake.log); accounts = @($script:accounts); host = (Test-EntryProbeHost) }`);
  assert.equal(got.host, false, 'this machine is not the drill guest');
  assert.deepEqual([got.r.state, got.r.error], ['not-run', 'not the drill guest']);
  assert.deepEqual([got.log, got.accounts], [[], []]);
  assert.match(fs.readFileSync(entryScript, 'utf8'), /function Test-EntryProbeHost \{ \$env:COMPUTERNAME -ceq 'CLUED-DRILL' \}/);
});

// The entry's own Get-FirstInstallEntryResult, as drill-r9-entry.test.mjs drives it: the guest check, the release check and the first
// install stood in. Here the guest reader is the entry's own, its parts read through the stand-ins above.
function guest(name) {
  const root = path.join(tmp, name), ci = path.join(root, 'ci'), work = path.join(root, 'bootstrap'), kitDir = path.join(root, 'kit'), out = path.join(root, 'out'), users = path.join(root, 'Users');
  for (const d of [ci, work, kitDir, out, users]) fs.mkdirSync(d, { recursive: true });
  write(path.join(ci, 'resident', 'state', 'status.json'), '{"executor":{"state":"HALTED"}}');
  write(path.join(ci, 'wsl', 'CluedResident-Linux', 'companion-wsl-import-result.json'), '{"contract":"clued.independent-ci.companion-wsl-import-result/1","phase":"complete","exitCode":0}');
  write(path.join(kitDir, 'guest-failure-files.json'), fs.readFileSync(listFile, 'utf8'));
  return { ci, work, kitDir, out, users };
}
const entry = (g, { stop = "throw 'LAUNCHER_STOPPED:COMPANION_HEADLESS_FELL_BACK'", before = '', extra = '$null' } = {}) => `$Work = ${q(g.out)}; $Kit = ${q(g.kitDir)}
  $script:EntryFailureRoots = @{ ci = ${q(g.ci)}; work = $null; users = ${q(g.users)} }
  $script:probeRuns = 0; $script:evidenceWindow = $null
  function Enable-EntryTaskSchedulerLog { [ordered]@{ state = 'enabled'; enabledBefore = $false; error = $null } }
  $script:EntryFailureEventReader = { param($Since, $Max) @() }
  function Read-EntryTaskEvents { 'T' }; function Read-EntryTaskEngineEvents { 'E' }; function Read-EntryLogonEvents { 'L' }; function Read-EntryGuestMemory { 'M' }
  function Read-EntryGuestProcesses { 'P' }; function Read-EntryWslService { 'W' }
  ${before}
  $script:EntryProbeRunnerInner = $script:EntryProbeRunner
  $script:EntryProbeRunner = { $script:probeRuns++; & $script:EntryProbeRunnerInner }
  function Assert-FirstInstallGuest { }; function Assert-FirstInstallRelease { }; function Set-EntryServerBlackhole { }
  function Invoke-FirstInstallAccepted { $script:EntryFailureRoots.work = ${q(g.work)}; ${stop} }
  $before = [DateTimeOffset]::UtcNow
  $r = Get-FirstInstallEntryResult
  [ordered]@{ result = $r; probeRuns = $script:probeRuns; started = $before.ToString('o'); extra = $(${extra}) }`;
const snapshotOf = g => JSON.parse(fs.readFileSync(path.join(g.out, 'resident-failure-snapshot.json'), 'utf8'));

test('T9/T10: a stopped first install: the probes, then the second layer, in the snapshot beside the files; a broken reader changes nothing else', opts, () => {
  const g = guest('t9-entry');
  const got = ps(entry(g, { before: `${evidenceStandIns}
    ${fakeScheduler({ plan: { P1: 'ran', P2: 'ran', P3: 'queued', P4: 'ran', P5: 'ran', P6: 'ran' } })}
    $script:EntryEvidenceReaders['power'] = { param($w) throw 'power reader broke' }
    $script:afterProbes = $null; $script:innerScheduler = $script:EntryEvidenceReaders['schedulerAll']
    $script:EntryEvidenceReaders['schedulerAll'] = { param($w) $script:afterProbes = ($script:probeFake.log -ccontains 'delete-folder CluedDrillProbe'); $script:evidenceWindow = $w; & $script:innerScheduler $w }`,
    extra: "[ordered]@{ afterProbes = $script:afterProbes; window = $(if ($script:evidenceWindow) { $script:evidenceWindow.ToString('o') } else { $null }) }" }));
  got.base = got; got.afterProbes = got.extra.afterProbes; got.window = got.extra.window;
  assert.deepEqual([got.base.result.status, got.base.result.stopCode], ['FIRST_INSTALL_STOPPED', 'LAUNCHER_STOPPED:COMPANION_HEADLESS_FELL_BACK'], 'the entry\'s result is its own');
  assert.equal(got.base.probeRuns, 1);
  assert.equal(got.afterProbes, true, 'the logs are read after the probes, so the probes\' own events are in them');
  // the window: the 15 minutes before the snapshot
  const lag = Date.parse(got.base.started) - Date.parse(got.window);
  assert.ok(lag > 14 * 60_000 && lag < 16 * 60_000, `window ${got.window} against ${got.base.started}`);
  const s = snapshotOf(g);
  assert.deepEqual(Object.keys(s.guest), ['taskSchedulerLog', 'taskEvents', 'engineEvents', 'logons', 'memory', 'processes', 'wslService', 'probes', 'evidence']);
  assert.deepEqual(s.guest.probes.probes.map(p => p.outcome), ['ran', 'ran', 'queued', 'ran', 'ran', 'ran']);
  assert.deepEqual(Object.keys(s.guest.evidence), EVIDENCE_KEYS);
  assert.deepEqual(s.guest.evidence.power, { state: 'unreadable', error: 'power reader broke' });
  for (const k of EVIDENCE_KEYS.filter(k => k !== 'power')) assert.equal(s.guest.evidence[k].state, 'read', k);
  // the import script's own diagnostic is in the list and comes back
  const imp = s.files.filter(f => f.pattern === 'wsl\\*\\companion-wsl-import-result.json');
  assert.deepEqual(imp.map(f => [f.state, JSON.parse(f.text).phase]), [['read', 'complete']]);
  assert.ok(s.files.some(f => f.pattern === 'resident\\state\\status.json' && f.state === 'read'));
});

test('T10: a probe runner and a guest reader that throw: the snapshot is written all the same, the result unchanged', opts, () => {
  const g = guest('t10-thrown');
  const got = ps(entry(g, { before: `${evidenceStandIns}
    $script:EntryProbeRunner = { throw 'probe runner broke' }` }));
  assert.deepEqual([got.result.status, got.result.stopCode], ['FIRST_INSTALL_STOPPED', 'LAUNCHER_STOPPED:COMPANION_HEADLESS_FELL_BACK']);
  const s = snapshotOf(g);
  assert.deepEqual(s.guest.probes, { state: 'failed', error: 'probe runner broke' });
  assert.equal(s.guest.evidence.schedulerAll.state, 'read');
  assert.ok(s.files.length > 0);
});

// Task 87d330d0 K3 (FABLE-drill-companion-k3-20261124 section 5, design T10): P6 is P5's one-off account's password task run ignoring the
// constraints (RunEx 2) -- P5 queued beside P6 ran is K3 itself in one snapshot (experiments R1/R3); the sentinel password never in it.
test('T10 (K3): P6, the probe account\'s password task by RunEx(2), beside P5 by Run: P5 queued, P6 ran; no password in the snapshot', opts, () => {
  const g = guest('t10-k3');
  const got = ps(entry(g, { before: `${evidenceStandIns}
    ${fakeScheduler({ plan: { P1: 'ran', P2: 'ran', P3: 'queued', P4: 'ran', P5: 'queued', P6: 'ran' } })}`, extra: '@($script:probeFake.log)' }));
  assert.deepEqual([got.result.status, got.result.stopCode], ['FIRST_INSTALL_STOPPED', 'LAUNCHER_STOPPED:COMPANION_HEADLESS_FELL_BACK']);
  const log = got.extra;
  assert.ok(log.includes(`register P6 flags=6 user=${process.env.COMPUTERNAME ?? ''}\\clued-drill-probe password=sentinel logon=1`), 'P6: the probe account, its password');
  assert.ok(log.includes('run P5') && log.includes('runex P6 flags=2'), 'P5 by Run, P6 by RunEx ignoring the constraints');
  assert.ok(log.includes('delete-task P6'), 'P6 removed like the others');
  const text = fs.readFileSync(path.join(g.out, 'resident-failure-snapshot.json'), 'utf8');
  assert.ok(!text.includes(SENTINEL));
  const s = JSON.parse(text);
  const p = Object.fromEntries(s.guest.probes.probes.map(x => [x.id, x]));
  assert.deepEqual([p.P5.principal, p.P5.logon, p.P5.run, p.P5.outcome], ['probe-account', 'password', 'run', 'queued']);
  assert.deepEqual([p.P6.principal, p.P6.logon, p.P6.run, p.P6.outcome], ['probe-account', 'password', 'run-ignore-constraints', 'ran']);
  assert.equal(p.P6.startedSeen, true);
});

test('T11: no password anywhere in the snapshot; a snapshot of every part at its limit stays within 1 MiB', opts, () => {
  const g = guest('t11');
  // big files on top: they are what is cut, never past the limit
  for (let i = 1; i <= 12; i++) write(path.join(g.ci, 'reinstall-progress-' + 'c'.repeat(32), String(i).padStart(3, '0') + '-step.json'), 'C'.repeat(60_000));
  const log = ps(entry(g, { before: `${evidenceStandIns}
    $script:eventCount = 600; $script:eventText = (('队' + [char]1) * 150)
    ${fakeScheduler({ plan: { P1: 'ran', P2: 'queued', P3: 'queued', P4: 'queued', P5: 'logon-refused', P6: 'logon-refused' } })}`, extra: '@($script:probeFake.log)' })).extra;
  assert.ok(log.some(l => l.endsWith('password=sentinel logon=1')), 'the sentinel was the probe account\'s password');
  const file = path.join(g.out, 'resident-failure-snapshot.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(SENTINEL), 'the probe account\'s password is not in the snapshot');
  assert.doesNotMatch(text, /"password"\s*:/i);   // no field of that name (P5 is logon "password" by kind)
  const size = fs.statSync(file).size;
  assert.ok(size <= 1048576, `the snapshot is ${size} bytes`);
  const s = JSON.parse(text);
  assert.equal(s.guest.probes.probes[4].outcome, 'logon-refused');
  // every log part is there, read, and what was cut to fit is said
  for (const k of ['schedulerAll', 'profileService', 'applicationProfile', 'systemEvents', 'securityLogons']) assert.equal(s.guest.evidence[k].state, 'read', k);
  assert.ok(Object.values(s.guest.evidence).some(p => typeof p.cut === 'number'), 'what was cut is named');
  assert.ok(s.guest.evidence.schedulerAll.items.length > 0);
});

test('T12: a first install that ends done runs no probe, reads no second layer and writes no snapshot', opts, () => {
  const g = guest('t12-done');
  const got = ps(entry(g, { stop: "[ordered]@{ status = 'FIRST_INSTALL_DONE'; stopCode = $null; tree = 'C:\\tree'; node = 'C:\\node.exe' }", before: `${evidenceStandIns}
    ${fakeScheduler({ plan: { P1: 'ran', P2: 'ran', P3: 'ran', P4: 'ran', P5: 'ran', P6: 'ran' } })}`, extra: '[ordered]@{ log = @($script:probeFake.log); asked = $script:asked.Count; accounts = $script:accounts.Count }' }));
  assert.equal(got.result.status, 'FIRST_INSTALL_DONE');
  assert.deepEqual([got.extra.log, got.extra.asked, got.extra.accounts, got.probeRuns], [[], 0, 0, 0]);
  assert.equal(fs.existsSync(path.join(g.out, 'resident-failure-snapshot.json')), false);
});

test('T12: stage-timings.json carries the companion switch\'s importWatch as companionImport; none, or unreadable, is null', opts, () => {
  const watch = { returned: { instanceGuid: '{95BCDEC3-0000-0000-0000-000000000000}', state: 2, enginePid: 0 }, startedAfterMs: 3120, endedAfterMs: 9800,
    transitions: [{ atMs: 0, taskState: 2, lastTaskResult: 0, instances: [{ state: 2, enginePid: 0 }] }, { atMs: 3120, taskState: 4, lastTaskResult: 0, instances: [{ state: 4, enginePid: 5120 }] }] };
  const run = (name, arrange) => {
    const work = path.join(tmp, 't12-timings', name, 'work'), out = path.join(tmp, 't12-timings', name, 'out');
    fs.mkdirSync(out, { recursive: true }); arrange(work);
    ps(`$m = New-EntryMeasurements; $m.host = 12.5; Write-EntryStageTimings ${q(out)} $m ${q(work)}; 'written'`);
    return JSON.parse(fs.readFileSync(path.join(out, 'stage-timings.json'), 'utf8'));
  };
  const withWatch = run('watch', work => write(path.join(work, 'prepare', 'launch-20261124T120000Z', 'companion-headless.stdout.json'),
    'step one\r\nstep two\r\n' + JSON.stringify({ status: 'COMPANION_HEADLESS_FELL_BACK', result: { failed: 'WSL_IMPORT_FAILED:not-started', importWatch: watch } }) + '\r\n'));
  assert.deepEqual(Object.keys(withWatch), ['assets', 'prereq', 'unpack', 'check', 'host', 'prepare', 'launcher', 'companionImport']);
  assert.equal(withWatch.host, 12.5);
  assert.deepEqual(withWatch.companionImport, watch);
  assert.equal(run('none', work => fs.mkdirSync(work, { recursive: true })).companionImport, null);
  assert.equal(run('torn', work => write(path.join(work, 'prepare', 'launch-20261124T120000Z', 'companion-headless.stdout.json'), '{"status":')).companionImport, null);
  assert.equal(run('no-watch', work => write(path.join(work, 'prepare', 'launch-20261124T120000Z', 'companion-headless.stdout.json'), '{"status":"COMPANION_HEADLESS_DONE","result":{}}')).companionImport, null);
  // no work directory yet (a stop before the prereq stage): null
  const out = path.join(tmp, 't12-timings', 'early'); fs.mkdirSync(out, { recursive: true });
  ps(`Write-EntryStageTimings ${q(out)} (New-EntryMeasurements) $null; 'written'`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'stage-timings.json'), 'utf8')).companionImport, null);
  // the entry writes it on every end, from the bootstrap's own work directory
  const text = fs.readFileSync(entryScript, 'utf8');
  const body = text.slice(text.indexOf('function Invoke-FirstInstallAccepted('), text.indexOf('function Get-FirstInstallEntryResult'));
  assert.match(body, /\} finally \{[\s\S]*Write-EntryStageTimings \$Output \$measurements \$script:EntryFailureRoots\.work/);
});
