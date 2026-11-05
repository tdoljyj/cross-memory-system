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

// raw-binding-grants: every resolve here runs before migration 20261009050000 is applied.

// Migration 20261009040000 revokes the two 2026-08-29 OAuth audit Bindings that had no v12 authorization
// (P0-4 step 7, first PR; Clued Task 9a4d6d2c, Owner Decision 29bff239). It touches only those two rows while
// they still look as checked, records each revocation, and changes nothing on a second run.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261009040000_revoke_legacy_audit_bindings_v1.sql';
const AUDIT = 'c0cc5abf-68f5-4a97-9a14-ab9379c854c0';
const AUDIT_6400 = 'b3603c56-0649-47ca-91e3-d1e8e06588c4';
const hex = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('the two legacy OAuth audit Bindings are revoked and nothing else', { timeout: 900000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-legacy-audit-revoke-'));
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
    for (const name of migrations.filter((name) => name < MIGRATION)) {
      try { await admin.query(await sql(name)); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message} ${error.detail ?? ''}`, { cause: error }); }
    }

    const userId = crypto.randomUUID();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    const proofs = { audit: hex(), audit6400: hex(), other: hex() };
    const insert = (id, name, proof, revokedAt = null) => admin.query(`insert into public.clued_agent_bindings
      (id,user_id,vendor,agent_name,token_hash,scopes,context_keys,revoked_at) values($1,$2,'OAuth',$3,$4,
      array['context:read'],array['system:projects'],$5) returning id`, [id, userId, name, proof, revokedAt]);
    await insert(AUDIT, 'Clued A03 read-only audit', proofs.audit);
    // Already revoked: keeps its own revocation time and gets no audit row.
    const earlier = new Date('2026-09-01T00:00:00Z');
    await insert(AUDIT_6400, 'Clued A03 read-only audit (port 6400)', proofs.audit6400, earlier);
    // Same shape, different id: not touched.
    const otherId = (await insert(crypto.randomUUID(), 'Clued A03 read-only audit', proofs.other)).rows[0].id;
    const resolve = (proof) => admin.query(`select (clued_private.resolve_binding($1,'context:read','system:projects')).id`, [proof]);
    assert.equal((await resolve(proofs.audit)).rows[0].id, AUDIT, 'the audit Binding works before the migration');

    await admin.query(await sql(MIGRATION));

    const rows = async () => (await admin.query(`select id, revoked_at from public.clued_agent_bindings
      where id = any($1::uuid[]) order by id`, [[AUDIT, AUDIT_6400, otherId]])).rows;
    const state = Object.fromEntries((await rows()).map((row) => [row.id, row.revoked_at]));
    assert.ok(state[AUDIT] instanceof Date, 'the live audit Binding is revoked');
    assert.equal(state[AUDIT_6400].toISOString(), earlier.toISOString(), 'an earlier revocation is kept');
    assert.equal(state[otherId], null, 'a Binding with another id stays live');
    await assert.rejects(resolve(proofs.audit), (error) => error.code === '42501');
    assert.equal((await resolve(proofs.other)).rows[0].id, otherId);

    const audit = (await admin.query(`select owner_id, binding_id, operation, selected->>'decision' decision
      from clued_private.authorization_audit_v12 where operation = 'legacy_binding_revoke'`)).rows;
    assert.deepEqual(audit, [{ owner_id: userId, binding_id: AUDIT, operation: 'legacy_binding_revoke',
      decision: '29bff239-5bc1-4e4b-9429-b2f81eb0228c' }]);

    // A second run, as the release workflow runs a migration (one string through plpgsql EXECUTE), changes nothing.
    const before = await rows();
    await admin.query(`create or replace function pg_temp.apply_once(s text) returns void language plpgsql
      as $apply$ begin execute s; end $apply$`);
    await admin.query('select pg_temp.apply_once($1)', [await sql(MIGRATION)]);
    assert.deepEqual(await rows(), before);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.authorization_audit_v12
      where operation = 'legacy_binding_revoke'`)).rows[0].n, 1);

    for (const name of migrations.filter((name) => name > MIGRATION)) await admin.query(await sql(name));
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
