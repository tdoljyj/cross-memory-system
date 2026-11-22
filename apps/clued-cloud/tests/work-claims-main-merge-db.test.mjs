// Migration 20261116090000 (resident DESIGN §80): a head that only merged main into an authorized head keeps that authorization when
// the CI admission issuer says so (carry_main_merge). Before it, the same merge commit stayed head_not_authorized until the holder
// authorized it with the private lease key (CLUED_MAIN_MERGE_BASELINE=1 runs this file without the migration: the first case fails).
// Migration 20261122090000 lets the same carry and every read-only resolve treat a relation the CI has not yet seen ('unknown')
// as open; T1a, T1c and T1d failed before it, T1b guards the terminal states either way.
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
const sha = c => c.repeat(40);
const repo = 'fixture/main-merge';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('a merge of main into an authorized head keeps the authorization, only by the CI issuer and only from a live source', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-main-merge-'));
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
      if (process.env.CLUED_MAIN_MERGE_BASELINE === '1' && name.endsWith('_work_claim_main_merge_authorization_v1.sql')) continue;
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (e) { throw new Error('Migration ' + name + ': ' + e.message, { cause: e }); }
    }
    await allowRawTestBindings(admin);
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'main-merge@example.invalid',now())", [user]);
    const tokens = {}, ids = {};
    for (const [name, scopes] of [['holder', ['context:read', 'context:write']], ['reader', ['context:read']], ['ci', ['context:read']]]) {
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
    const task = async () => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async task_id => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope: 'global', write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'terminal fixture', holder_session_ref: uuid(), idempotency_key: uuid() }));
    const authorize = (r, head, pr) => call('holder', 'clued_work_renew_v1', {
      scope: 'global', action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      target_branch: 'main', pr_number: pr, idempotency_key: uuid() });
    const resolve = (number, head) => call('ci', 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${number}`, head_sha: head, base_sha: sha('b'), target_branch: 'main' });
    const verify = (r, number, head) => call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id,
      pr_ref: `${repo}#${number}`, head_sha: head, base_sha: sha('b'), target_branch: 'main', changed_paths: ['fixture/' + r.claim.task_id + '/main.mjs'] });
    const carry = (who, number, from, head, extra = {}) => call(who, 'clued_work_verify_v1', { action: 'carry_main_merge', scope: 'global',
      pr_ref: `${repo}#${number}`, from_head_sha: from, head_sha: head, main_sha: sha('7'), target_branch: 'main', ...extra })
      .catch(e => ({ status: 'error', error: e.message }));
    const release = r => call('holder', 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    const lease = async r => (await admin.query('select fence,lease_version,expires_at,hard_deadline_at from clued_private.work_claims_v1 where claim_id=$1',
      [r.claim.claim_id])).rows[0];
    // A front: the holder authorized head H of PR n, the CI admitted it (which binds the PR to the Task).
    const front = async (n, H) => {
      const r = await claim(await task());
      committed(await authorize(r, H, n));
      assert.equal((await resolve(n, H)).binding_status, 'bound');
      assert.equal((await verify(r, n, H)).verdict, 'ADMITTED');
      return r;
    };

    await t.test('the issuer carries H to H+main; the merge commit is then bound and ADMITTED with nothing else moved', async () => {
      const H = sha('1'), X = sha('2'), r = await front(11, H), before = await lease(r);
      assert.equal((await resolve(11, X)).binding_status, 'head_not_authorized', 'the merge commit alone is not authorized');
      const carried = committed(await carry('ci', 11, H, X));
      assert.equal(carried.replayed, false);
      const bound = await resolve(11, X);
      assert.equal(bound.binding_status, 'bound', JSON.stringify(bound));
      assert.equal(bound.head_authorization_id, carried.authorization_id);
      assert.equal((await verify(r, 11, X)).verdict, 'ADMITTED');
      const row = (await admin.query(`select a.*,s.authorization_id source from clued_private.work_claim_head_authorizations_v1 a
        join clued_private.work_claim_head_authorizations_v1 s on s.authorization_id=a.carried_from where a.authorization_id=$1`, [carried.authorization_id])).rows[0];
      assert.equal(row.head_sha, X); assert.equal(row.pr_ref, `${repo}#11`); assert.equal(row.workflow, null);
      assert.equal(row.binding_id, (await admin.query('select holder_binding_id from clued_private.work_claims_v1 where claim_id=$1', [r.claim.claim_id])).rows[0].holder_binding_id);
      const receipt = (await admin.query("select binding_id,metadata from public.clued_audit_receipts where operation='work_claim_head_authorization_carried' and metadata->>'authorization_id'=$1",
        [carried.authorization_id])).rows[0];
      assert.equal(receipt.binding_id, ids.ci, 'the receipt names the issuer, not the holder');
      assert.equal(receipt.metadata.from_head_sha, H); assert.equal(receipt.metadata.main_sha, sha('7'));
      const after = await lease(r);
      assert.deepEqual([after.fence, after.lease_version, after.hard_deadline_at.getTime()], [before.fence, before.lease_version, before.hard_deadline_at.getTime()]);
      // Idempotent, and a carried head may itself be the source of the next main merge.
      assert.equal(committed(await carry('ci', 11, H, X)).replayed, true);
      committed(await carry('ci', 11, X, sha('3')));
      assert.equal((await resolve(11, sha('3'))).binding_status, 'bound');
      committed(await release(r));
      assert.notEqual((await resolve(11, X)).binding_status, 'bound', 'released with its claim');
    });

    await t.test('nobody but the issuer carries, and only from a live authorization of the PR\'s current claim', async () => {
      const H = sha('4'), X = sha('5'), r = await front(12, H);
      for (const who of ['holder', 'reader']) {
        const x = await carry(who, 12, H, X);
        assert.notEqual(x.status, 'committed', who);
        assert.notEqual((await resolve(12, X)).binding_status, 'bound', who);
      }
      assert.equal((await carry('ci', 12, sha('6'), X)).error_code, 'source_head_not_authorized', 'an unauthorized source');
      assert.equal((await carry('ci', 13, H, X)).error_code, 'pr_task_binding_unbound', 'another PR');
      for (const bad of [{ head_sha: H }, { main_sha: X }, { extra: 1 }, { scope: 'nope' }]) {
        assert.equal((await carry('ci', 12, H, X, bad)).status, 'error', JSON.stringify(bad));
      }
      assert.equal((await resolve(12, X)).binding_status, 'head_not_authorized');
      committed(await release(r));
      assert.equal((await carry('ci', 12, H, X)).status, 'rejected', 'a released claim carries nothing');
    });

    // Migration 20261122090000 (FABLE-botmerge-auth-carry-20261122 §2 step 1, T1): a PR the holder bound through authorize_head
    // and the CI never admitted stays 'unknown'. Before it, carry refused such a PR (pr_task_binding_unbound: #1220, 11-22) and
    // every read-only resolve answered no_live_claim / pr_task_binding_unknown whatever its heads' authorizations were.
    const bindingStatus = async n => (await admin.query('select status from clued_private.work_claim_pr_task_bindings_v1 where user_id=$1 and repo_id=$2 and pr_number=$3',
      [user, repo, n])).rows[0]?.status;
    const observeAs = (who, number, head) => call(who, 'clued_work_verify_v1', { action: 'resolve_pr_claim', scope: 'global',
      pr_ref: `${repo}#${number}`, head_sha: head, base_sha: sha('b'), target_branch: 'main', read_only: true });
    const writes = async () => (await admin.query(`select (select count(*)::int from public.clued_audit_receipts where user_id=$1) receipts,
      (select count(*)::int from clued_private.work_claim_head_authorizations_v1 where user_id=$1) authorizations,
      (select count(*)::int from clued_private.work_claim_door_usage_v1 where user_id=$1) usage`, [user])).rows[0];
    // Authorized by the holder with pr_number only: no CI resolve, no admission.
    const unadmitted = async (n, H) => {
      const r = await claim(await task());
      committed(await authorize(r, H, n));
      assert.equal(await bindingStatus(n), 'unknown', 'authorize_head alone leaves the relation unknown');
      return r;
    };

    await t.test('T1a: the issuer carries a head of a PR the CI never admitted; its next CI resolve binds and activates it', async () => {
      const H = sha('a'), M = sha('c'), r = await unadmitted(21, H);
      const carried = await carry('ci', 21, H, M);
      assert.equal(carried.status, 'committed', JSON.stringify(carried));
      const source = (await admin.query('select authorization_id from clued_private.work_claim_head_authorizations_v1 where claim_id=$1 and head_sha=$2',
        [r.claim.claim_id, H])).rows[0].authorization_id;
      assert.equal(carried.carried_from, source);
      assert.equal(await bindingStatus(21), 'unknown', 'carry itself does not change the relation');
      const bound = await resolve(21, M);
      assert.equal(bound.binding_status, 'bound', JSON.stringify(bound));
      assert.equal(bound.head_authorization_id, carried.authorization_id);
      assert.equal(bound.auto_bound, true);
      assert.equal(await bindingStatus(21), 'active');
      committed(await release(r));
    });

    await t.test('T1b: a closed or merged relation still carries nothing and still reads as no live claim', async () => {
      for (const [n, end] of [[22, 'closed'], [23, 'merged']]) {
        const H = sha('d'), M = sha('e'), r = await unadmitted(n, H);
        await admin.query('update clued_private.work_claim_pr_task_bindings_v1 set status=$4 where user_id=$1 and repo_id=$2 and pr_number=$3', [user, repo, n, end]);
        const refused = await carry('ci', n, H, M);
        assert.deepEqual([refused.status, refused.error_code], ['rejected', 'pr_task_binding_unbound'], end);
        for (const who of ['ci', 'reader']) {
          const seen = await observeAs(who, n, H);
          assert.deepEqual([seen.binding_status, seen.reason, seen.claim], ['no_live_claim', `pr_task_binding_${end}`, null], `${who} ${end}`);
        }
        assert.equal(await bindingStatus(n), end);
        committed(await release(r));
      }
    });

    await t.test('T1c: a read-only resolve of an authorized head of an unknown relation answers bound and writes nothing', async () => {
      const H = sha('f'), r = await unadmitted(24, H), before = await writes();
      const authorization = (await admin.query('select authorization_id from clued_private.work_claim_head_authorizations_v1 where claim_id=$1 and head_sha=$2',
        [r.claim.claim_id, H])).rows[0].authorization_id;
      for (const who of ['ci', 'reader']) {
        const seen = await observeAs(who, 24, H);
        assert.deepEqual([seen.binding_status, seen.reason, seen.head_authorization_id, seen.claim?.claim_id, seen.auto_bound, seen.receipt_id],
          ['bound', null, authorization, r.claim.claim_id, false, null], `${who}: ${JSON.stringify(seen)}`);
      }
      assert.equal(await bindingStatus(24), 'unknown', 'only the CI write resolve activates a relation');
      assert.deepEqual(await writes(), before, 'no receipt, authorization or head meter');
      committed(await release(r));
    });

    await t.test('T1d: a read-only resolve of an unauthorized head of an unknown relation names the claim', async () => {
      const H = sha('0'), G = sha('9'), r = await unadmitted(25, H), before = await writes();
      for (const who of ['ci', 'reader']) {
        const seen = await observeAs(who, 25, G);
        assert.deepEqual([seen.binding_status, seen.reason, seen.claim?.claim_id, seen.head_authorization_id],
          ['head_not_authorized', 'head_authorization_required', r.claim.claim_id, null], `${who}: ${JSON.stringify(seen)}`);
      }
      assert.equal(await bindingStatus(25), 'unknown');
      assert.deepEqual(await writes(), before);
      committed(await release(r));
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    assert.equal(await waitForPidExit(ownPid), true, 'this fixture must stop its own PostgreSQL child');
  }
});
