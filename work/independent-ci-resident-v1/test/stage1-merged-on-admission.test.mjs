// Field defect 2026-11-23 (PR #1238 on TURING 23:57:28, PR #1239 on DESK 00:21:05; FABLE-resident-halt-merge-race-20261123 A): the
// resident's stage-1 success (kooyumi-work-admission) was the PR's last required check, so GitHub's auto-merge merged the PR 4-5 s
// later. The verification after the write then failed (Native: full_admission_rejected, the PR is not open any more), stage 1 went to
// withdraw its check, the PATCH landed but its confirmation threw, the stage ended UNCERTAIN and the resident HALTed with
// PUBLICATION_UNCERTAIN: one node, then (after the watchdog handed the role over) the other. End to end here: the real Source stage-1
// publisher, its outcome through the real stage-fact mapping, into the real resident executor.
//   - A PR merged at exactly this head on this batch's base is the ending the green was for: stage 1 is SETTLED, nothing is withdrawn.
//   - No HALT; the next PR opens its batch as usual.
//   - How the merged PR's own batch ends is the second test, a TODO: the design expects FAILED_CLEAN / SUPERSEDED_AT_SAFE_POINT at
//     before-relay-plan with no change to the resident, but the executor counts stage 1 as the batch's first live read
//     (executor.mjs, "Stage 1's admission just read the PR open at this head"), so no live read is due there for
//     SUPERSEDE_LIVE_READ_MS and the batch goes on to its next stages. Planning decided (follow-up 2026-11-23 section 1): the executor
//     safe-point change is its own PR and turns this TODO into a real case; nothing on this branch changes the executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../../actions-hosted-migration/independent-ci-v1/src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { admittedFacts, tempDir } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { BASE, HEAD, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, triggerBytes } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const NEXT_PR = 885, NEXT_HEAD = '7'.repeat(40), LANDED = 'e'.repeat(40), TREE = 'c'.repeat(40);

// GitHub with auto-merge on PR 884: the moment its kooyumi-work-admission success is written, the PR is merged at HEAD on BASE.
// The withdrawal behaves as in the field: the PATCH lands, its answer is lost.
function github() {
  const checks = [], merged = new Set(), commits = {}, heads = { 884: HEAD, [NEXT_PR]: NEXT_HEAD }; let next = 1000, revokes = 0;
  return { fixture: true, checks, merged, get revokes() { return revokes; },
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) {
      return { number: n, ...(merged.has(n) ? { state: 'closed', merged: true, mergeable: null, merge_commit_sha: LANDED } : { state: 'open', merged: false, mergeable: true, merge_commit_sha: null }),
        head: { sha: heads[n], repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } };
    },
    async readGitCommit(sha) { if (!commits[sha]) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); return structuredClone(commits[sha]); },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async readAppChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head && c.app.id === APP).map(c => structuredClone(c)) }; },
    async createCheck(body) {
      const c = { id: next++, app: { id: APP }, ...structuredClone(body) }; checks.push(c);
      if (c.name === 'kooyumi-work-admission' && c.head_sha === HEAD) { merged.add(884); commits[LANDED] = { sha: LANDED, tree: TREE, parents: [BASE, HEAD] }; }
      return structuredClone(c);
    },
    async revokeCheck(id, body) { revokes++; Object.assign(checks.find(x => x.id === id), structuredClone(body)); throw Object.assign(new Error('github_timeout'), { code: 'github_timeout' }); } };
}

// A resident whose stage 1 is the real Source publisher. Native admits an open PR and rejects one that is not open any more.
async function node(t, gh) {
  const dir = await tempDir(t);
  const batchClaims = { read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at) => recordBatchClaim(dir, j, c, at) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const claims = new Map();
  const admission = { fixture: true, async evaluatePr(job, packet) {
    if (gh.merged.has(job.pr)) return { contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason: 'full_admission_rejected' };
    if (!claims.has(job.pr)) claims.set(job.pr, { claimId: randomUUID(), fence: 37, epoch: 1, expiresAt: iso(Date.now() + 3600_000) });
    return admittedFacts(job, claims.get(job.pr), packet, { domain: 'fixture', slotUntil: Date.now() + 3600_000 });
  } };
  const pub = createFixtureWorkAdmissionPublisherV2({ github: gh, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims, sleep: async () => {} });
  const engine = fakeEngine(), subjects = new Map(), derive = engine.derive, run = engine.runStage, results = [];
  engine.derive = async (subject, key, chain) => { subjects.set(key, subject); return derive(subject, key, chain); };
  engine.runStage = async (batch, stage, o) => {
    if (stage.number !== 1) return run(batch, stage, o);
    engine.calls.push(['stage', 1]);
    const s = subjects.get(batch.key);
    const jobs = batchJobsV2({ repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, testSha: s.headSha, sourceManifestSha256: s.sourceManifestSha256, createdAt: iso(Date.now() - MIN), attempt: s.attempt });
    const r = await pub.publish(jobs['work-admission']);
    results.push(r);
    if (r.status === 'SETTLED') return { ok: true, factsSha256: 'd'.repeat(64), outcome: { status: 'SETTLED', reason: null, sideEffects: r.sideEffects, mayHavePublished: true } };
    // stage-inputs.mjs#writeOutcome: anything but a clean BLOCKED with zero side effects may have published.
    const outcome = { status: r.status, reason: r.reason ?? null, sideEffects: r.sideEffects, mayHavePublished: !(r.status === 'BLOCKED' && r.sideEffects === 0), safeToRerun: r.safeToRerun === true, diagnostic: null, scheduling: null };
    return { ok: false, code: outcomeFailureCode(outcome, 1), proof: WINDOWS_CLEAN, outcome, brokerNoLaunch: false };
  };
  // The companion's live PR read (the safe points' input).
  const companion = fakeCompanion({ pull: pr => (gh.merged.has(pr) ? { number: pr, state: 'closed', headSha: HEAD } : { number: pr, state: 'open', headSha: pr === 884 ? HEAD : NEXT_HEAD }) });
  const f = await executorFixture(t, { engine, companion });
  return { f, results, stages: () => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]) };
}

async function mergedRun(t) {
  const gh = github();
  const n = await node(t, gh);
  await n.f.drop(triggerBytes());
  const r = await n.f.exec.tick();
  return { gh, n, r };
}

test("#1238/#1239: stage 1's green merges the PR: SETTLED, nothing withdrawn, no HALT, and the next PR opens its batch", async t => {
  const { gh, n, r } = await mergedRun(t);
  assert.equal(await n.f.ledger.halted(), null, `the resident is not HALTed: ${JSON.stringify(r)}; stage 1: ${JSON.stringify(n.results[0])}`);
  assert.deepEqual([n.results[0].status, n.results[0].settledMerged, n.results[0].reason], ['SETTLED', true, undefined], `stage 1: ${JSON.stringify(n.results[0])}`);
  assert.equal(gh.revokes, 0, "the merged PR's green is never withdrawn");
  assert.deepEqual(gh.checks.map(c => [c.name, c.head_sha, c.conclusion]), [['kooyumi-work-admission', HEAD, 'success']]);
  // The next PR is taken as usual.
  await n.f.drop(triggerBytes({ pr: NEXT_PR, headSha: NEXT_HEAD }));
  const next = await n.f.exec.tick();
  assert.equal(next.state, 'COMPLETED', JSON.stringify(next));
  assert.deepEqual(gh.checks.filter(c => c.head_sha === NEXT_HEAD).map(c => [c.name, c.conclusion]), [['kooyumi-work-admission', 'success']]);
  assert.equal(await n.f.ledger.halted(), null);
});

test("design A item 2: the merged PR's batch ends SUPERSEDED_AT_SAFE_POINT at before-relay-plan, nothing after stage 1 runs",
  { todo: 'fixed by the executor safe-point change (its own PR, FABLE-resident-halt-merge-race-followup-20261123 section 1): the executor counts stage 1 as the first live read, so no read is due at before-relay-plan' }, async t => {
    const { n, r } = await mergedRun(t);
    assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', 'SUPERSEDED_AT_SAFE_POINT', 'before-relay-plan'], JSON.stringify(r));
    assert.deepEqual(n.stages(), [1], 'nothing after stage 1 ran for the merged PR');
  });
