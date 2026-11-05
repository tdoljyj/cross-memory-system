// A passing GitHub 5xx on a read must not burn a head (11-04, PR #992, head df85e68d, attempt 2, stage 1: github_http_502
// inside the after-write boundary of the work-admission publisher withdrew the check and burned the head).
//   1. read-retry.mjs: reads (GET) are repeated on 500/502/503/504 or a network failure, with exponential backoff, inside a
//      shared budget and the stage's live() deadline; writes and Native RPCs (POST) never; nothing else is retried.
//   2. controllerPorts wires it around every GitHub read of the controller (publishers' and the evaluator's alike).
//   3. When the retry is used up: before any write the publication is a clean BLOCKED with zero side effects (the resident's
//      GITHUB_TRANSIENT_UNAVAILABLE: attempt 2 / the stage's transient path); after the write the check is withdrawn and the
//      title says the verification was unavailable, not that the authorization changed; if even the withdrawal cannot be
//      confirmed it stays UNCERTAIN for reconciliation, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createFixtureWorkAdmissionPublisherV2, refusalSafeToRerun, VERIFY_REREAD_DELAYS_MS, VERIFY_WAIT_WINDOW_MS, VERIFY_REVOKE_RESERVE_MS } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { transportFault } from '../src/full-admission-v2.mjs';
import { sanitizeAdmissionDiagnosticV2 } from '../src/admission-facts-v2.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { withReadRetry, READ_RETRY_DELAYS_MS, READ_RETRY_BUDGET_MS } from '../src/read-retry.mjs';
import { withdrawalTitle, verificationUnavailable, admissionVerificationRetryable, ADMISSION_REREAD_REASONS } from '../src/withdrawal-text.mjs';
import { controllerPorts } from '../src/resident-v2/entry-runtime.mjs';
import { outcomeFailureCode, outcomeFacts, TRANSIENT_CODES } from '../src/resident-v2/stage-fact.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const reply = status => new Response(status === 200 ? '{"ok":true}' : '{}', { status });
const netFault = code => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

// ---- 1. the retry wrapper -------------------------------------------------------------------------------------------
function scripted(answers) {
  const calls = [];
  const fn = async (url, opts = {}) => { calls.push({ url, method: opts.method ?? 'GET', signal: opts.signal }); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; if (a instanceof Error) throw a; return typeof a === 'number' ? reply(a) : a; };
  return { fn, calls };
}
const harness = (answers, options = {}) => { const s = scripted(answers), sleeps = []; return { ...s, sleeps, fetch: withReadRetry(s.fn, { sleep: async ms => { sleeps.push(ms); }, ...options }) }; };

test('read retry: a 5xx on a read is repeated with exponential backoff and the later 200 is returned', async () => {
  for (const status of [500, 502, 503, 504]) {
    const h = harness([status, status, 200]);
    const r = await h.fetch('https://api.github.com/repos/x/y/pulls/1');
    assert.equal(r.status, 200, String(status));
    assert.deepEqual(h.sleeps, [1000, 2000]);
    assert.equal(h.calls.length, 3);
  }
  assert.deepEqual([...READ_RETRY_DELAYS_MS], [1000, 2000, 4000, 8000]);
});

test('read retry: a network failure on a read is repeated; any other rejection is thrown at once', async () => {
  const h = harness([netFault('ECONNRESET'), netFault('ETIMEDOUT'), 200]);
  assert.equal((await h.fetch('https://api.github.com/x')).status, 200);
  assert.deepEqual(h.sleeps, [1000, 2000]);
  const abort = harness([Object.assign(new Error('aborted'), { name: 'AbortError' }), 200]);
  await assert.rejects(abort.fetch('https://api.github.com/x'), { name: 'AbortError' });
  const odd = harness([new TypeError('Invalid URL'), 200]);
  await assert.rejects(odd.fetch('https://api.github.com/x'), { message: 'Invalid URL' });
  assert.equal(abort.calls.length + odd.calls.length, 2, 'no repeat');
});

test('read retry: writes and Native RPCs (POST/PATCH) are never repeated, whatever they answer', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const h = harness([502, 200]);
    assert.equal((await h.fetch('https://api.github.com/repos/x/y/check-runs', { method })).status, 502, method);
    assert.equal(h.calls.length, 1, method);
    const net = harness([netFault('ECONNRESET'), 200]);
    await assert.rejects(net.fetch('https://x.supabase.co/rest/v1/rpc/clued_work_verify_v1', { method }), TypeError);
    assert.equal(net.calls.length, 1, method);
  }
});

test('read retry: only 500/502/503/504 are passing faults; 501, 4xx (403, 404, 429), redirects and successes are returned as they are', async () => {
  for (const status of [200, 201, 301, 400, 401, 403, 404, 409, 422, 429, 501]) {
    const h = harness([status, 200]);
    assert.equal((await h.fetch('https://api.github.com/x')).status, status);
    assert.equal(h.calls.length, 1, String(status));
  }
});

test('read retry: when the delays or the budget are used up the LAST answer comes back unchanged (the caller classifies it as before)', async () => {
  const h = harness([502, 502, 502, 502, 502, 502]);
  const r = await h.fetch('https://api.github.com/x');
  assert.equal(r.status, 502);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000, 8000]);
  assert.equal(h.calls.length, 5);
  // the budget is shared by the calls of one wrapper (one stage): 20 s in all
  assert.equal(READ_RETRY_BUDGET_MS, 20_000);
  const next = await h.fetch('https://api.github.com/y');
  assert.equal(next.status, 502);
  assert.deepEqual(h.sleeps.slice(4), [1000, 2000], 'only what is left of the 20 s: 15 s are gone, 3 s more fit, 4 s do not');
  assert.ok(h.sleeps.reduce((a, b) => a + b, 0) <= READ_RETRY_BUDGET_MS);
  await h.fetch('https://api.github.com/z');
  assert.equal(h.sleeps.length, 7, 'a last 1 s fits (19 s); then 1 s is left and the next delay is 1 s: it fits too');
  await h.fetch('https://api.github.com/w');
  assert.ok(h.sleeps.reduce((a, b) => a + b, 0) <= READ_RETRY_BUDGET_MS);
  const total = h.sleeps.length;
  await h.fetch('https://api.github.com/v');
  assert.equal(h.sleeps.length, total, 'the budget is spent: nothing more is repeated');
  const net = harness([netFault('ECONNRESET')], { delaysMs: [1, 1], budgetMs: 100 });
  await assert.rejects(net.fetch('https://api.github.com/x'), e => e.cause?.code === 'ECONNRESET');
  assert.equal(net.calls.length, 3);
});

test('read retry: the stage deadline (live) ends the wait; a repeat gets a fresh timeout; the config is validated', async () => {
  let alive = true;
  const h = harness([502, 200], { live: () => { if (!alive) throw Object.assign(new Error('stage_deadline'), { code: 'stage_deadline' }); } });
  alive = false;
  await assert.rejects(h.fetch('https://api.github.com/x'), { code: 'stage_deadline' });
  assert.equal(h.sleeps.length, 0, 'it never slept past the deadline');
  const t = harness([502, 200]);
  const first = AbortSignal.timeout(30_000);
  await t.fetch('https://api.github.com/x', { signal: first });
  assert.equal(t.calls[0].signal, first);
  assert.notEqual(t.calls[1].signal, first);
  const seen = []; const o = harness([503, 200], { onRetry: r => seen.push(r) });
  await o.fetch('https://api.github.com/x');
  assert.deepEqual(seen, [{ attempt: 1, delayMs: 1000, status: 503, network: null }]);
  assert.throws(() => withReadRetry(null), /read_retry_configuration_invalid/);
  assert.throws(() => withReadRetry(() => {}, { delaysMs: [0] }), /read_retry_configuration_invalid/);
  assert.throws(() => withReadRetry(() => {}, { budgetMs: -1 }), /read_retry_configuration_invalid/);
});

// Review of gen8, finding 4: attempt timeouts follow the stage's own deadline, and the reads before the first check write cannot use up the
// retries of the verification after it.
test('read retry: every attempt is cut to what is left of the stage deadline, and no wait runs past it', async () => {
  let clock = 1_000_000; const end = clock + 5_500;
  const h = harness([502], { deadlineAt: () => end, now: () => clock, sleep: async ms => { clock += ms; } });
  const r = await h.fetch('https://api.github.com/x');
  assert.equal(r.status, 502, 'after the 1 s and 2 s waits 2.5 s are left: the 4 s wait does not start, so the last answer comes back');
  assert.equal(h.calls.length, 3);
  // attempt timeouts: min(30 s, left). Left is 5.5 s, 4.5 s, 2.5 s; each attempt's signal fires by then and not at 30 s
  for (const c of h.calls) assert.ok(c.signal instanceof AbortSignal, 'a signal bounded by the deadline');
  const far = harness([502, 200], { deadlineAt: () => clock + 3_600_000, now: () => clock });
  await far.fetch('https://api.github.com/x');
  assert.equal(far.calls[0].signal, undefined, 'a far deadline leaves the first attempt as the caller made it');
  const none = harness([502, 200], {});
  await none.fetch('https://api.github.com/x');
  assert.equal(none.calls[0].signal, undefined);
  // the signal of an attempt with 40 ms left fires within a moment (not after 30 s)
  const near = harness([200], { deadlineAt: () => clock + 40, now: () => clock });
  await near.fetch('https://api.github.com/x');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(near.calls[0].signal.aborted, true);
});

test('read retry: a check write starts a new budget, so the verification after it keeps its retries', async () => {
  const h = harness([502], { resetOn: (url, opts) => opts?.method === 'POST' && /\/check-runs/.test(url) });
  await h.fetch('https://api.github.com/repos/x/y/pulls/1'); // before the write: the whole 20 s budget is used up (1+2+4+8 = 15 s; 5 s left)
  const before = h.sleeps.length;
  await h.fetch('https://api.github.com/repos/x/y/pulls/1');
  assert.ok(h.sleeps.length - before <= 3, 'without a write, only the 5 s that are left');
  await h.fetch('https://api.github.com/repos/x/y/check-runs', { method: 'POST' });
  const after = h.sleeps.length;
  await h.fetch('https://api.github.com/repos/x/y/pulls/1');
  assert.deepEqual(h.sleeps.slice(after, after + 4), [1000, 2000, 4000, 8000], 'a fresh budget after the check write');
  // another request that is not a check write does not reset
  const g = harness([502], { resetOn: (url, opts) => opts?.method === 'POST' && /\/check-runs/.test(url) });
  await g.fetch('https://api.github.com/x'); await g.fetch('https://api.github.com/repos/x/y/pulls/1', { method: 'PATCH' }); const n = g.sleeps.length;
  await g.fetch('https://api.github.com/y');
  assert.ok(g.sleeps.length - n <= 3);
});

test('read retry: controllerPorts resets the budget on a write to /check-runs only and passes the stage deadline on', async () => {
  const record = { config: { repository: REPO, scope: `project:${randomUUID()}`, supabaseUrl: 'https://example.invalid', publishableKey: 'sb_publishable_test' }, accepted: {}, ciTokenPinSha256: 'a'.repeat(64) };
  const s = scripted([502, 502, 502, 502, 502, 200, 502, 502, 502, 502, 502, 200]); const sleeps = [];
  const live = () => {}; live.deadlineAt = Date.now() + 3_600_000;
  const ports = controllerPorts({ record, appKey: null, nativeToken: 'clued_bnd_testtoken', policyText: '{}', sourceRoot: process.cwd(), live, log() {}, baseFetch: s.fn, readRetry: { sleep: async ms => { sleeps.push(ms); } } });
  await ports.fetchImpl('https://api.github.com/repos/x/y/pulls/1');
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
  await ports.fetchImpl('https://api.github.com/repos/x/y/check-runs/9', { method: 'PATCH', body: '{}' }); // a withdrawal also ends the phase
  await ports.fetchImpl('https://api.github.com/repos/x/y/pulls/1');
  assert.deepEqual(sleeps.slice(4), [1000, 2000, 4000, 8000], 'a full budget after the check write');
});

// ---- 2. controllerPorts ---------------------------------------------------------------------------------------------
test('controllerPorts: every GitHub read of the controller is retried; its writes and the Native RPC are not', async () => {
  const record = { config: { repository: REPO, scope: `project:${randomUUID()}`, supabaseUrl: 'https://example.invalid', publishableKey: 'sb_publishable_test' }, accepted: {}, ciTokenPinSha256: 'a'.repeat(64) };
  const s = scripted([502, 503, 200, 502, 200, 502]); const logged = [], sleeps = [];
  const ports = controllerPorts({ record, appKey: null, nativeToken: 'clued_bnd_testtoken', policyText: '{}', sourceRoot: process.cwd(), live() {}, log: (k, d) => logged.push([k, d]),
    baseFetch: s.fn, readRetry: { sleep: async ms => { sleeps.push(ms); } } });
  assert.equal((await ports.fetchImpl('https://api.github.com/repos/x/y/pulls/1')).status, 200);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(logged.map(([k]) => k), ['github_read_retry', 'github_read_retry']);
  assert.equal((await ports.fetchImpl('https://api.github.com/repos/x/y/check-runs/9', { method: 'PATCH', body: '{}' })).status, 502, 'a write is sent once');
  assert.equal(s.calls.length, 4);
  assert.equal(s.calls.filter(c => c.method === 'PATCH').length, 1);
});

// ---- 3. publishers: what is left when the retry is used up -----------------------------------------------------------
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });
const jobsFor = (attempt = 1) => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt });
const SLOT_UNTIL = iso(Date.now() + 3600_000);
const blocked = (reason, diagnostic) => ({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason, ...(diagnostic ? { diagnostic } : {}) });
// Native unreachable inside the evaluation: what full-admission-v2.mjs reports for a caught transport fault (generation 10).
const NATIVE_DOWN = Object.freeze({ phase: 'native', transport: true });
function admitted(job, observed, packet, { batchClaim = null, mode = {} } = {}) {
  const facts = { contract: 'clued.independent-ci.full-admission/2', status: 'ADMITTED', admitted: true, completeAdmission: true, evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate',
    domain: 'fixture', repository: REPO, scope: 'project:x', prRef: `${REPO}#${job.pr}`, headSha: job.headSha, baseSha: job.baseSha, jobId: job.id, role: job.role, attempt: job.attempt,
    claimId: observed.claimId, fence: observed.fence, epoch: observed.epoch, observedClaim: { ...observed }, batchClaimBound: batchClaim ? claimGeneration(batchClaim) : null,
    sourceManifestSha256: job.sourceManifestSha256, executionPolicy: 'staged', guarded: false, executionHandoverPending: false, mergeQueueHead: false,
    mode: { state: 'normal', layer: 'code', policyVersion: 1, ...mode }, mergeSlot: { state: 'held', ref: `merge:${REPO}:main`, tip: job.baseSha, until: SLOT_UNTIL },
    ownerReview: null, workflowGateFindings: [], observedAt: iso(Date.now()), claimExpiresAt: observed.expiresAt, modeProofRef: 'mode', observationRef: 'obs',
    packetSha256: digest(packet), evaluationSha256: digest('evaluation') };
  return { ...facts, observationSha256: digest(facts) };
}
// A GitHub port whose reads can fail with a given code from a given moment on: `failReads(code)` makes every later read
// (readChangedPaths, readChecks, readPullRequest) throw it; `failRevoke(code)` makes the withdrawal's PATCH throw.
function fakeGithub() {
  const checks = []; let next = 100; let readFault = null, revokeFault = null, afterCreate = null;
  const fault = code => Object.assign(new Error(code), { code });
  const guard = () => { if (readFault) throw fault(readFault); };
  return { fixture: true, checks, failReads: code => { readFault = code; }, failRevoke: code => { revokeFault = code; }, onCreate: fn => { afterCreate = fn; },
    async readChangedPaths(job) { guard(); return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { guard(); return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { guard(); return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); afterCreate?.(c); return structuredClone(c); },
    async revokeCheck(id, body) { if (revokeFault) throw fault(revokeFault); const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}
const fakeAdmission = answer => { let calls = 0; return { fixture: true, get calls() { return calls; }, async evaluatePr(job, packet, options) { calls++; return answer(job, packet, options ?? {}, calls); } }; };
async function workAdmission(t, { github, answer }) {
  const jobs = jobsFor(), c = claim();
  const dir = await tempDir(t);
  const batchClaims = { read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } }, record: (j, cl, at) => recordBatchClaim(dir, j, cl, at) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const admission = fakeAdmission((job, packet, opts, n) => answer(job, c, packet, opts, n));
  // Generation 10: the bounded re-reads of the verification after the write wait through this stub (no real 100 s here).
  const sleeps = [], records = [];
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record: (k, v) => { records.push([k, v]); }, authority: {}, batchClaims,
    sleep: async ms => { sleeps.push(ms); } });
  return { pub, job: jobs['work-admission'], journal, admission, sleeps, records };
}
const okAnswer = (job, c, packet, opts) => admitted(job, c, packet, { batchClaim: opts.batchClaim });

test('work admission v2: a 5xx that outlives the read retry BEFORE any write is a clean BLOCKED, zero side effects, the resident\'s transient path', async t => {
  for (const code of ['github_http_502', 'github_http_503', 'github_transport_unconfirmed']) {
    const github = fakeGithub(); github.failReads(code);
    const { pub, job } = await workAdmission(t, { github, answer: okAnswer });
    const r = await pub.publish(job);
    assert.deepEqual([r.status, r.reason, r.sideEffects, github.checks.length], ['BLOCKED', code, 0, 0], code);
    assert.equal(outcomeFailureCode({ ...r, mayHavePublished: false }, 1), 'GITHUB_TRANSIENT_UNAVAILABLE', code);
    // nothing was recorded or written, so the entry says it is safe to re-run: the resident releases the head (failure-table.json, DESIGN 49)
    assert.equal(r.safeToRerun, true, code);
  }
  // ... in the first step (the read-back of what GitHub already holds) as well as in the evaluation's boundary; never beside a recorded claim
  assert.equal(refusalSafeToRerun({ step: 'published-on-github', claimed: null, reason: 'github_http_502', diagnostic: null }), true);
  assert.equal(refusalSafeToRerun({ step: 'published-on-github', claimed: null, reason: 'HEAD_PUBLISHED_ON_GITHUB', diagnostic: null }), false);
  assert.equal(refusalSafeToRerun({ step: 'published-on-github', claimed: null, reason: 'github_http_403', diagnostic: null }), false);
  assert.equal(refusalSafeToRerun({ step: 'admitted', claimed: null, reason: 'github_http_502', diagnostic: null }), false);
  assert.equal(refusalSafeToRerun({ step: 'boundary', claimed: { claimId: 'x' }, reason: 'github_http_502', diagnostic: null }), false);
});

test('work admission v2 (gen 10): one 5xx AFTER the write is read again after a back-off and the check settles; nothing is withdrawn', async t => {
  const github = fakeGithub();
  const { pub, job, sleeps, records } = await workAdmission(t, { github, answer: okAnswer });
  github.onCreate(() => github.failReads('github_http_502')); // the first read after the write fails, as in PR #992
  let failures = 0; const readChangedPaths = github.readChangedPaths.bind(github);
  github.readChangedPaths = async j => { try { return await readChangedPaths(j); } catch (e) { failures++; github.failReads(null); throw e; } };
  const r = await pub.publish(job);
  assert.equal(failures, 1);
  assert.deepEqual([r.status, r.sideEffects, github.checks.length, github.checks[0].conclusion], ['SETTLED', 1, 1, 'success'], JSON.stringify(r));
  assert.deepEqual(sleeps, [VERIFY_REREAD_DELAYS_MS[0]]);
  assert.deepEqual(records.filter(([k]) => k === 'native_check_verify_retry').map(([, v]) => [v.attempt, v.delayMs, v.cause]), [[1, 10_000, 'github_http_502']]);
});

test('work admission v2 (gen 10): Native unreachable after the write (full_admission_unavailable, transport) once: read again, settled', async t => {
  const github = fakeGithub();
  const { pub, job, sleeps } = await workAdmission(t, { github, answer: (j, c, packet, opts, n) => (n === 2 ? blocked('full_admission_unavailable', NATIVE_DOWN) : admitted(j, c, packet, { batchClaim: opts.batchClaim })) });
  const r = await pub.publish(job);
  assert.deepEqual([r.status, github.checks[0].conclusion, sleeps.length], ['SETTLED', 'success', 1], JSON.stringify(r));
});

test('work admission v2 (gen 10): still unreadable after the bounded re-reads: withdrawn as "verification unavailable"; stage 1 maps it to the transient ADMISSION_VERIFICATION_UNAVAILABLE', async t => {
  assert.deepEqual([...VERIFY_REREAD_DELAYS_MS, VERIFY_WAIT_WINDOW_MS, VERIFY_REVOKE_RESERVE_MS], [10_000, 30_000, 60_000, 180_000, 120_000]);
  const fail502 = g => { g.onCreate(() => { g.readChangedPaths = async () => { throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); }; }); return null; };
  const native = (reason, diagnostic) => () => (j, c, packet, opts, n) => (n >= 2 ? blocked(reason, diagnostic) : admitted(j, c, packet, { batchClaim: opts.batchClaim }));
  for (const [label, setup] of [['github_http_502', fail502], ['full_admission_unavailable', native('full_admission_unavailable', NATIVE_DOWN)],
    ['full_admission_observation_expired', native('full_admission_observation_expired')], ['full_admission_mode_unknown', native('full_admission_mode_unknown')]]) {
    const github = fakeGithub();
    const answer = setup(github) ?? okAnswer;
    const { pub, job, sleeps, admission } = await workAdmission(t, { github, answer });
    const r = await pub.publish(job);
    assert.deepEqual([r.status, r.reason, r.sideEffects], ['REVOKED', label, 2], `${label} ${JSON.stringify(r)}`);
    assert.deepEqual(sleeps, [...VERIFY_REREAD_DELAYS_MS], label);
    if (label !== 'github_http_502') assert.equal(admission.calls, 1 + 1 + VERIFY_REREAD_DELAYS_MS.length, 'the verification is done again from the start every time');
    const c = github.checks[0];
    assert.equal(c.conclusion, 'failure');
    assert.match(c.output.title, /withdrawn: verification unavailable/, label);
    assert.match(c.output.summary, /no change of it was observed/);
    assert.equal(outcomeFailureCode(r, 1), 'ADMISSION_VERIFICATION_UNAVAILABLE', `${label}: stage 1, transient, the resident schedules attempt 2`);
    // the bound outcome carries the diagnostic as `diagnostic` (stage-inputs.mjs): the same answer
    const bound = { status: r.status, reason: r.reason, sideEffects: r.sideEffects, diagnostic: r.admissionDiagnostic ?? null };
    assert.equal(outcomeFailureCode(bound, 1), 'ADMISSION_VERIFICATION_UNAVAILABLE', `${label} bound`);
    for (const stage of [3, 5, 7, 8]) assert.equal(outcomeFailureCode(r, stage), 'PUBLICATION_REVOKED', `stage ${stage}: a role check is on the head`);
  }
  assert.ok(TRANSIENT_CODES.includes('ADMISSION_VERIFICATION_UNAVAILABLE'));
});

test('work admission v2 (gen 10): what is not a passing cause is never read again and stays PUBLICATION_REVOKED', async t => {
  // full_admission_unavailable that caught no transport fault (a refused credential, a 401/403, an evaluator fault)
  for (const diagnostic of [{ phase: 'principal', transport: false }, { phase: 'native' }, undefined]) {
    const github = fakeGithub();
    const { pub, job, sleeps } = await workAdmission(t, { github, answer: (j, c, packet, opts, n) => (n >= 2 ? blocked('full_admission_unavailable', diagnostic) : admitted(j, c, packet, { batchClaim: opts.batchClaim })) });
    const r = await pub.publish(job);
    assert.deepEqual([r.status, r.reason, sleeps.length], ['REVOKED', 'full_admission_unavailable', 0], JSON.stringify(diagnostic));
    assert.equal(outcomeFailureCode(r, 1), 'PUBLICATION_REVOKED', JSON.stringify(diagnostic));
    assert.match(github.checks[0].output.title, /withdrawn: verification unavailable/, 'still not "authorization changed": nothing was found to have changed');
  }
  for (const reason of ['NATIVE_AUTHORIZATION_BINDING_CHANGED', 'NATIVE_CHECK_READBACK_UNCONFIRMED', 'github_http_429', 'github_http_501', 'full_admission_claim_changed'])
    assert.equal(outcomeFailureCode({ status: 'REVOKED', reason, sideEffects: 2 }, 1), 'PUBLICATION_REVOKED', reason);
  for (const [reason, diagnostic, want] of [['github_http_503', null, true], ['github_transport_unconfirmed', null, true], ['full_admission_unavailable', { transport: true }, true],
    ['full_admission_unavailable', { transport: false }, false], ['full_admission_unavailable', null, false], ['NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE', null, true],
    ['full_admission_observer_unknown', null, true], ['full_admission_principal_unknown', null, false], ['github_http_403', null, false]])
    assert.equal(admissionVerificationRetryable(reason, diagnostic), want, `${reason} ${JSON.stringify(diagnostic)}`);
  assert.deepEqual([...ADMISSION_REREAD_REASONS], ['full_admission_mode_unknown', 'full_admission_observer_unknown', 'full_admission_observation_expired', 'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE']);
});

test('full admission v2 (gen 10): the catch-all says whether it caught a transport fault, and the diagnostic keeps that flag', () => {
  const net = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) });
  for (const e of [net, Object.assign(new Error('timed out'), { name: 'TimeoutError' }), new Error('GitHub API /repos/x/pulls/1 returned 502'), new Error('Native verify returned 503')])
    assert.equal(transportFault(e), true, String(e?.message));
  for (const e of [new Error('GitHub API /repos/x/pulls/1 returned 403'), new Error('GitHub API /x returned 401'), new Error('returned 502 but more'), new TypeError('fetch failed'),
    new TypeError('x is not a function'), Object.assign(new Error('aborted'), { name: 'AbortError' }), null, 'returned 502'])
    assert.equal(transportFault(e), false, String(e?.message ?? e));
  assert.equal(sanitizeAdmissionDiagnosticV2({ phase: 'native', transport: true }).transport, true);
  assert.equal(sanitizeAdmissionDiagnosticV2({ phase: 'native', transport: 'yes' }).transport, undefined);
});

test('work admission v2 (gen 10): no wait past the window or into the withdrawal reserve before the deadline; a lost lease is UNCERTAIN', async t => {
  const setup = async ({ clockStep = 0, deadline = null, live = () => {}, onSleep = () => {} } = {}) => {
    const github = fakeGithub();
    const jobs = jobsFor(), c = claim(), dir = await tempDir(t);
    const batchClaims = { read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } }, record: (j, cl, at) => recordBatchClaim(dir, j, cl, at) };
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    const admission = fakeAdmission((job, packet, opts, n) => (n >= 2 ? blocked('full_admission_unavailable', NATIVE_DOWN) : admitted(job, c, packet, { batchClaim: opts.batchClaim })));
    // the clock moves clockStep per reading only once the check is written (the slow verification after the write)
    let now = Date.now(), stepping = false; const sleeps = [];
    github.onCreate(() => { stepping = true; });
    const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive: live, record() {}, authority: {}, batchClaims, clock: () => (now += stepping ? clockStep : 0),
      sleep: async ms => { sleeps.push(ms); now += ms; onSleep(); }, deadlineAt: () => (deadline === null ? null : deadline(now)) });
    return { github, pub, job: jobs['work-admission'], sleeps };
  };
  // each verification takes a minute on this line: after 10 s + 30 s of waiting the window (3 minutes) has no room for the 60 s wait
  let w = await setup({ clockStep: 20_000 });
  let r = await w.pub.publish(w.job);
  assert.equal(r.status, 'REVOKED', JSON.stringify(r));
  assert.ok(w.sleeps.length < VERIFY_REREAD_DELAYS_MS.length, `waits ${w.sleeps}`);
  // a deadline that leaves no room for a wait and the withdrawal: withdrawn at once
  w = await setup({ deadline: now => now + 60_000 });
  r = await w.pub.publish(w.job);
  assert.deepEqual([r.status, w.sleeps], ['REVOKED', []]);
  assert.equal(w.github.checks[0].conclusion, 'failure');
  // the lease lost during the wait: the withdrawal cannot run either; UNCERTAIN, the unverified check is left for the reconciliation
  let dead = false;
  w = await setup({ live: () => { if (dead) throw Object.assign(new Error('HELD_RECORD_EXPIRED'), { code: 'HELD_RECORD_EXPIRED' }); }, onSleep: () => { dead = true; } });
  r = await w.pub.publish(w.job);
  assert.deepEqual([r.status, r.reason, w.sleeps], ['UNCERTAIN', 'NEGATIVE_COMPENSATION_UNCONFIRMED', [10_000]], JSON.stringify(r));
  assert.equal(w.github.checks[0].conclusion, 'success', 'nothing guessed: the reconciliation reads it');
  const g = w.github;
  for (const bad of [[0], [-1], [1.5], [120_001], [1, 2, 3, 4, 5, 6, 7], 'x'])
    assert.throws(() => createFixtureWorkAdmissionPublisherV2({ github: g, journal: null, admission: null, assertLive() {}, record() {}, authority: {}, batchClaims: null, verifyRereadDelaysMs: bad }), { code: 'WORK_ADMISSION_PUBLISHER_CONFIGURATION_REFUSED' });
  assert.throws(() => createFixtureWorkAdmissionPublisherV2({ github: g, journal: null, admission: null, assertLive() {}, record() {}, authority: {}, batchClaims: null, deadlineAt: 5 }), { code: 'WORK_ADMISSION_PUBLISHER_CONFIGURATION_REFUSED' });
});

test('work admission v2: a real authorization change after the write still says "authorization changed"', async t => {
  const github = fakeGithub();
  const { pub, job } = await workAdmission(t, { github, answer: (j, c, packet, opts, n) => admitted(j, c, packet, { batchClaim: opts.batchClaim, ...(n >= 2 ? { mode: { state: 'frozen' } } : {}) }) });
  const r = await pub.publish(job);
  assert.equal(r.status, 'REVOKED');
  assert.equal(r.reason, 'NATIVE_AUTHORIZATION_BINDING_CHANGED');
  assert.equal(github.checks[0].output.title, 'Work admission authorization changed');
});

test('work admission v2: a 5xx after the write that also stops the withdrawal stays UNCERTAIN for reconciliation, nothing is guessed', async t => {
  const github = fakeGithub();
  const { pub, job } = await workAdmission(t, { github, answer: okAnswer });
  github.onCreate(() => github.failReads('github_http_502')); // the after-write boundary and the withdrawal's identity read both fail
  const r = await pub.publish(job);
  assert.equal(r.status, 'UNCERTAIN', JSON.stringify(r));
  assert.equal(r.reason, 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED');
  assert.equal(r.sideEffects, 1, 'only the create was sent');
  assert.equal(github.checks.length, 1);
  assert.equal(github.checks[0].conclusion, 'success', 'the unverified check is left for the reconciliation, not touched blind');
  assert.equal(outcomeFailureCode(r, 1), 'PUBLICATION_UNCERTAIN');
  // a withdrawal whose PATCH cannot be sent either
  const g2 = fakeGithub();
  const w2 = await workAdmission(t, { github: g2, answer: okAnswer });
  let tripped = false; const rp = g2.readChangedPaths.bind(g2);
  g2.readChangedPaths = async j => { if (tripped) { g2.failReads(null); throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); } return rp(j); };
  g2.onCreate(() => { tripped = true; });
  g2.failRevoke('github_http_502');
  const r2 = await w2.pub.publish(w2.job);
  assert.deepEqual([r2.status, r2.reason], ['UNCERTAIN', 'NEGATIVE_COMPENSATION_UNCONFIRMED'], JSON.stringify(r2));
});

test('scanner publisher v2: a 5xx after the write is withdrawn as "verification unavailable"; before the write nothing is written', async t => {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = jobsFor().gitleaks, c = claim();
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
    publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const make = async github => createStagedCheckPublisherV2({ nativeAdmission: fakeAdmission((j, packet, opts) => admitted(j, c, packet, { batchClaim: opts.batchClaim })), authority, github,
    journal: await EffectJournal.open(path.join(await tempDir(t), 'effects')), signers, configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j),
    protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs }, batchClaim: claimGeneration(c), domain: 'fixture' });
  // before the write: BLOCKED, zero side effects, nothing on GitHub
  const early = fakeGithub(); early.failReads('github_http_503');
  const e = await (await make(early)).publish({ job, envelope });
  assert.deepEqual([e.status, e.reason, e.sideEffects, early.checks.length], ['BLOCKED', 'github_http_503', 0, 0]);
  assert.equal(outcomeFailureCode({ ...e, mayHavePublished: false }, 3), 'GITHUB_TRANSIENT_UNAVAILABLE');
  // after the write
  const late = fakeGithub();
  const rp = late.readPullRequest.bind(late); let created = false, failed = false;
  late.onCreate(() => { created = true; });
  late.readPullRequest = async n => { if (created && !failed) { failed = true; throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); } return rp(n); };
  const r = await (await make(late)).publish({ job, envelope });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['REVOKED', 'github_http_502', 2], JSON.stringify(r));
  assert.match(late.checks[0].output.title, /withdrawn: verification unavailable/);
  assert.doesNotMatch(late.checks[0].output.title, /authorization changed/);
});

test('withdrawal text: only a GitHub read that could not be done is "verification unavailable"', () => {
  for (const cause of ['github_http_500', 'github_http_502', 'github_http_503', 'github_http_504', 'github_transport_unconfirmed', 'full_admission_unavailable']) assert.equal(verificationUnavailable(cause), true, cause);
  // the set is exactly the read retry's: a 429 or a 501/505/599 is not a passing fault (review of gen8, finding 2)
  for (const cause of ['github_http_429', 'github_http_501', 'github_http_505', 'github_http_599', 'full_admission_unknown']) assert.equal(verificationUnavailable(cause), false, cause);
  for (const cause of ['github_http_403', 'github_http_404', 'authorization_binding_changed', 'full_admission_not_proven', 'NATIVE_AUTHORIZATION_BINDING_CHANGED', 'lease_expired_after_write', '', null, undefined]) assert.equal(verificationUnavailable(cause), false, String(cause));
  assert.equal(withdrawalTitle('Work admission', 'github_http_502'), 'Work admission check withdrawn: verification unavailable');
  assert.equal(withdrawalTitle('Work admission', 'x'), 'Work admission authorization changed');
  assert.equal(withdrawalTitle('Independent control', 'x'), 'Independent control authorization changed');
  assert.equal(withdrawalTitle('Independent CI', 'x'), 'Independent CI authorization changed');
});

// ---- DESIGN 51: B (probe before anything is recorded or written) and the entry's own safe-to-rerun flag (C) ----
test('work admission v2 (B): GitHub unreadable at the probe, before the batch claim is recorded, ends clean and safe to re-run; the next run publishes', async t => {
  const github = fakeGithub();
  const { pub, job } = await workAdmission(t, { github, answer: okAnswer });
  let failing = true; const rp = github.readPullRequest.bind(github);
  github.readPullRequest = async n => { if (failing) throw Object.assign(new Error('github_http_503'), { code: 'github_http_503' }); return rp(n); };
  const r = await pub.publish(job);
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun, github.checks.length], ['BLOCKED', 'github_http_503', 0, true, 0]);
  // nothing was recorded: no batch claim, no effect-key record, so the very next run is a first admission again
  failing = false;
  const again = await pub.publish(job);
  assert.deepEqual([again.status, again.sideEffects, github.checks.length], ['SETTLED', 1, 1]);
});

function scannerWorld(t, role, answer) {
  return (async () => {
    const { signer, docs } = fixtureRecord();
    const record = validateRecordV2(docs, { now: Date.now() });
    const job = jobsFor()[role], c = claim();
    const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
    const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
      publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
    const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
    const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    const make = github => createStagedCheckPublisherV2({ nativeAdmission: fakeAdmission(answer ?? ((j, packet, opts) => admitted(j, c, packet, { batchClaim: opts.batchClaim }))), authority, github, journal, signers,
      configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j),
      protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs }, batchClaim: claimGeneration(c), domain: 'fixture' });
    return { job, c, envelope, signer, journal, make, publish: github => make(github).publish({ job, envelope }) };
  })();
}

test('scanner publisher v2 (B, C): GitHub unreadable at the probe leaves no K, no journal record, no check; safe to run again and the next run publishes', async t => {
  const w = await scannerWorld(t, 'gitleaks');
  const github = fakeGithub();
  // the PR is read twice before the write (the boundary, then the probe): the second read fails
  const rp = github.readPullRequest.bind(github); let reads = 0, failing = true;
  github.readPullRequest = async n => { reads++; if (failing && reads >= 2) throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); return rp(n); };
  const r = await w.publish(github);
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun, github.checks.length], ['BLOCKED', 'github_http_502', 0, true, 0], JSON.stringify(r));
  assert.equal(await w.journal.read(r.effectKey), null, 'no effect-key record');
  assert.equal(outcomeFailureCode({ ...r, mayHavePublished: false }, 3), 'GITHUB_TRANSIENT_UNAVAILABLE');
  failing = false;
  const again = await w.publish(github);
  assert.deepEqual([again.status, again.sideEffects, github.checks.map(x => x.conclusion)], ['SETTLED', 1, ['success']], JSON.stringify(again));
});

test('scanner publisher v2 (C): the safe-to-rerun flag is the entry own, set only for a passing fault before anything was recorded', async t => {
  const blockedBy = (reason, diagnostic) => () => ({ ...blocked(reason), ...(diagnostic ? { diagnostic } : {}) });
  // the admission port was unavailable (any exception inside it): safe; Native's rejection of the head: not
  let r = await (await scannerWorld(t, 'trivy', blockedBy('full_admission_unavailable'))).publish(fakeGithub());
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun], ['BLOCKED', 'full_admission_not_proven', 0, true]);
  r = await (await scannerWorld(t, 'trivy', blockedBy('full_admission_rejected', { reasonCodes: ['claim_not_current'], nativeReasonCodes: [], verdict: 'REJECTED' }))).publish(fakeGithub());
  assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun], ['BLOCKED', 'full_admission_not_proven', 0, undefined]);
  r = await (await scannerWorld(t, 'trivy', blockedBy('full_admission_native_changed'))).publish(fakeGithub());
  assert.equal(r.safeToRerun, undefined);
  // GitHub unreadable: safe; a 403 is a refusal: not
  for (const [code, safe] of [['github_http_500', true], ['github_transport_unconfirmed', true], ['github_http_403', undefined], ['pr_subject_changed', undefined]]) {
    const github = fakeGithub(); github.failReads(code);
    r = await (await scannerWorld(t, 'trivy')).publish(github);
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun], ['BLOCKED', code, 0, safe], code);
  }
  // a refused signed result is never safe to run again
  const w = await scannerWorld(t, 'trivy');
  const bad = { ...w.envelope, signature: 'x'.repeat(10) };
  r = await w.make(fakeGithub()).publish({ job: w.job, envelope: bad });
  assert.deepEqual([r.status, r.sideEffects, r.safeToRerun], ['BLOCKED', 0, undefined]);
});

test('the flag survives the entry\'s outcome record and the stage fact the resident reads (stage 3)', async t => {
  const github = fakeGithub(); github.failReads('github_http_502');
  const r = await (await scannerWorld(t, 'gitleaks')).publish(github);
  const written = await writeOutcome({ receiptsRoot: await tempDir(t, 'clued-no-role-'), nonce: randomUUID().replace(/-/g, ''), plan: { stage: 3, entryRole: 'check-publisher' }, jobIds: [], result: r });
  const facts = outcomeFacts(written);
  assert.deepEqual([facts.safeToRerun, facts.sideEffects, facts.mayHavePublished], [true, 0, false]);
  assert.equal(outcomeFailureCode(written, 3), 'GITHUB_TRANSIENT_UNAVAILABLE');
});
