// The executor on its run queue (resident quota redesign phase 2, step 1: design v0.5 §4.2-§4.7, §7): scheduling order,
// the budgets from the ledger, waits, the breaker, supersession at the safe points, falsification and restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, SUPERSEDED_AT_SAFE_POINT, SUPERSEDED_ARCHIVE_REASON, BATCH_SUPERSEDED } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { RunQueue } from '../src/queue.mjs';
import { BASE, HEAD, RELAY_ON, SAFE_REFUSAL, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, localRow, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const H = n => String(n).repeat(40).slice(0, 40);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
const WAIT = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['merge_slot_required'] } };
// A stage-1 engine whose answer depends on the PR: per = { [pr]: result }.
const perPr = (per, base = fakeEngine()) => {
  const run = base.runStage;
  base.runStage = async (batch, stage, o) => {
    if (stage.number === 1 && per[batch.pr]) { base.calls.push(['stage', 1]); return per[batch.pr]; }
    return run(batch, stage, o);
  };
  const derive = base.derive;
  base.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  return base;
};

test('the order: a due attempt 2, then due waits, then first come first served; a row deferred for itself never blocks the rest', async t => {
  const engine = perPr({ 1: notAdmitted('NATIVE_NOT_ADMITTED', WAIT) });
  const f = await executorFixture(t, { engine, policy: rawPolicy({ limits: { ...rawPolicy().limits, perPrBatchesPer24h: 1 } }) });
  await f.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  assert.equal(f.queue.row(1).state, 'WAITING');
  await f.drop(triggerBytes({ pr: 2, headSha: H(2) }));
  await f.drop(triggerBytes({ pr: 3, headSha: H(3) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'PR 2 first come');
  f.advance(10 * MIN);
  // the wait of PR 1 is due and goes before PR 3, which arrived earlier than its retry
  const r = await f.exec.tick();
  assert.deepEqual([r.state, f.queue.row(1).level], ['NOT_ADMITTED', 2]);
  assert.equal(f.queue.row(1).origin, 'waiting-retry');
  // PR 3 runs; then a new commit of PR 2 is deferred for that PR alone (its 1 batch a day) and PR 4 behind it runs
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  await f.drop(triggerBytes({ pr: 2, headSha: H(5) }));
  await f.drop(triggerBytes({ pr: 4, headSha: H(4) }));
  const s = await f.exec.tick();
  assert.deepEqual([s.state, f.queue.row(2).reason], ['COMPLETED', 'PR_DAILY_BATCH_LIMIT']);
});

test('the budgets come from the ledger: waits have their own, environment releases and supersessions are no evaluations', async t => {
  const engine = perPr({ 1: notAdmitted('NATIVE_NOT_ADMITTED', WAIT), 2: { ok: false, code: 'BROKER_REQUEST_EXPIRED', proof: WINDOWS_CLEAN, outcome: null, brokerNoLaunch: true } });
  const f = await executorFixture(t, { engine, policy: rawPolicy({ limits: { ...rawPolicy().limits, waitingRetriesPer24h: 1 } }) });
  await f.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  await f.drop(triggerBytes({ pr: 2, headSha: H(2) }));
  await f.exec.tick();
  await f.exec.tick();
  let u = await f.ledger.usage(0);
  assert.deepEqual([u.evaluations, u.waitingRetries, u.releasesByHead.get(H(2))], [1, 0, 1], 'the first wait is an evaluation; the broker release is not');
  f.advance(10 * MIN);
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED', 'the first waiting retry');
  u = await f.ledger.usage(0);
  assert.deepEqual([u.evaluations, u.waitingRetries], [1, 1]);
  f.advance(20 * MIN);
  const r = await f.exec.tick();
  assert.notEqual(f.queue.row(1).state, 'RUNNING');
  assert.equal(f.queue.row(1).deferred ?? f.queue.row(1).reason, 'WAITING_BUDGET_EXHAUSTED');
  assert.ok(f.queue.notices.some(n => n.kind === 'waiting-budget'), 'the Owner is told once');
  assert.ok(['NOT_EXECUTED', 'IDLE', 'DEFERRED'].includes(r.state));
});

test('the breaker: three counted failures open it; nothing starts until the trial, which never picks the rows that failed', async t => {
  const burn = { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN };
  const engine = perPr({ 1: burn, 2: burn, 3: burn });
  const f = await executorFixture(t, { engine });
  for (const n of [1, 2, 3, 4]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
  for (const n of [1, 2, 3]) assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN', `PR ${n}`);
  assert.equal(f.queue.breaker.state, 'open');
  assert.ok((await receiptTypes(f)).includes('breaker-opened'));
  assert.deepEqual((await f.exec.tick()), { state: 'DEFERRED', reason: 'BREAKER_OPEN', until: f.queue.breaker.nextTrialAt });
  f.advance(30 * MIN);
  const trial = await f.exec.tick();
  assert.equal(trial.state, 'COMPLETED', 'PR 4 is the trial and passes');
  assert.equal(f.queue.breaker.state, 'closed');
  assert.ok((await receiptTypes(f)).includes('breaker-closed'));
});

test('a newer commit before stage 1 releases the batch as SUPERSEDED: nothing burned, the newer commit runs next', async t => {
  const f = await executorFixture(t);
  const bundle = f.companion.buildBundle;
  let once = true;
  f.companion.buildBundle = async b => { if (once) { once = false; await f.drop(triggerBytes({ headSha: H(7) })); } return bundle(b); };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.release], ['NOT_EXECUTED', BATCH_SUPERSEDED, 'SUPERSEDED']);
  assert.deepEqual(stagesRun(f.engine), [], 'stage 1 never ran');
  assert.equal(await f.ledger.headBurned(headKey(subject())), false);
  assert.deepEqual([f.queue.row(884).current.headSha, f.queue.row(884).superseded.map(c => c.headSha)], [H(7), [HEAD]]);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(await f.ledger.headBurned(headKey(subject({ headSha: H(7) }))), true);
  assert.equal((await f.ledger.usage(0)).evaluations, 0, 'a supersession is no evaluation');
});

test('after stage 1 only a live read ends a superseded batch: SUPERSEDED_AT_SAFE_POINT, archived, burned, never an attempt 2', async t => {
  const run = (pull) => async t2 => {
    const engine = fakeEngine();
    const base = engine.runStage;
    let f;
    engine.runStage = async (batch, stage, o) => { if (stage.number === 1) await f.drop(triggerBytes({ headSha: H(7) })); return base(batch, stage, o); };
    f = await executorFixture(t2, { engine, companion: fakeCompanion({ pull }) });
    await f.drop(triggerBytes());
    return { f, r: await f.exec.tick() };
  };
  // confirmed: the PR's head is the newer commit
  const confirmed = await run(pr => ({ number: pr, state: 'open', headSha: H(7) }))(t);
  assert.deepEqual([confirmed.r.state, confirmed.r.failureCode, confirmed.r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'before-relay-plan']);
  assert.deepEqual(stagesRun(confirmed.f.engine), [1]);
  assert.deepEqual(confirmed.f.engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), [SUPERSEDED_ARCHIVE_REASON]);
  assert.equal(await confirmed.f.ledger.headBurned(headKey(subject())), true);
  assert.equal(await confirmed.f.executedHeads.published(subject()), false, 'nothing after stage 1 published');
  assert.deepEqual(await confirmed.f.ledger.pendingAttempts2(), []);
  assert.equal(confirmed.f.queue.breaker?.state ?? 'closed', 'closed');
  assert.equal((await confirmed.f.exec.tick()).state, 'COMPLETED', 'the newer commit runs');
  // disproved: the live head is still the running one; the batch goes on and the stale newer commit is set aside
  const disproved = await run(pr => ({ number: pr, state: 'open', headSha: HEAD }))(t);
  assert.equal(disproved.r.state, 'COMPLETED');
  assert.deepEqual([disproved.f.queue.row(884).current.headSha, disproved.f.queue.row(884).state], [HEAD, 'DONE']);
  assert.ok(disproved.f.queue.row(884).superseded.some(c => c.headSha === H(7)));
  // no answer: never a reason to stop a started batch
  const silent = await run(() => null)(t);
  assert.equal(silent.r.state, 'COMPLETED');
  assert.ok((await receiptTypes(silent.f)).includes('supersede-unconfirmed'));
});

test('falsification: stage 1 sees the PR changed; the live head, one of its superseded commits, is restored and runs', async t => {
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 1 && batch.key === batchKey(subject({ headSha: H(1) }))
    ? (engine.calls.push(['stage', 1]), { ok: false, code: 'PR_NOT_OPEN_OR_CHANGED', proof: WINDOWS_CLEAN }) : base(batch, stage, o));
  const f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(2) }) }) });
  await f.drop(triggerBytes({ headSha: H(2) }));   // the real head, proposed first
  await f.drop(triggerBytes({ headSha: H(1) }));   // a stale older one, never seen: it replaces it
  assert.equal((await f.exec.tick()).failureCode, 'PR_NOT_OPEN_OR_CHANGED');
  assert.deepEqual([f.queue.row(884).current.headSha, f.queue.row(884).origin], [H(2), 'restored']);
  assert.ok((await receiptTypes(f)).includes('queue-restored'));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('an attempt 2 whose PR moved on is voided once a live read confirms it', async t => {
  let n = 0;
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage, o));
  const f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  await f.drop(triggerBytes({ headSha: H(7) }));
  f.advance(10 * MIN);
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', 'the newer commit runs instead');
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  assert.ok((await fs.readdir(path.join(f.root, 'state', 'ledger-attempt2'))).some(x => x.endsWith('.closed.json')));
});

test('the queue survives a restart; a row left running by a crash follows the ledger', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes());
  await f.drop(triggerBytes({ pr: 900, headSha: H(4) }));
  await f.exec.intake();
  assert.deepEqual(f.queue.candidates(f.clock()).map(c => c.pr), [884, 900]);
  // a reservation made, the queue written, then the process died before the batch ran: recovery closes the entry
  const k = batchKey(subject());
  await f.ledger.reserve(k, subject());
  f.queue.begin(884, HEAD, k, 'queued', f.clock());
  await f.queue.save();
  const queue = await RunQueue.open(path.join(f.root, 'state', 'queue'), f.clock);
  const exec = new ResidentExecutor({ ...f.ports, queue });
  assert.equal((await exec.tick()).state, 'HALTED', 'the open entry is a crash scene');
  assert.deepEqual([queue.row(884).state, queue.row(884).running], ['STOPPED', null], 'the ledger closed it: the row follows');
  assert.equal(queue.row(900).state, 'QUEUED');
});

// ---- independent review of step 1: the gaps it named ----

test('review M1: the executor\'s own end writes its record first; a crash in the middle is SUPERSEDE_INTERRUPTED, never a resumed wait', async t => {
  const f = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => null, pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  const key = batchKey(subject());
  // the process dies right after the record (simulated: the record is written, nothing else happens)
  await f.ledger.beginSelfAbort(key, { safePoint: 'before-relay-plan', liveHeadSha: H(7), liveState: 'open' });
  const fresh = new ResidentExecutor(f.ports);
  const r = await fresh.tick();
  assert.equal(r.state, 'HALTED');
  assert.equal((await f.ledger.halted()).value.code, 'SUPERSEDE_INTERRUPTED');
  assert.deepEqual([(await f.ledger.state(key)).outcome, (await f.ledger.state(key)).terminal.facts.failureCode], ['FAILED_UNKNOWN', 'SUPERSEDE_INTERRUPTED']);
});

test('review M1: quiescence that cannot be proven at the executor\'s own end HALTs, exactly like the Owner abort', async t => {
  const engine = fakeEngine();
  const base = engine.runStage;
  let f;
  engine.runStage = async (batch, stage, o) => { if (stage.number === 1) await f.drop(triggerBytes({ headSha: H(7) })); return base(batch, stage, o); };
  f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H(7) }), linux: { linuxUnitsInactive: false, containersZero: true } }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'HALTED');
  assert.equal((await f.ledger.halted()).value.code, 'SUPERSEDE_QUIESCENCE_UNPROVEN');
  assert.equal(engine.calls.some(c => c[0] === 'archive-windows'), false, 'the scene is left as it is');
});

test('supersession at the before-workspace safe point (after stage R) and during a hosted wait', async t => {
  // a newer commit arrives while stage R runs: caught before the workspace, after the plan was written
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => localRow(r)) }) });
  const relay = engine.runRelayStage.bind(engine);
  let f;
  engine.runRelayStage = async (batch, roles) => { await f.drop(triggerBytes({ headSha: H(7) })); return relay(batch, roles); };
  f = await executorFixture(t, { engine, policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }), pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'before-workspace']);
  assert.deepEqual(stagesRun(engine), [1, 9]);
  // during a hosted wait: the next resume sees the newer commit and the live read confirms it
  const g = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => null, pull: pr => ({ number: pr, state: 'open', headSha: H(7) }) }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  await g.drop(triggerBytes({ headSha: H(7) }));
  g.advance(60_000);
  const w = await g.exec.tick();
  assert.deepEqual([w.state, w.failureCode, w.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'before-relay-plan']);
});

test('review M2: attempt 2 runs when the live read disproves the newer commit, or gives no answer; the stale commit is set aside', async t => {
  for (const pull of [pr => ({ number: pr, state: 'open', headSha: HEAD }), () => null]) {
    let n = 0;
    const engine = fakeEngine();
    const base = engine.runStage;
    engine.runStage = async (batch, stage, o) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage, o));
    const f = await executorFixture(t, { engine, companion: fakeCompanion({ pull }) });
    await f.drop(triggerBytes());
    assert.ok((await f.exec.tick()).attempt2);
    await f.drop(triggerBytes({ headSha: H(7) })); // a stale or forged trigger
    f.advance(10 * MIN);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.key], ['COMPLETED', batchKey(subject({ attempt: 2 }))], String(pull));
    if (pull(884)) assert.ok(f.queue.row(884).superseded.some(c => c.headSha === H(7)), 'the disproved commit is set aside');
  }
});

test('review m4: the release cap holds across a queue that started over; the rebuilt breaker starts half-open', async t => {
  const engine = fakeEngine({ stages: { 1: notAdmitted() } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  f.advance(10 * MIN + 1);
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  assert.equal(f.queue.row(884).state, 'STOPPED');
  await fs.writeFile(path.join(f.root, 'state', 'queue', 'queue.json'), '{"not":"a queue"}');
  const queue = await RunQueue.open(path.join(f.root, 'state', 'queue'), f.clock);
  assert.equal(queue.breaker.state, 'half-open');
  const exec = new ResidentExecutor({ ...f.ports, queue });
  await f.drop(triggerBytes()); // the poller proposes the head again after the new generation
  f.advance(10 * MIN + 1);
  const r = await exec.tick();
  assert.equal(r.reason, 'RELEASE_CAP_REACHED');
  assert.equal(queue.row(884).state, 'STOPPED');
  assert.deepEqual(stagesRun(engine), [1, 1], 'never a third evaluation');
  assert.ok((await receiptTypes(f)).includes('queue-rebuilt'));
});

test('the breaker closing lifts rows the release cap stopped because of an environment fault', async t => {
  const broker = { ok: false, code: 'BROKER_REQUEST_EXPIRED', proof: WINDOWS_CLEAN, outcome: null, brokerNoLaunch: true };
  const burn = { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN };
  const per = { 1: broker };
  const engine = perPr(per);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  await f.exec.tick();
  f.advance(10 * MIN + 1);
  await f.exec.tick();
  assert.deepEqual([f.queue.row(1).state, f.queue.row(1).stopClass], ['STOPPED', 'environment']);
  // the two broker releases plus one more counted failure open the breaker
  per[2] = burn;
  await f.drop(triggerBytes({ pr: 2, headSha: H(2) }));
  await f.exec.tick();
  assert.equal(f.queue.breaker.state, 'open');
  delete per[1];
  await f.drop(triggerBytes({ pr: 3, headSha: H(3) }));
  f.advance(30 * MIN);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'the trial (PR 3) completes');
  assert.equal(f.queue.breaker.state, 'closed');
  assert.equal(f.queue.row(1).state, 'BACKOFF', 'the environment stop is lifted');
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'and PR 1 runs');
});

test('the re-evaluation cap per (PR, commit) and the evaluation budget at the executor; a full budget never starves a due wait', async t => {
  const engine = perPr({ 1: notAdmitted('NATIVE_NOT_ADMITTED', WAIT), 2: notAdmitted() });
  const f = await executorFixture(t, { engine, policy: rawPolicy({ limits: { ...rawPolicy().limits, reevaluationsPerPrHeadPer24h: 1, maxEvaluationsPer24h: 2 } }) });
  await f.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  await f.exec.tick();                                  // evaluation 1: PR 1 waits
  await f.drop(triggerBytes({ pr: 2, headSha: H(2) }));
  await f.exec.tick();                                  // evaluation 2: PR 2 released (back-off)
  // a poke of PR 2 (an Agent's trigger) now meets the full evaluation budget; the due wait of PR 1 still runs
  f.advance(10 * MIN + 1);
  await f.drop(triggerBytes({ pr: 2, headSha: H(2) }));
  const r = await f.exec.tick();
  assert.equal(r.state, 'NOT_ADMITTED', 'PR 1 waiting retry ran');
  assert.equal(f.queue.row(1).origin, 'waiting-retry');
  // the cap of 1 new-trigger re-evaluation per (PR, commit)
  const g = await executorFixture(t, { engine: perPr({ 1: notAdmitted('NATIVE_NOT_ADMITTED', WAIT) }), policy: rawPolicy({ limits: { ...rawPolicy().limits, reevaluationsPerPrHeadPer24h: 1 } }) });
  await g.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  await g.exec.tick();
  g.advance(10 * MIN + 1);
  const at = (await g.ledger.usage(0)).reevaluations.get(`1:${H(1)}`) ?? 0;
  assert.equal(at, 0);
  // first the waiting retry is due: move it out of the way with a long ci wait, then poke twice
  g.queue.row(1).nextAt = g.clock() + 5 * 60 * MIN;
  await g.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  assert.equal((await g.exec.tick()).state, 'NOT_ADMITTED', 'the first poke re-evaluates');
  g.queue.row(1).nextAt = g.clock() + 5 * 60 * MIN;
  g.advance(10 * MIN + 1);
  await g.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  const capped = await g.exec.tick();
  assert.equal(g.queue.row(1).deferred ?? g.queue.row(1).reason, 'REEVALUATION_CAP');
  assert.notEqual(capped.state, 'NOT_ADMITTED');
});

test('the daily execution limit defers without dropping, tells the Owner once, and the row runs the next day', async t => {
  const f = await executorFixture(t, { policy: rawPolicy({ limits: { ...rawPolicy().limits, maxBatchesPer24h: 1 } }) });
  await f.drop(triggerBytes({ pr: 1, headSha: H(1) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  await f.drop(triggerBytes({ pr: 2, headSha: H(2) }));
  assert.equal((await f.exec.tick()).reason, 'DAILY_BATCH_LIMIT');
  assert.equal((await f.exec.tick()).reason, 'DAILY_BATCH_LIMIT');
  assert.equal(f.queue.notices.filter(n => n.kind === 'batch-limit').length, 1);
  assert.equal(f.queue.row(2).state, 'QUEUED', 'never dropped');
  f.advance(24 * 60 * MIN + 1);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('review m6: triggers stay in the inbox when the queue cannot be written', async t => {
  const f = await executorFixture(t);
  f.queue.save = async () => { throw new Error('locked'); };
  await f.drop(triggerBytes());
  await f.exec.intake();
  assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 1);
});

test('re-review N2: refused triggers never wait for the queue; a queue that cannot be written is told once', async t => {
  const f = await executorFixture(t);
  f.queue.save = async () => { throw new Error('locked'); };
  await f.drop(Buffer.from('{not json'));
  await f.drop(triggerBytes());
  for (let i = 0; i < 4; i++) await f.exec.intake();
  assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 1, 'the unparseable one is gone, the good one waits');
  assert.equal(f.queue.notices.filter(n => n.kind === 'queue-unsaved').length, 1);
  assert.equal((await receiptTypes(f)).filter(x => x === 'queue-save-failed').length, 1);
});
