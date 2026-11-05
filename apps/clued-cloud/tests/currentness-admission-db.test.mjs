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
import { AUTHORIZATION_SUCCESSOR_MIGRATIONS, snapshotAuthorizationCallerBoundary, assertAuthorizationSuccessorBoundary, setWorkerGatewayCaller, workerGatewayRpc, CLOSEOUT_MIGRATION, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

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

test('T-CUR-16/17/29: session vector, checkpoint guard, and exact reconcile', { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-admission-'));
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
    // The terminal-source fixture below is a historical v1 Project. Preserve
    // that receipt family, then apply the real closeout before testing G6.
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql') && name !== CLOSEOUT_MIGRATION && !AUTHORIZATION_SUCCESSOR_MIGRATIONS.includes(name)).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const userId = uuid();
    const tokenHash = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'admission@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Currentness admission test',$2,
        array['context:read','context:write','audit:read'],array['global'])`, [userId, tokenHash]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = async (name, input) => await workerGatewayRpc(workerCaller, name, tokenHash, input);
    // A global-scope change invalidates both Global projections; admission waits for
    // the refresh Worker. This drains the queue the way the Worker does.
    const workerToken = hash();
    const workerId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'system','Projection refresh Worker',$2,array['context:read'],array['*']) returning id`,
    [userId, workerToken])).rows[0].id;
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','test-worker'),
            ($1,$2,'global','global.__aggregate__','test-worker')`, [workerId, userId]);
    const worker = async (name, input = {}) => await workerGatewayRpc(workerCaller, name, workerToken, input);
    const drainProjections = async () => {
      for (let round = 0; round < 6; round += 1) {
        await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
          where user_id=$1 and status in ('queued','failed')`, [userId]);
        const claim = await worker('clued_mcp_projection_refresh_claim');
        if (!claim.lease_id) return;
        const applied = await worker('clued_mcp_projection_refresh_apply', {
          projection_key: claim.projection_key, lease_id: claim.lease_id,
          expected_invalidation_revision: claim.expected_invalidation_revision,
          expected_source_vector_digest: claim.expected_source_vector_digest,
        });
        assert.ok(['rebuilt', 'reconciled'].includes(applied.status), JSON.stringify(applied));
      }
      throw new Error('projection refresh did not converge');
    };
    const globalProjectionsPending = async () => (await admin.query(`select count(*)::int n
      from clued_private.projection_invalidation_heads where user_id=$1 and target_scope='global'
        and invalidation_revision>resolved_through_revision`, [userId])).rows[0].n;
    const restored = await rpc('clued_mcp_restore', { context_key: 'global', response_view: 'structured' });
    const session = (await admin.query(`select id,restored_currentness_digest,restored_currentness_vector
      from public.clued_continuity_sessions where token_hash=encode(extensions.digest($1,'sha256'),'hex')`,
    [restored.session_token])).rows[0];
    assert.equal(session.restored_currentness_vector.schema, 'clued.currentness-vector.v1');
    await admin.query(`insert into public.clued_context_events
      (user_id,context_key,session_id,binding_id,event_type,payload,audit_visibility)
      select $1,'global',$2,s.binding_id,'decision',
        '{"marker":"hidden authority"}'::jsonb,'audit_only'
      from public.clued_continuity_sessions s where s.id=$2`, [userId, session.id]);
    const hiddenVector = (await admin.query(`select clued_private.currentness_vector(s.user_id,s.context_key,s.binding_id) vector
      from public.clued_continuity_sessions s where s.id=$1`, [session.id])).rows[0].vector;
    assert.deepEqual(hiddenVector, session.restored_currentness_vector);
    const hiddenDigest = (await admin.query(`select clued_private.currentness_hash(
      clued_private.currentness_vector(s.user_id,s.context_key,s.binding_id)) digest
      from public.clued_continuity_sessions s where s.id=$1`, [session.id])).rows[0].digest;
    assert.equal(hiddenDigest, session.restored_currentness_digest);
    // Decision-class Events are rejected by the public adapter; seed a pre-guard row.
    const event = (await admin.query('select clued_private.clued_mcp_append_event_unguarded($1,$2) value', [tokenHash, {
      context_key: 'global', session_token: restored.session_token, base_version: restored.version,
      event_type: 'decision', payload: { marker: 'new current authority' }, idempotency_key: uuid(),
    }])).rows[0].value;
    assert.equal(event.status, 'appended');
    const coverage = { mode: 'explicit', contexts: ['global'], tracks: ['decision'], event_ids: [event.event_id] };
    const checkpoint = {
      context_key: 'global', session_token: restored.session_token, base_version: event.version,
      snapshot: { marker: 'after event' }, summary: 'After event', next_action: 'Reconcile authority', coverage,
      idempotency_key: uuid(),
    };
    const rejected = await rpc('clued_mcp_commit_checkpoint', checkpoint);
    assert.deepEqual({ status: rejected.status, error: rejected.error },
      { status: 'conflict', error: 'current_truth_changed_since_resume' });
    assert.equal((await admin.query('select reconciliation_required from public.clued_continuity_sessions where id=$1', [session.id])).rows[0].reconciliation_required, true);
    assert.equal((await admin.query('select count(*)::integer n from public.clued_context_checkpoints where session_id=$1', [session.id])).rows[0].n, 0);
    assert.equal((await admin.query('select count(*)::integer n from public.clued_checkpoint_event_absorptions where event_id=$1', [event.event_id])).rows[0].n, 0);
    // The global decision Event invalidated both Global projections: nothing is
    // admission-eligible until the refresh Worker has rebuilt them.
    assert.equal(await globalProjectionsPending(), 2);
    await drainProjections();
    assert.equal(await globalProjectionsPending(), 0);
    const reconcile = await rpc('clued_mcp_session_reconcile', {
      context_key: 'global', session_token: restored.session_token,
    });
    assert.equal(reconcile.receipt_kind, 'CURRENTNESS_ADMISSION');
    assert.equal(reconcile.admission_eligible, true);
    assert.notEqual(reconcile.currentness_vector_digest, session.restored_currentness_digest);
    const committed = await rpc('clued_mcp_commit_checkpoint', checkpoint);
    assert.equal(committed.status, 'committed');
    const saved = (await admin.query(`select committed_currentness_vector,currentness_admission_status
      from public.clued_context_checkpoints where id=$1`, [committed.checkpoint_id])).rows[0];
    assert.equal(saved.currentness_admission_status, 'CURRENT');
    assert.equal(saved.committed_currentness_vector.scope.authority_revision, 1);
    const nextSession = await rpc('clued_mcp_restore', { context_key: 'global', response_view: 'structured' });
    const search = await rpc('clued_mcp_search_context', {
      context_key: 'global', session_token: nextSession.session_token,
      query: 'new current authority', include_history: false,
    });
    assert.ok(search.results.some((row) => row.kind === 'event' &&
      Number(row.id) === Number(event.event_id) &&
      row.source_semantics === 'canonical_material_event'));
    const carrier = (await admin.query(`select carrier_state from clued_private.event_truth_carriers
      where event_id=$1`, [event.event_id])).rows[0];
    assert.equal(carrier.carrier_state, 'ACTIVE_UNSTRUCTURED');
    const primaryBindingId = (await admin.query(`select id from public.clued_agent_bindings
      where user_id=$1 and token_hash=clued_private.credential_verifier_v1($2)`, [userId, tokenHash])).rows[0].id;
    const proofReceiptId = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,'global','continuity_only_resolution_authorized','event',
        $3,1,'{"proof":"verified"}'::jsonb) returning id`,
    [userId, primaryBindingId, String(event.event_id)])).rows[0].id;
    const resolvedCarrier = await rpc('clued_mcp_event_carrier_transition', {
      context_key: 'global', source_event_id: event.event_id,
      expected_transition_version: 1, transition: 'resolve',
      proof_receipt_id: proofReceiptId, idempotency_key: uuid(),
    });
    assert.equal(resolvedCarrier.status, 'transitioned');

    // The Worker rebuild above created the system Frontier projection record. The
    // scenario below reconstructs the pre-projection legacy state (a hand-bound
    // Frontier), so detach the system projection's head and binding first; the
    // fence only accepts the single record the projection head points to.
    await admin.query(`delete from clued_private.projection_record_bindings
      where user_id=$1 and projection_key='global.priority_frontier'`, [userId]);
    await admin.query(`delete from clued_private.projection_heads
      where user_id=$1 and projection_key='global.priority_frontier'`, [userId]);

    // T-CUR-28/35/45: a Project terminal source invalidates a preexisting
    // Global frontier; only a separately granted builder can rebuild it.
    const stateId = uuid();
    const oldFrontier = await rpc('clued_record_mutate', {
      operation: 'create', id: stateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Projection fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Global frontier', content: 'NOT_DEPLOYED',
        type_fields: { state_kind: 'frontier' }, relations: {} },
    });
    assert.equal(oldFrontier.status, 'committed');
    await admin.query(`insert into clued_private.projection_record_bindings
      (record_id,user_id,target_scope,projection_key,projection_owner)
      values($1,$2,'global','global.priority_frontier','fixture_legacy')`, [stateId, userId]);
    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    await admin.query(`update public.clued_agent_bindings set context_keys=array['global','system:projects']
      where user_id=$1`, [userId]);
    const legacyProject = async (input) => (await anon.query('select public.clued_project_mutate($1,$2) value', [tokenHash,input])).rows[0].value;
    const createdProject = await legacyProject({
      operation: 'create', canonical_project_id: projectId, project_schema_version: 1,
      idempotency_key: uuid(),
      mutation: { name: 'Released project', certainty_status: 'confirmed', progress_status: 'active' },
    });
    assert.equal(createdProject.status, 'committed');
    await admin.query(`update public.clued_agent_bindings set context_keys=array['global','system:projects',$2]
      where user_id=$1`, [userId, projectScope]);
    const projectStateId = uuid();
    const projectState = await rpc('clued_record_mutate', {
      operation: 'create', id: projectStateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Terminal fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Project release status', content: 'PRODUCTION_DEPLOYED',
        type_fields: { state_kind: 'release' }, relations: {} },
    });
    assert.equal(projectState.status, 'committed');
    const projectStateReceiptId = (await admin.query('select receipt_id from public.clued_memories where id=$1',
      [projectStateId])).rows[0].receipt_id;
    const completedProject = await legacyProject({
      operation: 'complete', canonical_project_id: projectId, project_schema_version: 1,
      base_version: 1, idempotency_key: uuid(),
      mutation: { closure_summary: 'Production deployed', closed_reason: 'Release complete' },
    });
    assert.equal(completedProject.status, 'committed');
    const terminalReceiptId = (await admin.query('select receipt_id from public.clued_projects where id=$1',
      [projectId])).rows[0].receipt_id;
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', await findGatewayCloseoutMigration(root)), 'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual((await rpc('clued_record_list', {
      level: 'global', record_type: 'state',
    })).records, []);
    assert.equal((await rpc('clued_mcp_currentness_g6_gate', { project_id: projectId })).status,
      'not_ready');
    const projectOnlyBinding = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Project only',$2,array['context:read'],array[$3])
      returning id`, [userId, hash(), projectScope])).rows[0].id;
    const projectOnlyBefore = (await admin.query(`select clued_private.currentness_vector($1,$2,$3) value`,
      [userId, projectScope, projectOnlyBinding])).rows[0].value;
    assert.equal(projectOnlyBefore.global_authority_revision, null);
    assert.equal(projectOnlyBefore.authority_unknown, true);
    const oldFrontierVersion = (await admin.query('select version from public.clued_memories where id=$1', [stateId])).rows[0].version;
    const changedFrontier = await rpc('clued_record_mutate', {
      operation: 'update', id: stateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', base_version: oldFrontierVersion,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Projection fixture', source_refs: [], source_unavailable_reason: null,
      mutation: { content: 'PRODUCTION_DEPLOYED' },
    });
    assert.equal(changedFrontier.status, 'committed');
    const projectOnlyAfter = (await admin.query(`select clued_private.currentness_vector($1,$2,$3) value`,
      [userId, projectScope, projectOnlyBinding])).rows[0].value;
    assert.deepEqual(projectOnlyAfter, projectOnlyBefore);
    // v2 requires a live Task source and complete source-read capability;
    // this does not weaken the earlier project-only authorization assertions.
    await admin.query("update public.clued_agent_bindings set context_keys=array['*'] where id=$1", [primaryBindingId]);
    const frontierTaskId = uuid();
    const frontierTask = await rpc('clued_record_mutate', {
      operation: 'create', id: frontierTaskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Synthetic Frontier source',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Accepted continuation', content: 'Accepted continuation',
        type_fields: { execution_bucket: 'now' }, relations: {} },
    });
    assert.equal(frontierTask.status, 'committed');
    const ruleDigest = (await admin.query('select clued_private.frontier_rule_digest_v2() value')).rows[0].value;
    const frontierVersion = (await admin.query('select version from public.clued_memories where id=$1', [stateId])).rows[0].version;
    const sourceBinding = await rpc('clued_record_mutate', {
      operation: 'update', id: stateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', base_version: frontierVersion,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Synthetic bound Frontier', mutation: { type_fields: {
        state_kind: 'frontier', projection_key: 'global.priority_frontier',
        source_task: { id: frontierTaskId, version: 1, scope: 'global' },
        render_rule_version: 'task-body.v1', rule_set_digest: ruleDigest,
      } },
    });
    assert.equal(sourceBinding.status, 'committed');
    const bindingId = primaryBindingId;
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','test-admin'),
            ($1,$2,'global','global.__aggregate__','test-admin')`, [bindingId, userId]);
    const sourceSnapshot = (await admin.query('select clued_private.projection_source_snapshot($1) value', [userId])).rows[0].value;
    const sourceDigest = (await admin.query('select clued_private.currentness_hash($1::jsonb) value', [sourceSnapshot])).rows[0].value;
    const revisions = (await admin.query(`select projection_key,invalidation_revision
      from clued_private.projection_invalidation_heads where user_id=$1 and target_scope='global'`, [userId])).rows;
    const revision = Object.fromEntries(revisions.map((row) => [row.projection_key, Number(row.invalidation_revision)]));
    await assert.rejects(() => rpc('clued_mcp_full_global_reconcile', {
      expected_invalidation_revision: revision['global.__aggregate__'],
      expected_source_vector_digest: sourceDigest,
    }), /required_projection_stale/);
    await assert.rejects(() => rpc('clued_mcp_projection_rebuild', {
      projection_key: 'global.priority_frontier', record_id: stateId,
      expected_invalidation_revision: revision['global.priority_frontier'],
      expected_source_vector_digest: '0'.repeat(64),
    }), /projection_source_changed/);
    const rebuild = await rpc('clued_mcp_projection_rebuild', {
      projection_key: 'global.priority_frontier', record_id: stateId,
      expected_invalidation_revision: revision['global.priority_frontier'],
      expected_source_vector_digest: sourceDigest,
    });
    assert.equal(rebuild.status, 'rebuilt');
    assert.equal((await rpc('clued_record_list', {
      level: 'global', record_type: 'state',
    })).records.length, 1);
    assert.equal((await admin.query('select content from public.clued_memories where id=$1', [stateId])).rows[0].content,
      'PRODUCTION_DEPLOYED');
    await assert.rejects(() => rpc('clued_mcp_full_global_reconcile', {
      expected_invalidation_revision: revision['global.__aggregate__'] - 1,
      expected_source_vector_digest: sourceDigest,
    }), /full_reconcile_cas_conflict/);
    const full = await rpc('clued_mcp_full_global_reconcile', {
      expected_invalidation_revision: revision['global.__aggregate__'],
      expected_source_vector_digest: sourceDigest,
    });
    assert.equal(full.status, 'reconciled');
    const gate = await rpc('clued_mcp_currentness_g6_gate', { project_id: projectId });
    assert.equal(gate.status, 'not_ready');
    assert.ok(gate.missing_requirements.includes('fresh_project_global_receipts'));

    const globalCutover = await rpc('clued_mcp_restore', {
      context_key: 'global', response_view: 'structured',
    });
    const cutoverAdmission = await rpc('clued_mcp_session_reconcile', {
      context_key: 'global', session_token: globalCutover.session_token,
    });
    assert.equal(cutoverAdmission.admission_eligible, true);
    const cutoverCheckpoint = await rpc('clued_mcp_commit_checkpoint', {
      context_key: 'global', session_token: globalCutover.session_token,
      base_version: globalCutover.version, snapshot: { release: 'current' },
      summary: 'Fresh Global release checkpoint', next_action: 'Current projection ready',
      coverage: { mode: 'explicit', contexts: ['global'], tracks: ['state'], event_ids: [] },
      idempotency_key: uuid(),
    });
    assert.equal(cutoverCheckpoint.status, 'committed');
    const freshGlobal = await rpc('clued_mcp_restore', {
      context_key: 'global', response_view: 'structured',
    });
    const freshProject = await rpc('clued_mcp_restore', {
      context_key: projectScope, response_view: 'structured',
    });
    const globalAdmission = await rpc('clued_mcp_session_reconcile', {
      context_key: 'global', session_token: freshGlobal.session_token,
    });
    const projectAdmission = await rpc('clued_mcp_session_reconcile', {
      context_key: projectScope, session_token: freshProject.session_token,
    });
    assert.equal(globalAdmission.admission_eligible, true);
    assert.equal(projectAdmission.admission_eligible, true);
    await admin.query(`insert into clued_private.currentness_transport_attestations
      (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by)
      values('production',$1,$2,true,$3::jsonb,now(),'synthetic-test-verifier')`,
    ['a'.repeat(40), 'b'.repeat(64), JSON.stringify({
      source_commit: 'a'.repeat(40), deployed_commit: 'a'.repeat(40),
      test_digest: 'b'.repeat(64), verification_status: 'passed',
      verification_context: 'production_post_deploy',source_worktree_dirty: false,
      live_health_url: 'https://clued.pixelgrav.com/healthz',
      test_files: Array(8).fill('synthetic-fixture'),
    })]);
    const missingTerminal = await rpc('clued_mcp_currentness_g6_gate', {
      project_id: projectId,
      project_state_receipt_id: projectStateReceiptId,
      project_receipt_id: projectAdmission.currentness_receipt_id,
      global_receipt_id: globalAdmission.currentness_receipt_id,
      project_session_token: freshProject.session_token,
      global_session_token: freshGlobal.session_token,
    });
    assert.equal(missingTerminal.status, 'not_ready');
    assert.ok(missingTerminal.missing_requirements.includes('project_terminal_source_receipts'));
    const closedGate = await rpc('clued_mcp_currentness_g6_gate', {
      project_id: projectId,
      __transport_source_commit: 'a'.repeat(40),
      terminal_receipt_id: terminalReceiptId,
      project_state_receipt_id: projectStateReceiptId,
      project_receipt_id: projectAdmission.currentness_receipt_id,
      global_receipt_id: globalAdmission.currentness_receipt_id,
      project_session_token: freshProject.session_token,
      global_session_token: freshGlobal.session_token,
    });
    assert.equal(closedGate.status, 'transport_precheck_ready');
    assert.deepEqual(closedGate.missing_requirements, []);
    const driftedGate = await rpc('clued_mcp_currentness_g6_gate', {
      project_id: projectId,
      __transport_source_commit: 'c'.repeat(40),
      terminal_receipt_id: terminalReceiptId,
      project_state_receipt_id: projectStateReceiptId,
      project_receipt_id: projectAdmission.currentness_receipt_id,
      global_receipt_id: globalAdmission.currentness_receipt_id,
      project_session_token: freshProject.session_token,
      global_session_token: freshGlobal.session_token,
    });
    assert.equal(driftedGate.status, 'not_ready');
    assert.ok(driftedGate.missing_requirements.includes('all_path_checkpoint_enforcement'));
    await admin.query(`update clued_private.currentness_transport_attestations
      set evidence=jsonb_set(evidence,'{test_digest}','"unverified"'::jsonb)
      where environment='production'`);
    const unverifiedGate = await rpc('clued_mcp_currentness_g6_gate', {
      project_id: projectId,
      terminal_receipt_id: terminalReceiptId,
      project_state_receipt_id: projectStateReceiptId,
      project_receipt_id: projectAdmission.currentness_receipt_id,
      global_receipt_id: globalAdmission.currentness_receipt_id,
      project_session_token: freshProject.session_token,
      global_session_token: freshGlobal.session_token,
    });
    assert.equal(unverifiedGate.status, 'not_ready');
    assert.ok(unverifiedGate.missing_requirements.includes('all_path_checkpoint_enforcement'));
    await admin.query(`update clued_private.currentness_transport_attestations
      set evidence=jsonb_set(evidence,'{test_digest}',to_jsonb(test_digest))
      where environment='production'`);

    // T-CUR-38: a mutation holding the user currentness lock commits before
    // the competing checkpoint evaluates its vector; no partial checkpoint.
    const raceSession = await rpc('clued_mcp_restore', {
      context_key: 'global', response_view: 'structured',
    });
    const revisionBeforeRace = Number((await admin.query(`select snapshot_revision
      from clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
    [userId])).rows[0].snapshot_revision);
    await admin.query('begin');
    try {
      await admin.query(`update public.clued_memories set content='RACE_WINNER',
        version=version+1,updated_at=now() where id=$1`, [stateId]);
      const pendingCheckpoint = rpc('clued_mcp_commit_checkpoint', {
        context_key: 'global', session_token: raceSession.session_token,
        base_version: raceSession.version, snapshot: { marker: 'old source' },
        summary: 'Concurrent checkpoint', next_action: 'Wait for current truth',
        coverage: { mode: 'explicit', contexts: ['global'], tracks: ['state'], event_ids: [] },
        idempotency_key: uuid(),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await admin.query('commit');
      const raceResult = await Promise.race([
        pendingCheckpoint,
        new Promise((_, reject) => setTimeout(() => reject(new Error('checkpoint lock timeout')), 5000)),
      ]);
      assert.deepEqual({ status: raceResult.status, error: raceResult.error },
        { status: 'conflict', error: 'current_truth_changed_since_resume' });
      assert.equal((await admin.query(`select count(*)::integer n from public.clued_context_checkpoints
        where session_id=(select id from public.clued_continuity_sessions
          where token_hash=encode(extensions.digest($1,'sha256'),'hex'))`,
      [raceSession.session_token])).rows[0].n, 0);
    } catch (error) {
      await admin.query('rollback').catch(() => {});
      throw error;
    }
    const revisionAfterRace = Number((await admin.query(`select snapshot_revision
      from clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
    [userId])).rows[0].snapshot_revision);
    assert.equal(revisionAfterRace, revisionBeforeRace + 1);

    // T-CUR-07/44: only a typed dependency edge carries A's source revision
    // into B's vector. Unrelated C has the same vector after A changes.
    const projectB = uuid();
    const projectC = uuid();
    const scopeB = `project:${projectB}`;
    const scopeC = `project:${projectC}`;
    await admin.query(`insert into public.clued_projects
      (id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$3,'Dependency B','dependency b',$4,'confirmed',now()),
            ($2,$3,'Unrelated C','unrelated c',$5,'confirmed',now())`,
    [projectB, projectC, userId, scopeB, scopeC]);
    await admin.query(`update public.clued_agent_bindings set
      context_keys=array['global','system:projects',$2,$3,$4]
      where id=$1`, [primaryBindingId, projectScope, scopeB, scopeC]);
    const taskA = uuid();
    const taskAResult = await rpc('clued_record_mutate', {
      operation: 'create', id: taskA, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Dependency fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Task A', content: 'A first',
        type_fields: { execution_bucket: 'next' }, relations: {} },
    });
    assert.equal(taskAResult.status, 'committed');
    const taskBResult = await rpc('clued_record_mutate', {
      operation: 'create', id: uuid(), record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: scopeB, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Dependency fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Task B waits for A', content: 'Typed dependency',
        type_fields: { execution_bucket: 'next' }, relations: { depends_on: [taskA] } },
    });
    assert.equal(taskBResult.status, 'committed');
    const readVector = async (scope) => (await admin.query(
      'select clued_private.currentness_vector($1,$2,$3) value',
      [userId, scope, primaryBindingId])).rows[0].value;
    const beforeB = await readVector(scopeB);
    const beforeC = await readVector(scopeC);
    assert.equal(beforeB.dependency_sources.length, 1);
    assert.equal(beforeC.dependency_sources.length, 0);
    const taskAVersion = (await admin.query('select version from public.clued_memories where id=$1', [taskA])).rows[0].version;
    const taskAUpdate = await rpc('clued_record_mutate', {
      operation: 'update', id: taskA, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: projectScope, base_version: taskAVersion,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Dependency fixture', source_refs: [], source_unavailable_reason: null,
      mutation: { content: 'A changed' },
    });
    assert.equal(taskAUpdate.status, 'committed');
    assert.notDeepEqual(await readVector(scopeB), beforeB);
    assert.deepEqual(await readVector(scopeC), beforeC);
    const beforeGlobalAuthority = await readVector(scopeB);
    const projectSessionBeforeAuthority = await rpc('clued_mcp_restore', {
      context_key: scopeB, response_view: 'structured',
    });
    const authorityWrite = await rpc('clued_record_mutate', {
      operation: 'create', id: uuid(), record_type: 'decision', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Global authority fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Global policy', content: 'Applies to project sessions',
        type_fields: { rationale: 'Authority fixture' }, relations: {} },
    });
    assert.equal(authorityWrite.status, 'committed');
    const afterGlobalAuthority = await readVector(scopeB);
    assert.ok(afterGlobalAuthority.global_authority_revision >
      beforeGlobalAuthority.global_authority_revision);
    const narrowedCoverage = await rpc('clued_mcp_commit_checkpoint', {
      context_key: scopeB, session_token: projectSessionBeforeAuthority.session_token,
      base_version: projectSessionBeforeAuthority.version,
      snapshot: { task: 'B' }, summary: 'Old B summary', next_action: 'Old B action',
      coverage: { mode: 'explicit', contexts: [scopeB], tracks: ['unrelated'], event_ids: [] },
      idempotency_key: uuid(),
    });
    assert.deepEqual({ status: narrowedCoverage.status, error: narrowedCoverage.error },
      { status: 'conflict', error: 'current_truth_changed_since_resume' });
    // Reapply the actual formal closeout after all fixture scenarios; no skip.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);
    // The unchanged closeout above seals all actual historical scenarios.
    // The current pair has its own identity, caller ACL and early-entry proof.
    const authorizationBefore = await snapshotAuthorizationCallerBoundary(admin);
    for (const name of AUTHORIZATION_SUCCESSOR_MIGRATIONS) {
      await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
    }
    await assertAuthorizationSuccessorBoundary(admin, authorizationBefore);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
