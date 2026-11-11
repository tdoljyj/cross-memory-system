// The host watchdog is one renderer for every host (Task 5282d4ae): what it supervises comes
// from the host's entry in node-profiles.json, never from a special case for a kind of host.
// - watchdog_drives: the drives it watches (default C:, at the capacity profile's C: levels):
//   below the level a host cleanup (files older than a day in the caches of the account it
//   runs as; never under the resident CI's, the runners' or the evidence folders, never
//   through a link) when the drive says clean, then an alert while still low.
// - the executors are the host's active runner entries; each kind brings its own part:
//   linux-runner its distribution cleanup and stop/start on its own disk, windows-runner a
//   report of its service. A retired runner is simply not there.
// home-primary (TURING, Linux runner retired; on 2026-11-11 its C:, which holds the resident
// CI's WSL disk, fell to 1.33 GB) was refused before. Windows only (Windows PowerShell 5.1).
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
const profiles = () => JSON.parse(fs.readFileSync(path.join(HERE, 'node-profiles.json'), 'utf8'));
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const RUNNER_OR_WSL = /wsl\.exe|systemctl|Stop-Service|Start-Service|Restart-Service|Stop-Process|docker/i;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// hosts: replaces the hosts of the real profiles (a synthetic host); null renders from the real file
function render(t, hostId = 'home-primary', hosts = null) {
  const dir = tempDir(t, 'watchdog-host-');
  const out = path.join(dir, 'watchdog.ps1');
  const args = ['-File', RENDERER, '-HostId', hostId, '-OutputPath', out];
  if (hosts) {
    const file = path.join(dir, 'node-profiles.json');
    fs.writeFileSync(file, JSON.stringify({ ...profiles(), hosts }));
    args.push('-ProfilesPath', file);
  }
  const result = powershell(args);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const text = fs.readFileSync(out, 'utf8');
  const parsed = powershell(['-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(out)}, [ref]$null, [ref]$e); $e.Count`]);
  assert.equal(parsed.stdout.trim(), '0', 'the rendered watchdog parses in Windows PowerShell 5.1');
  return { dir, out, text };
}

const home = () => profiles().hosts.find((host) => host.host_id === 'home-primary');
const windowsOnly = (extra = {}) => {
  const { linux_runner: _linux, ...rest } = home();
  return { ...rest, host_id: 'synthetic-win', hostname: 'SYNTH', ...extra };
};

// The host-disk step of a rendered watchdog in Windows PowerShell 5.1: the free space comes
// from `free` (one value per Get-FreeGB call); the cleanup and the notifications are recorded
// unless `realCleanup` (then only the recycle bin is).
function run(t, { hostId = 'home-primary', free = [], realCleanup = false, before = '', body }) {
  const { dir, text } = render(t, hostId);
  const block = /# BEGIN host-disk\r?\n([\s\S]*?)# END host-disk/.exec(text)?.[1];
  assert.ok(block, 'the host-disk block is in the rendered script');
  const log = path.join(dir, 'log.txt');
  const file = path.join(dir, 'step.ps1');
  fs.writeFileSync(file, [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${quote(log)}; function Log([string]$m) { Add-Content -LiteralPath $log -Value $m }`,
    '$DryRun = $false',
    '$events = New-Object System.Collections.ArrayList',
    "function Show-Toast([string]$title, [string]$text) { [void]$events.Add('toast:' + $title) }",
    block,
    `$frees = New-Object System.Collections.Queue; foreach ($f in @(${free.join(',') || '0'})) { $frees.Enqueue($f) }`,
    'function Get-FreeGB([string]$drive) { $script:frees.Dequeue() }',
    realCleanup ? "function Clear-RecycleBin { [void]$events.Add('recycle-bin') }" : "function Invoke-HostCleanup([string]$drive) { [void]$events.Add('cleanup:' + $drive) }",
    before,
    body,
    "'events=' + ($events -join ',')",
  ].join('\n'));
  const result = powershell(['-File', file]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  return { lines, events: lines.find((line) => line.startsWith('events='))?.slice(7), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('home-primary (Linux runner retired) renders: C: watched with the host cleanup, no Linux runner part, its active Windows runner only reported', { skip }, (t) => {
  assert.equal(home().linux_runner.state, 'retired', 'the case this covers');
  const { text } = render(t);
  assert.ok(text.includes("$hostDrives=@(@{Drive='C';Suspend=15;Resume=20;Clean=$true})"), 'C:, 15/20 GB, cleaned');
  assert.doesNotMatch(text, RUNNER_OR_WSL, 'no runner, WSL, service or process is stopped or started');
  assert.ok(text.includes(`$winService='${home().windows_runner.service_name}'`), 'the Windows runner of the profile is reported');
  assert.match(text, /watchdog-home-primary\{0\}\.log/);
  assert.match(text, /Local\\CluedCIWatchdog-home-primary\{0\}/);
  for (const root of ['$env:TEMP', "(Join-Path $env:SystemRoot 'Temp')", "(Join-Path $env:LOCALAPPDATA 'npm-cache')", "(Join-Path $env:LOCALAPPDATA 'pip\\Cache')", "(Join-Path $env:LOCALAPPDATA 'NuGet\\v3-cache')"]) {
    assert.ok(text.includes(root), `cleans ${root}`);
  }
  assert.ok(text.includes("$protectedRoots=@('C:\\ProgramData\\CluedIndependentCI','C:\\clued-resident','C:\\clued-ci','C:\\w','D:\\w')"), 'the protected folders');
  assert.match(text, /\$cleanAgeDays=1;/);
  assert.match(text, /Clear-RecycleBin -DriveLetter \$drive -Force/);
});

test('company-primary renders from the same parts: its Linux runners with their own cleanup and stop on their disk, its Windows runner reported, C: watched without a cleanup', { skip }, (t) => {
  const { text } = render(t, 'company-primary');
  assert.ok(text.includes("$hostDrives=@(@{Drive='C';Suspend=15;Resume=20;Clean=$false})"), 'C: only alerts there (Owner decision 241824b2)');
  for (const part of ['# BEGIN host-disk', '# BEGIN capacity-step', 'function Invoke-RunnerCleanup', 'function Stop-LinuxRunners', "$winService='"]) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf('Invoke-HostDiskStep\n') < text.indexOf('Invoke-CapacityStep\n', text.indexOf('while($true)')), 'the host drives first in each round');
});

test('a host with only a Windows runner renders: host drives and the report of its service, nothing of a Linux runner', { skip }, (t) => {
  const { text } = render(t, 'synthetic-win', [windowsOnly({ watchdog_drives: [{ drive: 'C' }, { drive: 'E', suspend_free_gb: 30, resume_free_gb: 40, clean: false }] })]);
  assert.ok(text.includes("$hostDrives=@(@{Drive='C';Suspend=15;Resume=20;Clean=$true},@{Drive='E';Suspend=30;Resume=40;Clean=$false})"));
  assert.ok(text.includes(`$winService='${home().windows_runner.service_name}'`));
  assert.doesNotMatch(text, RUNNER_OR_WSL);
  assert.doesNotMatch(text, /capacity-step|\$distro=/);
});

test('a host with no active executor (its Windows runner retired too) renders the host drives alone', { skip }, (t) => {
  const host = windowsOnly();
  const { text } = render(t, 'synthetic-win', [{ ...host, windows_runner: { ...host.windows_runner, state: 'retired' } }]);
  assert.ok(text.includes("$hostDrives=@(@{Drive='C';Suspend=15;Resume=20;Clean=$true})"));
  assert.doesNotMatch(text, RUNNER_OR_WSL);
  assert.doesNotMatch(text, /\$winService=|\$distro=/);
});

test('a drive entry the renderer cannot take is refused', { skip }, (t) => {
  for (const drives of [[{ drive: 'CD' }], [{ drive: 'C', suspend_free_gb: 20, resume_free_gb: 20 }], [{ drive: 'C' }, { drive: 'c' }]]) {
    const dir = tempDir(t, 'watchdog-bad-');
    const file = path.join(dir, 'node-profiles.json');
    fs.writeFileSync(file, JSON.stringify({ ...profiles(), hosts: [windowsOnly({ watchdog_drives: drives })] }));
    const result = powershell(['-File', RENDERER, '-HostId', 'synthetic-win', '-OutputPath', path.join(dir, 'w.ps1'), '-ProfilesPath', file]);
    assert.notEqual(result.status, 0, JSON.stringify(drives));
  }
});

test('the C: levels are 15 GB, cleared at 20 GB, for both hosts, and local-verify reads them from the rendered watchdog', async (t) => {
  const { capacity_profiles: capacities, hosts } = profiles();
  for (const host of hosts) {
    assert.equal(capacities[host.capacity_profile].suspend_c_free_gb, 15, host.host_id);
    assert.equal(capacities[host.capacity_profile].resume_c_free_gb, 20, host.host_id);
  }
  if (skip) return;
  const { watchdogLevels } = await import('../local-verify.mjs');
  for (const host of hosts) {
    const { out } = render(t, host.host_id);
    const levels = watchdogLevels({ hostname: host.hostname, env: {}, profilesFile: path.join(HERE, 'node-profiles.json'),
      readText: (file) => (file === host.watchdog_path ? fs.readFileSync(out, 'utf8').replace(/Suspend=15;Resume=20/, 'Suspend=11;Resume=21') : fs.readFileSync(file, 'utf8')) });
    assert.deepEqual(levels, { suspend: 11, resume: 21 }, `${host.host_id}: the installed watchdog's levels`);
  }
});

test('a drive below its level is cleaned first; a cleanup that is enough raises no alert', { skip }, (t) => {
  const r = run(t, { free: [14, 25], body: 'Invoke-HostDiskStep' });
  assert.equal(r.events, 'cleanup:C');
  assert.match(r.log, /Disk cleanup: C: 14 GB free, below 15 GB/);
  assert.match(r.log, /Disk cleanup done: C: 14 -> 25 GB free/);
  assert.doesNotMatch(r.log, /ALERT/);
});

test('a cleanup that is not enough alerts (once per 30 minutes while it lasts); the next cleanup waits 60 minutes; the alert clears at 20 GB, not at 19.9', { skip }, (t) => {
  const r = run(t, {
    free: [14, 14.5, 14, 16, 19.9, 20, 16],
    body: ['Invoke-HostDiskStep', 'Invoke-HostDiskStep', "'after2=' + ($events -join ',')", 'Invoke-HostDiskStep', 'Invoke-HostDiskStep', "'after199=' + ($events -join ',')",
      'Invoke-HostDiskStep', 'Invoke-HostDiskStep'].join('\n'),
  });
  const at = (key) => r.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.equal(at('after2'), 'cleanup:C,toast:Clued CI host: C: is low', 'a second low reading in the same hour: no cleanup, no second alert');
  assert.equal(at('after199'), at('after2'), '16 and 19.9 GB: still alerted, nothing new');
  assert.equal(r.events, 'cleanup:C,toast:Clued CI host: C: is low,toast:Clued CI host: C: has space again');
  const alerts = r.log.split(/\r?\n/).filter((line) => line.startsWith('ALERT'));
  assert.deepEqual(alerts, ['ALERT C: 14.5 GB free, below 15 GB after a cleanup; free space on C:', 'ALERT C: cleared: 20 GB free']);
});

test('company-primary: C: below 15 GB only alerts (no cleanup), once while it lasts, cleared once at 20 GB', { skip }, (t) => {
  const r = run(t, { hostId: 'company-primary', free: [5, 5, 21], body: 'Invoke-HostDiskStep; Invoke-HostDiskStep; Invoke-HostDiskStep' });
  assert.equal(r.events, 'toast:Clued CI host: C: is low,toast:Clued CI host: C: has space again');
  assert.deepEqual(r.log.split(/\r?\n/).filter((line) => line.startsWith('ALERT')), ['ALERT C: 5 GB free, below 15 GB; free space on C:', 'ALERT C: cleared: 21 GB free']);
});

test('each watched drive keeps its own state, and a drive that cannot be read does not stop the others', { skip }, (t) => {
  const r = run(t, {
    free: [14, 14, 30],
    before: ["$hostDrives=@(@{Drive='C';Suspend=15;Resume=20;Clean=$true},@{Drive='Q';Suspend=15;Resume=20;Clean=$false},@{Drive='E';Suspend=40;Resume=50;Clean=$false})",
      "function Get-FreeGB([string]$drive) { if ($drive -eq 'Q') { throw 'no such drive' }; $script:frees.Dequeue() }"].join('\n'),
    body: 'Invoke-HostDiskStep',
  });
  assert.equal(r.events, 'cleanup:C,toast:Clued CI host: C: is low,toast:Clued CI host: E: is low');
  assert.match(r.log, /Disk step for Q: failed: no such drive/);
  assert.match(r.log, /ALERT E: 30 GB free, below 40 GB; free space on E:/);
});

test('the cleanup removes only files older than a day under its roots on the drive, never through a link and never under a protected folder', { skip }, (t) => {
  const make = (file, days) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1024));
    const when = new Date(Date.now() - days * 86400000);
    fs.utimesSync(file, when, when);
  };
  const base = tempDir(t, 'watchdog-clean-');
  const temp = path.join(base, 'temp');
  const kept = path.join(base, 'kept');
  const guarded = path.join(base, 'guarded');
  make(path.join(temp, 'old.tmp'), 2);
  make(path.join(temp, 'deep', 'er', 'old.bin'), 3);
  make(path.join(temp, 'fresh.tmp'), 0);
  make(path.join(kept, 'old-behind-link.tmp'), 5);
  make(path.join(guarded, 'old-protected.tmp'), 5);
  make(path.join(guarded, 'inner', 'old.tmp'), 5);
  const linked = spawnSync('cmd.exe', ['/c', 'mklink', '/J', path.join(temp, 'link'), kept], { windowsHide: true });
  assert.equal(linked.status, 0, 'a junction (no elevation needed)');
  const drive = base.slice(0, 1).toUpperCase();
  const r = run(t, {
    free: [14, 14],
    realCleanup: true,
    before: [`$hostDrives=@(@{Drive='${drive}';Suspend=15;Resume=20;Clean=$true})`, `$protectedRoots = @(${quote(guarded)})`,
      `$cleanRoots = @(${quote(temp)}, ${quote(path.join(guarded, 'inner'))}, ${quote(path.join(base, 'missing'))}, 'Z:\\not-this-drive')`].join('\n'),
    body: 'Invoke-HostDiskStep',
  });
  assert.equal(fs.existsSync(path.join(temp, 'old.tmp')), false, 'an old file is removed');
  assert.equal(fs.existsSync(path.join(temp, 'deep', 'er', 'old.bin')), false, 'at any depth');
  assert.equal(fs.existsSync(path.join(temp, 'fresh.tmp')), true, 'a file of today is kept');
  assert.equal(fs.existsSync(path.join(kept, 'old-behind-link.tmp')), true, 'nothing through a junction');
  assert.equal(fs.existsSync(path.join(temp, 'link')), true, 'the junction itself is left');
  assert.equal(fs.existsSync(path.join(guarded, 'inner', 'old.tmp')), true, 'a root under a protected folder is refused');
  assert.equal(fs.existsSync(path.join(guarded, 'old-protected.tmp')), true);
  assert.match(r.events, /recycle-bin/, 'the recycle bin of the drive is emptied');
  assert.match(r.log, /Disk cleanup, .*temp: removed 2 file\(s\)/);
  assert.match(r.log, /Disk cleanup: .*inner refused: a protected folder/);
});

test('the real protected folders: a root inside or around them is refused, a cache root is not', { skip }, (t) => {
  const yes = ['C:\\w', 'C:\\W\\evidence', 'D:\\w\\tmp', 'C:\\clued-ci\\runner-home-win-01', 'C:\\clued-resident\\wsl', 'C:\\ProgramData\\CluedIndependentCI\\x', 'C:\\', 'D:\\', 'C:\\ProgramData'];
  const no = ['C:\\Users\\x\\AppData\\Local\\Temp', 'C:\\wsl', 'C:\\clued-resident2', 'D:\\cache'];
  const r = run(t, { body: `foreach ($p in ${[...yes, ...no].map(quote).join(',')}) { $p + '=' + (Test-Protected $p) }` });
  const at = (key) => r.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  for (const p of yes) assert.equal(at(p), 'True', p);
  for (const p of no) assert.equal(at(p), 'False', p);
});

test('a dry run removes nothing and says what it would remove', { skip }, (t) => {
  const base = tempDir(t, 'watchdog-dry-');
  const file = path.join(base, 'old.tmp');
  fs.writeFileSync(file, 'x');
  const when = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(file, when, when);
  const r = run(t, { free: [1, 1], realCleanup: true,
    before: [`$DryRun = $true; $hostDrives=@(@{Drive='${base.slice(0, 1).toUpperCase()}';Suspend=15;Resume=20;Clean=$true})`, `$cleanRoots = @(${quote(base)})`].join('\n'), body: 'Invoke-HostDiskStep' });
  assert.equal(fs.existsSync(file), true);
  assert.match(r.log, /would remove 1 file\(s\)/);
  assert.match(r.log, /would empty the recycle bin/);
  assert.doesNotMatch(r.events, /recycle-bin/);
});
