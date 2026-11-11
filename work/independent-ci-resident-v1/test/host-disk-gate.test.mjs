// C: disk gate: no new batch while the drive of the resident WSL disk is below 10 GiB (resumes at 15 GiB); a batch in flight is not touched;
// never HALT; the Owner is told through the retention notice channel (disk-space-reminder with blocksAnything, or an alert when unreadable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_DISK_DEFER_BYTES, HOST_DISK_RESUME_BYTES } from '../src/retention.mjs';
import { executorFixture, triggerBytes } from './helpers.mjs';

const GIB = 1024 ** 3;
const T0 = Date.parse('2026-10-23T05:00:00Z');
const pick = r => [r.state, r.reason ?? null];
const bodies = async (f, type) => (await f.receipts.latest([type], 16)).map(r => r.value.body);

async function fixture(t, reads) {
  const calls = { n: 0 };
  const hostDiskFree = async () => {
    const v = typeof reads.value === 'function' ? reads.value() : reads.value;
    calls.n += 1;
    if (v instanceof Error) throw v;
    return v;
  };
  const f = await executorFixture(t, { now: T0 });
  f.exec.hostDiskFree = hostDiskFree;
  return { f, calls };
}
const free = gib => ({ ok: true, freeBytes: Math.round(gib * GIB), drive: 'C:' });

test('constants: defer below 10 GiB, resume at 15 GiB', () => {
  assert.equal(HOST_DISK_DEFER_BYTES, 10 * GIB);
  assert.equal(HOST_DISK_RESUME_BYTES, 15 * GIB);
});

test('5 GiB free: no new batch (DEFERRED HOST_DISK_LOW, no stage, no HALT), the trigger stays queued, a blocking receipt is written once per day', async t => {
  const reads = { value: free(5) };
  const { f } = await fixture(t, reads);
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'HOST_DISK_LOW']);
  assert.equal(f.engine.calls.length, 0);
  assert.equal(f.queue.row(884).state, 'QUEUED');
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'HOST_DISK_LOW']);
  const rows = await bodies(f, 'disk-space-reminder');
  assert.equal(rows.length, 1, 'one receipt per day, not per tick');
  assert.deepEqual(rows[0], { drive: 'C:', freeBytes: 5 * GIB, thresholdBytes: 10 * GIB, action: 'owner-free-disk-space', blocksAnything: true });
  assert.ok(!(await f.ledger.halted()));
  f.advance(86_400_000);
  await f.exec.tick();
  assert.equal((await bodies(f, 'disk-space-reminder')).length, 2, 'and again the next day');
});

test('hysteresis: once low, 12 GiB still holds and 20 GiB lets the queue run; a fresh start at 12 GiB runs', async t => {
  const reads = { value: free(5) };
  const { f } = await fixture(t, reads);
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'HOST_DISK_LOW']);
  reads.value = free(12);
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'HOST_DISK_LOW'], 'between 10 and 15 GiB it keeps holding');
  assert.equal(f.engine.calls.length, 0);
  reads.value = free(20);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  reads.value = free(12);
  await f.drop(triggerBytes({ pr: 885 }));
  assert.notEqual((await f.exec.tick()).reason, 'HOST_DISK_LOW', 'after the release 12 GiB is above the 10 GiB bound');
});

test('12 GiB from the start: not low, the batch runs', async t => {
  const { f } = await fixture(t, { value: free(12) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await bodies(f, 'disk-space-reminder')).length, 0);
});

test('unreadable disk (not ok, or a throw): the batch runs, but an alert goes to the same notice channel; never HALT', async t => {
  for (const value of [{ ok: false }, new Error('statfs failed')]) {
    const { f } = await fixture(t, { value });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'COMPLETED');
    assert.ok(!(await f.ledger.halted()));
    const alerts = await bodies(f, 'archive-retention-alert');
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].spool, alerts[0].code], ['disk', 'HOST_DISK_UNREADABLE']);
  }
});

test('without the port nothing changes (older wiring): the batch runs and no receipt is written', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await bodies(f, 'disk-space-reminder')).length, 0);
});
