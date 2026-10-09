import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DOMAIN_POLICY as P } from '../worker/model-domain-policy.mjs';
import { POLICY } from '../worker/model-domain-readonly.mjs';
import { EXACT_BOOTSTRAP_PLAN, BootstrapReadinessDenied } from '../worker/model-domain-bootstrap-source.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const url = new URL('../worker/model-domain-dispatch.ts', import.meta.url);
const source = stripTypeScriptTypes(readFileSync(url, 'utf8')).replace(
  /from "(\.\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(new URL(relative === './model-domain-tools' ? relative + '.ts' : relative, url).href)}`,
);
const { dispatchModelDomainTool } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const flags = { CLUED_MODEL_DOMAIN_SOURCE_V1: 'true', CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: 'true' };
const input = { ...EXACT_BOOTSTRAP_PLAN.targets, idempotency_key: EXACT_BOOTSTRAP_PLAN.idempotency_key, immutable_plan_resource: EXACT_BOOTSTRAP_PLAN.resource };
const anchors = () => ({
  status: 'OWNER_ANCHOR_PROJECTION_REFS_ONLY', projection_only: true, source_scope: POLICY.scope,
  authority_effect: 'NONE', domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED',
  owner_adoption_server_ref: { id: P.domain.owner_adoption.canonical_record_id, version: 1, content_hash: P.domain.owner_adoption.record_content_sha256 },
  final_recognizer_server_ref: { ...P.server.owner_final_recognizer.record_ref },
});
const readiness = () => ({
  status: 'FIXED_OWNER_CHAIN_AND_PLAN_READINESS_ONLY',
  owner_adoption_server_ref: anchors().owner_adoption_server_ref,
  final_recognizer_server_ref: anchors().final_recognizer_server_ref,
  immutable_plan_resource: EXACT_BOOTSTRAP_PLAN.resource, plan_sha256: EXACT_BOOTSTRAP_PLAN.sha256,
  max_uses: 1, max_window_seconds: 3600, evaluated_at: new Date().toISOString(),
  bootstrap_write_authorized: false, domain_permission: 'NOT_GRANTED', m2_verdict: 'NOT_ISSUED', private_actor_fields_exposed: false,
});

for (const [label, produce] of [
  ['unavailable readiness RPC', () => { throw new Error('private fixture detail'); }],
  ['invalid readiness shape', () => ({ ...readiness(), private_actor: 'private fixture detail' })],
  ['expired readiness timestamp', () => ({ ...readiness(), evaluated_at: new Date(Date.now() - 300001).toISOString() })],
  ['future readiness timestamp', () => ({ ...readiness(), evaluated_at: new Date(Date.now() + 60000).toISOString() })],
]) {
  test(`request preserves typed ${label} and never submits`, async () => {
    let submissions = 0;
    await assert.rejects(dispatchModelDomainTool(flags, 'clued_model_dataset_split_bootstrap_request', input, {
      rpc: async name => name === 'clued_model_dataset_split_owner_anchor_refs_candidate' ? anchors() : produce(),
      submitOwnerRequest: async () => { submissions++; },
    }), error => error instanceof BootstrapReadinessDenied && !error.message.includes('private fixture detail'));
    assert.equal(submissions, 0);
  });
}

test('successful readiness still submits the original exact Owner request once', async () => {
  let submissions = 0;
  const result = { fixture_only: true };
  const out = await dispatchModelDomainTool(flags, 'clued_model_dataset_split_bootstrap_request', input, {
    rpc: async name => name === 'clued_model_dataset_split_owner_anchor_refs_candidate' ? anchors() : readiness(),
    submitOwnerRequest: async request => {
      submissions++;
      assert.equal(request.idempotency_key, EXACT_BOOTSTRAP_PLAN.idempotency_key);
      assert.deepEqual(request.suggested_grant, { expires_seconds: 3600, max_uses: 1 });
      assert.equal(request.resources.length, 6);
      return result;
    },
  });
  assert.equal(out, result);
  assert.equal(submissions, 1);
});

test('the existing Worker already maps the preserved typed readiness denial', () => {
  const worker = readFileSync(new URL('../worker/continuity.ts', import.meta.url), 'utf8');
  assert.match(worker, /error instanceof BootstrapReadinessDenied\) throw new HttpError\(403, "DatasetSplit bootstrap readiness denied or unavailable\."\)/);
});

test('actual Worker reports readiness rejection without an Owner request or private detail', async () => {
  const worker = await loadContinuityWorker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  const token = 'clued_bnd_' + 'fixture'.repeat(10);
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith('/clued_model_dataset_split_owner_anchor_refs_candidate')) return Response.json(anchors());
    assert(path.endsWith('/clued_model_dataset_split_bootstrap_readiness_candidate'));
    return Response.json({ ...readiness(), evaluated_at: new Date(Date.now() + 60000).toISOString() });
  };
  try {
    const request = new Request('https://clued.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_model_dataset_split_bootstrap_request', arguments: input } }),
    });
    const response = await worker.fetch(request, { PROJECT_VIEWS_V2: 'true', ...flags, CLUED_OWNER_REQUESTS_V1: 'true' }, { waitUntil() {} });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.message, 'DatasetSplit bootstrap readiness denied or unavailable.');
    assert.equal(calls.length, 2);
    assert(!calls.some(path => path.includes('owner_request')));
    assert(!JSON.stringify(body).includes(token));
    assert(!JSON.stringify(body).includes(P.domain.owner_adoption.canonical_record_id));
  } finally { globalThis.fetch = originalFetch; }
});
