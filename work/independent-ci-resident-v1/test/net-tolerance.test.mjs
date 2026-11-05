// Generation 10: network tolerance (DESIGN 53; Task 125a5162). A network outage must not burn a head, its cause must be visible in the
// logs (companion: halt-timeouts.test.mjs), and once the network is back the heads run again within 10 minutes; a fault that only LOOKS
// like an environment fault (a deterministic bundle refusal) keeps the release cap; the breaker of a network outage waits 10 minutes,
// never stacks its delay for the same outage, comes forward on read-only probes that really reached the outside and on the Owner's
// release; the board and the PR page say what really happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NETWORK_CAUSE, POSITIONS, breakerGate, breakerOf, breakerProbe, breakerRecord, breakerRelease, breakerView, closedBreaker, positionOf } from '../src/breaker.mjs';
import { POLICY_CONTRACT_V8, POLICY_CONTRACT_V9, TRAIN_DEFAULTS, validatePolicy } from '../src/policy.mjs';
import { BREAKER_RELEASE_CONTRACT } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { attempt2Decision } from '../src/attempts.mjs';
import { NETWORK_GITHUB_REASONS, classifyFailure, decideFailure, networkFailure, TRANSIENT_CODES } from '../src/classify.mjs';
import { BUNDLE_NETWORK_UNAVAILABLE } from '../src/companion.mjs';
import { describe, reportDue, statusSignature, REPORT_MIN_GAP_MS } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus, startStatusTimer } from '../src/status.mjs';
import { parseStageOutcome } from '../src/engine-windows.mjs';
import { breakerReleaseRequest, inspect, readBreakerView } from '../tools/rearm-tool.mjs';
import { BASE, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const H = n => String(n).repeat(40).slice(0, 40);
const MAIN = 'a'.repeat(40);
const NETWORK = Object.freeze({ trialDelayMs: 10 * MIN, earlyTrialProbes: 2, releasesPerHeadPer24h: 36 });
// /9 as it would be installed: the train in shadow (stage 10 runs on quiet ticks, as on DESK-W-591), breaker.network given.
const policyV9 = (network = NETWORK, o = {}) => { const p = rawPolicy(); return rawPolicy({ contract: POLICY_CONTRACT_V9, breaker: { ...p.breaker, ...(network ? { network } : {}) },
  train: { ...p.train, enabled: 'shadow', ...TRAIN_DEFAULTS }, ...o }); };
const policyV8 = () => { const p = rawPolicy(); return rawPolicy({ contract: POLICY_CONTRACT_V8, train: { ...p.train, enabled: 'shadow', ...TRAIN_DEFAULTS } }); };
const fail = (pos, pr, code, network = false) => ({ pos, counts: true, neutral: false, completed: false, windowsOnly: true, pr, code, network });
const net = (pr, code = 'BUNDLE_UNAVAILABLE') => fail(positionOf(0, 'bundle'), pr, code, true);
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
const subjectOf = n => ({ repo: 'tdoljyj/cross-memory-system', pr: n, headSha: H(n), baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 });
// Stage 10 as the fake engine reports it: up (it read main from GitHub) or down (refused, nothing read).
const trainUp = mode => { const r = fakeEngine().runTrainStage(mode); return r.then(x => ({ ...x, train: { ...x.train, mainSha: MAIN } })); };
const trainDown = () => ({ ok: false, code: 'TRAIN_STAGE_REFUSED', proof: WINDOWS_CLEAN, outcome: null });

// ---- policy /9 ----

test('policy /9: breaker.network is required and bounded; the trial delay may only shorten the wait; /7 and /8 refuse it and stay as they were', () => {
  const p = validatePolicy(policyV9());
  assert.deepEqual([p.contract, p.breaker.network], [POLICY_CONTRACT_V9, { trialDelayMs: 600_000, earlyTrialProbes: 2, releasesPerHeadPer24h: 36 }]);
  const base = rawPolicy().breaker;
  assert.throws(() => validatePolicy(policyV9(null)), { code: 'POLICY_BREAKER_KEYS_INVALID' }, '/9 needs breaker.network');
  assert.throws(() => validatePolicy(rawPolicy({ breaker: { ...base, network: NETWORK } })), { code: 'POLICY_BREAKER_KEYS_INVALID' }, '/7 has no network key');
  assert.throws(() => validatePolicy({ ...policyV8(), breaker: { ...base, network: NETWORK } }), { code: 'POLICY_BREAKER_KEYS_INVALID' }, '/8 has no network key');
  for (const bad of [{ trialDelayMs: 31 * MIN }, { trialDelayMs: 59_999 }, { trialDelayMs: 1.5 }, { earlyTrialProbes: 0 }, { earlyTrialProbes: 11 }, { releasesPerHeadPer24h: 0 }, { releasesPerHeadPer24h: 145 }])
    assert.throws(() => validatePolicy(policyV9({ ...NETWORK, ...bad })), { code: 'POLICY_BREAKER_NETWORK_INVALID' }, JSON.stringify(bad));
  assert.throws(() => validatePolicy(policyV9({ ...NETWORK, backoffMs: [MIN] })), { code: 'POLICY_BREAKER_NETWORK_KEYS_INVALID' });
  assert.throws(() => validatePolicy(policyV9({ trialDelayMs: MIN, earlyTrialProbes: 2 })), { code: 'POLICY_BREAKER_NETWORK_KEYS_INVALID' });
  assert.throws(() => validatePolicy(policyV9(NETWORK, { train: rawPolicy().train })), { code: 'POLICY_TRAIN_KEYS_INVALID' }, '/9 takes the /8 train settings');
  assert.equal(validatePolicy(policyV8()).contract, POLICY_CONTRACT_V8);
});

test('policy /9 example: the installed /8 values plus breaker.network (10 minutes, 2 probes, 36 network releases a day)', async () => {
  const read = async f => JSON.parse(await fs.readFile(new URL(`../config/${f}`, import.meta.url), 'utf8'));
  const v8 = await read('policy.v8-shadow.example.json'), v9 = await read('policy.v9.example.json');
  assert.equal(validatePolicy(v9).contract, POLICY_CONTRACT_V9);
  const { network, ...rest } = v9.breaker;
  assert.deepEqual(network, { trialDelayMs: 600000, earlyTrialProbes: 2, releasesPerHeadPer24h: 36 });
  assert.deepEqual({ ...v9, contract: v8.contract, breaker: rest }, v8, 'nothing else differs from /8');
});

// ---- what is the network ----

test('networkFailure: only the most specific fact says "the line"; a code alone never does', () => {
  assert.deepEqual([...NETWORK_GITHUB_REASONS], ['github_http_500', 'github_http_502', 'github_http_503', 'github_http_504', 'github_transport_unconfirmed']);
  assert.equal(networkFailure({ code: 'BUNDLE_UNAVAILABLE', bundleNetwork: true }), true);
  assert.equal(networkFailure({ code: 'BUNDLE_UNAVAILABLE' }), false, 'a refusal of the script itself (refs, main moved, timeout) is no network fault');
  for (const reason of NETWORK_GITHUB_REASONS) assert.equal(networkFailure({ code: 'GITHUB_TRANSIENT_UNAVAILABLE', outcome: { reason } }), true, reason);
  for (const reason of ['github_http_429', 'github_http_501', null]) assert.equal(networkFailure({ code: 'GITHUB_TRANSIENT_UNAVAILABLE', outcome: { reason } }), false, String(reason));
  assert.equal(networkFailure({ code: 'NATIVE_ADMISSION_UNAVAILABLE', outcome: { reason: 'native_claim_observation_unavailable' } }), true);
  assert.equal(networkFailure({ code: 'NATIVE_ADMISSION_UNAVAILABLE', outcome: { reason: 'full_admission_unavailable', diagnostic: { transport: true } } }), true);
  for (const diagnostic of [{ transport: false }, {}, null]) assert.equal(networkFailure({ code: 'NATIVE_ADMISSION_UNAVAILABLE', outcome: { reason: 'full_admission_unavailable', diagnostic } }), false, JSON.stringify(diagnostic));
  assert.equal(networkFailure({ code: 'ADMISSION_VERIFICATION_UNAVAILABLE' }), true);
  for (const code of ['BROKER_REQUEST_EXPIRED', 'BROKER_REQUEST_REFUSED', 'STAGE_PACKAGE_REFUSED', 'PUBLICATION_REVOKED']) assert.equal(networkFailure({ code, bundleNetwork: true }), false, code);
  // the transport flag of the Source's diagnostic survives the resident's stage-outcome parse
  const o = parseStageOutcome({ status: 'BLOCKED', reason: 'full_admission_unavailable', sideEffects: 0, mayHavePublished: false, diagnostic: { verdict: 'X', phase: 'native', transport: true } });
  assert.equal(o.diagnostic.transport, true);
});

// ---- the breaker ----

test('breaker /9: network faults open it for 10 minutes; the same outage failing every trial keeps that delay; another fault escalates', () => {
  const policy = validatePolicy(policyV9());
  let now = 0;
  const b = closedBreaker();
  for (const pr of [1, 2, 3]) breakerRecord(b, net(pr, pr === 3 ? 'GITHUB_TRANSIENT_UNAVAILABLE' : 'BUNDLE_UNAVAILABLE'), policy, now += MIN);
  assert.deepEqual([b.state, b.cause, b.level, (b.nextTrialAt - now) / MIN], ['open', NETWORK_CAUSE, 0, 10]);
  for (let i = 0; i < 5; i += 1) {
    now = b.nextTrialAt;
    assert.equal(breakerGate(b, now).trial, true);
    assert.equal(breakerRecord(b, net(9), policy, now), 'reopened');
    assert.deepEqual([b.cause, b.level, (b.nextTrialAt - now) / MIN], [NETWORK_CAUSE, 0, 10], `trial ${i}: one outage never stacks its delay`);
  }
  // a different fault in the trial (at the failing place): the next level of the policy's own delays, the cause is no longer network
  now = b.nextTrialAt; breakerGate(b, now);
  breakerRecord(b, fail(positionOf(0, 'bundle'), 9, 'BUNDLE_UNAVAILABLE'), policy, now);
  assert.deepEqual([b.cause, b.level, (b.nextTrialAt - now) / MIN], [null, 1, 60]);
  now = b.nextTrialAt; breakerGate(b, now);
  breakerRecord(b, net(9), policy, now);
  assert.deepEqual([b.cause, b.level, (b.nextTrialAt - now) / MIN], [null, 2, 120], 'the policy ladder goes on');
  now = b.nextTrialAt; breakerGate(b, now);
  assert.equal(breakerRecord(b, done(9), policy, now), 'closed');
  assert.deepEqual([b.state, b.cause, b.probeOks], ['closed', null, 0]);
});

test('breaker /9: a mixed opening and every /7 or /8 policy keep the old delays and escalation; a carried generation-9 state reads as before', () => {
  const policy = validatePolicy(policyV9());
  const mixed = closedBreaker();
  let now = 0;
  for (const [pr, network] of [[1, true], [2, false], [3, true]]) breakerRecord(mixed, fail(positionOf(0, 'bundle'), pr, 'BUNDLE_UNAVAILABLE', network), policy, now += MIN);
  assert.deepEqual([mixed.cause, (mixed.nextTrialAt - now) / MIN], [null, 30]);
  for (const p of [validatePolicy(rawPolicy()), validatePolicy(policyV8())]) {
    const b = closedBreaker(); now = 0;
    for (const pr of [1, 2, 3]) breakerRecord(b, net(pr), p, now += MIN);
    assert.deepEqual([b.cause, (b.nextTrialAt - now) / MIN], [null, 30], p.contract);
    now = b.nextTrialAt; breakerGate(b, now); breakerRecord(b, net(9), p, now);
    assert.deepEqual([b.level, (b.nextTrialAt - now) / MIN], [1, 60], p.contract);
    assert.equal(breakerProbe(b, true, p, now), null, 'no probe listening without breaker.network');
  }
  const old = { ...closedBreaker(), streakFails: [{ pos: 1, windowsOnly: true }, { pos: 1, windowsOnly: true }], streak: 2, streakPos: 1, streakPrs: [1, 2] };
  delete old.cause; delete old.probeOks;
  const b = breakerOf(old);
  breakerRecord(b, net(3), policy, 10 * MIN);
  assert.deepEqual([b.state, b.cause, (b.nextTrialAt - 10 * MIN) / MIN], ['open', null, 30], 'entries without the flag are never assumed to be network');
});

test('breaker /9: probes in a row make a network trial due now (also one already due); a failed probe starts again; the Owner release', () => {
  const policy = validatePolicy(policyV9({ ...NETWORK, trialDelayMs: 30 * MIN }));
  let now = 0;
  const b = closedBreaker();
  for (const pr of [1, 2, 3]) breakerRecord(b, net(pr), policy, now += MIN);
  const due = b.nextTrialAt;
  const gh = { github: true };
  assert.equal((due - now) / MIN, 30);
  assert.equal(breakerProbe(b, true, policy, now += MIN, gh), null);
  assert.equal(breakerProbe(b, false, policy, now += MIN, gh), null, 'the outage is still there');
  assert.equal(breakerProbe(b, true, policy, now += MIN), null, 'one in a row again (a Native answer)');
  assert.equal(breakerProbe(b, true, policy, now += MIN), null, 'two in a row, but none read GitHub: the line to GitHub may still be down');
  assert.equal(b.nextTrialAt, due);
  assert.equal(breakerProbe(b, true, policy, now += MIN, gh), 'early-trial', 'a GitHub read in the run');
  assert.deepEqual([b.nextTrialAt, b.probeOks, b.probeGithub], [now, 0, false]);
  // still open (no candidate ran the trial yet): two more good probes say so again (the executor then wakes the rows)
  assert.equal(breakerProbe(b, true, policy, now += MIN, gh), null);
  assert.equal(breakerProbe(b, true, policy, now += MIN), 'early-trial');
  assert.equal(b.nextTrialAt, now - 2 * MIN, 'a trial already due is not moved');
  assert.equal(breakerGate(b, now).trial, true);
  assert.equal(breakerProbe(b, true, policy, now), null, 'half-open listens to nothing');
  const other = closedBreaker(); now = 0;
  for (const pr of [1, 2, 3]) breakerRecord(other, fail(positionOf(1), pr, 'STAGE_PACKAGE_REFUSED'), policy, now += MIN);
  assert.equal(breakerProbe(other, true, policy, now += MIN), null); assert.equal(breakerProbe(other, true, policy, now += MIN), null);
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
  assert.deepEqual(attempt2Decision({ policy, subject: subjectOf(1), outcome: 'FAILED_CLEAN', failure: { code: 'ADMISSION_VERIFICATION_UNAVAILABLE', stageNumber: 1, phase: 'stage' } }), { eligible: true, reason: null });
  assert.equal(attempt2Decision({ policy, subject: { ...subjectOf(1), attempt: 2 }, outcome: 'FAILED_CLEAN', failure: { code: 'ADMISSION_VERIFICATION_UNAVAILABLE', stageNumber: 1 } }).eligible, false);
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

async function outage(t, { minutes, policy = policyV9(), bundleCode = BUNDLE_NETWORK_UNAVAILABLE } = {}) {
  const line = { down: true };
  const engine = fakeEngine({ train: mode => (line.down ? trainDown() : trainUp(mode)) });
  const f = await executorFixture(t, { engine, policy });
  f.companion.buildBundle = async () => { f.companion.calls.push(['bundle']); return line.down ? { ok: false, code: bundleCode } : { ok: true }; };
  for (const n of [1, 2, 3]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
  let opened = null;
  for (let m = 0; m < minutes; m += 1) {
    await f.exec.tick();
    if (!opened && f.queue.breaker?.state === 'open') opened = { at: f.clock(), nextTrialAt: f.queue.breaker.nextTrialAt, cause: f.queue.breaker.cause };
    f.advance(MIN);
  }
  return { f, line, engine, opened };
}
const keyOf = Object.fromEntries([1, 2, 3].map(n => [batchKey(subjectOf(n)), n]));

test('a 45-minute network outage: no head burned, no row stopped, no cap spent, every PR runs within 10 minutes of the network coming back', async t => {
  const { f, line, engine, opened } = await outage(t, { minutes: 45 });
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage' && c[1] !== 10), [], 'nothing ran past the bundle');
  assert.deepEqual([opened.cause, (opened.nextTrialAt - opened.at) / MIN], [NETWORK_CAUSE, 10], 'the network breaker waits 10 minutes');
  assert.equal(f.queue.breaker.level, 0, 'the same outage never stacked its delay');
  const u = await f.ledger.usage(0, { separateNetwork: true });
  for (const n of [1, 2, 3]) {
    assert.equal(await f.ledger.headBurned(headKey(subjectOf(n))), false, `PR ${n} head not burned`);
    assert.notEqual(f.queue.row(n).state, 'STOPPED', `PR ${n} not stopped`);
    assert.equal(u.releasesByHead.get(H(n)), undefined, `PR ${n}: nothing counted towards its release cap`);
    assert.ok(u.networkReleasesByHead.get(H(n)) >= 1 && u.networkReleasesByHead.get(H(n)) < NETWORK.releasesPerHeadPer24h, `PR ${n}: its network releases`);
  }
  assert.equal(u.evaluations, 0, 'an outage spends no evaluation');
  assert.ok((await receiptBodies(f, 'batch-unexecuted')).every(b => b.failureCode === 'BUNDLE_UNAVAILABLE' && b.network === true));
  line.down = false;
  const back = f.clock(), ran = {}, trace = [];
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

test('a bundle refusal that is not the network (a deterministic refusal) keeps the release cap and the 10/20/40 ladder: two releases and the row stops, as before', async t => {
  const f = await executorFixture(t, { policy: policyV9() });
  f.companion.buildBundle = async () => ({ ok: false, code: 'BUNDLE_UNAVAILABLE' });
  await f.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  for (let m = 0; m < 25; m += 1) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual([f.queue.row(1).state, f.queue.row(1).stopKind, f.queue.row(1).stopClass], ['STOPPED', 'release-cap', 'environment']);
  const u = await f.ledger.usage(0, { separateNetwork: true });
  assert.deepEqual([u.releasesByHead.get(H(1)), u.networkReleasesByHead.get(H(1))], [2, undefined]);
  assert.ok((await receiptBodies(f, 'batch-unexecuted')).every(b => b.network === false));
  // with three PRs the breaker opens, and never for "network"
  const { f: g } = await outage(t, { minutes: 30, bundleCode: 'BUNDLE_UNAVAILABLE' });
  assert.deepEqual([g.queue.breaker.state, g.queue.breaker.cause], ['open', null]);
  assert.ok([1, 2, 3].every(n => g.queue.row(n).levelKind === 'release'));
});

test('the network cap bounds a lasting outage per head (an environment stop); the outside answering again lifts it and the head runs', async t => {
  const { f, line } = await outage(t, { minutes: 60, policy: policyV9({ ...NETWORK, releasesPerHeadPer24h: 2 }) });
  const stopped = [1, 2, 3].filter(n => f.queue.row(n).state === 'STOPPED');
  assert.ok(stopped.length >= 1 && stopped.every(n => f.queue.row(n).stopClass === 'environment' && f.queue.row(n).reason === 'NETWORK_RELEASE_CAP_REACHED'),
    JSON.stringify(f.queue.data.rows.map(r => [r.pr, r.state, r.stopKind, r.stopClass, r.reason])));
  for (const n of [1, 2, 3]) assert.equal(await f.ledger.headBurned(headKey(subjectOf(n))), false);
  line.down = false;
  const ran = new Set();
  for (let m = 0; m < 40 && ran.size < 3; m += 1) { const r = await f.exec.tick(); if (r.state === 'COMPLETED') ran.add(keyOf[r.key]); f.advance(MIN); }
  assert.equal(ran.size, 3, 'two stage-10 runs that read main lift the stops; every head runs without a new commit');
  const early = await receiptBodies(f, 'breaker-early-trial');
  assert.ok(early.length >= 1 && early.some(b => b.lifted.length > 0), JSON.stringify(early));
});

test('the probes lift only the network cap\'s stops; a deterministic refusal stopped at the ordinary cap keeps waiting for the breaker to close', async t => {
  const f = await executorFixture(t, { policy: policyV9() });
  f.queue.offer({ repo: 'tdoljyj/cross-memory-system', pr: 1, headSha: H(1), baseSha: BASE, prUpdatedAt: null, seq: 1 }, f.clock(), { depth: 100, cooldownMs: 10 * MIN });
  f.queue.offer({ repo: 'tdoljyj/cross-memory-system', pr: 2, headSha: H(2), baseSha: BASE, prUpdatedAt: null, seq: 2 }, f.clock(), { depth: 100, cooldownMs: 10 * MIN });
  Object.assign(f.queue.row(1), { state: 'STOPPED', stopKind: 'release-cap', stopClass: 'environment', reason: 'NETWORK_RELEASE_CAP_REACHED' });
  Object.assign(f.queue.row(2), { state: 'STOPPED', stopKind: 'release-cap', stopClass: 'environment', reason: 'BUNDLE_UNAVAILABLE' });
  f.queue.breaker = { ...closedBreaker(), state: 'open', cause: NETWORK_CAUSE, openedAt: f.clock(), nextTrialAt: f.clock() + 30 * MIN, failingPos: 1, failingWindowsOnly: true };
  await f.exec.noteBreakerProbe(true, 'train-run');
  assert.equal(await f.exec.noteBreakerProbe(true, 'train-run'), 'early-trial');
  assert.deepEqual([f.queue.row(1).state, f.queue.row(2).state], ['BACKOFF', 'STOPPED']);
  const [r] = await receiptBodies(f, 'breaker-early-trial');
  assert.deepEqual(r.lifted, [1]);
  // the Owner's release lifts every environment stop, as a closing breaker does
  f.queue.breaker = { ...f.queue.breaker, state: 'open', nextTrialAt: f.clock() + 30 * MIN };
  await ownerFile(f, breakerReleaseRequest({ reason: 'fixed the line', by: SID }, f.clock));
  await f.exec.takeOwnerRequests();
  assert.equal(f.queue.row(2).state, 'BACKOFF');
});

test('the outage under the installed /8 policy behaves as generation 9 did (the policy decides): its ladder, its cap', async t => {
  const { f, opened } = await outage(t, { minutes: 40, policy: policyV8() });
  assert.deepEqual([opened.cause, (opened.nextTrialAt - opened.at) / MIN], [null, 30]);
  assert.equal((await f.ledger.usage(0)).networkReleasesByHead.size, 0);
});

test('stage-10 runs that read main from GitHub bring a network trial forward; a run that is down, or reads no main, does not; neither does an uncertain role probe', async t => {
  const policy = policyV9({ ...NETWORK, trialDelayMs: 30 * MIN });
  const { f, line, engine } = await outage(t, { minutes: 4, policy });
  assert.deepEqual([f.queue.breaker.state, f.queue.breaker.cause], ['open', NETWORK_CAUSE]);
  const due = f.queue.breaker.nextTrialAt;
  assert.deepEqual(await receiptBodies(f, 'breaker-early-trial'), [], 'the failing stage-10 runs while down are no probes that reached the outside');
  // a stage-10 summary without main (not on duty: nothing was read from GitHub) is no probe either
  line.down = false;
  const up = engine.runTrainStage;
  engine.runTrainStage = async mode => fakeEngine().runTrainStage(mode);
  for (let m = 0; m < 25; m += 1) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(await receiptBodies(f, 'breaker-early-trial'), [], 'mainSha null: not counted');
  // role probes: uncertain resets, held counts (noteBreakerProbe is what roleProbeMaintenance calls with the fact's result)
  engine.runTrainStage = up;
  f.queue.breaker = { ...f.queue.breaker, state: 'open', nextTrialAt: f.clock() + 30 * MIN, probeOks: 0 };
  assert.equal(await f.exec.noteBreakerProbe(true, 'role-probe'), null);
  assert.equal(await f.exec.noteBreakerProbe(false, 'role-probe'), null, 'uncertain');
  assert.equal(f.queue.breaker.probeOks, 0);
  let early = null;
  for (let m = 0; m < 25 && !early; m += 1) {
    await f.exec.tick();
    const r = await receiptBodies(f, 'breaker-early-trial');
    if (r.length) early = { at: f.clock(), body: r[0] };
    f.advance(MIN);
  }
  assert.ok(early, 'two stage-10 runs that read main brought the trial forward');
  assert.ok(Date.parse(early.body.nextTrialAt) < Date.parse(early.body.previousNextTrialAt), JSON.stringify(early.body));
  assert.equal(Date.parse(early.body.nextTrialAt), early.at, 'due at the probe');
  assert.deepEqual([early.body.probe, early.body.cause, early.body.level], ['train-run', NETWORK_CAUSE, 0]);
});

test('executor: role probes really run (roleProbeMaintenance): uncertain resets the run; held counts but a Native answer alone never ends a GitHub outage', async t => {
  const fact = { current: { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' } };
  const engine = fakeEngine();
  engine.runRoleProbe = async () => ({ ok: true, proof: WINDOWS_CLEAN, roleProbe: fact.current, outcome: { status: 'BLOCKED', reason: fact.current.code, sideEffects: 0, mayHavePublished: false } });
  const f = await executorFixture(t, { engine, policy: policyV9({ ...NETWORK, trialDelayMs: 30 * MIN }) });
  const open = () => { f.queue.breaker = { ...closedBreaker(), state: 'open', cause: NETWORK_CAUSE, openedAt: f.clock(), nextTrialAt: f.clock() + 30 * MIN, failingPos: 1, failingWindowsOnly: true }; };
  const probe = async () => { f.exec.roleProbe.markUrgent(); const r = await f.exec.roleProbeMaintenance(); assert.equal(r, null); f.advance(MIN); };
  open();
  await probe();
  await probe();
  assert.equal(f.queue.breaker.probeOks, 0, 'two uncertain answers are two failed probes');
  fact.current = { result: 'held', code: 'ROLE_PROBE_HELD' };
  await probe();
  await probe();
  assert.deepEqual([f.queue.breaker.probeOks, f.queue.breaker.probeGithub, f.queue.breaker.state], [2, false, 'open']);
  assert.ok(f.queue.breaker.nextTrialAt > f.clock(), 'not brought forward by Native answers alone');
  assert.deepEqual(await receiptBodies(f, 'breaker-early-trial'), []);
  assert.equal(engine.calls.filter(c => c[0] === 'stage').length, 0);
  // a GitHub read completes the run
  assert.equal(await f.exec.noteBreakerProbe(true, 'train-run'), 'early-trial');
});

test('executor: the role probe counts only a definite answer (held, not-held); stage 10 only a read of main (wiring)', async t => {
  const text = await fs.readFile(new URL('../src/executor.mjs', import.meta.url), 'utf8');
  assert.match(text, /await this\.noteBreakerProbe\(fact\?\.result === 'held' \|\| fact\?\.result === 'not-held', 'role-probe'\)/);
  assert.match(text, /await this\.noteBreakerProbe\(HEX40\.test\(summary\?\.mainSha \?\? ''\), 'train-run'\)/);
  assert.match(text, /breakerProbe\(b, ok, this\.policy, now, \{ github: probe === 'train-run' \}\)/);
});

test('the Owner releases an open breaker early (reason in the receipt, rows woken); a breaker that is not open refuses and keeps the reason too', async t => {
  const { f } = await outage(t, { minutes: 4, policy: rawPolicy() });
  assert.equal(f.queue.breaker.state, 'open');
  const before = f.queue.breaker.nextTrialAt;
  const req = breakerReleaseRequest({ reason: 'network back (checked by hand)', by: SID }, f.clock);
  assert.equal(req.contract, BREAKER_RELEASE_CONTRACT);
  await ownerFile(f, req);
  await f.exec.tick();
  const [rec] = (await receiptBodies(f, 'owner-request')).filter(b => b.kind === 'breaker-release');
  assert.ok(rec, 'recorded');
  assert.deepEqual([rec.reason, rec.by, rec.previousNextTrialAt, rec.level, rec.cause, Array.isArray(rec.lifted), Array.isArray(rec.woke)],
    ['network back (checked by hand)', SID, new Date(before).toISOString(), 0, null, true, true]);
  assert.ok(Date.parse(rec.nextTrialAt) < before);
  assert.equal(f.queue.breaker.state, 'open', 'the trial already ran in that tick and failed again: the release closed nothing');
  f.queue.breaker = { ...f.queue.breaker, state: 'closed' };
  await ownerFile(f, breakerReleaseRequest({ reason: 'again', by: SID }, () => f.clock() + 1));
  f.advance(1);
  await f.exec.tick();
  const refused = (await receiptBodies(f, 'owner-request-refused')).filter(b => b.failureCode === 'BREAKER_NOT_OPEN');
  assert.deepEqual(refused.map(b => [b.kind, b.reason, b.by]), [['breaker-release', 'again', SID]]);
  await ownerFile(f, { ...req, nonce: 'x', reason: '' });
  f.advance(1);
  await f.exec.tick();
  assert.ok((await receiptBodies(f, 'owner-request-refused')).some(b => b.failureCode === 'OWNER_REQUEST_REFUSED' && b.reason === undefined), 'an invalid request names no reason');
  assert.throws(() => breakerReleaseRequest({ reason: '', by: SID }), { code: 'BREAKER_RELEASE_REASON_REQUIRED' });
  assert.throws(() => breakerReleaseRequest({ reason: 'x'.repeat(201), by: SID }), { code: 'BREAKER_RELEASE_REASON_REQUIRED' });
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
  const statusFlush = async () => { const s = status.snapshot(); seen.push({ executor: s.executor.state, current: s.current?.pr ?? null, stage: s.current?.stage ?? null, breaker: s.breaker?.state ?? null }); };
  const line = { down: true };
  const f = await executorFixture(t, { status, statusFlush });
  f.companion.buildBundle = async () => (line.down ? { ok: false, code: BUNDLE_NETWORK_UNAVAILABLE } : { ok: true });
  for (const n of [1, 2, 3]) { await f.drop(triggerBytes({ pr: n, headSha: H(n) })); await f.exec.tick(); f.advance(MIN); }
  assert.equal(f.queue.breaker.state, 'open');
  assert.ok(seen.length >= 3 && seen.every(x => x.executor === 'RUNNING' && x.current !== null && x.stage === 0), JSON.stringify(seen));
  seen.length = 0;
  line.down = false;
  f.advance(30 * MIN);
  await f.exec.tick();
  assert.equal(seen[0].breaker, 'half-open', 'the trial is on the board before the batch runs');
  assert.equal(seen[1].executor, 'RUNNING');
  assert.notEqual(seen[1].current, null);
});

test('status timer: a flush asked while a write runs is written right after it, never dropped', async () => {
  const writes = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const board = { n: 0, snapshot() { return { n: this.n }; } };
  const file = { async write(s) { writes.push(s.n); if (writes.length === 1) await gate; } };
  const timer = startStatusTimer({ board, file, schedule: () => null, cancel: () => {} });
  const first = timer.flush();
  board.n = 1;
  assert.equal(await timer.flush(), false, 'busy: noted');
  release();
  assert.equal(await first, true);
  assert.deepEqual(writes, [0, 1], 'the newer board was written once more');
});

test('PR page: a trial time that has come or a half-open breaker never reads "熔断中"; an open network breaker says so', () => {
  const now = Date.parse('2026-11-05T03:20:10Z');
  const pull = { pr: 989, headSha: H(7), eligible: true };
  const base = { writtenAt: now, current: null, halt: null, paused: false, backfill: { complete: true }, intakePause: null, queue: null, recent: [],
    pending: [{ pr: 989, headSha: H(7), state: 'QUEUED', position: 1, deferred: null }] };
  const at = breaker => describe({ pull, status: { ...base, breaker }, now }).description;
  assert.match(at({ state: 'open', nextTrialAt: now + 5 * MIN, cause: 'network' }), /熔断中（网络故障），约 \d\d:\d\dZ? 试跑/);
  assert.match(at({ state: 'open', nextTrialAt: now + 5 * MIN, cause: null }), /执行器熔断中，约/);
  for (const b of [{ state: 'open', nextTrialAt: now - 2 * MIN, cause: 'network' }, { state: 'open', nextTrialAt: now, cause: null }, { state: 'half-open', nextTrialAt: null, cause: null }]) {
    const d = at(b);
    assert.doesNotMatch(d, /熔断中/, JSON.stringify(b));
    assert.match(d, /熔断后的试跑/);
    assert.doesNotMatch(d, /进行中/, 'half-open does not claim a trial is running');
  }
  // a row stopped at the network cap runs again by itself: no "push a new commit"
  const capped = describe({ pull, status: { ...base, breaker: null, pending: [{ pr: 989, headSha: H(7), state: 'STOPPED', position: null, deferred: 'NETWORK_RELEASE_CAP_REACHED', stopKind: 'release-cap' }] }, now });
  assert.deepEqual([capped.state, /自动重试/.test(capped.description), /推新提交/.test(capped.description.replace('不用推新提交', ''))], ['pending', true, false]);
  const board = new StatusBoard({ clock: () => now });
  board.update({ breaker: { state: 'open', openedAt: now, nextTrialAt: now + MIN, level: 0, failingPos: 1, recent: 3, streak: 3, cause: 'network' } });
  assert.equal(parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).breaker.cause, 'network');
  board.update({ breaker: { state: 'open', openedAt: now, nextTrialAt: now + MIN, level: 0, failingPos: 1, recent: 3, streak: 3, cause: 'other' } });
  assert.equal(parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).breaker.cause, null);
});

test('companion: the PR page is posted at once when the batch, its stage, the breaker, the intake pause or HALT/PAUSE changed; otherwise once a minute', () => {
  const s = (o = {}) => ({ current: null, breaker: { state: 'open', nextTrialAt: 1 }, halt: null, paused: false, intakePause: null, ...o });
  const sig = statusSignature(s());
  assert.equal(statusSignature(null), null);
  for (const o of [{ current: { pr: 1, headSha: H(1), attempt: 1, stage: 0 } }, { current: { pr: 1, headSha: H(1), attempt: 2, stage: 0 } }, { breaker: { state: 'half-open', nextTrialAt: null } },
    { breaker: { state: 'open', nextTrialAt: 2 } }, { halt: { code: 'X' } }, { paused: true }, { intakePause: { until: 5 } }]) assert.notEqual(statusSignature(s(o)), sig, JSON.stringify(o));
  assert.equal(statusSignature(s({ recent: [{ x: 1 }], writtenAt: 99 })), sig, 'what the page does not show does not count');
  // the signature reads only what status.mjs#parseStatus gives
  const parsed = parseStatus(Buffer.from(JSON.stringify(new StatusBoard({ clock: () => 0 }).snapshot())));
  assert.notEqual(statusSignature(parsed), null);
  const every = 60_000;
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - every - 1, lastSignature: sig, signature: sig, everyMs: every }), true, 'the minute');
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - 30_000, lastSignature: sig, signature: sig, everyMs: every }), false);
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - 30_000, lastSignature: sig, signature: 'other', everyMs: every }), true, 'a change: at once');
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - REPORT_MIN_GAP_MS, lastSignature: sig, signature: 'other', everyMs: every }), false, 'never twice within the gap');
  assert.equal(reportDue({ now: 1_000_000, lastReport: 1_000_000 - 30_000, lastSignature: sig, signature: null, everyMs: every }), false, 'an unreadable board waits for the minute');
});

test('companion-main reads the board at most every few seconds and posts on a change; the service passes the flush (wiring)', async () => {
  const text = await fs.readFile(new URL('../src/companion-main.mjs', import.meta.url), 'utf8');
  assert.match(text, /if \(Date\.now\(\) - lastReport > REPORT_MIN_GAP_MS && Date\.now\(\) - lastStatusRead > REPORT_MIN_GAP_MS\) \{\n\s+lastStatusRead = Date\.now\(\);/);
  assert.match(text, /if \(reportDue\(\{ now: Date\.now\(\), lastReport, lastSignature, signature, everyMs: REPORT_EVERY_MS \}\)\) \{/);
  const svc = await fs.readFile(new URL('../src/service-main.mjs', import.meta.url), 'utf8');
  assert.match(svc, /statusFlush: \(\) => statusTimer\.flush\(\),/);
});

test('executor: noteBreakerProbe resets on a failed probe, brings the trial forward on the second good one, persists it', async t => {
  const f = await executorFixture(t, { policy: policyV9({ ...NETWORK, trialDelayMs: 30 * MIN }) });
  f.queue.breaker = { ...closedBreaker(), state: 'open', cause: NETWORK_CAUSE, openedAt: f.clock(), nextTrialAt: f.clock() + 30 * MIN, failingPos: 1, failingWindowsOnly: true };
  assert.equal(await f.exec.noteBreakerProbe(true, 'role-probe'), null);
  assert.equal(await f.exec.noteBreakerProbe(false, 'train-run'), null);
  assert.equal(f.queue.breaker.probeOks, 0);
  assert.equal(await f.exec.noteBreakerProbe(true, 'role-probe'), null);
  assert.equal(await f.exec.noteBreakerProbe(true, 'train-run'), 'early-trial');
  assert.equal(f.queue.breaker.nextTrialAt, f.clock());
  const [r] = await receiptBodies(f, 'breaker-early-trial');
  assert.deepEqual([r.probe, r.lifted, r.woke], ['train-run', [], []]);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'queue', 'queue.json'), 'utf8'));
  assert.equal(saved.breaker.nextTrialAt, f.clock());
});
