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
import { assertGatewayCloseoutBoundary, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

// Disposable, full-chain PostgreSQL verification of AllContextsAuthorization.v0.1-r2
// §§4.1/4.2. Native consent and the existing Worker gateway are the write surfaces.
// Admin reads observe provenance/atomicity; explicit old rows below are legacy fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const proof = () => crypto.randomBytes(32).toString('hex');
const future = () => new Date(Date.now() + 3600000).toISOString();
const scope = (resource_id, actions) => ({ resource_kind: 'scope', resource_id, environment: 'canonical', actions });
const context = (resource_id, actions, environment = 'test') => ({ resource_kind: 'context', resource_id, environment, actions });
const macro = (actions) => scope('contexts:*', actions);
const sorted = (actions) => [...actions].sort();
const claims = (sub) => ({ sub, role: 'authenticated', session_id: 'all-contexts-db', aal: 'aal1',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('all-contexts sources, exact permission inheritance and real transaction barriers', { timeout: 420000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-all-contexts-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: proof(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {},
    onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    async function connect(role = null, owner = null) {
      const db = server.getPgClient();
      clients.push(db);
      await db.connect();
      await db.query("set statement_timeout='15s'; set lock_timeout='10s'");
      if (role) await db.query(`set role ${role}`);
      if (owner) await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [owner, JSON.stringify(claims(owner))]);
      return db;
    }
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
    const migrationNames = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrationNames.includes('20261014044323_all_contexts_authorization_v2.sql'));
    const rawConflictMigration = '20261015052000_raw_context_business_conflict_http409.sql';
    assert.ok(migrationNames.includes(rawConflictMigration));
    for (const name of migrationNames) {
      const rawKernel = async () => (await admin.query(`select pg_get_functiondef(p.oid) definition,
        to_jsonb(p)-'prosrc' metadata from pg_proc p
        where p.oid='clued_private.development_execute_authorized_v14(uuid,uuid,jsonb)'::regprocedure`)).rows[0];
      const before = name === rawConflictMigration ? await rawKernel() : null;
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      if (before) {
        const after = await rawKernel();
        const oldRaise = "raise exception 'record_version_conflict' using errcode='40001';";
        const newRaise = "raise exception 'record_version_conflict' using errcode='PT409';";
        assert.equal(before.definition.split(oldRaise).length - 1, 2);
        assert.equal(after.definition, before.definition.replaceAll(oldRaise, newRaise),
          'only the two raw Record business-conflict SQLSTATE literals change');
        assert.deepEqual(after.metadata, before.metadata, 'kernel OID, owner, ACL and security configuration are unchanged');
        assert.ok(after.definition.includes("raise exception 'feedback_version_conflict' using errcode='40001';"),
          'unrelated serialization SQLSTATE is not broadly remapped');
        await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
        assert.deepEqual(await rawKernel(), after, 'exact migration replay is a no-op');
      }
    }
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);
    await assertGatewayCloseoutBoundary(admin);

    const owner = uuid();
    const other = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'all-contexts@example.invalid',now()),($2,'all-contexts-other@example.invalid',now())`, [owner, other]);
    const human = await connect('authenticated', owner);
    const foreignHuman = await connect('authenticated', other);
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const anon = await connect('anon');
    const resource = 'https://all-contexts.example.invalid/mcp';
    const issuer = proof();
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
      values($1,$2,'All-contexts fixture issuer')`, [issuer, resource]);

    async function native(name, input, db = human) {
      return (await db.query(`select public.${name}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
    }
    async function prepare(requestedScopes = ['context:read', 'context:write', 'audit:read'], db = human, clientId = 'all-contexts-client') {
      return (await db.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) value', [issuer, JSON.stringify({
        request_digest: proof(), client_id: clientId, client_name: 'All-contexts fixture',
        redirect_uri: 'https://client.example.invalid/cb', resource, requested_scopes: requestedScopes,
      })])).rows[0].value;
    }
    async function approve(request, selected, db = human) {
      const token = proof();
      const expires = future();
      const result = (await db.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value',
        [issuer, request.request_id, request.version, JSON.stringify(selected), token, expires])).rows[0].value;
      return { ...result, token, expires };
    }
    // Independent Integration cases must not share a previously revoked OAuth client lineage.
    // Deliberately related Bindings still pass the same case-local clientId.
    const authorize = async (selected, scopes, db = human, clientId) => approve(await prepare(scopes, db, clientId), selected, db);
    const own = (input, db = human) => native('clued_development_owner_v14', { idempotency_key: uuid(), ...input }, db);
    const createContext = async (projectId, name, environment = 'test', db = human) => {
      const result = await own({ op: 'context_create', project_id: projectId, name, environment }, db);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return result.result.id;
    };
    async function fixtureProject(actor, name, db = admin) {
      const id = uuid();
      await db.query('begin');
      try {
        // Fixture/admin INSERT has the same explicitly held early Owner guard.
        await db.query('select clued_private.authorization_writer_guard_v2($1)', [actor]);
        await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
          values($1,$2,$3,$4,$5)`, [id, actor, name, name.toLowerCase(), `project:${id}`]);
        await db.query('commit');
      } catch (error) { await db.query('rollback'); throw error; }
      return id;
    }
    const project = await fixtureProject(owner, 'Owned project');
    const foreignProject = await fixtureProject(other, 'Foreign project');
    const testContext = await createContext(project, 'Exact test context');
    const previewContext = await createContext(project, 'Exact preview context', 'preview');
    const foreignContext = await createContext(foreignProject, 'Foreign context', 'test', foreignHuman);
    async function legacyBinding(selected) {
      // A real pre-source-protocol state: no new approve writer or policy is used.
      // This proves the migration baseline boundary rather than making a new direct source look old.
      const token = proof();
      const id = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'OAuth','Legacy effective baseline',$2,clued_private.authorization_scope_union_v12($3::jsonb),array['*']) returning id`, [owner, token, JSON.stringify(selected)])).rows[0].id;
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
        await admin.query(`insert into clued_private.authorizations_v12(binding_id,owner_id,client_id,client_name,resource,expires_at,issuance)
          values($1,$2,'legacy-all-contexts','Legacy baseline',$3,$4,'headless')`, [id, owner, resource, future()]);
        for (const row of selected) {
          await admin.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions,qualification_id)
            values($1,$2,$3,$4,$5,$6)`, [id, row.resource_kind, row.resource_id, row.environment, row.actions, row.qualification_id ?? null]);
          if (row.resource_kind === 'context') await admin.query(`insert into clued_private.development_grants_v14
            (context_id,binding_id,grantor,actions,history_policy,version_policy,freeze_cursor,allowed_fields,expires_at)
            values($1,$2,(select owner_id from clued_private.development_spaces_v14 where id=$1),$3,'EXISTING_AND_FUTURE','LATEST',0,array['*'],$4)`, [row.resource_id, id, row.actions, future()]);
        }
        await admin.query('commit');
      } catch (error) { await admin.query('rollback'); throw error; }
      return { binding_id: id, token };
    }
    const entries = async (bindingId) => (await admin.query(`select resource_kind,resource_id,environment,actions
      from clued_private.authorization_entries_v12 where binding_id=$1 order by resource_kind,resource_id,environment`, [bindingId])).rows;
    const entry = async (bindingId, kind, id, environment = 'canonical') => (await entries(bindingId))
      .find((row) => row.resource_kind === kind && row.resource_id === id && row.environment === environment);
    const grant = async (bindingId, contextId) => (await admin.query(`select * from clued_private.development_grants_v14
      where binding_id=$1 and context_id=$2`, [bindingId, contextId])).rows[0];
    const bindingView = async (bindingId, db = human) => (await native('clued_authorization_manage_v12', { op: 'list' }, db))
      .bindings.find((row) => row.binding_id === bindingId);
    const development = (binding, input, db = gateway) => workerGatewayRpc(db, 'clued_development_call_v14', binding.token,
      { mode: 'development_history', ...input });
    const write = (binding, contextId, content, db = gateway) => development(binding,
      { op: 'record_put', context_id: contextId, record_type: 'note', body: { title: content, content }, idempotency_key: uuid() }, db);
    const denied = (promise, pattern = /not_authorized|access_denied|grant|scope|source|permission|denied|qualification|current_project_action_required/) =>
      assert.rejects(promise, (error) => ['42501', '28000', '22023', '40001'].includes(error.code) && pattern.test(error.message));
    async function requestUpgrade(binding, role = 'developer') {
      const asked = await workerGatewayRpc(gateway, 'clued_owner_request_v1', binding.token, {
        action: 'connection.permission', resources: [`permission:contexts:*/${role}`], idempotency_key: uuid(),
      });
      assert.equal(asked.status, 'committed', JSON.stringify(asked));
      const confirmation = await native('clued_owner_grant_confirmation_issue_v1', { request_id: asked.request.request_id, choice: 'once' });
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      return { asked, confirmation };
    }
    async function finishUpgrade({ confirmation }, db = human) {
      const result = await native('clued_owner_grant_v1', { confirmation_token: confirmation.confirmation_token,
        view_digest: confirmation.view_digest }, db);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return result;
    }
    async function sourcesReduce(bindingId, sources, exceptions = [], db = human) {
      const view = await bindingView(bindingId, db);
      return native('clued_authorization_manage_v12', { op: 'reduce', binding_id: bindingId, base_version: Number(view.version),
        selection_format: 'sources_v1', sources, exceptions }, db);
    }
    const sourceSelection = (source, actions) => ({ source_id: source.source_id, base_version: Number(source.version), action_cap: actions });
    async function macroSource(bindingId) {
      const view = await bindingView(bindingId);
      assert.ok(Array.isArray(view.sources), 'upgraded Binding exposes source identities');
      const result = view.sources.find((row) => row.kind === 'contexts_policy');
      assert.ok(result, 'one macro source is represented independently');
      return result;
    }

    async function completeProjection(bindingId) {
      const tables = [
        ['binding', 'select to_jsonb(a) value from public.clued_agent_bindings a where id=$1'],
        ['authorization', 'select to_jsonb(a) value from clued_private.authorizations_v12 a where binding_id=$1'],
        ['source_mode', 'select to_jsonb(a) value from clued_private.authorization_source_bindings_v2 a where binding_id=$1'],
        ['sources', 'select to_jsonb(a) value from clued_private.authorization_sources_v2 a where binding_id=$1 order by id'],
        ['contributions', 'select to_jsonb(a) value from clued_private.authorization_contributions_v2 a join clued_private.authorization_sources_v2 s on s.id=a.source_id where s.binding_id=$1 order by a.source_id,a.resource_kind,a.resource_id,a.environment'],
        ['overrides', 'select to_jsonb(a) value from clued_private.authorization_resource_overrides_v2 a where binding_id=$1 order by id'],
        ['entries', 'select to_jsonb(a) value from clued_private.authorization_entries_v12 a where binding_id=$1 order by resource_kind,resource_id,environment'],
        ['grants', 'select to_jsonb(a) value from clued_private.development_grants_v14 a where binding_id=$1 order by id'],
        ['authorization_audit', 'select to_jsonb(a) value from clued_private.authorization_audit_v12 a where binding_id=$1 order by recorded_at,operation'],
      ];
      const result = {};
      for (const [name, sql] of tables) result[name] = (await admin.query(sql, [bindingId])).rows.map((row) => row.value);
      for (const [name, table] of [['receipts', 'clued_audit_receipts'], ['events', 'clued_context_events']]) {
        result[name] = (await admin.query(`select to_jsonb(a) value from public.${table} a where user_id=$1 order by id`, [owner])).rows.map((row) => row.value);
      }
      return result;
    }
    const constraints = async () => (await admin.query(`select conname,convalidated,pg_get_constraintdef(oid) definition
      from pg_constraint where conrelid='public.clued_agent_bindings'::regclass order by conname`)).rows;
    const integrationCall = (binding, name, input, db = gateway) => workerGatewayRpc(db, name, binding.token, input);
    async function installIntegration(binding, options = {}) {
      const opened = await integrationCall(binding, 'clued_integration_request_open_v1', {
        request_key: uuid(), intent: 'create_or_bind', host: 'anthropic.claude', host_surface: 'chat',
        adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED', ...options,
      });
      const bound = await integrationCall(binding, 'clued_integration_create_or_bind_v1', {
        idempotency_key: uuid(), request_id: opened.request_id, binding_intent: 'CREATE_OR_BIND',
      });
      assert.equal(bound.status, 'committed', JSON.stringify(bound));
      return bound.supplemental.integration_id;
    }
    const sourceProjection = async (bindingId) => (await admin.query(
      'select clued_private.authorization_current_projection_v2($1) value', [bindingId])).rows[0].value;
    const normalized = async (integrationId) => (await admin.query(
      'select clued_private.integration_normalize_detail_v1($1,clock_timestamp()) value', [integrationId])).rows[0].value;
    const evaluateIntegration = async (integrationId) => (await admin.query(
      'select clued_private.integration_evaluate_v1($1,clock_timestamp()) value', [integrationId])).rows[0].value;
    const diagnosticRows = async (integrationId) => (await admin.query(
      'select to_jsonb(a) value from clued_private.integration_derivation_diagnostics_v1 a where integration_id=$1 order by facts_sha256',
      [integrationId])).rows.map((row) => row.value);
    async function assertLostAuthorityState(binding, integrationId, state) {
      const before = await completeProjection(binding.binding_id);
      const beforeBusiness = await integrationBusiness(integrationId);
      const beforeDiagnostics = await diagnosticRows(integrationId);
      const result = await evaluateIntegration(integrationId);
      assert.equal(result.valid, true, JSON.stringify(result));
      assert.deepEqual(result.reason_codes, []);
      assert.deepEqual(result.effective_capabilities, []);
      assert.equal(result.facts.authentication_state, 'USABLE', 'a current valid credential is never forged into NONE');
      assert.equal(result.facts.authorization_state, state);
      const status = await integrationCall(binding, 'clued_integration_status_v1', { integration_id: integrationId });
      assert.equal(status.integration.evaluation.valid, true, JSON.stringify(status));
      assert.deepEqual(status.integration.evaluation.reason_codes, []);
      assert.deepEqual(status.integration.evaluation.effective_capabilities, []);
      assert.deepEqual(await diagnosticRows(integrationId), beforeDiagnostics, 'ordinary Source loss is not invalid input and adds no diagnostic');
      assert.deepEqual(await completeProjection(binding.binding_id), before, 'evaluate/status adds no receipt/event or authorization mutation');
      assert.deepEqual(await integrationBusiness(integrationId), beforeBusiness, 'evaluate/status adds no Integration business mutation');
    }
    async function integrationBusiness(integrationId) {
      const result = {};
      for (const table of ['integrations_v1', 'integration_connections_v1', 'integration_facts_v1',
        'integration_capability_declarations_v1', 'integration_canonical_verifications_v1', 'integration_ready_verifications_v1', 'integration_operation_log_v1',
        'integration_revocations_v1', 'integration_reauth_marks_v1', 'integration_identity_snapshots_v1', 'integration_claims_v1',
        'integration_derivation_diagnostics_v1', 'integration_regrants_v1']) {
        result[table] = (await admin.query(`select to_jsonb(a) value from clued_private.${table} a where integration_id=$1 order by to_jsonb(a)::text`,
          [integrationId])).rows.map((row) => row.value);
      }
      result.requests = (await admin.query(`select to_jsonb(a) value from clued_private.integration_installation_requests_v1 a
        where owner_id=$1 order by request_id`, [owner])).rows.map((row) => row.value);
      result.binding_owners = (await admin.query(`select to_jsonb(a) value from clued_private.integration_binding_owners_v1 a
        where owner_id=$1 order by binding_id`, [owner])).rows.map((row) => row.value);
      return result;
    }

    for (const ownership of ['owner', 'member']) {
      await t.test(`raw ${ownership} stale put and revoke return PT409 without changing Record, cursor or audit`, async () => {
        const actions = ['read', 'write', 'close'];
        let contextId;
        let binding;
        if (ownership === 'owner') {
          contextId = await createContext(project, `Raw owner CAS ${uuid()}`);
          binding = await authorize([context(contextId, actions)], undefined, human, `raw-cas-owner-${uuid()}`);
        } else {
          const memberProject = await fixtureProject(other, `Raw member CAS ${uuid()}`);
          contextId = await createContext(memberProject, 'Raw member CAS context', 'test', foreignHuman);
          const invite = await native('clued_project_access_v13', { op: 'invite_create', project_id: memberProject,
            environment: 'test', target_email: 'all-contexts@example.invalid', role: 'editor', actions,
            expires_at: future(), idempotency_key: uuid() }, foreignHuman);
          const membership = await native('clued_project_access_v13', { op: 'invite_accept', invite_token: invite.invite_token,
            base_version: invite.version, idempotency_key: uuid() });
          const request = await prepare(undefined, human, `raw-cas-member-${uuid()}`);
          const eligible = request.eligible.find((row) => row.resource_id === contextId);
          assert.equal(eligible.ownership, 'membership');
          assert.equal(eligible.qualification_id, membership.membership_id);
          assert.deepEqual(sorted(eligible.actions), sorted(actions));
          binding = await approve(request, [context(contextId, actions)]);
        }
        const qualification = (await admin.query(`select qualification_id from clued_private.authorization_entries_v12
          where binding_id=$1 and resource_kind='context' and resource_id=$2 and environment='test'`,
        [binding.binding_id, contextId])).rows[0].qualification_id;
        assert.equal(qualification === null, ownership === 'owner', 'the real own/member dispatch paths remain distinct');
        assert.deepEqual(sorted((await grant(binding.binding_id, contextId)).actions), ['read', 'write'],
          'close uses the existing internal write grant, never a fabricated grant action');
        const originalOperationCount = (await admin.query(`select count(*)::int n
          from clued_private.development_operations_v14 where context_id=$1`, [contextId])).rows[0].n;

        const created = await write(binding, contextId, `Raw ${ownership} v1`);
        assert.equal(created.status, 'committed');
        assert.equal(Number(created.result.version), 1);
        const recordId = created.result.id;
        const bodyV2 = { title: `Raw ${ownership} v2`, content: `Current ${ownership} body must survive stale writes` };
        const updated = await development(binding, { op: 'record_put', context_id: contextId, record_id: recordId,
          record_type: 'note', base_version: 1, body: bodyV2, idempotency_key: uuid() });
        assert.equal(updated.status, 'committed');
        assert.equal(Number(updated.result.version), 2);
        assert.equal(updated.actor_user_id, owner);
        assert.equal(updated.resource_owner_id, ownership === 'owner' ? owner : other);

        async function rawBusiness() {
          const result = {};
          for (const [name, table, predicate, order] of [
            ['context', 'development_spaces_v14', 'id=$1', 'id'],
            ['records', 'development_records_v14', 'context_id=$1', 'id'],
            ['versions', 'development_record_versions_v14', 'context_id=$1', 'record_id,version'],
            ['operations', 'development_operations_v14', 'context_id=$1', 'id'],
            ['receipts', 'development_receipts_v14', 'context_id=$1', 'id'],
            ['events', 'development_events_v14', 'context_id=$1', 'id'],
          ]) result[name] = (await admin.query(`select to_jsonb(a) value from clued_private.${table} a
            where ${predicate} order by ${order}`, [contextId])).rows.map((row) => row.value);
          return result;
        }
        const before = await rawBusiness();
        assert.deepEqual(before.records[0].body, bodyV2);
        assert.equal(Number(before.records[0].version), 2);
        assert.equal(before.records[0].lifecycle_status, 'ACTIVE');
        assert.equal(before.versions.length, 2);
        assert.equal(before.operations.length, originalOperationCount + 2);
        assert.equal(before.receipts.length, before.operations.length);
        assert.equal(before.events.length, before.operations.length);
        const conflict = (error) => error.code === 'PT409' && error.message === 'record_version_conflict';
        await assert.rejects(development(binding, { op: 'record_put', context_id: contextId, record_id: recordId,
          record_type: 'note', base_version: 1, body: { title: 'Stale', content: 'Must never replace v2' },
          idempotency_key: uuid() }), conflict, 'stale update is a non-retryable business conflict');
        assert.deepEqual(await rawBusiness(), before, 'stale put rolls back cursor, body, history and Receipt/Event writes');
        await assert.rejects(development(binding, { op: 'record_revoke', context_id: contextId, record_id: recordId,
          base_version: 1, reason: 'Stale revoke must not retire v2', idempotency_key: uuid() }), conflict,
        'stale revoke is the same exact non-retryable conflict');
        assert.deepEqual(await rawBusiness(), before, 'stale revoke also leaves the complete business projection unchanged');
        await assert.rejects(development(binding, { op: 'record_put', context_id: contextId, environment: 'preview',
          record_id: recordId, record_type: 'note', base_version: 2, body: bodyV2, idempotency_key: uuid() }),
        (error) => error.code === '42501' && error.message === 'context_environment_denied',
        'the conflict repair does not remap authorization denials');
        assert.deepEqual(await rawBusiness(), before);
        const revoked = await development(binding, { op: 'record_revoke', context_id: contextId, record_id: recordId,
          base_version: 2, reason: 'Dispose successful raw CAS fixture', idempotency_key: uuid() });
        assert.equal(revoked.status, 'committed', 'current-version revoke proves the real close permission was present');
        assert.equal(Number(revoked.result.version), 3);
        assert.equal(revoked.result.lifecycle_status, 'REVOKED');
        const after = await rawBusiness();
        assert.deepEqual(after.records[0].body, bodyV2);
        assert.equal(after.versions.length, 3);
        assert.equal(after.operations.length, originalOperationCount + 3);
      });
    }

    await t.test('eligible policy intersects requested scopes and preserves the API action vocabulary', async () => {
      const request = await prepare();
      const item = request.eligible.find((row) => row.resource_id === 'contexts:*');
      assert.ok(item);
      assert.equal(item.resource_kind, 'scope');
      assert.equal(item.environment, 'canonical');
      assert.deepEqual(sorted(item.actions), sorted(['read', 'write', 'close', 'restore', 'audit', 'feedback_submit']));
      const readOnly = (await prepare(['context:read'])).eligible.find((row) => row.resource_id === 'contexts:*');
      assert.deepEqual(readOnly.actions, ['read']);
      const readonly = await authorize([macro(['read'])], ['context:read']);
      await denied(write(readonly, testContext, 'Scope ceiling'));
      await denied(authorize([macro(['write'])], ['context:read']), /selection|scope|permission|action/);
    });

    await t.test('one Native macro approval covers exact self-owned resources with no foreign or execution-policy shortcut', async () => {
      const binding = await authorize([macro(['read', 'write', 'close', 'restore', 'audit', 'feedback_submit'])]);
      for (const id of ['global', 'profile', `project:${project}`]) {
        assert.deepEqual(sorted((await entry(binding.binding_id, 'scope', id)).actions), sorted(['read', 'write', 'close', 'restore', 'audit']));
      }
      for (const [id, environment] of [[testContext, 'test'], [previewContext, 'preview']]) {
        assert.deepEqual(sorted((await entry(binding.binding_id, 'context', id, environment)).actions), sorted(['read', 'write', 'close', 'feedback_submit']));
        const internal = await grant(binding.binding_id, id);
        assert.deepEqual(sorted(internal.actions), sorted(['read', 'write', 'feedback_submit']));
        assert.equal(internal.history_policy, 'EXISTING_AND_FUTURE');
        assert.equal(internal.version_policy, 'LATEST');
        assert.deepEqual(internal.allowed_fields, ['*']);
      }
      assert.equal(await entry(binding.binding_id, 'scope', `project:${foreignProject}`), undefined);
      assert.equal(await entry(binding.binding_id, 'context', foreignContext, 'test'), undefined);
      const written = await write(binding, testContext, 'Legitimate exact write');
      assert.equal(written.status, 'committed', JSON.stringify(written));
      assert.ok(written.receipt_id && written.event_id);
      await denied(development(binding, { op: 'record_list', context_id: testContext, environment: 'production' }));
      await denied(write(binding, foreignContext, 'Foreign write'));
      await assert.rejects(() => admin.query('select (clued_private.resolve_binding_action_v12($1,$2,$3,$4)).id',
        [binding.token, 'context:read', 'contexts:*', 'read']), /not_authorized|resource/);
    });

    await t.test('same-Binding Owner upgrade preserves legacy baseline; removing macro restores only legacy read', async () => {
      const old = await legacyBinding([scope('profile', ['read']), scope(`project:${project}`, ['read'])]);
      const before = await entries(old.binding_id);
      const upgrade = await requestUpgrade(old);
      assert.equal(upgrade.confirmation.confirmation_view.connection.binding_id, old.binding_id);
      await finishUpgrade(upgrade);
      assert.equal((await write(old, testContext, 'Same Binding after explicit Owner upgrade')).status, 'committed');
      const source = await macroSource(old.binding_id);
      const view = await bindingView(old.binding_id);
      assert.ok(view.sources.some((row) => row.kind === 'legacy_effective_baseline'));
      await sourcesReduce(old.binding_id, [sourceSelection(source, [])]);
      assert.deepEqual(await entries(old.binding_id), before, 'no synthesized write is copied back into baseline');
      await denied(write(old, testContext, 'Removed macro must not survive'));
      await assert.rejects(async () => native('clued_authorization_manage_v12', { op: 'reduce', binding_id: old.binding_id,
        base_version: Number((await bindingView(old.binding_id)).version), selected: before }), /sources_v1|selection_format|source_selection/);
    });

    await t.test('new explicit Native consent really extends a read-only macro scope ceiling and its future resources', async () => {
      const binding = await authorize([macro(['read'])], ['context:read']);
      const source = await macroSource(binding.binding_id);
      await denied(write(binding, testContext, 'Before explicit new scope consent'));
      await finishUpgrade(await requestUpgrade(binding, 'developer'));
      const upgraded = await macroSource(binding.binding_id);
      assert.equal(upgraded.source_id, source.source_id);
      assert.ok(upgraded.version > source.version);
      assert.equal((await write(binding, testContext, 'Existing Context after scope extension')).status, 'committed');
      const futureContext = await createContext(project, 'New Context after policy scope extension');
      assert.equal((await write(binding, futureContext, 'Future Context after scope extension')).status, 'committed');
      await finishUpgrade(await requestUpgrade(binding, 'full'));
      assert.deepEqual(sorted((await entry(binding.binding_id, 'context', testContext, 'test')).actions), sorted(['read', 'write', 'close', 'feedback_submit']));
      assert.deepEqual(sorted((await entry(binding.binding_id, 'scope', `project:${project}`)).actions), sorted(['read', 'write', 'close', 'restore', 'audit']));
    });

    await t.test('new Native policy consent renews an expired source within the unchanged Authorization hard expiry', async () => {
      const binding = await authorize([macro(['read'])], ['context:read']);
      const source = await macroSource(binding.binding_id);
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [source.source_id]);
      await denied(development(binding, { op: 'record_list', context_id: testContext }));
      // Cached macro read cannot make a truly expired source count as granted.
      await finishUpgrade(await requestUpgrade(binding, 'reader'));
      assert.equal((await development(binding, { op: 'record_list', context_id: testContext })).status, 'ok');
      const current = await macroSource(binding.binding_id);
      assert.notEqual(current.source_id, source.source_id, 'expired consent is a new source identity');
      assert.ok((await admin.query('select revoked_at from clued_private.authorization_sources_v2 where id=$1', [source.source_id])).rows[0].revoked_at);
      const renewed = (await admin.query('select expires_at from clued_private.authorization_sources_v2 where id=$1', [current.source_id])).rows[0];
      assert.equal(renewed.expires_at.toISOString(), binding.expires);
      assert.equal((await admin.query('select expires_at from clued_private.authorizations_v12 where binding_id=$1', [binding.binding_id])).rows[0].expires_at.toISOString(), binding.expires);
    });

    await t.test('fresh reader consent after expired full never revives old write/full and leaves a live independent source intact', async () => {
      const binding = await authorize([macro(['read', 'write', 'close', 'restore', 'audit', 'feedback_submit']), context(testContext, ['read', 'write'])]);
      const old = await macroSource(binding.binding_id);
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [old.source_id]);
      assert.equal((await write(binding, testContext, 'Independent direct source remains live')).status, 'committed');
      await denied(write(binding, previewContext, 'Expired policy write'));
      const approval = await requestUpgrade(binding, 'reader');
      const shown = approval.confirmation.confirmation_view.context_coverage.resources.find((r) => r.resource_id === previewContext);
      assert.deepEqual(shown.actual_actions, ['read']);
      await finishUpgrade(approval);
      const fresh = await macroSource(binding.binding_id);
      assert.notEqual(fresh.source_id, old.source_id);
      assert.deepEqual(fresh.actions, ['read']);
      await denied(write(binding, previewContext, 'Reader cannot revive expired write'));
      assert.equal((await development(binding, { op: 'record_list', context_id: previewContext })).status, 'ok');
      assert.equal((await write(binding, testContext, 'Independent source is preserved after fresh consent')).status, 'committed');
      const futureContext = await createContext(project, 'Fresh reader future Context');
      assert.deepEqual((await entry(binding.binding_id, 'context', futureContext, 'test')).actions, ['read']);
      await denied(write(binding, futureContext, 'Future write must remain denied'));
      assert.deepEqual((await entry(binding.binding_id, 'scope', `project:${project}`)).actions, ['read']);
    });

    await t.test('specified exact Context and canonical project selections have independent boundaries', async () => {
      const exact = await authorize([context(testContext, ['read', 'write'])]);
      const formal = await authorize([scope(`project:${project}`, ['read', 'write'])]);
      assert.equal((await write(exact, testContext, 'Exact UUID')).status, 'committed');
      await denied(write(exact, previewContext, 'Different environment Context'));
      await denied(write(formal, testContext, 'Formal does not imply Context'));
      const later = await createContext(project, 'Later exact name');
      await denied(write(exact, later, 'Specified has no future inheritance'));
      assert.equal(await entry(exact.binding_id, 'scope', `project:${project}`), undefined);
      assert.equal(await entry(formal.binding_id, 'context', later, 'test'), undefined);
    });

    await t.test('future Context and future Project inherit only the live self-owned macro', async () => {
      const live = await authorize([macro(['read', 'write'])]);
      const oldProjectPolicy = await authorize([scope('project:*', ['read', 'write', 'close', 'restore'])]);
      const later = await createContext(project, 'Inherited Context', 'production');
      assert.equal((await write(live, later, 'Inherited production record')).status, 'committed');
      assert.equal(await entry(oldProjectPolicy.binding_id, 'context', later, 'production'), undefined);
      const nextProject = await fixtureProject(owner, 'Future owned project');
      const nextContext = await createContext(nextProject, 'Future project Context', 'preview');
      assert.deepEqual(sorted((await entry(live.binding_id, 'scope', `project:${nextProject}`)).actions), ['read', 'write']);
      assert.deepEqual(sorted((await entry(oldProjectPolicy.binding_id, 'scope', `project:${nextProject}`)).actions), ['close', 'read', 'restore', 'write']);
      assert.equal((await write(live, nextContext, 'Future project exact Context')).status, 'committed');
      assert.equal(await entry(oldProjectPolicy.binding_id, 'context', nextContext, 'preview'), undefined);
      const source = await macroSource(live.binding_id);
      await sourcesReduce(live.binding_id, [sourceSelection(source, ['read'])]);
      await denied(write(live, nextContext, 'Policy reduction propagates'));
      const afterReduce = await createContext(nextProject, 'After reduce');
      assert.deepEqual((await entry(live.binding_id, 'context', afterReduce, 'test')).actions, ['read']);
      await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: live.binding_id,
        base_version: Number((await bindingView(live.binding_id)).version) });
      const afterRevoke = await createContext(nextProject, 'After revoke');
      assert.equal(await entry(live.binding_id, 'context', afterRevoke, 'test'), undefined);
    });

    await t.test('precise deny and existing history/field/version ceilings survive macro overlap and future refresh', async () => {
      const limited = await legacyBinding([context(testContext, ['read'])]);
      const initial = await grant(limited.binding_id, testContext);
      await admin.query(`update clued_private.development_grants_v14 set history_policy='EXISTING_ONLY',
        version_policy='FIXED_AT_GRANT',allowed_fields=array['title'],freeze_cursor=0,
        expires_at=clock_timestamp()+interval '15 minutes' where id=$1`, [initial.id]);
      const oldLimits = await grant(limited.binding_id, testContext);
      await finishUpgrade(await requestUpgrade(limited, 'full'));
      const after = await grant(limited.binding_id, testContext);
      for (const field of ['history_policy', 'version_policy', 'allowed_fields', 'freeze_cursor', 'since_cursor', 'explicit_record_ids']) {
        assert.deepEqual(after[field], oldLimits[field], field);
      }
      assert.equal(after.expires_at.toISOString(), oldLimits.expires_at.toISOString());
      assert.deepEqual(after.actions, ['read'], 'macro cannot enlarge the old exact grant action ceiling');
      const live = await authorize([macro(['read', 'write'])]);
      await sourcesReduce(live.binding_id, [], [{ resource_kind: 'context', resource_id: testContext, environment: 'test',
        denied_actions: ['read', 'write'] }]);
      await denied(write(live, testContext, 'Denied UUID'));
      const sameName = await createContext(project, 'Exact test context');
      assert.equal((await write(live, sameName, 'New UUID is a new resource')).status, 'committed');
      await denied(write(live, testContext, 'Refresh must not clear deny'));
      const narrowed = await macroSource(live.binding_id);
      await sourcesReduce(live.binding_id, [sourceSelection(narrowed, ['read'])]);
      await denied(development(live, { op: 'record_list', context_id: testContext }));
      const exception = (await bindingView(live.binding_id)).overrides.find((row) => row.resource_kind === 'context'
        && row.resource_id === testContext && row.environment === 'test');
      assert.ok(exception, 'exact denial remains a persistent source-independent exception');
      assert.deepEqual(sorted(exception.denied_actions), ['read', 'write']);
    });

    await t.test('single submitted macro materializes more than 100 real resources without a hidden truncation', async () => {
      const manyOwner = uuid();
      await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'many-contexts@example.invalid',now())", [manyOwner]);
      const manyHuman = await connect('authenticated', manyOwner);
      const manyProject = await fixtureProject(manyOwner, 'Large exact resource set');
      const ids = [];
      for (let i = 0; i < 105; i += 1) ids.push(await createContext(manyProject, `Context ${i}`, 'test', manyHuman));
      const binding = await authorize([macro(['read', 'write'])], undefined, manyHuman);
      const actual = (await entries(binding.binding_id)).filter((row) => row.resource_kind === 'context');
      assert.equal(actual.length, 105);
      assert.deepEqual(actual.map((row) => row.resource_id).sort(), ids.sort());
      assert.equal((await admin.query('select count(*)::int n from clued_private.development_grants_v14 where binding_id=$1',
        [binding.binding_id])).rows[0].n, 105);
      assert.equal((await write(binding, ids[104], 'The last resource is not omitted')).status, 'committed');
    });

    await t.test('management DTO exposes real activity, readable names and source-independent denial', async () => {
      const binding = await authorize([macro(['read', 'write'])]);
      const view = await bindingView(binding.binding_id);
      assert.equal(view.active, true);
      const named = view.grants.find((row) => row.resource_kind === 'context' && row.resource_id === testContext);
      assert.equal(named.name, 'Exact test context');
      assert.equal(named.context_name, named.name);
      assert.equal(named.project_id, project);
      assert.equal(named.project_name, 'Owned project');
      assert.ok(named.source_refs.length);
      await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: binding.binding_id, base_version: view.version });
      assert.equal((await bindingView(binding.binding_id)).active, false);
    });

    await t.test('last live source and last effective exact entry reject with a business error and complete rollback; explicit revoke truly denies MCP', async () => {
      for (const mode of ['last-source', 'last-entry']) {
        const request = await prepare(['context:read']);
        assert.ok(request.eligible.some((row) => row.resource_kind === 'scope' && row.resource_id === 'global' && row.actions.includes('read')));
        const binding = await approve(request, [scope('global', ['read'])]);
        const read = () => workerGatewayRpc(gateway, 'clued_record_list', binding.token, { level: 'global', record_type: 'note' });
        assert.ok(Array.isArray((await read()).records));
        const view = await bindingView(binding.binding_id);
        assert.equal(view.selection_format, 'sources_v1');
        assert.ok(view.sources.length > 0 && view.sources.every((s) => s.kind === 'direct'));
        const before = await completeProjection(binding.binding_id);
        const beforeConstraints = await constraints();
        await assert.rejects(() => sourcesReduce(binding.binding_id,
          mode === 'last-source' ? view.sources.map((s) => sourceSelection(s, [])) : [],
          mode === 'last-entry' ? [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', denied_actions: ['read'] }] : []),
        (error) => error.code === '22023' && error.message === 'authorization_empty_projection_requires_binding_revoke'
          && /未保存/.test(error.detail) && /撤销连接/.test(error.detail) && error.constraint === undefined);
        assert.deepEqual(await completeProjection(binding.binding_id), before, `${mode}: B/Auth/Sources/contributions/overrides/entries/grants/audit/receipts/events fully roll back`);
        assert.deepEqual(await bindingView(binding.binding_id), view, `${mode}: actual Native DTO is unchanged`);
        assert.deepEqual(await constraints(), beforeConstraints, 'the validated NONEMPTY CHECK remains exact');
        assert.ok(Array.isArray((await read()).records), 'failed unsaved reduction retains the original access');
        await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: binding.binding_id, base_version: view.version });
        assert.equal((await bindingView(binding.binding_id)).active, false);
        await denied(read());
        await denied(integrationCall(binding, 'clued_integration_request_open_v1', { request_key: uuid() }));
      }
    });

    await t.test('a future project policy with zero owned projects remains meaningful and later materializes a real project', async () => {
      const freshOwner = uuid();
      await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'future-only@example.invalid',now())", [freshOwner]);
      const freshHuman = await connect('authenticated', freshOwner);
      assert.equal(Number((await admin.query('select count(*) n from public.clued_projects where user_id=$1', [freshOwner])).rows[0].n), 0);
      const binding = await authorize([scope('project:*', ['read'])], ['context:read'], freshHuman);
      assert.deepEqual((await entry(binding.binding_id, 'scope', 'project:*')).actions, ['read']);
      const current = await sourceProjection(binding.binding_id);
      assert.equal(current.has_permissions, true);
      assert.deepEqual(current.scopes, ['context:read']);
      assert.equal(current.entries.length, 1, 'only the authorized future policy exists before any project');
      const newProject = await fixtureProject(freshOwner, 'First future-only project');
      assert.deepEqual((await entry(binding.binding_id, 'scope', `project:${newProject}`)).actions, ['read']);
      const read = await workerGatewayRpc(gateway, 'clued_record_list', binding.token, { level: 'project', project_id: newProject, record_type: 'note' });
      assert.ok(Array.isArray(read.records));
    });

    await t.test('expired final source cannot execute Integration mutations or revive cached authority; Native revoke remains available', async () => {
      const clientId = `all-contexts-integration-${uuid()}`;
      const binding = await authorize([context(testContext, ['read', 'write'])], undefined, human, clientId);
      const id = await installIntegration(binding);
      const original = await bindingView(binding.binding_id);
      const cached = await entries(binding.binding_id);
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [binding.binding_id]);
      assert.equal((await sourceProjection(binding.binding_id)).has_permissions, false);
      const identity = (await admin.query('select clued_private.integration_binding_identity_v1($1) value', [binding.binding_id])).rows[0].value;
      assert.equal(identity.live, false); assert.equal(identity.auth_usable, false);
      assert.deepEqual(identity.authority, { scopes: [], entries: [] });
      const facts = (await normalized(id)).facts;
      assert.deepEqual(facts.oauth_scope_facts, []);
      assert.deepEqual(facts.resource_action_scope_facts.capabilities, []);
      const snapshot = await completeProjection(binding.binding_id);
      const integrationBefore = await integrationBusiness(id);
      for (const name of ['clued_integration_request_open_v1', 'clued_integration_create_or_bind_v1',
        'clued_integration_identity_update_v1', 'clued_integration_reconcile_request_v1',
        'clued_integration_declare_v1', 'clued_integration_report_v1', 'clued_integration_verify_v1']) {
        await denied(integrationCall(binding, name, { integration_id: id, request_key: uuid(), idempotency_key: uuid(),
          kind: 'ready_profile', request_id: uuid(), binding_intent: 'CREATE_OR_BIND' }), /authorization_no_effective_source_permission/);
      }
      await denied(development(binding, { op: 'record_list', context_id: testContext }));
      assert.deepEqual(await completeProjection(binding.binding_id), snapshot, 'execution refusals are read-only with no receipts or Source repair');
      assert.deepEqual(await integrationBusiness(id), integrationBefore, 'no integration, link, fact, declaration, verification, operation, revoke or reauth row changes');
      assert.deepEqual(await entries(binding.binding_id), cached, 'cached nonempty projection is not execution authority');
      const status = await integrationCall(binding, 'clued_integration_status_v1', { integration_id: id });
      assert.ok(status.integration, 'diagnostics remain reachable with a valid credential');
      await assertLostAuthorityState(binding, id, 'EXPIRED');
      await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: binding.binding_id, base_version: original.version });
      await denied(development(binding, { op: 'record_list', context_id: testContext }));
    });

    await t.test('revoking the final Context grant commits without Source rebuild rollback and denies MCP and Integration execution', async () => {
      const clientId = `all-contexts-integration-${uuid()}`;
      const binding = await authorize([context(testContext, ['read', 'write'])], undefined, human, clientId);
      const id = await installIntegration(binding);
      const initial = await grant(binding.binding_id, testContext);
      const result = await own({ op: 'grant_revoke', context_id: testContext, grant_id: initial.id, base_version: initial.version });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.ok((await grant(binding.binding_id, testContext)).revoked_at);
      assert.equal(await entry(binding.binding_id, 'context', testContext, 'test'), undefined);
      assert.equal((await sourceProjection(binding.binding_id)).has_permissions, false);
      await denied(development(binding, { op: 'record_list', context_id: testContext }));
      await denied(write(binding, testContext, 'Revoked final Context permission'));
      await denied(integrationCall(binding, 'clued_integration_report_v1', { integration_id: id }), /authorization_no_effective_source_permission/);
      await denied(integrationCall(binding, 'clued_integration_verify_v1', { integration_id: id, kind: 'ready_profile' }), /authorization_no_effective_source_permission/);
      const facts = (await normalized(id)).facts;
      assert.deepEqual(facts.oauth_scope_facts, []);
      assert.deepEqual(facts.resource_action_scope_facts.capabilities, []);
      await assertLostAuthorityState(binding, id, 'REVOKED_CONNECTION');
      const view = await bindingView(binding.binding_id);
      await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: binding.binding_id, base_version: view.version });
      await denied(development(binding, { op: 'record_list', context_id: testContext }));
    });

    await t.test('Integration capabilities use the same live exact entry, retaining read while independently expired write is denied', async () => {
      const clientId = `all-contexts-integration-${uuid()}`;
      const binding = await authorize([scope('global', ['write']), scope(`project:${project}`, ['read'])], undefined, human, clientId);
      const id = await installIntegration(binding);
      const facts = (await normalized(id)).facts;
      assert.ok(facts.resource_action_scope_facts.capabilities.includes('project.read'));
      assert.ok(!facts.resource_action_scope_facts.capabilities.includes('project.write'), 'global write cannot synthesize project write');
      const view = await bindingView(binding.binding_id);
      const writeSource = view.sources.find((s) => s.contributions.some((c) => c.resource_id === 'global'));
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [writeSource.source_id]);
      const after = (await normalized(id)).facts;
      assert.deepEqual(after.oauth_scope_facts, ['context:read']);
      assert.ok(after.resource_action_scope_facts.capabilities.includes('project.read'));
      assert.ok(!after.resource_action_scope_facts.capabilities.includes('context.write'));
      assert.equal((await sourceProjection(binding.binding_id)).has_permissions, true);
    });

    await t.test('all seven Integration business families reject final membership revoke and natural Source expiry after actual waits with full rollback', async (waitTests) => {
      // Disposable registry extension, as in the existing Integration runtime
      // fixtures: real public calls create complete/claimed identities and a
      // legitimate collision for reconcile. No Binding/Source/claim simulation.
      await admin.query(`insert into clued_private.integration_hosts_v1(host,tenant_dimension,account_dimension,
        tenant_evidence_kinds,account_evidence_kinds,first_authorization_required,registry_version,capability_snapshot_ref)
        values('source.wait.tenant','REQUIRED','NOT_APPLICABLE',array['TEST_TENANT_ID'],'{}',true,1,'disposable Source wait fixture')`);
      await admin.query(`insert into clued_private.integration_host_surfaces_v1(host,surface,capability_ceiling,host_features,registry_version)
        values('source.wait.tenant','default',array['audit.read','context.read','context.write','development_history.read','evidence.write','project.read','project.write'],
          '{"mcp_tools":true,"oauth":true}',1)`);
      await admin.query(`insert into clued_private.integration_ready_profiles_v1(profile_id,profile_version,required_capabilities,
        required_qualification,evidence_rules,freshness_ttl)
        values('source.wait.read',1,array['context.read'],'ANY','{"context.read":{"kind":"resume_after_link"}}',interval '5 minutes')`);
      const names = ['clued_integration_request_open_v1', 'clued_integration_create_or_bind_v1',
        'clued_integration_identity_update_v1', 'clued_integration_reconcile_request_v1',
        'clued_integration_declare_v1', 'clued_integration_report_v1', 'clued_integration_verify_v1'];
      for (const loss of ['membership-revoke', 'natural-expiry']) for (const name of names) {
        await waitTests.test(`${name}: ${loss} while actually blocked`, async () => {
          const clientId = `all-contexts-integration-${uuid()}`;
          let membership;
          if (loss === 'membership-revoke') {
            const invite = await native('clued_project_access_v13', { op: 'invite_create', project_id: foreignProject, environment: 'test',
              target_email: 'all-contexts@example.invalid', role: 'editor', actions: ['read', 'write'], expires_at: future(), idempotency_key: uuid() }, foreignHuman);
            membership = await native('clued_project_access_v13', { op: 'invite_accept', invite_token: invite.invite_token,
              base_version: invite.version, idempotency_key: uuid() });
          }
          const binding = await authorize([context(loss === 'membership-revoke' ? foreignContext : testContext, ['read', 'write'])], undefined, human, clientId);
          const tenant = { status: 'VALUE', value: uuid(), evidence_kind: 'TEST_TENANT_ID' };
          let id;
          if (name === 'clued_integration_reconcile_request_v1') {
            const holding = await authorize([scope('global', ['read'])], ['context:read'], human, clientId);
            await installIntegration(holding, { host: 'source.wait.tenant', host_surface: 'default', tenant });
            id = await installIntegration(binding, { host: 'source.wait.tenant', host_surface: 'default' });
            const base = Number((await admin.query('select version from clued_private.integrations_v1 where integration_id=$1', [id])).rows[0].version);
            const conflict = await integrationCall(binding, 'clued_integration_identity_update_v1', {
              idempotency_key: uuid(), integration_id: id, base_version: base, tenant });
            assert.equal(conflict.status, 'committed', JSON.stringify(conflict));
            assert.equal(conflict.supplemental.identity_claim_state, 'CLAIM_CONFLICT');
          } else id = await installIntegration(binding, { host: 'source.wait.tenant', host_surface: 'default', tenant });
          const version = Number((await admin.query('select version from clued_private.integrations_v1 where integration_id=$1', [id])).rows[0].version);
          const requestPayload = { request_key: uuid(), intent: 'reauthorization', target_integration_id: id,
            host: 'source.wait.tenant', host_surface: 'default', tenant, adapter_family: 'test-adapter', adapter_version: '1.0.0', installation_phase: 'COMPLETED' };
          let input = { integration_id: id, base_version: version, idempotency_key: uuid() };
          if (name === 'clued_integration_request_open_v1') input = requestPayload;
          if (name === 'clued_integration_create_or_bind_v1') {
            const req = await integrationCall(binding, 'clued_integration_request_open_v1', requestPayload);
            input = { request_id: req.request_id, binding_intent: 'REAUTHORIZATION', idempotency_key: uuid() };
          }
          if (name === 'clued_integration_declare_v1') Object.assign(input, { host_surface: 'default', declared_capabilities: ['context.read'],
            host_features: { mcp_tools: true }, adapter_family: 'test-adapter', adapter_version: '1.0.0' });
          if (name === 'clued_integration_report_v1') Object.assign(input, { action: 'set', truth_class: 'adapter_state', value: 'BLOCKED', reason: 'Source wait boundary' });
          if (name === 'clued_integration_verify_v1') Object.assign(input, { kind: 'ready_profile', profile_id: 'source.wait.read', profile_version: 1 });
          const holder = await connect();
          const waiting = await connect();
          if (loss === 'natural-expiry') await admin.query(`update clued_private.authorization_sources_v2
            set expires_at=clock_timestamp()+interval '1500 milliseconds' where binding_id=$1`, [binding.binding_id]);
          assert.equal((await sourceProjection(binding.binding_id)).has_permissions, true, 'permission is live before entering the RPC');
          await holder.query('begin');
          let pending;
          try {
            if (name === 'clued_integration_request_open_v1') {
              await integrationCall(binding, name, input, holder);
              await holder.query('reset role');
            } else {
              await holder.query('select 1 from clued_private.integrations_v1 where integration_id=$1 for update', [id]);
            }
            pending = integrationCall(binding, name, input, waiting).then((value) => ({ value }), (error) => ({ error }));
            const actualWait = await waitForLock(waiting, holder);
            assert.equal(actualWait.wait_event_type, 'Lock');
            if (loss === 'membership-revoke') {
              const revoked = await native('clued_project_access_v13', { op: 'member_revoke', membership_id: membership.membership_id,
                base_version: membership.version, idempotency_key: uuid() }, foreignHuman);
              assert.ok(revoked, 'real membership revoke commits while the Binding/Integration operation remains blocked');
              assert.ok((await admin.query('select revoked_at from clued_private.project_memberships_v13 where id=$1',
                [membership.membership_id])).rows[0].revoked_at);
            } else {
              const deadline = Date.now() + 4000;
              while ((await sourceProjection(binding.binding_id)).has_permissions && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.equal((await sourceProjection(binding.binding_id)).has_permissions, false, 'authority is lost while the actual backend is still waiting');
            const revokedWait = await waitForLock(waiting, holder);
            assert.equal(revokedWait.wait_event_type, 'Lock');
            // Capture before release, so a buggy waiting call cannot commit
            // before the baseline read and hide its own effects. Only the
            // Request holder has a legitimate pending business row to account for.
            const before = await completeProjection(binding.binding_id);
            const businessBefore = await integrationBusiness(id);
            if (name === 'clued_integration_request_open_v1') {
              const heldRequest = (await holder.query('select to_jsonb(a) value from clued_private.integration_installation_requests_v1 a where owner_id=$1 and request_key=$2',
                [owner, input.request_key])).rows[0].value;
              businessBefore.requests.push(heldRequest);
              businessBefore.requests.sort((a, b) => a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0);
            }
            const diagnosticsBefore = await diagnosticRows(id);
            await holder.query('commit');
            const result = await pending;
            assert.ok(result.error, JSON.stringify(result.value));
            assert.equal(result.error.code, '42501');
            assert.equal(result.error.message, 'authorization_no_effective_source_permission');
            assert.deepEqual(await completeProjection(binding.binding_id), before, 'no Binding, Source, authorization, receipt or event effect from the refused RPC');
            assert.deepEqual(await integrationBusiness(id), businessBefore, 'no Integration, Request, identity, claim, fact, declaration, verification, link, ownership, revoke or reauth effect');
            assert.deepEqual(await diagnosticRows(id), diagnosticsBefore, 'no artificial invalid-input diagnostic');
            const evaluated = await evaluateIntegration(id);
            assert.equal(evaluated.valid, true, JSON.stringify(evaluated));
            assert.deepEqual(evaluated.reason_codes, []);
            assert.deepEqual(evaluated.effective_capabilities, []);
            waitTests.diagnostic(JSON.stringify({ family: name, loss, wait_event: actualWait.wait_event,
              source_live_before_wait: true, source_live_at_release: false, actual_error: { code: result.error.code, message: result.error.message } }));
          } finally {
            await holder.query('rollback').catch(() => {});
            if (pending) await pending;
          }
        });
      }
    });

    await t.test('partial permission loss while waiting retains real read but rolls back the entered operation instead of committing an old authority snapshot', async () => {
      for (const loss of ['membership-read-only', 'independent-write-expiry']) {
        const clientId = `all-contexts-integration-${uuid()}`;
        let membership;
        let binding;
        if (loss === 'membership-read-only') {
          const invite = await native('clued_project_access_v13', { op: 'invite_create', project_id: foreignProject, environment: 'test',
            target_email: 'all-contexts@example.invalid', role: 'editor', actions: ['read', 'write'], expires_at: future(), idempotency_key: uuid() }, foreignHuman);
          membership = await native('clued_project_access_v13', { op: 'invite_accept', invite_token: invite.invite_token,
            base_version: invite.version, idempotency_key: uuid() });
          binding = await authorize([context(foreignContext, ['read', 'write'])], undefined, human, clientId);
        } else binding = await authorize([scope('global', ['read']), context(testContext, ['write'])], undefined, human, clientId);
        const id = await installIntegration(binding);
        const version = Number((await admin.query('select version from clued_private.integrations_v1 where integration_id=$1', [id])).rows[0].version);
        const holder = await connect();
        const waiting = await connect();
        if (loss === 'independent-write-expiry') {
          const source = (await bindingView(binding.binding_id)).sources.find((s) => s.contributions.some((c) => c.resource_id === testContext));
          assert.ok(source);
          await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()+interval '1500 milliseconds' where id=$1", [source.source_id]);
        }
        await holder.query('begin');
        let pending;
        try {
          await holder.query('select 1 from clued_private.integrations_v1 where integration_id=$1 for update', [id]);
          pending = integrationCall(binding, 'clued_integration_report_v1', { integration_id: id, base_version: version,
            idempotency_key: uuid(), action: 'set', truth_class: 'adapter_state', value: 'BLOCKED', reason: 'Partial Source wait boundary' }, waiting)
            .then((value) => ({ value }), (error) => ({ error }));
          await waitForLock(waiting, holder);
          if (loss === 'membership-read-only') {
            const reduced = await native('clued_project_access_v13', { op: 'member_reduce', membership_id: membership.membership_id,
              base_version: membership.version, actions: ['read'], idempotency_key: uuid() }, foreignHuman);
            assert.ok(reduced);
            assert.deepEqual((await admin.query('select actions from clued_private.project_memberships_v13 where id=$1', [membership.membership_id])).rows[0].actions, ['read']);
          } else {
            const deadline = Date.now() + 4000;
            while ((await sourceProjection(binding.binding_id)).scopes.includes('context:write') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const current = await sourceProjection(binding.binding_id);
          assert.equal(current.has_permissions, true);
          assert.deepEqual(current.scopes, ['context:read']);
          await waitForLock(waiting, holder);
          const before = await completeProjection(binding.binding_id);
          const businessBefore = await integrationBusiness(id);
          await holder.query('commit');
          const result = await pending;
          assert.ok(result.error, JSON.stringify(result.value));
          assert.equal(result.error.code, '42501');
          assert.equal(result.error.message, 'authorization_source_permission_changed_during_call');
          assert.deepEqual(await completeProjection(binding.binding_id), before);
          assert.deepEqual(await integrationBusiness(id), businessBefore);
          assert.deepEqual((await sourceProjection(binding.binding_id)).scopes, ['context:read'], 'the separately committed restriction is retained');
          if (loss === 'membership-read-only') {
            assert.equal((await development(binding, { op: 'record_list', context_id: foreignContext })).status, 'ok');
            await denied(write(binding, foreignContext, 'Reduced member write remains denied'));
            const member = (await admin.query('select version from clued_private.project_memberships_v13 where id=$1', [membership.membership_id])).rows[0];
            await native('clued_project_access_v13', { op: 'member_revoke', membership_id: membership.membership_id,
              base_version: member.version, idempotency_key: uuid() }, foreignHuman);
          } else {
            assert.ok(Array.isArray((await workerGatewayRpc(gateway, 'clued_record_list', binding.token, { level: 'global', record_type: 'note' })).records));
            await denied(write(binding, testContext, 'Expired independent write remains denied'));
          }
        } finally {
          await holder.query('rollback').catch(() => {});
          if (pending) await pending;
        }
      }
    });

    await t.test('per-source expiry is checked at execution without read repair or killing a live independent source', async () => {
      const binding = await authorize([context(testContext, ['read']), macro(['write'])]);
      const sources = (await bindingView(binding.binding_id)).sources;
      const policy = sources.find((row) => row.kind === 'contexts_policy');
      const direct = sources.find((row) => row.kind === 'direct');
      assert.ok(policy && direct);
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [policy.source_id]);
      const before = await entries(binding.binding_id);
      await denied(write(binding, testContext, 'Expired write source'));
      assert.equal((await development(binding, { op: 'record_list', context_id: testContext })).status, 'ok');
      assert.deepEqual(await entries(binding.binding_id), before, 'diagnostic/read paths never repair or remove cached projection');
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [direct.source_id]);
      await denied(development(binding, { op: 'record_list', context_id: testContext }));
    });

    await t.test('revoked grants reopen only through exact Native old-to-new confirmation and all CAS values', async () => {
      const binding = await authorize([macro(['read', 'write'])]);
      const initial = await grant(binding.binding_id, testContext);
      const revocation = await own({ op: 'grant_revoke', context_id: testContext, grant_id: initial.id, base_version: initial.version });
      assert.equal(revocation.status, 'committed', JSON.stringify(revocation));
      await denied(write(binding, testContext, 'Exact grant revoked'));
      const actual = await grant(binding.binding_id, testContext);
      await assert.rejects(() => own({ op: 'grant_upsert', context_id: testContext, binding_id: binding.binding_id,
        grant_id: actual.id, base_version: actual.version, actions: ['read', 'write'], history_policy: 'EXISTING_AND_FUTURE',
        version_policy: 'LATEST', allowed_fields: ['*'], expires_at: binding.expires }), /explicit_grant_confirmation_required|explicit_connection_grant_required/);
      const state = await bindingView(binding.binding_id);
      const exception = state.overrides.find((row) => row.resource_id === testContext);
      const input = { op: 'limit_confirmation_issue', binding_id: binding.binding_id, base_version: state.version,
        resource_kind: 'context', resource_id: testContext, environment: 'test', grant_id: actual.id, grant_base_version: actual.version,
        override_id: exception.override_id, override_base_version: exception.version,
        new: { actions: ['read', 'write'], denied_actions: [], allowed_ceiling: null, history_policy: 'EXISTING_AND_FUTURE',
          version_policy: 'LATEST', freeze_cursor: 0, since_cursor: null, explicit_record_ids: [], allowed_fields: ['*'], expires_at: binding.expires } };
      const rejected = await native('clued_authorization_manage_v12', { ...input, grant_base_version: actual.version + 1 });
      assert.equal(rejected.status, 'rejected');
      assert.match(rejected.error_code, /version_conflict/);
      const confirmation = await native('clued_authorization_manage_v12', input);
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      assert.ok(confirmation.confirmation_view.old.grant.revoked_at);
      assert.deepEqual(confirmation.confirmation_view.new.effective_allowed_ceiling, ['read', 'write']);
      const consume = { op: 'limit_confirm', confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest };
      const result = await native('clued_authorization_manage_v12', consume);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.ok(result.receipt_id);
      assert.equal((await write(binding, testContext, 'Explicitly reopened exact UUID')).status, 'committed');
      const version = (await grant(binding.binding_id, testContext)).version;
      assert.equal((await native('clued_authorization_manage_v12', consume)).replayed, true);
      assert.equal((await grant(binding.binding_id, testContext)).version, version);
    });

    await t.test('historical exact action reduction survives upgrade, refresh and rotation until separate Native confirmation', async () => {
      const binding = await legacyBinding([scope('profile', ['read']), context(testContext, ['read', 'write'])]);
      const original = await grant(binding.binding_id, testContext);
      // A legitimate pre-migration Native grant_upsert could narrow only
      // internal actions; the precise v12 entry remained read/write. Seed
      // that historical committed state without using new provenance helpers.
      await admin.query("update clued_private.development_grants_v14 set actions=array['read'],version=version+1 where id=$1", [original.id]);
      const before = await bindingView(binding.binding_id);
      const oldRow = before.grants.find((r) => r.resource_id === testContext);
      assert.deepEqual(oldRow.effective_actions, ['read'], 'legacy diagnostics respect the live exact grant');
      const upgrade = await requestUpgrade(binding);
      const preview = upgrade.confirmation.confirmation_view.context_coverage.resources.find((r) => r.resource_id === testContext);
      assert.deepEqual(preview.actual_actions, ['read']);
      assert.deepEqual(preview.missing_actions, ['write']);
      await finishUpgrade(upgrade);
      assert.deepEqual((await grant(binding.binding_id, testContext)).actions, ['read']);
      await denied(write(binding, testContext, 'Macro cannot erase a legal old action reduction'));
      await createContext(project, 'Action ceiling refresh');
      await denied(write(binding, testContext, 'Future hook cannot erase action ceiling'));
      const state = await bindingView(binding.binding_id);
      const rotate = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Action ceiling rotation', days: 1, selected: [],
        replaces_binding_id: binding.binding_id, selection_format: 'sources_v1',
        sources: state.sources.map((s) => ({ source_id: s.source_id, base_version: s.version, action_cap: s.actions })),
        exceptions: state.overrides.map((o) => ({ override_id: o.override_id, base_version: o.version })) });
      assert.equal(rotate.status, 'issued', JSON.stringify(rotate));
      const rotated = await native('clued_headless_binding_issue_v1', { confirmation_token: rotate.confirmation_token, view_digest: rotate.view_digest });
      assert.equal(rotated.status, 'committed', JSON.stringify(rotated));
      assert.deepEqual((await grant(rotated.binding_id, testContext)).actions, ['read']);
      const token = crypto.createHash('sha256').update(rotated.token).digest('hex');
      await denied(write({ token }, testContext, 'Rotation retains old action reduction'));
      const view = await bindingView(rotated.binding_id);
      const meta = view.grants.find((r) => r.resource_id === testContext).precise_limit_confirmation;
      const limits = view.grants.find((r) => r.resource_id === testContext).limits;
      const confirmation = await native('clued_authorization_manage_v12', { op: 'limit_confirmation_issue', binding_id: rotated.binding_id,
        base_version: view.version, resource_kind: 'context', resource_id: testContext, environment: 'test',
        grant_id: meta.grant_id, grant_base_version: meta.grant_version, override_id: meta.override_id, override_base_version: meta.override_version,
        new: { actions: ['read', 'write'], denied_actions: [], allowed_ceiling: null, history_policy: 'EXISTING_AND_FUTURE', version_policy: 'LATEST',
          freeze_cursor: limits.freeze_cursor, since_cursor: null, explicit_record_ids: [], allowed_fields: ['*'], expires_at: limits.expires_at } });
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      const restored = await native('clued_authorization_manage_v12', { op: 'limit_confirm', confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
      assert.equal(restored.status, 'committed', JSON.stringify(restored));
      assert.equal((await write({ token }, testContext, 'Only new precise Native consent restores write')).status, 'committed');
    });

    await t.test('canonical precise denial needs its own Native confirmation with no fabricated grant', async () => {
      const binding = await authorize([macro(['read', 'write'])]);
      await sourcesReduce(binding.binding_id, [], [{ resource_kind: 'scope', resource_id: 'profile', environment: 'canonical', denied_actions: ['read', 'write'] }]);
      const state = await bindingView(binding.binding_id);
      const row = state.grants.find((r) => r.resource_kind === 'scope' && r.resource_id === 'profile');
      assert.deepEqual(row.actions, []);
      assert.equal(row.precise_limit_confirmation.supported, true);
      assert.equal(row.precise_limit_confirmation.grant_id, null);
      assert.ok(row.precise_limit_confirmation.current_expires_at);
      const input = { op: 'limit_confirmation_issue', binding_id: binding.binding_id, base_version: state.version,
        resource_kind: 'scope', resource_id: 'profile', environment: 'canonical', grant_id: null, grant_base_version: null,
        override_id: row.precise_limit_confirmation.override_id, override_base_version: row.precise_limit_confirmation.override_version,
        new: { actions: ['read', 'write'], denied_actions: [], allowed_ceiling: null, expires_at: binding.expires } };
      const confirmation = await native('clued_authorization_manage_v12', input);
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      assert.equal(confirmation.confirmation_view.old.grant, null);
      assert.equal(confirmation.confirmation_view.grant_id, null);
      const result = await native('clued_authorization_manage_v12', { op: 'limit_confirm', confirmation_token: confirmation.confirmation_token,
        view_digest: confirmation.view_digest });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.deepEqual(sorted((await entry(binding.binding_id, 'scope', 'profile')).actions), ['read', 'write']);
    });

    await t.test('precise confirmation binds Auth and exact limit versions and burns a stale token atomically', async () => {
      const binding = await authorize([macro(['read', 'write'])]);
      await sourcesReduce(binding.binding_id, [], [{ resource_kind: 'scope', resource_id: 'profile', environment: 'canonical', denied_actions: ['write'] }]);
      const state = await bindingView(binding.binding_id);
      const override = state.overrides.find((o) => o.resource_id === 'profile');
      const confirmation = await native('clued_authorization_manage_v12', { op: 'limit_confirmation_issue', binding_id: binding.binding_id,
        base_version: state.version, resource_kind: 'scope', resource_id: 'profile', environment: 'canonical',
        grant_id: null, grant_base_version: null, override_id: override.override_id, override_base_version: override.version,
        new: { actions: ['read', 'write'], denied_actions: [], allowed_ceiling: null, expires_at: binding.expires } });
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      const policy = await macroSource(binding.binding_id);
      await sourcesReduce(binding.binding_id, [sourceSelection(policy, ['read'])]);
      const result = await native('clued_authorization_manage_v12', { op: 'limit_confirm', confirmation_token: confirmation.confirmation_token,
        view_digest: confirmation.view_digest });
      assert.equal(result.status, 'rejected');
      assert.match(result.error_code, /version_conflict|stale/);
      assert.deepEqual((await entry(binding.binding_id, 'scope', 'profile')).actions, ['read']);
      assert.equal((await admin.query('select consume_outcome from clued_private.native_confirmation_tokens where id=$1', [confirmation.token_id])).rows[0].consume_outcome, 'rejected');
    });

    await t.test('an invited Context is separate from the macro and keeps its exact original qualification', async () => {
      const clientId = `all-contexts-integration-${uuid()}`;
      const invite = await native('clued_project_access_v13', { op: 'invite_create', project_id: foreignProject, environment: 'test',
        target_email: 'all-contexts@example.invalid', role: 'editor', actions: ['read', 'write'], expires_at: future(), idempotency_key: uuid() }, foreignHuman);
      const membership = await native('clued_project_access_v13', { op: 'invite_accept', invite_token: invite.invite_token,
        base_version: invite.version, idempotency_key: uuid() });
      const request = await prepare(undefined, human, clientId);
      const eligible = request.eligible.find((r) => r.resource_id === foreignContext);
      assert.equal(eligible.qualification_id, membership.membership_id);
      assert.equal(eligible.ownership, 'membership');
      const macroBinding = await authorize([macro(['read', 'write'])], undefined, human, clientId);
      await denied(write(macroBinding, foreignContext, 'Shared is not part of all-owned'));
      const explicit = await approve(request, [{ ...context(foreignContext, ['read', 'write']), qualification_id: uuid() }]);
      const invitedIntegration = await installIntegration(explicit);
      assert.equal((await write(explicit, foreignContext, 'Explicit invitation qualification')).status, 'committed');
      assert.equal((await admin.query('select qualification_id from clued_private.authorization_entries_v12 where binding_id=$1 and resource_id=$2',
        [explicit.binding_id, foreignContext])).rows[0].qualification_id, membership.membership_id, 'client cannot forge qualification ID');
      const legacy = await legacyBinding([{ ...context(foreignContext, ['read', 'write']), qualification_id: membership.membership_id }]);
      assert.deepEqual((await bindingView(legacy.binding_id)).grants.find((r) => r.resource_id === foreignContext).effective_actions, ['read', 'write']);
      const reducedMember = await native('clued_project_access_v13', { op: 'member_reduce', membership_id: membership.membership_id,
        base_version: membership.version, actions: ['read'], idempotency_key: uuid() }, foreignHuman);
      assert.deepEqual((await bindingView(legacy.binding_id)).grants.find((r) => r.resource_id === foreignContext).effective_actions, ['read'],
        'legacy diagnostics intersect the still-current exact qualification actions');
      await denied(write(legacy, foreignContext, 'Reduced legacy member action'));
      await native('clued_project_access_v13', { op: 'member_revoke', membership_id: membership.membership_id, base_version: reducedMember.version,
        idempotency_key: uuid() }, foreignHuman);
      await denied(write(explicit, foreignContext, 'Revoked membership'));
      assert.equal((await sourceProjection(explicit.binding_id)).has_permissions, false, 'revoked exact qualification cannot remain effective Source authority');
      assert.deepEqual((await normalized(invitedIntegration)).facts.resource_action_scope_facts.capabilities, []);
      await assertLostAuthorityState(explicit, invitedIntegration, 'REVOKED_CONNECTION');
      await denied(integrationCall(explicit, 'clued_integration_verify_v1', { integration_id: invitedIntegration, kind: 'ready_profile' }),
        /authorization_no_effective_source_permission/);
      await admin.query("update clued_private.development_spaces_v14 set name='PRIVATE RENAMED CONTEXT AFTER REVOKE' where id=$1", [foreignContext]);
      await admin.query("update public.clued_projects set name='PRIVATE RENAMED PROJECT AFTER REVOKE' where id=$1", [foreignProject]);
      const invalid = (await bindingView(explicit.binding_id)).grants.find((r) => r.resource_id === foreignContext);
      assert.equal(invalid.availability, 'unavailable');
      assert.equal(invalid.ownership, 'unavailable');
      for (const key of ['name', 'project_id', 'project_name', 'context_name']) assert.equal(invalid[key], null, key);
      assert.deepEqual(invalid.effective_actions, []);
      const allViews = await native('clued_authorization_manage_v12', { op: 'list' });
      assert.equal(JSON.stringify(allViews).includes('PRIVATE RENAMED'), false, 'revoked original member cannot observe new private names');
      const preview = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Unavailable old member preview', days: 1,
        selected: [context(foreignContext, ['read', 'write'])], replaces_binding_id: explicit.binding_id });
      assert.equal(preview.status, 'rejected');
      assert.equal(JSON.stringify(preview).includes('PRIVATE RENAMED'), false);
      const newInvite = await native('clued_project_access_v13', { op: 'invite_create', project_id: foreignProject, environment: 'test',
        target_email: 'all-contexts@example.invalid', role: 'editor', actions: ['read', 'write'], expires_at: future(), idempotency_key: uuid() }, foreignHuman);
      const next = await native('clued_project_access_v13', { op: 'invite_accept', invite_token: newInvite.invite_token, base_version: newInvite.version, idempotency_key: uuid() });
      assert.notEqual(next.membership_id, membership.membership_id);
      await denied(write(explicit, foreignContext, 'New membership must not replace original qualification'));
      const current = await authorize([context(foreignContext, ['read', 'write'])], undefined, human, clientId);
      assert.equal((await write(current, foreignContext, 'New explicit consent')).status, 'committed');
    });

    await t.test('unupgraded v12 Headless rotation preserves legacy history, fields, expiry and unknown baseline provenance', async () => {
      const binding = await legacyBinding([scope('profile', ['read']), context(testContext, ['read'])]);
      const original = await grant(binding.binding_id, testContext);
      await admin.query("update clued_private.development_grants_v14 set history_policy='EXISTING_ONLY',version_policy='FIXED_AT_GRANT',allowed_fields=array['title'],expires_at=clock_timestamp()+interval '10 minutes' where id=$1", [original.id]);
      const oldGrant = await grant(binding.binding_id, testContext);
      const before = await entries(binding.binding_id);
      const confirmation = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Legacy baseline rotation', days: 1,
        selected: before.map(({ resource_kind, resource_id, environment, actions }) => ({ resource_kind, resource_id, environment, actions })),
        replaces_binding_id: binding.binding_id });
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      assert.ok(Array.isArray(confirmation.confirmation_view.source_snapshot.legacy_entries));
      const result = await native('clued_headless_binding_issue_v1', { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      const newGrant = await grant(result.binding_id, testContext);
      for (const key of ['history_policy', 'version_policy', 'freeze_cursor', 'since_cursor', 'explicit_record_ids', 'allowed_fields', 'expires_at']) assert.deepEqual(newGrant[key], oldGrant[key], key);
      const view = await bindingView(result.binding_id);
      assert.equal(view.selection_format, 'sources_v1');
      assert.deepEqual(view.sources.map((s) => s.kind), ['legacy_effective_baseline']);
      assert.equal(view.sources.some((s) => s.kind === 'direct'), false, 'old union projection is not guessed to be independent consent');
      const rejected = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Cannot widen old choice', days: 1,
        selected: [scope('profile', ['read', 'write']), context(testContext, ['read'])], replaces_binding_id: binding.binding_id });
      assert.equal(rejected.status, 'rejected');
    });

    await t.test('Headless source rotation snapshots every source, exception and exact grant limit', async () => {
      const confirmed = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Source rotation', days: 1, selected: [macro(['read', 'write'])] });
      assert.equal(confirmed.status, 'issued', JSON.stringify(confirmed));
      const issued = await native('clued_headless_binding_issue_v1', { confirmation_token: confirmed.confirmation_token, view_digest: confirmed.view_digest });
      assert.equal(issued.status, 'committed', JSON.stringify(issued));
      const state = await bindingView(issued.binding_id);
      await sourcesReduce(issued.binding_id, [], [{ resource_kind: 'context', resource_id: testContext, environment: 'test', denied_actions: ['write'] }]);
      const before = await bindingView(issued.binding_id);
      const rotateInput = { label: 'Rotated source', days: 7, selected: [], replaces_binding_id: issued.binding_id,
        selection_format: 'sources_v1', sources: before.sources.map((s) => ({ source_id: s.source_id, base_version: s.version, action_cap: s.actions })),
        exceptions: before.overrides.map((o) => ({ override_id: o.override_id, base_version: o.version })) };
      const rotation = await native('clued_headless_binding_confirmation_issue_v1', rotateInput);
      assert.equal(rotation.status, 'issued', JSON.stringify(rotation));
      const snapshot = rotation.confirmation_view.source_snapshot;
      assert.equal(snapshot.binding_version, before.version);
      for (const key of ['sources', 'exceptions', 'grant_limits']) assert.ok(Array.isArray(snapshot[key]));
      assert.equal(snapshot.grant_limits.length, before.grants.filter((r) => r.resource_kind === 'context').length,
        'denied write retains a live read grant and all exact grant limits remain included');
      const rotated = await native('clued_headless_binding_issue_v1', { confirmation_token: rotation.confirmation_token, view_digest: rotation.view_digest });
      assert.equal(rotated.status, 'committed', JSON.stringify(rotated));
      const after = await bindingView(rotated.binding_id);
      assert.equal(after.selection_format, 'sources_v1');
      assert.deepEqual(after.sources.map((s) => [s.kind, s.actions]), before.sources.map((s) => [s.kind, s.actions]));
      const oldDeny = before.overrides.find((o) => o.resource_id === testContext);
      const newDeny = after.overrides.find((o) => o.resource_id === testContext);
      assert.deepEqual(newDeny.denied_actions, oldDeny.denied_actions);
      const rotatedToken = crypto.createHash('sha256').update(rotated.token).digest('hex');
      await denied(write({ token: rotatedToken }, testContext, 'Rotation cannot clear deny'));
      assert.equal((await native('clued_headless_binding_issue_v1', { confirmation_token: rotation.confirmation_token, view_digest: rotation.view_digest })).token, null);
    });

    async function waitForLock(db, blocker) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = (await admin.query(`select a.wait_event_type,a.wait_event,pg_blocking_pids(a.pid) blockers
          from pg_stat_activity a where a.pid=$1`, [db.processID])).rows[0];
        if (row?.wait_event_type === 'Lock' && row.blockers.includes(blocker.processID)) return row;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('actual second connection did not wait for the controlled first transaction');
    }
    async function race(first, second, firstOperation, secondOperation, verify) {
      await first.query('begin');
      let pending;
      try {
        const firstResult = await firstOperation();
        pending = secondOperation().then((value) => ({ value }), (error) => ({ error }));
        const wait = await waitForLock(second, first);
        assert.equal(wait.wait_event, 'advisory', 'early Owner barrier is reached before conflicting resource row locks');
        await first.query('commit');
        const result = await pending;
        if (result.error) throw result.error;
        await verify(firstResult, result.value);
      } catch (error) {
        await first.query('rollback').catch(() => {});
        if (pending) await pending;
        throw error;
      }
    }

    await t.test('two real clients: approval first then Context creation observes the new policy after waiting', async () => {
      const first = await connect('authenticated', owner);
      const second = await connect('authenticated', owner);
      const request = await prepare();
      await race(first, second, () => approve(request, [macro(['read', 'write'])], first),
        () => createContext(project, 'Queued Context creation', 'test', second), async (binding, id) => {
          assert.deepEqual(sorted((await entry(binding.binding_id, 'context', id, 'test')).actions), ['read', 'write']);
          assert.equal((await write(binding, id, 'No approval-first phantom')).status, 'committed');
        });
    });

    await t.test('two real clients: Context creation first then approval observes the committed new resource', async () => {
      const first = await connect('authenticated', owner);
      const second = await connect('authenticated', owner);
      const request = await prepare();
      await race(first, second, () => createContext(project, 'Held uncommitted Context', 'test', first),
        () => approve(request, [macro(['read', 'write'])], second), async (id, binding) => {
          assert.deepEqual(sorted((await entry(binding.binding_id, 'context', id, 'test')).actions), ['read', 'write']);
          assert.equal((await write(binding, id, 'No creation-first phantom')).status, 'committed');
        });
    });

    await t.test('two real clients: Native permission approval and Context creation cannot form the old GrantLock/Binding cycle', async () => {
      const binding = await authorize([scope('profile', ['read'])], ['context:read']);
      const request = await requestUpgrade(binding);
      const first = await connect('authenticated', owner);
      const second = await connect('authenticated', owner);
      await race(first, second, () => finishUpgrade(request, first),
        () => createContext(project, 'After held permission approval', 'test', second), async (_result, id) => {
          assert.equal((await write(binding, id, 'No inversion deadlock')).status, 'committed');
        });
    });

    await t.test('unguarded inserts, fake GUC guard, stronger snapshot and private API calls fail closed', async () => {
      await admin.query('drop trigger test_authorization_early_writer_v2 on clued_private.development_spaces_v14');
      const insert = `insert into clued_private.development_spaces_v14(owner_id,project_id,name,environment)
        values($1,$2,'Unguarded','test')`;
      await assert.rejects(() => admin.query(insert, [owner, project]), /writer|guard|barrier/);
      await admin.query("select set_config('clued.authorization_writer_guard',$1,false)", [owner]);
      await assert.rejects(() => admin.query(insert, [owner, project]), /writer|guard|barrier/);
      await human.query('begin isolation level repeatable read');
      try { await assert.rejects(() => createContext(project, 'Old snapshot', 'test'), /read_committed|isolation/); }
      finally { await human.query('rollback'); }
      await assert.rejects(() => anon.query('select clued_private.authorization_writer_guard_v2($1)', [owner]), /permission denied/);
      const exposed = (await admin.query(`select p.oid::regprocedure::text signature from pg_proc p
        where p.pronamespace='clued_private'::regnamespace and p.proname like 'authorization%v2'
        and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')
          or has_function_privilege('service_role',p.oid,'execute')) order by 1`)).rows;
      assert.deepEqual(exposed, []);
      await assertGatewayCloseoutBoundary(admin);
    });
  } finally {
    for (const db of clients.reverse()) await db.end().catch(() => {});
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('clued-all-contexts-'));
    await stopCluster(server);
    await removeTestDirectory(target);
  }
});
