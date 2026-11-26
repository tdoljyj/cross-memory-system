import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Merge train step 2a, server side (migration 20261031060000, Task a3701d3d;
// DESIGN.md §41.4–41.5 and the Owner's 2026-10-31 rulings): the Owner-only
// ordering switch (fifo by default, today's queue unchanged), the recorded
// front that no later join or priority displaces, priority order behind it by
// the Task's stored automatic priority, the queued-claim keepalive action on
// the CI command door, and merge-slot calls for resident-node Bindings only.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const REPO = 'tdoljyj/cross-memory-system';
const SLOT = `merge:${REPO}:main`;
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, extra = {}) =>
  ({ sub, role: 'authenticated', session_id: 'sess-owner', aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }], ...extra });


test('merge train queue: Owner switch, recorded front, priority order, keepalive and resident-node calls',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-merge-train-queue-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
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
    const plainUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'merge-train@example.invalid',now()),($2,'merge-train-fifo@example.invalid',now())`, [userId, plainUser]);
    const tokens = {};
    const ids = {};
    for (const [name, owner] of [['a1', userId], ['a2', userId], ['a3', userId], ['a4', userId],
      ['node', userId], ['envci', userId], ['p1', plainUser], ['p2', plainUser]]) {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`,
      [owner, `${name} connection`, tokens[name]])).rows[0].id;
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
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const rejected = (result, code) => {
      assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result));
      return result;
    };
    const tasks = new Map();
    // priority: the Task's automatic priority before the claim joins (null: no projection row).
    const claim = async (who, title, extra = {}, priority) => {
      const task = committed(await agent(who, 'clued_record_mutate', {
        operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
        scope: 'global', idempotency_key: uuid(), authority: 'observed',
        confidence_reason: 'merge train fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
      })).target_refs[0].id;
      if (priority === null) await admin.query('delete from clued_private.mtpe_intake_projection where record_id=$1', [task]);
      else if (priority !== undefined) assert.equal((await admin.query(`update clued_private.mtpe_intake_projection
        set algorithm_priority=$2 where record_id=$1`, [task, priority])).rowCount, 1, `a projection row for ${title}`);
      const c = committed(await agent(who, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), task_id: task,
        write_set: [`merge-train/${uuid()}`], holder_label: title, holder_session_ref: `session-${title}`,
        trigger_refs: [SLOT], ...extra })).claim;
      tasks.set(title, task);
      return c;
    };
    const renew = async (who, c, extra = {}) => committed(await agent(who, 'clued_work_renew_v1', { scope: 'global',
      claim_id: c.claim_id, fence: c.fence, lease_version: c.lease_version, progress_ref: uuid(), ...extra })).claim;
    const view = async (c) => (await agent('a1', 'clued_work_verify_v1', { scope: 'global', claim_id: c.claim_id })).claim;
    const queueOf = async (user = userId) =>
      (await admin.query('select clued_private.work_claim_merge_queue_current_v1($1,$2) v', [user, SLOT])).rows[0].v;
    const fifoQueue = async (user) =>
      (await admin.query('select clued_private.work_claim_merge_queue_v1($1,$2) v', [user, SLOT])).rows[0].v;
    const order = (queue) => queue.entries.filter((e) => ['head', 'waiting'].includes(e.state))
      .sort((x, y) => x.position - y.position).map((e) => e.claim_id);
    const front = async (user = userId, ref = SLOT) => (await admin.query(
      'select claim_id,since from clued_private.work_claim_merge_front_v1 where user_id=$1 and merge_ref=$2', [user, ref])).rows[0];
    const setPriority = async (title, value) => {
      const result = await admin.query(`update clued_private.mtpe_intake_projection set algorithm_priority=$2
        where record_id=$1`, [tasks.get(title), value]);
      assert.equal(result.rowCount, 1, `a projection row for ${title}`);
    };
    // Moves every queue time of the account back, as if the minutes had passed
    // (leases stay). Triggers are off while the clocks move, so nothing records midway.
    const shift = async (minutes, user = userId) => {
      await admin.query('begin');
      await admin.query("set local session_replication_role='replica'");
      await admin.query(`update clued_private.work_claims_v1 set
        merge_slot_at=merge_slot_at-make_interval(mins=>$2),merge_queued_at=merge_queued_at-make_interval(mins=>$2),
        merge_slot_taken_at=merge_slot_taken_at-make_interval(mins=>$2),merge_slot_ci_at=merge_slot_ci_at-make_interval(mins=>$2)
        where user_id=$1`, [user, minutes]);
      await admin.query(`update clued_private.work_claim_merge_queue_v1 set head_left_at=head_left_at-make_interval(mins=>$2),
        left_queued_at=left_queued_at-make_interval(mins=>$2) where user_id=$1`, [user, minutes]);
      await admin.query(`update clued_private.work_claim_merge_front_v1 set queued_at=queued_at-make_interval(mins=>$2),
        since=since-make_interval(mins=>$2),left_at=left_at-make_interval(mins=>$2) where user_id=$1`, [user, minutes]);
      await admin.query(`update clued_private.work_claim_merge_departed_v1 set queued_at=queued_at-make_interval(mins=>$2),
        left_at=left_at-make_interval(mins=>$2) where user_id=$1`, [user, minutes]);
      await admin.query(`update clued_private.work_claim_merge_rank_v1 set queued_at=queued_at-make_interval(mins=>$2)
        where user_id=$1`, [user, minutes]);
      await admin.query('commit');
    };
    const turn = (ordering, base_version, claims) => native('clued_merge_queue_ordering_set_v1', { ordering, base_version }, claims);
    const page = (claims) => native('clued_merge_queue_v1', {}, claims);
    const switchReceipts = async () => (await admin.query(`select version,metadata from public.clued_audit_receipts
      where operation='merge_queue_ordering_set' and user_id=$1 order by version`, [userId])).rows;

    // --- Nobody but the definer reaches the tables or helpers; the two Owner RPCs go to authenticated only. ---
    for (const client of [anon, human, workerCaller]) {
      await assert.rejects(() => client.query('select * from clued_private.merge_queue_settings_v1'), /permission denied/);
      await assert.rejects(() => client.query('select * from clued_private.work_claim_merge_front_v1'), /permission denied/);
    }
    const can = async (role, signature) => (await admin.query(
      `select has_function_privilege($1,$2::regprocedure,'execute') v`, [role, signature])).rows[0].v;
    for (const fn of ['public.clued_merge_queue_v1(jsonb)', 'public.clued_merge_queue_ordering_set_v1(jsonb)']) {
      assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn),
        await can('clued_worker_gateway', fn)], [false, true, false, false], fn);
    }
    for (const fn of ['work_claim_merge_queue_v2', 'work_claim_merge_queue_current_v1', 'work_claim_merge_front_sync_v1',
      'work_claim_merge_front_start_v1', 'work_claim_merge_queue_keepalive_v1', 'merge_slot_admits_v1', 'merge_queue_rank_v1',
      'merge_queue_ordering_v1', 'merge_queue_recorded_v1', 'merge_queue_setting_view_v1']) {
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        const allowed = (await admin.query(`select bool_or(has_function_privilege($1,p.oid,'execute')) v from pg_proc p
          where p.pronamespace='clued_private'::regnamespace and p.proname=$2`, [role, fn])).rows[0].v;
        assert.equal(allowed, false, `${role} can execute ${fn}`);
      }
    }
    // The CI8 anon surface and the 80 Worker overloads are unchanged.
    await assertGatewayCloseoutBoundary(admin);

    // --- An account that never turns the switch keeps today's queue: nothing is recorded. ---
    const p1 = await claim('p1', 'P1');
    const p2 = await claim('p2', 'P2');
    const p3 = await claim('p1', 'P3');
    assert.deepEqual(await queueOf(plainUser), await fifoQueue(plainUser));
    assert.deepEqual(order(await queueOf(plainUser)), [p1.claim_id, p2.claim_id, p3.claim_id]);
    await shift(46, plainUser);
    assert.deepEqual(await queueOf(plainUser), await fifoQueue(plainUser));
    assert.equal((await queueOf(plainUser)).head.claim_id, p2.claim_id, 'P1 lapsed, P2 is head as today');
    await renew('p2', p2, { trigger_refs: [] });
    assert.deepEqual(await queueOf(plainUser), await fifoQueue(plainUser));
    assert.equal((await queueOf(plainUser)).head.claim_id, p3.claim_id);
    assert.equal((await admin.query(`select (select count(*) from clued_private.work_claim_merge_front_v1 where user_id=$1)
      +(select count(*) from clued_private.work_claim_merge_departed_v1 where user_id=$1) n`, [plainUser])).rows[0].n, '0');
    assert.deepEqual(await page(fresh(plainUser)).then((p) => p.setting),
      { ordering: 'fifo', version: 0, default: true, updated_at: null, receipt_id: null });

    // --- Only the Owner, signed in directly with a session, turns the switch. ---
    const a = await claim('a1', 'A');
    const b = await claim('a2', 'B');
    const c = await claim('a3', 'C');
    await setPriority('A', 10); await setPriority('B', 20); await setPriority('C', 50);
    assert.deepEqual(order(await queueOf()), [a.claim_id, b.claim_id, c.claim_id], 'fifo by default');
    await assert.rejects(() => anon.query('select public.clued_merge_queue_ordering_set_v1($1)', [{ ordering: 'priority', base_version: 0 }]),
      /permission denied/);
    await assert.rejects(() => workerCaller.query('select public.clued_merge_queue_ordering_set_v1($1)', [{ ordering: 'priority', base_version: 0 }]),
      /permission denied/, 'no Binding reaches the switch through the Worker');
    await assert.rejects(() => turn('priority', 0, fresh(userId, { client_id: 'oauth-client' })), /direct_human_session_required/,
      'a delegated (OAuth or MCP) login cannot turn it');
    await assert.rejects(() => page(fresh(userId, { client_id: 'oauth-client' })), /direct_human_session_required/);
    await assert.rejects(() => turn('priority', 0, { role: 'authenticated' }), /direct_human_session_required/);
    const noSession = fresh(userId); delete noSession.session_id;
    await assert.rejects(() => turn('priority', 0, noSession), /merge_queue_setting_session_required/);
    for (const input of [{ ordering: 'rank', base_version: 0 }, { ordering: 'priority' }, { ordering: 'priority', base_version: -1 },
      { ordering: 'priority', base_version: 0, extra: 1 }, { ordering: true, base_version: 0 }, []]) {
      await assert.rejects(() => native('clued_merge_queue_ordering_set_v1', input), /merge_queue_setting_input_invalid/, JSON.stringify(input));
    }
    await assert.rejects(() => native('clued_merge_queue_v1', { x: 1 }), /merge_queue_input_invalid/);
    const same = committed(await turn('fifo', 0));
    assert.deepEqual([same.changed, same.ordering, same.version, same.default], [false, 'fifo', 0, true], 'fifo is already in force');
    assert.deepEqual(await switchReceipts(), [], 'refused attempts and no-change leave no receipt');
    assert.equal(await front(), undefined);

    // --- Turning priority on records today's head, with today's start, as the front. ---
    const before = await fifoQueue(userId);
    const on = committed(await turn('priority', 0));
    assert.deepEqual([on.changed, on.ordering, on.version, on.default], [true, 'priority', 1, false]);
    let receipts = await switchReceipts();
    assert.deepEqual(receipts.map((r) => [Number(r.version), r.metadata.receipt_kind, r.metadata.session_id, r.metadata.principal]),
      [[1, 'MERGE_QUEUE_ORDERING_PRIORITY', 'sess-owner', 'native_account_session']]);
    let recorded = await front();
    assert.equal(recorded.claim_id, a.claim_id);
    assert.equal(recorded.since.toISOString(), new Date(before.head.since).toISOString());
    let queue = await queueOf();
    assert.deepEqual(queue.head, before.head, 'the head and its slot are exactly as before');
    assert.deepEqual(order(queue), [a.claim_id, c.claim_id, b.claim_id], 'behind the front: by automatic priority');
    // A stale page and a repeat change nothing.
    const stale = rejected(await turn('fifo', 0), 'merge_queue_setting_version_conflict');
    assert.deepEqual([stale.current.ordering, stale.current.version], ['priority', 1]);
    assert.equal(committed(await turn('priority', 1)).changed, false);
    assert.equal((await switchReceipts()).length, 1);

    // --- A higher priority that joins later never displaces the front. ---
    const d = await claim('a4', 'D', {}, 99);
    queue = await queueOf();
    assert.deepEqual(order(queue), [a.claim_id, d.claim_id, c.claim_id, b.claim_id]);
    assert.equal((await view(a)).merge_queue[0].state, 'head');
    assert.deepEqual([(await view(d)).merge_queue[0].state, (await view(d)).merge_queue[0].position], ['waiting', 2]);
    // A priority change moves an entry at the next write, not before.
    await setPriority('A', 0); await setPriority('B', 100);
    assert.deepEqual(order(await queueOf()), [a.claim_id, d.claim_id, c.claim_id, b.claim_id], 'reads do not move');
    let shown = await page();
    assert.deepEqual(shown.setting.ordering, 'priority');
    assert.deepEqual(shown.queues.map((q) => q.ref), [SLOT]);
    assert.deepEqual(shown.queues[0].entries.map((x) => [x.claim_id, x.state, x.position, x.auto_priority, x.task_title, x.front_recorded]),
      [[a.claim_id, 'head', 1, 10, 'A', true], [d.claim_id, 'waiting', 2, 99, 'D', false],
        [c.claim_id, 'waiting', 3, 50, 'C', false], [b.claim_id, 'waiting', 4, 20, 'B', false]]);
    assert.equal(shown.queues[0].entries[0].task_id, tasks.get('A'));
    const queuedAt = async (x) => (await admin.query('select merge_queued_at from clued_private.work_claims_v1 where claim_id=$1',
      [x.claim_id])).rows[0].merge_queued_at.getTime();
    const bQueued = await queuedAt(b);
    await renew('a2', await view(b)); // any write to the queue
    assert.equal(await queuedAt(b), bQueued, 'a waiting entry renewing keeps its place');
    assert.deepEqual(order(await queueOf()), [a.claim_id, b.claim_id, d.claim_id, c.claim_id], 'B (now 100) moved up; A stays front');
    shown = await page();
    assert.deepEqual(shown.queues[0].entries.map((x) => [x.claim_id, x.auto_priority]),
      [[a.claim_id, 10], [b.claim_id, 100], [d.claim_id, 99], [c.claim_id, 50]]);

    // --- When the front leaves, the next head is chosen by priority and recorded in the same write. ---
    await renew('a1', a, { trigger_refs: [] });
    recorded = await front();
    assert.equal(recorded.claim_id, b.claim_id, 'B (100) follows A at once');
    queue = await queueOf();
    assert.deepEqual(order(queue), [b.claim_id, d.claim_id, c.claim_id]);
    assert.ok(Date.parse(queue.head.until) - Date.now() > 44 * 60000, 'B starts when A left');

    // --- Ties and missing priorities fall back to join order; a late projection row counts from the next write. ---
    const e = await claim('a1', 'E', {}, 20);
    const f = await claim('a2', 'F', {}, 20);
    const m = await claim('a3', 'M', {}, null);
    queue = await queueOf();
    assert.deepEqual(order(queue), [b.claim_id, d.claim_id, c.claim_id, e.claim_id, f.claim_id, m.claim_id],
      'E and F tie at 20 and go by join order; M without a priority waits behind them');
    await admin.query('select clued_private.mtpe_sync_record($1)', [tasks.get('M')]);
    await setPriority('M', 60);
    assert.deepEqual(order(await queueOf()), [b.claim_id, d.claim_id, c.claim_id, e.claim_id, f.claim_id, m.claim_id], 'not before a write');
    await renew('a3', await view(m));
    assert.deepEqual(order(await queueOf()), [b.claim_id, d.claim_id, m.claim_id, c.claim_id, e.claim_id, f.claim_id]);

    // --- The front lapses with no write: readers already see the next head, and an
    // MTPE change before the next write does not change it. ---
    await shift(46);
    queue = await queueOf();
    assert.equal(queue.head.claim_id, d.claim_id, 'B lapsed; D is next by priority');
    assert.equal(queue.entries.find((x) => x.claim_id === b.claim_id).state, 'lapsed');
    assert.equal((await front()).claim_id, b.claim_id, 'nothing is written by reading');
    await setPriority('E', 100); await setPriority('F', 100);
    assert.equal((await queueOf()).head.claim_id, d.claim_id);
    assert.equal((await agent('node', 'clued_work_merge_slot_holders_v1', { scope: 'global', repository: REPO })).holders
      .map((h) => h.claim_id).join(), d.claim_id, 'holders shows the same head');
    assert.equal((await view(d)).merge_queue[0].state, 'head');
    assert.equal((await front()).claim_id, b.claim_id, 'holders only reads');
    // The next write records exactly what readers saw, then E and F move up; G (100) joins behind them.
    const g = await claim('a3', 'G', {}, 100);
    assert.equal((await front()).claim_id, d.claim_id);
    assert.equal((await queueOf()).entries.find((x) => x.claim_id === b.claim_id).state, 'out', 'a lapsed front stays out');
    assert.deepEqual(order(await queueOf()), [d.claim_id, e.claim_id, f.claim_id, g.claim_id, m.claim_id, c.claim_id]);
    // A renewal follows this queue: a waiting entry keeps its place, an entry that
    // has left joins again at the back.
    const cQueued = await queuedAt(c);
    await renew('a3', await view(c));
    assert.equal(await queuedAt(c), cQueued, 'C keeps its place');
    const bLeft = await queuedAt(b);
    await renew('a2', await view(b));
    assert.ok(await queuedAt(b) > bLeft, 'B, which left, joins again');
    assert.deepEqual(order(await queueOf()), [d.claim_id, e.claim_id, f.claim_id, g.claim_id, b.claim_id, m.claim_id, c.claim_id]);
    assert.equal((await front()).claim_id, d.claim_id);

    // --- Back to fifo: the front stays; behind it, join order. ---
    const back = committed(await turn('fifo', 1));
    assert.deepEqual([back.changed, back.ordering, back.version], [true, 'fifo', 2]);
    assert.deepEqual(order(await queueOf()), [d.claim_id, c.claim_id, e.claim_id, f.claim_id, m.claim_id, g.claim_id, b.claim_id]);
    receipts = await switchReceipts();
    assert.deepEqual(receipts.map((r) => [Number(r.version), r.metadata.receipt_kind]),
      [[1, 'MERGE_QUEUE_ORDERING_PRIORITY'], [2, 'MERGE_QUEUE_ORDERING_FIFO']]);
    committed(await turn('priority', 2));
    assert.deepEqual(order(await queueOf()), [d.claim_id, e.claim_id, f.claim_id, g.claim_id, b.claim_id, m.claim_id, c.claim_id]);
    // Each change told the merge measurement journal; FIFO markers stop for this account.
    const policies = (await admin.query(`select payload from clued_private.merge_measurement_events_v1
      where user_id=$1 and kind='policy' and object_key='merge-train-v1' order by sequence`, [userId])).rows;
    assert.deepEqual(policies.map((r) => r.payload.ordering), ['priority', 'fifo', 'priority']);
    assert.ok(policies.every((r) => r.payload.profile && r.payload.front_recorded === true));
    const markers = async () => (await admin.query('select merge_ref from clued_private.work_claim_merge_queue_v1 where user_id=$1', [userId])).rows;
    const markerBefore = await markers();
    await admin.query(`insert into clued_private.work_claim_merge_queue_v1(user_id,merge_ref,head_left_at,left_queued_at,left_claim_id)
      values($1,'merge:owner/other:main',now(),now(),$2)`, [userId, uuid()]);
    assert.deepEqual(await markers(), markerBefore, 'no FIFO marker is written once the front is recorded');

    // --- Merge-slot calls: resident-node Bindings only (and the earlier open behaviour without any mark). ---
    await admin.query(`update clued_private.work_claims_v1 set bound_pr=$2 where claim_id=$1`, [d.claim_id, `${REPO}#1`]);
    const touchInput = { scope: 'global', pr_ref: `${REPO}#1`, head_sha: 'a'.repeat(40), ci_state: 'running', hard_cap_minutes: 120 };
    assert.equal((await agent('envci', 'clued_work_merge_slot_touch_v1', touchInput)).touched, true,
      'before any ci-admission mark every Binding keeps the earlier behaviour');
    const roleReceipt = async () => (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
      values($1,'global','binding_role_set','binding','fixture','{}'::jsonb) returning id`, [userId])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values($1,$2,'ci-admission',now()-interval '10 minutes',$3,now()-interval '5 minutes','resident-node')`, [userId, ids.node, await roleReceipt()]);
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values($1,$2,'ci-admission',now()-interval '10 minutes',$3,now()-interval '5 minutes','other')`, [userId, ids.envci, await roleReceipt()]);
    assert.deepEqual(await agent('envci', 'clued_work_merge_slot_touch_v1', touchInput),
      { status: 'ok', touched: false, reason: 'admission_binding_required' });
    assert.deepEqual(await agent('envci', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: `${REPO}#1`, merge_sha: 'b'.repeat(40) }),
      { status: 'ok', adopted: false, reason: 'admission_binding_required' });
    assert.deepEqual(await agent('envci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${REPO}#1` }),
      { status: 'ok', returned: false, reason: 'admission_binding_required' });
    assert.equal((await agent('a2', 'clued_work_merge_slot_touch_v1', touchInput)).reason, 'admission_binding_required');
    const running = await agent('node', 'clued_work_merge_slot_touch_v1', touchInput);
    assert.deepEqual([running.touched, running.claims], [true, [d.claim_id]]);
    // An "other" holder may still list holders (read only) and use the door's other actions.
    assert.equal((await agent('envci', 'clued_work_merge_slot_holders_v1', { scope: 'global', repository: REPO })).holders.length, 1);

    // --- Queued-claim keepalive on the CI command door. ---
    const keep = (who, prs, extra = {}) => agent(who, 'clued_work_verify_v1',
      { action: 'merge_queue_keepalive', scope: 'global', repository: REPO, pr_refs: prs, ...extra });
    const row = async (x) => (await admin.query(`select status,expires_at,hard_deadline_at,lease_version,renewals,fence,
      progress_ref,merge_slot_at,merge_slot_ci_at from clued_private.work_claims_v1 where claim_id=$1`, [x.claim_id])).rows[0];
    const lone = await claim('a4', 'H', { trigger_refs: [] }); // bound to a PR but not in any queue
    await admin.query(`update clued_private.work_claims_v1 set bound_pr=x.pr,expires_at=now()+interval '10 minutes'
      from (values ($1::uuid,'${REPO}#2'),($2::uuid,'${REPO}#3'),($3::uuid,'${REPO}#4'),($4::uuid,'${REPO}#5')) x(id,pr)
      where claim_id=x.id`, [g.claim_id, e.claim_id, f.claim_id, lone.claim_id]);
    // E is close to its hard deadline; F's lease has already run out (an ACTIVE row past expires_at).
    await admin.query(`update clued_private.work_claims_v1 set hard_deadline_at=now()+interval '30 minutes' where claim_id=$1`, [e.claim_id]);
    await admin.query(`update clued_private.work_claims_v1 set issued_at=now()-interval '20 minutes',expires_at=now()-interval '1 minute' where claim_id=$1`, [f.claim_id]);
    const gBefore = await row(g);
    rejected(await keep('envci', [`${REPO}#2`]), 'admission_binding_required');
    rejected(await keep('a1', [`${REPO}#2`]), 'admission_binding_required');
    for (const bad of [{ pr_refs: ['other/repo#2'] }, { pr_refs: 'x' }, { pr_refs: Array.from({ length: 51 }, (_, i) => `${REPO}#${i + 1}`) },
      { repository: 'not a repo' }, { extra: true }]) {
      await assert.rejects(() => keep('node', [`${REPO}#2`], bad), /work_claim_ci_command_invalid/, JSON.stringify(bad));
    }
    assert.deepEqual(await row(g), gBefore, 'refused calls change nothing');
    const kept = await keep('node', [`${REPO}#2`, `${REPO}#3`, `${REPO}#4`, `${REPO}#5`]);
    assert.equal(kept.status, 'ok');
    assert.deepEqual(kept.kept_alive.map((k) => k.claim_id).sort(), [g.claim_id, e.claim_id].sort(),
      'only queued claims with a listed open PR and a live lease');
    const gAfter = await row(g);
    assert.ok(gAfter.expires_at - Date.now() > 119 * 60000, `G's lease runs a full lease from now: ${gAfter.expires_at}`);
    for (const key of ['lease_version', 'renewals', 'fence', 'progress_ref', 'merge_slot_at', 'merge_slot_ci_at', 'hard_deadline_at']) {
      assert.deepEqual(gAfter[key], gBefore[key], key);
    }
    const eAfter = await row(e);
    assert.equal(eAfter.expires_at.getTime(), eAfter.hard_deadline_at.getTime(), 'never past the hard deadline');
    assert.equal((await row(f)).status, 'EXPIRED', 'a lease that already ran out expires first and is not revived');
    assert.ok((await row(lone)).expires_at - Date.now() < 11 * 60000, 'a claim not in the queue is not kept alive');
    const keptReceipts = async () => (await admin.query(`select object_id,metadata from public.clued_audit_receipts
      where operation='work_claim_queue_keepalive' and user_id=$1 order by created_at`, [userId])).rows;
    assert.deepEqual((await keptReceipts()).map((r) => [r.object_id, r.metadata.receipt_kind]).sort(),
      [[g.claim_id, 'WORK_CLAIM_QUEUE_KEPT_ALIVE'], [e.claim_id, 'WORK_CLAIM_QUEUE_KEPT_ALIVE']].sort());
    // Within the hour: the lease moves on, but no second receipt.
    const again = await keep('node', [`${REPO}#2`]);
    assert.deepEqual([again.kept_alive.length, again.kept_alive[0].receipt_id], [1, null]);
    assert.equal((await keptReceipts()).length, 2);
    // A PR that was not listed (closed) is not kept alive.
    await admin.query(`update clued_private.work_claims_v1 set expires_at=now()+interval '10 minutes' where claim_id=$1`, [g.claim_id]);
    assert.deepEqual((await keep('node', [`${REPO}#9`])).kept_alive, []);
    // The keepalive never moved the front.
    assert.equal((await front()).claim_id, d.claim_id);

    // --- A second account: the first flip with entries already out, a claim in two
    // queues, every way a front leaves, and the other role purposes. ---
    const u3 = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'merge-train-3@example.invalid',now())`, [u3]);
    for (const name of ['q1', 'q2', 'q3', 'q4', 'rnode', 'runspec', 'rpark']) {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`,
      [u3, `${name} connection`, tokens[name]])).rows[0].id;
    }
    const S2 = `merge:${REPO}:release`;
    const queue3 = async (ref = SLOT) =>
      (await admin.query('select clued_private.work_claim_merge_queue_current_v1($1,$2) v', [u3, ref])).rows[0].v;
    const view3 = async (x) => (await agent('q1', 'clued_work_verify_v1', { scope: 'global', claim_id: x.claim_id })).claim;
    const x1 = await claim('q1', 'X1', {}, 30);
    const x2 = await claim('q2', 'X2', {}, 30);
    const x3 = await claim('q3', 'X3', {}, 30);
    await shift(46, u3);
    await renew('q2', await view3(x2), { trigger_refs: [] });
    const today = await fifoQueue(u3);
    assert.deepEqual(today.entries.map((x) => [x.claim_id, x.state]), [[x1.claim_id, 'out'], [x3.claim_id, 'head']],
      "today's queue has X1 out behind the marker X2 left");
    committed(await turn('priority', 0, fresh(u3)));
    let q3 = await queue3();
    assert.deepEqual(q3.entries.map((x) => [x.claim_id, x.state]), [[x1.claim_id, 'out'], [x3.claim_id, 'head']]);
    assert.deepEqual(q3.head, today.head, 'the first flip keeps the head and its start');
    assert.equal((await admin.query(`select count(*)::int n from clued_private.work_claim_merge_departed_v1
      where user_id=$1 and claim_id=$2`, [u3, x1.claim_id])).rows[0].n, 1, 'an entry already out stays out');

    // A claim in two queues: waiting in one, front of the other.
    const y = await claim('q4', 'Y', { trigger_refs: [SLOT, S2] }, 10);
    assert.deepEqual((await view3(y)).merge_queue.map((x) => [x.ref, x.state]), [[SLOT, 'waiting'], [S2, 'head']]);
    assert.equal((await front(u3, S2)).claim_id, y.claim_id);
    assert.equal((await front(u3)).claim_id, x3.claim_id);

    // The front leaves by release: the next by priority is recorded in the same write.
    const z1 = await claim('q1', 'Z1', {}, 50);
    const z2 = await claim('q2', 'Z2', {}, 5);
    assert.deepEqual(order(await queue3()), [x3.claim_id, z1.claim_id, y.claim_id, z2.claim_id]);
    const x3v = await view3(x3);
    committed(await agent('q3', 'clued_work_release_v1', { scope: 'global', claim_id: x3.claim_id, fence: x3v.fence, outcome: 'completed' }));
    assert.equal((await front(u3)).claim_id, z1.claim_id);

    // The front and another entry expire in one statement.
    await admin.query(`update clued_private.work_claims_v1 set issued_at=now()-interval '3 hours',expires_at=now()-interval '1 minute'
      where claim_id=any($1)`, [[z1.claim_id, z2.claim_id]]);
    assert.equal((await admin.query('select clued_private.work_claim_expire_due($1) n', [u3])).rows[0].n, 2);
    assert.equal((await front(u3)).claim_id, y.claim_id);
    assert.deepEqual(order(await queue3()), [y.claim_id]);

    // Purposes: resident-node and unspecified rows are admitted, a parking spot is not.
    const receipt3 = async () => (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
      values($1,'global','binding_role_set','binding','fixture','{}'::jsonb) returning id`, [u3])).rows[0].id;
    for (const [name, purpose, effective] of [['rnode', 'resident-node', "now()-interval '5 minutes'"],
      ['runspec', 'unspecified', "now()-interval '5 minutes'"], ['rpark', 'parking', "'infinity'"]]) {
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'ci-admission',now()-interval '10 minutes',$3,${effective},$4)`, [u3, ids[name], await receipt3(), purpose]);
    }

    // The front leaves by adopt (both of its queues).
    await admin.query('update clued_private.work_claims_v1 set bound_pr=$2 where claim_id=$1', [y.claim_id, `${REPO}#21`]);
    const adoptInput = { scope: 'global', pr_ref: `${REPO}#21`, merge_sha: 'c'.repeat(40) };
    assert.deepEqual(await agent('rpark', 'clued_work_claim_adopt_v1', adoptInput),
      { status: 'ok', adopted: false, reason: 'admission_binding_required' }, 'a parking spot is refused');
    assert.deepEqual((await agent('rnode', 'clued_work_claim_adopt_v1', adoptInput)).merge_slot_returned, [y.claim_id]);
    assert.equal((await front(u3)).claim_id, null);
    assert.equal((await front(u3, S2)).claim_id, null);

    // The front leaves by return, reported by an unspecified (pre-purpose) row.
    const w1 = await claim('q1', 'W1', {}, 1);
    const w2 = await claim('q2', 'W2', {}, 2);
    assert.equal((await front(u3)).claim_id, w1.claim_id, 'the first to join an empty queue is recorded as front');
    await admin.query(`update clued_private.work_claims_v1 set bound_pr=x.pr
      from (values ($1::uuid,'${REPO}#22'),($2::uuid,'${REPO}#23')) x(id,pr) where claim_id=x.id`, [w1.claim_id, w2.claim_id]);
    assert.deepEqual(await agent('rpark', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${REPO}#22` }),
      { status: 'ok', returned: false, reason: 'admission_binding_required' });
    assert.deepEqual((await agent('runspec', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${REPO}#22` }))
      .merge_slot_returned, [w1.claim_id]);
    assert.equal((await front(u3)).claim_id, w2.claim_id);
    const touch3 = { scope: 'global', pr_ref: `${REPO}#23`, head_sha: 'd'.repeat(40), ci_state: 'running', hard_cap_minutes: 120 };
    assert.equal((await agent('rpark', 'clued_work_merge_slot_touch_v1', touch3)).reason, 'admission_binding_required');
    assert.deepEqual((await agent('runspec', 'clued_work_merge_slot_touch_v1', touch3)).claims, [w2.claim_id]);
    rejected(await agent('rpark', 'clued_work_verify_v1', { action: 'merge_queue_keepalive', scope: 'global',
      repository: REPO, pr_refs: [`${REPO}#23`] }), 'admission_binding_required');
    assert.equal((await agent('runspec', 'clued_work_verify_v1', { action: 'merge_queue_keepalive', scope: 'global',
      repository: REPO, pr_refs: [`${REPO}#23`] })).status, 'ok');
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
