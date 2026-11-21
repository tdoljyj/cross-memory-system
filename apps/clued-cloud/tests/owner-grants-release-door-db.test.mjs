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
// Re-review 7, MAJOR-3: the admission door's case runs with this file, which
// the authorization database job already lists.
import './owner-grants-admission-door-db.case.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Owner Credential v0.1 §6.1, the release door (migrations
// 20261003170000_owner_grants_release_door and, since 11-19,
// 20261119130000_release_door_db_identity_v1): the production release
// workflow consumes an Owner Grant by action and resources only (Owner
// choice), and when nothing admits it opens or reuses a pending request whose
// link the run prints. Since the install migration the workflow is identified
// by its database login, not by a Binding token: clued_private.release_door_v1
// is callable by that login only, the public door refuses the release actions,
// and the retired release-door Binding and its role row are revoked.

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

const INSTALL = '20261119130000_release_door_db_identity_v1.sql';
const REPOSITORY = 'tdoljyj/cross-memory-system';
const commit = (c) => `repo:${REPOSITORY}/${c.repeat(40)}`;
const migrationFile = (c, name = INSTALL) => `${commit(c)}/apps/clued-cloud/supabase/migrations/${name}`;
const PROTECTED_ROLES = ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'];

test('owner grants: the release door is the database login, consumes by action and commit and opens a request otherwise',
  { timeout: 300000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-grants-door-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    // Production's order: every migration before the install file, then the
    // state the install meets (the token-identified release door in use), then
    // the install file and anything after it.
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    await applyQualifiedMigrations(admin, names.filter((name) => name < INSTALL));
    await allowRawTestBindings(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'owner-grants@example.invalid',now()),($2,'owner-grants-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    const addBinding = async (name, user, scopes) => {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
    };
    const markRole = async (name, role) => {
      const receipt = (await admin.query(`insert into public.clued_audit_receipts
        (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,null,'global','binding_role_set','binding_role',$2,1,
          jsonb_build_object('receipt_kind','BINDING_ROLE_GRANTED','binding_id',$3::uuid,'role',$4::text)) returning id`,
      [userId, `${bindingIds[name]}:${role}`, bindingIds[name], role])).rows[0].id;
      return (await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
        values($1,$2,$3,now(),$4) returning id`, [userId, bindingIds[name], role, receipt])).rows[0].id;
    };
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['codex', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
      ['release', userId, ['context:write']], ['admission', userId, ['context:read']],
    ]) await addBinding(name, user, scopes);
    // Production on 11-19: the release environment's Binding (9f1788d9) is
    // the live release-door holder, and its only source has expired.
    const releaseRole = await markRole('release', 'release-door');
    const admissionRole = await markRole('admission', 'ci-admission');
    await admin.query(`update public.clued_agent_bindings set expires_at=now()-interval '1 hour' where id=$1`, [bindingIds.release]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller = server.getPgClient(); clients.push(workerCaller); await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const rpc = async (proof, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) v`, [proof, input])).rows[0].v
      : workerGatewayRpc(workerCaller, name, proof, input);
    const agent = (who, name, input) => rpc(tokens[who], name, input);
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
    const publicDoor = (who, input) => agent(who, 'clued_owner_grant_door_consume_v1', input);
    // The release workflow: its database login, no token.
    const releaseDoor = async (input) => (await admin.query('select clued_private.release_door_v1($1) v', [input])).rows[0].v;
    const counts = async () => (await admin.query(`select
      (select count(*)::int from clued_private.owner_requests_v1) requests,
      (select count(*)::int from clued_private.owner_grants_v1) grants,
      (select coalesce(sum(uses),0)::int from clued_private.owner_grants_v1) uses,
      (select count(*)::int from public.clued_audit_receipts) receipts`)).rows[0];

    // The old path is dead before the install: the expired token resolves to nothing.
    await assert.rejects(() => publicDoor('release', { action: 'release.production', resources: [commit('0')] }),
      /binding_not_authorized/);

    for (const name of names.filter((name) => name >= INSTALL)) {
      const sql = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
      try { await admin.query(sql); } catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const identity = async () => (await admin.query('select * from clued_private.release_identity_v1')).rows;

    await t.test('7. the install revokes the release-door Binding and its role row, and registers the identity', async () => {
      const rows = await identity();
      assert.equal(rows.length, 1, 'one registered release identity');
      assert.deepEqual([rows[0].user_id, rows[0].repository], [userId, REPOSITORY], 'the account of the release-door role, not a written-in id');
      const role = (await admin.query('select revoked_at,revoked_receipt_id from clued_private.binding_roles_v1 where id=$1',
        [releaseRole])).rows[0];
      assert.ok(role.revoked_at && role.revoked_receipt_id, 'the release-door role row is revoked');
      assert.ok((await admin.query('select revoked_at from public.clued_agent_bindings where id=$1', [bindingIds.release])).rows[0].revoked_at,
        'the release-door Binding is revoked');
      const installed = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [rows[0].receipt_id])).rows[0].metadata;
      assert.equal(installed.receipt_kind, 'RELEASE_DOOR_DB_IDENTITY_INSTALLED');
      assert.equal(role.revoked_receipt_id, rows[0].receipt_id, 'the role row ends under the install receipt');
      assert.deepEqual(installed.retired_bindings, [bindingIds.release]);
      assert.equal((await admin.query('select revoked_at from clued_private.binding_roles_v1 where id=$1', [admissionRole])).rows[0].revoked_at,
        null, 'other roles are untouched');
      await assert.rejects(() => admin.query(`select clued_private.release_door_install_v1('${REPOSITORY}')`), /release_door_already_installed/);
    });

    await t.test('1. incident: the release token is expired, the switch is on; the database login consumes a migration grant', async () => {
      const before = await counts();
      const result = await releaseDoor({ action: 'migration.production', resources: [migrationFile('a')],
        with: [{ action: 'release.production', resources: [commit('a')] }], run_id: '44450023079', run_attempt: '1' });
      assert.deepEqual([result.status, result.consumed, result.auto_approved], ['ok', true, true], JSON.stringify(result));
      const used = (await admin.query('select binding_id,metadata from public.clued_audit_receipts where id=$1',
        [result.grant.receipt_id])).rows[0];
      assert.deepEqual([used.metadata.receipt_kind, used.metadata.door, used.metadata.action],
        ['OWNER_GRANT_USED', 'release-workflow', 'migration.production']);
      assert.deepEqual(used.metadata.caller, { run_id: '44450023079', run_attempt: '1', verified: false },
        'the run is the caller\'s own claim, marked unverified');
      assert.equal(used.metadata.identity, 'database_login');
      const [row] = await identity();
      assert.equal(used.binding_id, row.anchor_binding_id, 'no connection token: the receipt names the identity\'s own anchor');
      assert.notEqual(used.binding_id, bindingIds.release);
      assert.equal((await counts()).uses, before.uses + 1, 'one use');
      // The expired token stays dead, now with the retired-door answer for the release actions.
      await assert.rejects(() => publicDoor('release', { action: 'release.production', resources: [commit('a')] }),
        /owner_grant_door_release_token_retired/);
    });

    await t.test('1b. a banned or deleted account: the door refuses, approves nothing and consumes nothing', async () => {
      // The switch is still on here, so without the account check the door would approve and consume.
      const input = { action: 'migration.production', resources: [migrationFile('9')],
        with: [{ action: 'release.production', resources: [commit('9')] }] };
      const before = await counts();
      for (const [column, value] of [['banned_until', "now()+interval '1 day'"], ['deleted_at', 'now()']]) {
        await admin.query(`update auth.users set ${column}=${value} where id=$1`, [userId]);
        try {
          for (const call of [{ probe: true }, input, { ...input, request_only: true }]) {
            await assert.rejects(() => releaseDoor(call), /account_not_available/, `${column}: ${JSON.stringify(call)}`);
          }
        } finally {
          await admin.query(`update auth.users set ${column}=null where id=$1`, [userId]);
        }
      }
      assert.deepEqual(await counts(), before, 'no request, approval, grant use or receipt');
      assert.equal((await releaseDoor({ probe: true })).status, 'ok', 'the account back, the door is back');
    });

    // From here on the Owner confirms each request by hand.
    await enableManualOwnerApprovalFixture(admin);

    await t.test('2. only the database login reaches the door', async () => {
      for (const role of PROTECTED_ROLES) {
        for (const signature of ['clued_private.release_door_v1(jsonb)', 'clued_private.release_door_install_v1(text)']) {
          assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed,
            false, `${role} cannot execute ${signature}`);
        }
        assert.equal((await admin.query("select has_table_privilege($1,'clued_private.release_identity_v1','SELECT') allowed",
          [role])).rows[0].allowed, false, `${role} cannot read the identity row`);
      }
      await assert.rejects(() => anon.query('select clued_private.release_door_v1($1)', [{ probe: true }]), /permission denied/);
      await assert.rejects(() => human.query('select clued_private.release_door_v1($1)', [{ probe: true }]), /permission denied/);
      await assert.rejects(() => workerCaller.query('select clued_private.release_door_v1($1)', [{ probe: true }]), /permission denied/);
      const service = server.getPgClient(); clients.push(service); await service.connect();
      await service.query('set role service_role');
      await assert.rejects(() => service.query('select clued_private.release_door_v1($1)', [{ probe: true }]), /permission denied/);
    });

    await t.test('3. the anchor Binding resolves through no token path', async () => {
      const [row] = await identity();
      const anchor = (await admin.query('select * from public.clued_agent_bindings where id=$1', [row.anchor_binding_id])).rows[0];
      assert.equal(anchor.agent_name, 'clued-release-workflow');
      assert.equal(anchor.user_id, userId);
      assert.ok(anchor.revoked_at, 'revoked when created');
      assert.match(anchor.token_hash, /^cv1:[0-9a-f]{64}$/);
      for (const proof of [anchor.token_hash, anchor.token_hash.slice(4)]) {
        await assert.rejects(() => rpc(proof, 'clued_owner_grant_door_consume_v1',
          { action: 'ci.resident_upgrade', resources: [`ci-resident:node-a/${'e'.repeat(64)}`], op_id: uuid() }),
        /binding_not_authorized|invalid_binding_or_context/);
        await assert.rejects(() => rpc(proof, 'clued_owner_request_v1',
          { action: 'release.production', resources: [commit('3')], idempotency_key: `anchor-${uuid()}` }),
        /binding_not_authorized|invalid_binding_or_context/);
        await assert.rejects(() => rpc(proof, 'clued_work_claims_active_v1', { scope: 'global' }),
          /binding_not_authorized|invalid_binding_or_context/);
      }
    });

    await t.test('4. the public door refuses the release actions to a valid release-door token; resident upgrades unchanged', async () => {
      await addBinding('release2', userId, ['context:read', 'context:write']);
      await markRole('release2', 'release-door');
      const before = await counts();
      for (const action of ['release.production', 'migration.production']) {
        await assert.rejects(() => publicDoor('release2', { action, resources: [commit('4')] }),
          (error) => error.code === '42501' && /owner_grant_door_release_token_retired/.test(error.message));
      }
      assert.deepEqual(await counts(), before, 'no request, grant use or receipt');
      await assert.rejects(() => publicDoor('release2', { action: 'repo.protected_change', resources: [commit('4')] }),
        /owner_grant_door_action_invalid/);
      await addBinding('node-a', userId, ['context:read']);
      await markRole('node-a', 'resident-upgrade');
      const upgrade = await publicDoor('node-a', { action: 'ci.resident_upgrade',
        resources: [`ci-resident:node-a/${'e'.repeat(64)}`], op_id: uuid() });
      assert.deepEqual([upgrade.status, upgrade.action], ['ok', 'ci.resident_upgrade'], JSON.stringify(upgrade));
      await assert.rejects(() => publicDoor('release2', { action: 'ci.resident_upgrade',
        resources: [`ci-resident:node-a/${'e'.repeat(64)}`], op_id: uuid() }), /owner_grant_door_binding_not_authorized/);
    });

    await t.test('5. resources outside the registered repository, short commits and other paths are refused', async () => {
      const before = await counts();
      const sha = 'b'.repeat(40);
      for (const [action, resources] of [
        ['release.production', [`repo:someone/else/${sha}`]],
        ['release.production', [`repo:${REPOSITORY}x/${sha}`]],
        ['release.production', [`repo:${REPOSITORY}/4f49b0e8aaaa`]],
        ['release.production', [`repo:${REPOSITORY}/${'B'.repeat(40)}`]],
        ['release.production', [`repo:${REPOSITORY}/**`]],
        ['release.production', [migrationFile('b')]],
        ['release.production', [commit('b'), `repo:someone/else/${sha}`]],
        ['migration.production', [commit('b')]],
        ['migration.production', [`${commit('b')}/apps/clued-cloud/supabase/other/${INSTALL}`]],
        ['migration.production', [`${commit('b')}/supabase/migrations/${INSTALL}`]],
        ['migration.production', [`${commit('b')}/apps/clued-cloud/supabase/migrations/../migrations/${INSTALL}`]],
        ['migration.production', [`${commit('b')}/apps/clued-cloud/supabase/migrations/x.sql`]],
        ['migration.production', [`repo:someone/else/${sha}/apps/clued-cloud/supabase/migrations/${INSTALL}`]],
      ]) {
        await assert.rejects(() => releaseDoor({ action, resources }), /release_door_resources_invalid/, JSON.stringify(resources));
      }
      await assert.rejects(() => releaseDoor({ action: 'migration.production', resources: [migrationFile('b')],
        with: [{ action: 'release.production', resources: [`repo:someone/else/${sha}`] }] }), /release_door_resources_invalid/);
      for (const action of ['repo.protected_change', 'ci.resident_upgrade', 'work_claim.extra_claims', 'merge.main']) {
        await assert.rejects(() => releaseDoor({ action, resources: [commit('b')] }), /release_door_action_invalid/, action);
      }
      for (const input of [{ action: 'release.production', resources: [commit('b')], task_id: uuid() },
        { probe: 'yes' }, { probe: true, action: 'release.production', resources: [commit('b')] },
        { action: 'release.production', resources: [commit('b')], request_only: 1 },
        { action: 'release.production', resources: [commit('b')], run_id: 'abc' },
        { action: 'release.production', resources: [commit('b')], run_attempt: 2 },
        { action: 'release.production', resources: [] }, 5, null]) {
        await assert.rejects(() => releaseDoor(input), /release_door_input_invalid|release_door_resources_invalid/, JSON.stringify(input));
      }
      assert.deepEqual(await counts(), before, 'a refused call writes nothing');
    });

    await t.test('6. switch off: a pending request, request_only reuses it, probe writes nothing', async () => {
      let before = await counts();
      const probe = await releaseDoor({ probe: true, run_id: '1', run_attempt: '1' });
      assert.deepEqual([probe.status, probe.probe, probe.door, probe.repository], ['ok', true, 'release-workflow', REPOSITORY]);
      assert.deepEqual(await counts(), before, 'probe writes no row');
      const input = { action: 'migration.production', resources: [migrationFile('c')],
        with: [{ action: 'release.production', resources: [commit('c')] }] };
      const opened = await releaseDoor(input);
      assert.equal(opened.consumed, false);
      const pending = opened.owner_request;
      assert.deepEqual([pending.status, pending.action, pending.resources], ['pending', 'migration.production', [migrationFile('c')]]);
      assert.deepEqual(pending.bundle.map((m) => m.action), ['migration.production', 'release.production'], 'one bundle with the deploy');
      before = await counts();
      for (let i = 0; i < 2; i += 1) {
        const again = await releaseDoor({ ...input, request_only: true, run_id: '77', run_attempt: String(i + 1) });
        assert.deepEqual([again.status, again.consumed, again.owner_request.request_id], ['ok', false, pending.request_id]);
      }
      assert.deepEqual(await counts(), before, 'request_only reuses the request and the bundle');
      // In a transaction that lost the identity the probe fails, so that transaction cannot commit.
      await admin.query('begin');
      try {
        await admin.query('delete from clued_private.release_identity_v1');
        await assert.rejects(() => releaseDoor({ probe: true }), /release_door_identity_missing/);
      } finally { await admin.query('rollback'); }
      assert.equal((await identity()).length, 1);
      // The Owner approves the bundle's migration once: request_only sees the grant and uses nothing.
      committed(await grant(await confirm({ request_id: pending.request_id, choice: 'once' })));
      before = await counts();
      const admitted = await releaseDoor({ ...input, request_only: true });
      assert.deepEqual([admitted.consumed, admitted.admitted], [false, true]);
      assert.deepEqual(await counts(), before);
      assert.equal((await releaseDoor(input)).consumed, true);
    });

    await t.test('the door matches by action and resources only, any requester, never another account', async () => {
      const commitA = commit('d');
      const commitB = commit('e');
      // --- Claude asks, the Owner grants to Claude; the release workflow consumes it. ---
      const asked = committed(await agent('claude', 'clued_owner_request_v1',
        { action: 'release.production', resources: [commitA], idempotency_key: 'door-release-a' }));
      const given = committed(await grant(await confirm({ request_id: asked.request.request_id })));
      assert.equal(given.grant.any_agent, false, 'granted to the requesting Agent only');
      let result = await releaseDoor({ action: 'release.production', resources: [commitA] });
      assert.deepEqual([result.status, result.consumed, result.grant.grant_id], ['ok', true, given.grant.grant_id]);
      const used = (await admin.query('select metadata from public.clued_audit_receipts where id=$1',
        [result.grant.receipt_id])).rows[0].metadata;
      assert.deepEqual([used.receipt_kind, used.door, used.action], ['OWNER_GRANT_USED', 'release-workflow', 'release.production']);
      // The same grant does not cover another action.
      result = await releaseDoor({ action: 'migration.production', resources: [migrationFile('d')] });
      assert.equal(result.consumed, false);

      // --- No grant: the door opens one pending request and reuses it. ---
      result = await releaseDoor({ action: 'release.production', resources: [commitB] });
      assert.equal(result.consumed, false);
      const pending = result.owner_request;
      assert.deepEqual([pending.status, pending.action, pending.resources, pending.confirm_path],
        ['pending', 'release.production', [commitB], `/confirm/${pending.request_id}`]);
      const again = await releaseDoor({ action: 'release.production', resources: [commitB] });
      assert.equal(again.owner_request.request_id, pending.request_id, 'one request per action and resources');
      // The Owner approves that request once: one run goes through, the next does not.
      committed(await grant(await confirm({ request_id: pending.request_id, choice: 'once' })));
      result = await releaseDoor({ action: 'release.production', resources: [commitB] });
      assert.equal(result.consumed, true);
      result = await releaseDoor({ action: 'release.production', resources: [commitB] });
      assert.equal(result.consumed, false);
      assert.notEqual(result.owner_request.request_id, pending.request_id, 'a decided request is not reused');

      // --- A grant for the repository glob covers any commit; a revoked grant covers nothing. ---
      const wide = committed(await grant(await confirm({ action: 'migration.production',
        resources: [`repo:${REPOSITORY}/**`] })));
      result = await releaseDoor({ action: 'migration.production', resources: [migrationFile('e')] });
      assert.deepEqual([result.consumed, result.grant.grant_id], [true, wide.grant.grant_id]);
      committed(await native('clued_owner_grant_revoke_v1', { grant_id: wide.grant.grant_id }));
      assert.equal((await releaseDoor({ action: 'migration.production', resources: [migrationFile('e')] })).consumed, false);

      // --- Another account's grant never admits. ---
      const strangerAsked = committed(await agent('stranger', 'clued_owner_request_v1',
        { action: 'release.production', resources: [commit('f')], idempotency_key: 'door-release-stranger' }));
      committed(await grant(await confirm({ request_id: strangerAsked.request.request_id }, session(otherUser)), session(otherUser)));
      assert.equal((await releaseDoor({ action: 'release.production', resources: [commit('f')] })).consumed, false);

      await assert.rejects(() => anon.query('select clued_private.owner_grant_consume_door_v1($1,$2,$3,$4)',
        [userId, bindingIds.claude, 'release.production', [commitA]]), /permission denied/);
      await assert.rejects(() => human.query('select public.clued_owner_grant_door_consume_v1($1,$2)',
        [tokens.claude, { action: 'release.production', resources: [commitA] }]), /permission denied/);
      // Current-chain behavior above is qualified independently of the bounded
      // historical closeout replay performed before applying the successors.
      await assertGatewayCloseoutBoundary(admin);
      assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
