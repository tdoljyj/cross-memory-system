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
    assert.match(r.text, new RegExp(`\\$disk=@\\{YellowPct=${STANDARD.disk.yellow_pct};YellowGb=${STANDARD.disk.yellow_gb};RedPct=${STANDARD.disk.red_pct};RedGb=${STANDARD.disk.red_gb};RecoverPct=${STANDARD.disk.recover_pct};RecoverGb=${STANDARD.disk.recover_gb}\\}`));
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
  assert.match(company.text, /\$suspendRunnerDisk=15; \$resumeRunnerDisk=20;/, 'the runner disk starts from the standard\'s absolute levels');
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
  const ok = render(t, 'home-primary', (d) => { home(d).governance.overrides = { classes: { docker_build_cache: { max_gb: 10 } }, disk: { red_gb: 12 } }; });
  assert.match(ok.text, /"docker_build_cache":\{"days":7,"max_gb":10\}/);
  assert.match(ok.text, /RedGb=12;/);
});

test('levels (standard section 2): the stricter of share and size; red holds until the recover level', { skip }, (t) => {
  const r = render(t, 'home-primary');
  const out = run(t, r, ['levels'], [
    "'a=' + (Get-DriveLevel 20 237 '')", "'b=' + (Get-DriveLevel 30 237 'red')", "'c=' + (Get-DriveLevel 40 237 'red')", "'d=' + (Get-DriveLevel 50 237 'yellow')",
    "'e=' + (Get-DriveLevel 200 2300 '')", "'f=' + (Get-DriveLevel 29 60 '')", "'g=' + (Get-DriveLevel 14.9 60 '')", "'h=' + (Get-DriveLevel 19.9 60 'red')", "'i=' + (Get-DriveLevel 20 60 'red')",
    "'red=' + (Get-RedGb 2300) + ',' + (Get-RecoverGb 2300) + ',' + (Get-YellowGb 2300)"]);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((k) => at(out.lines, k)), ['red', 'red', 'yellow', 'green', 'red', 'yellow', 'red', 'red', 'yellow']);
  assert.equal(at(out.lines, 'red'), '230,345,460', 'a 2.3 TB drive: 10% / 15% / 20%');
});

test('the status file is the one every reader takes: the executor and the PR page read what Write-Status wrote', { skip }, async (t) => {
  const r = render(t, 'company-primary');
  const file = path.join(r.dir, 'status.json');
  run(t, r, ['notify', 'levels', 'drive-round', 'sweep', 'status'], [
    `$statusFile=${quote(file)}; $probeDrives=@('C','D'); $residentDrive='D'; $vhdx=@(); $staleWorktrees=0; $nextDaily=''; $linuxHold=$null`,
    "$drv=@{C=@{Free=300GB;Used=600GB};D=@{Free=12GB;Used=2288GB}}",
    "function Get-PSDrive($n){[pscustomobject]$drv[$n]}",
    "$driveLevels=@{}; Invoke-DriveRound; Write-Status"]);
  const raw = fs.readFileSync(file);
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'no byte order mark');
  const s = JSON.parse(raw.toString('utf8'));
  assert.equal(s.contract, 'clued.node-governance-status/1');
  assert.equal(s.level, 'red');
  assert.deepEqual(s.intake, { drive: 'D', level: 'red' });
  assert.deepEqual(s.drives.map((d) => [d.drive, d.level, d.freeGb]), [['C', 'green', 300], ['D', 'red', 12]]);
  const { readNodeStatus, readCapacityAlert } = await import(pathToFileURL(path.join(ROOT, 'work/independent-ci-resident-v1/src/host-capacity.mjs')).href);
  const read = await readNodeStatus(file);
  assert.equal(read.ok, true);
  assert.equal(read.intake.level, 'red');
  assert.deepEqual(await readCapacityAlert(file, () => Date.parse(s.writtenAt)), { text: '节点资源红线（x D: 剩 12 GB，暂停接新批）' });
  const alerts = fs.readFileSync(path.join(r.dir, 'log.txt'), 'utf8');
  assert.match(alerts, /ALERT drive:D:red: D: 12 GB free of 2300 GB, below 230 GB: new resident batches wait until 345 GB/);
});

test('alerts: the same key at most once per its minutes; red every 30 minutes, yellow once a day; recovery said once', { skip }, (t) => {
  const r = render(t, 'home-primary');
  const out = run(t, r, ['notify', 'levels', 'drive-round'], [
    "$probeDrives=@('C'); $free=20GB; function Get-PSDrive($n){[pscustomobject]@{Free=$script:free;Used=(237GB-$script:free)}}",
    "$driveLevels=@{}; Invoke-DriveRound; Invoke-DriveRound; 'p1=' + $pressureDue",
    "$alertsSent['drive:C:red']=(Get-Date).AddMinutes(-31); Invoke-DriveRound",
    "$free=40GB; Invoke-DriveRound; Invoke-DriveRound; 'level=' + $driveLevels['C']; 'p2=' + $pressureDue"]);
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
  const r = step(t, { caps: [{ disk: 14 }, { disk: 25 }], body: 'Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup');
  assert.equal(r.suspended, 'False');
  assert.match(r.log, /Capacity cleanup: D: 14 GB free, below 15 GB/);
});

test('a sweep that is not enough stops the runners; the hold goes into the status (linuxRunners) and survives a restart', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 14 }, { disk: 14.5 }], body: 'Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup,stop');
  assert.equal(r.suspended, 'True');
  const hold = JSON.parse(r.hold);
  assert.equal(hold.suspended, true);
  assert.match(hold.detail, /^D: 14\.5 GB free \(stops below 15, resumes at 20\), memory 30 GB free \(stops below 6, resumes at 10\); cleanup before the stop: 14 -> 14\.5 GB$/);
  assert.match(r.log, /ALERT Suspend: Linux runners are stopped for low capacity/);
  assert.equal(r.state.suspended, true);
});

test('resume at the recover level, not below; C: low never stops the runners; low memory stops without a sweep; a busy runner holds both', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 14 }, { disk: 14 }, { disk: 19.9 }, { disk: 20 }], body: 'Invoke-CapacityStep; Invoke-CapacityStep; Invoke-CapacityStep' });
  assert.equal(r.events, 'cleanup,stop,start');
  assert.equal(r.hold, '', 'the resume clears the hold');
  assert.equal(step(t, { caps: [{ c: 5 }, { c: 5 }], body: 'Invoke-CapacityStep; Invoke-CapacityStep' }).events, '');
  assert.equal(step(t, { caps: [{ mem: 2 }], body: 'Invoke-CapacityStep' }).events, 'stop');
  assert.equal(step(t, { caps: [{ disk: 14 }], busy: true, body: 'Invoke-CapacityStep' }).events, '');
});

test('a restart while held back restores the intent and the hold, and stops runners systemd started again', { skip }, (t) => {
  const r = step(t, { caps: [{ disk: 14 }], active: ['actions.runner.x.service'], state: { suspended: true, reason: 'low capacity', changed: '2026-11-08T11:26:42.0109685+08:00' },
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

test('the resident is idle only when every signal of its status view agrees; unknown is busy (ported from the host adapters)', { skip }, (t) => {
  const r = render(t, 'home-primary');
  const now = '2026-11-12T05:00:00Z';
  const base = { contract: 'clued.independent-ci.resident-status/8', writtenAt: '2026-11-12T04:59:30.000Z', executor: { state: 'IDLE' }, halt: null, paused: false, current: null, pending: [] };
  const cases = [[base, true], [{ ...base, contract: 'clued.independent-ci.resident-status/4' }, false], [{ ...base, writtenAt: '2026-11-12T04:50:00Z' }, false],
    [{ ...base, executor: { state: 'RUNNING' } }, false], [{ ...base, current: { pr: 1 } }, false], [{ ...base, pending: [{ state: 'PARKED' }] }, false],
    [{ ...base, pending: [{ state: 'DONE' }] }, true], [{ ...base, paused: true }, false], [{ ...base, halt: { code: 'X' } }, false], [{ ...base, executor: { state: 'DEFERRED' } }, true], [null, false]];
  const out = run(t, r, ['idle'], cases.map(([s], i) => `'c${i}=' + (Test-ResidentIdle (${s === null ? '$null' : `(${quote(JSON.stringify(s))} | ConvertFrom-Json)`}) ([datetime]::Parse('${now}').ToUniversalTime()))`));
  cases.forEach(([, want], i) => assert.equal(at(out.lines, `c${i}`), want ? 'True' : 'False', `case ${i}`));
});

test('the Windows sweep removes only old files under its roots, never through a link or inside a protected folder; a dry run removes nothing', { skip }, (t) => {
  const r = render(t, 'home-primary');
  const root = path.join(r.dir, 'cache');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const old = new Date(Date.now() - 40 * 86_400_000);
  for (const f of ['old.bin', 'sub/old2.bin']) { fs.writeFileSync(path.join(root, f), 'x'); fs.utimesSync(path.join(root, f), old, old); }
  fs.writeFileSync(path.join(root, 'new.bin'), 'x');
  const target = path.join(r.dir, 'elsewhere');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.bin'), 'x'); fs.utimesSync(path.join(target, 'keep.bin'), old, old);
  fs.symlinkSync(target, path.join(root, 'link'), 'junction');
  const dry = run(t, r, ['windows-sweep'], [`$DryRun=$true; $x = Remove-OldFiles ${quote(root)} 30; 'n=' + $x.Files`]);
  assert.equal(at(dry.lines, 'n'), '2');
  assert.ok(fs.existsSync(path.join(root, 'old.bin')));
  const real = run(t, r, ['windows-sweep'], [`$x = Remove-OldFiles ${quote(root)} 30; 'n=' + $x.Files`, "'p=' + (Remove-OldFiles 'C:\\ProgramData\\CluedIndependentCI' 1).Files"]);
  assert.equal(at(real.lines, 'n'), '2');
  assert.deepEqual(fs.readdirSync(root).sort(), ['link', 'new.bin', 'sub']);
  assert.ok(fs.existsSync(path.join(target, 'keep.bin')), 'a junction is never entered');
  assert.equal(at(real.lines, 'p'), '0');
  assert.match(real.log, /refused: a protected folder/);
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

test('linux-sweep docker_dangling: leftover supabase_* containers older than a day and dangling volumes of the given names go, others stay; never while a job runs', { skip: skipBash }, (t) => {
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
  const out = sweep(t, ['docker_dangling', '24', re.leftover_container_regex, re.volume_regex, '16'], { docker });
  assert.equal(out.status, 0, out.stderr);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /^image prune --force$/m);
  assert.match(calls, /^container prune --force --filter until=24h$/m);
  assert.match(calls, /^rm -f supabase_db_x$/m);
  assert.doesNotMatch(calls, /rm -f supabase_db_y|rm -f postgres/);
  assert.match(calls, new RegExp(`^volume rm ${'a'.repeat(64)}$`, 'm'));
  assert.doesNotMatch(calls, /volume rm named-data/);
  assert.doesNotMatch(calls, /system prune|volume prune/);
  const busy = sweep(t, ['docker_dangling', '24', re.leftover_container_regex, re.volume_regex, '16'], { docker, busy: true });
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
  for (const key of ['retireTasks', 'retireProcesses', 'retireFiles', 'retireFolders']) assert.ok(Array.isArray(plan[key]), key);
  const text = fs.readFileSync(path.join(HERE, 'install.ps1'), 'utf8');
  assert.equal((text.match(/-Verb RunAs/g) ?? []).length, 1, 'one elevation');
  assert.doesNotMatch(text, /Stop-Process\s+-Name|-RunLevel Highest|taskkill/i, 'never by image name, never a Highest task');
  assert.ok(text.indexOf("Step 'first read-only round'") < text.indexOf("Step 'retire the old mechanisms'"), 'nothing old is retired before the round wrote a status');
});
