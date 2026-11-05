import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
// The lease key case (migration 20261005190000) runs with this file, under
// npm run test:work:claims.
import './work-claims-lease-key-db.case.mjs';
// The Owner handover and claims list case (migration 20261005200000) as well.
import './work-claims-owner-handover-db.case.mjs';
// The merge slot case (migration 20261006120000) as well.
import './work-claims-merge-slot-db.case.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Work Claim rejection Receipts for renew, takeover pre-checks and replays
// (migration 20261003070000, Task 91272c5d): every such refusal leaves a
// WORK_CLAIM_REJECTED Receipt, at most one per Binding, context, Task, error
// and limit a minute, keyed by the claim id when no Task is known. Responses
// are unchanged.

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

test('work claims: renew, takeover and replay refusals leave rate-limited rejection Receipts',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-reject-'));
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
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims-reject@example.invalid',now())`, [userId]);
    const tokens = {};
    const bindingIds = {};
    for (const name of ['claude', 'codex']) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`,
        [userId, name, tokens[name]])).rows[0].id;
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const agent = async (who, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who],input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const rejected = (result, code) => {
      assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result));
      return result;
    };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'rejection receipt fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, who = 'claude', extra = {}) => agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: [`reject/${taskId}`], ...extra });
    const renew = (who, c, extra = {}) => agent(who, 'clued_work_renew_v1', { scope: 'global',
      claim_id: c.claim_id, fence: c.fence, lease_version: c.lease_version, progress_ref: uuid(), ...extra });
    const takeover = (who, claimId, extra = {}) => agent(who, 'clued_work_takeover_v1',
      { scope: 'global', claim_id: claimId, idempotency_key: uuid(), ...extra });
    const release = (who, c) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed' });
    const expire = (c) => admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [c.claim_id]);
    const rejections = async (objectId) => (await admin.query(`select binding_id,context_key,object_type,metadata
      from public.clued_audit_receipts where user_id=$1 and operation='work_claim_reject' and object_id=$2
      order by created_at,id`, [userId, objectId])).rows;
    const codes = async (objectId) => (await rejections(objectId)).map((r) => r.metadata.error_code);
    const ageRejections = (objectId) => admin.query(`update public.clued_audit_receipts
      set created_at=created_at-interval '2 minutes'
      where user_id=$1 and operation='work_claim_reject' and object_id=$2`, [userId, objectId]);

    // --- Renew refusals, one Receipt each, keyed by the Task. ---
    const task = await createTask('renew refusals');
    let held = committed(await claim(task)).claim;
    const firstProgress = uuid();
    held = committed(await renew('claude', held, { progress_ref: firstProgress })).claim;

    rejected(await renew('claude', held, { progress_ref: firstProgress }), 'work_claim_no_progress');
    rejected(await renew('claude', held, { fence: held.fence + 1 }), 'work_claim_fence_mismatch');
    rejected(await renew('claude', held, { lease_version: held.lease_version + 5 }), 'work_claim_version_conflict');
    rejected(await renew('codex', held), 'work_claim_not_holder');
    let log = await rejections(task);
    assert.deepEqual(log.map((r) => r.metadata.error_code), ['work_claim_no_progress', 'work_claim_fence_mismatch',
      'work_claim_version_conflict', 'work_claim_not_holder']);
    assert.deepEqual([log[0].metadata.receipt_kind, log[0].metadata.attempted_operation, log[0].metadata.task_id,
      log[0].metadata.claim_id, log[0].object_type, log[0].context_key, log[0].binding_id],
    ['WORK_CLAIM_REJECTED', 'work_claim_renew', task, held.claim_id, 'work_claim_rejection', 'global',
      bindingIds.claude]);
    // The refusal by another Binding is logged under that Binding.
    assert.equal(log[3].binding_id, bindingIds.codex);

    // A loop of the same refusal within the minute: still one Receipt; after
    // the minute, one more.
    for (let i = 0; i < 5; i += 1) {
      rejected(await renew('claude', held, { progress_ref: firstProgress }), 'work_claim_no_progress');
    }
    assert.equal((await codes(task)).filter((c) => c === 'work_claim_no_progress').length, 1);
    await ageRejections(task);
    rejected(await renew('claude', held, { progress_ref: firstProgress }), 'work_claim_no_progress');
    assert.equal((await codes(task)).filter((c) => c === 'work_claim_no_progress').length, 2);

    // A widened write_set that hits another live claim: conflict, logged with
    // the conflicting claim.
    const otherTask = await createTask('other holder');
    const other = committed(await claim(otherTask, 'codex', { write_set: ['shared/x'] })).claim;
    const conflict = rejected(await renew('claude', held, { write_set: ['shared/**'] }), 'work_claim_conflict');
    assert.equal(conflict.conflicts[0].claim_id, other.claim_id);
    log = await rejections(task);
    const conflictLog = log.find((r) => r.metadata.error_code === 'work_claim_conflict');
    assert.deepEqual(conflictLog.metadata.conflicting_claim_ids, [other.claim_id]);
    committed(await release('codex', other));

    // Renewal budget and hard deadline.
    await admin.query(`update clued_private.work_claims_v1 set renewals=
      (clued_private.work_claim_profile_v1()->>'max_renewals')::integer where claim_id=$1`, [held.claim_id]);
    rejected(await renew('claude', held), 'work_claim_renewal_budget_exhausted');
    await admin.query(`update clued_private.work_claims_v1 set renewals=0,hard_deadline_at=expires_at
      where claim_id=$1`, [held.claim_id]);
    rejected(await renew('claude', held), 'work_claim_hard_deadline');

    // Expired, then released (not active).
    await expire(held);
    rejected(await renew('claude', held), 'work_claim_expired');
    const second = committed(await claim(await createTask('released renew'))).claim;
    committed(await release('claude', second));
    rejected(await renew('claude', second), 'work_claim_not_active');
    assert.deepEqual(await codes(second.task_id), ['work_claim_not_active']);
    assert.ok((await codes(task)).includes('work_claim_renewal_budget_exhausted'));
    assert.ok((await codes(task)).includes('work_claim_hard_deadline'));
    assert.ok((await codes(task)).includes('work_claim_expired'));

    // A claim id that does not exist: keyed by that id, with no Task.
    const missing = uuid();
    rejected(await renew('claude', { claim_id: missing, fence: 1, lease_version: 1 }), 'work_claim_not_found');
    log = await rejections(missing);
    assert.deepEqual([log.length, log[0].metadata.task_id, log[0].metadata.claim_id,
      log[0].metadata.attempted_operation], [1, null, missing, 'work_claim_renew']);

    // --- Takeover pre-check refusals. ---
    const takeTask = await createTask('takeover refusals');
    const live = committed(await claim(takeTask)).claim;
    rejected(await takeover('codex', live.claim_id), 'work_claim_still_active');
    committed(await release('claude', live));
    rejected(await takeover('codex', live.claim_id), 'work_claim_not_takeover_eligible');
    const missingTakeover = uuid();
    rejected(await takeover('codex', missingTakeover), 'work_claim_not_found');
    log = await rejections(takeTask);
    assert.deepEqual(log.map((r) => [r.metadata.error_code, r.metadata.attempted_operation, r.binding_id]), [
      ['work_claim_still_active', 'work_claim_takeover', bindingIds.codex],
      ['work_claim_not_takeover_eligible', 'work_claim_takeover', bindingIds.codex]]);
    assert.deepEqual(await codes(missingTakeover), ['work_claim_not_found']);
    // A refused takeover takes no token from the Task bucket.
    const bucket = await admin.query(`select tokens from clued_private.work_claim_rate_buckets_v1
      where user_id=$1 and bucket_kind='task' and key_id=$2`, [userId, takeTask]);
    assert.equal(Number(bucket.rows[0].tokens), 7, 'only the one claim took a token');

    // --- Replay refusals for claim and takeover. ---
    const replayTask = await createTask('replay refusals');
    const key = uuid();
    const original = committed(await claim(replayTask, 'claude', { idempotency_key: key })).claim;
    // Same key, different body: idempotency_conflict.
    rejected(await claim(replayTask, 'claude', { idempotency_key: key, write_set: ['reject/elsewhere'] }),
      'work_claim_idempotency_conflict');
    // Same key and body after release: idempotency_spent.
    committed(await release('claude', original));
    rejected(await claim(replayTask, 'claude', { idempotency_key: key }), 'work_claim_idempotency_spent');
    log = await rejections(replayTask);
    assert.deepEqual(log.map((r) => [r.metadata.error_code, r.metadata.attempted_operation, r.metadata.claim_id]), [
      ['work_claim_idempotency_conflict', 'work_claim', original.claim_id],
      ['work_claim_idempotency_spent', 'work_claim', original.claim_id]]);
    // A takeover replay that is spent is logged as a takeover.
    const takeReplayTask = await createTask('takeover replay');
    const expiring = committed(await claim(takeReplayTask)).claim;
    await expire(expiring);
    const takeKey = uuid();
    const tookOver = committed(await takeover('codex', expiring.claim_id, { idempotency_key: takeKey })).claim;
    committed(await release('codex', tookOver));
    rejected(await takeover('codex', expiring.claim_id, { idempotency_key: takeKey }), 'work_claim_idempotency_spent');
    log = await rejections(takeReplayTask);
    assert.deepEqual(log.map((r) => [r.metadata.error_code, r.metadata.attempted_operation, r.metadata.claim_id]), [
      ['work_claim_idempotency_spent', 'work_claim_takeover', tookOver.claim_id]]);
    // A successful replay is not a refusal.
    const okKey = uuid();
    const okTask = await createTask('replay ok');
    committed(await claim(okTask, 'claude', { idempotency_key: okKey }));
    assert.equal(committed(await claim(okTask, 'claude', { idempotency_key: okKey })).replayed, true);
    assert.deepEqual(await rejections(okTask), []);

    // --- Refusals from work_claim_issue still use the same logger and shape. ---
    const busyTask = await createTask('issue conflict');
    const busy = committed(await claim(busyTask, 'claude', { write_set: ['busy/x'] })).claim;
    const clashTask = await createTask('issue clash');
    rejected(await claim(clashTask, 'codex', { write_set: ['busy/**'] }), 'work_claim_conflict');
    log = await rejections(clashTask);
    assert.deepEqual([log.length, log[0].metadata.attempted_operation, log[0].metadata.task_id,
      log[0].metadata.conflicting_claim_ids, 'claim_id' in log[0].metadata],
    [1, 'work_claim', clashTask, [busy.claim_id], false]);

    // --- Nobody but the definer can call the loggers. ---
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of ['work_claim_reject_log_v1', 'work_claim_reject_logged_v1', 'work_claim_replay_logged_v1']) {
        const allowed = (await admin.query(`select bool_or(has_function_privilege($1,p.oid,'execute')) v
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='clued_private' and p.proname=$2`, [role, fn])).rows[0].v;
        assert.equal(allowed, false, `${role} can execute ${fn}`);
      }
    }
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
  }
});
