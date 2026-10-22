// The SCM stop request after a reboot (Task d80fd886, F2): a request from an earlier boot is dropped with a
// receipt and the executor keeps running; every other request, whatever its content, is honoured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STOP_REQUEST_CONTRACT, STOP_REQUEST_MAX_BYTES, classifyStopRequest, stopRequestCheck } from '../src/stop-request.mjs';
import { serviceLoop } from '../src/service-main.mjs';
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

async function setup(t) {
  const state = await tempRoot(t);
  const locks = path.join(state, 'locks');
  await fs.mkdir(locks);
  const stopFile = path.join(state, 'STOP-REQUESTED');
  const receipts = [];
  const check = stopRequestCheck({ stopFile, locksDir: locks, uptime: () => NOW, clock: () => 1000, pid: 222,
    receipts: { append: async (type, body) => { receipts.push({ type, body, stopFileThere: await fs.access(stopFile).then(() => true, () => false) }); } } });
  return { state, locks, stopFile, receipts, check };
}

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

test('a rename that fails is not swallowed', async t => {
  const f = await setup(t);
  await fs.writeFile(f.stopFile, request(5 * HOUR));
  await fs.rm(f.locks, { recursive: true });
  await assert.rejects(f.check(), { code: 'ENOENT' });
  await fs.access(f.stopFile);
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
