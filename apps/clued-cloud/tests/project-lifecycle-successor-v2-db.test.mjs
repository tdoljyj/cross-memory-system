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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = '20260924120000_project_lifecycle_successor_v2.sql';
const currentnessMigration = '20260924121000_project_lifecycle_successor_v2_frontier_invalidation.sql';
const issuerMigration = '20261009070001_issuer_identity_credentials_v1.sql';
const gatewayMigration = '20261009070002_worker_gateway_transition_v1.sql';
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
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
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
      name !== migration && name !== currentnessMigration && name !== issuerMigration && name !== gatewayMigration && !storageOwnerLifecycleMigrations.includes(name) &&
      !gatewayProbeMigrations.includes(name))) {
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
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('clued-project-v2-')) {
      throw new Error('Unsafe test cleanup');
    }
    await fs.rm(target, { recursive: true, force: true });
  }
});
