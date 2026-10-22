// The executor on its run queue (resident quota redesign phase 2, step 1: design v0.5 §4.2-§4.7, §7): scheduling order,
// the budgets from the ledger, waits, the breaker, supersession at the safe points, falsification and restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, SUPERSEDED_AT_SAFE_POINT, SUPERSEDED_ARCHIVE_REASON, BATCH_SUPERSEDED } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { RunQueue } from '../src/queue.mjs';
import { BASE, HEAD, SAFE_REFUSAL, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';

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
