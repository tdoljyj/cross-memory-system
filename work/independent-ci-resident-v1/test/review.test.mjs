// PR-A review (attempt 2 and the hosted wait): each test reproduces a finding and failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentExecutor } from '../src/executor.mjs';
import * as eng from '../src/engine-windows.mjs';
const { WindowsEngine } = eng;
const PUMP_CODES = eng.PUMP_CODES ?? [];
import { classifyFailure, isTransient } from '../src/classify.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { TEST_NODE, TEST_NODE_SHA, BASE, CLEAN_PROOF, HEAD, RELAY_ON, SOURCE, RESIDENT, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, notAdmitted, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const stage1Calls = engine => engine.calls.filter(c => c[0] === 'stage' && c[1] === 1).length;
// Attempt 1 fails stage 2 with a clean transient code (schedules attempt 2); later stage-1 runs answer `later`.
function attempt2Engine(later = null) {
  const engine = fakeEngine();
  const base = engine.runStage;
  let s1 = 0, s2 = 0;
  engine.runStage = async (b, st, o) => {
    if (st.number === 2 && ++s2 === 1) { engine.calls.push(['stage', 2]); return { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }; }
    if (st.number === 1 && ++s1 > 1 && later) { engine.calls.push(['stage', 1]); return later; }
    return base(b, st, o);
  };
  return engine;
}

test('MAJOR 1: attempt 2 is consumed at reservation; a NOT_ADMITTED or BUNDLE_UNAVAILABLE attempt 2 never runs again', async t => {
  for (const variant of ['not-admitted', 'bundle']) {
    const engine = attempt2Engine(variant === 'not-admitted' ? notAdmitted('PATHS_OUTSIDE_WRITE_SET') : null);
    let bundles = 0;
    const companion = fakeCompanion();
    companion.buildBundle = async () => ({ ok: !(variant === 'bundle' && ++bundles > 1) });
    const f = await executorFixture(t, { engine, companion });
    companion.heartbeat = async () => ({ at: f.clock() });
    await f.drop(triggerBytes());
    assert.ok((await f.exec.tick()).attempt2, variant);
    f.advance(600_000);
    const second = await f.exec.tick();
    assert.equal(second.state, variant === 'bundle' ? 'NOT_EXECUTED' : 'NOT_ADMITTED', variant);
    const runs = stage1Calls(engine);
    for (let i = 0; i < 4; i++) { f.advance(3_600_000); f.advance(0); await f.exec.tick(); }
    assert.equal(stage1Calls(engine), runs, `${variant}: no further stage-1 evaluation without a new trigger`);
    assert.deepEqual(await f.ledger.pendingAttempts2(), [], variant);
  }
});

test('MAJOR 2: a pending attempt 2 from before a reinstall (another Source) is closed, never run', async t => {
  const engine = attempt2Engine();
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  // reinstall: a new Source manifest in the policy and on disk; the same state
  const NEW = 'c'.repeat(64);
  const exec2 = new ResidentExecutor({ ...f.ports, policy: validatePolicy(rawPolicy({ sourceManifestSha256: NEW })),
    sourceIntegrity: async () => ({ ok: true, sourceManifestSha256: NEW, residentManifestSha256: RESIDENT }) });
  f.advance(600_000);
  const r = await exec2.tick();
  assert.deepEqual([r.state, r.reason], ['IGNORED', 'ATTEMPT2_SOURCE_CHANGED']);
  assert.equal(stage1Calls(engine), 1, 'the old subject never runs under the new install');
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
});

test('MAJOR 3: every resume of a waiting batch re-runs the start checks; Source drift fails closed before stage R', async t => {
  let drift = false;
  const f = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => hintFor({ gitleaks: { state: 'PENDING_QUEUED', queuedAt: Date.parse('2026-10-20T12:00:00Z') }, trivy: { state: 'SUCCESS' } }) }) });
  f.ports.sourceIntegrity = async () => ({ ok: !drift, sourceManifestSha256: SOURCE, residentManifestSha256: RESIDENT });
  const exec = new ResidentExecutor(f.ports);
  await f.drop(triggerBytes());
  assert.equal((await exec.tick()).state, 'WAITING');
  drift = true;
  f.advance(60_000);
  const r = await exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'RESIDENT_SOURCE_DRIFT']);
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1], 'no stage R, no local stage');
  const key = r.key;
  assert.equal((await f.ledger.state(key)).outcome, 'FAILED_UNKNOWN');
  // validUntil expiring while waiting ends the waiting batch neutrally (phase 2, step 2: a batch at a parking point is
  // closed, not halted; design v0.5 §4.8, review of step 2 m1): nothing ran after stage 1, nothing published
  const g = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion: fakeCompanion({ hint: () => null }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'WAITING');
  const later = new ResidentExecutor({ ...g.ports, policy: validatePolicy(rawPolicy({ relay: RELAY_ON, validUntil: new Date(g.clock() + 60_000).toISOString() })) });
  const r2 = await later.tick();
  assert.deepEqual([r2.state, r2.failureCode], ['FAILED_CLEAN', 'PARKED_AUTHORITY_EXPIRING']);
  assert.equal(await g.ledger.halted(), null);
  assert.deepEqual(g.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1]);
  // install-resident.ps1 refuses while any batch is open (also a waiting one)
  const ps = await fs.readFile(new URL('../windows/install-resident.ps1', import.meta.url), 'utf8');
  assert.ok(ps.indexOf("throw 'INSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST'") > 0 && ps.indexOf("throw 'INSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST'") < ps.indexOf('$receipt = [ordered]@'));
});

test('MINOR 7: if the attempt2-scheduled receipt cannot be written, the intent is cancelled before the HALT', async t => {
  const engine = attempt2Engine();
  const f = await executorFixture(t, { engine });
  const append = f.receipts.append.bind(f.receipts);
  f.receipts.append = async (type, body) => { if (type === 'attempt2-scheduled') throw Object.assign(new Error('disk'), { code: 'RECEIPT_WRITE_FAILED' }); return append(type, body); };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.equal(r.state, 'HALTED');
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 're-arm can never run it');
});

test('MINOR 9: a deferred attempt 2 does not block other PRs\' triggers', async t => {
  const engine = attempt2Engine();
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.ok(first.attempt2);
  const precheck = f.exec.precheck.bind(f.exec);
  f.exec.precheck = async (key, hk, subject, o) => (key === first.attempt2 ? { defer: 'COMPANION_NOT_READY' } : precheck(key, hk, subject, o));
  f.advance(600_000);
  await f.drop(triggerBytes({ pr: 885, headSha: '3'.repeat(40) }));
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED', 'the other PR runs');
  assert.equal((await f.ledger.pendingAttempts2()).length, 1, 'attempt 2 stays pending');
});

test('MINOR 5 and 6: a refs gate without an explicit answer and a free-form companion code never select attempt 2', async t => {
  assert.equal(classifyFailure('REFS_GATE_UNCONFIRMED', CLEAN_PROOF, 2).klass, 'CLEAN');
  assert.equal(isTransient('REFS_GATE_UNCONFIRMED'), false);
  assert.ok(PUMP_CODES.every(c => !isTransient(c)));
  const root = await tempRoot(t);
  const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
  await fs.mkdir(path.join(root, 'source', ...V2), { recursive: true });
  for (const n of ['invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(root, 'source', ...V2, n), '//');
  const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n START_TYPE : 3\r\n SERVICE_START_NAME : .\\clued-control\r\n';
  const fact = { contract: 'clued.independent-ci.resident-stage-fact/2', manifest_sha256: 'f'.repeat(64), state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null,
    scm_start_call_issued: true, original_binary_restored: true, complete_original_readback: true, configuration_conflict_detected: false, tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true, native_receipt_sha256: 'e'.repeat(64) };
  let answers = {};
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run: async a => (a[0].endsWith('sc.exe') ? { code: 0, stdout: a[1] === 'qc' ? SC_QC : 'STATE : 1 STOPPED\r\n PID : 0\r\n' } : { code: 0, stdout: JSON.stringify(fact) }),
    busy: () => false, sleep: async () => {}, clock: () => Date.now(), companionMailbox: { async send(kind) { return { kind }; }, async await(req) { return answers[req.kind]; } },
    paths: { sourceRoot: path.join(root, 'source'), workRoot: root, outboxRoot: root, nodeExe: 'C:\\node.exe', powershellExe: 'C:\\ps.exe', scExe: 'C:\\sc.exe' } });
  const batch = { batchId: 'b', key: 'a'.repeat(64), dir: root, stages: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: 'd'.repeat(64), workManifestSha256: 'f'.repeat(64) })) };
  const stages = validatePolicy(rawPolicy()).stages;
  answers = { 'check-refs': null };
  assert.equal((await engine.runStage(batch, stages[1], { firstLinux: true, betweenRoles: false })).code, 'REFS_GATE_UNCONFIRMED', 'no answer');
  answers = { 'check-refs': { ok: false, code: 'GITHUB_TRANSIENT_UNAVAILABLE' } };
  assert.equal((await engine.runStage(batch, stages[1], { firstLinux: true, betweenRoles: false })).code, 'REFS_GATE_UNCONFIRMED', 'a free-form refusal');
  answers = { 'check-refs': { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' } };
  assert.equal((await engine.runStage(batch, stages[1], { firstLinux: true, betweenRoles: false })).code, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  // the Windows stage succeeded; the companion's pump answer is not allow-listed -> never its code
  answers = { 'check-refs': { ok: true }, 'relay-stage': { ok: false, code: 'GITHUB_TRANSIENT_UNAVAILABLE' } };
  const r = await engine.runStage(batch, stages[1], { firstLinux: true, betweenRoles: false });
  assert.deepEqual([r.ok, r.code], [false, 'COMPANION_PUMP_UNCONFIRMED']);
  answers = { 'check-refs': { ok: true }, 'relay-stage': { ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE' } };
  assert.equal((await engine.runStage(batch, stages[1], { firstLinux: true, betweenRoles: false })).code, 'FORMAL_BRIDGE_STAGE_DEADLINE');
});

test('MINOR 4: a local ROLE_ALREADY_PUBLISHED_ON_HEAD is UNKNOWN (HALT), whatever the stage', () => {
  for (const stage of [3, 5, 7, 9]) assert.equal(classifyFailure('ROLE_ALREADY_PUBLISHED_ON_HEAD', CLEAN_PROOF, stage).klass, 'UNKNOWN');
});
