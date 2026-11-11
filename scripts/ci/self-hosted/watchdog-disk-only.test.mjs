// A host whose Linux runner is retired (home-primary, TURING) has no runner for the
// watchdog to supervise, but its C: still fills up: the resident CI's WSL virtual disk
// lives there, and on 2026-11-11 C: fell to 1.33 GB free and the distribution's I/O
// failed. For such a host the renderer writes a disk-only watchdog (Task 5282d4ae): it
// watches C:, below the profile's C: level removes rebuildable caches older than a day
// (never under C:\ProgramData\CluedIndependentCI, C:\clued-resident or C:\w, never
// through a link), and alerts when that was not enough. It touches no runner and no WSL.
// Windows only: the watchdog is run by Windows PowerShell 5.1.
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

function render(t, hostId = 'home-primary') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-disk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'watchdog.ps1');
  const result = powershell(['-File', RENDERER, '-HostId', hostId, '-OutputPath', out]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { dir, out, text: fs.readFileSync(out, 'utf8') };
}

// The disk step of the rendered home-primary watchdog in Windows PowerShell 5.1, with its levels;
// the free space comes from `free` (one value per Get-FreeGB call) unless `realDisk`, and the
// cleanup and the notification are recorded unless `realCleanup`.
function run(t, { free = [], realCleanup = false, before = '', body }) {
  const { dir, text } = render(t);
  const block = /# BEGIN disk-step\r?\n([\s\S]*?)# END disk-step/.exec(text)?.[1];
  assert.ok(block, 'the disk-step block is in the rendered script');
  const levels = /^\$drive=.*$/m.exec(text)?.[0];
  assert.ok(levels, 'the levels line is in the rendered script');
  const log = path.join(dir, 'log.txt');
  const file = path.join(dir, 'step.ps1');
  fs.writeFileSync(file, [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${quote(log)}; function Log([string]$m) { Add-Content -LiteralPath $log -Value $m }`,
    '$DryRun = $false',
    levels,
    '$events = New-Object System.Collections.ArrayList',
    'function Show-Toast([string]$title, [string]$text) { [void]$events.Add(\'toast:\' + $title) }',
    block,
    `$frees = New-Object System.Collections.Queue; foreach ($f in @(${free.join(',') || '0'})) { $frees.Enqueue($f) }`,
    'function Get-FreeGB { $script:frees.Dequeue() }',
    realCleanup ? 'function Clear-RecycleBin { [void]$events.Add(\'recycle-bin\') }' : "function Invoke-HostCleanup { [void]$events.Add('cleanup') }",
    before,
    body,
    "'events=' + ($events -join ',')",
  ].join('\n'));
  const result = powershell(['-File', file]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  return { dir, lines, events: lines.find((line) => line.startsWith('events='))?.slice(7), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('a host whose Linux runner is retired renders a disk-only watchdog for C: that parses in Windows PowerShell 5.1 and supervises no runner', { skip }, (t) => {
  const home = profiles().hosts.find((host) => host.host_id === 'home-primary');
  assert.equal(home.linux_runner.state, 'retired', 'the case this covers');
  const { out, text } = render(t);
  const parsed = powershell(['-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(out)}, [ref]$null, [ref]$e); $e.Count`]);
  assert.equal(parsed.stdout.trim(), '0', 'no parse error');
  const capacity = profiles().capacity_profiles[home.capacity_profile];
  assert.ok(text.includes(`$drive='C'; $suspendDisk=${capacity.suspend_c_free_gb}; $resumeDisk=${capacity.resume_c_free_gb}; $interval=${capacity.watchdog_interval_seconds}`), 'the C: levels and interval of the profile');
  assert.match(text, /watchdog-home-primary\{0\}\.log/);
  assert.match(text, /Local\\CluedCIWatchdog-home-primary\{0\}/, 'the same mutex name as a full watchdog of the host: never two of them');
  assert.doesNotMatch(text, /wsl\.exe|systemctl|Stop-Service|Start-Service|Restart-Service|Stop-Process|docker/i, 'no runner, WSL or process is touched');
  // the cleanup: these caches, these protected folders, nothing older than a day spared
  for (const root of ["$env:TEMP", "(Join-Path $env:SystemRoot 'Temp')", "(Join-Path $env:LOCALAPPDATA 'npm-cache')", "(Join-Path $env:LOCALAPPDATA 'pip\\Cache')", "(Join-Path $env:LOCALAPPDATA 'NuGet\\v3-cache')"]) {
    assert.ok(text.includes(root), `cleans ${root}`);
  }
  assert.ok(text.includes("$protectedRoots=@('C:\\ProgramData\\CluedIndependentCI','C:\\clued-resident','C:\\w')"), 'the protected folders');
  assert.match(text, /\$cleanAgeDays=1;/);
  assert.match(text, /Clear-RecycleBin -DriveLetter \$drive -Force/);
});

test('the C: level of TURING is 15 GB, cleared at 20 GB, like DESK-W-591, and local-verify reads the same levels from the rendered watchdog', async (t) => {
  const { capacity_profiles: capacities, hosts } = profiles();
  const home = hosts.find((host) => host.host_id === 'home-primary');
  assert.equal(capacities[home.capacity_profile].suspend_c_free_gb, 15);
  assert.equal(capacities[home.capacity_profile].resume_c_free_gb, 20);
  if (skip) return;
  const { out } = render(t);
  const { watchdogLevels } = await import('../local-verify.mjs');
  const levels = watchdogLevels({ hostname: home.hostname, env: {}, profilesFile: path.join(HERE, 'node-profiles.json'), readText: (file) => fs.readFileSync(file === home.watchdog_path ? out : file, 'utf8') });
  assert.deepEqual(levels, { suspend: 15, resume: 20 });
});

test('C: below 15 GB is cleaned first; a cleanup that is enough raises no alert', { skip }, (t) => {
  const r = run(t, { free: [14, 25], body: 'Invoke-DiskStep' });
  assert.equal(r.events, 'cleanup');
  assert.match(r.log, /Disk cleanup: C: 14 GB free, below 15 GB/);
  assert.match(r.log, /Disk cleanup done: C: 14 -> 25 GB free/);
  assert.doesNotMatch(r.log, /ALERT/);
});

test('a cleanup that is not enough alerts (once per 30 minutes while it lasts); the next cleanup waits 60 minutes; the alert clears at 20 GB, not at 19.9', { skip }, (t) => {
  const r = run(t, {
    free: [14, 14.5, 14, 16, 19.9, 20, 16],
    body: ['Invoke-DiskStep', 'Invoke-DiskStep', "'after2=' + ($events -join ',')", 'Invoke-DiskStep', 'Invoke-DiskStep', "'after199=' + ($events -join ',')",
      'Invoke-DiskStep', 'Invoke-DiskStep'].join('\n'),
  });
  const at = (key) => r.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.equal(at('after2'), 'cleanup,toast:Clued CI host: C: is low', 'a second low reading in the same hour: no cleanup, no second alert');
  assert.equal(at('after199'), at('after2'), '16 and 19.9 GB: still alerted, nothing new');
  assert.equal(r.events, 'cleanup,toast:Clued CI host: C: is low,toast:Clued CI host: C: has space again');
  const alerts = r.log.split(/\r?\n/).filter((line) => line.startsWith('ALERT'));
  assert.deepEqual(alerts, ['ALERT C: 14.5 GB free, below 15 GB after a cleanup; free space on C:', 'ALERT C: cleared: 20 GB free']);
});

test('the cleanup removes only files older than a day under its roots, never through a link and never under a protected folder', { skip }, (t) => {
  const make = (file, days) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1024));
    const when = new Date(Date.now() - days * 86400000);
    fs.utimesSync(file, when, when);
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-clean-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
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
    before: [`$drive = '${drive}'`, `$protectedRoots = @(${quote(guarded)})`,
      `$cleanRoots = @(${quote(temp)}, ${quote(path.join(guarded, 'inner'))}, ${quote(path.join(base, 'missing'))}, 'Z:\\not-this-drive')`].join('\n'),
    body: 'Invoke-DiskStep',
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
  const r = run(t, { body: [
    "foreach ($p in 'C:\\w', 'C:\\W\\evidence', 'C:\\clued-resident\\wsl', 'C:\\ProgramData\\CluedIndependentCI\\x', 'C:\\', 'C:\\ProgramData', 'C:\\Users\\x\\AppData\\Local\\Temp', 'C:\\wsl', 'C:\\clued-resident2') { $p + '=' + (Test-Protected $p) }",
  ].join('\n') });
  const at = (key) => r.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  for (const p of ['C:\\w', 'C:\\W\\evidence', 'C:\\clued-resident\\wsl', 'C:\\ProgramData\\CluedIndependentCI\\x', 'C:\\', 'C:\\ProgramData']) assert.equal(at(p), 'True', p);
  for (const p of ['C:\\Users\\x\\AppData\\Local\\Temp', 'C:\\wsl', 'C:\\clued-resident2']) assert.equal(at(p), 'False', p);
});

test('a dry run removes nothing and says what it would remove', { skip }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-dry-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'old.tmp');
  fs.writeFileSync(file, 'x');
  const when = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(file, when, when);
  const r = run(t, { free: [1, 1], realCleanup: true, before: [`$DryRun = $true; $drive = '${base.slice(0, 1).toUpperCase()}'`, `$cleanRoots = @(${quote(base)})`].join('\n'), body: 'Invoke-DiskStep' });
  assert.equal(fs.existsSync(file), true);
  assert.match(r.log, /would remove 1 file\(s\)/);
  assert.match(r.log, /would empty the recycle bin/);
  assert.doesNotMatch(r.events, /recycle-bin/);
});
