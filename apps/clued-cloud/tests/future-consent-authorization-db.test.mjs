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
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { assertGatewayCloseoutBoundary, snapshotAuthorizationCallerBoundary, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDS = 'owned-project-records:future';
const CONTEXTS = 'owned-project-contexts:future';
const uuid = () => crypto.randomUUID();
const proof = () => crypto.randomBytes(32).toString('hex');
const sorted = values => [...values].sort();
const scope = (resource_id, actions) => ({ resource_kind: 'scope', resource_id, environment: 'canonical', actions });
const context = (resource_id, actions, environment = 'test') => ({ resource_kind: 'context', resource_id, environment, actions });
const claims = sub => ({ sub, role: 'authenticated', session_id: 'future-consent-db', aal: 'aal1',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] });
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('future-only owned consent policies: real full-chain PostgreSQL and concurrent Native boundaries', { timeout: 420000 }, async t => {
  const started = performance.now();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-future-consent-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: proof(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {},
    onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    async function connect(role = null, owner = null) {
      const db = server.getPgClient(); clients.push(db); await db.connect();
      await db.query("set statement_timeout='15s'; set lock_timeout='10s'");
      if (role) await db.query(`set role ${role}`);
      if (owner) await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [owner, JSON.stringify(claims(owner))]);
      return db;
    }
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
    const additions = names.filter(name => name.endsWith('_consent_future_owned_policies.sql'));
    assert.equal(additions.length, 1, 'one real CLI-created additive successor');
    for (const name of names) {
      const before = name === additions[0] ? await snapshotAuthorizationCallerBoundary(admin) : null;
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      if (before) assert.deepEqual(await snapshotAuthorizationCallerBoundary(admin), before,
        'every public RPC OID, owner, security configuration and ACL stays unchanged');
    }
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);
    await assertGatewayCloseoutBoundary(admin);
    t.diagnostic(`full migration chain ${names.length} files: ${Math.round(performance.now() - started)}ms`);
    const owner = uuid(), foreign = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'future-consent@example.invalid',now()),($2,'future-consent-other@example.invalid',now())`, [owner, foreign]);
    const human = await connect('authenticated', owner);
    const otherHuman = await connect('authenticated', foreign);
    const gateway = await connect();
    const issuer = proof(), resource = 'https://future-consent.example.invalid/mcp';
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
      values($1,$2,'Future consent fixture')`, [issuer, resource]);
    const native = async (name, input, db = human) => (await db.query(`select public.${name}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
    async function prepare(scopes = ['context:read', 'context:write', 'audit:read'], db = human, digest = proof()) {
      const request = { request_digest: digest, client_id: `future-${digest}`, client_name: 'Future consent fixture',
        redirect_uri: 'https://client.example.invalid/cb', resource, requested_scopes: scopes };
      return { ...(await db.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) value', [issuer, JSON.stringify(request)])).rows[0].value, input: request };
    }
    const reread = async (request, db = human) => ({ ...(await db.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) value',
      [issuer, JSON.stringify(request.input)])).rows[0].value, input: request.input });
    async function approve(request, selected, db = human, evidence = null) {
      const args = evidence || [issuer, request.request_id, request.version, JSON.stringify(selected), proof(), new Date(Date.now() + 3600000).toISOString()];
      const value = (await db.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value', args)).rows[0].value;
      return { ...value, token: args[4], args };
    }
    const authorize = async (selected, scopes, db = human) => approve(await prepare(scopes, db), selected, db);
    async function project(actor, name, db = admin) {
      const id = uuid(); await db.query('begin');
      try {
        await db.query('select clued_private.authorization_writer_guard_v2($1)', [actor]);
        await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
          values($1,$2,$3,$4,$5)`, [id, actor, name, name.toLowerCase(), `project:${id}`]);
        await db.query('commit'); return id;
      } catch (error) { await db.query('rollback'); throw error; }
    }
    const own = (input, db = human) => native('clued_development_owner_v14', { idempotency_key: uuid(), ...input }, db);
    const createContext = async (id, name, environment = 'test', db = human) => {
      const result = await own({ op: 'context_create', project_id: id, name, environment }, db);
      assert.equal(result.status, 'committed', JSON.stringify(result)); return result.result.id;
    };
    const entries = async binding => (await admin.query(`select resource_kind,resource_id,environment,actions
      from clued_private.authorization_entries_v12 where binding_id=$1 order by resource_kind,resource_id,environment`, [binding.binding_id])).rows;
    const entry = async (binding, kind, id, environment = 'canonical') => (await entries(binding))
      .find(row => row.resource_kind === kind && row.resource_id === id && row.environment === environment);
    const view = async binding => (await native('clued_authorization_manage_v12', { op: 'list' })).bindings.find(row => row.binding_id === binding.binding_id);
    const grant = async (binding, id) => (await admin.query('select * from clued_private.development_grants_v14 where binding_id=$1 and context_id=$2', [binding.binding_id, id])).rows[0];
    const development = (binding, input) => workerGatewayRpc(gateway, 'clued_development_call_v14', binding.token, { mode: 'development_history', ...input });
    const write = (binding, id) => development(binding, { op: 'record_put', context_id: id, record_type: 'note',
      body: { title: 'Future fixture', content: 'Future fixture' }, idempotency_key: uuid() });
    const denied = (promise, pattern = /scope|grant|permission|authorization|binding|denied|resource|qualification|selection|explicit|context/) =>
      assert.rejects(promise, error => ['42501', '28000', '22023', '40001'].includes(error.code) && pattern.test(error.message));
    async function reduce(binding, kind, actions, exceptions = []) {
      const current = await view(binding);
      const source = current.sources.find(row => row.kind === kind);
      return native('clued_authorization_manage_v12', { op: 'reduce', binding_id: binding.binding_id, base_version: current.version,
        selection_format: 'sources_v1', sources: source ? [{ source_id: source.source_id, base_version: source.version, action_cap: actions }] : [], exceptions });
    }
    const currentProject = await project(owner, 'Current owned project');
    const oldContext = await createContext(currentProject, 'Current omitted context');
    const foreignProject = await project(foreign, 'Foreign project');
    const foreignContext = await createContext(foreignProject, 'Foreign context', 'test', otherHuman);

    await t.test('both capability markers exist; actions are requested and type-specific; invalid scope selections fail', async () => {
      const request = await prepare();
      assert.deepEqual(sorted(request.eligible.find(row => row.resource_id === RECORDS).actions), ['audit', 'close', 'read', 'restore', 'write']);
      assert.deepEqual(sorted(request.eligible.find(row => row.resource_id === CONTEXTS).actions), ['close', 'feedback_submit', 'read', 'write']);
      assert.equal(request.eligible.find(row => row.resource_id === CONTEXTS).ownership, 'self');
      const audit = await prepare(['audit:read']);
      assert.deepEqual(audit.eligible.find(row => row.resource_id === CONTEXTS).actions, []);
      assert.deepEqual(audit.eligible.find(row => row.resource_id === RECORDS).actions, ['audit']);
      await denied(approve(audit, [scope(CONTEXTS, ['audit'])]));
      await denied(approve(request, [scope(CONTEXTS, ['restore'])]));
      await denied(approve(request, [scope(CONTEXTS, [])]));
      await denied(approve(request, [scope(CONTEXTS, ['read']), scope(CONTEXTS, ['write'])]));
      await denied(approve(await prepare(['context:read']), [scope(RECORDS, ['write'])]));
      await denied(approve(request, [scope(RECORDS, ['read'])], otherHuman));
    });

    await t.test('future-only gives no current resource access; records/context policies inherit independently', async () => {
      const records = await authorize([scope(RECORDS, ['read', 'write'])]);
      const contexts = await authorize([scope(CONTEXTS, ['read', 'write', 'feedback_submit'])]);
      assert.equal(await entry(records, 'scope', `project:${currentProject}`), undefined);
      assert.equal(await entry(contexts, 'context', oldContext, 'test'), undefined);
      await denied(write(contexts, oldContext));
      const newProject = await project(owner, 'New project after independent policy consent');
      const child = await createContext(newProject, 'New project child', 'preview');
      const oldParentChild = await createContext(currentProject, 'Existing parent new child', 'production');
      assert.deepEqual(sorted((await entry(records, 'scope', `project:${newProject}`)).actions), ['read', 'write']);
      assert.equal(await entry(records, 'context', child, 'preview'), undefined);
      assert.equal(await entry(contexts, 'scope', `project:${newProject}`), undefined);
      assert.equal((await write(contexts, child)).status, 'committed');
      assert.equal((await write(contexts, oldParentChild)).status, 'committed');
      await denied(write(records, child));
      for (const id of [RECORDS, CONTEXTS]) await assert.rejects(() => admin.query(
        'select clued_private.authorization_assert_entry_v12($1,$2,$3,$4,$5)', [id === RECORDS ? records.binding_id : contexts.binding_id, 'scope', id, 'canonical', 'read']), /resource_action_not_authorized/);
    });

    await t.test('asymmetric future defaults and exact current omission never backfill or silently change actions', async () => {
      const binding = await authorize([scope('profile', ['read']), scope(RECORDS, ['audit']), scope(CONTEXTS, ['read'])]);
      const p = await project(owner, 'Asymmetric future project');
      const c = await createContext(p, 'Asymmetric future context');
      assert.deepEqual((await entry(binding, 'scope', `project:${p}`)).actions, ['audit']);
      assert.deepEqual((await entry(binding, 'context', c, 'test')).actions, ['read']);
      await denied(write(binding, c));
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
        await admin.query('select clued_private.authorization_materialize_resource_v2($1,$2,$3,$4)', [binding.binding_id, 'context', oldContext, 'test']);
        await admin.query('select clued_private.authorization_rebuild_projection_v2($1)', [binding.binding_id]);
        await admin.query('commit');
      } catch (error) { await admin.query('rollback'); throw error; }
      assert.equal(await entry(binding, 'context', oldContext, 'test'), undefined, 'refresh cannot refill a cleared/re-added empty current Context');
    });

    await t.test('shared, invited, owner mismatch and ownership updates never become future-owned grants', async () => {
      const binding = await authorize([scope(CONTEXTS, ['read', 'write'])]);
      const invite = await native('clued_project_access_v13', { op: 'invite_create', project_id: foreignProject,
        target_email: 'future-consent@example.invalid', role: 'editor', environment: 'test', actions: ['read', 'write'],
        expires_at: new Date(Date.now() + 3600000).toISOString(), idempotency_key: uuid() }, otherHuman);
      assert.ok(invite.invite_token, JSON.stringify(invite));
      const inspect = await native('clued_project_access_v13', { op: 'invite_inspect', invite_token: invite.invite_token });
      await native('clued_project_access_v13', { op: 'invite_accept', invite_token: invite.invite_token,
        base_version: inspect.version, idempotency_key: uuid() });
      const eligible = await prepare();
      assert.ok(eligible.eligible.some(row => row.resource_id === foreignContext && row.ownership === 'membership'));
      const sharedChild = await createContext(foreignProject, 'New shared context', 'test', otherHuman);
      await denied(write(binding, sharedChild));
      assert.equal(await entry(binding, 'context', sharedChild, 'test'), undefined);
      await admin.query('update clued_private.development_spaces_v14 set owner_id=$1 where id=$2', [owner, sharedChild]);
      assert.equal(await entry(binding, 'context', sharedChild, 'test'), undefined, 'ownership UPDATE is not resource creation');
      await denied(write(binding, sharedChild));
    });

    await t.test('source-specific reduce/removal retains overlapping old policy and independent direct consent', async () => {
      const binding = await authorize([scope('profile', ['read']), scope('project:*', ['read']), scope(RECORDS, ['read', 'write']), scope(CONTEXTS, ['read', 'write'])]);
      const p = await project(owner, 'Overlapping source project');
      assert.deepEqual(sorted((await entry(binding, 'scope', `project:${p}`)).actions), ['read', 'write']);
      await reduce(binding, 'future_owned_project_policy', []);
      assert.deepEqual((await entry(binding, 'scope', `project:${p}`)).actions, ['read']);
      assert.deepEqual((await entry(binding, 'scope', 'profile')).actions, ['read']);
      await reduce(binding, 'future_owned_context_policy', ['read']);
      const c = await createContext(p, 'After independent context reduction');
      assert.deepEqual((await entry(binding, 'context', c, 'test')).actions, ['read']);
      await denied(write(binding, c));
      await reduce(binding, 'future_owned_context_policy', []);
      const later = await createContext(p, 'After context policy removal');
      assert.equal(await entry(binding, 'context', later, 'test'), undefined);
      const nextP = await project(owner, 'Old project policy remains');
      assert.deepEqual((await entry(binding, 'scope', `project:${nextP}`)).actions, ['read']);
    });

    await t.test('source/Binding expiry and revoke stop inheritance and runtime authority without read repair', async () => {
      const binding = await authorize([scope(CONTEXTS, ['read', 'write'])]);
      const c = await createContext(currentProject, 'Before source expiry');
      assert.equal((await write(binding, c)).status, 'committed');
      await admin.query("update clued_private.authorization_sources_v2 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [binding.binding_id]);
      await denied(write(binding, c));
      const afterExpiry = await createContext(currentProject, 'After source expiry');
      assert.equal(await entry(binding, 'context', afterExpiry, 'test'), undefined);
      const revoked = await authorize([scope(CONTEXTS, ['read', 'write'])]);
      await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: revoked.binding_id, base_version: (await view(revoked)).version });
      const afterRevoke = await createContext(currentProject, 'After Binding revoke');
      assert.equal(await entry(revoked, 'context', afterRevoke, 'test'), undefined);
      await denied(write(revoked, afterRevoke));
    });

    await t.test('exact field/history/version limits and resource revocation survive future creation and source rotation', async () => {
      const confirm = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Future policy rotation', days: 1,
        selected: [scope(CONTEXTS, ['read', 'write']), context(oldContext, ['read', 'write'])] });
      const issued = await native('clued_headless_binding_issue_v1', { confirmation_token: confirm.confirmation_token, view_digest: confirm.view_digest });
      const binding = { ...issued, token: crypto.createHash('sha256').update(issued.token).digest('hex') };
      const initial = await grant(binding, oldContext);
      await admin.query(`update clued_private.development_grants_v14 set history_policy='EXISTING_ONLY',version_policy='FIXED_AT_GRANT',
        allowed_fields=array['title'],freeze_cursor=0,expires_at=clock_timestamp()+interval '15 minutes' where id=$1`, [initial.id]);
      await reduce(binding, 'no-source', [], [{ resource_kind: 'context', resource_id: oldContext, environment: 'test', allowed_ceiling: ['read'] }]);
      const limited = await grant(binding, oldContext);
      const futureContext = await createContext(currentProject, 'Rotation future context');
      await own({ op: 'grant_revoke', context_id: futureContext, grant_id: (await grant(binding, futureContext)).id,
        base_version: (await grant(binding, futureContext)).version });
      const before = await view(binding);
      const rotation = await native('clued_headless_binding_confirmation_issue_v1', { label: 'Rotated future policies', days: 1, selected: [],
        replaces_binding_id: binding.binding_id, selection_format: 'sources_v1',
        sources: before.sources.map(s => ({ source_id: s.source_id, base_version: s.version, action_cap: s.actions })),
        exceptions: before.overrides.map(o => ({ override_id: o.override_id, base_version: o.version })) });
      const result = await native('clued_headless_binding_issue_v1', { confirmation_token: rotation.confirmation_token, view_digest: rotation.view_digest });
      const rotated = { ...result, token: crypto.createHash('sha256').update(result.token).digest('hex') };
      const after = await grant(rotated, oldContext);
      for (const field of ['actions', 'history_policy', 'version_policy', 'allowed_fields', 'freeze_cursor', 'since_cursor', 'explicit_record_ids']) assert.deepEqual(after[field], limited[field], field);
      assert.equal(after.expires_at.toISOString(), limited.expires_at.toISOString());
      await denied(write(rotated, oldContext));
      await denied(write(rotated, futureContext));
      await createContext(currentProject, 'After rotation refresh');
      await denied(write(rotated, futureContext));
      const later = await createContext(currentProject, 'New rotated future authority');
      assert.equal((await write(rotated, later)).status, 'committed');
      assert.ok((await view(rotated)).sources.some(s => s.kind === 'future_owned_context_policy'));
    });

    await t.test('pending reread refreshes snapshot/version; stale tree approval fails and exact replay remains idempotent', async () => {
      const old = await prepare();
      await createContext(currentProject, 'Topology change after page read');
      await assert.rejects(approve(old, [scope(CONTEXTS, ['read'])]), error => error.code === '40001' && error.message === 'authorization_request_resources_changed');
      const fresh = await reread(old);
      assert.equal(fresh.request_id, old.request_id); assert.equal(fresh.version, old.version + 1);
      await denied(approve(old, [scope(CONTEXTS, ['read'])]), /conflict/);
      const binding = await approve(fresh, [scope(CONTEXTS, ['read'])]);
      const replay = await approve(fresh, [scope(CONTEXTS, ['read'])], human, binding.args);
      assert.equal(replay.binding_id, binding.binding_id);
      await assert.rejects(reread(fresh), /authorization_request_closed/);
    });

    async function waitForMutex(waiting, holder) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = (await admin.query('select wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1', [waiting.processID])).rows[0];
        if (row?.wait_event_type === 'Lock' && row.blockers.includes(holder.processID)) { assert.equal(row.wait_event, 'advisory'); return; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('second real connection did not reach the Owner advisory mutex');
    }
    await t.test('two real clients: approval first commits before waiting creation and future-only policy sees only that insert', async () => {
      const first = await connect('authenticated', owner), second = await connect('authenticated', owner);
      const request = await prepare(); await first.query('begin'); let pending;
      try {
        const binding = await approve(request, [scope(CONTEXTS, ['read', 'write'])], first);
        pending = createContext(currentProject, 'Approval-first new Context', 'test', second).then(value => ({ value }), error => ({ error }));
        await waitForMutex(second, first); await first.query('commit');
        const result = await pending; if (result.error) throw result.error;
        assert.equal((await write(binding, result.value)).status, 'committed');
        assert.equal(await entry(binding, 'context', oldContext, 'test'), undefined);
      } finally { await first.query('rollback'); if (pending) await pending; }
    });

    await t.test('two real clients: creation first invalidates old tree snapshot; reread recovers without backfilling that Context', async () => {
      const first = await connect('authenticated', owner), second = await connect('authenticated', owner);
      const request = await prepare(); await first.query('begin'); let pending;
      try {
        const inserted = await createContext(currentProject, 'Creation-first committed Context', 'test', first);
        pending = approve(request, [scope(CONTEXTS, ['read', 'write'])], second).then(value => ({ value }), error => ({ error }));
        await waitForMutex(second, first); await first.query('commit');
        const rejected = await pending;
        assert.equal(rejected.error?.code, '40001'); assert.equal(rejected.error?.message, 'authorization_request_resources_changed');
        const fresh = await reread(request, second);
        assert.equal(fresh.version, request.version + 1);
        const binding = await approve(fresh, [scope(CONTEXTS, ['read', 'write'])], second);
        assert.equal(await entry(binding, 'context', inserted, 'test'), undefined);
        const later = await createContext(currentProject, 'Creation after recovered approval');
        assert.equal((await write(binding, later)).status, 'committed');
      } finally { await first.query('rollback'); if (pending) await pending; }
    });

    await t.test('legacy all-owned macro keeps live expansion; 100 explicit-entry bound remains visible and never truncates', async () => {
      const legacyRequest = await prepare();
      const between = await createContext(currentProject, 'Legacy creation-first compatibility');
      const legacy = await approve(legacyRequest, [scope('contexts:*', ['read', 'write'])]);
      assert.equal((await write(legacy, between)).status, 'committed');
      const request = await prepare();
      const tooMany = Array.from({ length: 101 }, () => scope('profile', ['read']));
      await assert.rejects(approve(request, tooMany), /explicit_nonempty_selection_required/);
      const largeProject = await project(owner, 'More than one hundred current resources');
      for (let index = 0; index < 101; index++) await createContext(largeProject, `Existing large set ${index}`);
      const all = await authorize([scope('contexts:*', ['read'])]);
      assert.equal((await entries(all)).filter(row => row.resource_kind === 'context').length,
        Number((await admin.query(`select count(*) n from clued_private.development_spaces_v14 c
          join public.clued_projects p on p.id=c.project_id where c.owner_id=$1 and p.user_id=$1`, [owner])).rows[0].n));
    });

    await t.test('private helpers and Native-only issuer/Owner gates remain closed', async () => {
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        for (const signature of ['clued_private.authorization_future_owned_policy_v1(text,text,text)',
          'clued_private.authorization_future_owned_insert_v1(uuid,text,text,text)']) assert.equal((await admin.query(
          "select has_function_privilege($1,$2,'execute') allowed", [role, signature])).rows[0].allowed, false);
      }
      const oauthHuman = await connect('authenticated', owner);
      await oauthHuman.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ ...claims(owner), client_id: 'external-client' })]);
      await denied(prepare(undefined, oauthHuman), /human|session/);
      await human.query('begin isolation level repeatable read');
      try { await denied(prepare(undefined, human), /read_committed/); }
      finally { await human.query('rollback'); }
      await assertGatewayCloseoutBoundary(admin);
    });
    t.diagnostic(`complete suite elapsed: ${Math.round(performance.now() - started)}ms`);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('clued-future-consent-'));
    await stopCluster(server);
    await removeTestDirectory(target);
  }
});
