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

test('owner pin: the Pin the write accepts is the Pin the snapshot selects',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-mtpe-owner-pin-'));
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
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'mtpe-pin@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Host',$2,array['context:read','context:write','audit:read'],array['*'])`,
    [userId, hostToken]);

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
    const focusRows = async () => (await admin.query(
      'select record_id from clued_private.mtpe_owner_focus where user_id=$1', [userId])).rows;
    const row = (view, id) => view.candidate_universe.find((entry) => entry.record_id === id);

    // A project-scoped fixture avoids clued_now_global_uidx (one global 'now' Task per user).
    const projectId = uuid();
    const scope = `project:${projectId}`;
    assert.equal((await rpc(hostToken, 'clued_project_mutate_v2', {
      operation: 'create', canonical_project_id: projectId, project_schema_version: 2,
      idempotency_key: uuid(),
      mutation: { name: 'MTPE Owner Pin', progress_status: 'active' },
    })).status, 'committed');

    const createTask = async (title, typeFields) => {
      const id = uuid();
      const result = await write({
        operation: 'create', id, record_type: 'task', record_schema_version: 1,
        lifecycle_status: 'active', scope, idempotency_key: uuid(),
        authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Owner Pin fixture', source_refs: [],
        source_unavailable_reason: null,
        mutation: { title, content: title, type_fields: typeFields, relations: {} },
      });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return id;
    };

    // A Canonical Task carrying a backfilled intake_kind label derives a non-TASK
    // intake kind. It outranks the ready control, so the system Frontier would
    // pick it if the label were ignored there; it must not be.
    const readyId = await createTask('Ready normal task',
      { execution_bucket: 'next', criticality: 'NORMAL', priority: 30, user_product_impact: 4 });
    const labelledId = await createTask('Backfilled residual scope task', {
      execution_bucket: 'next', criticality: 'HIGH', priority: 90,
      intake_kind: 'legacy_residual_scope',
    });
    const before = await snapshot();
    assert.equal(row(before, labelledId).intake_kind, 'LEGACY_RESIDUAL_SCOPE');
    assert.ok(row(before, labelledId).algorithm_priority > row(before, readyId).algorithm_priority);
    assert.equal(before.system_recommended_frontier.record_id, readyId);
    assert.equal(before.owner_selected_current_focus, null);

    // 1. The Pin the write accepts is the Pin every reader selects.
    const pinned = await pin('set', labelledId, 1);
    assert.equal(pinned.status, 'committed', JSON.stringify(pinned));
    assert.equal(pinned.supplemental.owner_focus.record_id, labelledId);
    const after = await snapshot();
    assert.equal(after.owner_selected_current_focus.record_id, labelledId);
    assert.equal(after.owner_selected_current_focus.status, 'OWNER_SELECTED_READY');
    assert.equal(after.selected_frontier.record_id, labelledId);
    assert.equal(after.selected_frontier.selection_source, 'OWNER_PIN');
    // The system recommendation is unchanged: still Task-kind only.
    assert.equal(after.system_recommended_frontier.record_id, readyId);
    const validation = await validate();
    assert.equal(validation.status, 'pass', JSON.stringify(validation));
    assert.equal((await pin('cancel', labelledId, 1)).status, 'committed');
    assert.equal((await snapshot()).owner_selected_current_focus, null);

    // 2. A set the snapshot does not select is rejected and rolled back, never
    //    reported committed. Fault-inject a snapshot that drops the owner focus.
    const snapshotSource = (await admin.query(
      "select pg_get_functiondef('clued_private.mtpe_snapshot(uuid)'::regprocedure) def")).rows[0].def;
    await admin.query(`alter function clued_private.mtpe_snapshot(uuid)
      rename to mtpe_snapshot_real`);
    await admin.query(`create function clued_private.mtpe_snapshot(p_user_id uuid)
      returns jsonb language sql stable security definer set search_path to '' as
      $$select clued_private.mtpe_snapshot_real(p_user_id)
        ||jsonb_build_object('owner_selected_current_focus',null)$$`);
    try {
      const ineffective = await pin('set', readyId, 1);
      assert.equal(ineffective.status, 'rejected', JSON.stringify(ineffective));
      assert.match(JSON.stringify(ineffective), /owner_pin_not_effective/);
      assert.equal((await admin.query(
        'select count(*)::int n from clued_private.mtpe_owner_focus where user_id=$1',
        [userId])).rows[0].n, 0, 'the rejected Pin must be rolled back');
    } finally {
      await admin.query('drop function clued_private.mtpe_snapshot(uuid)');
      await admin.query(`alter function clued_private.mtpe_snapshot_real(uuid)
        rename to mtpe_snapshot`);
    }
    assert.equal((await admin.query(
      "select pg_get_functiondef('clued_private.mtpe_snapshot(uuid)'::regprocedure) def")).rows[0].def,
    snapshotSource);
    assert.equal((await pin('set', readyId, 1)).status, 'committed');
    assert.equal((await snapshot()).selected_frontier.record_id, readyId);

    // 3. Focus CAS: a set names the focus it replaces (Task 49404202). A set that
    //    expects no focus, or another focus, is rejected and changes nothing; the
    //    rejection names the current focus. A set without the key is malformed.
    const blind = await pin('set', labelledId, 1, null);
    assert.equal(blind.status, 'rejected', JSON.stringify(blind));
    assert.match(JSON.stringify(blind), /owner_pin_focus_conflict/);
    assert.equal(blind.supplemental.current_focus_id, readyId);
    const wrong = await pin('set', labelledId, 1, labelledId);
    assert.equal(wrong.status, 'rejected', JSON.stringify(wrong));
    assert.match(JSON.stringify(wrong), /owner_pin_focus_conflict/);
    const unnamed = await rpc(hostToken, 'clued_mcp_mtpe_owner_pin', {
      operation: 'set', record_id: labelledId, base_version: 1,
      idempotency_key: uuid(), user_confirmed: true, reason: 'Owner focus fixture',
    });
    assert.equal(unnamed.status, 'rejected', JSON.stringify(unnamed));
    assert.match(JSON.stringify(unnamed), /invalid_mtpe_owner_pin_request/);
    assert.deepEqual(await focusRows(), [{ record_id: readyId }]);
    assert.equal((await snapshot()).owner_selected_current_focus.record_id, readyId);
    // Re-pinning the current focus names itself; switching names the old focus.
    assert.equal((await pin('set', readyId, 1, readyId)).status, 'committed');
    const switched = await pin('set', labelledId, 1, readyId);
    assert.equal(switched.status, 'committed', JSON.stringify(switched));
    assert.equal(switched.supplemental.owner_focus.record_id, labelledId);
    assert.deepEqual(await focusRows(), [{ record_id: labelledId }]);
    // cancel already names the focus it removes and needs no expected focus.
    assert.equal((await pin('cancel', labelledId, 1)).status, 'committed');
    assert.deepEqual(await focusRows(), []);
    // The real formal migration is installed by the full chain and replays
    // unchanged after the original business/concurrency/negative matrix.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
