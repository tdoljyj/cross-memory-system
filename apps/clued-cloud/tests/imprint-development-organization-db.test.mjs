import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('Development Imprint: exact Owner namespace, shared Canonical tasks, immutable candidates and actual history',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-development-imprint-'));
  const server = newCluster({ databaseDir: directory, user: 'postgres', password: uuid(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await startCluster(server);
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const owner = uuid(), other = uuid(), project = uuid(), otherProject = uuid(), secondProject = uuid();
    const withOwnerWriter = async (user, write) => {
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [user]);
        assert.equal((await admin.query('select clued_private.authorization_writer_guard_held_v2($1) held', [user])).rows[0].held, true);
        const result = await write();
        await admin.query('commit');
        return result;
      } catch (error) { await admin.query('rollback'); throw error; }
    };
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'development-owner@example.invalid',now()),($2,'development-other@example.invalid',now())`, [owner, other]);
    for (const [id, user] of [[project, owner], [secondProject, owner], [otherProject, other]]) {
      await withOwnerWriter(user, () => admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
        values($1,$2,$3,$3,$4)`, [id, user, `project-${id}`, `project:${id}`]));
    }
    // raw-binding-grants: inert synthetic Bindings provide source actor FKs and
    // a direct admin call to the existing field/version filter. No Binding is
    // authenticated, no token is exposed, and no Agent authority is invented.
    const binding = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Development fixture',$2,array['context:read'],array['project:'||$3::text]) returning id`,
    [owner, hash(uuid()), project])).rows[0].id;
    assert.equal(Number((await admin.query('select count(*) n from clued_private.authorizations_v12 where binding_id=$1', [binding])).rows[0].n), 0,
      'FK-only actor fixture has no authenticated authorization');
    assert.equal(Number((await admin.query('select count(*) n from clued_private.development_grants_v14 where binding_id=$1', [binding])).rows[0].n), 0,
      'FK-only actor fixture has no development grant');
    const space = async (user = owner, projectId = project, environment = 'preview') => withOwnerWriter(user, async () =>
      (await admin.query(`insert into clued_private.development_spaces_v14
        (owner_id,project_id,name,environment,cursor) values($1,$2,'Synthetic owned space',$3,2) returning id`, [user, projectId, environment])).rows[0].id);
    const context = await space(), production = await space(owner, project, 'production');
    const foreignContext = await space(other, otherProject), invalidProjectContext = await space(owner, otherProject);
    const put = async ({ id = uuid(), contextId = context, kind = 'note', version = 1, lifecycle = 'ACTIVE',
      body = { title: 'Original development note', public: 'Latest public text', secret: 'Owner-only source JSON' },
      authority = 'candidate', cursor = 1 } = {}) => {
      const digest = (await admin.query('select clued_private.development_hash_v14($1::jsonb) v', [JSON.stringify(body)])).rows[0].v;
      await admin.query(`insert into clued_private.development_records_v14
        (id,context_id,version,record_type,body,content_hash,lifecycle_status,authority,created_cursor,revision_cursor,actor_binding_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)`, [id, contextId, version, kind, body, digest, lifecycle, authority, cursor, binding]);
      return id;
    };
    const candidate = await put({ kind: 'task', version: 2, cursor: 2 });
    const annotation = await put({ kind: 'annotation', body: { title: '原文技术JSON', annotation_of: { context_id: context, record_id: candidate }, values: [1, 2, 3] } });
    const noHistory = await put({ version: 3 });
    const closed = await put({ lifecycle: 'REVOKED' }), superseded = await put({ lifecycle: 'SUPERSEDED' });
    const foreign = await put({ contextId: foreignContext }), otherEnvironment = await put({ contextId: production });
    const oldBody = { title: 'Previous source title', public: 'Saved old text', secret: 'Saved old secret' };
    const oldEnvelope = (await admin.query(`select to_jsonb(r)||jsonb_build_object('version',1,'revision_cursor',1,'body',$2::jsonb,
      'content_hash',clued_private.development_hash_v14($2::jsonb)) v from clued_private.development_records_v14 r where r.id=$1`,
    [candidate, JSON.stringify(oldBody)])).rows[0].v;
    await admin.query('insert into clued_private.development_record_versions_v14 values($1,1,$2,1,$3)', [candidate, context, oldEnvelope]);
    const secondRetained = await put({ version: 2, cursor: 2, body: { title: 'Second present title', public: 'Different present content' } });
    const secondOldBody = { title: 'A retained second title', public: 'Saved old text only in retained history' };
    const secondEnvelope = (await admin.query(`select to_jsonb(r)||jsonb_build_object('version',1,'revision_cursor',1,'body',$2::jsonb,
      'content_hash',clued_private.development_hash_v14($2::jsonb)) v from clued_private.development_records_v14 r where r.id=$1`,
    [secondRetained, JSON.stringify(secondOldBody)])).rows[0].v;
    await admin.query('insert into clued_private.development_record_versions_v14 values($1,1,$2,1,$3)', [secondRetained, context, secondEnvelope]);
    const grant = (await admin.query(`insert into clued_private.development_grants_v14
      (context_id,binding_id,grantor,actions,history_policy,version_policy,freeze_cursor,allowed_fields,expires_at)
      values($1,$2,$3,array['read'],'EXISTING_ONLY','FIXED_AT_GRANT',1,array['public'],now()+interval '1 hour') returning id`,
    [context, binding, owner])).rows[0].id;
    const personal = async ({ id = uuid(), kind = 'task', projectId = project, lifecycle = 'active' } = {}) => {
      await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason,content_hash)
        values($1,$2,'Real Canonical record','正式任务同源全文','project',$3,$4,$5,1,$6,$7,$8,'{}','{}','user_explicit','Owner original words',$9)`,
      [id, owner, projectId, kind, lifecycle === 'active' ? 'active' : 'done', lifecycle, `project:${projectId}`,
        kind === 'task' ? { execution_bucket: 'later' } : { rationale: 'Owner confirmed choice' }, hash(uuid())]);
      return id;
    };
    const canonicalTask = await personal({ id: candidate }), decision = await personal({ kind: 'decision' });
    const otherProjectTask = await personal({ projectId: secondProject });
    const actor = async jwt => {
      const client = server.getPgClient(); clients.push(client); await client.connect(); await client.query('set role authenticated');
      const value = jwt ?? { sub: owner, role: 'authenticated', session_id: 'development-imprint-fixture' };
      await client.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [value.sub ?? '', JSON.stringify(value)]);
      return client;
    };
    const human = await actor();
    const call = async (client, name, input, digest) => (await client.query(`select public.${name}($1${digest === undefined ? '' : ',$2'}) v`,
      digest === undefined ? [JSON.stringify(input)] : [JSON.stringify(input), digest])).rows[0].v;
    const read = input => call(human, 'clued_development_imprint_read_v1', { context_id: context, ...input });
    const set = (input, client = human) => call(client, 'clued_development_imprint_organization_set_v1', input, hash(JSON.stringify(input)));
    const input = (id, domains, base = 0, recordVersion = id === candidate ? 2 : 1, source_kind = 'development') => ({
      context_id: context, source_kind, record_id: id, record_version: recordVersion, base_version: base,
      domains, idempotency_key: `development-imprint:${uuid()}` });
    const visibleForOldGrant = async () => (await admin.query(`select clued_private.development_visible_record_v14($1,g) v
      from clued_private.development_grants_v14 g where g.id=$2`, [candidate, grant])).rows[0].v;
    const snapshot = async () => {
      const result = {};
      for (const table of ['clued_private.development_records_v14', 'clued_private.development_spaces_v14',
        'clued_private.development_record_versions_v14', 'clued_private.development_grants_v14',
        'public.clued_memories', 'clued_private.scope_currentness_heads', 'clued_private.event_truth_carriers']) {
        result[table] = (await admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') v from ${table} t`)).rows[0].v;
      }
      result.oldGrant = await visibleForOldGrant();
      return result;
    };
    const before = await snapshot();

    await t.test('development labels change zero source, cursor, qualification, history or restricted-grant state', async () => {
      assert.deepEqual(before.oldGrant.body, { public: 'Saved old text' });
      assert.equal('content_hash' in before.oldGrant, false);
      for (const id of [candidate, annotation, closed, superseded]) {
        const result = await set(input(id, ['work', 'learning']));
        assert.equal(result.status, 'committed', JSON.stringify(result));
        assert.deepEqual(result.supplemental.organization, { context_id: context, record_id: id, domains: ['learning', 'work'], version: 1 });
      }
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('development CAS and stable replay stay separate from Canonical organization even for the same UUID', async () => {
      const change = input(candidate, ['creation'], 1);
      const first = await set(change), replay = await set(change);
      assert.equal(first.status, 'committed'); assert.equal(replay.receipt_id, first.receipt_id); assert.equal(replay.replayed, true);
      assert.deepEqual(replay.supplemental, first.supplemental);
      assert.equal((await set(input(candidate, ['daily'], 1))).error_code, 'organization_version_conflict');
      assert.equal((await set(input(candidate, ['daily'], 2, 99))).error_code, 'record_version_conflict');
      const peer = await actor();
      const raced = await Promise.all([set(input(candidate, ['daily'], 2)), set(input(candidate, ['interest'], 2), peer)]);
      assert.equal(raced.filter(r => r.status === 'committed').length, 1);
      assert.equal(raced.filter(r => r.error_code === 'organization_version_conflict').length, 1);
      const canonical = await set(input(canonicalTask, ['work'], 0, 1, 'canonical'));
      assert.equal(canonical.status, 'committed');
      const userSide = await call(human, 'clued_imprint_read_v1', { id: canonicalTask, include_history: true });
      assert.deepEqual(userSide.records[0].domains, ['work']); assert.equal(userSide.records[0].organization_version, 1);
      const crossTab = input(canonicalTask, ['work', 'creation'], 1, 1, 'canonical');
      const personalInput = { ...crossTab };
      delete personalInput.context_id; delete personalInput.source_kind;
      const crossResults = await Promise.all([set(crossTab), call(peer, 'clued_imprint_organization_set_v1', personalInput, hash(JSON.stringify(personalInput)))]);
      assert.equal(crossResults[0].receipt_id, crossResults[1].receipt_id);
      assert.ok(crossResults.every(r => r.status === 'committed'));
      assert.equal(crossResults.filter(r => r.replayed).length, 1);
      const both = await read({ id: candidate, include_history: true });
      assert.equal(both.records.length, 2);
      for (const source_kind of ['development', 'canonical']) {
        const exact = await read({ id: candidate, source_kind, include_history: true });
        assert.equal(exact.records.length, 1); assert.equal(exact.records[0].source_kind, source_kind);
      }
      // The two real tables intentionally contain the same UUID. Omitting the
      // write discriminator must not silently choose either organization row,
      // consume a Receipt key or emit an Event, even with otherwise valid CAS.
      const mutationState = async () => {
        const result = {};
        for (const table of ['clued_private.imprint_organization_v1', 'clued_private.imprint_development_organization_v1',
          'public.clued_audit_receipts', 'public.clued_context_events']) {
          result[table] = (await admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') v from ${table} t`)).rows[0].v;
        }
        return result;
      };
      const exactState = await mutationState();
      const omitted = input(candidate, ['work'], 3); delete omitted.source_kind;
      await assert.rejects(set(omitted), /development_imprint_organization_input_invalid/);
      for (const source_kind of [null, 123, 'other']) {
        await assert.rejects(set({ ...input(candidate, ['work'], 3), source_kind }), /development_imprint_organization_input_invalid/);
      }
      assert.deepEqual(await mutationState(), exactState);
      await assert.rejects(read({ id: candidate, source_kind: 'other' }), /development_imprint_read_input_invalid/);
      assert.notDeepEqual(both.records.find(r => r.source_kind === 'canonical').domains, both.records.find(r => r.source_kind === 'development').domains);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await set(input(otherProjectTask, ['work'], 0, 1, 'canonical'))).error_code, 'record_not_found');
    });

    await t.test('eight views share server filtering and a global merged page; formal views use actual Canonical tasks', async () => {
      const all = await read({ include_history: true });
      assert.ok(!all.records.some(r => [foreign, otherEnvironment, otherProjectTask].includes(r.id)));
      assert.equal(all.coverage.development_candidate_promotion, false); assert.equal(all.coverage.mcp_grants_changed, false);
      const candidateRow = all.records.find(r => r.id === candidate && r.source_kind === 'development');
      assert.equal(candidateRow.qualification, 'candidate'); assert.equal(candidateRow.authority, 'candidate');
      assert.equal(candidateRow.authoritative, false); assert.equal(candidateRow.record_currentness, 'UNKNOWN');
      assert.equal(candidateRow.history.length, 1); assert.deepEqual(candidateRow.history[0].body, oldBody);
      assert.equal(candidateRow.history[0].record_currentness, 'HISTORY');
      assert.equal(all.records.find(r => r.id === noHistory).history.length, 0, 'no inferred prior bodies');
      assert.equal(all.records.find(r => r.id === closed).lifecycle_status, 'REVOKED');
      assert.equal(all.records.find(r => r.id === closed).record_currentness, 'HISTORY');
      const full = all.records.find(r => r.id === annotation);
      assert.deepEqual(JSON.parse(full.content), full.body); assert.equal(full.source_status.available, false);
      for (const [view, id] of [['task', canonicalTask], ['decision', decision]]) {
        const projection = await read({ view });
        assert.deepEqual(projection.records.map(r => r.id), [id]);
        assert.equal(projection.records[0].source_kind, 'canonical');
        assert.equal(projection.records[0].source_semantics, 'canonical_record');
        assert.equal(projection.records[0].content, '正式任务同源全文');
      }
      const filtered = await read({ view: 'work', domains: ['learning'], include_history: true, limit: 1 });
      assert.equal(filtered.records.length, 1); assert.ok(filtered.records[0].domains.includes('learning'));
      const identities = new Set(); let cursor = 0;
      for (;;) {
        const page = await read({ include_history: true, limit: 2, cursor });
        for (const r of page.records) { const key = `${r.source_kind}:${r.id}`; assert.ok(!identities.has(key)); identities.add(key); }
        if (page.page.complete) break; cursor = page.page.next_cursor;
      }
      assert.equal(identities.size, all.records.length);
      assert.equal((await read({ query: 'Owner-only source JSON' })).records.filter(r => r.source_kind === 'development').length, 4);
      assert.equal((await read({ query: '正式任务同源全文' })).records.length, 2);
    });
    await t.test('default development browse retains terminal latest and candidates beside withheld Canonical records', async () => {
      const terminalTask = await personal({ lifecycle: 'completed' });
      const unknownCanonical = uuid();
      await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason,content_hash)
        values($1,$2,'Unknown Canonical State','Unknown project projection','project',$3,'state','current',1,'active',$4,
          '{"state_kind":"manual","projection_key":"unbound-development-projection"}','{}','{}','observed','Synthetic unknown',$5)`,
      [unknownCanonical, owner, project, `project:${project}`, hash(uuid())]);
      const all = await read({});
      assert.equal(all.read_semantics, 'qualified_saved_latest'); assert.equal(all.current_projection_unavailable, false);
      assert.equal(all.selection_complete, false); assert.ok(all.withheld_record_count >= 1);
      for (const id of [closed, superseded, candidate]) assert.ok(all.records.some(r => r.id === id && r.source_kind === 'development'));
      assert.equal(all.records.find(r => r.id === closed).record_currentness, 'HISTORY');
      assert.equal(all.records.find(r => r.id === terminalTask).record_currentness, 'HISTORY');
      assert.ok(!all.records.some(r => r.id === unknownCanonical));
      const diagnostic = await read({ include_history: true });
      assert.equal(diagnostic.records.find(r => r.id === unknownCanonical).record_currentness, 'UNKNOWN');
      const event = (await admin.query(`insert into public.clued_context_events(user_id,context_key,event_type,payload)
        values($1,$2,'blocker','{"title":"Development Canonical unresolved blocker"}') returning id`, [owner, `project:${project}`])).rows[0].id;
      await admin.query(`insert into clued_private.event_truth_carriers
        (event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
        values($1,$2,$3,array['task'],'work_log','direct','ACTIVE_UNSTRUCTURED',1)`, [event, owner, `project:${project}`]);
      try {
        const partial = await read({});
        assert.ok(partial.records.some(r => r.id === candidate && r.source_kind === 'development'));
        assert.ok(!partial.records.some(r => r.id === canonicalTask && r.source_kind === 'canonical'));
        assert.equal(partial.current_projection_unavailable, false); assert.equal(partial.selection_complete, false);
        assert.ok(partial.withheld_by_active_events);
        const strict = await read({ view: 'task' });
        assert.equal(strict.read_semantics, 'strict_current'); assert.equal(strict.current_projection_unavailable, true);
        assert.equal(strict.selection_complete, false); assert.deepEqual(strict.records, []);
      } finally {
        await admin.query('delete from clued_private.event_truth_carriers where event_id=$1', [event]);
      }
    });

    await t.test('Native exact space+project ownership, environment and roles cannot broaden grants', async () => {
      await assert.rejects(read({ context_id: foreignContext }), /context_access_denied/);
      await assert.rejects(read({ context_id: invalidProjectContext }), /context_access_denied/);
      await assert.rejects(read({ environment: 'production' }), /context_environment_denied/);
      await assert.rejects(read({ scope: `project:${otherProject}` }), /context_access_denied/);
      assert.equal((await set({ ...input(otherEnvironment, ['work']), environment: 'preview' })).error_code, 'development_record_not_found');
      await assert.rejects(set({ ...input(candidate, ['work'], 3), environment: 'production' }), /context_environment_denied/);
      const stranger = await actor({ sub: other, role: 'authenticated', session_id: 'other-fixture' });
      await assert.rejects(call(stranger, 'clued_development_imprint_read_v1', { context_id: context }), /context_access_denied/);
      const delegated = await actor({ sub: owner, role: 'authenticated', client_id: 'delegated', session_id: 'delegated-fixture' });
      await assert.rejects(call(delegated, 'clued_development_imprint_read_v1', { context_id: context }), /direct_human_session_required/);
      await assert.rejects(set(input(candidate, ['work'], 3), delegated), /direct_human_session_required/);
      await assert.rejects(set({ ...input(candidate, ['work'], 3), body: { overwritten: true } }), /development_imprint_organization_input_invalid/);
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        for (const signature of ['public.clued_development_imprint_read_v1(jsonb)', 'public.clued_development_imprint_organization_set_v1(jsonb,text)']) {
          assert.equal((await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') v", [role, signature])).rows[0].v, role === 'authenticated');
        }
        assert.equal((await admin.query("select has_table_privilege($1,'clued_private.imprint_development_organization_v1','select,insert,update,delete') v", [role])).rows[0].v, false);
      }
    });
    await t.test('only retained development revisions match old words before merged paging; latest source stays intact', async () => {
      const stable = await snapshot();
      assert.deepEqual((await read({ query: 'Saved old text', source_kind: 'development' })).records, []);
      const result = await read({ query: 'Saved old text', source_kind: 'development', include_history: true });
      assert.deepEqual(result.records.map(r => r.id).sort(), [candidate, secondRetained].sort());
      const found = result.records.find(r => r.id === candidate);
      assert.deepEqual(JSON.parse(found.content), { title: 'Original development note', public: 'Latest public text', secret: 'Owner-only source JSON' });
      assert.equal(found.version, 2); assert.equal(found.record_currentness, 'UNKNOWN'); assert.equal(found.authoritative, false);
      assert.equal(found.match_source, 'retained_history'); assert.equal(found.matched_revisions.length, 1);
      assert.equal(found.matched_revisions[0].id, candidate);
      assert.equal(found.matched_revisions[0].context_id, context);
      assert.equal(found.matched_revisions[0].version, 1);
      assert.equal(found.matched_revisions[0].matched_record_version, 1);
      assert.deepEqual(found.matched_revisions[0].body, oldBody);
      assert.equal(found.matched_revisions[0].record_currentness, 'HISTORY');
      assert.equal(found.matched_revisions[0].authoritative, false);
      const titleHit = await read({ query: 'Previous source title', include_history: true });
      assert.deepEqual(titleHit.records.map(r => r.id), [candidate]);
      assert.equal(titleHit.records[0].matched_revisions[0].title, 'Previous source title');
      const first = await read({ query: 'Saved old text', include_history: true, limit: 1 });
      assert.equal(first.records.length, 1); assert.equal(first.page.complete, false);
      const second = await read({ query: 'Saved old text', include_history: true, limit: 1, cursor: first.page.next_cursor });
      assert.equal(second.records.length, 1); assert.notEqual(first.records[0].id, second.records[0].id); assert.equal(second.page.complete, true);
      const currentDomain = found.domains[0];
      assert.deepEqual((await read({ query: 'Saved old text', include_history: true, domains: [currentDomain] })).records.map(r => r.id), [candidate]);
      assert.deepEqual((await read({ query: 'Saved old text', include_history: true, domains: ['creation'] })).records, []);
      assert.deepEqual((await read({ query: 'Previous source title', include_history: true, record_type: 'note' })).records, []);
      assert.deepEqual((await read({ query: 'Saved old text', include_history: true, source_kind: 'canonical' })).records, []);
      assert.deepEqual((await read({ query: 'Saved old text', include_history: true, view: 'task' })).records, []);
      assert.deepEqual((await read({ context_id: production, query: 'Saved old text', include_history: true })).records, []);
      const browsing = await read({ id: candidate, source_kind: 'development', query: '', include_history: true });
      assert.equal(browsing.records[0].match_source, 'browse'); assert.deepEqual(browsing.records[0].matched_revisions, []);
      assert.equal(browsing.records[0].history.length, 1);
      assert.equal(browsing.records[0].history[0].id, candidate);
      assert.equal(browsing.records[0].history[0].context_id, context);
      assert.equal(browsing.records[0].history[0].version, 1);
      assert.deepEqual(await snapshot(), stable);
    });
    await t.test('Canonically isolated rows cannot re-enter a development history projection', async () => {
      const originalDefinition = (await admin.query("select pg_get_functiondef('clued_private.record_currentness_fence(uuid,uuid,text[])'::regprocedure) v")).rows[0].v;
      await admin.query(originalDefinition.replace('clued_private.record_currentness_fence(', 'clued_private.imprint_development_fixture_fence('));
      await admin.query(`create or replace function clued_private.record_currentness_fence(
        p_user_id uuid,p_record_id uuid,p_authorized_scopes text[]) returns text language plpgsql stable security definer set search_path='' as $$
        begin
          if p_record_id='${canonicalTask}'::uuid then return 'ISOLATED'; end if;
          return clued_private.imprint_development_fixture_fence(p_user_id,p_record_id,p_authorized_scopes);
        end $$`);
      try {
        for (const include_history of [false, true]) {
          const tasks = await read({ view: 'task', id: canonicalTask, source_kind: 'canonical', include_history });
          assert.deepEqual(tasks.records, []); assert.equal(tasks.withheld_record_count, 0);
          assert.equal(tasks.page.next_cursor, null); assert.equal(tasks.page.complete, true);
          const sameID = await read({ id: candidate, include_history });
          assert.equal(sameID.records.length, 1); assert.equal(sameID.records[0].source_kind, 'development');
        }
        assert.equal((await set(input(canonicalTask, ['work'], 2, 1, 'canonical'))).error_code, 'record_not_found');
      } finally {
        await admin.query(originalDefinition);
        await admin.query('drop function clued_private.imprint_development_fixture_fence(uuid,uuid,text[])');
      }
    });
    await t.test('normal authorized Context writes auto-organize atomically; manual clear and replay retain source identity', async () => {
      await allowRawTestBindings(admin); await allowTestIssuerCredentials(admin);
      const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect();
      await setWorkerGatewayCaller(gateway);
      const issuer = hash(uuid()), resource = 'https://imprint-auto.example.invalid/mcp';
      await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
        values($1,$2,'Automatic domain synthetic issuer')`, [issuer, resource]);
      const prepared = (await human.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) v', [issuer, JSON.stringify({
        request_digest: hash(uuid()), client_id: 'imprint-auto-client', client_name: 'Automatic domain fixture',
        redirect_uri: 'https://imprint-auto.example.invalid/callback', resource, requested_scopes: ['context:read', 'context:write'],
      })])).rows[0].v;
      const token = hash(uuid());
      const authorized = (await human.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) v',
        [issuer, prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: 'context', resource_id: context,
          environment: 'preview', actions: ['read', 'write'] }]), token, new Date(Date.now() + 3600000).toISOString()])).rows[0].v;
      assert.ok(authorized.binding_id, JSON.stringify(authorized)); assert.equal(authorized.version, 1);
      const write = request => workerGatewayRpc(gateway, 'clued_development_call_v14', token,
        { context_id: context, environment: 'preview', ...request });
      const create = body => ({ op: 'record_put', record_type: 'note', body, idempotency_key: uuid() });
      const request = create({ title: 'Same raw source', content: '客户Logo设计方案。\n我正在复习线性代数。',
        source_refs: [{ content: '用途：兴趣探索。' }], metadata: { purpose: '家庭预算' } });
      const saved = await write(request), id = saved.result.id;
      assert.equal(saved.status, 'committed', JSON.stringify(saved));
      const org = async target => (await admin.query('select * from clued_private.imprint_development_organization_v1 where record_id=$1', [target])).rows[0];
      const original = (await admin.query('select to_jsonb(r) v from clued_private.development_records_v14 r where id=$1', [id])).rows[0].v;
      assert.deepEqual((await org(id)).domains, ['creation', 'learning', 'work']);
      assert.equal((await org(id)).source_operation_id, saved.operation_id);
      assert.equal((await org(id)).receipt_id, null, 'private operation Receipt is not a public M1 Receipt');
      assert.equal((await org(id)).auto_rules_version, 'imprint-explicit-local.v2');
      const projection = (await read({ id, view: 'learning', source_kind: 'development' })).records[0];
      assert.equal(projection.id, id); assert.equal(projection.organization_version, 1);
      assert.equal(projection.version, 1); assert.equal(projection.record_currentness, 'UNKNOWN');
      assert.equal(projection.authoritative, false); assert.deepEqual(projection.body, request.body);
      assert.deepEqual((await read({ id, view: 'task' })).records, []);
      const beforeAssociation = await org(id);
      const association = { record_id: id, record_version: 1, source_kind: 'development', context_id: context,
        environment: 'preview', target_id: canonicalTask, target_version: 1, action: 'add', base_version: 0, idempotency_key: uuid() };
      const linked = await call(human, 'clued_imprint_association_set_v1', association, hash(JSON.stringify(association)));
      assert.equal(linked.status, 'committed', JSON.stringify(linked));
      const classification = ({ associations, association_version, association_receipt_id, ...rest }) => rest;
      assert.deepEqual(classification(await org(id)), classification(beforeAssociation), 'association preserves actual automatic classification provenance');
      assert.equal(Number((await org(id)).association_version), 1);
      assert.deepEqual((await admin.query('select to_jsonb(r) v from clued_private.development_records_v14 r where id=$1', [id])).rows[0].v, original);
      const clear = input(id, [], 1), cleared = await set(clear), replay = await set(clear);
      assert.equal(cleared.status, 'committed', JSON.stringify(cleared)); assert.equal(replay.receipt_id, cleared.receipt_id);
      assert.equal(replay.replayed, true); assert.deepEqual((await org(id)).domains, []);
      assert.equal((await org(id)).source_operation_id, null); assert.equal((await org(id)).auto_rules_version, null);
      assert.equal((await org(id)).receipt_id, cleared.receipt_id);
      assert.deepEqual((await org(id)).associations, [{ record_id: canonicalTask, version: 1 }], 'classification upsert retains reading associations');
      assert.deepEqual((await admin.query('select to_jsonb(r) v from clued_private.development_records_v14 r where id=$1', [id])).rows[0].v, original);
      assert.equal((await write(request)).replayed, true);
      assert.deepEqual((await org(id)).domains, []);
      const updated = await write({ ...create({ content: '用途：家庭预算。' }), record_id: id, base_version: 1 });
      assert.equal(updated.result.version, 2); assert.deepEqual((await org(id)).domains, []);
      assert.equal((await set(input(id, ['daily'], 1, 2))).error_code, 'organization_version_conflict');
      for (const body of [{ content: '英文电影。' }, { content: '“用途：学习英语。”' },
        { source_refs: [{ text: '用途：工作汇报。' }], metadata: { content: '用途：学习英语。' } },
        { content: '用途：学习英语。', source_kind: 'external_material' }]) {
        const result = await write(create(body)); assert.equal(result.status, 'committed');
        assert.equal(await org(result.result.id), undefined);
      }
      const textField = await write(create({ text: '我收藏这篇文章用于兴趣探索。' }));
      assert.deepEqual((await org(textField.result.id)).domains, ['interest']);
      await assert.rejects(write({ ...create({ content: '用途：工作汇报。' }), environment: 'production' }), /context_environment_denied/);
      await assert.rejects(write({ ...create({ content: '用途：工作汇报。' }), context_id: foreignContext }), /denied|authorized|scope/);
      let aborted;
      await gateway.query('begin');
      try { aborted = (await write(create({ content: '用途：家庭预算。' }))).result.id; }
      finally { await gateway.query('rollback'); }
      assert.equal(await org(aborted), undefined);
      assert.equal((await admin.query('select count(*) n from clued_private.development_records_v14 where id=$1', [aborted])).rows[0].n, '0');
      const settled = await org(textField.result.id);
      await admin.query('update clued_private.development_operations_v14 set result=result where id=$1', [textField.operation_id]);
      assert.deepEqual(await org(textField.result.id), settled, 'settled operation updates do not classify twice');
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_function_privilege($1,'clued_private.imprint_auto_context_create_v1()','execute') v", [role])).rows[0].v, false);
      }
    });
    const associate = (value, client = human) => call(client, 'clued_imprint_association_set_v1', value, hash(JSON.stringify(value)));
    const associationRequest = (source, target = canonicalTask, extra = {}) => ({ record_id: source, record_version: 1,
      source_kind: 'development', context_id: context, environment: 'preview', target_id: target, target_version: 1,
      action: 'add', base_version: 0, idempotency_key: uuid(), ...extra });
    const currentRaw = id => read({ id, source_kind: 'development' }).then(result => result.records[0]);
    const rawSnapshot = async id => (await admin.query('select to_jsonb(r) v from clued_private.development_records_v14 r where id=$1', [id])).rows[0].v;
    await t.test('reading associations preserve Raw/canonical namespaces and one original source, with independent CAS and no-op replay', async () => {
      const original = await rawSnapshot(candidate), canonicalOriginal = (await admin.query('select to_jsonb(m) v from public.clued_memories m where id=$1', [canonicalTask])).rows[0].v;
      const request = associationRequest(candidate, canonicalTask, { record_version: 2 });
      const committed = await associate(request);
      assert.equal(committed.status, 'committed', JSON.stringify(committed));
      assert.equal(committed.supplemental.association.version, 1);
      const projected = await currentRaw(candidate);
      assert.equal(projected.association_version, 1); assert.equal(projected.authoritative, false); assert.equal(projected.record_currentness, 'UNKNOWN');
      assert.deepEqual(projected.associations.map(x => [x.record_id, x.source_kind, x.record_version, x.current_version]), [[canonicalTask, 'canonical', 1, 1]]);
      assert.deepEqual(await rawSnapshot(candidate), original);
      assert.deepEqual((await admin.query('select to_jsonb(m) v from public.clued_memories m where id=$1', [canonicalTask])).rows[0].v, canonicalOriginal);
      const replayed = await associate(request); assert.equal(replayed.receipt_id, committed.receipt_id); assert.equal(replayed.replayed, true);
      const duplicate = await associate({ ...request, base_version: 1, idempotency_key: uuid() });
      assert.equal(duplicate.status, 'committed'); assert.equal(duplicate.supplemental.association.changed, false);
      assert.deepEqual(duplicate.event_ids, []); assert.equal((await currentRaw(candidate)).association_version, 1);
      const mismatch = await associate({ ...request, target_id: decision });
      assert.equal(mismatch.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.equal((await associate({ ...request, idempotency_key: uuid() })).error_code, 'association_version_conflict');
      assert.equal((await associate({ ...request, record_version: 999, idempotency_key: uuid() })).error_code, 'record_version_conflict');
      assert.equal((await associate({ ...request, target_version: 999, base_version: 1, idempotency_key: uuid() })).error_code, 'record_version_conflict');
      assert.equal((await associate({ ...request, target_id: otherProjectTask, base_version: 1, idempotency_key: uuid() })).error_code, 'association_target_unavailable');
      assert.equal((await associate({ ...request, target_id: annotation, base_version: 1, idempotency_key: uuid() })).error_code, 'association_target_unavailable');
      assert.equal((await currentRaw(candidate)).association_version, 1, 'rejected operations never partly change metadata');
    });
    await t.test('same-key parallel calls settle once; first association initializes only absent organization and classification CAS0 must refresh', async () => {
      const source = await put(), before = await rawSnapshot(source), second = await actor();
      const request = associationRequest(source);
      const saved = await Promise.all([associate(request), associate(request, second)]);
      assert.ok(saved.every(x => x.status === 'committed'), JSON.stringify(saved)); assert.equal(saved[0].receipt_id, saved[1].receipt_id);
      const row = (await admin.query('select * from clued_private.imprint_development_organization_v1 where record_id=$1', [source])).rows[0];
      assert.equal(Number(row.version), 1); assert.equal(Number(row.association_version), 1); assert.deepEqual(row.domains, []);
      assert.equal(row.auto_rules_version, null); assert.equal(row.source_operation_id, null);
      assert.equal((await set(input(source, ['daily'], 0))).error_code, 'organization_version_conflict');
      assert.equal((await set(input(source, ['daily'], 1))).status, 'committed');
      assert.deepEqual((await currentRaw(source)).associations.map(x => x.record_id), [canonicalTask]);
      assert.deepEqual(await rawSnapshot(source), before);
      const racing = await put(), classification = input(racing, ['work'], 0), link = associationRequest(racing);
      const results = await Promise.all([set(classification), associate(link, second)]);
      assert.equal(results[1].status, 'committed', JSON.stringify(results));
      assert.ok(results[0].status === 'committed' || results[0].error_code === 'organization_version_conflict');
      const after = await currentRaw(racing); assert.equal(after.associations.length, 1);
      assert.deepEqual(after.domains, results[0].status === 'committed' ? ['work'] : []);
    });
    await t.test('Canonical reciprocal links have fixed row order and never change either body/state or existing formal relations', async () => {
      const a = await personal(), b = await personal({ kind: 'decision' }), second = await actor();
      const original = (await admin.query('select to_jsonb(m) v from public.clued_memories m where id=any($1::uuid[]) order by id', [[a, b]])).rows.map(r => r.v);
      await human.query("set statement_timeout='5s'"); await second.query("set statement_timeout='5s'");
      const requests = [associationRequest(a, b, { source_kind: 'canonical' }), associationRequest(b, a, { source_kind: 'canonical' })];
      const saved = await Promise.all([associate(requests[0]), associate(requests[1], second)]);
      assert.ok(saved.every(x => x.status === 'committed'), JSON.stringify(saved));
      assert.deepEqual((await admin.query('select to_jsonb(m) v from public.clued_memories m where id=any($1::uuid[]) order by id', [[a, b]])).rows.map(r => r.v), original);
      const fromContext = (await read({ id: a, source_kind: 'canonical' })).records[0];
      const fromUser = (await call(human, 'clued_imprint_read_v1', { id: a, scope: `project:${project}` })).records[0];
      assert.deepEqual(fromUser.associations, fromContext.associations); assert.equal(fromContext.associations[0].record_id, b);
      assert.equal((await associate(associationRequest(a, a, { source_kind: 'canonical', base_version: 1 }))).error_code, 'association_target_unavailable');
    });
    await t.test('unavailable target yields no stale title/ID; original association is retained diagnostically and can be removed', async () => {
      const source = await put(), target = await personal({ kind: 'decision' });
      assert.equal((await associate(associationRequest(source, target))).status, 'committed');
      await admin.query("update public.clued_memories set lifecycle_status='completed',status='done',version=version+1 where id=$1", [target]);
      const visible = await currentRaw(source);
      assert.deepEqual(visible.associations, []); assert.equal(visible.association_unavailable_count, 1);
      assert.equal(JSON.stringify(visible.associations).includes(target), false);
      const remove = associationRequest(source, target, { action: 'remove', base_version: 1 }); delete remove.target_version;
      assert.equal((await associate(remove)).status, 'committed'); assert.equal((await currentRaw(source)).association_unavailable_count, 0);
    });
    await t.test('cross-owner/context/environment, stale source and unqualified targets are refused; rollback and ACL remain strict', async () => {
      const source = await put(), request = associationRequest(source), stranger = await actor({ sub: other, role: 'authenticated', session_id: 'other' });
      await assert.rejects(associate(request, stranger), /denied|unavailable/);
      await assert.rejects(associate({ ...request, context_id: production, environment: 'production' }), /unavailable/);
      await assert.rejects(associate({ ...request, environment: 'production' }), /context_environment_denied/);
      await assert.rejects(associate({ ...request, caller_owner: owner }), /imprint_association_input_invalid/);
      assert.equal((await associate(associationRequest(closed))).error_code, 'association_source_unavailable');
      await human.query('begin'); let receipt;
      try { const saved = await associate(request); assert.equal(saved.status, 'committed'); receipt = saved.receipt_id; }
      finally { await human.query('rollback'); }
      assert.equal((await currentRaw(source)).association_version, 0);
      assert.equal((await admin.query('select count(*) n from public.clued_audit_receipts where id=$1', [receipt])).rows[0].n, '0');
      for (const role of ['anon', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_function_privilege($1,'public.clued_imprint_association_set_v1(jsonb,text)','execute') v", [role])).rows[0].v, false);
      }
      for (const signature of ['public.clued_imprint_read_before_associations_v1(jsonb)', 'public.clued_development_imprint_read_before_associations_v1(jsonb)',
        'clued_private.imprint_association_projection_v1(uuid,text,uuid,text,uuid)']) {
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') v', ['authenticated', signature])).rows[0].v, false);
      }
    });
    await t.test('mixed raw extraction uses only explicit text slots, exact Context ownership and Native S3 confirmation', async () => {
      // Formal creation uses an actual Native-recognized project, not the
      // earlier deliberately evidence-only projection fixtures.
      const extractionProject = uuid();
      const createProject = { operation: 'create', canonical_project_id: extractionProject, project_schema_version: 2,
        idempotency_key: uuid(), mutation: { name: 'Mixed extraction fixture', progress_status: 'active', aliases: [] },
        recognition: { confidence: 1, reason: 'Synthetic Native owner project', source: 'v2_explicit_create', source_refs: [] } };
      const createdProject = await call(human, 'clued_user_project_mutate_v2', createProject, hash(JSON.stringify(createProject)));
      assert.equal(createdProject.status, 'committed', JSON.stringify(createdProject));
      const extractionContext = await space(owner, extractionProject);
      const text = '😀原文\r\n周五交方案。已经决定采用A，因为成本低。', quote = '周五交方案';
      const id = await put({ contextId: extractionContext, body: { title: 'Mixed raw source', content: text, metadata: '我将删除资料。' } });
      const original = (await admin.query('select to_jsonb(r) v from clued_private.development_records_v14 r where id=$1', [id])).rows[0].v;
      const jwt = { sub: owner, role: 'authenticated', session_id: 'extraction-native', amr: [{ method: 'password', timestamp: Math.floor(Date.now()/1000) }] };
      const native = await actor(jwt), request = { idempotency_key: uuid(), owner_text_confirmed: true, source: {
        source_kind: 'development', context_id: extractionContext, environment: 'preview', record_id: id, record_version: 1,
        slot: 'content', start: [...text.slice(0, text.indexOf(quote))].length, end: [...text.slice(0, text.indexOf(quote)+quote.length)].length,
        text_hash: hash(text), quote, kind: 'task' } };
      const prepare = (input, client = native) => call(client, 'clued_imprint_extraction_prepare_v1', input, hash(JSON.stringify(input)));
      const first = await prepare(request); assert.equal(first.status, 'committed', JSON.stringify(first));
      assert.equal(first.supplemental.scope, `project:${extractionProject}`);
      const alternate = { ...request, idempotency_key: uuid(), source: { ...request.source, record_id: id.toUpperCase() } }; delete alternate.source.environment;
      assert.equal((await prepare(alternate)).supplemental.candidate_id, first.supplemental.candidate_id, 'equivalent namespace spelling and omitted environment dedup');
      await assert.rejects(prepare({ ...request, idempotency_key: uuid(), source: { ...request.source, context_id: production, environment: 'production' } }), /source_unavailable/);
      await assert.rejects(prepare({ ...request, idempotency_key: uuid(), source: { ...request.source, environment: 'production' } }), /environment_denied/);
      await assert.rejects(prepare({ ...request, idempotency_key: uuid(), source: { ...request.source, slot: 'metadata' } }), /source_invalid/);
      await assert.rejects(prepare({ ...request, idempotency_key: uuid(), source: { ...request.source, source_kind: 'canonical' } }), /source_unavailable/);
      const foreignActor = await actor({ ...jwt, sub: other }); await assert.rejects(prepare(request, foreignActor), /context_access_denied/);
      const issueInput = { tier: 'information', candidate_id: first.supplemental.candidate_id, base_version: 1, authority: 'user_explicit',
        confidence: null, confidence_reason: 'Native owner confirmed own raw words', native_type_fields: { execution_bucket: 'later' } };
      const view = await call(native, 'clued_candidate_confirmation_issue_v1', issueInput); assert.equal(view.status, 'issued', JSON.stringify(view));
      const promote = { tier: 'information', candidate_id: view.candidate_id, base_version: 1, confirmation_token: view.confirmation_token,
        view_digest: view.view_digest, idempotency_key: uuid() };
      const saved = await call(native, 'clued_candidate_promote_v1', promote, hash(JSON.stringify(promote)));
      assert.equal(saved.status, 'committed', JSON.stringify(saved));
      assert.equal(saved.supplemental.outcome, 'promoted', JSON.stringify(saved));
      assert.deepEqual((await admin.query('select to_jsonb(r) v from clued_private.development_records_v14 r where id=$1', [id])).rows[0].v, original);
      const rawView = (await read({ context_id: extractionContext, id, source_kind: 'development' })).records[0]; assert.equal(rawView.record_currentness, 'UNKNOWN'); assert.equal(rawView.authoritative, false);
      assert.equal((await call(native, 'clued_imprint_read_v1', { view: 'task', scope: `project:${extractionProject}`, id: view.record_id })).records[0].content, quote);
      const textId = await put({ contextId: extractionContext, body: { text, title: 'Alternative text slot' } });
      const textRequest = { ...request, idempotency_key: uuid(), source: { ...request.source, record_id: textId, slot: 'text' } };
      const c = (await prepare(textRequest)).supplemental;
      const v = await call(native, 'clued_candidate_confirmation_issue_v1', { ...issueInput, candidate_id: c.candidate_id }); assert.equal(v.status, 'issued');
      await admin.query("update clued_private.development_records_v14 set lifecycle_status='REVOKED',version=version+1 where id=$1", [textId]);
      assert.equal((await call(native, 'clued_candidate_confirmation_issue_v1', { ...issueInput, candidate_id: c.candidate_id })).status, 'rejected');
      const p = { ...promote, candidate_id: c.candidate_id, confirmation_token: v.confirmation_token, view_digest: v.view_digest, idempotency_key: uuid() };
      assert.equal((await call(native, 'clued_candidate_promote_v1', p, hash(JSON.stringify(p)))).status, 'rejected');
      assert.equal((await admin.query('select consumed_at is not null v from clued_private.candidate_confirmation_tokens where id=$1', [v.token_id])).rows[0].v, true);
      const reject = { tier: 'information', candidate_id: c.candidate_id, base_version: 1, idempotency_key: uuid() };
      assert.equal((await call(native, 'clued_candidate_reject_v1', reject, hash(JSON.stringify(reject)))).status, 'committed');
      const canonicalSource = await personal({ projectId: extractionProject, kind: 'decision' });
      const originalText = '正式任务同源全文', originalQuote = '正式任务';
      const canonicalRequest = { ...request, idempotency_key: uuid(), source: { ...request.source, source_kind: 'canonical', record_id: canonicalSource,
        start: 0, end: originalQuote.length, quote: originalQuote, text_hash: hash(originalText) } };
      const canonicalFirst = (await prepare(canonicalRequest)).supplemental;
      const secondContext = await space(owner, extractionProject), peer = await actor(jwt);
      const fromUser = { ...canonicalRequest, idempotency_key: uuid(), source: { ...canonicalRequest.source } }; delete fromUser.source.context_id; delete fromUser.source.environment;
      const crossViews = await Promise.all([prepare(fromUser), prepare({ ...canonicalRequest, idempotency_key: uuid(), source: { ...canonicalRequest.source, context_id: secondContext } },peer)]);
      assert.ok(crossViews.every(r=>r.supplemental.candidate_id===canonicalFirst.candidate_id),'same Canonical fragment shares one candidate across both directories and multiple Contexts');
      const cv = await call(native, 'clued_candidate_confirmation_issue_v1', { ...issueInput, candidate_id: canonicalFirst.candidate_id });
      const cp = { ...promote, candidate_id: cv.candidate_id, confirmation_token: cv.confirmation_token, view_digest: cv.view_digest, idempotency_key: uuid() };
      const canonicalSaved = await call(native, 'clued_candidate_promote_v1', cp, hash(JSON.stringify(cp)));
      assert.equal(canonicalSaved.supplemental.outcome, 'promoted', JSON.stringify(canonicalSaved));
      assert.equal((await prepare(fromUser)).supplemental.record_id, cv.record_id);
      // A second quote remains pending, initially bound to the exact first Context.
      const pending = (await prepare({ ...canonicalRequest, idempotency_key: uuid(), source: { ...canonicalRequest.source, start: 4, end: 6, quote: '同源' } })).supplemental;
      await withOwnerWriter(owner, () => admin.query('update clued_private.development_spaces_v14 set project_id=$2 where id=$1', [extractionContext, otherProject]));
      const pendingFromUser = { ...fromUser, idempotency_key: uuid(), source: { ...fromUser.source, start: 4, end: 6, quote: '同源' } };
      assert.equal((await prepare(pendingFromUser)).supplemental.candidate_id,pending.candidate_id,'another view cannot replace the immutable first provenance');
      assert.equal((await call(native, 'clued_candidate_confirmation_issue_v1', { ...issueInput, candidate_id: pending.candidate_id })).error_code,'context_access_denied');
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
