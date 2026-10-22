// The executor instance lock after a reboot (Task d80fd886, F1): a holder from an earlier boot is stale even
// when its pid now names a live process and its liveness record still looks fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock, secondsToMs, uptimeMs } from '../src/instance-lock.mjs';
import { tempRoot } from './helpers.mjs';

const HOUR = 3_600_000;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const kept = async root => (await fs.readdir(path.join(root, 'locks'))).filter(name => name.startsWith('stale-'));

test('holder and liveness record the uptime of their boot', async t => {
  const root = await tempRoot(t);
  const lock = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 1000, uptime: () => 5 * HOUR });
  assert.equal((await read(path.join(lock.dir, 'holder.json'))).uptimeMs, 5 * HOUR);
  assert.equal((await read(path.join(lock.dir, 'alive.json'))).uptimeMs, 5 * HOUR);
});

test('a holder from an earlier boot is stale although its pid is alive and its liveness is fresh', async t => {
  const root = await tempRoot(t);
  // The earlier boot: the executor started two minutes after boot (delayed auto start), so its holder record is
  // small; its liveness was last touched five hours in, one minute before the reboot. Only the liveness tells.
  let earlier = 2 * 60_000;
  const old = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => earlier });
  earlier = 5 * HOUR;
  await old.touch();
  // After the reboot: four minutes up, the old pid now names another process, the wall clock barely moved.
  const asked = [];
  const lock = await acquireInstanceLock(root, { pid: 222, alive: async pid => { asked.push(pid); return true; }, clock: () => 5 * 60_000, uptime: () => 4 * 60_000 });
  assert.deepEqual(asked, [], 'the old pid is not even asked about');
  assert.equal((await read(path.join(lock.dir, 'holder.json'))).pid, 222);
  const stale = await kept(root);
  assert.equal(stale.length, 1);
  assert.equal((await read(path.join(root, 'locks', stale[0], 'holder.json'))).pid, 111);
  const evidence = await read(path.join(root, 'locks', stale[0], 'earlier-boot.json'));
  assert.deepEqual([evidence.contract, evidence.recordedUptimeMs, evidence.recordedFrom, evidence.uptimeMs, evidence.marginMs], ['clued.independent-ci.lock-earlier-boot/1', 5 * HOUR, 'liveness', 4 * 60_000, 60_000]);
});

test('the holder record alone also tells an earlier boot (no liveness record)', async t => {
  const root = await tempRoot(t);
  const old = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
  await fs.rm(path.join(old.dir, 'alive.json'));
  await acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 4 * 60_000 });
  const stale = await kept(root);
  assert.equal(stale.length, 1);
  assert.equal((await read(path.join(root, 'locks', stale[0], 'earlier-boot.json'))).recordedFrom, 'holder');
});

test('a liveness record that cannot be read for another reason is not ignored', async t => {
  const root = await tempRoot(t);
  const old = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
  await fs.rm(path.join(old.dir, 'alive.json'));
  await fs.mkdir(path.join(old.dir, 'alive.json'));
  await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => false, clock: () => 1000, uptime: () => 4 * 60_000 }), { code: 'EISDIR' });
});

test('a torn liveness record (power loss) counts as none before the rules run', async t => {
  for (const torn of ['', '\0\0\0\0\0\0\0\0', '{"token":"']) {
    // Earlier boot: the holder record still tells, and the lock is stale.
    let root = await tempRoot(t);
    let old = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
    await fs.writeFile(path.join(old.dir, 'alive.json'), torn);
    await acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 4 * 60_000 });
    assert.equal((await kept(root)).length, 1, JSON.stringify(torn));
    // This boot with a live pid: no liveness is not fresh, so the Owner looks (as for a stale liveness record).
    root = await tempRoot(t);
    old = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
    await fs.writeFile(path.join(old.dir, 'alive.json'), torn);
    await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 5 * HOUR + 1000 }), { code: 'EXECUTOR_LOCK_AMBIGUOUS_OWNER_LOOK' }, JSON.stringify(torn));
  }
});

test('just past the margin is an earlier boot: a short earlier boot is still recognised', async t => {
  const root = await tempRoot(t);
  // The earlier boot lasted six minutes; the new start is five minutes in, so the record is 61 s ahead.
  await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * 60_000 + 61_000 });
  await acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 5 * 60_000 });
  assert.equal((await kept(root)).length, 1);
});

test('a live holder of this boot is still refused, also inside the margin', async t => {
  for (const later of [5 * HOUR, 5 * HOUR + 1, 5 * HOUR - 59_000]) {
    const root = await tempRoot(t);
    await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
    await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 60_000, uptime: () => later }), { code: 'EXECUTOR_ALREADY_RUNNING' }, String(later));
    assert.deepEqual(await kept(root), []);
  }
});

test('a hung holder of this boot stays ambiguous for the Owner', async t => {
  const root = await tempRoot(t);
  await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
  await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => HOUR, uptime: () => 6 * HOUR }), { code: 'EXECUTOR_LOCK_AMBIGUOUS_OWNER_LOOK' });
});

test('a holder without an uptime (written before this change) keeps the old rules', async t => {
  const root = await tempRoot(t);
  const dir = path.join(root, 'executor.lock');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'holder.json'), JSON.stringify({ pid: 111, token: 'aa', at: '2026-10-22T00:00:00.000Z' }));
  await fs.writeFile(path.join(dir, 'alive.json'), JSON.stringify({ token: 'aa', at: 0 }));
  await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 60_000 }), { code: 'EXECUTOR_ALREADY_RUNNING' });
  await acquireInstanceLock(root, { pid: 333, alive: async () => false, clock: () => 1000, uptime: () => 60_000 });
  const stale = await kept(root);
  assert.equal(stale.length, 1);
  await assert.rejects(fs.access(path.join(root, 'locks', stale[0], 'earlier-boot.json')), 'a dead pid is stale as before, with no earlier-boot record');
});

test('only the holder\'s own liveness record counts, and bad uptimes count as none', async t => {
  // A foreign liveness record is not this holder's, so it is not fresh either: the Owner looks. The others are the
  // holder's own fresh record, so a live pid of this boot is a running executor.
  for (const [name, holderUptime, liveness, code] of [
    ['foreign liveness token', 60_000, { token: 'other', at: 0, uptimeMs: 10 * HOUR }, 'EXECUTOR_LOCK_AMBIGUOUS_OWNER_LOOK'],
    ['negative uptime', -5, { token: 'aa', at: 0, uptimeMs: -5 }, 'EXECUTOR_ALREADY_RUNNING'],
    ['text uptime', '36000000', { token: 'aa', at: 0, uptimeMs: '36000000' }, 'EXECUTOR_ALREADY_RUNNING'],
    ['fractional uptime', 36000000.5, { token: 'aa', at: 0, uptimeMs: 36000000.5 }, 'EXECUTOR_ALREADY_RUNNING'],
    ['unsafe integer uptime', 1e300, { token: 'aa', at: 0, uptimeMs: 2 ** 53 + 2 }, 'EXECUTOR_ALREADY_RUNNING'],
  ]) {
    const root = await tempRoot(t);
    const dir = path.join(root, 'executor.lock');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'holder.json'), JSON.stringify({ pid: 111, token: 'aa', at: '2026-10-22T00:00:00.000Z', uptimeMs: holderUptime }));
    await fs.writeFile(path.join(dir, 'alive.json'), JSON.stringify(liveness));
    await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 2 * 60_000 }), { code }, name);
  }
});

test('the default uptime is os.uptime() in milliseconds', () => {
  const before = Math.round(os.uptime() * 1000);
  const value = uptimeMs();
  assert.ok(Number.isSafeInteger(value) && value >= before && value <= Math.round(os.uptime() * 1000));
});

test('seconds become the exact milliseconds they came from (GetTickCount64 / 1000)', () => {
  // These lose a millisecond when floored; the sweep reaches about 460 days of uptime.
  for (const ms of [2058941, 32840094, 32943041, 33045988]) assert.equal(secondsToMs(ms / 1000), ms);
  for (let ms = 0; ms < 4e10; ms += 999_983) assert.equal(secondsToMs(ms / 1000), ms, String(ms));
});

test('the default uptime goes through that conversion', t => {
  t.mock.method(os, 'uptime', () => 32840094 / 1000);
  assert.equal(uptimeMs(), 32840094);
});
