import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

// BUG-20261007-001: a write the database rejected or failed comes back as an M1
// envelope ({status, error_code}, HTTP 200, no `error` field). Over MCP it must be
// a tool error, as it already is on REST (m1HttpStatus) and on the storage,
// integration and owner_request tools.
const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-tool-error-status-'));
await build({ entryPoints: ['worker/continuity.ts'], outdir: directory, bundle: true,
  platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { handleContinuityRequest: handle } = await import(pathToFileURL(path.join(directory, 'continuity.mjs')));
const env = { SUPABASE_URL: 'https://storage.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
  PROJECT_VIEWS_V2: 'true' };
const token = 'clued_bnd_isolated-fixture-0123456789abcdefghijklmnop';

const recordUpdate = {
  operation: 'update', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
  scope: 'global', id: '00000000-0000-4000-8000-000000000001', base_version: 1,
  idempotency_key: 'fixture:tool-error-status', authority: 'observed', confidence_reason: 'fixture',
  mutation: { type_fields: { execution_bucket: 'next' } },
};

const envelope = (status, error_code = null) => ({
  status, error_code, receipt_id: '00000000-0000-4000-8000-0000000000aa', target_refs: [],
  committed_versions: {}, canonical_version: null, event_ids: [], evidence_ids: [], artifact_refs: [],
});

async function callTool(name, args, rpcBody) {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(rpcBody);
    const response = await handle(new Request('https://clued.example/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), env);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  } finally { globalThis.fetch = original; }
}

for (const [status, code] of [['rejected', 'RECORD_VERSION_CONFLICT'], ['failed', 'P0001']]) {
  test(`a ${status} write is an MCP tool error and keeps its envelope`, async () => {
    const result = await callTool('clued_record_mutate', recordUpdate, envelope(status, code));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, status);
    assert.equal(result.structuredContent.error_code, code);
    assert.equal(JSON.parse(result.content[0].text).error_code, code);
  });
}

test('a committed write is not a tool error', async () => {
  const result = await callTool('clued_record_mutate', recordUpdate, envelope('committed'));
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, 'committed');
});

test('every write tool family reports a rejected or failed envelope as a tool error', async () => {
  const saved = { ...env };
  Object.assign(env, { P5_TENANT_WRITES: 'true', CLUED_P5_GATEWAY_TOKEN: 'fixture-gateway-jwt' });
  try {
    for (const name of [
      'clued_decision_supersede', 'clued_evidence_ingest', 'clued_event_append',
      'clued_project_mutate',
      'clued_intake_submit', 'clued_intake_withdraw', 'clued_knowledge_propose',
      'clued_mtpe_owner_pin',
      'clued_p5_workspace_switch',
    ]) {
      for (const status of ['rejected', 'failed']) {
        const result = await callTool(name, {}, envelope(status, 'CAPABILITY_DENIED'));
        assert.equal(result.isError, true, `${name} ${status}`);
        assert.equal(result.structuredContent.error_code, 'CAPABILITY_DENIED', `${name} ${status}`);
      }
      assert.equal((await callTool(name, {}, envelope('committed'))).isError, false, name);
    }
  } finally { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, saved); }
});

test('a context pack the database refused is a tool error, as on REST (422)', async () => {
  const refused = await callTool('clued_context_pack', {},
    { status: 'rejected', error_code: 'CONTEXT_POLICY_REQUIRED', authoritative: false });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error_code, 'CONTEXT_POLICY_REQUIRED');
});

test('a result without a top-level status keeps its earlier isError', async () => {
  const listed = await callTool('clued_record_list', {}, { records: [{ status: 'rejected' }] });
  assert.equal(listed.isError, false);
  const refused = await callTool('clued_record_list', {}, { error: 'scope_denied' });
  assert.equal(refused.isError, true);
});

test('only the exact top-level values count: verdicts and nested statuses are not refusals', async () => {
  for (const [name, body] of [
    ['clued_mtpe_validate', { status: 'fail', violations: [] }],
    ['clued_session_reconcile', { status: 'reconciliation_required' }],
    ['clued_audit_receipts', { status: 'ok', receipts: [{ status: 'failed', error_code: 'P0001' }] }],
    ['clued_record_mutate', { status: 'Rejected' }],
  ]) {
    const result = await callTool(name, name === 'clued_record_mutate' ? recordUpdate : {}, body);
    assert.equal(result.isError, false, name);
  }
});

test('the export reports a rejected Receipt as a tool error', async () => {
  const rejected = await callTool('clued_canonical_export', {},
    { replayed: true, receipt: { status: 'rejected', error_code: 'REQUEST_HASH_MISMATCH' }, snapshot: null });
  assert.equal(rejected.isError, true);
  const committed = await callTool('clued_canonical_export', {},
    { replayed: false, receipt: { status: 'committed', error_code: null }, snapshot: { files: [] } });
  assert.equal(committed.isError, false);
});

test('work claims and agent messages keep their structured-result refusals (Task 934d981c)', async () => {
  const saved = { ...env };
  Object.assign(env, { CLUED_WORK_CLAIMS_V1: 'true', CLUED_AGENT_MESSAGES_V1: 'true' });
  try {
    const claim = await callTool('clued_work_claim', {
      task_id: '44444444-4444-4444-8444-444444444444', write_set: ['apps/**'], idempotency_key: 'fixture:claim',
      holder_label: 'fixture',
    }, { status: 'rejected', error_code: 'work_claim_conflict', conflicts: [] });
    assert.equal(claim.isError, false);
    const send = await callTool('clued_agent_message_send', {
      to: { claim_id: '33333333-3333-4333-8333-333333333333' }, subject: 's', body: 'b', idempotency_key: 'fixture:send',
    }, { status: 'rejected', error_code: 'agent_message_claim_not_live' });
    assert.equal(send.isError, false);
  } finally { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, saved); }
});

test('an Owner Request that failed is a tool error, like one that was rejected', async () => {
  const saved = { ...env };
  env.CLUED_OWNER_REQUESTS_V1 = 'true';
  try {
    const args = { request_id: '55555555-5555-4555-8555-555555555555', scope: 'global' };
    const failed = await callTool('clued_owner_request', args, { status: 'failed', error_code: 'P0001' });
    assert.equal(failed.isError, true);
    const rejected = await callTool('clued_owner_request', args, { status: 'rejected', error_code: 'owner_request_not_found' });
    assert.equal(rejected.isError, true);
  } finally { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, saved); }
});
