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
import { CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

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

test('post-commit projection refresh is coalesced, least-privilege, CAS-safe, and fail-closed',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-projection-refresh-'));
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const writerToken = hash();
    const builderToken = hash();
    const limitedBuilderToken = hash();
    const hostAToken = hash();
    const hostBToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'projection@example.invalid',now())", [userId]);
    const writerId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Canonical Writer',$2,
        array['context:read','context:write','audit:read'],array['*']) returning id`,
    [userId, writerToken])).rows[0].id;
    const builderId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'system','Projection Builder',$2,array['context:read'],array['*']) returning id`,
    [userId, builderToken])).rows[0].id;
    const limitedBuilderId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'system','Frontier-only Builder',$2,array['context:read'],array['*']) returning id`,
    [userId, limitedBuilderToken])).rows[0].id;
    for (const [agent, token] of [['Host A', hostAToken], ['Host B', hostBToken]]) {
      await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read'],array['*'])`, [userId, agent, token]);
    }
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','owner-approved-test'),
            ($1,$2,'global','global.__aggregate__','owner-approved-test')`,
    [builderId, userId]);
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','owner-approved-test')`,
    [limitedBuilderId, userId]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = async (token, name, input) =>
      await workerGatewayRpc(workerCaller,name,token,input);
    const writer = (name, input) => rpc(writerToken, name, input);
    const builder = (name, input = {}) => rpc(builderToken, name, input);

    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    const project = await writer('clued_project_mutate_v2', {
      operation: 'create', canonical_project_id: projectId, project_schema_version: 2,
      recognition: { confidence: 1, reason: 'Explicit synthetic Project fixture', source: 'v2_agent_recognition', source_refs: [] },
      idempotency_key: uuid(),
      mutation: { name: 'Projection Pipeline', progress_status: 'active' },
    });
    assert.equal(project.status, 'committed');
    const taskId = uuid();
    const created = await writer('clued_record_mutate', {
      operation: 'create', id: taskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Owner-approved projection pipeline test',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'MTPE Universal Intake M0', content: 'Task v1',
        type_fields: { execution_bucket: 'now' }, relations: {} },
    });
    assert.equal(created.status, 'committed');

    // Fast vN -> vN+1 -> vN+2 commits remain one job at the latest revision.
    for (const [base, content] of [[1, 'Task v2'], [2, 'Task v3']]) {
      const result = await writer('clued_record_mutate', {
        operation: 'update', id: taskId, record_type: 'task', record_schema_version: 1,
        lifecycle_status: 'active', scope: projectScope, base_version: base,
        idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Rapid canonical update', mutation: { content },
      });
      assert.equal(result.status, 'committed');
    }
    const jobs = (await admin.query(`select projection_key,target_invalidation_revision,status
      from clued_private.projection_refresh_jobs where user_id=$1 order by projection_key`, [userId])).rows;
    assert.deepEqual(jobs.map((row) => row.projection_key),
      ['global.__aggregate__', 'global.priority_frontier']);
    assert.ok(jobs.every((row) => row.status === 'queued'));
    const heads = (await admin.query(`select projection_key,invalidation_revision
      from clued_private.projection_invalidation_heads where user_id=$1 and target_scope='global'
      and projection_key in ('global.priority_frontier','global.__aggregate__')`, [userId])).rows;
    const headByKey = Object.fromEntries(heads.map((row) => [row.projection_key, Number(row.invalidation_revision)]));
    assert.equal(Number(jobs.find((row) => row.projection_key === 'global.priority_frontier').target_invalidation_revision),
      headByKey['global.priority_frontier']);

    // Duplicate triggers are idempotent and do not fan out queue rows.
    await admin.query(`select clued_private.projection_refresh_enqueue($1,'global',
      'global.priority_frontier',$2)`, [userId, headByKey['global.priority_frontier']]);
    await admin.query(`select clued_private.projection_refresh_enqueue($1,'global',
      'global.priority_frontier',$2)`, [userId, headByKey['global.priority_frontier']]);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.projection_refresh_jobs
      where user_id=$1 and projection_key='global.priority_frontier'`, [userId])).rows[0].n, 1);

    // The writer does not inherit Builder authority, and the read-only Builder
    // cannot mutate Canonical source records through the normal M1 RPC.
    await assert.rejects(() => rpc(writerToken, 'clued_mcp_projection_refresh_claim', {}),
      /projection_builder_not_authorized/);
    await assert.rejects(() => rpc(builderToken, 'clued_record_mutate', {
      operation: 'update', id: taskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 3,
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'forbidden',
      mutation: { content: 'forbidden' },
    }), /binding_not_authorized|binding_scope_missing/);

    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const staleBefore = await writer('clued_record_list', { level: 'global', record_type: 'state' });
    assert.equal(staleBefore.current_projection_unavailable, true);
    assert.equal(staleBefore.projection_rebuild_required, true);

    // Claim N, commit N+1 concurrently, then prove the old result is discarded.
    const oldClaim = await builder('clued_mcp_projection_refresh_claim');
    assert.equal(oldClaim.status, 'claimed');
    assert.equal(oldClaim.projection_key, 'global.priority_frontier');
    const v4 = await writer('clued_record_mutate', {
      operation: 'update', id: taskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 3,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Concurrent canonical update', mutation: { content: 'Task v4' },
    });
    assert.equal(v4.status, 'committed');
    const conflict = await builder('clued_mcp_projection_refresh_apply', {
      projection_key: oldClaim.projection_key, lease_id: oldClaim.lease_id,
      expected_invalidation_revision: oldClaim.expected_invalidation_revision,
      expected_source_vector_digest: oldClaim.expected_source_vector_digest,
    });
    assert.equal(conflict.status, 'cas_conflict');
    assert.ok(conflict.latest_invalidation_revision > conflict.discarded_invalidation_revision);
    assert.equal((await admin.query(`select outcome from clued_private.projection_refresh_attempts
      where lease_id=$1`, [oldClaim.lease_id])).rows[0].outcome, 'CAS_CONFLICT');

    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const currentClaim = await builder('clued_mcp_projection_refresh_claim');
    const revisionBeforeApply = (await admin.query(`select invalidation_revision
      from clued_private.projection_invalidation_heads where user_id=$1
      and projection_key='global.priority_frontier'`, [userId])).rows[0].invalidation_revision;
    const rebuilt = await builder('clued_mcp_projection_refresh_apply', {
      projection_key: currentClaim.projection_key, lease_id: currentClaim.lease_id,
      expected_invalidation_revision: currentClaim.expected_invalidation_revision,
      expected_source_vector_digest: currentClaim.expected_source_vector_digest,
    });
    assert.equal(rebuilt.status, 'rebuilt');
    assert.equal((await admin.query(`select invalidation_revision
      from clued_private.projection_invalidation_heads where user_id=$1
      and projection_key='global.priority_frontier'`, [userId])).rows[0].invalidation_revision,
    revisionBeforeApply, 'projection writes must not recursively invalidate themselves');

    const aggregateClaim = await builder('clued_mcp_projection_refresh_claim');
    assert.equal(aggregateClaim.projection_key, 'global.__aggregate__');
    const reconciled = await builder('clued_mcp_projection_refresh_apply', {
      projection_key: aggregateClaim.projection_key, lease_id: aggregateClaim.lease_id,
      expected_invalidation_revision: aggregateClaim.expected_invalidation_revision,
      expected_source_vector_digest: aggregateClaim.expected_source_vector_digest,
    });
    assert.equal(reconciled.status, 'reconciled');

    // BUG-20260924-003 regression: an active Global Event is part of the
    // projection source vector. Once the exact projection head is rebuilt from
    // that vector, the derived projection State must not be shadowed a second
    // time by the same Event. A normal Global Decision/constraint remains
    // authoritative and must be readable after the rebuild.
    const eventSession = await rpc(writerToken, 'clued_mcp_restore', {
      context_key: 'global', response_view: 'structured', event_limit: 10,
    });
    const constraintId = uuid();
    const constraint = await writer('clued_record_mutate', {
      operation: 'create', id: constraintId, record_type: 'decision',
      record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Projection head Event-shadow regression fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Global projection regression constraint',
        content: 'Remain visible after projection refresh.',
        type_fields: { constraint: true, rationale: 'BUG-20260924-003 regression' },
        relations: {} },
    });
    assert.equal(constraint.status, 'committed');
    const activeGlobalEvent = await rpc(writerToken, 'clued_mcp_append_event', {
      context_key: 'global', session_token: eventSession.session_token,
      base_version: eventSession.version, event_type: 'action',
      payload: { marker: 'projection-head-event-shadow-regression' },
      idempotency_key: uuid(),
    });
    assert.equal(activeGlobalEvent.status, 'appended', JSON.stringify(activeGlobalEvent));
    assert.equal((await admin.query(`select carrier_state from clued_private.event_truth_carriers
      where event_id=$1`, [activeGlobalEvent.event_id])).rows[0].carrier_state,
    'ACTIVE_UNSTRUCTURED');

    // Temporary Builder loss is visible, bounded, and recoverable.
    const v5 = await writer('clued_record_mutate', {
      operation: 'update', id: taskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 4,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Temporary failure recovery', mutation: { content: 'Task v5' },
    });
    assert.equal(v5.status, 'committed');
    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const abandoned = await builder('clued_mcp_projection_refresh_claim');
    assert.equal(abandoned.status, 'claimed');
    await admin.query(`update clued_private.projection_refresh_jobs
      set lease_expires_at=now()-interval '1 second' where lease_id=$1`, [abandoned.lease_id]);
    const waiting = await builder('clued_mcp_projection_refresh_claim');
    assert.equal(waiting.status, 'waiting');
    const failure = (await admin.query(`select outcome,error_code
      from clued_private.projection_refresh_attempts where lease_id=$1`, [abandoned.lease_id])).rows[0];
    assert.deepEqual(failure, { outcome: 'RETRYABLE_FAILURE', error_code: 'builder_lease_expired' });
    const retryState = (await admin.query(`select status,attempt_count,max_attempts,last_error_code
      from clued_private.projection_refresh_jobs where user_id=$1
      and projection_key='global.priority_frontier'`, [userId])).rows[0];
    assert.equal(retryState.status, 'retry_wait');
    assert.ok(retryState.attempt_count < retryState.max_attempts);
    assert.equal(retryState.last_error_code, 'builder_lease_expired');

    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    for (const expectedKey of ['global.priority_frontier', 'global.__aggregate__']) {
      const claim = await builder('clued_mcp_projection_refresh_claim');
      assert.equal(claim.projection_key, expectedKey);
      const applied = await builder('clued_mcp_projection_refresh_apply', {
        projection_key: claim.projection_key, lease_id: claim.lease_id,
        expected_invalidation_revision: claim.expected_invalidation_revision,
        expected_source_vector_digest: claim.expected_source_vector_digest,
      });
      assert.ok(['rebuilt', 'reconciled'].includes(applied.status));
      await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
        where user_id=$1`, [userId]);
    }

    const currentFrontierRecord = (await admin.query(`select record_id
      from clued_private.projection_heads where user_id=$1 and target_scope='global'
      and projection_key='global.priority_frontier'`, [userId])).rows[0].record_id;
    assert.equal((await admin.query(`select clued_private.record_currentness_fence(
      $1,$2,array['global']::text[]) currentness`,
    [userId, currentFrontierRecord])).rows[0].currentness, 'CURRENT',
    'the exact rebuilt projection head must not be re-shadowed by its active Event source');

    const globalDecisions = await writer('clued_record_list', {
      level: 'global', record_type: 'decision',
    });
    assert.equal(globalDecisions.current_projection_unavailable, false);
    assert.equal(globalDecisions.projection_rebuild_required, false);
    assert.ok(globalDecisions.records.some((row) => row.id === constraintId),
      'Global Decision reads recover after the projection rebuild');

    // Independent hosts read the same rebuilt Task version and body.
    for (const token of [hostAToken, hostBToken]) {
      const restored = await rpc(token, 'clued_mcp_restore', {
        context_key: 'global', response_view: 'structured', event_limit: 10,
      });
      assert.equal(restored.authoritative_current_action.status, 'RESOLVED');
      assert.equal(restored.authoritative_current_action.source_refs[0].id, taskId);
      assert.equal(restored.authoritative_current_action.source_refs[0].version, 5);
      assert.equal(restored.authoritative_current_action.action.content, 'Task v5');
      assert.equal(restored.currentness_evaluation.overall, 'CURRENT');
      assert.ok(restored.active_constraints.some((row) => row.id === constraintId),
        'Global constraints are delivered after the projection rebuild');
    }
    const finalHeads = (await admin.query(`select projection_key,
      invalidation_revision,resolved_through_revision from clued_private.projection_invalidation_heads
      where user_id=$1 and target_scope='global' and projection_key in
      ('global.priority_frontier','global.__aggregate__')`, [userId])).rows;
    assert.ok(finalHeads.every((row) => Number(row.invalidation_revision) ===
      Number(row.resolved_through_revision)));
    assert.equal((await admin.query(`select count(*)::int n from clued_private.projection_refresh_jobs
      where user_id=$1 and status='running'`, [userId])).rows[0].n, 0);
    assert.equal(writerId === builderId, false);

    // The independent watchdog observes bounded status only, with its own role.
    const runId = uuid();
    await assert.rejects(() => rpc(writerToken, 'clued_mcp_projection_refresh_heartbeat',
      { run_id: runId, phase: 'start' }), /projection_builder_not_authorized/);
    await assert.rejects(() => rpc(limitedBuilderToken, 'clued_mcp_projection_refresh_heartbeat',
      { run_id: runId, phase: 'start' }), /projection_builder_not_authorized/);
    await assert.rejects(() => builder('clued_mcp_projection_refresh_heartbeat',
      { run_id: runId }), /invalid_projection_heartbeat/);
    assert.equal((await builder('clued_mcp_projection_refresh_heartbeat',
      { run_id: runId, phase: 'start' })).status, 'recorded');
    assert.equal((await builder('clued_mcp_projection_refresh_heartbeat',
      { run_id: runId, phase: 'finish', result: 'idle' })).status, 'recorded');
    await assert.rejects(() => anon.query(
      'select clued_watchdog.projection_watchdog_snapshot()'), /permission denied/);
    const watchdog = server.getPgClient();
    clients.push(watchdog);
    await watchdog.connect();
    await watchdog.query('set role clued_projection_watchdog');
    const healthySnapshot = (await watchdog.query(
      'select clued_watchdog.projection_watchdog_snapshot() as snapshot')).rows[0].snapshot;
    assert.equal(healthySnapshot.heartbeat.last_result, 'idle');
    assert.deepEqual(healthySnapshot.projections.map((row) => row.projection_key),
      ['global.__aggregate__', 'global.priority_frontier']);
    assert.ok(healthySnapshot.projections.every((row) => row.source_digest_status === 'match'));
    assert.ok(healthySnapshot.projections.every((row) => /^[0-9a-f]{64}$/.test(row.tenant_key)));
    assert.ok(healthySnapshot.projections.every((row) => row.builder_served === true));
    await admin.query(`update clued_private.projection_builder_grants set active=false
      where user_id=$1 and projection_key='global.__aggregate__'`, [userId]);
    const unservedSnapshot = (await watchdog.query(
      'select clued_watchdog.projection_watchdog_snapshot() as snapshot')).rows[0].snapshot;
    assert.deepEqual(unservedSnapshot.projections.map((row) => [row.projection_key, row.builder_served]),
      [['global.__aggregate__', false], ['global.priority_frontier', true]]);
    await admin.query(`update clued_private.projection_builder_grants set active=true
      where user_id=$1 and projection_key='global.__aggregate__'`, [userId]);
    await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata,created_at)
      values($1,$2,'global','projection_refresh','projection','global.__aggregate__',999,
        $3,now()+interval '1 hour')`,
    [userId, builderId, { source_vector_digest: '0'.repeat(64) }]);
    const exactReceiptSnapshot = (await watchdog.query(
      'select clued_watchdog.projection_watchdog_snapshot() as snapshot')).rows[0].snapshot;
    assert.equal(exactReceiptSnapshot.projections.find((row) =>
      row.projection_key === 'global.__aggregate__').source_digest_status, 'match');
    await admin.query(`update clued_private.projection_heads
      set source_vector_digest=$1 where user_id=$2 and target_scope='global'
      and projection_key='global.priority_frontier'`, ['0'.repeat(64), userId]);
    const mismatchSnapshot = (await watchdog.query(
      'select clued_watchdog.projection_watchdog_snapshot() as snapshot')).rows[0].snapshot;
    assert.equal(mismatchSnapshot.projections.find((row) =>
      row.projection_key === 'global.priority_frontier').source_digest_status, 'mismatch');
    await admin.query(`update clued_private.projection_heads
      set source_vector_digest=$1 where user_id=$2 and target_scope='global'
      and projection_key='global.priority_frontier'`,
    [(await admin.query(`select clued_private.currentness_hash(
      clued_private.projection_source_snapshot($1)) as digest`, [userId])).rows[0].digest, userId]);
    await assert.rejects(() => watchdog.query(
      'select * from clued_private.projection_refresh_jobs'), /permission denied/);
    assert.equal((await watchdog.query(`select has_schema_privilege(
      'clued_private','USAGE') as allowed`)).rows[0].allowed, false);
    await assert.rejects(() => watchdog.query(
      "select public.clued_mcp_projection_refresh_claim('token', '{}'::jsonb)"),
    /permission denied/);

    // A Builder granted only Frontier may rebuild Frontier, but must not
    // diagnose, retry, or terminate an expired Aggregate lease owned by a
    // different Builder for the same user.
    const v6 = await writer('clued_record_mutate', {
      operation: 'update', id: taskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 5,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Exact-key lease authorization regression',
      mutation: { content: 'Task v6' },
    });
    assert.equal(v6.status, 'committed');
    const staleSnapshot = (await watchdog.query(
      'select clued_watchdog.projection_watchdog_snapshot() as snapshot')).rows[0].snapshot;
    assert.ok(staleSnapshot.projections.every((row) =>
      row.invalidation_revision > row.resolved_through_revision &&
      row.source_digest_status === 'not_applicable'));
    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const limitedClaim = await rpc(limitedBuilderToken, 'clued_mcp_projection_refresh_claim', {});
    assert.equal(limitedClaim.projection_key, 'global.priority_frontier');
    const limitedApply = await rpc(limitedBuilderToken, 'clued_mcp_projection_refresh_apply', {
      projection_key: limitedClaim.projection_key, lease_id: limitedClaim.lease_id,
      expected_invalidation_revision: limitedClaim.expected_invalidation_revision,
      expected_source_vector_digest: limitedClaim.expected_source_vector_digest,
    });
    assert.equal(limitedApply.status, 'rebuilt');
    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const aggregateLease = await builder('clued_mcp_projection_refresh_claim');
    assert.equal(aggregateLease.projection_key, 'global.__aggregate__');
    await admin.query(`update clued_private.projection_refresh_jobs
      set lease_expires_at=now()-interval '1 second' where lease_id=$1`,
    [aggregateLease.lease_id]);
    const limitedRecovery = await rpc(limitedBuilderToken,
      'clued_mcp_projection_refresh_claim', {});
    assert.equal(limitedRecovery.status, 'idle');
    const aggregateJob = (await admin.query(`select status,lease_id,last_error_code
      from clued_private.projection_refresh_jobs where user_id=$1
      and projection_key='global.__aggregate__'`, [userId])).rows[0];
    assert.equal(aggregateJob.status, 'running');
    assert.equal(aggregateJob.lease_id, aggregateLease.lease_id);
    assert.equal(aggregateJob.last_error_code, null);
    assert.equal((await admin.query(`select outcome from clued_private.projection_refresh_attempts
      where lease_id=$1`, [aggregateLease.lease_id])).rows[0].outcome, 'RUNNING');
    await builder('clued_mcp_projection_refresh_claim');
    assert.equal((await admin.query(`select status from clued_private.projection_refresh_jobs
      where user_id=$1 and projection_key='global.__aggregate__'`, [userId])).rows[0].status,
    'retry_wait');
    await admin.query('delete from public.clued_agent_bindings where id=$1', [builderId]);
    assert.equal((await admin.query(`select builder_binding_id from
      clued_private.projection_refresh_heartbeat where id=true`)).rows[0].builder_binding_id,
    null, 'a diagnostic heartbeat must not block binding/account deletion');
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await server.stop().catch(() => {});
  }
});
