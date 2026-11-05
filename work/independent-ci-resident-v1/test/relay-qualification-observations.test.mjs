// Real local create-only state; the protected engine boundary is simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { digest } from '../src/canonical.mjs';
import { RelayQualificationHolds } from '../src/relay-qualification-hold.mjs';
import { RelayQualificationObservations } from '../src/relay-qualification-observations.mjs';
import { BASE, HEAD, SOURCE, CI_SOURCE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';
import { makeJobV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { makeRelayQualificationRun, relayQualificationSubjectSha256, validateRelayQualificationObservation,
  RELAY_QUALIFICATION_OBSERVATION_CONTRACT } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/relay-qualification-run.mjs';

const NOW = Date.parse('2026-10-20T12:00:00.000Z'), OLD = '6'.repeat(40), NEW = '7'.repeat(40);
const h = c => c.repeat(64), n = c => c.repeat(32);
const hint = { observedAt: NOW, roles: { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } } };
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = (code = 'RELAY_QUALIFICATION_BUSY') => ({ ok: false, code, deferred: true,
  proof: { windowsTreeZero: false, serviceOriginalStopped: false }, liveQualified: false, observation: null, observationLocator: null });

async function fixture(t, script = null) {
  const root = await tempRoot(t); let now = NOW;
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 };
  const normal = makeJobV2({ ...subject, sourceManifestSha256: CI_SOURCE, testSha: HEAD,
    role: 'work-admission', createdAt: new Date(NOW).toISOString() });
  const q = { contract: 'clued.independent-ci.relay-qualification-window/1', qualificationRef: 'receipt:' + randomUUID(),
    sourceManifestSha256: CI_SOURCE, ownerReceiptRef: randomUUID(), authorityDecisionId: 'c32676f4-4528-408c-b5e6-88cb27fca13a',
    authorityDecisionSha256: h('a'), authorityReadReceiptRef: randomUUID(), subject: { repo: subject.repo, runId: 'a'.repeat(16) + '-' + 'b'.repeat(12),
      pr: 884, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: CI_SOURCE, nodeProfileSha256: TEST_NODE_SHA,
      claimId: randomUUID(), fence: 9, executionEpoch: 2, stage1JobId: normal.id },
    validUntil: new Date(NOW + 3_600_000).toISOString(), allowedPhases: ['initial', 'after-ref-move'], executionPolicy: 'staged', guarded: false,
    changedPaths: ['src/fixture.mjs'], changedPathsSha256: digest(['src/fixture.mjs']) };
  const holds = new RelayQualificationHolds(root, () => now), key = h('b'), batchId = key.slice(0, 16) + '-' + 'c'.repeat(12);
  await holds.arm(q, subject, { key, batchId });
  const stage1 = { nonce: n('d'), outcomeSha256: h('e'), nativeReceiptSha256: h('f'), jobId: normal.id };
  await holds.recordStage1(subject, { key, batchId, result: { factsSha256: stage1.nativeReceiptSha256, stage1Locator: stage1 } });
  const calls = [];
  function success(args) {
    const job = makeRelayQualificationRun({ ...q.subject, stage1OutcomeNonce: args.stage1Locator.nonce,
      stage1OutcomeSha256: args.stage1Locator.outcomeSha256, phase: args.phase,
      priorObservationNonce: args.priorObservation?.observationLocator.nonce ?? null,
      priorObservationSha256: args.priorObservation?.observationLocator.outcomeSha256 ?? null, createdAt: new Date(now).toISOString() });
    const roles = ['gitleaks', 'trivy'].map((role, i) => {
      const verifiedClaims = { iss: 'https://token.actions.githubusercontent.com', aud: 'clued-hosted-relay-v1', repository: subject.repo,
        run_id: String(42 + i), run_attempt: '1', sha: OLD, workflow_sha: OLD, iat: Math.floor(now / 1000) };
      return { role, verdict: 'ATTESTED_SUCCESS', checkRunId: 42 + i, workflowRunId: String(42 + i), runAttempt: '1',
        annotationsComplete: true, identityAnnotationCount: 1, totalAnnotationCount: 1, fullAnnotationsSha256: h('1'), tokenPresent: true,
        tokenSha256: h('2'), signatureVerified: true, verifiedClaims, claimsSha256: digest(verifiedClaims),
        checkRunIdClaimPresent: false, registryBindsCheckRunId: false, keyThumbprintSha256: h('3'), attestationSha256: h('4') };
    });
    const observation = validateRelayQualificationObservation({ contract: RELAY_QUALIFICATION_OBSERVATION_CONTRACT, jobId: job.id,
      phase: args.phase, subjectSha256: relayQualificationSubjectSha256(job), observedAt: new Date(now).toISOString(), liveQualified: false,
      roles, refObservation: { ref: `refs/pull/${q.subject.pr}/merge`, beforeMergeSha: OLD,
        afterMergeSha: args.phase === 'initial' ? OLD : NEW, oldMergeReadable: true }, jwksObservation: { networkFetched: true, sha256: h('5') } }, job);
    return { ok: true, code: null, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
      state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', nativeReceiptSha256: h('6'), observation,
      observationLocator: { nonce: randomBytes(16).toString('hex'), outcomeSha256: h('7'), nativeReceiptSha256: h('6'), jobId: job.id }, liveQualified: false };
  }
  const engine = { async runRelayQualification(args) { calls.push(args); return script ? script(args, { success, calls }) : success(args); } };
  const controller = () => new RelayQualificationObservations({ holds, engine, clock: () => now });
  return { root, subject, q, holds, stage1, calls, engine, controller, success, advance: ms => { now += ms; }, clock: () => now,
    book: path.join(holds.directory(subject), 'observations') };
}
const tick = (f, options = {}) => f.controller().tick({ subject: f.subject, hint, ...options });
async function bookText(root) {
  let text = '';
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    text += entry.isDirectory() ? await bookText(file) : await fs.readFile(file, 'utf8');
  }
  return text;
}

test('missing/pending/malformed advisory hints delay initial and never call the engine', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { ...hint, roles: { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'PENDING_RUNNING' } } },
    { ...hint, PASS: true }, { observedAt: NOW, roles: { gitleaks: { state: 'SUCCESS' } } }]) {
    assert.equal((await tick(f, { hint: value })).state, 'HELD');
  }
  assert.equal(f.calls.length, 0); assert.equal((await f.holds.inspect(f.subject)).held, true);
});
test('initial calls only after durable intent and both phases preserve protected public results without qualification', async t => {
  const f = await fixture(t, async (args, { success }) => {
    const intent = path.join(f.book, args.phase, 'attempt-01', '00-intent.json');
    assert.equal(JSON.parse(await fs.readFile(intent, 'utf8')).phase, args.phase);
    return success(args);
  });
  const first = await tick(f); assert.equal(first.state, 'OBSERVATIONS_COLLECTED_NO_QUALIFICATION');
  assert.equal(first.phase, 'initial'); assert.equal(first.liveQualified, false); assert.equal(f.calls.length, 1);
  for (const p of [null, { state: 'open', headSha: NEW }, { state: 'open', mergeSha: OLD }, { state: 'closed', mergeSha: NEW }]) {
    assert.equal((await tick(f, { livePull: p })).state, 'HELD');
  }
  assert.equal(f.calls.length, 1);
  const after = await tick(f, { livePull: { state: 'open', mergeSha: NEW } });
  assert.equal(after.state, 'OBSERVATIONS_COLLECTED_NO_QUALIFICATION'); assert.equal(after.phase, 'after-ref-move');
  assert.deepEqual(f.calls[1].priorObservation, first.result);
  assert.equal(f.calls.length, 2); assert.equal(after.liveQualified, false);
  assert.equal((await tick(f)).phase, 'after-ref-move'); assert.equal(f.calls.length, 2);
  assert.equal((await f.holds.inspect(f.subject)).held, true);
});
test('two controller instances/concurrent calls perform one engine effect', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async (args, { success }) => { entered(); await gate; return success(args); });
  const first = tick(f); await ready;
  const second = await tick(f); assert.equal(second.state, 'HELD'); assert.equal(f.calls.length, 1);
  release(); assert.equal((await first).state, 'OBSERVATIONS_COLLECTED_NO_QUALIFICATION');
  assert.equal(f.calls.length, 1);
});
test('missing/torn intent or terminal and open attempts remain permanently held without engine repost', async t => {
  for (const kind of ['empty-attempt', 'torn-intent', 'missing-terminal']) {
    const f = await fixture(t), dir = path.join(f.book, 'initial', 'attempt-01');
    await fs.mkdir(dir, { recursive: true });
    if (kind === 'torn-intent') await fs.writeFile(path.join(dir, '00-intent.json'), '{');
    if (kind === 'missing-terminal') await fs.writeFile(path.join(dir, '00-intent.json'), JSON.stringify({ contract: 'not a valid intent' }));
    assert.equal((await tick(f)).state, 'HELD'); f.advance(86_400_000);
    assert.equal((await tick(f)).state, 'HELD'); assert.equal(f.calls.length, 0);
  }
});
test('strict preflight deferred retries at least five minutes apart, at most twelve attempts', async t => {
  for (const code of ['RELAY_QUALIFICATION_BUSY', 'RELAY_QUALIFICATION_WINDOW_UNCONFIRMED']) {
    const f = await fixture(t, () => deferred(code));
    for (let i = 1; i <= 12; i++) {
      assert.equal((await tick(f)).code, code); assert.equal(f.calls.length, i);
      f.advance(299_999); assert.equal((await tick(f)).state, 'HELD'); assert.equal(f.calls.length, i); f.advance(1);
    }
    assert.equal((await tick(f)).code, 'RELAY_QUALIFICATION_PREFLIGHT_RETRIES_EXHAUSTED'); assert.equal(f.calls.length, 12);
    const dirs = await fs.readdir(path.join(f.book, 'initial')); assert.equal(dirs.length, 12);
    for (const dir of dirs) assert.deepEqual((await fs.readdir(path.join(f.book, 'initial', dir))).sort(), ['00-intent.json', '10-result.json']);
  }
});
for (const [name, make] of [
  ['timeout', () => ({ ...deferred(), code: 'RELAY_QUALIFICATION_TERMINAL_UNCONFIRMED', deferred: true })],
  ['posteffect deferred', () => ({ ...deferred(), sideEffects: 1 })],
  ['true cleanup deferred', () => ({ ...deferred(), proof: { windowsTreeZero: true, serviceOriginalStopped: true } })],
  ['free-form error', () => { throw Object.defineProperty({}, 'code', { get() { throw Error('SECRET_CODE_GETTER'); } }); }],
  ['extra raw secret', () => ({ ok: true, PASS: true, token: 'SECRET_TOKEN_BODY' })],
  ['fake success flags', () => ({ ok: true, liveQualified: true })],
]) test(`${name} never retries or persists unverified data`, async t => {
  const f = await fixture(t, make);
  const result = await tick(f); assert.equal(result.state, 'HELD'); assert.equal(result.liveQualified, false);
  f.advance(86_400_000); assert.equal((await tick(f)).state, 'HELD'); assert.equal(f.calls.length, 1);
  assert.ok(!(await bookText(f.book)).includes('SECRET'));
});
test('wrong subject/phase, JWT-shaped claims or unknown fields cannot be stored as typed successful observations', async t => {
  for (const change of [r => r.observation.subjectSha256 = h('0'), r => r.observation.phase = 'after-ref-move',
    r => r.observation.roles[0].verifiedClaims.token = 'SECRET', r => r.observation.roles[0].verifiedClaims.sub = 'aaa.bbb.ccc',
    r => r.observationLocator.jobId = h('0'), r => r.observation.liveQualified = true, r => r.error = 'SECRET']) {
    const f = await fixture(t, (args, { success }) => { const r = clone(success(args)); change(r); return r; });
    assert.equal((await tick(f)).state, 'HELD'); f.advance(300_000); await tick(f); assert.equal(f.calls.length, 1);
    assert.ok(!(await bookText(f.book)).includes('SECRET'));
  }
});
test('stage1 reader is closed and bound to the real guard key/batch/job', async t => {
  const f = await fixture(t); assert.deepEqual(await f.holds.readStage1Locator(f.subject), f.stage1);
  const file = path.join(f.holds.directory(f.subject), '10-stage1-locator.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8')); saved.locator.jobId = h('0');
  await fs.writeFile(file, JSON.stringify(saved)); // only this newly created corrupt fixture
  assert.equal((await tick(f)).state, 'HELD'); assert.equal(f.calls.length, 0);
});
