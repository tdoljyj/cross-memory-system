import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Work Claim Admission v0.1, step 1 (development/contracts/execution-admission/
// WorkClaimAdmission.v0.1.md §6 acceptance matrix). Every scenario below is a
// row of that matrix or a precondition for one.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');


test('work claims: one live claim per task/write set/trigger, progress-gated renewal, fenced takeover',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-'));
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
    const otherUserId = uuid();
    const hostA = hash();
    const hostB = hash();
    const hostC = hash();
    const verifier = hash();
    const otherUser = hash();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims@example.invalid',now()),($2,'other@example.invalid',now())`, [userId, otherUserId]);
    const bindingIds = {};
    for (const [name, token, scopes, owner] of [
      ['Host A', hostA, ['context:read', 'context:write'], userId],
      ['Host B', hostB, ['context:read', 'context:write'], userId],
      ['Host C', hostC, ['context:read', 'context:write'], userId],
      ['CI verifier', verifier, ['context:read'], userId],
      ['Other user', otherUser, ['context:read', 'context:write'], otherUserId],
    ]) {
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [owner, name, token, scopes])).rows[0].id;
    }

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
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
    const createTask = async (token, title) => {
      const result = await call(token, 'clued_record_mutate', {
        operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
        scope: 'global', idempotency_key: uuid(), authority: 'observed',
        confidence_reason: 'work claim fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
      });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return result.target_refs[0].id;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const rejected = (result, code) => {
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.equal(result.error_code, code, JSON.stringify(result));
      return result;
    };

    const taskNext = await createTask(hostA, 'Upgrade next for GHSA-vcvr-r3jv-pc5j');
    const taskGuard = await createTask(hostA, 'Task dependency target guard');
    const taskStorage = await createTask(hostA, 'Storage N4 budgets');
    const taskRace = await createTask(hostA, 'Raced task');
    const taskSpare1 = await createTask(hostA, 'Spare 1');
    const taskSpare2 = await createTask(hostA, 'Spare 2');
    const taskSpare3 = await createTask(hostA, 'Spare 3');
    const otherUserTask = await createTask(otherUser, 'Other user task');

    const nextPaths = ['apps/clued-cloud/package-lock.json', 'apps/clued-cloud/package.json']; // sorted, as the server returns them
    const ghsa = 'ghsa:GHSA-vcvr-r3jv-pc5j';

    // --- Claim: Host A takes the next upgrade. Paths come back normalized. ---
    const keyA = `host-a:${taskNext}:claim`;
    const claimA = committed(await call(hostA, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskNext, idempotency_key: keyA, base_commit: 'f7ba6ff312aa0e90095db1e28f5937920f30de3a',
      write_set: ['./apps/clued-cloud/package-lock.json', '/apps/clued-cloud//package.json'],
      trigger_refs: ['GHSA:GHSA-vcvr-r3jv-pc5j', 'ci:trivy@f7ba6ff'], holder_session_ref: 'session-a',
    })).claim;
    assert.equal(claimA.fence, 1);
    assert.equal(claimA.lease_version, 1);
    assert.equal(claimA.status, 'ACTIVE');
    assert.deepEqual(claimA.write_set, nextPaths);
    assert.deepEqual(claimA.trigger_refs, ['ci:trivy@f7ba6ff', ghsa]);
    assert.ok(claimA.receipt_id);
    assert.ok(new Date(claimA.expires_at) > new Date(claimA.issued_at));
    assert.ok(new Date(claimA.hard_deadline_at) >= new Date(claimA.expires_at));

    // --- Idempotent replay returns the same claim, not a second one. ---
    const replay = committed(await call(hostA, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskNext, idempotency_key: keyA, write_set: nextPaths,
    }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.claim.claim_id, claimA.claim_id);

    // --- Conflicts (443/444/445 replay): same trigger, different title and task. ---
    const byTrigger = rejected(await call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskGuard, idempotency_key: `host-b:${taskGuard}:trigger`,
      write_set: ['apps/clued-cloud/supabase/migrations/20261001030000_guard.sql'], trigger_refs: [ghsa],
    }), 'work_claim_conflict');
    assert.equal(byTrigger.conflicts.length, 1);
    assert.equal(byTrigger.conflicts[0].claim_id, claimA.claim_id);
    assert.deepEqual(byTrigger.conflicts[0].overlap, { same_task: false, paths: [], trigger_refs: [ghsa] });

    // Same lockfile reached through a glob, no shared trigger.
    const byPath = rejected(await call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskGuard, idempotency_key: `host-b:${taskGuard}:glob`,
      write_set: ['apps/clued-cloud/**'],
    }), 'work_claim_conflict');
    assert.deepEqual(byPath.conflicts[0].overlap.paths, nextPaths);
    // A concrete path against a claim that holds a glob also conflicts (reverse direction).
    const globHolder = committed(await call(hostC, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskSpare3, idempotency_key: `host-c:${taskSpare3}:glob`,
      write_set: ['kernel/**'],
    })).claim;
    rejected(await call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskSpare1, idempotency_key: `host-b:${taskSpare1}:under-glob`,
      write_set: ['kernel/domain/attempt-fsm.mjs'],
    }), 'work_claim_conflict');
    committed(await call(hostC, 'clued_work_release_v1', {
      scope: 'global', claim_id: globHolder.claim_id, fence: globHolder.fence, outcome: 'abandoned',
    }));

    // Same task, disjoint everything else.
    const byTask = rejected(await call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskNext, idempotency_key: `host-b:${taskNext}:same-task`,
      write_set: ['docs/README.md'],
    }), 'work_claim_conflict');
    assert.equal(byTask.conflicts[0].overlap.same_task, true);

    // Disjoint work proceeds.
    const claimB = committed(await call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskGuard, idempotency_key: `host-b:${taskGuard}:claim`,
      write_set: ['apps/clued-cloud/supabase/migrations/20261001030000_guard.sql',
        'apps/clued-cloud/tests/task-dependency-guard-db.test.mjs'],
      trigger_refs: ['issue:depends_on_unknown'],
    })).claim;
    assert.equal(claimB.fence, 1);

    // --- Input validation raises, never silently widens. ---
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: `host-b:${taskStorage}:bad-path`,
      write_set: ['../etc/passwd'],
    }), /work_claim_write_set_invalid/);
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: `host-b:${taskStorage}:empty`, write_set: [],
    }), /work_claim_write_set_invalid/);
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: `host-b:${taskStorage}:bad-trigger`,
      write_set: ['a/b'], trigger_refs: ['no-kind-separator'],
    }), /work_claim_trigger_refs_invalid/);
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: 'short', write_set: ['a/b'],
    }), /work_claim_idempotency_key_invalid/);
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: `host-b:${taskStorage}:lease`,
      write_set: ['a/b'], lease_seconds: 999999,
    }), /work_claim_lease_seconds_invalid/);
    // A task of another user, a missing task, or a non-task record is unavailable.
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: otherUserTask, idempotency_key: `host-b:${otherUserTask}:foreign`, write_set: ['a/b'],
    }), /work_claim_task_unavailable/);
    await assert.rejects(() => call(hostB, 'clued_work_claim_v1', {
      scope: 'global', task_id: uuid(), idempotency_key: `host-b:missing:claim`, write_set: ['a/b'],
    }), /work_claim_task_unavailable/);
    // A read-only Binding cannot claim; the other user cannot touch this user's claims.
    await assert.rejects(() => call(verifier, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: 'verifier:claim:attempt', write_set: ['a/b'],
    }), /binding_not_authorized/);
    rejected(await call(otherUser, 'clued_work_renew_v1', {
      scope: 'global', claim_id: claimA.claim_id, fence: 1, lease_version: 1, progress_ref: 'x',
    }), 'work_claim_not_found');

    // --- Concurrent claim on the same task from two connections: exactly one wins. ---
    const anon2 = server.getPgClient();
    clients.push(anon2);
    await anon2.connect();
    await anon2.query('set role anon');
    const raced = await Promise.all([
      rpc(anon, hostB, 'clued_work_claim_v1', { scope: 'global', task_id: taskRace,
        idempotency_key: `host-b:${taskRace}:race`, write_set: ['race/b.txt'] }),
      rpc(anon2, hostC, 'clued_work_claim_v1', { scope: 'global', task_id: taskRace,
        idempotency_key: `host-c:${taskRace}:race`, write_set: ['race/c.txt'] }),
    ]);
    const winners = raced.filter((r) => r.status === 'committed');
    const losers = raced.filter((r) => r.status === 'rejected' && r.error_code === 'work_claim_conflict');
    assert.equal(winners.length, 1, JSON.stringify(raced));
    assert.equal(losers.length, 1, JSON.stringify(raced));
    assert.equal(losers[0].conflicts[0].claim_id, winners[0].claim.claim_id);
    const raceClaim = winners[0].claim;
    const raceWinnerToken = raceClaim.holder_binding_id === bindingIds['Host B'] ? hostB : hostC;
    assert.equal((await admin.query(`select count(*)::int n from clued_private.work_claims_v1
      where task_id=$1 and status in ('ACTIVE','DRAINING')`, [taskRace])).rows[0].n, 1);

    // --- Verify (the CI gate's call): read-only Binding, exact path coverage. ---
    const verify = (input) => call(verifier, 'clued_work_verify_v1', { scope: 'global', ...input });
    let v = await verify({ claim_id: claimA.claim_id, changed_paths: nextPaths, head_sha: '3329174e', base_sha: 'f7ba6ff3' });
    assert.equal(v.verdict, 'ADMITTED', JSON.stringify(v));
    assert.deepEqual(v.reasons, []);
    assert.equal(v.current_fence, 1);
    v = await verify({ claim_id: claimA.claim_id, changed_paths: [...nextPaths, 'apps/clued-cloud/supabase/migrations/x.sql'] });
    assert.equal(v.verdict, 'REJECTED');
    assert.deepEqual(v.reasons, ['paths_outside_write_set']);
    assert.deepEqual(v.paths_outside_write_set, ['apps/clued-cloud/supabase/migrations/x.sql']);
    v = await verify({ claim_id: uuid(), changed_paths: nextPaths });
    assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['claim_not_found']]);
    // A glob in the write set covers concrete changed paths.
    const dirClaim = committed(await call(hostC, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskSpare2, idempotency_key: `host-c:${taskSpare2}:dir`,
      write_set: ['docs/runbooks/**', 'scripts/hooks/*.py'],
    })).claim;
    v = await verify({ claim_id: dirClaim.claim_id, changed_paths: ['docs/runbooks/a/b.md', 'scripts/hooks/guard.py'] });
    assert.equal(v.verdict, 'ADMITTED', JSON.stringify(v));
    v = await verify({ claim_id: dirClaim.claim_id, changed_paths: ['scripts/hooks/nested/guard.py'] });
    assert.deepEqual(v.reasons, ['paths_outside_write_set']);
    committed(await call(hostC, 'clued_work_release_v1', {
      scope: 'global', claim_id: dirClaim.claim_id, fence: dirClaim.fence, outcome: 'completed',
    }));

    // --- Renewal needs progress; heartbeat alone is refused. ---
    const renew = (token, input) => call(token, 'clued_work_renew_v1', { scope: 'global', ...input });
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 1 }), 'work_claim_no_progress');
    rejected(await renew(hostB, { claim_id: claimA.claim_id, fence: 1, lease_version: 1, progress_ref: 'sha-1' }), 'work_claim_not_holder');
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 2, lease_version: 1, progress_ref: 'sha-1' }), 'work_claim_fence_mismatch');
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 7, progress_ref: 'sha-1' }), 'work_claim_version_conflict');
    let renewed = committed(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 1, progress_ref: 'sha-1' })).claim;
    assert.equal(renewed.lease_version, 2);
    assert.equal(renewed.fence, 1);
    assert.equal(renewed.renewals, 1);
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 2, progress_ref: 'sha-1' }), 'work_claim_no_progress');

    // Scope expansion re-runs conflict detection against other live claims.
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 2, progress_ref: 'sha-2',
      write_set: [...nextPaths, 'apps/clued-cloud/tests/task-dependency-guard-db.test.mjs'] }), 'work_claim_conflict');
    renewed = committed(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 2, progress_ref: 'sha-2',
      write_set: [...nextPaths, 'apps/clued-cloud/README.md'] })).claim;
    assert.equal(renewed.lease_version, 3);
    assert.ok(renewed.write_set.includes('apps/clued-cloud/README.md'));
    v = await verify({ claim_id: claimA.claim_id, changed_paths: ['apps/clued-cloud/README.md'] });
    assert.equal(v.verdict, 'ADMITTED');

    // Renewal budget and hard deadline come from the profile, not from the caller.
    await admin.query('update clued_private.work_claims_v1 set renewals=12 where claim_id=$1', [claimA.claim_id]);
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 3, progress_ref: 'sha-3' }), 'work_claim_renewal_budget_exhausted');
    await admin.query('update clued_private.work_claims_v1 set renewals=0,expires_at=hard_deadline_at where claim_id=$1', [claimA.claim_id]);
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 3, progress_ref: 'sha-3' }), 'work_claim_hard_deadline');
    await admin.query(`update clued_private.work_claims_v1 set expires_at=issued_at+interval '1 hour' where claim_id=$1`, [claimA.claim_id]);

    // --- Takeover of a live claim is refused; of an expired one, fenced. ---
    rejected(await call(hostB, 'clued_work_takeover_v1', {
      scope: 'global', claim_id: claimA.claim_id, idempotency_key: `host-b:${claimA.claim_id}:early`,
    }), 'work_claim_still_active');
    // Time passes: A's lease lapses while A is partitioned.
    await admin.query(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '3 hours',
      expires_at=clock_timestamp()-interval '1 second' where claim_id=$1`, [claimA.claim_id]);
    v = await verify({ claim_id: claimA.claim_id, changed_paths: nextPaths });
    assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['claim_not_current']]);
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 3, progress_ref: 'sha-4' }), 'work_claim_expired');
    assert.equal((await admin.query('select status from clued_private.work_claims_v1 where claim_id=$1', [claimA.claim_id])).rows[0].status, 'EXPIRED');
    assert.equal((await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where operation='work_claim_expire' and object_id=$1`, [claimA.claim_id])).rows[0].n, 1);

    const keyTake = `host-b:${claimA.claim_id}:takeover`;
    const taken = committed(await call(hostB, 'clued_work_takeover_v1', {
      scope: 'global', claim_id: claimA.claim_id, idempotency_key: keyTake, holder_session_ref: 'session-b',
    }));
    const claimA2 = taken.claim;
    assert.equal(claimA2.task_id, taskNext);
    assert.equal(claimA2.fence, 2);
    assert.equal(claimA2.holder_binding_id, bindingIds['Host B']);
    assert.deepEqual(claimA2.write_set, renewed.write_set, 'takeover inherits the write set it supersedes');
    const old = (await admin.query('select status,superseded_by from clued_private.work_claims_v1 where claim_id=$1', [claimA.claim_id])).rows[0];
    assert.equal(old.status, 'SUPERSEDED');
    assert.equal(old.superseded_by, claimA2.claim_id);
    // Replaying the takeover returns the same new claim.
    const takenAgain = committed(await call(hostB, 'clued_work_takeover_v1', {
      scope: 'global', claim_id: claimA.claim_id, idempotency_key: keyTake,
    }));
    assert.equal(takenAgain.replayed, true);
    assert.equal(takenAgain.claim.claim_id, claimA2.claim_id);
    // The old holder recovers: its fence is dead at the verifier and at renew.
    v = await verify({ claim_id: claimA.claim_id, changed_paths: nextPaths });
    assert.equal(v.verdict, 'REJECTED');
    assert.ok(v.reasons.includes('fence_superseded'), JSON.stringify(v));
    assert.ok(v.reasons.includes('claim_not_current'));
    assert.equal(v.current_fence, 2);
    rejected(await renew(hostA, { claim_id: claimA.claim_id, fence: 1, lease_version: 3, progress_ref: 'sha-5' }), 'work_claim_not_active');
    rejected(await call(hostC, 'clued_work_takeover_v1', {
      scope: 'global', claim_id: claimA.claim_id, idempotency_key: `host-c:${claimA.claim_id}:late`,
    }), 'work_claim_not_takeover_eligible');
    v = await verify({ claim_id: claimA2.claim_id, changed_paths: nextPaths });
    assert.equal(v.verdict, 'ADMITTED');
    // A fresh claim on the same task continues the fence sequence after release.
    committed(await call(hostB, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimA2.claim_id, fence: 2, outcome: 'completed', evidence_ref: 'pr:443',
    }));
    const claimA3 = committed(await call(hostC, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskNext, idempotency_key: `host-c:${taskNext}:after-release`, write_set: nextPaths,
    })).claim;
    assert.equal(claimA3.fence, 3);
    v = await verify({ claim_id: claimA2.claim_id, changed_paths: nextPaths });
    assert.ok(v.reasons.includes('fence_superseded'));

    // --- Release: holder only, fence-checked; draining keeps blocking. ---
    rejected(await call(hostA, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimB.claim_id, fence: 1, outcome: 'completed',
    }), 'work_claim_not_holder');
    rejected(await call(hostB, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimB.claim_id, fence: 9, outcome: 'completed',
    }), 'work_claim_fence_mismatch');
    await assert.rejects(() => call(hostB, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimB.claim_id, fence: 1, outcome: 'done',
    }), /work_claim_outcome_invalid/);
    const draining = committed(await call(hostB, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimB.claim_id, fence: 1, outcome: 'draining',
    })).claim;
    assert.equal(draining.status, 'DRAINING');
    rejected(await call(hostA, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: `host-a:${taskStorage}:vs-draining`,
      write_set: ['apps/clued-cloud/tests/task-dependency-guard-db.test.mjs'],
    }), 'work_claim_conflict');
    rejected(await renew(hostB, { claim_id: claimB.claim_id, fence: 1, lease_version: 1, progress_ref: 'p' }), 'work_claim_not_active');
    committed(await call(hostB, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimB.claim_id, fence: 1, outcome: 'completed',
    }));
    rejected(await call(hostB, 'clued_work_release_v1', {
      scope: 'global', claim_id: claimB.claim_id, fence: 1, outcome: 'completed',
    }), 'work_claim_not_active');
    committed(await call(hostA, 'clued_work_claim_v1', {
      scope: 'global', task_id: taskStorage, idempotency_key: `host-a:${taskStorage}:after`,
      write_set: ['apps/clued-cloud/tests/task-dependency-guard-db.test.mjs'],
    }));

    // --- Per-session cap: three live claims in one session (these declare no
    // holder_session_ref, so they share one group), the fourth is refused. ---
    const liveC = (await admin.query(`select count(*)::int n from clued_private.work_claims_v1
      where holder_binding_id=$1 and status in ('ACTIVE','DRAINING')`, [bindingIds['Host C']])).rows[0].n;
    const needed = 3 - liveC;
    const capTasks = [];
    for (let i = 0; i < needed; i += 1) capTasks.push(await createTask(hostA, `Cap filler ${i}`));
    for (const t of capTasks) {
      committed(await call(hostC, 'clued_work_claim_v1', {
        scope: 'global', task_id: t, idempotency_key: `host-c:${t}:cap`, write_set: [`cap/${t}.txt`],
      }));
    }
    const overflowTask = await createTask(hostA, 'Cap overflow');
    const capped = rejected(await call(hostC, 'clued_work_claim_v1', {
      scope: 'global', task_id: overflowTask, idempotency_key: `host-c:${overflowTask}:cap`, write_set: ['cap/overflow.txt'],
    }), 'work_claim_budget_exhausted');
    assert.equal(capped.limit, 'max_active_per_session');
    assert.equal(capped.max_active_per_session, 3);
    assert.equal(capped.max_active_per_binding, 10);
    assert.equal(capped.active, 3);

    // --- Step 2: the resume fold-in read lists this user's live claims, in
    // the scopes the Binding may read, for a read-only Binding too. ---
    const active = await call(verifier, 'clued_work_claims_active_v1', { scope: 'global' });
    assert.equal(active.status, 'ok', JSON.stringify(active));
    const liveIds = (await admin.query(`select claim_id from clued_private.work_claims_v1
      where user_id=$1 and status in ('ACTIVE','DRAINING') and expires_at>clock_timestamp()
      order by expires_at,claim_id`, [userId])).rows.map((r) => r.claim_id);
    assert.deepEqual(active.active_work_claims.map((c) => c.claim_id), liveIds);
    assert.ok(active.active_work_claims.length >= 4, 'C holds three capped claims plus A holds one');
    assert.equal(active.work_claim_profile.max_active_per_session, 3);
    assert.equal(active.work_claim_profile.max_active_per_binding, 10);
    assert.ok(active.active_work_claims.every((c) => c.write_set.length > 0 && c.fence >= 1 && c.expires_at));
    const foreign = await call(otherUser, 'clued_work_claims_active_v1', { scope: 'global' });
    assert.deepEqual(foreign.active_work_claims, [], 'another user sees none of these claims');
    // Delegated OAuth dispatch knows the six work-claim entries.
    const oauthBody = (await admin.query(`select pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure) body`)).rows[0].body;
    for (const tool of ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_verify', 'clued_work_takeover', 'clued_work_claims_active']) {
      assert.ok(oauthBody.includes(`when '${tool}' then`), `clued_oauth_call dispatches ${tool}`);
    }

    // --- The table itself is not readable through the client role. ---
    await assert.rejects(() => anon.query('select * from clued_private.work_claims_v1'), /permission denied/);

    // --- Every state change left a receipt. ---
    const ops = (await admin.query(`select operation,count(*)::int n from public.clued_audit_receipts
      where object_type='work_claim' group by operation order by operation`)).rows;
    const byOp = Object.fromEntries(ops.map((r) => [r.operation, r.n]));
    for (const op of ['work_claim', 'work_claim_renew', 'work_claim_release', 'work_claim_expire', 'work_claim_takeover']) {
      assert.ok(byOp[op] > 0, `missing receipts for ${op}: ${JSON.stringify(byOp)}`);
    }
    assert.equal((await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where operation='work_claim_takeover'`)).rows[0].n, 1, 'replayed takeover emits no second receipt');
    assert.ok(raceWinnerToken);
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
