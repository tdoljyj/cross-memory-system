// Single-instance lock for the executor. Stopping the service never kills an executor that is in the
// middle of a batch, so after a restart an old executor might still be finishing. The lock is a
// directory created atomically; its holder refreshes a liveness file every tick. Checked in this order:
//   holder from an earlier boot            -> stale, whatever its pid (Task d80fd886, F1): after a reboot
//                                             the old pid may name an unrelated process, and a liveness
//                                             record from minutes before the reboot still looks fresh
//   holder pid gone                        -> stale: the lock is renamed (kept) and recovery decides
//   holder pid alive and liveness fresh    -> another executor is running: refuse to start
//   holder pid alive but liveness stale    -> ambiguous (pid reuse, or a hung executor): refuse to
//                                             start; the Owner looks (fail closed, nothing is killed)
// The holder and its liveness record carry the milliseconds since boot (os.uptime(), GetTickCount64 on
// Windows). Uptime restarts at every boot and only grows within one, so a record with more uptime than the
// machine has now was written before a reboot. The test is one-way: a holder whose last record was written
// earlier after its boot than the new start's uptime plus the margin is not recognised and falls back to the
// rules below it. The margin is defence in depth: with one clock source the error is a clock tick (about 16 ms
// on Windows), but a misjudged live holder would mean two executors. An unparsable liveness record (torn by a
// power loss; within one boot the rename is atomic) counts as none; any other read error is thrown.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, isoNow } from './canonical.mjs';
import { exists, nonce, readJson, renameToNew, writeNew } from './store.mjs';

const FRESH_MS = 10 * 60_000;
export const EARLIER_BOOT_MARGIN_MS = 60_000; // also the stop request's (src/stop-request.mjs)

// Rounded, not floored: os.uptime() is GetTickCount64() / 1000 on Windows, and only rounding gives back the exact
// milliseconds (flooring loses one for about one value in a hundred), so a record compares exactly with the host's.
export const secondsToMs = seconds => Math.round(seconds * 1000);
export const uptimeMs = () => secondsToMs(os.uptime());
const recordedUptime = record => (Number.isSafeInteger(record?.uptimeMs) && record.uptimeMs >= 0 ? record.uptimeMs : -1);
const readLiveness = async file => {
  if (!(await exists(file))) return null;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
};

export async function acquireInstanceLock(stateRoot, { pid = process.pid, alive, clock = Date.now, uptime = uptimeMs }) {
  const dir = path.join(stateRoot, 'executor.lock');
  const locks = path.join(stateRoot, 'locks');
  await fs.mkdir(locks, { recursive: true });
  try {
    await fs.mkdir(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = (await exists(path.join(dir, 'holder.json'))) ? (await readJson(path.join(dir, 'holder.json'))).value : null;
    const liveness = await readLiveness(path.join(dir, 'alive.json'));
    const ownLiveness = liveness && holder && liveness.token === holder.token ? liveness : null;
    const fromHolder = recordedUptime(holder), fromLiveness = recordedUptime(ownLiveness);
    const recorded = Math.max(fromHolder, fromLiveness);
    const now = uptime();
    const earlierBoot = recorded > now + EARLIER_BOOT_MARGIN_MS;
    if (holder && !earlierBoot && await alive(holder.pid)) {
      const fresh = ownLiveness && clock() - ownLiveness.at < FRESH_MS;
      check(!fresh, 'EXECUTOR_ALREADY_RUNNING', holder.pid);
      check(false, 'EXECUTOR_LOCK_AMBIGUOUS_OWNER_LOOK', holder.pid);
    }
    const kept = path.join(locks, `stale-${isoNow(clock).replace(/[:.]/g, '')}-${nonce()}`);
    await renameToNew(dir, kept);
    if (earlierBoot) {
      await writeNew(path.join(kept, 'earlier-boot.json'), {
        contract: 'clued.independent-ci.lock-earlier-boot/1', recordedUptimeMs: recorded, recordedFrom: fromLiveness >= fromHolder ? 'liveness' : 'holder',
        uptimeMs: now, marginMs: EARLIER_BOOT_MARGIN_MS, at: isoNow(clock),
      });
    }
    await fs.mkdir(dir);
  }
  const token = nonce(16);
  await writeNew(path.join(dir, 'holder.json'), { pid, token, at: isoNow(clock), uptimeMs: uptime() });
  const touch = async () => {
    const tmp = path.join(dir, `alive.${pid}.tmp`);
    // Synced before the rename: after a power loss the record must still carry the uptime the next boot reads.
    const handle = await fs.open(tmp, 'w');
    try { await handle.writeFile(JSON.stringify({ token, at: clock(), uptimeMs: uptime() })); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, path.join(dir, 'alive.json')); // liveness hint, not evidence
  };
  await touch();
  return { dir, touch };
}

export const processAlive = async pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
