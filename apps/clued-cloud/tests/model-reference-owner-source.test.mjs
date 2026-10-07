import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { ALLOWED, PROHIBITED, SCOPE, TASK } from '../worker/model-reference-owner-contract.mjs';
import { ownerApprovalInputSchema, ownerApprovalOutputSchema } from '../worker/model-reference-owner-schema.mjs';
import { readOwnerApprovalRefsWithExistingBindingRpc, SOURCE_RPC } from '../worker/model-reference-owner-source.mjs';
import { modelDomainTools, MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL, modelDomainToolPolicies, isModelDomainTool } from '../worker/model-domain-tools.ts';
const dispatchUrl = new URL('../worker/model-domain-dispatch.ts', import.meta.url);
const dispatchSource = stripTypeScriptTypes(readFileSync(dispatchUrl, 'utf8')).replace(/from "(\.\/[^\"]+)"/g,
  (_, relative) => `from ${JSON.stringify(new URL(relative === './model-domain-tools' ? relative + '.ts' : relative, dispatchUrl).href)}`);
const { dispatchModelDomainTool } = await import('data:text/javascript;base64,' + Buffer.from(dispatchSource).toString('base64'));
const time = Date.parse('2026-10-07T12:00:00Z');
// Synthetic DTOs exercise transport guards only; they are not actual Owner proof.
function input(now = time) {
  return { record_ref: { id: '11111111-1111-4111-8111-111111111111', version: 1, content_hash: '1'.repeat(64) },
    receipt_id: '22222222-1111-4111-8111-111111111111', request_sha256: '2'.repeat(64), approval_binding: {
      allowed_operations: [...ALLOWED], budget: { currency: 'USD', currency_exponent: 2, currency_profile_digest: '3'.repeat(64), max_attempts: 1,
        max_compute: { device_class: 'PC', max_compute_bytes: 1 }, max_concurrency: 1, max_cost_minor_units: 0, max_input_bytes: 1, max_input_tokens: 1,
        max_output_bytes: 1, max_output_tokens: 1, max_parallel_experiments: 1, max_requests: 1, max_response_bytes: 1, max_storage_bytes: 1,
        max_total_tokens: 2, max_wall_time: 1, provider_deadline_at: new Date(now + 1800000).toISOString() }, candidate_role: 'M2_REFERENCE_BASELINE',
      canonical_scope: SCOPE, confirmation_origin: 'OWNER_CURRENT_CONVERSATION_EXACT_REQUEST', host_ref: 'SYNTHETIC_TRANSPORT_ONLY',
      kind: 'M2_REFERENCE_QUALIFICATION_PROFILE_EXACT_APPROVAL', materializer_code_sha256: '4'.repeat(64), output_target_ref: 'artifact:never-issued',
      parent_boundary: 'QUALIFICATION', profile_id: 'M2-REFERENCE-QUALIFICATION-PC-33333333-1111-4111-8111-111111111111',
      prohibited_operations: [...PROHIBITED], purpose_id: 'qualification', request_sha256: '2'.repeat(64), source_stage: 'M1_FIXED_REFERENCE',
      task_id: TASK, template_sha256: '5'.repeat(64), window: { not_before: new Date(now - 1000).toISOString(), stop_at: new Date(now + 1800000).toISOString() },
    } };
}
function output(i, now = time) {
  return { status: 'CURRENT_EXACT_OWNER_APPROVAL_REFS_ONLY', approval_record_ref: i.record_ref, receipt_id: i.receipt_id,
    event_id: '123', canonical_version: 1, request_sha256: i.request_sha256, template_sha256: i.approval_binding.template_sha256,
    profile_id: i.approval_binding.profile_id, source_scope: SCOPE, task_id: TASK, evaluated_at: new Date(now).toISOString(),
    authority_effect: 'NONE', actual_execution: 'NONE', profile_issued: false, private_actor_fields_exposed: false, record_body_exposed: false };
}
test('new public branch remains hidden/denied before transport when the existing source flag is off', async () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    let rpc = 0, native = 0;
    await assert.rejects(dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: flag }, MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL,
      input(), { rpc: async () => { rpc++; }, submitOwnerRequest: async () => { native++; } }));
    assert.equal(rpc, 0); assert.equal(native, 0);
  }
});
test('source-on/Bootstrap-off transports only fixed source RPC and returns exactly public refs', async () => {
  const now = Date.now(), i = input(now); let rpc = 0, native = 0;
  const result = await dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'false' },
    MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL, i, { rpc: async (name, body) => { rpc++; assert.equal(name, SOURCE_RPC); assert.deepEqual(body, i); return output(i, now); },
      submitOwnerRequest: async () => { native++; } });
  assert.equal(rpc, 1); assert.equal(native, 0); assert.equal(Object.keys(result).length, 16);
  assert.equal('source_ref' in result, false); assert.equal(result.profile_issued, false);
});
test('caller Actor/verified fields are rejected before source transport', async () => {
  for (const key of ['actor_user_id', 'verified', 'p_token_hash']) {
    let calls = 0;
    await assert.rejects(readOwnerApprovalRefsWithExistingBindingRpc(async () => { calls++; }, { ...input(), [key]: 'caller' }, () => time));
    assert.equal(calls, 0);
  }
});
test('foreign fixed semantics fail before source transport', async () => {
  for (const [key, value] of [['task_id', 'foreign'], ['canonical_scope', 'global'], ['source_stage', 'T1'], ['candidate_role', 'FINAL_PRODUCT_CANDIDATE']]) {
    const i = input(); i.approval_binding[key] = value; let calls = 0;
    await assert.rejects(readOwnerApprovalRefsWithExistingBindingRpc(async () => { calls++; }, i, () => time)); assert.equal(calls, 0);
  }
});
test('private Actor/body/opaque source fields in server reply cannot pass the public adapter', async () => {
  const i = input();
  for (const key of ['actor_user_id', 'content', 'source_ref'])
    await assert.rejects(readOwnerApprovalRefsWithExistingBindingRpc(async () => ({ ...output(i), [key]: 'private' }), i, () => time));
});
test('unknown, issued and stale server outputs never become qualification or permission', async () => {
  const i = input();
  for (const delta of [{ status: 'UNKNOWN' }, { profile_issued: true }, { evaluated_at: '2026-10-07T11:00:00Z' }])
    await assert.rejects(readOwnerApprovalRefsWithExistingBindingRpc(async () => ({ ...output(i), ...delta }), i, () => time));
});
test('transport failure exposes only generic refusal and no private service message', async () => {
  await assert.rejects(readOwnerApprovalRefsWithExistingBindingRpc(async () => { throw new Error('private actor body'); }, input(), () => time),
    e => !e.message.includes('private') && e.code === 'EXACT_OWNER_SOURCE_DENIED_OR_UNAVAILABLE');
});
test('schema is closed on four selectors, exact18 approval and exact18 budget, public16 fields', () => {
  assert.deepEqual(ownerApprovalInputSchema.required.sort(), ['approval_binding', 'receipt_id', 'record_ref', 'request_sha256']);
  const a = ownerApprovalInputSchema.properties.approval_binding;
  assert.equal(a.required.length, 18); assert.equal(a.additionalProperties, false); assert.equal(a.properties.budget.required.length, 18);
  assert.equal(a.properties.task_id.const, TASK); assert.equal(a.properties.canonical_scope.const, SCOPE);
  assert.equal(ownerApprovalOutputSchema.required.length, 16); assert.equal(ownerApprovalOutputSchema.additionalProperties, false);
  assert(!['actor', 'source_ref', 'content'].some(k => k in ownerApprovalOutputSchema.properties));
});
test('five known tools include four source-only reads while Bootstrap remains separate', () => {
  assert.equal(modelDomainTools.length, 5); assert.equal(isModelDomainTool(MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL), true);
  assert.deepEqual(modelDomainToolPolicies[MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL].scopes, ['context:read']);
  assert.equal(modelDomainToolPolicies[MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL].readOnlyHint, true);
  assert.equal(modelDomainTools.filter(t => modelDomainToolPolicies[t.name].readOnlyHint).length, 4);
});
