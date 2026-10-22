// The SCM stop request, state\STOP-REQUESTED (Task d80fd886, F2). ResidentServiceHost creates it only when none
// exists and writes {"contract":"clued.independent-ci.stop-request/1","uptimeMs":<GetTickCount64>} into it, so a
// file without its content yet is a normal moment. The executor looks between ticks.
//
// A request whose uptime is more than the margin ahead of this boot's was asked before a reboot and never
// acknowledged (the executor ended first). It is not for this executor: it is renamed into
// state\locks\prior-boot-stop-<ms>-<pid> after a receipt with both uptimes, and the executor keeps running. Without
// this, the first start after such a reboot stops at once with exit 0, and no failure restart follows. Every other
// request is honoured as before, including one that is empty, torn, unreadable or of another shape: only a parsed
// request from an earlier boot is dropped. Within one boot the host's uptime is never ahead of the executor's.
// One narrow case stays open: an SCM stop that comes while such a leftover is still there (between the start and
// the executor's first look, a few seconds) finds it "already there" and writes nothing, and the executor then drops
// the leftover. The host reports STOPPED after its 20 s wait and the executor runs on without a host; the next
// start refuses the instance lock, so the Owner sees it.
import fs from 'node:fs/promises';
import path from 'node:path';
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
async function readRequest(file) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const buffer = Buffer.alloc(STOP_REQUEST_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// The service loop's stopRequested(): true when the executor must stop now.
export function stopRequestCheck({ stopFile, locksDir, receipts, uptime = uptimeMs, clock = Date.now, pid = process.pid }) {
  return async () => {
    let bytes;
    try { bytes = await readRequest(stopFile); } catch { return true; } // there, but unreadable: honoured
    if (bytes === null) return false;
    const now = uptime();
    const seen = classifyStopRequest(bytes, now);
    if (!seen.earlierBoot) return true;
    const kept = `prior-boot-stop-${clock()}-${pid}`;
    await receipts.append('service-stop-prior-boot', { pid, recordedUptimeMs: seen.recordedUptimeMs, uptimeMs: now, marginMs: EARLIER_BOOT_MARGIN_MS, kept });
    await fs.rename(stopFile, path.join(locksDir, kept));
    return false;
  };
}
