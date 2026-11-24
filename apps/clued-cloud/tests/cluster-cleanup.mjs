// Shared start and cleanup for tests that run an embedded PostgreSQL cluster.
//
// On Windows the cluster's files stay locked for a short while after the
// postgres process exits, so an immediate recursive remove fails with EBUSY
// (or EPERM / ENOTEMPTY) and node:test then fails the whole file although every
// subtest passed. The library itself removes a non-persistent cluster at
// the end of stop() with one unretried fs.rm, so stopping goes through here too.
//
// Cleanup is best effort and never throws: when a directory still cannot be
// removed it logs one line, deletes whatever can be deleted so no large
// directory is left behind, and returns false. It never kills a process: the
// postmaster is stopped by the library, and its exit is confirmed by the exact
// pid of the child this process started (postmaster.pid is not trusted; on
// Windows the library's taskkill leaves a stale one behind).
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These clusters are discarded after the test and never used for crash recovery.
export const EPHEMERAL_POSTGRES_FLAGS = Object.freeze([
  '-c', 'io_method=sync',
  '-c', 'fsync=off',
  '-c', 'synchronous_commit=off',
  '-c', 'full_page_writes=off',
]);
export const EPHEMERAL_INITDB_FLAGS = Object.freeze(['--no-sync']);

export const CLEANUP_DEFAULTS = Object.freeze({
  attempts: 8, // outer attempts, each with fs.rm's own retries
  attemptDelayMs: 500,
  maxRetries: 5, // fs.rm retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM itself
  retryDelay: 100,
  exitTimeoutMs: 15000,
  pollMs: 100,
});

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

const defaultLog = (message) => { process.stderr.write(`cluster-cleanup: ${message}\n`); };

function options(overrides = {}) {
  return {
    ...CLEANUP_DEFAULTS,
    rm: fs.rm,
    readdir: fs.readdir,
    realpath: fs.realpath,
    sleep: sleepFor,
    alive: processAlive,
    log: defaultLog,
    ...overrides,
  };
}

// The checkout's fixed test root: the database tests that must not use the
// temp directory keep their clusters under work/host-harness/ (and point TEMP
// into their own cluster directory while they run).
export const HOST_HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../work/host-harness');

// A cleanup is only ever pointed at something strictly inside the temp
// directory or the checkout's work/host-harness/.
async function checkedDirectory(directory, o) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  const target = path.resolve(directory);
  const roots = new Set([o.tmpdir ?? os.tmpdir(), o.harnessRoot ?? HOST_HARNESS_ROOT].map((root) => path.resolve(root)));
  for (const root of [...roots]) {
    try { roots.add(path.resolve(await o.realpath(root))); } catch { /* keep the unresolved root */ }
  }
  for (const root of roots) {
    const relative = path.relative(root, target);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return target;
  }
  return null;
}

// Resolves true once the process with this pid is gone (or there is no pid).
export async function waitForPidExit(pid, overrides = {}) {
  const o = options(overrides);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + o.exitTimeoutMs;
  while (o.alive(pid)) {
    if (Date.now() >= deadline) return false;
    await o.sleep(o.pollMs);
  }
  return true;
}

async function removeWhatCan(directory, o) {
  let left = 0;
  let entries = [];
  try { entries = await o.readdir(directory); } catch { return { removed: false, left }; }
  for (const name of entries) {
    try { await o.rm(path.join(directory, name), { recursive: true, force: true, maxRetries: o.maxRetries, retryDelay: o.retryDelay }); }
    catch { left += 1; }
  }
  try {
    await o.rm(directory, { recursive: true, force: true });
    return { removed: true, left: 0 };
  } catch {
    return { removed: false, left };
  }
}

// Removes a test directory (cluster data, scratch parents, bundles) that lies
// inside the temp directory or work/host-harness/. Retries lock errors and never throws.
export async function removeTestDirectory(directory, overrides = {}) {
  const o = options(overrides);
  const target = await checkedDirectory(directory, o);
  if (target === null) { o.log(`refusing to remove ${JSON.stringify(directory)}: not a directory inside the temp directory`); return false; }
  let last;
  for (let attempt = 1; attempt <= o.attempts; attempt += 1) {
    try {
      await o.rm(target, { recursive: true, force: true, maxRetries: o.maxRetries, retryDelay: o.retryDelay });
      return true;
    } catch (error) {
      last = error;
      if (attempt < o.attempts) await o.sleep(o.attemptDelayMs);
    }
  }
  const { removed, left } = await removeWhatCan(target, o);
  if (removed) return true;
  o.log(`could not remove ${target} after ${o.attempts} attempts (${last?.code ?? last?.message}); ${left} entr${left === 1 ? 'y' : 'ies'} left`);
  return false;
}

async function cleanupStep(o, name, fn) {
  const mark = (event) => {
    try { o.mark?.(name, event); } catch { /* timing is diagnostic only */ }
  };
  mark('start');
  try { return await fn(); } finally { mark('end'); }
}

// A slow stop is harmless once the owned process has exited and its directory
// can be cleaned up. Report other failures to callers while keeping cleanup best effort.
// A persistent cluster stays available for restart unless removal was explicitly requested.
export async function stopCluster(server, overrides = {}) {
  const o = options(overrides);
  const directory = o.directory ?? server?.options?.databaseDir;
  const child = server?.process;
  const pid = child?.pid;
  const libraryRemovesDirectory = server?.options?.persistent === false;
  const removeDirectory = o.removeDirectory ?? libraryRemovesDirectory;
  let slow = false;
  let stopped = true;
  // stop() waits for an 'exit' event, which an already exited child never emits again.
  const exited = !child || (child.exitCode !== null && child.exitCode !== undefined) || typeof child.signalCode === 'string';
  await cleanupStep(o, 'stop', async () => {
    if (exited) return;
    const timeout = Symbol('stop timeout');
    let timer;
    try {
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), o.exitTimeoutMs); });
      slow = (await Promise.race([server.stop(), deadline])) === timeout;
    } catch (error) {
      // Recover a lock error from the library's own unretried removal below.
      if (libraryRemovesDirectory && removeDirectory && ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error?.code)) return;
      stopped = false;
      o.log(`stop() failed: ${error?.code ?? error?.message ?? String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  });
  if (!(await cleanupStep(o, 'waitForExit', () => waitForPidExit(pid, o)))) {
    o.log(`postmaster ${pid} is still running ${o.exitTimeoutMs} ms after stop(); keeping its directory`);
    return false;
  }
  if (slow) o.log(`stop() exceeded ${o.exitTimeoutMs} ms; postmaster ${pid} exited`);
  const removed = await cleanupStep(o, 'removeDirectory', () => removeDirectory
    ? removeTestDirectory(directory, o) : true);
  return stopped && removed;
}

// A port nothing listens on at this moment. It is only a candidate: see startCluster.
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

export const START_ATTEMPTS = 5;

// The postmaster's own words for "this port is taken", as whole FATAL lines: no TCP address could be
// bound, or another postmaster holds the port's socket lock file (Linux). The library pins LC_MESSAGES
// to an English locale, so these are the English messages. Other lines that mention a postmaster or an
// address in use (the data directory held by another postmaster, one address family failing to bind)
// are not a taken port.
export const PORT_TAKEN = /FATAL: +(?:could not create any TCP\/IP sockets|lock file "[^"\r\n]*\.s\.PGSQL\.\d+\.lock" already exists)[ \t]*\r?$/m;

const fatalLines = (log) => log.split(/\r?\n/).filter((line) => /FATAL|PANIC/.test(line)).map((line) => line.trim()).join(' | ') || log;

// Starts a cluster built by newCluster (./pg-cluster-fixture.mjs) on a port it
// picks itself, before every start including the first; read the port from
// server.options.port once this returns. The data directory is initialised
// once; a persistent cluster that is started again passes initialise: false.
// Picking a free port and the postmaster binding it are two steps, and the
// database suites start four files' clusters at once (--test-concurrency=4):
// another cluster can bind the port in between, and the postmaster then exits
// at once. The library rejects an early exit with no reason, so the test
// failed with a bare `undefined` (migration-verify run 45380641278,
// work-claims-owner-grants-db, 663 ms in).
// Only an early exit whose log says the port is taken is retried, on a newly
// picked port, and each retry leaves one stderr line. Any other early exit is
// thrown at once with its port and the postmaster's log, and a start error that
// has a reason is thrown as it is. pickPort is handed the default picker.
// mark(name, event) is told of each real library call as stopCluster's is:
// 'initialise' once and 'start' for every start, retries too, each with
// 'start' and 'end'; picking a port is in neither. A throwing mark is ignored.
export async function startCluster(server, { initialise = true, attempts = START_ATTEMPTS, pickPort = freePort, log = defaultLog, mark } = {}) {
  const step = { mark };
  if (initialise) await cleanupStep(step, 'initialise', () => server.initialise());
  const ownLog = server.options.onLog;
  const ports = [];
  let lines = [];
  server.options.onLog = (message) => { lines.push(String(message)); return ownLog?.(message); };
  try {
    server.options.port = await pickPort(freePort);
    for (;;) {
      const port = server.options.port;
      ports.push(port);
      lines = [];
      try {
        await cleanupStep(step, 'start', () => server.start());
        return server;
      } catch (error) {
        if (error !== undefined) throw error;
        const output = lines.join('').trim();
        if (!PORT_TAKEN.test(output)) {
          throw new Error(`embedded PostgreSQL exited during start on port ${port}, not for a taken port, so not retried; its log: ${output || '(empty)'}`);
        }
        if (ports.length >= attempts) {
          throw new Error(`embedded PostgreSQL found ports ${ports.join(', ')} taken; its last log: ${output}`);
        }
        const next = await pickPort(freePort);
        log(`端口 ${port} 上 postmaster 启动即退出（端口冲突），改用端口 ${next}：${fatalLines(output)}`);
        server.options.port = next;
      }
    }
  } finally {
    server.options.onLog = ownLog;
  }
}
