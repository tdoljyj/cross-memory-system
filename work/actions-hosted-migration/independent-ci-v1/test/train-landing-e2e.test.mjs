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
import { validateTrainFacts } from '../src/independent-control-checks-v2/train-facts.mjs';
import { parseLandingArg } from '../src/resident-v2/invoke-stage.mjs';
import fs from 'node:fs/promises';
import { WindowsEngine, DESCRIPTOR_CHAIN_CONTRACT, DESCRIPTOR_CONTRACT } from '../../../independent-ci-resident-v1/src/engine-windows.mjs';
import { chainOfFront, openFrontBatchOf } from '../../../independent-ci-resident-v1/src/train.mjs';
import { AdmissionRerunner, AdmissionRerunState, decide, HEAD_RECHECK_MS } from '../../../independent-ci-resident-v1/src/admission-rerun.mjs';
import { parseStatus, StatusBoard } from '../../../independent-ci-resident-v1/src/status.mjs';
import { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } from '../../../independent-ci-resident-v1/src/policy.mjs';
import { CLEAN_PROOF, executorFixture, fakeEngine, rawPolicy, TEST_NODE, TEST_NODE_SHA } from '../../../independent-ci-resident-v1/test/helpers.mjs';

const APP = 5368905, ACTIONS = 15368, SCOPE = 'project:00000000-0000-4000-8000-000000000000';
const h = s => createHash('sha1').update(s).digest('hex');
const claimOf = pr => `${String(pr).padStart(8, '0')}-2222-4333-8444-555555555555`;
const body = pr => `Change.\n\nClued-Work-Claim: ${claimOf(pr)}\nClued-Work-Scope: ${SCOPE}\n`;
const healthy = { nodes: [{ node: { name: 'turing', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }] };

// ---- the world ----
async function world(t, { prs, bad = () => false, sharedClaim = false }) {
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
  W.refs.set('heads/main', T0);
  const actions = sha => {
    const id = W.nextCheck++;
    W.checks.set(id, { id, app: { id: ACTIONS }, name: 'ci-suites', head_sha: sha, status: 'completed',
      conclusion: bad(W.content.get(sha)) ? 'failure' : 'success', completed_at: iso(e.now - 5 * 60_000) });
  };
  for (const pr of prs) {
    const head = commit(h(`head:${pr}`), [T0], [String(pr)]);
    W.pulls.set(pr, { number: pr, head, state: 'open', merged: false, updated: iso(NOW - 3_600_000 + pr), body: body(pr) });
    actions(head); // the PR's own CI on its head (pull_request)
    const id = W.nextCheck++; // stage 1 admitted it: App 5368905's kooyumi-work-admission on the head
    W.checks.set(id, { id, app: { id: APP }, name: 'kooyumi-work-admission', head_sha: head, status: 'completed', conclusion: 'success' });
  }
  const markMerged = () => { for (const p of W.pulls.values()) if (p.state === 'open' && ancestor(p.head, W.refs.get('heads/main'))) Object.assign(p, { state: 'closed', merged: true, mergeSha: W.refs.get('heads/main') }); };
  // GitHub (the checks port's reads, over this world)
  const gh = e.gh;
  gh.world.pulls.clear();
  Object.defineProperty(gh.world, 'main', { get: () => W.refs.get('heads/main'), set: () => {} });
  gh.readBranchHead = async () => ({ name: 'main', sha: W.refs.get('heads/main') });
  gh.readBranchRules = async () => ({ complete: true, branch: 'main', rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } },
    { type: 'non_fast_forward' }, { type: 'deletion' },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [
      ...['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot', 'kooyumi-train-landed'].map(context => ({ context, integration_id: APP })),
      { context: 'ci-suites', integration_id: ACTIONS }] } }] });
  gh.readPullRequest = async n => {
    const p = W.pulls.get(n), main = W.refs.get('heads/main');
    const testMerge = p.state === 'open' ? (ancestor(p.head, main) ? null : merge(main, p.head)) : null;
    return { number: n, state: p.state, draft: false, merged: p.merged, mergeable: p.state === 'open', merge_commit_sha: p.merged ? p.mergeSha : testMerge, body: p.body,
      head: { sha: p.head, ref: `topic-${n}`, repo: { full_name: REPO } }, base: { ref: 'main', sha: main, repo: { full_name: REPO } } };
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
  const queue = [...prs];
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
    claimScope: SCOPE, layerOfPaths: () => 'code', landing: e.port, trainLanding: e.trainLanding ?? CHAIN4 });
}
async function stage8(t, e, b, { trainLanding = { landing: 'push', batchMax: 4, unreadable: false }, mode = () => 'normal' } = {}) {
  e.now += 60_000;
  const claim = pr => ({ claimId: e.claimFor(pr), fence: 3, epoch: 1, expiresAt: iso(e.now + 3_600_000) });
  const jobs = batchJobsV2({ repo: REPO, pr: b.pr, headSha: b.headSha, baseSha: b.baseSha, testSha: b.testSha, sourceManifestSha256: SOURCE, createdAt: iso(e.now), attempt: b.attempt });
  e.journal ??= await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const publisher = createFixtureControlPublisherV2({ github: e.gh, journal: e.journal, trainMode: 'on', batchClaim: claimGeneration(claim(b.pr)), slotNative: e.native.port,
    sweepStore: e.store, greenLedger: e.ledger, pullsUpdatedSince: cursor => e.gh.readPullsUpdatedSince(cursor),
    admission: { async evaluatePr(job, packet, options) {
      const front = e.queue[0] === job.pr;
      options?.scheduling?.({ mergeQueue: { entered: e.queue.includes(job.pr), state: front ? 'head' : 'waiting', position: e.queue.indexOf(job.pr) + 1 }, claimExpiresAt: iso(e.now + 3_600_000) });
      const { observationSha256, ...base } = admittedFacts(job, claim(job.pr), packet, { domain: 'fixture', mergeQueueHead: front, batchClaim: options?.batchClaim, observedAt: e.now, slotUntil: e.now + 600_000 });
      const facts = { ...base, mode: { state: mode(job.pr), layer: 'code', policyVersion: 1 } };
      return { ...facts, observationSha256: digest(facts) };
    } },
    assertLive() {}, record() {}, authority: {}, clock: e.clock, sleep: e.sleep, trainLanding, landing: e.port });
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

test('push, fail closed: main without the fast-forward-only, no-deletion or train-only rule parks the batch (TRAIN_LANDING_RULES_MISSING)', async t => {
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
    assert.deepEqual([p.status, p.reason, p.sideEffects], ['BLOCKED', 'TRAIN_LANDING_RULES_MISSING', 0]);
    untouched(e, T); assert.equal(e.W.pushes.length, 0);
  });
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

// Field 2026-11-13: Native finishes a PR's Task binding only on adopt or return, and the holder releases its claim as soon as it
// merges, so a PR the holder merged (or closed) itself was never adopted and its binding stayed active for good (25 such rows were
// cleared by hand at 07:06Z). Stage 10 reads every bound PR of the holder; one GitHub has closed is ended with adopt or return.
test('field 2026-11-13: bound PRs merged or closed outside the train are adopted or returned by stage 10, the open one stays front', async t => {
  const e = await world(t, { prs: [910, 911, 912], sharedClaim: true });
  const returned = [];
  e.native.port.returnSlot = async i => { returned.push(i.pr); e.queue.splice(e.queue.indexOf(i.pr), 1); return { onDuty: true, returned: false, claims: [] }; };
  const W = e.W, M = W.merge(e.main(), e.head(910), ':holder');
  W.refs.set('heads/main', M);
  Object.assign(W.pulls.get(910), { state: 'closed', merged: true, mergeSha: M });
  Object.assign(W.pulls.get(912), { state: 'closed', merged: false });
  let batch = null;
  for (let i = 0; i < 6 && !batch; i++) batch = (await stage10(e)).facts.openFrontBatch;
  assert.deepEqual(e.adopted, [[910, M]]);
  assert.deepEqual(returned, [912]);
  assert.deepEqual(e.queue, [911]);
  assert.equal(batch?.pr, 911);
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
