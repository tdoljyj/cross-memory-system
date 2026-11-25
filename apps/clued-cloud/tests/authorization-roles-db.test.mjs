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
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Permission simplification step 4 (migration 20261004210000_authorization_roles;
// PermissionSimplification.v0.1 §3.1, Decision b32fc5b9, Task 0756c748):
// "我的全部项目（含以后新建的）" is one project:* entry that Clued materializes as
// an entry per project the Owner owns, now and for projects created later, and
// connection.permission requests may name a role.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 60 }], ...extra });


test('authorization roles: project:* covers the Owner\'s projects, including later ones; roles in requests',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-authorization-roles-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
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
      if (name === '20261014044323_all_contexts_authorization_v2.sql') {
        await assertGatewayCloseoutBoundary(admin);
        const originalCatalog = await snapshotCallerCatalog(admin);
        await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', CLOSEOUT_MIGRATION), 'utf8'));
        await assertGatewayCloseoutBoundary(admin);
        assert.deepEqual(await snapshotCallerCatalog(admin), originalCatalog, 'original source closeout replay keeps OIDs and ACL');
      }
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);

    const owner = uuid();
    const other = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'roles@example.invalid',now()),($2,'roles-other@example.invalid',now())`, [owner, other]);
    const newProject = async (user, name) => {
      const id = uuid();
      await admin.query('insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,$3,$4,$5)',
        [id, user, name, name.toLowerCase(), 'project:' + id]);
      return id;
    };
    const m2 = await newProject(owner, 'M2');
    const foreign = await newProject(other, 'Not yours');
    const P = (id) => 'project:' + id;

    // --- The eligible list offers project:*, named, with the scope actions. ---
    const eligible = (await admin.query(`select clued_private.authorization_eligible_v12($1,
      array['context:read','context:write','audit:read']) v`, [owner])).rows[0].v;
    const all = eligible.find((row) => row.resource_id === 'project:*');
    assert.deepEqual(all, { resource_kind: 'scope', resource_id: 'project:*', environment: 'canonical',
      name: '我的全部项目（含以后新建的）', actions: ['read', 'write', 'close', 'restore', 'audit'] });
    const readOnly = (await admin.query(`select clued_private.authorization_eligible_v12($1,array['context:read']) v`,
      [owner])).rows[0].v;
    assert.deepEqual(readOnly.find((row) => row.resource_id === 'project:*').actions, ['read']);

    const tokens = { dev: hash(), reader: hash(), gone: hash() };
    const connect = async (name, scopes, keys, entries) => {
      const id = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'OAuth',$2,$3,$4,$5) returning id`, [owner, name, tokens[name], scopes, keys])).rows[0].id;
      await admin.query('begin');
      await admin.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
        values($1,null,$2,$3,$4,'https://clued.example/mcp',now()+interval '30 days','headless')`, [id, owner, name + '-client', name]);
      for (const [resourceId, actions] of entries) {
        await admin.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
          values($1,'scope',$2,'canonical',$3)`, [id, resourceId, actions]);
      }
      // This is an explicitly seeded pre-source Binding. The old deferred
      // projection-entry trigger is retired; fixtures call the source-aware
      // legacy expander under the real early Owner writer guard.
      if (entries.some(([resourceId]) => resourceId === 'project:*')) {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
        await admin.query('select clued_private.authorization_all_projects_expand_v1($1)', [id]);
      }
      await admin.query('commit');
      return id;
    };
    const entries = async (binding) => Object.fromEntries((await admin.query(`select resource_id,actions
      from clued_private.authorization_entries_v12 where binding_id=$1`, [binding])).rows.map((r) => [r.resource_id, r.actions.sort()]));
    const can = async (who, context, action = 'write') => {
      try {
        await admin.query('select (clued_private.resolve_binding_action_v12($1,$2,$3,$4)).id',
          [tokens[who], action === 'read' ? 'context:read' : action === 'audit' ? 'audit:read' : 'context:write', context, action]);
        return true;
      } catch (error) {
        if (!/binding_not_authorized|resource_action_not_authorized/.test(error.message)) throw error;
        return false;
      }
    };

    // --- 项目开发者 on 我的全部项目: Global read plus project:* read/write/close/restore. ---
    const developer = ['close', 'read', 'restore', 'write'];
    const dev = await connect('dev', ['context:read', 'context:write'], ['global', 'project:*'],
      [['global', ['read']], ['project:*', developer]]);
    assert.deepEqual(await entries(dev), { global: ['read'], 'project:*': developer, [P(m2)]: developer });
    const row = (await admin.query('select scopes,context_keys from public.clued_agent_bindings where id=$1', [dev])).rows[0];
    assert.deepEqual(row.context_keys, ['*']);
    assert.deepEqual(row.scopes.sort(), ['context:read', 'context:write']);
    for (const action of developer) assert.equal(await can('dev', P(m2), action), true, action);
    assert.equal(await can('dev', P(m2), 'audit'), false, 'audit is not part of the role');
    assert.equal(await can('dev', 'global', 'write'), false);
    assert.equal(await can('dev', 'global', 'read'), true);
    assert.equal(await can('dev', 'profile', 'read'), false);
    assert.equal(await can('dev', P(foreign), 'read'), false, 'never another user\'s project');
    // project:* itself is never a context a call acts on.
    assert.equal(await can('dev', 'project:*', 'read'), false);
    // --- A project created later is covered at once. ---
    const later = await newProject(owner, 'Later');
    assert.deepEqual((await entries(dev))[P(later)], developer);
    assert.equal(await can('dev', P(later), 'write'), true);
    // Another user's new project is not.
    const otherLater = await newProject(other, 'Theirs');
    assert.equal((await entries(dev))[P(otherLater)], undefined);
    const audit = (await admin.query(`select operation from clued_private.authorization_audit_v12
      where binding_id=$1 order by recorded_at`, [dev])).rows.map((r) => r.operation);
    assert.ok(audit.includes('sources_projection'), 'legacy project policy uses the same source projection');

    // --- A revoked connection gets nothing new. ---
    const gone = await connect('gone', ['context:read'], ['project:*'], [['project:*', ['read']]]);
    await admin.query('update clued_private.authorizations_v12 set revoked_at=now() where binding_id=$1', [gone]);
    const afterRevoke = await newProject(owner, 'After revoke');
    assert.equal((await entries(gone))[P(afterRevoke)], undefined);

    // --- Reducing project:* to read narrows every covered project. ---
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const native = async (name, input, claims = session(owner)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const version = (await admin.query('select version from clued_private.authorizations_v12 where binding_id=$1', [dev])).rows[0].version;
    await native('clued_authorization_manage_v12', { op: 'reduce', binding_id: dev, base_version: Number(version), selected: [
      { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] },
      { resource_kind: 'scope', resource_id: 'project:*', environment: 'canonical', actions: ['read'] }] });
    assert.deepEqual(await entries(dev), { global: ['read'], 'project:*': ['read'], [P(m2)]: ['read'],
      [P(later)]: ['read'], [P(afterRevoke)]: ['read'] });
    assert.equal(await can('dev', P(m2), 'write'), false);
    assert.equal(await can('dev', P(m2), 'read'), true);

    // --- connection.permission may name a role and project:*. ---
    const reader = await connect('reader', ['context:read'], ['profile'], [['profile', ['read']]]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const agent = async (who, name, input) => CI_SIGNATURES.includes(name+'(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
      : workerGatewayRpc(workerCaller,name,tokens[who],input);
    const asked = await agent('reader', 'clued_owner_request_v1', { action: 'connection.permission',
      resources: ['permission:project:*/developer', 'permission:global/reader'], idempotency_key: 'reader:roles' });
    assert.equal(asked.status, 'committed', JSON.stringify(asked));
    const issued = await native('clued_owner_grant_confirmation_issue_v1', { request_id: asked.request.request_id, choice: 'once' });
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    assert.deepEqual(issued.confirmation_view.permissions.map((p) => [p.context, p.context_name, p.action, p.role]), [
      ['global', '个人记录', 'read', 'reader'],
      ['project:*', '我的全部项目（含以后新建的）', 'read', 'developer'],
      ['project:*', '我的全部项目（含以后新建的）', 'write', 'developer'],
      ['project:*', '我的全部项目（含以后新建的）', 'close', 'developer'],
      ['project:*', '我的全部项目（含以后新建的）', 'restore', 'developer']]);
    const given = await native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest });
    assert.equal(given.status, 'committed', JSON.stringify(given));
    const granted = await entries(reader);
    assert.deepEqual(granted['project:*'], developer);
    assert.deepEqual(granted[P(m2)], developer);
    assert.deepEqual(granted.global, ['read']);
    assert.equal(await can('reader', P(later), 'write'), true);
    // Unknown roles and other users' projects are refused.
    await assert.rejects(() => agent('reader', 'clued_owner_request_v1', { action: 'connection.permission',
      resources: [`permission:${P(m2)}/admin`], idempotency_key: 'reader:bad-role' }), /owner_request_permission_invalid/);
    await assert.rejects(() => agent('reader', 'clued_owner_request_v1', { action: 'connection.permission',
      resources: [`permission:${P(foreign)}/developer`], idempotency_key: 'reader:foreign' }), /owner_request_permission_not_eligible/);
    // The materializer is not callable from the API roles.
    await assert.rejects(() => anon.query('select clued_private.authorization_all_projects_expand_v1($1,null)', [dev]),
      /permission denied/);
    // The old closeout source replay was qualified before the successors;
    // new early writers keep the same actual gateway/CI privilege boundary.
    await assertGatewayCloseoutBoundary(admin);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
