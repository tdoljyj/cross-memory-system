// Units of push mode (resident ADR 0018): the stage file, the shape of S, the other-App checks on S, which way to land (three ways,
// Fable 2026-11-20) and the rehearsal on S, composing and bisecting, the one write to main, the landing port's token and refs, the
// landing records, and the never-published check.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tempDir } from './resident-v2-fixtures.mjs';
import * as L from '../src/independent-control-checks-v2/train-landing.mjs';
import { createLandingPort, LANDING_PERMISSIONS } from '../src/independent-control-checks-v2/train-landing-port.mjs';
import { TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { requiredCheckFailure, rulesetFacts, TRAIN_ONLY_CHECK as RULES_TRAIN_ONLY, REQUIRED_CHECK_NAMES } from '../src/independent-control-checks-v2/train-rules.mjs';
import { requiredOnHead } from '../src/independent-control-checks-v2/train-facts.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { parseLandingArg, prepareStageDirectory } from '../src/resident-v2/invoke-stage.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { SCAFFOLD_RULESET, checkRun, mainRules, portRules, s7Green, scaffoldRules } from './s7-rules-fixture.mjs';

import { multiDutyClock, multiDutyGitHub } from '../../../independent-ci-resident-v1/test/multi-duty-fixture.mjs';
import { TRAIN_PROTOCOL_VERSION, TRAIN_REQUIRED_RUN_FIELDS, trainBatchKey, trainEffectKey, trainLandingSlotKey } from '../src/merge-train-v2-contract.mjs';
import { createFixtureControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';

const sha = n => n.toString(16).padStart(40, '0');
const T = sha(1), H1 = sha(2), H2 = sha(3), H3 = sha(4), S1 = sha(5), S2 = sha(6), S3 = sha(7);
const APP = 5368905, REPO = 'tdoljyj/cross-memory-system';

const scope = { tenantId: 'tenant', projectId: 'project', repositoryId: 11, targetBranch: 'main' };
const members = [
  { pr: 30, headSha: H1, claimId: 'front', fence: 2, epoch: 3 },
  { pr: 31, headSha: H2, claimId: 'rider', fence: 4, epoch: 5 },
  { pr: 32, headSha: H3, claimId: 'third', fence: 6, epoch: 7 },
];
const G = sha(20), DONE = sha(21), CANCEL = sha(22);
const batchId = trainBatchKey({ ...scope, baseSha: T, members, sourceSha256: 'a'.repeat(64), policyVersion: 'test' });
const effectId = trainEffectKey({ ...scope, action: 'landing_send', subject: [batchId, 1, G, T, S3] });
const slotId = trainLandingSlotKey(scope);

test('列车 v2：第 8 段只消费一次 Native 发送权，重启从共享回执续办', async t => {
  const w = { intent: { batchId, effectId, slotId, generation: 1, baseSha: T, testSha: S3,
    generationRefOid: G, landedRefOid: DONE, members, expiresAt: '2026-11-26T09:01:30Z' },
    clock: multiDutyClock(Date.parse('2026-11-26T09:00:00Z')) };
  const remote = multiDutyGitHub(w.clock);
  let main = T, generation = G, allowLand = false;
  const mainWrites = () => remote.totals().mainUpdates;
  w.port = {
    readTrainRefs: async () => ({ mainSha: main, generationRefOid: generation, stagingSha: S3 }),
    landIntent: async () => {
      assert.ok(allowLand);
      return remote.write('land', () => { main = S3; generation = DONE; }, () => ['mainUpdates', S3, 'B']);
    },
  };
  const batch = { ...w.intent, scope, steps: [S1, S2, S3], testTree: sha(60), sourceSha256: 'a'.repeat(64), policyVersion: 'test' };
  const { rules, rulesets } = s7State();
  let inventory = s7Green(S3), qualified = false, sent = 0;
  const verified = [];
  const byPlatform = name => name.includes('windows') ? 'windows' : 'linux';
  const providerChecks = structuredClone(inventory.filter(check => check.app.id === 15368));
  const linux = 800, windows = 801, hosted = 802;
  const nativeRunId = name => name.startsWith('hosted-') ? hosted : byPlatform(name) === 'windows' ? windows : linux;
  const register = check => ({
    testSha: S3, checkName: check.name, platform: byPlatform(check.name), policyVersion: batch.policyVersion,
    runId: nativeRunId(check.name), attempt: 1,
  });
  // A observes the original launches and writes the slice-0 tuples; B can
  // recover them solely from the shared batch, even inside a fresh publisher.
  const sharedRuns = providerChecks.map(register);
  assert.ok(sharedRuns.every(run => TRAIN_REQUIRED_RUN_FIELDS.every(field => Object.hasOwn(run, field))));
  for (const runId of new Set(sharedRuns.map(run => run.runId))) remote.count('requiredRuns', { testSha: S3, runId }, 'A');
  let providerProof = false, trustedWorkflow = true, nativeAttempt = 1, bisected = 0;
  const sharedBisections = new Set();
  const trainV2 = {
    protocolVersion: TRAIN_PROTOCOL_VERSION,
    readBatch: async () => ({ ...structuredClone(batch), requiredRuns: structuredClone(sharedRuns) }),
    async bisectBatch({ batch: observed, evidenceDigest }) {
      assert.equal(observed.batchId, batchId);
      assert.equal(observed.testSha, S3);
      assert.match(evidenceDigest, /^[a-f0-9]{64}$/);
      if (!sharedBisections.has(observed.testSha)) {
        sharedBisections.add(observed.testSha);
        bisected++;
      }
    },
    atomicLandingQualified: async () => qualified,
    readRuleBypass: async ({ rulesetId }) => rulesetId === FF_RS ? [] : [{ actor_id: APP, actor_type: 'Integration', bypass_mode: 'always' }],
    verifyMember: async ({ member }) => { verified.push(member); return true; },
    prepareLanding: async () => { assert.ok(allowLand); return { state: 'reserved', intent: w.intent }; },
    async authorizeLandingSend(intent) {
      assert.deepEqual(intent, w.intent);
      sent++;
      batch.landing = { state: 'sent', intent };
      return true;
    },
    async reconcileLanding({ intent, result }) {
      assert.equal(result.state, 'landed');
      batch.landing = { state: 'settled', intent, receipt: { receiptId: 'landed-receipt', intent, generationRefOid: DONE } };
      return { state: 'settled', effectId: intent.effectId };
    },
  };
  const github = {
    readBranchRules: async branch => ({ complete: true, branch, rules }),
    readRuleset: async id => rulesets.get(id),
    readGitCommit: async sha => ({ sha, tree: batch.testTree,
      parents: new Map([[S1, [T, H1]], [S2, [S1, H2]], [S3, [S2, H3]]]).get(sha) }),
    readPullRequest: async pr => ({ number: pr, state: 'open', draft: false,
      head: { sha: members.find(m => m.pr === pr).headSha, repo: { full_name: REPO } },
      base: { sha: T, ref: 'main', repo: { full_name: REPO } } }),
    readChecks: async sha => { assert.equal(sha, S3); return { complete: true, checks: inventory }; },
    async readTrainRun({ runId, attempt, testSha, workflow }) {
      assert.equal(testSha, S3);
      assert.equal(workflow, ({
        [linux]: '.github/workflows/clued-required-tests.yml',
        [windows]: '.github/workflows/clued-required-tests-windows.yml',
        [hosted]: '.github/workflows/hosted-required.yml',
      })[runId]);
      if (attempt !== nativeAttempt) return null;
      return { jobs: providerChecks.filter(check => nativeRunId(check.name) === runId)
        .map(check => ({ ...check, checkRunId: check.id, steps: check.name === 'ci-suites' && providerProof
          ? [{ name: 'Confirm merge train test failure', status: 'completed', conclusion: 'success' }] : [] })) };
    },
    sameTrainWorkflow: async () => trustedWorkflow,
  };
  const run = () => createFixtureControlPublisherV2({ github, journal: {}, admission: {}, assertLive() {}, record() {}, trainV2,
    clock: w.clock.now, landing: w.port, trainMode: 'on', trainLanding: { landing: 'push' } }).publishPair(
    ['control-admission', 'control-merge-slot'].map(role => makeJobV2({ repo: REPO, pr: members[0].pr, headSha: H1,
      baseSha: T, testSha: S3, role, sourceManifestSha256: batch.sourceSha256, createdAt: batch.expiresAt, attempt: 1 })),
    { waitUntil: Date.parse(batch.expiresAt) });
  assert.equal((await run()).reason, L.TRAIN_LANDING_RULES_MISSING);
  qualified = true;
  const full = inventory;
  const missing = inventory.find(r => r.name === 'ci-suites');
  inventory = [...full.filter(r => r !== missing),
    checkRun(1000, missing.name, APP, S3), checkRun(1001, missing.name, missing.app.id, H1)];
  assert.equal((await run()).reason, L.TRAIN_LANDING_CHECKS_PENDING);
  assert.equal(sent, 0);
  assert.deepEqual(verified, members);
  const failed = { ...missing, conclusion: 'failure', completed_at: '2026-11-26T08:50:00Z' };
  const ordinary = [{ annotation_level: 'failure', title: 'Merge train test failure', message: `source-v2-node ${S3}` }];
  github.readCheckAnnotations = async () => ordinary;
  for (const [name, check] of [
    ['skipped check', { ...failed, conclusion: 'skipped' }],
    ['cancelled check', { ...failed, conclusion: 'cancelled' }],
    ['timed-out check', { ...failed, conclusion: 'timed_out' }],
    ['failure with a forged job annotation', failed],
    ['green from a different workflow run', { ...missing, id: 1900 }],
  ]) await t.test(name, async () => {
    inventory = [...full.filter(r => r !== missing), check];
    const providerCheck = providerChecks.find(check => check.id === missing.id);
    providerCheck.conclusion = check.conclusion;
    assert.equal((await run()).reason, L.TRAIN_LANDING_CHECKS_PENDING);
    assert.equal(sent, 0);
    assert.equal(mainWrites(), 0);
    assert.equal(bisected, 0);
    providerCheck.conclusion = 'success';
  });
  await t.test('shared registration cannot advance to a new attempt without a receipt', async () => {
    inventory = full;
    nativeAttempt = 2;
    assert.equal((await run()).reason, L.TRAIN_LANDING_CHECKS_PENDING);
    nativeAttempt = 1;
  });
  await t.test('stable red needs a trusted workflow and one shared bisection receipt', async () => {
    inventory = [...full.filter(r => r !== missing), failed];
    const providerCheck = providerChecks.find(check => check.id === missing.id);
    providerCheck.conclusion = 'failure';
    providerProof = true;
    trustedWorkflow = false;
    assert.equal((await run()).reason, L.TRAIN_LANDING_CHECKS_PENDING);
    assert.equal(bisected, 0);
    trustedWorkflow = true;
    assert.equal((await run()).reason, L.TRAIN_LANDING_CHECK_FAILED);
    assert.equal((await run()).reason, L.TRAIN_LANDING_CHECK_FAILED);
    assert.equal(bisected, 1);
    assert.equal(mainWrites(), 0);
    providerCheck.conclusion = 'success';
    providerProof = false;
  });
  inventory = full;
  allowLand = true;
  remote.arm('land', { loseReply: true });
  assert.equal((await run()).status, 'SETTLED');
  batch.generation++;
  generation = CANCEL;
  assert.equal((await run()).status, 'SETTLED');
  assert.equal(sent, 1);
  assert.equal(mainWrites(), 1);
  assert.equal(remote.totals().requiredRuns, 3);
});

test('stage file: exact bytes, defaults, refusals; only push may carry a batch; one PR per batch unless the stage file says the chain is installed', async t => {
  assert.equal(L.stageTrainLandingText({ landing: 'push', batchMax: 3 }), '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3}');
  assert.throws(() => L.stageTrainLandingText({ landing: 'github-merge', batchMax: 2 }), /TRAIN_LANDING_REFUSED/);
  assert.throws(() => L.stageTrainLandingText({ landing: 'push', batchMax: 5 }), /TRAIN_LANDING_REFUSED/);
  assert.deepEqual(L.parseStageTrainLanding(null), { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: false });
  assert.deepEqual(L.parseStageTrainLanding(Buffer.from(L.stageTrainLandingText({ landing: 'push', batchMax: 4 }))), { landing: 'push', batchMax: 4, batchChain: false, unreadable: false });
  for (const bad of ['{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":4}\n', '{"landing":"push"}', 'x', '{"contract":"clued.independent-ci.stage-train-landing/1","batchMax":4,"landing":"push"}'])
    assert.deepEqual(L.parseStageTrainLanding(Buffer.from(bad)), { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: true }, bad);
  const dir = await tempDir(t);
  assert.deepEqual(await L.readStageTrainLandingFact(dir), { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: false });
  await fs.writeFile(path.join(dir, L.STAGE_TRAIN_LANDING_FILE), 'broken');
  assert.equal((await L.readStageTrainLandingFact(dir)).unreadable, true);
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4 }), 1, 'one PR per batch unless the stage file says the chain is installed');
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4, batchChain: false }), 1);
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4, batchChain: true }), 4);
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4, batchChain: true, unreadable: true }), 1);
  assert.equal(L.effectiveBatchMax({ landing: 'github-merge', batchMax: 1, batchChain: true }), 1);
  // the invoker: --train-landing <landing>:<n>, written for stages 8 and 10 only
  assert.deepEqual(parseLandingArg('push:4'), { landing: 'push', batchMax: 4, batchChain: false });
  assert.equal(parseLandingArg(undefined), null);
  assert.throws(() => L.landingSettings(parseLandingArg('push:0')), /TRAIN_LANDING_REFUSED/);
  const root = await tempDir(t), sealed = { files: { 'formal-service-entry.json': Buffer.from('{}'), 'jobs.json': Buffer.from('[]') } };
  const stageDir = await prepareStageDirectory({ stageRoot: root, nonce: 'a'.repeat(32), sealed, trainLanding: { landing: 'push', batchMax: 2 } });
  assert.deepEqual(await L.readStageTrainLandingFact(stageDir), { landing: 'push', batchMax: 2, batchChain: false, unreadable: false });
});

test('ADR 0019 stage file: batchChain (the resident found /4 installed) is written only when true, only in push mode, and is what lets stage 10 batch', async t => {
  const chain = L.stageTrainLandingText({ landing: 'push', batchMax: 3, batchChain: true });
  assert.equal(chain, '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3,"batchChain":true}');
  assert.equal(L.stageTrainLandingText({ landing: 'push', batchMax: 3, batchChain: false }), L.stageTrainLandingText({ landing: 'push', batchMax: 3 }), 'no chain: the bytes of before ADR 0019');
  assert.deepEqual(L.parseStageTrainLanding(Buffer.from(chain)), { landing: 'push', batchMax: 3, batchChain: true, unreadable: false });
  assert.equal(L.effectiveBatchMax(L.parseStageTrainLanding(Buffer.from(chain))), 3);
  for (const bad of [{ landing: 'github-merge', batchMax: 1, batchChain: true }, { landing: 'push', batchMax: 3, batchChain: 'yes' }, { landing: 'push', batchMax: 3, batchChain: 1 }])
    assert.throws(() => L.stageTrainLandingText(bad), /TRAIN_LANDING_REFUSED/, JSON.stringify(bad));
  for (const bad of ['{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3,"batchChain":false}',
    '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"github-merge","batchMax":1,"batchChain":true}',
    '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchChain":true,"batchMax":3}']) {
    const r = L.parseStageTrainLanding(Buffer.from(bad));
    assert.deepEqual(r, { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: true }, bad);
    assert.equal(L.effectiveBatchMax(r), 1, 'a file that cannot be read: one PR per batch');
  }
  // the invoker's argument: ':chain' only after push:<n>; github-merge with it is refused before anything is written
  assert.deepEqual(parseLandingArg('push:3:chain'), { landing: 'push', batchMax: 3, batchChain: true });
  for (const bad of ['push:3:chain:chain', 'push:3:Chain', 'push:3chain', 'push::chain']) assert.throws(() => L.landingSettings(parseLandingArg(bad)), /TRAIN_LANDING_REFUSED/, bad);
  assert.throws(() => L.landingSettings(parseLandingArg('github-merge:1:chain')), /TRAIN_LANDING_REFUSED/);
  const root = await tempDir(t), sealed = { files: { 'formal-service-entry.json': Buffer.from('{}'), 'jobs.json': Buffer.from('[]') } };
  const stageDir = await prepareStageDirectory({ stageRoot: root, nonce: 'b'.repeat(32), sealed, trainLanding: parseLandingArg('push:3:chain') });
  assert.equal(await fs.readFile(path.join(stageDir, L.STAGE_TRAIN_LANDING_FILE), 'utf8'), chain);
  assert.deepEqual(await L.readStageTrainLandingFact(stageDir), { landing: 'push', batchMax: 3, batchChain: true, unreadable: false });
  // the literals the resident looks for before it ever sends ':chain' (engine-windows.mjs BATCH_CHAIN_SOURCE_MARKERS)
  const v2 = name => new URL(`../src/resident-v2/${name}`, import.meta.url);
  assert.ok((await fs.readFile(v2('build-bundle.ps1'), 'utf8')).includes("$ChainContract='clued.independent-ci.resident-batch-descriptor/4'"));
  assert.ok((await fs.readFile(v2('prepare-workspaces.py'), 'utf8')).includes("DESCRIPTOR_CHAIN_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/4'"));
  assert.ok((await fs.readFile(v2('invoke-stage.mjs'), 'utf8')).includes("export const TRAIN_LANDING_CHAIN_ARG = 'chain';"));
});

test('batchChainOk: one member is exactly [T, H]; several walk first parents back to T with each head as a second parent, in order', () => {
  const one = new Map([[S1, { sha: S1, tree: sha(9), parents: [T, H1] }]]);
  assert.equal(L.batchChainOk({ commits: one, baseSha: T, heads: [H1], testSha: S1 }), true);
  assert.equal(L.batchChainOk({ commits: one, baseSha: sha(8), heads: [H1], testSha: S1 }), false);
  const chain = new Map([[S1, { sha: S1, parents: [T, H1] }], [S2, { sha: S2, parents: [S1, H2] }], [S3, { sha: S3, parents: [S2, H3] }]]);
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H1, H2, H3], testSha: S3 }), true);
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H1, H3, H2], testSha: S3 }), false, 'order matters');
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H2, H3], testSha: S3 }), false, 'a member left out');
  chain.set(S2, { sha: S2, parents: [S1, H2, sha(10)] });
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H1, H2, H3], testSha: S3 }), false, 'an octopus is not a chain step');
});

test('ADR 0019 review 3: readBatchChain with the train\'s own merge results: each step must be exactly the commit that merge returned', async () => {
  const commits = new Map([[S1, { sha: S1, tree: sha(11), parents: [T, H1] }], [S2, { sha: S2, tree: sha(12), parents: [S1, H2] }], [S3, { sha: S3, tree: sha(13), parents: [S2, H3] }]]);
  const read = async s => { const c = commits.get(s); if (!c) throw new Error('404'); return structuredClone(c); };
  const heads = [H1, H2, H3];
  assert.deepEqual(await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3 }), { ok: true, tree: sha(13) });
  assert.deepEqual(await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3, steps: [S1, S2, S3] }), { ok: true, tree: sha(13) });
  // someone moved staging.tmp between two merges: step 1 is another commit of the same shape ([T, H1]) than the one the merge returned
  const E = sha(20);
  commits.set(E, { sha: E, tree: sha(21), parents: [T, H1] });
  commits.set(S2, { sha: S2, tree: sha(12), parents: [E, H2] });
  assert.equal((await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3 })).ok, true, 'the shape alone cannot tell');
  assert.deepEqual(await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3, steps: [S1, S2, S3] }), { ok: false, tree: null });
  assert.equal((await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3, steps: [E, S2] })).ok, false, 'one step per member');
});

test('externalChecksDecision: the newest run by id of each other-App required check on the commit decides; the train-own checks are not looked at', () => {
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gitleaks', integration_id: APP }, { context: 'ci-suites', integration_id: 15368 },
    { context: 'migration-verify', integration_id: 15368 }] } }];
  const run = (id, name, conclusion, o = {}) => ({ id, name, head_sha: S1, app: { id: 15368 }, status: 'completed', conclusion, ...o });
  const d = checks => L.externalChecksDecision({ rules, inventory: { complete: true, checks }, commitSha: S1, appId: APP });
  assert.equal(d([run(1, 'ci-suites', 'success'), run(2, 'migration-verify', 'success')]), null);
  assert.equal(d([run(1, 'ci-suites', 'success')]), L.TRAIN_LANDING_CHECKS_PENDING, 'missing');
  assert.equal(d([run(1, 'ci-suites', 'success'), run(2, 'migration-verify', null, { status: 'in_progress' })]), L.TRAIN_LANDING_CHECKS_PENDING);
  assert.equal(d([run(1, 'ci-suites', 'success'), run(2, 'migration-verify', 'failure')]), L.TRAIN_LANDING_CHECK_FAILED);
  assert.equal(d([run(3, 'ci-suites', 'failure'), run(4, 'ci-suites', 'success'), run(2, 'migration-verify', 'success')]), null, 'a newer rerun wins');
  assert.equal(d([run(5, 'ci-suites', 'failure'), run(4, 'ci-suites', 'success'), run(2, 'migration-verify', 'success')]), L.TRAIN_LANDING_CHECK_FAILED, 'the newest decides');
  assert.equal(d([run(1, 'ci-suites', 'success', { app: { id: 999 } }), run(2, 'migration-verify', 'success')]), L.TRAIN_LANDING_CHECKS_PENDING, 'another App cannot stand in');
  assert.equal(d([run(1, 'ci-suites', 'success', { head_sha: H1 }), run(2, 'migration-verify', 'success')]), L.TRAIN_LANDING_CHECKS_PENDING, 'another commit cannot stand in');
  assert.equal(L.externalChecksDecision({ rules, inventory: { complete: false, checks: [] }, commitSha: S1, appId: APP }), L.TRAIN_LANDING_CHECKS_PENDING);
});

test('N9: only the newest verdict on S counts; inconclusive checks do not fail the batch', () => {
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'migration-verify', integration_id: 15368 }] } }];
  const now = Date.parse('2026-11-18T10:00:00Z');
  const run = (id, conclusion, completedAt = '2026-11-18T09:00:00Z') => ({
    id, name: 'migration-verify', head_sha: S1, app: { id: 15368 }, status: 'completed', conclusion, completed_at: completedAt,
  });
  const d = checks => L.externalChecksDecision({ rules, inventory: { complete: true, checks }, commitSha: S1, appId: APP, now });
  for (const conclusion of ['cancelled', 'timed_out', 'stale', 'startup_failure']) {
    assert.equal(d([run(1, 'success'), run(2, conclusion)]), L.TRAIN_LANDING_CHECKS_PENDING, conclusion);
    assert.equal(d([run(1, conclusion), run(2, 'success')]), null, conclusion);
  }
  assert.equal(d([run(1, 'failure', '2026-11-18T09:55:00.001Z')]), L.TRAIN_LANDING_CHECKS_PENDING);
  assert.equal(d([run(1, 'failure', '2026-11-18T09:55:00.000Z')]), L.TRAIN_LANDING_CHECK_FAILED);
});

// Fable 2026-11-20 三态选路 (补：可绕过字段读不到时, the last word): landingRoute reads main's rules (GET /rules/branches/main, each rule
// with its ruleset) and this App's own bypass of each of those rulesets (GET /rulesets/{id}: current_user_can_bypass). Without
// kooyumi-train-landed the current path, whatever the bypass state; with it push only when every push condition reads back true.
const MAIN_RS = 24182890, FF_RS = 27500001, ACTIONS = 15368;
const FOUR = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
function ruleState({ independent = true, trainLanded = true, mainCan = 'always', ffCan = 'never', trainApp = APP } = {}) {
  const checks = [...REQUIRED_CHECK_NAMES.map(context => ({ context, integration_id: APP })), ...(trainLanded ? [{ context: L.TRAIN_ONLY_CHECK, integration_id: trainApp }] : []),
    ...FOUR.map(context => ({ context, integration_id: ACTIONS }))];
  const rules = [{ type: 'deletion', rulesetId: MAIN_RS, parameters: null }, { type: 'non_fast_forward', rulesetId: MAIN_RS, parameters: null },
    { type: 'pull_request', rulesetId: MAIN_RS, parameters: { allowed_merge_methods: ['merge'] } },
    { type: 'required_status_checks', rulesetId: MAIN_RS, parameters: { strict_required_status_checks_policy: true, required_status_checks: checks } },
    ...(independent ? [{ type: 'deletion', rulesetId: FF_RS, parameters: null }, { type: 'non_fast_forward', rulesetId: FF_RS, parameters: null }] : [])];
  const rulesets = new Map([[MAIN_RS, { id: MAIN_RS, currentUserCanBypass: mainCan }], ...(independent ? [[FF_RS, { id: FF_RS, currentUserCanBypass: ffCan }]] : [])]);
  return { rules, rulesets, appId: APP };
}
const TODAY = { independent: false, trainLanded: false, mainCan: 'never' };
const route = (o, input = ruleState(o)) => { const r = L.landingRoute(input); return [r.route, r.missing, r.bypass]; };

// Fable 11-21 T5: the rules after C (kooyumi-train-landed pinned to this App, the independent ruleset) through the rule readers of stage 8
// and 10. kooyumi-train-landed is never published: the landing gate (requiredCheckFailure) never counts it failed. requiredOnHead is the
// current path's (GitHub merges, and GitHub requires it like any other: test/train-front-required-rerun.test.mjs "never green"); it is not
// read off that path (frontPullFacts builds no front.required for push or park: train-facts.test.mjs 应修 1), so under C it stops nothing.
// The resident's readers (the PR page, the re-run lane, the merge-slot reporter) have their own T5 cells.
test('T5: the rules after C x the stage 8/10 rule readers: kooyumi-train-landed, never published, is never a failure of the landing gate', () => {
  const { rules } = ruleState();
  assert.ok(rules.some(r => r.type === 'required_status_checks' && r.parameters.required_status_checks.some(c => c.context === L.TRAIN_ONLY_CHECK)));
  assert.deepEqual(rulesetFacts(rules, APP), { requiredPinned: true, strict: true, mergeOnly: true, appScans: ['gitleaks', 'trivy', 'contract-placement'] }, 'rulesetFacts reads the rules after C');
  let id = 0;
  const on = (name, app, extra = {}) => ({ id: ++id, name, head_sha: H1, app: { id: app }, status: 'completed', conclusion: 'success', ...extra });
  const green = [...REQUIRED_CHECK_NAMES.map(n => on(n, APP)), ...FOUR.map(n => on(n, ACTIONS))];
  assert.deepEqual(requiredCheckFailure(rules, { complete: true, checks: green }, H1, APP), [], 'requiredCheckFailure: nothing failed');
  // the current path's reader needs it (GitHub would never merge without it); only that path reads it
  assert.deepEqual(requiredOnHead({ rules, checks: green, headSha: H1, appId: APP }).missing.map(m => [m.context, m.state]), [[L.TRAIN_ONLY_CHECK, 'absent']]);
  // a real failure still counts, and only it
  const failing = green.map(c => c.name === 'trivy' ? { ...c, conclusion: 'failure' } : c);
  assert.deepEqual(requiredCheckFailure(rules, { complete: true, checks: failing }, H1, APP), ['trivy']);
  // pinned to another App it is not the train's never-published check: it is that App's required check, read from its runs
  // (task 04f9b91b): absent is no failure (GitHub keeps it required), its failure is one
  const other = ruleState({ trainApp: 5164952 }).rules;
  assert.deepEqual(requiredCheckFailure(other, { complete: true, checks: green }, H1, APP), []);
  assert.deepEqual(requiredCheckFailure(other, { complete: true, checks: [...green, on(L.TRAIN_ONLY_CHECK, 5164952, { conclusion: 'failure' })] }, H1, APP), [L.TRAIN_ONLY_CHECK]);
});

test('landingRoute: no kooyumi-train-landed -> the current path whatever the bypass state; with it push only when all of push reads back true', () => {
  assert.deepEqual(L.landingRoute(ruleState()), { route: 'push', missing: [], bypass: { main: 'always', independent: 'never' } });
  // today: main's own non_fast_forward and deletion (the ruleset the App will bypass) are not the independent ruleset
  assert.deepEqual(route(TODAY), ['github-merge', ['independent_ruleset_missing', 'train_landed_check_missing', 'main_app_cannot_bypass'], { main: 'never', independent: 'absent' }]);
  // H1: without kooyumi-train-landed the bypass state never stops the train: any value, unreadable or not read at all is the current path
  for (const mainCan of ['always', 'pull_requests_only', 'exempt', null, 'sometimes'])
    assert.equal(route({ ...TODAY, mainCan })[0], 'github-merge', String(mainCan));
  assert.deepEqual(route(TODAY, { ...ruleState(TODAY), rulesets: new Map() }),
    ['github-merge', ['independent_ruleset_missing', 'train_landed_check_missing', `ruleset_can_bypass_unreadable:${MAIN_RS}`], { main: 'unreadable', independent: 'absent' }]);
  assert.deepEqual(route(TODAY, { ...ruleState(TODAY), rulesets: null }),
    ['github-merge', ['independent_ruleset_missing', 'train_landed_check_missing'], { main: 'not_read', independent: 'absent' }], 'stage 10 before kooyumi-train-landed');
  assert.equal(route({ trainLanded: false, mainCan: 'never', ffCan: 'always' })[0], 'github-merge');
  // kooyumi-train-landed read: never the current path
  const park = (o, missing, input) => assert.deepEqual(route(o, input).slice(0, 2), ['park', missing], JSON.stringify(o));
  park({ independent: false }, ['independent_ruleset_missing']);
  // the App could rewrite or delete main through the independent ruleset: never push
  for (const ffCan of ['always', 'pull_requests_only', 'exempt']) park({ ffCan }, ['independent_ruleset_app_can_bypass']);
  park({ mainCan: 'never' }, ['main_app_cannot_bypass']);
  park({ mainCan: 'pull_requests_only' }, ['main_app_bypass_not_always']);
  park({ mainCan: 'exempt' }, ['main_app_bypass_not_always']);
  park({ trainApp: 1 }, ['train_landed_check_missing']);
  park({ independent: false, mainCan: 'never' }, ['independent_ruleset_missing', 'main_app_cannot_bypass']);
  // with kooyumi-train-landed, a bypass state that cannot be read is a park that names it
  for (const v of [null, '', 'sometimes', true]) park({ mainCan: v }, [`ruleset_can_bypass_unreadable:${MAIN_RS}`]);
  park({ ffCan: null }, [`ruleset_can_bypass_unreadable:${FF_RS}`]);
  park({}, [`ruleset_can_bypass_unreadable:${FF_RS}`, `ruleset_can_bypass_unreadable:${MAIN_RS}`], { ...ruleState(), rulesets: new Map() });
  park({}, [`ruleset_can_bypass_unreadable:${FF_RS}`, `ruleset_can_bypass_unreadable:${MAIN_RS}`], { ...ruleState(), rulesets: null });
});

test('landingRoute, fail closed: rules that cannot be read are never the current path', () => {
  const today = ruleState(TODAY);
  const unread = (input, missing) => { const r = L.landingRoute(input); assert.deepEqual([r.route, r.missing], ['park', missing], JSON.stringify(missing)); };
  unread({ ...today, rules: null }, ['rules_unreadable']);
  unread({ ...today, rules: [] }, ['rules_unreadable']);
  unread({ ...today, rules: today.rules.map((r, i) => (i === 0 ? { ...r, rulesetId: null } : r)) }, ['rules_unreadable']);
  unread({ ...today, rules: today.rules.map(r => (r.type === 'required_status_checks' ? { ...r, parameters: { required_status_checks: [null] } } : r)) }, ['rules_unreadable']);
  // the main ruleset (the one holding the six checks this App publishes) must be exactly one
  unread({ ...today, rules: today.rules.filter(r => r.type !== 'required_status_checks') }, ['main_ruleset_unidentified']);
  // the bypass lists are not read at all: a list beside the state changes nothing
  assert.equal(L.landingRoute({ ...today, rulesets: new Map([[MAIN_RS, { id: MAIN_RS, currentUserCanBypass: 'never', bypassActors: [{ actor_id: 9, actor_type: 'Team', bypass_mode: 'always' }] }]]) }).route, 'github-merge');
});

// Task 04f9b91b (Fable s7-landing-gaps 11-22, 改动 1): a push to main must pass every ruleset on main. A guard ruleset (its rules exactly
// deletion and non_fast_forward) a fast-forward passes, and the independent bypass state is read from those only; every other ruleset
// but the main one this App must always bypass, or push parks naming it. Order: guard, kooyumi-train-landed, main, the others by id.
function s7State({ trainLanded = true, guard = true, mainCan = 'always', ffCan = 'never', scaffoldCan = 'always', more = [] } = {}) {
  const rules = [...portRules(mainRules({ extra: trainLanded ? [{ context: L.TRAIN_ONLY_CHECK, integration_id: APP }] : [] })), ...portRules(scaffoldRules()),
    ...(guard ? [{ type: 'deletion', rulesetId: FF_RS, parameters: null }, { type: 'non_fast_forward', rulesetId: FF_RS, parameters: null }] : []),
    ...more.flatMap(([id]) => [{ type: 'pull_request', rulesetId: id, parameters: { allowed_merge_methods: ['merge'] } }])];
  const can = [[MAIN_RS, mainCan], [SCAFFOLD_RULESET, scaffoldCan], ...(guard ? [[FF_RS, ffCan]] : []), ...more];
  return { rules, rulesets: new Map(can.filter(([, c]) => c !== undefined).map(([id, c]) => [id, { id, currentUserCanBypass: c }])), appId: APP };
}
const SCAF = `ruleset_app_cannot_bypass:${SCAFFOLD_RULESET}`;
test('S7 landingRoute (must-red): the scaffold ruleset is not the guard ruleset; push needs this App to always bypass it, else park naming it', () => {
  // after both of the Owner's steps: push
  assert.deepEqual(route({}, s7State()), ['push', [], { main: 'always', independent: 'never' }]);
  // the scaffold ruleset the App cannot (or not always) bypass: park, named; never push
  for (const scaffoldCan of ['never', 'pull_requests_only', 'exempt']) assert.deepEqual(route({}, s7State({ scaffoldCan })).slice(0, 2), ['park', [SCAF]], scaffoldCan);
  // its bypass state not readable: park, named
  assert.deepEqual(route({}, s7State({ scaffoldCan: null })).slice(0, 2), ['park', [`ruleset_can_bypass_unreadable:${SCAFFOLD_RULESET}`]]);
  assert.deepEqual(route({}, s7State({ scaffoldCan: 'sometimes' })).slice(0, 2), ['park', [`ruleset_can_bypass_unreadable:${SCAFFOLD_RULESET}`]]);
  // S7 step 1 (#292 as today, the scaffold ruleset, no guard ruleset yet): the current path, the independent ruleset absent
  const step1 = { trainLanded: false, guard: false, mainCan: 'never' };
  assert.deepEqual(route({}, s7State(step1)), ['github-merge', ['independent_ruleset_missing', 'train_landed_check_missing', 'main_app_cannot_bypass'], { main: 'never', independent: 'absent' }]);
  // the guard ruleset created: push lacks exactly what the save of C adds
  assert.deepEqual(route({}, s7State({ ...step1, guard: true })), ['github-merge', ['train_landed_check_missing', 'main_app_cannot_bypass'], { main: 'never', independent: 'never' }]);
  // stage 10 before reading the rulesets: no unreadable item on the current path
  assert.deepEqual(route({}, { ...s7State(step1), rulesets: null }), ['github-merge', ['independent_ruleset_missing', 'train_landed_check_missing'], { main: 'not_read', independent: 'absent' }]);
  // a fixed order: guard, kooyumi-train-landed, main, the other rulesets by id ascending
  assert.deepEqual(route({}, s7State({ ...step1, scaffoldCan: 'never', more: [[SCAFFOLD_RULESET + 5, 'never'], [SCAFFOLD_RULESET - 5, undefined]] }))[1],
    ['independent_ruleset_missing', 'train_landed_check_missing', 'main_app_cannot_bypass', `ruleset_can_bypass_unreadable:${SCAFFOLD_RULESET - 5}`, SCAF,
      `ruleset_app_cannot_bypass:${SCAFFOLD_RULESET + 5}`]);
  // the guard shape, one function for the landing and the precheck
  for (const [types, guard] of [[['deletion', 'non_fast_forward'], true], [['non_fast_forward', 'deletion', 'deletion'], true], [['deletion'], false], [['non_fast_forward'], false],
    [['deletion', 'non_fast_forward', 'pull_request'], false], [[], false], [null, false], [['deletion', null, 'non_fast_forward'], false]])
    assert.equal(L.guardRuleset(types), guard, JSON.stringify(types));
});

// S8: the scaffold ruleset deleted, the rules are the push world's (stay green); a guard ruleset the App can bypass is still never push (stay
// green); S7 with C saved but no guard ruleset is the independent ruleset missing, never the scaffold ruleset read as one (must-red).
test('S7 landingRoute: without the scaffold ruleset nothing changes; a guard ruleset the App can bypass never pushes; no guard ruleset is missing', () => {
  assert.deepEqual(L.landingRoute(ruleState()), { route: 'push', missing: [], bypass: { main: 'always', independent: 'never' } });
  assert.deepEqual(route({}, s7State({ ffCan: 'always' })).slice(0, 2), ['park', ['independent_ruleset_app_can_bypass']]);
  assert.deepEqual(route({}, s7State({ guard: false })).slice(0, 2), ['park', ['independent_ruleset_missing']]);
});

// R3 open item 2 (修复前必红): push's main ruleset is found by the pin rule stages 8 and 10 read (train-rules.mjs#sixPinned), no longer by
// its own "all six pinned to this App": with the scans pinned to GitHub Actions the route can be push (S then waits for their Actions runs,
// externalRequiredChecks). Nothing else widens: admission or the control pair off this App, a scan on an unknown App or on none, the six
// split over two rulesets are still no main ruleset (park).
const repin = (input, pins) => ({ ...input, rules: input.rules.map(r => (r.type !== 'required_status_checks' ? r : { ...r, parameters: { ...r.parameters,
  required_status_checks: r.parameters.required_status_checks.map(c => {
    if (!Object.hasOwn(pins, c.context)) return c;
    if (pins[c.context] === null) { const { integration_id, ...rest } = c; return rest; }
    return { ...c, integration_id: pins[c.context] };
  }) } })) });
test('R3 open item 2: landingRoute finds the main ruleset by the stage 8/10 pin rule: scans from GitHub Actions can be push, nothing else widens', () => {
  const ACTIONS_SCANS = { gitleaks: ACTIONS, trivy: ACTIONS, 'contract-placement': ACTIONS };
  assert.deepEqual(L.landingRoute(repin(ruleState(), ACTIONS_SCANS)), { route: 'push', missing: [], bypass: { main: 'always', independent: 'never' } });
  assert.deepEqual(L.landingRoute(repin(ruleState(), { gitleaks: ACTIONS })).route, 'push', 'one scan from Actions');
  assert.deepEqual(rulesetFacts(repin(ruleState(), ACTIONS_SCANS).rules, APP).appScans, [], 'the same rules as stages 8 and 10 read them');
  // the other two ways are unchanged with the scans from Actions
  assert.deepEqual(route(TODAY, repin(ruleState(TODAY), ACTIONS_SCANS)).slice(0, 2), ['github-merge', ['independent_ruleset_missing', 'train_landed_check_missing', 'main_app_cannot_bypass']]);
  assert.deepEqual(route({}, repin(ruleState({ mainCan: 'never' }), ACTIONS_SCANS)).slice(0, 2), ['park', ['main_app_cannot_bypass']]);
  const unidentified = (input, name) => assert.deepEqual([L.landingRoute(input).route, L.landingRoute(input).missing], ['park', ['main_ruleset_unidentified']], name);
  unidentified(repin(ruleState(), { ...ACTIONS_SCANS, 'kooyumi-work-admission': ACTIONS }), 'admission from Actions');
  unidentified(repin(ruleState(), { ...ACTIONS_SCANS, 'kooyumi-admission-verified': ACTIONS }), 'admission-verified from Actions');
  unidentified(repin(ruleState(), { 'kooyumi-merge-slot': ACTIONS }), 'merge-slot from Actions');
  unidentified(repin(ruleState(), { gitleaks: 5164952 }), 'a scan on an unknown App');
  unidentified(repin(ruleState(), { trivy: null }), 'a scan pinned to no App');
  // the six split over two rulesets: gitleaks (from Actions) stays in main's, trivy and contract-placement in another one
  const split = repin(ruleState(), { gitleaks: ACTIONS });
  const moved = ['trivy', 'contract-placement'];
  split.rules = [...split.rules.map(r => (r.type !== 'required_status_checks' ? r : { ...r, parameters: { ...r.parameters,
    required_status_checks: r.parameters.required_status_checks.filter(c => !moved.includes(c.context)) } })),
    { type: 'required_status_checks', rulesetId: 31000001, parameters: { strict_required_status_checks_policy: true, required_status_checks: moved.map(context => ({ context, integration_id: ACTIONS })) } }];
  unidentified(split, 'the six split over two rulesets');
});

// Fable 11-21 open points §5: stage 10 reads the bypass states every round too (no 'when-train-landed' any more), for landing.bypass.
test('readLandingRoute: stages 8 and 10 read every ruleset\'s bypass state with the rules (one GET /rulesets/{id} each), today and after C', async () => {
  const reads = [];
  const gh = input => ({ async readBranchRules() { reads.push('rules'); return { complete: true, rules: input.rules }; },
    async readRuleset(id) { reads.push(id); return input.rulesets.get(id); } });
  assert.equal((await L.readLandingRoute({ github: gh(ruleState(TODAY)), appId: APP })).bypass.main, 'never');
  assert.deepEqual(reads.splice(0), ['rules', MAIN_RS]);
  const after = await L.readLandingRoute({ github: gh(ruleState()), appId: APP });
  assert.deepEqual([after.route, after.bypass], ['push', { main: 'always', independent: 'never' }]);
  assert.deepEqual(reads.splice(0), ['rules', MAIN_RS, FF_RS]);
  // a read that throws is that ruleset unreadable, never an exception
  const failing = { async readBranchRules() { return { complete: true, rules: ruleState(TODAY).rules }; }, async readRuleset() { throw Object.assign(new Error('x'), { code: 'github_http_502' }); } };
  assert.deepEqual((await L.readLandingRoute({ github: failing, appId: APP })).bypass, { main: 'unreadable', independent: 'absent' });
  assert.equal((await L.readLandingRoute({ github: { async readBranchRules() { throw new Error('x'); } }, appId: APP })).route, 'park');
});

test('rehearsalOf and validRehearsal: S, what push lacks and this App\'s bypass state as read; never S\'s checks (Fable 11-21 应修 2); only that shape is kept', () => {
  const today = L.landingRoute(ruleState(TODAY));
  const ok = L.rehearsalOf({ testSha: S1, route: today });
  assert.deepEqual(ok, { testSha: S1, missing: today.missing, bypass: { main: 'never', independent: 'absent' } });
  assert.deepEqual(L.validRehearsal(ok), ok);
  // the bypass state read on the current path, in each of its values (never decides anything)
  for (const main of ['never', 'always', 'unreadable']) {
    const x = L.rehearsalOf({ testSha: S1, route: { ...today, bypass: { main, independent: 'absent' } } });
    assert.deepEqual(L.validRehearsal(x)?.bypass, { main, independent: 'absent' });
  }
  // only exactly the shape: anything else (free text, extra keys, the removed checks / allSuccess snapshot) is left out
  for (const bad of [null, 'x', { ...ok, note: 'x' }, { ...ok, allSuccess: true }, { ...ok, checks: { 'ci-suites': 'success' } }, { ...ok, testSha: 'x' },
    { ...ok, bypass: { main: 'maybe', independent: 'absent' } }, { ...ok, missing: ['Free text'] }])
    assert.equal(L.validRehearsal(bad), null, JSON.stringify(bad));
  assert.equal(L.validLandingMissing(['independent_ruleset_missing', `ruleset_can_bypass_unreadable:${MAIN_RS}`]), true);
  assert.equal(L.validLandingMissing([], { empty: false }), false);
  assert.equal(L.validLandingMissing(['a b']), false);
});

test('stage-8 outcome (writeOutcome): the rehearsal of a SETTLED pair and the missing items of a park on main\'s rules are written and read back; nothing else', async t => {
  const root = await tempDir(t);
  const plan = { stage: 8, entryRole: 'control-checks' };
  const today = L.landingRoute(ruleState(TODAY));
  const rehearsal = L.rehearsalOf({ testSha: S1, route: today });
  const read = async nonce => JSON.parse(await fs.readFile(path.join(root, `outcome-${nonce}.json`), 'utf8'));
  const n = i => String(i).repeat(32);
  await writeOutcome({ receiptsRoot: root, nonce: n(1), plan, jobIds: [], result: { status: 'SETTLED', sideEffects: 2, rehearsal } });
  assert.deepEqual((await read(n(1))).rehearsal, rehearsal);
  const missing = ['independent_ruleset_missing', `ruleset_can_bypass_unreadable:${MAIN_RS}`];
  await writeOutcome({ receiptsRoot: root, nonce: n(2), plan, jobIds: [], result: { status: 'BLOCKED', reason: 'TRAIN_LANDING_RULES_MISSING', sideEffects: 0, missing } });
  assert.deepEqual((await read(n(2))).landingMissing, missing);
  // not stage 8, another ending, or not the shape (an old record with checks and allSuccess included): left out
  await writeOutcome({ receiptsRoot: root, nonce: n(3), plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [], result: { status: 'SETTLED', sideEffects: 1, rehearsal } });
  await writeOutcome({ receiptsRoot: root, nonce: n(4), plan, jobIds: [], result: { status: 'BLOCKED', reason: 'RULESET_UNREADABLE', sideEffects: 0, missing } });
  await writeOutcome({ receiptsRoot: root, nonce: n(5), plan, jobIds: [], result: { status: 'SETTLED', sideEffects: 2, rehearsal: { ...rehearsal, note: 'free text' } } });
  await writeOutcome({ receiptsRoot: root, nonce: n(6), plan, jobIds: [], result: { status: 'BLOCKED', reason: 'TRAIN_LANDING_RULES_MISSING', sideEffects: 0, missing: ['Not a code'] } });
  await writeOutcome({ receiptsRoot: root, nonce: n(7), plan, jobIds: [], result: { status: 'SETTLED', sideEffects: 2, rehearsal: { ...rehearsal, checks: {}, allSuccess: false } } });
  for (const i of [3, 4, 5, 6, 7]) { const o = await read(n(i)); assert.ok(!('rehearsal' in o) && !('landingMissing' in o), JSON.stringify(o)); }
});

test('GitHub port: one ruleset\'s current_user_can_bypass (this App\'s own bypass), normalized; the bypass list is never read; a malformed reply refused', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.parse('2026-11-20T03:00:00Z'), seen = [];
  // as GitHub answered the Owner on 2026-11-20 06:54Z for 24182890 (the list is returned only to a caller who may edit the ruleset)
  let body = { id: 24182890, name: 'main write policy (#292)', enforcement: 'active', bypass_actors: [], current_user_can_bypass: 'never' };
  const reply = b => ({ ok: true, status: 200, json: async () => b });
  const fetchImpl = async (url, options) => {
    const u = new URL(url); seen.push(`${options.method} ${u.pathname}${u.search}`);
    if (u.pathname === '/app') return reply({ id: 77 });
    if (u.pathname === '/app/installations/99/access_tokens') return reply({ token: 't', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    if (u.pathname === '/installation/repositories') return reply({ total_count: 1, repositories: [{ id: 41, full_name: 'owner/repo' }] });
    if (u.pathname === '/repos/owner/repo/rulesets/24182890') return reply(body);
    throw new Error('unexpected');
  };
  const port = createGitHubChecksPort({ repository: 'owner/repo', repositoryId: 41, appId: 77, installationId: 99, privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now });
  assert.deepEqual(await port.readRuleset(24182890), { id: 24182890, currentUserCanBypass: 'never' });
  assert.ok(seen.includes('GET /repos/owner/repo/rulesets/24182890?includes_parents=true'));
  body = { id: 24182890 };
  assert.deepEqual(await port.readRuleset(24182890), { id: 24182890, currentUserCanBypass: null }, 'the field absent: null (landingRoute parks)');
  await assert.rejects(port.readRuleset(0), e => e.code === 'invalid_ruleset');
  for (const bad of [{ id: 1 }, { id: 24182890, current_user_can_bypass: 3 }, []]) {
    body = bad;
    await assert.rejects(port.readRuleset(24182890), e => e.code === 'invalid_ruleset_reply', JSON.stringify(bad));
  }
});

test('the never-published train-only check', async () => {
  assert.equal(RULES_TRAIN_ONLY, L.TRAIN_ONLY_CHECK);
  assert.ok(!REQUIRED_CHECK_NAMES.includes(L.TRAIN_ONLY_CHECK), 'not one of the six the train publishes');
  // stage 8's queue check: a required kooyumi-train-landed that never reports is neither a failure nor an unknown provider
  const rules = [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [...REQUIRED_CHECK_NAMES, L.TRAIN_ONLY_CHECK].map(context => ({ context, integration_id: APP })) } }];
  assert.deepEqual(requiredCheckFailure(rules, { complete: true, checks: [] }, H1, APP), []);
  // the checks port refuses to publish it, before anything is sent
  let sent = 0;
  const port = createGitHubChecksPort({ repository: REPO, repositoryId: 1, appId: APP, installationId: 2, privateKeyProvider: async () => 'k', fetchImpl: async () => { sent++; throw Error('x'); } });
  await assert.rejects(port.createCheck({ name: L.TRAIN_ONLY_CHECK, head_sha: H1, status: 'completed', conclusion: 'success', external_id: 'independent-ci:x' }), /invalid_check_publication/);
  assert.equal(sent, 0);
});

test('pickMembers and bisectAfter: the first failing prefix, the front always first, riders kept out only after the evidence', () => {
  const m = (pr, headSha = sha(100 + pr)) => ({ pr, headSha, claimId: `0000000${pr % 10}-2222-4333-8444-555555555555` });
  const F = m(1), A = m(2), B = m(3), C = m(4);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [C, A, B], max: 4 }).members.map(x => x.pr), [1, 2, 3, 4]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [C, A, B], max: 2 }).members.map(x => x.pr), [1, 2]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [A, B], bad: [{ pr: 2, headSha: A.headSha }], max: 4 }).members.map(x => x.pr), [1, 3]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [A, B], bad: [{ pr: 2, headSha: sha(999) }], max: 4 }).members.map(x => x.pr), [1, 2, 3], 'a new head is not bad');
  // [F A B C] failed -> suspect it, next the first half
  let s = L.bisectAfter({ members: [F, A, B, C], landed: false });
  assert.deepEqual(s.suspect.map(x => x.pr), [1, 2, 3, 4]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [A, B, C], suspect: s.suspect, max: 4 }).members.map(x => x.pr), [1, 2]);
  // [F A] landed -> the rest [B C] is suspect, next [B] (when B is the front)
  s = L.bisectAfter({ suspect: s.suspect, members: [F, A], landed: true });
  assert.deepEqual(s.suspect.map(x => x.pr), [3, 4]);
  assert.deepEqual(L.pickMembers({ front: B, candidates: [C], suspect: s.suspect, max: 4 }).members.map(x => x.pr), [3]);
  // [B] landed -> C alone remains: kept out of riding (it is still tested alone when it is the front)
  s = L.bisectAfter({ suspect: s.suspect, members: [B], landed: true });
  assert.deepEqual([s.suspect, s.bad.map(x => x.pr)], [null, [4]]);
  // a suspect whose prefix no longer matches (a new head, another front) is dropped: normal composition again
  const drop = L.pickMembers({ front: F, candidates: [m(2, sha(555)), B], suspect: [F, A, B].map(({ pr, headSha }) => ({ pr, headSha })), max: 4 });
  assert.deepEqual([drop.suspect, drop.members.map(x => x.pr)], [null, [1, 2, 3]]);
  // a single member that failed: no suspect (the caller reports the front failed)
  assert.deepEqual(L.bisectAfter({ members: [F], landed: false }), { suspect: null, bad: [] });
});

test('landMain: landed, already landed, moved, refused, uncertain; never a second write', async () => {
  const at = { now: 0 };
  const run = async (answer, mains) => {
    let writes = 0, i = 0;
    const r = await L.landMain({ port: { async fastForwardMain() { writes++; if (answer instanceof Error) throw answer; return answer; } },
      readMain: async () => mains[Math.min(i++, mains.length - 1)], baseSha: T, testSha: S1, clock: () => at.now, sleep: async ms => { at.now += ms; } });
    return { ...r, writes };
  };
  assert.deepEqual(await run({ status: 200, sha: S1 }, [S1]), { state: 'landed', mainSha: S1, sent: true, writes: 1 });
  assert.equal((await run({ status: 422 }, [S1])).state, 'landed', 'someone pushed the same S');
  assert.equal((await run({ status: 422 }, [sha(77)])).state, 'moved');
  assert.equal((await run({ status: 422 }, [T])).state, 'refused');
  assert.equal((await run({ status: 403 }, [T])).state, 'refused');
  assert.equal((await run({ status: 502 }, [T, T, S1])).state, 'landed', 'a lost answer whose write landed');
  const lost = await run({ status: 502 }, [T]);
  assert.deepEqual([lost.state, lost.writes], ['uncertain', 1]);
  assert.equal((await run(new Error('cut'), [sha(77)])).state, 'uncertain');
  assert.equal((await run({ status: null, notSent: true }, [T])).state, 'refused', 'never left this host');
  await assert.rejects(L.landMain({ port: {}, readMain: async () => T, baseSha: T, testSha: S1 }), /TRAIN_LANDING_INPUT_REFUSED/);
});

test('landing port: a contents-write token of exactly this repository; main only fast-forward; only the train refs; merges into staging.tmp only', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const calls = [];
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  let minted = { token: 't', expires_at: new Date(Date.now() + 3_000_000).toISOString(), permissions: { ...LANDING_PERMISSIONS, metadata: 'read' }, repositories: [{ id: 11, full_name: REPO }] };
  const fetchImpl = async (url, o) => {
    calls.push([o.method, url.replace('https://api.github.com', ''), o.body ? JSON.parse(o.body) : null]);
    if (url.endsWith('/app')) return reply(200, { id: APP });
    if (url.includes('/access_tokens')) return reply(201, minted);
    if (url.endsWith('/merges')) return reply(201, { sha: S2 });
    return reply(200, { object: { sha: JSON.parse(o.body).sha } });
  };
  const port = createLandingPort({ repository: REPO, repositoryId: 11, appId: APP, installationId: 22, privateKeyProvider: async () => pem, fetchImpl });
  assert.deepEqual(await port.fastForwardMain(S1), { status: 200, sha: S1, notSent: false });
  const mint = calls.find(c => c[1].includes('/access_tokens'));
  assert.deepEqual(mint[2], { repository_ids: [11], permissions: { contents: 'write', workflows: 'write' } });
  assert.deepEqual(calls.at(-1), ['PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: S1, force: false }]);
  await port.pointRef(L.STAGING_REF, S2);
  assert.deepEqual(calls.at(-1), ['PATCH', `/repos/${REPO}/git/refs/heads/clued-train/staging`, { sha: S2, force: true }]);
  await port.mergeIntoTmp(H1, 'm');
  assert.deepEqual(calls.at(-1), ['POST', `/repos/${REPO}/merges`, { base: 'clued-train/staging.tmp', head: H1, commit_message: 'm' }]);
  const n = calls.length;
  for (const ref of ['heads/main', 'heads/other', 'tags/v1', 'heads/clued-train/x']) await assert.rejects(port.pointRef(ref, S1), /LANDING_REF_REFUSED/);
  await assert.rejects(port.fastForwardMain('nope'), /LANDING_REF_REFUSED/);
  assert.equal(calls.length, n, 'refused before anything was sent');
  // a token with more (or other) permissions, or another repository, is never used
  for (const wrong of [{ permissions: { ...LANDING_PERMISSIONS, metadata: 'read', checks: 'write' } }, { permissions: { contents: 'write', metadata: 'read' } },
    { repositories: [{ id: 12, full_name: REPO }] }, { repositories: [{ id: 11, full_name: REPO }, { id: 12, full_name: 'x/y' }] }]) {
    minted = { ...minted, ...wrong, permissions: wrong.permissions ?? { ...LANDING_PERMISSIONS, metadata: 'read' }, repositories: wrong.repositories ?? [{ id: 11, full_name: REPO }] };
    const p = createLandingPort({ repository: REPO, repositoryId: 11, appId: APP, installationId: 22, privateKeyProvider: async () => pem, fetchImpl });
    await assert.rejects(p.fastForwardMain(S1), /unexpected_installation_token_scope/);
  }
  for (const appId of [5164952, 5365273]) assert.throws(() => createLandingPort({ repository: REPO, repositoryId: 11, appId, installationId: 22, privateKeyProvider: async () => pem, fetchImpl }), /invalid_landing_configuration/);
});

test('landing records: exact batch records (the front first), the landing state (newest; a newer torn one is unreadable)', async t => {
  const store = await TrainSweepStore.open(path.join(await tempDir(t), 'sweep'));
  const runId = '0123456789abcdef-0123456789ab', claimId = '11111111-2222-4333-8444-555555555555';
  const batch = { writtenAt: '2026-11-07T00:00:00.000Z', runId, frontPr: 910, frontHeadSha: H1, baseSha: T, testSha: S2, testTree: sha(9), attempt: 1,
    members: [{ pr: 910, headSha: H1, claimId }, { pr: 911, headSha: H2, claimId }] };
  await store.appendLandingBatch(batch);
  assert.deepEqual((await store.landingBatchByTest(S2)).members.map(m => m.pr), [910, 911]);
  assert.equal(await store.landingBatchByTest(S3), null);
  await assert.rejects(store.appendLandingBatch({ ...batch, members: [batch.members[1], batch.members[0]] }), /invalid_train_landing_batch/);
  await assert.rejects(store.appendLandingBatch({ ...batch, members: [...batch.members, ...batch.members, batch.members[0]] }), /invalid_train_landing_batch/);
  assert.deepEqual(await store.readLandingState(), { bad: [], suspect: null, adopted: [], handled: [] });
  await store.writeLandingState({ writtenAt: '2026-11-07T00:00:01.000Z', runId, bad: [{ pr: 911, headSha: H2 }], suspect: null, adopted: [S2], handled: [] });
  assert.deepEqual(await store.readLandingState(), { bad: [{ pr: 911, headSha: H2 }], suspect: null, adopted: [S2], handled: [] });
  await fs.writeFile(path.join(store.directory, `landing-state-${Date.parse('2026-11-07T00:00:02.000Z')}-${runId}-00000000.json`), 'torn');
  const fresh = await TrainSweepStore.open(store.directory);
  await assert.rejects(fresh.readLandingState(), /TRAIN_LANDING_STATE_UNREADABLE/);
});
