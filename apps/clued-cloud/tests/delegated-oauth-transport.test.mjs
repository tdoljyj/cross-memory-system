import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build, stop } from 'esbuild';
import { selectOAuthOrigin } from '../worker/oauth-origin.mjs';

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
const newOrigin = 'https://kooyumi.example';
const resource = `${origin}/mcp`;
const originalFetch = globalThis.fetch;
function fixture({ dualOrigin = false } = {}) {
  const bindings = new Map(); const prepared = new Map(); const calls = []; const background = [];
  const authorizationRequests = new Map(), bindingIssuers = new Map(), fallbackCalls = [];
  const users = new Map([
    ['human-session-test', { id: '10000000-0000-4000-8000-000000000001', email: 'test@example.invalid' }],
    ['other-human-session-test', { id: '10000000-0000-4000-8000-000000000002', email: 'other@example.invalid' }],
  ]);
  const storageGrants = new Set();
  const nativeManagement = { response: { status: 'ok' }, status: 200 };
  const grantScopes = ['context:read', 'context:write'];
  const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", OAUTH_KV: new MemoryKV(), CLUED_DELEGATED_OAUTH_V12: 'true', CLUED_OAUTH_ORIGIN: origin,
    CLUED_AUTHORIZATION_ISSUER_TOKEN: 'isolated-issuer-test-value', SUPABASE_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public-key', PROJECT_VIEWS_V2: 'true' };
  if (dualOrigin) Object.assign(env, { KOOYUMI_OAUTH_ORIGIN: newOrigin,
    KOOYUMI_AUTHORIZATION_ISSUER_TOKEN: 'independent-new-issuer-test-value', KOOYUMI_OAUTH_KV: new MemoryKV() });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const resourceIssuers = new Map([[resource, hash(env.CLUED_AUTHORIZATION_ISSUER_TOKEN)]]);
  if (dualOrigin) resourceIssuers.set(newOrigin + '/mcp', hash(env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN));
  const run = (route, options = {}, requestOrigin = origin) => {
    const request = new Request(`${requestOrigin}${route}`, options), selected = selectOAuthOrigin(request, env);
    return handle(request, selected, { waitUntil(promise) { background.push(promise); }, passThroughOnException() {}, props: {} }, async next => {
      fallbackCalls.push({ request: next, origin: selected.CLUED_OAUTH_ORIGIN, storage: selected.OAUTH_KV });
      return new Response('fallback', { status: 404, headers: { 'x-fixture-oauth-origin': selected.CLUED_OAUTH_ORIGIN } });
    });
  };
  globalThis.fetch = async (url, options = {}) => {
    const name = new URL(url).pathname.split('/').at(-1); const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ name, body, headers: options.headers });
    if (['clued_authorization_status_v12', 'clued_authorization_revoke_issuer_v12'].includes(name)) {
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-worker-gateway');
      assert.equal(new Headers(options.headers).get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    }
    if (name === 'user') {
      const token = new Headers(options.headers).get('Authorization')?.replace(/^Bearer /, '');
      return users.has(token) ? Response.json(users.get(token)) : Response.json({ error: 'invalid_session' }, { status: 401 });
    }
    if (name === 'clued_authorization_prepare_v12') {
      const expectedIssuer = resourceIssuers.get(body.p_request.resource);
      if (!expectedIssuer || body.p_issuer_hash !== expectedIssuer) return Response.json({ error: 'issuer_resource_mismatch' }, { status: 403 });
      if (!prepared.has(body.p_request.request_digest)) {
        const entry = { request_id: crypto.randomUUID(), version: 1,
          eligible: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', name: 'My memory', actions: ['read', 'write'] }] };
        prepared.set(body.p_request.request_digest, entry);
        authorizationRequests.set(entry.request_id, { resource: body.p_request.resource, issuerHash: expectedIssuer });
      }
      return Response.json(prepared.get(body.p_request.request_digest));
    }
    if (name === 'clued_authorization_approve_v12') {
      const entry = [...prepared.values()].find(p => p.request_id === body.p_request_id);
      if (authorizationRequests.get(body.p_request_id)?.issuerHash !== body.p_issuer_hash) return Response.json({ error: 'issuer_request_mismatch' }, { status: 403 });
      if (!entry || entry.version !== body.p_base_version) return Response.json({ error: 'conflict' }, { status: 409 });
      entry.version++;
      const binding = { binding_id: crypto.randomUUID(), active: true, version: 1, expires_at: body.p_expires_at, granted_scopes: [...grantScopes] };
      bindingIssuers.set(binding.binding_id, authorizationRequests.get(entry.request_id));
      bindings.set(body.p_binding_hash, binding); return Response.json(binding);
    }
    if (name === 'clued_authorization_revoke_issuer_v12') {
      const binding = [...bindings.values()].find(row => row.binding_id === body.p_binding_id);
      if (!binding || body.p_issuer_hash !== bindingIssuers.get(binding.binding_id)?.issuerHash) return Response.json({ error: 'denied' }, { status: 403 });
      binding.active = false; return Response.json({ status: 'revoked' });
    }
    if (name === 'clued_authorization_deny_v12') {
      const entry = [...prepared.values()].find(p => p.request_id === body.p_request_id);
      if (authorizationRequests.get(body.p_request_id)?.issuerHash !== body.p_issuer_hash) return Response.json({ error: 'issuer_request_mismatch' }, { status: 403 });
      if (!entry || entry.version !== body.p_base_version) return Response.json({ error: 'conflict' }, { status: 409 });
      entry.version++; return Response.json({ status: 'denied' });
    }
    if (name === 'clued_authorization_status_v12') {
      const binding = bindings.get(body.p_token_hash);
      return Response.json(binding ? { ...binding, active: binding.active && Date.parse(binding.expires_at) > Date.now() } : { active: false });
    }
    if (name === 'clued_record_list') return Response.json({ status: 'ok', records: [] });
    if (name === 'clued_mcp_append_event') return Response.json({ status: 'committed' });
    if (name === 'clued_authorization_manage_v12') return Response.json(nativeManagement.response, { status: nativeManagement.status });
    if (name === 'clued_storage_jobs_v1') {
      if (!bindings.get(body.p_token_hash)?.active || !storageGrants.has(body.p_token_hash)) {
        return Response.json({ message: 'storage_binding_denied', code: '42501' }, { status: 403 });
      }
      return Response.json({ connection_id: body.p_input.connection_id, job_id: body.p_input.job_id,
        request_digest: 'a'.repeat(64), status: 'queued', intent_id: null,
        receipt_id: '30000000-0000-4000-8000-000000000001', execution_permitted: false });
    }
    if (name === 'clued_storage_read_v1') {
      // No Owner read access in this fixture: the read evaluator denies every admit.
      return Response.json({ message: 'storage_read_denied', code: '42501' }, { status: 403 });
    }
    if (name === 'clued_mcp_projection_refresh_claim') return Response.json({ status: 'idle' });
    throw new Error(`Unexpected storage route: ${name}`);
  };
  return { env, run, bindings, calls, background, storageGrants, grantScopes, nativeManagement, users, authorizationRequests, bindingIssuers, fallbackCalls };
}
async function client(f, requestOrigin = origin) {
  const response = await f.run('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Isolated client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }, requestOrigin);
  assert.equal(response.status, 201); return (await response.json()).client_id;
}
async function begin(f, clientId, humanToken = 'human-session-test', requestOrigin = origin) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://client.example/callback', response_type: 'code', scope: 'context:read context:write', state: 'test-state', resource: requestOrigin + '/mcp',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const response = await f.run(`/oauth/authorize?${query}`, {}, requestOrigin);
  assert.equal(response.status, 302, await response.clone().text());
  const id = new URL(response.headers.get('Location')).searchParams.get('request_id');
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  const headers = { Authorization: `Bearer ${humanToken}`, Cookie: cookie };
  const read = await f.run(`/oauth/request?request_id=${id}`, { headers }, requestOrigin);
  assert.equal(read.status, 200, await read.clone().text());
  return { id, cookie, headers, verifier, prepared: await read.json(), authorizationLocation: response.headers.get('Location') };
}
async function approve(f, clientId, flow, days = 1, requestOrigin = origin, extraInput = {}) {
  const response = await f.run(`/oauth/decision?request_id=${flow.id}`, { method: 'POST', headers: { ...flow.headers, Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...extraInput, action: 'approve', version: flow.prepared.version, days, selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] }] }) }, requestOrigin);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes('clued_bnd_'), false);
  assert.equal(JSON.stringify(body).includes('human-session-test'), false);
  flow.authorizationRedirect = body.redirect_url;
  const code = new URL(body.redirect_url).searchParams.get('code');
  const token = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://client.example/callback', code_verifier: flow.verifier, resource: requestOrigin + '/mcp' }) }, requestOrigin);
  assert.equal(token.status, 200, await token.clone().text());
  return await token.json();
}
const call = (token, name, args = { record_type: 'state' }) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });

test('consent forwards independent future policies and exact current environment actions without rewriting the selection', async () => {
  // The controlled DB only checks HTTP wiring here; the PostgreSQL suite proves eligibility and enforcement.
  const f = fixture();
  try {
    const id = await client(f), flow = await begin(f, id);
    const selected = [
      { resource_kind: 'scope', resource_id: 'owned-project-records:future', environment: 'canonical', actions: ['read'] },
      { resource_kind: 'scope', resource_id: 'owned-project-contexts:future', environment: 'canonical', actions: ['write', 'feedback_submit'] },
      { resource_kind: 'context', resource_id: '20000000-0000-4000-8000-000000000002', environment: 'test', actions: ['read'] },
      { resource_kind: 'context', resource_id: '20000000-0000-4000-8000-000000000002', environment: 'preview', actions: ['write'] },
    ];
    const response = await f.run(`/oauth/decision?request_id=${flow.id}`, { method: 'POST',
      headers: { ...flow.headers, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', version: flow.prepared.version, days: 30, selected }) });
    assert.equal(response.status, 200);
    const approved = f.calls.filter(row => row.name === 'clued_authorization_approve_v12');
    assert.equal(approved.length, 1);
    assert.deepEqual(approved[0].body.p_selected, selected);
    assert.equal(approved[0].body.p_base_version, flow.prepared.version);
    const body = await response.json();
    assert.ok(new URL(body.redirect_url).searchParams.get('code'));
    assert.equal(JSON.stringify(body).includes('clued_bnd_'), false);
    assert.equal(JSON.stringify(body).includes('human-session-test'), false);
  } finally { globalThis.fetch = originalFetch; }
});

const profileUserId = '10000000-0000-4000-8000-000000000001';
const profileOtherUserId = '10000000-0000-4000-8000-000000000002';
const profileRpc = args => ({ jsonrpc: '2.0', id: 'profile-fixture', method: 'tools/call',
  params: { name: 'clued_account_profile', ...(args === undefined ? {} : { arguments: args }) } });
const mcpRequest = (token, payload, headers = {}) => ({ method: 'POST', headers: {
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers,
}, body: JSON.stringify(payload) });
async function profile(f, access, args = {}, requestOrigin = origin) {
  const response = await f.run('/mcp', mcpRequest(access, profileRpc(args)), requestOrigin);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const envelope = await response.json();
  assert.equal(envelope.id, 'profile-fixture');
  assert.equal(envelope.result.isError, false);
  assert.deepEqual(JSON.parse(envelope.result.content[0].text), envelope.result.structuredContent);
  return envelope.result;
}

async function independentOriginGrants(f) {
  assert.notEqual(f.env.OAUTH_KV, f.env.KOOYUMI_OAUTH_KV);
  const old = { origin, clientId: await client(f) };
  old.flow = await begin(f, old.clientId);
  old.token = await approve(f, old.clientId, old.flow);
  const oldBeforeNewAuthorization = new Map(f.env.OAUTH_KV.rows);
  const current = { origin: newOrigin, clientId: await client(f, newOrigin) };
  current.flow = await begin(f, current.clientId, 'human-session-test', newOrigin);
  current.token = await approve(f, current.clientId, current.flow, 1, newOrigin);
  assert.deepEqual(f.env.OAUTH_KV.rows, oldBeforeNewAuthorization, 'a new issuer authorization must not revoke or rewrite old grants');
  return { old, current };
}
const refreshOn = (f, target, refreshToken = target.token.refresh_token) => f.run('/oauth/token', { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: target.clientId, resource: target.origin + '/mcp',
  }) }, target.origin);

test('independent real OAuth issuers publish matching discovery, consent and profile identity without moving old grants', async () => {
  const f = fixture({ dualOrigin: true });
  try {
    const { old, current } = await independentOriginGrants(f);
    assert.notEqual(old.clientId, current.clientId);
    assert.notEqual(old.token.access_token, current.token.access_token);
    assert.equal(f.bindings.size, 2);
    for (const grant of [old, current]) {
      const protectedResponse = await f.run('/.well-known/oauth-protected-resource/mcp', {}, grant.origin);
      assert.equal(protectedResponse.status, 200);
      const protectedMetadata = await protectedResponse.json();
      assert.equal(protectedMetadata.resource, grant.origin + '/mcp');
      assert.deepEqual(protectedMetadata.authorization_servers, [grant.origin]);
      const issuerResponse = await f.run('/.well-known/oauth-authorization-server', {}, grant.origin);
      assert.equal(issuerResponse.status, 200);
      const issuer = await issuerResponse.json();
      assert.equal(issuer.issuer, grant.origin);
      assert.equal(issuer.authorization_endpoint, grant.origin + '/oauth/authorize');
      assert.equal(issuer.token_endpoint, grant.origin + '/oauth/token');
      assert.equal(new URL(grant.flow.authorizationLocation).origin, grant.origin);
      assert.equal(new URL(grant.flow.authorizationRedirect).searchParams.get('iss'), grant.origin);
      assert.deepEqual((await profile(f, grant.token.access_token, {}, grant.origin)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
      const fallback = await f.run('/oauth/consent', {}, grant.origin);
      assert.equal(fallback.status, 404, 'the fixture retains the Native-page fallback boundary');
      assert.equal(fallback.headers.get('x-fixture-oauth-origin'), grant.origin);
      assert.equal(f.fallbackCalls.at(-1).origin, grant.origin);
      assert.equal(f.fallbackCalls.at(-1).storage, grant.origin === origin ? f.env.OAUTH_KV : f.env.KOOYUMI_OAUTH_KV);
    }
    const hashes = f.calls.filter(row => row.name === 'clued_authorization_prepare_v12')
      .map(row => [row.body.p_request.resource, row.body.p_issuer_hash]);
    const expected = new Map([[resource, createHash('sha256').update(f.env.CLUED_AUTHORIZATION_ISSUER_TOKEN).digest('hex')],
      [newOrigin + '/mcp', createHash('sha256').update(f.env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN).digest('hex')]]);
    assert.deepEqual(new Set(hashes.map(([resource]) => resource)), new Set(expected.keys()));
    for (const [resource, issuerHash] of hashes) assert.equal(issuerHash, expected.get(resource));
    assert.ok([...f.bindings.values()].every(binding => binding.active));
  } finally { globalThis.fetch = originalFetch; }
});

test('access and refresh tokens cannot cross issuer KV namespaces and correct refresh remains usable in both directions', async () => {
  const f = fixture({ dualOrigin: true });
  try {
    const { old, current } = await independentOriginGrants(f);
    for (const [source, target] of [[old, current], [current, old]]) {
      const oldRows = new Map(f.env.OAUTH_KV.rows), newRows = new Map(f.env.KOOYUMI_OAUTH_KV.rows), before = f.calls.length;
      const access = await f.run('/mcp', mcpRequest(source.token.access_token, profileRpc({})), target.origin);
      assert.ok(access.status >= 400);
      assert.equal((await access.text()).includes(profileUserId), false);
      // Use the target's valid client and resource so an invalid-client check cannot mask KV isolation.
      const refresh = await refreshOn(f, target, source.token.refresh_token);
      assert.ok(refresh.status >= 400);
      assert.equal((await refresh.text()).includes(profileUserId), false);
      assert.deepEqual(f.env.OAUTH_KV.rows, oldRows);
      assert.deepEqual(f.env.KOOYUMI_OAUTH_KV.rows, newRows);
      assert.equal(f.calls.length, before, 'cross-issuer tokens never reach Binding or business RPCs');
    }
    for (const grant of [old, current]) {
      const response = await refreshOn(f, grant);
      assert.equal(response.status, 200, await response.clone().text());
      grant.token = await response.json();
      assert.deepEqual((await profile(f, grant.token.access_token, {}, grant.origin)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    }
  } finally { globalThis.fetch = originalFetch; }
});

for (const revokeOrigin of [origin, newOrigin]) {
  test(`revocation at ${revokeOrigin} affects only its own issuer grant`, async () => {
    const f = fixture({ dualOrigin: true });
    try {
      const { old, current } = await independentOriginGrants(f);
      const source = revokeOrigin === origin ? old : current, other = source === old ? current : old;
      const otherStorage = other.origin === origin ? f.env.OAUTH_KV : f.env.KOOYUMI_OAUTH_KV;
      const otherRows = new Map(otherStorage.rows);
      const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: source.token.refresh_token, token_type_hint: 'refresh_token', client_id: source.clientId }) }, source.origin);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(otherStorage.rows, otherRows);
      const revoke = f.calls.filter(row => row.name === 'clued_authorization_revoke_issuer_v12').at(-1);
      const expectedToken = source.origin === origin ? f.env.CLUED_AUTHORIZATION_ISSUER_TOKEN : f.env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN;
      assert.equal(revoke.body.p_issuer_hash, createHash('sha256').update(expectedToken).digest('hex'));
      assert.equal(f.bindingIssuers.get(revoke.body.p_binding_id).resource, source.origin + '/mcp');
      assert.ok((await f.run('/mcp', mcpRequest(source.token.access_token, profileRpc({})), source.origin)).status >= 400);
      assert.ok((await refreshOn(f, source)).status >= 400);
      assert.deepEqual((await profile(f, other.token.access_token, {}, other.origin)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
      const refreshed = await refreshOn(f, other);
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
      assert.equal([...f.bindings.values()].filter(binding => binding.active).length, 1);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test('the fake authorization boundary rejects an issuer secret that does not own the requested resource', async () => {
  const f = fixture({ dualOrigin: true });
  try {
    const id = await client(f, newOrigin);
    f.env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN = 'unregistered-independent-issuer';
    await assert.rejects(begin(f, id, 'human-session-test', newOrigin), error => error.actual === 403 && error.expected === 200);
    assert.equal(f.authorizationRequests.size, 0);
    assert.equal(f.bindings.size, 0);
    const request = f.calls.filter(row => row.name === 'clued_authorization_prepare_v12').at(-1);
    assert.equal(request.body.p_request.resource, newOrigin + '/mcp');
    assert.equal(request.body.p_issuer_hash, createHash('sha256').update('unregistered-independent-issuer').digest('hex'));
  } finally { globalThis.fetch = originalFetch; }
});

test('real OAuth profile publishes its exclusive identity schema and account marker without changing ordinary tools', async () => {
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    const before = f.calls.length;
    const response = await f.run('/mcp', mcpRequest(token.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const tools = (await response.json()).result.tools;
    const descriptors = tools.filter(tool => tool.name === 'clued_account_profile');
    assert.equal(descriptors.length, 1);
    const descriptor = descriptors[0];
    assert.deepEqual(descriptor.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    assert.deepEqual(descriptor.outputSchema.required, ['id']);
    assert.deepEqual(Object.keys(descriptor.outputSchema.properties), ['id', 'name', 'email', 'nickname']);
    assert.equal(descriptor.outputSchema.additionalProperties, false);
    assert.equal(descriptor.outputSchema.properties.id.format, 'uuid');
    assert.equal(descriptor._meta['openai/profile'], true);
    assert.deepEqual(descriptor._meta['clued/requiredScopes'], []);
    assert.equal(descriptor._meta['clued/scopeEnforcement'], 'server-side');
    assert.deepEqual(descriptor.securitySchemes, [{ type: 'oauth2', scopes: [] }]);
    assert.deepEqual(descriptor.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tools.filter(tool => tool._meta?.['openai/profile'] === true).length, 1);
    assert.ok(tools.some(tool => tool.name === 'clued_session_resume'));
    assert.ok(tools.some(tool => tool.name === 'clued_record_list'));
    assert.deepEqual(f.calls.slice(before).map(row => row.name), ['clued_authorization_status_v12']);
    assert.deepEqual(requiredToolScopes('clued_account_profile'), []);
  } finally { globalThis.fetch = originalFetch; }
});

test('real provider grants identify two accounts and keep one stable account id across independent connections and refresh', async () => {
  const f = fixture();
  try {
    const id = await client(f);
    const first = await approve(f, id, await begin(f, id));
    const second = await approve(f, id, await begin(f, id));
    const other = await approve(f, id, await begin(f, id, 'other-human-session-test'));
    assert.equal(f.bindings.size, 3);
    assert.notEqual(first.access_token, second.access_token);
    const before = f.calls.length;
    assert.deepEqual((await profile(f, first.access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    assert.deepEqual((await profile(f, second.access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    assert.deepEqual((await profile(f, other.access_token)).structuredContent, { id: profileOtherUserId, email: 'other@example.invalid' });
    assert.deepEqual(f.calls.slice(before).map(row => row.name), Array(3).fill('clued_authorization_status_v12'));
    const refreshed = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: id, scope: 'context:read', resource }) });
    assert.equal(refreshed.status, 200);
    const rotated = await refreshed.json();
    assert.notEqual(rotated.access_token, first.access_token);
    assert.deepEqual((await profile(f, rotated.access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
  } finally { globalThis.fetch = originalFetch; }
});

test('new OAuth snapshots only the same verified account email and ignores supplied profile fields', async () => {
  const f = fixture();
  try {
    const id = await client(f), flow = await begin(f, id);
    const token = await approve(f, id, flow, 1, origin, {
      user_id: profileOtherUserId, email: 'forged@example.invalid',
      profileSnapshot: { id: profileOtherUserId, email: 'forged@example.invalid' },
    });
    const response = await f.run('/mcp', mcpRequest(token.access_token, profileRpc({}), {
      'X-Profile-Email': 'forged@example.invalid', 'X-User-Id': profileOtherUserId,
    }));
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.deepEqual(result.structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    assert.equal(JSON.stringify(result).includes('forged@example.invalid'), false);
    assert.equal(JSON.stringify(result).includes(profileOtherUserId), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('tokens without an email snapshot keep the old props shape and remain id-only through refresh', async () => {
  const f = fixture();
  try {
    f.users.set('human-session-test', { id: profileUserId });
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    assert.deepEqual((await profile(f, token.access_token)).structuredContent, { id: profileUserId });
    f.users.set('human-session-test', { id: profileUserId, email: 'new@example.invalid' });
    const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    assert.equal(response.status, 200);
    const refreshed = await response.json();
    assert.deepEqual((await profile(f, refreshed.access_token)).structuredContent, { id: profileUserId });
    const next = await approve(f, id, await begin(f, id));
    assert.deepEqual((await profile(f, next.access_token)).structuredContent, { id: profileUserId, email: 'new@example.invalid' });
    assert.deepEqual((await profile(f, refreshed.access_token)).structuredContent, { id: profileUserId });
  } finally { globalThis.fetch = originalFetch; }
});

test('email display is an authorization-time snapshot rather than a live account lookup', async () => {
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    f.users.set('human-session-test', { id: profileUserId, email: 'changed@example.invalid' });
    const before = f.calls.length;
    assert.deepEqual((await profile(f, token.access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await profile(f, (await response.json()).access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    assert.equal(f.calls.slice(before).some(call => call.name === 'user'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('missing and invalid verified email values are omitted without blocking OAuth', async () => {
  const f = fixture();
  try {
    const id = await client(f);
    for (const email of [undefined, null, '', 'not-an-email', ' person@example.invalid', 'x'.repeat(321) + '@example.invalid']) {
      f.users.set('human-session-test', { id: profileUserId, ...(email === undefined ? {} : { email }) });
      const token = await approve(f, id, await begin(f, id));
      assert.deepEqual((await profile(f, token.access_token)).structuredContent, { id: profileUserId });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('authenticated profile needs no business scope, accepts only empty arguments and never leaks connection internals', async () => {
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    for (const binding of f.bindings.values()) binding.scopes = [];
    for (const args of [{}, undefined]) {
      const response = await f.run('/mcp', mcpRequest(token.access_token, profileRpc(args)));
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { id: profileUserId, email: 'test@example.invalid' });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      const serialized = JSON.stringify(result);
      for (const forbidden of [token.access_token, token.refresh_token, 'human-session-test', 'test-worker-gateway',
        'isolated-issuer-test-value', 'other@example.invalid', 'binding_id', 'bindingToken', 'scopes', 'clued_bnd_']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
      for (const binding of f.bindings.values()) assert.equal(serialized.includes(binding.binding_id), false);
    }
    for (const args of [null, [], false, '', { id: profileOtherUserId }, { user_id: profileOtherUserId }, { email: 'forged@example.invalid' },
      { profileSnapshot: { id: profileUserId, email: 'forged@example.invalid' } }, { binding_id: 'other' }, { token: 'other' }, { _meta: {} }]) {
      const response = await f.run('/mcp', mcpRequest(token.access_token, profileRpc(args)));
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /mcp_profile_input_invalid/);
      assert.equal(JSON.stringify(result).includes(profileUserId), false);
      assert.equal(JSON.stringify(result).includes(profileOtherUserId), false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('profile refuses unauthenticated, revoked and live-expired grants without returning an identity', async () => {
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    const binding = [...f.bindings.values()][0], expiry = binding.expires_at;
    const refusal = async options => {
      const response = await f.run('/mcp', options);
      assert.ok(response.status >= 400);
      const body = await response.text();
      assert.equal(body.includes(profileUserId), false);
      assert.equal(body.includes('test@example.invalid'), false);
      assert.equal(body.includes(token.access_token), false);
      assert.equal(body.includes(binding.binding_id), false);
    };
    await refusal({ ...mcpRequest(token.access_token, profileRpc({})), headers: { 'Content-Type': 'application/json' } });
    binding.active = false;
    await refusal(mcpRequest(token.access_token, profileRpc({})));
    binding.active = true; binding.expires_at = '2000-01-01T00:00:00.000Z';
    await refusal(mcpRequest(token.access_token, profileRpc({})));
    binding.expires_at = expiry;
    assert.deepEqual((await profile(f, token.access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
  } finally { globalThis.fetch = originalFetch; }
});

test('profile rejects expired provider access tokens before any database or identity read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    t.mock.timers.tick(16 * 60 * 1000);
    const before = f.calls.length;
    const response = await f.run('/mcp', mcpRequest(token.access_token, profileRpc({})));
    assert.ok(response.status >= 400);
    assert.equal((await response.text()).includes(profileUserId), false);
    assert.equal(f.calls.length, before);
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});

test('profile never returns cached identity when live authorization status is unavailable', async () => {
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    assert.deepEqual((await profile(f, token.access_token)).structuredContent, { id: profileUserId, email: 'test@example.invalid' });
    const wire = globalThis.fetch;
    globalThis.fetch = async (url, options) => String(url).endsWith('/clued_authorization_status_v12')
      ? Response.json({ message: 'private provider and SQL diagnostics' }, { status: 503 }) : wire(url, options);
    const response = await f.run('/mcp', mcpRequest(token.access_token, profileRpc({})));
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes(profileUserId), false);
    assert.equal(body.includes('test@example.invalid'), false);
    assert.equal(body.includes('private provider'), false);
    assert.equal(body.includes(token.access_token), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('profile transport preserves Origin and JSON-RPC validation and refuses every batch without partial results', async () => {
  const f = fixture();
  try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    const cases = [
      [profileRpc({}), { Origin: 'https://attacker.example' }, 403],
      [{ ...profileRpc({}), jsonrpc: '1.0' }, {}, 400],
      [{ jsonrpc: '2.0', id: 1, params: { name: 'clued_account_profile' } }, {}, 400],
      [[profileRpc({})], {}, 400],
      [[profileRpc({}), { jsonrpc: '2.0', id: 2, method: 'tools/list' }], {}, 400],
    ];
    for (const [payload, headers, status] of cases) {
      const before = f.calls.length;
      const response = await f.run('/mcp', mcpRequest(token.access_token, payload, headers));
      assert.equal(response.status, status);
      const body = await response.text();
      assert.equal(body.includes(profileUserId), false);
      assert.equal(body.includes('structuredContent'), false);
      assert.equal(body.includes(token.access_token), false);
      assert.deepEqual(f.calls.slice(before).map(row => row.name), ['clued_authorization_status_v12']);
    }
    const invalidJson = await f.run('/mcp', { ...mcpRequest(token.access_token, profileRpc({})), body: '{"jsonrpc":' });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.text()).includes(profileUserId), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Native exact limit confirmation forwards Owner credentials and CAS without bypassing Origin, operation or size gates', async () => {
  const f = fixture();
  try {
    const headers = { Authorization: 'Bearer human-session-test', Origin: origin, 'Content-Type': 'application/json' };
    const issue = { op: 'limit_confirmation_issue', binding_id: '20000000-0000-4000-8000-000000000001', base_version: 4,
      resource_kind: 'context', resource_id: '20000000-0000-4000-8000-000000000002', environment: 'test',
      grant_id: '20000000-0000-4000-8000-000000000003', grant_base_version: 3,
      override_id: '20000000-0000-4000-8000-000000000004', override_base_version: 2,
      new: { actions: ['read'], denied_actions: [], allowed_ceiling: ['read'], history_policy: 'SINCE_GRANT',
        version_policy: 'LATEST', freeze_cursor: 8, since_cursor: 8, explicit_record_ids: [], allowed_fields: ['title'], expires_at: '2099-01-01T00:00:00Z' } };
    const post = (body, requestHeaders = headers) => f.run('/oauth/connections/api', { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) });
    f.nativeManagement.response = { status: 'issued', confirmation_token: 'fixture-native-confirmation', view_digest: 'a'.repeat(64) };
    let response = await post(issue);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'issued');
    const forwarded = f.calls.filter(row => row.name === 'clued_authorization_manage_v12').at(-1);
    assert.deepEqual(forwarded.body, { p_input: issue });
    assert.equal(new Headers(forwarded.headers).get('Authorization'), 'Bearer human-session-test');
    assert.equal(JSON.stringify(forwarded.body).includes('test-worker-gateway'), false);
    const confirmation = { op: 'limit_confirm', confirmation_token: 'fixture-native-confirmation', view_digest: 'a'.repeat(64) };
    f.nativeManagement.response = { status: 'committed', receipt_id: '20000000-0000-4000-8000-000000000005', version: 5 };
    response = await post(confirmation);
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.filter(row => row.name === 'clued_authorization_manage_v12').at(-1).body, { p_input: confirmation });
    const before = f.calls.length;
    for (const [body, requestHeaders, status] of [
      [issue, { ...headers, Origin: 'https://another.example' }, 403],
      [issue, { Origin: origin, 'Content-Type': 'application/json' }, 401],
      [{ op: 'clear_all_limits', binding_id: issue.binding_id }, headers, 400],
      [{ ...issue, padding: 'x'.repeat(65536) }, headers, 413],
    ]) {
      response = await post(body, requestHeaders);
      assert.equal(response.status, status);
      assert.equal(f.calls.length, before, 'refused requests must not reach the database');
    }
    // Real precise authorization, expiry, digest, CAS and replay outcomes are exercised on PostgreSQL;
    // this fake response proves only the existing HTTP boundary preserves an actual DB refusal.
    f.nativeManagement.status = 409;
    f.nativeManagement.response = { message: 'private SQL and confirmation details', code: 'conflict' };
    response = await post(confirmation);
    assert.equal(response.status, 409);
    assert.equal((await response.text()).includes('private SQL'), false);
  } finally { globalThis.fetch = originalFetch; }
});
test('last-permission reduction exposes only its controlled business code and keeps private diagnostics redacted', async () => {
  const f = fixture();
  try {
    const headers = { Authorization: 'Bearer human-session-test', Origin: origin, 'Content-Type': 'application/json' };
    const post = op => f.run('/oauth/connections/api', { method: 'POST', headers, body: JSON.stringify({ op, binding_id: '20000000-0000-4000-8000-000000000001', base_version: 4 }) });
    f.nativeManagement.status = 400;
    f.nativeManagement.response = { code: '22023', message: 'authorization_empty_projection_requires_binding_revoke', details: 'private SQL and context identity' };
    let response = await post('reduce');
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, 'authorization_empty_projection_requires_binding_revoke');
    assert.ok(result.message.includes('本次修改未保存'));
    assert.ok(!JSON.stringify(result).includes('private SQL'));
    response = await post('revoke');
    assert.equal(response.status, 403, 'the business-code exception is limited to reduction');
    assert.ok(!(await response.text()).includes('authorization_empty_projection'));
    f.nativeManagement.response = { code: '22023', message: 'private SQL and context identity' };
    response = await post('reduce');
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes('private SQL'));
  } finally { globalThis.fetch = originalFetch; }
});

// A gateway scope refusal is a tool error (HTTP 200, isError) carrying what to request; Hosts drop 403 bodies.
async function scopeDenied(response) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 1);
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.error.code, 'insufficient_scope');
  assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent);
  return body.result.structuredContent.error;
}

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

test('real OAuth MCP clued_storage_browse reaches the read evaluator with any memory scope', async () => {
  const f = fixture();
  try {
    Object.assign(f.env, { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: 'true', CLUED_STORAGE_GOOGLE_V1: 'true', CLUED_STORAGE_READ_V1: 'true',
      CLUED_STORAGE_CONNECTOR_ISSUER: 'i'.repeat(40), CLUED_STORAGE_GOOGLE_CLIENT_ID: 'read-client',
      CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: 'v1', keys: { v1: Buffer.alloc(32, 7).toString('base64url') } }),
      CLUED_STORAGE_READ_CURSOR_KEY: btoa('c'.repeat(32)), CLUED_STORAGE_READ_RECEIPT_KEYS: JSON.stringify({ current: 'k1', keys: { k1: btoa('h'.repeat(32)) } }) });
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    const refresh = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, scope: 'context:read', resource }) });
    assert.equal(refresh.status, 200); const narrowed = await refresh.json();
    const bindingHash = [...f.bindings.keys()][0];
    const browse = access => ({ ...call(access, 'clued_storage_browse'), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'clued_storage_browse', arguments: { connection_id: '20000000-0000-4000-8000-000000000001', operation: 'list' } } }) });
    const reads = () => f.calls.filter(x => x.name === 'clued_storage_read_v1');
    for (const access of [token.access_token, narrowed.access_token]) {
      const before = reads().length;
      const response = await f.run('/mcp', browse(access));
      // Not the OAuth scope gate's 403: the call reaches the read evaluator, whose denial is a tool error.
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()).result;
      assert.equal(body.isError, true); assert.equal(body.structuredContent.error, 'storage_read_unavailable');
      assert.equal(reads().length, before + 1);
      assert.equal(reads().at(-1).body.p_token_hash, bindingHash); assert.equal(reads().at(-1).body.p_input.action, 'admit');
    }
    f.env.CLUED_STORAGE_READ_V1 = 'false';
    const before = reads().length;
    assert.equal((await f.run('/mcp', browse(narrowed.access_token))).status, 404);
    assert.equal(reads().length, before);
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
test('refresh token lifetime follows the chosen authorization lifetime, up to 365 days', async () => {
  const f = fixture();
  try {
    const id = await client(f);
    for (const days of [1, 90, 365]) {
      const before = Math.floor(Date.now() / 1000);
      const token = await approve(f, id, await begin(f, id), days);
      const [userId, grantId] = token.refresh_token.split(':');
      const grant = JSON.parse(await f.env.OAUTH_KV.get(`grant:${userId}:${grantId}`));
      const lifetime = grant.expiresAt - before;
      assert.ok(lifetime > days * 86400 - 60 && lifetime <= days * 86400 + 1, `${days} days: ${lifetime}s`);
      const refresh = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
      assert.equal(refresh.status, 200, await refresh.clone().text());
    }
    for (const days of [0, 31, 366]) {
      const flow = await begin(f, id);
      const response = await f.run(`/oauth/decision?request_id=${flow.id}`, { method: 'POST', headers: { ...flow.headers, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: flow.prepared.version, days, selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] }) });
      assert.equal(response.status, 400, `${days} days is not an offered lifetime`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('OAuth MCP wakes the independent projection Builder only after a successful write', async () => {
  const f = fixture(); try {
    f.env.CLUED_PROJECTION_BUILDER_TOKEN = `clued_bnd_${'p'.repeat(43)}`;
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    assert.equal((await f.run('/mcp', call(token.access_token, 'clued_record_list'))).status, 200);
    await Promise.all(f.background);
    assert.equal(f.calls.filter(c => c.name === 'clued_mcp_projection_refresh_claim').length, 0);
    const response = await f.run('/mcp', call(token.access_token, 'clued_append_event', { context_key: 'global', event_type: 'action' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.isError, false);
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
    // The connection's live scopes still include write; the narrowed token does not regain it.
    for (const row of f.bindings.values()) row.scopes = ['context:read', 'context:write'];
    await scopeDenied(await f.run('/mcp', call(narrowed.access_token, 'clued_record_mutate')));
    await scopeDenied(await f.run('/mcp', call(narrowed.access_token, 'clued_event_carrier_transition')));
    await scopeDenied(await f.run('/mcp', call(narrowed.access_token, 'clued_projection_rebuild')));
    await scopeDenied(await f.run('/mcp', call(narrowed.access_token, 'clued_full_global_reconcile')));
    assert.equal(f.calls.some(c => c.name === 'clued_record_mutate'), false);
    assert.equal(f.calls.some(c => c.name === 'clued_mcp_event_carrier_transition'), false);
    assert.equal(f.calls.some(c => c.name === 'clued_mcp_projection_rebuild' || c.name === 'clued_mcp_full_global_reconcile'), false);
  } finally { globalThis.fetch = originalFetch; }
});
test('a connection the Owner widened uses its live scopes without reconnecting; a reduced one loses them', async () => {
  const f = fixture(); try {
    f.grantScopes.splice(0, f.grantScopes.length, 'context:read');
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    assert.equal(token.scope, 'context:read');
    // Before the Owner approves a connection.permission request: refused at the gateway.
    for (const row of f.bindings.values()) row.scopes = ['context:read'];
    const denied = await scopeDenied(await f.run('/mcp', call(token.access_token, 'clued_record_mutate')));
    // The refusal names what is missing and the request that asks the Owner for it.
    assert.deepEqual(denied.missing, { context: 'global', action: 'write', scope: 'context:write' });
    assert.equal(denied.suggested_request.action, 'connection.permission');
    assert.deepEqual(denied.suggested_request.resources, ['permission:global/write']);
    assert.match(denied.suggested_request.idempotency_key, /^permission:global\/write:\d{8}$/);
    assert.equal(f.calls.some(c => c.name === 'clued_record_mutate'), false);
    // After approval the database reports write on the same connection: the same token passes the gateway.
    for (const row of f.bindings.values()) row.scopes = ['context:read', 'context:write'];
    await f.run('/mcp', call(token.access_token, 'clued_record_mutate'));
    assert.equal(f.calls.some(c => c.name === 'clued_record_mutate'), true);
    // A refreshed token that keeps the whole grant follows the live scopes too.
    const refreshed = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const renewed = await refreshed.json();
    const before = f.calls.filter(c => c.name === 'clued_record_mutate').length;
    await f.run('/mcp', call(renewed.access_token, 'clued_record_mutate'));
    assert.equal(f.calls.filter(c => c.name === 'clued_record_mutate').length, before + 1);
    // When the Owner reduces the connection, the live scopes win over the token's.
    for (const row of f.bindings.values()) row.scopes = [];
    await scopeDenied(await f.run('/mcp', call(renewed.access_token, 'clued_record_list')));
  } finally { globalThis.fetch = originalFetch; }
});
test('a read-only connection can ask for a connection permission', async () => {
  const f = fixture(); try {
    f.env.CLUED_OWNER_REQUESTS_V1 = 'true';
    f.grantScopes.splice(0, f.grantScopes.length, 'context:read');
    const id = await client(f); const token = await approve(f, id, await begin(f, id));
    for (const row of f.bindings.values()) row.scopes = ['context:read'];
    const ask = (args) => ({ ...call(token.access_token, 'clued_owner_request'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_owner_request', arguments: args } }) });
    await scopeDenied(await f.run('/mcp', ask({ action: 'release.production', resources: ['repo:o/n/abc'], idempotency_key: 'release-key-1' })));
    assert.equal(f.calls.some(c => c.name === 'clued_owner_request_v1'), false);
    await f.run('/mcp', ask({ action: 'connection.permission', resources: ['permission:global/write'], idempotency_key: 'permission-key-1' }));
    assert.equal(f.calls.filter(c => c.name === 'clued_owner_request_v1').length, 1);
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
  // Storage connection discovery (Decision 1721045d): the storage evaluators decide, not a context scope.
  assert.deepEqual(requiredToolScopes('clued_storage_connections'), []);
  assert.deepEqual(requiredToolScopes('clued_projection_rebuild'), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_full_global_reconcile'), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_currentness_g6_gate'), ['context:read']);
  assert.deepEqual(requiredToolScopes('clued_owner_request'), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_owner_request', { action: 'release.production' }), ['context:write']);
  assert.deepEqual(requiredToolScopes('clued_owner_request', { action: 'connection.permission' }), []);
  assert.deepEqual(requiredToolScopes('clued_owner_request', { request_id: '10000000-0000-4000-8000-000000000001' }), []);
  assert.deepEqual(requiredToolScopes('clued_storage_browse'), []);
  assert.deepEqual(requiredToolScopes('clued_storage_read'), []);
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

test('a missing Worker gateway denies OAuth refresh before storage and preserves its token', async () => {
  const f = fixture(); try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    const before = new Map(f.env.OAUTH_KV.rows), count = f.calls.length;
    delete f.env.CLUED_DB_GATEWAY_TOKEN;
    const response = await f.run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, count);
    assert.deepEqual(f.env.OAUTH_KV.rows, before);
    assert.equal((await response.text()).includes('test-worker-gateway'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('a rejected Worker JWT leaves the OAuth refresh token usable after gateway recovery', async () => {
  const f = fixture(); try {
    const id = await client(f), token = await approve(f, id, await begin(f, id));
    const before = new Map(f.env.OAUTH_KV.rows), wire = globalThis.fetch;
    globalThis.fetch = async (url, options) => String(url).endsWith('/clued_authorization_status_v12')
      ? Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 }) : wire(url, options);
    const options = () => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource }) });
    const response = await f.run('/oauth/token', options());
    assert.equal(response.status, 503);
    assert.deepEqual(f.env.OAUTH_KV.rows, before);
    globalThis.fetch = wire;
    assert.equal((await f.run('/oauth/token', options())).status, 200);
  } finally { globalThis.fetch = originalFetch; }
});
