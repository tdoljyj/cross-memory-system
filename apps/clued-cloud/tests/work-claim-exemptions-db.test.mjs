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

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

// Work Claim per-Task cap exemption (migration 20261002190000, Owner Decision
// d16b5bfc): only a fresh Native account session can grant one, in two steps;
// it admits 5 more claims or takeovers of one Task for 24 hours.
// Owner Credential step 3 (20261003030000) retired issuing new exemptions,
// so this test applies the migrations before it: it covers the flow that
// granted the exemptions still honoured until they expire. The state after
// step 3 is covered by work-claims-owner-grants-db.test.mjs.
const STEP3 = '20261003030000_work_claims_owner_grants.sql';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

test('work claim exemption: Native two-step grant lifts the per-Task cap by 5 for 24 hours',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claim-exemption-'));
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
      .filter((name) => name.endsWith('.sql') && name < STEP3).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'exemption@example.invalid',now()),($2,'exemption-other@example.invalid',now())`, [userId, otherUser]);
    const agentToken = hash();
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Agent',$2,array['context:read','context:write'],array['*'])`, [userId, agentToken]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const call = async (name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [agentToken, input])).rows[0].v;
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const issue = (input, claims) => native('clued_work_claim_exemption_confirmation_issue_v1', input, claims);
    const grant = (input, claims) => native('clued_work_claim_exemption_grant_v1', input, claims);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await call('clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'work claim exemption fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId) => call('clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: ['exempt/x'] });
    const release = (c) => call('clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'abandoned' });
    const count = async (table, where, params) =>
      (await admin.query(`select count(*)::int n from ${table} where ${where}`, params)).rows[0].n;

    // A Task at the cap: ten claims, then refused.
    const task = await createTask('exemption target');
    for (let i = 0; i < 10; i += 1) committed(await release(committed(await claim(task)).claim));
    const refused = await claim(task);
    assert.equal(refused.error_code, 'work_claim_budget_exhausted', JSON.stringify(refused));
    assert.equal(refused.owner_exemption_path, `/work-claims/exemption?task=${task}&scope=global`);

    // --- No Agent path: a Binding cannot reach either RPC. ---
    await assert.rejects(() => anon.query('select public.clued_work_claim_exemption_confirmation_issue_v1($1)',
      [{ task_id: task, reason: 'x' }]), /permission denied/);
    await assert.rejects(() => anon.query('select public.clued_work_claim_exemption_grant_v1($1)',
      [{ confirmation_token: 'x', view_digest: 'x' }]), /permission denied/);
    // A delegated OAuth token (client_id claim) is not a direct human session.
    await assert.rejects(() => issue({ task_id: task, reason: 'x' }, { ...fresh(userId), client_id: 'oauth-client' }),
      /direct_human_session_required/);
    await assert.rejects(() => issue({ task_id: task, reason: 'x' }, { role: 'authenticated' }),
      /direct_human_session_required/);

    // --- Step 1 guards. ---
    const staleLogin = { ...fresh(userId), amr: [{ method: 'password', timestamp: nowEpoch() - 16 * 60 }] };
    assert.equal((await issue({ task_id: task, reason: 'x' }, staleLogin)).error_code, 'reauthentication_required');
    const { session_id: _omit, ...noSession } = fresh(userId);
    assert.equal((await issue({ task_id: task, reason: 'x' }, noSession)).error_code,
      'confirmation_token_session_id_required');
    assert.equal((await issue({ task_id: task })).error_code, 'work_claim_exemption_reason_required');
    assert.equal((await issue({ task_id: task, reason: '   ' })).error_code, 'work_claim_exemption_reason_required');
    assert.equal((await issue({ task_id: task, reason: 'x', extra_claims: 50 })).error_code,
      'work_claim_exemption_unknown_field');
    assert.equal((await issue({ task_id: uuid(), reason: 'x' })).error_code, 'work_claim_task_unavailable');
    // Another account cannot see the Task.
    assert.equal((await issue({ task_id: task, reason: 'x' }, fresh(otherUser))).error_code,
      'work_claim_task_unavailable');

    // --- Step 1: the view is fixed at +5 for 24 hours. ---
    const issued = await issue({ task_id: task, reason: 'finish the VM install today' });
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    assert.match(issued.confirmation_token, /^clued_wce_[0-9a-f]{64}$/);
    assert.deepEqual([issued.confirmation_view.task_id, issued.confirmation_view.task_title,
      issued.confirmation_view.extra_claims, issued.confirmation_view.valid_hours, issued.confirmation_view.reason],
      [task, 'exemption target', 5, 24, 'finish the VM install today']);
    assert.deepEqual([issued.task_status.claims_last_24h, issued.task_status.max_claims_per_task_24h,
      issued.task_status.active_exemptions], [10, 10, []]);
    // Only the hash is stored; claims are still refused before step 2.
    assert.equal(await count('clued_private.native_confirmation_tokens', 'token_hash=$1',
      [crypto.createHash('sha256').update(issued.confirmation_token).digest('hex')]), 1);
    assert.equal((await claim(task)).error_code, 'work_claim_budget_exhausted');

    // --- Step 2 guards; each failed attempt burns the token. ---
    const digest = issued.view_digest;
    assert.equal((await grant({ confirmation_token: 'clued_wce_' + 'f'.repeat(64), view_digest: digest })).error_code,
      'confirmation_token_invalid');
    assert.equal((await grant({ confirmation_token: issued.confirmation_token, view_digest: digest },
      fresh(otherUser))).error_code, 'confirmation_token_invalid');
    // Another session of the same account.
    assert.equal((await grant({ confirmation_token: issued.confirmation_token, view_digest: digest },
      fresh(userId, 'sess-other'))).error_code, 'confirmation_token_binding_mismatch');
    assert.equal((await grant({ confirmation_token: issued.confirmation_token, view_digest: digest })).error_code,
      'confirmation_token_reused');
    assert.equal(await count('clued_private.work_claim_exemptions_v1', 'task_id=$1', [task]), 0);

    // A wrong digest burns too.
    const second = await issue({ task_id: task, reason: 'finish the VM install today' });
    assert.equal((await grant({ confirmation_token: second.confirmation_token, view_digest: '0'.repeat(64) })).error_code,
      'confirmation_token_binding_mismatch');
    // A newer preview revokes the older live one.
    const third = await issue({ task_id: task, reason: 'finish the VM install today' });
    const fourth = await issue({ task_id: task, reason: 'finish the VM install today' });
    assert.equal((await grant({ confirmation_token: third.confirmation_token, view_digest: third.view_digest })).error_code,
      'confirmation_token_revoked');
    // A stale login at step 2.
    assert.equal((await grant({ confirmation_token: fourth.confirmation_token, view_digest: fourth.view_digest },
      staleLogin)).error_code, 'reauthentication_required');

    // A Task edited between the steps makes the view stale.
    const fifth = await issue({ task_id: task, reason: 'finish the VM install today' });
    committed(await call('clued_record_mutate', { operation: 'update', id: task, base_version: 1, record_type: 'task',
      record_schema_version: 1, lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'rename fixture', mutation: { title: 'renamed target' } }));
    assert.equal((await grant({ confirmation_token: fifth.confirmation_token, view_digest: fifth.view_digest })).error_code,
      'confirmation_view_stale');

    // --- The grant. ---
    const ok = await issue({ task_id: task, reason: 'finish the VM install today' });
    const granted = committed(await grant({ confirmation_token: ok.confirmation_token, view_digest: ok.view_digest }));
    assert.equal(granted.replayed, false);
    assert.equal(granted.exemption.extra_claims, 5);
    const lifetime = Date.parse(granted.exemption.expires_at) - Date.parse(granted.exemption.granted_at);
    assert.equal(lifetime, 24 * 3600 * 1000);
    const receipt = (await admin.query('select * from public.clued_audit_receipts where id=$1', [granted.receipt_id])).rows[0];
    assert.deepEqual([receipt.binding_id, receipt.operation, receipt.metadata.receipt_kind, receipt.metadata.principal],
      [null, 'work_claim_exemption_grant', 'WORK_CLAIM_EXEMPTION_GRANTED', 'native_account_session']);
    // Retrying the same step 2 (an uncertain network result) returns the same exemption.
    const again = committed(await grant({ confirmation_token: ok.confirmation_token, view_digest: ok.view_digest }));
    assert.deepEqual([again.replayed, again.exemption.exemption_id], [true, granted.exemption.exemption_id]);
    assert.equal(await count('clued_private.work_claim_exemptions_v1', 'task_id=$1', [task]), 1);

    // --- Five more claims or takeovers, then refused again. ---
    let current = committed(await claim(task)).claim;
    const issuedReceipt = (await admin.query(
      "select metadata from public.clued_audit_receipts where operation='work_claim' and object_id=$1",
      [current.claim_id])).rows[0].metadata;
    assert.equal(issuedReceipt.exemption_id, granted.exemption.exemption_id);
    committed(await release(current));
    for (let i = 0; i < 3; i += 1) committed(await release(committed(await claim(task)).claim));
    current = committed(await claim(task)).claim;
    // That was the fifth; a sixth attempt, here a takeover of an expired claim, is refused.
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [current.claim_id]);
    const over = await call('clued_work_takeover_v1', { scope: 'global', claim_id: current.claim_id, idempotency_key: uuid() });
    assert.equal(over.error_code, 'work_claim_budget_exhausted', JSON.stringify(over));
    assert.equal(over.claims_last_24h, 15);

    // An expired exemption admits nothing; another Task is not exempted.
    const other = await createTask('not exempted');
    for (let i = 0; i < 10; i += 1) committed(await release(committed(await claim(other)).claim));
    assert.equal((await claim(other)).error_code, 'work_claim_budget_exhausted');
    const late = await issue({ task_id: other, reason: 'expiry check' });
    const lateGrant = committed(await grant({ confirmation_token: late.confirmation_token, view_digest: late.view_digest }));
    await assert.rejects(() => admin.query('update clued_private.work_claim_exemptions_v1 set expires_at=now() where id=$1',
      [lateGrant.exemption.exemption_id]), /work_claim_exemption_immutable/);
    await admin.query('alter table clued_private.work_claim_exemptions_v1 disable trigger work_claim_exemptions_v1_immutable');
    await admin.query(`update clued_private.work_claim_exemptions_v1
      set granted_at=granted_at-interval '25 hours',expires_at=expires_at-interval '25 hours' where id=$1`,
      [lateGrant.exemption.exemption_id]);
    await admin.query('alter table clued_private.work_claim_exemptions_v1 enable trigger work_claim_exemptions_v1_immutable');
    assert.equal((await claim(other)).error_code, 'work_claim_budget_exhausted');

    // The table is closed to client roles.
    await assert.rejects(() => human.query('select * from clued_private.work_claim_exemptions_v1'), /permission denied/);
    await assert.rejects(() => anon.query('select * from clued_private.work_claim_exemptions_v1'), /permission denied/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
