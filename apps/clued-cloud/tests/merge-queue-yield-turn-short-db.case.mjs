// merge_queue_yield reason turn_short (migration 20261119120000; Fable 2026-11-19). Production 2026-11-19 (Beijing): claim 28ab365c
// was head from 07:32:36 (2-hour hard cap), used 64 minutes of the turn for #1169 and was rebound to #1173; from 08:40:24 the train
// found less of the turn left than a front batch needs (TRAIN_FRONT_BUDGET_SHORT) every round, and nothing ended the turn: the
// cannot_land yield refuses a head nobody waits behind (nobody_waiting), and the hard-cap rejoin only takes an entry that lapsed
// exactly at the cap. A person gave the claim up, claimed again, authorized the head again and edited the PR body. Now the train
// sends reason turn_short: the head joins again even alone (head again at once with a whole turn), behind waiting claims otherwise.
// Imported by work-claims-reject-receipts-db.test.mjs, so it runs in the production-schema suite.
import { stopCluster, waitForPidExit, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
// Each case has its own repository, so its own merge queue.
let repo = 'fixture/turn-short';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('merge_queue_yield turn_short: a head whose turn is too short joins again, alone or behind waiting claims', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-turn-short-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('turn-short fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
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
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'turn-short@example.invalid',now())", [user]);
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
    const call = async (who, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const task = async () => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async task_id => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope: 'global', write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'turn-short fixture', holder_session_ref: uuid(), idempotency_key: uuid() }));
    const authorize = (r, head, pr) => call('holder', 'clued_work_renew_v1', {
      scope: r.claim.context_key, action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      target_branch: 'main', pr_number: pr, idempotency_key: uuid() });
    const resolve = (n, head) => call('ci', 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${n}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main' });
    const release = r => call('holder', 'clued_work_release_v1', { scope: r.claim.context_key, claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    const admitted = async (r, n, head) => {
      committed(await authorize(r, head, n));
      assert.equal((await resolve(n, head)).binding_status, 'bound');
      const result = await call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id, pr_ref: `${repo}#${n}`, head_sha: head,
        base_sha: 'b'.repeat(40), target_branch: 'main', changed_paths: ['fixture/' + r.claim.task_id + '/main.mjs'] });
      assert.equal(result.verdict, 'ADMITTED', JSON.stringify(result));
    };
    const join = async (n, head) => {
      const j = await call('ci', 'clued_work_verify_v1', { action: 'merge_queue_join', scope: 'global', pr_ref: `${repo}#${n}`, head_sha: head });
      assert.equal(j.joined, true, JSON.stringify(j));
    };
    const yieldSlot = (n, head, extra = {}) => call('ci', 'clued_work_verify_v1', { action: 'merge_queue_yield', scope: 'global', pr_ref: `${repo}#${n}`, head_sha: head, ...extra });
    const queue = async () => (await admin.query('select clued_private.work_claim_merge_queue_current_v1($1,$2) v', [user, `merge:${repo}:main`])).rows[0].v;
    const entry = (q, r) => q.entries.find(e => e.claim_id === r.claim.claim_id);
    const slot = async r => (await admin.query('select merge_slot_taken_at,merge_slot_hard_cap_seconds,trigger_refs from clued_private.work_claims_v1 where claim_id=$1',
      [r.claim.claim_id])).rows[0];
    const rejoins = async r => (await admin.query("select binding_id,metadata from public.clued_audit_receipts where operation='work_claim_merge_queue_rejoin' and object_id=$1",
      [r.claim.claim_id])).rows;
    const now = async () => (await admin.query('select clock_timestamp() t')).rows[0].t;
    // Field replay: the head has used 68 minutes of its 2-hour hard cap (52 left; a front batch needs 64.5).
    const ageTurn = r => admin.query(`update clued_private.work_claims_v1 set merge_queued_at=now()-interval '68 minutes',
      merge_slot_taken_at=now()-interval '68 minutes',merge_slot_hard_cap_seconds=7200 where claim_id=$1`, [r.claim.claim_id]);

    await t.test('alone: turn_short starts a whole new turn for the same claim at once; without it nothing moves', async () => {
      repo = 'fixture/turn-short-alone';
      const a = await claim(await task()), headA = '61'.repeat(20);
      await admitted(a, 61, headA); await join(61, headA);
      await ageTurn(a);
      assert.equal((await yieldSlot(61, headA)).reason, 'nobody_waiting', 'cannot_land (the default) is unchanged');
      assert.equal((await yieldSlot(61, headA, { reason: 'cannot_land' })).reason, 'nobody_waiting');
      assert.equal((await rejoins(a)).length, 0);
      const before = await slot(a), at = await now();
      const y = await yieldSlot(61, headA, { reason: 'turn_short' });
      assert.equal(y.status, 'ok', JSON.stringify(y)); assert.equal(y.yielded, true, JSON.stringify(y)); assert.equal(y.claim_id, a.claim.claim_id);
      const q = await queue();
      assert.equal(q.head?.claim_id, a.claim.claim_id, 'still head: ' + JSON.stringify(q));
      const after = await slot(a);
      assert.ok(after.merge_slot_taken_at >= at, `a new turn from the yield: ${after.merge_slot_taken_at} >= ${at}`);
      assert.equal(after.merge_slot_hard_cap_seconds, null, 'no hard cap until the next touch');
      assert.ok(Date.parse(q.head.since) >= at.getTime() && Date.parse(q.head.until) - Date.now() > 40 * 60_000, JSON.stringify(q.head));
      assert.deepEqual(after.trigger_refs, before.trigger_refs, 'trigger_refs end as they were');
      const r = await rejoins(a);
      assert.deepEqual(r.map(x => [x.binding_id, x.metadata.receipt_kind, x.metadata.why, x.metadata.pr, x.metadata.head_sha]),
        [[ids.ci, 'WORK_CLAIM_MERGE_QUEUE_REJOINED', 'turn_short', `${repo}#61`, headA]]);
      committed(await release(a));
    });

    await t.test('behind a waiting claim: the waiting claim is head, the yielding one waits at the back', async () => {
      repo = 'fixture/turn-short-waiting';
      const a = await claim(await task()), headA = '71'.repeat(20);
      await admitted(a, 71, headA); await join(71, headA);
      const b = await claim(await task()), headB = '72'.repeat(20);
      await admitted(b, 72, headB); await join(72, headB);
      await ageTurn(a);
      assert.equal((await yieldSlot(72, headB, { reason: 'turn_short' })).reason, 'not_head', 'only the head may end its turn');
      const y = await yieldSlot(71, headA, { reason: 'turn_short' });
      assert.equal(y.yielded, true, JSON.stringify(y));
      const q = await queue();
      assert.equal(q.head.claim_id, b.claim.claim_id, JSON.stringify(q));
      assert.deepEqual({ state: entry(q, a).state, position: entry(q, a).position }, { state: 'waiting', position: 2 });
      assert.deepEqual((await rejoins(a)).map(x => x.metadata.why), ['turn_short']);
      assert.deepEqual(await rejoins(b), []);
      committed(await release(a)); committed(await release(b));
    });

    await t.test('any other reason is refused (22023) and writes nothing', async () => {
      repo = 'fixture/turn-short-invalid';
      const a = await claim(await task()), headA = '81'.repeat(20);
      await admitted(a, 81, headA); await join(81, headA);
      for (const reason of ['whatever', '', null, 7, ['turn_short']])
        await assert.rejects(() => yieldSlot(81, headA, { reason }), { code: '22023' }, JSON.stringify(reason));
      assert.deepEqual(await rejoins(a), []);
      committed(await release(a));
    });

    await t.test('the CI door still carries merge_queue_yield, and the yield knows turn_short, after every migration', async () => {
      const src = async sig => (await admin.query('select prosrc from pg_proc where oid=$1::regprocedure', [sig])).rows[0].prosrc;
      assert.match(await src('clued_private.work_claim_ci_command_v1(text,jsonb)'), /if op='merge_queue_yield' then\s+return clued_private\.work_claim_merge_queue_yield_v1\(b,p_input\);/);
      assert.match(await src('clued_private.work_claim_merge_queue_yield_v1(public.clued_agent_bindings,jsonb)'), /'turn_short'/);
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    const stopped = await waitForPidExit(ownPid);
    process.stderr.write('turn-short fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped, true, 'this fixture must stop its own PostgreSQL child');
  }
});
