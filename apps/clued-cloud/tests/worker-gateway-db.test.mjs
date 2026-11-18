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
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { AUTHORIZATION_SUCCESSOR_MIGRATIONS, CLOSEOUT_MIGRATION, WORKER_SIGNATURES,
  assertAuthorizationSuccessorBoundary, assertGatewayCloseoutBoundary, snapshotAuthorizationCallerBoundary,
  snapshotCallerCatalog, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

// C1 phase 1, Task 9a4d6d2c, Decision 818a9b05: an additive transport role.
// Preserve the C1 historical assertions, then exercise the actual stage-2 migration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261009070002_worker_gateway_transition_v1.sql';
const CLOCK_MIGRATION = '20261011113259_merge_admission_measurement_clock_target_v1.sql';
const CLOCK_SOURCE_SHA256 = 'a895a6593187dc0dd48e79c9f997929fca5ba8ca5033fd3ed8a869f88dbc9bd3';
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

// Supabase's Supautils supplies postgres with controlled event-trigger DDL.
// Vanilla embedded PostgreSQL has no hook. Emulate only these two fixed DDL
// statements through a disposable, zero-argument admin-owned capability; all
// other migration statements still run as NOSUPERUSER postgres. This is not a
// real Supautils/production capability test or a generic privileged SQL runner.
async function applyClockFixtureCapability(admin, migrator, caller, clockSql) {
  assert.equal(crypto.createHash('sha256').update(clockSql).digest('hex'), CLOCK_SOURCE_SHA256);
  const statements = [
    'create event trigger clock_source_ddl_end_candidate on ddl_command_end execute function clued_private.clock_source_ddl_candidate_v1();',
    'create event trigger clock_source_sql_drop_candidate on sql_drop execute function clued_private.clock_source_ddl_candidate_v1();',
  ];
  for (const statement of statements) assert.equal(clockSql.split(statement).length, 2, 'the exact reviewed DDL appears once');
  const roleState = () => migrator.query(`select current_user,session_user,rolsuper from pg_roles where rolname=current_user`);
  assert.deepEqual((await roleState()).rows[0], { current_user:'postgres',session_user:'postgres',rolsuper:false });
  assert.equal((await admin.query(`select count(*)::integer n from pg_event_trigger
    where evtname in ('clock_source_ddl_end_candidate','clock_source_sql_drop_candidate')`)).rows[0].n,0);
  await assert.rejects(migrator.query(clockSql), error => error.code === '42501'
    && error.message.includes('permission denied to create event trigger') && error.message.includes('clock_source_ddl_end_candidate'));
  assert.equal((await admin.query(`select to_regclass('clued_private.merge_clock_boundary_candidate_v1') is null absent`)).rows[0].absent, true,
    'the unadapted atomic clock installation rolls back at the vanilla capability gap');
  await migrator.query('create temporary table fixture_clock_capability_scope_v1(id integer)');
  const schema = (await migrator.query(`select nspname from pg_namespace where oid=pg_my_temp_schema()`)).rows[0].nspname;
  assert.match(schema, /^pg_temp_[0-9]+$/);
  assert.deepEqual((await migrator.query(`select c.relnamespace=pg_my_temp_schema() same_schema,
    c.relowner::regrole::text owner,c.relpersistence from pg_class c
    where c.oid='pg_temp.fixture_clock_capability_scope_v1'::regclass`)).rows[0],
    {same_schema:true,owner:'postgres',relpersistence:'t'});
  const capability = `"${schema}".fixture_clock_event_capability_v1()`;
  assert.equal((await admin.query('select to_regprocedure($1) is null absent',[capability])).rows[0].absent,true);
  await admin.query(`create function ${capability} returns void language plpgsql security definer set search_path='' as $scope$
    begin
      if session_user is distinct from 'postgres' or current_setting('role',true) is distinct from 'none'
        or pg_my_temp_schema() is distinct from '${schema}'::regnamespace::oid then
        raise exception 'fixture_clock_deployment_role_required' using errcode='42501';
      end if;
      ${statements.join('\n')}
    end $scope$;
    revoke all on function ${capability} from public,anon,authenticated,service_role,authenticator,clued_p5_gateway,clued_worker_gateway;
    grant execute on function ${capability} to postgres;`);
  try {
    assert.deepEqual((await admin.query(`select p.proowner::regrole::text owner,p.prosecdef,
      pg_get_function_identity_arguments(p.oid) arguments,has_function_privilege('postgres',p.oid,'EXECUTE') migrator,
      has_function_privilege('clued_worker_gateway',p.oid,'EXECUTE') gateway,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service,
      has_function_privilege('authenticator',p.oid,'EXECUTE') authenticator,has_function_privilege('clued_p5_gateway',p.oid,'EXECUTE') p5,
      exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') public
      from pg_proc p where p.oid=$1::regprocedure`,[capability])).rows[0],
      {owner:'supabase_admin',prosecdef:true,arguments:'',migrator:true,gateway:false,anon:false,authenticated:false,service:false,authenticator:false,p5:false,public:false});
    assert.deepEqual((await admin.query(`select a.grantee::regrole::text grantee,a.privilege_type,a.is_grantable
      from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure order by grantee`,[capability])).rows,
      [{grantee:'postgres',privilege_type:'EXECUTE',is_grantable:false},
        {grantee:'supabase_admin',privilege_type:'EXECUTE',is_grantable:false}], 'no other caller gets the scoped deployment capability');
    await caller.query('set role clued_worker_gateway');
    await assert.rejects(caller.query(`select ${capability}`), error => error.code==='42501');
    const adapted = clockSql.replace(statements[0], `perform ${capability};`).replace(statements[1], '');
    assert.equal(adapted.replace(`perform ${capability};`,''), clockSql.replace(statements[0],'').replace(statements[1],''),
      'only the two reviewed event-trigger statements are delegated; every other byte is unchanged');
    await migrator.query(adapted);
    assert.deepEqual((await roleState()).rows[0], { current_user:'postgres',session_user:'postgres',rolsuper:false });
    assert.deepEqual((await admin.query(`select evtname,evtevent,evtenabled,evtowner::regrole::text owner
      from pg_event_trigger where evtname in ('clock_source_ddl_end_candidate','clock_source_sql_drop_candidate') order by evtname`)).rows,
      [{evtname:'clock_source_ddl_end_candidate',evtevent:'ddl_command_end',evtenabled:'O',owner:'supabase_admin'},
        {evtname:'clock_source_sql_drop_candidate',evtevent:'sql_drop',evtenabled:'O',owner:'supabase_admin'}],
      'vanilla event-trigger ownership remains the trusted deployment administrator, not the runtime caller');
    assert.equal((await admin.query(`select bool_and(p.proowner='postgres'::regrole) exact_owner from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private' and
      (p.proname like 'clock_source_%' or p.proname like 'merge_clock_%')`)).rows[0].exact_owner, true);
    assert.equal((await admin.query(`select bool_and(c.relowner='postgres'::regrole) exact_owner from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_private' and c.relkind in ('r','S') and
      (c.relname like 'clock_source_%' or c.relname like 'merge_clock_%' or c.relname='merge_measurement_clock_registration_v1')`)).rows[0].exact_owner,true);
  } finally {
    await admin.query(`drop function ${capability}`);
    await migrator.query('drop table fixture_clock_capability_scope_v1');
  }
  assert.equal((await admin.query('select to_regprocedure($1) is null absent',[capability])).rows[0].absent,true);
}

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

    await t.test('the reviewed grant list covers live call sites and the retained heartbeat grant only', async () => {
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
      // This historical migration predates the on-demand scheduler. The
      // heartbeat RPC remains in the database until its separate retirement.
      const heartbeat = 'public.clued_mcp_projection_refresh_heartbeat(text,jsonb)';
      assert.ok(!expected.includes(heartbeat), 'the Worker no longer calls the heartbeat RPC');
      assert.deepEqual(signatures, [...expected, heartbeat].sort());
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
    await t.test('the bounded transition chain closes anon RPCs and preserves Native/P5 definitions and ACL', async () => {
      await migrator.query('drop function public.test_worker_gateway_role_probe()');
      for (const name of migrations.filter(n => n > MIGRATION && n < CLOSEOUT_MIGRATION)) {
        try {
          const laterSql=await fs.readFile(path.join(root,'supabase/migrations',name),'utf8');
          if(name===CLOCK_MIGRATION) await applyClockFixtureCapability(admin,migrator,caller,laterSql);
          else await migrator.query(laterSql);
        }
        catch (error) { throw new Error(`Later migration ${name}: ${error.message}`,{cause:error}); }
      }
      const catalogBefore=await snapshotCallerCatalog(admin);
      const closeout=await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8');
      await migrator.query(closeout);
      await assertGatewayCloseoutBoundary(admin);
      const catalogAfter=await snapshotCallerCatalog(admin);
      const g6='clued_mcp_currentness_g6_gate(text,jsonb)';
      const legacy=new Set(['clued_project_mutate(text,jsonb)','clued_storage_jobs_v2(text,jsonb)']);
      const stripPublic=s=>s.replace(/^public\./,'');
      const definitions=rows=>rows.filter(r=>stripPublic(r.signature)!==g6).map(({acl,...r})=>r);
      assert.deepEqual(definitions(catalogAfter),definitions(catalogBefore),'every non-G6 business definition, owner and config remains');
      const protectedRows=rows=>rows.filter(r=>!WORKER_SIGNATURES.includes(stripPublic(r.signature))&&!legacy.has(stripPublic(r.signature)));
      assert.deepEqual(protectedRows(catalogAfter),protectedRows(catalogBefore),'Native/P5/private/platform ACL remains');
      await migrator.query(closeout);
      assert.deepEqual(await snapshotCallerCatalog(admin),catalogAfter,'actual stage-2 replay is idempotent');
      await assertGatewayCloseoutBoundary(admin);
    });

    const stage2Proof=hex(),stage2Project=crypto.randomUUID(),stage2OtherProject=crypto.randomUUID();
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,'Gateway stage 2','gateway stage 2',$3,'confirmed',now())`,[stage2Project,user,'project:'+stage2Project]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,'Gateway stage 2 other','gateway stage 2 other',$3,'confirmed',now())`,[stage2OtherProject,user,'project:'+stage2OtherProject]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'test','stage-2 synthetic Binding',$2,array['context:read'],array['*'])`,[user,stage2Proof]);
    const gate=()=>caller.query('select public.clued_mcp_currentness_g6_gate($1,$2::jsonb) value',[stage2Proof,JSON.stringify({project_id:stage2Project})]);
    await t.test('actual G6 uses request role and valid JWT object together, preserving Binding business rejection',async()=>{
      await asRole(role);
      assert.equal((await gate()).rows[0].value.status,'not_ready');
      for(const claims of ['', '{', '{}','null','[]','123','true','"clued_worker_gateway"','{"role":"anon"}']) {
        await caller.query("select set_config('request.jwt.claims',$1,false)",[claims]);
        await assert.rejects(gate(),e=>e.code==='42501'&&e.message==='worker_gateway_required');
      }
      for(const name of ['anon','authenticated','clued_p5_gateway']) {
        await asRole(name);
        await caller.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role})]);
        await assert.rejects(gate(),e=>e.code==='42501');
      }
      await asRole(role);
      await assert.rejects(caller.query('select public.clued_mcp_currentness_g6_gate($1,$2::jsonb)',[hex(),'{}']),
        e=>e.code==='42501'&&e.message==='binding_not_authorized');
    });
    await t.test('accidental caller grants do not bypass G6 and unknown app ACL drift refuses the whole replay',async()=>{
      const closeout=await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8');
      await migrator.query('grant execute on function public.clued_mcp_currentness_g6_gate(text,jsonb) to authenticated');
      try {
        await asRole('authenticated');
        await caller.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role})]);
        await assert.rejects(gate(),e=>e.code==='42501'&&e.message==='worker_gateway_required');
      } finally {await migrator.query('revoke execute on function public.clued_mcp_currentness_g6_gate(text,jsonb) from authenticated');}
      await migrator.query('grant execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) to clued_worker_gateway');
      try {
        const before=await snapshotCallerCatalog(admin);
        await assert.rejects(migrator.query(closeout),e=>e.code==='42501'&&e.message==='worker_gateway_role_unexpected_privileges');
        assert.deepEqual(await snapshotCallerCatalog(admin),before,'failed replay cannot partially revoke the unexpected Native grant');
      } finally {await migrator.query('revoke execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) from clued_worker_gateway');}
      await migrator.query(`create function public.clued_test_unknown_closeout() returns int language sql security definer set search_path='' as 'select 1';
        revoke all on function public.clued_test_unknown_closeout() from public; grant execute on function public.clued_test_unknown_closeout() to anon`);
      try {
        const before=await snapshotCallerCatalog(admin);
        await assert.rejects(migrator.query(closeout),e=>e.code==='42501'&&e.message==='worker_gateway_closeout_boundary_unqualified'
          &&e.detail.includes('clued_test_unknown_closeout'));
        assert.deepEqual(await snapshotCallerCatalog(admin),before);
      } finally {await migrator.query('drop function public.clued_test_unknown_closeout()');}
      await migrator.query(closeout);
      await assertGatewayCloseoutBoundary(admin);
    });
    await t.test('the authorization pair preserves exact caller identities and boundaries after all independent successors are installed',async()=>{
      // Install accepted independent successors before measuring the authorization pair.
      // Their Native RPC additions must be in the exact baseline, not ignored by it.
      for (const name of migrations.filter(n=>n>CLOSEOUT_MIGRATION&&!AUTHORIZATION_SUCCESSOR_MIGRATIONS.includes(n))) {
        try {
          const laterSql=await fs.readFile(path.join(root,'supabase/migrations',name),'utf8');
          if(name===CLOCK_MIGRATION) await applyClockFixtureCapability(admin,migrator,caller,laterSql);
          else await migrator.query(laterSql);
        } catch(error) { throw new Error(`Later migration ${name}: ${error.message}`,{cause:error}); }
      }
      const authorizationBefore=await snapshotAuthorizationCallerBoundary(admin);
      for (const name of AUTHORIZATION_SUCCESSOR_MIGRATIONS) {
        assert.ok(migrations.includes(name),'the exact authorization successor file is present: '+name);
        await migrator.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
      }
      await assertAuthorizationSuccessorBoundary(admin,authorizationBefore);
    });
    await t.test('Native sources_v1 reduction rejects the observed old flat protocol, enforces CAS and preserves untargeted consent',async()=>{
      await allowTestIssuerCredentials(admin);
      const human=server.getPgClient();clients.push(human);await human.connect();
      await human.query('set role authenticated');
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [user,JSON.stringify({sub:user,role:'authenticated',session_id:'gateway-source-db',aal:'aal1',
          amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)-30}]})]);
      const issuer=hex(),resource='https://gateway-source.example.invalid/mcp';
      await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
        values($1,$2,'Gateway sources protocol fixture')`,[issuer,resource]);
      const pa='project:'+stage2Project,pb='project:'+stage2OtherProject;
      const selected=[pa,pb].map(resource_id=>({resource_kind:'scope',resource_id,environment:'canonical',actions:['read','write']}));
      const prepared=(await human.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) value',
        [issuer,JSON.stringify({request_digest:hex(),client_id:'gateway-source',client_name:'Gateway source fixture',
          redirect_uri:'https://gateway-source.example.invalid/cb',resource,requested_scopes:['context:read','context:write']})])).rows[0].value;
      const proof=hex();
      const approval=(await human.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value',
        [issuer,prepared.request_id,prepared.version,JSON.stringify(selected),proof,new Date(Date.now()+3600000).toISOString()])).rows[0].value;
      const manage=async input=>(await human.query('select public.clued_authorization_manage_v12($1::jsonb) value',[JSON.stringify(input)])).rows[0].value;
      const view=async()=> (await manage({op:'list'})).bindings.find(b=>b.binding_id===approval.binding_id);
      const current=await view();
      assert.equal(current.selection_format,'sources_v1');
      const exactSource=resourceId=>current.sources.filter(s=>s.kind==='direct'&&s.contributions.length===1
        &&s.contributions[0].resource_kind==='scope'&&s.contributions[0].resource_id===resourceId
        &&s.contributions[0].environment==='canonical');
      assert.equal(exactSource(pa).length,1);assert.equal(exactSource(pb).length,1);
      const [sourceA]=exactSource(pa),[sourceB]=exactSource(pb);
      const worker=server.getPgClient();clients.push(worker);await worker.connect();
      const read=project_id=>workerGatewayRpc(worker,'clued_record_list',proof,{level:'project',project_id,record_type:'note'});
      await read(stage2Project);await read(stage2OtherProject);
      const before=await view();
      await assert.rejects(manage({op:'reduce',binding_id:approval.binding_id,base_version:current.version,selected:[selected[0]]}),
        e=>e.code==='22023'&&e.message==='authorization_source_selection_required_sources_v1');
      assert.deepEqual(await view(),before,'rejected legacy protocol changes no authorization, source or grant DTO');
      const reduction={op:'reduce',binding_id:approval.binding_id,base_version:current.version,selection_format:'sources_v1',
        sources:[{source_id:sourceB.source_id,base_version:sourceB.version,action_cap:[]}],exceptions:[]};
      await assert.rejects(manage({...reduction,base_version:Number(current.version)+1}),
        e=>e.code==='40001'&&e.message==='authorization_version_conflict');
      await assert.rejects(manage({...reduction,sources:[{...reduction.sources[0],base_version:Number(sourceB.version)+1}]}),
        e=>e.code==='40001'&&e.message==='authorization_source_version_conflict');
      assert.deepEqual(await view(),before,'both failed CAS attempts leave the full DTO unchanged');
      const reduced=await manage(reduction);
      assert.equal(reduced.binding_id,approval.binding_id);
      assert.equal(Number(reduced.version),Number(current.version)+1);
      assert.deepEqual(reduced.selected.map(r=>r.resource_id),[pa]);
      const after=await view();
      assert.deepEqual(after.sources.find(s=>s.source_id===sourceA.source_id),sourceA,'the unsubmitted source remains byte-for-byte unchanged');
      assert.equal(after.sources.some(s=>s.source_id===sourceB.source_id),false,'the named source is revoked');
      assert.deepEqual(after.overrides,current.overrides,'source reduction invents no resource override');
      await read(stage2Project);
      await assert.rejects(read(stage2OtherProject),e=>e.code==='42501'&&/binding_not_authorized|resource_action_not_authorized/.test(e.message));
      await assert.rejects(manage(reduction),e=>e.code==='40001'&&e.message==='authorization_version_conflict');
      await manage({op:'revoke',binding_id:approval.binding_id,base_version:after.version});
      await assert.rejects(read(stage2Project),e=>e.code==='42501'&&e.message==='binding_not_authorized');
      await assertGatewayCloseoutBoundary(admin);
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    try { await removeTestDirectory(directory); }
    catch (error) { if (!failure) throw error; process.stderr.write(`Gateway fixture cleanup: ${error.code}\n`); }
  }
});
