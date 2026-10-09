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
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'supabase_admin', password: hex(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  let failure;
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role postgres nologin superuser createrole inherit;
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      grant anon,authenticated to authenticator;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      alter database postgres owner to postgres;
      alter schema auth owner to postgres; alter schema extensions owner to postgres;
      alter table auth.users owner to postgres;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrator = server.getPgClient(); clients.push(migrator); await migrator.connect();
    await migrator.query('set session authorization postgres');
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort();
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8');
    const signatures = [...sql.matchAll(/'(public\.clued_[a-z0-9_]+\([^']*\))'/g)].map(m => m[1]);
    assert.ok(signatures.length > 70, 'all serving Worker branches are in scope');
    assert.equal(new Set(signatures).size, signatures.length);
    for (const name of migrations.filter(n => n < MIGRATION)) {
      try { await migrator.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const before = (await admin.query(priorGrants)).rows;
    // Supabase's migration role is CREATEROLE but not a superuser. Historical
    // migrations use the old fixture setup; create and replay this candidate with
    // the real role attributes so PostgreSQL itself emits the management edge.
    await admin.query('alter role postgres nosuperuser');
    assert.deepEqual((await migrator.query(`select current_user,session_user,rolsuper,rolcreaterole,rolinherit
      from pg_roles where rolname=current_user`)).rows[0],
      { current_user: 'postgres', session_user: 'postgres', rolsuper: false, rolcreaterole: true, rolinherit: true });
    await migrator.query(sql);
    await allowRawTestBindings(admin);

    await t.test('a non-superuser migration creator gets only the bootstrap administrative edge', async () => {
      assert.deepEqual((await admin.query(`select member::regrole::text member,grantor::regrole::text grantor,
        admin_option,inherit_option,set_option from pg_auth_members
        where roleid=$1::regrole order by member`, [role])).rows,
      [
        { member: 'authenticator', grantor: 'postgres', admin_option: false, inherit_option: false, set_option: true },
        { member: 'postgres', grantor: 'supabase_admin', admin_option: true, inherit_option: false, set_option: false },
      ]);
      assert.equal((await admin.query(`select oid from pg_roles where rolname='supabase_admin'`)).rows[0].oid, 10);
      await assert.rejects(migrator.query(`set role ${role}`), error => error.code === '42501');
    });

    await t.test('prior callers, definer bodies and G6 compatibility are unchanged', async () => {
      assert.deepEqual((await admin.query(priorGrants)).rows, before);
      assert.equal((await admin.query(`select has_function_privilege('anon',
        'public.clued_mcp_currentness_g6_gate(text,jsonb)','EXECUTE') allowed`)).rows[0].allowed, true);
      // The production workflow wraps each file in plpgsql EXECUTE; replay must preserve grants too.
      await migrator.query(`create function pg_temp.apply_gateway(s text) returns void language plpgsql
        as $apply$ begin execute s; end $apply$`);
      await migrator.query('select pg_temp.apply_gateway($1)', [sql]);
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

    await t.test('schema lookup gates PUBLIC table/column grants, but never excuses direct ACLs or OID sequence access', async () => {
      const schema = 'test_worker_gateway_private';
      await admin.query(`create schema ${schema};
        create table ${schema}.public_table(id integer); insert into ${schema}.public_table values(7);
        create table ${schema}.public_column(visible integer,hidden integer);
        insert into ${schema}.public_column values(11,13);
        create view ${schema}.public_view as select id from ${schema}.public_table;
        grant select on ${schema}.public_table to public;
        grant select on ${schema}.public_view to public;
        grant select(visible) on ${schema}.public_column to public;
        create sequence ${schema}.sequence_oid;`);
      const limited = server.getPgClient(); clients.push(limited); await limited.connect();
      await limited.query('set session authorization authenticator; set role clued_worker_gateway');
      const apply = () => migrator.query('select pg_temp.apply_gateway($1)', [sql]);
      const denied = error => error.code === '42501';
      const rejectsKind = (kind, object, directAcl) => error => {
        if (error.code !== '42501' || error.message !== 'worker_gateway_role_unexpected_privileges') return false;
        const matching = JSON.parse(error.detail).violations.find(v => v.kind === kind && v.object === object);
        assert.ok(matching, error.detail);
        assert.equal(matching.schema, schema);
        assert.equal(matching.schema_usage, false);
        assert.equal(matching.direct_acl, directAcl);
        return true;
      };
      try {
        assert.deepEqual((await admin.query(`select has_schema_privilege($1,$2,'USAGE') schema_usage,
          has_table_privilege($1,$2||'.public_table','SELECT') table_select,
          has_table_privilege($1,$2||'.public_view','SELECT') view_select,
          has_column_privilege($1,$2||'.public_column','visible','SELECT') column_select`, [role, schema])).rows[0],
          { schema_usage: false, table_select: true, view_select: true, column_select: true });
        await apply();
        await assert.rejects(limited.query(`select * from ${schema}.public_table`), denied);
        await assert.rejects(limited.query(`select * from ${schema}.public_view`), denied);
        await assert.rejects(limited.query(`select visible from ${schema}.public_column`), denied);
        await assert.rejects(limited.query(`select nextval('${schema}.sequence_oid')`), denied);
        for (const [widen, repair] of [
          [`grant usage on schema ${schema} to ${role}`, `revoke usage on schema ${schema} from ${role}`],
          [`grant usage on schema ${schema} to public`, `revoke usage on schema ${schema} from public`],
        ]) {
          await admin.query(widen);
          try { await assert.rejects(apply(), error => error.code === '42501' &&
            JSON.parse(error.detail).violations.some(v => v.kind === 'schema_permission' && v.object === schema), widen); }
          finally { await admin.query(repair); }
        }
        for (const [widen, repair, kind, object] of [
          [`grant select on ${schema}.public_table to ${role}`, `revoke select on ${schema}.public_table from ${role}`, 'table_permission', `${schema}.public_table`],
          [`grant select(hidden) on ${schema}.public_column to ${role}`, `revoke select(hidden) on ${schema}.public_column from ${role}`, 'column_permission', `${schema}.public_column`],
          [`grant usage on sequence ${schema}.sequence_oid to ${role}`, `revoke usage on sequence ${schema}.sequence_oid from ${role}`, 'sequence_permission', `${schema}.sequence_oid`],
        ]) {
          await admin.query(widen);
          try { await assert.rejects(apply(), rejectsKind(kind, object, true), widen); }
          finally { await admin.query(repair); }
        }
        await admin.query(`grant usage on sequence ${schema}.sequence_oid to public`);
        try {
          const oid = (await admin.query('select $1::regclass::oid value', [`${schema}.sequence_oid`])).rows[0].value;
          await assert.rejects(limited.query(`select nextval('${schema}.sequence_oid')`), denied);
          assert.equal((await limited.query('select nextval($1::oid::regclass)::integer value', [oid])).rows[0].value, 1,
            'numeric OID sequence access needs no schema lookup');
          await assert.rejects(apply(), rejectsKind('sequence_permission', `${schema}.sequence_oid`, false));
        } finally { await admin.query(`revoke usage on sequence ${schema}.sequence_oid from public`); }
        await admin.query('create table public.test_worker_gateway_public_readable(id integer); grant select on public.test_worker_gateway_public_readable to public');
        try {
          await assert.rejects(apply(), error => error.code === '42501' && JSON.parse(error.detail).violations.some(v =>
            v.kind === 'table_permission' && v.object === 'public.test_worker_gateway_public_readable' &&
            v.schema === 'public' && v.schema_usage === true && v.direct_acl === false));
        } finally { await admin.query('drop table public.test_worker_gateway_public_readable'); }
        await apply();
      } finally { await admin.query(`drop schema ${schema} cascade`); }
    });

    await t.test('replay refuses an existing role with unexpected privileges instead of silently cleaning it', async () => {
      const fixtureSecret = hex();
      await admin.query('create table public.test_worker_gateway_diagnostic_secret(secret text)');
      await admin.query('insert into public.test_worker_gateway_diagnostic_secret values($1)', [fixtureSecret]);
      const diagnosticKinds = new Set();
      const rejected = error => {
        if (error.code !== '42501' || error.message !== 'worker_gateway_role_unexpected_privileges') return false;
        const diagnostic = JSON.parse(error.detail);
        assert.equal(diagnostic.schema, 'clued.worker-gateway-diagnostic.v1');
        assert.ok(diagnostic.violations.length > 0);
        assert.ok(diagnostic.violations.length <= 100);
        assert.ok(!error.detail.includes(fixtureSecret), 'diagnostics never contain business row values');
        for (const violation of diagnostic.violations) {
          diagnosticKinds.add(violation.kind);
          assert.ok(violation.object || violation.role || violation.class, 'each rejection identifies its catalog object');
          if (violation.kind === 'gateway_membership' || violation.kind === 'inherited_role') {
            assert.equal(typeof violation.member, 'string');
            assert.equal(typeof violation.grantor, 'string');
            for (const option of ['admin', 'inherit', 'set']) assert.equal(typeof violation[option], 'boolean');
          }
        }
        return true;
      };
      const cases = [
        [`grant select on public.test_worker_gateway_diagnostic_secret to ${role}`,
          `revoke select on public.test_worker_gateway_diagnostic_secret from ${role}`],
        [`grant select on public.clued_agent_bindings to ${role}`, `revoke select on public.clued_agent_bindings from ${role}`],
        [`grant maintain on public.clued_agent_bindings to ${role}`, `revoke maintain on public.clued_agent_bindings from ${role}`],
        [`grant select(token_hash) on public.clued_agent_bindings to ${role}`, `revoke select(token_hash) on public.clued_agent_bindings from ${role}`],
        [`grant usage on schema clued_private to ${role}`, `revoke usage on schema clued_private from ${role}`],
        [`grant execute on function public.clued_authorization_prepare_v12(text,jsonb) to ${role}`, `revoke execute on function public.clued_authorization_prepare_v12(text,jsonb) from ${role}`],
        [`grant execute on function public.clued_authorization_status_v12(text) to ${role} with grant option`, `revoke grant option for execute on function public.clued_authorization_status_v12(text) from ${role}`],
        [`create role unexpected_gateway_holder nologin; grant ${role} to unexpected_gateway_holder`, `revoke ${role} from unexpected_gateway_holder; drop role unexpected_gateway_holder`],
        [`grant ${role} to authenticator with admin option`, `revoke admin option for ${role} from authenticator`],
        [`grant ${role} to authenticator with inherit true`, `grant ${role} to authenticator with inherit false`],
        [`grant ${role} to authenticator with set false`, `grant ${role} to authenticator with set true`],
        [`grant ${role} to postgres with inherit true`, `grant ${role} to postgres with inherit false`],
        [`grant ${role} to postgres with set true`, `grant ${role} to postgres with set false`],
        // Removing the creator's ADMIN blocks ALTER ROLE before the boundary check.
        [`grant ${role} to postgres with admin false`, `grant ${role} to postgres with admin true`,
          error => error.code === '42501' && error.message === 'permission denied to alter role'],
        // Inject catalog drift only in this disposable cluster: PostgreSQL itself
        // refuses a creator granting ADMIN back to itself, so GRANT cannot build
        // this otherwise exact edge with a substituted grantor.
        [`update pg_auth_members set grantor='postgres'::regrole
          where roleid='${role}'::regrole and member='postgres'::regrole and grantor=10`,
          `update pg_auth_members set grantor=10
          where roleid='${role}'::regrole and member='postgres'::regrole and grantor='postgres'::regrole`],
        [`grant authenticated to ${role}`, `revoke authenticated from ${role}`],
        [`alter role ${role} bypassrls`, `alter role ${role} nobypassrls`],
        [`create sequence public.test_worker_gateway_sequence; grant usage on sequence public.test_worker_gateway_sequence to ${role}`, `drop sequence public.test_worker_gateway_sequence`],
        [`create table public.test_worker_gateway_owned(id integer); alter table public.test_worker_gateway_owned owner to ${role}`, `drop table public.test_worker_gateway_owned`],
      ];
      for (const [widen, repair, refuses = rejected] of cases) {
        await admin.query(widen);
        try { await assert.rejects(migrator.query('select pg_temp.apply_gateway($1)', [sql]), refuses, widen); }
        finally { await admin.query(repair); }
      }
      assert.deepEqual([...diagnosticKinds].sort(), ['column_permission', 'function_acl', 'function_permission',
        'gateway_membership', 'inherited_role', 'ownership', 'role_attributes', 'schema_permission',
        'sequence_permission', 'table_permission'].sort(), 'the actual rejected boundary kinds are diagnosed');
      await admin.query('drop table public.test_worker_gateway_diagnostic_secret');
      await migrator.query('select pg_temp.apply_gateway($1)', [sql]);
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
      await migrator.query(`create function public.test_worker_gateway_role_probe() returns jsonb
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
