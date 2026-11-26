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
import fs from 'node:fs/promises';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../src/policy.mjs';
import { executorFixture, fakeCompanion, fakeEngine, holdAtA, rawPolicy, triggerBytes, SOURCE, CI_SOURCE } from './helpers.mjs';
import { setup, newestStamp, holderOf, sha, iso, T, H, S, CLAIM, REPO, NOW } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { scaffoldRules } from '../../actions-hosted-migration/independent-ci-v1/test/s7-rules-fixture.mjs';
import { tempDir, admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { runTrain } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-maintenance.mjs';
import { makeTrainRun } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/train-run.mjs';
import { batchJobsV2, claimGeneration, frontJobIdsV2, makeJobV2, scanExternalIdV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { headScansOf, readPublishedChecks } from '../../actions-hosted-migration/independent-ci-v1/src/published-on-github-v2.mjs';
// A namespace import: the tested-line pair (rule 41ab823a) is checked by its own test, so a Source without it fails only there.
import * as onGithub from '../../actions-hosted-migration/independent-ci-v1/src/published-on-github-v2.mjs';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { outcomeFacts } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { HEAD_SCAN_EXTERNAL_ID, HEAD_SCAN_ROLES, parseStageOutcome, stageHeadScans } from '../src/engine-windows.mjs';
import { HEAVY_ROLES } from '../src/policy.mjs';
import { SCAN_CHECK_NAMES, SCAN_EXTERNAL_ID, validHeadScans } from '../../actions-hosted-migration/independent-ci-v1/src/published-on-github-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { createFixtureControlPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
// A namespace import: the field defect 1b31b06b test runs against an older Source too (no stage1FrontRequeue: the result as it was).
import * as claimAssistModule from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/claim-assist-native.mjs';

const MIN = 60_000;
const SCOPE = 'project:00000000-0000-4000-8000-000000000000';
const OTHER_CLAIM = '99999999-8888-4777-8666-555555555555';
const PROOF = { windowsTreeZero: true, serviceOriginalStopped: true };
// Gate mode (DESIGN §62: the take-over full sweep gates the train); strict-permanent mode (§65) is train-strict-permanent.test.mjs.
const policy = (nonFrontRuns = true, extra = {}, sweep = 'gate') => rawPolicy({ contract: POLICY_CONTRACT_V8, ...extra,
  train: { enabled: 'on', nonFrontRuns, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep } });
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
  // `claim` is this offline fixture's explicit holder authorization input,
  // never a parsed PR body. Keep authorization and Native relation separate:
  // only a writable qualified-CI lookup may first associate an authorized head.
  const authorizations = new Map(), relations = new Map();
  e.native.revokePRHead = number => authorizations.delete(number);
  e.native.bindingConflicts = new Set();
  e.native.bindings = new Map();
  const pull = e.gh.pull;
  e.gh.pull = (number, options = {}) => {
    pull(number, options);
    if (options.claim) authorizations.set(number, { claimId: options.claim, taskId: options.claim,
      headSha: e.gh.world.pulls.get(number).head, targetBranch: options.base ?? 'main' });
  };
  const resolve = e.native.port.resolvePRBinding;
  e.native.port.resolvePRBinding = async expected => {
    const authorization = authorizations.get(expected.prNumber), known = relations.get(expected.prNumber);
    let projection, autoBound = false;
    if (e.native.bindingConflicts.has(expected.prNumber)) projection = { state: 'conflict' };
    else if (authorization?.headSha === expected.headSha && authorization.targetBranch === expected.targetBranch
      && expected.repository === REPO && expected.scope === SCOPE && (known || expected.readOnly !== true)) {
      projection = { ...authorization, scope: SCOPE };
      autoBound = !known;
      if (autoBound) relations.set(expected.prNumber, projection);
    } else projection = known ? { ...known, state: 'head_not_authorized' } : null;
    if (projection) e.native.bindings.set(expected.prNumber, { ...projection, auto_bound: autoBound });
    else e.native.bindings.delete(expected.prNumber);
    const answer = await resolve(expected);
    if (answer.binding_status === 'bound' && answer.claim.claim_id === e.native.holder?.claimId) {
      const prs = [...relations.entries()].filter(([, r]) => r.claimId === answer.claim.claim_id).map(([number]) => number).sort((a,b) => a-b);
      e.native.holder = { ...e.native.holder, taskId: answer.task_id, prs, boundPrs: prs.map(number => `${REPO}#${number}`),
        pr: prs.length === 1 ? prs[0] : null, boundPr: prs.length === 1 ? `${REPO}#${prs[0]}` : null };
    }
    return answer;
  };
  e.native.port.nodesStatus = async () => ({ deployed: true, onDuty: true, dropped: 0,
    nodes: [{ node: { name: 'fixture-node', sourceManifestSha256: CI_SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(e.now) } }] });
  return e;
}

// The engine: stage 10 is the real Source v2 runTrain; stage 1 of a batch binds the PR's claim on Native (verify with pr_ref, as the
// admission stage does) and publishes kooyumi-work-admission; stage 8 of a front batch is the real control publisher.
// queueFacts (DESIGN §62.6): stage 1's outcome carries Native's merge-queue entry of the PR's claim (head when it is Native's holder), as
// the Source's admission publisher reports it; false: no outcome (Native not reached, an older Source).
// scans (rule 41ab823a, DESIGN §75): every ordinary batch's publication stage (3, 5, 7) publishes its scan check on H as App 5368905 with
// the staged external id and the line "tested <H>" in its summary (staged-check-publisher-v2.mjs), and a front batch's stage 1 reports the scans H carries exactly as the Source does (the read-back's inventory
// through published-on-github-v2.mjs#headScansOf, then stage-inputs.mjs#writeOutcome, stage-fact.mjs#outcomeFacts and the engine's
// parseStageOutcome). engine.beforeFrontStage1 (optional): runs right before a front batch's stage 1 (a scene change, e.g. an archive).
// A front batch's publication stage (3, 5, 7) publishes its scan check on H as the front job's own (its staged external id carries the front
// job's id), as staged-check-publisher-v2.mjs does; stage 8 reads them (review of R3, problem A: the scans main's rules still require
// from this App are done for the front subject).
// landing (optional): the push-landing port; stage 8 then runs with train-landing push (ADR 0018). passReason: stage 8's own not-ready or
// final reason reaches the executor (otherwise every stage-8 refusal is TRAIN_SINGLE_GREEN_NOT_PROVEN, as before).
// R3 open item 1 (task 04f9b91b): readBack: a front batch's stage 1 ends with HEAD_PUBLISHED_ON_GITHUB when H carries a role or control
// check of this front's own jobs (any attempt), as the Source's admission publisher does (published-on-github-v2.mjs); roleKeys: a front
// batch's publication stage takes K(H, S, role) first, as effect-journal.mjs does (K has no attempt): one held by another batch key ends
// the stage ROLE_ALREADY_PUBLISHED_ON_HEAD; frontEnd(subject, stage): a front stage's own ending (after K is taken), or null;
// ranScansOnly: stage 8 finds on H only the scans a front batch's own stages 3, 5, 7 wrote (otherwise it writes all three first).
function engineFor(e, at, script = {}, { frontStageMs = 0, queueFacts = true, scans = false, landing = null, passReason = false, readBack = false, roleKeys = false,
  frontEnd = null, ranScansOnly = false } = {}) {
  const subjects = new Map(), stages = [], heldK = new Map();
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
    // A stage-10 run is its own process and takes real time, so it never starts in the millisecond the previous run wrote its records in.
    // The simulated clock stands still between ticks; without this a third run in that millisecond finds two newest proofs of one stamp
    // that differ (train-sweep-store.mjs#latestProofStrict) and answers TRAIN_SWEEP_INCOMPLETE, which no node can meet.
    if (engine.trainEndedAt !== undefined && at.clock() <= engine.trainEndedAt) at.advance(engine.trainEndedAt + 1 - at.clock());
    e.now = at.clock();
    const { mode: m, ...params } = input;
    const runId = `${(++run).toString(16).padStart(16, '0')}-0123456789ab`;
    const job = makeTrainRun({ repo: REPO, runId, mode: m, sourceManifestSha256: CI_SOURCE, createdAt: iso(e.now), ...params });
    const calls = e.gh.world.calls, before = calls.length, began = e.now;
    const r = await runTrain({ job, github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep,
      claimScope: SCOPE });
    const created = calls.slice(before).filter(c => c === 'pulls-created').length;
    (engine.trainInputs ??= []).push(input);
    engine.trainRuns.push({ decision: r.facts.decision, frontBind: r.facts.frontBind ?? null, open: r.facts.openFrontBatch !== null, created,
      ms: e.now - began, full: r.facts.sweep?.fullSweep?.state ?? null });
    // Board 269: the store stamps each record after the newest one, so a burst of writes in one standing millisecond lands ahead
    // of this clock. The run ends no earlier than its last write (train-strict-fixtures.mjs#settle).
    at.advance(Math.max(e.now, await newestStamp(e.store.directory)) - at.clock());
    engine.trainEndedAt = at.clock();
    engine.lastFacts = r.facts;
    return { ok: true, runId, proof: PROOF, train: r.facts,
      outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: r.sideEffects, mayHavePublished: r.sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false } };
  };
  engine.runStage = async (batch, stage) => {
    const subject = subjects.get(batch.key);
    stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha ?? null, stage: stage.number, at: at.clock(), attempt: subject.attempt });
    engine.calls.push(['stage', stage.number]);
    // A slow front batch (generation 22, PR #1029): its stages 2-7 take frontStageMs each on the simulated clock.
    if (subject.testSha && stage.number >= 2 && stage.number <= 7) at.advance(frontStageMs);
    const ok = { ok: true, factsSha256: 'd'.repeat(64), proof: PROOF };
    const jobOf = role => makeJobV2({ repo: REPO, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.testSha ?? subject.headSha,
      role, sourceManifestSha256: CI_SOURCE, createdAt: iso(e.now), attempt: subject.attempt });
    const blocked = code => ({ ok: false, code, proof: PROOF, outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, safeToRerun: false } });
    if (readBack && subject.testSha && stage.number === 1) {
      const ids = frontJobIdsV2(jobOf('work-admission'));
      const own = [...e.gh.world.checks.values()].filter(c => c.head_sha === subject.headSha && c.app.id === 5368905
        && onGithub.PUBLISHED_ROLE_CHECK_NAMES.includes(c.name) && onGithub.ofJobIds(c, ids));
      if (own.length > 0) return blocked('HEAD_PUBLISHED_ON_GITHUB');
    }
    if (subject.testSha && [3, 5, 7].includes(stage.number) && roleKeys) {
      const k = `${subject.headSha}:${subject.testSha}:${stage.number}`;
      if (heldK.has(k) && heldK.get(k) !== batch.key) return { ok: false, code: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', proof: PROOF,
        outcome: { status: 'BLOCKED', reason: 'role_already_published_on_head', sideEffects: 0, mayHavePublished: true, safeToRerun: false } };
      heldK.set(k, batch.key);
    }
    const own = subject.testSha ? frontEnd?.(subject, stage.number) ?? null : null;
    if (own) return own;
    if (scans && !subject.testSha && [3, 5, 7].includes(stage.number)) {
      const role = { 3: 'gitleaks', 5: 'trivy', 7: 'contract-placement' }[stage.number];
      const id = 500 + e.gh.world.checks.size;
      e.gh.world.checks.set(id, { id, app: { id: 5368905 }, name: role, head_sha: subject.headSha, status: 'completed', conclusion: 'success',
        external_id: scanExternalIdV2(jobOf(role)), output: { title: `${role}: success`, summary: `Independent CI job x.\ntested ${subject.headSha}` } });
      return ok;
    }
    if (subject.testSha && [3, 5, 7].includes(stage.number)) {
      const role = { 3: 'gitleaks', 5: 'trivy', 7: 'contract-placement' }[stage.number];
      const id = Math.max(500, ...e.gh.world.checks.keys()) + 1;
      e.gh.world.checks.set(id, { id, app: { id: 5368905 }, name: role, head_sha: subject.headSha, status: 'completed', conclusion: 'success',
        external_id: scanExternalIdV2(jobOf(role)), output: { title: `${role}: success`, summary: `Independent CI job x.
tested ${subject.testSha}` } });
      return ok;
    }
    if (scans && subject.testSha && stage.number === 1) {
      await engine.beforeFrontStage1?.(subject);
      const job = jobOf('work-admission');
      const headScans = headScansOf(await readPublishedChecks(e.gh, subject.headSha), frontJobIdsV2(job), subject.headSha);
      e.gh.green(10, subject.headSha, { name: 'kooyumi-work-admission' });
      const written = await writeOutcome({ receiptsRoot: await tempDir(at.t), nonce: 'a'.repeat(32), plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [job.id],
        result: { status: 'SETTLED', sideEffects: 1, scheduling: null, headScans } });
      return { ...ok, outcome: parseStageOutcome(outcomeFacts(written)) };
    }
    if (stage.number === 1) {
      const binding = await e.native.port.resolvePRBinding({ scope: SCOPE, repository: REPO, prNumber: subject.pr,
        headSha: subject.headSha, baseSha: subject.baseSha, targetBranch: 'main' });
      e.gh.green(10, subject.headSha, { name: 'kooyumi-work-admission' });
      if (!queueFacts) return ok;
      const head = binding.binding_status === 'bound' && e.native.holder?.claimId === binding.claim.claim_id;
      return { ...ok, outcome: { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, diagnostic: null, safeToRerun: false,
        scheduling: { ciRetryAfter: null, claimExpiresAt: null, mergeQueue: head ? { entered: true, state: 'head', position: 1 } : { entered: true, state: 'waiting', position: 2 } } } };
    }
    if (stage.number !== 8) return ok;
    if (!subject.testSha) return { ok: false, code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', proof: PROOF,
      outcome: { status: 'BLOCKED', reason: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', sideEffects: 0, mayHavePublished: false } };
    e.now = at.clock();
    for (const [i, name] of ['kooyumi-work-admission', ...(ranScansOnly ? [] : ['gitleaks', 'trivy', 'contract-placement'])].entries()) e.gh.green(10 + i, subject.headSha, { name });
    const claim = { claimId: CLAIM, fence: 3, epoch: 1, expiresAt: iso(e.now + 3_600_000) };
    // The field model (generation 21, PR #1029): the batch subject names SOURCE, its stage-8 jobs (stage-08/jobs.json) name CI_SOURCE,
    // the same Source as stage 10's proof and the node heartbeat. One SOURCE everywhere hid the executor's mismatch.
    assert.equal(subject.sourceManifestSha256, SOURCE);
    const jobs = batchJobsV2({ repo: REPO, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.testSha,
      sourceManifestSha256: CI_SOURCE, createdAt: iso(e.now), attempt: subject.attempt });
    const publisher = createFixtureControlPublisherV2({ github: e.gh, journal: await EffectJournal.open(path.join(await tempDir(at.t), 'effects')),
      trainMode: 'on', batchClaim: claimGeneration(claim), slotNative: e.native.port, sweepStore: e.store, greenLedger: e.ledger,
      pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
      admission: { async evaluatePr(job, packet, options) { const { observationSha256, ...facts } = admittedFacts(job, claim, packet,
        { domain: 'fixture', mergeQueueHead: true, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 });
        return { ...facts, observationSha256: digest(facts) }; } },
      assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep,
      ...(landing ? { trainLanding: { landing: 'push', batchMax: 1, unreadable: false }, landing } : {}) });
    const published = await publisher.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: e.now + 90_000 });
    at.advance(Math.max(e.now, await newestStamp(e.store.directory)) - at.clock());
    engine.published = published;
    (engine.publishedAll ??= []).push({ testSha: subject.testSha, attempt: subject.attempt, status: published.status, reason: published.reason ?? null });
    const reason = passReason && published.status === 'BLOCKED' && published.sideEffects === 0 && typeof published.reason === 'string' ? published.reason : 'TRAIN_SINGLE_GREEN_NOT_PROVEN';
    return published.status === 'SETTLED' ? ok : { ok: false, code: reason, proof: PROOF,
      outcome: { status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false } };
  };
  return engine;
}

test('take-over fixture uses exact Native holder authorization, never body prose or a readonly discovery', async t => {
  const e = await world(t), expected = { scope: SCOPE, repository: REPO, prNumber: 910, headSha: H, baseSha: T, targetBranch: 'main' };
  e.gh.pull(910, { head: H, body: body(CLAIM) });
  assert.equal((await e.native.port.resolvePRBinding(expected)).binding_status, 'unbound', 'a body alone grants nothing');
  e.gh.pull(910, { head: H, body: body(OTHER_CLAIM), claim: CLAIM });
  assert.equal((await e.native.port.resolvePRBinding({ ...expected, readOnly: true })).binding_status, 'unbound', 'read-only cannot activate');
  const bound = await e.native.port.resolvePRBinding(expected);
  assert.equal(bound.binding_status, 'bound'); assert.equal(bound.auto_bound, true); assert.equal(bound.claim.claim_id, CLAIM);
  assert.equal((await e.native.port.resolvePRBinding({ ...expected, readOnly: true })).auto_bound, false);
  assert.equal((await e.native.port.resolvePRBinding({ ...expected, headSha: sha(123) })).binding_status, 'head_not_authorized');
  await assert.rejects(e.native.port.resolvePRBinding({ ...expected, scope: 'global' }), 'a different context cannot reuse the relation');
  e.gh.pull(912, { head: sha(124), body: 'No binding trailers.', claim: CLAIM });
  const other = await e.native.port.resolvePRBinding({ ...expected, prNumber: 912, headSha: sha(124) });
  assert.equal(other.task_id, bound.task_id, 'multiple independently authorized PRs of one Task are legal');
  assert.deepEqual(e.native.holder.boundPrs, [`${REPO}#910`, `${REPO}#912`]);
});

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
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
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
  // Defect a8910e41: it ends released after stage 1 (TRAIN_FRONT_BOUND), the head is not burned.
  const [bound] = (await f.receipts.latest(['batch-unexecuted'], 50)).map(r => r.value.body).filter(b => b.failureCode === 'TRAIN_FRONT_CLAIM_BOUND');
  assert.deepEqual([bound?.release, bound?.class], ['TRAIN_FRONT_BOUND', 'queue'], 'the binding run ends cleanly after stage 1');
  assert.equal((await f.receipts.latest(['batch-terminal'], 50)).filter(r => r.value.body.failureCode === 'TRAIN_FRONT_CLAIM_BOUND').length, 0);
  assert.ok(engine.stages.some(s => s.pr === 910 && s.testSha === S && s.stage === 8));
  // Generation 22: a proof with time to spare is not refreshed before stage 8 (no extra stage-10 run).
  assert.equal((await f.receipts.latest(['train-front-proof-refresh'], 5)).length, 0);
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
  // A run that only refreshed the running front batch's observation (TRAIN_FRONT_BATCH_RUNNING) may skip the pages too, right after a run
  // that read them or (generation 23, DESIGN §62.8) as the batch's first refresh right after its open run: from the open run on, a skipping
  // run is a refresh, and no more than three runs in a row skip.
  const fromOpen = engine.trainRuns.slice(engine.trainRuns.indexOf(openRuns[0]));
  t.diagnostic(`runs from the open: ${fromOpen.map(r => `${r.decision}:${r.created}`).join(' ')}`);
  for (let i = 1; i < fromOpen.length; i++) if (fromOpen[i].created === 0 && fromOpen[i].full === 'running') {
    assert.equal(fromOpen[i].decision, 'TRAIN_FRONT_BATCH_RUNNING', JSON.stringify(fromOpen));
    assert.ok(fromOpen[i - 1].created > 0 || (i === 1 && fromOpen[0].decision === 'OPEN_FRONT_BATCH'), JSON.stringify(fromOpen));
  }
  const all = engine.trainRuns.map(r => r.created === 0 && r.full === 'running');
  assert.ok(!all.some((s, i) => s && all[i + 1] && all[i + 2] && all[i + 3]), `four runs in a row skipped: ${JSON.stringify(engine.trainRuns)}`);
  assert.equal(f.exec.trainTakeoverDone, true, `take-over not done: ${JSON.stringify(engine.lastFacts?.sweep)}`);
  assert.equal((await e.store.readFullSweepStrict('on')).full.state, 'complete');
});

// Task ad19ef19: after the take-over (the steady state) with nonFrontRuns true, a new PR whose claim is the queue head runs an ordinary
// batch (no S): its stage 1 binds the claim, stages 1-7 pass and its stage 8 rests at B (TRAIN_SINGLE_GREEN_NOT_PROVEN: in train on only a
// front job can get the merge slot). Before the fix that row kept the PR busy: stage 10 counted and touched the front batch, the executor
// refused it (TRAIN_FRONT_PR_BUSY), stage 10 then said TRAIN_FRONT_BATCH_RUNNING, and no merge-slot green came within the hour.
// queueFacts false: stage 1 reports no merge-queue entry, so the ordinary batch does not give way after stage 1 (DESIGN §62.6) and the
// take-over at a parking point is what lets the front batch start.
async function steadyState(t, { atA = false, queueFacts = true, pr = 910, claim = CLAIM, head = H, scans = false } = {}) {
  const e = await world(t, { quick: true });
  const at = { t };
  const engine = engineFor(e, at, {}, { queueFacts, scans });
  const f = await executorFixture(t, { policy: policy(true), engine, now: NOW });
  // atA: an ordinary batch (no S) rests at parking point A (helpers.mjs#holdAtA) right after its stage 1.
  if (atA) holdAtA(f.exec, { when: s => !Object.hasOwn(s, 'testSha') });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  for (let i = 0; i < 12 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.equal(f.exec.trainTakeoverDone, true, `take-over not done: ${JSON.stringify(engine.lastFacts?.sweep)}`);
  assert.deepEqual(engine.stages, []);
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(pr, { head, mergeCommitSha: S, updated: iso(arrival), body: body(claim), claim });
  await f.drop(triggerBytes({ pr, headSha: head, baseSha: T }));
  const refused = async () => (await f.receipts.latest(['train-front-refused'], 50)).map(r => r.value.body.failureCode);
  const terminals = async () => (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body.failureCode);
  return { e, f, engine, arrival, refused, terminals, at };
}

test('steady state (task ad19ef19): a queue-head PR pushed after the take-over gets the merge-slot green within 30 minutes (no queue fact)', async t => {
  const { e, f, engine, arrival, refused, terminals } = await steadyState(t, { queueFacts: false });
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

// Rule 41ab823a, field 2026-11-14 (DESK, PR #1086 head 723e4ece; #1085 the same): the ordinary batch of H on main T ran gitleaks, trivy and
// contract-placement and rested at B; stage 10 then opened the front batch (H, S) on the same T, and S = merge(T, H) has H's own tree, yet
// the front batch ran all three scans again on that same input and published them on H a second time. DESIGN §75: stage 10 names H's tree,
// and the front batch reuses each scan its ordinary batch ran on exactly that input; a scan whose input changed still runs.
async function untilSlotGreen(e, f) {
  let green = null;
  for (let i = 0; i < 60 && !green; i++) {
    await f.exec.tick();
    green = slotGreen(e, H);
    if (!green) f.advance(MIN);
  }
  return green;
}

// Fable 2026-11-19 ("same tree, same check, one real run", §2.3): the evidence is H's own checks on GitHub (App 5368905, the ones the
// merge gate reads), read by the front batch's stage 1, never the node's ledger, so it holds after an archive, a reinstall or another node.
const SCAN_ROLES = ['gitleaks', 'trivy', 'contract-placement'];
const scanChecksOn = (e, head) => [...e.gh.world.checks.values()].filter(c => c.head_sha === head && SCAN_ROLES.includes(c.name) && c.external_id);
const ordinaryKeyOf = engine => engine.calls.find(c => c[0] === 'derive' && !engine.subjects.get(c[1]).testSha)[1];
async function assertReusedFromGithub(e, f, engine) {
  for (const stage of [2, 3, 4, 5, 6, 7]) {
    assert.equal(engine.stages.filter(s => s.pr === 910 && s.stage === stage).length, 1, `stage ${stage} ran more than once: ${JSON.stringify(engine.stages)}`);
  }
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 8]);
  const frontKey = engine.calls.find(c => c[0] === 'derive' && engine.subjects.get(c[1]).testSha)[1];
  const { plan } = await f.ledger.state(frontKey);
  assert.deepEqual(plan?.local, [], 'the front batch plans no local scan');
  const onH = scanChecksOn(e, H);
  assert.deepEqual(onH.map(c => c.name).sort(), [...SCAN_ROLES].sort(), 'each scan has exactly one check on H');
  const expected = SCAN_ROLES.map(role => ({ role, from: onH.find(c => c.name === role).external_id }));
  assert.deepEqual(plan.reused, expected, 'reused from H\'s checks on GitHub (their external ids)');
  const [receipt] = (await f.receipts.latest(['train-front-scans-reused'], 5)).map(r => r.value.body);
  assert.deepEqual(receipt?.reused, expected);
}

test('rule 41ab823a: the engine reads stage 1\'s headScans in exactly the Source\'s shape, the resident\'s heavy roles', () => {
  assert.deepEqual([...HEAD_SCAN_ROLES], [...HEAVY_ROLES]);
  assert.deepEqual([...HEAD_SCAN_ROLES], [...SCAN_CHECK_NAMES]);
  assert.equal(HEAD_SCAN_EXTERNAL_ID.source, SCAN_EXTERNAL_ID.source);
  const id = n => `independent-ci:staged:v2:${n.repeat(64)}:a1`;
  const samples = [[{ role: 'trivy', externalId: id('1') }, { role: 'gitleaks', externalId: id('2') }], [{ role: 'contract-placement', externalId: id('3') }],
    [{ role: 'gitleaks' }], [{ role: 'gitleaks', externalId: id('1'), extra: 1 }], [{ role: 'kooyumi-merge-slot', externalId: id('1') }],
    [{ role: 'gitleaks', externalId: `${id('1')}:x` }], [{ role: 'gitleaks', externalId: id('1') }, { role: 'gitleaks', externalId: id('2') }], null, {}, 'gitleaks'];
  for (const v of samples) assert.deepEqual(stageHeadScans(v), validHeadScans(v), JSON.stringify(v));
  // an empty list names nothing on either side (the Source leaves the field out, the engine reads none)
  assert.equal(stageHeadScans([]), null);
  const outcome = { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, headScans: samples[0] };
  assert.deepEqual(parseStageOutcome(outcome).headScans.map(x => x.role), ['gitleaks', 'trivy']);
  assert.equal('headScans' in parseStageOutcome({ ...outcome, status: 'BLOCKED', sideEffects: 0, mayHavePublished: false }), false);
  // the stub above writes the scanner's tested line as the Source's writer does
  assert.equal(onGithub.scanTestedLine(H), `tested ${H}`);
});

test('rule 41ab823a (PR #1086): same head, same main, S with H\'s tree: the front batch runs no scan again and gets the merge-slot green', async t => {
  const { e, f, engine, terminals } = await steadyState(t, { queueFacts: false, scans: true });
  const tree = e.gh.world.commits.get(S).tree;
  e.gh.world.commits.set(H, { sha: H, tree, parents: [T] });
  const green = await untilSlotGreen(e, f);
  assert.ok(green, `no kooyumi-merge-slot success; stages ${JSON.stringify(engine.stages)}`);
  assert.equal(engine.published.status, 'SETTLED');
  assert.ok((await terminals()).includes('TRAIN_FRONT_TAKES_OVER'), 'the ordinary batch rested at B and gave way');
  const [enqueued] = (await f.receipts.latest(['train-front-enqueued'], 5)).map(r => r.value.body);
  assert.deepEqual([enqueued.headTree, enqueued.testTree, enqueued.baseInHead], [tree, tree, true], 'stage 10 named H\'s tree and that T is in H');
  await assertReusedFromGithub(e, f, engine);
});

// Field #1170 (DIAG-duplicate-execution-20261119 §2, head 8086d0e4): the ordinary batch ran the three scans and rested at B, an upgrade drain
// ended it and archived it into ledger-flow-ends, its successor ended at stage 1 with HEAD_PUBLISHED_ON_GITHUB; then the front batch, S with
// H's tree, read its ordinary batch as ABSENT and ran all three scans again (and published them on H a second time).
test('field #1170 (T3): the ordinary batch archived into ledger-flow-ends: the front batch still reuses H\'s scans, read on GitHub', async t => {
  const { e, f, engine } = await steadyState(t, { queueFacts: false, scans: true });
  e.gh.world.commits.set(H, { sha: H, tree: e.gh.world.commits.get(S).tree, parents: [T] });
  engine.beforeFrontStage1 = async () => {
    const key = ordinaryKeyOf(engine);
    const ordinary = (await f.ledger.state(key)).reserved.subject;
    // The archive (ledger.mjs#archiveFlowEnd's rename) and the successor's stage-1 ending (executor.mjs#recordPublishedOnGithub).
    await fs.rename(f.ledger.dir(key), path.join(f.ledger.flowEnds, `${key}-2026-11-19T004825950Z-0123456789abcdef`));
    await f.executedHeads.record(ordinary, { key, origin: 'publication', basis: 'head-published-on-github', stage: 1 });
    assert.equal((await f.ledger.state(key)).state, 'ABSENT');
  };
  assert.ok(await untilSlotGreen(e, f), `no green: ${JSON.stringify(engine.stages)}`);
  await assertReusedFromGithub(e, f, engine);
});

test('Fable §2.3 (T3b): no ledger of the head on this node (a reinstall, or the ordinary batch ran on another node): the front batch reuses H\'s scans', async t => {
  const { e, f, engine } = await steadyState(t, { queueFacts: false, scans: true });
  e.gh.world.commits.set(H, { sha: H, tree: e.gh.world.commits.get(S).tree, parents: [T] });
  engine.beforeFrontStage1 = async () => {
    await fs.rm(f.ledger.dir(ordinaryKeyOf(engine)), { recursive: true, force: true });
    assert.deepEqual(await fs.readdir(f.ledger.flowEnds), []);
  };
  assert.ok(await untilSlotGreen(e, f), `no green: ${JSON.stringify(engine.stages)}`);
  await assertReusedFromGithub(e, f, engine);
});

test('rule 41ab823a: a scan whose input changed runs again on the front batch (S\'s tree is not H\'s, or no H tree was named)', async t => {
  for (const headTree of [sha(0x7777), null]) {
    const { e, f, engine } = await steadyState(t, { queueFacts: false, scans: true });
    if (headTree) e.gh.world.commits.set(H, { sha: H, tree: headTree, parents: [T] });
    assert.ok(await untilSlotGreen(e, f), `no green: ${JSON.stringify(engine.stages)}`);
    assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8], String(headTree));
    assert.equal((await f.receipts.latest(['train-front-scans-reused'], 5)).length, 0);
  }
});

// Fable §2.3 guards: whatever H carries that is not a successful scanner check of App 5368905, or a base that is not H's ancestor, makes
// the front batch scan again (the Source's read-back names nothing then); stage 1 itself ends as before.
const frontStages = engine => engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage);
async function untilFrontStage7(f, engine) {
  for (let i = 0; i < 60 && !engine.stages.some(s => s.testSha === S && s.stage === 7); i++) { await f.exec.tick(); f.advance(MIN); }
}

// Fable §2.3 guards, and the review ruling (R1, R2): whatever H carries that is not a successful scanner check of App 5368905 that tested
// H itself makes the front batch scan again; stage 1 itself ends as before.
test('Fable §2.3 guards: a failed or withdrawn check, another App\'s, a non-scanner one, one that tested another commit (R1) or says nothing of it (R2): the front batch scans again', async t => {
  const scenes = {
    failed: e => { for (const c of scanChecksOn(e, H)) c.conclusion = 'failure'; },
    otherApp: e => { for (const c of scanChecksOn(e, H)) c.app = { id: 15368 }; },
    notScanner: e => { for (const c of scanChecksOn(e, H)) c.external_id = `independent-ci:control:x:v2:${'0'.repeat(64)}:a1`; },
    // R1 (review B1): the newest scans on H come from a batch of several PRs, which published on its first member H the scans of its chain
    // merge S' (or a front on an older main, merge(T', H)): they tested another tree than H's.
    'R1 tested another commit': e => { for (const c of scanChecksOn(e, H)) c.output = { ...c.output, summary: `Independent CI job x.\ntested ${sha(0x7abc)}` }; },
    // R2: a check of the format before this generation says nothing of what it tested.
    'R2 older format': e => { for (const c of scanChecksOn(e, H)) c.output = { ...c.output, summary: 'Independent CI job x.' }; },
  };
  for (const [name, scene] of Object.entries(scenes)) {
    const { e, f, engine } = await steadyState(t, { queueFacts: false, scans: true });
    e.gh.world.commits.set(H, { sha: H, tree: e.gh.world.commits.get(S).tree, parents: [T] });
    engine.beforeFrontStage1 = async () => scene(e);
    await untilFrontStage7(f, engine);
    assert.deepEqual(frontStages(engine).slice(0, 7), [1, 2, 3, 4, 5, 6, 7], name);
    assert.equal((await f.receipts.latest(['train-front-scans-reused'], 5)).length, 0, name);
  }
});

// R4 (review B2): that T is in H comes from stage 10's own compare of exactly this batch's (T, H) (openFrontBatch baseInHead); stage 1 reads
// nothing for it. A compare that does not name both ends of this batch says nothing: the front batch scans again.
test('R4: no baseInHead from stage 10 (its compare does not name this batch\'s T and H): the front batch scans again', async t => {
  for (const reply of [(base, head) => ({ status: 'ahead', aheadBy: 1, behindBy: 0 }),
    (base, head) => ({ baseSha: sha(0x7bcd), headSha: head, mergeBaseSha: sha(0x7bcd), status: 'ahead', aheadBy: 1, behindBy: 0 })]) {
    const { e, f, engine } = await steadyState(t, { queueFacts: false, scans: true });
    e.gh.world.commits.set(H, { sha: H, tree: e.gh.world.commits.get(S).tree, parents: [T] });
    e.gh.world.hooks.compare = reply;
    await untilFrontStage7(f, engine);
    const [enqueued] = (await f.receipts.latest(['train-front-enqueued'], 5)).map(r => r.value.body);
    assert.equal(enqueued?.baseInHead, undefined);
    assert.deepEqual(frontStages(engine).slice(0, 7), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal((await f.receipts.latest(['train-front-scans-reused'], 5)).length, 0);
  }
});

// R6: the evidence lives in memory from the front batch's stage 1 to its plan; a restart in between (the batch resumes from parking point A)
// has none: the front batch scans again.
test('R6: a restart between the front batch\'s stage 1 and its plan loses the evidence: the front batch scans again', async t => {
  const { e, f, engine, at } = await steadyState(t, { queueFacts: false, scans: true });
  e.gh.world.commits.set(H, { sha: H, tree: e.gh.world.commits.get(S).tree, parents: [T] });
  holdAtA(f.exec, { when: s => Object.hasOwn(s, 'testSha') });
  for (let i = 0; i < 60 && !engine.stages.some(s => s.testSha === S && s.stage === 1); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(frontStages(engine), [1]);
  assert.equal(f.exec.frontHeadScans.size, 1, 'stage 1 named the scans H carries');
  const g = await executorFixture(t, { policy: policy(true), engine, root: f.root, now: f.clock() });
  Object.assign(at, { clock: g.clock, advance: g.advance });
  await g.exec.trainRecover();
  await untilFrontStage7(g, engine);
  assert.deepEqual(frontStages(engine).slice(0, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await g.receipts.latest(['train-front-scans-reused'], 5)).length, 0);
});

// The same at parking point A: the ordinary batch rests at A right after its stage 1 bound the claim (as one a restart found there).
// It gives way the same way and the front batch starts.
test('steady state (task ad19ef19): an ordinary batch resting at parking point A gives way to the front batch of its head (no queue fact)', async t => {
  const { f, engine, refused, terminals } = await steadyState(t, { atA: true, queueFacts: false });
  for (let i = 0; i < 30 && !engine.stages.some(s => s.testSha === S); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(await refused(), [], 'the front batch is never refused as busy');
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage), [1], 'the ordinary batch ran stage 1 only');
  assert.ok(engine.stages.some(s => s.pr === 910 && s.testSha === S && s.stage === 1), `front batch not started: ${JSON.stringify(engine.stages)}`);
  assert.ok((await terminals()).includes('TRAIN_FRONT_TAKES_OVER'), JSON.stringify(await terminals()));
});

// DESIGN §62.6 (the residue of §62.5): in steady state the queue head's ordinary batch ran stages 1-7 (13-15 minutes in the field), then
// stage 10 opened the front batch (H, S) and the ordinary batch's work was thrown away. Now it gives way right after its stage 1 bound the
// claim: released (TRAIN_FRONT_BOUND), stage 10 at once (OPEN_FRONT_BATCH), the front batch runs stages 1-8 and gets the merge slot.
test('steady state (DESIGN §62.6): the queue head\'s ordinary batch gives way after stage 1, the front batch gets the merge-slot green', async t => {
  const { e, f, engine, arrival, refused, terminals } = await steadyState(t);
  const before = engine.trainRuns.length;
  let green = null;
  for (let i = 0; i < 60 && !green; i++) {
    await f.exec.tick();
    green = slotGreen(e, H);
    if (!green) f.advance(MIN);
  }
  const own = engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage);
  assert.deepEqual(own, [1], `the ordinary batch runs stage 1 only, never stage 2: ${JSON.stringify(engine.stages)}`);
  assert.ok(engine.trainRuns.slice(before).some(r => r.decision === 'OPEN_FRONT_BATCH'), JSON.stringify(engine.trainRuns.slice(before)));
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(green, `no kooyumi-merge-slot success; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo}`);
  assert.equal(engine.published.status, 'SETTLED');
  t.diagnostic(`steady state with the yield: merge-slot green ${Math.round((f.clock() - arrival) / 1000)} s (simulated) after the PR arrived`);
  // A clean, explicit end: released after stage 1 (not burned), recorded; no busy refusal, no take-over at a parking point.
  const [bound] = (await f.receipts.latest(['batch-unexecuted'], 50)).map(r => r.value.body).filter(b => b.failureCode === 'TRAIN_FRONT_CLAIM_BOUND');
  assert.deepEqual([bound?.release, bound?.class], ['TRAIN_FRONT_BOUND', 'queue']);
  const yields = (await f.receipts.latest(['train-front-yield'], 5)).map(r => r.value.body);
  assert.deepEqual(yields.map(y => [y.pr, y.headSha, y.mergeQueue?.state]), [[910, H, 'head']]);
  assert.deepEqual(await refused(), []);
  assert.ok(!(await terminals()).includes('TRAIN_FRONT_TAKES_OVER'), JSON.stringify(await terminals()));
});

// Field 2026-11-13 (DESK, PR #1085, head 734cd84): the node came back paused (stage 10 ran revoke-only), the Owner resumed at 03:32:14Z and
// the same tick reserved the queue head's ordinary batch at once: the §62.6 yield read the revoke-only run and did not apply, so gitleaks,
// trivy and contract-placement ran on H (03:34-03:46), and the front batch on S, with the same tree on the same main, ran them all again
// (04:09-04:18). The stage-10 run a lifted pause owes now comes before any batch work: each scan stage of the head runs once.
test('field 2026-11-13 (PR #1085): after a resume the scans of the queue head run once, on the front batch only', async t => {
  const { e, f, engine } = await steadyState(t);
  // what steadyState queued is held behind a PAUSE first: stage 10 runs revoke-only, nothing is scheduled
  await f.ledger.pause({ reason: 'fleet-node-reinstall-hold-after-install' });
  for (let i = 0; i < 20 && f.exec.trainLast?.mode !== 'revoke-only'; i++) { assert.equal((await f.exec.tick()).state, 'PAUSED'); f.advance(MIN); }
  assert.equal(f.exec.trainLast?.mode, 'revoke-only', 'the run under the pause');
  assert.deepEqual(engine.stages, []);
  const { resumeRequest, writeOwnerRequest } = await import('../tools/rearm-tool.mjs');
  const p = await f.ledger.paused();
  await writeOwnerRequest(path.join(f.root, 'owner'), resumeRequest({ expectedPausedSha256: p.sha256, by: 'S-1-5-21-1-2-3-1001' }, f.clock), f.clock);
  let green = null;
  for (let i = 0; i < 60 && !green; i++) {
    await f.exec.tick();
    green = slotGreen(e, H);
    if (!green) f.advance(MIN);
  }
  assert.ok(green, `no kooyumi-merge-slot success; stages ${JSON.stringify(engine.stages)}`);
  for (const stage of [2, 3, 4, 5, 6, 7]) {
    assert.equal(engine.stages.filter(s => s.pr === 910 && s.stage === stage).length, 1, `stage ${stage} ran more than once: ${JSON.stringify(engine.stages)}`);
  }
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// Guard: a PR whose claim is not first in the merge queue runs its ordinary batch through stages 1-7 (and stage 8) as before.
test('steady state (DESIGN §62.6): an ordinary batch whose claim is not the queue head runs on past stage 1', async t => {
  const { f, engine } = await steadyState(t, { pr: 911, claim: OTHER_CLAIM, head: sha(0x7777) });
  for (let i = 0; i < 20 && !engine.stages.some(s => s.pr === 911 && s.stage === 8); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(engine.stages.filter(s => s.pr === 911 && s.testSha === null).map(s => s.stage).slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await f.receipts.latest(['train-front-yield'], 5)).length, 0);
  assert.equal((await f.receipts.latest(['batch-unexecuted'], 50)).filter(r => r.value.body.failureCode === 'TRAIN_FRONT_CLAIM_BOUND').length, 0);
});

// Guard: train shadow and off never give way, even when stage 1 says the claim is the queue head; nor does train on without strict, before
// the take-over is done (the binding run's business), for attempt 2 or a front row (S), or on a queue fact that is not head.
test('DESIGN §62.6: no yield in shadow or off, nor in on without strict, before the take-over, for attempt 2, S, or no head fact', async t => {
  const headOutcome = { ok: true, factsSha256: 'd'.repeat(64), outcome: { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, diagnostic: null, safeToRerun: false,
    scheduling: { ciRetryAfter: null, claimExpiresAt: null, mergeQueue: { entered: true, state: 'head', position: 1 } } } };
  for (const enabled of ['shadow', 'off']) {
    const engine = fakeEngine({ stages: { 1: headOutcome } });
    const g = await executorFixture(t, { policy: rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled, nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS } }),
      engine, now: NOW });
    await g.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
    let r = null;
    for (let i = 0; i < 5 && r?.state !== 'COMPLETED'; i++) { r = await g.exec.tick(); if (r.state !== 'COMPLETED') g.advance(MIN); }
    assert.equal(r.state, 'COMPLETED', `${enabled}: ${JSON.stringify(r)}`);
    assert.deepEqual(engine.calls.filter(c => c[0] === 'stage' && c[1] !== 10).map(c => c[1]), [1, 2, 3, 4, 5, 6, 7, 8], enabled);
    assert.equal(g.exec.trainFrontYield({ pr: 910, headSha: H, baseSha: T, attempt: 1 }, headOutcome), false, enabled);
  }
  const f = await executorFixture(t, { policy: policy(), now: NOW });
  await f.exec.trainRecover();
  const subject = { pr: 910, headSha: H, baseSha: T, attempt: 1 };
  f.exec.trainTakeoverDone = false;
  f.exec.trainLast = Object.freeze({ ...(f.exec.trainLast ?? {}), mode: 'on', onDuty: true, strict: true, wouldDo: 'NO_FRONT' });
  assert.equal(f.exec.trainFrontYield(subject, headOutcome), false, 'take-over not done');
  f.exec.trainTakeoverDone = true;
  assert.equal(f.exec.trainFrontYield(subject, headOutcome), true, 'steady state, strict, head');
  assert.equal(f.exec.trainFrontYield({ ...subject, attempt: 2 }, headOutcome), false, 'attempt 2');
  assert.equal(f.exec.trainFrontYield({ ...subject, testSha: S }, headOutcome), false, 'a front row');
  const fact = mergeQueue => ({ ...headOutcome, outcome: { ...headOutcome.outcome, scheduling: { ...headOutcome.outcome.scheduling, mergeQueue } } });
  for (const q of [{ entered: true, state: 'waiting', position: 2 }, { entered: true, state: 'head', position: 2 }, { entered: false, state: null, position: null }, null])
    assert.equal(f.exec.trainFrontYield(subject, fact(q)), false, JSON.stringify(q));
  assert.equal(f.exec.trainFrontYield(subject, { ok: true, factsSha256: 'd'.repeat(64) }), false, 'no outcome');
  f.exec.trainLast = Object.freeze({ ...f.exec.trainLast, strict: false });
  assert.equal(f.exec.trainFrontYield(subject, headOutcome), false, 'strict not true');
  f.exec.trainLast = Object.freeze({ ...f.exec.trainLast, strict: true, mode: 'shadow' });
  assert.equal(f.exec.trainFrontYield(subject, headOutcome), false, 'the newest run not on');
});

test('take-over front: no binding run without strict, for another Native claim, a Native conflict, or a draft', async t => {
  for (const change of ['strict-off', 'other-claim', 'native-conflict', 'draft']) await t.test(change, async t => {
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
    e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
    const named = change === 'other-claim' ? OTHER_CLAIM : CLAIM;
    e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(named), claim: named, draft: change === 'draft' });
    if (change === 'native-conflict') e.native.bindingConflicts.add(910);
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

// Defect a8910e41 (#1028 / #1029): the binding run ended after its stage 1 as TRAIN_FRONT_CLAIM_BOUND, which the failure table burned
// (clean-final, new-commit). When the front batch then did not get its merge slot, or the node went back to shadow, the PR's head never
// ran again: a new commit was needed. The binding run is now released (NOT_EXECUTED, the head stays unburned) with a marker that holds
// only for this duty: the same head is neither bound again nor run as an ordinary batch while the duty lasts.
async function bound(t) {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at);
  const f = await executorFixture(t, { policy: policy(true), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  for (let i = 0; i < 2; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const ended = async () => (await f.receipts.latest(['batch-terminal', 'batch-unexecuted'], 50)).map(r => r.value.body).find(b => b.failureCode === 'TRAIN_FRONT_CLAIM_BOUND');
  for (let i = 0; i < 20 && !(await ended()); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(await ended(), `no binding run: stages ${JSON.stringify(engine.stages)}`);
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage), [1]);
  return { e, f, engine, ended };
}

test('defect a8910e41: after the binding run the node goes back to shadow: the same head runs all eight stages, no new commit', async t => {
  const { f, ended } = await bound(t);
  const { outcome } = await ended() ?? {};
  assert.notEqual(outcome, 'FAILED_CLEAN', 'the binding run does not burn the head');
  // train=shadow (a reinstall restarts the service on the same state); the PR is triggered again (the poller, or the Owner's probe)
  const shadow = rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS } });
  const engine = fakeEngine();
  const g = await executorFixture(t, { policy: shadow, engine, root: f.root, now: f.clock() + 11 * MIN });
  await g.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  let r = null;
  for (let i = 0; i < 5 && r?.state !== 'COMPLETED'; i++) { r = await g.exec.tick(); if (r.state !== 'COMPLETED') g.advance(MIN); }
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.deepEqual(engine.calls.filter(c => c[0] === 'stage' && c[1] !== 10).map(c => c[1]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('defect a8910e41: in the same duty the released head is never bound a second time nor run as an ordinary batch', async t => {
  const { e, f, engine } = await bound(t);
  // the claim comes unbound again (the front was not opened): stage 10 names the same PR and head as the binding run's subject again
  e.native.holder = { ...e.native.holder, boundPrs: [], prs: [], boundPr: null, pr: null };
  for (let i = 0; i < 40; i++) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage), [1], 'one binding run of this head in this duty, no ordinary batch');
  assert.equal((await f.receipts.latest(['train-front-bind'], 50)).length, 1);
});

// Generation 22 field defect (PR #1029): the strict front proof was written 08:19:59 (sweepFreshMs 15 minutes), the front batch started
// 08:20:24 and its stage 7 ended 08:35:09; stage 8 then said TRAIN_SINGLE_GREEN_NOT_PROVEN (the proof had run out), the batch rested at
// B, stage 10 refreshed the proof 08:35:40-08:38:17 and the stage-8 retry succeeded 08:39:37. Now, right before stage 8 of a front batch
// whose proof has less than three minutes left (or none), stage 10 refreshes it first: the first stage-8 try gets the merge slot.
test('gen 22 (PR #1029): a front batch whose stages 1-7 outlast the strict proof gets the merge-slot green at its first stage-8 try', async t => {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at, {}, { frontStageMs: 3 * MIN });
  const f = await executorFixture(t, { policy: policy(true), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  for (let i = 0; i < 2; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 90 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  let green = null;
  for (let i = 0; i < 60 && !green; i++) {
    await f.exec.tick();
    green = slotGreen(e, H);
    if (!green) f.advance(MIN);
  }
  const front = engine.stages.filter(s => s.pr === 910 && s.testSha === S);
  assert.ok(front.length > 0, `no front batch: ${JSON.stringify(engine.stages)}`);
  const s1 = front.find(s => s.stage === 1).at, s8 = front.filter(s => s.stage === 8);
  assert.ok(s8.length > 0 && s8[0].at - s1 > 15 * MIN, `stages 1-7 took ${Math.round(((s8[0]?.at ?? f.clock()) - s1) / MIN)} minutes`);
  assert.deepEqual((await f.receipts.latest(['stage8-not-ready'], 20)).map(r => r.value.body.failureCode), [], 'no stage-8 try ran into an expired proof');
  assert.equal(s8.length, 1, 'the first stage-8 try is the one');
  assert.equal((await f.receipts.latest(['train-front-proof-refresh'], 5)).length, 1, 'one stage-10 refresh right before it');
  assert.ok(green, `no kooyumi-merge-slot success; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo}`);
  t.diagnostic(`front batch: stage 1 to stage 8 ${Math.round((s8[0].at - s1) / 1000)} s (simulated); merge-slot green ${Math.round((f.clock() - arrival) / 1000)} s after the PR arrived`);
  // Generation 23 field defect (PR #1032, DESIGN §62.8): the open run skipped the full-sweep segment (10:04:31), the front batch ran
  // 10:05:04-10:19:22 and the refresh before stage 8 then had to read it (10:19:22-10:21:59, 2 min 37 s) only because the open run had
  // skipped it. The strict front proof needs no history: the first refresh run after this batch's open run reads no full-sweep page.
  const openIdx = engine.trainRuns.findIndex(r => r.decision === 'OPEN_FRONT_BATCH');
  const refreshIdx = engine.trainRuns.findIndex((r, i) => i > openIdx && r.decision === 'TRAIN_FRONT_BATCH_RUNNING');
  assert.ok(openIdx >= 0 && refreshIdx === openIdx + 1, JSON.stringify(engine.trainRuns));
  const [open, refresh] = [engine.trainRuns[openIdx], engine.trainRuns[refreshIdx]];
  t.diagnostic(`runs: ${engine.trainRuns.map(r => `${r.decision}:${r.created}:${r.ms / 1000}s`).join(' ')}`);
  assert.equal(open.created, 0, 'the open run reads no full-sweep page');
  assert.equal(refresh.created, 0, 'the refresh run right after the open run reads no full-sweep page either');
  assert.ok(refresh.ms < 60_000, `the refresh run took ${refresh.ms / 1000} s (simulated)`);
  // Starvation bound: the run after them reads the full-sweep pages again, and the take-over full sweep still completes.
  e.gh.world.hooks.pullsPage = null;
  const after = engine.trainRuns.length;
  for (let i = 0; i < 40 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.ok(engine.trainRuns[after]?.created > 0 && engine.trainRuns[after].full !== null, `the next run reads pages: ${JSON.stringify(engine.trainRuns.slice(after))}`);
  assert.equal(f.exec.trainTakeoverDone, true, `take-over not done: ${JSON.stringify(engine.lastFacts?.sweep)}`);
});

// Task 60f83aa3 (#1031): the last stage 10 ran at 09:07 and said NO_FRONT (empty queue); the PR arrived at 09:14 and waited for the
// 10-minute cadence. A new unbound head after NO_FRONT is asked about at once (once per head), the same as after FRONT_NOT_BOUND.
test('take-over front (task 60f83aa3): a PR arriving after a NO_FRONT run gets its binding stage 10 within a minute, once per head', async t => {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at);
  const f = await executorFixture(t, { policy: policy(), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  await f.exec.tick(); // the run that says NO_FRONT (empty queue)
  assert.equal(f.exec.trainLast.wouldDo, 'NO_FRONT');
  f.advance(7 * MIN); // well inside the 10-minute cadence
  const arrival = f.clock();
  const before = engine.trainRuns.length;
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  let bound = null;
  for (let i = 0; i < 3 && !bound; i++) {
    await f.exec.tick();
    bound = engine.trainRuns.slice(before).find(r => r.frontBind) ?? null;
    if (!bound) f.advance(20_000);
  }
  assert.ok(bound, `no frontBind run after the arrival: ${JSON.stringify(engine.trainRuns.slice(before))}`);
  assert.ok(f.clock() - arrival <= MIN, `stage 10 ran ${Math.round((f.clock() - arrival) / 1000)} s after the arrival`);
  for (let i = 0; i < 3; i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(engine.stages.some(s => s.pr === 910 && s.testSha === null && s.stage === 1), 'the binding run ran stage 1');

  // Guard: the same head never makes stage 10 urgent a second time.
  f.exec.trainLast = Object.freeze({ ...f.exec.trainLast, wouldDo: 'NO_FRONT', mode: 'on', strict: true });
  f.exec.trainUrgent = false;
  f.exec.trainAskFrontBind([{ pr: 910, headSha: H, baseSha: T }]);
  assert.equal(f.exec.trainUrgent, false, 'an asked head is not asked again');
  f.exec.trainAskFrontBind([{ pr: 911, headSha: sha(0x7777), baseSha: T }]);
  assert.equal(f.exec.trainUrgent, true, 'a new head is asked once');
  f.exec.trainUrgent = false;
  f.exec.trainAskFrontBind([{ pr: 911, headSha: sha(0x7777), baseSha: T }]);
  assert.equal(f.exec.trainUrgent, false);
});

// Task 60f83aa3, steady state: the take-over is done, the queue is empty, the last stage 10 said NO_FRONT. A new PR's ordinary batch binds
// the claim in its stage 1; stage 10 must then open the front batch within a minute, not at the next 10-minute cadence. (An urgent
// request on arrival would be spent by a stage 10 that still sees the head unbound.)
test('steady state (task 60f83aa3): after the ordinary batch\'s stage 1 bound the claim, stage 10 opens the front within a minute', async t => {
  const e = await world(t, { quick: true });
  const at = { t };
  const engine = engineFor(e, at);
  const f = await executorFixture(t, { policy: policy(), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  for (let i = 0; i < 40 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.equal(f.exec.trainTakeoverDone, true);
  await f.exec.tick(); // a stage 10 on an empty queue: NO_FRONT, cadence restarts here
  assert.equal(f.exec.trainLast.wouldDo, 'NO_FRONT');
  f.advance(3 * MIN);
  const arrival = f.clock();
  const before = engine.trainRuns.length;
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  let stage1At = null, open = null;
  for (let i = 0; i < 12 && !open; i++) {
    await f.exec.tick();
    if (stage1At === null && engine.stages.some(s => s.pr === 910 && s.testSha === null && s.stage === 1)) stage1At = f.clock();
    open = engine.trainRuns.slice(before).find(r => r.decision === 'OPEN_FRONT_BATCH') ?? null;
    if (!open) f.advance(20_000);
  }
  assert.ok(stage1At !== null, 'the ordinary batch ran stage 1');
  assert.ok(open, `no OPEN_FRONT_BATCH run: ${JSON.stringify(engine.trainRuns.slice(before))}`);
  assert.ok(f.clock() - stage1At <= MIN, `stage 10 opened the front ${Math.round((f.clock() - stage1At) / 1000)} s after stage 1`);
  assert.ok(f.clock() - arrival < 7 * MIN, 'well inside the cadence');
});

test('steady state (task 60f83aa3): a head makes stage 10 urgent at most twice, and never on arrival once the take-over is done', async t => {
  const f = await executorFixture(t, { policy: policy(), now: NOW });
  await f.exec.trainRecover();
  f.exec.trainTakeoverDone = true;
  f.exec.trainLast = Object.freeze({ ...(f.exec.trainLast ?? {}), mode: 'on', wouldDo: 'NO_FRONT', strict: true });
  f.exec.trainUrgent = false;
  f.exec.trainAskFrontBind([{ pr: 910, headSha: H, baseSha: T }]);
  assert.equal(f.exec.trainUrgent, false, 'no ask on arrival after the take-over');
  const subject = { pr: 910, headSha: H, baseSha: T };
  f.exec.trainAskAfterBind(subject);
  assert.equal(f.exec.trainUrgent, true, 'asked once stage 1 bound');
  f.exec.trainUrgent = false;
  f.exec.trainAskAfterBind(subject);
  assert.equal(f.exec.trainUrgent, true, 'a second ask is allowed');
  f.exec.trainUrgent = false;
  f.exec.trainAskAfterBind(subject);
  assert.equal(f.exec.trainUrgent, false, 'never a third');
  f.exec.trainAskAfterBind({ ...subject, testSha: S });
  assert.equal(f.exec.trainUrgent, false, 'a front row (S) is not asked');
});

// PR #1142: stage 1 ran before this claim became the head. Its ordinary stage 8 now rests at B;
// continuously available ordinary work must not spend the head's entire 45-minute slot first.
async function busyFrontAtB(t) {
  const e = await world(t, { quick: true }), at = { t };
  const engine = engineFor(e, at, {}, { frontStageMs: 2 * MIN });
  const f = await executorFixture(t, { policy: policy(), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  for (let i = 0; i < 40 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.equal(f.exec.trainTakeoverDone, true);
  e.native.holders = undefined;
  e.native.holder = holderOf({ claimId: OTHER_CLAIM, pr: 999, prs: [999], boundPr: `${REPO}#999`, boundPrs: [`${REPO}#999`] });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(f.clock()), claim: CLAIM });
  const run = engine.runStage;
  let since = null;
  engine.runStage = async (batch, stage, opts) => {
    const subject = engine.subjects.get(batch.key);
    if (subject.pr === 910 && !subject.testSha && stage.number >= 2 && stage.number <= 7) f.advance(2 * MIN);
    if (subject.pr === 910 && !subject.testSha && stage.number === 8 && since === null) {
      since = f.clock();
      e.native.holder = holderOf({ takenAt: iso(since), mergeSlotUntil: iso(since + 45 * MIN) });
    }
    const result = await run(batch, stage, opts);
    if (subject.pr === 910 && !subject.testSha && stage.number === 8) result.outcome.scheduling = { mergeQueue: { entered: true, state: 'head', position: 1 } };
    return result;
  };
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const parked = await f.exec.tick();
  assert.equal(parked.state, 'PARKED');
  assert.equal(f.queue.row(910).parked.position, 1);
  for (const pr of [911, 912, 913]) {
    const head = sha(pr);
    e.gh.pull(pr, { head, updated: iso(f.clock()), claim: OTHER_CLAIM });
    await f.drop(triggerBytes({ pr, headSha: head, baseSha: T }));
  }
  return { e, at, engine, f, since, key: parked.key };
}

for (const restart of [false, true]) test(`field 2026-11-17 PR #1142: the head parked at B opens before busy ordinary work (restart ${restart})`, async t => {
  const setup = await busyFrontAtB(t);
  const { e, at, engine, since } = setup;
  let { f } = setup;
  const before = engine.trainRuns.length;
  if (restart) {
    f = await executorFixture(t, { policy: policy(), engine, root: f.root, now: f.clock() });
    Object.assign(at, { clock: f.clock, advance: f.advance });
  }
  await f.exec.tick();
  assert.ok(engine.trainRuns.slice(before).some(r => r.decision === 'OPEN_FRONT_BATCH'), 'next tick must run stage 10 and open the front, even with ordinary work ready');
  assert.equal(engine.stages.some(s => s.pr !== 910 && s.stage >= 2), false, 'stage 10 precedes all other ordinary work');
  assert.equal((await f.ledger.state(setup.key)).terminal.facts.failureCode, 'TRAIN_FRONT_TAKES_OVER');
  for (let i = 0; i < 4 && !slotGreen(e, H); i++) { await f.exec.tick(); f.advance(1000); }
  assert.ok(slotGreen(e, H), `no slot green: ${JSON.stringify(engine.trainRuns)}`);
  assert.ok(f.clock() - since < 45 * MIN, 'front completes within the original slot');
});

test('a settled front-open debt does not repeatedly preempt busy ticks, including after restart', async t => {
  const setup = await busyFrontAtB(t), { e, at, engine } = setup;
  let { f } = setup;
  // The head left before stage 10: a confirmed NO_FRONT settles this debt too.
  e.native.holders = [];
  const before = engine.trainRuns.length;
  await f.exec.tick();
  assert.equal(engine.trainRuns.length, before + 1, 'the owed decision runs once');
  assert.equal(engine.lastFacts.wouldDo, 'NO_FRONT');
  f = await executorFixture(t, { policy: policy(), engine, root: f.root, now: f.clock() });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  // FABLE-keep-train-replan §3.4: a busy PR's admission with the train idle asks one stage 10 ahead of the next batch; that is not the debt.
  let admissions = 0;
  for (let i = 0; i < 2; i++) { f.advance(1000); if (f.exec.trainAdmitOwed) admissions++; await f.exec.tick(); }
  assert.ok(admissions <= 1, `${admissions} admission asks`);
  assert.equal(engine.trainRuns.length, before + 1 + admissions, 'no repeated empty stage 10 in non-quiet ticks');
});

// ---- Strict-permanent mode (Owner decision 9e2511fe, Task 40f0dfb7, DESIGN §65) ----
// The policy names no train.sweep: the default is the Owner's decision ('audit'). Strict stays on for good, so no full sweep gates
// anything: the queue head's ordinary batch binds its claim at stage 1 (no take-over binding exception needed), gives way, and the front
// batch gets the merge-slot green on the strict current-front proof while the full sweep (here: hours) still runs.
// The fixture authorizes the exact head independently of PR prose. Native may discover that association through qualified CI;
// permanent mode does not need the take-over scheduling exception in either case.
const permanentPolicy = (extra = {}) => rawPolicy({ contract: POLICY_CONTRACT_V8, ...extra,
  train: { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, ...(extra.train ?? {}) } });

// R3 lean (DESIGN §82 item 1): main's rules with the three scans required from GitHub Actions (15368), the rest from this App.
const ACTIONS_SCAN_RULES = Object.freeze([['kooyumi-work-admission', 5368905], ['gitleaks', 15368], ['trivy', 15368], ['contract-placement', 15368],
  ['kooyumi-admission-verified', 5368905], ['kooyumi-merge-slot', 5368905]].map(([context, integration_id]) => Object.freeze({ context, integration_id })));

// ruleChecks: main's required checks as [{ context, integration_id }] (actionsScans: ACTIONS_SCAN_RULES); prepare(e, engine): before the
// executor starts (a rules or port change of the scene); engineOptions: engineFor's options.
async function permanentArrival(t, { strict = true, restart = false, sweep, actionsScans = false, ruleChecks = null, engineOptions = {}, prepare = null } = {}) {
  const e = await world(t);
  e.gh.world.strict = strict;
  if (actionsScans) e.gh.world.ruleChecks = ACTIONS_SCAN_RULES.map(c => ({ ...c }));
  if (ruleChecks) e.gh.world.ruleChecks = ruleChecks.map(c => ({ ...c }));
  const at = { t };
  const engine = engineFor(e, at, {}, engineOptions);
  await prepare?.(e, engine);
  const pol = permanentPolicy(sweep ? { train: { sweep } } : {});
  let f = await executorFixture(t, { policy: pol, engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  await f.exec.trainRecover();
  // train=on has just taken effect: the full sweep starts and runs (hours here); the queue is empty.
  for (let i = 0; i < 3; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  if (restart) {
    // An install (a new package, so a new policy: another digest) restarts the service on the same state: a new duty, a new onSince.
    const installed = permanentPolicy({ train: { maintenanceMaxPerDay: 199, ...(sweep ? { sweep } : {}) } });
    f = await executorFixture(t, { policy: installed, engine, root: f.root, now: f.clock() });
    Object.assign(at, { clock: f.clock, advance: f.advance });
    await f.exec.trainRecover();
    await f.exec.tick(); f.advance(MIN);
  }
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: 'Change.\n', claim: CLAIM });
  e.gh.pull(911, { head: sha(0x7777), updated: iso(arrival), body: 'Other change.\n', claim: OTHER_CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  await f.drop(triggerBytes({ pr: 911, headSha: sha(0x7777), baseSha: T }));
  return { e, f, engine, arrival, at };
}

async function untilGreen(f, e, minutes = 30) {
  let green = null;
  for (let i = 0; i <= minutes && !green; i++) { await f.exec.tick(); green = slotGreen(e, H) ?? null; if (!green) f.advance(MIN); }
  return green;
}

for (const restart of [false, true]) test(`strict-permanent (DESIGN §65): train on, the full sweep just started${restart ? ', then an install restart' : ''}: a new queue-head PR gets the merge-slot green within 30 minutes without the sweep`, async t => {
  const { e, f, engine, arrival } = await permanentArrival(t, { restart });
  const green = await untilGreen(f, e);
  const elapsed = f.clock() - arrival;
  assert.ok(green, `no kooyumi-merge-slot success within 30 minutes; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo}; stages ${JSON.stringify(engine.stages)}`);
  t.diagnostic(`strict-permanent${restart ? ' after restart' : ''}: first kooyumi-merge-slot success ${Math.round(elapsed / 1000)} s (simulated) after the PR arrived`);
  // Not the full sweep: it is still running, no proof says fullSweepSinceOn, the take-over gate was open from the start of the duty.
  const full = await e.store.readFullSweepStrict('on');
  assert.equal(full.full.state, 'running');
  assert.equal(full.full.onSince, new Date(f.exec.trainOnSince).toISOString(), 'the round is anchored to this duty');
  assert.equal((await e.store.latestProof()).fullSweepSinceOn, false);
  assert.equal(f.exec.trainSweep.fullSinceOn, false);
  assert.equal(f.exec.trainTakeoverDone, true);
  assert.equal(f.exec.trainStatus().sweepMode, 'audit');
  assert.equal(engine.published.status, 'SETTLED');
  // The ordinary batch bound the claim at stage 1 and gave way (DESIGN §62.6); the front batch (S) ran stages 1-8.
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage), [1]);
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await f.receipts.latest(['train-front-bind'], 5)).length, 0, 'no take-over binding exception was needed');
  // The PR that is not the queue head is no longer held for the sweep: it runs, and its stage 8 rests at B (only a front batch greens).
  // (Since §3.4 the front batch goes first, so 911 may run after the green.)
  for (let i = 0; i < 10 && !engine.stages.some(s => s.pr === 911 && s.stage === 8); i++) { f.advance(MIN); await f.exec.tick(); }
  assert.ok(engine.stages.some(s => s.pr === 911 && s.stage === 8), JSON.stringify(engine.stages));
  assert.equal(slotGreen(e, sha(0x7777)), undefined);
  // R3 lean regression: every scan pinned to this App: stage 10 says so and the resident runs every scan, as before.
  assert.deepEqual(engine.lastFacts.rules.appScans, ['gitleaks', 'trivy', 'contract-placement'], JSON.stringify(engine.lastFacts.rules));
  assert.equal((await f.receipts.latest(['scans-not-app-required'], 10)).length, 0);
});

// R3 lean (DESIGN §82 item 1): the scans main requires from GitHub Actions (integration 15368), not from this App: the resident runs none of
// them. With strict on, the front batch runs stages 1 and 8 only and still gets the merge-slot green; no batch runs stages 2-7.
test('R3: scans required from Actions, strict on -> no batch runs its own scans; the front batch runs stages 1 and 8 and gets the merge-slot green', async t => {
  const { e, f, engine } = await permanentArrival(t, { actionsScans: true });
  const green = await untilGreen(f, e);
  assert.ok(green, `no green; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo} rules ${JSON.stringify(engine.lastFacts?.rules)}; stages ${JSON.stringify(engine.stages)}`);
  assert.deepEqual(engine.lastFacts.rules.appScans, [], JSON.stringify(engine.lastFacts.rules));
  assert.deepEqual(f.exec.trainLast.appScans, []);
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 8]);
  assert.ok(!engine.stages.some(s => s.stage >= 2 && s.stage <= 7), `no scan stage runs: ${JSON.stringify(engine.stages)}`);
  const skipped = (await f.receipts.latest(['scans-not-app-required'], 10)).map(r => r.value.body.roles);
  assert.ok(skipped.length > 0 && skipped.every(r => JSON.stringify(r) === JSON.stringify(['gitleaks', 'trivy', 'contract-placement'])), JSON.stringify(skipped));
  assert.deepEqual((await f.receipts.latest(['paused'], 10)).map(r => r.value.body.reason), []);
});

// R3 lean, a part of the scans (review of R3, gap b): only gitleaks is required from GitHub Actions. The front batch runs no gitleaks
// stages (2, 3) but runs trivy and contract-placement (4-7) and still gets the merge-slot green (stage 8 finds both on H, its own).
test('R3: only gitleaks required from Actions -> the front batch skips gitleaks alone, runs the other two scans and gets the merge-slot green', async t => {
  const ruleChecks = ACTIONS_SCAN_RULES.map(c => ({ ...c, integration_id: c.context === 'gitleaks' ? 15368 : 5368905 }));
  const { e, f, engine } = await permanentArrival(t, { ruleChecks });
  const green = await untilGreen(f, e);
  assert.ok(green, `no green; stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.wouldDo}; stages ${JSON.stringify(engine.stages)}`);
  assert.deepEqual(engine.lastFacts.rules.appScans, ['trivy', 'contract-placement']);
  assert.deepEqual(f.exec.trainLast.appScans, ['trivy', 'contract-placement']);
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 4, 5, 6, 7, 8]);
  const skipped = (await f.receipts.latest(['scans-not-app-required'], 10)).map(r => r.value.body.roles);
  assert.ok(skipped.length > 0 && skipped.every(r => JSON.stringify(r) === JSON.stringify(['gitleaks'])), JSON.stringify(skipped));
});

// Task 04f9b91b (admission p90, 修复前必红): the scaffold phase. main's only rules are the scaffold ruleset as read back live (27843120:
// kooyumi-work-admission pinned to this App, the three hosted-* scans pinned to GitHub Actions). Stage 10 cannot read the rules as the
// six (nothing is published at stage 8), but no scan is pinned to this App: no batch runs stages 2-7 (13-15 minutes on the node), so the
// next head's admission no longer queues behind them. Reverse: the same rules not given whole (unreadable): every scan runs, as before.
for (const incomplete of [false, true]) test(`p90: the scaffold ruleset alone${incomplete ? ', not given whole' : ''} -> ${incomplete ? 'every scan runs' : 'no batch runs its own scans'}`, async t => {
  const { e, f, engine } = await permanentArrival(t, { prepare: e => { e.gh.world.rules = scaffoldRules(); e.gh.world.rulesIncomplete = incomplete; } });
  for (let i = 0; i < 30 && !engine.stages.some(s => s.pr === 910 && s.stage === 8); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(engine.stages.some(s => s.pr === 910 && s.stage === 8), `stage 10 said ${engine.lastFacts?.decision}/${engine.lastFacts?.rulesReason}; stages ${JSON.stringify(engine.stages)}`);
  assert.deepEqual([engine.lastFacts.rules, engine.lastFacts.rulesReason], [null, incomplete ? 'RULESET_READ_FAILED' : 'RULESET_UNREADABLE']);
  const skipped = (await f.receipts.latest(['scans-not-app-required'], 10)).map(r => r.value.body.roles);
  if (incomplete) {
    assert.equal(Object.hasOwn(f.exec.trainLast, 'appScans'), false, JSON.stringify(f.exec.trainLast));
    assert.deepEqual(engine.stages.filter(s => s.pr === 910).map(s => s.stage).slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(skipped, []);
  } else {
    assert.deepEqual(engine.lastFacts.appScans, []);
    assert.deepEqual(f.exec.trainLast.appScans, []);
    assert.ok(!engine.stages.some(s => s.stage >= 2 && s.stage <= 7), `no scan stage runs: ${JSON.stringify(engine.stages)}`);
    assert.ok(skipped.length > 0 && skipped.every(r => JSON.stringify(r) === JSON.stringify(['gitleaks', 'trivy', 'contract-placement'])), JSON.stringify(skipped));
  }
  assert.equal(slotGreen(e, H), undefined, 'the scaffold rules never green the merge slot');
});

// The top-level appScans (any rule's scans pinned to this App) and rules.appScans (the six read) come from one read; if they disagree the
// summary keeps neither: every scan runs.
test('p90: stage 10 answers a top-level appScans that disagrees with rules.appScans -> every scan runs', async t => {
  const { e, f, engine } = await permanentArrival(t, { actionsScans: true, prepare: (e, engine) => {
    const run = engine.runTrainStage;
    engine.runTrainStage = async (...a) => { const r = await run(...a); if (r.train?.rules) r.train = { ...r.train, appScans: ['trivy'] }; return r; };
  } });
  const green = await untilGreen(f, e);
  assert.ok(green, `no green; stages ${JSON.stringify(engine.stages)}`);
  assert.equal(Object.hasOwn(f.exec.trainLast, 'appScans'), false, JSON.stringify(f.exec.trainLast));
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// R3 lean, an unusable appScans (review of R3, gap c): stage 10 answers rules.appScans the resident cannot read (an unknown scan, one twice,
// not a list, too many): train.mjs#appScansOf drops it, so the summary carries none and the front batch runs every scan, as before R3.
for (const bad of [['gitleaks', 'nope'], ['trivy', 'trivy'], 'gitleaks', ['gitleaks', 'trivy', 'contract-placement', 'gitleaks']])
  test(`R3: stage 10's rules.appScans ${JSON.stringify(bad)} cannot be read -> every scan runs`, async t => {
    const { e, f, engine } = await permanentArrival(t, { actionsScans: true, prepare: (e, engine) => {
      const run = engine.runTrainStage;
      engine.runTrainStage = async (...a) => { const r = await run(...a); if (r.train?.rules) r.train.rules = { ...r.train.rules, appScans: bad }; return r; };
    } });
    const green = await untilGreen(f, e);
    assert.ok(green, `no green; stages ${JSON.stringify(engine.stages)}`);
    assert.equal(Object.hasOwn(f.exec.trainLast, 'appScans'), false, JSON.stringify(f.exec.trainLast));
    assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === S).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal((await f.receipts.latest(['scans-not-app-required'], 10)).length, 0);
  });

// The scene of problem A, up to the end of the first front batch. push: push landing (ADR 0018), else github-merge (stage 8 writes the
// merge-slot green). flips: how many front batches find the rules moved back to this App after their stage 1 (each one plans on stage
// 10's read of Actions and its stage 8 then refuses: TRAIN_BATCH_CHANGED); the rules are on Actions again whenever stage 10 opens a batch
// that is to flip; 0: the rules are on this App from the start and never move. until(scene): when the first part ends (default: S landed or
// a batch ended TRAIN_BATCH_CHANGED). engineOptions: more engineFor options. Returns the scene with a log of Native's touches.
async function problemA(t, { push = true, flips = 1, until = null, engineOptions = {} } = {}) {
  const MAIN_RS = 24182890, FF_RS = 27500001;
  const APP_RULES = ACTIONS_SCAN_RULES.map(c => ({ ...c, integration_id: 5368905 }));
  const scene = { kind: flips === 0 ? 'app' : 'actions', pushes: [], touches: [], flipped: 0 };
  let e = null;
  const setKind = k => { scene.kind = k; if (!push) e.gh.world.ruleChecks = (k === 'actions' ? ACTIONS_SCAN_RULES : APP_RULES).map(c => ({ ...c })); };
  scene.ownScans = () => {
    const ids = frontJobIdsV2(makeJobV2({ repo: REPO, pr: 910, headSha: H, baseSha: T, testSha: S, role: 'work-admission', sourceManifestSha256: CI_SOURCE, createdAt: iso(NOW), attempt: 1 }));
    return [...new Set([...e.gh.world.checks.values()].filter(c => c.head_sha === H && c.app.id === 5368905 && SCAN_CHECK_NAMES.includes(c.name)
      && c.status === 'completed' && c.conclusion === 'success' && onGithub.ofJobIds(c, ids)).map(c => c.name))].sort();
  };
  const landing = push ? { async fastForwardMain(s) { scene.pushes.push({ sha: s, scans: scene.ownScans(), kind: scene.kind }); e.gh.world.main = s; return { status: 200, sha: s }; } } : null;
  const ended = engine => (engine.publishedAll ?? []).filter(p => p.reason === 'TRAIN_BATCH_CHANGED').length;
  const arrived = await permanentArrival(t, { actionsScans: flips > 0, engineOptions: { ...(landing ? { landing } : {}), passReason: true, ranScansOnly: true, ...engineOptions }, prepare: (world, engine) => {
    e = world;
    if (push) {
      e.gh.readBranchRules = async () => ({ complete: true, branch: 'main', rules: [
        { type: 'pull_request', rulesetId: MAIN_RS, parameters: { allowed_merge_methods: ['merge'] } },
        { type: 'non_fast_forward', rulesetId: FF_RS, parameters: null }, { type: 'deletion', rulesetId: FF_RS, parameters: null },
        { type: 'required_status_checks', rulesetId: MAIN_RS, parameters: { strict_required_status_checks_policy: true, required_status_checks: [
          ...(scene.kind === 'actions' ? ACTIONS_SCAN_RULES : APP_RULES), { context: 'kooyumi-train-landed', integration_id: 5368905 }].map(c => ({ ...c })) } }] });
      // GET /rulesets/{id}: this App always bypasses the main ruleset and never the fast-forward-only one (ADR 0018 push)
      e.gh.readRuleset = async id => ({ id, currentUserCanBypass: id === MAIN_RS ? 'always' : 'never' });
    }
    const touch = e.native.port.touch;
    e.native.port.touch = async args => { scene.touches.push(args); return touch(args); };
    // The rules go back to this App right after a front batch's stage 1, so its plan holds stage 10's older read.
    const run = engine.runStage;
    engine.runStage = async (batch, stage, ...rest) => {
      const subject = engine.subjects.get(batch.key);
      const r = await run(batch, stage, ...rest);
      if (subject.testSha && stage.number === 1 && scene.kind === 'actions') { setKind('app'); scene.flipped++; }
      return r;
    };
    // Before stage 10 opens the next front batch that is to flip, the rules are on Actions again (pinned there once more).
    const train = engine.runTrainStage;
    engine.runTrainStage = async (...a) => {
      if (scene.flipped > 0 && scene.flipped < flips && scene.kind === 'app' && ended(engine) === scene.flipped) setKind('actions');
      return train(...a);
    };
  } });
  const { f, engine } = arrived;
  const first = () => (until ? until(scene) : scene.pushes.length > 0 || ended(engine) > 0);
  for (let i = 0; i <= 60 && !first(); i++) { await f.exec.tick(); if (!first()) f.advance(MIN); }
  Object.assign(scene, arrived, { ended: () => ended(engine), landed: () => (push ? scene.pushes.length > 0 : !!slotGreen(e, H)) });
  return scene;
}

const stage10Decisions = engine => engine.trainRuns.map(r => r.decision).filter((d, i, a) => d !== a[i - 1]);
const enqueuedOf = async f => (await f.receipts.latest(['train-front-enqueued'], 10)).map(r => r.value.body).filter(b => b.pr === 910 && b.testSha === S);
const ignoredOf = async f => (await f.receipts.latest(['trigger-ignored'], 10)).map(r => r.value.body);
const why = async scene => {
  const { e, f, engine } = scene;
  return `pushes ${JSON.stringify(scene.pushes)}; stage 8 ${JSON.stringify(engine.publishedAll)}; stage 10 ${JSON.stringify(stage10Decisions(engine))}; `
    + `enqueued ${JSON.stringify((await enqueuedOf(f)).map(b => [b.attempt, b.key.slice(0, 8)]))}; ignored ${JSON.stringify(await ignoredOf(f))}; `
    + `stages ${JSON.stringify(frontStages(engine))}; rows ${JSON.stringify(f.exec.queue.data.rows.filter(r => r.pr === 910).map(r => [r.state, r.reason, r.current]))}; `
    + `halt ${JSON.stringify((await f.ledger.halted())?.value ?? null)}; holder ${JSON.stringify(e.native.holder)}; `
    + `rules ${JSON.stringify(e.gh.world.ruleChecks)}; H checks ${JSON.stringify([...e.gh.world.checks.values()].filter(c => c.head_sha === H).map(c => [c.name, c.app.id, c.conclusion]))}`;
};
// Native gives the claim (alone in the queue) a new tenure: as it does once the first one's turn ended (stage 10's turnShort or the running
// clock); here at once, so these tests pin what the executor and stage 10 do with it, not how long Native takes.
const newTenure = scene => { scene.e.native.holder = holderOf({ takenAt: iso(scene.f.clock()), mergeSlotUntil: iso(scene.f.clock() + 45 * MIN) }); };
async function untilScene(scene, done, minutes = 60) {
  for (let i = 0; i <= minutes && !(await done()); i++) { await scene.f.exec.tick(); if (!(await done())) scene.f.advance(MIN); }
}

// Review of R3, problem A (修复前必红): stage 10 read the three scans pinned to GitHub Actions (appScans []); then main's rules went back to
// this App (switch A rolled back). The front batch planned on that older read skips every scan (executor.mjs#localPlan); before the fix
// its stage 8 pushed S to main (or wrote the green) with no scan of this App on it, past the rules that require them. Now stage 8 checks,
// against the rules it reads itself, that every scan they require from this App is done for this front subject: not done, it lands
// nothing and writes no green, the batch ends (TRAIN_BATCH_CHANGED).
for (const push of [true, false]) test(`R3 problem A (${push ? 'push' : 'github-merge'}): scans read as pinned to Actions, rules back to this App -> S never lands without its scans`, async t => {
  const scene = await problemA(t, { push });
  const { e, f } = scene;
  assert.equal(scene.kind, 'app', `the front batch never ran its stage 1: ${await why(scene)}`);
  // The older read was used: the first front batch skipped all three scans.
  const skipped = (await f.receipts.latest(['scans-not-app-required'], 10)).map(r => r.value.body.roles);
  assert.ok(skipped.some(r => JSON.stringify(r) === JSON.stringify(['gitleaks', 'trivy', 'contract-placement'])), JSON.stringify(skipped));
  assert.equal(scene.ended(), 1, await why(scene));
  assert.deepEqual(scene.pushes, []);
  assert.equal(slotGreen(e, H), undefined, 'no merge-slot green without the scans');
});

// R3 open item 1 (修复前必红, R1, the target scene end to end): the first front batch ended at stage 8 (TRAIN_BATCH_CHANGED). The next
// stage 10, reading the rules back on this App, opens the front batch of the same S again as its front number 2. Before the fix that batch
// had the ended one's key (attempt 1) and never ran; with its own key only, the executed-heads gate still ignored it
// (HEAD_ALREADY_PUBLISHED_NO_RETRY: the first batch wrote its before-stage-8 record). Now it runs: it plans on the rules read now, runs the
// three scans and lands S once (push) or gets the merge-slot green (github-merge). Nothing here enqueues, retries or changes a resident
// state by hand; S stays the same commit.
for (const push of [true, false]) test(`R3 open item 1 R1 (${push ? 'push' : 'github-merge'}): stage 10's second front batch of the same S runs its scans and lands S once`, async t => {
  const scene = await problemA(t, { push });
  const { e, f, engine } = scene;
  assert.equal(scene.ended(), 1, await why(scene));
  newTenure(scene);
  await untilScene(scene, scene.landed);
  assert.deepEqual((await ignoredOf(f)).map(b => b.failureCode), [], `the second front batch was ignored: ${await why(scene)}`);
  assert.ok(scene.landed(), `S did not land: ${await why(scene)}`);
  if (push) assert.deepEqual(scene.pushes.map(p => [p.sha, p.kind, p.scans]), [[S, 'app', ['contract-placement', 'gitleaks', 'trivy']]], await why(scene));
  else assert.deepEqual(scene.ownScans(), ['contract-placement', 'gitleaks', 'trivy'], 'the green has the scans of this App on H');
  assert.equal(slotGreen(e, H) === undefined, push, push ? 'push writes no merge-slot green' : 'github-merge writes the merge-slot green');
  assert.deepEqual(engine.publishedAll.filter(p => p.testSha === S).map(p => [p.attempt, p.status, p.reason]), [[1, 'BLOCKED', 'TRAIN_BATCH_CHANGED'], [2, 'SETTLED', null]]);
  const enqueued = await enqueuedOf(f);
  assert.deepEqual(enqueued.map(b => b.attempt).sort(), [1, 2], JSON.stringify(enqueued));
  assert.equal(new Set(enqueued.map(b => b.key)).size, 2, 'front number 2 is a batch of its own');
  const second = enqueued.find(b => b.attempt === 2).key;
  assert.equal((await f.receipts.latest(['scans-not-app-required'], 10)).filter(r => r.value.body.key === second).length, 0, 'the second batch skips no scan');
  assert.deepEqual(frontStages(engine).slice(-8), [1, 2, 3, 4, 5, 6, 7, 8], 'the second batch ran every stage');
  assert.equal(await f.ledger.halted(), null);
});

// R2 (修复前必红): as R1, with a restart of the executor after stage 10 enqueued front number 2 and before it ran: the key the executor works
// out again for the queue row is the one its 'train-front-enqueued' receipt names, and the batch runs once.
test('R3 open item 1 R2: a restart between enqueueing front number 2 and running it keeps its key; it runs once and lands S', async t => {
  const scene = await problemA(t, { push: true });
  const { engine } = scene;
  newTenure(scene);
  // One tick at a time until stage 10 enqueued front number 2; the same tick could run it at once, so this executor runs no row once it is
  // enqueued (the service stops right after the enqueue, before the row runs).
  const stagesBefore = engine.stages.length;
  const old = scene.f.exec, enqueue = old.enqueueFront.bind(old), runRow = old.runRow.bind(old);
  let stopped = false;
  old.enqueueFront = async front => { const k = await enqueue(front); if (k && front.attempt === 2) stopped = true; return k; };
  old.runRow = async (c, usage) => (stopped ? { state: 'DEFERRED', key: null, reason: 'R2_STOPPED' } : runRow(c, usage));
  for (let i = 0; i <= 30 && !stopped; i++) { await old.tick(); if (!stopped) scene.f.advance(MIN); }
  const second = (await enqueuedOf(scene.f)).find(b => b.attempt === 2);
  assert.ok(second, `front number 2 never enqueued: ${await why(scene)}`);
  const ranSince = engine.stages.slice(stagesBefore).filter(x => x.testSha === S).length;
  const f = await executorFixture(t, { policy: permanentPolicy(), engine, root: scene.f.root, now: scene.f.clock() });
  Object.assign(scene.at, { clock: f.clock, advance: f.advance });
  Object.assign(scene, { f });
  await f.exec.trainRecover();
  await untilScene(scene, scene.landed);
  assert.equal(ranSince, 0, 'front number 2 had not run before the restart');
  assert.deepEqual(scene.pushes.map(p => [p.sha, p.scans]), [[S, ['contract-placement', 'gitleaks', 'trivy']]], await why(scene));
  const reserved = (await f.receipts.latest(['batch-reserved'], 20)).map(r => r.value.body).filter(b => b.subject?.testSha === S && b.subject.attempt === 2);
  assert.deepEqual(reserved.map(b => b.key), [second.key], JSON.stringify(reserved));
});

// R4 (防回归): front number 2 finds the rules changed again (planned on Actions, stage 8 reads this App): it ends like the first one, and
// the next stage 10 says TRAIN_FRONT_ATTEMPTS_USED: no third front batch, no HALT, no pause.
test('R3 open item 1 R4: front number 2 refused at stage 8 too -> TRAIN_FRONT_ATTEMPTS_USED, no third batch, no HALT, no pause', async t => {
  const scene = await problemA(t, { push: true, flips: 2 });
  const { f, engine } = scene;
  newTenure(scene);
  await untilScene(scene, () => scene.ended() >= 2);
  assert.equal(scene.ended(), 2, await why(scene));
  newTenure(scene);
  await untilScene(scene, () => engine.trainRuns.some(r => r.decision === 'TRAIN_FRONT_ATTEMPTS_USED'), 30);
  assert.ok(engine.trainRuns.some(r => r.decision === 'TRAIN_FRONT_ATTEMPTS_USED'), await why(scene));
  assert.deepEqual((await enqueuedOf(f)).map(b => b.attempt).sort(), [1, 2]);
  assert.deepEqual(scene.pushes, []);
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual((await f.receipts.latest(['paused'], 10)).map(r => r.value.body.reason), []);
});

// F1 (修复前必红): right after the first front batch ended at stage 8, with no new Native tenure and the clock nowhere near the end of the
// running clock: the next stage 10 is told that batch ended (frontOutcome of it, frontFailed false), so it does not say
// TRAIN_FRONT_BATCH_RUNNING, and nothing failed is reported on the slot. Before the fix the executor reported no frontOutcome for a
// clean-final ending: stage 10 said TRAIN_FRONT_BATCH_RUNNING until the running clock ran out.
test('R3 open item 1 F1: a front batch that ended clean at stage 8 is reported ended to the next stage 10 (frontFailed false), no touch failed', async t => {
  const scene = await problemA(t, { push: true });
  const { f, engine } = scene;
  const runsBefore = engine.trainRuns.length;
  for (let i = 0; i < 15 && engine.trainRuns.length === runsBefore; i++) { await f.exec.tick(); if (engine.trainRuns.length === runsBefore) f.advance(MIN); }
  assert.ok(engine.trainRuns.length > runsBefore, 'a stage 10 ran');
  const input = engine.trainInputs[runsBefore];
  assert.notEqual(engine.trainRuns[runsBefore].decision, 'TRAIN_FRONT_BATCH_RUNNING', `${JSON.stringify(input)}; ${await why(scene)}`);
  assert.deepEqual([input.frontPr, input.frontHeadSha, input.frontTestSha, input.frontAttempt, input.frontCode, input.frontFailed],
    [910, H, S, 1, 'TRAIN_BATCH_CHANGED', false], JSON.stringify(input));
  assert.deepEqual(scene.touches.filter(x => x.ciState === 'failed'), [], 'nothing failed is reported on the slot');
});

// FABLE-r3-batch2-gate G1, G2, F4: the executed-heads gate lets stage 10's front number 2 of the same S through only after front number 1
// ended clean at stage 8 with no other record of (H, S) (executor.mjs#precheck). A stage's clean ending of the front's own: zero side effects.
const cleanEnd = code => ({ ok: false, code, proof: PROOF, outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, safeToRerun: false } });
const scanChecksOnH = e => [...e.gh.world.checks.values()].filter(c => c.head_sha === H && c.app.id === 5368905 && SCAN_CHECK_NAMES.includes(c.name) && c.external_id).length;
// G1's scene: the rules are on this App throughout; front number 1 takes K(H, S, gitleaks) at stage 3 and that stage then ends clean
// (PUBLICATION_BLOCKED). A new Native tenure; stage 10 opens front number 2 of the same S; it reaches the executor's gate.
async function g1Scene(t) {
  const ends = [];
  const frontEnd = (subject, stage) => (subject.attempt === 1 && stage === 3 ? (ends.push(stage), cleanEnd('PUBLICATION_BLOCKED')) : null);
  const scene = await problemA(t, { flips: 0, until: () => ends.length > 0, engineOptions: { roleKeys: true, frontEnd } });
  assert.deepEqual(frontStages(scene.engine), [1, 2, 3], await why(scene));
  newTenure(scene);
  await untilScene(scene, async () => (await ignoredOf(scene.f)).length > 0);
  return scene;
}

// G1 (防回归, green before and after the fix; without `stage === 8` in the gate it turns red: front number 2 would run stage 3 into
// ROLE_ALREADY_PUBLISHED_ON_HEAD, an UNKNOWN HALT).
test('R3 batch 2 G1: front number 1 took K at stage 3 and failed clean -> front number 2 is ignored by the gate, no HALT, no ROLE_ALREADY_PUBLISHED_ON_HEAD', async t => {
  const scene = await g1Scene(t);
  const { f, engine } = scene;
  const second = (await enqueuedOf(f)).find(b => b.attempt === 2);
  assert.ok(second, `front number 2 was never opened: ${await why(scene)}`);
  assert.deepEqual((await ignoredOf(f)).map(b => [b.key, b.failureCode]), [[second.key, 'HEAD_ALREADY_PUBLISHED_NO_RETRY']], await why(scene));
  assert.ok(!engine.stages.some(s => s.testSha === S && s.attempt === 2), 'front number 2 ran no stage');
  assert.equal(await f.ledger.halted(), null);
  const codes = (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body.failureCode);
  assert.ok(!codes.includes('ROLE_ALREADY_PUBLISHED_ON_HEAD'), JSON.stringify(codes));
});

// F4 (修复前必红): G1 continued: the ignored front number 2 is reported ended to the next stage 10 (frontFailed false), which says
// TRAIN_FRONT_ATTEMPTS_USED, not TRAIN_FRONT_BATCH_RUNNING.
test('R3 batch 2 F4: front number 2 ignored by the gate -> the next stage 10 says TRAIN_FRONT_ATTEMPTS_USED, not TRAIN_FRONT_BATCH_RUNNING', async t => {
  const scene = await g1Scene(t);
  const { f, engine } = scene;
  const runsBefore = engine.trainRuns.length;
  for (let i = 0; i < 15 && engine.trainRuns.length === runsBefore; i++) { await f.exec.tick(); if (engine.trainRuns.length === runsBefore) f.advance(MIN); }
  assert.ok(engine.trainRuns.length > runsBefore, 'a stage 10 ran');
  assert.equal(engine.trainRuns[runsBefore].decision, 'TRAIN_FRONT_ATTEMPTS_USED', `${JSON.stringify(engine.trainInputs[runsBefore])}; ${await why(scene)}`);
  const input = engine.trainInputs[runsBefore];
  assert.deepEqual([input.frontPr, input.frontAttempt, input.frontCode, input.frontFailed], [910, 2, 'HEAD_ALREADY_PUBLISHED_NO_RETRY', false]);
  assert.deepEqual(scene.touches.filter(x => x.ciState === 'failed'), [], 'nothing failed is reported on the slot');
});

// FABLE-r3-batch2-followup §2a (修复前必红): front number 1 opened by stage 10 is abandoned at stage 4 (DESIGN §27: the pump lost, the
// stage stopped through its stop path, quiescence proven): FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED, class environment, no automatic
// attempt 2 (stage 2 only). That is a final end: the next stage 10 is told (frontFailed false), does not say TRAIN_FRONT_BATCH_RUNNING,
// and reports nothing failed; no clock is pushed to the running clock's end. Before the fix nothing was reported and stage 10 said
// TRAIN_FRONT_BATCH_RUNNING until the running clock ran out (up to 90 minutes).
const abandonedAt = () => ({ ok: false, code: 'BRIDGE_STAGE_STOPPED_PUMP_LOST', proof: PROOF, outcome: null,
  bridge: { pumpCode: 'RELAY_REFUSED_NO_RETRY', stopRequestId: '0a1b2c3d-0000-4000-8000-000000000001', stopCode: 'STOP_SENT', stageCode: 'STAGE_OUTCOME_MISSING', pumpQuiet: true } });
for (const at of [4, 6]) test(`R3 batch 2 F5: front number 1 abandoned at stage ${at} (scanner) is reported ended to the next stage 10 (frontFailed false), not TRAIN_FRONT_BATCH_RUNNING`, async t => {
  const ends = [];
  const frontEnd = (subject, stage) => (subject.attempt === 1 && stage === at ? (ends.push(stage), abandonedAt()) : null);
  const scene = await problemA(t, { flips: 0, until: () => ends.length > 0, engineOptions: { roleKeys: true, frontEnd } });
  const { f, engine } = scene;
  const [first] = await enqueuedOf(f);
  await untilScene(scene, async () => (await f.ledger.state(first.key)).state === 'TERMINAL');
  const end = await f.ledger.state(first.key);
  assert.deepEqual([end.outcome, end.terminal?.facts?.failureCode, end.terminal?.facts?.stage, end.terminal?.facts?.class], ['FAILED_CLEAN', 'BRIDGE_ABANDONED_UNPUBLISHED', at, 'environment'], await why(scene));
  assert.equal(await f.ledger.halted(), null);
  const runsBefore = engine.trainRuns.length;
  for (let i = 0; i < 15 && engine.trainRuns.length === runsBefore; i++) { await f.exec.tick(); if (engine.trainRuns.length === runsBefore) f.advance(MIN); }
  assert.ok(engine.trainRuns.length > runsBefore, 'a stage 10 ran');
  const input = engine.trainInputs[runsBefore];
  assert.notEqual(engine.trainRuns[runsBefore].decision, 'TRAIN_FRONT_BATCH_RUNNING', `${JSON.stringify(input)}; ${await why(scene)}`);
  assert.deepEqual([input.frontPr, input.frontHeadSha, input.frontTestSha, input.frontAttempt, input.frontCode, input.frontFailed],
    [910, H, S, 1, 'BRIDGE_ABANDONED_UNPUBLISHED', false], JSON.stringify(input));
  assert.deepEqual(scene.touches.filter(x => x.ciState === 'failed'), [], 'nothing failed is reported on the slot');
});

// FABLE-r3-batch2-followup §2b (task 04f9b91b, 修复前必红): front number 1 opened by stage 10 fails clean at stage 2 for a reason that is
// not the PR's (REMOTE_REFS_CHANGED_SINCE_BUNDLE, transient): the executor schedules the head's one automatic attempt 2 (its front number
// 2). That attempt 2 then ends for good: it fails clean at stage 2 again ('ends'), or the precheck ignores it ('ignored'). Either way the
// next stage 10 is told (frontAttempt 2, frontFailed false) and does not say TRAIN_FRONT_BATCH_RUNNING; within two stage-10 rounds it says
// TRAIN_FRONT_ATTEMPTS_USED; nothing failed is reported on the slot; no clock is pushed to the running clock's end (one-minute ticks only).
// Before the fix stage 10's newest record of the head was its own front number 1, so the report of number 2 never matched it (an ignored
// attempt 2 was not reported at all) and stage 10 said TRAIN_FRONT_BATCH_RUNNING until the running clock ran out.
// 'main-moved': as 'ends', then main moves on before the next stage 10, which opens front number 2 on the new test merge S3; the executor
// refuses it (the head's two front batches are used) and reports that refused batch ended. Before the fix stage 10's newest record was that
// refused (S3, 2) and the report named S: stage 10 said TRAIN_FRONT_BATCH_RUNNING.
const ENDS = { ends: 'ends clean as front number 2', ignored: 'is ignored by the precheck', 'main-moved': 'ends, then main moves on before stage 10 opens front number 2' };
for (const end of Object.keys(ENDS)) test(`04f9b91b: the automatic attempt 2 of a front batch ${ENDS[end]} -> the next stage 10 says it ended, then TRAIN_FRONT_ATTEMPTS_USED`, async t => {
  const fails = [];
  const frontEnd = (subject, stage) => (stage === 2 && (subject.attempt === 1 || end !== 'ignored') ? (fails.push(subject.attempt), cleanEnd('REMOTE_REFS_CHANGED_SINCE_BUNDLE')) : null);
  const scene = await problemA(t, { flips: 0, until: () => fails.length > 0, engineOptions: { roleKeys: true, frontEnd } });
  const { f, engine } = scene;
  if (end === 'ignored') {
    const precheck = f.exec.precheck.bind(f.exec);
    f.exec.precheck = async (key, hk, subject, o = {}) => (o.origin === 'attempt2' ? { ignore: 'HEAD_ALREADY_PUBLISHED_NO_RETRY' } : precheck(key, hk, subject, o));
  }
  const [first] = await enqueuedOf(f);
  await untilScene(scene, async () => (await f.receipts.latest(['attempt2-scheduled'], 5)).some(r => r.value.body.key === first.key));
  const [scheduled] = (await f.receipts.latest(['attempt2-scheduled'], 5)).map(r => r.value.body).filter(b => b.key === first.key);
  assert.ok(scheduled, `no automatic attempt 2: ${await why(scene)}`);
  const key2 = scheduled.attempt2;
  const done = end !== 'ignored' ? async () => (await f.ledger.state(key2)).state === 'TERMINAL'
    : async () => (await f.receipts.latest(['attempt2-ignored'], 5)).some(r => r.value.body.key === key2);
  await untilScene(scene, done, 30);
  assert.ok(await done(), `the automatic attempt 2 did not end: ${await why(scene)}`);
  if (end !== 'ignored') {
    const s2 = await f.ledger.state(key2);
    assert.deepEqual([s2.outcome, s2.terminal?.facts?.failureCode, s2.terminal?.facts?.stage], ['FAILED_CLEAN', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 2], await why(scene));
  }
  assert.equal(await f.ledger.halted(), null);
  const T2 = sha(0x7d7d), S3 = sha(0x7e7e);
  if (end === 'main-moved') {
    scene.e.gh.world.commits.set(S3, { sha: S3, tree: sha(0x7f7f), parents: [T2, H] });
    scene.e.gh.world.main = T2;
    scene.e.gh.world.pulls.get(910).mergeCommitSha = S3;
  }
  const runsBefore = engine.trainRuns.length;
  for (let i = 0; i < 15 && engine.trainRuns.length === runsBefore; i++) { await f.exec.tick(); if (engine.trainRuns.length === runsBefore) f.advance(MIN); }
  assert.ok(engine.trainRuns.length > runsBefore, 'a stage 10 ran');
  const input = engine.trainInputs[runsBefore];
  assert.deepEqual([input.frontPr, input.frontHeadSha, input.frontTestSha, input.frontAttempt, input.frontCode, input.frontFailed],
    [910, H, S, 2, end !== 'ignored' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'HEAD_ALREADY_PUBLISHED_NO_RETRY', false], JSON.stringify(input));
  assert.notEqual(engine.trainRuns[runsBefore].decision, 'TRAIN_FRONT_BATCH_RUNNING', `${JSON.stringify(input)}; ${await why(scene)}`);
  // Two stage-10 rounds at most, one-minute ticks: TRAIN_FRONT_ATTEMPTS_USED, never TRAIN_FRONT_BATCH_RUNNING in between.
  for (let i = 0; i < 15 && engine.trainRuns.length < runsBefore + 2 && !engine.trainRuns.slice(runsBefore).some(r => r.decision === 'TRAIN_FRONT_ATTEMPTS_USED'); i++) {
    await f.exec.tick(); f.advance(MIN);
  }
  const after = engine.trainRuns.slice(runsBefore, runsBefore + 2).map(r => r.decision);
  assert.ok(after.includes('TRAIN_FRONT_ATTEMPTS_USED'), `${JSON.stringify(after)}; ${await why(scene)}`);
  assert.ok(!after.includes('TRAIN_FRONT_BATCH_RUNNING'), JSON.stringify(after));
  assert.deepEqual(scene.touches.filter(x => x.ciState === 'failed'), [], 'nothing failed is reported on the slot');
  assert.deepEqual(fails, end !== 'ignored' ? [1, 2] : [1], 'no third front batch ran');
  if (end === 'main-moved') {
    const refused = (await f.receipts.latest(['train-front-refused'], 5)).map(r => r.value.body);
    assert.deepEqual(refused.map(b => [b.testSha, b.attempt, b.failureCode]), [[S3, 2, 'TRAIN_FRONT_ATTEMPTS_USED']], `${JSON.stringify(after)}; ${await why(scene)}`);
  }
  assert.equal(await f.ledger.halted(), null);
});

// G2 (防回归): front number 1 ran its three scans and ended clean at stage 8. Front number 2 passes the gate; its stage 1 reads back this
// front's own scans on H (published-on-github-v2.mjs) and ends HEAD_PUBLISHED_ON_GITHUB (clean-final): no second set of scans, no HALT.
test('R3 batch 2 G2: front number 1 scanned and ended clean at stage 8 -> front number 2 passes the gate and ends at stage 1 (HEAD_PUBLISHED_ON_GITHUB)', async t => {
  const ends = [];
  const frontEnd = (subject, stage) => (subject.attempt === 1 && stage === 8 ? (ends.push(stage), cleanEnd('TRAIN_BATCH_CHANGED')) : null);
  const scene = await problemA(t, { flips: 0, until: () => ends.length > 0, engineOptions: { readBack: true, roleKeys: true, frontEnd } });
  const { e, f, engine } = scene;
  assert.deepEqual(frontStages(engine), [1, 2, 3, 4, 5, 6, 7, 8], await why(scene));
  const scans = scanChecksOnH(e);
  assert.equal(scans, 3, 'front number 1 published its three scans');
  newTenure(scene);
  let second = null;
  await untilScene(scene, async () => {
    second ??= (await enqueuedOf(f)).find(b => b.attempt === 2) ?? null;
    return second !== null && (await f.ledger.state(second.key)).state === 'TERMINAL';
  });
  assert.ok(second, `front number 2 was never opened: ${await why(scene)}`);
  const ended = await f.ledger.state(second.key);
  assert.deepEqual([ended.state, ended.outcome, ended.terminal?.facts?.failureCode, ended.terminal?.facts?.stage], ['TERMINAL', 'FAILED_CLEAN', 'HEAD_PUBLISHED_ON_GITHUB', 1], await why(scene));
  assert.deepEqual(engine.stages.filter(s => s.testSha === S && s.attempt === 2).map(s => s.stage), [1]);
  assert.deepEqual(await ignoredOf(f), []);
  assert.equal(scanChecksOnH(e), scans, 'no second set of scans');
  assert.equal(await f.ledger.halted(), null);
});

// Gate mode retains an unbound PR that has no exact holder authorization: body prose or a claim label cannot discover it.
test('strict-permanent (DESIGN §65): train.sweep gate still holds an unbound PR without Native holder authorization', async t => {
  const { e, f, engine } = await permanentArrival(t, { sweep: 'gate' });
  e.native.revokePRHead(910);
  assert.equal(await untilGreen(f, e), null);
  assert.equal(f.exec.trainTakeoverDone, false);
  assert.deepEqual(engine.stages, [], 'gate mode holds every batch before the take-over sweep');
  assert.equal(f.exec.trainStatus().sweepMode, 'gate');
});

// Strict read off in strict-permanent mode: stage 10 decides TRAIN_STRICT_OFF, opens no front batch and asks for PAUSE; the executor
// latches PAUSE (receipt 'paused') and tells the Owner; no merge-slot green. R3 lean regression: the same with the scans pinned to Actions.
for (const actionsScans of [false, true]) test(`strict-permanent (DESIGN §65): strict off${actionsScans ? ', scans from Actions' : ''} -> no green, TRAIN_STRICT_OFF, PAUSE latched and an Owner notice`, async t => {
  const { e, f, engine } = await permanentArrival(t, { strict: false, actionsScans });
  assert.equal(await untilGreen(f, e), null);
  const paused = (await f.receipts.latest(['paused'], 10)).map(r => r.value.body.reason);
  assert.ok(paused.includes('train-maintenance: TRAIN_STRICT_OFF'), JSON.stringify(paused));
  assert.ok(engine.trainRuns.some(r => r.decision === 'TRAIN_STRICT_OFF'), JSON.stringify(engine.trainRuns));
  assert.ok(!engine.trainRuns.some(r => r.open), 'no front batch opens with strict off');
  assert.ok(!engine.stages.some(s => s.testSha === S), 'no front batch runs');
  assert.equal(slotGreen(e, H), undefined);
  assert.ok(f.queue.notices.some(n => n.kind === 'train-owner' && n.code === 'TRAIN_STRICT_OFF'), JSON.stringify(f.queue.notices));
});

// Strict turned off between the front batch's open and its stage 8: stage 8 writes no green (the live-strict current-front route is the
// only one; no proof says fullSweepSinceOn) and the batch rests at B.
test('strict-permanent (DESIGN §65): strict switched off before the front batch\'s stage 8 -> stage 8 writes no green and rests at B', async t => {
  const { e, f, engine } = await permanentArrival(t);
  const run = engine.runStage;
  engine.runStage = async (batch, stage) => { if (stage.number === 8 && engine.subjects.get(batch.key)?.testSha) e.gh.world.strict = false; return run(batch, stage); };
  assert.equal(await untilGreen(f, e), null);
  assert.ok(engine.stages.some(s => s.testSha === S && s.stage === 8), JSON.stringify(engine.stages));
  assert.notEqual(engine.published?.status, 'SETTLED');
  assert.equal(slotGreen(e, H), undefined);
});

// Audit mode: one full round as a background audit, at most once a day; it never holds a green. Off: none at all.
test('strict-permanent (DESIGN §65): the audit round runs at its daily cadence and never holds the green; sweep off runs none', async t => {
  for (const sweep of ['audit', 'off']) await t.test(sweep, async t => {
    const e = await world(t, { quick: true });
    const at = { t };
    const engine = engineFor(e, at);
    const f = await executorFixture(t, { policy: permanentPolicy({ train: { sweep } }), engine, now: NOW });
    Object.assign(at, { clock: f.clock, advance: f.advance });
    await f.exec.trainRecover();
    assert.equal(f.exec.trainTakeoverDone, true, 'the gate is open from the start of the duty');
    const pages = () => engine.trainRuns.reduce((n, r) => n + r.created, 0);
    for (let i = 0; i < 12; i++) { await f.exec.tick(); f.advance(10 * MIN); }
    const full = await e.store.readFullSweepStrict('on');
    if (sweep === 'off') {
      assert.equal(pages(), 0, 'sweep off reads no full-sweep page');
      assert.notEqual(full?.full?.state, 'running');
    } else {
      assert.equal(full.full.state, 'complete', JSON.stringify(full.full));
      // Within a day of its completion no new round starts; after a day one does.
      const done = pages();
      for (let i = 0; i < 6 * 22; i++) { await f.exec.tick(); f.advance(10 * MIN); }
      assert.equal(pages(), done, 'no audit round within a day of the last one');
      for (let i = 0; i < 6 * 3; i++) { await f.exec.tick(); f.advance(10 * MIN); }
      assert.ok(pages() > done, 'the next audit round a day later');
    }
    assert.equal((await e.store.latestProof()).fullSweepSinceOn, false, 'a full round never covers a green in strict-permanent mode');
    // And the green does not wait for it.
    const arrival = f.clock();
    e.native.holders = undefined;
    e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
    e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: 'Change.\n', claim: CLAIM });
    await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
    assert.ok(await untilGreen(f, e), `${sweep}: no green; stage 10 said ${engine.lastFacts?.decision}`);
  });
});

// Field defect PR #1035 (2026-11-07): the front batch (with S) of the old head 5797132c rested at B after its stage 8 said
// REQUIRED_CHECK_FAILED. A new head 787ea0c5 was pushed; stage 10 said OPEN_FRONT_BATCH(1035, 787ea0c5) and then only
// TRAIN_FRONT_BATCH_RUNNING, while the executor stayed IDLE for 40 minutes: queue.json's row still ran the old head's parked batch,
// its current was the new head. During the take-over sweep resumeParked filtered every parked batch through the train gate before the
// supersede check (hold), and the old front batch is no longer the current front, so it was never ended as superseded and kept the row.
// Now a parked batch superseded by a newer commit ends at its safe point whatever the gate says, and the new head's front batch runs.
for (const [sweep, liveLate] of [['gate', false], ['audit', false], ['gate', true]]) test(`field #1035 (${sweep}${liveLate ? ', no live answer at first' : ''}): a front batch parked at B after a failed check, then a new head: the new head's front batch runs and gets the merge-slot green`, async t => {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at);
  const H2 = sha(0x7a7a), S2 = sha(0x7b7b), TREE2 = sha(0x7c7c);
  e.gh.world.commits.set(S2, { sha: S2, tree: TREE2, parents: [T, H2] });
  // The companion's live read of the PR: its current head.
  let liveHead = H, live = true;
  const companion = fakeCompanion({ pull: pr => (live ? { number: pr, state: 'open', headSha: liveHead } : null) });
  const f = await executorFixture(t, { policy: sweep === 'gate' ? policy() : permanentPolicy({ train: { sweep } }), engine, companion, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  // The old head's front batch: its stage 8 finds a required check failed and rests at B.
  const run = engine.runStage;
  engine.runStage = async (batch, stage) => {
    const subject = engine.subjects.get(batch.key);
    if (stage.number === 8 && subject.testSha === S) {
      engine.stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha, stage: 8, at: at.clock() });
      return { ok: false, code: 'REQUIRED_CHECK_FAILED', proof: PROOF, outcome: { status: 'BLOCKED', reason: 'REQUIRED_CHECK_FAILED', sideEffects: 0, mayHavePublished: false } };
    }
    return run(batch, stage);
  };
  await f.exec.trainRecover();
  for (let i = 0; i < 2; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const parked = async () => (await f.ledger.parkedEntries()).find(x => x.reserved?.subject?.testSha === S);
  for (let i = 0; i < 30 && !(await parked()); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(await parked(), `the old head's front batch is not parked at B: ${JSON.stringify(engine.stages)}`);
  // A new head is pushed to the same PR (the claim stays the queue head, bound to the PR). As in the field, stage 10 reads the PR on
  // GitHub before the poller's trigger reaches the queue: it names the new head and opens its front batch first.
  const pushed = f.clock();
  liveHead = H2;
  e.gh.pull(910, { head: H2, mergeCommitSha: S2, updated: iso(pushed), body: body(CLAIM), claim: CLAIM });
  f.exec.trainUrgent = true;
  // liveLate: the companion has no answer while stage 10 opens the new head's front batch and the trigger arrives (nothing may end on the
  // queue's order alone), so the front is refused as busy; the live answer comes back five minutes later.
  if (liveLate) live = false;
  for (let i = 0; i < 10 && engine.lastFacts?.front?.headSha !== H2; i++) { await f.exec.tick(); f.advance(MIN); }
  assert.equal(engine.lastFacts?.front?.headSha, H2, 'stage 10 saw the new head');
  t.diagnostic(`stage 10 on the new head: ${engine.lastFacts.decision}`);
  await f.drop(triggerBytes({ pr: 910, headSha: H2, baseSha: T }));
  if (liveLate) {
    for (let i = 0; i < 5; i++) { await f.exec.tick(); f.advance(MIN); }
    assert.ok(await parked(), 'without a live answer the parked batch stays');
    assert.ok((await f.receipts.latest(['train-front-refused'], 10)).some(r => r.value.body.headSha === H2 && r.value.body.failureCode === 'TRAIN_FRONT_PR_BUSY'));
    live = true;
  }
  let green = null;
  for (let i = 0; i <= 40 && !green; i++) { await f.exec.tick(); green = slotGreen(e, H2) ?? null; if (!green) f.advance(MIN); }
  const elapsed = f.clock() - pushed;
  assert.ok(green, `no merge-slot green for the new head within 40 minutes; stage 10 said ${engine.lastFacts?.decision}; parked ${JSON.stringify((await parked())?.key ?? null)}; `
    + `stages ${JSON.stringify(engine.stages.filter(s => s.at >= pushed))}`);
  t.diagnostic(`#1035 (${sweep}): new head's merge-slot green ${Math.round(elapsed / 1000)} s (simulated) after the push`);
  assert.equal(await parked(), undefined, 'the old head\'s parked batch ended');
  const ended = (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body).filter(b => b.failureCode === 'SUPERSEDED_AT_SAFE_POINT');
  assert.deepEqual(ended.map(b => b.safePoint), ['parked'], 'ended as superseded at its safe point');
  assert.deepEqual(engine.stages.filter(s => s.headSha === H2 && s.testSha === S2).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(slotGreen(e, H), undefined);
  if (liveLate) assert.equal((await f.receipts.latest(['train-front-reoffered'], 5)).length, 1, 'the refused front was offered again');
});

// Field defect PR #1035, the gate's side: during the take-over sweep a parked batch the train gate holds (here: the old head's front batch
// once no fresh strict observation names it) is still ended as superseded when its PR got a newer commit: ending publishes nothing.
test('field #1035: during the take-over a superseded parked batch ends at its safe point although the train gate holds it', async t => {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at);
  const H2 = sha(0x7a7a);
  let liveHead = H;
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: liveHead }) });
  const f = await executorFixture(t, { policy: policy(), engine, companion, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  const run = engine.runStage;
  engine.runStage = async (batch, stage) => {
    const subject = engine.subjects.get(batch.key);
    if (stage.number === 8 && subject.testSha === S) return { ok: false, code: 'REQUIRED_CHECK_FAILED', proof: PROOF, outcome: { status: 'BLOCKED', reason: 'REQUIRED_CHECK_FAILED', sideEffects: 0, mayHavePublished: false } };
    return run(batch, stage);
  };
  await f.exec.trainRecover();
  await f.exec.tick(); f.advance(10 * MIN);
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const parked = async () => (await f.ledger.parkedEntries()).find(x => x.reserved?.subject?.testSha === S);
  for (let i = 0; i < 30 && !(await parked()); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(await parked());
  // stage 10 stops answering (a clean refusal): the strict observation is dropped, the gate holds the parked front batch.
  engine.runTrainStage = async () => ({ ok: false, code: 'TRAIN_STAGE_REFUSED', proof: PROOF });
  f.exec.trainUrgent = true;
  await f.exec.tick(); f.advance(MIN);
  assert.equal(f.exec.trainTakeoverDone, false);
  assert.ok(f.exec.trainGate((await parked()).reserved.subject), 'the gate holds the old front batch');
  liveHead = H2;
  e.gh.pull(910, { head: H2, updated: iso(f.clock()), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H2, baseSha: T }));
  for (let i = 0; i < 5 && (await parked()); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.equal(await parked(), undefined, 'the superseded parked batch ended');
  const ended = (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body).filter(b => b.failureCode === 'SUPERSEDED_AT_SAFE_POINT');
  assert.deepEqual(ended.map(b => b.safePoint), ['parked']);
  assert.equal(f.queue.row(910).running, null, 'the row is free for the new head');
});

// Field defect 1b31b06b (PR #1037, 2026-11-07, resident receipts 3768-3812): the train front's batch for the old head 118f90a1 rested at B,
// its stage 8 said REQUIRED_CHECK_FAILED and returned the merge slot (the claim's merge ref removed: the claim left the queue). A new head
// 26ac75e4 was pushed; the old batch ended SUPERSEDED_AT_SAFE_POINT. The new head's ordinary batch then found the claim outside the queue at
// its stage 1 (mergeQueue entered false, rightly), did not give way (§62.6), ran stages 1-7 (13 minutes), and only its stage 8 joined the
// queue again; stage 10 opened the front 36 minutes after the push. Now the new head's stage 1 joins the queue again (Source
// claim-assist-native.mjs#stage1FrontRequeue: this node's newest front batch is this PR's, at another head, under this claim), Native's
// answer says it is the head of the empty queue, the ordinary batch gives way after stage 1 and the front batch (H2, S2) opens at once.
// End to end over the real executor, the real Source v2 stage 10 / sweep store / stage-8 publisher and the real stage1FrontRequeue (its
// claim-assist port answers from the offline Native: a join puts the claim back at the head of an empty queue).
test('field #1037 (1b31b06b): the front PR\'s old head rests at B after a failed check (slot returned), a new head is pushed: its ordinary batch gives way after stage 1, the front opens at once', async t => {
  const e = await world(t, { quick: true });
  const at = { t };
  const engine = engineFor(e, at);
  const H2 = sha(0x7a7a), S2 = sha(0x7b7b), TREE2 = sha(0x7c7c);
  e.gh.world.commits.set(S2, { sha: S2, tree: TREE2, parents: [T, H2] });
  let liveHead = H;
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: liveHead }) });
  const f = await executorFixture(t, { policy: policy(), engine, companion, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  // An older Source has no stage1FrontRequeue: the stage-1 result is reported as it is (what ran in the field).
  const requeue = claimAssistModule.stage1FrontRequeue ?? (async ({ result }) => result);
  const joins = [];
  const claimAssist = { async joinQueue({ pr, headSha }) {
    joins.push([pr, headSha]);
    if (e.native.holder) return { ok: true, joined: false, reason: 'already_queued', mergeQueue: { entered: true, state: e.native.holder.claimId === CLAIM ? 'head' : 'waiting', position: e.native.holder.claimId === CLAIM ? 1 : 2 } };
    e.native.holder = holderOf({ takenAt: iso(f.clock()), mergeSlotUntil: iso(f.clock() + 45 * MIN) });
    return { ok: true, joined: true, reason: null, mergeQueue: { entered: true, state: 'head', position: 1 } };
  } };
  const run = engine.runStage;
  engine.runStage = async (batch, stage) => {
    const subject = engine.subjects.get(batch.key);
    // The old head's front batch: a required check failed; stage 8 returns the slot (the claim leaves the queue) and rests at B.
    if (stage.number === 8 && subject.testSha === S) {
      engine.stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha, stage: 8, at: at.clock() });
      e.native.holder = null;
      return { ok: false, code: 'REQUIRED_CHECK_FAILED', proof: PROOF, outcome: { status: 'BLOCKED', reason: 'REQUIRED_CHECK_FAILED', sideEffects: 0, mayHavePublished: false,
        scheduling: { ciRetryAfter: null, claimExpiresAt: null, mergeQueue: { entered: false, state: null, position: null } } } };
    }
    // An ordinary batch's stage 1 while the claim is outside the queue: Native says so; the Source's stage 1 may then join again.
    if (stage.number === 1 && !subject.testSha && e.native.holder === null) {
      engine.stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: null, stage: 1, at: at.clock() });
      e.gh.green(10, subject.headSha, { name: 'kooyumi-work-admission' });
      const job = batchJobsV2({ repo: REPO, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.headSha, sourceManifestSha256: CI_SOURCE,
        createdAt: iso(at.clock()), attempt: 1 })['work-admission'];
      const settled = { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, diagnostic: null, safeToRerun: false,
        scheduling: { ciRetryAfter: null, claimExpiresAt: null, mergeQueue: { entered: false, state: null, position: null } } };
      const outcome = await requeue({ result: settled, job, trainMode: 'on', claimAssist, sweepStore: e.store, batchClaim: { claimId: CLAIM, fence: 3, epoch: 1 }, record() {} });
      return { ok: true, factsSha256: 'd'.repeat(64), proof: PROOF, outcome };
    }
    return run(batch, stage);
  };
  await f.exec.trainRecover();
  for (let i = 0; i < 12 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  assert.equal(f.exec.trainTakeoverDone, true);
  // The PR arrives; its claim is the queue head (not yet bound): the ordinary batch gives way, the front batch (H, S) runs and rests at B.
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const parked = async () => (await f.ledger.parkedEntries()).find(x => x.reserved?.subject?.testSha === S);
  for (let i = 0; i < 40 && !(await parked()); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(await parked(), `the old head's front batch is not parked at B: ${JSON.stringify(engine.stages)}`);
  assert.equal(e.native.holder, null, 'its stage 8 returned the slot');
  // The new head is pushed.
  const pushed = f.clock();
  liveHead = H2;
  e.gh.pull(910, { head: H2, mergeCommitSha: S2, updated: iso(pushed), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H2, baseSha: T }));
  let green = null;
  for (let i = 0; i <= 40 && !green; i++) { await f.exec.tick(); green = slotGreen(e, H2) ?? null; if (!green) f.advance(MIN); }
  const after = engine.stages.filter(s => s.at >= pushed);
  // The new head's ordinary batch ran stage 1 only, then gave way; the front batch (H2, S2) ran stages 1-8.
  assert.deepEqual(after.filter(s => s.headSha === H2 && s.testSha === null).map(s => s.stage), [1], `the new head's ordinary batch ran past stage 1: ${JSON.stringify(after)}`);
  assert.deepEqual(joins, [[910, H2]], 'stage 1 joined the queue again, once');
  const yields = (await f.receipts.latest(['train-front-yield'], 10)).map(r => r.value.body).filter(y => y.headSha === H2);
  assert.deepEqual(yields.map(y => [y.pr, y.mergeQueue?.state, y.mergeQueue?.position]), [[910, 'head', 1]]);
  assert.deepEqual(after.filter(s => s.headSha === H2 && s.testSha === S2).map(s => s.stage), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(green, `no merge-slot green for the new head; stage 10 said ${engine.lastFacts?.decision}; stages ${JSON.stringify(after)}`);
  t.diagnostic(`#1037: the new head's merge-slot green ${Math.round((f.clock() - pushed) / 1000)} s (simulated) after the push`);
  const ended = (await f.receipts.latest(['batch-terminal'], 50)).map(r => r.value.body).filter(b => b.failureCode === 'SUPERSEDED_AT_SAFE_POINT');
  assert.deepEqual(ended.map(b => b.safePoint), ['parked'], 'the old head\'s parked batch ended as superseded at its safe point');
});

// Guard (1b31b06b): a PR this node never opened a front batch for, whose claim is outside the queue, never joins at stage 1 and runs its
// ordinary batch through stages 1-7 as before (it joins at stage 8).
test('field #1037 (1b31b06b): a PR that was never the train front does not join at stage 1 and runs on past stage 1', async t => {
  const e = await world(t, { quick: true });
  const at = { t };
  const engine = engineFor(e, at);
  const f = await executorFixture(t, { policy: policy(), engine, now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  const joins = [];
  const claimAssist = { async joinQueue(i) { joins.push(i); return { ok: true, joined: true, reason: null, mergeQueue: { entered: true, state: 'head', position: 1 } }; } };
  const run = engine.runStage;
  engine.runStage = async (batch, stage) => {
    const subject = engine.subjects.get(batch.key);
    if (stage.number === 1 && !subject.testSha) {
      engine.stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: null, stage: 1, at: at.clock() });
      const job = batchJobsV2({ repo: REPO, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, testSha: subject.headSha, sourceManifestSha256: CI_SOURCE,
        createdAt: iso(at.clock()), attempt: 1 })['work-admission'];
      const settled = { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, diagnostic: null, safeToRerun: false,
        scheduling: { ciRetryAfter: null, claimExpiresAt: null, mergeQueue: { entered: false, state: null, position: null } } };
      return { ok: true, factsSha256: 'd'.repeat(64), proof: PROOF,
        outcome: await (claimAssistModule.stage1FrontRequeue ?? (async ({ result }) => result))({ result: settled, job, trainMode: 'on', claimAssist, sweepStore: e.store, batchClaim: { claimId: CLAIM, fence: 3, epoch: 1 }, record() {} }) };
    }
    return run(batch, stage);
  };
  await f.exec.trainRecover();
  for (let i = 0; i < 12 && !f.exec.trainTakeoverDone; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  e.native.holders = undefined;
  e.native.holder = null;
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(f.clock()), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  for (let i = 0; i < 10 && !engine.stages.some(s => s.stage === 7); i++) { await f.exec.tick(); f.advance(MIN); }
  assert.deepEqual(joins, [], 'no join: this node never opened a front batch for the PR');
  assert.deepEqual(engine.stages.filter(s => s.pr === 910 && s.testSha === null).map(s => s.stage).slice(0, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await f.receipts.latest(['train-front-yield'], 5)).length, 0);
});

// ---- bc982192 parked-front, redone on frontFailed (D:/w/tmp/FABLE-parked-front-vs-frontfailed-20261123.md §1 item 2, §3) ----
// The front batch (H, S) of PR 910 rests at B (its stage 8 found a required check failed). parkedFront: that scene, and the next front.
async function parkedFront(t) {
  const e = await world(t);
  const at = { t };
  const engine = engineFor(e, at);
  const S2 = sha(0x5e5e), TREE2 = sha(0x5e5f);
  e.gh.world.commits.set(S2, { sha: S2, tree: TREE2, parents: [T, H] });
  const f = await executorFixture(t, { policy: policy(), engine, companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: H }) }), now: NOW });
  Object.assign(at, { clock: f.clock, advance: f.advance });
  const run = engine.runStage;
  engine.runStage = async (batch, stage) => {
    const subject = engine.subjects.get(batch.key);
    if (stage.number === 8 && subject.testSha === S) {
      engine.stages.push({ pr: subject.pr, headSha: subject.headSha, testSha: subject.testSha, stage: 8, at: at.clock() });
      return { ok: false, code: 'REQUIRED_CHECK_FAILED', proof: PROOF, outcome: { status: 'BLOCKED', reason: 'REQUIRED_CHECK_FAILED', sideEffects: 0, mayHavePublished: false } };
    }
    return run(batch, stage);
  };
  const inputs = [], ten = engine.runTrainStage;
  engine.runTrainStage = async (mode, input) => { inputs.push(input); return ten(mode, input); };
  await f.exec.trainRecover();
  for (let i = 0; i < 2; i++) { await f.exec.tick(); f.advance(10 * MIN); }
  const arrival = f.clock();
  e.native.holders = undefined;
  e.native.holder = holderOf({ boundPrs: [], prs: [], boundPr: null, pr: null, takenAt: iso(arrival), mergeSlotUntil: iso(arrival + 45 * MIN) });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(arrival), body: body(CLAIM), claim: CLAIM });
  await f.drop(triggerBytes({ pr: 910, headSha: H, baseSha: T }));
  const parked = async () => (await f.ledger.parkedEntries()).find(x => x.reserved?.subject?.testSha === S);
  for (let i = 0; i < 30 && !(await parked()); i++) { await f.exec.tick(); f.advance(MIN); }
  const entry = await parked();
  assert.ok(entry, `the front batch (H, S) is not parked at B: ${JSON.stringify(engine.stages)}`);
  const next = { pr: 910, headSha: H, baseSha: T, testSha: S2, testTree: TREE2, attempt: 2, claimId: CLAIM, since: iso(arrival) };
  return { e, engine, f, entry, next, S2, inputs, parked };
}

// T3: stage 10 names a new S for the same head while the old front batch rests at B. The old batch ends at once as TRAIN_FRONT_TAKES_OVER
// (stage 10 is the only one that opens front batches: its naming is the fact), the row takes (H, S2), and the old batch's end is
// receipted with frontFailed false. It is not carried: the stage 10 that named S2 knows S ended, and a report that a batch of this head
// only ended is dropped once the head's next front batch is taken (bc982192 parked-front v2 §2.2 B). Before the fix the offer was
// refused as busy and S could never pass stage 8 again.
test('parked-front T3: a front batch resting at B gives way to a new S of the same head; its end is receipted with frontFailed false', async t => {
  const { f, entry, next, S2, inputs, parked } = await parkedFront(t);
  const key = await f.exec.enqueueFront(next);
  assert.notEqual(key, null, JSON.stringify((await f.receipts.latest(['train-front-refused'], 5)).map(r => r.value.body)));
  assert.equal(await parked(), undefined, 'the old front batch no longer rests at B');
  assert.equal((await f.ledger.state(entry.key)).terminal?.facts?.failureCode, 'TRAIN_FRONT_TAKES_OVER');
  assert.equal(f.queue.row(910).current.testSha, S2);
  assert.deepEqual((await f.receipts.latest(['train-front-ended'], 5)).map(r => [r.value.body.frontOutcome.testSha, r.value.body.frontOutcome.code]), [[S, 'TRAIN_FRONT_TAKES_OVER']]);
  assert.equal(f.exec.trainFrontOutcome, null, 'dropped once (H, S2) is taken');
  const before = inputs.length;
  f.exec.trainUrgent = true;
  for (let i = 0; i < 5 && inputs.length === before; i++) { await f.exec.tick(); f.advance(MIN); }
  assert.ok(inputs.length > before, 'a train run ran');
  assert.deepEqual(inputs.slice(before).filter(x => x.frontTestSha === S), [], 'no stage 10 is told S ended (it would name S2 had S2 the same S)');
});

// T3b (a guard, green before and after): the urgent stage 10 that stage8Try runs before a try of this very batch (frontProofShort)
// names a new S for the same PR. That batch is being executed, not resting: it is never ended there; the offer is refused as busy and
// the try goes on.
test('parked-front T3b: a new S named during the batch\'s own stage-8 try never ends the batch being executed', async t => {
  const { engine, f, entry, next } = await parkedFront(t);
  let inTry = false, offered;
  f.exec.frontProofShort = subject => { inTry = subject?.testSha === S && offered === undefined; return inTry; };
  f.exec.trainMaintenance = async () => { if (!inTry) return null; inTry = false; offered = await f.exec.enqueueFront(next); return null; };
  const tries = () => engine.stages.filter(s => s.testSha === S && s.stage === 8).length, before = tries();
  for (let i = 0; i < 40 && offered === undefined; i++) { await f.exec.tick(); f.advance(5 * MIN); }
  assert.notEqual(offered, undefined, 'the batch\'s stage-8 try ran stage 10');
  assert.equal(offered, null, 'refused as busy');
  assert.equal(tries(), before + 1, 'the try went on');
  assert.notEqual((await f.ledger.state(entry.key)).terminal?.facts?.failureCode, 'TRAIN_FRONT_TAKES_OVER');
  assert.deepEqual((await f.receipts.latest(['train-front-takes-over'], 10)).map(r => r.value.body), []);
});

// ---- bc982192 parked-front v2 rework (D:/w/tmp/FABLE-parked-front-attempt2-number-20261123.md §4 N6, N8) ----
// N6 (防误杀; green before the fix, red without §2.2 B): front number 1 of S ended clean at stage 8 and was reported ended (frontFailed
// false; F1). Stage 10 opens its number 2 of the same S and the executor takes it; the report of number 1 is dropped there (and a
// restart does not bring it back: it is older than the head's newest train-front-enqueued). So while number 2 is in, no stage 10 is told
// S ended: it says TRAIN_FRONT_BATCH_RUNNING. Stage 10 knows its batch by S alone now: an old report of S would end number 2.
// Number 2's row is held here (it stays queued), so the rounds see it in flight.
for (const restart of [false, true]) test(`parked-front N6 (${restart ? 'a restart after the enqueue' : 'one process'}): the report of front number 1 never ends number 2 of the same S`, async t => {
  const scene = await problemA(t, { push: true });
  const { engine } = scene;
  assert.equal(scene.ended(), 1, await why(scene));
  newTenure(scene);
  const hold = exec => {
    const runRow = exec.runRow.bind(exec);
    exec.runRow = async (c, usage) => (Object.hasOwn(c, 'testSha') && c.frontAttempt === 2 ? { state: 'DEFERRED', key: null, reason: 'N6_HELD' } : runRow(c, usage));
  };
  const old = scene.f.exec, enqueue = old.enqueueFront.bind(old);
  let in2 = false;
  old.enqueueFront = async front => { const k = await enqueue(front); if (k && front.attempt === 2) in2 = true; return k; };
  hold(old);
  for (let i = 0; i <= 30 && !in2; i++) { await old.tick(); if (!in2) scene.f.advance(MIN); }
  assert.ok(in2, `front number 2 never enqueued: ${await why(scene)}`);
  let f = scene.f;
  if (restart) {
    f = await executorFixture(t, { policy: permanentPolicy(), engine, root: scene.f.root, now: scene.f.clock() });
    Object.assign(scene.at, { clock: f.clock, advance: f.advance });
    Object.assign(scene, { f });
    hold(f.exec);
    await f.exec.trainRecover();
  }
  const runsBefore = engine.trainRuns.length;
  for (let i = 0; i <= 30 && engine.trainRuns.length < runsBefore + 2; i++) { await f.exec.tick(); f.advance(MIN); }
  const later = engine.trainRuns.slice(runsBefore).map(r => r.decision);
  const carried = engine.trainInputs.slice(runsBefore).map(x => [x.frontTestSha === S, x.frontAttempt, x.frontCode]);
  assert.ok(later.length >= 2, await why(scene));
  assert.deepEqual(later, later.map(() => 'TRAIN_FRONT_BATCH_RUNNING'), `carried ${JSON.stringify(carried)}; ${await why(scene)}`);
});

// N8 (review follow-up 3): the take-over report is not urgent (the stage 10 that named (H, S2) already knows the old batch ended).
test('parked-front N8: the TRAIN_FRONT_TAKES_OVER report makes no early stage 10', async t => {
  const { f, next } = await parkedFront(t);
  f.exec.trainUrgent = false;
  assert.notEqual(await f.exec.enqueueFront(next), null);
  assert.deepEqual((await f.receipts.latest(['train-front-ended'], 5)).map(r => r.value.body.frontOutcome.code), ['TRAIN_FRONT_TAKES_OVER']);
  assert.equal(f.exec.trainUrgent, false, 'not urgent');
});

// ---- bc982192 parked-front v2, review 2 must-fix 1: holdsFront's frontRetry branch (DESIGN §85 item 3: busy is not an end) ----
// H1: the T3b scene. The new S2 is refused as busy while the batch (H, S) is in its own stage-8 try, so it is kept as frontRetry.
// Nothing here ends (H, S2): it is offered again. So no end of S2 is reported: a report would make stage 10 count S2 ended (another of
// the head's front attempts used up, or a batch of several taken over by a new S). Offered again once the try is over, it is taken; the
// only end reported is the old batch's (TRAIN_FRONT_TAKES_OVER).
test('parked-front H1: a front batch refused as busy is kept for frontRetry and not reported ended; taken later, one report in all', async t => {
  const { f, next, S2 } = await parkedFront(t);
  let inTry = false, offered;
  f.exec.frontProofShort = subject => { inTry = subject?.testSha === S && offered === undefined; return inTry; };
  f.exec.trainMaintenance = async () => { if (!inTry) return null; inTry = false; offered = await f.exec.enqueueFront(next); return null; };
  for (let i = 0; i < 40 && offered === undefined; i++) { await f.exec.tick(); f.advance(5 * MIN); }
  assert.equal(offered, null, 'refused as busy');
  assert.equal(f.exec.frontRetry?.testSha, S2, 'kept to offer again');
  const ended = async () => (await f.receipts.latest(['train-front-ended', 'train-front-outcome'], 10)).map(r => [r.value.body.frontOutcome.testSha, r.value.body.frontOutcome.code]);
  assert.deepEqual(await ended(), [], 'busy is not an end');
  assert.equal(f.exec.trainFrontOutcome?.testSha === S2, false);
  assert.notEqual(await f.exec.enqueueFront(next), null, 'taken once the try is over');
  assert.equal(f.queue.row(910).current.testSha, S2);
  assert.deepEqual(await ended(), [[S, 'TRAIN_FRONT_TAKES_OVER']], 'one report in all: the old batch\'s');
});
