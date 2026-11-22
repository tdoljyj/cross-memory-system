// bors-style landing, end to end (resident ADR 0018): the real Source v2 stage 10 (runTrain), sweep store and green ledger and the
// real stage-8 control publisher, over an offline GitHub that models commits, refs, GitHub's test merges, the cumulative merges of
// POST /merges, fast-forward-only PATCH of main, PRs marked merged once main contains their head, and the GitHub Actions required
// check ci-suites on clued-train/staging; and an offline Native merge queue (one slot holder, the queue behind it, adopt and touch
// failed). The executor between stage 10 and stage 8 is a short loop here (stages 1-7 pass).
//   1. three PRs queued -> one batch -> main fast-forwarded to S -> all three marked merged and adopted;
//   2. the middle PR breaks the combination -> bisection -> the other two land, the middle one is reported failed;
//   3. someone else moves main between the check and the write -> the fast-forward is refused -> retested on the new main -> lands.
//   4. (ADR 0019) batchMax 3 as production gets it: the resident engine's stage-10 argument (push:3:chain only while its installed Source
//      and the Linux side take descriptor /4) -> the invoker's stage file -> stage 10 composes one batch of three -> the resident writes
//      descriptor /4 whose members and tree are that S's chain -> all three land in one push; without the chain fact: one PR per batch.
// Every stage 10 here reads its batch size from a stage file (trainLanding), as production does; nothing injects a batch size.
// This file imports only modules that exist without the landing (the landing port is the offline one below): before ADR 0018 nothing
// lands and every scenario fails on its first assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setup, jobOf, iso, REPO, NOW, SOURCE } from './train-strict-fixtures.mjs';
import { tempDir, admittedFacts } from './resident-v2-fixtures.mjs';
import { batchJobsV2, claimGeneration } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { digest } from '../src/proof.mjs';
import { createFixtureControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { runTrain } from '../src/independent-control-checks-v2/train-maintenance.mjs';
import { batchChainOk, parseStageTrainLanding, stageTrainLandingText } from '../src/independent-control-checks-v2/train-landing.mjs';
import { validateTrainFacts, REQUIRED_CHECKS_MAX_WAIT_MS } from '../src/independent-control-checks-v2/train-facts.mjs';
import { parseLandingArg, prepareStageDirectory } from '../src/resident-v2/invoke-stage.mjs';
import { readStageBatchRoute, stageBatchRouteText, STAGE_BATCH_ROUTE_FILE } from '../src/independent-control-checks-v2/batch-route.mjs';
import { makeTrainRun } from '../src/resident-v2/train-run.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createFullAdmissionPortV2 } from '../src/full-admission-v2.mjs';
import { mergeSlotState } from '../../../../scripts/ci/clued-work-admission.mjs';
import { Poller, MAIN_REF_ROUTE, PULLS_ROUTE } from '../../../independent-ci-resident-v1/src/poller.mjs';
import { WindowsEngine, DESCRIPTOR_CHAIN_CONTRACT, DESCRIPTOR_CONTRACT } from '../../../independent-ci-resident-v1/src/engine-windows.mjs';
import { chainOfFront, openFrontBatchOf } from '../../../independent-ci-resident-v1/src/train.mjs';
import { AdmissionRerunner, AdmissionRerunState, decide, HEAD_RECHECK_MS } from '../../../independent-ci-resident-v1/src/admission-rerun.mjs';
import { parseStatus, pollerLandingOf, StatusBoard } from '../../../independent-ci-resident-v1/src/status.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../../../independent-ci-resident-v1/src/policy.mjs';
import { CLEAN_PROOF, executorFixture, fakeEngine, rawPolicy, TEST_NODE, TEST_NODE_SHA } from '../../../independent-ci-resident-v1/test/helpers.mjs';

const APP = 5368905, ACTIONS = 15368, SCOPE = 'project:00000000-0000-4000-8000-000000000000';
const h = s => createHash('sha1').update(s).digest('hex');
const claimOf = pr => `${String(pr).padStart(8, '0')}-2222-4333-8444-555555555555`;
const body = pr => `Change.\n\nClued-Work-Claim: ${claimOf(pr)}\nClued-Work-Scope: ${SCOPE}\n`;
const healthy = { nodes: [{ node: { name: 'turing', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }] };

// ---- the world ----
// main's rulesets (Fable 2026-11-20 三态选路, 补：bypass 名单读不到): 'push' is the state after the Owner's two steps (an independent
// fast-forward-only ruleset App 5368905 cannot bypass, and the main ruleset with kooyumi-train-landed that it can always bypass); 'today'
// is production before them (the main ruleset alone holds non_fast_forward and deletion, no kooyumi-train-landed, the App cannot bypass
// it). The publisher reads only current_user_can_bypass (this App's own bypass); who else is on a list it does not read.
const MAIN_RS = 24182890, FF_RS = 27500001;
const FOUR = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
// R3 lean: the three scans, each required from this App or (not in appScans) from GitHub Actions, which then runs it on every commit.
const SCANS = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
function rulesOf(kind, appScans = SCANS) {
  const push = kind === 'push';
  return [{ type: 'pull_request', rulesetId: MAIN_RS, parameters: { allowed_merge_methods: ['merge'] } },
    { type: 'non_fast_forward', rulesetId: MAIN_RS, parameters: null }, { type: 'deletion', rulesetId: MAIN_RS, parameters: null },
    ...(push ? [{ type: 'non_fast_forward', rulesetId: FF_RS, parameters: null }, { type: 'deletion', rulesetId: FF_RS, parameters: null }] : []),
    { type: 'required_status_checks', rulesetId: MAIN_RS, parameters: { strict_required_status_checks_policy: true, required_status_checks: [
      ...['kooyumi-work-admission', ...appScans, 'kooyumi-admission-verified', 'kooyumi-merge-slot', ...(push ? ['kooyumi-train-landed'] : [])]
        .map(context => ({ context, integration_id: 5368905 })),
      ...[...FOUR, ...SCANS.filter(n => !appScans.includes(n))].map(context => ({ context, integration_id: 15368 }))] } }];
}
const rulesetsOf = kind => new Map(kind === 'push'
  ? [[MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'always' }], [FF_RS, { id: FF_RS, currentUserCanBypass: 'never' }]]
  : [[MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'never' }]]);

// queued false: nobody is in Native's merge queue yet (stage 8 joins it); admitted false: no stage 1 has run on any head yet; appScans: the
// scans main requires from this App (bc982192 E3: none).
async function world(t, { prs, bad = () => false, sharedClaim = false, rules = 'push', behind = 0, queued = true, admitted = true, appScans = SCANS }) {
  const e = await setup(t, { strict: true, fullDone: false, native: healthy, tick: 1 });
  e.claimFor = sharedClaim ? () => claimOf(prs[0]) : claimOf;
  e.native.bindings = new Map(prs.map(pr => [pr, { claimId: e.claimFor(pr), scope: SCOPE, headAuthorizationId: claimOf(pr) }]));
  const W = { commits: new Map(), content: new Map(), refs: new Map(), checks: new Map(), pulls: new Map(), nextCheck: 1000, beforeFastForward: null, pushes: [] };
  e.W = W;
  const treeOf = set => h(`tree:${[...set].sort().join(',')}`);
  const commit = (sha, parents, content) => { if (!W.commits.has(sha)) { W.commits.set(sha, { sha, tree: treeOf(content), parents }); W.content.set(sha, new Set(content)); } return sha; };
  const ancestor = (a, b) => { const seen = new Set(), todo = [b]; while (todo.length) { const x = todo.pop(); if (x === a) return true; if (seen.has(x)) continue; seen.add(x); todo.push(...(W.commits.get(x)?.parents ?? [])); } return false; };
  // GitHub's test merge of a PR stays the same commit while base and head stay; every POST /merges makes a new commit (its own dates).
  const merge = (a, b, salt = '') => commit(h(`merge:${a}:${b}${salt}`), [a, b], [...W.content.get(a), ...W.content.get(b)]);
  let mergesMade = 0;
  W.merge = merge; W.ancestor = ancestor;
  const T0 = commit(h('T0'), [], []);
  // behind: main has moved that many commits past T0, the commit every PR head is on (nobody merged main into them).
  let tip = T0;
  for (let i = 1; i <= behind; i++) tip = commit(h(`M${i}`), [tip], Array.from({ length: i }, (_, k) => `m${k + 1}`));
  W.refs.set('heads/main', tip); W.T0 = T0;
  // GitHub Actions: the four required checks of the main ruleset, by their own names
  const actions = sha => {
    for (const name of [...FOUR, ...SCANS.filter(n => !appScans.includes(n))]) {
      const id = W.nextCheck++;
      W.checks.set(id, { id, app: { id: ACTIONS }, name, head_sha: sha, status: 'completed',
        conclusion: bad(W.content.get(sha)) ? 'failure' : 'success', completed_at: iso(e.now - 5 * 60_000) });
    }
  };
  for (const pr of prs) {
    const head = commit(h(`head:${pr}`), [T0], [String(pr)]);
    // autoMerge: the author turned GitHub auto-merge on (every agent PR does, gh pr merge --auto); paths: its changed files (null: unreadable)
    W.pulls.set(pr, { number: pr, head, state: 'open', merged: false, updated: iso(NOW - 3_600_000 + pr), body: body(pr), autoMerge: true, paths: ['a.txt'] });
    actions(head); // the PR's own CI on its head (pull_request)
    if (!admitted) continue;
    const id = W.nextCheck++; // stage 1 admitted it: App 5368905's kooyumi-work-admission on the head
    W.checks.set(id, { id, app: { id: APP }, name: 'kooyumi-work-admission', head_sha: head, status: 'completed', conclusion: 'success' });
  }
  const markMerged = () => { for (const p of W.pulls.values()) if (p.state === 'open' && ancestor(p.head, W.refs.get('heads/main'))) Object.assign(p, { state: 'closed', merged: true, mergeSha: W.refs.get('heads/main') }); };
  // GitHub (the checks port's reads, over this world)
  const gh = e.gh;
  gh.world.pulls.clear();
  Object.defineProperty(gh.world, 'main', { get: () => W.refs.get('heads/main'), set: () => {} });
  gh.readBranchHead = async () => ({ name: 'main', sha: W.refs.get('heads/main') });
  W.rules = rulesOf(rules, appScans); W.rulesets = rulesetsOf(rules);
  W.setRules = kind => { W.rules = rulesOf(kind, appScans); W.rulesets = rulesetsOf(kind); };
  gh.readBranchRules = async () => ({ complete: true, branch: 'main', rules: structuredClone(W.rules) });
  // GET /rulesets/{id} as github.mjs#readRuleset answers it: this App's own bypass of the ruleset (current_user_can_bypass)
  gh.readRuleset = async id => {
    const r = W.rulesets.get(id);
    if (!r) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' });
    return structuredClone(r);
  };
  gh.readPullRequest = async n => {
    const p = W.pulls.get(n), main = W.refs.get('heads/main');
    const testMerge = p.state === 'open' ? (ancestor(p.head, main) ? null : merge(main, p.head)) : null;
    return { number: n, state: p.state, draft: false, merged: p.merged, mergeable: p.state === 'open', merge_commit_sha: p.merged ? p.mergeSha : testMerge, body: p.body,
      auto_merge: p.autoMerge ? { merge_method: 'merge' } : null,
      head: { sha: p.head, ref: `topic-${n}`, repo: { full_name: REPO } }, base: { ref: 'main', sha: main, repo: { full_name: REPO } } };
  };
  gh.readChangedPaths = async j => {
    const p = W.pulls.get(j.pr);
    if (!p || p.paths === null) throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' });
    return { complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: [...p.paths] };
  };
  gh.readCompare = async (base, head) => base === head ? { status: 'identical', aheadBy: 0, behindBy: 0 }
    : ancestor(base, head) ? { status: 'ahead', aheadBy: 1, behindBy: 0 } : ancestor(head, base) ? { status: 'behind', aheadBy: 0, behindBy: 1 } : { status: 'diverged', aheadBy: 1, behindBy: 1 };
  gh.readGitCommit = async s => { const c = W.commits.get(s); if (!c) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); return structuredClone(c); };
  const listChecks = s => [...W.checks.values(), ...[...gh.world.checks.values()]].filter(c => c.head_sha === s).map(c => structuredClone(c));
  gh.readChecks = async s => ({ complete: true, checks: listChecks(s) });
  gh.readPullsPage = async ({ state = 'all', sort = 'updated', page = 1, perPage = 100 }) => {
    let list = [...W.pulls.values()].filter(p => state === 'all' || p.state === state);
    list = sort === 'created' ? list.sort((a, b) => a.number - b.number) : list.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    const slice = list.slice((page - 1) * perPage, page * perPage);
    return { complete: true, page, pulls: slice.map(p => ({ number: p.number, state: p.state, updatedAt: p.updated, headSha: p.head, baseRef: 'main', merged: p.merged })), last: slice.length < perPage };
  };
  gh.readPullsUpdatedSince = async () => ({ complete: true, pulls: [], newest: null });
  gh.readPullCommitsBounded = async n => ({ complete: true, tooMany: false, count: 1, headSha: W.pulls.get(n).head, commits: [W.pulls.get(n).head] });
  gh.readForcePushes = async () => ({ complete: true, events: [] });
  // The landing port (refs only), as train-landing-port.mjs answers.
  e.port = {
    async fastForwardMain(s) {
      W.beforeFastForward?.(); W.beforeFastForward = null;
      W.pushes.push(s);
      if (!W.commits.has(s) || !ancestor(W.refs.get('heads/main'), s)) return { status: 422, sha: null };
      W.refs.set('heads/main', s); markMerged();
      return { status: 200, sha: s };
    },
    async pointRef(ref, s) {
      assert.ok(['heads/clued-train/staging', 'heads/clued-train/staging.tmp'].includes(ref), ref);
      W.refs.set(ref, s);
      if (ref === 'heads/clued-train/staging' && !listChecks(s).some(c => c.app.id === ACTIONS)) actions(s); // the push trigger runs CI on S
      return { sha: s };
    },
    async mergeIntoTmp(head) {
      W.beforeMerge?.();
      const base = W.refs.get('heads/clued-train/staging.tmp');
      if (ancestor(head, base)) return { status: 204, sha: null };
      const m = merge(base, head, `:post${++mergesMade}`); W.refs.set('heads/clued-train/staging.tmp', m); return { status: 201, sha: m };
    },
  };
  // Native: one slot holder (the head of the queue), the rest waiting; adopt and touch failed leave the queue.
  const queue = queued ? [...prs] : [];
  let takenAt = iso(NOW - 300_000), ci = { ciState: null, ciHeadSha: null }, slotUntil = NOW + 3_600_000;
  const holder = () => {
    if (!queue.length) return null;
    const prs = queue.filter(pr => e.claimFor(pr) === e.claimFor(queue[0])).sort((a,b)=>a-b), boundPrs = prs.map(pr=>`${REPO}#${pr}`);
    return { claimId: e.claimFor(queue[0]), taskId: e.claimFor(queue[0]), boundPrs, prs,
      boundPr: prs.length === 1 ? boundPrs[0] : null, pr: prs.length === 1 ? prs[0] : null,
      mergeSlotUntil: iso(slotUntil), takenAt, ...ci, hardCapUntil: null };
  };
  const leave = pr => { const i = queue.indexOf(pr); if (i < 0) return; queue.splice(i, 1); if (i === 0) { takenAt = iso(e.now); ci = { ciState: null, ciHeadSha: null }; slotUntil = e.now + 3_600_000; } };
  e.queue = queue; e.adopted = []; e.failed = [];
  Object.assign(e.native.port, {
    async holders() { const x = holder(); return { onDuty: true, holders: x ? [x] : [] }; },
    async nodesStatus() { return { deployed: true, onDuty: true, dropped: 0, nodes: [{ node: { ...healthy.nodes[0].node, lastHeartbeatAt: iso(e.now) } }] }; },
    async keepalive() { return { onDuty: true, keptAlive: queue.map(pr => ({ claimId: e.claimFor(pr), boundPr: `${REPO}#${pr}`, expiresAt: iso(e.now + 7_200_000) })) }; },
    async touch(i) {
      if (i.ciState === 'running') { ci = { ciState: 'running', ciHeadSha: i.headSha }; slotUntil = e.now + 90 * 60_000; }
      // stage 8's touch green on the current path (publisher.mjs#touchGreen): Native's merge_slot_green_seconds (1800) from now
      if (i.ciState === 'green') { ci = { ciState: 'green', ciHeadSha: i.headSha }; slotUntil = e.now + 30 * 60_000; }
      if (i.ciState === 'failed') { e.failed.push(i.pr); leave(i.pr); return { onDuty: true, touched: true, returned: true, claims: [e.claimFor(i.pr)] }; }
      return { onDuty: true, touched: true, until: iso(slotUntil), claims: [e.claimFor(i.pr)], returned: null };
    },
    async adopt(i) { const was = queue.includes(i.pr); e.adopted.push([i.pr, i.mergeSha]); leave(i.pr); return { onDuty: true, adopted: was, returned: [] }; },
  });
  e.head = pr => W.pulls.get(pr).head;
  e.main = () => W.refs.get('heads/main');
  return e;
}

// ---- stage 10, stage 8 and the loop between them ----
let runN = 0;
// The stage file stage 10 reads (invoke-stage.mjs writes it from the resident's --train-landing): push, batchMax 4, the chain installed.
const CHAIN4 = Object.freeze({ landing: 'push', batchMax: 4, batchChain: true, unreadable: false });
async function stage10(e, outcome = null) {
  e.now += 60_000;
  const runId = `${(++runN).toString(16).padStart(16, '0')}-0123456789ab`;
  const job = jobOf({ createdAt: iso(e.now), runId, sweep: 'audit', onSince: iso(NOW - 3_600_000),
    ...(outcome ? { frontPr: outcome.pr, frontHeadSha: outcome.headSha, frontTestSha: outcome.testSha, frontAttempt: outcome.attempt, frontCode: outcome.code } : {}) });
  return runTrain({ job, github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep,
    claimScope: SCOPE, layerOfPaths: e.layerOfPaths ?? (() => 'code'), landing: e.port, trainLanding: e.trainLanding ?? CHAIN4 });
}
// scans: the front batch's stages 2-7 passed and published its own scans on H (gh.frontScans); false for a batch that ran none.
// batchRoute: what stage 8 read from its batch-route.json (bc982192); claimAssist: Native's claim assist (a claim joins the queue).
async function stage8(t, e, b, { trainLanding = { landing: 'push', batchMax: 4, unreadable: false }, mode = () => 'normal', scans = true, batchRoute = null, claimAssist = null,
  admission = e.admission } = {}) {
  e.now += 60_000;
  const claim = pr => ({ claimId: e.claimFor(pr), fence: 3, epoch: 1, expiresAt: iso(e.now + 3_600_000) });
  const jobs = batchJobsV2({ repo: REPO, pr: b.pr, headSha: b.headSha, baseSha: b.baseSha, testSha: b.testSha, sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: b.attempt });
  if (scans) e.gh.frontScans(jobs);
  e.journal ??= await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const publisher = createFixtureControlPublisherV2({ github: e.gh, journal: e.journal, trainMode: 'on', batchClaim: claimGeneration(claim(b.pr)), slotNative: e.native.port,
    sweepStore: e.store, greenLedger: e.ledger, pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
    admission: admission ?? { async evaluatePr(job, packet, options) {
      const front = e.queue[0] === job.pr;
      options?.scheduling?.({ mergeQueue: { entered: e.queue.includes(job.pr), state: front ? 'head' : 'waiting', position: e.queue.indexOf(job.pr) + 1 }, claimExpiresAt: iso(e.now + 3_600_000) });
      const { observationSha256, ...base } = admittedFacts(job, claim(job.pr), packet, { domain: 'fixture', mergeQueueHead: front, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 });
      const facts = { ...base, mode: { state: mode(job.pr), layer: 'code', policyVersion: 1 } };
      return { ...facts, observationSha256: digest(facts) };
    } },
    assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep, trainLanding, landing: e.port, batchRoute, claimAssist });
  return publisher.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: e.now + 90_000 });
}
// The executor's part: a front batch runs (stages 1-7 pass), stage 8 answers; a final PR failure is stage 10's next frontOutcome.
async function drive(t, e, { until, steps = 40, opened = null }) {
  const log = [];
  let outcome = null;
  for (let i = 0; i < steps && !until(); i++) {
    const r = await stage10(e, outcome); outcome = null;
    log.push(['10', r.facts.decision, r.facts.openFrontBatch?.pr ?? null, r.facts.landing?.adopted ?? null]);
    const b = r.facts.openFrontBatch;
    if (!b) continue;
    if (opened) await opened(r, b);
    const members = typeof e.store.landingBatchByTest === 'function' ? (await e.store.landingBatchByTest(b.testSha))?.members.map(m => m.pr) ?? null : null;
    const p = await stage8(t, e, b);
    log.push(['8', p.status, p.reason ?? null, members]);
    if (p.status === 'BLOCKED' && p.reason === 'TRAIN_LANDING_CHECK_FAILED') outcome = { pr: b.pr, headSha: b.headSha, testSha: b.testSha, attempt: b.attempt, code: p.reason };
  }
  return log;
}

test('push: two PRs sharing one Task current claim land in stable sequence without dropping the second PR', async t => {
  const e = await world(t, { prs: [910, 911], sharedClaim: true });
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 8 });
  assert.deepEqual(log.filter(l => l[0] === '8').map(l => l[3]), [[910], [911]], JSON.stringify(log));
  assert.deepEqual(e.adopted.map(a => a[0]), [910, 911]);
  assert.ok(e.W.pulls.get(910).merged && e.W.pulls.get(911).merged);
});

test('push: Native rider bindings land when bodies are missing or name another claim and scope', async t => {
  const e = await world(t, { prs: [910, 911, 912] });
  e.W.pulls.get(910).body = null;
  e.W.pulls.get(911).body = 'No trailers';
  e.W.pulls.get(912).body = `Clued-Work-Claim: ${claimOf(999)}\nClued-Work-Scope: global`;
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 6 });
  assert.deepEqual(log.filter(l => l[0] === '8').map(l => l[3]), [[910, 911, 912]], JSON.stringify(log));
  assert.equal(e.queue.length, 0);
});

test('push: an admission green and advisory trailer cannot admit an unbound rider', async t => {
  const e = await world(t, { prs: [910, 911] });
  e.native.bindings.delete(911);
  let batch;
  for (let i = 0; i < 6 && !batch; i++) batch = (await stage10(e)).facts.openFrontBatch;
  assert.ok(batch);
  assert.deepEqual((await e.store.landingBatchByTest(batch.testSha)).members.map(m => m.pr), [910]);
  assert.equal(e.W.pulls.get(911).merged, false);
});

// D6 (Fable 2026-11-19 §1 items 7, 8): the first batch stage 10 opens, as the members it recorded (front first).
async function firstBatchMembers(e) {
  let batch;
  for (let i = 0; i < 6 && !batch; i++) batch = (await stage10(e)).facts.openFrontBatch;
  assert.ok(batch, 'a front batch opens');
  return (await e.store.landingBatchByTest(batch.testSha)).members.map(m => m.pr);
}
const LAYER = paths => (paths.some(p => p.startsWith('scripts/ci/')) ? 'protected' : 'code');

test('push D6 §1.7: a PR whose auto-merge is off never rides; the batch takes the next rider instead', async t => {
  const e = await world(t, { prs: [910, 911, 912] });
  e.W.pulls.get(911).autoMerge = false;
  assert.deepEqual(await firstBatchMembers(e), [910, 912]);
  assert.equal(e.W.pulls.get(911).merged, false);
});

test('push D6 §1.8: a protected-layer PR is never batched: a protected rider (or one whose paths cannot be read) is left out, a protected front goes alone', async t => {
  const rider = await world(t, { prs: [910, 911, 912, 913] });
  rider.layerOfPaths = LAYER;
  rider.W.pulls.get(911).paths = ['scripts/ci/x.mjs'];
  rider.W.pulls.get(912).paths = null; // unreadable counts as protected
  assert.deepEqual(await firstBatchMembers(rider), [910, 913], 'protected and unreadable riders stay out');
  const front = await world(t, { prs: [910, 911, 912] });
  front.layerOfPaths = LAYER;
  front.W.pulls.get(910).paths = ['a.txt', 'scripts/ci/x.mjs'];
  assert.deepEqual(await firstBatchMembers(front), [910], 'a protected front is a batch of one');
  const unread = await world(t, { prs: [910, 911] });
  unread.layerOfPaths = LAYER;
  unread.W.pulls.get(910).paths = null;
  assert.deepEqual(await firstBatchMembers(unread), [910], 'a front whose paths cannot be read is a batch of one');
});

test('push: three queued PRs -> one batch -> main fast-forwarded to the tested S -> all three marked merged and adopted', async t => {
  const e = await world(t, { prs: [910, 911, 912] });
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 6 });
  const landings = log.filter(l => l[0] === '8');
  assert.equal(landings.length, 1, JSON.stringify(log));
  assert.deepEqual(landings[0], ['8', 'SETTLED', null, [910, 911, 912]], JSON.stringify(log));
  const S = e.W.pushes.at(-1);
  assert.equal(e.main(), S, 'main is exactly the tested S');
  assert.deepEqual(e.W.commits.get(S).parents.length, 2);
  assert.ok([910, 911, 912].every(pr => e.W.ancestor(e.head(pr), S)), 'every member head is in S');
  assert.deepEqual([910, 911, 912].map(pr => e.W.pulls.get(pr).merged), [true, true, true], 'GitHub marks all three merged');
  assert.deepEqual(e.adopted.map(a => a[0]).sort(), [910, 911, 912]);
  assert.ok(e.adopted.every(a => a[1] === S), 'adopted with S');
  assert.equal(e.adopted.at(-1)[0], 910, 'the front (slot holder) is adopted last');
  assert.equal([...e.gh.world.checks.values()].filter(c => c.name === 'kooyumi-merge-slot').length, 0, 'push writes no merge-slot green');
});

test('push: the middle PR breaks the combination -> bisection -> the other two land, the middle one is reported failed', async t => {
  // 911 is fine alone (its own CI is green) but fails together with 910: a semantic conflict only the batch's S shows.
  const e = await world(t, { prs: [910, 911, 912], bad: set => set.has('910') && set.has('911') });
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 30 });
  const batches = log.filter(l => l[0] === '8').map(l => [l[1], l[2], l[3]]);
  assert.deepEqual(batches[0], ['BLOCKED', 'TRAIN_LANDING_CHECK_FAILED', [910, 911, 912]], JSON.stringify(log));
  assert.deepEqual(batches[1], ['BLOCKED', 'TRAIN_LANDING_CHECK_FAILED', [910, 911]], 'bisection: the first half');
  assert.deepEqual(batches[2], ['SETTLED', null, [910]], JSON.stringify(log));
  assert.deepEqual(e.failed, [911], JSON.stringify(log));
  assert.deepEqual([910, 911, 912].map(pr => e.W.pulls.get(pr).merged), [true, false, true]);
  assert.ok(!e.W.ancestor(e.head(911), e.main()), '911 never reached main');
  assert.ok(e.W.ancestor(e.head(910), e.main()) && e.W.ancestor(e.head(912), e.main()));
  assert.ok(!e.W.content.get(e.main()).has('911'));
  assert.deepEqual(e.adopted.map(a => a[0]).sort(), [910, 912]);
  // every commit main ever pointed at was a tested S of a batch this node recorded
  for (const s of e.W.pushes.filter(s => e.W.ancestor(s, e.main()))) assert.ok(await e.store.landingBatchByTest?.(s), s);
});

test('push: main moved by someone else between the check and the write -> the fast-forward is refused -> retested on the new main -> lands', async t => {
  const e = await world(t, { prs: [910] });
  let other = null;
  e.W.beforeFastForward = () => {
    // another writer pushes a commit on top of T just before the train's PATCH
    other = h('other');
    e.W.commits.set(other, { sha: other, tree: h('tree:other'), parents: [e.main()] }); e.W.content.set(other, new Set(['other']));
    e.W.refs.set('heads/main', other);
  };
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 8 });
  const tries = log.filter(l => l[0] === '8');
  assert.deepEqual(tries[0], ['8', 'BLOCKED', 'RESIDENT_BASE_MOVED', [910]], JSON.stringify(log));
  assert.equal(e.W.pushes.length, 2, JSON.stringify(log));
  assert.notEqual(e.W.pushes[0], e.W.pushes[1], 'the second S is a new test commit on the new main');
  assert.deepEqual(e.W.commits.get(e.W.pushes[1]).parents, [other, e.head(910)]);
  assert.equal(e.main(), e.W.pushes[1]);
  assert.equal(e.W.pulls.get(910).merged, true);
  assert.deepEqual(e.adopted, [[910, e.W.pushes[1]]]);
});

// ---- ADR 0019: batch size as production sets it (resident engine -> invoker -> stage file), descriptor /4 as the resident writes it ----
const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const CI_SOURCE = 'e'.repeat(64);
// The resident's WindowsEngine over a fixture Source directory holding the real build-bundle.ps1, prepare-workspaces.py and invoke-stage.mjs
// (what batchChainSupported reads) and a versions port (both sides of this generation, or not). Its derive runs a stub of derive-batch.mjs.
async function residentEngine(t, { consistent = true, linuxSource = CI_SOURCE } = {}) {
  const root = await tempDir(t), sourceRoot = path.join(root, 'source', CI_SOURCE);
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['build-bundle.ps1', 'prepare-workspaces.py', 'invoke-stage.mjs'])
    await fs.copyFile(new URL(`../src/resident-v2/${n}`, import.meta.url), path.join(sourceRoot, ...V2, n));
  await fs.writeFile(path.join(sourceRoot, ...V2, 'derive-batch.mjs'), '// fixture');
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64), directory: `stage-0${n}`, linuxWorker: [2, 4, 6].includes(n) }));
  const run = async argv => {
    const at = k => argv[argv.indexOf(k) + 1], subject = JSON.parse(at('--subject-json'));
    return { code: 0, stdout: JSON.stringify({ status: 'RESIDENT_BATCH_DERIVED', batchKey: at('--batch-key'), batchId: at('--batch-id'), packageSha256: 'c'.repeat(64),
      ciSourceManifestSha256: CI_SOURCE, sourceCommit: 'd'.repeat(40), gitleaksTomlSha256: '9'.repeat(64), testSha: subject.testSha ?? subject.headSha, stages: rows }) };
  };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, sleep: async () => {}, clock: () => NOW,
    trainLanding: { landing: 'push', batchMax: 3 },
    versions: async () => ({ consistent, windows: { ciSourceManifestSha256: CI_SOURCE }, linux: { ciSourceManifestSha256: linuxSource } }),
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'node.exe', powershellExe: 'powershell.exe', scExe: 'sc.exe' } });
  return { engine, root };
}
// The stage file stage 10 reads, from the engine's own argument through the invoker's parse and write.
async function stageFileOf(engine) {
  const args = await engine.stageArgs(10);
  const arg = args[args.indexOf('--train-landing') + 1];
  return { arg, trainLanding: parseStageTrainLanding(Buffer.from(stageTrainLandingText(parseLandingArg(arg)))) };
}
// What the resident does with a confirmed OPEN_FRONT_BATCH: its front binding (train.mjs) and the descriptor its derive writes.
async function residentDescriptor(r, b, engine, root) {
  const front = openFrontBatchOf(b);
  assert.ok(front, 'the resident takes the batch');
  const subject = { repo: REPO, pr: b.pr, headSha: b.headSha, baseSha: b.baseSha, sourceManifestSha256: CI_SOURCE, attempt: 1, testSha: b.testSha };
  const chain = chainOfFront(subject, front);
  const key = createHash('sha256').update(b.testSha).digest('hex');
  const batch = chain ? await engine.derive(subject, key, chain) : await engine.derive(subject, key);
  return JSON.parse(await fs.readFile(path.join(root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8'));
}

test('push ADR 0019: batchMax 3 as production sets it -> push:3:chain -> one batch of three -> descriptor /4 names exactly S\'s chain -> all three land in one push', async t => {
  const e = await world(t, { prs: [920, 921, 922, 923] });
  const { engine, root } = await residentEngine(t);
  const file = await stageFileOf(engine);
  assert.equal(file.arg, 'push:3:chain', 'the installed Source and the Linux side take /4: the resident says so');
  e.trainLanding = file.trainLanding;
  const descriptors = [];
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 10, opened: async (r, b) => {
    validateTrainFacts(r.facts);
    descriptors.push(await residentDescriptor(r, b, engine, root));
  } });
  const landings = log.filter(l => l[0] === '8');
  assert.deepEqual(landings.map(l => [l[1], l[3]]), [['SETTLED', [920, 921, 922]], ['SETTLED', [923]]], JSON.stringify(log));
  // the first push landed all three: main went from T straight to the tested S of the three-member batch
  const S = e.W.pushes[0];
  assert.ok([920, 921, 922].every(pr => e.W.ancestor(e.head(pr), S)) && !e.W.ancestor(e.head(923), S), 'batchMax 3: exactly three in the first batch');
  assert.deepEqual([920, 921, 922].map(pr => e.W.pulls.get(pr).merged), [true, true, true]);
  assert.ok(e.adopted.filter(a => a[1] === S).map(a => a[0]).sort().join() === '920,921,922', JSON.stringify(e.adopted));
  // the descriptor the resident wrote for it: /4, the members in merge order, S's own tree; S really is their chain on T
  const d = descriptors[0];
  assert.equal(d.contract, DESCRIPTOR_CHAIN_CONTRACT);
  assert.equal(d.testSha, S);
  assert.deepEqual(d.members, [920, 921, 922].map(pr => ({ pr, headSha: e.head(pr) })));
  assert.equal(d.testTree, e.W.commits.get(S).tree);
  assert.deepEqual([d.pr, d.headSha], [920, e.head(920)]);
  assert.equal(batchChainOk({ commits: e.W.commits, baseSha: d.baseSha, heads: d.members.map(m => m.headSha), testSha: d.testSha }), true);
  // the one-PR batch after it is a /3 descriptor, exactly as before
  assert.equal(descriptors[1].contract, DESCRIPTOR_CONTRACT);
  assert.equal(Object.hasOwn(descriptors[1], 'members') || Object.hasOwn(descriptors[1], 'testTree'), false);
});

test('push ADR 0019, fail closed: without the chain fact (the Linux side not known to be this generation, or another Source) batchMax 3 still lands one PR per batch', async t => {
  for (const o of [{ consistent: null }, { consistent: false }, { linuxSource: 'f'.repeat(64) }]) {
    const e = await world(t, { prs: [930, 931, 932] });
    const { engine, root } = await residentEngine(t, o);
    const file = await stageFileOf(engine);
    assert.equal(file.arg, 'push:3', JSON.stringify(o));
    e.trainLanding = file.trainLanding;
    const descriptors = [];
    const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 12, opened: async (r, b) => { descriptors.push(await residentDescriptor(r, b, engine, root)); } });
    assert.deepEqual(log.filter(l => l[0] === '8').map(l => [l[1], l[3]]), [['SETTLED', [930]], ['SETTLED', [931]], ['SETTLED', [932]]], JSON.stringify(log));
    assert.ok(descriptors.every(d => d.contract === DESCRIPTOR_CONTRACT && !Object.hasOwn(d, 'members')), 'only /3 descriptors');
  }
  // a stage file that cannot be read is no chain either
  const broken = parseStageTrainLanding(Buffer.from('{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3,"batchChain":false}'));
  assert.equal(broken.batchChain, false);
});

test('ADR 0019 train facts: openFrontBatch members must describe the batch (front first, distinct, 2..4); the resident refuses any other shape', async t => {
  const e = await world(t, { prs: [940, 941] });
  const r = await stage10(e);
  const f = r.facts, b = f.openFrontBatch;
  assert.deepEqual(b.members, [940, 941].map(pr => ({ pr, headSha: e.head(pr) })));
  validateTrainFacts(f);
  assert.ok(openFrontBatchOf(b)?.members?.length === 2);
  const bads = [b.members.slice(0, 1), [...b.members].reverse(), [b.members[0], b.members[0]], [b.members[0], { ...b.members[1], pr: b.members[0].pr }],
    [b.members[0], { ...b.members[1], headSha: b.testSha }], [b.members[0], { ...b.members[1], claimId: 'x' }], [b.members[0], { pr: 941, headSha: 'z'.repeat(40) }],
    [...b.members, ...[1, 2, 3].map(n => ({ pr: 950 + n, headSha: h(`x${n}`) }))], 'members'];
  for (const members of bads) {
    assert.throws(() => validateTrainFacts({ ...f, openFrontBatch: { ...b, members } }), /invalid_train_facts/, JSON.stringify(members));
    assert.equal(openFrontBatchOf({ ...b, members }), null, JSON.stringify(members));
  }
  // one member: no members key at all (descriptor /3)
  const one = await world(t, { prs: [960] });
  const r1 = await stage10(one);
  assert.equal(Object.hasOwn(r1.facts.openFrontBatch, 'members'), false);
});

test('ADR 0019 review 3, fail closed: staging.tmp moved by someone else between two of the train\'s merges -> no batch (never a step the train did not merge)', async t => {
  const e = await world(t, { prs: [970, 971, 972] });
  let merges = 0;
  e.W.beforeMerge = () => {
    if (++merges !== 2) return;
    // after the front's merge, another writer forces staging.tmp to E: the right shape ([T, H970]) with content nobody admitted
    const T = e.main(), E = h('evil-step');
    e.W.commits.set(E, { sha: E, tree: h('tree:evil'), parents: [T, e.head(970)] });
    e.W.content.set(E, new Set(['970', 'evil']));
    e.W.refs.set('heads/clued-train/staging.tmp', E);
  };
  const r = await stage10(e);
  assert.notEqual(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
  assert.equal(r.facts.decision, 'FRONT_TEST_MERGE_NOT_READY');
  assert.equal(r.facts.openFrontBatch, null);
  assert.equal(e.W.pushes.length, 0, 'main never moves');
});

// ---- fail closed: every refusal below writes nothing to main and nothing to GitHub's checks ----
async function opened(t, prs = [910, 911, 912], o = {}) {
  const e = await world(t, { prs, ...o });
  const r = await stage10(e);
  assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
  return { e, b: r.facts.openFrontBatch, T: e.main() };
}
const untouched = (e, T) => {
  assert.equal(e.main(), T, 'main unchanged');
  assert.equal([...e.gh.world.checks.values()].filter(c => c.name === 'kooyumi-merge-slot').length, 0, 'no merge-slot green');
};

test('N9 E10: the same S parks on timeout, is re-run by the lane, and lands without blaming a PR', async t => {
  const { e, b, T } = await opened(t);
  const { pr, headSha, testSha } = b;
  const originalHeads = [...e.W.pulls.values()].map(p => p.head);
  const context = 'migration-verify';
  const rules = e.gh.readBranchRules;
  e.gh.readBranchRules = async () => {
    const reply = await rules();
    reply.rules.at(-1).parameters.required_status_checks.push({ context, integration_id: ACTIONS });
    return reply;
  };
  const addCheck = (status, conclusion) => {
    const id = e.W.nextCheck++;
    e.W.checks.set(id, { id, name: context, head_sha: testSha, app: { id: ACTIONS }, status, conclusion, completed_at: iso(e.now) });
    return id;
  };
  const checkId = addCheck('completed', 'cancelled');
  const board = new StatusBoard({ clock: e.clock });
  board.update({ node: { name: 'fixture-node', mode: 'ACTIVE' }, train: { enabled: 'on', landing: 'push' } });
  const engine = fakeEngine();
  const stage = engine.runStage.bind(engine);
  const policy = rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'on', nonFrontRuns: true,
    maintenanceEveryMs: 10 * 60_000, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS, sweep: 'audit', landing: 'push', batchMax: 4 } });
  const f = await executorFixture(t, { now: e.now, engine, status: board, policy });
  f.exec.trainTakeoverDone = true;
  engine.runStage = async (batch, role, options) => {
    const result = await stage(batch, role, options);
    if (role.number !== 8) return result;
    e.now = f.clock();
    const outcome = await stage8(t, e, b);
    f.advance(e.now - f.clock());
    return { ok: outcome.status === 'SETTLED', code: outcome.reason, proof: CLEAN_PROOF,
      outcome: { ...outcome, mayHavePublished: outcome.sideEffects !== 0 } };
  };
  const key = await f.exec.enqueueFront(openFrontBatchOf(b));
  const subject = { repo: REPO, pr, headSha, baseSha: T, testSha, sourceManifestSha256: f.ports.policy.sourceManifestSha256, attempt: 1 };
  await f.ledger.reserve(key, subject, { origin: 'queued' });
  f.queue.begin(pr, headSha, key, 'queued', f.clock());
  const timedOut = await f.exec.driveReserved(key, subject, f.clock());
  assert.deepEqual([timedOut.state, timedOut.reason], ['PARKED', 'TRAIN_LANDING_CHECKS_PENDING'], JSON.stringify(timedOut));
  untouched(e, T);
  assert.deepEqual(e.W.pushes, []);

  const staging = 'clued-train/staging';
  const workflow = '.github/workflows/clued-required-tests.yml';
  const source = await fs.readFile(new URL(`../../../../${workflow}`, import.meta.url));
  const run = { id: 712, workflow_id: 100, path: workflow, head_sha: testSha, head_branch: staging,
    event: 'push', run_attempt: 1, status: 'completed', conclusion: 'cancelled' };
  const state = await AdmissionRerunState.open(path.join(await tempDir(t), 'rerun.json'), e.clock);
  const requests = [];
  let annotations = [], log = 'Running migrations\n##[error]The operation was canceled.';
  const steps = [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'cancelled' }];
  const lane = new AdmissionRerunner({ state, clock: e.clock, pulls: () => [{ pr, headSha }], notify: async () => {},
    readStatus: async () => parseStatus(Buffer.from(JSON.stringify(board.snapshot()))),
    gh: {
      repo: REPO,
      async get(route) {
        if (route === `/contents/${workflow}?ref=${T}`) return { path: workflow, sha: '1'.repeat(40), encoding: 'base64', content: source.toString('base64') };
        if (route === `/git/ref/heads/${staging}`) return { ref: `refs/heads/${staging}`, object: { sha: e.W.refs.get(`heads/${staging}`) } };
        if (route === `/actions/runs/${run.id}`) return { ...run };
        if (route === `/pulls/${pr}`) {
          const pull = await e.gh.readPullRequest(pr);
          return { ...pull, number: pr, base: { ...pull.base, sha: T } };
        }
        if (route === `/actions/workflows/${run.workflow_id}/runs?per_page=100&page=1`)
          return { total_count: 1, workflow_runs: [{ ...run }] };
        assert.fail(route);
      },
      async paged(route) {
        if (route === '/rules/branches/main') return (await e.gh.readBranchRules()).rules;
        if (route === `/commits/${testSha}/check-runs?filter=all`) return (await e.gh.readChecks(testSha)).checks;
        if (route === `/actions/runs?head_sha=${testSha}`) return [{ ...run }];
        if (route === `/commits/${headSha}/pulls`) return [];
        if (route === `/actions/runs/${run.id}/attempts/1/jobs`) return [
          { id: 500, name: 'admission-gate', head_sha: testSha, status: 'completed', conclusion: 'success' },
          { id: checkId, name: context, head_sha: testSha, status: 'completed', conclusion: 'cancelled', steps },
        ];
        if (route === `/check-runs/${checkId}/annotations`) return annotations;
        assert.fail(route);
      },
      async text(route) {
        assert.equal(route, `/actions/jobs/${checkId}/logs`);
        return log;
      },
      async rerun(id) {
        assert.equal(state.record(testSha)?.outcome, 'intent');
        requests.push(id);
        Object.assign(run, { run_attempt: 2, status: 'queued' });
        addCheck('queued', null);
        return { outcome: 'sent' };
      },
    },
  });
  const stagingDecision = () => decide({ gh: lane.gh, pr, headSha, testSha });
  assert.equal((await stagingDecision()).action, 'final', 'manual cancellation has no timeout proof');
  annotations = [{ message: 'The job has exceeded the maximum execution time of 30m0s' }];
  log = 'not ok 1 - migration assertion\n' + log;
  assert.equal((await stagingDecision()).action, 'final', 'the test failure vetoes even an annotated timeout');
  log = log.split('\n').slice(1).join('\n');
  steps[1].conclusion = null;
  assert.equal((await stagingDecision()).action, 'final', 'a missing step verdict cannot prove a clean timeout');
  steps[1].conclusion = 'cancelled';
  e.W.refs.set(`heads/${staging}`, T);
  assert.equal((await stagingDecision()).action, 'skip', 'the staging ref moved');
  e.W.refs.set(`heads/${staging}`, testSha);
  await lane.step();
  assert.deepEqual(requests, [run.id]);
  assert.match(lane.line(headSha), /列车暂存提交/);
  assert.deepEqual(state.record(testSha)?.failures, [{ name: context, kind: 'timeout' }]);
  const queued = await stage8(t, e, b);
  assert.deepEqual([queued.status, queued.reason, queued.sideEffects], ['BLOCKED', 'TRAIN_LANDING_CHECKS_PENDING', 0]);
  addCheck('completed', 'success');
  Object.assign(run, { status: 'completed', conclusion: 'success' });
  e.now += HEAD_RECHECK_MS;
  await lane.step();
  assert.deepEqual(requests, [run.id]);
  f.advance(timedOut.until - f.clock());
  const { acted: landed } = await f.exec.resumeParked();
  assert.deepEqual([landed?.state, landed?.key], ['COMPLETED', key], JSON.stringify(landed));
  for (const number of [2, 3, 4, 5, 6, 7])
    assert.equal(engine.calls.filter(([action, stage]) => action === 'stage' && stage === number).length, 1, `stage ${number} ran once`);
  assert.deepEqual(e.W.pushes, [testSha]);
  assert.deepEqual([...e.W.pulls.values()].map(p => p.head), originalHeads);
  await stage10(e);
  assert.deepEqual(e.failed, []);
  assert.equal(e.adopted.filter(([, sha]) => sha === testSha).length, originalHeads.length);
});

test('N9 E11: a real failure on S parks within five minutes and becomes a failure at the deadline', async t => {
  const { e, b, T } = await opened(t);
  const check = [...e.W.checks.values()].find(c => c.head_sha === b.testSha && c.app.id === ACTIONS);
  Object.assign(check, { conclusion: 'failure', completed_at: iso(e.now + 60_000) });
  const first = await stage8(t, e, b);
  assert.deepEqual([first.reason, first.sideEffects], ['TRAIN_LANDING_CHECKS_PENDING', 0]);
  e.now += 4 * 60_000;
  const second = await stage8(t, e, b);
  assert.deepEqual([second.reason, second.sideEffects], ['TRAIN_LANDING_CHECK_FAILED', 0]);
  untouched(e, T);
});

test('push: same-tree H with missing or skipped project CI lands using the green checks on S', async t => {
  for (const headChecks of ['missing', 'skipped']) await t.test(headChecks, async t => {
    const { e, b } = await opened(t, [910]);
    assert.notEqual(b.headSha, b.testSha);
    assert.equal(e.W.commits.get(b.headSha).tree, e.W.commits.get(b.testSha).tree);
    for (const [id, c] of e.W.checks) if (c.head_sha === b.headSha && c.app.id === ACTIONS) {
      if (headChecks === 'missing') e.W.checks.delete(id);
      else c.conclusion = 'skipped';
    }
    assert.ok([...e.W.checks.values()].some(c => c.head_sha === b.testSha && c.app.id === ACTIONS && c.conclusion === 'success'));
    const p = await stage8(t, e, b, { trainLanding: { landing: 'push', batchMax: 1, unreadable: false } });
    assert.equal(p.status, 'SETTLED', JSON.stringify(p));
    assert.equal(p.landed.mainSha, b.testSha);
    assert.deepEqual(e.W.pushes, [b.testSha]);
    assert.equal(e.main(), b.testSha);
  });
});

test('push, fail closed: green checks on same-tree H cannot replace missing, pending or failed checks on S', async t => {
  for (const testChecks of ['missing', 'pending', 'failed']) await t.test(testChecks, async t => {
    const { e, b, T } = await opened(t, [910]);
    assert.equal(e.W.commits.get(b.headSha).tree, e.W.commits.get(b.testSha).tree);
    for (const [id, c] of e.W.checks) if (c.head_sha === b.testSha && c.app.id === ACTIONS) {
      if (testChecks === 'missing') e.W.checks.delete(id);
      else Object.assign(c, { status: testChecks === 'pending' ? 'in_progress' : 'completed', conclusion: testChecks === 'pending' ? null : 'failure' });
    }
    const p = await stage8(t, e, b, { trainLanding: { landing: 'push', batchMax: 1, unreadable: false } });
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', testChecks === 'failed' ? 'TRAIN_LANDING_CHECK_FAILED' : 'TRAIN_LANDING_CHECKS_PENDING', 0]);
    untouched(e, T);
    assert.deepEqual(e.W.pushes, []);
  });
});

test('github-merge: same-tree H keeps its publication path when project CI is missing on S', async t => {
  const { e, b, T } = await opened(t, [910]);
  assert.equal(e.W.commits.get(b.headSha).tree, e.W.commits.get(b.testSha).tree);
  for (const [id, c] of e.W.checks) if (c.head_sha === b.testSha && c.app.id === ACTIONS) e.W.checks.delete(id);
  const p = await stage8(t, e, b, { trainLanding: { landing: 'github-merge', batchMax: 1, unreadable: false } });
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.equal(e.main(), T);
  assert.deepEqual(e.W.pushes, []);
  assert.ok([...e.gh.world.checks.values()].some(c => c.head_sha === b.headSha && c.name === 'kooyumi-merge-slot' && c.conclusion === 'success'));
});

test('push, fail closed: a batch of several PRs never gets a merge-slot green from a stage 8 that does not push (github-merge, or a landing file it cannot read)', async t => {
  const { e, b, T } = await opened(t);
  assert.equal((await e.store.landingBatchByTest(b.testSha)).members.length, 3);
  const merge = await stage8(t, e, b, { trainLanding: { landing: 'github-merge', batchMax: 1, unreadable: false } });
  assert.deepEqual([merge.status, merge.reason, merge.sideEffects], ['BLOCKED', 'TRAIN_BATCH_WITHOUT_PUSH', 0]);
  const broken = await stage8(t, e, b, { trainLanding: { landing: 'github-merge', batchMax: 1, unreadable: true } });
  assert.deepEqual([broken.status, broken.reason, broken.sideEffects], ['BLOCKED', 'TRAIN_MODE_UNREADABLE', 0]);
  untouched(e, T); assert.equal(e.W.pushes.length, 0);
});

test('push, fail closed: main without the fast-forward-only, no-deletion or train-only rule parks the batch (TRAIN_LANDING_RULES_MISSING), never a current-path green', async t => {
  for (const drop of ['non_fast_forward', 'deletion', 'kooyumi-train-landed']) await t.test(drop, async t => {
    const { e, b, T } = await opened(t);
    const read = e.gh.readBranchRules;
    e.gh.readBranchRules = async () => {
      const r = await read();
      r.rules = r.rules.filter(x => x.type !== drop).map(x => (x.type !== 'required_status_checks' ? x
        : { ...x, parameters: { ...x.parameters, required_status_checks: x.parameters.required_status_checks.filter(c => c.context !== drop) } }));
      return r;
    };
    const p = await stage8(t, e, b);
    // without kooyumi-train-landed the route is the current path (H1), which never takes a batch with riders
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', drop === 'kooyumi-train-landed' ? 'TRAIN_BATCH_WITHOUT_PUSH' : 'TRAIN_LANDING_RULES_MISSING', 0]);
    untouched(e, T); assert.equal(e.W.pushes.length, 0);
  });
});

// ---- Fable 2026-11-20 三态选路: which way a batch lands is read from main's live rules each time, by the one function ----
// A merge-slot green that stage 8 wrote on H, as GitHub's auto-merge then merges it: a merge commit [T, H] with S's tree (its own SHA).
function githubMerges(e, b) {
  const p = e.W.pulls.get(b.pr), M = e.W.merge(b.baseSha, b.headSha, ':github');
  assert.equal(e.W.commits.get(M).tree, e.W.commits.get(b.testSha).tree);
  e.W.refs.set('heads/main', M);
  Object.assign(p, { state: 'closed', merged: true, mergeSha: M });
  return M;
}
const greens = (e, sha) => [...e.gh.world.checks.values()].filter(c => c.head_sha === sha && c.name === 'kooyumi-merge-slot' && c.conclusion === 'success');
const PUSH1 = Object.freeze({ landing: 'push', batchMax: 1, unreadable: false });
const TODAY_MISSING = ['independent_ruleset_missing', 'train_landed_check_missing', 'main_app_cannot_bypass'];
// Fable 11-21 open points §5: stage 10 reads the bypass states every round too, so it names what push lacks as stage 8 does
const S10_TODAY_MISSING = TODAY_MISSING;

test('three ways, today (no independent ruleset, no kooyumi-train-landed, the App cannot bypass main): a push-capable package lands through GitHub as today and never parks', async t => {
  const { e, b, T } = await opened(t, [910], { rules: 'today' });
  // stage 10 still built the candidate merge commit S and pointed clued-train/staging at it: the four checks ran on S by their own names
  assert.equal(e.W.refs.get('heads/clued-train/staging'), b.testSha, 'the rehearsal S is on the staging ref');
  const p = await stage8(t, e, b, { trainLanding: PUSH1 });
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.deepEqual(e.W.pushes, [], 'nothing pushed to main');
  assert.equal(e.main(), T);
  assert.equal(greens(e, b.headSha).length, 1, 'the merge-slot green of the current path, on H');
  // the receipt: S, what push still lacks and this App's bypass state; never S's checks (Fable 11-21 应修 2: the precheck reads them)
  assert.deepEqual(p.rehearsal, { testSha: b.testSha, missing: TODAY_MISSING, bypass: { main: 'never', independent: 'absent' } });
  // GitHub merges it; the next stage 10 adopts it and says which way it read: the train went on
  const M = githubMerges(e, b);
  const s10 = (await stage10(e)).facts;
  assert.deepEqual([s10.landing?.route, s10.landing?.missing], ['github-merge', S10_TODAY_MISSING], JSON.stringify(s10.landing));
  assert.deepEqual(e.adopted, [[910, M]]);
  assert.equal(e.queue.length, 0);
});

// Merge of #1192 (a front is green only when every required check of main's live rules passed on its head) into the three ways: on the
// current path GitHub merges H, so H's own required checks decide, also when the installed package says push. Before the merge fix stage 10
// asked "push mode?" (the package) instead of "route push?" (main's rules): a push-capable package on today's rules called a front green
// whose head misses ci-suites-windows, a wait GitHub never ends.
test(`three ways, today: a push-capable package still waits for the head's own required checks (#1192) before "green, wait for merge"`, async t => {
  const e = await world(t, { prs: [910], rules: 'today' });
  const H = e.head(910);
  for (const [id, c] of e.W.checks) if (c.head_sha === H && c.name === 'ci-suites-windows') e.W.checks.delete(id);
  // stage 1's other App checks on H, as production has them (the world models only kooyumi-work-admission): the one gap is the Windows check
  for (const name of ['gitleaks', 'trivy', 'contract-placement']) { const id = e.W.nextCheck++; e.W.checks.set(id, { id, app: { id: APP }, name, head_sha: H, status: 'completed', conclusion: 'success' }); }
  const r = await stage10(e);
  assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
  const b = r.facts.openFrontBatch;
  const p = await stage8(t, e, b, { trainLanding: PUSH1 });
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.equal(greens(e, b.headSha).length, 1, 'the merge-slot green of the current path, on H');
  const s10 = (await stage10(e)).facts;
  assert.equal(s10.landing?.route, 'github-merge');
  assert.notEqual(s10.decision, 'FRONT_GREEN_WAIT_MERGE', 'GitHub cannot merge H without ci-suites-windows on H');
  assert.ok(['FRONT_CHECKS_WAIT', 'FRONT_CHECKS_MISSING'].includes(s10.decision), JSON.stringify(s10));
  assert.deepEqual(s10.front.required?.missing?.map(m => m.context), ['ci-suites-windows'], JSON.stringify(s10.front));
  assert.deepEqual(e.W.pushes, [], 'nothing pushed to main');
});

// Rereview of R3, item 3 (修复前必红: stage 8's green-time check off, today's rules go green): a front batch that ran no scan (H carries none
// of this App's) while main's rules require them from this App: stage 8 writes no green and pushes nothing, the batch ends
// (TRAIN_BATCH_CHANGED); the same on push's rules.
test('R3 problem A, three ways: H without this App\'s scans -> no green on today\'s rules, no push on push\'s rules', async t => {
  for (const rules of ['today', 'push']) await t.test(rules, async t => {
    const { e, b, T } = await opened(t, [910], { rules });
    const p = await stage8(t, e, b, { trainLanding: PUSH1, scans: false });
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_BATCH_CHANGED', 0], JSON.stringify(p));
    assert.equal(greens(e, b.headSha).length, 0, 'no merge-slot green on H');
    assert.equal([...e.gh.world.checks.values()].filter(c => c.name === 'kooyumi-admission-verified').length, 0);
    assert.deepEqual(e.W.pushes, [], 'nothing pushed to main');
    assert.equal(e.main(), T);
  });
});

// Rereview of R3, item 1 (修复前必红): push lands under the rules it read last. landOne reads the train facts (main's rules once), then
// main's rules again for the route; the scans went back from GitHub Actions to this App between those two reads (they had been pinned to
// Actions just after this stage 8 chose push). H carries this App's scans of another run (not this front's own, never reusable): the
// green-time check (any job of this App) passes; before the fix the push check took the first read's appScans ([]) and pushed S with no
// scan of this front subject. Now it checks against the second read: nothing lands, the batch ends (TRAIN_BATCH_CHANGED).
test('R3 problem A, push: scans pinned back from Actions to this App between landOne\'s two reads of the rules -> S is not pushed', async t => {
  const { e, b, T } = await opened(t, [910]);
  for (const name of ['gitleaks', 'trivy', 'contract-placement']) { const id = e.W.nextCheck++; e.W.checks.set(id, { id, app: { id: APP }, name, head_sha: b.headSha, status: 'completed', conclusion: 'success' }); }
  const toActions = rules => rules.map(r => (r.type !== 'required_status_checks' ? r : { ...r, parameters: { ...r.parameters,
    required_status_checks: r.parameters.required_status_checks.map(c => (['gitleaks', 'trivy', 'contract-placement'].includes(c.context) ? { ...c, integration_id: ACTIONS } : c)) } }));
  // phase: 'app' until the route read (its ruleset reads), then one read pinned to Actions (landOne's train facts), then this App again
  let phase = 'app';
  const read = e.gh.readBranchRules, readRuleset = e.gh.readRuleset;
  e.gh.readRuleset = async id => { if (phase === 'app') phase = 'next'; return readRuleset(id); };
  e.gh.readBranchRules = async () => {
    const r = await read();
    if (phase !== 'next') return r;
    phase = 'back';
    return { ...r, rules: toActions(r.rules) };
  };
  const p = await stage8(t, e, b, { trainLanding: PUSH1, scans: false });
  assert.equal(phase, 'back', 'landOne read the rules pinned to Actions once');
  assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_BATCH_CHANGED', 0], JSON.stringify(p));
  assert.deepEqual(p.missing, ['gitleaks', 'trivy', 'contract-placement']);
  assert.deepEqual(e.W.pushes, [], 'nothing pushed to main');
  untouched(e, T);
});

// R3 open item 2 (修复前必红): the three scans pinned to GitHub Actions with push's rules set up. Before the fix push's main ruleset was the
// one with all six pinned to this App: none, so stage 10 read park and stage 8 TRAIN_LANDING_RULES_MISSING, never landing. Now the main
// ruleset is found by the same pin rule as stages 8 and 10: stage 10 reads push with no scan required from this App, and stage 8 pushes S
// once its Actions scans passed on S (external checks); while gitleaks still runs on S it waits, a failed one fails the batch.
const SCANS = ['gitleaks', 'trivy', 'contract-placement'];
function scansFromActions(e) {
  e.W.rules = e.W.rules.map(r => (r.type !== 'required_status_checks' ? r : { ...r, parameters: { ...r.parameters,
    required_status_checks: r.parameters.required_status_checks.map(c => (SCANS.includes(c.context) ? { ...c, integration_id: ACTIONS } : c)) } }));
}
const actionsScanOn = (e, sha, name, o = {}) => { const id = e.W.nextCheck++; e.W.checks.set(id, { id, app: { id: ACTIONS }, name, head_sha: sha, status: 'completed', conclusion: 'success', completed_at: iso(e.now - 10 * 60_000), ...o }); return id; };
test('R3 open item 2: scans from GitHub Actions with push rules -> stage 10 reads push, stage 8 lands S once its Actions scans passed on S', async t => {
  for (const scan of ['passed', 'running', 'failed']) await t.test(scan, async t => {
    const e = await world(t, { prs: [910] });
    scansFromActions(e);
    const r = await stage10(e);
    assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
    assert.deepEqual([r.facts.landing?.route, r.facts.landing?.missing, r.facts.rules?.appScans], ['push', [], []], JSON.stringify([r.facts.landing, r.facts.rules]));
    const b = r.facts.openFrontBatch, T = e.main();
    for (const name of SCANS) actionsScanOn(e, b.testSha, name, name !== 'gitleaks' || scan === 'passed' ? {}
      : scan === 'running' ? { status: 'in_progress', conclusion: null, completed_at: null } : { conclusion: 'failure' });
    // the front ran no scan (none is required from this App): its stage 8 has none on H
    const p = await stage8(t, e, b, { trainLanding: PUSH1, scans: false });
    if (scan === 'passed') {
      assert.equal(p.status, 'SETTLED', JSON.stringify(p));
      assert.deepEqual(e.W.pushes, [b.testSha]);
      assert.equal(e.main(), b.testSha);
      assert.equal(greens(e, b.headSha).length, 0, 'push writes no merge-slot green');
    } else {
      assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', scan === 'running' ? 'TRAIN_LANDING_CHECKS_PENDING' : 'TRAIN_LANDING_CHECK_FAILED', 0], JSON.stringify(p));
      assert.deepEqual(e.W.pushes, []);
      untouched(e, T);
    }
  });
});

// Fable 11-21 应修 1: a merge-slot green counts only on the current path. #1192's shape on today's rules (the front alone in the queue, its
// head without ci-suites-windows): stage 8 wrote the current path's pair on H and GitHub cannot merge it. Then the Owner saves C. Before the
// fix stage 10 read the leftover green as "green, wait for merge" (no rules given on route push, so the merge slot alone was green) and
// waited for Native's hard cap; now it opens the front batch and stage 8 pushes S.
const MIN = 60_000;
function leftoverGreen(e) {
  const H = e.head(910);
  for (const [id, c] of e.W.checks) if (c.head_sha === H && c.name === 'ci-suites-windows') e.W.checks.delete(id);
  for (const name of ['gitleaks', 'trivy', 'contract-placement']) { const id = e.W.nextCheck++; e.W.checks.set(id, { id, app: { id: APP }, name, head_sha: H, status: 'completed', conclusion: 'success' }); }
  const slotCalls = [];
  e.native.port.yieldSlot = async i => { slotCalls.push(['yield', i.pr, i.reason ?? null]); return { onDuty: true, yielded: false }; };
  const returnSlot = e.native.port.returnSlot;
  e.native.port.returnSlot = async i => { slotCalls.push(['return', i.pr]); return returnSlot(i); };
  return { H, slotCalls };
}
async function greenOnTodayRules(t, e) {
  const r = await stage10(e);
  assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
  const b = r.facts.openFrontBatch;
  const p = await stage8(t, e, b, { trainLanding: PUSH1 });
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.equal(greens(e, b.headSha).length, 1, 'the merge-slot green of the current path, on H');
  return { b, T: e.main(), greenAt: e.now };
}

test('应修 1 (T1): green on today\'s rules, GitHub does not merge, the Owner saves C -> the next stage 10 opens the front batch and stage 8 lands it', async t => {
  const e = await world(t, { prs: [910], rules: 'today' });
  const { H, slotCalls } = leftoverGreen(e);
  const { T, greenAt } = await greenOnTodayRules(t, e);
  e.W.setRules('push');
  const s10 = await stage10(e);
  assert.equal(s10.facts.landing?.route, 'push');
  assert.equal(s10.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify({ decision: s10.facts.decision, front: s10.facts.front }));
  assert.equal(s10.facts.front.green, false, 'the leftover green is not green on route push');
  const b = s10.facts.openFrontBatch;
  const p = await stage8(t, e, b);
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.notEqual(e.main(), T);
  assert.equal(e.main(), b.testSha, 'main is S');
  await stage10(e);
  assert.deepEqual(e.adopted, [[910, b.testSha]], 'the front adopted at S');
  assert.equal(e.queue.length, 0);
  assert.deepEqual(slotCalls, [], 'no yield, no return');
  assert.ok(e.now - greenAt < REQUIRED_CHECKS_MAX_WAIT_MS, `landed ${Math.round((e.now - greenAt) / MIN)} minutes after the green, under the 60-minute wait`);
  assert.equal(greens(e, H).length, 1, 'no new green on H');
});

test('应修 1 (T1b): green on today\'s rules, then kooyumi-train-landed while the App cannot bypass main (park) -> open, park with the missing item, no new green, no yield loop; rules completed -> lands', async t => {
  const e = await world(t, { prs: [910], rules: 'today' });
  const { H, slotCalls } = leftoverGreen(e);
  const { T, greenAt } = await greenOnTodayRules(t, e);
  e.W.setRules('push'); e.W.rulesets.set(MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'never' });
  const s10 = await stage10(e);
  assert.equal(s10.facts.landing?.route, 'park');
  assert.equal(s10.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify({ decision: s10.facts.decision, front: s10.facts.front }));
  assert.equal(s10.facts.front.green, false, 'the leftover green is not green on route park');
  const b = s10.facts.openFrontBatch;
  // stage 8 parks the batch at B with zero effects (failure-table: TRAIN_LANDING_RULES_MISSING, park); the executor tries it again after
  // PARK_RETRY_MS (10, 20 minutes), stage 10 runs every few minutes meanwhile: past the 60 minutes after the green, nothing yields
  const parked = [], decisions = new Set();
  const first = e.now, retryAt = [first, first + 10 * MIN, first + 30 * MIN];
  while (e.now - greenAt < REQUIRED_CHECKS_MAX_WAIT_MS + 5 * MIN) {
    if (retryAt.length && e.now >= retryAt[0]) { retryAt.shift(); const p = await stage8(t, e, b); parked.push([p.status, p.reason, p.missing]); }
    e.now += 4 * MIN;
    const r = await stage10(e);
    decisions.add(r.facts.decision);
    assert.equal(r.facts.front?.green, false);
    assert.equal(r.facts.openFrontBatch, null, 'no second batch of the same head while the first is parked');
  }
  assert.equal(parked.length, 3);
  for (const x of parked) assert.deepEqual(x, ['BLOCKED', 'TRAIN_LANDING_RULES_MISSING', ['main_app_cannot_bypass']]);
  assert.deepEqual([...decisions], ['TRAIN_FRONT_BATCH_RUNNING']);
  assert.equal(greens(e, H).length, 1, 'no new green');
  assert.deepEqual([e.W.pushes, e.main()], [[], T]);
  assert.deepEqual(slotCalls, [], 'no 60-minute yield, no return');
  // the Owner's save completed (the App can always bypass the main ruleset): the executor's next try of the same batch lands it
  e.W.rulesets.set(MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'always' });
  e.now = Math.max(e.now, first + 70 * MIN); // the next PARK_RETRY_MS step (40 minutes after the third try)
  const p = await stage8(t, e, b);
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.equal(e.main(), b.testSha, 'main is S');
  await stage10(e);
  assert.deepEqual(e.adopted, [[910, b.testSha]]);
  assert.deepEqual(slotCalls, []);
});

// Fable 11-21 应修 1 (T3): the switch to C at every point of a front's way, each ending in a landing with no person and in a bounded number of
// rounds. The executor here is production's: a batch stage 10 opens goes to stage 8 at once; a park (zero effects) is tried again after
// PARK_RETRY_MS (10 minutes first); a final PR failure is the next stage 10's frontOutcome; a SETTLED current-path pair is done (GitHub
// cannot merge H: it misses ci-suites-windows, #1192's shape). Stage 10 runs every 4 minutes besides.
async function untilLanded(t, e, { batch = null, rounds = 30 } = {}) {
  const T = e.main(), log = [];
  let parked = batch ? { b: batch, at: e.now } : null, outcome = null;
  for (let i = 0; i < rounds && e.main() === T; i++) {
    if (parked && e.now >= parked.at) {
      const { b } = parked; parked = null;
      const p = await stage8(t, e, b);
      log.push(['8', p.status, p.reason ?? null]);
      if (p.status === 'BLOCKED' && p.reason === 'TRAIN_LANDING_CHECK_FAILED') outcome = { pr: b.pr, headSha: b.headSha, testSha: b.testSha, attempt: b.attempt, code: p.reason };
      else if (p.status === 'BLOCKED' && p.sideEffects === 0) parked = { b, at: e.now + 10 * MIN };
      continue;
    }
    const r = await stage10(e, outcome); outcome = null;
    log.push(['10', r.facts.decision]);
    if (r.facts.openFrontBatch) parked = { b: r.facts.openFrontBatch, at: e.now };
    else e.now += 4 * MIN;
  }
  if (e.main() !== T) { const r = await stage10(e); log.push(['10', r.facts.decision]); }
  return log;
}
test('应修 1 (T3): the switch to C at every point of the front\'s way -> no person, a bounded number of rounds, landed', async t => {
  const landed = async (t, e, slotCalls, start, log) => {
    assert.equal(e.W.pushes.at(-1), e.main(), `main is the pushed S: ${JSON.stringify(log)}`);
    assert.deepEqual(e.adopted.map(a => a[0]), [910], JSON.stringify(log));
    assert.deepEqual(slotCalls, [], `no yield, no return: ${JSON.stringify(log)}`);
    t.diagnostic(`${Math.round((e.now - start) / MIN)} minutes after the switch: ${JSON.stringify(log)}`);
  };
  await t.test('before stage 10 opens the batch', async t => {
    const e = await world(t, { prs: [910], rules: 'today' });
    const { slotCalls } = leftoverGreen(e);
    e.W.setRules('push');
    const start = e.now, log = await untilLanded(t, e);
    await landed(t, e, slotCalls, start, log);
  });
  // failS: the rehearsal S could not be built (clued-train/staging cannot be pointed), so the batch opens on GitHub's test merge, not on
  // clued-train/staging, with no landing-batch record (rehearsalOnly). park: the batch opens while the rules read back as park (the same
  // swallowed composition, Fable 11-21 open points §1's second source).
  const openedThenSwitched = async (t, { failS, park = false, rounds = 30 }) => {
    const e = await world(t, { prs: [910], rules: park ? 'push' : 'today' });
    if (park) e.W.rulesets.set(MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'never' });
    const { slotCalls } = leftoverGreen(e);
    const pointRef = e.port.pointRef;
    if (failS) e.port.pointRef = async () => { throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); };
    const r = await stage10(e);
    assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
    if (park) assert.equal(r.facts.landing?.route, 'park');
    const b = r.facts.openFrontBatch;
    if (failS) {
      assert.equal(b.testSha, e.W.merge(e.main(), e.head(910)), 'GitHub\'s test merge');
      assert.notEqual(e.W.refs.get('heads/clued-train/staging'), b.testSha, 'S is not on clued-train/staging');
      assert.equal(await e.store.landingBatchByTest(b.testSha), null, 'no landing-batch record');
      e.port.pointRef = pointRef;
    }
    if (park) e.W.rulesets.set(MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'always' }); else e.W.setRules('push');
    const start = e.now;
    let log = [];
    if (failS) {
      // Fable 11-21 open points §1: route push, the running front batch's S not on clued-train/staging -> stage 10 attaches it this round
      const s10 = await stage10(e);
      assert.equal(s10.facts.landing?.route, 'push');
      assert.equal(s10.facts.decision, 'TRAIN_FRONT_BATCH_RUNNING', JSON.stringify(s10.facts));
      assert.equal(e.W.refs.get('heads/clued-train/staging'), b.testSha, 'the next stage 10 points clued-train/staging at S');
      const rec = await e.store.landingBatchByTest(b.testSha);
      assert.deepEqual(rec && [rec.frontPr, rec.frontHeadSha, rec.baseSha, rec.testTree, rec.attempt, rec.members.map(m => m.pr)],
        [910, b.headSha, b.baseSha, b.testTree, b.attempt, [910]], 'a landing-batch record of the front alone');
      log.push(['10', s10.facts.decision]);
    }
    log = [...log, ...await untilLanded(t, e, { batch: b, rounds })];
    await landed(t, e, slotCalls, start, log);
    if (failS) {
      assert.equal(e.main(), b.testSha, 'main is S');
      assert.ok(e.now - start < REQUIRED_CHECKS_MAX_WAIT_MS, `landed ${Math.round((e.now - start) / MIN)} minutes after the switch, under 60`);
    }
  };
  await t.test('after stage 10 opened on today\'s rules (S on clued-train/staging), before stage 8', t => openedThenSwitched(t, { failS: false }));
  // Review optional 6, ruled by Fable 11-21 open points §1: the rehearsal S could not be built, so the batch's S is GitHub's test merge, not
  // on clued-train/staging. Before the fix it never got its Actions checks once C was saved: stage 8 parked it on CHECKS_PENDING while stage
  // 10 read it as running up to the hard cap (about 220 minutes, then a turn_short yield). Now stage 10 attaches it to clued-train/staging.
  await t.test('after stage 10 opened on today\'s rules with S = GitHub\'s test merge (the rehearsal S could not be built), before stage 8',
    t => openedThenSwitched(t, { failS: true }));
  await t.test('park source: opened while the rules read park with S = GitHub\'s test merge, then the rules completed to push',
    t => openedThenSwitched(t, { failS: true, park: true }));
  // Not past the line: on the current path the same batch (S = GitHub's test merge) gets no ref and no landing-batch record from stage 10.
  await t.test('current path: the same running batch on GitHub\'s test merge -> stage 10 writes no ref', async t => {
    const e = await world(t, { prs: [910], rules: 'today' });
    const pointRef = e.port.pointRef, points = [];
    e.port.pointRef = async () => { throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); };
    const r = await stage10(e);
    const b = r.facts.openFrontBatch;
    assert.equal(b.testSha, e.W.merge(e.main(), e.head(910)));
    e.port.pointRef = async (ref, s) => { points.push([ref, s]); return pointRef(ref, s); };
    for (let i = 0; i < 3; i++) {
      e.now += 4 * MIN;
      const s10 = await stage10(e);
      assert.equal(s10.facts.decision, 'TRAIN_FRONT_BATCH_RUNNING', JSON.stringify(s10.facts));
    }
    assert.deepEqual(points, [], 'no ref written');
    assert.equal(await e.store.landingBatchByTest(b.testSha), null, 'no landing-batch record');
  });
  await t.test('after stage 8 wrote kooyumi-admission-verified only', async t => {
    const e = await world(t, { prs: [910], rules: 'today' });
    const { slotCalls } = leftoverGreen(e);
    const r = await stage10(e);
    const b = r.facts.openFrontBatch;
    e.gh.world.hooks.create = c => { if (c.name === 'kooyumi-admission-verified') { e.W.setRules('push'); e.gh.world.hooks.create = null; } };
    const start = e.now;
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    const log = [['8', p.status, p.reason ?? null], ...await untilLanded(t, e)];
    await landed(t, e, slotCalls, start, log);
  });
  await t.test('after stage 8 wrote both (T1, the worst case: the front alone in the queue)', async t => {
    const e = await world(t, { prs: [910], rules: 'today' });
    const { slotCalls } = leftoverGreen(e);
    await greenOnTodayRules(t, e);
    e.W.setRules('push');
    const start = e.now, log = await untilLanded(t, e);
    await landed(t, e, slotCalls, start, log);
  });
  // A merge-slot success another job left on H before C (an S = H job, or a turn H lost), H not the front yet. Two moments: the green is
  // still a success when H becomes the front (the 应修 1 state), or the sweep revoked it first (H was neither the front nor in main).
  const promoted = async (t, { revokedFirst }) => {
    const e = await world(t, { prs: [909, 910], rules: 'push' });
    e.trainLanding = { landing: 'push', batchMax: 1, batchChain: false, unreadable: false }; // 909 alone, then 910 is the front
    const { H, slotCalls } = leftoverGreen(e);
    const green = () => { const id = Math.max(100, ...e.gh.world.checks.keys()) + 1;
      e.gh.world.checks.set(id, { id, app: { id: APP }, name: 'kooyumi-merge-slot', head_sha: H, status: 'completed', conclusion: 'success',
        started_at: iso(e.now - 30 * MIN), completed_at: iso(e.now - 30 * MIN) }); return id; };
    const id = revokedFirst ? green() : null;
    const start = e.now;
    const first = await untilLanded(t, e);
    assert.deepEqual(e.adopted.map(a => a[0]), [909], JSON.stringify(first));
    if (revokedFirst) assert.equal(e.gh.world.checks.get(id).conclusion, 'failure', 'the sweep revoked it while 909 was the front');
    const late = revokedFirst ? null : green();
    const log = await untilLanded(t, e);
    t.diagnostic(`${Math.round((e.now - start) / MIN)} minutes, slot calls ${JSON.stringify(slotCalls)}${late ? `, the late green ended ${e.gh.world.checks.get(late).conclusion}` : ''}: ${JSON.stringify(log)}`);
    assert.equal(e.W.pushes.at(-1), e.main(), `main is the pushed S: ${JSON.stringify(log)}`);
    assert.deepEqual(e.adopted.map(a => a[0]), [909, 910], JSON.stringify(log));
    return slotCalls;
  };
  // main unchanged since that green (the job before H left the queue without landing): the green is still a success when H is the front.
  await t.test('a merge-slot green another job left on H, main unchanged, H the front', async t => {
    const e = await world(t, { prs: [910], rules: 'push' });
    const { H, slotCalls } = leftoverGreen(e);
    const id = Math.max(100, ...e.gh.world.checks.keys()) + 1;
    e.gh.world.checks.set(id, { id, app: { id: APP }, name: 'kooyumi-merge-slot', head_sha: H, status: 'completed', conclusion: 'success',
      started_at: iso(e.now - 30 * MIN), completed_at: iso(e.now - 30 * MIN) });
    const start = e.now, log = await untilLanded(t, e);
    assert.equal(e.gh.world.checks.get(id).conclusion, 'success', 'the leftover green stayed a success');
    assert.equal(log[0][1], 'OPEN_FRONT_BATCH', JSON.stringify(log));
    assert.equal(e.W.pushes.at(-1), e.main(), `main is the pushed S: ${JSON.stringify(log)}`);
    assert.deepEqual(e.adopted.map(a => a[0]), [910], JSON.stringify(log));
    assert.deepEqual(slotCalls, [], 'no yield, no return');
    t.diagnostic(`${Math.round((e.now - start) / MIN)} minutes: ${JSON.stringify(log)}`);
  });
  // main moved (909 landed) before H became the front: stage 10 revokes the front head's green in that round (main moved) and opens.
  await t.test('the same green, main moved: the front before it lands, H is the front', async t => {
    assert.deepEqual(await promoted(t, { revokedFirst: false }), [], 'no yield, no return');
  });
  // Observed, not either 应修's state (no success is involved): the revoked merge slot on H is a failed required check to landable
  // (train-rules.mjs#requiredCheckFailure), so the new front asks Native to yield once; alone in the queue Native writes nothing and it lands.
  // Reported to Fable with the T3 results.
  await t.test('the same green revoked by the sweep before H becomes the front', async t => {
    assert.deepEqual(await promoted(t, { revokedFirst: true }), [['yield', 910, null]]);
  });
});

// The guard program (scripts/ci/clued-merge-executor.mjs) on the current path: a front head behind main is updated (main merged into it);
// the PR's own CI and stage 1 run again on the new head.
function updateBranch(e, pr) {
  const W = e.W, head = W.merge(e.head(pr), e.main(), ':update');
  W.pulls.get(pr).head = head;
  for (const [app, name] of [...FOUR.map(n => [ACTIONS, n]), [APP, 'kooyumi-work-admission']]) {
    const id = W.nextCheck++; W.checks.set(id, { id, app: { id: app }, name, head_sha: head, status: 'completed', conclusion: 'success', completed_at: iso(e.now) });
  }
}

test('three ways, today: three queued PRs go one by one through GitHub, none parks, every S rehearsed', async t => {
  const e = await world(t, { prs: [910, 911, 912], rules: 'today' });
  const log = [], decisions = [];
  for (let i = 0; i < 16 && e.queue.length; i++) {
    const r = await stage10(e);
    decisions.push(r.facts.decision);
    // the current path keeps strict's rule: a head behind main is not a front batch (push would land merge(T, H) itself)
    if (r.facts.decision === 'FRONT_NEEDS_MAIN_MERGE') { updateBranch(e, e.queue[0]); continue; }
    const b = r.facts.openFrontBatch;
    if (!b) continue;
    const p = await stage8(t, e, b, { trainLanding: { landing: 'push', batchMax: 4, unreadable: false } });
    log.push([b.pr, p.status, p.reason ?? null, p.rehearsal?.testSha === b.testSha]);
    if (p.status === 'SETTLED') githubMerges(e, b);
  }
  assert.deepEqual(log, [[910, 'SETTLED', null, true], [911, 'SETTLED', null, true], [912, 'SETTLED', null, true]], JSON.stringify({ log, decisions }));
  assert.ok(decisions.includes('FRONT_NEEDS_MAIN_MERGE'), 'one PR a batch, each head up to date with main');
  assert.deepEqual(e.W.pushes, []);
  assert.deepEqual(e.adopted.map(a => a[0]), [910, 911, 912]);
});

// Fable 11-21 open points §5: the precheck's P3 reads the bypass states from state\status.json (the receipts directory is not readable
// without elevation), so stage 10 reads them every round while push is in the package and its facts' landing carries them.
test('open points §5: stage 10 (push in the package) reads both bypass states every round and its facts carry landing.bypass, today and after C', async t => {
  let e = await world(t, { prs: [910], rules: 'today' });
  let r = await stage10(e);
  assert.equal(r.facts.landing?.route, 'github-merge');
  assert.deepEqual(r.facts.landing?.bypass, { main: 'never', independent: 'absent' }, 'today: the App cannot bypass main, no independent ruleset');
  validateTrainFacts(r.facts);
  e = await world(t, { prs: [910], rules: 'today' });
  e.W.rulesets.set(FF_RS, { id: FF_RS, currentUserCanBypass: 'never' });
  e.W.rules = [...e.W.rules, { type: 'non_fast_forward', rulesetId: FF_RS, parameters: null }, { type: 'deletion', rulesetId: FF_RS, parameters: null }];
  r = await stage10(e);
  assert.deepEqual([r.facts.landing?.route, r.facts.landing?.bypass], ['github-merge', { main: 'never', independent: 'never' }], 'the independent ruleset created (R1): never/never');
  e = await world(t, { prs: [910], rules: 'push' });
  r = await stage10(e);
  assert.deepEqual([r.facts.landing?.route, r.facts.landing?.bypass], ['push', { main: 'always', independent: 'never' }]);
  // a facts landing.bypass of another shape is refused by the shared validator
  for (const bypass of [{ main: 'x', independent: 'never' }, { main: 'never' }, { main: 'never', independent: 'never', other: 'never' }, 'never'])
    assert.throws(() => validateTrainFacts({ ...r.facts, landing: { ...r.facts.landing, bypass } }), undefined, JSON.stringify(bypass));
});

test('three ways: the three conditions all read back -> push lands, the stage-10 facts say so', async t => {
  const { e, b } = await opened(t, [910]);
  const p = await stage8(t, e, b, { trainLanding: PUSH1 });
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  assert.deepEqual(e.W.pushes, [b.testSha]);
  assert.equal(greens(e, b.headSha).length, 0);
  const s10 = (await stage10(e)).facts;
  assert.deepEqual([s10.landing?.route, s10.landing?.missing], ['push', []], JSON.stringify(s10.landing));
});

test('three ways, fail closed: rules that cannot be read, or read only in part, park with the missing item named; no check, no push', async t => {
  const cases = {
    'rules reply incomplete': e => { e.gh.readBranchRules = async () => ({ complete: false, branch: 'main', rules: [] }); },
    'rule without its ruleset': e => { const r = e.gh.readBranchRules; e.gh.readBranchRules = async () => { const x = await r(); delete x.rules[0].rulesetId; return x; }; },
  };
  for (const [name, breakIt] of Object.entries(cases)) for (const kind of ['today', 'push']) await t.test(`${name} (${kind})`, async t => {
    const { e, b, T } = await opened(t, [910], { rules: kind });
    breakIt(e);
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.equal(p.status, 'BLOCKED', JSON.stringify(p));
    assert.equal(p.sideEffects, 0);
    assert.ok(['TRAIN_LANDING_RULES_MISSING', 'RULESET_UNREADABLE'].includes(p.reason), JSON.stringify(p));
    if (p.reason === 'TRAIN_LANDING_RULES_MISSING') assert.ok(Array.isArray(p.missing) && p.missing.length > 0 && p.missing.every(m => /unreadable/.test(m)), JSON.stringify(p.missing));
    untouched(e, T); assert.deepEqual(e.W.pushes, []);
  });
});

test('three ways, fail closed: kooyumi-train-landed read while the rest is not complete -> no current-path green, no push, parked with what is missing', async t => {
  const cases = {
    // the main ruleset holds non_fast_forward and deletion itself (the App bypasses it): not the independent ruleset push relies on
    'no independent ruleset': W => { W.rules = W.rules.filter(r => r.rulesetId !== FF_RS); W.rulesets.delete(FF_RS); },
    // the App could force-push or delete main through it: the price of its bypass of the main ruleset is not paid
    'the App can bypass the independent ruleset': W => { W.rulesets.get(FF_RS).currentUserCanBypass = 'always'; },
    'the App cannot bypass main': W => { W.rulesets.get(MAIN_RS).currentUserCanBypass = 'never'; },
    'the App bypasses main for pull requests only': W => { W.rulesets.get(MAIN_RS).currentUserCanBypass = 'pull_requests_only'; },
    'train-landed pinned to another App': W => { W.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks.find(x => x.context === 'kooyumi-train-landed').integration_id = 1; },
  };
  const expected = { 'no independent ruleset': 'independent_ruleset_missing', 'the App can bypass the independent ruleset': 'independent_ruleset_app_can_bypass',
    'the App cannot bypass main': 'main_app_cannot_bypass', 'the App bypasses main for pull requests only': 'main_app_bypass_not_always', 'train-landed pinned to another App': null };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const { e, b, T } = await opened(t, [910]);
    change(e.W);
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    // kooyumi-train-landed pinned to another App is an unknown provider to the queue head's required-check gate (train-rules.mjs), which
    // parks first; landingRoute's own answer for it (train_landed_check_missing) is in train-landing.test.mjs
    if (expected[name] === null) assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'REQUIRED_CHECKS_UNREADABLE', 0], JSON.stringify(p));
    else assert.deepEqual([p.status, p.reason, p.sideEffects, p.missing], ['BLOCKED', 'TRAIN_LANDING_RULES_MISSING', 0, [expected[name]]], JSON.stringify(p));
    untouched(e, T); assert.deepEqual(e.W.pushes, []);
  });
});

// H1 (Fable 2026-11-20 补：可绕过字段读不到时): before kooyumi-train-landed the bypass state never chooses: read, recorded, and the train goes on.
test('three ways, H1: no kooyumi-train-landed and the bypass state unreadable (field absent, or the read fails) -> the current path, the rehearsal says unreadable', async t => {
  const cases = {
    'field absent': e => { for (const r of e.W.rulesets.values()) r.currentUserCanBypass = null; },
    'read fails': e => { e.gh.readRuleset = async () => { throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); }; },
    'an undocumented value': e => { e.W.rulesets.get(MAIN_RS).currentUserCanBypass = 'sometimes'; },
  };
  for (const [name, breakIt] of Object.entries(cases)) await t.test(name, async t => {
    const { e, b, T } = await opened(t, [910], { rules: 'today' });
    breakIt(e);
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.equal(p.status, 'SETTLED', JSON.stringify(p));
    assert.equal(greens(e, b.headSha).length, 1); assert.equal(e.main(), T); assert.deepEqual(e.W.pushes, []);
    assert.deepEqual(p.rehearsal.bypass, { main: 'unreadable', independent: 'absent' });
    assert.ok(p.rehearsal.missing.includes(`ruleset_can_bypass_unreadable:${MAIN_RS}`), JSON.stringify(p.rehearsal.missing));
  });
  await t.test('the App able to bypass main without kooyumi-train-landed: current path, recorded as always', async t => {
    const { e, b } = await opened(t, [910], { rules: 'today' });
    e.W.rulesets.get(MAIN_RS).currentUserCanBypass = 'always';
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.equal(p.status, 'SETTLED', JSON.stringify(p)); assert.deepEqual(e.W.pushes, []);
    assert.deepEqual(p.rehearsal.bypass, { main: 'always', independent: 'absent' });
  });
});

test('three ways, H1: kooyumi-train-landed and a bypass state that cannot be read -> parked, the unreadable ruleset named; no check, no push', async t => {
  const cases = {
    'field absent on both': [e => { for (const r of e.W.rulesets.values()) r.currentUserCanBypass = null; }, [`ruleset_can_bypass_unreadable:${FF_RS}`, `ruleset_can_bypass_unreadable:${MAIN_RS}`]],
    'field absent on main': [e => { e.W.rulesets.get(MAIN_RS).currentUserCanBypass = null; }, [`ruleset_can_bypass_unreadable:${MAIN_RS}`]],
    'independent read fails': [e => { const read = e.gh.readRuleset; e.gh.readRuleset = async id => { if (id === FF_RS) throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); return read(id); }; },
      [`ruleset_can_bypass_unreadable:${FF_RS}`]],
  };
  for (const [name, [breakIt, missing]] of Object.entries(cases)) await t.test(name, async t => {
    const { e, b, T } = await opened(t, [910]);
    breakIt(e);
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.deepEqual([p.status, p.reason, p.sideEffects, p.missing], ['BLOCKED', 'TRAIN_LANDING_RULES_MISSING', 0, missing], JSON.stringify(p));
    untouched(e, T); assert.deepEqual(e.W.pushes, []);
  });
});

test('three ways, M1: stage 8\'s outcome on disk carries the rehearsal of a current-path pair and the missing items of a park, and reads back', async t => {
  const root = await tempDir(t);
  const plan = { stage: 8, entryRole: 'control-checks' };
  const write = async (nonce, result) => { await writeOutcome({ receiptsRoot: root, nonce, plan, jobIds: [], result }); return JSON.parse(await fs.readFile(path.join(root, `outcome-${nonce}.json`), 'utf8')); };
  // the current path, Windows not yet on S: the record carries S, what push lacks and the bypass state, nothing of S's checks
  const today = await opened(t, [910], { rules: 'today' });
  for (const [id, c] of today.e.W.checks) if (c.head_sha === today.b.testSha && c.name === 'ci-suites-windows') today.e.W.checks.delete(id);
  const p = await stage8(t, today.e, today.b, { trainLanding: PUSH1 });
  assert.equal(p.status, 'SETTLED');
  const o = await write('a'.repeat(32), p);
  assert.deepEqual(o.rehearsal, { testSha: today.b.testSha, missing: TODAY_MISSING, bypass: { main: 'never', independent: 'absent' } });
  assert.ok(!('landingMissing' in o));
  // a park on main's rules
  const half = await opened(t, [910]);
  half.e.W.rules = half.e.W.rules.filter(r => r.rulesetId !== FF_RS); half.e.W.rulesets.delete(FF_RS);
  const q = await stage8(t, half.e, half.b, { trainLanding: PUSH1 });
  const parked = await write('b'.repeat(32), q);
  assert.deepEqual([parked.status, parked.reason, parked.landingMissing], ['BLOCKED', 'TRAIN_LANDING_RULES_MISSING', ['independent_ruleset_missing']]);
  assert.ok(!('rehearsal' in parked));
});

test('three ways: the bypass lists are not the publisher\'s to read: who else is on them changes no route (checked by an administrator when the Owner saves)', async t => {
  await t.test('today, another actor on main\'s list, the App cannot bypass -> current path', async t => {
    const { e, b } = await opened(t, [910], { rules: 'today' });
    e.W.rulesets.get(MAIN_RS).bypassActors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.equal(p.status, 'SETTLED', JSON.stringify(p)); assert.deepEqual(e.W.pushes, []);
  });
  await t.test('push state, other actors on both lists -> push', async t => {
    const { e, b } = await opened(t, [910]);
    for (const r of e.W.rulesets.values()) r.bypassActors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.equal(p.status, 'SETTLED', JSON.stringify(p)); assert.deepEqual(e.W.pushes, [b.testSha]);
  });
});

// Fable 11-21 应修 2: stage 8 settles before S's checks finish, so it reads none of them for the rehearsal (they are the precheck's, from GitHub).
test('three ways, rehearsal: S without all four checks green still lands through GitHub; the receipt carries no snapshot of the checks on S', async t => {
  for (const [what, change] of [['missing', (W, id) => W.checks.delete(id)], ['pending', (W, id) => Object.assign(W.checks.get(id), { status: 'in_progress', conclusion: null })],
    ['failure', (W, id) => Object.assign(W.checks.get(id), { conclusion: 'failure' })]]) await t.test(what, async t => {
    const { e, b } = await opened(t, [910], { rules: 'today' });
    const [id] = [...e.W.checks].find(([, c]) => c.head_sha === b.testSha && c.name === 'ci-suites-windows');
    change(e.W, id);
    const read = [], readChecks = e.gh.readChecks;
    e.gh.readChecks = async sha => { read.push(sha); return readChecks(sha); };
    const p = await stage8(t, e, b, { trainLanding: PUSH1 });
    assert.equal(p.status, 'SETTLED', JSON.stringify(p));
    assert.deepEqual(Object.keys(p.rehearsal).sort(), ['bypass', 'missing', 'testSha'], JSON.stringify(p.rehearsal));
    assert.ok(!read.includes(b.testSha), 'stage 8 on the current path reads no check of S');
    assert.equal(greens(e, b.headSha).length, 1);
  });
});

test('three ways, fail closed: a batch of several members never takes the current path (the merge-slot green would name a tree H was not tested as)', async t => {
  const { e, b, T } = await opened(t);
  assert.equal((await e.store.landingBatchByTest(b.testSha)).members.length, 3);
  e.W.setRules('today');
  const p = await stage8(t, e, b);
  assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_BATCH_WITHOUT_PUSH', 0], JSON.stringify(p));
  untouched(e, T); assert.deepEqual(e.W.pushes, []);
});

test('push, fail closed: a rider that is frozen, left the queue, moved to a new head or closed ends the batch (TRAIN_BATCH_CHANGED)', async t => {
  for (const change of ['frozen', 'queue', 'head', 'closed']) await t.test(change, async t => {
    const { e, b, T } = await opened(t);
    let mode = () => 'normal';
    if (change === 'frozen') mode = pr => (pr === 912 ? 'frozen' : 'normal');
    if (change === 'queue') e.queue.splice(e.queue.indexOf(912), 1);
    if (change === 'head') {
      const n = h('new-head-911');
      e.W.commits.set(n, { sha: n, tree: h('tree:n'), parents: [e.head(911)] }); e.W.content.set(n, new Set(['911', 'n'])); e.W.pulls.get(911).head = n;
    }
    if (change === 'closed') e.W.pulls.get(912).state = 'closed';
    const p = await stage8(t, e, b, { mode });
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_BATCH_CHANGED', 0], change);
    untouched(e, T); assert.equal(e.W.pushes.length, 0);
  });
});

test('push, fail closed: a frozen front, a required check still running on S, or a refused fast-forward write nothing; a lost answer is uncertain', async t => {
  await t.test('frozen front', async t => {
    const { e, b, T } = await opened(t);
    const p = await stage8(t, e, b, { mode: () => 'frozen' });
    assert.equal(p.status, 'BLOCKED'); assert.equal(p.sideEffects, 0); untouched(e, T); assert.equal(e.W.pushes.length, 0);
  });
  await t.test('checks pending', async t => {
    const { e, b, T } = await opened(t);
    for (const c of e.W.checks.values()) if (c.head_sha === b.testSha) Object.assign(c, { status: 'in_progress', conclusion: null });
    const p = await stage8(t, e, b);
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_LANDING_CHECKS_PENDING', 0]); untouched(e, T);
  });
  await t.test('refused while main is still T', async t => {
    const { e, b, T } = await opened(t);
    e.port.fastForwardMain = async s => { e.W.pushes.push(s); return { status: 422, sha: null }; };
    const p = await stage8(t, e, b);
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_LANDING_REFUSED', 0]); untouched(e, T);
  });
  await t.test('answer lost, main not moved: uncertain, never sent again blindly', async t => {
    const { e, b, T } = await opened(t);
    e.port.fastForwardMain = async s => { e.W.pushes.push(s); return { status: 502, sha: null }; };
    const p = await stage8(t, e, b);
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['UNCERTAIN', 'TRAIN_LANDING_UNCONFIRMED', 1]); untouched(e, T);
    assert.equal(e.W.pushes.length, 1);
    const again = await stage8(t, e, b);
    assert.equal(again.status, 'RECONCILIATION_REQUIRED');
    assert.equal(e.W.pushes.length, 1);
  });
});

test('push: GitHub marks the PRs merged late; stage 10 still adopts each member at its landed head (riders first) and lists the unmarked ones', async t => {
  const { e, b } = await opened(t);
  const ff = e.port.fastForwardMain;
  e.port.fastForwardMain = async s => { const r = await ff(s); for (const p of e.W.pulls.values()) Object.assign(p, { state: 'open', merged: false }); return r; };
  const p = await stage8(t, e, b);
  assert.equal(p.status, 'SETTLED', JSON.stringify(p));
  const r = await stage10(e);
  assert.equal(r.facts.decision, 'FRONT_ADOPTED');
  assert.deepEqual([...r.facts.landing.notMarkedMerged].sort(), [910, 911, 912]);
  assert.deepEqual(e.adopted.map(a => a[0]), [911, 912, 910]);
});

test('push: a member that moved to a new head after its batch landed is not adopted (its claim goes on with the new head)', async t => {
  const { e, b } = await opened(t);
  const ff = e.port.fastForwardMain;
  e.port.fastForwardMain = async s => {
    const r = await ff(s);
    const n = h('later-912'); e.W.commits.set(n, { sha: n, tree: h('tree:l'), parents: [e.head(912)] }); e.W.content.set(n, new Set(['912', 'l']));
    Object.assign(e.W.pulls.get(912), { head: n, state: 'open', merged: false });
    return r;
  };
  assert.equal((await stage8(t, e, b)).status, 'SETTLED');
  await stage10(e);
  assert.deepEqual(e.adopted.map(a => a[0]).sort(), [910, 911]);
});

// Field 2026-11-13: a PR the holder merged (or closed) itself was never adopted and its binding stayed active for good (25 such rows
// were cleared by hand at 07:06Z). FABLE 11-19 L2: stage 10 reconciles every binding Native still holds open with GitHub, so the
// holder's bound PRs GitHub has ended are reported (merged with the merge commit, closed) and the open one stays front.
test('field 2026-11-13: bound PRs merged or closed outside the train are reported by stage 10, the open one stays front', async t => {
  const e = await world(t, { prs: [910, 911, 912], sharedClaim: true });
  const reported = [];
  e.native.port.lifecycleReport = async ({ prs }) => {
    for (const p of prs) { reported.push([p.pr, p.state, p.mergeSha]); e.queue.splice(e.queue.indexOf(p.pr), 1); }
    return { onDuty: true, deployed: true, tracked: [...e.queue] };
  };
  e.native.port.returnSlot = async () => assert.fail('giving back a slot ends no binding');
  const W = e.W, M = W.merge(e.main(), e.head(910), ':holder');
  W.refs.set('heads/main', M);
  Object.assign(W.pulls.get(910), { state: 'closed', merged: true, mergeSha: M });
  Object.assign(W.pulls.get(912), { state: 'closed', merged: false });
  let batch = null;
  for (let i = 0; i < 6 && !batch; i++) batch = (await stage10(e)).facts.openFrontBatch;
  assert.deepEqual(reported, [[912, 'closed', null], [910, 'merged', M]]);
  assert.deepEqual(e.adopted, []);
  assert.deepEqual(e.queue, [911]);
  assert.equal(batch?.pr, 911);
});

// FABLE 11-19 §4.1 (7): stage 10 asks Native which bindings are still open (tracked), reads only those GitHub no longer lists as
// open and reports what GitHub says, merged with its merge commit or closed, in one call; an open PR is never reported. D merged
// after its holder had released the claim itself (#1173): it is reported like C, whatever the claim.
test('pr lifecycle reconcile: one report per round names B closed, C and D merged with their merge commits, never the open A', async t => {
  const e = await world(t, { prs: [910, 911, 912, 913] });
  e.queue.splice(1);
  const W = e.W, MC = W.merge(e.main(), e.head(912), ':c'), MD = W.merge(e.main(), e.head(913), ':d');
  Object.assign(W.pulls.get(911), { state: 'closed', merged: false });
  Object.assign(W.pulls.get(912), { state: 'closed', merged: true, mergeSha: MC });
  Object.assign(W.pulls.get(913), { state: 'closed', merged: true, mergeSha: MD });
  const reports = [], reads = [];
  let tracked = [910, 911, 912, 913];
  e.native.port.lifecycleReport = async ({ prs }) => {
    reports.push(prs); tracked = tracked.filter(n => !prs.some(p => p.pr === n));
    return { onDuty: true, deployed: true, tracked: [...tracked] };
  };
  const read = e.gh.readPullRequest, page = e.gh.readPullsPage, pages = [];
  e.gh.readPullRequest = async (n, o) => { reads.push(n); return read(n, o); };
  e.gh.readPullsPage = async o => { pages.push(o); return page(o); };
  await stage10(e);
  assert.deepEqual(reports, [[], [{ pr: 913, state: 'merged', mergeSha: MD }, { pr: 912, state: 'merged', mergeSha: MC }, { pr: 911, state: 'closed', mergeSha: null }]]);
  assert.deepEqual(reads.filter(n => n !== 910).sort(), [911, 912, 913]);
  // Review 4: the round's own open list (fewer than a page) is complete; the reconcile reads no page of its own.
  const ownPages = () => pages.filter(o => o?.state === 'open' && o?.sort === 'created').length;
  assert.equal(ownPages(), 0);
  // Steady state: every tracked binding is open on GitHub, so a round asks once and reads no PR for it.
  reports.length = 0; reads.length = 0; pages.length = 0;
  await stage10(e);
  assert.deepEqual(reports, [[]]);
  assert.deepEqual(reads.filter(n => n !== 910), []);
  assert.equal(ownPages(), 0);
});

// Review 3: closed is reported only when GitHub says merged false and no merged_at; a reply without them is no fact this round.
test('pr lifecycle reconcile reports closed only on merged === false and no merged_at', async t => {
  const e = await world(t, { prs: [910, 914, 915] });
  e.queue.splice(1);
  Object.assign(e.W.pulls.get(914), { state: 'closed', merged: undefined });
  Object.assign(e.W.pulls.get(915), { state: 'closed', merged: false });
  const read = e.gh.readPullRequest;
  e.gh.readPullRequest = async (n, o) => { const p = await read(n, o); return n === 915 ? { ...p, merged_at: '2026-11-19T00:00:00Z' } : p; };
  const reports = [];
  e.native.port.lifecycleReport = async ({ prs }) => { reports.push(prs); return { onDuty: true, deployed: true, tracked: [914, 915] }; };
  await stage10(e);
  assert.deepEqual(reports, [[]]);
});

// Review B1: the reconcile is never on the train's path. It runs after the front's adopt/return/touch, the front bind and the front
// batch, inside the round's budget, every read with the round's deadline and the clock checked before each read; GitHub reads that
// take long change neither the decision nor the front batch: the reconcile only does less (and reports what it already has).
test('pr lifecycle reconcile is bounded and after the front: slow GitHub reads change no decision and no front batch', async t => {
  const ended = Array.from({ length: 30 }, (_, i) => 920 + i), SLOW = 200_000;
  const round = async slow => {
    const e = await world(t, { prs: [910, ...ended] });
    e.queue.splice(1);
    for (const n of ended) Object.assign(e.W.pulls.get(n), { state: 'closed', merged: false });
    const reported = [];
    e.native.port.lifecycleReport = async ({ prs }) => {
      reported.push(...prs.map(p => p.pr));
      return { onDuty: true, deployed: true, tracked: slow ? [910, ...ended].filter(n => !reported.includes(n)) : [] };
    };
    if (slow) {
      const read = e.gh.readPullRequest, page = e.gh.readPullsPage;
      e.gh.readPullRequest = async (n, o) => { if (ended.includes(n)) e.now += SLOW; return read(n, o); };
      e.gh.readPullsPage = async o => { if (o?.state === 'open' && o?.sort === 'created') e.now += SLOW; return page(o); };
    }
    const before = e.now;
    const r = await stage10(e);
    return { facts: [r.facts.decision, r.facts.requestPause, r.facts.openFrontBatch?.pr ?? null, r.facts.openFrontBatch?.headSha ?? null],
      reported, spent: e.now - before - 60_000 };
  };
  const quick = await round(false), slow = await round(true);
  assert.deepEqual(slow.facts, quick.facts);
  assert.ok(slow.reported.length > 0 && slow.reported.length < 25, `the reconcile did less: ${slow.reported.length}`);
  assert.ok(slow.spent <= 250_000 + SLOW, `the round stayed in its budget: ${slow.spent}`);
});

// FABLE 11-19 §4.1 (9): the reconcile is auxiliary. An RPC that is not deployed (PGRST202), a GitHub read that throws or a reply that
// cannot be read only means no reconcile this round: the round decides as it would without it and never asks for a pause.
test('pr lifecycle reconcile is auxiliary: not deployed, a failed GitHub read or an unreadable reply skips it and changes no decision', async t => {
  const unreadable = () => Object.assign(new Error('MERGE_TRAIN_NATIVE_UNREADABLE'), { code: 'MERGE_TRAIN_NATIVE_UNREADABLE' });
  const round = async patch => {
    const e = await world(t, { prs: [910, 911] });
    e.queue.splice(1);
    Object.assign(e.W.pulls.get(911), { state: 'closed', merged: false });
    e.asked = [];
    patch(e);
    const r = await stage10(e);
    return { e, facts: [r.facts.decision, r.facts.requestPause, r.facts.openFrontBatch?.pr ?? null] };
  };
  const answer = (e, reply) => { e.native.port.lifecycleReport = async ({ prs }) => { e.asked.push(prs); return reply(prs); }; };
  const baseline = await round(e => answer(e, () => ({ onDuty: true, deployed: true, tracked: [] })));
  assert.deepEqual(baseline.e.asked, [[]]);
  assert.equal(baseline.facts[1], null);
  const cases = {
    'not deployed': e => answer(e, () => ({ onDuty: null, deployed: false, tracked: null })),
    'first reply unreadable': e => answer(e, () => { throw unreadable(); }),
    'github read throws': e => {
      answer(e, () => ({ onDuty: true, deployed: true, tracked: [911] }));
      const read = e.gh.readPullRequest;
      e.gh.readPullRequest = async n => { if (n === 911) throw Object.assign(new Error('github_http_502'), { code: 'github_http_502' }); return read(n); };
    },
    'report reply unreadable': e => answer(e, prs => { if (prs.length) throw unreadable(); return { onDuty: true, deployed: true, tracked: [911] }; }),
    'tracked malformed': e => answer(e, () => ({ onDuty: true, deployed: true, tracked: 'all' })),
  };
  for (const [name, patch] of Object.entries(cases)) {
    const r = await round(patch);
    assert.ok(r.e.asked.length >= 1, `${name}: the reconcile was tried`);
    assert.deepEqual(r.facts, baseline.facts, name);
  }
  assert.deepEqual((await round(cases['github read throws'])).e.asked, [[]], 'nothing readable from GitHub: no report');
});

// Field 2026-11-13 (#1087): the holder's CI head is a head its PR no longer has (the author pushed). No bound PR matches it, which
// left no front at all (FRONT_NOT_BOUND) for good; the front is then the lowest bound PR, as when there is no CI head.
test('field 2026-11-13: a Task whose CI head was replaced by a push still gets its front, the lowest bound PR', async t => {
  const e = await world(t, { prs: [910, 911], sharedClaim: true });
  let first = null;
  for (let i = 0; i < 6 && !first; i++) first = (await stage10(e)).facts.openFrontBatch;
  assert.equal(first?.pr, 910);
  const W = e.W, pushed = W.merge(e.head(910), e.main(), ':push');
  W.pulls.get(910).head = pushed;
  for (const [app, name] of [[ACTIONS, 'ci-suites'], [APP, 'kooyumi-work-admission']]) {
    const id = W.nextCheck++; W.checks.set(id, { id, app: { id: app }, name, head_sha: pushed, status: 'completed', conclusion: 'success' });
  }
  let next = null, decisions = [];
  for (let i = 0; i < 6 && !next; i++) { const r = await stage10(e); decisions.push(r.facts.decision); next = r.facts.openFrontBatch; }
  assert.deepEqual([next?.pr, next?.headSha], [910, pushed], JSON.stringify(decisions));
});

// ---- D6 §8.4 (field 2026-11-19, DIAG-train-sweep-incomplete-20261119): a landing state the validator refuses ----
// DESK's store held a landing-state-* record the current validator refuses, so every push round refused the front in composeBatch
// (as TRAIN_SWEEP_INCOMPLETE) and nothing ever wrote a valid state. The real file has not been seen yet (landing-dump/out.txt was not
// produced): this fixture is generation 1's record (before f5dde69d1: the seven fields plus terminalScan), 待真实文件核对.
import { canonical } from '../src/proof.mjs';
import { validateLandingState, LANDING_STATE_CONTRACT, TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { trainSummary, withTrainLine, TRAIN_OWNER_NOTICE_DECISIONS } from '../../../independent-ci-resident-v1/src/train.mjs';

const LEGACY_RUN = '0000b59a89ac0000-000000000001';
async function legacyLandingState(e, ms) {
  const record = { contract: LANDING_STATE_CONTRACT, writtenAt: iso(ms), runId: LEGACY_RUN, bad: [], suspect: null, adopted: [], handled: [],
    terminalScan: { nextKind: 'landing-batch', front: { name: `front-${String(ms - 60_000).padStart(13, '0')}-${LEGACY_RUN}-0000aaaa.json`, recordSha256: 'a'.repeat(64) }, landing: null } };
  assert.throws(() => validateLandingState(record), { code: 'invalid_train_landing_state' }, 'the validator stays strict: the old field is refused');
  const name = `landing-state-${String(ms).padStart(13, '0')}-${LEGACY_RUN}-0000bbbb.json`;
  await fs.writeFile(path.join(e.store.directory, name), canonical(record));
  return name;
}

test('D6 §8.4 (a): a landing state the validator refuses and no landing batch -> read as empty, a valid state written, the first push round opens the batch', async t => {
  const e = await world(t, { prs: [910, 911] });
  const legacy = await legacyLandingState(e, NOW - 6 * 86_400_000);
  await assert.rejects(e.store.readLandingState(), { code: 'TRAIN_LANDING_STATE_UNREADABLE' }, 'the store refuses it as before');
  const r = await stage10(e);
  assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH', JSON.stringify(r.facts));
  assert.equal(r.facts.landing?.error, undefined, JSON.stringify(r.facts.landing));
  assert.deepEqual((await e.store.landingBatchByTest(r.facts.openFrontBatch.testSha)).members.map(m => m.pr), [910, 911]);
  assert.ok(e.W.refs.has('heads/clued-train/staging'), 'S pushed to staging');
  const names = await fs.readdir(e.store.directory);
  assert.ok(names.includes(legacy), 'the refused record is left as it is');
  assert.equal(names.filter(n => n.startsWith('landing-state-')).length, 2, 'one valid state written in that round');
  // a fresh reader (the next round's store) reads the written state, not the refused one
  assert.deepEqual(await (await TrainSweepStore.open(e.store.directory)).readLandingState(), { bad: [], suspect: null, adopted: [], handled: [] });
  const log = await drive(t, e, { until: () => e.queue.length === 0, steps: 6 });
  assert.equal(e.queue.length, 0, JSON.stringify(log));
  assert.deepEqual([910, 911].map(pr => e.W.pulls.get(pr).merged), [true, true]);
});

test('D6 §8.4 (b): the same refused state beside a landing batch of this node -> TRAIN_LANDING_STATE_UNREADABLE, no batch; landing.error reaches the status and the PR line, the Owner is told', async t => {
  const e = await world(t, { prs: [910, 911] });
  const T = e.main(), old = h('old-head');
  await e.store.appendLandingBatch({ writtenAt: iso(NOW - 7 * 86_400_000), runId: LEGACY_RUN, frontPr: 900, frontHeadSha: old, baseSha: T, testSha: h('old-S'), testTree: h('old-tree'),
    attempt: 1, members: [{ pr: 900, headSha: old, claimId: claimOf(900) }] });
  await legacyLandingState(e, NOW - 6 * 86_400_000);
  for (let round = 0; round < 2; round++) {
    const r = await stage10(e);
    assert.equal(r.facts.decision, 'TRAIN_LANDING_STATE_UNREADABLE', JSON.stringify(r.facts));
    assert.deepEqual(r.facts.landing, { route: 'push', missing: [], bypass: { main: 'always', independent: 'never' }, error: 'TRAIN_LANDING_STATE_UNREADABLE' });
    assert.equal(r.facts.openFrontBatch, null);
    validateTrainFacts(r.facts);
    assert.ok(!e.W.refs.has('heads/clued-train/staging') && !e.W.refs.has('heads/clued-train/staging.tmp'), 'nothing composed');
    assert.equal((await fs.readdir(e.store.directory)).filter(n => n.startsWith('landing-state-')).length, 1, 'no state written over it');
    // the resident: status.json train.last carries the error, the front's PR line names it, the decision is an Owner notice
    const summary = trainSummary(r.facts);
    assert.deepEqual([summary.decision, summary.landing], ['TRAIN_LANDING_STATE_UNREADABLE', { error: 'TRAIN_LANDING_STATE_UNREADABLE', route: 'push', bypass: { main: 'always', independent: 'never' } }]);
    const board = new StatusBoard({ clock: e.clock });
    board.update({ train: { enabled: 'on', last: summary } });
    const last = parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).train.last;
    assert.deepEqual([last.decision, last.landing], ['TRAIN_LANDING_STATE_UNREADABLE', { error: 'TRAIN_LANDING_STATE_UNREADABLE', route: 'push', bypass: { main: 'always', independent: 'never' } }]);
    const line = withTrainLine({ state: 'pending', description: '排队中' }, last, { pr: 910, headSha: e.head(910) }, e.now, 400);
    assert.match(line.description, /落地状态.*TRAIN_LANDING_STATE_UNREADABLE/, line.description);
    assert.ok(TRAIN_OWNER_NOTICE_DECISIONS.includes(summary.decision));
  }
  assert.deepEqual(e.W.pushes, []);
  assert.equal(e.main(), T);
});

// ---- bc982192 (replan §3.3, cause 甲): push landing admits a head behind main on its merge base ----
// The real resident poller, the real Source v2 full admission (fixture domain; its evaluator answers the merge slot with the real
// scripts/ci mergeSlotState: not_needed for a head that does not contain main's tip), the real stage 8 and stage 10.
const reach = (W, sha) => { const seen = new Set(), todo = [sha]; while (todo.length) { const x = todo.pop(); if (seen.has(x)) continue; seen.add(x); todo.push(...(W.commits.get(x)?.parents ?? [])); } return seen; };
function mergeBaseOf(W, a, b) {
  const inB = reach(W, b);
  const common = [...reach(W, a)].filter(x => inB.has(x));
  return common.find(x => common.every(y => y === x || !W.ancestor(x, y))) ?? null;
}
// gh as the poller calls it: the main ref and the open pulls with --include, compare with its --jq projection.
function pollerRun(e) {
  return async argv => {
    const route = argv.find(a => a.startsWith('repos/')) ?? '';
    const included = v => ({ code: 0, stdout: `HTTP/1.1 200 OK\n\n${JSON.stringify(v)}` });
    if (route === MAIN_REF_ROUTE(REPO)) return included({ object: { sha: e.main() } });
    if (route === PULLS_ROUTE(REPO)) return included([...e.W.pulls.values()].filter(p => p.state === 'open').map(p => ({ number: p.number,
      head: { sha: p.head }, base: { sha: e.W.T0 }, draft: false, updated_at: p.updated }))); // GitHub's base.sha: where main was at the last push
    const m = /compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})/.exec(route);
    if (m) {
      const inHead = reach(e.W, m[2]);
      const behindBy = [...reach(e.W, m[1])].filter(x => !inHead.has(x)).length;
      return { code: 0, stdout: JSON.stringify({ behind_by: behindBy, base: m[1], merge_base: mergeBaseOf(e.W, m[1], m[2]) }) };
    }
    return { code: 9, stdout: '' };
  };
}
const BINDING_ID = '0b1d0000-2222-4333-8444-555555555555';
const taskOf = pr => `${String(pr).padStart(8, '0')}-3333-4333-8444-555555555555`;
// The full admission port of stage 1 and stage 8, over the world: GitHub reads from it, Native's verify from its queue.
// batchRoute: what the stage read from its batch-route.json (bc982192; null: none, main's tip is the batch base).
function realAdmission(e, { batchRoute = null } = {}) {
  const W = e.W, ref = `merge:${REPO}:main`, policyText = '{"policy":"fixture"}';
  const config = { domain: 'fixture', repository: REPO, scope: SCOPE, workspace: os.tmpdir(), sourceManifestSha256: SOURCE, evaluatorSha256: digest('EVALUATOR'),
    policyText, policySha256: digest(policyText), ciPrincipalBindingId: BINDING_ID, ciPrincipalQualificationRef: 'qualification-ref',
    publishableKey: 'sb_publishable_fixture', supabaseUrl: 'https://fixture.supabase.co' };
  const answer = v => ({ ok: true, status: 200, json: async () => structuredClone(v) });
  const fetchImpl = async url => {
    const p = new URL(url).pathname;
    let m = /\/pulls\/(\d+)$/.exec(p);
    if (m) return answer(await e.gh.readPullRequest(Number(m[1])));
    m = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40}|main)$/.exec(p);
    if (m) { const c = await e.gh.readCompare(m[1], m[2] === 'main' ? e.main() : m[2]); return answer({ status: c.status, ahead_by: c.aheadBy, behind_by: c.behindBy }); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const evaluateImpl = async ({ event, observation_recorder }) => {
    const pr = event.pull_request, n = pr.number, head = pr.head.sha, main = e.main(), prRef = `${REPO}#${n}`, claimId = e.claimFor(n);
    const at = e.queue.indexOf(n), until = iso(e.now + 600_000), paths = [...W.pulls.get(n).paths];
    const claim = { claim_id: claimId, task_id: taskOf(n), fence: 3, execution_epoch: 1, context_key: SCOPE, status: 'ACTIVE', bound_pr: prRef,
      expires_at: iso(e.now + 3_600_000), lease_key_required: false, execution_handover_pending: false, merge_slot_until: until, trigger_refs: [ref],
      merge_queue: at < 0 ? [] : [{ ref, state: at === 0 ? 'head' : 'waiting', position: at + 1, ahead: at === 0 ? [] : e.queue.slice(0, at).map(x => ({ claim_id: e.claimFor(x) })),
        head: { claim_id: e.claimFor(e.queue[0]), bound_pr: `${REPO}#${e.queue[0]}`, since: iso(e.now - 1000), until } }] };
    const native = { status: 'ok', verdict: 'ADMITTED', execution_authorized: true, execution_policy: 'staged', current_fence: 3, execution_epoch: 1,
      bound_pr: prRef, pr_ref: prRef, head_sha: head, base_sha: pr.base.sha, verified_at: iso(e.now), paths_outside_write_set: [], claim };
    observation_recorder.record('claim_verification', { result: { payload: native } });
    const upToDate = W.ancestor(main, head), layer = (e.layerOfPaths ?? (() => 'code'))(paths);
    // evaluate()'s check_and_strict of the protected layer (clued-work-admission.mjs, protected_change_not_up_to_date): unchanged here
    const rejected = layer === 'protected' && !upToDate;
    return { admitted: !rejected, verdict: rejected ? 'REJECTED' : 'ADMITTED', reasons: rejected ? [`protected_change_not_up_to_date:${main}`] : [],
      head_sha: head, base_sha: pr.base.sha, pr_ref: prRef, claim_id: claimId, task_id: taskOf(n), scope: SCOPE, changed_paths: paths,
      claim_binding: { status: 'ok', binding_status: 'bound', reason: null, repository: REPO, pr_number: n, pr_ref: prRef, head_sha: head, base_sha: pr.base.sha,
        target_branch: 'main', scope: SCOPE, task_id: taskOf(n), claim: { claim_id: claimId, task_id: taskOf(n), context_key: SCOPE, fence: 3, execution_epoch: 1,
          lease_version: 1, expires_at: claim.expires_at, status: 'ACTIVE', execution_handover_pending: false }, head_authorization_id: null, auto_bound: false, receipt_id: null },
      admission_mode: { state: 'normal', layer, policy_version: 1 },
      merge_slot: mergeSlotState({ repository: REPO, branch: 'main', tip: main, upToDate, claim, verifiedAt: native.verified_at }),
      owner_review: null, workflow_gate_findings: [] };
  };
  return createFullAdmissionPortV2({ protectedConfig: config, batchRoute, clock: () => e.now, monotonic: () => e.now, fetchImpl,
    tokenProvider: async () => ({ githubToken: 'gh-fixture', ciAdmissionToken: ['clued', 'bnd', 'fixture123'].join('_'), ciPrincipalBindingId: BINDING_ID, ciPrincipalQualificationRef: 'qualification-ref' }),
    modeProvider: async () => ({ complete: true, repository: REPO, variable: 'CLUED_MERGE_ADMISSION_STATE', source: 'github-repository-variables', exists: false, observedAt: iso(e.now), proofRef: 'mode-proof' }),
    recorderProvider: async () => ({ kind: 'independent-controller', domain: 'fixture', observedAt: iso(e.now), observationRef: 'obs', recorder: { newId: () => h(`id:${e.now}:${Math.random()}`), record() {} } }),
    fixtureHooks: { evaluatorReader: () => 'EVALUATOR', evaluateImpl } });
}
// Stage 1 (S = H) of every trigger the poller wrote: the real full admission; then that batch's stage 8 (it parks: not the train front).
async function stageOneAll(t, e, triggers, { batchRoute = null } = {}) {
  const out = [];
  for (const g of triggers) {
    const job = batchJobsV2({ repo: REPO, pr: g.pr, headSha: g.headSha, baseSha: g.baseSha, testSha: g.headSha, sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: 1 })['control-admission'];
    const facts = await e.admission.evaluatePr(job, await e.gh.readChangedPaths(job));
    const p8 = facts.status === 'ADMITTED' ? await stage8(t, e, { pr: g.pr, headSha: g.headSha, baseSha: g.baseSha, testSha: g.headSha, attempt: 1 }, { batchRoute }) : null;
    out.push({ pr: g.pr, status: facts.status, reason: facts.reason ?? null, slot: facts.mergeSlot?.state ?? null, stage8: p8 ? [p8.status, p8.reason ?? null] : null });
  }
  return out;
}
const pollOnce = async (e, landing) => {
  const triggers = [];
  const poller = new Poller({ repo: REPO, ghExe: 'gh', run: pollerRun(e), clock: () => e.now, writeTrigger: async v => { triggers.push(v); }, landing: async () => landing });
  await poller.pass();
  return { triggers, pulls: poller.lastPass?.pulls ?? null };
};

test('push C3 (cause 甲): three PRs each two commits behind main, nobody merges main -> admitted on their merge base -> one batch of three lands within 30 minutes', async t => {
  const prs = [1301, 1302, 1303];
  const e = await world(t, { prs, behind: 2 });
  e.admission = realAdmission(e, { batchRoute: 'push' }); // every batch here stamped push (the resident-level drive is E3 below)
  const start = e.now, T0 = e.W.T0, M2 = e.main(), heads = prs.map(e.head);
  assert.ok(prs.every(pr => !e.W.ancestor(M2, e.head(pr))), 'every head is behind main');
  // ring 1: the poller proposes each head on its merge base with main (T0), not main's tip
  const { triggers, pulls } = await pollOnce(e, 'push');
  assert.deepEqual(triggers.map(g => [g.pr, g.headSha, g.baseSha]).sort((a, b) => a[0] - b[0]), prs.map(pr => [pr, e.head(pr), T0]), JSON.stringify(pulls));
  // ring 2: stage 1's full admission admits S = H on T0 (the head does not contain main: merge slot not_needed); ring 3: its stage 8 never
  // ends the base because main is past it
  const one = await stageOneAll(t, e, triggers, { batchRoute: 'push' });
  for (const r of one) {
    assert.equal(r.status, 'ADMITTED', JSON.stringify(r));
    assert.equal(r.slot, 'not_needed', JSON.stringify(r));
    assert.notEqual(r.stage8?.[1], 'RESIDENT_BASE_MOVED', JSON.stringify(r));
  }
  // ring 4: stage 10 composes merge(M2, H...) and stage 8 (the real admission: the front's tested S contains main) pushes it
  let batch = null;
  const log = await drive(t, e, { until: () => prs.every(pr => e.W.pulls.get(pr).merged), opened: async (r, b) => { batch ??= b; } });
  assert.ok(prs.every(pr => e.W.pulls.get(pr).merged), JSON.stringify(log));
  assert.equal(e.W.pushes.length, 1, JSON.stringify(log));
  assert.equal(new Set(prs.map(pr => e.W.pulls.get(pr).mergeSha)).size, 1, 'one batch');
  assert.equal(batch.baseSha, M2);
  assert.ok(e.W.ancestor(M2, e.main()), 'main only fast-forwarded');
  assert.deepEqual(prs.map(e.head), heads, 'no head was changed: nobody merged main into a PR');
  assert.ok(e.now - start <= 30 * 60_000, `landed after ${(e.now - start) / 60_000} minutes`);
});

test('C3 regression, github-merge: a head behind main is still told merge-main and proposed to no stage (also without a landing port, or when it cannot be read)', async t => {
  const e = await world(t, { prs: [1331], behind: 2, rules: 'today' });
  for (const landing of ['github-merge', undefined, 'unknown']) {
    const { triggers, pulls } = await pollOnce(e, landing);
    assert.deepEqual(triggers, [], String(landing));
    assert.deepEqual(pulls.map(p => [p.pr, p.eligible, p.hint, p.behindBy]), [[1331, false, 'merge-main', 2]], String(landing));
  }
  // a broken landing port is github-merge too
  const triggers = [];
  const poller = new Poller({ repo: REPO, ghExe: 'gh', run: pollerRun(e), clock: () => e.now, writeTrigger: async v => { triggers.push(v); }, landing: async () => { throw new Error('status unreadable'); } });
  await poller.pass();
  assert.deepEqual(triggers, []);
  assert.equal(poller.lastPass.pulls[0].hint, 'merge-main');
  // a head that contains main's tip: proposed on main's tip, exactly as before
  const up = await world(t, { prs: [1332] });
  const r = await pollOnce(up, 'github-merge');
  assert.deepEqual(r.triggers.map(g => [g.pr, g.baseSha]), [[1332, up.main()]]);
});

test('C3 regression, protected layer: a protected head behind main is still refused at stage 1 (it must contain main\'s tip) and never opens a batch', async t => {
  const e = await world(t, { prs: [1311], behind: 2 });
  e.layerOfPaths = LAYER;
  e.W.pulls.get(1311).paths = ['scripts/ci/x.mjs'];
  e.admission = realAdmission(e, { batchRoute: 'push' }); // stamped push: the evaluator's protected rule is what refuses it
  const { triggers } = await pollOnce(e, 'push');
  assert.equal(triggers.length, 1, 'the poller does not judge layers');
  const [one] = await stageOneAll(t, e, triggers);
  assert.deepEqual([one.status, one.reason], ['BLOCKED', 'full_admission_rejected'], JSON.stringify(one));
  const decisions = [];
  for (let i = 0; i < 4; i++) { const r = await stage10(e); decisions.push(r.facts.decision); assert.equal(r.facts.openFrontBatch ?? null, null, JSON.stringify(decisions)); }
  assert.deepEqual(e.W.pushes, []);
  assert.equal(e.W.pulls.get(1311).merged, false);
});

test('C3 rider rule: a PR whose head has a failed required check never rides; the batch lands the others in one push', async t => {
  const prs = [1321, 1322, 1323];
  const e = await world(t, { prs, bad: content => content.has('1322') });
  assert.deepEqual(await firstBatchMembers(e), [1321, 1323]);
  const log = await drive(t, e, { until: () => e.W.pulls.get(1321).merged && e.W.pulls.get(1323).merged });
  assert.ok(e.W.pulls.get(1321).merged && e.W.pulls.get(1323).merged, JSON.stringify(log));
  assert.equal(e.W.pulls.get(1321).mergeSha, e.W.pulls.get(1323).mergeSha, 'one batch');
  assert.equal(e.W.pulls.get(1322).merged, false);
});

test('C3 descriptor: the resident writes baseRule on-main only for an S = H batch stamped push; what is installed decides nothing', async t => {
  const describe = async (engine, root, subject) => {
    const batch = await engine.derive(subject, createHash('sha256').update(JSON.stringify(subject)).digest('hex'));
    return { batch, d: JSON.parse(await fs.readFile(path.join(root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8')) };
  };
  const head = h('c3-head'), base = h('c3-merge-base'), S = h('c3-S');
  const sh = { repo: REPO, pr: 1340, headSha: head, baseSha: base, sourceManifestSha256: CI_SOURCE, attempt: 1 };
  const { engine, root } = await residentEngine(t);
  for (const [trainMode, trainLanding] of [['on', { landing: 'push', batchMax: 3 }], ['shadow', { landing: 'push', batchMax: 3 }], ['on', { landing: 'github-merge', batchMax: 1 }]]) {
    Object.assign(engine, { trainMode, trainLanding });
    const why = `${trainMode} ${trainLanding.landing}`;
    assert.equal((await describe(engine, root, { ...sh, batchRoute: 'push' })).d.baseRule, 'on-main', why);
    assert.equal((await describe(engine, root, { ...sh, testSha: head, batchRoute: 'push' })).d.baseRule, 'on-main', why);
    const front = await describe(engine, root, { ...sh, testSha: S, batchRoute: 'push' });
    assert.equal(Object.hasOwn(front.d, 'baseRule'), false, `a front batch runs on main's tip (${why})`);
    assert.equal(front.batch.batchRoute, 'push', 'its stages 1 and 8 still learn the route');
    const plain = await describe(engine, root, sh);
    assert.equal(Object.hasOwn(plain.d, 'baseRule'), false, `no stamp: main must be the base (${why})`);
    assert.equal(Object.hasOwn(plain.batch, 'batchRoute'), false);
  }
});

// ---- bc982192 (C3 rework, plan 戊; FABLE-c3-batch-rule-channel-20261122 §5, E1-E3, E6, E8): the batch route, end to end ----
// The resident between the poller and the stages: the real ResidentExecutor (intake and its stamp, localPlan, the train's maintenance, the
// front binding) over this world. Stage 10 is the real runTrain; derive is the resident engine's (its descriptor); stage 1 is the real
// Source v2 full admission and stage 8 the real control publisher, each with the route its own stage file gives it: the engine's arguments
// for that stage (stageArgs) -> the invoker's stage directory (invoke-stage.mjs#prepareStageDirectory) -> batch-route.mjs#readStageBatchRoute,
// as both startup.mjs read it. Stages 2-7 are only counted (R3 skips them when no scan is required from this App). The poller reads the
// executor's own status board as companion-main.mjs does (status.mjs#pollerLandingOf). Nothing is queued or admitted beforehand.
// tamper(number, dir): changes stage 1's or 8's stage directory before the stage reads it (E6).
const SEALED = Object.freeze({ files: Object.freeze({ 'formal-service-entry.json': Buffer.from('{}'), 'jobs.json': Buffer.from('[]') }) });
const PROOF = Object.freeze({ windowsTreeZero: true, serviceOriginalStopped: true });
const CHAIN3 = Object.freeze({ landing: 'push', batchMax: 3, batchChain: true, unreadable: false });
let nonceN = 0;
async function stageRoute(t, real, number, batch, tamper = null) {
  const args = await real.stageArgs(number, batch), i = args.indexOf('--batch-route');
  const dir = await prepareStageDirectory({ stageRoot: await tempDir(t), nonce: (++nonceN).toString(16).padStart(32, '0'), sealed: SEALED,
    batchRoute: i < 0 ? null : args[i + 1] });
  await tamper?.(number, dir);
  return readStageBatchRoute(dir);
}
async function residentOver(t, e, { tamper = null, facts = null } = {}) {
  const { engine: real, root } = await residentEngine(t);
  const engine = fakeEngine();
  const subjects = new Map();
  Object.assign(engine, { stages: [], stage1: [], stage8: [], routes: [], descriptors: new Map(), trainRuns: [], subjects });
  let f = null, run = 0;
  const sync = () => { e.now = f.clock(); };
  const back = () => { if (e.now > f.clock()) f.advance(e.now - f.clock()); };
  engine.derive = async (subject, key, chain) => {
    engine.calls.push(['derive', key]);
    const batch = await real.derive(subject, key, chain ?? null);
    subjects.set(key, subject);
    engine.descriptors.set(key, JSON.parse(await fs.readFile(path.join(root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8')));
    return batch;
  };
  engine.runTrainStage = async (mode, input) => {
    engine.calls.push(['stage', 10, mode]);
    sync();
    const { mode: m, ...params } = input;
    const job = makeTrainRun({ repo: REPO, runId: `${(++run).toString(16).padStart(16, '0')}-0123456789ab`, mode: m, sourceManifestSha256: SOURCE, createdAt: iso(e.now), ...params });
    const r = await runTrain({ job, github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep,
      claimScope: SCOPE, layerOfPaths: e.layerOfPaths ?? (() => 'code'), landing: e.port, trainLanding: e.trainLanding ?? CHAIN3 });
    const train = facts ? facts(r.facts) : r.facts;
    engine.trainRuns.push(train);
    back();
    return { ok: true, runId: job.runId, proof: PROOF, train,
      outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: r.sideEffects, mayHavePublished: r.sideEffects > 0, diagnostic: null, scheduling: null, safeToRerun: false } };
  };
  engine.runStage = async (batch, stage) => {
    const subject = subjects.get(batch.key), front = Object.hasOwn(subject, 'testSha') && subject.testSha !== subject.headSha;
    const testSha = subject.testSha ?? subject.headSha, n = subject.pr;
    engine.stages.push({ pr: n, front, stage: stage.number, at: f.clock() });
    engine.calls.push(['stage', stage.number]);
    sync();
    const b = { pr: n, headSha: subject.headSha, baseSha: subject.baseSha, testSha, attempt: subject.attempt };
    const ok = { ok: true, factsSha256: 'd'.repeat(64), proof: PROOF };
    if (stage.number === 1) {
      const batchRoute = await stageRoute(t, real, 1, batch, tamper);
      engine.routes.push({ pr: n, front, stage: 1, stamped: batch.batchRoute ?? null, read: batchRoute });
      const job = batchJobsV2({ repo: REPO, ...b, sourceManifestSha256: SOURCE, createdAt: iso(e.now) })['control-admission'];
      const facts = await realAdmission(e, { batchRoute }).evaluatePr(job, await e.gh.readChangedPaths(job));
      engine.stage1.push({ pr: n, front, status: facts.status, reason: facts.reason ?? null, slot: facts.mergeSlot?.state ?? null });
      if (facts.status !== 'ADMITTED') return { ok: false, code: 'NATIVE_NOT_ADMITTED', proof: PROOF,
        outcome: { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: true } };
      // the admission stage publishes App 5368905's kooyumi-work-admission on H
      if (!front) { const id = e.W.nextCheck++; e.W.checks.set(id, { id, app: { id: APP }, name: 'kooyumi-work-admission', head_sha: subject.headSha, status: 'completed', conclusion: 'success' }); }
      const at = e.queue.indexOf(n);
      return { ...ok, outcome: { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true, diagnostic: null, safeToRerun: false,
        scheduling: { ciRetryAfter: null, claimExpiresAt: null, mergeQueue: at < 0 ? { entered: false, state: null, position: null } : { entered: true, state: at === 0 ? 'head' : 'waiting', position: at + 1 } } } };
    }
    if (stage.number !== 8) return ok;
    const batchRoute = await stageRoute(t, real, 8, batch, tamper);
    engine.routes.push({ pr: n, front, stage: 8, stamped: batch.batchRoute ?? null, read: batchRoute });
    const claimAssist = { async joinQueue({ pr }) { if (!e.queue.includes(pr)) e.queue.push(pr); return { ok: true, joined: true }; },
      async extendLease() { return { ok: true, extended: false, reason: null }; } };
    const p = await stage8(t, e, b, { trainLanding: CHAIN3, scans: false, batchRoute, claimAssist, admission: realAdmission(e, { batchRoute }) });
    engine.stage8.push({ pr: n, front, status: p.status, reason: p.reason ?? null });
    back();
    return p.status === 'SETTLED' ? ok : { ok: false, code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', proof: PROOF,
      outcome: { status: 'BLOCKED', reason: 'TRAIN_SINGLE_GREEN_NOT_PROVEN', sideEffects: 0, mayHavePublished: false } };
  };
  const policy = rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 10 * 60_000, maintenanceMaxPerDay: 200,
    ...TRAIN_DEFAULTS, sweep: 'audit', landing: 'push', batchMax: 3 } });
  const board = new StatusBoard({ clock: () => e.now });
  f = await executorFixture(t, { now: e.now, engine, status: board, policy });
  f.exec.trainTakeoverDone = true;
  await f.exec.trainRecover();
  // companion-main.mjs: the poller's landing port reads the status file the executor writes
  const status = () => parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  const poller = new Poller({ repo: REPO, ghExe: 'gh', run: pollerRun(e), clock: () => f.clock(), writeTrigger: async v => { await f.drop(Buffer.from(JSON.stringify(v))); },
    landing: async () => pollerLandingOf(status()) });
  // origin/main's poller (no landing port) over the same world, for comparison
  const plain = new Poller({ repo: REPO, ghExe: 'gh', run: pollerRun(e), clock: () => f.clock(), writeTrigger: async () => { throw new Error('origin/main proposes nothing here'); } });
  return { f, engine, real, board, status, poller, plain };
}
const BLOCKED_ROUTE = 'blocked (bc982192 result file): stage 10 and stage 8 read the route as park (main_ruleset_unidentified) when the three scans are required from Actions; train-landing.mjs#readLandingRoute, a design choice for planning';
const rowsOf = f => [...f.queue.data.rows].map(r => ({ pr: r.pr, state: r.state, headSha: r.current?.headSha ?? null, baseSha: r.current?.baseSha ?? null, batchRoute: r.current?.batchRoute ?? null }));
const passOf = p => p.lastPass.pulls.map(x => [x.pr, x.eligible, x.hint, x.behindBy]);

// E1 (H2) and E2: installed landing push; stage 10's own reading is not push, nothing was read, the status cannot be read, or a scan is still
// required from this App (or appScans not read: a Source before R3): no stamp anywhere, the poller proposes nothing and says merge-main for
// every head behind main, exactly as origin/main's poller (no landing port) on the same world; no row, no batch, only stage 10 runs.
for (const scene of [
  { name: 'E1 route github-merge (today\'s rules)', rules: 'today' },
  { name: 'E1 route park (kooyumi-train-landed, the App cannot bypass main)', rules: 'push', prepare: e => { e.W.rulesets.set(MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'never' }); } },
  { name: 'E1 no route read yet (no stage 10)', rules: 'push', appScans: [], noStage10: true },
  { name: 'E1 the status cannot be read', rules: 'push', appScans: [], unreadable: true, todo: BLOCKED_ROUTE },
  { name: 'E2 route push, all three scans from this App', rules: 'push' },
  { name: 'E2 route push, gitleaks still from this App', rules: 'push', appScans: ['gitleaks'] },
  { name: 'E2 route push, appScans not read (a Source before R3)', rules: 'push', appScans: [], facts: x => (x.rules ? { ...x, rules: Object.fromEntries(Object.entries(x.rules).filter(([k]) => k !== 'appScans')) } : x) },
]) test(`bc982192 ${scene.name}: installed push -> no stamp, no proposal, merge-main, as origin/main`, scene.todo ? { todo: scene.todo } : {}, async t => {
  const prs = [1401, 1402, 1403];
  const e = await world(t, { prs, behind: 2, rules: scene.rules, queued: false, admitted: false, ...(scene.appScans ? { appScans: scene.appScans } : {}) });
  scene.prepare?.(e);
  const r = await residentOver(t, e, { facts: scene.facts ?? null });
  if (scene.unreadable) r.board.snapshot = () => { throw new Error('status unreadable'); };
  for (let i = 0; i < 4; i++) {
    if (!scene.noStage10) await r.f.exec.tick();
    await r.poller.pass(); await r.plain.pass();
    assert.deepEqual(passOf(r.poller), passOf(r.plain), `pass ${i}`);
    assert.deepEqual(passOf(r.poller), prs.map(pr => [pr, false, 'merge-main', 2]), `pass ${i}`);
    if (!scene.noStage10) await r.f.exec.tick();
    r.f.advance(10 * 60_000);
  }
  if (!scene.noStage10) {
    assert.ok(r.engine.trainRuns.length > 0, 'stage 10 ran');
    assert.equal(r.f.exec.batchRoute(), scene.unreadable ? 'push' : null, JSON.stringify(r.f.exec.trainLast));
  }
  if (!scene.unreadable) assert.equal(Object.hasOwn(r.f.exec.trainStatus(), 'batchRoute'), false);
  assert.deepEqual(rowsOf(r.f), []);
  assert.deepEqual(r.engine.calls.filter(c => c[0] !== 'stage' || c[1] !== 10), [], 'nothing but stage 10');
  assert.deepEqual(e.W.pushes, []);
});

// E3 (the target scene, end to end): route push and no scan required from this App; three PRs each two commits behind main, nobody in the
// merge queue, no admission yet; main moves once more on its own meanwhile. Nobody merges main into any PR; one batch lands all three.
test('bc982192 E3: route push, appScans [] -> stamped at birth -> stage 1 on the merge base -> no scan stage -> stage 8 joins -> one front batch of three lands in one push within 30 minutes', { todo: BLOCKED_ROUTE }, async t => {
  const prs = [1411, 1412, 1413];
  const e = await world(t, { prs, behind: 2, queued: false, admitted: false, appScans: [] });
  const r = await residentOver(t, e);
  const { f, engine } = r;
  const start = f.clock(), T0 = e.W.T0, heads = prs.map(e.head);
  let moved = null;
  const landed = () => prs.every(pr => e.W.pulls.get(pr).merged);
  for (let i = 0; i < 40 && !landed(); i++) {
    await r.poller.pass();
    await f.exec.tick();
    // main moves once more on its own after the first stage 8 (another writer)
    if (!moved && engine.stage8.length > 0) {
      moved = h('E3-other');
      e.W.commits.set(moved, { sha: moved, tree: h('tree:E3-other'), parents: [e.main()] }); e.W.content.set(moved, new Set([...e.W.content.get(e.main()), 'other']));
      e.W.refs.set('heads/main', moved);
    }
    f.advance(60_000);
  }
  const diag = JSON.stringify({ rows: rowsOf(f), stages: engine.stages, stage1: engine.stage1, stage8: engine.stage8, routes: engine.routes,
    ten: engine.trainRuns.map(x => [x.decision, x.landing?.route ?? null, x.landing?.missing ?? null, x.rules?.appScans ?? null, x.openFrontBatch?.pr ?? null]) });
  assert.ok(landed(), diag);
  assert.ok(moved, 'main moved during the run');
  // one push, of one batch of all three, on main past the move; main only fast-forwarded; no head changed (nobody merged main into a PR)
  assert.equal(e.W.pushes.length, 1, diag);
  assert.equal(new Set(prs.map(pr => e.W.pulls.get(pr).mergeSha)).size, 1, diag);
  assert.ok(e.W.ancestor(moved, e.main()), 'landed on main past the move');
  assert.deepEqual(prs.map(e.head), heads);
  assert.ok(f.clock() - start <= 30 * 60_000, `landed after ${(f.clock() - start) / 60_000} minutes`);
  // the stamp: every ordinary batch was born push, on the merge base T0, and its descriptor says on-main
  const ordinary = [...engine.subjects.entries()].filter(([, s]) => !Object.hasOwn(s, 'testSha'));
  assert.deepEqual(ordinary.map(([, s]) => s.pr).sort(), prs, diag);
  for (const [key, s] of ordinary) {
    assert.deepEqual([s.baseSha, s.batchRoute], [T0, 'push'], JSON.stringify(s));
    assert.equal(engine.descriptors.get(key).baseRule, 'on-main');
  }
  // stage 1 read the route from its file and admitted each head on T0; the front's stage 1 too (its merge slot read as on main's tip)
  assert.ok(engine.routes.every(x => x.stamped === 'push' && x.read === 'push'), diag);
  assert.deepEqual(engine.stage1.filter(x => !x.front).map(x => [x.pr, x.status]).sort((a, b) => a[0] - b[0]), prs.map(pr => [pr, 'ADMITTED']), diag);
  const front1 = engine.stage1.filter(x => x.front);
  assert.ok(front1.length >= 1 && front1.every(x => x.status === 'ADMITTED' && x.slot !== 'not_needed'), diag);
  // R3: no scan stage ran for any batch; the receipt says why
  assert.deepEqual(engine.stages.filter(s => s.stage >= 2 && s.stage <= 7), [], diag);
  assert.ok((await f.receipts.latest(['scans-not-app-required'], 10)).length > 0);
  // stage 8 of each ordinary batch joined the queue and never ended on the moved base; the front's stage 8 landed
  assert.ok(engine.stage8.every(x => x.reason !== 'RESIDENT_BASE_MOVED' && x.reason !== 'full_admission_subject_changed'), diag);
  assert.ok(engine.stage8.some(x => x.front && x.status === 'SETTLED'), diag);
  // stage 10 opened the front batch with the two riders
  const open = engine.trainRuns.find(x => x.openFrontBatch);
  assert.equal(open.openFrontBatch.members?.length ?? 0, 3, diag);
});

// E6 (a broken channel is the strict rule): a batch stamped push whose stage file is missing, too long, names an unknown route or is not
// the exact bytes: stage 1 refuses the head behind main (full_admission_subject_changed); stage 8 never relaxes either (the real admission:
// full_admission_subject_changed; an admission that does not look at the base: RESIDENT_BASE_MOVED); a front job's merge slot is not taken
// as on main's tip.
const rewrite = text => async dir => { await fs.rm(path.join(dir, STAGE_BATCH_ROUTE_FILE)); if (text !== null) await fs.writeFile(path.join(dir, STAGE_BATCH_ROUTE_FILE), text); };
for (const [name, tamper] of [
  ['missing', rewrite(null)],
  ['too long', rewrite(`${stageBatchRouteText('push')}${' '.repeat(300)}`)],
  ['an unknown route', rewrite(stageBatchRouteText('push').replace('push', 'github-merge'))],
  ['not the exact bytes', rewrite(`${stageBatchRouteText('push')}\n`)],
]) test(`bc982192 E6: a batch stamped push whose batch-route.json is ${name} -> stage 1 full_admission_subject_changed, stage 8 never relaxes, frontSlot not transformed`, async t => {
  const e = await world(t, { prs: [1421], behind: 2, queued: false, admitted: false, appScans: [] });
  const { engine: real } = await residentEngine(t);
  const stamped = { batchRoute: 'push' };
  const T0 = e.W.T0, H1 = e.head(1421), M = e.main();
  const route = n => stageRoute(t, real, n, stamped, (_, dir) => tamper(dir));
  assert.equal(await stageRoute(t, real, 1, stamped), 'push', 'untouched it reads push');
  const r1 = await route(1);
  assert.equal(r1, null);
  const job = batchJobsV2({ repo: REPO, pr: 1421, headSha: H1, baseSha: T0, testSha: H1, sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: 1 })['control-admission'];
  const one = await realAdmission(e, { batchRoute: r1 }).evaluatePr(job, await e.gh.readChangedPaths(job));
  assert.deepEqual([one.status, one.reason], ['BLOCKED', 'full_admission_subject_changed'], JSON.stringify(one));
  // stage 8, the publisher's own gate (publisher.mjs, RESIDENT_BASE_MOVED): an admission that admits the head and reads main's tip as the
  // slot's tip; not in the queue, so the queue-head path does not answer first. The route read: main past the base ends nothing.
  const b = { pr: 1421, headSha: H1, baseSha: T0, testSha: H1, attempt: 1 };
  const r8 = await route(8);
  assert.equal(r8, null);
  const tipAdmission = { async evaluatePr(job, packet, options) {
    const claim = { claimId: e.claimFor(job.pr), fence: 3, epoch: 1, expiresAt: iso(e.now + 3_600_000) };
    options?.scheduling?.({ mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: claim.expiresAt });
    const { observationSha256, ...base } = admittedFacts(job, claim, packet, { domain: 'fixture', mergeQueueHead: false, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 });
    const facts = { ...base, mergeSlot: { ...base.mergeSlot, tip: e.main() } };
    return { ...facts, observationSha256: digest(facts) };
  } };
  const q = await stage8(t, e, b, { batchRoute: r8, scans: false, admission: tipAdmission });
  assert.deepEqual([q.status, q.reason], ['BLOCKED', 'RESIDENT_BASE_MOVED'], JSON.stringify(q));
  const qp = await stage8(t, e, b, { batchRoute: 'push', scans: false, admission: tipAdmission });
  assert.notEqual(qp.reason, 'RESIDENT_BASE_MOVED', JSON.stringify(qp));
  // the real admission at stage 8 (the queue head now): it refuses the moved base itself
  e.queue.push(1421);
  const p = await stage8(t, e, b, { batchRoute: r8, scans: false, admission: realAdmission(e, { batchRoute: r8 }) });
  assert.deepEqual([p.status, p.reason], ['BLOCKED', 'full_admission_subject_changed'], JSON.stringify(p));
  // the front job (S = merge(main, H)): its merge slot as the evaluator answered it (not_needed), never taken as on main's tip
  const S = e.W.merge(M, H1);
  const fjob = batchJobsV2({ repo: REPO, pr: 1421, headSha: H1, baseSha: M, testSha: S, sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: 1 })['control-admission'];
  const fr = await realAdmission(e, { batchRoute: await route(1) }).evaluatePr(fjob, await e.gh.readChangedPaths(fjob));
  const fp = await realAdmission(e, { batchRoute: 'push' }).evaluatePr(fjob, await e.gh.readChangedPaths(fjob));
  assert.equal(fr.mergeSlot?.state, 'not_needed', JSON.stringify(fr));
  assert.notEqual(fp.mergeSlot?.state, 'not_needed', 'with the route read, the front slot is on main\'s tip');
});

// E8 (the route changes after the batch is born): the rows were stamped push; then main's rules go back to today's (route github-merge).
// Stage 1 of a stamped batch still admits it on its merge base (the stamp is the birth's), but nothing lands: stage 10 opens no front batch
// for a head behind main, no stage 8 writes main, and the next poll says merge-main again.
test('bc982192 E8: stamped push at birth, then the route turns github-merge -> stage 1 still admits, nothing lands, the poller says merge-main', { todo: BLOCKED_ROUTE }, async t => {
  const prs = [1431, 1432];
  const e = await world(t, { prs, behind: 2, queued: false, admitted: false, appScans: [] });
  const r = await residentOver(t, e);
  const { f, engine } = r;
  for (let i = 0; i < 6 && rowsOf(f).length < prs.length; i++) { await r.poller.pass(); await f.exec.tick(); f.advance(60_000); }
  assert.deepEqual(rowsOf(f).map(x => [x.pr, x.batchRoute]), prs.map(pr => [pr, 'push']), JSON.stringify(rowsOf(f)));
  e.W.setRules('today');
  const T = e.main();
  for (let i = 0; i < 30; i++) { await r.poller.pass(); await f.exec.tick(); f.advance(60_000); }
  const diag = JSON.stringify({ rows: rowsOf(f), stage1: engine.stage1, stage8: engine.stage8, ten: engine.trainRuns.map(x => [x.decision, x.landing?.route ?? null, x.openFrontBatch?.pr ?? null]) });
  assert.ok(engine.stage1.filter(x => !x.front).length >= 1 && engine.stage1.filter(x => !x.front).every(x => x.status === 'ADMITTED'), diag);
  assert.equal(engine.trainRuns.at(-1).landing?.route, 'github-merge', diag);
  assert.equal(f.exec.batchRoute(), null);
  assert.deepEqual(e.W.pushes, [], diag);
  assert.equal(e.main(), T);
  assert.ok(prs.every(pr => !e.W.pulls.get(pr).merged));
  assert.ok(engine.trainRuns.slice(-5).every(x => !x.openFrontBatch), diag);
  assert.deepEqual(passOf(r.poller), prs.map(pr => [pr, false, 'merge-main', 2]));
});
