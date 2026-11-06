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

// Binding and Resource Center credentials stored as verifiers (migration 20261008210000, P0-4 step 2a, Clued Task
// 9a4d6d2c, Owner Decisions 1427642f and 2ec964af). The stored column holds 'cv1:'||sha256(prefix||proof); a caller
// still presents the proof; the stored value no longer works as a proof; written proofs are converted on the way
// in; internal proofs map back to a stored verifier only inside their transaction; no function compares a stored
// credential with a raw parameter or hands one on as a proof.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261008210000_credential_verifier_v1.sql';
const hex = () => crypto.randomBytes(32).toString('hex');
const verifier = (proof) => `cv1:${crypto.createHash('sha256').update(`clued.credential-verifier.v1:${proof}`).digest('hex')}`;

// The same expressions the migration's guard uses, plus the hand-on check that is easier to state in JavaScript.
const RAW_COMPARISON = /(?<![\w.])(?<!set )(?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash|authority_token_hash)\s*(?:=|<>|is distinct from|is not distinct from)\s*(?:p_\w+|h|reader_hash|writer_hash)(?!\w)/;
const QUALIFIED_CALL = /\b(?:public|clued_private)\.(\w+)\(([^()]*)\)/g;
const STORED_ARGUMENT = /^\s*\w+\.(?:token_hash|authority_token_hash)\s*$/;
// Issuer credentials are step 2b.
const ISSUER_FUNCTIONS = new Set(['clued_private.authorization_issuer_v12(text,text)']);

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('Binding and Resource Center credentials are stored as verifiers', { timeout: 900000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-credential-verifier-'));
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
    const apply = async (names) => {
      for (const name of names) {
        try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message} ${error.detail ?? ""}`, { cause: error }); }
      }
      await allowRawTestBindings(admin);
    };
    await apply(migrations.filter((name) => name < MIGRATION));

    // A Binding issued before the migration, stored the old way.
    const userId = crypto.randomUUID();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    const before = hex();
    const beforeId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'test','Before',$2,
      array['context:read'],array['*']) returning id`, [userId, before])).rows[0].id;

    // This test replays and rolls back the historical 2a migration at its own boundary. Successor issuer
    // identity functions are validated on the complete chain by issuer-credentials-db.test.mjs; reapplying
    // the older text-rewrite migration over a newer contract is not a supported rollback.
    await apply(migrations.filter((name) => name === MIGRATION));

    const stored = async (id) => (await admin.query('select token_hash from public.clued_agent_bindings where id=$1', [id])).rows[0].token_hash;
    assert.equal(await stored(beforeId), verifier(before), 'the existing row now holds the verifier');
    assert.equal((await admin.query(`select clued_private.credential_verifier_v1($1) v`, [before])).rows[0].v, verifier(before),
      'the database and this test compute the same verifier');
    const backup = (await admin.query(`select old_value, delete_after > now() + interval '6 days' as kept
      from clued_private.credential_proof_backup_v1 where table_name='clued_agent_bindings' and row_key=jsonb_build_object('id',$1::uuid)`, [beforeId])).rows;
    assert.deepEqual(backup, [{ old_value: before, kept: true }], 'the old value is kept for seven days');

    // The proof still authenticates; the stored value does not.
    const resolve = (proof) => admin.query(`select (clued_private.resolve_binding($1,'context:read','global')).id`, [proof]);
    assert.equal((await resolve(before)).rows[0].id, beforeId);
    await assert.rejects(resolve(await stored(beforeId)), (error) => error.code === '28000' || error.code === '42501');
    await assert.rejects(resolve(verifier(before).slice(4)), (error) => error.code === '28000' || error.code === '42501',
      'the bare verifier digest is not a proof either');

    // Writers keep writing proofs; the trigger stores verifiers and leaves verifiers alone.
    const after = hex();
    const afterId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'test','After',$2,
      array['context:read'],array['*']) returning id`, [userId, after])).rows[0].id;
    assert.equal(await stored(afterId), verifier(after));
    assert.equal((await resolve(after)).rows[0].id, afterId);
    await admin.query('update public.clued_agent_bindings set token_hash=token_hash, agent_name=$2 where id=$1', [afterId, 'Renamed']);
    assert.equal(await stored(afterId), verifier(after), 'rewriting the stored verifier keeps it');
    await assert.rejects(admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'test','Bad','not-a-hash',
      array['context:read'],array['*'])`, [userId]), (error) => error.code === '23514');

    // An internal proof maps to the stored verifier inside its transaction and nowhere else.
    await admin.query('begin');
    const internal = (await admin.query('select clued_private.credential_internal_proof_v1($1) p', [verifier(after)])).rows[0].p;
    assert.match(internal, /^[0-9a-f]{64}$/);
    assert.equal((await resolve(internal)).rows[0].id, afterId, 'an internal proof resolves inside its transaction');
    assert.equal((await admin.query('select clued_private.credential_internal_proof_v1($1) p', [verifier(after)])).rows[0].p, internal,
      'the same verifier reuses its internal proof');
    await admin.query('commit');
    await assert.rejects(resolve(internal), (error) => error.code === '28000' || error.code === '42501',
      'an internal proof is useless in another transaction');
    const nothing = (await admin.query('select clued_private.credential_internal_proof_v1($1) p', ['cv1:not-a-verifier'])).rows[0].p;
    assert.match(nothing, /^[0-9a-f]{64}$/);
    assert.equal((await admin.query('select clued_private.credential_verifier_v1($1) v', ['x'])).rows[0].v, 'cv0:');
    assert.equal((await admin.query('select clued_private.credential_verifier_v1(null) v')).rows[0].v, 'cv0:');

    // Every in-scope column only accepts verifiers.
    const checks = (await admin.query(`select conrelid::regclass::text t, pg_get_constraintdef(oid) d from pg_constraint
      where conname ~ '^(clued_agent_bindings|resource_center_\\w+)_(token_hash|old_\\w+_hash|authority_token_hash)_check$'
      order by 1, 2`)).rows;
    assert.equal(checks.length, 8);
    for (const check of checks) assert.match(check.d, /\^cv1:\[0-9a-f\]\{64\}\$/, check.t);

    // No function compares a stored credential with a raw parameter, or hands a stored one on as a proof.
    const functions = (await admin.query(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def
      from pg_proc p where p.pronamespace in ('public'::regnamespace,'clued_private'::regnamespace) and p.prokind='f'`)).rows;
    const raw = functions.filter((f) => !ISSUER_FUNCTIONS.has(f.sig) && RAW_COMPARISON.test(f.def)).map((f) => f.sig);
    assert.deepEqual(raw, [], 'compare with clued_private.credential_verifier_v1(<proof>)');
    const handedOn = [];
    for (const f of functions) {
      // clued_oauth_call replaces v_binding.token_hash with an internal proof once, before every tool call.
      const replaced = new Set([...f.def.matchAll(/(\w+\.token_hash):=clued_private\.credential_internal_proof_v1\(\1\)/g)].map((m) => m[1]));
      for (const call of f.def.matchAll(QUALIFIED_CALL)) {
        if (call[1].startsWith('credential_')) continue;
        if (call[2].split(',').some((argument) => STORED_ARGUMENT.test(argument) && !replaced.has(argument.trim()))) {
          handedOn.push(`${f.sig}: ${call[0]}`);
        }
      }
    }
    assert.deepEqual(handedOn, [], 'pass clued_private.credential_internal_proof_v1(<stored>) where a proof is expected');

    // A second run, as the release workflow runs a migration (one string through plpgsql EXECUTE), changes nothing.
    const snapshot = async () => (await admin.query(`select
      (select jsonb_agg(token_hash order by id) from public.clued_agent_bindings) b,
      (select jsonb_agg(md5(pg_get_functiondef(p.oid)) order by p.oid) from pg_proc p
        where p.pronamespace in ('public'::regnamespace,'clued_private'::regnamespace) and p.prokind='f') f`)).rows[0];
    const first = await snapshot();
    await admin.query(`create or replace function pg_temp.apply_once(s text) returns void language plpgsql
      as $apply$ begin execute s; end $apply$`);
    await admin.query('select pg_temp.apply_once($1)', [await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8')]);
    assert.deepEqual(await snapshot(), first, 'a second run changes nothing');

    // The rollback in docs/maintenance/database-security.md restores what the backup holds.
    const runbook = await fs.readFile(path.join(root, '../../docs/maintenance/database-security.md'), 'utf8');
    const rollback = runbook.split('## Credential verifiers, 2026-10-08')[1].split('```sql')[1].split('```')[0];
    await admin.query(rollback);
    assert.equal(await stored(beforeId), before, 'the old value is back');
    assert.equal((await resolve(before)).rows[0].id, beforeId, 'the old comparison is back');
    await assert.rejects(resolve(after), (error) => error.code === '28000' || error.code === '42501',
      'a Binding issued after the migration has only its verifier and must be reissued');
    assert.equal((await admin.query(`select count(*)::int n from pg_trigger where tgname='credential_verifier_normalize_v1'`)).rows[0].n, 0);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
