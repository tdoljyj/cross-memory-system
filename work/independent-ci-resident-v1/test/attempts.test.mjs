// The one automatic attempt 2 (Owner decision 1b5d3687) and the Source v2 failure catalogue mirror (S11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchKey, headKey } from '../src/ledger.mjs';
import { attempt2Decision, ATTEMPT2_STAGES } from '../src/attempts.mjs';
import { classifyFailure, NOT_ADMITTED_CODES, TRANSIENT_CODES, CLEAN_FINAL_CODES, UNKNOWN_CODES } from '../src/classify.mjs';
import { validatePolicy } from '../src/policy.mjs';
import * as source from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { BASE, CLEAN_PROOF, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const policy = validatePolicy(rawPolicy());

test('the resident catalogue mirrors the installed Source catalogue exactly', () => {
  assert.deepEqual([...NOT_ADMITTED_CODES], [...source.NOT_ADMITTED_CODES]);
  assert.deepEqual([...TRANSIENT_CODES], [...source.TRANSIENT_CODES]);
  assert.deepEqual([...CLEAN_FINAL_CODES], [...source.CLEAN_FINAL_CODES]);
  assert.deepEqual([...UNKNOWN_CODES], [...source.UNKNOWN_CODES]);
  for (const c of source.ALL_STAGE_CODES) {
    const k = classifyFailure(c, CLEAN_PROOF, 3).klass;
    assert.equal(k, source.UNKNOWN_CODES.includes(c) ? 'UNKNOWN' : 'CLEAN', c);
  }
  for (const c of source.NOT_ADMITTED_CODES) assert.equal(classifyFailure(c, WINDOWS_CLEAN, 1).klass, 'NOT_ADMITTED', c);
  assert.equal(classifyFailure('REMOTE_REFS_CHANGED_SINCE_BUNDLE', { ...CLEAN_PROOF, linuxUnitsInactive: false }, 2).klass, 'UNKNOWN', 'transient still needs the proof');
});

test('attempt-2 decision: clean transient, attempt 1, before any role publication, enabled; nothing else', () => {
  const ok = { policy, subject: subject(), outcome: 'FAILED_CLEAN', failure: { code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', stageNumber: 2, phase: 'stage' } };
  assert.deepEqual(attempt2Decision(ok), { eligible: true, reason: null });
  assert.deepEqual(ATTEMPT2_STAGES, [0, 1, 2]);
  assert.equal(attempt2Decision({ ...ok, failure: { ...ok.failure, stageNumber: 1, code: 'NATIVE_ADMISSION_UNAVAILABLE' } }).eligible, true);
  assert.equal(attempt2Decision({ ...ok, failure: { code: 'BRIDGE_TRANSPORT_TIMEOUT', stageNumber: 0, phase: 'workspace' } }).eligible, true);
  assert.equal(attempt2Decision({ ...ok, failure: { code: 'BRIDGE_TRANSPORT_TIMEOUT', stageNumber: 0, phase: 'bundle' } }).reason, 'ATTEMPT2_ROLE_MAY_BE_PUBLISHED');
  for (const stageNumber of [3, 4, 5, 6, 7, 8]) assert.equal(attempt2Decision({ ...ok, failure: { ...ok.failure, stageNumber } }).reason, 'ATTEMPT2_ROLE_MAY_BE_PUBLISHED');
  for (const code of ['STAGE_CHILD_REFUSED', 'PUBLICATION_UNCERTAIN', 'EVIDENCE_IDENTITY_CONFLICT', 'BATCH_CLAIM_CHANGED', 'NATIVE_NOT_ADMITTED', 'PUBLICATION_BLOCKED'])
    assert.equal(attempt2Decision({ ...ok, failure: { ...ok.failure, code } }).reason, 'ATTEMPT2_REQUIRES_TRANSIENT_CODE', code);
  assert.equal(attempt2Decision({ ...ok, outcome: 'FAILED_UNKNOWN' }).reason, 'ATTEMPT2_REQUIRES_CLEAN_FAILURE');
  assert.equal(attempt2Decision({ ...ok, subject: subject({ attempt: 2 }) }).reason, 'ATTEMPT2_ONLY_AFTER_ATTEMPT1');
  assert.equal(attempt2Decision({ ...ok, policy: validatePolicy(rawPolicy({ automaticAttempt2: { enabled: false, delayMs: 600_000 } })) }).reason, 'ATTEMPT2_DISABLED');
});

test('a push between bundle and scan (stage 2) runs attempt 2 once after the delay, under its own keys', async t => {
  let n = 0;
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage));
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.equal(first.state, 'FAILED_CLEAN');
  assert.equal(first.attempt2, batchKey(subject({ attempt: 2 })));
  assert.equal((await f.exec.tick()).state, 'IDLE', 'not before the delay');
  f.advance(600_000);
  const second = await f.exec.tick();
  assert.deepEqual([second.state, second.key], ['COMPLETED', batchKey(subject({ attempt: 2 }))]);
  assert.deepEqual(stagesRun(engine), [1, 2, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(await f.ledger.headBurned(headKey(subject({ attempt: 2 }))), true);
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'consumed by reserving attempt 2');
  f.advance(600_000);
  assert.equal((await f.exec.tick()).state, 'IDLE', 'never an attempt 3');
  // a new trigger for the head is still refused (attempt 1's head is burned)
  await f.drop(triggerBytes({ pr: 990 }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
});

test('attempt 2 of a PR merged in the meantime is closed, never run, and the PR leaves the queue (rule 41ab823a)', async t => {
  let n = 0, state = 'open';
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage));
  const f = await executorFixture(t, { engine, companion: fakeCompanion({ pull: pr => ({ number: pr, state, headSha: HEAD }) }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'FAILED_CLEAN');
  state = 'merged';
  f.advance(600_000);
  const second = await f.exec.tick();
  assert.deepEqual([second.state, second.reason], ['IGNORED', 'ATTEMPT2_PR_CLOSED']);
  assert.deepEqual(stagesRun(engine), [1, 2], 'attempt 2 ran no stage');
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'attempt 2 is closed for good');
  assert.deepEqual([f.queue.row(884).state, f.queue.row(884).reason], ['DONE', 'PR_CLOSED']);
  f.advance(600_000);
  assert.equal((await f.exec.tick()).state, 'IDLE');
});

test('attempt 2 that fails transiently again ends FAILED_CLEAN with no further attempt', async t => {
  const engine = fakeEngine({ stages: { 2: { ok: false, code: 'BRIDGE_TRANSPORT_TIMEOUT', proof: WINDOWS_CLEAN } } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  f.advance(600_000);
  const second = await f.exec.tick();
  assert.equal(second.state, 'FAILED_CLEAN');
  assert.equal(second.attempt2, undefined);
  f.advance(600_000);
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(stagesRun(engine), [1, 2, 1, 2]);
});

test('no attempt 2 after a role may have been published, for a final code, or for an unknown ending', async t => {
  for (const [stages, expect] of [
    [{ 3: { ok: false, code: 'GITHUB_TRANSIENT_UNAVAILABLE', proof: WINDOWS_CLEAN } }, 'FAILED_CLEAN'],
    [{ 2: { ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN } }, 'FAILED_CLEAN'],
    [{ 2: { ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN } }, 'HALTED'],
  ]) {
    const engine = fakeEngine({ stages });
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.equal(r.state, expect);
    assert.equal(r.attempt2, undefined);
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  }
});

test('a deferred attempt 2 stays pending; a transient stage-1 failure is eligible (its check is attempt-scoped)', async t => {
  let ready = true;
  const companion = fakeCompanion();
  companion.heartbeat = async () => (ready ? { at: Date.parse('2026-10-20T12:00:00Z') + 10 * 60_000 } : null);
  let n = 0;
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage) => (stage.number === 1 && ++n === 1 ? (engine.calls.push(['stage', 1]), { ok: false, code: 'NATIVE_ADMISSION_UNAVAILABLE', proof: WINDOWS_CLEAN }) : base(batch, stage));
  const f = await executorFixture(t, { engine, companion });
  companion.heartbeat = async () => (ready ? { at: f.clock() } : null);
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  f.advance(600_000);
  ready = false;
  assert.deepEqual([(await f.exec.tick()).reason], ['COMPANION_NOT_READY']);
  assert.equal((await f.ledger.pendingAttempts2()).length, 1);
  ready = true;
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});
