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
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Permission simplification step 3 (migration 20261004200000_owner_request_bundles;
// PermissionSimplification.v0.1 §3.3, Task 23045c17): one approval for several
// actions. An Agent asks for 2 to 5 actions in one call; the release door opens
// its own request together with the others the run names. Members stay
// ordinary requests: each is confirmed over its own view, gets its own grant,
// and each door consumes its own grant once.

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

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('owner request bundles: one link for several actions, each member granted and consumed on its own',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-request-bundles-'));
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
    await applyQualifiedMigrations(admin, (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort());
    await allowRawTestBindings(admin);
    await enableManualOwnerApprovalFixture(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'owner-grants@example.invalid',now()),($2,'owner-grants-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['codex', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
      ['release', userId, ['context:read', 'context:write']],
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
    const confirm = async (input, claims) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return issued;
    };
    const grant = (issued, claims, digest = issued.view_digest) =>
      native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: digest }, claims);

    const door = (who, input) => agent(who, 'clued_owner_grant_door_consume_v1', input);
    const bundle = (who, input) => agent(who, 'clued_owner_request_bundle_v1', input);
    const sha = 'a'.repeat(40);
    const commit = `repo:tdoljyj/cross-memory-system/${sha}`;
    const file = (name) => `${commit}/apps/clued-cloud/supabase/migrations/${name}`;
    const migrations = [file('20261004200000_a.sql'), file('20261004200001_b.sql')];

    // --- An Agent asks for the migration and the deploy of one commit in one call. ---
    const asked = committed(await bundle('claude', { idempotency_key: 'bundle-release-1', agent_note: 'release',
      actions: [{ action: 'migration.production', resources: migrations },
        { action: 'release.production', resources: [commit] }] }));
    const lead = asked.request;
    assert.equal(asked.replayed, false);
    assert.equal(lead.action, 'migration.production');
    assert.equal(lead.confirm_path, `/confirm/${lead.request_id}`);
    assert.deepEqual(lead.bundle.map((m) => [m.action, m.status]),
      [['migration.production', 'pending'], ['release.production', 'pending']]);
    assert.equal(lead.bundle[0].request_id, lead.request_id);
    const member = lead.bundle[1];
    assert.deepEqual(member.resources, [commit]);
    // Replay returns the same bundle; each member has its own Receipt.
    const replay = committed(await bundle('claude', { idempotency_key: 'bundle-release-1', agent_note: 'release',
      actions: [{ action: 'migration.production', resources: migrations },
        { action: 'release.production', resources: [commit] }] }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.request.request_id, lead.request_id);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_requests_v1 where bundle_id=$1`,
      [lead.request_id])).rows[0].n, 2);
    // A member's status read shows the whole bundle.
    const status = await agent('claude', 'clued_owner_request_status_v1', { request_id: member.request_id });
    assert.deepEqual(status.request.bundle.map((m) => m.request_id), lead.bundle.map((m) => m.request_id));
    // The Owner's view of either member lists the bundle.
    const viewed = await native('clued_owner_request_view_v1', { request_id: member.request_id });
    assert.equal(viewed.request.bundle.length, 2);

    // --- One click on the page: one two-step confirmation per member, each over its own view. ---
    for (const m of lead.bundle) {
      const issued = await confirm({ request_id: m.request_id, choice: 'once' });
      assert.equal(issued.confirmation_view.action, m.action);
      committed(await grant(issued));
    }
    const decided = await agent('claude', 'clued_owner_request_status_v1', { request_id: lead.request_id });
    assert.deepEqual(decided.request.bundle.map((m) => m.status), ['approved_once', 'approved_once']);
    // Each door consumes its own grant once, for its own action and resources.
    let result = await door('release', { action: 'migration.production', resources: migrations });
    assert.equal(result.consumed, true);
    result = await door('release', { action: 'release.production', resources: [commit] });
    assert.equal(result.consumed, true);
    assert.equal((await door('release', { action: 'release.production', resources: [commit] })).consumed, false);

    // --- The release door opens its own request with the others the run names. ---
    const sha2 = 'b'.repeat(40);
    const commit2 = `repo:tdoljyj/cross-memory-system/${sha2}`;
    const files2 = [`${commit2}/apps/clued-cloud/supabase/migrations/20261004200002_c.sql`];
    result = await door('release', { action: 'migration.production', resources: files2,
      with: [{ action: 'release.production', resources: [commit2] }] });
    assert.equal(result.consumed, false);
    const opened = result.owner_request;
    assert.deepEqual(opened.bundle.map((m) => [m.action, m.resources]),
      [['migration.production', files2], ['release.production', [commit2]]]);
    // Run again: the same requests are reused, still one bundle.
    const reopened = (await door('release', { action: 'migration.production', resources: files2,
      with: [{ action: 'release.production', resources: [commit2] }] })).owner_request;
    assert.deepEqual(reopened.bundle.map((m) => m.request_id), opened.bundle.map((m) => m.request_id));
    // Approving both from the page admits the migrate run and then the deploy run.
    for (const m of opened.bundle) committed(await grant(await confirm({ request_id: m.request_id, choice: 'once' })));
    assert.equal((await door('release', { action: 'migration.production', resources: files2,
      with: [{ action: 'release.production', resources: [commit2] }] })).consumed, true);
    assert.equal((await door('release', { action: 'release.production', resources: [commit2] })).consumed, true);

    // --- A `with` action a live grant already admits is not asked again. ---
    const sha3 = 'c'.repeat(40);
    const commit3 = `repo:tdoljyj/cross-memory-system/${sha3}`;
    const files3 = [`${commit3}/apps/clued-cloud/supabase/migrations/20261004200003_d.sql`];
    const deployOnly = committed(await agent('claude', 'clued_owner_request_v1',
      { action: 'release.production', resources: [commit3], idempotency_key: 'deploy-only-3' }));
    committed(await grant(await confirm({ request_id: deployOnly.request.request_id, choice: 'once' })));
    const single = (await door('release', { action: 'migration.production', resources: files3,
      with: [{ action: 'release.production', resources: [commit3] }] })).owner_request;
    assert.equal(single.bundle, null, 'nothing to bundle with');
    assert.equal(single.action, 'migration.production');

    // --- Refusals. ---
    const refused = (input, pattern) => assert.rejects(() => bundle('claude', input), pattern);
    await refused({ idempotency_key: 'bundle-bad-1', actions: [{ action: 'release.production', resources: [commit] }] },
      /owner_request_bundle_invalid/);
    await refused({ idempotency_key: 'bundle-bad-2', actions: [{ action: 'release.production', resources: [commit] },
      { action: 'release.production', resources: [commit2] }] }, /owner_request_bundle_invalid/);
    await refused({ idempotency_key: 'bundle-bad-3', actions: [{ action: 'release.production', resources: [commit] },
      { action: 'connection.permission', resources: ['permission:global/write'] }] }, /owner_request_bundle_invalid/);
    await refused({ idempotency_key: 'bundle-bad-4', action: 'release.production',
      actions: [{ action: 'release.production', resources: [commit] }, { action: 'migration.production', resources: migrations }] },
      /owner_request_bundle_invalid/);
    await refused({ idempotency_key: 'bundle-bad-5', actions: [{ action: 'release.production', resources: [commit] },
      { action: 'merge.main', resources: [commit] }] }, /owner_grant_action_unknown/);
    // A failing member rolls the whole call back.
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_requests_v1
      where idempotency_key like 'bundle-bad-%'`)).rows[0].n, 0);
    await assert.rejects(() => bundle('reader', { idempotency_key: 'bundle-reader', actions: [
      { action: 'release.production', resources: [commit] }, { action: 'migration.production', resources: migrations }] }),
      /binding_not_authorized/);
    await assert.rejects(() => door('release', { action: 'migration.production', resources: files2,
      with: [{ action: 'migration.production', resources: files2 }] }), /owner_grant_door_action_invalid/);
    await assert.rejects(() => door('release', { action: 'migration.production', resources: files2,
      with: [{ action: 'work_claim.extra_claims', resources: ['record:x'] }] }), /owner_grant_door_action_invalid/);
    await assert.rejects(() => door('release', { action: 'migration.production', resources: files2, with: [] }),
      /owner_grant_door_input_invalid/);
    await assert.rejects(() => anon.query('select clued_private.owner_request_bundle_join_v1($1,$2)',
      [userId, [lead.request_id]]), /permission denied/);
    await assert.rejects(() => human.query('select public.clued_owner_request_bundle_v1($1,$2)',
      [tokens.claude, { idempotency_key: 'bundle-human', actions: [] }]), /permission denied/);
    // Current-chain behavior above is qualified independently of the bounded
    // historical closeout replay performed before applying the successors.
    await assertGatewayCloseoutBoundary(admin);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
