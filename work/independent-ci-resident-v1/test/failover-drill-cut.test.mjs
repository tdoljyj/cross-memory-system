// 第 18 代故障转移演练的断网脚本（任务 04f9b91b，D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 1、7 节）。
// 脚本在 Windows PowerShell 5.1 里 dot-source（只定义函数，不执行），真正动系统的动作（列网卡、禁用、启用、注册或删除兜底任务）
// 和等待、连通探测都换成桩；不提权、不碰本机网卡和计划任务。
//   C1 兜底任务没注册成（或读回不对）→ 不禁用
//   C2 睡眠中抛异常 → 仍启用
//   C3 待命超时 → 不禁用，且删兜底任务
//   C4 本机状态不是 ACTIVE 空闲 → 不禁用，且删兜底任务
//   C5 正常路径：注册 → 禁用 → 启用 → 删任务，结果文件本机与共享目录各一份
//   C6 参数块在 5.1 Parser 下无错；含非 ASCII 字符时带 UTF-8 BOM
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const opts = { skip: !windows, timeout: 120_000 };
const script = fileURLToPath(new URL('../drill/failover-drill-cut.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-drill-cut-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;

function ps(expr) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(script)}; ConvertTo-Json -Depth 8 -Compress -InputObject $(${expr})`;
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 100_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}

const ACTIVE_IDLE = { executor: { state: 'IDLE' }, halt: null, paused: false, intakePause: null, node: { mode: 'ACTIVE' }, current: null, pending: [] };
let n = 0;
function caseDirs({ status = ACTIVE_IDLE, release = 'gen18-t' } = {}) {
  const root = path.join(tmp, `c${++n}`), work = path.join(root, 'work'), shared = path.join(root, 'shared');
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(shared, { recursive: true });
  const statusFile = path.join(root, 'status.json');
  fs.writeFileSync(statusFile, JSON.stringify(status));
  const releaseFile = path.join(work, 'release-gen18-t.txt');
  if (release !== null) fs.writeFileSync(releaseFile, release);
  return { work, shared, statusFile, releaseFile };
}

// The stubs: every system action appends to $script:calls; the clock advances by what Wait-DrillSeconds is asked for.
const stubs = ({ register = '$true', wait = '$null', adapters = "@('Ethernet', 'Wi-Fi')" } = {}) => `
  $script:calls = New-Object System.Collections.ArrayList
  $script:fakeNow = [datetime]'2026-11-25T03:00:00Z'
  $script:PollSeconds = 15; $script:StandbyLimitSeconds = 60; $script:CutSeconds = 540; $script:ReconnectSeconds = 120
  function Get-DrillNow { $script:fakeNow.ToUniversalTime() }
  function Wait-DrillSeconds([int]$Seconds) { [void]$script:calls.Add("wait:$Seconds"); ${wait}; $script:fakeNow = $script:fakeNow.AddSeconds($Seconds) }
  function Get-DrillUpAdapters { [void]$script:calls.Add('list'); ${adapters} }
  function Disable-DrillAdapters([string[]]$Names) { [void]$script:calls.Add('disable:' + ($Names -join ',')) }
  function Enable-DrillAdapters([string[]]$Names) { [void]$script:calls.Add('enable:' + ($Names -join ',')); @() }
  function Register-DrillBackstop([string]$TaskName, [string[]]$Names, [datetime]$At) { [void]$script:calls.Add('register'); ${register} }
  function Remove-DrillBackstop([string]$TaskName) { [void]$script:calls.Add('remove'); $true }
  function Test-DrillConnectivity { [void]$script:calls.Add('probe'); $true }`;
const run = (d, extra = '') => ps(`${stubs(extra)}
  $r = Invoke-FailoverDrillCut -DrillId 'gen18-t' -WorkDir ${q(d.work)} -SharedDir ${q(d.shared)} -StatusFile ${q(d.statusFile)} -ReleaseFile ${q(d.releaseFile)}
  @{ result = $r; calls = @($script:calls) }`);
const systemCalls = calls => calls.filter(c => !c.startsWith('wait:') && c !== 'probe');

test('C1: a backstop task that is not registered means no cut', opts, () => {
  for (const register of ['$false', "throw 'access denied'"]) {
    const r = run(caseDirs(), { register });
    assert.equal(r.result.outcome, 'BACKSTOP_NOT_REGISTERED');
    assert.ok(!r.calls.some(c => c.startsWith('disable')), r.calls.join(' '));
  }
});

test('C2: an exception while cut off still enables the adapters', opts, () => {
  const r = run(caseDirs(), { wait: 'if ($Seconds -eq 540) { throw "interrupted" }' });
  const order = systemCalls(r.calls);
  assert.ok(order.includes('disable:Ethernet,Wi-Fi'), order.join(' '));
  assert.ok(order.indexOf('enable:Ethernet,Wi-Fi') > order.indexOf('disable:Ethernet,Wi-Fi'), order.join(' '));
  assert.equal(r.result.outcome, 'CUT_INTERRUPTED');
  assert.ok(r.result.t0 && r.result.restoredAt);
});

test('C3: no release within the standby limit means no cut, and the backstop task is removed', opts, () => {
  const r = run(caseDirs({ release: null }));
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT');
  assert.ok(!r.calls.some(c => c.startsWith('disable')), r.calls.join(' '));
  assert.equal(r.calls.at(-1), 'remove');
  assert.equal(r.result.backstopRemoved, true);
});

test('C3: a release file for another drill is not a release', opts, () => {
  const r = run(caseDirs({ release: 'other-drill' }));
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT');
  assert.ok(!r.calls.some(c => c.startsWith('disable')));
});

test('C4: a node that is not ACTIVE and idle is not cut off, and the backstop task is removed', opts, () => {
  const states = [{ ...ACTIVE_IDLE, node: { mode: 'STANDBY' } }, { ...ACTIVE_IDLE, current: { pr: 5, headSha: 'a'.repeat(40) } },
    { ...ACTIVE_IDLE, paused: true }, { ...ACTIVE_IDLE, executor: { state: 'PAUSED' } }, { ...ACTIVE_IDLE, halt: { code: 'X' } },
    { ...ACTIVE_IDLE, intakePause: { until: '2026-11-25T05:00:00Z' } }];
  for (const status of states) {
    const r = run(caseDirs({ status }));
    assert.equal(r.result.outcome, 'LOCAL_STATUS_NOT_READY', JSON.stringify(status));
    assert.ok(!r.calls.some(c => c.startsWith('disable')), r.calls.join(' '));
    assert.equal(r.calls.at(-1), 'remove');
  }
  const d = caseDirs(); fs.writeFileSync(d.statusFile, '{not json');
  assert.equal(run(d).result.outcome, 'LOCAL_STATUS_NOT_READY');
});

test('C5: the normal path registers, disables, enables, then removes the task, and writes both result files', opts, () => {
  const d = caseDirs();
  const r = run(d);
  assert.equal(r.result.outcome, 'CUT_DONE', JSON.stringify(r.result));
  const order = systemCalls(r.calls);
  // registered at the start (the UAC check) and again just before the cut (its time trigger at T0 + 12 minutes)
  assert.deepEqual(order, ['list', 'register', 'register', 'disable:Ethernet,Wi-Fi', 'enable:Ethernet,Wi-Fi', 'remove']);
  assert.ok(r.calls.includes('wait:540'));
  assert.equal(r.result.connected, true);
  assert.equal(r.result.backstopRemoved, true);
  assert.deepEqual(r.result.enableFailed, []);
  assert.equal(Date.parse(r.result.restoredAt) - Date.parse(r.result.t0), 540_000);
  for (const dir of [d.work, d.shared]) {
    const file = path.join(dir, 'failover-drill-gen18-t.result.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).outcome, 'CUT_DONE', file);
  }
});

test('C5: no adapter up means no cut', opts, () => {
  const r = run(caseDirs(), { adapters: '@()' });
  assert.equal(r.result.outcome, 'NO_ADAPTER');
  assert.ok(!r.calls.some(c => c.startsWith('disable') || c === 'register'));
});

test('C6: the param block parses in Windows PowerShell 5.1, and a non-ASCII script carries a BOM', opts, () => {
  const r = ps(`$t = $null; $e = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(${q(script)}, [ref]$t, [ref]$e)
    @{ errors = @($e | ForEach-Object { $_.Message }); params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) }`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.params, ['DrillId', 'WorkDir', 'SharedDir', 'StatusFile', 'ReleaseFile']);
  const bytes = fs.readFileSync(script);
  if (bytes.some(b => b > 0x7f)) assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});
