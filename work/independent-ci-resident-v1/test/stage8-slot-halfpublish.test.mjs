// Stage 8: the merge slot lapses between the two control checks (DESIGN §28.6; TURING 2026-11-14, PR #1095 head a9e717d3).
// End to end: the Source's control publisher (fixture GitHub, fixture Native, a real effect journal), the stage outcome it writes,
// the stage code the Source maps it to, and the resident executor that acts on that code. Before the fix the pair wrote
// kooyumi-admission-verified, was refused kooyumi-merge-slot before its write (the slot had lapsed: zero effects), answered
// UNCERTAIN, and the executor halted the node. Now the pair never starts on a slot that cannot hold for both writes, and a half
// refused before its write after a settled half is a clean not-ready answer: the batch parks and the next try settles both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PARK_RETRY_MS } from '../src/executor.mjs';
import { batchJobsV2, claimGeneration } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { createFixtureControlPublisherV2, STAGE8_CHECK_MS } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';
import { outcomeFailureCode, outcomeFacts } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const S_HEAD = 'a'.repeat(40), S_BASE = 'b'.repeat(40), TREE = 'c'.repeat(40), TEST_MERGE = 'd'.repeat(40);
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const iso = ms => new Date(ms).toISOString();
const MIN = 60_000;

// main's rules (six checks pinned to 5368905, strict on, merge only) and GitHub's test merge of exactly [BASE, HEAD].
function fakeGithub(world) {
  const checks = []; let next = 100;
  const rules = [{ type: 'pull_request', rulesetId: 1, parameters: { allowed_merge_methods: ['merge'], required_approving_review_count: 0 } },
    { type: 'required_status_checks', rulesetId: 1, parameters: { strict_required_status_checks_policy: true, required_status_checks: SIX.map(context => ({ context, integration_id: 5368905 })) } }];
  const commits = { [S_HEAD]: { sha: S_HEAD, tree: TREE, parents: [S_BASE] }, [TEST_MERGE]: { sha: TEST_MERGE, tree: TREE, parents: [S_BASE, S_HEAD] } };
  return { fixture: true, checks,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, merge_commit_sha: TEST_MERGE, head: { sha: S_HEAD, repo: { full_name: REPO } }, base: { sha: S_BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readBranchRules(branch) { return { complete: true, branch, rules: structuredClone(rules) }; },
    async readGitCommit(sha) { if (!commits[sha]) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); return structuredClone(commits[sha]); },
    // The first write's read-back is where its time passes (after its own after-write observation, as on TURING).
    async readChecks(head) { if (world.written && world.onWrite) { const hook = world.onWrite; world.onWrite = null; hook(world); } return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { world.written = true; const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}

// One node's Source side: its clock, Native's merge slot for the claim, GitHub, and the control journal kept across tries.
async function sourceWorld(t, { slotLeftMs, onFirstWrite }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage8-halfpublish-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const world = { time: Date.parse('2026-11-14T19:30:00.000Z') };
  world.slotUntil = world.time + slotLeftMs;
  world.onWrite = onFirstWrite;
  const c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(world.time + 6 * 3600_000) };
  const jobs = batchJobsV2({ repo: REPO, pr: 888, headSha: S_HEAD, baseSha: S_BASE, testSha: S_HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(world.time - 3600_000), attempt: 1 });
  const github = fakeGithub(world);
  const journal = await EffectJournal.open(path.join(dir, 'effects'));
  // Native: the claim heads the queue while its slot holds (mergeQueueHead and the slot's until lapse together).
  const admission = { fixture: true, async evaluatePr(job, packet, opts = {}) {
    opts.scheduling?.({ mergeQueue: { entered: true, state: 'head', position: 1 }, claimExpiresAt: c.expiresAt });
    return admittedFacts(job, c, packet, { domain: 'fixture', mergeQueueHead: world.slotUntil > world.time, slotUntil: world.slotUntil, batchClaim: opts.batchClaim, observedAt: world.time });
  } };
  const pair = [jobs['control-admission'], jobs['control-merge-slot']];
  // Stage 8 as the resident runs it: the pair, the outcome file, the code; SETTLED is the stage's success.
  world.stage8 = async () => {
    const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c),
      clock: () => world.time, sleep: async ms => { world.time += ms; } });
    const result = await pub.publishPair(pair, { waitUntil: world.time + STAGE8_CHECK_MS });
    world.last = result;
    if (result.status === 'SETTLED') return { ok: true, factsSha256: 'd'.repeat(64) };
    const outcome = await writeOutcome({ receiptsRoot: path.join(dir, 'receipts'), nonce: randomBytes(16).toString('hex'), plan: { stage: 8, entryRole: 'control-checks' },
      jobIds: pair.map(j => j.id), result, clock: () => world.time });
    return { ok: false, code: outcomeFailureCode(outcome, 8), proof: WINDOWS_CLEAN, brokerNoLaunch: false, outcome: outcomeFacts(outcome) };
  };
  world.github = github;
  // The slot lapsed and the claim joined the queue again (claim-assist): a new slot of 45 minutes at the head.
  world.newSlot = () => { world.slotUntil = world.time + 45 * MIN; };
  return world;
}

function residentWith(world) {
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 ? (engine.calls.push(['stage', 8]), world.stage8()) : base(batch, stage, o));
  return engine;
}

async function runToEnd(t, world, writtenAfterFirstTry) {
  const f = await executorFixture(t, { engine: residentWith(world) });
  await f.drop(triggerBytes());
  const first = await f.exec.tick();
  assert.notEqual(first.state, 'HALTED', `the first try must not halt the node: ${JSON.stringify(world.last)}`);
  assert.equal(await f.ledger.halted(), null);
  assert.equal(first.state, 'PARKED', JSON.stringify(first));
  assert.equal(first.reason, 'RESIDENT_QUEUE_HEAD_NOT_REACHED');
  assert.deepEqual(world.github.checks.map(c => c.name), writtenAfterFirstTry);
  world.newSlot();
  f.advance(PARK_RETRY_MS[0]);
  const second = await f.exec.tick();
  assert.equal(second.state, 'COMPLETED', JSON.stringify([second, world.last]));
  assert.equal(await f.ledger.halted(), null);
  return { first, second };
}

test('slot with 10 s left and a first write that takes 20 s: nothing is half published, the next try settles both, no HALT', async t => {
  const world = await sourceWorld(t, { slotLeftMs: 10_000, onFirstWrite: w => { w.time += 20_000; } });
  // The slot cannot hold for both writes: the first try writes nothing at all.
  await runToEnd(t, world, []);
  assert.deepEqual(world.github.checks.map(c => [c.name, c.conclusion]), [['kooyumi-admission-verified', 'success'], ['kooyumi-merge-slot', 'success']],
    'exactly one pair, written on the new slot; no half and no revocation');
});

test('slot lost right after the first half settled: a clean not-ready answer, the retry reads the settled half back and writes only the second', async t => {
  // The slot holds for the whole reserve when the pair starts and is gone at the first write (returned or lapsed by Native).
  const world = await sourceWorld(t, { slotLeftMs: 45 * MIN, onFirstWrite: w => { w.time += 20_000; w.slotUntil = w.time - 1; } });
  await runToEnd(t, world, ['kooyumi-admission-verified']);
  assert.deepEqual(world.github.checks.map(c => [c.name, c.conclusion]), [['kooyumi-admission-verified', 'success'], ['kooyumi-merge-slot', 'success']],
    'the settled half is not written again and never revoked');
});
