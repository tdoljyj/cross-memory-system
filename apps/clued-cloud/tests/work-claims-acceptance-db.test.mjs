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

// Work Claim Admission v0.1, step 7 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §6): the acceptance-matrix rows that
// currentness-work-claims-db.test.mjs does not exercise. Concurrency rows run
// the two sides on separate connections released together; time is moved by
// writing expires_at, as the step-1 test does.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims acceptance: races, revoked Bindings, verify repeatability, expiry, restore',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-acceptance-'));
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
      values($1,'acceptance@example.invalid',now())`, [userId]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, scopes] of [
      ['A', ['context:read', 'context:write']], ['B', ['context:read', 'context:write']],
      ['C', ['context:read', 'context:write']], ['D', ['context:read', 'context:write']],
      ['verifier', ['context:read']],
    ]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [userId, name, tokens[name], scopes])).rows[0].id;
    }

    const connect = async () => {
      const client = server.getPgClient();
      clients.push(client);
      await client.connect();
      await client.query('set role anon');
      return client;
    };
    const anon = await connect();
    const anon2 = await connect();
    // A distinct GW connection for each original transport preserves real
    // concurrent transactions; CI and permission-negative callers stay anon.
    const workerClients = new Map();
    const workerClient = async (transport) => {
      if (!workerClients.has(transport)) workerClients.set(transport, (async () => {
        const client = server.getPgClient(); clients.push(client);
        await client.connect(); await setWorkerGatewayCaller(client); return client;
      })());
      return await workerClients.get(transport);
    };
    const rpc = async (client, token, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await client.query(`select public.${name}($1,$2) value`, [token,input])).rows[0].value
        : await workerGatewayRpc(await workerClient(client), name, token, input);
    const call = (token, name, input) => rpc(anon, token, name, input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const rejected = (result, code) => {
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.equal(result.error_code, code, JSON.stringify(result));
      return result;
    };
    const createTask = async (title) => committed(await call(tokens.A, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'work claim acceptance fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (client, token, input) => rpc(client, token, 'clued_work_claim_v1', {
      scope: 'global', idempotency_key: uuid(), ...input });
    const release = (token, c) => call(token, 'clued_work_release_v1', {
      scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'abandoned' });
    const verify = (input) => call(tokens.verifier, 'clued_work_verify_v1', { scope: 'global', ...input });
    const expire = (claimId) => admin.query(`update clued_private.work_claims_v1 set
      issued_at=clock_timestamp()-interval '3 hours',expires_at=clock_timestamp()-interval '1 second'
      where claim_id=$1`, [claimId]);
    const liveCount = async (where, params) => (await admin.query(`select count(*)::int n
      from clued_private.work_claims_v1 where status in ('ACTIVE','DRAINING') and ${where}`, params)).rows[0].n;
    // Run both sides of a race together, several rounds: each round must end
    // with exactly one winner and the loser told who holds it.
    const race = async (rounds, makeSides) => {
      for (let round = 0; round < rounds; round += 1) {
        const sides = await makeSides(round);
        const results = await Promise.all(sides.map(({ client, token, input, fn }) =>
          (fn ?? claim)(client, token, input)));
        const winners = results.filter((r) => r.status === 'committed');
        const losers = results.filter((r) => r.status === 'rejected');
        assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
        assert.equal(losers.length, sides.length - 1, `round ${round}: ${JSON.stringify(results)}`);
        await sides.at(-1).after?.(winners[0], losers);
      }
    };

    // --- Row "多资源反序竞争": two Tasks, overlapping write sets declared in
    // opposite order, claimed at the same moment. The per-user lock serializes
    // them: one wins, the other gets work_claim_conflict naming it, no deadlock.
    await race(5, async (round) => {
      const [t1, t2] = [await createTask(`reverse ${round} a`), await createTask(`reverse ${round} b`)];
      const p = [`race/${round}/one.ts`, `race/${round}/two.ts`];
      return [
        { client: anon, token: tokens.A, input: { task_id: t1, write_set: [p[0], p[1]] } },
        { client: anon2, token: tokens.B, input: { task_id: t2, write_set: [p[1], p[0]] },
          async after(winner, losers) {
            assert.equal(losers[0].error_code, 'work_claim_conflict');
            assert.equal(losers[0].conflicts[0].claim_id, winner.claim.claim_id);
            assert.equal(await liveCount('write_set && $1::text[]', [p]), 1);
            committed(await release(winner.claim.holder_binding_id === bindingIds.A ? tokens.A : tokens.B, winner.claim));
          } },
      ];
    });

    // --- Row "不同标题、同意图": two Tasks, disjoint paths, same trigger ref.
    await race(5, async (round) => {
      const [t1, t2] = [await createTask(`ghsa ${round} a`), await createTask(`ghsa ${round} b`)];
      const ref = `ghsa:GHSA-race-${round}`;
      return [
        { client: anon, token: tokens.A, input: { task_id: t1, write_set: [`a/${round}`], trigger_refs: [ref] } },
        { client: anon2, token: tokens.B, input: { task_id: t2, write_set: [`b/${round}`], trigger_refs: [ref] },
          async after(winner, losers) {
            assert.equal(losers[0].error_code, 'work_claim_conflict');
            assert.equal(await liveCount('$1=any(trigger_refs)', [ref]), 1);
            committed(await release(winner.claim.holder_binding_id === bindingIds.A ? tokens.A : tokens.B, winner.claim));
          } },
      ];
    });

    // --- Row "过期 owner、接管": two Hosts take over the same expired claim at
    // once. Exactly one new claim, fence advanced by exactly one.
    await race(3, async (round) => {
      const task = await createTask(`takeover race ${round}`);
      const old = committed(await claim(anon, tokens.C, { task_id: task, write_set: [`takeover/${round}`] })).claim;
      await expire(old.claim_id);
      const input = { scope: 'global', claim_id: old.claim_id };
      return [
        { client: anon, token: tokens.A, input: { ...input, idempotency_key: uuid() },
          fn: (client, token, body) => rpc(client, token, 'clued_work_takeover_v1', body) },
        { client: anon2, token: tokens.B, input: { ...input, idempotency_key: uuid() },
          fn: (client, token, body) => rpc(client, token, 'clued_work_takeover_v1', body),
          async after(winner, losers) {
            assert.equal(winner.claim.fence, old.fence + 1);
            assert.equal(losers[0].error_code, 'work_claim_not_takeover_eligible', JSON.stringify(losers));
            const rows = (await admin.query(`select status,fence::int fence from clued_private.work_claims_v1
              where task_id=$1 order by fence`, [task])).rows;
            assert.deepEqual(rows, [{ status: 'SUPERSEDED', fence: 1 }, { status: 'ACTIVE', fence: 2 }]);
            const v = await verify({ claim_id: old.claim_id });
            assert.ok(v.reasons.includes('fence_superseded'), JSON.stringify(v));
            committed(await release(winner.claim.holder_binding_id === bindingIds.A ? tokens.A : tokens.B, winner.claim));
          } },
      ];
    });

    // --- Row "权限撤销": a revoked Binding can no longer claim, renew, release,
    // take over or verify. Its live claim keeps blocking until the lease ends
    // (bounded by the profile), then another Host takes it over.
    const taskRevoked = await createTask('revoked holder');
    const held = committed(await claim(anon, tokens.D, { task_id: taskRevoked, write_set: ['revoked/**'] })).claim;
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [bindingIds.D]);
    const denied = /binding_not_authorized/;
    const taskAfterRevoke = await createTask('after revoke');
    await assert.rejects(() => claim(anon, tokens.D, { task_id: taskAfterRevoke, write_set: ['x'] }), denied);
    await assert.rejects(() => call(tokens.D, 'clued_work_renew_v1', { scope: 'global', claim_id: held.claim_id,
      fence: held.fence, lease_version: held.lease_version, progress_ref: 'after-revoke' }), denied);
    await assert.rejects(() => release(tokens.D, held), denied);
    await assert.rejects(() => call(tokens.D, 'clued_work_verify_v1', { scope: 'global', claim_id: held.claim_id }), denied);
    rejected(await claim(anon, tokens.A, { task_id: taskRevoked, write_set: ['elsewhere'] }), 'work_claim_conflict');
    rejected(await call(tokens.A, 'clued_work_takeover_v1', { scope: 'global', claim_id: held.claim_id,
      idempotency_key: uuid() }), 'work_claim_still_active');
    const heldRow = (await admin.query(`select expires_at,hard_deadline_at from clued_private.work_claims_v1
      where claim_id=$1`, [held.claim_id])).rows[0];
    assert.ok(heldRow.expires_at - new Date(held.issued_at) <= 7200 * 1000, 'lease bounded by the profile');
    assert.ok(heldRow.hard_deadline_at - new Date(held.issued_at) <= 86400 * 1000, 'hard deadline bounded');
    await expire(held.claim_id);
    const rescued = committed(await call(tokens.A, 'clued_work_takeover_v1', { scope: 'global',
      claim_id: held.claim_id, idempotency_key: uuid() })).claim;
    assert.equal(rescued.fence, held.fence + 1);
    committed(await release(tokens.A, rescued));

    // --- Row "CI gate 对同一 head 重复查询返回同一判定": verify is read-only and
    // repeatable, and leaves no receipt.
    const taskVerify = await createTask('verify repeatability');
    const vc = committed(await claim(anon, tokens.A, { task_id: taskVerify, write_set: ['docs/a.md', 'src/**'] })).claim;
    const receiptsBefore = (await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
    const probe = { claim_id: vc.claim_id, changed_paths: ['docs/a.md', 'src/x/y.ts', 'outside.txt'],
      head_sha: 'abc1234', base_sha: 'def5678' };
    const answers = await Promise.all([verify(probe), verify(probe), rpc(anon2, tokens.verifier,
      'clued_work_verify_v1', { scope: 'global', ...probe })]);
    for (const a of answers) {
      assert.equal(a.verdict, 'REJECTED');
      assert.deepEqual(a.reasons, ['paths_outside_write_set']);
      assert.deepEqual(a.paths_outside_write_set, ['outside.txt']);
    }
    assert.equal((await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n,
      receiptsBefore, 'verify writes no receipt');
    // A write Binding asking verify on a claim id of nobody, or a malformed id.
    assert.deepEqual((await verify({ claim_id: uuid() })).reasons, ['claim_not_found']);
    await assert.rejects(() => verify({ claim_id: 'not-a-uuid' }), /work_claim_id_invalid/);

    // --- Row "cleanup 崩溃 / EXPIRED 清理不删 ACTIVE 行": the sweep marks only
    // due claims EXPIRED, deletes nothing, and leaves live claims untouched.
    const taskSweepA = await createTask('sweep due');
    const taskSweepB = await createTask('sweep live');
    const due = committed(await claim(anon, tokens.B, { task_id: taskSweepA, write_set: ['sweep/due'] })).claim;
    const live = committed(await claim(anon, tokens.B, { task_id: taskSweepB, write_set: ['sweep/live'] })).claim;
    await expire(due.claim_id);
    const rowsBefore = (await admin.query('select count(*)::int n from clued_private.work_claims_v1')).rows[0].n;
    // Every mutating call runs the sweep first; a renewal of the live claim triggers it.
    committed(await call(tokens.B, 'clued_work_renew_v1', { scope: 'global', claim_id: live.claim_id,
      fence: live.fence, lease_version: live.lease_version, progress_ref: 'sweep-progress' }));
    const states = Object.fromEntries((await admin.query(`select claim_id,status from clued_private.work_claims_v1
      where claim_id=any($1::uuid[])`, [[due.claim_id, live.claim_id]])).rows.map((r) => [r.claim_id, r.status]));
    assert.deepEqual(states, { [due.claim_id]: 'EXPIRED', [live.claim_id]: 'ACTIVE' });
    assert.equal((await admin.query('select count(*)::int n from clued_private.work_claims_v1')).rows[0].n, rowsBefore);
    committed(await release(tokens.B, live));

    // --- Row "备份恢复后 max(fence) 不回退": fences are derived from the table,
    // so restoring an older copy lowers max(fence). What must hold is that a
    // claim issued after the backup cannot be admitted after the restore:
    // verify finds no such claim, and the fence a new claim gets again is
    // tied to a different claim_id.
    const taskRestore = await createTask('restore');
    const before = committed(await claim(anon, tokens.A, { task_id: taskRestore, write_set: ['restore/**'] })).claim;
    await admin.query('create table public.work_claims_backup as select * from clued_private.work_claims_v1');
    await expire(before.claim_id);
    const after = committed(await call(tokens.B, 'clued_work_takeover_v1', { scope: 'global',
      claim_id: before.claim_id, idempotency_key: uuid() })).claim;
    assert.equal(after.fence, 2);
    await admin.query(`begin; delete from clued_private.work_claims_v1;
      insert into clued_private.work_claims_v1 select * from public.work_claims_backup; commit`);
    const stale = await verify({ claim_id: after.claim_id, changed_paths: ['restore/x'] });
    assert.deepEqual([stale.verdict, stale.reasons], ['REJECTED', ['claim_not_found']]);
    await expire(before.claim_id);
    const reissued = committed(await call(tokens.C, 'clued_work_takeover_v1', { scope: 'global',
      claim_id: before.claim_id, idempotency_key: uuid() })).claim;
    assert.equal(reissued.fence, 2, 'fence regresses with the restored table (documented limit)');
    assert.notEqual(reissued.claim_id, after.claim_id);
    assert.equal((await verify({ claim_id: reissued.claim_id, changed_paths: ['restore/x'] })).verdict, 'ADMITTED');
    assert.equal((await verify({ claim_id: after.claim_id })).verdict, 'REJECTED');

    // The documented remedy (Owner Decision 2b23eb0c): after a restore the
    // Owner runs scripts/work-claims-after-restore.sql once. Live claims are
    // abandoned and every fence moves above any fence issued before.
    const fencesBefore = (await admin.query('select max(fence)::bigint m from clued_private.work_claims_v1')).rows[0].m;
    await admin.query(await fs.readFile(path.join(root, 'scripts', 'work-claims-after-restore.sql'), 'utf8'));
    const abandoned = (await admin.query(`select status,released_outcome,fence::bigint fence
      from clued_private.work_claims_v1 where claim_id=$1`, [reissued.claim_id])).rows[0];
    assert.deepEqual(abandoned, { status: 'RELEASED', released_outcome: 'abandoned', fence: '1000002' });
    assert.equal((await admin.query(`select count(*)::int n from clued_private.work_claims_v1
      where status in ('ACTIVE','DRAINING')`)).rows[0].n, 0);
    assert.equal((await verify({ claim_id: reissued.claim_id, changed_paths: ['restore/x'] })).verdict, 'REJECTED');
    const fresh = committed(await claim(anon, tokens.A, { task_id: taskRestore, write_set: ['restore/**'] })).claim;
    assert.equal(fresh.fence, 1000003);
    assert.ok(BigInt(fresh.fence) > BigInt(fencesBefore), 'a new fence is above every fence issued before the restore');
    assert.equal((await verify({ claim_id: fresh.claim_id, changed_paths: ['restore/x'] })).verdict, 'ADMITTED');
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
