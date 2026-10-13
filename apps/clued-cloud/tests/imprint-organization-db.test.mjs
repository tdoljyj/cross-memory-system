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
const uuid = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const claims = sub => ({ sub, role: 'authenticated', session_id: 'synthetic-imprint-session',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('Native Imprint: one identity, terminal metadata, isolated CAS, source and currentness',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-imprint-organization-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: uuid(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
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
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter(name => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const owner = uuid(), other = uuid(), project = uuid(), foreignProject = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'imprint-owner@example.invalid',now()),($2,'imprint-other@example.invalid',now())`, [owner, other]);
    for (const [id, user] of [[project, owner], [foreignProject, other]]) {
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
        values($1,$2,$3,$3,$4)`, [id, user, `project-${id}`, `project:${id}`]);
    }
    const actor = async (jwt = claims(owner)) => {
      const client = server.getPgClient(); clients.push(client); await client.connect();
      await client.query('set role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [jwt.sub ?? '', JSON.stringify(jwt)]);
      return client;
    };
    const human = await actor(), stranger = await actor(claims(other));
    const call = async (client, name, input, receivedHash) => (await client.query(
      `select public.${name}($1${receivedHash === undefined ? '' : ',$2'}) v`,
      receivedHash === undefined ? [JSON.stringify(input)] : [JSON.stringify(input), receivedHash])).rows[0].v;
    const read = input => call(human, 'clued_imprint_read_v1', input);
    const source = input => call(human, 'clued_imprint_source_v1', input);
    const set = (input, client = human) => call(client, 'clued_imprint_organization_set_v1', input, hash(JSON.stringify(input)));
    const put = async ({ user = owner, kind = 'note', scope = 'global', lifecycle = 'active',
      status = 'active', schema = 1, content = 'Full original Canonical text', typeFields = {}, relations = {} } = {}) => {
      const id = uuid();
      await admin.query(`insert into public.clued_memories
        (id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,
          lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
          confidence,confidence_reason,content_hash)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}','user_explicit',1,
          'Owner original words',$14)`,
      [id, user, `Original ${kind}`, content, scope.startsWith('project:') ? 'project' : 'global',
        scope.startsWith('project:') ? scope.slice(8) : null, kind, status, schema, lifecycle,
        schema ? scope : null, typeFields, relations, hash(content)]);
      return id;
    };
    const decision = await put({ kind: 'decision', typeFields: { rationale: 'Owner reason' } });
    const task = await put({ kind: 'task', scope: `project:${project}`, content: 'Long全文 unique needle saved source.',
      typeFields: { execution_bucket: 'later' }, relations: { related_decisions: [decision] } });
    const profile = await put({ kind: 'profile_fact', scope: 'profile', typeFields: { fact_kind: 'preference' } });
    const state = await put({ kind: 'state', typeFields: { state_kind: 'manual' } });
    const legacy = await put({ schema: null, lifecycle: null });
    const foreign = await put({ user: other });
    const wrongScope = await put({ scope: `project:${foreignProject}` });
    const unknown = await put({ kind: 'task', typeFields: { execution_bucket: 'later', projection_key: 'unbound-imprint-projection' } });
    const terminal = [];
    for (const [lifecycle, status] of [['completed', 'done'], ['cancelled', 'cancelled'], ['archived', 'archived'], ['superseded', 'superseded']]) {
      terminal.push(await put({ kind: lifecycle === 'superseded' ? 'decision' : 'task', lifecycle, status,
        typeFields: lifecycle === 'superseded' ? { rationale: 'Historical decision' } : { execution_bucket: 'later' } }));
    }
    const archivedNote = await put({ lifecycle: 'archived', status: 'archived' });
    const metadata = async (id, domains, version = 0, recordVersion = 1) => ({ record_id: id,
      record_version: recordVersion, base_version: version, domains, idempotency_key: `imprint:${uuid()}` });
    const snapshot = async () => {
      const result = {};
      for (const table of ['public.clued_memories', 'clued_private.scope_currentness_heads',
        'clued_private.projection_invalidation_heads', 'clued_private.event_truth_carriers',
        'clued_private.native_write_markers']) {
        result[table] = (await admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') v from ${table} t`)).rows[0].v;
      }
      return result;
    };
    const before = await snapshot();

    await t.test('closed labels preserve source, lifecycle, provenance and Currentness', async () => {
      for (const id of [task, decision, profile, legacy, archivedNote, ...terminal]) {
        const result = await set(await metadata(id, ['work', 'learning']));
        assert.equal(result.status, 'committed', JSON.stringify(result));
        assert.deepEqual(result.supplemental.organization, { record_id: id, domains: ['learning', 'work'], version: 1 });
        assert.deepEqual(Object.keys(result.committed_versions), [`imprint_organization:${id}`]);
      }
      assert.deepEqual(await snapshot(), before, 'labels must change zero canonical/currentness/confirmation rows');
      const events = (await admin.query(`select audit_visibility,canonical_event_type from public.clued_context_events
        where canonical_event_type='extension:imprint:organization_updated'`)).rows;
      assert.equal(events.length, 9);
      assert.ok(events.every(e => e.audit_visibility === 'audit_only'));
    });

    await t.test('independent metadata CAS, replay and same-source version fence', async () => {
      const input = await metadata(task, ['interest'], 1);
      const first = await set(input), replay = await set(input);
      assert.equal(first.status, 'committed'); assert.equal(replay.replayed, true);
      assert.equal(replay.receipt_id, first.receipt_id);
      assert.deepEqual(replay.supplemental, first.supplemental);
      assert.equal((await set(await metadata(task, ['daily'], 1))).error_code, 'organization_version_conflict');
      assert.equal((await set(await metadata(task, ['daily'], 2, 99))).error_code, 'record_version_conflict');
      const peer = await actor();
      const raced = await Promise.all([set(await metadata(task, ['daily'], 2)), set(await metadata(task, ['creation'], 2), peer)]);
      assert.equal(raced.filter(r => r.status === 'committed').length, 1);
      assert.equal(raced.filter(r => r.error_code === 'organization_version_conflict').length, 1);
      const identical = await metadata(state, ['daily']);
      const same = await Promise.all([set(identical), set({ ...identical,
        idempotency_key: ` ${identical.idempotency_key} ` }, peer)]);
      assert.equal(same[0].receipt_id, same[1].receipt_id);
      assert.equal(same.filter(r => r.replayed).length, 1);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('eight projections, AND-domain filters, paging, full bodies and uncertain reads', async () => {
      const history = await read({ include_history: true });
      assert.equal(history.status, 'ok');
      assert.equal(history.coverage.unlinked_intake_included, false);
      assert.equal(history.coverage.prior_body_revisions_available, false);
      assert.ok([profile, legacy, state, ...terminal].every(id => history.records.some(r => r.id === id)));
      assert.ok(!history.records.some(r => [foreign, wrongScope].includes(r.id)));
      assert.equal(history.records.find(r => r.id === archivedNote).record_currentness, 'HISTORY');
      const exact = await read({ id: task, include_history: true });
      assert.equal(exact.records[0].content, 'Long全文 unique needle saved source.');
      assert.deepEqual(exact.records[0].relations.related_decisions, [decision]);
      assert.equal(exact.records[0].authority, 'user_explicit');
      assert.equal(exact.records[0].confidence_reason, 'Owner original words');
      assert.equal(exact.records[0].version, 1);
      const filtered = await read({ view: 'work', domains: ['learning'], include_history: true, limit: 1 });
      assert.equal(filtered.records.length, 1);
      assert.ok(filtered.records[0].domains.includes('work') && filtered.records[0].domains.includes('learning'));
      assert.ok(filtered.page.next_cursor > 0);
      const ids = new Set(); let cursor = 0;
      for (;;) {
        const page = await read({ view: 'all', domains: ['learning'], include_history: true, limit: 2, cursor });
        for (const record of page.records) { assert.ok(!ids.has(record.id)); ids.add(record.id); }
        if (page.page.complete) break;
        cursor = page.page.next_cursor;
      }
      assert.equal(ids.size, 8); // task's labels changed in the CAS test; eight remain.
      assert.deepEqual((await read({ query: 'needle', scope: `project:${project}` })).records.map(r => r.id), [task]);
      for (const view of ['task', 'decision']) assert.ok((await read({ view, include_history: true })).records.every(r => r.record_type === view));
      const uncertain = await read({ id: unknown });
      assert.deepEqual(uncertain.records, []); assert.equal(uncertain.current_projection_unavailable, false);
      assert.equal(uncertain.read_semantics, 'qualified_saved_latest'); assert.equal(uncertain.selection_complete, false);
      assert.equal(uncertain.withheld_record_count, 1);
      const strict = await read({ view: 'task', id: unknown });
      assert.equal(strict.read_semantics, 'strict_current'); assert.equal(strict.current_projection_unavailable, true);
      assert.equal(strict.selection_complete, false);
      assert.equal((await read({ id: unknown, include_history: true })).records[0].record_currentness, 'UNKNOWN');
      await assert.rejects(read({ include_history: 'true' }), /imprint_read_input_invalid/);
      await assert.rejects(read({ domains: ['not-a-domain'] }), /imprint_domains_invalid/);
      await assert.rejects(read({ scope: `project:${foreignProject}` }), /imprint_scope_not_found/);
    });

    await t.test('All and domains include saved terminal latest objects without borrowing unrelated Global State failure', async () => {
      const all = await read({ view: 'all' });
      assert.ok(terminal.every(id => all.records.some(r => r.id === id)), 'completed/cancelled/archived/superseded latest are saved objects');
      assert.equal(all.records.find(r => r.id === archivedNote).record_currentness, 'HISTORY');
      assert.equal(all.records.find(r => r.id === archivedNote).authoritative, false);
      const domain = await read({ view: 'work', domains: ['learning'] });
      assert.ok(terminal.every(id => domain.records.some(r => r.id === id)));
      const independent = await put({ content: 'Independent readable note beside an unknown State' });
      const unknownState = await put({ kind: 'state', typeFields: { state_kind: 'manual', projection_key: 'unbound-native-state' } });
      const headExisted = (await admin.query(`select exists(select 1 from clued_private.projection_invalidation_heads
        where user_id=$1 and target_scope='global' and projection_key='global.priority_frontier') v`, [owner])).rows[0].v;
      await admin.query(`insert into clued_private.projection_invalidation_heads
        (user_id,target_scope,projection_key,invalidation_revision) values($1,'global','global.priority_frontier',1)
        on conflict(user_id,target_scope,projection_key) do nothing`, [owner]);
      try {
        const gate = (await admin.query(`select clued_private.record_list_core($1,
          '{"level":"global","record_type":"state","limit":1}'::jsonb,null::text[]) v`, [owner])).rows[0].v;
        assert.equal(gate.current_projection_unavailable, true, 'the original Global aggregate really is unavailable');
        const exact = await read({ id: independent });
        assert.deepEqual(exact.records.map(r => r.id), [independent]);
        assert.equal(exact.read_semantics, 'qualified_saved_latest'); assert.equal(exact.selection_complete, true);
        assert.equal(exact.current_projection_unavailable, false); assert.equal(exact.projection_rebuild_required, false);
        const partial = await read({ scope: 'global' });
        assert.ok(partial.records.some(r => r.id === independent)); assert.ok(!partial.records.some(r => r.id === unknownState));
        assert.equal(partial.current_projection_unavailable, false); assert.equal(partial.selection_complete, false);
        assert.ok(partial.withheld_record_count >= 1);
        const strict = await read({ view: 'task', id: unknown });
        assert.equal(strict.current_projection_unavailable, true); assert.equal(strict.selection_complete, false);
      } finally {
        if (!headExisted) await admin.query(`delete from clued_private.projection_invalidation_heads
          where user_id=$1 and target_scope='global' and projection_key='global.priority_frontier'`, [owner]);
      }
    });

    await t.test('direct Native tenancy and privilege isolation', async () => {
      assert.deepEqual((await call(stranger, 'clued_imprint_read_v1', { id: task, include_history: true })).records, []);
      assert.equal((await set(await metadata(foreign, ['daily']))).error_code, 'record_not_found');
      assert.equal((await set(await metadata(wrongScope, ['daily']))).error_code, 'record_not_found');
      const delegated = await actor({ ...claims(owner), client_id: 'delegated-oauth-client' });
      for (const [name, input, digest] of [['clued_imprint_read_v1', {}],
        ['clued_imprint_organization_set_v1', await metadata(task, ['work'], 3), 'a'.repeat(64)],
        ['clued_imprint_source_v1', { record_id: task, evidence_id: uuid() }]]) {
        await assert.rejects(call(delegated, name, input, digest), /direct_human_session_required/);
      }
      const absent = await actor({ role: 'authenticated' });
      await assert.rejects(call(absent, 'clued_imprint_read_v1', {}), /direct_human_session_required/);
      await assert.rejects(set({ ...(await metadata(task, ['work'], 3)), content: 'overwrite' }), /imprint_organization_input_invalid/);
      await assert.rejects(call(human, 'clued_imprint_organization_set_v1', await metadata(task, ['work'], 3), 'wrong'), /imprint_organization_input_invalid/);
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        for (const signature of ['public.clued_imprint_read_v1(jsonb)', 'public.clued_imprint_organization_set_v1(jsonb,text)',
          'public.clued_imprint_source_v1(jsonb)']) {
          assert.equal((await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') v", [role, signature])).rows[0].v,
            role === 'authenticated', `${role} ${signature}`);
        }
        assert.equal((await admin.query("select has_table_privilege($1,'clued_private.imprint_organization_v1','select,insert,update,delete') v", [role])).rows[0].v, false);
      }
      assert.equal((await admin.query("select relrowsecurity from pg_class where oid='clued_private.imprint_organization_v1'::regclass")).rows[0].relrowsecurity, true);
    });

    await t.test('shared active-carrier reasons are preserved without treating a withheld view as empty', async () => {
      const blockedTask = await put({ kind: 'task', typeFields: { execution_bucket: 'later' } });
      const event = (await admin.query(`insert into public.clued_context_events
        (user_id,context_key,event_type,payload) values($1,'global','blocker','{"title":"Synthetic unresolved blocker"}') returning id`, [owner])).rows[0].id;
      await admin.query(`insert into clued_private.event_truth_carriers
        (event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
        values($1,$2,'global',array['task'],'work_log','direct','ACTIVE_UNSTRUCTURED',1)`, [event, owner]);
      const blocked = await read({ id: blockedTask, view: 'task' });
      assert.deepEqual(blocked.records, []); assert.equal(blocked.current_projection_unavailable, true);
      assert.equal(blocked.withheld_record_count, 1);
      assert.ok(JSON.stringify(blocked.withheld_by_active_events).includes('Synthetic unresolved blocker'));
      const diagnostic = await read({ id: blockedTask, include_history: true });
      assert.equal(diagnostic.records[0].record_currentness, 'SHADOWED_BY_ACTIVE_EVENT');
      assert.equal(diagnostic.records[0].authoritative, false);
      const stable = await snapshot();
      assert.equal((await set(await metadata(blockedTask, ['work']))).status, 'committed');
      assert.deepEqual(await snapshot(), stable, 'metadata must not retire or change the active truth carrier');
    });

    await t.test('linked original segments verify ownership and hashes; external locators stay unavailable', async sourceTest => {
      const record = await put(), evidence = uuid(), submission = uuid();
      const segment = { schema_version: 'segment_input.v1', segment_id: 'synthetic-segment', reference_time: new Date().toISOString(), timezone: 'Asia/Shanghai',
        messages: [{ message_id: 'm1', evidence_id: 'e1', author_role: 'user', created_at: new Date().toISOString(),
          context_only: false, content: '用户原文。 No inference becomes source text.' }] };
      const digest = (await admin.query('select clued_private.m1_sha256($1::jsonb) v', [JSON.stringify(segment)])).rows[0].v;
      const receipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type)
        values($1,'fixture','fixture','fixture') returning id`, [owner])).rows[0].id;
      await admin.query(`insert into public.clued_evidence(id,user_id,evidence_schema_version,evidence_type,storage_ref,content_hash,receipt_id)
        values($1,$2,1,'file',$3,$4,$5)`, [evidence, owner, `intake:${submission}`, digest, receipt]);
      await admin.query(`insert into clued_private.information_intake_submissions
        (id,user_id,scope,source_kind,segment,segment_sha256,input_digest,evidence_id,receipt_id,idempotency_key)
        values($1,$2,'global','native_ui',$3,$4,$4,$5,$6,$7)`, [submission, owner, segment, digest, evidence, receipt, uuid()]);
      await admin.query('update public.clued_memories set source_refs=array[$2::uuid] where id=$1', [record, evidence]);
      const input = { record_id: record, evidence_id: evidence };
      const captured = await source(input);
      assert.equal(captured.available, true); assert.deepEqual(captured.segment, segment);
      assert.equal(captured.content, segment.messages[0].content); assert.equal(captured.authoritative, false);
      assert.equal(captured.record_version, 1);
      const mutate = { operation: 'update', record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope: 'global', id: record, base_version: 1,
        idempotency_key: `imprint-source-version:${uuid()}`, authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Synthetic Owner source update', mutation: { content: 'Changed source record body', type_fields: { note_kind: 'log' } } };
      const changed = await call(human, 'clued_user_record_mutate', mutate, hash(JSON.stringify(mutate)));
      assert.equal(changed.status, 'committed', JSON.stringify(changed));
      const stale = await source({ ...input, record_version: 1 });
      assert.equal(stale.available, false); assert.equal(stale.unavailable_reason, 'stale_record_version');
      assert.equal(stale.record_version, 2);
      for (const key of ['evidence', 'content', 'segment']) assert.equal(key in stale, false);
      assert.equal((await source({ ...input, record_version: 2 })).available, true);
      assert.equal((await source(input)).record_version, 2, 'omitted version remains a latest read');
      for (const record_version of ['1', 0, 1.5, 9007199254740992]) {
        await assert.rejects(source({ ...input, record_version }), /imprint_source_input_invalid/);
      }
      assert.equal((await source({ record_id: task, evidence_id: evidence })).error_code, 'source_not_found');
      assert.equal((await call(stranger, 'clued_imprint_source_v1', input)).error_code, 'source_not_found');
      await admin.query("update public.clued_evidence set content_hash=repeat('0',64) where id=$1", [evidence]);
      assert.equal((await source(input)).error_code, 'source_hash_mismatch');
      await admin.query("update public.clued_evidence set storage_ref='https://example.invalid/private-original' where id=$1", [evidence]);
      const external = await source(input); assert.equal(external.available, false);
      assert.equal(external.unavailable_reason, 'external_source_content_not_stored');
      assert.equal('content' in external, false); assert.equal(external.evidence.storage_ref, 'https://example.invalid/private-original');
      await admin.query('update public.clued_evidence set storage_ref=$2,content_hash=$3 where id=$1',
        [evidence, `intake:${submission}`, digest]);
      const issued = await call(human, 'clued_evidence_withdrawal_confirmation_issue_v1',
        { evidence_id: evidence, base_version: 0, reason: 'Synthetic source withdrawal' });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      const withdrawal = { idempotency_key: `imprint-withdraw:${uuid()}`, evidence_id: evidence,
        base_version: 0, confirmation_token: issued.confirmation_token, view_digest: issued.view_digest };
      const withdrawn = await call(human, 'clued_evidence_withdraw_v1', withdrawal, hash(JSON.stringify(withdrawal)));
      assert.equal(withdrawn.status, 'committed', JSON.stringify(withdrawn));
      const noCurrentSource = await source(input);
      assert.equal(noCurrentSource.available, false); assert.equal(noCurrentSource.unavailable_reason, 'evidence_withdrawn');
      assert.equal('segment' in noCurrentSource, false); assert.equal('content' in noCurrentSource, false);
      const historicalSource = await source({ ...input, include_history: true });
      assert.equal(historicalSource.available, true); assert.deepEqual(historicalSource.segment, segment);
      assert.equal(historicalSource.evidence_status, 'withdrawn');
      assert.equal(historicalSource.source_semantics, 'historical_evidence');
      assert.equal(historicalSource.authoritative, false); assert.equal(historicalSource.current_input_eligible, false);
      await assert.rejects(source({ ...input, include_history: 'true' }), /imprint_source_input_invalid/);
      await sourceTest.test('isolation never becomes history, source access or an observable hidden count', async () => {
        const originalDefinition = (await admin.query("select pg_get_functiondef('clued_private.record_currentness_fence(uuid,uuid,text[])'::regprocedure) v")).rows[0].v;
        // The deployed core has no ISOLATED code today. Substitute exact synthetic
        // IDs at this boundary to verify fail-closed future/currentness denials.
        await admin.query(originalDefinition.replace('clued_private.record_currentness_fence(', 'clued_private.imprint_fixture_original_fence('));
        await admin.query(`create or replace function clued_private.record_currentness_fence(
          p_user_id uuid,p_record_id uuid,p_authorized_scopes text[])
          returns text language plpgsql stable security definer set search_path='' as $$
          begin
            if $2='${record}'::uuid then return 'ISOLATED'; end if;
            if $2='${terminal[0]}'::uuid then return 'NOT_AUTHORIZED'; end if;
            return clued_private.imprint_fixture_original_fence($1,$2,$3);
          end $$`);
        try {
          for (const id of [record, terminal[0]]) {
            for (const include_history of [false, true]) {
              const blocked = await read({ id, include_history });
              assert.deepEqual(blocked.records, []); assert.equal(blocked.withheld_record_count, 0);
              assert.equal(blocked.page.next_cursor, null); assert.equal(blocked.page.complete, true);
            }
            assert.equal((await set(await metadata(id, ['work'], id === record ? 0 : 1))).error_code, 'record_not_found');
          }
          assert.equal((await source(input)).error_code, 'source_not_found');
        } finally {
          await admin.query(originalDefinition);
          await admin.query('drop function clued_private.imprint_fixture_original_fence(uuid,uuid,text[])');
        }
      });
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
