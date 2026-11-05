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
// directory is left behind, and returns false.
import fs from 'node:fs/promises';
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
    readFile: fs.readFile,
    readdir: fs.readdir,
    sleep: sleepFor,
    alive: processAlive,
    kill: (pid) => process.kill(pid),
    log: defaultLog,
    ...overrides,
  };
}

// A cleanup must never be pointed at something that is not a test directory.
function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  const resolved = path.resolve(directory);
  const { root } = path.parse(resolved);
  return resolved.slice(root.length).split(path.sep).filter(Boolean).length >= 2 ? resolved : null;
}

// postmaster.pid is removed by postgres as it shuts down; its first line is the
// pid. Resolves true once no live postmaster is recorded for the directory.
export async function waitForClusterExit(directory, overrides = {}) {
  const o = options(overrides);
  const deadline = Date.now() + o.exitTimeoutMs;
  for (;;) {
    let pid = null;
    try { pid = Number.parseInt(String(await o.readFile(path.join(directory, 'postmaster.pid'), 'utf8')).split('\n')[0], 10); }
    catch { return true; }
    if (!Number.isSafeInteger(pid) || pid <= 0 || !o.alive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await o.sleep(o.pollMs);
  }
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

// Removes a test directory (cluster data, scratch parents, bundles). Waits for
// a recorded postmaster to exit, retries lock errors, never throws.
export async function removeTestDirectory(directory, overrides = {}) {
  const o = options(overrides);
  const target = checkedDirectory(directory);
  if (target === null) { o.log(`refusing to remove ${JSON.stringify(directory)}: not an absolute test directory`); return false; }
  if (!(await waitForClusterExit(target, o))) o.log(`postmaster of ${target} is still running after ${o.exitTimeoutMs} ms; removing anyway`);
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
  try { await server.stop(); }
  catch (error) {
    // The library's own unretried remove of a non-persistent cluster is the usual cause.
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error?.code)) o.log(`stop() failed: ${error?.code ?? error?.message}`);
  }
  if (typeof directory !== 'string') return;
  if (!(await waitForClusterExit(directory, o))) {
    let pid = null;
    try { pid = Number.parseInt(String(await o.readFile(path.join(directory, 'postmaster.pid'), 'utf8')).split('\n')[0], 10); } catch { /* gone */ }
    if (Number.isSafeInteger(pid) && pid > 0) {
      o.log(`postmaster ${pid} of ${directory} did not exit; killing it`);
      try { o.kill(pid); } catch { /* already gone */ }
      await waitForClusterExit(directory, { ...o, exitTimeoutMs: 5000 });
    }
  }
  if (server.options?.persistent === false) await removeTestDirectory(directory, o);
}
