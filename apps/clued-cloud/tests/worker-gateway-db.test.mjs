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

// C1 phase 1, Task 9a4d6d2c, Decision 818a9b05: an additive transport role.
// The G6 role guard below is a disposable candidate fixture, never a migration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261009070002_worker_gateway_transition_v1.sql';
const role = 'clued_worker_gateway';
const hex = () => crypto.randomBytes(32).toString('hex');
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
const priorGrants = `select p.oid::regprocedure::text signature, p.proowner::regrole::text owner,
  p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) definition,
  has_function_privilege('anon',p.oid,'EXECUTE') anon,
  has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
  has_function_privilege('service_role',p.oid,'EXECUTE') service_role,
  has_function_privilege('clued_p5_gateway',p.oid,'EXECUTE') p5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'clued_%' order by signature`;

test('Worker gateway is additive, least privileged, and still requires a live Binding', { timeout: 600000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-worker-gateway-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hex(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  let failure;
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      grant anon,authenticated to authenticator;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort();
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8');
    const signatures = [...sql.matchAll(/'(public\.clued_[a-z0-9_]+\([^']*\))'/g)].map(m => m[1]);
    assert.ok(signatures.length > 70, 'all serving Worker branches are in scope');
    assert.equal(new Set(signatures).size, signatures.length);
    for (const name of migrations.filter(n => n < MIGRATION)) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const before = (await admin.query(priorGrants)).rows;
    await admin.query(sql);
    await allowRawTestBindings(admin);

    await t.test('prior callers, definer bodies and G6 compatibility are unchanged', async () => {
      assert.deepEqual((await admin.query(priorGrants)).rows, before);
      assert.equal((await admin.query(`select has_function_privilege('anon',
        'public.clued_mcp_currentness_g6_gate(text,jsonb)','EXECUTE') allowed`)).rows[0].allowed, true);
      // The production workflow wraps each file in plpgsql EXECUTE; replay must preserve grants too.
      await admin.query(`create function pg_temp.apply_gateway(s text) returns void language plpgsql
        as $apply$ begin execute s; end $apply$`);
      await admin.query('select pg_temp.apply_gateway($1)', [sql]);
      assert.deepEqual((await admin.query(priorGrants)).rows, before);
    });

    await t.test('the role has only the exact Worker overload grants, not native or P5 grants', async () => {
      const attributes = (await admin.query(`select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,
        rolreplication,rolbypassrls,rolconfig from pg_roles where rolname=$1`, [role])).rows[0];
      assert.deepEqual(attributes, { rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false,
        rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolconfig: ['statement_timeout=3s'] });
      assert.equal((await admin.query(`select pg_has_role('authenticator',$1,'MEMBER') member`, [role])).rows[0].member, true);
      assert.equal((await admin.query(`select count(*)::integer n from pg_auth_members where member=$1::regrole`, [role])).rows[0].n, 0);
      const granted = (await admin.query(`select p.oid::regprocedure::text signature from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        join lateral aclexplode(p.proacl) a on a.grantee=$1::regrole and a.privilege_type='EXECUTE'
        where n.nspname='public' order by signature`, [role])).rows.map(r => 'public.' + r.signature);
      assert.deepEqual(granted, signatures);
      assert.equal((await admin.query(`select has_schema_privilege($1,'clued_private','USAGE') allowed`, [role])).rows[0].allowed, false);
      assert.equal((await admin.query(`select has_table_privilege($1,'public.clued_agent_bindings','SELECT') allowed`, [role])).rows[0].allowed, false);
      for (const signature of ['public.clued_authorization_prepare_v12(text,jsonb)', 'public.clued_p5_session_open(text,jsonb)']) {
        const exists = (await admin.query('select to_regprocedure($1) value', [signature])).rows[0].value;
        assert.ok(exists, signature);
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed, false, signature);
      }
    });

    await t.test('replay refuses an existing role with unexpected privileges instead of silently cleaning it', async () => {
      const rejected = error => error.code === '42501' && error.message === 'worker_gateway_role_unexpected_privileges';
      const cases = [
        [`grant select on public.clued_agent_bindings to ${role}`, `revoke select on public.clued_agent_bindings from ${role}`],
        [`grant maintain on public.clued_agent_bindings to ${role}`, `revoke maintain on public.clued_agent_bindings from ${role}`],
        [`grant select(token_hash) on public.clued_agent_bindings to ${role}`, `revoke select(token_hash) on public.clued_agent_bindings from ${role}`],
        [`grant usage on schema clued_private to ${role}`, `revoke usage on schema clued_private from ${role}`],
        [`grant execute on function public.clued_authorization_prepare_v12(text,jsonb) to ${role}`, `revoke execute on function public.clued_authorization_prepare_v12(text,jsonb) from ${role}`],
        [`grant execute on function public.clued_authorization_status_v12(text) to ${role} with grant option`, `revoke grant option for execute on function public.clued_authorization_status_v12(text) from ${role}`],
        [`create role unexpected_gateway_holder nologin; grant ${role} to unexpected_gateway_holder`, `revoke ${role} from unexpected_gateway_holder; drop role unexpected_gateway_holder`],
        [`grant ${role} to authenticator with admin option`, `revoke admin option for ${role} from authenticator`],
        [`grant authenticated to ${role}`, `revoke authenticated from ${role}`],
        [`alter role ${role} bypassrls`, `alter role ${role} nobypassrls`],
        [`create sequence public.test_worker_gateway_sequence; grant usage on sequence public.test_worker_gateway_sequence to ${role}`, `drop sequence public.test_worker_gateway_sequence`],
        [`create table public.test_worker_gateway_owned(id integer); alter table public.test_worker_gateway_owned owner to ${role}`, `drop table public.test_worker_gateway_owned`],
      ];
      for (const [widen, repair] of cases) {
        await admin.query(widen);
        try { await assert.rejects(admin.query('select pg_temp.apply_gateway($1)', [sql]), rejected, widen); }
        finally { await admin.query(repair); }
      }
      await admin.query('select pg_temp.apply_gateway($1)', [sql]);
    });

    await t.test('the reviewed grant list covers live source call sites and no Native-only RPC', async () => {
      const workerFiles = (await fs.readdir(path.join(root, 'worker'))).filter(n => /\.(ts|mjs)$/.test(n));
      const sources = (await Promise.all(workerFiles.map(n => fs.readFile(path.join(root, 'worker', n), 'utf8')))).join('\n');
      const mentioned = new Set(sources.match(/\bclued_[a-z0-9_]+\b/g));
      // These names are Native calls or public tool names whose dispatch uses a successor RPC.
      const excluded = new Set(['clued_authorization_approve_v12','clued_authorization_deny_v12','clued_authorization_prepare_v12',
        'clued_canonical_export','clued_project_list','clued_project_mutate','clued_storage_directory_probe_v1',
        'clued_storage_native_recovery_v1','clued_storage_oauth_v1','clued_storage_policy_transition_v2']);
      const expected = (await admin.query(`select p.proname,p.oid::regprocedure::text signature
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
        and p.proargnames && array['p_token_hash','p_issuer_hash']::text[] order by signature`)).rows
        .filter(r => mentioned.has(r.proname) && !excluded.has(r.proname) && !r.proname.startsWith('clued_p5_'))
        .map(r => 'public.' + r.signature);
      assert.deepEqual(signatures, expected);
    });

    const user = crypto.randomUUID(), proof = hex();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'gateway@example.invalid',now())`, [user]);
    const binding = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'test','Worker gateway test',$2,array['context:read'],array['*']) returning id`, [user, proof])).rows[0].id;
    const caller = server.getPgClient(); clients.push(caller); await caller.connect();
    await caller.query('set session authorization authenticator');
    const asRole = async name => {
      await caller.query(`set role ${name}`);
      await caller.query(`select set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ role: name })]);
    };
    const active = value => caller.query(`select public.clued_work_claims_active_v1($1,'{"scope":{"level":"global"}}') value`, [value]);
    await t.test('Worker and transitional anon require the Binding proof; revocation still denies', async () => {
      for (const name of [role, 'anon']) {
        await asRole(name);
        assert.equal((await active(proof)).rows[0].value.status, 'ok');
        await assert.rejects(active(hex()), error => error.code === '42501' && error.message === 'binding_not_authorized');
        const verifier = (await admin.query('select token_hash from public.clued_agent_bindings where id=$1', [binding])).rows[0].token_hash;
        await assert.rejects(active(verifier), error => error.code === '28000' && error.message === 'invalid_binding_or_context');
      }
      await asRole(role);
      await assert.rejects(caller.query('select * from public.clued_agent_bindings'), error => error.code === '42501');
      await assert.rejects(caller.query('select * from clued_private.raw_binding_grants_v1'), error => error.code === '42501');
      await assert.rejects(caller.query('set role postgres'), error => error.code === '42501');
      await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [binding]);
      await assert.rejects(active(proof), error => error.code === '42501' && error.message === 'binding_not_authorized');
    });

    await t.test('a test-only G6 candidate distinguishes the request role from the definer owner', async () => {
      await admin.query(`create function public.test_worker_gateway_role_probe() returns jsonb
        language plpgsql security definer set search_path='' as $probe$
        begin
          if current_setting('role',true) is distinct from 'clued_worker_gateway'
            or (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')
              is distinct from 'clued_worker_gateway' then
            raise exception 'worker_gateway_required' using errcode='42501';
          end if;
          return jsonb_build_object('owner',current_user,'request_role',current_setting('role',true),'login',session_user);
        end $probe$;
        revoke all on function public.test_worker_gateway_role_probe() from public;
        grant execute on function public.test_worker_gateway_role_probe() to clued_worker_gateway,anon,authenticated,clued_p5_gateway;`);
      await asRole(role);
      assert.deepEqual((await caller.query('select public.test_worker_gateway_role_probe() value')).rows[0].value,
        { owner: 'postgres', request_role: role, login: 'authenticator' });
      for (const name of ['anon', 'authenticated', 'clued_p5_gateway']) {
        await asRole(name);
        // A forged claim cannot substitute for the database's SET ROLE.
        await caller.query(`select set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ role })]);
        await assert.rejects(caller.query('select public.test_worker_gateway_role_probe()'),
          error => error.code === '42501' && error.message === 'worker_gateway_required');
      }
      await asRole(role);
      for (const claims of ['', '{}', '{"role":"anon"}']) {
        await caller.query(`select set_config('request.jwt.claims',$1,false)`, [claims]);
        await assert.rejects(caller.query('select public.test_worker_gateway_role_probe()'), error => error.code === '42501');
      }
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    try { await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { if (!failure) throw error; process.stderr.write(`Gateway fixture cleanup: ${error.code}\n`); }
  }
});
