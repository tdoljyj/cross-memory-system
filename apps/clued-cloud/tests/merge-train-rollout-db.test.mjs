import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createIndependentPublicationRuntime } from '../../../scripts/ci/clued-independent-publication-runtime.mjs';
import { makeIndependentPublicationIdentity } from '../../../scripts/ci/clued-independent-publication-identity.mjs';
import { makeJobV2, REPO_V2 as repository } from '../../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import * as landing from '../../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-landing.mjs';
import { EffectJournal } from '../../../work/actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import {
  TRAIN_FAILURE, TRAIN_PROBE_FIELDS, TRAIN_PROTOCOL_VERSION, trainBatchKey, trainEffectKey, trainLandingSlotKey,
} from '../../../work/actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';
import { TRAIN_STAGING_WORKFLOWS } from '../../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-landing.mjs';
import { removeTestDirectory } from './cluster-cleanup.mjs';
import { schedulingFixture, digest, sha, uuid, limits } from './ci-scheduling-stage1-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';
import { multiDutyClock, multiDutyGitHub } from '../../../work/independent-ci-resident-v1/test/multi-duty-fixture.mjs';
import { openTrainTransport } from '../../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/train-transport.mjs';

const cloud = new URL('../', import.meta.url);
const appRequire = createRequire(new URL('package.json', cloud));
const repositoryId = 12345;
const appId = 5368905;
const policyVersion = 'slice-7-drill';
const checkName = 'kooyumi-work-admission';
const paths = ['work/ci-scheduling-fixture/s7.mjs'];
const leaseOf = ({ work_key, generation, lease_version }) => ({ work_key, generation, lease_version });
export const batchOf = ({ batchId, generation }) => ({ batchId, generation });
// handover-timing 复用同一隔离库驱动，只有直接运行本文件才注册下列演练。
const rolloutTest = import.meta.main ? test : () => {};

let gatewayModule;
export async function drill(t, { through } = {}) {
  // 与片 1 使用同一真实 Worker 入口。HTTP 替身只把 RPC 转发给隔离库。
  gatewayModule ??= (async () => {
    const { build, stop } = appRequire('esbuild');
    try {
      const bundle = await build({ stdin: { contents: "export * from './worker/ci-node-gateway-v1.ts'; export * from './worker/ci-scheduling-v1.ts';",
        resolveDir: fileURLToPath(cloud), loader: 'ts' }, bundle: true, platform: 'neutral', format: 'esm', write: false });
      return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    } finally { stop(); }
  })();
  const api = await gatewayModule;
  const primaryToken = randomBytes(32).toString('hex');
  // raw-binding-grants: schedulingFixture calls allowRawTestBindings(admin) after applying the migrations.
  const db = await schedulingFixture({ tokenHash: digest(primaryToken), through });
  t.after(db.close);
  const { admin, user, project } = db;
  const atomicLandingQualificationRef = uuid();
  const scope = `project:${project}`;
  const keyScope = { tenantId: user, projectId: project, repositoryId, targetBranch: 'main' };
  const source = digest('s7-source');
  const clock = multiDutyClock(db.sessionIssuedAt);
  const github = multiDutyGitHub(clock);
  const one = async (client, sql, args = []) => (await client.query(sql, args)).rows[0];
  const transport = await db.connect();
  await setWorkerGatewayCaller(transport);
  const anon = await db.connect('anon');
  const fleet = await db.native('clued_ci_nodes_v1', { project_id: project });
  const pool = await db.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: fleet.pool.version,
    repository: { id: repositoryId, name: repository }, limits: limits(), accepted_ref: 'fixture-pool-acceptance' });
  assert.equal(pool.status, 'issued', JSON.stringify(pool));
  db.committed(await db.native('clued_ci_pool_apply_v1', { confirmation_token: pool.confirmation_token, view_digest: pool.view_digest }));
  await db.modelMode();
  await admin.query(`update clued_private.work_claim_execution_policy_v1
    set activated_at=clock_timestamp(),qualification_commit=$1 where singleton`, [sha('source')]);
  const head = (pr = 1788) => ({ pr, head_sha: sha(`s7-head-${pr}`), claim_id: db.claim.claim_id,
    claim_fence: Number(db.claim.fence), execution_epoch: Number(db.claim.execution_epoch) });
  async function authorize(subject) {
    db.committed(await workerGatewayRpc(db.gateway, 'clued_work_renew_v1', db.token, {
      scope, action: 'authorize_head', claim_id: subject.claim_id, fence: subject.claim_fence, lease_version: db.claim.lease_version,
      ...(db.claimResult.lease_key ? { lease_key: db.claimResult.lease_key } : {}), repository,
      head_sha: subject.head_sha, target_branch: 'main', pr_number: subject.pr, idempotency_key: uuid(),
    }));
  }
  async function addNode(name, { legacy = false } = {}) {
    const local = await mkdtemp(path.join(tmpdir(), `train-s7-${name}-`));
    t.after(() => removeTestDirectory(local));
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
    const token = legacy ? primaryToken : randomBytes(32).toString('hex');
    const tokenHash = digest(token);
    const binding = legacy ? db.binding : (await one(admin, `insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic',$2,$3,array['context:read'],array['*']) returning id`, [user, name, tokenHash])).id;
    const { node_id: id } = db.committed(await db.native('clued_ci_node_registration_v1', {
      ...db.registration(), name, binding_id: binding, identity_public_jwk: { kty, crv, x, y },
    }));
    await db.approve(id);
    await admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',
      qualification_verified_at=now(),qualification_expires_at=now()+interval '1 hour',
      eligible_until=now()+interval '1 hour',hardening_observed=true where node_id=$1`, [id]);
    await db.live(id);
    if (legacy) await admin.query(`update clued_private.work_claim_independent_consumer_v1
      set activated_at=clock_timestamp(),qualification_commit=$1,source_manifest_sha256=$2,ci_principal_binding_id=$3 where singleton`,
    [sha('source'), source, binding]);
    return { id, binding, local, pair, token, tokenHash };
  }
  async function enableV2() {
    // 只设定隔离库切换后的配置，排空和拒写由真实发布入口判定。
    await admin.query(`update clued_private.ci_quota_counters_v1 set policy=policy||$2::jsonb
      where project_id=$1 and row_kind='pool_policy'`, [project, { signature_gateway_active: true,
      merge_train_v2: { source_manifest_sha256: source, source_commit: sha('source'), policy_version: policyVersion, stop_scope: 'none',
        staging_actor_id: 501, atomic_landing_qualification_ref: atomicLandingQualificationRef } }]);
  }
  async function command(node, action, fields = {}) {
    const { value: trust } = await one(transport, 'select public.clued_ci_node_trust_v1($1,$2) value', [node.tokenHash, node.id]);
    const { value: now } = await one(admin, 'select floor(extract(epoch from clock_timestamp())*1000)::float8 value');
    const payload = { protocol_version: TRAIN_PROTOCOL_VERSION, action, repository_id: repositoryId,
      target_branch: 'main', source_manifest_sha256: source, ...fields };
    const header = { protocol: 'clued.ci-node-command/1', operation: 'merge_train_v2', ...trust.principal,
      node_id: node.id, node_version: trust.node.version, key_version: trust.node.key_version,
      key_fingerprint: trust.node.identity_fingerprint, payload_sha256: digest(api.ciCanonicalJson(payload)),
      nonce: randomBytes(32).toString('base64url'), job_id: null, execution_generation: 0, train_generation: 0,
      issued_at_ms: now, expires_at_ms: now + 60_000 };
    header.signature = sign('sha256', Buffer.from(api.ciCanonicalJson(header)), { key: node.pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const reply = await api.handleCiNodeGatewayV1(new Request('https://worker.example.test/v1/ci/node', {
      method: 'POST', headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: header, payload }),
    }), { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'pk-fixture', CLUED_DB_GATEWAY_TOKEN: 'gw-fixture' }, {
      now: () => now,
      async fetchImpl(url, options) {
        const endpoint = new URL(url);
        assert.equal(endpoint.origin, 'https://db.example.test');
        const input = JSON.parse(options.body);
        if (endpoint.pathname === '/rest/v1/rpc/clued_ci_node_trust_v1') {
          const { value } = await one(transport, 'select public.clued_ci_node_trust_v1($1,$2) value', [input.p_token_hash, input.p_node_id]);
          return Response.json(value);
        }
        assert.equal(endpoint.pathname, '/rest/v1/rpc/clued_ci_node_command_v1');
        const { value } = await one(transport, 'select public.clued_ci_node_command_v1($1,$2,$3,$4) value',
          [input.p_token_hash, input.p_command, input.p_payload, input.p_verified]);
        return Response.json(value);
      },
    });
    const data = await reply.json();
    return data.result ?? data;
  }
  async function protectedTransport(node) {
    const { value: trust } = await one(transport, 'select public.clued_ci_node_trust_v1($1,$2) value', [node.tokenHash, node.id]);
    const config = { repository, repositoryId, scope, sourceManifestSha256: source, mergeTrainProtocolVersion: 2,
      mergeTrainNode: { nodeId: node.id, tenantId: user, projectId: project, keyFingerprint: trust.node.identity_fingerprint,
        atomicLandingQualificationRef } };
    const dbClock = () => one(admin, 'select floor(extract(epoch from clock_timestamp())*1000)::float8 now');
    const { now } = await dbClock();
    const transportPort = await openTrainTransport({ config }, () => {}, {
      readCredential: async () => ({ nativeToken: node.token, bindingId: node.binding, bindingGeneration: trust.node.binding_generation }),
      clock: () => now,
      sign: data => sign('sha256', Buffer.from(data), { key: node.pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
      fetchImpl: (url, init) => api.handleCiNodeGatewayV1(new Request(url, init),
        { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'pk-fixture', CLUED_DB_GATEWAY_TOKEN: 'gw-fixture' }, {
          now: () => now,
          async fetchImpl(rpc, options) {
            const input = JSON.parse(options.body);
            if (new URL(rpc).pathname.endsWith('/clued_ci_node_trust_v1')) {
              const { value } = await one(transport, 'select public.clued_ci_node_trust_v1($1,$2) value', [input.p_token_hash, input.p_node_id]);
              return Response.json(value);
            }
            try {
              const { value } = await one(transport, 'select public.clued_ci_node_command_v1($1,$2,$3,$4) value',
                [input.p_token_hash, input.p_command, input.p_payload, input.p_verified]);
              if (value.status !== 'committed') t.diagnostic(input.p_payload.action + ': ' + value.error_code);
              return Response.json(value);
            } catch (error) {
              t.diagnostic(input.p_payload.action + ': ' + error.message);
              throw error;
            }
          },
        }),
    });
    return { config, transport: { ...transportPort, command: input => transportPort.command({ repository_id: repositoryId,
      target_branch: 'main', source_manifest_sha256: source, ...input }) } };
  }
  const legacy = async (node, input) => (await one(anon, 'select public.clued_work_verify_v1($1,$2) value',
    [node.tokenHash, { scope, ...input }])).value;
  function checkFor(subject) { return { appId, headSha: subject.head_sha, externalId: `s7-work-admission-${subject.pr}` }; }
  const checks = new Map();
  async function openCheck(node, subject) {
    const acquired = await command(node, 'head_acquire', subject);
    assert.equal(acquired.status, 'leased', `片 1 head_acquire 必须授予写代次 ${JSON.stringify(acquired)}`);
    const lease = leaseOf(acquired);
    const admitted = await command(node, 'verify_head', { ...lease, base_sha: sha('base'), changed_paths: paths });
    assert.equal(admitted.verdict, 'ADMITTED', JSON.stringify(admitted));
    const ticket = await command(node, 'publication_begin_independent', { ...lease, check: checkFor(subject) });
    assert.equal(ticket.state, 'reserved', JSON.stringify(ticket));
    const effect = { ...lease, effect_key: ticket.effect_key };
    assert.equal((await command(node, 'publication_send', effect)).state, 'sent');
    return { acquired, effect, check: checkFor(subject) };
  }
  const postCheck = (node, check) => github.write('v2 check POST', () => {
    const result = { ...check, checkName, checkRunId: checks.size + 100, state: 'published', must_revoke: false };
    checks.set(result.checkRunId, result);
    return result;
  }, result => ['checkCreates', result, node.id]);
  async function finishCheck(node, effect, observation) {
    const settled = await command(node, 'publication_finish', { ...effect, observation });
    assert.equal(settled.state, 'settled', JSON.stringify(settled));
    assert.ok(settled.receipt_id);
    return settled.receipt_id;
  }
  async function joinAndStage(node, subject) {
    const { effect, check } = await openCheck(node, subject);
    const observed = await postCheck(node, check);
    await finishCheck(node, effect, observed);
    const readback = await command(node, 'head_admission_read', { work_key: effect.work_key, base_sha: sha('base'), changed_paths: paths });
    assert.equal(readback.verdict, 'ADMITTED', JSON.stringify(readback));
    const queue = await command(node, 'queue_acquire', subject);
    assert.equal(queue.status, 'leased', JSON.stringify(queue));
    assert.equal((await command(node, 'merge_queue_join', { ...leaseOf(queue), check_run_id: observed.checkRunId,
      inventory_digest: digest(JSON.stringify([observed])) })).joined, true);
    const baseSha = sha('base'), testSha = sha(`test of ${subject.head_sha}`);
    const members = [{ pr: subject.pr, headSha: subject.head_sha, claimId: subject.claim_id,
      fence: subject.claim_fence, epoch: subject.execution_epoch }];
    const batch = await command(node, 'batch_reserve', { baseSha, members });
    assert.equal(batch.state, 'forming', JSON.stringify(batch));
    assert.equal(batch.batchId, trainBatchKey({ ...keyScope, baseSha, members, sourceSha256: source, policyVersion }));
    const handle = batchOf(batch);
    const sealed = await command(node, 'batch_seal', { ...handle, testSha, treeSha: sha('tree'),
      steps: [{ sha: testSha, firstParent: baseSha, secondParent: subject.head_sha }], checksPolicyVersion: policyVersion });
    assert.equal(sealed.state, 'sealed');
    const generationRefOid = sha('staged marker');
    assert.equal((await command(node, 'staging_prepare', { ...handle, generationRefOid })).stagingState, 'reserved');
    assert.equal((await command(node, 'staging_send', handle)).stagingState, 'sent');
    const runs = ['linux', 'windows'].map((platform, i) => ({ testSha, platform, policyVersion, runId: i + 10,
      checkName: `fixture-${platform}`, checkRunId: i + 1000, appId: 15368, actorId: 501, attempt: 1,
      event: 'push', ref: 'refs/heads/clued-train/staging', workflow: TRAIN_STAGING_WORKFLOWS[platform] }));
    const observation = await github.write('staging ref', () => {
      for (const run of runs) github.count('requiredRuns', run, node.id);
      return { testSha, generationRefOid, evidence_digest: digest(JSON.stringify(runs)) };
    }, value => ['stagingUpdates', value.testSha, node.id]);
    assert.equal((await command(node, 'staging_publish', { ...handle, observation })).state, 'waiting_checks');
    const acquired = await command(node, 'batch_acquire', { batchId: batch.batchId });
    const runHandle = batchOf(acquired);
    for (const run of runs) {
      const result = await command(node, 'required_run_register', { ...runHandle, run });
      assert.equal(result.status, 'committed', JSON.stringify(result));
    }
    await command(node, 'batch_release', runHandle);
    const staged = await command(node, 'batch_read', { batchId: batch.batchId });
    return { ...staged, generationRefOid, runs };
  }
  return { db, scope, keyScope, source, clock, github, digest, sha, uuid, one, head, addNode, enableV2, authorize, command,
    legacy, openCheck, postCheck, finishCheck, checks, joinAndStage, protectedTransport };
}

export async function probe(d, node) {
  const result = await d.command(node, 'role_probe');
  assert.equal(result.protocol_version, TRAIN_PROTOCOL_VERSION, `片 1 未提供签名 role_probe ${JSON.stringify(result)}`);
  for (const field of TRAIN_PROBE_FIELDS) assert.ok(Object.hasOwn(result, field), field);
  assert.equal(result.node_id, node.id);
  assert.equal(result.source_manifest_sha256, d.source);
  assert.ok(result.binding_generation > 0);
  return result;
}

rolloutTest('片 7：主线合入派生头须使用原 H 已完成的句柄和有效代次', async t => {
  const d = await drill(t);
  const node = await d.addNode('carry-original-head');
  const subject = d.head();
  await d.authorize(subject);
  await d.enableV2();
  const { effect, check } = await d.openCheck(node, subject);
  await d.finishCheck(node, effect, await d.postCheck(node, check));
  const held = await d.command(node, 'carry_head_read', { work_key: effect.work_key });
  assert.deepEqual([held.status, held.work_key, held.pr, held.head_sha], ['ok', effect.work_key, subject.pr, subject.head_sha]);
  const refreshedHead = d.sha('main merged into original H');
  const input = { ...leaseOf(held), new_head_sha: refreshedHead, main_sha: d.sha('parent from main'), evidence_digest: d.digest('comparison proof') };
  const stale = await d.command(node, 'carry_main_merge', { ...input, lease_version: input.lease_version + 1 });
  assert.equal(stale.error_code, TRAIN_FAILURE.LEASE_STALE.native, JSON.stringify(stale));
  const carried = await d.command(node, 'carry_main_merge', input);
  assert.deepEqual([carried.status, carried.head_sha], ['committed', refreshedHead], JSON.stringify(carried));
  const next = await d.command(node, 'head_acquire', { ...subject, head_sha: refreshedHead });
  assert.equal(next.status, 'leased', JSON.stringify(next));
  assert.notEqual(next.work_key, held.work_key);
});

export async function requiredRunDecision(d, staged, completed) {
  assert.equal(typeof landing.exactTrainChecksDecision, 'function', '片 4、6 未集成 S 上的精确检查判定');
  const requirements = staged.runs.map(({ checkName, appId, platform }) => ({ checkName, appId, platform }));
  const rules = [{ type: 'required_status_checks', parameters: {
    required_status_checks: requirements.map(({ checkName, appId }) => ({ context: checkName, integration_id: appId })),
  } }];
  const checks = staged.runs.map(({ checkRunId, checkName, appId, testSha }) => ({ id: checkRunId, name: checkName,
    app: { id: appId }, head_sha: testSha, status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : null,
    completed_at: completed ? new Date(d.clock.now()).toISOString() : null }));
  const github = { async readTrainRun({ runId, attempt, testSha, workflow }) {
    const run = staged.runs.find(candidate => candidate.runId === runId && candidate.attempt === attempt
      && candidate.testSha === testSha && candidate.workflow === workflow);
    assert.ok(run);
    return { jobs: [{ name: run.checkName, checkRunId: run.checkRunId, status: 'completed', conclusion: 'success' }] };
  } };
  return (await landing.exactTrainChecksDecision({ rules, inventory: { complete: true, checks }, batch: staged,
    github, now: d.clock.now() })).reason;
}

async function sendLandingIntent(d, node, acquired, staged) {
  assert.equal(await requiredRunDecision(d, staged, true), null);
  const handle = batchOf(acquired);
  const landedRefOid = d.sha(`landed:${staged.testSha}`);
  const prepared = await d.command(node, 'landing_prepare', { ...handle, generationRefOid: staged.generationRefOid,
    successorRefOid: landedRefOid, evidence_digest: d.digest(JSON.stringify(staged.runs)),
    requiredRunsSha256: acquired.requiredRunsSha256 });
  assert.equal(prepared.state, 'reserved', JSON.stringify(prepared));
  const intent = { ...prepared.intent, effectId: prepared.effect_key, slotId: trainLandingSlotKey(d.keyScope), landedRefOid };
  assert.deepEqual([intent.baseSha, intent.testSha, intent.members], [staged.baseSha, staged.testSha, staged.members]);
  const send = { ...handle, effect_key: prepared.effect_key };
  assert.equal((await d.command(node, 'landing_send', send)).state, 'sent');
  return { intent, send };
}

export async function landReadyBatch(d, node, acquired, staged, { apiMs = 0, loseReply = false } = {}) {
  assert.equal(typeof landing.landTrainIntent, 'function', '片 4 未集成落地比较交换和读回');
  const { intent, send } = await sendLandingIntent(d, node, acquired, staged);
  // 落地端以数据库时间为基准核截止，效果仍由独立的故障演练时钟计时。
  const { now } = await d.one(d.db.admin, 'select floor(extract(epoch from clock_timestamp())*1000)::float8 now');
  const virtualStart = d.clock.now();
  let refs = { mainSha: staged.baseSha, generationRefOid: staged.generationRefOid };
  if (loseReply) d.github.arm('main CAS', { loseReply: true });
  const result = await landing.landTrainIntent({ intent, clock: () => now + d.clock.now() - virtualStart, readRefs: async () => refs,
    contains: async (testSha, tip) => testSha === tip, port: { landIntent: proposal => d.github.write('main CAS', () => {
      d.clock.advance(apiMs);
      assert.deepEqual([refs.mainSha, refs.generationRefOid], [proposal.baseSha, proposal.generationRefOid]);
      refs = { mainSha: proposal.testSha, generationRefOid: proposal.landedRefOid };
      return refs;
    }, after => ['mainUpdates', after.mainSha, node.id]) } });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  const observation = { ...refs, containsTestSha: true, evidence_digest: d.digest(JSON.stringify(refs)) };
  const settled = await d.command(node, 'landing_reconcile', { ...send, observation });
  assert.equal(settled.state, 'settled', JSON.stringify(settled));
  for (const member of staged.members) {
    const request = { ...send, member, evidence_digest: d.digest(JSON.stringify(member)) };
    const adopted = await d.command(node, 'claim_adopt', request);
    assert.equal(adopted.completed, true, JSON.stringify(adopted));
    assert.ok(adopted.receipt_id);
    assert.equal((await d.command(node, 'claim_adopt', request)).receipt_id, adopted.receipt_id);
  }
  assert.deepEqual(d.github.effects().filter(row => row.kind === 'mainUpdates').map(row => [row.subject, row.node]), [[staged.testSha, node.id]]);
  assert.equal(d.github.requests().filter(row => row.operation === 'main CAS').length, 1);
}

async function legacyPublisher(d, node, subject) {
  const job = makeJobV2({ repo: repository, pr: subject.pr, headSha: subject.head_sha, baseSha: d.sha('base'), role: 'work-admission',
    testSha: subject.head_sha, sourceManifestSha256: d.source, createdAt: new Date(d.clock.now()).toISOString(), attempt: 1 });
  const identity = makeIndependentPublicationIdentity({ job, controller_id: d.uuid(), claim: {
    claim_id: subject.claim_id, fence: subject.claim_fence, execution_epoch: subject.execution_epoch } });
  const context = { identity, scope: d.scope, paths, payload: { name: checkName, head_sha: subject.head_sha,
    external_id: `independent-ci:${job.id}`, status: 'completed', conclusion: 'success', output: { title: 'fixture', summary: 'fixture' } } };
  const replies = [];
  const published = new Map();
  const runtime = createIndependentPublicationRuntime({
    native: { async command(input) {
      const reply = await d.legacy(node, input);
      replies.push({ action: input.action, errorCode: reply.error_code });
      return reply;
    } }, journal: await EffectJournal.open(path.join(node.local, d.uuid())),
    assertCurrent: async () => true,
    observeStopped: async () => ({ stopped: true, controller_id: identity.controller_id, job_id: job.id,
      source: 'qualified-controller-supervisor', proofRef: `sha256:${d.digest('fixture process exited')}` }),
    github: { createCheck: payload => d.github.write('v1 check POST', () => {
      const check = { ...payload, id: 42, app: { id: appId } };
      published.set(check.id, check);
      return check;
    }, result => ['checkCreates', result, node.id]), readChecks: async () => [...published.values()],
    readCheck: async id => published.get(id),
    revokeCheck: async () => assert.fail('旧控制器不得撤回新证据') },
  });
  return { runtime, context, replies };
}

rolloutTest('片 7：数据库排空后旧包迟到，已排空票和新旧包竞争均无旧 POST', async t => {
  const d = await drill(t);
  const old = await d.addNode('old', { legacy: true });
  const next = await d.addNode('new');
  const subject = d.head();
  const different = d.head(1789);
  for (const item of [subject, different]) {
    await d.authorize(item);
    const bound = await d.legacy(old, { action: 'resolve_pr_claim', pr_ref: `${repository}#${item.pr}`, head_sha: item.head_sha,
      base_sha: d.sha('base'), target_branch: 'main', read_only: false });
    assert.equal(bound.binding_status, 'bound', JSON.stringify(bound));
    assert.equal(bound.claim?.claim_id, item.claim_id);
  }
  const { runtime, context, replies } = await legacyPublisher(d, old, subject);
  const prepared = await runtime.prepare(context).catch(error => {
    throw new Error(`排空前旧票前置未成立 ${JSON.stringify(replies)}`, { cause: error });
  });
  assert.ok(prepared.publicationId, '先真实取得旧票');
  const drained = await runtime.reconcileStopped(prepared.key);
  assert.equal(drained.status, 'NOT_SENT');
  const closed = await d.one(d.db.admin, `select state from clued_private.work_claim_publications_v1 where publication_id=$1`, [prepared.publicationId]);
  assert.notEqual(closed.state, 'open');
  await d.enableV2();
  const late = await legacyPublisher(d, old, subject);
  // 分别重放排空前句柄与重连后的旧入口。后者没有前一个控制器的本机日志。
  const results = await Promise.allSettled([runtime.createCheck(prepared), late.runtime.prepare(late.context)]);
  assert.equal(d.github.requests().filter(request => request.operation === 'v1 check POST').length, 0);
  assert.equal(results[0].value?.status, 'NOT_SENT', String(results[0].reason));
  assert.equal(results[1].status, 'rejected', '已排空的同一效果不能重新取得旧票');
  const legacyRetry = await legacyPublisher(d, old, different);
  const [lateRetry, v2] = await Promise.allSettled([
    legacyRetry.runtime.prepare(legacyRetry.context).then(handle => legacyRetry.runtime.createCheck(handle)),
    (async () => {
      const { effect, check } = await d.openCheck(next, different);
      return d.finishCheck(next, effect, await d.postCheck(next, check));
    })(),
  ]);
  const oldRequests = d.github.requests().filter(request => request.operation === 'v1 check POST');
  assert.equal(oldRequests.length, 0, `切换后的旧包到达 GitHub POST ${oldRequests.length} 次`);
  assert.deepEqual([lateRetry.status, legacyRetry.replies.at(-1)], ['rejected', {
    action: 'publication_begin_independent', errorCode: TRAIN_FAILURE.LEASE_STALE.native,
  }], '不同 head 也要由切换硬闸拒绝旧入口');
  assert.equal(v2.status, 'fulfilled', String(v2.reason));
  assert.deepEqual(d.github.effects().map(row => [row.kind, row.node]), [['checkCreates', next.id]]);
});

rolloutTest('片 7：同一节点回滚到旧协议重连，接手只读回原检查一次', async t => {
  const d = await drill(t);
  const writer = await d.addNode('writer', { legacy: true });
  const reader = await d.addNode('reader');
  const subject = d.head();
  await d.authorize(subject);
  await d.enableV2();
  const { acquired, effect, check } = await d.openCheck(writer, subject);
  assert.equal(effect.effect_key, trainEffectKey({ ...d.keyScope, action: 'publication_begin_independent',
    subject: [subject.pr, subject.head_sha, 'work-admission'] }));
  d.github.arm('v2 check POST', { loseReply: true });
  await assert.rejects(d.postCheck(writer, check), /远端写入后丢弃回复/);
  const rollback = await legacyPublisher(d, writer, subject);
  await assert.rejects(rollback.runtime.prepare(rollback.context), { code: 'independent_publication_not_sent' });
  assert.equal(rollback.replies.at(-1)?.errorCode, TRAIN_FAILURE.LEASE_STALE.native);
  await d.db.admin.query(`update clued_private.ci_train_work_v2 set expires_at=clock_timestamp()-interval '1 millisecond'
    where work_key=$1`, [effect.work_key]);
  const adopted = await d.command(reader, 'head_acquire', subject);
  assert.equal(adopted.generation, acquired.generation + 1);
  const recovery = { ...leaseOf(adopted), effect_key: effect.effect_key };
  const read = await d.command(reader, 'publication_reconcile', recovery);
  assert.deepEqual([read.state, read.effect_key, read.check?.appId, read.check?.headSha, read.check?.externalId],
    ['unknown', effect.effect_key, check.appId, check.headSha, check.externalId]);
  assert.equal((await d.command(reader, 'publication_begin_independent', { ...leaseOf(adopted), check })).error_code,
    TRAIN_FAILURE.EFFECT_UNKNOWN.native, '在途效果不能再领一张票');
  const [observation] = d.checks.values();
  const receipt = await d.finishCheck(reader, recovery, observation);
  assert.equal(await d.finishCheck(reader, recovery, observation), receipt);
  assert.deepEqual(d.github.requests().map(row => row.operation), ['v2 check POST']);
  assert.equal(d.github.totals().checkCreates, 1);
});

rolloutTest('片 7：S 等 CI 时重装，空本机目录从共享批接回原 S 和运行', async t => {
  const d = await drill(t);
  const original = await d.addNode('original');
  const subject = d.head();
  await d.authorize(subject);
  await d.enableV2();
  const staged = await d.joinAndStage(original, subject);
  assert.equal(await requiredRunDecision(d, staged, false), landing.TRAIN_LANDING_CHECKS_PENDING);
  const replacement = await d.addNode('reinstalled');
  await d.db.admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1', [original.binding]);
  assert.notEqual(original.local, replacement.local);
  const resumed = await d.command(replacement, 'batch_acquire', { batchId: staged.batchId });
  assert.equal(resumed.generation, staged.generation + 1);
  assert.equal(resumed.state, 'waiting_checks');
  assert.equal(resumed.testSha, staged.testSha);
  assert.deepEqual(resumed.members, staged.members);
  const runs = d.github.effects().filter(row => row.kind === 'requiredRuns' && row.subject.testSha === resumed.testSha).map(row => row.subject);
  assert.equal(resumed.stagingObservation?.evidence_digest, d.digest(JSON.stringify(runs)), '共享暂存证据要绑定重新读回的原运行');
  const recoveredStage = { ...resumed, generationRefOid: resumed.stagingObservation.generationRefOid, runs };
  assert.equal(await requiredRunDecision(d, recoveredStage, false), landing.TRAIN_LANDING_CHECKS_PENDING);
  assert.equal(d.github.totals().mainUpdates, 0, '检查未结束时 main 保持 T');
  d.github.emit('ci-completed', staged.testSha);
  await d.github.deliver('ci-completed', async testSha => {
    assert.equal(testSha, resumed.testSha);
    await landReadyBatch(d, replacement, resumed, recoveredStage);
  });
  assert.deepEqual(d.github.effects().filter(row => row.kind === 'requiredRuns').map(row => row.subject), staged.runs);
  assert.equal(d.github.totals().stagingUpdates, 1);
  assert.equal(d.github.requests().filter(row => row.operation === 'staging ref').length, 1);
});

rolloutTest('片 7：1→2→3→1→0→1，零容量保留共享批，再入班承接同一批', async t => {
  const d = await drill(t);
  await d.enableV2();
  const a = await d.addNode('a');
  const subject = d.head();
  await d.authorize(subject);
  const setRunning = async (node, running) => d.db.admin.query(`update clued_private.ci_node_liveness_v1
    set reported_service_running=$2 where node_id=$1`, [node.id, running]);
  const capacity = async (nodes, n) => {
    const projections = await Promise.all(nodes.map(node => probe(d, node)));
    assert.equal(projections.filter(value => value.on_duty && value.stop_scope === 'none').length, n);
  };
  await capacity([a], 1);
  const staged = await d.joinAndStage(a, subject);
  const b = await d.addNode('b');
  await capacity([a, b], 2);
  const c = await d.addNode('c');
  await capacity([a, b, c], 3);
  const readers = await Promise.all([b, c].map(node => d.command(node, 'batch_acquire', { batchId: staged.batchId })));
  assert.equal(readers.filter(value => value.state === 'waiting_checks').length, 1, JSON.stringify(readers));
  assert.equal(readers.find(value => value.state !== 'waiting_checks').error_code, TRAIN_FAILURE.HEAD_LEASE_HELD.native);
  await setRunning(a, false);
  await setRunning(b, false);
  await capacity([a, b, c], 1);
  await setRunning(c, false);
  await capacity([a, b, c], 0);
  const before = d.github.effects();
  const refused = await d.command(c, 'batch_acquire', { batchId: staged.batchId });
  assert.equal(refused.error_code, 'CI_NODE_NOT_ELIGIBLE');
  assert.deepEqual(d.github.effects(), before);
  await d.db.admin.query(`update clued_private.ci_train_batches_v2 set expires_at=clock_timestamp()-interval '1 millisecond'
    where batch_id=$1`, [staged.batchId]);
  await setRunning(a, true);
  await capacity([a, b, c], 1);
  const resumed = await d.command(a, 'batch_acquire', { batchId: staged.batchId });
  assert.deepEqual([resumed.batchId, resumed.testSha, resumed.members], [staged.batchId, staged.testSha, staged.members]);
  assert.deepEqual(d.github.effects(), before, '容量变化不能重发 staging 或重跑原 S 的 CI');
  await landReadyBatch(d, a, resumed, staged);
});

rolloutTest('片 7：main 已动但远端代次证据不全，保留已发落地意图并判停', async t => {
  assert.equal(typeof landing.reconcileTrainIntent, 'function', '片 4 未集成 landing_reconcile');
  const d = await drill(t);
  const a = await d.addNode('sender');
  const b = await d.addNode('reconciler');
  const subject = d.head();
  await d.authorize(subject);
  await d.enableV2();
  const staged = await d.joinAndStage(a, subject);
  const acquired = await d.command(a, 'batch_acquire', { batchId: staged.batchId });
  const { intent, send } = await sendLandingIntent(d, a, acquired, staged);
  const original = await d.one(d.db.admin, 'select intent,state from clued_private.ci_train_landing_v2 where effect_key=$1', [send.effect_key]);
  assert.equal(original.state, 'sent', '远端发出前，数据库已登记原意图');
  d.github.arm('main CAS', { loseReply: true });
  let remote;
  await assert.rejects(d.github.write('main CAS', () => (remote = { mainSha: intent.testSha, generationRefOid: intent.landedRefOid }),
    after => ['mainUpdates', after.mainSha, a.id]), /远端写入后丢弃回复/);
  await d.db.admin.query(`update clued_private.ci_train_batches_v2 set expires_at=clock_timestamp()-interval '1 millisecond'
    where batch_id=$1`, [staged.batchId]);
  const replacement = await d.command(b, 'batch_acquire', { batchId: staged.batchId });
  const recovery = { ...send, generation: replacement.generation };
  const pending = await d.command(b, 'landing_reconcile', { ...recovery, observation: null });
  assert.deepEqual([pending.state, pending.intent], ['unknown', original.intent]);
  const refs = { ...remote, generationRefOid: d.sha('unprovable-marker') };
  const result = await landing.reconcileTrainIntent({ intent, readRefs: async () => refs, contains: async () => true });
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, TRAIN_FAILURE.LANDING_REF_MISMATCH.resident);
  assert.deepEqual(result.refs, refs);
  const disagreement = await d.command(b, 'landing_reconcile', { ...recovery, observation: { ...refs,
    containsTestSha: true, evidence_digest: d.digest(JSON.stringify(refs)) } });
  assert.equal(disagreement.error_code, TRAIN_FAILURE.LANDING_REF_MISMATCH.native);
  assert.equal((await d.command(b, 'landing_send', recovery)).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
  assert.deepEqual(await d.one(d.db.admin, 'select intent,state from clued_private.ci_train_landing_v2 where effect_key=$1', [send.effect_key]),
    { intent: original.intent, state: 'unknown' });
  assert.equal(d.github.requests().filter(row => row.operation === 'main CAS').length, 1);
});
