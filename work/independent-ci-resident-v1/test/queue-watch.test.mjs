// Generation 12 (DESIGN §56.2): the queue watch. A batch parked at B because its claim is not in the merge queue, or not at
// its head, is watched by a role probe every QUEUE_WATCH_MS on a tick that ran nothing; when the slot holder is bound to its
// PR, its stage-8 try is due now instead of after the back-off (10 minutes and more).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, PARK_RETRY_MS, QUEUE_WATCH_FAIL_MS, QUEUE_WATCH_MS, QUEUE_WATCH_MAX_PER_DAY } from '../src/executor.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { ROLE_PROBE_CODES, roleBookFact, validateRoleProbeFact } from '../src/role-probe.mjs';
import { WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const SEC = 1000, MIN = 60_000;
const T0 = Date.parse('2026-11-05T08:00:00Z');
const HELD = { result: 'held', code: 'ROLE_PROBE_HELD' };
const WATCHED = { result: 'held', code: 'ROLE_PROBE_HELD_WATCHED_HEAD' };
const NOT_HELD = { result: 'not-held', code: 'ROLE_PROBE_NOT_HELD' };
const UNCERTAIN = { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' };
const probeResult = fact => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true }, roleProbe: fact,
  outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false } });
const notReady = (code, mergeQueue = { entered: false, state: null, position: null }) => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue }, safeToRerun: false } });

// answer(opts): the probe's answer for this call (opts.watchPr when it watches). stage8: the not-ready answers of PR 884's first tries.
async function fx(t, { answer = () => HELD, stage8 = [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')] } = {}) {
  const engine = fakeEngine();
  engine.probes = [];
  engine.queueWatchSupported = async () => true;
  engine.runRoleProbe = async (opts) => { const a = answer(opts ?? null, engine.probes.length); engine.probes.push(opts ?? null); return typeof a === 'function' ? a() : probeResult(a); };
  const run = engine.runStage, derive = engine.derive;
  const left = [...stage8];
  engine.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8 && batch.pr === 884 && left.length) { engine.calls.push(['stage', 8]); return left.shift(); }
    return run(batch, stage, o);
  };
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, status: board, now: T0 });
  await f.exec.tick(); // the start's probe: ACTIVE
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  return f;
}
const watches = f => f.engine.probes.filter(p => p?.watchPr);
const tries = f => f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 8).length;
const receiptBodies = async (f, type) => {
  const dir = path.join(f.root, 'state', 'receipts');
  const out = [];
  for (const n of (await fs.readdir(dir)).sort()) if (n.endsWith(`-${type}.json`)) out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')).body);
  return out;
};

test('not in the queue: watched every 30 s on a quiet tick; once its claim holds the slot the try comes at once, not after 10 minutes', async t => {
  let joined = false;
  const f = await fx(t, { answer: o => (o?.watchPr === 884 && joined ? WATCHED : HELD) });
  assert.equal(tries(f), 1);
  assert.equal(watches(f).length, 0, 'not at the parking tick itself (the role probe ran within 30 s)');
  f.advance(QUEUE_WATCH_MS);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(watches(f), [{ watchPr: 884 }], 'one watch of PR 884');
  assert.equal(tries(f), 1, 'a watch is no try');
  await f.exec.tick();
  assert.equal(watches(f).length, 1, 'never twice within QUEUE_WATCH_MS');
  joined = true;
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 2);
  // the next tick runs the try (its last try ended over a minute ago); the second try passes
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.equal(tries(f), 2);
  assert.ok(f.clock() - T0 < PARK_RETRY_MS[0], 'well before the 10-minute back-off');
  const results = await receiptBodies(f, 'role-probe-result');
  assert.deepEqual(results.filter(b => b.watch).map(b => b.watch), [{ pr: 884, head: false }, { pr: 884, head: true }]);
  assert.deepEqual((await receiptBodies(f, 'role-probe-intent')).filter(b => b.watchPr).map(b => b.watchPr), [884, 884]);
  // the role book keeps the plain held code (an earlier generation reads it back)
  assert.equal(f.exec.roleProbe.last.code, 'ROLE_PROBE_HELD');
  assert.equal(f.exec.roleProbeMode, 'ACTIVE');
});

test('behind another claim (RESIDENT_QUEUE_HEAD_NOT_REACHED, place 2): watched too; at the first place (60 s tries) it is not', async t => {
  const f = await fx(t, { answer: o => (o?.watchPr === 884 ? WATCHED : HELD),
    stage8: [notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 2 }),
      notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'head', position: 1 })] });
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 1);
  f.advance(MIN);
  assert.equal((await f.exec.tick()).state, 'PARKED', 'the nudged try: now first in the queue but not ready');
  assert.equal(tries(f), 2);
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 1, 'a try at the first place comes a minute apart anyway: no watch');
});

test('network cut: an uncertain watch brings nothing forward, never HALTs, backs off (30 s, 2, 5, 10 min) and is no role-probe failure', async t => {
  const f = await fx(t, { answer: o => (o?.watchPr ? UNCERTAIN : HELD) });
  const at = [];
  for (let i = 0; i < 36; i++) { f.advance(QUEUE_WATCH_MS / 2); const n = watches(f).length; await f.exec.tick(); if (watches(f).length > n) at.push(f.clock() - T0); }
  assert.ok(f.clock() - T0 < PARK_RETRY_MS[0], 'still before the back-off try');
  const gaps = at.slice(1).map((x, i) => x - at[i]);
  assert.deepEqual(gaps.slice(0, 3), [QUEUE_WATCH_FAIL_MS[0], QUEUE_WATCH_FAIL_MS[1], QUEUE_WATCH_FAIL_MS[2]].map(ms => Math.ceil(ms / (QUEUE_WATCH_MS / 2)) * (QUEUE_WATCH_MS / 2)));
  assert.equal(tries(f), 1, 'nothing brought the try forward');
  assert.equal(await f.ledger.halted(), null);
  assert.equal(f.exec.roleProbeMode, 'ACTIVE', 'uncertain changes no mode');
  assert.equal(f.exec.roleProbe.failures, 0, 'no failure streak in the role book');
  assert.equal(f.exec.roleProbeNotices.length, 0, 'no role-probe-uncertain notice for the Owner');
  f.advance(PARK_RETRY_MS[0]);
  await f.exec.tick();
  assert.equal(tries(f), 2, 'the back-off try still comes');
});

test('holders and stage 8 disagree (the watch keeps saying head, stage 8 keeps saying not joined): one nudged try, then the back-off; a new change to head nudges again', async t => {
  let head = true;
  const f = await fx(t, { answer: o => (o?.watchPr === 884 && head ? WATCHED : HELD),
    stage8: Array.from({ length: 20 }, () => notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')) });
  for (let i = 0; i < 30; i++) { f.advance(QUEUE_WATCH_MS); await f.exec.tick(); }
  assert.equal(tries(f), 2, 'the first try and one nudged try in 15 minutes, not one a minute');
  const triesBefore = tries(f);
  head = false;
  f.advance(QUEUE_WATCH_MS); await f.exec.tick();
  head = true;
  f.advance(QUEUE_WATCH_MS); await f.exec.tick();
  f.advance(MIN); await f.exec.tick();
  assert.equal(tries(f), triesBefore + 1, 'the slot came back to it: one more try');
});

test('a clock that steps back never reaches the role book through a watch (no throw, no swap until it caught up)', async t => {
  const f = await fx(t, { answer: o => (o?.watchPr === 884 ? HELD : HELD) });
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 1);
  f.advance(-2 * MIN);
  const r = await f.exec.tick();
  assert.notEqual(r.state, 'HALTED');
  assert.equal(watches(f).length, 1, 'no watch while the clock is behind the last observation');
  // a clock that steps back during the probe: the answer is not observed, nothing throws
  f.advance(3 * MIN);
  f.engine.runRoleProbe = async opts => { f.engine.probes.push(opts ?? null); f.advance(-5 * MIN); return probeResult(HELD); };
  await f.exec.tick();
  assert.equal(watches(f).length, 2);
  assert.equal(await f.ledger.halted(), null);
});

test('the gap is counted from the end of the last probe: a 40 s urgent probe and a watch never share a tick', async t => {
  const f = await fx(t);
  f.advance(QUEUE_WATCH_MS);
  const slow = f.engine.runRoleProbe;
  f.engine.runRoleProbe = async opts => { if (!opts) f.advance(40 * SEC); return slow(opts); };
  f.exec.roleProbe.markUrgent();
  await f.exec.tick();
  assert.deepEqual(f.engine.probes.slice(-1), [null], 'the urgent probe only');
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.deepEqual(f.engine.probes.slice(-1), [{ watchPr: 884 }]);
});

test('the cadence slows with the time at B: 30 s for 30 minutes, then 2 minutes', async t => {
  const f = await fx(t, { stage8: [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), ...Array.from({ length: 10 }, () => notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'))] });
  const at = [];
  for (let i = 0; i < 200; i++) { f.advance(QUEUE_WATCH_MS); const n = watches(f).length; await f.exec.tick(); if (watches(f).length > n) at.push(f.clock() - T0); }
  const early = at.filter(x => x < 30 * MIN), late = at.filter(x => x > 40 * MIN && x < 90 * MIN);
  assert.ok(early.length >= 40, `about one every 30 s at first (${early.length})`);
  const lateGaps = late.slice(1).map((x, i) => x - late[i]).filter(g => g < 10 * MIN);
  assert.ok(lateGaps.length > 0 && lateGaps.every(g => g >= 2 * MIN), JSON.stringify(lateGaps));
});

test('no watch while the stage-8 tries of the day are used up', async t => {
  const f = await fx(t);
  f.advance(QUEUE_WATCH_MS);
  f.ledger.usage = async () => ({ stage8Retries: 10_000 });
  assert.equal(await f.exec.queueWatchMaintenance(), null);
  assert.equal(watches(f).length, 0);
  assert.equal(f.exec.queueWatchView.size, 0, 'and the PR page is not told it is watched');
});

test('#1144: a different PR exhausting stage 8 cannot disable this PR queue watch', async t => {
  const f = await fx(t);
  f.advance(QUEUE_WATCH_MS);
  f.ledger.usage = async (_since, options) => ({ stage8Retries: options?.stage8Pr === 884 ? 0 : 100 });
  await f.exec.queueWatchMaintenance();
  assert.deepEqual(watches(f), [{ watchPr: 884 }]);
});

test('a watch that leaves no confirmed fact HALTs like any role probe (the swap may not be clean); a busy engine only defers', async t => {
  const busy = await fx(t, { answer: o => (o?.watchPr ? () => ({ ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null }) : HELD) });
  busy.advance(QUEUE_WATCH_MS);
  await busy.exec.tick();
  assert.equal(await busy.ledger.halted(), null);
  const lost = await fx(t, { answer: o => (o?.watchPr ? () => ({ ok: false, code: 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false }, roleProbe: null }) : HELD) });
  lost.advance(QUEUE_WATCH_MS);
  assert.equal((await lost.exec.tick()).failureCode, 'ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED');
});

test('a probe without a watch that names a watched head is no fact (HALT): only a watch may say so', async t => {
  const f = await fx(t);
  f.engine.runRoleProbe = async () => { f.engine.probes.push(null); return probeResult(WATCHED); };
  f.exec.roleProbe.markUrgent();
  assert.equal((await f.exec.roleProbeMaintenance()).failureCode, 'ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED');
});

test('no watch on a STANDBY node, under PAUSE, for a try due within 30 s, past park.maxMs, or past the daily cap', async t => {
  const standby = await fx(t);
  await standby.exec.setNodeMode('STANDBY', 'test');
  standby.advance(QUEUE_WATCH_MS);
  assert.equal(await standby.exec.queueWatchMaintenance(), null);
  assert.equal(watches(standby).length, 0);

  const paused = await fx(t);
  paused.advance(QUEUE_WATCH_MS);
  await paused.ledger.pause({ reason: 'test', requestSha256: 'a'.repeat(64) });
  assert.equal(await paused.exec.queueWatchMaintenance(), null);
  assert.equal(watches(paused).length, 0);

  const soon = await fx(t);
  soon.advance(PARK_RETRY_MS[0] - QUEUE_WATCH_MS + SEC);
  assert.equal(await soon.exec.queueWatchMaintenance(), null, 'its try is due within QUEUE_WATCH_MS anyway');
  assert.equal(watches(soon).length, 0);

  const capped = await fx(t);
  capped.advance(QUEUE_WATCH_MS);
  capped.exec.queueWatchDay = { day: new Date(capped.clock()).toISOString().slice(0, 10), n: QUEUE_WATCH_MAX_PER_DAY };
  assert.equal(await capped.exec.queueWatchMaintenance(), null);
  assert.equal(watches(capped).length, 0);
  capped.advance(24 * 60 * MIN);
  const entries = await capped.ledger.parkedEntries();
  assert.deepEqual(capped.exec.queueWatchCandidates(entries, capped.clock()), [], 'past park.maxMs the batch is not watched');
});

test('no watch with a Source that does not know it (or an engine without the check)', async t => {
  const f = await fx(t);
  f.engine.queueWatchSupported = async () => false;
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 0);
  delete f.engine.queueWatchSupported;
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 0);
  f.engine.queueWatchSupported = async () => { throw new Error('unreadable'); };
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 0);
});

test('the role fact of a watch: validated as held; the book stores ROLE_PROBE_HELD', () => {
  assert.deepEqual(validateRoleProbeFact(WATCHED), WATCHED);
  assert.throws(() => validateRoleProbeFact({ result: 'not-held', code: ROLE_PROBE_CODES.watchedHead }));
  assert.deepEqual(roleBookFact(validateRoleProbeFact(WATCHED)), HELD);
  assert.equal(roleBookFact(NOT_HELD), NOT_HELD);
});

test('review round 2: the first place is watched once its 60 s streak is over, not during it', async t => {
  const first = () => notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'head', position: 1 });
  const f = await fx(t, { stage8: Array.from({ length: 40 }, first) });
  const at = [];
  for (let i = 0; i < 60; i++) { f.advance(QUEUE_WATCH_MS); const n = watches(f).length; await f.exec.tick(); if (watches(f).length > n) at.push(f.clock() - T0); }
  assert.ok(at.length > 0, 'watched after the streak');
  assert.ok(at.every(x => x > 15 * MIN), JSON.stringify(at));
});

test('review round 2: the watched mark goes stale when no quiet tick renewed it; a watch that could not start is not counted', async t => {
  const f = await fx(t);
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  const row = () => parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot()))).pending.find(p => p.state === 'PARKED');
  f.exec.reportQueue();
  assert.equal(row().watched, true);
  f.advance(2 * MIN);
  f.exec.reportQueue();
  assert.equal(row().watched, false, 'nothing renewed it (as while another batch runs)');
  // a watch that cannot start (not idle) is not counted and not tried again at once
  const n = f.exec.queueWatchDay.n;
  const halted = f.ledger.halted.bind(f.ledger);
  f.ledger.halted = async () => ({ value: { code: 'X' } });
  f.advance(QUEUE_WATCH_MS);
  assert.equal(await f.exec.queueWatchMaintenance(), null);
  assert.equal(f.exec.queueWatchDay.n, n);
  // (review round 3: the status view is refreshed on every quiet tick, so the ledger is read; no second start is attempted)
  let halts = 0;
  f.ledger.halted = async () => { halts++; return { value: { code: 'X' } }; };
  const probes = f.engine.probes.length;
  assert.equal(await f.exec.queueWatchMaintenance(), null);
  assert.equal(halts, 0, 'not tried again within QUEUE_WATCH_MS (roleProbeMaintenance is not entered)');
  assert.equal(f.engine.probes.length, probes);
  f.ledger.halted = halted;
});

test('review round 3: a watch the engine deferred (the runner busy) is not counted towards the daily cap', async t => {
  const f = await fx(t, { answer: o => (o?.watchPr ? () => ({ ok: false, code: 'ROLE_PROBE_BUSY', deferred: true, proof: null, roleProbe: null }) : HELD) });
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(watches(f).length, 1);
  assert.equal(f.exec.queueWatchDay?.n ?? 0, 0);
});

test('review round 4: a watch answering not-held switches the node to STANDBY even when its answer could not reach the role book', async t => {
  const f = await fx(t);
  f.advance(QUEUE_WATCH_MS);
  f.engine.runRoleProbe = async opts => { f.engine.probes.push(opts ?? null); f.advance(-5 * MIN); return probeResult(NOT_HELD); };
  await f.exec.tick();
  assert.equal(watches(f).length, 1);
  assert.equal(f.exec.roleProbeMode, 'STANDBY');
});

test('review round 5: every answered watch tells the breaker; an uncertain one is a failed probe (no Owner notice)', async t => {
  const f = await fx(t, { answer: o => (o?.watchPr ? (f.engine.probes.length % 2 ? UNCERTAIN : HELD) : HELD) });
  const told = [];
  const note = f.exec.noteBreakerProbe.bind(f.exec);
  f.exec.noteBreakerProbe = async (ok, why) => { told.push(ok); return note(ok, why); };
  for (let i = 0; i < 3; i++) { f.advance(2 * MIN); await f.exec.tick(); }
  assert.ok(told.includes(false), JSON.stringify(told));
  assert.ok(told.includes(true), JSON.stringify(told));
  assert.equal(f.exec.roleProbe.failures, 0, 'the role book keeps no uncertain count from watches');
  assert.equal(f.exec.roleProbeNotices.length, 0);
});

test('review round 13: once another batch starts, the parked row is no longer shown as watched (the page goes back to the generation-11 text)', async t => {
  const f = await fx(t);
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  const row = () => parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot()))).pending.find(p => p.pr === 884);
  f.exec.reportQueue();
  assert.equal(row().watched, true);
  let seen = null;
  const run = f.engine.runStage;
  f.engine.runStage = async (batch, stage, o) => { if (batch.pr === 900 && stage.number === 3) seen = row().watched; return run(batch, stage, o); };
  await f.drop(triggerBytes({ pr: 900, headSha: 'c'.repeat(40) }));
  await f.exec.tick();
  assert.equal(seen, false, 'while PR 900 runs, PR 884 is not shown as watched');
});

test('review round 20: no watch under an intake pause, also on a tick whose schedule had no due row; it resumes when the pause ends', async t => {
  const { intakePauseRequest, intakeResumeRequest } = await import('../src/intake-pause.mjs');
  const f = await fx(t);
  await f.drop(Buffer.from(JSON.stringify(intakePauseRequest({ minutes: 30, reason: 'planned switch' }, f.clock))), 'requests');
  for (let i = 0; i < 4; i++) { f.advance(QUEUE_WATCH_MS); await f.exec.tick(); }
  assert.equal(watches(f).length, 0, 'held by the pause (no due row: the schedule itself was IDLE)');
  const st = parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot())));
  assert.equal(st.pending.find(p => p.pr === 884)?.watched, false, 'and not shown as watched');
  await f.drop(Buffer.from(JSON.stringify(intakeResumeRequest({ reason: 'switch done' }, f.clock))), 'requests');
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.ok(watches(f).length >= 1, 'watched again after the pause');
});

test('review round 20: no watch while the train take-over sweep holds the parked batches', async t => {
  const f = await fx(t);
  f.exec.trainTakeoverPending = () => true;
  for (let i = 0; i < 3; i++) { f.advance(QUEUE_WATCH_MS); await f.exec.tick(); }
  assert.equal(watches(f).length, 0);
});

test('review round 27: a slow watch (and a stage-10 run after it in the same tick) keeps the row watched in that tick\'s own report', async t => {
  let slow = false, f;
  f = await fx(t, { answer: o => (o?.watchPr && slow ? () => { f.advance(100 * SEC); return probeResult(HELD); } : HELD) });
  const row = () => parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot()))).pending.find(p => p.state === 'PARKED');
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.equal(row().watched, true);
  slow = true;
  f.advance(QUEUE_WATCH_MS);
  await f.exec.tick();
  assert.ok(watches(f).length >= 2);
  assert.equal(row().watched, true, 'the report at the end of the slow tick');
  f.advance(15 * SEC);
  await f.exec.tick();
  assert.equal(row().watched, true, 'and the next quiet tick');
});
