import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DOMAIN_POLICY as P } from '../worker/model-domain-policy.mjs';
import { POLICY } from '../worker/model-domain-readonly.mjs';
import { modelDomainTools, MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL,
  MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL, MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL } from '../worker/model-domain-tools.ts';

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
const bootstrapInput = {"producer_record_id":"36f0b1f1-3352-4a0a-abab-011b39164143","permission_record_id":"adfb0f98-c415-42a5-944c-c5fc91af0fc6","recognition_record_id":"1f443b83-e612-4bec-84ea-b5f2e0e22eb5","idempotency_key":"model-bootstrap-1b397478-b792-4d73-864b-cee9af714052","immutable_plan_resource":"repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json"};
const anchorOutput = () => ({
  owner_adoption_server_ref: { id: P.domain.owner_adoption.canonical_record_id, version: 1, content_hash: P.domain.owner_adoption.record_content_sha256 },
  final_recognizer_server_ref: { id: P.server.owner_final_recognizer.record_ref.id, version: 1, content_hash: P.server.owner_final_recognizer.record_ref.content_hash },
  status: 'OWNER_ANCHOR_PROJECTION_REFS_ONLY', projection_only: true, source_scope: POLICY.scope,
  authority_effect: 'NONE', domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED',
});

test('feature OFF rejects every model-domain branch before any RPC or Owner-request submission', async () => {
  for (const name of [MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, MODEL_DOMAIN_BOOTSTRAP_READINESS_TOOL, MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL]) {
    let effects = 0;
    const transport = { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } };
    await assert.rejects(dispatchModelDomainTool({}, name, {}, transport));
    assert.equal(effects, 0);
  }
});
test('bootstrap request remains independently OFF when readonly sources are enabled', async () => {
  let effects = 0;
  await assert.rejects(dispatchModelDomainTool({ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_MODEL_DOMAIN_SOURCE_V1: 'true' }, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL,
    bootstrapInput, { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } }));
  assert.equal(effects, 0);
});
test('registered candidate input schemas expose no client identity, grants, proof, scope or clock', () => {
  for (const tool of modelDomainTools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert(!['actor', 'subject_id', 'binding_id', 'grant', 'user_confirmed', 'clock', 'scope', 'p_token_hash'].some(key => key in tool.inputSchema.properties));
  }
  assert.equal(modelDomainTools.length, 9);
});
test('caller actor or authority proof is rejected before source RPC or submission', async () => {
  for (const [name, input] of [[MODEL_DOMAIN_REFS_TOOL, selectors], [MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, bootstrapInput]]) {
    let effects = 0;
    await assert.rejects(dispatchModelDomainTool({ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' },
      name, { ...input, actor_user_id: id(90) }, { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } }));
    assert.equal(effects, 0);
  }
});
test('bootstrap uses fixed protected anchor RPC then existing Owner entry and returns actual request result', async () => {
  const calls = [];
  const existingRequestResult = { structuredContent: { status: 'pending', request: { id: id(70), confirm_url: 'https://clued.example/confirm/' + id(70) } }, isError: false };
  const out = await dispatchModelDomainTool({ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' },
    MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL, bootstrapInput, {
      rpc: async (name, input) => { calls.push(name);
        if(name==='clued_model_dataset_split_owner_anchor_refs_candidate'){assert.deepEqual(input,{schema:'clued.model-owner-anchor-refs/1'});return anchorOutput();}
        assert.equal(name,'clued_model_dataset_split_bootstrap_readiness_candidate');assert.deepEqual(input,{});
        const anchors=anchorOutput();return {status:'FIXED_OWNER_CHAIN_AND_PLAN_READINESS_ONLY',
          owner_adoption_server_ref:anchors.owner_adoption_server_ref,final_recognizer_server_ref:anchors.final_recognizer_server_ref,
          immutable_plan_resource:bootstrapInput.immutable_plan_resource,plan_sha256:'fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea',
          max_uses:1,max_window_seconds:3600,evaluated_at:new Date().toISOString(),bootstrap_write_authorized:false,
          domain_permission:'NOT_GRANTED',m2_verdict:'NOT_ISSUED',private_actor_fields_exposed:false};
      },
      submitOwnerRequest: async input => {
        calls.push('EXISTING_OWNER_REQUEST_ENTRY');
        assert.equal(input.action, P.bootstrap_action); assert.equal(input.scope, POLICY.scope); assert.equal(input.task_id, POLICY.task);
        assert.equal(input.resources.length, 6); assert.deepEqual(input.suggested_grant, { expires_seconds: 3600, max_uses: 1 });
        assert(!('user_confirmed' in input)); assert(!('p_token_hash' in input));
        return existingRequestResult;
      },
    });
  assert.deepEqual(calls, ['clued_model_dataset_split_owner_anchor_refs_candidate', 'clued_model_dataset_split_bootstrap_readiness_candidate', 'EXISTING_OWNER_REQUEST_ENTRY']);
  assert.equal(out, existingRequestResult); assert(!JSON.stringify(out).includes('actual_execution'));
});
test('private actor or raw Owner row in anchor response fails before Native request effect', async () => {
  let submissions = 0;
  await assert.rejects(dispatchModelDomainTool({ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' },
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

test('commit remains OFF independently of source reads before any effect',async()=>{
 let calls=0;await assert.rejects(dispatchModelDomainTool({ CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",CLUED_MODEL_DOMAIN_SOURCE_V1:'true'},MODEL_DOMAIN_BOOTSTRAP_COMMIT_TOOL,{},{
 rpc:async()=>{calls++;},submitOwnerRequest:async()=>{calls++;}}));assert.equal(calls,0);
});
test('Worker completion uncertainty stays a structured error and never success-shaped',()=>{
 const worker=readFileSync(new URL('../worker/continuity.ts',import.meta.url),'utf8');
 const start=worker.indexOf('if (error instanceof BootstrapCompletionUnknown)');
 assert.ok(start>0);const branch=worker.slice(start,start+480);
 assert.match(branch,/completion_unknown: true/);assert.match(branch,/retry_allowed: false/);assert.match(branch,/isError: true/);
});
