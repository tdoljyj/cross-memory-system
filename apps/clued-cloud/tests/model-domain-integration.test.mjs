import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DOMAIN_POLICY as P } from '../worker/model-domain-policy.mjs';
import { POLICY } from '../worker/model-domain-readonly.mjs';
import { modelDomainTools, MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL,
  MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL } from '../worker/model-domain-tools.ts';

// Node's built-in type stripping executes the same candidate dispatch module.
// Production TypeScript compilation is a separate integration gate.
const dispatchUrl = new URL('../worker/model-domain-dispatch.ts', import.meta.url);
const source = stripTypeScriptTypes(readFileSync(dispatchUrl, 'utf8')).replace(
  /from "(\.\/[^\"]+)"/g, (_, relative) => {
    const target = relative === './model-domain-tools' ? relative + '.ts' : relative;
    return `from ${JSON.stringify(new URL(target, dispatchUrl).href)}`;
  });
const { dispatchModelDomainTool } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selectors = { permission_record_id: id(1), producer_registration_id: id(2), recognition_record_id: id(3) };
const bootstrapInput = { producer_record_id: id(60), permission_record_id: id(61), recognition_record_id: id(62),
  idempotency_key: 'native-bootstrap-integration', immutable_plan_resource: 'repo:tdoljyj/cross-memory-system/' + '1'.repeat(40) + '/development/contracts/model-program/stage-admission/BootstrapExactTest.json' };
const anchorOutput = () => ({
  owner_adoption_server_ref: { id: P.domain.owner_adoption.canonical_record_id, version: 1, content_hash: 'a'.repeat(64) },
  final_recognizer_server_ref: { id: P.server.owner_final_recognizer.record_ref.id, version: 1, content_hash: 'b'.repeat(64) },
  status: 'OWNER_ANCHOR_PROJECTION_REFS_ONLY', projection_only: true, source_scope: POLICY.scope,
  authority_effect: 'NONE', domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED',
});

test('feature OFF rejects every model-domain branch before any RPC or Owner-request submission', async () => {
  for (const name of [MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL]) {
    let effects = 0;
    const transport = { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } };
    await assert.rejects(dispatchModelDomainTool({}, name, {}, transport));
    assert.equal(effects, 0);
  }
});
test('bootstrap request remains independently OFF when readonly sources are enabled', async () => {
  let effects = 0;
  await assert.rejects(dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true' }, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL,
    bootstrapInput, { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } }));
  assert.equal(effects, 0);
});
test('registered candidate input schemas expose no client identity, grants, proof, scope or clock', () => {
  for (const tool of modelDomainTools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert(!['actor', 'subject_id', 'binding_id', 'grant', 'user_confirmed', 'clock', 'scope', 'p_token_hash'].some(key => key in tool.inputSchema.properties));
  }
  assert.equal(modelDomainTools.length, 7);
});
test('caller actor or authority proof is rejected before source RPC or submission', async () => {
  for (const [name, input] of [[MODEL_DOMAIN_REFS_TOOL, selectors], [MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, bootstrapInput]]) {
    let effects = 0;
    await assert.rejects(dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' },
      name, { ...input, actor_user_id: id(90) }, { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } }));
    assert.equal(effects, 0);
  }
});
test('bootstrap uses fixed protected anchor RPC then existing Owner entry and returns actual request result', async () => {
  const calls = [];
  const existingRequestResult = { structuredContent: { status: 'pending', request: { id: id(70), confirm_url: 'https://clued.example/confirm/' + id(70) } }, isError: false };
  const out = await dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' },
    MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, bootstrapInput, {
      rpc: async (name, input) => { calls.push(name); assert.deepEqual(input, { schema: 'clued.model-owner-anchor-refs/1' }); return anchorOutput(); },
      submitOwnerRequest: async input => {
        calls.push('EXISTING_OWNER_REQUEST_ENTRY');
        assert.equal(input.action, P.bootstrap_action); assert.equal(input.scope, POLICY.scope); assert.equal(input.task_id, POLICY.task);
        assert.equal(input.resources.length, 6); assert.deepEqual(input.suggested_grant, { expires_seconds: 3600, max_uses: 1 });
        assert(!('user_confirmed' in input)); assert(!('p_token_hash' in input));
        return existingRequestResult;
      },
    });
  assert.deepEqual(calls, ['clued_model_dataset_split_owner_anchor_refs_candidate', 'EXISTING_OWNER_REQUEST_ENTRY']);
  assert.equal(out, existingRequestResult); assert(!JSON.stringify(out).includes('actual_execution'));
});
test('private actor or raw Owner row in anchor response fails before Native request effect', async () => {
  let submissions = 0;
  await assert.rejects(dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' },
    MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, bootstrapInput, { rpc: async () => ({ ...anchorOutput(), actor_user_id: id(90) }),
      submitOwnerRequest: async () => { submissions++; } }));
  assert.equal(submissions, 0);
});
test('exact integration candidate captures one Request/Binding and never imports or calls atomic writer', () => {
  // The integrated repository must contain the actual Worker callsite.
  const worker = new URL('../worker/continuity.ts', import.meta.url);
  const preview = readFileSync(worker, 'utf8');
  assert(preview.includes('submitOwnerRequest: async (input) => await callOwnerRequest(request, env, input)'));
  const begin = preview.indexOf('async function callModelDomainTool(');
  const end = preview.indexOf('// IntegrationRuntime §12.3:', begin);
  const branch = preview.slice(begin, end);
  assert(branch.indexOf('!modelDomainSourceEnabled(env)') < branch.indexOf('const token = bearerToken(request)'));
  assert(branch.includes('p_token_hash: tokenHash, p_input: input'));
  assert(!branch.includes('clued_record_mutate')); assert(!branch.includes('atomic-writer')); assert(!branch.includes('user_confirmed'));
});
