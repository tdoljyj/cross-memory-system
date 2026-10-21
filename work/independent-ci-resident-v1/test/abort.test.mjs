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
import { BASE, HEAD, RELAY_ON, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

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
// A batch that waits for hosted signals (relay on, no hint yet): safe point P0 at every tick start.
async function waitingBatch(t, companion = fakeCompanion({ hint: () => null })) {
  const f = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion });
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
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN }), true);
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: { windowsTreeZero: false, serviceOriginalStopped: true } }), false);
  assert.equal(abortStageEndingClean({ ok: false, code: 'STAGE_OUTCOME_MISSING', proof: {} }), false, 'never without the stage\'s own Windows proof');
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
  // The same head never runs again, whatever trigger names it.
  await f.drop(triggerBytes({ baseSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('an abort during a scanner-issuer stage stops it through the broker and helper stop path, then FAILED_CLEAN OWNER_ABORTED', async t => {
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async (batch, number) => { engine.calls.push(['request-stop', number, batch.key]); stopAsked(); return { pump: true, broker: true, requestId: '0a1b2c3d-0000-4000-8000-000000000001' }; };
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
  assert.deepEqual([s.terminal.facts.stage, s.terminal.facts.stageCode, s.abort.safePoint], [2, 'STAGE_OUTCOME_MISSING', 'in-stage-2']);
  assert.deepEqual((await bodies(f, 'owner-abort-stop-requested')).map(b => [b.stage, b.pump]), [[2, true]]);
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
  const companion = fakeCompanion({ hint: () => null, linux: busy });
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
  const companion = fakeCompanion({ hint: () => null });
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
  engine.requestStop = async () => { stopAsked(); return { pump: true, broker: true, requestId: null }; };
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
  assert.deepEqual(view.abortTargets, [{ batchKey: KEY, state: 'STARTED', waiting: true, aborting: false, latestLedgerEntry: '15-relay-wait.json', ledgerEntrySha256: latest.sha256 }]);
  assert.equal(view.openBatches, 1);
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
