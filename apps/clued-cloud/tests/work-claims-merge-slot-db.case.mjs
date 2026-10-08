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
// it, and is returned when its pull request is merged or closed. Merge
// Admission step 3 (migration 20261008100000, Task 3576d10d): CI reports keep
// it (running 45 minutes, green 30), a CI failure returns it, a hard cap ends
// it, and the admission mode goes into the verify Receipts. Imported by
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
    const sibling = rejected(await renew('claude', c2, { trigger_refs: ['task:race', SLOT] }), 'work_claim_conflict');
    assert.deepEqual(sibling.conflicts.map((row) => [row.claim_id, row.overlap.same_task, row.overlap.paths, row.overlap.trigger_refs]),
      [[c1.claim_id, false, [], [SLOT]]], 'only the live slot conflicts between copies');
    c2 = committed(await renew('claude', c2)).claim;
    c1 = committed(await renew('claude', c1)).claim;
    assert.ok(c1.merge_slot_until, 'the holder copy refreshes its slot');
    // A copy issued while a sibling holds the slot waits for it.
    rejected(await agent('claude', 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), task_id: raceTask,
      write_set: ['merge-slot/race/**'], trigger_refs: [SLOT], holder_session_ref: 'race-3' }), 'work_claim_conflict');

    // --- The return drops only the pull request's own repository's slots. ---
    c1 = committed(await renew('claude', c1, { trigger_refs: ['task:race', SLOT, 'merge:other/repo:main'] })).claim;
    const boundC1 = await agent('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: c1.claim_id,
      head_sha: 'e'.repeat(40), base_sha: 'b'.repeat(40), pr_ref: 'tdoljyj/Cross-Memory-System#9' });
    assert.equal(boundC1.verdict, 'ADMITTED', JSON.stringify(boundC1));
    assert.deepEqual((await agent('ci', 'clued_work_merge_slot_return_v1',
      { scope: 'global', pr_ref: 'tdoljyj/Cross-Memory-System#9' })).merge_slot_returned, [c1.claim_id]);
    assert.deepEqual((await view(c1)).trigger_refs, ['merge:other/repo:main', 'task:race']);

    // --- Merge Admission step 3 (migration 20261008100000): the slot follows CI. ---
    assert.equal((await admin.query('select clued_private.work_claim_profile_v1() v')).rows[0].v.merge_slot_green_seconds, 1800);
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

    // running keeps the slot 45 minutes after the report, whatever the renewal clock says.
    await setSlot(d, 'merge_slot_at', 40);
    assert.ok(minutesLeft((await view(d)).merge_slot_until) < 6, 'the renewal clock alone has 5 minutes left');
    const running = await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    assert.deepEqual([running.status, running.touched, running.claims], ['ok', true, [d.claim_id]], JSON.stringify(running));
    d = await view(d);
    assert.ok(minutesLeft(d.merge_slot_until) > 44 && minutesLeft(d.merge_slot_until) <= 45, d.merge_slot_until);
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
    assert.ok(minutesLeft(d.merge_slot_until) > 29 && minutesLeft(d.merge_slot_until) <= 30, d.merge_slot_until);
    d = committed(await renew('codex', d)).claim;
    assert.ok(minutesLeft(d.merge_slot_until) > 44, 'the renewal clock is later now');
    assert.equal(d.merge_slot_ci.ci_state, 'green', 'a renewal of a live slot keeps its CI state');
    assert.deepEqual((await receipts(d, 'work_claim_merge_slot_touch')).map((m) => [m.ci_state, m.previous_ci_state]),
      [['running', null], ['green', 'running']]);

    // The hard cap ends the slot whatever the clocks say, and a report cannot revive it.
    await setSlot(d, 'merge_slot_taken_at', 110);
    await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    d = await view(d);
    assert.ok(minutesLeft(d.merge_slot_until) > 9 && minutesLeft(d.merge_slot_until) <= 10, d.merge_slot_until);
    await setSlot(d, 'merge_slot_taken_at', 121);
    d = await view(d);
    assert.equal(d.merge_slot_until, null, 'past the hard cap the slot has lapsed');
    assert.deepEqual((await holders()).holders, []);
    const late = await touch({ ci_state: 'running', hard_cap_minutes: 120 });
    assert.deepEqual([late.touched, late.reason], [false, 'no_live_slot_for_pr']);
    assert.equal((await view(d)).merge_slot_until, null);
    // Someone else may take it now; the old holder may take it again only while it is free, as a new slot.
    let e = await claim('claude', 'E: waits for the slot');
    e = committed(await renew('claude', e, { trigger_refs: [SLOT] })).claim;
    assert.ok(e.merge_slot_until, 'E takes the slot D lost to the hard cap');
    rejected(await renew('codex', d), 'work_claim_conflict');
    e = committed(await renew('claude', e, { trigger_refs: [] })).claim;
    d = committed(await renew('codex', await view(d))).claim;
    assert.ok(minutesLeft(d.merge_slot_until) > 44);
    assert.deepEqual([d.merge_slot_ci.ci_state, d.merge_slot_ci.hard_cap_until], [null, null], 'taken again: a new slot');
    assert.ok(Date.now() - Date.parse(d.merge_slot_ci.taken_at) < 60000);
    // Another pull request's report does nothing to it.
    assert.equal((await touch({ pr_ref: 'tdoljyj/cross-memory-system#21', ci_state: 'running', hard_cap_minutes: 90 })).touched, false);
    assert.equal((await touch({ pr_ref: 'tdoljyj/cross-memory-system#21', ci_state: 'failed' })).returned, false);
    assert.ok((await view(d)).merge_slot_until);

    // failed returns the slot at once, with its Receipt.
    const failed = await touch({ ci_state: 'failed' });
    assert.deepEqual([failed.returned, failed.merge_slot_returned], [true, [d.claim_id]]);
    d = await view(d);
    assert.deepEqual([d.merge_slot_until, d.merge_slot_ci, d.trigger_refs], [null, null, []]);
    const failure = (await receipts(d, 'work_claim_merge_slot_return')).at(-1);
    assert.deepEqual([failure.receipt_kind, failure.why, failure.ref.head_sha, failure.merge_refs],
      ['WORK_CLAIM_MERGE_SLOT_RETURNED', 'ci_failed', HEAD, [SLOT]]);
    assert.equal((await touch({ ci_state: 'failed', hard_cap_minutes: 120 })).returned, false, 'nothing more to return');
    await assert.rejects(() => touch({ ci_state: 'failed', hard_cap_minutes: 200 }), /work_claim_merge_slot_hard_cap_invalid/);

    // Once the Owner marks the CI admission Binding, only it may report or list.
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
      values($1,'global','binding_role_set','binding','fixture','{}'::jsonb) returning id`, [userId])).rows[0].id;
    const ciBinding = (await admin.query('select id from public.clued_agent_bindings where token_hash=$1', [tokens.ci])).rows[0].id;
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
