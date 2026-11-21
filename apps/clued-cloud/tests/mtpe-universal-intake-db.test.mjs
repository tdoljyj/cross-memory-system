import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

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

test('Universal Intake routes every actionable kind and preserves priority, Owner focus, and executability',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-mtpe-intake-'));
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
    await allowTestIssuerCredentials(admin);

    const userId = uuid();
    const hostAToken = hash();
    const hostBToken = hash();
    const limitedToken = hash();
    const builderToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'mtpe@example.invalid',now())", [userId]);
    for (const [name, token, contexts] of [
      ['Host A', hostAToken, ['*']], ['Host B', hostBToken, ['*']],
      ['Limited Host', limitedToken, ['global']],
    ]) {
      await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write','audit:read'],$4)`,
      [userId, name, token, contexts]);
    }
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
    const write = (token, input) => rpc(token, 'clued_record_mutate', input);
    const snapshot = (token = hostAToken) => rpc(token, 'clued_mcp_mtpe_snapshot');
    const validate = (token = hostAToken) => rpc(token, 'clued_mcp_mtpe_validate');

    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    assert.equal((await rpc(hostAToken, 'clued_project_mutate_v2', {
      operation: 'create', canonical_project_id: projectId, project_schema_version: 2,
      idempotency_key: uuid(),
      mutation: { name: 'MTPE Runtime', progress_status: 'active' },
    })).status, 'committed');

    const blockedId = uuid();
    const readyId = uuid();
    const blockedFields = {
      execution_bucket: 'blocked', owner_track: '工程与平台',
      affected_tracks: ['产品与体验'], criticality: 'CRITICAL', priority: 100,
      current_frontier_blocking: true, downstream_unlock_value: 15,
      security_risk: true, user_product_impact: 15, time_sensitivity: 10,
      owner_pin: true,
      hard_gate_blockers: [{ code: 'AUTHORITY_REQUIRED', basis: 'production write grant',
        resolution: 'obtain the exact environment grant' }],
    };
    const readyFields = {
      execution_bucket: 'next', owner_track: '产品与体验', criticality: 'NORMAL',
      priority: 30, user_product_impact: 4,
    };
    for (const [token, id, title, fields] of [
      [hostAToken, blockedId, 'Blocked critical task', blockedFields],
      [hostBToken, readyId, 'Ready lower-priority task', readyFields],
    ]) {
      assert.equal((await write(token, {
        operation: 'create', id, record_type: 'task', record_schema_version: 1,
        lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
        authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Synthetic MTPE acceptance input', source_refs: [],
        source_unavailable_reason: null,
        mutation: { title, content: title, type_fields: fields, relations: {} },
      })).status, 'committed');
    }
    const blockedPinKey = uuid();
    const blockedPin = await rpc(hostAToken, 'clued_mcp_mtpe_owner_pin', {
      operation: 'set', record_id: blockedId, base_version: 1,
      expected_current_focus_id: null,
      idempotency_key: blockedPinKey, user_confirmed: true,
      reason: 'Owner explicitly selected the blocked task',
    });
    assert.equal(blockedPin.status, 'committed');
    const blockedPinReplay = await rpc(hostBToken, 'clued_mcp_mtpe_owner_pin', {
      operation: 'set', record_id: blockedId, base_version: 1,
      expected_current_focus_id: null,
      idempotency_key: blockedPinKey, user_confirmed: true,
      reason: 'Owner explicitly selected the blocked task',
    });
    assert.equal(blockedPinReplay.receipt_id, blockedPin.receipt_id);

    const first = await snapshot();
    assert.equal(first.system_recommended_priority.record_id, blockedId);
    assert.equal(first.system_recommended_frontier.record_id, readyId,
      'priority and executability must remain separate');
    assert.equal(first.owner_selected_current_focus.record_id, blockedId);
    assert.equal(first.owner_selected_current_focus.status, 'OWNER_SELECTED_BLOCKED');
    assert.equal(first.selected_frontier.record_id, blockedId,
      'a blocked Owner selection must not be silently replaced');
    assert.equal(first.selected_frontier.selection_source, 'OWNER_PIN');
    assert.deepEqual(first.owner_selected_current_focus.hard_gate_blockers,
      blockedFields.hard_gate_blockers);

    // Requirement 14 consumes the MTPE result and preserves the blocked Pin.
    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const blockedClaim = await rpc(builderToken, 'clued_mcp_projection_refresh_claim');
    assert.equal(blockedClaim.projection_key, 'global.priority_frontier');
    const blockedRebuild = await rpc(builderToken, 'clued_mcp_projection_refresh_apply', {
      projection_key: blockedClaim.projection_key, lease_id: blockedClaim.lease_id,
      expected_invalidation_revision: blockedClaim.expected_invalidation_revision,
      expected_source_vector_digest: blockedClaim.expected_source_vector_digest,
    });
    assert.equal(blockedRebuild.status, 'rebuilt', JSON.stringify(blockedRebuild));
    const blockedProjection = (await admin.query(`select type_fields from public.clued_memories
      where user_id=$1 and record_type='state'
      and type_fields->>'projection_key'='global.priority_frontier'`, [userId])).rows[0].type_fields;
    assert.equal(blockedProjection.source_task.id, blockedId);
    assert.equal(blockedProjection.executability, 'BLOCKED_HARD_GATE');
    assert.equal(blockedProjection.selection_source, 'OWNER_PIN');

    // A later explicit Pin that names the focus it replaces switches the focus
    // without changing either score.
    const beforeReadyScore = first.candidate_universe.find((row) => row.record_id === readyId).algorithm_priority;
    assert.equal((await rpc(hostBToken, 'clued_mcp_mtpe_owner_pin', {
      operation: 'set', record_id: readyId, base_version: 1,
      expected_current_focus_id: blockedId,
      idempotency_key: uuid(), user_confirmed: true,
      reason: 'Owner chooses B despite the higher recommendation',
    })).status, 'committed');
    const switched = await snapshot(hostBToken);
    assert.equal(switched.system_recommended_priority.record_id, blockedId);
    assert.equal(switched.owner_selected_current_focus.record_id, readyId);
    assert.equal(switched.owner_selected_current_focus.status, 'OWNER_SELECTED_READY');
    assert.equal(switched.selected_frontier.record_id, readyId);
    assert.equal(switched.candidate_universe.find((row) => row.record_id === readyId).algorithm_priority,
      beforeReadyScore, 'Owner Pin must not rewrite the algorithmic priority');

    // Cancel the active Pin, then prove a different Host mutation recomputes one
    // stable projection row instead of creating a duplicate wrapper.
    assert.equal((await rpc(hostAToken, 'clued_mcp_mtpe_owner_pin', {
      operation: 'cancel', record_id: readyId, base_version: 1,
      idempotency_key: uuid(), user_confirmed: true,
      reason: 'Owner cancels the current focus',
    })).status, 'committed');
    assert.equal((await snapshot()).owner_selected_current_focus, null);
    const beforeBlockedScore = (await snapshot()).candidate_universe
      .find((row) => row.record_id === blockedId).algorithm_priority;
    assert.equal((await write(hostBToken, {
      operation: 'update', id: blockedId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 1,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Cross-host severity and cost recompute',
      mutation: { type_fields: { ...blockedFields,
        criticality: 'LOW', current_frontier_blocking: false,
        downstream_unlock_value: 0, security_risk: false,
        user_product_impact: 0, time_sensitivity: 0, resource_cost: 10, priority: 0 } },
    })).status, 'committed');
    const afterRecompute = await snapshot(hostBToken);
    assert.equal(afterRecompute.owner_selected_current_focus, null,
      'a stored owner_pin flag must not replay and steal focus after cancellation');
    assert.ok(afterRecompute.candidate_universe.find((row) => row.record_id === blockedId)
      .algorithm_priority < beforeBlockedScore);
    assert.equal((await admin.query(`select count(*)::int n
      from clued_private.mtpe_intake_projection where user_id=$1 and record_id=$2`,
    [userId, blockedId])).rows[0].n, 1);

    // Exercise every governed intake kind. Tasks were covered above.
    const noteKinds = ['proposal', 'bug', 'defect', 'blocker', 'risk', 'incident',
      'technical_debt', 'legacy_residual_scope', 'research_question',
      'product_issue', 'brand_issue', 'commercial_issue'];
    const kindIds = new Map();
    for (const noteKind of noteKinds) {
      const id = uuid();
      kindIds.set(noteKind, id);
      assert.equal((await write(hostAToken, {
        operation: 'create', id, record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
        authority: 'observed', confidence_reason: 'Synthetic governed intake kind',
        source_refs: [], source_unavailable_reason: 'Synthetic acceptance fixture',
        mutation: { title: noteKind, content: noteKind,
          type_fields: { note_kind: noteKind }, relations: {} },
      })).status, 'committed');
    }
    const decisionId = uuid();
    assert.equal((await write(hostAToken, {
      operation: 'create', id: decisionId, record_type: 'decision', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Decision follow-up acceptance fixture', source_refs: [],
      source_unavailable_reason: null,
      mutation: { title: 'Decision requiring follow-up', content: 'Follow up',
        type_fields: { rationale: 'Acceptance fixture', decision_follow_up: true }, relations: {} },
    })).status, 'committed');
    const stateId = uuid();
    assert.equal((await write(hostAToken, {
      operation: 'create', id: stateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'Blocker state acceptance fixture',
      source_refs: [], source_unavailable_reason: 'Synthetic acceptance fixture',
      mutation: { title: 'Runtime blocker', content: 'Blocked',
        type_fields: { state_kind: 'blocker' }, relations: {} },
    })).status, 'committed');
    const kinds = new Set((await snapshot()).candidate_universe.map((row) => row.intake_kind));
    for (const expected of ['TASK', ...noteKinds.map((value) => value.toUpperCase()),
      'DECISION_FOLLOW_UP']) assert.ok(kinds.has(expected), `missing ${expected}`);
    assert.ok(kinds.has('BLOCKER'));

    // A higher-priority READY non-Task remains visible in the governed
    // universe but cannot become Context v2's Task-bound executable frontier.
    const incidentId = kindIds.get('incident');
    assert.equal((await write(hostBToken, {
      operation: 'update', id: incidentId, record_type: 'note', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 1,
      idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'High-priority non-Task frontier boundary fixture',
      mutation: { type_fields: { note_kind: 'incident', criticality: 'CRITICAL',
        priority: 100, current_frontier_blocking: true, security_risk: true,
        user_product_impact: 15, time_sensitivity: 10 } },
    })).status, 'committed');
    const mixedSnapshot = await snapshot(hostBToken);
    assert.equal(mixedSnapshot.system_recommended_priority.record_id, incidentId);
    assert.equal(mixedSnapshot.system_recommended_frontier.record_id, readyId);
    await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
      where user_id=$1`, [userId]);
    const mixedClaim = await rpc(builderToken, 'clued_mcp_projection_refresh_claim');
    const mixedRebuild = await rpc(builderToken, 'clued_mcp_projection_refresh_apply', {
      projection_key: mixedClaim.projection_key, lease_id: mixedClaim.lease_id,
      expected_invalidation_revision: mixedClaim.expected_invalidation_revision,
      expected_source_vector_digest: mixedClaim.expected_source_vector_digest,
    });
    assert.equal(mixedRebuild.status, 'rebuilt', JSON.stringify(mixedRebuild));
    const mixedProjection = (await admin.query(`select type_fields from public.clued_memories
      where user_id=$1 and record_type='state'
      and type_fields->>'projection_key'='global.priority_frontier'`, [userId])).rows[0].type_fields;
    assert.equal(mixedProjection.source_task.id, readyId);

    const rejectedNonTaskPin = await rpc(hostAToken, 'clued_mcp_mtpe_owner_pin', {
      operation: 'set', record_id: incidentId, base_version: 2,
      expected_current_focus_id: null,
      idempotency_key: uuid(), user_confirmed: true,
      reason: 'Non-Task focus must not violate the Task frontier contract',
    });
    assert.equal(rejectedNonTaskPin.status, 'rejected');
    assert.match(JSON.stringify(rejectedNonTaskPin), /owner_pin_target_not_eligible/);

    // Unknown execution semantics and malformed blockers fail closed instead
    // of becoming READY through default coercion.
    const malformedId = uuid();
    assert.equal((await write(hostAToken, {
      operation: 'create', id: malformedId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Malformed execution boundary fixture', source_refs: [],
      source_unavailable_reason: null,
      mutation: { title: 'Unknown execution semantics', content: 'Fail closed', type_fields: {
        execution_bucket: 'next', priority: 100, criticality: 'CRITICAL',
        priority_eligibility: 'FUTURE_UNKNOWN', executability: 'AUTHORITY_PENDING',
        hard_gate_blockers: { code: 'not-an-array' },
      }, relations: {} },
    })).status, 'committed');
    const malformedRow = (await snapshot()).candidate_universe
      .find((row) => row.record_id === malformedId);
    assert.equal(malformedRow.priority_eligibility, 'UNKNOWN_INVALID');
    assert.equal(malformedRow.executability, 'BLOCKED_HARD_GATE');
    assert.notEqual((await snapshot()).system_recommended_frontier.record_id, malformedId);
    assert.equal((await validate()).status, 'fail');
    assert.equal((await write(hostBToken, {
      operation: 'update', id: malformedId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: 1,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Repair malformed execution boundary fixture',
      mutation: { type_fields: { execution_bucket: 'later', priority: 1,
        priority_eligibility: 'DEFERRED_WITH_TRIGGER', executability: 'DEFERRED' } },
    })).status, 'committed');

    // Currentness is evaluated at snapshot time. An UNKNOWN high-score Task is
    // blocked before arbitration, and the builder can still publish a current
    // ready Task instead of entering a retry loop.
    const staleId = uuid();
    assert.equal((await write(hostAToken, {
      operation: 'create', id: staleId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Currentness arbitration fixture', source_refs: [],
      source_unavailable_reason: null,
      mutation: { title: 'Stale high-priority task', content: 'Must not win', type_fields: {
        execution_bucket: 'next', priority: 100, criticality: 'CRITICAL',
        current_frontier_blocking: true, user_product_impact: 15,
      }, relations: {} },
    })).status, 'committed');
    await admin.query(`update public.clued_memories set
      type_fields=type_fields||jsonb_build_object('execution_intent',jsonb_build_object(
        'id',$2::text,'source_id',$3::text,'source_scope',$4::text,'source_version','1')),
      version=version+1,updated_at=now() where id=$1`,
    [staleId, uuid(), uuid(), projectScope]);
    const currentnessSnapshot = await snapshot();
    const staleRow = currentnessSnapshot.candidate_universe
      .find((row) => row.record_id === staleId);
    assert.equal(staleRow.record_currentness, 'UNKNOWN');
    assert.equal(staleRow.executability, 'BLOCKED_HARD_GATE');
    assert.equal(currentnessSnapshot.system_recommended_frontier.record_id, readyId);
    await admin.query(`update clued_private.projection_refresh_jobs
      set next_attempt_at=case when projection_key='global.priority_frontier'
        then now() else now()+interval '1 hour' end where user_id=$1`, [userId]);
    const currentnessClaim = await rpc(builderToken, 'clued_mcp_projection_refresh_claim');
    assert.equal(currentnessClaim.projection_key, 'global.priority_frontier');
    const currentnessRebuild = await rpc(builderToken, 'clued_mcp_projection_refresh_apply', {
      projection_key: currentnessClaim.projection_key, lease_id: currentnessClaim.lease_id,
      expected_invalidation_revision: currentnessClaim.expected_invalidation_revision,
      expected_source_vector_digest: currentnessClaim.expected_source_vector_digest,
    });
    assert.equal(currentnessRebuild.status, 'rebuilt', JSON.stringify(currentnessRebuild));

    // Explicitly excluded personal work never leaks into the governed universe.
    const excludedId = uuid();
    assert.equal((await write(hostAToken, {
      operation: 'create', id: excludedId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Out-of-governance fixture', source_refs: [],
      source_unavailable_reason: null,
      mutation: { title: 'Personal task', content: 'Not governed', type_fields: {
        execution_bucket: 'later', governance_profile: 'OUT_OF_GOVERNANCE_PROFILE' }, relations: {} },
    })).status, 'committed');
    assert.equal((await admin.query(`select count(*)::int n
      from clued_private.mtpe_intake_projection where record_id=$1`, [excludedId])).rows[0].n, 0);

    // Terminal rows remain auditable, including after a legitimate Decision
    // replacement using the existing successor-side relations.supersedes model.
    const replacementDecisionId = uuid();
    assert.equal((await rpc(hostAToken, 'clued_decision_supersede', {
      source_decisions: [{ id: decisionId, base_version: 1 }],
      supersede_reason: 'Acceptance successor contract', user_confirmed: true,
      idempotency_key: uuid(), replacement: {
        id: replacementDecisionId, title: 'Replacement decision', content: 'Follow up',
        scope: projectScope, record_schema_version: 1,
        type_fields: { rationale: 'Acceptance successor', decision_follow_up: true },
        relations: { supersedes: [decisionId] }, authority: 'user_explicit',
        source_refs: [], source_unavailable_reason: null,
        confidence_reason: 'Explicit acceptance replacement',
      },
    })).status, 'committed');
    assert.equal((await validate()).status, 'pass');

    // Missing terminal coverage and stale derived versions are detected by the
    // historical sweep, then repair deterministically from Canonical Records.
    const proposalId = kindIds.get('proposal');
    assert.equal((await write(hostBToken, {
      operation: 'close', id: proposalId, record_type: 'note', record_schema_version: 1,
      lifecycle_status: 'completed', scope: projectScope, base_version: 1,
      idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'Terminal intake fixture', mutation: { closure_summary: 'Done' },
    })).status, 'committed');
    assert.equal((await admin.query(`select candidate_status from clued_private.mtpe_intake_projection
      where user_id=$1 and record_id=$2`, [userId, proposalId])).rows[0].candidate_status, 'TERMINAL');
    await admin.query(`delete from clued_private.mtpe_intake_projection
      where user_id=$1 and record_id=$2`, [userId, proposalId]);
    assert.equal((await validate()).missing_route, 1);
    await admin.query('select clued_private.mtpe_sync_record($1)', [proposalId]);
    await admin.query(`update clued_private.mtpe_intake_projection
      set source_record_version=source_record_version-1
      where user_id=$1 and record_id=$2`, [userId, proposalId]);
    assert.equal((await validate()).stale_projection, 1);
    await admin.query('select clued_private.mtpe_sync_record($1)', [proposalId]);

    // SUPERSEDED without a real owned successor is rejected; an actual
    // successor Record whose relations.supersedes contains the source repairs it.
    const debtId = kindIds.get('technical_debt');
    await admin.query(`update public.clued_memories set lifecycle_status='superseded',
      status='superseded',relations='{}'::jsonb,version=version+1 where id=$1`, [debtId]);
    assert.equal((await validate()).status, 'fail');
    assert.equal((await validate()).invalid_terminal_successor_binding, 1);
    assert.equal((await write(hostAToken, {
      operation: 'create', id: uuid(), record_type: 'note', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'Successor binding fixture',
      source_refs: [], source_unavailable_reason: 'Synthetic acceptance fixture',
      mutation: { title: 'Debt successor', content: 'Replacement',
        type_fields: { note_kind: 'technical_debt' },
        relations: { supersedes: [debtId] } },
    })).status, 'committed');
    const finalValidation = await validate();
    assert.equal(finalValidation.status, 'pass');
    assert.equal(finalValidation.missing_route, 0);
    assert.equal(finalValidation.missing_priority, 0);
    assert.ok(finalValidation.terminal >= 2);

    // Same snapshot, different authorized Hosts: byte-identical replay digest.
    const hostAView = await snapshot(hostAToken);
    const hostBView = await snapshot(hostBToken);
    assert.equal(hostAView.candidate_universe_digest, hostBView.candidate_universe_digest);
    assert.deepEqual(hostAView.candidate_universe, hostBView.candidate_universe);

    // Read-set coverage: a Binding may inspect MTPE only when its effective read
    // scopes cover every Canonical source scope the operation reads. Denial is a
    // structured tool result naming the missing scopes, not an HTTP auth failure.
    const assertCoverageDenied = (result, missing) => {
      assert.equal(result.status, 'denied');
      assert.equal(result.rule, 'mtpe-read-set-coverage.v1');
      assert.equal(result.error.code, 'INSUFFICIENT_CONTEXT_COVERAGE');
      assert.deepEqual(result.error.missing_context_keys, missing);
      assert.equal(result.candidate_universe, undefined);
    };
    assertCoverageDenied(await snapshot(limitedToken), [projectScope]);
    assertCoverageDenied(await validate(limitedToken), [projectScope]);

    const coveringToken = hash();
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Explicit covering Host',$2,array['context:read'],$3)`,
    [userId, coveringToken, ['global', projectScope]]);
    const coveringView = await snapshot(coveringToken);
    assert.equal(coveringView.status, 'ok');
    assert.equal(coveringView.candidate_universe_digest, hostAView.candidate_universe_digest);
    assert.deepEqual(coveringView.candidate_universe, hostAView.candidate_universe);
    assert.deepEqual(await validate(coveringToken), await validate(hostAToken));

    // OAuth consent Bindings are judged by their effective per-entry read actions.
    const oauthToken = hash();
    const oauthBinding = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'OAuth','Consent Host',$2,array['context:read'],$3) returning id`,
    [userId, oauthToken, ['global', projectScope]])).rows[0].id;
    const issuerHash = hash();
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
      values($1,'https://mcp.example.invalid/mcp','MTPE issuer')`, [issuerHash]);
    const requestId = (await admin.query(`insert into clued_private.authorization_requests_v12
      (owner_id,issuer_hash,request_digest,client_id,client_name,redirect_uri,resource,requested_scopes,eligible,status)
      values($1,$2,$3,'mtpe-client','MTPE client','https://client.example.invalid/callback',
      'https://mcp.example.invalid/mcp',array['context:read'],'[]'::jsonb,'approved') returning id`,
    [userId, issuerHash, hash()])).rows[0].id;
    await admin.query(`insert into clued_private.authorizations_v12
      (binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
      values($1,$2,$3,'mtpe-client','MTPE client','https://mcp.example.invalid/mcp',now()+interval '1 hour')`,
    [oauthBinding, requestId, userId]);
    await admin.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope','global','canonical',array['read']),($1,'scope',$2,'canonical',array['read'])`,
    [oauthBinding, projectScope]);
    assert.equal((await snapshot(oauthToken)).candidate_universe_digest, hostAView.candidate_universe_digest);
    await admin.query(`delete from clued_private.authorization_entries_v12
      where binding_id=$1 and resource_id=$2`, [oauthBinding, projectScope]);
    assertCoverageDenied(await snapshot(oauthToken), [projectScope]);

    // A new Project is never inherited by an explicit grant; '*' keeps its meaning.
    const laterProjectId = uuid();
    const laterScope = `project:${laterProjectId}`;
    assert.equal((await rpc(hostAToken, 'clued_project_mutate_v2', {
      operation: 'create', canonical_project_id: laterProjectId, project_schema_version: 2,
      idempotency_key: uuid(),
      mutation: { name: 'MTPE Later', progress_status: 'active' },
    })).status, 'committed');
    assert.equal((await write(hostAToken, {
      operation: 'create', id: uuid(), record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: laterScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Synthetic MTPE acceptance input', source_refs: [],
      source_unavailable_reason: null,
      mutation: { title: 'Later project task', content: 'Later project task',
        type_fields: { execution_bucket: 'next', owner_track: '产品与体验', priority: 10 },
        relations: {} },
    })).status, 'committed');
    assertCoverageDenied(await snapshot(coveringToken), [laterScope]);
    assertCoverageDenied(await validate(coveringToken), [laterScope]);
    assert.equal((await snapshot(hostAToken)).status, 'ok');
    assert.ok((await snapshot(hostAToken)).candidate_universe.some((item) => item.scope === laterScope));

    // Unknown scope kinds and unscoped sources fail closed unless unrestricted.
    const denial = async (granted, readSet, returned = []) => (await admin.query(
      'select clued_private.mtpe_read_coverage_denial_v1($1,$2,$3) value',
      [granted, readSet, JSON.stringify(returned)])).rows[0].value;
    assert.equal(await denial(['global'], { scopes: ['global'], unscoped_sources: 0 }), null);
    assert.equal(await denial(null, { scopes: ['workspace:x'], unscoped_sources: 3 }), null);
    assert.deepEqual((await denial(['global'], { scopes: ['global', 'workspace:x'], unscoped_sources: 0 }))
      .error.missing_context_keys, ['workspace:x']);
    const unscoped = await denial(['global'], { scopes: ['global'], unscoped_sources: 1 });
    assert.equal(unscoped.error.code, 'INSUFFICIENT_CONTEXT_COVERAGE');
    assert.equal(unscoped.error.unscoped_sources, 1);
    assert.deepEqual((await denial(['global'], { scopes: ['global'], unscoped_sources: 0 }, [projectScope]))
      .error.missing_context_keys, [projectScope]);
    assert.equal((await denial(['global'], { scopes: ['global'], unscoped_sources: 0 }, [null]))
      .error.unscoped_sources, 1);
    await assert.rejects(anon.query('select clued_private.mtpe_read_set_v1($1,$2)', [userId, 'snapshot']),
      /permission denied/);
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

