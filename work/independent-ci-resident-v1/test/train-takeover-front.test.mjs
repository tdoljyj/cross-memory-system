// Generation 19 field defect (2026-11-07, PR #1027): the train went on, its take-over full sweep began (hours long), the queue was
// empty; then a PR was pushed whose claim was the merge queue's head. Nothing ever bound the claim to the PR (only an admission
// stage 1 does, and the take-over gate held every batch), so stage 10 said FRONT_NOT_BOUND, never wrote the strict current-front
// observation and never opened the front batch: the PR waited for the whole full sweep.
// End to end over the real resident executor and the real Source v2 stage 10 (runTrain), sweep store, green ledger and stage-8
// publisher, with offline GitHub and Native ports: the queue head's PR gets App 5368905's kooyumi-merge-slot success while the full
// sweep is still running, and no other PR runs anything before the take-over sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { executorFixture, fakeCompanion, fakeEngine, rawPolicy, relayedRow, triggerBytes, RELAY_ON, SOURCE, CI_SOURCE } from './helpers.mjs';
import { setup, holderOf, sha, iso, T, H, S, CLAIM, REPO, NOW } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { tempDir, admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { runTrain } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-maintenance.mjs';
import { makeTrainRun } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/train-run.mjs';
import { batchJobsV2, claimGeneration } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { createFixtureControlPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';

const MIN = 60_000;
const SCOPE = 'project:00000000-0000-4000-8000-000000000000';
const OTHER_CLAIM = '99999999-8888-4777-8666-555555555555';
const PROOF = { windowsTreeZero: true, serviceOriginalStopped: true };
const policy = (nonFrontRuns = true, extra = {}) => rawPolicy({ contract: POLICY_CONTRACT_V8, ...extra,
  train: { enabled: 'on', nonFrontRuns, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS } });
const body = claim => `Change.\n\nClued-Work-Claim: ${claim}\nClued-Work-Scope: ${SCOPE}\n`;
const slotGreen = (e, head) => [...e.gh.world.checks.values()].find(c => c.app.id === 5368905 && c.name === 'kooyumi-merge-slot' && c.head_sha === head
  && c.status === 'completed' && c.conclusion === 'success');

// The world: GitHub (strict on, merge only, App-pinned required checks), Native (one ACTIVE node of this CI Source), a history that
// keeps the full sweep running for hours (every full-sweep page read outlasts the stage's sweep budget), and an empty queue.
// quick: every full-sweep page read is instant, so the take-over sweep completes within a few stage-10 runs (the steady state).
async function world(t, { quick = false } = {}) {
  const e = await setup(t, { strict: true, fullDone: false, tick: 0 });
  e.native.holders = [];
  e.gh.world.pulls.delete(910);
  for (let n = 1; n <= 300; n++) e.gh.pull(n, { state: 'closed', head: sha(0x9000 + n), updated: iso(NOW - 30 * 86_400_000) });
  if (!quick) e.gh.world.hooks.pullsPage = sort => { if (sort === 'created') e.now += 160_000; };
  // The PR as GitHub answers it, with its body and head repository (the fixture's PR read is reduced).
  const read = e.gh.readPullRequest.bind(e.gh);
  e.gh.readPullRequest = async n => { const p = e.gh.world.pulls.get(n); return { ...(await read(n)), body: p.body ?? null, draft: p.draft === true,
    head: { sha: p.head, ref: `topic-${n}`, repo: { full_name: p.headRepo ?? REPO } } }; };
  e.native.port.nodesStatus = async () => ({ deployed: true, onDuty: true, dropped: 0,
    nodes: [{ node: { name: 'fixture-node', sourceManifestSha256: CI_SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(e.now) } }] });
  return e;
}

// The engine: stage 10 is the real Source v2 runTrain; stage 1 of a batch binds the PR's claim on Native (verify with pr_ref, as the
// admission stage does) and publishes kooyumi-work-admission; stage 8 of a front batch is the real control publisher.
function engineFor(e, at, script = {}) {
  const subjects = new Map(), stages = [];
  let run = 0;
  const engine = fakeEngine(script);
  engine.subjects = subjects;
  engine.stages = stages;
  // Task e30b5a36: what each stage-10 run decided and how many full-sweep pages (pulls sorted by created) it read.
  engine.trainRuns = [];
  // As the real derivation (Source v2 derive-batch.mjs): the batch subject and key carry the resident's installed-files manifest
  // (policy sourceManifestSha256, SOURCE), while every job of the batch carries the install record's CI Source (CI_SOURCE).
  engine.derive = async (subject, key) => { engine.calls.push(['derive', key]); subjects.set(key, subject);
    return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: 'c'.repeat(64), ciSourceManifestSha256: CI_SOURCE }; };
  engine.runTrainStage = async (mode, input) => {
    engine.calls.push(['stage', 10, mode]);
    e.now = at.clock();
    const { mode: m, ...params } = input;
    const runId = `${(++run).toString(16).padStart(16, '0')}-0123456789ab`;
    const job = makeTrainRun({ repo: REPO, runId, mode: m, sourceManifestSha256: CI_SOURCE, createdAt: iso(e.now), ...params });
    const created = () => e.gh.world.calls.filter(c => c === 'pulls-created').length, before = created(), began = e.now;
    const r = await runTrain({ job, github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep,
      claimScope: SCOPE });
    engine.trainRuns.push({ decision: r.facts.decision, frontBind: r.facts.frontBind ?? null, open: r.facts.openFrontBatch !== null, created: created() - before,
      ms: e.now - began, full: r.facts.sweep?.fullSweep?.state ?? null });
    at.advance(e.now - at.clock());
    engine.lastFacts = r.facts;
    return { ok: true, runId, proof: PROOF, train: r.facts,
      outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: r.sideEffects, mayHavePublished: r.sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false } };
  };
  engine.runStage = async (batch, stage) => {
    const subject = subjects.get(batch.key);
    stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha ?? null, stage: stage.number });
    engine.calls.push(['stage', stage.number]);
    const ok = { ok: true, factsSha256: 'd'.repeat(64), proof: PROOF };
    if (stage.number === 1) {
      const pr = e.gh.world.pulls.get(subject.pr);
      // Native binds the claim the PR names to the PR (migration 20261003200000: only the ci-admission verify with pr_ref does).
      if (pr.claim && e.native.holder?.claimId === pr.claim) e.native.holder = { ...e.native.holder, boundPr: `${REPO}#${subject.pr}`, pr: subject.pr };
      e.gh.green(10, subject.headSha, { name: 'kooyumi-work-admission' });
      return ok;
    }
    if (stage.number !== 8) return ok;
    if (!subject.testSha) return { ok: false, code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', proof: PROOF,
      outcome: { status: 'BLOCKED', reason: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', sideEffects: 0, mayHavePublished: false } };
    e.now = at.clock();
    for (const [i, name] of ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement'].entries()) e.gh.green(10 + i, subject.headSha, { name });
    const claim = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(e.now + 3_600_000) };
    // The field model (generation 21, PR #1029): the batch subject names SOURCE, its stage-8 jobs (stage-08/jobs.json) name CI_SOURCE,
    // the same Source as stage 10's proof and the node heartbeat. One SOURCE everywhere hid the executor's mismatch.
    assert.equal(subject.sourceManifestSha256, SOURCE);
    const jobs = batchJobsV2({ repo: REPO, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.testSha,
      sourceManifestSha256: CI_SOURCE, createdAt: iso(e.now), attempt: 1 });
    const publisher = createFixtureControlPublisherV2({ github: e.gh, journal: await EffectJournal.open(path.join(await tempDir(at.t), 'effects')),
      trainMode: 'on', batchClaim: claimGeneration(claim), slotNative: e.native.port, sweepStore: e.store, greenLedger: e.ledger,
      pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
      admission: { async evaluatePr(job, packet, options) { const { observationSha256, ...facts } = admittedFacts(job, claim, packet,
        { domain: 'fixture', mergeQueueHead: true, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 });
        return { ...facts, observationSha256: digest(facts) }; } },
      assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep });
    const published = await publisher.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: e.now + 90_000 });
    at.advance(e.now - at.clock());
    engine.published = published;
    return published.status === 'SETTLED' ? ok : { ok: false, code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', proof: PROOF,
      outcome: { status: 'BLOCKED', reason: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', sideEffects: 0, mayHavePublished: false } };
  };
  return engine;
}

// Task 7100ff62: with nonFrontRuns false the schedule kept only the front rows (S), so the binding run (no S) was deferred as
// TRAIN_NON_FRONT_RUNS_OFF and the claim was never bound. The binding run is the front's own prelude: it runs under both settings.
for (const nonFrontRuns of [true, false]) test(`take-over front (gen 19 PR #1027): a queue-head PR pushed after train=on gets the merge-slot green within 30 minutes while the full sweep still runs (nonFrontRuns ${nonFrontRuns})`, async t => {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at);
  const f = await executorFixture(t, { policy: policy(nonFrontRuns), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();

  // train=on has just taken effect: the take-over full sweep starts and runs (it needs hours here); the queue is empty.
  for (let i = 0; i < 3; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.equal(f.exec.trainTakeoverDone, false);
  assert.equal(engine.lastFacts.sweep.fullSweep.state, 'running', JSON.stringify(engine.lastFacts.sweep));
  assert.equal(engine.lastFacts.wouldDo, 'NO_FRONT');

  // The claim joins the merge queue and is its head (unbound: no admission ran for it yet); its PR is pushed. Another PR, whose claim
  // is not the head, is pushed too.
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  e.gh.pull(911, { head: sha(0x7777), updated: iso(arrival), body: body(OTHER_CLAIM), claim: OTHER_CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  await f.drop(triggerBytes({ pr: 911, headSha: sha(0x7777), baseSha: T }));

  let green = null, sweepAtGreen = null;
  for (let i = 0; i < 40 && !green; i++) {
    await f.exec.tick();
    green = slotGreen(e, H);
    if (green) sweepAtGreen = await e.store.readFullSweepStrict('on');
    else f.advance(MIN);
  }
  const elapsed = f.clock() - arrival;
  assert.ok(green, `no kooyumi-merge-slot success for the queue head's PR; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo}; `
    + `stages ${JSON.stringify(engine.stages)}`);
  assert.ok(elapsed <= 30 * MIN, `first green after ${Math.round(elapsed / MIN)} minutes`);
  t.diagnostic(`first kooyumi-merge-slot success ${Math.round(elapsed / 1000)} s (simulated) after the PR arrived; full sweep ${sweepAtGreen.full.state}`);
  // It is the strict current-front route: the full sweep is still running and the take-over is not done.
  assert.equal(f.exec.trainTakeoverDone, false);
  assert.equal(sweepAtGreen.full.state, 'running');
  assert.equal(f.exec.trainSweep.fullSinceOn, false);
  assert.equal(engine.published.status, 'SETTLED');
  // The PR's own run went only as far as binding the claim (stage 1), then the front batch (S) ran in full.
  const own = engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage);
  assert.deepEqual(own, [1], 'the binding run publishes stage 1 only');
  const [bound] = (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body).filter(b => b.failureCode === 'TRAIN_FRONT_CLAIM_BOUND');
  assert.ok(bound, 'the binding run ends cleanly after stage 1');
  assert.ok(engine.stages.some(s => s.pr === 910 && s.testSha === S && s.stage === 8));
  // The PR whose claim is not the queue head runs nothing before the take-over sweep.
  assert.deepEqual(engine.stages.filter(s => s.pr === 911), []);
  assert.equal(f.queue.row(911).state, 'QUEUED');
  // Task e30b5a36 (generation 22 cold start): the run that named the binding and the run that opened the front batch read no
  // full-sweep page (each spent about 2.6 minutes on it in the field); the take-over full sweep waits for the following runs.
  const bindRuns = engine.trainRuns.filter(r => r.frontBind), openRuns = engine.trainRuns.filter(r => r.decision === 'OPEN_FRONT_BATCH');
  assert.ok(bindRuns.length >= 1 && openRuns.length >= 1, JSON.stringify(engine.trainRuns));
  assert.deepEqual([...bindRuns, ...openRuns].map(r => r.created), [...bindRuns, ...openRuns].map(() => 0), JSON.stringify(engine.trainRuns));
  t.diagnostic(`binding run ${bindRuns.map(r => r.ms / 1000)} s, open run ${openRuns.map(r => r.ms / 1000)} s (simulated)`);
  // Those pages wait for the later runs: the take-over full sweep still advances to its end and the take-over completes (from here on
  // a full-sweep page read is instant, as in the quick world, or this history would never end).
  e.gh.world.hooks.pullsPage = null;
  const after = engine.trainRuns.length;
  for (let i = 0; i < 40 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.ok(engine.trainRuns.slice(after).some(r => r.created > 0), JSON.stringify(engine.trainRuns.slice(after)));
  // A run that only refreshed the running front batch's observation (TRAIN_FRONT_BATCH_RUNNING) may skip the pages too, but only right
  // after a run that read them: from the open run on, no two runs in a row skip.
  const fromOpen = engine.trainRuns.slice(engine.trainRuns.indexOf(openRuns[0]));
  t.diagnostic(`runs from the open: ${fromOpen.map(r => `${r.decision}:${r.created}`).join(' ')}`);
  for (let i = 1; i < fromOpen.length; i++) if (fromOpen[i].created === 0 && fromOpen[i].full === 'running') {
    assert.equal(fromOpen[i].decision, 'TRAIN_FRONT_BATCH_RUNNING', JSON.stringify(fromOpen));
    assert.ok(fromOpen[i - 1].created > 0, JSON.stringify(fromOpen));
  }
  assert.equal(f.exec.trainTakeoverDone, true, `take-over not done: ${JSON.stringify(engine.lastFacts?.sweep)}`);
  assert.equal((await e.store.readFullSweepStrict('on')).full.state, 'complete');
});

// Task ad19ef19: after the take-over (the steady state) with nonFrontRuns true, a new PR whose claim is the queue head runs an ordinary
// batch (no S): its stage 1 binds the claim, stages 1-7 pass and its stage 8 rests at B (TRAIN_SINGLE_GREEN_NOT_PROVEN: in train on only a
// front job can get the merge slot). Before the fix that row kept the PR busy: stage 10 counted and touched the front batch, the executor
// refused it (TRAIN_FRONT_PR_BUSY), stage 10 then said TRAIN_FRONT_BATCH_RUNNING, and no merge-slot green came within the hour.
async function steadyState(t, { relay = false } = {}) {
  const e = await world(t, { quick: true });
  const at = { t };
  const engine = engineFor(e, at, relay ? { relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role, H)) }) } : {});
  const f = await executorFixture(t, { policy: policy(true, relay ? { relay: RELAY_ON } : {}), engine, now: NOW,
    ...(relay ? { companion: fakeCompanion({ hint: () => null }) } : {}) });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  for (let i = 0; i < 12 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.equal(f.exec.trainTakeoverDone, true, `take-over not done: ${JSON.stringify(engine.lastFacts?.sweep)}`);
  assert.deepEqual(engine.stages, []);
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const refused = async () => (await f.receipts.latest(['train-front-refused'], 50)).map(r => r.value.body.failureCode);
  const terminals = async () => (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body.failureCode);
  return { e, f, engine, arrival, refused, terminals };
}

test('steady state (task ad19ef19): a queue-head PR pushed after the take-over gets the merge-slot green within 30 minutes', async t => {
  const { e, f, engine, arrival, refused, terminals } = await steadyState(t);
  let green = null;
  for (let i = 0; i < 60 && !green; i++) {
    await f.exec.tick();
    green = slotGreen(e, H);
    if (!green) f.advance(MIN);
  }
  const elapsed = f.clock() - arrival;
  assert.ok(green, `no kooyumi-merge-slot success after ${Math.round(elapsed / MIN)} minutes; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo}; `
    + `front refusals ${JSON.stringify(await refused())}; stages ${JSON.stringify(engine.stages)}`);
  assert.ok(elapsed <= 30 * MIN, `first green after ${Math.round(elapsed / MIN)} minutes`);
  t.diagnostic(`steady state: first kooyumi-merge-slot success ${Math.round(elapsed / 1000)} s (simulated) after the PR arrived`);
  assert.ok(engine.stages.some(s => s.pr === 910 && s.testSha === S && s.stage === 8));
  assert.equal(engine.published.status, 'SETTLED');
  // The fix: the ordinary batch resting at B gave way at once (one stage-8 try, no busy refusal), ending cleanly as TRAIN_FRONT_TAKES_OVER.
  assert.deepEqual(await refused(), [], 'the front batch is never refused as busy');
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok((await terminals()).includes('TRAIN_FRONT_TAKES_OVER'), JSON.stringify(await terminals()));
  assert.equal((await f.receipts.latest(['train-front-takes-over'], 5)).length, 1);
});

// The same at parking point A: Stage R on and no hosted signal, so the ordinary batch rests at A right after its stage 1 bound the claim.
// It gives way the same way and the front batch starts. (With relay on, a front batch then waits for RELAY_PROVIDER_TRANSFER_REQUIRED by
// the Owner's once-per-head rule 41ab823a, unrelated to this fix; the shipped policies keep relay off, where A never happens.)
test('steady state (task ad19ef19): an ordinary batch resting at parking point A gives way to the front batch of its head', async t => {
  const { f, engine, refused, terminals } = await steadyState(t, { relay: true });
  for (let i = 0; i < 30 && !engine.stages.some(s => s.testSha === S); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(await refused(), [], 'the front batch is never refused as busy');
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage), [1], 'the ordinary batch ran stage 1 only');
  assert.ok(engine.stages.some(s => s.pr === 910 && s.testSha === S && s.stage === 1), `front batch not started: ${JSON.stringify(engine.stages)}`);
  assert.ok((await terminals()).includes('TRAIN_FRONT_TAKES_OVER'), JSON.stringify(await terminals()));
});

test('take-over front: no binding run without strict, for a PR that names another claim, or for two PRs naming the head claim', async t => {
  for (const change of ['strict-off', 'other-claim', 'ambiguous', 'draft']) await t.test(change, async t => {
    const e = await world(t);
    const at = { t };
    const engine = engineFor(e, at);
    const f = await executorFixture(t, { policy: policy(), engine, now: NOW });
    Object.assign(at, { clock: f.clock, advance: f.advance });
    await f.exec.trainRecover();
    await f.exec.tick(); f.advance(10 * MIN);
    if (change === 'strict-off') e.gh.world.strict = false;
    const arrival = f.clock();
    e.native.holders = undefined;
    e.native.holder = holderOf({ boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
    const named = change === 'other-claim' ? OTHER_CLAIM : CLAIM;
    e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(named), claim: named, draft: change === 'draft' });
    if (change === 'ambiguous') e.gh.pull(912, { head: sha(0x7778), updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
    await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
    for (let i = 0; i < 15; i++) { await f.exec.tick(); f.advance(MIN); }
    assert.deepEqual(engine.stages, [], 'nothing runs before the take-over sweep');
    assert.equal(engine.lastFacts.frontBind ?? null, null);
    assert.equal(engine.lastFacts.wouldDo, 'FRONT_NOT_BOUND');
  });
});

test('take-over front: the binding exception is this duty\'s fresh observation for exactly that head, never S, attempt 2, a stale or unconfirmed run', async t => {
  const f = await executorFixture(t, { policy: policy(), now: NOW });
  const subject = { pr: 910, headSha: H, baseSha: T };
  const observed = (o = {}) => Object.freeze({ at: iso(f.clock()), mode: 'on', wouldDo: 'FRONT_NOT_BOUND', onDuty: true, front: null, mainSha: T, strict: true, wouldRevokeCount: 0,
    decision: 'TRAIN_TAKEOVER_SWEEP_PENDING', sweep: null, actions: null, requestPause: null, openFrontBatch: null, frontBind: { pr: 910, headSha: H, claimId: CLAIM }, ...o });
  f.exec.trainLast = observed();
  assert.equal(f.exec.trainGate(subject), null, 'the named head of the unbound queue head claim');
  assert.ok(f.exec.trainGate({ ...subject, headSha: sha(0x7777) }), 'another head of that PR');
  assert.ok(f.exec.trainGate({ ...subject, pr: 911 }), 'another PR');
  assert.ok(f.exec.trainGate({ ...subject, testSha: S }), 'a subject with S needs its own enqueue binding');
  assert.ok(f.exec.trainGate({ ...subject, attempt: 2 }), 'never an attempt 2');
  assert.equal(f.exec.trainGate()?.reason, 'TRAIN_TAKEOVER_SWEEP_PENDING', 'the global gate still holds everything else');
  for (const o of [{ strict: false }, { strict: null }, { decision: 'TRAIN_SOURCE_MISMATCH' }, { decision: 'TRAIN_REVOKE_UNCONFIRMED' }, { mode: 'revoke-only' }, { onDuty: false },
    { frontBind: undefined }, { at: iso(f.clock() - 15 * MIN) }, { at: iso(f.clock() + 1) }, { at: iso(NOW - 2 * 86_400_000) }]) {
    f.exec.trainLast = observed(o);
    assert.ok(f.exec.trainGate(subject), JSON.stringify(o));
  }
  f.exec.trainLast = observed();
  f.exec.trainSweep = { fullAllPending: 'TRAIN_MAIN_REWRITTEN' };
  assert.ok(f.exec.trainGate(subject), 'main rewritten: frozen until the real full sweep');
  f.exec.trainSweep = null;
  f.exec.trainTakeoverDone = true;
  assert.equal(f.exec.trainFrontBind(subject), false, 'after the take-over the ordinary path applies');
  f.exec.trainTakeoverDone = false;
  // A stage-10 run that could not confirm it again (failed or unclean) drops it.
  f.exec.engine.runTrainStage = async () => ({ ok: false, code: 'TRAIN_STAGE_REFUSED', proof: PROOF });
  f.exec.trainUrgent = true;
  await f.exec.trainRecover();
  await f.exec.trainMaintenance();
  assert.equal(f.exec.trainLast.frontBind, undefined);
  assert.ok(f.exec.trainGate(subject));
});

test('take-over front: a binding run restarted between its stage 1 and its end still ends after stage 1', async t => {
  const f = await executorFixture(t, { policy: policy(), now: NOW });
  await f.exec.trainRecover();
  f.exec.trainLast = Object.freeze({ at: iso(f.clock()), mode: 'on', wouldDo: 'FRONT_NOT_BOUND', onDuty: true, front: null, mainSha: T, strict: true, wouldRevokeCount: 0,
    decision: 'TRAIN_TAKEOVER_SWEEP_PENDING', sweep: null, actions: null, requestPause: null, openFrontBatch: null, frontBind: { pr: 910, headSha: H, claimId: CLAIM } });
  const key = 'f'.repeat(64);
  await f.exec.receipt('train-front-bind', { key, pr: 910, headSha: H, baseSha: T, claimId: CLAIM });
  const next = await executorFixture(t, { policy: policy(), root: f.root, now: NOW });
  await next.exec.trainRecover();
  assert.deepEqual(next.exec.frontBindKeys.get(key), { pr: 910, headSha: H });
  const ended = next.exec.frontBindEnd(key);
  assert.deepEqual([ended.code, ended.stageNumber, ended.windowsOnly], ['TRAIN_FRONT_CLAIM_BOUND', 1, true]);
  assert.equal(next.exec.trainUrgent, true, 'stage 10 is due at once to open the front');
  assert.equal(next.exec.frontBindKeys.has(key), false);
});
