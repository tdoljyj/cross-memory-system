import { stopCluster } from './cluster-cleanup.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
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

// S2c Integration Runtime PR-2 (IntegrationRuntime v0.1.8 §14.1): Integration identity, Installation
// Requests, the Claim Store, connections and explicit Binding ownership, normalization and the PR-2
// operations. Proves G-A10 (except the cases that need PR-3's ACTIVE), the DB parts of T-A3-1 / 3 / 6,
// T-A7-9's DB layer, T-A9-1, T-A9-11 and T-S-1…6. The PR-2 gating test T-A11-26 was removed by PR-4 (§13.5,
// v0.1.8 NIT-3), which replaces the temporary REPLACE_HOLDER refusal with rule 2 (T-A11-15(c)(e)).
// Every database runs as a non-root OS user (embedded-postgres refuses root).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261005090000_integration_runtime_identity_claim.sql';
// the stage C §5.13 grant migration: held back until T-S-2 has checked the S2c-only database (§13.0)
const GRANTS = '20261005163000_integration_runtime_grants.sql';
const STATES = ['INSTALL_PENDING', 'INSTALLED', 'AUTH_PENDING', 'VERIFYING', 'ACTIVE', 'DEGRADED', 'BLOCKED',
  'REAUTH_REQUIRED', 'INCOMPATIBLE', 'REVOKED'];
const BINDING_RPCS = ['clued_integration_request_open_v1', 'clued_integration_create_or_bind_v1',
  'clued_integration_identity_update_v1', 'clued_integration_reconcile_request_v1', 'clued_integration_status_v1'];
const TABLES = ['integration_binding_owners_v1', 'integration_binding_ownership_log_v1',
  'integration_canonical_verifications_v1', 'integration_capability_declarations_v1', 'integration_claims_v1',
  'integration_connections_v1',
  'integration_derivation_diagnostics_v1', 'integration_facts_v1', 'integration_identity_snapshots_v1',
  'integration_installation_requests_v1', 'integration_operation_log_v1', 'integration_reauth_marks_v1',
  'integration_regrants_v1', 'integration_revocations_v1', 'integrations_v1'];
const FULL = ['audit.read', 'context.read', 'context.write', 'development_history.read', 'evidence.write',
  'project.read', 'project.write'];

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const uid = () => crypto.randomUUID();
const key = (label = 'k') => `${label}-${crypto.randomUUID()}`;

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function expectCode(promise, code) {
  try {
    const result = await promise;
    assert.fail(`expected ${code}, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.equal(error.message, code);
  }
}

test('S2c PR-2: identity, Installation Requests, claims, connections and ownership', { timeout: 1_800_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-identity-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: sha(uid()), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync', '-c', 'max_connections=60'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  const connect = async () => {
    const client = server.getPgClient();
    clients.push(client);
    await client.connect();
    return client;
  };
  try {
    await server.initialise();
    await server.start();
    const admin = await connect();
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(MIGRATION));
    const apply = async (name) => {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    for (const name of migrations.filter((name) => name < MIGRATION)) await apply(name);

    // ---- fixtures ----------------------------------------------------------------------------
    let earlyWriterInstalled = false;
    const withOwnerWriter = async (owner, write) => {
      // The historical S2c snapshot precedes this protocol. Only fixtures in
      // the subsequently installed full chain acquire its real Owner mutex.
      if (!earlyWriterInstalled) return write(false);
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
        assert.equal((await admin.query('select clued_private.authorization_writer_guard_held_v2($1) held', [owner])).rows[0].held, true);
        const result = await write(true);
        await admin.query('commit');
        return result;
      } catch (error) { await admin.query('rollback'); throw error; }
    };
    const newUser = async () => {
      const id = uid();
      await admin.query('insert into auth.users(id, email) values ($1, $2)', [id, `${id}@clued.test`]);
      return id;
    };
    const rawBinding = async (user, { scopes = ['context:read', 'context:write', 'audit:read'], organization = null,
      workspace = null, createdAt = null } = {}) => {
      const token = `clued_bnd_${crypto.randomBytes(24).toString('hex')}`;
      const { rows } = await admin.query(`insert into public.clued_agent_bindings(user_id, vendor, agent_name, token_hash,
          scopes, organization_id, workspace_id, active_context_key, role, purpose, policy_version, revocation_epoch,
          expires_at, actor_kind, created_at)
        values ($1, 'Test', 'raw', $2, $3, $4, $5, case when $4::uuid is null then null else 'global' end,
          case when $4::uuid is null then null else 'denied' end, case when $4::uuid is null then null else 'test' end,
          case when $4::uuid is null then null else 1 end, case when $4::uuid is null then null else 1 end,
          case when $4::uuid is null then null else now() + interval '1 day' end,
          case when $4::uuid is null then null else 'agent_binding' end, coalesce($6, now())) returning id`,
      [user, sha(token), scopes, organization, workspace, createdAt]);
      return { id: rows[0].id, token, hash: sha(token), user };
    };
    const issuer = sha('integration-identity-issuer');
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash, resource, name)
      values ($1, 'https://clued.test/mcp', 'test issuer')`, [issuer]);
    const DEFAULT_ENTRIES = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] }];
    const oauthBinding = async (user, { client = 'client-a', scopes = ['context:read', 'context:write'],
      entries = DEFAULT_ENTRIES, createdAt = null, expiresAt = null, issuance = 'oauth' } = {}) => withOwnerWriter(user, async (currentProtocol) => {
      const binding = await rawBinding(user, { scopes });
      let request = null;
      if (issuance === 'oauth') {
        request = (await admin.query(`insert into clued_private.authorization_requests_v12(owner_id, issuer_hash,
            request_digest, client_id, client_name, redirect_uri, resource, requested_scopes, eligible, status, binding_id)
          values ($1, $2, $3, $4, $4, 'https://host.test/cb', 'https://clued.test/mcp', $5, '[]', 'approved', $6) returning id`,
        [user, issuer, sha(uid()), client, scopes, binding.id])).rows[0].id;
      }
      await admin.query(`insert into clued_private.authorizations_v12(binding_id, request_id, owner_id, client_id, client_name,
          resource, expires_at, created_at, issuance)
        values ($1, $2, $3, $4, $4, $5, coalesce($6, now() + interval '20 days'), coalesce($7, clock_timestamp()), $8)`,
      [binding.id, request, user, issuance === 'oauth' ? client : 'clued-headless',
        issuance === 'oauth' ? 'https://clued.test/mcp' : 'clued:headless', expiresAt, createdAt, issuance]);
      for (const entry of entries) {
        await admin.query(`insert into clued_private.authorization_entries_v12(binding_id, resource_kind, resource_id,
            environment, actions) values ($1, $2, $3, $4, $5)`,
        [binding.id, entry.resource_kind, entry.resource_id, entry.environment, entry.actions]);
      }
      if (currentProtocol && entries.some((entry) => entry.resource_kind === 'scope' && entry.resource_id === 'project:*')) {
        // This seed is historical flat consent. The retired deferred trigger
        // is replaced by its explicit guarded legacy expander, which uses
        // initialize_sources(..., false); it does not create contexts:* consent.
        const prior = (await admin.query('select scopes from public.clued_agent_bindings where id=$1', [binding.id])).rows[0];
        const priorAuthorization = (await admin.query('select to_jsonb(a) v from clued_private.authorizations_v12 a where binding_id=$1', [binding.id])).rows[0].v;
        await admin.query('select clued_private.authorization_all_projects_expand_v1($1)', [binding.id]);
        assert.deepEqual((await admin.query('select scopes from public.clued_agent_bindings where id=$1', [binding.id])).rows[0], prior);
        assert.deepEqual((await admin.query('select to_jsonb(a) v from clued_private.authorizations_v12 a where binding_id=$1', [binding.id])).rows[0].v, priorAuthorization);
        assert.equal((await admin.query('select source_protocol from clued_private.authorization_source_bindings_v2 where binding_id=$1', [binding.id])).rows[0].source_protocol, false);
        for (const entry of entries) assert.deepEqual((await admin.query(`select actions from clued_private.authorization_entries_v12
          where binding_id=$1 and resource_kind=$2 and resource_id=$3 and environment=$4`,
        [binding.id, entry.resource_kind, entry.resource_id, entry.environment])).rows[0].actions, entry.actions);
      }
      return { ...binding, client, request };
    });

    // pre-migration Bindings for T-S-4 / T-A9-11
    const preUser = await newUser();
    const preRaw = await rawBinding(preUser);
    const preOauth = await oauthBinding(preUser, { client: 'pre-existing' });

    // ---- T-S-3 snapshot around the migration ---------------------------------------------------
    const snapshot = async () => (await admin.query(`select jsonb_build_object(
      'functions', (select jsonb_object_agg(p.oid::regprocedure::text,
          md5(case when p.prokind = 'a' then p.oid::regprocedure::text else pg_get_functiondef(p.oid) end)
          || ':' || coalesce(p.proacl::text, '') || ':' || pg_get_userbyid(p.proowner))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'),
      'relations', (select jsonb_object_agg(c.oid::regclass::text, jsonb_build_object('kind', c.relkind,
          'acl', coalesce(c.relacl::text, ''), 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
          'owner', pg_get_userbyid(c.relowner),
          'viewdef', (case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end),
          'columns', (select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
              coalesce(pg_get_expr(d.adbin, d.adrelid), ''), coalesce(a.attacl::text, '')) order by a.attnum)
            from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
          'constraints', (select jsonb_object_agg(co.conname, pg_get_constraintdef(co.oid))
            from pg_constraint co where co.conrelid = c.oid),
          'indexes', (select jsonb_object_agg(i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid))
            from pg_index i where i.indrelid = c.oid),
          'triggers', (select jsonb_object_agg(tg.tgname, pg_get_triggerdef(tg.oid))
            from pg_trigger tg where tg.tgrelid = c.oid and not tg.tgisinternal)))
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'),
      'policies', (select jsonb_object_agg(schemaname || '.' || tablename || '.' || policyname,
          jsonb_build_array(permissive, roles, cmd, qual, with_check)) from pg_policies),
      'schemas', (select jsonb_object_agg(nspname, coalesce(nspacl::text, '') || ':' || pg_get_userbyid(nspowner))
        from pg_namespace),
      'default_acl', (select coalesce(jsonb_agg(jsonb_build_array(defaclrole, defaclnamespace, defaclobjtype,
          defaclacl::text) order by defaclrole, defaclnamespace, defaclobjtype), '[]') from pg_default_acl),
      'roles', (select jsonb_object_agg(rolname, jsonb_build_array(rolsuper, rolinherit, rolcanlogin, rolbypassrls))
        from pg_roles)) s`)).rows[0].s;
    const before = await snapshot();
    await apply(MIGRATION);
    const after = await snapshot();
    // Production order: the migrations up to the grant migration now, the grant migration and every later one
    // (the security hygiene migration 20261007120000 among them) once T-S-2 has checked the database before it.
    assert.ok(migrations.includes(GRANTS));
    for (const name of migrations.filter((name) => name > MIGRATION && name < GRANTS)) await apply(name);

    await t.test('T-S-3 applying the migration leaves every existing object unchanged', () => {
      for (const kind of ['functions', 'relations', 'policies', 'schemas']) {
        for (const [name, value] of Object.entries(before[kind] ?? {})) {
          assert.deepEqual(after[kind]?.[name], value, `${kind} ${name} changed`);
        }
      }
      assert.deepEqual(after.default_acl, before.default_acl);
      assert.deepEqual(after.roles, before.roles);
      const added = Object.keys(after.relations).filter((name) => !(name in before.relations));
      for (const name of added) assert.match(name, /^clued_private\.integration[a-z0-9_]*$/, name);
      assert.deepEqual(added.filter((name) => after.relations[name].kind === 'r').sort(),
        TABLES.map((name) => `clued_private.${name}`).sort());
      const addedFunctions = Object.keys(after.functions).filter((name) => !(name in before.functions));
      for (const name of addedFunctions) {
        assert.match(name, /^(clued_private\.integration_|(public\.)?clued_integration_|(public\.)?clued_user_integration_v1)/, name);
      }
      assert.deepEqual(Object.keys(after.policies ?? {}).filter((name) => !(name in (before.policies ?? {}))), []);
    });

    await t.test('T-S-4 / T-A9-11 applying the migration creates no Integration, whatever Bindings exist', async () => {
      const { rows } = await admin.query('select (select count(*) from clued_private.integrations_v1) i, (select count(*) from public.clued_agent_bindings) b');
      assert.equal(Number(rows[0].i), 0);
      assert.ok(Number(rows[0].b) >= 2);
    });

    await t.test('T-S-1 every new table has RLS on, no policy and no privilege for public, anon, authenticated, service_role', async () => {
      const { rows } = await admin.query(`select c.relname, c.relkind, c.relrowsecurity,
          exists (select 1 from aclexplode(c.relacl) a where a.grantee <> c.relowner) any_grantee,
          (select count(*) from pg_policies p where p.schemaname = 'clued_private' and p.tablename = c.relname) policies,
          bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger')) any_privilege
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (select rolname::text as rolname from pg_roles where rolname in ('anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway')) r
        where n.nspname = 'clued_private' and c.relname = any($1) group by c.oid, c.relname, c.relkind, c.relrowsecurity,
          c.relacl, c.relowner order by c.relname`, [TABLES]);
      assert.deepEqual(rows.map((r) => r.relname), [...TABLES].sort());
      for (const row of rows) {
        assert.equal(row.relrowsecurity, true, row.relname);
        assert.equal(row.any_grantee, false, row.relname);
        assert.equal(Number(row.policies), 0, row.relname);
        assert.equal(row.any_privilege, false, row.relname);
      }
      assert.equal(Number((await admin.query(`select count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'clued_private' and c.relname like 'integration%' and c.relkind = 'S'`)).rows[0].n), 0, 'no sequence');
      assert.equal(Number((await admin.query(`select count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like '%integration%' and c.relkind in ('v','m')`)).rows[0].n), 0, 'no public view');
    });

    await t.test('T-S-2 no EXECUTE on any Integration function before the target grants (OQ-21)', async () => {
      const { rows } = await admin.query(`select p.oid::regprocedure::text f,
          bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) any_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (select rolname::text as rolname from pg_roles where rolname in ('anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway')) r
        where (n.nspname = 'clued_private' and p.proname like 'integration\\_%')
           or (n.nspname = 'public' and (p.proname like 'clued\\_integration\\_%' or p.proname = 'clued_user_integration_v1'))
        group by p.oid`);
      assert.ok(rows.length > 40, `${rows.length} functions`);
      for (const row of rows) assert.equal(row.any_execute, false, row.f);
      const publicRpcs = rows.filter((row) => row.f.startsWith('clued_integration_') || row.f.startsWith('clued_user_integration_v1'))
        .map((row) => row.f.replace(/\(.*$/, '')).sort();
      // PR-2's public RPCs; later S2c PRs add theirs, covered by their own test files (PR-3: integration-runtime-verification-db)
      for (const name of [...BINDING_RPCS, 'clued_user_integration_v1']) assert.ok(publicRpcs.includes(name), name);
    });

    // the §5.13 target grants: the stage C grant migration itself (§13.0)
    await apply(GRANTS);
    const executors = async () => (await admin.query(`select p.proname, array_agg(r.rolname order by r.rolname) filter (where
        has_function_privilege(r.rolname, p.oid, 'execute')) roles
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (select rolname::text as rolname from pg_roles where rolname in ('anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway')) r
      where n.nspname = 'public' and p.proname = any($1)
      group by p.proname order by p.proname`, [[...BINDING_RPCS, 'clued_user_integration_v1']])).rows;

    await t.test('T-S-2 after the target grants: exactly §5.13', async () => {
      const rows = await executors();
      assert.equal(rows.length, BINDING_RPCS.length + 1);
      for (const row of rows) {
        assert.deepEqual(row.roles, row.proname === 'clued_user_integration_v1' ? ['authenticated'] : ['anon', 'authenticated'], row.proname);
      }
    });

    // every later migration, in production order
    for (const name of migrations.filter((name) => name > GRANTS)) await apply(name);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
    earlyWriterInstalled = true;
    const gateway=await connect();
    await gateway.query('set session authorization authenticator');
    await setWorkerGatewayCaller(gateway);
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);

    await t.test('T-S-2 after the security hygiene migration: the current Binding path is gateway only after full-chain G6 closeout', async () => {
      const rows = await executors();
      assert.equal(rows.length, BINDING_RPCS.length + 1);
      for (const row of rows) {
        assert.deepEqual(row.roles, row.proname === 'clued_user_integration_v1' ? ['authenticated'] : ['clued_worker_gateway'], row.proname);
      }
    });

    // test-only registry rows (§13.0): test.complete — tenant and account NOT_APPLICABLE, so a claim key
    // is complete; test.noauth — no first authorization; test.tenant — tenant REQUIRED with one accepted
    // test evidence kind, account NOT_APPLICABLE.
    await admin.query(`insert into clued_private.integration_hosts_v1(host, tenant_dimension, account_dimension,
        tenant_evidence_kinds, account_evidence_kinds, first_authorization_required, registry_version, capability_snapshot_ref)
      values ('test.complete', 'NOT_APPLICABLE', 'NOT_APPLICABLE', '{}', '{}', true, 1, 'test'),
             ('test.noauth', 'NOT_APPLICABLE', 'NOT_APPLICABLE', '{}', '{}', false, 1, 'test'),
             ('test.tenant', 'REQUIRED', 'NOT_APPLICABLE', '{TEST_TENANT_ID}', '{}', true, 1, 'test')`);
    await admin.query(`insert into clued_private.integration_host_surfaces_v1(host, surface, capability_ceiling, host_features, registry_version)
      select h, 'default', $1::text[], '{"mcp_tools":true,"oauth":true}', 1
        from unnest(array['test.complete','test.noauth','test.tenant']) h`, [FULL]);

    // ---- channel helpers -------------------------------------------------------------------------
    // Concurrent compound fixtures seed rows and hold locks on their original
    // backend. Switch only that public call's real role, retaining its transaction/PID.
    // A failed SQL statement leaves an open transaction aborted; its existing outer
    // rollback restores the transactional SET and the original SQLSTATE is preserved.
    const roleQueues=new WeakMap();
    const requestRole = (client,role,body) => {
      const next=(roleQueues.get(client) ?? Promise.resolve()).catch(()=>{}).then(async()=>{
      const prior=(await client.query("select current_setting('role') role,current_setting('request.jwt.claims',true) claims")).rows[0];
      await client.query("select set_config('role',$1,false),set_config('request.jwt.claims',$2,false)",[role,JSON.stringify({role})]);
      try { return await body(); }
      finally {
        try { await client.query("select set_config('role',$1,false),set_config('request.jwt.claims',$2,false)",[prior.role,prior.claims ?? '']); }
        catch(error) { if(error.code!=='25P02') throw error; }
      }
      });
      roleQueues.set(client,next);
      return next;
    };
    const rpc = async (client, name, binding, input) => client===admin
      ? workerGatewayRpc(gateway,name,binding.hash ?? binding,input)
      : requestRole(client,'clued_worker_gateway',async() => (await client.query(`select public.${name}($1, $2::jsonb) r`,[binding.hash ?? binding,JSON.stringify(input)])).rows[0].r);
    const native = async (client, user, input) => {
      await client.query('begin');
      await client.query('set local role authenticated');
      try {
        await client.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', '{}', true)`, [user]);
        const result = (await client.query('select public.clued_user_integration_v1($1::jsonb) r', [JSON.stringify(input)])).rows[0].r;
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    };
    const open = (binding, input, client = admin) => rpc(client, 'clued_integration_request_open_v1', binding, {
      request_key: key('request'), intent: 'create_or_bind', host: 'test.complete', host_surface: 'default',
      adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED', ...input,
    });
    const bind = (binding, requestId, intent = 'CREATE_OR_BIND', client = admin, idem = key('bind')) =>
      rpc(client, 'clued_integration_create_or_bind_v1', binding, { idempotency_key: idem, request_id: requestId, binding_intent: intent });
    const install = async (binding, input = {}, intent = 'CREATE_OR_BIND') => {
      const opened = await open(binding, { intent: intent.toLowerCase(), ...input });
      return bind(binding, opened.request_id, intent);
    };
    const integration = async (id) => (await admin.query('select * from clued_private.integrations_v1 where integration_id = $1', [id])).rows[0];
    const evaluate = async (id, asOf = null) => (await admin.query(
      'select clued_private.integration_evaluate_v1($1, coalesce($2::timestamptz, clock_timestamp())) e', [id, asOf])).rows[0].e;
    const currentBinding = async (id) => (await admin.query(`select binding_id from clued_private.integration_connections_v1
      where integration_id = $1 and link_status = 'CURRENT'`, [id])).rows[0]?.binding_id ?? null;
    const counts = async () => (await admin.query(`select jsonb_build_object(
        'integrations', (select count(*) from clued_private.integrations_v1),
        'claims', (select count(*) from clued_private.integration_claims_v1),
        'connections', (select count(*) from clued_private.integration_connections_v1),
        'owners', (select count(*) from clued_private.integration_binding_owners_v1),
        'requests', (select count(*) from clued_private.integration_installation_requests_v1),
        'snapshots', (select count(*) from clued_private.integration_identity_snapshots_v1),
        'operations', (select count(*) from clued_private.integration_operation_log_v1),
        'revocations', (select count(*) from clued_private.integration_revocations_v1),
        'receipts', (select count(*) from public.clued_audit_receipts),
        'events', (select count(*) from public.clued_context_events)) c`)).rows[0].c;
    const claimCount = async (integrationId) => Number((await admin.query(`select count(*) n from clued_private.integration_claims_v1
      where integration_id = $1 and claim_status = 'CURRENT'`, [integrationId])).rows[0].n);

    await t.test('T-A9-1 / T-A10-10 structure: request status ∩ states = ∅; NOT NULL integration_id FKs; no state columns', async () => {
      const def = (await admin.query(`select pg_get_constraintdef(c.oid) d from pg_constraint c
        where c.conrelid = 'clued_private.integration_installation_requests_v1'::regclass and pg_get_constraintdef(c.oid) like '%request_status%IN%'
          or c.conrelid = 'clued_private.integration_installation_requests_v1'::regclass and pg_get_constraintdef(c.oid) like '%request_status = ANY%'`)).rows;
      const values = new Set(def.flatMap((row) => [...row.d.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])));
      assert.ok(values.has('OPEN') && values.has('BOUND'));
      for (const state of STATES) assert.equal(values.has(state), false, state);
      const { rows } = await admin.query(`select c.relname, a.attnotnull, exists (select 1 from pg_constraint f
          where f.conrelid = c.oid and f.contype = 'f' and f.confrelid = 'clued_private.integrations_v1'::regclass
            and a.attnum = any(f.conkey)) fk
        from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'clued_private' and a.attname = 'integration_id' and c.relkind = 'r'
          and c.relname in ('integration_claims_v1','integration_connections_v1','integration_facts_v1',
            'integration_capability_declarations_v1','integration_revocations_v1','integration_regrants_v1',
            'integration_reauth_marks_v1','integration_identity_snapshots_v1','integration_binding_owners_v1',
            'integration_canonical_verifications_v1')`);
      assert.equal(rows.length, 10);
      for (const row of rows) assert.ok(row.attnotnull && row.fk, row.relname);
      const stateColumns = (await admin.query(`select c.relname, a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'clued_private' and c.relname like 'integration%'
        and a.attname in ('integration_state','integration_operable','effective_capabilities') and a.attnum > 0`)).rows;
      assert.deepEqual(stateColumns, []);
    });

    await t.test('T-S-5 an unusable token reads and writes nothing (403 before any side effect)', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const opened = await open(b, {});
      const c0 = await counts();
      for (const bad of ['not-a-hash', sha('unknown-token')]) {
        await expectCode(rpc(admin, 'clued_integration_create_or_bind_v1', bad, { idempotency_key: key(), request_id: opened.request_id,
          binding_intent: 'CREATE_OR_BIND' }), 'binding_not_authorized');
        await expectCode(rpc(admin, 'clued_integration_request_open_v1', bad, { request_key: key('request') }), 'binding_not_authorized');
        await expectCode(rpc(admin, 'clued_integration_status_v1', bad, {}), 'binding_not_authorized');
        await expectCode(rpc(admin, 'clued_integration_identity_update_v1', bad, { idempotency_key: key(), integration_id: uid(),
          base_version: 1 }), 'binding_not_authorized');
        await expectCode(rpc(admin, 'clued_integration_reconcile_request_v1', bad, { idempotency_key: key(), integration_id: uid(),
          base_version: 1 }), 'binding_not_authorized');
      }
      const revoked = await rawBinding(user);
      await admin.query('update public.clued_agent_bindings set revoked_at = now() where id = $1', [revoked.id]);
      await expectCode(bind(revoked, opened.request_id), 'binding_not_authorized');
      assert.deepEqual(await counts(), c0);
    });

    await t.test('T-A10-1 one Installation Request never yields a second integration_id', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const opened = await open(b, { host: 'anthropic.claude', host_surface: 'claude_code' });
      // (a) the same idempotency_key five times → the same Receipt, replayed
      const idem = key('idem');
      const first = await bind(b, opened.request_id, 'CREATE_OR_BIND', admin, idem);
      assert.equal(first.status, 'committed');
      assert.equal(first.supplemental.outcome, 'CREATE');
      for (let n = 0; n < 5; n += 1) {
        const again = await bind(b, opened.request_id, 'CREATE_OR_BIND', admin, idem);
        assert.equal(again.replayed, true);
        assert.equal(again.receipt_id, first.receipt_id);
        assert.equal(again.supplemental.integration_id, first.supplemental.integration_id);
      }
      // (b) a new idempotency_key, same request and intent → the same integration_id
      const second = await bind(b, opened.request_id);
      assert.equal(second.status, 'committed');
      assert.equal(second.supplemental.integration_id, first.supplemental.integration_id);
      assert.equal(second.supplemental.request_replayed, true);
      assert.equal(second.supplemental.outcome, 'CREATE');
      // (c) callback replay: the same request_key re-opened returns the same Request
      const payload = (await admin.query('select request_key, request_payload from clued_private.integration_installation_requests_v1 where request_id = $1',
        [opened.request_id])).rows[0];
      const reopened = await rpc(admin, 'clued_integration_request_open_v1', b, { request_key: payload.request_key,
        intent: 'create_or_bind', host: 'anthropic.claude', host_surface: 'claude_code', adapter_family: 'test-adapter',
        adapter_version: '1.0.0', installation_phase: 'COMPLETED' });
      assert.equal(reopened.request_id, opened.request_id);
      assert.equal(reopened.replayed, true);
      const third = await bind(b, reopened.request_id);
      assert.equal(third.supplemental.integration_id, first.supplemental.integration_id);
      // the same key with a different payload is a conflict
      await expectCode(rpc(admin, 'clued_integration_request_open_v1', b, { request_key: payload.request_key,
        intent: 'create_or_bind', host: 'anthropic.claude', host_surface: 'chat', adapter_family: 'test-adapter',
        adapter_version: '1.0.0' }), 'installation_request_key_conflict');
      // (d) BOUND is decided before the intent comparison; a different caller or intent is refused
      const other = await rawBinding(user);
      const byOther = await bind(other, opened.request_id);
      assert.equal(byOther.status, 'rejected');
      assert.equal(byOther.error_code, 'installation_request_bound_to_other_integration');
      const otherIntent = await bind(b, opened.request_id, 'REBIND');
      assert.equal(otherIntent.error_code, 'installation_request_bound_to_other_integration');
      const fresh = await open(b, { host: 'anthropic.claude', host_surface: 'claude_code' });
      const mismatch = await bind(b, fresh.request_id, 'REBIND');
      assert.equal(mismatch.error_code, 'installation_request_intent_mismatch');
      // a BOUND Request replayed after expires_at still returns the same id (NIT-1)
      await admin.query(`alter table clued_private.integration_installation_requests_v1 disable trigger integration_installation_requests_v1_bound_immutable;
        update clued_private.integration_installation_requests_v1 set expires_at = now() - interval '1 hour' where request_id = '${opened.request_id}';
        alter table clued_private.integration_installation_requests_v1 enable trigger integration_installation_requests_v1_bound_immutable;`);
      const late = await bind(b, opened.request_id);
      assert.equal(late.supplemental.integration_id, first.supplemental.integration_id);
      // an OPEN Request past expires_at is refused
      await admin.query(`alter table clued_private.integration_installation_requests_v1 disable trigger integration_installation_requests_v1_bound_immutable;
        update clued_private.integration_installation_requests_v1 set expires_at = now() - interval '1 hour' where request_id = '${fresh.request_id}';
        alter table clued_private.integration_installation_requests_v1 enable trigger integration_installation_requests_v1_bound_immutable;`);
      assert.equal((await bind(b, fresh.request_id)).error_code, 'installation_request_expired');
      // (e) two connections replaying one Request concurrently, 20 rounds → always one id
      const c1 = await connect(); const c2 = await connect();
      // each round a fresh Binding: a Binding that already owns an Integration cannot create another (§5.5 O3)
      for (let round = 0; round < 20; round += 1) {
        const br = await rawBinding(user);
        const r = await open(br, { host: 'anthropic.claude', host_surface: 'claude_code' });
        const [x, y] = await Promise.all([bind(br, r.request_id, 'CREATE_OR_BIND', c1), bind(br, r.request_id, 'CREATE_OR_BIND', c2)]);
        assert.equal(x.status, 'committed'); assert.equal(y.status, 'committed');
        assert.equal(x.supplemental.integration_id, y.supplemental.integration_id);
      }
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integrations_v1 where owner_id = $1', [user])).rows[0].n), 21);
    });

    await t.test('T-A10-3 unavailable dimensions never merge through weak identifiers', async () => {
      const user = await newUser();
      const provenance = { email: 'same@example.com', display_name: 'Same Person', vendor: 'Anthropic' };
      const x = await install(await rawBinding(user), { host: 'anthropic.claude', host_surface: 'chat', source_provenance: provenance });
      const y = await install(await rawBinding(user), { host: 'anthropic.claude', host_surface: 'chat', source_provenance: provenance });
      assert.notEqual(x.supplemental.integration_id, y.supplemental.integration_id);
      for (const id of [x.supplemental.integration_id, y.supplemental.integration_id]) {
        const row = await integration(id);
        assert.equal(row.identity_claim_state, 'INCOMPLETE_UNCLAIMED');
        assert.equal(row.claim_key_sha256, null);
      }
      const b = await rawBinding(user);
      for (const kind of ['EMAIL', 'DISPLAY_NAME', 'HOST_UI_LABEL', 'VENDOR_LABEL', 'AGENT_NAME', 'CLIENT_NAME', 'UNVERIFIED_HOST_ASSERTION']) {
        await expectCode(open(b, { host: 'anthropic.claude', host_surface: 'chat',
          account: { status: 'VALUE', value: 'same@example.com', evidence_kind: kind } }), 'identity_weak_identifier_forbidden');
      }
      // an accepted-looking but unregistered kind leaves the dimension UNAVAILABLE (§6.2 rule 4)
      const z = await install(b, { host: 'anthropic.claude', host_surface: 'chat',
        account: { status: 'VALUE', value: 'acct-1', evidence_kind: 'HOST_SIGNED_ASSERTION:demo' } });
      assert.equal((await integration(z.supplemental.integration_id)).account_status, 'UNAVAILABLE');
      // NOT_APPLICABLE only from the registry
      await expectCode(open(b, { host: 'anthropic.claude', host_surface: 'chat', tenant: { status: 'NOT_APPLICABLE' } }),
        'identity_dimension_not_applicable_mismatch');
      // static: the claim key reads Tuple columns only
      const src = (await admin.query(`select pg_get_functiondef('clued_private.integration_claim_key_material_v1(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure) d`)).rows[0].d;
      assert.doesNotMatch(src, /provenance|email|display|vendor|agent_name|client_name/i);
    });

    await t.test('T-S-6 Integration operations write no Event and change no continuity state (OQ-15)', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const before = await admin.query(`select (select count(*) from public.clued_context_events) e,
        (select count(*) from public.clued_context_checkpoints) k`);
      const created = await install(b, {});
      const id = created.supplemental.integration_id;
      await rpc(admin, 'clued_integration_status_v1', b, {});
      await rpc(admin, 'clued_integration_identity_update_v1', b, { idempotency_key: key(), integration_id: id,
        base_version: (await integration(id)).version });
      const afterRows = await admin.query(`select (select count(*) from public.clued_context_events) e,
        (select count(*) from public.clued_context_checkpoints) k`);
      assert.deepEqual(afterRows.rows[0], before.rows[0]);
      const receipts = (await admin.query(`select operation_family, event_ids from public.clued_audit_receipts
        where user_id = $1 and operation_family like 'integration%'`, [user])).rows;
      assert.ok(receipts.length >= 2);
      for (const row of receipts) assert.deepEqual(row.event_ids, [], row.operation_family);
    });
    await t.test('T-A10-2 concurrent create_or_bind on one complete key never yields two current holders', async () => {
      const user = await newUser();
      const c1 = await connect(); const c2 = await connect();
      // (a) two Requests, two Bindings of one OAuth client (same key), 50 rounds with random interleaving
      for (let round = 0; round < 50; round += 1) {
        const client = `race-${round}`;
        const b1 = await oauthBinding(user, { client }); const b2 = await oauthBinding(user, { client });
        const r1 = await open(b1, {}); const r2 = await open(b2, {});
        const delay = Math.floor(Math.random() * 3);
        const [x, y] = await Promise.all([
          bind(b1, r1.request_id, 'CREATE_OR_BIND', c1),
          new Promise((resolve) => setTimeout(resolve, delay)).then(() => bind(b2, r2.request_id, 'CREATE_OR_BIND', c2))]);
        assert.equal(x.status, 'committed', JSON.stringify(x)); assert.equal(y.status, 'committed', JSON.stringify(y));
        assert.equal(x.supplemental.integration_id, y.supplemental.integration_id);
        assert.deepEqual([x.supplemental.outcome, y.supplemental.outcome].sort(), ['BIND_EXISTING', 'CREATE']);
        const k = (await integration(x.supplemental.integration_id)).claim_key_sha256;
        assert.equal(Number((await admin.query(`select count(*) n from clued_private.integration_claims_v1
          where claim_key_sha256 = $1 and claim_status = 'CURRENT'`, [k])).rows[0].n), 1);
      }
      // (b) deterministic: A holds L4 uncommitted, B waits on the advisory lock, then binds to A's id
      const ba = await oauthBinding(user, { client: 'det' }); const bb = await oauthBinding(user, { client: 'det' });
      const ra = await open(ba, {}); const rb = await open(bb, {});
      await c1.query('begin');
      const a = await rpc(c1,'clued_integration_create_or_bind_v1',ba,
        { idempotency_key: key(), request_id: ra.request_id, binding_intent: 'CREATE_OR_BIND' });
      const pid = (await c2.query('select pg_backend_pid() p')).rows[0].p;
      const pending = bind(bb, rb.request_id, 'CREATE_OR_BIND', c2);
      let waiting = null;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        waiting = (await admin.query(`select wait_event_type, wait_event from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid])).rows[0];
      }
      assert.ok(waiting, 'B waits on a lock');
      assert.equal(waiting.wait_event, 'advisory');
      await c1.query('commit');
      const bres = await pending;
      assert.equal(bres.supplemental.integration_id, a.supplemental.integration_id);
      assert.equal(bres.supplemental.outcome, 'BIND_EXISTING');
      // (c) A rolls back → B creates and is the only holder
      const bc = await oauthBinding(user, { client: 'rollback' }); const bd = await oauthBinding(user, { client: 'rollback' });
      const rc = await open(bc, {}); const rd = await open(bd, {});
      await c1.query('begin');
      await rpc(c1,'clued_integration_create_or_bind_v1',bc,
        { idempotency_key: key(), request_id: rc.request_id, binding_intent: 'CREATE_OR_BIND' });
      const pendingD = bind(bd, rd.request_id, 'CREATE_OR_BIND', c2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await c1.query('rollback');
      const dres = await pendingD;
      assert.equal(dres.supplemental.outcome, 'CREATE');
      assert.equal(await claimCount(dres.supplemental.integration_id), 1);
    });

    // test.tenant: tenant REQUIRED with one accepted evidence kind; INCOMPLETE until a tenant is known
    const tenant = (value) => ({ status: 'VALUE', value, evidence_kind: 'TEST_TENANT_ID' });

    await t.test('T-A10-4 / T-A10-5 late strengthening re-claims atomically; a collision is CLAIM_CONFLICT and BLOCKED', async () => {
      const user = await newUser();
      const bh = await oauthBinding(user, { client: 'tenant-client' });
      const holder = await install(bh, { host: 'test.tenant', tenant: tenant('T1') });
      assert.equal(holder.supplemental.identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      // an INCOMPLETE Integration of the same client (tenant unknown) strengthens into the same key
      const bi = await oauthBinding(user, { client: 'tenant-client' });
      const incomplete = await install(bi, { host: 'test.tenant' });
      assert.equal(incomplete.supplemental.identity_claim_state, 'INCOMPLETE_UNCLAIMED');
      const iid = incomplete.supplemental.integration_id;
      const update = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: iid,
        base_version: (await integration(iid)).version, tenant: tenant('T1') });
      assert.equal(update.status, 'committed', JSON.stringify(update));
      assert.equal(update.supplemental.identity_claim_state, 'CLAIM_CONFLICT');
      const row = await integration(iid);
      assert.equal(row.conflicting_integration_id, holder.supplemental.integration_id);
      const e = await evaluate(iid);
      assert.equal(e.integration_state, 'BLOCKED');
      assert.deepEqual(e.effective_capabilities, []);
      assert.deepEqual(e.candidate_ordinary_capabilities, []);
      assert.equal((await integration(holder.supplemental.integration_id)).identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      // a free key: INCOMPLETE → COMPLETE becomes the holder in the same transaction
      const bj = await oauthBinding(user, { client: 'tenant-client' });
      const j = (await install(bj, { host: 'test.tenant' })).supplemental.integration_id;
      const claimed = await rpc(admin, 'clued_integration_identity_update_v1', bj, { idempotency_key: key(), integration_id: j,
        base_version: (await integration(j)).version, tenant: tenant('T2') });
      assert.equal(claimed.supplemental.identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      assert.equal(await claimCount(j), 1);
      // two INCOMPLETE Integrations strengthening into one key concurrently, 50 rounds → exactly one holder
      const c1 = await connect(); const c2 = await connect();
      for (let round = 0; round < 50; round += 1) {
        const client = `strengthen-${round}`;
        const x = await oauthBinding(user, { client }); const y = await oauthBinding(user, { client });
        const ix = (await install(x, { host: 'test.tenant' })).supplemental.integration_id;
        const iy = (await install(y, { host: 'test.tenant' })).supplemental.integration_id;
        const [rx, ry] = await Promise.all([
          rpc(c1, 'clued_integration_identity_update_v1', x, { idempotency_key: key(), integration_id: ix, base_version: (await integration(ix)).version, tenant: tenant('same') }),
          rpc(c2, 'clued_integration_identity_update_v1', y, { idempotency_key: key(), integration_id: iy, base_version: (await integration(iy)).version, tenant: tenant('same') })]);
        assert.deepEqual([rx.supplemental.identity_claim_state, ry.supplemental.identity_claim_state].sort(),
          ['CLAIM_CONFLICT', 'CURRENT_CLAIM_HOLDER']);
      }
      // facts layer: COMPLETE ∧ INCOMPLETE_UNCLAIMED is C2 (the CHECK forbids it in storage; built in a disposable
      // transaction with the CHECKs dropped, MINOR-3)
      await admin.query('begin');
      try {
        const names = (await admin.query(`select conname from pg_constraint where conrelid = 'clued_private.integrations_v1'::regclass
          and contype = 'c' and (pg_get_constraintdef(oid) like '%identity_completeness%')`)).rows.map((r) => r.conname);
        for (const name of names) await admin.query(`alter table clued_private.integrations_v1 drop constraint ${name}`);
        await admin.query(`alter table clued_private.integrations_v1 disable trigger integrations_v1_claim_consistency`);
        await admin.query(`update clued_private.integrations_v1 set identity_claim_state = 'INCOMPLETE_UNCLAIMED', conflicting_integration_id = null
          where integration_id = $1`, [iid]);
        const c2e = await evaluate(iid);
        assert.equal(c2e.valid, false);
        assert.ok(c2e.reason_codes.includes('C2_COMPLETE_BUT_UNCLAIMED'), JSON.stringify(c2e.reason_codes));
        assert.deepEqual(c2e.effective_capabilities, []);
      } finally {
        await admin.query('rollback');
      }
    });

    await t.test('T-A10-6 a key change has no observable double-current window; the deferred trigger rejects one', async () => {
      const user = await newUser();
      const b = await oauthBinding(user, { client: 'rekey' });
      const id = (await install(b, { host: 'test.tenant', tenant: tenant('K1') })).supplemental.integration_id;
      const k1 = (await integration(id)).claim_key_sha256;
      const c1 = await connect(); const observer = await connect(); const c3 = await connect();
      await c1.query('begin');
      const moved = await rpc(c1,'clued_integration_identity_update_v1',b,
        { idempotency_key: key(), integration_id: id, base_version: (await integration(id)).version, tenant: tenant('K2') });
      assert.equal(moved.status, 'committed', JSON.stringify(moved));
      const seen = (await observer.query(`select claim_key_sha256 from clued_private.integration_claims_v1
        where integration_id = $1 and claim_status = 'CURRENT'`, [id])).rows;
      assert.deepEqual(seen.map((r) => r.claim_key_sha256), [k1], 'the observer sees only the old state');
      // a competitor for K1 waits on L4 until A commits
      const competitor = await oauthBinding(user, { client: 'rekey' });
      const cid = (await install(competitor, { host: 'test.tenant' })).supplemental.integration_id;
      const cversion = (await integration(cid)).version;
      const pending = rpc(c3, 'clued_integration_identity_update_v1', competitor, { idempotency_key: key(), integration_id: cid,
        base_version: cversion, tenant: tenant('K1') });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await c1.query('commit');
      const got = await pending;
      assert.equal(got.supplemental.identity_claim_state, 'CURRENT_CLAIM_HOLDER', JSON.stringify(got));
      assert.equal(await claimCount(id), 1);
      assert.equal((await admin.query(`select count(*) n from clued_private.integration_claims_v1 where claim_key_sha256 = $1 and claim_status = 'CURRENT'`, [k1])).rows[0].n, '1');
      // the deferred trigger: a holder without its row cannot commit
      await expectCode(admin.query(`update clued_private.integration_claims_v1 set claim_status = 'RELEASED', ended_at = now()
        where integration_id = $1 and claim_status = 'CURRENT'`, [id]), 'identity_claim_store_divergence');
      await expectCode(admin.query(`delete from clued_private.integration_claims_v1 where integration_id = $1 and claim_status = 'CURRENT'`, [id]),
        'identity_claim_store_divergence');
      assert.equal(await claimCount(id), 1);
    });

    await t.test('T-A10-13 the same Binding binding one Request 20 ways × 20 rounds never deadlocks', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const pool = [];
      for (let i = 0; i < 20; i += 1) pool.push(await connect());
      for (let round = 0; round < 20; round += 1) {
        // one Binding per round (O3: an owned Binding cannot create a second Integration); 20 calls of it per round
        const br = round === 0 ? b : await rawBinding(user);
        const r = await open(br, { host: 'anthropic.claude', host_surface: 'chat' });
        const results = await Promise.all(pool.map((client) => bind(br, r.request_id, 'CREATE_OR_BIND', client)));
        const ids = new Set(results.map((x) => x.supplemental.integration_id));
        assert.equal(ids.size, 1, JSON.stringify(results.map((x) => x.error_code)));
        for (const x of results) assert.equal(x.status, 'committed');
      }
      for (const client of pool) await client.end();
      // static (d): Binding-channel RPCs never call resolve_binding / resolve_binding_action_v12; the caller row is
      // locked once (integration_lock_bindings_v1), status takes FOR SHARE
      const { rows } = await admin.query(`select p.proname, pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind = 'f' and ((n.nspname = 'public' and p.proname like 'clued\\_integration\\_%') or (n.nspname = 'clued_private' and p.proname like 'integration\\_%'))`);
      for (const row of rows) assert.doesNotMatch(row.d, /resolve_binding/, row.proname);
      const auth = rows.find((row) => row.proname === 'integration_auth_binding_v1').d;
      assert.equal((auth.match(/for share/g) ?? []).length, 1);
      const lock = rows.find((row) => row.proname === 'integration_lock_bindings_v1').d;
      assert.equal((lock.match(/from public\.clued_agent_bindings where id = v_id for update/g) ?? []).length, 1);
    });
    // two Integrations on one complete key (test.complete + one OAuth client): H holds, I is in conflict
    const conflictPair = async (client = `pair-${uid()}`) => {
      const user = await newUser();
      const bh = await oauthBinding(user, { client });
      const h = (await install(bh, { host: 'test.tenant', tenant: tenant('P') })).supplemental.integration_id;
      const bi = await oauthBinding(user, { client });
      const i = (await install(bi, { host: 'test.tenant' })).supplemental.integration_id;
      const u = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: (await integration(i)).version, tenant: tenant('P') });
      assert.equal(u.supplemental.identity_claim_state, 'CLAIM_CONFLICT', JSON.stringify(u));
      return { user, bh, bi, h, i };
    };

    await t.test('T-A10-7 / T-A10-8 / T-A3-6 CLAIM_CONFLICT, PENDING_RECONCILE and SUPERSEDED fail closed through one chain', async () => {
      const { user, bi, h, i } = await conflictPair();
      const check = async (id, claimState) => {
        const e = await evaluate(id);
        assert.equal(e.valid, true, JSON.stringify(e.reason_codes));
        assert.equal(e.facts.identity_claim_state, claimState);
        assert.equal(e.predicates.identity_claim_blocks_ordinary_runtime, true);
        assert.deepEqual(e.candidate_ordinary_capabilities, []);
        assert.ok(['BLOCKED', 'REVOKED', 'INCOMPATIBLE', 'REAUTH_REQUIRED', 'AUTH_PENDING'].includes(e.integration_state), e.integration_state);
        assert.equal(e.integration_operable, false);
        assert.deepEqual(e.effective_capabilities, []);
      };
      await check(i, 'CLAIM_CONFLICT');
      const pending = await rpc(admin, 'clued_integration_reconcile_request_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: (await integration(i)).version });
      assert.equal(pending.status, 'committed', JSON.stringify(pending));
      assert.equal((await integration(i)).conflicting_integration_id, h, 'PENDING_RECONCILE keeps the conflicting ref');
      await check(i, 'PENDING_RECONCILE');
      // reconcile_request on a non-conflict Integration is not applicable
      const again = await rpc(admin, 'clued_integration_reconcile_request_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: (await integration(i)).version });
      assert.equal(again.error_code, 'reconcile_not_applicable');
      // REBIND_TO_HOLDER: I's live connection moves to H; I SUPERSEDED (credential lost, BLOCKED, not REAUTH_REQUIRED)
      const r = await native(admin, user, { op: 'reconcile', idempotency_key: key(), integration_id: i, resolution: 'REBIND_TO_HOLDER',
        base_version: (await integration(i)).version, holder_base_version: (await integration(h)).version });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal(await currentBinding(h), bi.id);
      assert.equal(await currentBinding(i), null);
      const owner = (await admin.query('select integration_id, acquired_via from clued_private.integration_binding_owners_v1 where binding_id = $1', [bi.id])).rows[0];
      assert.deepEqual(owner, { integration_id: h, acquired_via: 'NATIVE_RECONCILE' });
      assert.equal((await admin.query(`select link_authority from clued_private.integration_connections_v1 where integration_id = $1 and link_status = 'CURRENT'`, [h])).rows[0].link_authority, 'NATIVE_RECONCILE');
      const superseded = await integration(i);
      assert.equal(superseded.identity_claim_state, 'SUPERSEDED');
      assert.equal(superseded.historical, 'SUPERSEDED');
      assert.equal(superseded.superseded_by_integration_id, h);
      await check(i, 'SUPERSEDED');
      const e = await evaluate(i);
      assert.equal(e.predicates.credential_lost, true);
      assert.equal(e.integration_state, 'BLOCKED');
      assert.ok(r.supplemental.ownership_transfer.some((x) => x.binding_id === bi.id && x.from_integration_id === i));
      // T-A9-9: a SUPERSEDED Integration cannot be rebound
      const reb = await install(bi, { intent: 'rebind', target_integration_id: i, host: 'test.tenant' }, 'REBIND');
      assert.equal(reb.error_code, 'integration_superseded');
      const bx = await oauthBinding(user, { client: 'unrelated' });
      const rx = await install(bx, { intent: 'rebind', target_integration_id: i, host: 'test.tenant' }, 'REBIND');
      assert.equal(rx.error_code, 'integration_superseded');
      assert.equal(rx.supplemental.superseded_by, h);
    });

    await t.test('Native reconcile REPLACE_HOLDER supersedes the holder and moves its Bindings; guards', async () => {
      const { user, bh, bi, h, i } = await conflictPair();
      const r = await native(admin, user, { op: 'reconcile', idempotency_key: key(), integration_id: i, resolution: 'REPLACE_HOLDER',
        base_version: (await integration(i)).version, holder_base_version: (await integration(h)).version });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal((await integration(i)).identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      assert.equal(await claimCount(i), 1);
      const holder = await integration(h);
      assert.equal(holder.identity_claim_state, 'SUPERSEDED');
      assert.equal(holder.superseded_by_integration_id, i);
      assert.equal(await currentBinding(h), null, "H's CURRENT connection is unlinked");
      assert.equal(await currentBinding(i), bi.id, "I's connection is unchanged");
      assert.equal((await admin.query('select integration_id from clued_private.integration_binding_owners_v1 where binding_id = $1', [bh.id])).rows[0].integration_id, i);
      assert.equal((await admin.query(`select claim_status from clued_private.integration_claims_v1 where integration_id = $1 order by claimed_at desc limit 1`, [h])).rows[0].claim_status, 'SUPERSEDED');
      // stale versions are a conflict, a resolved pair is not applicable
      const stale = await native(admin, user, { op: 'reconcile', idempotency_key: key(), integration_id: i, resolution: 'REPLACE_HOLDER',
        base_version: 1, holder_base_version: 1 });
      assert.equal(stale.error_code, 'reconcile_not_applicable');
      // REBIND_TO_HOLDER needs a live connection on I
      const p2 = await conflictPair();
      await admin.query(`update public.clued_agent_bindings set expires_at = now() - interval '1 minute' where id = $1`, [p2.bi.id]);
      const dead = await native(admin, p2.user, { op: 'reconcile', idempotency_key: key(), integration_id: p2.i, resolution: 'REBIND_TO_HOLDER',
        base_version: (await integration(p2.i)).version, holder_base_version: (await integration(p2.h)).version });
      assert.equal(dead.error_code, 'reconcile_requires_active_connection');
      const conflict = await native(admin, p2.user, { op: 'reconcile', idempotency_key: key(), integration_id: p2.i, resolution: 'REBIND_TO_HOLDER',
        base_version: (await integration(p2.i)).version + 1, holder_base_version: (await integration(p2.h)).version });
      assert.equal(conflict.error_code, 'integration_version_conflict');
    });

    // ---- fail-closed branches (review MAJOR-1…3) -------------------------------------------------
    // business rows of a rejected bind: the Request itself was committed by request_open beforehand
    const business = async () => { const c = await counts(); delete c.receipts; delete c.requests; return c; };
    const unbound = async () => Number((await admin.query(`select count(*) n from clued_private.integration_installation_requests_v1
      where request_status = 'OPEN'`)).rows[0].n);
    const codeOf = async (promise) => {
      try { const r = await promise; return r.error_code ?? r.status; } catch (error) { return error.message; }
    };
    const reconcile = async (user, i, h, resolution) => native(admin, user, { op: 'reconcile', idempotency_key: key(), integration_id: i,
      resolution, base_version: (await integration(i)).version, holder_base_version: (await integration(h)).version });
    const revokeFixture = (id) => admin.query(`insert into clued_private.integration_revocations_v1(integration_id, revoked_by, reason,
        revoked_binding_ids, receipt_id) values ($1, 'USER', 'fixture', '{}', gen_random_uuid())`, [id]);

    await t.test('reconcile re-resolves the holder under L4 / L5: a SUPERSEDED holder never receives or loses a survivor (MAJOR-1)', async () => {
      const client = `tri-${uid()}`;
      const { user, h, i } = await conflictPair(client);
      const b2 = await oauthBinding(user, { client });
      const i2 = (await install(b2, { host: 'test.tenant' })).supplemental.integration_id;
      const u = await rpc(admin, 'clued_integration_identity_update_v1', b2, { idempotency_key: key(), integration_id: i2,
        base_version: (await integration(i2)).version, tenant: tenant('P') });
      assert.equal(u.supplemental.identity_claim_state, 'CLAIM_CONFLICT');
      assert.equal((await integration(i2)).conflicting_integration_id, h);
      assert.equal((await reconcile(user, i, h, 'REPLACE_HOLDER')).status, 'committed');
      assert.equal((await integration(h)).superseded_by_integration_id, i);
      for (const resolution of ['REBIND_TO_HOLDER', 'REPLACE_HOLDER']) {
        const c0 = await business();
        const r = await reconcile(user, i2, h, resolution);
        assert.equal(r.status, 'rejected', resolution);
        assert.equal(r.error_code, 'integration_superseded', resolution);
        assert.equal(r.supplemental.holder_superseded_by, i, resolution);
        assert.deepEqual(await business(), c0, `${resolution}: no business write`);
      }
      const holder = await integration(h);
      assert.equal(holder.superseded_by_integration_id, i, "H's lineage stays under the survivor");
      // a holder that re-keyed away no longer conflicts with I: neither resolution applies
      const p = await conflictPair();
      assert.equal((await rpc(admin, 'clued_integration_identity_update_v1', p.bh, { idempotency_key: key(), integration_id: p.h,
        base_version: (await integration(p.h)).version, tenant: tenant('Q') })).supplemental.identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      assert.equal((await integration(p.i)).conflicting_integration_id, p.h, 'the stored pointer is stale');
      for (const resolution of ['REBIND_TO_HOLDER', 'REPLACE_HOLDER']) {
        const c0 = await business();
        assert.equal((await reconcile(p.user, p.i, p.h, resolution)).error_code, 'reconcile_not_applicable', resolution);
        assert.deepEqual(await business(), c0, `${resolution}: no business write`);
      }
      assert.equal(await currentBinding(p.h), p.bh.id);
      assert.equal((await integration(p.h)).historical, 'NONE');
      assert.equal(await currentBinding(h), null);
      assert.equal(await currentBinding(i2), b2.id);
      assert.equal((await admin.query('select integration_id from clued_private.integration_binding_owners_v1 where binding_id = $1', [b2.id])).rows[0].integration_id, i2);
      assert.equal((await integration(i2)).identity_claim_state, 'CLAIM_CONFLICT');
    });

    await t.test('Native identity_update / reconcile refuse a foreign Integration with 403 before any Receipt (MAJOR-2)', async () => {
      const { h, i } = await conflictPair();
      const stranger = await newUser();
      const c0 = await counts();
      for (const target of [i, uid(), 'not-a-uuid']) {
        await expectCode(native(admin, stranger, { op: 'identity_update', idempotency_key: key(), integration_id: target, base_version: 1,
          tenant: tenant('X') }), 'integration_not_owned');
        await expectCode(native(admin, stranger, { op: 'reconcile', idempotency_key: key(), integration_id: target, base_version: 1,
          holder_base_version: 1, resolution: 'REPLACE_HOLDER' }), 'integration_not_owned');
      }
      // confirm_rebind / adopt_binding check Binding ownership before taking any lock
      const foreign = await oauthBinding((await integration(h)).owner_id, { client: `f-${uid()}` });
      await expectCode(native(admin, stranger, { op: 'adopt_binding', idempotency_key: key(), binding_id: foreign.id, host: 'test.complete',
        host_surface: 'default', adapter_family: 'x', adapter_version: '1', installation_phase: 'COMPLETED' }), 'binding_not_owned');
      assert.deepEqual(await counts(), c0, 'no Receipt and no business row');
    });

    await t.test('the post-write validity gate rejects a write whose result adds a reason code (G-A10, T-A7-9)', async () => {
      // fault injection: drop the owner row a link has just written, so the result reads connection_store
      // OWNER_ROW_MISSING (C7) although the facts before the write were valid
      await admin.query(`create table public.test_gate_fault(binding_id uuid primary key);
        create function public.test_gate_fault_fn() returns trigger language plpgsql as $f$
        begin
          if exists (select 1 from public.test_gate_fault f where f.binding_id = new.binding_id) then
            delete from clued_private.integration_binding_owners_v1 where binding_id = new.binding_id;
          end if;
          return null;
        end $f$;
        create trigger test_gate_fault after insert or update on clued_private.integration_binding_owners_v1
          for each row execute function public.test_gate_fault_fn();`);
      try {
        const user = await newUser();
        const client = `gate-${uid()}`;
        const b0 = await oauthBinding(user, { client });
        const id = (await install(b0, { host: 'test.complete' })).supplemental.integration_id;
        const v0 = (await integration(id)).version;
        // CREATE: a new Integration whose own result is invalid is never written
        const bc = await oauthBinding(user, { client: `gate-c-${uid()}` });
        await admin.query('insert into public.test_gate_fault values ($1)', [bc.id]);
        let c0 = await business();
        const open0 = await unbound();
        const created = await install(bc, { host: 'test.complete' });
        assert.equal(await unbound(), open0 + 1, 'the Request stays OPEN');
        assert.equal(created.status, 'rejected');
        assert.equal(created.error_code, 'derivation_input_invalid');
        assert.ok(created.supplemental.reason_codes.length > 0, JSON.stringify(created.supplemental));
        assert.ok(Array.isArray(created.target_refs));
        assert.equal(created.target_refs.some((ref) => ref.kind === 'integration'), false, 'no ref to the rolled-back Integration');
        assert.deepEqual(await business(), c0, 'CREATE: business rows unchanged');
        // SAME_PROVIDER rebind: I stays on b0, version unchanged
        const b1 = await oauthBinding(user, { client });
        await admin.query('insert into public.test_gate_fault values ($1)', [b1.id]);
        c0 = await business();
        const rebound = await install(b1, { intent: 'rebind', target_integration_id: id, host: 'test.complete' }, 'REBIND');
        assert.equal(rebound.error_code, 'derivation_input_invalid', JSON.stringify(rebound));
        assert.deepEqual(await business(), c0, 'REBIND: business rows unchanged');
        assert.equal(await currentBinding(id), b0.id);
        assert.equal((await integration(id)).version, v0);
        // the same rebind without the fault commits
        await admin.query('delete from public.test_gate_fault');
        assert.equal((await install(b1, { intent: 'rebind', target_integration_id: id, host: 'test.complete' }, 'REBIND')).status, 'committed');
      } finally {
        await admin.query(`drop trigger test_gate_fault on clued_private.integration_binding_owners_v1;
          drop function public.test_gate_fault_fn(); drop table public.test_gate_fault;`);
      }
    });

    await t.test('T-A10-14(b) a same-client Binding owned by J cannot be linked to I through the Binding channel (O3)', async () => {
      const user = await newUser();
      const client = `o3-${uid()}`;
      const bi = await oauthBinding(user, { client });
      const i = (await install(bi, { host: 'test.tenant', tenant: tenant('A') })).supplemental.integration_id;
      const bj = await oauthBinding(user, { client });
      const j = (await install(bj, { host: 'test.tenant', tenant: tenant('B') })).supplemental.integration_id;
      // bj becomes J's HISTORICAL connection, still owned by J
      assert.equal((await install(await oauthBinding(user, { client }), { intent: 'rebind', target_integration_id: j, host: 'test.tenant' },
        'REBIND')).status, 'committed');
      const c0 = await business();
      for (const intent of ['REBIND', 'REAUTHORIZATION']) {
        const r = await install(bj, { intent: intent.toLowerCase(), target_integration_id: i, host: 'test.tenant' }, intent);
        assert.equal(r.error_code, 'binding_owned_by_other_integration', `${intent} ${JSON.stringify(r)}`);
      }
      assert.deepEqual(await business(), c0);
      assert.equal((await admin.query('select integration_id from clued_private.integration_binding_owners_v1 where binding_id = $1', [bj.id])).rows[0].integration_id, j);
    });

    await t.test('FORBIDS_REAUTH refuses a new connection at the bind site and at REBIND_TO_HOLDER (T-A11-20(c))', async () => {
      const user = await newUser();
      const client = `fr-${uid()}`;
      const b0 = await oauthBinding(user, { client });
      const id = (await install(b0, { host: 'test.complete' })).supplemental.integration_id;
      assert.ok((await integration(id)).first_authorized_at);
      // the recovery policy is set by fixture (its Operator write is PR-4)
      await admin.query(`update clued_private.integrations_v1 set recovery_policy = 'FORBIDS_REAUTH' where integration_id = $1`, [id]);
      const c0 = await business();
      const r = await install(await oauthBinding(user, { client }), { intent: 'rebind', target_integration_id: id, host: 'test.complete' }, 'REBIND');
      assert.equal(r.error_code, 'integration_recovery_forbidden');
      assert.deepEqual(await business(), c0);
      // the current connection itself (SELF) is not a new connection
      assert.equal((await install(b0, { intent: 'verification_repair', target_integration_id: id, host: 'test.complete' },
        'VERIFICATION_REPAIR')).status, 'committed');
      const p = await conflictPair();
      await admin.query(`update clued_private.integrations_v1 set recovery_policy = 'FORBIDS_REAUTH' where integration_id = $1`, [p.h]);
      const c1 = await business();
      const rr = await reconcile(p.user, p.i, p.h, 'REBIND_TO_HOLDER');
      assert.equal(rr.error_code, 'integration_recovery_forbidden');
      assert.deepEqual(await business(), c1);
      assert.equal(await currentBinding(p.h), p.bh.id);
      assert.equal(await currentBinding(p.i), p.bi.id);
    });

    await t.test('T-A11-17(a) / T-A11-15(d) reconcile refuses a revoked I either way, and REBIND_TO_HOLDER a revoked H', async () => {
      for (const [revoke, resolution] of [['i', 'REBIND_TO_HOLDER'], ['i', 'REPLACE_HOLDER'], ['h', 'REBIND_TO_HOLDER']]) {
        const p = await conflictPair();
        await revokeFixture(p[revoke]);
        const c0 = await business();
        const r = await reconcile(p.user, p.i, p.h, resolution);
        assert.equal(r.error_code, 'integration_revoked_requires_explicit_restore', `${revoke} ${resolution}`);
        assert.deepEqual(await business(), c0, `${revoke} ${resolution}: no business write`);
        assert.equal(await currentBinding(p.h), p.bh.id);
        assert.equal(await currentBinding(p.i), p.bi.id);
        assert.equal((await integration(p.h)).identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      }
    });

    await t.test('§6.5 a same-key write keeps PENDING_RECONCILE; only the Owner reconcile leaves it (MINOR-N27)', async () => {
      const p = await conflictPair();
      assert.equal((await rpc(admin, 'clued_integration_reconcile_request_v1', p.bi, { idempotency_key: key(), integration_id: p.i,
        base_version: (await integration(p.i)).version })).status, 'committed');
      const u = await rpc(admin, 'clued_integration_identity_update_v1', p.bi, { idempotency_key: key(), integration_id: p.i,
        base_version: (await integration(p.i)).version, tenant: tenant('P') });
      assert.equal(u.status, 'committed', JSON.stringify(u));
      assert.equal(u.supplemental.identity_claim_state, 'PENDING_RECONCILE');
      const row = await integration(p.i);
      assert.equal(row.identity_claim_state, 'PENDING_RECONCILE');
      assert.equal(row.conflicting_integration_id, p.h);
    });

    await t.test('T-A11-20(d) REBIND_TO_HOLDER clears H\'s reauth marks raised before b\'s grant and keeps later ones', async () => {
      const p = await conflictPair();
      const mark = async (raisedAt) => (await admin.query(`insert into clued_private.integration_reauth_marks_v1(integration_id, reason,
          raised_by, raised_receipt_id, raised_at) values ($1, 'PROVIDER_RECONFIRMATION', 'CLUED', gen_random_uuid(), $2) returning mark_id`,
      [p.h, raisedAt])).rows[0].mark_id;
      const early = await mark('2020-01-01T00:00:00Z');
      const late = await mark(new Date(Date.now() + 60_000).toISOString());
      const r = await reconcile(p.user, p.i, p.h, 'REBIND_TO_HOLDER');
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.deepEqual(r.supplemental.cleared_reauth_mark_ids, [early]);
      const rows = (await admin.query(`select mark_id, cleared_by, cleared_receipt_id from clued_private.integration_reauth_marks_v1
        where integration_id = $1`, [p.h])).rows;
      assert.deepEqual(rows.find((x) => x.mark_id === early), { mark_id: early, cleared_by: 'REAUTHORIZATION_REBIND', cleared_receipt_id: r.receipt_id });
      assert.equal(rows.find((x) => x.mark_id === late).cleared_by, null);
    });

    await t.test('request_open and create_or_bind refuse unregistered hosts, surfaces and unverified connection evidence', async () => {
      const user = await newUser();
      const b = await oauthBinding(user, { client: `reg-${uid()}` });
      const c0 = await business();
      assert.equal(await codeOf(open(b, { host: 'not.registered' })), 'host_not_registered');
      assert.equal(await codeOf(open(b, { host: 'test.complete', host_surface: 'nope' })), 'host_surface_not_registered');
      assert.deepEqual(await business(), c0);
      const opened = await open(b, { host: 'test.complete', provider_connection_id: sha('some-other-client') });
      if (opened.request_id) {
        const r = await bind(b, opened.request_id);
        assert.equal(r.error_code, 'identity_dimension_evidence_unverified', JSON.stringify(r));
      } else {
        assert.equal(opened.error_code ?? opened.status, 'identity_dimension_evidence_unverified');
      }
      // identity_update never accepts a provider connection id
      const installer = await oauthBinding(user, { client: `reg2-${uid()}` });
      const ok = await install(installer, { host: 'test.complete' });
      const id = ok.supplemental.integration_id;
      // The column holds the verifier, so the call presents the installing Binding's own proof.
      const cur = (await admin.query(`select b.id from clued_private.integration_connections_v1 c join public.clued_agent_bindings b
        on b.id = c.binding_id where c.integration_id = $1 and c.link_status = 'CURRENT'`, [id])).rows[0].id;
      assert.equal(cur, installer.id, 'the CURRENT connection is the installing Binding');
      const r = await rpc(admin, 'clued_integration_identity_update_v1', installer, { idempotency_key: key(), integration_id: id,
        base_version: (await integration(id)).version, provider_connection_id: sha('x') });
      assert.equal(r.error_code, 'invalid_identity_update');
    });

    await t.test('a request_key replays only for its own channel and Binding; account deletion cascades over Requests', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const requestKey = key('replay');
      const first = await open(b, { request_key: requestKey });
      assert.equal((await open(b, { request_key: requestKey })).request_id, first.request_id);
      assert.equal(await codeOf(open(await rawBinding(user), { request_key: requestKey })), 'installation_request_key_conflict');
      assert.equal(await codeOf(native(admin, user, { op: 'request_open', request_key: requestKey, intent: 'create_or_bind',
        host: 'test.complete', host_surface: 'default', provider: 'clued.binding.v1', adapter_family: 'test-adapter',
        adapter_version: '1.0.0', installation_phase: 'COMPLETED' })), 'installation_request_key_conflict');
      // §5.2 point 3: an account that only opened Requests can be deleted
      const gone = await newUser();
      await open(await rawBinding(gone), {});
      await admin.query('delete from auth.users where id = $1', [gone]);
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_installation_requests_v1 where owner_id = $1',
        [gone])).rows[0].n), 0);
    });

    await t.test('T-A10-9 / T-A7-9 a Claim Store divergence fails closed with one diagnostic and one Receipt', async () => {
      const user = await newUser();
      const b = await oauthBinding(user, { client: `div-${uid()}` });
      const id = (await install(b, { host: 'test.tenant', tenant: tenant('D') })).supplemental.integration_id;
      const asOf1 = '2026-10-05T01:00:00Z'; const asOf2 = '2026-10-05T01:05:00Z';
      const diverge = async (sql, params) => {
        await admin.query('begin');
        await admin.query(`set local session_replication_role = replica`);
        await admin.query(sql, params);
        await admin.query('commit');
      };
      // (1) KEY_MISMATCH → C4
      await diverge(`update clued_private.integration_claims_v1 set claim_key_sha256 = $2 where integration_id = $1 and claim_status = 'CURRENT'`, [id, sha('other')]);
      const e1 = await evaluate(id, asOf1);
      assert.equal(e1.valid, false);
      assert.deepEqual(e1.reason_codes, ['C4_CLAIM_STORE_MISSING']);
      assert.equal(e1.integration_state, null);
      assert.deepEqual(e1.effective_capabilities, []);
      const e2 = await evaluate(id, asOf2);
      assert.equal(e2.facts_sha256, e1.facts_sha256, 'as_of does not enter facts_sha256');
      assert.notEqual(e2.facts.as_of, e1.facts.as_of);
      const diag = (await admin.query(`select occurrences, receipt_id from clued_private.integration_derivation_diagnostics_v1
        where integration_id = $1 and facts_sha256 = $2`, [id, e1.facts_sha256])).rows;
      assert.equal(diag.length, 1);
      assert.equal(Number(diag[0].occurrences), 2);
      const receipts = (await admin.query(`select id, status from public.clued_audit_receipts where user_id = $1
        and operation_family = 'integration_derivation_invalid'`, [user])).rows;
      assert.deepEqual(receipts.map((r) => r.id), [diag[0].receipt_id]);
      assert.equal(receipts[0].status, 'committed');
      // (2) MISSING_CURRENT_ROW → C4; (3) a non-holder with a CURRENT row → C5
      await diverge(`update clued_private.integration_claims_v1 set claim_status = 'RELEASED', ended_at = now() where integration_id = $1 and claim_status = 'CURRENT'`, [id]);
      assert.deepEqual((await evaluate(id)).reason_codes, ['C4_CLAIM_STORE_MISSING']);
      await diverge(`update clued_private.integration_claims_v1 set claim_status = 'CURRENT', ended_at = null, claim_key_sha256 = (select claim_key_sha256 from clued_private.integrations_v1 where integration_id = $1)
        where claim_id = (select claim_id from clued_private.integration_claims_v1 where integration_id = $1 order by claimed_at desc limit 1)`, [id]);
      assert.equal((await evaluate(id)).valid, true, 'repaired');
      const other = await oauthBinding(user, { client: `div2-${uid()}` });
      const nh = (await install(other, { host: 'test.tenant' })).supplemental.integration_id;
      await diverge(`insert into clued_private.integration_claims_v1(owner_id, active_binding_domain, claim_key_sha256, claim_key_material,
        integration_id, claim_status, claimed_receipt_id) values ($1, 'clued.default.v1', $2, '{}', $3, 'CURRENT', gen_random_uuid())`, [user, sha('stray'), nh]);
      assert.deepEqual((await evaluate(nh)).reason_codes, ['C5_CLAIM_STORE_UNEXPECTED']);
      // the post-write validity gate: a repair that does not add a reason code may commit; the same writes in
      // normal mode are refused at commit by the deferred trigger (above, T-A10-6)
      const repair = await rpc(admin, 'clued_integration_identity_update_v1', other, { idempotency_key: key(), integration_id: nh,
        base_version: (await integration(nh)).version });
      assert.equal(repair.status, 'committed', JSON.stringify(repair));
      // two CURRENT rows for one Integration are excluded by the unique index: built in a disposable transaction
      await admin.query('begin');
      try {
        await admin.query('drop index clued_private.integration_claims_v1_one_current_per_integration');
        await admin.query('set local session_replication_role = replica');
        await admin.query(`insert into clued_private.integration_claims_v1(owner_id, active_binding_domain, claim_key_sha256, claim_key_material,
          integration_id, claim_status, claimed_receipt_id) values ($1, 'clued.default.v1', $2, '{}', $3, 'CURRENT', gen_random_uuid())`, [user, sha('second'), id]);
        assert.deepEqual((await evaluate(id)).reason_codes, ['C4_CLAIM_STORE_MISSING']);
      } finally {
        await admin.query('rollback');
      }
    });

    await t.test('T-A10-11 no Binding can take over another connection\'s Integration', async () => {
      const user = await newUser();
      const b1 = await oauthBinding(user, { client: 'C1' });
      const claude = (await install(b1, { host: 'anthropic.claude', host_surface: 'claude_code' })).supplemental.integration_id;
      const b2 = await oauthBinding(user, { client: 'C2', scopes: ['context:read'] });
      const intents = ['REBIND', 'RECOVERY', 'ADAPTER_MIGRATION', 'REAUTHORIZATION', 'REINSTALL', 'VERIFICATION_REPAIR', 'BIND_CONNECTION'];
      const c0 = await counts();
      for (const intent of intents) {
        // (a) another host → host mismatch; the same host, another client → Owner confirmation
        const x = await install(b2, { intent: intent.toLowerCase(), target_integration_id: claude, host: 'openai.chatgpt', host_surface: 'web' }, intent);
        assert.equal(x.error_code, 'integration_host_mismatch', `${intent} ${JSON.stringify(x)}`);
        const y = await install(b2, { intent: intent.toLowerCase(), target_integration_id: claude, host: 'anthropic.claude', host_surface: 'chat' }, intent);
        assert.equal(y.error_code, 'integration_rebind_requires_owner_confirmation', intent);
      }
      assert.equal(await currentBinding(claude), b1.id);
      const c1 = await counts();
      assert.deepEqual({ ...c1, receipts: c0.receipts, requests: c0.requests }, c0, 'no business write');
      // (b) another client C3 → confirmation; (c) the same client C1 → SAME_PROVIDER_CONNECTION
      const b3 = await oauthBinding(user, { client: 'C3' });
      const r3 = await open(b3, { intent: 'rebind', target_integration_id: claude, host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal((await bind(b3, r3.request_id, 'REBIND')).error_code, 'integration_rebind_requires_owner_confirmation');
      const b1b = await oauthBinding(user, { client: 'C1' });
      const same = await install(b1b, { intent: 'reauthorization', target_integration_id: claude, host: 'anthropic.claude', host_surface: 'chat' }, 'REAUTHORIZATION');
      assert.equal(same.status, 'committed', JSON.stringify(same));
      assert.equal(same.supplemental.link_authority, 'SAME_PROVIDER_CONNECTION');
      assert.equal(await currentBinding(claude), b1b.id);
      // (d) clued.binding.v1: another raw Binding needs confirmation
      const raw1 = await rawBinding(user);
      const rawI = (await install(raw1, { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.integration_id;
      const raw2 = await rawBinding(user);
      assert.equal((await install(raw2, { intent: 'rebind', target_integration_id: rawI, host: 'anthropic.claude', host_surface: 'chat' }, 'REBIND')).error_code,
        'integration_rebind_requires_owner_confirmation');
      // (e) the Owner confirms B3 (NATIVE_OWNER_CONFIRMED); B3 replaying the same Request returns the same id; another Binding cannot
      const confirmed = await native(admin, user, { op: 'confirm_rebind', idempotency_key: key(), request_id: r3.request_id,
        binding_id: b3.id, base_version: (await integration(claude)).version });
      assert.equal(confirmed.status, 'committed', JSON.stringify(confirmed));
      assert.equal(confirmed.supplemental.link_authority, 'NATIVE_OWNER_CONFIRMED');
      assert.equal(await currentBinding(claude), b3.id);
      const replay = await bind(b3, r3.request_id, 'REBIND');
      assert.equal(replay.supplemental.integration_id, claude);
      assert.equal((await bind(b1b, r3.request_id, 'REBIND')).error_code, 'installation_request_bound_to_other_integration');
      // confirm_rebind needs the Owner's base_version
      const r4 = await open(b2, { intent: 'rebind', target_integration_id: claude, host: 'anthropic.claude', host_surface: 'chat' });
      const stale = await native(admin, user, { op: 'confirm_rebind', idempotency_key: key(), request_id: r4.request_id, binding_id: b2.id, base_version: 1 });
      assert.equal(stale.error_code, 'integration_version_conflict');
      // (f) R = ∅: a Native bind_connection Request may be consumed (NATIVE_BIND_REQUEST); a Binding's own one may not
      const nat = await native(admin, user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host: 'anthropic.claude',
        host_surface: 'chat', provider: 'clued.oauth.v12', adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED' });
      const empty = await native(admin, user, { op: 'create_or_bind', idempotency_key: key(), request_id: nat.request_id, binding_intent: 'CREATE_OR_BIND' });
      assert.equal(empty.status, 'committed', JSON.stringify(empty));
      const t0 = empty.supplemental.integration_id;
      const b5 = await oauthBinding(user, { client: 'C5' });
      const own = await install(b5, { intent: 'bind_connection', target_integration_id: t0, host: 'anthropic.claude', host_surface: 'chat' }, 'BIND_CONNECTION');
      assert.equal(own.error_code, 'integration_rebind_requires_owner_confirmation');
      // (g) a pinned Native Request: the wrong client is refused, the pinned one succeeds
      const pinned = await native(admin, user, { op: 'request_open', request_key: key('pinned'), intent: 'bind_connection', target_integration_id: t0,
        host: 'anthropic.claude', host_surface: 'chat', adapter_family: 'test-adapter', adapter_version: '1.0.0',
        expected_provider_connection_id: sha('C1') });
      assert.equal((await bind(b5, pinned.request_id, 'BIND_CONNECTION')).error_code, 'integration_rebind_requires_owner_confirmation');
      const b1c = await oauthBinding(user, { client: 'C1' });
      const pinOk = await bind(b1c, pinned.request_id, 'BIND_CONNECTION');
      assert.equal(pinOk.status, 'committed', JSON.stringify(pinOk));
      assert.equal(pinOk.supplemental.link_authority, 'NATIVE_BIND_REQUEST');
      // an unpinned Native Request id never appears in a Binding-channel response
      const unpinned = await native(admin, user, { op: 'request_open', request_key: key('unpinned'), intent: 'bind_connection', target_integration_id: t0,
        host: 'anthropic.claude', host_surface: 'chat', adapter_family: 'test-adapter', adapter_version: '1.0.0' });
      const view = JSON.stringify(await rpc(admin, 'clued_integration_status_v1', b1c, {}));
      assert.equal(view.includes(unpinned.request_id), false);
      assert.equal(view.includes(nat.request_id), false);
      // a Binding cannot pin (expected_provider_connection_id is Native-only)
      await expectCode(open(b5, { intent: 'bind_connection', target_integration_id: t0, host: 'anthropic.claude', host_surface: 'chat',
        expected_provider_connection_id: sha('C5') }), 'invalid_expected_provider_connection_id');
    });

    await t.test('T-A10-12 a conflict cannot be left by changing identity', async () => {
      const { bi, i } = await conflictPair();
      const before = await integration(i);
      for (const intent of ['REBIND', 'ADAPTER_MIGRATION']) {
        const down = await install(bi, { intent: intent.toLowerCase(), target_integration_id: i, host: 'test.tenant',
          tenant: { status: 'UNAVAILABLE' } }, intent);
        assert.equal(down.error_code, 'integration_claim_blocked', `${intent} ${JSON.stringify(down)}`);
      }
      const rekey = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: before.version, tenant: tenant('elsewhere') });
      assert.equal(rekey.error_code, 'integration_claim_blocked');
      const down = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: before.version, tenant: { status: 'UNAVAILABLE' } });
      assert.equal(down.error_code, 'identity_dimension_downgrade_forbidden');
      // other REBIND_CLASS intents may never downgrade
      const reauth = await install(bi, { intent: 'reauthorization', target_integration_id: i, host: 'test.tenant',
        tenant: { status: 'UNAVAILABLE' } }, 'REAUTHORIZATION');
      assert.equal(reauth.error_code, 'identity_dimension_downgrade_forbidden');
      await rpc(admin, 'clued_integration_reconcile_request_v1', bi, { idempotency_key: key(), integration_id: i, base_version: before.version });
      const pending = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: (await integration(i)).version, tenant: tenant('elsewhere') });
      assert.equal(pending.error_code, 'integration_claim_blocked');
      const after = await integration(i);
      assert.equal(after.conflicting_integration_id, before.conflicting_integration_id);
      const e = await evaluate(i);
      assert.equal(e.integration_state, 'BLOCKED');
      assert.deepEqual(e.effective_capabilities, []);
      assert.equal(e.facts.policy.incomplete_identity_ordinary_runtime, 'PERMIT');
    });

    await t.test('T-A10-14 explicit Binding ownership', async () => {
      const user = await newUser();
      const ownerOf = async (binding) => (await admin.query('select integration_id, acquired_via, version from clued_private.integration_binding_owners_v1 where binding_id = $1',
        [binding])).rows[0] ?? null;
      // (a) a first link creates the owner row (FIRST_LINK) and a log row; a rebind keeps the old Binding's owner
      const b0 = await oauthBinding(user, { client: 'own' });
      const i = (await install(b0, { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.integration_id;
      assert.deepEqual(await ownerOf(b0.id), { integration_id: i, acquired_via: 'FIRST_LINK', version: '1' });
      const log = (await admin.query('select from_integration_id, to_integration_id, acquired_via, actor_kind from clued_private.integration_binding_ownership_log_v1 where binding_id = $1', [b0.id])).rows;
      assert.deepEqual(log, [{ from_integration_id: null, to_integration_id: i, acquired_via: 'FIRST_LINK', actor_kind: 'binding' }]);
      const b1 = await oauthBinding(user, { client: 'own' });
      assert.equal((await install(b1, { intent: 'rebind', target_integration_id: i, host: 'anthropic.claude', host_surface: 'chat' }, 'REBIND')).status, 'committed');
      assert.equal((await admin.query(`select link_status from clued_private.integration_connections_v1 where binding_id = $1`, [b0.id])).rows[0].link_status, 'HISTORICAL');
      assert.equal((await ownerOf(b0.id)).integration_id, i);
      // (b) a Binding owned by I cannot fork J through the Binding channel, nor bind elsewhere
      const fork = await install(b0, { host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal(fork.error_code, 'binding_owned_by_other_integration');
      const j = (await install(await oauthBinding(user, { client: 'jclient' }), { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.integration_id;
      assert.equal((await install(b0, { intent: 'rebind', target_integration_id: j, host: 'anthropic.claude', host_surface: 'chat' }, 'REBIND')).error_code,
        'integration_rebind_requires_owner_confirmation');
      // b0 back to I is allowed (owned by I, same client; SELF is only the reference connection itself)
      assert.equal((await install(b0, { intent: 'rebind', target_integration_id: i, host: 'anthropic.claude', host_surface: 'chat' }, 'REBIND')).supplemental.link_authority, 'SAME_PROVIDER_CONNECTION');
      assert.equal((await install(b0, { intent: 'verification_repair', target_integration_id: i, host: 'anthropic.claude', host_surface: 'chat' }, 'VERIFICATION_REPAIR')).supplemental.link_authority, 'SELF');
      // (c) the Owner confirms I's HISTORICAL b1 onto J → ownership moves I → J, recorded
      const rq = await open(b1, { intent: 'rebind', target_integration_id: j, host: 'anthropic.claude', host_surface: 'chat' });
      const moved = await native(admin, user, { op: 'confirm_rebind', idempotency_key: key(), request_id: rq.request_id, binding_id: b1.id,
        base_version: (await integration(j)).version });
      assert.equal(moved.status, 'committed', JSON.stringify(moved));
      assert.deepEqual(moved.supplemental.ownership_transfer, { binding_id: b1.id, from_integration_id: i, to_integration_id: j, acquired_via: 'NATIVE_OWNER_CONFIRMED' });
      assert.ok(moved.target_refs.some((ref) => ref.role === 'ownership_source' && ref.id === i));
      assert.deepEqual(await ownerOf(b1.id), { integration_id: j, acquired_via: 'NATIVE_OWNER_CONFIRMED', version: '2' });
      // (d) the same for I's CURRENT connection is refused
      const rq2 = await open(b0, { intent: 'rebind', target_integration_id: j, host: 'anthropic.claude', host_surface: 'chat' });
      const refused = await native(admin, user, { op: 'confirm_rebind', idempotency_key: key(), request_id: rq2.request_id, binding_id: b0.id,
        base_version: (await integration(j)).version });
      assert.equal(refused.error_code, 'binding_owned_by_other_integration');
      // (f) static: only integration_take_ownership_v1 writes the owner table
      const writers = (await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('clued_private','public') and p.prokind = 'f'
          and pg_get_functiondef(p.oid) ~* '(insert into|update) clued_private\\.integration_binding_owners_v1'`)).rows.map((r) => r.proname);
      assert.deepEqual(writers, ['integration_take_ownership_v1']);
      // (g) first ownership by path: confirm_rebind of an unowned Binding, adopt_binding
      const b9 = await oauthBinding(user, { client: 'own' });
      const rq3 = await open(b9, { intent: 'rebind', target_integration_id: i, host: 'anthropic.claude', host_surface: 'chat' });
      const conf = await native(admin, user, { op: 'confirm_rebind', idempotency_key: key(), request_id: rq3.request_id, binding_id: b9.id,
        base_version: (await integration(i)).version });
      assert.equal(conf.status, 'committed', JSON.stringify(conf));
      assert.equal((await ownerOf(b9.id)).acquired_via, 'NATIVE_OWNER_CONFIRMED');
      const ba = await rawBinding(user);
      const adopted = await native(admin, user, { op: 'adopt_binding', idempotency_key: key(), binding_id: ba.id, host: 'generic.mcp',
        host_surface: 'default', adapter_family: 'legacy', adapter_version: '0.1', installation_phase: 'COMPLETED' });
      assert.equal(adopted.status, 'committed', JSON.stringify(adopted));
      assert.equal(adopted.supplemental.link_authority, 'NATIVE_ADOPT');
      assert.equal((await ownerOf(ba.id)).acquired_via, 'NATIVE_ADOPT');
      assert.equal((await admin.query('select from_integration_id from clued_private.integration_binding_ownership_log_v1 where binding_id = $1', [ba.id])).rows[0].from_integration_id, null);
    });

    await t.test('T-A9-3 the Native path up to the PR-3 boundary; provider mismatch', async () => {
      const user = await newUser();
      const nat = await native(admin, user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host: 'test.complete',
        host_surface: 'default', provider: 'clued.oauth.v12', adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'STARTED' });
      const created = await native(admin, user, { op: 'create_or_bind', idempotency_key: key(), request_id: nat.request_id, binding_intent: 'CREATE_OR_BIND' });
      const id = created.supplemental.integration_id;
      const row = await integration(id);
      assert.equal(row.connection_status, 'UNAVAILABLE');
      assert.equal(row.identity_claim_state, 'INCOMPLETE_UNCLAIMED');
      assert.equal((await evaluate(id)).integration_state, 'INSTALL_PENDING');
      // installation_completed is PR-4's lifecycle op; a COMPLETED Native Integration with no connection is AUTH_PENDING
      const nat2 = await native(admin, user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host: 'test.complete',
        host_surface: 'default', provider: 'clued.oauth.v12', adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED' });
      const id2 = (await native(admin, user, { op: 'create_or_bind', idempotency_key: key(), request_id: nat2.request_id, binding_intent: 'CREATE_OR_BIND' })).supplemental.integration_id;
      assert.equal((await evaluate(id2)).integration_state, 'AUTH_PENDING');
      const bindReq = await native(admin, user, { op: 'request_open', request_key: key('bind'), intent: 'bind_connection', target_integration_id: id2,
        host: 'test.complete', host_surface: 'default', adapter_family: 'test-adapter', adapter_version: '1.0.0' });
      // a clued.binding.v1 Binding cannot complete a clued.oauth.v12 Integration
      const raw = await rawBinding(user);
      assert.equal((await bind(raw, bindReq.request_id, 'BIND_CONNECTION')).error_code, 'integration_provider_mismatch');
      const ob = await oauthBinding(user, { client: 'native-client' });
      const linked = await bind(ob, bindReq.request_id, 'BIND_CONNECTION');
      assert.equal(linked.status, 'committed', JSON.stringify(linked));
      assert.equal(linked.supplemental.link_authority, 'NATIVE_BIND_REQUEST');
      assert.equal(linked.supplemental.identity_claim_state, 'CURRENT_CLAIM_HOLDER', 'late strengthening re-claims in the same transaction');
      assert.equal((await evaluate(id2)).integration_state, 'VERIFYING');
      // test.noauth: no first authorization → INSTALLED without a connection
      const nat3 = await native(admin, user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host: 'test.noauth',
        host_surface: 'default', provider: 'clued.oauth.v12', adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED' });
      const id3 = (await native(admin, user, { op: 'create_or_bind', idempotency_key: key(), request_id: nat3.request_id, binding_intent: 'CREATE_OR_BIND' })).supplemental.integration_id;
      assert.equal((await evaluate(id3)).integration_state, 'INSTALLED');
      // the provider is required on a Native create_or_bind Request
      await expectCode(native(admin, user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host: 'test.complete',
        host_surface: 'default', adapter_family: 'test-adapter', adapter_version: '1.0.0' }), 'provider_not_registered');
    });

    await t.test('§10.1 a derived connection revoke is materialized by the next successful write; rebind is refused', async () => {
      const user = await newUser();
      const b = await oauthBinding(user, { client: `mat-${uid()}` });
      const id = (await install(b, { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.integration_id;
      // the Owner revokes the connection in Clued's connection page (manage_v12 revoke)
      await admin.query('begin');
      await admin.query('set local role authenticated');
      await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      await admin.query(`select public.clued_authorization_manage_v12($1::jsonb)`, [JSON.stringify({ op: 'revoke', binding_id: b.id, base_version: 1 })]);
      await admin.query('commit');
      const e = await evaluate(id);
      assert.equal(e.integration_state, 'REVOKED');
      assert.equal(e.facts.revocation_source, 'CONNECTION_USER_REVOKE');
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_revocations_v1 where integration_id = $1', [id])).rows[0].n), 0,
        'a read never materializes');
      // a same-client re-consent cannot rebind it (G-A11)
      const fresh = await oauthBinding(user, { client: b.client });
      const reb = await install(fresh, { intent: 'reauthorization', target_integration_id: id, host: 'anthropic.claude', host_surface: 'chat' }, 'REAUTHORIZATION');
      assert.equal(reb.error_code, 'integration_revoked_requires_explicit_restore');
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_revocations_v1 where integration_id = $1', [id])).rows[0].n), 0,
        'a rejected write leaves no materialized row');
      // a successful Native identity_update materializes exactly one row from the adopted revoke
      const upd = await native(admin, user, { op: 'identity_update', idempotency_key: key(), integration_id: id, base_version: (await integration(id)).version });
      assert.equal(upd.status, 'committed', JSON.stringify(upd));
      assert.ok(upd.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
      const row = (await admin.query('select * from clued_private.integration_revocations_v1 where integration_id = $1', [id])).rows[0];
      assert.equal(row.revocation_source, 'CONNECTION_REVOKE_ADOPTED');
      assert.equal(row.revoked_by, 'USER');
      assert.equal(row.adopted_from.audit_operation, 'revoke');
      assert.deepEqual(row.revoked_binding_ids, [b.id]);
      assert.ok(upd.target_refs.some((ref) => ref.role === 'revocation' && ref.id === row.revocation_id));
      const audit = (await admin.query(`select recorded_at from clued_private.authorization_audit_v12 where binding_id = $1 and operation = 'revoke'`, [b.id])).rows[0];
      assert.equal(new Date(row.revoked_at).getTime(), new Date(audit.recorded_at).getTime(), 'revoked_at is the connection revoke time');
      assert.equal((await evaluate(id)).facts.revocation_source, 'INTEGRATION');
      // the row is immutable except for the two §5.9 updates
      await expectCode(admin.query(`update clued_private.integration_revocations_v1 set reason = 'x' where revocation_id = $1`, [row.revocation_id]),
        'integration_revocation_immutable');
      await expectCode(admin.query(`delete from clued_private.integration_revocations_v1 where revocation_id = $1`, [row.revocation_id]),
        'integration_revocation_immutable');
    });

    await t.test('§5.5 O7 a grant issued before a revocation cannot link or create; a later one can', async () => {
      const user = await newUser();
      const client = `o7-${uid()}`;
      const b = await oauthBinding(user, { client });
      const pre = await oauthBinding(user, { client, createdAt: new Date(Date.now() - 60_000).toISOString() });
      const id = (await install(b, { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.integration_id;
      await admin.query(`update public.clued_agent_bindings set revoked_at = now() where id = $1`, [b.id]);   // unattributable revoke
      assert.equal((await evaluate(id)).integration_state, 'REVOKED');
      const c0 = await counts();
      const blocked = await install(pre, { host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal(blocked.error_code, 'binding_predates_revocation');
      assert.equal((await counts()).integrations, c0.integrations);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = await oauthBinding(user, { client });
      const created = await install(after, { host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal(created.supplemental.outcome, 'CREATE', JSON.stringify(created));
      assert.notEqual(created.supplemental.integration_id, id);
      // a raw Binding is never in any lineage
      assert.equal((await install(await rawBinding(user), { host: 'anthropic.claude', host_surface: 'chat' })).status, 'committed');
    });

    await t.test('§10.3 the authorization ceiling: covers, C_eff after a reduce, fresh consent', async () => {
      const user = await newUser();
      const client = `ceil-${uid()}`;
      const old = await oauthBinding(user, { client, createdAt: new Date(Date.now() - 120_000).toISOString() });
      const b1 = await oauthBinding(user, { client });
      const id = (await install(b1, { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.integration_id;
      const ceiling = (await integration(id)).authorization_ceiling;
      assert.deepEqual(ceiling, { scopes: ['context:read', 'context:write'], entries: [{ resource_kind: 'scope', resource_id: 'global',
        environment: 'canonical', actions: ['read', 'write'] }] });
      // the Owner reduces b1 to read while it is the CURRENT connection
      await admin.query('begin');
      await admin.query('set local role authenticated');
      await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      await admin.query(`select public.clued_authorization_manage_v12($1::jsonb)`, [JSON.stringify({ op: 'reduce', binding_id: b1.id, base_version: 1,
        selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] })]);
      await admin.query('commit');
      // an older, wider same-client Binding is refused; a narrower new one is accepted and lands C_eff
      const wide = await install(old, { intent: 'reauthorization', target_integration_id: id, host: 'anthropic.claude', host_surface: 'chat' }, 'REAUTHORIZATION');
      assert.equal(wide.error_code, 'reauthorization_scope_expansion_forbidden');
      const narrow = await oauthBinding(user, { client, scopes: ['context:read'],
        entries: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] });
      const ok = await install(narrow, { intent: 'reauthorization', target_integration_id: id, host: 'anthropic.claude', host_surface: 'chat' }, 'REAUTHORIZATION');
      assert.equal(ok.status, 'committed', JSON.stringify(ok));
      const row = await integration(id);
      assert.deepEqual(row.authorization_ceiling.entries[0].actions, ['read']);
      const reduce = (await admin.query(`select recorded_at from clued_private.authorization_audit_v12 where binding_id = $1 and operation = 'reduce'`, [b1.id])).rows[0];
      assert.equal(new Date(row.authorization_ceiling_set_at).getTime(), new Date(reduce.recorded_at).getTime());
      // a fresh consent (created after the ceiling) may expand it, recorded
      await new Promise((resolve) => setTimeout(resolve, 20));
      const consent = await oauthBinding(user, { client });
      const expanded = await install(consent, { intent: 'reauthorization', target_integration_id: id, host: 'anthropic.claude', host_surface: 'chat' }, 'REAUTHORIZATION');
      assert.equal(expanded.status, 'committed', JSON.stringify(expanded));
      assert.deepEqual(expanded.supplemental.outcome_flags, ['AUTHORITY_EXPANDED_BY_CONSENT']);
      assert.deepEqual(expanded.supplemental.ceiling_after.entries[0].actions, ['read', 'write']);
      // a raw Binding (LEGACY_UNRESTRICTED) is never covered by finite entries
      const covers = (await admin.query(`select clued_private.integration_covers_v1($1::jsonb, '{"scopes":["context:read"],"entries":"LEGACY_UNRESTRICTED"}'::jsonb) c`,
        [JSON.stringify((await integration(id)).authorization_ceiling)])).rows[0].c;
      assert.equal(covers, false);
    });

    await t.test('ERRATA-004 a ceiling project:* covers the project:<id> entries it materializes', async () => {
      const covers = async (c, a) => (await admin.query('select clued_private.integration_covers_v1($1::jsonb, $2::jsonb) c',
        [JSON.stringify(c), JSON.stringify(a)])).rows[0].c;
      const entry = (resourceId, actions, environment = 'canonical') => ({ resource_kind: 'scope', resource_id: resourceId, environment, actions });
      const shape = (...entries) => ({ scopes: ['context:read', 'context:write'], entries });
      const [u1, u2] = [uid(), uid()];
      const wild = shape(entry('project:*', ['read', 'write']), entry(`project:${u1}`, ['read', 'write']));
      assert.equal(await covers(wild, shape(entry(`project:${u2}`, ['read']))), true, 'a later project under project:*');
      assert.equal(await covers(wild, shape(entry(`project:${u2}`, ['read', 'write']), entry('project:*', ['read']))), true);
      assert.equal(await covers(shape(entry('project:*', ['read'])), shape(entry(`project:${u2}`, ['read', 'write']))), false, 'actions beyond project:*');
      assert.equal(await covers(wild, shape(entry(`project:${u2}`, ['read'], 'other'))), false, 'another environment');
      assert.equal(await covers(wild, shape(entry('project:not-a-uuid', ['read']))), false, 'not a project id');
      assert.equal(await covers(wild, shape(entry('global', ['read']))), false, 'project:* is not global');
      assert.equal(await covers(wild, shape(entry(`project:${u2}`.toUpperCase().replace('PROJECT:', 'project:'), ['read']))), false,
        'not the canonical lowercase id');
      assert.equal(await covers(wild, shape({ resource_kind: 'context', resource_id: `project:${u2}`, environment: 'canonical', actions: ['read'] })),
        false, 'project:* covers scope entries only');
      assert.equal(await covers(shape(entry(`project:${u1}`, ['read', 'write'])), shape(entry(`project:${u2}`, ['read']))), false,
        'without project:* a new project is an expansion');
      const inter = (await admin.query('select clued_private.integration_ceiling_intersect_v1($1::jsonb, $2::jsonb) i',
        [JSON.stringify(shape(entry('project:*', ['read', 'write']), entry(`project:${u1}`, ['read']))),
          JSON.stringify(shape(entry(`project:${u1}`, ['read', 'write']), entry(`project:${u2}`, ['write']), entry('global', ['read'])))])).rows[0].i;
      assert.deepEqual(inter.entries, [entry(`project:${u1}`, ['read', 'write']), entry(`project:${u2}`, ['write'])].sort(
        (a, b) => (a.resource_id < b.resource_id ? -1 : 1)));
      // the rule is symmetric: the same result with project:* only on the right
      const flipped = (await admin.query('select clued_private.integration_ceiling_intersect_v1($1::jsonb, $2::jsonb) i',
        [JSON.stringify(shape(entry(`project:${u1}`, ['read', 'write']), entry(`project:${u2}`, ['write']), entry('global', ['read']))),
          JSON.stringify(shape(entry('project:*', ['read', 'write']), entry(`project:${u1}`, ['read'])))])).rows[0].i;
      assert.deepEqual(flipped, inter);
      // end to end: an Integration whose connection holds project:*, then the Owner creates a project
      const user = await newUser();
      const project = async () => {
        const id = uid();
        await withOwnerWriter(user, () => admin.query('insert into public.clued_projects(id, user_id, name, normalized_name, context_key) values ($1, $2, $3, $3, $4)',
          [id, user, `p-${id.slice(0, 8)}`, `project:${id}`]));
        return id;
      };
      const p1 = await project();
      const b = await oauthBinding(user, { client: `wild-${uid()}`, entries: [entry('project:*', ['read', 'write'])] });
      const entriesOf = async (bindingId) => (await admin.query(`select resource_id from clued_private.authorization_entries_v12
        where binding_id = $1 order by resource_id`, [bindingId])).rows.map((r) => r.resource_id);
      assert.deepEqual(await entriesOf(b.id), [`project:${p1}`, 'project:*'].sort());
      const id = (await install(b, { host: 'test.complete' })).supplemental.integration_id;
      assert.ok((await integration(id)).authorization_ceiling.entries.some((e) => e.resource_id === 'project:*'));
      const p2 = await project();
      assert.ok((await entriesOf(b.id)).includes(`project:${p2}`), 'migration 20261004210000 materialized the new project');
      const repaired = await install(b, { intent: 'verification_repair', target_integration_id: id, host: 'test.complete' }, 'VERIFICATION_REPAIR');
      assert.equal(repaired.status, 'committed', JSON.stringify(repaired));
      assert.equal(repaired.supplemental.link_authority, 'SELF');
      // a connection granted one named project gains another without project:* → still an expansion
      const narrow = await oauthBinding(user, { client: `named-${uid()}`, entries: [entry(`project:${p1}`, ['read', 'write'])] });
      const id2 = (await install(narrow, { host: 'test.complete' })).supplemental.integration_id;
      await admin.query(`insert into clued_private.authorization_entries_v12(binding_id, resource_kind, resource_id, environment, actions)
        values ($1, 'scope', $2, 'canonical', '{read}')`, [narrow.id, `project:${p2}`]);
      const refused = await install(narrow, { intent: 'verification_repair', target_integration_id: id2, host: 'test.complete' }, 'VERIFICATION_REPAIR');
      assert.equal(refused.error_code, 'reauthorization_scope_expansion_forbidden');
    });

    await t.test('T-A9-11 adoption is explicit, one Binding at a time; P5 Bindings are not adoptable', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const inv0 = await native(admin, user, { op: 'binding_inventory' });
      assert.deepEqual(inv0.bindings.map((x) => x.binding_id), [b.id]);
      const adopted = await native(admin, user, { op: 'adopt_binding', idempotency_key: key(), binding_id: b.id, host: 'generic.mcp',
        host_surface: 'default', adapter_family: 'legacy', adapter_version: '0.1', installation_phase: 'COMPLETED' });
      assert.equal(adopted.status, 'committed', JSON.stringify(adopted));
      assert.equal((await admin.query(`select operation_family from public.clued_audit_receipts where id = $1`, [adopted.receipt_id])).rows[0].operation_family,
        'integration_adopt_binding');
      assert.deepEqual((await native(admin, user, { op: 'binding_inventory' })).bindings, []);
      const org = (await admin.query(`insert into public.clued_organizations(tenant_key, name) values ($1, 'Org') returning id`, [`org-${uid().slice(0, 8)}`])).rows[0].id;
      const ws = (await admin.query(`insert into public.clued_workspaces(organization_id, workspace_key, name) values ($1, 'ws-main', 'WS') returning id`, [org])).rows[0].id;
      const p5 = await rawBinding(user, { organization: org, workspace: ws });
      assert.deepEqual((await native(admin, user, { op: 'binding_inventory' })).bindings, [], 'P5 Bindings are not listed');
      const refused = await native(admin, user, { op: 'adopt_binding', idempotency_key: key(), binding_id: p5.id, host: 'generic.mcp',
        host_surface: 'default', adapter_family: 'legacy', adapter_version: '0.1' });
      assert.equal(refused.error_code, 'binding_not_adoptable');
      await expectCode(open(p5, {}), 'binding_not_adoptable');
      // someone else's Binding is not the Owner's to adopt (403, no Receipt)
      const stranger = await rawBinding(await newUser());
      await expectCode(native(admin, user, { op: 'adopt_binding', idempotency_key: key(), binding_id: stranger.id, host: 'generic.mcp',
        host_surface: 'default', adapter_family: 'legacy', adapter_version: '0.1' }), 'binding_not_owned');
      // a Binding without an Integration reports NOT_ADOPTED
      assert.deepEqual(await rpc(admin, 'clued_integration_status_v1', await rawBinding(user), {}), { integration: null, reason: 'NOT_ADOPTED' });
      // the pre-migration Bindings are still unadopted and untouched
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_binding_owners_v1 where binding_id in ($1, $2)',
        [preRaw.id, preOauth.id])).rows[0].n), 0);
    });

    await t.test('T-A10-10 create_or_bind writes the Integration and the Request binding in one transaction', async () => {
      const user = await newUser();
      const b = await rawBinding(user);
      const r = await open(b, { host: 'anthropic.claude', host_surface: 'chat' });
      await admin.query(`create function pg_temp.fail_link() returns trigger language plpgsql as $$ begin raise exception 'injected_failure'; end $$;`);
      await admin.query(`create trigger zz_fail_link before insert on clued_private.integration_connections_v1 for each row
        when (new.binding_id = '${b.id}') execute function pg_temp.fail_link()`);
      try {
        const failed = await bind(b, r.request_id);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error_code, 'injected_failure');
      } finally {
        await admin.query('drop trigger zz_fail_link on clued_private.integration_connections_v1');
      }
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integrations_v1 where owner_id = $1', [user])).rows[0].n), 0);
      assert.equal((await admin.query('select request_status from clued_private.integration_installation_requests_v1 where request_id = $1', [r.request_id])).rows[0].request_status, 'OPEN');
      assert.equal((await bind(b, r.request_id)).status, 'committed');
    });

    await t.test('T-A3-1 / T-A3-3 DB: an empty candidate is never operable; each reachable state has an empty effective set', async () => {
      const user = await newUser();
      // OAuth scopes outside the three v12 scopes only → no scope capability → B8
      const noScope = await rawBinding(user, { scopes: ['canonical:read'] });
      const a = (await install(noScope, { host: 'test.complete' })).supplemental.integration_id;
      const ea = await evaluate(a);
      assert.deepEqual(ea.candidate_ordinary_capabilities, []);
      assert.equal(ea.integration_state, 'BLOCKED');
      assert.ok(ea.predicates.blocking.includes('B8_candidate_empty'));
      assert.deepEqual(ea.sources_read.dropped_scopes, ['canonical:read']);
      // v12 entries without a mapped action → ENTRIES with no capability
      const feedback = await oauthBinding(user, { client: `fb-${uid()}`, entries: [{ resource_kind: 'scope', resource_id: 'global',
        environment: 'canonical', actions: ['feedback_submit'] }] });
      const f = (await install(feedback, { host: 'test.complete' })).supplemental.integration_id;
      assert.deepEqual((await evaluate(f)).candidate_ordinary_capabilities, []);
      assert.equal((await evaluate(f)).integration_state, 'BLOCKED');
      // qualification SUSPENDED and host HARD_UNAVAILABLE (fact rows written by the fixture; fact_set is PR-3)
      for (const [klass, value] of [['qualification_state', 'SUSPENDED'], ['host_state', 'HARD_UNAVAILABLE']]) {
        const id = (await install(await rawBinding(user), { host: 'test.complete' })).supplemental.integration_id;
        await admin.query(`insert into clued_private.integration_facts_v1(integration_id, truth_class, source, value, fact_status, receipt_id)
          values ($1, $2, 'operator', $3, 'CURRENT', gen_random_uuid())`, [id, klass, value]);
        const e = await evaluate(id);
        assert.deepEqual(e.candidate_ordinary_capabilities, [], klass);
        assert.equal(e.integration_operable, false);
        assert.equal(e.integration_state, 'BLOCKED', klass);
      }
      // every state reached through RPCs in this build has Operable = false and an empty effective set
      const seen = new Set((await admin.query(`select integration_id from clued_private.integrations_v1`)).rows.map((r) => r.integration_id));
      const states = new Set();
      for (const id of seen) {
        const e = await evaluate(id);
        if (!e.valid) continue;
        states.add(e.integration_state);
        assert.equal(e.integration_operable, false, `${id} ${e.integration_state}`);
        assert.deepEqual(e.effective_capabilities, []);
      }
      // AUTH_PENDING is reached in T-A9-3 (that Integration then moves on to VERIFYING)
      for (const state of ['INSTALL_PENDING', 'INSTALLED', 'VERIFYING', 'BLOCKED', 'REVOKED']) {
        assert.ok(states.has(state), `${state} reached`);
      }
    });

    await t.test('T-A3-3 DB: A-class verification facts from fixture rows (verify is PR-3); REAUTH_REQUIRED and INCOMPATIBLE', async () => {
      const user = await newUser();
      const client = `crv-${uid()}`;
      const b0 = await oauthBinding(user, { client });
      const id = (await install(b0, { host: 'test.complete' })).supplemental.integration_id;
      const crv = async (result, validUntil, digest = null) => (await admin.query(`insert into clued_private.integration_canonical_verifications_v1(
          integration_id, verification_contract, result, checks, subject_digest, connection_id, evidence_sha256, receipt_id, valid_until)
        select $1, 'clued.crv.v1', $2, '[]', coalesce($4, clued_private.integration_subject_digest_v1($1)), c.connection_id, $5,
          gen_random_uuid(), $3::timestamptz
          from clued_private.integration_connections_v1 c where c.integration_id = $1 and c.link_status = 'CURRENT'
        returning verification_id`, [id, result, validUntil, digest, sha(uid())])).rows[0].verification_id;
      const crvOf = (e) => e.facts.canonical_runtime_verification_facts;
      assert.deepEqual(crvOf(await evaluate(id)), { status: 'NONE', verification_id: null, valid_until: null });
      const inOneHour = new Date(Date.now() + 3_600_000).toISOString();
      const v1 = await crv('PASS', inOneHour);
      const active = await evaluate(id);
      assert.equal(active.valid, true, JSON.stringify(active.reason_codes));
      assert.equal(crvOf(active).status, 'VALID');
      assert.equal(crvOf(active).verification_id, v1);
      assert.equal(active.integration_state, 'ACTIVE');
      assert.equal(active.integration_operable, true);
      assert.equal(active.sources_read.crv_verification_id, v1);
      const view = (await native(admin, user, { op: 'status', integration_id: id })).integration;
      assert.equal(view.canonical_verification_evidence_ref.verification_id, v1);
      assert.ok(view.canonical_verification_evidence_ref.receipt_id && view.canonical_verification_evidence_ref.evidence_sha256);
      assert.ok(view.last_canonical_verified_at);
      const expired = await evaluate(id, new Date(Date.now() + 7_200_000).toISOString());
      assert.equal(crvOf(expired).status, 'EXPIRED');
      assert.notEqual(expired.integration_state, 'ACTIVE');
      // a later FAIL row is the latest
      await crv('FAIL', inOneHour);
      assert.equal(crvOf(await evaluate(id)).status, 'FAILED');
      assert.notEqual((await evaluate(id)).integration_state, 'ACTIVE');
      // a PASS for another subject is INVALIDATED; a rebind changes the subject digest of a VALID row
      await crv('PASS', inOneHour, sha('another subject'));
      assert.equal(crvOf(await evaluate(id)).status, 'INVALIDATED');
      await crv('PASS', inOneHour);
      assert.equal((await evaluate(id)).integration_state, 'ACTIVE');
      assert.equal((await install(await oauthBinding(user, { client }), { intent: 'rebind', target_integration_id: id, host: 'test.complete' },
        'REBIND')).status, 'committed');
      const rebound = await evaluate(id);
      assert.equal(crvOf(rebound).status, 'INVALIDATED');
      assert.equal(rebound.integration_state, 'VERIFYING', 'back to VERIFYING, not INSTALL_PENDING (§7.4)');
      // REAUTH_REQUIRED: the current OAuth grant has expired after a first authorization
      const b2 = await oauthBinding(user, { client: `exp-${uid()}` });
      const id2 = (await install(b2, { host: 'test.complete' })).supplemental.integration_id;
      await admin.query(`update clued_private.authorizations_v12 set expires_at = now() - interval '1 minute' where binding_id = $1`, [b2.id]);
      const e2 = await evaluate(id2);
      assert.equal(e2.valid, true, JSON.stringify(e2.reason_codes));
      assert.equal(e2.integration_state, 'REAUTH_REQUIRED');
      assert.deepEqual(e2.effective_capabilities, []);
      // INCOMPATIBLE: a hard compatibility fact (fact rows written by the fixture; fact_set is PR-3)
      const id3 = (await install(await oauthBinding(user, { client: `inc-${uid()}` }), { host: 'test.complete' })).supplemental.integration_id;
      await admin.query(`insert into clued_private.integration_facts_v1(integration_id, truth_class, source, value, fact_status, receipt_id)
        values ($1, 'compatibility_state', 'operator', 'HARD_INCOMPATIBLE', 'CURRENT', gen_random_uuid())`, [id3]);
      const e3 = await evaluate(id3);
      assert.equal(e3.integration_state, 'INCOMPATIBLE');
      assert.equal(e3.integration_operable, false);
      assert.deepEqual(e3.effective_capabilities, []);
    });

    await t.test('ERRATA-003 headless Bindings derive as clued.binding.v1, one provider connection each', async () => {
      const user = await newUser();
      const h1 = await oauthBinding(user, { issuance: 'headless' });
      const h2 = await oauthBinding(user, { issuance: 'headless' });
      const id1 = await admin.query('select clued_private.integration_binding_identity_v1($1) x', [h1.id]);
      assert.equal(id1.rows[0].x.provider, 'clued.binding.v1');
      assert.equal(id1.rows[0].x.provider_connection_id, h1.id);
      assert.equal(id1.rows[0].x.connection_kind, 'OAUTH_V12');
      const i1 = (await install(h1, { host: 'test.complete' })).supplemental.integration_id;
      const i2 = (await install(h2, { host: 'test.complete' })).supplemental.integration_id;
      assert.notEqual(i1, i2, 'two headless Bindings are two keys');
      assert.equal((await install(h2, { intent: 'rebind', target_integration_id: i1, host: 'test.complete' }, 'REBIND')).error_code,
        'integration_rebind_requires_owner_confirmation', 'headless Bindings are not one OAuth client');
      assert.equal((await evaluate(i1)).facts.authorization_state, 'GRANTED');
    });

    await t.test('§10.9 status and list views redact the provider connection id and carry the audit fields', async () => {
      const user = await newUser();
      const b = await oauthBinding(user, { client: `view-${uid()}` });
      const id = (await install(b, { host: 'test.complete' })).supplemental.integration_id;
      const view = (await rpc(admin, 'clued_integration_status_v1', b, { integration_id: id })).integration;
      assert.equal(view.integration_id, id);
      assert.equal(view.identity.provider_connection_id.prefix.length, 8);
      assert.equal(JSON.stringify(view).includes(sha(b.client)), false);
      assert.equal(view.evaluation.integration_state, 'VERIFYING');
      assert.ok(view.identity_claim_evidence_ref.identity_snapshot_id);
      assert.equal(view.owned_bindings[0].binding_id, b.id);
      assert.equal(view.connections[0].link_authority, 'CREATE');
      // another Binding of the same owner is not the current connection
      await expectCode(rpc(admin, 'clued_integration_status_v1', await rawBinding(user), { integration_id: id }), 'integration_connection_required');
      await expectCode(rpc(admin, 'clued_integration_status_v1', await rawBinding(await newUser()), { integration_id: id }), 'integration_not_owned');
      const list = await native(admin, user, { op: 'list' });
      assert.deepEqual(list.integrations.map((x) => x.integration_id), [id]);
      await expectCode(native(admin, await newUser(), { op: 'status', integration_id: id }), 'integration_not_owned');
      await expectCode(native(admin, user, { op: 'declare', integration_id: id }), 'invalid_integration_operation');
      // an OAuth client JWT is not a Native session
      await admin.query('begin');
      await admin.query('set local role authenticated');
      try {
        await admin.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', '{"client_id":"x"}', true)`, [user]);
        await expectCode(admin.query(`select public.clued_user_integration_v1('{"op":"list"}'::jsonb)`), 'direct_human_session_required');
      } finally {
        await admin.query('rollback');
      }
    });
    const closeout=await findGatewayCloseoutMigration(root);
    const callerCatalog=await snapshotCallerCatalog(admin);
    await apply(closeout);
    assert.deepEqual(await snapshotCallerCatalog(admin),callerCatalog,'G6 replay preserves current Native/Binding definitions and ACL');
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});

// The production database does not carry the P5 migrations (authorization-migration-chain's
// production-installed-shape), so clued_agent_bindings has no organization_id / expires_at there. The
// PR-2 functions must run on that shape, not only compile.
test('S2c PR-2 runs on the production-installed shape (no P5 migrations)', { timeout: 600_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-prodshape-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: sha(uid()), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  let db, gateway;
  try {
    await server.initialise();
    await server.start();
    db = server.getPgClient();
    await db.connect();
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql') && !name.includes('p5_')).sort();
    for (const name of names) {
      try { await db.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    gateway=server.getPgClient();await gateway.connect();
    await gateway.query('set session authorization authenticator');
    await setWorkerGatewayCaller(gateway);
    await assertGatewayCloseoutBoundary(db);
    await allowRawTestBindings(db);
    await allowTestIssuerCredentials(db);
    const columns = (await db.query(`select array_agg(attname::text) c from pg_attribute
      where attrelid = 'public.clued_agent_bindings'::regclass and attnum > 0 and not attisdropped`)).rows[0].c;
    assert.equal(columns.includes('organization_id'), false, 'the shape under test has no P5 columns');
    const user = uid();
    await db.query('insert into auth.users(id, email) values ($1, $2)', [user, `${user}@clued.test`]);
    const binding = async (name) => {
      const token = `clued_bnd_${crypto.randomBytes(24).toString('hex')}`;
      const { rows } = await db.query(`insert into public.clued_agent_bindings(user_id, vendor, agent_name, token_hash)
        values ($1, 'Test', $2, $3) returning id`, [user, name, sha(token)]);
      return { id: rows[0].id, hash: sha(token) };
    };
    const call = async (name,b,input) => workerGatewayRpc(gateway,name,b.hash,input);
    const b1 = await binding('first');
    const b2 = await binding('second');
    const opened = await call('clued_integration_request_open_v1', b1, { request_key: key('request'), intent: 'create_or_bind',
      host: 'generic.mcp', host_surface: 'default', adapter_family: 'legacy', adapter_version: '0.1', installation_phase: 'COMPLETED' });
    const created = await call('clued_integration_create_or_bind_v1', b1, { idempotency_key: key(), request_id: opened.request_id,
      binding_intent: 'CREATE_OR_BIND' });
    assert.equal(created.status, 'committed', JSON.stringify(created));
    const id = created.supplemental.integration_id;
    const status = await call('clued_integration_status_v1', b1, { integration_id: id });
    assert.equal(status.integration.evaluation.valid, true);
    const native = async (input) => {
      await db.query('begin');
      await db.query('set local role authenticated');
      try {
        await db.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', '{}', true)`, [user]);
        const result = (await db.query('select public.clued_user_integration_v1($1::jsonb) r', [JSON.stringify(input)])).rows[0].r;
        await db.query('commit');
        return result;
      } catch (error) {
        await db.query('rollback');
        throw error;
      }
    };
    assert.deepEqual((await native({ op: 'binding_inventory' })).bindings.map((x) => x.binding_id), [b2.id]);
    const adopted = await native({ op: 'adopt_binding', idempotency_key: key(), binding_id: b2.id, host: 'generic.mcp',
      host_surface: 'default', adapter_family: 'legacy', adapter_version: '0.1', installation_phase: 'COMPLETED' });
    assert.equal(adopted.status, 'committed', JSON.stringify(adopted));
    assert.equal((await native({ op: 'list' })).integrations.length, 2);
    const closeout=await findGatewayCloseoutMigration(root);
    const callerCatalog=await snapshotCallerCatalog(db);
    await replayGatewayCloseout(db, await fs.readFile(path.join(root,'supabase/migrations',closeout),'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(db),callerCatalog,'G6 replay preserves the no-P5 shape');
    await assertGatewayCloseoutBoundary(db);
  } finally {
    if (gateway) await gateway.end().catch(()=>{});
    if (db) await db.end().catch(() => {});
    await stopCluster(server);
  }
});
