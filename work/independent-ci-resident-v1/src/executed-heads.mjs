// Executed heads, independent of the installed Source (resident quota redesign v0.6 + §9, phase 1, items 1, 6, 7).
//
// The ledger burns a head per (repo, head, Source, attempt) (ledger.mjs#headKey), so a new Source makes every head new
// again. That is right for a head that never published a check, and wrong for one that did: on 2026-10-22, after the
// r2 reinstall (fresh state, new Source), #896 head 21d6d7e3 was admitted again, stage 3 found its gitleaks check
// already published by the r1 run (ROLE_ALREADY_PUBLISHED_ON_HEAD) and the executor HALTed (Note 1550fef8).
//
// This store keeps, per (repo, head) and whatever the Source or attempt, the heads that MAY HAVE PUBLISHED a check:
//   state\executed-heads\<executedHeadKey>\<origin>-<batch key, 16 hex>.json   (create-only; any file, or the directory alone
//   after an interrupted write, means "may have published")
// written
//   - by the executor right before the first stage that can publish a role check (stage R, 3, 5, 7 or 8), and
//   - once, on the first start of an install, by the BACKFILL from every earlier ledger: the state the service starts
//     with and the earlier installs' state that install-resident.ps1 carried into state\backfill\<n>\ (n = its place in
//     the manifest) and listed, file by file with its SHA-256, in install\backfill-manifest.json. A reinstall therefore
//     never forgets one.
// No batch runs before the backfill wrote BACKFILL-COMPLETE.json (executor.mjs#tick). A head in this store is never
// admitted again, under any Source (executor.mjs#precheck, HEAD_ALREADY_PUBLISHED_NO_RETRY); a new commit is needed.
// Heads that ended before any publication stage (stage 1 or 2, the workspace, a bundle) stay out of it, so a new Source
// may still run them, exactly as before. A train front batch (subject with S) is kept per (repo, head, S) (executedHeadKey).
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, HEX64, REPO, ResidentError, check, digest, isoNow, parseBoundedJson, sha256 } from './canonical.mjs';
import { ensureDir, exists, readBounded, writeNew } from './store.mjs';

export const EXECUTED_HEAD_KEY_CONTRACT = 'clued.independent-ci.resident-executed-head-key/1';
export const EXECUTED_HEAD_CONTRACT = 'clued.independent-ci.resident-executed-head/1';
export const BACKFILL_MARKER_CONTRACT = 'clued.independent-ci.resident-executed-heads-backfill/1';
export const BACKFILL_MANIFEST_CONTRACT = 'clued.independent-ci.resident-backfill-manifest/1';
export const BACKFILL_MARKER = 'BACKFILL-COMPLETE.json';
export const ORIGINS = Object.freeze(['publication', 'backfill']);
// The files install-resident.ps1 carries from an earlier install's state (relative, forward slashes).
const HEAD_KEY = /^[0-9a-f]{32}$/;
export const CARRIED_FILE = /^(?:ledger-heads\/[0-9a-f]{64}\.json|ledger\/[0-9a-f]{64}\/(?:00-reserved|10-started|25-plan|80-owner-abort|90-terminal)\.json|executed-heads\/[0-9a-f]{32}\/(?:publication|backfill)-[0-9a-f]{16}\.json)$/;
// The directory a carried state is copied into: its position in the manifest, so every carried path stays far below
// the Windows path limit (260) the install's .NET file calls obey.
export const CARRIED_DIR = /^[1-9][0-9]{0,2}$/;
export const CARRIED_SOURCE = /^resident-uninstalled-[0-9A-Za-z-]{1,80}$/;
// The ledger records the verdict reads, by file name -> the name mayHavePublished uses.
const LEDGER_RECORDS = Object.freeze({ '00-reserved': 'reserved', '10-started': 'started', '25-plan': 'plan', '80-owner-abort': 'abort', '90-terminal': 'terminal' });
const UNREADABLE = Symbol('unreadable');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_MANIFEST = 32 * 1024 * 1024;
// Owner-abort safe points before any role check could have been published (executor.mjs#continueBatch order).
export const NOT_PUBLISHED_SAFE_POINTS = Object.freeze(['waiting', 'before-stage-1', 'before-relay-plan', 'before-workspace', 'before-stage-2', 'in-stage-2', 'before-stage-3']);

// 128 bits of the digest name the head's directory (and 64 bits of the batch key its record), so that every path,
// also a carried copy under state\backfill\<n>\, stays well below the Windows path limit.
// Merge train (DESIGN §41.4): a train front batch (a subject with S) is its own identity (H, S): its records live under a key
// that names S, so only that front batch's own publications make it "published", never a non-front run of H (nor the reverse).
// Every subject without S keeps its key.
const frontShaOk = s => !Object.hasOwn(s, 'testSha') || (typeof s.testSha === 'string' && HEX40.test(s.testSha) && s.testSha !== s.headSha);
export function executedHeadKey(subject) {
  const { repo, headSha } = subject ?? {};
  check(typeof repo === 'string' && REPO.test(repo) && typeof headSha === 'string' && HEX40.test(headSha) && frontShaOk(subject), 'EXECUTED_HEAD_SUBJECT_INVALID');
  return digest({ contract: EXECUTED_HEAD_KEY_CONTRACT, repo, headSha, ...(Object.hasOwn(subject, 'testSha') ? { testSha: subject.testSha } : {}) }).slice(0, 32);
}

// Pure: may the batch behind this burned head have published a role check? Conservative: anything not proven to have
// ended before the first publication stage counts as published.
//   head: the ledger-heads record ({ headKey, key, subject, burnedBy? }); entry: its ledger records
//   ({ reserved, started, plan, abort, terminal }, any of them null) or null when the entry is not there.
export function mayHavePublished(head, entry) {
  if (head?.burnedBy?.quarantine === true) return { published: true, basis: 'quarantined' };
  if (!entry) return { published: true, basis: 'ledger-entry-missing' };
  const t = entry.terminal;
  if (!t) return { published: true, basis: 'ledger-entry-open' };
  if (t.outcome === 'COMPLETED') return { published: true, basis: 'completed' };
  if (t.outcome !== 'FAILED_CLEAN') return { published: true, basis: t.outcome === 'FAILED_UNKNOWN' ? 'failed-unknown' : 'outcome-unrecognised' };
  if (Array.isArray(entry.plan?.relayed) && entry.plan.relayed.length > 0) return { published: true, basis: 'relayed' };
  const f = t.facts ?? {};
  if (f.failureCode === 'OWNER_ABORTED') {
    return NOT_PUBLISHED_SAFE_POINTS.includes(f.safePoint) ? { published: false, basis: `owner-aborted-${f.safePoint}` } : { published: true, basis: 'owner-aborted-after-publication-stage' };
  }
  return [0, 1, 2].includes(f.stage) ? { published: false, basis: `failed-clean-stage-${f.stage}` } : { published: true, basis: 'failed-clean-at-or-after-publication-stage' };
}

const contentError = error => error instanceof ResidentError || error instanceof SyntaxError;
const subjectOf = v => (v && typeof v === 'object' && typeof v.repo === 'string' && REPO.test(v.repo) && typeof v.headSha === 'string' && HEX40.test(v.headSha) && frontShaOk(v)) ? v : null;

export class ExecutedHeads {
  // carried: { manifestFile: <root>\install\backfill-manifest.json, carriedRoot: <root>\state\backfill } (the service's).
  constructor(stateRoot, clock, carried = {}) {
    this.stateRoot = stateRoot;
    this.dir = path.join(stateRoot, 'executed-heads');
    this.marker = path.join(this.dir, BACKFILL_MARKER);
    this.clock = clock;
    this.manifestFile = carried.manifestFile ?? null;
    this.carriedRoot = carried.carriedRoot ?? null;
  }

  static async open(stateRoot, clock = Date.now, carried = {}) {
    const e = new ExecutedHeads(stateRoot, clock, carried);
    await ensureDir(e.dir);
    return e;
  }

  headDir(subject) { return path.join(this.dir, executedHeadKey(subject)); }

  // Any record of this head, whatever Source or attempt wrote it, and also its directory alone (an interrupted write).
  async published(subject) { return exists(this.headDir(subject)); }

  // True only when the head's one record FILE is attempt 1's own, written first "before stage R" (batch key key1). A
  // record is create-only per (origin, batch key), so a later stage of the same attempt writes nothing new: this alone
  // cannot tell that stage R was the last publication stage. The executor therefore also requires attempt 1's ledger to
  // say so (executor.mjs#relayedNothing: FAILED_CLEAN at stage 0, 1 or 2 with a plan that relayed no role), as the
  // attempt 2 decision did (attempts.mjs; independent review of phase 1, MINOR 5). Anything unreadable is false.
  async onlyRelayRecordOf(subject, key1, relayStage) {
    try {
      const names = await fs.readdir(this.headDir(subject));
      if (typeof key1 !== 'string' || !HEX64.test(key1) || names.length !== 1 || names[0] !== `publication-${key1.slice(0, 16)}.json`) return false;
      const r = parseBoundedJson(await readBounded(path.join(this.headDir(subject), names[0]), MAX_RECORD, 'EXECUTED_HEADS_RECORD_UNREADABLE'), MAX_RECORD, 'EXECUTED_HEADS_RECORD_UNREADABLE');
      return r.contract === EXECUTED_HEAD_CONTRACT && r.origin === 'publication' && r.key === key1 && r.stage === relayStage && r.basis === `before-stage-${relayStage}`;
    } catch { return false; }
  }

  // Create-only and idempotent: an existing record of the same origin and batch key is the same record.
  async record(subject, { key, origin, basis, stage = null }) {
    check(ORIGINS.includes(origin) && typeof key === 'string' && HEX64.test(key) && typeof basis === 'string' && basis.length > 0 && basis.length <= 80, 'EXECUTED_HEAD_RECORD_INVALID');
    const dir = this.headDir(subject);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${origin}-${key.slice(0, 16)}.json`);
    if (await exists(file)) return false;
    await writeNew(file, { contract: EXECUTED_HEAD_CONTRACT, repo: subject.repo, headSha: subject.headSha, pr: Number.isSafeInteger(subject.pr) ? subject.pr : null,
      sourceManifestSha256: HEX64.test(subject.sourceManifestSha256 ?? '') ? subject.sourceManifestSha256 : null,
      attempt: Number.isSafeInteger(subject.attempt) ? subject.attempt : null, key, origin, basis, stage, at: isoNow(this.clock),
      // A front batch's record names its S, so the backfill of a later install files it under the same (H, S) key.
      ...(Object.hasOwn(subject, 'testSha') ? { testSha: subject.testSha } : {}) });
    return true;
  }

  async backfilled() { return exists(this.marker); }

  async readMarker() {
    if (!(await exists(this.marker))) return null;
    try { return parseBoundedJson(await readBounded(this.marker, 65536, 'EXECUTED_HEADS_MARKER_REFUSED'), 65536, 'EXECUTED_HEADS_MARKER_REFUSED'); } catch { return { contract: BACKFILL_MARKER_CONTRACT, unreadable: true }; }
  }

  // The install's list of carried files. Missing or malformed: no batch may run (the caller HALTs). Every listed file
  // must still be there with its listed SHA-256: anything else is evidence that the carried state changed.
  async carriedSources(manifestFile, carriedRoot) {
    if (!(await exists(manifestFile))) throw new ResidentError('EXECUTED_HEADS_BACKFILL_MANIFEST_MISSING');
    const m = parseBoundedJson(await readBounded(manifestFile, MAX_MANIFEST, 'EXECUTED_HEADS_BACKFILL_MANIFEST_REFUSED'), MAX_MANIFEST, 'EXECUTED_HEADS_BACKFILL_MANIFEST_REFUSED');
    check(m.contract === BACKFILL_MANIFEST_CONTRACT && Array.isArray(m.sources) && m.sources.length <= 256, 'EXECUTED_HEADS_BACKFILL_MANIFEST_REFUSED');
    const out = [];
    for (const [i, s] of m.sources.entries()) {
      // dir: where the install copied it (its 1-based position), name: the earlier install it came from.
      check(s && typeof s === 'object' && typeof s.name === 'string' && CARRIED_SOURCE.test(s.name) && s.dir === String(i + 1) && CARRIED_DIR.test(s.dir)
        && Array.isArray(s.files) && s.files.length <= 200_000 && !out.some(o => o.name === s.name)
        // heads (optional): the earlier state's executed-heads keys, also those whose directory holds no readable record
        && (s.heads === undefined || (Array.isArray(s.heads) && s.heads.length <= 200_000 && s.heads.every(k => typeof k === 'string' && HEAD_KEY.test(k)) && new Set(s.heads).size === s.heads.length)),
      'EXECUTED_HEADS_BACKFILL_MANIFEST_REFUSED');
      const files = new Map();
      for (const f of s.files) {
        check(f && typeof f === 'object' && typeof f.path === 'string' && CARRIED_FILE.test(f.path) && typeof f.sha256 === 'string' && HEX64.test(f.sha256)
          && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= MAX_RECORD && (f.bytes > 0 || f.sha256 === EMPTY_SHA256) && !files.has(f.path), 'EXECUTED_HEADS_BACKFILL_MANIFEST_REFUSED');
        files.set(f.path, f);
      }
      out.push({ name: s.name, root: path.join(carriedRoot, s.dir), files, keys: s.heads ?? [] });
    }
    return out;
  }

  // One carried file: its listed bytes, or a hard refusal (missing, replaced, changed).
  // A listed empty file (a record whose write was interrupted before its bytes; independent review of phase 1, MINOR 4)
  // is carried as it is and counted unreadable, as in the resident's own state; it must still be there and still empty.
  static async readCarried(source, rel) {
    const f = source.files.get(rel);
    if (f.bytes === 0) {
      let link;
      try { link = await fs.lstat(path.join(source.root, ...rel.split('/'))); } catch (error) { if (error?.code === 'ENOENT') throw new ResidentError('EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED', rel); throw error; }
      check(link.isFile() && !link.isSymbolicLink() && link.size === 0, 'EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED', rel);
      return UNREADABLE;
    }
    let bytes;
    try { bytes = await readBounded(path.join(source.root, ...rel.split('/')), MAX_RECORD, 'EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED'); }
    catch (error) { if (error instanceof ResidentError || error?.code === 'ENOENT') throw new ResidentError('EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED', rel); throw error; }
    check(bytes.length === f.bytes && sha256(bytes) === f.sha256, 'EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED', rel);
    return bytes;
  }

  // The resident's own ledger (the install's fresh state, or an older one): every record of the fixed shapes there is.
  // Its own executed-heads records are this store already.
  async ownFiles() {
    const files = [];
    const list = async rel => { try { return (await fs.readdir(path.join(this.stateRoot, ...rel.split('/')))).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
    for (const n of await list('ledger-heads')) if (CARRIED_FILE.test(`ledger-heads/${n}`)) files.push(`ledger-heads/${n}`);
    for (const k of await list('ledger')) if (HEX64.test(k)) for (const n of await list(`ledger/${k}`)) if (CARRIED_FILE.test(`ledger/${k}/${n}`)) files.push(`ledger/${k}/${n}`);
    return files;
  }

  // Reads one source into heads, ledger entries and executed records. A record whose bytes do not parse cannot name
  // its head: it is counted (unreadable) and skipped; the K(head, role) mutex of the publishers remains the last guard.
  // An executed-heads record is the exception: its directory already names the head (the key), so a carried key is kept
  // whether or not its record parses (an empty one from an interrupted write; independent re-review, MINOR-A).
  async readSource(source) {
    const paths = source.files ? [...source.files.keys()].sort() : await this.ownFiles();
    const heads = [], entries = new Map(), executed = [];
    const keys = new Set(source.files ? source.keys ?? [] : []);
    if (source.files) for (const rel of paths) { const [kind, k] = rel.split('/'); if (kind === 'executed-heads' && HEAD_KEY.test(k)) keys.add(k); }
    let unreadable = 0;
    for (const rel of paths) {
      const bytes = source.files ? await ExecutedHeads.readCarried(source, rel) : await readOwn(this.stateRoot, rel);
      if (bytes === null) continue;
      let value = null;
      if (bytes !== UNREADABLE) {
        try { value = parseBoundedJson(bytes, MAX_RECORD, 'EXECUTED_HEADS_RECORD_UNREADABLE'); } catch (error) { if (!contentError(error)) throw error; }
      }
      if (value === null) { unreadable += 1; continue; }
      const [kind, a, b] = rel.split('/');
      if (kind === 'ledger-heads') { if (subjectOf(value.subject) && HEX64.test(value.key ?? '')) heads.push(value); else unreadable += 1; }
      else if (kind === 'ledger') {
        if (!entries.has(a)) entries.set(a, {});
        entries.get(a)[LEDGER_RECORDS[b.replace(/\.json$/, '')]] = value;
      } else if (subjectOf(value) && HEX64.test(value.key ?? '')) executed.push(value);
      else unreadable += 1;
    }
    return { heads, entries, executed, keys: [...keys].sort(), unreadable };
  }

  // The backfill. Idempotent (create-only records; an interrupted run is simply repeated) and done when the marker is.
  async backfill({ manifestFile = this.manifestFile, carriedRoot = this.carriedRoot } = {}) {
    check(typeof manifestFile === 'string' && typeof carriedRoot === 'string', 'EXECUTED_HEADS_BACKFILL_MANIFEST_MISSING');
    const sources = [{ name: 'current', root: this.stateRoot, files: null }, ...await this.carriedSources(manifestFile, carriedRoot)];
    const summary = [], heads = new Set();
    let unreadable = 0;
    for (const source of sources) {
      const { heads: burned, entries, executed, keys, unreadable: bad } = await this.readSource(source);
      const mine = new Set();
      const keep = async (subject, key, basis) => {
        await this.record(subject, { key, origin: 'backfill', basis: `${source.name === 'current' ? 'current' : 'carried'}:${basis}`.slice(0, 80) });
        mine.add(executedHeadKey(subject)); heads.add(executedHeadKey(subject));
      };
      for (const head of burned) {
        const verdict = mayHavePublished(head, entries.get(head.key) ?? null);
        if (verdict.published) await keep(head.subject, head.key, verdict.basis);
      }
      for (const x of executed) await keep(x, x.key, 'executed-head');
      // Every carried key, readable or not, is a head that may have published: its directory is the record.
      for (const k of keys) { await fs.mkdir(path.join(this.dir, k), { recursive: true }); mine.add(k); heads.add(k); }
      unreadable += bad;
      summary.push({ name: source.name, heads: burned.length, entries: entries.size, executed: executed.length, keys: keys.length, published: mine.size, unreadable: bad });
    }
    // published: distinct heads (repo, head) the store holds from this backfill.
    const marker = { contract: BACKFILL_MARKER_CONTRACT, at: isoNow(this.clock), sources: summary, published: heads.size, unreadable };
    await writeNew(this.marker, marker);
    return marker;
  }
}

// A record of the resident's own state: its bytes, null when it vanished, UNREADABLE when its shape is refused (a link,
// extra hard links, a size out of bounds). Any other I/O error propagates (transient: the next tick tries again).
async function readOwn(root, rel) {
  try { return await readBounded(path.join(root, ...rel.split('/')), MAX_RECORD, 'EXECUTED_HEADS_RECORD_UNREADABLE'); }
  catch (error) { if (error?.code === 'ENOENT') return null; if (error instanceof ResidentError) return UNREADABLE; throw error; }
}
