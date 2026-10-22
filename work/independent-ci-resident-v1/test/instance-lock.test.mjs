// The executor instance lock after a reboot (Task d80fd886, F1): a holder from an earlier boot is stale even
// when its pid now names a live process and its liveness record still looks fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock, uptimeMs } from '../src/instance-lock.mjs';
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
  // The earlier boot: up five hours, liveness touched one minute before the reboot.
  const old = await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 0, uptime: () => 5 * HOUR });
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
  assert.deepEqual([evidence.contract, evidence.recordedUptimeMs, evidence.uptimeMs], ['clued.independent-ci.lock-earlier-boot/1', 5 * HOUR, 4 * 60_000]);
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
  for (const [name, holderUptime, liveness] of [
    ['foreign liveness token', 60_000, { token: 'other', at: 0, uptimeMs: 10 * HOUR }],
    ['negative uptime', -5, { token: 'aa', at: 0, uptimeMs: -5 }],
    ['text uptime', '36000000', { token: 'aa', at: 0, uptimeMs: '36000000' }],
    ['fractional uptime', 36000000.5, { token: 'aa', at: 0, uptimeMs: 36000000.5 }],
  ]) {
    const root = await tempRoot(t);
    const dir = path.join(root, 'executor.lock');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'holder.json'), JSON.stringify({ pid: 111, token: 'aa', at: '2026-10-22T00:00:00.000Z', uptimeMs: holderUptime }));
    await fs.writeFile(path.join(dir, 'alive.json'), JSON.stringify(liveness));
    await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 1000, uptime: () => 2 * 60_000 }), { code: /EXECUTOR_(ALREADY_RUNNING|LOCK_AMBIGUOUS_OWNER_LOOK)/ }, name);
  }
});

test('the default uptime is os.uptime() in milliseconds', () => {
  const before = Math.floor(os.uptime() * 1000);
  const value = uptimeMs();
  assert.ok(Number.isSafeInteger(value) && value >= before - 1 && value <= Math.floor(os.uptime() * 1000) + 1);
});
