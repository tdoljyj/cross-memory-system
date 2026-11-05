// Task 576231fa, the issuer's own reads (Source v2, bridge v4): offline tests of
//   1. the remote refs port's transient/refusal split and the issuer's bounded, complete re-collection (late in a
//      callback round, a clean transient before the issue, a refusal never retried);
//   2. the refs snapshot of a remote-refs response measured at its issuance, not its arrival (as Owner Decision 6f1fb753
//      did for the admission);
//      and the gitleaks v4 adapter's three checks of that snapshot at one reference time;
//   3. the changed-paths read's own refusals and GitHub's 403 kept apart from full_admission_unavailable, and how the
//      stage fact classifies all of these reasons.
// No network, Docker, WSL, Host path or credential; directories are under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../src/proof.mjs';
import { batchJobsV2 } from '../src/job-v2.mjs';
import { remoteRefsReferenceTime } from '../src/admission-facts-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { outcomeFailureCode, TRANSIENT_CODES, ISSUER_REFUSAL_REASONS } from '../src/resident-v2/stage-fact.mjs';
import { collectCompleteRemoteRefs, refsTransient } from '../worker/protected-controller-ports-v2/refs.mjs';
import { REQUIRED_SOURCE_PATHS, createWindowsContext } from '../worker/protected-job-bridge-v4/boundary.mjs';
import { CALLBACK_WINDOW_MS, makeIssue, makeChallenge, makeResponse, makeBlocked, validateResponse, encode, decode } from '../worker/protected-job-bridge-v4/protocol.mjs';
import { createFixtureMailbox } from '../worker/protected-job-bridge-v4/mailbox.mjs';
import { runIssuer, collectRefs, refsFailureReason, changedPathsFailure, issuerEvaluate, REFS_RETRY_WAITS_MS, REFS_COLLECTION_MS } from '../worker/protected-job-bridge-v4/windows-issuer.mjs';
import { callbackValue } from '../worker/protected-job-bridge-v4/linux-worker.mjs';
import { IMAGE as GITLEAKS_IMAGE, SCAN_ARGS, validateRemoteSnapshot, refsInStore, prepareRequiredHistory } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, admittedFacts } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const WINDOWS = { skip: process.platform !== 'win32' && 'Windows issuer context' };
const iso = ms => new Date(ms).toISOString();
const sha = b => createHash('sha256').update(b).digest('hex');
const coded = code => Object.assign(new Error(code), { code });
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });
const PACKET = { complete: true, paths: ['a.txt'] };
const refsSnapshot = (now = Date.now()) => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(now), refs: [{ name: 'refs/heads/main', objectSha: BASE }] });

function setup() {
  const fx = fixtureRecord({}, { paths: REQUIRED_SOURCE_PATHS });
  const record = validateRecordV2(fx.docs, { now: Date.now() });
  const jobs = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: record.config.sourceManifestSha256, createdAt: iso(Date.now() - 60_000), attempt: 1 });
  return { ...fx, record, jobs };
}
const facts = (job, c) => admittedFacts(job, c, PACKET, { batchClaim: c });

// ---- 1a. the refs port: which failures may pass on their own ----
// A GraphQL page the port accepts: refs/heads/ has main at BASE, refs/tags/ is empty.
const page = prefix => {
  const edges = prefix === 'refs/heads/' ? [{ cursor: 'c1', node: { name: 'main', prefix, target: { oid: BASE, __typename: 'Commit' } } }] : [];
  const bytes = Buffer.from(JSON.stringify({ data: { repository: { databaseId: 1334673495, nameWithOwner: REPO,
    refs: { totalCount: edges.length, edges, pageInfo: { hasNextPage: false, endCursor: edges.at(-1)?.cursor ?? null } } } } }));
  return { ok: true, status: 200, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })), releaseLock() {} }; } } };
};
const pull = n => ({ number: n, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } });
// `fail(i, init)` may answer the i-th GraphQL request (0-based) itself; otherwise the page above.
const collectWith = (job, fail = () => null, o = {}) => {
  let i = 0;
  return collectCompleteRemoteRefs({ job, token: 'gh-fixture', readPullRequest: o.readPullRequest ?? (async n => pull(n)), signal: o.signal, ...(o.clock ? { clock: o.clock } : {}),
    fetchImpl: async (_url, init) => (await fail(i++, init)) ?? page(JSON.parse(init.body).variables.prefix) });
};

test('refs port: GitHub 5xx and 429, no answer and a page cut off mid-read are transient; 403, shape and bounds are refusals', async () => {
  const job = setup().jobs.gitleaks;
  assert.equal((await collectWith(job)).complete, true);
  // the 3rd request: the second pass has read refs/heads/ and fails on refs/tags/ (a collection read half-way)
  const at3 = answer => (i => (i === 2 ? answer() : null));
  for (const [answer, code] of [
    [() => ({ ok: false, status: 503 }), 'REFS_HTTP_503'], [() => ({ ok: false, status: 502 }), 'REFS_HTTP_502'], [() => ({ ok: false, status: 429 }), 'REFS_HTTP_429'],
    [() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }); }, 'REFS_TRANSPORT_UNCONFIRMED'],
    [() => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => { throw new TypeError('terminated'); }, releaseLock() {} }) } }), 'REFS_TRANSPORT_UNCONFIRMED']]) {
    await assert.rejects(collectWith(job, at3(answer)), { code }, code);
    assert.equal(refsTransient(code), true, code);
  }
  // the per-page timeout fired (a clock 1 ms short of the 30 s window leaves a 1 ms timeout): no answer, transient
  let ticks = 0;
  const late = () => { const base = 1_000_000; return ticks++ === 0 ? base : base + 29_999; };
  await assert.rejects(collectWith(job, (i, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { clock: late }),
    { code: 'REFS_TRANSPORT_UNCONFIRMED' });
  for (const [answer, code] of [
    [() => ({ ok: false, status: 403 }), 'REFS_HTTP_403'], [() => ({ ok: false, status: 404 }), 'REFS_HTTP_404'], [() => ({ ok: false }), 'REFS_HTTP_UNCONFIRMED'],
    [() => ({ ok: true, status: 200, body: null }), 'REFS_HTTP_UNCONFIRMED'],
    [() => { const r = page('refs/tags/'); return { ...r, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: Buffer.from('{"errors":[{"message":"x"}]}') })), releaseLock() {} }; } } }; }, 'REFS_GRAPHQL_ERRORS'],
    [() => { throw coded('HELD_RECORD_LEASE_LOST'); }, 'HELD_RECORD_LEASE_LOST']]) {
    await assert.rejects(collectWith(job, at3(answer)), { code }, code);
    assert.equal(refsTransient(code), false, code);
  }
  // the caller's own abort is a refusal, never a transport failure
  const controller = new AbortController();
  await assert.rejects(collectWith(job, i => { if (i === 1) controller.abort(); return null; }, { signal: controller.signal }), { code: 'REFS_ABORTED' });
  // the PR read: GitHub's own transient codes pass through as transient, 403 does not
  for (const [code, transient] of [['github_http_503', true], ['github_http_429', true], ['github_transport_unconfirmed', true], ['github_http_403', false], ['github_response_invalid', false]]) {
    await assert.rejects(collectWith(job, () => null, { readPullRequest: async () => { throw coded(code); } }), { code });
    assert.equal(refsTransient(code), transient, code);
  }
  for (const code of ['REFS_WINDOW_EXPIRED', 'REFS_HTTP_500', 'REFS_HTTP_599']) assert.equal(refsTransient(code), true, code);
  for (const code of ['REFS_PAGE_SHAPE_UNKNOWN', 'REFS_PAGE_LIMIT', 'REFS_INCOMPLETE', 'REFS_EDGE_UNKNOWN', 'REFS_PAGE_BYTES_BOUND', 'REFS_JSON_REQUIRED', 'REFS_HTTP_400', 'REFS_HTTP_4031', undefined, null])
    assert.equal(refsTransient(code), false, String(code));
});

test('refs failure reasons: transient -> REMOTE_REFS_UNAVAILABLE, any other refusal -> REMOTE_REFS_REFUSED; a push and a moved PR keep theirs', () => {
  for (const code of ['REFS_HTTP_503', 'REFS_HTTP_429', 'REFS_TRANSPORT_UNCONFIRMED', 'REFS_WINDOW_EXPIRED', 'github_transport_unconfirmed', 'github_http_502'])
    assert.equal(refsFailureReason(code), 'REMOTE_REFS_UNAVAILABLE', code);
  for (const code of ['REFS_HTTP_403', 'github_http_403', 'REFS_PAGE_SHAPE_UNKNOWN', 'REFS_PAGE_LIMIT', 'REFS_GRAPHQL_ERRORS', 'REFS_ABORTED', 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED', undefined])
    assert.equal(refsFailureReason(code), 'REMOTE_REFS_REFUSED', String(code));
  assert.equal(refsFailureReason('REFS_TOTAL_CHANGED'), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.equal(refsFailureReason('REFS_MAIN_BASE_CHANGED'), 'full_admission_subject_changed');
});

// ---- 1b. the issuer's bounded re-collection ----
function issuerFixture(t, role = 'gitleaks') {
  const s = setup(), c = claim(), j = s.jobs[role];
  let live = true;
  const context = createWindowsContext({ inputs: { jobs: [j], record: s.record }, policyText: '{}', sourceRoot: 'C:\\fixture', live: () => { if (!live) throw coded('HELD_RECORD_LEASE_LOST'); } });
  return { ...s, c, job: j, context, evaluate: async () => facts(j, c), stop: () => { live = false; } };
}
// Records the backoff waits (1 s and more; the issuer polls with 100 ms sleeps), each lasting 20 ms.
const backoffSleep = (waits, onWait = () => {}) => ms => { if (ms >= 1000) { waits.push(ms); onWait(ms); } return new Promise(r => setTimeout(r, ms >= 1000 ? 20 : ms)); };
// plan[i]: the i-th collection's answer, a code (thrown) or 'ok' (a complete snapshot observed now); default 'ok'.
const scripted = plan => { const calls = []; const collect = async () => { const step = plan[calls.length] ?? 'ok'; const v = step === 'ok' ? refsSnapshot() : null; calls.push(v ?? step); if (!v) throw coded(step); return v; }; return { calls, collect }; };
async function spool(t) { const root = await tempDir(t, 'clued-v2-spool-'); for (const d of ['incoming', 'outgoing']) await fs.mkdir(path.join(root, d)); return root; }
async function put(root, name, bytes) {
  await fs.writeFile(path.join(root, 'incoming', `${name}.json`), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'incoming', `${name}.ready.json`), canonical({ bytes: bytes.length, contract: 'clued.independent-ci.complete-public-file/1', sha256: sha(bytes) }), { flag: 'wx' });
}
// The fixture's own waits, measured on the monotonic clock: a test that moves Date.now (the slow refs collection) must
// not end them early. SPOOL_WAIT_MS bounds waiting for the issuer's spool files; NO_ANSWER_WAIT_MS bounds how long the
// simulated worker watches the issuer's collections before it ends its round unanswered.
const SPOOL_WAIT_MS = 8000;
const NO_ANSWER_WAIT_MS = 8000;
async function waitFor(file, ms = SPOOL_WAIT_MS) {
  for (const until = performance.now() + ms; ;) { try { return await fs.readFile(file); } catch (e) { if (e.code !== 'ENOENT' || performance.now() > until) throw e; } await new Promise(r => setTimeout(r, 50)); }
}
const exists = file => fs.lstat(file).then(() => true, () => false);
// The simulated Linux side runs beside runIssuer and is awaited after it. Its failure aborts runIssuer (pass
// `signal: linux.signal`), so the test reports it at once instead of waiting out the issue, and it is marked handled,
// so it is reported once, by that await, and not as an unhandled rejection first.
const linuxSide = run => { const ac = new AbortController(), p = run(); p.catch(() => ac.abort()); return Object.assign(p, { signal: ac.signal }); };

test('collectRefs: at most three complete collections (waits 1 and 2 s), each only while it fits before the deadline; a refusal is never collected again', WINDOWS, async t => {
  assert.deepEqual([[...REFS_RETRY_WAITS_MS], REFS_COLLECTION_MS], [[1000, 2000], 30_000]);
  assert.ok(3 * REFS_COLLECTION_MS + REFS_RETRY_WAITS_MS.reduce((a, b) => a + b) < CALLBACK_WINDOW_MS, 'the worst case fits inside one callback round');
  const f = issuerFixture(t), far = Date.now() + CALLBACK_WINDOW_MS;
  const run = async (plan, until = far, onWait) => { const s = scripted(plan), waits = [];
    const r = await collectRefs({ context: f.context, collect: s.collect, until, sleep: backoffSleep(waits, onWait) }).then(v => ({ v }), e => ({ code: e.code }));
    return { ...r, calls: s.calls, waits }; };
  // transient twice, then a complete one: the third collection is the answer, nothing of the failed ones
  let x = await run(['REFS_HTTP_503', 'REFS_TRANSPORT_UNCONFIRMED', 'ok']);
  assert.deepEqual([x.calls.length, x.waits, x.v], [3, [1000, 2000], x.calls[2]]);
  // transient three times: given up, unavailable
  x = await run(['REFS_HTTP_503', 'github_http_429', 'REFS_WINDOW_EXPIRED', 'ok']);
  assert.deepEqual([x.code, x.calls.length, x.waits], ['REMOTE_REFS_UNAVAILABLE', 3, [1000, 2000]]);
  // a refusal at once, also after a transient one
  for (const [plan, code, waits] of [[['REFS_HTTP_403'], 'REMOTE_REFS_REFUSED', []], [['REFS_HTTP_503', 'REFS_PAGE_LIMIT'], 'REMOTE_REFS_REFUSED', [1000]],
    [['REFS_SNAPSHOT_CHANGED'], 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', []], [['REFS_PR_SUBJECT_CHANGED'], 'full_admission_subject_changed', []]]) {
    x = await run(plan);
    assert.deepEqual([x.code, x.calls.length, x.waits], [code, plan.length, waits], plan.join());
  }
  // a retry only when its wait plus one whole collection ends before the deadline
  x = await run(['REFS_HTTP_503', 'ok'], Date.now() + REFS_COLLECTION_MS + 500);
  assert.deepEqual([x.code, x.calls.length, x.waits], ['REMOTE_REFS_UNAVAILABLE', 1, []]);
  x = await run(['REFS_HTTP_503', 'REFS_HTTP_503', 'ok'], Date.now() + REFS_COLLECTION_MS + 1500);
  assert.deepEqual([x.code, x.calls.length, x.waits], ['REMOTE_REFS_UNAVAILABLE', 2, [1000]]);
  // the held lease ends during a wait: no further collection, the lease's own code
  x = await run(['REFS_HTTP_503', 'ok'], far, () => f.stop());
  assert.deepEqual([x.code, x.calls.length], ['HELD_RECORD_LEASE_LOST', 1]);
});

test('issuer (gitleaks): before the issue a transient refs failure is collected again; given up it is a clean BLOCKED, a refusal too, nothing issued', WINDOWS, async t => {
  // [refs plan, stage window beyond the first callback reserve, result, collections, waits]
  for (const [plan, extra, reason, n, waits] of [
    [['REFS_HTTP_503', 'REFS_HTTP_503', 'REFS_HTTP_503'], 60_000, 'REMOTE_REFS_UNAVAILABLE', 3, [1000, 2000]],
    [['REFS_HTTP_503', 'ok'], 20_000, 'REMOTE_REFS_UNAVAILABLE', 1, []],
    [['REFS_HTTP_403', 'ok'], 60_000, 'REMOTE_REFS_REFUSED', 1, []]]) {
    const f = issuerFixture(t), root = await spool(t), s = scripted(plan), w = [];
    const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: s.collect, box: await createFixtureMailbox(root, 'windows'),
      sleep: backoffSleep(w), stageDeadline: Date.now() + CALLBACK_WINDOW_MS + extra });
    assert.deepEqual([r.status, r.reason, r.sideEffects, s.calls.length, w], ['BLOCKED', reason, 0, n, waits], plan.join());
    assert.equal(await exists(path.join(root, 'outgoing', 'issue.json')), false);
    // the stage fact: unavailable is the clean GitHub transient, a refusal is final (never attempt 2)
    const code = outcomeFailureCode({ status: 'BLOCKED', reason: r.reason, sideEffects: 0, mayHavePublished: false }, 2);
    assert.equal(code, reason === 'REMOTE_REFS_UNAVAILABLE' ? 'GITHUB_TRANSIENT_UNAVAILABLE' : 'STAGE_CHILD_REFUSED');
  }
  // transient once, then complete: issued with the complete snapshot of the second collection
  const f = issuerFixture(t), root = await spool(t), s = scripted(['github_transport_unconfirmed', 'ok']), w = [];
  const linux = linuxSide(async () => { const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    assert.deepEqual(issue.remoteRefs, s.calls[1]); await put(root, 'blocked', encode(makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'))); });
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: s.collect, box: await createFixtureMailbox(root, 'windows'),
    sleep: backoffSleep(w), signal: linux.signal, stageDeadline: Date.now() + CALLBACK_WINDOW_MS + 60_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, s.calls.length, w], ['BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 0, 2, [1000]]);
});

test('issuer (gitleaks): a slow refs collection (35 s, then retried) does not leave the admission stale at the issue (review M2)', WINDOWS, async t => {
  const realNow = Date.now, start = realNow();
  let skew = 0;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  const f = issuerFixture(t), root = await spool(t), w = [], calls = [];
  // the first collection takes 35 s and fails transiently (its own window ran out); the second is complete at once
  const collect = async () => { calls.push(calls.length); if (calls.length === 1) { skew += 35_000; throw coded('REFS_WINDOW_EXPIRED'); } return refsSnapshot(); };
  const linux = linuxSide(async () => { const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    // the issuer saw the moved clock: its issue is from after the slow collection
    assert.ok(Date.parse(issue.issuedAt) >= start + 35_000, issue.issuedAt);
    await put(root, 'blocked', encode(makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'))); });
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect, box: await createFixtureMailbox(root, 'windows'),
    sleep: backoffSleep(w), signal: linux.signal, stageDeadline: Date.now() + CALLBACK_WINDOW_MS + 120_000 });
  await linux;
  // issued (the Linux side then ended it cleanly), not BLOCKED on a stale admission before the issue
  assert.deepEqual([r.status, r.reason, calls.length, w], ['BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 2, [1000]]);
  assert.equal(await exists(path.join(root, 'outgoing', 'issue.json')), true);
});

test('issuer (gitleaks): a remote-refs callback retries a transient failure and answers the complete snapshot; still unavailable it is late (no UNCERTAIN); a refusal stays UNCERTAIN', WINDOWS, async t => {
  // [refs plan after the issue's collection, Linux: answer expected?, outcome status, reason, side effects, waits]
  for (const [plan, answered, status, reason, sideEffects, waits] of [
    [['REFS_HTTP_502', 'ok'], true, 'BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 0, [1000]],
    [['REFS_HTTP_503', 'REFS_TRANSPORT_UNCONFIRMED', 'REFS_HTTP_429', 'ok'], false, 'BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 0, [1000, 2000]],
    [['REFS_PAGE_SHAPE_UNKNOWN', 'ok'], false, 'UNCERTAIN', 'REMOTE_REFS_REFUSED', 1, []]]) {
    const f = issuerFixture(t), root = await spool(t), s = scripted(['ok', ...plan]), w = [];
    const linux = linuxSide(async () => {
      const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
      const challenge = makeChallenge(issue, 'remote-refs', 1);
      await put(root, 'challenge-01', encode(challenge));
      if (!answered) {
        // the worker gets no answer within its round and ends with its clean blocked record (simulated at once)
        for (const end = performance.now() + NO_ANSWER_WAIT_MS; s.calls.length < 1 + plan.length - 1 && performance.now() < end;) await new Promise(r => setTimeout(r, 20));
        if (status === 'BLOCKED') await put(root, 'blocked', encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
        return;
      }
      const response = validateResponse(issue, challenge, decode(await waitFor(path.join(root, 'outgoing', 'response-01.json'))));
      assert.deepEqual(response.remoteRefs, s.calls.at(-1), 'the answer is the complete collection after the retry');
      await put(root, 'blocked', encode(makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE')));
    });
    const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: s.collect, box: await createFixtureMailbox(root, 'windows'),
      sleep: backoffSleep(w), signal: linux.signal, stageDeadline: Date.now() + CALLBACK_WINDOW_MS + 60_000 });
    await linux;
    assert.deepEqual([r.status, r.reason, r.sideEffects, w], [status, reason, sideEffects, waits], plan.join());
    assert.equal(await exists(path.join(root, 'outgoing', 'response-01.json')), answered, plan.join());
  }
});

// ---- 2. the refs snapshot is fresh at the response's issuance ----
test('protocol v4: a remote-refs response is fresh at its issuance and only has to arrive inside its window; the adapter may measure from that issuance', () => {
  const { jobs } = setup(), gl = jobs.gitleaks, c = claim();
  const issue = makeIssue(gl, facts(gl, c), refsSnapshot(), { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), expiresAt: iso(Date.now() + 600_000) });
  const t = Date.now(), ch = makeChallenge(issue, 'remote-refs', 1, { now: t });
  const response = makeResponse(issue, ch, null, refsSnapshot(t + 10_000), { now: t + 10_500 });
  // the relay took 35 s: the snapshot is 35.5 s old on arrival, but was 0.5 s old when the issuer wrote the response
  const arrived = t + 10_500 + 35_000;
  assert.ok(validateResponse(issue, ch, decode(encode(response)), arrived));
  // arrival past the round is still refused; a snapshot stale at issuance is never issued, a forged later issuedAt neither
  assert.throws(() => validateResponse(issue, ch, decode(encode(response)), Date.parse(ch.deadline)), { code: 'BRIDGE_CHALLENGE_EXPIRED' });
  assert.throws(() => makeResponse(issue, ch, null, refsSnapshot(t), { now: t + 31_000 }), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  assert.throws(() => validateResponse(issue, ch, { ...decode(encode(makeResponse(issue, ch, null, refsSnapshot(t + 1000), { now: t + 1500 }))), issuedAt: iso(t + 31_500) }, t + 32_000),
    { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  // a snapshot observed after the response's issuance is refused
  assert.throws(() => validateResponse(issue, ch, { ...decode(encode(response)), remoteRefs: refsSnapshot(t + 10_600) }, t + 11_000), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  // the snapshot the worker hands the adapter keeps the response's issuance while the response is valid ...
  const given = callbackValue('remote-refs', decode(encode(response)));
  assert.equal(remoteRefsReferenceTime(given, arrived), Date.parse(response.issuedAt));
  assert.ok(validateRemoteSnapshot(given, gl, remoteRefsReferenceTime(given, arrived)));
  assert.equal(remoteRefsReferenceTime(given, Date.parse(response.expiresAt)), Date.parse(response.expiresAt), 'not past the response window');
  assert.throws(() => validateRemoteSnapshot(given, gl, remoteRefsReferenceTime(given, Date.parse(response.expiresAt))), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  // ... and any other copy keeps `now`
  const copy = structuredClone(given);
  assert.equal(remoteRefsReferenceTime(copy, arrived), arrived);
  assert.throws(() => validateRemoteSnapshot(copy, gl, arrived), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
});

// ---- 3. the changed-paths read: own refusals and 403 are not unavailable ----
test('changed-paths read: transient GitHub is unavailable (retried); the port\'s refusals, 403 and a moved PR are final; the stage fact agrees', async () => {
  for (const code of ['github_transport_unconfirmed', 'github_http_500', 'github_http_503', 'github_http_429', 'github_response_invalid', undefined])
    assert.equal(changedPathsFailure(code), 'full_admission_unavailable', String(code));
  for (const code of ['invalid_pr_subject', 'pr_files_changed', 'incomplete_pr_files', 'invalid_pr_files', 'pr_files_page_limit', 'unexpected_app_identity',
    'unexpected_installation_token_scope', 'unexpected_repository_scope', 'invalid_github_route'])
    assert.equal(changedPathsFailure(code), 'full_admission_paths_refused', code);
  assert.equal(changedPathsFailure('github_http_403'), 'full_admission_github_forbidden');
  assert.equal(changedPathsFailure('pr_subject_changed'), 'full_admission_subject_changed');
  // through issuerEvaluate: no admission is evaluated without the paths
  let evaluated = 0;
  const admission = { evaluatePr: async () => { evaluated++; return { status: 'ADMITTED' }; } };
  const r = await issuerEvaluate({ github: { readChangedPaths: async () => { throw coded('github_http_403'); } }, admission, job: {}, batchClaim: null })();
  assert.deepEqual([r, evaluated], [{ status: 'BLOCKED', reason: 'full_admission_github_forbidden', diagnostic: { phase: 'changed_paths' } }, 0]);
  // stage fact (issuer stages 2, 4, 6; clean BLOCKED, zero side effects): refusals are STAGE_CHILD_REFUSED, never transient
  const blocked = reason => ({ status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false });
  assert.deepEqual([...ISSUER_REFUSAL_REASONS].sort(), ['REMOTE_REFS_REFUSED', 'full_admission_github_forbidden', 'full_admission_paths_refused']);
  for (const stage of [2, 4, 6]) {
    for (const reason of ISSUER_REFUSAL_REASONS) {
      const code = outcomeFailureCode(blocked(reason), stage);
      assert.equal(code, 'STAGE_CHILD_REFUSED', `${reason}@${stage}`);
      assert.ok(!TRANSIENT_CODES.includes(code));
    }
    assert.equal(outcomeFailureCode(blocked('full_admission_unavailable'), stage), 'NATIVE_ADMISSION_UNAVAILABLE');
    assert.equal(outcomeFailureCode(blocked('REMOTE_REFS_UNAVAILABLE'), stage), 'GITHUB_TRANSIENT_UNAVAILABLE');
    assert.equal(outcomeFailureCode(blocked('full_admission_subject_changed'), stage), 'PR_NOT_OPEN_OR_CHANGED');
    // after the issue the same refusals are UNCERTAIN, as every refusal there
    assert.equal(outcomeFailureCode({ status: 'UNCERTAIN', reason: 'full_admission_paths_refused', sideEffects: 1 }, stage), 'PUBLICATION_UNCERTAIN');
  }
});

// ---- 2b. the gitleaks v4 adapter's three checks of the snapshot use one reference time ----
// The adapter itself needs the protected Linux root; offline, its three checks are driven directly with the reference
// time it computes (remoteRefsReferenceTime of the exact object the worker handed it), and its source is checked for
// that one computation before the run directory.
const GIT = [String.raw`C:\Program Files\Git\mingw64\libexec\git-core\git.exe`, '/usr/bin/git']
  .find(file => { try { const s = fsSync.lstatSync(file); return s.isFile() && s.nlink === 1; } catch { return false; } }) ?? null;

test('gitleaks v4: a snapshot 35 s old on arrival but fresh at the response\'s issuance passes all three checks; one stale at issuance is refused before the run directory', { skip: !GIT && 'no single-link git executable' }, async t => {
  const dir = await tempDir(t, 'clued-v2-refsat-'), repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
  const git = (...a) => { const r = spawnSync(GIT, a, { cwd: repo, env }); if (r.status !== 0) throw new Error(String(r.stderr)); return String(r.stdout).trim(); };
  git('init', '-q', '-b', 'main', '.');
  await fs.writeFile(path.join(repo, 'a.txt'), 'a'); git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'b.txt'), 'b'); git('add', 'b.txt'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD'), store = path.join(repo, '.git'), gitSha = sha(await fs.readFile(GIT));
  const manifest = Buffer.from(JSON.stringify({ schema: 'independent-ci.sources.v2', repo: REPO, sourceSha: 'c'.repeat(40),
    roles: { gitleaks: { sourceFiles: [], containerCommand: { image: GITLEAKS_IMAGE, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', cwd: '/input', args: SCAN_ARGS } } } }));
  const gl = batchJobsV2({ repo: REPO, pr: 888, headSha: head, baseSha: base, testSha: head, sourceManifestSha256: sha(manifest), createdAt: iso(Date.now() - 60_000), attempt: 1 }).gitleaks;
  const c = claim(), source = path.join(dir, 'source'), runs = path.join(dir, 'runs');
  await fs.mkdir(source); await fs.mkdir(runs);
  const snapshot = at => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(at), refs: [{ name: 'refs/heads/main', objectSha: base }, { name: 'refs/heads/pr', objectSha: head }] });
  const issue = makeIssue(gl, admittedFacts(gl, c, PACKET, { batchClaim: c }), snapshot(Date.now()), { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), expiresAt: iso(Date.now() + 600_000) });
  const t0 = Date.now(), ch = makeChallenge(issue, 'remote-refs', 1, { now: t0 });
  const response = makeResponse(issue, ch, null, snapshot(t0 + 10_000), { now: t0 + 10_500 });
  const arrived = t0 + 10_500 + 35_000; // the relay took 35 s
  const prepare = (remote, now) => prepareRequiredHistory({ job: gl, sourceManifestBytes: manifest, expectedSourceManifestSha256: sha(manifest), trustedSourceDirectory: source,
    gitDirectory: store, remoteSnapshot: remote, outputDirectory: path.join(runs, 'history'), gitExecutable: GIT, expectedGitSha256: gitSha, ...(now === undefined ? {} : { now }) });
  // the adapter's three checks, as it runs them: one reference time from the object the worker handed it, then a copy
  const checks = async (given, now) => {
    const refsAt = remoteRefsReferenceTime(given, now), remote = structuredClone(given);
    validateRemoteSnapshot(remote, gl, refsAt);
    await refsInStore({ job: gl, remoteSnapshot: remote, gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha, now: refsAt });
    // (here the adapter creates its run directory; a failure from now on is UNCERTAIN)
    return prepare(remote, refsAt).then(() => 'prepared', e => e.code);
  };
  const given = callbackValue('remote-refs', validateResponse(issue, ch, decode(encode(response)), arrived));
  assert.equal(remoteRefsReferenceTime(given, arrived), Date.parse(response.issuedAt));
  // accepted by all three; prepareRequiredHistory goes past its refs check (it stops later, at the fixture's missing source pins)
  assert.equal(await checks(given, arrived), 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED');
  // without the response's issuance (the old arrival rule) the same snapshot is refused
  assert.throws(() => validateRemoteSnapshot(structuredClone(given), gl, arrived), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  // stale relative to issuedAt (observed 31 s before it; a forged response, noted as the worker would): refused at the
  // first check, before the run directory, so a clean BLOCKED and never UNCERTAIN
  const stale = callbackValue('remote-refs', { ...decode(encode(response)), remoteRefs: snapshot(t0 + 10_500 - 31_000) });
  await assert.rejects(checks(stale, arrived), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  // past the response's own window the issuance no longer counts: refused at the first check as well
  await assert.rejects(checks(given, Date.parse(response.expiresAt) + 1), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
  // prepareRequiredHistory with `now` honours it; without it, it keeps measuring from its own clock (the old default)
  assert.equal(await prepare(snapshot(Date.now() - 31_000), Date.now() - 2_000).then(() => 'prepared', e => e.code), 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED');
  await assert.rejects(prepare(snapshot(Date.now() - 31_000)), { code: 'FRESH_COMPLETE_REMOTE_REFS_REQUIRED' });
});

test('gitleaks v4 adapter: the reference time is computed once, from the port\'s own object, before the run directory, and passed to all three checks', async () => {
  const text = await fs.readFile(new URL('../worker/formal-gitleaks-v4/adapter.mjs', import.meta.url), 'utf8');
  const at = s => { const i = text.indexOf(s); assert.ok(i >= 0, s); return i; };
  const once = at('const given=await remoteRefsPort(job),refsAt=remoteRefsReferenceTime(given,Date.now());');
  const clone = at('const remote=deepFreeze(structuredClone(given));validateRemoteSnapshot(remote,job,refsAt);');
  const store = at('expectedGitSha256:config.gitExecutableSha256,now:refsAt});');
  const mkdir = at('await fsp.mkdir(run,{mode:0o700})');
  const prepare = at('const prepared=await prepareRequiredHistory(');
  assert.ok(once < clone && clone < store && store < mkdir && mkdir < prepare);
  assert.ok(text.slice(prepare, text.indexOf('});', prepare)).includes('now:refsAt'));
  assert.equal(text.match(/remoteRefsReferenceTime\(/g).length, 1, 'one computation');
  assert.ok(!/validateRemoteSnapshot\(remote,job\)/.test(text));
});
