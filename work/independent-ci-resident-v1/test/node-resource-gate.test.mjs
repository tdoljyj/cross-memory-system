// Node Resource Governance v1: the executor's only disk rule is the node's status file (C:\ProgramData\Clued\node-governance\status.json,
// written by the node's Clued-Node-Governance task). Red on the drive of the resident WSL disk (status.intake) holds new batches
// (DEFERRED NODE_RESOURCE_RED, never HALT; a batch in flight goes on). The executor has no thresholds of its own. An unreadable,
// foreign or stale status holds nothing and raises one alert per day in the retention notice channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NODE_STATUS_CONTRACT, capacityText, readNodeStatus } from '../src/host-capacity.mjs';
import { executorFixture, tempRoot, triggerBytes } from './helpers.mjs';

const T0 = Date.parse('2026-11-12T05:00:00Z');
const pick = r => [r.state, r.reason ?? null];
const bodies = async (f, type) => (await f.receipts.latest([type], 16)).map(r => r.value.body);
const status = (level, extra = {}) => ({ contract: NODE_STATUS_CONTRACT, host: 'home-primary', writtenAt: new Date(T0).toISOString(), level,
  intake: { drive: 'C', level }, drives: [{ drive: 'C', freeGb: level === 'red' ? 12.3 : 80, totalGb: 237, level }], linuxRunners: null, ...extra });

async function fixture(t, reads) {
  const f = await executorFixture(t, { now: T0 });
  f.exec.nodeStatus = async () => { const v = typeof reads.value === 'function' ? reads.value() : reads.value; if (v instanceof Error) throw v; return v; };
  return f;
}

test('red on the resident disk: no new batch (DEFERRED NODE_RESOURCE_RED, no stage, no HALT), the trigger stays queued', async t => {
  const f = await fixture(t, { value: { ok: true, ...status('red') } });
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_RESOURCE_RED']);
  assert.equal(f.engine.calls.length, 0);
  assert.equal(f.queue.row(884).state, 'QUEUED');
  assert.ok(!(await f.ledger.halted()));
});

test('green or yellow runs; red that recovered runs again (the hysteresis is the governance task\'s, not the executor\'s)', async t => {
  const reads = { value: { ok: true, ...status('red') } };
  const f = await fixture(t, reads);
  await f.drop(triggerBytes());
  assert.deepEqual(pick(await f.exec.tick()), ['DEFERRED', 'NODE_RESOURCE_RED']);
  reads.value = { ok: true, ...status('yellow') };
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('red elsewhere (another drive) does not hold the resident: only status.intake counts', async t => {
  const s = status('green', { level: 'red', drives: [{ drive: 'C', freeGb: 80, totalGb: 237, level: 'green' }, { drive: 'D', freeGb: 5, totalGb: 30, level: 'red' }] });
  const f = await fixture(t, { value: { ok: true, ...s } });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('unreadable or stale status: the batch runs, one alert a day (NODE_STATUS_UNREADABLE), never HALT', async t => {
  for (const value of [{ ok: false }, new Error('EACCES'), { ok: true, ...status('red', { writtenAt: new Date(T0 - 3_600_000).toISOString() }) }]) {
    const f = await fixture(t, { value });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'COMPLETED');
    await f.drop(triggerBytes({ pr: 885 }));
    await f.exec.tick();
    const alerts = await bodies(f, 'archive-retention-alert');
    assert.equal(alerts.length, 1, 'once per day');
    assert.deepEqual([alerts[0].spool, alerts[0].code], ['disk', 'NODE_STATUS_UNREADABLE']);
    assert.ok(!(await f.ledger.halted()));
  }
});

test('without the port (older wiring) nothing is held and nothing is written', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await bodies(f, 'archive-retention-alert')).length, 0);
});

test('the executor keeps no thresholds of its own', async () => {
  const text = await fs.readFile(new URL('../src/executor.mjs', import.meta.url), 'utf8');
  for (const gone of ['HOST_DISK_DEFER_BYTES', 'HOST_DISK_RESUME_BYTES', 'hostDiskFree', 'DISK_RECEIPT']) assert.ok(!text.includes(gone), gone);
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
