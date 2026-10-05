import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// S2c Integration Runtime PR-4 (IntegrationRuntime v0.1.8 §14.1): revoke (Native / Binding revoke_self /
// Operator), restore / regrant, reauth mark / clear, capability_expansion, lifecycle, §10.5 REPLACE_HOLDER
// rule 2. Proves G-A11 (T-A11-1…25 except the Worker transport cases T-A11-4b(a)(d), which are PR-5, and the
// PR-2 cases T-A11-15(d), T-A11-17(a), T-A11-20(c)(d) already in integration-runtime-identity-db), T-A9-2 and the
// remaining G-A9 criteria (T-A9-4, -5, -6, -8, -10, -12), and the PR-4 structure checks (T-S-1…3, T-S-5).
// Every database runs as a non-root OS user (embedded-postgres refuses root).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261005150000_integration_runtime_revocation_lifecycle.sql';
const EARLIER_RPCS = ['clued_integration_request_open_v1', 'clued_integration_create_or_bind_v1',
  'clued_integration_identity_update_v1', 'clued_integration_reconcile_request_v1', 'clued_integration_status_v1',
  'clued_integration_declare_v1', 'clued_integration_report_v1', 'clued_integration_verify_v1'];
const BINDING_RPCS = [...EARLIER_RPCS, 'clued_integration_revoke_self_v1'];
const REPLACED = ['clued_private.integration_view_v1(uuid,timestamp with time zone)',
  'clued_private.integration_normalize_detail_v1(uuid,timestamp with time zone)',
  'clued_private.integration_reconcile_core_v1(jsonb,uuid,jsonb,text)', 'clued_user_integration_v1(jsonb)',
  'clued_admin_integration_v1(jsonb)'];
const STATES = ['INSTALL_PENDING', 'INSTALLED', 'AUTH_PENDING', 'VERIFYING', 'ACTIVE', 'DEGRADED', 'BLOCKED',
  'REAUTH_REQUIRED', 'INCOMPATIBLE', 'REVOKED'];
const FULL = ['audit.read', 'context.read', 'context.write', 'development_history.read', 'evidence.write',
  'project.read', 'project.write'];
const TRANSPORT = { protocol_version: '2025-06-18', build_sha: 'a'.repeat(40) };
const REBIND_CLASS = ['REAUTHORIZATION', 'REINSTALL', 'RECOVERY', 'REBIND', 'ADAPTER_MIGRATION', 'VERIFICATION_REPAIR'];

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

test('S2c PR-4: revocation, restore, reauth marks, capability expansion and lifecycle', { timeout: 1_800_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-lifecycle-'));
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
    for (const name of migrations.filter((name) => name > MIGRATION)) await apply(name);


    // ---- structure (§13.7) -------------------------------------------------------------------------
    await t.test('T-S-3 the migration adds functions only and replaces only five S2c objects', () => {
      for (const kind of ['relations', 'policies']) {
        for (const [name, value] of Object.entries(before[kind] ?? {})) assert.deepEqual(after[kind]?.[name], value, `${kind} ${name} changed`);
      }
      assert.deepEqual(Object.keys(after.relations).filter((name) => !(name in before.relations)), [], 'no new relation (T-S-1)');
      assert.deepEqual(after.roles, before.roles);
      for (const name of REPLACED) assert.ok(name in before.functions, `${name} exists before`);
      for (const [name, value] of Object.entries(before.functions)) {
        if (REPLACED.includes(name)) {
          assert.notEqual(after.functions[name].def, value.def, `${name} is replaced`);
          assert.deepEqual({ ...after.functions[name], def: null }, { ...value, def: null }, `${name} keeps its privileges and owner`);
        } else {
          assert.deepEqual(after.functions[name], value, `function ${name} changed`);
        }
      }
      for (const name of Object.keys(after.functions).filter((name) => !(name in before.functions))) {
        assert.match(name, /^(clued_private\.integration_|clued_integration_revoke_self_v1\()/, name);
      }
      assert.deepEqual(Object.keys(after.policies ?? {}).filter((name) => !(name in (before.policies ?? {}))), []);
    });

    await t.test('T-S-2 no EXECUTE on any Integration function before the target grants (OQ-21)', async () => {
      const { rows } = await admin.query(`select p.oid::regprocedure::text f,
          bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) any_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
        where (n.nspname = 'clued_private' and p.proname like 'integration\\_%')
           or (n.nspname = 'public' and (p.proname like 'clued\\_integration\\_%'
               or p.proname in ('clued_user_integration_v1', 'clued_admin_integration_v1')))
        group by p.oid`);
      for (const row of rows) assert.equal(row.any_execute, false, row.f);
      const publicRpcs = rows.map((row) => row.f).filter((f) => !f.startsWith('clued_private.')).map((f) => f.replace(/\(.*$/, '')).sort();
      for (const name of [...BINDING_RPCS, 'clued_user_integration_v1', 'clued_admin_integration_v1']) assert.ok(publicRpcs.includes(name), name);
    });

    // the §5.13 target grants, exactly as the flag-enabling migration will apply them (§13.0)
    for (const rpc of BINDING_RPCS) await admin.query(`grant execute on function public.${rpc}(text, jsonb) to anon, authenticated`);
    await admin.query('grant execute on function public.clued_user_integration_v1(jsonb) to authenticated');
    await admin.query('grant execute on function public.clued_admin_integration_v1(jsonb) to authenticated');

    await t.test('T-S-2 after the target grants: exactly §5.13', async () => {
      const { rows } = await admin.query(`select p.proname, array_agg(r.rolname order by r.rolname) filter (where
          has_function_privilege(r.rolname, p.oid, 'execute')) roles
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
        where n.nspname = 'public' and p.proname = any($1)
        group by p.proname order by p.proname`, [[...BINDING_RPCS, 'clued_user_integration_v1', 'clued_admin_integration_v1']]);
      assert.equal(rows.length, BINDING_RPCS.length + 2);
      for (const row of rows) {
        assert.deepEqual(row.roles, row.proname.startsWith('clued_integration_') ? ['anon', 'authenticated'] : ['authenticated'], row.proname);
      }
    });

    // ---- fixtures ----------------------------------------------------------------------------
    const newUser = async () => {
      const id = uid();
      await admin.query('insert into auth.users(id, email) values ($1, $2)', [id, `${id}@clued.test`]);
      return id;
    };
    const rawBinding = async (user, { scopes = ['context:read', 'context:write', 'audit:read'], db = admin } = {}) => {
      const token = `clued_bnd_${crypto.randomBytes(24).toString('hex')}`;
      const { rows } = await db.query(`insert into public.clued_agent_bindings(user_id, vendor, agent_name, token_hash, scopes)
        values ($1, 'Test', 'raw', $2, $3) returning id`, [user, sha(token), scopes]);
      return { id: rows[0].id, token, hash: sha(token), user };
    };
    const issuer = sha('integration-lifecycle-issuer');
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash, resource, name)
      values ($1, 'https://clued.test/mcp', 'test issuer')`, [issuer]);
    const DEFAULT_ENTRIES = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] }];
    const oauthBinding = async (user, { client = `client-${uid()}`, scopes = ['context:read', 'context:write'],
      entries = DEFAULT_ENTRIES, db = admin } = {}) => {
      const binding = await rawBinding(user, { scopes, db });
      const request = (await db.query(`insert into clued_private.authorization_requests_v12(owner_id, issuer_hash,
          request_digest, client_id, client_name, redirect_uri, resource, requested_scopes, eligible, status, binding_id)
        values ($1, $2, $3, $4, $4, 'https://host.test/cb', 'https://clued.test/mcp', $5, '[]', 'approved', $6) returning id`,
      [user, issuer, sha(uid()), client, scopes, binding.id])).rows[0].id;
      await db.query(`insert into clued_private.authorizations_v12(binding_id, request_id, owner_id, client_id, client_name,
          resource, expires_at, issuance) values ($1, $2, $3, $4, $4, 'https://clued.test/mcp', now() + interval '20 days', 'oauth')`,
      [binding.id, request, user, client]);
      for (const entry of entries) {
        await db.query(`insert into clued_private.authorization_entries_v12(binding_id, resource_kind, resource_id,
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
    const rpc = async (client, name, binding, input) =>
      (await client.query(`select public.${name}($1, $2::jsonb) r`, [binding.hash ?? binding, JSON.stringify(input)])).rows[0].r;
    const asUser = async (fn, user, input, claims = {}) => {
      await admin.query('begin');
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


    // ---- PR-4 helpers ------------------------------------------------------------------------------
    const tenant = (value) => ({ status: 'VALUE', value, evidence_kind: 'TEST_TENANT_ID' });
    // an ordinary existing tool call (§10.10: resolve_binding fails closed on a revoked Binding)
    const tool = async (binding) => {
      try {
        await admin.query(`select clued_private.resolve_binding($1, 'context:read', 'global')`, [binding.hash]);
        return 'ok';
      } catch (error) {
        return error.message;
      }
    };
    const call = async (promise) => {
      try {
        return await promise;
      } catch (error) {
        return { thrown: error.message };
      }
    };
    const openReq = (binding, input) => rpc(admin, 'clued_integration_request_open_v1', binding, { request_key: key('request'),
      host: 'test.complete', host_surface: 'default', adapter_family: 'test-adapter', adapter_version: '1.0.0',
      installation_phase: 'COMPLETED', ...input });
    // a Binding opens a Request and consumes it (any intent); throws become {thrown}
    const bindAs = async (binding, intent, input = {}) => call((async () => {
      const opened = await openReq(binding, { intent: intent.toLowerCase(), ...input });
      return rpc(admin, 'clued_integration_create_or_bind_v1', binding, { idempotency_key: key('bind'),
        request_id: opened.request_id, binding_intent: intent });
    })());
    const bindTo = async (binding, id, intent, input = {}) => {
      const i = await integration(id);
      return bindAs(binding, intent, { target_integration_id: id, host: i.host,
        host_surface: i.host === 'anthropic.claude' ? 'chat' : 'default', ...input });
    };
    const claude = async (binding) => {
      const r = await bindAs(binding, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      return r.supplemental.integration_id;
    };
    const revoke = (user, id, extra = {}) => native(user, { op: 'revoke', idempotency_key: key('revoke'), integration_id: id,
      reason: 'owner revoke', ...extra });
    const opRevoke = (id, by = 'SECURITY', extra = {}) => operator({ op: 'revoke', idempotency_key: key('revoke'), integration_id: id,
      reason: 'operator revoke', revoked_by: by, ...extra });
    const revokeSelf = (binding, id, extra = {}) => call(rpc(admin, 'clued_integration_revoke_self_v1', binding, {
      idempotency_key: key('self'), integration_id: id, reason: 'host disconnect', ...extra }));
    const restore = async (user, id, binding, extra = {}) => call(native(user, { op: 'restore', idempotency_key: key('restore'),
      integration_id: id, base_version: await version(id), new_binding_id: binding.id ?? binding, ...extra }));
    const opRestore = async (id, binding, extra = {}) => call(operator({ op: 'restore', idempotency_key: key('restore'),
      integration_id: id, base_version: await version(id), new_binding_id: binding.id ?? binding, ...extra }));
    const mark = async (id, extra = {}) => operator({ op: 'reauth_mark', idempotency_key: key('mark'), integration_id: id,
      base_version: await version(id), reason: 'PROVIDER_RECONFIRMATION', raised_by: 'CLUED', ...extra });
    const clearMark = async (id, markId) => operator({ op: 'reauth_clear', idempotency_key: key('clear'), integration_id: id,
      base_version: await version(id), mark_id: markId, reason: 'operator cleared' });
    const lifecycle = async (user, id, action, extra = {}) => native(user, { op: 'lifecycle', idempotency_key: key('life'),
      integration_id: id, base_version: await version(id), action, ...extra });
    const opLifecycle = async (op, id, extra = {}) => operator({ op, idempotency_key: key('life'), integration_id: id,
      base_version: await version(id), ...extra });
    const issuerRevoke = (binding) => admin.query('select public.clued_authorization_revoke_issuer_v12($1, $2)', [issuer, binding.id]);
    const selfRevokeV12 = (binding) => admin.query('select public.clued_authorization_revoke_self_v12($1)', [binding.hash]);
    const authVersion = async (binding) => Number((await admin.query('select version from clued_private.authorizations_v12 where binding_id = $1',
      [binding.id])).rows[0].version);
    const manage = async (binding, input) => asUser('clued_authorization_manage_v12', binding.user,
      { binding_id: binding.id, base_version: await authVersion(binding), ...input });
    const bindingRow = async (id) => (await admin.query('select * from public.clued_agent_bindings where id = $1', [id])).rows[0];
    const authRow = async (id) => (await admin.query('select * from clued_private.authorizations_v12 where binding_id = $1', [id])).rows[0];
    const revoked = async (binding) => (await bindingRow(binding.id ?? binding)).revoked_at !== null;
    const openRow = async (id) => (await admin.query(`select * from clued_private.integration_revocations_v1
      where integration_id = $1 and restored_by_regrant_id is null`, [id])).rows[0] ?? null;
    const rowCount = async (id) => Number((await admin.query('select count(*) n from clued_private.integration_revocations_v1 where integration_id = $1',
      [id])).rows[0].n);
    const ownerOf = async (binding) => (await admin.query('select * from clued_private.integration_binding_owners_v1 where binding_id = $1',
      [binding.id ?? binding])).rows[0] ?? null;
    const currentBinding = async (id) => (await admin.query(`select binding_id from clued_private.integration_connections_v1
      where integration_id = $1 and link_status = 'CURRENT'`, [id])).rows[0]?.binding_id ?? null;
    const opLog = async (id, type) => (await admin.query(`select * from clued_private.integration_operation_log_v1
      where integration_id = $1 and operation_type = $2 order by recorded_at`, [id, type])).rows;
    const source = async (id) => (await evaluate(id)).facts.revocation_source;
    const expire = (binding) => admin.query(`update clued_private.authorizations_v12 set expires_at = clock_timestamp() - interval '1 second'
      where binding_id = $1`, [binding.id]);
    const receiptCount = async () => Number((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n);
    const sorted = (xs) => [...xs].sort();
    // test.tenant: H holds (P, client); I, created without a tenant, strengthens to P and conflicts (§6.5)
    const conflictPair = async (client = `pair-${uid()}`, owner = null) => {
      const user = owner ?? await newUser();
      const bh = await oauthBinding(user, { client });
      const h = await install(bh, { host: 'test.tenant', tenant: tenant('P') });
      const bi = await oauthBinding(user, { client });
      const i = await install(bi, { host: 'test.tenant' });
      const u = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: i,
        base_version: await version(i), tenant: tenant('P') });
      assert.equal(u.supplemental.identity_claim_state, 'CLAIM_CONFLICT', JSON.stringify(u));
      return { user, bh, bi, h, i, client };
    };
    const reconcile = async (user, i, h, resolution) => native(user, { op: 'reconcile', idempotency_key: key('reconcile'),
      integration_id: i, resolution, base_version: await version(i), holder_base_version: await version(h) });
    // the Owner confirms a cross-client connection (NATIVE_OWNER_CONFIRMED, §10.1)
    const confirm = async (user, id, binding) => {
      const i = await integration(id);
      const opened = await openReq(binding, { intent: 'rebind', target_integration_id: id, host: i.host,
        host_surface: i.host === 'anthropic.claude' ? 'chat' : 'default' });
      const r = await native(user, { op: 'confirm_rebind', idempotency_key: key('confirm'), request_id: opened.request_id,
        binding_id: binding.id, base_version: await version(id) });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      return r;
    };

    // ---- G-A11 (§13.5) ------------------------------------------------------------------------------
    await t.test('T-S-5 revoke_self without a valid token reads and writes nothing (403 before any Receipt)', async () => {
      const { binding, id } = await active();
      const other = await active();
      const sameOwner = await oauthBinding(other.user);
      const r0 = await receiptCount(); const g0 = await guarded();
      assert.equal((await revokeSelf({ hash: sha('nobody') }, id)).thrown, 'binding_not_authorized');
      assert.equal((await revokeSelf({ hash: 'not-a-hash' }, id)).thrown, 'binding_not_authorized');
      assert.equal((await revokeSelf(other.binding, id)).thrown, 'integration_not_owned');
      assert.equal((await revokeSelf(sameOwner, other.id)).thrown, 'integration_connection_required');
      assert.equal(await receiptCount(), r0);
      assert.deepEqual(await guarded(), g0);
      assert.equal(await state(id), 'ACTIVE');
      assert.equal(await tool(binding), 'ok');
    });

    await t.test('T-A11-1 a real revocation is not cleared by an ordinary OAuth retry (test.complete + clued.oauth.v12)', async () => {
      const client = `c-${uid()}`;
      const { user, binding, id } = await active({}, { client });
      const r = await revoke(user, id);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal(r.supplemental.outcome, 'REVOKED');
      const row = await openRow(id);
      assert.equal(row.revocation_source, 'INTEGRATION_REVOKE');
      assert.equal(row.revoked_by, 'USER');
      assert.deepEqual(row.revoked_binding_ids, [binding.id]);
      assert.ok(r.target_refs.some((x) => x.role === 'revocation' && x.id === row.revocation_id));
      assert.equal(await state(id), 'REVOKED');
      assert.ok(await revoked(binding));
      assert.notEqual((await authRow(binding.id)).revoked_at, null);
      const fresh = await oauthBinding(user, { client });
      for (const intent of REBIND_CLASS) {
        const x = await bindTo(fresh, id, intent);
        assert.equal(x.status, 'rejected', `${intent} ${JSON.stringify(x)}`);
        assert.equal(x.error_code, 'integration_revoked_requires_explicit_restore', intent);
      }
      const create = await bindAs(fresh, 'CREATE_OR_BIND');
      assert.equal(create.error_code, 'integration_revoked_requires_explicit_restore', JSON.stringify(create));
      assert.equal(await state(id), 'REVOKED');
      assert.equal(await ownerOf(fresh), null);
    });

    await t.test('T-A11-1b an incomplete identity creates a new Integration; the revoked one is never restored', async () => {
      const user = await newUser();
      const client = `c-${uid()}`;
      const b = await oauthBinding(user, { client });
      const id = await claude(b);
      assert.equal((await integration(id)).identity_completeness, 'INCOMPLETE');
      assert.equal((await revoke(user, id)).status, 'committed');
      const fresh = await oauthBinding(user, { client });
      const created = await bindAs(fresh, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal(created.status, 'committed', JSON.stringify(created));
      assert.equal(created.supplemental.outcome, 'CREATE');
      const i2 = await integration(created.supplemental.integration_id);
      assert.notEqual(i2.integration_id, id);
      assert.equal(i2.created_receipt_id, created.receipt_id);
      assert.ok(['INSTALL_PENDING', 'VERIFYING', 'AUTH_PENDING'].includes(await state(i2.integration_id)));
      assert.equal(await state(id), 'REVOKED');
      assert.ok(await revoked(b));
      assert.equal((await bindTo(fresh, id, 'REBIND')).error_code, 'integration_revoked_requires_explicit_restore');
      // clued.binding.v1: a new raw Binding is a new provider connection, hence a new key
      const raw = await rawBinding(user);
      const rid = await install(raw);
      assert.equal((await revoke(user, rid)).status, 'committed');
      const raw2 = await rawBinding(user);
      const c2 = await bindAs(raw2, 'CREATE_OR_BIND');
      assert.equal(c2.supplemental.outcome, 'CREATE', JSON.stringify(c2));
      assert.notEqual(c2.supplemental.integration_id, rid);
      assert.equal(await state(rid), 'REVOKED');
    });

    await t.test('T-A11-2 no recovery through cached or never-linked credentials; the sweep and its siblings', async () => {
      const client = `c-${uid()}`;
      const { user, binding, id } = await active({}, { client });
      const pre = await oauthBinding(user, { client });            // issued before the revoke, never linked
      const other = await oauthBinding(user);                       // another client
      const m = await mark(id);
      assert.equal(m.status, 'committed', JSON.stringify(m));
      const r = await revoke(user, id);
      const after = await oauthBinding(user, { client });           // a new decision after t_rev
      assert.equal(await tool(binding), 'binding_not_authorized');
      assert.equal((await call(verify(binding, id))).thrown, 'binding_not_authorized');
      assert.equal((await call(declare(binding, id))).thrown, 'binding_not_authorized');
      assert.equal(await tool(pre), 'binding_not_authorized');
      const o = await ownerOf(pre);
      assert.equal(o.acquired_via, 'REVOCATION_SWEEP');
      assert.equal(o.integration_id, id);
      assert.deepEqual(r.supplemental.swept_unowned_binding_ids.map((x) => x.binding_id), [pre.id]);
      assert.deepEqual(sorted(r.supplemental.revoked_binding_ids), sorted([binding.id, pre.id]));
      assert.equal(await tool(other), 'ok');
      assert.equal(await tool(after), 'ok');
      assert.equal(await ownerOf(after), null);
      // Operator reauth_clear does not change REVOKED
      const cleared = await clearMark(id, m.supplemental.mark_id);
      assert.equal(cleared.status, 'committed', JSON.stringify(cleared));
      assert.equal(await state(id), 'REVOKED');
      // v0.1.6 MINOR-N22: two incomplete same-client Integrations share a lineage
      const user2 = await newUser();
      const c2 = `c-${uid()}`;
      const i1 = await claude(await oauthBinding(user2, { client: c2 }));
      const i2 = await claude(await oauthBinding(user2, { client: c2 }));
      const sib = await oauthBinding(user2, { client: c2 });       // a reconnect meant for I2, not yet linked
      assert.equal((await lifecycle(user2, i1, 'pause')).status, 'committed');
      assert.equal(await tool(sib), 'ok', 'pause sweeps nothing');
      const r2 = await revoke(user2, i1);
      const swept = r2.supplemental.swept_unowned_binding_ids.find((x) => x.binding_id === sib.id);
      assert.ok(swept, JSON.stringify(r2.supplemental));
      assert.deepEqual(swept.sibling_integration_ids, [i2]);
      assert.equal(await tool(sib), 'binding_not_authorized');
      assert.notEqual(await state(i2), 'REVOKED');
    });

    await t.test('T-A11-3 explicit restore: new Receipt and provenance, VERIFYING, marks cleared, superseded refused', async () => {
      const client = `c-${uid()}`;
      const { user, binding, id } = await active({}, { client });
      const m = await mark(id);
      const otherPre = await oauthBinding(user);                    // another client, issued before the revoke
      const samePre = await oauthBinding(user, { client });         // swept by the revoke
      assert.equal((await revoke(user, id)).status, 'committed');
      for (const b of [otherPre, samePre]) {
        const stale = await restore(user, id, b);
        assert.equal(stale.status, 'rejected', JSON.stringify(stale));
        assert.equal(stale.error_code, 'restore_requires_new_authorization_decision');
      }
      const fresh = await oauthBinding(user, { client });
      const ok = await restore(user, id, fresh);
      assert.equal(ok.status, 'committed', JSON.stringify(ok));
      assert.equal(ok.supplemental.restore_kind, 'REVOCATION');
      assert.deepEqual(ok.supplemental.cleared_reauth_mark_ids, [m.supplemental.mark_id]);
      const regrant = (await admin.query('select * from clued_private.integration_regrants_v1 where regrant_id = $1',
        [ok.supplemental.regrant_id])).rows[0];
      assert.equal(regrant.receipt_id, ok.receipt_id);
      assert.equal(regrant.decided_by, 'USER');
      assert.equal(regrant.new_binding_id, fresh.id);
      assert.equal(await openRow(id), null);
      assert.equal(await state(id), 'VERIFYING');
      assert.ok(await revoked(binding));
      assert.equal(await currentBinding(id), fresh.id);
      assert.equal((await admin.query('select cleared_by from clued_private.integration_reauth_marks_v1 where mark_id = $1',
        [m.supplemental.mark_id])).rows[0].cleared_by, 'RESTORE');
      assert.equal((await mark(id)).status, 'committed');
      assert.equal(await state(id), 'REAUTH_REQUIRED');
      // a revoked holder superseded by REPLACE_HOLDER cannot be restored
      const pair = await conflictPair();
      assert.equal((await revoke(pair.user, pair.h)).status, 'committed');
      assert.equal((await reconcile(pair.user, pair.i, pair.h, 'REPLACE_HOLDER')).status, 'committed');
      const late = await oauthBinding(pair.user, { client: pair.client });
      const sup = await restore(pair.user, pair.h, late);
      assert.equal(sup.error_code, 'integration_superseded', JSON.stringify(sup));
    });

    await t.test('T-A11-4 expiry and reauth marks → REAUTH_REQUIRED; a Host disconnect → REVOKED; FORBIDS_REAUTH → BLOCKED', async () => {
      const a = await active();
      const v0 = await version(a.id);
      await expire(a.binding);
      assert.equal(await state(a.id), 'REAUTH_REQUIRED');
      assert.equal(await version(a.id), v0, 'derived at read time, no write');
      const b = await active();
      assert.equal((await mark(b.id)).status, 'committed');
      assert.equal(await state(b.id), 'REAUTH_REQUIRED');
      const c = await active();
      await issuerRevoke(c.binding);
      assert.equal(await state(c.id), 'REVOKED');
      assert.equal(await source(c.id), 'CONNECTION_USER_REVOKE');
      const refused = await mark(c.id);
      assert.equal(refused.error_code, 'integration_revoked_requires_explicit_restore');
      assert.equal(await rowCount(c.id), 0, 'a rejected write leaves no materialized row');
      const d = await active();
      assert.equal((await opLifecycle('recovery_policy', d.id, { value: 'FORBIDS_REAUTH' })).status, 'committed');
      await expire(d.binding);
      assert.equal(await state(d.id), 'BLOCKED');
    });

    await t.test('T-A11-4b (b)(c) every connection-level revoke derives REVOKED; restore materializes the adopted row', async () => {
      const cases = [['manage', 'revoke', 'USER'], ['revoke_self_v12', 'revoke_self', 'USER_VIA_HOST'],
        ['revoke_issuer', 'revoke_issuer', 'USER_VIA_HOST'], ['raw', null, 'USER']];
      for (const [how, operation, by] of cases) {
        const client = `c-${uid()}`;
        const { user, binding, id } = await active({}, { client });
        if (how === 'manage') await manage(binding, { op: 'revoke' });
        else if (how === 'revoke_self_v12') await selfRevokeV12(binding);
        else if (how === 'revoke_issuer') await issuerRevoke(binding);
        else await admin.query('update public.clued_agent_bindings set revoked_at = clock_timestamp() where id = $1', [binding.id]);
        assert.equal(await state(id), 'REVOKED', how);
        assert.equal(await source(id), 'CONNECTION_USER_REVOKE', how);
        const fresh = await oauthBinding(user, { client });
        assert.equal((await bindTo(fresh, id, 'REAUTHORIZATION')).error_code, 'integration_revoked_requires_explicit_restore', how);
        assert.equal((await bindAs(fresh, 'CREATE_OR_BIND')).error_code, 'integration_revoked_requires_explicit_restore', how);
        const r = await restore(user, id, fresh);
        assert.equal(r.status, 'committed', `${how} ${JSON.stringify(r)}`);
        assert.ok(r.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'), how);
        const row = (await admin.query('select * from clued_private.integration_revocations_v1 where revocation_id = $1',
          [r.supplemental.revocation_id])).rows[0];
        assert.equal(row.revocation_source, 'CONNECTION_REVOKE_ADOPTED', how);
        assert.equal(row.adopted_from.audit_operation, operation, how);
        assert.equal(row.revoked_by, by, how);
        assert.equal(row.receipt_id, r.receipt_id, how);
        assert.deepEqual(row.revoked_binding_ids, [binding.id], how);
        assert.equal(await state(id), 'VERIFYING', how);
      }
    });

    await t.test('T-A11-5 no automatic expansion of scope, entries or authority through re-OAuth', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const WIDE = ['audit:read', 'context:read', 'context:write'];
      const big = await oauthBinding(user, { client, scopes: WIDE });           // older than the ceiling
      const extra = await oauthBinding(user, { client, entries: [...DEFAULT_ENTRIES,
        { resource_kind: 'context', resource_id: `project:${uid()}`, environment: 'canonical', actions: ['read'] }] });
      const { id } = await active({}, { client }, user);
      assert.equal((await mark(id)).status, 'committed');
      const same = await oauthBinding(user, { client });
      const ok = await bindTo(same, id, 'REAUTHORIZATION');
      assert.equal(ok.status, 'committed', JSON.stringify(ok));
      assert.equal(ok.supplemental.cleared_reauth_mark_ids.length, 1);
      assert.equal(await state(id), 'VERIFYING');
      await resume(same);
      assert.equal((await verify(same, id)).supplemental.result, 'PASS');
      assert.equal(await state(id), 'ACTIVE');
      assert.equal((await bindTo(big, id, 'REAUTHORIZATION')).error_code, 'reauthorization_scope_expansion_forbidden');
      assert.equal((await bindTo(extra, id, 'REAUTHORIZATION')).error_code, 'reauthorization_scope_expansion_forbidden');
      const consent = await oauthBinding(user, { client, scopes: WIDE });
      const accepted = await bindTo(consent, id, 'REAUTHORIZATION');
      assert.equal(accepted.status, 'committed', JSON.stringify(accepted));
      assert.ok(accepted.supplemental.outcome_flags.includes('AUTHORITY_EXPANDED_BY_CONSENT'));
      assert.ok(accepted.supplemental.ceiling_before && accepted.supplemental.ceiling_after);
      // raw Binding: no consent page; expansion only through the Native capability_expansion
      const user2 = await newUser();
      const raw = await rawBinding(user2, { scopes: ['context:read'] });
      const rid = await install(raw);
      await admin.query(`update public.clued_agent_bindings set scopes = $2 where id = $1`, [raw.id, WIDE]);
      assert.equal((await bindTo(raw, rid, 'VERIFICATION_REPAIR')).error_code, 'reauthorization_scope_expansion_forbidden');
      const narrower = await native(user2, { op: 'capability_expansion', idempotency_key: key(), integration_id: rid,
        base_version: await version(rid), new_ceiling: { scopes: [], entries: 'LEGACY_UNRESTRICTED' } });
      assert.equal(narrower.error_code, 'invalid_capability_expansion');
      const expanded = await native(user2, { op: 'capability_expansion', idempotency_key: key(), integration_id: rid,
        base_version: await version(rid), new_ceiling: { scopes: WIDE, entries: 'LEGACY_UNRESTRICTED' } });
      assert.equal(expanded.status, 'committed', JSON.stringify(expanded));
      const after = await bindTo(raw, rid, 'VERIFICATION_REPAIR');
      assert.equal(after.status, 'committed', JSON.stringify(after));
    });

    await t.test('T-A11-6 / T-A11-7 REVOKED wins over reauth marks, incompatibility, claim conflict and expiry', async () => {
      const { user, id } = await active();
      const m = await mark(id);
      assert.equal((await revoke(user, id)).status, 'committed');
      assert.equal(await state(id), 'REVOKED');
      assert.equal((await clearMark(id, m.supplemental.mark_id)).status, 'committed');
      assert.equal(await state(id), 'REVOKED');
      // expiry
      const a = await active();
      await revoke(a.user, a.id);
      await expire(a.binding);
      assert.equal(await state(a.id), 'REVOKED');
      // claim conflict
      const pair = await conflictPair();
      assert.equal((await revoke(pair.user, pair.i)).status, 'committed');
      assert.equal((await integration(pair.i)).identity_claim_state, 'CLAIM_CONFLICT');
      assert.equal(await state(pair.i), 'REVOKED');
      // hard incompatibility
      const family = `revoked-family-${uid()}`;
      const b = await active({ adapter_family: family });
      await admin.query(`insert into clued_private.integration_compatibility_rules_v1(host, adapter_family, min_adapter_version,
        below_minimum, registry_version) values ('test.complete', $1, '9.0.0', 'HARD_INCOMPATIBLE', 1)`, [family]);
      assert.equal(await state(b.id), 'INCOMPATIBLE');
      await revoke(b.user, b.id);
      assert.equal(await state(b.id), 'REVOKED');
    });

    await t.test('T-A11-8 revoke_self is limited to its own provider connection (PARTIAL_CONNECTION_REVOKE)', async () => {
      const user = await newUser();
      const c1 = `c1-${uid()}`;
      const b0 = await oauthBinding(user, { client: c1 });
      const id = await claude(b0);
      const b3 = await oauthBinding(user);                           // client C3, Owner-confirmed
      await confirm(user, id, b3);
      const b1 = await oauthBinding(user, { client: c1 });            // back to C1, Owner-confirmed
      await confirm(user, id, b1);
      assert.equal(await currentBinding(id), b1.id);
      const r = await revokeSelf(b1, id);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal(r.supplemental.outcome, 'PARTIAL_CONNECTION_REVOKE');
      assert.equal(r.supplemental.remaining_binding_count, 1);
      assert.ok(await revoked(b0));
      assert.ok(await revoked(b1));
      assert.equal(await tool(b3), 'ok');
      assert.equal(await rowCount(id), 0, 'no revocation row');
      assert.equal(await source(id), 'CONNECTION_USER_REVOKE');
      assert.equal((await opLog(id, 'PARTIAL_REVOKE'))[0].affected_binding_ids.length, 2);
      const owner = await revoke(user, id);
      assert.equal(owner.status, 'committed', JSON.stringify(owner));
      assert.ok(owner.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
      const row = await openRow(id);
      assert.deepEqual(row.revoked_binding_ids, [b1.id, b3.id]);
      assert.equal(await tool(b3), 'binding_not_authorized');
      const view = (await native(user, { op: 'status', integration_id: id })).integration.revocation;
      assert.deepEqual(sorted(view.revoked_binding_ids), sorted([b0.id, b1.id, b3.id]), 'row ∪ PARTIAL log');
      // without another identity the same call is a full revoke
      const user2 = await newUser();
      const c = `c-${uid()}`;
      const a0 = await oauthBinding(user2, { client: c });
      const id2 = await claude(a0);
      const a1 = await oauthBinding(user2, { client: c });
      assert.equal((await bindTo(a1, id2, 'REAUTHORIZATION')).status, 'committed');
      const full = await revokeSelf(a1, id2);
      assert.equal(full.supplemental.outcome, 'REVOKED', JSON.stringify(full));
      const row2 = await openRow(id2);
      assert.equal(row2.revocation_source, 'INTEGRATION_REVOKE');
      assert.equal(row2.revoked_by, 'USER_VIA_HOST');
      assert.deepEqual(sorted(row2.revoked_binding_ids), sorted([a0.id, a1.id]));
      // another Integration's current connection cannot revoke this one
      const a2 = await oauthBinding(user2);
      await claude(a2);
      const id3 = await claude(await oauthBinding(user2));
      assert.equal((await revokeSelf(a2, id3)).thrown, 'integration_connection_required');
    });

    await t.test('T-A11-9 revocation is unconditional: an invalid Integration is still revoked through every channel', async () => {
      const tamper = async (sql, params) => {
        await admin.query('begin');
        await admin.query('set local session_replication_role = replica');
        await admin.query(sql, params);
        await admin.query('commit');
      };
      for (const channel of ['native', 'operator', 'self']) {
        const { user, binding, id } = await active();
        const realKey = (await integration(id)).claim_key_sha256;
        await tamper(`update clued_private.integration_claims_v1 set claim_key_sha256 = $2 where integration_id = $1 and claim_status = 'CURRENT'`,
          [id, sha(`other-${uid()}`)]);
        const e = await evaluate(id);
        assert.equal(e.valid, false, channel);
        assert.ok(e.reason_codes.includes('C4_CLAIM_STORE_MISSING'), JSON.stringify(e.reason_codes));
        const r = channel === 'native' ? await revoke(user, id) : channel === 'operator' ? await opRevoke(id) : await revokeSelf(binding, id);
        assert.equal(r.status, 'committed', `${channel} ${JSON.stringify(r)}`);
        assert.ok(r.supplemental.outcome_flags.includes('CLAIM_STORE_DIVERGENT'), channel);
        assert.notEqual(await openRow(id), null, channel);
        assert.ok(await revoked(binding), channel);
        assert.equal(await tool(binding), 'binding_not_authorized', channel);
        await tamper(`update clued_private.integration_claims_v1 set claim_key_sha256 = $2 where integration_id = $1 and claim_status = 'CURRENT'`,
          [id, realKey]);
        assert.equal(await state(id), 'REVOKED', channel);
      }
    });

    // ---- concurrency helpers (a second and third connection) -------------------------------------
    const c2 = await connect();
    const c3 = await connect();
    const pidOf = async (db) => (await db.query('select pg_backend_pid() p')).rows[0].p;
    const pid3 = await pidOf(c3);
    const waitLocked = async (pid) => {
      for (let n = 0; n < 400; n += 1) {
        const { rows } = await admin.query('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`backend ${pid} is not waiting on a lock`);
    };
    // one call inside an already open transaction of db, as the Native / Operator session of user
    const sessionIn = async (db, fn, user, input) => {
      await db.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', '{}', true)`, [user]);
      return (await db.query(`select public.${fn}($1::jsonb) r`, [JSON.stringify(input)])).rows[0].r;
    };
    // a whole transaction on db (begin … commit), started now and awaited later
    const inTx = (db, body) => (async () => {
      await db.query('begin');
      try {
        const result = await body();
        await db.query('commit');
        return result;
      } catch (error) {
        await db.query('rollback');
        return { thrown: error.message };
      }
    })();
    const revokeOn = (db, user, id) => inTx(db, () => sessionIn(db, 'clued_user_integration_v1', user,
      { op: 'revoke', idempotency_key: key('revoke'), integration_id: id, reason: 'owner revoke' }));
    // Rev(I) = ∅ after an explicit revoke: every Binding I owns, and every never-linked same-client grant
    // issued before rev_at(I), is revoked
    const revEmpty = async (id) => (await admin.query(`select cardinality(clued_private.integration_rev_set_v1($1,
      clued_private.integration_rev_at_v1($1, clock_timestamp()))) n`, [id])).rows[0].n === 0;

    await t.test('T-A11-10 revoke vs create_or_bind: set change aborts and retries, reverse order refuses, invariant holds', async () => {
      // (a) a same-client reauthorization holds L5 (uncommitted); the revoke has S0 = {B1} locked and waits on L5
      const client = `c-${uid()}`;
      const user = await newUser();
      const b1 = await oauthBinding(user, { client });
      const id = await install(b1);
      await c2.query('begin');
      const b2 = await oauthBinding(user, { client, db: c2 });
      const opened = await rpc(c2, 'clued_integration_request_open_v1', b2, { request_key: key('request'), intent: 'reauthorization',
        target_integration_id: id, host: 'test.complete', host_surface: 'default', adapter_family: 'test-adapter',
        adapter_version: '1.0.0', installation_phase: 'COMPLETED' });
      const rebind = await rpc(c2, 'clued_integration_create_or_bind_v1', b2, { idempotency_key: key('bind'),
        request_id: opened.request_id, binding_intent: 'REAUTHORIZATION' });
      assert.equal(rebind.status, 'committed', JSON.stringify(rebind));
      const pending = revokeOn(c3, user, id);
      await waitLocked(pid3);
      const v0 = await version(id);
      await c2.query('commit');
      const first = await pending;
      assert.equal(first.status, 'rejected', JSON.stringify(first));
      assert.equal(first.error_code, 'integration_revoke_connection_set_changed');
      assert.ok(await version(id) > v0, 'the reauthorization committed');
      assert.equal(await openRow(id), null, 'no business write');
      const retry = await revoke(user, id);
      assert.equal(retry.status, 'committed', JSON.stringify(retry));
      assert.ok(await revoked(b1));
      assert.ok(await revoked(b2));
      // (b) reverse order: the revoke commits first, the reauthorization is refused
      const user2 = await newUser();
      const k1 = await oauthBinding(user2, { client });
      const id2 = await install(k1);
      const k2 = await oauthBinding(user2, { client });
      assert.equal((await revoke(user2, id2)).status, 'committed');
      assert.equal((await bindTo(k2, id2, 'REAUTHORIZATION')).thrown, 'binding_not_authorized', 'k2 was swept');
      const k3 = await oauthBinding(user2, { client });
      assert.equal((await bindTo(k3, id2, 'REAUTHORIZATION')).error_code, 'integration_revoked_requires_explicit_restore');
      // (c) random interleavings: after the (retried) revoke, I has an open row and Rev(I) = ∅
      for (let round = 0; round < 50; round += 1) {
        const u = await newUser();
        const c = `r-${uid()}`;
        const x1 = await oauthBinding(u, { client: c });
        const ix = await install(x1);
        const x2 = await oauthBinding(u, { client: c });
        const binder = inTx(c2, async () => {
          const o = await rpc(c2, 'clued_integration_request_open_v1', x2, { request_key: key('request'), intent: 'reauthorization',
            target_integration_id: ix, host: 'test.complete', host_surface: 'default', adapter_family: 'test-adapter',
            adapter_version: '1.0.0', installation_phase: 'COMPLETED' });
          return rpc(c2, 'clued_integration_create_or_bind_v1', x2, { idempotency_key: key('bind'), request_id: o.request_id,
            binding_intent: 'REAUTHORIZATION' });
        });
        let r = await (round % 2 === 0 ? revokeOn(c3, u, ix) : (async () => { await binder; return revokeOn(c3, u, ix); })());
        await binder;
        while (r.error_code === 'integration_revoke_connection_set_changed') r = await revoke(u, ix);
        assert.equal(r.status, 'committed', `round ${round} ${JSON.stringify(r)}`);
        assert.notEqual(await openRow(ix), null, `round ${round}`);
        assert.ok(await revEmpty(ix), `round ${round}: Rev(I) = ∅`);
        assert.ok(await revoked(x1), `round ${round}`);
        assert.ok(await revoked(x2), `round ${round}`);
      }
      // (d) a member of S0 revoked concurrently (manage_v12) before the revoke's L1: S1 ⊊ S0 commits
      const user3 = await newUser();
      const cl = `c-${uid()}`;
      const m1 = await oauthBinding(user3, { client: cl });
      const id3 = await install(m1);
      const m2 = await oauthBinding(user3, { client: cl });            // unowned lineage, in S0
      await c2.query('begin');
      await sessionIn(c2, 'clued_authorization_manage_v12', user3, { op: 'revoke', binding_id: m2.id, base_version: await authVersion(m2) });
      const racing = revokeOn(c3, user3, id3);
      await waitLocked(pid3);
      await c2.query('commit');
      const done = await racing;
      assert.equal(done.status, 'committed', JSON.stringify(done));
      assert.deepEqual(done.supplemental.revoked_binding_ids, [m1.id]);
      assert.ok(await revEmpty(id3));
    });

    await t.test('T-A11-11 derived REVOKED with a live HISTORICAL Binding: explicit revoke materializes and extends', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const bOld = await oauthBinding(user, { client });
      const id = await install(bOld);
      const bCur = await oauthBinding(user, { client });
      assert.equal((await bindTo(bCur, id, 'REAUTHORIZATION')).status, 'committed');
      // (a)
      await selfRevokeV12(bCur);
      assert.equal(await state(id), 'REVOKED');
      assert.equal(await rowCount(id), 0);
      assert.equal(await tool(bOld), 'ok');
      // (b)
      const r = await revoke(user, id);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.ok(r.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
      assert.equal(await rowCount(id), 1);
      const row = await openRow(id);
      assert.equal(row.revocation_source, 'CONNECTION_REVOKE_ADOPTED');
      assert.deepEqual(row.revoked_binding_ids, [bCur.id, bOld.id]);
      assert.equal(await tool(bOld), 'binding_not_authorized');
      // (c)
      const v = await version(id);
      const again = await revoke(user, id);
      assert.equal(again.supplemental.outcome, 'ALREADY_REVOKED');
      assert.deepEqual(again.committed_versions, {});
      assert.deepEqual(await openRow(id), row);
      assert.equal(await version(id), v);
      // (d) policy_pause materializes {B_cur} first; the Owner's revoke then extends the same row
      const user2 = await newUser();
      const old2 = await oauthBinding(user2, { client });
      const id2 = await install(old2);
      const cur2 = await oauthBinding(user2, { client });
      await bindTo(cur2, id2, 'REAUTHORIZATION');
      await selfRevokeV12(cur2);
      const paused = await opLifecycle('policy_pause', id2);
      assert.equal(paused.status, 'committed', JSON.stringify(paused));
      assert.ok(paused.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
      assert.ok(paused.target_refs.some((x) => x.role === 'revocation'));
      assert.deepEqual((await openRow(id2)).revoked_binding_ids, [cur2.id]);
      assert.equal(await tool(old2), 'ok');
      const ext = await revoke(user2, id2);
      assert.equal(ext.supplemental.outcome, 'REVOKED', JSON.stringify(ext));
      const row2 = await openRow(id2);
      assert.deepEqual(row2.revoked_binding_ids, [cur2.id, old2.id]);
      assert.deepEqual(row2.extended_receipt_ids, [ext.receipt_id]);
      assert.equal(await rowCount(id2), 1);
      assert.equal(await tool(old2), 'binding_not_authorized');
    });

    await t.test('T-A11-12 a revoke never crosses owners (C7 tampering is only counted)', async () => {
      const { user, binding, id } = await active();
      const stranger = await oauthBinding(await newUser());
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(`insert into clued_private.integration_connections_v1(integration_id, binding_id, connection_kind, link_status,
          unlinked_at, scopes_at_link, provider, provider_connection_id, link_authority, link_receipt_id)
        values ($1, $2, 'OAUTH_V12', 'HISTORICAL', clock_timestamp(), '{context:read}', 'clued.oauth.v12', $3, 'CREATE', gen_random_uuid())`,
      [id, stranger.id, sha(stranger.client)]);
      await admin.query(`insert into clued_private.integration_binding_owners_v1(binding_id, integration_id, owner_id, acquired_via,
          acquired_receipt_id) values ($1, $2, $3, 'FIRST_LINK', gen_random_uuid())`, [stranger.id, id, user]);
      await admin.query('commit');
      const before = await authRow(stranger.id);
      const r = await revoke(user, id);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal(r.supplemental.foreign_binding_count, 1);
      assert.equal(await revoked(stranger), false);
      assert.deepEqual(await authRow(stranger.id), before);
      assert.ok(await revoked(binding));
    });

    await t.test('T-A11-13 a v12 reduce lowers the ceiling used for the next link', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const b0 = await oauthBinding(user, { client });
      const id = await install(b0);
      const b1 = await oauthBinding(user, { client });
      assert.equal((await bindTo(b1, id, 'REAUTHORIZATION')).status, 'committed');
      const READ = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }];
      await manage(b1, { op: 'reduce', selected: READ });
      const reducedAt = (await admin.query(`select max(recorded_at) t from clued_private.authorization_audit_v12
        where binding_id = $1 and operation = 'reduce'`, [b1.id])).rows[0].t;
      assert.equal((await bindTo(b0, id, 'REAUTHORIZATION')).error_code, 'reauthorization_scope_expansion_forbidden');
      const narrow = await oauthBinding(user, { client, scopes: ['context:read'], entries: READ });
      const n = await bindTo(narrow, id, 'REAUTHORIZATION');
      assert.equal(n.status, 'committed', JSON.stringify(n));
      const i = await integration(id);
      assert.deepEqual(i.authorization_ceiling.scopes, ['context:read']);
      assert.equal(i.authorization_ceiling_set_at.toISOString(), reducedAt.toISOString());
      const consent = await oauthBinding(user, { client });
      const c = await bindTo(consent, id, 'REAUTHORIZATION');
      assert.equal(c.status, 'committed', JSON.stringify(c));
      assert.ok(c.supplemental.outcome_flags.includes('AUTHORITY_EXPANDED_BY_CONSENT'));
    });

    await t.test('T-A11-14 a revoked Integration with invalid facts still refuses a reauthorization', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const b = await oauthBinding(user, { client });
      const id = await install(b);
      assert.equal((await revoke(user, id)).status, 'committed');
      // invalid facts by tampering (C4: the holder's claim row no longer matches), then a same-client reauthorization
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      const realKey = (await integration(id)).claim_key_sha256;
      await admin.query(`update clued_private.integration_claims_v1 set claim_key_sha256 = $2 where integration_id = $1 and claim_status = 'CURRENT'`,
        [id, sha(`x-${uid()}`)]);
      await admin.query('commit');
      const e = await evaluate(id);
      assert.equal(e.valid, false);
      assert.equal(e.integration_state, null);
      assert.equal(e.facts.revocation_state, 'REVOKED');
      const connections = async () => Number((await admin.query(`select count(*) n from clued_private.integration_connections_v1
        where integration_id = $1`, [id])).rows[0].n);
      const n0 = await connections();
      const fresh = await oauthBinding(user, { client });
      assert.equal((await bindTo(fresh, id, 'REAUTHORIZATION')).error_code, 'integration_revoked_requires_explicit_restore');
      assert.equal(await connections(), n0);
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(`update clued_private.integration_claims_v1 set claim_key_sha256 = $2 where integration_id = $1 and claim_status = 'CURRENT'`,
        [id, realKey]);
      await admin.query('commit');
    });

    await t.test('T-A11-15 revocation scope after supersede, and REPLACE_HOLDER rule 2 over a revoked holder', async () => {
      // (a) REBIND_TO_HOLDER moves I's current and its old Binding to H
      const pa = await conflictPair();
      const iOld = pa.bi;
      const iCur = await oauthBinding(pa.user, { client: pa.client });
      assert.equal((await bindTo(iCur, pa.i, 'REAUTHORIZATION')).status, 'committed');
      const pre = await oauthBinding(pa.user, { client: pa.client });   // a same-client grant issued before I's revoke
      const moved = await reconcile(pa.user, pa.i, pa.h, 'REBIND_TO_HOLDER');
      assert.equal(moved.status, 'committed', JSON.stringify(moved));
      assert.deepEqual(sorted(moved.supplemental.ownership_transfer.map((x) => x.binding_id)), sorted([iOld.id, iCur.id]));
      assert.equal(await currentBinding(pa.h), iCur.id);
      await resume(iCur);
      assert.equal((await verify(iCur, pa.h)).supplemental.result, 'PASS');
      assert.equal(await state(pa.h), 'ACTIVE');
      const ri = await revoke(pa.user, pa.i);
      assert.equal(ri.status, 'committed', JSON.stringify(ri));
      assert.deepEqual(ri.supplemental.revoked_binding_ids, []);
      assert.equal(await state(pa.h), 'ACTIVE');
      // T-A11-25 (O7 excludes a SUPERSEDED X): the pre-revoke same-client grant still links to H
      assert.equal((await bindTo(pre, pa.h, 'REAUTHORIZATION')).status, 'committed');
      const rh = await revoke(pa.user, pa.h);
      assert.equal(rh.status, 'committed');
      for (const b of [iOld, iCur, pre]) assert.ok(await revoked(b));
      // (b) REPLACE_HOLDER, H not revoked: b_H unlinked and transferred with H's other Bindings
      const pb = await conflictPair();
      const replaced = await reconcile(pb.user, pb.i, pb.h, 'REPLACE_HOLDER');
      assert.equal(replaced.status, 'committed', JSON.stringify(replaced));
      assert.equal(await currentBinding(pb.h), null);
      assert.equal((await ownerOf(pb.bh)).integration_id, pb.i);
      assert.equal((await revoke(pb.user, pb.i)).status, 'committed');
      assert.equal(await tool(pb.bh), 'binding_not_authorized');
      // (c) H derived-revoked (revoke_issuer), with a live HISTORICAL B_oldH and a never-linked B_pre
      const pc = await conflictPair();
      const bhCur = await oauthBinding(pc.user, { client: pc.client });
      assert.equal((await bindTo(bhCur, pc.h, 'REAUTHORIZATION')).status, 'committed');
      const bOldH = pc.bh;
      const bPre = await oauthBinding(pc.user, { client: pc.client });
      await issuerRevoke(bhCur);
      assert.equal(await source(pc.h), 'CONNECTION_USER_REVOKE');
      const r = await reconcile(pc.user, pc.i, pc.h, 'REPLACE_HOLDER');
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.ok(r.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
      assert.deepEqual(r.supplemental.ownership_transfer, []);
      assert.equal(await rowCount(pc.h), 1);
      const row = await openRow(pc.h);
      assert.deepEqual(sorted(row.revoked_binding_ids), sorted([bhCur.id, bOldH.id, bPre.id]));
      assert.equal(row.revoked_binding_ids[0], bhCur.id);
      assert.deepEqual(row.extended_receipt_ids, []);
      assert.equal(row.receipt_id, r.receipt_id);
      assert.equal((await opLog(pc.h, 'RECONCILE_REVOKE')).length, 1);
      for (const b of [bOldH, bPre]) {
        assert.ok(await revoked(b));
        assert.equal((await ownerOf(b)).integration_id, pc.h);
      }
      assert.equal((await ownerOf(bPre)).acquired_via, 'REVOCATION_SWEEP');
      assert.equal((await bindTo(bOldH, pc.i, 'REBIND')).thrown, 'binding_not_authorized');
      // (e) H explicitly revoked (Rev(H) = ∅): REPLACE_HOLDER commits, H's row is untouched
      const pe = await conflictPair();
      assert.equal((await revoke(pe.user, pe.h)).status, 'committed');
      const rowE = await openRow(pe.h);
      const e = await reconcile(pe.user, pe.i, pe.h, 'REPLACE_HOLDER');
      assert.equal(e.status, 'committed', JSON.stringify(e));
      assert.deepEqual(await openRow(pe.h), rowE);
      assert.deepEqual(e.supplemental.ownership_transfer, []);
      assert.equal((await opLog(pe.h, 'RECONCILE_REVOKE')).length, 0);
      assert.equal((await integration(pe.i)).identity_claim_state, 'CURRENT_CLAIM_HOLDER');
    });

    await t.test('T-A11-16 no fork escapes a revocation', async () => {
      // Path 1 / Path 2 (anthropic.claude, INCOMPLETE)
      const user = await newUser();
      const client = `c-${uid()}`;
      const bOld = await oauthBinding(user, { client });
      const id = await claude(bOld);
      const bCur = await oauthBinding(user, { client });
      assert.equal((await bindTo(bCur, id, 'REAUTHORIZATION')).status, 'committed');
      const count = async () => Number((await admin.query('select count(*) n from clued_private.integrations_v1 where owner_id = $1',
        [user])).rows[0].n);
      const n0 = await count();
      assert.equal((await bindAs(bOld, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' })).error_code,
        'binding_owned_by_other_integration');
      assert.equal(await count(), n0);
      assert.equal((await bindTo(bOld, id, 'REBIND')).status, 'committed');
      assert.equal((await bindAs(bCur, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' })).error_code,
        'binding_owned_by_other_integration');
      // Path 1b (test.tenant): an old Binding of I hitting another holder
      const p = await conflictPair();
      const p2 = await oauthBinding(p.user, { client: p.client });
      assert.equal((await bindTo(p2, p.i, 'REAUTHORIZATION')).status, 'committed');
      assert.equal((await bindAs(p.bi, 'CREATE_OR_BIND', { host: 'test.tenant', tenant: tenant('P') })).error_code,
        'binding_owned_by_other_integration');
      // Path 3 (i): a never-linked pre-revoke grant is swept by the Native revoke
      const bPre = await oauthBinding(user, { client });
      assert.equal((await revoke(user, id)).status, 'committed');
      assert.equal((await bindAs(bPre, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' })).thrown, 'binding_not_authorized');
      // Path 3 (ii): after a Host disconnect only, the unswept pre-disconnect grant cannot create
      const u2 = await newUser();
      const c2id = `c-${uid()}`;
      const old2 = await oauthBinding(u2, { client: c2id });
      const id2 = await claude(old2);
      const cur2 = await oauthBinding(u2, { client: c2id });
      await bindTo(cur2, id2, 'REAUTHORIZATION');
      const pre2 = await oauthBinding(u2, { client: c2id });
      await issuerRevoke(cur2);
      const n2 = Number((await admin.query('select count(*) n from clued_private.integrations_v1 where owner_id = $1', [u2])).rows[0].n);
      assert.equal((await bindAs(pre2, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' })).error_code,
        'binding_predates_revocation');
      assert.equal(Number((await admin.query('select count(*) n from clued_private.integrations_v1 where owner_id = $1', [u2])).rows[0].n), n2);
      const fresh = await oauthBinding(u2, { client: c2id });
      const j = await bindAs(fresh, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal(j.supplemental.outcome, 'CREATE', JSON.stringify(j));
      assert.equal((await revoke(u2, id2)).status, 'committed');
      for (const b of [old2, cur2, pre2]) assert.equal(await tool(b), 'binding_not_authorized');
      for (const b of [old2, cur2]) assert.equal((await ownerOf(b)).integration_id, id2);
      assert.equal(await tool(fresh), 'ok');
    });

    await t.test('T-A11-17 a revoked I cannot REBIND_TO_HOLDER; same-client restore unlocks REPLACE_HOLDER', async () => {
      // (b) derived revoke of I's current Binding: refused, and the refusal leaves no materialized row
      const pb = await conflictPair();
      await issuerRevoke(pb.bi);
      const rb = await reconcile(pb.user, pb.i, pb.h, 'REBIND_TO_HOLDER');
      assert.equal(rb.error_code, 'integration_revoked_requires_explicit_restore', JSON.stringify(rb));
      assert.equal(await rowCount(pb.i), 0);
      assert.equal(await currentBinding(pb.h), pb.bh.id);
      // (c) I without a CURRENT connection
      const pc = await conflictPair();
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(`update clued_private.integration_connections_v1 set link_status = 'HISTORICAL', unlinked_at = clock_timestamp()
        where integration_id = $1 and link_status = 'CURRENT'`, [pc.i]);
      await admin.query('commit');
      assert.equal((await reconcile(pc.user, pc.i, pc.h, 'REBIND_TO_HOLDER')).error_code, 'reconcile_requires_active_connection');
      // (d) I's current Binding expired
      const pd = await conflictPair();
      await expire(pd.bi);
      assert.equal((await reconcile(pd.user, pd.i, pd.h, 'REBIND_TO_HOLDER')).error_code, 'reconcile_requires_active_connection');
      // (e) I revoked: REPLACE_HOLDER refused; a same-client restore keeps the conflict; then REPLACE_HOLDER commits
      const pe = await conflictPair();
      assert.equal((await revoke(pe.user, pe.i)).status, 'committed');
      assert.equal((await reconcile(pe.user, pe.i, pe.h, 'REPLACE_HOLDER')).error_code, 'integration_revoked_requires_explicit_restore');
      const claims0 = (await admin.query('select count(*) n from clued_private.integration_claims_v1')).rows[0].n;
      const fresh = await oauthBinding(pe.user, { client: pe.client });
      const restored = await restore(pe.user, pe.i, fresh);
      assert.equal(restored.status, 'committed', JSON.stringify(restored));
      assert.ok(!restored.supplemental.outcome_flags.includes('CLAIM_CONFLICT_AFTER_RESTORE'));
      const ie = await integration(pe.i);
      assert.equal(ie.identity_claim_state, 'CLAIM_CONFLICT');
      assert.equal(ie.conflicting_integration_id, pe.h);
      assert.equal((await admin.query('select count(*) n from clued_private.integration_claims_v1')).rows[0].n, claims0, 'no claim store write');
      assert.equal(await source(pe.i), 'NONE');
      assert.equal((await reconcile(pe.user, pe.i, pe.h, 'REPLACE_HOLDER')).status, 'committed');
      assert.equal((await integration(pe.i)).identity_claim_state, 'CURRENT_CLAIM_HOLDER');
      // PENDING_RECONCILE variant
      const pp = await conflictPair();
      assert.equal((await rpc(admin, 'clued_integration_reconcile_request_v1', pp.bi, { idempotency_key: key(), integration_id: pp.i,
        base_version: await version(pp.i) })).status, 'committed');
      assert.equal((await revoke(pp.user, pp.i)).status, 'committed');
      const fp = await oauthBinding(pp.user, { client: pp.client });
      const rp = await restore(pp.user, pp.i, fp);
      assert.equal(rp.status, 'committed', JSON.stringify(rp));
      assert.equal((await integration(pp.i)).identity_claim_state, 'PENDING_RECONCILE');
      assert.equal((await integration(pp.i)).conflicting_integration_id, pp.h);
      // (f) a restore that would change the key is claim-blocked, with no business write
      const pf = await conflictPair();
      assert.equal((await revoke(pf.user, pf.i)).status, 'committed');
      const g0 = await guarded();
      const other = await oauthBinding(pf.user);
      const g1 = await guarded();
      const blocked = await restore(pf.user, pf.i, other);
      assert.equal(blocked.error_code, 'integration_claim_blocked', JSON.stringify(blocked));
      assert.deepEqual(await guarded(), g1);
      assert.notDeepEqual(g0, g1);
      assert.equal(await state(pf.i), 'REVOKED');
      // FORBIDS_REAUTH_RECOVERY on a conflicted Integration is claim-blocked
      const pg = await conflictPair();
      assert.equal((await opLifecycle('recovery_policy', pg.i, { value: 'FORBIDS_REAUTH' })).status, 'committed');
      await expire(pg.bi);
      const fg = await oauthBinding(pg.user, { client: pg.client });
      assert.equal((await restore(pg.user, pg.i, fg)).error_code, 'integration_claim_blocked');
    });

    await t.test('T-A11-18 the materialized row\'s time does not depend on who materializes it', async () => {
      const run = async (viaPause, withOld) => {
        const client = `c-${uid()}`;
        const user = await newUser();
        const bOld = await oauthBinding(user, { client });
        const id = await install(bOld);
        const bCur = await oauthBinding(user, { client });
        await bindTo(bCur, id, 'REAUTHORIZATION');
        if (!withOld) await admin.query('update public.clued_agent_bindings set revoked_at = clock_timestamp() where id = $1', [bOld.id]);
        await issuerRevoke(bCur);                                                     // t0
        const t0 = (await admin.query(`select recorded_at from clued_private.authorization_audit_v12
          where binding_id = $1 and operation = 'revoke_issuer'`, [bCur.id])).rows[0].recorded_at;
        const bNew = await oauthBinding(user, { client });                            // t1
        assert.equal((await bindTo(bNew, id, 'REAUTHORIZATION')).error_code, 'integration_revoked_requires_explicit_restore');
        assert.equal(await rowCount(id), 0, 'a rejected bind materializes nothing');
        if (viaPause) {
          const p = await opLifecycle('policy_pause', id);                          // t2
          assert.ok(p.supplemental.outcome_flags.includes('REVOCATION_MATERIALIZED'));
          assert.ok(p.target_refs.some((x) => x.role === 'revocation'));
          assert.equal((await openRow(id)).revoked_at.toISOString(), t0.toISOString());
        }
        return { user, id, bOld, bCur, bNew, t0 };
      };
      for (const viaPause of [true, false]) {
        const { user, id, bNew, t0 } = await run(viaPause, false);
        const r = await restore(user, id, bNew);
        assert.equal(r.status, 'committed', JSON.stringify(r));
        assert.equal(new Date(r.supplemental.t_loss).toISOString(), t0.toISOString());
        const row = (await admin.query('select * from clued_private.integration_revocations_v1 where revocation_id = $1',
          [r.supplemental.revocation_id])).rows[0];
        assert.equal(row.revoked_at.toISOString(), t0.toISOString(), `via pause ${viaPause}`);
      }
      // extension variant (v0.1.7 MINOR-N26): from t2, the Owner's revoke extends the row with B_old only
      const { user, id, bOld, bCur, bNew, t0 } = await run(true, true);
      const ext = await revoke(user, id);
      assert.equal(ext.status, 'committed', JSON.stringify(ext));
      assert.equal(new Date(ext.supplemental.t_cut).toISOString(), t0.toISOString());
      const row = await openRow(id);
      assert.deepEqual(row.revoked_binding_ids, [bCur.id, bOld.id]);
      assert.equal(row.revoked_at.toISOString(), t0.toISOString());
      assert.equal(row.revoked_by, 'USER_VIA_HOST');
      assert.deepEqual(row.extended_receipt_ids, [ext.receipt_id]);
      assert.ok(await revoked(bOld));
      assert.equal(await tool(bNew), 'ok', 'a later decision is not swept');
      assert.equal((await restore(user, id, bNew)).status, 'committed');
      await assert.rejects(admin.query(`update clued_private.integration_revocations_v1 set revoked_binding_ids = revoked_binding_ids || $2::uuid,
        extended_receipt_ids = extended_receipt_ids || gen_random_uuid() where revocation_id = $1`, [row.revocation_id, uid()]),
      /integration_revocation_immutable/);
    });

    await t.test('T-A11-19 restore follows the provider and identity rules; ownership on restore', async () => {
      const client = `c-${uid()}`;
      const { user, id } = await active({}, { client });
      assert.equal((await revoke(user, id)).status, 'committed');
      const c2Pre = await oauthBinding(user, { client: `c2-${uid()}` });            // an unrelated client, before t_loss
      const raw = await rawBinding(user);
      const g0 = await guarded();
      assert.equal((await restore(user, id, raw)).error_code, 'integration_provider_mismatch');
      assert.deepEqual(await guarded(), g0);
      // another client C2: new snapshot, key released and re-claimed, wider authority flagged
      const cTwo = `c2-${uid()}`;
      const k0 = (await integration(id)).claim_key_sha256;
      const pre2 = await oauthBinding(user, { client: cTwo });                     // C2, before the restore, never linked
      const n2 = await oauthBinding(user, { client: cTwo, scopes: ['audit:read', 'context:read', 'context:write'] });
      const r = await restore(user, id, n2);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.ok(r.supplemental.outcome_flags.includes('AUTHORITY_CHANGED_BY_RESTORE'));
      assert.ok(r.supplemental.ceiling_before && r.supplemental.ceiling_after);
      const i = await integration(id);
      assert.equal(i.provider_connection_id, sha(cTwo));
      assert.notEqual(i.claim_key_sha256, k0);
      assert.equal(Number((await admin.query(`select count(*) n from clued_private.integration_claims_v1 where integration_id = $1
        and claim_status = 'CURRENT'`, [id])).rows[0].n), 1);
      assert.equal(await tool(pre2), 'ok', 'Lin*(I) is evaluated before linking: C2 grants are not swept');
      assert.equal(await tool(c2Pre), 'ok');
      // the new key already held by H: restore commits into CLAIM_CONFLICT
      const cThree = `c3-${uid()}`;
      const hb = await oauthBinding(user, { client: cThree });
      const h = await install(hb);
      const victim = await active({}, {}, user);
      assert.equal((await revoke(user, victim.id)).status, 'committed');
      const into = await oauthBinding(user, { client: cThree });
      const conflict = await restore(user, victim.id, into);
      assert.equal(conflict.status, 'committed', JSON.stringify(conflict));
      assert.ok(conflict.supplemental.outcome_flags.includes('CLAIM_CONFLICT_AFTER_RESTORE'));
      assert.equal((await integration(victim.id)).conflicting_integration_id, h);
      assert.equal(await state(victim.id), 'BLOCKED');
      // ownership: J's CURRENT connection is refused; J's HISTORICAL Binding is transferred (Native only)
      const j = await active({}, {}, user);
      const target = await active({}, {}, user);
      assert.equal((await revoke(user, target.id)).status, 'committed');
      const jOld = await oauthBinding(user, { client: j.binding.client });
      await bindTo(jOld, j.id, 'REAUTHORIZATION');                                 // jOld is J's CURRENT connection now
      const jHist = j.binding;                                                       // HISTORICAL of J, issued before target's revoke
      assert.equal((await restore(user, target.id, jOld)).error_code, 'binding_owned_by_other_integration');
      assert.equal((await restore(user, target.id, jHist)).error_code, 'restore_requires_new_authorization_decision');
      const jNew = await oauthBinding(user, { client: j.binding.client });
      await bindTo(jNew, j.id, 'REAUTHORIZATION');                                 // jOld becomes HISTORICAL of J, issued after the revoke
      const opRefused = await opRestore(target.id, jOld);
      assert.equal(opRefused.error_code, 'binding_owned_by_other_integration', 'the Operator never transfers ownership');
      const moved = await restore(user, target.id, jOld);
      assert.equal(moved.status, 'committed', JSON.stringify(moved));
      assert.equal(moved.supplemental.ownership_transfer.from_integration_id, j.id);
      assert.ok(moved.target_refs.some((x) => x.role === 'ownership_source' && x.id === j.id));
      assert.equal((await revoke(user, j.id)).status, 'committed');
      assert.equal(await revoked(jOld), false, 'revoking J no longer reaches it');
      // Operator restore with an unowned Binding: OPERATOR_RESTORE ownership and link
      const t2 = await active({}, {}, user);
      assert.equal((await revoke(user, t2.id)).status, 'committed');
      const free = await oauthBinding(user, { client: t2.binding.client });
      const op = await opRestore(t2.id, free);
      assert.equal(op.status, 'committed', JSON.stringify(op));
      const o = await ownerOf(free);
      assert.equal(o.acquired_via, 'OPERATOR_RESTORE');
      const link = (await admin.query(`select link_authority from clued_private.integration_connections_v1 where integration_id = $1
        and link_status = 'CURRENT'`, [t2.id])).rows[0].link_authority;
      assert.equal(link, 'OPERATOR_RESTORE');
      assert.equal((await admin.query(`select from_integration_id from clued_private.integration_binding_ownership_log_v1
        where binding_id = $1`, [free.id])).rows[0].from_integration_id, null);
      assert.equal((await admin.query('select decided_by from clued_private.integration_regrants_v1 where regrant_id = $1',
        [op.supplemental.regrant_id])).rows[0].decided_by, 'OPERATOR');
      assert.equal(moved.supplemental.link_authority, 'NATIVE_RESTORE');
      // concurrency: a restore holding L1 on the new Binding blocks its CREATE_OR_BIND elsewhere
      const t3 = await active({}, {}, user);
      assert.equal((await revoke(user, t3.id)).status, 'committed');
      const contested = await oauthBinding(user, { client: `c-${uid()}` });
      const opened = await openReq(contested, { intent: 'create_or_bind', host: 'anthropic.claude', host_surface: 'chat' });
      await c2.query('begin');
      const held = await sessionIn(c2, 'clued_user_integration_v1', user, { op: 'restore', idempotency_key: key(),
        integration_id: t3.id, base_version: await version(t3.id), new_binding_id: contested.id });
      assert.equal(held.status, 'committed', JSON.stringify(held));
      const blocked = inTx(c3, () => rpc(c3, 'clued_integration_create_or_bind_v1', contested, { idempotency_key: key('bind'),
        request_id: opened.request_id, binding_intent: 'CREATE_OR_BIND' }));
      await waitLocked(pid3);
      await c2.query('commit');
      assert.equal((await blocked).error_code, 'binding_owned_by_other_integration');
    });

    await t.test('T-A11-20 REBIND_TO_HOLDER receiving guards (a)(b)', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const WIDE = ['audit:read', 'context:read', 'context:write'];
      const wideOld = await oauthBinding(user, { client, scopes: WIDE });           // older than H's ceiling
      const bh = await oauthBinding(user, { client });
      const h = await install(bh, { host: 'test.tenant', tenant: tenant('P') });
      const i = await install(wideOld, { host: 'test.tenant' });
      const u = await rpc(admin, 'clued_integration_identity_update_v1', wideOld, { idempotency_key: key(), integration_id: i,
        base_version: await version(i), tenant: tenant('P') });
      assert.equal(u.supplemental.identity_claim_state, 'CLAIM_CONFLICT');
      const owners0 = await ownerOf(wideOld);
      const a = await reconcile(user, i, h, 'REBIND_TO_HOLDER');
      assert.equal(a.error_code, 'reauthorization_scope_expansion_forbidden', JSON.stringify(a));
      assert.deepEqual(await ownerOf(wideOld), owners0);
      const wideNew = await oauthBinding(user, { client, scopes: WIDE });           // fresh consent after H's ceiling
      assert.equal((await bindTo(wideNew, i, 'REAUTHORIZATION')).status, 'committed');
      const b = await reconcile(user, i, h, 'REBIND_TO_HOLDER');
      assert.equal(b.status, 'committed', JSON.stringify(b));
      assert.ok(b.supplemental.outcome_flags.includes('AUTHORITY_EXPANDED_BY_CONSENT'));
      assert.ok(b.supplemental.ceiling_before && b.supplemental.ceiling_after);
    });

    await t.test('T-A11-21 restore revokes the superseded credentials (REVOCATION and FORBIDS_REAUTH_RECOVERY)', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const bOld = await oauthBinding(user, { client });
      const id = await install(bOld);
      const bCur = await oauthBinding(user, { client });
      await bindTo(bCur, id, 'REAUTHORIZATION');
      const bPre = await oauthBinding(user, { client });
      await issuerRevoke(bCur);
      const bNew = await oauthBinding(user, { client });
      const r = await restore(user, id, bNew);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.deepEqual(sorted(r.supplemental.revoked_binding_ids), sorted([bOld.id, bPre.id]));
      assert.deepEqual(r.supplemental.swept_unowned_binding_ids.map((x) => x.binding_id), [bPre.id]);
      assert.equal((await ownerOf(bPre)).acquired_via, 'REVOCATION_SWEEP');
      const sweep = await opLog(id, 'RESTORE_SWEEP');
      assert.equal(sweep.length, 1);
      assert.deepEqual(sorted(sweep[0].affected_binding_ids), sorted([bOld.id, bPre.id]));
      assert.equal((await bindTo(bOld, id, 'REBIND')).thrown, 'binding_not_authorized');
      assert.equal(await state(id), 'VERIFYING');
      assert.deepEqual((await admin.query('select clued_private.integration_owned_unrevoked_v1($1) o', [id])).rows[0].o, [bNew.id]);
      // FORBIDS_REAUTH_RECOVERY: Owned(I) \ {new} is revoked, never-linked grants are not swept
      const u2 = await newUser();
      const o2 = await oauthBinding(u2, { client });
      const id2 = await install(o2);
      const c2b = await oauthBinding(u2, { client });
      await bindTo(c2b, id2, 'REAUTHORIZATION');
      assert.equal((await opLifecycle('recovery_policy', id2, { value: 'FORBIDS_REAUTH' })).status, 'committed');
      const pre2 = await oauthBinding(u2, { client });
      await expire(c2b);
      assert.equal(await state(id2), 'BLOCKED');
      const n2 = await oauthBinding(u2, { client });
      const r2 = await restore(u2, id2, n2);
      assert.equal(r2.status, 'committed', JSON.stringify(r2));
      assert.equal(r2.supplemental.restore_kind, 'FORBIDS_REAUTH_RECOVERY');
      assert.deepEqual(sorted(r2.supplemental.revoked_binding_ids), sorted([o2.id, c2b.id]));
      assert.ok(await revoked(o2));
      assert.equal(await tool(pre2), 'ok');
      assert.equal(await state(id2), 'VERIFYING');
    });

    await t.test('T-A11-22 sweep concurrency boundaries', async () => {
      // (a) an unowned same-client B_pre's CREATE_OR_BIND holds its L1: the revoke waits, then leaves it to J
      const client = `c-${uid()}`;
      const user = await newUser();
      const id = await claude(await oauthBinding(user, { client }));
      const bPre = await oauthBinding(user, { client });
      const opened = await openReq(bPre, { intent: 'create_or_bind', host: 'anthropic.claude', host_surface: 'chat' });
      await c2.query('begin');
      const created = await rpc(c2, 'clued_integration_create_or_bind_v1', bPre, { idempotency_key: key('bind'),
        request_id: opened.request_id, binding_intent: 'CREATE_OR_BIND' });
      assert.equal(created.supplemental.outcome, 'CREATE', JSON.stringify(created));
      const pending = revokeOn(c3, user, id);
      await waitLocked(pid3);
      await c2.query('commit');
      const r = await pending;
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.ok(!r.supplemental.revoked_binding_ids.includes(bPre.id));
      assert.equal(await tool(bPre), 'ok');
      assert.equal((await ownerOf(bPre)).integration_id, created.supplemental.integration_id);
      // reverse: the revoke commits first, the create_or_bind fails authentication under its lock
      const u2 = await newUser();
      const id2 = await claude(await oauthBinding(u2, { client }));
      const pre2 = await oauthBinding(u2, { client });
      const op2 = await openReq(pre2, { intent: 'create_or_bind', host: 'anthropic.claude', host_surface: 'chat' });
      assert.equal((await revoke(u2, id2)).status, 'committed');
      assert.equal((await call(rpc(admin, 'clued_integration_create_or_bind_v1', pre2, { idempotency_key: key('bind'),
        request_id: op2.request_id, binding_intent: 'CREATE_OR_BIND' }))).thrown, 'binding_not_authorized');
      // (b) a consent after t_rev is not swept and may create (no binding_predates_revocation)
      const after = await oauthBinding(u2, { client });
      assert.equal(await tool(after), 'ok');
      assert.equal((await bindAs(after, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' })).supplemental.outcome, 'CREATE');
      // (c) revoke_self's LINEAGE includes same-client unowned grants, never another client's
      const u3 = await newUser();
      const c1 = `c1-${uid()}`;
      const b0 = await oauthBinding(u3, { client: c1 });
      const id3 = await claude(b0);
      const b3 = await oauthBinding(u3);
      await confirm(u3, id3, b3);
      const b1 = await oauthBinding(u3, { client: c1 });
      await confirm(u3, id3, b1);
      const sameUnowned = await oauthBinding(u3, { client: c1 });
      const otherUnowned = await oauthBinding(u3, { client: b3.client });
      const s = await revokeSelf(b1, id3);
      assert.equal(s.supplemental.outcome, 'PARTIAL_CONNECTION_REVOKE', JSON.stringify(s));
      assert.ok(await revoked(sameUnowned));
      assert.equal(await revoked(otherUnowned), false);
      assert.equal(await revoked(b3), false);
    });

    await t.test('T-A11-23 a concurrent consent (known boundary 1) is caught by O7 and by the next revoke or restore', async () => {
      for (const followUp of ['revoke', 'restore']) {
        const client = `c-${uid()}`;
        const user = await newUser();
        const b = await oauthBinding(user, { client });
        const id = await claude(b);
        const sibling = await claude(await oauthBinding(user, { client }));
        await c2.query('begin');
        const late = await oauthBinding(user, { client, db: c2 });                // created_at ≤ t_rev, committed after the revoke
        const r = await revoke(user, id);
        assert.equal(r.status, 'committed');
        await c2.query('commit');
        assert.equal(await tool(late), 'ok', 'known boundary 1');
        assert.equal((await bindAs(late, 'CREATE_OR_BIND', { host: 'anthropic.claude', host_surface: 'chat' })).error_code,
          'binding_predates_revocation');
        assert.equal((await bindTo(late, sibling, 'REBIND')).error_code, 'binding_predates_revocation');
        if (followUp === 'revoke') {
          const again = await opRevoke(id);
          assert.equal(again.status, 'committed', JSON.stringify(again));
          assert.ok(again.supplemental.revoked_binding_ids.includes(late.id));
        } else {
          const fresh = await oauthBinding(user, { client });
          const rr = await restore(user, id, fresh);
          assert.equal(rr.status, 'committed', JSON.stringify(rr));
          assert.ok(rr.supplemental.revoked_binding_ids.includes(late.id));
        }
        assert.equal(await tool(late), 'binding_not_authorized', followUp);
      }
    });

    await t.test('T-A11-24 a repeated revoke cuts at rev_at(I), never later', async () => {
      const client = `c-${uid()}`;
      const user = await newUser();
      const b = await oauthBinding(user, { client });
      const id = await claude(b);
      await issuerRevoke(b);                                                         // t0
      const t0 = (await admin.query(`select recorded_at from clued_private.authorization_audit_v12 where binding_id = $1
        and operation = 'revoke_issuer'`, [b.id])).rows[0].recorded_at;
      const bNew = await oauthBinding(user, { client });                             // t1
      const r = await revoke(user, id);                                              // t2
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal((await openRow(id)).revoked_at.toISOString(), t0.toISOString());
      assert.equal(new Date(r.supplemental.t_cut).toISOString(), t0.toISOString());
      assert.equal(await tool(bNew), 'ok');
      assert.equal((await restore(user, id, bNew)).status, 'committed');
      assert.equal(await state(id), 'VERIFYING');
      // a first explicit revoke cuts at t_rev; a second one at the row's revoked_at
      const u2 = await newUser();
      const id2 = await claude(await oauthBinding(u2, { client }));
      const first = await revoke(u2, id2);
      const row = await openRow(id2);
      assert.equal(new Date(first.supplemental.t_cut).toISOString(), row.revoked_at.toISOString());
      const bAfter = await oauthBinding(u2, { client });
      const second = await opRevoke(id2);
      assert.equal(second.supplemental.outcome, 'ALREADY_REVOKED', JSON.stringify(second));
      assert.deepEqual(await openRow(id2), row);
      assert.equal(await tool(bAfter), 'ok');
    });

    await t.test('T-A11-25 lineage along a supersede chain (Lin*)', async () => {
      const make = async () => {
        const client = `c-${uid()}`;
        const user = await newUser();
        const bh = await oauthBinding(user, { client });
        const y = await install(bh, { host: 'test.tenant', tenant: tenant('P') });
        const c3b = await oauthBinding(user);                                       // Y's history gains client C3
        await confirm(user, y, c3b);
        const back = await oauthBinding(user, { client });
        await confirm(user, y, back);
        const bi = await oauthBinding(user, { client });
        const x = await install(bi, { host: 'test.tenant' });
        const u = await rpc(admin, 'clued_integration_identity_update_v1', bi, { idempotency_key: key(), integration_id: x,
          base_version: await version(x), tenant: tenant('P') });
        assert.equal(u.supplemental.identity_claim_state, 'CLAIM_CONFLICT', JSON.stringify(u));
        assert.equal((await reconcile(user, x, y, 'REPLACE_HOLDER')).status, 'committed');
        const bC3 = await oauthBinding(user, { client: c3b.client });              // never linked, before X's revoke
        return { user, x, bi, bC3 };
      };
      const one = await make();
      const r = await revoke(one.user, one.x);
      assert.ok(r.supplemental.revoked_binding_ids.includes(one.bC3.id), JSON.stringify(r.supplemental));
      assert.equal(await tool(one.bC3), 'binding_not_authorized');
      const two = await make();
      await issuerRevoke(two.bi);
      assert.equal((await bindAs(two.bC3, 'CREATE_OR_BIND', { host: 'test.tenant' })).error_code, 'binding_predates_revocation');
    });

    // ---- G-A9 (§13.6) -------------------------------------------------------------------------------
    const nativeCreate = async (user, host, phase) => {
      const request = await native(user, { op: 'request_open', request_key: key('native'), intent: 'create_or_bind', host,
        host_surface: 'default', provider: 'clued.oauth.v12', adapter_family: 'test-adapter', adapter_version: '1.0.0',
        installation_phase: phase });
      const created = await native(user, { op: 'create_or_bind', idempotency_key: key(), request_id: request.request_id,
        binding_intent: 'CREATE_OR_BIND' });
      assert.equal(created.status, 'committed', JSON.stringify(created));
      return created.supplemental.integration_id;
    };
    const DEGRADE = { action: 'set', truth_class: 'host_state', value: 'DEGRADED', mask: ['context.read'], reason: 'slow host' };

    await t.test('T-A9-2 the Binding-initiated path: INSTALL_PENDING → VERIFYING → ACTIVE → DEGRADED', async () => {
      const user = await newUser();
      const b = await oauthBinding(user);
      const r = await bindAs(b, 'CREATE_OR_BIND', { installation_phase: 'STARTED' });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      const id = r.supplemental.integration_id;
      assert.equal(await state(id), 'INSTALL_PENDING');
      const done = await lifecycle(user, id, 'installation_completed');
      assert.equal(done.status, 'committed', JSON.stringify(done));
      assert.equal(done.supplemental.to, 'COMPLETED');
      assert.equal(await state(id), 'VERIFYING');
      assert.equal((await lifecycle(user, id, 'installation_completed')).error_code, 'lifecycle_transition_invalid', 'monotonic');
      await resume(b);
      assert.equal((await verify(b, id)).supplemental.result, 'PASS');
      assert.equal(await state(id), 'ACTIVE');
      assert.equal((await report(b, id, DEGRADE)).status, 'committed');
      assert.equal(await state(id), 'DEGRADED');
    });

    await t.test('T-A9-4 every state is reached by a real RPC sequence', async () => {
      const reached = new Set();
      const user = await newUser();
      const pending = await nativeCreate(user, 'test.complete', 'STARTED');
      reached.add(await state(pending));
      assert.equal((await lifecycle(user, pending, 'installation_completed')).status, 'committed');
      reached.add(await state(pending));                                             // AUTH_PENDING
      const noauth = await nativeCreate(user, 'test.noauth', 'STARTED');
      assert.equal((await lifecycle(user, noauth, 'installation_completed')).status, 'committed');
      reached.add(await state(noauth));                                              // INSTALLED
      const a = await active({}, {}, user);
      reached.add('VERIFYING');                                                      // asserted inside active()
      reached.add(await state(a.id));
      assert.equal((await report(a.binding, a.id, DEGRADE)).status, 'committed');
      reached.add(await state(a.id));                                                // DEGRADED
      const p = await active({}, {}, user);
      assert.equal((await lifecycle(user, p.id, 'pause')).status, 'committed');
      reached.add(await state(p.id));                                                // BLOCKED
      const m = await active({}, {}, user);
      assert.equal((await mark(m.id)).status, 'committed');
      reached.add(await state(m.id));                                                // REAUTH_REQUIRED
      const family = `t-a9-4-${uid()}`;
      await admin.query(`insert into clued_private.integration_compatibility_rules_v1(host, adapter_family, min_adapter_version,
        below_minimum, registry_version) values ('test.complete', $1, '2.0.0', 'HARD_INCOMPATIBLE', 1)`, [family]);
      const inc = await active({ adapter_family: family, adapter_version: '2.0.0' }, {}, user);
      assert.equal((await declare(inc.binding, inc.id, { adapter_family: family, adapter_version: '1.0.0' })).status, 'committed');
      reached.add(await state(inc.id));                                              // INCOMPATIBLE
      const v = await active({}, {}, user);
      assert.equal((await revoke(user, v.id)).status, 'committed');
      reached.add(await state(v.id));                                                // REVOKED
      assert.deepEqual([...reached].sort(), [...STATES].sort());
    });

    await t.test('T-A9-5 Request close / archive never change the Integration', async () => {
      const { user, binding, id } = await active();
      const asOf = new Date(Date.now() + 1000).toISOString();
      const before = await integration(id);
      const e0 = await evaluate(id, asOf);
      const request = async (rid) => (await admin.query('select * from clued_private.integration_installation_requests_v1 where request_id = $1',
        [rid])).rows[0];
      const act = async (rid, action) => native(user, { op: 'lifecycle', idempotency_key: key(), action, request_id: rid,
        base_version: Number((await request(rid)).version) });
      const open = await openReq(binding, { intent: 'reauthorization', target_integration_id: id });
      const closed = await act(open.request_id, 'request_close');
      assert.equal(closed.status, 'committed', JSON.stringify(closed));
      assert.equal((await request(open.request_id)).request_status, 'CLOSED');
      assert.equal((await act(open.request_id, 'request_close')).error_code, 'lifecycle_transition_invalid');
      assert.equal((await act(open.request_id, 'request_archive')).status, 'committed');
      assert.equal((await request(open.request_id)).request_status, 'ARCHIVED');
      const bound = (await admin.query('select request_id from clued_private.integration_installation_requests_v1 where bound_integration_id = $1',
        [id])).rows[0].request_id;
      assert.equal((await act(bound, 'request_close')).status, 'committed');
      assert.equal((await act(bound, 'request_archive')).status, 'committed');
      assert.equal((await act(bound, 'request_archive')).error_code, 'lifecycle_transition_invalid', 'ARCHIVED is final');
      const fresh = await openReq(binding, { intent: 'reauthorization', target_integration_id: id });
      const conflict = await native(user, { op: 'lifecycle', idempotency_key: key(), action: 'request_close', request_id: fresh.request_id,
        base_version: 99 });
      assert.equal(conflict.error_code, 'installation_request_version_conflict');
      assert.equal((await call(native(await newUser(), { op: 'lifecycle', idempotency_key: key(), action: 'request_close',
        request_id: fresh.request_id, base_version: 1 }))).thrown, 'integration_not_owned');
      assert.deepEqual(await integration(id), before);
      const e1 = await evaluate(id, asOf);
      assert.deepEqual(e1.facts, e0.facts);
      assert.equal(e1.facts_sha256, e0.facts_sha256);
      assert.equal(e1.integration_state, e0.integration_state);
    });

    await t.test('T-A9-6 rebind-class intents never reset to INSTALL_PENDING', async () => {
      for (const intent of REBIND_CLASS) {
        const client = `c-${uid()}`;
        const { user, id } = await active({}, { client });
        const fresh = await oauthBinding(user, { client });
        const r = await bindTo(fresh, id, intent, { installation_phase: 'STARTED' });
        assert.equal(r.status, 'committed', `${intent} ${JSON.stringify(r)}`);
        assert.ok(['VERIFYING', 'REAUTH_REQUIRED', 'BLOCKED', 'DEGRADED', 'ACTIVE'].includes(await state(id)), intent);
        assert.equal((await integration(id)).install_status, 'COMPLETED', intent);
      }
    });

    await t.test('T-A9-8 pause / resume, and the Owner cannot lift a policy pause', async () => {
      const { user, id } = await active();
      assert.equal((await lifecycle(user, id, 'pause')).status, 'committed');
      let e = await evaluate(id);
      assert.equal(e.integration_state, 'BLOCKED');
      assert.deepEqual(e.effective_capabilities, []);
      assert.equal((await lifecycle(user, id, 'pause')).error_code, 'lifecycle_transition_invalid');
      assert.equal((await lifecycle(user, id, 'resume')).status, 'committed');
      assert.equal(await state(id), 'ACTIVE', 'the verification is still valid');
      assert.equal((await opLifecycle('policy_pause', id)).status, 'committed');
      assert.equal(await state(id), 'BLOCKED');
      assert.equal((await lifecycle(user, id, 'resume')).error_code, 'lifecycle_transition_invalid');
      assert.equal((await lifecycle(user, id, 'pause')).error_code, 'lifecycle_transition_invalid');
      assert.equal((await opLifecycle('policy_pause', id)).error_code, 'lifecycle_transition_invalid');
      assert.equal((await opLifecycle('policy_resume', id)).status, 'committed');
      assert.equal(await state(id), 'ACTIVE');
      assert.equal((await opLifecycle('policy_resume', id)).error_code, 'lifecycle_transition_invalid');
      assert.equal((await call(native(user, { op: 'lifecycle', idempotency_key: key(), integration_id: id, base_version: await version(id),
        action: 'policy_pause' }))).error_code, 'invalid_lifecycle', 'Owner cannot use the Operator actions');
      assert.equal((await opLifecycle('recovery_policy', id, { value: 'SOMETIMES' })).error_code, 'invalid_lifecycle');
      assert.equal((await call(operator({ op: 'policy_pause', idempotency_key: key(), integration_id: id, base_version: await version(id) },
        user))).thrown, 'platform_admin_required');
      const stale = await native(user, { op: 'lifecycle', idempotency_key: key(), integration_id: id, base_version: 1, action: 'pause' });
      assert.equal(stale.error_code, 'integration_version_conflict');
      e = await evaluate(id);
      assert.equal(e.integration_state, 'ACTIVE');
    });

    await t.test('T-A9-10 the (state, operation) transition table; every success has its Receipt and operation log', async () => {
      const fixtures = {
        INSTALL_PENDING: async () => { const user = await newUser(); return { user, id: await nativeCreate(user, 'test.complete', 'STARTED') }; },
        VERIFYING: async () => { const user = await newUser(); const binding = await oauthBinding(user); return { user, binding, id: await install(binding) }; },
        ACTIVE: async () => active(),
        BLOCKED: async () => { const x = await active(); await lifecycle(x.user, x.id, 'pause'); return x; },
        REAUTH_REQUIRED: async () => { const x = await active(); await mark(x.id); return x; },
        REVOKED: async () => { const x = await active(); await revoke(x.user, x.id); return x; },
      };
      const NOT = 'lifecycle_transition_invalid';
      const ops = {
        revoke: async (x) => revoke(x.user, x.id),
        reauth_mark: async (x) => mark(x.id),
        pause: async (x) => lifecycle(x.user, x.id, 'pause'),
        resume: async (x) => lifecycle(x.user, x.id, 'resume'),
        installation_completed: async (x) => lifecycle(x.user, x.id, 'installation_completed'),
        policy_pause: async (x) => opLifecycle('policy_pause', x.id),
        restore: async (x) => restore(x.user, x.id, await oauthBinding(x.user, { client: x.binding?.client })),
      };
      // [state][op] = expected result state on commit (§8.4 precedence: REAUTH_REQUIRED before BLOCKED), or the rejection code
      const table = {
        INSTALL_PENDING: { revoke: 'REVOKED', reauth_mark: 'INSTALL_PENDING', pause: 'BLOCKED', resume: NOT,
          installation_completed: 'AUTH_PENDING', policy_pause: 'BLOCKED', restore: NOT },
        VERIFYING: { revoke: 'REVOKED', reauth_mark: 'REAUTH_REQUIRED', pause: 'BLOCKED', resume: NOT, installation_completed: NOT,
          policy_pause: 'BLOCKED', restore: NOT },
        ACTIVE: { revoke: 'REVOKED', reauth_mark: 'REAUTH_REQUIRED', pause: 'BLOCKED', resume: NOT, installation_completed: NOT,
          policy_pause: 'BLOCKED', restore: NOT },
        BLOCKED: { revoke: 'REVOKED', reauth_mark: 'REAUTH_REQUIRED', pause: NOT, resume: 'ACTIVE', installation_completed: NOT,
          policy_pause: 'BLOCKED', restore: NOT },
        REAUTH_REQUIRED: { revoke: 'REVOKED', reauth_mark: 'REAUTH_REQUIRED', pause: 'REAUTH_REQUIRED', resume: NOT,
          installation_completed: NOT, policy_pause: 'REAUTH_REQUIRED', restore: NOT },
        REVOKED: { revoke: 'REVOKED', reauth_mark: 'integration_revoked_requires_explicit_restore', pause: 'REVOKED', resume: NOT,
          installation_completed: NOT, policy_pause: 'REVOKED', restore: 'VERIFYING' },
      };
      for (const [from, row] of Object.entries(table)) {
        for (const [op, expected] of Object.entries(row)) {
          const x = await fixtures[from]();
          assert.equal(await state(x.id), from, `fixture ${from}`);
          const r = await ops[op](x);
          if (STATES.includes(expected)) {
            assert.equal(r.status, 'committed', `${from} × ${op}: ${JSON.stringify(r)}`);
            assert.equal(await state(x.id), expected, `${from} × ${op}`);
            const receipt = (await admin.query('select status, operation_family from public.clued_audit_receipts where id = $1',
              [r.receipt_id])).rows[0];
            assert.equal(receipt.status, 'committed', `${from} × ${op}`);
            const log = (await admin.query('select * from clued_private.integration_operation_log_v1 where receipt_id = $1',
              [r.receipt_id])).rows;
            assert.ok(log.length >= 1, `${from} × ${op}: operation log`);
            for (const l of log) {
              for (const field of ['owner_id', 'actor_kind', 'integration_id', 'operation_type', 'identity_snapshot_id', 'source_provenance',
                'result', 'receipt_id', 'recorded_at']) assert.notEqual(l[field], null, `${from} × ${op}: ${field}`);
            }
          } else {
            assert.equal(r.status, 'rejected', `${from} × ${op}: ${JSON.stringify(r)}`);
            assert.equal(r.error_code, expected, `${from} × ${op}`);
            assert.equal(await state(x.id), from, `${from} × ${op} unchanged`);
          }
        }
      }
    });

    await t.test('T-A9-12 FORBIDS_REAUTH on the write path; FORBIDS_REAUTH_RECOVERY restore', async () => {
      const client = `c-${uid()}`;
      const { user, binding, id } = await active({}, { client });
      assert.equal((await opLifecycle('recovery_policy', id, { value: 'FORBIDS_REAUTH' })).status, 'committed');
      const early = await oauthBinding(user, { client });
      await expire(binding);
      // early's grant was issued before the loss (expire() backdates expires_at by one second)
      await admin.query(`update clued_private.authorizations_v12 set created_at = (select expires_at - interval '1 minute'
        from clued_private.authorizations_v12 where binding_id = $2) where binding_id = $1`, [early.id, binding.id]);
      assert.equal(await state(id), 'BLOCKED');
      for (const intent of ['REAUTHORIZATION', 'REBIND', 'RECOVERY']) {
        const fresh = await oauthBinding(user, { client });
        assert.equal((await bindTo(fresh, id, intent)).error_code, 'integration_recovery_forbidden', intent);
      }
      assert.equal(await state(id), 'BLOCKED');
      assert.equal((await restore(user, id, early)).error_code, 'restore_requires_new_authorization_decision');
      const fresh = await oauthBinding(user, { client });
      const r = await restore(user, id, fresh);
      assert.equal(r.status, 'committed', JSON.stringify(r));
      assert.equal(r.supplemental.restore_kind, 'FORBIDS_REAUTH_RECOVERY');
      assert.equal((await admin.query('select revocation_id from clued_private.integration_regrants_v1 where regrant_id = $1',
        [r.supplemental.regrant_id])).rows[0].revocation_id, null);
      assert.equal(await state(id), 'VERIFYING');
      // a mark raised before the expiry: t_loss is the later of the two; the restore clears the mark
      const m = await active({}, { client: `m-${uid()}` });
      await opLifecycle('recovery_policy', m.id, { value: 'FORBIDS_REAUTH' });
      const mk = await mark(m.id);
      await admin.query('update clued_private.authorizations_v12 set expires_at = clock_timestamp() where binding_id = $1', [m.binding.id]);
      const expiresAt = (await authRow(m.binding.id)).expires_at;
      const mf = await oauthBinding(m.user, { client: m.binding.client });
      const rm = await restore(m.user, m.id, mf);
      assert.equal(rm.status, 'committed', JSON.stringify(rm));
      assert.equal(new Date(rm.supplemental.t_loss).toISOString(), expiresAt.toISOString());
      assert.deepEqual(rm.supplemental.cleared_reauth_mark_ids, [mk.supplemental.mark_id]);
      assert.equal(await state(m.id), 'VERIFYING');
      // SUPERSEDED with FORBIDS_REAUTH
      const pair = await conflictPair();
      await opLifecycle('recovery_policy', pair.h, { value: 'FORBIDS_REAUTH' });
      assert.equal((await reconcile(pair.user, pair.i, pair.h, 'REPLACE_HOLDER')).status, 'committed');
      const late = await oauthBinding(pair.user, { client: pair.client });
      assert.equal((await restore(pair.user, pair.h, late)).error_code, 'integration_superseded');
      // a healthy FORBIDS_REAUTH Integration: confirm_rebind refused; revoke then restore succeeds
      const hlt = await active({}, { client: `h-${uid()}` });
      await opLifecycle('recovery_policy', hlt.id, { value: 'FORBIDS_REAUTH' });
      const other = await oauthBinding(hlt.user);
      const opened = await openReq(other, { intent: 'rebind', target_integration_id: hlt.id });
      const cr = await native(hlt.user, { op: 'confirm_rebind', idempotency_key: key(), request_id: opened.request_id,
        binding_id: other.id, base_version: await version(hlt.id) });
      assert.equal(cr.error_code, 'integration_recovery_forbidden', JSON.stringify(cr));
      assert.equal((await restore(hlt.user, hlt.id, await oauthBinding(hlt.user, { client: hlt.binding.client }))).error_code,
        'lifecycle_transition_invalid', 'nothing to restore while healthy');
      const rv = await revoke(hlt.user, hlt.id);
      const rs = await restore(hlt.user, hlt.id, await oauthBinding(hlt.user, { client: hlt.binding.client }));
      assert.equal(rs.status, 'committed', JSON.stringify(rs));
      assert.notEqual(rv.receipt_id, rs.receipt_id);
    });

    await t.test('Operator entry: admin only, input validation, revoke_self family and replay', async () => {
      const { user, binding, id } = await active();
      assert.equal((await call(operator({ op: 'revoke', integration_id: id, idempotency_key: key(), reason: 'x', revoked_by: 'SECURITY' },
        user))).thrown, 'platform_admin_required');
      assert.equal((await opRevoke(id, 'USER')).error_code, 'invalid_revoke', 'the Operator cannot claim the Owner');
      assert.equal((await revoke(user, id, { base_version: 1 })).error_code, 'invalid_revoke', 'no base_version (placement choice (a))');
      assert.equal((await revoke(user, id, { reason: '' })).error_code, 'invalid_revoke');
      assert.equal((await mark(id, { raised_by: 'SERVER' })).error_code, 'invalid_reauth_mark', 'SERVER is server-only');
      assert.equal((await mark(id, { reason: 'BORED' })).error_code, 'invalid_reauth_mark');
      assert.equal((await clearMark(id, uid())).error_code, 'reauth_mark_not_open');
      assert.equal((await call(native(user, { op: 'restore', idempotency_key: key(), integration_id: id, base_version: 1,
        new_binding_id: (await oauthBinding(await newUser())).id }))).thrown, 'binding_not_owned');
      const input = { idempotency_key: key('replay'), integration_id: id, reason: 'host disconnect' };
      const first = await rpc(admin, 'clued_integration_revoke_self_v1', binding, input);
      assert.equal(first.status, 'committed', JSON.stringify(first));
      const family = (await admin.query('select operation_family from public.clued_audit_receipts where id = $1', [first.receipt_id])).rows[0];
      assert.equal(family.operation_family, 'integration_revoke');
      const view = (await native(user, { op: 'status', integration_id: id })).integration;
      assert.equal(view.revocation.revocation_state, 'REVOKED');
      assert.equal(view.revocation.revoked_by, 'USER_VIA_HOST');
      assert.deepEqual(view.revocation.revoked_binding_ids, [binding.id]);
      assert.equal(view.lifecycle.ordinary_runtime, 'PERMITTED');
      const replay = await revoke(user, id, { idempotency_key: key('again') });
      assert.equal(replay.supplemental.outcome, 'ALREADY_REVOKED');
    });

  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
