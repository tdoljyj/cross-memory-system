import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = '20260924090000_project_lifecycle_successor_v2.sql';
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
    for (const name of migrationNames.filter((name) => name !== migration)) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

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
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', migration), 'utf8'));

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
