// 第 18 代故障转移演练的断网脚本（任务 04f9b91b；方案 D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 1、7 节，
// 定案 D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md 第 1 节第 3、5 条，独立复核 D:/w/tmp/claude-review-failover-drill-gen18-fable.md M1、M2、S1，
// 补充二第 2 条：S2、S4、S8）。
// 脚本在 Windows PowerShell 5.1 里 dot-source（只定义函数，不执行），真正动系统的动作（列网卡、禁用、启用、注册或删除兜底任务）
// 和等待、连通探测都换成桩；不提权、不碰本机网卡和计划任务。放行文件由等待的桩在待命期间写（和 DESK 门过后写一样）。
//   C1 兜底任务没注册成（或读回不对）→ 不禁用
//   C2 睡眠中抛异常 → 仍启用
//   C3 待命超时 → 不禁用，且删兜底任务
//   C4 放行时本机状态不满足 → 不断网、删掉这份放行文件、回到待命；再放行且满足 → 正常断网；删不掉才退出
//   C5 正常路径：注册 → 重列网卡取并集 → 注册 → 禁用 → 启用 → 删任务，结果文件本机与共享目录各一份
//   C6 参数块在 5.1 Parser 下无错；含非 ASCII 字符时带 UTF-8 BOM
//   M1 兜底任务只有读回网卡不再是 Disabled 才删自己，到点触发每 2 分钟重复；启用读回仍 Disabled 的算没启用成
//   M2 待命前就在的放行文件不算放行（删掉；删不掉不待命）；用过即删。清在注册成功之后、进入待命之前（补充三定案），
//      所以注册重试期间写下的也不算
//   S1 放行文件所在目录写不进就不待命，直接退出
//   S2 在用的物理网卡里有一块不是有线就不断网（第 1 步不注册；第 4 步并集后再核，有就删兜底任务）
//   S4 status.json 缺键算不满足；writtenAt 超过 120 秒（或解析不了）算不新鲜
//   S8 禁用到一半抛异常仍全部启用；共享目录写不进时本机结果照写、结论不变
//   读回出错（补充三）：待命前的第一次注册原地重试 3 次；放行后的第二次注册失败回到待命，兜底任务留着
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const opts = { skip: !windows };
const script = fileURLToPath(new URL('../drill/failover-drill-cut.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-drill-cut-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const q = s => `'${String(s).replace(/'/g, "''")}'`;

function ps(expr) {
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(script)}; ConvertTo-Json -Depth 8 -Compress -InputObject $(${expr})`;
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}

// 当班节点空闲时的 status.json：形状取自 11-24 DESK 本机那份（test/fixtures/failover-drill-gen18-readings.json），改成 ACTIVE、无在途，
// writtenAt 改成桩时钟的起点（桩时钟只随等待前进，待命上限 60 秒，核的时候总在 120 秒内）
const SAMPLE = JSON.parse(fs.readFileSync(new URL('./fixtures/failover-drill-gen18-readings.json', import.meta.url), 'utf8')).statusDesk;
const T_START = '2026-11-25T03:00:00.000Z';
const ACTIVE_IDLE = { ...structuredClone(SAMPLE), node: { ...SAMPLE.node, mode: 'ACTIVE', probe: { ...SAMPLE.node.probe, result: 'held' } }, current: null, writtenAt: T_START };
let n = 0;
function caseDirs({ status = ACTIVE_IDLE, preexisting = null } = {}) {
  const root = path.join(tmp, `c${++n}`), work = path.join(root, 'work'), shared = path.join(root, 'shared');
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(shared, { recursive: true });
  const statusFile = path.join(root, 'status.json');
  fs.writeFileSync(statusFile, typeof status === 'string' ? status : JSON.stringify(status));
  const releaseFile = path.join(work, 'release-gen18-t.txt');
  if (preexisting !== null) fs.writeFileSync(releaseFile, preexisting);
  return { root, work, shared, statusFile, releaseFile };
}

// The stubs: every system action appends to $script:calls; the clock advances by what Wait-DrillSeconds is asked for.
// `onWait` runs inside each wait (after the count goes up); by default the release is written during the first standby wait.
const writeRelease = (content = 'gen18-t') => `[IO.File]::WriteAllText($script:rel, ${q(content)})`;
// `nonWired` is what Get-DrillNonWiredUp returns ($script:nonWiredCount counts the calls); `realDisable` keeps the script's
// Disable-DrillAdapters and stubs Disable-NetAdapter instead, which logs `disable1:<name>` and throws for the names in `disableThrows`.
const stubs = (d, { register = '$true', wait = '$null', adapters = "@('Ethernet', 'Wi-Fi')", enable = '@()', nonWired = '@()',
  onWait = `if ($script:waitCount -eq 1) { ${writeRelease()} }`, pre = '', realDisable = false, disableThrows = [] } = {}) => `
  $script:calls = New-Object System.Collections.ArrayList
  $script:rel = ${q(d.releaseFile)}; $script:statusPath = ${q(d.statusFile)}
  $script:waitCount = 0; $script:listCount = 0; $script:nonWiredCount = 0; $script:registerCount = 0
  $script:fakeNow = [datetime]${q(T_START)}
  $script:PollSeconds = 15; $script:StandbyLimitSeconds = 60; $script:CutSeconds = 540; $script:ReconnectSeconds = 120
  function Get-DrillNow { $script:fakeNow.ToUniversalTime() }
  function Wait-DrillSeconds([int]$Seconds) { $script:waitCount++; [void]$script:calls.Add("wait:$Seconds"); ${onWait}; ${wait}; $script:fakeNow = $script:fakeNow.AddSeconds($Seconds) }
  function Get-DrillUpAdapters { $script:listCount++; [void]$script:calls.Add('list'); ${adapters} }
  ${realDisable
    ? `function Disable-NetAdapter { [CmdletBinding(SupportsShouldProcess)] param([string]$Name) [void]$script:calls.Add("disable1:$Name"); if (@(${disableThrows.map(q).join(',')}) -contains $Name) { throw "cannot disable $Name" } }`
    : `function Disable-DrillAdapters([string[]]$Names) { [void]$script:calls.Add('disable:' + ($Names -join ',')) }`}
  function Get-DrillNonWiredUp { $script:nonWiredCount++; ${nonWired} }
  function Enable-DrillAdapters([string[]]$Names) { [void]$script:calls.Add('enable:' + ($Names -join ',')); ${enable} }
  function Register-DrillBackstop([string]$TaskName, [string[]]$Names, [datetime]$At) { $script:registerCount++; [void]$script:calls.Add('register:' + ($Names -join ',')); ${register} }
  function Remove-DrillBackstop([string]$TaskName) { [void]$script:calls.Add('remove'); $true }
  function Test-DrillConnectivity { [void]$script:calls.Add('probe'); $true }
  ${pre}`;
const run = (d, extra = {}) => ps(`${stubs(d, extra)}
  $r = Invoke-FailoverDrillCut -DrillId 'gen18-t' -WorkDir ${q(d.work)} -SharedDir ${q(d.shared)} -StatusFile ${q(d.statusFile)} -ReleaseFile ${q(d.releaseFile)}
  @{ result = $r; calls = @($script:calls) }`);
const systemCalls = calls => calls.filter(c => !c.startsWith('wait:') && c !== 'probe');
const noCut = r => assert.ok(!r.calls.some(c => c.startsWith('disable')), r.calls.join(' '));

test('C1: a backstop task that is not registered means no cut', opts, () => {
  for (const register of ['$false', "throw 'access denied'"]) {
    const r = run(caseDirs(), { register });
    assert.equal(r.result.outcome, 'BACKSTOP_NOT_REGISTERED');
    noCut(r);
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
  const r = run(caseDirs(), { onWait: '$null' });
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT');
  noCut(r);
  assert.equal(r.calls.at(-1), 'remove');
  assert.equal(r.result.backstopRemoved, true);
});

test('C3: a release file for another drill is not a release', opts, () => {
  const r = run(caseDirs(), { onWait: `if ($script:waitCount -eq 1) { ${writeRelease('other-drill')} }` });
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT');
  noCut(r);
});

test('M2: a release file that was there before standby is not a release; it is removed', opts, () => {
  const d = caseDirs({ preexisting: 'gen18-t' });
  const r = run(d, { onWait: '$null' });
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT', JSON.stringify(r.result));
  noCut(r);
  assert.equal(fs.existsSync(d.releaseFile), false);
});

test('M2: a stale release file that cannot be removed means no standby and no cut; the backstop task just registered is removed', opts, () => {
  const d = caseDirs({ preexisting: 'gen18-t' });
  const r = run(d, { onWait: '$null', pre: `$script:lock = [IO.File]::Open($script:rel, 'Open', 'Read', 'Read')` });
  assert.equal(r.result.outcome, 'RELEASE_PREEXISTS', JSON.stringify(r.result));
  noCut(r);
  assert.deepEqual(systemCalls(r.calls), ['list', 'register:Ethernet,Wi-Fi', 'remove']);
  assert.ok(!r.calls.includes('wait:15'), r.calls.join(' '));
  assert.equal(r.result.backstopRemoved, true);
});

test('M2: the release file is used once — gone after the cut', opts, () => {
  const d = caseDirs();
  const r = run(d);
  assert.equal(r.result.outcome, 'CUT_DONE', JSON.stringify(r.result));
  assert.equal(fs.existsSync(d.releaseFile), false);
});

test('S1: a release directory that cannot be written means no standby', opts, () => {
  const d = caseDirs();
  d.releaseFile = path.join(d.statusFile, 'release-gen18-t.txt');      // its parent is a file
  const r = run(d, { onWait: '$null' });
  assert.equal(r.result.outcome, 'RELEASE_DIR_NOT_WRITABLE', JSON.stringify(r.result));
  assert.deepEqual(systemCalls(r.calls), []);
});

const NOT_READY = [{ ...ACTIVE_IDLE, node: { ...ACTIVE_IDLE.node, mode: 'STANDBY' } }, { ...ACTIVE_IDLE, current: { pr: 1298, headSha: 'a'.repeat(40) } },
  { ...ACTIVE_IDLE, paused: true }, { ...ACTIVE_IDLE, executor: { ...ACTIVE_IDLE.executor, state: 'PAUSED' } }, { ...ACTIVE_IDLE, halt: { code: 'X' } },
  { ...ACTIVE_IDLE, intakePause: { until: '2026-11-25T05:00:00Z' } }, '{not json'];

test('C4: not ready at release → no cut, that release file removed, back to standby; a new release once ready → normal cut', opts, () => {
  for (const status of NOT_READY) {
    const d = caseDirs({ status });
    const onWait = `if ($script:waitCount -eq 1) { ${writeRelease()} }
      if ($script:waitCount -eq 3) {
        if (-not (Test-Path -LiteralPath $script:rel)) { [void]$script:calls.Add('release-gone') }
        [IO.File]::WriteAllText($script:statusPath, ${q(JSON.stringify(ACTIVE_IDLE))}); ${writeRelease()} }`;
    const r = run(d, { onWait });
    const what = JSON.stringify(status).slice(0, 80);
    assert.equal(r.result.outcome, 'CUT_DONE', `${what}: ${JSON.stringify(r.result)}`);
    assert.ok(r.calls.includes('release-gone'), `${what}: ${r.calls.join(' ')}`);
    assert.ok(r.calls.indexOf('release-gone') < r.calls.findIndex(c => c.startsWith('disable')), r.calls.join(' '));
    assert.equal(r.result.releasesRefused, 1, what);
    assert.ok(r.result.localProblems.length > 0, what);
  }
});

test('C4: never ready → no cut until the standby limit, release removed, backstop removed', opts, () => {
  const d = caseDirs({ status: NOT_READY[1] });
  const r = run(d);
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT', JSON.stringify(r.result));
  noCut(r);
  assert.equal(r.calls.at(-1), 'remove');
  assert.equal(fs.existsSync(d.releaseFile), false);
});

test('C4: not ready and the release file cannot be removed → exit as before (LOCAL_STATUS_NOT_READY), no cut', opts, () => {
  const d = caseDirs({ status: NOT_READY[0] });
  const r = run(d, { onWait: `if ($script:waitCount -eq 1) { ${writeRelease()}; $script:lock = [IO.File]::Open($script:rel, 'Open', 'Read', 'Read') }` });
  assert.equal(r.result.outcome, 'LOCAL_STATUS_NOT_READY', JSON.stringify(r.result));
  noCut(r);
  assert.equal(r.calls.at(-1), 'remove');
});

test('C5: the normal path registers, re-lists, registers, disables, enables, then removes the task, and writes both result files', opts, () => {
  const d = caseDirs();
  const r = run(d);
  assert.equal(r.result.outcome, 'CUT_DONE', JSON.stringify(r.result));
  const order = systemCalls(r.calls);
  assert.deepEqual(order, ['list', 'register:Ethernet,Wi-Fi', 'list', 'register:Ethernet,Wi-Fi', 'disable:Ethernet,Wi-Fi', 'enable:Ethernet,Wi-Fi', 'remove']);
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

test('C5 item 3: an adapter that came up during standby is in the union that is registered, disabled and enabled', opts, () => {
  const r = run(caseDirs(), { adapters: "if ($script:listCount -eq 1) { @('Ethernet') } else { @('Wi-Fi 2', 'Ethernet') }" });
  assert.equal(r.result.outcome, 'CUT_DONE', JSON.stringify(r.result));
  assert.deepEqual(systemCalls(r.calls), ['list', 'register:Ethernet', 'list', 'register:Ethernet,Wi-Fi 2', 'disable:Ethernet,Wi-Fi 2', 'enable:Ethernet,Wi-Fi 2', 'remove']);
  assert.deepEqual(r.result.adapters, ['Ethernet', 'Wi-Fi 2']);
});

test('C5: no adapter up means no cut', opts, () => {
  const r = run(caseDirs(), { adapters: '@()' });
  assert.equal(r.result.outcome, 'NO_ADAPTER');
  assert.ok(!r.calls.some(c => c.startsWith('disable') || c.startsWith('register')));
});

test('M1: an adapter that did not come back keeps the backstop task', opts, () => {
  const r = run(caseDirs(), { enable: "@('Wi-Fi')" });
  assert.deepEqual(r.result.enableFailed, ['Wi-Fi']);
  assert.equal(r.result.backstopRemoved, false);
  assert.ok(!systemCalls(r.calls).slice(systemCalls(r.calls).findIndex(c => c.startsWith('enable'))).includes('remove'), r.calls.join(' '));
});

test('S2: a non-wired adapter in use at the start means no backstop, no standby, no cut', opts, () => {
  const d = caseDirs();
  const r = run(d, { nonWired: "@('Wi-Fi')" });
  assert.equal(r.result.outcome, 'NON_WIRED_ADAPTER', JSON.stringify(r.result));
  assert.match(String(r.result.detail), /Wi-Fi/);
  assert.deepEqual(systemCalls(r.calls), ['list']);
  assert.ok(!r.calls.some(c => c.startsWith('wait:')), r.calls.join(' '));
});

test('S2: a non-wired adapter that came up during standby means no cut, and the backstop task is removed', opts, () => {
  const d = caseDirs();
  const r = run(d, { adapters: "if ($script:listCount -eq 1) { @('Ethernet') } else { @('Wi-Fi 2', 'Ethernet') }",
    nonWired: "if ($script:nonWiredCount -eq 1) { @() } else { @('Wi-Fi 2') }" });
  assert.equal(r.result.outcome, 'NON_WIRED_ADAPTER', JSON.stringify(r.result));
  assert.match(String(r.result.detail), /Wi-Fi 2/);
  assert.deepEqual(systemCalls(r.calls), ['list', 'register:Ethernet', 'list', 'remove']);
  assert.equal(r.result.backstopRemoved, true);
  assert.equal(fs.existsSync(d.releaseFile), false);
});

const without = (o, dotted) => { const c = structuredClone(o); const [a, b] = dotted.split('.'); if (b) delete c[a][b]; else delete c[a]; return c; };
const S4_CASES = [
  [without(ACTIVE_IDLE, 'current'), '缺 current'],
  [without(ACTIVE_IDLE, 'executor.state'), '缺 executor.state'],
  [without(ACTIVE_IDLE, 'writtenAt'), '缺 writtenAt'],
  [{ ...ACTIVE_IDLE, writtenAt: '2026-11-25T02:55:00.000Z' }, 'status.json 不新鲜'],
  [{ ...ACTIVE_IDLE, writtenAt: 'yesterday' }, 'status.json 不新鲜'],
];

test('S4: a missing key or a status.json older than 120 s is not ready → no cut, release removed, still standing by', opts, () => {
  for (const [status, problem] of S4_CASES) {
    const d = caseDirs({ status });
    const onWait = `if ($script:waitCount -eq 1) { ${writeRelease()} }
      if ($script:waitCount -eq 3) {
        if (-not (Test-Path -LiteralPath $script:rel)) { [void]$script:calls.Add('release-gone') }
        [IO.File]::WriteAllText($script:statusPath, ${q(JSON.stringify(ACTIVE_IDLE))}); ${writeRelease()} }`;
    const r = run(d, { onWait });
    assert.equal(r.result.releasesRefused, 1, `${problem}: ${JSON.stringify(r.result)}`);
    assert.ok(r.result.localProblems.includes(problem), `${problem}: ${JSON.stringify(r.result.localProblems)}`);
    assert.ok(r.calls.includes('release-gone'), `${problem}: ${r.calls.join(' ')}`);
    assert.ok(r.calls.indexOf('release-gone') < r.calls.findIndex(c => c.startsWith('disable')), r.calls.join(' '));
    assert.equal(r.result.outcome, 'CUT_DONE', problem);
  }
});

test('S8: a throw while disabling the second adapter still enables every adapter', opts, () => {
  const r = run(caseDirs(), { realDisable: true, disableThrows: ['Wi-Fi'] });
  const order = systemCalls(r.calls);
  assert.deepEqual(order.slice(order.indexOf('disable1:Ethernet')), ['disable1:Ethernet', 'disable1:Wi-Fi', 'enable:Ethernet,Wi-Fi', 'remove']);
  assert.ok(!r.calls.includes('wait:540'), r.calls.join(' '));
  assert.equal(r.result.outcome, 'CUT_INTERRUPTED', JSON.stringify(r.result));
  assert.match(String(r.result.error), /cannot disable Wi-Fi/);
  assert.ok(r.result.t0 && r.result.restoredAt);
});

test('S8: a shared directory that cannot be written still leaves the local result, outcome unchanged', opts, () => {
  const d = caseDirs();
  d.shared = path.join(d.statusFile, 'shared');      // its parent is a file
  const r = run(d);
  assert.equal(r.result.outcome, 'CUT_DONE', JSON.stringify(r.result));
  assert.equal(r.result.sharedWritten, false);
  const local = JSON.parse(fs.readFileSync(path.join(d.work, 'failover-drill-gen18-t.result.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(local.outcome, 'CUT_DONE');
  assert.equal(local.sharedWritten, false);
});

test('补充三: the second registration failing after release goes back to standby; the next release cuts normally', opts, () => {
  for (const fails of ['$false', "throw 'read back failed'"]) {
    const d = caseDirs();
    const r = run(d, { register: `if ($script:registerCount -eq 2) { ${fails} } else { $true }`,
      onWait: `if ($script:waitCount -eq 1 -or $script:waitCount -eq 2) { ${writeRelease()} }` });
    assert.equal(r.result.outcome, 'CUT_DONE', `${fails}: ${JSON.stringify(r.result)}`);
    assert.deepEqual(systemCalls(r.calls), ['list', 'register:Ethernet,Wi-Fi', 'list', 'register:Ethernet,Wi-Fi', 'list', 'register:Ethernet,Wi-Fi',
      'disable:Ethernet,Wi-Fi', 'enable:Ethernet,Wi-Fi', 'remove'], fails);
    assert.equal(r.result.backstopRetries, 1, fails);
    assert.ok(r.result.error, fails);
  }
});

test('补充三: the second registration never succeeding → no cut, standby until the limit, backstop task kept until then', opts, () => {
  const r = run(caseDirs(), { register: 'if ($script:registerCount -eq 1) { $true } else { $false }',
    onWait: `if ($script:waitCount -eq 1) { ${writeRelease()} }` });
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT', JSON.stringify(r.result));
  noCut(r);
  const order = systemCalls(r.calls);
  assert.equal(order.indexOf('remove'), order.length - 1, order.join(' '));
  assert.equal(r.result.backstopRetries, 1);
});

test('补充三定案: a release file written while the first registration is being retried is not a release', opts, () => {
  const d = caseDirs();
  const r = run(d, { register: 'if ($script:registerCount -eq 1) { $false } else { $true }', onWait: `if ($script:waitCount -eq 1) { ${writeRelease()} }` });
  assert.equal(r.calls[2], 'wait:5', r.calls.join(' '));
  assert.equal(r.result.outcome, 'STANDBY_TIMEOUT', JSON.stringify(r.result));
  noCut(r);
  assert.equal(r.result.staleReleaseRemoved, true);
  assert.equal(fs.existsSync(d.releaseFile), false);
});

test('补充三: the first registration is retried in place, 3 tries 5 s apart', opts, () => {
  const ok = run(caseDirs(), { register: 'if ($script:registerCount -le 2) { $false } else { $true }',
    onWait: `if ($script:waitCount -eq 3) { ${writeRelease()} }` });
  assert.equal(ok.result.outcome, 'CUT_DONE', JSON.stringify(ok.result));
  assert.deepEqual(ok.calls.slice(0, 6), ['list', 'register:Ethernet,Wi-Fi', 'wait:5', 'register:Ethernet,Wi-Fi', 'wait:5', 'register:Ethernet,Wi-Fi']);
  assert.equal(ok.result.backstopRegistered, true);
  for (const register of ['$false', "throw 'access denied'"]) {
    const bad = run(caseDirs(), { register });
    assert.equal(bad.result.outcome, 'BACKSTOP_NOT_REGISTERED', register);
    assert.deepEqual(bad.calls.filter(c => c.startsWith('register') || c.startsWith('wait')),
      ['register:Ethernet,Wi-Fi', 'wait:5', 'register:Ethernet,Wi-Fi', 'wait:5', 'register:Ethernet,Wi-Fi'], register);
    noCut(bad);
  }
});

// Stand-ins for the NetAdapter and ScheduledTasks cmdlets (functions win over cmdlets); nothing on this machine is touched.
const netStubs = ({ enableThrows = [], disabled = [] } = {}) => `
  $script:log = New-Object System.Collections.ArrayList
  function Enable-NetAdapter { [CmdletBinding(SupportsShouldProcess)] param([string]$Name) [void]$script:log.Add("enable:$Name"); if (@(${[...enableThrows].map(q).join(',')}) -contains $Name) { throw "cannot enable $Name" } }
  function Get-NetAdapter { [CmdletBinding()] param([string]$Name, [switch]$Physical) [pscustomobject]@{ Name = $Name; Status = $(if (@(${[...disabled].map(q).join(',')}) -contains $Name) { 'Disabled' } else { 'Up' }) } }
  function Unregister-ScheduledTask { [CmdletBinding(SupportsShouldProcess)] param([string]$TaskName) [void]$script:log.Add("unregister:$TaskName") }
  function Wait-DrillSeconds { param([int]$Seconds) [void]$script:log.Add("wait:$Seconds") }`;

test('M1: Enable-DrillAdapters reads the adapters back; still Disabled or a throw counts as not enabled', opts, () => {
  const r = ps(`${netStubs({ enableThrows: ['Ethernet'], disabled: ['Ethernet', 'Wi-Fi'] })}
    @{ failed = @(Enable-DrillAdapters @('Ethernet', 'Wi-Fi', 'LAN 3')) }`);
  assert.deepEqual(r.failed, ['Ethernet', 'Wi-Fi']);
});

test('M1: the backstop action removes its task only once every adapter reads back not Disabled', opts, () => {
  const action = (s) => ps(`${netStubs(s)}
    & ([scriptblock]::Create((Get-DrillBackstopCommand -TaskName 'CluedFailoverDrillRestore-gen18-t' -Names @('Ethernet', 'Wi-Fi'))))
    @{ log = @($script:log) }`).log;
  const stuck = action({ disabled: ['Wi-Fi'] });
  assert.ok(!stuck.some(l => l.startsWith('unregister')), stuck.join(' '));
  assert.ok(stuck.filter(l => l === 'enable:Wi-Fi').length > 1, `retries inside the action: ${stuck.join(' ')}`);
  assert.deepEqual(stuck.filter(l => l.startsWith('wait:')), Array(5).fill('wait:10'));
  const thrown = action({ enableThrows: ['Ethernet'], disabled: ['Ethernet'] });
  assert.ok(!thrown.some(l => l.startsWith('unregister')), thrown.join(' '));
  const ok = action({});
  assert.deepEqual(ok.filter(l => l.startsWith('wait:') || l.startsWith('unregister')), ['unregister:CluedFailoverDrillRestore-gen18-t']);
});

test('M1: the backstop time trigger repeats every 2 minutes for a day, and there is a boot trigger', opts, () => {
  const r = ps(`@(New-DrillBackstopTriggers -At ([datetime]'2026-11-25T03:12:00Z') | ForEach-Object {
      @{ kind = $_.CimClass.CimClassName; interval = (Get-DrillProp $_.Repetition 'Interval'); duration = (Get-DrillProp $_.Repetition 'Duration') } })`);
  const list = Array.isArray(r) ? r : [r];
  const time = list.filter(t => t.kind === 'MSFT_TaskTimeTrigger');
  assert.equal(time.length, 1, JSON.stringify(list));
  assert.equal(time[0].interval, 'PT2M');
  assert.equal(time[0].duration, 'P1D');
  assert.equal(list.filter(t => t.kind === 'MSFT_TaskBootTrigger').length, 1, JSON.stringify(list));
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
