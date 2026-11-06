import { stopCluster } from './cluster-cleanup.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';
import EmbeddedPostgres from 'embedded-postgres';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';

// S2c Integration Runtime PR-5 (IntegrationRuntime v0.1.8 §13.5 T-A11-4b (a)(d)): the real Host-disconnect
// path. The pinned OAuth provider (worker/delegated-oauth.ts) and the continuity Worker run in process over
// a migrated PostgreSQL; only identity and the PostgREST hop are local fixtures. (a) an RFC 7009 revocation
// at POST /oauth/token reaches revoke_issuer and derives REVOKED (CONNECTION_USER_REVOKE); reconnecting the
// same client is refused. (d) refresh rotation, expiry and the provider's expiry cleanup never call
// revoke_issuer. The (b)(c) variants are in integration-runtime-lifecycle-db.test.mjs.
// The controlled PostgREST shim selects real PostgreSQL roles from synthetic credentials.
// Its HTTP status mapping is fixture behavior; this does not qualify production JWT
// verification or real PostgREST response codes.
// Every database runs as a non-root OS user (embedded-postgres refuses root).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://clued.example';
const resource = `${origin}/mcp`;
const OWNER = '10000000-0000-4000-8000-0000000000a1';
const FULL = ['audit.read', 'context.read', 'context.write', 'development_history.read', 'evidence.write',
  'project.read', 'project.write'];
const BINDING_RPCS = ['clued_integration_request_open_v1', 'clued_integration_create_or_bind_v1',
  'clued_integration_identity_update_v1', 'clued_integration_reconcile_request_v1', 'clued_integration_status_v1',
  'clued_integration_declare_v1', 'clued_integration_report_v1', 'clued_integration_verify_v1', 'clued_integration_revoke_self_v1'];
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const key = (label) => `${label}-${crypto.randomUUID()}`;

// Workers KV as the provider uses it, including expiry: expirationTtl / expiration evict a row once
// Date.now passes it. That eviction is the provider's expiry cleanup; it never goes through delete.
class MemoryKV {
  rows = new Map();
  deletes = [];
  live(name) {
    const row = this.rows.get(name);
    if (row && row.expiresAt !== null && Date.now() >= row.expiresAt) this.rows.delete(name);
    return this.rows.get(name);
  }
  async get(name, type) {
    const row = this.live(name);
    return row === undefined ? null : type === 'json' || type?.type === 'json' ? JSON.parse(row.value) : row.value;
  }
  async put(name, value, options = {}) {
    const expiresAt = options.expiration ? options.expiration * 1000
      : options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.rows.set(name, { value, expiresAt });
  }
  async delete(name) { this.deletes.push(name); this.rows.delete(name); }
  async list({ prefix = '' } = {}) {
    const keys = [...this.rows.keys()].filter((name) => name.startsWith(prefix) && this.live(name));
    return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: '' };
  }
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('T-A11-4b (a)(d): the Host disconnect through the real OAuth provider and Worker', { timeout: 600_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-transport-'));
  await build({ entryPoints: [path.join(root, 'worker/delegated-oauth.ts')], outdir: directory, bundle: true, platform: 'node',
    format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'silent', plugins: [{ name: 'worker-runtime-only', setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'worker-runtime', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class WorkerEntrypoint {}' }));
    } }] });
  stop();
  const { handleDelegatedOAuth } = await import(pathToFileURL(path.join(directory, 'delegated-oauth.mjs')).href);
  const server = new EmbeddedPostgres({
    databaseDir: path.join(directory, 'db'), user: 'postgres', password: sha(crypto.randomUUID()), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  const clients = [];
  const connect = async () => {
    const client = server.getPgClient();
    clients.push(client);
    await client.connect();
    return client;
  };
  try {
    await server.initialise();
    await server.start();
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowTestIssuerCredentials(admin);
    // The entire chain includes G6: current Binding RPCs are GW-only, while Native remains authenticated.
    for (const rpc of BINDING_RPCS) {
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway']) {
        const {rows}=await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') ok",[role,`public.${rpc}(text,jsonb)`]);
        assert.equal(rows[0].ok,role==='clued_worker_gateway',role+': '+rpc);
      }
    }
    for(const fn of ['clued_user_integration_v1','clued_admin_integration_v1']) {
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway']) {
        const {rows}=await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') ok",[role,`public.${fn}(jsonb)`]);
        assert.equal(rows[0].ok,role==='authenticated',role+': '+fn);
      }
    }
    const closeout=await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    const callerCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',closeout),'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin),callerCatalog);
    await assertGatewayCloseoutBoundary(admin);
    // test-only registry rows (§13.0)
    await admin.query(`insert into clued_private.integration_hosts_v1(host, tenant_dimension, account_dimension,
        tenant_evidence_kinds, account_evidence_kinds, first_authorization_required, registry_version, capability_snapshot_ref)
      values ('test.complete', 'NOT_APPLICABLE', 'NOT_APPLICABLE', '{}', '{}', true, 1, 'test')`);
    await admin.query(`insert into clued_private.integration_host_surfaces_v1(host, surface, capability_ceiling, host_features, registry_version)
      values ('test.complete', 'default', $1::text[], '{"mcp_tools":true,"oauth":true,"hooks":false}', 1)`, [FULL]);
    await admin.query("insert into auth.users(id, email, email_confirmed_at) values ($1, 'owner@clued.test', now())", [OWNER]);
    const issuer = crypto.randomBytes(32).toString('hex');
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash, resource, name)
      values ($1, $2, 'Integration transport fixture')`, [sha(issuer), resource]);
    const human = await connect();
    const gateway = await connect();
    await human.query('set role authenticated');
    await human.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
      [OWNER, JSON.stringify({ sub: OWNER })]);
    await gateway.query('set session authorization authenticator; set role clued_worker_gateway');
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);

    const gatewayToken = 'synthetic-integration-runtime-worker-gateway';
    const env = { CLUED_DB_GATEWAY_TOKEN: gatewayToken, OAUTH_KV: new MemoryKV(), CLUED_DELEGATED_OAUTH_V12: 'true', CLUED_OAUTH_ORIGIN: origin,
      CLUED_AUTHORIZATION_ISSUER_TOKEN: issuer, SUPABASE_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
      PROJECT_VIEWS_V2: 'true', CLUED_INTEGRATION_RUNTIME_V1: 'true',
      ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
    // PostgREST stand-in: the account JWT runs as authenticated with its claims;
    // the Worker credential runs as the real gateway, and unknown credentials are refused.
    // the SQLSTATE → HTTP mapping is PostgREST's for the codes these entries raise.
    const rpcLog = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://db.invalid', url.href);
      const isHuman = new Headers(init.headers).get('authorization') === 'Bearer fixture-human';
      if (url.pathname === '/auth/v1/user') {
        return isHuman ? Response.json({ id: OWNER, email: 'owner@clued.test', email_confirmed_at: '2026-10-01T00:00:00Z' })
          : Response.json({ message: 'invalid JWT' }, { status: 401 });
      }
      const name = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname)?.[1];
      assert.ok(name, url.pathname);
      if (!isHuman && new Headers(init.headers).get('authorization') !== `Bearer ${gatewayToken}`) {
        return Response.json({ code: 'PGRST301', message: 'invalid JWT' }, { status: 401 });
      }
      rpcLog.push(name);
      const values = JSON.parse(init.body || '{}');
      const keys = Object.keys(values);
      assert.ok(keys.every((name) => /^p_[a-z0-9_]+$/.test(name)), keys.join());
      try {
        const { rows } = await (isHuman ? human : gateway).query(
          `select public.${name}(${keys.map((name, index) => `${name} => $${index + 1}`).join(', ')}) value`,
          keys.map((name) => (values[name] !== null && typeof values[name] === 'object' ? JSON.stringify(values[name]) : values[name])));
        return Response.json(rows[0].value);
      } catch (error) {
        const status = error.code === '42501' ? (isHuman ? 403 : 401) : ['40001', '23505', '23503'].includes(error.code) ? 409
          : /^(P0|XX|55|25)/.test(error.code) && error.code !== 'P0001' ? 500 : 400;
        return Response.json({ code: error.code, message: error.message }, { status });
      }
    };
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
    const run = (route, options = {}) => handleDelegatedOAuth(new Request(`${origin}${route}`, options), env, ctx,
      async () => new Response('not found', { status: 404 }));
    const form = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

    const register = async () => {
      const response = await run('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Integration Host', redirect_uris: ['https://host.example/callback'],
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
      assert.equal(response.status, 201);
      return (await response.json()).client_id;
    };
    // The consent page flow: authorize → request → approve (global scope) → code exchange.
    const authorize = async (clientId) => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://host.example/callback', response_type: 'code',
        scope: 'context:read context:write', state: 'integration', resource,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      const begun = await run(`/oauth/authorize?${query}`);
      assert.equal(begun.status, 302, await begun.clone().text());
      const requestId = new URL(begun.headers.get('Location')).searchParams.get('request_id');
      const headers = { Authorization: 'Bearer fixture-human', Cookie: begun.headers.get('Set-Cookie').split(';')[0] };
      const details = await run(`/oauth/request?request_id=${requestId}`, { headers });
      assert.equal(details.status, 200, await details.clone().text());
      const prepared = await details.json();
      const global = prepared.eligible.find((row) => row.resource_kind === 'scope' && row.resource_id === 'global');
      assert.ok(global, JSON.stringify(prepared.eligible));
      const decision = await run(`/oauth/decision?request_id=${requestId}`, { method: 'POST',
        headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: prepared.version, days: 1,
          selected: [{ resource_kind: 'scope', resource_id: 'global', environment: global.environment, actions: ['read', 'write'] }] }) });
      assert.equal(decision.status, 200, await decision.clone().text());
      const code = new URL((await decision.json()).redirect_url).searchParams.get('code');
      const token = await run('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: clientId,
        redirect_uri: 'https://host.example/callback', code_verifier: verifier, resource }));
      assert.equal(token.status, 200, await token.clone().text());
      const issued = await token.json();
      const bindingId = (await admin.query(`select binding_id from clued_private.authorizations_v12 where client_id = $1
        order by created_at desc limit 1`, [clientId])).rows[0].binding_id;
      return { ...issued, bindingId };
    };
    const mcp = async (accessToken, name, args = {}) => {
      const response = await run('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      return { status: response.status, body, result: body?.result?.structuredContent };
    };
    const evaluate = async (id) => (await admin.query('select clued_private.integration_evaluate_v1($1, clock_timestamp()) e', [id])).rows[0].e;
    const version = async (id) => Number((await admin.query('select version from clued_private.integrations_v1 where integration_id = $1',
      [id])).rows[0].version);
    const issuerAudit = async () => Number((await admin.query(`select count(*) n from clued_private.authorization_audit_v12
      where operation = 'revoke_issuer'`)).rows[0].n);
    const install = (accessToken, intent, extra = {}) => mcp(accessToken, 'clued_integration_install', {
      request_key: key('request-key'), intent, host: 'test.complete', host_surface: 'default', adapter_family: 'test-adapter',
      adapter_version: '1.0.0', installation_phase: 'COMPLETED', idempotency_key: key('bind'), ...extra });
    // A fresh ACTIVE Integration on its own DCR client: install, one resume after the link, A-class verification,
    // every step over the Worker with the access token the provider issued.
    const activeIntegration = async () => {
      const clientId = await register();
      const tokens = await authorize(clientId);
      const installed = await install(tokens.access_token, 'create_or_bind');
      assert.equal(installed.status, 200, JSON.stringify(installed.body));
      assert.equal(installed.result.status, 'committed', JSON.stringify(installed.result));
      const id = installed.result.supplemental.integration_id;
      assert.equal((await evaluate(id)).integration_state, 'VERIFYING');
      const resumed = await mcp(tokens.access_token, 'clued_session_resume', { context_key: 'global', client_session_id: key('session') });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      const verified = await mcp(tokens.access_token, 'clued_integration_verify', { kind: 'canonical_baseline',
        idempotency_key: key('verify'), integration_id: id, base_version: await version(id) });
      assert.equal(verified.result.status, 'committed', JSON.stringify(verified.result));
      assert.equal(verified.result.supplemental.result, 'PASS', JSON.stringify(verified.result.supplemental));
      const checks = (await admin.query(`select checks from clued_private.integration_canonical_verifications_v1
        where integration_id = $1 order by verified_at desc limit 1`, [id])).rows[0]?.checks;
      assert.ok(JSON.stringify(checks ?? {}).includes('2025-06-18'), 'the Worker-observed protocol version was recorded');
      assert.equal((await evaluate(id)).integration_state, 'ACTIVE');
      const status = await mcp(tokens.access_token, 'clued_integration_status', { integration_id: id });
      assert.equal(status.status, 200, JSON.stringify(status.body));
      return { clientId, tokens, id };
    };

    await t.test('T-A11-4b (a) RFC 7009 revocation at /oauth/token → revoke_issuer → REVOKED; the same client cannot reconnect it', async () => {
      const { clientId, tokens, id } = await activeIntegration();
      const audit = await issuerAudit();
      const v0 = await version(id);
      rpcLog.length = 0;
      const revoked = await run('/oauth/token', form({ token: tokens.refresh_token, client_id: clientId }));
      assert.equal(revoked.status, 200, await revoked.clone().text());
      assert.ok(rpcLog.includes('clued_authorization_revoke_issuer_v12'), rpcLog.join());
      assert.equal(await issuerAudit(), audit + 1);
      const row = (await admin.query(`select binding_id from clued_private.authorization_audit_v12 where operation = 'revoke_issuer'
        order by recorded_at desc limit 1`)).rows[0];
      assert.equal(row.binding_id, tokens.bindingId);
      const evaluation = await evaluate(id);
      assert.equal(evaluation.integration_state, 'REVOKED');
      assert.equal(evaluation.facts.revocation_source, 'CONNECTION_USER_REVOKE');
      assert.equal(await version(id), v0, 'derived at read time: no Integration write');
      assert.ok((await mcp(tokens.access_token, 'clued_integration_status', { integration_id: id })).status >= 400,
        'the revoked token no longer reaches the Worker');

      // the same client re-authorizes on the consent page: a new Binding, refused for this Integration
      const again = await authorize(clientId);
      assert.notEqual(again.bindingId, tokens.bindingId);
      for (const [intent, extra] of [['reauthorization', { target_integration_id: id }], ['create_or_bind', {}]]) {
        const refused = await install(again.access_token, intent, extra);
        assert.equal(refused.status, 200, JSON.stringify(refused.body));
        assert.equal(refused.body.result.isError, true, intent);
        assert.equal(refused.result.status, 'rejected', intent);
        assert.equal(refused.result.error.code, 'integration_revoked_requires_explicit_restore', intent);
        assert.equal(refused.result.error.category, 'request_rule', intent);
        assert.match(refused.result.error.hint, /restored only by the Owner/, intent);
      }
      assert.equal((await evaluate(id)).integration_state, 'REVOKED');
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_revocations_v1 where integration_id = $1',
        [id])).rows[0].n), 0, 'nothing was materialized or cleared');
      assert.equal(Number((await admin.query(`select count(*) n from clued_private.integration_connections_v1
        where binding_id = $1`, [again.bindingId])).rows[0].n), 0, 'the new Binding is not linked');
    });

    await t.test('T-A11-4b (d) refresh rotation, expiry and expiry cleanup never call revoke_issuer', async () => {
      const { clientId, tokens, id } = await activeIntegration();
      const audit = await issuerAudit();
      rpcLog.length = 0;
      // rotation, twice: each refresh token is single-use and replaced
      let refresh = tokens.refresh_token;
      for (let n = 0; n < 2; n += 1) {
        const rotated = await run('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, resource }));
        assert.equal(rotated.status, 200, await rotated.clone().text());
        const next = await rotated.json();
        assert.notEqual(next.refresh_token, refresh);
        refresh = next.refresh_token;
        assert.equal((await mcp(next.access_token, 'clued_integration_status', { integration_id: id })).status, 200);
      }
      assert.equal((await evaluate(id)).integration_state, 'ACTIVE');

      // the Clued authorization expires: the provider refuses the token and the refresh, nothing is revoked
      await admin.query(`update clued_private.authorizations_v12 set expires_at = clock_timestamp() - interval '1 second'
        where binding_id = $1`, [tokens.bindingId]);
      const expiredCall = await mcp(tokens.access_token, 'clued_integration_status', { integration_id: id });
      assert.ok(expiredCall.status >= 400, String(expiredCall.status));
      const expiredRefresh = await run('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, resource }));
      assert.ok(expiredRefresh.status >= 400, String(expiredRefresh.status));
      const evaluation = await evaluate(id);
      assert.equal(evaluation.integration_state, 'REAUTH_REQUIRED');

      // the provider's own expiry cleanup: past the token and grant lifetimes Workers KV evicts the grant
      // and its tokens (the provider stores them with expiration / expirationTtl)
      const [userId, grantId] = tokens.access_token.split(':');
      const grantRows = async () => (await env.OAUTH_KV.list({ prefix: `grant:${userId}:${grantId}` })).keys.length
        + (await env.OAUTH_KV.list({ prefix: `token:${userId}:${grantId}:` })).keys.length;
      assert.ok(await grantRows() > 0, 'the grant and its tokens are stored before expiry');
      const deletes = env.OAUTH_KV.deletes.length;
      Date.now = () => previousNow() + 3 * 86_400_000;
      try {
        assert.equal(await grantRows(), 0, 'expired: evicted');
        assert.ok((await run('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, resource }))).status >= 400);
        assert.ok((await mcp(tokens.access_token, 'clued_integration_status', { integration_id: id })).status >= 400);
      } finally { Date.now = previousNow; }
      assert.deepEqual(env.OAUTH_KV.deletes.slice(deletes).filter((name) => name.includes(grantId)), [],
        'the cleanup is eviction, not a delete through the revocation hook');

      assert.equal(rpcLog.includes('clued_authorization_revoke_issuer_v12'), false, rpcLog.join());
      assert.equal(await issuerAudit(), audit, 'no revoke_issuer audit row');
      assert.equal((await evaluate(id)).integration_state, 'REAUTH_REQUIRED');
      assert.notEqual((await evaluate(id)).facts.revocation_source, 'CONNECTION_USER_REVOKE');
    });
  } finally {
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
