// Bounded inboxes.
//
// Inbox: untrusted requests (triggers, pause requests). Producers in the Owner's user session may
// only create files; the executor reads at most N files of at most M bytes per tick (one handle per
// file, no lstat/read gap) and then renames each one into a disposition directory. Archived copies
// keep their original ACL, so every receipt that mentions one records the SHA-256 of the bytes that
// were acted on; a later edit of the archived copy is therefore detectable.
//
// A drop box is create-only for the Owner's session (install-resident.ps1 Get-AclPlan: the folder allows adding a file, existing
// files are read-only for the Owner, who has no DELETE and no DELETE_CHILD), so a producer can neither write a temporary name
// and rename it nor replace a file: it creates the file and then writes it, and the resident can find it in between, empty
// (DESIGN §31, Task 32d10618). The reader therefore waits: an empty file, or one whose size changed under the read, is not
// there yet. It is left in place and read again on the next pass; one still unfinished after INBOX_UNFINISHED_GRACE_MS (by the
// reader's own clock, counted from the pass that first met it) is listed as refused, as every such file was before.
//
// OwnerInbox: the admin-only owner directory (only Administrators may create files; the service may
// only read). Requests are never moved; the service remembers processed ones by digest.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX64, check } from './canonical.mjs';
import { ensureDir, exists, nonce, readBounded, writeNew } from './store.mjs';

const NAME = /^[0-9]{13}-[0-9a-f]{12}\.json$/;
export const DISPOSITIONS = Object.freeze(['processed', 'rejected', 'ignored']);
export const INBOX_UNFINISHED_GRACE_MS = 30_000;
const NOT_THERE_YET = new Set(['empty', 'size-changed']);

// unfinished: name -> the reader's clock at the first pass that met the file unfinished (Inbox keeps it; a name that is no
// longer in the directory is forgotten).
async function readEntries(dir, maxFiles, maxBytes, unfinished, now) {
  const out = [];
  const names = (await fs.readdir(dir)).sort();
  const present = new Set(names);
  for (const known of unfinished.keys()) if (!present.has(known)) unfinished.delete(known);
  for (const name of names) {
    if (out.length >= maxFiles) break;
    if (!NAME.test(name)) { out.push({ name, bytes: null, refused: 'INBOX_ENTRY_SHAPE_REFUSED' }); continue; }
    try {
      out.push({ name, bytes: await readBounded(path.join(dir, name), maxBytes, 'INBOX_ENTRY_SHAPE_REFUSED') });
      unfinished.delete(name);
    } catch (error) {
      if (error?.code === 'INBOX_ENTRY_SHAPE_REFUSED' && NOT_THERE_YET.has(error.detail)) {
        if (!unfinished.has(name)) unfinished.set(name, now);
        if (now - unfinished.get(name) < INBOX_UNFINISHED_GRACE_MS) continue; // being written: not there yet
      }
      out.push({ name, bytes: null, refused: 'INBOX_ENTRY_SHAPE_REFUSED' });
    }
  }
  return out;
}

export class Inbox {
  constructor(dir, archiveRoot, clock = Date.now) { this.dir = dir; this.archiveRoot = archiveRoot; this.clock = clock; this.unfinished = new Map(); }

  static async open(dir, archiveRoot, clock = Date.now) {
    await ensureDir(dir);
    await ensureDir(archiveRoot);
    for (const d of DISPOSITIONS) await ensureDir(path.join(archiveRoot, d));
    return new Inbox(dir, archiveRoot, clock);
  }

  // Producer helper (companion, Agents, tests): create-only, unique, time-ordered name.
  static fileName(nowMs) { return `${String(nowMs).padStart(13, '0')}-${nonce()}.json`; }

  // The companion's way into a drop box (the poller's triggers, the dual-active hold's intake requests): one new file with
  // the next name. Create-then-write, because the Owner may do no more there; the reader above waits for it.
  static async drop(dir, value, clock = Date.now) {
    const name = Inbox.fileName(clock());
    await writeNew(path.join(dir, name), value);
    return name;
  }

  read(maxFiles, maxBytes) { return readEntries(this.dir, maxFiles, maxBytes, this.unfinished, this.clock()); }

  async dispose(name, disposition) {
    check(DISPOSITIONS.includes(disposition), 'INBOX_DISPOSITION_INVALID');
    const from = path.join(this.dir, name);
    if (!(await exists(from))) return false;
    const to = path.join(this.archiveRoot, disposition, `${Date.now()}-${nonce()}-${name.replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 80)}`);
    await fs.rename(from, to);
    return true;
  }
}

export class OwnerInbox {
  constructor(dir, seenDir) { this.dir = dir; this.seenDir = seenDir; this.namesDir = path.join(seenDir, 'names'); }

  static async open(dir, seenDir) {
    await ensureDir(dir);
    await ensureDir(seenDir);
    await ensureDir(path.join(seenDir, 'names'));
    return new OwnerInbox(dir, seenDir);
  }

  // The service can only read owner\, which therefore only grows. Names already handled are skipped
  // BEFORE the per-tick limit is applied, so old requests can never starve new ones (review M6a).
  async read(maxFiles, maxBytes) {
    const pending = [];
    for (const name of (await fs.readdir(this.dir)).sort()) {
      if (!NAME.test(name)) continue;
      if (await exists(path.join(this.namesDir, `${name}.json`))) continue;
      pending.push(name);
      if (pending.length >= maxFiles) break;
    }
    const out = [];
    for (const name of pending) {
      try { out.push({ name, bytes: await readBounded(path.join(this.dir, name), maxBytes, 'OWNER_REQUEST_SHAPE_REFUSED') }); }
      catch { out.push({ name, bytes: null, refused: 'OWNER_REQUEST_SHAPE_REFUSED' }); }
    }
    return out;
  }

  seen(sha) { check(HEX64.test(sha), 'OWNER_REQUEST_DIGEST_INVALID'); return exists(path.join(this.seenDir, `${sha}.json`)); }

  // Remembers both the file name (so it is never read again) and the byte digest (so a copy of a
  // processed request under another name is not acted on twice).
  async remember(name, sha) {
    check(NAME.test(name), 'OWNER_REQUEST_NAME_INVALID');
    if (!(await exists(path.join(this.namesDir, `${name}.json`)))) await writeNew(path.join(this.namesDir, `${name}.json`), { name, sha256: sha ?? null, at: new Date().toISOString() });
    if (sha && HEX64.test(sha) && !(await this.seen(sha))) await writeNew(path.join(this.seenDir, `${sha}.json`), { sha256: sha, name, at: new Date().toISOString() });
  }
}
