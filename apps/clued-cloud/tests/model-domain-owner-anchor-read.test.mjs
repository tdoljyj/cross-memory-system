import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { readOwnerAnchorsWithExistingBindingRpc, OWNER_ANCHOR_IDS, OWNER_ANCHOR_RPC } from '../worker/model-domain-owner-anchor-rpc.mjs';
import { modelDomainTools, modelDomainToolPolicies, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL } from '../worker/model-domain-tools.ts';
const dispatchUrl = new URL('../worker/model-domain-dispatch.ts', import.meta.url);
const source = stripTypeScriptTypes(readFileSync(dispatchUrl, 'utf8')).replace(/from "(\.\/[^\"]+)"/g, (_, relative) => {
  const target = relative === './model-domain-tools' ? relative + '.ts' : relative;
  const local = new URL(target, dispatchUrl);
  return `from ${JSON.stringify(local.href)}`;
});
const { dispatchModelDomainTool } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const fixed = { schema: 'clued.model-owner-anchor-refs/1' };
const positive = () => ({ owner_adoption_server_ref: { id: OWNER_ANCHOR_IDS[0], version: 1, content_hash: 'a'.repeat(64) },
  final_recognizer_server_ref: { id: OWNER_ANCHOR_IDS[1], version: 1, content_hash: 'b'.repeat(64) },
  status: 'OWNER_ANCHOR_PROJECTION_REFS_ONLY', projection_only: true,
  source_scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f', authority_effect: 'NONE', domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED' });

test('source flag OFF denies the fixed Owner read before every RPC or Owner request', async () => {
  let effects = 0;
  await assert.rejects(dispatchModelDomainTool({}, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL, {},
    { rpc: async () => { effects++; }, submitOwnerRequest: async () => { effects++; } }));
  assert.equal(effects, 0);
});
test('source flag alone reads fixed Owner refs and never calls Owner request with bootstrap OFF', async () => {
  let reads = 0, submissions = 0;
  const out = await dispatchModelDomainTool({ CLUED_MODEL_DOMAIN_SOURCE_V1: 'true' }, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL, {}, {
    rpc: async (name, input) => { reads++; assert.equal(name, OWNER_ANCHOR_RPC); assert.deepEqual(input, fixed); return positive(); },
    submitOwnerRequest: async () => { submissions++; throw new Error('Owner-request effect forbidden'); },
  });
  assert.equal(reads, 1); assert.equal(submissions, 0); assert.deepEqual(out, positive());
});
test('empty, omitted or fixed-schema params always become exactly one fixed server request', async () => {
  for (const input of [{}, undefined, fixed]) {
    const out = await readOwnerAnchorsWithExistingBindingRpc(async (name, request) => {
      assert.equal(name, OWNER_ANCHOR_RPC); assert.deepEqual(request, fixed); return positive();
    }, input);
    assert(Object.isFrozen(out)); assert.deepEqual(out, positive());
  }
});
test('caller selector, identity, hash, grant, clock or confirmation proof is refused before RPC', async () => {
  for (const input of [null, [], { schema: 'other' }, { record_id: OWNER_ANCHOR_IDS[0] }, { ...fixed, actor_user_id: OWNER_ANCHOR_IDS[0] },
    { ...fixed, p_token_hash: 'f'.repeat(64) }, { ...fixed, user_confirmed: true }, { ...fixed, clock: 1 }, { ...fixed, grants: [] }]) {
    let reads = 0;
    await assert.rejects(readOwnerAnchorsWithExistingBindingRpc(async () => { reads++; return positive(); }, input));
    assert.equal(reads, 0);
  }
});
test('Actor/raw Record or permission-bearing server response is rejected rather than sanitized into authority', async () => {
  for (const extra of [{ actor_user_id: OWNER_ANCHOR_IDS[0] }, { record: {} }, { domain_permission: 'GRANTED' }, { m2_verdict: 'PASS' }]) {
    await assert.rejects(readOwnerAnchorsWithExistingBindingRpc(async () => ({ ...positive(), ...extra }), {}));
  }
});
test('foreign role/id/version, malformed serverhash and source unavailability fail closed', async () => {
  for (const mutate of [x => x.owner_adoption_server_ref.id = OWNER_ANCHOR_IDS[1], x => x.final_recognizer_server_ref.version = 2,
    x => x.owner_adoption_server_ref.content_hash = 'body-hash-guess', x => x.source_scope = 'global']) {
    const out = positive(); mutate(out); await assert.rejects(readOwnerAnchorsWithExistingBindingRpc(async () => out, {}));
  }
  await assert.rejects(readOwnerAnchorsWithExistingBindingRpc(async () => { throw new Error('not installed'); }, {}));
});
test('fourth tool is read-only context-read only and exposes no arbitrary selectors or caller authority', () => {
  const tool = modelDomainTools.find(x => x.name === MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL);
  assert(tool); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['schema']);
  assert.equal(tool.inputSchema.properties.schema.const, fixed.schema);
  const policy = modelDomainToolPolicies[MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL];
  assert.deepEqual(policy.scopes, ['context:read']); assert.equal(policy.readOnlyHint, true);
});
