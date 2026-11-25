import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// ci.resident_upgrade under the Owner's automatic approval (migration
// 20261106100000_resident_upgrade_auto_approve_v1, Task ceeaa7c3, Owner Decision
// f8aff2f9): with the switch on the resident-upgrader door approves the request it
// opens with the switch's high-risk rule (once, one use, 24 hours, the requesting
// Binding, the exact resource) and uses the grant in the same call; with the switch
// off the Owner approves. connection.permission and the model.dataset_split.*
// actions stay manual. Since 20261107090000 (Owner Decision 56371a46) a node gets up
// to six automatic approvals in 24 hours and the same package asked again is the
// Owner's; the six, the window and the guards are resident-upgrade-auto-approve-v2-db.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261106100000_resident_upgrade_auto_approve_v1.sql';
const ACTION = 'ci.resident_upgrade';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() }] });
const pkg = (c) => c.repeat(64);
const resource = (node, c) => `ci-resident:${node}/${pkg(c)}`;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('resident upgrade: approved automatically under the switch, counted by node; manual when off',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-resident-upgrade-auto-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
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
    await server.initialise();
    await server.start();
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

    const owner = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'resident-auto@example.invalid',now())`, [owner]);
    const tokens = {}; const ids = {};
    const bind = async (name, scopes, agentName = name) => {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [owner, agentName, tokens[name], scopes])).rows[0].id;
    };
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,null,'global','binding_role_set','binding_role','fixture',1,'{}'::jsonb) returning id`, [owner])).rows[0].id;
    // Each node's upgrader connection, marked resident-upgrade (the Owner marks it on /bindings).
    for (const node of ['node-a', 'node-b', 'node-c']) {
      await bind(node, ['context:read']);
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'resident-upgrade',now()-interval '1 day',$3,now()-interval '1 day','unspecified')`, [owner, ids[node], roleReceipt]);
    }
    await bind('plain', ['context:read']);
    await bind('claude', ['context:read', 'context:write']);

    const anon = await connect('anon');
    const human = await connect('authenticated');
    const native = async (name, input, claims = session(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };
    const upgrade = async (node, res, opId) => (await anon.query('select public.clued_owner_grant_door_consume_v1($1,$2) v',
      [tokens[node], { action: ACTION, resources: [res], op_id: opId }])).rows[0].v;
    const approve = async (requestId) => {
      const token = issued(await native('clued_owner_grant_confirmation_issue_v1', { request_id: requestId, choice: 'once' }));
      return committed(await native('clued_owner_grant_v1', { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
    };
    const grantRow = async (id) => (await admin.query('select * from clued_private.owner_grants_v1 where id=$1', [id])).rows[0];
    const receipt = async (id) => (await admin.query('select operation,binding_id,metadata from public.clued_audit_receipts where id=$1', [id])).rows[0];
    const grantsOf = async (binding) => (await admin.query(`select count(*)::int n from clued_private.owner_grants_v1
      where action=$1 and grantee_binding_id=$2`, [ACTION, binding])).rows[0].n;

    // --- Registry: automatic, high risk; connection.permission and dataset_split stay manual. ---
    assert.deepEqual((await admin.query(`select risk,auto_approvable from clued_private.owner_grant_actions where action=$1`, [ACTION])).rows,
      [{ risk: 'high', auto_approvable: true }]);
    const manual = (await admin.query(`select action from clued_private.owner_grant_actions where not auto_approvable order by action`)).rows
      .map((r) => r.action);
    assert.deepEqual(manual, ['connection.permission', 'fleet.accept', 'model.dataset_split.bootstrap', 'model.dataset_split.producer',
      'model.dataset_split.recognize', 'model.dataset_split.verify']);
    await assert.rejects(() => admin.query(`update clued_private.owner_grant_actions set auto_approvable=true where action='connection.permission'`),
      /owner_grant_actions_auto_approvable_check/);
    let list = await native('clued_owner_grants_list_v1', {});
    assert.equal(list.auto_approve.on, true, 'the switch is on by default');
    assert.ok(list.auto_approve.covers.includes(ACTION));
    assert.deepEqual(list.auto_approve.excluded.map((x) => x.action), manual);

    // --- Switch on: the first request is approved and used in the same call. ---
    const A1 = resource('node-a', 'a');
    const op1 = uuid();
    let r = await upgrade('node-a', A1, op1);
    assert.deepEqual([r.status, r.consumed, r.auto_approved, r.action, r.resources], ['ok', true, true, ACTION, [A1]]);
    assert.deepEqual([r.grant.use, r.grant.max_uses, r.grant.replayed], [1, 1, false]);
    const g1 = await grantRow(r.grant.grant_id);
    assert.ok(g1.auto_approve_id, 'the grant comes from the switch');
    assert.equal(g1.token_id, null);
    assert.deepEqual([g1.grantee_binding_id, g1.resources, g1.max_uses, g1.uses], [ids['node-a'], [A1], 1, 1]);
    assert.equal(g1.expires_at.getTime() - g1.granted_at.getTime(), 24 * 3600 * 1000, 'once, 24 hours');
    const request1 = (await admin.query('select status,grant_id,idempotency_key from clued_private.owner_requests_v1 where id=$1', [g1.request_id])).rows[0];
    assert.deepEqual([request1.status, request1.grant_id, request1.idempotency_key], ['approved_once', g1.id, `resident-upgrade:${op1}`]);
    // Receipts: the switch's grant, the door's use.
    const given = await receipt(g1.receipt_id);
    assert.deepEqual([given.operation, given.binding_id, given.metadata.receipt_kind, given.metadata.principal, given.metadata.policy],
      ['owner_grant', null, 'OWNER_GRANT_GIVEN', 'owner_auto_approve', 'owner_auto_approve_persistent_v1']);
    assert.equal(given.metadata.auto_approve_id, g1.auto_approve_id);
    assert.deepEqual([given.metadata.choices.action, given.metadata.choices.resources, given.metadata.choices.choice,
      given.metadata.choices.max_uses, given.metadata.choices.expires_seconds, given.metadata.choices.grantee_binding_id],
    [ACTION, [A1], 'once', 1, 86400, ids['node-a']]);
    const used = await receipt(r.grant.receipt_id);
    assert.ok(used);
    assert.deepEqual([used.operation, used.binding_id, used.metadata.receipt_kind, used.metadata.door, used.metadata.op_id,
      used.metadata.resources, used.metadata.grant_id, used.metadata.use, used.metadata.max_uses],
    ['owner_grant_use', ids['node-a'], 'OWNER_GRANT_USED', 'resident-upgrader', op1, [A1], g1.id, 1, 1]);
    assert.ok(!('auto_approved' in used.metadata), 'the use receipt is the existing one of the door');
    // The same op replays its use; nothing new is granted.
    const useReceipt = r.grant.receipt_id;
    r = await upgrade('node-a', A1, op1);
    assert.deepEqual([r.consumed, r.grant.grant_id, r.grant.receipt_id, r.grant.replayed], [true, g1.id, useReceipt, true]);
    assert.equal(await grantsOf(ids['node-a']), 1);
    // On /grants the request is decided, nothing waits.
    list = await native('clued_owner_grants_list_v1', {});
    assert.ok(!list.pending_requests.some((x) => x.action === ACTION));

    // --- The same package again, with a new op: the Owner's (20261107090000). ---
    const A2 = A1;
    const op2 = uuid();
    r = await upgrade('node-a', A2, op2);
    assert.deepEqual([r.consumed, r.owner_request.status], [false, 'pending']);
    assert.equal(await grantsOf(ids['node-a']), 1, 'no second automatic grant');
    r = await upgrade('node-a', A2, op2);
    assert.deepEqual([r.consumed, r.owner_request.status], [false, 'pending'], 'asking again does not approve it either');
    list = await native('clued_owner_grants_list_v1', {});
    assert.ok(list.pending_requests.some((x) => x.request_id === r.owner_request.request_id), 'it waits on /grants');
    const byOwner = await approve(r.owner_request.request_id);
    r = await upgrade('node-a', A2, op2);
    assert.deepEqual([r.consumed, r.grant.grant_id, r.auto_approved], [true, byOwner.grant.grant_id, undefined]);
    assert.equal((await grantRow(byOwner.grant.grant_id)).auto_approve_id, null, 'the Owner gave this one');

    // --- Another node is counted on its own. ---
    const B1 = resource('node-b', 'a');
    r = await upgrade('node-b', B1, uuid());
    assert.deepEqual([r.consumed, r.auto_approved], [true, true]);
    // Counted by the node, not the Binding: the Owner unmarks node-b's upgrader and marks a new Binding
    // of node-b; asking for node-b's last package again is the Owner's from it too.
    await admin.query(`update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2
      where binding_id=$1 and role='resident-upgrade'`, [ids['node-b'], roleReceipt]);
    await assert.rejects(upgrade('node-b', resource('node-b', 'e'), uuid()), /owner_grant_door_binding_not_authorized/);
    await bind('node-b-new', ['context:read'], 'node-b');
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values($1,$2,'resident-upgrade',now()-interval '1 minute',$3,now()-interval '1 minute','unspecified')`, [owner, ids['node-b-new'], roleReceipt]);
    r = await upgrade('node-b-new', B1, uuid());
    assert.deepEqual([r.consumed, r.owner_request.status], [false, 'pending'], 'a new Binding of node-b waits for the Owner');
    // A request of another node name is not held by node-b's window.
    r = await upgrade('node-c', resource('node-c', 'e'), uuid());
    assert.deepEqual([r.consumed, r.auto_approved], [true, true]);
    await admin.query(`update clued_private.owner_grants_v1 set granted_at=granted_at-interval '25 hours',
      expires_at=expires_at-interval '25 hours' where grantee_binding_id=$1`, [ids['node-c']]);

    // --- After the Owner's grant, the node's next package is approved automatically again. ---
    r = await upgrade('node-a', resource('node-a', 'c'), uuid());
    assert.deepEqual([r.consumed, r.auto_approved], [true, true]);
    r = await upgrade('node-a', resource('node-a', 'f'), uuid());
    assert.deepEqual([r.consumed, r.auto_approved], [true, true], 'more than one automatic approval in 24 hours');

    // --- Switch off: the Owner approves; on again: the same op's waiting request goes through. ---
    list = await native('clued_owner_grants_list_v1', {});
    committed(await native('clued_owner_auto_approve_set_v1', { enabled: false, base_version: list.auto_approve.version }));
    const C1 = resource('node-c', 'a');
    const opC = uuid();
    const cBefore = await grantsOf(ids['node-c']);
    r = await upgrade('node-c', C1, opC);
    assert.deepEqual([r.consumed, r.owner_request.status], [false, 'pending']);
    assert.equal(await grantsOf(ids['node-c']), cBefore);
    list = await native('clued_owner_grants_list_v1', {});
    committed(await native('clued_owner_auto_approve_set_v1', { enabled: true, base_version: list.auto_approve.version }));
    r = await upgrade('node-c', C1, opC);
    assert.deepEqual([r.consumed, r.auto_approved], [true, true]);

    // --- Revoked after use: the op's replay is no longer consumed, and nothing new is granted for it. ---
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: r.grant.grant_id }));
    r = await upgrade('node-c', C1, opC);
    assert.deepEqual([r.consumed, r.revoked], [false, true]);
    assert.equal(await grantsOf(ids['node-c']), cBefore + 1);

    // --- Rejected and expired requests are never approved automatically. ---
    await admin.query(`update clued_private.owner_grants_v1 set granted_at=granted_at-interval '25 hours',
      expires_at=expires_at-interval '25 hours' where action=$1`, [ACTION]);
    committed(await native('clued_owner_auto_approve_set_v1', { enabled: false,
      base_version: (await native('clued_owner_grants_list_v1', {})).auto_approve.version }));
    const opR = uuid(); const opE = uuid();
    const toReject = (await upgrade('node-b-new', resource('node-b', 'b'), opR)).owner_request;
    const toExpire = (await upgrade('node-b-new', resource('node-b', 'c'), opE)).owner_request;
    committed(await native('clued_owner_request_reject_v1', { request_id: toReject.request_id }));
    await admin.query(`update clued_private.owner_requests_v1 set expires_at=greatest(created_at+interval '1 millisecond',clock_timestamp())
      where id=$1`, [toExpire.request_id]);
    committed(await native('clued_owner_auto_approve_set_v1', { enabled: true,
      base_version: (await native('clued_owner_grants_list_v1', {})).auto_approve.version }));
    r = await upgrade('node-b-new', resource('node-b', 'b'), opR);
    assert.deepEqual([r.consumed, r.owner_request.status], [false, 'rejected']);
    r = await upgrade('node-b-new', resource('node-b', 'c'), opE);
    assert.deepEqual([r.consumed, r.owner_request.status], [false, 'expired']);

    // --- Only a marked node's upgrader reaches the door: the switch grants nobody else anything. ---
    const before = (await admin.query(`select count(*)::int n from clued_private.owner_grants_v1 where action=$1`, [ACTION])).rows[0].n;
    for (const who of ['plain', 'claude']) {
      await assert.rejects(upgrade(who, resource(who === 'plain' ? 'plain' : 'claude', 'a'), uuid()),
        (error) => error.code === '42501' && /owner_grant_door_binding_not_authorized/.test(error.message), who);
    }
    await assert.rejects(upgrade('node-b-new', resource('node-a', 'd'), uuid()), /owner_grant_door_resources_invalid/);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_grants_v1 where action=$1`, [ACTION])).rows[0].n, before);

    // --- connection.permission and dataset_split stay the Owner's: the registry and the CHECK above; the
    // request path itself is owner-auto-approve-db.test.mjs ("never connection.permission"). ---
    assert.deepEqual((await native('clued_owner_grants_list_v1', {})).auto_approve.excluded.map((x) => x.action), manual);

    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
