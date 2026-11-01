// One companion per node (Task 42fe5ae4, op 8e3b3e1b: a rollback that could not see its companion started one more every
// minute, and every one served the same mailboxes). companion-main.mjs takes the executor's lock (instance-lock.mjs) in the
// Owner's profile before it sets anything up, and refreshes it while its lanes run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { COMPANION_LOCK_TOUCH_MS } from '../src/companion-main.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'companion-main.mjs');

test('a second companion refuses while the first lives; a dead one is set aside', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-companion-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await acquireInstanceLock(dir, { pid: 101, alive: async pid => pid === 101 });
  await assert.rejects(acquireInstanceLock(dir, { pid: 102, alive: async pid => pid === 101 }), { code: 'EXECUTOR_ALREADY_RUNNING' });
  await first.touch();
  // The restart stopped the old one (its pid is gone): the new one takes the lock, the old lock is kept aside.
  await acquireInstanceLock(dir, { pid: 103, alive: async pid => pid === 103 });
  assert.equal((await fs.readdir(path.join(dir, 'locks'))).filter(n => n.startsWith('stale-')).length, 1);
});

test('companion-main takes the lock in the Owner profile before any lane, and refreshes it well inside ten minutes', async () => {
  const text = await fs.readFile(SRC, 'utf8');
  const lockAt = text.indexOf('acquireInstanceLock(path.join(cfg.node.ownerProfileDirectory'), probeAt = text.indexOf('await probeJobHost(runner)');
  assert.ok(lockAt > 0 && lockAt < probeAt, 'the lock comes before the job host probe and every lane');
  assert.match(text, /'CluedIndependentCI', 'companion-lock'\)/);
  assert.ok(text.includes('instanceLock.touch()') && COMPANION_LOCK_TOUCH_MS <= 60_000);
});
