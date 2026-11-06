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
  assert.ok(at("Send-CapacityAlert 'Resume'") > at('Log ("Capacity resume:'));
  assert.ok(at("Send-CapacityAlert 'Reminder'") > at("Send-CapacityAlert 'Resume'"));
  assert.match(text, /elseif\(\$capacitySuspended -and \(\(Get-Date\)-\$lastAlert\)\.TotalMinutes -ge \$alertEveryMinutes\)/);
  assert.match(text, /if\(\$firstLoop\)\{\$firstLoop=\$false; if\(-not \$capacitySuspended\)\{Clear-StaleCapacityAlert\}\}/, 'the first look clears a marker when nothing is held back');
  // the levels the alert names are the capacity profile's
  const profiles = JSON.parse(fs.readFileSync(path.join(HERE, 'node-profiles.json'), 'utf8'));
  const host = profiles.hosts.find((entry) => entry.host_id === 'company-primary');
  const capacity = profiles.capacity_profiles[host.capacity_profile];
  assert.ok(text.includes(`$suspendDisk=${capacity.suspend_c_free_gb}; $resumeDisk=${capacity.resume_c_free_gb};`));
  assert.match(text, /Log \("Thresholds: C: stops below \{0\} GB, resumes at \{1\} GB; memory stops below \{2\} GB, resumes at \{3\} GB" -f \$suspendDisk,\$resumeDisk,\$suspendMem,\$resumeMem\)/, 'a start logs the levels it works with');
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

// Owner decision: the runners stop at 50 GB free on C: and start again at 60 GB, on every
// host of the workstation profile; the profile, the tools that read it and the text
// that describes it say the same.
test('the workstation profile resumes the runners at 60 GB, stops them at 50, and every reader says so', () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(HERE, 'node-profiles.json'), 'utf8'));
  const workstation = profiles.capacity_profiles['workstation-v1'];
  assert.equal(workstation.suspend_c_free_gb, 50);
  assert.equal(workstation.resume_c_free_gb, 60);
  const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
  assert.match(readme, /capacity suspend: host free memory < 6 GB or C: free < 50 GB\r?\ncapacity resume:  host free memory >= 10 GB and C: free >= 60 GB/);
  const runbook = fs.readFileSync(path.join(HERE, '..', '..', '..', 'docs', 'maintenance', 'runner-configuration-and-operations.md'), 'utf8');
  assert.match(runbook, /≥ 10 GiB \*\*且\*\* ≥ 60 GiB/);
  assert.doesNotMatch(runbook, /50\/80 GiB/);
});

test('local-verify reads the 60 GB level of the real profile for the company host', async () => {
  const { watchdogLevels } = await import('../local-verify.mjs');
  const company = profiles().hosts.find((host) => host.host_id === 'company-primary');
  const levels = watchdogLevels({ hostname: company.hostname, env: {}, profilesFile: path.join(HERE, 'node-profiles.json'), readText: (file) => {
    if (file === company.watchdog_path) throw new Error('not installed in this test');
    return fs.readFileSync(file, 'utf8');
  } });
  assert.deepEqual(levels, { suspend: 50, resume: 60 });
});

function profiles() { return JSON.parse(fs.readFileSync(path.join(HERE, 'node-profiles.json'), 'utf8')); }
