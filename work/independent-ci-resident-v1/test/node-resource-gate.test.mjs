// The disk/memory guard (node governance v1; field facts 2026-11-15: no node had the governance task, so the status-file-only gate
// held nothing while TURING's C: fell to 5 GB). The resident reads the rule itself (host-capacity.mjs#createNodeResourceReader): the
// governance status when fresh, else its own drives (the WSL disk's and the resident root's) at the standard's 10/15 GB and host
// memory at 1.5/2.5 GB, with hysteresis. Red holds new batches through the executor's own intake hold (holder node-resource): the
// status board, the PR page line and the heartbeat (INTAKE_PAUSED) say it; green again lifts it. The companion removes the bundles
// of ended batches first (companion.mjs#pruneBundles). A guard that cannot read does nothing (never a hold, never HALT).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DISK_LEVELS, MEMORY_LEVELS, NODE_MEMORY_LOW, NODE_RESOURCE_HOLDER, NODE_RESOURCE_RED, NODE_STATUS_CONTRACT, capacityText, createNodeResourceReader,
  readNodeStatus, resourceHoldAlert, wslDrive } from '../src/host-capacity.mjs';
import { NODE_RESOURCE_HOLD_MINUTES } from '../src/executor.mjs';
import { BUNDLE_KEEP_MS, BUNDLE_KEEP_NEWEST, pruneBundles } from '../src/companion.mjs';
import { heartbeatPayload } from '../src/companion-heartbeat.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { canonicalJson } from '../src/canonical.mjs';
import { executorFixture, tempRoot, triggerBytes } from './helpers.mjs';

const T0 = Date.parse('2026-11-15T05:00:00Z');
const GB = 1024 ** 3;
const status = (level, extra = {}) => ({ contract: NODE_STATUS_CONTRACT, host: 'home-primary', writtenAt: new Date(T0).toISOString(), level,
  intake: { drive: 'C', level }, drives: [{ drive: 'C', freeGb: level === 'red' ? 12.3 : 80, totalGb: 237, level }], linuxRunners: null, ...extra });
const WSL_RECORD = JSON.stringify({ contract: 'clued.independent-ci.companion-wsl/1', target: 'D:\\clued-resident\\wsl\\Ubuntu-24.04\\ext4.vhdx' });

// A node: free GB per drive and memory, as the reader's ports see them.
function node(t, { free = { C: 80, D: 80 }, mem = 8, statusFile, clock = () => T0, record = WSL_RECORD } = {}) {
  const n = { free, mem, fail: false };
  n.read = createNodeResourceReader({ statusFile: statusFile ?? path.join('Z:\\', 'no-such', 'status.json'), installRecord: 'install-record', root: 'C:\\ProgramData\\CluedIndependentCI\\resident',
    readFile: async () => { if (record === null) throw new Error('ENOENT'); return record; },
    statfs: async p => { if (n.fail) throw new Error('EIO'); return { bavail: Math.round(n.free[p[0]] * 1024), bsize: GB / 1024 }; },
    freemem: () => n.mem * GB, clock });
  return n;
}
const hb = (board, now) => heartbeatPayload({ nodeName: 'home-primary', status: parseStatus(Buffer.from(canonicalJson(board.snapshot()))), serviceRunning: true, now });

test('the levels are the node governance standard (config/node-governance-standard.json disk) and the compact capacity profile (memory)', async () => {
  const std = JSON.parse(await fs.readFile(new URL('../../../config/node-governance-standard.json', import.meta.url), 'utf8'));
  assert.deepEqual(DISK_LEVELS, { redGb: std.disk.red_gb, recoverGb: std.disk.recover_gb });
  const profiles = JSON.parse(await fs.readFile(new URL('../../../scripts/ci/self-hosted/node-profiles.json', import.meta.url), 'utf8'));
  assert.deepEqual(MEMORY_LEVELS, { redGb: profiles.capacity_profiles['compact-v1'].suspend_free_memory_gb, recoverGb: profiles.capacity_profiles['compact-v1'].resume_free_memory_gb });
});

test('own reading: the WSL disk drive and the resident root drive, red below 10 GB, green again only at 15 (hysteresis); memory below 1.5, again at 2.5', async t => {
  assert.equal(wslDrive(WSL_RECORD), 'D');
  assert.equal(wslDrive('{"contract":"other/1","target":"D:\\\\x"}'), null);
  const n = node(t);
  const r0 = await n.read();
  assert.deepEqual([r0.ok, r0.red, r0.source, r0.drives.map(d => d.drive)], [true, false, 'self', ['D', 'C']]);
  n.free.D = 12; assert.equal((await n.read()).red, false, 'between the lines, never red before: green');
  n.free.D = 8; assert.deepEqual([(await n.read()).red, (await n.read()).reason], [true, NODE_RESOURCE_RED]);
  n.free.D = 12; assert.equal((await n.read()).red, true, 'between the lines after red: still red');
  n.free.D = 16; assert.equal((await n.read()).red, false);
  n.free.C = 9; assert.equal((await n.read()).red, true, 'the resident root drive counts too');
  n.free.C = 80;
  n.mem = 1.0; assert.deepEqual([(await n.read()).red, (await n.read()).reason], [true, NODE_MEMORY_LOW]);
  n.mem = 2.0; assert.equal((await n.read()).red, true);
  n.mem = 3.0; assert.equal((await n.read()).red, false);
  n.fail = true; assert.deepEqual(await n.read(), { ok: false }, 'a drive that cannot be read: no reading');
  const noRecord = node(t, { record: null, free: { C: 8 } });
  assert.deepEqual((await noRecord.read()).drives.map(d => d.drive), ['C'], 'no install record: C:');
});

test('a fresh governance status decides the disk; a stale one falls back to the own reading', async t => {
  const root = await tempRoot(t), file = path.join(root, 'status.json');
  await fs.writeFile(file, JSON.stringify(status('red')));
  let now = T0;
  const n = node(t, { statusFile: file, clock: () => now });
  assert.deepEqual([(await n.read()).red, (await n.read()).source], [true, 'governance'], 'its red, though the drives have room');
  now = T0 + 3_600_000;
  assert.deepEqual([(await n.read()).red, (await n.read()).source], [false, 'self']);
});

test('bundle retention: only batch directories older than 30 h beyond the newest three; the seed, other names and links stay', async t => {
  const dir = await tempRoot(t);
  const at = async (name, ageMs) => { const d = path.join(dir, name); await fs.mkdir(path.join(d, 'gen-2'), { recursive: true }); await fs.writeFile(path.join(d, 'gen-2', 'x.bundle'), 'b');
    const when = new Date(T0 - ageMs); for (const p of [path.join(d, 'gen-2', 'x.bundle'), path.join(d, 'gen-2'), d]) await fs.utimes(p, when, when); return name; };
  const id = i => `${String(i).padStart(16, '0')}-${'a'.repeat(12)}`;
  const old = [];
  for (let i = 0; i < 5; i += 1) old.push(await at(id(i), BUNDLE_KEEP_MS + 3_600_000 * (i + 1)));
  await at(id(9), 3_600_000);
  await at('_seed', 10 * BUNDLE_KEEP_MS);
  await at('not-a-batch', 10 * BUNDLE_KEEP_MS);
  const removed = await pruneBundles({ dir, now: T0 });
  // the newest three are kept whatever their age: id(9), id(0), id(1)
  assert.deepEqual(removed.sort(), old.slice(2).sort());
  assert.deepEqual((await fs.readdir(dir)).sort(), ['_seed', id(0), id(1), id(9), 'not-a-batch'].sort());
  assert.equal(BUNDLE_KEEP_NEWEST, 3);
  assert.ok(BUNDLE_KEEP_MS > 24 * 3_600_000, 'longer than park.maxMs (24 h at most)');
});

test('end to end: low disk -> the bundles of ended batches go first -> still low: no new batch, the hold is reported -> recovered: it runs', async t => {
  let f = null;
  const board = new StatusBoard({ clock: () => (f ? f.clock() : T0) });
  f = await executorFixture(t, { now: T0, status: board });
  const bundles = await tempRoot(t);
  for (let i = 0; i < 8; i += 1) {
    const d = path.join(bundles, `${String(i).padStart(16, '0')}-${'b'.repeat(12)}`);
    await fs.mkdir(d); const when = new Date(T0 - (i < 3 ? 3_600_000 : BUNDLE_KEEP_MS + 3_600_000)); await fs.utimes(d, when, when);
  }
  // the resident's drive: 2 GB less free per bundle directory, other files take `others` GB
  let others = 4;
  const n = node(t, { clock: f.clock });
  const freeNow = async () => 40 - others - 2 * (await fs.readdir(bundles)).length;
  f.exec.nodeStatus = async () => { n.free.D = await freeNow(); return n.read(); };
  // 1. 40 - 4 - 16 = 20 GB: green, the first batch runs
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  // 2. others grow to 18: 40 - 18 - 16 = 6 GB. The companion's pass removes the five ended batches' bundles first: 40 - 18 - 6 = 16 GB, green
  others = 18;
  assert.equal((await pruneBundles({ dir: bundles, now: f.clock() })).length, 5);
  await f.drop(triggerBytes({ pr: 885, headSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'cleaned enough: no hold');
  // 3. others grow to 27: 40 - 27 - 6 = 7 GB, nothing more to remove: the hold
  others = 27;
  assert.deepEqual(await pruneBundles({ dir: bundles, now: f.clock() }), []);
  await f.drop(triggerBytes({ pr: 886, headSha: '4'.repeat(40) }));
  const held = await f.exec.tick();
  assert.deepEqual([held.state, held.reason], ['DEFERRED', 'INTAKE_PAUSED']);
  const calls = f.engine.calls.length;
  assert.equal(f.queue.row(886).state, 'QUEUED', 'the trigger waits');
  assert.ok(!(await f.ledger.halted()));
  const holds = () => f.exec.intakePause.active(f.clock()).map(h => [h.holder, h.until]);
  assert.deepEqual(holds(), [[NODE_RESOURCE_HOLDER, new Date(f.clock() + NODE_RESOURCE_HOLD_MINUTES * 60_000).toISOString()]]);
  const paused = (await f.receipts.latest(['intake-paused'], 5)).map(e => e.value.body);
  assert.deepEqual(paused.map(b => [b.holder, b.reason]), [[NODE_RESOURCE_HOLDER, NODE_RESOURCE_RED]]);
  // reported: the status board, the PR page line, and the heartbeat (the server routes no ci-admission to an INTAKE_PAUSED node)
  assert.equal(board.content.intakePause.holders[0].holder, NODE_RESOURCE_HOLDER);
  assert.deepEqual(resourceHoldAlert(board.content), { text: '节点资源红线（暂停接新批）' });
  const beat = hb(board, f.clock());
  assert.deepEqual([beat.state, beat.intake_paused_until], ['INTAKE_PAUSED', board.content.intakePause.until]);
  // 4. 12 GB (others 22): between the lines, still held; renewed before it runs out
  others = 22;
  for (let i = 0; i < 3; i += 1) { f.advance(5 * 60_000); assert.equal((await f.exec.tick()).reason, 'INTAKE_PAUSED'); }
  f.advance(10 * 60_000); await f.exec.tick();
  assert.deepEqual((await f.receipts.latest(['intake-paused'], 5)).map(e => e.value.body.renewed), [false, true]);
  assert.equal(f.engine.calls.length, calls, 'no batch started while held');
  // 5. 16 GB (others 18): lifted, the waiting trigger runs, the heartbeat is NORMAL again
  others = 18;
  f.advance(60_000);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(holds(), []);
  assert.deepEqual((await f.receipts.latest(['intake-resumed'], 5)).map(e => [e.value.body.holder, e.value.body.reason]), [[NODE_RESOURCE_HOLDER, 'NODE_RESOURCE_RECOVERED']]);
  assert.equal(resourceHoldAlert(board.content), null);
  assert.equal(hb(board, f.clock()).state, 'NORMAL');
});

test('end to end, memory: low host memory holds new batches the same way (NODE_MEMORY_LOW), green again at 2.5 GB', async t => {
  let f = null;
  const board = new StatusBoard({ clock: () => (f ? f.clock() : T0) });
  f = await executorFixture(t, { now: T0, status: board });
  const n = node(t, { clock: f.clock, mem: 1.2 });
  f.exec.nodeStatus = n.read;
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).reason, 'INTAKE_PAUSED');
  assert.deepEqual((await f.receipts.latest(['intake-paused'], 5)).map(e => [e.value.body.holder, e.value.body.reason]), [[NODE_RESOURCE_HOLDER, NODE_MEMORY_LOW]]);
  assert.equal(hb(board, f.clock()).state, 'INTAKE_PAUSED');
  n.mem = 2.0; f.advance(60_000); assert.equal((await f.exec.tick()).reason, 'INTAKE_PAUSED');
  n.mem = 3.0; f.advance(60_000); assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('a guard that cannot read does nothing: the batch runs, one alert a day (NODE_STATUS_UNREADABLE), never a hold or HALT', async t => {
  for (const value of [{ ok: false }, new Error('EACCES')]) {
    const f = await executorFixture(t, { now: T0 });
    f.exec.nodeStatus = async () => { if (value instanceof Error) throw value; return value; };
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'COMPLETED');
    await f.drop(triggerBytes({ pr: 885 }));
    await f.exec.tick();
    const alerts = (await f.receipts.latest(['archive-retention-alert'], 16)).map(r => r.value.body);
    assert.equal(alerts.length, 1, 'once per day');
    assert.deepEqual([alerts[0].spool, alerts[0].code], ['disk', 'NODE_STATUS_UNREADABLE']);
    assert.deepEqual(f.exec.intakePause.active(f.clock()), []);
    assert.ok(!(await f.ledger.halted()));
  }
});

test('without the port (older wiring) nothing is held and nothing is written', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await f.receipts.latest(['archive-retention-alert'], 16)).length, 0);
});

test('the executor keeps no thresholds of its own (the reader has them)', async () => {
  const text = await fs.readFile(new URL('../src/executor.mjs', import.meta.url), 'utf8');
  for (const gone of ['HOST_DISK_DEFER_BYTES', 'HOST_DISK_RESUME_BYTES', 'hostDiskFree', 'DISK_RECEIPT', 'DISK_LEVELS', 'MEMORY_LEVELS']) assert.ok(!text.includes(gone), gone);
  const retention = await fs.readFile(new URL('../src/retention.mjs', import.meta.url), 'utf8');
  for (const gone of ['DISK_REMINDER_BYTES', 'HOST_DISK_', 'checkDisk', 'diskFree']) assert.ok(!retention.includes(gone), gone);
});

test('readNodeStatus: exact contract, bounded, a regular file; anything else is not ok; PR line names the red', async t => {
  const root = await tempRoot(t), file = path.join(root, 'status.json');
  assert.deepEqual(await readNodeStatus(file), { ok: false });
  await fs.writeFile(file, JSON.stringify(status('red')));
  const s = await readNodeStatus(file);
  assert.equal(s.ok, true); assert.equal(s.intake.level, 'red'); assert.equal(s.host, 'home-primary');
  assert.equal(capacityText(s), '节点资源红线（home-primary C: 剩 12.3 GB，暂停接新批）');
  assert.equal(capacityText({ ...s, ...status('green') }), null);
  assert.equal(capacityText({ ok: true, ...status('green', { linuxRunners: { suspended: true } }) }), '节点资源红线（home-primary Linux runner 已停）');
  for (const bad of [{ ...status('red'), contract: 'other/1' }, { ...status('red'), intake: { drive: 'C', level: 'purple' } }, '{', 'x'.repeat(70000)]) {
    await fs.writeFile(file, typeof bad === 'string' ? bad : JSON.stringify(bad));
    assert.deepEqual(await readNodeStatus(file), { ok: false }, String(bad).slice(0, 40));
  }
});
