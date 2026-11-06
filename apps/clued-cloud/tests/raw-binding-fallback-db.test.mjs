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
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

// Migration 20261009050000 closes "a Binding without a v12 authorization is let through" (P0-4 step 7b; Clued Task
// 9a4d6d2c, Owner Decisions 29bff239 and d0458559). Such a Binding is refused unless
// clued_private.raw_binding_grants_v1 names it; the migration names only the Projection Builder, for read on
// global; nobody but the database owner can write that table; a second run changes nothing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261009050000_close_v12_raw_binding_fallback_v1.sql';
const BUILDER = '05effaa9-966d-43ad-904b-1f3426394410';
const hex = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('a Binding without a v12 authorization needs an explicit raw grant', { timeout: 900000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-raw-binding-fallback-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hex(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(MIGRATION));
    const sql = async (name) => fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    const apply = async (names) => {
      for (const name of names) {
        try { await admin.query(await sql(name)); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message} ${error.detail ?? ''}`, { cause: error }); }
      }
    };
    await apply(migrations.filter((name) => name < MIGRATION));

    const userId = crypto.randomUUID();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    // raw-binding-grants: this test checks the refusal itself and calls the fixture only at the end.
    const insert = async (id, name, keys) => {
      const proof = hex();
      const row = (await admin.query(`insert into public.clued_agent_bindings
        (id,user_id,vendor,agent_name,token_hash,scopes,context_keys) values(coalesce($1,gen_random_uuid()),$2,'system',$3,$4,
        array['context:read','context:write'],$5) returning id`, [id, userId, name, proof, keys])).rows[0];
      return { id: row.id, proof };
    };
    const builder = await insert(BUILDER, 'Projection Builder: two approved Global views', ['*']);
    const before = await insert(null, 'Raw before', ['*']);
    const resolve = (proof, scope, context) =>
      admin.query('select (clued_private.resolve_binding($1,$2,$3)).id', [proof, scope, context]);
    assert.equal((await resolve(before.proof, 'context:write', 'global')).rows[0].id, before.id,
      'before the migration a raw Binding is let through');

    await apply(migrations.filter((name) => name >= MIGRATION));

    const refused = (error) => error.code === '42501' && error.message === 'resource_action_not_authorized';
    await assert.rejects(resolve(before.proof, 'context:read', 'global'), refused, 'an existing raw Binding is refused');
    const after = await insert(null, 'Raw after', ['*']);
    await assert.rejects(resolve(after.proof, 'context:read', 'global'), refused, 'a new raw Binding is refused');

    assert.equal((await resolve(builder.proof, 'context:read', 'global')).rows[0].id, BUILDER,
      'the Projection Builder still reads global');
    await assert.rejects(resolve(builder.proof, 'context:write', 'global'), refused, 'but cannot write');
    await assert.rejects(resolve(builder.proof, 'context:read', 'profile'), refused, 'or read another scope');
    assert.deepEqual((await admin.query(`select binding_id, context_key, actions from clued_private.raw_binding_grants_v1`)).rows,
      [{ binding_id: BUILDER, context_key: 'global', actions: ['read'] }], 'the migration grants only the Builder');

    const privileges = (await admin.query(`select r.rolname, has_table_privilege(r.rolname,'clued_private.raw_binding_grants_v1',
      'select,insert,update,delete') any_privilege from pg_roles r where r.rolname in ('anon','authenticated','service_role')
      order by 1`)).rows;
    assert.deepEqual(privileges.map((row) => row.any_privilege), [false, false, false], 'only the owner touches the grants');

    // A second run, as the release workflow runs a migration (one string through plpgsql EXECUTE), changes nothing.
    const snapshot = async () => (await admin.query(`select
      (select jsonb_agg(to_jsonb(g) - 'created_at' order by binding_id) from clued_private.raw_binding_grants_v1 g) g,
      md5(pg_get_functiondef('clued_private.authorization_assert_entry_v12(uuid,text,text,text,text)'::regprocedure)) f`)).rows[0];
    const first = await snapshot();
    await admin.query(`create or replace function pg_temp.apply_once(s text) returns void language plpgsql
      as $apply$ begin execute s; end $apply$`);
    await admin.query('select pg_temp.apply_once($1)', [await sql(MIGRATION)]);
    assert.deepEqual(await snapshot(), first, 'a second run changes nothing');

    // The rollback in docs/maintenance/database-security.md brings the old fallback back; the migration closes it again.
    const runbook = await fs.readFile(path.join(root, '../../docs/maintenance/database-security.md'), 'utf8');
    const rollback = runbook.split('## Raw Binding grants, 2026-10-09')[1].split('```sql')[2].split('```')[0];
    await admin.query(rollback);
    assert.equal((await resolve(after.proof, 'context:write', 'global')).rows[0].id, after.id, 'the rollback lets raw Bindings through');
    await admin.query('select pg_temp.apply_once($1)', [await sql(MIGRATION)]);
    await assert.rejects(resolve(after.proof, 'context:read', 'global'), refused, 'reapplying closes it again');

    // The test fixture restores the old behaviour for test databases only.
    await allowRawTestBindings(admin);
    assert.equal((await resolve(before.proof, 'context:write', 'global')).rows[0].id, before.id);
    const fixtureBinding = await insert(null, 'Raw with fixture', ['global']);
    assert.equal((await resolve(fixtureBinding.proof, 'context:read', 'global')).rows[0].id, fixtureBinding.id);
    await assert.rejects(resolve(fixtureBinding.proof, 'context:read', 'profile'), (error) => error.code === '42501',
      'resolve_binding still checks the row\'s own context keys');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
