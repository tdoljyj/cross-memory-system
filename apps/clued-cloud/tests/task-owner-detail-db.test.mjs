import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const fresh = (sub) => ({ sub, role: 'authenticated', session_id: 'owner-detail-session',
  aal: 'aal1', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('Owner record detail: Native tenancy, typed links, exact currentness and read-only claims',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-task-owner-detail-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hash(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
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
      .filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await assertGatewayCloseoutBoundary(admin);

    const owner = uuid(), stranger = uuid(), project = uuid(), foreignProject = uuid();
    const bindingToken = hash(), privateKey = `clued_lk_${hash()}`;
    const keyHash = crypto.createHash('sha256').update(privateKey).digest('hex');
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'detail-owner@example.invalid',now()),($2,'detail-stranger@example.invalid',now())`, [owner, stranger]);
    for (const [id, user] of [[project, owner], [foreignProject, stranger]]) {
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [user]);
        assert.equal((await admin.query('select clued_private.authorization_writer_guard_held_v2($1) held', [user])).rows[0].held, true);
        await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
          values($1,$2,$3,$3,$4)`, [id, user, `project-${id}`, `project:${id}`]);
        await admin.query('commit');
      } catch (error) { await admin.query('rollback'); throw error; }
    }
    // raw-binding-grants: these inert Bindings only provide claim-holder foreign keys and labels.
    // Every detail call uses a direct Native human session; no call resolves or authenticates a Binding.
    // Keep them ungranted so the fixture does not invent Agent execution authority.
    const binding = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Detail fixture',$2,array['context:read'],array['*']) returning id`,
    [owner, bindingToken])).rows[0].id;
    const foreignBinding = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Other owner fixture',$2,array['context:read'],array['*']) returning id`,
    [stranger, hash()])).rows[0].id;
    assert.equal(Number((await admin.query('select count(*) n from clued_private.authorizations_v12 where binding_id=any($1::uuid[])',
      [[binding, foreignBinding]])).rows[0].n), 0, 'FK-only claim holders have no authenticated authorization');
    assert.equal(Number((await admin.query('select count(*) n from clued_private.development_grants_v14 where binding_id=any($1::uuid[])',
      [[binding, foreignBinding]])).rows[0].n), 0, 'FK-only claim holders have no development grants');
    const put = async ({ id = uuid(), user = owner, kind = 'task', scope = 'global',
      title = 'Owner detail fixture', content = 'Task full text', lifecycle = 'active',
      status = 'active', typeFields = {}, relations = {}, schema = 1, closure = null }) => {
      await admin.query(`insert into public.clued_memories
        (id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,
          lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,
          confidence_reason,content_hash,closure_summary)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}','observed','detail fixture',$14,$15)`,
      [id, user, title, content, scope === 'global' ? 'global' : 'project',
        scope.startsWith('project:') ? scope.slice(8) : null, kind, status, schema, lifecycle,
        schema === 1 ? scope : null, typeFields, relations, hash(), closure]);
      return id;
    };
    const decision = await put({ id: '4bcc424d-0000-4000-8000-000000000001', kind: 'decision',
      title: 'Owner Decision full text', content: 'Click the Task ID.' });
    const structuredNote = await put({ kind: 'note', content: 'Exact canonical relation note' });
    const task = await put({ content: `执行全部任务正文。Owner Decision 4bcc424d v2 第 4 项。`,
      scope: `project:${project}`, typeFields: { execution_bucket: 'next', private_metadata: keyHash },
      relations: { evidence_note: structuredNote, foreign_decision: uuid() } });
    const backlinkNote = await put({ kind: 'note', typeFields: { follow_up_tasks: [`Task ${task.slice(0, 8)}`] },
      content: 'Handover note full text' });
    const exactBacklinkNote = await put({ kind: 'note', relations: { follow_up_tasks: [task] } });
    const foreignDecision = await put({ id: '4bcc424d-0000-4000-8000-000000000003', user: stranger,
      kind: 'decision', content: 'Foreign private full text' });
    const unrelatedNote = await put({ kind: 'note', content: `An untyped ${task.slice(0, 8)} is not a link.` });
    const malformedTask = await put({ content: `An arbitrary URL https://example.invalid/${decision} is not a link.`,
      relations: { external: `https://example.invalid/${decision}` } });
    const barePrefixTask = await put({ content: `Bare ${decision.slice(0, 8)} and malformed Decision 4bcc424d123 are not refs.` });
    const foreignScopeTask = await put({ scope: `project:${foreignProject}` });
    const legacy = await put({ kind: 'note', schema: null });
    const state = await put({ kind: 'state', content: 'State remains outside the detail surface.' });
    const closed = await put({ lifecycle: 'completed', status: 'done', closure: 'Merged and accepted.' });
    const unknown = await put({ typeFields: { execution_bucket: 'next', projection_key: 'forged-detail-projection' } });
    const archivedNote = await put({ kind: 'note', lifecycle: 'archived' });
    const unknownDecision = await put({ kind: 'decision', typeFields: { projection_key: 'unbound-related-projection' } });
    const unrelatedTask = await put({ content: 'Another task with its own claim' });
    await admin.query(`update public.clued_memories set relations=relations||jsonb_build_object(
      'foreign',$2::text,'archived_note',$3::text,'unknown_decision',$4::text) where id=$1`,
    [task, foreignDecision, archivedNote, unknownDecision]);

    const claim = async ({ taskId = task, user = owner, holder = binding, status = 'ACTIVE', copy = null,
      issued = '-1 hour', expires = '1 hour', deadline = '2 hours', updated = '-1 minute' } = {}) => {
      const id = uuid();
      await admin.query(`insert into clued_private.work_claims_v1
        (claim_id,user_id,task_id,context_key,holder_binding_id,write_set,trigger_refs,fence,
          issued_at,expires_at,hard_deadline_at,status,idempotency_key,updated_at,copy_index,
          lease_key_hash,holder_label,holder_client,holder_session_title,holder_session_ref)
        values($1,$2,$3,'global',$4,array['detail/fixture'],array['task:detail'],1,
          clock_timestamp()+$5::interval,clock_timestamp()+$6::interval,clock_timestamp()+$7::interval,
          $8,$9,clock_timestamp()+$10::interval,$11,$12,'详情页 · 本机','Codex','详情页会话','codex-detail-session')`,
      [id, user, taskId, holder, issued, expires, deadline, status, uuid(), updated, copy, keyHash]);
      return id;
    };
    const active = await claim({ copy: 1 });
    const draining = await claim({ status: 'DRAINING', copy: 2 });
    const lapsed = await claim({ copy: 3, expires: '-1 second' });
    const released = await claim({ status: 'RELEASED', expires: '-1 minute' });
    const old = await claim({ status: 'EXPIRED', issued: '-26 hours', expires: '-25 hours', deadline: '-24 hours' });
    const otherClaim = await claim({ taskId: unrelatedTask });
    const foreignClaim = await claim({ user: stranger, holder: foreignBinding });

    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const native = async (input, claims = fresh(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query('select public.clued_task_owner_detail_v1($1) v', [JSON.stringify(input)])).rows[0].v;
    };
    const rejected = (result, code) => assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result));
    const snapshot = async () => {
      const tables = (await admin.query(`select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r' and n.nspname in ('public','clued_private') order by n.nspname,c.relname`)).rows;
      const counts = [];
      for (const { nspname, relname } of tables) {
        counts.push([`${nspname}.${relname}`, (await admin.query(`select count(*)::text n from "${nspname}"."${relname}"`)).rows[0].n]);
      }
      const rows = {};
      for (const table of ['public.clued_memories', 'public.clued_context_events', 'public.clued_audit_receipts', 'clued_private.work_claims_v1']) {
        rows[table] = (await admin.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from ${table} t`)).rows[0].r;
      }
      return { counts, rows, sequence: (await admin.query('select last_value,is_called from clued_private.canonical_version_seq')).rows };
    };
    const before = await snapshot();
    const detail = await native({ id: task });
    assert.equal(detail.status, 'ok', JSON.stringify(detail));
    assert.ok(Number.isFinite(Date.parse(detail.observed_at)));
    assert.deepEqual(Object.keys(detail).sort(), ['claims', 'ended', 'observed_at', 'record', 'related', 'status']);
    assert.deepEqual(Object.keys(detail.record).sort(), ['closure_summary', 'content', 'currentness', 'execution_bucket',
      'id', 'lifecycle_status', 'record_type', 'scope', 'status', 'title', 'updated_at', 'version']);
    assert.deepEqual([detail.record.id, detail.record.content, detail.record.scope, detail.record.execution_bucket, detail.record.currentness],
      [task, '执行全部任务正文。Owner Decision 4bcc424d v2 第 4 项。', `project:${project}`, 'next', 'CURRENT']);
    assert.deepEqual(detail.related.map((r) => r.id).sort(),
      [decision, structuredNote, backlinkNote, exactBacklinkNote, archivedNote, unknownDecision].sort());
    for (const row of detail.related) {
      assert.deepEqual(Object.keys(row).sort(), ['currentness', 'id', 'record_type', 'scope', 'title']);
      assert.equal(row.currentness, row.id === archivedNote ? 'HISTORY' : row.id === unknownDecision ? 'UNKNOWN' : 'CURRENT');
    }
    assert.ok(!detail.related.some((r) => [foreignDecision, unrelatedNote].includes(r.id)));
    assert.deepEqual(detail.claims.map((c) => c.claim_id).sort(), [active, draining].sort());
    assert.deepEqual(detail.ended.map((c) => c.claim_id).sort(), [lapsed, released].sort());
    assert.equal(detail.ended.find((c) => c.claim_id === lapsed).state, 'EXPIRED');
    assert.equal(detail.claims.find((c) => c.claim_id === draining).state, 'DRAINING');
    assert.deepEqual([detail.claims[0].holder_client, detail.claims[0].holder_label, detail.claims[0].holder_session_title],
      ['Codex', '详情页 · 本机', '详情页会话']);
    assert.ok(![...detail.claims, ...detail.ended].some((c) => [old, otherClaim, foreignClaim].includes(c.claim_id)));
    for (const secret of [privateKey, keyHash, bindingToken, 'lease_key_hash', 'private_metadata']) {
      assert.equal(JSON.stringify(detail).includes(secret), false, `detail leaks ${secret}`);
    }

    for (const id of [decision, backlinkNote]) {
      const linked = await native({ id });
      assert.equal(linked.status, 'ok');
      assert.deepEqual([linked.record.id, linked.record.execution_bucket, linked.claims, linked.ended], [id, null, [], []]);
    }
    assert.deepEqual((await native({ id: malformedTask })).related, []);
    assert.deepEqual((await native({ id: barePrefixTask })).related, []);
    const terminal = await native({ id: closed });
    assert.deepEqual([terminal.record.currentness, terminal.record.closure_summary], ['HISTORY', 'Merged and accepted.']);
    assert.equal((await native({ id: archivedNote })).record.currentness, 'HISTORY');
    assert.equal((await native({ id: unknown })).record.currentness, 'UNKNOWN');
    for (const id of [task, closed, unknown]) {
      const fence = (await admin.query(`select clued_private.record_currentness_fence($1,$2,array['global',$3]) v`,
        [owner, id, `project:${project}`])).rows[0].v;
      assert.equal((await native({ id })).record.currentness, fence, 'use the actual per-record server fence');
    }
    for (const id of [uuid(), foreignDecision, foreignScopeTask, legacy, state]) rejected(await native({ id }), 'record_not_found');
    rejected(await native({ id: task }, fresh(stranger)), 'record_not_found');
    for (const input of [null, [], {}, { id: task.slice(0, 8) }, { id: 42 }, { id: task, user_id: owner },
      { id: task, scope: 'global' }, { id: task, include_history: true }, { id: task, lease_key: privateKey }]) {
      rejected(await native(input), 'record_detail_input_invalid');
    }
    await assert.rejects(() => native({ id: task }, { role: 'authenticated' }), /direct_human_session_required/);
    await assert.rejects(() => native({ id: task }, { ...fresh(owner), client_id: 'delegated-oauth-client' }), /direct_human_session_required/);
    for (const role of ['anon', 'service_role', 'clued_worker_gateway']) {
      const caller = server.getPgClient();
      clients.push(caller);
      await caller.connect();
      await caller.query(`set role ${role}`);
      await assert.rejects(() => caller.query('select public.clued_task_owner_detail_v1($1)', [{ id: task }]), /permission denied/);
    }
    assert.deepEqual(await snapshot(), before, 'all success and refusal reads leave records, claims, Events, Receipts and sequence untouched');
    assert.equal((await admin.query('select status from clued_private.work_claims_v1 where claim_id=$1', [lapsed])).rows[0].status,
      'ACTIVE', 'expired claims are observed, never materialized by a read');

    // Ambiguous short refs are not guessed; an exact canonical relation remains usable.
    const colliding = await put({ id: '4bcc424d-0000-4000-8000-000000000002', kind: 'decision' });
    const ambiguous = await native({ id: task });
    assert.ok(!ambiguous.related.some((r) => [decision, colliding].includes(r.id)));
    await admin.query('update public.clued_memories set relations=relations||jsonb_build_object(\'decision_id\',$2::text) where id=$1', [task, decision]);
    assert.ok((await native({ id: task })).related.some((r) => r.id === decision));
    await put({ id: `${task.slice(0, 8)}-0000-4000-8000-000000000001`, content: 'Same Task short ID, another canonical identity.' });
    const ambiguousBacklink = await native({ id: task });
    assert.ok(!ambiguousBacklink.related.some((r) => r.id === backlinkNote), 'ambiguous short Task backrefs are refused');
    assert.ok(ambiguousBacklink.related.some((r) => r.id === exactBacklinkNote), 'an exact canonical Task backref remains usable');

    // The ended window is strictly the latest 24 hours and bounded to 100.
    for (let n = 0; n < 102; n++) await claim({ status: 'RELEASED', updated: `-${n + 1} minutes` });
    const capBefore = await snapshot();
    assert.equal((await native({ id: task })).ended.length, 100);
    assert.deepEqual(await snapshot(), capBefore, 'bounded history stays read-only');

    const signatures = ['public.clued_task_owner_detail_v1(jsonb)',
      'clued_private.task_owner_reference_ids_v1(uuid,public.clued_memories,text[],text[])',
      'clued_private.task_owner_currentness_v1(uuid,public.clued_memories,text[])'];
    for (const signature of signatures) {
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        const allowed = (await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') v", [role, signature])).rows[0].v;
        assert.equal(allowed, signature.startsWith('public.') && role === 'authenticated', `${role} ${signature}`);
      }
    }
    const catalog = (await admin.query(`select prosecdef,proconfig from pg_proc
      where oid='public.clued_task_owner_detail_v1(jsonb)'::regprocedure`)).rows[0];
    assert.equal(catalog.prosecdef, true);
    assert.deepEqual(catalog.proconfig, ['search_path=""']);
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
