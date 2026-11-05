// Generation 13 (resident DESIGN §57.2, Task 7b21f820): a slow step of a publication (Native's complete admission, the GitHub
// read-back) can outlast the 30 seconds live authority stays fresh (FRESH_MS, Decision 1100a0ed). On 2026-11-05 PR #1001 head
// 5abcb6f5 lost its head that way: protected_facts_expired_during_admission after the trivy green, revoked. The facts are now observed
// again (the bound is unchanged); only a real change of authorization withdraws a green. An admission that aged during the read-back
// after the write is evaluated again, completely, and must bind the same authorization. These tests drive the publisher alone; the
// production wiring (the recoverable publisher and its observation windows) is test/stale-facts-production-wiring.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult, admittedFacts } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const SLOW = 40_000; // longer than FRESH_MS
const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];

function fakeGithub(clock, { slowReadback = false, slowBeforeWrite = false } = {}) {
  const checks = []; let next = 100, created = false;
  const slow = { readback: slowReadback, beforeWrite: slowBeforeWrite };
  return { fixture: true, checks, slow,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { if (created ? slow.readback : slow.beforeWrite) clock.now += SLOW; return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { created = true; const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}

// A scanner publication whose clock the steps move: `admission` (ms the complete admission takes, or a function of the n-th
// evaluation), `observe(n, base, clock)` the n-th observation of the protected facts (a function may change, throw or move the clock).
async function world(t, { admission = SLOW, observe = (n, base) => base, slowReadback = false, slowBeforeWrite = false } = {}) {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 }).trivy;
  const c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const clock = { now: Date.now() };
  const refs = Object.fromEntries(REFS.map(k => [k, record.accepted[k]]));
  const observations = [];
  const authority = { fixture: true, async observe(j) {
    const base = { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
      publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(clock.now), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) };
    observations.push(clock.now);
    return observe(observations.length, base, clock);
  } };
  const evaluations = [];
  const nativeAdmission = { fixture: true, async evaluatePr(j, packet, opts) {
    clock.now += typeof admission === 'function' ? admission(evaluations.length + 1) : admission; evaluations.push(clock.now);
    return admittedFacts(j, c, packet, { domain: 'fixture', batchClaim: opts.batchClaim, observedAt: clock.now }); } };
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const github = fakeGithub(clock, { slowReadback, slowBeforeWrite });
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const pub = createStagedCheckPublisherV2({ nativeAdmission, authority, github, journal, signers, configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j),
    protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs }, batchClaim: claimGeneration(c),
    domain: 'fixture', clock: () => clock.now });
  return { publish: () => pub.publish({ job, envelope }), github, observations, evaluations, c, clock };
}

test('a complete admission slower than FRESH_MS: the facts are observed again and the green stays (PR #1001 head 5abcb6f5)', async t => {
  const w = await world(t);
  const r = await w.publish();
  assert.deepEqual([r.status, r.sideEffects, w.github.checks.map(x => x.conclusion)], ['SETTLED', 1, ['success']], JSON.stringify(r));
  assert.equal(w.observations.length, 4, 'once before and once again after each slow admission (before and after the write)');
});

test('a slow GitHub read-back after the write: the admission is evaluated again, completely, and binds the same authorization', async t => {
  const w = await world(t, { admission: 0, slowReadback: true });
  const r = await w.publish();
  assert.deepEqual([r.status, w.github.checks.map(x => x.conclusion)], ['SETTLED', ['success']], JSON.stringify(r));
  assert.equal(w.observations.length, 3, 'before, after, and the re-evaluation after the slow read-back');
  assert.equal(w.evaluations.length, 3, 'one complete admission each');
});

test('the re-evaluation after the read-back sees a real change, or cannot be made live: the green is withdrawn', async t => {
  const moved = await world(t, { admission: 0, slowReadback: true, observe: (n, base) => n === 3 ? { ...base, claim: { ...base.claim, fence: base.claim.fence + 1 } } : base });
  const r = await moved.publish();
  assert.deepEqual([r.status, r.reason, moved.github.checks.map(x => x.conclusion)], ['REVOKED', 'protected_claim_changed', ['failure']], JSON.stringify(r));
  // the re-evaluation's own admission is slow, and its facts observed once more take long again: the re-evaluated admission has aged
  const aged = await world(t, { admission: n => n === 3 ? SLOW : 0, slowReadback: true,
    observe: (n, base, clock) => { if (n !== 4) return base; clock.now += SLOW; return { ...base, observedAt: iso(clock.now) }; } });
  const r2 = await aged.publish();
  assert.deepEqual([r2.status, r2.reason, aged.github.checks.map(x => x.conclusion)], ['REVOKED', 'lease_expired_after_write', ['failure']], JSON.stringify(r2));
});

test('a real change in the facts observed again still stops: another claim generation, a lost qualification', async t => {
  // before the write: nothing is written
  const other = await world(t, { observe: (n, base) => n === 2 ? { ...base, claim: { ...base.claim, fence: base.claim.fence + 1 } } : base });
  const r = await other.publish();
  assert.equal(r.status, 'BLOCKED', JSON.stringify(r));
  assert.equal(other.github.checks.length, 0);
  // after the write: the green is withdrawn as before
  const lost = await world(t, { observe: (n, base) => n === 4 ? { ...base, publisherQualified: false } : base });
  const r2 = await lost.publish();
  assert.deepEqual([r2.status, r2.reason, lost.github.checks.map(x => x.conclusion)], ['REVOKED', 'protected_qualification_missing', ['failure']], JSON.stringify(r2));
});

test('the facts cannot be observed again before the write: a clean BLOCKED, safe to run again; nothing on GitHub', async t => {
  const w = await world(t, { observe: (n, base) => { if (n === 2) throw Object.assign(new Error('native_claim_observation_unavailable'), { code: 'native_claim_observation_unavailable' }); return base; } });
  const r = await w.publish();
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun, w.github.checks.length], ['BLOCKED', 'protected_facts_reobservation_unavailable', 0, true, 0], JSON.stringify(r));
});

test('the admission aged before anything was recorded (a slow GitHub read before the write): a clean BLOCKED, safe to run again, and the run again settles', async t => {
  const w = await world(t, { admission: 0, slowBeforeWrite: true });
  const r = await w.publish();
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun, w.github.checks.length], ['BLOCKED', 'native_admission_aged_before_write', 0, true, 0], JSON.stringify(r));
  w.github.slow.beforeWrite = false; // the resident runs the stage again with the same signed result (DESIGN 51)
  const again = await w.publish();
  assert.deepEqual([again.status, w.github.checks.map(x => x.conclusion)], ['SETTLED', ['success']], JSON.stringify(again));
});

test('facts observed once more that come back not fresh: refused like any stale observation, no second try, nothing written', async t => {
  const w = await world(t, { observe: (n, base) => n === 2 ? { ...base, observedAt: iso(Date.parse(base.observedAt) - SLOW) } : base });
  const r = await w.publish();
  assert.deepEqual([r.status, r.reason, r.safeToRerun, w.github.checks.length, w.observations.length], ['BLOCKED', 'protected_facts_unconfirmed', undefined, 0, 2], JSON.stringify(r));
});

test('the stage fact: the three passing pre-write reasons of generation 13 are the transient NATIVE_ADMISSION_UNAVAILABLE, only on a clean BLOCKED', async () => {
  const { outcomeFailureCode } = await import('../src/resident-v2/stage-fact.mjs');
  for (const reason of ['protected_facts_reobservation_unavailable', 'native_admission_aged_before_write', 'publication_window_short_before_write']) {
    assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false }, 5), 'NATIVE_ADMISSION_UNAVAILABLE', reason);
    assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason, sideEffects: 1, mayHavePublished: false }, 5), 'PUBLICATION_UNCERTAIN', reason);
    assert.equal(outcomeFailureCode({ status: 'REVOKED', reason, sideEffects: 2, mayHavePublished: true }, 5), 'PUBLICATION_REVOKED', reason);
  }
});
