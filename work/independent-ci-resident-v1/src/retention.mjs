// Archive retention (Owner decision 1b5d3687; Task 4aedda54, DESIGN §35). Three parts:
//
// 1. The 50 GB reminder (unchanged): when what the archives keep exceeds the policy threshold the service writes ONE
//    reminder receipt per day. Measured: the Windows spool archives (formal-spool\archive-*, failed-*), the resident's own
//    derived batch packages (work\) and companion bundles (bundles\), and, through the companion, the Linux spool archives
//    (clued-ci-resident-linux archive-usage). An unreadable entry makes the measurement incomplete; an incomplete
//    measurement can still remind (never the other way round), and says so.
//
// 2. The retention rule (§35): per spool (Windows here, Linux in clued-ci-resident-linux archive-prune, the same rule), the
//    success class (archive-*, completed-*) and the failure class (failed-*: failures, HALTs, Owner aborts) each keep their
//    newest 20 GiB, never fewer than their newest 10 directories; beyond that the oldest are deleted. Archives the Owner
//    lists in the keep list (resident\owner\retention-keep.json: the archives an open Task, Bug or Evidence refers to, or
//    that the Owner marked) are never deleted and are counted on their own. Deletion is planned first and then applied,
//    only between batches with no open batch (the caller's `idle` port), only directly below the spool root, only for
//    names of the three known kinds, and fails closed: a size that cannot be read, a link or junction anywhere in a class,
//    a keep list that cannot be read, a redirected spool, a permission error or a directory that changed after planning
//    deletes nothing more and is written into the receipt.
//
// 3. Disk reminder: C: / 30 GiB by default; optional Owner settings choose drives/threshold. Receipts feed the companion's normal notification queue.
//
// No Linux measurement and no Linux prune without a fresh companion heartbeat (Task 018da927 c): the request would wait
// for its whole timeout (archive-usage: 3 minutes) and the service loop with it.
//
// The merge train's state (step 3c-2b, DESIGN §41.7) is not pruned here: state\v2\train-shadow, train-sweep, green-ledger\closed
// and the month segments of state\v2\receipts are clued-control's (the service may only read state\v2\receipts), so stage 10
// prunes and segments them itself (Source v2 resident-v2/state-retention.mjs; its pass records in state\v2\receipts\retention\).
// The resident's own receipt chain is never deleted: it is closed by month (receipts.mjs), which keeps its start bounded.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE, check, fail } from './canonical.mjs';

export const REMINDER_RECEIPT = 'archive-retention-reminder';
export const PRUNE_RECEIPT = 'archive-retention-prune';
export const DISK_RECEIPT = 'disk-space-reminder';
export const ALERT_RECEIPT = 'archive-retention-alert';
export const KEEP_CONTRACT = 'clued.independent-ci.archive-retention-keep/1';
export const KEEP_FILE = 'retention-keep.json';
const DAY = 86_400_000;
const GIB = 1024 ** 3;
// Legacy defaults (Task 4aedda54); optional Owner settings do not change the installed policy contract.
export const RETENTION_RULE = Object.freeze({ classBudgetBytes: 20 * GIB, minKeepPerClass: 10, maxDeletesPerPass: 16 });
export const DISK_REMINDER_BYTES = 30 * GIB;
// The archive kinds the archive tools create (src/archive.mjs, resident-v2/archive-windows-spool.ps1, clued-ci-resident-linux);
// any other name below the spool root is never considered for deletion. The length bound keeps a pass's answer within the
// mailbox's 4 KB.
export const ARCHIVE_NAME = /^(archive|completed|failed)-[0-9A-Za-z-]{1,90}$/;
export const archiveClass = name => { const m = ARCHIVE_NAME.exec(name); return m ? (m[1] === 'failed' ? 'failure' : 'success') : null; };
const KEEP_MAX_BYTES = 256 * 1024;
const KEEP_MAX_ENTRIES = 2000;
const KEEP_SPOOLS = Object.freeze(['windows', 'linux', 'any']);

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

// The Owner's keep list: { contract, keep: [{ name, spool: windows|linux|any, ref }] }. ref says why (an open Task, Bug or
// Evidence id, or "owner"); it is recorded, not interpreted. Anything else refuses the whole list.
export function parseKeepList(bytes) {
  let v;
  try { v = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('RETENTION_KEEP_LIST_INVALID'); }
  check(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === 'contract,keep' && v.contract === KEEP_CONTRACT
    && Array.isArray(v.keep) && v.keep.length <= KEEP_MAX_ENTRIES, 'RETENTION_KEEP_LIST_INVALID');
  for (const k of v.keep) {
    check(k && typeof k === 'object' && !Array.isArray(k) && Object.keys(k).sort().join() === 'name,ref,spool' && typeof k.name === 'string' && ARCHIVE_NAME.test(k.name)
      && KEEP_SPOOLS.includes(k.spool) && typeof k.ref === 'string' && k.ref.length >= 1 && k.ref.length <= 200, 'RETENTION_KEEP_LIST_INVALID');
  }
  return v.keep;
}

// The names kept on one spool. A missing file refuses like an unreadable one (RETENTION_KEEP_LIST_MISSING): an unknown list
// is never an empty one (independent review M2), so nothing is deleted until the Owner has written the file, even as
// {"contract":…,"keep":[]}, which is what allows deletion. A file that is not a plain file, too large, or not exactly the
// contract refuses too.
export async function readKeepList(file, spool) {
  try {
    let st;
    try { st = await fs.lstat(file); } catch (error) {
      return { ok: false, code: error.code === 'ENOENT' ? 'RETENTION_KEEP_LIST_MISSING' : 'RETENTION_KEEP_LIST_UNREADABLE' };
    }
    if (!st.isFile() || st.isSymbolicLink() || st.size > KEEP_MAX_BYTES) return { ok: false, code: 'RETENTION_KEEP_LIST_INVALID' };
    const keep = parseKeepList(await fs.readFile(file));
    return { ok: true, names: new Set(keep.filter(k => k.spool === spool || k.spool === 'any').map(k => k.name)), entries: keep.length };
  } catch (error) {
    return { ok: false, code: error?.code === 'RETENTION_KEEP_LIST_INVALID' ? 'RETENTION_KEEP_LIST_INVALID' : 'RETENTION_KEEP_LIST_UNREADABLE' };
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Pure plan (the Linux tool's plan_retention is the same rule, held to the same cases: test/fixtures/retention-cases.json).
// entries: [{ name, mtimeMs, bytes (null = unreadable), complete, isDir, links }] of the spool root; keep: Set of names.
export function planRetention({ entries, keep = new Set(), rule = RETENTION_RULE }) {
  const classes = { success: [], failure: [] };
  const protectedArchives = { directories: 0, bytes: 0, complete: true, names: [] };
  for (const e of entries) {
    const cls = archiveClass(e.name);
    if (!cls) continue;
    if (keep.has(e.name)) {
      protectedArchives.directories += 1; protectedArchives.bytes += e.bytes ?? 0;
      protectedArchives.complete &&= e.bytes !== null && e.complete === true; protectedArchives.names.push(e.name);
      continue;
    }
    classes[cls].push(e);
  }
  protectedArchives.names.sort();
  const out = { classes: {}, protected: protectedArchives, deletes: [], deferred: 0 };
  let deletes = [];
  for (const [cls, list] of Object.entries(classes)) {
    const refused = list.some(e => e.isDir !== true || e.links > 0) ? 'RETENTION_LINK_REFUSED'
      : list.some(e => e.bytes === null || e.complete !== true) ? 'RETENTION_SIZE_UNREADABLE' : null;
    const bytes = list.reduce((a, e) => a + (e.bytes ?? 0), 0);
    const summary = { directories: list.length, bytes, deleteDirectories: 0, deleteBytes: 0, refused };
    out.classes[cls] = summary;
    if (refused) continue;
    // Newest first (modification time, then name); delete from the oldest end while over budget and above the minimum.
    const sorted = [...list].sort((a, b) => (b.mtimeMs - a.mtimeMs) || byName(b, a));
    let total = bytes, remaining = sorted.length;
    const classRule = rule.classRules?.[cls] ?? rule;
    for (let i = sorted.length - 1; i >= 0 && total > classRule.classBudgetBytes && remaining > classRule.minKeepPerClass; i -= 1) {
      deletes.push({ name: sorted[i].name, class: cls, bytes: sorted[i].bytes, mtimeMs: sorted[i].mtimeMs });
      total -= sorted[i].bytes; remaining -= 1; summary.deleteDirectories += 1; summary.deleteBytes += sorted[i].bytes;
    }
  }
  deletes = deletes.sort((a, b) => (a.mtimeMs - b.mtimeMs) || byName(a, b));
  out.deferred = Math.max(0, deletes.length - rule.maxDeletesPerPass);
  out.deletes = deletes.slice(0, rule.maxDeletesPerPass).map(({ name, class: c, bytes }) => ({ name, class: c, bytes }));
  return out;
}

// Facts of one tree, links and junctions counted and never followed (Node reports a junction as a symbolic link).
export async function treeFacts(dir, { maxEntries = 2_000_000 } = {}) {
  let bytes = 0, entries = 0, links = 0, complete = true;
  const walk = async d => {
    let names;
    try { names = await fs.readdir(d, { withFileTypes: true }); } catch { complete = false; return; }
    for (const e of names) {
      if (++entries > maxEntries) { complete = false; return; }
      const p = path.join(d, e.name);
      let s;
      try { s = await fs.lstat(p); } catch { complete = false; continue; }
      if (s.isSymbolicLink() || e.isSymbolicLink()) { links += 1; continue; }
      if (s.isDirectory()) { await walk(p); continue; }
      if (s.isFile()) bytes += s.size; else links += 1; // a device, pipe or socket in an archive is as suspect as a link
    }
  };
  await walk(dir);
  return { bytes, entries, links, complete };
}

async function entryFacts(spool, name) {
  const p = path.join(spool, name);
  let st;
  try { st = await fs.lstat(p); } catch { return { name, mtimeMs: 0, bytes: null, complete: false, isDir: true, links: 0, entries: 0 }; }
  if (!st.isDirectory() || st.isSymbolicLink()) return { name, mtimeMs: Math.floor(st.mtimeMs), bytes: null, complete: false, isDir: false, links: 1, entries: 0 };
  const t = await treeFacts(p);
  return { name, mtimeMs: Math.floor(st.mtimeMs), bytes: t.complete ? t.bytes : null, complete: t.complete, isDir: true, links: t.links, entries: t.entries };
}

// Depth first, never following a link: a link or junction met on the way stops the deletion (fail closed).
export async function removeTree(dir) {
  const st = await fs.lstat(dir);
  check(st.isDirectory() && !st.isSymbolicLink(), 'RETENTION_LINK_REFUSED');
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const s = await fs.lstat(p);
    check(!s.isSymbolicLink() && !e.isSymbolicLink(), 'RETENTION_LINK_REFUSED');
    if (s.isDirectory()) await removeTree(p); else await fs.unlink(p);
  }
  await fs.rmdir(dir);
}

const deleteCode = error => (error?.code && CODE.test(error.code) && error.code.startsWith('RETENTION_') ? error.code
  : ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) ? 'RETENTION_PERMISSION_REFUSED' : 'RETENTION_DELETE_UNCONFIRMED');

async function realSpool(spool) {
  const st = await fs.lstat(spool);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return st.isDirectory() && !st.isSymbolicLink() && same(path.resolve(await fs.realpath(spool)), path.resolve(spool));
}

const refusedPass = (base, code) => ({ ...base, refused: code, classes: null, protected: null, deferred: 0, deleted: [], deletedBytes: 0, stopped: null });

// One pass over one spool: inventory, plan, apply. Returns the facts the receipt carries; deletes nothing when refused.
export async function pruneSpool({ spool, keep, rule = RETENTION_RULE, authorizeDelete = async () => true }) {
  const base = { rule: { classBudgetBytes: rule.classBudgetBytes, minKeepPerClass: rule.minKeepPerClass, maxDeletesPerPass: rule.maxDeletesPerPass,
    ...(rule.classRules ? { classRules: rule.classRules } : {}) } };
  if (!keep?.ok) return refusedPass(base, keep?.code ?? 'RETENTION_KEEP_LIST_UNREADABLE');
  const entries = [];
  try {
    if (!(await realSpool(spool))) return refusedPass(base, 'RETENTION_SPOOL_REDIRECTED');
    for (const e of await fs.readdir(spool, { withFileTypes: true })) if (archiveClass(e.name)) entries.push(await entryFacts(spool, e.name));
  } catch { return refusedPass(base, 'RETENTION_SPOOL_UNREADABLE'); }
  const plan = planRetention({ entries, keep: keep.names, rule });
  const deleted = [];
  let stopped = null;
  for (const d of plan.deletes) {
    if (!await authorizeDelete().catch(() => false)) { stopped = { name: d.name, code: 'RETENTION_SETTINGS_CHANGED', partial: false }; break; }
    // Re-checked right before the deletion: still the planned directory, same size and entry count, no link.
    const before = entries.find(e => e.name === d.name);
    const now = await entryFacts(spool, d.name);
    if (!now.isDir || now.links > 0) { stopped = { name: d.name, code: 'RETENTION_LINK_REFUSED', partial: false }; break; }
    if (now.bytes !== before.bytes || now.entries !== before.entries) { stopped = { name: d.name, code: 'RETENTION_CHANGED_SINCE_PLAN', partial: false }; break; }
    try { await removeTree(path.join(spool, d.name)); deleted.push(d); } catch (error) { stopped = { name: d.name, code: deleteCode(error), partial: true }; break; }
  }
  return { ...base, refused: null, classes: plan.classes, protected: { ...plan.protected, names: plan.protected.names.slice(0, 64) }, deferred: plan.deferred,
    deleted, deletedBytes: deleted.reduce((a, d) => a + d.bytes, 0), stopped };
}

export class RetentionWatch {
  // ports: { policy, receipts, clock, measureWindows(), measureLinux() -> {ok, bytes, directories},
  //   companionReady() -> bool (a fresh companion heartbeat; without it nothing is asked of the companion),
  //   idle() -> { ok, reason } (no open batch, no HALT; deletion runs only then),
  //   pruneWindows() -> pruneSpool facts, pruneLinux() -> { ok, prune, usage } | { ok: false, code },
  //   diskFree(driveRoot) -> { ok, freeBytes }, readSettings() -> {ok, settings|code} }. Without idle() nothing is deleted.
  constructor(ports) {
    Object.assign(this, ports);
    this.lastCheck = -Infinity; this.lastReminder = -Infinity; this.lastDisk = -Infinity; this.lastRefusal = new Map(); this.lastAlert = new Map();
  }

  async alert(spool, code, now) {
    const key = `${spool}:${code}`;
    if (now - (this.lastAlert.get(key) ?? -Infinity) < DAY) return;
    await this.receipts.append(ALERT_RECEIPT, { spool, code, action: 'owner-review-retention', deletesAnything: false });
    if (typeof this.notify === 'function') await this.notify(`retention:${key}`, 'Clued：归档保留需要检查', `${spool}: ${code}。请检查归档保留配置；未自动放宽清理条件。`);
    this.lastAlert.set(key, now);
  }

  async ready() {
    if (typeof this.companionReady !== 'function') return true;
    try { return (await this.companionReady()) === true; } catch { return false; }
  }

  // A pass with deletions writes its receipt every time; a pass that was refused or stopped writes one per day per reason.
  async recordPrune(spool, facts, now) {
    const problem = facts.refused ?? facts.stopped?.code ?? Object.values(facts.classes ?? {}).map(c => c.refused).find(Boolean) ?? null;
    if (problem) await this.alert(spool, problem, now);
    for (const warning of facts.warnings ?? []) await this.alert(spool, warning, now);
    if (facts.deleted.length === 0 && !problem) return false;
    if (facts.deleted.length === 0) {
      const key = `${spool}:${problem}`;
      if (now - (this.lastRefusal.get(key) ?? -Infinity) < DAY) return false;
    }
    await this.receipts.append(PRUNE_RECEIPT, { spool, ...facts, deletesAnything: facts.deleted.length > 0 });
    if (problem) this.lastRefusal.set(`${spool}:${problem}`, now);
    return true;
  }

  async prunePass(companion, now) {
    const out = { skipped: null, windows: null, linux: null, linuxUsage: null };
    const idle = typeof this.idle === 'function' ? await this.idle().catch(() => ({ ok: false, reason: 'IDLE_UNCONFIRMED' })) : { ok: false, reason: 'NO_IDLE_PORT' };
    if (!idle?.ok) { out.skipped = idle?.reason ?? 'BATCH_OPEN'; return out; }
    if (typeof this.pruneWindows === 'function') {
      try { out.windows = await this.pruneWindows(this.activeSettings ?? {}); } catch { out.windows = refusedPass({}, 'RETENTION_PASS_UNCONFIRMED'); }
      await this.recordPrune('windows', out.windows, now);
    }
    if (typeof this.pruneLinux === 'function' && companion) {
      const r = await this.pruneLinux().catch(() => ({ ok: false, code: 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED' }));
      out.linux = r?.prune ? r.prune : refusedPass({}, r?.code ?? 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED');
      out.linuxUsage = r?.ok && r.usage ? r.usage : null;
      await this.recordPrune('linux', out.linux, now);
    }
    return out;
  }

  async maybeCheck() {
    const now = this.clock();
    if (now - this.lastCheck < this.policy.retention.checkEveryMs) return null;
    this.lastCheck = now;
    const companion = await this.ready();
    const settings = typeof this.readSettings === 'function' ? await this.readSettings().catch(() => ({ ok: false, code: 'RETENTION_SETTINGS_UNREADABLE' })) : { ok: true, settings: {} };
    this.activeSettings = settings.ok ? settings.settings : {};
    if (!settings.ok) await this.alert('settings', settings.code, now);
    const prune = settings.ok ? await this.prunePass(companion, now) : { skipped: settings.code, windows: null, linux: null, linuxUsage: null };
    const w = await this.measureWindows();
    // Task 018da927 (c): no heartbeat, no request; the archive-usage request would hold this loop for its 3-minute timeout.
    const l = !companion ? { ok: false, skipped: 'COMPANION_HEARTBEAT_ABSENT' }
      : prune.linuxUsage ? { ok: true, ...prune.linuxUsage } : await this.measureLinux().catch(() => ({ ok: false }));
    const total = w.bytes + (l.ok ? l.bytes : 0);
    const facts = { totalBytes: total, thresholdBytes: this.policy.retention.reminderBytes, windows: { bytes: w.bytes, directories: w.directories, complete: w.complete },
      linux: l.ok ? { bytes: l.bytes, directories: l.directories, complete: true } : { bytes: null, directories: null, complete: false, ...(l.skipped ? { skipped: l.skipped } : {}) } };
    const extra = { prune: { skipped: prune.skipped, windows: prune.windows?.deleted.length ?? null, linux: prune.linux?.deleted.length ?? null }, disk: await this.checkDisk(now) };
    if (total < this.policy.retention.reminderBytes || now - this.lastReminder < DAY) return { reminded: false, ...facts, ...extra };
    this.lastReminder = now;
    await this.receipts.append(REMINDER_RECEIPT, { ...facts, action: 'owner-review-archives', deletesAnything: false });
    return { reminded: true, ...facts, ...extra };
  }

  // Defaults to C: below 30 GiB; optional Owner drive list, daily reminders, unreadable disks also alert. Never blocks a batch.
  async checkDisk(now) {
    if (typeof this.diskFree !== 'function') return null;
    const config = this.activeSettings?.disk ?? { drives: ['C:'], thresholdBytes: DISK_REMINDER_BYTES };
    const results = [];
    this.lastDrives ??= new Map();
    for (const drive of config.drives) {
      const d = await this.diskFree(drive + '\\').catch(() => ({ ok: false }));
      if (!d?.ok || !Number.isSafeInteger(d.freeBytes) || d.freeBytes < 0) {
        await this.alert('disk', 'RETENTION_DISK_UNREADABLE', now);
        results.push({ ok: false, reminded: false }); continue;
      }
      const reminded = d.freeBytes < config.thresholdBytes && now - (this.lastDrives.get(drive) ?? -Infinity) >= DAY;
      if (reminded) {
        await this.receipts.append(DISK_RECEIPT, { drive, freeBytes: d.freeBytes, thresholdBytes: config.thresholdBytes, action: 'owner-free-disk-space', blocksAnything: false });
        this.lastDrives.set(drive, now);
      }
      results.push({ ok: true, freeBytes: d.freeBytes, reminded });
    }
    return results.length === 1 ? results[0] : { drives: results };
  }
}

// Free bytes of a drive for this account (fs.statfs).
export async function diskFreeBytes(root = 'C:\\') {
  const s = await fs.statfs(root);
  const free = s.bavail * s.bsize;
  return Number.isSafeInteger(free) ? { ok: true, freeBytes: free } : { ok: false };
}
