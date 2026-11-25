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
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Owner Credential v0.1, rollout step 1 (migration 20261002220000_owner_grants_v1;
// OwnerCredential.v0.1.md §3, §4): Agents create Owner Requests, only the
// Owner's Native session turns them into scoped grants (two-step token), and
// doors consume grants through owner_grant_consume_v1.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The sealed G6 closeout qualifies its original sources, before these two
// authorized successors. Keep its real replay and separately prove the current
// catalog rather than asking the historical seal to accept a changed body.
async function applyQualifiedMigrations(admin, names) {
  const targets = ['public.clued_project_mutate(text,jsonb)',
    'public.clued_development_owner_v14(jsonb)', 'public.clued_authorization_manage_v12(jsonb)'];
  const catalog = async () => (await admin.query(`select p.oid, p.oid::regprocedure::text signature,
    pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl
    from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid`, [targets])).rows;
  let originalTargets;
  const successors = new Map([
    ['20261014044323_all_contexts_authorization_v2.sql', 'b78cb49134f2788c3f1fbc7438c4647a8e89cdcedf3519d540305d1105b845b8'],
    ['20261014045157_all_contexts_serialization_v2.sql', 'ce8ee42d89240a338cbd229846c397f9626f1445e2dfa832b60c19fecb994e58'],
  ]);
  for (const name of names) {
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      await assertGatewayCloseoutBoundary(admin);
      const closedCatalog = await snapshotCallerCatalog(admin);
      await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', CLOSEOUT_MIGRATION), 'utf8'));
      await assertGatewayCloseoutBoundary(admin);
      assert.deepEqual(await snapshotCallerCatalog(admin), closedCatalog,
        'actual sealed G6 replay preserves original definitions and ACL at its bounded stage');
      originalTargets = await catalog();
      assert.equal(originalTargets.length, targets.length);
    }
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    if (successors.has(name)) assert.equal(crypto.createHash('sha256').update(sql).digest('hex'), successors.get(name));
    try { await admin.query(sql); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, false);
    }
  }
  assert.ok(originalTargets, 'both successors run only after the bounded closeout proof');
  assert.deepEqual(await catalog(), originalTargets, 'successors preserve existing OIDs, owners, security metadata and ACL');
  await assertGatewayCloseoutBoundary(admin);
  assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  assert.equal((await admin.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid='public.clued_project_mutate(text,jsonb)'::regprocedure")).rows[0].source_hash,
    '64503257b828c3dcf1405fc378a9d297faf559cec29a373e77e5013e2eb76262', 'retired alias keeps its sealed business body');
  for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
    assert.equal((await admin.query("select has_function_privilege($1,'public.clued_project_mutate(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed,
      false, role + ' cannot execute the retired alias');
  }
  for (const signature of ['clued_private.authorization_writer_guard_v2(uuid)',
    'clued_private.authorization_writer_require_v2(uuid)', 'clued_private.authorization_sources_view_v2(uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
      assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed,
        false, `${role} cannot directly call private successor helper ${signature}`);
    }
  }
}

const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
// An old sign-in on purpose: grants do not require a recent login (Decision 667f588b).
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 3 * 86400 }], ...extra });


test('owner grants: requests, Native two-step grants, consumption and revocation',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-grants-'));
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
    await applyQualifiedMigrations(admin, (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort());
    await allowRawTestBindings(admin);
    await enableManualOwnerApprovalFixture(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'owner-grants@example.invalid',now()),($2,'owner-grants-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['codex', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
    ]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
    }

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) => CI_SIGNATURES.includes(name+'(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
      : workerGatewayRpc(workerCaller,name,tokens[who],input);
    const native = async (name, input, claims = session(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const consume = async (binding, action, resources, taskId = null) => (await admin.query(
      'select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5) v',
      [userId, binding, action, resources, taskId])).rows[0].v;
    const confirm = async (input, claims) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return issued;
    };
    const grant = (issued, claims, digest = issued.view_digest) =>
      native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: digest }, claims);
    const assertGrantDuration = async (granted, seconds, message) => {
      // The grant response omits granted_at; use the grant's own server-side timestamp.
      const { granted_at: grantedAt } = (await admin.query(
        'select granted_at from clued_private.owner_grants_v1 where id=$1', [granted.grant_id])).rows[0];
      const durationMs = new Date(granted.expires_at).getTime() - grantedAt.getTime();
      assert.ok(Math.abs(durationMs - seconds * 1000) <= 1, `${message}: ${durationMs} ms`);
    };

    // --- Agent creates a request; a retry with the same key replays it. ---
    const commit = 'repo:tdoljyj/cross-memory-system/4f49b0e8';
    const requestInput = { action: 'release.production', resources: [commit], idempotency_key: 'release-request-fixture',
      suggested_grant: { expires_seconds: 7200 }, agent_note: '发布 #502 的数据库函数，已备份' };
    const created = committed(await agent('claude', 'clued_owner_request_v1', requestInput));
    const request = created.request;
    assert.equal(request.status, 'pending');
    assert.equal(request.confirm_path, `/confirm/${request.request_id}`);
    assert.deepEqual(request.resources, [commit]);
    const replay = committed(await agent('claude', 'clued_owner_request_v1', requestInput));
    assert.equal(replay.replayed, true);
    assert.equal(replay.request.request_id, request.request_id);
    // Unknown actions and unknown resource kinds are refused; a read-only Binding cannot ask.
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1',
      { ...requestInput, idempotency_key: 'bad-action-1', action: 'merge.main' }), /owner_grant_action_unknown/);
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1',
      { ...requestInput, idempotency_key: 'bad-kind-01', resources: ['calendar:x'] }), /work_claim_resource_kind_unknown/);
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1',
      { ...requestInput, idempotency_key: 'too-long-01', suggested_grant: { expires_seconds: 604801 } }),
      /owner_request_suggested_grant_invalid/);
    await assert.rejects(() => agent('reader', 'clued_owner_request_v1',
      { ...requestInput, idempotency_key: 'reader-0001' }));
    // Status is readable by the Owner's Agents, not by another user's.
    assert.equal((await agent('reader', 'clued_owner_request_status_v1', { request_id: request.request_id })).request.status,
      'pending');
    assert.equal((await agent('stranger', 'clued_owner_request_status_v1', { request_id: request.request_id })).error_code,
      'owner_request_not_found');

    // --- Agents cannot reach the Owner side. ---
    await assert.rejects(() => anon.query('select public.clued_owner_grant_confirmation_issue_v1($1)', [{}]),
      /permission denied/);
    await assert.rejects(() => anon.query('select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5)',
      [userId, bindingIds.claude, 'release.production', [commit], null]), /permission denied/);
    await assert.rejects(() => anon.query('select * from clued_private.owner_grants_v1'), /permission denied/);
    // A delegated OAuth token (client_id) is not the Owner's own session.
    await assert.rejects(() => native('clued_owner_request_view_v1', { request_id: request.request_id },
      session(userId, 'sess-main', { client_id: 'some-agent' })), /direct_human_session_required/);
    // Without a session id no token is issued.
    const { session_id: _omit, ...noSession } = session(userId);
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { request_id: request.request_id }, noSession))
      .error_code, 'confirmation_token_session_id_required');
    // Another user sees nothing.
    assert.equal((await native('clued_owner_request_view_v1', { request_id: request.request_id }, session(otherUser)))
      .error_code, 'owner_request_not_found');

    // --- The page view is rendered by Clued; the Agent note is marked unverified. ---
    const view = await native('clued_owner_request_view_v1', { request_id: request.request_id });
    assert.equal(view.view.action, 'release.production');
    assert.equal(view.view.action_title, '运行生产发布（deploy 模式）');
    assert.deepEqual(view.view.resources, [commit]);
    assert.equal(view.view.grantee.binding_id, bindingIds.claude);
    // A high-risk action opens on "approve once" (Decision b7053465); the
    // Agent's suggested duration stays available for "grant for a while".
    assert.equal(view.default_choice, 'once');
    assert.equal(view.suggested_expires_seconds, 7200);
    assert.equal(view.view.choice, 'once');
    assert.equal(view.view.expires_seconds, 86400);
    assert.equal(view.view.max_uses, 1);
    assert.deepEqual((await admin.query(`select action,risk from clued_private.owner_grant_actions order by action`)).rows,
      [{ action: 'ci.connection_renew', risk: 'high' }, { action: 'ci.resident_upgrade', risk: 'high' },
        { action: 'connection.permission', risk: 'high' }, { action: 'fleet.accept', risk: 'high' }, { action: 'migration.production', risk: 'high' },
        { action: 'model.dataset_split.bootstrap', risk: 'high' },
        { action: 'model.dataset_split.producer', risk: 'high' }, { action: 'model.dataset_split.recognize', risk: 'high' },
        { action: 'model.dataset_split.verify', risk: 'high' },
        { action: 'release.production', risk: 'high' }, { action: 'repo.protected_change', risk: 'high' },
        { action: 'work_claim.extra_claims', risk: 'routine' }]);
    assert.equal(view.view.request.agent_note_unverified, '发布 #502 的数据库函数，已备份');

    // --- Nothing is consumable before the Owner confirms. ---
    assert.equal(await consume(bindingIds.claude, 'release.production', [commit]), null);

    // --- Two-step: a stale digest burns the token; a fresh one commits. ---
    let issued = await confirm({ request_id: request.request_id });
    assert.equal(issued.confirmation_view.expires_seconds, 7200);
    assert.equal((await grant(issued, undefined, '0'.repeat(64))).error_code, 'confirmation_token_binding_mismatch');
    assert.equal((await grant(issued)).error_code, 'confirmation_token_reused');
    issued = await confirm({ request_id: request.request_id });
    // Another session of the Owner cannot use this token.
    assert.equal((await grant(issued, session(userId, 'sess-other'))).error_code, 'confirmation_token_binding_mismatch');
    issued = await confirm({ request_id: request.request_id, expires_seconds: 3600 });
    const given = committed(await grant(issued));
    assert.equal(given.grant.any_agent, false);
    // A retry of the same committed token replays.
    const again = committed(await grant(issued));
    assert.equal(again.replayed, true);
    assert.equal(again.grant.grant_id, given.grant.grant_id);
    const status = await agent('claude', 'clued_owner_request_status_v1', { request_id: request.request_id });
    assert.equal(status.request.status, 'granted');
    assert.equal(status.request.grant.grant_id, given.grant.grant_id);
    await assertGrantDuration(given.grant, 3600, 'requested 1 hour');
    // A decided request takes no further confirmation.
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { request_id: request.request_id })).error_code,
      'owner_request_decided');

    // --- Consumption: requester only, covered resources only, Receipt per use. ---
    const used = await consume(bindingIds.claude, 'release.production', [commit]);
    assert.equal(used.grant_id, given.grant.grant_id);
    assert.equal(used.use, 1);
    assert.equal(await consume(bindingIds.codex, 'release.production', [commit]), null, 'grantee is the requester');
    assert.equal(await consume(bindingIds.claude, 'release.production', ['repo:tdoljyj/cross-memory-system/other']), null);
    assert.equal(await consume(bindingIds.claude, 'migration.production', [commit]), null, 'other action');
    assert.equal((await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where operation='owner_grant_use' and object_id=$1`, [given.grant.grant_id])).rows[0].n, 1);

    // --- Approve once: one use, then nothing. ---
    const onceReq = committed(await agent('codex', 'clued_owner_request_v1', { action: 'migration.production',
      resources: [commit], idempotency_key: 'migrate-once-fixture' })).request;
    committed(await grant(await confirm({ request_id: onceReq.request_id, choice: 'once' })));
    assert.equal((await agent('codex', 'clued_owner_request_status_v1', { request_id: onceReq.request_id })).request.status,
      'approved_once');
    assert.ok(await consume(bindingIds.codex, 'migration.production', [commit]));
    assert.equal(await consume(bindingIds.codex, 'migration.production', [commit]), null);

    // --- Any agent, glob scope, task-bound, revocation. ---
    const taskId = (await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed', confidence_reason: 'owner grants fixture',
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'grant fixture', content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const anyReq = committed(await agent('claude', 'clued_owner_request_v1', { action: 'work_claim.extra_claims',
      resources: [`record:${taskId}`], task_id: taskId, idempotency_key: 'extra-claims-1',
      suggested_grant: { expires_seconds: 86400, max_uses: 5 } })).request;
    // A routine action opens on "grant for a while" with the Agent's suggestion.
    const routine = await native('clued_owner_request_view_v1', { request_id: anyReq.request_id });
    assert.equal(routine.default_choice, 'grant');
    assert.equal(routine.view.choice, 'grant');
    assert.equal(routine.view.expires_seconds, 86400);
    assert.equal(routine.view.max_uses, 5);
    const anyGrant = committed(await grant(await confirm({ request_id: anyReq.request_id, grantee: 'any_agent' })));
    assert.equal(anyGrant.grant.any_agent, true);
    assert.equal(anyGrant.grant.max_uses, 5);
    assert.ok(await consume(bindingIds.codex, 'work_claim.extra_claims', [`record:${taskId}`], taskId));
    assert.equal(await consume(bindingIds.codex, 'work_claim.extra_claims', [`record:${taskId}`], uuid()), null,
      'task-bound grant');
    const direct = committed(await grant(await confirm({ action: 'release.production',
      resources: ['repo:tdoljyj/cross-memory-system/**'] })));
    assert.equal(direct.grant.any_agent, true);
    await assertGrantDuration(direct.grant, 14400, 'default 4 hours');
    assert.equal((await consume(bindingIds.codex, 'release.production', ['repo:tdoljyj/cross-memory-system/abc1234']))
      .grant_id, direct.grant.grant_id);
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: direct.grant.grant_id }));
    assert.equal(await consume(bindingIds.codex, 'release.production', ['repo:tdoljyj/cross-memory-system/abc1234']), null);
    // Expired grants are not consumed.
    await admin.query(`update clued_private.owner_grants_v1 set granted_at=now()-interval '2 hours',
      expires_at=now()-interval '1 second' where id=$1`, [given.grant.grant_id]);
    assert.equal(await consume(bindingIds.claude, 'release.production', [commit]), null);

    // --- Limits on what the Owner can give. ---
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { action: 'release.production',
      resources: [commit], expires_seconds: 604801 })).error_code, 'owner_grant_duration_invalid');
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { request_id: anyReq.request_id,
      action: 'migration.production' })).error_code, 'owner_grant_request_fields_fixed');
    const week = await confirm({ action: 'release.production', resources: [commit], expires_seconds: 604800 });
    committed(await grant(week));

    // --- Rejection. ---
    const rejectReq = committed(await agent('claude', 'clued_owner_request_v1', { action: 'release.production',
      resources: ['repo:tdoljyj/cross-memory-system/deadbee'], idempotency_key: 'reject-deadbee' })).request;
    committed(await native('clued_owner_request_reject_v1', { request_id: rejectReq.request_id }));
    assert.equal((await agent('claude', 'clued_owner_request_status_v1', { request_id: rejectReq.request_id }))
      .request.status, 'rejected');
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { request_id: rejectReq.request_id })).error_code,
      'owner_request_decided');

    // --- The list shows live grants and pending requests. ---
    committed(await agent('claude', 'clued_owner_request_v1', { action: 'release.production',
      resources: ['repo:tdoljyj/cross-memory-system/feed123'], idempotency_key: 'pending-feed123' }));
    const list = await native('clued_owner_grants_list_v1', {});
    assert.equal(list.status, 'ok');
    const listed = list.grants.map((g) => g.grant_id);
    assert.ok(listed.includes(anyGrant.grant.grant_id));
    // Ids the Owner can match against what an Agent quotes (PermissionSimplification §3.4).
    const shown = list.grants.find((g) => g.grant_id === anyGrant.grant.grant_id);
    assert.equal(shown.request_id, anyReq.request_id);
    assert.equal(shown.task_id, taskId);
    assert.equal(shown.task_title, 'grant fixture');
    assert.ok(!listed.includes(direct.grant.grant_id), 'revoked grants are not listed');
    assert.ok(!listed.includes(given.grant.grant_id), 'expired grants are not listed');
    assert.equal(list.pending_requests.length, 1);
    // Current-chain behavior above is qualified independently of the bounded
    // historical closeout replay performed before applying the successors.
    await assertGatewayCloseoutBoundary(admin);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
