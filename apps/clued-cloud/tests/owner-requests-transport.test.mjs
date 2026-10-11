import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// Owner Credential v0.1, step 2: the clued_owner_request MCP tool over the
// step-1 Agent RPCs. The database side is covered by owner-grants-db.test.mjs;
// here every RPC is mocked.

const assets = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const enabled = { ...assets, PROJECT_VIEWS_V2: 'true', CLUED_OWNER_REQUESTS_V1: 'true' };
const disabled = { ...assets, PROJECT_VIEWS_V2: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'o'.repeat(43)}`;
const oauthToken = 'account-or-legacy-oauth-token';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const TOOL = 'clued_owner_request';

function mcp(token, name, args = {}, id = 1) {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
}
function list(token) {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}
function mockFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const rpc = /\/rpc\/([^/?]+)$/.exec(String(input))?.[1];
    const body = JSON.parse(init.body);
    calls.push({ rpc, body });
    return handler({ rpc, body, calls });
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}
const publicRequest = (status = 'pending') => ({
  request_id: REQUEST_ID, action: 'release.production', resources: ['repo:tdoljyj/cross-memory-system/**'],
  task_id: null, status, confirm_path: `/confirm/${REQUEST_ID}`, created_at: '2026-10-03T00:00:00Z',
  expires_at: '2026-10-04T00:00:00Z', decided_at: null, grant: null,
});

test('the tool is advertised only behind CLUED_OWNER_REQUESTS_V1, with context:read', async () => {
  const worker = await loadContinuityWorker();
  const on = (await (await worker.fetch(list(bindingToken), enabled, ctx)).json()).result.tools;
  const off = (await (await worker.fetch(list(bindingToken), disabled, ctx)).json()).result.tools;
  assert.equal(off.length + 1, on.length, 'the flag adds exactly one tool');
  assert.ok(!off.some((tool) => tool.name === TOOL));
  const tool = on.find((entry) => entry.name === TOOL);
  assert.ok(tool);
  // context:read is the lowest it advertises: connection.permission asks need no
  // scope at all (the database checks the live connection), other actions need context:write.
  assert.deepEqual(tool._meta['clued/requiredScopes'], ['context:read']);
  assert.match(tool.description, /Required Clued scope: context:read\.$/);
  assert.match(tool.description, /connection\.permission/);
  assert.match(tool.description, /Other actions require context:write\./);
  assert.match(tool.description, /cannot approve/);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.suggested_grant.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.suggested_grant.properties.expires_seconds.maximum, 604800);
  // The Owner's answer comes back to the session that asked (§13).
  assert.equal(tool.inputSchema.properties.session_ref.maxLength, 200);
  assert.match(tool.description, /the answer comes to that session by itself/);
  assert.match(tool.description, /owner_answers/);
  // Nothing in the schema lets an Agent approve, grant or widen.
  for (const key of ['choice', 'grantee', 'confirmation_token', 'view_digest', 'grant_id', 'approve']) {
    assert.ok(!(key in tool.inputSchema.properties), key);
  }
});

test('a disabled flag refuses the call before any database request', async () => {
  const worker = await loadContinuityWorker();
  const { calls, restore } = mockFetch(() => Response.json({ status: 'committed' }));
  try {
    const body = await (await worker.fetch(mcp(bindingToken, TOOL, { request_id: REQUEST_ID }), disabled, ctx)).json();
    assert.match(body.error.message, /owner requests are disabled/);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('create goes to clued_owner_request_v1 with the Binding hash and returns an absolute confirm_url', async () => {
  const worker = await loadContinuityWorker();
  const args = {
    action: 'release.production', resources: ['repo:tdoljyj/cross-memory-system/**'],
    task_id: '11111111-1111-4111-8111-111111111111', suggested_grant: { expires_seconds: 14400 },
    agent_note: 'Release PR #507', idempotency_key: 'release-507-request',
  };
  const { calls, restore } = mockFetch(() => Response.json({
    status: 'committed', replayed: false, receipt_id: 'r-1', request: { ...publicRequest(), user_id: 'u-1' },
  }));
  try {
    const response = await worker.fetch(mcp(bindingToken, TOOL, args), enabled, ctx);
    const result = (await response.json()).result;
    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rpc, 'clued_owner_request_v1');
    assert.match(calls[0].body.p_token_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(calls[0].body.p_input, args);
    assert.equal(result.structuredContent.request.confirm_url, `https://clued.test/confirm/${REQUEST_ID}`);
    assert.equal(result.structuredContent.request.user_id, undefined, 'identifiers are sanitized');
  } finally { restore(); }
});

test('a request the auto-approval switch approved comes back decided, with its grant and no confirm_url (OwnerCredential §12)', async () => {
  const worker = await loadContinuityWorker();
  const grant = { grant_id: '44444444-4444-4444-8444-444444444444', expires_at: '2026-10-04T00:00:00Z', max_uses: 1,
    uses: 0, revoked: false, any_agent: false, auto_approved: true };
  const { restore } = mockFetch(() => Response.json({
    status: 'committed', replayed: false, receipt_id: 'r-1', request: { ...publicRequest('approved_once'), grant },
  }));
  try {
    const result = (await (await worker.fetch(mcp(bindingToken, TOOL, { action: 'release.production',
      resources: ['repo:tdoljyj/cross-memory-system/abc'], idempotency_key: 'auto-approved-1' }), enabled, ctx)).json()).result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.request.status, 'approved_once');
    assert.equal(result.structuredContent.request.grant.auto_approved, true);
    assert.equal(result.structuredContent.request.confirm_url, undefined);
  } finally { restore(); }
});

test('actions creates one bundle through clued_owner_request_bundle_v1 (PermissionSimplification §3.3)', async () => {
  const worker = await loadContinuityWorker();
  const MEMBER = '44444444-4444-4444-8444-444444444444';
  const args = {
    actions: [
      { action: 'migration.production', resources: ['repo:tdoljyj/cross-memory-system/' + 'a'.repeat(40) + '/apps/clued-cloud/supabase/migrations/20261004200000_x.sql'] },
      { action: 'release.production', resources: ['repo:tdoljyj/cross-memory-system/' + 'a'.repeat(40)] },
    ],
    idempotency_key: 'release-bundle-1',
  };
  const bundle = [
    { request_id: REQUEST_ID, action: 'migration.production', resources: args.actions[0].resources, status: 'pending', confirm_path: `/confirm/${REQUEST_ID}` },
    { request_id: MEMBER, action: 'release.production', resources: args.actions[1].resources, status: 'pending', confirm_path: `/confirm/${MEMBER}` },
  ];
  const { calls, restore } = mockFetch(() => Response.json({
    status: 'committed', replayed: false, receipt_id: 'r-1',
    request: { ...publicRequest(), action: 'migration.production', resources: args.actions[0].resources, bundle },
  }));
  try {
    const result = (await (await worker.fetch(mcp(bindingToken, TOOL, args), enabled, ctx)).json()).result;
    assert.equal(result.isError, false);
    assert.equal(calls[0].rpc, 'clued_owner_request_bundle_v1');
    assert.deepEqual(calls[0].body.p_input, args);
    assert.equal(result.structuredContent.request.confirm_url, `https://clued.test/confirm/${REQUEST_ID}`);
    assert.deepEqual(result.structuredContent.request.bundle.map((m) => m.request_id), [REQUEST_ID, MEMBER]);
    // actions with action or resources is refused before the database.
    const mixed = (await (await worker.fetch(mcp(bindingToken, TOOL, { ...args, action: 'release.production' }), enabled, ctx)).json()).result;
    assert.equal(mixed.isError, true);
    assert.deepEqual(mixed.structuredContent, { status: 'rejected', error_code: 'owner_request_bundle_invalid',
      error: { code: 'owner_request_bundle_invalid', category: 'canonical_result', status: 'rejected' } });
    assert.deepEqual(JSON.parse(mixed.content[0].text), mixed.structuredContent);
    const status = (await (await worker.fetch(mcp(bindingToken, TOOL, { request_id: REQUEST_ID, actions: args.actions }), enabled, ctx)).json()).result;
    assert.equal(status.isError, true);
    assert.deepEqual(status.structuredContent, { status: 'rejected', error_code: 'owner_request_status_fields_invalid',
      error: { code: 'owner_request_status_fields_invalid', category: 'canonical_result', status: 'rejected' } });
    assert.deepEqual(JSON.parse(status.content[0].text), status.structuredContent);
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('request_id alone reads status; mixing it with create fields is refused before the database', async () => {
  const worker = await loadContinuityWorker();
  const { calls, restore } = mockFetch(() => Response.json({ status: 'ok', request: publicRequest('granted') }));
  try {
    const status = (await (await worker.fetch(mcp(bindingToken, TOOL, { request_id: REQUEST_ID, scope: 'global' }), enabled, ctx)).json()).result;
    assert.equal(status.isError, false);
    assert.equal(calls[0].rpc, 'clued_owner_request_status_v1');
    assert.deepEqual(calls[0].body.p_input, { request_id: REQUEST_ID, scope: 'global' });
    assert.equal(status.structuredContent.request.status, 'granted');
    assert.equal(status.structuredContent.request.confirm_url, `https://clued.test/confirm/${REQUEST_ID}`);

    const mixed = (await (await worker.fetch(mcp(bindingToken, TOOL, { request_id: REQUEST_ID, action: 'release.production' }), enabled, ctx)).json()).result;
    assert.equal(mixed.isError, true);
    assert.deepEqual(mixed.structuredContent, { status: 'rejected', error_code: 'owner_request_status_fields_invalid',
      error: { code: 'owner_request_status_fields_invalid', category: 'canonical_result', status: 'rejected' } });
    assert.deepEqual(JSON.parse(mixed.content[0].text), mixed.structuredContent);
    assert.equal(calls.length, 1);

    // session_ref with request_id is a status read; the session is dropped.
    const withSession = (await (await worker.fetch(mcp(bindingToken, TOOL, { request_id: REQUEST_ID, session_ref: 'session-b' }), enabled, ctx)).json()).result;
    assert.equal(withSession.isError, false);
    assert.equal(calls[1].rpc, 'clued_owner_request_status_v1');
    assert.deepEqual(calls[1].body.p_input, { request_id: REQUEST_ID });
  } finally { restore(); }
});

test('session_ref on create goes to the database so the answer reaches that session (OwnerCredential §13)', async () => {
  const worker = await loadContinuityWorker();
  const args = { action: 'release.production', resources: ['repo:tdoljyj/cross-memory-system/abc'],
    session_ref: 'session_01AmLsxZYKrKSjpN9b7J1q4f', idempotency_key: 'answer-session-1' };
  const { calls, restore } = mockFetch(() => Response.json({
    status: 'committed', replayed: false, receipt_id: 'r-1', request: publicRequest(),
  }));
  try {
    const result = (await (await worker.fetch(mcp(bindingToken, TOOL, args), enabled, ctx)).json()).result;
    assert.equal(result.isError, false);
    assert.equal(calls[0].rpc, 'clued_owner_request_v1');
    assert.deepEqual(calls[0].body.p_input, args);
  } finally { restore(); }
});

test('account and legacy OAuth tokens are refused; no token is a 401', async () => {
  const worker = await loadContinuityWorker();
  const { calls, restore } = mockFetch(() => Response.json({ status: 'committed' }));
  try {
    const oauth = await (await worker.fetch(mcp(oauthToken, TOOL, { request_id: REQUEST_ID }), enabled, ctx)).json();
    assert.match(oauth.error.message, /require a Clued Agent Binding/);
    const none = await worker.fetch(mcp(null, TOOL, { request_id: REQUEST_ID }), enabled, ctx);
    assert.ok(none.status === 401 || (await none.clone().json()).error, 'no token is refused');
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('database contract rejections become tool errors naming the rule; other failures stay transport errors', async () => {
  const worker = await loadContinuityWorker();
  let reply = () => Response.json({ code: '22023', message: 'owner_grant_action_unknown' }, { status: 400 });
  const { restore } = mockFetch(() => reply());
  try {
    const args = { action: 'deploy.anything', resources: ['repo:x/y/**'], idempotency_key: 'unknown-action' };
    const rejected = (await (await worker.fetch(mcp(bindingToken, TOOL, args), enabled, ctx)).json()).result;
    assert.equal(rejected.isError, true);
    assert.deepEqual(rejected.structuredContent, { status: 'rejected', error_code: 'owner_grant_action_unknown',
      error: { code: 'owner_grant_action_unknown', category: 'canonical_result', status: 'rejected' } });
    assert.deepEqual(JSON.parse(rejected.content[0].text), rejected.structuredContent);

    reply = () => Response.json({ code: '22023', message: 'work_claim_resource_kind_unknown' }, { status: 400 });
    const kind = (await (await worker.fetch(mcp(bindingToken, TOOL, { ...args, action: 'release.production', resources: ['zz:x'] }), enabled, ctx)).json()).result;
    assert.equal(kind.structuredContent.error_code, 'work_claim_resource_kind_unknown');

    reply = () => Response.json({ status: 'rejected', error_code: 'owner_request_not_found' });
    const missing = (await (await worker.fetch(mcp(bindingToken, TOOL, { request_id: REQUEST_ID }), enabled, ctx)).json()).result;
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error_code, 'owner_request_not_found');

    reply = () => Response.json({ code: '42501', message: 'binding_scope_denied' }, { status: 401 });
    const denied = await (await worker.fetch(mcp(bindingToken, TOOL, args), enabled, ctx)).json();
    assert.ok(denied.error, 'an authorization failure is not turned into a tool result');
  } finally { restore(); }
});
