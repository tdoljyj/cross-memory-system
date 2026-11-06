// Generation 11 (DESIGN 54): an execution stage (4 trivy, 6 contract-placement) that ended with an environment fault proven to have
// published nothing runs again in the same batch: no burned head, no new commit, and the role's publication stage runs once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXECUTION_RETRY_MS } from '../src/executor.mjs';
import { BRIDGE_ABANDONED_UNPUBLISHED, EXECUTION_RETRY_BLOCKED_REASONS, EXECUTION_RETRY_STAGES, LINUX_MEMORY_NOT_READY, executionRetryable } from '../src/classify.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { WindowsEngine } from '../src/engine-windows.mjs';
import { Mailbox, REQUEST_CONTRACT, validateRequest } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, validateCompanionConfig, workerRanEvidence, workerRanSince } from '../src/companion.mjs';
import { BASE, HEAD, RELAY_ON, SOURCE, TEST_NODE, TEST_NODE_SHA, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, rawPolicy, relayedRow, tempRoot, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const SWAP = '0a1b2c3d-0000-4000-8000-000000000001';
const BATCH = '0123456789abcdef-0123456789ab';
const JOB = 'e'.repeat(64);
const T0 = Date.parse('2026-11-05T10:30:00Z');
const TRANSFERRED = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
const NOT_THERE = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
const companionCfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}
const bridge = (o = {}) => ({ pumpCode: 'RELAY_REFUSED_NO_RETRY', stopRequestId: SWAP, stopCode: 'STOP_SENT', stageCode: 'LINUX_WORKER_ENDED_WITHOUT_RECORD', pumpQuiet: true, ...o });
// 2026-11-05 head 46f6e452: the Linux worker ended without its record (the DB download was cut), the pump refused, the stage was stopped
const lost = () => ({ ok: false, code: 'LINUX_WORKER_ENDED_WITHOUT_RECORD', proof: WINDOWS_CLEAN, outcome: null, bridge: bridge() });
const refused = (reason = 'LINUX_PREPARATION_REFUSED') => ({ ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN,
  outcome: { status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null }, bridge: bridge({ pumpCode: null, stopCode: null, stageCode: 'STAGE_CHILD_REFUSED' }) });
// An engine whose stage `n` answers the listed results in turn (then success).
function engineWith(n, answers, engine = fakeEngine()) {
  const run = engine.runStage, list = [...answers];
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === n && list.length) { engine.calls.push(['stage', n]); engine.opts.push([n, o ?? null]); return list.shift(); }
    return run(batch, stage, o);
  };
  return engine;
}

test('the pure rule: stages 4 and 6 (and 2, abandoned only); abandoned-unpublished, a clean environment refusal or the memory gate; never a refusal about the PR', () => {
  assert.deepEqual([...EXECUTION_RETRY_STAGES], [2, 4, 6]);
  assert.deepEqual(EXECUTION_RETRY_MS.map(ms => ms / 60_000), [1, 5]);
  for (const stage of [1, 3, 5, 7, 8, 9]) assert.equal(executionRetryable({ stage, code: lost().code, bridge: bridge(), proof: WINDOWS_CLEAN }).retry, false, String(stage));
  assert.deepEqual(executionRetryable({ stage: 4, code: lost().code, bridge: bridge(), proof: WINDOWS_CLEAN }), { retry: true, basis: 'abandoned-unpublished', reason: null });
  assert.equal(executionRetryable({ stage: 6, code: lost().code, bridge: bridge({ pumpQuiet: false }), proof: WINDOWS_CLEAN }).retry, false, 'the pump not quiet: no proof');
  assert.equal(executionRetryable({ stage: 6, code: lost().code, bridge: bridge({ pumpCode: 'COMPANION_HEARTBEAT_LOST' }), proof: WINDOWS_CLEAN }).retry, false, 'unprovable pump');
  assert.equal(executionRetryable({ stage: 4, code: lost().code, bridge: bridge(), proof: { windowsTreeZero: true, serviceOriginalStopped: false } }).retry, false, 'Windows half');
  for (const reason of EXECUTION_RETRY_BLOCKED_REASONS) assert.equal(executionRetryable({ stage: 6, code: 'STAGE_CHILD_REFUSED', outcome: refused(reason).outcome, proof: WINDOWS_CLEAN }).basis, 'clean-refusal', reason);
  assert.equal(executionRetryable({ stage: 4, code: 'X', outcome: { ...refused('full_admission_unavailable').outcome, diagnostic: { transport: true } }, proof: WINDOWS_CLEAN }).retry, true);
  for (const reason of ['full_admission_unavailable', 'PR_NOT_OPEN_OR_CHANGED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'full_admission_rejected', 'github_http_429', 'github_http_403'])
    assert.equal(executionRetryable({ stage: 4, code: 'X', outcome: refused(reason).outcome, proof: WINDOWS_CLEAN }).retry, false, reason);
  for (const o of [{ ...refused().outcome, sideEffects: 1 }, { ...refused().outcome, mayHavePublished: true }, { ...refused().outcome, status: 'UNCERTAIN' }, null])
    assert.equal(executionRetryable({ stage: 4, code: 'X', outcome: o, proof: WINDOWS_CLEAN }).retry, false, JSON.stringify(o));
  assert.deepEqual(executionRetryable({ stage: 6, code: LINUX_MEMORY_NOT_READY, proof: WINDOWS_CLEAN }), { retry: true, basis: 'memory-gate', reason: null });
});

// Generation 14 (DESIGN 58, defect e0a5630d): the stage-2 relay a busy host made the pump refuse (11-06 #1007, 11-05 #1005, 11-04).
const pumpLost2 = (o = {}) => ({ ok: false, code: 'BRIDGE_STAGE_STOPPED_PUMP_LOST', proof: WINDOWS_CLEAN, outcome: null, bridge: bridge({ stageCode: 'STAGE_OUTCOME_MISSING', ...o }) });
test('the pure rule at stage 2: the abandoned basis only; the memory gate, clean refusals, a loud pump or a missing proof keep the path of before', () => {
  const p = pumpLost2();
  assert.deepEqual(executionRetryable({ stage: 2, code: p.code, bridge: p.bridge, proof: WINDOWS_CLEAN }), { retry: true, basis: 'abandoned-unpublished', reason: null });
  assert.deepEqual(executionRetryable({ stage: 2, code: lost().code, bridge: bridge(), proof: WINDOWS_CLEAN }).basis, 'abandoned-unpublished');
  const no = o => assert.deepEqual(executionRetryable({ stage: 2, proof: WINDOWS_CLEAN, ...o }).retry, false, JSON.stringify(o));
  no({ code: LINUX_MEMORY_NOT_READY }); // keeps its one attempt 2 (DESIGN 32)
  for (const reason of EXECUTION_RETRY_BLOCKED_REASONS) no({ code: 'STAGE_CHILD_REFUSED', outcome: refused(reason).outcome, bridge: refused(reason).bridge });
  no({ code: p.code, bridge: bridge({ stopCode: null }) }); // the stop never reached the helper
  no({ code: p.code, bridge: bridge({ pumpQuiet: false }) }); // the pump may still write
  no({ code: p.code, bridge: bridge({ pumpCode: 'COMPANION_HEARTBEAT_LOST' }) }); // unprovable
  no({ code: p.code, bridge: null });
  // side effects or a possible publication under an ending the abandonment proof does not cover: never
  no({ code: 'RELAY_PUBLICATION_UNCERTAIN', outcome: { ...refused().outcome, sideEffects: 1, mayHavePublished: true }, bridge: bridge() });
  no({ code: 'STAGE_CHILD_TREE_UNCONFIRMED', bridge: bridge() });
  assert.equal(executionRetryable({ stage: 2, code: p.code, bridge: p.bridge, proof: { windowsTreeZero: false, serviceOriginalStopped: true } }).retry, false, 'Windows half');
  assert.equal(executionRetryable({ stage: 2, code: LINUX_MEMORY_NOT_READY, proof: WINDOWS_CLEAN }).reason, 'EXECUTION_RETRY_STAGE2_NOT_ABANDONED');
  // the publisher of the same role never runs again here (it has its own DESIGN 51 rule)
  assert.equal(executionRetryable({ stage: 3, code: p.code, bridge: p.bridge, proof: WINDOWS_CLEAN }).retry, false);
});

test('stage 2 (gitleaks): the relay abandoned once (pump lost, stopped); it runs again in the batch with its refs gate and the PR completes, stage 3 runs once', async t => {
  const engine = engineWith(2, [pumpLost2()]);
  const companion = fakeCompanion();
  const sleeps = [];
  const f = await executorFixture(t, { engine, companion, sleep: async ms => { sleeps.push(ms); await new Promise(r => setImmediate(r)); } });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.deepEqual(stagesRun(engine), [1, 2, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(sleeps.includes(60_000), JSON.stringify(sleeps));
  const [retry] = await bodies(f, 'execution-retry');
  assert.deepEqual([retry.stage, retry.try, retry.basis, retry.failureCode, retry.archive], [2, 1, 'abandoned-unpublished', 'BRIDGE_STAGE_STOPPED_PUMP_LOST', 'retry-stage-2-1']);
  assert.ok(engine.calls.some(c => c[0] === 'archive-windows' && c[1] === 'retry-stage-2-1'));
  assert.ok(companion.calls.some(c => c[0] === 'archive-linux' && c[1] === 'retry-stage-2-1'));
  // the batch's first Linux stage keeps its refs gate on the run again; no between-roles archive
  assert.deepEqual(engine.opts.filter(o => o[0] === 2).map(([, o]) => [o.betweenRoles, o.firstLinux, o.again ?? 0, typeof o.stillAllowed]), [[false, true, 0, 'function'], [false, true, 1, 'function']]);
  assert.deepEqual((await bodies(f, 'attempt2-scheduled')), [], 'no attempt 2');
  assert.deepEqual((await bodies(f, 'batch-terminal')).map(b => b.outcome), ['COMPLETED']);
});

test('stage 2: the runs again used up end exactly as before (FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED and the one attempt 2); a clean refusal is never run again', async t => {
  let engine = engineWith(2, [pumpLost2(), pumpLost2(), pumpLost2()]);
  let f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED]);
  assert.deepEqual(stagesRun(engine), [1, 2, 2, 2]);
  assert.deepEqual((await bodies(f, 'execution-retry')).map(b => b.archive), ['retry-stage-2-1', 'retry-stage-2-2']);
  assert.equal(r.attempt2, batchKey(subject({ attempt: 2 })));
  // a clean environment refusal at stage 2 is not run again here
  engine = engineWith(2, [refused()]);
  f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine).filter(n => n === 2), [2]);
  assert.deepEqual(await bodies(f, 'execution-retry'), []);
});

test('stage 4 (trivy): the Linux worker ended without its record once; the stage runs again in the batch and the PR completes, stage 5 runs once', async t => {
  const engine = engineWith(4, [lost()]);
  const companion = fakeCompanion();
  const f = await executorFixture(t, { engine, companion });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 4, 5, 6, 7, 8]);
  assert.equal(stagesRun(engine).filter(n => n === 5).length, 1, 'the trivy check is published once');
  const [retry] = await bodies(f, 'execution-retry');
  assert.deepEqual([retry.stage, retry.try, retry.basis, retry.failureCode, retry.afterMs], [4, 1, 'abandoned-unpublished', 'LINUX_WORKER_ENDED_WITHOUT_RECORD', 60_000]);
  assert.ok(engine.calls.some(c => c[0] === 'archive-windows' && c[1] === 'retry-stage-4-1'));
  assert.ok(companion.calls.some(c => c[0] === 'archive-linux' && c[1] === 'retry-stage-4-1'));
  assert.deepEqual([retry.archive, retry.windows, retry.linux], ['retry-stage-4-1', 'failed-x-retry-stage-4-1-000000000000', 'failed-x-retry-stage-4-1-111111111111']);
  // the run again starts no between-roles archive and no refs gate of its own
  assert.deepEqual(engine.opts.filter(o => o[0] === 4).map(o => o[1]), [{ betweenRoles: true, firstLinux: false }, { betweenRoles: false, firstLinux: false, again: 1 }]);
  const terminals = (await bodies(f, 'stage-terminal')).filter(b => b.stage === 4);
  assert.deepEqual(terminals.map(b => [b.ok, b.executionRetry ?? 0]), [[false, 0], [true, 1]]);
});

test('stage 6 (contract-placement): two clean environment refusals, then success; the waits are 1 and 5 minutes', async t => {
  const engine = engineWith(6, [refused(), refused('BRIDGE_CALLBACK_DEADLINE')]);
  const sleeps = [];
  const f = await executorFixture(t, { engine, sleep: async ms => { sleeps.push(ms); await new Promise(r => setImmediate(r)); } });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine).filter(n => n === 6 || n === 7), [6, 6, 6, 7]);
  assert.ok(sleeps.includes(60_000) && sleeps.includes(300_000), JSON.stringify(sleeps));
  assert.deepEqual((await bodies(f, 'execution-retry')).map(b => [b.stage, b.try, b.basis, b.reason]), [[6, 1, 'clean-refusal', 'LINUX_PREPARATION_REFUSED'], [6, 2, 'clean-refusal', 'BRIDGE_CALLBACK_DEADLINE']]);
});

test('the runs again used up: the batch ends exactly as before (abandoned: FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED, head burned)', async t => {
  const engine = engineWith(4, [lost(), lost(), lost()]);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED]);
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 4, 4]);
  assert.equal((await bodies(f, 'execution-retry')).length, 2);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
});

test('never retried: a refusal about the PR, a stage that is not listed, an unproven quiescence, an archive that is not verified', async t => {
  // a refusal about the PR
  let engine = engineWith(4, [refused('PR_NOT_OPEN_OR_CHANGED')]);
  let f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine).filter(n => n === 4), [4]);
  assert.deepEqual(await bodies(f, 'execution-retry'), []);
  // a stage that is not listed (stage 3, the gitleaks publisher) never runs again by this rule
  engine = engineWith(3, [lost()]);
  f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine).filter(n => n === 3), [3]);
  assert.deepEqual(await bodies(f, 'execution-retry'), []);
  // Linux never quiet: no archive, no run again; the failure path decides (here: the abandonment cannot prove quiescence either: HALT)
  engine = engineWith(4, [lost(), lost()]);
  const companion = fakeCompanion({ linux: { linuxUnitsInactive: false, containersZero: true } });
  f = await executorFixture(t, { engine, companion });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual(stagesRun(engine).filter(n => n === 4), [4]);
  assert.ok(!companion.calls.some(c => c[0] === 'archive-linux' && c[1].startsWith('retry-stage-4')));
  assert.equal(r.state, 'HALTED', JSON.stringify(r));
  // the Linux archive not verified: no run again
  engine = engineWith(4, [lost()]);
  const c2 = fakeCompanion();
  const archive = c2.archiveLinux;
  c2.archiveLinux = async (batch, reason) => (reason === 'retry-stage-4-1' ? { verified: false, directory: null } : archive(batch, reason));
  f = await executorFixture(t, { engine, companion: c2 });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine).filter(n => n === 4), [4]);
  assert.deepEqual(await bodies(f, 'execution-retry'), []);
});

test('the memory gate refused stage 6 (nothing of it ran): it runs again after the wait', async t => {
  const engine = engineWith(6, [{ ok: false, code: LINUX_MEMORY_NOT_READY, proof: WINDOWS_CLEAN, memoryGate: { checks: 3, order: 9, blocks: 0, low: true, ready: false, waitedMs: 1, refused: true } }]);
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual((await bodies(f, 'execution-retry')).map(b => b.basis), ['memory-gate']);
});

test('HALT or drift seen before the run again: no run again (prepareExecutionRetry)', async t => {
  const f = await executorFixture(t);
  f.exec.ledger.halted = async () => ({ value: { code: 'X' } });
  assert.equal(await f.exec.prepareExecutionRetry(KEY, { key: KEY, batchId: '0'.repeat(16) + '-' + '0'.repeat(12) }, 4, lost(), 0, 'abandoned-unpublished'), false);
  const g = await executorFixture(t, { integrity: { ok: true, sourceManifestSha256: 'f'.repeat(64), residentManifestSha256: 'e'.repeat(64) } });
  assert.equal(await g.exec.prepareExecutionRetry(KEY, { key: KEY, batchId: '0'.repeat(16) + '-' + '0'.repeat(12) }, 4, lost(), 0, 'abandoned-unpublished'), false);
});

// ---- the run again of the same unit instance (clued-ci-worker@<jobId>): the facts of the run before are no evidence ----

test('the mailbox carries `again` only on a relay-stage (stage 2, 4 or 6), as 1 or 2; a first run never carries it', () => {
  const base = { contract: REQUEST_CONTRACT, requestId: SWAP, kind: 'relay-stage', createdAt: '2026-11-05T10:00:00Z', deadline: '2026-11-05T11:00:00Z', batchId: BATCH, jobId: JOB };
  for (const [stage, again] of [[2, 1], [2, 2], [4, 1], [4, 2], [6, 1], [6, 2]]) assert.equal(validateRequest({ ...base, stage, again }).again, again);
  assert.equal(Object.hasOwn(validateRequest({ ...base, stage: 4 }), 'again'), false);
  for (const [stage, again] of [[3, 1], [2, 0], [2, 3], [4, 0], [4, 3], [6, '1'], [4, null], [4, 1.5]])
    assert.throws(() => validateRequest({ ...base, stage, again }), /MAILBOX_RELAY_FIELDS_REFUSED/, `${stage}/${again}`);
  assert.throws(() => validateRequest({ kind: 'archive-linux', contract: REQUEST_CONTRACT, requestId: SWAP, createdAt: base.createdAt, deadline: base.deadline, batchId: BATCH, reason: 'x', again: 1 }), /MAILBOX_REQUEST_KEYS_REFUSED/);
});

test('the engine: a run again goes to the pump as `again`, without the between-roles archive; the first Linux stage keeps its refs gate; refused anywhere else', async () => {
  const engine = Object.create(WindowsEngine.prototype);
  const row = n => ({ number: n, workManifestSha256: 'a'.repeat(64), jobId: JOB });
  const batch = { batchId: BATCH, key: 'b'.repeat(64), dir: 'x', stages: Array.from({ length: 9 }, (_, i) => row(i + 1)) };
  const seen = [];
  engine.invoke = async (b, stage) => { seen.push(stage); return { ok: true }; };
  engine.archiveWindows = async () => { seen.push('archive'); return { verified: true }; };
  engine.archiveLinux = engine.archiveWindows;
  await engine.runStage(batch, { number: 4, linuxWorker: true }, { betweenRoles: false, firstLinux: false, again: 1 });
  await engine.runStage(batch, { number: 6, linuxWorker: true }, { betweenRoles: false, firstLinux: false, again: 2 });
  assert.deepEqual(seen.map(s => s.again), [1, 2], 'no archive, the stage carries again');
  // the batch's first Linux stage run again keeps its refs gate (firstLinux): the gate is asked, then the stage runs with `again`
  const asked = [];
  engine.companionMailbox = { send: async kind => { asked.push(kind); return { kind }; }, await: async req => (req.kind === 'check-refs' ? { ok: true } : null) };
  engine.versions = async () => ({ consistent: true });
  await engine.runStage(batch, { number: 6, linuxWorker: true }, { betweenRoles: false, firstLinux: true, again: 1 });
  assert.deepEqual([asked, seen.at(-1).again, seen.at(-1).number], [['check-refs'], 1, 6]);
  delete engine.companionMailbox;
  delete engine.versions;
  for (const [n, o] of [[3, { again: 1 }], [2, { again: 3 }], [5, { again: 1 }], [4, { again: 3 }], [4, { betweenRoles: true, again: 1 }], [6, { betweenRoles: true, firstLinux: false, again: 2 }]])
    await assert.rejects(engine.runStage(batch, { number: n, linuxWorker: true }, o), /RESIDENT_STAGE_AGAIN_INVALID/, `${n} ${JSON.stringify(o)}`);
  // the relay-stage request: `again` only on a run again
  const sent = [];
  engine.companionMailbox = { send: async (kind, fields) => { sent.push([kind, fields]); return { requestId: SWAP }; } };
  engine.observePump = () => ({ stop: async () => {} });
  engine.run = async () => { throw new Error('stop here'); };
  engine.paths = { nodeExe: 'node' };
  engine.trainModeArgs = () => [];
  for (const stage of [{ number: 4, linuxWorker: true, runMilliseconds: 1 }, { number: 4, linuxWorker: true, runMilliseconds: 1, again: 2 }])
    await assert.rejects(engine.invokeStage(batch, stage, row(4), 'invoke.mjs'), /stop here/);
  assert.deepEqual(sent.map(([k, f]) => [k, f.again]), [['relay-stage', undefined], ['relay-stage', 2]]);
  assert.equal(Object.hasOwn(sent[0][1], 'again'), false);
});

test('workerRanSince: the first run as before; a run again counts only what changed since the facts read before its start', () => {
  const F = (activeState, invocationId = '', mainStartMonotonic = 0) => ({ activeState, invocationId, mainStartMonotonic });
  const OLD = 'a'.repeat(32), NEW = 'b'.repeat(32);
  for (const f of [F('failed'), F('inactive', OLD, 5), F('active'), null, F('inactive')]) assert.equal(workerRanSince(f, null), workerRanEvidence(f));
  const failedBefore = F('failed', OLD, 5);
  assert.equal(workerRanSince(F('failed', OLD, 5), failedBefore), false, 'the run before failed: still its facts');
  assert.equal(workerRanSince(F('inactive', OLD, 5), F('inactive', OLD, 5)), false, 'the run before ended inactive');
  for (const s of ['activating', 'active', 'deactivating']) assert.equal(workerRanSince(F(s, OLD, 5), failedBefore), true, s);
  assert.equal(workerRanSince(F('inactive', NEW, 9), failedBefore), true, 'a new invocation that started its main process');
  assert.equal(workerRanSince(F('failed', NEW, 5), failedBefore), true, 'a new invocation that failed (its pre-start check)');
  assert.equal(workerRanSince(F('inactive', NEW, 5), failedBefore), false, 'a new id without a new start time is not enough');
  assert.equal(workerRanSince(F('inactive', OLD, 9), failedBefore), false, 'the same invocation id');
  assert.equal(workerRanSince(F('failed', NEW, 9), 'unread'), false, 'no baseline: only a running state counts');
  assert.equal(workerRanSince(F('active'), 'unread'), true);
  assert.equal(workerRanSince(null, failedBefore), false);
});

// A pump over a scripted host (as bridge-observer.test.mjs): unitFacts(ms, sinceStart) answers the systemctl show.
async function pumpAgain(t, { again, unitFacts, listing = () => '', relay = m => (m === 'SendIssue' ? TRANSFERRED : NOT_THERE), cancelAt = null }) {
  const root = await tempRoot(t);
  let now = T0, req, started = null;
  const box = await Mailbox.open(root, () => now);
  const factsAt = [];
  const run = async a => {
    const m = a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : null;
    if (m) return relay(m, now);
    if (a.some(x => x.startsWith('--property=ActiveState'))) { factsAt.push(now - T0); return unitFacts(now - T0, started === null ? null : now - started); }
    if (a.includes('/usr/bin/ls')) return { code: 0, stdout: listing(started === null ? -1 : now - started) };
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
    if (a.includes('--no-block')) started = now;
    return { code: 0, stdout: '' };
  };
  const c = new Companion({ cfg: companionCfg, mailbox: box, run, fileExists: async p => p.includes('\\outgoing\\'),
    sleep: async ms => { now += ms; if (cancelAt !== null && now - T0 >= cancelAt) await box.cancel(req, 'stage-ended'); }, clock: () => now });
  req = await box.send('relay-stage', { batchId: BATCH, stage: 4, jobId: JOB, ...(again ? { again } : {}) }, 45 * 60_000);
  await c.step();
  return { res: await box.poll(req), factsAt, elapsed: now - T0 };
}
const unit = (state, invocation = '', mono = 0) => ({ code: 0, stdout: `ActiveState=${state}\nInvocationID=${invocation}\nExecMainStartTimestampMonotonic=${mono}\n` });

test('the pump of a run again: the failed unit of the run before is not "ended"; the new run is followed to its record', async t => {
  const OLD = 'a'.repeat(32), NEW = 'b'.repeat(32);
  // systemd runs the queued start 20 s late (load): until then the unit still reads the run before (failed); then the new run is
  // active for 40 s and leaves its result
  const facts = (ms, since) => (since === null || since < 20_000 ? unit('failed', OLD, 5) : since < 60_000 ? unit('active', NEW, 9) : unit('inactive', NEW, 9));
  const listing = since => (since >= 60_000 ? 'result.ready.json\n' : '');
  const relay = m => (m === 'SendIssue' || m === 'ReceiveResult' ? TRANSFERRED : NOT_THERE);
  const again = await pumpAgain(t, { again: 1, unitFacts: facts, listing, relay });
  assert.equal(again.res.ok, true, JSON.stringify(again.res));
  assert.equal(again.factsAt[0], 0, 'the baseline is read before the start');
  // the same host without `again` (the evidence of a first run): the failed unit reads as an ended worker at once, a false ending
  const old = await pumpAgain(t, { again: 0, unitFacts: facts, listing, relay });
  assert.equal(old.res.code, 'LINUX_WORKER_ENDED_WITHOUT_RECORD');
  // a run again whose new invocation really ended without a record still ends so (signal B)
  const ended = await pumpAgain(t, { again: 2, unitFacts: (ms, since) => (since === null || since < 5_000 ? unit('failed', OLD, 5) : unit('failed', NEW, 7)) });
  assert.equal(ended.res.code, 'LINUX_WORKER_ENDED_WITHOUT_RECORD');
  // the unit never changes from the run before: no evidence, signal C after the start wait
  const never = await pumpAgain(t, { again: 1, unitFacts: () => unit('failed', OLD, 5) });
  assert.equal(never.res.code, 'LINUX_WORKER_NOT_STARTED');
  // the baseline unreadable: only a running state counts; the new run seen active is followed to its record
  const unread = await pumpAgain(t, { again: 1, listing, relay,
    unitFacts: (ms, since) => (since === null ? { code: 1, stdout: '' } : since < 20_000 ? unit('failed', OLD, 5) : since < 60_000 ? unit('active', NEW, 9) : unit('failed', NEW, 9)) });
  assert.equal(unread.res.ok, true, JSON.stringify(unread.res));
});

// ---- review of item 1 (B1, B2, M3, m4, m5) ----

test('B1: each run again is its own archive instance (retry-stage-N-1, then -2); an archive not named for this try is no proof', async t => {
  const engine = engineWith(6, [lost(), lost()]);
  const companion = fakeCompanion();
  const f = await executorFixture(t, { engine, companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(companion.calls.filter(c => c[0] === 'archive-linux' && c[1].startsWith('retry-')).map(c => c[1]), ['retry-stage-6-1', 'retry-stage-6-2']);
  assert.deepEqual((await bodies(f, 'execution-retry')).map(b => [b.try, b.archive]), [[1, 'retry-stage-6-1'], [2, 'retry-stage-6-2']]);
  // a Linux answer that replays the first try's archive (its directory) for the second: refused, the batch ends as before
  const e2 = engineWith(6, [lost(), lost(), lost()]);
  const c2 = fakeCompanion();
  c2.archiveLinux = async (batch, reason) => { c2.calls.push(['archive-linux', reason]); return { verified: true, directory: 'failed-x-retry-stage-6-1-111111111111' }; };
  const g = await executorFixture(t, { engine: e2, companion: c2 });
  await g.drop(triggerBytes());
  const r = await g.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED]);
  assert.deepEqual(stagesRun(e2).filter(n => n === 6), [6, 6], 'one run again, not two');
  const refused = await bodies(g, 'execution-retry-refused');
  assert.deepEqual(refused.map(b => [b.try, b.step, b.windows, b.linux]), [[2, 'archive-linux', 'failed-x-retry-stage-6-2-000000000000', null]], 'm5: the Windows archive already made is named');
});

test('B2: the stop remembered for the run before is forgotten when the stage is invoked again', async () => {
  const engine = Object.create(WindowsEngine.prototype);
  const row = { number: 4, workManifestSha256: 'a'.repeat(64), jobId: JOB };
  const batch = { batchId: BATCH, key: 'b'.repeat(64), dir: 'x', stages: [] };
  engine.companionMailbox = { send: async () => ({ requestId: SWAP }) };
  engine.observePump = () => ({ stop: async () => {} });
  engine.run = async () => { throw new Error('stop here'); };
  engine.paths = { nodeExe: 'node' };
  engine.trainModeArgs = () => [];
  engine.stageStopFor = { batchId: BATCH, stage: 4, requestId: 'old-run' };
  await assert.rejects(engine.invokeStage(batch, { number: 4, linuxWorker: true, runMilliseconds: 1, again: 1 }, row, 'invoke.mjs'), /stop here/);
  assert.equal(engine.stageStopFor, null, 'this run finds and writes its own stop');
  engine.stageStopFor = { batchId: BATCH, stage: 6, requestId: 'other-stage' };
  await assert.rejects(engine.invokeStage(batch, { number: 4, linuxWorker: true, runMilliseconds: 1 }, row, 'invoke.mjs'), /stop here/);
  assert.deepEqual(engine.stageStopFor, { batchId: BATCH, stage: 6, requestId: 'other-stage' }, 'another stage keeps its own');
});

test('M3: no run again when the installed authority would end before this stage again and the stages after it are done', async t => {
  const engine = engineWith(4, [lost()]);
  const f = await executorFixture(t, { engine });
  const now = f.clock();
  const p = f.exec.policy;
  const rest = p.stages.filter(s => s.number >= 4 && s.number <= 8).reduce((sum, s) => sum + s.runMilliseconds + p.limits.stageMarginMs, 0);
  // enough for the batch as before (batchBudgetMs), not for the run again on top of it
  f.exec.policy = { ...p, validUntil: new Date(now + rest + 60_000).toISOString() };
  assert.equal(f.exec.executionRetryFitsAuthority(4, 0), false);
  f.exec.policy = { ...p, validUntil: new Date(now + 60_000 + 5 * 60_000 + 2 * 14 * 60_000 + rest).toISOString() };
  assert.equal(f.exec.executionRetryFitsAuthority(4, 0), true);
  assert.equal(f.exec.executionRetryFitsAuthority(4, 0, { afterWait: true }), true, 'after the wait only the stages are left');
  f.exec.policy = { ...p, validUntil: new Date(now + rest - 1).toISOString() };
  assert.equal(f.exec.executionRetryFitsAuthority(4, 0, { afterWait: true }), false);
  f.exec.policy = { ...p, validUntil: null };
  assert.equal(f.exec.executionRetryFitsAuthority(4, 1), true, 'no expiry: no bound');
  f.exec.policy = { ...p, validUntil: new Date(now + rest).toISOString() };
  assert.equal(await f.exec.prepareExecutionRetry(KEY, { key: KEY, batchId: '0'.repeat(16) + '-' + '0'.repeat(12) }, 4, lost(), 0, 'abandoned-unpublished'), false);
  assert.deepEqual((await bodies(f, 'execution-retry-refused')).map(b => b.step), ['authority']);
  assert.deepEqual(engine.calls.filter(c => c[0] === 'archive-windows'), [], 'nothing archived');
});

test('m4: a HALT that comes during the wait: no run again, the batch ends by the failure path', async t => {
  const engine = engineWith(4, [lost(), lost()]);
  let halted = null;
  const f = await executorFixture(t, { engine, sleep: async ms => { if (ms === EXECUTION_RETRY_MS[0]) halted = { value: { code: 'OWNER_HALT' } }; } });
  const real = f.exec.ledger.halted.bind(f.exec.ledger);
  f.exec.ledger.halted = async () => halted ?? real();
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual(stagesRun(engine).filter(n => n === 4), [4], 'never run again');
  assert.deepEqual((await bodies(f, 'execution-retry-refused')).map(b => b.step), ['after-wait-halt']);
});

test('the first local Linux stage (gitleaks and trivy relayed to hosted): its run again keeps firstLinux, so the refs gate is passed again', async t => {
  const base = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  const engine = engineWith(6, [lost()], base);
  const f = await executorFixture(t, { engine, policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => null }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(61 * 60_000);
  f.companion.hostedHint = async s => Buffer.from(JSON.stringify(hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }, { pr: s.pr, head: s.headSha, at: f.clock() })));
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  const opts6 = engine.opts.filter(o => o[0] === 6).map(o => o[1]);
  assert.ok(opts6.every(o => typeof o.stillAllowed === 'function'), "the refs gate's waits ask the executor (DESIGN 55)");
  assert.deepEqual(opts6.map(({ stillAllowed, ...o }) => o), [{ betweenRoles: false, firstLinux: true }, { betweenRoles: false, firstLinux: true, again: 1 }]);
});
