import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// Work Claims merge slot (migration 20261006120000, Task f89eaf0a, Owner
// Decisions 0edf7889 and 2ea795e4): the slot merge:<owner>/<name>:<branch> is
// held by one live claim at a time, lapses 45 minutes after it was last taken
// or refreshed, cannot be revived by its old holder once another session took
// it, and is returned when its pull request is merged or closed. Imported by
// work-claims-reject-receipts-db.test.mjs, so it runs with npm run test:work:claims.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const SLOT = 'merge:tdoljyj/cross-memory-system:main';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims: the merge slot is held by one claim, lapses after 45 minutes and is returned on merge or close',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-merge-slot-'));
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

    const userId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims-merge-slot@example.invalid',now())`, [userId]);
    const tokens = {};
    for (const [name, vendor] of [['claude', 'anthropic'], ['codex', 'openai'], ['ci', 'github']]) {
      tokens[name] = hash();
      await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,$2,$3,$4,array['context:read','context:write'],array['*'])`,
      [userId, vendor, `${name} connection`, tokens[name]]);
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const agent = async (who, name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v;
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const rejected = (result, code) => {
      assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result));
      return result;
    };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'merge slot fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async (who, title, extra = {}) => committed(await agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: await createTask(title),
        write_set: [`merge-slot/${uuid()}`], holder_label: title, ...extra })).claim;
    const renew = (who, c, extra = {}) => agent(who, 'clued_work_renew_v1', { scope: 'global',
      claim_id: c.claim_id, fence: c.fence, lease_version: c.lease_version, progress_ref: uuid(), ...extra });
    const view = async (c) => (await agent('ci', 'clued_work_verify_v1',
      { scope: 'global', claim_id: c.claim_id })).claim;
    const slotAt = async (c) => (await admin.query(
      'select merge_slot_at from clued_private.work_claims_v1 where claim_id=$1', [c.claim_id])).rows[0].merge_slot_at;
    const age = (c, minutes) => admin.query(`update clued_private.work_claims_v1
      set merge_slot_at=clock_timestamp()-make_interval(mins=>$2) where claim_id=$1`, [c.claim_id, minutes]);
    const minutesLeft = (until) => (Date.parse(until) - Date.now()) / 60000;

    // The profile names the slot clock.
    assert.equal((await admin.query('select clued_private.work_claim_profile_v1() v')).rows[0].v.merge_slot_seconds, 2700);

    // --- One holder at a time. ---
    let a = await claim('claude', 'A: pull request one');
    let b = await claim('codex', 'B: pull request two');
    assert.equal(a.merge_slot_until, null, 'no merge ref, no slot');
    a = committed(await renew('claude', a, { trigger_refs: ['task:a', SLOT] })).claim;
    assert.ok(minutesLeft(a.merge_slot_until) > 44 && minutesLeft(a.merge_slot_until) <= 45, a.merge_slot_until);
    // Another session, whatever the case of the ref, waits.
    for (const ref of [SLOT, 'MERGE:tdoljyj/Cross-Memory-System:MAIN']) {
      const refused = rejected(await renew('codex', b, { trigger_refs: [ref] }), 'work_claim_conflict');
      const conflict = refused.conflicts.find((row) => row.claim_id === a.claim_id);
      assert.deepEqual(conflict.overlap.trigger_refs, [SLOT]);
      assert.equal(conflict.merge_slot_until, a.merge_slot_until);
    }
    // Refused renewals use nothing.
    assert.equal((await view(b)).renewals, b.renewals);
    // A new claim that asks for the slot waits too.
    rejected(await agent('codex', 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(),
      task_id: await createTask('C: new claim'), write_set: ['merge-slot/c'], trigger_refs: [SLOT] }), 'work_claim_conflict');
    // Another branch's slot is another slot.
    b = committed(await renew('codex', b, { trigger_refs: ['merge:tdoljyj/cross-memory-system:release'] })).claim;
    assert.ok(b.merge_slot_until);
    b = committed(await renew('codex', b, { trigger_refs: [] })).claim;
    assert.equal(b.merge_slot_until, null);
    assert.equal(await slotAt(b), null, 'without a merge ref there is no clock');

    // --- A renewal refreshes the slot; other writes do not. ---
    await age(a, 30);
    const before = await slotAt(a);
    a = committed(await renew('claude', a)).claim;
    assert.ok(await slotAt(a) > before, 'a renewal that keeps the ref refreshes the clock');
    assert.ok(minutesLeft(a.merge_slot_until) > 44);
    await age(a, 10);
    const aged = await slotAt(a);
    const bound = await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: a.claim_id,
      head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), pr_ref: 'tdoljyj/cross-memory-system#5' });
    assert.equal(bound.verdict, 'ADMITTED', JSON.stringify(bound));
    assert.equal(bound.claim.bound_pr, 'tdoljyj/cross-memory-system#5');
    assert.deepEqual(await slotAt(a), aged, 'binding the pull request does not refresh the slot');
    a = (await view(a));

    // --- It lapses after 45 minutes, and the old holder cannot take it back. ---
    await age(a, 46);
    a = await view(a);
    assert.equal(a.merge_slot_until, null, 'a lapsed slot is shown as not held');
    assert.deepEqual(a.trigger_refs, [SLOT, 'task:a'], 'the ref stays until the holder drops it');
    b = committed(await renew('codex', b, { trigger_refs: [SLOT] })).claim;
    assert.ok(minutesLeft(b.merge_slot_until) > 44, 'B takes the lapsed slot');
    const revived = rejected(await renew('claude', a), 'work_claim_conflict');
    assert.deepEqual(revived.conflicts.map((row) => row.claim_id), [b.claim_id]);
    assert.equal(await slotAt(a) < await slotAt(b), true, 'the refused renewal did not refresh A');
    a = committed(await renew('claude', a, { trigger_refs: ['task:a'] })).claim;
    assert.equal(a.merge_slot_until, null);

    // --- A merge returns the slot of the claims bound to the pull request. ---
    const boundB = await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: b.claim_id,
      head_sha: 'c'.repeat(40), base_sha: 'b'.repeat(40), pr_ref: 'tdoljyj/cross-memory-system#6' });
    assert.equal(boundB.verdict, 'ADMITTED', JSON.stringify(boundB));
    const merged = await agent('ci', 'clued_work_claim_adopt_v1',
      { scope: 'global', pr_ref: 'tdoljyj/cross-memory-system#6', merge_sha: 'd'.repeat(40) });
    assert.deepEqual([merged.status, merged.adopted, merged.reason, merged.merge_slot_returned],
      ['ok', false, 'no_copy_for_pr', [b.claim_id]]);
    b = await view(b);
    assert.deepEqual([b.trigger_refs, b.merge_slot_until, b.status], [[], null, 'ACTIVE'], 'the claim itself stays live');
    const receipt = (await admin.query(`select metadata from public.clued_audit_receipts
      where operation='work_claim_merge_slot_return' and object_id=$1`, [b.claim_id])).rows;
    assert.deepEqual([receipt.length, receipt[0].metadata.receipt_kind, receipt[0].metadata.why,
      receipt[0].metadata.merge_refs, receipt[0].metadata.ref.merge_sha],
    [1, 'WORK_CLAIM_MERGE_SLOT_RETURNED', 'merged', [SLOT], 'd'.repeat(40)]);
    // Replaying the merge report returns nothing more, and answers as before.
    assert.deepEqual(await agent('ci', 'clued_work_claim_adopt_v1',
      { scope: 'global', pr_ref: 'tdoljyj/cross-memory-system#6', merge_sha: 'd'.repeat(40) }),
    { status: 'ok', adopted: false, reason: 'no_copy_for_pr', pr_ref: 'tdoljyj/cross-memory-system#6' });

    // --- So does a pull request closed without a merge. ---
    a = committed(await renew('claude', a, { trigger_refs: [SLOT] })).claim;
    assert.ok(a.merge_slot_until, 'the returned slot is free again');
    const closed = await agent('ci', 'clued_work_merge_slot_return_v1',
      { scope: 'global', pr_ref: 'tdoljyj/cross-memory-system#5' });
    assert.deepEqual([closed.status, closed.returned, closed.merge_slot_returned], ['ok', true, [a.claim_id]]);
    assert.equal((await view(a)).merge_slot_until, null);
    assert.equal((await agent('ci', 'clued_work_merge_slot_return_v1',
      { scope: 'global', pr_ref: 'tdoljyj/cross-memory-system#77' })).returned, false);
    await assert.rejects(() => agent('ci', 'clued_work_merge_slot_return_v1',
      { scope: 'global', pr_ref: 'tdoljyj/cross-memory-system#5', merge_sha: 'd'.repeat(40) }),
    /work_claim_merge_slot_return_input_invalid/);
    await assert.rejects(() => agent('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: 'not a pr' }),
      /work_claim_pr_ref_invalid/);

    // --- A released claim frees its slot at once. ---
    let c = await claim('codex', 'C: takes and releases', { trigger_refs: [SLOT] });
    assert.ok(c.merge_slot_until, 'a claim issued with the ref takes the slot');
    committed(await agent('codex', 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed' }));
    c = await view(c);
    assert.equal(c.merge_slot_until, null);
    a = committed(await renew('claude', await view(a), { trigger_refs: [SLOT] })).claim;
    assert.ok(a.merge_slot_until);

    // --- Grants: the return RPC to anon (the admission door) only; helpers to nobody. ---
    const can = async (role, signature) => (await admin.query(
      `select has_function_privilege($1,$2::regprocedure,'execute') v`, [role, signature])).rows[0].v;
    assert.deepEqual([await can('anon', 'public.clued_work_merge_slot_return_v1(text,jsonb)'),
      await can('authenticated', 'public.clued_work_merge_slot_return_v1(text,jsonb)'),
      await can('service_role', 'public.clued_work_merge_slot_return_v1(text,jsonb)')], [true, false, false]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of ['work_claim_merge_refs_v1', 'work_claim_merge_slot_until_v1', 'work_claim_merge_slot_live_v1',
        'work_claim_merge_slot_stamp_v1', 'work_claim_merge_slot_return_core_v1']) {
        const allowed = (await admin.query(`select bool_or(has_function_privilege($1,p.oid,'execute')) v
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='clued_private' and p.proname=$2`, [role, fn])).rows[0].v;
        assert.equal(allowed, false, `${role} can execute ${fn}`);
      }
    }
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
