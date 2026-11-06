// Sweep records of stage 10 (step 3c-2b; DESIGN §41.2, §41.3, §41.6): create-only files under state\v2\train-sweep
// (clued-control only, acl-model.json). Same write discipline as the green ledger and the shadow records: written whole
// under a temporary name, synced, hard-linked into place (a link never replaces a file), the temporary name removed.
//   proof-<ms>-<runId>-<nonce>.json       clued.independent-ci.train-sweep-proof/1: what one run proved about the front
//                                         (stage 8's trainHeadReady reads the newest: INTERFACES §4)
//   full-<mode>-<ms>-<runId>-<nonce>.json clued.independent-ci.train-full-sweep/1: the incremental cursor and the
//                                         segmented full sweep of one mode (shadow sweeps never count for on)
//   front-<ms>-<runId>-<nonce>.json       clued.independent-ci.train-front-batch/1: one front batch this node opened
//                                         (at most two per head, §41.4; T, S and S's tree for the landing check)
// A reader takes the newest valid record of a kind; a file of these names that is not exactly a record is ignored and
// counted (`torn`; `refused` only for proofs and front batches newer than the newest valid proof); any other name is
// ignored (`foreign`). No credential, no GitHub, no Native.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical } from '../proof.mjs';

export const SWEEP_PROOF_CONTRACT = 'clued.independent-ci.train-sweep-proof/1';
export const FULL_SWEEP_CONTRACT = 'clued.independent-ci.train-full-sweep/1';
export const FRONT_BATCH_CONTRACT = 'clued.independent-ci.train-front-batch/1';
export const PROOF_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', 'mode', 'pr', 'headSha', 'claimId', 'since', 'mainSha', 'clean', 'unconfirmed',
  'fullSweepSinceOn', 'slotHardCapMinutes', 'sweepFreshMs', 'prUpdatedCursor']);
// Generation 15 (DESIGN 60): the state also records the main tip this run saw (mainSha) and whether main was rewritten since a
// round enumerated everything (mainRewritten); a round records what it enumerates (scope 'all': every pull and commit, the
// enumeration before generation 15; 'current': open pulls whole, closed unmerged heads) and why (scopeReason). A record
// written before generation 15 has none of them: it reads as mainSha null, mainRewritten false and a round of scope 'all'.
export const FULL_SWEEP_FIELDS_V1 = Object.freeze(['contract', 'writtenAt', 'runId', 'mode', 'incrementalCursor', 'full', 'inMain']);
export const FULL_SWEEP_FIELDS = Object.freeze([...FULL_SWEEP_FIELDS_V1, 'mainSha', 'mainRewritten']);
export const FULL_FIELDS_V1 = Object.freeze(['state', 'via', 'startedAt', 'completedAt', 'onSince', 'mainSha', 'nextPage', 'nextIndex', 'prs', 'commits', 'heads',
  'revoked', 'unconfirmed', 'wouldRevoke', 'calls', 'ms', 'reason']);
export const FULL_FIELDS = Object.freeze([...FULL_FIELDS_V1, 'scope', 'scopeReason']);
export const FULL_SCOPES = Object.freeze(['all', 'current']);
export const FRONT_BATCH_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', 'pr', 'headSha', 'baseSha', 'testSha', 'testTree', 'claimId', 'since', 'attempt']);
export const FULL_STATES = Object.freeze(['none', 'running', 'complete', 'abandoned']);
// Heads known to be in main (never revoked, never listed again): bounded, newest kept.
export const MAX_IN_MAIN = 2000;
const RUN_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/, SHA = /^[0-9a-f]{40}$/, CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const NAME = /^(proof|full-shadow|full-on|front)-(\d{13})-([0-9a-f]{16}-[0-9a-f]{12})-[0-9a-f]{8}\.json$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const exact = (o, fields) => plain(o) && Object.keys(o).length === fields.length && fields.every(k => Object.hasOwn(o, k));
const count = v => Number.isSafeInteger(v) && v >= 0;

// The front (pr, headSha, claimId, since) is all null when the run had no single open front; a revoke-only proof may lack
// `since` (no batch follows it). Stage 8 accepts only mode 'on' with its own front.
export function validateSweepProof(p) {
  const front = (p?.pr === null && p.headSha === null && p.claimId === null && p.since === null)
    || (Number.isSafeInteger(p?.pr) && p.pr > 0 && SHA.test(p.headSha ?? '') && UUID.test(p.claimId ?? '') && (iso(p.since) || (p.mode === 'revoke-only' && p.since === null)));
  if (!exact(p, PROOF_FIELDS) || p.contract !== SWEEP_PROOF_CONTRACT || !iso(p.writtenAt) || !RUN_ID.test(p.runId ?? '') || !['on', 'revoke-only'].includes(p.mode)
    || !front || !SHA.test(p.mainSha ?? '')
    || typeof p.clean !== 'boolean' || !count(p.unconfirmed) || (p.clean && p.unconfirmed !== 0) || typeof p.fullSweepSinceOn !== 'boolean'
    || !Number.isSafeInteger(p.slotHardCapMinutes) || p.slotHardCapMinutes < 60 || p.slotHardCapMinutes > 180
    || !Number.isSafeInteger(p.sweepFreshMs) || p.sweepFreshMs < 60_000 || p.sweepFreshMs > 3_600_000 || !iso(p.prUpdatedCursor)) fail('invalid_train_sweep_proof');
  return p;
}

export function validateFullSweep(s) {
  const f = s?.full;
  const v1 = exact(s, FULL_SWEEP_FIELDS_V1) && exact(f, FULL_FIELDS_V1);
  const v2 = exact(s, FULL_SWEEP_FIELDS) && exact(f, FULL_FIELDS) && (s.mainSha === null || SHA.test(s.mainSha)) && typeof s.mainRewritten === 'boolean'
    && FULL_SCOPES.includes(f.scope) && (f.scopeReason === null || CODE.test(f.scopeReason));
  if (!(v1 || v2) || s.contract !== FULL_SWEEP_CONTRACT || !iso(s.writtenAt) || !RUN_ID.test(s.runId ?? '') || !['shadow', 'on'].includes(s.mode)
    || !(s.incrementalCursor === null || iso(s.incrementalCursor)) || !FULL_STATES.includes(f.state)
    || !(f.via === null || ['sweep', 'watermark'].includes(f.via)) || !(f.startedAt === null || iso(f.startedAt)) || !(f.completedAt === null || iso(f.completedAt))
    || !(f.onSince === null || iso(f.onSince)) || !(f.mainSha === null || SHA.test(f.mainSha)) || !Number.isSafeInteger(f.nextPage) || f.nextPage < 1
    || !['nextIndex', 'prs', 'commits', 'heads', 'revoked', 'unconfirmed', 'wouldRevoke', 'calls', 'ms'].every(k => count(f[k]))
    || !(f.reason === null || CODE.test(f.reason)) || (f.state === 'complete') !== (f.completedAt !== null) || (f.state !== 'none' && f.startedAt === null)
    || !Array.isArray(s.inMain) || s.inMain.length > MAX_IN_MAIN || !s.inMain.every(h => SHA.test(h ?? ''))) fail('invalid_train_full_sweep');
  return s;
}

export function validateFrontBatch(r) {
  if (!exact(r, FRONT_BATCH_FIELDS) || r.contract !== FRONT_BATCH_CONTRACT || !iso(r.writtenAt) || !RUN_ID.test(r.runId ?? '') || !Number.isSafeInteger(r.pr) || r.pr < 1
    || !['headSha', 'baseSha', 'testSha', 'testTree'].every(k => SHA.test(r[k] ?? '')) || !UUID.test(r.claimId ?? '') || !iso(r.since) || ![1, 2].includes(r.attempt)) fail('invalid_train_front_batch');
  return r;
}

const KIND = { proof: [SWEEP_PROOF_CONTRACT, validateSweepProof], 'full-shadow': [FULL_SWEEP_CONTRACT, validateFullSweep], 'full-on': [FULL_SWEEP_CONTRACT, validateFullSweep],
  front: [FRONT_BATCH_CONTRACT, validateFrontBatch] };

export class TrainSweepStore {
  static async open(directory) {
    const resolved = path.resolve(directory);
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    for (let current = resolved; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_train_sweep_directory');
      if (current === path.dirname(current)) break;
    }
    return new TrainSweepStore(resolved);
  }
  constructor(directory) { this.directory = directory; this.tornNames = new Map(); this.foreignNames = new Set(); this.newestProofMs = null; }
  // Stage 8's "no newer proof was replaced by an older one" (review R1 m3): the torn proof and front-batch files (a name of
  // this store that is not exactly its record) newer than the newest valid proof read so far, or all of them before any.
  // A name that is not one of this store's (desktop.ini, a stray copy) never counts: it is listed in `foreign` only.
  get refused() {
    return [...this.tornNames.values()].filter(t => ['proof', 'front'].includes(t.kind) && (this.newestProofMs === null || t.ms > this.newestProofMs)).length;
  }
  get foreign() { return this.foreignNames.size; }
  get torn() { return this.tornNames.size; }
  async write(kind, record) {
    if (!Object.hasOwn(KIND, kind)) fail('invalid_train_sweep_record');
    KIND[kind][1](record);
    const name = `${kind}-${String(Date.parse(record.writtenAt)).padStart(13, '0')}-${record.runId}-${randomBytes(4).toString('hex')}.json`;
    const temporary = path.join(this.directory, `${name}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(canonical(record)); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, path.join(this.directory, name));
    await fs.unlink(temporary).catch(() => { /* a leftover temporary file is ignored by readers */ });
    return name;
  }
  // Valid records of one kind, newest first; stops after `limit`.
  async read(kind, limit = Infinity, accept = () => true) {
    const out = [];
    for (const name of (await fs.readdir(this.directory)).sort().reverse()) {
      if (name.endsWith('.tmp')) continue;
      const parts = NAME.exec(name);
      if (!parts) { this.foreignNames.add(name); continue; }
      if (parts[1] !== kind) continue;
      try {
        const file = path.join(this.directory, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail('unsafe_train_sweep_record');
        const text = await fs.readFile(file, 'utf8'), record = KIND[kind][1](JSON.parse(text));
        if (canonical(record) !== text || Date.parse(record.writtenAt) !== Number(parts[2]) || record.runId !== parts[3]) fail('invalid_train_sweep_record');
        if (!accept(record)) continue;
        out.push(record);
        if (out.length >= limit) break;
      } catch { this.tornNames.set(name, { kind, ms: Number(parts[2]) }); }
    }
    return out;
  }
  async appendProof(p) { return this.write('proof', { contract: SWEEP_PROOF_CONTRACT, ...p }); }
  async latestProof() {
    const p = (await this.read('proof', 1))[0] ?? null;
    if (p) this.newestProofMs = Date.parse(p.writtenAt);
    return p;
  }
  // mode: 'on' (also the revoke-only runs' incremental cursor) or 'shadow'.
  async readFullSweep(mode = 'on') { return (await this.read(`full-${mode}`, 1))[0] ?? null; }
  async writeFullSweep(s) { return this.write(`full-${s?.mode}`, { contract: FULL_SWEEP_CONTRACT, ...s, inMain: (s?.inMain ?? []).slice(-MAX_IN_MAIN) }); }
  async appendFrontBatch(r) { return this.write('front', { contract: FRONT_BATCH_CONTRACT, ...r }); }
  // This node's front batches of one head, newest first.
  async frontBatches({ pr, headSha }) { return this.read('front', Infinity, r => r.pr === pr && r.headSha === headSha); }
}
