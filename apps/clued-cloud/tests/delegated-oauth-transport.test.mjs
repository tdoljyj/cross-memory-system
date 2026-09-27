import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build, stop } from 'esbuild';

// Real pinned OAuth provider and application transport; fake DB is deliberately
// limited to HTTP wiring. SQL authorization is tested separately on PostgreSQL.
const dir = await mkdtemp(path.join(os.tmpdir(), 'clued-oauth-transport-'));
await build({ entryPoints: ['worker/delegated-oauth.ts'], outdir: dir, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  plugins: [{ name: 'worker-runtime-only', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'worker-runtime', namespace: 'test-runtime' }));
    b.onLoad({ filter: /.*/, namespace: 'test-runtime' }, () => ({ contents: 'export class WorkerEntrypoint {}' }));
  } }] });
stop();
const { handleDelegatedOAuth: handle, requiredToolScopes } = await import(pathToFileURL(path.join(dir, 'delegated-oauth.mjs')));
class MemoryKV {
  rows = new Map();
  async get(key, type) { const row = this.rows.get(key); if (!row) return null; return (type === 'json' || type?.type === 'json') ? JSON.parse(row) : row; }
  async put(key, value) { this.rows.set(key, value); }
  async delete(key) { this.rows.delete(key); }
  async list({ prefix = '' } = {}) { return { keys: [...this.rows.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cursor: '' }; }
}
const origin = 'https://clued.example';
const resource = `${origin}/mcp`;
const originalFetch = globalThis.fetch;
function fixture() {
  const bindings = new Map(); const prepared = new Map(); const calls = []; const background = [];
  const storageGrants = new Set();
  const env = { OAUTH_KV: new MemoryKV(), CLUED_DELEGATED_OAUTH_V12: 'true', CLUED_OAUTH_ORIGIN: origin,
    CLUED_AUTHORIZATION_ISSUER_TOKEN: 'isolated-issuer-test-value', SUPABASE_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public-key', PROJECT_VIEWS_V2: 'true' };
  const run = (route, options = {}) => handle(new Request(`${origin}${route}`, options), env, { waitUntil(promise) { background.push(promise); }, passThroughOnException() {}, props: {} }, async () => new Response('fallback', { status: 404 }));
  globalThis.fetch = async (url, options = {}) => {
    const name = new URL(url).pathname.split('/').at(-1); const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ name, body, headers: options.headers });
    if (name === 'user') return Response.json({ id: '10000000-0000-4000-8000-000000000001', email: 'test@example.invalid' });
    if (name === 'clued_authorization_prepare_v12') {
      if (!prepared.has(body.p_request.request_digest)) prepared.set(body.p_request.request_digest, { request_id: crypto.randomUUID(), version: 1,
        eligible: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', name: 'My memory', actions: ['read', 'write'] }] });
      return Response.json(prepared.get(body.p_request.request_digest));
    }
    if (name === 'clued_authorization_approve_v12') {
      const entry = [...prepared.values()].find(p => p.request_id === body.p_request_id);
      if (!entry || entry.version !== body.p_base_version) return Response.json({ error: 'conflict' }, { status: 409 });
      entry.version++;
      const binding = { binding_id: crypto.randomUUID(), active: true, version: 1, expires_at: body.p_expires_at, granted_scopes: ['context:read', 'context:write'] };
      bindings.set(body.p_binding_hash, binding); return Response.json(binding);
    }
    if (name === 'clued_authorization_revoke_issuer_v12') {
      const binding = [...bindings.values()].find(row => row.binding_id === body.p_binding_id);
      if (!binding || body.p_issuer_hash !== createHash('sha256').update(env.CLUED_AUTHORIZATION_ISSUER_TOKEN).digest('hex')) return Response.json({ error: 'denied' }, { status: 403 });
      binding.active = false; return Response.json({ status: 'revoked' });
    }
    if (name === 'clued_authorization_deny_v12') {
      const entry = [...prepared.values()].find(p => p.request_id === body.p_request_id);
      if (!entry || entry.version !== body.p_base_version) return Response.json({ error: 'conflict' }, { status: 409 });
      entry.version++; return Response.json({ status: 'denied' });
    }
    if (name === 'clued_authorization_status_v12') return Response.json(bindings.get(body.p_token_hash) || { active: false });
    if (name === 'clued_record_list') return Response.json({ status: 'ok', records: [] });
    if (name === 'clued_storage_jobs_v1') {
      if (!bindings.get(body.p_token_hash)?.active || !storageGrants.has(body.p_token_hash)) {
        return Response.json({ message: 'storage_binding_denied', code: '42501' }, { status: 403 });
      }
      return Response.json({ connection_id: body.p_input.connection_id, job_id: body.p_input.job_id,
        request_digest: 'a'.repeat(64), status: 'queued', intent_id: null,
        receipt_id: '30000000-0000-4000-8000-000000000001', execution_permitted: false });
    }
    if (name === 'clued_mcp_projection_refresh_claim') return Response.json({ status: 'idle' });
    throw new Error(`Unexpected storage route: ${name}`);
  };
  return { env, run, bindings, calls, background, storageGrants };
}
async function client(f) {
  const response = await f.run('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Isolated client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(response.status, 201); return (await response.json()).client_id;
}
async function begin(f, clientId) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://client.example/callback', response_type: 'code', scope: 'context:read context:write', state: 'test-state', resource,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const response = await f.run(`/oauth/authorize?${query}`);
  assert.equal(response.status, 302, await response.clone().text());
  const id = new URL(response.headers.get('Location')).searchParams.get('request_id');
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  const headers = { Authorization: 'Bearer human-session-test', Cookie: cookie };
  const read = await f.run(`/oauth/request?request_id=${id}`, { headers });
  assert.equal(read.status, 200, await read.clone().text());
  return { id, cookie, headers, verifier, prepared: await read.json() };
}
async function approve(f, clientId, flow) {
  const response = await f.run(`/oauth/decision?request_id=${flow.id}`, { method: 'POST', headers: { ...flow.headers, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', version: flow.prepared.version, days: 1, selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] }] }) });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes('clued_bnd_'), false);
  assert.equal(JSON.stringify(body).includes('human-session-test'), false);
  const code = new URL(body.redirect_url).searchParams.get('code');
  const token = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://client.example/callback', code_verifier: flow.verifier, resource }) });
  assert.equal(token.status, 200, await token.clone().text());
  return await token.json();
}
const call = (token, name) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { record_type: 'state' } } }) });

test('real OAuth MCP storage tools retain live Binding and separate storage grant gates', async () => {
  const f = fixture();
  try {
    f.env.CLUED_STORAGE_ACCOUNT_V1 = 'true'; f.env.CLUED_STORAGE_JOBS_V1 = 'true';
    const id = await client(f), flow = await begin(f, id), token = await approve(f, id, flow);
    const ref = { connection_id: '20000000-0000-4000-8000-000000000001', job_id: '10000000-0000-4000-8000-000000000001' };
    const mutation = { operation: 'create', target_kind: 'file', destination_path: 'G:/My Drive/Clued_资料中心/track/topic/test.md', content: 'fixture' };
    const storageCall = (access, name, args) => ({ ...call(access, name), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    // Actual provider issued a context:write token, but no storage grant exists.
    let response = await f.run('/mcp', storageCall(token.access_token, 'clued_storage_submit', { ...ref, mutation }));
    assert.equal(response.status, 200); assert.equal((await response.json()).result.isError, true);
    const bindingHash = [...f.bindings.keys()][0]; f.storageGrants.add(bindingHash);
    // Narrowing memory scopes does not substitute for or erase the separate grant.
    const refresh = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, scope: 'context:read', resource }) });
    assert.equal(refresh.status, 200); const narrowed = await refresh.json();
    assert.equal(narrowed.scope, 'context:read');
    for (const [name, args] of [['clued_storage_submit', { ...ref, mutation }], ['clued_storage_inspect', ref]]) {
      response = await f.run('/mcp', storageCall(narrowed.access_token, name, args));
      assert.equal(response.status, 200); const body = (await response.json()).result;
      assert.equal(body.isError, false); assert.equal(body.structuredContent.execution_permitted, false);
      assert.equal(f.calls.filter(x => x.name === 'clued_storage_jobs_v1').at(-1).body.p_token_hash, bindingHash);
    }
    f.storageGrants.delete(bindingHash);
    response = await f.run('/mcp', storageCall(narrowed.access_token, 'clued_storage_inspect', ref));
    assert.equal((await response.json()).result.isError, true);
    f.storageGrants.add(bindingHash); f.env.CLUED_STORAGE_JOBS_V1 = 'false';
    let before = f.calls.filter(x => x.name === 'clued_storage_jobs_v1').length;
    assert.equal((await f.run('/mcp', storageCall(narrowed.access_token, 'clued_storage_submit', { ...ref, mutation }))).status, 404);
    assert.equal(f.calls.filter(x => x.name === 'clued_storage_jobs_v1').length, before);
    f.env.CLUED_STORAGE_JOBS_V1 = 'true'; f.bindings.get(bindingHash).active = false;
    before = f.calls.filter(x => x.name === 'clued_storage_jobs_v1').length;
    assert.equal((await f.run('/mcp', storageCall(narrowed.access_token, 'clued_storage_inspect', ref))).status, 400);
    assert.equal(f.calls.filter(x => x.name === 'clued_storage_jobs_v1').length, before);
  } finally { globalThis.fetch = originalFetch; }
});

test('real OAuth discovery challenges unauthenticated MCP and advertises the new issuer', async () => {
  const f = fixture(); try {
    assert.equal((await f.run('/mcp', { method: 'POST' })).status, 401);
    const response = await f.run('/.well-known/oauth-protected-resource/mcp');
    const metadata = await response.json(); assert.equal(metadata.resource, resource); assert.deepEqual(metadata.authorization_servers, [origin]);
    assert.deepEqual(metadata.scopes_supported, ['context:read', 'context:write', 'audit:read']);
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('PKCE and target are validated before consent or storage', async () => {
  const f = fixture(); try {
    const id = await client(f);
    const query = new URLSearchParams({ client_id: id, redirect_uri: 'https://client.example/callback', response_type: 'code', scope: 'context:read', resource: 'https://wrong.example/mcp' });
    assert.equal((await f.run(`/oauth/authorize?${query}`)).status >= 400, true); assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('consent requires the matching browser cookie and rejects cross-origin POST', async () => {
  const f = fixture(); try {
    const id = await client(f); const flow = await begin(f, id);
    assert.equal((await f.run(`/oauth/request?request_id=${flow.id}`, { headers: { Authorization: 'Bearer human-session-test' } })).status, 400);
    const before = f.calls.length;
    assert.equal((await f.run(`/oauth/decision?request_id=${flow.id}`, { method: 'POST', headers: { ...flow.headers, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal(f.calls.length, before);
  } finally { globalThis.fetch = originalFetch; }
});
test('two consent instances for the same client issue independent simultaneously usable grants', async () => {
  const f = fixture(); try {
    const id = await client(f); const first = await begin(f, id); const second = await begin(f, id);
    const a = await approve(f, id, first); const b = await approve(f, id, second);
    assert.notEqual(a.access_token, b.access_token); assert.equal(f.bindings.size, 2);
    for (const token of [a.access_token, b.access_token]) assert.equal((await f.run('/mcp', call(token, 'clued_record_list'))).status, 200);
  } finally { globalThis.fetch = originalFetch; }
});
test('OAuth MCP forwards the Worker execution context to the independent projection Builder', async () => {
  const f = fixture(); try {
    f.env.CLUED_PROJECTION_BUILDER_TOKEN = `clued_bnd_${'p'.repeat(43)}`;
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    assert.equal((await f.run('/mcp', call(token.access_token, 'clued_record_list'))).status, 200);
    await Promise.all(f.background);
    const claims = f.calls.filter(c => c.name === 'clued_mcp_projection_refresh_claim');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].body.p_token_hash,
      createHash('sha256').update(f.env.CLUED_PROJECTION_BUILDER_TOKEN).digest('hex'));
  } finally { globalThis.fetch = originalFetch; }
});
test('refresh downscoping cannot retain write capability in encrypted application props', async () => {
  const f = fixture(); try {
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    const refreshed = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, scope: 'context:read', resource }) });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const narrowed = await refreshed.json(); assert.equal(narrowed.scope, 'context:read');
    assert.equal((await f.run('/mcp', call(narrowed.access_token, 'clued_record_mutate'))).status, 403);
    assert.equal((await f.run('/mcp', call(narrowed.access_token, 'clued_event_carrier_transition'))).status, 403);
    assert.equal((await f.run('/mcp', call(narrowed.access_token, 'clued_projection_rebuild'))).status, 403);
    assert.equal((await f.run('/mcp', call(narrowed.access_token, 'clued_full_global_reconcile'))).status, 403);
    assert.equal(f.calls.some(c => c.name === 'clued_record_mutate'), false);
    assert.equal(f.calls.some(c => c.name === 'clued_mcp_event_carrier_transition'), false);
    assert.equal(f.calls.some(c => c.name === 'clued_mcp_projection_rebuild' || c.name === 'clued_mcp_full_global_reconcile'), false);
  } finally { globalThis.fetch = originalFetch; }
});
test('database revocation denies existing access and refresh even when provider KV remains unchanged', async () => {
  const f = fixture(); try {
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    for (const row of f.bindings.values()) row.active = false;
    const response = await f.run('/mcp', call(token.access_token, 'clued_record_list'));
    assert.equal(response.status >= 400, true);
    const refreshed = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    assert.equal(refreshed.status >= 400, true); assert.equal(f.calls.some(c => c.name === 'clued_record_list'), false);
  } finally { globalThis.fetch = originalFetch; }
});
test('context write requires an explicit write scope and unknown tools fail closed', () => {
  assert.deepEqual(requiredToolScopes('clued_context', { op: 'record_put' }), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_context', { op: 'feedback_list' }), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_event_carrier_transition'), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_session_reconcile'), ['context:read']);
  assert.deepEqual(requiredToolScopes('clued_projection_rebuild'), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_full_global_reconcile'), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_currentness_g6_gate'), ['context:read']);
  assert.equal(requiredToolScopes('clued_context', { op: 'publish' }), null);
  assert.equal(requiredToolScopes('clued_mcp_event_carrier_transition'), null);
  assert.equal(requiredToolScopes('invented_admin_tool'), null);
});

for (const type of ['access_token', 'refresh_token']) {
  test(`real provider ${type} revocation commits DB denial before success despite stale KV copies`, async () => {
    const f = fixture(); try {
      const id = await client(f); const token = await approve(f, id, await begin(f, id));
      const oldRows = new Map(f.env.OAUTH_KV.rows);
      const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token[type], token_type_hint: type, client_id: id }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal([...f.bindings.values()][0].active, false);
      f.env.OAUTH_KV.rows = oldRows; // Emulate Cloudflare KV stale replicas after deletion.
      assert.equal((await f.run('/mcp', call(token.access_token, 'clued_record_list'))).status >= 400, true);
    } finally { globalThis.fetch = originalFetch; }
  });
}
test('wrong-client revocation cannot reach the issuer revoke RPC', async () => {
  const f = fixture(); try {
    const ownerClient = await client(f); const otherClient = await client(f);
    const token = await approve(f, ownerClient, await begin(f, ownerClient));
    const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refresh_token, client_id: otherClient }) });
    assert.equal(response.status, 200); assert.equal([...f.bindings.values()][0].active, true);
    assert.equal(f.calls.some(c => c.name === 'clued_authorization_revoke_issuer_v12'), false);
  } finally { globalThis.fetch = originalFetch; }
});
test('denial is committed through request CAS before redirecting access_denied', async () => {
  const f = fixture(); try {
    const id = await client(f); const flow = await begin(f, id);
    const response = await f.run(`/oauth/decision?request_id=${flow.id}`, { method: 'POST', headers: { ...flow.headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'deny', version: flow.prepared.version }) });
    assert.equal(response.status, 200); assert.equal(new URL((await response.json()).redirect_url).searchParams.get('error'), 'access_denied');
    assert.equal(f.calls.some(c => c.name === 'clued_authorization_deny_v12' && c.body.p_base_version === flow.prepared.version), true);
    assert.equal(f.bindings.size, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('failed database revoke keeps provider tokens and never reports success', async () => {
  const f = fixture(); try {
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    const before = new Map(f.env.OAUTH_KV.rows); const wire = globalThis.fetch;
    globalThis.fetch = async (url, options) => String(url).endsWith('/clued_authorization_revoke_issuer_v12') ? Response.json({ error: 'unavailable' }, { status: 503 }) : wire(url, options);
    const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refresh_token, client_id: id }) });
    assert.equal(response.status >= 400, true); assert.deepEqual(f.env.OAUTH_KV.rows, before);
  } finally { globalThis.fetch = originalFetch; }
});


test('streamed oversized requests without Content-Length are stopped before OAuth storage', async () => {
  const f = fixture(); try {
    let canceled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { canceled = true; } });
    const response = await f.run('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
    assert.equal(response.status, 413); assert.equal(canceled, true);
    assert.equal(f.env.OAUTH_KV.rows.size, 0); assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('transient authorization outage during refresh preserves the usable refresh token', async () => {
  const f = fixture(); try {
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    const before = new Map(f.env.OAUTH_KV.rows); const wire = globalThis.fetch;
    globalThis.fetch = async (url, options) => String(url).endsWith('/clued_authorization_status_v12') ? Response.json({ error: 'busy' }, { status: 503 }) : wire(url, options);
    const options = () => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    const response = await f.run('/oauth/token', options());
    assert.equal(response.status, 503); assert.deepEqual(f.env.OAUTH_KV.rows, before);
    globalThis.fetch = wire;
    assert.equal((await f.run('/oauth/token', options())).status, 200);
  } finally { globalThis.fetch = originalFetch; }
});
