// A merged pull request ends its claim's merge-slot turn (migration 20261115150000; throughput defect A,
// production 2026-11-15: claim 96373a88 kept one 2-hour turn for #1117-#1126, #1119 merged with 59 minutes of
// it left, the train refused the next front as TRAIN_FRONT_BUDGET_SHORT until the turn lapsed, and the lapsed
// entry stayed out of the queue until the holder renewed by hand). When the merged PR's Task still has another
// active PR, its claim leaves the queue and joins again at the back: claims that waited go first, and a claim
// alone is head again at once with a whole turn. A turn that lapsed at the hard cap (12:46 that day: nothing joined again until
// a manual renew at 13:21) joins again the same way on the duty node's next queue keepalive; an idle lapse stays out.
// A head whose PR cannot land (field #1121) gives way to a waiting claim through the CI door's merge_queue_yield.
// Imported by work-claims-reject-receipts-db.test.mjs, so it runs in the production-schema suite.
import { stopCluster, waitForPidExit } from './cluster-cleanup.mjs';
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
// Each case has its own repository, so its own merge queue: a case that fails leaves nothing in the next one's queue.
let repo = 'fixture/merge-turn';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('a merged PR ends its claim merge-slot turn; the claim joins again at the back', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-merge-turn-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('merge-turn fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (e) { throw new Error('Migration ' + name + ': ' + e.message, { cause: e }); }
    }
    await allowRawTestBindings(admin);
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'merge-turn@example.invalid',now())", [user]);
    const tokens = {}, ids = {};
    for (const [name, scopes] of [['holder', ['context:read', 'context:write']], ['ci', ['context:read']]]) {
      tokens[name] = hash(); ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [user, name, tokens[name], scopes])).rows[0].id;
    }
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [user, ids.ci])).rows[0].id;
    await admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'ci-admission',now(),$3)", [user, ids.ci, roleReceipt]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const call = async (who, name, input) => [...CI_SIGNATURES, PR_LIFECYCLE_REPORT_SIGNATURE].includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const task = async () => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async task_id => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope: 'global', write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'merge-turn fixture', holder_session_ref: uuid(), idempotency_key: uuid() }));
    const authorize = (r, head, pr) => call('holder', 'clued_work_renew_v1', {
      scope: r.claim.context_key, action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      target_branch: 'main', pr_number: pr, idempotency_key: uuid() });
    const resolve = (n, head) => call('ci', 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${n}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main' });
    const release = r => call('holder', 'clued_work_release_v1', { scope: r.claim.context_key, claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    // The holder authorizes a PR head; qualified CI binds it (stage 1) and, for `admit`, admits it.
    const bound = async (r, n, head) => {
      committed(await authorize(r, head, n));
      assert.equal((await resolve(n, head)).binding_status, 'bound');
    };
    const admitted = async (r, n, head) => {
      await bound(r, n, head);
      const result = await call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id, pr_ref: `${repo}#${n}`, head_sha: head,
        base_sha: 'b'.repeat(40), target_branch: 'main', changed_paths: ['fixture/' + r.claim.task_id + '/main.mjs'] });
      assert.equal(result.verdict, 'ADMITTED', JSON.stringify(result));
    };
    // As stage 8 does: the CI puts the claim into merge:<repo>:main.
    const join = async (n, head) => {
      const j = await call('ci', 'clued_work_verify_v1', { action: 'merge_queue_join', scope: 'global', pr_ref: `${repo}#${n}`, head_sha: head });
      assert.equal(j.joined, true, JSON.stringify(j));
    };
    const adopt = n => call('ci', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: `${repo}#${n}`, merge_sha: 'f'.repeat(40) });
    // GitHub shows the PR closed: the resident reports it (20261119140000); giving back a slot ends nothing.
    const reportClosed = n => call('ci', 'clued_work_pr_lifecycle_report_v1', { scope: 'global', repository: repo, prs: [{ pr_number: n, state: 'closed' }] });
    const binding = async n => (await admin.query('select status from clued_private.work_claim_pr_task_bindings_v1 where repo_id=$1 and pr_number=$2', [repo, n])).rows[0]?.status;
    const queue = async () => (await admin.query('select clued_private.work_claim_merge_queue_current_v1($1,$2) v', [user, `merge:${repo}:main`])).rows[0].v;
    const entry = (q, r) => q.entries.find(e => e.claim_id === r.claim.claim_id);
    const queuedAt = async r => (await admin.query('select merge_queued_at from clued_private.work_claims_v1 where claim_id=$1', [r.claim.claim_id])).rows[0].merge_queued_at;
    const now = async () => (await admin.query('select clock_timestamp() t')).rows[0].t;
    // The claim has been head for 110 minutes of its 2-hour hard cap (production: 59 minutes were left when #1119 merged).
    const ageTurn = r => admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '110 minutes',
      merge_slot_taken_at=now()-interval '110 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [r.claim.claim_id]);

    await t.test('a merge with another active PR of the Task: the claim that waited goes first, then a whole new turn', async () => {
      const a = await claim(await task()), headA = '21'.repeat(20), other = '22'.repeat(20);
      await bound(a, 22, other); await admitted(a, 21, headA);
      await join(21, headA);
      const b = await claim(await task()), headB = '23'.repeat(20);
      await admitted(b, 23, headB); await join(23, headB);
      await ageTurn(a);
      const before = await queue();
      assert.equal(before.head.claim_id, a.claim.claim_id, JSON.stringify(before));
      assert.ok(Date.parse(before.head.until) - Date.now() < 11 * 60_000, 'A has about 10 minutes of its turn left');
      assert.equal(entry(before, b).state, 'waiting');

      const mergedAt = await now();
      const answer = await adopt(21);
      assert.equal(answer.status, 'ok', JSON.stringify(answer));
      assert.equal(answer.merge_slot_returned, undefined, 'the slot is not returned: the claim stays queued');
      assert.equal(await binding(21), 'merged'); assert.equal(await binding(22), 'active');

      const after = await queue();
      assert.equal(after.head.claim_id, b.claim.claim_id, 'the claim that waited is head now: ' + JSON.stringify(after));
      assert.deepEqual({ state: entry(after, a).state, position: entry(after, a).position }, { state: 'waiting', position: 2 });
      assert.ok(await queuedAt(a) >= mergedAt, 'A joined again at the back when its PR merged');
      const rejoined = (await admin.query("select binding_id,metadata from public.clued_audit_receipts where operation='work_claim_merge_queue_rejoin' and object_id=$1",
        [a.claim.claim_id])).rows;
      assert.equal(rejoined.length, 1); assert.equal(rejoined[0].binding_id, ids.ci);
      assert.equal(rejoined[0].metadata.receipt_kind, 'WORK_CLAIM_MERGE_QUEUE_REJOINED'); assert.equal(rejoined[0].metadata.merged_pr, `${repo}#21`);
      assert.equal(rejoined[0].metadata.why, 'merged');

      // B lands its only PR and leaves: A is head again with a whole new turn, not the rest of the old one.
      assert.equal((await adopt(23)).status, 'ok');
      const turn = await queue();
      assert.equal(turn.head.claim_id, a.claim.claim_id, JSON.stringify(turn));
      assert.ok(Date.parse(turn.head.since) >= mergedAt.getTime(), 'the turn starts after the merge');
      assert.ok(Date.parse(turn.head.until) - Date.now() > 40 * 60_000, 'a whole renewal window, far past the old turn end');
      committed(await release(a));
    });

    await t.test('a claim alone is head again at once with a whole turn; a closed PR leaves the turn as it was', async () => {
      repo = 'fixture/merge-turn-alone';
      const a = await claim(await task()), headA = '31'.repeat(20);
      await bound(a, 32, '32'.repeat(20)); await bound(a, 33, '33'.repeat(20)); await admitted(a, 31, headA);
      await join(31, headA);
      await ageTurn(a);
      const queuedBefore = await queuedAt(a);
      assert.equal((await reportClosed(33)).status, 'ok'); assert.equal(await binding(33), 'closed');
      assert.deepEqual(await queuedAt(a), queuedBefore, 'a closed PR does not end the turn');
      const mergedAt = await now();
      assert.equal((await adopt(31)).status, 'ok');
      const q = await queue();
      assert.equal(q.head.claim_id, a.claim.claim_id, JSON.stringify(q));
      assert.ok(Date.parse(q.head.since) >= mergedAt.getTime(), 'a new turn from the merge: ' + JSON.stringify(q.head));
      assert.ok(Date.parse(q.head.until) - Date.now() > 40 * 60_000, 'time for the next front batch');
      committed(await release(a));
    });
    await t.test('a turn that lapsed at the hard cap joins again on the next keepalive; an idle lapse stays out', async () => {
      repo = 'fixture/merge-turn-cap';
      const keepalive = prs => call('ci', 'clued_work_verify_v1', { action: 'merge_queue_keepalive', scope: 'global', repository: repo, pr_refs: prs.map(n => `${repo}#${n}`) });
      const a = await claim(await task()), headA = '41'.repeat(20);
      await admitted(a, 41, headA); await join(41, headA);
      // The CI kept reporting (renewal clock past the cap), so the 2-hour cap ended the turn a minute ago (production: 12:46:03).
      await admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '121 minutes',merge_slot_taken_at=now()-interval '121 minutes',
        merge_slot_at=now()-interval '10 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [a.claim.claim_id]);
      const refs = (await admin.query('select trigger_refs from clued_private.work_claims_v1 where claim_id=$1', [a.claim.claim_id])).rows[0].trigger_refs;
      const lapsed = await queue();
      assert.equal(lapsed.head, null, JSON.stringify(lapsed)); assert.equal(entry(lapsed, a).state, 'lapsed');
      const at = await now();
      const kept = await keepalive([41]);
      assert.equal(kept.status, 'ok', JSON.stringify(kept));
      const q = await queue();
      assert.equal(q.head?.claim_id, a.claim.claim_id, 'the claim is head again: ' + JSON.stringify(q));
      assert.ok(Date.parse(q.head.since) >= at.getTime() && Date.parse(q.head.until) - Date.now() > 40 * 60_000, JSON.stringify(q.head));
      assert.deepEqual((await admin.query('select trigger_refs from clued_private.work_claims_v1 where claim_id=$1', [a.claim.claim_id])).rows[0].trigger_refs, refs,
        'trigger_refs end as they were (no execution admission changes)');
      const rejoined = (await admin.query("select metadata from public.clued_audit_receipts where operation='work_claim_merge_queue_rejoin' and object_id=$1", [a.claim.claim_id])).rows;
      assert.deepEqual(rejoined.map(r => r.metadata.why), ['hard_cap']);
      assert.equal((await keepalive([41])).status, 'ok');
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where operation='work_claim_merge_queue_rejoin' and object_id=$1", [a.claim.claim_id])).rows[0].n,
        1, 'a head is not joined again');
      committed(await release(a));

      // Idle: the renewal clock ran out before the cap; no keepalive brings it back.
      repo = 'fixture/merge-turn-idle';
      const c = await claim(await task()), headC = '43'.repeat(20);
      await admitted(c, 43, headC); await join(43, headC);
      await admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '60 minutes',merge_slot_taken_at=now()-interval '60 minutes',
        merge_slot_at=now()-interval '50 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [c.claim.claim_id]);
      assert.equal(entry(await queue(), c).state, 'lapsed');
      assert.equal((await keepalive([43])).status, 'ok');
      assert.equal(entry(await queue(), c).state, 'lapsed', 'an idle lapse is not revived');
      committed(await release(c));
    });
    await t.test('a head whose PR cannot land yields to a waiting claim; alone or not head, nothing moves', async () => {
      repo = 'fixture/merge-turn-yield';
      const yieldSlot = (n, head) => call('ci', 'clued_work_verify_v1', { action: 'merge_queue_yield', scope: 'global', pr_ref: `${repo}#${n}`, head_sha: head });
      const a = await claim(await task()), headA = '51'.repeat(20);
      await admitted(a, 51, headA); await join(51, headA);
      assert.deepEqual(await yieldSlot(51, headA), { status: 'ok', yielded: false, reason: 'nobody_waiting', claim_id: a.claim.claim_id, pr_ref: `${repo}#51`, head_sha: headA });
      const b = await claim(await task()), headB = '52'.repeat(20);
      await admitted(b, 52, headB); await join(52, headB);
      assert.equal((await yieldSlot(52, headB)).reason, 'not_head');
      const refs = (await admin.query('select trigger_refs from clued_private.work_claims_v1 where claim_id=$1', [a.claim.claim_id])).rows[0].trigger_refs;
      const y = await yieldSlot(51, headA);
      assert.equal(y.yielded, true, JSON.stringify(y));
      const q = await queue();
      assert.equal(q.head.claim_id, b.claim.claim_id, JSON.stringify(q));
      assert.deepEqual({ state: entry(q, a).state, position: entry(q, a).position }, { state: 'waiting', position: 2 });
      assert.deepEqual((await admin.query('select trigger_refs from clued_private.work_claims_v1 where claim_id=$1', [a.claim.claim_id])).rows[0].trigger_refs, refs);
      const why = (await admin.query("select metadata from public.clued_audit_receipts where operation='work_claim_merge_queue_rejoin' and object_id=$1", [a.claim.claim_id])).rows;
      assert.deepEqual(why.map(r => [r.metadata.why, r.metadata.pr, r.metadata.head_sha]), [['cannot_land', `${repo}#51`, headA]]);
      committed(await release(a)); committed(await release(b));
    });

    await t.test('the keepalive and the CI door carry their calls after every migration', async () => {
      const src = async sig => (await admin.query('select prosrc from pg_proc where oid=$1::regprocedure', [sig])).rows[0].prosrc;
      assert.match(await src('clued_private.work_claim_merge_queue_keepalive_v1(public.clued_agent_bindings,jsonb)'),
        /perform clued_private\.work_claim_merge_cap_rejoin_v1\(b,v_scope,v_prefix,v_prs\);/);
      assert.match(await src('clued_private.work_claim_ci_command_v1(text,jsonb)'), /if op='merge_queue_yield' then\s+return clued_private\.work_claim_merge_queue_yield_v1\(b,p_input\);/);
    });

  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    const stopped = await waitForPidExit(ownPid);
    process.stderr.write('merge-turn fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped, true, 'this fixture must stop its own PostgreSQL child');
  }
});
