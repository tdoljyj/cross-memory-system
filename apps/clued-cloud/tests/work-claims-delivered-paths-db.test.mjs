// Migration 20261124160000 (PLAN-claim-write-set-granularity-20261124 §4, §6): repository paths are exclusive until delivery.
// A live claim holding a live head authorization of its current execution epoch (authorize_head succeeded) no longer blocks
// another claim on the same repository paths; its write set, the admission coverage check, same-Task and trigger conflicts
// and non-repository resources are unchanged. Before the migration cases 1, 2 and 8 fail (work_claim_conflict: the second
// pushed PR of a hot file waited, or the first one's write set was narrowed by hand and its next head was refused, #1300).
// Cases 3 to 7 are controls: the conflict is returned either way (4 and 7 also name which entries overlap, see there).
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
const head = () => crypto.randomBytes(20).toString('hex');
const base = 'b'.repeat(40);
const repo = 'fixture/delivered-paths';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('repository paths of a claim with a live head authorization do not block another claim; everything else still does', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-delivered-paths-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
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
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'delivered-paths@example.invalid',now())", [user]);
    const tokens = {}, ids = {};
    for (const [name, scopes] of [['A', ['context:read', 'context:write']], ['B', ['context:read', 'context:write']],
      ['C', ['context:read', 'context:write']], ['ci', ['context:read']]]) {
      tokens[name] = hash(); ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic',$2,$3,$4,'{*}') returning id`,
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
    const conflict = (r, holder) => {
      assert.equal(r.error_code, 'work_claim_conflict', JSON.stringify(r));
      assert.equal(r.conflicts.length, 1, JSON.stringify(r));
      assert.equal(r.conflicts[0].claim_id, holder.claim.claim_id);
      return r.conflicts[0].overlap;
    };
    const task = async who => committed(await call(who, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async (who, write_set, extra = {}) => call(who, 'clued_work_claim_v1', {
      task_id: extra.task_id ?? await task(who), scope: 'global', write_set, holder_label: 'delivered paths fixture',
      holder_session_ref: uuid(), idempotency_key: uuid(), ...extra });
    const authorize = (who, r, sha, pr) => call(who, 'clued_work_renew_v1', {
      scope: 'global', action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: sha,
      target_branch: 'main', pr_number: pr, idempotency_key: uuid() });
    const widen = (who, r, write_set) => call(who, 'clued_work_renew_v1', { scope: 'global', claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_version: r.claim.lease_version, lease_key: r.lease_key, progress_ref: 'widen',
      write_set, idempotency_key: uuid() });
    const resolve = (pr, sha) => call('ci', 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${pr}`, head_sha: sha, base_sha: base, target_branch: 'main' });
    const verify = (r, pr, sha, changed_paths) => call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id,
      pr_ref: `${repo}#${pr}`, head_sha: sha, base_sha: base, target_branch: 'main', changed_paths });
    const release = async (who, r) => committed(await call(who, 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'abandoned' }));
    const writeSet = async r => (await admin.query('select write_set from clued_private.work_claims_v1 where claim_id=$1', [r.claim.claim_id])).rows[0].write_set;
    // A delivered claim: write set claimed, then one head of PR n authorized by its holder.
    const delivered = async (who, write_set, pr, extra) => {
      const r = committed(await claim(who, write_set, extra)), sha = head();
      committed(await authorize(who, r, sha, pr));
      return { ...r, sha };
    };
    let a1, b1;

    await t.test('1: A claimed and authorized a head; B, another Task, claims the same file and is committed', async () => {
      a1 = await delivered('A', ['d1/hot.mjs', 'd1/a.mjs'], 101);
      b1 = committed(await claim('B', ['d1/hot.mjs', 'd1/b.mjs']));
      assert.deepEqual(b1.claim.write_set, ['d1/b.mjs', 'd1/hot.mjs']);
      assert.deepEqual(await writeSet(a1), ['d1/a.mjs', 'd1/hot.mjs'], 'A keeps its whole write set');
    });

    await t.test('2: both PRs are admitted on their whole change and A pushes a second head; no write set was touched (#1300)', async () => {
      assert.ok(a1 && b1, 'needs case 1');
      b1.sha = head(); committed(await authorize('B', b1, b1.sha, 102));
      assert.equal((await resolve(101, a1.sha)).binding_status, 'bound');
      assert.equal((await resolve(102, b1.sha)).binding_status, 'bound');
      assert.equal((await verify(a1, 101, a1.sha, ['d1/hot.mjs', 'd1/a.mjs'])).verdict, 'ADMITTED');
      assert.equal((await verify(b1, 102, b1.sha, ['d1/hot.mjs', 'd1/b.mjs'])).verdict, 'ADMITTED');
      // Coverage is judged as before: a path of the other claim is outside this one's write set.
      const outside = await verify(a1, 101, a1.sha, ['d1/hot.mjs', 'd1/b.mjs']);
      assert.equal(outside.verdict, 'REJECTED', JSON.stringify(outside));
      assert.deepEqual(outside.paths_outside_write_set, ['d1/b.mjs']);
      const second = head();
      committed(await authorize('A', a1, second, 101));
      assert.equal((await resolve(101, second)).binding_status, 'bound');
      assert.equal((await verify(a1, 101, second, ['d1/hot.mjs', 'd1/a.mjs'])).verdict, 'ADMITTED');
      assert.deepEqual(await writeSet(a1), ['d1/a.mjs', 'd1/hot.mjs']);
      assert.deepEqual(await writeSet(b1), ['d1/b.mjs', 'd1/hot.mjs']);
      await release('A', a1); await release('B', b1);
    });

    await t.test('3: control. A has no authorization: B still conflicts on the same file', async () => {
      const a = committed(await claim('A', ['d3/hot.mjs', 'd3/a.mjs']));
      const overlap = conflict(await claim('B', ['d3/hot.mjs', 'd3/b.mjs']), a);
      assert.deepEqual(overlap.paths, ['d3/hot.mjs']);
      await release('A', a);
    });

    await t.test('4: control. A is delivered: the same Task and an equal trigger ref still conflict', async () => {
      const ref = 'issue:' + uuid();
      const a = await delivered('A', ['d4/hot.mjs'], 104, { trigger_refs: [ref] });
      const sameTask = conflict(await claim('B', ['d4/other.mjs'], { task_id: a.claim.task_id }), a);
      assert.equal(sameTask.same_task, true);
      assert.deepEqual(sameTask.paths, [], 'the delivered paths are not what conflicts');
      const sameTrigger = conflict(await claim('B', ['d4/hot.mjs'], { trigger_refs: [ref] }), a);
      // Before the migration the conflict was the same and paths also named d4/hot.mjs.
      assert.deepEqual([sameTrigger.same_task, sameTrigger.paths, sameTrigger.trigger_refs], [false, [], [ref]]);
      await release('A', a);
    });

    await t.test('5: control. A is delivered and widens onto a path C holds undelivered: still a conflict', async () => {
      const c = committed(await claim('C', ['d5/x.mjs']));
      const a = await delivered('A', ['d5/a.mjs'], 105);
      const overlap = conflict(await widen('A', a, ['d5/a.mjs', 'd5/x.mjs']), c);
      assert.deepEqual(overlap.paths, ['d5/x.mjs']);
      assert.deepEqual(await writeSet(a), ['d5/a.mjs']);
      await release('A', a); await release('C', c);
    });

    await t.test('6: control. Every authorization of A revoked: the same file conflicts again', async () => {
      const a = await delivered('A', ['d6/hot.mjs'], 106);
      await admin.query('update clued_private.work_claim_head_authorizations_v1 set revoked_at=clock_timestamp() where claim_id=$1', [a.claim.claim_id]);
      assert.deepEqual(conflict(await claim('B', ['d6/hot.mjs']), a).paths, ['d6/hot.mjs']);
      // An authorization of an earlier execution epoch is not a delivery either (the epoch trigger revokes them; both are required).
      await admin.query('update clued_private.work_claim_head_authorizations_v1 set revoked_at=null where claim_id=$1', [a.claim.claim_id]);
      await admin.query('alter table clued_private.work_claims_v1 disable trigger work_claim_execution_epoch_v1');
      try {
        await admin.query('update clued_private.work_claims_v1 set execution_epoch=execution_epoch+1 where claim_id=$1', [a.claim.claim_id]);
        assert.deepEqual(conflict(await claim('B', ['d6/hot.mjs']), a).paths, ['d6/hot.mjs']);
        await admin.query('update clued_private.work_claims_v1 set execution_epoch=execution_epoch-1 where claim_id=$1', [a.claim.claim_id]);
      } finally {
        await admin.query('alter table clued_private.work_claims_v1 enable trigger work_claim_execution_epoch_v1');
      }
      await release('A', a);
    });

    await t.test('7: control. A is delivered: its storage and record resources still conflict', async () => {
      const a = await delivered('A', ['d7/hot.mjs', 'storage:c7/docs/**', 'record:r7'], 107);
      assert.deepEqual(conflict(await claim('B', ['storage:c7/docs/a.md']), a).paths, ['storage:c7/docs/**', 'storage:c7/docs/a.md']);
      // Before the migration the conflict was the same and paths also named d7/hot.mjs.
      assert.deepEqual(conflict(await claim('B', ['record:r7', 'd7/hot.mjs']), a).paths, ['record:r7']);
      await release('A', a);
    });

    await t.test('8: a delivered repo: resource is a repository path too, bare or typed on the other side', async () => {
      const a = await delivered('A', ['repo:fixture/delivered-paths/d8/**'], 108);
      await release('B', committed(await claim('B', ['d8/hot.mjs'])));
      await release('C', committed(await claim('C', ['repo:fixture/delivered-paths/d8/hot.mjs'])));
      await release('A', a);
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    assert.equal(await waitForPidExit(ownPid), true, 'this fixture must stop its own PostgreSQL child');
  }
});
