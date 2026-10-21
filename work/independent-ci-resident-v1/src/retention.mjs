// Archive retention reminder (Owner decision 1b5d3687). Archives are rename-only and never deleted by the
// resident; when what they keep exceeds the policy threshold (50 GB) the service writes ONE reminder
// receipt per day, so the Owner can decide what to move or delete. Nothing is deleted or moved here.
//
// Measured: the Windows spool archives (formal-spool\archive-*, failed-*), the resident's own derived
// batch packages (work\) and companion bundles (bundles\), and, through the companion, the Linux spool
// archives (clued-ci-resident-linux archive-usage). An unreadable entry makes the measurement incomplete;
// an incomplete measurement can still remind (never the other way round), and says so.
import fs from 'node:fs/promises';
import path from 'node:path';

export const REMINDER_RECEIPT = 'archive-retention-reminder';
const DAY = 86_400_000;

// Bytes of regular files below dir (links and reparse points are not followed, nothing is opened).
export async function treeBytes(dir, { maxEntries = 2_000_000 } = {}) {
  let bytes = 0, entries = 0, complete = true;
  const walk = async d => {
    let names;
    try { names = await fs.readdir(d, { withFileTypes: true }); } catch { complete = false; return; }
    for (const e of names) {
      if (++entries > maxEntries) { complete = false; return; }
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(p); continue; }
      try { const s = await fs.lstat(p); if (s.isFile()) bytes += s.size; } catch { complete = false; }
    }
  };
  await walk(dir);
  return { bytes, complete };
}

// roots: { spool, work, bundles }. Archives in the spool are its archive-*/failed-* directories only.
export async function measureWindows({ spool, work, bundles }) {
  let bytes = 0, directories = 0, complete = true;
  try {
    for (const e of await fs.readdir(spool, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink() || !/^(archive|failed)-[0-9A-Za-z-]+$/.test(e.name)) continue;
      const t = await treeBytes(path.join(spool, e.name)); bytes += t.bytes; complete &&= t.complete; directories += 1;
    }
  } catch { complete = false; }
  for (const d of [work, bundles]) {
    try { await fs.access(d); } catch { continue; }
    const t = await treeBytes(d); bytes += t.bytes; complete &&= t.complete;
  }
  return { bytes, directories, complete };
}

export class RetentionWatch {
  // ports: { policy, receipts, clock, measureWindows(), measureLinux() -> {ok, bytes, directories} }
  constructor(ports) { Object.assign(this, ports); this.lastCheck = -Infinity; this.lastReminder = -Infinity; }

  async maybeCheck() {
    const now = this.clock();
    if (now - this.lastCheck < this.policy.retention.checkEveryMs) return null;
    this.lastCheck = now;
    const w = await this.measureWindows();
    const l = await this.measureLinux().catch(() => ({ ok: false }));
    const total = w.bytes + (l.ok ? l.bytes : 0);
    const facts = { totalBytes: total, thresholdBytes: this.policy.retention.reminderBytes, windows: { bytes: w.bytes, directories: w.directories, complete: w.complete },
      linux: l.ok ? { bytes: l.bytes, directories: l.directories, complete: true } : { bytes: null, directories: null, complete: false } };
    if (total < this.policy.retention.reminderBytes || now - this.lastReminder < DAY) return { reminded: false, ...facts };
    this.lastReminder = now;
    await this.receipts.append(REMINDER_RECEIPT, { ...facts, action: 'owner-review-archives', deletesAnything: false });
    return { reminded: true, ...facts };
  }
}
