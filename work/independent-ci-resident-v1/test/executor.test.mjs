import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor, PAUSE_CONTRACT } from '../src/executor.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { rearmRequest, resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { BASE, CLEAN_PROOF, HEAD, RESIDENT, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const keyFor = o => batchKey(subject(o));
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const ls = async dir => (await fs.readdir(dir)).sort();
const OWNER = 'S-1-5-21-1-2-3-1001';

test('happy path: bundle, stage 1, start, workspaces, stages 2..8 once; the same head never again', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(f.engine), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(f.companion.calls.map(c => c[0]), ['bundle', 'wsprep']);
  assert.equal((await f.ledger.state(keyFor())).outcome, 'COMPLETED');
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  // The same head again: the run queue has seen it, nothing is reserved (phase 2).
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.equal(stagesRun(f.engine).length, 8);
  // A queue that started over (or another PR naming the head) still never runs it: the ledger decides.
  const fresh = await executorFixture(t, { root: f.root });
  await fresh.queue.save();
  await fresh.drop(triggerBytes({ pr: 885 }));
  assert.equal((await fresh.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
  assert.equal(stagesRun(f.engine).length, 8);
  assert.ok((await f.receipts.verify()).seq >= 12);
});

test('a burned head is never re-run under a new base, another PR number or any claim (review M3)', async t => {
  const engine = fakeEngine({ stages: { 2: { ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE', proof: WINDOWS_CLEAN } } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  await f.drop(triggerBytes({ baseSha: '3'.repeat(40) })); // main moved: a head this PR was already seen with
  assert.equal((await f.exec.tick()).state, 'IDLE');
  await f.drop(triggerBytes({ pr: 999 }));                  // same head in another PR
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
  assert.deepEqual(stagesRun(engine), [1, 2]);
});

test('malformed or foreign triggers are rejected without touching the engine; receipts hash the bytes', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes({ repo: 'someone/else' }));
  await f.drop(Buffer.from('{"contract":"x"}'));
  await fs.writeFile(path.join(f.root, 'inbox', 'evil.ps1'), 'Remove-Item C:\\ -Recurse');
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.equal(f.engine.calls.length, 0);
  assert.equal((await ls(path.join(f.root, 'state', 'inbox-archive', 'rejected'))).length, 3);
  const receipts = (await ls(path.join(f.root, 'state', 'receipts'))).filter(n => n.includes('trigger-rejected'));
  const first = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'receipts', receipts[0]), 'utf8'));
  assert.match(first.body.bytesSha256 ?? '', /^[0-9a-f]{64}$/);
});

test('the bundle is fetched before stage 1; its failure releases the key with nothing published (review M4)', async t => {
  const f = await executorFixture(t, { companion: fakeCompanion({ bundle: { ok: false } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_EXECUTED');
  assert.deepEqual(stagesRun(f.engine), [], 'stage 1 never ran');
  assert.equal((await f.ledger.state(keyFor())).state, 'ABSENT');
  assert.equal(await f.ledger.headBurned(headKey(subject())), false);
});

test('stage-1 "not admitted" releases the key; the queue retries on its own back-off and stops at the release cap', async t => {
  const engine = fakeEngine({ stages: { 1: notAdmitted() } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
  assert.equal(await f.ledger.headBurned(headKey(subject())), false);
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).level], ['BACKOFF', 1]);
  f.advance(9 * 60_000);
  assert.equal((await f.exec.tick()).state, 'IDLE', 'its 10-minute back-off');
  f.advance(60_001);
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED', 'retried without a new trigger (phase 2)');
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).stopKind], ['STOPPED', 'release-cap'], 'at most two releases in 24 hours (design v0.5 §4.5)');
  assert.ok(f.queue.notices.some(n => n.kind === 'stopped' && n.pr === 884));
  f.advance(3_600_000);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  // Only a new commit runs it again: a new trigger of the same commit does not (design v0.5 §4.5).
  await f.drop(triggerBytes({ contract: 'clued.independent-ci.resident-trigger/2', prUpdatedAt: '2026-10-20T13:30:00Z' }));
  assert.equal((await f.exec.tick()).state, 'IDLE');
  engine.runStage = fakeEngine().runStage.bind(engine);
  await f.drop(triggerBytes({ headSha: '7'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(stagesRun(engine).slice(0, 2), [1, 1]);
});

test('any other stage-1 failure burns the head even before 10-started (review M4)', async t => {
  const engine = fakeEngine({ stages: { 1: { ok: false, code: 'FIXED_PUBLIC_CHILD_REFUSED', proof: WINDOWS_CLEAN } } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  await f.drop(triggerBytes({ pr: 901, baseSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('the cleanup proof is gathered fresh: a stage claiming clean while Linux is busy halts (review M5)', async t => {
  const engine = fakeEngine({ stages: { 3: { ok: false, code: 'FIXED_PUBLIC_CHILD_REFUSED', proof: CLEAN_PROOF } } });
  const f = await executorFixture(t, { engine, companion: fakeCompanion({ linux: { linuxUnitsInactive: false, containersZero: true } }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal(engine.calls.some(c => c[0].startsWith('archive')), false);
  const busyWindows = await executorFixture(t, { engine: fakeEngine({ stages: { 5: { ok: false, code: 'FIXED_PUBLIC_CHILD_REFUSED', proof: CLEAN_PROOF } }, windows: { windowsTreeZero: false, serviceOriginalStopped: true } }) });
  await busyWindows.drop(triggerBytes());
  assert.equal((await busyWindows.exec.tick()).state, 'HALTED');
});

test('a clean failure archives both hosts and other PRs continue', async t => {
  const engine = fakeEngine({ stages: { 4: { ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE', proof: WINDOWS_CLEAN } } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  assert.deepEqual(engine.calls.filter(c => c[0] === 'archive-windows'), [['archive-windows', 'formal-bridge-stage-deadline']]);
  assert.deepEqual(f.companion.calls.filter(c => c[0] === 'archive-linux'), [['archive-linux', 'formal-bridge-stage-deadline']]);
  await f.drop(triggerBytes({ pr: 900, headSha: '4'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN', 'the next PR runs (its scripted stage 4 fails too)');
});

test('unrecognised codes, engine exceptions and archive failures all halt', async t => {
  for (const script of [
    { stages: { 5: { ok: false, code: 'SOMETHING_NEVER_SEEN', proof: CLEAN_PROOF } } },
    { stages: { 6: { ok: false, code: 'lowercase code', proof: CLEAN_PROOF } } },
    { deriveThrows: true },
    { stages: { 3: { ok: false, code: 'FIXED_PUBLIC_CHILD_REFUSED', proof: CLEAN_PROOF } }, archiveWindows: { verified: false } },
  ]) {
    const f = await executorFixture(t, { engine: fakeEngine(script) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'HALTED', JSON.stringify(script));
    assert.equal((await f.ledger.open()).length, 0, 'never leaves an open entry behind');
  }
});

test('recovery runs even while halted: incomplete and started entries are closed, re-arm is never wedged (review M6)', async t => {
  const f = await executorFixture(t);
  const k1 = keyFor();
  await f.ledger.reserve(k1, subject());
  await f.ledger.markStarted(k1, { batchId: `${k1.slice(0, 16)}-${'0'.repeat(12)}` });
  const k2 = keyFor({ pr: 2, headSha: '5'.repeat(40) });
  await fs.mkdir(path.join(f.root, 'state', 'ledger', k2)); // crash between mkdir and 00-reserved
  await f.ledger.halt('RESIDENT_LOOP_EXCEPTION', {});
  const fresh = new ResidentExecutor(f.ports);
  assert.equal((await fresh.tick()).state, 'HALTED');
  assert.equal((await f.ledger.state(k1)).outcome, 'FAILED_UNKNOWN');
  assert.equal((await f.ledger.state(k2)).outcome, 'FAILED_UNKNOWN');
  assert.equal((await f.ledger.open()).length, 0);
  // The Owner's re-arm request (written elevated into owner\) is carried out by the service.
  const h = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: '0'.repeat(64), reason: 'stale view', by: OWNER }), f.clock);
  assert.equal((await fresh.tick()).state, 'HALTED', 'a stale HALT digest is refused');
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'checked, containers gone', by: OWNER }), f.clock);
  assert.equal((await fresh.tick()).state, 'IDLE');
  assert.equal(await f.ledger.halted(), null);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true, 'the halted head stays burned');
});

test('re-arm refuses without quiescence on both hosts and leaves HALT in place', async t => {
  const f = await executorFixture(t, { companion: fakeCompanion({ linux: { linuxUnitsInactive: true, containersZero: false } }) });
  await f.ledger.halt('X_Y', {});
  const h = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'r', by: OWNER }), f.clock);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const names = await ls(path.join(f.root, 'state', 'receipts'));
  assert.ok(names.some(n => n.endsWith('owner-request-refused.json')));
});

test('anyone may pause; only an Owner resume request clears it; a pause never interrupts a batch', async t => {
  const f = await executorFixture(t);
  await f.drop(Buffer.from(JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'Owner away' })), 'requests');
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  assert.equal(f.engine.calls.length, 0);
  // A forged resume dropped into the user-writable requests\ directory has no effect.
  await f.drop(Buffer.from(JSON.stringify(resumeRequest({ expectedPausedSha256: (await f.ledger.paused()).sha256, by: OWNER }))), 'requests');
  assert.equal((await f.exec.tick()).state, 'PAUSED');
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: (await f.ledger.paused()).sha256, by: OWNER }), f.clock);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('another process appending to the receipt chain cannot fork or wedge it (review M6)', async t => {
  const f = await executorFixture(t);
  await f.receipts.append('service-start', {});
  const other = await ReceiptChain.open(path.join(f.root, 'state', 'receipts'), f.clock);
  await other.append('owner-request', {});
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.ok((await f.receipts.verify()).seq > 2);
});

test('Source drift and an expiring install authority halt before any reservation; limits defer', async t => {
  const drift = await executorFixture(t, { integrity: { ok: true, sourceManifestSha256: 'e'.repeat(64), residentManifestSha256: RESIDENT } });
  await drift.drop(triggerBytes());
  assert.equal((await drift.exec.tick()).failureCode, 'RESIDENT_SOURCE_DRIFT');
  assert.equal((await drift.ledger.keys()).length, 0);
  const expiring = await executorFixture(t, { policy: rawPolicy({ validUntil: '2026-10-20T13:00:00Z' }) });
  await expiring.drop(triggerBytes());
  assert.equal((await expiring.exec.tick()).failureCode, 'RESIDENT_INSTALL_AUTHORITY_EXPIRING');
  const stale = await executorFixture(t, { companion: fakeCompanion({ heartbeat: 0 }) });
  await stale.drop(triggerBytes());
  assert.equal((await stale.exec.tick()).reason, 'COMPANION_NOT_READY');
  const limited = await executorFixture(t, { policy: rawPolicy({ limits: { ...rawPolicy().limits, maxBatchesPer24h: 1 } }) });
  await limited.drop(triggerBytes());
  assert.equal((await limited.exec.tick()).state, 'COMPLETED');
  await limited.drop(triggerBytes({ pr: 900, headSha: '4'.repeat(40) }));
  assert.equal((await limited.exec.tick()).reason, 'DAILY_BATCH_LIMIT');
  // Junk evaluations have their own cap and do not consume the execution budget.
  const junk = await executorFixture(t, { engine: fakeEngine({ stages: { 1: notAdmitted() } }), policy: rawPolicy({ limits: { ...rawPolicy().limits, maxEvaluationsPer24h: 2 } }) });
  for (const n of [1, 2]) { await junk.drop(triggerBytes({ pr: n, headSha: String(n).repeat(40) })); assert.equal((await junk.exec.tick()).state, 'NOT_ADMITTED'); }
  await junk.drop(triggerBytes({ pr: 3, headSha: '3'.repeat(40) }));
  assert.equal((await junk.exec.tick()).reason, 'DAILY_EVALUATION_LIMIT');
  assert.equal(await junk.ledger.startedSince(0), 0);
});

test('a workspace failure with a fresh complete proof burns cleanly; without one it halts', async t => {
  const w = await executorFixture(t, { companion: fakeCompanion({ wsprep: { ok: false, code: 'WORKSPACE_PREPARATION_REFUSED' } }) });
  await w.drop(triggerBytes());
  assert.equal((await w.exec.tick()).state, 'FAILED_CLEAN');
  const u = await executorFixture(t, { companion: fakeCompanion({ wsprep: { ok: false, code: 'WORKSPACE_PREPARATION_REFUSED' }, linux: { linuxUnitsInactive: false, containersZero: true } }) });
  await u.drop(triggerBytes());
  assert.equal((await u.exec.tick()).state, 'HALTED');
});

test('the executor needs every port and a valid policy', () => {
  assert.throws(() => new ResidentExecutor({}), { code: 'EXECUTOR_PORT_MISSING' });
  assert.throws(() => validatePolicy(rawPolicy({ repo: 'not a repo' })), { code: 'POLICY_REPO_INVALID' });
});

const probeResult = (fact = { result: 'held', code: 'ROLE_PROBE_HELD' }, override = {}) => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
  roleProbe: fact, outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false }, ...override });
test('C2 idle probe has no batch, burned head, evaluation, Linux or companion; active cadence is 30min', async t => {
  const f = await executorFixture(t); let calls = 0;
  f.engine.runRoleProbe = async () => { calls++; return probeResult(); };
  assert.equal((await f.exec.tick()).state, 'IDLE'); assert.equal(calls, 1);
  assert.equal((await f.ledger.keys()).length, 0);
  assert.deepEqual(await f.ledger.usage(f.clock() - 86400000), { started: 0, startedByPr: new Map(), evaluations: 0, waitingRetries: 0, reevaluations: new Map(), releasesByHead: new Map(), stage8Retries: 0 });
  assert.equal(f.companion.calls.length, 0); assert.equal(f.engine.calls.length, 0);
  await f.exec.tick(); assert.equal(calls, 1);
  f.advance(1800000 - 1); await f.exec.tick(); assert.equal(calls, 1);
  f.advance(1); await f.exec.tick(); assert.equal(calls, 2);
});
test('C2 probes never run during a batch or while paused/HALT; it never clears head burn', async t => {
  const f = await executorFixture(t); let calls = 0;
  f.engine.runRoleProbe = async () => { calls++; return probeResult(); };
  f.exec.roleProbeMode = 'ACTIVE'; // C3: a start is UNCERTAIN and takes no trigger before its first probe; this node has probed already
  await f.drop(triggerBytes()); await f.exec.tick(); assert.equal(calls, 0);
  const hk = headKey(subject()); assert.equal(await f.ledger.headBurned(hk), true);
  await f.ledger.halt('PUBLICATION_UNCERTAIN', {}); await f.exec.tick(); assert.equal(calls, 0);
  assert.equal(await f.ledger.headBurned(hk), true);
});
test('C2 three uncertainties and connection authorization refusal notify without changing mode or retrying CI', async t => {
  const f = await executorFixture(t); let calls = 0;
  f.engine.runRoleProbe = async () => { calls++; return probeResult({ result: 'uncertain', code: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED' }); };
  f.exec.roleProbeMode = 'STANDBY';
  await f.exec.tick(); f.advance(900000); await f.exec.tick(); f.advance(900000); await f.exec.tick();
  assert.equal(calls, 3); assert.equal(f.exec.roleProbeMode, 'STANDBY');
  assert.deepEqual(f.exec.roleProbeNotices.map(n => n.kind), ['role-probe-connection', 'role-probe-uncertain']);
  assert.equal(await f.ledger.halted(), null); assert.equal((await f.ledger.keys()).length, 0);
});
test('C2 unproven Native cleanup or malformed outcome always HALTs; interrupted receipt never retries', async t => {
  const f = await executorFixture(t);
  f.engine.runRoleProbe = async () => probeResult(undefined, { proof: { windowsTreeZero: false, serviceOriginalStopped: true } });
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.ledger.halted()).value.code, 'ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED');
  assert.equal((await f.ledger.keys()).length, 0);
  const g = await executorFixture(t); let calls = 0;
  g.engine.runRoleProbe = async () => { calls++; return probeResult(); };
  await g.receipts.append('role-probe-intent', { mode: 'ACTIVE' });
  assert.equal((await g.exec.tick()).state, 'HALTED'); assert.equal(calls, 0);
  assert.equal((await g.ledger.halted()).value.code, 'ROLE_PROBE_INTERRUPTED');
  assert.equal((await g.receipts.latest(['role-probe-result'], 1)).length, 1);
});
test('C2 tick serialization refuses overlap while its one controller read is in flight', async t => {
  const f = await executorFixture(t); let release, started;
  const begin = new Promise(r => { started = r; }), hold = new Promise(r => { release = r; });
  f.engine.runRoleProbe = async () => { started(); await hold; return probeResult(); };
  const first = f.exec.tick(); await begin;
  assert.deepEqual(await f.exec.tick(), { state: 'DEFERRED', reason: 'EXECUTOR_TICK_BUSY' });
  release(); assert.equal((await first).state, 'IDLE');
});
