// A limited coverage certificate. It never means a completed full sweep. Claim generations are deliberately not
// invented from holders: stage 8 revalidates the exception against its authoritative Native batch generation.
import { digest } from '../proof.mjs';
import { createSweeper, incrementalSweep, fullSweepSegment, MAX_REVOKES_PER_RUN, SWEEP_BUDGET_MS, revokeGreens } from './train-sweep.mjs';

export const STRICT_PROOF_CONTRACT = 'clued.independent-ci.train-strict-coverage-proof/1';
export const STRICT_ROUND_CONTRACT = 'clued.independent-ci.train-strict-coverage-round/1';
export const STRICT_READINESS_CONTRACT = 'clued.independent-ci.train-strict-readiness/1';
export const STRICT_SCOPE_VERSION = 'gen15-all-current/1';
export const STRICT_AUTHORITY_BINDING = 'stage8-native-current';
const SHA = /^[a-f0-9]{40}$/, HEX = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RUN = /^[a-f0-9]{16}-[a-f0-9]{12}$/, REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const plain = v => v !== null && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const count = v => Number.isSafeInteger(v) && v >= 0;
const fail = () => { throw Object.assign(new Error('invalid_train_strict_record'), { code: 'invalid_train_strict_record' }); };
export const strictSettingsDigest = job => digest({ slotHardCapMinutes: job.slotHardCapMinutes, frontBatchBudgetMs: job.frontBatchBudgetMs,
  sweepFreshMs: job.sweepFreshMs, fullSweepMaxMs: job.fullSweepMaxMs });
export const strictFront = (holder, headSha) => ({ pr: holder.pr, headSha, claimId: holder.claimId, since: new Date(Date.parse(holder.takenAt)).toISOString() });
export const validStrictFront = f => exact(f, ['pr', 'headSha', 'claimId', 'since']) && Number.isSafeInteger(f.pr) && f.pr > 0
  && SHA.test(f.headSha ?? '') && UUID.test(f.claimId ?? '') && iso(f.since);
const IDENTITY = ['repo', 'mode', 'sourceManifestSha256', 'settingsDigest', 'onSince', 'mainSha', 'front', 'scope', 'scopeVersion', 'authorityBinding'];
export function strictIdentity({ job, holder, headSha, mainSha, scope }) {
  return { repo: job.repo, mode: 'on', sourceManifestSha256: job.sourceManifestSha256, settingsDigest: strictSettingsDigest(job), onSince: job.onSince,
    mainSha, front: strictFront(holder, headSha), scope, scopeVersion: STRICT_SCOPE_VERSION, authorityBinding: STRICT_AUTHORITY_BINDING };
}
export const sameStrictIdentity = (a, b) => IDENTITY.every(k => digest(a?.[k] ?? null) === digest(b?.[k] ?? null));
const validIdentity = p => REPO.test(p.repo ?? '') && p.mode === 'on' && HEX.test(p.sourceManifestSha256 ?? '') && HEX.test(p.settingsDigest ?? '')
  && iso(p.onSince) && SHA.test(p.mainSha ?? '') && validStrictFront(p.front) && ['all', 'current'].includes(p.scope)
  && p.scopeVersion === STRICT_SCOPE_VERSION && p.authorityBinding === STRICT_AUTHORITY_BINDING;
export const STRICT_PROOF_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', ...IDENTITY, 'clean', 'enumerationComplete', 'eligibleRevocationsConfirmed',
  'unconfirmed', 'prUpdatedCursor', 'sweepFreshMs', 'slotHardCapMinutes', 'coverage']);
const validCoverage = c => exact(c, ['prs', 'commits', 'heads', 'eligible', 'deferred', 'revoked']) && Object.values(c).every(count);
export function validateStrictProof(p) {
  if (!exact(p, STRICT_PROOF_FIELDS) || p.contract !== STRICT_PROOF_CONTRACT || !iso(p.writtenAt) || !RUN.test(p.runId ?? '') || !validIdentity(p)
    || p.clean !== true || p.enumerationComplete !== true || p.eligibleRevocationsConfirmed !== true || p.unconfirmed !== 0
    || !iso(p.prUpdatedCursor) || !Number.isSafeInteger(p.sweepFreshMs) || p.sweepFreshMs < 60_000 || p.sweepFreshMs > 3_600_000
    || !Number.isSafeInteger(p.slotHardCapMinutes) || p.slotHardCapMinutes < 60 || p.slotHardCapMinutes > 180 || !validCoverage(p.coverage)) fail();
  return p;
}
export const STRICT_ROUND_FIELDS = Object.freeze(['contract', 'writtenAt', 'runId', ...IDENTITY, 'startedAt', 'state', 'nextPage', 'nextIndex', 'incrementalCursor', 'coverage', 'pending']);
export function validateStrictRound(p) {
  if (!exact(p, STRICT_ROUND_FIELDS) || p.contract !== STRICT_ROUND_CONTRACT || !iso(p.writtenAt) || !RUN.test(p.runId ?? '') || !validIdentity(p)
    || !iso(p.startedAt) || !['running', 'complete'].includes(p.state) || !Number.isSafeInteger(p.nextPage) || p.nextPage < 1 || !count(p.nextIndex)
    || !(p.incrementalCursor === null || iso(p.incrementalCursor)) || !validCoverage(p.coverage)
    || !Array.isArray(p.pending) || p.pending.length > MAX_REVOKES_PER_RUN || !p.pending.every(t => exact(t, ['checkRunId', 'headSha', 'reason', 'own'])
      && Number.isSafeInteger(t.checkRunId) && t.checkRunId > 0 && SHA.test(t.headSha ?? '') && CODE.test(t.reason ?? '') && typeof t.own === 'boolean')) fail();
  return p;
}
export function strictReadiness({ identity = null, state = 'none', proofRef = null, writtenAt = null, sweepFreshMs = null, backgroundAllPending = null, reason = null }) {
  return { contract: STRICT_READINESS_CONTRACT, state, repo: identity?.repo ?? null, mainSha: identity?.mainSha ?? null,
    sourceManifestSha256: identity?.sourceManifestSha256 ?? null, settingsDigest: identity?.settingsDigest ?? null, onSince: identity?.onSince ?? null,
    front: identity?.front ?? null, proofRef, writtenAt, expiresAt: writtenAt === null ? null : new Date(Date.parse(writtenAt) + sweepFreshMs).toISOString(), backgroundAllPending, reason };
}
export function validStrictReadiness(r) {
  if (!exact(r, ['contract', 'state', 'repo', 'mainSha', 'sourceManifestSha256', 'settingsDigest', 'onSince', 'front', 'proofRef', 'writtenAt', 'expiresAt', 'backgroundAllPending', 'reason'])
    || r.contract !== STRICT_READINESS_CONTRACT || !['none', 'running', 'ready', 'invalid'].includes(r.state)
    || !(r.backgroundAllPending === null || CODE.test(r.backgroundAllPending ?? '')) || !(r.reason === null || CODE.test(r.reason ?? ''))) return false;
  if (r.state === 'none') return ['repo', 'mainSha', 'sourceManifestSha256', 'settingsDigest', 'onSince', 'front', 'proofRef', 'writtenAt', 'expiresAt'].every(k => r[k] === null);
  if (!REPO.test(r.repo ?? '') || !SHA.test(r.mainSha ?? '') || !HEX.test(r.sourceManifestSha256 ?? '') || !HEX.test(r.settingsDigest ?? '') || !iso(r.onSince) || !validStrictFront(r.front)) return false;
  return r.state === 'ready' ? /^strict-proof-\d{13}-[a-f0-9]{16}-[a-f0-9]{12}-[a-f0-9]{8}\.json$/.test(r.proofRef ?? '')
    && iso(r.writtenAt) && iso(r.expiresAt) && Date.parse(r.expiresAt) > Date.parse(r.writtenAt) && Date.parse(r.expiresAt) - Date.parse(r.writtenAt) <= 3_600_000
    : r.proofRef === null && r.writtenAt === null && r.expiresAt === null;
}

export function validTrainProviderBudget(b, now) {
  const resource = r => r === null || exact(r, ['limit', 'remaining', 'resetAt']) && count(r.limit) && r.limit > 0 && count(r.remaining)
    && r.remaining <= r.limit && iso(r.resetAt);
  if (!exact(b, ['contract', 'state', 'requests', 'restRequests', 'graphqlRequests', 'rest', 'graphql', 'retryAt', 'observedAt', 'extraSlicesAllowed'])
    || b.contract !== 'clued.independent-ci.train-provider-budget/1' || !['ok', 'low', 'unknown'].includes(b.state)
    || !['requests', 'restRequests', 'graphqlRequests'].every(k => count(b[k])) || b.requests !== b.restRequests + b.graphqlRequests
    || !resource(b.rest) || !resource(b.graphql) || !(b.retryAt === null || iso(b.retryAt)) || !(b.observedAt === null || iso(b.observedAt))
    || typeof b.extraSlicesAllowed !== 'boolean' || b.extraSlicesAllowed !== (b.state === 'ok') || (b.state !== 'unknown' && b.observedAt === null)) return false;
  return b.state !== 'ok' || Number.isSafeInteger(now) && b.observedAt !== null && Date.parse(b.observedAt) <= now && now - Date.parse(b.observedAt) <= 60_000
    && b.retryAt === null && [b.rest, b.graphql].every(r => r !== null && Date.parse(r.resetAt) > now && r.remaining > Math.ceil(r.limit / 2));
}
export function validSweepProgress(p) {
  return exact(p, ['contract', 'roundId', 'scope', 'required', 'advanced', 'token', 'at']) && p.contract === 'clued.independent-ci.train-sweep-progress/1'
    && HEX.test(p.roundId ?? '') && p.scope === 'all' && p.required === true && typeof p.advanced === 'boolean' && HEX.test(p.token ?? '') && iso(p.at);
}
export function sweepProgress({ identity, startedAt, nextPage, nextIndex, revoked, advanced, at }) {
  return { contract: 'clued.independent-ci.train-sweep-progress/1', roundId: digest({ identity, startedAt }), scope: 'all', required: true, advanced,
    token: digest({ nextPage, nextIndex, revoked }), at };
}

// Independent cursor: the full sweep's cursor, completion and in-main cache are never advanced by deferred revocations.
// One lane is serial and bounded inside the original stage budget; its revocations use the unchanged two-readback port.
export async function runStrictLane({ identity, job, sweepStore, github, native, entries, stream, own, appId, clock, sleep,
  started, until, ledger, revokeHead, fx }) {
  const no = reason => ({ ready: false, reason, attempted: 0, unconfirmed: 0, revoked: [], identity, round: null, advanced: false });
  let previous;
  try { previous = await sweepStore.readStrictRound(); } catch { return no('TRAIN_STRICT_STATE_UNREADABLE'); }
  const zero = { prs: 0, commits: 0, heads: 0, eligible: 0, deferred: 0, revoked: 0 };
  let round = previous && sameStrictIdentity(previous, identity) && started >= Date.parse(previous.writtenAt)
    && started - Date.parse(previous.startedAt) <= job.fullSweepMaxMs ? previous
    : { ...identity, startedAt: new Date(started).toISOString(), state: 'running', nextPage: 1, nextIndex: 0, incrementalCursor: null, coverage: zero, pending: [] };
  const priorToken = digest({ nextPage: round.nextPage, nextIndex: round.nextIndex, revoked: round.coverage.revoked });
  const sweeper = createSweeper({ github, appId, mainSha: identity.mainSha, strictCoverage: true, clock, until: started + SWEEP_BUDGET_MS });
  const incremental = await incrementalSweep({ sweeper, github, entries, stream, cursor: round.incrementalCursor, front: identity.front, own, revokeHead,
    clock, until: started + (round.state === 'running' ? SWEEP_BUDGET_MS / 2 : SWEEP_BUDGET_MS) });
  const segment = round.state === 'running' && !sweeper.late() ? await fullSweepSegment({ sweeper, github, nextPage: round.nextPage, nextIndex: round.nextIndex,
    scope: identity.scope, front: identity.front, own }) : null;
  const targets = [...new Map([...(previous?.pending ?? []), ...incremental.targets, ...(segment?.targets ?? [])].map(t => [t.checkRunId, t])).values()];
  let onDuty = true;
  if (targets.some(t => !t.own)) {
    try { onDuty = (await native.holders())?.onDuty === true; } catch { onDuty = false; }
  }
  const selected = onDuty ? targets.slice(0, MAX_REVOKES_PER_RUN) : targets.filter(t => t.own).slice(0, MAX_REVOKES_PER_RUN);
  const r = await revokeGreens({ github, targets: selected, appId, mainSha: identity.mainSha, ledger, own, clock, sleep,
    writeUntil: until.write, readUntil: until.read });
  fx.n += r.sideEffects;
  const confirmed = onDuty && targets.length === selected.length && r.unconfirmed.length === 0 && r.ledgerFailures === 0;
  const coverage = { ...round.coverage };
  for (const k of ['prs', 'commits', 'heads', 'eligible', 'deferred']) coverage[k] += sweeper.stats[k];
  coverage.revoked += r.revoked.length;
  if (confirmed) {
    if (incremental.complete || incremental.progress) round = { ...round, incrementalCursor: incremental.complete ? incremental.newest : incremental.progress };
    if (segment?.ok) round = { ...round, nextPage: segment.nextPage, nextIndex: segment.nextIndex,
      state: segment.reachedEnd && incremental.complete ? 'complete' : 'running' };
  }
  round = { ...round, coverage, pending: selected.filter(t => r.ledgerFailures > 0 || r.unconfirmed.some(u => u.checkRunId === t.checkRunId)) };
  try { await sweepStore.writeStrictRound({ ...round, contract: STRICT_ROUND_CONTRACT, writtenAt: new Date(clock()).toISOString(), runId: job.runId }); }
  catch { return { ...no('TRAIN_STRICT_STATE_UNWRITTEN'), attempted: selected.length, revoked: r.revoked, unconfirmed: r.unconfirmed.length }; }
  const ready = round.state === 'complete' && incremental.complete && confirmed && segment?.ok !== false;
  return { ready, reason: ready ? null : r.unconfirmed.length ? 'TRAIN_REVOKE_UNCONFIRMED' : incremental.reason ?? segment?.reason ?? 'TRAIN_TAKEOVER_SWEEP_PENDING',
    attempted: selected.length, unconfirmed: r.unconfirmed.length, revoked: r.revoked, identity, round,
    advanced: priorToken !== digest({ nextPage: round.nextPage, nextIndex: round.nextIndex, revoked: round.coverage.revoked }) };
}
