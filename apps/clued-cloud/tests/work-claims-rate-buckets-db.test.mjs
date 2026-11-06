import { stopCluster } from './cluster-cleanup.mjs';
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
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Work Claim rate buckets (migration 20261003050000, GenericWorkClaim §10.3):
// a new claim or takeover takes a token from the Task bucket (8, one back per
// hour) and the Binding bucket (30, one back per 15 minutes); renewals and
// replays take none. A short bucket refuses with work_claim_budget_exhausted
// unless an exemption or Owner Grant admits the start, and refusals leave a
// rate-limited WORK_CLAIM_REJECTED Receipt.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });

// Start times (epoch seconds) of the 27 production claims of M2 Task 1502fd80,
// 2026-10-01T16:55Z to 2026-10-02T19:58Z: the Task that hit the old cap.
const M2_STARTS = [1790873728, 1790876695, 1790878920, 1790880496, 1790880940, 1790881023, 1790882454,
  1790882694, 1790915950, 1790916684, 1790916975, 1790918208, 1790918297, 1790919856, 1790921985,
  1790923933, 1790943515, 1790944192, 1790946230, 1790947264, 1790947920, 1790948396, 1790961937,
  1790964000, 1790966439, 1790968853, 1790971098];

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims: per-Task and per-Binding rate buckets, exemptions and rejection Receipts',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-buckets-'));
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
    await enableManualOwnerApprovalFixture(admin);

    const userId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims-buckets@example.invalid',now())`, [userId]);
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
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who],input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'rate bucket fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, who = 'claude', extra = {}) => agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: [`buckets/${taskId}`], ...extra });
    const release = (who, c) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed' });
    const level = async (kind, key) => Number((await admin.query(`select clued_private.work_claim_bucket_level_v1(
        $1,$2,$3,b.capacity,b.refill,clock_timestamp()) v from (select
          (clued_private.work_claim_profile_v1()->>($2||'_claim_bucket_capacity'))::integer capacity,
          (clued_private.work_claim_profile_v1()->>($2||'_claim_bucket_refill_seconds'))::integer refill) b`,
      [userId, kind, key])).rows[0].v);
    const age = (kind, key, seconds) => admin.query(`update clued_private.work_claim_rate_buckets_v1
      set updated_at=updated_at-make_interval(secs=>$4) where user_id=$1 and bucket_kind=$2 and key_id=$3`,
      [userId, kind, key, seconds]);
    const resetBindingBucket = (who) => admin.query(`delete from clued_private.work_claim_rate_buckets_v1
      where user_id=$1 and bucket_kind='binding' and key_id=$2`, [userId, bindingIds[who]]);
    const rejections = (taskId) => admin.query(`select metadata from public.clued_audit_receipts
      where user_id=$1 and operation='work_claim_reject' and object_id=$2 order by created_at`, [userId, taskId]);

    // --- Profile: buckets replace the 24-hour count. ---
    const profile = (await admin.query('select clued_private.work_claim_profile_v1() p')).rows[0].p;
    assert.deepEqual([profile.task_claim_bucket_capacity, profile.task_claim_bucket_refill_seconds,
      profile.binding_claim_bucket_capacity, profile.binding_claim_bucket_refill_seconds,
      profile.max_claims_per_task_24h, profile.github_ci_heads_per_task_24h], [8, 3600, 30, 900, undefined, 40]);

    // --- Stepwise claim-and-release: eight starts, then the Task bucket is
    // empty. A replay of an issued claim still answers and takes nothing. ---
    const stepwise = await createTask('stepwise');
    assert.equal(await level('task', stepwise), 8, 'a bucket without a row is full');
    let lastKey;
    let last;
    for (let i = 0; i < 8; i += 1) {
      lastKey = uuid();
      last = committed(await claim(stepwise, 'claude', { idempotency_key: lastKey })).claim;
      if (i < 7) committed(await release('claude', last));
    }
    assert.ok(await level('task', stepwise) < 1);
    const replay = committed(await claim(stepwise, 'claude', { idempotency_key: lastKey }));
    assert.deepEqual([replay.replayed, replay.claim.claim_id], [true, last.claim_id]);
    // Renewing takes no token either.
    const before = await level('task', stepwise);
    committed(await agent('claude', 'clued_work_renew_v1', { scope: 'global', claim_id: last.claim_id,
      fence: last.fence, lease_version: last.lease_version, progress_ref: 'renew-1' }));
    assert.ok(Math.abs(await level('task', stepwise) - before) < 0.01);
    committed(await release('claude', last));
    const refused = await claim(stepwise);
    assert.equal(refused.error_code, 'work_claim_budget_exhausted', JSON.stringify(refused));
    assert.equal(refused.limit, 'task_claim_rate');
    assert.deepEqual([refused.task_bucket.capacity, refused.task_bucket.refill_seconds], [8, 3600]);
    assert.ok(refused.task_bucket.tokens < 1);
    // The next token is at most one refill interval away, not 24 hours.
    const wait = Date.parse(refused.retry_after) - Date.now();
    assert.ok(wait > 3500000 && wait <= 3600000, `retry_after in ${wait} ms`);
    assert.equal(refused.owner_request.action, 'work_claim.extra_claims');
    assert.equal(refused.owner_request.task_id, stepwise);
    // Another Task is not affected.
    committed(await release('claude', committed(await claim(await createTask('other task'))).claim));
    // One hour later one token is back: one start, then refused again.
    await age('task', stepwise, 3600);
    committed(await release('claude', committed(await claim(stepwise)).claim));
    assert.equal((await claim(stepwise)).limit, 'task_claim_rate');

    // --- Rejection Receipts: one per Binding, Task, error and limit a minute. ---
    // Two refusals within the minute: one Receipt.
    let logged = (await rejections(stepwise)).rows;
    assert.equal(logged.length, 1, JSON.stringify(logged));
    await admin.query(`update public.clued_audit_receipts set created_at=created_at-interval '2 minutes'
      where user_id=$1 and operation='work_claim_reject' and object_id=$2`, [userId, stepwise]);
    assert.equal((await claim(stepwise)).limit, 'task_claim_rate');
    assert.equal((await claim(stepwise)).limit, 'task_claim_rate');
    logged = (await rejections(stepwise)).rows;
    assert.equal(logged.length, 2);
    assert.deepEqual([logged[1].metadata.receipt_kind, logged[1].metadata.attempted_operation,
      logged[1].metadata.error_code, logged[1].metadata.limit, logged[1].metadata.task_id],
      ['WORK_CLAIM_REJECTED', 'work_claim', 'work_claim_budget_exhausted', 'task_claim_rate', stepwise]);
    // A conflict refusal is logged with the conflicting claim, and takes no token.
    const shared = await createTask('shared path holder');
    const holder = committed(await claim(shared, 'claude', { write_set: ['shared/x'] })).claim;
    const clashTask = await createTask('shared path clash');
    const clash = await claim(clashTask, 'codex', { write_set: ['shared/**'] });
    assert.equal(clash.error_code, 'work_claim_conflict', JSON.stringify(clash));
    const clashLog = (await rejections(clashTask)).rows;
    assert.deepEqual([clashLog.length, clashLog[0].metadata.error_code, clashLog[0].metadata.conflicting_claim_ids],
      [1, 'work_claim_conflict', [holder.claim_id]]);
    assert.equal(await level('task', clashTask), 8);
    committed(await release('claude', holder));

    // --- A takeover takes a token too. ---
    const takeoverTask = await createTask('takeover');
    const taken = committed(await claim(takeoverTask)).claim;
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [taken.claim_id]);
    const tookOver = committed(await agent('codex', 'clued_work_takeover_v1',
      { scope: 'global', claim_id: taken.claim_id, idempotency_key: uuid() })).claim;
    assert.ok(Math.abs(await level('task', takeoverTask) - 6) < 0.01);
    committed(await release('codex', tookOver));

    // --- The Binding bucket: thirty starts across Tasks, then this Binding is
    // refused; another Binding is not. ---
    await resetBindingBucket('claude');
    const spread = [];
    for (let i = 0; i < 31; i += 1) spread.push(await createTask(`spread ${i}`));
    for (let i = 0; i < 30; i += 1) committed(await release('claude', committed(await claim(spread[i])).claim));
    const binding = await claim(spread[30]);
    assert.deepEqual([binding.error_code, binding.limit], ['work_claim_budget_exhausted', 'binding_claim_rate'],
      JSON.stringify(binding));
    assert.deepEqual([binding.binding_bucket.capacity, binding.binding_bucket.refill_seconds], [30, 900]);
    const bindingWait = Date.parse(binding.retry_after) - Date.now();
    assert.ok(bindingWait > 850000 && bindingWait <= 900000, `retry_after in ${bindingWait} ms`);
    committed(await release('codex', committed(await claim(spread[30], 'codex')).claim));

    // --- An Owner Grant admits a start on a short bucket without taking a
    // token; without one the refusal carries the request. ---
    await resetBindingBucket('claude');
    const issued = await native('clued_owner_grant_confirmation_issue_v1',
      { request_id: refused.owner_request.request_id, choice: 'once' });
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    const grant = committed(await native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest }));
    const tokensBefore = await level('task', stepwise);
    const granted = committed(await claim(stepwise)).claim;
    assert.ok(Math.abs(await level('task', stepwise) - tokensBefore) < 0.01, 'a granted start takes no token');
    const grantedReceipt = (await admin.query(
      "select metadata from public.clued_audit_receipts where operation='work_claim' and object_id=$1",
      [granted.claim_id])).rows[0].metadata;
    assert.equal(grantedReceipt.owner_grant_id, grant.grant.grant_id);
    committed(await release('claude', granted));
    assert.equal((await claim(stepwise)).limit, 'task_claim_rate');

    // --- Replay of production history and a synthetic loop, through the
    // same level/take functions the issue path uses. ---
    const replayBucket = async (starts, capacity, refill) => {
      const key = uuid();
      let admitted = 0;
      let firstRefusal = null;
      let lowest = capacity;
      for (const at of starts) {
        const when = new Date(at * 1000).toISOString();
        const tokensNow = Number((await admin.query(
          'select clued_private.work_claim_bucket_level_v1($1,$2,$3,$4,$5,$6) v',
          [userId, 'task', key, capacity, refill, when])).rows[0].v);
        if (tokensNow >= 1) {
          await admin.query('select clued_private.work_claim_bucket_take_v1($1,$2,$3,$4,$5)',
            [userId, 'task', key, tokensNow, when]);
          admitted += 1;
          lowest = Math.min(lowest, tokensNow - 1);
        } else if (firstRefusal === null) firstRefusal = at;
      }
      return { admitted, firstRefusal, lowest };
    };
    const m2 = await replayBucket(M2_STARTS, 8, 3600);
    assert.deepEqual([m2.admitted, m2.firstRefusal], [M2_STARTS.length, null], 'M2 history is never refused');
    assert.ok(m2.lowest > 2, `M2 lowest level ${m2.lowest}`);
    const t0 = 1791000000;
    const loop = await replayBucket(Array.from({ length: 480 }, (_, i) => t0 + i * 180), 8, 3600);
    assert.equal((loop.firstRefusal - t0) / 60, 24, 'a loop every 3 minutes is stopped at minute 24');
    assert.equal(loop.admitted, 31);
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
  }
});
