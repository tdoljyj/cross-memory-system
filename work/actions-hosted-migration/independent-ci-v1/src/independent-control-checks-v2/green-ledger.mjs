// Resident quota redesign phase 2, step 3a (design v0.5 §5.4 item 4; Owner decision 0bb98194): the green ledger. Every
// kooyumi-merge-slot success stage 8 writes is recorded here by (commit, check run id, phase), in create-only files
// under state\v2\green-ledger (clued-control only, migrate-acl.ps1). The intent is recorded before the check is written,
// so a write whose outcome is uncertain is in the ledger too; the later phases (posted, settled, merged, revoked) are
// recorded after the fact and may be missing after a crash (the intent and the journal still name the check).
// In step 3a the ledger only records. Step 3c's stage 10 reads it to revoke every old green before a new one (§5.4).
// No credential, no GitHub, no Native: a local record of what the control publisher did.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical } from '../proof.mjs';

export const GREEN_LEDGER_CONTRACT = 'clued.independent-ci.green-ledger/1';
export const GREEN_PHASES = Object.freeze(['intent', 'posted', 'settled', 'merged', 'revoked']);
// The intent could not be recorded: nothing was written to GitHub; stage 8 is not ready (the resident parks and retries).
export const GREEN_LEDGER_UNAVAILABLE = 'GREEN_LEDGER_UNAVAILABLE';
export const GREEN_ENTRY_FIELDS = Object.freeze(['contract', 'phase', 'repo', 'pr', 'headSha', 'baseSha', 'testTree', 'testMergeSha', 'effectKey', 'externalId', 'checkRunId', 'at', 'detail']);
const SHA = /^[a-f0-9]{40}$/, HEX64 = /^[a-f0-9]{64}$/, NAME = /^(\d{13})-([a-f0-9]{16})-([a-z]{4,7})-[a-f0-9]{8}\.json$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export function validateGreenEntry(e) {
  if (!plain(e) || Object.keys(e).length !== GREEN_ENTRY_FIELDS.length || !GREEN_ENTRY_FIELDS.every(k => Object.hasOwn(e, k))
    || e.contract !== GREEN_LEDGER_CONTRACT || !GREEN_PHASES.includes(e.phase) || typeof e.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repo)
    || !Number.isSafeInteger(e.pr) || e.pr < 1 || !SHA.test(e.headSha ?? '') || !SHA.test(e.baseSha ?? '') || !SHA.test(e.testTree ?? '')
    || !(e.testMergeSha === null || SHA.test(e.testMergeSha)) || !HEX64.test(e.effectKey ?? '') || typeof e.externalId !== 'string' || !e.externalId.startsWith('independent-ci:control:')
    || !(e.checkRunId === null || (Number.isSafeInteger(e.checkRunId) && e.checkRunId > 0)) || (e.phase !== 'intent' && e.checkRunId === null)
    || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || !(e.detail === null || (typeof e.detail === 'string' && e.detail.length <= 200))) fail('invalid_green_entry');
  return e;
}

export class GreenLedger {
  static async open(directory) {
    const resolved = path.resolve(directory);
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    for (let current = resolved; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_green_ledger_directory');
      if (current === path.dirname(current)) break;
    }
    return new GreenLedger(resolved);
  }
  constructor(directory, clock = Date.now) { this.directory = directory; this.clock = clock; }
  // One new file per record: written whole under a temporary name, synced, then hard-linked to a name nothing else can have
  // (time, effect key, phase, a nonce) and the temporary name removed. A link never replaces an existing file (a rename
  // would, on Windows: review N2). A crash leaves at most a temporary file, never a half record under a ledger name.
  async append({ phase, job, testTree, testMergeSha = null, effectKey, externalId, checkRunId = null, detail = null }) {
    const now = this.clock();
    const entry = validateGreenEntry({ contract: GREEN_LEDGER_CONTRACT, phase, repo: job?.repo, pr: job?.pr, headSha: job?.headSha, baseSha: job?.baseSha, testTree,
      testMergeSha, effectKey, externalId, checkRunId, at: new Date(now).toISOString(), detail });
    const name = `${String(now).padStart(13, '0')}-${effectKey.slice(0, 16)}-${phase}-${randomBytes(4).toString('hex')}.json`;
    const temporary = path.join(this.directory, `${name}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(canonical(entry)); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, path.join(this.directory, name));
    await fs.unlink(temporary).catch(() => { /* a leftover temporary file is skipped by list() */ });
    return { name, entry };
  }
  // Every complete record, oldest first. A file that is not exactly a ledger record is reported, never skipped silently:
  // step 3c's sweep fails closed on it.
  async list() {
    const out = [], refused = [];
    for (const name of (await fs.readdir(this.directory)).sort()) {
      if (name.endsWith('.tmp')) continue;
      const parts = NAME.exec(name);
      if (!parts) { refused.push(name); continue; }
      try {
        const file = path.join(this.directory, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) fail('unsafe_green_entry');
        const text = await fs.readFile(file, 'utf8'), entry = validateGreenEntry(JSON.parse(text));
        // The name says when, which effect and which phase: the content must say the same (review N2).
        if (canonical(entry) !== text || Date.parse(entry.at) !== Number(parts[1]) || entry.effectKey.slice(0, 16) !== parts[2] || entry.phase !== parts[3]) fail('invalid_green_entry');
        out.push({ name, entry });
      } catch { refused.push(name); }
    }
    return { entries: out, refused };
  }
}
