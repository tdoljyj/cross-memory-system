import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';
import { fitNode } from './fit-node-fixture.mjs';

// Binding roles (migration 20261003200000, Task 869d2db7, Owner Decision
// 38ddb8cf): once the Owner marks a CI admission Binding, only it binds claims
// to pull requests, meters heads, admits hand dispatches and reports merges;
// the release-door role is still marked and listed, but since 20261119130000 no token, marked or not,
// consumes release grants: the release workflow is its database login.
// Before a role is marked, every Binding keeps the earlier behaviour.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('binding roles: CI admission and release-door Bindings, set by the Owner in two Native steps',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-binding-roles-'));
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
    await enableManualOwnerApprovalFixture(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'roles@example.invalid',now()),($2,'roles-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const name of ['claude', 'codex', 'reader', 'ci', 'release']) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [userId, name, tokens[name], name === 'reader' || name === 'ci' ? ['context:read'] : ['context:read', 'context:write']])).rows[0].id;
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who],input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'race fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const holders = new Map();
    const claim = async (taskId, who = 'claude', session = 'session-a', writeSet = ['storage:c1/**']) => {
      const result = await agent(who, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), task_id: taskId,
        write_set: writeSet, holder_session_ref: session });
      if (result.status === 'committed') holders.set(result.claim.claim_id, { who, lease_key: result.lease_key });
      return result;
    };
    const release = (who, c) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed' });
    const verify = (c, pr, head = crypto.randomBytes(20).toString('hex')) => agent('reader', 'clued_work_verify_v1',
      { scope: 'global', claim_id: c.claim_id, pr_ref: pr, head_sha: head });
    const gate = async (who, c, resources) => (await admin.query(
      `select clued_private.work_claim_gate_v1($1,$2,'clued-storage','storage_submit','collision_only',$3,$4) v`,
      [userId, bindingIds[who], resources, c ? { claim_id: c.claim_id, fence: c.fence } : null])).rows[0].v;
    const enable = async (input, claims) => {
      const issued = await native('clued_work_claim_multi_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return { issued, enabled: await native('clued_work_claim_multi_enable_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, claims) };
    };
    const row = async (claimId) => (await admin.query(
      'select status,outcome,copy_index,superseded_by from clued_private.work_claims_v1 where claim_id=$1', [claimId])).rows[0];
    const shared = ['storage:c1/final/**'];

    const sha = (i) => i.toString(16).padStart(40, '0');
    const usage = async (taskId) => Number((await admin.query(`select count(*) n from clued_private.work_claim_door_usage_v1
      where user_id=$1 and door='github-ci' and task_id=$2`, [userId, taskId])).rows[0].n);
    // A PR belongs to its Task (20261108161615): the holder's head
    // authorization naming the PR binds it (relation unknown), and only the
    // CI admission Binding's observation activates it. A verify only reads it,
    // with the exact head and base.
    const BASE = 'b'.repeat(40);
    const authorizeHead = async (c, pr, head) => {
      const { who, lease_key } = holders.get(c.claim_id);
      const now = (await admin.query('select fence,lease_version from clued_private.work_claims_v1 where claim_id=$1', [c.claim_id])).rows[0];
      committed(await agent(who, 'clued_work_renew_v1', { scope: 'global', action: 'authorize_head', claim_id: c.claim_id,
        fence: Number(now.fence), lease_version: Number(now.lease_version), lease_key, repository: pr.split('#')[0],
        head_sha: head, target_branch: 'main', pr_number: Number(pr.split('#')[1]), idempotency_key: uuid() }));
    };
    const observe = (who, pr, head) => agent(who, 'clued_work_verify_v1', { action: 'resolve_pr_claim', pr_ref: pr,
      head_sha: head, base_sha: BASE, target_branch: 'main' });
    const bindPr = async (c, pr, head) => {
      await authorizeHead(c, pr, head);
      const seen = await observe('ci', pr, head);
      assert.equal(seen.binding_status, 'bound', JSON.stringify(seen));
    };
    const verifyAs = (who, c, input) => agent(who, 'clued_work_verify_v1', { scope: 'global', claim_id: c.claim_id,
      ...(input.pr_ref ? { base_sha: BASE, target_branch: 'main' } : {}), ...input });
    // A ci-admission mark takes a purpose and starts 5 minutes later (C10,
    // Task bb13efb5, tested in ci-admission-handover-db); here the CI Binding
    // is a resident node's (merge-slot calls admit only that purpose since
    // 20261031060000) and the 5 minutes are let pass. Production marks this
    // Binding (aa4969fb, the GitHub environment admission token) resident-node.
    const ciPurpose = (role, enabled) => role === 'ci-admission' && enabled ? { purpose: 'resident-node' } : {};
    const elapse = (binding) => admin.query(`update clued_private.binding_roles_v1 set granted_at=granted_at-interval '5 minutes',
      effective_at=effective_at-interval '5 minutes' where binding_id=$1 and revoked_at is null and purpose<>'parking'`, [binding]);
    // The CI Binding's node is fit to hold ci-admission (20261114120000); it reports again before each mark.
    const ciNode = await fitNode(admin, { userId, bindingId: bindingIds.ci });
    const setRole = async (binding, role, enabled, claims) => {
      if (binding === bindingIds.ci && role === 'ci-admission' && enabled) await ciNode.heard();
      const issued = await native('clued_binding_role_confirmation_issue_v1',
        { binding_id: binding, role, enabled, ...ciPurpose(role, enabled) }, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      const result = await native('clued_binding_role_set_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, claims);
      if (result.status === 'committed' && enabled) await elapse(binding);
      return result;
    };

    // --- Before any role is marked, no Binding activates a PR. ---
    // Since 20261108161615 only the CI admission Binding's observation makes a
    // PR -> Task relation active; the holder's authorization alone leaves it
    // unknown, and nobody else's verify or observation activates or meters it.
    const legacyTask = await createTask('legacy');
    const legacy = committed(await claim(legacyTask, 'claude', 'session-a', ['legacy/**'])).claim;
    await authorizeHead(legacy, 'o/r#1', sha(1));
    for (const who of ['reader', 'ci']) {
      assert.deepEqual([(await observe(who, 'o/r#1', sha(1))).reason], ['pr_task_binding_unknown'], who);
    }
    let v = await verifyAs('reader', legacy, { pr_ref: 'o/r#1', head_sha: sha(1) });
    assert.deepEqual([v.verdict, v.reasons, v.bound_pr], ['REJECTED', ['pr_task_binding_unknown'], undefined]);
    assert.equal(await usage(legacyTask), 0);
    committed(await release('claude', legacy));

    // --- Only the Owner's Native session manages roles. ---
    for (const name of ['clued_binding_roles_list_v1', 'clued_binding_role_confirmation_issue_v1', 'clued_binding_role_set_v1']) {
      await assert.rejects(() => anon.query(`select public.${name}($1)`, [{}]), /permission denied/, name);
    }
    await assert.rejects(() => anon.query('select * from clued_private.binding_roles_v1'), /permission denied/);
    // PostgREST runs a STABLE or IMMUTABLE RPC in a read-only transaction, and the
    // Native owner check locks the account row (FOR SHARE), which a read-only
    // transaction refuses. Every public RPC that makes the check is VOLATILE.
    await human.query('begin read only');
    await assert.rejects(() => native('clued_binding_roles_list_v1', {}), /read-only transaction/);
    await human.query('rollback');
    assert.deepEqual((await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.provolatile<>'v' and p.prosrc like '%authorization_owner_v12%'
      order by 1`)).rows.map((r) => r.proname), []);
    await assert.rejects(() => human.query('select * from clued_private.binding_roles_v1'), /permission denied/);
    await assert.rejects(() => anon.query('select clued_private.binding_role_admits_v1(b,$1) from public.clued_agent_bindings b limit 1',
      ['ci-admission']), /permission denied/);
    const issueErr = async (input, claims) => (await native('clued_binding_role_confirmation_issue_v1', input, claims)).error_code;
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'merge', enabled: true }), 'binding_role_invalid');
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'ci-admission', enabled: 'yes' }), 'binding_role_input_invalid');
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'ci-admission', enabled: true, x: 1 }), 'binding_role_input_invalid');
    assert.equal(await issueErr({ binding_id: bindingIds.reader, role: 'release-door', enabled: true }), 'binding_role_scope_missing');
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'ci-admission', enabled: false }), 'binding_role_unchanged');
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'ci-admission', enabled: true },
      fresh(otherUser)), 'binding_role_binding_invalid', "another user's Binding");
    const { session_id: _omit, ...noSession } = fresh(userId);
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'ci-admission', enabled: true }, noSession),
      'confirmation_token_session_id_required');
    // The view is rendered by Clued; a newer issue revokes the older token.
    await ciNode.heard();
    const first = await native('clued_binding_role_confirmation_issue_v1', { binding_id: bindingIds.ci, role: 'ci-admission', enabled: true, purpose: 'other' });
    assert.deepEqual([first.confirmation_view.agent_name, first.confirmation_view.role, first.confirmation_view.enabled,
      first.confirmation_view.others], ['ci', 'ci-admission', true, []]);
    assert.match(first.confirmation_view.role_title, /GitHub CI 准入/);
    const second = await native('clued_binding_role_confirmation_issue_v1', { binding_id: bindingIds.ci, role: 'ci-admission', enabled: true, purpose: 'other' });
    assert.equal((await native('clued_binding_role_set_v1', { confirmation_token: first.confirmation_token,
      view_digest: first.view_digest })).error_code, 'confirmation_token_revoked');
    assert.equal((await native('clued_binding_role_set_v1', { confirmation_token: second.confirmation_token,
      view_digest: 'f'.repeat(64) })).error_code, 'confirmation_token_binding_mismatch');
    const marked = await setRole(bindingIds.ci, 'ci-admission', true);
    committed(marked);
    assert.equal((await native('clued_binding_role_set_v1', { confirmation_token: second.confirmation_token,
      view_digest: second.view_digest })).error_code, 'confirmation_token_reused', 'a burned token stays burned');
    const receipt = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [marked.receipt_id])).rows[0].metadata;
    assert.deepEqual([receipt.receipt_kind, receipt.role, receipt.principal], ['BINDING_ROLE_GRANTED', 'ci-admission', 'native_account_session']);
    const listed = await native('clued_binding_roles_list_v1', {});
    assert.deepEqual(listed.bindings.find((b) => b.binding_id === bindingIds.ci).roles, ['ci-admission']);
    assert.deepEqual(listed.bindings.find((b) => b.binding_id === bindingIds.claude).roles, []);
    assert.deepEqual(listed.roles.map((r) => r.role), ['ci-admission', 'release-door', 'resident-upgrade']);

    // --- N2: once marked, only the CI Binding binds, meters and admits dispatches. ---
    const task = await createTask('roles');
    const mine = committed(await claim(task, 'claude', 'session-a', ['roles/**'])).claim;
    // Another Binding's observation does not activate a PR either.
    await authorizeHead(mine, 'o/r#7', sha(2));
    assert.equal((await observe('reader', 'o/r#7', sha(2))).reason, 'pr_task_binding_unknown');
    assert.equal((await observe('ci', 'o/r#7', sha(2))).binding_status, 'bound');
    for (const who of ['claude', 'codex', 'reader']) {
      v = await verifyAs(who, mine, { pr_ref: 'o/r#7', head_sha: sha(2) });
      assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['admission_binding_required']], who);
      v = await verifyAs(who, mine, { head_sha: sha(3), ci_dispatch: true });
      assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['admission_binding_required']], who);
    }
    assert.equal(await usage(task), 0, 'nothing metered');
    v = await verifyAs('codex', mine, { changed_paths: ['roles/a'] });
    assert.deepEqual([v.verdict, v.bound_pr], ['ADMITTED', 'o/r#7'], 'read-only verify stays open to every Binding (it shows the Task PR)');
    await bindPr(mine, 'o/r#7', sha(4));
    v = await verifyAs('ci', mine, { pr_ref: 'o/r#7', head_sha: sha(4), changed_paths: ['roles/a'] });
    assert.deepEqual([v.verdict, v.bound_pr, v.task_ci_heads_24h, v.admitted_heads], ['ADMITTED', 'o/r#7', 1, 1]);
    // A hand dispatch meters its head without binding a pull request.
    v = await verifyAs('ci', mine, { head_sha: sha(5), ci_dispatch: true });
    assert.deepEqual([v.verdict, v.bound_pr, v.task_ci_heads_24h, v.admitted_heads], ['ADMITTED', 'o/r#7', 2, 1]);
    v = await verifyAs('ci', mine, { head_sha: sha(5), ci_dispatch: true });
    assert.equal(v.task_ci_heads_24h, 2, 'the same dispatched head is counted once');
    await admin.query(`insert into clued_private.work_claim_door_usage_v1(user_id,door,task_id,binding_id,claim_id,unit_key,used_at)
      select $1,'github-ci',$2,$3,$4,lpad(to_hex(g),40,'e'),now() from generate_series(1,38) g`,
    [userId, task, bindingIds.ci, mine.claim_id]);
    v = await verifyAs('ci', mine, { head_sha: sha(6), ci_dispatch: true });
    assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['task_ci_head_cap_reached']]);
    for (const input of [{ head_sha: sha(6), ci_dispatch: 'true' }, { ci_dispatch: true },
      { head_sha: sha(4), ci_dispatch: true, pr_ref: 'o/r#7' }]) {
      await assert.rejects(() => verifyAs('ci', mine, input), /work_claim_ci_dispatch_invalid/, JSON.stringify(input));
    }
    committed(await release('claude', mine));

    // --- N1: only the CI Binding reports a merge. ---
    const raceTask = await createTask('roles race');
    assert.equal((await enable({ task_id: raceTask, copies: 2, shared_resources: ['storage:c9/final/**'] })).enabled.status, 'committed');
    const copyA = committed(await claim(raceTask, 'claude', 'session-b', ['storage:c9/**'])).claim;
    const copyB = committed(await claim(raceTask, 'codex', 'session-c', ['storage:c9/**'])).claim;
    v = await verifyAs('codex', copyB, { pr_ref: 'o/r#999', head_sha: sha(9) });
    assert.deepEqual(v.reasons, ['pr_task_binding_unbound'], 'a copy cannot bind itself to a made-up PR');
    await bindPr(copyB, 'o/r#11', sha(10));
    v = await verifyAs('ci', copyB, { pr_ref: 'o/r#11', head_sha: sha(10) });
    assert.equal(v.verdict, 'ADMITTED');
    let adopted = await agent('codex', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: 'o/r#11', merge_sha: sha(11) });
    assert.deepEqual([adopted.adopted, adopted.reason], [false, 'admission_binding_required']);
    assert.equal((await row(copyA.claim_id)).status, 'ACTIVE', 'the honest copy is untouched');
    // The same Binding marked "other" (not a resident node) may not report a merge.
    const ciRolePurpose = (purpose) => admin.query(`update clued_private.binding_roles_v1 set purpose=$2
      where binding_id=$1 and role='ci-admission' and revoked_at is null`, [bindingIds.ci, purpose]);
    await ciRolePurpose('other');
    adopted = await agent('ci', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: 'o/r#11', merge_sha: sha(11) });
    assert.deepEqual([adopted.adopted, adopted.reason], [false, 'admission_binding_required']);
    await ciRolePurpose('resident-node');
    adopted = await agent('ci', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: 'o/r#11', merge_sha: sha(11) });
    assert.deepEqual([adopted.adopted, adopted.copy_index], [true, 2], JSON.stringify(adopted));
    assert.equal((await row(copyA.claim_id)).outcome, 'not_adopted');

    // --- N5: the public release door refuses every token, marked or not. ---
    const commit = 'repo:tdoljyj/cross-memory-system/' + sha(12);
    const door = (who) => agent(who, 'clued_owner_grant_door_consume_v1', { action: 'release.production', resources: [commit] });
    const retired = /owner_grant_door_release_token_retired/;
    await assert.rejects(() => door('codex'), retired, 'no write Binding reaches the release actions');
    await assert.rejects(() => door('reader'), retired);
    committed(await setRole(bindingIds.release, 'release-door', true));
    await assert.rejects(() => door('codex'), retired);
    await assert.rejects(() => door('claude'), retired);
    await assert.rejects(() => door('release'), retired, 'the marked Binding is refused too');

    // --- Ending a role explicitly returns to the earlier behaviour. ---
    committed(await setRole(bindingIds.release, 'release-door', false));
    await assert.rejects(() => door('codex'), retired);
    assert.equal(await issueErr({ binding_id: bindingIds.release, role: 'release-door', enabled: false }), 'binding_role_unchanged');

    // --- Re-review 2, finding A: a revoked or expired holder keeps the role locked. ---
    const t2 = await createTask('roles revoked');
    const c2 = committed(await claim(t2, 'claude', 'session-d', ['roles2/**'])).claim;
    await bindPr(c2, 'o/r#12', sha(13));
    assert.deepEqual((await verifyAs('claude', c2, { pr_ref: 'o/r#12', head_sha: sha(13) })).reasons, ['admission_binding_required']);
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [bindingIds.ci]);
    assert.deepEqual((await verifyAs('claude', c2, { pr_ref: 'o/r#12', head_sha: sha(13) })).reasons, ['admission_binding_required'],
      'a revoked CI Binding does not open binding to every Binding');
    const stillLocked = await agent('codex', 'clued_work_claim_adopt_v1', { scope: 'global', pr_ref: 'o/r#12', merge_sha: sha(13) });
    assert.deepEqual([stillLocked.adopted, stillLocked.reason], [false, 'admission_binding_required']);
    committed(await setRole(bindingIds.release, 'release-door', true));
    await admin.query("update public.clued_agent_bindings set expires_at=now()-interval '1 minute' where id=$1", [bindingIds.release]);
    await assert.rejects(() => door('release'), retired, 'the expired holder itself is refused');
    await assert.rejects(() => door('codex'), retired);
    // The Owner sees the dead holders and can end their roles, but cannot mark a dead Binding.
    const held = (await native('clued_binding_roles_list_v1', {})).bindings;
    assert.deepEqual(held.filter((b) => !b.live).map((b) => [b.binding_id, b.roles]).sort(),
      [[bindingIds.ci, ['ci-admission']], [bindingIds.release, ['release-door']]].sort());
    assert.ok(held.filter((b) => b.live).every((b) => ![bindingIds.ci, bindingIds.release].includes(b.binding_id)));
    assert.equal(await issueErr({ binding_id: bindingIds.ci, role: 'release-door', enabled: true }), 'binding_role_binding_invalid');
    // Rotation: mark a new live Binding; the dead one keeps nothing open.
    committed(await setRole(bindingIds.codex, 'release-door', true));
    await assert.rejects(() => door('codex'), retired, 'the new holder is refused too');
    await assert.rejects(() => door('claude'), retired);
    // Ending the dead CI holder's role, the last one, reopens binding to every Binding.
    committed(await setRole(bindingIds.ci, 'ci-admission', false));
    const v2 = await verifyAs('claude', c2, { pr_ref: 'o/r#12', head_sha: sha(13) });
    assert.deepEqual([v2.verdict, v2.bound_pr], ['ADMITTED', 'o/r#12'],
      'no role marked any more: the earlier behaviour for a PR the CI Binding activated');
    assert.ok(!(await native('clued_binding_roles_list_v1', {})).bindings.some((b) => b.binding_id === bindingIds.ci),
      'a revoked Binding without a role is not listed');
    // This full chain includes the explicit scan-start successor (Worker82/CI8).
    // Historical Worker80 closeout replay is proved by its own phase tests;
    // replaying that old admission manifest over its successor must refuse.
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
