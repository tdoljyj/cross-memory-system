import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');


test('frontier eligibility v2 keeps backlog / later / 暂缓 / do-not-recommend Tasks out of the NOW',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-mtpe-eligibility-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
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
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'mtpe-v2@example.invalid',now())", [userId]);
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
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) value`, [token,input])).rows[0].value
        : await workerGatewayRpc(workerCaller, name, token, input);
    const write = (input) => rpc(hostToken, 'clued_record_mutate', input);
    const snapshot = () => rpc(hostToken, 'clued_mcp_mtpe_snapshot');
    const validate = () => rpc(hostToken, 'clued_mcp_mtpe_validate');
    const pin = (operation, recordId, baseVersion, expectedFocus = null) =>
      rpc(hostToken, 'clued_mcp_mtpe_owner_pin', {
        operation, record_id: recordId, base_version: baseVersion,
        ...(operation === 'set' ? { expected_current_focus_id: expectedFocus } : {}),
        idempotency_key: uuid(), user_confirmed: true, reason: 'Owner focus fixture',
      });
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

    // Project-scoped fixtures avoid clued_now_global_uidx (one global 'now' Task
    // per user); the regression suite below creates its own global 'now' control.
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
    // Legacy writers bypassed the M1 bucket vocabulary; reproduce that shape directly.
    const rewriteFields = (id, patch) => admin.query(`update public.clued_memories
      set type_fields=type_fields||$2::jsonb,version=version+1,updated_at=now()
      where id=$1`, [id, JSON.stringify(patch)]);

    const urgent = { criticality: 'CRITICAL', priority: 100, current_frontier_blocking: true,
      downstream_unlock_value: 15, user_product_impact: 15, time_sensitivity: 10 };
    const readyId = await createTask('Ready normal task',
      { execution_bucket: 'next', criticality: 'NORMAL', priority: 30, user_product_impact: 4 });
    const laterId = await createTask('Later urgent task', { ...urgent, execution_bucket: 'later' });
    const backlogId = await createTask('Backlog urgent task', { ...urgent, execution_bucket: 'next' });
    await rewriteFields(backlogId, { execution_bucket: 'backlog' });
    const titleHoldId = await createTask(
      '确认「当前最重要的一件事」：原型 / 剧情 / 名字收敛——暂缓：Owner 暂时不考虑推动',
      { ...urgent, execution_bucket: 'next' });
    const dnrId = await createTask('Do-not-recommend urgent task',
      { ...urgent, execution_bucket: 'next', do_not_recommend: true });
    const held = new Map([
      [laterId, 'EXECUTION_BUCKET_LATER'], [backlogId, 'EXECUTION_BUCKET_BACKLOG'],
      [titleHoldId, 'TITLE_HOLD_MARKER'], [dnrId, 'DO_NOT_RECOMMEND'],
    ]);

    // 1. Held Tasks outrank the ready control yet never become the NOW or the
    //    system recommended priority, and are projected DEFERRED, never READY.
    const first = await snapshot();
    assert.match(first.eligibility_rule, /^mtpe-frontier-eligibility\.v2(\.\d+)?$/);
    assert.equal(first.frontier_status, 'SELECTED');
    for (const [id, code] of held) {
      const entry = row(first, id);
      assert.equal(entry.recommendation_hold, code, id);
      assert.equal(entry.executability, 'DEFERRED', id);
      assert.equal(entry.candidate_status, 'DEFERRED_WITH_TRIGGER', id);
      assert.ok(entry.algorithm_priority > row(first, readyId).algorithm_priority,
        'the held fixture must outrank the ready control for this test to be meaningful');
    }
    assert.equal(first.selected_frontier.record_id, readyId);
    assert.equal(first.selected_frontier.selection_source, 'SYSTEM_RECOMMENDED');
    assert.equal(first.system_recommended_frontier.record_id, readyId);
    assert.equal(first.system_recommended_priority.record_id, readyId);
    const firstValidation = await validate();
    assert.equal(firstValidation.status, 'pass', JSON.stringify(firstValidation));
    assert.equal(firstValidation.held_projected_ready, 0);
    assert.equal(firstValidation.frontier_eligibility_violation, 0);
    const selectedRebuild = await rebuildFrontier();
    assert.equal(selectedRebuild.status, 'rebuilt', JSON.stringify(selectedRebuild));
    assert.equal(selectedRebuild.frontier_status, 'SELECTED');
    assert.equal((await frontierProjection()).source_task.id, readyId);

    // 2. Owner Pin: setting a held Task is rejected; an existing Pin whose Task is
    //    later held is reported as OWNER_SELECTED_DEFERRED and is not selected.
    const rejected = await pin('set', laterId, 1);
    assert.equal(rejected.status, 'rejected', JSON.stringify(rejected));
    assert.match(JSON.stringify(rejected), /owner_pin_target_deferred/);
    assert.equal((await snapshot()).owner_selected_current_focus, null);
    const pinnedId = await createTask('Owner pinned task',
      { execution_bucket: 'next', criticality: 'HIGH', priority: 60 });
    assert.equal((await pin('set', pinnedId, 1)).status, 'committed');
    assert.equal((await snapshot()).selected_frontier.record_id, pinnedId);
    assert.equal((await write({
      operation: 'update', id: pinnedId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope, base_version: 1, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Owner defers the pinned task',
      mutation: { type_fields: { execution_bucket: 'later', criticality: 'HIGH', priority: 60 } },
    })).status, 'committed');
    const deferredPin = await snapshot();
    assert.equal(deferredPin.owner_selected_current_focus.record_id, pinnedId);
    assert.equal(deferredPin.owner_selected_current_focus.status, 'OWNER_SELECTED_DEFERRED');
    assert.equal(deferredPin.owner_selected_current_focus.recommendation_hold,
      'EXECUTION_BUCKET_LATER');
    assert.equal(deferredPin.selected_frontier.record_id, readyId);
    assert.equal(deferredPin.selected_frontier.selection_source, 'SYSTEM_RECOMMENDED');

    // 3. Legacy boolean priority_eligibility and bare 'BLOCKED' executability are
    //    normalised instead of degrading to UNKNOWN_INVALID.
    const legacyTrueId = await createTask('Legacy eligible blocked task', { execution_bucket: 'next' });
    await rewriteFields(legacyTrueId, { priority_eligibility: true, executability: 'BLOCKED' });
    const legacyFalseId = await createTask('Legacy ineligible task', { execution_bucket: 'next' });
    await rewriteFields(legacyFalseId, { priority_eligibility: false });
    const legacy = (await admin.query(`select record_id,priority_eligibility,executability,
        hard_gate_blockers from clued_private.mtpe_intake_projection
      where record_id=any($1::uuid[]) order by record_id`, [[legacyTrueId, legacyFalseId]])).rows;
    const legacyTrue = legacy.find((entry) => entry.record_id === legacyTrueId);
    const legacyFalse = legacy.find((entry) => entry.record_id === legacyFalseId);
    assert.equal(legacyTrue.priority_eligibility, 'ELIGIBLE');
    assert.equal(legacyTrue.executability, 'BLOCKED_HARD_GATE');
    assert.deepEqual(legacyTrue.hard_gate_blockers.map((entry) => entry.code), ['EXPLICIT_HARD_GATE']);
    assert.equal(legacyFalse.priority_eligibility, 'INELIGIBLE');
    const legacyValidation = await validate();
    assert.equal(legacyValidation.missing_priority, 0, JSON.stringify(legacyValidation));
    assert.equal(legacyValidation.status, 'pass', JSON.stringify(legacyValidation));
    assert.ok(!(await snapshot()).candidate_universe
      .some((entry) => entry.priority_eligibility === 'UNKNOWN_INVALID'));

    // 4. With only held (or blocked) candidates left, the frontier is an explicit
    //    NO_ELIGIBLE_CANDIDATE and the refresh job completes instead of failing.
    assert.equal((await write({
      operation: 'close', id: readyId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'completed', scope, base_version: 1, idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'Ready control completed',
      mutation: { closure_summary: 'Done' },
    })).status, 'committed');
    const empty = await snapshot();
    assert.equal(empty.frontier_status, 'NO_ELIGIBLE_CANDIDATE');
    assert.equal(empty.selected_frontier, null);
    assert.equal(empty.system_recommended_frontier, null);
    assert.ok(!held.has(empty.system_recommended_priority?.record_id));
    assert.equal(empty.owner_selected_current_focus.status, 'OWNER_SELECTED_DEFERRED');
    const emptyRebuild = await rebuildFrontier();
    assert.equal(emptyRebuild.status, 'rebuilt', JSON.stringify(emptyRebuild));
    assert.equal(emptyRebuild.frontier_status, 'NO_ELIGIBLE_CANDIDATE');
    const emptyProjection = await frontierProjection();
    assert.equal(emptyProjection.frontier_status, 'NO_ELIGIBLE_CANDIDATE');
    assert.equal(emptyProjection.source_task, null);
    assert.equal((await admin.query(`select status from clued_private.projection_refresh_jobs
      where user_id=$1 and projection_key='global.priority_frontier'`, [userId])).rows[0].status,
    'completed');
    const heads = (await admin.query(`select invalidation_revision,resolved_through_revision
      from clued_private.projection_invalidation_heads where user_id=$1
        and projection_key='global.priority_frontier'`, [userId])).rows[0];
    assert.equal(heads.resolved_through_revision, heads.invalidation_revision);
    const source = (await admin.query('select clued_private.frontier_task_source_v2($1,$2) value',
      [userId, emptyProjection])).rows[0].value;
    // v2 returned PROJECTION_REQUIRED here; v2.1 resolves a current empty Frontier as NONE.
    assert.equal(source.status, 'NONE');
    assert.equal(source.action, null);
    assert.equal(source.reason, 'NO_ELIGIBLE_FRONTIER_CANDIDATE');
    const emptyValidation = await validate();
    assert.equal(emptyValidation.status, 'pass', JSON.stringify(emptyValidation));
    assert.equal(emptyValidation.frontier_status, 'NO_ELIGIBLE_CANDIDATE');
    assert.equal(emptyValidation.frontier_projection_drift, 0);

    // 5. The in-database regression suite passes and leaves no side effects behind.
    const sideEffects = async () => (await admin.query(`select
        (select jsonb_agg(to_jsonb(i) order by projection_key)
          from clued_private.projection_invalidation_heads i where user_id=$1) heads,
        (select jsonb_agg(jsonb_build_object('key',projection_key,'status',status)
          order by projection_key) from clued_private.projection_refresh_jobs where user_id=$1) jobs,
        (select jsonb_agg(to_jsonb(f)) from clued_private.mtpe_owner_focus f where user_id=$1) focus,
        (select count(*) from public.clued_memories where user_id=$1) records`, [userId])).rows[0];
    const beforeSuite = await sideEffects();
    const suite = (await admin.query('select clued_private.mtpe_frontier_regression_suite($1) value',
      [userId])).rows[0].value;
    assert.equal(suite.status, 'pass', JSON.stringify(suite));
    assert.equal(suite.failures, 0);
    assert.ok(suite.classification.length >= 14);
    assert.ok(suite.end_to_end.length >= 10);
    assert.deepEqual(await sideEffects(), beforeSuite);
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['clued_private.mtpe_frontier_regression_suite(uuid)',
        'clued_private.mtpe_recommendation_hold(jsonb,text)']) {
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
          [role, signature])).rows[0].ok, false, `${role} ${signature}`);
      }
    }

    // 6. A held Owner Pin can still be cancelled, and the explicit empty frontier
    //    stops being current as soon as an eligible Task appears.
    assert.equal((await pin('cancel', pinnedId, 2)).status, 'committed');
    assert.equal((await snapshot()).owner_selected_current_focus, null);
    const revivedId = await createTask('Newly eligible task', { execution_bucket: 'next' });
    const revived = await snapshot();
    assert.equal(revived.frontier_status, 'SELECTED');
    assert.equal(revived.selected_frontier.record_id, revivedId);
    const staleEmpty = (await admin.query('select clued_private.frontier_task_source_v2($1,$2) value',
      [userId, emptyProjection])).rows[0].value;
    assert.equal(staleEmpty.status, 'PROJECTION_REQUIRED');
    assert.equal(staleEmpty.reason, undefined, 'a stale empty frontier must not claim to be current');
    const revivedRebuild = await rebuildFrontier();
    assert.equal(revivedRebuild.frontier_status, 'SELECTED', JSON.stringify(revivedRebuild));
    assert.equal((await frontierProjection()).source_task.id, revivedId);
    // The real formal migration is installed by the full chain and replays
    // unchanged after the original business/concurrency/negative matrix.
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
