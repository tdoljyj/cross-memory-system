// The host watchdog must not stop the Linux runners for low capacity unseen
// (defect 2102f7e1: they stood still for 86 minutes, only the log said why).
// The watchdog is rendered by render-host-watchdog.ps1 and run by Windows
// PowerShell 5.1; these tests render it for the company-primary host, check what
// the rendered script does on suspend, reminder and resume, and run its alert block
// in 5.1. Windows only. The notification itself is shown only when
// CLUED_TEST_TOAST=1 (it puts a notification on the desktop).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, 'render-host-watchdog.ps1');
const available = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '1'], { windowsHide: true }).status === 0;
const skip = available ? false : 'needs Windows PowerShell';
const powershell = (args, env = {}) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });

function render(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-alert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'watchdog.ps1');
  const result = powershell(['-File', RENDERER, '-HostId', 'company-primary', '-OutputPath', out]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { dir, out, text: fs.readFileSync(out, 'utf8') };
}

// the alert block with a log and a marker file of the test
function harness(dir, text, body) {
  const block = /# BEGIN capacity-alert\r?\n([\s\S]*?)# END capacity-alert/.exec(text)?.[1];
  assert.ok(block, 'the alert block is in the rendered script');
  const log = path.join(dir, 'log.txt');
  const marker = path.join(dir, 'state', 'capacity-alert.json');
  const file = path.join(dir, 'harness.ps1');
  fs.writeFileSync(file, [
    "$ErrorActionPreference = 'Stop'",
    `$log = '${log}'; function Log([string]$m) { Add-Content -LiteralPath $log -Value $m }`,
    block,
    `$alertFile = '${marker}'`,
    body(marker),
  ].join('\n'));
  return { file, log, marker };
}

test('the rendered watchdog parses (Windows PowerShell 5.1) and alerts on every capacity suspend, reminds while it lasts, clears on resume and at a start without a hold', { skip }, (t) => {
  const { out, text } = render(t);
  const parsed = powershell(['-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${out.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`]);
  assert.equal(parsed.stdout.trim(), '0', 'no parse error');
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.ok(index >= 0, `the watchdog has: ${needle}`);
    return index;
  };
  // the suspend, with its alert right after, in the branch that stops the runners
  assert.ok(at("Send-CapacityAlert 'Suspend'") > at('Log ("Capacity suspend:') && at("Send-CapacityAlert 'Suspend'") < at('Capacity resume:'));
  assert.ok(text.indexOf("Send-CapacityAlert 'Resume'", at('Log ("Capacity resume:')) > 0, 'the resume alert follows the resume');
  assert.ok(at("Send-CapacityAlert 'Reminder'") > at("Send-CapacityAlert 'Resume'"));
  assert.match(text, /if\(\(\(Get-Date\)-\$lastAlert\)\.TotalMinutes -ge \$alertEveryMinutes\)\{Send-CapacityAlert 'Reminder'/);
  assert.match(text, /if\(\$firstLoop\)\{\$firstLoop=\$false; if\(-not \$capacitySuspended\)\{Clear-StaleCapacityAlert\}\}/, 'the first look clears a marker when nothing is held back');
  // the levels the alert names are the capacity profile's
  const profiles = JSON.parse(fs.readFileSync(path.join(HERE, 'node-profiles.json'), 'utf8'));
  const host = profiles.hosts.find((entry) => entry.host_id === 'company-primary');
  const capacity = profiles.capacity_profiles[host.capacity_profile];
  assert.ok(text.includes(`$suspendDisk=${capacity.suspend_c_free_gb}; $resumeDisk=${capacity.resume_c_free_gb};`));
  assert.ok(text.includes(`$suspendRunnerDisk=${capacity.suspend_runner_disk_free_gb}; $resumeRunnerDisk=${capacity.resume_runner_disk_free_gb};`));
  assert.match(text, /Log \("Thresholds: the runner disk stops below \{0\} GB, resumes at \{1\} GB \(after a cleanup first\); memory stops below \{2\} GB, resumes at \{3\} GB; C: only alerts below \{4\} GB, clears at \{5\} GB" -f \$suspendRunnerDisk,\$resumeRunnerDisk,\$suspendMem,\$resumeMem,\$suspendDisk,\$resumeDisk\)/, 'a start logs the levels it works with');
});

test('the alert block: an ALERT line, a marker file (UTF-8 without a byte order mark) while suspended, kept since the first alert, removed on resume', { skip }, (t) => {
  const { dir, text } = render(t);
  const { file, log, marker } = harness(dir, text, (target) => [
    "Send-CapacityAlert 'Suspend' 'C: 49.8 GB free'",
    `$first = Get-Content -LiteralPath '${target}' -Raw | ConvertFrom-Json`,
    'Start-Sleep -Milliseconds 1100',
    "Send-CapacityAlert 'Reminder' 'C: 51.0 GB free'",
    `$again = Get-Content -LiteralPath '${target}' -Raw | ConvertFrom-Json`,
    "[pscustomobject]@{ state = $first.state; detail = $first.detail; sinceKept = ($first.since -eq $again.since); detailNow = $again.detail } | ConvertTo-Json -Compress",
    `Copy-Item -LiteralPath '${target}' -Destination '${target}.copy'`,
    "Send-CapacityAlert 'Resume' 'C: 70.0 GB free'",
    `'gone=' + -not (Test-Path -LiteralPath '${target}')`,
  ].join('\n'));
  const result = powershell(['-File', file], { CLUED_WATCHDOG_NO_TOAST: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const [json, gone] = result.stdout.trim().split(/\r?\n/);
  assert.deepEqual(JSON.parse(json), { state: 'capacity-suspended', detail: 'C: 49.8 GB free', sinceKept: true, detailNow: 'C: 51.0 GB free' });
  assert.equal(gone, 'gone=True', 'the marker is removed on resume');
  const bytes = fs.readFileSync(`${marker}.copy`);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'no byte order mark');
  assert.equal(JSON.parse(bytes.toString('utf8')).state, 'capacity-suspended', 'any JSON reader takes it');
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.match(lines[0], /^ALERT Suspend: Linux runners are stopped for low capacity \(C: 49\.8 GB free\)$/);
  assert.match(lines[1], /^ALERT Reminder: /);
  assert.match(lines[2], /^ALERT cleared: runners resumed \(C: 70\.0 GB free\)$/);
});

test('a marker an earlier watchdog left is removed by one that starts with the runners running, and only then', { skip }, (t) => {
  const { dir, text } = render(t);
  const { file, log, marker } = harness(dir, text, (target) => [
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${target}') | Out-Null`,
    `Set-Content -LiteralPath '${target}' -Value '{"state":"capacity-suspended"}'`,
    'Clear-StaleCapacityAlert',
    `'cleared=' + -not (Test-Path -LiteralPath '${target}')`,
    'Clear-StaleCapacityAlert',
  ].join('\n'));
  const result = powershell(['-File', file], { CLUED_WATCHDOG_NO_TOAST: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trim(), 'cleared=True');
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/), ['ALERT marker of an earlier watchdog removed: the runners are not held back'], 'said once, nothing when there was none');
});

test('a marker that cannot be written does not hide the alert: the ALERT line says so, the next try is in 5 minutes; a restart while held back keeps the time the hold began', { skip }, (t) => {
  const { dir, text } = render(t);
  const { file, log, marker } = harness(dir, text, (target) => [
    // the file the marker is written to first is a directory: writing it fails
    `New-Item -ItemType Directory -Force -Path '${target}.tmp' | Out-Null`,
    "Send-CapacityAlert 'Suspend' 'C: 49.8 GB free'",
    "'minutes=' + [int](((Get-Date) - $lastAlert).TotalMinutes)",
    `Remove-Item -LiteralPath '${target}.tmp' -Recurse -Force`,
    "$holdSince = '2026-11-05T01:00:00.0000000+08:00'",
    "Send-CapacityAlert 'Reminder' 'C: 51.0 GB free'",
    `'since=' + (Get-Content -LiteralPath '${target}' -Raw | ConvertFrom-Json).since`,
    "'minutes2=' + [int](((Get-Date) - $lastAlert).TotalMinutes)",
  ].join('\n'));
  const result = powershell(['-File', file], { CLUED_WATCHDOG_NO_TOAST: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['minutes=25', 'since=2026-11-05T01:00:00.0000000+08:00', 'minutes2=0'], 'a failed write is tried again after 5 minutes (30 - 25 elapsed); the first alert of a restart takes the hold\'s start from the state');
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.match(lines[0], /^ALERT Suspend: Linux runners are stopped for low capacity \(C: 49\.8 GB free\) \(the marker file was not written: /);
  assert.match(lines[1], /^ALERT Reminder: .*C: 51\.0 GB free\)$/);
  assert.equal(fs.existsSync(marker), true, 'written at the second try');
});

test('the notification (Windows PowerShell 5.1) uses a registered application id and raises no error', { skip: skip || (process.env.CLUED_TEST_TOAST === '1' ? false : 'set CLUED_TEST_TOAST=1: it shows a notification on the desktop') }, (t) => {
  const { dir, text } = render(t);
  const { file, log } = harness(dir, text, () => "Show-Toast '[test] Clued CI watchdog notification check' 'defect 2102f7e1: ignore this test notification'");
  const result = powershell(['-File', file], { CLUED_WATCHDOG_NO_TOAST: '' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const logged = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.doesNotMatch(logged, /Alert notification failed/, logged);
  const registered = powershell(['-Command', "Test-Path 'HKCU:\\Software\\Classes\\AppUserModelId\\Clued CI watchdog'"]);
  assert.equal(registered.stdout.trim(), 'True');
});

// Owner decision 241824b2 (2026-11-08): the runners stop at 15 GB free on the disk that holds
// their own distribution's virtual disk and start again at 20 GB, after a cleanup first; C:
// below 15 GB only alerts (it holds the resident CI's distribution, not the runners'). The
// profile, the tools that read it and the text that describes it say the same.
test('Owner decision 241824b2: the workstation profile stops the runners at 15 GB on their own disk, resumes at 20, C: only alerts, and every reader says so', () => {
  const workstation = profiles().capacity_profiles['workstation-v1'];
  assert.equal(workstation.suspend_runner_disk_free_gb, 15);
  assert.equal(workstation.resume_runner_disk_free_gb, 20);
  assert.equal(workstation.suspend_c_free_gb, 15);
  assert.equal(workstation.resume_c_free_gb, 20);
  const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
  assert.match(readme, /capacity suspend: host free memory < 6 GB or runner disk free < 15 GB \(after a cleanup first\)\r?\ncapacity resume:  host free memory >= 10 GB and runner disk free >= 20 GB\r?\nC: alert only:    C: free < 15 GB, cleared at >= 20 GB/);
  const runbook = fs.readFileSync(path.join(HERE, '..', '..', '..', 'docs', 'maintenance', 'runner-configuration-and-operations.md'), 'utf8');
  assert.match(runbook, /≥ 10 GiB \*\*且\*\* runner 盘 ≥ 20 GiB/);
  assert.doesNotMatch(runbook, /≥ 10 GiB \*\*且\*\* ≥ 60 GiB/);
});

test('local-verify reads the 20 GB C: level of the real profile for the company host', async () => {
  const { watchdogLevels } = await import('../local-verify.mjs');
  const company = profiles().hosts.find((host) => host.host_id === 'company-primary');
  const levels = watchdogLevels({ hostname: company.hostname, env: {}, profilesFile: path.join(HERE, 'node-profiles.json'), readText: (file) => {
    if (file === company.watchdog_path) throw new Error('not installed in this test');
    return fs.readFileSync(file, 'utf8');
  } });
  assert.deepEqual(levels, { suspend: 15, resume: 20 });
});

function profiles() { return JSON.parse(fs.readFileSync(path.join(HERE, 'node-profiles.json'), 'utf8')); }

// The capacity step of the rendered company-primary watchdog, run in Windows PowerShell 5.1 with
// its levels and alert block, and with the parts that touch WSL, the drives and the desktop
// replaced: what it measures comes from `caps` (one entry per Get-Capacity call), and every
// cleanup, stop, start and alert is recorded in order.
function step(t, { caps, busy = false, active = [], state = null, body }) {
  const { dir, text } = render(t);
  const block = (name) => {
    const found = new RegExp(`# BEGIN ${name}\\r?\\n([\\s\\S]*?)# END ${name}`).exec(text)?.[1];
    assert.ok(found, `the ${name} block is in the rendered script`);
    return found;
  };
  const levels = /^\$suspendMem=.*$/m.exec(text)?.[0];
  assert.ok(levels, 'the levels line is in the rendered script');
  const log = path.join(dir, 'log.txt');
  const stateFile = path.join(dir, 'state', 'watchdog.state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  const ps = (value) => (value === null ? '$null' : String(value));
  const capList = caps.map((c) => `@{Mem=${ps(c.mem ?? 30)};CFree=${ps(c.c ?? 48)};Drive='${c.drive ?? 'D'}';Free=${ps(c.disk === undefined ? 2000 : c.disk)}}`).join(',');
  const file = path.join(dir, 'step.ps1');
  fs.writeFileSync(file, [
    "$ErrorActionPreference = 'Stop'",
    `$log = '${log}'; function Log([string]$m) { Add-Content -LiteralPath $log -Value $m }`,
    "$lastDeferral=''",
    levels,
    block('capacity-alert'),
    block('capacity-step'),
    `$alertFile = '${path.join(dir, 'state', 'capacity-alert.json')}'; $stateFile = '${stateFile}'; $forceResumeFile = '${path.join(dir, 'state', 'force-resume')}'`,
    '$events = New-Object System.Collections.ArrayList; $details = New-Object System.Collections.ArrayList',
    `$caps = New-Object System.Collections.Queue; foreach ($c in @(${capList})) { $caps.Enqueue($c) }`,
    'function Get-Capacity { [pscustomobject]$script:caps.Dequeue() }',
    `function Test-LinuxBusy { ${busy ? '$true' : '$false'} }`,
    `function Get-RunnerActive { @{ Ok = $true; Active = @(${active.map((u) => `'${u}'`).join(',')}) } }`,
    "function Invoke-RunnerCleanup { [void]$events.Add('cleanup') }",
    "function Stop-LinuxRunners { [void]$events.Add('stop') }",
    "function Start-LinuxRunners { [void]$events.Add('start') }",
    "function Send-CapacityAlert([string]$kind, [string]$detail) { [void]$events.Add('alert:' + $kind); [void]$details.Add($detail); $script:lastAlert = Get-Date }",
    'function Show-Toast([string]$title, [string]$text) { }',
    body,
    "'events=' + ($events -join ',')",
    "'suspended=' + $capacitySuspended",
    "foreach ($d in $details) { 'detail=' + $d }",
  ].join('\n'));
  const result = powershell(['-File', file], { CLUED_WATCHDOG_NO_TOAST: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  const value = (key) => lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  return {
    lines, events: value('events')[0], suspended: value('suspended')[0], details: value('detail'),
    log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')) : null,
  };
}

test('Owner decision 241824b2: a runner disk below 15 GB is cleaned first, and a cleanup that brings it back keeps the runners running', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 14 }, { disk: 25 }], body: 'Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup');
  assert.equal(r.suspended, 'False');
  assert.match(r.log, /Capacity cleanup: D: 14 GB free, below 15 GB/);
  assert.match(r.log, /Capacity cleanup done: D: 14 -> 25 GB free/);
  assert.match(r.log, /Capacity cleanup was enough: the runners keep running/);
});

test('Owner decision 241824b2: a cleanup that is not enough is followed by the stop, its alert and the saved intent', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 14 }, { disk: 14.5 }], body: 'Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup,stop,alert:Suspend');
  assert.equal(r.suspended, 'True');
  assert.match(r.details[0], /^D: 14\.5 GB free \(stops below 15, resumes at 20\), memory 30 GB free \(stops below 6, resumes at 10\); cleanup before the stop: 14 -> 14\.5 GB$/);
  assert.equal(r.state.suspended, true, 'the intent survives a restart');
});

test('Owner decision 241824b2: the new levels: 16 GB on the runner disk stops nothing; a suspend resumes at 20 GB, not at 19.9', { skip }, (t) => {
  const r = step(t, {
    caps: [{ disk: 16 }, { disk: 14 }, { disk: 14 }, { disk: 19.9 }, { disk: 20 }],
    body: ['Invoke-CapacityStep', "'after16=' + ($events -join ',')", 'Invoke-CapacityStep', "'after14=' + ($events -join ',')",
      'Invoke-CapacityStep', "'after199=' + ($events -join ',')", 'Invoke-CapacityStep'].join('\n'),
  });
  const at = (key) => r.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.equal(at('after16'), '', '16 GB is above the stop level');
  assert.equal(at('after14'), 'cleanup,stop,alert:Suspend');
  assert.equal(at('after199'), 'cleanup,stop,alert:Suspend', '19.9 GB is below the resume level');
  assert.equal(r.events, 'cleanup,stop,alert:Suspend,start,alert:Resume');
  assert.equal(r.suspended, 'False');
  assert.equal(r.state.suspended, false);
});

test('Owner decision 241824b2: C: below its level only alerts (log and notification), never cleans or stops the runners', { skip }, (t) => {
  const r = step(t, { caps: [{ c: 5, disk: 2000 }, { c: 5, disk: 2000 }, { c: 21, disk: 2000 }], body: 'Invoke-CapacityStep; Invoke-CapacityStep; Invoke-CapacityStep' });
  assert.equal(r.events, '');
  assert.equal(r.suspended, 'False');
  const alerts = r.log.split(/\r?\n/).filter((line) => line.startsWith('ALERT C:'));
  assert.equal(alerts.length, 2, `once while it lasts (not every minute), cleared once: ${r.log}`);
  assert.match(alerts[0], /^ALERT C: 5 GB free, below 15 GB\. The runners are not stopped for C: \(their disk is D:\); free space on C:$/);
  assert.match(alerts[1], /^ALERT C: cleared: 21 GB free$/);
});

test('low memory alone stops the runners without a cleanup (a cleanup frees no memory); a busy runner holds back both', { skip }, (t) => {
  const low = step(t, { caps: [{ mem: 2, disk: 2000 }], body: 'Invoke-CapacityStep' });
  assert.equal(low.events, 'stop,alert:Suspend');
  const busy = step(t, { caps: [{ disk: 14 }], busy: true, body: 'Invoke-CapacityStep' });
  assert.equal(busy.events, '');
  assert.equal(busy.suspended, 'False');
});

test('a cleanup within the last 15 minutes counts: the disk low again goes straight to the stop', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 14 }, { disk: 25 }, { disk: 14 }], body: 'Invoke-CapacityStep; Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup,stop,alert:Suspend');
  assert.doesNotMatch(r.details[0], /cleanup before the stop/);
});

test('a runner disk that cannot be found is not judged (said once): C: low does not stop the runners in its place', { skip }, (t) => {
  const r = step(t, { caps: [{ c: 1, disk: null }, { c: 1, disk: null }], body: 'Invoke-CapacityStep; Invoke-CapacityStep' });
  assert.equal(r.events, '');
  assert.equal(r.log.split(/\r?\n/).filter((line) => line.startsWith('Runner disk unknown')).length, 1, r.log);
});

test('a restart while held back restores the intent and stops runners systemd started again; the resume level still applies', { skip }, (t) => {
  const r = step(t, {
    caps: [{ disk: 14 }],
    active: ['actions.runner.x.service'],
    state: { suspended: true, reason: 'low capacity', changed: '2026-11-08T11:26:42.0109685+08:00' },
    body: 'Restore-CapacityState; Invoke-CapacityStep',
  });
  assert.equal(r.events, 'stop,alert:Reminder');
  assert.equal(r.suspended, 'True');
  assert.match(r.log, /Restored state: suspended=True/);
  assert.match(r.log, /Capacity suspend re-asserted: 1 unit\(s\)/);
});

test('the runner disk is the drive of the distribution\'s registered folder, with or without the \\\\?\\ prefix', { skip }, (t) => {
  const r = step(t, { caps: [], body: [
    "'d=' + (ConvertTo-RunnerDisk 'D:\\clued-ci\\wsl\\clued-ci-linux-01' 'ext4.vhdx' | ConvertTo-Json -Compress)",
    "'c=' + (ConvertTo-RunnerDisk '\\\\?\\c:\\Users\\x\\wsl' '' | ConvertTo-Json -Compress)",
    "'none=' + ($null -eq (ConvertTo-RunnerDisk '\\\\server\\share' 'ext4.vhdx'))",
  ].join('\n') });
  const at = (key) => r.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.deepEqual(JSON.parse(at('d')), { Drive: 'D', Vhdx: 'D:\\clued-ci\\wsl\\clued-ci-linux-01\\ext4.vhdx' });
  assert.deepEqual(JSON.parse(at('c')), { Drive: 'C', Vhdx: 'c:\\Users\\x\\wsl\\ext4.vhdx' });
  assert.equal(at('none'), 'True');
});

test('the cleanup removes only rebuildable things of the runner distribution: unused images, build cache, the _work/_temp of idle runners; never containers, volumes or a system prune', { skip }, (t) => {
  const { text } = render(t);
  const cleanup = /function Invoke-RunnerCleanup \{[\s\S]*?\n\}/.exec(text)?.[0];
  assert.ok(cleanup, 'the cleanup function is in the rendered script');
  assert.match(cleanup, /'docker','image','prune','--all','--force'/);
  assert.match(cleanup, /'docker','builder','prune','--all','--force'/);
  assert.match(cleanup, /'fstrim','-v','\/'/);
  const script = /\$runnerTempScript='([^']*)'/.exec(text)?.[1];
  assert.ok(script, 'the temporary-files script is in the rendered script');
  assert.doesNotMatch(cleanup + script, /volume|'system'|system prune|container/i);
  assert.doesNotMatch(script, /"/, 'no double quote: Windows PowerShell 5.1 passes it to wsl.exe unescaped');
  assert.match(script, /pgrep -f \[R\]unner\.Worker >\/dev\/null; s=\$\?; if \[ \$s -ne 1 \]; then echo kept: a job is running or the processes cannot be read; exit 0; fi/, 'nothing is removed while any job runs or when that cannot be told');
  assert.match(script, /find \$t -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- \{\} \+/);
  assert.match(script, /\[ -L \$t \] \|\| \[ -L \$r\/_work \]/, 'a linked _work or _temp is left alone');
  for (const root of ['/home/runner/actions-runner', '/home/runner/actions-runner-02', '/home/runner/actions-runner-03', '/home/runner/actions-runner-04']) {
    assert.ok(text.includes(`'${root}'`), `the active runner root ${root} is rendered`);
  }
});
