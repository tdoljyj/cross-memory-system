import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

// Credential table privileges for signed-in users (migration 20261008150000, P0-4 step 1, Clued Task
// 9a4d6d2c, Owner Decisions 1427642f and 096df8b8). A session may read its Bindings and sessions without
// token_hash and revoke a live Binding; it may not insert, delete, rewrite or un-revoke one. The Worker's
// two direct table calls (worker/continuity.ts listBindings, revokeBinding) keep working, SECURITY DEFINER
// paths are untouched, and the migration applies a second time through plpgsql EXECUTE without a change.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261008150000_credential_table_privileges_v1.sql';
const hex = () => crypto.randomBytes(32).toString('hex');
// The columns worker/continuity.ts listBindings selects.
const WORKER_LIST = 'id,vendor,agent_name,scopes,context_keys,created_at,last_used_at,revoked_at';


const PRIVILEGES = `select jsonb_build_object(
  'table', (select jsonb_object_agg(c.relname, (select coalesce(jsonb_agg(a.privilege_type order by a.privilege_type), '[]')
      from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 'authenticated'::regrole))
    from pg_class c where c.oid in ('public.clued_agent_bindings'::regclass, 'public.clued_continuity_sessions'::regclass)),
  'columns', (select jsonb_object_agg(c.relname || '.' || t.attname, (select coalesce(jsonb_agg(a.privilege_type order by a.privilege_type), '[]')
      from aclexplode(t.attacl) a where a.grantee = 'authenticated'::regrole))
    from pg_attribute t join pg_class c on c.oid = t.attrelid
    where c.oid in ('public.clued_agent_bindings'::regclass, 'public.clued_continuity_sessions'::regclass)
      and t.attnum > 0 and not t.attisdropped)) p`;

test('signed-in sessions read Bindings without token_hash and may only revoke them', { timeout: 600000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-credential-table-privileges-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hex(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
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
    const apply = async (names) => {
      for (const name of names) {
        try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      }
      await allowRawTestBindings(admin);
    };
    await apply(migrations.filter((name) => name < MIGRATION));
    // clued-prod (read 2026-10-08) holds more than the migrations grant: authenticated has SELECT,
    // INSERT, UPDATE and DELETE on clued_agent_bindings. Start from that.
    await admin.query('grant select, insert, update, delete on table public.clued_agent_bindings to authenticated');
    const before = (await admin.query(PRIVILEGES)).rows[0].p;
    assert.deepEqual(before.table.clued_agent_bindings, ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    assert.deepEqual(before.table.clued_continuity_sessions, ['SELECT']);
    await apply(migrations.filter((name) => name >= MIGRATION));

    const after = (await admin.query(PRIVILEGES)).rows[0].p;
    assert.deepEqual(after.table, { clued_agent_bindings: [], clued_continuity_sessions: [] });
    for (const [column, privileges] of Object.entries(after.columns)) {
      const [table, name] = column.split('.');
      const expected = name === 'token_hash' ? []
        : table === 'clued_agent_bindings' && name === 'revoked_at' ? ['SELECT', 'UPDATE'] : ['SELECT'];
      assert.deepEqual(privileges, expected, column);
    }

    // The release workflow runs a migration as one string through plpgsql EXECUTE; a second run is a no-op.
    await admin.query(`create or replace function pg_temp.apply_once(s text) returns void language plpgsql
      as $apply$ begin execute s; end $apply$`);
    await admin.query('select pg_temp.apply_once($1)',
      [await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8')]);
    assert.deepEqual((await admin.query(PRIVILEGES)).rows[0].p, after, 'a second run changes nothing');

    const userId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'owner@example.invalid',now()),($2,'other@example.invalid',now())`, [userId, otherId]);
    const insertBinding = async (owner) => (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'test','Test agent',$2,
      array['context:read'],array['*']) returning id`, [owner, hex()])).rows[0].id;
    const live = await insertBinding(userId);
    const second = await insertBinding(userId);
    const foreign = await insertBinding(otherId);

    const session = server.getPgClient();
    clients.push(session);
    await session.connect();
    await session.query('set role authenticated');
    await session.query(`select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })]);
    const denied = async (sql, params = []) => {
      await session.query('savepoint attempt');
      try {
        await session.query(sql, params);
        assert.fail(`expected a refusal: ${sql}`);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        assert.equal(error.code, '42501', `${sql}: ${error.message}`);
      } finally {
        await session.query('rollback to savepoint attempt');
      }
    };
    await session.query('begin');

    // listBindings: the Worker's column list, own rows only.
    const listed = (await session.query(`select ${WORKER_LIST} from public.clued_agent_bindings order by created_at`)).rows;
    assert.deepEqual(listed.map((row) => row.id).sort(), [live, second].sort());
    await denied('select token_hash from public.clued_agent_bindings');
    await denied('select * from public.clued_agent_bindings');
    await denied('select token_hash from public.clued_continuity_sessions');
    await session.query('select id, binding_id, context_key, expires_at from public.clued_continuity_sessions');

    // No Binding outside the issuance flow, no deletes, no rewriting.
    await denied(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'test','Self-made',$2,array['context:read','context:write','audit:read'],array['*'])`, [userId, hex()]);
    await denied('delete from public.clued_agent_bindings where id=$1', [second]);
    await denied('update public.clued_agent_bindings set token_hash=$2 where id=$1', [live, hex()]);
    await denied(`update public.clued_agent_bindings set scopes=array['context:write'] where id=$1`, [live]);
    await denied(`update public.clued_agent_bindings set context_keys=array['*'] where id=$1`, [live]);

    // revokeBinding: set revoked_at on a live Binding; nothing on another user's.
    const revoked = await session.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [live]);
    assert.equal(revoked.rowCount, 1);
    assert.equal((await session.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [foreign])).rowCount, 0);
    // No un-revoking and no moving revoked_at once set.
    await denied('update public.clued_agent_bindings set revoked_at=null where id=$1', [live]);
    await denied(`update public.clued_agent_bindings set revoked_at=now()+interval '1 day' where id=$1`, [live]);
    await session.query('commit');

    const state = (await admin.query('select id, revoked_at from public.clued_agent_bindings where id = any($1)', [[live, second, foreign]])).rows;
    assert.ok(state.find((row) => row.id === live).revoked_at, 'the revocation is kept');
    assert.equal(state.find((row) => row.id === second).revoked_at, null);
    assert.equal(state.find((row) => row.id === foreign).revoked_at, null);

    // Function-owner paths are unaffected: the owner role may still change any column.
    await admin.query(`update public.clued_agent_bindings set scopes=array['context:read','audit:read'], revoked_at=null where id=$1`, [live]);
    const resolved = (await admin.query(
      `select (clued_private.resolve_binding(clued_private.credential_internal_proof_v1(token_hash),'context:read','global')).id
         from public.clued_agent_bindings where id=$1`, [second])).rows[0].id;
    assert.equal(resolved, second, 'resolve_binding still authenticates (the column holds a verifier since 20261008210000)');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
