import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { assertGatewayCloseoutBoundary, setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const proof = () => crypto.randomBytes(32).toString('hex');
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// The publisher's actual COPY/LF/MD5/EXECUTE boundary, not pg.query(file).
// This fixture uses only a disposable server and random, synthetic credentials.
async function applyPublisherMigration(admin, filename, bytes) {
  assert.ok(bytes.length > 0 && bytes.at(-1) === 10);
  const text = bytes.toString('utf8');
  assert.equal(/[\r\x00\x01\x02\uFFFD]/.test(text) || text.startsWith('\uFEFF'), false);
  assert.equal(text.split('\n').includes('\\.'), false);
  const workflow = await fs.readFile(path.resolve(root, '../../.github/workflows/clued-cloud-production-release.yml'), 'utf8');
  assert.ok(workflow.includes("copy migration_lines(line) from stdin with (format csv, delimiter e'\\x01', quote e'\\x02')"));
  assert.ok(workflow.includes("string_agg(coalesce(line, ''), e'\\n' order by n)"));
  assert.ok(workflow.includes('execute s;'));
  const version = filename.slice(0, 14), name = filename.slice(15, -4), expected = md5(bytes);
  await admin.query('create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[])');
  await admin.query('create temp table migration_lines(n bigserial primary key,line text)');
  class CopyLines extends pg.Query {
    handleCopyInResponse(connection) { connection.sendCopyFromChunk(bytes); connection.endCopyFrom(); }
  }
  await new Promise((resolve, reject) => {
    const copy = new CopyLines("copy migration_lines(line) from stdin with (format csv, delimiter e'\\x01', quote e'\\x02')");
    copy.on('end', resolve); copy.on('error', reject); admin.query(copy);
  });
  await admin.query('begin;\n' +
    "do $apply$ declare s text := (select string_agg(coalesce(line, ''), e'\\n' order by n) from migration_lines) || e'\\n';\n" +
    "begin if md5(s) is distinct from '" + expected + "' then raise exception 'migration text differs from the file'; end if;\n" +
    'execute s;\n' +
    "insert into supabase_migrations.schema_migrations(version,name,statements) values('" + version + "','" + name + "',array[s]);\n" +
    'end $apply$; commit;');
  const recorded = (await admin.query("select md5(array_to_string(statements,'')) hash,statements[1] text from supabase_migrations.schema_migrations where version=$1 and name=$2", [version, name])).rows[0];
  assert.equal(recorded.hash, expected);
  assert.equal(recorded.text, text);
  await admin.query('drop table migration_lines');
}

test('D01 optional Binding expiry matches the production schema and retains actual Agent authorization',
  { timeout: 300000 }, async suite => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-task-production-schema-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: proof(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {},
    onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query([
      'create role anon nologin; create role authenticated nologin;',
      'create role service_role nologin bypassrls; create role authenticator nologin noinherit;',
      'create schema auth; create schema extensions; create extension pgcrypto with schema extensions;',
      'create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);',
      "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
      "create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;",
      'grant usage on schema auth,extensions to anon,authenticated,service_role;',
      'grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;'
    ].join('\n'));
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
    const fixNames = names.filter(name => /^\d{14}_task_goal_delivery_optional_binding_expiry(?:_v\d+)?\.sql$/.test(name));
    assert.equal(fixNames.length, 1, 'the one actual forward migration must exist');
    const fixName = fixNames[0];
    for (const name of names.filter(name => name !== fixName)) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error('Migration ' + name + ': ' + error.message, { cause: error }); }
    }
    await assertGatewayCloseoutBoundary(admin);
    const owner = uuid(), stranger = uuid(), project = uuid(), scope = 'project:' + project;
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'optional-owner@example.invalid',now()),($2,'optional-stranger@example.invalid',now())", [owner, stranger]);
    await admin.query('begin');
    try {
      await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
      await admin.query('select clued_private.authorization_writer_lock_fanout_v2($1)', [owner]);
      const recognized = (await admin.query('select clued_private.project_mutation_core_v2($1,null,$2,clued_private.m1_sha256($2)) v', [owner, {
        operation: 'create', canonical_project_id: project, project_schema_version: 2, authority: 'user_explicit', user_confirmed: true,
        confidence_reason: 'Disposable recognized Project', source_refs: [], source_unavailable_reason: 'Synthetic fixture',
        idempotency_key: uuid(), mutation: { name: 'Optional expiry fixture', progress_status: 'active', aliases: [] }
      }])).rows[0].v;
      assert.equal(recognized.status, 'committed', JSON.stringify(recognized));
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
    const connect = async role => {
      const client = server.getPgClient(); clients.push(client); await client.connect();
      await client.query("set statement_timeout='8s'");
      if (role) await client.query('set role ' + role);
      return client;
    };
    const native = await connect('authenticated');
    const claims = { sub: owner, role: 'authenticated', session_id: uuid(), aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [owner, JSON.stringify(claims)]);
    const put = async (kind, fields) => {
      const id = uuid();
      await admin.query('insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason,content_hash) ' +
        "values($1,$2,'Optional expiry fixture','Existing executable Task/source body','project',$3,$4,'active',1,'active',$5,$6,'{}','{}',$8,'Synthetic disposable Record',$7)",
      [id, owner, project, kind, scope, fields, proof(), kind === 'decision' ? 'user_explicit' : 'observed']);
      return id;
    };
    // The profile requires an explicit, current Owner Decision. Match the
    // established Task/Storage fixture's source authority; do not relax its gate.
    const decision = await put('decision', { rationale: 'Disposable authorized Storage root' });
    const task = await put('task', { execution_bucket: 'next' });
    const workflow = { contract: 'clued.task-goal-delivery/1', goal: 'Deliver the agreed file', scope: 'Same Project file only',
      completion_level: 'artifact', input_versions: [], acceptance_mode: 'machine',
      conditions: [{ id: 'archived', kind: 'file_integrity', text: 'Current archived file version', deliverable_id: 'report' }],
      deliverables: [{ id: 'report', label: 'Report', required: true }] };
    const goalSet = (await native.query('select public.clued_task_goal_delivery_owner_v1($1) v', [{ action: 'set_goal', id: task,
      expected_owner_id: owner, base_record_version: 1, workflow, idempotency_key: uuid() }])).rows[0].v;
    assert.equal(goalSet.status, 'committed', JSON.stringify(goalSet));

    // Reuse the existing Storage DB suite's profile/qualification/registration
    // setup. Facts are synthetic; the real read and inspect evaluators remain intact.
    const location = '/optional-expiry-' + project, track = '20_P_产品与体验';
    const registered = (await admin.query('select public.clued_resource_center_admin_v1($1,$2) v', [owner, {
      action: 'profile_register', project_id: project, profile_version: 'optional-fixture/1', source_decision_id: decision,
      managed_root: location, root_folder_id: 'root-' + project, root_parent_id: 'parent-' + project,
      root_folder_version: '1', idempotency_key: uuid()
    }])).rows[0].v;
    assert.equal(registered.status, 'committed', JSON.stringify(registered));
    const profile = registered.target_refs.find(ref => ref.role === 'primary').id;
    const trackResult = (await admin.query('select public.clued_resource_center_admin_v1($1,$2) v', [owner, {
      action: 'artifact_register', profile_id: profile, source_decision_id: decision, path: location + '/' + track,
      provider_file_id: 'track-' + project, provider_file_version: '1', target_kind: 'directory',
      governance_class: 'ordinary', delete_authority: false, idempotency_key: uuid()
    }])).rows[0].v;
    assert.equal(trackResult.status, 'committed', JSON.stringify(trackResult));
    const qualified = (await admin.query('select public.clued_storage_cloud_qualify_v1($1,$2) v', [owner, {
      profile_id: profile, base_version: 1, allowed_root_children: [track], source_decision_id: decision, idempotency_key: uuid()
    }])).rows[0].v;
    assert.equal(qualified.status, 'committed', JSON.stringify(qualified));
    const connection = (await admin.query("insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,provider_subject,oauth_client_id,state,credential_version,credential_envelope,receipt_id) values($1,$2,1,$3,1,'google-drive','synthetic-provider','synthetic-client','active',1,'{}',$4) returning id",
      [owner, profile, decision, registered.receipt_id])).rows[0].id;
    const policy = uuid();
    await admin.query('begin');
    try {
      await admin.query('insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id) ' +
        "select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','optional-fixture/2',c.receipt_id from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2", [policy, connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, registered.receipt_id]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
      await admin.query("insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id) values($1,$2,$3,array['read'],1,'optional-read-fixture/1',$4)", [owner, connection, policy, registered.receipt_id]);
      await admin.query('commit');
    } catch (error) { await admin.query('rollback'); throw error; }
    await allowTestIssuerCredentials(admin);
    const issuer = proof(), token = proof(), resource = 'https://optional-fixture.invalid/mcp', clientId = 'optional-' + uuid();
    await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Disposable fixture issuer')", [issuer, resource]);
    const prepared = (await native.query('select public.clued_authorization_prepare_v12($1,$2) v', [issuer, {
      request_digest: proof(), client_id: clientId, client_name: 'Optional expiry approved client', redirect_uri: 'https://optional-fixture.invalid/callback',
      resource, requested_scopes: ['context:read','context:write']
    }])).rows[0].v;
    const approved = (await native.query('select public.clued_authorization_approve_v12($1,$2,$3,$4,$5,$6) v', [issuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: 'scope', resource_id: scope,
        environment: 'canonical', actions: ['read','write','close'] }]), token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].v;
    assert.match(approved.binding_id ?? '', /^[0-9a-f-]{36}$/, JSON.stringify(approved));
    const binding = approved.binding_id, lineage = uuid();
    const digest = (await admin.query('select clued_private.storage_client_request_digest_v2($1) d', [prepared.request_id])).rows[0].d;
    await admin.query('insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)', [lineage, issuer, resource, clientId, digest, registered.receipt_id]);
    await admin.query('insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)', [prepared.request_id, lineage, digest, registered.receipt_id]);
    await admin.query('insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)', [lineage, registered.receipt_id]);
    const jobs = [];
    for (let index = 0; index < 2; index++) {
      const job = uuid(), mutation = { operation: 'create', target_kind: 'file', destination_path: location + '/' + track + '/pending-' + job + '.txt', content: 'Synthetic queued file' };
      await admin.query('insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,receipt_id,authority_snapshot_v2) values($1,$2,$3,$4,$5,1,clued_private.m1_sha256($6),$7,$5,$8)',
        [owner, job, connection, binding, registered.receipt_id, { connection_id: connection, mutation }, mutation, {}]);
      jobs.push(job);
    }
    const gateway = await connect(); await setWorkerGatewayCaller(gateway);
    const scopeRead = async (who = owner, selectedBinding = binding) => (await admin.query('select clued_private.task_goal_delivery_scope_read_v1($1,$2,$3) ok', [who, selectedBinding, scope])).rows[0].ok;
    const stored = async () => (await admin.query('select version,type_fields from public.clued_memories where id=$1', [task])).rows[0];
    const list = async () => (await gateway.query('select public.clued_record_list($1,$2) v', [token,
      { level: 'project', project_id: project, record_type: 'task', limit: 200 }])).rows[0].v.records.find(row => row.id === task);
    const mutate = async mutation => {
      const current = await stored();
      return (await gateway.query('select public.clued_record_mutate($1,$2) v', [token, { operation: 'update', id: task,
        base_version: Number(current.version), scope, record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
        authority: 'observed', confidence_reason: 'Actual authorized Agent regression call in disposable database',
        mutation, idempotency_key: uuid() }])).rows[0].v;
    };
    const bind = async job => {
      const current = await list();
      return mutate({ type_fields: { task_workflow: { ...current.task_workflow.definition,
        delivery_refs: [{ deliverable_id: 'report', job_id: job, goal_version: current.task_workflow.goal_version }] } } });
    };
    const catalog = async () => (await admin.query("select oid,proowner,proacl::text acl,proconfig,prosecdef,provolatile,pg_get_functiondef(oid) definition from pg_proc where oid='clued_private.task_goal_delivery_scope_read_v1(uuid,uuid,text)'::regprocedure")).rows[0];
    await suite.test('present optional expiry and actual v12 read, ownership and Binding checks retain their boundary', async () => {
      assert.equal(await scopeRead(), true);
      assert.ok(Array.isArray((await list()).task_workflow.deliveries));
      await admin.query("update public.clued_agent_bindings set expires_at=clock_timestamp()+interval '1 hour' where id=$1", [binding]);
      assert.equal(await scopeRead(), true);
      await admin.query("update public.clued_agent_bindings set expires_at=clock_timestamp()-interval '1 second' where id=$1", [binding]);
      assert.equal(await scopeRead(), false);
      await admin.query('update public.clued_agent_bindings set expires_at=null where id=$1', [binding]);
      assert.equal(await scopeRead(), true);
      assert.equal(await scopeRead(owner, uuid()), false);
      assert.equal(await scopeRead(stranger), false);
    });
    const before = await catalog();
    await suite.test('missing production-only P5 column reproduces SQLSTATE 42703 and the original closed helper', async () => {
      const ledger = JSON.parse(await fs.readFile(path.join(root, 'supabase/ledger/production-history.json'), 'utf8'));
      assert.equal(ledger.repository_only.find(row => row.file === 'migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql')?.status, 'never_applied');
      await admin.query('alter table public.clued_agent_bindings drop column expires_at');
      assert.equal((await admin.query("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='clued_agent_bindings' and column_name='expires_at') present")).rows[0].present, false);
      await assert.rejects(() => admin.query('select expires_at from public.clued_agent_bindings where id=$1', [binding]), error => error.code === '42703');
      assert.equal(await scopeRead(), false);
      const ordinary = await list();
      assert.ok(ordinary?.task_workflow?.goal_version, 'the existing authorized canonical list still returns the Task');
      assert.equal(Object.hasOwn(ordinary.task_workflow, 'deliveries'), false, 'core metadata survives but Agent qualification is missing');
      const changed = await mutate({ type_fields: { execution_bucket: 'next' } });
      assert.equal(changed.status, 'committed', JSON.stringify(changed));
      assert.equal(changed.supplemental.record.task_workflow, null);
      const version = Number((await stored()).version), failed = await bind(jobs[0]);
      assert.equal(failed.status, 'rejected', JSON.stringify(failed));
      assert.equal(failed.error_code, 'task_delivery_reference_unavailable');
      assert.equal(Number((await stored()).version), version, 'the rejected bind cannot mutate the Task');
    });
    await suite.test('exact forward migration crosses production COPY/EXECUTE while retaining OID, ACL and header', async () => {
      await applyPublisherMigration(admin, fixName, await fs.readFile(path.join(root, 'supabase/migrations', fixName)));
      const after = await catalog();
      for (const key of ['oid','proowner','acl','proconfig','prosecdef','provolatile']) assert.deepEqual(after[key], before[key], key);
      assert.notEqual(after.definition, before.definition);
      assert.equal(await scopeRead(), true);
      await assertGatewayCloseoutBoundary(admin);
    });
    await suite.test('the same approved Agent, canonical Task and Storage Job bind with no optional column', async () => {
      assert.ok(Array.isArray((await list()).task_workflow.deliveries));
      const bound = await bind(jobs[0]);
      assert.equal(bound.status, 'committed', JSON.stringify(bound));
      assert.equal(bound.supplemental.record.id, task);
      assert.equal(bound.supplemental.record.task_workflow.delivery_refs[0].job_id, jobs[0]);
      assert.equal(bound.supplemental.record.task_workflow.deliveries[0].status, 'pending', 'a queued Job never becomes verified file delivery');
      assert.equal((await list()).task_workflow.deliveries[0].status, 'pending');
      const ownerRead = (await native.query('select public.clued_task_goal_delivery_owner_v1($1) v', [{ action: 'read', id: task, expected_owner_id: owner }])).rows[0].v;
      assert.equal(ownerRead.task_workflow.completion.eligible, false, 'the fix cannot create completion proof');
    });
    await suite.test('fixed missing-column helper still denies missing/mismatched/revoked Bindings and withdrawn read', async () => {
      assert.equal(await scopeRead(owner, uuid()), false);
      assert.equal(await scopeRead(stranger), false);
      await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1', [binding]);
      assert.equal(await scopeRead(), false);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1', [binding]);
      assert.equal(await scopeRead(), true);
      await admin.query("update clued_private.authorization_entries_v12 set actions=array['write','close'] where binding_id=$1 and resource_kind='scope' and resource_id=$2 and environment='canonical'", [binding, scope]);
      assert.equal(await scopeRead(), false);
      // Keep write granted so the real outer M1 resolver succeeds, then show
      // that the new reference's independent read admission still refuses.
      const current = await stored();
      const denied = await mutate({ type_fields: { task_workflow: { ...current.type_fields.task_workflow,
        delivery_refs: [{ deliverable_id: 'report', job_id: jobs[1], goal_version: boundGoal(current) }] } } });
      assert.equal(denied.status, 'rejected', JSON.stringify(denied));
      assert.equal(denied.error_code, 'task_delivery_reference_unavailable');
      assert.equal(Number((await stored()).version), Number(current.version));
    });
    await suite.test('fixed helper retains null/future/expired behavior when the optional column is present', async () => {
      await admin.query("update clued_private.authorization_entries_v12 set actions=array['read','write','close'] where binding_id=$1 and resource_kind='scope' and resource_id=$2 and environment='canonical'", [binding, scope]);
      // Only this disposable database: the forward migration itself never
      // manufactures the P5 schema or grants a caller extra permission.
      await admin.query('alter table public.clued_agent_bindings add column expires_at timestamptz');
      assert.equal(await scopeRead(), true, 'optional null is no Binding expiry');
      await admin.query("update public.clued_agent_bindings set expires_at=clock_timestamp()+interval '1 hour' where id=$1", [binding]);
      assert.equal(await scopeRead(), true);
      await admin.query("update public.clued_agent_bindings set expires_at=clock_timestamp()-interval '1 second' where id=$1", [binding]);
      assert.equal(await scopeRead(), false);
      await admin.query('update public.clued_agent_bindings set expires_at=null where id=$1', [binding]);
      assert.equal(await scopeRead(), true);
      await assertGatewayCloseoutBoundary(admin);
    });
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    await stopCluster(server);
    // This exact directory was allocated by this test; reject a changed target.
    if (await fs.realpath(directory).catch(() => null) === directory) await removeTestDirectory(directory);
  }
});

function boundGoal(record) { return record.type_fields.task_workflow.delivery_refs[0].goal_version; }
