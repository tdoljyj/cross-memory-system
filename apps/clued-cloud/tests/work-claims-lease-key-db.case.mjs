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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Work Claim private lease key (migration 20261005190000, Task f165eb56,
// Decision 22b9bd9e): claim and takeover return a key once and store only its
// sha256; another Binding of the same user that presents it may renew (the
// claim moves to it) or release; the key never appears in views, refusals or
// Receipts. Imported by work-claims-reject-receipts-db.test.mjs, so it runs
// with npm run test:work:claims.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const KEY = /^clued_lk_[0-9a-f]{64}$/;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims: a private lease key lets another Binding of the same user renew or release',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-lease-key-'));
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
      values($1,'claims-lease-key@example.invalid',now()),($2,'claims-lease-stranger@example.invalid',now())`,
    [userId, strangerId]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, owner] of [['claude', userId], ['codex', userId], ['stranger', strangerId]]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`,
        [owner, name, tokens[name]])).rows[0].id;
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
      confidence_reason: 'lease key fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, who = 'claude', extra = {}) => agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: [`lease/${taskId}`], ...extra });
    const renew = (who, c, extra = {}) => agent(who, 'clued_work_renew_v1', { scope: 'global',
      claim_id: c.claim_id, fence: c.fence, lease_version: c.lease_version, progress_ref: uuid(), ...extra });
    const release = (who, c, extra = {}) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed', ...extra });
    const takeover = (who, claimId, extra = {}) => agent(who, 'clued_work_takeover_v1',
      { scope: 'global', claim_id: claimId, idempotency_key: uuid(), ...extra });
    const storedHash = async (claimId) => (await admin.query(
      'select lease_key_hash from clued_private.work_claims_v1 where claim_id=$1', [claimId])).rows[0].lease_key_hash;
    const keys = [];
    const issued = (result) => {
      assert.match(result.lease_key, KEY);
      keys.push(result.lease_key);
      return result;
    };

    // --- Issue: one key, only its hash stored, never in the claim view. ---
    const task = await createTask('lease key');
    const idem = uuid();
    const first = issued(committed(await claim(task, 'claude', { idempotency_key: idem })));
    assert.equal(await storedHash(first.claim.claim_id), sha256(first.lease_key));
    assert.equal('lease_key' in first.claim, false);
    assert.equal('lease_key_hash' in first.claim, false);

    // A replay by the holder returns a fresh key; the earlier one stops working.
    const replay = issued(committed(await claim(task, 'claude', { idempotency_key: idem })));
    assert.equal(replay.replayed, true);
    assert.notEqual(replay.lease_key, first.lease_key);
    assert.equal(await storedHash(first.claim.claim_id), sha256(replay.lease_key));
    let held = replay.claim;
    rejected(await renew('codex', held, { lease_key: first.lease_key }), 'work_claim_not_holder');

    // Another Binding without the key, or with a wrong one: not the holder.
    rejected(await renew('codex', held), 'work_claim_not_holder');
    rejected(await renew('codex', held, { lease_key: `clued_lk_${hash()}` }), 'work_claim_not_holder');
    rejected(await release('codex', held), 'work_claim_not_holder');
    // The holder with a wrong key is refused; with the right key or none it renews as before.
    rejected(await renew('claude', held, { lease_key: `clued_lk_${hash()}` }), 'work_claim_lease_key_invalid');
    rejected(await release('claude', held, { lease_key: first.lease_key }), 'work_claim_lease_key_invalid');
    const own = committed(await renew('claude', held, { lease_key: replay.lease_key }));
    assert.equal(own.transferred, undefined);
    held = committed(await renew('claude', own.claim)).claim;
    assert.equal(held.holder_binding_id, bindingIds.claude);

    // A Binding of another user never reaches the claim, key or not.
    rejected(await renew('stranger', held, { lease_key: replay.lease_key }), 'work_claim_not_found');

    // --- Transfer: another Binding with the key renews and becomes the holder. ---
    const sessionBefore = held.holder_session_ref;
    const moved = committed(await renew('codex', held, { lease_key: replay.lease_key, holder_session_ref: 'session-new' }));
    assert.equal(moved.transferred, true);
    assert.deepEqual([moved.claim.claim_id, moved.claim.fence, moved.claim.lease_version,
      moved.claim.holder_binding_id, moved.claim.holder_session_ref],
    [held.claim_id, held.fence, held.lease_version + 1, bindingIds.codex, 'session-new']);
    assert.notEqual(sessionBefore, 'session-new');
    const renewReceipt = (await admin.query(`select binding_id,metadata from public.clued_audit_receipts
      where id=$1`, [moved.receipt_id])).rows[0];
    assert.deepEqual([renewReceipt.binding_id, renewReceipt.metadata.via_lease_key,
      renewReceipt.metadata.transferred_from_binding], [bindingIds.codex, true, bindingIds.claude]);
    // The transfer returns a new key; the presented one works once.
    issued(moved);
    assert.notEqual(moved.lease_key, replay.lease_key);
    assert.equal(await storedHash(held.claim_id), sha256(moved.lease_key));
    held = moved.claim;
    // The new holder renews without the key; the old Binding no longer can, nor with the spent key.
    held = committed(await renew('codex', held)).claim;
    rejected(await renew('claude', held), 'work_claim_not_holder');
    rejected(await renew('claude', held, { lease_key: replay.lease_key }), 'work_claim_not_holder');
    // A replay of the claim by the Binding that issued it does not start a new claim.
    const spent = rejected(await claim(task, 'claude', { idempotency_key: idem }), 'work_claim_idempotency_spent');
    assert.deepEqual([spent.transferred, spent.claim.claim_id], [true, held.claim_id]);
    // The current key opens it for the old Binding again (the same work, back again).
    const back = issued(committed(await renew('claude', held, { lease_key: moved.lease_key })));
    assert.equal(back.claim.holder_binding_id, bindingIds.claude);
    assert.equal(back.claim.holder_session_ref, null);
    held = back.claim;

    // --- Release with the key: ends the claim, the holder stays, the key is cleared. ---
    rejected(await release('codex', held, { lease_key: moved.lease_key }), 'work_claim_not_holder');
    const released = committed(await release('codex', held, { lease_key: back.lease_key }));
    assert.deepEqual([released.claim.status, released.claim.holder_binding_id], ['RELEASED', bindingIds.claude]);
    const releaseReceipt = (await admin.query('select binding_id,metadata from public.clued_audit_receipts where id=$1',
      [released.receipt_id])).rows[0];
    assert.deepEqual([releaseReceipt.binding_id, releaseReceipt.metadata.via_lease_key], [bindingIds.codex, true]);
    assert.equal(await storedHash(held.claim_id), null);
    // The holder retrying with its key on the ended claim hears that it ended.
    rejected(await release('claude', held, { lease_key: back.lease_key }), 'work_claim_not_active');

    // --- Takeover issues a new key; the replaced claim's key is spent. ---
    const takeTask = await createTask('lease key takeover');
    const old = issued(committed(await claim(takeTask)));
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [old.claim.claim_id]);
    // An expired claim moves to nobody: its holder hears work_claim_expired even
    // with the right key, and another Binding's key does not revive it.
    rejected(await renew('claude', old.claim, { lease_key: old.lease_key }), 'work_claim_expired');
    rejected(await renew('codex', old.claim, { lease_key: old.lease_key }), 'work_claim_expired');
    const took = issued(committed(await takeover('codex', old.claim.claim_id)));
    assert.equal(took.claim.fence, old.claim.fence + 1);
    assert.equal(await storedHash(old.claim.claim_id), null);
    assert.equal(await storedHash(took.claim.claim_id), sha256(took.lease_key));
    // The old holder with its old key hears that its claim ended (taken over).
    rejected(await renew('claude', old.claim, { lease_key: old.lease_key }), 'work_claim_not_active');
    const tookBack = issued(committed(await renew('claude', took.claim, { lease_key: took.lease_key })));
    assert.equal(tookBack.claim.holder_binding_id, bindingIds.claude);
    committed(await release('claude', tookBack.claim));

    // --- A claim issued before the key existed behaves as before. ---
    const legacyTask = await createTask('lease key legacy');
    const legacy = issued(committed(await claim(legacyTask)));
    await admin.query('update clued_private.work_claims_v1 set lease_key_hash=null where claim_id=$1',
      [legacy.claim.claim_id]);
    rejected(await renew('codex', legacy.claim, { lease_key: legacy.lease_key }), 'work_claim_not_holder');
    // The holder needs no key for it; one it presents is not checked.
    committed(await release('claude', committed(await renew('claude', legacy.claim,
      { lease_key: legacy.lease_key })).claim));

    // --- The receiving Binding's idempotency keys stay unique. ---
    const clashKey = uuid();
    const clashTask = await createTask('lease key clash');
    const clashing = issued(committed(await claim(clashTask, 'claude', { idempotency_key: clashKey })));
    const codexOwn = issued(committed(await claim(await createTask('codex own'), 'codex',
      { idempotency_key: clashKey })));
    rejected(await renew('codex', clashing.claim, { lease_key: clashing.lease_key }), 'work_claim_idempotency_conflict');
    committed(await release('codex', codexOwn.claim));
    committed(await release('claude', clashing.claim));

    // --- The receiving Binding's live-claim caps apply. ---
    const capTask = await createTask('lease key cap');
    const capped = issued(committed(await claim(capTask)));
    const busy = [];
    for (let i = 0; i < 3; i += 1) {
      busy.push(issued(committed(await claim(await createTask(`codex busy ${i}`), 'codex',
        { holder_session_ref: 'session-full' }))).claim);
    }
    const refusedCap = rejected(await renew('codex', capped.claim,
      { lease_key: capped.lease_key, holder_session_ref: 'session-full' }), 'work_claim_budget_exhausted');
    assert.equal(refusedCap.limit, 'max_active_per_session');
    for (const c of busy) committed(await release('codex', c));

    // --- The key is nowhere but in the answers that issued it. ---
    const active = await agent('codex', 'clued_work_claims_active_v1', { scope: 'global' });
    const views = JSON.stringify(active);
    const receipts = JSON.stringify((await admin.query(
      'select metadata from public.clued_audit_receipts where user_id=$1', [userId])).rows);
    const events = JSON.stringify((await admin.query(
      `select to_jsonb(e) r from public.clued_context_events e where e.user_id=$1`, [userId])).rows);
    for (const key of keys) {
      for (const [where, text] of [['active claims', views], ['receipts', receipts], ['events', events]]) {
        assert.equal(text.includes(key), false, `a lease key appears in ${where}`);
        assert.equal(text.includes(sha256(key)), false, `a lease key hash appears in ${where}`);
      }
    }

    // --- Nobody but the definer can call the helpers. ---
    for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
      for (const fn of ['work_claim_lease_key_hash_v1', 'work_claim_lease_key_issue_v1',
        'work_claim_with_lease_key_v1', 'work_claim_lease_access_v1']) {
        const allowed = (await admin.query(`select bool_or(has_function_privilege($1,p.oid,'execute')) v
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='clued_private' and p.proname=$2`, [role, fn])).rows[0].v;
        assert.equal(allowed, false, `${role} can execute ${fn}`);
      }
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of ['clued_work_claim_v1', 'clued_work_renew_v1', 'clued_work_release_v1', 'clued_work_takeover_v1']) {
        const allowed = (await admin.query(`select has_function_privilege($1,$2::regprocedure,'execute') v`,
          [role, `public.${fn}(text,jsonb)`])).rows[0].v;
        assert.equal(allowed, false, `${role} can execute ${fn}`);
      }
    }
    for (const fn of ['clued_work_claim_v1', 'clued_work_renew_v1', 'clued_work_release_v1', 'clued_work_takeover_v1']) {
      assert.equal((await admin.query(`select has_function_privilege('clued_worker_gateway',$1::regprocedure,'execute') v`,
        [`public.${fn}(text,jsonb)`])).rows[0].v, true, `gateway cannot execute ${fn}`);
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
    await stopCluster(server);
  }
});
