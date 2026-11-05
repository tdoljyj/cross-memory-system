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
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Connection permission requests (migration 20261004150000; Owner Decision
// 43ba00e2, Task e86eb58d): a connection that lacks a context or action asks
// for it with clued_owner_request (connection.permission), and the Owner's
// approval on the confirmation page adds exactly that to the same connection.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 60 }], ...extra });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('connection permission requests: ask without the scope, Owner approves once, the same connection gains it',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-connection-permission-'));
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
      // The immutable closeout qualifies its original source bytes. Retain
      // its real replay at that bounded chain, before authorized successors
      // intentionally replace an early-entry legacy alias body.
      if (name === '20261014044323_all_contexts_authorization_v2.sql') {
        await assertGatewayCloseoutBoundary(admin);
        const originalCatalog = await snapshotCallerCatalog(admin);
        await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', CLOSEOUT_MIGRATION), 'utf8'));
        await assertGatewayCloseoutBoundary(admin);
        assert.deepEqual(await snapshotCallerCatalog(admin), originalCatalog, 'original closeout replay preserves its qualified source and ACL');
      }
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);

    const owner = uuid();
    const other = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'connection-permission@example.invalid',now()),($2,'connection-permission-other@example.invalid',now())`,
    [owner, other]);
    const project = uuid();
    const foreign = uuid();
    for (const [id, user, name] of [[project, owner, 'M2'], [foreign, other, 'Not yours']]) {
      await admin.query('insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,$3,$4,$5)',
        [id, user, name, name.toLowerCase(), 'project:' + id]);
    }
    const P = 'project:' + project;

    // A delegated connection that can only read the profile, and a raw Binding.
    const tokens = { chatgpt: hash(), raw: hash(), second: hash() };
    const binding = async (name, scopes, keys, entries) => {
      const id = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'OAuth',$2,$3,$4,$5) returning id`, [owner, name, tokens[name], scopes, keys])).rows[0].id;
      if (!entries) return id;
      await admin.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
        values($1,null,$2,$3,$4,'https://clued.example/mcp',now()+interval '30 days','headless')`, [id, owner, name + '-client', name]);
      for (const [resourceId, actions] of entries) {
        await admin.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
          values($1,'scope',$2,'canonical',$3)`, [id, resourceId, actions]);
      }
      return id;
    };
    const chatgpt = await binding('chatgpt', ['context:read'], ['profile'], [['profile', ['read']]]);
    await binding('raw', ['context:read', 'context:write'], ['*'], null);
    const second = await binding('second', ['context:read'], ['profile'], [['profile', ['read']]]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) => CI_SIGNATURES.includes(name+'(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
      : workerGatewayRpc(workerCaller,name,tokens[who],input);
    const native = async (name, input, claims = session(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const writeOn = (who, context, action = 'write') => admin.query(
      'select (clued_private.resolve_binding_action_v12($1,$2,$3,$4)).id', [tokens[who], 'context:write', context, action]);

    // --- Before: the connection cannot write the project. ---
    await assert.rejects(() => writeOn('chatgpt', P), /binding_not_authorized/);

    // --- A read-only connection asks for write on the project and Global. ---
    const ask = { action: 'connection.permission', resources: [`permission:${P}/write`, 'permission:global/write'],
      idempotency_key: 'chatgpt:m2-write', agent_note: '要把 M2 的安装测试结果记进任务' };
    const created = committed(await agent('chatgpt', 'clued_owner_request_v1', ask));
    const request = created.request;
    assert.equal(request.status, 'pending');
    assert.equal(request.action, 'connection.permission');
    assert.equal(request.confirm_path, `/confirm/${request.request_id}`);
    assert.equal(committed(await agent('chatgpt', 'clued_owner_request_v1', ask)).replayed, true);
    // It reads its own request although it cannot read Global.
    assert.equal((await agent('chatgpt', 'clued_owner_request_status_v1', { request_id: request.request_id })).request.status,
      'pending');

    // --- What cannot be asked. ---
    const refused = async (input, pattern, who = 'chatgpt') => assert.rejects(() => agent(who, 'clued_owner_request_v1',
      { action: 'connection.permission', idempotency_key: 'k-' + hash().slice(0, 12), ...input }), pattern);
    await refused({ resources: ['permission:project:not-a-uuid/write'] }, /owner_request_permission_invalid/);
    await refused({ resources: [`permission:${P}/delete`] }, /owner_request_permission_invalid/);
    await refused({ resources: [`repo:tdoljyj/cross-memory-system/x`] }, /owner_request_permission_invalid/);
    await refused({ resources: [`permission:project:${foreign}/write`] }, /owner_request_permission_not_eligible/);
    await refused({ resources: ['permission:profile/read'] }, /owner_request_permission_already_granted/);
    await refused({ resources: [`permission:${P}/write`], task_id: uuid() }, /owner_request_permission_fields_invalid/);
    await refused({ resources: [`permission:${P}/write`], suggested_grant: { expires_seconds: 600 } },
      /owner_request_permission_fields_invalid/);
    // A raw Binding has no connection authorization to widen.
    await refused({ resources: [`permission:${P}/write`] }, /binding_not_authorized/, 'raw');
    // Another connection cannot read this connection's request without its own scope.
    await assert.rejects(() => agent('second', 'clued_owner_request_status_v1', { request_id: request.request_id }),
      /binding_not_authorized/);

    // --- The Owner's view names each context and action and the connection. ---
    const view = await native('clued_owner_request_view_v1', { request_id: request.request_id });
    assert.equal(view.default_choice, 'once');
    assert.equal(view.view.action_title, '给发起请求的连接加权限');
    assert.deepEqual(view.view.permissions.map(({ context, context_name, action }) => [context, context_name, action]),
      [['global', '个人记录', 'write'], [P, 'M2', 'write']]);
    assert.equal(view.view.connection.binding_id, chatgpt);
    assert.equal(view.view.connection.client_name, 'chatgpt');
    assert.deepEqual(view.view.connection.current,
      [{ resource_kind: 'scope', resource_id: 'profile', environment: 'canonical', actions: ['read'] }]);
    assert.equal(view.view.request.agent_note_unverified, '要把 M2 的安装测试结果记进任务');

    // --- Only "once", only for the requester, only from a request. ---
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1', { request_id: request.request_id, choice: 'grant' }))
      .error_code, 'owner_grant_choice_invalid');
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1',
      { request_id: request.request_id, choice: 'once', grantee: 'any_agent' })).error_code, 'owner_grant_choice_invalid');
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1',
      { action: 'connection.permission', resources: [`permission:${P}/write`] })).error_code, 'owner_grant_action_request_only');

    // --- Approve: the same connection gains exactly what was asked. ---
    const issued = await native('clued_owner_grant_confirmation_issue_v1', { request_id: request.request_id, choice: 'once' });
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    assert.equal(issued.confirmation_view.permissions.length, 2);
    const given = committed(await native('clued_owner_grant_v1',
      { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
    assert.equal(given.grant.action, 'connection.permission');
    const status = await agent('chatgpt', 'clued_owner_request_status_v1', { request_id: request.request_id });
    assert.equal(status.request.status, 'approved_once');
    assert.equal(status.request.grant.uses, 1);

    assert.ok((await writeOn('chatgpt', P)).rows[0].id);
    assert.ok((await writeOn('chatgpt', 'global')).rows[0].id);
    // Nothing beyond the request: no close, no other project, profile unchanged.
    await assert.rejects(() => writeOn('chatgpt', P, 'close'), /resource_action_not_authorized/);
    await assert.rejects(() => writeOn('chatgpt', 'project:' + foreign), /binding_not_authorized/);
    const row = (await admin.query('select scopes,context_keys from public.clued_agent_bindings where id=$1', [chatgpt])).rows[0];
    assert.deepEqual(row.scopes, ['context:read', 'context:write']);
    assert.deepEqual(row.context_keys.sort(), ['global', P, 'profile'].sort());
    assert.deepEqual((await admin.query(`select resource_id,actions from clued_private.authorization_entries_v12
      where binding_id=$1 order by resource_id`, [chatgpt])).rows,
    [{ resource_id: 'global', actions: ['write'] }, { resource_id: 'profile', actions: ['read'] },
      { resource_id: P, actions: ['write'] }].sort((a, b) => a.resource_id.localeCompare(b.resource_id)));
    // The connection keeps its expiry; the change is audited and the grant used up.
    const audit = (await admin.query(`select operation,version from clued_private.authorization_audit_v12
      where binding_id=$1 order by recorded_at`, [chatgpt])).rows;
    assert.ok(audit.some((row) => row.operation === 'sources_projection' && row.version === '1'));
    assert.deepEqual(audit.filter((row) => row.operation === 'extend'), [{ operation: 'extend', version: '2' }]);
    assert.equal((await admin.query(`select clued_private.owner_grant_consume_v1($1,$2,'connection.permission',$3,null) v`,
      [owner, chatgpt, [`permission:${P}/write`]])).rows[0].v, null);
    // The gateway's status check reports the live scopes.
    const live = await workerGatewayRpc(workerCaller,'clued_authorization_status_v12',tokens.chatgpt);
    assert.equal(live.active, true);
    assert.deepEqual(live.scopes, ['context:read', 'context:write']);
    // Asking again for what it now has is refused.
    await refused({ resources: [`permission:${P}/write`] }, /owner_request_permission_already_granted/);

    // --- A connection revoked before approval gains nothing. ---
    const pending = committed(await agent('second', 'clued_owner_request_v1',
      { action: 'connection.permission', resources: [`permission:${P}/read`], idempotency_key: 'second:m2-read' })).request;
    const late = await native('clued_owner_grant_confirmation_issue_v1', { request_id: pending.request_id, choice: 'once' });
    assert.equal(late.status, 'issued', JSON.stringify(late));
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [second]);
    const failed = await native('clued_owner_grant_v1', { confirmation_token: late.confirmation_token, view_digest: late.view_digest });
    assert.equal(failed.status, 'rejected');
    assert.equal(failed.error_code, 'connection_permission_connection_inactive');
    assert.equal((await admin.query('select status from clued_private.owner_requests_v1 where id=$1', [pending.request_id]))
      .rows[0].status, 'pending');
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_grants_v1 where request_id=$1`,
      [pending.request_id])).rows[0].n, 0);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.authorization_entries_v12
      where binding_id=$1 and resource_id=$2`, [second, P])).rows[0].n, 0);

    // --- Agents cannot reach the door or the helpers. ---
    for (const fn of ['connection_permission_apply_v1($1,$2)', 'connection_permission_binding_v1($1)']) {
      const args = fn.includes('$2') ? [owner, uuid()] : [tokens.chatgpt];
      await assert.rejects(() => anon.query(`select clued_private.${fn}`, args), /permission denied/);
      await assert.rejects(() => human.query(`select clued_private.${fn}`, args), /permission denied/);
    }
    // The complete successor chain keeps the qualified gateway/CI surface;
    // the source-specific old closeout replay was tested at its own boundary.
    await assertGatewayCloseoutBoundary(admin);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => undefined);
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
