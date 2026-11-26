// Manual release and PR-end release use the same evidence that this claim served an open PR: authorization naming
// the PR or a CI admission for it. The claim view lists every open PR of the Task with separate covered and served flags.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha = () => crypto.randomBytes(20).toString('hex');
const base = 'b'.repeat(40);
const repo = 'fixture/release-pr-open';
const ref = n => `${repo}#${n}`;
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('manual release protects open pull requests served by the claim; every claim answer lists open_prs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-release-pr-open-'));
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
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'release-pr-open@example.invalid',now())", [user]);
    const tokens = {}, ids = {};
    for (const [name, scopes] of [['holder', ['context:read', 'context:write']], ['ci', ['context:read']]]) {
      tokens[name] = hash(); ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic',$2,$3,$4,'{*}') returning id`,
        [user, name, tokens[name], scopes])).rows[0].id;
    }
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [user, ids.ci])).rows[0].id;
    await admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'ci-admission',now(),$3)", [user, ids.ci, roleReceipt]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const human = server.getPgClient(); clients.push(human); await human.connect(); await human.query('set role authenticated');
    // The Owner's Native session, for turning a Task into a race (case 4). Its sign-in time is the database's clock.
    const signedIn = (await admin.query('select extract(epoch from now())::bigint value')).rows[0].value;
    const native = async (name, input) => {
      const claims = { sub: user, role: 'authenticated', session_id: 'release-pr-open-owner', aal: 'aal1',
        amr: [{ method: 'password', timestamp: Number(signedIn) }] };
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) value`, [input])).rows[0].value;
    };
    const call = async (who, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', r.error_code); return r; };
    const task = async () => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async task_id => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope: 'global', trigger_refs: [], write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'release-pr-open fixture',
      holder_session_ref: uuid(), idempotency_key: uuid() }));
    const row = async r => (await admin.query('select to_jsonb(c) value from clued_private.work_claims_v1 c where claim_id=$1', [r.claim.claim_id])).rows[0].value;
    // authorize_head with the claim's current lease version (an authorization that pins the lease does not bump it).
    const authorize = async (r, head, pr) => {
      const now = await row(r);
      return call('holder', 'clued_work_renew_v1', { scope: 'global', action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
        lease_version: now.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head, target_branch: 'main',
        ...(pr ? { pr_number: pr } : {}), idempotency_key: uuid() });
    };
    // Qualified CI sees the pull request open on that head: the relation becomes 'active'.
    const seen = async (n, head) => assert.equal((await call('ci', 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: ref(n), head_sha: head, base_sha: base, target_branch: 'main' })).binding_status, 'bound');
    const release = (r, outcome = 'completed') => call('holder', 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome, evidence_ref: 'fixture:' + uuid() });
    const binding = async n => (await admin.query('select status from clued_private.work_claim_pr_task_bindings_v1 where repo_id=$1 and pr_number=$2', [repo, n])).rows[0]?.status;
    const lifecycle = async prs => (await anon.query('select public.clued_work_pr_lifecycle_report_v1($1,$2) value',
      [tokens.ci, { scope: 'global', repository: repo, prs }])).rows[0].value;
    const webhook = async n => (await gateway.query('select public.clued_work_pr_merged_event_v1($1) as result',
      [{ repository: repo, pr_number: n, merge_sha: 'e'.repeat(40) }])).rows[0].result;
    const listed = async r => (await call('holder', 'clued_work_claims_active_v1', { scope: 'global' }))
      .active_work_claims.find(c => c.claim_id === r.claim.claim_id);
    const releaseReceipts = async r => Number((await admin.query(`select count(*) n from public.clued_audit_receipts
      where user_id=$1 and operation='work_claim_release' and object_id=$2`, [user, r.claim.claim_id])).rows[0].n);
    // A refused release: the code, the open pull requests, and nothing written.
    const refused = async (r, outcome, open) => {
      const before = await row(r);
      const result = await release(r, outcome);
      assert.deepEqual([result.status, result.error_code], ['rejected', 'work_claim_release_pr_open']);
      assert.deepEqual(result.open_prs.map(p => [p.pr_ref, p.status]), open);
      assert.equal(Object.hasOwn(result, 'lease_key'), false);
      assert.deepEqual(await row(r), before, 'a refused release changes nothing of the claim');
      assert.equal(await releaseReceipts(r), 0);
      return result;
    };
    // The end of a claim that the service itself brings about, for cleanup and for case 3.
    const forceEnd = r => admin.query(`update clued_private.work_claims_v1 set status='RELEASED',released_outcome='abandoned',
      lease_key_hash=null,updated_at=clock_timestamp() where claim_id=$1`, [r.claim.claim_id]);
    const setDeadline = (r, remaining) => admin.query(`update clued_private.work_claims_v1
      set hard_deadline_at=clock_timestamp()+$2::interval,expires_at=clock_timestamp()+$2::interval where claim_id=$1`,
    [r.claim.claim_id, remaining]);

    await t.test('1. the holder named the pull request (relation unknown): completed, abandoned and draining are refused', async () => {
      const r = await claim(await task()), head = sha();
      const authorized = committed(await authorize(r, head, 201));
      assert.equal(await binding(201), 'unknown');
      const expected = [{ pr_ref: ref(201), status: 'unknown', covered: true, served: true }];
      for (const outcome of ['completed', 'abandoned', 'draining']) {
        const result = await refused(r, outcome, [[ref(201), 'unknown']]);
        assert.deepEqual(result.open_prs, expected);
        assert.deepEqual(result.claim.open_prs, expected);
      }
      assert.deepEqual(r.claim.open_prs, [], 'a new claim of a Task without pull requests');
      assert.deepEqual(authorized.claim.open_prs, expected);
      assert.equal((await row(r)).status, 'ACTIVE');
      await forceEnd(r);
    });

    await t.test('2. qualified CI saw the pull request open (relation active): refused the same way', async () => {
      const r = await claim(await task()), head = sha();
      committed(await authorize(r, head, 202)); await seen(202, head);
      assert.equal(await binding(202), 'active');
      const result = await refused(r, 'abandoned', [[ref(202), 'active']]);
      assert.deepEqual(result.open_prs, [{ pr_ref: ref(202), status: 'active', covered: true, served: true }]);
      await refused(r, 'completed', [[ref(202), 'active']]);
      assert.equal((await row(r)).status, 'ACTIVE');
      await forceEnd(r);
    });

    await t.test('3. 11-25 as it happened: two open pull requests; a new claim of the Task covers neither until it authorizes each', async () => {
      const id = await task(), first = await claim(id), headA = sha(), headB = sha();
      committed(await authorize(first, headA, 203)); await seen(203, headA);
      committed(await authorize(first, headB, 204));
      await refused(first, 'completed', [[ref(203), 'active'], [ref(204), 'unknown']]);
      // Force what the refusal now prevents (an expiry or a takeover still gets here): the old claim ends, the Task is claimed again.
      await forceEnd(first);
      const next = await claim(id);
      assert.notEqual(next.claim.claim_id, first.claim.claim_id);
      const uncovered = [{ pr_ref: ref(203), status: 'active', covered: false, served: false },
        { pr_ref: ref(204), status: 'unknown', covered: false, served: false }];
      assert.deepEqual(next.claim.open_prs, uncovered);
      assert.deepEqual((await listed(next)).open_prs, uncovered, 'active_work_claims says the same');
      // Naming the pull request covers that one only.
      const one = committed(await authorize(next, headA, 203));
      assert.deepEqual(one.claim.open_prs, [{ ...uncovered[0], covered: true, served: true }, uncovered[1]]);
      assert.deepEqual((await listed(next)).open_prs, one.claim.open_prs);
      // An unrelated head covers nothing; the head last authorized for the other pull request covers it without its number.
      assert.deepEqual(committed(await authorize(next, sha())).claim.open_prs, one.claim.open_prs);
      const both = committed(await authorize(next, headB));
      assert.deepEqual(both.claim.open_prs, [one.claim.open_prs[0], { ...uncovered[1], covered: true }]);
      // A renewal answers the same list.
      const renewed = committed(await call('holder', 'clued_work_renew_v1', { scope: 'global', claim_id: next.claim.claim_id, fence: next.claim.fence,
        lease_version: (await row(next)).lease_version, lease_key: next.lease_key, progress_ref: 'fixture:' + uuid() }));
      assert.deepEqual(renewed.claim.open_prs, both.claim.open_prs);
      await refused(next, 'abandoned', [[ref(203), 'active'], [ref(204), 'unknown']]);
      await forceEnd(next);
    });

    await t.test('4. releases that stay possible: the pull requests ended, another live claim of the Task, the last two hours, no pull request', async t => {
      await t.test('a claim that never named a pull request is released as before', async () => {
        const r = await claim(await task());
        committed(await authorize(r, sha()));
        const result = committed(await release(r));
        assert.equal(result.claim.status, 'RELEASED'); assert.deepEqual(result.claim.open_prs, []);
      });
      await t.test('closed and merged pull requests no longer hold the claim', async () => {
        const r = await claim(await task()), headA = sha(), headB = sha();
        committed(await authorize(r, headA, 205)); await seen(205, headA);
        committed(await authorize(r, headB, 206));
        // A later head without a pull request keeps the claim when its pull requests end (20261113151000), so the holder's own release is what is judged.
        committed(await authorize(r, sha()));
        assert.equal((await lifecycle([{ pr_number: 206, state: 'closed' }])).finished, 1);
        assert.equal(await binding(206), 'closed');
        await refused(r, 'completed', [[ref(205), 'active']]);
        assert.equal((await webhook(205)).finished, 1);
        assert.equal(await binding(205), 'merged');
        assert.equal((await row(r)).status, 'ACTIVE');
        const result = committed(await release(r));
        assert.equal(result.claim.status, 'RELEASED'); assert.deepEqual(result.claim.open_prs, []);
      });
      await t.test('a closed pull request the CI never saw (unknown) is ended by the resident report and frees the claim', async () => {
        const r = await claim(await task());
        committed(await authorize(r, sha(), 207));
        committed(await authorize(r, sha()));
        await refused(r, 'abandoned', [[ref(207), 'unknown']]);
        assert.equal((await lifecycle([])).tracked.includes(207), true, 'the resident is told to ask GitHub about it');
        assert.equal((await lifecycle([{ pr_number: 207, state: 'closed' }])).finished, 1);
        committed(await release(r, 'abandoned'));
      });
      await t.test('with the pull request ended and no later head, the service has already released the claim', async () => {
        const r = await claim(await task()), head = sha();
        committed(await authorize(r, head, 208)); await seen(208, head);
        assert.deepEqual((await lifecycle([{ pr_number: 208, state: 'closed' }])).released, [r.claim.claim_id]);
        const after = await row(r);
        assert.deepEqual([after.status, after.released_by], ['RELEASED', 'pr_end']);
      });
      await t.test('one copy of a race is released while another copy is live; the last live copy is not', async () => {
        const id = await task();
        const issued = await native('clued_work_claim_multi_confirmation_issue_v1', { task_id: id, copies: 2, shared_resources: ['fixture/' + id + '/main.mjs'] });
        assert.equal(issued.status, 'issued', JSON.stringify(issued));
        committed(await native('clued_work_claim_multi_enable_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
        const a = await claim(id), b = await claim(id), head = sha();
        committed(await authorize(a, head, 209)); await seen(209, head);
        committed(await release(a, 'abandoned'));
        committed(await authorize(b, head, 209));
        await refused(b, 'abandoned', [[ref(209), 'active']]);
        await forceEnd(b);
      });
      await t.test('less than two hours before the hard deadline the release is accepted', async () => {
        const r = await claim(await task()), head = sha();
        committed(await authorize(r, head, 210)); await seen(210, head);
        await setDeadline(r, '2 hours 10 minutes');
        await refused(r, 'completed', [[ref(210), 'active']]);
        await setDeadline(r, '1 hour 50 minutes');
        const result = committed(await release(r));
        assert.equal(result.claim.status, 'RELEASED');
        assert.deepEqual(result.claim.open_prs, [{ pr_ref: ref(210), status: 'active', covered: false, served: true }]);
      });
    });

    const oldTask = await task();
    const old = await claim(oldTask);
    committed(await authorize(old, 'a'.repeat(40), 1308));
    assert.equal(await binding(1308), 'unknown');
    await setDeadline(old, '1 hour');
    committed(await release(old, 'abandoned'));
    const oldDraft = { pr_ref: ref(1308), status: 'unknown', covered: false, served: false };

    await t.test('5. #1308: a draft served only by the old claim allows the new claim to be released', async () => {
      const r = await claim(oldTask);
      const open = r.claim.open_prs;
      const released = await release(r, 'abandoned');
      if (released.status !== 'committed') await forceEnd(r);
      assert.equal(committed(released).claim.status, 'RELEASED');
      assert.deepEqual(open, [oldDraft]);
    });

    await t.test('6. #1359: a served PR blocks manual release, then its merge releases the claim despite #1308', async () => {
      const r = await claim(oldTask);
      const authorized = committed(await authorize(r, sha(), 1359));
      const refusedRelease = await refused(r, 'completed', [[ref(1308), 'unknown'], [ref(1359), 'unknown']]);
      const expected = [oldDraft, { pr_ref: ref(1359), status: 'unknown', covered: true, served: true }];
      assert.deepEqual(authorized.claim.open_prs, expected);
      assert.deepEqual(refusedRelease.open_prs, expected);
      assert.deepEqual(await webhook(1359), { status: 'ok', finished: 1, released: [r.claim.claim_id] });
      assert.equal(await binding(1359), 'merged');
      assert.equal(await binding(1308), 'unknown');
      const after = await row(r);
      assert.deepEqual([after.status, after.released_by], ['RELEASED', 'pr_end']);
    });

    await t.test('7. a CI admission serves the PR even when the authorization omits the PR number', async () => {
      const r = await claim(await task()), head = sha();
      committed(await authorize(r, head));
      await seen(211, head);
      const admitted = await call('ci', 'clued_work_verify_v1', {
        scope: 'global', claim_id: r.claim.claim_id, pr_ref: ref(211), head_sha: head, base_sha: base,
        target_branch: 'main', changed_paths: [`fixture/${r.claim.task_id}/main.mjs`],
      });
      assert.equal(admitted.verdict, 'ADMITTED', admitted.reason);
      const authRefs = (await admin.query(`select pr_ref from clued_private.work_claim_head_authorizations_v1
        where claim_id=$1`, [r.claim.claim_id])).rows;
      assert.deepEqual(authRefs, [{ pr_ref: null }]);
      const result = await refused(r, 'abandoned', [[ref(211), 'active']]);
      assert.deepEqual(result.open_prs, [{ pr_ref: ref(211), status: 'active', covered: true, served: true }]);
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    // stop() resolves on the child's exit; the library then removes the cluster directory with one unretried rm, whose
    // lock error on Windows is not this test's verdict.
    const ownPid = server.process?.pid;
    await server.stop().catch(error => { if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error?.code)) throw error; });
    let alive = false;
    if (Number.isSafeInteger(ownPid)) { try { process.kill(ownPid, 0); alive = true; } catch (error) { alive = error?.code === 'EPERM'; } }
    assert.equal(alive, false, 'this fixture must stop its own PostgreSQL child');
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
