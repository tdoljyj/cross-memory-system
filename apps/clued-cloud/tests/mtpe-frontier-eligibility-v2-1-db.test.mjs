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
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

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

test('frontier eligibility v2.1 resolves an empty frontier as NONE and narrows the title fallback',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-mtpe-eligibility-v21-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const hostToken = hash();
    const builderToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'mtpe-v21@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Host',$2,array['context:read','context:write','audit:read'],array['*'])`,
    [userId, hostToken]);
    const builderId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'system','MTPE Projection Builder',$2,array['context:read'],array['*']) returning id`,
    [userId, builderToken])).rows[0].id;
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','owner-approved-test'),
            ($1,$2,'global','global.__aggregate__','owner-approved-test')`, [builderId, userId]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = async (token, name, input = {}) =>
      await workerGatewayRpc(workerCaller, name, token, input);
    const write = (input) => rpc(hostToken, 'clued_record_mutate', input);
    const snapshot = () => rpc(hostToken, 'clued_mcp_mtpe_snapshot');
    const validate = () => rpc(hostToken, 'clued_mcp_mtpe_validate');
    const row = (view, id) => view.candidate_universe.find((entry) => entry.record_id === id);
    const frontierProjection = async () => (await admin.query(`select type_fields
      from public.clued_memories where user_id=$1 and record_type='state'
        and type_fields->>'projection_key'='global.priority_frontier'`, [userId])).rows[0]?.type_fields;
    const rebuildFrontier = async () => {
      await admin.query(`update clued_private.projection_refresh_jobs
        set next_attempt_at=case when projection_key='global.priority_frontier'
          then now() else now()+interval '1 hour' end where user_id=$1`, [userId]);
      const claim = await rpc(builderToken, 'clued_mcp_projection_refresh_claim');
      assert.equal(claim.projection_key, 'global.priority_frontier', JSON.stringify(claim));
      return rpc(builderToken, 'clued_mcp_projection_refresh_apply', {
        projection_key: claim.projection_key, lease_id: claim.lease_id,
        expected_invalidation_revision: claim.expected_invalidation_revision,
        expected_source_vector_digest: claim.expected_source_vector_digest,
      });
    };

    // Project-scoped fixtures avoid clued_now_global_uidx (one global 'now' Task per user).
    const projectId = uuid();
    const scope = `project:${projectId}`;
    assert.equal((await rpc(hostToken, 'clued_project_mutate_v2', {
      operation: 'create', canonical_project_id: projectId, project_schema_version: 2,
      idempotency_key: uuid(),
      mutation: { name: 'MTPE Eligibility', progress_status: 'active' },
    })).status, 'committed');
    const createTask = async (title, typeFields) => {
      const id = uuid();
      const result = await write({
        operation: 'create', id, record_type: 'task', record_schema_version: 1,
        lifecycle_status: 'active', scope, idempotency_key: uuid(),
        authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Frontier eligibility fixture', source_refs: [],
        source_unavailable_reason: null,
        mutation: { title, content: title, type_fields: typeFields, relations: {} },
      });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return id;
    };

    const urgent = { criticality: 'CRITICAL', priority: 100, current_frontier_blocking: true,
      downstream_unlock_value: 15, user_product_impact: 15, time_sensitivity: 10 };
    const g6ActionMissing = async () => (await rpc(hostToken, 'clued_mcp_currentness_g6_gate', {
      project_id: projectId })).missing_requirements?.includes('authoritative_current_action') ?? false;
    const globalAction = async () => (await admin.query(
      "select clued_private.authoritative_current_action_v1($1,'global') value", [userId])).rows[0].value;

    // 1. Title fallback: Tasks only, negations are not holds, structured release wins,
    //    and only the hyphenated / underscored do-not-recommend token counts.
    const releasedId = await createTask('解除暂缓：恢复推进原型', { execution_bucket: 'next' });
    const resumedId = await createTask('不再搁置名字收敛', { execution_bucket: 'next' });
    const overrideId = await createTask('方案评审——暂缓',
      { execution_bucket: 'next', hold_status: 'NONE' });
    const proseId = await createTask('Why we do not recommend option X', { execution_bucket: 'next' });
    const titleHeldId = await createTask('确认名字收敛——暂缓：Owner 暂时不考虑推动',
      { execution_bucket: 'next' });
    const structuredId = await createTask('Structured later task',
      { execution_bucket: 'later', hold_status: 'NONE' });
    const decisionId = uuid();
    assert.equal((await write({
      operation: 'create', id: decisionId, record_type: 'decision', record_schema_version: 1,
      lifecycle_status: 'active', scope, idempotency_key: uuid(), authority: 'user_explicit',
      user_confirmed: true, confidence_reason: 'Non-Task title fixture', source_refs: [],
      source_unavailable_reason: null,
      mutation: { title: '决定搁置方案B', content: 'Follow up', relations: {},
        type_fields: { ...urgent, rationale: 'Title fixture', decision_follow_up: true } },
    })).status, 'committed');
    const first = await snapshot();
    assert.equal(first.eligibility_rule, 'mtpe-frontier-eligibility.v2.1');
    for (const id of [releasedId, resumedId, overrideId, proseId, decisionId]) {
      assert.equal(row(first, id).recommendation_hold, null, id);
    }
    assert.equal(row(first, titleHeldId).recommendation_hold, 'TITLE_HOLD_MARKER');
    assert.equal(row(first, structuredId).recommendation_hold, 'EXECUTION_BUCKET_LATER');
    assert.equal(first.system_recommended_priority.record_id, decisionId,
      'a non-Task title must not suppress the system recommended priority');
    const validation = await validate();
    assert.equal(validation.status, 'pass', JSON.stringify(validation));
    assert.equal(validation.title_only_hold, 1);
    assert.deepEqual(validation.title_only_hold_ids, [titleHeldId]);

    // 2. A current explicit empty Frontier resolves as NONE for every read surface.
    for (const id of [releasedId, resumedId, overrideId, proseId]) {
      assert.equal((await write({
        operation: 'close', id, record_type: 'task', record_schema_version: 1,
        lifecycle_status: 'completed', scope, base_version: 1, idempotency_key: uuid(),
        authority: 'observed', confidence_reason: 'Leave only held candidates',
        mutation: { closure_summary: 'Done' },
      })).status, 'committed');
    }
    const empty = await snapshot();
    assert.equal(empty.frontier_status, 'NO_ELIGIBLE_CANDIDATE');
    const rebuilt = await rebuildFrontier();
    assert.equal(rebuilt.status, 'rebuilt', JSON.stringify(rebuilt));
    assert.equal(rebuilt.frontier_status, 'NO_ELIGIBLE_CANDIDATE');
    const source = (await admin.query('select clued_private.frontier_task_source_v2($1,$2) value',
      [userId, await frontierProjection()])).rows[0].value;
    assert.equal(source.status, 'NONE');
    assert.equal(source.action, null);
    assert.equal(source.reason, 'NO_ELIGIBLE_FRONTIER_CANDIDATE');
    const action = await globalAction();
    assert.equal(action.status, 'NONE', JSON.stringify(action));
    assert.equal(action.reason, 'NO_ELIGIBLE_FRONTIER_CANDIDATE');
    assert.equal(await g6ActionMissing(), false,
      'a current empty Frontier must not be reported as a missing authoritative action');
    // A newly eligible Task makes the stored empty Frontier stale again.
    const revivedId = await createTask('Newly eligible task', { execution_bucket: 'next' });
    assert.equal((await admin.query('select clued_private.frontier_task_source_v2($1,$2) value',
      [userId, await frontierProjection()])).rows[0].value.status, 'PROJECTION_REQUIRED');
    assert.equal((await rebuildFrontier()).frontier_status, 'SELECTED');
    assert.equal((await frontierProjection()).source_task.id, revivedId);

    // 3. The regression suite also passes for a user who already has a global 'now' Task.
    await admin.query(`insert into public.clued_memories(user_id,title,content,record_type,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,
        authority,confidence_reason,content_hash)
      values($1,'Existing global now','fixture','task',1,'active','global',
        '{"execution_bucket":"now"}','{}','{}','observed','existing now fixture',repeat('0',64))`,
    [userId]);
    const suite = (await admin.query('select clued_private.mtpe_frontier_regression_suite($1) value',
      [userId])).rows[0].value;
    assert.equal(suite.status, 'pass', JSON.stringify(suite));
    assert.equal(suite.classification.length, 19);
    assert.notEqual(suite.end_to_end.find((entry) => entry.case === 'E02 held never selected').got,
      null, 'with a current global scope the ready control must be selected');

    // ...and while an active work_log carrier shadows the whole global scope (the state
    // production was in when v2.1 was first applied): nothing global is selectable then.
    assert.equal((await write({
      operation: 'close', id: revivedId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'completed', scope, base_version: 1, idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'Leave no selectable project Task',
      mutation: { closure_summary: 'Done' },
    })).status, 'committed');
    const restored = await rpc(hostToken, 'clued_mcp_restore', {
      context_key: 'global', response_view: 'structured' });
    const shadowEvent = await rpc(hostToken, 'clued_mcp_append_event', {
      context_key: 'global', session_token: restored.session_token, base_version: restored.version,
      event_type: 'action', payload: { marker: 'direct work_log action' }, idempotency_key: uuid(),
    });
    assert.equal(shadowEvent.status, 'appended', JSON.stringify(shadowEvent));
    assert.equal((await admin.query(`select carrier_state from clued_private.event_truth_carriers
      where event_id=$1`, [shadowEvent.event_id])).rows[0].carrier_state, 'ACTIVE_UNSTRUCTURED');
    const shadowedSuite = (await admin.query(
      'select clued_private.mtpe_frontier_regression_suite($1) value', [userId])).rows[0].value;
    assert.equal(shadowedSuite.status, 'pass', JSON.stringify(shadowedSuite));
    assert.equal(shadowedSuite.end_to_end.find((entry) => entry.case === 'E02 held never selected').got,
      null, 'the shadowed ready control cannot be selected, and that must not fail the gate');
    assert.equal((await admin.query(`select count(*)::int n from public.clued_memories
      where user_id=$1 and title like 'MTPE-REG%'`, [userId])).rows[0].n, 0);

    // 4. Grants: the suite and the continuity contract are private to the owner role.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const signature of ['clued_private.mtpe_frontier_regression_suite(uuid)',
        'clued_private.mtpe_recommendation_hold(jsonb,text)',
        'clued_private.reconcile_approved_direct_event_continuity_once_v1(uuid,text,uuid,uuid,boolean)']) {
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
          [role, signature])).rows[0].ok, false, `${role} ${signature}`);
      }
    }

    // 5. The direct-Event continuity contract is bound to its manifest owner and fails
    //    closed when the exact Events are absent or changed; execution needs approval.
    await assert.rejects(() => admin.query(
      'select clued_private.reconcile_approved_direct_event_continuity_once_v1($1)', [userId]),
    /direct_continuity_owner_invalid/);
    const owner = '2ddd1804-b1e5-4916-89fb-3b87fae11ee6';
    await assert.rejects(() => admin.query(
      'select clued_private.reconcile_approved_direct_event_continuity_once_v1($1)', [owner]),
    /direct_continuity_source_changed event=1218/);
    await assert.rejects(() => admin.query(
      'select clued_private.reconcile_approved_direct_event_continuity_once_v1($1,null,null,null,true)',
      [owner]), /direct_continuity_approval_required/);
    await assert.rejects(() => admin.query(
      `select clued_private.reconcile_approved_direct_event_continuity_once_v1($1,$2,$3,$4,true)`,
      [owner, '0'.repeat(64), uuid(), uuid()]), /direct_continuity_manifest_digest_mismatch/);
    // Reapply the actual formal closeout after all fixture scenarios; no skip.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
