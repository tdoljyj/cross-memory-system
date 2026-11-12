// DESIGN §27 (design r3 part three, "自动收尾"; Task d2974298) and Owner decision eaa7d5e4 (O-2): a stage-2/4/6 ending that
// would HALT is closed FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED on the Owner abort's quiescence proof; anything unproven HALTs
// as before. The abandonment never reads GitHub, never writes or clears HALT.json and never publishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ABORT_QUIESCENCE_ATTEMPTS, ABORT_QUIESCENCE_POLL_MS, ResidentExecutor, SCANNER_ABANDON_ARCHIVE_REASON } from '../src/executor.mjs';
import { BRIDGE_ABANDONED_UNPUBLISHED, CLEAN_FINAL_CODES, NOT_ADMITTED_CODES, OWNER_ABORTED, OWNER_ABORT_STAGE_ENDINGS, PUMP_CODES_UNPROVABLE, SCANNER_ABANDON_ENDINGS,
  TRANSIENT_CODES, UNKNOWN_CODES, abortStageEndingClean, decideFailure, failureRow, scannerAbandonEligible } from '../src/classify.mjs';
import { ATTEMPT2_RESIDENT_CODES, attempt2Decision } from '../src/attempts.mjs';
import { PUMP_CODES } from '../src/engine-windows.mjs';
import { mayHavePublished } from '../src/executed-heads.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { abortRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, CLEAN_PROOF, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const OWNER = 'S-1-5-21-1-2-3-1001';
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const SWAP = '0a1b2c3d-0000-4000-8000-000000000001';
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}
// The 2026-10-28 #929 ending as the engine now reports it: the pump lost (a relay refused), the stage stopped through its stop path.
const bridge = (o = {}) => ({ pumpCode: 'RELAY_REFUSED_NO_RETRY', stopRequestId: SWAP, stopCode: 'STOP_SENT', stageCode: 'STAGE_OUTCOME_MISSING', pumpQuiet: true, ...o });
const stopped = (o = {}) => ({ ok: false, code: 'BRIDGE_STAGE_STOPPED_PUMP_LOST', proof: WINDOWS_CLEAN, outcome: null, bridge: bridge(o) });

test('the eligibility matrix: stage x code x STOP_SENT x Windows half x quiet pump x pump code (pump code first)', () => {
  const codes = [...SCANNER_ABANDON_ENDINGS, 'STAGE_CHILD_TREE_UNCONFIRMED', 'STAGE_HELPER_NOT_STOPPED_IN_TIME', 'STAGE_ORIGINAL_NOT_RESTORED', 'STAGE_INVOKER_TERMINAL_UNCONFIRMED',
    'BROKER_RESPONSE_UNCONFIRMED', 'EVIDENCE_IDENTITY_CONFLICT', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 'RECONCILIATION_REQUIRED', 'RELAY_PUBLICATION_UNCERTAIN', 'COMPANION_PUMP_CANCELLED',
    'COMPANION_HEARTBEAT_LOST', 'COMPANION_REQUEST_EXPIRED', 'COMPANION_HANDLER_UNCONFIRMED', 'LINUX_WORKER_NOT_STARTED', 'ISSUE_TRANSFER_UNCONFIRMED'];
  let eligible = 0;
  for (const stage of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) for (const code of codes) for (const stopCode of ['STOP_SENT', null, 'BROKER_STOP_NOT_THIS_HELPER'])
    for (const windows of [true, false]) for (const pumpQuiet of [true, false]) for (const pumpCode of [null, 'RELAY_REFUSED_NO_RETRY', 'LINUX_WORKER_NOT_STARTED', ...PUMP_CODES_UNPROVABLE]) {
      const proof = windows ? WINDOWS_CLEAN : { windowsTreeZero: true, serviceOriginalStopped: false };
      const want = [2, 4, 6].includes(stage) && !PUMP_CODES_UNPROVABLE.includes(pumpCode) && SCANNER_ABANDON_ENDINGS.includes(code)
        && (!['STAGE_OUTCOME_MISSING', 'BRIDGE_STAGE_STOPPED_PUMP_LOST'].includes(code) || stopCode === 'STOP_SENT') && windows && pumpQuiet;
      const got = scannerAbandonEligible({ stage, code, proof, bridge: bridge({ stopCode, pumpQuiet, pumpCode }) }).eligible;
      assert.equal(got, want, JSON.stringify({ stage, code, stopCode, windows, pumpQuiet, pumpCode }));
      if (got) eligible += 1;
    }
  assert.ok(eligible > 0);
  // the pump code goes first: an unprovable companion HALTs whatever the stage code says
  for (const pumpCode of PUMP_CODES_UNPROVABLE) for (const code of SCANNER_ABANDON_ENDINGS)
    assert.equal(scannerAbandonEligible({ stage: 2, code, proof: WINDOWS_CLEAN, bridge: bridge({ pumpCode }) }).reason, 'ABANDON_PUMP_UNPROVABLE', code);
  // no bridge facts, a phase other than a stage, a proof field missing: never
  assert.equal(scannerAbandonEligible({ stage: 2, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, bridge: null }).eligible, false);
  assert.equal(scannerAbandonEligible({ stage: 2, phase: 'workspace', code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, bridge: bridge() }).eligible, false);
  assert.equal(scannerAbandonEligible({ stage: 2, code: 'PUBLICATION_UNCERTAIN', proof: { windowsTreeZero: true }, bridge: bridge() }).eligible, false);
  // the lists are the resident's own: none of them is mirrored from the Source (cross-check with the Source arrays)
  const mirrored = new Set([...NOT_ADMITTED_CODES, ...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...UNKNOWN_CODES]);
  for (const code of [BRIDGE_ABANDONED_UNPUBLISHED, 'BRIDGE_STAGE_STOPPED_PUMP_LOST', 'LINUX_WORKER_ENDED_WITHOUT_RECORD', 'LINUX_WORKER_NOT_STARTED', 'COMPANION_HEARTBEAT_LOST', 'RELAY_PARTIAL_RECORD_PRESERVED'])
    assert.equal(mirrored.has(code), false, code);
  for (const code of ['LINUX_WORKER_ENDED_WITHOUT_RECORD', 'LINUX_WORKER_NOT_STARTED', 'COMPANION_HEARTBEAT_LOST']) assert.ok(PUMP_CODES.includes(code), code);
  // every ending it may close HALTs by the table: the abandonment never replaces a clean decision
  for (const code of SCANNER_ABANDON_ENDINGS) for (const stage of [2, 4, 6]) assert.equal(decideFailure({ code, stage, proof: CLEAN_PROOF, started: true }).klass, 'UNKNOWN', `${code}@${stage}`);
});

test('the 10-28 ending at stage 2: two runs again in the batch (DESIGN 59), then FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED, archived scanner-abandoned, no HALT, never published, one attempt 2', async t => {
  const engine = fakeEngine({ stages: { 2: stopped() } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.originalCode], ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED, 'BRIDGE_STAGE_STOPPED_PUMP_LOST']);
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual(stagesRun(engine), [1, 2, 2, 2], 'the run and two runs again; nothing after stage 2 ran');
  const s = await f.ledger.state(KEY);
  const facts = s.terminal.facts;
  assert.deepEqual([s.outcome, facts.failureCode, facts.basis, facts.originalCode, facts.pumpCode, facts.stopCode, facts.stageCode, facts.stage, facts.class, facts.retry, facts.breaker],
    ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED, 'scanner-abandon-quiescence-proven', 'BRIDGE_STAGE_STOPPED_PUMP_LOST', 'RELAY_REFUSED_NO_RETRY', 'STOP_SENT', 'STAGE_OUTCOME_MISSING', 2, 'environment', 'attempt2', 'counts']);
  assert.deepEqual(engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), ['retry-stage-2-1', 'retry-stage-2-2', SCANNER_ABANDON_ARCHIVE_REASON]);
  assert.deepEqual(f.companion.calls.filter(c => c[0] === 'archive-linux').map(c => c[1]), ['retry-stage-2-1', 'retry-stage-2-2', SCANNER_ABANDON_ARCHIVE_REASON]);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true, 'the head is burned (same Source, same attempt)');
  assert.deepEqual(mayHavePublished({}, s), { published: false, basis: 'failed-clean-stage-2' });
  assert.equal(await f.executedHeads.published(subject()), false, 'never recorded as executed: a new Source may run it');
  // the receipts: what the observer saw, the stage-terminal with its bridge facts, then the terminal
  assert.deepEqual((await bodies(f, 'bridge-pump-lost')).map(b => [b.stage, b.failureCode]), Array(3).fill([2, 'RELAY_REFUSED_NO_RETRY']));
  assert.deepEqual((await bodies(f, 'bridge-stop-requested')).map(b => [b.stage, b.requestId]), Array(3).fill([2, SWAP]));
  assert.deepEqual((await bodies(f, 'execution-retry')).map(b => [b.stage, b.try, b.basis]), [[2, 1, 'abandoned-unpublished'], [2, 2, 'abandoned-unpublished']]);
  assert.deepEqual((await bodies(f, 'stage-terminal')).find(b => b.stage === 2).bridge, bridge());
  assert.deepEqual((await bodies(f, 'batch-terminal')).map(b => [b.outcome, b.failureCode, b.class, b.originalCode]), [['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED, 'environment', 'BRIDGE_STAGE_STOPPED_PUMP_LOST']]);
  // Owner decision eaa7d5e4: stage 2 gets the one attempt 2
  assert.equal(r.attempt2, batchKey(subject({ attempt: 2 })));
  assert.deepEqual((await bodies(f, 'attempt2-scheduled')).map(b => [b.failureCode, b.stage]), [[BRIDGE_ABANDONED_UNPUBLISHED, 2]]);
  assert.equal(f.queue.breaker?.consecutive ?? 1, 1, 'counted by the breaker');
});

test('stage 2: attempt 2 runs once after the delay; an attempt 2 abandoned again gets no attempt 3', async t => {
  const engine = fakeEngine();
  let n = 0;
  // each attempt: the run and its two runs again in the batch (DESIGN 59)
  engine.runStage = async (batch, stage) => { engine.calls.push(['stage', stage.number]); return stage.number === 2 && ++n <= 6 ? stopped() : { ok: true }; };
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  f.advance(600_000);
  const second = await f.exec.tick();
  assert.deepEqual([second.state, second.failureCode, second.attempt2], ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED, undefined]);
  f.advance(600_000);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(stagesRun(engine), [1, 2, 2, 2, 1, 2, 2, 2]);
  // and one whose attempt 2 runs through completes
  const g = await executorFixture(t, { engine: (() => { const e = fakeEngine(); let m = 0; e.runStage = async (b, s) => { e.calls.push(['stage', s.number]); return s.number === 2 && ++m <= 3 ? stopped() : { ok: true }; }; return e; })() });
  await g.drop(triggerBytes());
  await g.exec.tick();
  g.advance(600_000);
  assert.equal((await g.exec.tick()).state, 'COMPLETED');
});

test('stages 4 and 6: two runs again in the batch (DESIGN 54), then FAILED_CLEAN, never an attempt 2, the head counts as published (stage 3 published)', async t => {
  for (const stage of [4, 6]) {
    const f = await executorFixture(t, { engine: fakeEngine({ stages: { [stage]: { ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'BRIDGE_RESULT_DEADLINE', sideEffects: 1, mayHavePublished: true },
      bridge: bridge({ stopRequestId: null, stopCode: null, stageCode: 'PUBLICATION_UNCERTAIN' }) } } }) });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED, undefined], String(stage));
    assert.equal(f.engine.calls.filter(c => c[0] === 'stage' && c[1] === stage).length, 3, 'the run and two runs again');
    assert.deepEqual(f.engine.calls.filter(c => c[0] === 'archive-windows' && c[1].startsWith('retry-stage-')).map(c => c[1]), [`retry-stage-${stage}-1`, `retry-stage-${stage}-2`],
      'each run again its own archive instance (never a replay of the one before)');
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.terminal.facts.stage, s.terminal.facts.retry, s.terminal.facts.outcomeReason], [stage, 'new-commit', 'BRIDGE_RESULT_DEADLINE']);
    assert.equal(mayHavePublished({}, s).published, true);
    assert.equal(await f.executedHeads.published(subject()), true, 'recorded before stage 3, as always');
  }
  assert.deepEqual(attempt2Decision({ policy: { automaticAttempt2: { enabled: true } }, subject: { attempt: 1 }, outcome: 'FAILED_CLEAN', failure: { code: BRIDGE_ABANDONED_UNPUBLISHED, stageNumber: 4, relayedRoles: 0 } }),
    { eligible: false, reason: 'ATTEMPT2_ROLE_MAY_BE_PUBLISHED' });
  // DESIGN §32 adds the memory gate's stage-2 refusal to the same list, at stage 2 only; DESIGN §71 the reboot's clean end, at stages 1 and 2
  assert.deepEqual({ ...ATTEMPT2_RESIDENT_CODES }, { [BRIDGE_ABANDONED_UNPUBLISHED]: [2], LINUX_MEMORY_NOT_READY: [2], EXECUTOR_RESTARTED_UNPUBLISHED: [1, 2] });
  assert.deepEqual([failureRow({ code: BRIDGE_ABANDONED_UNPUBLISHED, stage: 2 }).retry, failureRow({ code: BRIDGE_ABANDONED_UNPUBLISHED, stage: 6 }).retry], ['attempt2', 'new-commit']);
});

test('quiescence not proven within 5 minutes HALTs with the original code; the scene stays', async t => {
  const companion = fakeCompanion({ linux: { linuxUnitsInactive: false, containersZero: true } });
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 2: stopped() } }), companion });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'BRIDGE_STAGE_STOPPED_PUMP_LOST']);
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.outcome, s.terminal.facts.failureCode, s.terminal.facts.basis, s.terminal.facts.originalCode], ['FAILED_UNKNOWN', 'BRIDGE_STAGE_STOPPED_PUMP_LOST', 'scanner-abandon-quiescence-unproven', 'BRIDGE_STAGE_STOPPED_PUMP_LOST']);
  assert.equal((await f.ledger.halted()).value.code, 'BRIDGE_STAGE_STOPPED_PUMP_LOST');
  // the failure proof, then the bounded re-check of the run again (DESIGN 59: refused, no archive), then that of the failure path
  assert.equal(companion.calls.filter(c => c[0] === 'quiescence').length, 1 + 2 * ABORT_QUIESCENCE_ATTEMPTS, 'the failure proof, then the bounded re-checks');
  assert.deepEqual((await bodies(f, 'execution-retry-refused')).map(b => [b.stage, b.step]), [[2, 'quiescence']]);
  assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length + companion.calls.filter(c => c[0] === 'archive-linux').length, 0, 'nothing archived');
  assert.equal((await f.ledger.pendingAttempts2()).length, 0);
});

test('an archive that is not confirmed HALTs', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 2: stopped() }, archiveWindows: { verified: false, directory: null } }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'FAILURE_ARCHIVE_UNCONFIRMED']);
  assert.equal((await f.ledger.state(KEY)).terminal.facts.basis, 'scanner-abandon-unconfirmed');
});

test('never while halted, never with drifted bytes, never for an unprovable pump; it never clears HALT', async t => {
  // HALT latched during the stage (by anything): the failure HALTs as before, the HALT record is left exactly as it is
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  engine.runStage = async (batch, stage) => { engine.calls.push(['stage', stage.number]); if (stage.number !== 2) return { ok: true }; await f.ledger.halt('X_Y', {}); return stopped(); };
  let cleared = 0;
  f.ledger.clearHalt = async () => { cleared += 1; throw new Error('never'); };
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual([(await f.ledger.state(KEY)).outcome, (await f.ledger.halted()).value.code, cleared], ['FAILED_UNKNOWN', 'X_Y', 0]);
  // drift of the installed bytes found at the failure
  const d = await executorFixture(t, { engine: fakeEngine() });
  d.engine.runStage = async (batch, stage) => { d.engine.calls.push(['stage', stage.number]); if (stage.number !== 2) return { ok: true }; d.exec.sourceIntegrity = async () => ({ ok: false }); return stopped(); };
  await d.drop(triggerBytes());
  assert.deepEqual([(await d.exec.tick()).failureCode, (await d.ledger.state(KEY)).outcome], ['BRIDGE_STAGE_STOPPED_PUMP_LOST', 'FAILED_UNKNOWN']);
  // the companion's heartbeat was lost: fast HALT, no quiescence re-check
  const companion = fakeCompanion();
  const h = await executorFixture(t, { engine: fakeEngine({ stages: { 2: stopped({ pumpCode: 'COMPANION_HEARTBEAT_LOST', pumpQuiet: false }) } }), companion });
  await h.drop(triggerBytes());
  assert.equal((await h.exec.tick()).state, 'HALTED');
  assert.equal(companion.calls.filter(c => c[0] === 'quiescence').length, 1, 'only the failure\'s own proof');
  assert.equal(companion.calls.filter(c => c[0] === 'archive-linux').length, 0);
  // a pump that never answered (not quiet), or a stop the broker did not send: HALT
  for (const o of [{ pumpQuiet: false }, { stopCode: 'BROKER_STOP_NOT_THIS_HELPER' }]) {
    const g = await executorFixture(t, { engine: fakeEngine({ stages: { 2: stopped(o) } }) });
    await g.drop(triggerBytes());
    assert.equal((await g.exec.tick()).state, 'HALTED', JSON.stringify(o));
  }
});

test('a crash at any await of the abandonment before its terminal record leaves a crash scene: the next tick HALTs', async t => {
  // The service dies at that await: the port never answers. `died` resolves once the run got there.
  const points = {
    quiescence: (f, never) => { let n = 0; const q = f.companion.linuxQuiescence; f.companion.linuxQuiescence = async b => (++n === 2 ? never() : q(b)); },
    'windows-quiescence': (f, never) => { let n = 0; const w = f.engine.windowsQuiescence; f.engine.windowsQuiescence = async b => (++n === 2 ? never() : w(b)); },
    'quiescence-sleep': (f, never) => { f.companion.linuxQuiescence = async () => { f.companion.calls.push(['quiescence']); return { linuxUnitsInactive: false, containersZero: true }; }; const s0 = f.exec.sleep; f.exec.sleep = ms => (ms === ABORT_QUIESCENCE_POLL_MS ? never() : s0(ms)); },
    'archive-windows': (f, never) => { f.engine.archiveFailure = () => never(); },
    'archive-linux': (f, never) => { f.companion.archiveLinux = () => never(); },
    terminal: (f, never) => { const term = f.ledger.terminal.bind(f.ledger); f.ledger.terminal = async (k, o, x) => (o === 'FAILED_CLEAN' ? never() : term(k, o, x)); f.restore = () => { f.ledger.terminal = term; }; },
  };
  for (const [label, crash] of Object.entries(points)) {
    const f = await executorFixture(t, { engine: fakeEngine({ stages: { 2: stopped() } }) });
    let died;
    const reached = new Promise(resolve => { died = resolve; });
    crash(f, () => { died(); return new Promise(() => {}); });
    await f.drop(triggerBytes());
    let settled = false;
    f.exec.tick().then(() => { settled = true; });
    await reached;
    for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r));
    assert.equal(settled, false, `${label}: the service died here`);
    assert.equal((await f.ledger.state(KEY)).state, 'STARTED', `${label}: no terminal yet`);
    f.restore?.();
    // the restarted service (fresh ports for the hosts; the same ledger, receipts and directories)
    const restarted = new ResidentExecutor({ ...f.ports, engine: fakeEngine(), companion: fakeCompanion() });
    assert.equal((await restarted.tick()).state, 'HALTED', label);
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.outcome, s.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH'], label);
  }
});

test('regression: the Owner abort is unchanged and wins; a bridge-stopped ending on the abort path needs STOP_SENT like a missing outcome', async t => {
  assert.equal(abortStageEndingClean({ ok: false, code: 'BRIDGE_STAGE_STOPPED_PUMP_LOST', proof: WINDOWS_CLEAN }, { stopSent: true }), true);
  assert.equal(abortStageEndingClean({ ok: false, code: 'BRIDGE_STAGE_STOPPED_PUMP_LOST', proof: WINDOWS_CLEAN }), false);
  assert.ok(OWNER_ABORT_STAGE_ENDINGS.includes('BRIDGE_STAGE_STOPPED_PUMP_LOST'));
  // an abort accepted while stage 2 runs and the bridge stopped it: FAILED_CLEAN OWNER_ABORTED, never the abandonment
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine });
  let stopAsked;
  const asked = new Promise(resolve => { stopAsked = resolve; });
  engine.requestStop = async () => { stopAsked(); return { broker: true, requestId: SWAP, stopCode: 'STOP_SENT', pump: true, done: true }; };
  engine.runStage = async (batch, stage) => {
    engine.calls.push(['stage', stage.number]);
    if (stage.number !== 2) return { ok: true };
    const latest = await f.ledger.latestRecord(batch.key);
    await writeOwnerRequest(path.join(f.root, 'owner'), abortRequest({ batchKey: batch.key, expectedLedgerEntrySha256: latest.sha256, reason: 'stuck', by: OWNER }, f.clock), f.clock);
    await asked;
    return stopped();
  };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', OWNER_ABORTED, 'in-stage-2']);
  assert.deepEqual(engine.calls.filter(c => c[0] === 'archive-windows').map(c => c[1]), ['owner-aborted']);
  assert.equal((await f.ledger.pendingAttempts2()).length, 0, 'an abort never gets an attempt 2');
});
