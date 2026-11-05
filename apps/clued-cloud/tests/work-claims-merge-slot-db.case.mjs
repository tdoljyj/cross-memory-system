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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Work Claims merge slot (migration 20261006120000, Task f89eaf0a, Owner
// Decisions 0edf7889 and 2ea795e4): the slot merge:<owner>/<name>:<branch> is
// held by one live claim at a time, lapses 45 minutes after it was last taken
// or refreshed, cannot be revived by its old holder once another session took
// it, and is returned when its pull request is merged or closed. Merge
// Admission step 3 (migration 20261009010000, Task 3576d10d): CI reports keep
// it (running 45 minutes, green 30), a CI failure returns it, a hard cap ends
// it, and the admission mode goes into the verify Receipts. Merge Admission
// step 4 (migration 20261009080000, Task 38e0c90d): the slot is a FIFO queue;
// a merge ref never conflicts, the head holds the slot, and the next entry
// becomes head when it leaves or lapses. Imported by
// work-claims-reject-receipts-db.test.mjs, so it runs with npm run test:work:claims.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const SLOT = 'merge:tdoljyj/cross-memory-system:main';
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-owner') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });

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
    await allowRawTestBindings(admin);

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
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
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
    // Moves every slot and queue time of the account back, as if the minutes had passed (leases stay).
    const age = async (minutes) => {
      await admin.query(`update clued_private.work_claims_v1 set
        merge_slot_at=merge_slot_at-make_interval(mins=>$2),merge_queued_at=merge_queued_at-make_interval(mins=>$2),
        merge_slot_taken_at=merge_slot_taken_at-make_interval(mins=>$2),merge_slot_ci_at=merge_slot_ci_at-make_interval(mins=>$2)
        where user_id=$1`, [userId, minutes]);
      await admin.query(`update clued_private.work_claim_merge_queue_v1 set
        head_left_at=head_left_at-make_interval(mins=>$2),left_queued_at=left_queued_at-make_interval(mins=>$2)
        where user_id=$1`, [userId, minutes]);
    };
    // Makes the head's slot have started the minutes ago.
    const startedAgo = async (c, minutes) => {
      await admin.query(`update clued_private.work_claims_v1 set merge_queued_at=clock_timestamp()-make_interval(mins=>$2)
        where claim_id=$1`, [c.claim_id, minutes]);
      // Whoever left before it left earlier still.
      await admin.query(`update clued_private.work_claim_merge_queue_v1
        set head_left_at=least(head_left_at,clock_timestamp()-make_interval(mins=>$2)),
          left_queued_at=least(left_queued_at,clock_timestamp()-make_interval(mins=>$2+1)) where user_id=$1`, [userId, minutes]);
    };
    const queue = (c) => c.merge_queue?.[0];
    // Every slot time is stamped by the database's clock (clock_timestamp()). The windows below are checked on that
    // clock alone, never against Node's Date, so drift or a step between the two clocks cannot move them. A slot that
    // lasts `minutes` from its start ends at start + minutes; the start is no earlier than the beginning of this case and
    // no later than the database's clock when the slot is read, so `until` lies in [T0 + minutes, now + minutes].
    // That bounds the start exactly, however long the test process is delayed, where the old 1-minute window did not.
    const dbMicros = async () => BigInt((await admin.query(
      'select (extract(epoch from clock_timestamp())*1000000)::bigint v')).rows[0].v);
    const microsOf = async (timestamp) => BigInt((await admin.query(
      'select (extract(epoch from $1::timestamptz)*1000000)::bigint v', [timestamp])).rows[0].v);
    const T0 = await dbMicros();
    const assertEnds = async (until, minutes, message, since = T0) => {
      const end = await microsOf(until), now = await dbMicros(), span = BigInt(minutes) * 60_000_000n;
      assert.ok(end >= since + span && end <= now + span,
        `${message ?? 'slot end'}: ${until} is not ${minutes} minutes after a start in [${since}, ${now}] (microseconds, database clock)`);
    };

    // The profile names the slot clock.
    assert.equal((await admin.query('select clued_private.work_claim_profile_v1() v')).rows[0].v.merge_slot_seconds, 2700);

    // --- One head at a time; the others wait in the queue (step 4). ---
    let a = await claim('claude', 'A: pull request one');
    let b = await claim('codex', 'B: pull request two');
    assert.deepEqual([a.merge_slot_until, a.merge_queue], [null, null], 'no merge ref, no slot');
    a = committed(await renew('claude', a, { trigger_refs: ['task:a', SLOT] })).claim;
    await assertEnds(a.merge_slot_until, 45, 'a taken slot lasts 45 minutes');
    assert.deepEqual([queue(a).ref, queue(a).state, queue(a).position, queue(a).length, queue(a).head.claim_id, queue(a).ahead],
      [SLOT, 'head', 1, 1, a.claim_id, []]);
    // Another session joins behind it, whatever the case of the ref.
    b = committed(await renew('codex', b, { trigger_refs: ['MERGE:tdoljyj/Cross-Memory-System:MAIN'] })).claim;
    assert.equal(b.merge_slot_until, null, 'a waiting claim holds no slot');
    assert.deepEqual([queue(b).state, queue(b).position, queue(b).length, queue(b).ahead.map((row) => row.claim_id),
      queue(b).head.claim_id], ['waiting', 2, 2, [a.claim_id], a.claim_id]);
    // A new claim with the ref joins too, and a waiting renewal keeps its place.
    let c0 = await claim('codex', 'C: new claim', { trigger_refs: [SLOT] });
    assert.deepEqual([queue(c0).state, queue(c0).position, c0.merge_slot_until], ['waiting', 3, null]);
    b = committed(await renew('codex', b)).claim;
    assert.deepEqual([queue(b).state, queue(b).position], ['waiting', 2]);
    assert.deepEqual([queue(await view(a)).state, queue(await view(a)).length], ['head', 3]);
    // Dropping the ref leaves the queue.
    c0 = committed(await renew('codex', c0, { trigger_refs: [] })).claim;
    assert.equal(c0.merge_queue, null);
    // Another branch's slot is another queue.
    b = committed(await renew('codex', b, { trigger_refs: ['merge:tdoljyj/cross-memory-system:release'] })).claim;
    assert.ok(b.merge_slot_until);
    assert.equal(queue(await view(a)).length, 1);
    b = committed(await renew('codex', b, { trigger_refs: [] })).claim;
    assert.equal(b.merge_slot_until, null);
    assert.equal(await slotAt(b), null, 'without a merge ref there is no clock');

    // --- A renewal refreshes the slot; other writes do not. ---
    await age(30);
    const before = await slotAt(a);
    a = committed(await renew('claude', a)).claim;
    assert.ok(await slotAt(a) > before, 'a renewal that keeps the ref refreshes the clock');
    await assertEnds(a.merge_slot_until, 45, 'a renewal restarts the 45 minutes');
    await age(10);
    const aged = await slotAt(a);
    const bound = await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: a.claim_id,
      head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), pr_ref: 'tdoljyj/cross-memory-system#5' });
    assert.equal(bound.verdict, 'ADMITTED', JSON.stringify(bound));
    assert.equal(bound.claim.bound_pr, 'tdoljyj/cross-memory-system#5');
    assert.deepEqual(await slotAt(a), aged, 'binding the pull request does not refresh the slot');
    a = (await view(a));

    // --- It lapses after 45 minutes; the next entry becomes head, and the old holder joins at the back. ---
    b = committed(await renew('codex', b, { trigger_refs: [SLOT] })).claim;
    assert.equal(queue(b).state, 'waiting');
    await age(46);
    a = await view(a);
    assert.deepEqual([a.merge_slot_until, queue(a).state], [null, 'lapsed'], 'a lapsed slot is shown as not held');
    assert.deepEqual(a.trigger_refs, [SLOT, 'task:a'], 'the ref stays until the holder drops it');
    b = await view(b);
    assert.equal(queue(b).state, 'head');
    const bUntil = b.merge_slot_until;
    await assertEnds(bUntil, 34, 'B became head when A lapsed 11 minutes ago');
    a = committed(await renew('claude', a)).claim;
    assert.deepEqual([queue(a).state, queue(a).position, queue(a).ahead.map((row) => row.claim_id), a.merge_slot_until],
      ['waiting', 2, [b.claim_id], null], 'A joins again at the back');
    b = await view(b);
    assert.equal(b.merge_slot_until, bUntil, 'A joining again does not move the start B got');
    a = committed(await renew('claude', a, { trigger_refs: ['task:a'] })).claim;
    assert.equal(a.merge_queue, null);

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
    assert.ok(c.merge_slot_until, 'a claim issued with the ref into an empty queue takes the slot');
    committed(await agent('codex', 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed' }));
    c = await view(c);
    assert.equal(c.merge_slot_until, null);
    a = committed(await renew('claude', await view(a), { trigger_refs: [SLOT] })).claim;
    assert.ok(a.merge_slot_until);

    // --- The copies of a race share the one slot too (review MAJOR-1). ---
    a = committed(await renew('claude', a, { trigger_refs: [] })).claim;
    const raceTask = await createTask('race for the slot');
    const shared = ['merge-slot/race/final/**'];
    const issued = await native('clued_work_claim_multi_confirmation_issue_v1', { task_id: raceTask, copies: 2, shared_resources: shared });
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    committed(await native('clued_work_claim_multi_enable_v1',
      { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
    const copy = async (session) => committed(await agent('claude', 'clued_work_claim_v1', { scope: 'global',
      idempotency_key: uuid(), task_id: raceTask, write_set: ['merge-slot/race/**'], trigger_refs: ['task:race'],
      holder_session_ref: session })).claim;
    let c1 = await copy('race-1');
    let c2 = await copy('race-2');
    assert.deepEqual([c1.copy_index, c2.copy_index], [1, 2], 'siblings with the same paths and refs do not conflict');
    c1 = committed(await renew('claude', c1, { trigger_refs: ['task:race', SLOT] })).claim;
    assert.ok(c1.merge_slot_until);
    c2 = committed(await renew('claude', c2, { trigger_refs: ['task:race', SLOT] })).claim;
    assert.deepEqual([c2.merge_slot_until, queue(c2).state, queue(c2).ahead.map((row) => row.claim_id)],
      [null, 'waiting', [c1.claim_id]], 'a sibling copy queues behind the holder copy');
    c1 = committed(await renew('claude', c1)).claim;
    assert.ok(c1.merge_slot_until, 'the holder copy refreshes its slot');
    c2 = committed(await renew('claude', c2, { trigger_refs: ['task:race'] })).claim;

    // --- The return drops only the pull request's own repository's slots. ---
    c1 = committed(await renew('claude', c1, { trigger_refs: ['task:race', SLOT, 'merge:other/repo:main'] })).claim;
    const boundC1 = await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: c1.claim_id,
      head_sha: 'e'.repeat(40), base_sha: 'b'.repeat(40), pr_ref: 'tdoljyj/Cross-Memory-System#9' });
    assert.equal(boundC1.verdict, 'ADMITTED', JSON.stringify(boundC1));
    assert.deepEqual((await agent('ci', 'clued_work_merge_slot_return_v1',
      { scope: 'global', pr_ref: 'tdoljyj/Cross-Memory-System#9' })).merge_slot_returned, [c1.claim_id]);
    assert.deepEqual((await view(c1)).trigger_refs, ['merge:other/repo:main', 'task:race']);

    // --- Merge Admission step 3 (migration 20261009010000): the slot follows CI. ---
    const slotProfile = (await admin.query('select clued_private.work_claim_profile_v1() v')).rows[0].v;
    assert.deepEqual([slotProfile.merge_slot_running_seconds, slotProfile.merge_slot_green_seconds], [5400, 1800]);
    const PR = 'tdoljyj/cross-memory-system#20';
    const HEAD = 'f'.repeat(40);
    const touch = (input) => agent('ci', 'clued_work_merge_slot_touch_v1',
      { scope: 'global', pr_ref: PR, head_sha: HEAD, ...input });
    const holders = (input = {}) => agent('ci', 'clued_work_merge_slot_holders_v1',
      { scope: 'global', repository: 'tdoljyj/cross-memory-system', ...input });
    const receipts = async (c, operation) => (await admin.query(`select metadata from public.clued_audit_receipts
      where operation=$2 and object_id=$1 order by created_at,id`, [c.claim_id, operation])).rows.map((row) => row.metadata);
    const setSlot = (c, column, minutes) => admin.query(`update clued_private.work_claims_v1
      set ${column}=clock_timestamp()-make_interval(mins=>$2) where claim_id=$1`, [c.claim_id, minutes]);
    c1 = committed(await renew('claude', c1, { trigger_refs: ['task:race'] })).claim;
    let d = await claim('codex', 'D: final round under CI', { trigger_refs: [SLOT] });
    assert.ok(d.merge_slot_until);
    assert.deepEqual(d.merge_slot_ci, { taken_at: d.merge_slot_ci.taken_at, hard_cap_until: null,
      ci_state: null, ci_head_sha: null, ci_at: null }, 'a new slot has no CI state and no cap yet');

    // §10: the admission mode goes into the Receipts of the binding and of each newly admitted head.
    await assert.rejects(() => agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: d.claim_id,
      head_sha: HEAD, base_sha: 'b'.repeat(40), pr_ref: PR, admission_mode: { state: 'relaxed', layer: 'code' } }),
    /work_claim_admission_mode_invalid/);
    for (const mode of [[], { state: 'normal' }, { state: 'normal', layer: 'code', reruns_per_head: 4 },
      { state: 'normal', layer: 'code', extra: 1 }, { state: 'normal', layer: 'code', reruns_per_head: '1' }]) {
      await assert.rejects(() => agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: d.claim_id,
        head_sha: HEAD, pr_ref: PR, admission_mode: mode }), /work_claim_admission_mode_invalid/, JSON.stringify(mode));
    }
    const MODE = { state: 'normal', layer: 'code', reruns_per_head: 1 };
    const boundD = await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: d.claim_id,
      head_sha: HEAD, base_sha: 'b'.repeat(40), pr_ref: PR, admission_mode: MODE });
    assert.deepEqual([boundD.verdict, boundD.admission_mode], ['ADMITTED', MODE], JSON.stringify(boundD));
    assert.deepEqual((await receipts(d, 'work_claim_bind_pr')).map((m) => m.admission_mode), [MODE]);
    // The same head again writes nothing more; a new head writes its own Receipt, with or without a mode.
    await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: d.claim_id, head_sha: HEAD, pr_ref: PR, admission_mode: MODE });
    await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: d.claim_id, head_sha: '9'.repeat(40), pr_ref: PR });
    assert.deepEqual((await receipts(d, 'work_claim_admit_head')).map((m) => [m.receipt_kind, m.head_sha, m.pr_ref, m.admission_mode]),
      [['WORK_CLAIM_HEAD_ADMITTED', HEAD, PR, MODE], ['WORK_CLAIM_HEAD_ADMITTED', '9'.repeat(40), PR, null]]);
    // A read-only verify (no pull request) with a mode admits nothing and writes nothing.
    assert.equal((await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: d.claim_id, admission_mode: MODE })).verdict, 'ADMITTED');
    assert.equal((await receipts(d, 'work_claim_admit_head')).length, 2);

    // The holders of a repository's slot.
    const listed = await holders();
    assert.deepEqual(listed.holders.map((row) => [row.claim_id, row.bound_pr, row.merge_refs]), [[d.claim_id, PR, [SLOT]]]);
    assert.equal(listed.holders[0].progress_ref, d.progress_ref);
    assert.deepEqual((await holders({ repository: 'other/repo' })).holders, []);
    await assert.rejects(() => holders({ repository: 'not a repo' }), /work_claim_repository_invalid/);
    await assert.rejects(() => holders({ pr_ref: PR }), /work_claim_merge_slot_holders_input_invalid/);

    // Input checks.
    for (const [input, error] of [[{ ci_state: 'pending', hard_cap_minutes: 120 }, /work_claim_merge_slot_ci_state_invalid/],
      [{ ci_state: 'running' }, /work_claim_merge_slot_hard_cap_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: 59 }, /work_claim_merge_slot_hard_cap_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: 181 }, /work_claim_merge_slot_hard_cap_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: '120' }, /work_claim_merge_slot_hard_cap_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: 120.5 }, /work_claim_merge_slot_hard_cap_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: 120, head_sha: 'not a sha' }, /work_claim_head_sha_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: 120, pr_ref: 'nope' }, /work_claim_pr_ref_invalid/],
      [{ ci_state: 'running', hard_cap_minutes: 120, merge_sha: HEAD }, /work_claim_merge_slot_touch_input_invalid/]]) {
      await assert.rejects(() => touch(input), error, JSON.stringify(input));
    }

    // running keeps the slot 90 minutes after the report (an hour between reports and a late
    // scheduled run, review MAJOR-1), whatever the renewal clock says.
    await age(40);
    await assertEnds((await view(d)).merge_slot_until, 5, 'the renewal clock alone has 5 minutes left');
    const running = await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    assert.deepEqual([running.status, running.touched, running.claims], ['ok', true, [d.claim_id]], JSON.stringify(running));
    d = await view(d);
    // 90 minutes from the report, but the slot started 40 minutes ago, so the 120-minute cap ends it first.
    await assertEnds(d.merge_slot_until, 80, 'the 120-minute cap ends the slot 80 minutes from now');
    assert.deepEqual([d.merge_slot_ci.ci_state, d.merge_slot_ci.ci_head_sha], ['running', HEAD]);
    assert.ok(Math.abs(Date.parse(d.merge_slot_ci.hard_cap_until) - Date.parse(d.merge_slot_ci.taken_at) - 120 * 60000) < 1000);
    // A repeated report refreshes the clock but writes no new Receipt.
    await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    assert.deepEqual((await receipts(d, 'work_claim_merge_slot_touch')).map((m) => [m.receipt_kind, m.ci_state, m.previous_ci_state]),
      [['WORK_CLAIM_MERGE_SLOT_TOUCHED', 'running', null]]);
    // Reports do not count as renewals.
    assert.equal(d.renewals, 0);

    // green keeps it 30 minutes after the report, unless a renewal gives more.
    await touch({ ci_state: 'green', hard_cap_minutes: 120 });
    d = await view(d);
    await assertEnds(d.merge_slot_until, 30, 'green keeps the slot 30 minutes');
    // A later green report for the same head does not move its 30 minutes (review MINOR-3)...
    await setSlot(d, 'merge_slot_ci_at', 20);
    await touch({ ci_state: 'green', hard_cap_minutes: 120 });
    d = await view(d);
    await assertEnds(d.merge_slot_until, 10, 'a repeated green report does not move the 30 minutes');
    // ...a new head's does, and so does running in between.
    await touch({ ci_state: 'green', hard_cap_minutes: 120, head_sha: '9'.repeat(40) });
    d = await view(d);
    await assertEnds(d.merge_slot_until, 30, 'a new head restarts the 30 minutes');
    await touch({ ci_state: 'green', hard_cap_minutes: 120 });
    d = committed(await renew('codex', await view(d))).claim;
    await assertEnds(d.merge_slot_until, 45, 'the renewal clock is later now');
    assert.equal(d.merge_slot_ci.ci_state, 'green', 'a renewal of a live slot keeps its CI state');
    assert.deepEqual((await receipts(d, 'work_claim_merge_slot_touch')).map((m) => [m.ci_state, m.head_sha, m.previous_ci_state]),
      [['running', HEAD, null], ['green', HEAD, 'running'], ['green', '9'.repeat(40), 'green'], ['green', HEAD, 'green']]);

    // The hard cap ends the slot whatever the clocks say, and a report cannot revive it.
    await startedAgo(d, 110);
    await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    d = await view(d);
    await assertEnds(d.merge_slot_until, 10, 'the cap leaves 10 minutes of a slot that started 110 minutes ago');
    await startedAgo(d, 121);
    d = await view(d);
    assert.equal(d.merge_slot_until, null, 'past the hard cap the slot has lapsed');
    assert.deepEqual((await holders()).holders, []);
    const late = await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    assert.deepEqual([late.touched, late.reason], [false, 'no_live_slot_for_pr']);
    assert.equal((await view(d)).merge_slot_until, null);
    // The next entry takes it now; the old holder joins again behind, and gets a new slot when its turn comes.
    let e = await claim('claude', 'E: waits for the slot');
    e = committed(await renew('claude', e, { trigger_refs: [SLOT] })).claim;
    assert.ok(e.merge_slot_until, 'E takes the slot D lost to the hard cap');
    d = committed(await renew('codex', await view(d))).claim;
    assert.deepEqual([d.merge_slot_until, queue(d).state, queue(d).ahead.map((row) => row.claim_id)],
      [null, 'waiting', [e.claim_id]], 'D joins again behind E');
    const eLeft = await dbMicros();
    e = committed(await renew('claude', e, { trigger_refs: [] })).claim;
    d = await view(d);
    await assertEnds(d.merge_slot_until, 45, 'D is head again once E leaves', eLeft);
    assert.deepEqual([d.merge_slot_ci.ci_state, d.merge_slot_ci.hard_cap_until], [null, null], 'taken again: a new slot');
    assert.ok(await microsOf(d.merge_slot_ci.taken_at) >= eLeft && await microsOf(d.merge_slot_ci.taken_at) <= await dbMicros(),
      'the new slot was taken when E left');
    // Another pull request's report does nothing to it.
    assert.equal((await touch({ pr_ref: 'tdoljyj/cross-memory-system#21', ci_state: 'running', hard_cap_minutes: 90 })).touched, false);
    assert.equal((await touch({ pr_ref: 'tdoljyj/cross-memory-system#21', ci_state: 'failed' })).returned, false);
    assert.ok((await view(d)).merge_slot_until);

    // failed returns the slot at once, with its Receipt.
    const failed = await touch({ ci_state: 'failed', reason: 'gitleaks concluded failure' });
    assert.deepEqual([failed.returned, failed.merge_slot_returned], [true, [d.claim_id]]);
    assert.deepEqual(failed.notified, [d.claim_id]);
    const notices = async () => (await admin.query(`select * from clued_private.agent_messages_v1
      where to_claim_id=$1 and rate_limit_exempt order by created_at`, [d.claim_id])).rows;
    let messages = await notices();
    assert.equal(messages.length, 1);
    const notice = messages[0];
    assert.deepEqual([notice.kind, notice.to_binding_id, notice.to_session_ref, notice.thread_id],
      ['info', d.holder_binding_id, d.holder_session_ref, notice.message_id]);
    assert.match(notice.subject, /CI 失败：.*#20 合并位已退回/);
    assert.ok(notice.body.includes(HEAD));
    assert.match(notice.body, /gitleaks concluded failure.*\n下一步：修好后 push/);
    assert.deepEqual(notice.refs, ['pr:20', `task:${d.task_id}`]);
    assert.equal(notice.idempotency_key, `ci-failed:${d.claim_id}:${HEAD}`);
    assert.match(notice.request_hash, /^[0-9a-f]{64}$/);
    assert.equal(Date.parse(notice.expires_at) - Date.parse(notice.created_at), 14 * 86400000);
    const messageReceipts = await admin.query(`select metadata from public.clued_audit_receipts
      where object_type='agent_message' and object_id=$1`, [notice.message_id]);
    assert.equal(messageReceipts.rows.length, 1);
    assert.equal(messageReceipts.rows[0].metadata.receipt_kind, 'AGENT_MESSAGE_SENT');
    assert.equal(JSON.stringify(messageReceipts.rows).includes('gitleaks concluded failure'), false);
    const inbox = await agent('codex', 'clued_agent_inbox_v1', { scope: 'global', session_ref: d.holder_session_ref });
    assert.ok(inbox.messages.some((m) => m.message_id === notice.message_id && m.body === notice.body));
    d = await view(d);
    assert.deepEqual([d.merge_slot_until, d.merge_slot_ci, d.trigger_refs], [null, null, []]);
    const failure = (await receipts(d, 'work_claim_merge_slot_return')).at(-1);
    assert.deepEqual([failure.receipt_kind, failure.why, failure.ref.head_sha, failure.merge_refs],
      ['WORK_CLAIM_MERGE_SLOT_RETURNED', 'ci_failed', HEAD, [SLOT]]);
    assert.equal((await touch({ ci_state: 'failed', hard_cap_minutes: 120 })).returned, false, 'nothing more to return');
    assert.equal((await notices()).length, 1);
    await assert.rejects(() => touch({ ci_state: 'failed', hard_cap_minutes: 200 }), /work_claim_merge_slot_hard_cap_invalid/);

    // Even when it takes the slot again, the same claim/head has one notice.
    d = committed(await renew('codex', d, { trigger_refs: [SLOT], progress_ref: HEAD })).claim;
    assert.equal((await holders()).holders.find((h) => h.claim_id === d.claim_id).progress_ref, HEAD);
    assert.deepEqual((await touch({ ci_state: 'failed', reason: 'same head, another report' })).notified, []);
    assert.equal((await notices()).length, 1);
    d = committed(await renew('codex', await view(d), { trigger_refs: [SLOT] })).claim;
    const newHead = '8'.repeat(40);
    assert.deepEqual((await touch({ ci_state: 'failed', head_sha: newHead })).notified, [d.claim_id]);
    assert.equal((await notices()).length, 2);

    // Invalid reason never returns the slot or creates a notice.
    d = committed(await renew('codex', await view(d), { trigger_refs: [SLOT] })).claim;
    for (const reason of [null, 1, {}, '', 'x'.repeat(301), 'line\nbreak', 'tab\there']) {
      await assert.rejects(() => touch({ ci_state: 'failed', reason }), /work_claim_merge_slot_reason_invalid/);
    }
    assert.ok((await view(d)).merge_slot_until);
    // Revoked, expired, scope-denied and context-denied recipients are skipped;
    // the failure still returns the slot. Restore the synthetic Binding each time.
    for (const [column, value, restore] of [['revoked_at', 'clock_timestamp()', null],
      ['expires_at', "clock_timestamp()-interval '1 second'", null], ['scopes', ['context:write'], ['context:read', 'context:write']],
      ['context_keys', ['project:00000000-0000-4000-8000-000000000001'], ['*']]]) {
      if (typeof value === 'string') await admin.query(`update public.clued_agent_bindings set ${column}=${value} where id=$1`, [d.holder_binding_id]);
      else await admin.query(`update public.clued_agent_bindings set ${column}=$2 where id=$1`, [d.holder_binding_id, value]);
      const skipped = await touch({ ci_state: 'failed', head_sha: '7'.repeat(40) });
      assert.deepEqual([skipped.returned, skipped.notified], [true, []], column);
      await admin.query(`update public.clued_agent_bindings set ${column}=$2 where id=$1`, [d.holder_binding_id, restore]);
      d = committed(await renew('codex', await view(d), { trigger_refs: [SLOT] })).claim;
    }
    assert.equal((await notices()).length, 2);
    // The account switch is preserved for these internal messages too.
    const settingsReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,context_key,operation,object_type,object_id,metadata)
      values($1,'global','fixture','fixture','switch','{}') returning id`, [userId])).rows[0].id;
    await admin.query(`insert into clued_private.agent_message_settings_v1(user_id,enabled,version,updated_at,receipt_id)
      values($1,false,1,clock_timestamp(),$2)`, [userId, settingsReceipt]);
    assert.deepEqual((await touch({ ci_state: 'failed', head_sha: '6'.repeat(40) })).notified, []);
    await admin.query('delete from clued_private.agent_message_settings_v1 where user_id=$1', [userId]);
    // Exempt notices do not spend the normal sender's hourly limit.
    await admin.query(`insert into clued_private.agent_messages_v1(user_id,context_key,thread_id,kind,
      sender_binding_id,to_binding_id,subject,body,idempotency_key,request_hash,expires_at,rate_limit_exempt)
      select user_id,context_key,message_id,'info',sender_binding_id,to_binding_id,'synthetic notice','fixture',
        'synthetic-notice:'||g,request_hash,expires_at,true from clued_private.agent_messages_v1
      cross join generate_series(1,120) g where message_id=$1`, [notice.message_id]);
    committed(await agent('ci', 'clued_agent_message_send_v1', { scope: 'global', kind: 'info',
      to: { binding_id: d.holder_binding_id }, subject: 'ordinary coordination', body: 'still within budget', idempotency_key: uuid() }));

    // --- An entry whose slot lapsed stays out when the head behind it leaves: no revival. ---
    let q1 = await claim('claude', 'Q1', { trigger_refs: [SLOT], holder_session_ref: 'queue-1' });
    let q2 = await claim('codex', 'Q2', { trigger_refs: [SLOT], holder_session_ref: 'queue-2' });
    let q3 = await claim('codex', 'Q3', { trigger_refs: [SLOT], holder_session_ref: 'queue-3' });
    assert.deepEqual([q1, q2, q3].map((x) => queue(x).state), ['head', 'waiting', 'waiting']);
    await age(46);
    [q1, q2, q3] = [await view(q1), await view(q2), await view(q3)];
    assert.deepEqual([q1, q2, q3].map((x) => queue(x).state), ['lapsed', 'head', 'waiting']);
    assert.deepEqual(queue(q3).ahead.map((row) => row.claim_id), [q2.claim_id], 'a lapsed entry is not ahead of anyone');
    q2 = committed(await renew('codex', q2, { trigger_refs: [] })).claim;
    [q1, q3] = [await view(q1), await view(q3)];
    assert.deepEqual([queue(q1).state, q1.merge_slot_until, queue(q3).state], ['out', null, 'head']);
    await assertEnds(q3.merge_slot_until, 45, 'Q3 starts when Q2 left');
    // The entry that was out joins again at the back; a released head hands over too.
    q1 = committed(await renew('claude', q1)).claim;
    assert.deepEqual([queue(q1).state, queue(q1).position], ['waiting', 2]);
    committed(await agent('codex', 'clued_work_release_v1',
      { scope: 'global', claim_id: q3.claim_id, fence: q3.fence, outcome: 'completed' }));
    q1 = await view(q1);
    assert.deepEqual([queue(q1).state, queue(q1).position, queue(q1).length], ['head', 1, 1]);
    await assertEnds(q1.merge_slot_until, 45, 'Q1 starts when Q3 released');
    q1 = committed(await renew('claude', q1, { trigger_refs: [] })).claim;
    // The leaving is recorded per account and merge ref, out of reach of the API roles.
    const left = (await admin.query(`select merge_ref,left_claim_id from clued_private.work_claim_merge_queue_v1
      where user_id=$1`, [userId])).rows;
    assert.equal(left.find((row) => row.merge_ref === SLOT).left_claim_id, q1.claim_id);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await admin.query(`select has_table_privilege($1,'clued_private.work_claim_merge_queue_v1','select') v`,
        [role])).rows[0].v, false, role);
    }

    // --- A lapsed entry whose lease ended before its turn leaves without moving the head's start (review BLOCKER-1). ---
    let l1 = await claim('claude', 'L1', { trigger_refs: [SLOT], holder_session_ref: 'lease-1' });
    const l2 = await claim('codex', 'L2', { trigger_refs: [SLOT], holder_session_ref: 'lease-2' });
    let l3 = await claim('codex', 'L3', { trigger_refs: [SLOT], holder_session_ref: 'lease-3' });
    await age(46);
    await admin.query(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '60 minutes',expires_at=clock_timestamp()-interval '50 minutes'
      where claim_id=$1`, [l2.claim_id]);
    await admin.query(`update clued_private.work_claims_v1 set status='EXPIRED' where claim_id=$1`, [l2.claim_id]);
    [l1, l3] = [await view(l1), await view(l3)];
    assert.deepEqual([queue(l1).state, queue(l3).state], ['out', 'head']);
    await assertEnds(l3.merge_slot_until, 44, `L3 keeps the start it got when L2's turn came: ${l3.merge_slot_until}`);
    l1 = committed(await renew('claude', l1, { trigger_refs: [] })).claim;
    l3 = committed(await renew('codex', l3, { trigger_refs: [] })).claim;

    // --- Changing the merge refs joins again at the back: no jumping the line (review MAJOR-2). ---
    let x = await claim('claude', 'X', { trigger_refs: ['merge:tdoljyj/cross-memory-system:release'], holder_session_ref: 'switch-x' });
    let h = await claim('codex', 'H', { trigger_refs: [SLOT], holder_session_ref: 'switch-h' });
    x = committed(await renew('claude', x, { trigger_refs: [SLOT] })).claim;
    assert.deepEqual([queue(x).state, queue(x).ahead.map((row) => row.claim_id), x.merge_slot_until],
      ['waiting', [h.claim_id], null]);
    assert.equal(queue(await view(h)).state, 'head');
    // A change of letter case only is the same ref: the head stays head (review MINOR-3).
    h = committed(await renew('codex', h, { trigger_refs: ['merge:TDOLJYJ/cross-memory-system:main'] })).claim;
    assert.deepEqual([queue(h).state, queue(h).position, queue(h).length], ['head', 1, 2]);
    x = committed(await renew('claude', x, { trigger_refs: [] })).claim;
    h = committed(await renew('codex', h, { trigger_refs: [] })).claim;

    // Once the Owner marks the CI admission Binding, only it may report or list.
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
      values($1,'global','binding_role_set','binding','fixture','{}'::jsonb) returning id`, [userId])).rows[0].id;
    // By name: the stored token_hash is a verifier since 20261008210000 (P0-4), not the token's hash.
    const ciBinding = (await admin.query(`select id from public.clued_agent_bindings where user_id=$1 and agent_name='ci connection'`, [userId])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',now(),$3)`, [userId, ciBinding, roleReceipt]);
    assert.deepEqual(await agent('claude', 'clued_work_merge_slot_touch_v1',
      { scope: 'global', pr_ref: PR, head_sha: HEAD, ci_state: 'failed' }),
    { status: 'ok', touched: false, reason: 'admission_binding_required' });
    assert.deepEqual(await agent('claude', 'clued_work_merge_slot_holders_v1',
      { scope: 'global', repository: 'tdoljyj/cross-memory-system' }),
    { status: 'ok', holders: [], reason: 'admission_binding_required' });
    assert.equal((await holders()).status, 'ok');
    for (const fn of ['clued_work_merge_slot_touch_v1(text,jsonb)', 'clued_work_merge_slot_holders_v1(text,jsonb)']) {
      assert.deepEqual([await admin.query(`select has_function_privilege('anon','public.${fn}'::regprocedure,'execute') v`),
        await admin.query(`select has_function_privilege('authenticated','public.${fn}'::regprocedure,'execute') v`)]
        .map((result) => result.rows[0].v), [true, false], fn);
    }

    // --- Grants: the return RPC to anon (the admission door) only; helpers to nobody. ---
    const can = async (role, signature) => (await admin.query(
      `select has_function_privilege($1,$2::regprocedure,'execute') v`, [role, signature])).rows[0].v;
    assert.deepEqual([await can('anon', 'public.clued_work_merge_slot_return_v1(text,jsonb)'),
      await can('authenticated', 'public.clued_work_merge_slot_return_v1(text,jsonb)'),
      await can('service_role', 'public.clued_work_merge_slot_return_v1(text,jsonb)')], [true, false, false]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of ['work_claim_merge_refs_v1', 'work_claim_merge_slot_until_v1', 'work_claim_merge_slot_live_v1',
        'work_claim_merge_slot_stamp_v1', 'work_claim_merge_slot_return_core_v1', 'work_claim_merge_slot_until_from_v1',
        'work_claim_merge_queue_v1', 'work_claim_merge_queue_view_v1', 'work_claim_merge_slot_ci_view_v1', 'work_claim_ci_notice_v1']) {
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
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
