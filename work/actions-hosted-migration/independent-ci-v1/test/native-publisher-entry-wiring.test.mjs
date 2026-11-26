import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicationControllerGithub, controllerPorts } from '../src/resident-v2/entry-runtime.mjs';
import { makeIndependentPublicationIdentity } from '../../../../scripts/ci/clued-independent-publication-identity.mjs';
import { independentAdmissionCheck } from '../../../../scripts/ci/clued-work-admission.mjs';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../src/job-v2.mjs';
import { digest, canonical } from '../src/proof.mjs';
import { ENTRY_V2 } from '../src/resident-v2/layout.mjs';
import { PLAN_CONTRACT_V2 } from '../src/resident-v2/stage-package.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createFixtureControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { fixtureRecord, tempDir, subject, admittedFacts, signResult } from './resident-v2-fixtures.mjs';
import { multiDutyClock, multiDutyGitHub } from '../../../independent-ci-resident-v1/test/multi-duty-fixture.mjs';
import { TRAIN_FAILURE, TRAIN_CONTROL_TIMING, TRAIN_PROTOCOL_VERSION } from '../src/merge-train-v2-contract.mjs';
import { outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';
import { createMergeSlotNative } from '../src/independent-control-checks-v2/merge-slot-native.mjs';
import { probeRole } from '../src/resident-v2/role-probe-entry.mjs';

function entryFacade({ports,jobs,journal,record,nonce}) {
 const [stage,entryRole]=jobs.length===2 ? [8,'control-checks']
  : jobs[0].role==='work-admission'?[1,'work-admission']:[3,'check-publisher'];
 const plan={contract:PLAN_CONTRACT_V2,enabled:true,stage,entryRole,batchKey:'b'.repeat(64),batchId:'b'.repeat(16)+'-'+'c'.repeat(12),
  ownerPackageAcceptanceRef:record.accepted.ownerPackageAcceptanceRef,nodeSha256:record.config.controllerNodeSha256,nodeProfileSha256:digest(record.accepted.node),
  entrySha256:record.pins.get(ENTRY_V2[entryRole]),acceptanceSha256:record.hashes.acceptanceSha256,sourceManifestSha256:jobs[0].sourceManifestSha256,
  installationSha256:record.hashes.installationSha256,runtimeConfigPinSha256:record.hashes.runtimeConfigPinSha256,jobSha256:digest(jobs)};
 // Local fixture metadata only; real entries already hold the accepted record
 // and source-bound jobs from loadStageInputs.
 const fixtureRecord={...record,config:{...record.config,sourceManifestSha256:jobs[0].sourceManifestSha256},
  accepted:{...record.accepted,revocationMaintenanceQualification:{contract:'clued.independent-ci.revocation-maintenance-qualification/1',
   qualificationRef:'receipt:'+randomUUID(),sourceManifestSha256:jobs[0].sourceManifestSha256,allowWhileHalted:false,validUntil:null}}};
 return publicationControllerGithub({ports,jobs,journal,args:{nonce,configSha256:digest(plan)},record:fixtureRecord,plan});
}

// These exercise the actual entry adapter and publisher engines, with simulated
// service ports. They are local integration checks, not runtime qualification.
async function fixture(t, active = true) {
  const time = Date.now(), iso = ms => new Date(ms).toISOString();
  const jobs = batchJobsV2(subject({ testSha: subject().headSha, createdAt: iso(time - 60000) }));
  const claim = { claimId: randomUUID(), fence: 4, epoch: 3, expiresAt: iso(time + 3600000) };
  const checks = [], calls = [], trace = [], tickets = new Map();
  let next = 101, current = true;
  const rawGithub = { fixture: true,
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, merge_commit_sha: 'd'.repeat(40),
      head: { sha: jobs.gitleaks.headSha, repo: { full_name: jobs.gitleaks.repo } },
      base: { sha: jobs.gitleaks.baseSha, ref: 'main', repo: { full_name: jobs.gitleaks.repo } } }; },
    async readGitCommit(sha) { return { sha, tree: 'c'.repeat(40), parents: sha === 'd'.repeat(40)
      ? [jobs.gitleaks.baseSha, jobs.gitleaks.headSha] : [jobs.gitleaks.baseSha] }; },
    async readBranchRules(branch) { return { complete: true, branch, rules: [
      { type: 'pull_request', rulesetId: 24182890, parameters: { allowed_merge_methods: ['merge'], required_approving_review_count: 0 } },
      { type: 'required_status_checks', rulesetId: 24182890, parameters: { strict_required_status_checks_policy: true,
        required_status_checks: ['kooyumi-work-admission','gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot']
          .map(context => ({ context, integration_id: 5368905 })) } },
    ] }; },
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['scripts/ci/test.mjs'] }; },
    async readChecks(head) { trace.push('read'); return { complete: true, checks: structuredClone(checks.filter(c => c.head_sha === head)) }; },
    async createCheck(payload) { trace.push(`create:${payload.status}`); const check = { ...structuredClone(payload), id: next++, app: { id: 5368905 } }; checks.push(check); return structuredClone(check); },
    async revokeCheck(id, payload) { trace.push(`patch:${payload.conclusion}`); const check = checks.find(c => c.id === id); Object.assign(check, structuredClone(payload)); return structuredClone(check); },
  };
  const native = { async current(identity, mode) {
    return current && identity.claim.claim_id === claim.claimId && mode.executionPolicy === (active ? 'active' : 'staged') && mode.guarded === active;
  }, async command(input) {
    calls.push(input);
    trace.push(input.action);
    if (input.action === 'publication_begin_independent') {
      if (!current) return { status: 'rejected' };
      const identity = input.independent_identity;
      if (!tickets.has(identity.effect_key)) tickets.set(identity.effect_key, { publication_id: randomUUID(), receipt_id: randomUUID() });
      return { status: 'ok', verdict: 'ADMITTED', execution_policy: 'active', execution_authorized: true, publication_required: true,
        ...tickets.get(identity.effect_key), independent_identity: identity };
    }
    assert.equal(input.action, 'publication_finish');
    return { status: 'committed', receipt_id: randomUUID(), must_revoke: !current };
  }};
  const headAuthorizationId = randomUUID();
  const admission = { fixture: true, async evaluatePr(job, packet, options = {}) {
    trace.push('evaluate');
    const facts = admittedFacts(job, claim, packet, { domain: 'fixture', batchClaim: options.batchClaim, mergeQueueHead: true,
      slotUntil: time + 3600000, observedAt: Date.now() });
    if (!active) return facts;
    delete facts.observationSha256;
    const body = { ...facts, contract: 'clued.independent-ci.full-admission/3', executionPolicy: 'active', guarded: true,
      publicationRequired: true, headAuthorizationId };
    return { ...body, observationSha256: digest(body) };
  }};
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const { docs, signer } = fixtureRecord(), record = validateRecordV2(docs, { now: time });
  const wrap = (selected, overrides = {}) => entryFacade({ ports: { github: rawGithub, native }, jobs: selected, journal, nonce: 'a'.repeat(32), record, ...overrides });
  return { jobs, claim, checks, calls, trace, journal, admission, wrap, record, signer, rawGithub, native, time, setCurrent: value => { current = value; } };
}

async function trainFixture(t, { staged = false, mustRevoke = false, omitTicket = false } = {}) {
  const f = await fixture(t, !staged), job = f.jobs['work-admission'];
  const clock = multiDutyClock(f.time), remote = multiDutyGitHub(clock);
  const projectId = '00000000-0000-4000-8000-000000000000';
  const scope = { tenantId: randomUUID(), projectId, contextKey: 'project:' + projectId, repositoryId: 1234, targetBranch: 'main' };
  const nodes = [randomUUID(), randomUUID()];
  let holder = null, generation = 0, expires = 0, effect = null, pendingQueue = null;
  let pausedBeforePost = false, loseFinishedReply = false, loseRevokedReply = false;
  let chargedHead = null, admissionBlocked = false;
  const admission = { ...f.admission, async evaluatePr(job, packet, options) {
    assert.equal(admissionBlocked, false, '旧认领失效后，撤回不得依赖重新准入');
    const facts = await f.admission.evaluatePr(job, packet, options);
    if (chargedHead !== job.headSha) {
      chargedHead = job.headSha;
      remote.count('headCharges', job.headSha);
    }
    return facts;
  } };
  const reply = body => ({ protocol_version: TRAIN_PROTOCOL_VERSION, ...body });
  const error = code => reply({ status: 'rejected', error_code: code });
  const snapshot = () => structuredClone(effect);
  const train = n => ({ scope, protocolVersion: TRAIN_PROTOCOL_VERSION, async command(input) {
    assert.equal(input.protocol_version, TRAIN_PROTOCOL_VERSION);
    if (input.action === 'verify_head') {
      assert.equal(input.head_sha, job.headSha);
      if (effect?.state === 'settled' || effect?.revocation_receipt_id)
        return { ...error(TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native), work_key: input.work_key };
      if (clock.now() < expires && holder !== n) return { ...error(TRAIN_FAILURE.HEAD_LEASE_HELD.native),
        work_key: input.work_key, ci_retry_after: new Date(expires).toISOString() };
      if (clock.now() >= expires) { holder = n; generation++; expires = clock.now() + TRAIN_CONTROL_TIMING.leaseMs; }
      return reply({ status: 'ok', work_key: input.work_key, lease_generation: generation,
        resume_required: ['sent', 'unknown', 'revoked'].includes(effect?.state) });
    }
    assert.equal(n, holder);
    assert.equal(input.lease_generation, generation);
    assert.ok(clock.now() < expires);
    assert.equal(input.scope, scope.contextKey);
    if (input.action === 'publication_reconcile' && input.phase === 'read') {
      assert.equal(input.effect_key, effect.effect_key);
      return reply({ status: 'ok', ...snapshot(), lease_generation: generation });
    }
    if (input.action === 'publication_begin_independent') {
      if (omitTicket) return reply({ status: 'ok' });
      const firstSend = input.phase === 'send' && effect?.state === 'reserved' && input.publication_id === effect.publication_id;
      if (firstSend && pausedBeforePost) throw new Error('夹具在发送栅栏前切断 A');
      if (input.phase === 'reserve' && (!effect || effect.state === 'reserved' && effect.generation !== generation)) {
        const publication_id = randomUUID();
        effect = { state: 'reserved', effect_key: input.effect_key, generation, publication_id, receipt_id: randomUUID(),
          independent_identity: input.independent_identity, effect: { ...input.effect, checkRunId: null } };
      }
      if (firstSend) effect.state = 'sent';
      return reply({ status: 'ok', ...snapshot(), lease_generation: generation, send_authorized: firstSend });
    }
    assert.equal(input.effect_key, effect.effect_key);
    assert.equal(input.publication_id, effect.publication_id);
    if (input.action === 'publication_finish') {
      const check = f.checks.find(c => c.id === input.effect.checkRunId);
      assert.equal(check?.external_id, effect.effect.externalId);
      effect.effect.checkRunId = check.id;
      effect.state = mustRevoke ? 'revoked' : 'settled';
      if (!mustRevoke) pendingQueue = { workKey: digest('first-queue:' + effect.effect_key), leaseGeneration: 1,
        effectKey: effect.effect_key, check: effect.effect, claim: claimGeneration(f.claim) };
      if (loseFinishedReply || loseRevokedReply) throw new Error('夹具丢弃已提交的 finish 回复');
      return reply({ status: 'committed', publication_id: effect.publication_id, receipt_id: randomUUID(), must_revoke: mustRevoke,
        publication_status: mustRevoke ? 'revoked' : 'published', first_queue_pending: !mustRevoke, effect_key: effect.effect_key, effect: effect.effect });
    }
    assert.equal(input.action, 'publication_reconcile');
    assert.equal(f.checks.find(c => c.id === input.effect.checkRunId)?.conclusion, 'failure');
    if (effect.revocation_receipt_id === undefined) effect.revocation_receipt_id = randomUUID();
    return reply({ status: 'committed', receipt_id: effect.revocation_receipt_id, publication_id: effect.publication_id,
      effect_key: effect.effect_key, effect: effect.effect, must_revoke: true });
  } });
  async function publisher(index, qualified = true) {
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'node-effects'));
    let claim = null;
    const github = { ...f.rawGithub,
      createCheck: body => remote.write('post', () => f.rawGithub.createCheck(body), c => ['checkCreates', c.id, nodes[index]]),
      revokeCheck: (id, body) => remote.write('revoke', () => f.rawGithub.revokeCheck(id, body), c => ['checkRevocations', c.id, nodes[index]]),
    };
    const trainNative = train(nodes[index]);
    const port = qualified ? f.wrap([job], { ports: { github, native: { ...f.native, train: trainNative } }, journal,
      nonce: String(index + 1).repeat(32) }) : github;
    const engine = createFixtureWorkAdmissionPublisherV2({ github: port, journal, admission,
      ...(qualified ? {} : { trainProtocolVersion: TRAIN_PROTOCOL_VERSION }), assertLive() {}, record() {}, authority: {}, batchClaims: {
        async read() { return claim; }, async record(j, c) { claim = claimGeneration(c); },
      } });
    return () => engine.publish(job);
  }
  return { ...f, job, clock, remote, publisher, admission, scope, pendingQueue: () => pendingQueue, snapshot,
    cutBeforePost: value => { pausedBeforePost = value; }, loseFinish: value => { loseFinishedReply = value; },
    loseRevokedFinish: value => { loseRevokedReply = value; }, blockAdmission: () => { admissionBlocked = true; } };
}

test('片2：首次发布在 POST 前丢节点，接手和 held 不重复计量', async t => {
  const f = await trainFixture(t), a = await f.publisher(0), b = await f.publisher(1);
  f.cutBeforePost(true);
  assert.notEqual((await a()).status, 'SETTLED');
  assert.equal(f.remote.totals().checkCreates, 0);
  const before = f.trace.filter(event => event === 'evaluate').length;
  const held = await b();
  assert.equal(held.reason, TRAIN_FAILURE.HEAD_LEASE_HELD.native);
  assert.equal(outcomeFailureCode({ ...held, mayHavePublished: false }, 1), TRAIN_FAILURE.HEAD_LEASE_HELD.resident);
  assert.equal(held.scheduling.ciRetryAfter, new Date(f.clock.now() + TRAIN_CONTROL_TIMING.leaseMs).toISOString());
  assert.equal(f.trace.filter(event => event === 'evaluate').length, before);
  f.clock.advance(TRAIN_CONTROL_TIMING.leaseMs); f.cutBeforePost(false);
  assert.equal((await b()).status, 'SETTLED');
  const completed = await a();
  assert.equal(completed.reason, TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native);
  assert.equal(outcomeFailureCode({ ...completed, mayHavePublished: false }, 1), TRAIN_FAILURE.HEAD_LEASE_COMPLETED.resident);
  assert.equal(f.trace.filter(event => event === 'evaluate').length, before + 1);
  assert.equal(f.remote.totals().headCharges, 1);
  assert.equal(f.remote.totals().checkCreates, 1);
  assert.ok(f.pendingQueue());
});

test('片2：GitHub 已创建但未 finish 时，独立节点核对原效果和原票据', async t => {
  const f = await trainFixture(t), a = await f.publisher(0), b = await f.publisher(1);
  f.remote.arm('post', { loseReply: true });
  assert.notEqual((await a()).status, 'SETTLED');
  assert.equal(f.checks[0]?.conclusion, 'success');
  const original = f.snapshot().publication_id;
  f.clock.advance(TRAIN_CONTROL_TIMING.leaseMs);
  assert.equal((await b()).status, 'SETTLED');
  assert.equal(f.snapshot().publication_id, original);
  assert.equal(f.remote.requests().filter(r => r.operation === 'post').length, 1);
  assert.equal(f.pendingQueue()?.check.checkRunId, f.checks[0].id);
});

test('片2：must_revoke 后丢回复，下一节点只撤回并结清原检查', async t => {
  const f = await trainFixture(t, { mustRevoke: true }), a = await f.publisher(0), b = await f.publisher(1);
  f.loseRevokedFinish(true);
  assert.notEqual((await a()).status, 'SETTLED');
  assert.equal(f.snapshot().state, 'revoked');
  assert.equal(f.checks[0].conclusion, 'success');
  f.clock.advance(TRAIN_CONTROL_TIMING.leaseMs); f.loseRevokedFinish(false); f.blockAdmission();
  assert.equal((await b()).status, 'REVOKED');
  assert.equal((await a()).reason, TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native);
  assert.equal(f.checks[0].conclusion, 'failure');
  assert.equal(f.pendingQueue(), null);
  assert.equal(f.remote.requests().filter(r => r.operation === 'post').length, 1);
  assert.equal(f.remote.totals().checkRevocations, 1);
});

test('片2：协议 2 的普通准入缺受保护票据时，GitHub 零写入', async t => {
  const f = await trainFixture(t, { staged: true, omitTicket: true });
  assert.equal((await (await f.publisher(0, false))()).status, 'BLOCKED');
  assert.equal((await (await f.publisher(0))()).status, 'UNCERTAIN');
  assert.equal(f.remote.totals().checkCreates, 0);
  assert.equal(f.pendingQueue(), null);
});

test('片2：从未入队的 PR 等待固定 App 检查，乱序通知只生效一次', async t => {
  const { evaluateFirstTrainQueue } = await import('../src/independent-control-checks-v2/publisher.mjs');
  const f = await trainFixture(t), a = await f.publisher(0);
  assert.equal((await a()).status, 'SETTLED');
  const gate = await independentAdmissionCheck(async () => Response.json({ check_runs: f.checks }),
    { GITHUB_TOKEN: 'test-only' }, f.job.repo, f.job.headSha, f.job.pr);
  assert.equal(gate.admitted, true);
  const work = f.pendingQueue();
  let entered = false;
  const slotNative = createMergeSlotNative({ config: f.record.config, train: { scope: f.scope, protocolVersion: TRAIN_PROTOCOL_VERSION,
    async command(decision) {
      assert.equal(decision.action, 'merge_queue_join');
      assert.equal(decision.work_key, work.workKey);
      assert.equal(decision.effect_key, work.effectKey);
      assert.equal(decision.pr_ref, f.job.repo + '#' + f.job.pr);
      assert.equal(decision.head_sha, f.job.headSha);
      assert.equal(decision.claim_id, f.claim.claimId);
      if (decision.disposition === 'join' && !entered) {
        assert.match(decision.observation_sha256, /^[a-f0-9]{64}$/);
        entered = true;
        f.remote.count('queueJoins', work.effectKey);
      }
      return { status: 'committed', protocol_version: TRAIN_PROTOCOL_VERSION, work_key: work.workKey,
        effect_key: work.effectKey, disposition: decision.disposition, receipt_id: randomUUID() };
    } } });
  const evaluate = () => evaluateFirstTrainQueue({ work, job: f.job, github: f.rawGithub, admission: f.admission,
    slotNative, now: () => f.time, assertLive() {} });
  assert.equal((await evaluate()).disposition, 'wait');
  for (const [idx, name] of ['gitleaks', 'trivy', 'contract-placement'].entries()) {
    f.checks.push({ id: 200 + idx, app: { id: 5368905 }, name, head_sha: f.job.headSha, status: 'completed', conclusion: 'success' });
  }
  f.remote.emit('earlier', work); f.remote.emit('later', work);
  await f.remote.deliver('later', evaluate); await f.remote.deliver('earlier', evaluate);
  work.entered = true;
  f.checks.push({ id: 300, app: { id: 5368905 }, name: 'gitleaks', head_sha: f.job.headSha, status: 'completed', conclusion: 'failure' });
  assert.equal((await evaluate()).disposition, 'return');
  const readPullRequest = f.rawGithub.readPullRequest;
  f.rawGithub.readPullRequest = async pr => {
    const pull = await readPullRequest(pr);
    return { ...pull, head: { ...pull.head, sha: 'f'.repeat(40) } };
  };
  assert.equal((await evaluate()).disposition, 'discard');
  assert.equal(f.remote.totals().queueJoins, 1);
  assert.equal(f.remote.totals().checkCreates, 1);
});

test('片2：成功 finish 丢回复后，其他节点只看到 completed，队列待办仍在', async t => {
  const f = await trainFixture(t), a = await f.publisher(0), b = await f.publisher(1);
  f.loseFinish(true);
  assert.equal((await a()).status, 'UNCERTAIN');
  assert.ok(f.pendingQueue());
  f.clock.advance(TRAIN_CONTROL_TIMING.leaseMs);
  assert.equal((await b()).reason, TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native);
  assert.equal(f.remote.totals().checkCreates, 1);
  assert.equal(f.remote.totals().headCharges, 1);
});

test('片2：已发送效果读不到原检查时，接手保持待核对', async t => {
  const f = await trainFixture(t), a = await f.publisher(0), b = await f.publisher(1);
  f.remote.arm('post', { loseReply: true });
  await a();
  f.checks[0].external_id += '-different';
  f.clock.advance(TRAIN_CONTROL_TIMING.leaseMs);
  const result = await b();
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(outcomeFailureCode(result, 1), TRAIN_FAILURE.EFFECT_UNKNOWN.resident);
  assert.equal(f.remote.requests().filter(r => r.operation === 'post').length, 1);
  assert.equal(f.pendingQueue(), null);
});

test('片2：资格探测绑定节点、代次与 Source，watchPr 只用于唤醒', async t => {
  const f = await fixture(t), nodeId = randomUUID(), sourceSha256 = f.jobs['work-admission'].sourceManifestSha256;
  const record = { config: { ...f.record.config, sourceManifestSha256: sourceSha256 } };
  let reply = { status: 'ok', protocol_version: TRAIN_PROTOCOL_VERSION, on_duty: true, node_id: nodeId,
    binding_generation: 4, source_manifest_sha256: sourceSha256, stop_scope: 'none' };
  const train = { protocolVersion: TRAIN_PROTOCOL_VERSION, nodeId, bindingGeneration: 4, async command(input) {
    assert.equal(input.action, 'role_probe');
    assert.equal(Object.hasOwn(input, 'watchPr'), false);
    return reply;
  } };
  const run = () => probeRole({ record, train, watchPr: 888, live() {} });
  assert.equal((await run()).reason, 'ROLE_PROBE_HELD');
  reply = { ...reply, binding_generation: 5 };
  assert.equal((await run()).reason, 'ROLE_PROBE_UNCERTAIN');
  reply = { ...reply, binding_generation: 4, source_manifest_sha256: 'f'.repeat(64) };
  assert.equal((await run()).reason, 'ROLE_PROBE_UNCERTAIN');
  reply = { ...reply, source_manifest_sha256: sourceSha256, stop_scope: 'fleet' };
  assert.equal((await run()).reason, 'ROLE_PROBE_NOT_HELD');
});

test('the actual entry adapter wires work admission to the original Native ticket and re-verifies without another POST', async t => {
  const f = await fixture(t), job = f.jobs['work-admission']; let batchClaim = null;
  const publisher = createFixtureWorkAdmissionPublisherV2({ github: f.wrap([job]), journal: f.journal, admission: f.admission,
    assertLive() {}, record() {}, authority: {}, batchClaims: { async read() { return batchClaim; }, async record(j, c) { batchClaim = claimGeneration(c); } } });
  const result = await publisher.publish(job);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(f.checks.length, 1); assert.match(f.checks[0].output.summary, /Native publication independent-ci:native:v1:/);
  assert.deepEqual(f.calls.map(c => c.action), ['publication_begin_independent', 'publication_begin_independent', 'publication_finish']);
  assert.equal((await publisher.publish(job)).sideEffects, 0); assert.equal(f.checks.length, 1);
});

test('one control invocation routes both roles to distinct real publication identities', async t => {
  const f = await fixture(t), pair = [f.jobs['control-admission'], f.jobs['control-merge-slot']];
  const publisher = createFixtureControlPublisherV2({ github: f.wrap(pair), journal: f.journal, admission: f.admission,
    assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(f.claim) });
  const result = await publisher.publishPair(pair, { waitUntil: Date.now() + 10000 });
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.deepEqual(f.checks.map(c => c.name), ['kooyumi-admission-verified', 'kooyumi-merge-slot']);
  const identities = f.calls.filter(c => c.action === 'publication_begin_independent').map(c => c.independent_identity);
  assert.equal(new Set(identities.map(i => i.controller_id)).size, 2);
  assert.equal(new Set(identities.map(i => i.effect_key)).size, 2);
  assert.ok(f.checks.every(c => c.output.summary.includes('begin Receipt')));
});

async function publishActiveScanner(f) {
  const job = f.jobs.trivy, github = f.wrap([job]);
  const refs = Object.fromEntries(['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef'].map(k => [k, f.record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: f.record.config.ciPrincipalBindingId,
    sourceAccepted: true, hostQualified: true, publisherQualified: true, ciPrincipalQualified: true, observedAt: new Date().toISOString(),
    claimExpiresAt: f.claim.expiresAt, claim: claimGeneration(f.claim) }; } };
  const publisher = createStagedCheckPublisherV2({ nativeAdmission: f.admission, authority, github, journal: f.journal,
    signers: new Map([...f.record.signers].map(([k,v]) => [k, { ...v, domain: 'fixture' }])), configuredChecks: f.record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), batchClaim: claimGeneration(f.claim), domain: 'fixture',
    protectedDeployment: { enabled: true, domain: 'fixture', repository: job.repo, ciPrincipalBindingId: f.record.config.ciPrincipalBindingId, ...refs } });
  const envelope = signResult(job, f.signer, { domain: 'fixture', startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000 });
  return publisher.publish({ job, envelope });
}

test('scanner publication through the actual entry adapter retains signed evidence and the Native marker', async t => {
  const f = await fixture(t), result = await publishActiveScanner(f);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(f.checks.length, 1); assert.match(f.checks[0].output.summary, /signed execution sha256/);
  assert.match(f.checks[0].output.summary, /Native publication independent-ci:native:v1:/);
});

// Production activation preflight for work_claim_execution_policy_v1. See
// WorkClaimAdmission.v0.1.md. Run as a hard assertion when qualifying activation.
test('Native active activation requires pending, verification, success readback, then ticket settlement', {
  todo: process.env.CLUED_TEST_NATIVE_ACTIVE_ACTIVATION !== '1' && 'Native active is outside the staged release',
}, async t => {
  const f = await fixture(t);
  const result = await publishActiveScanner(f);
  assert.equal(result.status, 'SETTLED');
  const begin = f.trace.indexOf('publication_begin_independent');
  const create = f.trace.indexOf('create:in_progress');
  const verify = f.trace.indexOf('evaluate', create + 1);
  const success = f.trace.indexOf('patch:success');
  const readback = f.trace.indexOf('read', success + 1);
  const finish = f.trace.indexOf('publication_finish');
  assert.ok(begin >= 0 && begin < create && create < verify && verify < success && success < readback && readback < finish,
    JSON.stringify(f.trace));
});

test('legacy entry wiring still publishes without creating a Native publication', async t => {
  const f = await fixture(t, false), job = f.jobs['work-admission']; let batchClaim = null;
  const publisher = createFixtureWorkAdmissionPublisherV2({ github: f.wrap([job]), journal: f.journal, admission: f.admission,
    assertLive() {}, record() {}, authority: {}, batchClaims: { async read() { return batchClaim; }, async record(j, c) { batchClaim = claimGeneration(c); } } });
  const result = await publisher.publish(job); assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(f.checks.length, 1); assert.equal(f.calls.length, 0);
});

test('the real read-only controller request carries the complete admitted packet paths',async t=>{
 const {docs}=fixtureRecord(),record=validateRecordV2(docs,{now:Date.now()}),job=batchJobsV2(subject({testSha:subject().headSha})).gitleaks;
 const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:randomUUID(),fence:4,execution_epoch:3},controller_id:randomUUID()});
 const paths=['scripts/ci/a.mjs','work/a.mjs'],requests=[],original=globalThis.fetch,taskId=randomUUID();
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options)=>{
  const input=JSON.parse(options.body).p_input;requests.push(input);
  if(input.action==='resolve_pr_claim'){
   assert.equal(input.scope,record.config.scope);assert.equal(input.pr_ref,`${job.repo}#${job.pr}`);
   assert.equal(input.read_only,true,'publication recheck cannot auto-bind or spend a CI head');
   return new Response(JSON.stringify({status:'ok',binding_status:'bound',reason:null,repository:job.repo,pr_number:job.pr,
    pr_ref:input.pr_ref,head_sha:job.headSha,base_sha:job.baseSha,target_branch:'main',scope:record.config.scope,task_id:taskId,
    claim:{...identity.claim,task_id:taskId,context_key:record.config.scope,lease_version:1,status:'ACTIVE',execution_handover_pending:false,
     expires_at:new Date(Date.now()+60000).toISOString()},head_authorization_id:null,auto_bound:false,receipt_id:null}),{status:200});
  }
  assert.deepEqual(input.changed_paths,paths);assert.equal(Object.hasOwn(input,'pr_ref'),false,'Agent observation must not bind or spend a CI head');
  return new Response(JSON.stringify({status:'ok',verdict:'ADMITTED',execution_policy:'staged',current_fence:4,execution_epoch:3,
   verified_at:new Date().toISOString(),claim:{...identity.claim,task_id:taskId,status:'ACTIVE',lease_key_required:false,execution_handover_pending:false,
   context_key:record.config.scope,bound_pr:`${job.repo}#${job.pr}`,expires_at:new Date(Date.now()+60000).toISOString()}}),{status:200});
 };
 const ports=controllerPorts({record,appKey:'fixture-unused-key',nativeToken:'fixture-unused-token',policyText:'',sourceRoot:'.',live(){},log(){}});
 assert.equal(await ports.native.current(identity,{scope:record.config.scope,executionPolicy:'staged',guarded:false,paths}),true);
 assert.equal(await ports.native.current(identity,{scope:record.config.scope,executionPolicy:'staged',guarded:false,paths:[]}),false);
 assert.equal(requests.length,2);
 const before=requests.length;
 await assert.rejects(ports.native.command({action:'resolve_pr_claim',scope:record.config.scope,pr_ref:'foreign/repo#1',
  head_sha:job.headSha,base_sha:job.baseSha,target_branch:'main'}),{code:'NATIVE_PUBLICATION_SCOPE_REFUSED'});
 assert.equal(requests.length,before,'foreign repository rejected before the RPC can create a binding');
});
