// Owner abort of the current batch (DESIGN §6.5): honoured only at safe points, a running scanner-issuer stage is
// stopped through its own stop path, then quiescence on both hosts, a rename-only archive and FAILED_CLEAN
// OWNER_ABORTED. Nothing is published, retracted, re-run or killed; unproven quiescence HALTs exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ABORT_CONTRACT, ABORT_QUIESCENCE_ATTEMPTS, OWNER_ABORT_ARCHIVE_REASON, ResidentExecutor, validateAbortRequest } from '../src/executor.mjs';
import { ABORTABLE_IN_FLIGHT, OWNER_ABORTED, OWNER_ABORT_STAGE_ENDINGS, UNKNOWN_CODES, abortStageEndingClean } from '../src/classify.mjs';
import { FIXED_STAGES } from '../src/policy.mjs';
import { Ledger, batchKey, headKey } from '../src/ledger.mjs';
import { abortRequest, inspect, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, holdAtA, triggerBytes } from './helpers.mjs';

const OWNER = 'S-1-5-21-1-2-3-1001';
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const types = async f => (await f.receipts.entries()).map(e => e.type);
async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}
// The Owner's two steps: read the latest ledger record of the batch, then write the elevated request naming it.
async function ownerAborts(f, key = KEY, { reason = 'stage stuck', sha } = {}) {
  const latest = await f.ledger.latestRecord(key);
  return writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: key, expectedLedgerEntrySha256: sha ?? latest.sha256, reason, by: OWNER }, f.clock), f.clock);
}
// A batch resting at parking point A (helpers.mjs#holdAtA): safe point P0 at every tick start.
async function waitingBatch(t, companion = fakeCompanion({})) {
  const f = await executorFixture(t, { companion });
  holdAtA(f.exec);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  return f;
}

test('the request contract: exact keys and bounds; the scanner-issuer stages are the only ones stopped in flight', () => {
  const v = abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: 'd'.repeat(64), reason: 'stuck', by: OWNER });
  assert.deepEqual(Object.keys(v).sort(), ['batchKey', 'by', 'contract', 'ledgerEntrySha256', 'nonce', 'reason', 'requestedAt']);
  assert.equal(v.contract, ABORT_CONTRACT);
  for (const bad of [{ ...v, extra: 1 }, { ...v, batchKey: 'x' }, { ...v, ledgerEntrySha256: 'D'.repeat(64) }, { ...v, by: 'S-1-5-18' }, { ...v, nonce: 'zz' }, { ...v, reason: '' }, { ...v, reason: 'r'.repeat(201) }])
    assert.throws(() => validateAbortRequest(bad), { code: 'OWNER_REQUEST_REFUSED' }, JSON.stringify(bad));
  assert.throws(() => abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: 'd'.repeat(64), reason: 'x', by: 'nobody' }), { code: 'OWNER_SID_REQUIRED' });
  // The issuer stages are exactly the Linux-worker stages of the fixed batch; publishers, stage 8 and stage R are not.
  assert.deepEqual([...ABORTABLE_IN_FLIGHT], FIXED_STAGES.filter(s => s.linuxWorker).map(s => s.number));
  // The allow-listed endings of a stopped stage never include an ending that may leave a publication or a process.
  for (const code of ['STAGE_HELPER_NOT_STOPPED_IN_TIME', 'STAGE_ORIGINAL_NOT_RESTORED', 'STAGE_CHILD_TREE_UNCONFIRMED', 'PUBLICATION_UNCERTAIN',
    'BROKER_CONFIGURATION_CONFLICT', 'BROKER_RESPONSE_UNCONFIRMED', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 'COMPANION_PUMP_UNCONFIRMED']) assert.ok(!OWNER_ABORT_STAGE_ENDINGS.includes(code), code);
  assert.deepEqual(UNKNOWN_CODES.filter(c => OWNER_ABORT_STAGE_ENDINGS.includes(c)), ['STAGE_OUTCOME_MISSING'], 'only the stopped entry\'s missing outcome is admitted from the unknown list');
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN }, { stopSent: true }), true);
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN }), false, 'a missing outcome only after the broker sent the stop');
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: { windowsTreeZero: false, serviceOriginalStopped: true } }, { stopSent: true }), false);
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: {} }, { stopSent: true }), false, 'never without the stage\'s own Windows proof');
  assert.equal(abortStageEndingClean({ ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE', proof: WINDOWS_CLEAN }), true, 'a clean ending needs no stop');
});

test('a batch waiting for hosted signals is aborted at the next tick start: FAILED_CLEAN OWNER_ABORTED, archived rename-only, nothing else ran', async t => {
  const f = await waitingBatch(t);
  const latest = await f.ledger.latestRecord(KEY);
  assert.equal(latest.name, '15-relay-wait.json');
  await ownerAborts(f);
  const r = await f.exec.tick();
  assert.equal(r.state, 'IDLE', 'the tick goes on after the abort');
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.state, s.outcome, s.terminal.facts.failureCode, s.terminal.facts.safePoint, s.terminal.facts.basis],
    ['TERMINAL', 'FAILED_CLEAN', OWNER_ABORTED, 'waiting', 'owner-abort-quiescence-proven']);
  assert.equal(s.abort.requestSha256, s.terminal.facts.requestSha256, 'the accepted request is the one recorded');
  assert.deepEqual(stagesRun(f.engine), [1], 'no stage R, no local stage, no publication after the abort');
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), [OWNER_ABORT_ARCHIVE_REASON]);
  assert.deepEqual(f.companion.calls.filter(c => c[0] === 'archive-linux').map(c => c[1]), [OWNER_ABORT_ARCHIVE_REASON]);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true, 'the head stays burned');
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual((await bodies(f, 'owner-request')).map(b => [b.kind, b.outcome, b.failureCode]), [['abort', 'FAILED_CLEAN', OWNER_ABORTED]]);
  assert.ok((await types(f)).includes('owner-abort-accepted'));
  assert.equal((await f.ledger.pendingAttempts2()).length, 0, 'never an attempt 2');
  // The same head never runs again, whatever trigger names it (its own PR's row has seen it; another PR is refused by the ledger).
  await f.drop(triggerBytes({ baseSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'IDLE');
  await f.drop(triggerBytes({ pr: 990, baseSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('an abort during a scanner-issuer stage stops it through the broker and helper stop path, then FAILED_CLEAN OWNER_ABORTED', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async (batch, number) => { engine.calls.push(['request-stop', number, batch.key]); stopAsked(); return { broker: true, requestId: '0a1b2c3d-0000-4000-8000-000000000001', stopCode: 'STOP_SENT', pump: true, done: true }; };
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number !== 2) return { ok: true };
    // Stage 2 hangs (the 2026-10-21 refused relay); the Owner looks and writes the abort while it runs. The stage
    // ends only once it was asked to stop: the helper drained its own job, the entry wrote no outcome.
    assert.equal((await f.ledger.latestRecord(batch.key)).name, '25-plan.json', 'stages write no ledger record: the reviewed digest stays valid');
    await ownerAborts(f, batch.key);
    await asked;
    return { ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN };
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', OWNER_ABORTED, 'in-stage-2']);
  assert.deepEqual(stagesRun(engine), [1, 2], 'stages 3..8 never ran: nothing was published after the abort');
  assert.deepEqual(engine.calls.filter(c => c[0] === 'request-stop').map(c => [c[1], c[2]]), [[2, KEY]], 'asked once, for this batch\'s stage 2');
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.terminal.facts.stage, s.terminal.facts.stageCode, s.terminal.facts.stopCode, s.abort.safePoint], [2, 'STAGE_OUTCOME_MISSING', 'STOP_SENT', 'in-stage-2']);
  assert.deepEqual((await bodies(f, 'owner-abort-stop-requested')).map(b => b.stage), [2]);
  assert.deepEqual((await bodies(f, 'stage-terminal')).map(b => [b.stage, b.ok]), [[1, true], [2, false]]);
  assert.ok(!engine.calls.some(c => /kill|retract|publish/i.test(String(c[0]))), 'the engine was never asked to kill, publish or retract');
});

test('a publishing stage is never interrupted: an abort written during stage 3 takes the safe point before stage 4', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number === 3) await ownerAborts(f, batch.key);
    return { ok: true };
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', OWNER_ABORTED, 'before-stage-4']);
  assert.deepEqual(stagesRun(engine), [1, 2, 3], 'stage 3 ran to its own end; stage 4 never started');
  assert.equal(engine.calls.filter(c => c[0] === 'request-stop').length, 0, 'nothing was stopped');
});

test('an abort naming a stale ledger digest is refused and the batch goes on', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number === 1) await ownerAborts(f, batch.key, { sha: 'e'.repeat(64) });
    return { ok: true };
  };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_LEDGER_CHANGED_SINCE_REVIEW']);
  assert.ok(!(await types(f)).includes('owner-abort-accepted'));
});

test('quiescence that cannot be proven HALTs exactly as before: FAILED_UNKNOWN, scene untouched, bounded re-check', async t => {
  const busy = { linuxUnitsInactive: false, containersZero: true };
  const companion = fakeCompanion({ linux: busy });
  const f = await waitingBatch(t, companion);
  await ownerAborts(f);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'OWNER_ABORT_QUIESCENCE_UNPROVEN']);
  assert.equal((await f.ledger.halted()).value.code, 'OWNER_ABORT_QUIESCENCE_UNPROVEN');
  assert.equal(companion.calls.filter(c => c[0] === 'quiescence').length, ABORT_QUIESCENCE_ATTEMPTS, 'a bounded re-check, then HALT');
  assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length + companion.calls.filter(c => c[0] === 'archive-linux').length, 0, 'nothing archived');
  // The Owner's ordinary re-arm then archives it once Linux is quiet.
  busy.linuxUnitsInactive = true;
  const { rearmRequest } = await import('../tools/rearm-tool.mjs');
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: (await f.ledger.halted()).sha256, reason: 'looked', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), ['rearm-unknown-failure']);
});

test('quiescence that comes within the bounded re-check is enough', async t => {
  let left = 2;
  const companion = fakeCompanion({});
  companion.linuxQuiescence = async () => { companion.calls.push(['quiescence']); left -= 1; return { linuxUnitsInactive: left < 0, containersZero: true }; };
  const f = await waitingBatch(t, companion);
  await ownerAborts(f);
  await f.exec.tick();
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_CLEAN');
  assert.equal(companion.calls.filter(c => c[0] === 'quiescence').length, 3);
});

test('a stopped stage that did not end cleanly is UNKNOWN: HALT with the stage\'s own code', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async () => { stopAsked(); return { broker: false, requestId: null, stopCode: null, pump: false, done: false }; };
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number !== 4) return { ok: true };
    await ownerAborts(f, batch.key);
    await asked;
    return { ok: false, code: 'STAGE_HELPER_NOT_STOPPED_IN_TIME', proof: { windowsTreeZero: false, serviceOriginalStopped: false } };
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'STAGE_HELPER_NOT_STOPPED_IN_TIME']);
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_UNKNOWN');
  assert.equal(engine.calls.filter(c => c[0] === 'archive-windows').length, 0, 'the scene stays for the Owner');
});

test('an abort for a batch that already ended is refused at the next tick; nothing changes', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  const plan = await fs.readFile(path.join(f.root, 'state', 'ledger', KEY, '25-plan.json'));
  await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: (await import('node:crypto')).createHash('sha256').update(plan).digest('hex'), reason: 'too late', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_BATCH_NOT_OPEN']);
  assert.equal((await f.ledger.state(KEY)).outcome, 'COMPLETED');
});

test('an abort leaves HALT as it is: a waiting batch is aborted while halted, and HALT stays latched', async t => {
  const f = await waitingBatch(t);
  await f.ledger.halt('X_Y', {});
  await ownerAborts(f);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_CLEAN');
  assert.equal((await f.ledger.halted()).value.code, 'X_Y', 'only a re-arm clears HALT');
});

test('a service that dies in the middle of an abort leaves a crash scene: never resumed, FAILED_UNKNOWN OWNER_ABORT_INTERRUPTED + HALT', async t => {
  const f = await waitingBatch(t);
  await f.ledger.beginOwnerAbort(KEY, { requestSha256: 'f'.repeat(64), ledgerEntrySha256: (await f.ledger.latestRecord(KEY)).sha256, by: OWNER, reason: 'x', safePoint: 'waiting', stage: null });
  assert.equal(Ledger.resumable({ ...(await f.ledger.state(KEY)) }), false);
  assert.equal(await f.ledger.latestRecord(KEY), null, 'an aborting batch offers no new target');
  const restarted = new ResidentExecutor(f.ports);
  assert.equal((await restarted.tick()).state, 'HALTED');
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'OWNER_ABORT_INTERRUPTED']);
  assert.equal((await f.ledger.halted()).value.code, 'OWNER_ABORT_INTERRUPTED');
  assert.deepEqual(stagesRun(f.engine), [1], 'the waiting batch was not continued');
});

test('a copy of a handled abort under another name is a duplicate, never acted on twice', async t => {
  const f = await waitingBatch(t);
  const file = await ownerAborts(f);
  await f.exec.tick();
  const bytes = await fs.readFile(file);
  f.advance(1);
  await fs.writeFile(path.join(f.root, 'owner', `${String(f.clock()).padStart(13, '0')}-aaaaaaaaaaaa.json`), bytes);
  await f.exec.tick();
  assert.ok((await types(f)).includes('owner-request-duplicate'));
});

test('inspect lists every open batch with the exact values an abort names', async t => {
  const f = await waitingBatch(t);
  const view = await inspect({ ledger: f.ledger, receipts: f.receipts });
  const latest = await f.ledger.latestRecord(KEY);
  assert.deepEqual(view.abortTargets, [{ batchKey: KEY, state: 'STARTED', waiting: true, parked: false, aborting: false, latestLedgerEntry: '15-relay-wait.json', ledgerEntrySha256: latest.sha256 }]);
  assert.equal(view.openBatches, 1);
});

// ---- independent review of v0.8: M1, M2, M5, M6 and the untested paths of M7 ----

test('an acceptance that fails half-way at a tick start HALTs in that tick: no other batch starts behind it (review M1)', async t => {
  const f = await waitingBatch(t);
  await ownerAborts(f);
  await f.drop(triggerBytes({ pr: 885, headSha: '7'.repeat(40) }));
  const remember = f.exec.owner.remember.bind(f.exec.owner);
  let failed = false;
  f.exec.owner.remember = async (...a) => { if (!failed) { failed = true; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } return remember(...a); };
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.basis], ['FAILED_UNKNOWN', 'owner-abort-unconfirmed']);
  assert.deepEqual((await bodies(f, 'owner-request')).map(b => [b.kind, b.outcome]), [['abort', 'HALTED']], 'accepted, then closed UNKNOWN: no refusal');
  assert.equal((await bodies(f, 'owner-request-refused')).length, 0);
  assert.deepEqual(stagesRun(f.engine), [1], 'PR 885 was not reserved, nothing else ran');
  assert.equal((await f.ledger.open()).length, 0);
});

test('the gate: an acceptance that fails half-way and whose UNKNOWN close cannot even latch HALT still runs no other batch (review M1)', async t => {
  const f = await waitingBatch(t);
  await ownerAborts(f);
  await f.drop(triggerBytes({ pr: 885, headSha: '7'.repeat(40) }));
  const remember = f.exec.owner.remember.bind(f.exec.owner);
  const halt = f.ledger.halt.bind(f.ledger);
  let r1 = false, h1 = false;
  f.exec.owner.remember = async (...a) => { if (!r1) { r1 = true; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } return remember(...a); };
  // The first HALT write (inside unknown()) fails, so only the gate after takeOwnerRequests can stop this tick.
  f.ledger.halt = async (...a) => { if (!h1) { h1 = true; throw Object.assign(new Error('disk'), { code: 'EIO' }); } return halt(...a); };
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.deepEqual(stagesRun(f.engine), [1], 'PR 885 was not reserved');
  assert.equal((await f.ledger.state(KEY)).state, 'STARTED', 'still open: recovery closes it on the next tick');
  const h = await f.ledger.halted();
  assert.deepEqual([h.value.code, h.value.facts.keys], ['OWNER_ABORT_UNCONFIRMED', [KEY]]);
  assert.equal((await bodies(f, 'owner-abort-unconfirmed')).length, 1, 'an accepted, unconcluded abort is no refusal');
  assert.equal((await bodies(f, 'owner-request-refused')).length, 0);
  await f.exec.tick();
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'OWNER_ABORT_INTERRUPTED']);
  assert.deepEqual(stagesRun(f.engine), [1]);
});

test('a second, different abort of a batch whose abort is already accepted is refused (OWNER_ABORT_ALREADY_ACCEPTED)', async t => {
  const f = await waitingBatch(t);
  await f.ledger.beginOwnerAbort(KEY, { requestSha256: 'f'.repeat(64), ledgerEntrySha256: (await f.ledger.latestRecord(KEY)).sha256, by: OWNER, reason: 'first', safePoint: 'waiting', stage: null });
  const v = abortRequest({ batchKey: KEY, expectedLedgerEntrySha256: 'd'.repeat(64), reason: 'second', by: OWNER }, f.clock);
  await assert.rejects(f.exec.abortAtTickStart(v, 'e'.repeat(64), '0000000000001-aaaaaaaaaaaa.json'), { code: 'OWNER_ABORT_ALREADY_ACCEPTED' });
});

test('inside a tick, a different abort of a batch whose abort is already accepted is refused (OWNER_ABORT_ALREADY_ACCEPTED)', async t => {
  const f = await waitingBatch(t);
  const latest = await f.ledger.latestRecord(KEY);
  await ownerAborts(f);
  await f.ledger.beginOwnerAbort(KEY, { requestSha256: 'f'.repeat(64), ledgerEntrySha256: latest.sha256, by: OWNER, reason: 'first', safePoint: 'in-stage-2', stage: 2 });
  assert.equal(await f.exec.pendingAbort(KEY), null);
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_ALREADY_ACCEPTED']);
});

test('at a tick start, a different abort of a batch whose acceptance names another request is a refusal, not unconfirmed', async t => {
  const f = await waitingBatch(t);
  await f.ledger.beginOwnerAbort(KEY, { requestSha256: 'f'.repeat(64), ledgerEntrySha256: 'd'.repeat(64), by: OWNER, reason: 'first', safePoint: 'waiting', stage: null });
  await ownerAborts(f, KEY, { sha: 'd'.repeat(64) });
  f.exec.recover = async () => { throw new Error('recovery failed'); }; // the aborting entry stays open for takeOwnerRequests
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_ALREADY_ACCEPTED']);
  assert.equal((await bodies(f, 'owner-abort-unconfirmed')).length, 0);
});

test('a concluded P0 abort whose summary receipt fails is neither refused nor unconfirmed', async t => {
  const f = await waitingBatch(t);
  await ownerAborts(f);
  const receipt = f.exec.receipt.bind(f.exec);
  f.exec.receipt = async (type, body) => { if (type === 'owner-request') throw Object.assign(new Error('disk'), { code: 'EIO' }); return receipt(type, body); };
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_CLEAN');
  assert.equal((await bodies(f, 'owner-abort-unconfirmed')).length + (await bodies(f, 'owner-request-refused')).length, 0);
  assert.equal(await f.ledger.halted(), null);
});

test('an abort accepted by a service that died before remembering it is unconfirmed, not refused, after recovery (final check NIT-1)', async t => {
  const f = await waitingBatch(t);
  const file = await ownerAborts(f);
  const requestSha256 = (await import('node:crypto')).createHash('sha256').update(await fs.readFile(file)).digest('hex');
  // The dead service wrote 80-owner-abort for this very request, then died before it remembered the request.
  await f.ledger.beginOwnerAbort(KEY, { requestSha256, ledgerEntrySha256: (await f.ledger.latestRecord(KEY)).sha256, by: OWNER, reason: 'stage stuck', safePoint: 'waiting', stage: null });
  const restarted = new ResidentExecutor(f.ports);
  assert.equal((await restarted.tick()).state, 'HALTED');
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'OWNER_ABORT_INTERRUPTED']);
  assert.deepEqual((await bodies(f, 'owner-abort-unconfirmed')).map(b => [b.requestSha256, b.failureCode]), [[requestSha256, 'OWNER_ABORT_BATCH_NOT_OPEN']]);
  assert.equal((await bodies(f, 'owner-request-refused')).length, 0);
});

test('a P0 abort whose FAILED_CLEAN conclusion is written but whose batch-terminal receipt fails is never unconfirmed', async t => {
  const f = await waitingBatch(t);
  await ownerAborts(f);
  const receipt = f.exec.receipt.bind(f.exec);
  f.exec.receipt = async (type, body) => { if (type === 'batch-terminal') throw Object.assign(new Error('disk'), { code: 'EIO' }); return receipt(type, body); };
  await f.exec.tick();
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_CLEAN', OWNER_ABORTED]);
  assert.equal((await bodies(f, 'owner-abort-unconfirmed')).length, 0);
});

test('a P0 abort never runs the archive tools from drifted Source bytes', async t => {
  const f = await waitingBatch(t);
  await ownerAborts(f);
  f.exec.sourceIntegrity = async () => ({ ok: false });
  await f.exec.tick();
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_SOURCE_DRIFT']);
  assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length, 0);
});

test('a torn 80-owner-abort written during a stage is UNKNOWN after the stage: no publishing stage runs (second review MINOR 1)', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number === 2) await fs.writeFile(path.join(f.root, 'state', 'ledger', batch.key, '80-owner-abort.json'), '{"key":');
    return { ok: true };
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'OWNER_ABORT_UNCONFIRMED']);
  assert.deepEqual(stagesRun(engine), [1, 2], 'stage 3 (a publisher) never ran');
  // The next tick's recovery quarantines the unreadable entry; the Owner's re-arm archives it as rearm-quarantine.
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(KEY)).state, 'ABSENT');
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  assert.equal((await f.ledger.quarantinedUnarchived()).length, 1);
  const { rearmRequest } = await import('../tools/rearm-tool.mjs');
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: (await f.ledger.halted()).sha256, reason: 'looked at the torn entry', by: OWNER }, f.clock), f.clock);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), ['rearm-quarantine']);
});

test('the stop-requested receipt is written after the stage when the poll could not write it', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async () => { stopAsked(); return { broker: true, requestId: '0a1b2c3d-0000-4000-8000-000000000001', stopCode: 'STOP_SENT', pump: true, done: true }; };
  const receipt = f.exec.receipt.bind(f.exec);
  let failed = false;
  f.exec.receipt = async (type, body) => { if (type === 'owner-abort-stop-requested' && !failed) { failed = true; throw Object.assign(new Error('disk'), { code: 'EIO' }); } return receipt(type, body); };
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number !== 2) return { ok: true };
    await ownerAborts(f, batch.key);
    await asked;
    return { ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN };
  };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).failureCode, OWNER_ABORTED);
  assert.ok(failed, 'the first write failed');
  assert.deepEqual((await bodies(f, 'owner-abort-stop-requested')).map(b => [b.stage, b.requestId]), [[2, '0a1b2c3d-0000-4000-8000-000000000001']]);
});

test('UNKNOWN endings of an abort record its safe point and request digest', async t => {
  // P1: the acceptance itself fails.
  const companion = fakeCompanion();
  const f = await executorFixture(t, { companion });
  let digest;
  companion.buildBundle = async () => { const file = await ownerAborts(f); digest = (await import('node:crypto')).createHash('sha256').update(await fs.readFile(file)).digest('hex'); return { ok: true }; };
  f.ledger.beginOwnerAbort = async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const s = (await f.ledger.state(KEY)).terminal.facts;
  assert.deepEqual([s.failureCode, s.basis, s.safePoint, s.requestSha256], ['RESIDENT_EXECUTOR_EXCEPTION', 'owner-abort-unconfirmed', 'before-stage-1', digest]);
  // ownerAbort: the archive throws after quiescence was proven.
  const g = await waitingBatch(t);
  g.engine.archiveFailure = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await ownerAborts(g);
  assert.equal((await g.exec.tick()).state, 'HALTED');
  const st = await g.ledger.state(KEY);
  assert.deepEqual([st.outcome, st.terminal.facts.basis, st.terminal.facts.safePoint, st.terminal.facts.requestSha256], ['FAILED_UNKNOWN', 'owner-abort-unconfirmed', 'waiting', st.abort.requestSha256]);
});

test('a stage that ends with a missing outcome while the stop was never sent is UNKNOWN: HALT (review M2)', async t => {
  const engine = fakeEngine({ stopCode: 'BROKER_STOP_NOT_THIS_HELPER' });
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async () => { stopAsked(); return { broker: true, requestId: '0a1b2c3d-0000-4000-8000-000000000001', stopCode: 'BROKER_STOP_NOT_THIS_HELPER', pump: false, done: true }; };
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number !== 2) return { ok: true };
    await ownerAborts(f, batch.key);
    await asked;
    return { ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN };
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'STAGE_OUTCOME_MISSING']);
  assert.equal((await f.ledger.state(KEY)).outcome, 'FAILED_UNKNOWN');
  // A clean ending the stage reached on its own still aborts cleanly without STOP_SENT.
  const g = await executorFixture(t, { engine: fakeEngine({ stopCode: null }) });
  let stop2;
  const asked2 = new Promise(resolve => { stop2 = resolve; });
  g.engine.requestStop = async () => { stop2(); return { broker: false, requestId: null, stopCode: null, pump: false, done: false }; };
  g.engine.runStage = async (batch, stage) => {
    g.engine.calls.push(['stage', stage.number]);
    if (stage.number !== 2) return { ok: true };
    await ownerAborts(g, batch.key);
    await asked2;
    return { ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE', proof: WINDOWS_CLEAN };
  };
  await g.drop(triggerBytes());
  assert.deepEqual([(await g.exec.tick()).failureCode, (await g.ledger.state(KEY)).terminal.facts.stopCode], [OWNER_ABORTED, null]);
});

test('an acceptance whose receipt failed during a stage still asks the stage to stop (review M5)', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async (batch, number) => { engine.calls.push(['request-stop', number]); stopAsked(); return { broker: true, requestId: '0a1b2c3d-0000-4000-8000-000000000001', stopCode: 'STOP_SENT', pump: true, done: true }; };
  const receipt = f.exec.receipt.bind(f.exec);
  let failed = false;
  f.exec.receipt = async (type, body) => { if (type === 'owner-abort-accepted' && !failed) { failed = true; throw Object.assign(new Error('disk'), { code: 'EIO' }); } return receipt(type, body); };
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number !== 2) return { ok: true };
    await ownerAborts(f, batch.key);
    await asked;
    return { ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN };
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', OWNER_ABORTED]);
  assert.equal(engine.calls.filter(c => c[0] === 'request-stop').length, 1, 'the stop was requested although the acceptance receipt failed');
});

test('a waiting batch is not aborted while another unarchived scene exists: the full-scope archive never takes it (review M6)', async t => {
  const f = await waitingBatch(t);
  const other = batchKey(subject({ pr: 886, headSha: '8'.repeat(40) }));
  await f.ledger.reserve(other, subject({ pr: 886, headSha: '8'.repeat(40) }));
  await f.ledger.terminal(other, 'FAILED_UNKNOWN', { failureCode: 'X_Y' });
  await ownerAborts(f);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_UNARCHIVED_SCENE_PRESENT']);
  assert.equal(Ledger.resumable(await f.ledger.state(KEY)), true, 'the waiting batch is untouched');
  assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length, 0);
});

test('an abort of another batch read during a stage is left for the next tick, which refuses it', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  const stranger = 'b'.repeat(64);
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number === 2) await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: stranger, expectedLedgerEntrySha256: 'd'.repeat(64), reason: 'wrong batch', by: OWNER }, f.clock), f.clock);
    return { ok: true };
  };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(engine.calls.filter(c => c[0] === 'request-stop').length, 0);
  assert.equal((await bodies(f, 'owner-request-refused')).length, 0, 'not touched inside the batch');
  await f.exec.tick();
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_BATCH_NOT_OPEN']);
});

test('at a tick start after a failed recovery, an open entry that is no waiting batch is refused (OWNER_ABORT_NOT_AT_SAFE_POINT)', async t => {
  const f = await executorFixture(t);
  await f.ledger.reserve(KEY, subject());
  await f.ledger.markStarted(KEY, { batchId: `${KEY.slice(0, 16)}-${'0'.repeat(12)}` });
  await ownerAborts(f);
  f.exec.recover = async () => { throw new Error('recovery failed'); };
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.deepEqual((await bodies(f, 'owner-request-refused')).map(b => b.failureCode), ['OWNER_ABORT_NOT_AT_SAFE_POINT']);
  assert.equal((await f.ledger.state(KEY)).state, 'STARTED', 'nothing was done to it');
});

test('rearm-resident.ps1 -Request Abort writes exactly the fields the service validates, and only lower-case hex', async () => {
  const text = await fs.readFile(new URL('../windows/rearm-resident.ps1', import.meta.url), 'utf8');
  const line = text.split('\n').find(l => l.includes(`contract = '${ABORT_CONTRACT}'`));
  assert.ok(line, 'the abort body is written by the script');
  const keys = [...line.matchAll(/(\w+) = /g)].map(m => m[1]).sort();
  assert.deepEqual(keys, ['batchKey', 'by', 'contract', 'ledgerEntrySha256', 'nonce', 'reason', 'requestedAt']);
  assert.match(text, /\$BatchKey -cnotmatch '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(text, /\$ExpectedLedgerEntrySha256 -cnotmatch '\^\[0-9a-f\]\{64\}\$'/);
});

test('the abort before stage 1 needs the reservation digest and never reaches the admission stage', async t => {
  const engine = fakeEngine();
  const companion = fakeCompanion();
  const f = await executorFixture(t, { engine, companion });
  companion.buildBundle = async () => { companion.calls.push(['bundle']); assert.equal((await f.ledger.latestRecord(KEY)).name, '00-reserved.json'); await ownerAborts(f); return { ok: true }; };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', OWNER_ABORTED, 'before-stage-1']);
  assert.deepEqual(stagesRun(engine), [], 'stage 1 (which publishes work-admission) never ran');
  assert.equal(await f.ledger.headBurned(headKey(subject())), true, 'a stale trigger cannot start the aborted head again');
});
