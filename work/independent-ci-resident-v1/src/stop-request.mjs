// The SCM stop request, state\STOP-REQUESTED (Task d80fd886, F2). ResidentServiceHost creates it only when none
// exists and writes {"contract":"clued.independent-ci.stop-request/1","uptimeMs":<GetTickCount64>} into it, so a
// file without its content yet is a normal moment. The executor looks before every tick, the first included.
//
// A request whose uptime is more than the margin ahead of this boot's was asked before a reboot and never
// acknowledged (the executor ended first). It is not for this executor: it is renamed into
// state\locks\prior-boot-stop-<ms>-<pid> after a receipt with both uptimes, and the executor keeps running. Without
// this, the first start after such a reboot stops at once with exit 0, and no failure restart follows. Every other
// request is honoured as before, including one that is empty, torn, unreadable or of another shape: only a parsed
// request from an earlier boot is dropped. Within one boot the host's uptime is never ahead of the executor's, which
// is read at each look from the same clock (os.uptime(), GetTickCount64 on Windows).
//
// Two cases stay open:
// - The test is one-way. A request that the earlier boot wrote no more than the margin after the uptime of this
//   executor's look (the service starts delayed, a few minutes after boot) is not recognised and is honoured: the
//   first start then stops with exit 0, as before this change.
// - An SCM stop that comes while such a leftover is still there (from the service reporting RUNNING to the
//   executor's first look) finds it "already there" and writes nothing, and the executor then drops the leftover.
//   The host reports STOPPED after its 20 s wait, and the executor runs on without a host. The SCM cannot stop it
//   any more: the next start refuses the instance lock, so the Owner sees it, and stops it by creating
//   STOP-REQUESTED by hand or by ending the process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check } from './canonical.mjs';
import { EARLIER_BOOT_MARGIN_MS, uptimeMs } from './instance-lock.mjs';

export const STOP_REQUEST_CONTRACT = 'clued.independent-ci.stop-request/1';
export const STOP_REQUEST_MAX_BYTES = 4096;

// { earlierBoot: true, recordedUptimeMs } only for a well-formed request from an earlier boot; otherwise
// { earlierBoot: false, reason }, and the request is honoured.
export function classifyStopRequest(bytes, now) {
  if (bytes.length === 0) return { earlierBoot: false, reason: 'empty' };
  if (bytes.length > STOP_REQUEST_MAX_BYTES) return { earlierBoot: false, reason: 'oversize' };
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { earlierBoot: false, reason: 'unparsable' }; }
  if (value?.contract !== STOP_REQUEST_CONTRACT) return { earlierBoot: false, reason: 'contract' };
  const recorded = value.uptimeMs;
  if (!Number.isSafeInteger(recorded) || recorded < 0) return { earlierBoot: false, reason: 'uptime' };
  if (recorded > now + EARLIER_BOOT_MARGIN_MS) return { earlierBoot: true, recordedUptimeMs: recorded };
  return { earlierBoot: false, reason: 'this-boot' };
}

// At most one byte more than the limit, so an oversize request is seen as one. null: no request.
export async function readStopRequest(file) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const buffer = Buffer.alloc(STOP_REQUEST_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// The service loop's stopRequested(): true when the executor must stop now. A receipt or a rename that fails is
// thrown (exit 4, so the host reports 1064), after a best-effort receipt that the request is still in place.
export function stopRequestCheck({ stopFile, locksDir, receipts, uptime = uptimeMs, clock = Date.now, pid = process.pid, read = readStopRequest }) {
  return async () => {
    let bytes;
    try { bytes = await read(stopFile); } catch { return true; } // there, but unreadable: honoured
    if (bytes === null) return false;
    const now = uptime();
    const seen = classifyStopRequest(bytes, now);
    if (!seen.earlierBoot) return true;
    const kept = `prior-boot-stop-${clock()}-${pid}`;
    await receipts.append('service-stop-prior-boot', { pid, recordedUptimeMs: seen.recordedUptimeMs, uptimeMs: now, marginMs: EARLIER_BOOT_MARGIN_MS, kept });
    try {
      await fs.rename(stopFile, path.join(locksDir, kept));
    } catch (error) {
      try { await receipts.append('service-stop-prior-boot-failed', { pid, kept, failureCode: 'STOP_REQUEST_RENAME_FAILED', errno: String(error?.code ?? 'unknown') }); } catch { /* the error below still ends us */ }
      check(false, 'STOP_REQUEST_RENAME_FAILED', error?.code);
    }
    return false;
  };
}
