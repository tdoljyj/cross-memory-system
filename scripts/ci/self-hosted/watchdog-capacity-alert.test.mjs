// The host watchdog must not stop the Linux runners for low capacity unseen
// (defect 2102f7e1: they stood still for 86 minutes, only the log said why).
// The watchdog is rendered by render-host-watchdog.ps1; these tests render it for
// the company-primary host, check what the rendered script does on suspend,
// reminder and resume, and run its alert block. Windows with PowerShell 7 only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'render-host-watchdog.ps1');
const available = process.platform === 'win32' && spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { windowsHide: true }).status === 0;
const skip = available ? false : 'needs Windows with PowerShell 7';
const pwsh = (args, env = {}) => spawnSync('pwsh', ['-NoProfile', ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });

function render(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-alert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'watchdog.ps1');
  const result = pwsh(['-File', RENDERER, '-HostId', 'company-primary', '-OutputPath', out]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { dir, out, text: fs.readFileSync(out, 'utf8') };
}

test('the rendered watchdog parses and alerts on every capacity suspend, reminds while it lasts and clears on resume', { skip }, (t) => {
  const { out, text } = render(t);
  const parsed = pwsh(['-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${out.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`]);
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
  // the thresholds the alert names are the profile's
  assert.match(text, /\$suspendDisk=50; \$resumeDisk=80;/);
});

test('the alert block: an ALERT line, a marker file while suspended (kept since the first alert), removed on resume', { skip }, (t) => {
  const { dir, text } = render(t);
  const block = /# BEGIN capacity-alert\r?\n([\s\S]*?)# END capacity-alert/.exec(text)?.[1];
  assert.ok(block, 'the alert block is in the rendered script');
  const log = path.join(dir, 'log.txt');
  const marker = path.join(dir, 'state', 'capacity-alert.json');
  const harness = path.join(dir, 'harness.ps1');
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    `$log = '${log}'; function Log([string]$m) { Add-Content -LiteralPath $log -Value $m }`,
    block,
    `$alertFile = '${marker}'`,
    "Send-CapacityAlert 'Suspend' 'C: 49.8 GB free'",
    `$first = Get-Content -LiteralPath '${marker}' -Raw | ConvertFrom-Json`,
    'Start-Sleep -Milliseconds 1100',
    "Send-CapacityAlert 'Reminder' 'C: 51.0 GB free'",
    `$again = Get-Content -LiteralPath '${marker}' -Raw | ConvertFrom-Json`,
    "[pscustomobject]@{ state = $first.state; detail = $first.detail; sinceKept = ($first.since -eq $again.since); detailNow = $again.detail } | ConvertTo-Json -Compress",
    "Send-CapacityAlert 'Resume' 'C: 70.0 GB free'",
    `'gone=' + -not (Test-Path -LiteralPath '${marker}')`,
  ].join('\n'));
  const result = pwsh(['-File', harness], { CLUED_WATCHDOG_NO_TOAST: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const [json, gone] = result.stdout.trim().split(/\r?\n/);
  assert.deepEqual(JSON.parse(json), { state: 'capacity-suspended', detail: 'C: 49.8 GB free', sinceKept: true, detailNow: 'C: 51.0 GB free' });
  assert.equal(gone, 'gone=True', 'the marker is removed on resume');
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.match(lines[0], /^ALERT Suspend: Linux runners are stopped for low capacity \(C: 49\.8 GB free\)$/);
  assert.match(lines[1], /^ALERT Reminder: /);
  assert.match(lines[2], /^ALERT cleared: runners resumed \(C: 70\.0 GB free\)$/);
});
