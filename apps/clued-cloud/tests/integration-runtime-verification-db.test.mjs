import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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

// S2c Integration Runtime PR-3 (IntegrationRuntime v0.1.8 §14.1): A / B verification, READY profiles,
// integration_ready_project_v1 and its Receipt, declare / report / fact_set. Proves G-A8 (T-A8-1…4), the
// DB part of T-A7-1 / T-A7-2 (P4), T-A9-7, the G-A10 cases PR-2 deferred because they need ACTIVE
// (T-A10-5, T-A10-7) and the PR-3 structure checks (T-S-1…3).
// Every database runs as a non-root OS user (embedded-postgres refuses root).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261005130000_integration_runtime_verification.sql';
// the stage C §5.13 grant migration: held back until T-S-2 has checked the S2c-only database (§13.0)
const GRANTS = '20261005163000_integration_runtime_grants.sql';
const PR2_RPCS = ['clued_integration_request_open_v1', 'clued_integration_create_or_bind_v1',
  'clued_integration_identity_update_v1', 'clued_integration_reconcile_request_v1', 'clued_integration_status_v1'];
const PR3_BINDING_RPCS = ['clued_integration_declare_v1', 'clued_integration_report_v1', 'clued_integration_verify_v1'];
const BINDING_RPCS = [...PR2_RPCS, ...PR3_BINDING_RPCS];
const PR3_TABLES = ['integration_ready_profiles_v1', 'integration_ready_verifications_v1'];
const REPLACED = ['clued_integration_status_v1(text,jsonb)', 'clued_user_integration_v1(jsonb)'];
const FULL = ['audit.read', 'context.read', 'context.write', 'development_history.read', 'evidence.write',
  'project.read', 'project.write'];
const NON_OPERABLE = ['INSTALL_PENDING', 'INSTALLED', 'AUTH_PENDING', 'VERIFYING', 'BLOCKED', 'REAUTH_REQUIRED',
  'INCOMPATIBLE', 'REVOKED'];
const TRANSPORT = { protocol_version: '2025-06-18', build_sha: 'a'.repeat(40) };

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

test('S2c PR-3: verification separation, READY profiles, declare / report / fact_set', { timeout: 1_800_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-verification-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: sha(uid()), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync', '-c', 'max_connections=40'],
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

    // ---- T-S-3 snapshot around the migration -----------------------------------------------------
    const snapshot = async () => (await admin.query(`select jsonb_build_object(
      'functions', (select jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_object(
          'def', md5(case when p.prokind = 'a' then p.oid::regprocedure::text else pg_get_functiondef(p.oid) end),
          'acl', coalesce(p.proacl::text, ''), 'owner', pg_get_userbyid(p.proowner)))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'),
      'relations', (select jsonb_object_agg(c.oid::regclass::text, jsonb_build_object('kind', c.relkind,
          'acl', coalesce(c.relacl::text, ''), 'rls', c.relrowsecurity, 'owner', pg_get_userbyid(c.relowner),
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
      'roles', (select jsonb_object_agg(rolname, jsonb_build_array(rolsuper, rolinherit, rolcanlogin, rolbypassrls))
        from pg_roles)) s`)).rows[0].s;
    const before = await snapshot();
    await apply(MIGRATION);
    const after = await snapshot();
    assert.ok(migrations.includes(GRANTS));
    // Production order: the migrations between this one and the grant migration now, the grant migration
    // after T-S-2 has checked the database without it, then every later migration (among them
    // 20261007120000_db_security_hygiene.sql, which narrows the grants).
    for (const name of migrations.filter((name) => name > MIGRATION && name < GRANTS)) await apply(name);

    await t.test('T-S-3 the migration adds only PR-3 objects and replaces only the two PR-2 entry points', () => {
      for (const kind of ['relations', 'policies']) {
        for (const [name, value] of Object.entries(before[kind] ?? {})) assert.deepEqual(after[kind]?.[name], value, `${kind} ${name} changed`);
      }
      assert.deepEqual(after.roles, before.roles);
      for (const [name, value] of Object.entries(before.functions)) {
        if (REPLACED.includes(name)) {
          assert.notEqual(after.functions[name].def, value.def, `${name} is replaced`);
          assert.deepEqual({ ...after.functions[name], def: null }, { ...value, def: null }, `${name} keeps its privileges and owner`);
        } else {
          assert.deepEqual(after.functions[name], value, `function ${name} changed`);
        }
      }
      const added = Object.keys(after.relations).filter((name) => !(name in before.relations));
      assert.deepEqual(added.filter((name) => after.relations[name].kind === 'r').sort(), PR3_TABLES.map((x) => `clued_private.${x}`));
      for (const name of added) assert.match(name, /^clued_private\.integration_ready_[a-z_]+_v1(_pkey|_latest)?$/, name);
      for (const name of Object.keys(after.functions).filter((name) => !(name in before.functions))) {
        assert.match(name, /^(clued_private\.integration_|clued_integration_|clued_admin_integration_v1)/, name);
      }
      assert.deepEqual(Object.keys(after.policies ?? {}).filter((name) => !(name in (before.policies ?? {}))), []);
    });

    await t.test('T-S-1 the PR-3 tables have RLS on, no policy and no privilege for public, anon, authenticated, service_role', async () => {
      const { rows } = await admin.query(`select c.relname, c.relrowsecurity,
          exists (select 1 from aclexplode(c.relacl) a where a.grantee <> c.relowner) any_grantee,
          (select count(*) from pg_policies p where p.schemaname = 'clued_private' and p.tablename = c.relname) policies,
          bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger')) any_privilege
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (select rolname::text as rolname from pg_roles where rolname in ('anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway')) r
        where n.nspname = 'clued_private' and c.relname = any($1)
        group by c.oid, c.relname, c.relrowsecurity, c.relacl, c.relowner order by c.relname`, [PR3_TABLES]);
      assert.deepEqual(rows.map((r) => r.relname), PR3_TABLES);
      for (const row of rows) {
        assert.equal(row.relrowsecurity, true, row.relname);
        assert.equal(row.any_grantee, false, row.relname);
        assert.equal(Number(row.policies), 0, row.relname);
        assert.equal(row.any_privilege, false, row.relname);
      }
      // S2c seeds no production READY profile (§5.1); the only rows are the ones S3 defines
      // (20261007060000_integration_runtime_ready_profiles.sql, tested in integration-runtime-ready-profiles-db).
      assert.equal(Number((await admin.query(`select count(*) n from clued_private.integration_ready_profiles_v1
        where profile_id !~ '^(anthropic\\.claude|openai\\.chatgpt)\\.[a-z_]+\\.continuity$'`)).rows[0].n), 0,
        'no production READY profile other than the S3 continuity profiles');
    });

    await t.test('T-S-2 no EXECUTE on any Integration function before the target grants (OQ-21)', async () => {
      const { rows } = await admin.query(`select p.oid::regprocedure::text f,
          bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) any_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (select rolname::text as rolname from pg_roles where rolname in ('anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway')) r
        where (n.nspname = 'clued_private' and p.proname like 'integration\\_%')
           or (n.nspname = 'public' and (p.proname like 'clued\\_integration\\_%'
               or p.proname in ('clued_user_integration_v1', 'clued_admin_integration_v1')))
        group by p.oid`);
      for (const row of rows) assert.equal(row.any_execute, false, row.f);
      const publicRpcs = rows.map((row) => row.f).filter((f) => !f.startsWith('clued_private.')).map((f) => f.replace(/\(.*$/, '')).sort();
      // PR-2 + PR-3 public RPCs; later S2c PRs add theirs, covered by their own test files (PR-4: integration-runtime-lifecycle-db)
      for (const name of [...BINDING_RPCS, 'clued_user_integration_v1', 'clued_admin_integration_v1']) assert.ok(publicRpcs.includes(name), name);
    });

    // the §5.13 target grants: the stage C grant migration itself (§13.0), then the later migrations
    await apply(GRANTS);
    for (const name of migrations.filter((name) => name > GRANTS)) await apply(name);
    const gateway=await connect();
    await gateway.query('set session authorization authenticator');
    await setWorkerGatewayCaller(gateway);
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);

    // ---- fixtures ----------------------------------------------------------------------------
    const newUser = async () => {
      const id = uid();
      await admin.query('insert into auth.users(id, email) values ($1, $2)', [id, `${id}@clued.test`]);
      return id;
    };
    const rawBinding = async (user, { scopes = ['context:read', 'context:write', 'audit:read'] } = {}) => {
      const token = `clued_bnd_${crypto.randomBytes(24).toString('hex')}`;
      const { rows } = await admin.query(`insert into public.clued_agent_bindings(user_id, vendor, agent_name, token_hash, scopes)
        values ($1, 'Test', 'raw', $2, $3) returning id`, [user, sha(token), scopes]);
      return { id: rows[0].id, token, hash: sha(token), user };
    };
    const issuer = sha('integration-verification-issuer');
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash, resource, name)
      values ($1, 'https://clued.test/mcp', 'test issuer')`, [issuer]);
    const DEFAULT_ENTRIES = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] }];
    const oauthBinding = async (user, { client = `client-${uid()}`, scopes = ['context:read', 'context:write'],
      entries = DEFAULT_ENTRIES } = {}) => {
      const binding = await rawBinding(user, { scopes });
      const request = (await admin.query(`insert into clued_private.authorization_requests_v12(owner_id, issuer_hash,
          request_digest, client_id, client_name, redirect_uri, resource, requested_scopes, eligible, status, binding_id)
        values ($1, $2, $3, $4, $4, 'https://host.test/cb', 'https://clued.test/mcp', $5, '[]', 'approved', $6) returning id`,
      [user, issuer, sha(uid()), client, scopes, binding.id])).rows[0].id;
      await admin.query(`insert into clued_private.authorizations_v12(binding_id, request_id, owner_id, client_id, client_name,
          resource, expires_at, issuance) values ($1, $2, $3, $4, $4, 'https://clued.test/mcp', now() + interval '20 days', 'oauth')`,
      [binding.id, request, user, client]);
      for (const entry of entries) {
        await admin.query(`insert into clued_private.authorization_entries_v12(binding_id, resource_kind, resource_id,
            environment, actions) values ($1, $2, $3, $4, $5)`,
        [binding.id, entry.resource_kind, entry.resource_id, entry.environment, entry.actions]);
      }
      return { ...binding, client };
    };

    // test-only registry rows (§13.0)
    await admin.query(`insert into clued_private.integration_hosts_v1(host, tenant_dimension, account_dimension,
        tenant_evidence_kinds, account_evidence_kinds, first_authorization_required, registry_version, capability_snapshot_ref)
      values ('test.complete', 'NOT_APPLICABLE', 'NOT_APPLICABLE', '{}', '{}', true, 1, 'test'),
             ('test.noauth', 'NOT_APPLICABLE', 'NOT_APPLICABLE', '{}', '{}', false, 1, 'test'),
             ('test.tenant', 'REQUIRED', 'NOT_APPLICABLE', '{TEST_TENANT_ID}', '{}', true, 1, 'test')`);
    await admin.query(`insert into clued_private.integration_host_surfaces_v1(host, surface, capability_ceiling, host_features, registry_version)
      select h, 'default', $1::text[], '{"mcp_tools":true,"oauth":true,"hooks":false}', 1
        from unnest(array['test.complete','test.noauth','test.tenant']) h`, [FULL]);
    await admin.query(`insert into clued_private.integration_host_surfaces_v1(host, surface, capability_ceiling, host_features, registry_version)
      values ('test.complete', 'narrow', '{context.read,audit.read}', '{"mcp_tools":true}', 1)`);
    const PROFILE = (id, capabilities, rules, { version = 1, qualification = 'ANY', ttl = '1 day' } = {}) => admin.query(
      `insert into clued_private.integration_ready_profiles_v1(profile_id, profile_version, required_capabilities,
         required_qualification, evidence_rules, freshness_ttl) values ($1, $2, $3, $4, $5, $6::interval)`,
      [id, version, capabilities, qualification, JSON.stringify(rules), ttl]);
    const RESUME = { kind: 'resume_after_link' };
    await PROFILE('test.read', ['context.read'], { 'context.read': RESUME });
    await PROFILE('test.audit', ['audit.read'], { 'audit.read': RESUME });
    await PROFILE('test.write', ['context.write'], { 'context.write': { kind: 'committed_receipt_after_link', families: ['record_mutation'] } });
    await PROFILE('test.qualified', ['context.read'], { 'context.read': RESUME }, { qualification: 'QUALIFIED' });
    const operatorUser = await newUser();
    await admin.query('insert into clued_private.platform_admin_v13(subject_id, version) values ($1, 1)', [operatorUser]);

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
    const asUser = async (fn, user, input, claims = {}) => {
      await admin.query('begin');
      await admin.query('set local role authenticated');
      try {
        await admin.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
          [user, JSON.stringify(claims)]);
        const result = (await admin.query(`select public.${fn}($1::jsonb) r`, [JSON.stringify(input)])).rows[0].r;
        await admin.query('commit');
        return result;
      } catch (error) {
        await admin.query('rollback');
        throw error;
      }
    };
    const native = (user, input) => asUser('clued_user_integration_v1', user, input);
    const operator = (input, user = operatorUser, claims = {}) => asUser('clued_admin_integration_v1', user, input, claims);
    const integration = async (id) => (await admin.query('select * from clued_private.integrations_v1 where integration_id = $1', [id])).rows[0];
    const version = async (id) => Number((await integration(id)).version);
    const evaluate = async (id, asOf = null) => (await admin.query(
      'select clued_private.integration_evaluate_v1($1, coalesce($2::timestamptz, clock_timestamp())) e', [id, asOf])).rows[0].e;
    const install = async (binding, input = {}) => {
      const opened = await rpc(admin, 'clued_integration_request_open_v1', binding, {
        request_key: key('request'), intent: 'create_or_bind', host: 'test.complete', host_surface: 'default',
        adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED', ...input,
      });
      const bound = await rpc(admin, 'clued_integration_create_or_bind_v1', binding, { idempotency_key: key('bind'),
        request_id: opened.request_id, binding_intent: 'CREATE_OR_BIND' });
      assert.equal(bound.status, 'committed', JSON.stringify(bound));
      return bound.supplemental.integration_id;
    };
    const resume = (binding) => admin.query(`insert into public.clued_continuity_sessions(user_id, binding_id, context_key,
      token_hash, restored_version) values ($1, $2, 'global', $3, 0)`, [binding.user, binding.id, sha(uid())]);
    const verify = async (binding, id, input = {}) => rpc(admin, 'clued_integration_verify_v1', binding, {
      kind: 'canonical_baseline', idempotency_key: key('verify'), integration_id: id, base_version: await version(id),
      transport: TRANSPORT, ...input });
    const verifyReady = async (binding, id, profileId, input = {}) => rpc(admin, 'clued_integration_verify_v1', binding, {
      kind: 'ready_profile', idempotency_key: key('ready'), integration_id: id, base_version: await version(id),
      profile_id: profileId, profile_version: 1, ...input });
    const declare = async (binding, id, input = {}) => rpc(admin, 'clued_integration_declare_v1', binding, {
      idempotency_key: key('declare'), integration_id: id, base_version: await version(id), host_surface: 'default',
      declared_capabilities: FULL, host_features: { mcp_tools: true }, adapter_family: 'test-adapter', adapter_version: '1.0.0',
      ...input });
    const report = async (binding, id, input) => rpc(admin, 'clued_integration_report_v1', binding, {
      idempotency_key: key('report'), integration_id: id, base_version: await version(id), ...input });
    const fact = async (op, id, input) => operator({ op, idempotency_key: key('fact'), integration_id: id,
      base_version: await version(id), ...input });
    const project = async (id, profileId, asOf = null, profileVersion = 1) => (await admin.query(
      'select clued_private.integration_ready_project_v1($1, $2, $3, coalesce($4::timestamptz, clock_timestamp())) p',
      [id, profileId, profileVersion, asOf])).rows[0].p;
    const state = async (id) => (await evaluate(id)).integration_state;
    // a fresh ACTIVE Integration: install, one resume after the link, A-class verification
    const active = async (input = {}, bindingOptions = {}, owner = null) => {
      const user = owner ?? await newUser();
      const binding = await oauthBinding(user, bindingOptions);
      const id = await install(binding, input);
      assert.equal(await state(id), 'VERIFYING');
      await resume(binding);
      const verified = await verify(binding, id);
      assert.equal(verified.status, 'committed', JSON.stringify(verified));
      assert.equal(verified.supplemental.result, 'PASS', JSON.stringify(verified.supplemental.checks));
      assert.equal(await state(id), 'ACTIVE');
      return { user, binding, id };
    };
    // one committed M1 Receipt of an ordinary tool family by this Binding (server-observable use, §10.8)
    const toolUse = async (binding, family = 'record_mutation') => {
      const input = { idempotency_key: key('use') };
      const r = (await admin.query(`select (clued_private.m1_begin_receipt($1, $2, $3, $4::jsonb, $5)).id`,
        [binding.user, binding.id, family, JSON.stringify(input), sha(uid())])).rows[0].id;
      await admin.query(`select clued_private.m1_finish_receipt($1, 'committed', '[]', '{}', '{}', '{}', '{}', null)`, [r]);
      return r;
    };
    // a PASS READY row for the current subject, backed by a real Receipt (fixture for states no verify can reach)
    const passRow = async (id, profile, verifiedAt = null) => (await admin.query(`insert into clued_private.integration_ready_verifications_v1(
        integration_id, profile_id, profile_version, result, checks, subject_digest, evidence_sha256, receipt_id, valid_until, verified_at)
      values ($1, $2, 1, 'PASS', '[]', clued_private.integration_subject_digest_v1($1), $3,
        (select id from public.clued_audit_receipts order by created_at desc limit 1), clock_timestamp() + interval '1 day',
        coalesce($4::timestamptz, clock_timestamp() - interval '1 minute')) returning verification_id`,
    [id, profile, sha(uid()), verifiedAt])).rows[0].verification_id;
    const rowHash = async (table) => (await admin.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h
      from ${table} x`)).rows[0].h;
    const guarded = async () => Object.fromEntries(await Promise.all(['clued_private.integration_canonical_verifications_v1',
      'clued_private.integrations_v1', 'clued_private.integration_facts_v1', 'public.clued_agent_bindings',
      'clued_private.authorizations_v12', 'clued_private.authorization_entries_v12', 'clued_private.integration_connections_v1',
      'clued_private.integration_binding_owners_v1', 'clued_private.integration_revocations_v1',
      'clued_private.integration_capability_declarations_v1', 'clued_private.integration_claims_v1'].map(async (table) => [table, await rowHash(table)])));

    // Historical §5.13 is followed by the actual G6 closeout: Binding RPCs use GW, Native remains authenticated.
    await t.test('T-S-2 after the complete migration chain: G6 Binding gateway and Native authenticated only', async () => {
      const { rows } = await admin.query(`select p.proname, array_agg(r.rolname order by r.rolname) filter (where
          has_function_privilege(r.rolname, p.oid, 'execute')) roles
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (select rolname::text as rolname from pg_roles where rolname in ('anon','authenticated','service_role','clued_worker_gateway','clued_p5_gateway')) r
        where n.nspname = 'public' and p.proname = any($1)
        group by p.proname order by p.proname`, [[...BINDING_RPCS, 'clued_user_integration_v1', 'clued_admin_integration_v1']]);
      assert.equal(rows.length, BINDING_RPCS.length + 2);
      for (const row of rows) {
        assert.deepEqual(row.roles, row.proname.startsWith('clued_integration_') ? ['clued_worker_gateway'] : ['authenticated'], row.proname);
      }
    });

    await t.test('§10.7 A-class verification: VERIFYING → ACTIVE on server-observed evidence; failures are FAIL rows', async () => {
      const user = await newUser();
      const b = await oauthBinding(user);
      const id = await install(b);
      assert.equal(await state(id), 'VERIFYING');
      // no resume after the link: CRV-2 FAIL → FAIL row, Receipt, still VERIFYING (OQ-9)
      const failed = await verify(b, id);
      assert.equal(failed.status, 'committed', JSON.stringify(failed));
      assert.equal(failed.supplemental.result, 'FAIL');
      assert.deepEqual(failed.supplemental.checks.map((c) => [c.id, c.result]),
        [['CRV-1', 'PASS'], ['CRV-2', 'FAIL'], ['CRV-3', 'PASS'], ['CRV-4', 'PASS']]);
      assert.equal((await evaluate(id)).facts.canonical_runtime_verification_facts.status, 'FAILED');
      assert.equal(await state(id), 'VERIFYING');
      await resume(b);
      // CRV-3 is weak: a missing or malformed transport can only fail the result
      for (const transport of [undefined, { protocol_version: '1999-01-01', build_sha: null }, { protocol_version: '2025-06-18', build_sha: 'xyz' }]) {
        const weak = await verify(b, id, { transport });
        assert.equal(weak.supplemental.result, 'FAIL', JSON.stringify(transport));
        assert.equal(weak.supplemental.checks.find((c) => c.id === 'CRV-3').evidence_strength, 'WEAK_CALLER_SUPPLIED');
      }
      const ok = await verify(b, id, { transport: { protocol_version: '2026-07-28', build_sha: null } });
      assert.equal(ok.supplemental.result, 'PASS', JSON.stringify(ok.supplemental.checks));
      assert.equal(ok.supplemental.evaluation.integration_state, 'ACTIVE');
      const row = (await admin.query(`select * from clued_private.integration_canonical_verifications_v1 where verification_id = $1`,
        [ok.supplemental.verification_id])).rows[0];
      assert.equal(row.verification_class, 'CANONICAL_RUNTIME_BASELINE');
      assert.equal(row.receipt_id, ok.receipt_id);
      assert.equal(row.connection_id, (await admin.query(`select connection_id from clued_private.integration_connections_v1
        where integration_id = $1 and link_status = 'CURRENT'`, [id])).rows[0].connection_id);
      assert.equal((await admin.query(`select clued_private.integration_sha256_v1(checks::text) = evidence_sha256 ok
        from clued_private.integration_canonical_verifications_v1 where verification_id = $1`, [row.verification_id])).rows[0].ok, true);
      const days = (new Date(row.valid_until) - new Date(row.verified_at)) / 86_400_000;
      assert.ok(days > 29.99 && days < 30.01, `ttl ${days}`);
      const receipt = (await admin.query('select operation_family, status from public.clued_audit_receipts where id = $1', [ok.receipt_id])).rows[0];
      assert.deepEqual(receipt, { operation_family: 'integration_verify_baseline', status: 'committed' });
      assert.equal(Number(ok.committed_versions[id]), await version(id));
      // idempotent replay: same key and payload → the original Receipt, no second row
      const input = { kind: 'canonical_baseline', idempotency_key: key('replay'), integration_id: id, base_version: await version(id), transport: TRANSPORT };
      const first = await rpc(admin, 'clued_integration_verify_v1', b, input);
      const rows = Number((await admin.query('select count(*) n from clued_private.integration_canonical_verifications_v1 where integration_id = $1', [id])).rows[0].n);
      const replay = await rpc(admin, 'clued_integration_verify_v1', b, input);
      assert.equal(replay.replayed, true);
      assert.equal(replay.receipt_id, first.receipt_id);
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_canonical_verifications_v1 where integration_id = $1', [id])).rows[0].n), rows);
      // CAS: a stale base_version is a conflict (rejected envelope, no row)
      const stale = await verify(b, id, { base_version: 1 });
      assert.equal(stale.status, 'rejected');
      assert.equal(stale.error_code, 'integration_version_conflict');
      // the class is fixed by kind; a caller-supplied class is input-invalid
      const forged = await verify(b, id, { verification_class: 'READY_PROFILE_VERIFICATION' });
      assert.equal(forged.status, 'rejected');
      assert.equal(forged.error_code, 'invalid_verification_input');
      await expectCode(rpc(admin, 'clued_integration_verify_v1', b, { integration_id: id }), 'invalid_verification_input');
      // 403 class, before any Receipt: another Binding of the owner, another owner
      const receipts = Number((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n);
      await expectCode(verify(await oauthBinding(user), id), 'integration_connection_required');
      await expectCode(verify(await oauthBinding(await newUser()), id), 'integration_not_owned');
      assert.equal(Number((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n), receipts);
    });

    await t.test('§10.7 guard: no verification while not eligible, claim-blocked or blocked (§16.3)', async () => {
      const { binding, id } = await active();
      const blocked = await fact('fact_set', id, { truth_class: 'adapter_state', value: 'BLOCKED', reason: 'test' });
      assert.equal(blocked.status, 'committed', JSON.stringify(blocked));
      assert.equal(await state(id), 'BLOCKED');
      const rows = Number((await admin.query('select count(*) n from clued_private.integration_canonical_verifications_v1 where integration_id = $1', [id])).rows[0].n);
      const refused = await verify(binding, id);
      assert.equal(refused.status, 'rejected');
      assert.equal(refused.error_code, 'verification_not_eligible');
      assert.ok(refused.supplemental.blocking.includes('B6_adapter'), JSON.stringify(refused.supplemental));
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integration_canonical_verifications_v1 where integration_id = $1', [id])).rows[0].n), rows);
      assert.equal(await state(id), 'BLOCKED');
    });

    await t.test('T-A8-1 A and B are separate truth classes; normalization and derivation never read READY', async () => {
      const checks = (await admin.query(`select conrelid::regclass::text t, pg_get_constraintdef(oid) d from pg_constraint
        where conrelid in ('clued_private.integration_canonical_verifications_v1'::regclass,
          'clued_private.integration_ready_verifications_v1'::regclass) and pg_get_constraintdef(oid) like '%verification_class%'`)).rows;
      const a = checks.filter((c) => c.t.endsWith('canonical_verifications_v1')).map((c) => c.d).join(' ');
      const b = checks.filter((c) => c.t.endsWith('ready_verifications_v1')).map((c) => c.d).join(' ');
      assert.match(a, /CANONICAL_RUNTIME_BASELINE/); assert.doesNotMatch(a, /READY_PROFILE_VERIFICATION/);
      assert.match(b, /READY_PROFILE_VERIFICATION/); assert.doesNotMatch(b, /CANONICAL_RUNTIME_BASELINE/);
      // every function reachable from the roots (the call closure through clued_private.integration_* names in
      // prosrc; PostgreSQL records no table dependency for plpgsql / SQL-string bodies, so pg_depend proves nothing)
      const roots = ['integration_normalize_v1', 'integration_normalize_detail_v1', 'integration_derive_v1',
        'integration_candidate_v1', 'integration_evaluate_v1', 'integration_verify_baseline_core_v1'];
      const sources = Object.fromEntries((await admin.query(`select p.proname, string_agg(p.prosrc, ' ') src from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'clued_private' and p.proname like 'integration\\_%'
        group by p.proname`)).rows.map((r) => [r.proname, r.src]));
      const closure = new Set();
      const queue = [...roots];
      while (queue.length) {
        const name = queue.pop();
        if (closure.has(name)) continue;
        assert.ok(sources[name], `missing ${name}`);
        closure.add(name);
        for (const m of sources[name].matchAll(/clued_private\.(integration_[a-z0-9_]+)/g)) {
          if (sources[m[1]] && !closure.has(m[1])) queue.push(m[1]);
        }
      }
      for (const name of ['integration_predicates_v1', 'integration_select_state_v1', 'integration_facts_validate_v1',
        'integration_crv_facts_v1', 'integration_subject_digest_v1', 'integration_revocation_status_v1', 'integration_lattice_merge_v1']) {
        assert.ok(closure.has(name), `closure misses ${name}`);
      }
      for (const name of closure) assert.doesNotMatch(sources[name], /integration_ready|ready_profile|READY_PROFILE/i, name);
      // a facts document carrying a READY key is C1 (§7.1 rule 2)
      const { id } = await active();
      const facts = (await evaluate(id)).facts;
      for (const extra of [{ ready: true }, { ready_profile: { id: 'test.read', version: 1 } }, { ready_verification: 'PASS' }]) {
        const d = (await admin.query('select clued_private.integration_derive_v1($1::jsonb) d', [JSON.stringify({ ...facts, ...extra })])).rows[0].d;
        assert.equal(d.valid, false);
        assert.ok(d.reason_codes.includes('C1_SCHEMA_INVALID'), JSON.stringify(d.reason_codes));
        assert.equal(d.integration_state, null);
      }
    });

    await t.test('T-A8-2 READY verification never writes Canonical truth, Bindings or Authorizations', async () => {
      const { binding, id } = await active();
      for (const profile of ['test.read', 'test.audit']) {
        const before = await guarded();
        const result = await verifyReady(binding, id, profile);
        assert.equal(result.status, 'committed', JSON.stringify(result));
        assert.equal(result.supplemental.result, profile === 'test.read' ? 'PASS' : 'FAIL');
        assert.deepEqual(result.committed_versions, {});
        assert.deepEqual(await guarded(), before, profile);
        const receipt = (await admin.query('select operation_family from public.clued_audit_receipts where id = $1', [result.receipt_id])).rows[0];
        assert.equal(receipt.operation_family, 'integration_verify_ready');
        const row = (await admin.query('select verification_class, receipt_id from clued_private.integration_ready_verifications_v1 where verification_id = $1',
          [result.supplemental.verification_id])).rows[0];
        assert.deepEqual(row, { verification_class: 'READY_PROFILE_VERIFICATION', receipt_id: result.receipt_id });
      }
      // static: the B-class write function writes none of those tables
      const src = (await admin.query(`select prosrc from pg_proc where proname = 'integration_verify_ready_core_v1'`)).rows[0].prosrc;
      assert.doesNotMatch(src, /(insert\s+into|update|delete\s+from)\s+(public\.|clued_private\.)?(integration_canonical_verifications_v1|integrations_v1|integration_facts_v1|clued_agent_bindings|authorizations_v12|authorization_entries_v12)\b/i);
      assert.doesNotMatch(src, /integration_touch_v1|integration_materialize_connection_revoke_v1|integration_write_open_v1/);
      // kind:'ready_profile' with a forged Canonical class is input-invalid
      const before = await guarded();
      const forged = await verifyReady(binding, id, 'test.read', { verification_class: 'CANONICAL_RUNTIME_BASELINE' });
      assert.equal(forged.status, 'rejected');
      assert.equal(forged.error_code, 'invalid_verification_input');
      assert.deepEqual(await guarded(), before);
      const unknown = await verifyReady(binding, id, 'test.missing');
      assert.equal(unknown.error_code, 'ready_profile_unknown');
    });

    await t.test('T-A8-3 changing the READY profile never changes the Canonical state', async () => {
      const { binding, id } = await active();
      await verifyReady(binding, id, 'test.read');
      await verifyReady(binding, id, 'test.audit');
      // pg's Date parser truncates microseconds; keep the actual database instant
      // so a verification in this same millisecond is not excluded by as_of.
      const asOf = (await admin.query('select clock_timestamp()::text t')).rows[0].t;
      const x = await project(id, 'test.read', asOf);
      const y = await project(id, 'test.audit', asOf);
      assert.equal(x.ready, true, JSON.stringify(x.reasons));
      assert.equal(y.ready, false);
      assert.ok(y.reasons.includes('CAPABILITY_NOT_EFFECTIVE') && y.reasons.includes('READY_VERIFICATION_FAILED'), JSON.stringify(y.reasons));
      assert.deepEqual(y.missing_capabilities, ['audit.read']);
      assert.equal(x.integration_state, 'ACTIVE');
      assert.equal(y.integration_state, x.integration_state);
      assert.equal(y.facts_sha256, x.facts_sha256);
      const e0 = await evaluate(id, asOf);
      await PROFILE('test.read', ['context.read', 'context.write'], { 'context.read': RESUME, 'context.write': RESUME }, { version: 2 });
      const e1 = await evaluate(id, asOf);
      assert.equal(e1.integration_state, e0.integration_state);
      assert.equal(e1.facts_sha256, e0.facts_sha256);
      assert.equal((await project(id, 'test.read', asOf, 2)).reasons.includes('READY_VERIFICATION_NONE'), true);
    });

    await t.test('T-A8-4 / §20 a non-operable state never projects READY, and READY verification is refused', async () => {
      // real states reached through the operations
      const scenarios = {
        BLOCKED: async ({ id }) => fact('fact_set', id, { truth_class: 'adapter_state', value: 'BLOCKED', reason: 'test' }),
        INCOMPATIBLE: async ({ id }) => fact('fact_set', id, { truth_class: 'compatibility_state', value: 'HARD_INCOMPATIBLE', reason: 'test' }),
        VERIFYING: async ({ binding, id }) => declare(binding, id, { adapter_version: '1.1.0' }),
        REAUTH_REQUIRED: async ({ id }) => admin.query(`insert into clued_private.integration_reauth_marks_v1(integration_id, reason,
          raised_by, raised_receipt_id) values ($1, 'CREDENTIAL_INVALIDATED', 'SERVER', $2)`, [id, uid()]),
        REVOKED: async ({ binding }) => admin.query('update public.clued_agent_bindings set revoked_at = now() where id = $1', [binding.id]),
      };
      for (const [expected, make] of Object.entries(scenarios)) {
        const fixture = await active();
        const passed = await verifyReady(fixture.binding, fixture.id, 'test.read');
        assert.equal(passed.supplemental.result, 'PASS');
        assert.equal((await project(fixture.id, 'test.read')).ready, true);
        await make(fixture);
        assert.equal(await state(fixture.id), expected);
        const p = await project(fixture.id, 'test.read');
        assert.equal(p.ready, false, expected);
        assert.ok(p.reasons.includes('NOT_OPERABLE'), `${expected} ${JSON.stringify(p.reasons)}`);
        if (expected !== 'REVOKED') {
          const refused = await verifyReady(fixture.binding, fixture.id, 'test.read');
          assert.equal(refused.status, 'rejected', expected);
          assert.equal(refused.error_code, 'ready_verification_requires_operable', expected);
        } else {
          await expectCode(verifyReady(fixture.binding, fixture.id, 'test.read'), 'binding_not_authorized');
        }
      }
      // the three states no Binding can verify in: real Native Integrations, each with a PASS READY row for its
      // current subject and a real Receipt (a fixture: §10.8 refuses the verification itself)
      const reached = new Set(Object.keys(scenarios));
      const user = await newUser();
      for (const [expected, host, phase] of [['INSTALL_PENDING', 'test.complete', 'STARTED'], ['AUTH_PENDING', 'test.complete', 'COMPLETED'],
        ['INSTALLED', 'test.noauth', 'COMPLETED']]) {
        const request = await native(user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host,
          host_surface: 'default', provider: 'clued.oauth.v12', adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: phase });
        const created = await native(user, { op: 'create_or_bind', idempotency_key: key(), request_id: request.request_id, binding_intent: 'CREATE_OR_BIND' });
        const id = created.supplemental.integration_id;
        assert.equal(await state(id), expected);
        await passRow(id, 'test.read');
        const p = await project(id, 'test.read');
        assert.equal(p.ready, false, expected);
        assert.ok(p.reasons.includes('NOT_OPERABLE'), `${expected} ${JSON.stringify(p.reasons)}`);
        assert.equal(p.reasons.includes('READY_VERIFICATION_NONE'), false, 'the PASS row is found');
        reached.add(expected);
      }
      assert.deepEqual([...reached].sort(), [...NON_OPERABLE].sort());
    });

    await t.test('T-A7-1 / T-A7-2 (P4) READY profiles and READY verifications never change normalization or state', async () => {
      const { binding, id } = await active();
      await verifyReady(binding, id, 'test.read');
      const asOf = (await admin.query('select clock_timestamp() t')).rows[0].t;
      const normalized = async () => (await admin.query('select clued_private.integration_normalize_v1($1, $2)::text n', [id, asOf])).rows[0].n;
      const n0 = await normalized();
      const s0 = (await evaluate(id, asOf)).integration_state;
      const check = async (label) => {
        assert.equal(await normalized(), n0, label);
        assert.equal((await evaluate(id, asOf)).integration_state, s0, label);
      };
      const digest = (await admin.query('select clued_private.integration_subject_digest_v1($1) d', [id])).rows[0].d;
      const receiptId = (await admin.query(`select id from public.clued_audit_receipts where binding_id = $1 and status = 'committed'
        order by created_at desc limit 1`, [binding.id])).rows[0].id;
      const insertRow = (profile, result, validUntil, verifiedAt = null) => admin.query(`insert into clued_private.integration_ready_verifications_v1(
          integration_id, profile_id, profile_version, result, checks, subject_digest, evidence_sha256, receipt_id, valid_until, verified_at)
        values ($1, $2, 1, $3, '[]', $4, $5, $6, $7, coalesce($8, clock_timestamp())) returning verification_id`,
      [id, profile, result, digest, sha(uid()), receiptId, validUntil, verifiedAt]);
      await PROFILE('test.p4', ['context.read'], { 'context.read': RESUME });
      await check('new profile');
      const rows = [];
      const before = new Date(new Date(asOf).getTime() - 60_000);
      const tomorrow = new Date(Date.now() + 86_400_000);
      // rows a regression reading READY "as of p_as_of" would see: verified before as_of, current subject, not expired
      rows.push((await insertRow('test.p4', 'PASS', tomorrow, before)).rows[0].verification_id);
      await check('PASS row before as_of');
      rows.push((await insertRow('test.audit', 'FAIL', tomorrow, before)).rows[0].verification_id);
      await check('FAIL row before as_of');
      rows.push((await insertRow('test.p4', 'PASS', tomorrow)).rows[0].verification_id);
      await check('PASS row after as_of');
      rows.push((await insertRow('test.read', 'PASS', new Date(Date.now() - 1000), new Date(Date.now() - 86_400_000))).rows[0].verification_id);
      await check('expired row, verified before as_of');
      await admin.query(`update clued_private.integration_ready_verifications_v1 set result = 'FAIL', valid_until = clock_timestamp() - interval '1 hour'
        where integration_id = $1 and profile_id = 'test.read'`, [id]);
      await check('existing READY rows modified');
      await admin.query(`update clued_private.integration_ready_profiles_v1 set freshness_ttl = interval '1 hour',
        required_qualification = 'QUALIFIED' where profile_id = 'test.p4'`);
      await check('modified profile');
      await admin.query('delete from clued_private.integration_ready_verifications_v1 where verification_id = any($1)', [rows]);
      await admin.query(`delete from clued_private.integration_ready_profiles_v1 where profile_id = 'test.p4'`);
      await check('deleted rows and profile');
      // status(profiles=[A]) vs status(profiles=[B]): same Canonical state and facts
      await verifyReady(binding, id, 'test.read');
      const a = await rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id, profiles: [{ id: 'test.read', version: 1 }] });
      const b = await rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id, profiles: [{ id: 'test.audit', version: 1 }] });
      assert.notEqual(a.integration.ready[0].ready, b.integration.ready[0].ready);
      assert.equal(a.integration.evaluation.integration_state, b.integration.evaluation.integration_state);
      assert.equal(a.integration.evaluation.facts_sha256, b.integration.evaluation.facts_sha256);
    });

    await t.test('§9.5 READY reasons: none, failed, invalidated, expired, qualification; evidence by receipt family', async () => {
      const { user, binding, id } = await active();
      assert.deepEqual((await project(id, 'test.read')).reasons, ['READY_VERIFICATION_NONE']);
      // test.write needs a committed record_mutation Receipt by this Binding after the link; the runtime's own
      // committed Receipts (a FAIL ready verification, a declaration) are not evidence (placement choice (b))
      const failed = await verifyReady(binding, id, 'test.write');
      assert.equal(failed.supplemental.result, 'FAIL');
      assert.equal((await verifyReady(binding, id, 'test.write')).supplemental.result, 'FAIL', 'a FAIL row never proves the next');
      assert.deepEqual((await project(id, 'test.write')).reasons, ['READY_VERIFICATION_FAILED']);
      assert.equal((await declare(binding, id)).status, 'committed');
      assert.equal(await state(id), 'VERIFYING', 'the first declaration names the surface: a new subject (§7.4)');
      assert.equal((await verify(binding, id)).supplemental.result, 'PASS');
      assert.equal((await declare(binding, id)).status, 'committed');
      assert.equal(await state(id), 'ACTIVE', 'an unchanged declaration keeps the subject digest');
      assert.equal((await verifyReady(binding, id, 'test.write')).supplemental.result, 'FAIL');
      const use = await toolUse(binding);
      const passed = await verifyReady(binding, id, 'test.write');
      assert.equal(passed.supplemental.result, 'PASS', JSON.stringify(passed.supplemental.checks));
      assert.equal(passed.supplemental.checks[0].evidence_ref, use);
      assert.equal((await project(id, 'test.write')).ready, true);
      await verifyReady(binding, id, 'test.read');
      const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
      assert.ok((await project(id, 'test.read', later)).reasons.includes('READY_VERIFICATION_EXPIRED'));
      // an upgrade changes the subject digest: Canonical VERIFYING and the READY row INVALIDATED
      await declare(binding, id, { adapter_version: '1.0.1' });
      const invalidated = await project(id, 'test.read');
      assert.ok(invalidated.reasons.includes('NOT_OPERABLE') && invalidated.reasons.includes('READY_VERIFICATION_INVALIDATED'),
        JSON.stringify(invalidated.reasons));
      await verify(binding, id);
      assert.deepEqual((await project(id, 'test.read')).reasons, ['READY_VERIFICATION_INVALIDATED']);
      await verifyReady(binding, id, 'test.read');
      assert.equal((await project(id, 'test.read')).ready, true);
      // QUALIFIED profiles need an Operator qualification fact (§10.6, S3)
      await verifyReady(binding, id, 'test.qualified');
      assert.deepEqual((await project(id, 'test.qualified')).reasons, ['QUALIFICATION_REQUIRED']);
      assert.equal((await fact('fact_set', id, { truth_class: 'qualification_state', value: 'QUALIFIED', reason: 'S3' })).status, 'committed');
      assert.equal(await state(id), 'ACTIVE');
      assert.equal((await project(id, 'test.qualified')).ready, true);
      // Native status carries the projection too
      const s = await native(user, { op: 'status', integration_id: id, profiles: [{ id: 'test.qualified', version: 1 }] });
      assert.equal(s.integration.ready[0].ready, true);
      assert.equal(s.integration.ready[0].ready_verification_evidence_ref.receipt_id,
        (await admin.query(`select receipt_id from clued_private.integration_ready_verifications_v1 where integration_id = $1
          and profile_id = 'test.qualified' order by verified_at desc limit 1`, [id])).rows[0].receipt_id);
    });

    await t.test('§9.5 / §10.9 the READY projection Receipt is written in the same request and replays', async () => {
      const { binding, id } = await active();
      await verifyReady(binding, id, 'test.read');
      const input = { integration_id: id, profiles: [{ id: 'test.read', version: 1 }, { id: 'test.audit', version: 1 }],
        emit_ready_receipt: true, idempotency_key: key('projection') };
      const first = await rpc(admin, 'clued_integration_status_v1', binding, input);
      const envelope = first.ready_projection_receipt;
      assert.equal(envelope.status, 'committed', JSON.stringify(envelope));
      const receipt = (await admin.query('select operation_family, binding_id, target_refs, metadata from public.clued_audit_receipts where id = $1',
        [envelope.receipt_id])).rows[0];
      assert.equal(receipt.operation_family, 'integration_ready_projection');
      assert.equal(receipt.binding_id, binding.id);
      assert.deepEqual(receipt.metadata.supplemental.projections.map((p) => [p.profile.id, p.ready]), [['test.read', true], ['test.audit', false]]);
      assert.deepEqual(receipt.metadata.supplemental.projections, first.integration.ready);
      assert.ok(receipt.target_refs.some((r) => r.role === 'ready_verification'));
      // a READY verification after the original request: a fresh projection would differ, the replay does not
      await verifyReady(binding, id, 'test.audit');
      const receipts = Number((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n);
      const replay = await rpc(admin, 'clued_integration_status_v1', binding, input);
      assert.equal(replay.ready_projection_receipt.replayed, true);
      assert.equal(replay.ready_projection_receipt.receipt_id, envelope.receipt_id);
      assert.deepEqual(replay.integration.ready, first.integration.ready, 'a replay answers with the bound projections');
      assert.equal(Number((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n), receipts);
      // without the flag: no Receipt; malformed requests are refused before anything is written
      const plain = await rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id, profiles: [{ id: 'test.read', version: 1 }] });
      assert.equal(plain.ready_projection_receipt, undefined);
      await expectCode(rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id, profiles: [{ id: 'test.read', version: 1 }],
        emit_ready_receipt: true }), 'invalid_ready_profiles');
      await expectCode(rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id, profiles: [{ id: 'test.read' }] }),
        'invalid_ready_profiles');
      await expectCode(rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id,
        profiles: [{ id: 'test.read', version: 1 }, { version: 1, id: 'test.read' }] }), 'invalid_ready_profiles');
      await expectCode(rpc(admin, 'clued_integration_status_v1', binding, { integration_id: id, profiles: [{ id: 'test.none', version: 1 }] }),
        'ready_profile_unknown');
      await expectCode(project(id, 'test.none'), 'ready_profile_unknown');
      assert.equal(Number((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n), receipts);
    });

    await t.test('§10.6 declare: narrows within the surface ceiling; Host features only as registered', async () => {
      const { binding, id } = await active();
      const rejected = async (input, code) => {
        const r = await declare(binding, id, input);
        assert.equal(r.status, 'rejected', JSON.stringify(r));
        assert.equal(r.error_code, code);
      };
      await rejected({ host_surface: 'nope' }, 'host_surface_not_registered');
      await rejected({ host_surface: 'narrow', declared_capabilities: ['context.read', 'context.write'] }, 'capability_declaration_exceeds_ceiling');
      await rejected({ declared_capabilities: ['context.read', 'telepathy'] }, 'capability_unknown');
      await rejected({ host_features: { hooks: true } }, 'host_feature_not_supported');
      await rejected({ host_features: { subagents: true } }, 'host_feature_not_supported');
      await rejected({ host_features: { mcp_tools: 'yes' } }, 'invalid_declaration');
      await rejected({ adapter_version: '' }, 'invalid_declaration');
      assert.equal(await state(id), 'ACTIVE');
      const v0 = await version(id);
      const ok = await declare(binding, id, { declared_capabilities: ['context.read', 'context.read'], host_features: { mcp_tools: true, hooks: false },
        package_version: '7.0.0' });
      assert.equal(ok.status, 'committed', JSON.stringify(ok));
      assert.deepEqual(ok.supplemental.declared_capabilities, ['context.read']);
      assert.equal(await version(id), v0 + 1);
      const row = await integration(id);
      assert.deepEqual([row.adapter_family, row.adapter_version, row.package_version], ['test-adapter', '1.0.0', '7.0.0']);
      const e = await evaluate(id);
      assert.equal(e.integration_state, 'VERIFYING', 'package_version is part of the subject digest');
      assert.deepEqual(e.facts.host_state.declared, ['context.read']);
      await verify(binding, id);
      assert.deepEqual((await evaluate(id)).effective_capabilities, ['context.read'], 'Host Capability: ceiling ∩ declared');
      const stale = await declare(binding, id, { base_version: v0 });
      assert.equal(stale.error_code, 'integration_version_conflict');
      await expectCode(declare(await oauthBinding((await integration(id)).owner_id), id), 'integration_connection_required');
    });

    await t.test('T-A9-7 upgrade: VERIFYING without reauth; below a minimum → INCOMPATIBLE or DEGRADED', async () => {
      const FAMILY = 'upgrade-adapter';
      const { binding, id } = await active({ adapter_family: FAMILY });
      const before = await integration(id);
      const upgraded = await declare(binding, id, { adapter_family: FAMILY, adapter_version: '1.5.0' });
      assert.equal(upgraded.status, 'committed', JSON.stringify(upgraded));
      let e = await evaluate(id);
      assert.equal(e.integration_state, 'VERIFYING');
      assert.equal(e.facts.canonical_runtime_verification_facts.status, 'INVALIDATED');
      const row = await integration(id);
      assert.deepEqual(row.authorization_ceiling, before.authorization_ceiling, 'an upgrade never widens the ceiling (§37)');
      assert.equal(e.facts.reauth_marks_open, 0);
      assert.deepEqual(e.facts.oauth_scope_facts, ['context:read', 'context:write']);
      await admin.query(`insert into clued_private.integration_compatibility_rules_v1(host, adapter_family, min_adapter_version,
        below_minimum, registry_version) values ('test.complete', $1, '2.0.0', 'HARD_INCOMPATIBLE', 1)`, [FAMILY]);
      e = await evaluate(id);
      assert.equal(e.facts.compatibility_state.value, 'HARD_INCOMPATIBLE');
      assert.equal(e.integration_state, 'INCOMPATIBLE');
      assert.equal(await state(id), 'INCOMPATIBLE');
      await declare(binding, id, { adapter_family: FAMILY, adapter_version: '2.1.0' });
      assert.equal(await state(id), 'VERIFYING');
      assert.equal((await verify(binding, id)).supplemental.result, 'PASS');
      assert.equal(await state(id), 'ACTIVE');
      await admin.query(`insert into clued_private.integration_compatibility_rules_v1(host, adapter_family, min_adapter_version,
        below_minimum, degraded_mask, registry_version) values ('test.complete', $1, '3.0.0', 'DEGRADED', '{context.read}', 2)`, [FAMILY]);
      e = await evaluate(id);
      assert.equal(e.integration_state, 'DEGRADED');
      assert.deepEqual(e.effective_capabilities, ['context.read']);
    });

    await t.test('§10.6 report: an adapter only narrows host_state / adapter_state and clears only its own report', async () => {
      const { binding, id } = await active();
      const set = (input) => report(binding, id, { action: 'set', ...input });
      const expectRejected = async (promise, code) => {
        const r = await promise;
        assert.equal(r.status, 'rejected', JSON.stringify(r));
        assert.equal(r.error_code, code);
      };
      await expectRejected(set({ truth_class: 'environment_state', value: 'BLOCKED' }), 'adapter_report_cannot_expand');
      await expectRejected(set({ truth_class: 'qualification_state', value: 'SUSPENDED' }), 'adapter_report_cannot_expand');
      await expectRejected(set({ truth_class: 'host_state', value: 'AVAILABLE' }), 'adapter_report_cannot_expand');
      await expectRejected(set({ truth_class: 'adapter_state', value: 'OK' }), 'adapter_report_cannot_expand');
      await expectRejected(set({ truth_class: 'host_state', value: 'DEGRADED' }), 'invalid_integration_report');
      await expectRejected(set({ truth_class: 'host_state', value: 'DEGRADED', mask: ['telepathy'] }), 'invalid_integration_report');
      await expectRejected(set({ truth_class: 'host_state', value: 'DEGRADED', mask: ['context.read'], source: 'operator' }), 'invalid_integration_report');
      await expectRejected(report(binding, id, { action: 'clear', truth_class: 'host_state' }), 'invalid_integration_report');
      const degraded = await set({ truth_class: 'host_state', value: 'DEGRADED', mask: ['context.read'], reason: 'slow host' });
      assert.equal(degraded.status, 'committed', JSON.stringify(degraded));
      let e = await evaluate(id);
      assert.equal(e.integration_state, 'DEGRADED');
      assert.deepEqual(e.effective_capabilities, ['context.read']);
      assert.equal((await set({ truth_class: 'adapter_state', value: 'BLOCKED' })).status, 'committed');
      assert.equal(await state(id), 'BLOCKED');
      assert.equal((await report(binding, id, { action: 'clear', truth_class: 'adapter_state' })).status, 'committed');
      assert.equal(await state(id), 'DEGRADED');
      // the adapter cannot override or clear an operator fact: the lattice keeps the most restrictive
      assert.equal((await fact('fact_set', id, { truth_class: 'host_state', value: 'HARD_UNAVAILABLE', reason: 'incident' })).status, 'committed');
      assert.equal(await state(id), 'BLOCKED');
      assert.equal((await report(binding, id, { action: 'clear', truth_class: 'host_state' })).status, 'committed');
      e = await evaluate(id);
      assert.equal(e.facts.host_state.value, 'HARD_UNAVAILABLE');
      await expectRejected(report(binding, id, { action: 'clear', truth_class: 'host_state' }), 'invalid_integration_report');
      assert.equal((await fact('fact_clear', id, { truth_class: 'host_state' })).status, 'committed');
      assert.equal(await state(id), 'ACTIVE');
      const rows = (await admin.query(`select source, fact_status from clued_private.integration_facts_v1 where integration_id = $1
        and truth_class = 'host_state' order by recorded_at`, [id])).rows;
      assert.deepEqual(rows, [{ source: 'adapter', fact_status: 'CLEARED' }, { source: 'operator', fact_status: 'CLEARED' }]);
      // a narrowing fact past its valid_until is not current truth any more (§7.2)
      const until = new Date(Date.now() + 2000).toISOString();
      await set({ truth_class: 'adapter_state', value: 'BLOCKED', valid_until: until });
      assert.equal(await state(id), 'BLOCKED');
      assert.equal((await evaluate(id, new Date(Date.now() + 5000).toISOString())).integration_state, 'ACTIVE');
      await expectRejected(set({ truth_class: 'adapter_state', value: 'BLOCKED', valid_until: '2000-01-01T00:00:00Z' }), 'invalid_integration_report');
    });

    await t.test('§10.1 / §10.6 Operator fact_set / fact_clear: platform admin only, reason required', async () => {
      const { user, id } = await active();
      await expectCode(operator({ op: 'fact_set', integration_id: id }, user), 'platform_admin_required');
      await expectCode(operator({ op: 'fact_set', integration_id: id }, operatorUser, { client_id: 'some-client' }), 'direct_human_session_required');
      await expectCode(operator({ op: 'fact_set', integration_id: uid() }), 'integration_not_owned');
      await expectCode(operator({ op: 'declare', integration_id: id }), 'invalid_integration_operation');
      const missingReason = await fact('fact_set', id, { truth_class: 'qualification_state', value: 'SUSPENDED' });
      assert.equal(missingReason.error_code, 'invalid_integration_fact');
      const badValue = await fact('fact_set', id, { truth_class: 'qualification_state', value: 'NOT_EVALUATED', reason: 'x' });
      assert.equal(badValue.error_code, 'invalid_integration_fact');
      const badSource = await fact('fact_set', id, { truth_class: 'environment_state', value: 'BLOCKED', reason: 'x', source: 'adapter' });
      assert.equal(badSource.error_code, 'invalid_integration_fact');
      const suspended = await fact('fact_set', id, { truth_class: 'qualification_state', value: 'SUSPENDED', reason: 'S3 review' });
      assert.equal(suspended.status, 'committed', JSON.stringify(suspended));
      const receipt = (await admin.query('select operation_family, user_id, binding_id from public.clued_audit_receipts where id = $1',
        [suspended.receipt_id])).rows[0];
      assert.deepEqual(receipt, { operation_family: 'integration_fact_set', user_id: user, binding_id: null });
      const log = (await admin.query(`select actor_kind, source_provenance from clued_private.integration_operation_log_v1 where receipt_id = $1`,
        [suspended.receipt_id])).rows[0];
      assert.equal(log.actor_kind, 'operator');
      assert.equal(log.source_provenance.operator_id, operatorUser);
      assert.equal(await state(id), 'BLOCKED');
      const policy = await fact('fact_set', id, { truth_class: 'environment_state', value: 'RESTRICTED', mask: ['context.read'],
        reason: 'policy', source: 'policy' });
      assert.equal(policy.status, 'committed');
      assert.equal((await fact('fact_clear', id, { truth_class: 'qualification_state' })).status, 'committed');
      let e = await evaluate(id);
      assert.equal(e.integration_state, 'DEGRADED');
      assert.deepEqual(e.effective_capabilities, ['context.read']);
      assert.equal((await fact('fact_clear', id, { truth_class: 'environment_state', source: 'policy' })).status, 'committed');
      e = await evaluate(id);
      assert.equal(e.integration_state, 'ACTIVE');
      const stale = await operator({ op: 'fact_set', idempotency_key: key(), integration_id: id, base_version: 1,
        truth_class: 'adapter_state', value: 'BLOCKED', reason: 'x' });
      assert.equal(stale.error_code, 'integration_version_conflict');
      const s = await operator({ op: 'status', integration_id: id, profiles: [{ id: 'test.read', version: 1 }] });
      assert.equal(s.integration.evaluation.integration_state, 'ACTIVE');
      assert.equal(s.integration.ready[0].ready, false);
    });

    const tenant = (value) => ({ status: 'VALUE', value, evidence_kind: 'TEST_TENANT_ID' });

    await t.test('T-A10-5 (ACTIVE) late strengthening into an ACTIVE holder: CLAIM_CONFLICT, BLOCKED, the holder unchanged', async () => {
      const client = `late-${uid()}`;
      const holder = await active({ host: 'test.tenant', tenant: tenant('T1') }, { client });
      const late = await active({ host: 'test.tenant' }, { client }, holder.user);
      assert.equal((await integration(late.id)).identity_completeness, 'INCOMPLETE');
      const h0 = await evaluate(holder.id);
      assert.equal(h0.integration_state, 'ACTIVE');
      const update = await rpc(admin, 'clued_integration_identity_update_v1', late.binding.hash, { idempotency_key: key(),
        integration_id: late.id, base_version: await version(late.id), tenant: tenant('T1') });
      assert.equal(update.status, 'committed', JSON.stringify(update));
      assert.equal(update.supplemental.identity_claim_state, 'CLAIM_CONFLICT');
      const e = await evaluate(late.id);
      assert.equal(e.integration_state, 'BLOCKED');
      assert.equal(e.integration_operable, false);
      assert.deepEqual(e.effective_capabilities, []);
      const h1 = await evaluate(holder.id);
      assert.equal(h1.integration_state, 'ACTIVE');
      assert.equal((await integration(holder.id)).identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      assert.equal(h1.facts_sha256, h0.facts_sha256);
      // ordinary advancement is refused while the claim is blocked
      const blocked = await verify(late.binding, late.id);
      assert.equal(blocked.error_code, 'integration_claim_blocked');
      assert.equal((await declare(late.binding, late.id, { adapter_version: '9.0.0' })).error_code, 'integration_claim_blocked');
    });

    await t.test('T-A10-7 (ACTIVE) CLAIM_CONFLICT, PENDING_RECONCILE, SUPERSEDED: one fail-closed chain from ACTIVE', async () => {
      const client = `chain-${uid()}`;
      const holder = await active({ host: 'test.tenant', tenant: tenant('C') }, { client });
      const late = await active({ host: 'test.tenant' }, { client }, holder.user);
      await verifyReady(late.binding, late.id, 'test.read');
      assert.equal((await project(late.id, 'test.read')).ready, true);
      const chain = async (claimState) => {
        const e = await evaluate(late.id);
        assert.equal(e.valid, true, JSON.stringify(e.reason_codes));
        assert.equal(e.facts.identity_claim_state, claimState);
        assert.equal(e.predicates.identity_claim_blocks_ordinary_runtime, true);
        assert.deepEqual(e.candidate_ordinary_capabilities, []);
        assert.equal(e.integration_state, 'BLOCKED');
        assert.equal(e.integration_operable, false);
        assert.deepEqual(e.effective_capabilities, []);
        assert.equal((await project(late.id, 'test.read')).ready, false);
      };
      await rpc(admin, 'clued_integration_identity_update_v1', late.binding.hash, { idempotency_key: key(),
        integration_id: late.id, base_version: await version(late.id), tenant: tenant('C') });
      await chain('CLAIM_CONFLICT');
      const pending = await rpc(admin, 'clued_integration_reconcile_request_v1', late.binding.hash, { idempotency_key: key(),
        integration_id: late.id, base_version: await version(late.id) });
      assert.equal(pending.status, 'committed', JSON.stringify(pending));
      await chain('PENDING_RECONCILE');
      const r = await native(late.user, { op: 'reconcile', idempotency_key: key(), integration_id: late.id, resolution: 'REBIND_TO_HOLDER',
        base_version: await version(late.id), holder_base_version: await version(holder.id) });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      await chain('SUPERSEDED');
      // the holder now carries the moved connection: a new subject, so it must verify again (§7.4), then ACTIVE
      assert.equal(await state(holder.id), 'VERIFYING');
      await resume(late.binding);
      assert.equal((await verify(late.binding, holder.id)).supplemental.result, 'PASS');
      assert.equal(await state(holder.id), 'ACTIVE');
    });

    await t.test('§10.1 a PR-3 write on a connection-revoked Integration materializes the revocation; a rejected one leaves none', async () => {
      const revocations = async (id) => (await admin.query(`select revocation_source, receipt_id, revoked_by, adopted_from
        from clued_private.integration_revocations_v1 where integration_id = $1`, [id])).rows;
      const a = await active();
      await admin.query('update public.clued_agent_bindings set revoked_at = now() where id = $1', [a.binding.id]);
      assert.equal(await state(a.id), 'REVOKED');
      assert.deepEqual(await revocations(a.id), [], 'derived REVOKED, not yet materialized');
      const committed = await fact('fact_set', a.id, { truth_class: 'environment_state', value: 'BLOCKED', reason: 'incident' });
      assert.equal(committed.status, 'committed', JSON.stringify(committed));
      assert.ok(committed.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
      const rows = await revocations(a.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].revocation_source, 'CONNECTION_REVOKE_ADOPTED');
      assert.equal(rows[0].receipt_id, committed.receipt_id);
      assert.equal(rows[0].adopted_from.binding_id, a.binding.id);
      const ref = committed.target_refs.find((r) => r.role === 'revocation');
      assert.equal(ref.kind, 'integration_revocation');
      assert.equal(await state(a.id), 'REVOKED');
      // a rejected write rolls its materialization back with it
      const b = await active();
      await admin.query('update public.clued_agent_bindings set revoked_at = now() where id = $1', [b.binding.id]);
      const stale = await operator({ op: 'fact_set', idempotency_key: key(), integration_id: b.id, base_version: (await version(b.id)) - 1,
        truth_class: 'environment_state', value: 'BLOCKED', reason: 'x' });
      assert.equal(stale.error_code, 'integration_version_conflict');
      const invalid = await fact('fact_set', b.id, { truth_class: 'environment_state', value: 'NOPE', reason: 'x' });
      assert.equal(invalid.error_code, 'invalid_integration_fact');
      assert.deepEqual(await revocations(b.id), []);
    });

    await t.test('§10.7 CRV-3 accepts exactly the MCP versions the Worker supports', async () => {
      const source = await fs.readFile(path.join(root, 'worker/continuity.ts'), 'utf8');
      const block = source.match(/const SUPPORTED_MCP_VERSIONS = \[([^\]]*)\]/);
      assert.ok(block, 'SUPPORTED_MCP_VERSIONS not found in worker/continuity.ts');
      const worker = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const sql = (await admin.query('select clued_private.integration_supported_mcp_versions_v1() v')).rows[0].v;
      assert.deepEqual(sql, worker);
    });

    await t.test('READY profile rows: the evidence rules CHECK (placement choice (b))', async () => {
      const bad = [
        [['context.read'], {}],
        [['context.read'], { 'context.read': RESUME, 'context.write': RESUME }],
        [['context.read'], { 'context.read': { kind: 'self_reported' } }],
        [['context.read'], { 'context.read': { kind: 'resume_after_link', extra: 1 } }],
        [['context.write'], { 'context.write': { kind: 'committed_receipt_after_link', families: [] } }],
        [['context.write'], { 'context.write': { kind: 'committed_receipt_after_link', families: [1] } }],
        [['context.read', 'context.read'], { 'context.read': RESUME }],
        [['telepathy'], { telepathy: RESUME }],
        [['context.read'], [RESUME]],
        [['context.read'], { 'context.read': { kind: 'committed_receipt_after_link', families: ['integration_verify_ready'] } }],
        [['context.read'], { 'context.read': { kind: 'committed_receipt_after_link', families: ['record_mutation', 'integration_ready_projection'] } }],
      ];
      for (const [i, [caps, rules]] of bad.entries()) {
        await assert.rejects(PROFILE(`test.bad-${i}`, caps, rules), /violates check constraint/, JSON.stringify(rules));
      }
      await assert.rejects(PROFILE('Bad Id', ['context.read'], { 'context.read': RESUME }), /violates check constraint/);
      await assert.rejects(PROFILE('test.zero-ttl', ['context.read'], { 'context.read': RESUME }, { ttl: '0 seconds' }), /violates check constraint/);
    });

    // Plugin line S3 (Cross-Host v0.2.6 §20, §41.0; Task 9966975d): the production READY profiles that
    // 20261007060000_integration_runtime_ready_profiles.sql seeds, one per registered Host surface. Kept in
    // this suite, which already applies every migration, so S3 adds no database of its own to CI.
    await t.test('S3 READY profiles: one continuity profile per registered surface', async () => {
      const S3_MIGRATION = '20261007060000_integration_runtime_ready_profiles.sql';
      const S3_FAMILIES = ['record_mutation', 'decision_supersede'];
      assert.ok(migrations.includes(S3_MIGRATION));
      const { rows } = await admin.query(`select profile_id, profile_version, required_capabilities, required_qualification,
          evidence_rules, extract(epoch from freshness_ttl)::bigint ttl,
          clued_private.integration_ready_rules_valid_v1(required_capabilities, evidence_rules) rules_valid
        from clued_private.integration_ready_profiles_v1
        where profile_id like any (array['anthropic.%', 'openai.%']) order by profile_id`);
      // one profile per surface of the two seeded Hosts (this suite adds test.* hosts of its own)
      const surfaces = (await admin.query(`select host || '.' || surface || '.continuity' id
        from clued_private.integration_host_surfaces_v1 where host in ('anthropic.claude', 'openai.chatgpt')
        order by 1`)).rows.map((r) => r.id);
      assert.equal(surfaces.length, 7);
      assert.deepEqual(rows.map((r) => r.profile_id), surfaces);
      for (const row of rows) {
        assert.equal(row.profile_version, 1, row.profile_id);
        assert.deepEqual(row.required_capabilities, ['context.read', 'context.write'], row.profile_id);
        assert.equal(row.required_qualification, 'ANY', row.profile_id);
        assert.equal(Number(row.ttl), 30 * 24 * 3600, row.profile_id);
        assert.equal(row.rules_valid, true, row.profile_id);
        assert.deepEqual(row.evidence_rules, {
          'context.read': { kind: 'resume_after_link' },
          'context.write': { kind: 'committed_receipt_after_link', families: S3_FAMILIES },
        }, row.profile_id);
      }
      // the evidence families are operation families Clued writes for ordinary record and decision writes
      const older = await Promise.all(migrations.filter((name) => name < S3_MIGRATION)
        .map((name) => fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')));
      for (const family of S3_FAMILIES) {
        assert.ok(older.some((text) => text.includes(`'${family}'`)), `${family} is an operation family`);
      }
    });
    const closeout=await findGatewayCloseoutMigration(root);
    const callerCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeout), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin),callerCatalog,'G6 replay preserves current Native/Binding definitions and ACL');
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory).catch(() => {});
  }
});
