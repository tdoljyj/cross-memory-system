import { stopCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import net from 'node:net';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

// Independent boundary checks. Transport fixtures are not database authorization evidence.
const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-context-independent-'));
await build({ entryPoints: ['worker/continuity.ts'], outdir: directory, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { handleContinuityRequest: handle } = await import(pathToFileURL(path.join(directory, 'continuity.mjs')));
const env = { CLUED_DEVELOPMENT_CONTEXT_V14: 'true', SUPABASE_URL: 'https://independent.invalid', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' };
const make = (route, input) => new Request(`https://clued.example${route}`, { method: 'POST', headers: { authorization: 'Bearer clued_bnd_independent_fixture', 'content-type': 'application/json' }, body: JSON.stringify(input) });

for (const route of ['/v1/development', '/mcp']) {
  test(`independent exact development Record body survives ${route}`, async () => {
    const payload = { title: 'Accepted contract', user_id: 'domain-example', actor_binding_id: 'document-example', nested: [{ binding_id: 'literal-content' }] };
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ status: 'ok', records: [{ id: 'record-reference', body: payload, content_hash: 'approved-hash' }] });
    try {
      const input = { op: 'record_list', mode: 'development_history', context_id: 'context-reference' };
      const response = await handle(make(route, route === '/mcp' ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_context', arguments: input } } : input), env);
      assert.equal(response.status, 200);
      const returned = await response.json();
      const result = route === '/mcp' ? returned.result.structuredContent : returned;
      assert.deepEqual(result.records[0].body, payload, 'The transport must not alter domain content while retaining its hash.');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } finally { globalThis.fetch = original; }
  });
}

test('independent revoked MCP call never returns a successful old package', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: '42501', message: 'context_access_denied' }, { status: 403 });
  try {
    const response = await handle(make('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'clued_context', arguments: { op: 'record_list', mode: 'development_history' } } }), env);
    const body = await response.json();
    assert.ok(body.error || body.result?.isError === true);
    assert.equal(body.result?.structuredContent?.records, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { globalThis.fetch = original; }
});

test('independent real PostgreSQL negative access boundaries', { timeout: 120000 }, async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'clued-context-independent-pg-'));
  const server = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: crypto.randomUUID(), port, persistent: false, onLog() {}, onError() {} });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator nologin noinherit; create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions; create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrations = 'supabase/migrations';
    for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql') && (n < '20260826000000' || n === '20260907123955_clued_context_ownership_publication_v11.sql')).sort()) {
      await admin.query(await readFile(path.join(migrations, name), 'utf8'));
    }
    // Exercise production baseline plus a future optional Binding expiry column.
    await admin.query('alter table public.clued_agent_bindings add column if not exists expires_at timestamptz');
    const ownerId = crypto.randomUUID(), projectId = crypto.randomUUID();
    const bindingId = crypto.randomUUID(), tokenHash = crypto.randomBytes(32).toString('hex');
    await admin.query('insert into auth.users(id,email) values($1,$2)', [ownerId, 'independent@example.invalid']);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'Independent','independent',$3)`, [projectId, ownerId, `project:${projectId}`]);
    await admin.query(`insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,context_keys) values($1,$2,'fixture','restricted fixture',$3,array['*'])`, [bindingId, ownerId, tokenHash]);
    const owner = server.getPgClient(), anon = server.getPgClient(); clients.push(owner, anon);
    await owner.connect(); await anon.connect();
    await owner.query('set role authenticated'); await anon.query('set role anon');
    await owner.query(`select set_config('request.jwt.claim.sub',$1,false)`, [ownerId]);
    const own = async input => (await owner.query('select public.clued_context_owner($1) result', [{ idempotency_key: crypto.randomUUID(), ...input }])).rows[0].result;
    const cid = (await own({ op: 'context_create', name: 'INDEPENDENT-PRIVATE-NAME', project_id: projectId, environment: 'test' })).result.id;
    const grant = (await own({ op: 'grant_upsert', context_id: cid, binding_id: bindingId, actions: ['read'], history_policy: 'EXISTING_AND_FUTURE', version_policy: 'LATEST', expires_at: new Date(Date.now() + 3600000).toISOString() })).result;
    await own({ op: 'link_upsert', context_id: cid, project_id: projectId, grant_id: grant.id });
    const call = async input => (await anon.query('select public.clued_context_call($1,$2) result', [tokenHash, input])).rows[0].result;

    await t.test('owner project inventory excludes another account projects', async () => {
      const otherOwner = crypto.randomUUID(), otherProject = crypto.randomUUID();
      await admin.query('insert into auth.users(id,email) values($1,$2)', [otherOwner, 'another-independent@example.invalid']);
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'OTHER-PRIVATE-PROJECT','other-private-project',$3)`, [otherProject, otherOwner, `project:${otherProject}`]);
      const inventory = await own({ op: 'owner_list' });
      assert.deepEqual(inventory.projects.map(p => p.id), [projectId]);
      assert.equal(JSON.stringify(inventory).includes('OTHER-PRIVATE-PROJECT'), false);
      await assert.rejects(call({ op: 'owner_list' }), e => e.code === '42501');
    });
    await t.test('list respects explicit environment even with valid private Grant', async () => {
      const result = await call({ op: 'context_list', mode: 'development_history', environment: 'production' });
      assert.equal(result.contexts.length, 0);
    });
    await t.test('list does not enumerate a project outside Binding context_keys', async () => {
      await admin.query('update public.clued_agent_bindings set context_keys=$1 where id=$2', [[`project:${crypto.randomUUID()}`], bindingId]);
      const result = await call({ op: 'context_list', mode: 'development_history', environment: 'test' });
      assert.equal(result.contexts.length, 0);
      await admin.query(`update public.clued_agent_bindings set context_keys=array['*'] where id=$1`, [bindingId]);
    });
    await t.test('staged publication interruption preserves old head; tampering rejects; same delivery retries safely', async () => {
      await own({ op: 'grant_upsert', context_id: cid, binding_id: bindingId, grant_id: grant.id, base_version: grant.version,
        actions: ['read','write','accept','publish'], history_policy: 'EXISTING_AND_FUTURE', version_policy: 'LATEST', expires_at: new Date(Date.now() + 3600000).toISOString() });
      const mutation = async input => call({ context_id: cid, environment: 'test', mode: 'development_history', idempotency_key: crypto.randomUUID(), ...input });
      const makeStage = async (payload, expected_current) => {
        const record = (await mutation({ op: 'record_put', record_type: 'note', body: payload })).result;
        const acceptance = (await mutation({ op: 'accept', record_id: record.id, record_version: record.version, content_hash: record.content_hash, publication_payload: payload, audience: 'authenticated_owner', channel: 'canonical_api' })).result;
        return (await mutation({ op: 'publish', acceptance_id: acceptance.id, payload, audience: 'authenticated_owner', channel: 'canonical_api', expected_current })).result;
      };
      const first = await makeStage({ content: 'first independent publication' }, null);
      assert.equal(first.delivery_status, 'PENDING');
      await assert.rejects(call({ context_id: cid, environment: 'test', op: 'publication_read' }), e => e.code === '42501');
      await mutation({ op: 'publication_deliver', publication_id: first.id, base_version: first.version, expected_current: null });
      const payload = { content: 'second independent publication', user_id: 'legitimate-domain-field' };
      const next = await makeStage(payload, first.id);
      const readCurrent = async () => (await call({ context_id: cid, environment: 'test', op: 'publication_read' })).publication;
      assert.equal((await readCurrent()).id, first.id);
      const deliver = { op: 'publication_deliver', publication_id: next.id, base_version: next.version, expected_current: first.id, idempotency_key: crypto.randomUUID() };
      await admin.query(`update clued_private.context_publications_v11 set payload='{"content":"tampered"}'::jsonb where id=$1`, [next.id]);
      await assert.rejects(mutation(deliver), e => e.code === '42501');
      assert.equal((await readCurrent()).id, first.id);
      await admin.query('update clued_private.context_publications_v11 set payload=$1 where id=$2', [payload, next.id]);
      const delivered = await mutation(deliver);
      assert.equal(delivered.result.delivery_status, 'VERIFIED');
      assert.deepEqual((await readCurrent()).payload, payload);
      const replay = await mutation(deliver);
      assert.equal(replay.replayed, true);
      assert.equal(replay.operation_id, delivered.operation_id);
      assert.equal(Number((await admin.query('select count(*) from clued_private.context_receipts_v11 where id=$1', [delivered.receipt_id])).rows[0].count), 1);
    });
    await t.test('expired Binding rejects a still-live Grant and token', async () => {
      await admin.query(`update public.clued_agent_bindings set expires_at=now()-interval '1 second' where id=$1`, [bindingId]);
      await assert.rejects(call({ op: 'context_list', mode: 'development_history', environment: 'test' }), e => ['42501','28000'].includes(e.code));
    });
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
