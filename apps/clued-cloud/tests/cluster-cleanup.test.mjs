import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLEANUP_DEFAULTS, HOST_HARNESS_ROOT, removeTestDirectory, stopCluster, waitForPidExit } from './cluster-cleanup.mjs';

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
const DIRECTORY = path.join(os.tmpdir(), 'clued-cluster-cleanup-test', 'clued-cluster-1');
const runningServer = (extra = {}) => ({
  options: { databaseDir: DIRECTORY, persistent: false },
  process: { pid: 4242, exitCode: null, signalCode: null },
  stop: async () => {},
  ...extra,
});

test('removal retries after EBUSY and then succeeds without logging', async () => {
  let failures = 2;
  const { state, deps } = harness({
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

test('only directories strictly inside the temp directory are removed', async () => {
  const { state, deps } = harness({ rm: async (target) => { state.rmCalls.push(target); } });
  const root = path.parse(os.tmpdir()).root;
  const outside = [undefined, '', 'relative/dir', root, os.tmpdir(), path.join(os.tmpdir(), '..', 'elsewhere'),
    path.join(root, 'clued-not-in-temp', 'x'), os.homedir()];
  for (const bad of outside) assert.equal(await removeTestDirectory(bad, deps), false, String(bad));
  assert.deepEqual(state.rmCalls, []);
  assert.equal(state.logs.length, outside.length);
  assert.equal(await removeTestDirectory(path.join(os.tmpdir(), 'clued-ok'), deps), true);
  assert.equal(await removeTestDirectory(path.join(os.tmpdir(), '.', 'nested', 'clued-ok'), deps), true);
});

test('a cluster under the checkout work/host-harness/ is removed too, the root itself and its parent never', async () => {
  const { state, deps } = harness({ rm: async (target) => { state.rmCalls.push(target); } });
  const inside = path.join(HOST_HARNESS_ROOT, 'ngc', 'clued-ngc-1');
  assert.equal(await removeTestDirectory(inside, { ...deps, tmpdir: inside }), true, 'TEMP pointed at the cluster itself');
  assert.deepEqual(state.rmCalls, [inside]);
  for (const bad of [HOST_HARNESS_ROOT, path.dirname(HOST_HARNESS_ROOT), path.join(HOST_HARNESS_ROOT, '..', 'other')]) {
    assert.equal(await removeTestDirectory(bad, deps), false, bad);
  }
  assert.deepEqual(state.rmCalls, [inside]);
});

test('really removes a populated directory, and an absent one is fine', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-cleanup-real-'));
  await fs.mkdir(path.join(directory, 'base', '1'), { recursive: true });
  await fs.writeFile(path.join(directory, 'base', '1', 'file'), 'x');
  await fs.writeFile(path.join(directory, 'postmaster.pid'), `${process.pid}\n`); // stale file naming a live pid
  const started = Date.now();
  assert.equal(await removeTestDirectory(directory), true);
  assert.ok(Date.now() - started < 5000, 'a stale postmaster.pid is not waited on');
  await assert.rejects(fs.lstat(directory), { code: 'ENOENT' });
  assert.equal(await removeTestDirectory(directory), true, 'an already removed directory is fine');
});

test('waitForPidExit polls the exact pid and gives up without killing anything', async () => {
  let polls = 0;
  const { state, deps } = harness({ alive: (pid) => { assert.equal(pid, 4242); polls += 1; return polls < 3; } });
  assert.equal(await waitForPidExit(4242, deps), true);
  assert.equal(state.sleeps, 2);
  assert.equal(await waitForPidExit(undefined, deps), true);
  assert.equal(await waitForPidExit(4242, { ...deps, exitTimeoutMs: 20, alive: () => true, sleep: () => new Promise((resolve) => setTimeout(resolve, 15)) }), false);
});

test('stopCluster finishes a non-persistent cluster whose own removal hit EBUSY', async () => {
  const removed = [];
  const { state, deps } = harness({ alive: () => false, rm: async (target) => { removed.push(target); } });
  await stopCluster(runningServer({ stop: async () => { throw lockError(); } }), deps);
  assert.deepEqual(removed, [DIRECTORY]);
  assert.deepEqual(state.logs, [], 'a lock error from the library removal is expected, not reported');
});

test('stopCluster leaves a persistent cluster directory to the test', async () => {
  const { state, deps } = harness({ alive: () => false, rm: async (target) => { state.rmCalls.push(target); } });
  let stopped = 0;
  await stopCluster(runningServer({ options: { databaseDir: DIRECTORY, persistent: true }, stop: async () => { stopped += 1; } }), deps);
  assert.equal(stopped, 1);
  assert.deepEqual(state.rmCalls, []);
});

test('stopCluster reports other stop errors, never throws, and tolerates a missing server', async () => {
  const { state, deps } = harness({ alive: () => false, rm: async () => {} });
  await stopCluster(undefined, deps);
  await stopCluster(runningServer({ stop: async () => { throw new Error('Could not find process PID'); } }), deps);
  assert.deepEqual(state.logs, ['stop() failed: Could not find process PID']);
});

test('stopCluster does not call stop() on a child that already exited, and still removes the cluster', async () => {
  const { state, deps } = harness({ alive: () => false, rm: async (target) => { state.rmCalls.push(target); } });
  for (const process of [{ pid: 7, exitCode: 0, signalCode: null }, { pid: 7, exitCode: null, signalCode: 'SIGKILL' }]) {
    await stopCluster(runningServer({ process, stop: async () => { throw new Error('stop() would wait forever'); } }), deps);
  }
  assert.deepEqual(state.rmCalls, [DIRECTORY, DIRECTORY]);
  assert.deepEqual(state.logs, []);
});

test('stopCluster waits for the pid of its own child and only reports one that stays alive', async () => {
  const { state, deps } = harness({
    exitTimeoutMs: 20,
    alive: (pid) => { assert.equal(pid, 4242, 'never another pid'); return true; },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 15)),
    rm: async () => {},
  });
  await stopCluster(runningServer(), deps);
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /postmaster 4242 is still running 20 ms after stop\(\)/);
});
