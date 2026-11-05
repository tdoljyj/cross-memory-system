// The stage outcome travels from the Source's stage fact to the executor (resident quota redesign v0.6 + §9, phase 1,
// item 4: outcome, reason, sideEffects, diagnostic, reasonCodes, nativeReasonCodes, ci_retry_after, the merge-queue
// entry and safeToRerun), and the executor releases or burns a stage-1 failure by the failure table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { QUEUE_STATES, parseStageFact, parseStageOutcome } from '../src/engine-windows.mjs';
import { MERGE_QUEUE_STATES } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/queue-facts.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { buildStageFact } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { BASE, HEAD, SAFE_REFUSAL, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, notAdmitted, triggerBytes } from './helpers.mjs';

const M = 'f'.repeat(64);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const refusedFact = outcome => ({ contract: 'clued.independent-ci.resident-stage-fact/2', stage: 1, nonce: 'n'.repeat(32), manifest_sha256: M, state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED',
  failure_code: 'TASK_CI_HEAD_CAP_REACHED', scm_start_call_issued: true, original_binary_restored: true, complete_original_readback: true, configuration_conflict_detected: false,
  tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true, native_receipt_sha256: 'a'.repeat(64), outcome, relay: null, broker_no_launch: false });

test('the stage fact\'s outcome reaches the executor whole: diagnostic codes, ci_retry_after, the queue entry, safeToRerun', () => {
  const outcome = { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, safeToRerun: true,
    diagnostic: { verdict: 'REJECTED', nativeVerdict: 'REJECTED', ownerReviewKind: 'UNKNOWN', reasonCodes: ['task_ci_head_cap_reached'], nativeReasonCodes: ['task_ci_head_cap_reached'],
      ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: false, state: null, position: null } },
    scheduling: { ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: true, state: 'waiting', position: 3 } } };
  const f = parseStageFact(JSON.stringify(refusedFact(outcome)), M);
  assert.deepEqual([f.ok, f.code, f.brokerNoLaunch], [false, 'TASK_CI_HEAD_CAP_REACHED', false]);
  // the fixed owner-review kind survives the resident's second filter (3bf77462: bounded issuer diagnostics)
  assert.deepEqual(f.outcome, { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, safeToRerun: true,
    diagnostic: { verdict: 'REJECTED', nativeVerdict: 'REJECTED', ownerReviewKind: 'UNKNOWN', reasonCodes: ['task_ci_head_cap_reached'], nativeReasonCodes: ['task_ci_head_cap_reached'], ciRetryAfter: '2026-10-22T12:00:00.000Z',
      mergeQueue: { entered: false, state: null, position: null } },
    scheduling: { ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: true, state: 'waiting', position: 3 }, claimExpiresAt: null } });
  // generation 12 (DESIGN §56.3): the claim's lease end passes when it is a time
  assert.equal(parseStageOutcome({ ...outcome, scheduling: { ...outcome.scheduling, claimExpiresAt: '2026-10-22T13:00:00.000Z' } }).scheduling.claimExpiresAt, '2026-10-22T13:00:00.000Z');
  // re-validated to fixed shapes: nothing malformed passes, and a flag never survives side effects
  assert.equal(parseStageOutcome({ ...outcome, sideEffects: 1, mayHavePublished: true }).safeToRerun, false);
  assert.equal(parseStageOutcome({ ...outcome, status: 'blocked' }), null);
  assert.equal(parseStageOutcome({ ...outcome, reason: 'has spaces in it' }), null);
  assert.deepEqual(parseStageOutcome({ ...outcome, diagnostic: { reasonCodes: ['Free Text', 'ok_code'], ciRetryAfter: 'soon' } }).diagnostic.reasonCodes, ['ok_code']);
  assert.equal(parseStageOutcome({ ...outcome, diagnostic: { ciRetryAfter: 'soon' } }).diagnostic.ciRetryAfter, null);
  assert.equal(parseStageOutcome({ ...outcome, scheduling: { mergeQueue: { entered: true, state: 'lapsed', position: 2 } } }).scheduling.mergeQueue.entered, false);
  // Native's 'none' (a claim with the ref but no entry) is kept as itself: the same states as the Source's
  assert.deepEqual([...QUEUE_STATES], [...MERGE_QUEUE_STATES]);
  assert.deepEqual(parseStageOutcome({ ...outcome, scheduling: { mergeQueue: { entered: false, state: 'none', position: null } } }).scheduling.mergeQueue, { entered: false, state: 'none', position: null });
  assert.equal(parseStageFact(JSON.stringify(refusedFact(null)), M).outcome, null);
});

test('the Source\'s broker no-launch fact parses to brokerNoLaunch, and only with the original read back', () => {
  const broker = { contract: 'x', requestId: '0a1b2c3d-0000-4000-8000-000000000001', ok: false, code: 'BROKER_REQUEST_EXPIRED', started: false, startCallIssued: false, helperPid: null,
    stoppedInTime: false, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false };
  const fact = buildStageFact({ stage: 1, nonce: 'a'.repeat(32), plan: { stage: 1 }, planSha256: 'b'.repeat(64), workManifestSha256: M, broker });
  const parsed = parseStageFact(JSON.stringify(fact), M);
  assert.deepEqual([parsed.ok, parsed.code, parsed.brokerNoLaunch, parsed.proof.serviceOriginalStopped], [false, 'BROKER_REQUEST_EXPIRED', true, true]);
  assert.equal(parseStageFact(JSON.stringify({ ...fact, original_binary_restored: false }), M).brokerNoLaunch, false);
  assert.equal(parseStageFact(JSON.stringify({ ...fact, scm_start_call_issued: true }), M).brokerNoLaunch, false);
});

test('stage 1: released only on the outcome\'s safeToRerun or the broker\'s no-launch; otherwise the head is burned', async t => {
  // NATIVE_NOT_ADMITTED without the flag (for example a re-evaluation with a batch claim already recorded): burned
  const burn = await executorFixture(t, { engine: fakeEngine({ stages: { 1: notAdmitted('NATIVE_NOT_ADMITTED', { ...SAFE_REFUSAL, safeToRerun: false }) } }) });
  await burn.drop(triggerBytes());
  const r = await burn.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'NATIVE_NOT_ADMITTED']);
  assert.equal(await burn.ledger.headBurned(headKey(subject())), true);
  const t1 = (await burn.ledger.state(batchKey(subject()))).terminal.facts;
  assert.deepEqual([t1.class, t1.retry, t1.reason, t1.safeToRerun], ['not-admitted', 'new-trigger', 'full_admission_rejected', false]);

  // the broker refused stage 1 before any launch and re-read the original: released as BROKER_NOT_LAUNCHED
  const broker = await executorFixture(t, { engine: fakeEngine({ stages: { 1: { ok: false, code: 'BROKER_REQUEST_EXPIRED', proof: WINDOWS_CLEAN, outcome: null, brokerNoLaunch: true } } }) });
  await broker.drop(triggerBytes());
  const b = await broker.exec.tick();
  assert.deepEqual([b.state, b.release], ['NOT_EXECUTED', 'BROKER_NOT_LAUNCHED']);
  assert.equal(await broker.ledger.headBurned(headKey(subject())), false);
  const moved = await fs.readdir(path.join(broker.root, 'state', 'ledger-unexecuted'));
  const record = JSON.parse(await fs.readFile(path.join(broker.root, 'state', 'ledger-unexecuted', moved[0], '90-terminal.json'), 'utf8'));
  assert.deepEqual([record.reason, record.facts.class, record.facts.brokerNoLaunch], ['BROKER_NOT_LAUNCHED', 'environment', true]);
  // a later trigger of the same head is held by the cool-down (the row's own 10-minute back-off)
  await broker.drop(triggerBytes());
  assert.equal((await broker.exec.tick()).state, 'IDLE');
  assert.deepEqual([broker.queue.row(884).state, broker.queue.row(884).nextAt - broker.clock() > 0], ['BACKOFF', true]);

  // a waiting-class refusal with the flag: released; the stage-terminal receipt keeps the codes and ci_retry_after
  const cap = { ...SAFE_REFUSAL, diagnostic: { verdict: 'REJECTED', nativeVerdict: 'REJECTED', reasonCodes: ['task_ci_head_cap_reached'], nativeReasonCodes: [], ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: null },
    scheduling: { ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: false, state: null, position: null } } };
  const waiting = await executorFixture(t, { engine: fakeEngine({ stages: { 1: notAdmitted('TASK_CI_HEAD_CAP_REACHED', cap) } }) });
  await waiting.drop(triggerBytes());
  assert.equal((await waiting.exec.tick()).state, 'NOT_ADMITTED');
  const names = (await fs.readdir(path.join(waiting.root, 'state', 'receipts'))).filter(n => n.includes('stage-terminal'));
  const receipt = JSON.parse(await fs.readFile(path.join(waiting.root, 'state', 'receipts', names[0]), 'utf8')).body;
  assert.deepEqual([receipt.outcome.safeToRerun, receipt.outcome.reasonCodes, receipt.outcome.ciRetryAfter, receipt.outcome.mergeQueue],
    [true, ['task_ci_head_cap_reached'], '2026-10-22T12:00:00.000Z', { entered: false, state: null, position: null }]);
});

test('after 10-started nothing is released, whatever the outcome says', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 3: { ok: false, code: 'PUBLICATION_BLOCKED', proof: WINDOWS_CLEAN, outcome: { ...SAFE_REFUSAL, reason: 'x_y' } } } }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PUBLICATION_BLOCKED']);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
});
