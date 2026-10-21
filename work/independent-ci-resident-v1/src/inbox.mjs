// Bounded inboxes.
//
// Inbox: untrusted requests (triggers, pause requests). Producers in the Owner's user session may
// only create files; the executor reads at most N files of at most M bytes per tick (one handle per
// file, no lstat/read gap) and then renames each one into a disposition directory. Archived copies
// keep their original ACL, so every receipt that mentions one records the SHA-256 of the bytes that
// were acted on; a later edit of the archived copy is therefore detectable.
//
// OwnerInbox: the admin-only owner directory (only Administrators may create files; the service may
// only read). Requests are never moved; the service remembers processed ones by digest.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX64, check } from './canonical.mjs';
import { ensureDir, exists, nonce, readBounded, writeNew } from './store.mjs';

const NAME = /^[0-9]{13}-[0-9a-f]{12}\.json$/;
export const DISPOSITIONS = Object.freeze(['processed', 'rejected', 'ignored']);

async function readEntries(dir, maxFiles, maxBytes) {
  const out = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    if (out.length >= maxFiles) break;
    if (!NAME.test(name)) { out.push({ name, bytes: null, refused: 'INBOX_ENTRY_SHAPE_REFUSED' }); continue; }
    try {
      out.push({ name, bytes: await readBounded(path.join(dir, name), maxBytes, 'INBOX_ENTRY_SHAPE_REFUSED') });
    } catch {
      out.push({ name, bytes: null, refused: 'INBOX_ENTRY_SHAPE_REFUSED' });
    }
  }
  return out;
}

export class Inbox {
  constructor(dir, archiveRoot) { this.dir = dir; this.archiveRoot = archiveRoot; }

  static async open(dir, archiveRoot) {
    await ensureDir(dir);
    await ensureDir(archiveRoot);
    for (const d of DISPOSITIONS) await ensureDir(path.join(archiveRoot, d));
    return new Inbox(dir, archiveRoot);
  }

  // Producer helper (companion, Agents, tests): create-only, unique, time-ordered name.
  static fileName(nowMs) { return `${String(nowMs).padStart(13, '0')}-${nonce()}.json`; }

  read(maxFiles, maxBytes) { return readEntries(this.dir, maxFiles, maxBytes); }

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
