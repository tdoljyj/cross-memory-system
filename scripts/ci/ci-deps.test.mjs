// Tests of the one CI dependency entry (ci-deps.mjs). No test uses the network:
// the npm runs are fakes, or real npm on lockfiles that need nothing or only --offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DepsError, EXIT_PREPARE_FAILED, EXIT_STORE_MISSING, PREPARE_FLAGS, cacheRoot, install, isReady, main, prepare, storeKey,
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

test('prepare: few sockets and strong retries, rounds that resume, an offline proof, then the ready mark', (t) => {
  const dir = app(t);
  const cache = tempDir(t);
  const calls = [];
  const slept = [];
  let fills = 0;
  const run = (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes('--offline')) return { status: 0, output: '' };
    fills += 1;
    return fills < 3 ? { status: 1, output: 'npm error code ECONNRESET' } : { status: 0, output: '' };
  };
  assert.deepEqual(prepare(dir, { cache, run, log: quiet, sleep: (ms) => slept.push(ms) }), { key: keyOf(dir), prepared: true });
  assert.deepEqual(calls.map(({ args }) => args.includes('--offline') ? 'offline' : 'fill'), ['fill', 'fill', 'fill', 'offline']);
  for (const { args } of calls.filter(({ args }) => !args.includes('--offline'))) {
    for (const flag of PREPARE_FLAGS) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--cache') + 1], cache);
  }
  assert.ok(calls.every(({ cwd }) => cwd !== dir && path.basename(cwd).startsWith('ci-deps-')), 'filled in a scratch copy, not the app');
  assert.equal(fs.existsSync(calls[0].cwd), false, 'the scratch copy is removed');
  assert.deepEqual(slept, [15_000, 30_000]);
  assert.ok(isReady(cache, keyOf(dir)));
  const mark = JSON.parse(fs.readFileSync(path.join(cache, '_clued-ci-deps', 'ready', `${keyOf(dir)}.json`), 'utf8'));
  assert.equal(mark.key, keyOf(dir));
  calls.length = 0;
  assert.deepEqual(prepare(dir, { cache, run, log: quiet }), { key: keyOf(dir), prepared: false });
  assert.deepEqual(calls, [], 'a ready lockfile costs nothing, no network');
});

test('prepare: a store that never fills fails as the store (exit 75), not as a test, and is not marked', (t) => {
  const dir = app(t);
  const cache = tempDir(t);
  let calls = 0;
  const run = (args) => { calls += 1; return args.includes('--offline') ? { status: 1, output: 'ENOTCACHED' } : { status: 0, output: '' }; };
  assert.throws(() => prepare(dir, { cache, run, log: quiet, sleep: quiet, rounds: 3 }),
    (error) => error instanceof DepsError && error.exitCode === EXIT_PREPARE_FAILED && /依赖库准备失败.*不是测试失败/.test(error.message));
  assert.equal(calls, 6, 'every round fills and tries the offline proof');
  assert.equal(isReady(cache, keyOf(dir)), false, 'nothing unproved is marked ready');
});

test('prepare: a lockfile npm refuses is not retried as a network fault', (t) => {
  const dir = app(t);
  let calls = 0;
  const run = () => { calls += 1; return { status: 1, output: 'npm error code EUSAGE\nnpm ci can only install packages when your package.json and package-lock.json are in sync' }; };
  assert.throws(() => prepare(dir, { cache: tempDir(t), run, log: quiet, sleep: quiet }), (error) => error.exitCode === 1 && /not the network/.test(error.message));
  assert.equal(calls, 1);
});

test('install is offline only; a package the store lacks is 依赖库缺失 (exit 78) and unmarks the lockfile', (t) => {
  const dir = app(t);
  const cache = tempDir(t);
  prepare(dir, { cache, run: () => ({ status: 0, output: '' }), log: quiet });
  const seen = [];
  install(dir, { cache, run: (args, cwd) => { seen.push({ args, cwd }); return { status: 0, output: '' }; }, log: quiet });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, dir);
  assert.ok(seen[0].args.includes('--offline'));
  assert.ok(!seen[0].args.some((arg) => /^--(prefer-online|prefer-offline|fetch-)/.test(arg)), 'nothing that reaches the network');
  assert.throws(() => install(dir, { cache, run: () => ({ status: 1, output: 'npm error code ENOTCACHED' }), log: quiet }),
    (error) => error.exitCode === EXIT_STORE_MISSING && /依赖库缺失/.test(error.message) && /没有联网/.test(error.message));
  assert.equal(isReady(cache, keyOf(dir)), false, 'the next prepare fills it in');
  prepare(dir, { cache, run: () => ({ status: 0, output: '' }), log: quiet });
  assert.throws(() => install(dir, { cache, run: () => ({ status: 1, output: 'npm error code ENOSPC' }), log: quiet }),
    (error) => error.exitCode === 1 && /not a missing package/.test(error.message));
  assert.ok(isReady(cache, keyOf(dir)), 'another failure leaves the store alone');
});

test('runners preparing one lockfile take turns; a dead holder\'s lock is taken over; waiting has a limit', (t) => {
  const cache = tempDir(t);
  const lock = path.join(cache, '_clued-ci-deps', 'locks', 'k');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: 424242 }));
  let alive = true;
  let waits = 0;
  const result = withKeyLock(cache, 'k', () => 'ran', { log: quiet, alive: () => alive, sleep: () => { waits += 1; if (waits === 3) alive = false; } });
  assert.equal(result, 'ran');
  assert.equal(waits, 3, 'waited while the holder lived');
  assert.equal(fs.existsSync(lock), false, 'released');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: process.pid }));
  let clock = 0;
  assert.throws(() => withKeyLock(cache, 'k', () => 'never', { log: quiet, sleep: () => { clock += 60_000; }, now: () => clock, waitMs: 120_000 }),
    (error) => error.exitCode === EXIT_PREPARE_FAILED && /不是测试失败/.test(error.message));
});

test('the command line takes prepare or install and one app directory', () => {
  assert.equal(main([]), 2);
  assert.equal(main(['fetch', 'x']), 2);
  assert.equal(main(['install', 'x', 'y']), 2);
});

test('real npm: a lockfile is prepared, proved and installed offline; an empty store says 依赖库缺失 without the network', (t) => {
  const cache = tempDir(t);
  const empty = app(t);
  assert.equal(prepare(empty, { cache, log: quiet }).prepared, true);
  assert.ok(isReady(cache, keyOf(empty)));
  install(empty, { cache, log: quiet });
  // left-pad is in no cache here; --offline must refuse it rather than download it
  const needsOne = app(t, { pkg: LEFT_PAD, lock: LEFT_PAD_LOCK });
  assert.throws(() => install(needsOne, { cache, log: quiet }), (error) => error.exitCode === EXIT_STORE_MISSING && /依赖库缺失/.test(error.message));
  assert.equal(fs.existsSync(path.join(needsOne, 'node_modules', 'left-pad')), false);
});
