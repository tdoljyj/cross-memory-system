import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openMigration = '20261009160000_worker_gateway_request_context_probe_v1.sql';
const closeMigration = '20261009160100_close_worker_gateway_request_context_probe_v1.sql';
const signature = 'public.clued_worker_request_context_probe_v1()';
const lifecycle = 'clued_private.worker_request_probe_lifecycle_v1';
const role = 'clued_worker_gateway';
const hash = () => crypto.randomBytes(32).toString('hex');
const identityDenied = error => error.code === '55000' && /worker_request_context_probe_/.test(error.message);
const requestDenied = error => error.code === '42501';
const businessCatalog = `select p.oid::regprocedure::text signature,p.proowner::regrole::text owner,
  p.prosecdef,p.proconfig,p.prosrc,p.proacl::text acl,
  has_function_privilege('anon',p.oid,'EXECUTE') anon,
  has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
  has_function_privilege('service_role',p.oid,'EXECUTE') service_role,
  has_function_privilege('clued_p5_gateway',p.oid,'EXECUTE') p5,
  has_function_privilege('clued_worker_gateway',p.oid,'EXECUTE') gateway
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'clued_%'
    and p.proname<>'clued_worker_request_context_probe_v1' order by signature`;

test('temporary gateway probe reports real invoker settings and closes permanently without changing business ACLs',
  { timeout: 240000 }, async t => {
    const sql = name => fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    const [opening, closing] = await Promise.all([sql(openMigration), sql(closeMigration)]);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-gateway-request-context-'));
    const server = newCluster({ databaseDir: directory, user: 'postgres', password: hash(),
      persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
      onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
    const clients = [];
    let failure;
    try {
      await startCluster(server);
      const admin = server.getPgClient(); clients.push(admin); await admin.connect();
      await admin.query(`create role anon nologin; create role authenticated nologin;
        create role service_role nologin bypassrls; create role authenticator nologin noinherit;
        grant anon,authenticated,service_role to authenticator;
        create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
        create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
          banned_until timestamptz,deleted_at timestamptz);
        create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
        create function auth.uid() returns uuid language sql stable as
          $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        create function auth.jwt() returns jsonb language sql stable as
          $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
        grant usage on schema auth,extensions to anon,authenticated,service_role;
        grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
      const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort();
      assert.ok(migrations.indexOf('20261009070001_issuer_identity_credentials_v1.sql') < migrations.indexOf(openMigration));
      for (const name of migrations.filter(n => n !== openMigration && n !== closeMigration)) {
        try { await admin.query(await sql(name)); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      }
      const baseline = (await admin.query(businessCatalog)).rows;
      await assertGatewayCloseoutBoundary(admin);
      const caller = server.getPgClient(); clients.push(caller); await caller.connect();
      await caller.query('set session authorization authenticator; set role clued_worker_gateway');
      const metadata = () => admin.query(`select singleton,opened_at,deadline,closed_at,function_oid,function_owner_oid,
        function_definition,opened_at::text opened_text,deadline::text deadline_text,extract(epoch from deadline-opened_at)::integer lifetime_seconds
        from ${lifecycle} where singleton`).then(r => r.rows[0]);
      const probe = () => caller.query(`select ${signature} value`).then(r => r.rows[0].value);
      const setCaller = async (selectedRole = role, claims = JSON.stringify({ role: selectedRole })) => {
        await caller.query('reset role'); await caller.query(`set role ${selectedRole}`);
        await caller.query("select set_config('request.jwt.claims',$1,false)", [claims]);
      };

      await t.test('unknown pre-existing same-name function is refused before the private lifecycle is created', async () => {
        await admin.query(`create function ${signature} returns jsonb language sql as $$select '{}'::jsonb$$`);
        try { await assert.rejects(admin.query(opening), identityDenied); }
        finally { await admin.query(`drop function ${signature}`); }
        assert.equal((await admin.query('select to_regclass($1) value', [lifecycle])).rows[0].value, null);
      });
      try { await admin.query(opening); }
      catch (error) {
        // Safe catalog-only diagnostics for a first-open schema mismatch, no row values.
        if (error.message === 'worker_request_context_probe_lifecycle_drift') {
          const schemaBlock = opening.match(/    create table clued_private\.worker_request_probe_lifecycle_v1[\s\S]*?(?=    table_oid:=)/)?.[0];
          if (schemaBlock) {
            await admin.query(schemaBlock);
            const diagnostics = (await admin.query(`select conname,contype,convalidated,pg_get_constraintdef(oid) definition
              from pg_constraint where conrelid=$1::regclass order by conname`, [lifecycle])).rows;
            console.log('LOCAL catalog shape:', JSON.stringify(diagnostics));
          }
        }
        throw error;
      }
      const initial = await metadata();

      await t.test('only the gateway has a temporary no-argument SECURITY INVOKER EXECUTE grant', async () => {
        const fn = (await admin.query(`select prosecdef,provolatile,pronargs,proretset,proowner::regrole::text owner,
          proconfig,pg_get_function_result(oid) result from pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
        assert.deepEqual(fn, { prosecdef: false, provolatile: 's', pronargs: 0, proretset: false,
          owner: 'postgres', proconfig: ['search_path=""'], result: 'jsonb' });
        const grantees = (await admin.query(`select a.grantee::regrole::text grantee,a.privilege_type,a.is_grantable
          from pg_proc p cross join lateral aclexplode(p.proacl) a
          where p.oid=$1::regprocedure and a.grantee<>p.proowner order by 1`, [signature])).rows;
        assert.deepEqual(grantees, [{ grantee: role, privilege_type: 'EXECUTE', is_grantable: false }]);
        for (const selected of ['anon', 'authenticated', 'service_role', 'authenticator', 'clued_p5_gateway']) {
          assert.equal((await admin.query('select has_function_privilege($1,$2,\'EXECUTE\') value', [selected, signature])).rows[0].value, false, selected);
          assert.equal((await admin.query('select has_table_privilege($1,$2,\'SELECT\') value', [selected, lifecycle])).rows[0].value, false, selected);
        }
        assert.equal((await admin.query('select has_table_privilege($1,$2,\'SELECT\') value', [role, lifecycle])).rows[0].value, false);
        const expectedGateway = [...baseline.filter(r => r.gateway).map(r => r.signature), signature]
          .map(s => s.replace(/^public\./, '')).sort();
        const actualGateway = (await admin.query(`select p.oid::regprocedure::text signature
          from pg_proc p where p.pronamespace='public'::regnamespace
            and has_function_privilege('clued_worker_gateway',p.oid,'EXECUTE') order by 1`)).rows
          .map(r => r.signature.replace(/^public\./, '')).sort();
        assert.deepEqual(actualGateway, expectedGateway, 'the exact qualified successor plus only the temporary probe');
        await assert.rejects(admin.query(`select ${signature}`), requestDenied,
          'even the function owner does not satisfy the request identity guard');
        assert.deepEqual((await admin.query(businessCatalog)).rows, baseline);
      });

      await t.test('reports actual request identity and current statement timeout; it never sets the timeout', async () => {
        await setCaller();
        // Explicit local simulation of PostgREST role settings. This is not HTTP JWT evidence.
        const roleTimeout = (await admin.query(`select substr(setting,length('statement_timeout=')+1) value
          from pg_roles r cross join lateral unnest(r.rolconfig) setting
          where r.rolname=$1 and setting like 'statement_timeout=%'`, [role])).rows[0].value;
        assert.equal(roleTimeout, '3s');
        for (const timeout of [roleTimeout, '1100ms']) {
          await caller.query('begin');
          try {
            await caller.query("select set_config('statement_timeout',$1,true)", [timeout]);
            const before = (await caller.query("select current_setting('statement_timeout') value")).rows[0].value;
            const result = await probe();
            assert.deepEqual(Object.keys(result).sort(), ['current_user','deadline','jwt_role','request_role','statement_timeout'].sort());
            assert.equal(result.current_user, role); assert.equal(result.request_role, role); assert.equal(result.jwt_role, role);
            assert.equal(result.statement_timeout, before);
            assert.equal(new Date(result.deadline).getTime(), initial.deadline.getTime());
            assert.equal((await caller.query("select current_setting('statement_timeout') value")).rows[0].value, before);
          } finally { await caller.query('rollback'); }
        }
        await assert.rejects(caller.query(`select * from ${lifecycle}`), requestDenied);
      });

      await t.test('first lifecycle is exactly thirty minutes and opening replay never extends it', async () => {
        assert.equal(initial.lifetime_seconds, 1800); assert.equal(initial.closed_at, null);
        await admin.query(opening); await admin.query(opening);
        assert.deepEqual(await metadata(), initial);
      });

      await t.test('empty, bad JSON, null, scalar, array and mismatching JWT roles fail closed', async () => {
        for (const claims of ['', '{', '{}', 'null', '[]', '"clued_worker_gateway"', '1', 'true',
          '{"role":"anon"}', '{"role":null}', '{"role":["clued_worker_gateway"]}']) {
          await setCaller(role, claims);
          await assert.rejects(probe(), error => error.code === '42501' && error.message === 'worker_request_context_probe_denied', claims);
        }
        // A future mistaken grant must not make another request role usable with a forged JWT role.
        await admin.query(`grant execute on function ${signature} to anon,authenticated,service_role,clued_p5_gateway`);
        try {
          for (const selected of ['anon','authenticated','service_role','clued_p5_gateway']) {
            await setCaller(selected, JSON.stringify({ role }));
            await assert.rejects(probe(), error => error.code === '42501' && error.message === 'worker_request_context_probe_denied');
          }
        } finally { await admin.query(`revoke execute on function ${signature} from anon,authenticated,service_role,clued_p5_gateway`); }
      });

      await t.test('expiry uses the actual handler; a past literal fixture is refused without waiting or changing system time', async () => {
        await setCaller();
        const past = (await admin.query("select (clock_timestamp()-interval '1 hour')::text value")).rows[0].value;
        assert.ok(initial.function_definition.includes(initial.deadline_text));
        // Change only this disposable database's embedded deadline, not source migrations or guard logic.
        const expiredDefinition = initial.function_definition.replaceAll(initial.deadline_text, past);
        await admin.query(expiredDefinition);
        try {
          await assert.rejects(probe(), error => error.code === '42501' && error.message === 'worker_request_context_probe_expired');
          await assert.rejects(admin.query(opening), identityDenied);
          await assert.rejects(admin.query(closing), identityDenied);
        } finally { await admin.query(initial.function_definition); }
      });

      await t.test('function ACL, owner, SECURITY DEFINER, timeout configuration and overload drift are refused', async () => {
        const cases = [
          [`grant execute on function ${signature} to public`, `revoke execute on function ${signature} from public`],
          [`grant execute on function ${signature} to ${role} with grant option`, `revoke grant option for execute on function ${signature} from ${role}`],
          [`alter function ${signature} security definer`, `alter function ${signature} security invoker`],
          [`alter function ${signature} set statement_timeout='1s'`, `alter function ${signature} reset statement_timeout`],
          [`alter function ${signature} owner to authenticated`, `alter function ${signature} owner to postgres`],
          [`create function public.clued_worker_request_context_probe_v1(text) returns jsonb language sql as $$select '{}'::jsonb$$`,
            'drop function public.clued_worker_request_context_probe_v1(text)'],
        ];
        for (const [widen, repair] of cases) {
          await admin.query(widen);
          try { await assert.rejects(admin.query(opening), identityDenied, widen); await assert.rejects(admin.query(closing), identityDenied, widen); }
          finally {
            await admin.query(repair);
            if (/owner to/.test(widen)) {
              await admin.query(`revoke all on function ${signature} from authenticated;
                grant execute on function ${signature} to ${role}`);
            }
          }
        }
        await admin.query(opening);
      });

      await t.test('private lifecycle schema, access and row deadline drift cannot be silently repaired', async () => {
        const cases = [
          [`alter table ${lifecycle} add column unexpected text`, `alter table ${lifecycle} drop column unexpected`],
          [`alter table ${lifecycle} disable row level security`, `alter table ${lifecycle} enable row level security`],
          [`grant select on ${lifecycle} to ${role}`, `revoke select on ${lifecycle} from ${role}`],
          [`create policy unexpected on ${lifecycle} using(true)`, `drop policy unexpected on ${lifecycle}`],
        ];
        for (const [widen] of cases) {
          // Dropping a column leaves a dropped attribute, deliberately treated as drift;
          // roll back the whole negative fixture to restore the exact original shape.
          await admin.query('begin');
          try { await admin.query(widen); await assert.rejects(admin.query(opening), identityDenied, widen); }
          finally { await admin.query('rollback'); }
          await admin.query('begin');
          try { await admin.query(widen); await assert.rejects(admin.query(closing), identityDenied, widen); }
          finally { await admin.query('rollback'); }
        }
        await admin.query(`update ${lifecycle} set opened_at=opened_at+interval '1 hour',deadline=deadline+interval '1 hour' where singleton`);
        try { await assert.rejects(admin.query(opening), identityDenied); await assert.rejects(admin.query(closing), identityDenied); }
        finally { await admin.query(`update ${lifecycle} set opened_at=$1,deadline=$2 where singleton`, [initial.opened_text,initial.deadline_text]); }
        await admin.query(opening);
      });

      await t.test('cleanup preserves the explicit gateway successor and open/close replay never resurrects the probe', async () => {
        await admin.query(closing);
        assert.equal((await admin.query('select to_regprocedure($1) value', [signature])).rows[0].value, null);
        const tombstone = await metadata(); assert.ok(tombstone.closed_at);
        assert.equal(tombstone.lifetime_seconds, 1800);
        await admin.query(opening); await admin.query(closing); await admin.query(opening);
        assert.equal((await admin.query('select to_regprocedure($1) value', [signature])).rows[0].value, null);
        assert.deepEqual(await metadata(), tombstone);
        // The full chain now includes Worker82/CI8. Never replay the historical
        // Worker80 transition over its deliberately larger exact successor.
        await assertGatewayCloseoutBoundary(admin);
        assert.deepEqual((await admin.query(businessCatalog)).rows, baseline);
        await admin.query(`create function ${signature} returns jsonb language sql as $$select '{}'::jsonb$$`);
        try { await assert.rejects(admin.query(opening), identityDenied); await assert.rejects(admin.query(closing), identityDenied); }
        finally { await admin.query(`drop function ${signature}`); }
      });
    } catch (error) { failure = error; throw error; }
    finally {
      for (const db of clients.reverse()) await db.end().catch(() => {});
      await stopCluster(server);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('clued-gateway-request-context-'));
      try { await removeTestDirectory(directory); }
      catch (error) { if (!failure) throw error; }
    }
  });
