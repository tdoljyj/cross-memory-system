#!/usr/bin/env node
// The one way CI installs an application's npm dependencies. Tests never touch
// the network: what they install comes out of one npm cache per runner host
// (the runner account's ~/.npm, or CLUED_CI_NPM_CACHE), shared by every runner
// instance of the account. check-ci-deps-entry.mjs fails CI on any other
// npm ci / npm install in the CI scripts and workflows.
//
//   node scripts/ci/ci-deps.mjs install <app-dir>
//     npm ci --offline from the cache. Only when the cache lacks a package of
//     <app-dir>/package-lock.json does it prepare (below) and install offline
//     again; a package still missing then is "依赖库缺失" (exit 78). The
//     network is never used to install.
//   node scripts/ci/ci-deps.mjs prepare <app-dir>
//     The only step that uses the network: fills the cache for the lockfile in
//     a scratch copy, with few sockets and long retries, in rounds that resume
//     from what the cache already holds (npm does not retry a download reset
//     midway). With the cache complete it makes no request. A failure exits 75
//     and says it is the dependency store, not a test. Run it on its own to
//     fill a new runner or a new lockfile ahead of the jobs.
//
// No mark claims the cache is complete: the offline install is the proof, so
// a cache emptied by the node sweep (linux-sweep.sh package_caches) or a
// changed lockfile is simply prepared again. Concurrent use is safe: npm's
// cache (cacache) writes content aside and renames it into place, and installs
// only read it. Runners preparing the same lockfile take turns (one lock per
// lockfile) only so that it is fetched once.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXIT_PREPARE_FAILED = 75; // EX_TEMPFAIL: the store could not be filled (network); no test ran
export const EXIT_STORE_MISSING = 78; // EX_CONFIG: the store lacks a package after preparing
const STATE = '_clued-ci-deps';
const COMMON = ['--ignore-scripts', '--no-audit', '--no-fund'];
export const PREPARE_FLAGS = ['--prefer-offline', '--maxsockets=4', '--fetch-retries=6', '--fetch-retry-mintimeout=2000',
  '--fetch-retry-maxtimeout=60000', '--fetch-timeout=120000'];
// What a prepare may spend, inside ci-suites' 45-minute job. A round runs until it fails or the budget ends
// (one large tarball can take minutes); what it fetched stays in the cache for the next round.
const PREPARE_BUDGET_MS = 18 * 60_000;
const OFFLINE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
// A lock this old outlived any prepare (its holder's pid may be another process's by now).
const LOCK_STALE_MS = 30 * 60_000;
// The cache lacks a package (or holds a damaged copy): prepare, never download during install.
const MISSING = /\berror code (ENOTCACHED|EINTEGRITY)\b/;
// The lockfile itself is wrong (out of step with package.json, a bad integrity, a version that does not
// exist): no retry fixes it, and it is the change's fault, not the network's.
const LOCKFILE_FAULT = /\berror code (EUSAGE|EINTEGRITY|E404|ETARGET|ENOVERSIONS)\b/;

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

// One npm run. Its output streams to stderr as it comes (stdout may carry a caller's report); on a failure the
// error codes are read from npm's debug log.
export function runNpm(args, cwd, { timeoutMs = OFFLINE_MS } = {}) {
  const [npm, ...prefix] = npmCommand();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-deps-log-'));
  try {
    const done = spawnSync(npm, [...prefix, ...args, '--logs-dir', logs, '--logs-max', '10'], { cwd, stdio: ['ignore', 2, 2], windowsHide: true,
      timeout: timeoutMs, killSignal: 'SIGTERM' });
    const status = done.status ?? 1;
    let output = done.error ? done.error.message : '';
    if (status !== 0) for (const file of fs.readdirSync(logs)) output += `\n${fs.readFileSync(path.join(logs, file), 'utf8')}`;
    return { status, output };
  } finally {
    fs.rmSync(logs, { recursive: true, force: true });
  }
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
  return storeKey({ lock: fs.readFileSync(lockFile) });
}

// One holder per lockfile key on this host. Only an optimisation: a holder that
// is gone is replaced, a wait past its limit goes ahead without the lock.
export function withKeyLock(cache, key, fn, { log = console.error, sleep = sleepMs, alive = processAlive, now = Date.now,
  waitMs = LOCK_WAIT_MS } = {}) {
  const lock = path.join(cache, STATE, 'locks', key);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const me = JSON.stringify({ host: os.hostname(), pid: process.pid });
  const deadline = now() + waitMs;
  let held = false;
  while (!held) {
    try {
      fs.writeFileSync(lock, me, { flag: 'wx' });
      held = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let text = null;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; text = fs.readFileSync(lock, 'utf8'); } catch { /* being removed */ }
      let owner = null;
      try { owner = JSON.parse(text); } catch { /* being written, or its writer died first */ }
      // gone: its process ended, it outlived any prepare, or it stayed empty past a minute
      const stale = owner ? (owner.host === os.hostname() && !alive(owner.pid)) || age > LOCK_STALE_MS : text !== null && age > 60_000;
      if (stale) {
        log(`ci-deps: the lock of ${key} is stale (${owner ? `pid ${owner.pid}` : 'empty'}); taking over`);
        try { if (fs.readFileSync(lock, 'utf8') === text) fs.rmSync(lock, { force: true }); } catch { /* taken meanwhile */ }
        continue;
      }
      if (now() > deadline) {
        log(`ci-deps: ${key} has been prepared elsewhere for over ${Math.round(waitMs / 60000)} minutes; going ahead alongside it`);
        break;
      }
      log(`ci-deps: another runner is preparing ${key}; waiting for it`);
      sleep(5000);
    }
  }
  try {
    return fn();
  } finally {
    try { if (held && fs.readFileSync(lock, 'utf8') === me) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

// The only networked step. Returns the key once the cache holds the lockfile's packages.
export function prepare(app, { cache = cacheRoot(), run = runNpm, log = console.error, sleep = sleepMs, now = Date.now,
  budgetMs = PREPARE_BUDGET_MS, scratchRoot = os.tmpdir(), lockOptions = {} } = {}) {
  const key = readApp(app);
  return withKeyLock(cache, key, () => {
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'ci-deps-'));
    try {
      for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
        if (fs.existsSync(path.join(app, file))) fs.copyFileSync(path.join(app, file), path.join(scratch, file));
      }
      const deadline = now() + budgetMs;
      for (let round = 1; ; round += 1) {
        log(`ci-deps: preparing ${key} in ${cache} (round ${round}; the only step that uses the network)`);
        const fill = run(['ci', ...COMMON, '--cache', cache, ...PREPARE_FLAGS], scratch, { timeoutMs: deadline - now() });
        if (fill.status === 0) {
          log(`ci-deps: ${key} is in the dependency store`);
          return key;
        }
        const fault = LOCKFILE_FAULT.exec(fill.output);
        if (fault) {
          throw new DepsError(`npm ci refuses ${app}'s package-lock.json (${fault[1]}): the lockfile is wrong, not the network; ` +
            "npm's output is above", 1);
        }
        const pause = 15_000 * round;
        if (now() + pause + 60_000 > deadline) break;
        sleep(pause);
      }
      throw new DepsError(`依赖库准备失败：${Math.round(budgetMs / 60000)} 分钟的联网填充后 ${key} 仍不完整（网络问题，不是测试失败；npm 的输出在上面）`,
        EXIT_PREPARE_FAILED);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, { log, sleep, now, ...lockOptions });
}

// Offline install; a missing package is prepared for (the only networked step), never downloaded by the install.
export function install(app, { cache = cacheRoot(), run = runNpm, log = console.error, prepareStore = prepare } = {}) {
  const key = readApp(app);
  const offline = () => run(['ci', ...COMMON, '--cache', cache, '--offline'], app, { timeoutMs: OFFLINE_MS });
  let done = offline();
  if (done.status !== 0 && MISSING.test(done.output)) {
    log(`ci-deps: the dependency store lacks packages of ${key}; preparing it`);
    prepareStore(app, { cache, run, log });
    done = offline();
    if (done.status !== 0 && MISSING.test(done.output)) {
      throw new DepsError(`依赖库缺失：准备后 ${cache} 仍缺 ${key} 的包（npm 的输出在上面）；没有联网安装`, EXIT_STORE_MISSING);
    }
  }
  if (done.status !== 0) throw new DepsError(`npm ci --offline failed in ${app} (not a missing package; npm's output is above)`, 1);
  log(`ci-deps: installed ${app} offline from the dependency store (${key})`);
  return key;
}

export function main(argv = process.argv.slice(2)) {
  const [step, app] = argv;
  if (!['prepare', 'install'].includes(step) || !app || argv.length !== 2) {
    console.error('usage: node scripts/ci/ci-deps.mjs <install|prepare> <app-dir>');
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

if (import.meta.main) process.exitCode = main();
