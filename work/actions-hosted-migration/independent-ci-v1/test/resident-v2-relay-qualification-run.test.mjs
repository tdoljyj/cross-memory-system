import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RELAY_QUALIFICATION_RUN_CONTRACT, RELAY_QUALIFICATION_RUN_FIELDS,
  RELAY_QUALIFICATION_SUBJECT_FIELDS, RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS, RELAY_QUALIFICATION_OBSERVATION_CONTRACT,
  RELAY_QUALIFICATION_WINDOW_CONTRACT, RELAY_QUALIFICATION_AUTHORITY_ID,
  makeRelayQualificationRun, validateRelayQualificationRun, relayQualificationRunId,
  relayQualificationSubjectSha256, validateRelayQualificationObservation, relayQualificationWindow,
} from '../src/resident-v2/relay-qualification-run.mjs';

const H = c => c.repeat(64), S = c => c.repeat(40), N = c => c.repeat(32);
const UUID = '12345678-1234-1234-1234-123456789abc';
const NOW = Date.parse('2026-11-02T13:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => sha(`{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(',')}}`);
function input(extra = {}) {
  return { repo: 'tdoljyj/cross-memory-system', runId: 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbb', pr: 987,
    headSha: S('a'), baseSha: S('b'), testSha: S('a'), sourceManifestSha256: H('c'),
    nodeProfileSha256: H('d'), claimId: UUID, fence: 9, executionEpoch: 2,
    stage1JobId: H('e'), stage1OutcomeNonce: N('f'), stage1OutcomeSha256: H('1'),
    phase: 'initial', priorObservationNonce: null, priorObservationSha256: null,
    createdAt: '2026-11-02T13:00:00.000Z', ...extra };
}
function role(name) {
  const verifiedClaims = { iss: 'https://token.actions.githubusercontent.com', aud: 'clued-independent-ci',
    repository: 'tdoljyj/cross-memory-system', run_id: '42', run_attempt: '1', sha: S('a'),
    workflow_sha: S('a'), iat: Math.floor(NOW / 1000) };
  return { role: name, verdict: 'ATTESTED_SUCCESS', checkRunId: 42, workflowRunId: '42', runAttempt: '1',
    annotationsComplete: true, identityAnnotationCount: 1, totalAnnotationCount: 1,
    fullAnnotationsSha256: H('2'), tokenPresent: true, tokenSha256: H('3'), signatureVerified: true,
    verifiedClaims, claimsSha256: canonicalHash(verifiedClaims), checkRunIdClaimPresent: false,
    registryBindsCheckRunId: false, keyThumbprintSha256: H('4'), attestationSha256: H('5') };
}
function observation(job = makeRelayQualificationRun(input())) {
  return { contract: RELAY_QUALIFICATION_OBSERVATION_CONTRACT, jobId: job.id, phase: job.phase,
    subjectSha256: relayQualificationSubjectSha256(job), observedAt: '2026-11-02T13:00:01.000Z', liveQualified: false,
    roles: [role('gitleaks'), role('trivy')],
    refObservation: { ref: `refs/pull/${job.pr}/merge`, beforeMergeSha: S('6'), afterMergeSha: S('6'), oldMergeReadable: true },
    jwksObservation: { networkFetched: true, sha256: H('7') } };
}
function record(job = makeRelayQualificationRun(input())) {
  return { config: { sourceManifestSha256: job.sourceManifestSha256 }, accepted: {
    ownerReceiptRef: UUID,
    relayQualificationWindow: { contract: RELAY_QUALIFICATION_WINDOW_CONTRACT, qualificationRef: 'receipt:' + UUID,
      sourceManifestSha256: job.sourceManifestSha256, ownerReceiptRef: UUID,
      authorityDecisionId: RELAY_QUALIFICATION_AUTHORITY_ID, authorityDecisionSha256: H('8'), authorityReadReceiptRef: UUID,
      subject: Object.fromEntries(RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.map(k => [k, job[k]])),
      validUntil: '2026-11-02T14:00:00.000Z', allowedPhases: ['initial', 'after-ref-move'],
      executionPolicy: 'staged', guarded: false, changedPaths: ['src/example.mjs'],
      changedPathsSha256: sha(JSON.stringify(['src/example.mjs'])) } } };
}
const refusedRun = value => assert.throws(() => validateRelayQualificationRun(value), /RELAY_QUALIFICATION_RUN_REFUSED/);
const refusedObservation = (value, job) => assert.throws(() => validateRelayQualificationObservation(value, job), /RELAY_QUALIFICATION_OBSERVATION_REFUSED|RELAY_QUALIFICATION_RUN_REFUSED/);

test('dedicated job has closed fields and deterministic cross-language array identity', () => {
  const job = makeRelayQualificationRun(input());
  assert.equal(job.contract, RELAY_QUALIFICATION_RUN_CONTRACT);
  assert.deepEqual(Object.keys(job).sort(), [...RELAY_QUALIFICATION_RUN_FIELDS].sort());
  const expected = sha(JSON.stringify([RELAY_QUALIFICATION_RUN_CONTRACT,
    ...RELAY_QUALIFICATION_SUBJECT_FIELDS.map(k => job[k]), 'initial', null, null]));
  assert.equal(job.id, expected); assert.equal(job.id, relayQualificationRunId(job)); assert.ok(Object.isFrozen(job));
  assert.equal(makeRelayQualificationRun(input({ createdAt: '2026-11-02T13:00:01.000Z' })).id, job.id);
});
test('every execution subject and prior receipt identity changes the job id', () => {
  const first = makeRelayQualificationRun(input());
  for (const [key, value] of Object.entries({ runId: 'bbbbbbbbbbbbbbbb-cccccccccccc', pr: 988, baseSha: S('c'),
    sourceManifestSha256: H('4'), nodeProfileSha256: H('5'), claimId: '22345678-1234-1234-1234-123456789abc',
    fence: 10, executionEpoch: 3, stage1JobId: H('6'), stage1OutcomeNonce: N('7'), stage1OutcomeSha256: H('8') })) {
    const changed = makeRelayQualificationRun(input({ [key]: value }));
    assert.notEqual(changed.id, first.id, key); refusedRun({ ...first, [key]: value });
  }
  assert.notEqual(makeRelayQualificationRun(input({ headSha: S('d'), testSha: S('d') })).id, first.id);
  const after = makeRelayQualificationRun(input({ phase: 'after-ref-move', priorObservationNonce: N('2'), priorObservationSha256: H('3') }));
  assert.notEqual(after.id, first.id);
  assert.equal(relayQualificationSubjectSha256(after), relayQualificationSubjectSha256(first));
  assert.notEqual(makeRelayQualificationRun(input({ phase: 'after-ref-move', priorObservationNonce: N('3'), priorObservationSha256: H('3') })).id, after.id);
});
test('malformed, train, coercible, accessor and extra-key jobs are refused without getter execution', () => {
  const job = makeRelayQualificationRun(input());
  for (const patch of [{ pr: '987' }, { pr: NaN }, { fence: 0 }, { executionEpoch: 1.5 }, { testSha: S('b') },
    { phase: 'arbitrary' }, { priorObservationNonce: N('a') }, { priorObservationSha256: H('a') },
    { phase: 'after-ref-move', priorObservationNonce: null, priorObservationSha256: H('a') },
    { phase: 'after-ref-move', priorObservationNonce: N('f'), priorObservationSha256: H('a') },
    { createdAt: '2026-02-30T13:00:00.000Z' }, { createdAt: '2026-11-02T13:00:00Z' }, { role: 'gitleaks' }]) refusedRun({ ...job, ...patch });
  let calls = 0; const getter = { ...job };
  Object.defineProperty(getter, 'headSha', { get() { calls++; throw Error('leak'); }, enumerable: true }); refusedRun(getter);
  const coercible = { ...job, pr: { valueOf() { calls++; return 987; } } }; refusedRun(coercible);
  assert.equal(calls, 0); refusedRun({ ...job, [Symbol('extra')]: 'x' });
});
test('observation snapshots only bounded public claims and hashes, bound to exact subject/phase', () => {
  const job = makeRelayQualificationRun(input()), raw = observation(job);
  const result = validateRelayQualificationObservation(raw, job);
  assert.equal(result.liveQualified, false); assert.ok(Object.isFrozen(result.roles[0].verifiedClaims));
  raw.roles[0].verifiedClaims.repository = 'other/repo';
  assert.equal(result.roles[0].verifiedClaims.repository, job.repo);
  for (const patch of [{ jobId: H('9') }, { phase: 'after-ref-move' }, { subjectSha256: H('9') },
    { liveQualified: true }, { token: 'must never persist' }, { roles: [...result.roles].reverse() }]) refusedObservation({ ...result, ...patch }, job);
});
test('public role claims reject raw values, secret keys, false verification and hash mismatches', () => {
  const job = makeRelayQualificationRun(input());
  const cases = [r => r.token = 'eyJ.a.b', r => r.verifiedClaims.rawToken = 'secret',
    r => r.verifiedClaims.sub = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.signature',
    r => r.claimsSha256 = H('9'), r => r.verifiedClaims.iat = '123',
    r => r.verifiedClaims.aud = 'a'.repeat(513), r => r.signatureVerified = false,
    r => r.checkRunIdClaimPresent = true, r => r.totalAnnotationCount = 0,
    r => r.fullAnnotationsSha256 = null, r => r.attestationSha256 = null];
  for (const change of cases) { const o = observation(job); change(o.roles[0]); refusedObservation(o, job); }
  const o = observation(job); let calls = 0;
  Object.defineProperty(o.roles[0].verifiedClaims, 'sub', { enumerable: true, get() { calls++; throw Error('secret'); } });
  refusedObservation(o, job); assert.equal(calls, 0);
});
test('a pending observation is explicit and cannot fake signature/network/ref success', () => {
  const job = makeRelayQualificationRun(input()), o = observation(job);
  for (const r of o.roles) Object.assign(r, { verdict: 'PENDING', checkRunId: null, workflowRunId: null, runAttempt: null,
    annotationsComplete: false, identityAnnotationCount: 0, totalAnnotationCount: 0, fullAnnotationsSha256: null,
    tokenPresent: false, tokenSha256: null, signatureVerified: false, verifiedClaims: null, claimsSha256: null,
    checkRunIdClaimPresent: false, keyThumbprintSha256: null, attestationSha256: null });
  o.jwksObservation = { networkFetched: false, sha256: null };
  o.refObservation = { ref: `refs/pull/${job.pr}/merge`, beforeMergeSha: null, afterMergeSha: null, oldMergeReadable: false };
  assert.equal(validateRelayQualificationObservation(o, job).roles[0].verdict, 'PENDING');
  const badNetwork = clone(o); badNetwork.jwksObservation.networkFetched = true; refusedObservation(badNetwork, job);
  const badRef = clone(o); badRef.refObservation.ref = 'refs/heads/unrelated'; refusedObservation(badRef, job);
  const badOld = clone(o); badOld.refObservation.oldMergeReadable = true; refusedObservation(badOld, job);
});
test('capability block is exact Source/Owner/authority/subject-bound and expiry-bounded', () => {
  const job = makeRelayQualificationRun(input()), r = record(job);
  const q = relayQualificationWindow(r, { job, now: NOW, reserveMs: 300000 });
  assert.equal(q.authorityDecisionId, RELAY_QUALIFICATION_AUTHORITY_ID);
  assert.ok(Object.isFrozen(q.subject)); assert.ok(Object.isFrozen(q.allowedPhases));
  const changes = [q => q.sourceManifestSha256 = H('9'), q => q.ownerReceiptRef = '22345678-1234-1234-1234-123456789abc',
    q => q.authorityDecisionId = UUID, q => q.authorityDecisionSha256 = null, q => q.authorityReadReceiptRef = null,
    q => q.validUntil = '2026-11-02T13:05:00.000Z', q => q.allowedPhases = [],
    q => q.allowedPhases = ['after-ref-move', 'initial'], q => q.subject.fence++, q => q.unread = true];
  for (const change of changes) { const bad = record(job); change(bad.accepted.relayQualificationWindow);
    assert.equal(relayQualificationWindow(bad, { job, now: NOW, reserveMs: 300000 }), null); }
});
test('capability never evaluates accessor/coercible authority data or grants live authority', () => {
  const job = makeRelayQualificationRun(input()); let calls = 0;
  const r = record(job); Object.defineProperty(r.accepted.relayQualificationWindow, 'ownerReceiptRef',
    { enumerable: true, get() { calls++; throw Error('secret'); } });
  assert.equal(relayQualificationWindow(r, { job, now: NOW }), null);
  const outer = record(job); Object.defineProperty(outer.config, 'sourceManifestSha256',
    { enumerable: true, get() { calls++; throw Error('secret'); } });
  assert.equal(relayQualificationWindow(outer, { job, now: NOW }), null); assert.equal(calls, 0);
  assert.equal(relayQualificationWindow({}, { job, now: NOW }), null);
  assert.equal(relayQualificationWindow(record(job), { job, now: NOW }).liveQualified, undefined);
});
test('installed window binds only pre-Stage1 subject while run identity still binds exact outcome locators', () => {
  const first = makeRelayQualificationRun(input()), r = record(first);
  assert.equal(RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.length, 12);
  assert.deepEqual(Object.keys(r.accepted.relayQualificationWindow.subject), [...RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS]);
  assert.ok(!RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.includes('stage1OutcomeNonce'));
  assert.ok(!RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.includes('stage1OutcomeSha256'));
  const later = makeRelayQualificationRun(input({ stage1OutcomeNonce: N('2'), stage1OutcomeSha256: H('3') }));
  assert.notEqual(first.id, later.id);
  assert.notEqual(relayQualificationSubjectSha256(first), relayQualificationSubjectSha256(later));
  assert.ok(relayQualificationWindow(r, { job: first, now: NOW }));
  assert.ok(relayQualificationWindow(r, { job: later, now: NOW }));
  for (const patch of [{ runId: 'bbbbbbbbbbbbbbbb-aaaaaaaaaaaa' }, { pr: 988 }, { headSha: S('1'), testSha: S('1') },
    { baseSha: S('2') }, { sourceManifestSha256: H('3') }, { nodeProfileSha256: H('4') },
    { claimId: '22345678-1234-1234-1234-123456789abc' }, { fence: 10 }, { executionEpoch: 3 }, { stage1JobId: H('5') }]) {
    assert.equal(relayQualificationWindow(r, { job: makeRelayQualificationRun(input(patch)), now: NOW }), null);
  }
  for (const extra of ['stage1OutcomeNonce', 'stage1OutcomeSha256']) {
    const bad = record(first); bad.accepted.relayQualificationWindow.subject[extra] = first[extra];
    assert.equal(relayQualificationWindow(bad, { job: first, now: NOW }), null, 'window subject has exact static fields');
  }
});
test('accepted execution mode bits are mandatory, exact and never default active to staged', () => {
  const job = makeRelayQualificationRun(input());
  const active = record(job); Object.assign(active.accepted.relayQualificationWindow, { executionPolicy: 'active', guarded: true });
  const q = relayQualificationWindow(active, { job, now: NOW });
  assert.equal(q.executionPolicy, 'active'); assert.equal(q.guarded, true);
  assert.equal(job.id, makeRelayQualificationRun(input()).id, 'capability mode never changes public run identity');
  for (const patch of [{ executionPolicy: 'off' }, { executionPolicy: null }, { executionPolicy: 1 },
    { guarded: 'true' }, { guarded: null }, { guarded: 0 }]) {
    const r = record(job); Object.assign(r.accepted.relayQualificationWindow, patch);
    assert.equal(relayQualificationWindow(r, { job, now: NOW }), null);
  }
  for (const missing of ['executionPolicy', 'guarded']) {
    const r = record(job); delete r.accepted.relayQualificationWindow[missing];
    assert.equal(relayQualificationWindow(r, { job, now: NOW }), null);
  }
  let calls = 0; const r = record(job);
  Object.defineProperty(r.accepted.relayQualificationWindow, 'guarded', { enumerable: true, get() { calls++; return true; } });
  assert.equal(relayQualificationWindow(r, { job, now: NOW }), null); assert.equal(calls, 0);
});
test('accepted actual changed paths are sorted, unique, repo-relative and exact-hash bound', () => {
  const job = makeRelayQualificationRun(input()), r = record(job);
  const q = relayQualificationWindow(r, { job, now: NOW });
  assert.deepEqual(q.changedPaths, ['src/example.mjs']); assert.ok(Object.isFrozen(q.changedPaths));
  r.accepted.relayQualificationWindow.changedPaths.push('src/later.mjs');
  assert.deepEqual(q.changedPaths, ['src/example.mjs'], 'accepted path snapshot does not follow caller mutation');
  const invalid = [[], ['../secret'], ['a/../secret'], ['a/./b'], ['a//b'], ['/absolute'],
    ['C:/absolute'], ['a\\b'], ['a\u0000b'], ['a\u007fb'], ['a'.repeat(513)], ['b', 'a'], ['a', 'a'],
    Array.from({ length: 2001 }, (_, i) => `src/${String(i).padStart(5, '0')}.mjs`)];
  for (const paths of invalid) {
    const bad = record(job); bad.accepted.relayQualificationWindow.changedPaths = paths;
    bad.accepted.relayQualificationWindow.changedPathsSha256 = sha(JSON.stringify(paths));
    assert.equal(relayQualificationWindow(bad, { job, now: NOW }), null);
  }
  const wrongHash = record(job); wrongHash.accepted.relayQualificationWindow.changedPathsSha256 = H('9');
  assert.equal(relayQualificationWindow(wrongHash, { job, now: NOW }), null);
  for (const missing of ['changedPaths', 'changedPathsSha256']) {
    const bad = record(job); delete bad.accepted.relayQualificationWindow[missing];
    assert.equal(relayQualificationWindow(bad, { job, now: NOW }), null);
  }
  let calls = 0; const accessor = record(job);
  Object.defineProperty(accessor.accepted.relayQualificationWindow.changedPaths, '0',
    { enumerable: true, get() { calls++; throw Error('secret'); } });
  assert.equal(relayQualificationWindow(accessor, { job, now: NOW }), null); assert.equal(calls, 0);
});
