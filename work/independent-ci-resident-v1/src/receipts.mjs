// Append-only, hash-chained audit receipts. Each receipt names the SHA-256 of the previous
// receipt's exact bytes, so removing, reordering or editing one breaks verification.
//
// Segments by month (merge train step 3c-2b, DESIGN §41.7, §22.5): the receipt contract, the names and the global sequence are
// unchanged, and the open segment stays where every receipt always was, flat in receipts\ (the upgrader's frozen reader, the
// tools and the Owner find the newest receipts there as before). At the service's start (open with { seal: true }) the receipts
// of the months before the current one are closed: one seal, create-only, in receipts\index\<nnnn>.json, then each of those
// files renamed (never copied or rewritten) into receipts\archive\<nnnn>-<yyyy-mm>\ under its own name. A seal names its
// segment's month, first and last sequence, its count, the SHA-256 of its last receipt's bytes (what the next receipt chains
// from) and the SHA-256 of the previous seal's bytes, so the seals form a chain of their own. A start then reads only the
// seals and the open segment (verify); verifyAll also reads every archived segment against its seal. Old receipts stay
// readable: a chain from before segmentation is simply an open segment, closed at the first start in a later month; a receipt
// keeps its name and bytes wherever it lies; latest() looks in the open segment first and in the archive only when it needs
// more. A start interrupted between a seal and its renames finishes the renames (files of a sealed range left in receipts\);
// a reader that does not seal skips them without moving anything.
// Documented residual (review R3 MINOR 2): "by month" is "at a start, the prefix of months before the current one": the first start
// of an installed node seals all its past months as one segment (named by the last), and a service that runs across a month end
// seals at its next start; a start reads the seals and the open segment, which a monthly restart (Windows updates) keeps short.
// The way back to a package from before segmentation is tools/receipts-unseal.mjs (review R3 M7).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE, check, isoNow, sha256 } from './canonical.mjs';
import { ensureDir, exists, writeNew, writeNewAtomic } from './store.mjs';

export const RECEIPT_CONTRACT = 'clued.independent-ci.resident-receipt/1';
export const RECEIPT_SEAL_CONTRACT = 'clued.independent-ci.resident-receipt-seal/1';
export const INDEX_DIR = 'index';
export const ARCHIVE_DIR = 'archive';
// Stage R receipt types (free-minutes design S22). Bodies carry the batch key, the role and, for a local
// fallback, the stable reason (a RELAY_NOT_ATTESTED_* code of stage R or a resident scheduling reason).
export const RELAY_RECEIPTS = Object.freeze({ attested: 'relay-attested', localFallback: 'relay-local-fallback', billingRefused: 'relay-billing-refused',
  lateIgnored: 'relay-late-ignored' });
const NAME = /^(\d{8})-([a-z0-9-]{1,48})\.json$/;
const SEAL = /^(\d{4})\.json$/;
const SEGMENT = /^(\d{4})-(\d{4}-\d{2})$/;
const GENESIS = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const month = at => (typeof at === 'string' && /^\d{4}-\d{2}/.test(at) ? at.slice(0, 7) : null);
const named = list => list.map(name => { const m = NAME.exec(name); check(m, 'RECEIPT_NAME_UNEXPECTED', name); return { name, seq: Number(m[1]), type: m[2] }; });

export class ReceiptChain {
  constructor(dir, clock) { this.dir = dir; this.clock = clock; }

  // seal: close the months before the current one (the service's start only; tools read without it).
  static async open(dir, clock = Date.now, { seal = false } = {}) {
    await ensureDir(dir);
    const chain = new ReceiptChain(dir, clock);
    await chain.verify({ repair: seal });
    if (seal) await chain.sealPast();
    return chain;
  }

  // Every receipt file in receipts\ itself, oldest first (the open segment, and a sealed range a start left half moved).
  async files() {
    return named((await fs.readdir(this.dir, { withFileTypes: true }))
      .filter(e => !e.name.startsWith('.') && !(e.isDirectory() && [INDEX_DIR, ARCHIVE_DIR].includes(e.name))).map(e => e.name).sort());
  }

  // The open segment's receipts, oldest first.
  async entries() {
    const base = ReceiptChain.base(await this.knownSeals());
    return (await this.files()).filter(e => e.seq > base.seq);
  }

  // The seals, oldest first, each { no, seal, sha256, segment }, the seal chain checked (contract, numbering, ranges, links).
  async seals() {
    const dir = path.join(this.dir, INDEX_DIR);
    let names = [];
    try { names = (await fs.readdir(dir)).filter(n => !n.startsWith('.')).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const out = [];
    let prev = { sha256: GENESIS, lastSeq: 0 };
    for (const name of names) {
      const m = SEAL.exec(name);
      check(m && Number(m[1]) === out.length + 1, 'RECEIPT_SEAL_UNEXPECTED', name);
      const bytes = await fs.readFile(path.join(dir, name));
      const s = JSON.parse(bytes.toString('utf8'));
      check(s && s.contract === RECEIPT_SEAL_CONTRACT && s.no === out.length + 1 && s.prevSealSha256 === prev.sha256 && s.firstSeq === prev.lastSeq + 1
        && Number.isSafeInteger(s.lastSeq) && s.lastSeq >= s.firstSeq && s.count === s.lastSeq - s.firstSeq + 1 && HEX64.test(s.headSha256 ?? '') && /^\d{4}-\d{2}$/.test(s.month ?? ''),
      'RECEIPT_SEAL_INVALID', name);
      out.push({ no: s.no, seal: s, sha256: sha256(bytes), segment: `${String(s.no).padStart(4, '0')}-${s.month}` });
      prev = { sha256: out.at(-1).sha256, lastSeq: s.lastSeq };
    }
    return out;
  }

  // The seals as this chain last read or wrote them (only a start seals, so they do not change under an open chain).
  async knownSeals() { return (this.sealsKnown ??= await this.seals()); }

  // Where the open segment starts: the last seal's head, or the genesis.
  static base(seals) { const s = seals.at(-1)?.seal; return s ? { seq: s.lastSeq, sha256: s.headSha256 } : { seq: 0, sha256: GENESIS }; }

  // Files of a sealed range still in receipts\ are moved into their segment (rename only, never over a file).
  async finishMoves(seals, files) {
    for (const e of files) {
      const owner = seals.find(s => e.seq >= s.seal.firstSeq && e.seq <= s.seal.lastSeq);
      if (!owner) continue;
      const target = path.join(this.dir, ARCHIVE_DIR, owner.segment);
      await ensureDir(target);
      check(!(await exists(path.join(target, e.name))), 'RECEIPT_ARCHIVE_TARGET_EXISTS', e.name);
      await fs.rename(path.join(this.dir, e.name), path.join(target, e.name));
    }
  }

  // Verify the seals and the open segment and return the head; any gap, edit or foreign file fails closed. The archived
  // segments are not read (verifyAll does). repair: finish the renames of an interrupted seal first.
  async verify({ repair = false } = {}) {
    const seals = this.sealsKnown = await this.seals();
    if (repair) await this.finishMoves(seals, await this.files());
    const head = await this.verifyRun(this.dir, await this.entries(), ReceiptChain.base(seals));
    this.head = { seq: head.seq, sha256: head.sha256 };
    return this.head;
  }

  // Everything, also every archived segment against its seal (the Owner's tools).
  async verifyAll() {
    let base = { seq: 0, sha256: GENESIS };
    for (const s of await this.seals()) {
      const dir = path.join(this.dir, ARCHIVE_DIR, s.segment);
      let names = [];
      try { names = (await fs.readdir(dir)).filter(n => !n.startsWith('.')).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // A segment whose renames a start did not finish yet still has its rest in receipts\.
      const entries = [...named(names).map(e => ({ ...e, dir })), ...(await this.files()).filter(e => e.seq >= s.seal.firstSeq && e.seq <= s.seal.lastSeq).map(e => ({ ...e, dir: this.dir }))]
        .sort((a, b) => a.seq - b.seq);
      check(entries.length === s.seal.count, 'RECEIPT_SEGMENT_INCOMPLETE', s.segment);
      let h = base;
      for (const e of entries) h = await this.verifyRun(e.dir, [e], h);
      check(h.seq === s.seal.lastSeq && h.sha256 === s.seal.headSha256, 'RECEIPT_SEGMENT_CHANGED', s.segment);
      base = { seq: h.seq, sha256: h.sha256 };
    }
    return this.verify();
  }

  // One run of receipts in order from base; entries gain their month (of `at`).
  async verifyRun(dir, entries, base) {
    let prev = base.sha256, seq = base.seq;
    for (const entry of entries) {
      seq += 1;
      check(entry.seq === seq, 'RECEIPT_SEQUENCE_GAP', entry.name);
      const bytes = await fs.readFile(path.join(dir, entry.name));
      const value = JSON.parse(bytes.toString('utf8'));
      check(value.contract === RECEIPT_CONTRACT && value.seq === seq && value.type === entry.type, 'RECEIPT_SHAPE_CHANGED', entry.name);
      check(value.prevSha256 === prev, 'RECEIPT_CHAIN_BROKEN', entry.name);
      prev = sha256(bytes);
      entry.month = month(value.at);
    }
    return { seq, sha256: prev };
  }

  // The service's start: the leading receipts of the open segment from months before the current one become one sealed
  // segment (named by the month of its last receipt). The current month always stays open.
  async sealPast() {
    const now = month(isoNow(this.clock));
    const seals = await this.seals();
    const entries = await this.entries();
    await this.verifyRun(this.dir, entries, ReceiptChain.base(seals));
    let n = 0;
    while (n < entries.length && entries[n].month !== null && entries[n].month < now) n += 1;
    if (n === 0) return null;
    const closing = entries.slice(0, n), last = closing.at(-1), no = seals.length + 1;
    const seal = { contract: RECEIPT_SEAL_CONTRACT, no, month: last.month, firstSeq: closing[0].seq, lastSeq: last.seq, count: closing.length,
      headSha256: sha256(await fs.readFile(path.join(this.dir, last.name))), prevSealSha256: seals.at(-1)?.sha256 ?? GENESIS, sealedAt: isoNow(this.clock) };
    await ensureDir(path.join(this.dir, INDEX_DIR));
    // Atomic (review R3 MINOR 1): a power loss leaves either no seal or the whole one, never an empty index\<nnnn>.json that
    // seals() could not read (a temporary .tmp- file is no seal: seals() skips dot names).
    await writeNewAtomic(path.join(this.dir, INDEX_DIR, `${String(no).padStart(4, '0')}.json`), seal);
    this.sealsKnown = await this.seals();
    await this.finishMoves(this.sealsKnown, closing);
    return seal;
  }

  // The archived segments, newest first: [{ dir, entries }] (names only).
  async archived() {
    const root = path.join(this.dir, ARCHIVE_DIR);
    let names = [];
    try { names = (await fs.readdir(root)).filter(n => SEGMENT.test(n)).sort().reverse(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const out = [];
    for (const name of names) {
      const dir = path.join(root, name);
      out.push({ dir, entries: (await fs.readdir(dir)).map(n => NAME.exec(n)).filter(Boolean).map(m => ({ name: m[0], seq: Number(m[1]), type: m[2] })).sort((a, b) => a.seq - b.seq) });
    }
    return out;
  }

  // The newest receipts of the given types (newest last), at most `limit`, with their contents (stage 10's
  // bookkeeping, executor.mjs#trainRecover). Reads only the picked files; the archive only when the open segment has too few.
  async latest(types, limit) {
    check(Number.isSafeInteger(limit) && limit > 0, 'RECEIPT_LIMIT_INVALID');
    let picked = (await this.entries()).filter(e => types.includes(e.type)).slice(-limit).map(e => ({ ...e, dir: this.dir }));
    if (picked.length < limit) {
      for (const seg of await this.archived()) {
        picked = [...seg.entries.filter(e => types.includes(e.type)).map(e => ({ ...e, dir: seg.dir })), ...picked].slice(-limit);
        if (picked.length >= limit) break;
      }
    }
    const out = [];
    for (const { dir, ...e } of picked) out.push({ ...e, value: JSON.parse(await fs.readFile(path.join(dir, e.name), 'utf8')) });
    return out;
  }

  // The head is re-derived from the last file on every append, so an append by another process
  // (or a crash between write and cache update) can never make this one collide or fork the chain.
  async currentHead() {
    const base = ReceiptChain.base(await this.knownSeals());
    const entries = (await this.files()).filter(e => e.seq > base.seq);
    if (entries.length === 0) return base;
    const last = entries[entries.length - 1];
    check(last.seq === base.seq + entries.length, 'RECEIPT_SEQUENCE_GAP', last.name);
    return { seq: last.seq, sha256: sha256(await fs.readFile(path.join(this.dir, last.name))) };
  }

  async append(type, body) {
    check(/^[a-z0-9-]{1,48}$/.test(type), 'RECEIPT_TYPE_INVALID');
    if (body && body.failureCode !== undefined && body.failureCode !== null) check(CODE.test(body.failureCode), 'RECEIPT_FAILURE_CODE_INVALID');
    const head = await this.currentHead();
    const seq = head.seq + 1;
    const value = { contract: RECEIPT_CONTRACT, seq, type, at: isoNow(this.clock), prevSha256: head.sha256, body };
    const file = path.join(this.dir, `${String(seq).padStart(8, '0')}-${type}.json`);
    const fileSha = await writeNew(file, value);
    this.head = { seq, sha256: fileSha };
    return { seq, sha256: fileSha, file };
  }
}
