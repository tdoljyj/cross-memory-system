import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Owner Credential v0.1 §4 item 3 (migration 20261003190000, Task fcd55008,
// Owner Decision c4e82dee): for "grant for a while" the Owner keeps a subset of
// a request's resources and may widen each to a parent wildcard Clued offers.
// Nothing else is accepted, and "approve once" keeps the requested resources.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The sealed G6 closeout qualifies its original sources, before these two
// authorized successors. Keep its real replay and separately prove the current
// catalog rather than asking the historical seal to accept a changed body.
async function applyQualifiedMigrations(admin, names) {
  const targets = ['public.clued_project_mutate(text,jsonb)',
    'public.clued_development_owner_v14(jsonb)', 'public.clued_authorization_manage_v12(jsonb)'];
  const catalog = async () => (await admin.query(`select p.oid, p.oid::regprocedure::text signature,
    pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl
    from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid`, [targets])).rows;
  let originalTargets;
  const successors = new Map([
    ['20261014044323_all_contexts_authorization_v2.sql', 'b78cb49134f2788c3f1fbc7438c4647a8e89cdcedf3519d540305d1105b845b8'],
    ['20261014045157_all_contexts_serialization_v2.sql', 'ce8ee42d89240a338cbd229846c397f9626f1445e2dfa832b60c19fecb994e58'],
  ]);
  for (const name of names) {
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      await assertGatewayCloseoutBoundary(admin);
      const closedCatalog = await snapshotCallerCatalog(admin);
      await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', CLOSEOUT_MIGRATION), 'utf8'));
      await assertGatewayCloseoutBoundary(admin);
      assert.deepEqual(await snapshotCallerCatalog(admin), closedCatalog,
        'actual sealed G6 replay preserves original definitions and ACL at its bounded stage');
      originalTargets = await catalog();
      assert.equal(originalTargets.length, targets.length);
    }
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    if (successors.has(name)) assert.equal(crypto.createHash('sha256').update(sql).digest('hex'), successors.get(name));
    try { await admin.query(sql); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, false);
    }
  }
  assert.ok(originalTargets, 'both successors run only after the bounded closeout proof');
  assert.deepEqual(await catalog(), originalTargets, 'successors preserve existing OIDs, owners, security metadata and ACL');
  await assertGatewayCloseoutBoundary(admin);
  assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  assert.equal((await admin.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid='public.clued_project_mutate(text,jsonb)'::regprocedure")).rows[0].source_hash,
    '64503257b828c3dcf1405fc378a9d297faf559cec29a373e77e5013e2eb76262', 'retired alias keeps its sealed business body');
  for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
    assert.equal((await admin.query("select has_function_privilege($1,'public.clued_project_mutate(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed,
      false, role + ' cannot execute the retired alias');
  }
  for (const signature of ['clued_private.authorization_writer_guard_v2(uuid)',
    'clued_private.authorization_writer_require_v2(uuid)', 'clued_private.authorization_sources_view_v2(uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
      assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed,
        false, `${role} cannot directly call private successor helper ${signature}`);
    }
  }
}

const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
// An old sign-in on purpose: grants do not require a recent login (Decision 667f588b).
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 3 * 86400 }], ...extra });


test('owner grants: the confirmation page narrows or widens a request\'s resources',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-grants-'));
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
    await applyQualifiedMigrations(admin, (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort());
    await allowRawTestBindings(admin);
    await enableManualOwnerApprovalFixture(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'scope@example.invalid',now()),($2,'scope-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['codex', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
    ]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
    }

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
    const native = async (name, input, claims = session(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const consume = async (binding, action, resources, taskId = null) => (await admin.query(
      'select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5) v',
      [userId, binding, action, resources, taskId])).rows[0].v;
    const confirm = async (input, claims) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return issued;
    };
    const grant = (issued, claims, digest = issued.view_digest) =>
      native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: digest }, claims);

    const options = async (resource) => (await admin.query(
      'select clued_private.owner_grant_scope_options_v1($1) v', [resource])).rows[0].v;
    const ask = async (resources, key) => committed(await agent('claude', 'clued_owner_request_v1',
      { action: 'release.production', resources, idempotency_key: key })).request;
    const commit = 'repo:tdoljyj/cross-memory-system/4f49b0e8';
    const record = 'record:2a31ca2a-0ece-476d-af7f-d4ee6dc4d1e0';

    // --- Offered options: the resource itself, then parents, narrowest first. ---
    assert.deepEqual(await options(commit), [commit, 'repo:tdoljyj/cross-memory-system/**']);
    assert.deepEqual(await options('repo:o/n/apps/x/y.ts'),
      ['repo:o/n/apps/x/y.ts', 'repo:o/n/apps/x/**', 'repo:o/n/apps/**', 'repo:o/n/**']);
    assert.deepEqual(await options('repo:o/n/**'), ['repo:o/n/**'], 'never above <owner>/<name>');
    assert.deepEqual(await options('repo:o/n/apps/*.ts'), ['repo:o/n/apps/*.ts', 'repo:o/n/apps/**', 'repo:o/n/**']);
    assert.deepEqual(await options(record), [record], 'a record has no parent');
    assert.deepEqual(await options('storage:c1/a/b.txt'), ['storage:c1/a/b.txt', 'storage:c1/a/**', 'storage:c1/**']);
    assert.deepEqual(await options('docs/a.md'), ['docs/a.md', 'docs/**']);
    await assert.rejects(() => anon.query('select clued_private.owner_grant_scope_options_v1($1)', [commit]),
      /permission denied/);
    await assert.rejects(() => human.query('select clued_private.owner_request_scope_options_v1($1)', [[commit]]),
      /permission denied/);

    // --- The request view lists the options for each requested resource. ---
    const both = await ask([commit, record], 'scope-both');
    const viewed = await native('clued_owner_request_view_v1', { request_id: both.request_id });
    assert.deepEqual(viewed.resource_options, [
      { resource: commit, options: [commit, 'repo:tdoljyj/cross-memory-system/**'] },
      { resource: record, options: [record] },
    ].sort((a, b) => (a.resource < b.resource ? -1 : 1)));

    // --- Widen: the view and the grant carry the chosen parent. ---
    const wide = await confirm({ request_id: both.request_id, choice: 'grant',
      resources: ['repo:tdoljyj/cross-memory-system/**', record] });
    assert.deepEqual(wide.confirmation_view.resources, ['record:2a31ca2a-0ece-476d-af7f-d4ee6dc4d1e0',
      'repo:tdoljyj/cross-memory-system/**'].sort());
    const widened = committed(await grant(wide));
    assert.deepEqual(widened.grant.resources.slice().sort(), [record, 'repo:tdoljyj/cross-memory-system/**'].sort());
    assert.ok(await consume(bindingIds.claude, 'release.production', ['repo:tdoljyj/cross-memory-system/ffffffff']),
      'a widened grant covers another commit');
    assert.equal((await native('clued_owner_request_view_v1', { request_id: both.request_id })).request.status, 'granted');

    committed(await native('clued_owner_grant_revoke_v1', { grant_id: widened.grant.grant_id }));

    // --- Narrow: keep one row; only that resource is granted. ---
    const narrowReq = await ask([commit, record], 'scope-narrow');
    const narrow = await confirm({ request_id: narrowReq.request_id, choice: 'grant', resources: [record] });
    assert.deepEqual(narrow.confirmation_view.resources, [record]);
    const narrowed = committed(await grant(narrow));
    assert.deepEqual(narrowed.grant.resources, [record]);
    assert.equal(await consume(bindingIds.claude, 'release.production', ['repo:tdoljyj/cross-memory-system/eeeeeeee']), null,
      'an unticked resource is not granted');

    // --- Refused: anything not offered, empty, other kinds, typed text, "once". ---
    const refusedReq = await ask([commit], 'scope-refused');
    const refuse = async (input) => (await native('clued_owner_grant_confirmation_issue_v1',
      { request_id: refusedReq.request_id, ...input })).error_code;
    for (const [resources, code] of [
      [['repo:tdoljyj/**'], 'owner_grant_resources_not_offered'],
      [['repo:tdoljyj/other-repo/**'], 'owner_grant_resources_not_offered'],
      [['repo:tdoljyj/cross-memory-system/apps/**'], 'owner_grant_resources_not_offered'],
      [['**'], 'owner_grant_resources_not_offered'],
      [['storage:tdoljyj/cross-memory-system/**'], 'owner_grant_resources_not_offered'],
      [[record], 'owner_grant_resources_not_offered'],
      [[], 'owner_grant_resources_invalid'],
      ['repo:tdoljyj/cross-memory-system/**', 'owner_grant_resources_invalid'],
      [['calendar:x'], 'work_claim_resource_kind_unknown'],
    ]) assert.equal(await refuse({ choice: 'grant', resources }), code, JSON.stringify(resources));
    assert.equal(await refuse({ choice: 'once', resources: [commit] }), 'owner_grant_request_fields_fixed');
    assert.equal(await refuse({ resources: ['repo:tdoljyj/cross-memory-system/**'], action: 'migration.production' }),
      'owner_grant_request_fields_fixed');
    // Normalized spellings of an offered option are the same option.
    const spelled = await confirm({ request_id: refusedReq.request_id, choice: 'grant',
      resources: [' REPO:tdoljyj//cross-memory-system/** '] });
    assert.deepEqual(spelled.confirmation_view.resources, ['repo:tdoljyj/cross-memory-system/**']);
    // Without resources the requested ones are kept, as before.
    const kept = await confirm({ request_id: refusedReq.request_id, choice: 'grant' });
    assert.deepEqual(kept.confirmation_view.resources, [commit]);
    // Only the latest view can be approved: the earlier widened token is revoked.
    assert.equal((await grant(spelled)).error_code, 'confirmation_token_revoked');
    assert.deepEqual(committed(await grant(kept)).grant.resources, [commit]);
    // Current-chain behavior above is qualified independently of the bounded
    // historical closeout replay performed before applying the successors.
    await assertGatewayCloseoutBoundary(admin);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
