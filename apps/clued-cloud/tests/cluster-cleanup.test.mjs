import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLEANUP_DEFAULTS, removeTestDirectory, stopCluster, waitForClusterExit } from './cluster-cleanup.mjs';

// No real waiting: every injected sleep only counts.
const harness = (overrides = {}) => {
  const state = { logs: [], sleeps: 0, rmCalls: [] };
  return {
    state,
    deps: {
      log: (message) => state.logs.push(message),
      sleep: async () => { state.sleeps += 1; },
      ...overrides,
    },
  };
};
const lockError = (code = 'EBUSY') => Object.assign(new Error(`${code}: resource busy or locked, rmdir 'x'`), { code });
const DIRECTORY = path.join(path.parse(os.tmpdir()).root, 'clued-test-root', 'clued-cluster-1');

test('removal retries after EBUSY and then succeeds without logging', async () => {
  let failures = 2;
  const { state, deps } = harness({
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    rm: async (target, opts) => {
      state.rmCalls.push([target, opts]);
      if (failures-- > 0) throw lockError();
    },
  });
  assert.equal(await removeTestDirectory(DIRECTORY, deps), true);
  assert.equal(state.rmCalls.length, 3);
  assert.equal(state.sleeps, 2, 'waits between attempts, not after the successful one');
  assert.deepEqual(state.rmCalls[0][1], { recursive: true, force: true, maxRetries: CLEANUP_DEFAULTS.maxRetries, retryDelay: CLEANUP_DEFAULTS.retryDelay });
  assert.deepEqual(state.logs, []);
});

test('a lock that never clears is logged once, not thrown, and removable entries are still deleted', async () => {
  const removedChildren = [];
  const { state, deps } = harness({
    attempts: 3,
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readdir: async () => ['base', 'pg_wal', 'locked.dat'],
    rm: async (target) => {
      if (target === DIRECTORY) throw lockError();
      if (path.basename(target) === 'locked.dat') throw lockError('EPERM');
      removedChildren.push(path.basename(target));
    },
  });
  assert.equal(await removeTestDirectory(DIRECTORY, deps), false);
  assert.deepEqual(removedChildren, ['base', 'pg_wal'], 'only the locked entry is left behind');
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /could not remove .*clued-cluster-1 after 3 attempts \(EBUSY\); 1 entry left/);
});

test('removal waits for the recorded postmaster to exit before deleting', async () => {
  let polls = 0;
  const events = [];
  const { state, deps } = harness({
    readFile: async () => '4242\n/data\n',
    alive: (pid) => { assert.equal(pid, 4242); polls += 1; events.push('poll'); return polls < 3; },
    rm: async () => { events.push('rm'); },
  });
  assert.equal(await removeTestDirectory(DIRECTORY, deps), true);
  assert.deepEqual(events, ['poll', 'poll', 'poll', 'rm']);
  assert.equal(state.sleeps, 2);
});

test('a postmaster that never exits is reported and removal is still attempted', async () => {
  const { state, deps } = harness({
    exitTimeoutMs: 20,
    readFile: async () => '4242\n',
    alive: () => true,
    sleep: async () => { state.sleeps += 1; await new Promise((resolve) => setTimeout(resolve, 15)); },
    rm: async () => {},
  });
  assert.equal(await waitForClusterExit(DIRECTORY, deps), false);
  assert.equal(await removeTestDirectory(DIRECTORY, deps), true);
  assert.ok(state.logs.some((line) => /postmaster of .* is still running/.test(line)));
});

test('paths that are not absolute test directories are refused and nothing is removed', async () => {
  const { state, deps } = harness({ rm: async (target) => { state.rmCalls.push(target); } });
  for (const bad of [undefined, '', 'relative/dir', path.parse(os.tmpdir()).root, path.join(path.parse(os.tmpdir()).root, 'top')]) {
    assert.equal(await removeTestDirectory(bad, deps), false, String(bad));
  }
  assert.deepEqual(state.rmCalls, []);
  assert.equal(state.logs.length, 5);
});

test('really removes a populated directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-cleanup-real-'));
  await fs.mkdir(path.join(directory, 'base', '1'), { recursive: true });
  await fs.writeFile(path.join(directory, 'base', '1', 'file'), 'x');
  assert.equal(await removeTestDirectory(directory), true);
  await assert.rejects(fs.lstat(directory), { code: 'ENOENT' });
  assert.equal(await removeTestDirectory(directory), true, 'an already removed directory is fine');
});

test('stopCluster finishes a non-persistent cluster whose own removal hit EBUSY', async () => {
  const removed = [];
  const { state, deps } = harness({
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    rm: async (target) => { removed.push(target); },
  });
  const server = { options: { databaseDir: DIRECTORY, persistent: false }, stop: async () => { throw lockError(); } };
  await stopCluster(server, deps);
  assert.deepEqual(removed, [DIRECTORY]);
  assert.deepEqual(state.logs, [], 'a lock error from the library removal is expected, not reported');
});

test('stopCluster leaves a persistent cluster directory to the test', async () => {
  const { state, deps } = harness({
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    rm: async (target) => { state.rmCalls.push(target); },
  });
  let stopped = 0;
  await stopCluster({ options: { databaseDir: DIRECTORY, persistent: true }, stop: async () => { stopped += 1; } }, deps);
  assert.equal(stopped, 1);
  assert.deepEqual(state.rmCalls, []);
});

test('stopCluster reports other stop errors, never throws, and tolerates a missing server', async () => {
  const { state, deps } = harness({
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    rm: async () => {},
  });
  await stopCluster(undefined, deps);
  await stopCluster({ options: { databaseDir: DIRECTORY, persistent: false }, stop: async () => { throw new Error('Could not find process PID'); } }, deps);
  assert.deepEqual(state.logs, ['stop() failed: Could not find process PID']);
});

test('stopCluster kills a postmaster that outlives stop() and then removes the directory', async () => {
  const events = [];
  let alive = true;
  const { state, deps } = harness({
    exitTimeoutMs: 20,
    readFile: async () => '777\n',
    alive: () => alive,
    kill: (pid) => { events.push(`kill ${pid}`); alive = false; },
    sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); },
    rm: async () => { events.push('rm'); },
  });
  await stopCluster({ options: { databaseDir: DIRECTORY, persistent: false }, stop: async () => {} }, deps);
  assert.deepEqual(events, ['kill 777', 'rm']);
  assert.ok(state.logs.some((line) => /postmaster 777 .* did not exit; killing it/.test(line)));
});
