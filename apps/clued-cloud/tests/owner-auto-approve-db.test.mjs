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

// Owner auto-approval switch (migration 20261008170000_owner_auto_approve_v1;
// OwnerCredential.v0.1.md §12, Owner Decision 5ce219c6, Task 8eb340c7). The
// Owner turns it on from the signed-in page (two steps); while it is on, a
// request for any registered action but connection.permission is approved in
// the call that opens it, and each door uses the new grant at once.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 3 * 86400 }], ...extra });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('owner auto-approval: the switch approves requests at once, never connection.permission, and stops when off',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-auto-approve-'));
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
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'auto-approve@example.invalid',now()),($2,'auto-approve-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['release', userId, ['context:read', 'context:write']],
      ['admission', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
    ]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
    }
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,'global','binding_role_set','binding_role','ci-admission',1,'{}'::jsonb) returning id`,
      [userId, bindingIds.admission])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',now(),$3)`, [userId, bindingIds.admission, roleReceipt]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v;
    const native = async (name, input, claims = session(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const turnOn = async (input = {}, claims) => {
      const issued = await native('clued_owner_auto_approve_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return committed(await native('clued_owner_auto_approve_on_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, claims));
    };
    const ask = (input) => agent('claude', 'clued_owner_request_v1', { idempotency_key: uuid(), ...input });
    const listed = () => native('clued_owner_grants_list_v1', {});
    const sha = (c) => `repo:tdoljyj/cross-memory-system/${c.repeat(40)}`;

    // --- Off by default: requests wait for the Owner as before. ---
    let list = await listed();
    assert.equal(list.auto_approve.on, false);
    const excluded = ['connection.permission', 'model.dataset_split.producer', 'model.dataset_split.recognize',
      'model.dataset_split.verify'];
    assert.deepEqual(list.auto_approve.excluded.map((x) => x.action), excluded);
    assert.deepEqual(list.auto_approve.covers,
      ['migration.production', 'release.production', 'repo.protected_change', 'work_claim.extra_claims']);
    const before = committed(await ask({ action: 'release.production', resources: [sha('a')] }));
    assert.equal(before.request.status, 'pending');

    // --- Turning it on: Native two steps only, at most 7 days. ---
    const offered = await native('clued_owner_auto_approve_confirmation_issue_v1', {});
    assert.equal(offered.confirmation_view.expires_seconds, 86400, 'default 24 hours');
    assert.deepEqual(offered.confirmation_view.covers.map((x) => [x.action, x.approval]), [
      ['migration.production', 'once'], ['release.production', 'once'],
      ['repo.protected_change', 'once'], ['work_claim.extra_claims', 'grant']]);
    assert.deepEqual(offered.confirmation_view.excluded.map((x) => x.action), excluded);
    await assert.rejects(() => admin.query(`update clued_private.owner_grant_actions set auto_approvable=true
      where action='connection.permission'`), /owner_grant_actions_auto_approvable_check/);
    assert.equal((await native('clued_owner_auto_approve_confirmation_issue_v1', { expires_seconds: 604801 })).error_code,
      'owner_auto_approve_duration_invalid');
    assert.equal((await native('clued_owner_auto_approve_confirmation_issue_v1', { reason: 'x' })).error_code,
      'owner_auto_approve_unknown_field');
    assert.equal((await native('clued_owner_auto_approve_on_v1',
      { confirmation_token: offered.confirmation_token, view_digest: '0'.repeat(64) })).error_code,
      'confirmation_token_binding_mismatch', 'a wrong digest burns the token');
    assert.equal((await native('clued_owner_auto_approve_on_v1',
      { confirmation_token: offered.confirmation_token, view_digest: offered.view_digest })).error_code,
      'confirmation_token_reused');
    const otherSession = await native('clued_owner_auto_approve_confirmation_issue_v1', {});
    assert.equal((await native('clued_owner_auto_approve_on_v1',
      { confirmation_token: otherSession.confirmation_token, view_digest: otherSession.view_digest },
      session(userId, 'sess-other'))).error_code, 'confirmation_token_binding_mismatch');
    await assert.rejects(() => anon.query('select public.clued_owner_auto_approve_confirmation_issue_v1($1)', [{}]),
      /permission denied/);
    await assert.rejects(() => anon.query('select public.clued_owner_auto_approve_on_v1($1)', [{}]), /permission denied/);
    await assert.rejects(() => anon.query('select clued_private.owner_auto_approve_request_v1(null)'), /permission denied/);
    assert.equal((await listed()).auto_approve.on, false);

    const on = await turnOn();
    assert.equal(on.auto_approve.on, true);
    const switchEnd = Date.parse(on.auto_approve.expires_at);
    assert.ok(Math.abs(switchEnd - Date.now() - 86400_000) < 60_000);
    assert.equal((await admin.query(`select metadata->>'receipt_kind' k from public.clued_audit_receipts where id=$1`,
      [on.receipt_id])).rows[0].k, 'OWNER_AUTO_APPROVE_ON');
    // Another user's switch is their own.
    assert.equal(committed(await agent('stranger', 'clued_owner_request_v1',
      { idempotency_key: uuid(), action: 'release.production', resources: [sha('a')] })).request.status, 'pending');

    // --- An Agent's request is approved in the same call: the result is the receipt. ---
    const high = committed(await ask({ action: 'release.production', resources: [sha('b')],
      suggested_grant: { expires_seconds: 604800, max_uses: 50 } }));
    assert.equal(high.request.status, 'approved_once');
    assert.equal(high.request.grant.auto_approved, true);
    assert.equal(high.request.grant.max_uses, 1, 'a high-risk action is approved once, whatever the Agent suggests');
    assert.equal(high.request.grant.any_agent, false);
    const given = (await admin.query(`select g.grantee_binding_id,g.resources,g.token_id,r.metadata
      from clued_private.owner_grants_v1 g join public.clued_audit_receipts r on r.id=g.receipt_id
      where g.id=$1`, [high.request.grant.grant_id])).rows[0];
    assert.equal(given.grantee_binding_id, bindingIds.claude);
    assert.deepEqual(given.resources, [sha('b')]);
    assert.equal(given.token_id, null);
    assert.equal(given.metadata.receipt_kind, 'OWNER_GRANT_GIVEN');
    assert.equal(given.metadata.principal, 'owner_auto_approve');
    assert.equal(given.metadata.switch_receipt_id, on.receipt_id);
    // Status reads and the earlier pending request.
    assert.equal((await agent('claude', 'clued_owner_request_status_v1', { request_id: high.request.request_id }))
      .request.status, 'approved_once');
    assert.equal((await agent('claude', 'clued_owner_request_status_v1', { request_id: before.request.request_id }))
      .request.status, 'pending', 'a request opened before the switch waits for the Owner');

    // A routine action gets the Agent's suggestion, never past the switch's end.
    const routine = committed(await ask({ action: 'work_claim.extra_claims', resources: ['record:' + uuid()],
      suggested_grant: { expires_seconds: 3600, max_uses: 5 } }));
    assert.equal(routine.request.status, 'granted');
    assert.equal(routine.request.grant.max_uses, 5);
    assert.ok(Math.abs(Date.parse(routine.request.grant.expires_at) - Date.now() - 3600_000) < 60_000);
    const long = committed(await ask({ action: 'work_claim.extra_claims', resources: ['record:' + uuid()],
      suggested_grant: { expires_seconds: 604800 } }));
    assert.ok(Date.parse(long.request.grant.expires_at) <= switchEnd, 'capped at the switch end');

    // connection.permission and the model actions are never automatic: a
    // pending request for one comes back unchanged.
    const permission = { request: (await admin.query(`with r as (insert into public.clued_audit_receipts
        (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,$2,'global','owner_request_create','owner_request','fixture',1,'{}'::jsonb) returning id)
      insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,expires_at,receipt_id)
      select $1,$2,'fixture-'||gen_random_uuid(),a,array['permission:profile/audit'],clock_timestamp()+interval '1 hour',r.id
      from r, unnest(array['connection.permission','model.dataset_split.verify']) a
      returning id request_id`, [userId, bindingIds.claude])).rows[0] };
    for (const status of (await admin.query(`select (clued_private.owner_auto_approve_request_v1(q)).status s
      from clued_private.owner_requests_v1 q where q.user_id=$1 and q.idempotency_key like 'fixture-%'`, [userId])).rows) {
      assert.equal(status.s, 'pending');
    }

    // A bundle: each member approved.
    const bundled = committed(await agent('claude', 'clued_owner_request_bundle_v1', { idempotency_key: 'auto-bundle-1',
      actions: [{ action: 'migration.production', resources: [sha('c') + '/apps/clued-cloud/supabase/migrations/x.sql'] },
        { action: 'release.production', resources: [sha('c')] }] }));
    assert.deepEqual(bundled.request.bundle.map((m) => m.status), ['approved_once', 'approved_once']);

    // --- The release door approves and uses the grant in one call. ---
    let result = await agent('release', 'clued_owner_grant_door_consume_v1', { action: 'release.production', resources: [sha('d')] });
    assert.deepEqual([result.status, result.consumed, result.auto_approved], ['ok', true, true]);
    assert.equal(result.grant.use, 1);
    result = await agent('release', 'clued_owner_grant_door_consume_v1', { action: 'release.production', resources: [sha('d')] });
    assert.equal(result.consumed, true, 'the next run gets a new approval while the switch is on');

    // --- The admission door, for repo.protected_change. ---
    result = await agent('admission', 'clued_owner_grant_admission_door_v1',
      { action: 'repo.protected_change', resources: [sha('e')], note: 'o/r#1' });
    assert.deepEqual([result.status, result.admitted, result.auto_approved], ['ok', true, true]);
    result = await agent('admission', 'clued_owner_grant_admission_door_v1',
      { action: 'repo.protected_change', resources: [sha('e')] });
    assert.deepEqual([result.admitted, result.grant.replayed], [true, true], 'a re-run of the same commit takes no new use');

    // --- A work claim over the per-Task cap goes ahead. ---
    const taskId = committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'auto-approve fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'auto-approve claims', content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    await admin.query(`insert into clued_private.work_claim_rate_buckets_v1
        (user_id,bucket_kind,key_id,tokens,updated_at) values($1,'task',$2,0,clock_timestamp())
      on conflict (user_id,bucket_kind,key_id) do update set tokens=0,updated_at=clock_timestamp()`, [userId, taskId]);
    const claimed = await agent('claude', 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: [`auto/${taskId}`] });
    assert.equal(claimed.status, 'committed', JSON.stringify(claimed));
    const claimRequest = (await admin.query(`select status,grant_id from clued_private.owner_requests_v1
      where action='work_claim.extra_claims' and task_id=$1`, [taskId])).rows;
    assert.deepEqual(claimRequest.map((r) => r.status), ['granted']);
    assert.equal((await admin.query('select uses from clued_private.owner_grants_v1 where id=$1',
      [claimRequest[0].grant_id])).rows[0].uses, 1);

    // --- /grants marks what the switch gave. ---
    list = await listed();
    assert.equal(list.auto_approve.on, true);
    assert.ok(list.grants.some((g) => g.grant_id === high.request.grant.grant_id && g.auto_approved === true));
    assert.ok(list.pending_requests.some((r) => r.request_id === permission.request.request_id));

    // --- Off: one step, new requests wait again, grants already given stay. ---
    const off = committed(await native('clued_owner_auto_approve_off_v1', {}));
    assert.equal(off.auto_approve.on, false);
    assert.equal(committed(await native('clued_owner_auto_approve_off_v1', {})).replayed, true);
    assert.equal(committed(await ask({ action: 'release.production', resources: [sha('f')] })).request.status, 'pending');
    result = await agent('release', 'clued_owner_grant_door_consume_v1', { action: 'release.production', resources: [sha('9')] });
    assert.deepEqual([result.consumed, result.owner_request.status], [false, 'pending']);
    assert.ok((await listed()).grants.some((g) => g.grant_id === high.request.grant.grant_id));

    // --- A switch period ends on its own; turning on again replaces the live one. ---
    const short = await turnOn({ expires_seconds: 600 });
    const again = await turnOn({ expires_seconds: 1200 });
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_auto_approve_v1
      where user_id=$1 and turned_off_at is null`, [userId])).rows[0].n, 1);
    assert.notEqual(short.auto_approve.switch_id, again.auto_approve.switch_id);
    await admin.query(`update clued_private.owner_auto_approve_v1
      set turned_on_at=turned_on_at-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' where id=$1`,
      [again.auto_approve.switch_id]);
    assert.equal((await listed()).auto_approve.on, false);
    assert.equal(committed(await ask({ action: 'release.production', resources: [sha('8')] })).request.status, 'pending');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
