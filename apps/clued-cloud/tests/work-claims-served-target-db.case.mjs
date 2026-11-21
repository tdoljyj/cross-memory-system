// authorize_head: the server decides a pull request's target branch (Clued Task 0ca0479d; Fable 2026-11-20 §2.1, §3 T1).
// Production 2026-11-20 (Beijing): claim 4d3fe9eb authorized head b228cedc5f for PR #1200 with target_branch
// claude/train-required-rerun (the PR's own head branch) at 18:45:58. The call answered committed with a
// WORK_CLAIM_HEAD_AUTHORIZED Receipt, but CI resolves a PR with its real base (main), so that row never matched: the
// resident answered CLAIM_NOT_CURRENT for 2 h 05 min until the head was authorized again with main. 5 of 588 production
// authorizations named the PR's own branch; none named a real non-main target.
// Invariant: a committed pull-request authorization makes the same head resolve as bound when CI asks with main.
// Imported by work-claims-lease-pin-db.test.mjs, so it runs in the production-schema suite.
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
const repo = 'fixture/served-target';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('a committed pull-request head authorization always resolves bound against main', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-served-target-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('served-target fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
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
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'served-target@example.invalid',now())", [user]);
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
    // The real RPCs: CI signatures directly, everything else through the Worker gateway caller.
    const call = async (who, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const task = async () => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated served-target fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async () => { const task_id = await task(); return committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope: 'global', write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'served-target fixture',
      holder_session_ref: uuid(), idempotency_key: uuid() })); };
    // authorize_head as the holder sends it; `fields` is the exact target part (target_branch, pr_number, workflow).
    // An input the server raises on comes back as { status: 'error' } so every case asserts on one shape.
    const authorize = (r, head, fields) => call('holder', 'clued_work_renew_v1', {
      scope: 'global', action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      idempotency_key: uuid(), ...fields }).catch(e => ({ status: 'error', error: e.message }));
    // What the resident asks: the PR's real base, main.
    const resolve = (number, head) => call('ci', 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${number}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main' });
    const release = r => call('holder', 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    const effects = async r => {
      const one = async (sql) => (await admin.query(sql, [r.claim.claim_id])).rows[0].n;
      return {
        authorizations: await one('select count(*)::int n from clued_private.work_claim_head_authorizations_v1 where claim_id=$1'),
        authorized_receipts: await one(`select count(*)::int n from public.clued_audit_receipts where object_id=$1::text
          and metadata->>'receipt_kind'='WORK_CLAIM_HEAD_AUTHORIZED'`),
        pr_bindings: await one('select count(*)::int n from clued_private.work_claim_pr_task_bindings_v1 b join clued_private.work_claims_v1 c on c.task_id=b.task_id where c.claim_id=$1'),
      };
    };
    const lease = async r => (await admin.query('select expires_at,hard_deadline_at from clued_private.work_claims_v1 where claim_id=$1',
      [r.claim.claim_id])).rows[0];
    const rows = async r => (await admin.query(`select target_branch,workflow,pr_ref from clued_private.work_claim_head_authorizations_v1
      where claim_id=$1 order by issued_at`, [r.claim.claim_id])).rows;
    // The invariant every case keeps: committed for a pull request means CI's resolve with main is bound.
    const assertInvariant = async (authorized, number, head) => {
      if (authorized.status !== 'committed') return;
      const resolved = await resolve(number, head);
      assert.equal(resolved.binding_status, 'bound',
        `authorize_head answered committed, yet CI resolving PR #${number} with main gets ${JSON.stringify(resolved)}`);
    };

    await t.test('a PR authorization naming the PR head branch is refused and writes nothing (PR #1200)', async () => {
      const r = await claim(), head = '1'.repeat(40), before = await effects(r), leaseBefore = await lease(r);
      const authorized = await authorize(r, head, { target_branch: 'claude/some-head-branch', pr_number: 11 });
      await assertInvariant(authorized, 11, head);
      assert.equal(authorized.status, 'rejected', JSON.stringify(authorized));
      assert.equal(authorized.error_code, 'work_claim_target_branch_not_served');
      assert.equal(authorized.served_target, 'main');
      assert.deepEqual(await effects(r), before, 'no authorization row, no WORK_CLAIM_HEAD_AUTHORIZED Receipt, no PR binding');
      const leaseAfter = await lease(r);
      assert.equal(leaseAfter.expires_at.getTime(), leaseBefore.expires_at.getTime(), 'the lease is not pinned');
      assert.ok(leaseAfter.expires_at.getTime() < leaseAfter.hard_deadline_at.getTime());
      await release(r);
    });

    await t.test('the same before the PR exists (no pr_ref) is refused too', async () => {
      const r = await claim(), head = '2'.repeat(40), before = await effects(r), leaseBefore = await lease(r);
      const authorized = await authorize(r, head, { target_branch: 'claude/some-head-branch' });
      await assertInvariant(authorized, 12, head);
      assert.equal(authorized.status, 'rejected', JSON.stringify(authorized));
      assert.equal(authorized.error_code, 'work_claim_target_branch_not_served');
      assert.equal(authorized.served_target, 'main');
      assert.deepEqual(await effects(r), before);
      assert.equal((await lease(r)).expires_at.getTime(), leaseBefore.expires_at.getTime(), 'the lease is not pinned');
      await release(r);
    });

    await t.test('without target_branch the server fills main: committed and bound', async () => {
      const r = await claim(), head = '3'.repeat(40);
      const authorized = await authorize(r, head, { pr_number: 13 });
      committed(authorized);
      await assertInvariant(authorized, 13, head);
      assert.deepEqual((await rows(r)).map(row => row.target_branch), ['main']);
      // The pre-push form too: CI discovers the PR from the authorized head.
      const early = await claim(), earlyHead = '4'.repeat(40);
      const pushed = await authorize(early, earlyHead, {});
      committed(pushed);
      await assertInvariant(pushed, 14, earlyHead);
      await release(r); await release(early);
    });

    await t.test('target_branch main stays accepted (older clients)', async () => {
      const r = await claim(), head = '5'.repeat(40);
      const authorized = await authorize(r, head, { target_branch: 'main', pr_number: 15 });
      committed(authorized);
      await assertInvariant(authorized, 15, head);
      const lease_ = await lease(r);
      assert.equal(lease_.expires_at.getTime(), lease_.hard_deadline_at.getTime(), 'a PR authorization still pins the lease');
      await release(r);
    });

    // Only the exact string main is served; no normalising (case, refs/heads/, whitespace, empty) and no PR-head name.
    await t.test('every value other than exactly main is refused at the outer layer and writes nothing', async () => {
      for (const value of ['', 'Main', 'MAIN', 'refs/heads/main', 'main ', 'claude/authorize-target-main']) {
        const r = await claim(), head = crypto.randomBytes(20).toString('hex');
        const before = await effects(r), leaseBefore = await lease(r);
        const authorized = await authorize(r, head, { target_branch: value, pr_number: 21 });
        const label = JSON.stringify(value);
        assert.equal(authorized.status, 'rejected', label + ' ' + JSON.stringify(authorized));
        assert.equal(authorized.error_code, 'work_claim_target_branch_not_served', label);
        assert.equal(authorized.served_target, 'main', label);
        assert.deepEqual(await effects(r), before, label + ': no authorization row, no Receipt, no PR binding');
        assert.equal((await lease(r)).expires_at.getTime(), leaseBefore.expires_at.getTime(), label + ': the lease is not pinned');
        await release(r);
      }
    });

    // JSON null is not "absent": the inner validator reports input_invalid; the outer layer neither fills main nor says not_served.
    await t.test('target_branch JSON null is input_invalid, not committed and not not_served', async () => {
      const r = await claim(), head = '9'.repeat(40), before = await effects(r), leaseBefore = await lease(r);
      const authorized = await authorize(r, head, { target_branch: null, pr_number: 22 });
      assert.notEqual(authorized.status, 'committed', JSON.stringify(authorized));
      assert.notEqual(authorized.error_code, 'work_claim_target_branch_not_served', JSON.stringify(authorized));
      assert.match(JSON.stringify(authorized), /work_claim_head_authorization_input_invalid/);
      assert.deepEqual(await effects(r), before);
      assert.equal((await lease(r)).expires_at.getTime(), leaseBefore.expires_at.getTime(), 'the lease is not pinned');
      await release(r);
    });

    await t.test('replaying an idempotency_key without target_branch, now with main, is replayed with one row', async () => {
      const r = await claim(), head = 'a'.repeat(40), idempotency_key = uuid();
      const first = committed(await authorize(r, head, { pr_number: 23, idempotency_key }));
      assert.notEqual(first.replayed, true, JSON.stringify(first));
      const second = await authorize(r, head, { target_branch: 'main', pr_number: 23, idempotency_key });
      committed(second);
      assert.equal(second.replayed, true, JSON.stringify(second));
      assert.equal((await effects(r)).authorizations, 1, 'only one authorization row');
      await release(r);
    });

    await t.test('a workflow dispatch authorization is unchanged', async () => {
      const r = await claim();
      committed(await authorize(r, '6'.repeat(40), { target_branch: 'feature/x', workflow: 'fixture.yml' }));
      committed(await authorize(r, '7'.repeat(40), { target_branch: 'main', workflow: 'fixture.yml' }));
      assert.deepEqual((await rows(r)).map(row => [row.target_branch, row.workflow]), [['feature/x', 'fixture.yml'], ['main', 'fixture.yml']]);
      const missing = await authorize(r, '8'.repeat(40), { workflow: 'fixture.yml' });
      assert.equal(missing.status, 'error', JSON.stringify(missing));
      assert.match(missing.error, /work_claim_head_authorization_input_invalid/);
      await release(r);
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    const stopped = await waitForPidExit(ownPid);
    process.stderr.write('served-target fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped, true, 'this fixture must stop its own PostgreSQL child');
  }
});
