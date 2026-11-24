// The node reboot fallback (design D:/w/tmp/FABLE-admission-reboot-batch-20261124.md section 4, tests N1-N10; docs/architecture.md 9.1).
// Every port is fake: the clock is a number the test moves, the lane is stepped by hand every 5 s, and run() answers the companion's
// fixed commands (shutdown.exe, tasklist, quser, whoami, the pool tag reader, the self read, wsl) from a small world. Nothing reads the
// real clock, no real timer runs, and nothing is ever shut down or restarted: shutdown.exe is only recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODES, GIB, NODE_REBOOT_DEFAULTS, NODE_REBOOT_HOLDER, NodeReboot, RECEIPT_CHECK_FAILED, RECEIPT_VERIFIED, parsePoolTags,
  parsePrivileges, parseQuserIdleMs, parseTasklist, validateNodeRebootConfig } from '../src/node-reboot.mjs';
import { POOL_TAGS_TOOL, QUSER_EXE, REBOOT_COMMENT, SHUTDOWN_EXE, TASKLIST_EXE, WHOAMI_PRIV_EXE, argv, shutdownArgvOk } from '../src/companion.mjs';
import { INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT } from '../src/intake-pause.mjs';

const ROOT = 'C:\\ProgramData\\CluedIndependentCI\\resident';
const CFG = Object.freeze({ wslExe: 'C:\\Windows\\System32\\wsl.exe', distribution: 'Ubuntu-24.04', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
const T0 = Date.parse('2026-11-25T04:00:00.000Z');
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const STEP = 5 * SEC;
const OVER_SOFT = Math.round(3.5 * GIB);   // between the default lines
const OVER_HARD = Math.round(5.5 * GIB);
const LOW = Math.round(0.4 * GIB);

async function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'node-reboot-')); }

// The world the fake commands read. pool: bytes of the largest tag, 'fail' (the tool fails) or 'shape' (output of another shape).
function world(over = {}) {
  return { now: T0, bootAt: T0 - 2 * HOUR, pool: OVER_SOFT, processes: ['System', 'tasklist.exe', 'Runner.Listener.exe'], wslWorker: false, wslUp: true,
    idleMin: 45, privileges: ['SeChangeNotifyPrivilege', 'SeShutdownPrivilege'],
    self: { session: 0, parentName: 'CluedCompanionSupervisor.exe', parentPath: `${ROOT}\\bin\\CluedCompanionSupervisor.exe` },
    status: {}, upgradePending: false, heartbeat: true, shutdownCode: 0, commands: [], requests: [], notices: [], ...over };
}
function statusOf(w) {
  const extra = typeof w.status === 'function' ? w.status(w) : w.status;
  return { writtenAt: w.now - 5 * SEC, executor: { state: 'IDLE', companion: { firstBeatAfterServiceStartMs: 2000 } }, halt: null, paused: false, intakePause: null,
    node: { name: 'DESK', source: 'abcdef012345', mode: 'ACTIVE' }, current: null, pending: [], versions: { generation: 18, upgrade: null }, ...extra };
}
function fakeRun(w) {
  return async a => {
    const exe = a[0];
    if (exe === SHUTDOWN_EXE) { w.commands.push({ at: w.now, args: a.slice(1) }); return { code: w.shutdownCode, stdout: '' }; }
    if (exe === TASKLIST_EXE) {
      if (w.processes === null) return { code: 1, stdout: '' };
      return { code: 0, stdout: `${w.processes.map((n, i) => `"${n}","${100 + i}","Services","0","1,000 K"`).join('\r\n')}\r\n` };
    }
    if (exe === QUSER_EXE) {
      if (w.idleMin === null) return { code: 1, stdout: '' };
      return { code: 0, stdout: ` USERNAME  SESSIONNAME  ID  STATE  IDLE TIME  LOGON TIME\r\n>owner  console  1  Active  ${w.idleMin === 0 ? 'none' : w.idleMin}  11/25/2026 9:00 AM\r\n` };
    }
    if (exe === WHOAMI_PRIV_EXE) return { code: 0, stdout: w.privileges.map(p => `"${p}","x","Disabled"`).join('\r\n') };
    if (exe === CFG.powershellExe && a.includes('-File') && a.at(-1) === POOL_TAGS_TOOL) {
      if (w.pool === 'fail') return { code: 1, stdout: '' };
      if (w.pool === 'shape') return { code: 0, stdout: '{"tags":[{"tag":"Toke","bytes":1}]}\n' };
      return { code: 0, stdout: `${JSON.stringify({ contract: 'clued.independent-ci.pool-tags/1', tags: [{ tag: 'Ntff', pagedBytes: 300 * 1024 * 1024, pagedCount: 400000 },
        { tag: 'Toke', pagedBytes: w.pool, pagedCount: Math.floor(w.pool / 2175) }] })}\n` };
    }
    if (exe === CFG.powershellExe && a.includes('-Command')) return { code: 0, stdout: `${JSON.stringify(w.self)}\r\n` };
    if (exe === CFG.wslExe && a.includes('/usr/bin/pgrep')) return w.wslWorker === null ? { code: 2, stdout: '' } : { code: w.wslWorker ? 0 : 1, stdout: '' };
    if (exe === CFG.wslExe && a.includes('/usr/bin/true')) return { code: w.wslUp ? 0 : 1, stdout: '' };
    return { code: null, stdout: '', refused: 'TEST_UNKNOWN_ARGV' };
  };
}
function lane(w, dir, { config = NODE_REBOOT_DEFAULTS, a = argv(CFG) } = {}) {
  return new NodeReboot({ config, a, run: fakeRun(w), root: ROOT, dir, clock: () => w.now, uptimeMs: () => w.now - w.bootAt, pid: 4242,
    readStatus: async () => { if (w.status === 'fail') throw new Error('STATUS_REFUSED'); return statusOf(w); },
    upgradePending: async () => w.upgradePending,
    writeRequest: async v => { w.requests.push({ at: w.now, v, intents: readdirSync(dir).filter(n => n.startsWith('intent-')).length }); },
    notify: async (key, title, body) => { w.notices.push({ key, title, body }); },
    heartbeatOk: () => w.heartbeat });
}
// Step the lane every 5 s for ms (or until stop(w) after a step).
async function advance(w, nr, ms, stop = () => false) {
  for (let t = 0; t < ms; t += STEP) {
    w.now += STEP;
    await nr.step();
    if (stop(w)) return true;
  }
  return false;
}
const restarts = w => w.commands.filter(c => c.args[0] === '/r');
const aborts = w => w.commands.filter(c => c.args[0] === '/a');
const pauses = w => w.requests.filter(r => r.v.contract === INTAKE_PAUSE_CONTRACT);
const resumes = w => w.requests.filter(r => r.v.contract === INTAKE_RESUME_CONTRACT);
const readJson = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
const closes = async dir => Promise.all((await fs.readdir(dir)).filter(n => n.startsWith('close-')).map(n => readJson(dir, n)));

// Simulate the machine's restart after the lane's restart command: a later boot, a fresh companion on the same records.
function rebootWorld(w, { after = 90 * SEC, up = 2 * MIN } = {}) {
  const last = restarts(w).at(-1);
  w.bootAt = last.at + Number(last.args[2]) * SEC + after;
  w.now = w.bootAt + up;
}

test('N1: over the soft line twice, CI idle, nobody at the machine: intent first, then the pause, then exactly one shutdown /r /t 60', async () => {
  const dir = await tmpDir(), w = world(), nr = lane(w, dir);
  assert.equal(await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0), true, 'the lane restarts the node');
  await advance(w, nr, 2 * MIN);
  assert.equal(restarts(w).length, 1);
  assert.deepEqual(w.commands[0].args, ['/r', '/t', '60', '/c', REBOOT_COMMENT]);
  const p = pauses(w);
  assert.ok(p.length >= 1);
  assert.equal(p[0].v.holder, NODE_REBOOT_HOLDER);
  assert.equal(p[0].v.minutes, 30);
  assert.equal(p[0].intents, 1, 'the intent record is written before the pause request');
  assert.ok(p[0].at <= w.commands[0].at);
  const intent = (await fs.readdir(dir)).filter(n => n.startsWith('intent-'));
  assert.equal(intent.length, 1);
  const v = await readJson(dir, intent[0]);
  assert.equal(v.line, 'soft');
  assert.equal(v.reading.tag, 'Toke');
  assert.equal(v.reading.bytes, OVER_SOFT);
  assert.equal(v.bootAt, w.bootAt);
  // One reading over the line is not enough: the restart needs two readings ten minutes apart plus ten idle minutes.
  assert.ok(w.commands[0].at - T0 >= 20 * MIN);
});

test('N2: a person at the machine holds the soft line; over the hard line the lane pauses at once and restarts with /t 600', async () => {
  const dir = await tmpDir(), w = world({ idleMin: 5 }), nr = lane(w, dir);
  await advance(w, nr, 3 * HOUR);
  assert.equal(w.commands.length, 0, 'the soft line waits for the person to leave');
  assert.equal(w.requests.length, 0, 'and holds nothing while it waits');
  w.pool = OVER_HARD;
  assert.equal(await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0), true);
  assert.equal(pauses(w)[0].intents, 0, 'the hard line asks for the pause before any intent');
  assert.deepEqual(restarts(w)[0].args, ['/r', '/t', '600', '/c', REBOOT_COMMENT]);
  const intent = (await fs.readdir(dir)).filter(n => n.startsWith('intent-'));
  assert.equal((await readJson(dir, intent[0])).line, 'hard');
});

for (const [name, arrive] of [
  ['a Runner.Worker on Windows', w => { w.processes = [...w.processes, 'Runner.Worker.exe']; }],
  ['a Runner.Worker in WSL', w => { w.wslWorker = true; }],
  ['a batch the resident opened', w => { w.status = { current: { pr: 7, headSha: 'a'.repeat(40), attempt: 1, stage: 1 } }; }],
  ['an upgrade request', w => { w.upgradePending = true; }],
]) {
  test(`N3: ${name} during the countdown aborts it (/a), is recorded, and the lane starts again from the three reads 5 minutes later`, async () => {
    const dir = await tmpDir(), w = world(), nr = lane(w, dir);
    await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0);
    const before = { processes: w.processes, wslWorker: w.wslWorker, status: w.status, upgradePending: w.upgradePending };
    arrive(w);
    await advance(w, nr, STEP);
    assert.equal(aborts(w).length, 1);
    assert.deepEqual(aborts(w)[0].args, ['/a']);
    const state = await readJson(dir, 'state.json');
    assert.equal(state.cancels.length, 1);
    assert.equal(state.cancels[0].kind, 'work-arrived');
    Object.assign(w, before);
    await advance(w, nr, 4 * MIN);
    assert.equal(restarts(w).length, 1, 'nothing for 5 minutes');
    assert.equal(await advance(w, nr, 3 * MIN, x => restarts(x).length > 1), true);
    assert.ok(restarts(w)[1].at - aborts(w)[0].at >= 5 * MIN);
    assert.equal((await fs.readdir(dir)).filter(n => n.startsWith('intent-')).length, 1, 'the same episode: no second intent');
  });
}

for (const [name, set] of [
  ['a batch in flight', w => { w.status = { current: { pr: 7, headSha: 'a'.repeat(40), attempt: 1, stage: 3 } }; }],
  ['a RUNNING row', w => { w.status = { pending: [{ pr: 8, headSha: 'b'.repeat(40), state: 'RUNNING' }] }; }],
  ['HALT', w => { w.status = { halt: { code: 'SOME_HALT', at: T0 }, executor: { state: 'HALTED', companion: { firstBeatAfterServiceStartMs: 1 } } }; }],
  ['PAUSE', w => { w.status = { paused: true }; }],
  ['an upgrade op in flight', w => { w.status = { versions: { generation: 18, upgrade: { opId: 'c'.repeat(8), state: 'RUNNING' } } }; }],
  ['an upgrade mailbox request', w => { w.upgradePending = true; }],
  ['a stale status', w => { w.status = x => ({ writtenAt: x.now - 10 * MIN }); }],
  ['an unreadable status', w => { w.status = 'fail'; }],
  ['an unreadable process table', w => { w.processes = null; }],
  ['an unreadable WSL process list', w => { w.wslWorker = null; }],
]) {
  test(`N4: ${name} keeps the node from restarting, on the soft and the hard line`, async () => {
    for (const pool of [OVER_SOFT, OVER_HARD]) {
      const dir = await tmpDir(), w = world({ pool }), nr = lane(w, dir);
      set(w);
      await advance(w, nr, 3 * HOUR);
      assert.equal(restarts(w).length, 0, `no restart at ${pool}`);
    }
  });
}

for (const pool of ['fail', 'shape']) {
  test(`N5: a pool read that ${pool === 'fail' ? 'fails' : 'has another shape'} does nothing: no pause, no command, no notice`, async () => {
    const dir = await tmpDir(), w = world({ pool }), nr = lane(w, dir);
    await advance(w, nr, 3 * HOUR);
    assert.deepEqual([w.commands.length, w.requests.length, w.notices.length], [0, 0, 0]);
  });
}

test('N6: on the hard line with work that never ends, the pause is lifted after 2 hours, one notice, and no new try for 6 hours', async () => {
  const dir = await tmpDir(), w = world({ pool: OVER_HARD }), nr = lane(w, dir);
  w.processes = [...w.processes, 'Runner.Worker.exe'];
  await advance(w, nr, 30 * MIN);
  const first = pauses(w)[0];
  assert.ok(first, 'the hard line pauses at once');
  assert.equal(await advance(w, nr, 3 * HOUR, x => resumes(x).length > 0), true);
  const lifted = resumes(w)[0];
  assert.equal(lifted.v.holder, NODE_REBOOT_HOLDER);
  assert.ok(lifted.at - first.at >= 2 * HOUR && lifted.at - first.at < 2 * HOUR + 2 * MIN, 'lifted at two hours');
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].body, new RegExp(CODES.FAILED));
  assert.equal(restarts(w).length, 0);
  const pausesBefore = pauses(w).length;
  await advance(w, nr, 5 * HOUR + 50 * MIN);
  assert.equal(pauses(w).length, pausesBefore, 'nothing for six hours');
  assert.equal(w.notices.length, 1, 'one notice only');
  await advance(w, nr, 40 * MIN);
  assert.ok(pauses(w).length > pausesBefore, 'tried again after six hours');
});

test('N7: after the restart every check passes: node-reboot-verified with the readings, and the pause is lifted', async () => {
  const dir = await tmpDir(), w = world(), nr = lane(w, dir);
  await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0);
  rebootWorld(w);
  w.pool = LOW;
  const after = lane(w, dir);
  await advance(w, after, 3 * MIN);
  const c = await closes(dir);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, RECEIPT_VERIFIED);
  assert.equal(c[0].bootAt, w.bootAt);
  assert.equal(c[0].before.bytes, OVER_SOFT);
  assert.equal(c[0].after.bytes, LOW);
  assert.equal(typeof c[0].downMs, 'number');
  assert.equal(resumes(w).at(-1).v.holder, NODE_REBOOT_HOLDER);
  assert.equal(w.notices.length, 0);
});

test('N7: after the restart a check that does not pass in 15 minutes: node-reboot-check-failed, one notice, the pause lifted, nothing else', async () => {
  const dir = await tmpDir(), w = world(), nr = lane(w, dir);
  await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0);
  rebootWorld(w);
  w.pool = LOW;
  w.status = { versions: { generation: 19, upgrade: null } };   // the generation changed across the restart
  const after = lane(w, dir);
  await advance(w, after, 10 * MIN);
  assert.equal((await closes(dir)).length, 0, 'still within 15 minutes');
  await advance(w, after, 10 * MIN);
  const c = await closes(dir);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, RECEIPT_CHECK_FAILED);
  assert.deepEqual(c[0].failed, ['version']);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].body, new RegExp(CODES.CHECK_FAILED));
  assert.ok(resumes(w).length >= 1);
  const commands = w.commands.length;
  await advance(w, after, 2 * HOUR);
  assert.equal(w.commands.length, commands, 'no command after a failed check');
});

test('N8: a first reading after the restart still at half the soft line or more switches the lane off for good', async () => {
  const dir = await tmpDir(), w = world(), nr = lane(w, dir);
  await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0);
  rebootWorld(w);
  w.pool = Math.round(1.6 * GIB);   // half of 3 GiB is 1.5 GiB
  const after = lane(w, dir);
  await advance(w, after, 2 * MIN);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].body, new RegExp(CODES.INEFFECTIVE));
  assert.equal((await closes(dir))[0].code, CODES.INEFFECTIVE);
  assert.equal(after.phase, 'disabled');
  const counts = [restarts(w).length, pauses(w).length];
  w.pool = OVER_HARD;
  await advance(w, after, 12 * HOUR);
  const again = lane(w, dir);   // and after a companion restart
  await advance(w, again, 12 * HOUR);
  assert.deepEqual([restarts(w).length, pauses(w).length], counts, 'never again');
  assert.equal(w.notices.length, 1);
});

for (const [name, change, reason] of [
  ['no SeShutdownPrivilege', w => { w.privileges = ['SeChangeNotifyPrivilege']; }, 'NO_SHUTDOWN_PRIVILEGE'],
  ['not in session 0', w => { w.self = { ...w.self, session: 1 }; }, 'NOT_SESSION_0'],
  ['not started by the supervisor', w => { w.self = { ...w.self, parentName: 'explorer.exe', parentPath: 'C:\\Windows\\explorer.exe' }; }, 'NOT_STARTED_BY_SUPERVISOR'],
]) {
  test(`N9: ${name}: NODE_REBOOT_UNAVAILABLE with its reason, no pause, no command, no notice`, async () => {
    const dir = await tmpDir(), w = world({ pool: OVER_HARD }), nr = lane(w, dir);
    change(w);
    await advance(w, nr, 3 * HOUR);
    const a = await readJson(dir, 'availability.json');
    assert.equal(a.available, false);
    assert.equal(a.code, CODES.UNAVAILABLE);
    assert.equal(a.reason, reason);
    assert.deepEqual([w.commands.length, w.requests.length, w.notices.length], [0, 0, 0]);
  });
}

test('N9: the self-report of a node that can work says so', async () => {
  const dir = await tmpDir(), w = world({ pool: LOW }), nr = lane(w, dir);
  await advance(w, nr, STEP);
  const a = await readJson(dir, 'availability.json');
  assert.deepEqual([a.available, a.code, a.reason, a.shutdownPrivilege, a.session, a.supervised], [true, null, null, true, 0, true]);
});

test('N10: shutdown.exe has exactly two fixed argument groups; everything else is refused, also inside the lane', async () => {
  const a = argv(CFG);
  assert.equal(SHUTDOWN_EXE, 'C:\\Windows\\System32\\shutdown.exe');
  assert.deepEqual(a.reboot(60), [SHUTDOWN_EXE, '/r', '/t', '60', '/c', REBOOT_COMMENT]);
  assert.deepEqual(a.reboot(600), [SHUTDOWN_EXE, '/r', '/t', '600', '/c', REBOOT_COMMENT]);
  assert.deepEqual(a.rebootAbort(), [SHUTDOWN_EXE, '/a']);
  for (const bad of [0, 30, 3600, '60', null, undefined]) assert.throws(() => a.reboot(bad), /COMPANION_REBOOT_ARGS_INVALID/);
  for (const ok of [a.reboot(60), a.reboot(600), a.rebootAbort()]) assert.equal(shutdownArgvOk(ok), true);
  for (const bad of [[SHUTDOWN_EXE, '/s', '/t', '0'], [SHUTDOWN_EXE, '/r', '/t', '0'], [SHUTDOWN_EXE, '/r', '/t', '60'], [SHUTDOWN_EXE, '/r', '/t', '60', '/c', 'other'],
    [SHUTDOWN_EXE, '/r', '/t', '60', '/c', REBOOT_COMMENT, '/f'], [SHUTDOWN_EXE, '/a', '/m', '\\\\other'], ['C:\\Temp\\shutdown.exe', '/a'], [SHUTDOWN_EXE], []]) {
    assert.equal(shutdownArgvOk(bad), false, JSON.stringify(bad));
  }
  // The lane refuses a shutdown.exe argv outside the two groups whatever built it.
  const dir = await tmpDir(), w = world();
  const nr = lane(w, dir, { a: { ...argv(CFG), reboot: () => [SHUTDOWN_EXE, '/s', '/t', '0'] } });
  await advance(w, nr, 2 * HOUR);
  assert.equal(w.commands.length, 0);
});

test('the parsers: pool tags, tasklist, quser (also localized), whoami /priv', () => {
  assert.deepEqual(parsePoolTags('{"contract":"clued.independent-ci.pool-tags/1","tags":[{"tag":"Ntff","pagedBytes":10,"pagedCount":1},{"tag":"Toke","pagedBytes":20,"pagedCount":2}]}\n'),
    { tag: 'Toke', bytes: 20, count: 2 });
  for (const bad of ['', 'x', '{"contract":"clued.independent-ci.pool-tags/1","tags":[]}', '{"contract":"other","tags":[{"tag":"Toke","pagedBytes":1,"pagedCount":1}]}',
    '{"contract":"clued.independent-ci.pool-tags/1","tags":[{"tag":"Toke","pagedBytes":-1,"pagedCount":1}]}',
    '{"contract":"clued.independent-ci.pool-tags/1","tags":[{"tag":"Toke","pagedBytes":1.5,"pagedCount":1}]}']) assert.equal(parsePoolTags(bad), null, bad);
  assert.equal(parseTasklist('"System","4","Services","0","16 K"\r\n'), null, 'a list without its own reader is no list');
  assert.deepEqual([...parseTasklist('"System","4","Services","0","16 K"\r\n"Runner.Worker.exe","9","Services","0","1 K"\r\n"tasklist.exe","10","Console","1","9 K"\r\n')],
    ['system', 'runner.worker.exe', 'tasklist.exe']);
  assert.equal(parseQuserIdleMs(' 用户名                会话名             ID  状态    空闲时间   登录时间\r\n>windows               console             1  运行中      无     2026/11/24 10:26\r\n'), 0);
  assert.equal(parseQuserIdleMs(' USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME\r\n>owner console 1 Active 1:05 11/25/2026 9:00 AM\r\n'), 65 * MIN);
  assert.equal(parseQuserIdleMs(' USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME\r\n owner 2 Disc 2+03:04 11/25/2026 9:00 AM\r\n other console 3 Active 40 11/25/2026 9:00 AM\r\n'), 40 * MIN);
  assert.equal(parseQuserIdleMs('No User exists for *\r\n'), null);
  assert.deepEqual([...parsePrivileges('"SeShutdownPrivilege","关闭系统","已禁用"\r\n"SeChangeNotifyPrivilege","x","已启用"\r\n')], ['SeShutdownPrivilege', 'SeChangeNotifyPrivilege']);
  assert.equal(parsePrivileges(''), null);
});

test('companion.json nodeReboot: on by default with 3 GiB and 5 GiB; anything else of another shape is refused', () => {
  assert.deepEqual({ ...validateNodeRebootConfig(undefined) }, { enabled: true, softBytes: 3 * GIB, hardBytes: 5 * GIB });
  assert.deepEqual({ ...validateNodeRebootConfig({ softBytes: 2 * GIB }) }, { enabled: true, softBytes: 2 * GIB, hardBytes: 5 * GIB });
  assert.equal(validateNodeRebootConfig({ enabled: false }).enabled, false);
  for (const bad of [[], 'on', { enabled: 'yes' }, { softBytes: 6 * GIB }, { softBytes: 1.5 }, { hardBytes: 10 }, { other: 1 }]) {
    assert.throws(() => validateNodeRebootConfig(bad), /COMPANION_NODE_REBOOT_CONFIG_INVALID/, JSON.stringify(bad));
  }
});

test('a companion restart in the same boot while a restart is pending aborts it and lifts the pause', async () => {
  const dir = await tmpDir(), w = world(), nr = lane(w, dir);
  await advance(w, nr, 2 * HOUR, x => restarts(x).length > 0);
  const again = lane(w, dir);
  await advance(w, again, STEP);
  assert.equal(aborts(w).length, 1);
  assert.equal((await closes(dir))[0].kind, 'companion-restarted');
  assert.equal(resumes(w).length, 1);
});
