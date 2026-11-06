import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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

test('global-scope record and Event changes invalidate and rebuild both Global projections',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-global-invalidation-'));
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
    const hostToken = hash();
    const builderToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'global-inv@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Host',$2,array['context:read','context:write','audit:read'],array['*'])`,
    [userId, hostToken]);
    const builderId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'system','Projection Builder',$2,array['context:read'],array['*']) returning id`,
    [userId, builderToken])).rows[0].id;
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','owner-approved-test'),
            ($1,$2,'global','global.__aggregate__','owner-approved-test')`, [builderId, userId]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = async (token, name, input = {}) =>
      await workerGatewayRpc(workerCaller,name,token,input);
    const write = (input) => rpc(hostToken, 'clued_record_mutate', input);

    const heads = async () => ({
      'global.priority_frontier': { inv: 0, res: 0 }, 'global.__aggregate__': { inv: 0, res: 0 },
      ...Object.fromEntries((await admin.query(`select projection_key,
          invalidation_revision::int inv,resolved_through_revision::int res
        from clued_private.projection_invalidation_heads
        where user_id=$1 and target_scope='global'`, [userId])).rows
        .map((row) => [row.projection_key, { inv: row.inv, res: row.res }])),
    });
    const digestStatus = async () => Object.fromEntries(((await admin.query(
      'select clued_watchdog.projection_watchdog_snapshot() value')).rows[0].value.projections)
      .map((row) => [row.projection_key, row.source_digest_status]));
    // Drain the refresh queue exactly as the Worker does: claim → apply until idle.
    const drain = async () => {
      const applied = [];
      for (let round = 0; round < 6; round += 1) {
        await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
          where user_id=$1 and status in ('queued','failed')`, [userId]);
        const claim = await rpc(builderToken, 'clued_mcp_projection_refresh_claim');
        if (!claim.lease_id) return applied;
        const result = await rpc(builderToken, 'clued_mcp_projection_refresh_apply', {
          projection_key: claim.projection_key, lease_id: claim.lease_id,
          expected_invalidation_revision: claim.expected_invalidation_revision,
          expected_source_vector_digest: claim.expected_source_vector_digest,
        });
        assert.ok(['rebuilt', 'reconciled'].includes(result.status), JSON.stringify(result));
        applied.push(claim.projection_key);
      }
      throw new Error('projection refresh did not converge (self-invalidation loop)');
    };
    const assertCurrent = async (label) => {
      const now = await heads();
      for (const key of ['global.priority_frontier', 'global.__aggregate__']) {
        assert.equal(now[key].inv, now[key].res, `${label}: ${key} resolved`);
      }
      assert.deepEqual(await digestStatus(),
        { 'global.priority_frontier': 'match', 'global.__aggregate__': 'match' }, label);
      return now;
    };
    const assertInvalidatedBoth = (before, after, label) => {
      for (const key of ['global.priority_frontier', 'global.__aggregate__']) {
        assert.ok(after[key].inv > before[key].inv, `${label}: ${key} invalidated`);
        assert.ok(after[key].inv > after[key].res, `${label}: ${key} pending rebuild`);
      }
    };

    // Baseline: a global Task creates both projections; rebuilding converges and the
    // Frontier projection's own global State write does not invalidate it again.
    const taskId = uuid();
    assert.equal((await write({
      operation: 'create', id: taskId, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Global fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Global ready task', content: 'Do it',
        type_fields: { execution_bucket: 'next' }, relations: {} },
    })).status, 'committed');
    const created = await heads();
    assert.ok(created['global.priority_frontier'].inv > created['global.priority_frontier'].res);
    assert.ok(created['global.__aggregate__'].inv > created['global.__aggregate__'].res);
    assert.deepEqual((await drain()).sort(), ['global.__aggregate__', 'global.priority_frontier']);
    const baseline = await assertCurrent('after first rebuild');
    assert.deepEqual(await drain(), [], 'a rebuild must not enqueue another rebuild');
    assert.deepEqual(await heads(), baseline);
    assert.equal((await admin.query(`select type_fields->'source_task'->>'id' id
      from public.clued_memories where user_id=$1
        and type_fields->>'projection_key'='global.priority_frontier'`, [userId])).rows[0].id,
    taskId);

    // A global State create and close (the production incident) both invalidate.
    const stateId = uuid();
    assert.equal((await write({
      operation: 'create', id: stateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'Hand-written frontier note fixture',
      source_refs: [], source_unavailable_reason: 'Synthetic fixture',
      mutation: { title: 'Hand-written frontier note', content: 'Stale',
        type_fields: { state_kind: 'priority_frontier' }, relations: {} },
    })).status, 'committed');
    assertInvalidatedBoth(baseline, await heads(), 'global State create');
    await drain();
    const afterCreate = await assertCurrent('after State create rebuild');
    assert.equal((await write({
      operation: 'close', id: stateId, record_type: 'state', record_schema_version: 1,
      lifecycle_status: 'completed', scope: 'global', base_version: 1,
      idempotency_key: uuid(), authority: 'user_explicit', user_confirmed: true,
      confidence_reason: 'Superseded by the system projection',
      mutation: { closure_summary: 'Superseded by global.priority_frontier' },
    })).status, 'committed');
    assertInvalidatedBoth(afterCreate, await heads(), 'global State close');
    assert.equal((await admin.query(`select count(*)::int n from clued_private.projection_refresh_jobs
      where user_id=$1 and status='queued'`, [userId])).rows[0].n, 2);
    await drain();
    const afterClose = await assertCurrent('after State close rebuild');
    assert.equal((await rpc(hostToken, 'clued_mcp_mtpe_snapshot')).selected_frontier.record_id, taskId);

    // A global work_log Event (direct carrier) also invalidates both projections.
    const restored = await rpc(hostToken, 'clued_mcp_restore', {
      context_key: 'global', response_view: 'structured' });
    const event = await rpc(hostToken, 'clued_mcp_append_event', {
      context_key: 'global', session_token: restored.session_token, base_version: restored.version,
      event_type: 'action', payload: { marker: 'global direct action' }, idempotency_key: uuid(),
    });
    assert.equal(event.status, 'appended', JSON.stringify(event));
    assertInvalidatedBoth(afterClose, await heads(), 'global direct Event');
    await drain();
    const afterEvent = await assertCurrent('after Event rebuild');

    // Project-scoped changes keep their existing invalidation of both projections.
    const projectId = uuid();
    assert.equal((await rpc(hostToken, 'clued_project_mutate_v2', {
      operation: 'create', canonical_project_id: projectId, project_schema_version: 2,
      recognition: { confidence: 1, reason: 'Explicit synthetic Project fixture', source: 'v2_agent_recognition', source_refs: [] },
      idempotency_key: uuid(),
      mutation: { name: 'Scoped', progress_status: 'active' },
    })).status, 'committed');
    assert.equal((await write({
      operation: 'create', id: uuid(), record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: `project:${projectId}`, idempotency_key: uuid(),
      authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Project fixture',
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'Project task', content: 'Scoped',
        type_fields: { execution_bucket: 'next' }, relations: {} },
    })).status, 'committed');
    assertInvalidatedBoth(afterEvent, await heads(), 'project Task create');
    await drain();
    await assertCurrent('after project rebuild');
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
