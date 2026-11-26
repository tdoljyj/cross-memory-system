// Task 30643342 (FABLE-botmerge-auth-carry-20261122 §1.5, §2 step 3, §3 T3): PR #1220 head def14fe1 was refused CLAIM_NOT_CURRENT at
// 02:41:14 (Beijing) and backed off to 03:20, though its holder had authorized the head at 02:41:00. Two things kept the wake from
// happening: the evaluation started with no protected observation of 30 seconds or younger (stage 10 runs every 10 minutes), so the
// first observation after the refusal only became the baseline, and the authorization had already happened before it; and every
// observation had to be 30 seconds or younger when the executor read it, though stage 10's own observation loop may take 30 seconds
// before the stage even ends. A refusal proves the head was not bound when it was evaluated: a fresh protected observation that says
// bound, for an authorization id this row has not woken for yet, wakes it at once (once per authorization id; every daily cap stays).
// These tests run the real queue, ledger and executor on offline ports (the stage engine, stage 10's observations, a fake clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TRIGGER_CONTRACT_V2 } from '../src/trigger.mjs';
import { SAFE_REFUSAL, CI_SOURCE, rawPolicy, executorFixture, fakeCompanion, fakeEngine, notAdmitted, BASE } from './helpers.mjs';
import { trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000;
const PR = 1220;
const HEAD = 'def14fe1'.padEnd(40, '0');
const TASK = '11111111-1111-4111-8111-111111111111';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const OTHER_CLAIM = '44444444-4444-4444-8444-444444444444';
const AUTH_A = 'a102af89-0000-4000-8000-000000000001';
const AUTH_B = 'b102af89-0000-4000-8000-000000000002';
const REFUSAL = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['pr_task_binding_head_not_authorized'] } };
const trigger = updatedAt => Buffer.from(JSON.stringify({ contract: TRIGGER_CONTRACT_V2, repo: 'tdoljyj/cross-memory-system', pr: PR, headSha: HEAD, baseSha: BASE,
  prUpdatedAt: new Date(updatedAt).toISOString() }));
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
const woke = async f => (await receiptTypes(f)).filter(x => x === 'queue-claim-changed').length;

// Native, as stage 1 and stage 10's read-only resolve see it. Stage 1 admits only a bound head whose claim is `admits`.
// native.observation: what stage 10 reports (null: it reports nothing for this PR). runMs: how long stage 10's run takes after it
// observed the PR (the observation loop and the stage's end).
async function field(t, { admits = CLAIM } = {}) {
  const native = { status: 'head_not_authorized', claim: CLAIM, authorization: null, report: true, runMs: 0, patch: null };
  const engine = fakeEngine();
  const run = engine.runStage;
  const stage1 = [];
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) {
      stage1.push(native.authorization);
      if (native.status !== 'bound' || native.claim !== admits) { engine.calls.push(['stage', 1]); return notAdmitted('CLAIM_NOT_CURRENT', REFUSAL); }
    }
    return run(batch, stage, o);
  };
  let f = null;
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD }) }, () => f.clock());
  const policy = rawPolicy(); policy.train.maintenanceEveryMs = MIN;
  f = await executorFixture(t, { engine, companion, policy, now: Date.parse('2026-11-21T18:41:14Z') });
  engine.runTrainStage = async mode => {
    engine.calls.push(['stage', 10, mode]);
    const claim = ['bound', 'head_not_authorized', 'handover_pending'].includes(native.status);
    const observation = { repository: policy.repo, scope: `project:${TASK}`, pr: PR, headSha: HEAD, baseSha: BASE, targetBranch: 'main',
      bindingStatus: native.status, taskId: TASK, claimId: claim ? native.claim : null, fence: claim ? 3 : null, epoch: claim ? 1 : null,
      headAuthorizationId: native.status === 'bound' ? native.authorization : null,
      observedAt: new Date(f.clock()).toISOString(), sourceManifestSha256: CI_SOURCE, ...native.patch };
    f.advance(native.runMs);
    return { ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
      outcome: { status: 'TRAIN_FACTS', sideEffects: 0, mayHavePublished: false },
      train: { ...trainFacts({ mode, at: new Date(f.clock()).toISOString(), onDuty: false, holders: [], mainSha: null, rules: null,
        front: null, revoke: [], ledger: null }), claimBindings: native.report ? [observation] : [] } };
  };
  return { f, native, stage1 };
}

// T: the first evaluation, with no protected observation before it (stage 10 has not run since the head arrived): refused
// CLAIM_NOT_CURRENT, the row waits 10 minutes.
async function refusedWithoutBaseline(f) {
  await f.drop(trigger(f.clock() - MIN));
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['NOT_ADMITTED', 'CLAIM_NOT_CURRENT']);
  const row = f.queue.row(PR);
  assert.deepEqual([row.state, row.reason], ['WAITING', 'CLAIM_NOT_CURRENT']);
  assert.equal(row.evalBinding ?? null, null, 'the evaluation had no protected observation of its own (#1220)');
  return row.nextAt;
}

test('T3a #1220: an authorization made before the refusal wakes the head at the first protected observation, without a baseline', async t => {
  const { f, native, stage1 } = await field(t);
  const at = f.clock();
  const nextAt = await refusedWithoutBaseline(f);
  // The holder authorized the head 14 seconds before the refusal was recorded (stage 1's Native read came first).
  native.status = 'bound'; native.authorization = AUTH_A;
  f.advance(MIN);
  await f.exec.tick(); // stage 10: the first observation after the refusal says bound
  const row = f.queue.row(PR);
  assert.equal(row.poke?.claimChanged, true, 'the first bound observation after a refusal is the change');
  assert.equal(row.poke.dueAt, f.clock(), 'due at once, no cool-down');
  const r = await f.exec.tick();
  assert.ok(f.clock() < nextAt, 'well before the back-off ends');
  assert.equal(r.state, 'COMPLETED', 'evaluated again and admitted');
  assert.deepEqual(stage1, [null, AUTH_A]);
  assert.deepEqual([f.queue.row(PR).state, f.queue.row(PR).origin], ['DONE', 'new-trigger']);
  assert.equal(await woke(f), 1);
  assert.ok(f.clock() - at < 10 * MIN, 'within one stage-10 period of the refusal');
});

test('T3b: one wake per authorization id; another authorization id wakes once more', async t => {
  // Stage 1 keeps refusing (the binding names another claim than the one Native admits), so the row keeps waiting.
  const { f, native, stage1 } = await field(t, { admits: OTHER_CLAIM });
  await refusedWithoutBaseline(f);
  native.status = 'bound'; native.authorization = AUTH_A;
  f.advance(MIN);
  await f.exec.tick(); // observation: bound A -> wake
  assert.equal((await f.exec.tick()).failureCode, 'CLAIM_NOT_CURRENT', 'woken for A and refused again');
  assert.deepEqual(stage1, [null, AUTH_A]);
  assert.equal(f.queue.row(PR).wokeAuth, AUTH_A);
  const nextAt = f.queue.row(PR).nextAt;
  // The same authorization id, observed again and again: never another wake.
  for (let i = 0; i < 5; i += 1) { f.advance(MIN); await f.exec.tick(); }
  assert.ok(f.clock() < nextAt);
  assert.deepEqual(stage1, [null, AUTH_A], 'the same authorization id woke the row once');
  assert.equal(await woke(f), 1);
  assert.equal(f.queue.row(PR).state, 'WAITING');
  // A new authorization id: one more wake.
  native.authorization = AUTH_B;
  f.advance(MIN);
  await f.exec.tick();
  assert.equal((await f.exec.tick()).failureCode, 'CLAIM_NOT_CURRENT');
  assert.ok(f.clock() < nextAt);
  assert.deepEqual(stage1, [null, AUTH_A, AUTH_B]);
  assert.equal(await woke(f), 2);
  for (let i = 0; i < 3; i += 1) { f.advance(MIN); await f.exec.tick(); }
  assert.deepEqual(stage1, [null, AUTH_A, AUTH_B], 'B woke it once too');
});

// §1.5-3 (open question): the observation loop alone may take 30 seconds (train-maintenance.mjs#observePRClaimBindings), and the
// executor used to keep only observations 30 seconds old or younger when it read them after the stage ended. The PR updated last
// (the one most likely waiting) is observed first. A baseline is taken first here, so only the observation's age decides; the 25-second
// run is the control.
for (const runMs of [25_000, 35_000]) test(`T3c: stage 10 takes ${runMs / 1000} seconds and observes the PR first: the observation is still used`, async t => {
  const { f, native, stage1 } = await field(t);
  const nextAt = await refusedWithoutBaseline(f);
  f.advance(MIN);
  await f.exec.tick(); // baseline: head_not_authorized
  assert.equal(typeof f.queue.row(PR).evalBinding, 'string', 'the baseline is there');
  native.status = 'bound'; native.authorization = AUTH_A;
  native.runMs = runMs; // the observation loop (at most 30 s) and the stage's own end
  f.advance(MIN);
  await f.exec.tick();
  assert.equal(f.queue.row(PR).poke?.claimChanged, true, 'an observation of this very stage-10 run is fresh, whatever its place in the loop');
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.ok(f.clock() < nextAt);
  assert.deepEqual(stage1, [null, AUTH_A]);
});

test('T3c guard: an observation stamped before this stage-10 run began, or after it ended, is never used', async t => {
  for (const change of ['before', 'after']) await t.test(change, async t => {
    const { f, native, stage1 } = await field(t);
    const nextAt = await refusedWithoutBaseline(f);
    native.status = 'bound'; native.authorization = AUTH_A; native.runMs = 35_000;
    f.advance(MIN);
    native.patch = { observedAt: new Date(change === 'before' ? f.clock() - 31_000 : f.clock() + 36_000).toISOString() };
    await f.exec.tick(); await f.exec.tick();
    assert.equal(f.queue.row(PR).nextAt, nextAt);
    assert.equal(f.queue.row(PR).state, 'WAITING');
    assert.equal(stage1.length, 1);
    assert.equal(await woke(f), 0);
  });
});

test('T3d guard: an observation that keeps saying no_live_claim never wakes the head', async t => {
  const { f, native, stage1 } = await field(t);
  const nextAt = await refusedWithoutBaseline(f);
  native.status = 'no_live_claim';
  for (let i = 0; i < 8; i += 1) { f.advance(MIN); await f.exec.tick(); }
  assert.ok(f.clock() < nextAt);
  assert.deepEqual([f.queue.row(PR).state, f.queue.row(PR).nextAt, stage1.length], ['WAITING', nextAt, 1]);
  assert.equal(await woke(f), 0);
  // head_not_authorized, as a refused head is: no wake either.
  native.status = 'head_not_authorized';
  f.advance(MIN); await f.exec.tick(); await f.exec.tick();
  assert.equal(stage1.length, 1);
});

test('T3e guard: an authorization after the first observation (the baseline) still wakes the head', async t => {
  const { f, native, stage1 } = await field(t);
  const nextAt = await refusedWithoutBaseline(f);
  f.advance(MIN);
  await f.exec.tick(); // baseline: head_not_authorized
  assert.equal(typeof f.queue.row(PR).evalBinding, 'string');
  assert.equal(stage1.length, 1);
  native.status = 'bound'; native.authorization = AUTH_A;
  f.advance(MIN);
  await f.exec.tick();
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.ok(f.clock() < nextAt);
  assert.deepEqual(stage1, [null, AUTH_A]);
});
