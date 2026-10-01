import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-auth-errors-'));
await build({ entryPoints: ['worker/continuity.ts'], outdir: directory, bundle: true,
  platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { handleContinuityRequest: handle } = await import(pathToFileURL(path.join(directory, 'continuity.mjs')));
const env = { SUPABASE_URL: 'https://storage.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' };
const request = token => new Request('https://clued.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_project_list', arguments: { limit: 10 } } }),
});

test('resource denials stay denied without triggering an OAuth challenge', async () => {
  const original = globalThis.fetch;
  try {
    for (const message of ['binding_not_authorized', 'resource_action_not_authorized', 'authorization_revoked_or_expired']) {
      let calls = 0;
      globalThis.fetch = async url => {
        calls++;
        assert.equal(new URL(url).pathname, '/rest/v1/rpc/clued_project_list_v2');
        return Response.json({ code: '42501', message }, { status: 401 });
      };
      const response = await handle(request('clued_bnd_isolated-fixture'), env);
      assert.equal(response.status, 403);
      assert.equal(response.headers.has('www-authenticate'), false);
      const body = await response.json();
      assert.equal(body.error.code, -32000);
      assert.equal(body.error.message, message);
      assert.equal(body.error.data.code, '42501');
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('invalid JWT still challenges authentication', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
  try {
    const response = await handle(request('expired-jwt-fixture'), env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
    assert.equal((await response.json()).error.code, -32001);
  } finally { globalThis.fetch = original; }
});

test('missing credentials challenge before storage; authorized empty list succeeds', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ projects: [] }); };
  try {
    const denied = await handle(request(), env);
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);
    const response = await handle(request('clued_bnd_isolated-fixture'), env);
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual((await response.json()).result.structuredContent, { projects: [] });
  } finally { globalThis.fetch = original; }
});

test('contract-rule rejections return a tool error instead of an HTTP 403', async () => {
  const original = globalThis.fetch;
  try {
    for (const message of ['lifecycle_action_cannot_edit_record_content', 'resume_required', 'project_scope_mismatch',
      'checkpoint_event_not_authorized']) {
      globalThis.fetch = async () => Response.json({ code: '42501', message }, { status: 401 });
      const response = await handle(request('clued_bnd_isolated-fixture'), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.has('www-authenticate'), false);
      const { result } = await response.json();
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.status, 'rejected');
      assert.equal(result.structuredContent.error.code, message);
      assert.equal(result.structuredContent.error.category, 'request_rule');
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }
    globalThis.fetch = async () => Response.json(
      { code: '42501', message: 'lifecycle_action_cannot_edit_record_content' }, { status: 401 });
    const { result } = await (await handle(request('clued_bnd_isolated-fixture'), env)).json();
    assert.match(result.structuredContent.error.hint, /closure_summary/);
  } finally { globalThis.fetch = original; }
});

test('a checkpoint covering another context\'s events is a tool error, not a firewall-looking 403', async () => {
  // BUG-20260924-003: this 42501 reached Hosts as HTTP 403, which they render as
  // "blocked by a firewall", and the Agent misreported an infrastructure failure.
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      assert.equal(new URL(url).pathname, '/rest/v1/rpc/clued_mcp_commit_checkpoint');
      return Response.json({ code: '42501', message: 'checkpoint_event_not_authorized' }, { status: 401 });
    };
    const response = await handle(new Request('https://clued.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer clued_bnd_isolated-fixture' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'clued_session_checkpoint', arguments: {
          session_token: 'clued_ses_fixture', base_version: 1, context_key: 'global', snapshot: {},
          summary: 's', next_action: 'n',
          coverage: { mode: 'explicit', contexts: ['global'], tracks: ['t'], event_ids: [7] } } } }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('www-authenticate'), false);
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'checkpoint_event_not_authorized');
    assert.equal(result.structuredContent.error.category, 'request_rule');
    assert.match(result.structuredContent.error.hint, /context_key/);
  } finally { globalThis.fetch = original; }
});

test('a malformed resume context_key is a tool error naming the key format', async () => {
  // A bare project UUID reached Hosts as HTTP 403 ("blocked by a firewall").
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      assert.equal(new URL(url).pathname, '/rest/v1/rpc/clued_mcp_restore');
      return Response.json({ code: '42501', message: 'requested_context_not_authorized' }, { status: 401 });
    };
    const response = await handle(new Request('https://clued.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer clued_bnd_isolated-fixture' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'clued_session_resume', arguments: { context_key: '00000000-0000-4000-8000-000000000000' } } }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('www-authenticate'), false);
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'requested_context_not_authorized');
    assert.equal(result.structuredContent.error.category, 'request_rule');
    assert.match(result.structuredContent.error.hint, /project:<canonical_project_id>/);
  } finally { globalThis.fetch = original; }
});

test('unlisted and authorization denials keep the HTTP 403', async () => {
  const original = globalThis.fetch;
  try {
    for (const message of ['record_not_authorized', 'context_access_denied', 'some_future_denial']) {
      globalThis.fetch = async () => Response.json({ code: '42501', message }, { status: 401 });
      const response = await handle(request('clued_bnd_isolated-fixture'), env);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.message, message);
    }
    globalThis.fetch = async () => Response.json({ code: 'P0001', message: 'resume_required' }, { status: 400 });
    assert.equal((await handle(request('clued_bnd_isolated-fixture'), env)).status, 400);
  } finally { globalThis.fetch = original; }
});

const recordEnv = { ...env, PROJECT_VIEWS_V2: 'true' };
const recordInput = {
  operation: 'create', record_type: 'task', record_schema_version: 1,
  lifecycle_status: 'active', scope: 'global', authority: 'user_explicit',
  confidence_reason: 'Owner confirmed the exact fixture record', source_refs: [],
  source_unavailable_reason: 'Isolated transport fixture has no Evidence',
  mutation: { title: 'PRIVATE-TITLE-DO-NOT-ECHO', content: 'PRIVATE-CONTENT-DO-NOT-ECHO',
    type_fields: { execution_bucket: 'later' } }, idempotency_key: 'bug-20261001-001-fixture',
};
const recordRequest = (input, token = 'clued_bnd_isolated-fixture') => new Request('https://clued.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'clued_record_mutate', arguments: input } }),
});

async function recordRejection(input) {
  const response = await handle(recordRequest(input), recordEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('www-authenticate'), false);
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.equal(body.result.isError, true);
  assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent);
  assert.equal(body.result.structuredContent.status, 'rejected');
  assert.equal(body.result.structuredContent.error.code, 'INVALID_RECORD_FIELDS');
  assert.equal(body.result.structuredContent.error.category, 'request_validation');
  const text = JSON.stringify(body);
  assert.equal(text.includes(recordInput.mutation.title), false);
  assert.equal(text.includes(recordInput.mutation.content), false);
  return body.result.structuredContent.error;
}

test('record create exposes exact confirmation error without request text or a storage call', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('invalid create must not reach storage'); };
  try {
    for (const input of [recordInput, { ...recordInput, user_confirmed: false }]) {
      const error = await recordRejection(input);
      assert.deepEqual(error.missing_fields, []);
      assert.deepEqual(error.invalid_fields, [{ field: 'user_confirmed', error: 'authority_escalation_forbidden' }]);
      assert.match(error.hint, /records that the main claim is the Owner's own words in this conversation; do not ask the Owner again/);
      assert.deepEqual(Object.keys(error.create_contract), ['type_specific_fields']);
      assert.deepEqual(error.create_contract.type_specific_fields.task,
        { field: 'execution_bucket', error: 'task_execution_bucket_required' });
    }
  } finally { globalThis.fetch = original; }
});

test('missing source reason and task bucket are actionable tool errors without confirmation hints', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('invalid create must not reach storage'); };
  try {
    const { source_unavailable_reason: _omitted, ...missingReason } = { ...recordInput, user_confirmed: true };
    void _omitted;
    const reason = await recordRejection(missingReason);
    assert.deepEqual(reason.missing_fields, ['source_unavailable_reason']);
    assert.deepEqual(reason.invalid_fields, []);
    assert.equal(reason.hint, undefined);
    const bucket = await recordRejection({ ...recordInput, user_confirmed: true,
      mutation: { ...recordInput.mutation, type_fields: {} } });
    assert.deepEqual(bucket.invalid_fields,
      [{ field: 'mutation.type_fields.execution_bucket', error: 'task_execution_bucket_required' }]);
    assert.equal(bucket.hint, undefined);
  } finally { globalThis.fetch = original; }
});

test('non-object mutation envelope returns its structured 422 details as a tool error', async () => {
  const error = await recordRejection([]);
  assert.deepEqual(error.missing_fields,
    ['operation', 'record_type', 'mutation', 'source_refs', 'source_unavailable_reason']);
  assert.deepEqual(error.invalid_fields, []);
  assert.equal(error.create_contract, undefined);
});

test('record validation projection discards values, raw diagnostics and caller-shaped contracts', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error_code: 'INVALID_RECORD_FIELDS',
    message: recordInput.mutation.content, title: recordInput.mutation.title,
    missing_fields: ['source_unavailable_reason', recordInput.mutation.title, { value: 'secret' }],
    invalid_fields: [{ field: 'user_confirmed', error: 'authority_escalation_forbidden', value: 'secret' },
      { field: 'mutation.content', error: recordInput.mutation.content }],
    create_contract: { type_specific_fields: recordInput.mutation, secret: 'secret' } }, { status: 422 });
  try {
    const error = await recordRejection({ ...recordInput, operation: 'update', base_version: 1 });
    assert.deepEqual(error.missing_fields, ['source_unavailable_reason']);
    assert.deepEqual(error.invalid_fields, [{ field: 'user_confirmed', error: 'authority_escalation_forbidden' }]);
    assert.equal(JSON.stringify(error).includes('secret'), false);
    assert.deepEqual(error.create_contract.type_specific_fields.task,
      { field: 'execution_bucket', error: 'task_execution_bucket_required' });
  } finally { globalThis.fetch = original; }
});

test('record transport preserves message-only 422, authentication, authorization and server errors', async () => {
  const original = globalThis.fetch;
  try {
    const missingToken = await handle(recordRequest(recordInput, ''), recordEnv);
    assert.equal(missingToken.status, 401);
    for (const [upstreamStatus, details, expectedStatus] of [
      [422, { message: 'plain validation error' }, 422],
      [401, { code: 'PGRST301', message: 'JWT expired' }, 401],
      [401, { code: '42501', message: 'record_not_authorized' }, 403],
      [500, { message: 'server error' }, 500],
    ]) {
      globalThis.fetch = async () => Response.json(details, { status: upstreamStatus });
      const response = await handle(recordRequest({ ...recordInput, user_confirmed: true }), recordEnv);
      assert.equal(response.status, expectedStatus);
      assert.equal((await response.json()).result, undefined);
    }
    globalThis.fetch = async () => Response.json(
      { code: '42501', message: 'lifecycle_action_cannot_edit_record_content' }, { status: 401 });
    const response = await handle(recordRequest({ ...recordInput, operation: 'close' }), recordEnv);
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.category, 'request_rule');
  } finally { globalThis.fetch = original; }
});

test('explicitly confirmed record create still commits through the canonical RPC', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const input = { ...recordInput, user_confirmed: true };
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(new URL(url).pathname, '/rest/v1/rpc/clued_record_mutate');
    assert.deepEqual(JSON.parse(init.body).p_input, input);
    return Response.json({ status: 'committed', receipt_id: '22222222-2222-4222-8222-222222222222' });
  };
  try {
    const response = await handle(recordRequest(input), recordEnv);
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'committed');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('record tool discovery explains exact confirmation and the actual database value constraints', async () => {
  const response = await handle(new Request('https://clued.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), recordEnv);
  const tool = (await response.json()).result.tools.find(tool => tool.name === 'clued_record_mutate');
  assert.match(tool.description, /authority=user_explicit \(the record's main claim is the Owner's own words in this conversation\) requires user_confirmed=true/);
  assert.match(tool.description, /do not ask the Owner again before writing/);
  const fields = tool.inputSchema.properties.mutation.properties.type_fields.properties;
  assert.deepEqual(fields.execution_bucket.enum, ['now', 'next', 'blocked', 'later']);
  assert.match(fields.state_kind.description, /manual/);
  assert.match(fields.note_kind.description, /log/);
  for (const field of ['rationale', 'state_kind', 'fact_kind', 'note_kind']) {
    assert.equal(fields[field].enum, undefined);
    assert.match(fields[field].description, /No database value enum/);
  }
});
