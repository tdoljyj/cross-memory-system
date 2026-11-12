// Tests of the one CI dependency entry (ci-deps.mjs). No test uses the network:
// the npm runs are fakes, or real npm on lockfiles that need nothing or only --offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DepsError, EXIT_PREPARE_FAILED, EXIT_STORE_MISSING, PREPARE_FLAGS, cacheRoot, install, main, prepare, storeKey,
  withKeyLock } from './ci-deps.mjs';

function tempDir(t, prefix = 'ci-deps-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const LEFT_PAD = { name: 'probe', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } };
const LEFT_PAD_LOCK = { name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
  '': LEFT_PAD,
  'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    integrity: 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEYcOP2/8xfaDqySm8GEpNgnp8MO8vC9Zq2wOV2XwTt6g2A==' } } };

function app(t, { pkg = { name: 'probe', version: '1.0.0' }, lock = null } = {}) {
  const dir = path.join(tempDir(t), 'app');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock ?? { ...pkg, lockfileVersion: 3, requires: true, packages: { '': pkg } }));
  return dir;
}

const quiet = () => {};
const keyOf = (dir) => storeKey({ lock: fs.readFileSync(path.join(dir, 'package-lock.json')) });

test('the store key is the lockfile, the platform and Node\'s major version', () => {
  const key = storeKey({ lock: 'a', platform: 'linux', arch: 'x64', nodeVersion: 'v24.19.0' });
  assert.match(key, /^[0-9a-f]{16}-linux-x64-node24$/);
  assert.equal(storeKey({ lock: 'a', platform: 'linux', arch: 'x64', nodeVersion: 'v24.21.3' }), key, 'a minor Node update keeps the store');
  for (const changed of [{ lock: 'b' }, { platform: 'win32' }, { arch: 'arm64' }, { nodeVersion: 'v22.1.0' }]) {
    assert.notEqual(storeKey({ lock: 'a', platform: 'linux', arch: 'x64', nodeVersion: 'v24.19.0', ...changed }), key, JSON.stringify(changed));
  }
});

test('the store is the runner account\'s ~/.npm unless CLUED_CI_NPM_CACHE names another', () => {
  assert.equal(cacheRoot({}, '/home/runner'), path.resolve('/home/runner/.npm'));
  assert.equal(cacheRoot({ CLUED_CI_NPM_CACHE: '/srv/npm' }, '/home/runner'), path.resolve('/srv/npm'));
});

test('prepare: few sockets and long retries in a scratch copy, rounds that resume within a time budget', (t) => {
  const dir = app(t);
  const cache = tempDir(t);
  const calls = [];
  const slept = [];
  let clock = 0;
  const run = (args, cwd, { timeoutMs }) => {
    calls.push({ args, cwd, timeoutMs });
    clock += 60_000;
    return calls.length < 3 ? { status: 1, output: 'npm error code ECONNRESET\nnpm error network aborted' } : { status: 0, output: '' };
  };
  assert.equal(prepare(dir, { cache, run, log: quiet, now: () => clock, sleep: (ms) => { slept.push(ms); clock += ms; } }), keyOf(dir));
  assert.equal(calls.length, 3, 'a failed round is followed by another that resumes from the cache');
  for (const { args, cwd, timeoutMs } of calls) {
    for (const flag of PREPARE_FLAGS) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes('--offline'));
    assert.equal(args[args.indexOf('--cache') + 1], cache);
    assert.ok(cwd !== dir && path.basename(cwd).startsWith('ci-deps-'), 'filled in a scratch copy, not the app');
    assert.ok(timeoutMs > 0 && timeoutMs <= 25 * 60_000);
  }
  assert.equal(fs.existsSync(calls[0].cwd), false, 'the scratch copy is removed');
  assert.deepEqual(slept, [15_000, 30_000]);
});

test('prepare: a store that never fills fails as the store (exit 75), not as a test, inside its time budget', (t) => {
  const dir = app(t);
  let clock = 0;
  let rounds = 0;
  // each round dies of a reset some minutes in; a round that hangs is stopped at the end of the budget
  const run = (args, cwd, { timeoutMs }) => { rounds += 1; clock += Math.min(timeoutMs, 4 * 60_000); return { status: 1, output: 'npm error code ECONNRESET' }; };
  assert.throws(() => prepare(dir, { cache: tempDir(t), run, log: quiet, now: () => clock, sleep: (ms) => { clock += ms; } }),
    (error) => error instanceof DepsError && error.exitCode === EXIT_PREPARE_FAILED && /依赖库准备失败.*不是测试失败/.test(error.message));
  assert.ok(rounds >= 2, `${rounds} rounds`);
  assert.ok(clock <= 25 * 60_000, `spent ${clock / 60000} minutes`);
});

test('prepare: a lockfile npm refuses is not retried as a network fault', (t) => {
  const dir = app(t);
  let calls = 0;
  const run = () => {
    calls += 1;
    return { status: 1, output: 'npm error code EUSAGE\nnpm ci can only install packages when your package.json and package-lock.json are in sync' };
  };
  assert.throws(() => prepare(dir, { cache: tempDir(t), run, log: quiet, sleep: quiet }), (error) => error.exitCode === 1 && /not the network/.test(error.message));
  assert.equal(calls, 1);
});

test('install is offline; only a missing or damaged package prepares the store, and one still missing is 依赖库缺失 (exit 78)', (t) => {
  const dir = app(t);
  const cache = tempDir(t);
  const seen = [];
  const prepared = [];
  const prepareStore = (where, options) => { prepared.push({ where, cache: options.cache }); };
  const offline = (results) => (args, cwd) => { seen.push({ args, cwd }); return results.shift(); };
  // the cache holds the lockfile: one offline install, nothing else
  assert.equal(install(dir, { cache, run: offline([{ status: 0, output: '' }]), log: quiet, prepareStore }), keyOf(dir));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, dir);
  assert.ok(seen[0].args.includes('--offline'));
  assert.equal(seen[0].args[seen[0].args.indexOf('--cache') + 1], cache);
  assert.ok(!seen[0].args.some((arg) => /^--(prefer-online|prefer-offline|fetch-)/.test(arg)), 'nothing that reaches the network');
  assert.deepEqual(prepared, []);
  // a package missing (or damaged): prepared, then installed offline again
  for (const code of ['ENOTCACHED', 'EINTEGRITY']) {
    seen.length = 0;
    prepared.length = 0;
    install(dir, { cache, run: offline([{ status: 1, output: `npm error code ${code}` }, { status: 0, output: '' }]), log: quiet, prepareStore });
    assert.deepEqual(prepared, [{ where: dir, cache }], code);
    assert.deepEqual(seen.map(({ args }) => args.includes('--offline')), [true, true], 'both installs offline');
  }
  assert.throws(() => install(dir, { cache, run: offline([{ status: 1, output: 'ENOTCACHED' }, { status: 1, output: 'ENOTCACHED' }]), log: quiet,
    prepareStore }), (error) => error.exitCode === EXIT_STORE_MISSING && /依赖库缺失/.test(error.message) && /没有联网安装/.test(error.message));
  prepared.length = 0;
  assert.throws(() => install(dir, { cache, run: offline([{ status: 1, output: 'npm error code ENOSPC' }]), log: quiet, prepareStore }),
    (error) => error.exitCode === 1 && /not a missing package/.test(error.message));
  assert.deepEqual(prepared, [], 'another failure is not a store to prepare');
});

test('runners preparing one lockfile take turns; a dead holder is replaced; a long wait goes ahead without the lock', (t) => {
  const cache = tempDir(t);
  const lock = path.join(cache, '_clued-ci-deps', 'locks', 'k');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: 424242 }));
  let alive = true;
  let waits = 0;
  assert.equal(withKeyLock(cache, 'k', () => 'ran', { log: quiet, alive: () => alive, sleep: () => { waits += 1; if (waits === 3) alive = false; } }), 'ran');
  assert.equal(waits, 3, 'waited while the holder lived');
  assert.equal(fs.existsSync(lock), false, 'released');
  const other = JSON.stringify({ host: os.hostname(), pid: process.pid });
  fs.writeFileSync(lock, other);
  let clock = 0;
  assert.equal(withKeyLock(cache, 'k', () => 'alongside', { log: quiet, sleep: () => { clock += 60_000; }, now: () => clock, waitMs: 120_000 }), 'alongside');
  assert.equal(fs.readFileSync(lock, 'utf8'), other, 'a lock it never held is left to its holder');
});

test('the command line takes install or prepare and one app directory', () => {
  assert.equal(main([]), 2);
  assert.equal(main(['fetch', 'x']), 2);
  assert.equal(main(['install', 'x', 'y']), 2);
});

test('real npm: an empty lockfile is prepared and installed offline; a package the store lacks is prepared for, never fetched by the install', (t) => {
  const cache = tempDir(t);
  const empty = app(t);
  assert.equal(prepare(empty, { cache, log: quiet }), keyOf(empty));
  assert.equal(install(empty, { cache, log: quiet }), keyOf(empty));
  // left-pad is in no cache here: the offline install refuses it and asks for a prepare instead of downloading it
  const needsOne = app(t, { pkg: LEFT_PAD, lock: LEFT_PAD_LOCK });
  const asked = [];
  assert.throws(() => install(needsOne, { cache, log: quiet, prepareStore: (where) => asked.push(where) }),
    (error) => error.exitCode === EXIT_STORE_MISSING && /依赖库缺失/.test(error.message));
  assert.deepEqual(asked, [needsOne]);
  assert.equal(fs.existsSync(path.join(needsOne, 'node_modules', 'left-pad')), false);
});
