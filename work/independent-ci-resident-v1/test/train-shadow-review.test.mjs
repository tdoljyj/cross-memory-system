// The shadow review tool (Task 67b41719, DESIGN §41.9 step 3): read-only, every condition 满足 / 不满足 / 数据不够, missing data never counts as met.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReceiptChain } from '../src/receipts.mjs';
import { loadReceipts, loadShadow, review, renderPage, run, MET, NOT_MET, INSUFFICIENT } from '../tools/train-shadow-review.mjs';
import { tempRoot } from './helpers.mjs';

const T0 = Date.parse('2026-11-05T00:00:00Z'), MIN = 60_000, H = 3_600_000;
const iso = t => new Date(t).toISOString();
const sha = c => c.repeat(40);
const KEY = n => String(n).padStart(2, '0').repeat(32);
const OK = { status: 'ok', text: '完整' };
const verdicts = r => Object.fromEntries(r.gates.map(g => [g.id, g.verdict]));
const asRecords = list => list.map(d => ({ runId: d.runId, at: d.at, facts: d.facts }));

// A receipt chain written by the real writer (so the chain verifies). script: [{ at, type, body }] in order.
async function chainOf(t, script) {
  const root = path.join(await tempRoot(t), 'receipts');
  let now = T0;
  const chain = await ReceiptChain.open(root, () => now);
  for (const s of script) { now = s.at; await chain.append(s.type, s.body); }
  return root;
}
const load = async (t, script) => (await loadReceipts(await chainOf(t, script))).receipts;
// One stage-10 run: intent (receipt `seq`) then train-run (receipt seq+1).
const stage10 = (at, seq, { wouldDo = 'NO_FRONT', frontPr = null, ok = true, failureCode = null, revokes = 1, main = sha('a') } = {}) => [
  { at: at - 1000, type: 'train-run-intent', body: { runId: `r${seq}` } },
  { at, type: 'train-run', body: { failureCode, frontPr, intentSeq: seq, mainSha: main, mode: 'shadow', ok, runId: `r${seq}`, wouldDo, wouldRevokeCount: revokes } }];
// stage-10 runs every 10 minutes from T0; fronts: { runIndex: [pr, wouldDo] }. The intent of run k is receipt 2k+1.
function runs(count, fronts = {}) {
  const out = [];
  for (let k = 0; k < count; k += 1) { const f = fronts[k]; out.push(...stage10(T0 + k * 10 * MIN, 2 * k + 1, f ? { wouldDo: f[1], frontPr: f[0] } : {})); }
  return out;
}
const frontsOf = (idx, wouldDo = 'OPEN_FRONT_BATCH') => Object.fromEntries(idx.map((k, i) => [k, [900 + i, wouldDo]]));
const batch = (at, key, pr, head, outcome, { attempt = 1, code = null } = {}) => [
  { at, type: 'batch-reserved', body: { key: KEY(key), headKey: KEY(key + 50), origin: 'queued', subject: { attempt, baseSha: sha('b'), headSha: head, pr, repo: 'o/r', sourceManifestSha256: 'c'.repeat(64) } } },
  outcome === 'COMPLETED' || outcome === 'FAILED_CLEAN' ? { at: at + MIN, type: 'batch-terminal', body: { key: KEY(key), outcome, ...(code ? { failureCode: code } : {}) } }
    : outcome?.startsWith('UNEXECUTED') ? { at: at + MIN, type: 'batch-unexecuted', body: { key: KEY(key), failureCode: outcome.split(':')[1], network: true, companionJobTree: null } } : null].filter(Boolean);

const facts = (at, over = {}) => ({ runId: `${String(at).padStart(16, '0')}-${'ab'.repeat(6)}`, at,
  facts: { contract: 'clued.independent-ci.train-facts/2', mode: 'shadow', at: iso(at), onDuty: true, mainSha: sha('a'), front: null, wouldDo: 'NO_FRONT', wouldRevoke: [], wouldRevokeCount: 0, nodes: null, ...over } });
const sweepFacts = (at, state, { startedAt = iso(T0), completedAt = null, reason = null, calls = 18, msRun = 25_000, incomplete = false } = {}) => facts(at, {
  sweep: { kind: 'full-segment', complete: !incomplete && state !== 'abandoned', revoked: 0, unconfirmed: 0, wouldRevokeCount: 0, calls, ms: msRun, proofWritten: false, fullSweep: { state, startedAt, completedAt, sinceOn: false, reason } } });
const node = (name, source, at) => ({ node: name, sourceManifestSha256: source, state: 'NORMAL', lastHeartbeatAt: iso(at) });

test('G1: 59 minutes is not enough, 60 is (NaN/offset-free); G2: 2 front PRs are not enough, 3 are', async t => {
  const span = async minutes => review({ receipts: await load(t, [...stage10(T0, 1), ...stage10(T0 + minutes * MIN, 3)]), since: T0, now: T0 + 10 * H, chain: OK });
  assert.equal(verdicts(await span(59)).G1, NOT_MET);
  assert.equal(verdicts(await span(60)).G1, MET);
  const r2 = review({ receipts: await load(t, runs(8, frontsOf([0, 2]))), since: T0, now: T0 + 10 * H, chain: OK });
  assert.deepEqual([verdicts(r2).G1, verdicts(r2).G2, r2.window.frontPrs], [MET, NOT_MET, [900, 901]]);
  const r3 = review({ receipts: await load(t, runs(8, frontsOf([0, 2, 4]))), since: T0, now: T0 + 10 * H, chain: OK });
  assert.equal(verdicts(r3).G2, MET);
});

test('G2 counts only PRs that went through the front: not-runnable, ambiguous and unbound holders are not fronts', async t => {
  for (const wouldDo of ['FRONT_NOT_RUNNABLE', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND']) {
    const r = review({ receipts: await load(t, runs(8, frontsOf([0, 1, 2], wouldDo))), since: T0, now: T0 + 10 * H, chain: OK });
    assert.deepEqual([verdicts(r).G2, r.window.frontPrs], [NOT_MET, []], wouldDo);
  }
  for (const wouldDo of ['FRONT_NEEDS_MAIN_MERGE', 'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']) {
    const r = review({ receipts: await load(t, runs(8, frontsOf([0, 1, 2], wouldDo))), since: T0, now: T0 + 10 * H, chain: OK });
    assert.equal(verdicts(r).G2, MET, wouldDo);
  }
});

test('G1/G2/G5: a standby node (NOT_ON_DUTY) observes nothing; nothing in the window is 数据不够; runs at --since and --now count, outside do not', async t => {
  const standby = Array.from({ length: 8 }, (_, k) => stage10(T0 + k * 10 * MIN, 2 * k + 1, { wouldDo: 'NOT_ON_DUTY', revokes: 0 })).flat();
  let r = review({ receipts: await load(t, standby), since: T0, now: T0 + 10 * H, chain: OK });
  assert.deepEqual([verdicts(r).G1, verdicts(r).G2], [INSUFFICIENT, INSUFFICIENT]);
  const receipts = await load(t, runs(8, frontsOf([1, 2, 3])));
  r = review({ receipts, since: T0 + 50 * H, now: T0 + 60 * H, chain: OK });
  assert.deepEqual([verdicts(r).G1, verdicts(r).G2, verdicts(r).G5], [INSUFFICIENT, INSUFFICIENT, INSUFFICIENT]);
  assert.equal(verdicts(review({ receipts, since: null, now: T0 + 60 * H, chain: OK })).G0, INSUFFICIENT);
  r = review({ receipts, since: T0 + 30 * MIN, now: T0 + 40 * MIN, chain: OK });          // exactly the runs at minute 30 and 40
  assert.deepEqual([r.window.runs, r.window.frontPrs], [2, [902]]);
  r = review({ receipts, since: T0 + 30 * MIN + 1, now: T0 + 40 * MIN - 1, chain: OK });
  assert.equal(r.window.runs, 0);
});

test('G1 uses the earliest and latest run times, not the order of the receipts (a clock step backwards)', async t => {
  const r = review({ receipts: await load(t, [...stage10(T0 + 2 * H, 1), ...stage10(T0, 3)]), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([verdicts(r).G1, r.window.observedMin], [MET, 120]);
});

test('the receipt chain: a broken chain is 不满足, an unverified one 数据不够, and neither lets the verdict through', async t => {
  const receipts = await load(t, runs(8, frontsOf([0, 1, 2])));
  assert.equal(verdicts(review({ receipts, since: T0, now: T0 + 5 * H, chain: { status: 'broken', text: '核验失败' } })).GC, NOT_MET);
  assert.equal(verdicts(review({ receipts, since: T0, now: T0 + 5 * H })).GC, INSUFFICIENT);
  assert.equal(verdicts(review({ receipts, since: T0, now: T0 + 5 * H, chain: OK })).GC, MET);
  const torn = review({ receipts, since: T0, now: T0 + 5 * H, chain: OK, unreadable: { receipts: 1, shadow: 0 } });
  assert.equal(verdicts(torn).GC, NOT_MET);
  assert.match(renderPage(torn), /警告：有 1 个回执、0 个影子记录读不出/);
});

test('front first-run failure: PASS, FAIL, NOT_RUN (never ran / superseded) and PENDING are told apart; attempt 2 is never a first run; heads per PR', async t => {
  const script = [
    ...runs(8, { 4: [10, 'OPEN_FRONT_BATCH'], 5: [11, 'OPEN_FRONT_BATCH'], 6: [12, 'OPEN_FRONT_BATCH'] }),
    ...batch(T0 + 1 * MIN, 1, 10, sha('1'), 'COMPLETED'),
    ...batch(T0 + 2 * MIN, 2, 11, sha('2'), 'FAILED_CLEAN'),
    ...batch(T0 + 3 * MIN, 3, 11, sha('3'), 'COMPLETED'),
    ...batch(T0 + 4 * MIN, 4, 12, sha('4'), 'UNEXECUTED:BUNDLE_UNAVAILABLE'),
    ...batch(T0 + 5 * MIN, 5, 99, sha('5'), 'FAILED_CLEAN'),                                   // not a front PR: heads per PR only
    ...batch(T0 + 6 * MIN, 6, 10, sha('1'), 'COMPLETED', { attempt: 2 }),                      // attempt 2 of the same head: not a first run
    ...batch(T0 + 7 * MIN, 7, 12, sha('6'), null),                                              // no outcome yet
    ...batch(T0 + 8 * MIN, 8, 12, sha('7'), 'FAILED_CLEAN', { code: 'SUPERSEDED_AT_SAFE_POINT' })].sort((a, b) => a.at - b.at);
  const r = review({ receipts: await load(t, script), since: T0, now: T0 + 5 * H, chain: OK });
  const f = r.stats.firstRunFailure;
  assert.deepEqual([f.heads, f.decided, f.failed, f.notRun, f.rate], [6, 3, 1, 2, 0.333]);
  assert.deepEqual(r.stats.headsPerPr, { mean: 1.75, max: 3 });
  assert.deepEqual(r.stats.headsPerFrontPr, { mean: 2, max: 3 });
  assert.match(renderPage(r), /1\/3 = 33\.3%.*没跑起来或被取代 2 个不计，未出结果 1 个/);
});

test('first run: attempt 1 reserved before --since is still the head\'s first run; a head pushed after the PR left the front is not counted', async t => {
  const script = [...runs(3, { 1: [10, 'OPEN_FRONT_BATCH'] }),
    ...batch(T0 - 2 * H, 1, 10, sha('1'), 'FAILED_CLEAN'),                                      // attempt 1, before --since
    ...batch(T0 + 5 * MIN, 2, 10, sha('1'), 'COMPLETED', { attempt: 2 }),                      // its attempt 2 inside the window
    ...batch(T0 + 25 * MIN, 3, 10, sha('2'), 'FAILED_CLEAN')].sort((a, b) => a.at - b.at);     // a later head: after the PR was last the front (minute 10)
  const r = review({ receipts: await load(t, script), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([r.stats.firstRunFailure.heads, r.stats.firstRunFailure.decided], [0, 0], 'the before-since attempt 1 is outside the window; attempt 2 and the late head are no first runs');
  const wide = review({ receipts: await load(t, script), since: T0 - 3 * H, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([wide.stats.firstRunFailure.heads, wide.stats.firstRunFailure.failed], [1, 1]);
});

test('front green to merge: the last unbroken green run starts the gap; no merge times is 数据不够, an unmerged PR has no sample', async t => {
  const script = runs(8, { 1: [10, 'FRONT_GREEN_WAIT_MERGE'], 2: [10, 'OPEN_FRONT_BATCH'], 3: [10, 'FRONT_GREEN_WAIT_MERGE'], 4: [10, 'FRONT_GREEN_WAIT_MERGE'], 5: [11, 'FRONT_GREEN_WAIT_MERGE'] });
  const receipts = await load(t, script);
  let r = review({ receipts, since: T0, now: T0 + 5 * H, chain: OK });
  assert.equal(r.stats.greenToMerge.samples, null);
  assert.deepEqual(r.stats.greenToMerge.greenSeen, [10, 11]);
  r = review({ receipts, since: T0, now: T0 + 5 * H, chain: OK, pulls: { 10: { mergedAt: iso(T0 + 30 * MIN + 14 * MIN) }, 12: { mergedAt: iso(T0) } } });
  assert.deepEqual(r.stats.greenToMerge.samples.map(s => [s.pr, s.gapMin]), [[10, 14]], 'PR 10 re-greened at minute 30, not 10');
  assert.equal(r.stats.greenToMerge.unmerged, 1);
  assert.deepEqual(review({ receipts, since: T0, now: T0 + 5 * H, chain: OK, pulls: { 10: { mergedAt: 'not a time' } } }).stats.greenToMerge.samples, []);
});

test('G4 (Owner reading): >= 2 completions in the window, every abandonment explained by the clock (>= 6 h), not by an error', async t => {
  const receipts = await load(t, runs(8));
  const sw = (startH, endMin, { state = 'complete', reason = null } = {}) => [sweepFacts(T0 + startH * H + MIN, 'running', { startedAt: iso(T0 + startH * H) }),
    sweepFacts(T0 + startH * H + endMin * MIN, state, { startedAt: iso(T0 + startH * H), completedAt: state === 'complete' ? iso(T0 + startH * H + endMin * MIN) : null, reason })];
  const g4 = shadow => { const r = review({ receipts, shadow: asRecords(shadow), since: T0, now: T0 + 40 * H, chain: OK }); return [verdicts(r).G4, r]; };
  // two completions with an expired sweep between them: replaced after 6 h 1 min (the resident expires a sweep only when it is older than the cap) -> explained
  let [v, r] = g4([...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), ...sw(7 + 1 / 60, 20), ...sw(14, 20)]);
  assert.deepEqual([v, r.sweep.completed, r.sweep.abandoned, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained], [MET, 3, 1, 1, []]);
  assert.match(r.gates.find(g => g.id === 'G4').evidence, /完成 3 次；放弃.被替换 1 次，其中 1 次是跑满上限（节奏慢）、0 次记录里看不出是节奏慢/);
  // replaced after exactly 6 h or after 5 h 59 min: it did not run out the clock -> not explained
  for (const startH of [7, 6.99]) {
    [v, r] = g4([...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), ...sw(startH, 20), ...sw(14, 20)]);
    assert.deepEqual([startH, v, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.length], [startH, NOT_MET, 0, 1]);
  }
  // a sweep stuck on errors (its runs report an unfinished sweep) is not slow, even when it is replaced after 6 h
  const stuck = at => sweepFacts(at, 'running', { startedAt: iso(T0 + H), incomplete: true });
  [v, r] = g4([...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), stuck(T0 + 2 * H), ...sw(8, 20), ...sw(14, 20)]);
  assert.deepEqual([v, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.map(x => x.stalled)], [NOT_MET, 0, [true]]);
  assert.match(r.gates.find(g => g.id === 'G4').evidence, /REPLACED_WITHOUT_FINISHING（期间有运行没扫完/);
  // ... while a failed run elsewhere (another sweep, or the replacement itself) does not taint the slow one
  [v, r] = g4([...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), ...sw(8, 20), sweepFacts(T0 + 8 * H + 30 * MIN, 'running', { startedAt: iso(T0 + 8 * H), incomplete: true }), ...sw(14.5, 20)]);
  assert.deepEqual([v, r.sweep.abandonedExpired], [MET, 1]);
  // a recorded TRAIN_FULL_SWEEP_EXPIRED abandonment is explained by itself; a recorded failed segment or any other reason is not
  const expired = (startH, ageMin) => [sweepFacts(T0 + startH * H + MIN, 'running', { startedAt: iso(T0 + startH * H) }), sweepFacts(T0 + startH * H + ageMin * MIN, 'abandoned', { startedAt: iso(T0 + startH * H), reason: 'TRAIN_FULL_SWEEP_EXPIRED' })];
  [v, r] = g4([...sw(0, 20), ...sw(7, 20), ...expired(14, 361)]);
  assert.deepEqual([v, r.sweep.completed, r.sweep.abandonedExpired], [MET, 2, 1]);
  [v, r] = g4([...sw(0, 20), ...sw(7, 20), ...expired(14, 360)]);        // exactly the cap: not older than it
  assert.deepEqual([v, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.length], [NOT_MET, 0, 1]);
  [v, r] = g4([...sw(0, 20), ...sw(7, 20), ...expired(14, 60)]);         // a recorded expiry one hour in is not believed
  assert.deepEqual([v, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.length], [NOT_MET, 0, 1]);
  for (const reason of ['TRAIN_SWEEP_INCOMPLETE', 'TRAIN_PULL_OVER_250_COMMITS', 'TRAIN_FULL_SWEEP_BEFORE_ON', null]) {
    [v, r] = g4([...sw(0, 20), ...sw(7, 20), ...sw(14, 5, { state: 'abandoned', reason })]);
    assert.deepEqual([reason, v, r.sweep.abandonedNotExplained.length], [reason, NOT_MET, 1]);
  }
  // a recorded failed segment followed by a sweep 6+ hours later is still an error, not the clock
  [v, r] = g4([...sw(0, 20), ...sw(7, 20), ...sw(14, 5, { state: 'abandoned', reason: 'TRAIN_SWEEP_INCOMPLETE' }), ...sw(22, 20)]);
  assert.deepEqual([v, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.map(x => x.reason)], [NOT_MET, 0, ['TRAIN_SWEEP_INCOMPLETE']]);
  // one explained and one unexplained abandonment: still not met, and the evidence names the unexplained one only
  [v, r] = g4([...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), ...sw(8, 20), ...sw(15, 5, { state: 'abandoned', reason: 'TRAIN_SWEEP_INCOMPLETE' }), ...sw(30, 20)]);
  assert.deepEqual([v, r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.map(x => x.reason)], [NOT_MET, 1, ['TRAIN_SWEEP_INCOMPLETE']]);
  assert.match(r.gates.find(g => g.id === 'G4').evidence, new RegExp(`1 次记录里看不出是节奏慢：${iso(T0 + 15 * H)} TRAIN_SWEEP_INCOMPLETE`));
  // fewer than two completions is still short of data, however the abandonments are explained; no shadow records at all too
  [v] = g4([...sw(0, 20), ...sw(7, 5, { state: 'abandoned', reason: 'TRAIN_FULL_SWEEP_EXPIRED' })]);
  assert.equal(v, INSUFFICIENT);
  [v, r] = g4([]);
  assert.equal(v, INSUFFICIENT);
  // a run that does not say whether its sweep completed is not proof that the sweep was merely slow
  const silentComplete = at => { const rec = sweepFacts(at, 'running', { startedAt: iso(T0 + H) }); delete rec.facts.sweep.complete; return rec; };
  [v, r] = g4([...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), silentComplete(T0 + 2 * H), ...sw(8, 20), ...sw(14, 20)]);
  assert.deepEqual([v, r.sweep.abandonedNotExplained.map(x => x.stalled)], [NOT_MET, [true]]);
  // a recorded expiry is judged by the time of the record, not by a completedAt it carries
  const lying = sweepFacts(T0 + H + 30 * MIN, 'abandoned', { startedAt: iso(T0 + H), reason: 'TRAIN_FULL_SWEEP_EXPIRED', completedAt: iso(T0 + 8 * H) });
  [v, r] = g4([...sw(0, 20), ...sw(7, 20), sweepFacts(T0 + H + MIN, 'running', { startedAt: iso(T0 + H) }), lying]);
  assert.deepEqual([r.sweep.abandonedExpired, r.sweep.abandonedNotExplained.length], [0, 1]);
  // the last sweep still running past the cap at --now: nothing abandoned it, so the sweeping stopped -> not explained (fresh one is fine)
  [v, r] = g4([...sw(0, 20), ...sw(7, 20), sweepFacts(T0 + 14 * H, 'running', { startedAt: iso(T0 + 14 * H) })]);
  assert.deepEqual([v, r.sweep.abandonedNotExplained.map(x => x.reason)], [NOT_MET, ['RUNNING_PAST_CAP']]);
  for (const [lateMin, verdict] of [[6 * 60 + 30, MET], [6 * 60 + 31, NOT_MET]]) {    // the cap plus 30 minutes of grace
    const edge = review({ receipts, shadow: asRecords([...sw(0, 20), ...sw(7, 20), sweepFacts(T0 + 14 * H, 'running', { startedAt: iso(T0 + 14 * H) })]), since: T0, now: T0 + 14 * H + lateMin * MIN, chain: OK });
    assert.deepEqual([lateMin, verdicts(edge).G4], [lateMin, verdict]);
  }
  const fresh = review({ receipts, shadow: asRecords([...sw(0, 20), ...sw(7, 20), sweepFacts(T0 + 14 * H, 'running', { startedAt: iso(T0 + 14 * H) })]), since: T0, now: T0 + 14 * H + 5 * H, chain: OK });
  assert.deepEqual([verdicts(fresh).G4, fresh.sweep.running], [MET, 1]);
  // a replaced sweep with no start time cannot be tied to the clock
  [v, r] = g4([...sw(0, 20), ...sw(14, 20), sweepFacts(T0 + 30 * H, 'running', { startedAt: null }), ...sw(31, 20)]);
  assert.deepEqual([v, r.sweep.abandonedNotExplained.length], [NOT_MET, 1]);
});

test('--accept-abandoned: the Owner ruling on one named abandonment; it never widens beyond that sweep', async t => {
  const receipts = await load(t, runs(8));
  const sw = (startH, endMin, { state = 'complete', reason = null } = {}) => [sweepFacts(T0 + startH * H + MIN, 'running', { startedAt: iso(T0 + startH * H) }),
    sweepFacts(T0 + startH * H + endMin * MIN, state, { startedAt: iso(T0 + startH * H), completedAt: state === 'complete' ? iso(T0 + startH * H + endMin * MIN) : null, reason })];
  const bad = [...sw(0, 20), ...sw(7, 20), ...sw(14, 5, { state: 'abandoned', reason: 'TRAIN_SWEEP_INCOMPLETE' }), ...sw(22, 20)];
  const at = h => T0 + h * H;
  const g = accept => review({ receipts, shadow: asRecords(bad), since: T0, now: T0 + 40 * H, chain: OK, acceptAbandoned: accept });
  assert.equal(verdicts(g([])).G4, NOT_MET);
  let r = g([at(14)]);
  assert.deepEqual([verdicts(r).G4, r.sweep.abandonedAccepted, r.sweep.abandonedNotExplained, r.sweep.acceptedUnmatched], [MET, [{ startedAt: iso(T0 + 14 * H), reason: 'TRAIN_SWEEP_INCOMPLETE' }], [], []]);
  assert.match(r.gates.find(g => g.id === 'G4').evidence, /1 次按 Owner 2026-11-06 裁定可接受（.*TRAIN_SWEEP_INCOMPLETE）、0 次记录里看不出是节奏慢/);
  assert.match(renderPage(r), /Owner 2026-11-06 裁定可接受的全量扫描放弃：.*TRAIN_SWEEP_INCOMPLETE/);
  // a start time that matches no abandonment changes nothing and is said so; so does a time that names a completed sweep
  r = g([at(15), at(7)]);
  assert.deepEqual([verdicts(r).G4, r.sweep.acceptedUnmatched.length, r.sweep.abandonedAccepted.length], [NOT_MET, 2, 0]);
  assert.match(r.gates.find(g => g.id === 'G4').evidence, /在窗口内没有对应的、需要裁定的放弃记录.*没有生效/);
  assert.match(renderPage(r), /没有对应记录、未生效的起点/);
  // the ruling does not cover another unexplained abandonment, and does not turn a missing completion into a pass
  const two = [...sw(0, 20), ...sw(7, 20), ...sw(14, 5, { state: 'abandoned', reason: 'TRAIN_SWEEP_INCOMPLETE' }), ...sw(16, 5, { state: 'abandoned', reason: 'TRAIN_SWEEP_INCOMPLETE' })];
  r = review({ receipts, shadow: asRecords(two), since: T0, now: T0 + 40 * H, chain: OK, acceptAbandoned: [at(14)] });
  assert.deepEqual([verdicts(r).G4, r.sweep.abandonedNotExplained.map(x => x.startedAt)], [NOT_MET, [iso(T0 + 16 * H)]]);
  r = review({ receipts, shadow: asRecords([...sw(0, 20), ...sw(14, 5, { state: 'abandoned', reason: 'TRAIN_SWEEP_INCOMPLETE' })]), since: T0, now: T0 + 40 * H, chain: OK, acceptAbandoned: [at(14)] });
  assert.equal(verdicts(r).G4, INSUFFICIENT);
  // the ruling covers a RECORDED abandonment only: naming a sweep the tool merely inferred as replaced (stuck or not), or one still running, changes nothing
  const stuck = [...sw(0, 20), sweepFacts(T0 + H, 'running', { startedAt: iso(T0 + H) }), sweepFacts(T0 + 2 * H, 'running', { startedAt: iso(T0 + H), incomplete: true }), ...sw(8, 20), ...sw(14, 20)];
  r = review({ receipts, shadow: asRecords(stuck), since: T0, now: T0 + 40 * H, chain: OK, acceptAbandoned: [at(1)] });
  assert.deepEqual([verdicts(r).G4, r.sweep.abandonedAccepted.length, r.sweep.acceptedUnmatched], [NOT_MET, 0, [iso(T0 + H)]]);
  const past = review({ receipts, shadow: asRecords([...sw(0, 20), ...sw(7, 20), sweepFacts(T0 + 14 * H, 'running', { startedAt: iso(T0 + 14 * H) })]), since: T0, now: T0 + 40 * H, chain: OK, acceptAbandoned: [at(14)] });
  assert.deepEqual([verdicts(past).G4, past.sweep.abandonedAccepted.length], [NOT_MET, 0]);
  // junk in the list (null, NaN) matches nothing, in particular not a sweep without a start time
  const noStart = review({ receipts, shadow: asRecords([...sw(0, 20), ...sw(7, 20), sweepFacts(T0 + 14 * H, 'abandoned', { startedAt: null, reason: 'X' })]), since: T0, now: T0 + 40 * H, chain: OK, acceptAbandoned: [null, NaN, 'x'] });
  assert.deepEqual([verdicts(noStart).G4, noStart.sweep.abandonedAccepted.length], [NOT_MET, 0]);
});

test('--accept-abandoned on the command line: repeatable, strict ISO, shown on the page', async t => {
  const dir = await chainOf(t, runs(2));
  const shadowDir = await tempRoot(t);
  const rec = (startH, endMin, state, reason) => { const f = sweepFacts(T0 + startH * H + endMin * MIN, state, { startedAt: iso(T0 + startH * H), reason, completedAt: state === 'complete' ? iso(T0 + startH * H + endMin * MIN) : null }); return f; };
  for (const f of [rec(0, 20, 'complete'), rec(7, 20, 'complete'), rec(14, 5, 'abandoned', 'TRAIN_SWEEP_INCOMPLETE')]) {
    await fs.writeFile(path.join(shadowDir, `${String(f.at).padStart(13, '0')}-${'a'.repeat(16)}-${'b'.repeat(12)}.json`), JSON.stringify({ runId: f.runId, facts: f.facts }));
  }
  const base = ['--receipts', dir, '--shadow', shadowDir, '--since', iso(T0), '--now', iso(T0 + 40 * H), '--json'];
  const g4 = out => JSON.parse(out).gates.find(g => g.id === 'G4').verdict;
  assert.equal(g4(await run(base)), NOT_MET);
  const withRuling = await run([...base, '--accept-abandoned', iso(T0 + 14 * H), '--accept-abandoned', iso(T0 + 3 * H)]);
  assert.deepEqual([g4(withRuling), JSON.parse(withRuling).sweep.abandonedAccepted.length, JSON.parse(withRuling).sweep.acceptedUnmatched], [MET, 1, [iso(T0 + 3 * H)]]);
  const page = await run(base.filter(a => a !== '--json').concat(['--accept-abandoned', iso(T0 + 14 * H)]));
  assert.match(page, /Owner 2026-11-06 裁定可接受的全量扫描放弃：/);
  const out = page;
  await assert.rejects(run(['--receipts', dir, '--accept-abandoned', 'tomorrow']), e => e.code === 'TIME_INVALID');
  await assert.rejects(run(['--receipts', dir, '--accept-abandoned']), e => e.code === 'ARGUMENT_VALUE_MISSING');
});

test('queue residence is windowed by --since/--now, and an unusable marker is counted, not averaged', () => {
  const markers = [{ leftQueuedAt: iso(T0 + 10 * MIN), headLeftAt: iso(T0 + 20 * MIN) }, { leftQueuedAt: iso(T0 + 30 * MIN), headLeftAt: iso(T0 + 90 * MIN) },
    { leftQueuedAt: iso(T0 - 5 * H), headLeftAt: iso(T0 - 4 * H) }, { leftQueuedAt: iso(T0 + 40 * MIN), headLeftAt: iso(T0 + 30 * MIN) }, null, { headLeftAt: 5 }];
  const r = review({ receipts: [], markers, since: T0, now: T0 + 2 * H });
  assert.deepEqual([r.stats.queueResidence.samples, r.stats.queueResidence.dropped, r.stats.queueResidence.medianMin, r.stats.queueResidence.maxMin], [2, 3, 35, 60]);
});

test('full sweeps: segments of one sweep are one sweep; a sweep replaced without finishing is abandoned even with no abandoned record', async t => {
  const receipts = await load(t, runs(8));
  const s1 = iso(T0 + MIN), s2 = iso(T0 + 3 * H);
  const done = [sweepFacts(T0 + 2 * MIN, 'running', { startedAt: s1, calls: 40, msRun: 30_000 }), sweepFacts(T0 + 12 * MIN, 'complete', { startedAt: s1, completedAt: iso(T0 + 12 * MIN), calls: 10, msRun: 5_000 }),
    sweepFacts(T0 + 3 * H + MIN, 'running', { startedAt: s2 }), sweepFacts(T0 + 3 * H + 11 * MIN, 'complete', { startedAt: s2, completedAt: iso(T0 + 3 * H + 11 * MIN) })];
  let r = review({ receipts, shadow: asRecords(done), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([r.sweep.completed, r.sweep.abandoned, verdicts(r).G3, verdicts(r).G4], [2, 0, MET, MET]);
  assert.deepEqual([r.sweep.sweeps[0].segments, r.sweep.sweeps[0].calls, r.sweep.sweeps[0].wallMin, r.sweep.sweeps[0].activeMin], [2, 50, 11, 0.6]);
  const one = review({ receipts, shadow: asRecords(done.slice(0, 2)), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([verdicts(one).G3, verdicts(one).G4], [MET, INSUFFICIENT]);
  const recorded = [...done, sweepFacts(T0 + 4 * H, 'abandoned', { startedAt: iso(T0 + 3.5 * H), reason: 'TRAIN_SWEEP_INCOMPLETE' })];
  r = review({ receipts, shadow: asRecords(recorded), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([r.sweep.abandoned, r.sweep.abandonedReasons, verdicts(r).G4], [1, { TRAIN_SWEEP_INCOMPLETE: 1 }, NOT_MET]);
  assert.deepEqual([r.sweep.abandonedExpired, r.sweep.abandonedNotExplained], [0, [{ startedAt: iso(T0 + 3.5 * H), reason: 'TRAIN_SWEEP_INCOMPLETE', stalled: false }]]);
  assert.match(r.gates.find(g => g.id === 'G4').evidence, /1 次记录里看不出是节奏慢：.*TRAIN_SWEEP_INCOMPLETE/);
  // the resident abandons an expired shadow sweep and starts the next in the same run: the first one just stops showing up
  const silent = [sweepFacts(T0 + 2 * MIN, 'running', { startedAt: s1 }), sweepFacts(T0 + 7 * H, 'running', { startedAt: iso(T0 + 7 * H) }), sweepFacts(T0 + 7 * H + 20 * MIN, 'complete', { startedAt: iso(T0 + 7 * H), completedAt: iso(T0 + 7 * H + 20 * MIN) }),
    sweepFacts(T0 + 14 * H, 'running', { startedAt: iso(T0 + 14 * H) }), sweepFacts(T0 + 14 * H + 20 * MIN, 'complete', { startedAt: iso(T0 + 14 * H), completedAt: iso(T0 + 14 * H + 20 * MIN) })];
  r = review({ receipts, shadow: asRecords(silent), since: T0, now: T0 + 20 * H, chain: OK });
  assert.deepEqual([r.sweep.completed, r.sweep.abandoned, r.sweep.abandonedReasons, r.sweep.abandonedExpired, verdicts(r).G4], [2, 1, { REPLACED_WITHOUT_FINISHING: 1 }, 1, MET]);
  const none = review({ receipts, shadow: asRecords([sweepFacts(T0 + 2 * MIN, 'abandoned', { reason: 'TRAIN_SWEEP_INCOMPLETE' })]), since: T0, now: T0 + 5 * H, chain: OK });
  assert.equal(verdicts(none).G3, NOT_MET);
});

test('sweeps and records after --now or from a non-shadow mode do not count', async t => {
  const receipts = await load(t, runs(8));
  const late = sweepFacts(T0 + 9 * H, 'complete', { startedAt: iso(T0 + 8 * H), completedAt: iso(T0 + 9 * H) });
  const onMode = sweepFacts(T0 + 20 * MIN, 'complete', { startedAt: iso(T0 + 10 * MIN), completedAt: iso(T0 + 20 * MIN) });
  onMode.facts.mode = 'on';
  const r = review({ receipts, shadow: asRecords([late, onMode]), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([r.sweep.completed, r.sweep.fromShadow, verdicts(r).G3], [0, false, INSUFFICIENT]);
});

test('shadow records without sweep data (facts /1) leave G3 at 数据不够; the status file counts only when there are no sweep records', async t => {
  const receipts = await load(t, runs(8));
  const plainRecords = asRecords([facts(T0 + 10 * MIN), facts(T0 + 20 * MIN)]);
  const status = { train: { enabled: 'shadow', last: { mode: 'shadow', sweep: { fullSweep: { state: 'running', startedAt: iso(T0) } } }, sweep: { fullCompletedAt: iso(T0 + H) } } };
  let r = review({ receipts, shadow: plainRecords, since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([verdicts(r).G3, verdicts(r).G4], [INSUFFICIENT, INSUFFICIENT]);
  r = review({ receipts, status, since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([verdicts(r).G3, verdicts(r).G4, verdicts(r).G7, r.sweep.statusFile.lastCompletedAt], [MET, INSUFFICIENT, INSUFFICIENT, iso(T0 + H)]);
  r = review({ receipts, status, since: T0 + 2 * H, now: T0 + 5 * H, chain: OK });   // the completion is before the window
  assert.equal(verdicts(r).G3, INSUFFICIENT);
  assert.equal(r.canEnterTrainOn, false);
});

test('would-revoke: per-run counts from the receipts, the distinct greens from the shadow records (capped lists are flagged)', async t => {
  const receipts = await load(t, [...stage10(T0 + 10 * MIN, 1, { revokes: 0 }), ...stage10(T0 + 20 * MIN, 3, { revokes: 2 }), ...stage10(T0 + 30 * MIN, 5, { revokes: 2 })]);
  const w = [{ headSha: sha('1'), checkRunId: 7, pr: 5, phase: 'posted' }, { headSha: sha('2'), checkRunId: 9 }];
  const shadow = asRecords([facts(T0 + 20 * MIN, { wouldRevoke: w, wouldRevokeCount: 2 }), facts(T0 + 30 * MIN, { wouldRevoke: w, wouldRevokeCount: 2 })]);
  let r = review({ receipts, shadow, since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual([r.stats.wouldRevoke.runs, r.stats.wouldRevoke.max, r.stats.wouldRevoke.latest, r.stats.wouldRevoke.nonZeroRuns], [3, 2, 2, 2]);
  assert.deepEqual([r.stats.wouldRevoke.uniqueGreens.map(g => g.checkRunId), r.stats.wouldRevoke.uniqueGreensCapped], [[7, 9], false]);
  r = review({ receipts, shadow: asRecords([facts(T0 + 20 * MIN, { wouldRevoke: w, wouldRevokeCount: 30 })]), since: T0, now: T0 + 5 * H, chain: OK });
  assert.equal(r.stats.wouldRevoke.uniqueGreensCapped, true);
});

test('GitHub recompute delay: from main moving under a bound front to its test merge being [main, head] again', () => {
  const front = (ok, over = {}) => ({ claimId: 'x', pr: 7, headSha: sha('7'), green: false, testMergeParentsOk: ok, ...over });
  const at = k => T0 + k * 10 * MIN;
  const seq = [facts(at(0), { front: front(true) }), facts(at(1), { front: front(true) }),
    facts(at(2), { mainSha: sha('d'), front: front(false) }), facts(at(3), { mainSha: sha('d'), front: front(false) }), facts(at(4), { mainSha: sha('d'), front: front(true) }),
    facts(at(5), { mainSha: sha('e'), front: front(false, { green: true }) }),                  // a green front does not wait for a recompute
    facts(at(6), { mainSha: sha('f'), front: front(false) }), facts(at(7), { mainSha: sha('f'), front: null })];   // the front left: no sample
  const r = review({ receipts: [], shadow: asRecords(seq), since: T0, now: T0 + 5 * H });
  assert.deepEqual([r.stats.recompute.samples, r.stats.recompute.medianMin, r.stats.recompute.maxMin], [1, 20, 20]);
});

test('nodes: no nodes, a never-heard entry, a missing Source, a lone node and different Sources are never 满足; stale heartbeats are 不满足', () => {
  const now = T0 + 2 * H, A = 'c'.repeat(64), B = 'e'.repeat(64);
  const verdictOf = (nodes, expectNodes = 2) => { const r = review({ receipts: [], shadow: asRecords([facts(now - MIN, { nodes })]), since: T0, now, expectNodes }); return [verdicts(r).G7, verdicts(r).G8, r]; };
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN), node('node-b', A, now - 4 * MIN)]).slice(0, 2), [MET, MET]);
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN), node('node-b', B, now - 4 * MIN)]).slice(0, 2), [MET, NOT_MET]);
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN), node('node-b', A, now - 31 * MIN)]).slice(0, 2), [NOT_MET, MET]);
  assert.deepEqual(verdictOf([]).slice(0, 2), [INSUFFICIENT, undefined]);
  assert.deepEqual(verdictOf([{ node: null, sourceManifestSha256: null, state: null, lastHeartbeatAt: null }]).slice(0, 1), [INSUFFICIENT]);
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN), node('node-b', null, now - 4 * MIN)]).slice(0, 2), [MET, INSUFFICIENT]);
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN)]).slice(0, 2), [INSUFFICIENT, INSUFFICIENT], 'one node of two expected');
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN)], 1).slice(0, 2), [MET, MET]);
  assert.deepEqual(verdictOf([node('desk', A, now - 5 * MIN), node('node-b', A, now - 31 * MIN)])[2].nodes.stale, ['node-b']);
});

test('malformed shadow facts never crash the report: wrong types are dropped, sums stay numbers', () => {
  const bad = facts(T0 + 10 * MIN, { wouldRevoke: [null, 5, { headSha: 'x' }, { headSha: sha('1'), checkRunId: 4 }], wouldRevokeCount: '7', nodes: [null, 'x', { node: 5, sourceManifestSha256: 5, lastHeartbeatAt: 'soon' }],
    front: 'x', sweep: { kind: 'full-segment', calls: '7', ms: {}, fullSweep: { state: 'complete', startedAt: 'yesterday', completedAt: iso(T0 + 11 * MIN), reason: 5 } } });
  const bad2 = facts(T0 + 20 * MIN, { wouldRevoke: 'abc', nodes: 'nodes', sweep: 5, front: { pr: -1, headSha: 3 } });
  const bad3 = facts(T0 + 30 * MIN, { wouldRevoke: {}, sweep: { kind: 'full-segment', fullSweep: null } });
  const r = review({ receipts: [], shadow: asRecords([bad, bad2, bad3]), since: T0, now: T0 + 5 * H, chain: OK });
  assert.deepEqual(r.stats.wouldRevoke.uniqueGreens.map(g => g.checkRunId), [4]);
  assert.equal(Number.isFinite(r.sweep.sweeps[0].calls) && Number.isFinite(r.sweep.sweeps[0].activeMs), true);
  assert.doesNotThrow(() => renderPage(r));
});

test('G5: a HALT, an older unclosed intent, or an interrupted run fail it; only the newest intent may still be running; breakers are only noted', async t => {
  const base = runs(8);
  const verdictOf = async (extra, now = T0 + 2 * H) => { const r = review({ receipts: await load(t, [...base, ...extra]), since: T0, now, chain: OK }); return [verdicts(r).G5, r]; };
  assert.equal((await verdictOf([{ at: T0 + 85 * MIN, type: 'halt', body: { code: 'TRAIN_STAGE_INTERRUPTED' } }]))[0], NOT_MET);
  const [dead, r] = await verdictOf([{ at: T0 + 85 * MIN, type: 'train-run-intent', body: { runId: 'dead' } }], T0 + 5 * H);
  assert.deepEqual([dead, r.anomaly.intentsWithoutClose], [NOT_MET, 1]);
  assert.equal((await verdictOf([{ at: T0 + 100 * MIN, type: 'train-run-intent', body: { runId: 'now' } }], T0 + 110 * MIN))[0], MET, 'the newest intent is still running');
  // an unclosed intent followed by a later, closed one is not "the newest": it died
  const died = [{ at: T0 + 90 * MIN, type: 'train-run-intent', body: { runId: 'died' } }, ...stage10(T0 + 100 * MIN, 19)];
  assert.equal((await verdictOf(died, T0 + 110 * MIN))[0], NOT_MET);
  // the closing receipt a restart writes for an interrupted run, with or without a halt receipt
  const interrupted = [{ at: T0 + 85 * MIN, type: 'train-run-intent', body: { runId: 'cut' } }, { at: T0 + 86 * MIN, type: 'train-run', body: { intentSeq: 17, runId: null, mode: 'shadow', ok: false, failureCode: 'TRAIN_STAGE_INTERRUPTED', wouldDo: null, wouldRevokeCount: null, frontPr: null, mainSha: null } }];
  const [cut, rc] = await verdictOf(interrupted);
  assert.deepEqual([cut, rc.anomaly.interruptedRuns], [NOT_MET, 1]);
  const [quiet, rq] = await verdictOf([{ at: T0 + 85 * MIN, type: 'breaker-opened', body: { cause: 'GITHUB_TRANSIENT_UNAVAILABLE' } }]);
  assert.deepEqual([quiet, rq.anomaly.receiptsByKind['breaker-opened']], [MET, 1]);
  const [transient, rt] = await verdictOf(stage10(T0 + 90 * MIN, 17, { ok: false, failureCode: 'GITHUB_TRANSIENT_UNAVAILABLE', wouldDo: null, revokes: null }));
  assert.deepEqual([transient, rt.anomaly.stage10Failures.map(f => f.code)], [MET, ['GITHUB_TRANSIENT_UNAVAILABLE']]);
});

test('the verdict: every gate must be met; the second place needs data (the queue residence), the recompute delay does not', async t => {
  const fronts = Object.fromEntries([3, 4, 5].map((k, i) => [k, [800 + i, 'FRONT_GREEN_WAIT_MERGE']]));
  const receipts = await load(t, [...runs(8, fronts), ...batch(T0 + 1 * MIN, 1, 800, sha('1'), 'COMPLETED')]);
  const s1 = iso(T0 + MIN), s2 = iso(T0 + H);
  const shadow = asRecords([sweepFacts(T0 + 12 * MIN, 'complete', { startedAt: s1, completedAt: iso(T0 + 12 * MIN) }), sweepFacts(T0 + 72 * MIN, 'complete', { startedAt: s2, completedAt: iso(T0 + 72 * MIN) }),
    facts(T0 + 75 * MIN, { nodes: [node('desk', 'c'.repeat(64), T0 + 74 * MIN), node('node-b', 'c'.repeat(64), T0 + 73 * MIN)] })]);
  const pulls = { 800: { mergedAt: iso(T0 + 40 * MIN) } };
  const markers = [{ leftQueuedAt: iso(T0 + 5 * MIN), headLeftAt: iso(T0 + 16 * MIN) }];
  const common = { receipts, pulls, markers, since: T0, now: T0 + 76 * MIN, chain: OK };
  const noRecompute = review({ ...common, shadow });
  assert.deepEqual(verdicts(noRecompute), { GC: MET, G1: MET, G2: MET, G3: MET, G4: MET, G5: MET, G6: MET, G7: MET, G8: MET });
  assert.equal(noRecompute.stats.recompute.samples, 0);
  assert.match(noRecompute.gates.find(g => g.id === 'G6').evidence, /重算延迟没有样本，Owner 已定开车前不要求/);
  assert.deepEqual([noRecompute.canEnterTrainOn, noRecompute.blocking], [true, []]);
  assert.match(renderPage(noRecompute), /影子观察条件全部满足/);
  const noQueue = review({ ...common, shadow: [...shadow], markers: null });
  assert.match(noQueue.gates.find(g => g.id === 'G6').evidence, /第 2 位的等待/);
  assert.deepEqual([noQueue.canEnterTrainOn, noQueue.blocking], [false, ['G6']]);
  assert.match(renderPage(noQueue), /还不能进入 a3701d3d 开车：1 项未满足或数据不够（G6）/);
  const front = (ok, o = {}) => ({ claimId: 'x', pr: 800, headSha: sha('8'), green: false, testMergeParentsOk: ok, ...o });
  const moving = [...shadow, ...asRecords([facts(T0 + 20 * MIN, { front: front(true) }), facts(T0 + 30 * MIN, { mainSha: sha('d'), front: front(false) }), facts(T0 + 40 * MIN, { mainSha: sha('d'), front: front(true) })])];
  const ok = review({ ...common, shadow: moving });
  assert.equal(ok.canEnterTrainOn, true, JSON.stringify(ok.blocking));
  assert.match(renderPage(ok), /影子观察条件全部满足/);
  assert.equal(review({ ...common, shadow: moving, chain: { status: 'broken', text: 'x' } }).canEnterTrainOn, false);
});

test('loadReceipts reads the open segment and archived months, skips foreign files, counts the unreadable; a missing folder is reported', async t => {
  const dir = await chainOf(t, runs(2));
  await fs.mkdir(path.join(dir, 'archive', '0001-2026-10'), { recursive: true });
  await fs.writeFile(path.join(dir, 'archive', '0001-2026-10', '00000000-service-start.json'), JSON.stringify({ seq: 0, type: 'service-start', at: iso(T0 - H), body: {} }));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  await fs.writeFile(path.join(dir, '00000099-train-run.json'), '{broken');
  await fs.writeFile(path.join(dir, '00000098-train-run.json'), JSON.stringify({ seq: 1, type: 'train-run', at: iso(T0), body: {} }));   // name and seq disagree
  await fs.writeFile(path.join(dir, '00000097-train-run.json'), JSON.stringify({ seq: 97, type: 'train-run', at: '5 Nov', body: {} }));    // a time that is no ISO time
  const { receipts, unreadable } = await loadReceipts(dir);
  assert.deepEqual([receipts.length, unreadable, receipts[0].seq], [5, 3, 0]);
  assert.deepEqual(await loadReceipts(path.join(dir, 'nope')), { receipts: [], unreadable: 0, missing: true });
});

test('loadShadow reads facts /1 and /2 in time order, ignores *.tmp, counts and drops the unreadable, sanitizes the rest', async t => {
  const dir = await tempRoot(t);
  const put = async (name, value) => fs.writeFile(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  const a = facts(T0 + MIN), b = facts(T0, { wouldRevoke: 'abc' });
  b.facts.contract = 'clued.independent-ci.train-facts/1';
  const stamp = x => String(x.at).padStart(13, '0');
  await put(`${stamp(a)}-0000000000000001-aaaaaaaaaaaa.json`, { runId: '0000000000000001-aaaaaaaaaaaa', facts: a.facts });
  await put(`${stamp(b)}-0000000000000002-bbbbbbbbbbbb.json`, { runId: '0000000000000002-bbbbbbbbbbbb', facts: b.facts });
  await put(`${stamp(a)}-0000000000000003-cccccccccccc.json.tmp`, { runId: 'x', facts: a.facts });
  await put(`${stamp(a)}-0000000000000004-dddddddddddd.json`, '{torn');
  await put(`${stamp(a)}-0000000000000005-eeeeeeeeeeee.json`, { runId: 'r', facts: { contract: 'other/1', at: iso(a.at) } });
  await put(`${stamp(a)}-0000000000000006-ffffffffffff.json`, 'null');
  await put(`${stamp(a)}-0000000000000007-111111111111.json`, { runId: 'r', facts: 5 });
  const { records, unreadable } = await loadShadow(dir);
  assert.deepEqual([records.map(r => r.runId), unreadable], [['0000000000000002-bbbbbbbbbbbb', '0000000000000001-aaaaaaaaaaaa'], 4]);
  assert.deepEqual(records[0].facts.wouldRevoke, []);
  assert.equal((await loadShadow(path.join(dir, 'nope'))).missing, true);
});

test('command line: page or JSON, chain verified, strict arguments, nothing written anywhere under the inputs', async t => {
  const dir = await chainOf(t, runs(8, { 0: [1, 'OPEN_FRONT_BATCH'] }));
  const shadow = await tempRoot(t);
  const a = facts(T0 + MIN);
  await fs.writeFile(path.join(shadow, `${String(a.at).padStart(13, '0')}-0000000000000001-aaaaaaaaaaaa.json`), JSON.stringify({ runId: '0000000000000001-aaaaaaaaaaaa', facts: a.facts }));
  const snapshot = async root => (await fs.readdir(root, { recursive: true })).sort().map(n => n).join('|') + '#' + (await Promise.all((await fs.readdir(root, { recursive: true })).sort().map(async n => { const s = await fs.stat(path.join(root, n)); return s.isDirectory() ? n : `${n}:${s.size}:${s.mtimeMs}`; }))).join('|');
  const before = [await snapshot(dir), await snapshot(shadow)];
  const clock = () => T0 + 2 * H;
  const page = await run(['--receipts', dir, '--shadow', shadow, '--since', iso(T0)], { clock });
  assert.match(page, /回执链：完整（序号 16）/);
  assert.match(page, /\| G2 至少 3 个真实队首 PR 经过[^|]*\| 不满足 \|/);
  const json = JSON.parse(await run(['--receipts', dir, '--since', iso(T0), '--json', '--no-verify', '--nodes', '3'], { clock }));
  assert.deepEqual([json.contract, json.chain, json.canEnterTrainOn], ['clued.independent-ci.train-shadow-review/1', '未核验（--no-verify）', false]);
  assert.deepEqual([await snapshot(dir), await snapshot(shadow)], before, 'the inputs are untouched');
  const file = path.join(dir, (await fs.readdir(dir)).find(n => n.endsWith('-train-run.json')));
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"ok":true', '"ok":false'));
  assert.match(await run(['--receipts', dir], { clock }), /回执链：核验失败/);
  const bad = path.join(await tempRoot(t), 'x.json');
  await fs.writeFile(bad, '{nope');
  const arr = path.join(path.dirname(bad), 'a.json');
  await fs.writeFile(arr, '[]');
  const cases = [[[], 'RECEIPTS_REQUIRED'], [['--receipts'], 'ARGUMENT_VALUE_MISSING'], [['--receipts', dir, '--since', '--json'], 'ARGUMENT_VALUE_MISSING'], [['--receipts', dir, '--shadow', ''], 'ARGUMENT_VALUE_MISSING'],
    [['--receipts', dir, '--bogus'], 'ARGUMENT_UNKNOWN'], [['--receipts', dir, '--receipts', dir], 'ARGUMENT_DUPLICATE'],
    [['--receipts', dir, '--since', 'yesterday'], 'TIME_INVALID'], [['--receipts', dir, '--since', '2026'], 'TIME_INVALID'], [['--receipts', dir, '--since', '2026-11-05T00:00:00'], 'TIME_INVALID'],
    [['--receipts', dir, '--since', '2026-11-05T10:00:00Z', '--now', '2026-11-05T09:00:00Z'], 'SINCE_AFTER_NOW'], [['--receipts', dir, '--nodes', '0'], 'NODES_INVALID'],
    [['--receipts', path.join(dir, 'missing')], 'RECEIPTS_MISSING'], [['--receipts', dir, '--shadow', path.join(dir, 'missing')], 'SHADOW_MISSING_OR_UNREADABLE'],
    [['--receipts', dir, '--status', bad], 'INPUT_UNREADABLE'], [['--receipts', dir, '--status', path.join(dir, 'missing.json')], 'INPUT_UNREADABLE'], [['--receipts', dir, '--status', arr], 'INPUT_SHAPE_INVALID'],
    [['--receipts', dir, '--queue-markers', bad], 'INPUT_UNREADABLE']];
  for (const [args, code] of cases) await assert.rejects(run(args, { clock }), error => error.code === code, `${args.join(' ')} -> ${code}`);
  assert.match(await run(['--receipts', dir, '--since', '2026-11-05T08:00:00+08:00', '--no-verify'], { clock }), /窗口起点：2026-11-05T00:00:00\.000Z/);
});

test('run as a script: through a directory link it still prints the page, and a refusal exits 1 with a code', async t => {
  const dir = await chainOf(t, runs(2));
  const link = path.join(await tempRoot(t), 'tools-link');
  await fs.symlink(path.resolve(import.meta.dirname, '..', 'tools'), link, 'junction');
  const out = spawnSync(process.execPath, [path.join(link, 'train-shadow-review.mjs'), '--receipts', dir, '--no-verify'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /影子审查（合并列车开车前）/);
  const refused = spawnSync(process.execPath, [path.join(link, 'train-shadow-review.mjs')], { encoding: 'utf8' });
  assert.deepEqual([refused.status, JSON.parse(refused.stderr).code], [1, 'RECEIPTS_REQUIRED']);
});

test('second review round: prior-boot stop fails G5, duplicate node names count once, input order does not matter, a green streak ends at any run that is not its green, outcomes after --now are unseen', async t => {
  const base = runs(8);
  const crash = review({ receipts: await load(t, [...base, { at: T0 + 85 * MIN, type: 'service-stop-prior-boot', body: { pid: 1 } }]), since: T0, now: T0 + 2 * H, chain: OK });
  assert.equal(verdicts(crash).G5, NOT_MET);
  assert.match(crash.gates.find(g => g.id === 'G5').evidence, /断电\/崩溃后的停机记录 1/);
  const now = T0 + 2 * H, A = 'c'.repeat(64);
  const twice = review({ receipts: [], shadow: asRecords([facts(now - MIN, { nodes: [node('a', A, now - MIN), node('a', A, now - MIN)] })]), since: T0, now });
  assert.deepEqual([verdicts(twice).G7, verdicts(twice).G8, twice.nodes.heard], [INSUFFICIENT, INSUFFICIENT, 1]);
  const front = (ok, o = {}) => ({ claimId: 'x', pr: 7, headSha: sha('7'), green: false, testMergeParentsOk: ok, ...o });
  const ordered = [facts(T0, { front: front(true) }), facts(T0 + 10 * MIN, { mainSha: sha('d'), front: front(false) }), facts(T0 + 20 * MIN, { mainSha: sha('d'), front: front(true) })];
  const shuffled = review({ receipts: [], shadow: asRecords([ordered[2], ordered[0], ordered[1]]), since: T0, now: T0 + 5 * H });
  assert.equal(shuffled.stats.recompute.samples, 1);
  // green at run 0, no front at run 1, green again at run 2, merged at 60 minutes: the streak starts at run 2
  const receipts = await load(t, runs(5, { 0: [10, 'FRONT_GREEN_WAIT_MERGE'], 2: [10, 'FRONT_GREEN_WAIT_MERGE'] }));
  const g = review({ receipts, since: T0, now: T0 + 5 * H, chain: OK, pulls: { 10: { mergedAt: iso(T0 + 60 * MIN) } } });
  assert.deepEqual(g.stats.greenToMerge.samples.map(s => s.gapMin), [40]);
  // a terminal receipt after --now is not seen by a replay with an earlier --now
  const script = [...runs(4, { 1: [10, 'OPEN_FRONT_BATCH'] }), ...batch(T0 + 1 * MIN, 1, 10, sha('1'), 'COMPLETED')].sort((a, b) => a.at - b.at);
  const replay = review({ receipts: await load(t, script), since: T0, now: T0 + 1 * MIN + 30_000, chain: OK });
  assert.deepEqual([replay.stats.firstRunFailure.heads, replay.stats.firstRunFailure.decided], [0, 0]);
  const gapPage = review({ receipts: await load(t, [...stage10(T0, 1), ...stage10(T0 + 70 * MIN, 3)]), since: T0, now: T0 + 5 * H, chain: OK });
  assert.match(gapPage.gates.find(g => g.id === 'G1').evidence, /最长间隔 70 分钟，只显示不判定/);
  assert.equal(verdicts(gapPage).G1, MET);
});

test('the status file only vouches for a shadow-mode sweep', async t => {
  const receipts = await load(t, runs(8));
  const sweepOf = (mode, enabled) => ({ train: { enabled, last: { mode, sweep: { fullSweep: { state: 'running' } } }, sweep: { fullCompletedAt: iso(T0 + H) } } });
  assert.equal(verdicts(review({ receipts, status: sweepOf('shadow', 'shadow'), since: T0, now: T0 + 5 * H, chain: OK })).G3, MET);
  assert.equal(verdicts(review({ receipts, status: sweepOf('on', 'on'), since: T0, now: T0 + 5 * H, chain: OK })).G3, INSUFFICIENT);
});
