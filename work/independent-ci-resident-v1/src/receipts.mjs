// Append-only, hash-chained audit receipts. Each receipt names the SHA-256 of the previous
// receipt's exact bytes, so removing, reordering or editing one breaks verification.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE, check, isoNow, sha256 } from './canonical.mjs';
import { ensureDir, writeNew } from './store.mjs';

export const RECEIPT_CONTRACT = 'clued.independent-ci.resident-receipt/1';
// Stage R receipt types (free-minutes design S22). Bodies carry the batch key, the role and, for a local
// fallback, the stable reason (a RELAY_NOT_ATTESTED_* code of stage R or a resident scheduling reason).
export const RELAY_RECEIPTS = Object.freeze({ attested: 'relay-attested', localFallback: 'relay-local-fallback', billingRefused: 'relay-billing-refused',
  lateIgnored: 'relay-late-ignored' });
const NAME = /^(\d{8})-([a-z0-9-]{1,48})\.json$/;
const GENESIS = '0'.repeat(64);

export class ReceiptChain {
  constructor(dir, clock) { this.dir = dir; this.clock = clock; }

  static async open(dir, clock = Date.now) {
    await ensureDir(dir);
    const chain = new ReceiptChain(dir, clock);
    await chain.verify();
    return chain;
  }

  async entries() {
    const names = (await fs.readdir(this.dir)).filter(n => !n.startsWith('.')).sort();
    return names.map(name => {
      const m = NAME.exec(name);
      check(m, 'RECEIPT_NAME_UNEXPECTED', name);
      return { name, seq: Number(m[1]), type: m[2] };
    });
  }

  // The newest receipts of the given types (newest last), at most `limit`, with their contents (stage 10's
  // bookkeeping, executor.mjs#trainRecover). Reads only the picked files.
  async latest(types, limit) {
    check(Number.isSafeInteger(limit) && limit > 0, 'RECEIPT_LIMIT_INVALID');
    const picked = (await this.entries()).filter(e => types.includes(e.type)).slice(-limit);
    const out = [];
    for (const e of picked) out.push({ ...e, value: JSON.parse(await fs.readFile(path.join(this.dir, e.name), 'utf8')) });
    return out;
  }

  // Verify the whole chain and return its head; any gap, edit or foreign file fails closed.
  async verify() {
    let prev = GENESIS;
    let seq = 0;
    for (const entry of await this.entries()) {
      seq += 1;
      check(entry.seq === seq, 'RECEIPT_SEQUENCE_GAP', entry.name);
      const bytes = await fs.readFile(path.join(this.dir, entry.name));
      const value = JSON.parse(bytes.toString('utf8'));
      check(value.contract === RECEIPT_CONTRACT && value.seq === seq && value.type === entry.type, 'RECEIPT_SHAPE_CHANGED', entry.name);
      check(value.prevSha256 === prev, 'RECEIPT_CHAIN_BROKEN', entry.name);
      prev = sha256(bytes);
    }
    this.head = { seq, sha256: prev };
    return this.head;
  }

  // The head is re-derived from the last file on every append, so an append by another process
  // (or a crash between write and cache update) can never make this one collide or fork the chain.
  async currentHead() {
    const entries = await this.entries();
    if (entries.length === 0) return { seq: 0, sha256: GENESIS };
    const last = entries[entries.length - 1];
    check(last.seq === entries.length, 'RECEIPT_SEQUENCE_GAP', last.name);
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
