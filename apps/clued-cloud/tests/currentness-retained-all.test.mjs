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
const hash = () => crypto.randomBytes(32).toString('hex');
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('Retained T-CUR currentness contracts: supplemental database matrix', { timeout: 240000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-cur-retained-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
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
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');

    async function fixture() {
      const userId = uuid();
      const token = hash();
      await admin.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
        [userId, `${userId}@example.invalid`]);
      const bindingId = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','T-CUR retained',$2,array['context:read','context:write','audit:read'],array['*'])
        returning id`, [userId, token])).rows[0].id;
      const rpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) value`, [token, input])).rows[0].value;
      const project = async (name) => {
        const id = uuid();
        const scope = `project:${id}`;
        await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,
          context_key,certainty_status,confirmed_at,lifecycle_status)
          values($1,$2,$3,$4,$5,'confirmed',now(),'active')`, [id, userId, name, name.toLowerCase(), scope]);
        return { id, scope };
      };
      const record = async (scope, type, title, typeFields = {}, relations = {}) => {
        const id = uuid();
        const response = await rpc('clued_record_mutate', {
          operation: 'create', id, record_type: type, record_schema_version: 1,
          lifecycle_status: 'active', scope, idempotency_key: uuid(),
          authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Retained regression fixture',
          source_refs: [], source_unavailable_reason: null,
          mutation: { title, content: title, type_fields: typeFields, relations },
        });
        assert.equal(response.status, 'committed', JSON.stringify(response));
        return id;
      };
      const update = async (scope, type, id, mutation, lifecycleStatus = 'active') => {
        const version = (await admin.query('select version from public.clued_memories where id=$1', [id])).rows[0].version;
        const response = await rpc('clued_record_mutate', {
          operation: 'update', id, record_type: type, record_schema_version: 1,
          lifecycle_status: lifecycleStatus, scope, base_version: version,
          idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
          confidence_reason: 'Retained regression fixture', mutation,
        });
        assert.equal(response.status, 'committed', JSON.stringify(response));
        return response;
      };
      const restore = (scope, view = 'structured', extra = {}) =>
        rpc('clued_mcp_restore', { context_key: scope, response_view: view, ...extra });
      const checkpoint = (scope, session, extra = {}) => rpc('clued_mcp_commit_checkpoint', {
        context_key: scope, session_token: session.session_token,
        base_version: session.version, snapshot: { previous: 'OLD_CHECKPOINT' },
        summary: 'OLD_CHECKPOINT', next_action: 'OLD_CHECKPOINT',
        coverage: { mode: 'explicit', contexts: [scope], tracks: ['retained'], event_ids: [] },
        idempotency_key: uuid(), ...extra,
      });
      return { userId, token, bindingId, rpc, project, record, update, restore, checkpoint };
    }

    await t.test('T-CUR-01/02/09: Task and State changes stale both read views', async () => {
      const f = await fixture();
      const p = await f.project('Local stale project');
      await f.record(p.scope, 'task', 'Task A', { execution_bucket: 'next', priority: 1 });
      const stateId = await f.record(p.scope, 'state', 'State A', { state_kind: 'frontier' });
      const first = await f.restore(p.scope);
      assert.equal(first.currentness_evaluation.overall,
        (await f.restore(p.scope, 'work_log')).currentness_evaluation.overall);
      assert.equal((await f.checkpoint(p.scope, first)).status, 'committed');
      await f.record(p.scope, 'task', 'Task B', { execution_bucket: 'now', priority: 99 });
      const taskStructured = await f.restore(p.scope);
      const taskLog = await f.restore(p.scope, 'work_log');
      assert.equal(taskStructured.currentness_evaluation.overall, 'STALE');
      assert.equal(taskLog.currentness_evaluation.overall, 'STALE');
      assert.equal(taskStructured.effective_next_action, null);
      assert.notEqual(taskStructured.next_action, 'OLD_CHECKPOINT');
      const admission = await f.rpc('clued_mcp_session_reconcile', {
        context_key: p.scope, session_token: taskStructured.session_token,
      });
      assert.equal(admission.admission_eligible, true);
      const second = await f.restore(p.scope);
      assert.equal((await f.checkpoint(p.scope, second)).status, 'committed');
      await f.update(p.scope, 'state', stateId, { content: 'State terminal changed' });
      const stateStructured = await f.restore(p.scope);
      const stateLog = await f.restore(p.scope, 'work_log');
      assert.equal(stateStructured.currentness_evaluation.overall, 'STALE');
      assert.equal(stateLog.currentness_evaluation.overall, 'STALE');
      assert.equal(taskStructured.next_action_authoritative, false);
      assert.ok(taskStructured.required_reads?.includes('project.task'));
    });

    await t.test('T-CUR-03/06/39: Decision conflict and Global authority mid-session impact', async () => {
      const f = await fixture();
      const p = await f.project('Global control project');
      const old = await f.restore(p.scope);
      assert.equal((await f.checkpoint(p.scope, old)).status, 'committed');
      const preDecision = await f.restore(p.scope);
      await f.record('global', 'decision', 'Newer global constraint',
        { rationale: 'Current authority', constraint: true });
      const changed = await f.restore(p.scope);
      const changedLog = await f.restore(p.scope, 'work_log');
      assert.equal(changed.currentness_evaluation.overall, 'STALE');
      const oldCheckpoint = await f.checkpoint(p.scope, preDecision);
      assert.deepEqual({ status: oldCheckpoint.status, error: oldCheckpoint.error },
        { status: 'conflict', error: 'current_truth_changed_since_resume' });
      assert.equal(changedLog.currentness_evaluation.overall,
        changed.currentness_evaluation.overall);
      assert.ok(changed.active_constraints.some((row) => row.title === 'Newer global constraint'));
      assert.ok(changed.authority_conflicts.some((row) =>
        row.title === 'Newer global constraint' && row.status === 'review_required'));
      assert.ok(changedLog.authority_conflicts.some((row) =>
        row.title === 'Newer global constraint' && row.status === 'review_required'));
      assert.notEqual(changed.next_action, 'OLD_CHECKPOINT');
      const fresh = await f.restore(p.scope);
      const admitted = await f.rpc('clued_mcp_session_reconcile', {
        context_key: p.scope, session_token: fresh.session_token,
      });
      assert.equal(admitted.admission_eligible, true);
      assert.equal((await f.checkpoint(p.scope, fresh)).status, 'committed');
      const noteSession = await f.restore('global');
      await f.rpc('clued_mcp_append_event', {
        context_key: 'global', session_token: noteSession.session_token,
        base_version: noteSession.version, event_type: 'note',
        payload: { marker: 'irrelevant-note' }, idempotency_key: uuid(),
      });
      assert.equal((await f.restore(p.scope)).currentness_evaluation.overall, 'CURRENT');
    });

    await t.test('T-CUR-04/05/08/15/25: Project closeout invalidates pre-deploy Global checkpoint and projection', async () => {
      const f = await fixture();
      const oldFrontier = await f.record('global', 'state', '0.3.3 / NOT_DEPLOYED',
        { state_kind: 'frontier' });
      await admin.query(`insert into clued_private.projection_record_bindings
        (record_id,user_id,target_scope,projection_key,projection_owner)
        values($1,$2,'global','global.priority_frontier','legacy_fixture')`, [oldFrontier, f.userId]);
      const old = await f.restore('global');
      assert.equal((await f.checkpoint('global', old)).status, 'committed');
      const p = await f.project('0.4.0 incident replay');
      const before = (await admin.query(`select invalidation_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.__aggregate__'`, [f.userId])).rows[0].invalidation_revision;
      const projectState = await f.record(p.scope, 'state', '0.4.0 production terminal',
        { state_kind: 'frontier', terminal: true });
      const projectTask = await f.record(p.scope, 'task', 'Release blocker',
        { execution_bucket: 'now', priority: 90 });
      await f.update(p.scope, 'task', projectTask,
        { type_fields: { execution_bucket: 'later', priority: 10 } });
      const after = (await admin.query(`select invalidation_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.__aggregate__'`, [f.userId])).rows[0].invalidation_revision;
      assert.ok(Number(after) > Number(before));
      const resumed = await f.restore('global');
      assert.equal(resumed.currentness_evaluation.overall, 'STALE');
      assert.deepEqual(resumed.snapshot, {});
      assert.notEqual(resumed.next_action, 'OLD_CHECKPOINT');
      assert.equal(resumed.effective_next_action, null);
      assert.deepEqual((await f.rpc('clued_record_list', { level: 'global', record_type: 'state' })).records, []);
      await admin.query(`update public.clued_projects set lifecycle_status='complete',
        version=version+1 where id=$1`, [p.id]);
      const complete = (await admin.query(`select invalidation_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.__aggregate__'`, [f.userId])).rows[0].invalidation_revision;
      assert.ok(Number(complete) > Number(after));
      await admin.query(`update public.clued_projects set lifecycle_status='archived',
        version=version+1 where id=$1`, [p.id]);
      await admin.query(`update public.clued_projects set lifecycle_status='active',
        version=version+1 where id=$1`, [p.id]);
      const restoredRevision = (await admin.query(`select invalidation_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.__aggregate__'`, [f.userId])).rows[0].invalidation_revision;
      assert.ok(Number(restoredRevision) >= Number(complete) + 2);
      assert.ok(projectState);
    });

    await t.test('T-CUR-07: only explicit cross-project dependents invalidate', async () => {
      const f = await fixture();
      const a = await f.project('Dependency source');
      const b = await f.project('Dependent project');
      const c = await f.project('Unrelated project');
      const source = await f.record(a.scope, 'task', 'Upstream deliverable',
        { execution_bucket: 'now' });
      await f.record(b.scope, 'task', 'Dependent deliverable',
        { execution_bucket: 'now' }, { depends_on: [source] });
      const b0 = await f.restore(b.scope);
      const c0 = await f.restore(c.scope);
      assert.equal((await f.checkpoint(b.scope, b0)).status, 'committed');
      assert.equal((await f.checkpoint(c.scope, c0)).status, 'committed');
      await f.update(a.scope, 'task', source, { type_fields: { execution_bucket: 'later' } });
      assert.equal((await f.restore(b.scope)).currentness_evaluation.overall, 'STALE');
      assert.equal((await f.restore(c.scope)).currentness_evaluation.overall, 'CURRENT');
    });

    await t.test('T-CUR-10/11/19/60: hidden Event equivalence and revoked admission', async () => {
      const f = await fixture();
      const session = await f.restore('global');
      const before = await f.rpc('clued_record_list', { level: 'global', record_type: 'decision' });
      const vector = (await admin.query(`select clued_private.currentness_vector($1,'global',$2) value`,
        [f.userId, f.bindingId])).rows[0].value;
      const sessionId = (await admin.query(`select id from public.clued_continuity_sessions
        where token_hash=encode(extensions.digest($1,'sha256'),'hex')`,
      [session.session_token])).rows[0].id;
      const hidden = (await admin.query(`insert into public.clued_context_events
        (user_id,context_key,session_id,binding_id,event_type,payload,audit_visibility)
        values($1,'global',$2,$3,'decision','{"marker":"SECRET"}'::jsonb,'audit_only') returning id`,
      [f.userId, sessionId, f.bindingId])).rows[0].id;
      const after = await f.rpc('clued_record_list', { level: 'global', record_type: 'decision' });
      assert.deepEqual(after, before);
      assert.deepEqual((await admin.query(`select clued_private.currentness_vector($1,'global',$2) value`,
        [f.userId, f.bindingId])).rows[0].value, vector);
      const lowToken = hash();
      await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','No audit',$2,array['context:read','context:write'],array['global'])`,
      [f.userId, lowToken]);
      const lowRpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) value`,
        [lowToken, input])).rows[0].value;
      const lowSession = await lowRpc('clued_mcp_restore', { context_key: 'global', response_view: 'structured' });
      const lowSearch = await lowRpc('clued_mcp_search_context', {
        context_key: 'global', session_token: lowSession.session_token, query: 'SECRET',
      });
      assert.deepEqual(lowSearch.results, []);
      const lowLog = await lowRpc('clued_mcp_read_log', {
        context_key: 'global', session_token: lowSession.session_token,
      });
      assert.doesNotMatch(lowLog.markdown, /SECRET/);
      await assert.rejects(() => lowRpc('clued_mcp_audit_receipts', { context_key: 'global' }),
        /binding_not_authorized|binding_scope_denied|scope_not_authorized|audit:read|permission denied/);
      const countBefore = (await admin.query(`select count(*)::integer n from public.clued_context_checkpoints
        where user_id=$1`, [f.userId])).rows[0].n;
      const absorptionBefore = (await admin.query(`select count(*)::integer n from public.clued_checkpoint_event_absorptions
        where event_id=$1`, [hidden])).rows[0].n;
      const hiddenInput = {
        context_key: 'global', session_token: lowSession.session_token,
        base_version: lowSession.version, snapshot: { marker: 'bad' }, summary: 'bad',
        next_action: 'bad', idempotency_key: uuid(),
        coverage: { mode: 'explicit', contexts: ['global'], tracks: ['decision'], event_ids: [Number(hidden)] },
      };
      const unknownInput = { ...hiddenInput,
        coverage: { ...hiddenInput.coverage, event_ids: [Number(hidden) + 100000] } };
      const hiddenError = await lowRpc('clued_mcp_commit_checkpoint', hiddenInput)
        .then(() => null, (error) => error.message);
      const unknownError = await lowRpc('clued_mcp_commit_checkpoint', unknownInput)
        .then(() => null, (error) => error.message);
      assert.equal(hiddenError, unknownError);
      assert.match(hiddenError, /checkpoint_event_not_authorized/);
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_context_checkpoints
        where user_id=$1`, [f.userId])).rows[0].n, countBefore);
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_checkpoint_event_absorptions
        where event_id=$1`, [hidden])).rows[0].n, absorptionBefore);
      const admitted = await lowRpc('clued_mcp_session_reconcile', {
        context_key: 'global', session_token: lowSession.session_token,
      });
      assert.equal(admitted.admission_eligible, true);
      await admin.query(`update public.clued_agent_bindings set revoked_at=now()
        where token_hash=$1`, [lowToken]);
      await assert.rejects(() => lowRpc('clued_mcp_commit_checkpoint', {
        ...hiddenInput, coverage: { ...hiddenInput.coverage, event_ids: [] },
        idempotency_key: uuid(),
      }), /binding_not_authorized|binding_revoked/);
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_context_checkpoints
        where user_id=$1`, [f.userId])).rows[0].n, countBefore);
    });

    await t.test('T-CUR-12/13/14/40/55: legacy Event continuation, current search, cursor and CAS', async () => {
      const f = await fixture();
      const session = await f.restore('global', 'structured', { event_limit: 1, event_budget_bytes: 4096 });
      const append = (baseVersion, marker) => f.rpc('clued_mcp_append_event', {
        context_key: 'global', session_token: session.session_token,
        base_version: baseVersion, event_type: 'decision',
        payload: { marker }, idempotency_key: uuid(),
      });
      const first = await append(session.version, 'legacy-first');
      const second = await append(first.version, 'legacy-second');
      assert.equal(first.status, 'appended');
      assert.equal(second.status, 'appended');
      const page = await f.restore('global', 'work_log', {
        event_cursor: Number(first.event_id) - 1, event_limit: 1, event_budget_bytes: 4096,
      });
      assert.equal(page.event_page.returned, 1);
      assert.equal(page.event_page.truncated, true);
      assert.match(page.work_log, /legacy-first/);
      assert.doesNotMatch(page.work_log, /legacy-second/);
      const badKey = uuid();
      const commitInput = {
        context_key: 'global', session_token: session.session_token,
        base_version: second.version, snapshot: { marker: 'legacy' },
        summary: 'Legacy continuation', next_action: 'Continue', idempotency_key: badKey,
        coverage: { mode: 'explicit', contexts: ['global'], tracks: ['decision'], event_ids: [first.event_id] },
      };
      const stale = await f.rpc('clued_mcp_commit_checkpoint', commitInput);
      assert.equal(stale.status, 'conflict');
      assert.equal(stale.error, 'current_truth_changed_since_resume');
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_context_checkpoints
        where user_id=$1`, [f.userId])).rows[0].n, 0);
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_checkpoint_event_absorptions
        where event_id=$1`, [first.event_id])).rows[0].n, 0);
      const reconcile = await f.rpc('clued_mcp_session_reconcile', {
        context_key: 'global', session_token: session.session_token,
      });
      assert.equal(reconcile.admission_eligible, true);
      const committed = await f.rpc('clued_mcp_commit_checkpoint', commitInput);
      assert.equal(committed.status, 'committed');
      const replaySession = await f.restore('global');
      const replay = await f.rpc('clued_mcp_commit_checkpoint', {
        ...commitInput, session_token: replaySession.session_token,
      });
      assert.equal(replay.status, 'duplicate');
      assert.equal(replay.checkpoint_id, committed.checkpoint_id);
      const carrier = (await admin.query(`select carrier_state from clued_private.event_truth_carriers
        where event_id=$1`, [first.event_id])).rows[0];
      assert.ok(['ACTIVE_UNSTRUCTURED', 'ACTIVE_TYPED'].includes(carrier.carrier_state));
      const after = await f.restore('global');
      assert.equal(after.pending_event_count, 1);
      const staleBase = await f.rpc('clued_mcp_commit_checkpoint', {
        ...commitInput, session_token: after.session_token,
        base_version: Number(after.version) - 1, idempotency_key: uuid(),
        coverage: { ...commitInput.coverage, event_ids: [] },
      });
      assert.deepEqual({ status: staleBase.status, error: staleBase.error },
        { status: 'conflict', error: 'stale_base_version' });
      assert.equal((await f.rpc('clued_mcp_search_context', {
        context_key: 'global', session_token: after.session_token,
        query: 'legacy-first', include_history: false,
      })).results[0].kind, 'event');
      const checkpointSearch = await f.rpc('clued_mcp_search_context', {
        context_key: 'global', session_token: after.session_token,
        query: 'Legacy continuation', include_history: false,
      });
      assert.equal(checkpointSearch.results.some((row) => row.kind === 'checkpoint'), false);
      const historyCheckpoint = await f.rpc('clued_mcp_search_context', {
        context_key: 'global', session_token: after.session_token,
        query: 'Legacy continuation', include_history: true,
      });
      assert.ok(historyCheckpoint.results.some((row) => row.kind === 'checkpoint' &&
        row.authoritative === false && row.source_semantics === 'continuity_history'));
      assert.equal(after.authoritative_current_action.status === 'RESOLVED', false);
    });

    await t.test('T-CUR-16/17/22/24/29/31/34: mid-session admission and free-text authority', async () => {
      const f = await fixture();
      const p = await f.project('Admission source project');
      const task = await f.record(p.scope, 'task', 'Canonical now task',
        { execution_bucket: 'now', priority: 80 });
      const session = await f.restore(p.scope);
      await f.update(p.scope, 'task', task, { content: 'Canonical truth changed' });
      const staleInput = {
        context_key: p.scope, session_token: session.session_token,
        base_version: session.version, snapshot: { action: 'old' },
        summary: 'Old checkpoint', next_action: 'OLD_FREE_TEXT',
        idempotency_key: uuid(),
        coverage: { mode: 'explicit', contexts: [p.scope], tracks: ['unrelated-track'], event_ids: [] },
      };
      const stale = await f.rpc('clued_mcp_commit_checkpoint', staleInput);
      assert.deepEqual({ status: stale.status, error: stale.error },
        { status: 'conflict', error: 'current_truth_changed_since_resume' });
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_context_checkpoints
        where user_id=$1 and context_key=$2`, [f.userId, p.scope])).rows[0].n, 0);
      await assert.rejects(() => anon.query(`select public.clued_mcp_commit_checkpoint_pre_currentness($1,$2)`,
        [f.token, staleInput]), /permission denied for function/);
      const sessionState = (await admin.query(`select reconciliation_required from public.clued_continuity_sessions
        where token_hash=encode(extensions.digest($1,'sha256'),'hex')`,
      [session.session_token])).rows[0];
      assert.equal(sessionState.reconciliation_required, true);
      const receipt = await f.rpc('clued_mcp_session_reconcile', {
        context_key: p.scope, session_token: session.session_token,
      });
      assert.equal(receipt.receipt_kind, 'CURRENTNESS_ADMISSION');
      await f.update(p.scope, 'task', task, { content: 'Changed after admission' });
      const afterReceipt = await f.rpc('clued_mcp_commit_checkpoint', staleInput);
      assert.deepEqual({ status: afterReceipt.status, error: afterReceipt.error },
        { status: 'conflict', error: 'current_truth_changed_since_resume' });
      const fresh = await f.restore(p.scope);
      const freshReceipt = await f.rpc('clued_mcp_session_reconcile', {
        context_key: p.scope, session_token: fresh.session_token,
      });
      assert.equal(freshReceipt.admission_eligible, true);
      const committed = await f.checkpoint(p.scope, fresh, {
        snapshot: { action: 'OLD_FREE_TEXT' }, next_action: 'OLD_FREE_TEXT',
        coverage: { mode: 'explicit', contexts: [p.scope],
          tracks: ['unrelated-track'], event_ids: [] },
      });
      assert.equal(committed.status, 'committed');
      const resumed = await f.restore(p.scope);
      assert.notEqual(resumed.effective_next_action?.title, 'OLD_FREE_TEXT');
      assert.equal(resumed.effective_next_action?.title, 'Canonical now task');
      const vectorBeforeNote = resumed.currentness_evaluation.currentness_vector_digest;
      const globalSession = await f.restore('global');
      await f.rpc('clued_mcp_append_event', {
        context_key: 'global', session_token: globalSession.session_token,
        base_version: globalSession.version, event_type: 'note',
        payload: { marker: 'not-a-truth-change', event_type: 'decision',
          next_action: 'MALICIOUS_NOTE_ACTION' }, idempotency_key: uuid(),
      });
      const afterNote = await f.restore(p.scope);
      assert.equal(afterNote.currentness_evaluation.currentness_vector_digest,
        vectorBeforeNote);
      assert.equal(afterNote.currentness_evaluation.overall, 'CURRENT');
      assert.equal(afterNote.effective_next_action?.title, 'Canonical now task');
    });

    await t.test('T-CUR-20/21/33: projection CAS and source-invalidation rollback', async () => {
      const f = await fixture();
      const frontier = await f.record('global', 'state', 'Priority frontier',
        { state_kind: 'frontier' });
      await admin.query(`insert into clued_private.projection_record_bindings
        (record_id,user_id,target_scope,projection_key,projection_owner)
        values($1,$2,'global','global.priority_frontier','legacy_fixture')`,
      [frontier, f.userId]);
      const p = await f.project('Projection source project');
      const task = await f.record(p.scope, 'task', 'Project priority',
        { execution_bucket: 'next', priority: 10 });
      await admin.query(`insert into clued_private.projection_builder_grants
        (binding_id,user_id,target_scope,projection_key,granted_by)
        values($1,$2,'global','global.priority_frontier','test-admin')`,
      [f.bindingId, f.userId]);
      const source = (await admin.query(`select clued_private.projection_source_snapshot($1) value`,
        [f.userId])).rows[0].value;
      const digest = (await admin.query(`select clued_private.currentness_hash($1::jsonb) value`,
        [source])).rows[0].value;
      const oldRevision = Number((await admin.query(`select invalidation_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.priority_frontier'`,
      [f.userId])).rows[0].invalidation_revision);
      await f.update(p.scope, 'task', task,
        { type_fields: { execution_bucket: 'now', priority: 90 } });
      await assert.rejects(() => f.rpc('clued_mcp_projection_rebuild', {
        projection_key: 'global.priority_frontier', record_id: frontier,
        expected_invalidation_revision: oldRevision,
        expected_source_vector_digest: digest,
      }), /projection_source_changed|projection_rebuild_cas_conflict|projection_cas_conflict/);
      const head = (await admin.query(`select invalidation_revision,resolved_through_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.priority_frontier'`,
      [f.userId])).rows[0];
      assert.ok(Number(head.invalidation_revision) > Number(head.resolved_through_revision));
      const ruleIds = (await admin.query(`select rule_id from clued_private.projection_dependency_registry
        where status='active'`)).rows.map((row) => row.rule_id);
      assert.ok(ruleIds.includes('project.task.frontier'));
      assert.ok(ruleIds.some((id) => id.includes('project')));
      const before = (await admin.query(`select content,version from public.clued_memories where id=$1`,
        [task])).rows[0];
      const receiptCount = (await admin.query(`select count(*)::integer n from public.clued_audit_receipts
        where user_id=$1`, [f.userId])).rows[0].n;
      await admin.query(`create function clued_private.reject_retained_invalidation()
        returns trigger language plpgsql as $$begin raise exception 'forced_invalidation_failure'; end$$`);
      await admin.query(`create trigger reject_retained_invalidation before insert or update
        on clued_private.projection_invalidation_heads for each row
        execute function clued_private.reject_retained_invalidation()`);
      try {
        await assert.rejects(() => f.update(p.scope, 'task', task,
          { content: 'MUST_ROLL_BACK' }), /forced_invalidation_failure/);
      } finally {
        await admin.query('drop trigger reject_retained_invalidation on clued_private.projection_invalidation_heads');
        await admin.query('drop function clued_private.reject_retained_invalidation()');
      }
      assert.deepEqual((await admin.query(`select content,version from public.clued_memories
        where id=$1`, [task])).rows[0], before);
      const receiptsAfter = (await admin.query(`select operation,object_type,object_id,status,
        committed_versions,event_ids,error_code
        from public.clued_audit_receipts where user_id=$1 order by created_at,id`,
      [f.userId])).rows;
      assert.equal(receiptsAfter.length, receiptCount + 1);
      assert.equal(receiptsAfter.filter((row) => row.status === 'committed').length,
        receiptCount, JSON.stringify(receiptsAfter));
      assert.ok(receiptsAfter.some((row) => row.status === 'failed' &&
        row.error_code === 'forced_invalidation_failure'));
    });

    await t.test('T-CUR-33: every production projection dependency rule advances its target', async () => {
      const f = await fixture();
      const p = await f.project('Rule coverage project');
      const rules = (await admin.query(`select rule_id,target_projection_keys,fallback_projection_key
        from clued_private.projection_dependency_registry where status='active'
        order by rule_id`)).rows;
      assert.deepEqual(rules.map((rule) => rule.rule_id), [
        'project.decision.authority', 'project.lifecycle.frontier',
        'project.state.frontier', 'project.task.frontier',
      ]);
      assert.ok(rules.every((rule) => rule.target_projection_keys.includes('global.priority_frontier') &&
        rule.fallback_projection_key === 'global.__aggregate__'));
      const revision = async () => Number((await admin.query(`select invalidation_revision from
        clued_private.projection_invalidation_heads where user_id=$1
        and target_scope='global' and projection_key='global.priority_frontier'`,
      [f.userId])).rows[0]?.invalidation_revision ?? 0);
      let before = await revision();
      await f.record(p.scope, 'state', 'Rule state', { state_kind: 'frontier' });
      assert.ok(await revision() > before);
      before = await revision();
      await f.record(p.scope, 'task', 'Rule task', { execution_bucket: 'next' });
      assert.ok(await revision() > before);
      before = await revision();
      await f.record(p.scope, 'decision', 'Rule decision', { rationale: 'fixture' });
      assert.ok(await revision() > before);
      before = await revision();
      await admin.query(`update public.clued_projects set lifecycle_status='complete',
        version=version+1 where id=$1`, [p.id]);
      assert.ok(await revision() > before);
    });

    await t.test('T-CUR-23/26/27/28/30/57: legacy checkpoint and stale Global source read', async () => {
      const f = await fixture();
      const frontier = await f.record('global', 'state', '0.3.3 / NOT_DEPLOYED',
        { state_kind: 'frontier' });
      await admin.query(`insert into clued_private.projection_record_bindings
        (record_id,user_id,target_scope,projection_key,projection_owner)
        values($1,$2,'global','global.priority_frontier','legacy_fixture')`,
      [frontier, f.userId]);
      const first = await f.restore('global');
      const legacy = await f.checkpoint('global', first);
      assert.equal(legacy.status, 'committed');
      await admin.query(`update public.clued_context_checkpoints set
        committed_currentness_vector=null,currentness_admission_status=null
        where id=$1`, [legacy.checkpoint_id]);
      const legacyRead = await f.restore('global');
      assert.equal(legacyRead.currentness_evaluation.overall, 'UNKNOWN');
      const admission = await f.rpc('clued_mcp_session_reconcile', {
        context_key: 'global', session_token: legacyRead.session_token,
      });
      assert.equal(admission.admission_eligible, true);
      const successor = await f.checkpoint('global', legacyRead);
      assert.equal(successor.status, 'committed');
      const bound = (await admin.query(`select committed_currentness_vector from
        public.clued_context_checkpoints where id=$1`, [successor.checkpoint_id])).rows[0];
      assert.equal(bound.committed_currentness_vector.schema, 'clued.currentness-vector.v1');
      const p = await f.project('0.4.0 production terminal');
      await f.record(p.scope, 'state', '0.4.0 deployed',
        { state_kind: 'frontier', terminal: true });
      const projectRead = await f.restore(p.scope);
      assert.equal(projectRead.currentness_evaluation.overall, 'CURRENT');
      const globalRead = await f.restore('global');
      assert.equal(globalRead.currentness_evaluation.overall, 'STALE');
      const currentRows = await f.rpc('clued_record_list', {
        level: 'global', record_type: 'state',
      });
      assert.deepEqual(currentRows.records, []);
      const historyRows = await f.rpc('clued_record_list', {
        level: 'global', record_type: 'state', include_history: true,
      });
      assert.equal(historyRows.records[0].projection_currentness, 'STALE');
      assert.equal(historyRows.records[0].authoritative, false);
      const currentSearch = await f.rpc('clued_mcp_search_context', {
        context_key: 'global', session_token: globalRead.session_token,
        query: 'NOT_DEPLOYED', include_history: false,
      });
      assert.equal(currentSearch.results.some((row) => row.kind === 'record' &&
        row.id === frontier), false);
      const historicalSearch = await f.rpc('clued_mcp_search_context', {
        context_key: 'global', session_token: globalRead.session_token,
        query: 'NOT_DEPLOYED', include_history: true,
      });
      const oldText = await f.checkpoint('global', globalRead, {
        snapshot: { release: '0.3.3 / NOT_DEPLOYED' },
        next_action: '0.3.3 / NOT_DEPLOYED',
        coverage: { mode: 'explicit', contexts: ['global'],
          tracks: ['irrelevant-track'], event_ids: [] },
      });
      if (oldText.status === 'committed') {
        const saved = (await admin.query(`select currentness_admission_status from
          public.clued_context_checkpoints where id=$1`, [oldText.checkpoint_id])).rows[0];
        assert.equal(saved.currentness_admission_status, 'CONTINUITY_COMMITTED_NOT_CURRENT');
        const afterOldText = await f.restore('global');
        assert.equal(afterOldText.currentness_evaluation.overall, 'STALE');
        assert.equal(afterOldText.effective_next_action, null);
      } else {
        assert.equal(oldText.status, 'conflict');
        assert.equal(oldText.error, 'current_truth_changed_since_resume');
      }
      assert.ok(historicalSearch.results.some((row) => row.kind === 'record' &&
        row.id === frontier && row.authoritative === false),
      JSON.stringify(historicalSearch.results));
    });

    await t.test('T-CUR-32: ambiguous now Tasks expose sources and never pick a winner', async () => {
      const f = await fixture();
      const p = await f.project('Ambiguous action project');
      const first = await f.record(p.scope, 'task', 'Now task one',
        { execution_bucket: 'now', priority: 50 });
      const second = await f.record(p.scope, 'task', 'Imported task two',
        { execution_bucket: 'next', priority: 50 });
      // A legacy imported row can bypass the M1 single-now authoring rule.
      // The resolver still has to fail closed when it reads this real data.
      await admin.query('drop index public.clued_now_project_uidx');
      await admin.query(`update public.clued_memories set
        type_fields=jsonb_set(type_fields,'{execution_bucket}','"now"'::jsonb),
        version=version+1,updated_at=now() where id=$1`, [second]);
      const response = await f.restore(p.scope);
      assert.equal(response.authoritative_current_action.status, 'AMBIGUOUS');
      assert.equal(response.effective_next_action, null);
      assert.deepEqual(new Set(response.authoritative_current_action.source_refs
        .map((ref) => ref.id)), new Set([first, second]));
    });

    await t.test('T-CUR-18: account HTTP and Binding core parity; retired OAuth fails closed', async () => {
      const f = await fixture();
      const record = await f.record('global', 'decision', 'Transport parity decision',
        { rationale: 'Same owner fixture' });
      const user = server.getPgClient();
      clients.push(user);
      await user.connect();
      await user.query('set role authenticated');
      await user.query("select set_config('request.jwt.claim.sub',$1,false)", [f.userId]);
      const input = { level: 'global', record_type: 'decision' };
      const binding = await f.rpc('clued_record_list', input);
      const account = (await user.query('select public.clued_user_record_list($1) value',
        [input])).rows[0].value;
      assert.deepEqual(account.records, binding.records);
      assert.equal(binding.records[0].id, record);
      await user.query(`select set_config('request.jwt.claims',
        '{"client_id":"retired-legacy-client"}',false)`);
      await assert.rejects(() => user.query(`select public.clued_oauth_call($1,$2)`,
        ['clued_record_list', input]), /legacy_oauth_requires_new_provider_reauthorization/);
    });

    await t.test('T-CUR-36/65: observation and absorption cannot clear LEGACY_UNBOUND', async () => {
      const f = await fixture();
      const old = await f.restore('global');
      const sessionId = (await admin.query(`select id from public.clued_continuity_sessions
        where token_hash=encode(extensions.digest($1,'sha256'),'hex')`,
      [old.session_token])).rows[0].id;
      const eventId = (await admin.query(`insert into public.clued_context_events
        (user_id,context_key,session_id,binding_id,event_type,payload,audit_visibility)
        values($1,'global',$2,$3,'decision','{"marker":"legacy-unbound"}'::jsonb,null)
        returning id`, [f.userId, sessionId, f.bindingId])).rows[0].id;
      await admin.query(`update clued_private.event_truth_carriers set
        carrier_state='LEGACY_UNBOUND',source_kind='legacy' where event_id=$1`, [eventId]);
      const fresh = await f.restore('global');
      assert.equal(fresh.currentness_evaluation.authoritative, false);
      const observation = await f.rpc('clued_mcp_session_reconcile', {
        context_key: 'global', session_token: fresh.session_token,
      });
      assert.equal(observation.receipt_kind, 'CURRENTNESS_OBSERVATION');
      assert.equal(observation.admission_eligible, false);
      const committed = await f.checkpoint('global', fresh, {
        coverage: { mode: 'explicit', contexts: ['global'],
          tracks: ['irrelevant-track'], event_ids: [Number(eventId)] },
      });
      assert.equal(committed.status, 'committed');
      const saved = (await admin.query(`select currentness_admission_status from
        public.clued_context_checkpoints where id=$1`, [committed.checkpoint_id])).rows[0];
      assert.equal(saved.currentness_admission_status, 'CONTINUITY_COMMITTED_NOT_CURRENT');
      assert.equal((await admin.query(`select carrier_state from clued_private.event_truth_carriers
        where event_id=$1`, [eventId])).rows[0].carrier_state, 'LEGACY_UNBOUND');
      assert.equal((await f.restore('global')).currentness_evaluation.authoritative, false);
    });

    await t.test('T-CUR-37: source digest is JSON canonical and client claims are ignored', async () => {
      const f = await fixture();
      const first = (await admin.query(`select clued_private.currentness_hash(
        '{"scope":{"authority_revision":3,"snapshot_revision":2},"context_key":"global"}'::jsonb) value`)).rows[0].value;
      const reordered = (await admin.query(`select clued_private.currentness_hash(
        '{"context_key":"global","scope":{"snapshot_revision":2,"authority_revision":3}}'::jsonb) value`)).rows[0].value;
      assert.equal(first, reordered);
      const restored = await f.restore('global');
      const admission = await f.rpc('clued_mcp_session_reconcile', {
        context_key: 'global', session_token: restored.session_token,
        currentness_vector_digest: '0'.repeat(64),
      });
      assert.notEqual(admission.currentness_vector_digest, '0'.repeat(64));
      assert.equal(admission.admission_eligible, true);
    });

    await t.test('T-CUR-41/42/43: direct material Events advance only their visible dimensions', async () => {
      const f = await fixture();
      const p = await f.project('Direct Event project');
      const initialProject = await f.restore(p.scope);
      assert.equal((await f.checkpoint(p.scope, initialProject)).status, 'committed');
      const projectSession = await f.restore(p.scope);
      const globalSession = await f.restore('global');
      const globalBefore = (await admin.query(`select authority_revision from
        clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [f.userId])).rows[0]?.authority_revision ?? 0;
      const globalDecision = await f.rpc('clued_mcp_append_event', {
        context_key: 'global', session_token: globalSession.session_token,
        base_version: globalSession.version, event_type: 'decision',
        payload: { marker: 'direct-global-decision' }, idempotency_key: uuid(),
      });
      assert.equal(globalDecision.status, 'appended');
      const globalAfter = (await admin.query(`select authority_revision from
        clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [f.userId])).rows[0].authority_revision;
      assert.equal(Number(globalAfter), Number(globalBefore) + 1);
      assert.equal((await f.restore(p.scope)).currentness_evaluation.overall, 'STALE');
      const oldCheckpoint = await f.checkpoint(p.scope, projectSession);
      assert.equal(oldCheckpoint.error, 'current_truth_changed_since_resume');
      const currentProject = await f.restore(p.scope);
      const projectBlocker = await f.rpc('clued_mcp_append_event', {
        context_key: p.scope, session_token: currentProject.session_token,
        base_version: currentProject.version, event_type: 'blocker',
        payload: { marker: 'project-blocker' }, idempotency_key: uuid(),
      });
      assert.equal(projectBlocker.status, 'appended');
      const aggregate = (await admin.query(`select invalidation_revision,
        resolved_through_revision from clued_private.projection_invalidation_heads
        where user_id=$1 and target_scope='global' and projection_key='global.__aggregate__'`,
      [f.userId])).rows[0];
      assert.ok(Number(aggregate.invalidation_revision) > Number(aggregate.resolved_through_revision));
      const beforeRecord = (await admin.query(`select snapshot_revision from
        clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [f.userId])).rows[0].snapshot_revision;
      await f.record('global', 'decision', 'Generated Event once', { rationale: 'fixture' });
      const afterRecord = (await admin.query(`select snapshot_revision from
        clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [f.userId])).rows[0].snapshot_revision;
      assert.equal(Number(afterRecord), Number(beforeRecord) + 1);
    });

    await t.test('T-CUR-58: a note cannot claim action authority; unknown action stays scoped', async () => {
      const f = await fixture();
      const a = await f.project('Unknown action A');
      const b = await f.project('Independent action B');
      await f.record(a.scope, 'task', 'A canonical action', { execution_bucket: 'now' });
      await f.record(b.scope, 'task', 'B canonical action', { execution_bucket: 'now' });
      const a0 = await f.restore(a.scope);
      const b0 = await f.restore(b.scope);
      assert.equal((await f.checkpoint(a.scope, a0)).status, 'committed');
      assert.equal((await f.checkpoint(b.scope, b0)).status, 'committed');
      const aSession = await f.restore(a.scope);
      await f.rpc('clued_mcp_append_event', {
        context_key: a.scope, session_token: aSession.session_token,
        base_version: aSession.version, event_type: 'action',
        payload: { marker: 'unknown-action' }, idempotency_key: uuid(),
      });
      const aAfter = await f.restore(a.scope);
      const bAfter = await f.restore(b.scope);
      assert.equal(aAfter.currentness_evaluation.overall, 'STALE');
      assert.equal(aAfter.effective_next_action, null);
      assert.equal(bAfter.currentness_evaluation.overall, 'CURRENT');
      assert.equal(bAfter.effective_next_action?.title, 'B canonical action');
      const noteSession = await f.restore(b.scope);
      await f.rpc('clued_mcp_append_event', {
        context_key: b.scope, session_token: noteSession.session_token,
        base_version: noteSession.version, event_type: 'note',
        payload: { event_type: 'decision', next_action: 'FAKE_NOTE_ACTION' },
        idempotency_key: uuid(),
      });
      const bNote = await f.restore(b.scope);
      assert.equal(bNote.effective_next_action?.title, 'B canonical action');
    });

    await t.test('T-CUR-44: malformed dependency is unknown, typed A→B is scoped', async () => {
      const f = await fixture();
      const a = await f.project('Dependency A');
      const b = await f.project('Dependency B');
      const c = await f.project('Dependency C');
      const source = await f.record(a.scope, 'task', 'A task', { execution_bucket: 'next' });
      const dependent = await f.record(b.scope, 'task', 'B task',
        { execution_bucket: 'now' }, { depends_on: [source] });
      const bBefore = await f.restore(b.scope);
      const cBefore = await f.restore(c.scope);
      assert.equal((await f.checkpoint(b.scope, bBefore)).status, 'committed');
      assert.equal((await f.checkpoint(c.scope, cBefore)).status, 'committed');
      await f.update(a.scope, 'task', source, { content: 'A changed' });
      assert.equal((await f.restore(b.scope)).currentness_evaluation.overall, 'STALE');
      assert.equal((await f.restore(c.scope)).currentness_evaluation.overall, 'CURRENT');
      await admin.query(`update public.clued_memories set relations='{"depends_on":{"untyped":"edge"}}'::jsonb,
        version=version+1 where id=$1`, [dependent]);
      const bindingId = f.bindingId;
      const unknownVector = (await admin.query(`select clued_private.currentness_vector($1,$2,$3) value`,
        [f.userId, b.scope, bindingId])).rows[0].value;
      assert.equal(unknownVector.dependency_unknown, true);
      assert.equal((await f.restore(b.scope)).currentness_evaluation.authoritative, false);
    });

    await t.test('T-CUR-56: materialization rejects wrong owner/scope/version/state and replays once', async () => {
      const f = await fixture();
      const initial = await f.restore('global');
      const event = await f.rpc('clued_mcp_append_event', {
        context_key: 'global', session_token: initial.session_token,
        base_version: initial.version, event_type: 'decision',
        payload: { marker: 'materialization-source' }, idempotency_key: uuid(),
      });
      assert.equal(event.status, 'appended');
      const create = (owner, scope, title, relation, key = uuid()) => owner.rpc('clued_record_mutate', {
        operation: 'create', id: uuid(), record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope,
        idempotency_key: key, authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Materialization binding regression',
        source_refs: [], source_unavailable_reason: null,
        mutation: { title, content: title, type_fields: { rationale: 'fixture' },
          relations: relation },
      });
      const carrier = async () => (await admin.query(`select carrier_state,transition_version
        from clued_private.event_truth_carriers where event_id=$1`, [event.event_id])).rows[0];
      const revisionBefore = (await admin.query(`select snapshot_revision from
        clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [f.userId])).rows[0].snapshot_revision;
      assert.equal((await create(f, 'global', 'wrong id', {
        materializes_event: { id: Number(event.event_id) + 100000, version: event.version },
      })).status, 'rejected');
      assert.equal((await create(f, 'global', 'wrong version', {
        materializes_event: { id: event.event_id, version: Number(event.version) + 1 },
      })).status, 'rejected');
      const p = await f.project('Wrong materialization scope');
      assert.equal((await create(f, p.scope, 'wrong scope', {
        materializes_event: { id: event.event_id, version: event.version },
      })).status, 'rejected');
      const other = await fixture();
      assert.equal((await create(other, 'global', 'wrong owner', {
        materializes_event: { id: event.event_id, version: event.version },
      })).status, 'rejected');
      assert.equal((await carrier()).carrier_state, 'ACTIVE_UNSTRUCTURED');
      const forged = await create(f, 'global', 'forged resolve marker', {
        resolves_event: event.event_id,
      });
      assert.equal(forged.status, 'committed');
      assert.equal((await carrier()).carrier_state, 'ACTIVE_UNSTRUCTURED');
      const validKey = uuid();
      const validInput = {
        operation: 'create', id: uuid(), record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
        idempotency_key: validKey, authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Materialization binding regression',
        source_refs: [], source_unavailable_reason: null,
        mutation: { title: 'Legitimate materialization', content: 'Legitimate materialization',
          type_fields: { rationale: 'fixture' }, relations: {
            materializes_event: { id: event.event_id, version: event.version },
          } },
      };
      const valid = await f.rpc('clued_record_mutate', validInput);
      assert.equal(valid.status, 'committed', JSON.stringify(valid));
      const after = await carrier();
      assert.equal(after.carrier_state, 'MATERIALIZED_TO_RECORD');
      const replay = await f.rpc('clued_record_mutate', validInput);
      assert.equal(replay.status, 'committed');
      assert.deepEqual(await carrier(), after);
      const revisionAfter = (await admin.query(`select snapshot_revision from
        clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [f.userId])).rows[0].snapshot_revision;
      assert.equal(Number(revisionAfter), Number(revisionBefore) + 2);
      const secondEvent = await f.rpc('clued_mcp_append_event', {
        context_key: 'global', session_token: initial.session_token,
        base_version: event.version, event_type: 'decision',
        payload: { marker: 'already-resolved-source' }, idempotency_key: uuid(),
      });
      assert.equal(secondEvent.status, 'appended');
      await admin.query(`update clued_private.event_truth_carriers set
        carrier_state='RESOLVED_CONTINUITY_ONLY' where event_id=$1`,
      [secondEvent.event_id]);
      assert.equal((await create(f, 'global', 'resolved source', {
        materializes_event: { id: secondEvent.event_id, version: secondEvent.version },
      })).status, 'rejected');
      assert.equal((await admin.query(`select carrier_state from
        clued_private.event_truth_carriers where event_id=$1`,
      [secondEvent.event_id])).rows[0].carrier_state, 'RESOLVED_CONTINUITY_ONLY');
    });

    await t.test('T-CUR-62: two Bindings see the same atomic carrier fence', async () => {
      const f = await fixture();
      const secondToken = hash();
      await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','Second host fixture',$2,
          array['context:read','context:write'],array['global'])`,
      [f.userId, secondToken]);
      const secondRpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) value`,
        [secondToken, input])).rows[0].value;
      const decision = await f.record('global', 'decision', 'Before append',
        { rationale: 'two host fixture' });
      const read = (rpc) => rpc('clued_record_list', {
        level: 'global', record_type: 'decision',
      });
      const before = await Promise.all([read(f.rpc), read(secondRpc)]);
      assert.deepEqual(before[0], before[1]);
      assert.equal(before[0].records[0].id, decision);
      const session = await f.restore('global');
      await admin.query('begin');
      try {
        await admin.query(`insert into public.clued_context_events
          (user_id,context_key,session_id,binding_id,event_type,payload,audit_visibility)
          values($1,'global',
            (select id from public.clued_continuity_sessions
              where token_hash=encode(extensions.digest($2,'sha256'),'hex')),
            $3,'decision','{"marker":"two-host-append"}'::jsonb,'work_log')`,
        [f.userId, session.session_token, f.bindingId]);
        const preCommit = await Promise.all([read(f.rpc), read(secondRpc)]);
        assert.deepEqual(preCommit[0], before[0]);
        assert.deepEqual(preCommit[1], before[1]);
        await admin.query('commit');
      } catch (error) {
        await admin.query('rollback').catch(() => {});
        throw error;
      }
      const after = await Promise.all([read(f.rpc), read(secondRpc)]);
      assert.deepEqual(after[0], after[1]);
      assert.deepEqual(after[0].records, []);
    });

    await t.test('T-CUR-64: missing inventoried candidate invalidates receipt and G6', async () => {
      const f = await fixture();
      const p = await f.project('Inventory gate project');
      const session = await f.restore('global');
      const source = (await admin.query(`insert into public.clued_context_events
        (user_id,context_key,session_id,binding_id,event_type,payload,audit_visibility)
        values($1,'global',
          (select id from public.clued_continuity_sessions
            where token_hash=encode(extensions.digest($2,'sha256'),'hex')),
          $3,'decision','{"marker":"absorbed-unreferenced-legacy"}'::jsonb,'work_log')
        returning id`, [f.userId, session.session_token, f.bindingId])).rows[0].id;
      const absorbedSession = await f.restore('global');
      const absorbed = await f.checkpoint('global', absorbedSession, {
        coverage: { mode: 'explicit', contexts: ['global'],
          tracks: ['legacy-inventory'], event_ids: [Number(source)] },
      });
      assert.equal(absorbed.status, 'committed');
      assert.equal((await admin.query(`select count(*)::integer n from
        public.clued_checkpoint_event_absorptions where event_id=$1`,
      [source])).rows[0].n, 1);
      const batch = uuid();
      await admin.query(`update clued_private.legacy_inventory_epoch
        set cutover_event_id=$1 where id`, [source]);
      await admin.query(`insert into clued_private.legacy_event_candidates
        (event_id,user_id,raw_context_key,canonical_scope,event_type,event_version,
         visibility,dimensions,occurred_at,disposition,disposition_evidence,inventory_batch_id)
        select e.id,e.user_id,e.context_key,'global',e.event_type,e.version,
          'work_log',array['decision'],e.occurred_at,'LEGACY_ACTIVE_UNSTRUCTURED',
          '{"checkpoint_absorption_ignored":true}'::jsonb,$2
        from public.clued_context_events e where e.id=$1`, [source, batch]);
      await admin.query(`insert into clued_private.legacy_carrier_inventory_receipts
        (batch_id,user_id,raw_context_key,source_baseline,migration_schema_version,
         candidate_count,lower_event_id,upper_event_id,disposition_counts,
         unbound_impacts,inventory_sha256,scan_completed_revision,append_cutover_revision)
        select $2,c.user_id,c.raw_context_key,'synthetic-raw-source','20260922092810',
          1,c.event_id,c.event_id,'{"LEGACY_ACTIVE_UNSTRUCTURED":1}'::jsonb,
          '[]'::jsonb,pg_catalog.encode(extensions.digest(jsonb_build_object(
          'event_id',c.event_id,'owner',c.user_id,'raw_context',c.raw_context_key,
          'canonical_scope',c.canonical_scope,'event_type',c.event_type,
          'event_version',c.event_version,'source_receipt',c.source_receipt_id,
          'visibility',c.visibility,'dimensions',c.dimensions,
          'occurred_at',c.occurred_at,'disposition',c.disposition)::text,'sha256'),'hex'),
          c.event_id,c.event_id
        from clued_private.legacy_event_candidates c where c.event_id=$1`,
      [source, batch]);
      const complete = async () => (await admin.query(`select
        clued_private.legacy_inventory_complete($1) value`, [f.userId])).rows[0].value;
      assert.equal(await complete(), true);
      await admin.query(`delete from clued_private.legacy_event_candidates where event_id=$1`,
        [source]);
      assert.equal(await complete(), false);
      const gate = await f.rpc('clued_mcp_currentness_g6_gate', { project_id: p.id });
      assert.equal(gate.status, 'not_ready');
      assert.ok(gate.missing_requirements.includes('legacy_inventory_or_unbound'));
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
