#!/usr/bin/env node
// The one way CI installs an application's npm dependencies. Tests never touch
// the network: everything they install comes out of one npm cache per runner
// host (the runner account's ~/.npm, or CLUED_CI_NPM_CACHE), which every runner
// instance on the host shares. check-ci-deps-entry.mjs fails CI on any other
// npm ci / npm install in the CI scripts and workflows.
//
//   node scripts/ci/ci-deps.mjs prepare <app-dir>
//     The only step that uses the network. Makes the cache hold every package
//     <app-dir>/package-lock.json installs on this platform: npm ci into a
//     scratch copy with few sockets and strong retries, rounds that resume from
//     what the cache already holds, then npm ci --offline to prove it. Only then
//     is the lockfile marked ready. A lockfile already marked ready costs
//     nothing. Runners preparing the same lockfile take turns (one lock per
//     lockfile); a failure exits 75 and says it is the store, not a test.
//   node scripts/ci/ci-deps.mjs install <app-dir>
//     npm ci --offline from that cache, never the network. A package the cache
//     lacks fails with "依赖库缺失" (exit 78) and unmarks the lockfile, so the
//     next prepare fills it in.
//
// A changed lockfile is a new key: it is not ready until a prepare has run for
// it. Concurrent use is safe without the lock: npm's cache (cacache) writes
// content to a temporary file and renames it into place, installs only read it,
// and a ready mark is written aside and renamed into place, last.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_PREPARE_FAILED = 75; // EX_TEMPFAIL: the store could not be filled (network); no test ran
export const EXIT_STORE_MISSING = 78; // EX_CONFIG: the store lacks a package; run prepare
const STATE = '_clued-ci-deps';
const COMMON = ['--ignore-scripts', '--no-audit', '--no-fund'];
// Few sockets and long retries: a reset mid-download (ECONNRESET "network aborted") is not retried by npm's
// fetch, so the rounds above it resume from the cache instead (measured on DESK 2026-11-12; see the commit).
export const PREPARE_FLAGS = ['--prefer-offline', '--maxsockets=4', '--fetch-retries=6', '--fetch-retry-mintimeout=2000',
  '--fetch-retry-maxtimeout=60000', '--fetch-timeout=120000'];
const NPM_TIMEOUT_MS = 15 * 60_000;
const LOCK_WAIT_MS = 50 * 60_000;
const LOCK_STALE_MS = 60 * 60_000;

export class DepsError extends Error {
  constructor(message, exitCode) { super(message); this.exitCode = exitCode; }
}

export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

// The npm cache every CI install of this runner host uses.
export function cacheRoot(env = process.env, home = os.homedir()) {
  return path.resolve(env.CLUED_CI_NPM_CACHE || path.join(home, '.npm'));
}

// What decides which packages npm ci fetches: the lockfile, the platform (optional
// packages of other platforms are skipped) and Node's major version (its npm).
export function storeKey({ lock, platform = process.platform, arch = process.arch, nodeVersion = process.version }) {
  return `${sha256(lock).slice(0, 16)}-${platform}-${arch}-node${nodeVersion.replace(/^v/, '').split('.')[0]}`;
}

// On Windows `npm` is npm.cmd, which Node does not start without a shell; npm's own CLI next to node.exe starts directly.
export function npmCommand({ platform = process.platform, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return ['npm'];
  const cli = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(cli)) throw new Error(`npm's CLI is not next to ${execPath}`);
  return [execPath, cli];
}

// One npm run, its output passed through and kept for the error codes.
export function runNpm(args, cwd) {
  const [npm, ...prefix] = npmCommand();
  const done = spawnSync(npm, [...prefix, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: NPM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024 });
  const output = `${done.stdout ?? ''}${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}`;
  process.stderr.write(output);
  return { status: done.status ?? 1, output };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readApp(app) {
  const lockFile = path.join(app, 'package-lock.json');
  if (!fs.existsSync(path.join(app, 'package.json')) || !fs.existsSync(lockFile)) {
    throw new DepsError(`${app} has no package.json or package-lock.json`, 1);
  }
  return { lock: fs.readFileSync(lockFile) };
}

const readyFile = (cache, key) => path.join(cache, STATE, 'ready', `${key}.json`);
export const isReady = (cache, key) => fs.existsSync(readyFile(cache, key));

function markReady(cache, key, facts) {
  const file = readyFile(cache, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const aside = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(aside, `${JSON.stringify({ key, ...facts, prepared_at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(aside, file);
}

// One holder per lockfile key, so runners on one host fetch it once. Correctness
// never rests on it (see the top): a lock judged stale wrongly costs a second fetch.
export function withKeyLock(cache, key, fn, { log = console.error, sleep = sleepMs, alive = processAlive, now = Date.now,
  waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const dir = path.join(cache, STATE, 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, key);
  const deadline = now() + waitMs;
  let told = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let owner = null;
    let age = 0;
    try {
      age = now() - fs.statSync(lock).mtimeMs;
      owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    } catch { /* being created or removed */ }
    const stale = owner ? (owner.host === os.hostname() && !alive(owner.pid)) || age > staleMs : age > 60_000;
    if (stale) {
      const aside = `${lock}.stale-${process.pid}`;
      try { fs.renameSync(lock, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch { /* another waiter took it */ }
      continue;
    }
    if (now() > deadline) throw new DepsError(`依赖库准备失败：等待 ${key} 的另一次准备超过 ${Math.round(waitMs / 60000)} 分钟（不是测试失败）`, EXIT_PREPARE_FAILED);
    if (!told) log(`ci-deps: another runner is preparing ${key}; waiting for it`);
    told = true;
    sleep(2000);
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: process.pid }));
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// The only networked step. Returns { key, prepared } (prepared false: it was ready already).
export function prepare(app, { cache = cacheRoot(), run = runNpm, log = console.error, rounds = 4, sleep = sleepMs,
  scratchRoot = os.tmpdir(), lockOptions = {} } = {}) {
  const { lock } = readApp(app);
  const key = storeKey({ lock });
  if (isReady(cache, key)) {
    log(`ci-deps: dependency store ${key} is ready in ${cache}`);
    return { key, prepared: false };
  }
  return withKeyLock(cache, key, () => {
    if (isReady(cache, key)) return { key, prepared: false };
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'ci-deps-'));
    try {
      for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
        if (fs.existsSync(path.join(app, file))) fs.copyFileSync(path.join(app, file), path.join(scratch, file));
      }
      for (let round = 1; round <= rounds; round += 1) {
        log(`ci-deps: filling ${cache} for ${key} (round ${round} of ${rounds}; the only step that uses the network)`);
        const fill = run(['ci', ...COMMON, '--cache', cache, ...PREPARE_FLAGS], scratch);
        if (/\bEUSAGE\b/.test(fill.output)) {
          throw new DepsError(`npm ci refuses ${app}'s package.json and package-lock.json (not the network; npm's output is above)`, 1);
        }
        if (fill.status === 0) {
          const proof = run(['ci', ...COMMON, '--cache', cache, '--offline'], scratch);
          if (proof.status === 0) {
            markReady(cache, key, { lockfile_sha256: sha256(lock), npm_cache: cache, node: process.version });
            log(`ci-deps: dependency store ${key} is ready (proved by an offline install)`);
            return { key, prepared: true };
          }
        }
        if (round < rounds) sleep(15_000 * round);
      }
      throw new DepsError(`依赖库准备失败：${rounds} 轮联网填充后 ${key} 仍不完整（网络问题，不是测试失败；npm 的输出在上面）`, EXIT_PREPARE_FAILED);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, { log, sleep, ...lockOptions });
}

// Offline only. Installs app/node_modules from the cache; a missing package is "依赖库缺失", never a download.
export function install(app, { cache = cacheRoot(), run = runNpm, log = console.error } = {}) {
  const { lock } = readApp(app);
  const key = storeKey({ lock });
  const done = run(['ci', ...COMMON, '--cache', cache, '--offline'], app);
  if (done.status === 0) {
    log(`ci-deps: installed ${app} offline from dependency store ${key}`);
    return { key };
  }
  if (/\bENOTCACHED\b/.test(done.output)) {
    fs.rmSync(readyFile(cache, key), { force: true });
    throw new DepsError(`依赖库缺失：${cache} 里没有 ${key} 需要的包，没有联网。` +
      `先运行 node scripts/ci/ci-deps.mjs prepare ${app}`, EXIT_STORE_MISSING);
  }
  throw new DepsError(`npm ci --offline failed in ${app} (not a missing package; npm's output is above)`, 1);
}

export function main(argv = process.argv.slice(2)) {
  const [step, app] = argv;
  if (!['prepare', 'install'].includes(step) || !app || argv.length !== 2) {
    console.error('usage: node scripts/ci/ci-deps.mjs <prepare|install> <app-dir>');
    return 2;
  }
  try {
    (step === 'prepare' ? prepare : install)(path.resolve(app));
    return 0;
  } catch (error) {
    console.error(`ci-deps ${step}: ${error.message}`);
    return error instanceof DepsError ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
