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
import { AUTHORIZATION_SUCCESSOR_MIGRATIONS, CLOSEOUT_MIGRATION, assertAuthorizationSuccessorBoundary,
  assertGatewayCloseoutBoundary, snapshotAuthorizationCallerBoundary, snapshotCallerCatalog, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = '20260924120000_project_lifecycle_successor_v2.sql';
const currentnessMigration = '20260924121000_project_lifecycle_successor_v2_frontier_invalidation.sql';
const issuerMigration = '20261009070001_issuer_identity_credentials_v1.sql';
const gatewayMigration = '20261009070002_worker_gateway_transition_v1.sql';
const storageMasterMigration = '20261011035952_storage_master_control_v1.sql';
const storageReconnectRetryMigration = '20261011101500_storage_reconnect_retry_v1.sql';
const storageReconnectRefreshMigration = '20261012033722_storage_reconnect_refresh_default_v1.sql';
const storageConflictMigration = '20261016040000_storage_conflict_isolation_v1.sql';
const storageAutomaticReconcileMigration = '20261016090000_storage_automatic_reconcile_v1.sql';
const storageRegistrationRecoveryMigration = '20261016133429_storage_registration_recovery_v1.sql';
const storageSemanticRecoveryMigration = '20261017043050_storage_semantic_recovery_v1.sql';
const storageRecoveryCoverageMigration = '20261017053535_storage_recovery_coverage_v1.sql';
const storageRecoveryReaderMigration = '20261017060438_storage_recovery_read_connection_v1.sql';
const storageRecoveryNativeMigration = '20261017063317_storage_recovery_native_coverage_v1.sql';
const storageLegacyDirectoryMigration = '20261017074657_storage_legacy_directory_recovery_v1.sql';
const storageCurrentRegistrationMigration = '20261017102500_storage_registration_reconcile_v1.sql';
const imprintBulkMigration = '20261017121706_imprint_bulk_backfill_v1.sql';
const storageLegacyCreateMigration = '20261017131000_storage_legacy_create_adoption_v1.sql';
const storageDirectoryCurrentRegistrationMigration = '20261017160500_storage_directory_current_registration_v2.sql';
const imprintClassifierScanMigration = '20261017142000_imprint_classifier_scan_v1.sql';
const storageDemandRenewalMigrations = [
  '20261012103238_storage_demand_refresh_prepare_v1.sql',
  '20261012113128_storage_demand_refresh_runtime_v1.sql',
];
// This scenario reconstructs the lifecycle transition before handover support.
// Defer the exact migration family until the historical lifecycle assertions
// and gateway/storage prerequisites below have been replayed. The final
// subtest installs the whole family, including the observation successor,
// and checks the unchanged caller grants.
const workClaimHandoverMigration = '20261011131755_work_claim_handover_execution_v1.sql';
const workClaimHandoverMigrations = [
  workClaimHandoverMigration,
  '20261012114500_work_claim_handover_legacy_drain_v1.sql',
  '20261017215600_work_verify_shared_observation_v1.sql',
];
const storageOwnerLifecycleMigrations = [
  '20261010055701_storage_owner_lifecycle_v1.sql',
  '20261010150000_storage_owner_root_trash_scope_v2.sql',
];
const gatewayProbeMigrations = [
  '20261009160000_worker_gateway_request_context_probe_v1.sql',
  '20261009160100_close_worker_gateway_request_context_probe_v1.sql',
];
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('Project Lifecycle v2 deterministically disposes legacy rows and preserves authorization/currentness', { timeout: 180000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-project-v2-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: true, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
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
    const migrationNames = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrationNames.filter((name) =>
      name !== CLOSEOUT_MIGRATION && name !== storageMasterMigration && name !== storageReconnectRetryMigration && name !== storageReconnectRefreshMigration && name !== storageConflictMigration && name !== storageAutomaticReconcileMigration && name !== storageRegistrationRecoveryMigration && name !== storageSemanticRecoveryMigration && name !== storageRecoveryCoverageMigration && name !== storageRecoveryReaderMigration && name !== storageRecoveryNativeMigration && !workClaimHandoverMigrations.includes(name) && name !== migration && name !== currentnessMigration && name !== issuerMigration && name !== gatewayMigration && !storageOwnerLifecycleMigrations.includes(name) &&
      name !== storageLegacyDirectoryMigration && name !== storageCurrentRegistrationMigration && name !== imprintBulkMigration && name !== storageLegacyCreateMigration && name !== storageDirectoryCurrentRegistrationMigration && name !== imprintClassifierScanMigration && !gatewayProbeMigrations.includes(name) && !storageDemandRenewalMigrations.includes(name) && !AUTHORIZATION_SUCCESSOR_MIGRATIONS.includes(name))) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);

    const userId = uuid();
    const confirmedId = uuid();
    const mentionedId = uuid();
    const evidenceOnlyId = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'project-v2@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_projects
      (id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at,confidence)
      values($1::uuid,$4::uuid,'Confirmed',clued_private.normalize_project_name('Confirmed'),'project:'||$1::text,'confirmed',now(),1),
            ($2::uuid,$4::uuid,'Confirmed mention',clued_private.normalize_project_name('Confirmed mention'),'project:'||$2::text,'unconfirmed',null,0.7),
            ($3::uuid,$4::uuid,'Mention only',clued_private.normalize_project_name('Mention only'),'project:'||$3::text,'unconfirmed',null,0.4)`,
    [confirmedId, mentionedId, evidenceOnlyId, userId]);
    await admin.query(`insert into public.clued_project_mentions
      (user_id,project_id,intent,evidence_summary,confidence,source_ref,idempotency_key)
      values($1,$2,'confirmed','Owner said this is a Project',0.9,'fixture','confirmed-mention-v2'),
            ($1,$3,'possible','Possible mention only',0.4,'fixture','possible-mention-v2')`,
    [userId, mentionedId, evidenceOnlyId]);

    const preflight = (await admin.query(await fs.readFile(
      path.join(root, 'supabase/preflight/project_lifecycle_v2_inventory.sql'), 'utf8'))).rows;
    const priorFrontierState = (await admin.query(`select coalesce(max(invalidation_revision),0) as revision,
        coalesce(max(resolved_through_revision),0) as resolved
      from clued_private.projection_invalidation_heads where user_id=$1 and target_scope='global'
        and projection_key='global.priority_frontier'`, [userId])).rows[0];
    const priorFrontierRevision = Number(priorFrontierState.revision);
    const priorFrontierResolved = Number(priorFrontierState.resolved);
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', migration), 'utf8'));
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', currentnessMigration), 'utf8'));
    // In production these two ran long before 20261008210000_credential_verifier_v1.sql, which rewrites the
    // functions they create to compare Binding verifiers; replay it here so the order matches.
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', '20261008210000_credential_verifier_v1.sql'), 'utf8'));
    // 2b wraps issuer-authenticated functions only after their strict 2a Binding-verifier
    // rewrite. Deferring it preserves that historical assertion before installing wrappers.
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', issuerMigration), 'utf8'));
    // C1 requires the complete real RPC surface, including clued_canonical_export_v2 created by
    // the deferred lifecycle cutover. Apply it after those targets, the verifier replay and 2b; only
    // this legacy-row fixture defers them, while production uses normal timestamp order.
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', gatewayMigration), 'utf8'));
    // Apply the probe opening and mandatory cleanup after their gateway role,
    // following the same deferred prerequisite sequence as this historical fixture.
    for (const name of gatewayProbeMigrations) {
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
    }
    // Native storage lifecycle uses the 2b issuer resolver and extends its RPC
    // inventory. Install it after that exact historical inventory cutover,
    // matching production, rather than replaying future functions before 2b.
    // The V2 successor upgrades this exact Native function, so both must follow
    // the deferred prerequisites in their original timestamp order.
    for (const name of storageOwnerLifecycleMigrations) {
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
    }

    await t.test('deferred Native lifecycle includes its V2 successor with authenticated-only ACL and exact GW80', async () => {
      const signature = 'public.clued_storage_owner_lifecycle_v1(text,jsonb)';
      const native = (await admin.query(`select pg_get_userbyid(proowner) as owner,prosecdef,proconfig,
        encode(sha256(convert_to(prosrc,'UTF8')),'hex') as source_hash
        from pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
      assert.equal(native.source_hash, 'a6eb23ee9c69dae6e1f0ac709587f2b46f675478a326b30f2b3a909bf8170017');
      assert.equal(native.owner, 'postgres');
      assert.equal(native.prosecdef, true);
      assert.deepEqual(native.proconfig, ['search_path=""']);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed,
          role === 'authenticated', role);
      }
      assert.equal((await admin.query(`select count(*)::int as count from pg_proc
        where pronamespace='public'::regnamespace and has_function_privilege('clued_worker_gateway',oid,'EXECUTE')`)).rows[0].count, 80);
    });

    await t.test('cutover advances and enqueues the dedicated Frontier currentness revision', async () => {
      const state = (await admin.query(`select h.invalidation_revision,h.resolved_through_revision,
        h.latest_source_ref,j.target_invalidation_revision,j.status
        from clued_private.projection_invalidation_heads h
        join clued_private.projection_refresh_jobs j using(user_id,target_scope,projection_key)
        where h.user_id=$1 and h.target_scope='global'
          and h.projection_key='global.priority_frontier'`, [userId])).rows[0];
      assert.equal(Number(state.invalidation_revision), priorFrontierRevision + 1);
      assert.equal(Number(state.resolved_through_revision), priorFrontierResolved);
      assert.equal(Number(state.target_invalidation_revision), priorFrontierRevision + 1);
      assert.equal(state.status, 'queued');
      assert.deepEqual(state.latest_source_ref, {
        id: 'migration:20260924121000', kind: 'project_lifecycle_v2_cutover', scope: 'global',
      });
    });

    await t.test('legacy rows receive one immutable, deterministic disposition without bulk promotion', async () => {
      const rows = (await admin.query(`select project_id,disposition,disposition_reason,recognition_source,
        recognition_confidence,source_refs,basis
        from clued_private.project_lifecycle_v2_dispositions where user_id=$1 order by project_id`, [userId])).rows;
      const byId = Object.fromEntries(rows.map((row) => [row.project_id, row]));
      const proposed = Object.fromEntries(preflight.map((row) => [row.project_id, row]));
      assert.equal(byId[confirmedId].disposition, 'recognized_project');
      assert.equal(byId[confirmedId].recognition_source, 'v1_confirmed');
      assert.equal(byId[mentionedId].disposition, 'recognized_project');
      assert.equal(byId[mentionedId].recognition_source, 'confirmed_mention');
      assert.equal(byId[evidenceOnlyId].disposition, 'evidence_only');
      assert.equal(byId[evidenceOnlyId].recognition_source, 'legacy_mention_only');
      assert.equal(Number(byId[evidenceOnlyId].basis.mention_count), 1);
      for (const row of rows) {
        assert.equal(row.disposition, proposed[row.project_id].proposed_disposition);
        assert.equal(row.recognition_source, proposed[row.project_id].proposed_recognition_source);
        assert.equal(Number(row.recognition_confidence), Number(proposed[row.project_id].proposed_recognition_confidence));
        assert.deepEqual(row.source_refs, proposed[row.project_id].proposed_source_refs);
        assert.equal(row.disposition_reason, proposed[row.project_id].proposed_disposition_reason);
        assert.deepEqual(row.basis, proposed[row.project_id].basis);
      }
      await assert.rejects(admin.query(`update clued_private.project_lifecycle_v2_dispositions
        set disposition='recognized_project' where project_id=$1`, [evidenceOnlyId]), /immutable/);
    });

    const tokenHash = hash();
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,context_keys,scopes)
      values($1,'fixture','Project v2',$2,array['*'],array['context:read','context:write','audit:read'])`,
    [userId, tokenHash]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const rpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) value`, [tokenHash, input])).rows[0].value;

    await t.test('v2 list exposes only recognized Projects and no certainty axis', async () => {
      const listed = await rpc('clued_project_list_v2', { limit: 200 });
      assert.deepEqual(new Set(listed.projects.map((project) => project.id)), new Set([confirmedId, mentionedId]));
      for (const project of listed.projects) {
        assert.equal(project.project_schema_version, 2);
        assert.equal('certainty_status' in project, false);
        assert.equal('confirmed_at' in project, false);
        assert.equal('confidence' in project, false);
      }
      await assert.rejects(rpc('clued_project_list_v2', { certainty_status: 'confirmed' }), /legacy_project_certainty_forbidden/);
      const privileges = (await admin.query(`select
        has_table_privilege('anon','public.clued_projects_v2','select') anon_view,
        has_table_privilege('authenticated','public.clued_projects_v2','select') authenticated_view,
        has_function_privilege('anon','public.clued_project_list_v2(text,jsonb)','execute') anon_rpc,
        has_function_privilege('authenticated','public.clued_user_project_list_v2(jsonb)','execute') authenticated_rpc`)).rows[0];
      assert.equal(privileges.anon_view, false);
      assert.equal(privileges.authenticated_view, false);
      assert.equal(privileges.anon_rpc, true);
      assert.equal(privileges.authenticated_rpc, true);
    });

    const compatId = uuid();
    await t.test('bounded v1 compatibility never promotes an unconfirmed create and appends a later explicit recognition', async () => {
      const created = await rpc('clued_project_mutate', {
        operation: 'create', canonical_project_id: compatId, project_schema_version: 1,
        base_version: null, idempotency_key: uuid(),
        mutation: { name: 'Compat recognition', progress_status: 'active', certainty_status: 'unconfirmed', aliases: [] },
      });
      assert.equal(created.status, 'committed');
      const before = (await admin.query(`select p.id,p.version,p.certainty_status,p.project_recognized_v2,
        d.disposition,d.recognition_source from public.clued_projects p
        join clued_private.project_lifecycle_v2_dispositions d on d.project_id=p.id
        where p.id=$1`, [compatId])).rows[0];
      assert.equal(before.id, compatId);
      assert.equal(Number(before.version), 1);
      assert.equal(before.certainty_status, 'unconfirmed');
      assert.equal(before.project_recognized_v2, false);
      assert.equal(before.disposition, 'evidence_only');
      assert.equal(before.recognition_source, 'legacy_mention_only');
      assert.equal((await rpc('clued_project_list_v2', { limit: 200 })).projects.some((project) => project.id === compatId), false);
      const revisionBefore = Number((await admin.query(`select snapshot_revision
        from clued_private.scope_currentness_heads where user_id=$1 and canonical_scope=$2`,
      [userId, `project:${compatId}`])).rows[0].snapshot_revision);

      const confirmKey = uuid();
      const confirmInput = {
        operation: 'update', canonical_project_id: compatId, project_schema_version: 1,
        base_version: 1, idempotency_key: confirmKey, mutation: { certainty_status: 'confirmed' },
      };
      const confirmed = await rpc('clued_project_mutate', confirmInput);
      assert.equal(confirmed.status, 'committed');
      const replay = await rpc('clued_project_mutate', confirmInput);
      assert.equal(replay.status, 'committed');
      assert.equal(replay.receipt_id, confirmed.receipt_id);
      const after = (await admin.query(`select p.id,p.version,p.certainty_status,p.project_recognized_v2,
        d.disposition,r.recognition_source,r.source_receipt_id,r.basis
        from public.clued_projects p
        join clued_private.project_lifecycle_v2_dispositions d on d.project_id=p.id
        join clued_private.project_lifecycle_v2_recognitions r on r.project_id=p.id
        where p.id=$1`, [compatId])).rows[0];
      assert.equal(after.id, compatId);
      assert.equal(Number(after.version), 2);
      assert.equal(after.certainty_status, 'confirmed');
      assert.equal(after.project_recognized_v2, true);
      assert.equal(after.disposition, 'evidence_only');
      assert.equal(after.recognition_source, 'v1_confirmed');
      assert.equal(after.basis.operation, 'v1_compat_confirm');
      assert.ok(after.source_receipt_id);
      assert.equal((await rpc('clued_project_list_v2', { limit: 200 })).projects.some((project) => project.id === compatId), true);
      assert.equal(Number((await admin.query(`select count(*) count from clued_private.project_lifecycle_v2_recognitions
        where project_id=$1`, [compatId])).rows[0].count), 1);
      const receipt = (await admin.query(`select status,operation,operation_family,user_id,event_ids
        from public.clued_audit_receipts where id=$1`, [after.source_receipt_id])).rows[0];
      assert.equal(receipt.status, 'committed');
      assert.equal(receipt.operation, 'project_mutation');
      assert.equal(receipt.operation_family, 'project_mutation');
      assert.equal(receipt.user_id, userId);
      assert.equal(receipt.event_ids.length, 1);
      const event = (await admin.query(`select canonical_event_type from public.clued_context_events
        where id=$1::bigint`, [receipt.event_ids[0]])).rows[0];
      assert.equal(event.canonical_event_type, 'project_updated');
      const revisionAfter = Number((await admin.query(`select snapshot_revision
        from clued_private.scope_currentness_heads where user_id=$1 and canonical_scope=$2`,
      [userId, `project:${compatId}`])).rows[0].snapshot_revision);
      assert.ok(revisionAfter > revisionBefore);
      const privileges = (await admin.query(`select
        has_table_privilege('anon','clued_private.project_lifecycle_v2_recognitions','select') anon_select,
        has_table_privilege('authenticated','clued_private.project_lifecycle_v2_recognitions','select') authenticated_select,
        has_table_privilege('service_role','clued_private.project_lifecycle_v2_recognitions','select') service_select`)).rows[0];
      assert.equal(privileges.anon_select, false);
      assert.equal(privileges.authenticated_select, false);
      assert.equal(privileges.service_select, false);
      await assert.rejects(admin.query(`update clued_private.project_lifecycle_v2_recognitions
        set recognition_reason='rewrite' where project_id=$1`, [compatId]), /immutable/);
    });

    await t.test('v1 confirmed create is recognized atomically without a transition row', async () => {
      const projectId = uuid();
      const result = await rpc('clued_project_mutate', {
        operation: 'create', canonical_project_id: projectId, project_schema_version: 1,
        base_version: null, idempotency_key: uuid(),
        mutation: { name: 'Compat confirmed create', progress_status: 'active', certainty_status: 'confirmed', aliases: [] },
      });
      assert.equal(result.status, 'committed');
      const stored = (await admin.query(`select p.project_recognized_v2,d.disposition,
        (select count(*) from clued_private.project_lifecycle_v2_recognitions r where r.project_id=p.id) transition_count
        from public.clued_projects p join clued_private.project_lifecycle_v2_dispositions d on d.project_id=p.id
        where p.id=$1`, [projectId])).rows[0];
      assert.equal(stored.project_recognized_v2, true);
      assert.equal(stored.disposition, 'recognized_project');
      assert.equal(Number(stored.transition_count), 0);
    });

    await t.test('v1 confirmation fails closed when a recognized Project already owns the normalized name', async () => {
      const legacyId = uuid();
      const recognizedId = uuid();
      assert.equal((await rpc('clued_project_mutate', {
        operation: 'create', canonical_project_id: legacyId, project_schema_version: 1,
        base_version: null, idempotency_key: uuid(),
        mutation: { name: 'Compat name conflict', progress_status: 'paused', certainty_status: 'unconfirmed', aliases: [] },
      })).status, 'committed');
      assert.equal((await rpc('clued_project_mutate_v2', {
        operation: 'create', canonical_project_id: recognizedId, project_schema_version: 2,
        base_version: null, idempotency_key: uuid(),
        mutation: { name: 'Compat name conflict', progress_status: 'not_started', aliases: [] },
        recognition: { confidence: 1, reason: 'Explicit duplicate-name conflict fixture.', source: 'v2_agent_recognition', source_refs: [] },
      })).status, 'committed');
      const rejected = await rpc('clued_project_mutate', {
        operation: 'update', canonical_project_id: legacyId, project_schema_version: 1,
        base_version: 1, idempotency_key: uuid(), mutation: { certainty_status: 'confirmed' },
      });
      assert.equal(rejected.status, 'rejected');
      const state = (await admin.query(`select project_recognized_v2,
        (select count(*) from clued_private.project_lifecycle_v2_recognitions where project_id=$1) transition_count
        from public.clued_projects where id=$1`, [legacyId])).rows[0];
      assert.equal(state.project_recognized_v2, false);
      assert.equal(Number(state.transition_count), 0);
    });

    const createdId = uuid();
    await t.test('v2 create preserves caller-selected identity and records private recognition evidence', async () => {
      const result = await rpc('clued_project_mutate_v2', {
        operation: 'create', canonical_project_id: createdId, project_schema_version: 2,
        base_version: null, idempotency_key: uuid(),
        mutation: { name: 'Created v2', progress_status: 'not_started', aliases: [] },
        recognition: { confidence: 0.86, reason: 'Agent recognition crossed the Project decision.', source: 'v2_agent_recognition', source_refs: [] },
      });
      assert.equal(result.status, 'committed');
      assert.equal(result.supplemental.project.id, createdId);
      assert.equal(result.supplemental.project.progress_status, 'not_started');
      assert.equal('certainty_status' in result.supplemental.project, false);
      const stored = (await admin.query(`select p.id,p.project_schema_version,d.disposition,
        d.recognition_confidence,d.recognition_source from public.clued_projects p
        join clued_private.project_lifecycle_v2_dispositions d on d.project_id=p.id where p.id=$1`, [createdId])).rows[0];
      assert.equal(stored.id, createdId);
      assert.equal(stored.project_schema_version, 2);
      assert.equal(stored.disposition, 'recognized_project');
      assert.equal(Number(stored.recognition_confidence), 0.86);
      assert.equal(stored.recognition_source, 'v2_agent_recognition');
      const rejected = await rpc('clued_project_mutate_v2', {
        operation: 'update', canonical_project_id: createdId, project_schema_version: 2,
        base_version: 1, idempotency_key: uuid(), mutation: { certainty_status: 'confirmed' },
      });
      assert.equal(rejected.status, 'rejected');
      assert.match(rejected.error_code, /legacy_project_certainty_forbidden/);
    });

    await t.test('evidence-only history does not reserve a recognized Project name', async () => {
      const promotedAsNewId = uuid();
      const result = await rpc('clued_project_mutate_v2', {
        operation: 'create', canonical_project_id: promotedAsNewId, project_schema_version: 2,
        base_version: null, idempotency_key: uuid(),
        mutation: { name: 'Mention only', progress_status: 'not_started', aliases: [] },
        recognition: { confidence: 1, reason: 'A later explicit decision creates a distinct stable Project.', source: 'v2_agent_recognition', source_refs: [] },
      });
      assert.equal(result.status, 'committed');
      assert.equal(result.supplemental.project.id, promotedAsNewId);
      const rows = (await admin.query(`select id,normalized_name,project_recognized_v2 from public.clued_projects
        where user_id=$1 and id=any($2::uuid[]) order by id`, [userId, [evidenceOnlyId, promotedAsNewId]])).rows;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].normalized_name, rows[1].normalized_name);
      assert.equal(rows.find((row) => row.id === evidenceOnlyId).project_recognized_v2, false);
      assert.equal(rows.find((row) => row.id === promotedAsNewId).project_recognized_v2, true);
    });

    await t.test('Record and Event writes use effective Project/lifecycle disposition, not certainty', async () => {
      const recordInput = (scope) => ({
        operation: 'create', id: uuid(), record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope, idempotency_key: uuid(), authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Project Lifecycle v2 fixture',
        source_refs: [], source_unavailable_reason: null,
        mutation: { title: 'Project note', content: 'Project note', type_fields: { note_kind: 'fixture' }, relations: {} },
      });
      assert.equal((await rpc('clued_record_mutate', recordInput(`project:${confirmedId}`))).status, 'committed');
      assert.equal((await rpc('clued_record_mutate', recordInput(`project:${compatId}`))).status, 'committed');
      const deniedRecord = await rpc('clued_record_mutate', recordInput(`project:${evidenceOnlyId}`));
      assert.equal(deniedRecord.status, 'rejected');
      assert.match(deniedRecord.error_code, /project_not_active/i);
      const deniedEvent = await rpc('clued_event_append', {
        event_schema_version: 1, event_type: 'extension:fixture:note',
        event_scope: `project:${evidenceOnlyId}`, idempotency_key: uuid(),
        target_refs: [], change_summary: [], evidence_refs: [], artifact_refs: [],
      });
      assert.equal(deniedEvent.status, 'rejected');
      assert.match(deniedEvent.error_code, /project_not_active/i);
    });

    await t.test('v2 canonical export keeps evidence-only rows in legacy history and advances Currentness', async () => {
      const exported = await rpc('clued_canonical_export_v2', { idempotency_key: uuid() });
      assert.equal(exported.snapshot.schema_version, 2);
      assert.equal(exported.snapshot.project_contract_version, 2);
      assert.equal(exported.snapshot.projects.some((project) => project.canonical_project_id === evidenceOnlyId), false);
      assert.equal(exported.snapshot.legacy_projects.some((project) => project.legacy_id === evidenceOnlyId && project.migration_status === 'evidence_only'), true);
      assert.equal(exported.snapshot.projects.some((project) => project.canonical_project_id === compatId), true);
      assert.equal(exported.snapshot.legacy_projects.some((project) => project.legacy_id === compatId), false);
      const revisions = (await admin.query(`select canonical_scope,snapshot_revision from clued_private.scope_currentness_heads
        where user_id=$1 and canonical_scope like 'project:%'`, [userId])).rows;
      assert.ok(revisions.every((row) => Number(row.snapshot_revision) > 0));
    });
    await t.test('historical legacy assertions are followed by actual G6 closeout, replay and current Worker access',async()=>{
      const sql=await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8');
      const before=await snapshotCallerCatalog(admin);
      await admin.query(sql);
      await assertGatewayCloseoutBoundary(admin);
      const after=await snapshotCallerCatalog(admin);
      const fixed=rows=>rows.filter(r=>r.nspname!=='public'||!r.signature.replace(/^public\./,'').startsWith('clued_mcp_currentness_g6_gate(')).map(({acl,...r})=>r);
      assert.deepEqual(fixed(after),fixed(before),'all original non-G6 business definitions remain');
      const native=rows=>rows.filter(r=>r.nspname==='auth'||r.nspname==='clued_private'||r.signature.includes('clued_storage_owner_lifecycle_v1('));
      assert.deepEqual(native(after),native(before),'Native V2 and platform/private ACL preserved');
      await admin.query(sql);
      assert.deepEqual(await snapshotCallerCatalog(admin),after);
      await assertGatewayCloseoutBoundary(admin);
      await assert.rejects(rpc('clued_project_mutate',{operation:'create'}),e=>e.code==='42501');
      await assert.rejects(rpc('clued_project_list_v2',{limit:200}),e=>e.code==='42501');
      const gateway=server.getPgClient();clients.push(gateway);await gateway.connect();
      const listed=await workerGatewayRpc(gateway,'clued_project_list_v2',tokenHash,{limit:200});
      assert.ok(listed.projects.some(p=>p.id===compatId),'current v2 business reads remain available through GW');
    });
    await t.test('storage master follows its deferred historical prerequisites and preserves the Native/GW boundary',async()=>{
      // Keep the immutable V2 hash and legacy caller assertions above. The new
      // successor requires their actual production definitions, so install it
      // only after this fixture has replayed every deferred cutover.
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',storageMasterMigration),'utf8'));
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',storageReconnectRetryMigration),'utf8'));
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',storageReconnectRefreshMigration),'utf8'));
      assert.equal((await admin.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid='public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure")).rows[0].h,
        '5507655146cad446408ddb26136a3c8cbeb84b88ee559aa19114b8f3c03a2238');
      // Demand renewal depends on the issuer/gateway and all Owner successors;
      // first preserve the actual old hash assertion, then verify its successor.
      for(const name of storageDemandRenewalMigrations){
        await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
      }
      assert.equal((await admin.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid='public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure")).rows[0].h,
        'e0637d3279d7f1b6bb77f7b12258f2839c51187f8dbe283a030bbbc694c80740');
      await assertGatewayCloseoutBoundary(admin);
      assert.ok((await admin.query("select to_regclass('clued_private.storage_master_controls_v1') as table_id")).rows[0].table_id);
      const signature='public.clued_storage_owner_lifecycle_v1(text,jsonb)';
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
        assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,signature])).rows[0].allowed,role==='authenticated',role);
    });
    await t.test('work-claim handover follows the real deferred gateway/storage dependencies without changing caller grants',async()=>{
      for (const name of workClaimHandoverMigrations)
        await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
      await assertGatewayCloseoutBoundary(admin);
      assert.ok((await admin.query("select to_regclass('clued_private.work_claim_storage_authorizations_v1') as table_id")).rows[0].table_id);
      assert.ok((await admin.query("select to_regclass('clued_private.work_claim_activation_drains_v1') as table_id")).rows[0].table_id);
      assert.equal((await admin.query('select clued_private.work_claim_execution_enabled_v1() as active')).rows[0].active,false);
      const signature='clued_private.work_claim_ci_command_v1(text,jsonb)';
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
        assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,signature])).rows[0].allowed,false,role);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
        assert.equal((await admin.query("select has_function_privilege($1,'clued_private.work_claim_execution_activate_v1(text)','EXECUTE') as allowed",[role])).rows[0].allowed,false,role);
    });
    await t.test('authorization successors follow every deferred prerequisite and qualify the actual current caller catalog',async()=>{
      const before=await snapshotAuthorizationCallerBoundary(admin);
      for (const name of AUTHORIZATION_SUCCESSOR_MIGRATIONS)
        await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
      await assertAuthorizationSuccessorBoundary(admin,before);
      const gateway=server.getPgClient();clients.push(gateway);await gateway.connect();
      const listed=await workerGatewayRpc(gateway,'clued_project_list_v2',tokenHash,{limit:200});
      assert.ok(listed.projects.some(p=>p.id===compatId),'recognized history remains readable through the actual current gateway');
      await assert.rejects(rpc('clued_project_list_v2',{limit:200}),e=>e.code==='42501');
    });
    await t.test('storage conflict isolation follows its actual deferred prerequisites and preserves current caller grants',async()=>{
      // I9 patches the issuer-wrapped Worker/recovery functions and the final
      // demand-renewal implementation. Replay it only after those historical
      // dependencies, preserving every earlier cutover/hash assertion above.
      const before=await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',storageConflictMigration),'utf8'));
      // The automatic successor wraps I9 functions; this historical replay
      // defers it with I9 instead of loading it before its prerequisites.
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',storageAutomaticReconcileMigration),'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin),before,
        'I9 preserves every public RPC OID, owner, definer configuration and ACL');
      await assertGatewayCloseoutBoundary(admin);
      assert.ok((await admin.query("select to_regclass('clued_private.storage_conflict_isolations_v1') as table_id")).rows[0].table_id,
        'the actual deferred I9 module is installed');
      const worker=(await admin.query("select pg_get_functiondef('clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)'::regprocedure) as body")).rows[0].body;
      assert.ok(worker.includes('storage_conflict_assert_v1'),'the actual Worker load contains the I9 admission guard');
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        assert.equal((await admin.query("select has_table_privilege($1,'clued_private.storage_conflict_isolations_v1','SELECT,INSERT,UPDATE,DELETE') as allowed",[role])).rows[0].allowed,false,role);
        for(const signature of ['clued_private.storage_conflict_sweep_v1()','clued_private.storage_conflict_require_scheduler_v1()'])
          assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,signature])).rows[0].allowed,false,role+' '+signature);
      }
    });
    await t.test('registration recovery follows I9 and automatic reconciliation without widening the caller boundary',async()=>{
      // The registration successor clones the actual I9 Worker and automatic
      // status/queue implementations. Install it after their historical hash
      // and guard assertions above, preserving the production dependency order.
      const before=await snapshotAuthorizationCallerBoundary(admin);
      const workerSignature='clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)';
      const implementation=async signature=>(await admin.query(`select oid::text oid,
        pg_get_userbyid(proowner) owner,prosecdef,proconfig,prosrc
        from pg_proc where oid=$1::regprocedure`,[signature])).rows[0];
      const original=await implementation(workerSignature);
      assert.ok(original.prosrc.includes('storage_conflict_assert_v1'),'the source being cloned contains the actual I9 admission guard');
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',storageRegistrationRecoveryMigration),'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin),before,
        'registration recovery preserves every public RPC OID, owner, definer configuration and ACL');
      await assertGatewayCloseoutBoundary(admin);
      const preserved=await implementation('clued_private.storage_cloud_before_registration_v1(text,jsonb)');
      assert.equal(preserved.prosrc,original.prosrc,'the private clone preserves the complete original Worker, including its I9 admission guard');
      for(const key of ['owner','prosecdef','proconfig'])assert.deepEqual(preserved[key],original[key],key);
      const wrapper=await implementation(workerSignature);
      assert.equal(wrapper.oid,original.oid,'the existing private Worker keeps its OID');
      for(const key of ['owner','prosecdef','proconfig'])assert.deepEqual(wrapper[key],original[key],key);
      assert.ok(wrapper.prosrc.includes('storage_registration_recovery_v1'),'the installed wrapper routes only its new internal recovery actions');
      assert.ok(wrapper.prosrc.includes('storage_cloud_before_registration_v1'),'ordinary Worker actions retain their original guarded implementation');
      const privateNames=['ii_priv_storage_cloud_worker_v2','storage_cloud_before_registration_v1',
        'storage_registration_finish_v1','storage_registration_recovery_v1','storage_delivery_issuer_compatible_v1',
        'storage_registration_check_audit_v1','storage_registration_job_closed_v1',
        'storage_job_status_before_registration_v1','storage_queue_before_registration_v1',
        'storage_job_status_v1','ii_pub_clued_storage_queued_sweep_v1'];
      const helpers=(await admin.query(`select proname,oid::regprocedure::text signature,
        pg_get_userbyid(proowner) owner,prosecdef,proconfig from pg_proc
        where pronamespace='clued_private'::regnamespace and proname=any($1::text[]) order by proname`,[privateNames])).rows;
      assert.deepEqual(helpers.map(row=>row.proname),[...privateNames].sort(),'every new helper, clone and existing wrapper is checked');
      for(const helper of helpers){
        assert.equal(helper.owner,'postgres',helper.signature);assert.equal(helper.prosecdef,true,helper.signature);
        assert.deepEqual(helper.proconfig,['search_path=""'],helper.signature);
        for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
          assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,helper.signature])).rows[0].allowed,false,helper.signature+' '+role);
      }
      const table='clued_private.storage_registration_checks_v1';
      const sidecar=(await admin.query('select pg_get_userbyid(relowner) owner,relrowsecurity from pg_class where oid=$1::regclass',[table])).rows[0];
      assert.equal(sidecar.owner,'postgres');assert.equal(sidecar.relrowsecurity,true);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
        assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",[role,table])).rows[0].allowed,false,table+' '+role);
    });
    await t.test('semantic recovery installs after the real gateway and I9 prerequisites without widening caller access', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageSemanticRecoveryMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
      for (const table of ['storage_semantic_attempts_v1', 'storage_semantic_verifications_v1']) {
        const signature = 'clued_private.' + table;
        assert.equal((await admin.query('select relrowsecurity enabled from pg_class where oid=$1::regclass', [signature])).rows[0].enabled, true);
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, signature])).rows[0].allowed, false);
      }
    });
    await t.test('recovery coverage follows its semantic predecessor with the same public caller boundary', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageRecoveryCoverageMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
    });
    await t.test('recovery reader installs after its real predecessors without expanding the public caller catalog', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageRecoveryReaderMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
      assert.equal((await admin.query("select has_function_privilege('clued_worker_gateway','clued_private.storage_recovery_reader_v1(text,uuid,uuid,uuid)','execute') allowed")).rows[0].allowed, false);
      assert.equal((await admin.query(`select bool_and(not has_function_privilege(role_name,signature,'execute')) denied
        from (values('anon'),('authenticated'),('service_role'),('clued_worker_gateway')) roles(role_name)
        cross join (values('clued_private.storage_recovery_reader_refresh_v1(uuid,uuid,uuid,uuid,boolean,uuid,uuid,text)'),
          ('clued_private.storage_recovery_refresh_input_guard_v1(jsonb)')) helpers(signature)`)).rows[0].denied,true);
      assert.equal((await admin.query("select has_function_privilege('clued_worker_gateway','clued_private.storage_recovery_client_input_guard_v1(jsonb)','execute') allowed")).rows[0].allowed, false);
    });
    await t.test('Native predecessor recovery listing follows the read-connection migration with unchanged caller grants', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageRecoveryNativeMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
      assert.equal((await admin.query("select has_function_privilege('clued_worker_gateway','clued_private.storage_recovery_native_visible_v1(uuid,uuid,uuid,text)','execute') allowed")).rows[0].allowed, false);
    });
    await t.test('legacy directory before recovery installs after I9 and the actual reader without widening callers', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageLegacyDirectoryMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
        assert.equal((await admin.query("select has_function_privilege($1,'clued_private.storage_legacy_directory_reconcile_v1(text,jsonb)','execute') allowed", [role])).rows[0].allowed, false);
    });
    await t.test('current registration installs after its actual issuer, master and legacy dependencies with unchanged callers', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageCurrentRegistrationMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
      const names = ['storage_registration_program_authority_v1', 'storage_registration_artifact_permitted_v1',
        'storage_current_registration_node_v1', 'storage_current_registration_plan_v1', 'storage_current_registration_observation_v1',
        'storage_current_registration_reconcile_v1', 'storage_current_registration_status_v1',
        'storage_scheduled_before_current_registration_v1', 'ii_pub_clued_storage_scheduled_recovery_v2',
        'storage_job_status_before_current_registration_v1', 'storage_conflict_public_before_current_registration_v1',
        'storage_job_status_v1', 'storage_conflict_public_status_v1', 'storage_conflict_exit_allowed_v1', 'storage_conflict_artifact_guard_v1'];
      const helpers = (await admin.query(`select proname,oid::regprocedure::text signature,
        pg_get_userbyid(proowner) owner,prosecdef,proconfig from pg_proc
        where pronamespace='clued_private'::regnamespace and proname=any($1::text[]) order by proname`, [names])).rows;
      assert.deepEqual(helpers.map(row => row.proname), [...names].sort());
      for (const helper of helpers) {
        assert.equal(helper.owner, 'postgres', helper.signature);
        // This private immutable node projection is an invoker, while the
        // authority/registry helpers remain definers. Both stay owner-only.
        assert.equal(helper.prosecdef, helper.proname !== 'storage_current_registration_node_v1', helper.signature);
        assert.deepEqual(helper.proconfig, ['search_path=""'], helper.signature);
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await admin.query("select has_function_privilege($1,$2,'execute') allowed", [role, helper.signature])).rows[0].allowed, false, helper.signature+' '+role);
      }
      for (const table of ['clued_private.storage_current_registration_results_v1', 'clued_private.storage_registration_artifact_permits_v1']) {
        const catalog = (await admin.query(`select pg_get_userbyid(c.relowner) owner,c.relrowsecurity,
          not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner or a.grantor<>c.relowner) owner_only,
          not exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and a.attacl is not null) no_column_grants,
          not exists(select 1 from pg_policy p where p.polrelid=c.oid) no_policies
          from pg_class c where c.oid=$1::regclass`, [table])).rows[0];
        assert.deepEqual(catalog, {owner:'postgres',relrowsecurity:true,owner_only:true,no_column_grants:true,no_policies:true}, table);
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
          assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, table])).rows[0].allowed, false, table+' '+role);
          assert.equal((await admin.query("select has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [role, table])).rows[0].allowed, false, table+' '+role);
        }
      }
    });
    await t.test('bounded imprint rehearsal installs after its real lifecycle dependency without widening existing callers', async () => {
      // This historical scenario deliberately defers recognized-project helpers.
      // Install the actual migration once, after every original assertion and
      // predecessor; the ordinary full-chain test keeps timestamp order.
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', imprintBulkMigration), 'utf8'));
      const after = await snapshotAuthorizationCallerBoundary(admin);
      assert.deepEqual(after.filter(row => !row.signature.replace(/^public\./, '').startsWith('clued_imprint_bulk_')), before);
      assert.equal(after.length, before.length + 3);
      await assertGatewayCloseoutBoundary(admin);
      const nativeSignatures = ['public.clued_imprint_bulk_preview_v1(jsonb)', 'public.clued_imprint_bulk_status_v1()',
        'public.clued_imprint_bulk_mutate_v1(jsonb,text)'];
      for (const signature of nativeSignatures) for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
        assert.equal((await admin.query("select has_function_privilege($1,$2,'execute') allowed", [role, signature])).rows[0].allowed, role === 'authenticated');
      const helpers = (await admin.query(`select proname,oid::regprocedure::text signature,pg_get_userbyid(proowner) owner,prosecdef,proconfig
        from pg_proc where pronamespace='clued_private'::regnamespace and proname like 'imprint_bulk_%' order by proname`)).rows;
      assert.equal(helpers.length, 7);
      for (const helper of helpers) {
        assert.equal(helper.owner, 'postgres'); assert.deepEqual(helper.proconfig, ['search_path=""']);
        assert.equal(helper.prosecdef, helper.proname !== 'imprint_bulk_domains_v1');
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await admin.query("select has_function_privilege($1,$2,'execute') allowed", [role, helper.signature])).rows[0].allowed, false);
      }
      for (const table of ['imprint_bulk_batches_v1', 'imprint_bulk_items_v1', 'imprint_bulk_proof_key_v1']) {
        const catalog = (await admin.query(`select pg_get_userbyid(c.relowner) owner,c.relrowsecurity,
          not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner or a.grantor<>c.relowner) owner_only,
          not exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and a.attacl is not null) no_column_grants,
          not exists(select 1 from pg_policy p where p.polrelid=c.oid) no_policies from pg_class c where c.oid=$1::regclass`, ['clued_private.' + table])).rows[0];
        assert.deepEqual(catalog, { owner: 'postgres', relrowsecurity: true, owner_only: true, no_column_grants: true, no_policies: true });
      }
    });
    await t.test('legacy create registration follows its actual deferred registry dependencies without widening callers', async () => {
      const before = await snapshotAuthorizationCallerBoundary(admin);
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageLegacyCreateMigration), 'utf8'));
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before);
      await assertGatewayCloseoutBoundary(admin);
      const names = ['storage_legacy_create_registration_authority_v1', 'storage_legacy_create_registration_plan_v1',
        'storage_legacy_create_registration_observation_v1', 'storage_legacy_create_registration_v1', 'storage_registration_before_create_v1'];
      const helpers = (await admin.query(`select proname,oid::regprocedure::text signature,
        pg_get_userbyid(proowner) owner,prosecdef,proconfig from pg_proc
        where pronamespace='clued_private'::regnamespace and proname=any($1::text[]) order by proname`, [names])).rows;
      assert.deepEqual(helpers.map(row => row.proname), [...names].sort());
      for (const helper of helpers) {
        assert.equal(helper.owner, 'postgres');assert.equal(helper.prosecdef, true);assert.deepEqual(helper.proconfig, ['search_path=""']);
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await admin.query("select has_function_privilege($1,$2,'execute') allowed", [role, helper.signature])).rows[0].allowed, false);
      }
    });
    await t.test('nonempty directory registration follows both deferred helpers and preserves every caller and private function catalog', async () => {
      const beforeCallers = await snapshotAuthorizationCallerBoundary(admin);
      const privateCatalog = async () => (await admin.query(`select oid::text,proname,prosrc,
        pg_get_userbyid(proowner) owner,prosecdef,provolatile,proparallel,proconfig,proacl::text
        from pg_proc where pronamespace='clued_private'::regnamespace order by oid`)).rows;
      const before = await privateCatalog();
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', storageDirectoryCurrentRegistrationMigration), 'utf8'));
      const expected = before.map(row => ['storage_current_registration_observation_v1', 'storage_legacy_create_registration_observation_v1'].includes(row.proname)
        ? { ...row, prosrc: row.prosrc.replace("p_observation->'target'->'empty' is distinct from 'true'::jsonb",
          "jsonb_typeof(p_observation->'target'->'empty') is distinct from 'boolean'") } : row);
      assert.equal(expected.filter((row, index) => row.prosrc !== before[index].prosrc).length, 2);
      assert.deepEqual(await privateCatalog(), expected, 'only the two current directory child-presence predicates change');
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), beforeCallers);
      await assertGatewayCloseoutBoundary(admin);
    });
    await t.test('classifier successor follows deferred bulk without changing function identity or caller privileges', async () => {
      const beforeCallers = await snapshotAuthorizationCallerBoundary(admin);
      const identity = async () => (await admin.query(`select oid::text,pg_get_userbyid(proowner) owner,
        prosecdef,provolatile,proparallel,proconfig,proacl::text from pg_proc
        where oid='clued_private.imprint_auto_domains_v1(text)'::regprocedure`)).rows[0];
      const before = await identity();
      const sql = await fs.readFile(path.join(root, 'supabase/migrations', imprintClassifierScanMigration), 'utf8');
      await admin.query(sql);
      assert.deepEqual(await identity(), before);
      assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), beforeCallers);
      await assertGatewayCloseoutBoundary(admin);
      const installed = (await admin.query("select md5(prosrc) body from pg_proc where oid='clued_private.imprint_auto_domains_v1(text)'::regprocedure")).rows[0].body;
      const expected = /as \$\$([\s\S]*)\$\$;/.exec(sql);
      assert.ok(expected, 'the actual single-function successor is present');
      assert.equal(installed, crypto.createHash('md5').update(expected[1]).digest('hex'), 'the deferred bulk migration cannot restore an older classifier');
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('clued-project-v2-')) {
      throw new Error('Unsafe test cleanup');
    }
    await removeTestDirectory(target);
  }
});
