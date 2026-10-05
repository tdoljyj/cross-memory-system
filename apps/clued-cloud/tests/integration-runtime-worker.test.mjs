import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// S2c Integration Runtime PR-5 (IntegrationRuntime v0.1.8 §12, §13.8 T-W-1…6): the Worker surface behind
// CLUED_INTEGRATION_RUNTIME_V1 — tools/list, bootstrap, REST, Binding-channel dispatch and the §11.1 error
// rendering. Every RPC is mocked here; the database side is covered by the integration-runtime-*-db suites
// and the real Host-disconnect path by integration-runtime-transport.test.mjs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integrations-'));
await build({ entryPoints: [path.join(root, 'worker/integrations.ts')], outfile: path.join(directory, 'integrations.mjs'),
  bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
stop();
const integrations = await import(pathToFileURL(path.join(directory, 'integrations.mjs')).href);
const baseline = JSON.parse(await fs.readFile(path.join(root, 'evals/public-mcp/tools-list.baseline.json'), 'utf8'));
const toolVersions = JSON.parse(await fs.readFile(path.join(root, 'evals/public-mcp/tool-versions.json'), 'utf8'));

const TOOLS = ['clued_integration_install', 'clued_integration_status', 'clued_integration_declare', 'clued_integration_report',
  'clued_integration_identity_update', 'clued_integration_verify', 'clued_integration_revoke'];
// §12.2: readOnly / destructive / idempotent / openWorld
const ANNOTATIONS = {
  clued_integration_install: [false, false, true, true],
  clued_integration_status: [true, false, true, true],
  clued_integration_declare: [false, false, true, true],
  clued_integration_report: [false, false, true, true],
  clued_integration_identity_update: [false, false, true, true],
  clued_integration_verify: [false, false, true, true],
  clued_integration_revoke: [false, true, true, true],
};
const AUTHORIZATION = ['binding_not_authorized', 'direct_human_session_required', 'integration_not_owned',
  'integration_connection_required', 'platform_admin_required', 'binding_not_owned'];
const CONFLICTS = ['integration_version_conflict', 'installation_request_version_conflict', 'identity_claim_retry_exhausted',
  'integration_revoke_connection_set_changed'];
const RULE_MESSAGE = 'The request was refused by a Clued contract rule; reconnecting will not change the outcome.';

const assets = { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const production = { ...assets, PROJECT_VIEWS_V2: 'true', P5_TENANT_WRITES: 'false' };
const enabled = { ...production, CLUED_INTEGRATION_RUNTIME_V1: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'b'.repeat(64)}`;
const tokenHash = crypto.createHash('sha256').update(bindingToken).digest('hex');
const ID = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';

const rpcRequest = (body, headers = {}, token = bindingToken) => new Request('https://clued.test/mcp', {
  method: 'POST',
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
});
const listTools = async (env) => (await (await (await loadContinuityWorker()).fetch(rpcRequest({ method: 'tools/list' }), env, ctx)).json()).result.tools;
const callTool = async (env, name, args = {}, { headers, token } = {}) => {
  const response = await (await loadContinuityWorker()).fetch(rpcRequest({ method: 'tools/call', params: { name, arguments: args } }, headers, token), env, ctx);
  return { status: response.status, body: await response.json() };
};
const rest = async (env, method, pathname, { body, token = 'account-jwt', headers = {} } = {}) => {
  const response = await (await loadContinuityWorker()).fetch(new Request(`https://clued.test${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
// Every outbound request is recorded; handler(rpc, body, headers) answers the PostgREST hop.
function mockFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.pathname === '/auth/v1/user') {
      calls.push({ auth: true, token: headers.get('authorization') });
      return headers.get('authorization') === 'Bearer account-jwt'
        ? Response.json({ id: '33333333-3333-4333-8333-333333333333', email: 'owner@clued.test', email_confirmed_at: '2026-10-01T00:00:00Z' })
        : Response.json({ message: 'invalid JWT' }, { status: 401 });
    }
    const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname)?.[1];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ rpc, body, authorization: headers.get('authorization') });
    return handler(rpc, body, calls);
  };
  return { calls, rpcCalls: () => calls.filter((call) => call.rpc), restore: () => { globalThis.fetch = previous; } };
}
const committed = (supplemental = {}) => Response.json({ status: 'committed', replayed: false, receipt_id: 'receipt-1', supplemental });

test('T-W-1 flag off: tools/list is byte-identical to the frozen baseline; the 8-row matrix holds through the Worker', async () => {
  for (const value of [undefined, 'false', '0', 'off', '', 'yes']) {
    const env = value === undefined ? production : { ...production, CLUED_INTEGRATION_RUNTIME_V1: value };
    assert.equal(JSON.stringify(await listTools(env)), JSON.stringify(baseline.tools), `flag ${JSON.stringify(value)}`);
  }
  assert.equal(baseline.tools.length, 29);
  const rows = toolVersions.feature_flags.full_matrix;
  assert.equal(rows.length, 8);
  for (const row of rows) {
    const env = { ...assets, PROJECT_VIEWS_V2: String(row.PROJECT_VIEWS_V2), P5_TENANT_WRITES: String(row.P5_TENANT_WRITES),
      CLUED_INTEGRATION_RUNTIME_V1: String(row.CLUED_INTEGRATION_RUNTIME_V1) };
    const tools = await listTools(env);
    assert.equal(tools.length, row.expected_tool_count, JSON.stringify(env));
    assert.equal(tools.filter((tool) => TOOLS.includes(tool.name)).length, row.CLUED_INTEGRATION_RUNTIME_V1 ? 7 : 0);
  }
  // §12.6 counts, independent of the metadata file
  const count = (v2, p5, on) => rows.find((row) => row.PROJECT_VIEWS_V2 === v2 && row.P5_TENANT_WRITES === p5
    && row.CLUED_INTEGRATION_RUNTIME_V1 === on).expected_tool_count;
  assert.deepEqual([count(false, false, false), count(true, false, false), count(false, true, false), count(true, true, false)], [18, 29, 23, 34]);
  assert.deepEqual([count(false, false, true), count(true, false, true), count(false, true, true), count(true, true, true)], [25, 36, 30, 41]);
  assert.deepEqual(toolVersions.feature_flags.production_equivalent,
    { PROJECT_VIEWS_V2: true, P5_TENANT_WRITES: false, CLUED_INTEGRATION_RUNTIME_V1: false, expected_tool_count: 29 });
  for (const value of ['true', 'TRUE', '1', 'on', 'enabled', ' true ']) {
    assert.equal(integrations.integrationRuntimeEnabled({ CLUED_INTEGRATION_RUNTIME_V1: value }), true, value);
  }
});

test('T-W-2 flag off: bootstrap carries no integration_runtime key; /v1/integrations* is 404; tool names are unknown', async () => {
  const { rpcCalls, calls, restore } = mockFetch(() => committed());
  try {
    const worker = await loadContinuityWorker();
    const read = async (env, pathname) => (await worker.fetch(new Request(`https://clued.test${pathname}`), env, ctx)).text();
    for (const pathname of ['/v1/continuity/bootstrap', '/.well-known/clued-continuity']) {
      const off = await read(production, pathname);
      const on = JSON.parse(await read(enabled, pathname));
      assert.equal(off.includes('integration'), false, pathname);
      assert.deepEqual(on.capabilities.integration_runtime, {
        enabled: true, contract: 'clued.integration-runtime.v1', derivation_contract: 'clued.integration-derivation.v1',
        facts_schema: 'clued.integration-facts.v1',
        capability_vocabulary: ['context.read', 'context.write', 'audit.read', 'project.read', 'project.write', 'evidence.write',
          'development_history.read'],
        tools: TOOLS,
        states: ['INSTALL_PENDING', 'INSTALLED', 'AUTH_PENDING', 'VERIFYING', 'ACTIVE', 'DEGRADED', 'BLOCKED', 'REAUTH_REQUIRED',
          'INCOMPATIBLE', 'REVOKED'],
      });
      // the flag adds exactly that one key: with it removed the document is byte-identical to flag off
      delete on.capabilities.integration_runtime;
      assert.equal(JSON.stringify(on), off, pathname);
    }
    const viaTool = await callTool(production, 'clued_agent_bootstrap');
    assert.equal('integration_runtime' in viaTool.body.result.structuredContent.capabilities, false);

    for (const [method, pathname] of [['GET', '/v1/integrations'], ['GET', `/v1/integrations/${ID}`],
      ['POST', `/v1/integrations/${ID}/revoke`], ['POST', '/v1/integrations/requests'], ['GET', '/v1/integrations/binding-inventory'],
      ['POST', '/v1/integrations/adopt-binding'], ['POST', `/v1/integrations/requests/${REQUEST}/confirm-rebind`],
      ['GET', '/v1/integrations/unknown'], ['OPTIONS', '/v1/integrations']]) {
      const response = await rest(production, method, pathname, method === 'POST' ? { body: {} } : {});
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.deepEqual(response.body, { error: 'Not found.' });
    }
    // the flag check precedes the origin check: a cross-origin request is the same 404
    const crossOrigin = await rest(production, 'POST', `/v1/integrations/${ID}/revoke`, { body: {}, headers: { origin: 'https://elsewhere.example' } });
    assert.deepEqual(crossOrigin, { status: 404, body: { error: 'Not found.' } });
    for (const name of TOOLS) {
      const response = await callTool(production, name, { integration_id: ID });
      assert.equal(response.status, 404, name);
      assert.equal(response.body.error.message, 'Unknown Clued continuity tool.', name);
      const unknown = await callTool(production, 'clued_integration_nonexistent');
      assert.deepEqual(response.body, unknown.body, 'indistinguishable from an unknown tool');
    }
    assert.equal(rpcCalls().length, 0);
    assert.equal(calls.length, 0, 'no database or auth request with the flag off');
  } finally { restore(); }
});

test('T-W-3 flag on: the seven tools match §12.2 and every existing tool definition is unchanged', async () => {
  const on = await listTools(enabled);
  const off = await listTools(production);
  assert.equal(on.length, off.length + 7);
  assert.equal(JSON.stringify(on.filter((tool) => !TOOLS.includes(tool.name))), JSON.stringify(off), 'existing tools unchanged, same order');
  assert.deepEqual(on.filter((tool) => TOOLS.includes(tool.name)).map((tool) => tool.name), TOOLS);
  for (const name of TOOLS) {
    const tool = on.find((entry) => entry.name === name);
    const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = ANNOTATIONS[name];
    assert.deepEqual(tool.annotations, { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }, name);
    // OQ-12 interim: context:read, server-enforced, and the description says connection-self
    assert.deepEqual(tool._meta, { 'clued/requiredScopes': ['context:read'], 'clued/scopeEnforcement': 'server-side' }, name);
    assert.match(tool.description, /Connection-self operation/, name);
    assert.match(tool.description, /never reads or writes your Clued context\. Required Clued scope: context:read\.$/, name);
    assert.equal(tool.inputSchema.type, 'object', name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    assert.ok(tool.outputSchema, name);
  }
  const verify = on.find((tool) => tool.name === 'clued_integration_verify');
  assert.equal('transport' in verify.inputSchema.properties, false, 'the transport is never a caller input');
  assert.deepEqual(verify.inputSchema.properties.kind.enum, ['canonical_baseline', 'ready_profile']);
  const identity = on.find((tool) => tool.name === 'clued_integration_identity_update');
  assert.ok('active_binding_domain' in identity.inputSchema.properties, '§10.4 optional input');
  const install = on.find((tool) => tool.name === 'clued_integration_install');
  assert.deepEqual(install.inputSchema.properties.intent.enum, ['create_or_bind', 'bind_connection', 'rebind', 'reauthorization',
    'reinstall', 'recovery', 'adapter_migration', 'verification_repair']);
  for (const forbidden of ['provider_connection_key', 'binding_id', 'owner_id', 'user_id']) {
    assert.equal(forbidden in install.inputSchema.properties, false, `the server derives ${forbidden}`);
  }
});

test('T-W-4 every 42501 code in the Integration migrations is exactly one class, and each class renders as §11.1', async () => {
  const files = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => /_integration_runtime_.*\.sql$/.test(name)).sort();
  assert.ok(files.length >= 4, files.join());
  const raised = new Set();
  for (const file of files) {
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', file), 'utf8');
    for (const match of sql.matchAll(/raise\s+exception\s+'([a-z0-9_]+)'\s+using\s+errcode\s*=\s*'42501'/gi)) raised.add(match[1]);
    // no other 42501 raise form slips past the scan
    const other = sql.split('\n').filter((line) => /raise[^;]*42501/i.test(line)
      && !/raise\s+exception\s+'[a-z0-9_]+'\s+using\s+errcode\s*=\s*'42501'/i.test(line));
    assert.deepEqual(other, [], file);
  }
  assert.ok(raised.size >= 40, `the scan found ${raised.size} codes`);
  const rules = Object.keys(integrations.INTEGRATION_REQUEST_RULE_REJECTIONS);
  // the tables are exactly §11.2's, including rule codes raised only inside the Receipt
  const contract = await fs.readFile(path.join(root, '../../development/contracts/integration-runtime/IntegrationRuntime.v0.1.8.md'), 'utf8');
  const section = (start, end) => {
    const text = contract.slice(contract.indexOf(start), contract.indexOf(end, contract.indexOf(start)));
    return text.split('\n').filter((line) => /^\| `/.test(line))
      .flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]));
  };
  assert.deepEqual(section('**授权（HTTP 403）**', '**请求规则').sort(), [...AUTHORIZATION].sort());
  assert.deepEqual(section('**请求规则', 'v0.1.2（MINOR-N3）').sort(), [...rules].sort());
  assert.deepEqual([...integrations.INTEGRATION_AUTHORIZATION_CODES], AUTHORIZATION);
  assert.deepEqual(AUTHORIZATION.filter((code) => rules.includes(code)), [], 'the classes are disjoint');
  for (const code of raised) assert.ok(AUTHORIZATION.includes(code) !== rules.includes(code), `${code} is in exactly one class`);
  assert.deepEqual([...raised].filter((code) => !AUTHORIZATION.includes(code) && !rules.includes(code)), []);
  assert.deepEqual([...integrations.INTEGRATION_CONFLICT_CODES], CONFLICTS);
  assert.deepEqual(CONFLICTS.filter((code) => rules.includes(code) || AUTHORIZATION.includes(code)), []);

  let reply;
  const { restore } = mockFetch(() => reply());
  try {
    const args = { integration_id: ID };
    // authorization: HTTP 403 (anon's 401+42501 rewritten), never a tool result
    for (const code of AUTHORIZATION) {
      reply = () => Response.json({ code: '42501', message: code }, { status: 401 });
      const response = await callTool(enabled, 'clued_integration_status', args);
      assert.equal(response.status, 403, code);
      assert.equal(response.body.error.message, code);
      assert.equal(response.body.result, undefined, code);
    }
    // every rule code, both transports: the same request_rule shape and hint
    for (const code of rules) {
      const hint = integrations.INTEGRATION_REQUEST_RULE_REJECTIONS[code];
      const error = { code, category: 'request_rule', message: RULE_MESSAGE, ...(hint ? { hint } : {}) };
      reply = () => Response.json({ code: '42501', message: code }, { status: 401 });
      const raisedResult = await callTool(enabled, 'clued_integration_status', args);
      assert.equal(raisedResult.status, 200, code);
      assert.equal(raisedResult.body.result.isError, true, code);
      assert.deepEqual(raisedResult.body.result.structuredContent, { status: 'rejected', error }, code);
      reply = () => Response.json({ status: 'rejected', replayed: false, receipt_id: 'receipt-r', error_code: code, supplemental: {} });
      const envelope = await callTool(enabled, 'clued_integration_status', args);
      assert.equal(envelope.status, 200, code);
      assert.equal(envelope.body.result.isError, true, code);
      assert.deepEqual(envelope.body.result.structuredContent, { status: 'rejected', error, receipt_id: 'receipt-r', replayed: false }, code);
      assert.deepEqual(JSON.parse(envelope.body.result.content[0].text), envelope.body.result.structuredContent);
    }
    // conflicts: retryable, not a rule
    for (const code of CONFLICTS) {
      reply = () => Response.json({ status: 'rejected', replayed: false, receipt_id: null, error_code: code,
        supplemental: { current_version: 4 } });
      const response = await callTool(enabled, 'clued_integration_status', args);
      assert.deepEqual(response.body.result.structuredContent, { status: 'rejected',
        error: { code, category: 'conflict', retryable: true }, receipt_id: null, replayed: false, supplemental: { current_version: 4 } });
    }
    // input invalid (22023) stays an HTTP 400 transport error; an unlisted envelope code is returned unchanged
    reply = () => Response.json({ code: '22023', message: 'integration_input_invalid' }, { status: 400 });
    assert.equal((await callTool(enabled, 'clued_integration_status', args)).status, 400);
    reply = () => Response.json({ status: 'rejected', replayed: false, receipt_id: null, error_code: 'IDEMPOTENCY_KEY_CONFLICT' });
    assert.deepEqual((await callTool(enabled, 'clued_integration_status', args)).body.result.structuredContent,
      { status: 'rejected', replayed: false, receipt_id: null, error_code: 'IDEMPOTENCY_KEY_CONFLICT' });
    reply = () => Response.json({ status: 'failed', error_code: 'INTERNAL' });
    assert.equal((await callTool(enabled, 'clued_integration_status', args)).body.result.isError, true);
    reply = () => committed({ integration_state: 'ACTIVE' });
    const ok = await callTool(enabled, 'clued_integration_status', args);
    assert.equal(ok.body.result.isError, false);
    assert.equal(ok.body.result.structuredContent.supplemental.integration_state, 'ACTIVE');

    // REST: a rule raised before the Receipt is the same 422 as one inside it; authorization stays 403
    reply = () => Response.json({ code: '42501', message: 'binding_not_adoptable' }, { status: 403 });
    const raisedRest = await rest(enabled, 'POST', '/v1/integrations/adopt-binding', { body: { binding_id: ID } });
    assert.equal(raisedRest.status, 422);
    assert.deepEqual(raisedRest.body, { status: 'rejected', error: { code: 'binding_not_adoptable', category: 'request_rule',
      message: RULE_MESSAGE, hint: integrations.INTEGRATION_REQUEST_RULE_REJECTIONS.binding_not_adoptable } });
    reply = () => Response.json({ code: '42501', message: 'integration_not_owned' }, { status: 403 });
    assert.equal((await rest(enabled, 'GET', `/v1/integrations/${ID}`)).status, 403);
    // REST: a rule rejection is 422, a conflict 409, committed 200; the body is the Native envelope
    for (const [body, status] of [[{ status: 'rejected', error_code: 'lifecycle_transition_invalid' }, 422],
      [{ status: 'rejected', error_code: 'integration_version_conflict' }, 409],
      [{ status: 'rejected', error_code: 'IDEMPOTENCY_KEY_CONFLICT' }, 409],
      [{ status: 'failed', error_code: 'INTERNAL' }, 500], [{ status: 'committed', receipt_id: 'r' }, 200]]) {
      reply = () => Response.json(body);
      const response = await rest(enabled, 'POST', `/v1/integrations/${ID}/lifecycle`, { body: { action: 'pause' } });
      assert.equal(response.status, status, JSON.stringify(body));
      assert.deepEqual(response.body, body);
    }
  } finally { restore(); }
});

test('T-W-5 verify: the Worker injects the transport facts and overwrites a caller field of the same name', async () => {
  const { rpcCalls, restore } = mockFetch(() => committed({ result: 'PASS' }));
  try {
    const args = { kind: 'canonical_baseline', idempotency_key: 'verify-key-1', integration_id: ID, base_version: 3,
      transport: { protocol_version: '2099-01-01', build_sha: 'f'.repeat(40) } };
    await callTool(enabled, 'clued_integration_verify', args);
    await callTool(enabled, 'clued_integration_verify', args, { headers: { 'mcp-protocol-version': '2025-06-18' } });
    const [first, second] = rpcCalls();
    assert.equal(first.rpc, 'clued_integration_verify_v1');
    assert.equal(first.body.p_token_hash, tokenHash);
    // no header → MCP Streamable HTTP 2025-03-26; a Node test build has no 40-hex build SHA → null
    assert.deepEqual(first.body.p_input, { ...args, transport: { protocol_version: '2025-03-26', build_sha: null } });
    assert.deepEqual(second.body.p_input.transport, { protocol_version: '2025-06-18', build_sha: null });
    // ready_profile never reads it: no transport at all, so a retry's idempotency hash is stable
    const ready = { ...args, kind: 'ready_profile', profile_id: 'test.read', profile_version: 1 };
    await callTool(enabled, 'clued_integration_verify', ready, { headers: { 'mcp-protocol-version': '2025-06-18' } });
    const { transport: _ignored, ...readyInput } = ready;
    void _ignored;
    assert.deepEqual(rpcCalls().at(-1).body.p_input, readyInput);
  } finally { restore(); }
});

test('T-W-6 a non-clued_bnd_ token is 403 and no token 401, before any database request', async () => {
  const { calls, restore } = mockFetch(() => committed());
  try {
    for (const name of TOOLS) {
      const account = await callTool(enabled, name, { integration_id: ID }, { token: 'account-jwt' });
      assert.equal(account.status, 403, name);
      assert.equal(account.body.error.message, 'Integration operations require a Clued Agent Binding.');
      const none = await callTool(enabled, name, { integration_id: ID }, { token: null });
      assert.equal(none.status, 401, name);
    }
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('install opens the Request and consumes it; identity_update routes request_reconcile; other tools map one to one', async () => {
  let fail = null;
  const { rpcCalls, restore } = mockFetch((rpc) => {
    if (rpc === fail) return Response.json({ code: '42501', message: 'host_not_registered' }, { status: 401 });
    if (rpc === 'clued_integration_request_open_v1') return Response.json({ request_id: REQUEST, status: 'OPEN', version: 1 });
    return committed({ integration_id: ID });
  });
  try {
    const install = { request_key: 'request-key-0000001', intent: 'reauthorization', target_integration_id: ID, host: 'test.complete',
      host_surface: 'default', adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED',
      idempotency_key: 'bind-key-1' };
    const result = await callTool(enabled, 'clued_integration_install', install);
    assert.equal(result.body.result.isError, false);
    assert.deepEqual(result.body.result.structuredContent, { status: 'committed', replayed: false, receipt_id: 'receipt-1',
      supplemental: { integration_id: ID } });
    const [open, bind] = rpcCalls();
    assert.equal(open.rpc, 'clued_integration_request_open_v1');
    const openInput = { ...install };
    delete openInput.idempotency_key;
    assert.deepEqual(open.body, { p_token_hash: tokenHash, p_input: openInput });
    assert.equal(bind.rpc, 'clued_integration_create_or_bind_v1');
    assert.deepEqual(bind.body, { p_token_hash: tokenHash,
      p_input: { idempotency_key: 'bind-key-1', request_id: REQUEST, binding_intent: 'REAUTHORIZATION' } });
    // a rule rejection on the open stops before the bind and renders as request_rule
    fail = 'clued_integration_request_open_v1';
    const refused = await callTool(enabled, 'clued_integration_install', install);
    assert.equal(refused.body.result.structuredContent.error.code, 'host_not_registered');
    assert.equal(refused.body.result.structuredContent.error.category, 'request_rule');
    assert.equal(rpcCalls().length, 3);
    fail = null;

    const reconcile = { action: 'request_reconcile', idempotency_key: 'reconcile-1', integration_id: ID, base_version: 2,
      tenant: { status: 'UNAVAILABLE' } };
    await callTool(enabled, 'clued_integration_identity_update', reconcile);
    assert.deepEqual(rpcCalls().at(-1), { rpc: 'clued_integration_reconcile_request_v1', authorization: rpcCalls().at(-1).authorization,
      body: { p_token_hash: tokenHash, p_input: { idempotency_key: 'reconcile-1', integration_id: ID, base_version: 2 } } });
    const update = { idempotency_key: 'update-1', integration_id: ID, base_version: 2, tenant: { status: 'NOT_APPLICABLE' } };
    for (const args of [update, { ...update, action: 'update' }]) {
      await callTool(enabled, 'clued_integration_identity_update', args);
      assert.equal(rpcCalls().at(-1).rpc, 'clued_integration_identity_update_v1');
      assert.deepEqual(rpcCalls().at(-1).body.p_input, update, 'action is not forwarded');
    }
    for (const [name, rpc] of [['clued_integration_status', 'clued_integration_status_v1'],
      ['clued_integration_declare', 'clued_integration_declare_v1'], ['clued_integration_report', 'clued_integration_report_v1'],
      ['clued_integration_revoke', 'clued_integration_revoke_self_v1']]) {
      const args = { integration_id: ID, idempotency_key: `${name}-key` };
      await callTool(enabled, name, args);
      assert.deepEqual(rpcCalls().at(-1).body, { p_token_hash: tokenHash, p_input: args }, name);
      assert.equal(rpcCalls().at(-1).rpc, rpc, name);
    }
  } finally { restore(); }
});

test('Native REST: each route forwards to clued_user_integration_v1 with the account JWT; path parameters win', async () => {
  const { calls, rpcCalls, restore } = mockFetch(() => Response.json({ status: 'committed', receipt_id: 'r' }));
  try {
    const cases = [
      ['GET', '/v1/integrations', null, { op: 'list' }],
      ['GET', '/v1/integrations/binding-inventory', null, { op: 'binding_inventory' }],
      ['POST', '/v1/integrations/adopt-binding', { binding_id: ID, idempotency_key: 'k1' }, { binding_id: ID, idempotency_key: 'k1', op: 'adopt_binding' }],
      ['POST', '/v1/integrations/requests', { request_key: 'r'.repeat(16) }, { request_key: 'r'.repeat(16), op: 'request_open' }],
      ['POST', `/v1/integrations/requests/${REQUEST.toUpperCase()}/confirm-rebind`, { request_id: ID, op: 'list' },
        { request_id: REQUEST, op: 'confirm_rebind' }],
      ['GET', `/v1/integrations/${ID}`, null, { integration_id: ID, op: 'status' }],
      ...['revoke', 'restore', 'reconcile', 'lifecycle', 'identity', 'capability-expansion'].map((action) => ['POST',
        `/v1/integrations/${ID}/${action}`, { integration_id: REQUEST, base_version: 2 },
        { integration_id: ID, base_version: 2,
          op: { identity: 'identity_update', 'capability-expansion': 'capability_expansion' }[action] ?? action }]),
    ];
    for (const [method, pathname, body, input] of cases) {
      const response = await rest(enabled, method, pathname, body ? { body } : {});
      assert.equal(response.status, 200, `${method} ${pathname}`);
      const call = rpcCalls().at(-1);
      assert.equal(call.rpc, 'clued_user_integration_v1', pathname);
      assert.equal(call.authorization, 'Bearer account-jwt', pathname);
      assert.deepEqual(call.body, { p_input: input }, pathname);
    }
    const forwarded = rpcCalls().length;
    // unknown routes and methods are 404 before authentication
    for (const [method, pathname] of [['POST', '/v1/integrations'], ['GET', '/v1/integrations/requests'], ['DELETE', `/v1/integrations/${ID}`],
      ['GET', `/v1/integrations/${ID}/revoke`], ['POST', `/v1/integrations/${ID}/delete`], ['GET', '/v1/integrations/not-a-uuid']]) {
      assert.equal((await rest(enabled, method, pathname)).status, 404, `${method} ${pathname}`);
    }
    assert.equal((await rest(enabled, 'OPTIONS', '/v1/integrations')).status, 204);
    // account JWT only: a Binding token or no token never reaches the RPC
    assert.equal((await rest(enabled, 'GET', '/v1/integrations', { token: bindingToken })).status, 401);
    assert.equal((await rest(enabled, 'GET', '/v1/integrations', { token: null })).status, 401);
    assert.equal((await rest(enabled, 'GET', '/v1/integrations', { token: 'expired-jwt' })).status, 401);
    assert.equal(rpcCalls().length, forwarded);
    assert.ok(calls.every((call) => call.auth || call.rpc === 'clued_user_integration_v1'));
  } finally { restore(); }
});
