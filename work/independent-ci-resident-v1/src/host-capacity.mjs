// The host watchdog's capacity marker, for the PR page (Owner decision 241824b2). The watchdog
// (scripts/ci/self-hosted/render-host-watchdog.ps1, rendered to C:\clued-ci\watchdog-<host>.ps1, running in the Owner's session)
// writes C:\clued-ci\state\capacity-alert.json exactly while it holds the Linux runners back for low capacity, and removes it at the
// resume: { state: 'capacity-suspended', since, detail, host }, detail being its Format-Capacity text
// ("D: 12.3 GB free (stops below 20, resumes at 30), memory 9.87 GB free (stops below 2, resumes at 3)", a suspend adding its
// cleanup note after it). Until now only a desktop notification said so, and 2026-11-08 #1040 waited 13 minutes behind it.
//
// The companion writes the PR page status itself (pr-status.mjs runs in its advisory lane), so this fact needs no channel to the
// service: no mailbox record, no heartbeat field, nothing an older service could refuse. The read is advisory and never fails:
// read only, at most CAPACITY_ALERT_MAX_BYTES, a regular file only; anything missing, too big, torn or of another shape is no marker.
// What is shown is a fixed template over the drive letter and the numbers the watchdog wrote, never its free text.
import fs from 'node:fs/promises';
import { parseBoundedJson } from './canonical.mjs';

export const CAPACITY_ALERT_FILE = 'C:\\clued-ci\\state\\capacity-alert.json';
export const CAPACITY_ALERT_MAX_BYTES = 4096;
export const CAPACITY_ALERT_TEXT = '主机容量不足，Linux runner 已停';

const NUM = '(\\d{1,6}(?:[.,]\\d{1,3})?)';
// The start of Format-Capacity's text; what follows (a suspend's cleanup note) is not read.
const DETAIL = new RegExp(`^([A-Z?]): (unknown|${NUM.slice(1, -1)}) GB free \\(stops below ${NUM}, resumes at ${NUM}\\), memory ${NUM} GB free \\(stops below ${NUM}, resumes at ${NUM}\\)`);
const num = s => (typeof s === 'string' && s !== 'unknown' ? Number(s.replace(',', '.')) : null);

// The line for the PR page, or null without a marker. The disk is named while it is below its resume level, memory likewise;
// a detail in another form (or a disk the watchdog could not size) gives the line without numbers.
export function capacityText(alert) {
  if (!alert) return null;
  const parts = [];
  if (alert.drive && alert.freeGb !== null && (alert.diskResumeGb === null || alert.freeGb < alert.diskResumeGb)) parts.push(`${alert.drive}: 剩 ${alert.freeGb} GB`);
  if (alert.memGb !== null && alert.memResumeGb !== null && alert.memGb < alert.memResumeGb) parts.push(`内存剩 ${alert.memGb} GB`);
  return parts.length ? `${CAPACITY_ALERT_TEXT}（${parts.join('，')}）` : CAPACITY_ALERT_TEXT;
}

// -> { drive, freeGb, memGb, text } while the marker says the runners are held back; null otherwise. Never throws.
export async function readCapacityAlert(file = CAPACITY_ALERT_FILE) {
  let fh = null;
  try {
    fh = await fs.open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0 || st.size > CAPACITY_ALERT_MAX_BYTES) return null;
    const buf = Buffer.alloc(CAPACITY_ALERT_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const marker = parseBoundedJson(buf.subarray(0, bytesRead), CAPACITY_ALERT_MAX_BYTES, 'CAPACITY_ALERT_REFUSED');
    if (marker.state !== 'capacity-suspended') return null;
    const m = typeof marker.detail === 'string' ? DETAIL.exec(marker.detail) : null;
    const v = m ? { drive: m[1] === '?' ? null : m[1], freeGb: num(m[2]), diskResumeGb: num(m[4]), memGb: num(m[5]), memResumeGb: num(m[7]) }
      : { drive: null, freeGb: null, diskResumeGb: null, memGb: null, memResumeGb: null };
    return { drive: v.drive, freeGb: v.freeGb, memGb: v.memGb, text: capacityText(v) };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}
