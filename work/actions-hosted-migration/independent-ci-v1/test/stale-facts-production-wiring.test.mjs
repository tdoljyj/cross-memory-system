// Generation 13 (resident DESIGN §57.2, §57.4; review round 1, MAJOR 1-3): the stale-facts and adopted-copy paths of the publisher
// as production assembles it, inside createRecoverableCheckPublisherV2 and its protected observation port (runtime/one-shot-v2.mjs).
// Every protected observation of a publication, before and after the write, shares the fixed 60 s window of Task a3ad42a9 (unchanged):
// a write whose confirmation, estimated as long as the boundary before it, would not fit what is left is not made (a clean, rerunnable
// BLOCKED). The production publication port refuses an admission answer older than FRESH_MS (prepareNativePublication), which is why an
// admission that aged before the write stops cleanly too.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, makeJobV2, scanEffectKeyV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { retainServerAnswerForFacts } from '../src/clock-skew.mjs';
import { ADOPT_READ_DELAYS_MS, createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { protectedAuthority, createRecoverableCheckPublisherV2, createPublicationRecoveryAuditWriter, PUBLICATION_OBSERVE_BUDGET_MS } from '../runtime/one-shot-v2.mjs';
import { createIndependentPublicationPort } from '../../../../scripts/ci/clued-independent-publication-port.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult, admittedFacts, subject } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const jobsFor = () => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 });
const claim = () => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) });

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
// fetch's network failures as undici gives them: a TypeError whose cause carries the socket or DNS code.
const network = (message = 'fetch failed', code = 'UND_ERR_SOCKET') => new TypeError(message, { cause: Object.assign(new Error('other side closed'), { code }) });
// A verify reply for `c` as Native gives it, verified at `at`.
const verifyBody = (c, at) => ({ status: 'ok', verdict: 'ADMITTED', execution_policy: 'staged', current_fence: c.fence, execution_epoch: c.epoch, paths_outside_write_set: [],
  verified_at: iso(at), claim: { claim_id: c.claimId, fence: c.fence, execution_epoch: c.epoch, context_key: 'project:x', status: 'ACTIVE', lease_key_required: false,
    execution_handover_pending: false, expires_at: c.expiresAt } });
const reply = (status, body, { cancelled = null } = {}) => ({ status, async json() { if (body instanceof Error) throw body; return structuredClone(body); },
  body: { async cancel() { if (cancelled) cancelled.count++; } } });

// A scripted Native verify endpoint: each step is a reply, an error to throw, or a function of the call.
// `clock` is a fake time the script may advance (a step that "took" ms).
function scripted(steps, { clock = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    const value = typeof step === 'function' ? await step(calls.length, opts) : step;
    if (Number.isFinite(value?.took) && clock) clock.now += value.took;
    const result = Number.isFinite(value?.took) ? value.then : value;
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetchImpl, calls };
}

// With a fake `clock` (both the wall clock and the monotonic one), every attempt's signal is a fake one that records its
// timeout (signals) and is never aborted.
function authorityWith({ fetchImpl, accepted = Object.fromEntries(REFS.map(k => [k, randomUUID()])), ciPrincipalBindingId = randomUUID(), clock = null, live = () => {}, sleepDelay = 0 }) {
  const waits = [], logs = [], signals = [];
  const config = { supabaseUrl: 'https://x.supabase.co/', publishableKey: 'k', scope: 'project:x', ciPrincipalBindingId };
  const auth = protectedAuthority({ config, accepted, github: { async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; } },
    fetchImpl, nativeToken: 't', live, log: (kind, data) => logs.push({ kind, data: structuredClone(data) }),
    ...(clock ? { clock: () => clock.now, monotonic: () => clock.now, sleep: async ms => { waits.push(ms); clock.now += ms + sleepDelay; }, timeoutSignal: ms => { signals.push(ms); return new AbortController().signal; } }
      : { sleep: async ms => { waits.push(ms); } }) });
  return { auth, waits, logs, signals };
}

async function publisherWith(t, steps, { recover = false, clock = null, changeGithub = () => {}, readClaim = null, log = () => {}, serverOffset = 0, admissions = [] } = {}) {
  let evals = 0;
  const now = () => clock ? clock.now : Date.now();
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = jobsFor().trivy, c = claim();
  if (serverOffset) c.expiresAt = iso(now() + serverOffset + 60_000);
  const fixtureRoot = await tempDir(t), auditRoot = path.join(fixtureRoot, 'audit');
  await fs.mkdir(auditRoot);
  const journal = await EffectJournal.open(path.join(fixtureRoot, 'effects'));
  const accepted = Object.fromEntries(REFS.map(k => [k, record.accepted[k]]));
  const checks = []; let next = 100;
  const github = { fixture: true, checks,
    async readChangedPaths(j) { return { complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { return { complete: true, checks: checks.filter(x => x.head_sha === head).map(x => structuredClone(x)) }; },
    async createCheck(body) { const x = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(x); return structuredClone(x); },
    async revokeCheck(id, body) { const x = checks.find(y => y.id === id); Object.assign(x, structuredClone(body)); return structuredClone(x); } };
  const observed = { claimId: c.claimId, fence: c.fence, epoch: c.epoch, expiresAt: c.expiresAt }, slotUntil = iso(Date.now() + 3600_000);
  const nativeAdmission = { fixture: true, async evaluatePr(j, packet, options) {
    if (clock) clock.now += admissions[evals++] ?? 0;
    const facts = { contract: 'clued.independent-ci.full-admission/2', status: 'ADMITTED', admitted: true, completeAdmission: true, evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate',
      domain: 'fixture', repository: REPO, scope: 'project:x', prRef: `${REPO}#${j.pr}`, headSha: j.headSha, baseSha: j.baseSha, jobId: j.id, role: j.role, attempt: j.attempt,
      claimId: observed.claimId, fence: observed.fence, epoch: observed.epoch, observedClaim: { ...observed }, batchClaimBound: options?.batchClaim ? claimGeneration(options.batchClaim) : null,
      sourceManifestSha256: j.sourceManifestSha256, executionPolicy: 'staged', guarded: false, executionHandoverPending: false, mergeQueueHead: false,
      mode: { state: 'normal', layer: 'code', policyVersion: 1 }, mergeSlot: { state: 'held', ref: `merge:${REPO}:main`, tip: j.baseSha, until: slotUntil },
      ownerReview: null, workflowGateFindings: [], observedAt: iso(now()), claimExpiresAt: observed.expiresAt, modeProofRef: 'mode', observationRef: 'obs',
      packetSha256: digest(packet), evaluationSha256: digest('evaluation') };
    const result = { ...facts, observationSha256: digest(facts) };
    return serverOffset ? retainServerAnswerForFacts(result,
      { verifiedAt: iso(now() + serverOffset), expiresAt: observed.expiresAt, sentMono: now() }, now) : result;
  } };
  changeGithub(github);
  const verify = scripted(steps(c, now), { clock });
  const { auth, waits } = authorityWith({ fetchImpl: verify.fetchImpl, accepted, ciPrincipalBindingId: record.config.ciPrincipalBindingId, clock });
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const publisherOptions = { nativeAdmission, authority: { fixture: true, observe: auth.observe }, github, journal, signers, configuredChecks: record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...accepted },
    batchClaim: claimGeneration(c), domain: 'fixture', clock: now, sleep: async ms => { if (clock) clock.now += ms; } };
  const recoveryContext = { nonce: randomUUID().replaceAll('-', ''), stage: 5, entryRole: 'check-publisher', batchKey: digest('fixture-batch'),
    configSha256: digest('fixture-config'), sourceManifestSha256: job.sourceManifestSha256, acceptanceSha256: digest('fixture-acceptance'), entrySha256: digest('fixture-entry') };
  const publisher = recover ? createRecoverableCheckPublisherV2({ publisherOptions, recoveryContext,
    auditWriter: createPublicationRecoveryAuditWriter({ context: recoveryContext, domain: 'fixture', fixtureDirectory: auditRoot }), authorityOptions: {
    config: { supabaseUrl: 'https://x.supabase.co/', publishableKey: 'k', scope: 'project:x', ciPrincipalBindingId: record.config.ciPrincipalBindingId },
    accepted, fetchImpl: verify.fetchImpl, nativeToken: 't', sleep: async ms => { if (clock) clock.now += ms; }, timeoutSignal: () => new AbortController().signal },
    readCurrentBatchClaim: readClaim ?? (async () => claimGeneration(c)), live() {}, log, clock: now,
    ...(clock ? { monotonic: now } : {}) }) : createStagedCheckPublisherV2(publisherOptions);
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const result = await publisher.publish({ job, envelope });
  return { result, checks, waits, calls: verify.calls, journal, key: scanEffectKeyV2(job, record.config.checks.trivy) };
}

const run = (t, admissions, opts = () => ({})) => { const clock = { now: Date.now() };
  return publisherWith(t, (c, now) => [() => reply(200, verifyBody(c, now()))], { recover: true, clock, admissions, ...opts(clock) }); };
const outcome = r => [r.result.status, r.result.reason ?? null, r.checks.map(x => x.conclusion)];
const lostCreate = () => Object.assign(new Error('github_http_502'), { code: 'github_http_502', retryable: true, unsent: false, ambiguous: true });

test('one observation window for the whole publication, before and after the write (Task a3ad42a9, unchanged)', () => {
  assert.equal(PUBLICATION_OBSERVE_BUDGET_MS, 60_000);
});

for (const [name, admissions] of [['fast before, 35 s after (the PR #1001 incident)', [5000, 35000]], ['fast before, 40 s after', [5000, 40000]]]) {
  test(`production wiring: ${name}: the facts are observed again inside the window and the green stays`, async t => {
    const r = await run(t, admissions);
    assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  });
}

test('production wiring: a boundary so slow that a confirmation as long would not fit the window: nothing is written, a clean BLOCKED, safe to run again', async t => {
  const r = await run(t, [40000, 40000]);
  assert.deepEqual([...outcome(r), r.result.safeToRerun, r.result.sideEffects], ['BLOCKED', 'publication_window_short_before_write', [], true, 0], JSON.stringify(r.result));
});

test('production wiring: the estimate is the boundary before the write; a confirmation slower than it still cannot outlast the window and is withdrawn', async t => {
  const r = await run(t, [5000, 56000]);
  assert.deepEqual(outcome(r), ['REVOKED', 'protected_facts_reobservation_unavailable', ['failure']], JSON.stringify(r.result));
});

for (const [name, visibleAfter] of [['10 s', 10_000], ['25 s', 25_000]]) {
  test(`production wiring: a lost create whose exact copy shows up ${name} later is adopted inside the window and settles`, async t => {
    const r = await run(t, [], clock => ({ changeGithub: gh => {
      let hidden = null, at = 0; const read = gh.readChecks.bind(gh);
      gh.createCheck = async body => { hidden = { id: 500, app: { id: 5368905 }, ...structuredClone(body) }; at = clock.now + visibleAfter; throw lostCreate(); };
      gh.readChecks = async head => { if (hidden && clock.now >= at) { gh.checks.push(hidden); hidden = null; } return read(head); };
    } }));
    assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
    assert.equal(r.checks.length, 1, 'never sent again');
  });
}

test('production wiring: no adopt read is made that would leave the confirmation no room in the window', async t => {
  const reads = [];
  const r = await run(t, [20000], clock => ({ changeGithub: gh => {
    const read = gh.readChecks.bind(gh); let failed = false;
    gh.createCheck = async () => { failed = true; throw lostCreate(); };
    gh.readChecks = async head => { if (failed) reads.push(clock.now); return read(head); };
  } }));
  assert.notEqual(r.result.status, 'SETTLED', JSON.stringify(r.result));
  assert.ok(reads.length >= 1 && reads.length < 1 + ADOPT_READ_DELAYS_MS.length, `the late adopt reads were not made (${reads.length} reads)`);
});

test('the production publication port refuses an admission answer older than FRESH_MS: an aged admission is never written under', async t => {
  const now = Date.parse('2026-10-29T05:00:00Z');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'g13-port-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const job = makeJobV2({ ...subject(), testSha: subject().headSha, role: 'gitleaks' });
  const claim = { claimId: '11111111-2222-4333-8444-555555555555', fence: 4, epoch: 3, expiresAt: new Date(now + 3600_000).toISOString() };
  const packet = { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.mjs'] };
  const facts = admittedFacts(job, claim, packet, { batchClaim: claim, observedAt: now });
  let clk = now + 40_000;
  const port = createIndependentPublicationPort({ job, controllerId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    github: { createCheck: async () => {}, revokeCheck: async () => {}, readChecks: async () => ({ complete: true, checks: [] }) },
    native: { command: async () => ({}) }, journal: await EffectJournal.open(directory), clock: () => clk, assertCurrent: async () => true });
  const payload = { name: 'gitleaks', head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: 'x', output: { title: 't', summary: 's' } };
  await assert.rejects(port.prepareNativePublication({ facts, packet, payload }), { code: 'independent_complete_admission_required' });
  clk = now + 10_000;
  assert.equal((await port.prepareNativePublication({ facts, packet, payload })).native, false);
});

// Review round 2, MAJOR A: the facts observed once more after a slow admission (liveFacts) get no answer (Native verify 503 until its
// retries are spent), or the admission alone outlasts the window. Nothing was recorded or written: a clean BLOCKED, safe to run again,
// never the recoverable publisher's UNCERTAIN (which would HALT the node).
for (const [name, steps, admissions] of [['Native verify 503 on the re-observation', (c, now) => [() => reply(200, verifyBody(c, now())), () => reply(503, {})], [35000]],
  ['an admission slower than the whole window', (c, now) => [() => reply(200, verifyBody(c, now()))], [61000]]]) {
  test(`production wiring: the re-observation after the admission cannot be made (${name}): a clean BLOCKED, never UNCERTAIN`, async t => {
    const clock = { now: Date.now() };
    const r = await publisherWith(t, steps, { recover: true, clock, admissions });
    assert.deepEqual([r.result.status, r.result.reason, r.result.safeToRerun, r.result.mayHavePublished ?? false, r.result.sideEffects, r.checks.length],
      ['BLOCKED', 'protected_facts_reobservation_unavailable', true, false, 0, 0], JSON.stringify(r.result));
    assert.equal(await r.journal.read(r.key), null);
  });
}

test('production wiring: an admission that aged during a slow read-back after the write is evaluated again, completely, inside the window', async t => {
  const r = await run(t, [5000, 5000, 0], clock => ({ changeGithub: gh => {
    const read = gh.readChecks.bind(gh); let slowed = false;
    gh.readChecks = async head => { const l = await read(head); if (l.checks.length && !slowed) { slowed = true; clock.now += 31_000; } return l; };
  } }));
  assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
});

test('an UNCERTAIN of the recoverable publisher never carries the rerun flag of the result it replaces (review round 2, MAJOR A)', async t => {
  // an exhaustion code the observation port never latched: the recoverable publisher cannot prove it, so the result is UNCERTAIN
  const r = await run(t, [], () => ({ changeGithub: gh => {
    gh.readChangedPaths = async () => { throw Object.assign(new Error('native_claim_observation_unavailable'), { code: 'native_claim_observation_unavailable' }); };
  } }));
  assert.deepEqual([r.result.status, r.result.reason, r.result.mayHavePublished, 'safeToRerun' in r.result], ['UNCERTAIN', 'publication_recovery_unconfirmed', true, false], JSON.stringify(r.result));
});

// Review round 3, MINOR 1: the estimate counts the boundary's first observation too. Same slow line before and after the write:
// observation 28 s (two 9 s timeouts, 1 s + 2 s waits, a 7 s answer), admission 6 s. Before the write 34 s of the window are used and
// 26 s are left; a confirmation as long (34 s + 5 s) cannot fit: a clean, rerunnable BLOCKED, never a check withdrawn after the write.
test('production wiring: the estimate includes the boundary\'s first observation, retries and waits included', async t => {
  const clock = { now: Date.now() };
  const slowObservation = (c, now) => [{ took: 9000, then: timeout() }, { took: 9000, then: timeout() }, () => ({ took: 7000, then: reply(200, verifyBody(c, now())) })];
  const steps = (c, now) => [...slowObservation(c, now), ...slowObservation(c, now), () => reply(200, verifyBody(c, now()))];
  const r = await publisherWith(t, steps, { recover: true, clock, admissions: [6000, 6000] });
  assert.deepEqual([r.result.status, r.result.reason, r.result.safeToRerun, r.checks.length], ['BLOCKED', 'publication_window_short_before_write', true, 0], JSON.stringify(r.result));
});

test('a check withdrawn because Native could not be read after the write says so: verification unavailable, never "authorization changed"', async () => {
  const { withdrawalTitle, withdrawalNote, verificationUnavailable } = await import('../src/withdrawal-text.mjs');
  for (const cause of ['native_claim_observation_unavailable', 'protected_facts_reobservation_unavailable']) {
    assert.equal(withdrawalTitle('Independent CI', cause), 'Independent CI check withdrawn: verification unavailable', cause);
    assert.match(withdrawalNote(cause), /no change of it was observed/, cause);
    assert.equal(verificationUnavailable(cause), false, 'the read set of stage 1 and of safeToRerun is unchanged');
  }
  assert.equal(withdrawalTitle('Independent CI', 'authorization_binding_changed'), 'Independent CI authorization changed');
});
