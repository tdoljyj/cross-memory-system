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
import { CI_SIGNATURES, PR_LIFECYCLE_REPORT_SIGNATURE, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const repo = 'fixture/pr-task';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('PR binding is stable Task identity, derived current claims and holder-authorized discovery', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-pr-task-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('PR binding fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    let candidateMigration;
    const successorMigrations=[];
    for (const name of (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      // Explicit baseline fixture loads the byte-identical pre-change chain;
      // it does not replace product files or relax any assertion.
      if (name.endsWith('_work_claim_pr_task_binding_v1.sql')) {
        candidateMigration = await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8'); continue;
      }
      if(name>'20261108161615_work_claim_pr_task_binding_v1.sql'){
        successorMigrations.push({name,sql:await fs.readFile(path.join(cloud,'supabase/migrations',name),'utf8')});continue;
      }
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (e) { throw new Error(`Migration ${name}: ${e.message}`, { cause: e }); }
    }
    await allowRawTestBindings(admin);
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'pr-task@example.invalid',now())", [user]);
    const tokens = {}, ids = {};
    for (const [name, scopes] of [['holder', ['context:read', 'context:write']], ['reader', ['context:read']], ['ci', ['context:read']]]) {
      tokens[name] = hash(); ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [user, name, tokens[name], scopes])).rows[0].id;
    }
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [user, ids.ci])).rows[0].id;
    await admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'ci-admission',now(),$3)", [user, ids.ci, roleReceipt]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const human = server.getPgClient(); clients.push(human); await human.connect(); await human.query('set role authenticated');
    const native = async (name, input) => {
      const claims = { sub: user, role: 'authenticated', session_id: 'pr-task-owner-fixture', aal: 'aal1',
        amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) value`, [input])).rows[0].value;
    };
    const call = async (who, name, input) => [...CI_SIGNATURES, PR_LIFECYCLE_REPORT_SIGNATURE].includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    // GitHub shows the PR closed: the resident's lifecycle report ends its binding (20261119140000).
    const reportClosed = n => call('ci', 'clued_work_pr_lifecycle_report_v1', { scope: 'global', repository: repo, prs: [{ pr_number: n, state: 'closed' }] });
    const task = async (scope = 'global') => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope,
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async (task_id, scope = 'global') => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope, write_set: [`fixture/${task_id}/**`], holder_label: 'PR binding fixture', holder_session_ref: uuid(), idempotency_key: uuid() }));
    const authorize = (r, head, pr, extra = {}) => call('holder', 'clued_work_renew_v1', {
      scope: r.claim.context_key, action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      target_branch: 'main', ...(pr ? { pr_number: pr } : {}), idempotency_key: uuid(), ...extra });
    const resolve = (who, number, head, extra = {}) => call(who, 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${number}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main', ...extra });
    const release = r => call('holder', 'clued_work_release_v1', { scope: r.claim.context_key, claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    const counts = async () => {
      const present = (await admin.query("select to_regclass('clued_private.work_claim_pr_task_bindings_v1') present")).rows[0].present;
      const bindings = present ? (await admin.query('select count(*)::int n from clued_private.work_claim_pr_task_bindings_v1')).rows[0].n : 0;
      const uses = (await admin.query('select count(*)::int n from clued_private.work_claim_door_usage_v1')).rows[0].n;
      return { bindings, uses };
    };
    // Real pre-upgrade lifecycle: the old public CI door creates its immutable
    // trusted bind receipt, then closes the PR while its Task claim stays live.
    const historical = await claim(await task()), historicalHead = 'c'.repeat(40);
    committed(await authorize(historical, historicalHead, null, { pr_ref: `${repo}#90` }));
    const legacyVerified = await call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: historical.claim.claim_id,
      pr_ref: `${repo}#90`, head_sha: historicalHead, base_sha: 'b'.repeat(40), target_branch: 'main',
      changed_paths: [`fixture/${historical.claim.task_id}/source.mjs`] });
    assert.equal(legacyVerified.verdict, 'ADMITTED', JSON.stringify(legacyVerified));
    assert.equal((await call('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${repo}#90` })).status, 'ok');
    if (process.env.CLUED_PR_TASK_BASELINE !== '1') await admin.query(candidateMigration);
    if (process.env.CLUED_PR_TASK_BASELINE !== '1') for(const migration of successorMigrations){
      try{await admin.query(migration.sql);}catch(error){throw new Error('Migration '+migration.name+': '+error.message,{cause:error});}
    }

    await t.test('existing CI publication gate alone decides the no-claim advisory case without inventing Task scope', async () => {
      const before = await counts();
      const input = { action: 'publication_begin', pr_ref: `${repo}#9090`, head_sha: '9'.repeat(40),
        base_sha: 'b'.repeat(40), target_branch: 'main', changed_paths: ['docs/fixture.md'], run_id: '9090', publication_key: uuid() };
      assert.deepEqual(await call('ci', 'clued_work_verify_v1', input), { status: 'ok', publication_required: false });
      const denied = await call('reader', 'clued_work_verify_v1', input);
      assert.equal(denied.status, 'rejected'); assert.equal(denied.error_code, 'admission_binding_required');
      assert.deepEqual(await counts(), before, 'no relation, receipt or head budget is manufactured');
    });

    await t.test('historical closed PR imports identity as unknown and cannot keep a new PR queue slot', async () => {
      const read = await resolve('reader', 90, historicalHead);
      // 'unknown' counts as open: the read-only answer reports the holder's exact head grant, without binding or activating.
      assert.equal(read.binding_status, 'bound'); assert.equal(read.auto_bound, false);
      assert.equal(read.task_id, historical.claim.task_id); assert.equal(read.scope, 'global');
      assert.equal(read.claim.claim_id, historical.claim.claim_id);
      const before = await counts();
      const observing = await resolve('ci', 90, historicalHead, { read_only: true });
      assert.equal(observing.binding_status, 'bound'); assert.equal(observing.auto_bound, false); assert.equal(observing.receipt_id, null);
      assert.deepEqual(await counts(), before);
      committed(await authorize(historical, historicalHead, 90));
      assert.equal((await resolve('reader', 90, historicalHead)).binding_status, 'bound',
        'read-only answer reports the authorization; only the CI write resolve activates the relation');
      const currentHead = 'd'.repeat(40);
      committed(await authorize(historical, currentHead, 91));
      assert.equal((await resolve('ci', 91, currentHead)).binding_status, 'bound');
      const queuedHistory = committed(await call('holder', 'clued_work_renew_v1', { scope: 'global', claim_id: historical.claim.claim_id,
        fence: historical.claim.fence, lease_version: historical.claim.lease_version, lease_key: historical.lease_key,
        progress_ref: 'historical-queue:' + uuid(), trigger_refs: [`merge:${repo}:main`] }));
      historical.claim = queuedHistory.claim;
      assert.equal((await call('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${repo}#91` })).status, 'ok');
      const row = (await admin.query('select status,trigger_refs from clued_private.work_claims_v1 where claim_id=$1', [historical.claim.claim_id])).rows[0];
      assert.equal(row.status, 'ACTIVE'); assert.ok(!row.trigger_refs.includes(`merge:${repo}:main`),
        'unknown historical target must not keep a new PR slot');
      committed(await authorize(historical, historicalHead, 90));
      const promoted = await resolve('ci', 90, historicalHead);
      assert.equal(promoted.binding_status, 'bound'); assert.equal(promoted.auto_bound, true); assert.ok(promoted.receipt_id);
      assert.equal((await resolve('ci', 90, historicalHead)).auto_bound, false);
      await call('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${repo}#90` });
      committed(await release(historical));
    });

    await t.test('no trailers: only CI discovery binds once from an existing exact holder head grant', async () => {
      const r = await claim(await task()); const head = '1'.repeat(40);
      committed(await authorize(r, head));
      const before = await counts();
      for (const extra of [{}, { read_only: false }]) {
        const read = await resolve('reader', 1, head, extra);
        assert.equal(read.binding_status, 'unbound'); assert.equal(read.auto_bound, false); assert.equal(read.scope, null);
      }
      const observe = await resolve('ci', 1, head, { read_only: true });
      assert.equal(observe.binding_status, 'unbound'); assert.equal(observe.receipt_id, null);
      assert.deepEqual(await counts(), before);
      const bound = await resolve('ci', 1, head);
      assert.equal(bound.binding_status, 'bound'); assert.equal(bound.task_id, r.claim.task_id);
      assert.equal(bound.scope, 'global'); assert.equal(bound.claim.claim_id, r.claim.claim_id); assert.equal(bound.auto_bound, true);
      const after = await counts(); assert.equal(after.bindings, before.bindings + 1); assert.equal(after.uses, before.uses);
      assert.equal((await resolve('reader', 1, head)).binding_status, 'bound');
      assert.equal((await resolve('ci', 1, head)).auto_bound, false); assert.deepEqual(await counts(), after);
      const newHead = await resolve('reader', 1, '2'.repeat(40));
      assert.equal(newHead.binding_status, 'head_not_authorized'); assert.equal(newHead.claim.claim_id, r.claim.claim_id);
      committed(await release(r));
      assert.equal((await resolve('reader', 1, head)).binding_status, 'no_live_claim');
    });
    await t.test('known PR first authorization, same Task multiple PRs and true Task conflicts', async () => {
      const r = await claim(await task()); const head = '3'.repeat(40);
      const beforeInvalid = await counts();
      for (const [extra, code] of [[{ lease_key: 'clued_lk_' + '0'.repeat(64) }, 'work_claim_lease_key_invalid'],
        [{ fence: r.claim.fence + 1 }, 'work_claim_fence_mismatch'],
        [{ lease_version: r.claim.lease_version + 1 }, 'work_claim_version_conflict']]) {
        const denied = await authorize(r, head, 2, extra);
        assert.equal(denied.status, 'rejected'); assert.equal(denied.error_code, code);
      }
      assert.deepEqual(await counts(), beforeInvalid, 'invalid holder proof cannot create a relation or meter a head');
      committed(await authorize(r, head, 2)); committed(await authorize(r, head, 3));
      const knownUnknown = await resolve('reader', 2, head);
      assert.equal(knownUnknown.binding_status, 'bound'); assert.equal(knownUnknown.task_id, r.claim.task_id);
      assert.equal(knownUnknown.claim.claim_id, r.claim.claim_id, 'unknown counts as open: the live claim is reported');
      const knownObserve = await resolve('ci', 2, head, { read_only: true });
      assert.equal(knownObserve.binding_status, 'bound'); assert.equal(knownObserve.auto_bound, false);
      const knownOpen = await resolve('ci', 2, head);
      assert.equal(knownOpen.binding_status, 'bound'); assert.equal(knownOpen.auto_bound, true); assert.ok(knownOpen.receipt_id);
      assert.equal((await resolve('ci', 3, head)).binding_status, 'bound');
      assert.equal((await resolve('reader', 2, head)).task_id, r.claim.task_id);
      const beforeVerifyNegatives = await counts();
      const exact = { scope: 'global', claim_id: r.claim.claim_id, fence: r.claim.fence,
        pr_ref: `${repo}#2`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main',
        changed_paths: [`fixture/${r.claim.task_id}/source.mjs`] };
      const notCi = await call('reader', 'clued_work_verify_v1', exact);
      assert.equal(notCi.verdict, 'REJECTED'); assert.ok(notCi.reasons.includes('admission_binding_required'));
      const outside = await call('ci', 'clued_work_verify_v1', { ...exact, changed_paths: ['uncovered/source.mjs'] });
      assert.equal(outside.verdict, 'REJECTED'); assert.ok(outside.reasons.includes('paths_outside_write_set'));
      assert.deepEqual(await counts(), beforeVerifyNegatives, 'role and coverage denials neither bind nor meter');
      assert.equal((await resolve('reader', 3, head)).claim.claim_id, r.claim.claim_id);
      const other = await claim(await task());
      const authsBefore = (await admin.query('select count(*)::int n from clued_private.work_claim_head_authorizations_v1')).rows[0].n;
      const rejected = await authorize(other, head, 2);
      assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error_code, 'pr_task_binding_conflict');
      assert.equal((await admin.query('select count(*)::int n from clued_private.work_claim_head_authorizations_v1')).rows[0].n,
        authsBefore, 'Task conflict rolls back its new head authorization atomically');
      assert.equal((await resolve('reader', 2, head)).task_id, r.claim.task_id);
      for (const number of [2, 3]) {
        const verified = await call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id,
          fence: r.claim.fence, pr_ref: `${repo}#${number}`, head_sha: head, base_sha: 'b'.repeat(40),
          target_branch: 'main', changed_paths: [`fixture/${r.claim.task_id}/source.mjs`] });
        assert.equal(verified.verdict, 'ADMITTED', JSON.stringify(verified));
        assert.equal(verified.bound_pr, `${repo}#${number}`); assert.equal(verified.claim.bound_pr, `${repo}#${number}`);
      }
      assert.equal((await admin.query("select count(*)::int n from clued_private.work_claim_door_usage_v1 where task_id=$1 and door='github-ci'", [r.claim.task_id])).rows[0].n,
        1, 'same Task and exact head across two PRs is metered once');
      const queued = committed(await call('holder', 'clued_work_renew_v1', { scope: 'global', claim_id: r.claim.claim_id,
        fence: r.claim.fence, lease_version: r.claim.lease_version, lease_key: r.lease_key,
        progress_ref: 'queue:' + uuid(), trigger_refs: [`merge:${repo}:main`] }));
      const beforeClose = (await admin.query('select trigger_refs,merge_queued_at,admitted_heads from clued_private.work_claims_v1 where claim_id=$1', [r.claim.claim_id])).rows[0];
      assert.equal((await call('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${repo}#2` })).status, 'ok');
      const closed = await reportClosed(2);
      assert.equal(closed.status, 'ok');
      const terminal = await resolve('reader', 2, head);
      assert.equal(terminal.binding_status, 'no_live_claim'); assert.equal(terminal.task_id, r.claim.task_id);
      assert.equal(terminal.scope, 'global'); assert.equal(terminal.claim, null); assert.equal(terminal.reason, 'pr_task_binding_closed');
      assert.equal((await resolve('reader', 3, head)).claim.claim_id, r.claim.claim_id);
      const row = (await admin.query('select status,trigger_refs,merge_queued_at,admitted_heads from clued_private.work_claims_v1 where claim_id=$1', [r.claim.claim_id])).rows[0];
      assert.equal(row.status, 'ACTIVE');
      assert.deepEqual({ trigger_refs: row.trigger_refs, merge_queued_at: row.merge_queued_at, admitted_heads: row.admitted_heads }, beforeClose);
      const merged = await call('ci', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: `${repo}#3`, merge_sha: 'f'.repeat(40) });
      assert.equal(merged.status, 'ok');
      const finished = (await admin.query('select status,trigger_refs from clued_private.work_claims_v1 where claim_id=$1', [r.claim.claim_id])).rows[0];
      assert.equal(finished.status, 'ACTIVE', 'last PR does not complete the Task or release its claim');
      assert.ok(!finished.trigger_refs.includes(`merge:${repo}:main`), 'last PR follows original slot-return lifecycle');
      const mergedTarget = await resolve('reader', 3, head);
      assert.equal(mergedTarget.binding_status, 'no_live_claim'); assert.equal(mergedTarget.task_id, r.claim.task_id);
      assert.equal(mergedTarget.reason, 'pr_task_binding_merged');
      committed(await release(other)); committed(await release(r));
    });
    await t.test('same repo/head grants for different Tasks are ambiguous, including across scopes', async () => {
      const project = uuid(), scope = `project:${project}`;
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
        values($1,$2,'Other scope','other scope',$3,'confirmed',now())`, [project, user, scope]);
      const a = await claim(await task()), b = await claim(await task(scope), scope); const head = '4'.repeat(40);
      committed(await authorize(a, head)); committed(await authorize(b, head));
      const before = await counts(); const ambiguous = await resolve('ci', 4, head, { scope: 'global' });
      assert.equal(ambiguous.binding_status, 'conflict'); assert.equal(ambiguous.task_id, null); assert.equal(ambiguous.claim, null);
      assert.deepEqual(await counts(), before); committed(await release(a)); committed(await release(b));
    });
    await t.test('a new current claim follows the stable Task, old head grants do not', async () => {
      const id = await task(); const old = await claim(id); const head = '5'.repeat(40);
      committed(await authorize(old, head, 5)); assert.equal((await resolve('ci', 5, head)).binding_status, 'bound');
      committed(await release(old));
      const next = await claim(id); const waiting = await resolve('reader', 5, head);
      assert.equal(waiting.binding_status, 'head_not_authorized'); assert.equal(waiting.claim.claim_id, next.claim.claim_id);
      assert.notEqual(next.claim.fence, old.claim.fence); committed(await authorize(next, head));
      assert.equal((await resolve('reader', 5, head)).binding_status, 'bound'); committed(await release(next));
    });
    await t.test('scope is derived from the Task, checked before writes, and never assumed global', async () => {
      const project = uuid(), scoped = `project:${project}`;
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
        values($1,$2,'Derived scope','derived scope',$3,'confirmed',now())`, [project, user, scoped]);
      const r = await claim(await task(scoped), scoped); const head = '7'.repeat(40);
      committed(await authorize(r, head));
      const before = await counts(); const wrong = await resolve('ci', 7, head, { scope: 'global' });
      assert.equal(wrong.binding_status, 'conflict'); assert.equal(wrong.reason, 'scope_not_served'); assert.deepEqual(await counts(), before);
      const derived = await resolve('ci', 7, head);
      assert.equal(derived.binding_status, 'bound'); assert.equal(derived.scope, scoped);
      assert.equal((await resolve('reader', 7, head)).scope, scoped);
      const restricted = hash();
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','global-only reader',$2,array['context:read'],array['global'])`, [user, restricted]);
      await assert.rejects(() => anon.query('select public.clued_work_verify_v1($1,$2)', [restricted,
        { action: 'resolve_pr_claim', pr_ref: `${repo}#7`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main', read_only: true }]),
      /binding_not_authorized|context_not_authorized|binding_context/);
      committed(await release(r));
    });
    await t.test('race copies resolve by unique exact head, ambiguity rejects, and winner carries the Task without reviving losers', async () => {
      const id = await task();
      const issued = await native('clued_work_claim_multi_confirmation_issue_v1', {
        task_id: id, copies: 2, shared_resources: [`fixture/${id}/**`] });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      committed(await native('clued_work_claim_multi_enable_v1', {
        confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
      const a = await claim(id), b = await claim(id);
      assert.notEqual(a.claim.copy_index, b.claim.copy_index);
      const ha = '8'.repeat(40), hb = '9'.repeat(40), hc = 'a'.repeat(40);
      committed(await authorize(a, ha, 8)); committed(await authorize(b, hb, 9));
      assert.equal((await resolve('ci', 8, ha)).binding_status, 'bound');
      assert.equal((await resolve('ci', 9, hb)).binding_status, 'bound');
      assert.equal((await resolve('reader', 8, ha)).claim.claim_id, a.claim.claim_id,
        'older fence is still the exact head owner in an open race');
      assert.equal((await resolve('reader', 9, hb)).claim.claim_id, b.claim.claim_id);
      committed(await authorize(b, ha));
      const ambiguous = await resolve('ci', 8, ha);
      assert.equal(ambiguous.binding_status, 'conflict'); assert.equal(ambiguous.task_id, null); assert.equal(ambiguous.claim, null);
      assert.equal(ambiguous.reason, 'pr_task_current_claim_ambiguous');
      committed(await authorize(a, hc, 10));
      assert.equal((await resolve('ci', 10, hc)).binding_status, 'bound');
      const admitted = await call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: b.claim.claim_id,
        fence: b.claim.fence, pr_ref: `${repo}#9`, head_sha: hb, base_sha: 'b'.repeat(40), target_branch: 'main',
        changed_paths: [`fixture/${id}/source.mjs`] });
      assert.equal(admitted.verdict, 'ADMITTED', JSON.stringify(admitted));
      const adopted = await call('ci', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: `${repo}#9`, merge_sha: 'f'.repeat(40) });
      assert.equal(adopted.adopted, true, JSON.stringify(adopted)); assert.equal(adopted.claim_id, b.claim.claim_id);
      const loser = (await admin.query('select status,outcome from clued_private.work_claims_v1 where claim_id=$1', [a.claim.claim_id])).rows[0];
      assert.deepEqual(loser, { status: 'SUPERSEDED', outcome: 'not_adopted' });
      const inherited = await resolve('reader', 10, hc);
      assert.equal(inherited.binding_status, 'head_not_authorized'); assert.equal(inherited.claim.claim_id, b.claim.claim_id);
      const stale = await authorize(a, hc, 10);
      assert.equal(stale.status, 'rejected'); assert.equal(stale.error_code, 'copy_not_adopted');
      committed(await authorize(b, hc, 10));
      assert.equal((await resolve('reader', 10, hc)).claim.claim_id, b.claim.claim_id);
      committed(await release(b));
    });
    await t.test('real repository holders include Task identity and only active targets of the requested repository', async () => {
      const r = await claim(await task()), head = '6'.repeat(40), otherRepo = 'fixture/other';
      for (const number of [30, 31, 32, 33]) committed(await authorize(r, head, number));
      for (const number of [30, 31, 33]) assert.equal((await resolve('ci', number, head)).binding_status, 'bound');
      await call('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${repo}#33` }); await reportClosed(33);
      committed(await authorize(r, head, 40, { repository: otherRepo }));
      assert.equal((await resolve('ci', 40, head, { pr_ref: `${otherRepo}#40` })).binding_status, 'bound');
      committed(await call('holder', 'clued_work_renew_v1', { scope: 'global', claim_id: r.claim.claim_id,
        fence: r.claim.fence, lease_version: r.claim.lease_version, lease_key: r.lease_key,
        progress_ref: 'holders:' + uuid(), trigger_refs: [`merge:${repo}:main`, `merge:${otherRepo}:main`] }));
      const holders = async repository => {
        const result = await call('ci', 'clued_work_merge_slot_holders_v1', { scope: 'global', repository });
        assert.equal(result.status, 'ok'); assert.equal(result.repository, repository); assert.equal(result.holders.length, 1);
        return result.holders[0];
      };
      const local = await holders(repo);
      assert.equal(local.task_id, r.claim.task_id); assert.equal(local.claim_id, r.claim.claim_id);
      assert.deepEqual(local.bound_prs, [`${repo}#30`, `${repo}#31`]); assert.equal(local.bound_pr, null);
      assert.deepEqual(local.merge_refs, [`merge:${repo}:main`]);
      const other = await holders(otherRepo);
      assert.equal(other.task_id, r.claim.task_id); assert.deepEqual(other.bound_prs, [`${otherRepo}#40`]);
      assert.equal(other.bound_pr, `${otherRepo}#40`); assert.deepEqual(other.merge_refs, [`merge:${otherRepo}:main`]);
      await call('ci', 'clued_work_merge_slot_return_v1', { scope: 'global', pr_ref: `${repo}#30` }); await reportClosed(30);
      const remaining = await holders(repo);
      assert.deepEqual(remaining.bound_prs, [`${repo}#31`]); assert.equal(remaining.bound_pr, `${repo}#31`);
      assert.deepEqual((await holders(otherRepo)).bound_prs, [`${otherRepo}#40`]);
      committed(await release(r));
    });
    await t.test('projection validates inputs, protects tenants and keeps the sole table private', async () => {
      await assert.rejects(() => resolve('reader', 7, 'short'), /work_claim_pr_binding_input_invalid/);
      await assert.rejects(() => resolve('reader', 7, '6'.repeat(40), { read_only: 'false' }), /work_claim_pr_binding_input_invalid/);
      await assert.rejects(() => resolve('reader', 7, '6'.repeat(40), { auto_bind: true }), /work_claim_pr_binding_input_invalid/);
      await assert.rejects(() => anon.query('select * from clued_private.work_claim_pr_task_bindings_v1'), /permission denied/);
      const otherUser = uuid(), foreign = hash();
      await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'foreign@example.invalid',now())", [otherUser]);
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','foreign reader',$2,array['context:read'],array['*'])`, [otherUser, foreign]);
      const result = (await anon.query('select public.clued_work_verify_v1($1,$2) value', [foreign,
        { action: 'resolve_pr_claim', pr_ref: `${repo}#7`, head_sha: '7'.repeat(40), base_sha: 'b'.repeat(40), target_branch: 'main' }])).rows[0].value;
      assert.equal(result.binding_status, 'unbound'); assert.equal(result.task_id, null); assert.equal(result.claim, null);
    });
    await t.test('real Owner handover revokes both PRs and requires a fresh key, epoch authorization and admission', async () => {
      let r = await claim(await task());
      const handover = async () => {
        const issued = await native('clued_work_claim_handover_confirmation_issue_v1', { claim_id: r.claim.claim_id });
        assert.equal(issued.status, 'issued');
        return native('clued_work_claim_handover_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest });
      };
      // The real Owner-confirmed first handover enables the protected key
      // state. No synthetic lease_key_required or pending flag bypass is used.
      const protectedClaim = committed(await handover());
      r = { claim: protectedClaim.claim, lease_key: protectedClaim.lease_key };
      await admin.query("update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),qualification_commit=$1", ['f'.repeat(40)]);
      const heads = [[13, 'e'.repeat(40)], [14, 'f'.repeat(40)]];
      const verify = (number, head) => call('ci', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id,
        fence: r.claim.fence, pr_ref: `${repo}#${number}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main',
        changed_paths: [`fixture/${r.claim.task_id}/source.mjs`] });
      const observation = (number, head) => anon.query('select public.clued_work_verify_v1(null,$1) value',
        [{ action: 'execution_current', repository: repo, pr_ref: `${repo}#${number}`, head_sha: head, target_branch: 'main' }])
        .then(v => v.rows[0].value);
      for (const [number, head] of heads) {
        committed(await authorize(r, head, number));
        assert.equal((await resolve('ci', number, head)).binding_status, 'bound');
        const admitted = await verify(number, head);
        assert.equal(admitted.verdict, 'ADMITTED', JSON.stringify(admitted)); assert.equal(admitted.execution_authorized, true);
        assert.equal((await observation(number, head)).epoch_current, true);
      }
      const old = r, oldEpoch = r.claim.execution_epoch;
      const pending = await handover();
      assert.equal(pending.status, 'pending'); assert.equal('lease_key' in pending, false);
      assert.ok(pending.execution_epoch > oldEpoch); assert.ok(pending.claim.fence > old.claim.fence);
      for (const [number, head] of heads) {
        const paused = await resolve('reader', number, head);
        assert.equal(paused.binding_status, 'handover_pending'); assert.equal(paused.claim.execution_epoch, pending.execution_epoch);
        assert.equal((await observation(number, head)).epoch_current, false);
        const rejected = await verify(number, head);
        assert.equal(rejected.verdict, 'REJECTED'); assert.ok(rejected.reasons.includes('work_claim_handover_pending'));
      }
      const command = input => call('ci', 'clued_work_verify_v1', { scope: 'global', ...input });
      const batch = await command({ action: 'revocations_list' });
      const rows = batch.revocations.filter(v => v.claim_id === r.claim.claim_id);
      assert.ok(rows.length >= 2);
      assert.deepEqual([...new Set(rows.map(v => v.pr_ref).filter(Boolean))].sort(), [`${repo}#13`, `${repo}#14`]);
      for (const item of rows) committed(await command({ action: 'revocation_ack', outbox_id: item.outbox_id,
        execution_epoch: pending.execution_epoch, evidence: { checks_revoked: true, auto_merge_disabled: true, dispatch_revoked: true } }));
      const delivered = committed(await native('clued_work_claim_handover_v1', { action: 'collect', delivery_id: pending.delivery_id }));
      r = { claim: delivered.claim, lease_key: delivered.lease_key };
      const staleKey = await authorize(r, heads[0][1], heads[0][0], { lease_key: old.lease_key });
      assert.equal(staleKey.error_code, 'work_claim_lease_key_invalid');
      const staleFence = await authorize(r, heads[0][1], heads[0][0], { fence: old.claim.fence });
      assert.equal(staleFence.error_code, 'work_claim_fence_mismatch');
      for (const [number, head] of heads) {
        assert.equal((await resolve('reader', number, head)).binding_status, 'head_not_authorized');
        assert.equal((await verify(number, head)).verdict, 'REJECTED');
        assert.equal((await observation(number, head)).epoch_current, false);
      }
      committed(await authorize(r, heads[0][1], heads[0][0]));
      assert.equal((await resolve('reader', heads[1][0], heads[1][1])).binding_status, 'head_not_authorized',
        'fresh authorization for one PR cannot restore the other target');
      assert.equal((await observation(heads[0][0], heads[0][1])).epoch_current, false, 'authorization alone is not CI admission');
      assert.equal((await verify(heads[0][0], heads[0][1])).verdict, 'ADMITTED');
      assert.equal((await observation(heads[0][0], heads[0][1])).epoch_current, true);
      committed(await authorize(r, heads[1][1], heads[1][0]));
      assert.equal((await verify(heads[1][0], heads[1][1])).verdict, 'ADMITTED');
      committed(await release(r));
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid=server.process?.pid;
    await stopCluster(server);
    const stopped=await waitForPidExit(ownPid);
    process.stderr.write('PR binding fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped,true,'this fixture must stop its own PostgreSQL child');
  }
});
