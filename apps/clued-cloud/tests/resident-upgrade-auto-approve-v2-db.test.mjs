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

// ci.resident_upgrade under the Owner's automatic approval, second rule
// (migration 20261107090000_resident_upgrade_auto_approve_v2, Owner Decision
// 56371a46): a node gets at most six automatic approvals in 24 hours, counted by
// the node and from the time the request was opened, and a request stays the
// Owner's when
//   - the node's latest grant before it is an automatic one left unused, or one
//     that named the same package (the database holds no fact of whether an
//     upgrade succeeded, so these stand for "the last upgrade did not succeed");
//   - the node's previous request named the same package.
// A grant the Owner gave on the page does not hold the node. The high-risk rule
// (once, one use, 24 hours, the requesting Binding, the exact resource) is
// resident-upgrade-auto-approve-db.test.mjs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261107090000_resident_upgrade_auto_approve_v2.sql';
const ACTION = 'ci.resident_upgrade';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() }] });
const pkg = (c) => c.repeat(64);
const resource = (node, c) => `ci-resident:${node}/${pkg(c)}`;


test('resident upgrade: six automatic approvals per node in 24 hours, held after a failed or repeated upgrade',
  { timeout: 300000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-resident-upgrade-auto-v2-'));
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
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);

    const owner = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'resident-auto-v2@example.invalid',now())`, [owner]);
    const tokens = {}; const ids = {};
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,null,'global','binding_role_set','binding_role','fixture',1,'{}'::jsonb) returning id`, [owner])).rows[0].id;
    // Each node's upgrader connection, marked resident-upgrade (the Owner marks it on /bindings).
    const bindNode = async (name, node = name) => {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read'],array['*']) returning id`, [owner, node, tokens[name]])).rows[0].id;
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'resident-upgrade',now()-interval '1 day',$3,now()-interval '1 day','unspecified')`, [owner, ids[name], roleReceipt]);
    };
    for (const node of ['node-a', 'node-b', 'node-c', 'node-d', 'node-e']) await bindNode(node);

    const anon = await connect('anon');
    const human = await connect('authenticated');
    const native = async (name, input, claims = session(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };
    const upgrade = async (name, res, opId) => (await anon.query('select public.clued_owner_grant_door_consume_v1($1,$2) v',
      [tokens[name], { action: ACTION, resources: [res], op_id: opId }])).rows[0].v;
    const approve = async (requestId) => {
      const token = issued(await native('clued_owner_grant_confirmation_issue_v1', { request_id: requestId, choice: 'once' }));
      return committed(await native('clued_owner_grant_v1', { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
    };
    const setSwitch = async (enabled) => committed(await native('clued_owner_auto_approve_set_v1',
      { enabled, base_version: (await native('clued_owner_grants_list_v1', {})).auto_approve.version }));
    const autoGrants = async (node) => (await admin.query(`select count(*)::int n from clued_private.owner_grants_v1
      where action=$1 and auto_approve_id is not null and resources[1] like $2`, [ACTION, `ci-resident:${node}/%`])).rows[0].n;
    const isAuto = (r, what) => assert.deepEqual([r.status, r.consumed, r.auto_approved], ['ok', true, true], `${what}: ${JSON.stringify(r)}`);
    const isHeld = (r, what) => {
      assert.deepEqual([r.status, r.consumed, r.owner_request?.status], ['ok', false, 'pending'], `${what}: ${JSON.stringify(r)}`);
      return r.owner_request.request_id;
    };
    // The upgrader asks again for the same op: a held request stays held.
    const staysHeld = async (name, res, opId, requestId, what) => {
      const again = await upgrade(name, res, opId);
      assert.equal(isHeld(again, `${what} (asked again)`), requestId);
    };

    assert.deepEqual((await admin.query(`select risk,auto_approvable from clued_private.owner_grant_actions where action=$1`, [ACTION])).rows,
      [{ risk: 'high', auto_approvable: true }]);
    await t.test('the migration is in place', () => assert.ok(names.includes(MIGRATION), `${MIGRATION} is in supabase/migrations`));

    // --- Six automatic approvals per node in 24 hours; the seventh is the Owner's. ---
    await t.test('six per node in 24 hours, counted from the time the request was opened', async () => {
      const packages = ['1', '2', '3', '4', '5', '6'];
      for (const [i, c] of packages.entries()) isAuto(await upgrade('node-a', resource('node-a', c), uuid()), `approval ${i + 1}`);
      assert.equal(await autoGrants('node-a'), 6);
      const op7 = uuid();
      const seventh = isHeld(await upgrade('node-a', resource('node-a', '7'), op7), 'the seventh');
      await staysHeld('node-a', resource('node-a', '7'), op7, seventh, 'the seventh');
      assert.equal(await autoGrants('node-a'), 6);
      // Another node is not held by node-a's six.
      isAuto(await upgrade('node-e', resource('node-e', '1'), uuid()), 'another node');
      // Now: the six grants are 25 hours old, the seventh request 2 hours old (opened 23 hours after them).
      // It was opened inside their 24 hours, so it stays the Owner's however long the upgrader keeps asking.
      await admin.query(`update clued_private.owner_requests_v1 set created_at=now()-interval '2 hours',
        expires_at=now()+interval '22 hours' where id=$1`, [seventh]);
      await admin.query(`update clued_private.owner_grants_v1 set granted_at=now()-interval '25 hours',
        expires_at=now()-interval '1 hour' where action=$1 and resources[1] like 'ci-resident:node-a/%'`, [ACTION]);
      await staysHeld('node-a', resource('node-a', '7'), op7, seventh, 'opened inside the window');
      // A request opened after the window is approved automatically again.
      isAuto(await upgrade('node-a', resource('node-a', '8'), uuid()), 'after the window');
    });

    // --- The latest automatic grant was left unused: the Owner's; a grant the Owner gives clears it. ---
    await t.test('held after an unused automatic grant until the Owner approves one', async () => {
      const first = await upgrade('node-b', resource('node-b', 'a'), uuid());
      isAuto(first, 'first');
      // The door uses an automatic grant in the call that gives it, so an unused one is a fault; the fixture
      // makes it so (the grant's use count back to 0).
      await admin.query('update clued_private.owner_grants_v1 set uses=0 where id=$1', [first.grant.grant_id]);
      const opB = uuid();
      const held = isHeld(await upgrade('node-b', resource('node-b', 'b'), opB), 'after an unused automatic grant');
      await staysHeld('node-b', resource('node-b', 'b'), opB, held, 'after an unused automatic grant');
      // The Owner approves it on the page and the upgrader uses it.
      const byOwner = await approve(held);
      const used = await upgrade('node-b', resource('node-b', 'b'), opB);
      assert.deepEqual([used.consumed, used.grant.grant_id, used.auto_approved], [true, byOwner.grant.grant_id, undefined]);
      // The node's latest grant is now the Owner's: the next package is approved automatically.
      isAuto(await upgrade('node-b', resource('node-b', 'c'), uuid()), 'after the Owner\'s grant');
    });

    // --- The same package again after the latest automatic grant was used: the Owner's. ---
    await t.test('held when the package of the latest automatic grant is asked again', async () => {
      isAuto(await upgrade('node-c', resource('node-c', 'a'), uuid()), 'first');
      // A request for another package that the Owner rejects comes between, so the previous request is not
      // the same package: only the latest grant holds the next one.
      await setSwitch(false);
      const between = isHeld(await upgrade('node-c', resource('node-c', 'b'), uuid()), 'with the switch off');
      committed(await native('clued_owner_request_reject_v1', { request_id: between }));
      await setSwitch(true);
      const opAgain = uuid();
      const held = isHeld(await upgrade('node-c', resource('node-c', 'a'), opAgain), 'the same package again');
      await staysHeld('node-c', resource('node-c', 'a'), opAgain, held, 'the same package again');
      assert.equal(await autoGrants('node-c'), 1);
      // Another package is approved automatically.
      isAuto(await upgrade('node-c', resource('node-c', 'd'), uuid()), 'another package');
    });

    // --- A repeated request for the same package: the Owner's, even with no grant before. ---
    await t.test('held when the previous request named the same package', async () => {
      await setSwitch(false);
      const first = isHeld(await upgrade('node-d', resource('node-d', 'a'), uuid()), 'with the switch off');
      committed(await native('clued_owner_request_reject_v1', { request_id: first }));
      await setSwitch(true);
      assert.equal(await autoGrants('node-d'), 0);
      const opRepeat = uuid();
      const held = isHeld(await upgrade('node-d', resource('node-d', 'a'), opRepeat), 'repeated');
      await staysHeld('node-d', resource('node-d', 'a'), opRepeat, held, 'repeated');
      assert.equal(await autoGrants('node-d'), 0);
      // The next request names another package: approved automatically.
      isAuto(await upgrade('node-d', resource('node-d', 'b'), uuid()), 'another package');
    });

    // --- Unchanged: connection.permission and the dataset_split actions stay the Owner's. ---
    await t.test('connection.permission and dataset_split stay manual', async () => {
      const manual = (await admin.query(`select action from clued_private.owner_grant_actions where not auto_approvable order by action`)).rows
        .map((r) => r.action);
      assert.deepEqual(manual, ['connection.permission', 'fleet.accept', 'model.dataset_split.bootstrap', 'model.dataset_split.producer',
        'model.dataset_split.recognize', 'model.dataset_split.verify']);
      await assert.rejects(() => admin.query(`update clued_private.owner_grant_actions set auto_approvable=true where action='connection.permission'`),
        /owner_grant_actions_auto_approvable_check/);
      // Every automatic grant of this action kept the high-risk rule.
      const bad = (await admin.query(`select id from clued_private.owner_grants_v1 g where action=$1 and auto_approve_id is not null
        and not (max_uses=1 and expires_at-granted_at=interval '24 hours' and cardinality(resources)=1 and grantee_binding_id=
          (select binding_id from clued_private.owner_requests_v1 r where r.id=g.request_id)
          and resources=(select resources from clued_private.owner_requests_v1 r where r.id=g.request_id))`, [ACTION])).rows;
      assert.deepEqual(bad, []);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
