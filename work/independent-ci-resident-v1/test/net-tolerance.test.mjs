// Generation 10: network tolerance (DESIGN 53; Task 125a5162). A network outage must not burn a head, its cause must be visible in the
// logs (companion: halt-timeouts.test.mjs), and once the network is back the heads run again within 10 minutes; the breaker of a network
// outage waits 10 minutes, never stacks its delay for the same outage, comes forward on read-only probes that reach the outside and on
// the Owner's release; the board and the PR page say what really happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NETWORK_CAUSE, NETWORK_FAULT_CODES, POSITIONS, breakerGate, breakerOf, breakerProbe, breakerRecord, breakerRelease, breakerView, closedBreaker, positionOf } from '../src/breaker.mjs';
import { POLICY_CONTRACT_V8, POLICY_CONTRACT_V9, TRAIN_DEFAULTS, validatePolicy } from '../src/policy.mjs';
import { BREAKER_RELEASE_CONTRACT } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { attempt2Decision } from '../src/attempts.mjs';
import { classifyFailure, decideFailure, TRANSIENT_CODES } from '../src/classify.mjs';
import { describe, reportDue, statusSignature, REPORT_MIN_GAP_MS } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { breakerReleaseRequest, inspect, readBreakerView } from '../tools/rearm-tool.mjs';
import { BASE, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const H = n => String(n).repeat(40).slice(0, 40);
const NETWORK = Object.freeze({ backoffMs: [10 * MIN, 30 * MIN, 60 * MIN], earlyTrialProbes: 2 });
// /9 as it would be installed: the train in shadow (stage 10 runs on quiet ticks, as on DESK-W-591), breaker.network given.
const policyV9 = (network = NETWORK, o = {}) => { const p = rawPolicy(); return rawPolicy({ contract: POLICY_CONTRACT_V9, breaker: { ...p.breaker, ...(network ? { network } : {}) },
  train: { ...p.train, enabled: 'shadow', ...TRAIN_DEFAULTS }, ...o }); };
const policyV8 = () => { const p = rawPolicy(); return rawPolicy({ contract: POLICY_CONTRACT_V8, train: { ...p.train, ...TRAIN_DEFAULTS } }); };
const fail = (pos, pr, code) => ({ pos, counts: true, neutral: false, completed: false, windowsOnly: true, pr, code });
const done = pr => ({ pos: POSITIONS.END, counts: false, neutral: true, completed: true, windowsOnly: false, pr, code: null });
const receiptBodies = async (f, type) => {
  const dir = path.join(f.root, 'state', 'receipts');
  const out = [];
  for (const n of (await fs.readdir(dir)).sort()) if (n.replace(/^\d+-|\.json$/g, '') === type) out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')).body);
  return out;
};
const SID = 'S-1-5-21-1-2-3-1001';
let ownerSeq = 0;
const ownerFile = async (f, value) => {
  ownerSeq += 1;
  const name = `${String(f.clock()).padStart(13, '0')}-${String(ownerSeq).padStart(12, '0')}.json`;
  await fs.writeFile(path.join(f.root, 'owner', name), JSON.stringify(value));
};

// ---- policy /9 ----

test('policy /9: breaker.network is required, bounded, may only shorten the first wait; /7 and /8 refuse it and stay as they were', () => {
  const p = validatePolicy(policyV9());
  assert.deepEqual([p.contract, p.breaker.network.backoffMs, p.breaker.network.earlyTrialProbes], [POLICY_CONTRACT_V9, [10 * MIN, 30 * MIN, 60 * MIN], 2]);
  const base = rawPolicy().breaker;
  assert.throws(() => validatePolicy(policyV9(null)), { code: 'POLICY_BREAKER_KEYS_INVALID' }, '/9 needs breaker.network');
  assert.throws(() => validatePolicy(rawPolicy({ breaker: { ...base, network: NETWORK } })), { code: 'POLICY_BREAKER_KEYS_INVALID' }, '/7 has no network key');
  assert.throws(() => validatePolicy({ ...policyV8(), breaker: { ...base, network: NETWORK } }), { code: 'POLICY_BREAKER_KEYS_INVALID' }, '/8 has no network key');
  for (const bad of [{ backoffMs: [31 * MIN], earlyTrialProbes: 2 }, { backoffMs: [], earlyTrialProbes: 2 }, { backoffMs: [59_999], earlyTrialProbes: 2 }, { backoffMs: [20 * MIN, 10 * MIN], earlyTrialProbes: 2 },
    { backoffMs: [10 * MIN], earlyTrialProbes: 0 }, { backoffMs: [10 * MIN], earlyTrialProbes: 11 }, { backoffMs: Array(7).fill(10 * MIN), earlyTrialProbes: 2 }])
    assert.throws(() => validatePolicy(policyV9(bad)), { code: 'POLICY_BREAKER_NETWORK_INVALID' }, JSON.stringify(bad));
  assert.throws(() => validatePolicy(policyV9({ backoffMs: [10 * MIN], earlyTrialProbes: 2, extra: 1 })), { code: 'POLICY_BREAKER_NETWORK_KEYS_INVALID' });
  // /9 takes the /8 train settings
  assert.throws(() => validatePolicy(policyV9(NETWORK, { train: rawPolicy().train })), { code: 'POLICY_TRAIN_KEYS_INVALID' });
  assert.equal(validatePolicy(policyV8()).contract, POLICY_CONTRACT_V8);
});

test('policy /9 example: the installed /8 values plus breaker.network (10, 30, 60 minutes; 2 probes)', async () => {
  const read = async f => JSON.parse(await fs.readFile(new URL(`../config/${f}`, import.meta.url), 'utf8'));
  const v8 = await read('policy.v8-shadow.example.json'), v9 = await read('policy.v9.example.json');
  const p = validatePolicy(v9);
  assert.equal(p.contract, POLICY_CONTRACT_V9);
  const { network, ...rest } = v9.breaker;
  assert.deepEqual(network, { backoffMs: [600000, 1800000, 3600000], earlyTrialProbes: 2 });
  assert.deepEqual({ ...v9, contract: v8.contract, breaker: rest }, v8, 'nothing else differs from /8');
});

// ---- the breaker ----

test('breaker /9: network faults open it for 10 minutes; the same outage failing the trial keeps the level; another fault escalates', () => {
  const policy = validatePolicy(policyV9());
  assert.deepEqual([...NETWORK_FAULT_CODES], ['BUNDLE_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE', 'NATIVE_ADMISSION_UNAVAILABLE', 'ADMISSION_VERIFICATION_UNAVAILABLE']);
  let now = 0;
  const b = closedBreaker();
  for (const [pr, code] of [[1, 'BUNDLE_UNAVAILABLE'], [2, 'BUNDLE_UNAVAILABLE'], [3, 'GITHUB_TRANSIENT_UNAVAILABLE']]) breakerRecord(b, fail(positionOf(0, 'bundle'), pr, code), policy, now += MIN);
  assert.deepEqual([b.state, b.cause, b.level, (b.nextTrialAt - now) / MIN], ['open', NETWORK_CAUSE, 0, 10]);
  for (let i = 0; i < 5; i += 1) {
    now = b.nextTrialAt;
    assert.equal(breakerGate(b, now).trial, true);
    assert.equal(breakerRecord(b, fail(positionOf(0, 'bundle'), 9, 'BUNDLE_UNAVAILABLE'), policy, now), 'reopened');
    assert.deepEqual([b.cause, b.level, (b.nextTrialAt - now) / MIN], [NETWORK_CAUSE, 0, 10], `trial ${i}: one outage never stacks its delay`);
  }
  // a different fault in the trial (at the failing place): the next level of the policy's own delays, and the cause is no longer network
  now = b.nextTrialAt; breakerGate(b, now);
  breakerRecord(b, fail(positionOf(0, 'bundle'), 9, 'STAGE_PACKAGE_REFUSED'), policy, now);
  assert.deepEqual([b.cause, b.level, (b.nextTrialAt - now) / MIN], [null, 1, 60]);
  // then a network fault again: the policy's ladder goes on (the outage is no longer the only cause)
  now = b.nextTrialAt; breakerGate(b, now);
  breakerRecord(b, fail(positionOf(0, 'bundle'), 9, 'BUNDLE_UNAVAILABLE'), policy, now);
  assert.deepEqual([b.cause, b.level, (b.nextTrialAt - now) / MIN], [null, 2, 120]);
  // a trial that gets through closes it as before
  now = b.nextTrialAt; breakerGate(b, now);
  assert.equal(breakerRecord(b, done(9), policy, now), 'closed');
  assert.deepEqual([b.state, b.cause, b.probeOks], ['closed', null, 0]);
});

test('breaker /9: a mixed opening (any non-network fault) and every /7 or /8 policy keep the old delays and escalation', () => {
  const mixed = closedBreaker(), policy = validatePolicy(policyV9());
  let now = 0;
  for (const [pr, code] of [[1, 'BUNDLE_UNAVAILABLE'], [2, 'STAGE_PACKAGE_REFUSED'], [3, 'BUNDLE_UNAVAILABLE']]) breakerRecord(mixed, fail(positionOf(0, 'bundle'), pr, code), policy, now += MIN);
  assert.deepEqual([mixed.cause, (mixed.nextTrialAt - now) / MIN], [null, 30]);
  for (const p of [validatePolicy(rawPolicy()), validatePolicy(policyV8())]) {
    const b = closedBreaker(); now = 0;
    for (const pr of [1, 2, 3]) breakerRecord(b, fail(positionOf(0, 'bundle'), pr, 'BUNDLE_UNAVAILABLE'), p, now += MIN);
    assert.deepEqual([b.cause, (b.nextTrialAt - now) / MIN], [null, 30], p.contract);
    now = b.nextTrialAt; breakerGate(b, now); breakerRecord(b, fail(positionOf(0, 'bundle'), 9, 'BUNDLE_UNAVAILABLE'), p, now);
    assert.deepEqual([b.level, (b.nextTrialAt - now) / MIN], [1, 60], p.contract);
    assert.equal(breakerProbe(b, true, p, now), null, 'no probe listening without breaker.network');
  }
  // a breaker carried from generation 9 (no cause, no probe count, streak entries without codes) reads as before
  const old = { ...closedBreaker(), streakFails: [{ pos: 1, windowsOnly: true }, { pos: 1, windowsOnly: true }], streak: 2, streakPos: 1, streakPrs: [1, 2] };
  delete old.cause; delete old.probeOks;
  const b = breakerOf(old);
  breakerRecord(b, fail(positionOf(0, 'bundle'), 3, 'BUNDLE_UNAVAILABLE'), policy, 10 * MIN);
  assert.deepEqual([b.state, b.cause, (b.nextTrialAt - 10 * MIN) / MIN], ['open', null, 30], 'codes the old entries never had are not assumed to be network');
});

test('breaker /9: read-only probes in a row bring a network trial forward; a failed probe starts the count again; release by the Owner', () => {
  const policy = validatePolicy(policyV9({ backoffMs: [30 * MIN], earlyTrialProbes: 2 }));
  let now = 0;
  const b = closedBreaker();
  for (const pr of [1, 2, 3]) breakerRecord(b, fail(positionOf(0, 'bundle'), pr, 'BUNDLE_UNAVAILABLE'), policy, now += MIN);
  const due = b.nextTrialAt;
  assert.equal((due - now) / MIN, 30);
  assert.equal(breakerProbe(b, true, policy, now += MIN), null);
  assert.equal(breakerProbe(b, false, policy, now += MIN), null, 'the outage is still there');
  assert.equal(breakerProbe(b, true, policy, now += MIN), null, 'one in a row again');
  assert.equal(b.nextTrialAt, due);
  assert.equal(breakerProbe(b, true, policy, now += MIN), 'early-trial');
  assert.deepEqual([b.nextTrialAt, b.probeOks, breakerGate(b, now).trial], [now, 0, true]);
  assert.equal(breakerProbe(b, true, policy, now), null, 'half-open listens to nothing');
  // a non-network breaker never listens to probes
  const other = closedBreaker(); now = 0;
  for (const pr of [1, 2, 3]) breakerRecord(other, fail(positionOf(1), pr, 'STAGE_PACKAGE_REFUSED'), policy, now += MIN);
  assert.equal(breakerProbe(other, true, policy, now += MIN), null); assert.equal(breakerProbe(other, true, policy, now += MIN), null);
  // the Owner's release: any open breaker's trial is due now; it never closes, never touches a closed or half-open one
  const before = other.nextTrialAt;
  const r = breakerRelease(other, now);
  assert.deepEqual([r.released, r.previousNextTrialAt, other.nextTrialAt, other.state], [true, before, now, 'open']);
  assert.equal(breakerGate(other, now).trial, true);
  assert.deepEqual(breakerRelease(other, now), { released: false, code: 'BREAKER_NOT_OPEN', state: 'half-open' });
  assert.deepEqual(breakerRelease(closedBreaker(), now), { released: false, code: 'BREAKER_NOT_OPEN', state: 'closed' });
  assert.equal(breakerView(b).cause, NETWORK_CAUSE);
});

// ---- stage 1: a withdrawal that could not be verified ----

test('ADMISSION_VERIFICATION_UNAVAILABLE: transient, clean with the cleanup proof, burns attempt 1 into the one automatic attempt 2 (stage 1 only)', () => {
  assert.ok(TRANSIENT_CODES.includes('ADMISSION_VERIFICATION_UNAVAILABLE'));
  const proof = { ...WINDOWS_CLEAN, linuxUnitsInactive: true, containersZero: true };
  assert.equal(classifyFailure('ADMISSION_VERIFICATION_UNAVAILABLE', proof, 1).klass, 'CLEAN');
  const d = decideFailure({ code: 'ADMISSION_VERIFICATION_UNAVAILABLE', stage: 1, outcome: { status: 'REVOKED', reason: 'full_admission_unavailable', sideEffects: 2 }, proof, started: false });
  assert.deepEqual([d.klass, d.release, d.row.class, d.row.retry, d.row.breaker], ['CLEAN', null, 'transient', 'attempt2', 'counts']);
  const policy = validatePolicy(rawPolicy());
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 1, headSha: H(1), baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 };
  assert.deepEqual(attempt2Decision({ policy, subject, outcome: 'FAILED_CLEAN', failure: { code: 'ADMISSION_VERIFICATION_UNAVAILABLE', stageNumber: 1, phase: 'stage' } }), { eligible: true, reason: null });
  assert.equal(attempt2Decision({ policy, subject: { ...subject, attempt: 2 }, outcome: 'FAILED_CLEAN', failure: { code: 'ADMISSION_VERIFICATION_UNAVAILABLE', stageNumber: 1 } }).eligible, false);
});

test('executor: stage 1 withdrew its check unverified: attempt 2 runs it again after the delay and the PR completes, no new commit', async t => {
  const engine = fakeEngine();
  const run = engine.runStage;
  let firsts = 0;
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1 && firsts++ === 0) { engine.calls.push(['stage', 1]); return { ok: false, code: 'ADMISSION_VERIFICATION_UNAVAILABLE', proof: WINDOWS_CLEAN,
      outcome: { status: 'REVOKED', reason: 'full_admission_unavailable', sideEffects: 2, mayHavePublished: true }, brokerNoLaunch: false }; }
    return run(batch, stage, o);
  };
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.deepEqual([first.state, first.failureCode], ['FAILED_CLEAN', 'ADMISSION_VERIFICATION_UNAVAILABLE']);
  assert.equal((await f.ledger.pendingAttempts2()).length, 1, 'attempt 2 is scheduled');
  f.advance(10 * MIN + 1);
  const second = await f.exec.tick();
  assert.equal(second.state, 'COMPLETED', JSON.stringify(second));
  assert.equal(engine.calls.filter(c => c[0] === 'stage' && c[1] === 1).length, 2);
});

// ---- the simulated outage, end to end ----

async function outage(t, { minutes, policy = policyV9() } = {}) {
  const net = { down: true };
  const train = mode => (net.down ? { ok: false, code: 'TRAIN_STAGE_REFUSED', proof: WINDOWS_CLEAN, outcome: null } : fakeEngine().runTrainStage(mode));
  const engine = fakeEngine({ train });
  const f = await executorFixture(t, { engine, policy });
  f.companion.buildBundle = async () => { f.companion.calls.push(['bundle']); return net.down ? { ok: false, code: 'BUNDLE_UNAVAILABLE' } : { ok: true }; };
  for (const n of [1, 2, 3]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
  let opened = null;
  for (let m = 0; m < minutes; m += 1) {
    await f.exec.tick();
    if (!opened && f.queue.breaker?.state === 'open') opened = { at: f.clock(), nextTrialAt: f.queue.breaker.nextTrialAt, cause: f.queue.breaker.cause };
    f.advance(MIN);
  }
  return { f, net, engine, opened };
}

test('a 45-minute network outage (BUNDLE_UNAVAILABLE): no head burned, no row stopped, every PR runs within 10 minutes of the network coming back', async t => {
  const { f, net, engine, opened } = await outage(t, { minutes: 45 });
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage' && c[1] !== 10), [], 'nothing ran past the bundle');
  assert.deepEqual([opened.cause, (opened.nextTrialAt - opened.at) / MIN], [NETWORK_CAUSE, 10], 'the network breaker waits 10 minutes');
  assert.equal(f.queue.breaker.level, 0, 'the same outage never stacked its delay');
  const u = await f.ledger.usage(0);
  for (const n of [1, 2, 3]) {
    const s = { repo: 'tdoljyj/cross-memory-system', pr: n, headSha: H(n), baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 };
    assert.equal(await f.ledger.headBurned(headKey(s)), false, `PR ${n} head not burned`);
    assert.notEqual(f.queue.row(n).state, 'STOPPED', `PR ${n} not stopped`);
    assert.equal(u.releasesByHead.get(H(n)), undefined, `PR ${n}: no release counted towards its cap`);
  }
  assert.equal(u.evaluations, 0, 'an outage spends no evaluation');
  assert.ok((await receiptBodies(f, 'batch-unexecuted')).every(b => b.failureCode === 'BUNDLE_UNAVAILABLE'));
  // the network comes back
  net.down = false;
  const back = f.clock(), ran = {}, trace = [];
  const keyOf = Object.fromEntries([1, 2, 3].map(n => [batchKey({ repo: 'tdoljyj/cross-memory-system', pr: n, headSha: H(n), baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 }), n]));
  for (let m = 0; m <= 20 && Object.keys(ran).length < 3; m += 1) {
    const r = await f.exec.tick();
    trace.push(`${m}:${r.state}:${r.reason ?? r.failureCode ?? ''}:${keyOf[r.key] ?? ''}`);
    if (r.state === 'COMPLETED') ran[keyOf[r.key]] = f.clock();
    f.advance(MIN);
  }
  const times = Object.values(ran).map(at => (at - back) / MIN).sort((a, b) => a - b);
  assert.equal(times.length, 3, trace.join(' '));
  assert.ok(times[0] <= 10, `the first PR ran ${times[0]} minutes after the network came back`);
  assert.ok(times[2] <= 12, `all three ran by ${times[2]} minutes (one batch at a time after the trial): ${times}`);
  assert.equal(f.queue.breaker.state, 'closed');
  for (const n of [1, 2, 3]) assert.equal(f.queue.row(n).state, 'DONE', `PR ${n}`);
});

test('the outage under the installed /8 policy: still no head burned and no row stopped (generation 10 counting); the breaker keeps its 30-minute ladder', async t => {
  const { f, opened } = await outage(t, { minutes: 40, policy: policyV8() });
  assert.deepEqual([opened.cause, (opened.nextTrialAt - opened.at) / MIN], [null, 30]);
  for (const n of [1, 2, 3]) assert.notEqual(f.queue.row(n).state, 'STOPPED', `PR ${n}`);
});

test('stage-10 runs that reach GitHub bring a network trial forward (early-trial receipt); failed ones do not', async t => {
  const policy = policyV9({ backoffMs: [30 * MIN], earlyTrialProbes: 2 });
  const { f, net } = await outage(t, { minutes: 4, policy });
  assert.deepEqual([f.queue.breaker.state, f.queue.breaker.cause], ['open', NETWORK_CAUSE]);
  const due = f.queue.breaker.nextTrialAt;
  assert.deepEqual(await receiptBodies(f, 'breaker-early-trial'), [], 'the failing stage-10 runs while down are no probes that reached the outside');
  net.down = false;
  // stage 10 runs every 10 minutes (maintenanceEveryMs) while the breaker holds the batches back
  let early = null;
  for (let m = 0; m < 25 && !early; m += 1) {
    await f.exec.tick();
    const r = await receiptBodies(f, 'breaker-early-trial');
    if (r.length) early = { at: f.clock(), body: r[0] };
    f.advance(MIN);
  }
  assert.ok(early, 'two good stage-10 runs in a row brought the trial forward');
  assert.ok(early.at < due, 'before the 30-minute trial time');
  assert.deepEqual([early.body.probe, early.body.cause, early.body.level], ['train-run', NETWORK_CAUSE, 0]);
  f.advance(MIN);
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', 'the trial runs at once and gets through');
  assert.equal(f.queue.breaker.state, 'closed');
});

test('the Owner releases an open breaker early (reason in the receipt); a breaker that is not open refuses; the request shape is the script\'s', async t => {
  const { f } = await outage(t, { minutes: 4, policy: validatePolicy(rawPolicy()) && rawPolicy() });
  assert.equal(f.queue.breaker.state, 'open');
  const before = f.queue.breaker.nextTrialAt;
  const req = breakerReleaseRequest({ reason: 'network back (checked by hand)', by: SID }, f.clock);
  assert.equal(req.contract, BREAKER_RELEASE_CONTRACT);
  await ownerFile(f, req);
  await f.exec.tick();
  const [rec] = (await receiptBodies(f, 'owner-request')).filter(b => b.kind === 'breaker-release');
  assert.ok(rec, 'recorded');
  assert.deepEqual([rec.reason, rec.by, rec.previousNextTrialAt, rec.level, rec.cause], ['network back (checked by hand)', SID, new Date(before).toISOString(), 0, null]);
  assert.ok(Date.parse(rec.nextTrialAt) < before);
  // the trial already started in that same tick (the bundle still fails: the breaker reopened, the Owner's release closed nothing)
  assert.equal(f.queue.breaker.state, 'open');
  // a second request while the breaker is half-open or closed: refused, recorded as such
  f.queue.breaker = { ...f.queue.breaker, state: 'closed' };
  await ownerFile(f, breakerReleaseRequest({ reason: 'again', by: SID }, () => f.clock() + 1));
  f.advance(1);
  await f.exec.tick();
  const refused = await receiptBodies(f, 'owner-request-refused');
  assert.ok(refused.some(b => b.failureCode === 'BREAKER_NOT_OPEN'), JSON.stringify(refused));
  // malformed: refused, nothing changes
  await ownerFile(f, { ...req, nonce: 'x', reason: '' });
  f.advance(1);
  await f.exec.tick();
  assert.ok((await receiptBodies(f, 'owner-request-refused')).some(b => b.failureCode === 'OWNER_REQUEST_REFUSED'));
  assert.throws(() => breakerReleaseRequest({ reason: '', by: SID }), { code: 'BREAKER_RELEASE_REASON_REQUIRED' });
  assert.throws(() => breakerReleaseRequest({ reason: 'x'.repeat(201), by: SID }), { code: 'BREAKER_RELEASE_REASON_REQUIRED' });
  // the inspection shows the breaker the release would act on
  const view = await readBreakerView(path.join(f.root, 'state'));
  assert.equal(view.state, f.queue.breaker.state);
  assert.equal((await inspect({ ledger: f.ledger, receipts: f.receipts, breaker: view })).breaker, view);
  assert.equal(await readBreakerView(path.join(f.root, 'no-such-state')), null);
});

test('rearm-resident.ps1 -Request ReleaseBreaker writes exactly the fields the service validates and needs a reason', async () => {
  const text = await fs.readFile(new URL('../windows/rearm-resident.ps1', import.meta.url), 'utf8');
  assert.match(text, /\[ValidateSet\('Rearm', 'Resume', 'Abort', 'ReleaseBreaker'\)\]/);
  const line = text.split('\n').find(l => l.includes(`contract = '${BREAKER_RELEASE_CONTRACT}'`));
  assert.ok(line, 'the release body is written by the script');
  assert.deepEqual([...line.matchAll(/(\w+) = /g)].map(m => m[1]).sort(), ['by', 'contract', 'nonce', 'reason', 'requestedAt']);
  assert.match(text, /if \(-not \$Reason\) \{ throw 'BREAKER_RELEASE_REASON_REQUIRED' \}/);
});

// ---- the board and the PR page ----

test('status: the claimed batch and a started trial are written at once (statusFlush), the executor shows RUNNING and the breaker half-open', async t => {
  const status = new StatusBoard({ clock: () => 0 });
  const seen = [];
  const statusFlush = async () => { const s = status.snapshot(); seen.push({ executor: s.executor.state, current: s.current?.pr ?? null, stage: s.current?.stage ?? null, breaker: s.breaker?.state ?? null,
    row: s.pending.find(p => p.pr === 2)?.state ?? null }); };
  const net = { down: true };
  const f = await executorFixture(t, { status, statusFlush });
  f.companion.buildBundle = async () => (net.down ? { ok: false, code: 'BUNDLE_UNAVAILABLE' } : { ok: true });
  for (const n of [1, 2, 3]) { await f.drop(triggerBytes({ pr: n, headSha: H(n) })); await f.exec.tick(); f.advance(MIN); }
  assert.equal(f.queue.breaker.state, 'open');
  assert.ok(seen.length >= 3 && seen.every(x => x.executor === 'RUNNING' && x.current !== null && x.stage === 0), JSON.stringify(seen));
  seen.length = 0;
  net.down = false;
  f.advance(30 * MIN);
  await f.exec.tick();
  assert.equal(seen[0].breaker, 'half-open', 'the trial is on the board before the batch runs');
  assert.equal(seen[1].executor, 'RUNNING');
  assert.notEqual(seen[1].current, null);
});

test('PR page: a trial time that has come or a half-open breaker never reads "熔断中"; an open network breaker says so', () => {
  const now = Date.parse('2026-11-05T03:20:10Z');
  const pull = { pr: 989, headSha: H(7), eligible: true };
  const base = { writtenAt: now, current: null, halt: null, paused: false, backfill: { complete: true }, intakePause: null, queue: null, recent: [],
    pending: [{ pr: 989, headSha: H(7), state: 'QUEUED', position: 1, deferred: null }] };
  const at = (breaker) => describe({ pull, status: { ...base, breaker }, now }).description;
  assert.match(at({ state: 'open', nextTrialAt: now + 5 * MIN, cause: 'network' }), /熔断中（网络故障），约 \d\d:\d\dZ? 试跑/);
  assert.match(at({ state: 'open', nextTrialAt: now + 5 * MIN, cause: null }), /执行器熔断中，约/);
  for (const b of [{ state: 'open', nextTrialAt: now - 2 * MIN, cause: 'network' }, { state: 'open', nextTrialAt: now, cause: null }, { state: 'half-open', nextTrialAt: null, cause: null }]) {
    const d = at(b);
    assert.doesNotMatch(d, /熔断中/, JSON.stringify(b));
    assert.match(d, /熔断后的试跑/);
  }
  // the parsed board keeps the cause (and only "network")
  const board = new StatusBoard({ clock: () => now });
  board.update({ breaker: { state: 'open', openedAt: now, nextTrialAt: now + MIN, level: 0, failingPos: 1, recent: 3, streak: 3, cause: 'network' } });
  assert.equal(parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).breaker.cause, 'network');
  board.update({ breaker: { state: 'open', openedAt: now, nextTrialAt: now + MIN, level: 0, failingPos: 1, recent: 3, streak: 3, cause: 'other' } });
  assert.equal(parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).breaker.cause, null);
});

test('companion: the PR page is posted at once when the batch, its stage, the breaker or HALT/PAUSE changed; otherwise once a minute', () => {
  const s = (o = {}) => ({ current: null, breaker: { state: 'open', nextTrialAt: 1 }, halt: null, paused: false, ...o });
  const sig = statusSignature(s());
  assert.equal(statusSignature(null), null);
  for (const o of [{ current: { key: 'k', pr: 1, headSha: H(1), stage: 0, phase: 'bundle' } }, { breaker: { state: 'half-open', nextTrialAt: null } }, { breaker: { state: 'open', nextTrialAt: 2 } },
    { halt: { code: 'X' } }, { paused: true }]) assert.notEqual(statusSignature(s(o)), sig, JSON.stringify(o));
  assert.equal(statusSignature(s({ recent: [{ x: 1 }], writtenAt: 99 })), sig, 'what the page does not show does not count');
  const every = 60_000;
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - every - 1, lastSignature: sig, signature: sig, everyMs: every }), true, 'the minute');
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - 30_000, lastSignature: sig, signature: sig, everyMs: every }), false);
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - 30_000, lastSignature: sig, signature: 'other', everyMs: every }), true, 'a change: at once');
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - REPORT_MIN_GAP_MS, lastSignature: sig, signature: 'other', everyMs: every }), false, 'never twice within the gap');
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - 30_000, lastSignature: sig, signature: null, everyMs: every }), false, 'an unreadable board waits for the minute');
});

test('companion-main reads the board every few seconds and posts on a change (wiring)', async () => {
  const text = await fs.readFile(new URL('../src/companion-main.mjs', import.meta.url), 'utf8');
  assert.match(text, /if \(Date\.now\(\) - lastReport > REPORT_MIN_GAP_MS\) \{/);
  assert.match(text, /if \(reportDue\(\{ now: Date\.now\(\), lastReport, lastSignature, signature, everyMs: REPORT_EVERY_MS \}\)\) \{/);
  const svc = await fs.readFile(new URL('../src/service-main.mjs', import.meta.url), 'utf8');
  assert.match(svc, /statusFlush: \(\) => statusTimer\.flush\(\),/);
});

test('executor: a stage-10 run or role probe that cannot reach the outside resets the probe count (noteBreakerProbe)', async t => {
  const f = await executorFixture(t, { policy: policyV9({ backoffMs: [30 * MIN], earlyTrialProbes: 2 }) });
  f.queue.breaker = { ...closedBreaker(), state: 'open', cause: NETWORK_CAUSE, openedAt: f.clock(), nextTrialAt: f.clock() + 30 * MIN, failingPos: 1, failingWindowsOnly: true };
  assert.equal(await f.exec.noteBreakerProbe(true, 'role-probe'), null);
  assert.equal(await f.exec.noteBreakerProbe(false, 'train-run'), null);
  assert.equal(f.queue.breaker.probeOks, 0);
  assert.equal(await f.exec.noteBreakerProbe(true, 'role-probe'), null);
  assert.equal(await f.exec.noteBreakerProbe(true, 'train-run'), 'early-trial');
  assert.equal(f.queue.breaker.nextTrialAt, f.clock());
  const [r] = await receiptBodies(f, 'breaker-early-trial');
  assert.equal(r.probe, 'train-run');
  // the queue file holds it (a restart keeps the early trial)
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'queue', 'queue.json'), 'utf8'));
  assert.equal(saved.breaker.nextTrialAt, f.clock());
  assert.equal(await f.exec.noteBreakerProbe(true, 'train-run'), null, 'closed or half-open: nothing to bring forward');
});
