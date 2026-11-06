import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The sealed G6 closeout qualifies its original sources, before these two
// authorized successors. Keep its real replay and separately prove the current
// catalog rather than asking the historical seal to accept a changed body.
async function applyQualifiedMigrations(admin, names) {
  const targets = ['public.clued_project_mutate(text,jsonb)',
    'public.clued_development_owner_v14(jsonb)', 'public.clued_authorization_manage_v12(jsonb)'];
  const catalog = async () => (await admin.query(`select p.oid, p.oid::regprocedure::text signature,
    pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl
    from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid`, [targets])).rows;
  let originalTargets;
  const successors = new Map([
    ['20261014044323_all_contexts_authorization_v2.sql', 'b78cb49134f2788c3f1fbc7438c4647a8e89cdcedf3519d540305d1105b845b8'],
    ['20261014045157_all_contexts_serialization_v2.sql', 'ce8ee42d89240a338cbd229846c397f9626f1445e2dfa832b60c19fecb994e58'],
  ]);
  for (const name of names) {
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      await assertGatewayCloseoutBoundary(admin);
      const closedCatalog = await snapshotCallerCatalog(admin);
      await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', CLOSEOUT_MIGRATION), 'utf8'));
      await assertGatewayCloseoutBoundary(admin);
      assert.deepEqual(await snapshotCallerCatalog(admin), closedCatalog,
        'actual sealed G6 replay preserves original definitions and ACL at its bounded stage');
      originalTargets = await catalog();
      assert.equal(originalTargets.length, targets.length);
    }
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    if (successors.has(name)) assert.equal(crypto.createHash('sha256').update(sql).digest('hex'), successors.get(name));
    try { await admin.query(sql); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, false);
    }
  }
  assert.ok(originalTargets, 'both successors run only after the bounded closeout proof');
  assert.deepEqual(await catalog(), originalTargets, 'successors preserve existing OIDs, owners, security metadata and ACL');
  await assertGatewayCloseoutBoundary(admin);
  assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  assert.equal((await admin.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid='public.clued_project_mutate(text,jsonb)'::regprocedure")).rows[0].source_hash,
    '64503257b828c3dcf1405fc378a9d297faf559cec29a373e77e5013e2eb76262', 'retired alias keeps its sealed business body');
  for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
    assert.equal((await admin.query("select has_function_privilege($1,'public.clued_project_mutate(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed,
      false, role + ' cannot execute the retired alias');
  }
  for (const signature of ['clued_private.authorization_writer_guard_v2(uuid)',
    'clued_private.authorization_writer_require_v2(uuid)', 'clued_private.authorization_sources_view_v2(uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
      assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed,
        false, `${role} cannot directly call private successor helper ${signature}`);
    }
  }
}

const key = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const future = () => new Date(Date.now() + 3600000).toISOString();
const selectedContext = (id, actions) => ({ resource_kind: 'context', resource_id: id, environment: 'test', actions });

async function guardedProjectInsert(admin, owner, sql, values) {
  await admin.query('begin');
  try {
    await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
    assert.equal((await admin.query('select clued_private.authorization_writer_guard_held_v2($1) held', [owner])).rows[0].held,
      true, 'raw fixture setup holds the real granted Owner advisory transaction lock before INSERT');
    const result = await admin.query(sql, values);
    await admin.query('commit');
    return result;
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// Reuse the existing isolated PostgreSQL fixture shape, not an authorization mock.
// No remote URL, Supabase credentials, environment lookup or production connection.
test('Authorization closeout: new resources and interrupted multi-step work', { timeout: 180000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-auth-closeout-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [], user = key(), issuer = hash(), resource = 'https://closeout.example.invalid/mcp';
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql') && !name.includes('p5_')).sort();
    await applyQualifiedMigrations(admin, migrations);
    await allowTestIssuerCredentials(admin);
    await admin.query('insert into auth.users values($1,$2)', [user, 'closeout@example.invalid']);
    await admin.query('insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,$3)', [issuer, resource, 'Local closeout']);
    async function client(role, subject = null) {
      const db = server.getPgClient(); clients.push(db); await db.connect(); await db.query('set role ' + role);
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [subject ?? '', JSON.stringify({ sub: subject })]);
      return db;
    }
    const owner = await client('authenticated', user);
    // The full migration set supplies C1's gateway role and RPC grants. Binding
    // calls use its real authenticator path; consent and revoke stay human APIs.
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect();
    await gateway.query('set session authorization authenticator; set role clued_worker_gateway');
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
    assert.deepEqual((await gateway.query('select session_user, current_user')).rows[0],
      { session_user: 'authenticator', current_user: 'clued_worker_gateway' });
    const rpc = async (db, name, args) => (await db.query('select public.' + name + '(' + args.map((_, index) => '$' + (index + 1)).join(',') + ') value', args.map(value => Array.isArray(value) ? JSON.stringify(value) : value))).rows[0].value;
    const denied = promise => assert.rejects(promise, error => ['42501', '28000'].includes(error.code));
    const prepare = () => rpc(owner, 'clued_authorization_prepare_v12', [issuer, { request_digest: hash(), client_id: 'same-closeout-client', client_name: 'Local closeout', redirect_uri: 'https://client.example.invalid/callback', resource, requested_scopes: ['context:read', 'context:write'] }]);
    async function connect(selection) {
      const request = await prepare(), tokenHash = hash();
      const result = await rpc(owner, 'clued_authorization_approve_v12', [issuer, request.request_id, request.version, selection, tokenHash, future()]);
      return { ...result, tokenHash };
    }
    async function project(name) {
      const id = key();
      await guardedProjectInsert(admin, user, 'insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,$3,$4,$5)', [id, user, name, name.toLowerCase(), 'project:' + id]);
      const context = await rpc(owner, 'clued_development_owner_v14', [{ op: 'context_create', idempotency_key: key(), name: name + ' development', project_id: id, environment: 'test' }]);
      return { id, context: context.result.id };
    }
    const call = (binding, context, input) => rpc(gateway, 'clued_development_call_v14', [binding.tokenHash, { context_id: context, ...input }]);
    const entries = binding => admin.query('select resource_kind,resource_id,environment,actions from clued_private.authorization_entries_v12 where binding_id=$1 order by resource_kind,resource_id,environment', [binding.binding_id]).then(result => result.rows);
    const firstProject = await project('Project A');

    await t.test('A11: a project created after consent requires a new grant and cannot expand the old binding', async () => {
      const old = await connect([selectedContext(firstProject.context, ['read'])]);
      const before = await entries(old);
      const added = await project('Project B');
      const offered = await prepare();
      assert.ok(offered.eligible.some(row => row.resource_id === added.context));
      await denied(call(old, added.context, { op: 'record_list', mode: 'development_history' }));
      await denied(call(old, added.context, { op: 'record_put', record_type: 'note', body: { content: 'Must not be written' }, idempotency_key: key() }));
      assert.deepEqual((await call(old, firstProject.context, { op: 'context_list', mode: 'development_history' })).contexts.map(row => row.id), [firstProject.context]);
      const renewed = await connect([selectedContext(added.context, ['read'])]);
      assert.notEqual(renewed.binding_id, old.binding_id);
      assert.deepEqual((await call(renewed, added.context, { op: 'record_list', mode: 'development_history' })).records, []);
      await denied(call(old, added.context, { op: 'record_list', mode: 'development_history' }));
      await denied(call(renewed, firstProject.context, { op: 'record_list', mode: 'development_history' }));
      assert.deepEqual(await entries(old), before);
      assert.equal((await admin.query('select count(*)::int n from clued_private.development_records_v14 where context_id=$1', [added.context])).rows[0].n, 0);
    });

    await t.test('A15: revoking between steps rejects the next write and preserves the first record event and receipt', async () => {
      const binding = await connect([selectedContext(firstProject.context, ['read', 'write'])]);
      const firstKey = key(), nextKey = key();
      const first = await call(binding, firstProject.context, { op: 'record_put', record_type: 'note', body: { content: 'Committed first step' }, idempotency_key: firstKey });
      assert.equal(first.status, 'committed');
      assert.ok(first.result.id && first.operation_id && first.event_id && first.receipt_id);
      const snapshot = async () => ({
        record: (await admin.query('select to_jsonb(r) value from clued_private.development_records_v14 r where id=$1', [first.result.id])).rows[0].value,
        operation: (await admin.query('select to_jsonb(o) value from clued_private.development_operations_v14 o where id=$1', [first.operation_id])).rows[0].value,
      });
      const before = await snapshot();
      assert.equal(before.operation.event_id, first.event_id); assert.equal(before.operation.receipt_id, first.receipt_id);
      const revoked = await rpc(owner, 'clued_authorization_manage_v12', [{ op: 'revoke', binding_id: binding.binding_id, base_version: binding.version }]);
      assert.equal(revoked.version, binding.version + 1);
      await denied(call(binding, firstProject.context, { op: 'record_put', record_type: 'note', body: { content: 'Forbidden second step' }, idempotency_key: nextKey }));
      assert.deepEqual(await snapshot(), before);
      const counts = (await admin.query('select count(*) filter(where idempotency_key=$2)::int first_count,count(*) filter(where idempotency_key=$3)::int next_count from clued_private.development_operations_v14 where binding_ref=$1', [binding.binding_id, firstKey, nextKey])).rows[0];
      assert.deepEqual(counts, { first_count: 1, next_count: 0 });
      assert.equal((await admin.query("select count(*)::int n from clued_private.development_records_v14 where context_id=$1 and body->>'content'='Forbidden second step'", [firstProject.context])).rows[0].n, 0);
    });
  } finally {
    for (const db of clients.reverse()) await db.end().catch(() => {});
    await stopCluster(server);
    const target = path.resolve(dir);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('clued-auth-closeout-')) throw new Error('Unsafe test cleanup');
    await removeTestDirectory(target);
  }
});
