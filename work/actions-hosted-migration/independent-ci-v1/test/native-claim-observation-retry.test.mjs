// The protected observation's bounded retry (KooYomi Task a3ad42a9; runtime/one-shot-v2.mjs#protectedAuthority).
// #916 stage 5 (2026-10-23 09:48:16Z) and #895 stage 3 (2026-10-21 17:26Z) each lost a head to one Native verify
// request that did not answer: native_claim_observation_unconfirmed, PUBLICATION_BLOCKED, burned. A timeout, a network
// failure or a 5xx/429 answer is now sent again after 1, 2 and 4 s within 30 s; a refusal never is; nothing is
// published twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { protectedAuthority, transientFetchError, OBSERVE_RETRY_WAITS_MS, OBSERVE_BUDGET_MS } from '../runtime/one-shot-v2.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const jobsFor = () => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 });
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
    if (value?.took && clock) clock.now += value.took;
    const result = value?.took ? value.then : value;
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetchImpl, calls };
}

// With a fake `clock` (both the wall clock and the monotonic one), every attempt's signal is a fake one that records its
// timeout (signals) and is never aborted.
function authorityWith({ fetchImpl, accepted = Object.fromEntries(REFS.map(k => [k, randomUUID()])), ciPrincipalBindingId = randomUUID(), clock = null, live = () => {} }) {
  const waits = [], logs = [], signals = [];
  const config = { supabaseUrl: 'https://x.supabase.co/', publishableKey: 'k', scope: 'project:x', ciPrincipalBindingId };
  const auth = protectedAuthority({ config, accepted, github: { async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; } },
    fetchImpl, nativeToken: 't', live, log: (kind, data) => logs.push({ kind, data: structuredClone(data) }),
    ...(clock ? { clock: () => clock.now, monotonic: () => clock.now, sleep: async ms => { waits.push(ms); clock.now += ms; }, timeoutSignal: ms => { signals.push(ms); return new AbortController().signal; } }
      : { sleep: async ms => { waits.push(ms); } }) });
  return { auth, waits, logs, signals };
}

test('the retry schedule is the issuer\'s: 1, 2 and 4 s within 30 s', () => {
  assert.deepEqual([...OBSERVE_RETRY_WAITS_MS], [1000, 2000, 4000]);
  assert.equal(OBSERVE_BUDGET_MS, 30000);
});

test('one timed-out verify request is sent again after 1 s and the fresh answer is used', async () => {
  const jobs = jobsFor(), c = claim();
  const { fetchImpl, calls } = scripted([timeout(), () => reply(200, verifyBody(c, Date.now()))]);
  const { auth, waits, logs } = authorityWith({ fetchImpl });
  const facts = await auth.observe(jobs.trivy, claimGeneration(c));
  assert.deepEqual(facts.claim, claimGeneration(c));
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(logs.map(l => l.kind), ['native_claim_observation_retry', 'native_claim_observation']);
  assert.deepEqual(logs[0].data, { attempt: 1, cause: 'transport', status: null });
  // every attempt sends the same request with its own bounded signal
  assert.equal(calls[0].opts.body, calls[1].opts.body);
  assert.ok(calls.every(x => x.opts.signal instanceof AbortSignal && x.opts.signal.aborted === false && x.opts.redirect === 'error'));
  assert.notEqual(calls[0].opts.signal, calls[1].opts.signal);
});

test('5xx (the anon statement timeout, 500/57014) and 429 are transient; their bodies are discarded unread', async () => {
  const jobs = jobsFor(), c = claim(), cancelled = { count: 0 };
  const { fetchImpl, calls } = scripted([reply(500, { code: '57014', message: 'canceling statement due to statement timeout' }, { cancelled }),
    reply(429, { message: 'slow down' }, { cancelled }), reply(503, new SyntaxError('html'), { cancelled }), () => reply(200, verifyBody(c, Date.now()))]);
  const { auth, waits, logs } = authorityWith({ fetchImpl });
  const facts = await auth.observe(jobs.trivy, claimGeneration(c));
  assert.deepEqual(facts.claim, claimGeneration(c));
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(cancelled.count, 3);
  assert.deepEqual(logs.filter(l => l.kind === 'native_claim_observation_retry').map(l => [l.data.cause, l.data.status]), [['status', 500], ['status', 429], ['status', 503]]);
});

test('a dual-stack connect refused on every address (AggregateError) is transient, whatever its first code', async () => {
  const aggregate = first => new TypeError('fetch failed', { cause: Object.assign(new AggregateError([Object.assign(new Error('a'), { code: first }),
    Object.assign(new Error('b'), { code: 'ECONNREFUSED' })], 'connect failed'), { code: first }) });
  assert.equal(transientFetchError(aggregate('ECONNREFUSED')), true);
  assert.equal(transientFetchError(aggregate('EADDRNOTAVAIL')), true);
  assert.equal(transientFetchError(new TypeError('fetch failed', { cause: new AggregateError([new Error('x')], 'no codes') })), false);
});

test('a network failure while reading the body is transient too', async () => {
  const jobs = jobsFor(), c = claim();
  const { fetchImpl, calls } = scripted([reply(200, network('terminated')), () => reply(200, verifyBody(c, Date.now()))]);
  const { auth, waits, logs } = authorityWith({ fetchImpl });
  await auth.observe(jobs.trivy, claimGeneration(c));
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(logs[0].data, { attempt: 1, cause: 'body', status: 200 });
});

test('exhausted after four attempts: native_claim_observation_unavailable', async () => {
  const jobs = jobsFor(), c = claim();
  const { fetchImpl, calls } = scripted([network()]);
  const { auth, waits, logs } = authorityWith({ fetchImpl });
  await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_unavailable' });
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.ok(!logs.some(l => l.kind === 'native_claim_observation'));
  // every failed attempt is in the observation log, the last one as the reason it gave up
  assert.deepEqual(logs.map(l => [l.kind, l.data.attempt]), [['native_claim_observation_retry', 1], ['native_claim_observation_retry', 2],
    ['native_claim_observation_retry', 3], ['native_claim_observation_unavailable', 4]]);
});

test('a retried answer must be fresh at its own arrival', async () => {
  const jobs = jobsFor(), c = claim();
  // attempt 1 times out at 10 s; attempt 2 arrives at 21 s, verified at the start: 21 s old is fresh, 31 s old is not
  for (const [age, ok] of [[21000, true], [31000, false]]) {
    const start = Date.now() - 60_000, clock = { now: start };
    const { fetchImpl, calls } = scripted([() => ({ took: 10000, then: timeout() }), () => ({ took: 10000, then: reply(200, verifyBody(c, clock.now + 10000 - age)) })], { clock });
    const { auth } = authorityWith({ fetchImpl, clock });
    if (ok) assert.equal((await auth.observe(jobs.trivy, claimGeneration(c))).observedAt, iso(start + 21000 - age));
    else await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_refused' });
    assert.equal(calls.length, 2, String(age));
  }
});

test('the whole retry stays within 30 s: every attempt timing out ends after three attempts, the last cut to the budget', async () => {
  const jobs = jobsFor(), c = claim(), clock = { now: Date.parse('2026-10-23T09:48:00.000Z') }, start = clock.now;
  let signals;
  // Each attempt runs into its own timeout: the fake clock moves by the signal's timeout, then TimeoutError.
  const { fetchImpl, calls } = scripted([() => ({ took: signals.at(-1), then: timeout() })], { clock });
  const authority = authorityWith({ fetchImpl, clock });
  signals = authority.signals;
  await assert.rejects(authority.auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_unavailable' });
  // 0-10 attempt 1, wait 1 s, 11-21 attempt 2, wait 2 s, 23-30 attempt 3 (7 s left); a 4 s wait would end past the budget
  assert.equal(calls.length, 3);
  assert.deepEqual(signals, [10000, 10000, 7000]);
  assert.deepEqual(authority.waits, [1000, 2000]);
  assert.equal(clock.now - start, OBSERVE_BUDGET_MS);
});

test('a slow failing Native (3 s 500s) gets four attempts in 19 s', async () => {
  const jobs = jobsFor(), c = claim(), clock = { now: Date.parse('2026-10-23T09:48:00.000Z') }, start = clock.now;
  const { fetchImpl, calls } = scripted([() => ({ took: 3000, then: reply(500, { code: '57014' }) })], { clock });
  const { auth, waits } = authorityWith({ fetchImpl, clock });
  await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_unavailable' });
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(clock.now - start, 19000);
});

test('a wait is taken only when it leaves at least 2 s of the budget for the next attempt', async () => {
  const jobs = jobsFor(), c = claim();
  // attempt 1 ends at 27 s: 27 + 1 + 2 = 30, so one more attempt with the 2 s left
  let clock = { now: 0 };
  let { fetchImpl, calls } = scripted([() => ({ took: 27000, then: reply(502, {}) }), () => ({ took: 2000, then: reply(502, {}) })], { clock });
  let authority = authorityWith({ fetchImpl, clock });
  await assert.rejects(authority.auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_unavailable' });
  assert.equal(calls.length, 2);
  assert.deepEqual(authority.waits, [1000]);
  assert.deepEqual(authority.signals, [10000, 2000]);
  // attempt 1 ends at 27.5 s: a 1 s wait would leave 1.5 s, so it stops without waiting
  clock = { now: 0 };
  ({ fetchImpl, calls } = scripted([() => ({ took: 27500, then: reply(502, {}) })], { clock }));
  authority = authorityWith({ fetchImpl, clock });
  await assert.rejects(authority.auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_unavailable' });
  assert.equal(calls.length, 1);
  assert.deepEqual(authority.waits, []);
});

test('every 5xx and 429 is transient; other 4xx are answers', async () => {
  const jobs = jobsFor(), c = claim();
  for (const status of [429, 500, 502, 503, 504, 520, 599]) {
    const { fetchImpl, calls } = scripted([reply(status, {}), () => reply(200, verifyBody(c, Date.now()))]);
    const { auth, waits } = authorityWith({ fetchImpl });
    await auth.observe(jobs.trivy, claimGeneration(c));
    assert.deepEqual([calls.length, waits], [2, [1000]], String(status));
  }
  for (const status of [400, 403, 409, 422, 428]) {
    const { fetchImpl, calls } = scripted([reply(status, { message: 'no' }), () => reply(200, verifyBody(c, Date.now()))]);
    const { auth } = authorityWith({ fetchImpl });
    await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_refused' }, String(status));
    assert.equal(calls.length, 1, String(status));
  }
});

test('a refusal never retries: wrong generation, 4xx, a stale answer', async () => {
  const jobs = jobsFor(), c = claim();
  for (const [name, step] of [
    ['fence moved', () => reply(200, { ...verifyBody(c, Date.now()), current_fence: 4, claim: { ...verifyBody(c, Date.now()).claim, fence: 4 } })],
    ['not admitted', () => reply(200, { ...verifyBody(c, Date.now()), verdict: 'NOT_ADMITTED' })],
    ['401', () => reply(401, { message: 'invalid token' })],
    ['404', () => reply(404, { code: 'PGRST202' })],
    ['stale verified_at', () => reply(200, verifyBody(c, Date.now() - 31000))]]) {
    const { fetchImpl, calls } = scripted([step, () => reply(200, verifyBody(c, Date.now()))]);
    const { auth, waits } = authorityWith({ fetchImpl });
    await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_refused' }, name);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(waits, [], name);
  }
});

test('a body that is not JSON, or any other error, is unconfirmed at once', async () => {
  const jobs = jobsFor(), c = claim();
  for (const [name, step] of [['html 200', reply(200, new SyntaxError('Unexpected token <'))], ['html 404', reply(404, new SyntaxError('Unexpected token <'))],
    ['plain error', new Error('offline')], ['outer abort', new DOMException('aborted', 'AbortError')],
    ['redirect', new TypeError('fetch failed', { cause: new Error('unexpected redirect') })], ['bad url', new TypeError('Failed to parse URL from x', { cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }) })],
    ['a fault in this code', new TypeError("Cannot read properties of undefined (reading 'status')")], ['fetch failed, unknown cause', network('fetch failed', 'CERT_HAS_EXPIRED')],
    ['coded error', Object.assign(new Error('HELD_RECORD_LOST'), { code: 'HELD_RECORD_LOST' })]]) {
    const { fetchImpl, calls } = scripted([step, () => reply(200, verifyBody(c, Date.now()))]);
    const { auth, waits } = authorityWith({ fetchImpl });
    await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'native_claim_observation_unconfirmed' }, name);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(waits, [], name);
  }
});

test('the held record is checked again before every attempt', async () => {
  const jobs = jobsFor(), c = claim();
  let lives = 0;
  const lost = Object.assign(new Error('HELD_RECORD_LOST'), { code: 'HELD_RECORD_LOST' });
  const { fetchImpl, calls } = scripted([timeout()]);
  const { auth, waits } = authorityWith({ fetchImpl, live: () => { if (++lives === 3) throw lost; } });
  // live 1 before the changed paths, live 2 before attempt 1, live 3 (after the wait) refuses attempt 2
  await assert.rejects(auth.observe(jobs.trivy, claimGeneration(c)), { code: 'HELD_RECORD_LOST' });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, [1000]);
});

// The publisher with the real observation port: one transient verify failure costs a wait, never a head, and never a
// second check; exhausted before the write, nothing is written and the effect key stays free.
async function publisherWith(t, steps) {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = jobsFor().trivy, c = claim();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
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
    const facts = { contract: 'clued.independent-ci.full-admission/2', status: 'ADMITTED', admitted: true, completeAdmission: true, evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate',
      domain: 'fixture', repository: REPO, scope: 'project:x', prRef: `${REPO}#${j.pr}`, headSha: j.headSha, baseSha: j.baseSha, jobId: j.id, role: j.role, attempt: j.attempt,
      claimId: observed.claimId, fence: observed.fence, epoch: observed.epoch, observedClaim: { ...observed }, batchClaimBound: options?.batchClaim ? claimGeneration(options.batchClaim) : null,
      sourceManifestSha256: j.sourceManifestSha256, executionPolicy: 'staged', guarded: false, executionHandoverPending: false, mergeQueueHead: false,
      mode: { state: 'normal', layer: 'code', policyVersion: 1 }, mergeSlot: { state: 'held', ref: `merge:${REPO}:main`, tip: j.baseSha, until: slotUntil },
      ownerReview: null, workflowGateFindings: [], observedAt: iso(Date.now()), claimExpiresAt: observed.expiresAt, modeProofRef: 'mode', observationRef: 'obs',
      packetSha256: digest(packet), evaluationSha256: digest('evaluation') };
    return { ...facts, observationSha256: digest(facts) };
  } };
  const verify = scripted(steps(c));
  const { auth, waits } = authorityWith({ fetchImpl: verify.fetchImpl, accepted, ciPrincipalBindingId: record.config.ciPrincipalBindingId });
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const publisher = createStagedCheckPublisherV2({ nativeAdmission, authority: { fixture: true, observe: auth.observe }, github, journal, signers, configuredChecks: record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...accepted },
    batchClaim: claimGeneration(c), domain: 'fixture' });
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const result = await publisher.publish({ job, envelope });
  return { result, checks, waits, calls: verify.calls, journal, key: scanEffectKeyV2(job, record.config.checks.trivy) };
}

test('publisher: a timeout on the first observation (before any write) is retried and the check is published once', async t => {
  const { result, checks, waits, calls } = await publisherWith(t, c => [timeout(), () => reply(200, verifyBody(c, Date.now()))]);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(result.sideEffects, 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'success');
  assert.equal(calls.length, 3, 'two before the write, one after');
  assert.deepEqual(waits, [1000]);
});

test('publisher: a 5xx on the observation after the write is retried; the check is neither re-posted nor revoked', async t => {
  const { result, checks, waits, calls } = await publisherWith(t, c => [() => reply(200, verifyBody(c, Date.now())), reply(503, {}), () => reply(200, verifyBody(c, Date.now()))]);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'success');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000]);
});

test('publisher: exhausted before the write, nothing is written and the outcome is a clean zero-side-effect block', async t => {
  const { result, checks, waits, calls, journal, key } = await publisherWith(t, () => [reply(503, {})]);
  assert.deepEqual([result.status, result.reason, result.sideEffects, result.productionAuthorized], ['BLOCKED', 'native_claim_observation_unavailable', 0, false]);
  assert.equal(checks.length, 0);
  assert.equal(await journal.read(key), null, 'no effect journal entry: the key was never begun');
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  // stage-inputs.mjs#writeOutcome: BLOCKED with zero side effects is mayHavePublished=false
  assert.equal(outcomeFailureCode({ ...result, mayHavePublished: false }, 5), 'PUBLICATION_BLOCKED');
});

// Real fetch (undici) against a local server: the classification above holds for Node's own errors.
test('real fetch: reset, 503, a hang and a body cut off are retried; a redirect is not', async t => {
  const c = claim(), jobs = jobsFor();
  let script = [];
  const server = http.createServer((req, res) => {
    const step = script.shift();
    if (step === 'reset') return req.socket.destroy();
    if (step === 'hang') return;
    if (step === 'cut') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":'); return setTimeout(() => res.socket.destroy(), 20); }
    if (step === '503') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<html>busy</html>'); }
    if (step === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(verifyBody(c, Date.now())));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const run = async steps => {
    script = [...steps];
    const waits = [], logs = [];
    const auth = protectedAuthority({ config: { supabaseUrl: `http://127.0.0.1:${server.address().port}/`, publishableKey: 'k', scope: 'project:x', ciPrincipalBindingId: randomUUID() },
      accepted: Object.fromEntries(REFS.map(k => [k, randomUUID()])), github: { async readChangedPaths(job) { return { paths: ['a.txt'], pr: job.pr }; } },
      fetchImpl: (url, opts) => fetch(url, opts), nativeToken: 't', live() {}, log: (kind, data) => logs.push({ kind, data }),
      sleep: async ms => { waits.push(ms); }, timeoutSignal: () => AbortSignal.timeout(script[0] === 'hang' ? 200 : 10000) });
    try { return { facts: await auth.observe(jobs.trivy, claimGeneration(c)), waits, logs }; } catch (error) { return { error, waits, logs }; }
  };
  const ok = await run(['reset', '503', 'hang', 'ok']);
  assert.equal(ok.error, undefined, ok.error?.stack);
  assert.deepEqual(ok.facts.claim, claimGeneration(c));
  assert.deepEqual(ok.logs.filter(l => l.kind === 'native_claim_observation_retry').map(l => [l.data.cause, l.data.status]), [['transport', null], ['status', 503], ['transport', null]]);
  const cut = await run(['cut', 'ok']);
  assert.equal(cut.error, undefined, cut.error?.stack);
  assert.deepEqual(cut.logs[0].data, { attempt: 1, cause: 'body', status: 200 });
  const redirect = await run(['redirect', 'ok']);
  assert.equal(redirect.error?.code, 'native_claim_observation_unconfirmed');
  assert.deepEqual(redirect.waits, []);
  // and the classifier itself, on errors fetch really throws
  const errorOf = async (url, opts = {}) => { try { await fetch(url, opts); } catch (error) { return error; } return null; };
  assert.equal(transientFetchError(await errorOf('not a url')), false);
  assert.equal(transientFetchError(await errorOf(`http://127.0.0.1:${server.address().port}/`, { headers: { apikey: 'a\nb' } })), false);
});
