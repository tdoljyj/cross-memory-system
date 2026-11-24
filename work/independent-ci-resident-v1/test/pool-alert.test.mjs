// The kernel pool alert (board row 140; the Owner on 11-24: "到线通知我 别擅自 自动重启"; docs/architecture.md 9.1). Two must-be-red
// tests: a line reached is always notified, and no path ever restarts or shuts down the machine. Every port is fake: the clock is a
// number the test moves, the lane is stepped by hand every 10 minutes, run() answers the one pool reader from a small world and
// records everything else. Nothing reads the real clock, no real timer runs, nothing is ever restarted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GIB, POOL_ALERT_DEFAULTS, POOL_ALERT_EVERY_MS, PoolAlert, beijing, parsePoolReading, validatePoolAlertConfig }
  from '../src/pool-alert.mjs';
import { POOL_TAGS_TOOL, argv } from '../src/companion.mjs';
import { suspiciousText } from '../src/notify-queue.mjs';

const RESIDENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = Object.freeze({ wslExe: 'C:\\Windows\\System32\\wsl.exe', distribution: 'Ubuntu-24.04', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
const T0 = Date.parse('2026-11-25T04:00:00.000Z');   // 12:00 Beijing time
const MIN = 60_000, HOUR = 60 * MIN;
const LIMIT = 96 * GIB;

async function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'pool-alert-')); }
// pool: the largest tag's bytes, or 'fail' (the reader fails) or 'shape' (output of another shape).
function world(over = {}) {
  return { now: T0, bootAt: T0 - 2 * HOUR, pool: Math.round(1 * GIB), commit: 60 * GIB, commands: [], notices: [], notifyFails: 0, ...over };
}
function fakeRun(w) {
  return async (a, o) => {
    w.commands.push({ at: w.now, a, o });
    if (a.includes(POOL_TAGS_TOOL)) {
      if (w.pool === 'fail') return { code: 1, stdout: '' };
      if (w.pool === 'shape') return { code: 0, stdout: '{"contract":"clued.independent-ci.pool-tags/1","tags":[]}\n' };
      return { code: 0, stdout: `${JSON.stringify({ contract: 'clued.independent-ci.pool-reading/1', top: { tag: 'Toke', pagedBytes: w.pool, pagedCount: Math.floor(w.pool / 2175) },
        pagedPoolBytes: w.pool + Math.round(0.9 * GIB), commitBytes: w.commit, commitLimitBytes: LIMIT })}\n` };
    }
    return { code: null, stdout: '', refused: 'TEST_UNKNOWN_ARGV' };
  };
}
function lane(w, dir, { config = POOL_ALERT_DEFAULTS } = {}) {
  return new PoolAlert({ config, a: argv(CFG), run: fakeRun(w), dir, clock: () => w.now, uptimeMs: () => w.now - w.bootAt, node: 'node-a',
    notify: async (key, title, body) => {
      if (w.notifyFails > 0) { w.notifyFails -= 1; throw new Error('QUEUE_WRITE_FAILED'); }
      w.notices.push({ at: w.now, key, title, body });
    } });
}
// One reading every 10 minutes; pool may be a number or a function of the reading's index.
async function readings(w, pa, n, pool = w.pool) {
  for (let i = 0; i < n; i += 1) {
    w.now += POOL_ALERT_EVERY_MS;
    w.pool = typeof pool === 'function' ? pool(i) : pool;
    await pa.step();
  }
}

// ---- Must be red 1: a line reached is always notified, once per line per episode, with what the Owner needs to decide ----
test('MUST-RED 1: over a line the Owner is always notified (once per line and episode, with the pool, the commit headroom, the hours to the line and when to restart)', async () => {
  // Growing by 0.25 GiB an hour from 2.5 GiB: two readings over 3 GiB, then exactly one soft notice.
  {
    const dir = await tmpDir(), w = world(), pa = lane(w, dir);
    const start = 2.5 * GIB, perReading = 0.25 * GIB / 6;
    await readings(w, pa, 12, i => Math.round(start + i * perReading));   // 2 hours, still under the line
    assert.equal(w.notices.length, 0, 'under the line: nothing');
    let i = 12;
    while (w.pool < 3 * GIB) { await readings(w, pa, 1, Math.round(start + i * perReading)); i += 1; }
    assert.equal(w.notices.length, 0, 'one reading over the line is not yet a line');
    await readings(w, pa, 1, Math.round(start + i * perReading)); i += 1;
    assert.equal(w.notices.length, 1, 'the second reading over the soft line notifies');
    const n = w.notices[0];
    assert.match(n.title, /软线/);
    assert.match(n.body, /分页池共 \d+\.\d\d GiB/, 'the paged pool now');
    assert.match(n.body, /离提交上限还有 \d+\.\d\d GiB/, 'the commit headroom');
    assert.match(n.body, /约 \d+\.\d 小时到硬线（\d\d-\d\d \d\d:\d\d）/, 'the hours to the hard line at the current growth');
    assert.match(n.body, /0\.25 GiB\/小时/, 'the growth');
    assert.match(n.body, /建议：在 \d\d-\d\d \d\d:\d\d（北京时间）前/, 'when to restart');
    assert.match(n.body, new RegExp(CODES.soft));
    assert.match(n.body, /不会自动重启/);
    assert.ok(n.title.length <= 400 && n.body.length <= 400, 'within the queue\'s 400 characters');
    assert.equal(suspiciousText(n.title, n.body), false, 'the notifier shows it as it is');
    // Fixed throttle: more readings over the soft line notify nothing more, also across a companion restart.
    await readings(w, pa, 6, Math.round(3.4 * GIB));
    const again = lane(w, dir);
    await readings(w, again, 6, Math.round(3.4 * GIB));
    assert.equal(w.notices.length, 1, 'the same episode is not notified again');
    // Escalation: the hard line is notified once, too.
    await readings(w, again, 2, Math.round(5.2 * GIB));
    assert.equal(w.notices.length, 2);
    assert.match(w.notices[1].title, /硬线/);
    assert.match(w.notices[1].body, new RegExp(CODES.hard));
    assert.match(w.notices[1].body, /建议：今天在 CI 空闲时尽快重启/);
    await readings(w, again, 12, Math.round(5.3 * GIB));
    assert.equal(w.notices.length, 2, 'the hard line once per episode');
    // Two readings under the soft line end the episode; the next crossing is a new one and is notified again.
    await readings(w, again, 2, Math.round(0.5 * GIB));
    await readings(w, again, 2, Math.round(3.2 * GIB));
    assert.equal(w.notices.length, 3, 'a new episode is notified');
    assert.notEqual(w.notices[2].key, w.notices[0].key);
  }
  // Straight over the hard line: one hard notice, no soft one first.
  {
    const dir = await tmpDir(), w = world(), pa = lane(w, dir);
    await readings(w, pa, 2, Math.round(5.5 * GIB));
    assert.deepEqual(w.notices.map(n => n.key.split(':')[1]), ['hard']);
    assert.match(w.notices[0].body, /估不出/, 'no growth yet: said so, not made up');
  }
  // A notice the queue could not take is tried again at the next reading: never lost.
  {
    const dir = await tmpDir(), w = world({ notifyFails: 2 }), pa = lane(w, dir);
    await readings(w, pa, 4, Math.round(3.5 * GIB));
    assert.equal(w.notices.length, 1, 'queued at the third try');
    await readings(w, pa, 4, Math.round(3.5 * GIB));
    assert.equal(w.notices.length, 1);
  }
  // Configured lines are the lines.
  {
    const dir = await tmpDir(), w = world(), pa = lane(w, dir, { config: validatePoolAlertConfig({ softBytes: GIB, hardBytes: 2 * GIB }) });
    await readings(w, pa, 2, Math.round(1.5 * GIB));
    assert.equal(w.notices.length, 1);
  }
});

// ---- Must be red 2: no path ever restarts or shuts down the machine ----
const RESTART = /shutdown\.exe|\bshutdown\s+\/[rsgpaf]\b|Restart-Computer|Stop-Computer|InitiateSystemShutdown|ExitWindowsEx|NtShutdownSystem|SeShutdownPrivilege/i;
async function packageFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await packageFiles(p));
    else out.push(p);
  }
  return out;
}
test('MUST-RED 2: no path restarts or shuts down the machine: nothing in the package can, and the lane runs only the read-only pool reader', async () => {
  // Statically: nothing the resident package ships (src, tools, windows: build-package.mjs#RESIDENT_FILES) and nothing of the
  // upgrader names a restart or shutdown command, API or privilege.
  const hits = [];
  for (const top of ['src', 'tools', 'windows', 'upgrader']) {
    for (const f of await packageFiles(path.join(RESIDENT, top))) {
      const text = await fs.readFile(f, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => { if (RESTART.test(line)) hits.push(`${path.relative(RESIDENT, f)}:${i + 1}: ${line.trim()}`); });
    }
  }
  assert.deepEqual(hits, [], 'no restart or shutdown anywhere in the package');
  // The companion's fixed commands: none of them restarts.
  const a = argv(CFG);
  for (const [name, build] of Object.entries(a)) {
    if (typeof build !== 'function' || build.length !== 0) continue;
    let built;
    try { built = build(); } catch { continue; }
    if (Array.isArray(built)) assert.ok(!RESTART.test(built.join(' ')), name);
  }
  // Dynamically: every path of the lane (under, soft, hard, escalation, unreadable, wrong shape, a failing queue, a companion
  // restart, a machine restart, switched off) runs the pool reader and nothing else.
  const dir = await tmpDir(), w = world({ notifyFails: 1 });
  let pa = lane(w, dir);
  await readings(w, pa, 6, i => Math.round((1 + i) * GIB));
  await readings(w, pa, 12, Math.round(5.8 * GIB));
  await readings(w, pa, 2, 'fail');
  await readings(w, pa, 2, 'shape');
  pa = lane(w, dir);
  await readings(w, pa, 6, Math.round(6 * GIB));
  w.bootAt = w.now + MIN; w.now += 3 * MIN;   // the Owner restarted the machine himself
  pa = lane(w, dir);
  await readings(w, pa, 6, Math.round(0.4 * GIB));
  const off = lane(w, dir, { config: validatePoolAlertConfig({ enabled: false }) });
  await readings(w, off, 6, Math.round(6 * GIB));
  assert.ok(w.commands.length > 0);
  const reader = a.poolTags();
  for (const c of w.commands) assert.deepEqual(c.a, reader, 'only the read-only pool reader');
  assert.equal(w.commands.filter(c => c.at > w.now - 6 * POOL_ALERT_EVERY_MS).length, 0, 'switched off: nothing runs at all');
  assert.ok(w.notices.length >= 1);
});

// ---- The pieces ----
test('the reader\'s output, the configuration and Beijing time', () => {
  const ok = '{"contract":"clued.independent-ci.pool-reading/1","top":{"tag":"FMfn","pagedBytes":856692816,"pagedCount":1540223},"pagedPoolBytes":5931110400,"commitBytes":65845653504,"commitLimitBytes":96316837888}\n';
  assert.deepEqual(parsePoolReading(ok), { tag: 'FMfn', bytes: 856692816, count: 1540223, pagedPoolBytes: 5931110400, commitBytes: 65845653504, commitLimitBytes: 96316837888 });
  for (const bad of ['', 'x', ok.replace('pool-reading/1', 'pool-reading/2'), ok.replace('"FMfn"', '"FMfnX"'), ok.replace('856692816', '-1'),
    ok.replace('96316837888', '0'), ok.replace('5931110400', '1.5'), '{"contract":"clued.independent-ci.pool-reading/1"}']) assert.equal(parsePoolReading(bad), null, bad);
  assert.deepEqual(validatePoolAlertConfig(undefined), { enabled: true, softBytes: 3 * GIB, hardBytes: 5 * GIB });
  for (const bad of [[], 'x', { softBytes: 5 * GIB, hardBytes: 3 * GIB }, { softBytes: 1 }, { enabled: 'yes' }, { other: 1 }, { softBytes: 3.5 }])
    assert.throws(() => validatePoolAlertConfig(bad), /COMPANION_POOL_ALERT_CONFIG_INVALID/);
  assert.equal(beijing(T0), '11-25 12:00');
});
