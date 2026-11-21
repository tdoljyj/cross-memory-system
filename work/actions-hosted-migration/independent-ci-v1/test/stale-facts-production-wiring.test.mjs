// Generation 13 (resident DESIGN §57.2, §57.4; review round 1, MAJOR 1-3): the stale-facts and adopted-copy paths of the publisher
// as production assembles it, inside createRecoverableCheckPublisherV2 and its protected observation port (runtime/one-shot-v2.mjs).
// The protected observations before the write share the fixed 60 s window of Task a3ad42a9; those after it, the confirmation, have a
// 60 s window of their own, started by the first of them (Owner Decision 36946d8b, a change of the a3ad42a9 bound). A write that
// cannot be made in what is left of the pre-write window, or whose confirmation, estimated as long as the boundary before it, would
// not fit the post-write window, is not made (a clean, rerunnable BLOCKED). The production publication port refuses an admission
// answer older than FRESH_MS (prepareNativePublication), which is why an admission that aged before the write stops cleanly too.
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
import { protectedAuthority, createRecoverableCheckPublisherV2, createPublicationRecoveryAuditWriter, PUBLICATION_OBSERVE_BUDGET_MS, PUBLICATION_POST_WRITE_OBSERVE_BUDGET_MS } from '../runtime/one-shot-v2.mjs';
import { createIndependentPublicationPort } from '../../../../scripts/ci/clued-independent-publication-port.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult, admittedFacts, subject, withFastWallClock } from './resident-v2-fixtures.mjs';

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

test('one 60 s observation window before the write (Task a3ad42a9) and one of its own after it (Owner Decision 36946d8b)', () => {
  assert.equal(PUBLICATION_OBSERVE_BUDGET_MS, 60_000);
  assert.equal(PUBLICATION_POST_WRITE_OBSERVE_BUDGET_MS, 60_000);
});

for (const [name, admissions] of [['fast before, 35 s after (the PR #1001 incident)', [5000, 35000]], ['fast before, 40 s after', [5000, 40000]]]) {
  test(`production wiring: ${name}: the facts are observed again inside the window and the green stays`, async t => {
    const r = await run(t, admissions);
    assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  });
}

// Owner Decision 36946d8b: the two cases the one shared window could not settle (40 s + 40 s was never written, 5 s + 56 s was withdrawn).
for (const [name, admissions] of [['40 s before, 40 s after', [40000, 40000]], ['5 s before, 56 s after', [5000, 56000]]]) {
  test(`production wiring: ${name}: the confirmation has its own window and the green stays (Owner Decision 36946d8b)`, async t => {
    const r = await run(t, admissions);
    assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  });
}

// CI run 44895513321 (clued-company-win-01) had "5 s before, 56 s after" BLOCKED execution_proof_refused while it was green here:
// the fixture signed the result with the real clock and the publisher judged it with the fake one (task ce2e5c1a step 2). Under a
// wall clock that runs 2 s per read, every case above gives the same verdict.
for (const [name, admissions] of [['fast before, 35 s after', [5000, 35000]], ['40 s before, 40 s after', [40000, 40000]], ['5 s before, 56 s after', [5000, 56000]]]) {
  test(`production wiring: ${name} settles the same when the wall clock runs fast (a slow host)`, async t => {
    const r = await withFastWallClock(() => run(t, admissions));
    assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  });
}

test('production wiring: a boundary that leaves the write no room in the pre-write window: nothing is written, a clean BLOCKED, safe to run again', async t => {
  const r = await run(t, [56000]);
  assert.deepEqual([...outcome(r), r.result.safeToRerun, r.result.sideEffects], ['BLOCKED', 'publication_window_short_before_write', [], true, 0], JSON.stringify(r.result));
});

test('production wiring: a confirmation that outlasts its own window is withdrawn', async t => {
  const r = await run(t, [5000, 61000]);
  assert.deepEqual(outcome(r), ['REVOKED', 'protected_facts_reobservation_unavailable', ['failure']], JSON.stringify(r.result));
});

for (const [name, visibleAfter] of [['10 s', 10_000], ['25 s', 25_000]]) {
  test(`production wiring: a lost create whose exact copy shows up ${name} later is adopted and settles`, async t => {
    const r = await run(t, [], clock => ({ changeGithub: gh => {
      let hidden = null, at = 0; const read = gh.readChecks.bind(gh);
      gh.createCheck = async body => { hidden = { id: 500, app: { id: 5368905 }, ...structuredClone(body) }; at = clock.now + visibleAfter; throw lostCreate(); };
      gh.readChecks = async head => { if (hidden && clock.now >= at) { gh.checks.push(hidden); hidden = null; } return read(head); };
    } }));
    assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
    assert.equal(r.checks.length, 1, 'never sent again');
  });
}

test('production wiring: the adopt reads do not use the confirmation\'s window: all are made after a slow boundary, and a copy 25 s late still settles', async t => {
  const reads = [];
  const r = await run(t, [20000], clock => ({ changeGithub: gh => {
    let hidden = null, at = 0; const read = gh.readChecks.bind(gh);
    gh.createCheck = async body => { hidden = { id: 500, app: { id: 5368905 }, ...structuredClone(body) }; at = clock.now + 25_000; throw lostCreate(); };
    gh.readChecks = async head => { if (hidden || at) reads.push(clock.now); if (hidden && clock.now >= at) { gh.checks.push(hidden); hidden = null; } return read(head); };
  } }));
  assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  assert.ok(reads.length >= ADOPT_READ_DELAYS_MS.length, `every adopt read was made (${reads.length} reads)`);
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

// Review round 3, MINOR 1, with Owner Decision 36946d8b: the same slow line before and after the write, observation 28 s (two 9 s
// timeouts, 1 s + 2 s waits, a 7 s answer) and admission 6 s. Under the one shared window this could not be written (34 s used, a
// confirmation as long did not fit what was left); each side now has its own window and it settles. That the estimate counts the
// boundary's first observation is test/stale-facts-publish.test.mjs (writeFits).
test('production wiring: a slow line before and after the write settles: each side has its own window', async t => {
  const clock = { now: Date.now() };
  const slowObservation = (c, now) => [{ took: 9000, then: timeout() }, { took: 9000, then: timeout() }, () => ({ took: 7000, then: reply(200, verifyBody(c, now())) })];
  const steps = (c, now) => [...slowObservation(c, now), ...slowObservation(c, now), () => reply(200, verifyBody(c, now()))];
  const r = await publisherWith(t, steps, { recover: true, clock, admissions: [6000, 6000] });
  assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
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

// Review round 6, MAJOR 1 and NIT 2: what is left of the pre-write window must hold the write's own Native calls, estimated from the
// slowest round trip Native answered before it (WRITE_NATIVE_CALLS of them plus WRITE_MARGIN_MS). A 9 s round trip and a 30 s admission
// leave 21 s, less than 5 + 2 x 9: nothing is written (the confirmation alone, 39 s + 5 s, would fit its own window). A 6 s round trip
// leaves 24 s, more than 5 + 2 x 6: it settles.
for (const [roundTrip, expected] of [[9000, 'BLOCKED'], [6000, 'SETTLED']]) {
  test(`production wiring: a ${roundTrip / 1000} s Native round trip before the write and a 30 s admission: ${expected}`, async t => {
    const clock = { now: Date.now() };
    const steps = (c, now) => [() => ({ took: roundTrip, then: reply(200, verifyBody(c, now())) }), () => reply(200, verifyBody(c, now()))];
    const r = await publisherWith(t, steps, { recover: true, clock, admissions: [30000, 0] });
    if (expected === 'SETTLED') assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
    else assert.deepEqual([...outcome(r), r.result.safeToRerun, r.result.sideEffects], ['BLOCKED', 'publication_window_short_before_write', [], true, 0], JSON.stringify(r.result));
  });
}

// Review round 6, MINOR 1: the post-write window starts at the first observation after the write, not at the write. A lost create whose
// copy shows up 25 s later takes the adopt reads 35 s; the confirmation then needs 40 s more (an admission that long, and its facts
// observed once more). From the write that is 75 s, past 60; from the first post-write observation it is 40 s: it settles.
test('production wiring: the window of the confirmation starts at its first observation, after the adopt reads', async t => {
  const r = await run(t, [5000, 40000], clock => ({ changeGithub: gh => {
    let hidden = null, at = 0; const read = gh.readChecks.bind(gh);
    gh.createCheck = async body => { hidden = { id: 500, app: { id: 5368905 }, ...structuredClone(body) }; at = clock.now + 25_000; throw lostCreate(); };
    gh.readChecks = async head => { if (hidden && clock.now >= at) { gh.checks.push(hidden); hidden = null; } return read(head); };
  } }));
  assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  assert.equal(r.checks.length, 1, 'never sent again');
});

// Review round 7, MAJOR 1: a timeout says the line is at least that slow. Two 9.5 s timeouts, a 1 s answer and a 25 s admission leave
// 12 s of the pre-write window; the write's Native calls are estimated from the slowest attempt, timed out or not (5 + 2 x 9.5 s): nothing
// is written, a clean BLOCKED. Counting only answered attempts (5 + 2 x 1 s) would write, and a write step as slow as the line would then
// meet the reserve at the create (UNCERTAIN, the node HALTs).
test('production wiring: timed-out attempts count in the estimate of the Native calls of the write', async t => {
  const clock = { now: Date.now() };
  const steps = (c, now) => [{ took: 9500, then: timeout() }, { took: 9500, then: timeout() }, () => ({ took: 1000, then: reply(200, verifyBody(c, now())) }), () => reply(200, verifyBody(c, now()))];
  const r = await publisherWith(t, steps, { recover: true, clock, admissions: [25000, 0] });
  assert.deepEqual([...outcome(r), r.result.safeToRerun, r.result.sideEffects], ['BLOCKED', 'publication_window_short_before_write', [], true, 0], JSON.stringify(r.result));
});

// Review round 7, MINOR 1: the a3ad42a9 recovery is unchanged. The first try is exhausted by slow 504 answers (9.5 s, 9.5 s, 7 s); the
// second try answers at once and its admission takes 10 s, leaving about 21 s. Its estimate is its own (the first try's slow answers are
// not carried over), so it writes and settles, as before generation 13.
test('production wiring: the second try of the recovery estimates from its own observations and settles', async t => {
  const clock = { now: Date.now() };
  const steps = (c, now) => [{ took: 9500, then: reply(504, {}) }, { took: 9500, then: reply(504, {}) }, { took: 7000, then: reply(504, {}) }, () => reply(200, verifyBody(c, now()))];
  const logs = [];
  const r = await publisherWith(t, steps, { recover: true, clock, admissions: [10000, 0], log: (kind, data) => logs.push({ kind, data }) });
  assert.deepEqual(outcome(r), ['SETTLED', null, ['success']], JSON.stringify(r.result));
  assert.equal(logs.filter(x => x.kind === 'publication_recovery_result').at(-1).data.publisherAttempts, 2);
});
