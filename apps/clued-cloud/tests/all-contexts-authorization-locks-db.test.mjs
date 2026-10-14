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
import { assertGatewayCloseoutBoundary, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const proof = () => crypto.randomBytes(32).toString('hex');
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const macro = (actions) => [{ resource_kind: 'scope', resource_id: 'contexts:*', environment: 'canonical', actions }];
const claims = (sub) => ({ sub, role: 'authenticated', session_id: 'locks-db-native', aal: 'aal1',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] });
async function port() {
  const listener = net.createServer(); await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port; await new Promise((resolve) => listener.close(resolve)); return value;
}

test('all-contexts real early writer barriers and preserved caller catalog', { timeout: 420000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-all-contexts-locks-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: proof(), port: await port(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
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
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) {
      const sql = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
      if (name.includes('all_contexts')) t.diagnostic(JSON.stringify({ migration: name, sha256: crypto.createHash('sha256').update(sql).digest('hex') }));
      try { await admin.query(sql); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin); await allowTestIssuerCredentials(admin);
    const owner = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'locks@example.invalid',now())", [owner]);
    const first = await connect('authenticated', owner);
    const second = await connect('authenticated', owner);
    const gateway = await connect(); await setWorkerGatewayCaller(gateway);
    const resource = 'https://locks.example.invalid/mcp'; const issuer = proof();
    await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Lock fixture')", [issuer, resource]);
    const native = async (db, name, input) => (await db.query(`select public.${name}($1::jsonb) v`, [JSON.stringify(input)])).rows[0].v;
    const own = (db, input) => native(db, 'clued_development_owner_v14', { idempotency_key: uuid(), ...input });
    const project = uuid();
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'Locks','locks',$3)", [project, owner, `project:${project}`]);
    const create = async (db, name) => {
      const result = await own(db, { op: 'context_create', project_id: project, name, environment: 'test' });
      assert.equal(result.status, 'committed'); return result.result.id;
    };
    const cid = await create(first, 'First lock context');
    const prepare = async () => (await first.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) v', [issuer, JSON.stringify({
      request_digest: proof(), client_id: uuid(), client_name: 'Locks', redirect_uri: 'https://client.invalid/cb', resource,
      requested_scopes: ['context:read', 'context:write', 'audit:read'],
    })])).rows[0].v;
    const approve = async (db, request, selected = macro(['read', 'write'])) => {
      const token = proof();
      const result = (await db.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) v',
        [issuer, request.request_id, request.version, JSON.stringify(selected), token, expiry()])).rows[0].v;
      return { ...result, token };
    };
    const grant = async (binding, contextId = cid) => (await admin.query('select * from clued_private.development_grants_v14 where binding_id=$1 and context_id=$2', [binding.binding_id, contextId])).rows[0];
    const view = async (binding) => (await native(first, 'clued_authorization_manage_v12', { op: 'list' })).bindings
      .find((row) => row.binding_id === binding.binding_id);
    async function permissionToken(binding, role = 'full') {
      const requested = await workerGatewayRpc(gateway, 'clued_owner_request_v1', binding.token, {
        action: 'connection.permission', resources: [`permission:contexts:*/${role}`], idempotency_key: uuid(),
      });
      assert.equal(requested.status, 'committed');
      const token = await native(first, 'clued_owner_grant_confirmation_issue_v1', { request_id: requested.request.request_id, choice: 'once' });
      assert.equal(token.status, 'issued', JSON.stringify(token)); return token;
    }
    const finishPermission = (db, token) => native(db, 'clued_owner_grant_v1', {
      confirmation_token: token.confirmation_token, view_digest: token.view_digest,
    });
    async function headless(label) {
      const token = await native(first, 'clued_headless_binding_confirmation_issue_v1', {
        label, days: 1, selected: macro(['read', 'write']),
      });
      assert.equal(token.status, 'issued', JSON.stringify(token));
      const result = await native(first, 'clued_headless_binding_issue_v1', {
        confirmation_token: token.confirmation_token, view_digest: token.view_digest,
      });
      assert.equal(result.status, 'committed', JSON.stringify(result)); return result;
    }
    const upsert = async (db, binding) => {
      const old = await grant(binding);
      return own(db, { op: 'grant_upsert', context_id: cid, binding_id: binding.binding_id, grant_id: old.id,
        base_version: Number(old.version), actions: old.actions, history_policy: old.history_policy, version_policy: old.version_policy,
        allowed_fields: old.allowed_fields, expires_at: old.expires_at });
    };
    const base = await approve(first, await prepare());

    // Query the wait graph, not elapsed sleep, before releasing the held writer.
    async function barrier(held, holdAction, waiting, waitAction, waitKind = 'mutex') {
      const pid = Number((await waiting.query('select pg_backend_pid() pid')).rows[0].pid);
      await held.query('begin'); await waiting.query('begin');
      let pending;
      try {
        const heldResult = await holdAction();
        pending = waitAction().then((value) => ({ value }), (error) => ({ error }));
        let observed = false;
        for (let n = 0; n < 100; n += 1) {
          observed = (await admin.query(`select exists(select 1 from pg_locks where pid=$1 and not granted
            and (($2='mutex' and locktype='advisory' and mode='ExclusiveLock')
              or ($2='binding' and locktype in ('transactionid','tuple')))) waiting`, [pid, waitKind])).rows[0].waiting;
          if (observed) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(observed, true, `second real RPC waits at the required ${waitKind} barrier`);
        const late = (await admin.query(`select relation::regclass::text relation,mode from pg_locks where pid=$1
          and relation in ('public.clued_agent_bindings'::regclass,'clued_private.authorizations_v12'::regclass,
            'clued_private.development_spaces_v14'::regclass,'public.clued_projects'::regclass)
          and mode in ('RowShareLock','RowExclusiveLock')`, [pid])).rows;
        if (waitKind === 'mutex') {
          assert.deepEqual(late, [], 'waiter has no late Binding/Authorization/Context/Project row-lock relation');
        } else {
          assert.ok(late.length > 0 && late.every((lock) => lock.relation === 'clued_agent_bindings'), 'writer waits at B before Authorization/Context/Project');
          const grantLock = (await admin.query(`select exists(select 1 from pg_locks where pid=$1 and locktype='advisory'
            and granted and objsubid=1 and ((classid::bigint<<32)|objid::bigint)=hashtext('owner-grant:'||$2)::bigint) held`, [pid, owner])).rows[0].held;
          assert.equal(grantLock, false, 'Native writer has not acquired owner_grant_lock before B');
        }
        await held.query('commit');
        const answer = await pending;
        if (answer.error) throw answer.error;
        await waiting.query('commit');
        return { held: heldResult, waited: answer.value };
      } catch (error) {
        await held.query('rollback').catch(() => {}); await waiting.query('rollback').catch(() => {});
        if (pending) await pending;
        throw error;
      }
    }

    await t.test('real catalog preserves gateway 80 / anon CI8 and private guards are unexposed', async () => {
      await assertGatewayCloseoutBoundary(admin);
      const rows = (await admin.query(`select p.oid::regprocedure::text signature from pg_proc p where
        p.pronamespace='clued_private'::regnamespace and p.proname like 'authorization_writer%v2'
        and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')
          or has_function_privilege('clued_worker_gateway',p.oid,'execute'))`)).rows;
      assert.deepEqual(rows, []);
      assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
      const catalog = (await admin.query(`select p.oid::regprocedure::text signature,p.proacl::text acl,
        encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') source_hash
        from pg_proc p where p.oid=any(array[
          'public.clued_development_owner_v14(jsonb)'::regprocedure::oid,
          'clued_private.development_execute_before_authorization_v14(uuid,uuid,boolean,jsonb)'::regprocedure::oid,
          'clued_private.ii_pub_clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)'::regprocedure::oid,
          'public.clued_authorization_manage_v12(jsonb)'::regprocedure::oid,
          'public.clued_owner_request_v1(text,jsonb)'::regprocedure::oid,
          'public.clued_owner_grant_v1(jsonb)'::regprocedure::oid,
          'public.clued_headless_binding_issue_v1(jsonb)'::regprocedure::oid,
          'public.clued_project_mutate_v2(text,jsonb)'::regprocedure::oid,
          'clued_private.binding_expiry_sweep_v1()'::regprocedure::oid,
          'clued_private.development_execute_v14(uuid,uuid,boolean,jsonb)'::regprocedure::oid]) order by 1`)).rows;
      t.diagnostic(JSON.stringify({ actual_function_catalog: catalog }));
    });
    await t.test('macro approval versus Native grant_upsert, both orderings', async () => {
      const one = await prepare();
      const a = await barrier(first, () => approve(first, one), second, () => upsert(second, base));
      assert.equal(a.waited.status, 'committed');
      const two = await prepare();
      const b = await barrier(first, () => upsert(first, base), second, () => approve(second, two));
      assert.equal(b.held.status, 'committed'); assert.ok(await grant(b.waited));
    });
    await t.test('approval/create scan race in both orderings has complete exact grants', async () => {
      const one = await prepare();
      const a = await barrier(first, () => create(first, 'Created before approval commit'), second, () => approve(second, one));
      assert.ok(await grant(a.waited, a.held), 'approval sees the resource committed while it waited');
      const two = await prepare();
      const b = await barrier(first, () => approve(first, two), second, () => create(second, 'Created after approval commit'));
      assert.ok(await grant(b.held, b.waited), 'creation sees the policy committed while it waited');
    });
    await t.test('real MCP creator with highest Binding UUID and old/new policies uses one sorted Project/Context fan-out', async () => {
      const legacy = await approve(first, await prepare(), [{ resource_kind: 'scope', resource_id: 'project:*', environment: 'canonical', actions: ['read', 'write'] }]);
      const creator = { binding_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', token: proof() };
      await admin.query(`insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,$2,'synthetic','Actual raw creator',$3,array['context:read','context:write'],array['*'])`, [creator.binding_id, owner, creator.token]);
      const newPid = uuid();
      const input = { operation: 'create', canonical_project_id: newPid, project_schema_version: 2, base_version: null,
        idempotency_key: uuid(), mutation: { name: 'Joint policy fanout', progress_status: 'not_started', aliases: [] },
        recognition: { confidence: 1, reason: 'Synthetic actual creator lock qualification', source: 'v2_agent_recognition', source_refs: [] } };
      const result = await barrier(gateway, () => workerGatewayRpc(gateway, 'clued_project_mutate_v2', creator.token, input), second,
        async () => {
          const created = await own(second, { op: 'context_create', project_id: newPid, name: 'Joint policy Context', environment: 'preview' });
          assert.equal(created.status, 'committed'); return created.result.id;
        });
      assert.equal(result.held.status, 'committed', JSON.stringify(result.held));
      assert.equal(result.held.supplemental.project.id, newPid);
      for (const subject of [legacy, base]) {
        assert.ok((await admin.query(`select 1 from clued_private.authorization_entries_v12 where binding_id=$1
          and resource_kind='scope' and resource_id=$2 and 'read'=any(actions)`, [subject.binding_id, `project:${newPid}`])).rowCount);
      }
      assert.equal(await grant(legacy, result.waited), undefined, 'old project policy does not acquire Context meaning');
      assert.ok(await grant(base, result.waited), 'new contexts policy acquires the future precise Context');
    });
    await t.test('Native permission approval waits before Binding/GrantLock while an actual request producer holds them', async () => {
      const narrow = await approve(first, await prepare(), macro(['read']));
      const token = await permissionToken(narrow);
      const result = await barrier(gateway, () => workerGatewayRpc(gateway, 'clued_owner_request_v1', base.token, {
        action: 'release.production', resources: [`repo:tdoljyj/cross-memory-system/${proof().slice(0,40)}`], idempotency_key: uuid(),
      }), second, () => finishPermission(second, token));
      assert.equal(result.held.status, 'committed'); assert.equal(result.waited.status, 'committed', JSON.stringify(result.waited));
    });
    for (const [name, action] of [['clued_owner_grant_door_consume_v1', 'release.production'],
      ['clued_owner_grant_admission_door_v1', 'repo.protected_change']]) {
      await t.test(`actual ${name} B SHARE -> GrantLock consumption versus Native permission writer has no inverse lock`, async () => {
        const subject = await approve(first, await prepare());
        if (name === 'clued_owner_grant_admission_door_v1') {
          const roleToken = await native(first, 'clued_binding_role_confirmation_issue_v1', {
            binding_id: subject.binding_id, role: 'ci-admission', enabled: true,
          });
          assert.equal(roleToken.status, 'issued', JSON.stringify(roleToken));
          const roleSet = await native(first, 'clued_binding_role_set_v1', {
            confirmation_token: roleToken.confirmation_token, view_digest: roleToken.view_digest,
          });
          assert.equal(roleSet.status, 'committed', JSON.stringify(roleSet));
        }
        const token = await permissionToken(subject);
        const door = await connect('anon');
        const resourceId = `repo:tdoljyj/cross-memory-system/${proof().slice(0,40)}`;
        const result = await barrier(door,
          async () => (await door.query(`select public.${name}($1,$2::jsonb) v`, [subject.token, JSON.stringify({ action, resources: [resourceId] })])).rows[0].v,
          second, () => finishPermission(second, token), 'binding');
        assert.equal(result.held.status, 'ok'); assert.equal(result.waited.status, 'committed', JSON.stringify(result.waited));
      });
    }
    await t.test('headless rotation versus context creation preserves the source snapshot and grants the new Binding', async () => {
      const issued = await headless('Lock rotation original');
      const originalView = await view(issued);
      const rotate = await native(first, 'clued_headless_binding_confirmation_issue_v1', {
        label: 'Lock rotation successor', days: 1, selected: [], replaces_binding_id: issued.binding_id, selection_format: 'sources_v1',
        sources: originalView.sources.map((source) => ({ source_id: source.source_id, base_version: Number(source.version), action_cap: source.actions })),
        exceptions: originalView.overrides.map((override) => ({ override_id: override.override_id, base_version: Number(override.version) })),
      });
      assert.equal(rotate.status, 'issued', JSON.stringify(rotate));
      const result = await barrier(first, () => native(first, 'clued_headless_binding_issue_v1', {
        confirmation_token: rotate.confirmation_token, view_digest: rotate.view_digest,
      }), second, () => create(second, 'Created after rotation'));
      assert.equal(result.held.status, 'committed', JSON.stringify(result.held));
      assert.ok(await grant(result.held, result.waited));
      assert.ok((await view(result.held)).sources.some((row) => row.kind === 'contexts_policy'));
    });
    await t.test('revoke/create and expiry/create never re-grant a ended Binding', async () => {
      const ended = await approve(first, await prepare());
      const oldView = await view(ended);
      const result = await barrier(first, () => native(first, 'clued_authorization_manage_v12', {
        op: 'revoke', binding_id: ended.binding_id, base_version: Number(oldView.version),
      }), second, () => create(second, 'After revoke'));
      assert.equal(await grant(ended, result.waited), undefined);
      const expires = await headless('Expiry original');
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 minute' where binding_id=$1", [expires.binding_id]);
      const sweep = await barrier(admin, () => admin.query('select clued_private.binding_expiry_sweep_v1()'), second,
        () => create(second, 'After expiry sweep'));
      assert.equal(await grant(expires, sweep.waited), undefined);
      assert.ok((await admin.query('select revoked_at from public.clued_agent_bindings where id=$1', [expires.binding_id])).rows[0].revoked_at);
    });
    await t.test('Native exact grant revoke and source reduction serialize; future creation retains the precise deny', async () => {
      const subject = await approve(first, await prepare());
      const original = await grant(subject);
      const prior = await view(subject);
      const reduction = { op: 'reduce', binding_id: subject.binding_id, base_version: Number(prior.version), selection_format: 'sources_v1',
        sources: prior.sources.map((source) => ({ source_id: source.source_id, base_version: Number(source.version),
          action_cap: source.actions.includes('read') ? ['read'] : [] })), exceptions: [] };
      const result = await barrier(first, () => own(first, { op: 'grant_revoke', context_id: cid,
        grant_id: original.id, base_version: Number(original.version) }), second,
      () => native(second, 'clued_authorization_manage_v12', reduction));
      assert.equal(result.held.status, 'committed');
      assert.ok(result.waited.version);
      await create(first, 'After precise revoke and source reduction');
      const deny = (await admin.query(`select denied_actions from clued_private.authorization_resource_overrides_v2
        where binding_id=$1 and resource_kind='context' and resource_id=$2`, [subject.binding_id, cid])).rows[0];
      assert.ok(deny.denied_actions.includes('read'));
      await assert.rejects(workerGatewayRpc(gateway, 'clued_development_call_v14', subject.token,
        { op: 'record_list', context_id: cid, mode: 'development_history' }), /not_authorized|grant|source|access_denied/);
    });
    await t.test('Native list is diagnostic and does not wait on held authorization/context locks', async () => {
      await first.query('begin');
      try {
        await upsert(first, base);
        await second.query("set statement_timeout='1s'");
        const listed = await native(second, 'clued_authorization_manage_v12', { op: 'list' });
        assert.ok(listed.bindings.some((row) => row.binding_id === base.binding_id));
        const ownList = await own(second, { op: 'owner_list' });
        assert.ok(ownList.contexts.some((row) => row.id === cid));
      } finally { await first.query('rollback'); await second.query("set statement_timeout='15s'"); }
    });
    await t.test('ordinary Native upsert cannot widen a live precise expiry without new confirmation', async () => {
      const original = await grant(base);
      await assert.rejects(own(first, { op: 'grant_upsert', context_id: cid, binding_id: base.binding_id,
        grant_id: original.id, base_version: Number(original.version), actions: original.actions,
        history_policy: original.history_policy, version_policy: original.version_policy, allowed_fields: original.allowed_fields,
        expires_at: new Date(new Date(original.expires_at).getTime() + 60000).toISOString() }), /explicit_grant_confirmation_required/);
      const actual = await grant(base);
      assert.equal(actual.version, original.version); assert.equal(+actual.expires_at, +original.expires_at);
    });
    await t.test('fake GUC and absent real early lock cannot authorize a direct future-resource hook', async () => {
      await admin.query('drop trigger test_authorization_early_writer_v2 on public.clued_projects');
      await admin.query("select set_config('clued.authorization_writer_owner_v2',$1,false)", [owner]);
      await assert.rejects(admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'Denied','denied',$3)",
        [uuid(), owner, `project:${uuid()}`]), /authorization_early_writer_guard_required/);
      await allowRawTestBindings(admin);
      const partial = (await admin.query("select count(*) n from public.clued_projects where name='Denied'")).rows[0].n;
      assert.equal(Number(partial), 0, 'failed hook rolled back the inserted project');
    });
    await t.test('Repeatable Read writer rejects before mutation, keeping ordinary reader availability', async () => {
      await first.query('begin isolation level repeatable read');
      try { await assert.rejects(create(first, 'Wrong snapshot'), /authorization_writer_requires_read_committed/); }
      finally { await first.query('rollback'); }
      const value = await workerGatewayRpc(gateway, 'clued_development_call_v14', base.token, { op: 'context_list', mode: 'development_history' });
      assert.ok(value.contexts.some((row) => row.id === cid));
    });
  } finally {
    await Promise.allSettled(clients.map((db) => db.end())); await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
