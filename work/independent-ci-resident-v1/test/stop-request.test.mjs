// The SCM stop request after a reboot (Task d80fd886, F2): a request from an earlier boot is dropped with a
// receipt and the executor keeps running; every other request, whatever its content, is honoured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STOP_REQUEST_CONTRACT, STOP_REQUEST_MAX_BYTES, classifyStopRequest, stopRequestCheck } from '../src/stop-request.mjs';
import { serviceLoop } from '../src/service-main.mjs';
import { uptimeMs } from '../src/instance-lock.mjs';
import { tempRoot } from './helpers.mjs';

const HOUR = 3_600_000;
const NOW = 4 * 60_000; // four minutes after this boot
const request = uptimeMs => Buffer.from(JSON.stringify({ contract: STOP_REQUEST_CONTRACT, uptimeMs }) + '\n'); // the host's bytes

test('only a well-formed request from an earlier boot is from an earlier boot', () => {
  for (const [name, bytes, reason] of [
    ['empty (created, not yet written)', Buffer.alloc(0), 'empty'],
    ['oversize', Buffer.alloc(STOP_REQUEST_MAX_BYTES + 1, 0x20), 'oversize'],
    ['zeroed by a power loss', Buffer.alloc(8), 'unparsable'],
    ['torn', request(5 * HOUR).subarray(0, 40), 'unparsable'],
    ['the old host (no content contract)', Buffer.from('stop\n'), 'unparsable'],
    ['null', Buffer.from('null'), 'contract'],
    ['another contract', Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.stop-request/2', uptimeMs: 5 * HOUR })), 'contract'],
    ['no uptime', Buffer.from(JSON.stringify({ contract: STOP_REQUEST_CONTRACT })), 'uptime'],
    ['negative uptime', request(-1), 'uptime'],
    ['text uptime', Buffer.from(JSON.stringify({ contract: STOP_REQUEST_CONTRACT, uptimeMs: '18000000' })), 'uptime'],
    ['fractional uptime', request(5 * HOUR + 0.5), 'uptime'],
    ['unsafe integer uptime', request(2 ** 53 + 2), 'uptime'],
    ['this boot, earlier', request(NOW - 30_000), 'this-boot'],
    ['this boot, now', request(NOW), 'this-boot'],
    ['inside the margin', request(NOW + 60_000), 'this-boot'],
  ]) assert.deepEqual(classifyStopRequest(bytes, NOW), { earlierBoot: false, reason }, name);
  assert.deepEqual(classifyStopRequest(request(NOW + 60_001), NOW), { earlierBoot: true, recordedUptimeMs: NOW + 60_001 });
  assert.deepEqual(classifyStopRequest(request(5 * HOUR), NOW), { earlierBoot: true, recordedUptimeMs: 5 * HOUR });
  const padded = Buffer.concat([request(5 * HOUR), Buffer.alloc(STOP_REQUEST_MAX_BYTES - request(5 * HOUR).length, 0x20)]);
  assert.deepEqual(classifyStopRequest(padded, NOW), { earlierBoot: true, recordedUptimeMs: 5 * HOUR }, 'at the limit');
});

async function setup(t, options = {}) {
  const state = await tempRoot(t);
  const locks = path.join(state, 'locks');
  await fs.mkdir(locks);
  const stopFile = path.join(state, 'STOP-REQUESTED');
  const receipts = [];
  const check = stopRequestCheck({ stopFile, locksDir: locks, uptime: () => NOW, clock: () => 1000, pid: 222,
    receipts: { append: async (type, body) => { receipts.push({ type, body, stopFileThere: await fs.access(stopFile).then(() => true, () => false) }); } }, ...options });
  return { state, locks, stopFile, receipts, check };
}

test('the default clock is this boot\'s uptime, read at each look', async t => {
  // No uptime injected: the check must use os.uptime(), not the process's age.
  let f = await setup(t, { uptime: undefined });
  await fs.writeFile(f.stopFile, request(uptimeMs()));
  assert.equal(await f.check(), true, 'a request of this boot, written now, is honoured');
  f = await setup(t, { uptime: undefined });
  await fs.writeFile(f.stopFile, request(uptimeMs() + 2 * HOUR));
  assert.equal(await f.check(), false, 'a request two hours ahead is from an earlier boot');
  // The clock is read at each look, not once: hours later, a request written a second ago is honoured. The first
  // look also has a request, so a clock read only on first use is caught too.
  let now = NOW;
  f = await setup(t, { uptime: () => now });
  await fs.writeFile(f.stopFile, request(now));
  assert.equal(await f.check(), true);
  await fs.rm(f.stopFile);
  now = NOW + 2 * HOUR;
  await fs.writeFile(f.stopFile, request(now - 1000));
  assert.equal(await f.check(), true);
});

test('the default clock moves with os.uptime(), not with a value taken once', async t => {
  // A default read once is behind here: taken at module load it drops both requests, taken on first use the second.
  const base = os.uptime() * 1000;
  let now = base + HOUR;
  t.mock.method(os, 'uptime', () => now / 1000);
  const f = await setup(t, { uptime: undefined });
  await fs.writeFile(f.stopFile, request(Math.round(now)));
  assert.equal(await f.check(), true);
  await fs.rm(f.stopFile);
  now = base + 10 * HOUR;
  await fs.writeFile(f.stopFile, request(Math.round(now) - 1000));
  assert.equal(await f.check(), true);
});

test('a request from an earlier boot is renamed after a receipt, and the executor keeps running', async t => {
  const f = await setup(t);
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  assert.equal(await f.check(), false);
  await assert.rejects(fs.access(f.stopFile));
  assert.deepEqual(await fs.readdir(f.locks), ['prior-boot-stop-1000-222']);
  assert.deepEqual(await fs.readFile(path.join(f.locks, 'prior-boot-stop-1000-222')), request(5 * HOUR), 'kept as it was');
  assert.deepEqual(f.receipts, [{ type: 'service-stop-prior-boot', stopFileThere: true,
    body: { pid: 222, recordedUptimeMs: 5 * HOUR, uptimeMs: NOW, marginMs: 60_000, kept: 'prior-boot-stop-1000-222' } }]);
  // The host of this boot can ask again, and that request stops us.
  assert.equal(await f.check(), false, 'nothing there now');
  await fs.writeFile(f.stopFile, request(NOW));
  assert.equal(await f.check(), true);
  assert.equal(f.receipts.length, 1);
});

test('every other request is honoured and left for the stop acknowledgement', async t => {
  for (const [name, make] of [
    ['this boot', file => fs.writeFile(file, request(NOW - 1000))],
    ['empty', file => fs.writeFile(file, '')],
    ['oversize', file => fs.writeFile(file, Buffer.alloc(STOP_REQUEST_MAX_BYTES + 10, 0x20))],
    // Its first 4096 bytes alone would be a request from an earlier boot: the byte past the limit must be read.
    ['oversize by one byte', file => fs.writeFile(file, Buffer.concat([request(5 * HOUR), Buffer.alloc(STOP_REQUEST_MAX_BYTES - request(5 * HOUR).length + 1, 0x20)]))],
    ['torn', file => fs.writeFile(file, request(5 * HOUR).subarray(0, 40))],
    ['unreadable (a directory)', file => fs.mkdir(file)],
  ]) {
    const f = await setup(t);
    await make(f.stopFile);
    assert.equal(await f.check(), true, name);
    await fs.access(f.stopFile);
    assert.deepEqual(await fs.readdir(f.locks), [], name);
    assert.deepEqual(f.receipts, [], name);
  }
});

test('no request: no stop and nothing written', async t => {
  const f = await setup(t);
  assert.equal(await f.check(), false);
  assert.deepEqual(await fs.readdir(f.locks), []);
  assert.deepEqual(f.receipts, []);
});

test('any read error other than "not there" is honoured as a stop', async t => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EISDIR']) {
    const f = await setup(t, { read: async () => { throw Object.assign(new Error(code), { code }); } });
    assert.equal(await f.check(), true, code);
    assert.deepEqual(f.receipts, [], code);
  }
  // The real read: only "not there" means no request.
  const f = await setup(t);
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  const open = t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
  const seen = await f.check();
  open.mock.restore();
  assert.equal(seen, true);
});

test('a failure receipt that fails does not hide the rename error', async t => {
  const f = await setup(t, { receipts: { append: async type => { if (type.endsWith('-failed')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  await fs.rm(f.locks, { recursive: true });
  await assert.rejects(f.check(), { code: 'STOP_REQUEST_RENAME_FAILED' });
});

test('a rename that fails is thrown, after a receipt that the request is still in place', async t => {
  const f = await setup(t);
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  await fs.rm(f.locks, { recursive: true });
  await assert.rejects(f.check(), { code: 'STOP_REQUEST_RENAME_FAILED' });
  await fs.access(f.stopFile);
  assert.deepEqual(f.receipts.map(r => [r.type, r.body.failureCode, r.body.errno]),
    [['service-stop-prior-boot', undefined, undefined], ['service-stop-prior-boot-failed', 'STOP_REQUEST_RENAME_FAILED', 'ENOENT']]);
});

test('a receipt that fails is thrown and nothing is renamed', async t => {
  const f = await setup(t, { receipts: { append: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  await assert.rejects(f.check(), { code: 'ENOSPC' });
  await fs.access(f.stopFile);
  assert.deepEqual(await fs.readdir(f.locks), []);
});

test('the service loop runs on past a request from an earlier boot and stops on the next one', async t => {
  const f = await setup(t);
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  let ticks = 0, acks = 0;
  const exec = { tick: async () => { ticks += 1; if (ticks === 2) await fs.writeFile(f.stopFile, request(NOW)); return { state: 'IDLE' }; } };
  const code = await serviceLoop({ exec, lock: { touch: async () => {} }, sleep: async () => {}, stopRequested: f.check,
    acknowledgeStop: async () => { acks += 1; }, onLoopException: async () => {}, betweenBatches: async () => {} });
  assert.deepEqual([code, ticks, acks, f.receipts.length], [0, 2, 1, 1]);
});
