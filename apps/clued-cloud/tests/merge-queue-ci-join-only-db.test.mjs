// The merge queue of a repository the resident CI serves has one way in: the CI door's merge_queue_join
// (migration *_merge_queue_ci_join_only_v1.sql; design FABLE-merge-queue-head-20261122, Task 05ff5174).
//
// Production 2026-11-22 (Beijing): the claim of #1227 was issued with merge:tdoljyj/cross-memory-system:main in
// trigger_refs, as agent contract A.6 told every agent to do. The stamp trigger queued it at once (it reads only
// "is there a merge ref"), it became head without a bound, admitted head, and every admitted pull request waited
// behind it until a person renewed it with trigger_refs=[]. Seven more write paths did the same (claim, takeover,
// renewal, a head's renewal keeping its place, a changed set of merge refs).
//
// Now a merge ref of a served repository stays on a claim only while work_claim_ci_merge_refs_v1 holds the CI's
// mark of it for that claim; without the mark it is dropped from trigger_refs, with no error. The holder can
// still leave. T1-T9 are the design's cases; T1-T5, T7b, T8 and T9 are red before the migration. Every step goes
// through the public RPCs; only the passing of time is written straight into the tables, as the other merge
// queue cases do.
import { stopCluster, removeTestDirectory, waitForPidExit, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { CI_SIGNATURES, PR_LIFECYCLE_REPORT_SIGNATURE, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const GATE = /_merge_queue_ci_join_only_v1\.sql$/;
const BASE = 'b'.repeat(40);
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('merge queue: a served repository is joined only through the CI door', { timeout: 600000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-merge-join-only-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('merge-join-only fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort();
    const gate = names.find(n => GATE.test(n));
    const apply = async list => {
      for (const name of list) {
        try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
        catch (e) { throw new Error('Migration ' + name + ': ' + e.message, { cause: e }); }
      }
    };
    // Everything before the gate first: T8 builds the queue the migration finds, then the gate (and anything after it) runs.
    await apply(gate ? names.slice(0, names.indexOf(gate)) : names);
    await allowRawTestBindings(admin);

    // served: an account with a resident ci-admission Binding on duty. old: the same, for the rows the migration finds (T8).
    // plain: an account without any ci-admission row.
    const users = { served: uuid(), old: uuid(), plain: uuid() };
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'join-only@example.invalid',now()),
      ($2,'join-only-old@example.invalid',now()),($3,'join-only-plain@example.invalid',now())`, [users.served, users.old, users.plain]);
    const tokens = {}, ids = {};
    const WRITE = ['context:read', 'context:write'];
    for (const [name, owner, scopes] of [['holder', users.served, WRITE], ['holder2', users.served, WRITE], ['ci', users.served, ['context:read']],
      ['oldholder', users.old, WRITE], ['oldci', users.old, ['context:read']], ['plainholder', users.plain, WRITE]]) {
      tokens[name] = hash(); ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [owner, name, tokens[name], scopes])).rows[0].id;
    }
    for (const [who, owner] of [['ci', users.served], ['oldci', users.old]]) {
      const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
        values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [owner, ids[who]])).rows[0].id;
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,purpose)
        values($1,$2,'ci-admission',now(),$3,'resident-node')`, [owner, ids[who], roleReceipt]);
    }
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const call = async (who, name, input) => [...CI_SIGNATURES, PR_LIFECYCLE_REPORT_SIGNATURE].includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const ref = repo => `merge:${repo}:main`;
    const task = async who => committed(await call(who, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claimInput = (task_id, extra = {}) => ({ task_id, scope: 'global', write_set: ['fixture/' + task_id + '/main.mjs'],
      holder_label: 'join-only fixture', holder_session_ref: uuid(), idempotency_key: uuid(), ...extra });
    // A claim answer with who holds it: {claim, lease_key, who}.
    const claim = async (who, extra = {}) => ({ ...committed(await call(who, 'clued_work_claim_v1', claimInput(await task(who), extra))), who });
    const row = async r => (await admin.query(`select claim_id,status,fence,lease_version,trigger_refs,merge_queued_at,merge_slot_at,
      merge_slot_taken_at,merge_slot_hard_cap_seconds,execution_epoch,expires_at from clued_private.work_claims_v1 where claim_id=$1`, [r.claim.claim_id])).rows[0];
    // The holder's renewal with the claim's current fence and lease version; extra carries trigger_refs when the list is sent.
    const renew = async (r, extra = {}) => {
      const now = await row(r);
      return committed(await call(r.who, 'clued_work_renew_v1', { scope: 'global', claim_id: r.claim.claim_id, fence: Number(now.fence),
        lease_version: Number(now.lease_version), lease_key: r.lease_key, progress_ref: uuid(), ...extra })).claim;
    };
    const authorize = async (r, repo, n, head) => {
      const now = await row(r);
      return call(r.who, 'clued_work_renew_v1', { scope: 'global', action: 'authorize_head', claim_id: r.claim.claim_id, fence: Number(now.fence),
        lease_version: Number(now.lease_version), lease_key: r.lease_key, repository: repo, head_sha: head, target_branch: 'main', pr_number: n, idempotency_key: uuid() });
    };
    // The holder authorizes a PR head; the CI binds it (stage 1).
    const bound = async (ci, r, repo, n, head) => {
      committed(await authorize(r, repo, n, head));
      assert.equal((await call(ci, 'clued_work_verify_v1', { action: 'resolve_pr_claim', pr_ref: `${repo}#${n}`, head_sha: head, base_sha: BASE,
        target_branch: 'main' })).binding_status, 'bound');
    };
    // ... and admits it: the execution admission of that head for the claim's current epoch.
    const admitted = async (ci, r, repo, n, head) => {
      await bound(ci, r, repo, n, head);
      const result = await call(ci, 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id, pr_ref: `${repo}#${n}`, head_sha: head,
        base_sha: BASE, target_branch: 'main', changed_paths: ['fixture/' + r.claim.task_id + '/main.mjs'] });
      assert.equal(result.verdict, 'ADMITTED', JSON.stringify(result));
    };
    // As stage 8 does.
    const join = (ci, repo, n, head) => call(ci, 'clued_work_verify_v1', { action: 'merge_queue_join', scope: 'global', pr_ref: `${repo}#${n}`, head_sha: head });
    const joined = async (ci, repo, n, head) => { const j = await join(ci, repo, n, head); assert.equal(j.joined, true, JSON.stringify(j)); return j; };
    const adopt = (ci, repo, n) => call(ci, 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: `${repo}#${n}`, merge_sha: 'f'.repeat(40) });
    const release = r => call(r.who, 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    // A Binding holds at most ten live claims: each case gives its own back (a claim already over answers rejected, which is fine here).
    const finish = async (...rs) => { for (const r of rs) await release(r); };
    const queue = async (user, repo) => (await admin.query('select clued_private.work_claim_merge_queue_current_v1($1,$2) v', [user, ref(repo)])).rows[0].v;
    const entry = (q, r) => q.entries.find(e => e.claim_id === r.claim.claim_id);
    const marks = async r => (await admin.query('select merge_ref from clued_private.work_claim_ci_merge_refs_v1 where claim_id=$1', [r.claim.claim_id])).rows.map(x => x.merge_ref);
    const receipts = async (operation, r) => (await admin.query(`select binding_id,metadata from public.clued_audit_receipts
      where operation=$1 and object_id=$2 order by created_at,id`, [operation, r.claim.claim_id])).rows;
    const now = async () => (await admin.query('select clock_timestamp() t')).rows[0].t;
    // The claim is not in the queue of repo in any state, holds no slot and does not carry the ref.
    const assertOut = async (user, repo, r, label) => {
      const q = await queue(user, repo), w = await row(r);
      assert.equal(entry(q, r), undefined, `${label}: no queue entry: ${JSON.stringify(q)}`);
      assert.ok(!w.trigger_refs.some(x => x.toLowerCase() === ref(repo)), `${label}: trigger_refs ${JSON.stringify(w.trigger_refs)}`);
      assert.equal(w.merge_queued_at, null, `${label}: merge_queued_at`);
    };
    // A repository the resident serves: it has admitted a pull request head of it before (target main).
    const serve = async (holder, ci, repo) => {
      const s = await claim(holder);
      await admitted(ci, s, repo, 900, '90'.repeat(20));
      committed(await release(s));
    };

    // --- T8, before the migration: the queue it finds. ---
    const R8 = 'fixture/join-only-migrate', R8OPEN = 'fixture/join-only-migrate-open';
    await serve('oldholder', 'oldci', R8);
    const a8 = await claim('oldholder', { trigger_refs: [ref(R8)] });            // #1227: took the head itself, no PR, no admission
    const b8 = await claim('oldholder');                                         // admitted, joined by its own renewal: no CI mark
    await admitted('oldci', b8, R8, 81, '81'.repeat(20));
    await renew(b8, { trigger_refs: [ref(R8)] });
    const c8 = await claim('oldholder');                                         // admitted and joined by the CI
    await admitted('oldci', c8, R8, 82, '82'.repeat(20));
    await joined('oldci', R8, 82, '82'.repeat(20));
    const d8 = await claim('plainholder', { trigger_refs: [ref(R8OPEN)] });      // an account without a resident
    const before8 = { q: await queue(users.old, R8), b: await row(b8), c: await row(c8), d: await row(d8) };
    if (gate) await apply(names.slice(names.indexOf(gate)));

    await t.test('T8 migration: the unadmitted head leaves with a receipt; the admitted claims keep their places', async () => {
      assert.ok(gate, 'the migration *_merge_queue_ci_join_only_v1.sql is present');
      assert.deepEqual(before8.q.entries.filter(e => ['head', 'waiting'].includes(e.state)).map(e => [e.claim_id, e.state]),
        [[a8.claim.claim_id, 'head'], [b8.claim.claim_id, 'waiting'], [c8.claim.claim_id, 'waiting']], 'what the migration found');
      await assertOut(users.old, R8, a8, 'the unadmitted head');
      assert.equal((await row(a8)).status, 'ACTIVE', 'only the queue place goes; the claim stays');
      const left = (await admin.query(`select metadata from public.clued_audit_receipts where user_id=$1
        and operation='work_claim_merge_queue_unadmitted_leave' order by created_at,id`, [users.old])).rows;
      assert.deepEqual(left.map(x => [x.metadata.receipt_kind, x.metadata.claim_id, x.metadata.merge_ref]),
        [['WORK_CLAIM_MERGE_QUEUE_UNADMITTED_REMOVED', a8.claim.claim_id, ref(R8)]], 'one receipt, for the removed entry only');
      const q = await queue(users.old, R8);
      assert.equal(q.head?.claim_id, b8.claim.claim_id, 'the admitted claim that waited is head: ' + JSON.stringify(q));
      assert.deepEqual({ state: entry(q, c8).state, position: entry(q, c8).position }, { state: 'waiting', position: 2 });
      assert.deepEqual((await row(b8)).merge_queued_at, before8.b.merge_queued_at, 'B keeps its join time');
      assert.deepEqual((await row(c8)).merge_queued_at, before8.c.merge_queued_at, 'C keeps its join time');
      assert.deepEqual(await marks(b8), [ref(R8)], 'the admitted claim got the CI mark');
      assert.deepEqual(await marks(c8), [ref(R8)]);
      const backfilled = (await admin.query(`select metadata from public.clued_audit_receipts where user_id=$1
        and operation='work_claim_merge_queue_ci_mark_backfill'`, [users.old])).rows;
      assert.deepEqual(backfilled.map(x => x.metadata.claim_id), [b8.claim.claim_id]);
      // The marked place survives the holder's next renewal that keeps the list.
      await renew(b8);
      assert.equal((await queue(users.old, R8)).head?.claim_id, b8.claim.claim_id);
      // An account without a resident is not touched.
      assert.deepEqual(await row(d8), before8.d);
      assert.equal((await queue(users.plain, R8OPEN)).head?.claim_id, d8.claim.claim_id);
    });

    await t.test('T1 (#1227): a claim issued with the merge ref and no pull request is not queued', async () => {
      const repo = 'fixture/join-only-t1'; await serve('holder', 'ci', repo);
      const a = await claim('holder', { trigger_refs: ['task:t1', ref(repo)] });
      assert.equal(a.claim.merge_queue, null, 'the answer shows no queue place: ' + JSON.stringify(a.claim.merge_queue));
      assert.deepEqual(a.claim.trigger_refs, ['task:t1'], 'the ref is dropped, the rest of the list stays');
      await assertOut(users.served, repo, a, 'A');
      assert.equal((await queue(users.served, repo)).head, null);
      await finish(a);
    });

    await t.test('T2: two admitted pull requests land one after the other; the unadmitted claim never holds the head', async () => {
      const repo = 'fixture/join-only-t2'; await serve('holder', 'ci', repo);
      const a = await claim('holder', { trigger_refs: [ref(repo)] });
      const heads = [];
      const head = async label => {
        const q = await queue(users.served, repo);
        assert.equal(entry(q, a), undefined, `${label}: A is not in the queue: ${JSON.stringify(q)}`);
        if (q.head) heads.push(q.head.claim_id);
        return q.head?.claim_id ?? null;
      };
      assert.equal(await head('after the claim'), null);
      await renew(a, { trigger_refs: [ref(repo)] });
      const b = await claim('holder'), c = await claim('holder');
      await admitted('ci', b, repo, 1, '01'.repeat(20)); await admitted('ci', c, repo, 2, '02'.repeat(20));
      const jb = await joined('ci', repo, 1, '01'.repeat(20));
      assert.deepEqual(jb.merge_queue.map(x => [x.state, x.position]), [['head', 1]], 'B is head at once, not behind A');
      assert.equal(await head('B joined'), b.claim.claim_id);
      await renew(a, { trigger_refs: [ref(repo)] });
      const jc = await joined('ci', repo, 2, '02'.repeat(20));
      assert.deepEqual(jc.merge_queue.map(x => [x.state, x.position]), [['waiting', 2]]);
      assert.equal(await head('C joined'), b.claim.claim_id);
      assert.equal((await adopt('ci', repo, 1)).status, 'ok');
      assert.equal(await head('B merged'), c.claim.claim_id, 'C is head as soon as B has landed');
      await renew(a, { trigger_refs: [ref(repo)] });
      assert.equal(await head('A renewed again'), c.claim.claim_id);
      assert.equal((await adopt('ci', repo, 2)).status, 'ok');
      assert.equal(await head('C merged'), null, 'the queue is empty: A did not move up');
      await assertOut(users.served, repo, a, 'A at the end');
      // Every head there ever was had been joined by the CI.
      for (const id of new Set(heads)) {
        assert.equal((await receipts('work_claim_merge_queue_join_by_ci', { claim: { claim_id: id } })).length, 1, `head ${id} has its WORK_CLAIM_MERGE_QUEUE_JOINED_BY_CI receipt`);
      }
      assert.deepEqual([...new Set(heads)], [b.claim.claim_id, c.claim.claim_id]);
      await finish(a, b, c);
    });

    await t.test('T3 takeover: the new claim inherits trigger_refs but not the queue place', async () => {
      const repo = 'fixture/join-only-t3'; await serve('holder', 'ci', repo);
      const x = await claim('holder');
      await admitted('ci', x, repo, 3, '03'.repeat(20)); await joined('ci', repo, 3, '03'.repeat(20));
      assert.equal((await queue(users.served, repo)).head?.claim_id, x.claim.claim_id);
      // Time passes: the lease runs out.
      await admin.query(`update clued_private.work_claims_v1 set issued_at=now()-interval '3 hours',expires_at=now()-interval '1 minute' where claim_id=$1`, [x.claim.claim_id]);
      const y = { ...committed(await call('holder2', 'clued_work_takeover_v1', { scope: 'global', claim_id: x.claim.claim_id, idempotency_key: uuid() })), who: 'holder2' };
      assert.notEqual(y.claim.claim_id, x.claim.claim_id);
      assert.equal(y.claim.merge_queue, null, JSON.stringify(y.claim.merge_queue));
      await assertOut(users.served, repo, y, 'the claim that took over');
      assert.equal((await queue(users.served, repo)).head, null);
      // The CI can put it in once its own head is admitted.
      await admitted('ci', y, repo, 3, '13'.repeat(20)); await joined('ci', repo, 3, '13'.repeat(20));
      assert.equal((await queue(users.served, repo)).head?.claim_id, y.claim.claim_id);
      await finish(y);
    });

    await t.test('T4 renewal: adding the ref, or bringing it back after leaving, does not join', async () => {
      const repo = 'fixture/join-only-t4'; await serve('holder', 'ci', repo);
      const n = await claim('holder');
      const added = await renew(n, { trigger_refs: ['task:t4', ref(repo)] });
      assert.deepEqual([added.trigger_refs, added.merge_queue], [['task:t4'], null]);
      await assertOut(users.served, repo, n, 'a renewal that adds the ref');
      // Bound and admitted does not change it: only the CI joins.
      await admitted('ci', n, repo, 4, '04'.repeat(20));
      await renew(n, { trigger_refs: ['task:t4', ref(repo)] });
      await assertOut(users.served, repo, n, 'an admitted claim adding the ref itself');
      // A claim the CI joined leaves by its own renewal, then comes back with the ref: still out.
      const m = await claim('holder');
      await admitted('ci', m, repo, 5, '05'.repeat(20)); await joined('ci', repo, 5, '05'.repeat(20));
      await renew(m, { trigger_refs: [] });
      await renew(m, { trigger_refs: [ref(repo)] });
      await assertOut(users.served, repo, m, 'a claim that left and renews with the ref');
      // In another spelling too (refs are matched without case).
      await renew(m, { trigger_refs: [ref(repo).replace('fixture', 'Fixture')] });
      assert.equal((await queue(users.served, repo)).head, null);
      assert.equal((await row(m)).merge_queued_at, null);
      await finish(n, m);
    });

    await t.test('T5 leaving still works: the holder leaves, cannot come back alone, and the CI joins it again', async () => {
      const repo = 'fixture/join-only-t5'; await serve('holder', 'ci', repo);
      const p = await claim('holder');
      await admitted('ci', p, repo, 6, '06'.repeat(20)); await joined('ci', repo, 6, '06'.repeat(20));
      assert.deepEqual(await marks(p), [ref(repo)]);
      // Keeping the list, or naming the ref, keeps the place.
      const queuedAt = (await row(p)).merge_queued_at;
      await renew(p); await renew(p, { trigger_refs: [ref(repo)] });
      assert.deepEqual((await row(p)).merge_queued_at, queuedAt);
      assert.equal((await queue(users.served, repo)).head?.claim_id, p.claim.claim_id);
      const left = await renew(p, { trigger_refs: [] });
      assert.deepEqual([left.trigger_refs, left.merge_queue, left.status], [[], null, 'ACTIVE'], 'the holder left the queue and kept the claim');
      assert.deepEqual(await marks(p), []);
      const back = await renew(p, { trigger_refs: [ref(repo)] });
      assert.deepEqual([back.trigger_refs, back.merge_queue], [[], null], 'it cannot come back by itself');
      await assertOut(users.served, repo, p, 'after leaving');
      await admitted('ci', p, repo, 6, '06'.repeat(20));
      const again = await joined('ci', repo, 6, '06'.repeat(20));
      assert.deepEqual(again.merge_queue.map(x => x.state), ['head'], 'the CI door joins it again');
      assert.deepEqual(await marks(p), [ref(repo)]);
      await finish(p);
    });

    await t.test('T6 the queue\'s own rejoins still work for a claim the CI joined (turn_short, hard cap, the door\'s rejoin)', async () => {
      let repo = 'fixture/join-only-t6-short'; await serve('holder', 'ci', repo);
      const q6 = await claim('holder'), head6 = '07'.repeat(20);
      await admitted('ci', q6, repo, 7, head6); await joined('ci', repo, 7, head6);
      let refs = (await row(q6)).trigger_refs;
      await admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '68 minutes',
        merge_slot_taken_at=now()-interval '68 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [q6.claim.claim_id]);
      let at = await now();
      const y = await call('ci', 'clued_work_verify_v1', { action: 'merge_queue_yield', scope: 'global', pr_ref: `${repo}#7`, head_sha: head6, reason: 'turn_short' });
      assert.equal(y.yielded, true, JSON.stringify(y));
      let q = await queue(users.served, repo);
      assert.equal(q.head?.claim_id, q6.claim.claim_id, 'head again after turn_short: ' + JSON.stringify(q));
      assert.ok((await row(q6)).merge_queued_at >= at, 'a new join');
      assert.deepEqual((await row(q6)).trigger_refs, refs);
      assert.deepEqual((await receipts('work_claim_merge_queue_rejoin', q6)).map(x => x.metadata.why), ['turn_short']);
      // The turn ends at the hard cap while the CI still reports; the next keepalive joins it again.
      repo = 'fixture/join-only-t6-cap'; await serve('holder', 'ci', repo);
      const k6 = await claim('holder'), headK = '08'.repeat(20);
      await admitted('ci', k6, repo, 8, headK); await joined('ci', repo, 8, headK);
      refs = (await row(k6)).trigger_refs;
      await admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '121 minutes',merge_slot_taken_at=now()-interval '121 minutes',
        merge_slot_at=now()-interval '10 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [k6.claim.claim_id]);
      assert.equal(entry(await queue(users.served, repo), k6).state, 'lapsed');
      at = await now();
      assert.equal((await call('ci', 'clued_work_verify_v1', { action: 'merge_queue_keepalive', scope: 'global', repository: repo, pr_refs: [`${repo}#8`] })).status, 'ok');
      q = await queue(users.served, repo);
      assert.equal(q.head?.claim_id, k6.claim.claim_id, 'head again after the hard cap: ' + JSON.stringify(q));
      assert.ok((await row(k6)).merge_queued_at >= at);
      assert.deepEqual((await row(k6)).trigger_refs, refs);
      assert.deepEqual((await receipts('work_claim_merge_queue_rejoin', k6)).map(x => x.metadata.why), ['hard_cap']);
      // An entry that lapsed idle is joined again by the CI door (its rejoin branch).
      repo = 'fixture/join-only-t6-idle'; await serve('holder', 'ci', repo);
      const i6 = await claim('holder'), headI = '09'.repeat(20);
      await admitted('ci', i6, repo, 9, headI); await joined('ci', repo, 9, headI);
      await admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '60 minutes',merge_slot_taken_at=now()-interval '60 minutes',
        merge_slot_at=now()-interval '50 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [i6.claim.claim_id]);
      assert.equal(entry(await queue(users.served, repo), i6).state, 'lapsed');
      const back = await joined('ci', repo, 9, headI);
      assert.deepEqual(back.merge_queue.map(x => x.state), ['head']);
      assert.deepEqual(await marks(i6), [ref(repo)]);
      assert.deepEqual((await receipts('work_claim_merge_queue_join_by_ci', i6)).map(x => [x.metadata.rejoined, x.metadata.previous_state]), [[false, 'none'], [true, 'lapsed']]);
      await finish(q6, k6, i6);
    });

    await t.test('T7 not served: an account without a resident, a repository it never admitted, another branch stay open', async () => {
      const plain = await claim('plainholder', { trigger_refs: [ref('fixture/join-only-t7')] });
      assert.deepEqual(plain.claim.merge_queue.map(x => [x.ref, x.state]), [[ref('fixture/join-only-t7'), 'head']]);
      const renewed = await renew(plain, { trigger_refs: ['task:t7', ref('fixture/join-only-t7')] });
      assert.deepEqual(renewed.merge_queue.map(x => x.state), ['head']);
      // The served account, a repository the resident has no admission for.
      const fresh = await claim('holder', { trigger_refs: [ref('fixture/join-only-t7-unserved')] });
      assert.deepEqual(fresh.claim.merge_queue.map(x => x.state), ['head']);
      // The served account and repository, a branch the resident does not serve.
      const repo = 'fixture/join-only-t7-branch'; await serve('holder', 'ci', repo);
      const other = await claim('holder', { trigger_refs: [`merge:${repo}:release`] });
      assert.deepEqual(other.claim.merge_queue.map(x => [x.ref, x.state]), [[`merge:${repo}:release`, 'head']]);
      await finish(plain, fresh, other);
    });

    await t.test('T7b a list with a served and an open merge ref loses only the served one', async () => {
      const repo = 'fixture/join-only-t7-mixed'; await serve('holder', 'ci', repo);
      const mixed = await claim('holder', { trigger_refs: [`merge:${repo}:release`, 'task:t7', ref(repo)] });
      assert.deepEqual(mixed.claim.trigger_refs, [`merge:${repo}:release`, 'task:t7'], 'only the served ref is dropped');
      assert.deepEqual(mixed.claim.merge_queue.map(x => [x.ref, x.state]), [[`merge:${repo}:release`, 'head']]);
      await finish(mixed);
    });

    await t.test('T9 replay: the same idempotency_key returns the claim, writes no row and joins nothing', async () => {
      const repo = 'fixture/join-only-t9'; await serve('holder', 'ci', repo);
      const input = claimInput(await task('holder'), { trigger_refs: ['task:t9', ref(repo)] });
      const first = committed(await call('holder', 'clued_work_claim_v1', input));
      const whole = async () => (await admin.query('select to_jsonb(w) v from clued_private.work_claims_v1 w where w.claim_id=$1', [first.claim.claim_id])).rows[0].v;
      const count = async () => (await admin.query('select count(*)::int n from clued_private.work_claims_v1 where user_id=$1', [users.served])).rows[0].n;
      const [rowBefore, countBefore] = [await whole(), await count()];
      const again = committed(await call('holder', 'clued_work_claim_v1', input));
      assert.deepEqual([again.replayed, again.claim.claim_id], [true, first.claim.claim_id]);
      assert.equal(await count(), countBefore, 'no new claim row');
      const rowAfter = await whole();
      // Row by row: the replay may only hand out a new private key.
      const changed = Object.keys(rowAfter).filter(k => JSON.stringify(rowAfter[k]) !== JSON.stringify(rowBefore[k])).sort();
      process.stderr.write('T9 columns a replay changed: ' + JSON.stringify(changed) + '\n');
      assert.deepEqual(changed.filter(k => !['lease_key_hash', 'updated_at'].includes(k)), [], 'a replay changes nothing but the private key');
      assert.equal(again.claim.merge_queue, null, JSON.stringify(again.claim.merge_queue));
      assert.deepEqual(again.claim.trigger_refs, ['task:t9']);
      await assertOut(users.served, repo, { claim: first.claim }, 'the replayed claim');
      await finish({ ...again, who: 'holder' });
    });

    // --- Design 3.4: two behaviours left as they are; these record them and judge nothing. ---
    await t.test('as it is (3.4): after one pull request of a Task merges, the claim joins again for the next one, admitted or not', async () => {
      const repo = 'fixture/join-only-multi'; await serve('holder', 'ci', repo);
      const m = await claim('holder');
      await bound('ci', m, repo, 12, '12'.repeat(20));                 // the Task's second pull request: bound, never admitted
      await admitted('ci', m, repo, 11, '11'.repeat(20)); await joined('ci', repo, 11, '11'.repeat(20));
      const w = await claim('holder');
      await admitted('ci', w, repo, 13, '13'.repeat(20)); await joined('ci', repo, 13, '13'.repeat(20));
      assert.equal((await adopt('ci', repo, 11)).status, 'ok');
      let q = await queue(users.served, repo);
      assert.equal(q.head?.claim_id, w.claim.claim_id);
      assert.deepEqual({ state: entry(q, m).state, position: entry(q, m).position }, { state: 'waiting', position: 2 }, 'M waits again, for a head nobody admitted');
      assert.equal((await adopt('ci', repo, 13)).status, 'ok');
      q = await queue(users.served, repo);
      assert.equal(q.head?.claim_id, m.claim.claim_id, 'and becomes head: ' + JSON.stringify(q));
      await finish(m, w);
    });

    await t.test('as it is (3.4): a claim moved to another Binding (a new execution epoch) keeps its queue place', async () => {
      const repo = 'fixture/join-only-epoch'; await serve('holder', 'ci', repo);
      const e = await claim('holder'), head = '21'.repeat(20);
      await admitted('ci', e, repo, 21, head); await joined('ci', repo, 21, head);
      const epoch = Number((await row(e)).execution_epoch), w0 = await row(e);
      const moved = committed(await call('holder2', 'clued_work_renew_v1', { scope: 'global', claim_id: e.claim.claim_id, fence: Number(w0.fence),
        lease_version: Number(w0.lease_version), lease_key: e.lease_key, progress_ref: `reconnect:${uuid()}`, holder_session_ref: 'session-moved' }));
      assert.equal(moved.transferred, true, JSON.stringify(moved));
      assert.equal(Number((await row(e)).execution_epoch), epoch + 1, 'the admission is no longer of the current epoch');
      const q = await queue(users.served, repo);
      assert.equal(q.head?.claim_id, e.claim.claim_id, 'still head: ' + JSON.stringify(q));
      assert.deepEqual(await marks(e), [ref(repo)]);
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    const stopped = await waitForPidExit(ownPid);
    process.stderr.write('merge-join-only fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    await removeTestDirectory(dir);
    assert.equal(stopped, true, 'this fixture must stop its own PostgreSQL child');
  }
});
