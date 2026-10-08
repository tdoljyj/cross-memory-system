import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareExactPlanWithExistingBindingRpc } from '../worker/model-domain-plan-preparation.mjs';
import { DOMAIN_POLICY as P } from '../worker/model-domain-policy.mjs';
import { POLICY } from '../worker/model-domain-readonly.mjs';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { MODEL_DOMAIN_PLAN_PREPARATION_TOOL, MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL, modelDomainTools,
  modelDomainToolPolicies } from '../worker/model-domain-tools.ts';

// Fictional transport results exercise source rejection and exact serialization;
// these tests do not authenticate a Host or create an actual Native plan.
const anchors = () => ({ status: 'OWNER_ANCHOR_PROJECTION_REFS_ONLY', projection_only: true,
  source_scope: POLICY.scope, authority_effect: 'NONE', domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED',
  owner_adoption_server_ref: { id: P.domain.owner_adoption.canonical_record_id, version: 1,
    content_hash: P.domain.owner_adoption.record_content_sha256 },
  final_recognizer_server_ref: { ...P.server.owner_final_recognizer.record_ref } });
const dispatchUrl = new URL('../worker/model-domain-dispatch.ts', import.meta.url);
const source = stripTypeScriptTypes(readFileSync(dispatchUrl, 'utf8')).replace(/from "(\.\/[^\"]+)"/g,
  (_, relative) => `from ${JSON.stringify(new URL(relative === './model-domain-tools' ? relative + '.ts' : relative, dispatchUrl).href)}`);
const { dispatchModelDomainTool } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('preparation accepts no caller refs/actor/transport/grant and calls no source for invalid input', async () => {
  let reads = 0;
  for (const input of [null, undefined, [], { owner_anchor_refs: anchors() }, { actor: 'owner' }, { rpc: () => {} }, { user_confirmed: true }]) {
    await assert.rejects(prepareExactPlanWithExistingBindingRpc(async () => { reads++; return anchors(); }, input));
  }
  assert.equal(reads, 0);
});
test('denied/malformed/private source never produces a plan or invokes a second RPC', async () => {
  for (const reply of [null, { ...anchors(), actor_user_id: 'private' }, { ...anchors(), domain_permission: 'GRANTED' },
    { ...anchors(), source_scope: 'global' }, { ...anchors(), owner_adoption_server_ref: { ...anchors().owner_adoption_server_ref, version: 2 } }]) {
    let reads = 0;
    await assert.rejects(prepareExactPlanWithExistingBindingRpc(async name => {
      assert.equal(name, 'clued_model_dataset_split_owner_anchor_refs_candidate'); reads++; return reply;
    }, {}));
    assert.equal(reads, 1);
  }
  await assert.rejects(prepareExactPlanWithExistingBindingRpc(async () => { throw new Error('denied'); }, {}));
});
test('proposal exact UTF8/hash matches original twelve-field writer contract and has no authority/effect', async () => {
  const out = await prepareExactPlanWithExistingBindingRpc(async name => {
    assert.equal(name, 'clued_model_dataset_split_owner_anchor_refs_candidate'); return anchors();
  }, {});
  assert.equal(out.status, 'PLAN_ARTIFACT_PROPOSAL_UNCOMMITTED_UNAUTHORIZED');
  assert.equal(out.plan_bytes, Buffer.byteLength(out.plan_utf8));
  assert.equal(out.plan_sha256, createHash('sha256').update(out.plan_utf8).digest('hex'));
  const plan = JSON.parse(out.plan_utf8);
  assert.deepEqual(Object.keys(plan).sort(), ['authority_registry_sha256','canonical_scope','contract_sha256','idempotency_key',
    'max_uses','max_window_seconds','mutation_roles','owner_anchor_refs','schema','subject','targets','task_id']);
  assert.equal(JSON.stringify(plan, null, 2) + '\n', out.plan_utf8);
  assert.deepEqual(plan.subject, P.domain.subject);
  // These pins are independent of the imported candidate policy and preserve
  // the original reviewed writer contract. Drift requires a reviewed successor.
  assert.equal(plan.contract_sha256, 'd8599ca8148f63a7893133ad3b13426edab25f3f48bc5291b1fb7c038a04754f');
  assert.equal(plan.authority_registry_sha256, 'b89bb15a047cd59390428e86d33e8e2fc59d3a83954c68c2393d0e5b3dc4f3cc');
  assert.deepEqual(plan.subject, { definition_id: 'clued.model-program.DatasetSplit', version: 'v0.1',
    definition_sha256: 'f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77',
    instance_schema_sha256: '062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f' });
  assert.deepEqual(plan.owner_anchor_refs, { owner_adoption_server_ref: anchors().owner_adoption_server_ref,
    final_recognizer_server_ref: anchors().final_recognizer_server_ref });
  assert.deepEqual(plan.mutation_roles.map(x => [x.role,x.record_type,x.authority,x.identity_not_persisted]),
    [['producer','state','user_explicit',true],['permission','decision','user_explicit',true],['recognition','state','observed',true]]);
  assert.deepEqual([plan.canonical_scope,plan.task_id,plan.contract_sha256,plan.authority_registry_sha256,plan.max_uses,plan.max_window_seconds],
    [POLICY.scope,POLICY.task,P.contract_sha256,P.domain.authority_registry_sha256,1,3600]);
  const ids = Object.values(plan.targets);
  assert.equal(new Set(ids).size, 3);
  assert(ids.every(x => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x)));
  assert.equal(out.role_inputs.idempotency_key, plan.idempotency_key);
  assert(Object.isFrozen(out.role_inputs)); assert(Object.isFrozen(out.role_inputs.owner_adoption_server_ref));
  assert(Object.isFrozen(out.role_inputs.final_recognizer_server_ref));
  assert.throws(() => { out.role_inputs.producer_record_id = 'changed'; }, TypeError);
  for (const [key,id] of Object.entries(plan.targets)) assert.equal(out.role_inputs[key], id);
  assert.deepEqual([out.actual_execution,out.execution,out.mutation_permitted,out.authority_effect,out.immutable_resource,
    out.SQL_emitted,out.domain_permission,out.m2_verdict], ['NONE',false,false,'NONE',null,false,'NOT_GRANTED','NOT_ISSUED']);
});
test('each preparation produces distinct IDs; it is explicitly non-idempotent and read-only', async () => {
  const one = await prepareExactPlanWithExistingBindingRpc(async () => anchors(), {});
  const two = await prepareExactPlanWithExistingBindingRpc(async () => anchors(), {});
  assert.notEqual(one.plan_sha256, two.plan_sha256);
  assert.notEqual(one.role_inputs.idempotency_key, two.role_inputs.idempotency_key);
  for (const name of [MODEL_DOMAIN_PLAN_PREPARATION_TOOL, MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL]) {
    assert.equal(modelDomainTools.find(x => x.name === name).inputSchema.additionalProperties, false);
    assert.deepEqual(modelDomainToolPolicies[name].scopes, ['context:read']);
    assert.equal(modelDomainToolPolicies[name].readOnlyHint, true);
  }
  assert.equal(modelDomainToolPolicies[MODEL_DOMAIN_PLAN_PREPARATION_TOOL].idempotentHint, false);
});
test('source OFF rejects both new routes before effects; plan branch never submits Owner request', async () => {
  let effects = 0;
  for (const name of [MODEL_DOMAIN_PLAN_PREPARATION_TOOL, MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL]) {
    await assert.rejects(dispatchModelDomainTool({}, name, {}, { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } }));
  }
  assert.equal(effects, 0);
  const out = await dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'false' },
    MODEL_DOMAIN_PLAN_PREPARATION_TOOL, {}, { rpc: async () => anchors(), submitOwnerRequest: async () => { throw new Error('forbidden'); } });
  assert.equal(out.actual_execution, 'NONE');
});
test('new plan route is independent of the historical non-executable M1 placeholder', () => {
  const writer = readFileSync(new URL('../../../development/contracts/model-program/stage-admission/repo-integration-candidate/unvalidated-full-domain/native-m1-atomic-writer.candidate.sql', import.meta.url), 'utf8');
  assert(writer.includes("'hash_binding','ORIGINAL_EXACT_SERVER_HASH_GUARD_NO_BODY_HASH_FALLBACK'"));
  assert(!writer.includes("'hash_mapping'"));
  const oldTemplate = readFileSync(new URL('../worker/model-domain-m1-bootstrap-plan.mjs', import.meta.url), 'utf8');
  assert(oldTemplate.includes('M1_CREATE_PLAN_NOT_EXECUTABLE'));
  assert(!source.includes('model-domain-m1-bootstrap-plan'));
  const preparation = readFileSync(new URL('../worker/model-domain-plan-preparation.mjs', import.meta.url), 'utf8');
  assert(!preparation.includes('model-domain-m1-bootstrap-plan'));
});
test('actual Worker call captures one current Binding, exposes a proposal and never submits a Native request', async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  const token = 'clued_bnd_' + 'a'.repeat(64);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.pathname, '/rest/v1/rpc/clued_model_dataset_split_owner_anchor_refs_candidate');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { p_token_hash: tokenHash, p_input: { schema: 'clued.model-owner-anchor-refs/1' } });
    calls.push(target.pathname);
    return Response.json(anchors());
  };
  const env = { PROJECT_VIEWS_V2: 'true', CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'false',
    ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
  const request = bearer => new Request('https://clued.test/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: MODEL_DOMAIN_PLAN_PREPARATION_TOOL, arguments: {} } }) });
  try {
    for (const [bearer,status] of [[undefined,401],['account-session',403]]) {
      assert.equal((await worker.fetch(request(bearer),env,{waitUntil(){}})).status,status);
    }
    assert.equal(calls.length,0);
    const response = await worker.fetch(request(token),env,{waitUntil(){}});
    assert.equal(response.status,200);
    const body = await response.json();
    assert.equal(body.result.structuredContent.status,'PLAN_ARTIFACT_PROPOSAL_UNCOMMITTED_UNAUTHORIZED');
    assert.equal(body.result.structuredContent.authority_effect,'NONE');
    assert.deepEqual(calls,['/rest/v1/rpc/clued_model_dataset_split_owner_anchor_refs_candidate']);
    assert(!JSON.stringify(body).includes(token)); assert(!JSON.stringify(body).includes(tokenHash));
  } finally { globalThis.fetch = previousFetch; }
});
