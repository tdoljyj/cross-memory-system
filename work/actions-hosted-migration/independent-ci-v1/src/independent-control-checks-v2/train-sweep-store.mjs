// Sweep records of stage 10 (step 3c-2b; DESIGN §41.2, §41.3, §41.6): create-only files under state\v2\train-sweep
// (clued-control only, acl-model.json). Same write discipline as the green ledger and the shadow records: written whole
// under a temporary name, synced, hard-linked into place (a link never replaces a file), the temporary name removed.
//   proof-<ms>-<runId>-<nonce>.json       clued.independent-ci.train-sweep-proof/1: what one run proved about the front
//                                         (stage 8's trainHeadReady reads the newest: INTERFACES §4)
//   full-<mode>-<ms>-<runId>-<nonce>.json clued.independent-ci.train-full-sweep/1: the incremental cursor and the
//                                         segmented full sweep of one mode (shadow sweeps never count for on)
//   front-<ms>-<runId>-<nonce>.json       clued.independent-ci.train-front-batch/1: one front batch this node opened
//                                         (at most two per head, §41.4; T, S and S's tree for the landing check)
//   strict-proof-<ms>-<runId>-<nonce>.json limited non-front coverage; never a v1 full-sweep proof or cross-epoch authority
//   strict-round-<ms>-<runId>-<nonce>.json independent coverage cursor, including unresolved two-readback revocations
//   strict-front-proof-<ms>-<runId>-<nonce>.json current subject only; explicitly no historical coverage
//   pending-revocations-<ms>-<runId>-<nonce>.json bounded exact-ID negative intents, preserved across duty/Source changes;
//                                         an old count without IDs stays latched until a real complete all round
//   landing-batch-<ms>-<runId>-<nonce>.json clued.independent-ci.train-landing-batch/1 (push mode, resident ADR 0018 §3): one batch
//                                         this node opened: T, S, S's tree and the members in batch order (the front first)
//   landing-state-<ms>-<runId>-<nonce>.json clued.independent-ci.train-landing-state/1: the riders kept out (bad heads), the bisection
//                                         suspect, the batches whose members were all adopted and the failures already handled
// Legacy readers take the newest valid record and count unreadable names (`torn`; `refused` for newer proofs/fronts).
// Strict readers refuse a torn record at or after the newest valid timestamp, and refuse contradictory valid records
// at that timestamp: neither a run id nor a nonce proves ordering. Unknown pending state is never silently discarded.
// Other names are ignored (`foreign`). No credential, no GitHub, no Native.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical } from '../proof.mjs';
import { MAX_BAD, MAX_ADOPTED, BATCH_MAX_LIMIT } from './train-landing.mjs';
import { STRICT_PROOF_CONTRACT, STRICT_ROUND_CONTRACT, STRICT_FRONT_PROOF_CONTRACT, validateStrictProof, validateStrictRound, validateStrictFrontProof, sameStrictIdentity } from './train-strict.mjs';
import { SCAN_CONTRACT, validateScanProgress } from './train-scan-progress.mjs';

export const SWEEP_PROOF_CONTRACT = 'clued.independent-ci.train-sweep-proof/1';
export const FULL_SWEEP_CONTRACT = 'clued.independent-ci.train-full-sweep/1';
export const FRONT_BATCH_CONTRACT = 'clued.independent-ci.train-front-batch/1';
export const PENDING_REVOCATIONS_CONTRACT = 'clued.independent-ci.pending-revocations/1';
export const LANDING_BATCH_CONTRACT = 'clued.independent-ci.train-landing-batch/1';
export const LANDING_STATE_CONTRACT = 'clued.independent-ci.train-landing-state/1';
export const LANDING_BATCH_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', 'frontPr', 'frontHeadSha', 'baseSha', 'testSha', 'testTree', 'attempt', 'members']);
export const LANDING_STATE_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', 'bad', 'suspect', 'adopted', 'handled']);
export const PROOF_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', 'mode', 'pr', 'headSha', 'claimId', 'since', 'mainSha', 'clean', 'unconfirmed',
  'fullSweepSinceOn', 'slotHardCapMinutes', 'sweepFreshMs', 'prUpdatedCursor']);
// Generation 15 (DESIGN 60): the state also records the main tip this run saw (mainSha) and why rounds enumerate everything until
// one of scope 'all' completes (allPending: TRAIN_MAIN_REWRITTEN, TRAIN_NO_MAIN_RECORD, or null); a round records what it
// enumerates (scope 'all': every pull and commit, the enumeration before generation 15; 'current': open pulls whole, closed
// unmerged heads) and why (scopeReason). A record written before generation 15 has none of them: it reads as mainSha null,
// allPending null and a round of scope 'all'.
export const FULL_SWEEP_FIELDS_V1 = Object.freeze(['contract', 'writtenAt', 'runId', 'mode', 'incrementalCursor', 'full', 'inMain']);
export const FULL_SWEEP_FIELDS = Object.freeze([...FULL_SWEEP_FIELDS_V1, 'mainSha', 'allPending']);
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
const NAME = /^(scan-on|scan-shadow|scan-strict|landing-batch|landing-state|pending-revocations|strict-front-proof|strict-proof|strict-round|proof|full-shadow|full-on|front)-(\d{13})-([0-9a-f]{16}-[0-9a-f]{12})-[0-9a-f]{8}\.json$/;
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
  const v2 = exact(s, FULL_SWEEP_FIELDS) && exact(f, FULL_FIELDS) && (s.mainSha === null || SHA.test(s.mainSha)) && (s.allPending === null || CODE.test(s.allPending))
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

export function validatePendingRevocations(r) {
  if (!exact(r, ['contract', 'writtenAt', 'runId', 'repo', 'targets', 'legacyUnconfirmed', 'legacySince']) || r.contract !== PENDING_REVOCATIONS_CONTRACT
    || !iso(r.writtenAt) || !RUN_ID.test(r.runId ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo ?? '')
    || !count(r.legacyUnconfirmed) || !(r.legacyUnconfirmed === 0 ? r.legacySince === null : iso(r.legacySince))
    || !Array.isArray(r.targets) || r.targets.length > 20 || new Set(r.targets.map(t => t?.checkRunId)).size !== r.targets.length
    || !r.targets.every(t => exact(t, ['checkRunId', 'headSha', 'reason', 'own']) && Number.isSafeInteger(t.checkRunId) && t.checkRunId > 0
      && SHA.test(t.headSha ?? '') && CODE.test(t.reason ?? '') && typeof t.own === 'boolean')) fail('invalid_pending_revocations');
  return r;
}

const member = m => exact(m, ['pr', 'headSha', 'claimId']) && Number.isSafeInteger(m.pr) && m.pr > 0 && SHA.test(m.headSha ?? '') && UUID.test(m.claimId ?? '');
const headRef = m => exact(m, ['pr', 'headSha']) && Number.isSafeInteger(m.pr) && m.pr > 0 && SHA.test(m.headSha ?? '');
export function validateLandingBatch(r) {
  if (!exact(r, LANDING_BATCH_FIELDS) || r.contract !== LANDING_BATCH_CONTRACT || !iso(r.writtenAt) || !RUN_ID.test(r.runId ?? '')
    || !Number.isSafeInteger(r.frontPr) || r.frontPr < 1 || !['frontHeadSha', 'baseSha', 'testSha', 'testTree'].every(k => SHA.test(r[k] ?? '')) || ![1, 2].includes(r.attempt)
    || !Array.isArray(r.members) || r.members.length < 1 || r.members.length > BATCH_MAX_LIMIT || !r.members.every(member)
    || r.members[0].pr !== r.frontPr || r.members[0].headSha !== r.frontHeadSha || new Set(r.members.map(m => m.pr)).size !== r.members.length) fail('invalid_train_landing_batch');
  return r;
}
export function validateLandingState(r) {
  if (!exact(r, LANDING_STATE_FIELDS) || r.contract !== LANDING_STATE_CONTRACT || !iso(r.writtenAt) || !RUN_ID.test(r.runId ?? '')
    || !Array.isArray(r.bad) || r.bad.length > MAX_BAD || !r.bad.every(headRef)
    || !(r.suspect === null || (Array.isArray(r.suspect) && r.suspect.length >= 1 && r.suspect.length <= BATCH_MAX_LIMIT && r.suspect.every(headRef)))
    || !Array.isArray(r.adopted) || r.adopted.length > MAX_ADOPTED || !r.adopted.every(s => SHA.test(s ?? ''))
    || !Array.isArray(r.handled) || r.handled.length > MAX_ADOPTED || !r.handled.every(s => SHA.test(s ?? ''))) fail('invalid_train_landing_state');
  return r;
}

const KIND = { 'landing-batch': [LANDING_BATCH_CONTRACT, validateLandingBatch], 'landing-state': [LANDING_STATE_CONTRACT, validateLandingState], proof: [SWEEP_PROOF_CONTRACT, validateSweepProof], 'full-shadow': [FULL_SWEEP_CONTRACT, validateFullSweep], 'full-on': [FULL_SWEEP_CONTRACT, validateFullSweep],
  front: [FRONT_BATCH_CONTRACT, validateFrontBatch], 'strict-proof': [STRICT_PROOF_CONTRACT, validateStrictProof], 'strict-round': [STRICT_ROUND_CONTRACT, validateStrictRound],
  'strict-front-proof': [STRICT_FRONT_PROOF_CONTRACT, validateStrictFrontProof], 'pending-revocations': [PENDING_REVOCATIONS_CONTRACT, validatePendingRevocations],
  'scan-on': [SCAN_CONTRACT, validateScanProgress], 'scan-shadow': [SCAN_CONTRACT, validateScanProgress], 'scan-strict': [SCAN_CONTRACT, validateScanProgress] };

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
  constructor(directory) { this.directory = directory; this.tornNames = new Map(); this.foreignNames = new Set(); this.newestProofMs = null; this.newestStrictMs = null; }
  // Stage 8's "no newer proof was replaced by an older one" (review R1 m3): the torn proof and front-batch files (a name of
  // this store that is not exactly its record) newer than the newest valid proof read so far, or all of them before any.
  // A name that is not one of this store's (desktop.ini, a stray copy) never counts: it is listed in `foreign` only.
  get refused() {
    return [...this.tornNames.values()].filter(t => ['proof', 'front'].includes(t.kind) && (this.newestProofMs === null || t.ms > this.newestProofMs)).length;
  }
  get foreign() { return this.foreignNames.size; }
  get torn() { return this.tornNames.size; }
  get strictRefused() {
    return [...this.tornNames.values()].filter(t => ['strict-proof', 'strict-round', 'front'].includes(t.kind)
      && (this.newestStrictMs === null || t.ms >= this.newestStrictMs)).length;
  }
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
  async read(kind, limit = Infinity, accept = () => true, sameNewestStamp = false) {
    const out = [];
    let newestStamp = null;
    for (const name of (await fs.readdir(this.directory)).sort().reverse()) {
      if (name.endsWith('.tmp')) continue;
      const parts = NAME.exec(name);
      if (!parts) { this.foreignNames.add(name); continue; }
      if (parts[1] !== kind) continue;
      if (sameNewestStamp && newestStamp !== null && Number(parts[2]) < newestStamp) break;
      try {
        const file = path.join(this.directory, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (kind.startsWith('scan-') ? 8 * 1024 * 1024 : 256 * 1024)) fail('unsafe_train_sweep_record');
        const text = await fs.readFile(file, 'utf8'), record = KIND[kind][1](JSON.parse(text));
        if (canonical(record) !== text || Date.parse(record.writtenAt) !== Number(parts[2]) || record.runId !== parts[3]) fail('invalid_train_sweep_record');
        if (!accept(record)) continue;
        out.push(record);
        if (out.length >= limit) {
          if (!sameNewestStamp) break;
          newestStamp ??= Number(parts[2]);
        }
      } catch { this.tornNames.set(name, { kind, ms: Number(parts[2]) }); }
    }
    return out;
  }
  async appendProof(p) { return this.write('proof', { contract: SWEEP_PROOF_CONTRACT, ...p }); }
  async readScanProgress(lane) {
    if (!['on', 'shadow', 'strict'].includes(lane)) fail('invalid_train_scan_lane');
    const kind = `scan-${lane}`, records = await this.read(kind, 1, () => true, true), p = records[0] ?? null;
    if (p && records.some(r => this.strictMeaning(r) !== this.strictMeaning(p))) fail('TRAIN_SCAN_STATE_UNREADABLE');
    if ([...this.tornNames.values()].some(t => t.kind === kind && (p === null || t.ms >= Date.parse(p.writtenAt)))) fail('TRAIN_SCAN_STATE_UNREADABLE');
    return p;
  }
  async writeScanProgress(lane, p) {
    if (!['on', 'shadow', 'strict'].includes(lane)) fail('invalid_train_scan_lane');
    return this.write(`scan-${lane}`, { contract: SCAN_CONTRACT, ...p });
  }
  async writePendingRevocations(p) { return this.write('pending-revocations', { contract: PENDING_REVOCATIONS_CONTRACT, legacyUnconfirmed: 0, legacySince: null, ...p }); }
  async readPendingRevocations() {
    const records = await this.read('pending-revocations', 1, () => true, true), p = records[0] ?? null;
    if (p && records.some(r => this.strictMeaning(r) !== this.strictMeaning(p))) fail('TRAIN_PENDING_REVOCATIONS_UNREADABLE');
    if ([...this.tornNames.values()].some(t => t.kind === 'pending-revocations' && (p === null || t.ms >= Date.parse(p.writtenAt))))
      fail('TRAIN_PENDING_REVOCATIONS_UNREADABLE');
    return p;
  }
  async latestProof() {
    const p = (await this.read('proof', 1))[0] ?? null;
    if (p) this.newestProofMs = Date.parse(p.writtenAt);
    return p;
  }
  async latestProofStrict() {
    const records = await this.read('proof', 1, () => true, true), p = records[0] ?? null;
    if (p && records.some(r => this.strictMeaning(r) !== this.strictMeaning(p))) fail('TRAIN_SWEEP_PROOF_UNREADABLE');
    if ([...this.tornNames.values()].some(t => t.kind === 'proof' && (p === null || t.ms >= Date.parse(p.writtenAt))))
      fail('TRAIN_SWEEP_PROOF_UNREADABLE');
    return p;
  }
  async appendStrictProof(p) { return this.write('strict-proof', { contract: STRICT_PROOF_CONTRACT, ...p }); }
  async appendStrictFrontProof(p) { return this.write('strict-front-proof', { contract: STRICT_FRONT_PROOF_CONTRACT, ...p }); }
  async latestStrictFrontProof() {
    const records = await this.read('strict-front-proof', 1, () => true, true), p = records[0] ?? null;
    if (p && records.some(r => this.strictMeaning(r) !== this.strictMeaning(p))) fail('TRAIN_STRICT_FRONT_PROOF_UNREADABLE');
    if ([...this.tornNames.values()].some(t => t.kind === 'strict-front-proof' && (p === null || t.ms >= Date.parse(p.writtenAt))))
      fail('TRAIN_STRICT_FRONT_PROOF_UNREADABLE');
    return p;
  }
  async latestStrictProof() {
    const records = await this.read('strict-proof', 1, () => true, true);
    const p = records[0] ?? null;
    if (p) this.newestStrictMs = Date.parse(p.writtenAt);
    if (p && records.some(r => this.strictMeaning(r) !== this.strictMeaning(p))) fail('TRAIN_STRICT_PROOF_UNREADABLE');
    if ([...this.tornNames.values()].some(t => t.kind === 'strict-proof' && (p === null || t.ms >= Date.parse(p.writtenAt))))
      fail('TRAIN_STRICT_PROOF_UNREADABLE');
    // Read round integrity too: an unreadable newer binding invalidation must not resurrect an older certificate.
    const round = await this.readStrictRound();
    if (!p || !round || round.state !== 'complete' || round.pending.length !== 0 || !sameStrictIdentity(p, round)) return null;
    return p;
  }
  async readStrictRound() {
    const records = await this.read('strict-round', 1, () => true, true);
    const round = records[0] ?? null;
    // Unlike ordinary historical records, a newer torn round may contain unresolved revocations. Never replace it
    // with an older complete round and then mint a fresh certificate that hides the unreadable pending state.
    if ([...this.tornNames.values()].some(t => t.kind === 'strict-round' && (round === null || t.ms >= Date.parse(round.writtenAt))))
      fail('TRAIN_STRICT_STATE_UNREADABLE');
    if (round && records.some(r => this.strictMeaning(r) !== this.strictMeaning(round))) fail('TRAIN_STRICT_STATE_UNREADABLE');
    return round;
  }
  strictMeaning(record) {
    const { writtenAt, runId, ...meaning } = record;
    return canonical(meaning);
  }
  async writeStrictRound(p) { return this.write('strict-round', { contract: STRICT_ROUND_CONTRACT, ...p }); }
  // mode: 'on' (also the revoke-only runs' incremental cursor) or 'shadow'.
  async readFullSweep(mode = 'on') { return (await this.read(`full-${mode}`, 1))[0] ?? null; }
  // Front-only authority must never recover an older non-rewrite anchor over a
  // newer torn rewrite/pending record. Legacy full readers retain their format.
  async readFullSweepStrict(mode = 'on') {
    const kind = `full-${mode}`, records = await this.read(kind, 1, () => true, true), p = records[0] ?? null;
    if (p && records.some(r => this.strictMeaning(r) !== this.strictMeaning(p))) fail('TRAIN_FULL_STATE_UNREADABLE');
    if ([...this.tornNames.values()].some(t => t.kind === kind && (p === null || t.ms >= Date.parse(p.writtenAt))))
      fail('TRAIN_FULL_STATE_UNREADABLE');
    return p;
  }
  async writeFullSweep(s) { return this.write(`full-${s?.mode}`, { contract: FULL_SWEEP_CONTRACT, ...s, inMain: (s?.inMain ?? []).slice(-MAX_IN_MAIN) }); }
  // Push mode (ADR 0018 §3): batch records, newest first (at most `limit`), and the landing state (newest valid; none: empty).
  async appendLandingBatch(r) { return this.write('landing-batch', { contract: LANDING_BATCH_CONTRACT, ...r }); }
  async landingBatches(limit = 20) { return this.read('landing-batch', limit); }
  async landingBatchByTest(testSha) { return (await this.read('landing-batch', 1, r => r.testSha === testSha))[0] ?? null; }
  async writeLandingState({ writtenAt, runId, bad, suspect, adopted, handled }) {
    const r = { writtenAt, runId, bad, suspect, adopted, handled };
    return this.write('landing-state', { contract: LANDING_STATE_CONTRACT, ...r, bad: r.bad.slice(-MAX_BAD), adopted: r.adopted.slice(-MAX_ADOPTED), handled: r.handled.slice(-MAX_ADOPTED) });
  }
  // A newer torn state is unreadable (never an older one in its place): the caller does not compose riders or bisect then.
  async readLandingState() {
    const records = await this.read('landing-state', 1), p = records[0] ?? null;
    if ([...this.tornNames.values()].some(t => t.kind === 'landing-state' && (p === null || t.ms >= Date.parse(p.writtenAt)))) fail('TRAIN_LANDING_STATE_UNREADABLE');
    return p ? { bad: p.bad, suspect: p.suspect, adopted: p.adopted, handled: p.handled } : { bad: [], suspect: null, adopted: [], handled: [] };
  }
  async appendFrontBatch(r) { return this.write('front', { contract: FRONT_BATCH_CONTRACT, ...r }); }
  // Newest revision of each actual execution, newest first. A timestamp refresh preserves every tested identity
  // field and the attempt; its append-only record is not another execution or another consumed front attempt.
  async frontBatches({ pr, headSha }) {
    const records = await this.read('front', Infinity, r => r.pr === pr && r.headSha === headSha), seen = new Set();
    return records.filter(r => {
      const key = JSON.stringify([r.claimId, r.pr, r.headSha, r.baseSha, r.testSha, r.testTree, r.attempt]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  // Generation 28 (resident docs/adr/0016): the newest front batch this node opened, of any PR, or null; a torn front record at or after it
  // refuses (a newer front this node cannot read must not let an older one count as the newest).
  async latestFrontBatch() {
    const record = (await this.read('front', 1))[0] ?? null;
    if ([...this.tornNames.values()].some(t => t.kind === 'front' && (record === null || t.ms >= Date.parse(record.writtenAt)))) fail('TRAIN_FRONT_BATCH_UNREADABLE');
    return record;
  }
}
