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

// Work Claims PR 2 (migration 20261005200000, Task f165eb56, Decisions
// 22b9bd9e and 4bcc424d): the Agent's holder_label, the Owner's list of live
// claims, and the Owner's two-step handover to a new session (new fence, new
// key shown once, the key required from then on). Imported by
// work-claims-reject-receipts-db.test.mjs, so it runs with
// npm run test:work:claims.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-owner') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const KEY = /^clued_lk_[0-9a-f]{64}$/;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims: holder labels, the Owner list and the Owner handover to a new session',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-handover-'));
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
    const strangerId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims-handover@example.invalid',now()),($2,'claims-handover-stranger@example.invalid',now())`,
    [userId, strangerId]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, owner, vendor] of [['claude', userId, 'anthropic'], ['codex', userId, 'openai'],
      ['stranger', strangerId, 'synthetic']]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,$2,$3,$4,array['context:read','context:write'],array['*']) returning id`,
        [owner, vendor, `${name} connection`, tokens[name]])).rows[0].id;
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
    const rejected = (result, code) => {
      assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result));
      return result;
    };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'handover fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, who = 'claude', extra = {}) => agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: [`handover/${taskId}`], ...extra });
    const renew = (who, c, extra = {}) => agent(who, 'clued_work_renew_v1', { scope: 'global',
      claim_id: c.claim_id, fence: c.fence, lease_version: c.lease_version, progress_ref: uuid(), ...extra });
    const release = (who, c, extra = {}) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed', ...extra });
    const issue = (claimId, claims) => native('clued_work_claim_handover_confirmation_issue_v1', { claim_id: claimId }, claims);
    const handover = (issued, claims) => native('clued_work_claim_handover_v1',
      { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, claims);
    const keys = [];
    const kept = (key) => { assert.match(key, KEY); keys.push(key); return key; };

    // --- holder_label: stored, shown in the view, replaced on renew, validated. ---
    const labelTask = await createTask('label task');
    const labelKey = uuid();
    const labelled = committed(await claim(labelTask, 'claude', { idempotency_key: labelKey, holder_label: '  修 C-3 · 笔记本  ',
      holder_client: 'Claude Code', holder_session_title: 'S2c C-3 eval baseline',
      holder_session_ref: 'session_01CmqMMByJcMoDqW3PyWd9Ta' }));
    kept(labelled.lease_key);
    assert.deepEqual([labelled.claim.holder_label, labelled.claim.holder_client, labelled.claim.holder_session_title],
      ['修 C-3 · 笔记本', 'Claude Code', 'S2c C-3 eval baseline']);
    let held = committed(await renew('claude', labelled.claim, { holder_label: 'C-3 PR 等 CI' })).claim;
    assert.equal(held.holder_label, 'C-3 PR 等 CI');
    held = committed(await renew('claude', held)).claim;
    assert.equal(held.holder_label, 'C-3 PR 等 CI', 'a renewal without a label keeps it');
    assert.equal(held.holder_client, 'Claude Code', 'a renewal without a client keeps it');
    held = committed(await renew('claude', held, { holder_session_title: 'C-3 waiting for CI' })).claim;
    assert.equal(held.holder_session_title, 'C-3 waiting for CI');
    const badTask = await createTask('bad label');
    for (const bad of [42, 'x'.repeat(201), 'line\nbreak', '   ', 'safe\u202eevil', 'zero\u200bwidth']) {
      await assert.rejects(() => claim(badTask, 'claude', { holder_label: bad }),
        /work_claim_holder_label_invalid/, JSON.stringify(bad));
    }
    await assert.rejects(() => claim(badTask, 'claude', { holder_label: 'ok', holder_client: 'x'.repeat(81) }),
      /work_claim_holder_client_invalid/);
    await assert.rejects(() => claim(badTask, 'claude', { holder_label: 'ok', holder_session_title: 'tab\there' }),
      /work_claim_holder_session_title_invalid/);
    const unlabelled = committed(await claim(await createTask('codex task'), 'codex',
      { holder_session_ref: 'codex-thread-7' }));
    kept(unlabelled.lease_key);
    assert.equal(unlabelled.claim.holder_label, null);

    // --- The Owner list: live claims only, with names, labels and session links. ---
    const listed = await native('clued_work_claims_owner_list_v1', {});
    assert.equal(listed.status, 'ok');
    const byId = Object.fromEntries(listed.claims.map((row) => [row.claim_id, row]));
    assert.deepEqual(Object.keys(byId).sort(), [held.claim_id, unlabelled.claim.claim_id].sort());
    const mine = byId[held.claim_id];
    assert.deepEqual([mine.task_title, mine.context_key, mine.holder_name, mine.holder_vendor, mine.holder_label,
      mine.holder_client, mine.holder_session_title, mine.holder_session_url,
      mine.holder_connection_live, mine.lease_key_required, mine.handover_available, mine.state, mine.ended_at],
    ['label task', 'global', 'claude connection', 'anthropic', 'C-3 PR 等 CI', 'Claude Code', 'C-3 waiting for CI',
      'https://claude.ai/code/session_01CmqMMByJcMoDqW3PyWd9Ta', true, false, true, 'ACTIVE', null]);
    assert.deepEqual([mine.renewals, mine.max_renewals, typeof mine.progress_ref, mine.write_set, mine.trigger_refs],
      [held.renewals, 12, 'string', held.write_set, held.trigger_refs]);
    assert.deepEqual(listed.ended, [], 'ended claims only on request');
    assert.deepEqual([byId[unlabelled.claim.claim_id].holder_session_ref, byId[unlabelled.claim.claim_id].holder_session_url],
      ['codex-thread-7', null]);
    rejected(await native('clued_work_claims_owner_list_v1', { all: true }), 'work_claim_owner_list_input_invalid');
    for (const bad of [0, 169, 1.5, '24']) {
      rejected(await native('clued_work_claims_owner_list_v1', { ended_within_hours: bad }), 'work_claim_owner_list_input_invalid');
    }
    // Another account sees none of these; a delegated OAuth token and Bindings cannot call it.
    assert.deepEqual((await native('clued_work_claims_owner_list_v1', {}, fresh(strangerId))).claims, []);
    await assert.rejects(() => native('clued_work_claims_owner_list_v1', {}, { ...fresh(userId), client_id: 'oauth-client' }),
      /direct_human_session_required/);
    await assert.rejects(() => anon.query('select public.clued_work_claims_owner_list_v1($1)', [{}]), /permission denied/);
    committed(await release('codex', unlabelled.claim));
    // Ended claims on request: released with its outcome, and a lapsed one as EXPIRED before any write persists it.
    const lapsed = committed(await claim(await createTask('lapsed task'), 'codex'));
    kept(lapsed.lease_key);
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [lapsed.claim.claim_id]);
    const ended = await native('clued_work_claims_owner_list_v1', { ended_within_hours: 24 });
    const endedById = Object.fromEntries(ended.ended.map((row) => [row.claim_id, row]));
    assert.deepEqual([endedById[unlabelled.claim.claim_id].state, endedById[unlabelled.claim.claim_id].released_outcome,
      typeof endedById[unlabelled.claim.claim_id].ended_at], ['RELEASED', 'completed', 'string']);
    assert.deepEqual([endedById[lapsed.claim.claim_id].state, endedById[lapsed.claim.claim_id].handover_available],
      ['EXPIRED', false]);
    assert.ok(!ended.claims.some((row) => row.claim_id === lapsed.claim.claim_id), 'a lapsed claim is not live');

    // --- Handover, step by step. ---
    const stuck = held;
    rejected(await issue(stuck.claim_id, { ...fresh(userId), session_id: undefined }), 'confirmation_token_session_id_required');
    rejected(await issue(stuck.claim_id, fresh(strangerId)), 'work_claim_not_found');
    rejected(await native('clued_work_claim_handover_confirmation_issue_v1', { claim_id: stuck.claim_id, extra: 1 }),
      'work_claim_handover_input_invalid');
    const issued = await issue(stuck.claim_id);
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    assert.deepEqual([issued.confirmation_view.task_title, issued.confirmation_view.fence, issued.confirmation_view.holder_label],
      ['label task', stuck.fence, 'C-3 PR 等 CI']);
    // The stuck session renewing in between does not stale the confirmation.
    const between = committed(await renew('claude', stuck)).claim;
    // Another session of the Owner cannot use the confirmation.
    rejected(await handover(issued, fresh(userId, 'sess-other')), 'confirmation_token_binding_mismatch');
    const issuedAgain = await issue(stuck.claim_id);
    const done = committed(await handover(issuedAgain));
    const newKey = kept(done.lease_key);
    const moved = done.claim;
    assert.deepEqual([moved.claim_id, moved.fence, moved.lease_version, moved.lease_key_required],
      [stuck.claim_id, between.fence + 1, between.lease_version + 1, true]);
    assert.ok(Date.parse(moved.expires_at) > Date.parse(between.expires_at) - 1000);
    const receipt = (await admin.query('select binding_id,metadata from public.clued_audit_receipts where id=$1',
      [done.receipt_id])).rows[0];
    assert.deepEqual([receipt.binding_id, receipt.metadata.receipt_kind, receipt.metadata.previous_fence,
      receipt.metadata.fence, receipt.metadata.principal],
    [null, 'WORK_CLAIM_HANDOVER', between.fence, moved.fence, 'native_account_session']);
    // A replay commits nothing new and cannot show the key again.
    const replay = committed(await handover(issuedAgain));
    assert.deepEqual([replay.replayed, replay.lease_key, replay.receipt_id], [true, null, done.receipt_id]);

    // The stuck session is cut off: without the key, with its old key, with its old fence.
    const latest = { claim_id: moved.claim_id, fence: moved.fence, lease_version: moved.lease_version };
    rejected(await renew('claude', latest), 'work_claim_lease_key_required');
    rejected(await renew('claude', latest, { lease_key: labelled.lease_key }), 'work_claim_lease_key_invalid');
    rejected(await renew('claude', between, { lease_key: newKey }), 'work_claim_fence_mismatch');
    rejected(await release('claude', latest), 'work_claim_lease_key_required');

    // The new session (same Binding, new key) takes over and keeps the key requirement.
    // The stuck session replaying its original claim gets no key back.
    rejected(await claim(labelTask, 'claude', { idempotency_key: labelKey, holder_label: '  修 C-3 · 笔记本  ',
      holder_client: 'Claude Code', holder_session_title: 'S2c C-3 eval baseline',
      holder_session_ref: 'session_01CmqMMByJcMoDqW3PyWd9Ta' }), 'work_claim_lease_key_required');
    const taken = committed(await renew('claude', latest, { lease_key: newKey, holder_session_ref: 'session_01NewSessionAfterHandover',
      holder_label: '接手 · 新会话' }));
    assert.deepEqual([taken.transferred, taken.claim.lease_key_required, taken.claim.holder_label, taken.claim.holder_session_ref],
      [undefined, true, '接手 · 新会话', 'session_01NewSessionAfterHandover']);
    const relisted = (await native('clued_work_claims_owner_list_v1', {})).claims.find((row) => row.claim_id === taken.claim.claim_id);
    assert.equal(relisted.holder_session_url, 'https://claude.ai/code/session_01NewSessionAfterHandover');
    rejected(await renew('claude', taken.claim), 'work_claim_lease_key_required');
    // From another Binding the key moves the claim, and the key rotates.
    const across = committed(await renew('codex', taken.claim, { lease_key: newKey, holder_session_ref: 'codex-thread-8' }));
    const acrossKey = kept(across.lease_key);
    assert.equal(across.claim.holder_binding_id, bindingIds.codex);
    rejected(await renew('codex', across.claim), 'work_claim_lease_key_required');
    rejected(await renew('claude', across.claim), 'work_claim_not_holder');
    committed(await release('codex', across.claim, { lease_key: acrossKey }));

    // --- Refusals at the confirmation steps. ---
    const staleTask = await createTask('stale handover');
    const staleClaim = committed(await claim(staleTask, 'claude', { write_set: ['stale/a'] }));
    kept(staleClaim.lease_key);
    const staleIssued = await issue(staleClaim.claim.claim_id);
    committed(await renew('claude', staleClaim.claim, { write_set: ['stale/a', 'stale/b'] }));
    rejected(await handover(staleIssued), 'confirmation_view_stale');
    rejected(await handover(staleIssued), 'confirmation_token_reused');
    const endedIssued = await issue(staleClaim.claim.claim_id);
    const current = (await native('clued_work_claims_owner_list_v1', {})).claims.find((row) => row.claim_id === staleClaim.claim.claim_id);
    committed(await release('claude', { claim_id: current.claim_id, fence: current.fence }));
    rejected(await handover(endedIssued), 'work_claim_not_active');
    rejected(await issue(staleClaim.claim.claim_id), 'work_claim_not_active');
    // A claim the new session could not renew cannot be handed over.
    const spent = committed(await claim(await createTask('spent handover')));
    kept(spent.lease_key);
    await admin.query(`update clued_private.work_claims_v1 set renewals=12 where claim_id=$1`, [spent.claim.claim_id]);
    rejected(await issue(spent.claim.claim_id), 'work_claim_handover_no_renewal_left');
    await admin.query(`update clued_private.work_claims_v1 set renewals=0 where claim_id=$1`, [spent.claim.claim_id]);
    const spentIssued = await issue(spent.claim.claim_id);
    await admin.query(`update clued_private.work_claims_v1 set hard_deadline_at=clock_timestamp()+interval '5 minutes',
      expires_at=least(expires_at,clock_timestamp()+interval '5 minutes') where claim_id=$1`, [spent.claim.claim_id]);
    rejected(await handover(spentIssued), 'work_claim_handover_no_renewal_left');
    // A legacy claim with no key cannot be handed over.
    const legacy = committed(await claim(await createTask('legacy handover')));
    kept(legacy.lease_key);
    await admin.query('update clued_private.work_claims_v1 set lease_key_hash=null where claim_id=$1', [legacy.claim.claim_id]);
    rejected(await issue(legacy.claim.claim_id), 'work_claim_handover_unavailable');

    // --- No key or key hash anywhere it can be read back. ---
    const everything = JSON.stringify([
      (await native('clued_work_claims_owner_list_v1', {})),
      (await admin.query('select metadata from public.clued_audit_receipts where user_id=$1', [userId])).rows,
      (await admin.query('select to_jsonb(e) r from public.clued_context_events e where e.user_id=$1', [userId])).rows,
      (await admin.query('select native_choices,confirmation_view from clued_private.native_confirmation_tokens where user_id=$1',
        [userId])).rows,
    ]);
    for (const key of keys) {
      assert.equal(everything.includes(key), false, 'a lease key was stored or listed');
      assert.equal(everything.includes(crypto.createHash('sha256').update(key).digest('hex')), false, 'a key hash leaked');
    }

    // --- Grants: the three Owner RPCs to authenticated only; helpers to nobody. ---
    for (const fn of ['clued_work_claims_owner_list_v1', 'clued_work_claim_handover_confirmation_issue_v1',
      'clued_work_claim_handover_v1']) {
      const can = async (role) => (await admin.query(`select has_function_privilege($1,$2::regprocedure,'execute') v`,
        [role, `public.${fn}(jsonb)`])).rows[0].v;
      assert.deepEqual([await can('authenticated'), await can('anon'), await can('service_role')], [true, false, false], fn);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of ['work_claim_self_report_v1', 'work_claim_owner_row_v1', 'work_claim_handover_view_v1']) {
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
