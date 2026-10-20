// Single-instance lock for the executor. Stopping the service never kills an executor that is in the
// middle of a batch, so after a restart an old executor might still be finishing. The lock is a
// directory created atomically; its holder refreshes a liveness file every tick.
//   holder pid gone                        -> stale: the lock is renamed (kept) and recovery decides
//   holder pid alive and liveness fresh    -> another executor is running: refuse to start
//   holder pid alive but liveness stale    -> ambiguous (pid reuse, or a hung executor): refuse to
//                                             start; the Owner looks (fail closed, nothing is killed)
import fs from 'node:fs/promises';
import path from 'node:path';
import { check, isoNow } from './canonical.mjs';
import { exists, nonce, readJson, renameToNew, writeNew } from './store.mjs';

const FRESH_MS = 10 * 60_000;

export async function acquireInstanceLock(stateRoot, { pid = process.pid, alive, clock = Date.now }) {
  const dir = path.join(stateRoot, 'executor.lock');
  const locks = path.join(stateRoot, 'locks');
  await fs.mkdir(locks, { recursive: true });
  try {
    await fs.mkdir(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = (await exists(path.join(dir, 'holder.json'))) ? (await readJson(path.join(dir, 'holder.json'))).value : null;
    const liveness = (await exists(path.join(dir, 'alive.json'))) ? JSON.parse(await fs.readFile(path.join(dir, 'alive.json'), 'utf8')) : null;
    if (holder && await alive(holder.pid)) {
      const fresh = liveness && liveness.token === holder.token && clock() - liveness.at < FRESH_MS;
      check(!fresh, 'EXECUTOR_ALREADY_RUNNING', holder.pid);
      check(false, 'EXECUTOR_LOCK_AMBIGUOUS_OWNER_LOOK', holder.pid);
    }
    await renameToNew(dir, path.join(locks, `stale-${isoNow(clock).replace(/[:.]/g, '')}-${nonce()}`));
    await fs.mkdir(dir);
  }
  const token = nonce(16);
  await writeNew(path.join(dir, 'holder.json'), { pid, token, at: isoNow(clock) });
  const touch = async () => {
    const tmp = path.join(dir, `alive.${pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ token, at: clock() }));
    await fs.rename(tmp, path.join(dir, 'alive.json')); // liveness hint, not evidence
  };
  await touch();
  return { dir, touch };
}

export const processAlive = async pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
