// Units of push mode (resident ADR 0018): the stage file, the shape of S, the other-App checks on S, which way to land (three ways,
// Fable 2026-11-20) and the rehearsal on S, composing and bisecting, the one write to main, the landing port's token and refs, the
// landing records, and the never-published check.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { tempDir } from './resident-v2-fixtures.mjs';
import * as L from '../src/independent-control-checks-v2/train-landing.mjs';
import { createLandingPort, LANDING_PERMISSIONS } from '../src/independent-control-checks-v2/train-landing-port.mjs';
import { TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { requiredCheckFailure, rulesetFacts, TRAIN_ONLY_CHECK as RULES_TRAIN_ONLY, REQUIRED_CHECK_NAMES } from '../src/independent-control-checks-v2/train-rules.mjs';
import { requiredOnHead } from '../src/independent-control-checks-v2/train-facts.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { controllerPorts } from '../src/resident-v2/entry-runtime.mjs';
import { parseLandingArg, prepareStageDirectory } from '../src/resident-v2/invoke-stage.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { SCAFFOLD_RULESET, checkRun, mainRules, portRules, s7Green, scaffoldRules } from './s7-rules-fixture.mjs';
import { multiDutyClock, multiDutyGitHub } from '../../../independent-ci-resident-v1/test/multi-duty-fixture.mjs';
import { TRAIN_FAILURE, TRAIN_PROTOCOL_VERSION, trainBatchKey, trainEffectKey, trainLandingSlotKey } from '../src/merge-train-v2-contract.mjs';
import * as maintenance from '../src/independent-control-checks-v2/train-maintenance.mjs';
import { createFixtureControlPublisherV2, createProductionControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import { trainPortsV2, stageTrainModeText, readStageTrainModeFact, STAGE_TRAIN_MODE_FILE } from '../src/independent-control-checks-v2/train-mode.mjs';
import { FIXED_APP } from '../src/resident-v2/record.mjs';
import { makeTrainRun, TRAIN_RUN_SHADOW_DEFAULTS } from '../src/resident-v2/train-run.mjs';

const sha = n => n.toString(16).padStart(40, '0');
const T = sha(1), H1 = sha(2), H2 = sha(3), H3 = sha(4), S1 = sha(5), S2 = sha(6), S3 = sha(7);
const APP = 5368905, REPO = 'tdoljyj/cross-memory-system';

const scope = { tenantId: 'tenant', projectId: 'project', repositoryId: FIXED_APP.repositoryId, targetBranch: 'main' };
const members = [
  { pr: 30, headSha: H1, claimId: 'front', fence: 2, epoch: 3 },
  { pr: 31, headSha: H2, claimId: 'rider', fence: 4, epoch: 5 },
  { pr: 32, headSha: H3, claimId: 'third', fence: 6, epoch: 7 },
];
const G = sha(20), DONE = sha(21), CANCEL = sha(22), STAGED = sha(23);
const batchId = trainBatchKey({ ...scope, baseSha: T, members, sourceSha256: 'a'.repeat(64), policyVersion: 'test' });
const effectId = trainEffectKey({ ...scope, action: 'landing_send', subject: [batchId, 1, G, T, S3] });
const slotId = trainLandingSlotKey(scope);

function v2World() {
  const clock = multiDutyClock(Date.parse('2026-11-26T09:00:00.000Z'));
  const remote = multiDutyGitHub(clock);
  const intent = { batchId, effectId, slotId, generation: 1, baseSha: T, testSha: S3, generationRefOid: G,
    landedRefOid: DONE, members, expiresAt: new Date(clock.now() + 90_000).toISOString() };
  const refs = new Map([[L.MAIN_REF, T], [L.STAGING_REF, T], ['heads/clued-train/generation', G]]);
  const tempMerges = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fetchImpl = async (url, options) => {
    const json = (body, status = 200) => Response.json(body, { status });
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/app')) return json({ id: APP });
    if (url.endsWith('/access_tokens')) return json({
      permissions: LANDING_PERMISSIONS, token: 'fixture', expires_at: new Date(clock.now() + 3_600_000).toISOString(),
      repositories: [{ id: scope.repositoryId, full_name: REPO, node_id: 'R_fixture' }],
    }, 201);
    if (url.endsWith('/graphql')) {
      if (body.query.includes('query TrainRefs')) return json({ data: { repository: { id: 'R_fixture',
        main: { target: { oid: refs.get(L.MAIN_REF) } },
        generation: { target: { oid: refs.get('heads/clued-train/generation') } },
        staging: { target: { oid: refs.get(L.STAGING_REF) } },
      } } });
      const { input } = body.variables;
      assert.equal(input.repositoryId, 'R_fixture');
      const updates = input.refUpdates.map(u => ({ ...u, name: u.name.replace(/^refs\//, '') }));
      const isLanding = updates.some(u => u.name === L.MAIN_REF);
      const isStaging = updates.some(u => u.name === L.STAGING_REF);
      const operation = isLanding ? 'land' : isStaging ? 'stage' : updates.some(u => u.name.includes('/tmp/')) ? 'temp' : 'invalidate';
      let applied = false;
      return remote.write(operation, () => {
        if (updates.some(u => (refs.get(u.name) ?? sha(0)) !== u.beforeOid
          || (u.name === L.MAIN_REF && (u.force !== false || u.afterOid !== S3)))) {
          return json({ errors: [{ message: 'ref changed' }] });
        }
        for (const { name, afterOid } of updates) refs.set(name, afterOid);
        applied = true;
        if (isStaging) remote.count('requiredRuns', refs.get(L.STAGING_REF));
        return json({ data: { updateRefs: { clientMutationId: input.clientMutationId } } });
      }, () => applied && (isLanding || isStaging) ? [isLanding ? 'mainUpdates' : 'stagingUpdates', S3] : null);
    }
    if (url.endsWith('/git/commits') && options.method === 'POST') {
      return remote.write('marker', () => json({ sha: sha(70), tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) }, 201));
    }
    if (url.includes('/git/refs/heads/main') && options.method === 'PATCH') {
      return remote.write('land', () => {
        refs.set(L.MAIN_REF, body.sha);
        return json({ object: { sha: body.sha } });
      }, () => ['mainUpdates', body.sha]);
    }
    if (url.includes('/git/refs/' + L.STAGING_TMP_REF) && options.method === 'PATCH') {
      return remote.write('temp', () => {
        refs.set(L.STAGING_TMP_REF, body.sha);
        return json({ object: { sha: body.sha } });
      });
    }
    if (url.endsWith('/merges')) {
      assert.match(body.base, /^clued-train\/(?:tmp\/|staging\.tmp$)/);
      tempMerges.push(body.base);
      const sha = new Map([[H1, S1], [H2, S2], [H3, S3]]).get(body.head);
      refs.set(`heads/${body.base}`, sha);
      return json({ sha }, 201);
    }
    throw Error(`unexpected request: ${url}`);
  };
  const port = createLandingPort({ repository: REPO, repositoryId: scope.repositoryId, appId: APP, installationId: 22,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: clock.now });
  const readRefs = async () => ({ mainSha: refs.get(L.MAIN_REF), generationRefOid: refs.get('heads/clued-train/generation'),
    stagingSha: refs.get(L.STAGING_REF) });
  const land = () => L.landTrainIntent({ intent, port, readRefs,
    contains: async (test, main) => test === S3 && main === sha(40), clock: clock.now });
  return { intent, refs, readRefs, land, remote, port, tempMerges, clock };
}

async function waitForRemote(remote, operation) {
  for (let i = 0; i < 20 && !remote.waiting(operation); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(remote.waiting(operation), true);
}

test('列车 v2：旧任在最后准入后暂停，作废先赢，迟到落地零效果', async () => {
  const w = v2World();
  w.remote.arm('land', { delay: true });
  const late = w.land();
  await waitForRemote(w.remote, 'land');
  assert.equal((await L.invalidateTrainIntent({ intent: { ...w.intent, invalidatedRefOid: CANCEL }, port: w.port, readRefs: w.readRefs })).state, 'revoked');
  w.remote.release('land');
  assert.equal((await late).reason, TRAIN_FAILURE.LANDING_REF_MISMATCH.resident);
  assert.equal((await w.readRefs()).mainSha, T);
  assert.equal(w.remote.totals().mainUpdates, 0);
});

test('列车 v2：main 先到 S 的中间祖先，禁止落地和标记推进', async () => {
  const w = v2World();
  w.remote.arm('land', { delay: true });
  const late = w.land();
  await waitForRemote(w.remote, 'land');
  w.refs.set(L.MAIN_REF, S1);
  w.remote.release('land');
  assert.equal((await late).state, 'unknown');
  assert.deepEqual(await w.readRefs(), { mainSha: S1, generationRefOid: G, stagingSha: T });
  assert.equal(w.remote.totals().mainUpdates, 0);
});

test('列车 v2：写成后断线，接手凭完成标记和 main 祖先关系收尾', async () => {
  const w = v2World();
  w.remote.arm('land', { loseReply: true });
  assert.equal((await w.land()).state, 'landed');
  w.refs.set(L.MAIN_REF, sha(40));
  const result = await L.reconcileTrainIntent({ intent: w.intent, readRefs: w.readRefs, contains: async (test, main) => test === S3 && main === sha(40) });
  assert.equal(result.state, 'landed');
  assert.equal(w.remote.requests().filter(x => x.operation === 'land').length, 1);
  assert.equal(w.remote.totals().mainUpdates, 1);
});

test('列车 v2：逐成员 adopt 断线后续办，车头最后，精确认领幂等', async () => {
  const w = v2World();
  await w.land();
  const receipts = new Map();
  let node = 'A';
  const calls = [];
  const native = {
    async adoptMember(input) {
      calls.push({ node, ...input });
      const { member } = input;
      const old = receipts.get(member.pr);
      if (old) return old;
      const receipt = { state: member.pr === 32 ? 'claim_changed' : 'adopted', member };
      receipts.set(member.pr, receipt);
      if (receipt.state === 'adopted') w.remote.count('adoptions', member.pr);
      if (node === 'A') throw Error('回执写成后节点停止');
      return receipt;
    },
  };
  const receipt = { intent: w.intent, mainSha: S3, generationRefOid: DONE };
  const run = () => maintenance.adoptTrainReceipt({ receipt, native, readRefs: w.readRefs, contains: async () => false,
    readPull: async pr => ({ head: { sha: members.find(m => m.pr === pr).headSha } }) });
  assert.equal((await run()).complete, false);
  node = 'B';
  assert.equal((await run()).complete, true);
  assert.deepEqual(calls.map(({ node, member }) => [node, member]), [['A', members[1]], ['B', members[1]], ['B', members[2]], ['B', members[0]]]);
  assert.equal(w.remote.totals().adoptions, 2);
});

test('列车 v2：迟到临时 ref 隔离，旧暂存被拒，已暂存 S 不重发 CI', async () => {
  const w = v2World();
  w.remote.arm('temp', { delay: true });
  const late = w.port.prepareBatchTmp({ batchId, generation: 1, baseSha: T });
  await waitForRemote(w.remote, 'temp');
  await w.port.invalidateGeneration({ beforeOid: G, afterOid: CANCEL, effectId });
  await w.port.prepareBatchTmp({ batchId, generation: 2, baseSha: T });
  w.remote.release('temp');
  await late;
  await w.port.mergeIntoBatchTmp({ batchId, generation: 1, headSha: H1, message: '旧任' });
  assert.equal(w.refs.get(`heads/${w.tempMerges[0]}`), S1);
  assert.equal(w.refs.get(w.tempMerges[0].replace(/1$/, '2').replace(/^/, 'heads/')), T);
  const stage = generationRefOid => ({ ...w.intent, generationRefOid, stagedRefOid: STAGED, stagingBeforeOid: T });
  const publish = (intent, send = true) => L.publishTrainStaging({ intent, port: w.port, readRefs: w.readRefs, clock: w.clock.now, send });
  assert.equal((await publish(stage(G))).state, 'mismatch');
  const current = stage(CANCEL);
  w.remote.arm('stage', { loseReply: true });
  assert.equal((await publish(current)).state, 'staged');
  assert.equal((await publish(current, false)).state, 'staged');
  assert.equal(w.remote.requests().filter(x => x.operation === 'stage').length, 1);
  assert.equal(w.remote.totals().requiredRuns, 1);
});

test('列车 v2：第 10 段先封存有序合成链，再凭共享暂存票发送一次', async () => {
  const w = v2World();
  const batch = { batchId, scope, policyVersion: 'test', generation: 1, baseSha: T, members, expiresAt: w.intent.expiresAt };
  const existingRuns = [{ runId: 50, testSha: S3, platform: 'linux', policyVersion: batch.policyVersion },
    { runId: 51, testSha: S3, platform: 'windows', policyVersion: batch.policyVersion }];
  const steps = [S1, S2, S3];
  const trees = new Map(steps.map((step, i) => [step, { sha: step, tree: sha(60 + i),
    parents: [(i === 0 ? T : steps[i - 1]), members[i].headSha] }]));
  const github = { readGitCommit: async sha => trees.get(sha) };
  let state = 'reserved', sealed, grants = 0;
  const native = {
    authorizeComposition: async value => value === batch,
    async sealBatch(value) { sealed = { ...batch, ...value }; return sealed; },
    async prepareStaging(value) {
      assert.equal(value, sealed);
      return { state, intent: stagingIntent(w), runs: state === 'settled' ? existingRuns : null };
    },
    async authorizeStagingSend() { state = 'sent'; grants++; return true; },
    async readStagingRuns() { return { complete: true, runs: [...existingRuns].reverse() }; },
    async reconcileStaging({ result }) {
      assert.equal(result.state, 'staged');
      assert.deepEqual(result.runs, existingRuns);
      state = 'settled';
      return result;
    },
  };
  const composed = await maintenance.composeTrainV2Batch({ batch, github, landing: w.port, native, clock: w.clock.now });
  assert.deepEqual(composed, { ...batch, testSha: S3, testTree: sha(62), steps });
  assert.equal(w.remote.totals().requiredRuns, 0);
  const stage = () => maintenance.stageTrainV2Batch({ batch: composed, landing: w.port, native, clock: w.clock.now });
  w.remote.arm('stage', { loseReply: true });
  assert.equal((await stage()).state, 'staged');
  assert.equal((await stage()).state, 'staged');
  assert.equal(grants, 1);
  assert.equal(w.remote.totals().requiredRuns, 1);
});

const CONTROL_PAIR = new Set(['kooyumi-admission-verified', 'kooyumi-merge-slot']);
const platformOf = name => name.endsWith('-windows') ? 'windows' : 'linux';

function stage8World({ policyVersion = 'test' } = {}) {
  const w = v2World();
  w.intent.batchId = trainBatchKey({ ...scope, baseSha: T, members, sourceSha256: 'a'.repeat(64), policyVersion });
  w.intent.effectId = trainEffectKey({ ...scope, action: 'landing_send', subject: [w.intent.batchId, 1, G, T, S3] });
  const batch = { ...w.intent, scope, steps: [S1, S2, S3], testTree: sha(60), sourceSha256: 'a'.repeat(64), policyVersion };
  let { rules } = s7State();
  const { rulesets } = s7State();
  let runPolicy = policyVersion;
  let inventory = s7Green(S3), qualified = false, sent = 0;
  const verified = [];
  const trainV2 = {
    protocolVersion: TRAIN_PROTOCOL_VERSION,
    readBatch: async () => batch,
    atomicLandingQualified: async () => qualified,
    readRuleBypass: async ({ rulesetId }) => rulesetId === FF_RS ? [] : [{ actor_id: APP, actor_type: 'Integration', bypass_mode: 'always' }],
    verifyMember: async ({ member }) => { verified.push(member); return true; },
    readRequiredRuns: async () => ({
      complete: true,
      requirements: [...new Map(rules.filter(r => r.type === 'required_status_checks')
        .flatMap(r => r.parameters.required_status_checks)
        .filter(c => !CONTROL_PAIR.has(c.context) && c.context !== L.TRAIN_ONLY_CHECK)
        .map(c => [JSON.stringify([c.context, c.integration_id]),
          { checkName: c.context, appId: c.integration_id, platform: platformOf(c.context) }])).values()],
      runs: inventory.map(c => ({ checkRunId: c.id, testSha: c.head_sha, checkName: c.name,
        platform: platformOf(c.name), appId: c.app.id, policyVersion: runPolicy })),
    }),
    prepareLanding: async () => ({ state: 'reserved', intent: w.intent }),
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
    readCompare: async (baseSha, headSha) => ({ baseSha, headSha, mergeBaseSha: baseSha, status: 'ahead', behindBy: 0 }),
    readChecks: async sha => { assert.equal(sha, S3); return { complete: true, checks: inventory }; },
  };
  const jobs = ['control-admission', 'control-merge-slot'].map(role => makeJobV2({ repo: REPO, pr: members[0].pr, headSha: H1,
    baseSha: T, testSha: S3, role, sourceManifestSha256: batch.sourceSha256, createdAt: batch.expiresAt, attempt: 1 }));
  const run = (ports = { trainV2 }, createPublisher = createFixtureControlPublisherV2) => createPublisher({ github, journal: {}, admission: {}, assertLive() {}, record() {}, ...ports,
    clock: w.clock.now, sleep: async ms => w.clock.advance(ms), landing: w.port, trainMode: 'on', trainLanding: { landing: 'push' } }).publishPair(jobs, { waitUntil: Date.parse(batch.expiresAt) });
  return { ...w, batch, trainV2, github, run, jobs, verified, get sent() { return sent; },
    qualify: () => { qualified = true; }, get inventory() { return inventory; },
    setInventory: value => { inventory = value; }, setRunPolicy: value => { runPolicy = value; },
    retireControlPair: () => { rules = rules.map(r => r.type !== 'required_status_checks' ? r : ({
      ...r, parameters: { ...r.parameters, required_status_checks: r.parameters.required_status_checks.filter(c => !CONTROL_PAIR.has(c.context) && c.context !== 'kooyumi-work-admission') },
    })); } };
}

test('列车 v2：第 8 段只消费一次 Native 发送权，重启从共享回执续办', async () => {
  const w = stage8World();
  const { run, batch, verified } = w;
  assert.equal((await run()).reason, L.TRAIN_LANDING_RULES_MISSING);
  w.qualify();
  const full = w.inventory;
  const missing = full.find(r => r.name === 'ci-suites');
  w.setInventory([...full.filter(r => r !== missing),
    checkRun(1000, missing.name, APP, S3), checkRun(1001, missing.name, missing.app.id, H1)]);
  assert.equal((await run()).reason, L.TRAIN_LANDING_CHECKS_PENDING);
  assert.equal(w.sent, 0);
  assert.deepEqual(verified, members);
  w.setInventory(full);
  w.remote.arm('land', { loseReply: true });
  assert.equal((await run()).status, 'SETTLED');
  batch.generation++;
  w.refs.set(L.GENERATION_REF, CANCEL);
  assert.equal((await run()).status, 'SETTLED');
  assert.equal(w.sent, 1);
  assert.equal(w.remote.totals().mainUpdates, 1);
});

function productionTrainPorts(w, command, record = { config: { scope: 'project:fixture', repository: REPO } }) {
  return trainPortsV2({ trainMode: 'on', record,
    github: w.github, nativeCommand: command, sourceManifestSha256: w.batch.sourceSha256, repositoryId: scope.repositoryId,
    openStore: async () => null, queueReturn: true });
}

test('片 2、4 接线：第 8、10 段通过同一受保护传输探测和请求批次', async () => {
  const w = stage8World();
  const nodeId = '00000000-0000-4000-8000-000000000001';
  const bindingGeneration = 2;
  const projectId = '00000000-0000-4000-8000-000000000003';
  const transportScope = { ...scope, projectId, contextKey: 'project:' + projectId, tenantId: '00000000-0000-4000-8000-000000000002' };
  const record = { config: { scope: transportScope.contextKey, repository: REPO, repositoryId: scope.repositoryId,
    sourceManifestSha256: w.batch.sourceSha256, mergeTrainProtocolVersion: TRAIN_PROTOCOL_VERSION } };
  const calls = [];
  const protectedTrainTransport = { nodeId, bindingGeneration, scope: transportScope, async command(input) {
    calls.push(input);
    if (input.action === 'role_probe') return { status: 'ok', protocol_version: TRAIN_PROTOCOL_VERSION,
      on_duty: true, stop_scope: 'none', node_id: nodeId, binding_generation: bindingGeneration,
      source_manifest_sha256: w.batch.sourceSha256 };
    return { protocol_version: TRAIN_PROTOCOL_VERSION, result: input.operation };
  } };
  const network = [];
  const options = { record, live() {}, trainControl: true, baseFetch: async url => { network.push(url); throw new Error('意外网络请求'); } };
  const { native } = controllerPorts({ ...options, protectedTrainTransport });
  const { trainV2 } = await productionTrainPorts(w, native.command, record);
  assert.equal(await trainV2.readBatch({ testSha: S3 }), 'read_batch');
  assert.equal(await trainV2.readMaintenance({ runId: 'fixture' }), 'read_maintenance');
  assert.deepEqual(calls.map(input => [input.action, input.protocol_version, input.source_manifest_sha256]),
    ['role_probe', 'landing_prepare', 'batch_reserve'].map(action => [action, TRAIN_PROTOCOL_VERSION, w.batch.sourceSha256]));
  assert.ok(calls.slice(1).every(input => input.node_id === nodeId && input.binding_generation === bindingGeneration));
  const { native: missing } = controllerPorts(options);
  const blocked = await productionTrainPorts(w, missing.command, record);
  assert.equal(blocked.trainV2.protocolVersion, null);
  assert.deepEqual(network, []);
});

function sharedCommand(w, protocolVersion = TRAIN_PROTOCOL_VERSION) {
  return async ({ action, operation, subject }) => {
    if (action === 'role_probe') return { ...(protocolVersion === null ? {} : { protocol_version: protocolVersion }),
      on_duty: true, stop_scope: 'none',
      source_manifest_sha256: w.batch.sourceSha256, node_id: 'fixture-node', binding_generation: 1 };
    let result;
    switch (operation) {
      case 'read_batch': result = w.batch; break;
      case 'atomic_landing_qualified': result = await w.trainV2.atomicLandingQualified(subject); break;
      case 'read_rule_bypass': result = await w.trainV2.readRuleBypass(subject); break;
      case 'verify_member': result = await w.trainV2.verifyMember(subject); break;
      case 'read_required_runs': result = await w.trainV2.readRequiredRuns(subject); break;
      case 'prepare_landing': result = await w.trainV2.prepareLanding(subject); break;
      case 'authorize_landing_send': result = await w.trainV2.authorizeLandingSend(subject.intent, subject.evidence); break;
      case 'reconcile_landing': result = await w.trainV2.reconcileLanding(subject); break;
      default: assert.fail(`unexpected Native action: ${action}/${operation}`);
    }
    return { protocol_version: TRAIN_PROTOCOL_VERSION, result };
  };
}

async function runStage8Startup(t, w, command) {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, STAGE_TRAIN_MODE_FILE), stageTrainModeText('on'));
  await fs.writeFile(path.join(dir, L.STAGE_TRAIN_LANDING_FILE), L.stageTrainLandingText({ landing: 'push' }));
  t.mock.timers.enable({ apis: ['Date'], now: w.clock.now() });
  const record = { config: { repository: REPO, scope: 'project:fixture' }, accepted: { validUntil: w.batch.expiresAt } };
  const github = { ...w.github, readChangedPaths() { throw Object.assign(new Error('no local batch'), { code: 'full_admission_claim_missing' }); } };
  globalThis.trainStartupFixture = {
    runEntry: ({ body }) => body({ args: {}, inputs: { record, jobs: w.jobs, dir }, held: {}, live() {}, sourceRoot: dir }),
    controllerPrincipal: async () => ({ nativeToken: 'fixture', bindingId: 'fixture' }),
    controllerPorts: () => ({ github, native: { command }, admission: {} }),
    publicationControllerGithub: () => github,
    observationLog: () => () => {}, authorityOf: () => ({}),
    readBatchClaim: async () => null,
    EffectJournal: { open: async () => ({}) }, GreenLedger: { open: async () => null },
    createLandingPort: () => w.port, createClaimAssistNative: () => ({}),
    readStageTrainModeFact,
    trainPortsV2: options => trainPortsV2({ ...options, openStore: async () => null }),
  };
  const entry = new URL('../src/independent-control-checks-v2/startup.mjs?train-r1-fixture', import.meta.url);
  const replacements = new Map([
    ['entry-runtime.mjs', 'runEntry, controllerPrincipal, controllerPorts, publicationControllerGithub, observationLog, authorityOf'],
    ['batch-claim-v2.mjs', 'readBatchClaim'], ['effect-journal.mjs', 'EffectJournal'],
    ['green-ledger.mjs', 'GreenLedger'], ['train-landing-port.mjs', 'createLandingPort'],
    ['train-mode.mjs', 'readStageTrainModeFact, trainPortsV2'], ['claim-assist-native.mjs', 'createClaimAssistNative'],
  ]);
  const hook = registerHooks({ resolve(spec, context, next) {
    const url = next(spec, context);
    const names = context.parentURL === entry.href && replacements.get(spec.split('/').pop());
    if (!names) return url;
    return { url: 'data:text/javascript,' + encodeURIComponent(`export const { ${names} } = globalThis.trainStartupFixture;`), shortCircuit: true };
  } });
  try { return await (await import(entry.href)).main([]); }
  finally { hook.deregister(); delete globalThis.trainStartupFixture; }
}

function runStage10(w, ports) {
  return maintenance.runTrain({ ...ports, job: makeTrainRun({
    ...TRAIN_RUN_SHADOW_DEFAULTS, repo: REPO, runId: 'a'.repeat(16) + '-' + 'b'.repeat(12),
    mode: 'on', onSince: new Date(w.clock.now()).toISOString(), sweep: 'off',
    sourceManifestSha256: w.batch.sourceSha256, createdAt: new Date(w.clock.now()).toISOString(),
  }), clock: w.clock.now, github: w.github, landing: w.port, trainLanding: { landing: 'push' },
  native: { holders: async () => ({ onDuty: false, holders: [] }) },
  sweepStore: { landingBatches: async () => [] } });
}

test('返修 1：第 10 段创建标记，由 Native 固定 OID 后激活并读回', async () => {
  const w = stage8World();
  w.qualify();
  const intent = { batchId, generation: 1, baseSha: T, generationRefOid: G, expiresAt: w.intent.expiresAt,
    effectId: trainEffectKey({ ...scope, action: 'batch_reserve', subject: [batchId, 1, G, T] }) };
  const marker = { effectId: intent.effectId, parentOid: G, treeOid: w.batch.testTree, transition: 'activate',
    createdAt: '2026-11-26T09:00:00Z' };
  let fixed = null, reconciled = null;
  const command = sharedCommand(w);
  const ports = await productionTrainPorts(w, async input => {
    const { operation, subject } = input;
    let result;
    switch (operation) {
      case 'read_maintenance': result = { kind: 'activate', batch: w.batch, activation: { state: fixed ? 'settled' : 'reserved', intent: fixed ?? intent, marker } }; break;
      case 'fix_marker':
        assert.equal(w.refs.get(L.GENERATION_REF), G);
        assert.deepEqual(subject.marker, marker);
        fixed = { ...intent, activatedRefOid: subject.markerOid };
        result = { state: 'reserved', intent: fixed };
        break;
      case 'authorize_generation_activation':
        assert.deepEqual(subject, fixed);
        result = true;
        break;
      case 'reconcile_generation_activation': reconciled = subject.result; result = { state: 'settled' }; break;
      default: return command(input);
    }
    return { protocol_version: 2, result };
  });
  await runStage10(w, ports);
  assert.equal(w.refs.get(L.GENERATION_REF), sha(70));
  assert.equal(reconciled.state, 'activated');
  assert.equal(w.remote.totals().mainUpdates, 0);
  await runStage10(w, ports);
  assert.equal(w.remote.requests().length, 2, '重放只读回，合计一次创建及一次引用更新');
});

test('返修 1：第 10 段从可信 PR 读口取单员合成对象，核父链后封存', async () => {
  const w = stage8World();
  const batch = { scope, baseSha: T, sourceSha256: w.batch.sourceSha256, policyVersion: w.batch.policyVersion,
    members: [members[0]], generation: 1, expiresAt: w.intent.expiresAt };
  batch.batchId = trainBatchKey({ ...batch, ...scope });
  const readPullRequest = w.github.readPullRequest;
  w.github.readPullRequest = async pr => ({ ...await readPullRequest(pr), merge_commit_sha: S1 });
  const command = sharedCommand(w);
  let sealed;
  const ports = await productionTrainPorts(w, async input => {
    const { operation, subject } = input;
    let result;
    switch (operation) {
      case 'read_maintenance': result = { kind: 'compose', batch }; break;
      case 'authorize_composition': assert.deepEqual(subject, batch); result = true; break;
      case 'seal_batch': sealed = subject; result = subject; break;
      default: return command(input);
    }
    return { protocol_version: 2, result };
  });
  await runStage10(w, ports);
  assert.equal(sealed?.testSha, S1, '可信的 [T,H] 对象必须被共享账本封存');
  assert.deepEqual(sealed.steps, [S1]);
  assert.equal(w.remote.requests().length, 0);
});

test('返修 7：A 只结清一个成员便断线，B 通过第 10 段从空本机存储续办', async () => {
  const w = stage8World();
  w.refs.set(L.MAIN_REF, S3);
  w.refs.set(L.GENERATION_REF, DONE);
  const receipt = { receiptId: 'receipt', intent: w.intent, mainSha: S3, generationRefOid: DONE, settledMembers: [] };
  const command = sharedCommand(w);
  const adoptions = [];
  const node = (name) => productionTrainPorts(w, async input => {
    if (input.operation === 'read_maintenance') return { protocol_version: 2, result: { kind: 'adopt', batch: w.batch, receipt } };
    if (input.operation !== 'adopt_member') return command(input);
    const { member } = input.subject;
    adoptions.push([name, member.pr]);
    receipt.settledMembers.push(member);
    if (name === 'A') throw Error('成员回执已入共享账本，原节点丢回复');
    return { protocol_version: 2, result: { state: 'adopted', member } };
  });
  await runStage10(w, await node('A'));
  await runStage10(w, await node('B'));
  assert.deepEqual(adoptions, [['A', 31], ['B', 32], ['B', 30]]);
});

// Run the same external-effect assertions before and after the production port switches.
async function landingTransport(w) {
  const ports = await productionTrainPorts(w, sharedCommand(w));
  const actual = ports.trainV2?.protocolVersion === 2;
  return {
    land: () => actual ? w.land() : L.landMain({ port: w.port, readMain: async () => (await w.readRefs()).mainSha,
      baseSha: T, testSha: S3, clock: w.clock.now, sleep: async ms => w.clock.advance(ms) }),
    tmp: generation => actual ? w.port.prepareBatchTmp({ batchId, generation, baseSha: T })
      : w.port.pointRef(L.STAGING_TMP_REF, T),
    mergeTmp: generation => actual ? w.port.mergeIntoBatchTmp({ batchId, generation, headSha: H1, message: 'fixture' })
      : w.port.mergeIntoTmp(H1, 'fixture'),
    tempRef: generation => actual ? `heads/clued-train/tmp/${batchId}/${generation}` : L.STAGING_TMP_REF,
  };
}

for (const intervening of ['invalidate', 'advance-main']) test(`返修 7：旧发送已在途，${intervening} 先赢后 main 零效果`, async () => {
  const w = stage8World();
  const transport = await landingTransport(w);
  w.remote.arm('land', { delay: true });
  const late = transport.land();
  await waitForRemote(w.remote, 'land');
  if (intervening === 'invalidate') {
    await L.invalidateTrainIntent({ intent: { ...w.intent, invalidatedRefOid: CANCEL }, port: w.port, readRefs: w.readRefs });
  } else {
    w.refs.set(L.MAIN_REF, S1);
  }
  w.remote.release('land');
  await late;
  assert.equal(w.remote.totals().mainUpdates, 0, '已发出的请求必须在远端同时比较 T 和 G');
  assert.equal(w.refs.get(L.MAIN_REF), intervening === 'invalidate' ? T : S1);
});

test('返修 7：写成丢回复，读回留下恰好一次落地及其后继标记', async () => {
  const w = stage8World();
  w.remote.arm('land', { loseReply: true });
  await (await landingTransport(w)).land();
  assert.deepEqual([w.remote.totals().mainUpdates, w.refs.get(L.MAIN_REF), w.refs.get(L.GENERATION_REF)], [1, S3, DONE]);
});

test('返修 7：旧临时引用晚写不覆盖新代次已写入的合成提交', async () => {
  const w = stage8World();
  const transport = await landingTransport(w);
  w.remote.arm('temp', { delay: true });
  const late = transport.tmp(1);
  await waitForRemote(w.remote, 'temp');
  await transport.tmp(2);
  await transport.mergeTmp(2);
  w.remote.release('temp');
  await late;
  assert.equal(w.refs.get(transport.tempRef(2)), S1, '新代次提交应留在独立临时引用');
});

test('返修 1、7：B 通过正式第 8、10 段接同一个已暂存 S，丢回复后仍逐成员结清', async t => {
  const w = stage8World();
  w.qualify();
  w.refs.set(L.STAGING_REF, S3);
  w.batch.staging = { state: 'settled', sender: 'A' };
  w.remote.arm('land', { loseReply: true });
  const adopted = [];
  const command = sharedCommand(w);
  const result = await runStage8Startup(t, w, command);
  assert.equal(w.remote.totals().mainUpdates, 1, 'B 应从共享批对 main 生效一次');
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  const stage10 = await productionTrainPorts(w, async input => {
    if (input.operation === 'read_maintenance') return { protocol_version: 2,
      result: { kind: 'adopt', batch: w.batch, receipt: { ...w.batch.landing.receipt, mainSha: S3 } } };
    if (input.operation === 'adopt_member') {
      adopted.push(input.subject.member.pr);
      return { protocol_version: 2, result: { state: 'adopted', member: input.subject.member } };
    }
    return command(input);
  });
  const { sideEffects } = await runStage10(w, stage10);
  assert.deepEqual(adopted, [31, 32, 30], 'B 本机空存储不阻碍共享收尾');
  assert.equal(sideEffects, 3);
  assert.equal(w.remote.totals().stagingUpdates, 0);
});

for (const protocol of [null, 11]) test(`返修 1：协议投影 ${protocol} 时旧写入口关闭`, async () => {
  const w = stage8World();
  w.qualify();
  const ports = await productionTrainPorts(w, sharedCommand(w, protocol));
  const result = await w.run(ports, createProductionControlPublisherV2);
  assert.deepEqual([result.status, result.reason, w.sent, w.remote.totals().mainUpdates],
    ['BLOCKED', TRAIN_FAILURE.LEASE_STALE.resident, 0, 0]);
  const maintenance = await runStage10(w, ports);
  assert.equal(maintenance.facts.decision, 'TRAIN_SOURCE_UNREADABLE');
  assert.equal(maintenance.sideEffects, 0);
});

for (const retired of [false, true]) test(`返修 2：控制对已从规则移除=${retired}，逐项核精确 S`, async () => {
  const w = stage8World();
  w.qualify();
  if (retired) w.retireControlPair();
  const produced = w.inventory.filter(c => !CONTROL_PAIR.has(c.name)
    && !(retired && c.name === 'kooyumi-work-admission'));
  const withoutOne = [];
  for (const check of produced) {
    w.setInventory(produced.filter(c => c !== check));
    withoutOne.push(await w.run());
  }
  w.setInventory(produced);
  const ready = await w.run();
  assert.deepEqual([...new Set(withoutOne.map(result => result.reason)), ...new Set(withoutOne.map(result => result.sideEffects)),
    ready.status, w.sent, w.remote.totals().mainUpdates],
  [L.TRAIN_LANDING_CHECKS_PENDING, 0, 'SETTLED', 1, 1], JSON.stringify({ missing: withoutOne[0], ready }));
});

test('返修 3：策略 B 重建同 S 批，策略 A 绿不能消费发送权', async () => {
  const w = stage8World({ policyVersion: 'B' });
  w.qualify();
  w.setRunPolicy('A');
  const result = await w.run();
  assert.deepEqual([result.reason, w.sent, w.remote.totals().mainUpdates], [L.TRAIN_LANDING_CHECKS_PENDING, 0, 0]);
  w.setRunPolicy('B');
  assert.equal((await w.run()).status, 'SETTLED');
});

test('返修 3：同 SHA、同策略、同检查 ID 的错平台证据仍不能落地', async () => {
  const w = stage8World();
  w.qualify();
  const readRuns = w.trainV2.readRequiredRuns;
  w.trainV2.readRequiredRuns = async () => {
    const evidence = await readRuns();
    return { ...evidence, runs: evidence.runs.map(run => run.checkName === 'ci-suites-windows' ? { ...run, platform: 'linux' } : run) };
  };
  const result = await w.run();
  assert.deepEqual([result.reason, w.sent, w.remote.totals().mainUpdates], [L.TRAIN_LANDING_CHECKS_PENDING, 0, 0]);
});

test('返修 5：准备落地时读到竞争回执且远端 G 已推进', async () => {
  const w = stage8World();
  w.qualify();
  w.trainV2.prepareLanding = async () => {
    w.refs.set(L.MAIN_REF, sha(40));
    w.refs.set(L.GENERATION_REF, CANCEL);
    return { state: 'settled', intent: w.intent, receipt: { receiptId: 'race', intent: w.intent, generationRefOid: DONE, mainSha: S3 } };
  };
  const result = await w.run();
  assert.deepEqual([result.status, w.sent, w.remote.requests().length], ['SETTLED', 0, 0]);
});

function stagingIntent(w, { action = 'staging_publish', ...fields } = {}) {
  const intent = { ...w.intent, stagingBeforeOid: T, stagedRefOid: STAGED, ...fields };
  return { ...intent, effectId: trainEffectKey({ ...scope, action,
    subject: [intent.batchId, intent.generation, intent.generationRefOid, intent.baseSha, intent.testSha] }) };
}

for (const scenario of ['old-marker', 'wrong-effect', 'wrong-run']) test(`返修 4：暂存 ${scenario} 留待核对且零更新`, async () => {
  const w = stage8World();
  const intent = stagingIntent(w, { action: scenario === 'wrong-effect' ? 'landing_send' : 'staging_publish' });
  const expected = [{ runId: 8, testSha: S3, platform: 'linux', policyVersion: 'test' },
    { runId: 9, testSha: S3, platform: 'windows', policyVersion: 'test' }];
  let grants = 0;
  if (scenario !== 'wrong-effect') w.refs.set(L.STAGING_REF, S3);
  if (scenario === 'wrong-run') w.refs.set(L.GENERATION_REF, STAGED);
  const native = {
    prepareStaging: async () => ({ state: scenario === 'wrong-effect' ? 'reserved' : 'sent', intent, runs: expected }),
    authorizeStagingSend: async () => { grants++; return true; },
    readStagingRuns: async () => ({ complete: true, runs: expected.map(run => run.platform === 'linux' ? { ...run, runId: 10 } : run) }),
    reconcileStaging: async ({ result }) => result,
  };
  let response;
  try { response = (await maintenance.stageTrainV2Batch({ batch: w.batch, landing: w.port, native, clock: w.clock.now })).state; }
  catch (error) { response = error.code; }
  assert.deepEqual([response, grants, w.remote.totals().stagingUpdates],
    [scenario === 'wrong-effect' ? TRAIN_FAILURE.LEASE_STALE.resident : 'unknown', 0, 0]);
});

const dbFixture = new URL('../../../../apps/clued-cloud/tests/merge-train-v2-db.fixture.mjs', import.meta.url);
let dbAvailable = true;
try { createRequire(dbFixture).resolve('embedded-postgres'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  dbAvailable = false;
}
test('返修 6：隔离 PostgreSQL 中 H2 有效授权早于迟到的 H1 准入，H1 收尾保留 H2',
  { skip: !dbAvailable && '应用未安装嵌入式 PostgreSQL。生产模式迁移套件也注册此用例。' }, async t => {
    const { verifyInFlightAdoptPreservesNewHead } = await import(dbFixture);
    await verifyInFlightAdoptPreservesNewHead(t);
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
