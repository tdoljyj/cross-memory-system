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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Resident CI assist (migration 20261105120000; Clued Decision "第 12 代‘推送后
// 全自动’设计决定" and Owner Decision 207c0cd0 v3): two actions of the CI command
// door, merge_queue_join and lease_extend, let the CI admission Binding put a
// pull request's claim into merge:<owner>/<repo>:main and extend its lease,
// for a head admitted in the claim's current execution epoch, without moving
// the holder's lease_version, fence, progress_ref, renewals or execution
// epoch. The holder's renewal keeps the CI's merge ref and never shortens a
// longer lease.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const REPO = 'tdoljyj/cross-memory-system';
const SLOT = `merge:${REPO}:main`;
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, extra = {}) =>
  ({ sub, role: 'authenticated', session_id: 'sess-owner', aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }], ...extra });
const HEAD = (c) => c.repeat(40);
const REFUSED = { status: 'rejected', error_code: 'admission_binding_required' };

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('resident CI assist: merge_queue_join and lease_extend on the CI command door', { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-ci-queue-assist-'));
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
    const u2 = uuid();
    const u3 = uuid();
    const u4 = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'ci-assist@example.invalid',now()),
      ($2,'ci-assist-2@example.invalid',now()),($3,'ci-assist-3@example.invalid',now()),($4,'ci-assist-4@example.invalid',now())`,
    [userId, u2, u3, u4]);
    const tokens = {};
    const ids = {};
    for (const [name, owner] of [['h1', userId], ['h2', userId], ['h3', userId], ['h4', userId], ['node', userId],
      ['envci', userId], ['standby', userId], ['revoked', userId], ['h5', userId], ['k1', u2], ['k2', u2], ['knode', u2],
      ['f1', u3], ['f2', u3], ['f3', u3], ['unspec', u3], ['w1', u4], ['wnode', u4]]) {
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

    const native = async (name, input, claims) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const agent = async (who, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const claimAnswer = async (who, title, extra = {}) => {
      const task = committed(await agent(who, 'clued_record_mutate', {
        operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
        scope: 'global', idempotency_key: uuid(), authority: 'observed',
        confidence_reason: 'ci assist fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
      })).target_refs[0].id;
      return committed(await agent(who, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), task_id: task,
        write_set: [`ci-assist/${uuid()}`], holder_label: title, holder_session_ref: `session-${title}`,
        trigger_refs: [`task:${title.toLowerCase()}`], ...extra }));
    };
    const claim = async (who, title, extra = {}) => (await claimAnswer(who, title, extra)).claim;
    const renew = async (who, c, extra = {}) => committed(await agent(who, 'clued_work_renew_v1', { scope: 'global',
      claim_id: c.claim_id, fence: Number(c.fence), lease_version: Number(c.lease_version), progress_ref: uuid(), ...extra })).claim;
    // Binds a claim to a pull request and admits a head for the current execution epoch, as the admission check does.
    const admit = async (who, c, pr, head, branch = 'main') => {
      const result = await agent(who, 'clued_work_verify_v1',
        { scope: 'global', claim_id: c.claim_id, pr_ref: pr, head_sha: head, target_branch: branch });
      assert.equal(result.verdict, 'ADMITTED', JSON.stringify(result));
      return result.claim;
    };
    const door = (who, input) => agent(who, 'clued_work_verify_v1', input);
    const join = (who, pr, head, extra = {}) =>
      door(who, { action: 'merge_queue_join', scope: 'global', pr_ref: pr, head_sha: head, ...extra });
    const extend = (who, pr, head, minutes, extra = {}) =>
      door(who, { action: 'lease_extend', scope: 'global', pr_ref: pr, head_sha: head, minutes, ...extra });
    const row = async (c) => (await admin.query(`select status,expires_at,hard_deadline_at,lease_version,renewals,fence,
      progress_ref,progress_refs,holder_binding_id,holder_session_ref,lease_key_hash,execution_epoch,trigger_refs,
      merge_queued_at,merge_slot_at,merge_slot_ci_at,bound_pr,admitted_heads,task_id,write_set
      from clued_private.work_claims_v1 where claim_id=$1`, [c.claim_id])).rows[0];
    const holderFields = ['fence', 'lease_version', 'renewals', 'progress_ref', 'progress_refs', 'holder_binding_id',
      'holder_session_ref', 'lease_key_hash', 'execution_epoch', 'hard_deadline_at'];
    const assertHolderFieldsKept = (after, before, label) => {
      for (const key of holderFields) assert.deepEqual(after[key], before[key], `${label}: ${key}`);
    };
    const queueOf = async (user = userId, ref = SLOT) =>
      (await admin.query('select clued_private.work_claim_merge_queue_current_v1($1,$2) v', [user, ref])).rows[0].v;
    const order = (queue) => queue.entries.filter((e) => ['head', 'waiting'].includes(e.state))
      .sort((x, y) => x.position - y.position).map((e) => e.claim_id);
    const receipts = async (operation, user = userId) => (await admin.query(`select object_id,binding_id,metadata,created_at
      from public.clued_audit_receipts where operation=$1 and user_id=$2 order by created_at,id`, [operation, user])).rows;
    const ageReceipts = (operation, user = userId) => admin.query(`update public.clued_audit_receipts
      set created_at=created_at-interval '6 minutes' where operation=$1 and user_id=$2`, [operation, user]);
    // Moves every queue time of an account back, as if the minutes had passed (leases stay).
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
    const roleReceipt = async (user) => (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
      values($1,'global','binding_role_set','binding','fixture','{}'::jsonb) returning id`, [user])).rows[0].id;
    const mark = async (user, who, purpose, effective = "now()-interval '5 minutes'") =>
      admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'ci-admission',now()-interval '10 minutes',$3,${effective},$4)`, [user, ids[who], await roleReceipt(user), purpose]);
    const digestMatches = async (c) => (await admin.query(`select e.resources_digest=clued_private.m1_sha256(
        jsonb_build_object('write_set',w.write_set,'trigger_refs',w.trigger_refs)) ok
      from clued_private.work_claim_execution_admissions_v1 e join clued_private.work_claims_v1 w on w.claim_id=e.claim_id
      where e.claim_id=$1 order by e.created_at desc limit 1`, [c.claim_id])).rows[0].ok;

    // --- Surface: CI8 and GW80 unchanged; the helpers and the table are private to everybody. ---
    for (const fn of ['work_claim_ci_assist_target_v1', 'work_claim_ci_assist_input_v1', 'work_claim_ci_queue_join_v1',
      'work_claim_ci_lease_extend_v1', 'work_claim_ci_keep_merge_ref_v1', 'work_claim_ci_extended_to_v1']) {
      assert.equal((await admin.query(`select count(*)::int n from pg_proc where pronamespace='clued_private'::regnamespace
        and proname=$1`, [fn])).rows[0].n, 1, fn);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        const allowed = (await admin.query(`select bool_or(has_function_privilege($1,p.oid,'execute')) v from pg_proc p
          where p.pronamespace='clued_private'::regnamespace and p.proname=$2`, [role, fn])).rows[0].v;
        assert.equal(allowed, false, `${role} can execute ${fn}`);
      }
    }
    for (const client of [anon, human, workerCaller]) {
      await assert.rejects(() => client.query('select * from clued_private.work_claim_ci_merge_refs_v1'), /permission denied/);
    }
    for (const name of ['clued_work_merge_queue_join_v1', 'clued_work_lease_extend_v1']) {
      assert.equal((await admin.query('select count(*)::int n from pg_proc where proname=$1', [name])).rows[0].n, 0, name);
    }
    await assertGatewayCloseoutBoundary(admin);

    // --- Before any ci-admission mark the door refuses every Binding (unlike touch's open behaviour). ---
    const a = await claim('h1', 'A');
    const pr1 = `${REPO}#1`;
    assert.deepEqual(await join('node', pr1, HEAD('a')), REFUSED);
    assert.deepEqual(await extend('node', pr1, HEAD('a'), 30), REFUSED);

    await mark(userId, 'node', 'resident-node');
    await mark(userId, 'envci', 'other');
    await mark(userId, 'standby', 'resident-node', "now()+interval '5 minutes'"); // marked, not started
    await mark(userId, 'revoked', 'resident-node');
    await admin.query(`update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2 where binding_id=$1`,
      [ids.revoked, await roleReceipt(userId)]);

    // --- Input checks: the door's 22023. ---
    for (const bad of [{ pr_ref: undefined }, { head_sha: undefined }, { pr_ref: 'not a pr' }, { pr_ref: 7 },
      { head_sha: 'abcdef1' }, { head_sha: 'a'.repeat(64) }, { head_sha: 'g'.repeat(40) }, { extra: true }, { minutes: 5 },
      { scope: 7 }]) {
      await assert.rejects(() => join('node', pr1, HEAD('a'), bad),
        (error) => /work_claim_ci_command_invalid/.test(error.message) && error.code === '22023', JSON.stringify(bad));
    }
    for (const minutes of [0, 181, 1.5, '10', -1, null, undefined]) {
      await assert.rejects(() => extend('node', pr1, HEAD('a'), minutes), /work_claim_ci_command_invalid/, `minutes ${minutes}`);
    }
    await assert.rejects(() => extend('node', pr1, HEAD('a'), 10, { extra: true }), /work_claim_ci_command_invalid/);

    // --- Authorization: the holder, a standby node not yet on duty, a revoked row and an "other" row are refused. ---
    for (const who of ['h1', 'standby', 'revoked', 'envci']) {
      assert.deepEqual(await join(who, pr1, HEAD('a')), REFUSED, who);
      assert.deepEqual(await extend(who, pr1, HEAD('a'), 30), REFUSED, who);
    }

    // --- Bound to exactly that pull request, with that head admitted for the current epoch and branch main. ---
    assert.equal((await join('node', pr1, HEAD('a'))).reason, 'claim_not_bound');
    assert.equal((await extend('node', pr1, HEAD('a'), 30)).reason, 'claim_not_bound');
    // A verify without target_branch binds and admits the head but records no execution admission.
    const plain = await agent('node', 'clued_work_verify_v1', { scope: 'global', claim_id: a.claim_id, pr_ref: pr1, head_sha: HEAD('a') });
    assert.equal(plain.verdict, 'ADMITTED');
    assert.equal((await join('node', pr1, HEAD('a'))).reason, 'head_not_admitted', 'no execution admission');
    await admit('node', a, pr1, HEAD('9'), 'release');
    assert.equal((await join('node', pr1, HEAD('9'))).reason, 'head_not_admitted', 'admitted for another target branch');
    const aBound = await admit('node', a, pr1, HEAD('a'));
    for (const result of [await join('node', pr1, HEAD('b')), await extend('node', pr1, HEAD('b'), 30)]) {
      assert.deepEqual([result.status, result.reason], ['ok', 'head_not_admitted']);
    }
    assert.equal((await join('node', `${REPO}#11`, HEAD('a'))).reason, 'claim_not_bound', 'another PR');
    assert.equal((await join('node', `${REPO.toUpperCase()}#1`, HEAD('a'))).reason, 'claim_not_bound', 'exactly the bound pr_ref');
    assert.deepEqual(await receipts('work_claim_merge_queue_join_by_ci'), [], 'refusals write nothing');

    // --- Join without the ref: added at the back; the holder's fields stay. ---
    const aBefore = await row(a);
    assert.equal(await digestMatches(a), true);
    const joinedA = await join('node', pr1, HEAD('A'));
    assert.deepEqual([joinedA.status, joinedA.joined, joinedA.claim_id, joinedA.merge_ref], ['ok', true, a.claim_id, SLOT],
      JSON.stringify(joinedA));
    assert.deepEqual(joinedA.merge_queue.map((q) => [q.ref, q.state, q.position]), [[SLOT, 'head', 1]]);
    const aAfter = await row(a);
    assertHolderFieldsKept(aAfter, aBefore, 'join');
    assert.deepEqual([aAfter.expires_at, aAfter.status], [aBefore.expires_at, 'ACTIVE']);
    assert.deepEqual(aAfter.trigger_refs, [SLOT, 'task:a'].sort());
    let joinReceipts = await receipts('work_claim_merge_queue_join_by_ci');
    assert.equal(joinReceipts.length, 1);
    assert.deepEqual([joinReceipts[0].object_id, joinReceipts[0].binding_id, joinReceipts[0].metadata.receipt_kind,
      joinReceipts[0].metadata.pr_ref, joinReceipts[0].metadata.head_sha, joinReceipts[0].metadata.ci_binding_id,
      joinReceipts[0].metadata.rejoined], [a.claim_id, ids.node, 'WORK_CLAIM_MERGE_QUEUE_JOINED_BY_CI', pr1, HEAD('a'), ids.node, false]);
    assert.deepEqual((await admin.query('select merge_ref from clued_private.work_claim_ci_merge_refs_v1 where claim_id=$1',
      [a.claim_id])).rows, [{ merge_ref: SLOT }]);
    // The join changed trigger_refs: the earlier execution admission no longer matches the claim's
    // resources (a guarded claim reports epoch_current=false) until the CI verifies the head again.
    assert.equal(await digestMatches(a), false, 'the old admission digest is stale after a join');
    await admit('node', a, pr1, HEAD('a'));
    assert.equal(await digestMatches(a), true, 'verifying again records an admission that matches');
    // Already in the queue (head): idempotent, no write.
    const aJoined = await row(a);
    const again = await join('node', pr1, HEAD('a'));
    assert.deepEqual([again.joined, again.reason, again.merge_queue[0].state], [false, 'already_queued', 'head']);
    assert.equal((await receipts('work_claim_merge_queue_join_by_ci')).length, 1);
    assert.deepEqual(await row(a), aJoined);

    // A second pull request joins behind it; waiting is also already queued.
    const b = await claim('h2', 'B');
    const pr2 = `${REPO}#2`;
    await admit('node', b, pr2, HEAD('b'));
    const joinedB = await join('node', pr2, HEAD('b'));
    assert.deepEqual(joinedB.merge_queue.map((q) => [q.state, q.position]), [['waiting', 2]]);
    assert.deepEqual(order(await queueOf()), [a.claim_id, b.claim_id]);
    assert.equal((await join('node', pr2, HEAD('b'))).reason, 'already_queued');

    // --- The holder's renewal: its own lease_version still works, and a list without the CI's ref keeps it. ---
    const queuedAt = (await row(a)).merge_queued_at;
    const aRenewed = await renew('h1', aBound, { trigger_refs: ['task:a'] });
    assert.equal(aRenewed.lease_version, aBound.lease_version + 1);
    assert.deepEqual(aRenewed.trigger_refs, [SLOT, 'task:a'].sort(), 'the CI merge ref is kept');
    assert.deepEqual((await row(a)).merge_queued_at, queuedAt, 'its place is unchanged');
    assert.deepEqual(order(await queueOf()), [a.claim_id, b.claim_id]);
    const bRenewed = await renew('h2', await row(b).then((r) => ({ claim_id: b.claim_id, ...r })), { trigger_refs: ['task:b', 'task:b2'] });
    assert.deepEqual(bRenewed.trigger_refs, [SLOT, 'task:b', 'task:b2'].sort(), 'kept beside a changed list');
    assert.deepEqual(order(await queueOf()), [a.claim_id, b.claim_id], 'a waiting place is kept too');

    // --- Rejoin after a lapse (FIFO): back of the queue, renewals untouched; journal and marker as for a renewal. ---
    await shift(46);
    assert.deepEqual((await queueOf()).entries.map((e) => [e.claim_id, e.state]),
      [[a.claim_id, 'lapsed'], [b.claim_id, 'head']], 'A lapsed, B is head');
    const aLapsed = await row(a);
    const events = async () => (await admin.query(`select kind,object_key,payload from clued_private.merge_measurement_events_v1
      where user_id=$1 order by sequence`, [userId])).rows;
    const before = (await events()).length;
    const rejoined = await join('node', pr1, HEAD('a'));
    assert.deepEqual([rejoined.joined, rejoined.merge_queue[0].state, rejoined.merge_queue[0].position], [true, 'waiting', 2]);
    assert.deepEqual(order(await queueOf()), [b.claim_id, a.claim_id]);
    const aRejoined = await row(a);
    assertHolderFieldsKept(aRejoined, aLapsed, 'rejoin');
    assert.deepEqual([aRejoined.expires_at, aRejoined.trigger_refs], [aLapsed.expires_at, aLapsed.trigger_refs]);
    assert.ok(aRejoined.merge_queued_at > aLapsed.merge_queued_at, 'a new join time');
    const written = (await events()).slice(before);
    assert.deepEqual(written.filter((e) => e.kind === 'claim').map((e) => [e.object_key, e.payload.merge_refs, e.payload.merge_queued_at !== null]),
      [[a.claim_id, [], false], [a.claim_id, [SLOT], true]], 'the journal sees the claim leave and join again');
    assert.deepEqual(written.filter((e) => e.kind === 'queue_marker').map((e) => [e.payload.left_claim_id, e.payload.merge_ref]),
      [[a.claim_id, SLOT]], 'the lapsed entry\'s leaving is recorded once');
    assert.equal((await admin.query(`select left_claim_id from clued_private.work_claim_merge_queue_v1 where user_id=$1 and merge_ref=$2`,
      [userId, SLOT])).rows[0].left_claim_id, a.claim_id);
    joinReceipts = await receipts('work_claim_merge_queue_join_by_ci');
    assert.deepEqual(joinReceipts.map((r) => [r.object_id, r.metadata.rejoined, r.metadata.previous_state]),
      [[a.claim_id, false, 'none'], [b.claim_id, false, 'none'], [a.claim_id, true, 'lapsed']]);

    // --- A claim that already has another merge ref: both refs, every queue joined again. ---
    const OTHER = 'merge:owner/other:main';
    const m = await claim('h4', 'M', { trigger_refs: ['task:m', OTHER] });
    const pr8 = `${REPO}#8`;
    await admit('node', m, pr8, HEAD('8'));
    const mBefore = await row(m);
    const joinedM = await join('node', pr8, HEAD('8'));
    assert.equal(joinedM.joined, true);
    assert.deepEqual((await row(m)).trigger_refs, [SLOT, OTHER, 'task:m'].sort());
    assert.deepEqual(joinedM.merge_queue.map((q) => q.ref).sort(), [SLOT, OTHER].sort());
    assert.ok((await row(m)).merge_queued_at > mBefore.merge_queued_at, 'a changed set of merge refs joins every queue again');

    // --- A full list of trigger refs is refused cleanly. ---
    const full = await claim('h4', 'Full', { trigger_refs: Array.from({ length: 50 }, (_, i) => `full:${i}`) });
    const pr9 = `${REPO}#9`;
    await admit('node', full, pr9, HEAD('f'));
    const fullAnswer = await join('node', pr9, HEAD('f'));
    assert.deepEqual([fullAnswer.status, fullAnswer.joined, fullAnswer.reason], ['ok', false, 'trigger_refs_full']);
    assert.equal((await row(full)).trigger_refs.length, 50);

    // --- Not live: expired, handover pending, released, superseded, not adopted, draining. ---
    const live = async (title, pr, head, who = 'h3') => {
      const c = await claim(who, title);
      await admit('node', c, pr, head);
      return c;
    };
    const c = await live('C', `${REPO}#3`, HEAD('c'));
    await admin.query(`update clued_private.work_claims_v1 set issued_at=now()-interval '20 minutes',
      expires_at=now()-interval '1 minute' where claim_id=$1`, [c.claim_id]);
    const cExpired = await row(c);
    assert.equal((await extend('node', `${REPO}#3`, HEAD('c'), 60)).reason, 'claim_not_live', 'never revives an expired lease');
    assert.deepEqual([(await row(c)).status, (await row(c)).expires_at], ['EXPIRED', cExpired.expires_at]);
    assert.equal((await join('node', `${REPO}#3`, HEAD('c'))).reason, 'claim_not_live');
    const d = await live('D', `${REPO}#4`, HEAD('d'));
    await admin.query('update clued_private.work_claims_v1 set execution_handover_pending=true where claim_id=$1', [d.claim_id]);
    assert.equal((await join('node', `${REPO}#4`, HEAD('d'))).reason, 'claim_not_live', 'handover pending');
    assert.equal((await extend('node', `${REPO}#4`, HEAD('d'), 60)).reason, 'claim_not_live', 'handover pending');
    const g = await claim('h2', 'G');
    const gBound = await admit('node', g, `${REPO}#7`, HEAD('7'));
    committed(await agent('h2', 'clued_work_release_v1', { scope: 'global', claim_id: g.claim_id, fence: gBound.fence, outcome: 'completed' }));
    assert.equal((await extend('node', `${REPO}#7`, HEAD('7'), 60)).reason, 'claim_not_live', 'released');
    assert.equal((await join('node', `${REPO}#7`, HEAD('7'))).reason, 'claim_not_live', 'released');
    for (const [title, n, patch] of [['Sup', 12, "status='SUPERSEDED'"], ['NotAdopted', 13, "copy_index=1,outcome='not_adopted'"],
      ['Draining', 14, "status='DRAINING'"]]) {
      const x = await live(title, `${REPO}#${n}`, HEAD(String(n % 10)));
      await admin.query(`update clued_private.work_claims_v1 set ${patch} where claim_id=$1`, [x.claim_id]);
      assert.equal((await join('node', `${REPO}#${n}`, HEAD(String(n % 10)))).reason, 'claim_not_live', title);
      assert.equal((await extend('node', `${REPO}#${n}`, HEAD(String(n % 10)), 60)).reason, 'claim_not_live', title);
    }
    // Superseded by a newer fence of its Task (the released claim G takes the Task and a higher fence).
    const s = await live('S', `${REPO}#15`, HEAD('5'));
    await admin.query(`update clued_private.work_claims_v1 set task_id=$2,fence=$3 where claim_id=$1`,
      [g.claim_id, (await row(s)).task_id, Number((await row(s)).fence) + 100]);
    assert.equal((await join('node', `${REPO}#15`, HEAD('5'))).reason, 'claim_not_live', 'a newer fence of the Task');

    // --- The execution epoch: after a key-transfer renewal moves the claim to another
    // Binding (a new epoch), the old admission no longer counts. ---
    const pAnswer = await claimAnswer('h4', 'P');
    const p = pAnswer.claim;
    assert.ok(pAnswer.lease_key, 'the claim answer carries its private key');
    await admit('node', p, `${REPO}#16`, HEAD('6'));
    const epoch = Number((await row(p)).execution_epoch);
    const moved = committed(await agent('h5', 'clued_work_renew_v1', { scope: 'global', claim_id: p.claim_id,
      fence: Number(p.fence), lease_version: Number(p.lease_version), lease_key: pAnswer.lease_key,
      progress_ref: `reconnect:${uuid()}`, holder_session_ref: 'session-P2' }));
    assert.equal(moved.transferred, true);
    assert.equal((await row(p)).holder_binding_id, ids.h5);
    assert.equal(Number((await row(p)).execution_epoch), epoch + 1, 'the transfer moved the execution epoch');
    assert.equal((await join('node', `${REPO}#16`, HEAD('6'))).reason, 'head_not_admitted', 'a revoked batch cannot join');
    assert.equal((await extend('node', `${REPO}#16`, HEAD('6'), 60)).reason, 'head_not_admitted', 'nor extend');
    await admit('node', p, `${REPO}#16`, HEAD('6'));
    assert.equal((await join('node', `${REPO}#16`, HEAD('6'))).joined, true, 'admitted again in the new epoch');

    // --- lease_extend: never past the hard deadline, idempotent, at most once per 5 minutes. ---
    const e = await live('E', `${REPO}#5`, HEAD('e'));
    await admin.query(`update clued_private.work_claims_v1 set expires_at=now()+interval '10 minutes' where claim_id=$1`, [e.claim_id]);
    const eBefore = await row(e);
    const extended = await extend('node', `${REPO}#5`, HEAD('e'), 60);
    assert.deepEqual([extended.status, extended.extended, extended.claim_id, extended.minutes], ['ok', true, e.claim_id, 60],
      JSON.stringify(extended));
    const eAfter = await row(e);
    assert.ok(Math.abs(eAfter.expires_at - Date.now() - 60 * 60000) < 60000, `about an hour from now: ${eAfter.expires_at}`);
    assert.equal(new Date(extended.expires_at).getTime(), eAfter.expires_at.getTime());
    assert.equal(new Date(extended.previous_expires_at).getTime(), eBefore.expires_at.getTime());
    assertHolderFieldsKept(eAfter, eBefore, 'extend');
    for (const key of ['trigger_refs', 'merge_queued_at', 'merge_slot_at', 'merge_slot_ci_at', 'status']) {
      assert.deepEqual(eAfter[key], eBefore[key], `extend: ${key}`);
    }
    let extendReceipts = await receipts('work_claim_lease_extend_by_ci');
    assert.equal(extendReceipts.length, 1);
    assert.deepEqual([extendReceipts[0].object_id, extendReceipts[0].binding_id, extendReceipts[0].metadata.receipt_kind,
      extendReceipts[0].metadata.minutes, extendReceipts[0].metadata.pr_ref],
    [e.claim_id, ids.node, 'WORK_CLAIM_LEASE_EXTENDED_BY_CI', 60, `${REPO}#5`]);
    assert.equal(new Date(extendReceipts[0].metadata.previous_expires_at).getTime(), eBefore.expires_at.getTime());
    assert.equal(new Date(extendReceipts[0].metadata.expires_at).getTime(), eAfter.expires_at.getTime());
    const shorter = await extend('node', `${REPO}#5`, HEAD('e'), 30);
    assert.deepEqual([shorter.extended, shorter.reason], [false, 'already_extended']);
    const soon = await extend('node', `${REPO}#5`, HEAD('e'), 180);
    assert.deepEqual([soon.status, soon.extended, soon.reason], ['ok', false, 'recently_extended']);
    assert.deepEqual(await row(e), eAfter);
    assert.equal((await receipts('work_claim_lease_extend_by_ci')).length, 1);
    await ageReceipts('work_claim_lease_extend_by_ci');
    const later = await extend('node', `${REPO}#5`, HEAD('e'), 180);
    assert.equal(later.extended, true, JSON.stringify(later));
    const eLong = (await row(e)).expires_at;
    assert.ok(Math.abs(eLong - Date.now() - 180 * 60000) < 60000);
    // The holder's renewal is accepted and never cuts the CI's 3 hours back to the 2-hour lease.
    const eHolder = await renew('h3', { claim_id: e.claim_id, fence: eBefore.fence, lease_version: eBefore.lease_version });
    assert.equal(Number(eHolder.lease_version), Number(eBefore.lease_version) + 1);
    assert.equal((await row(e)).expires_at.getTime(), eLong.getTime(), 'the renewal keeps the later expiry');
    // An ordinary renewal still sets the lease to two hours from now.
    const r2 = await live('R', `${REPO}#17`, HEAD('3'));
    await admin.query(`update clued_private.work_claims_v1 set expires_at=now()+interval '5 minutes' where claim_id=$1`, [r2.claim_id]);
    await renew('h3', await row(r2).then((x) => ({ claim_id: r2.claim_id, ...x })));
    assert.ok(Math.abs((await row(r2)).expires_at - Date.now() - 120 * 60000) < 60000);

    // The hard deadline caps it, and then nothing more is written (1 minute is the lower bound).
    const f = await live('F', `${REPO}#6`, HEAD('4'));
    await admin.query(`update clued_private.work_claims_v1 set expires_at=now()+interval '30 seconds',
      hard_deadline_at=now()+interval '20 minutes' where claim_id=$1`, [f.claim_id]);
    assert.equal((await extend('node', `${REPO}#6`, HEAD('4'), 1)).extended, true);
    await ageReceipts('work_claim_lease_extend_by_ci');
    const toDeadline = await extend('node', `${REPO}#6`, HEAD('4'), 180);
    const fRow = await row(f);
    assert.deepEqual([toDeadline.extended, fRow.expires_at.getTime()], [true, fRow.hard_deadline_at.getTime()]);
    await ageReceipts('work_claim_lease_extend_by_ci');
    const atDeadline = await extend('node', `${REPO}#6`, HEAD('4'), 180);
    assert.deepEqual([atDeadline.extended, atDeadline.reason], [false, 'hard_deadline']);
    extendReceipts = await receipts('work_claim_lease_extend_by_ci');
    assert.deepEqual(extendReceipts.map((r) => r.object_id), [e.claim_id, e.claim_id, f.claim_id, f.claim_id],
      'one receipt per effective extension');

    // --- After a CI extension reached the hard deadline, the holder still renews (the expiry stays at the cap). ---
    const t = await live('T', `${REPO}#18`, HEAD('2'), 'h4');
    await admin.query(`update clued_private.work_claims_v1 set expires_at=now()+interval '30 minutes',
      hard_deadline_at=now()+interval '170 minutes' where claim_id=$1`, [t.claim_id]);
    const tExtended = await extend('node', `${REPO}#18`, HEAD('2'), 180);
    const tRow = await row(t);
    assert.deepEqual([tExtended.extended, tRow.expires_at.getTime()], [true, tRow.hard_deadline_at.getTime()]);
    const tRenewed = await renew('h4', { claim_id: t.claim_id, fence: tRow.fence, lease_version: tRow.lease_version },
      { progress_ref: HEAD('2'), write_set: [...tRow.write_set, 'ci-assist/extra'] });
    assert.equal(Number(tRenewed.lease_version), Number(tRow.lease_version) + 1);
    assert.equal(tRenewed.progress_ref, HEAD('2'));
    assert.ok(tRenewed.write_set.includes('ci-assist/extra'));
    assert.equal((await row(t)).expires_at.getTime(), tRow.hard_deadline_at.getTime(), 'the expiry stays at the deadline');
    // Without a CI extension, a lease at the deadline is refused as before.
    const tPlain = await live('TPlain', `${REPO}#19`, HEAD('1'), 'h4');
    await admin.query(`update clued_private.work_claims_v1 set hard_deadline_at=expires_at where claim_id=$1`, [tPlain.claim_id]);
    const tPlainRow = await row(tPlain);
    const refusedRenew = await agent('h4', 'clued_work_renew_v1', { scope: 'global', claim_id: tPlain.claim_id,
      fence: Number(tPlainRow.fence), lease_version: Number(tPlainRow.lease_version), progress_ref: uuid() });
    assert.deepEqual([refusedRenew.status, refusedRenew.error_code], ['rejected', 'work_claim_hard_deadline']);

    // Only an extension receipt from the claim's lifetime counts: one dated before the claim was issued does not.
    const tOld = await live('TOld', `${REPO}#27`, HEAD('5'), 'h4');
    await admin.query(`update clued_private.work_claims_v1 set hard_deadline_at=expires_at where claim_id=$1`, [tOld.claim_id]);
    const tOldRow = await admin.query('select * from clued_private.work_claims_v1 where claim_id=$1', [tOld.claim_id]).then((r) => r.rows[0]);
    // Exact expiry (microseconds) copied in SQL; createdAt is an SQL expression over the claim row w.
    const fakeExtension = (createdAt) => admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
        object_type,object_id,version,metadata,created_at)
      select w.user_id,$2,'global','work_claim_lease_extend_by_ci','work_claim',w.claim_id::text,w.fence,
        jsonb_build_object('receipt_kind','WORK_CLAIM_LEASE_EXTENDED_BY_CI','expires_at',w.expires_at),${createdAt}
      from clued_private.work_claims_v1 w where w.claim_id=$1`, [tOld.claim_id, ids.node]);
    await fakeExtension("w.issued_at-interval '1 minute'");
    const renewOld = () => agent('h4', 'clued_work_renew_v1', { scope: 'global', claim_id: tOld.claim_id,
      fence: Number(tOldRow.fence), lease_version: Number(tOldRow.lease_version), progress_ref: uuid() });
    assert.equal((await renewOld()).error_code, 'work_claim_hard_deadline', 'a receipt from before the claim does not count');
    await fakeExtension('clock_timestamp()');
    const renewedOld = await renewOld();
    assert.equal(renewedOld.status, 'committed', JSON.stringify(renewedOld));
    // The lookup is a range of the (user_id, context_key, created_at desc) index.
    await admin.query('set enable_seqscan=off');
    const plan = (await admin.query(`explain select 1 from public.clued_audit_receipts r where r.user_id=$1
      and r.context_key='global' and r.created_at>=$2 and r.operation='work_claim_lease_extend_by_ci'
      and r.object_id=$3 and (r.metadata->>'expires_at')::timestamptz=$4`,
    [userId, tOldRow.issued_at, tOld.claim_id, tOldRow.expires_at])).rows.map((r) => r['QUERY PLAN']).join(' | ');
    await admin.query('reset enable_seqscan');
    assert.match(plan, /Index Cond: [^|]*created_at >= /, plan);
    console.log(`work_claim_ci_extended_to_v1 lookup plan: ${plan}`);

    // --- Keeping the CI's ref would make 51 refs: the renewal is refused with 22023. ---
    const u = await live('U', `${REPO}#20`, HEAD('0'), 'h5');
    await admin.query(`update clued_private.work_claims_v1 set trigger_refs=$2 where claim_id=$1`,
      [u.claim_id, Array.from({ length: 49 }, (_, i) => `u:${String(i).padStart(2, '0')}`)]);
    assert.equal((await join('node', `${REPO}#20`, HEAD('0'))).joined, true);
    assert.equal((await row(u)).trigger_refs.length, 50);
    const uRow = await row(u);
    await assert.rejects(() => agent('h5', 'clued_work_renew_v1', { scope: 'global', claim_id: u.claim_id,
      fence: Number(uRow.fence), lease_version: Number(uRow.lease_version), progress_ref: uuid(),
      trigger_refs: Array.from({ length: 50 }, (_, i) => `u:${String(i).padStart(2, '0')}`) }),
    (error) => /work_claim_trigger_refs_invalid/.test(error.message) && error.code === '22023');
    assert.deepEqual(await row(u), uRow, 'the refused renewal changed nothing');

    // --- The CI's ref left with the slot; one the holder adds again is the holder's own and leaves on renewal. ---
    const q = await live('Q', `${REPO}#24`, HEAD('7'), 'h5');
    assert.equal((await join('node', `${REPO}#24`, HEAD('7'))).joined, true);
    const ciRow = async (x) => (await admin.query('select merge_ref from clued_private.work_claim_ci_merge_refs_v1 where claim_id=$1',
      [x.claim_id])).rows;
    assert.deepEqual(await ciRow(q), [{ merge_ref: SLOT }]);
    assert.equal((await agent('node', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${REPO}#24` })).returned, true);
    assert.deepEqual((await row(q)).trigger_refs, ['task:q']);
    assert.deepEqual(await ciRow(q), [], 'the return deletes the CI ref row');
    let qClaim = await renew('h5', await row(q).then((x) => ({ claim_id: q.claim_id, ...x })), { trigger_refs: ['task:q', SLOT] });
    assert.deepEqual(qClaim.trigger_refs, [SLOT, 'task:q'].sort(), 'the holder takes the slot itself');
    qClaim = await renew('h5', qClaim, { trigger_refs: ['task:q'] });
    assert.deepEqual(qClaim.trigger_refs, ['task:q'], 'a renewal without its own ref leaves the queue');
    // A stale row of a ref that left some other way is dropped by the next renewal.
    const q2 = await live('Q2', `${REPO}#25`, HEAD('8'), 'h5');
    assert.equal((await join('node', `${REPO}#25`, HEAD('8'))).joined, true);
    await admin.query(`update clued_private.work_claims_v1 set trigger_refs=array['task:q2'] where claim_id=$1`, [q2.claim_id]);
    let q2Claim = await renew('h5', await row(q2).then((x) => ({ claim_id: q2.claim_id, ...x })), { trigger_refs: ['task:q2', SLOT] });
    assert.deepEqual(await ciRow(q2), [], 'the stale row is gone');
    q2Claim = await renew('h5', q2Claim, { trigger_refs: ['task:q2'] });
    assert.deepEqual(q2Claim.trigger_refs, ['task:q2']);

    // --- Approval: verify records the execution admission of a protected-layer head before and without any
    // Owner Grant, and the CI may join it: intended, the server trusts the admission check, joining is not
    // merging, and the required checks still need the Grant (Owner Decision 207c0cd0 v4). ---
    const v = await claim('h5', 'V');
    const vAdmitted = await agent('node', 'clued_work_verify_v1', { scope: 'global', claim_id: v.claim_id, pr_ref: `${REPO}#26`,
      head_sha: HEAD('9'), target_branch: 'main', admission_mode: { state: 'normal', layer: 'protected' } });
    assert.equal(vAdmitted.verdict, 'ADMITTED');
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_grants_v1 where user_id=$1`, [userId])).rows[0].n, 0);
    assert.equal((await join('node', `${REPO}#26`, HEAD('9'))).joined, true, 'no server-side Grant condition for a join');

    // --- A CI ref that left the claim (the slot returned on close) is not put back by a renewal. ---
    assert.equal((await agent('node', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: pr2 })).returned, true);
    assert.deepEqual((await row(b)).trigger_refs, ['task:b', 'task:b2']);
    const bAfterReturn = await renew('h2', await row(b).then((x) => ({ claim_id: b.claim_id, ...x })), { trigger_refs: ['task:b'] });
    assert.deepEqual(bAfterReturn.trigger_refs, ['task:b']);

    // --- An account with a recorded front (priority ordering): a lapsed front rejoins at the back. ---
    await mark(u2, 'knode', 'resident-node');
    const k1 = await claim('k1', 'K1');
    const k2 = await claim('k2', 'K2');
    committed(await native('clued_merge_queue_ordering_set_v1', { ordering: 'priority', base_version: 0 }, fresh(u2)));
    await admit('knode', k1, `${REPO}#21`, HEAD('1'));
    await admit('knode', k2, `${REPO}#22`, HEAD('2'));
    assert.equal((await join('knode', `${REPO}#21`, HEAD('1'))).joined, true);
    assert.equal((await join('knode', `${REPO}#22`, HEAD('2'))).joined, true);
    const front = async () => (await admin.query(`select claim_id from clued_private.work_claim_merge_front_v1
      where user_id=$1 and merge_ref=$2`, [u2, SLOT])).rows[0]?.claim_id;
    assert.equal(await front(), k1.claim_id);
    await shift(46, u2);
    const k1Lapsed = await row(k1);
    const k1Back = await join('knode', `${REPO}#21`, HEAD('1'));
    assert.deepEqual([k1Back.joined, k1Back.merge_queue[0].state], [true, 'waiting']);
    assert.deepEqual(order(await queueOf(u2)), [k2.claim_id, k1.claim_id]);
    assert.equal(await front(), k2.claim_id, 'the next head is recorded in the same write');
    assertHolderFieldsKept(await row(k1), k1Lapsed, 'recorded rejoin');
    assert.equal((await join('node', `${REPO}#22`, HEAD('2'))).reason, 'claim_not_bound', 'another account');

    // --- FIFO: an entry that is out (behind the marker) rejoins at the back; an unspecified row is admitted. ---
    await mark(u3, 'unspec', 'unspecified');
    const x1 = await claim('f1', 'X1', { trigger_refs: [SLOT] });
    const x2 = await claim('f2', 'X2', { trigger_refs: [SLOT] });
    const x3 = await claim('f3', 'X3', { trigger_refs: [SLOT] });
    await shift(46, u3);
    await renew('f2', x2, { trigger_refs: [] });
    const fifo = async () => (await admin.query('select clued_private.work_claim_merge_queue_v1($1,$2) v', [u3, SLOT])).rows[0].v;
    assert.deepEqual((await fifo()).entries.map((x) => [x.claim_id, x.state]), [[x1.claim_id, 'out'], [x3.claim_id, 'head']]);
    await admit('unspec', x1, `${REPO}#31`, HEAD('1'));
    const x1Back = await join('unspec', `${REPO}#31`, HEAD('1'));
    assert.deepEqual([x1Back.joined, x1Back.merge_queue[0].state, x1Back.merge_queue[0].position], [true, 'waiting', 2]);
    assert.deepEqual((await receipts('work_claim_merge_queue_join_by_ci', u3)).map((r) => r.metadata.previous_state), ['out']);
    assert.deepEqual(order(await fifo()), [x3.claim_id, x1.claim_id]);

    // --- A CI rejoin of the holder's own ref keeps it the holder's: a renewal without it leaves the queue. ---
    await mark(u4, 'wnode', 'resident-node');
    const w = await claim('w1', 'W');
    await admit('wnode', w, `${REPO}#41`, HEAD('4'));
    const wJoined = await renew('w1', w, { trigger_refs: ['task:w', SLOT] });
    assert.deepEqual(wJoined.merge_queue.map((x) => x.state), ['head'], 'the holder joined itself');
    await shift(46, u4);
    const wBack = await join('wnode', `${REPO}#41`, HEAD('4'));
    assert.deepEqual([wBack.joined, wBack.merge_queue[0].state], [true, 'head']);
    assert.deepEqual((await receipts('work_claim_merge_queue_join_by_ci', u4)).map((r) => [r.metadata.rejoined, r.metadata.previous_state]),
      [[true, 'lapsed']]);
    assert.deepEqual((await admin.query('select * from clued_private.work_claim_ci_merge_refs_v1 where claim_id=$1',
      [w.claim_id])).rows, [], 'a rejoin does not make the ref the CI one');
    const wLeft = await renew('w1', wJoined, { trigger_refs: ['task:w'] });
    assert.deepEqual([wLeft.trigger_refs, wLeft.merge_queue], [['task:w'], null], 'the holder leaves the queue by renewing');

    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
