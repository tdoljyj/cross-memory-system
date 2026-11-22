import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';
import EmbeddedPostgres from 'embedded-postgres';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';

// Real OAuth library -> application transport -> real migrated PostgreSQL.
// Identity and HTTP plumbing are local fixtures, not a live Supabase/ChatGPT login.
const U = '10000000-0000-4000-8000-000000000001';
const V = '10000000-0000-4000-8000-000000000002';
const P = '20000000-0000-4000-8000-000000000001';
const origin = 'https://clued.example', resource = origin + '/mcp';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
class MemoryKV {
  rows = new Map();
  async get(key, type) { const value = this.rows.get(key); return value === undefined ? null : type === 'json' || type?.type === 'json' ? JSON.parse(value) : value; }
  async put(key, value) { this.rows.set(key, value); }
  async delete(key) { this.rows.delete(key); }
  async list({ prefix = '' } = {}) { return { keys: [...this.rows.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true, cursor: '' }; }
}
test('OAuth consent, MCP record receipt, replay and revoke use the real database together', { timeout: 180000 }, async () => {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-authorization-e2e-'));
  await build({ entryPoints: ['worker/delegated-oauth.ts'], outdir: directory, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, plugins: [{ name: 'worker-runtime-only', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'worker-runtime', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class WorkerEntrypoint {}' }));
  } }] }); stop();
  const { handleDelegatedOAuth } = await import(pathToFileURL(path.join(directory, 'delegated-oauth.mjs')));
  const server = new EmbeddedPostgres({ databaseDir: path.join(directory, 'db'), user: 'postgres', password: crypto.randomBytes(32).toString('hex'), port, persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const originalFetch = globalThis.fetch; const connections = [];
  try {
    await server.initialise(); await server.start();
    const db = server.getPgClient(); connections.push(db); await db.connect();
    await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir('supabase/migrations')).filter(name => name.endsWith('.sql')).sort()) await db.query(await fs.readFile(path.join('supabase/migrations', name), 'utf8'));
    await db.query("insert into auth.users values($1,'fixture@example.invalid',now()),($2,'developer@example.invalid',now())", [U, V]);
    // Raw fixture creation follows the production early Owner writer protocol.
    await db.query('begin');
    try {
      await db.query('select clued_private.authorization_writer_guard_v2($1)', [U]);
      assert.equal((await db.query('select clued_private.authorization_writer_guard_held_v2($1) held', [U])).rows[0].held, true);
      await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'Integration project','integration project',$3)", [P, U, 'project:' + P]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    const issuer = crypto.randomBytes(32).toString('hex');
    await allowTestIssuerCredentials(db);
    await db.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Integration fixture')", [hash(issuer), resource]);
    const human = server.getPgClient(), gateway = server.getPgClient(), invited = server.getPgClient();
    for (const connection of [human, gateway, invited]) { connections.push(connection); await connection.connect(); }
    await human.query('set role authenticated'); await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [U, JSON.stringify({ sub: U })]);
    await invited.query('set role authenticated'); await invited.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [V, JSON.stringify({ sub: V })]);
    // The full migration set above supplies the actual C1 role and exact RPC grants.
    // Enter it through authenticator, as PostgREST does, without superuser privileges.
    await gateway.query('set session authorization authenticator; set role clued_worker_gateway');
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
    assert.deepEqual((await gateway.query('select session_user, current_user')).rows[0],
      { session_user: 'authenticator', current_user: 'clued_worker_gateway' });
    const context = (await human.query("select public.clued_development_owner_v14($1) value", [{ op: 'context_create', name: 'Integration development', project_id: P, environment: 'test', idempotency_key: crypto.randomUUID() }])).rows[0].value.result.id;
    const gatewayToken = 'synthetic-authorization-e2e-worker-gateway';
    const env = { CLUED_DB_GATEWAY_TOKEN: gatewayToken, OAUTH_KV: new MemoryKV(), CLUED_DELEGATED_OAUTH_V12: 'true', CLUED_OAUTH_ORIGIN: origin, CLUED_AUTHORIZATION_ISSUER_TOKEN: issuer, SUPABASE_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key', PROJECT_VIEWS_V2: 'true', CLUED_DEVELOPMENT_CONTEXT_V14: 'true' };
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url); assert.equal(parsed.origin, 'https://db.invalid');
      const headers = new Headers(options.headers); const isOwner = headers.get('Authorization') === 'Bearer fixture-human'; const isInvited = headers.get('Authorization') === 'Bearer fixture-developer'; const isHuman = isOwner || isInvited;
      if (parsed.pathname === '/auth/v1/user') return Response.json(isHuman ? { id: isOwner ? U : V, email: isOwner ? 'fixture@example.invalid' : 'developer@example.invalid' } : { error: 'unauthorized' }, { status: isHuman ? 200 : 401 });
      if (!isHuman && headers.get('Authorization') !== 'Bearer ' + gatewayToken) return Response.json({ code: 'PGRST301', message: 'invalid JWT' }, { status: 401 });
      const name = parsed.pathname.split('/').at(-1); assert.match(name, /^clued_[a-z0-9_]+$/);
      const values = JSON.parse(options.body || '{}'), keys = Object.keys(values); assert.ok(keys.every(key => /^p_[a-z0-9_]+$/.test(key)));
      try {
        const result = await (isOwner ? human : isInvited ? invited : gateway).query('select public.' + name + '(' + keys.map((key, index) => key + ' => $' + (index + 1)).join(',') + ') value', keys.map(key => typeof values[key] === 'object' && values[key] !== null ? JSON.stringify(values[key]) : values[key]));
        return Response.json(result.rows[0].value);
      } catch (error) { return Response.json({ message: error.message, code: error.code }, { status: error.code === '40001' ? 409 : error.code === '42501' || error.code === '28000' ? 403 : 400 }); }
    };
    const run = (route, options = {}) => handleDelegatedOAuth(new Request(origin + route, options), env, { waitUntil() {}, passThroughOnException() {}, props: {} }, async () => new Response('not found', { status: 404 }));
    const registered = await run('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Integration client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    assert.equal(registered.status, 201); const clientId = (await registered.json()).client_id;
    async function connect(actions, identityToken = 'fixture-human') {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://client.example/callback', response_type: 'code', scope: 'context:read context:write', state: 'integration', resource, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      const begun = await run('/oauth/authorize?' + query); assert.equal(begun.status, 302);
      const requestId = new URL(begun.headers.get('Location')).searchParams.get('request_id');
      const headers = { Authorization: 'Bearer ' + identityToken, Cookie: begun.headers.get('Set-Cookie').split(';')[0] };
      const detailsResponse = await run('/oauth/request?request_id=' + requestId, { headers }); assert.equal(detailsResponse.status, 200, await detailsResponse.clone().text());
      const details = await detailsResponse.json(); assert.ok(details.eligible.some(row => row.resource_id === context));
      const decision = await run('/oauth/decision?request_id=' + requestId, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', version: details.version, days: 1, selected: [{ resource_kind: 'context', resource_id: context, environment: 'test', actions }] }) });
      assert.equal(decision.status, 200, await decision.clone().text());
      const code = new URL((await decision.json()).redirect_url).searchParams.get('code');
      const response = await run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://client.example/callback', code_verifier: verifier, resource }) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    }
    const read = await connect(['read']), write = await connect(['write']);
    assert.equal(read.scope, 'context:read'); assert.equal(write.scope, 'context:write');
    assert.equal((await db.query('select count(*)::int n from clued_private.authorizations_v12')).rows[0].n, 2);
    const call = (token, input) => run('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_context', arguments: { context_id: context, mode: 'development_history', ...input } } }) });
    const input = { op: 'record_put', record_type: 'note', body: { content: 'Integration record' }, idempotency_key: crypto.randomUUID() };
    // The gateway's scope refusal is a tool error (PermissionSimplification §3.2); a
    // Development Context write is not a connection.permission resource, so no request is suggested.
    const refused = await call(read.access_token, input); assert.equal(refused.status, 200);
    const refusal = (await refused.json()).result; assert.equal(refusal.isError, true);
    assert.equal(refusal.structuredContent.error.code, 'insufficient_scope');
    assert.equal('suggested_request' in refusal.structuredContent.error, false);
    const written = await call(write.access_token, input); assert.equal(written.status, 200, await written.clone().text());
    const repeated = await call(write.access_token, input); assert.equal(repeated.status, 200, await repeated.clone().text());
    const operations = await db.query("select id,receipt_id,event_id from clued_private.development_operations_v14 where op='record_put' and idempotency_key=$1", [input.idempotency_key]);
    assert.equal(operations.rows.length, 1); assert.ok(operations.rows[0].receipt_id); assert.ok(operations.rows[0].event_id);
    assert.equal((await db.query('select count(*)::int n from clued_private.development_records_v14 where context_id=$1', [context])).rows[0].n, 1);
    assert.equal((await call(read.access_token, { op: 'record_list' })).status, 200);
    const revoke = await run('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: write.refresh_token, client_id: clientId }) });
    assert.equal(revoke.status, 200, await revoke.clone().text());
    assert.ok((await call(write.access_token, { ...input, idempotency_key: crypto.randomUUID() })).status >= 400);
    assert.equal((await call(read.access_token, { op: 'record_list' })).status, 200);
    const humanApi = async (identityToken, input) => {
      const response = await run('/oauth/projects/api', { method: 'POST', headers: { Authorization: 'Bearer ' + identityToken, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    const invitation = await humanApi('fixture-human', { op: 'invite_create', project_id: P, environment: 'test', target_email: 'developer@example.invalid', role: 'reader', actions: ['read'], expires_at: new Date(Date.now() + 3600000).toISOString(), idempotency_key: crypto.randomUUID() });
    const inspected = await humanApi('fixture-developer', { op: 'invite_inspect', invite_token: invitation.invite_token });
    assert.equal(inspected.project_id, P); assert.equal(inspected.environment, 'test');
    const membership = await humanApi('fixture-developer', { op: 'invite_accept', invite_token: invitation.invite_token, base_version: inspected.version, idempotency_key: crypto.randomUUID() });
    const developer = await connect(['read'], 'fixture-developer');
    assert.equal((await call(developer.access_token, { op: 'record_list' })).status, 200);
    const developerRefused = await call(developer.access_token, input); assert.equal(developerRefused.status, 200);
    assert.equal((await developerRefused.json()).result.structuredContent.error.code, 'insufficient_scope');
    const resumed = await run('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + developer.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'clued_session_resume', arguments: { context_key: 'global', client_session_id: 'integration-developer' } } }) });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const envelope = await resumed.json();
    const projection = envelope.result.structuredContent || JSON.parse(envelope.result.content[0].text);
    assert.equal(projection.status, 'scoped_context_ready'); assert.equal(projection.session_checkpoint_supported, false);
    assert.equal(projection.authorized_contexts.length, 1); assert.equal(projection.authorized_contexts[0].context_id, context);
    assert.equal(projection.snapshot, undefined); assert.equal(projection.session_token, undefined);
    await humanApi('fixture-human', { op: 'member_revoke', membership_id: membership.membership_id, base_version: membership.version, idempotency_key: crypto.randomUUID() });
    assert.ok((await call(developer.access_token, { op: 'record_list' })).status >= 400);
    assert.equal((await call(read.access_token, { op: 'record_list' })).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    for (const connection of connections) await connection.end();
    await stopCluster(server);
  }
});
