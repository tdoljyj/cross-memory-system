import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { assertGatewayCloseoutBoundary, snapshotCallerCatalog } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uid = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const claims = sub => ({ sub, role: 'authenticated', session_id: 'isolated-imprint-query-owner',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('Native imprint query scope preserves lawful Owner source scope and all isolation gates', { timeout: 300000 }, async t => {
  const started = performance.now();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-imprint-query-owner-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: uid(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    async function connect(role, jwt) {
      const db = server.getPgClient(); clients.push(db); await db.connect();
      await db.query("set statement_timeout='15s'; set lock_timeout='10s'");
      if (role) await db.query(`set role ${role}`);
      if (jwt) await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [jwt.sub ?? '', JSON.stringify(jwt)]);
      return db;
    }
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrationDir = path.join(root, 'supabase/migrations');
    const names = (await fs.readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
    const additions = names.filter(name => name.endsWith('_imprint_query_owner_scope.sql'));
    assert.equal(additions.length, 1, 'one actual CLI-created additive migration');
    const migration = await fs.readFile(path.join(migrationDir, additions[0]), 'utf8');
    const predecessors = names.filter(name => name < additions[0]);
    const successors = names.filter(name => name > additions[0]);
    for (const name of predecessors) {
      try { await admin.query(await fs.readFile(path.join(migrationDir, name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await assertGatewayCloseoutBoundary(admin);
    t.diagnostic(`full chronological predecessor chain ${predecessors.length} migrations: ${Math.round(performance.now() - started)}ms`);
    const owner = uid(), other = uid(), project = uid(), sourceProject = uid(), foreignProject = uid();
    const scope = 'project:' + project, sourceScope = 'project:' + sourceProject, foreignScope = 'project:' + foreignProject;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'query-owner@example.invalid',now()),($2,'query-other@example.invalid',now())`, [owner, other]);
    async function guarded(user, write) {
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [user]);
        const result = await write(); await admin.query('commit'); return result;
      } catch (error) { await admin.query('rollback'); throw error; }
    }
    for (const [id, user] of [[project, owner], [sourceProject, owner], [foreignProject, other]]) {
      await guarded(user, () => admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
        values($1,$2,$3,$3,$4)`, [id, user, 'isolated-' + id, 'project:' + id]));
    }
    const contextId = (await guarded(owner, () => admin.query(`insert into clued_private.development_spaces_v14
      (owner_id,project_id,name,environment,cursor) values($1,$2,'Isolated query context','test',0) returning id`, [owner, project]))).rows[0].id;
    async function put({ user = owner, kind = 'note', recordScope = scope, fields = {}, title = 'Isolated note' } = {}) {
      const id = uid(), content = 'Full immutable body for ' + title;
      await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence,confidence_reason,content_hash)
        values($1,$2,$3,$4,$5,$6,$7,'active',1,'active',$8,$9,'{}','{}','user_explicit',1,'Synthetic isolated fixture',$10)`,
      [id, user, title, content, recordScope.startsWith('project:') ? 'project' : 'global',
        recordScope.startsWith('project:') ? recordScope.slice(8) : null, kind, recordScope, fields, hash(content)]);
      return id;
    }
    async function registered(sourceRecordScope, title, user = owner) {
      const intent = uid();
      const source = await put({ user, kind: 'decision', recordScope: sourceRecordScope, title,
        fields: { rationale: 'Synthetic current source', execution_intents: [{ id: intent, completion_criteria: 'Exact isolated scope result' }] } });
      return { id: intent, source_id: source, source_version: 1, source_scope: sourceRecordScope };
    }
    const globalRef = await registered('global', 'Global registered source');
    const projectRef = await registered(sourceScope, 'Other owned Project registered source');
    const foreignRef = await registered(foreignScope, 'Foreign registered source', other);
    const globalTask = await put({ kind: 'task', title: 'Project Task with Global source', fields: { execution_bucket: 'later', execution_intent: globalRef } });
    const projectTask = await put({ kind: 'task', title: 'Project Task with other owned source', fields: { execution_bucket: 'later', execution_intent: projectRef } });
    const outsideTask = await put({ kind: 'task', recordScope: sourceScope, title: 'Other Project Task', fields: { execution_bucket: 'later' } });
    const note = await put();
    const human = await connect('authenticated', claims(owner)), stranger = await connect('authenticated', claims(other));
    const read = async (input, db = human, name = 'clued_imprint_read_v1') =>
      (await db.query(`select public.${name}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
    const projectInput = { view: 'task', scope, include_history: false, limit: 30, cursor: 0 };
    const strict = (extra = {}, db = human) => read({ ...projectInput, ...extra }, db);
    const development = () => read({ ...projectInput, scope: 'all', context_id: contextId, environment: 'test' }, human, 'clued_development_imprint_read_v1');
    const ownerScopes = (await admin.query('select clued_private.imprint_owner_scopes_v1($1) value', [owner])).rows[0].value;
    const fence = async (id, scopes = ownerScopes) => (await admin.query('select clued_private.record_currentness_fence($1,$2,$3) value', [owner, id, scopes])).rows[0].value;
    const original = (await admin.query("select pg_get_functiondef('public.clued_imprint_read_v1(jsonb)'::regprocedure) value")).rows[0].value;
    const originalCatalog = await snapshotCallerCatalog(admin);
    let globalGateBefore;

    await t.test('real predecessor rejects lawful Global and other-owned sources only after query narrowing', async () => {
      for (const id of [globalTask, projectTask]) {
        assert.equal((await admin.query('select clued_private.execution_intent_error_v2($1,null,$2,type_fields) value from public.clued_memories where id=$2', [owner, id])).rows[0].value, null);
        assert.equal(await fence(id, [scope]), 'UNKNOWN');
        assert.equal(await fence(id), 'CURRENT');
      }
      const before = await strict();
      assert.deepEqual(before.records, []);
      assert.equal(before.current_projection_unavailable, true);
      assert.equal(before.selection_complete, false); assert.equal(before.withheld_record_count, 2);
      assert.deepEqual(new Set((await development()).records.map(row => row.id)), new Set([globalTask, projectTask]));
      globalGateBefore = await read({ view: 'task', scope: 'all' });
      assert.equal(globalGateBefore.current_projection_unavailable, true, 'real unresolved Global frontier gate remains distinct from query scope');
    });

    await t.test('an unfamiliar original function body fails closed without changing catalog', async () => {
      await admin.query('begin');
      try {
        await admin.query(original.replace(/begin\r?\n/, 'begin\n  -- incompatible synthetic predecessor\n'));
        await assert.rejects(admin.query(migration), /imprint_query_owner_scope_source_changed/);
      } finally { await admin.query('rollback'); }
      assert.deepEqual(await snapshotCallerCatalog(admin), originalCatalog);
    });

    await t.test('only three exact body replacements apply; public identity, ACL and every other function remain unchanged', async () => {
      await admin.query(migration);
      const expected = original
        .replace('v_id uuid; v_scopes text[]; v_domains text[];', 'v_id uuid; v_scopes text[]; v_owner_scopes text[]; v_domains text[];')
        .replace('  v_scopes:=clued_private.imprint_owner_scopes_v1(v_owner);', '  v_owner_scopes:=clued_private.imprint_owner_scopes_v1(v_owner);\n  v_scopes:=v_owner_scopes;')
        .replace('clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence', 'clued_private.imprint_record_currentness_v1(v_owner,m,v_owner_scopes) fence');
      assert.equal((await admin.query("select pg_get_functiondef('public.clued_imprint_read_v1(jsonb)'::regprocedure) value")).rows[0].value, expected);
      const after = await snapshotCallerCatalog(admin);
      const changed = after.filter((row, index) => JSON.stringify(row) !== JSON.stringify(originalCatalog[index]));
      assert.equal(changed.length, 1); assert.equal(changed[0].signature, 'clued_imprint_read_v1(jsonb)');
      assert.deepEqual(after.map(({ source_hash, ...row }) => row), originalCatalog.map(({ source_hash, ...row }) => row));
      await assertGatewayCloseoutBoundary(admin);
      await admin.query(migration);
      assert.deepEqual(await snapshotCallerCatalog(admin), after, 'exact applied-body replay is inert');
    });

    await t.test('full selected Project strict query agrees with Context while output and pagination remain narrowed', async () => {
      const result = await strict();
      assert.equal(result.current_projection_unavailable, false); assert.equal(result.projection_rebuild_required, false);
      assert.equal(result.selection_complete, true); assert.equal(result.withheld_record_count, 0);
      assert.deepEqual(new Set(result.records.map(row => row.id)), new Set([globalTask, projectTask]));
      const context = await development();
      for (const row of result.records) {
        assert.equal(row.scope, scope); assert.equal(row.record_currentness, 'CURRENT'); assert.equal(row.authoritative, true);
        const twin = context.records.find(otherRow => otherRow.id === row.id);
        for (const key of ['id', 'version', 'title', 'content', 'record_currentness']) assert.equal(row[key], twin[key]);
      }
      const first = await strict({ limit: 1 }), second = await strict({ limit: 1, cursor: first.page.next_cursor });
      assert.equal(first.page.complete, false); assert.equal(second.page.complete, true);
      assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 2);
      const selected = await read({ view: 'all', scope, limit: 100 });
      assert.deepEqual(new Set(selected.records.map(row => row.id)), new Set([globalTask, projectTask, note]));
      for (const id of [globalRef.source_id, projectRef.source_id, foreignRef.source_id, outsideTask]) assert.ok(!selected.records.some(row => row.id === id));
      assert.deepEqual((await strict({ query: 'Global source' })).records.map(row => row.id), [globalTask]);
      const gate = await read({ view: 'task', scope: 'all' });
      for (const key of ['current_projection_unavailable', 'projection_rebuild_required', 'selection_complete']) assert.equal(gate[key], globalGateBefore[key]);
    });

    // Each negative uses real rows and the real Native role inside a rollback,
    // preserving the successful fixture and its registered intent generations.
    async function negative(sql, values, expected = 'UNKNOWN') {
      await admin.query('begin');
      try {
        await admin.query(sql, values);
        await admin.query('set local role authenticated');
        await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [owner, JSON.stringify(claims(owner))]);
        const result = await strict({ id: globalTask }, admin);
        assert.equal(result.current_projection_unavailable, true); assert.equal(result.selection_complete, false);
        assert.equal(result.withheld_record_count, 1); assert.deepEqual(result.records, []);
        const history = await strict({ id: globalTask, include_history: true }, admin);
        assert.equal(history.records[0].record_currentness, expected); assert.equal(history.records[0].authoritative, false);
      } finally { await admin.query('rollback'); }
    }
    for (const [label, sql, values] of [
      ['source version drift', 'update public.clued_memories set version=version+1 where id=$1', [globalRef.source_id]],
      ['unregistered source intent', `update public.clued_memories set type_fields=jsonb_set(type_fields,'{execution_intents}','[]') where id=$1`, [globalRef.source_id]],
      ['terminal source', "update public.clued_memories set lifecycle_status='archived',status='archived' where id=$1", [globalRef.source_id]],
      ['unbound source projection', `update public.clued_memories set type_fields=type_fields||'{"projection_key":"unbound-source"}'::jsonb where id=$1`, [globalRef.source_id]],
      ['foreign source scope', `update public.clued_memories set type_fields=jsonb_set(type_fields,'{execution_intent}',$2::jsonb) where id=$1`, [globalTask, JSON.stringify({ ...foreignRef, id: globalRef.id })]],
    ]) await t.test(`${label} still withholds the Task instead of upgrading uncertainty`, () => negative(sql, values));

    await t.test('real active source carrier remains a blocker', async () => {
      await admin.query('begin');
      try {
        const event = (await admin.query(`insert into public.clued_context_events(user_id,context_key,event_type,payload)
          values($1,'global','blocker','{"title":"Isolated active source blocker"}') returning id`, [owner])).rows[0].id;
        await admin.query(`insert into clued_private.event_truth_carriers
          (event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
          values($1,$2,'global',array['decision'],'work_log','direct','ACTIVE_UNSTRUCTURED',1)`, [event, owner]);
        assert.equal(await fence(globalRef.source_id), 'SHADOWED_BY_ACTIVE_EVENT');
        await admin.query('set local role authenticated');
        await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [owner, JSON.stringify(claims(owner))]);
        assert.equal((await strict({ id: globalTask }, admin)).current_projection_unavailable, true);
      } finally { await admin.query('rollback'); }
    });

    await t.test('Native identity, foreign and shared-only Project isolation and exact caller ACL are unchanged', async () => {
      await admin.query(`insert into clued_private.project_memberships_v13
        (project_id,subject_id,resource_owner_id,environment,role,actions,grantor_id,expires_at)
        values($1,$2,$3,'test','reader',array['read'],$3,now()+interval '1 hour')`, [foreignProject, owner, other]);
      assert.ok(!ownerScopes.includes(foreignScope));
      await assert.rejects(read({ view: 'all', scope: foreignScope, include_history: true }), /imprint_scope_not_found/);
      assert.deepEqual((await read({ id: globalTask, include_history: true }, stranger)).records, []);
      const oauth = await connect('authenticated', { ...claims(owner), client_id: 'external-oauth-client' });
      const missing = await connect('authenticated', { role: 'authenticated' });
      await assert.rejects(read(projectInput, oauth), /direct_human_session_required/);
      await assert.rejects(read(projectInput, missing), /direct_human_session_required/);
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_function_privilege($1,'public.clued_imprint_read_v1(jsonb)','execute') value", [role])).rows[0].value, role === 'authenticated');
        if (role !== 'authenticated') await assert.rejects(read(projectInput, await connect(role, claims(owner))), /permission denied for function clued_imprint_read_v1/);
      }
      assert.equal((await strict()).current_projection_unavailable, false, 'all failed probes left valid source identities intact');
    });
    await t.test('chronological successors preserve current Owner-scope behavior and Native isolation', async () => {
      for (const name of successors) await admin.query(await fs.readFile(path.join(migrationDir, name), 'utf8'));
      const result = await strict();
      assert.equal(result.current_projection_unavailable, false); assert.equal(result.selection_complete, true);
      assert.deepEqual(new Set(result.records.map(row => row.id)), new Set([globalTask, projectTask]));
      assert.ok(result.records.every(row => row.scope === scope && row.record_currentness === 'CURRENT' && row.authoritative));
      assert.deepEqual(new Set((await development()).records.map(row => row.id)), new Set([globalTask, projectTask]));
      await assert.rejects(read({ view: 'all', scope: foreignScope, include_history: true }), /imprint_scope_not_found/);
      assert.deepEqual((await read({ id: globalTask, include_history: true }, stranger)).records, []);
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_function_privilege($1,'public.clued_imprint_read_v1(jsonb)','execute') value", [role])).rows[0].value, role === 'authenticated');
      }
      await assertGatewayCloseoutBoundary(admin);
    });
    t.diagnostic(`complete chronological chain ${names.length} migrations; total ${Math.round(performance.now() - started)}ms`);
  } finally {
    for (const db of clients.reverse()) await db.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
