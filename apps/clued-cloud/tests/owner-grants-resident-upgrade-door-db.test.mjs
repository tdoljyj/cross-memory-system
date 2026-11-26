import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, GATEWAY_ROLE, assertGatewayCloseoutBoundary, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

// Resident CI in-place upgrade, PR-0 (migration 20261030010000_resident_upgrade_door_v1,
// Task 018da927, Owner Decisions dda41297 and 3ce5200c): the existing anonymous release
// RPC hands ci.resident_upgrade to the resident-upgrader door. Only a Binding the Owner
// marked resident-upgrade (live and started) uses it; the resource names one node and one
// package exactly; a grant is used once per op_id and replayed by its use receipt; with no
// grant the op's request is returned or opened. Since 20261106100000 (Task ceeaa7c3, Owner
// Decision f8aff2f9) the Owner's automatic approval switch approves it like release.production
// (resident-upgrade-auto-approve-db.test.mjs); this test turns the switch off first, so every
// request below waits for the Owner, as the manual path does.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261030010000_resident_upgrade_door_v1.sql';
const ACTION = 'ci.resident_upgrade';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() }] });
const pkg = (c) => c.repeat(64);
const resource = (node, c) => `ci-resident:${node}/${pkg(c)}`;


test('owner grants: the resident-upgrader door uses an exact Owner Grant once per op (switch off: the Owner approves)',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-resident-upgrade-door-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  const connect = async (role) => {
    const client = server.getPgClient(); clients.push(client); await client.connect();
    if (role) await client.query(`set role ${role}`);
    return client;
  };
  try {
    await startCluster(server);
    const admin = await connect();
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
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(names.includes(MIGRATION));
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    // The Owner's automatic approval is turned off below (after the registry checks): the manual path.

    const owner = uuid();
    const stranger = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'resident-upgrade@example.invalid',now()),($2,'resident-upgrade-other@example.invalid',now())`, [owner, stranger]);
    const tokens = {};
    const ids = {};
    // The agent_name of a resident-upgrade Binding is its node name.
    const bind = async (name, scopes, user = owner, agentName = name) => {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, agentName, tokens[name], scopes])).rows[0].id;
    };
    for (const name of ['node-a', 'node-b', 'early', 'ended', 'plain', 'ciadm']) await bind(name, ['context:read']);
    await bind('node-a-twin', ['context:read'], owner, 'node-a');
    await bind('node-a-copy', ['context:read'], owner, 'node-a');
    await bind('Node_X', ['context:read']);
    await bind('writer', ['context:write']);
    await bind('claude', ['context:read', 'context:write']);
    await bind('release', ['context:read', 'context:write']);
    await bind('foreign', ['context:read'], stranger);

    const anon = await connect('anon');
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const human = await connect('authenticated');
    const native = async (name, input, claims = session(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };
    const agent = async (who, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const door = (who, input) => agent(who, 'clued_owner_grant_door_consume_v1', input);
    const upgrade = (who, res, opId, extra = {}) => door(who, { action: ACTION, resources: res, op_id: opId, ...extra });
    const fails = async (promise, code, message) => {
      await assert.rejects(promise, (error) => {
        assert.equal(error.code, code, error.message);
        assert.match(error.message, message);
        return true;
      });
    };
    const requests = async (binding) => (await admin.query(`select count(*)::int n from clued_private.owner_requests_v1
      where binding_id=$1 and action=$2`, [binding, ACTION])).rows[0].n;
    const confirm = async (input) => issued(await native('clued_owner_grant_confirmation_issue_v1', input));
    const approve = async (input) => {
      const token = await confirm(input);
      return committed(await native('clued_owner_grant_v1',
        { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
    };

    // --- Registry: one action at one door, high risk, automatic under the switch (20261106100000). ---
    assert.deepEqual((await admin.query(`select doors,risk,auto_approvable from clued_private.owner_grant_actions
      where action=$1`, [ACTION])).rows, [{ doors: ['resident-upgrader'], risk: 'high', auto_approvable: true }]);
    assert.deepEqual((await admin.query(`select doors from clued_private.work_claim_resource_kinds where kind='ci-resident'`)).rows,
      [{ doors: ['resident-upgrader'] }]);
    await assert.rejects(() => admin.query(`update clued_private.owner_grant_actions set auto_approvable=true where action='connection.permission'`),
      /owner_grant_actions_auto_approvable_check/);
    let list = await native('clued_owner_grants_list_v1', {});
    assert.equal(list.auto_approve.on, true, 'the automatic approval switch is on by default');
    assert.ok(list.auto_approve.covers.includes(ACTION));
    assert.ok(!list.auto_approve.excluded.some((x) => x.action === ACTION));
    committed(await native('clued_owner_auto_approve_set_v1', { enabled: false, base_version: list.auto_approve.version }));
    assert.equal((await native('clued_owner_grants_list_v1', {})).auto_approve.on, false);

    // --- The role: marked by the Owner in two Native steps, context:read. ---
    const roles = await native('clued_binding_roles_list_v1', {});
    assert.deepEqual(roles.roles.map((r) => [r.role, r.required_scope, r.marked]),
      [['ci-admission', 'context:read', false], ['release-door', 'context:write', false], ['resident-upgrade', 'context:read', false]]);
    const issueRole = (binding, enabled, extra = {}) => native('clued_binding_role_confirmation_issue_v1',
      { binding_id: ids[binding], role: 'resident-upgrade', enabled, ...extra });
    assert.equal((await issueRole('writer', true)).error_code, 'binding_role_scope_missing');
    assert.equal((await issueRole('node-a', true, { purpose: 'resident-node' })).error_code, 'binding_role_purpose_invalid');
    assert.equal((await native('clued_binding_role_confirmation_issue_v1',
      { binding_id: ids['node-a'], role: 'resident-upgrader', enabled: true })).error_code, 'binding_role_invalid');
    const setRole = async (binding, enabled) => {
      const token = issued(await issueRole(binding, enabled));
      assert.equal(token.confirmation_view.role_title, '常驻节点升级门口（消费本节点的原地升级授权）');
      return committed(await native('clued_binding_role_set_v1',
        { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
    };
    const marked = await setRole('node-a', true);
    assert.equal(marked.purpose, 'unspecified');
    await setRole('node-b', true);
    await setRole('ended', true);
    await setRole('ended', false);
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,null,'global','binding_role_set','binding_role','fixture',1,'{}'::jsonb) returning id`, [owner])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at)
      values($1,$2,'resident-upgrade',now(),$3,now()+interval '1 hour')`, [owner, ids.early, roleReceipt]);
    const after = await native('clued_binding_roles_list_v1', {});
    assert.equal(after.roles.find((r) => r.role === 'resident-upgrade').marked, true);
    assert.deepEqual(after.bindings.find((b) => b.binding_id === ids['node-a']).roles, ['resident-upgrade']);

    // --- The role stands alone, reads only, and names one node. ---
    assert.equal((await issueRole('claude', true)).error_code, 'binding_role_scope_invalid');
    assert.equal((await issueRole('Node_X', true)).error_code, 'binding_role_node_name_invalid');
    assert.equal((await issueRole('node-a-copy', true)).error_code, 'binding_role_node_taken');
    // A revoked Binding no longer holds its node name.
    await bind('node-c-old', ['context:read'], owner, 'node-c');
    await bind('node-c', ['context:read']);
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'resident-upgrade',now(),$3)`, [owner, ids['node-c-old'], roleReceipt]);
    assert.equal((await issueRole('node-c', true)).error_code, 'binding_role_node_taken');
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [ids['node-c-old']]);
    issued(await issueRole('node-c', true));
    const issueOther = (binding, role, extra = {}) => native('clued_binding_role_confirmation_issue_v1',
      { binding_id: ids[binding], role, enabled: true, ...extra });
    assert.equal((await issueOther('node-a', 'ci-admission', { purpose: 'other' })).error_code, 'binding_role_exclusive');
    const ciToken = issued(await issueOther('ciadm', 'ci-admission', { purpose: 'other' }));
    committed(await native('clued_binding_role_set_v1', { confirmation_token: ciToken.confirmation_token, view_digest: ciToken.view_digest }));
    assert.equal((await issueRole('ciadm', true)).error_code, 'binding_role_exclusive');
    // A ci-admission handover cannot land on a resident-upgrade Binding.
    assert.equal((await native('clued_binding_role_handover_confirmation_issue_v1',
      { from_binding_id: ids.ciadm, to_binding_id: ids['node-a'] })).error_code, 'binding_role_handover_target_holds_role');
    // A twin of node-a's name marked behind the page's back (it could not be
    // marked there) still cannot use node-a's grant: grants go to the requester.
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'resident-upgrade',now(),$3)`, [owner, ids['node-a-twin'], roleReceipt]);

    const A1 = resource('node-a', 'a');
    const A2 = resource('node-a', 'b');

    // --- Not the exact started holder: 42501, whatever else the input says. ---
    for (const who of ['plain', 'early', 'ended', 'release', 'foreign', 'claude', 'ciadm']) {
      await fails(upgrade(who, [A1], uuid()), '42501', /owner_grant_door_binding_not_authorized/);
    }
    await fails(upgrade('plain', ['bad'], uuid()), '42501', /owner_grant_door_binding_not_authorized/);
    // A marked Binding whose scopes were widened later reads no more: refused.
    await admin.query(`update public.clued_agent_bindings set scopes=array['context:read','context:write'] where id=$1`, [ids['node-b']]);
    await fails(upgrade('node-b', [resource('node-b', 'a')], uuid()), '42501', /owner_grant_door_binding_not_authorized/);
    await admin.query(`update public.clued_agent_bindings set scopes=array['context:read'] where id=$1`, [ids['node-b']]);
    // A node asks only for itself: node-b cannot name node-a, before any grant or request.
    await assert.rejects(upgrade('node-b', [resource('node-a', 'a')], uuid()), (error) =>
      error.code === '22023' && /owner_grant_door_resources_invalid/.test(error.message) && error.detail === 'resident_node_mismatch');
    assert.equal(await requests(ids['node-b']), 0);

    // --- Malformed input or resources: 400 (22023). ---
    for (const res of [[], [A1, A2], ['ci-resident:node-a/*'], ['ci-resident:node-a/**'], [`ci-resident:Node-a/${pkg('a')}`],
      [`ci-resident:node-a/${pkg('A')}`], [`ci-resident:node-a/${'a'.repeat(63)}`], [`ci-resident:-node/${pkg('a')}`],
      [`ci-resident:node-/${pkg('a')}`], [`ci-resident:${'n'.repeat(33)}/${pkg('a')}`], [`ci-resident:node?a/${pkg('a')}`],
      [`repo:o/r/${pkg('a')}`], [` ${A1}`], [`${A1}\n`], [A1.toUpperCase()], [1], 'x']) {
      await fails(upgrade('node-a', res, uuid()), '22023', /owner_grant_door_resources_invalid/);
    }
    for (const input of [
      { action: ACTION, resources: [A1] },
      { action: ACTION, resources: [A1], op_id: 'not-a-uuid' },
      { action: ACTION, resources: [A1], op_id: uuid().toUpperCase() },
      { action: ACTION, resources: [A1], op_id: uuid(), with: [] },
      { action: ACTION, resources: [A1], op_id: uuid(), task_id: uuid() },
      { action: ACTION, resources: [A1], op_id: uuid(), note: 'x'.repeat(2001) },
      { action: ACTION, resources: [A1], op_id: uuid(), note: 7 },
    ]) {
      await fails(door('node-a', input), '22023', /owner_grant_door_input_invalid/);
    }
    assert.equal(await requests(ids['node-a']), 0);

    // --- No grant: one request per op, reused; not approved automatically with the switch off. ---
    const op1 = uuid();
    let result = await upgrade('node-a', [A1], op1, { note: '  升级到 r6 ' });
    assert.deepEqual([result.status, result.consumed, result.action, result.resources], ['ok', false, ACTION, [A1]]);
    const pending = result.owner_request;
    assert.deepEqual([pending.status, pending.action, pending.resources, pending.confirm_path],
      ['pending', ACTION, [A1], `/confirm/${pending.request_id}`]);
    const stored = (await admin.query(`select r.idempotency_key,r.suggested_max_uses,r.agent_note,
        round(extract(epoch from r.expires_at-r.created_at))::int seconds,c.metadata
      from clued_private.owner_requests_v1 r join public.clued_audit_receipts c on c.id=r.receipt_id where r.id=$1`,
    [pending.request_id])).rows[0];
    assert.deepEqual([stored.idempotency_key, stored.suggested_max_uses, stored.agent_note, stored.seconds],
      [`resident-upgrade:${op1}`, 1, '升级到 r6', 86400]);
    assert.deepEqual([stored.metadata.origin, stored.metadata.op_id, stored.metadata.action], ['resident-upgrader', op1, ACTION]);
    result = await upgrade('node-a', [A1], op1);
    assert.deepEqual([result.consumed, result.owner_request.request_id, result.owner_request.status],
      [false, pending.request_id, 'pending']);
    assert.equal(await requests(ids['node-a']), 1);
    await fails(upgrade('node-a', [A2], op1), '22023', /owner_grant_door_input_invalid/);
    // The release actions are no token's any more (the release workflow is its database login).
    await assert.rejects(() => door('release', { action: 'release.production', resources: [`repo:tdoljyj/cross-memory-system/${'c'.repeat(40)}`] }),
      /owner_grant_door_release_token_retired/);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_grants_v1 where action=$1`, [ACTION])).rows[0].n, 0,
      'no automatic grant for ci.resident_upgrade with the switch off');

    // --- The page: only the exact resource, the upgrader's note. ---
    const view = await native('clued_owner_request_view_v1', { request_id: pending.request_id });
    assert.equal(view.status, 'ok');
    assert.equal(view.default_choice, 'once');
    assert.deepEqual(view.resource_options, [{ resource: A1, options: [A1] }]);
    assert.deepEqual([view.view.request.note_source, view.view.request.agent_note_unverified], ['resident-upgrader', '升级到 r6']);
    // Only "once", for the requesting Binding, on the request's own resource.
    for (const input of [{ choice: 'grant' }, { choice: 'grant', resources: ['ci-resident:node-a/**'] },
      { choice: 'grant', resources: [A1], max_uses: 5 }, { choice: 'once', grantee: 'any_agent' }]) {
      assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { request_id: pending.request_id, ...input })).error_code,
        'owner_grant_choice_invalid', JSON.stringify(input));
    }
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1',
      { request_id: pending.request_id, choice: 'once', resources: [A2] })).error_code, 'owner_grant_request_fields_fixed');
    // Never granted on the page without the door's request, glob or not.
    for (const res of [['ci-resident:node-a/**'], [A1]]) {
      assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { action: ACTION, resources: res })).error_code,
        'owner_grant_action_request_only');
    }

    // --- Approved once on the page: used once; the same op replays; a new op does not use it. ---
    const given = await approve({ request_id: pending.request_id, choice: 'once' });
    assert.deepEqual([given.grant.max_uses, given.grant.any_agent], [1, false]);
    result = await upgrade('node-a', [A1], op1);
    assert.deepEqual([result.consumed, result.grant.grant_id, result.grant.use, result.grant.max_uses, result.grant.replayed],
      [true, given.grant.grant_id, 1, 1, false]);
    assert.ok(result.grant.receipt_id && result.grant.expires_at);
    const used = (await admin.query('select binding_id,metadata from public.clued_audit_receipts where id=$1', [result.grant.receipt_id])).rows[0];
    assert.deepEqual([used.binding_id, used.metadata.receipt_kind, used.metadata.door, used.metadata.op_id, used.metadata.resources],
      [ids['node-a'], 'OWNER_GRANT_USED', 'resident-upgrader', op1, [A1]]);
    const replay = await upgrade('node-a', [A1], op1);
    assert.deepEqual([replay.consumed, replay.grant.grant_id, replay.grant.receipt_id, replay.grant.use, replay.grant.replayed],
      [true, given.grant.grant_id, result.grant.receipt_id, 1, true]);
    assert.equal((await admin.query('select uses from clued_private.owner_grants_v1 where id=$1', [given.grant.grant_id])).rows[0].uses, 1);
    await fails(upgrade('node-a', [A2], op1), '22023', /owner_grant_door_input_invalid/);
    await fails(upgrade('node-a-twin', [A1], op1), '22023', /owner_grant_door_input_invalid/);
    // The table keeps every grant of the action once, exact and personal.
    for (const change of [`max_uses=2`, `max_uses=null`, `resources=array['ci-resident:node-a/**']`, `grantee_binding_id=null`,
      `expires_at=granted_at+interval '25 hours'`]) {
      await assert.rejects(() => admin.query(`update clued_private.owner_grants_v1 set ${change} where id=$1`, [given.grant.grant_id]),
        /owner_grants_v1_resident_upgrade_check/, change);
    }
    const op2 = uuid();
    result = await upgrade('node-a', [A1], op2);
    assert.equal(result.consumed, false, 'a new op needs a new grant');
    const pending2 = result.owner_request;
    assert.equal(pending2.status, 'pending');
    assert.notEqual(pending2.request_id, pending.request_id);

    // --- A grant goes to the requesting Binding: another Binding with node-a's name cannot use it. ---
    const given2 = await approve({ request_id: pending2.request_id, choice: 'once' });
    result = await upgrade('node-a-twin', [A1], uuid());
    assert.equal(result.consumed, false, 'node-a-twin opens its own request instead');
    assert.equal(result.owner_request.status, 'pending');
    result = await upgrade('node-a', [A1], op2);
    assert.deepEqual([result.consumed, result.grant.grant_id, result.grant.replayed], [true, given2.grant.grant_id, false]);

    // --- Revoked after use: the op's replay is no longer consumed, and nothing else is used for it. ---
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: given2.grant.grant_id }));
    const before = await requests(ids['node-a']);
    result = await upgrade('node-a', [A1], op2);
    assert.deepEqual([result.consumed, result.revoked, result.grant.grant_id, result.grant.revoked, result.owner_request.request_id],
      [false, true, given2.grant.grant_id, true, pending2.request_id]);
    assert.equal(await requests(ids['node-a']), before);
    // The earlier op's grant was not revoked: it still replays.
    assert.equal((await upgrade('node-a', [A1], op1)).consumed, true);

    // --- A grant for another package never admits (exact match, no covers). ---
    const op5 = uuid();
    const forA2 = (await upgrade('node-a', [A2], op5)).owner_request;
    await approve({ request_id: forA2.request_id, choice: 'once' });
    result = await upgrade('node-a', [resource('node-a', 'd')], uuid());
    assert.equal(result.consumed, false);
    result = await upgrade('node-a', [A2], op5);
    assert.equal(result.consumed, true, 'the grant naming A2 exactly admits A2');

    // --- Rejected and expired requests come back as they are; no new request. ---
    const op3 = uuid();
    const toReject = (await upgrade('node-a', [A1], op3)).owner_request;
    committed(await native('clued_owner_request_reject_v1', { request_id: toReject.request_id }));
    const op4 = uuid();
    const toExpire = (await upgrade('node-a', [A1], op4)).owner_request;
    await admin.query(`update clued_private.owner_requests_v1 set expires_at=greatest(created_at+interval '1 millisecond',clock_timestamp())
      where id=$1`, [toExpire.request_id]);
    const count = await requests(ids['node-a']);
    result = await upgrade('node-a', [A1], op3);
    assert.deepEqual([result.consumed, result.owner_request.request_id, result.owner_request.status], [false, toReject.request_id, 'rejected']);
    result = await upgrade('node-a', [A1], op4);
    assert.deepEqual([result.consumed, result.owner_request.request_id, result.owner_request.status], [false, toExpire.request_id, 'expired']);
    assert.equal(await requests(ids['node-a']), count);

    // --- Door-only: no Agent request, no bundle, no release-door companion. ---
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1',
      { action: ACTION, resources: [A1], idempotency_key: 'resident-upgrade-agent' }), /owner_request_action_door_only/);
    await assert.rejects(() => agent('claude', 'clued_owner_request_bundle_v1', {
      actions: [{ action: ACTION, resources: [A1] }, { action: 'release.production', resources: ['repo:tdoljyj/cross-memory-system/x'] }],
      idempotency_key: 'resident-upgrade-bundle' }), /owner_request_bundle_invalid/);
    await assert.rejects(() => door('release', { action: 'migration.production', resources: ['repo:tdoljyj/cross-memory-system/y'],
      with: [{ action: ACTION, resources: [A1] }] }), /owner_grant_door_release_token_retired/);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_requests_v1 where action=$1 and binding_id=$2`,
      [ACTION, ids.claude])).rows[0].n, 0);

    // --- Only the release RPC reaches the private door; the anon surface is unchanged. ---
    for (const role of ['anon', 'authenticated', 'service_role', GATEWAY_ROLE]) {
      assert.equal((await admin.query(`select has_function_privilege($1,'clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)','EXECUTE') ok`,
        [role])).rows[0].ok, false, role);
    }
    await assert.rejects(() => anon.query('select clued_private.owner_grant_resident_upgrade_door_v1($1,$2)',
      [tokens['node-a'], { action: ACTION, resources: [A1], op_id: uuid() }]), /permission denied/);
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
