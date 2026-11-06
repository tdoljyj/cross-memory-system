// Shared cleanup for tests that run an embedded PostgreSQL cluster.
//
// On Windows the cluster's files stay locked for a short while after the
// postgres process exits, so an immediate recursive remove fails with EBUSY
// (or EPERM / ENOTEMPTY) and node:test then fails the whole file although every
// subtest passed. `embedded-postgres` itself removes a non-persistent cluster at
// the end of stop() with one unretried fs.rm, so stopping goes through here too.
//
// Cleanup is best effort and never throws: when a directory still cannot be
// removed it logs one line, deletes whatever can be deleted so no large
// directory is left behind, and returns false. It never kills a process: the
// postmaster is stopped by the library, and its exit is confirmed by the exact
// pid of the child this process started (postmaster.pid is not trusted; on
// Windows the library's taskkill leaves a stale one behind).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

// A cleanup is only ever pointed at something strictly inside the temp directory.
async function checkedDirectory(directory, o) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  const target = path.resolve(directory);
  const roots = new Set([o.tmpdir ?? os.tmpdir()].map((root) => path.resolve(root)));
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
  try { entries = await o.readdir(directory); } catch { return left; }
  for (const name of entries) {
    try { await o.rm(path.join(directory, name), { recursive: true, force: true, maxRetries: o.maxRetries, retryDelay: o.retryDelay }); }
    catch { left += 1; }
  }
  try { await o.rm(directory, { recursive: true, force: true }); } catch { /* still locked */ }
  return left;
}

// Removes a test directory (cluster data, scratch parents, bundles) that lies
// inside the temp directory. Retries lock errors and never throws.
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
  const left = await removeWhatCan(target, o);
  o.log(`could not remove ${target} after ${o.attempts} attempts (${last?.code ?? last?.message}); ${left} entr${left === 1 ? 'y' : 'ies'} left`);
  return false;
}

// Stops an embedded-postgres server and, for a non-persistent cluster, makes
// sure its directory is gone even when the library's own remove hit a lock.
// A persistent cluster's directory is left to the test, which may restart it.
export async function stopCluster(server, overrides = {}) {
  if (!server) return;
  const o = options(overrides);
  const directory = overrides.directory ?? server.options?.databaseDir;
  const child = server.process;
  const pid = child?.pid;
  // stop() waits for an 'exit' event, which an already exited child never emits again.
  const exited = !child || (child.exitCode !== null && child.exitCode !== undefined) || typeof child.signalCode === 'string';
  if (!exited) {
    try { await server.stop(); }
    catch (error) {
      // The library's own unretried remove of a non-persistent cluster is the usual cause.
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error?.code)) o.log(`stop() failed: ${error?.code ?? error?.message}`);
    }
  }
  if (!(await waitForPidExit(pid, o))) o.log(`postmaster ${pid} is still running ${o.exitTimeoutMs} ms after stop()`);
  if (typeof directory === 'string' && server.options?.persistent === false) await removeTestDirectory(directory, o);
}
