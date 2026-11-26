// Node Resource Governance v1: one governance task per node, rendered by render.ps1 from the one standard
// (config/node-governance-standard.json) and the node's governance block in node-profiles.json. These tests render it for
// both nodes, run its blocks in Windows PowerShell 5.1 with everything that touches WSL, the drives or the desktop
// replaced, and run linux-sweep.sh in bash over temporary directories with fake pgrep/docker. Nothing on the host is
// changed: no WSL, no task, no deletion outside the test's own temporary folders.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const RENDERER = path.join(HERE, 'render.ps1');
const SWEEP = path.join(HERE, 'linux-sweep.sh');
const STANDARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'node-governance-standard.json'), 'utf8'));
const available = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '1'], { windowsHide: true }).status === 0;
const skip = available ? false : 'needs Windows PowerShell';
const bashOk = spawnSync('bash', ['-c', 'command -v find du stat base64 timeout >/dev/null'], { windowsHide: true }).status === 0;
const skipBash = bashOk ? false : 'needs bash with coreutils';
const powershell = (args, env = {}) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
const profiles = () => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'node-profiles.json'), 'utf8'));
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function render(t, hostId = 'company-primary', mutate = null) {
  const dir = tempDir(t, 'governance-');
  const out = path.join(dir, 'node-governance.ps1');
  const args = ['-File', RENDERER, '-HostId', hostId, '-OutputPath', out];
  if (mutate) {
    const file = path.join(dir, 'node-profiles.json');
    const data = profiles();
    mutate(data);
    fs.writeFileSync(file, JSON.stringify(data));
    args.push('-ProfilesPath', file);
  }
  const result = powershell(args);
  if (result.status !== 0) return { dir, error: `${result.stdout}${result.stderr}` };
  const text = fs.readFileSync(out, 'utf8');
  const parsed = powershell(['-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(out)}, [ref]$null, [ref]$e); $e.Count`]);
  assert.equal(parsed.stdout.trim(), '0', 'the rendered script parses in Windows PowerShell 5.1');
  return { dir, out, text };
}
const block = (text, name) => {
  const found = new RegExp(`# BEGIN ${name}\\r?\\n([\\s\\S]*?)# END ${name}`).exec(text)?.[1];
  assert.ok(found, `the ${name} block is in the rendered script`);
  return found;
};
// A PowerShell 5.1 harness over named blocks of a rendered script; prelude/body are lines of PowerShell.
function run(t, r, blocks, body, { prelude = [], env = {} } = {}) {
  const log = path.join(r.dir, 'log.txt');
  const file = path.join(r.dir, `h-${Math.random().toString(36).slice(2)}.ps1`);
  const classes = /^\$C=ConvertFrom-Json .*$/m.exec(r.text)[0];
  const numbers = /^\$maxObjects=.*$/m.exec(r.text)[0];
  fs.writeFileSync(file, ["$ErrorActionPreference = 'Stop'", `$log = ${quote(log)}; function Log([string]$m) { Add-Content -LiteralPath $log -Value $m }`,
    `$hostId='x'; $DryRun=$false; $logDir=${quote(path.join(r.dir, 'logs'))}; $stateDir=${quote(r.dir)}`, classes, numbers, /^\$repeatMinutes=.*$/m.exec(r.text)[0],
    'function Pick($a,$b){if($null -ne $a){$a}else{$b}}', ...prelude, ...blocks.map((b) => block(r.text, b)), ...[].concat(body)].join('\n'));
  const result = powershell(['-File', file], { CLUED_WATCHDOG_NO_TOAST: '1', ...env });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { lines: result.stdout.trim().split(/\r?\n/), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}
const at = (lines, key) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

test('both nodes render from the same parts: one standard, one governance block each; no watchdog leftovers', { skip }, (t) => {
  const company = render(t, 'company-primary');
  const home = render(t, 'home-primary');
  for (const r of [company, home]) {
    assert.ok(!/__[A-Z_]+__/.test(r.text));
    assert.match(r.text, /\$statusFile=if\(\$DryRun\)\{'C:\\ProgramData\\Clued\\node-governance\\status\.dryrun\.json'\}else\{'C:\\ProgramData\\Clued\\node-governance\\status\.json'\}/);
    assert.ok(r.text.includes(`$diskDefault=@{Yellow=${STANDARD.disk.yellow_gb};Red=${STANDARD.disk.red_gb};Recover=${STANDARD.disk.recover_gb}}; $diskLevels=@{}`));
    assert.match(r.text, /\$probeDrives=@\('C','D'\)/);
    assert.match(r.text, new RegExp(`^\\$interval=${STANDARD.schedule.probe_seconds}$`, 'm'));
    assert.doesNotMatch(r.text, /capacity-alert\.json|watchdog-clued-ci|C:\\clued-ci\\state/, 'one status file, no marker of the old watchdog');
  }
  assert.match(company.text, /\$distro='CluedCI-Linux'/);
  for (const root of ['/home/runner/actions-runner', '/home/runner/actions-runner-02', '/home/runner/actions-runner-03', '/home/runner/actions-runner-04']) assert.ok(company.text.includes(`'${root}'`), root);
  assert.match(company.text, /\$residentDistro='CluedResident-Linux'/);
  assert.match(company.text, /\$worktreeRoots=@\('C:\\w\\tmp','D:\\w\\tmp'\)/);
  assert.doesNotMatch(home.text, /Invoke-CapacityStep|\$distro=/, 'TURING\'s Linux runner is retired: no runner part');
  assert.match(home.text, /\$residentDistro='Ubuntu-24\.04'/);
  assert.match(home.text, /\$winService='actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-home-win-01'/);
  assert.match(company.text, /\$suspendRunnerDisk=10; \$resumeRunnerDisk=15;/, 'the runner disk starts from the standard\'s levels');
  assert.doesNotMatch(company.text + home.text, /Invoke-ResidentSweep|Test-ResidentIdle/, 'the resident distribution is the resident\'s own: only read here');
});

test('the declaration is checked: no governance block, a bad drive, an override of an unknown or non-number key are refused; a number override applies', { skip }, (t) => {
  const home = (d) => d.hosts.find((h) => h.host_id === 'home-primary');
  assert.match(render(t, 'home-primary', (d) => { delete home(d).governance; }).error, /no governance block/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.drives = ['CD']; }).error, /not one drive letter/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.drives = ['C', 'c']; }).error, /twice/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.overrides = { classes: { nope: { days: 1 } } }; }).error, /unknown classes\.nope/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.overrides = { classes: { temp: { regex: 1 } } }; }).error, /not a number of the standard/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.overrides = { classes: { temp: { days: 'x' } } }; }).error, /not a number/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.overrides = { schedule: { probe_seconds: 1 } }; }).error, /may not set schedule/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.overrides = { drives: { D: { red_gb: 20 } } }; }).error, /need 0 < red < recover <= yellow/);
  assert.match(render(t, 'home-primary', (d) => { home(d).governance.overrides = { drives: { D: { size: 1 } } }; }).error, /not a disk level/);
  const ok = render(t, 'home-primary', (d) => { home(d).governance.overrides = { classes: { docker_build_cache: { max_gb: 10 } }, disk: { red_gb: 12 }, drives: { D: { yellow_gb: 50, recover_gb: 25 } } }; });
  assert.match(ok.text, /"docker_build_cache":\{"days":7,"max_gb":10\}/);
  assert.ok(ok.text.includes('$diskDefault=@{Yellow=30;Red=12;Recover=15}; $diskLevels=@{D=@{Yellow=50;Red=12;Recover=25}}'), 'a drive overrides the default levels');
});

test('levels (standard section 2): fixed GiB whatever the drive size: below 30 yellow, below 10 red, red holds until 15; a drive may override', { skip }, (t) => {
  const r = render(t, 'home-primary', (d) => { d.hosts.find((h) => h.host_id === 'home-primary').governance.overrides = { drives: { D: { red_gb: 40, recover_gb: 60, yellow_gb: 100 } } }; });
  const out = run(t, r, ['levels'], [
    "$l=''; foreach($free in 15,9,12,14.9,15,29.9,30){ $l=Get-DriveLevel $free 'C' $l; 'c' + $free + '=' + $l }",
    "'d=' + (Get-DriveLevel 50 'D' '')", "'e=' + (Get-DriveLevel 200 'E' '')"]);
  assert.deepEqual([15, 9, 12, 14.9, 15, 29.9, 30].map((f) => at(out.lines, `c${f}`)), ['yellow', 'red', 'red', 'red', 'yellow', 'yellow', 'green'],
    'a 930 GB drive with 15 GB free is yellow, not red; 9 GB is red; back at 15 GB it recovers');
  assert.equal(at(out.lines, 'd'), 'yellow', 'D: has its own levels');
  assert.equal(at(out.lines, 'e'), 'green', 'no share of a large drive: 200 GB free is green');
});

test('the status file is the one every reader takes: the executor and the PR page read what Write-Status wrote', { skip }, async (t) => {
  const r = render(t, 'company-primary');
  const file = path.join(r.dir, 'status.json');
  run(t, r, ['notify', 'levels', 'drive-round', 'sweep', 'status'], [
    `$statusFile=${quote(file)}; $probeDrives=@('C','D'); $residentDrive='D'; $vhdx=@(); $staleWorktrees=0; $nextDaily=''; $linuxHold=$null`,
    "$drv=@{C=@{Free=300GB;Used=600GB};D=@{Free=8GB;Used=2292GB}}",
    "function Get-PSDrive($n){[pscustomobject]$drv[$n]}",
    "$driveLevels=@{}; Invoke-DriveRound; Write-Status"]);
  const raw = fs.readFileSync(file);
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'no byte order mark');
  const s = JSON.parse(raw.toString('utf8'));
  assert.equal(s.contract, 'clued.node-governance-status/1');
  assert.equal(s.level, 'red');
  assert.deepEqual(s.intake, { drive: 'D', level: 'red' });
  assert.deepEqual(s.drives.map((d) => [d.drive, d.level, d.freeGb]), [['C', 'green', 300], ['D', 'red', 8]]);
  const { readNodeStatus, readCapacityAlert } = await import(pathToFileURL(path.join(ROOT, 'work/independent-ci-resident-v1/src/host-capacity.mjs')).href);
  const read = await readNodeStatus(file);
  assert.equal(read.ok, true);
  assert.equal(read.intake.level, 'red');
  assert.deepEqual(await readCapacityAlert(file, () => Date.parse(s.writtenAt)), { text: '节点资源红线（x D: 剩 8 GB，暂停接新批）' });
  const alerts = fs.readFileSync(path.join(r.dir, 'log.txt'), 'utf8');
  assert.match(alerts, /ALERT drive:D:red: D: 8 GB free of 2300 GB, below 10 GB: new resident batches wait until 15 GB/);
});

// The hourly history line (board 265, design D:/w/tmp/FABLE-node-install-batch-20261124.md section 4): the replaced host
// watchdog's telemetry stopped on 11-08 because the hand-placed script lost it; here it is part of the rendered task.
function historyRound(t, body, { prelude = [] } = {}) {
  const r = render(t, 'company-primary');
  fs.mkdirSync(path.join(r.dir, 'logs'), { recursive: true });
  const statusFile = path.join(r.dir, 'status.json');
  const out = run(t, r, ['notify', 'levels', 'drive-round', 'sweep', 'status'], [
    `$statusFile=${quote(statusFile)}; $probeDrives=@('C','D'); $residentDrive='D'; $vhdx=@(); $staleWorktrees=0; $nextDaily=''; $linuxHold=$null`,
    "function Get-PSDrive($n){[pscustomobject](@{C=@{Free=300GB;Used=600GB};D=@{Free=8GB;Used=2292GB}})[$n]}",
    '$driveLevels=@{}; Invoke-DriveRound', ...[].concat(body)], { prelude });
  const read = (name) => { const f = path.join(r.dir, 'logs', name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/) : null; };
  return { r, out, statusFile, read };
}

test('history: one round writes a header and one line; its memory is the number the same round put into status.json; a dry run writes its own file', { skip }, (t) => {
  const h = historyRound(t, 'Write-Status');
  const lines = h.read('history-x.csv');
  assert.ok(lines, 'the round wrote logs\\history-<host>.csv');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.equal(lines[0], 'time,memoryFreeGb,drivesFreeGb,linuxRunnersSuspended');
  const [time, mem, drives, suspended] = lines[1].split(',');
  assert.ok(!Number.isNaN(Date.parse(time)), time);
  assert.match(mem, /^\d+(\.\d+)?$/, 'the memory column is a number');
  const s = JSON.parse(fs.readFileSync(h.statusFile, 'utf8'));
  assert.equal(Number(mem), s.memoryFreeGb, 'the same reading as the status file, not a second one');
  assert.equal(drives, 'C=300;D=8');
  assert.equal(suspended, 'False');
  const dry = historyRound(t, 'Write-Status', { prelude: ['$DryRun=$true'] });
  assert.equal(dry.read('history-x.csv'), null, 'a dry run leaves the real history alone');
  assert.equal(dry.read('history-x.dryrun.csv')?.length, 2);
});

test('history: a second round within the hour adds nothing; an hour after the last line adds one, with the runner hold', { skip }, (t) => {
  const h = historyRound(t, ['Write-Status; Write-Status', "'same=' + (@(Get-Content -LiteralPath $historyFile).Count)",
    '(Get-Item -LiteralPath $historyFile).LastWriteTime=(Get-Date).AddMinutes(-61)',
    "$linuxHold=[ordered]@{suspended=$true;since='2026-11-18T21:41:00+08:00';detail='memory'}; Write-Status"]);
  assert.equal(at(h.out.lines, 'same'), '2', 'header and one line after two rounds in the same hour');
  const lines = h.read('history-x.csv');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.equal(lines[2].split(',')[3], 'True', 'a held runner is recorded as stopped');
});

test('history is an aid: when it cannot be written the round goes on, status.json is written and the failure is only logged', { skip }, (t) => {
  const h = historyRound(t, []);
  const blocker = path.join(h.r.dir, 'logs', 'blocked');
  fs.mkdirSync(blocker);
  const old = new Date(Date.now() - 2 * 3_600_000);
  fs.utimesSync(blocker, old, old);
  const again = run(t, h.r, ['notify', 'levels', 'drive-round', 'sweep', 'status'], [
    `$statusFile=${quote(h.statusFile)}; $probeDrives=@('C'); $residentDrive='C'; $vhdx=@(); $staleWorktrees=0; $nextDaily=''; $linuxHold=$null`,
    "function Get-PSDrive($n){[pscustomobject]@{Free=300GB;Used=600GB}}",
    `$driveLevels=@{}; Invoke-DriveRound; $historyFile=${quote(blocker)}; Write-Status; 'after=ok'`]);
  assert.equal(at(again.lines, 'after'), 'ok', 'the round went on (the harness also requires exit 0)');
  assert.equal(JSON.parse(fs.readFileSync(h.statusFile, 'utf8')).contract, 'clued.node-governance-status/1');
  assert.match(again.log, /History write failed/);
});

test('alerts: the same key at most once per its minutes; red every 30 minutes, yellow once a day; recovery said once', { skip }, (t) => {
  const r = render(t, 'home-primary');
  const out = run(t, r, ['notify', 'levels', 'drive-round'], [
    "$probeDrives=@('C'); $free=9GB; function Get-PSDrive($n){[pscustomobject]@{Free=$script:free;Used=(237GB-$script:free)}}",
    "$driveLevels=@{}; Invoke-DriveRound; Invoke-DriveRound; 'p1=' + $pressureDue",
    "$alertsSent['drive:C:red']=(Get-Date).AddMinutes(-31); Invoke-DriveRound",
    "$free=20GB; Invoke-DriveRound; Invoke-DriveRound; 'level=' + $driveLevels['C']; 'p2=' + $pressureDue"]);
  const alerts = out.log.split(/\r?\n/).filter((l) => l.startsWith('ALERT'));
  assert.equal(alerts.filter((l) => l.startsWith('ALERT drive:C:red')).length, 2, out.log);
  assert.equal(alerts.filter((l) => l.startsWith('ALERT drive:C: recovered')).length, 1, out.log);
  assert.equal(alerts.filter((l) => l.startsWith('ALERT drive:C:yellow')).length, 1, out.log);
  assert.equal(at(out.lines, 'p1'), 'False', 'a pressure sweep at most once per gap');
  assert.equal(at(out.lines, 'level'), 'yellow');
});

// The capacity step (Linux runners) with every part that touches WSL replaced; Get-Capacity gives the drive's size, so
// the stop and resume levels follow the standard's share of it.
function step(t, { caps, busy = false, active = [], state = null, body }) {
  const r = render(t, 'company-primary');
  const levels = /^\$suspendMem=.*$/m.exec(r.text)?.[0];
  const stateFile = path.join(r.dir, 'governance.state.json');
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  const ps = (value) => (value === null ? '$null' : String(value));
  const capList = caps.map((c) => `@{Mem=${ps(c.mem ?? 30)};CFree=${ps(c.c ?? 48)};Drive='${c.drive ?? 'D'}';Free=${ps(c.disk === undefined ? 2000 : c.disk)}}`).join(',');
  const out = run(t, r, ['levels', 'capacity-alert', 'capacity-step'], [
    `$stateFile = ${quote(stateFile)}; $forceResumeFile = ${quote(path.join(r.dir, 'force-resume'))}`,
    '$events = New-Object System.Collections.ArrayList; $details = New-Object System.Collections.ArrayList',
    `$caps = New-Object System.Collections.Queue; foreach ($c in @(${capList})) { $caps.Enqueue($c) }`,
    'function Get-Capacity { [pscustomobject]$script:caps.Dequeue() }',
    `function Test-LinuxBusy { ${busy ? '$true' : '$false'} }`,
    `function Get-RunnerActive { @{ Ok = $true; Active = @(${active.map((u) => `'${u}'`).join(',')}) } }`,
    "function Invoke-RunnerSweep([switch]$Pressure) { [void]$events.Add('cleanup') }",
    "function Stop-LinuxRunners { [void]$events.Add('stop') }",
    "function Start-LinuxRunners { [void]$events.Add('start') }",
    'function Show-Toast([string]$title, [string]$text) { }',
    body,
    "'events=' + ($events -join ',')", "'suspended=' + $capacitySuspended", "'hold=' + ($linuxHold | ConvertTo-Json -Compress)"], { prelude: ["$lastDeferral=''", levels, "$distro='CluedCI-Linux'"] });
  return { ...out, events: at(out.lines, 'events'), suspended: at(out.lines, 'suspended'), hold: at(out.lines, 'hold'),
    state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')) : null };
}

test('the runner disk below its red level gets a pressure sweep first; enough keeps the runners running', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 9 }, { disk: 25 }], body: 'Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup');
  assert.equal(r.suspended, 'False');
  assert.match(r.log, /Capacity cleanup: D: 9 GB free, below 10 GB/);
});

test('a sweep that is not enough stops the runners; the hold goes into the status (linuxRunners) and survives a restart', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 9 }, { disk: 9.5 }], body: 'Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup,stop');
  assert.equal(r.suspended, 'True');
  const hold = JSON.parse(r.hold);
  assert.equal(hold.suspended, true);
  assert.match(hold.detail, /^D: 9\.5 GB free \(stops below 10, resumes at 15\), memory 30 GB free \(stops below 6, resumes at 10\); cleanup before the stop: 9 -> 9\.5 GB$/);
  assert.match(r.log, /ALERT Suspend: Linux runners are stopped for low capacity/);
  assert.equal(r.state.suspended, true);
});

test('resume at the recover level, not below; C: low never stops the runners; low memory stops without a sweep; a busy runner holds both', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 9 }, { disk: 9 }, { disk: 14.9 }, { disk: 15 }], body: 'Invoke-CapacityStep; Invoke-CapacityStep; Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup,stop,start');
  assert.equal(r.hold, '', 'the resume clears the hold');
  assert.equal(step(t, { caps: [{ c: 5 }, { c: 5 }], body: 'Invoke-CapacityStep; Invoke-CapacityStep' }).events, '');
  assert.equal(step(t, { caps: [{ mem: 2 }], body: 'Invoke-CapacityStep' }).events, 'stop');
  assert.equal(step(t, { caps: [{ disk: 9 }], busy: true, body: 'Invoke-CapacityStep' }).events, '');
});

test('a restart while held back restores the intent and the hold, and stops runners systemd started again', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 9 }], active: ['actions.runner.x.service'], state: { suspended: true, reason: 'low capacity', changed: '2026-11-08T11:26:42.0109685+08:00' },
    body: 'Restore-CapacityState; Invoke-CapacityStep' });
  assert.equal(r.events, 'stop');
  assert.equal(JSON.parse(r.hold).since, '2026-11-08T11:26:42.0109685+08:00');
  assert.match(r.log, /Capacity suspend re-asserted: 1 unit\(s\)/);
});

test('the distribution disk is the drive of its registered folder, with or without the \\\\?\\ prefix', { skip }, (t) => {
  const r = render(t, 'home-primary');
  const out = run(t, r, ['distro-disk'], [
    "'d=' + (ConvertTo-RunnerDisk 'D:\\clued-ci\\wsl\\clued-ci-linux-01' 'ext4.vhdx' | ConvertTo-Json -Compress)",
    "'c=' + (ConvertTo-RunnerDisk '\\\\?\\c:\\Users\\x\\wsl' '' | ConvertTo-Json -Compress)",
    "'none=' + ($null -eq (ConvertTo-RunnerDisk '\\\\server\\share' 'ext4.vhdx'))"]);
  assert.deepEqual(JSON.parse(at(out.lines, 'd')), { Drive: 'D', Vhdx: 'D:\\clued-ci\\wsl\\clued-ci-linux-01\\ext4.vhdx' });
  assert.deepEqual(JSON.parse(at(out.lines, 'c')), { Drive: 'C', Vhdx: 'c:\\Users\\x\\wsl\\ext4.vhdx' });
  assert.equal(at(out.lines, 'none'), 'True');
});

test('a sweep goes to WSL as one bash -c with the script base64-encoded and no double quote; its facts and debt are kept; debt 3 rounds alerts', { skip }, (t) => {
  const r = render(t, 'company-primary');
  const b64 = /^\$sweepB64='([A-Za-z0-9+/=]+)'$/m.exec(r.text)?.[1];
  assert.ok(b64);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), fs.readFileSync(SWEEP, 'utf8').replace(/\r\n/g, '\n'), 'the embedded sweep is linux-sweep.sh');
  const out = run(t, r, ['notify', 'sweep'], [
    '$calls = New-Object System.Collections.ArrayList',
    "function wsl.exe { [void]$calls.Add(($args -join ' ')); 'deleted 12 /x/a'; 'deleted 3 /x/b'; 'debt 4'; 'freed 15'; $global:LASTEXITCODE = 0 }",
    "$x = Invoke-Sweep 'CluedCI-Linux' 'runner' @('runner_checkout', 14, 10, 16, '/home/runner/actions-runner')",
    "'x=' + $x.Objects + ',' + $x.Freed + ',' + $x.Debt",
    "[void](Invoke-Sweep 'CluedCI-Linux' 'runner' @('runner_checkout', 14, 10, 16, '/r')); [void](Invoke-Sweep 'CluedCI-Linux' 'runner' @('runner_checkout', 14, 10, 16, '/r'))",
    "'debt=' + ($debt | ConvertTo-Json -Compress)", "'call=' + $calls[0]", "'actions=' + $actions.Count"]);
  assert.equal(at(out.lines, 'x'), '2,15,4');
  assert.equal(at(out.lines, 'debt'), '{"CluedCI-Linux:runner_checkout":4}');
  const call = at(out.lines, 'call');
  assert.ok(call.startsWith('-d CluedCI-Linux -u runner -e bash -c set -f; echo $0 | base64 -d | timeout 60 bash -s -- $@ '), call);
  assert.ok(call.endsWith(' runner_checkout 14 10 16 /home/runner/actions-runner'), call);
  assert.doesNotMatch(call, /"/);
  assert.equal(out.log.split(/\r?\n/).filter((l) => l.startsWith('ALERT debt:CluedCI-Linux:runner_checkout')).length, 1, 'debt three rounds running alerts once');
  assert.equal(at(out.lines, 'actions'), '3');
});

// The renderer protects the node's Windows runner root. A fixture under the temp folder is only outside it if the runner
// root is somewhere else, so the test pins the root instead of inheriting whichever machine it runs on (on clued-ci-home-win-01
// TEMP is inside the runner root and the sweep correctly refused the fixture).
// The protected folder the sweep must refuse is that runner root, a fixture folder that exists with an old file in it: the
// refusal is only reached for a folder that exists, so a production path (C:\ProgramData\CluedIndependentCI) gave the
// expected refusal only on a machine that has it, and pointed the delete function at it (task 04f9b91b: on the
// GitHub-hosted runner it does not exist and the case failed).
function windowsSweepCase(t) {
  const runnerRoot = tempDir(t, 'governance-runner-root-');
  const old = new Date(Date.now() - 40 * 86_400_000);
  fs.writeFileSync(path.join(runnerRoot, 'protected-old.bin'), 'x'); fs.utimesSync(path.join(runnerRoot, 'protected-old.bin'), old, old);
  const r = render(t, 'home-primary', (d) => { d.hosts.find((h) => h.host_id === 'home-primary').windows_runner.root = runnerRoot; });
  const root = path.join(r.dir, 'cache');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  for (const f of ['old.bin', 'sub/old2.bin']) { fs.writeFileSync(path.join(root, f), 'x'); fs.utimesSync(path.join(root, f), old, old); }
  fs.writeFileSync(path.join(root, 'new.bin'), 'x');
  const target = path.join(r.dir, 'elsewhere');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.bin'), 'x'); fs.utimesSync(path.join(target, 'keep.bin'), old, old);
  fs.symlinkSync(target, path.join(root, 'link'), 'junction');
  const dry = run(t, r, ['windows-sweep'], [`$DryRun=$true; $x = Remove-OldFiles ${quote(root)} 30; 'n=' + $x.Files`]);
  assert.equal(at(dry.lines, 'n'), '2');
  assert.ok(fs.existsSync(path.join(root, 'old.bin')));
  const real = run(t, r, ['windows-sweep'], [`$x = Remove-OldFiles ${quote(root)} 30; 'n=' + $x.Files`, `'p=' + (Remove-OldFiles ${quote(runnerRoot)} 1).Files`]);
  assert.equal(at(real.lines, 'n'), '2');
  assert.deepEqual(fs.readdirSync(root).sort(), ['link', 'new.bin', 'sub']);
  assert.ok(fs.existsSync(path.join(target, 'keep.bin')), 'a junction is never entered');
  assert.equal(at(real.lines, 'p'), '0');
  assert.ok(fs.existsSync(path.join(runnerRoot, 'protected-old.bin')), 'nothing inside the protected folder is removed');
  assert.ok(real.log.includes(`${runnerRoot} refused: a protected folder`), real.log);
}

test('the Windows sweep removes only old files under its roots, never through a link or inside a protected folder; a dry run removes nothing', { skip }, (t) => {
  windowsSweepCase(t);
});

test('the Windows sweep gives the same result wherever TEMP is, except that a fixture inside the runner root is refused', { skip }, (t) => {
  const r = render(t, 'home-primary', (d) => { d.hosts.find((h) => h.host_id === 'home-primary').windows_runner.root = os.tmpdir(); });
  const out = run(t, r, ['windows-sweep'], [`$x = Remove-OldFiles ${quote(r.dir)} 30; 'n=' + $x.Files`]);
  assert.equal(at(out.lines, 'n'), '0');
  assert.match(out.log, /refused: a protected folder/);
});

// ---- linux-sweep.sh in bash, with fake pgrep and docker on PATH ----
function sweep(t, args, { busy = false, docker = null, env = {} } = {}) {
  const dir = tempDir(t, 'sweep-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\nexit ${busy ? 0 : 1}\n`, { mode: 0o755 });
  if (docker) fs.writeFileSync(path.join(bin, 'docker'), docker, { mode: 0o755 });
  const result = spawnSync('bash', [SWEEP, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: `${bin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`)}:${process.env.PATH}`, SWEEP_SAMPLE_GAP: '0', MSYS: 'noglob', ...env } }); // noglob: Git Bash would glob and brace-expand arguments from a Windows command line
  return { dir, status: result.status, lines: result.stdout.trim().split(/\r?\n/), stderr: result.stderr };
}
const posix = (p) => p.replace(/\\/g, '/');
function runnerTree(base) {
  const r = path.join(base, 'actions-runner');
  const old = new Date(Date.now() - 20 * 86_400_000);
  for (const d of ['_work/_temp/job1', '_work/repo-old', '_work/repo-new', '_work/_actions/actions/checkout', '_work/_tool/node/18.0.0', '_work/_tool/node/22.0.0']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, '_work/_temp/job1/f'), 'x');
  for (const d of ['_work/repo-old', '_work/_actions/actions', '_work/_tool/node/18.0.0']) fs.utimesSync(path.join(r, d), old, old);
  return r;
}

test('linux-sweep: nothing while a job runs or the process list cannot be read; idle empties _temp and takes old checkouts only', { skip: skipBash }, (t) => {
  const base = tempDir(t, 'runner-');
  const r = runnerTree(base);
  const busy = sweep(t, ['runner_temp', posix(r)], { busy: true });
  assert.deepEqual(busy.lines, ['kept: a job is running or the processes cannot be read', 'freed 0']);
  assert.ok(fs.existsSync(path.join(r, '_work/_temp/job1')));
  const temp = sweep(t, ['runner_temp', posix(r)]);
  assert.equal(temp.status, 0, temp.stderr);
  assert.deepEqual(fs.readdirSync(path.join(r, '_work/_temp')), []);
  const co = sweep(t, ['runner_checkout', '14', '10', '16', posix(r)]);
  assert.equal(co.status, 0, co.stderr);
  assert.deepEqual(fs.readdirSync(path.join(r, '_work')).sort(), ['_actions', '_temp', '_tool', 'repo-new']);
  assert.deepEqual(fs.readdirSync(path.join(r, '_work/_actions')), [], 'the old downloaded action owner goes');
  const tool = sweep(t, ['runner_tool', '14', '10', '16', posix(r)]);
  assert.equal(tool.status, 0, tool.stderr);
  assert.deepEqual(fs.readdirSync(path.join(r, '_work/_tool/node')), ['22.0.0']);
});

test('linux-sweep: the budget leaves debt; a dry run deletes nothing; an unknown class refuses', { skip: skipBash }, (t) => {
  const base = tempDir(t, 'tmp-');
  const old = new Date(Date.now() - 20 * 86_400_000);
  for (const n of ['a', 'b', 'c']) { fs.mkdirSync(path.join(base, n)); fs.utimesSync(path.join(base, n), old, old); }
  fs.mkdirSync(path.join(base, 'fresh'));
  const dry = sweep(t, ['temp', '7', '2'], { env: { SWEEP_TMP: posix(base), SWEEP_DRY_RUN: '1' } });
  assert.equal(dry.lines.filter((l) => l.startsWith('would delete')).length, 2, dry.lines.join('\n'));
  assert.ok(dry.lines.includes('debt 1'));
  assert.equal(fs.readdirSync(base).length, 4);
  const real = sweep(t, ['temp', '7', '2'], { env: { SWEEP_TMP: posix(base) } });
  assert.ok(real.lines.includes('debt 1'), real.lines.join('\n'));
  assert.equal(fs.readdirSync(base).length, 2);
  assert.equal(sweep(t, ['nope']).status, 2);
});

test('linux-sweep docker_dangling: stopped containers older than a day (leftover supabase_* included) and dangling volumes of the given names go; a running container never; nothing while a job runs', { skip: skipBash }, (t) => {
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC');
  const fresh = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC');
  const log = path.join(tempDir(t, 'docker-'), 'calls.txt');
  const docker = `#!/bin/bash
echo "$*" >> '${posix(log)}'
case "$1 $2" in
  "ps -a") printf '%s\\n' 'supabase_db_x|${old}' 'supabase_db_y|${fresh}' 'postgres|${old}' ;;
  "volume ls") printf '%s\\n' '${'a'.repeat(64)}' 'named-data' ;;
  "volume inspect") echo '${new Date(Date.now() - 3 * 86_400_000).toISOString()}' ;;
esac
exit 0
`;
  const re = STANDARD.classes.docker_dangling;
  const out = sweep(t, ['docker_dangling', '24', re.volume_regex, '16'], { docker });
  assert.equal(out.status, 0, out.stderr);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /^image prune --force$/m);
  assert.match(calls, /^container prune --force --filter until=24h$/m);
  assert.doesNotMatch(calls, /^(rm|kill|stop)\b/m, 'no container is removed by name: a running supabase_* stack stays (standard 7.3)');
  assert.doesNotMatch(calls, /^ps\b/m);
  assert.match(calls, new RegExp(`^volume rm ${'a'.repeat(64)}$`, 'm'));
  assert.doesNotMatch(calls, /volume rm named-data/);
  assert.doesNotMatch(calls, /system prune|volume prune/);
  const busy = sweep(t, ['docker_dangling', '24', re.volume_regex, '16'], { docker, busy: true });
  assert.ok(busy.lines[0].startsWith('kept:'));
});

test('install.ps1 -WhatIf: one task for the Owner, Limited, a first read-only round, and what it would retire; nothing changes and nothing elevates', { skip }, () => {
  const result = powershell(['-File', path.join(HERE, 'install.ps1'), '-HostId', 'company-primary', '-WhatIf']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.task, 'Clued-Node-Governance');
  assert.equal(plan.runLevel, 'Limited');
  assert.deepEqual(plan.triggers, ['AtLogOn, repeated every minute', 'Daily 04:00']);
  assert.match(plan.firstRound, /-DryRun -MaxIterations 1/);
  assert.match(plan.generations, /retention-generations\.mjs --root C:\\ProgramData\\CluedIndependentCI\\resident --apply/);
  for (const key of ['retireTasks', 'retireProcesses', 'retireFiles', 'retireFolders']) assert.ok(Array.isArray(plan[key]), key);
  const text = fs.readFileSync(path.join(HERE, 'install.ps1'), 'utf8');
  assert.equal((text.match(/-Verb RunAs/g) ?? []).length, 1, 'one elevation');
  assert.doesNotMatch(text, /Stop-Process\s+-Name|-RunLevel Highest|taskkill/i, 'never by image name, never a Highest task');
  assert.ok(text.indexOf("Step 'first read-only round'") < text.indexOf("Step 'retire the old mechanisms'"), 'nothing old is retired before the round wrote a status');
  assert.match(text, /\$f\.StartsWith\(\$ResidentRoot \+ '\\'/, 'the elevated generation tool runs only from the resident\'s admin-only root');
});
