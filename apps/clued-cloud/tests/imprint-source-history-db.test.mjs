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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve)); return port;
}
const jwt = sub => ({ sub, role: 'authenticated', session_id: 'isolated-source-history',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });

test('Native source/history search: real revisions, exact qualifications, full match before pagination',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-imprint-source-history-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: uuid(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const owner = uuid(), other = uuid(), project = uuid(), foreignProject = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'history-owner@example.invalid',now()),($2,'history-other@example.invalid',now())`, [owner, other]);
    async function actor(user = owner, extras = {}, role = 'authenticated') {
      const db = server.getPgClient(); clients.push(db); await db.connect();
      await db.query("set statement_timeout='30s'; set lock_timeout='10s'");
      await db.query('set role ' + role);
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [user, JSON.stringify({ ...jwt(user), ...extras })]); return db;
    }
    const human = await actor(), stranger = await actor(other), second = await actor();
    const call = async (name, input, client = human, writing = false) => (await client.query(
      `select public.${name}($1${writing ? ',$2' : ''}) v`,
      writing ? [JSON.stringify(input), hash(JSON.stringify(input))] : [JSON.stringify(input)])).rows[0].v;
    const read = (input = {}, client = human) => call('clued_imprint_read_v1', input, client);
    const src = (input, client = human) => call('clued_imprint_source_v1', input, client);
    const revision = (input, client = human) => call('clued_imprint_revision_read_v1', input, client);
    for (const [id, client] of [[project, human], [foreignProject, stranger]]) {
      const input = { operation: 'create', project_schema_version: 2, canonical_project_id: id,
        idempotency_key: uuid(), mutation: { name: 'Synthetic history project ' + id, progress_status: 'active' } };
      const created = await call('clued_user_project_mutate_v2', input, client, true);
      assert.equal(created.status, 'committed', JSON.stringify(created));
    }
    async function create(content = 'original body', scope = 'global', extra = {}) {
      const input = { operation: 'create', id: uuid(), record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope, idempotency_key: 'history-create:' + uuid(), authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Isolated synthetic owner write', source_refs: [],
        source_unavailable_reason: 'Isolated synthetic record', mutation: { title: 'Synthetic source history', content,
          type_fields: { note_kind: 'log' } }, ...extra };
      const result = await call('clued_user_record_mutate', input, human, true);
      assert.equal(result.status, 'committed', JSON.stringify(result)); return input.id;
    }
    async function change(id, version, content, extra = {}, client = human) {
      const input = { operation: 'update', id, record_type: 'note', record_schema_version: 1, base_version: version,
        lifecycle_status: 'active', scope: 'global', idempotency_key: 'history-update:' + uuid(), authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Isolated synthetic owner update',
        mutation: { content }, ...extra };
      return call('clued_user_record_mutate', input, client, true);
    }
    const histories = async id => (await admin.query('select * from clued_private.imprint_record_history_v1 where record_id=$1 order by version', [id])).rows;
    const current = async id => (await admin.query('select to_jsonb(m) v from public.clued_memories m where id=$1', [id])).rows[0].v;
    const bare = value => { const copy = { ...value }; delete copy.user_id; return copy; };
    const original = '最初绿色方案 %_😀，只存在第一版。 ' + '甲'.repeat(1500) + '尾部完整匹配字样';
    const id = await create(original); let version = 1;

    await t.test('create and ordinary labels retain existing behavior, without an invented prior snapshot', async () => {
      assert.equal((await histories(id)).length, 0);
      assert.equal((await read({ id })).records[0].content, original);
      assert.equal((await read({ query: '绿色方案' })).records[0].id, id);
      const before = await current(id);
      const changed = await change(id, version, '现在采用蓝色，正文完整。');
      assert.equal(changed.status, 'committed', JSON.stringify(changed)); version++;
      const h = await histories(id);
      assert.equal(h.length, 1); assert.deepEqual(h[0].envelope, bare(before));
      assert.equal(Number(h[0].version), 1);
      const sha = (await admin.query('select clued_private.m1_sha256($1::jsonb) v', [h[0].envelope])).rows[0].v;
      assert.equal(h[0].envelope_sha256, sha);
      assert.equal((await current(id)).content_hash, changed.supplemental.record.content_hash);
      await admin.query('update public.clued_memories set content_hash=content_hash where id=$1', [id]);
      assert.equal((await histories(id)).length, 1, 'same-version hash refresh is not a historical body');
    });
    await t.test('history-only matches preserve latest body, exact old version, literal Unicode and tails', async () => {
      assert.equal((await read({ query: '绿色方案' })).records.length, 0);
      for (const query of ['绿色方案', '%_', '😀', '尾部完整匹配字样']) {
        const result = await read({ query, include_history: true, limit: 1 });
        assert.equal(result.records.length, 1);
        const row = result.records[0]; assert.equal(row.id, id); assert.equal(row.version, version);
        assert.equal(row.content, '现在采用蓝色，正文完整。');
        assert.equal(row.authoritative, false); assert.equal(row.matched_revision_count, 1);
        assert.equal(row.matched_revisions[0].matched_record_version, 1);
        assert.equal(row.matched_revisions[0].record_currentness, 'HISTORY');
        assert.equal(row.matched_revisions[0].authoritative, false);
        assert.equal(row.matched_revisions[0].full_body_included, false);
        assert.ok([...row.matched_revisions[0].snippet].length <= 240);
      }
      const full = await revision({ record_id: id, record_version: version, historical_record_version: 1, scope: 'global' });
      assert.equal(full.available, true); assert.equal(full.complete, true); assert.equal(full.record.content, original);
      assert.equal(full.authoritative, false); assert.equal(full.current_input_eligible, false);
    });
    await t.test('same transaction advances capture final OLD rows; rollback leaves no history or effects', async () => {
      await human.query('begin');
      const v2 = await current(id);
      const third = await change(id, version, '第三版真实正文');
      assert.equal(third.status, 'committed'); version++;
      const v3 = third.supplemental.record;
      assert.equal((await change(id, version, '第四版真实正文')).status, 'committed'); version++;
      await human.query('commit');
      const h = await histories(id); assert.deepEqual(h.map(row => Number(row.version)), [1, 2, 3]);
      assert.deepEqual(h[1].envelope, bare(v2));
      assert.deepEqual(h[2].envelope, bare(v3), 'the captured row includes the final same-version hash refresh');
      const before = await current(id), count = h.length;
      await human.query('begin'); assert.equal((await change(id, version, '回滚后不可见')).status, 'committed');
      await human.query('rollback'); assert.deepEqual(await current(id), before);
      assert.equal((await histories(id)).length, count);
    });
    await t.test('concurrent real CAS and replay never invent an extra retained version', async () => {
      const outcomes = await Promise.all([change(id, version, '并发胜者一'), change(id, version, '并发胜者二', {}, second)]);
      assert.equal(outcomes.filter(row => row.status === 'committed').length, 1);
      assert.equal(outcomes.filter(row => row.status === 'rejected').length, 1); version++;
      assert.equal((await histories(id)).length, version - 1);
    });

    async function evidence(record, text, evidenceOwner = owner, scope = 'global') {
      const evidenceId = uuid(), submission = uuid();
      const segment = { schema_version: 'segment_input.v1', segment_id: 'history-fixture', reference_time: new Date().toISOString(),
        timezone: 'Asia/Shanghai', messages: [{ message_id: '1', evidence_id: '1', author_role: 'user',
          created_at: new Date().toISOString(), context_only: false, content: text }] };
      const digest = (await admin.query('select clued_private.m1_sha256($1::jsonb) v', [JSON.stringify(segment)])).rows[0].v;
      const receipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type)
        values($1,'fixture','fixture','fixture') returning id`, [evidenceOwner])).rows[0].id;
      await admin.query(`insert into public.clued_evidence(id,user_id,evidence_schema_version,evidence_type,storage_ref,content_hash,receipt_id)
        values($1,$2,1,'file',$3,$4,$5)`, [evidenceId, evidenceOwner, 'intake:' + submission, digest, receipt]);
      await admin.query(`insert into clued_private.information_intake_submissions
        (id,user_id,scope,source_kind,segment,segment_sha256,input_digest,evidence_id,receipt_id,idempotency_key)
        values($1,$2,$3,'native_ui',$4,$5,$5,$6,$7,$8)`,
      [submission, evidenceOwner, scope, segment, digest, evidenceId, receipt, uuid()]);
      await admin.query('update public.clued_memories set source_refs=array[$2::uuid] where id=$1', [record, evidenceId]);
      return { id: evidenceId, submission, digest, segment };
    }
    const sourceRecord = await create('最新正文不含来源独有词');
    const sourceText = '源'.repeat(1800) + '来源OnlyNeedle %_😀 真实原话';
    const e = await evidence(sourceRecord, sourceText);
    let sourceVersion = 1;
    await t.test('source-only match searches complete qualified intake before LIMIT', async () => {
      const result = await read({ query: '来源OnlyNeedle', limit: 1 });
      assert.equal(result.records.length, 1); assert.equal(result.records[0].id, sourceRecord);
      assert.equal(result.records[0].match_source, 'linked_source');
      assert.equal(result.records[0].matched_source_count, 1);
      const hit = result.records[0].matched_sources[0];
      assert.equal(hit.evidence_id, e.id); assert.equal(hit.record_version, 1);
      assert.ok(hit.snippet.includes('来源OnlyNeedle')); assert.ok([...hit.snippet].length <= 240);
      assert.equal(hit.authoritative, false); assert.equal(hit.current_input_eligible, false);
      assert.equal((await src({ record_id: sourceRecord, record_version: 1, evidence_id: e.id })).content, sourceText);
      const bound = await src({ record_id: sourceRecord, record_version: 1, evidence_id: e.id });
      assert.equal(bound.record_id, sourceRecord); assert.equal(bound.evidence.id, e.id); assert.equal(bound.complete, true);
      assert.equal((await read({ query: '%_', include_history: true })).records.some(row => row.id === sourceRecord), true);
    });
    await t.test('unlinked old source needs explicit old version AND current-card fence', async () => {
      assert.equal((await change(sourceRecord, 1, '第二版移除来源', { source_refs: [] })).status, 'committed');
      sourceVersion = 2;
      assert.equal((await read({ query: '来源OnlyNeedle' })).records.length, 0);
      const historical = await read({ query: '来源OnlyNeedle', include_history: true });
      assert.equal(historical.records[0].matched_sources[0].historical_record_version, 1);
      const input = { record_id: sourceRecord, record_version: 2, historical_record_version: 1, include_history: true, evidence_id: e.id };
      const actual = await src(input); assert.equal(actual.available, true); assert.equal(actual.content, sourceText);
      assert.equal(actual.record_version, 2); assert.equal(actual.source_record_version, 1);
      assert.equal(actual.source_semantics, 'historical_evidence'); assert.equal(actual.authoritative, false);
      for (const extra of [{ record_version: 1, historical_record_version: undefined }]) {
        const stale = await src({ ...input, ...extra });
        assert.equal(stale.available, false); assert.equal(stale.unavailable_reason, 'stale_record_version');
        for (const key of ['content', 'segment', 'evidence']) assert.equal(key in stale, false);
      }
      await assert.rejects(src({ ...input, include_history: false }), /imprint_source_input_invalid/);
      const wrong = await src({ ...input, evidence_id: uuid() }); assert.equal(wrong.error_code, 'source_not_found');
      const old = await revision({ record_id: sourceRecord, record_version: 2, historical_record_version: 1, scope: 'global' });
      assert.equal(old.record.content, '最新正文不含来源独有词');
      assert.equal((await change(sourceRecord, 2, '第三版当前正文')).status, 'committed'); sourceVersion = 3;
      const staleHistoricalCard = await src(input);
      assert.equal(staleHistoricalCard.unavailable_reason, 'stale_record_version');
      for (const key of ['content', 'segment', 'evidence']) assert.equal(key in staleHistoricalCard, false);
    });
    await t.test('hash disagreement fails closed, not an empty successful search', async () => {
      await admin.query("update public.clued_evidence set content_hash=repeat('0',64) where id=$1", [e.id]);
      assert.equal((await src({ record_id: sourceRecord, record_version: sourceVersion, historical_record_version: 1, include_history: true, evidence_id: e.id })).error_code,
        'source_hash_mismatch');
      await assert.rejects(read({ query: '来源OnlyNeedle', include_history: true }), /imprint_source_integrity_unavailable/);
      await admin.query('update public.clued_evidence set content_hash=$2 where id=$1', [e.id, e.digest]);
    });
    await t.test('foreign owner, foreign scope, OAuth and private tables/functions supply no read path', async () => {
      assert.deepEqual((await read({ id, include_history: true }, stranger)).records, []);
      assert.equal((await revision({ record_id: id, record_version: version, historical_record_version: 1, scope: 'global' }, stranger)).available, false);
      await assert.rejects(read({ scope: 'project:' + foreignProject, query: '绿色方案', include_history: true }), /imprint_scope_not_found/);
      const oauth = await actor(owner, { client_id: 'synthetic-oauth' });
      await assert.rejects(revision({ record_id: id, record_version: version, historical_record_version: 1, scope: 'global' }, oauth), /direct_human_session_required/);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        if (!(await admin.query('select exists(select 1 from pg_roles where rolname=$1) yes', [role])).rows[0].yes) continue;
        const permissions = (await admin.query(`select has_table_privilege($1,'clued_private.imprint_record_history_v1','select') s,
          has_table_privilege($1,'clued_private.imprint_record_history_v1','insert') i,
          has_function_privilege($1,'clued_private.imprint_history_capture_v1()','execute') e,
          has_function_privilege($1,'public.clued_imprint_revision_read_v1(jsonb)','execute') r`, [role])).rows[0];
        assert.deepEqual([permissions.s, permissions.i, permissions.e], [false, false, false]);
        assert.equal(permissions.r, role === 'authenticated');
      }
    });
    await t.test('exact totals and truncation follow full matching, while one identity remains one result', async () => {
      const many = await create('boundedRevisionNeedle v1');
      for (let v = 1; v <= 23; v++) {
        await admin.query('update public.clued_memories set version=version+1,content=$2,updated_at=now() where id=$1',
          [many, 'boundedRevisionNeedle v' + (v + 1)]);
      }
      const result = await read({ query: 'boundedRevisionNeedle', include_history: true, limit: 1 });
      assert.equal(result.records.length, 1); assert.equal(result.records[0].id, many);
      assert.equal(result.records[0].matched_revision_count, 23);
      assert.equal(result.records[0].matched_revisions.length, 20); assert.equal(result.records[0].matched_revisions_truncated, true);
      assert.equal(result.page.complete, true); assert.equal(result.page.next_cursor, null);
    });
    await t.test('over-limit stored body is matched in full but never returned as a fake complete body', async () => {
      const huge = await create('oversize initial');
      await admin.query("update public.clued_memories set content=$2,relations=jsonb_build_object('fixture_padding',repeat('界',50000)) where id=$1",
        [huge, '界'.repeat(7000) + 'oversizeTailNeedle']);
      await admin.query("update public.clued_memories set version=version+1,content='small current' where id=$1", [huge]);
      const result = await read({ query: 'oversizeTailNeedle', include_history: true });
      assert.equal(result.records[0].id, huge);
      assert.ok(result.records[0].matched_revisions[0].snippet.includes('oversizeTailNeedle'));
      const full = await revision({ record_id: huge, record_version: 2, historical_record_version: 1, scope: 'global' });
      assert.equal(full.available, false); assert.equal(full.complete, false);
      assert.equal(full.unavailable_reason, 'revision_content_exceeds_read_limit'); assert.equal('record' in full, false);
    });
    await t.test('trusted frequent projections are excluded, but caller projection labels cannot suppress real history', async () => {
      const forged = await create('forged projection old body', 'global', {
        mutation: { title: 'User-authored projection label', content: 'forged projection old body',
          type_fields: { note_kind: 'log', projection_key: 'global.priority_frontier' } },
      });
      await admin.query("update public.clued_memories set version=version+1,content='new user body' where id=$1", [forged]);
      assert.equal((await histories(forged)).length, 1);
      for (const key of ['global.priority_frontier', 'global.__aggregate__']) {
        const derived = await create('trusted derived old body');
        await admin.query(`insert into clued_private.projection_record_bindings
          (record_id,user_id,target_scope,projection_key,projection_owner) values($1,$2,'global',$3,'synthetic-existing-builder')`,
          [derived, owner, key]);
        await admin.query("update public.clued_memories set version=version+1,content='trusted refreshed body' where id=$1", [derived]);
        assert.equal((await histories(derived)).length, 0, 'trusted builder history must not amplify every refresh');
      }
    });
    await t.test('history integrity and identity collisions fail closed and preserve the original source transaction', async () => {
      const target = await create('integrityOldNeedle'); await change(target, 1, 'integrity latest');
      await assert.rejects(admin.query("update clued_private.imprint_record_history_v1 set scope=scope where record_id=$1", [target]),
        /imprint_history_immutable/);
      const originalHash = (await histories(target))[0].envelope_sha256;
      await admin.query('begin');
      try {
        await admin.query('alter table clued_private.imprint_record_history_v1 disable trigger imprint_history_immutable_v1');
        await admin.query("update clued_private.imprint_record_history_v1 set envelope_sha256=repeat('0',64) where record_id=$1", [target]);
        await admin.query('alter table clued_private.imprint_record_history_v1 enable trigger imprint_history_immutable_v1');
        await admin.query('commit');
        await assert.rejects(revision({ record_id: target, record_version: 2, historical_record_version: 1, scope: 'global' }),
          /imprint_history_integrity_unavailable/);
        await assert.rejects(read({ query: 'integrityOldNeedle', include_history: true }), /imprint_history_integrity_unavailable/);
      } finally {
        await admin.query('rollback'); await admin.query('begin');
        await admin.query('alter table clued_private.imprint_record_history_v1 disable trigger imprint_history_immutable_v1');
        await admin.query('update clued_private.imprint_record_history_v1 set envelope_sha256=$2 where record_id=$1', [target, originalHash]);
        await admin.query('alter table clued_private.imprint_record_history_v1 enable trigger imprint_history_immutable_v1');
        await admin.query('commit');
      }
      // Deliberately pre-seed a conflicting prior identity as a superuser fixture.
      const conflict = await create('conflict source original'), before = await current(conflict);
      const envelope = { ...bare(before), content: 'different same-version body' };
      await admin.query(`insert into clued_private.imprint_record_history_v1(user_id,record_id,version,scope,envelope,envelope_sha256)
        values($1,$2,1,'global',$3,clued_private.m1_sha256($3::jsonb))`, [owner, conflict, envelope]);
      await assert.rejects(admin.query("update public.clued_memories set version=version+1,content='must rollback' where id=$1", [conflict]),
        /imprint_history_identity_conflict/);
      assert.deepEqual(await current(conflict), before);
      await admin.query('delete from clued_private.imprint_record_history_v1 where record_id=$1', [conflict]);
      const exact = bare(before);
      await admin.query(`insert into clued_private.imprint_record_history_v1(user_id,record_id,version,scope,envelope,envelope_sha256)
        values($1,$2,1,'global',$3,clued_private.m1_sha256($3::jsonb))`, [owner, conflict, exact]);
      await admin.query("update public.clued_memories set version=version+1,content='successful equal snapshot replay' where id=$1", [conflict]);
      assert.equal((await histories(conflict)).length, 1);
    });
    await t.test('actual close, explicit restore and replay retain real lifecycle versions without reopening on read', async () => {
      const target = await create('LifecycleHistoryNeedle', 'global', { record_type: 'task',
        mutation: { title: 'Lifecycle synthetic task', content: 'LifecycleHistoryNeedle', type_fields: { execution_bucket: 'later' } } });
      const base = { id: target, record_type: 'task', record_schema_version: 1, scope: 'global', authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Isolated explicit lifecycle regression' };
      const closeInput = { ...base, operation: 'close', base_version: 1, lifecycle_status: 'completed',
        idempotency_key: uuid(), mutation: { closed_reason: 'Synthetic completion' } };
      const closed = await call('clued_user_record_mutate', closeInput, human, true);
      assert.equal(closed.status, 'committed', JSON.stringify(closed));
      const terminalBefore = await current(target);
      const old = await revision({ record_id: target, record_version: 2, historical_record_version: 1, scope: 'global' });
      assert.equal(old.available, true); assert.equal(old.record.lifecycle_status, 'active');
      assert.deepEqual(await current(target), terminalBefore, 'reading never restores the task');
      const restoreInput = { ...base, operation: 'restore', base_version: 2, lifecycle_status: 'active',
        reopen_reason: 'Explicit synthetic Owner restore', terminal_receipt_id: closed.receipt_id,
        idempotency_key: uuid(), mutation: {} };
      const restored = await call('clued_user_record_mutate', restoreInput, human, true);
      assert.equal(restored.status, 'committed', JSON.stringify(restored));
      const replayed = await call('clued_user_record_mutate', restoreInput, human, true);
      assert.equal(replayed.receipt_id, restored.receipt_id); assert.equal(replayed.replayed, true);
      const retained = await histories(target); assert.equal(retained.length, 2);
      assert.equal(retained[1].envelope.lifecycle_status, 'completed');
      assert.equal((await current(target)).version, 3);
    });
    await t.test('actual decision supersede keeps the source and replacement as distinct identities', async () => {
      const target = await create('DecisionHistoricalNeedle', 'global', { record_type: 'decision',
        mutation: { title: 'Original synthetic decision', content: 'DecisionHistoricalNeedle', type_fields: { rationale: 'Original reason' } } });
      const input = { source_decisions: [{ id: target, base_version: 1 }], supersede_reason: 'Synthetic replacement', idempotency_key: uuid(),
        replacement: { record_schema_version: 1, scope: 'global', title: 'Synthetic replacement', content: 'New accepted conclusion',
          type_fields: { rationale: 'Explicit changed reason' }, relations: { supersedes: [target] }, source_refs: [],
          source_unavailable_reason: 'Synthetic regression', authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Isolated Owner' } };
      const result = await call('clued_user_decision_supersede', input, human, true);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      const latest = await current(target); assert.equal(latest.lifecycle_status, 'superseded'); assert.equal(latest.version, 2);
      const prior = await revision({ record_id: target, record_version: 2, historical_record_version: 1, scope: 'global' });
      assert.equal(prior.record.content, 'DecisionHistoricalNeedle'); assert.equal(prior.record.lifecycle_status, 'active');
      assert.equal(prior.authoritative, false);
      const replacementId = result.target_refs.find(ref => ref.role === 'target').id;
      assert.notEqual(replacementId, target); assert.equal((await histories(replacementId)).length, 0);
    });
    await t.test('withdrawn and invalidated sources match only explicit history, while foreign and external sources never supply snippets', async () => {
      const target = await create('Source qualification parent'), linked = await evidence(target, 'WithdrawalSearchNeedle');
      const issued = await call('clued_evidence_withdrawal_confirmation_issue_v1',
        { evidence_id: linked.id, base_version: 0, reason: 'Isolated source qualification regression' });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      const withdrawn = await call('clued_evidence_withdraw_v1', { idempotency_key: uuid(), evidence_id: linked.id, base_version: 0,
        confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, human, true);
      assert.equal(withdrawn.status, 'committed', JSON.stringify(withdrawn));
      assert.deepEqual((await read({ query: 'WithdrawalSearchNeedle' })).records, []);
      const hit = (await read({ query: 'WithdrawalSearchNeedle', include_history: true })).records[0].matched_sources[0];
      assert.equal(hit.evidence_status, 'withdrawn'); assert.equal(hit.authoritative, false);
      const foreignTarget = await create('Foreign linked parent');
      const foreign = await evidence(foreignTarget, 'ForeignSourceSecretNeedle', other);
      const externalTarget = await create('External linked parent'), external = await evidence(externalTarget, 'ExternalOnlyNeedle');
      await admin.query("update public.clued_evidence set storage_ref='https://example.invalid/ExternalOnlyNeedle' where id=$1", [external.id]);
      for (const query of ['ForeignSourceSecretNeedle', 'ExternalOnlyNeedle']) {
        const result = await read({ query, include_history: true });
        assert.deepEqual(result.records, []); assert.equal(result.withheld_record_count, 0);
        assert.equal(result.page.complete, true); assert.equal(result.page.next_cursor, null);
      }
      assert.equal((await src({ record_id: foreignTarget, evidence_id: foreign.id })).error_code, 'source_not_found');
      assert.equal((await src({ record_id: externalTarget, evidence_id: external.id })).available, false);
      const invalidTarget = await create('Invalidated source parent'), invalid = await evidence(invalidTarget, 'InvalidatedSearchNeedle');
      // Reuse the actual private flag row from the real withdrawal above.
      const withdrawalId = (await admin.query('select id from clued_private.evidence_withdrawals where evidence_id=$1', [linked.id])).rows[0].id;
      await admin.query(`insert into clued_private.record_evidence_status
        (user_id,record_id,record_version,evidence_id,withdrawal_id,flagged_by)
        values($1,$2,1,$3,$4,'record_write')`, [owner, invalidTarget, invalid.id, withdrawalId]);
      assert.deepEqual((await read({ query: 'InvalidatedSearchNeedle' })).records, []);
      const invalidHit = (await read({ query: 'InvalidatedSearchNeedle', include_history: true })).records[0].matched_sources[0];
      assert.equal(invalidHit.evidence_status, 'invalidated');
    });
    await t.test('source counts are exact beyond twenty and oversized source full reads stay unavailable', async () => {
      const target = await create('Many saved source parent'), links = [];
      for (let i = 0; i < 23; i++) links.push((await evidence(target, 'ManySourcesNeedle ' + i)).id);
      await admin.query('update public.clued_memories set source_refs=$2::uuid[] where id=$1', [target, links]);
      const result = await read({ query: 'ManySourcesNeedle', limit: 1 });
      assert.equal(result.records.length, 1); assert.equal(result.records[0].id, target);
      assert.equal(result.records[0].matched_source_count, 23); assert.equal(result.records[0].matched_sources.length, 20);
      assert.equal(result.records[0].matched_sources_truncated, true); assert.equal(result.page.complete, true);
      const large = await create('Large source parent'), e = await evidence(large, '界'.repeat(50000) + 'LargeSourceTailNeedle');
      const match = await read({ query: 'LargeSourceTailNeedle' }); assert.equal(match.records[0].id, large);
      assert.ok(match.records[0].matched_sources[0].snippet.includes('LargeSourceTailNeedle'));
      const full = await src({ record_id: large, record_version: 1, evidence_id: e.id });
      assert.equal(full.available, false); assert.equal(full.complete, false);
      assert.equal(full.unavailable_reason, 'source_content_exceeds_read_limit');
      assert.equal('content' in full, false); assert.equal('segment' in full, false);
    });
    await t.test('Context Canonical histories keep exact owned project/context/environment before unified paging', async () => {
      async function space(user, projectId, environment) {
        await admin.query('begin');
        try {
          await admin.query('select clued_private.authorization_writer_guard_v2($1)', [user]);
          const result = await admin.query(`insert into clued_private.development_spaces_v14
            (owner_id,project_id,name,environment,cursor) values($1,$2,'History synthetic context',$3,0) returning id`,
          [user, projectId, environment]); await admin.query('commit'); return result.rows[0].id;
        } catch (e) { await admin.query('rollback'); throw e; }
      }
      const context = await space(owner, project, 'preview'), production = await space(owner, project, 'production');
      const foreign = await space(other, foreignProject, 'preview');
      const scope = 'project:' + project, target = await create('ContextHistoricalNeedle', scope);
      assert.equal((await change(target, 1, 'Context latest body', { scope })).status, 'committed');
      for (const [context_id, environment] of [[context, 'preview'], [production, 'production']]) {
        const input = { context_id, source_kind: 'canonical', query: 'ContextHistoricalNeedle', include_history: true, limit: 1 };
        const found = await call('clued_development_imprint_read_v1', input);
        assert.equal(found.records.length, 1); assert.equal(found.records[0].id, target);
        const old = found.records[0].matched_revisions[0];
        assert.equal(old.context_id, context_id); assert.equal(old.environment, environment);
        assert.equal(found.records[0].content, 'Context latest body'); assert.equal(found.page.complete, true);
        const detail = await revision({ record_id: target, record_version: 2, historical_record_version: 1, scope, context_id });
        assert.equal(detail.available, true); assert.equal(detail.context_id, context_id);
      }
      await assert.rejects(call('clued_development_imprint_read_v1', { context_id: foreign, query: 'ContextHistoricalNeedle', include_history: true }),
        /context_access_denied/);
      await assert.rejects(revision({ record_id: target, record_version: 2, historical_record_version: 1, scope, context_id: foreign }),
        /context_access_denied/);
    });
    await t.test('new unknown and isolated fences cannot re-enter through history, source, snippets, totals or cursors', async () => {
      const target = await create('IsolatedHistoricalNeedle'); const e = await evidence(target, 'IsolatedSourceNeedle');
      await change(target, 1, 'New isolated body');
      const original = (await admin.query("select pg_get_functiondef('clued_private.record_currentness_fence(uuid,uuid,text[])'::regprocedure) v")).rows[0].v;
      await admin.query(original.replace('clued_private.record_currentness_fence(', 'clued_private.history_fixture_original_fence('));
      try {
        for (const fence of ['ISOLATED', 'NOT_AUTHORIZED', 'FUTURE_DENIED']) {
          await admin.query(`create or replace function clued_private.record_currentness_fence(p_user_id uuid,p_record_id uuid,p_authorized_scopes text[])
            returns text language plpgsql stable security definer set search_path='' as $f$
            begin if $2='${target}'::uuid then return '${fence}'; end if;
              return clued_private.history_fixture_original_fence($1,$2,$3); end $f$`);
          for (const query of ['IsolatedHistoricalNeedle', 'IsolatedSourceNeedle']) {
            const result = await read({ query, include_history: true });
            assert.deepEqual(result.records, []); assert.equal(result.withheld_record_count, 0);
            assert.equal(result.page.next_cursor, null); assert.equal(result.page.complete, true);
          }
          const details = await revision({ record_id: target, record_version: 2, historical_record_version: 1, scope: 'global' });
          assert.equal(details.available, false); assert.equal('record' in details, false);
          const source = await src({ record_id: target, record_version: 2, evidence_id: e.id, historical_record_version: 1, include_history: true });
          assert.equal(source.error_code, 'source_not_found'); assert.equal('content' in source, false);
        }
      } finally {
        await admin.query(original); await admin.query('drop function clued_private.history_fixture_original_fence(uuid,uuid,text[])');
      }
    });
    await t.test('two thousand retained 7KB bodies stream within the Native read budget without losing exact totals', async () => {
      const target = await create('x'.repeat(7000) + 'LongHistoryNeedle initial');
      // Isolated superuser fixture advances the real source row; the actual
      // AFTER trigger captures every OLD row. No precomputed fake snapshots.
      await admin.query(`do $bulk$ declare n integer; begin for n in 1..2000 loop
        update public.clued_memories set version=version+1,content=repeat('x',7000)||'LongHistoryNeedle '||n,
          updated_at=clock_timestamp() where id='${target}'::uuid;
        end loop; end $bulk$`);
      await human.query("set statement_timeout='8s'");
      const start = performance.now();
      try {
        const result = await read({ id: target, query: 'LongHistoryNeedle', include_history: true, limit: 1 });
        assert.equal(result.records.length, 1); assert.equal(result.records[0].id, target);
        assert.equal(result.records[0].version, 2001); assert.equal(result.records[0].matched_revision_count, 2000);
        assert.equal(result.records[0].matched_revisions.length, 20); assert.equal(result.records[0].matched_revisions_truncated, true);
        assert.equal(result.page.complete, true); assert.equal(result.page.next_cursor, null);
        t.diagnostic('Streaming exact 2000-version/7KB read elapsed ms: ' + Math.round(performance.now() - start));
      } finally { await human.query("set statement_timeout='30s'"); }
    });
    await t.test('history cannot survive a scope mismatch or forge a version/detail input', async () => {
      const input = { record_id: id, record_version: version, historical_record_version: 1, scope: 'global' };
      assert.equal((await revision({ ...input, record_version: version - 1 })).unavailable_reason, 'stale_record_version');
      assert.equal((await revision({ ...input, scope: 'project:' + project })).available, false);
      for (const historical_record_version of [0, '1', version, version + 1, 1.5, 9007199254740992]) {
        await assert.rejects(revision({ ...input, historical_record_version }), /imprint_revision_input_invalid/);
      }
      const moved = await change(id, version, 'Moved scoped body', { operation: 'reclassify_scope', scope: 'project:' + project,
        reclassification_reason: 'Explicit isolated Owner scope move' });
      assert.equal(moved.status, 'committed', JSON.stringify(moved));
      assert.equal((await revision({ ...input, scope: 'project:' + project, record_version: version + 1 })).available, false);
      assert.equal((await read({ query: '绿色方案', include_history: true })).records.some(row => row.id === id), false);
    });
    t.diagnostic('Applied complete chronological migration chain: ' + names.length);
  } finally {
    for (const db of clients.reverse()) await db.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
