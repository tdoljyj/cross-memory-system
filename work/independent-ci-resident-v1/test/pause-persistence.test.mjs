import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PAUSE_CONTRACT } from '../src/executor.mjs';
import { executorFixture, triggerBytes } from './helpers.mjs';

const pause = () => Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'Owner requested stop' }));
const ioFailure = () => Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
const pending = f => fs.readdir(path.join(f.root, 'requests'));

test('failed pause persistence aborts the tick before scheduling and preserves the request for recovery', async t => {
  const f = await executorFixture(t);
  await f.drop(pause(), 'requests');
  await f.drop(triggerBytes());
  const names = await pending(f);
  const original = f.ledger.pause.bind(f.ledger);
  f.ledger.pause = async () => { throw ioFailure(); };

  await assert.rejects(f.exec.tick(), { code: 'PAUSE_PERSISTENCE_UNCONFIRMED' });
  assert.equal(await f.ledger.paused(), null);
  assert.deepEqual(f.engine.calls, [], 'no stage may start after the requested stop failed');
  assert.deepEqual(await pending(f), names, 'do not consume a stop that never took effect');

  f.ledger.pause = original;
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.ok(await f.ledger.paused());
  assert.deepEqual(f.engine.calls, []);
  assert.deepEqual(await pending(f), []);
});

test('an audit failure after writing the pause remains stopped and leaves the pending request intact', async t => {
  const f = await executorFixture(t);
  await f.drop(pause(), 'requests');
  await f.drop(triggerBytes());
  const names = await pending(f);
  const append = f.receipts.append.bind(f.receipts);
  f.receipts.append = async (kind, ...args) => {
    if (kind === 'paused') throw ioFailure();
    return append(kind, ...args);
  };

  await assert.rejects(f.exec.tick(), { code: 'PAUSE_PERSISTENCE_UNCONFIRMED' });
  assert.ok(await f.ledger.paused(), 'the successful stop must not be rolled back');
  assert.deepEqual(f.engine.calls, []);
  assert.deepEqual(await pending(f), names);

  f.receipts.append = append;
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.deepEqual(f.engine.calls, []);
});

test('a malformed pause is still rejected without becoming a persistent stop', async t => {
  const f = await executorFixture(t);
  await f.drop(Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'x', extra: true })), 'requests');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(await f.ledger.paused(), null);
  assert.deepEqual(await pending(f), []);
});
