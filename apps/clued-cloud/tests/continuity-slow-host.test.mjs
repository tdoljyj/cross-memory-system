import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// continuity-serial-rpc.test.mjs told serial from concurrent database calls by a 5 ms window; on a loaded host the two
// reads of one wave reached the database further apart than that and the test failed. It runs here with an uneven thread
// pool (slow-digest-preload.cjs) and still passes. The nested run has no cap of its own: the entry bounds the whole command.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const preload = fileURLToPath(new URL('./slow-digest-preload.cjs', import.meta.url));

test('continuity: serial and concurrent database calls are told apart when the thread pool is slow', () => {
  const file = 'apps/clued-cloud/tests/continuity-serial-rpc.test.mjs';
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, SLOW_DIGEST_MS: '40' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', 'resume reads claims and inbox concurrently', file],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${file} with a slow thread pool:\n${r.stdout.slice(-4000)}${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, /ℹ pass [1-9]/, `${file}: the pattern ran no test:\n${r.stdout.slice(-1000)}`);
});
