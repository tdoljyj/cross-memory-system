import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Owner Credential v0.1, step 3 (migration 20261003030000): over the per-Task
// claim cap, a claim or takeover consumes an Owner Grant for
// work_claim.extra_claims on that Task, and a refusal carries an Owner Request
// the Owner approves on /confirm/<id>. A legacy exemption granted before the
// migration keeps working; issuing new exemptions is retired.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP3 = '20261003030000_work_claims_owner_grants.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims over the per-Task cap consume Owner Grants; refusals carry an Owner Request',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-owner-grants-'));
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(STEP3));
    const apply = async (names) => {
      for (const name of names) {
        try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      }
      await allowRawTestBindings(admin);
      await enableManualOwnerApprovalFixture(admin);
    };
    // Everything before step 3 first, so a legacy exemption can be granted
    // the old way; then step 3 and anything after it.
    await apply(migrations.filter((name) => name < STEP3));

    const userId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims-grants@example.invalid',now())`, [userId]);
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
    let workerCaller; // STEP3 historical setup precedes the C1 gateway role.
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) =>
      !workerCaller || CI_SIGNATURES.includes(name + '(text,jsonb)')
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
      confidence_reason: 'owner grant claims fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, who = 'claude') => agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: [`grants/${who}/${taskId}`] });
    const release = (who, c) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'abandoned' });
    const fill = async (taskId, who = 'claude', n = 10) => {
      for (let i = 0; i < n; i += 1) committed(await release(who, committed(await claim(taskId, who)).claim));
    };
    const approve = async (input) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', input);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return committed(await native('clued_owner_grant_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
    };
    const count = async (table, where, params) =>
      (await admin.query(`select count(*)::int n from ${table} where ${where}`, params)).rows[0].n;

    // --- Before step 3: a legacy exemption, and a step-1 token not yet confirmed. ---
    const legacyTask = await createTask('legacy exemption');
    const pendingTask = await createTask('pending exemption token');
    await fill(legacyTask);
    await fill(pendingTask);
    const legacyIssued = await native('clued_work_claim_exemption_confirmation_issue_v1', { task_id: legacyTask, reason: 'legacy' });
    committed(await native('clued_work_claim_exemption_grant_v1',
      { confirmation_token: legacyIssued.confirmation_token, view_digest: legacyIssued.view_digest }));
    const inFlight = await native('clued_work_claim_exemption_confirmation_issue_v1', { task_id: pendingTask, reason: 'in flight' });
    assert.equal(inFlight.status, 'issued', JSON.stringify(inFlight));

    await apply(migrations.filter((name) => name >= STEP3));
    workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    // From 20261003050000 the cap is the Task's rate bucket: an empty bucket
    // stands for a Task at its cap.
    const drain = (taskId) => admin.query(`insert into clued_private.work_claim_rate_buckets_v1
        (user_id,bucket_kind,key_id,tokens,updated_at) values($1,'task',$2,0,clock_timestamp())
      on conflict (user_id,bucket_kind,key_id) do update set tokens=0,updated_at=clock_timestamp()`, [userId, taskId]);
    await drain(legacyTask);
    await drain(pendingTask);

    // The legacy exemption still admits its five extra claims, without any request.
    for (let i = 0; i < 5; i += 1) committed(await release('claude', committed(await claim(legacyTask)).claim));
    // A step-1 token issued before the migration can still be confirmed.
    committed(await native('clued_work_claim_exemption_grant_v1',
      { confirmation_token: inFlight.confirmation_token, view_digest: inFlight.view_digest }));
    committed(await release('claude', committed(await claim(pendingTask)).claim));
    // Issuing a new exemption is retired; the refusal points to the grants page.
    const retired = await native('clued_work_claim_exemption_confirmation_issue_v1', { task_id: legacyTask, reason: 'new' });
    assert.deepEqual([retired.status, retired.error_code, retired.grants_path],
      ['rejected', 'work_claim_exemption_retired', '/grants']);
    await assert.rejects(() => native('clued_work_claim_exemption_confirmation_issue_v1', { task_id: legacyTask, reason: 'x' },
      { ...fresh(userId), client_id: 'oauth-client' }), /direct_human_session_required/);

    // --- A Task at the cap: the refusal carries an Owner Request. ---
    const task = await createTask('grant target');
    await drain(task);
    const refused = await claim(task);
    assert.equal(refused.error_code, 'work_claim_budget_exhausted', JSON.stringify(refused));
    assert.equal(refused.owner_exemption_path, undefined);
    const request = refused.owner_request;
    assert.deepEqual([request.action, request.resources, request.task_id, request.status, request.confirm_path],
      ['work_claim.extra_claims', [`record:${task}`], task, 'pending', `/confirm/${request.request_id}`]);
    const requestRow = (await admin.query('select * from clued_private.owner_requests_v1 where id=$1', [request.request_id])).rows[0];
    assert.deepEqual([requestRow.binding_id, requestRow.suggested_expires_seconds, requestRow.suggested_max_uses, requestRow.agent_note],
      [bindingIds.claude, 86400, 5, null]);
    const requestReceipt = (await admin.query('select * from public.clued_audit_receipts where id=$1', [requestRow.receipt_id])).rows[0];
    assert.deepEqual([requestReceipt.operation, requestReceipt.metadata.receipt_kind, requestReceipt.metadata.origin],
      ['owner_request_create', 'OWNER_REQUEST_CREATED', 'work_claim_budget_exhausted']);
    // Retrying reuses the pending request; another Binding gets its own.
    assert.equal((await claim(task)).owner_request.request_id, request.request_id);
    assert.equal(await count('clued_private.owner_requests_v1', 'task_id=$1 and binding_id=$2', [task, bindingIds.claude]), 1);
    const codexRefused = await claim(task, 'codex');
    assert.equal(codexRefused.error_code, 'work_claim_budget_exhausted');
    assert.notEqual(codexRefused.owner_request.request_id, request.request_id);
    // An Agent cannot approve its own request.
    await assert.rejects(() => anon.query('select public.clued_owner_grant_v1($1)',
      [{ confirmation_token: 'x', view_digest: 'x' }]), /permission denied/);
    await assert.rejects(() => anon.query('select public.clued_owner_grant_confirmation_issue_v1($1)',
      [{ request_id: request.request_id }]), /permission denied/);

    // --- "Only this once": exactly one more claim, then a fresh request. ---
    const once = await approve({ request_id: request.request_id, choice: 'once' });
    assert.equal(once.grant.max_uses, 1);
    const admitted = committed(await claim(task)).claim;
    const admittedReceipt = (await admin.query(
      "select metadata from public.clued_audit_receipts where operation='work_claim' and object_id=$1",
      [admitted.claim_id])).rows[0].metadata;
    assert.deepEqual([admittedReceipt.owner_grant_id, admittedReceipt.owner_grant_use, admittedReceipt.exemption_id],
      [once.grant.grant_id, 1, undefined]);
    assert.equal(await count('public.clued_audit_receipts', "operation='owner_grant_use' and object_id=$1",
      [once.grant.grant_id]), 1);
    committed(await release('claude', admitted));
    const again = await claim(task);
    assert.equal(again.error_code, 'work_claim_budget_exhausted');
    assert.notEqual(again.owner_request.request_id, request.request_id, 'the decided request is not reused');

    // --- The Owner's grant covers this Binding and Task only. ---
    const grant = await approve({ request_id: again.owner_request.request_id, choice: 'grant' });
    assert.equal(grant.grant.max_uses, 5);
    // codex is not the grantee.
    assert.equal((await claim(task, 'codex')).error_code, 'work_claim_budget_exhausted');
    // Another Task at its cap is not covered.
    const other = await createTask('not granted');
    await drain(other);
    assert.equal((await claim(other)).error_code, 'work_claim_budget_exhausted');
    // Four claims and one takeover use the five; the next takeover is refused.
    for (let i = 0; i < 4; i += 1) committed(await release('claude', committed(await claim(task)).claim));
    const lastClaim = committed(await claim(task)).claim;
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [lastClaim.claim_id]);
    const over = await agent('claude', 'clued_work_takeover_v1', { scope: 'global', claim_id: lastClaim.claim_id, idempotency_key: uuid() });
    assert.equal(over.error_code, 'work_claim_budget_exhausted', JSON.stringify(over));
    assert.equal((await admin.query('select uses from clued_private.owner_grants_v1 where id=$1', [grant.grant.grant_id])).rows[0].uses, 5);

    // --- A takeover consumes a grant too; a revoked grant admits nothing. ---
    const takeoverGrant = await approve({ request_id: over.owner_request.request_id, choice: 'grant' });
    const takenOver = committed(await agent('claude', 'clued_work_takeover_v1',
      { scope: 'global', claim_id: lastClaim.claim_id, idempotency_key: uuid() }));
    const takeoverReceipt = (await admin.query(
      "select metadata from public.clued_audit_receipts where operation='work_claim_takeover' and object_id=$1",
      [takenOver.claim.claim_id])).rows[0].metadata;
    assert.equal(takeoverReceipt.owner_grant_id, takeoverGrant.grant.grant_id);
    committed(await release('claude', takenOver.claim));
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: takeoverGrant.grant.grant_id }));
    assert.equal((await claim(task)).error_code, 'work_claim_budget_exhausted');

    // A conflict refusal does not use a grant: conflicts are checked first.
    const conflictTask = await createTask('conflict check');
    await drain(conflictTask);
    const conflictGrant = await approve({ request_id: (await claim(conflictTask)).owner_request.request_id, choice: 'grant' });
    const holder = committed(await claim(conflictTask)).claim;
    const clash = await agent('claude', 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: conflictTask, write_set: ['elsewhere/x'] });
    assert.equal(clash.error_code, 'work_claim_conflict', JSON.stringify(clash));
    assert.equal((await admin.query('select uses from clued_private.owner_grants_v1 where id=$1',
      [conflictGrant.grant.grant_id])).rows[0].uses, 1);
    committed(await release('claude', holder));
    // Qualify the complete current chain's explicit Worker82/CI8 successor.
    // Historical Worker80 replay remains in its separate phase tests.
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
