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
import { GATEWAY_ROLE, assertGatewayCloseoutBoundary, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

// Accepting a universal node package (migration 20261125100000_fleet_accept_door_v1, Task 87d330d0,
// plans PLAN-accept-auto-seal-20261125 part A and PLAN-accept-binding-20261125 section 3): the Owner's
// "accept" is an Owner Grant of fleet.accept that only the confirmation page gives. No Binding takes
// part: the release workflow's database login opens the request through a private door, the Owner's
// approval writes the accepted row (one per version) in its own transaction, and anyone reads the
// result anonymously. The automatic approval never approves it, the Owner cannot grant it without the
// door's request, another request for an accepted version is refused, and a rejected request reads
// rejected.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261125100000_fleet_accept_door_v1.sql';
const ACTION = 'fleet.accept';
const REPO = 'tdoljyj/cross-memory-system';
const TITLE = '接受通用节点包（版本与哈希见范围）：全部登记节点原地升级，当班节点升级时 CI 暂停几分钟';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
// The sign-in time in the session claims: a constant (grants need no recent sign-in, Decision 667f588b).
const SIGNED_IN = 1795000000;
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: SIGNED_IN }], ...extra });
const hex = (c) => c.repeat(64);
const resource = (version, tar, request, repo = REPO) => `fleet-node:${repo}/${version}/${hex(tar)}/${hex(request)}`;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('owner grants: fleet.accept is asked by the release login, given only on the page, and recorded by the approval', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-fleet-accept-door-'));
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
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);

    const owner = uuid();
    const stranger = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'fleet-accept@example.invalid',now()),($2,'fleet-accept-other@example.invalid',now())`, [owner, stranger]);
    const tokens = {};
    const ids = {};
    const bind = async (name, scopes, user = owner) => {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
    };
    for (const name of ['reader', 'node-a', 'node-b']) await bind(name, ['context:read']);
    await bind('old-release', ['context:write']);
    await bind('claude', ['context:read', 'context:write']);
    await bind('foreign', ['context:read'], stranger);

    const anon = await connect('anon');
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const service = await connect('service_role');
    const human = await connect('authenticated');
    const native = async (name, input, claims = session(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };
    // The release workflow's database login is the migration login: this test's admin connection.
    const door = async (input) => (await admin.query('select clued_private.fleet_accept_door_v1($1) v', [JSON.stringify(input)])).rows[0].v;
    const ask = (res, extra = {}) => door({ action: ACTION, resources: [res], run_id: '4242', run_attempt: '1', ...extra });
    // Anyone reads the result: PostgREST, anon, no token.
    const read = async (res) => (await anon.query('select public.clued_fleet_accept_status_v1($1) v', [res])).rows[0].v;
    const tokenDoor = (who, input) => anon.query('select public.clued_owner_grant_door_consume_v1($1,$2) v', [tokens[who], input]);
    const fails = async (promise, code, message) => {
      await assert.rejects(promise, (error) => {
        assert.equal(error.code, code, error.message);
        assert.match(error.message, message);
        return true;
      });
    };
    const count = async (table, where = 'true', values = []) =>
      (await admin.query(`select count(*)::int n from clued_private.${table} where ${where}`, values)).rows[0].n;
    const requests = () => count('owner_requests_v1', 'action=$1', [ACTION]);
    const grants = () => count('owner_grants_v1', 'action=$1', [ACTION]);
    const issue = (requestId, input = { choice: 'once' }, claims = session(owner)) =>
      native('clued_owner_grant_confirmation_issue_v1', { request_id: requestId, ...input }, claims);
    const approve = async (requestId) => {
      const token = issued(await issue(requestId));
      return native('clued_owner_grant_v1', { confirmation_token: token.confirmation_token, view_digest: token.view_digest });
    };

    // --- Registry: one action at its own door name, high risk, never automatic (table check). ---
    assert.ok(names.includes(MIGRATION), 'the fleet.accept migration is present');
    assert.deepEqual((await admin.query(`select doors,risk,auto_approvable,title from clued_private.owner_grant_actions
      where action=$1`, [ACTION])).rows, [{ doors: ['fleet-accept'], risk: 'high', auto_approvable: false, title: TITLE }],
    'fleet.accept is registered');
    assert.deepEqual((await admin.query(`select doors from clued_private.work_claim_resource_kinds where kind='fleet-node'`)).rows,
      [{ doors: ['fleet-accept'] }]);
    await assert.rejects(() => admin.query(`update clued_private.owner_grant_actions set auto_approvable=true where action=$1`, [ACTION]),
      /owner_grant_actions_auto_approvable_check/);
    // No Binding role was added for it.
    assert.deepEqual((await native('clued_binding_roles_list_v1', {})).roles.map((r) => r.role),
      ['ci-admission', 'release-door', 'resident-upgrade']);
    // The switch is on for this whole test (its default): every request below still waits for the Owner.
    const list = await native('clued_owner_grants_list_v1', {});
    assert.equal(list.auto_approve.on, true, 'the automatic approval switch is on');
    assert.ok(!list.auto_approve.covers.includes(ACTION));
    assert.ok(list.auto_approve.excluded.some((x) => x.action === ACTION));

    const R1 = resource('18.0.0', 'a', 'b');
    const R1_OTHER_REQUEST = resource('18.0.0', 'a', 'e');
    const V19 = resource('19.0.0-rc.1+build_2', 'c', 'd');

    // --- Before the release identity is registered the door and the read answer nothing. ---
    await fails(ask(R1), '55000', /release_door_identity_missing/);
    await fails(read(R1), '55000', /release_door_identity_missing/);
    // The identity of 20261119130000: the account that held the release-door role, its anchor revoked from birth.
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,null,'global','binding_role_set','binding_role','fixture',1,'{}'::jsonb) returning id`, [owner])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'release-door',now(),$3)`, [owner, ids['old-release'], roleReceipt]);
    await admin.query('select clued_private.release_door_install_v1($1)', [REPO]);
    const identity = (await admin.query('select user_id,anchor_binding_id from clued_private.release_identity_v1')).rows[0];
    assert.equal(identity.user_id, owner);
    const anchor = identity.anchor_binding_id;

    // --- Only the database login reaches the door: every PostgREST role is refused. ---
    for (const role of ['anon', 'authenticated', 'service_role', GATEWAY_ROLE]) {
      for (const signature of ['clued_private.fleet_accept_door_v1(jsonb)', 'clued_private.fleet_accept_apply_v1(uuid,uuid)',
        'clued_private.fleet_accept_answer_v1(uuid,uuid,text)', 'clued_private.fleet_accept_parts_v1(text)']) {
        assert.equal((await admin.query(`select has_function_privilege($1,$2,'EXECUTE') f`, [role, signature])).rows[0].f, false,
          `${role} ${signature}`);
      }
      assert.equal((await admin.query(`select has_table_privilege($1,'clued_private.fleet_accepted_v1','SELECT') t`, [role])).rows[0].t,
        false, role);
      assert.equal((await admin.query(`select has_function_privilege($1,'public.clued_fleet_accept_status_v1(text)','EXECUTE') f`,
        [role])).rows[0].f, role === 'anon', `${role} status`);
    }
    for (const client of [anon, human, service, gateway]) {
      await assert.rejects(() => client.query('select clued_private.fleet_accept_door_v1($1)',
        [JSON.stringify({ action: ACTION, resources: [R1] })]), /permission denied/);
    }
    // --- No Binding token asks for it: the public token door, a request of its own, a bundle. ---
    for (const who of ['reader', 'claude', 'node-a', 'foreign']) {
      await fails(tokenDoor(who, { action: ACTION, resources: [R1], op_id: uuid() }), '22023', /owner_grant_door_action_invalid/);
    }
    await assert.rejects(() => workerGatewayRpc(gateway, 'clued_owner_request_v1', tokens.claude,
      { action: ACTION, resources: [R1], idempotency_key: 'fleet-accept-agent' }), /owner_request_action_door_only/);
    await assert.rejects(() => workerGatewayRpc(gateway, 'clued_owner_request_bundle_v1', tokens.claude, {
      actions: [{ action: ACTION, resources: [R1] }, { action: 'release.production', resources: [`repo:${REPO}/x`] }],
      idempotency_key: 'fleet-accept-bundle' }), /owner_request_bundle_invalid/);
    // The release door (which approves automatically) does not take the action.
    await fails(admin.query('select clued_private.release_door_v1($1)', [JSON.stringify({ action: ACTION, resources: [R1] })]),
      '22023', /release_door_action_invalid/);
    assert.equal(await requests(), 0);

    // --- The door's input: exactly one resource of the registered repository, nothing else. ---
    for (const res of [[], [R1, V19], [`fleet-node:${REPO}/**`], [`fleet-node:${REPO}/18.0.0/${hex('a')}`],
      [`fleet-node:${REPO}/18.0.0/${hex('A')}/${hex('b')}`], [`fleet-node:${REPO}/18.0.0/${hex('a')}/${'b'.repeat(63)}`],
      [`fleet-node:${REPO}/-18/${hex('a')}/${hex('b')}`], [`fleet-node:${REPO}/${'9'.repeat(90)}/${hex('a')}/${hex('b')}`],
      [`fleet-node:cross-memory-system/18.0.0/${hex('a')}/${hex('b')}`], [`fleet-node:${REPO}/18.0.0/x/${hex('a')}/${hex('b')}`],
      [resource('18.0.0', 'a', 'b', 'tdoljyj/other')], [`ci-resident:node-a/${hex('a')}`], [` ${R1}`], [`${R1}\n`], [1], 'x']) {
      await fails(door({ action: ACTION, resources: res }), '22023', /fleet_accept_door_resources_invalid/);
    }
    for (const input of [{ resources: [R1] }, { action: 'release.production', resources: [R1] },
      { action: ACTION, resources: [R1], probe: true }, { action: ACTION, resources: [R1], request_only: true },
      { action: ACTION, resources: [R1], with: [] }, { action: ACTION, resources: [R1], note: 'x' },
      { action: ACTION, resources: [R1], run_id: 'x' }, { action: ACTION, resources: [R1], run_attempt: 0 }, 'x']) {
      await fails(door(input), '22023', /fleet_accept_door_input_invalid/);
    }
    for (const res of ['x', `fleet-node:${REPO}/**`, ` ${R1}`, resource('18.0.0', 'a', 'b', 'tdoljyj/other')]) {
      await fails(read(res), '22023', /fleet_accept_resource_invalid/);
    }
    assert.equal(await requests(), 0);

    // --- Nothing asked yet: none. Every answer carries the request's hash, the resource's last part. ---
    let result = await read(R1);
    assert.deepEqual(result, { status: 'none', action: ACTION, resources: [R1], repository: REPO, version: '18.0.0',
      archive_sha256: hex('a'), request_sha256: hex('b') });

    // --- 1. The release login asks: pending, with the confirmation path. ---
    result = await ask(R1);
    assert.deepEqual([result.status, result.action, result.resources, result.request_sha256, result.confirm_path],
      ['pending', ACTION, [R1], hex('b'), `/confirm/${result.request_id}`]);
    // The whole answer, key for key: rollout/fleet/accept-door.mjs readAnswer reads confirm_path and expires_at at the top.
    assert.deepEqual(Object.keys(result).sort(), ['action', 'archive_sha256', 'confirm_path', 'expires_at', 'repository', 'request_id',
      'request_sha256', 'resources', 'status', 'version']);
    const pending = result;
    const stored = (await admin.query(`select r.binding_id,r.suggested_max_uses,r.agent_note,
        round(extract(epoch from r.expires_at-r.created_at))::int seconds,r.expires_at
      from clued_private.owner_requests_v1 r where r.id=$1`, [pending.request_id])).rows[0];
    assert.deepEqual([stored.binding_id, stored.suggested_max_uses, stored.agent_note, stored.seconds], [anchor, 1, null, 86400]);
    assert.equal(Date.parse(pending.expires_at), stored.expires_at.getTime());
    // The anonymous read gives the same answer.
    assert.deepEqual(await read(R1), pending);

    // --- 2. The automatic approval switch is on: still pending, however often it asks; no second request. ---
    for (let i = 0; i < 2; i += 1) assert.deepEqual(await ask(R1), pending);
    assert.equal(await requests(), 1);
    assert.equal(await grants(), 0, 'no automatic grant of fleet.accept with the switch on');
    assert.equal(await count('fleet_accepted_v1'), 0);
    // The automatic step itself leaves the request as it is.
    const untouched = (await admin.query(`select (clued_private.owner_auto_approve_request_v1(r)).status
      from clued_private.owner_requests_v1 r where r.id=$1`, [pending.request_id])).rows[0].status;
    assert.equal(untouched, 'pending');
    // Another request of the same version, asked before anything is accepted (used in 5 below).
    const rival = await ask(R1_OTHER_REQUEST);
    assert.deepEqual([rival.status, rival.request_sha256], ['pending', hex('e')]);
    assert.notEqual(rival.request_id, pending.request_id);

    // --- 3. Nobody but the Owner's signed-in session approves. ---
    for (const rpc of ['clued_owner_grant_confirmation_issue_v1', 'clued_owner_grant_v1', 'clued_owner_request_view_v1']) {
      await assert.rejects(() => anon.query(`select public.${rpc}($1)`, [{ request_id: pending.request_id, choice: 'once' }]),
        /permission denied/, rpc);
    }
    // A delegated OAuth token of the Owner's account (client_id) is not the Owner's own session either.
    await assert.rejects(() => issue(pending.request_id, { choice: 'once' }, session(owner, 'sess-main', { client_id: 'some-agent' })),
      /direct_human_session_required/);
    // Another account sees no such request.
    assert.equal((await issue(pending.request_id, { choice: 'once' }, session(stranger))).error_code, 'owner_request_not_found');
    assert.equal(await grants(), 0);

    // --- The page: the exact resource, once, for the requester; the Owner cannot grant it without the door's request. ---
    const view = await native('clued_owner_request_view_v1', { request_id: pending.request_id });
    assert.equal(view.status, 'ok');
    assert.equal(view.default_choice, 'once');
    assert.deepEqual(view.resource_options, [{ resource: R1, options: [R1] }]);
    assert.equal(view.view.action_title, TITLE);
    assert.deepEqual(view.view.resources, [R1]);
    for (const input of [{ choice: 'grant' }, { choice: 'grant', resources: [`fleet-node:${REPO}/**`] },
      { choice: 'grant', resources: [R1], max_uses: 5 }, { choice: 'once', grantee: 'any_agent' }]) {
      assert.equal((await issue(pending.request_id, input)).error_code, 'owner_grant_choice_invalid', JSON.stringify(input));
    }
    assert.equal((await issue(pending.request_id, { choice: 'once', resources: [V19] })).error_code, 'owner_grant_request_fields_fixed');
    for (const res of [[`fleet-node:${REPO}/**`], [R1]]) {
      assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { action: ACTION, resources: res })).error_code,
        'owner_grant_action_request_only');
    }
    assert.equal(await grants(), 0);

    // Registered nodes of this account report their Source and state; a retired one is not listed.
    const project = uuid();
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'Fleet','fleet',$3)`,
      [project, owner, `project:${project}`]);
    const node = async (name, binding, state, source, reported = 'NORMAL') => {
      const id = (await admin.query(`insert into clued_private.ci_nodes_v1(user_id,project_id,binding_id,name,profile,profile_sha256,
          identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,state,registration_digest,idempotency_key)
        values($1,$2,$3,$4,'{}',$5,'{}','{}',$6,$7,$8,$9,$10) returning node_id`,
      [owner, project, ids[binding], name, hash(), hash(), hash(), state, hash(), `node-${name}-${state}`])).rows[0].node_id;
      if (source !== undefined) {
        await admin.query(`insert into clued_private.ci_node_liveness_v1(node_id,user_id,last_heartbeat_at,last_sender_binding_id,
            heartbeat_sequence,reported_state,reported_service_running,reported_source_sha256)
          values($1,$2,clock_timestamp(),$3,1,$5,true,$4)`, [id, owner, ids[binding], source, reported]);
      }
    };
    await node('desk', 'node-a', 'active', hex('5'));
    await node('turing', 'node-b', 'active', null, 'PAUSED');
    await node('gone', 'reader', 'retired', hex('6'));
    await node('silent', 'claude', 'pending', undefined);

    // --- 4. The Owner approves on the page: that transaction writes the accepted row and the use receipt. ---
    const receiptsBefore = (await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
    const given = committed(await approve(pending.request_id));
    assert.deepEqual([given.grant.max_uses, given.grant.any_agent], [1, false]);
    const grantRow = (await admin.query(`select granted_at,auto_approve_id,token_id is not null page,grantee_binding_id,uses
      from clued_private.owner_grants_v1 where id=$1`, [given.grant.grant_id])).rows[0];
    assert.deepEqual([grantRow.auto_approve_id, grantRow.page, grantRow.grantee_binding_id, grantRow.uses], [null, true, anchor, 1]);
    // Nothing called the door in between: the approval alone wrote the row.
    const rows = (await admin.query('select * from clued_private.fleet_accepted_v1')).rows;
    assert.equal(rows.length, 1);
    const used = (await admin.query('select binding_id,metadata from public.clued_audit_receipts where id=$1', [rows[0].receipt_id])).rows[0];
    assert.deepEqual([rows[0].user_id, rows[0].repository, rows[0].version, rows[0].archive_sha256, rows[0].request_sha256,
      rows[0].grant_id, rows[0].binding_id, rows[0].accepted_at.getTime()],
    [owner, REPO, '18.0.0', hex('a'), hex('b'), given.grant.grant_id, anchor, grantRow.granted_at.getTime()]);
    assert.deepEqual([used.binding_id, used.metadata.receipt_kind, used.metadata.door, used.metadata.used_by, used.metadata.resources,
      used.metadata.grant_id, used.metadata.request_id],
    [anchor, 'OWNER_GRANT_USED', 'fleet-accept', 'owner_approval', [R1], given.grant.grant_id, pending.request_id]);
    assert.notEqual(rows[0].receipt_id, given.receipt_id, 'the use receipt is its own, beside the grant receipt');
    // Two receipts: the grant and its use.
    assert.equal((await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n, receiptsBefore + 2);

    // The anonymous read answers accepted: the grant, the receipt, the time of the approval, the nodes.
    result = await read(R1);
    assert.deepEqual([result.status, result.action, result.resources, result.grant_id, result.receipt_id],
      ['accepted', ACTION, [R1], given.grant.grant_id, rows[0].receipt_id]);
    assert.equal(Date.parse(result.accepted_at), grantRow.granted_at.getTime());
    assert.deepEqual([result.repository, result.version, result.archive_sha256, result.request_sha256], [REPO, '18.0.0', hex('a'), hex('b')]);
    // The whole answer, key for key, and each node exactly what accept-door.mjs readFleet uses: its name, its reported Source, paused.
    assert.deepEqual(Object.keys(result).sort(), ['accepted_at', 'action', 'archive_sha256', 'grant_id', 'nodes', 'receipt_id', 'repository',
      'request_sha256', 'resources', 'status', 'version']);
    assert.deepEqual(result.nodes, [{ name: 'desk', source_sha256: hex('5'), paused: false }, { name: 'silent', source_sha256: null, paused: false },
      { name: 'turing', source_sha256: null, paused: true }]);
    // The door replays the same answer and writes nothing, also after the Owner revokes the used grant.
    const written = async () => [await requests(), await grants(), await count('fleet_accepted_v1')];
    const before = await written();
    assert.deepEqual(await ask(R1), result);
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: given.grant.grant_id }));
    assert.deepEqual(await ask(R1), result);
    assert.deepEqual(await read(R1), result);
    assert.deepEqual(await written(), before);
    // The read shows the nodes as they report now.
    await admin.query(`update clued_private.ci_node_liveness_v1 set reported_source_sha256=$1,reported_state='NORMAL'
      where reported_source_sha256 is null`, [hex('5')]);
    assert.deepEqual((await read(R1)).nodes.map((n) => [n.name, n.source_sha256, n.paused]),
      [['desk', hex('5'), false], ['silent', null, false], ['turing', hex('5'), false]]);

    // --- 5. The same version under another request or archive: refused, nothing opened, never approved. ---
    for (const res of [R1_OTHER_REQUEST, resource('18.0.0', 'f', 'b')]) {
      await fails(ask(res), '22023', /fleet_accept_version_already_accepted/);
      assert.deepEqual(await read(res), { status: 'none', conflict: 'fleet_accept_version_already_accepted', action: ACTION,
        resources: [res], repository: REPO, version: '18.0.0', archive_sha256: res.split('/')[3], request_sha256: res.split('/')[4] });
    }
    assert.deepEqual(await written(), before);
    // The request opened for it before the acceptance is still on the page: approving it is refused whole.
    const refused = await approve(rival.request_id);
    assert.deepEqual([refused.status, refused.error_code], ['rejected', 'fleet_accept_version_already_accepted']);
    assert.deepEqual(await written(), before);
    assert.equal((await read(R1)).grant_id, given.grant.grant_id);
    // The table keeps every grant of the action once, exact, for the requester, from the page.
    for (const change of ['max_uses=2', 'max_uses=null', `resources=array['fleet-node:${REPO}/**']`, 'grantee_binding_id=null',
      `expires_at=granted_at+interval '25 hours'`]) {
      await assert.rejects(() => admin.query(`update clued_private.owner_grants_v1 set ${change} where id=$1`, [given.grant.grant_id]),
        /owner_grants_v1_fleet_accept_check/, change);
    }

    // --- 6. Rejected: it reads rejected and nothing is accepted. Asking again opens a new request. ---
    const toReject = await ask(V19);
    assert.equal(toReject.status, 'pending');
    committed(await native('clued_owner_request_reject_v1', { request_id: toReject.request_id }));
    result = await read(V19);
    assert.deepEqual([result.status, result.action, result.resources, result.request_id, result.request_sha256],
      ['rejected', ACTION, [V19], toReject.request_id, hex('d')]);
    assert.equal(result.confirm_path, undefined);
    assert.equal(await count('fleet_accepted_v1', 'version=$1', ['19.0.0-rc.1+build_2']), 0);
    const again = await ask(V19);
    assert.equal(again.status, 'pending');
    assert.notEqual(again.request_id, toReject.request_id);
    // Expired: it reads expired; asking again opens a new request, which the Owner can accept.
    await admin.query(`update clued_private.owner_requests_v1 set expires_at=greatest(created_at+interval '1 millisecond',clock_timestamp())
      where id=$1`, [again.request_id]);
    result = await read(V19);
    assert.deepEqual([result.status, result.request_id, result.request_sha256], ['expired', again.request_id, hex('d')]);
    const reopened = await ask(V19);
    assert.equal(reopened.status, 'pending');
    assert.notEqual(reopened.request_id, again.request_id);
    committed(await approve(reopened.request_id));
    result = await read(V19);
    assert.deepEqual([result.status, result.version, result.request_sha256], ['accepted', '19.0.0-rc.1+build_2', hex('d')]);
    assert.equal(await count('fleet_accepted_v1'), 2);

    // --- The surface: one more anonymous definer RPC (the read), named in the boundary fixture; nothing else. ---
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
