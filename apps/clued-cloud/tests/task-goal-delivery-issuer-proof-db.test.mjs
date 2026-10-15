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
import { assertGatewayCloseoutBoundary, setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';
import { createResourceCenterCloudExecutor } from '../../../kernel/host/resource-center-cloud-executor.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';

// raw-binding-grants: directly inserted Bindings are inert Storage foreign-key
// fixtures and never authenticate calls; Agent calls use the actual v12 issuer
// approval flow below, while Native calls use direct human session claims.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fresh = (sub) => ({ sub, role: 'authenticated', session_id: uuid(), aal: 'aal1',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// The production publisher uses CSV COPY, exact LF reconstruction, md5 and
// one PL/pgSQL EXECUTE + schema_migrations transaction. Use the same server
// boundary here; the embedded package contains no psql binary.
async function applyProductionWrappedMigration(admin, name, bytes) {
  assert.ok(bytes.length > 0 && bytes.at(-1) === 10, 'publisher requires final LF');
  assert.equal(/[\r\x01\x02]/.test(bytes.toString('utf8')), false, 'publisher refuses CR/delimiter/quote');
  assert.equal(bytes.toString('utf8').split('\n').some((line) => line === '\\.'), false, 'publisher refuses COPY terminator');
  const expected = crypto.createHash('md5').update(bytes).digest('hex');
  const version = name.slice(0, 14), short = name.slice(15, -4);
  const workflow = await fs.readFile(path.resolve(root, '../../.github/workflows/clued-cloud-production-release.yml'), 'utf8');
  assert.ok(workflow.includes("copy migration_lines(line) from stdin with (format csv, delimiter e'\\x01', quote e'\\x02')"));
  assert.ok(workflow.includes("string_agg(coalesce(line, ''), e'\\n' order by n)"));
  assert.ok(workflow.includes('execute s;'));
  await admin.query('create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[])');
  await admin.query('create temp table migration_lines(n bigserial primary key, line text)');
  class CopyLines extends pg.Query {
    handleCopyInResponse(connection) {
      connection.sendCopyFromChunk(bytes);
      connection.endCopyFrom();
    }
  }
  await new Promise((resolve, reject) => {
    const copy = new CopyLines("copy migration_lines(line) from stdin with (format csv, delimiter e'\\x01', quote e'\\x02')");
    copy.on('end', resolve); copy.on('error', reject); admin.query(copy);
  });
  const sql = 'begin;\n' +
    "do $apply$ declare s text := (select string_agg(coalesce(line, ''), e'\\n' order by n) from migration_lines) || e'\\n';\n" +
    "begin\nif md5(s) is distinct from '" + expected + "' then raise exception 'migration text differs from the file'; end if;\n" +
    'execute s;\n' +
    "insert into supabase_migrations.schema_migrations(version,name,statements) values('" + version + "','" + short + "',array[s]);\n" +
    'end $apply$;\ncommit;';
  await admin.query(sql);
  const recorded = (await admin.query("select md5(array_to_string(statements,'')) digest,statements[1] text from supabase_migrations.schema_migrations where version=$1 and name=$2", [version, short])).rows[0];
  assert.equal(recorded.digest, expected);
  assert.equal(recorded.text, bytes.toString('utf8'), 'the entire file remains byte-identical through COPY+EXECUTE and ledger');
  await admin.query('drop table migration_lines');
}

test('Task delivery consumes actual issuer /3 producer proof and preserves archival /2 and rejection boundaries',
  { timeout: 300000 }, async (suite) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-task-goal-delivery-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hash(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
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
    const signature='clued_private.task_goal_delivery_file_v1(uuid,text,uuid,jsonb,jsonb,text,boolean)';
    let oldDefinition, oldCatalog;
    for (const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
      try {
        const bytes=await fs.readFile(path.join(root,'supabase/migrations',name));
        if(name==='20261015030000_task_goal_delivery_issuer_proof_v1.sql') {
          oldDefinition=(await admin.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;
          oldCatalog=(await admin.query('select oid,proowner,proacl::text,prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0];
          await applyProductionWrappedMigration(admin,name,bytes);
          assert.deepEqual((await admin.query('select oid,proowner,proacl::text,prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0],oldCatalog);
        } else await admin.query(bytes.toString('utf8'));
      } catch(error) { throw new Error('Migration '+name+': '+error.message,{cause:error}); }
    }
    await assertGatewayCloseoutBoundary(admin);
    const owner = uuid(), stranger = uuid(), project = uuid(), otherProject = uuid(), foreignProject = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'goal-owner@example.invalid',now()),($2,'goal-stranger@example.invalid',now())", [owner, stranger]);
    for (const [id, user] of [[project, owner], [otherProject, owner], [foreignProject, stranger]]) {
      const create = { operation: 'create', canonical_project_id: id, project_schema_version: 2, authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Isolated recognized Project fixture', source_refs: [],
        source_unavailable_reason: 'Synthetic disposable Project', idempotency_key: uuid(),
        mutation: { name: 'goal-project-' + id, progress_status: 'active', aliases: [] } };
      // Real direct-human Native entry keeps the Owner transaction/guard intact,
      // including the all-contexts successor; no private core writer bypass.
      await admin.query('begin');
      try {
        const payloadHash=(await admin.query('select clued_private.m1_sha256($1::jsonb) h',[create])).rows[0].h;
        await admin.query('set local role authenticated');
        await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user,JSON.stringify(fresh(user))]);
        const recognized=(await admin.query('select public.clued_user_project_mutate_v2($1,$2) v',[create,payloadHash])).rows[0].v;
        assert.equal(recognized.status,'committed',JSON.stringify(recognized));
        await admin.query('commit');
      } catch(error) { await admin.query('rollback'); throw error; }
    }
    const connect = async (role) => {
      const c = server.getPgClient(); clients.push(c); await c.connect();
      await c.query("set statement_timeout='6s'");
      if (role) await c.query('set role ' + role);
      return c;
    };
    const native = await connect('authenticated');
    const claims = fresh(owner);
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [owner, JSON.stringify(claims)]);
    const scope = 'project:' + project;
    const put = async ({ user = owner, scope: recordScope = scope, kind = 'task', content = 'The single executable Task body', fields } = {}) => {
      const id = uuid();
      await admin.query('insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason,content_hash) ' +
        "values($1,$2,'Goal fixture',$3,$4,$5,$6,'active',1,'active',$7,$8,'{}','{}','user_explicit','isolated fixture',$9)",
      [id, user, content, recordScope === 'global' ? 'global' : 'project',
        recordScope.startsWith('project:') ? recordScope.slice(8) : null, kind, recordScope,
        fields ?? (kind === 'decision' ? { rationale: 'Fixture source only' } : { execution_bucket: 'next' }), hash()]);
      return id;
    };
    const decisions = new Map();
    for (const [p, user] of [[project, owner], [otherProject, owner], [foreignProject, stranger]]) {
      decisions.set(p, await put({ user, scope: 'project:' + p, kind: 'decision' }));
    }
    // Inert FK Bindings model already-admitted Storage jobs. They grant no execution.
    const bindings = new Map();
    for (const user of [owner, stranger]) {
      bindings.set(user, (await admin.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic','Storage FK fixture',$2,array['context:read'],array['*']) returning id", [user, hash()])).rows[0].id);
    }
    const jsonSha = async (j) => (await admin.query('select clued_private.m1_sha256($1::jsonb) h', [JSON.stringify(j)])).rows[0].h;
    const receipt = async (user, op, payload, recordScope, targetRefs = []) => {
      const r = (await admin.query('select (clued_private.m1_begin_receipt($1,null,$2,$3::jsonb,clued_private.m1_sha256($3::jsonb))).id id',
        [user, op, JSON.stringify(payload)])).rows[0].id;
      const ev = (await admin.query("select clued_private.m1_append_event_row($1,null,$2,(select canonical_version from public.clued_audit_receipts where id=$2),'extension:task_goal_delivery_fixture:proof',$3::jsonb,$4,null,'{}',$5,(select request_sha256 from public.clued_audit_receipts where id=$2),'success','audit_only','{}','[]',null) id",
        [user, r, JSON.stringify(targetRefs), recordScope, payload.idempotency_key])).rows[0].id;
      await admin.query("select clued_private.m1_finish_receipt($1,'committed',$2::jsonb,'{}','{}',array[$3]::text[],'{}',null)",
        [r, JSON.stringify(targetRefs), ev]);
      return r;
    };
    const roots = new Map();
    const registeredRoot = async (p = project, user = owner) => {
      if (roots.has(p)) return roots.get(p);
      const location = '/task-goal-delivery-' + p + '/Clued_资料中心', decision = decisions.get(p);
      const registered = (await admin.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) v', [user, JSON.stringify({
        action: 'profile_register', project_id: p, profile_version: 'task-goal-fixture/1', source_decision_id: decision,
        managed_root: location, root_folder_id: 'root-' + p, root_parent_id: 'parent-' + p, root_folder_version: '1', idempotency_key: uuid()
      })])).rows[0].v;
      assert.equal(registered.status, 'committed', JSON.stringify(registered));
      const profile = registered.target_refs.find((r) => r.role === 'primary').id;
      const track = '20_P_产品与体验';
      const trackResult = (await admin.query('select public.clued_resource_center_admin_v1($1,$2) v', [user, {
        action: 'artifact_register', profile_id: profile, source_decision_id: decision, path: location + '/' + track,
        provider_file_id: 'track-' + p, provider_file_version: '1', target_kind: 'directory', governance_class: 'ordinary',
        delete_authority: false, idempotency_key: uuid()
      }])).rows[0].v;
      assert.equal(trackResult.status, 'committed', JSON.stringify(trackResult));
      const qualified = (await admin.query('select public.clued_storage_cloud_qualify_v1($1,$2) v', [user, {
        profile_id: profile, base_version: 1, allowed_root_children: [track], source_decision_id: decision, idempotency_key: uuid()
      }])).rows[0].v;
      assert.equal(qualified.status, 'committed', JSON.stringify(qualified));
      const connection = (await admin.query("insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,provider_subject,oauth_client_id,state,credential_version,credential_envelope,receipt_id) values($1,$2,1,$3,1,'google-drive','synthetic-provider','synthetic-client','active',1,'{}',$4) returning id",
        [user, profile, decision, registered.receipt_id])).rows[0].id;
      const policy = uuid();
      await admin.query('begin');
      try {
        await admin.query("insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id) " +
          "select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','task-goal-fixture/2',c.receipt_id from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2",
          [policy, connection]);
        await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, registered.receipt_id]);
        await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
        await admin.query("insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id) values($1,$2,$3,array['read'],1,'task-goal-read-fixture/1',$4)", [user, connection, policy, registered.receipt_id]);
        await admin.query('commit');
      } catch (error) { await admin.query('rollback'); throw error; }
      const value = { location, profile, connection, decision, policy, track, receipt: registered.receipt_id, p, user };
      roots.set(p, value); return value;
    };
    const approvedClient = async (target, scopes = [scope]) => {
      await allowTestIssuerCredentials(admin);
      const issuer = hash(), resource = 'https://task-goal-fixture.invalid/mcp', token = hash(), clientId = 'goal-client-' + uuid();
      await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Goal fixture issuer')", [issuer, resource]);
      const prepared = (await native.query('select public.clued_authorization_prepare_v12($1,$2) v', [issuer, {
        request_digest: hash(), client_id: clientId, client_name: 'Goal approved Storage fixture',
        redirect_uri: 'https://task-goal-fixture.invalid/callback', resource, requested_scopes: ['context:read','context:write']
      }])).rows[0].v;
      const approved = (await native.query('select public.clued_authorization_approve_v12($1,$2,$3,$4,$5,$6) v', [issuer,
        prepared.request_id, prepared.version, JSON.stringify(scopes.map((value) => ({ resource_kind: 'scope', resource_id: value,
          environment: 'canonical', actions: ['read','write','close'] }))), token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].v;
      assert.match(approved.binding_id ?? '', /^[0-9a-f-]{36}$/, JSON.stringify(approved));
      const lineage = uuid(), digest = (await admin.query('select clued_private.storage_client_request_digest_v2($1) d', [prepared.request_id])).rows[0].d;
      await admin.query('insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)',
        [lineage, issuer, resource, clientId, digest, target.receipt]);
      await admin.query('insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)',
        [prepared.request_id, lineage, digest, target.receipt]);
      await admin.query('insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)', [lineage, target.receipt]);
      return { token, id: approved.binding_id, lineage, issuer };
    };
    // Trusted synthetic fixture facts exercise the persisted-proof contract only.
    // No fixture contacts Google or qualifies an online provider observation.
    const file = async ({ p = project, user = owner, pending = false, binary = false, contract, missingProof = false, state = 'committed' } = {}) => {
      const target = await registeredRoot(p, user), job = uuid(), intent = uuid();
      const filePath = target.location + '/' + target.track + '/report-' + job + (binary ? '.pdf' : '.txt');
      const providerId = 'file-' + job, content = 'Exact archived UTF-8 report ' + job;
      const digest = sha(content), size = Buffer.byteLength(content);
      const mutation = binary ? { operation: 'create', target_kind: 'file', destination_path: filePath,
        content_ref: { staging_id: uuid(), sha256: digest, size, mime_type: 'application/pdf' } }
        : { operation: 'create', target_kind: 'file', destination_path: filePath, content };
      const submit = await receipt(user, 'storage_job_submit', { idempotency_key: 'fixture-submit:' + job }, 'project:' + p);
      const requestDigest = await jsonSha({ connection_id: target.connection, mutation });
      await admin.query('insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,receipt_id,authority_snapshot_v2) values($1,$2,$3,$4,$5,1,$6,$7,$5,$8)',
        [user, job, target.connection, bindings.get(user), submit, requestDigest, mutation, {}]);
      if (pending) return { ...target, job, filePath, providerId, digest, size };
      const registered = (await admin.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) v', [user, JSON.stringify({
        action: 'artifact_register', profile_id: target.profile, source_decision_id: target.decision, path: filePath,
        provider_file_id: providerId, provider_file_version: '1', target_kind: 'file', governance_class: 'ordinary',
        delete_authority: false, idempotency_key: uuid()
      })])).rows[0].v;
      assert.equal(registered.status, 'committed', JSON.stringify(registered));
      const artifact = registered.target_refs.find((r) => r.role === 'primary').id;
      const attemptReceipt = await receipt(user, 'storage_provider_attempt', { idempotency_key: 'fixture-attempt:' + intent }, 'project:' + p);
      const proof = { contract: contract ?? (binary ? 'clued.storage-create-verified/3' : 'clued.storage-create-verified/2'),
        target_kind: 'file', path: filePath, parent_id: 'track-' + p, provider_file_id: providerId, provider_file_version: '1',
        sha256: digest, size: String(size), checks: { identity: true, content: true, ancestors: true, unique_name: true, stable_version: true,
          ...(binary ? { mime_type: true, sha256_checksum: true } : {}) }, ...(binary ? { mime_type: 'application/pdf' } : {}) };
      const exact = { mutation }, authorityRequest = { mutation }, authorityResult = { status: 'resolved' }, attempt = { provider_file_id: providerId };
      const requestSha = await jsonSha(exact);
      const saved = { contract: 'clued.storage-persisted-verification/2', issuer_hash: hash(), record_input_digest: hash(),
        recorded_at: new Date().toISOString(), owner_id: user, connection_id: target.connection, job_id: job, job_request_digest: requestDigest,
        submit_receipt_id: submit, intent_id: intent, intent_version: 1, request_sha256: requestSha, writer_binding_id: null,
        provider_attempt: attempt, provider_attempt_receipt_id: attemptReceipt, authority_snapshot: {}, authority_result: authorityResult,
        exact_request_digest: await jsonSha(exact), authority_request_digest: await jsonSha(authorityRequest), proof };
      const savedDigest = await jsonSha(saved);
      const verified = await receipt(user, 'storage_verified_record', { idempotency_key: 'storage-verified:' + intent, intent_id: intent, verified_digest: savedDigest }, 'project:' + p);
      const settled = await receipt(user, 'storage_verified_settle', { idempotency_key: 'storage-settle-verified:' + intent, intent_id: intent, verified_digest: savedDigest }, 'project:' + p);
      await admin.query('insert into clued_private.resource_center_mutations_v1(id,user_id,profile_id,request_key,request_sha256,exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,version,expires_at,receipt_id,final_result,provider_attempt,provider_attempt_receipt_id,verified_result_v2,verified_receipt_id_v2,verified_digest_v2) ' +
        "values($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,$8,1,$9,$17,2,now()+interval '1 hour',$10,$11,$12,$13,$14,$15,$16)",
      [intent, user, target.profile, requestSha, exact, authorityRequest, authorityResult, hash(), target.decision, settled, registered, attempt, attemptReceipt,
        missingProof ? null : saved, missingProof ? null : verified, missingProof ? null : savedDigest, state]);
      await admin.query('update clued_private.storage_jobs_v1 set intent_id=$3 where owner_id=$1 and job_id=$2', [user, job, intent]);
      return { ...target, job, intent, filePath, providerId, digest, size, artifact, verified, settled, saved };
    };
    const call = async (input, c = native) => (await c.query('select public.clued_task_goal_delivery_owner_v1($1::jsonb) v',
      [JSON.stringify({ expected_owner_id: owner, ...input })])).rows[0].v;
    const read = async (id) => call({ action: 'read', id });
    const goal = (overrides = {}) => ({ contract: 'clued.task-goal-delivery/1', goal: 'Deliver the agreed archived report',
      scope: 'Report file only', completion_level: 'artifact', input_versions: [], acceptance_mode: 'machine',
      conditions: [{ id: 'archived', kind: 'file_integrity', text: 'Agreed archived file version', deliverable_id: 'report' }],
      deliverables: [{ id: 'report', label: 'Report', required: true }], ...overrides });
    const setGoal = async (id, definition = goal()) => {
      const view = await read(id);
      return call({ action: 'set_goal', id, base_record_version: view.record_version, workflow: definition, idempotency_key: uuid() });
    };
    const bind = async (id, job) => {
      const view = await read(id);
      return call({ action: 'bind_delivery', id, base_record_version: view.record_version,
        goal_version: view.task_workflow.goal_version, deliverable_id: 'report', job_id: job, idempotency_key: uuid() });
    };
    const completeInput = (view) => ({ action: 'complete', id: view.task_id, base_record_version: view.record_version,
      goal_version: view.task_workflow.goal_version, completion_digest: view.task_workflow.completion.completion_digest,
      closure_summary: 'The exact agreed archived version passed the current checks.', idempotency_key: uuid() });
    const rejected = (result, code) => assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result));
    const stored = async (id) => (await admin.query('select * from public.clued_memories where id=$1', [id])).rows[0];
    const nativeM1 = async (id, mutation, extra = {}) => {
      const t = await stored(id);
      const input = { operation: 'update', id, base_version: t.version, record_type: 'task', record_schema_version: 1,
        scope: t.canonical_scope, lifecycle_status: 'active', authority: 'observed', confidence_reason: 'Isolated M1 test',
        mutation, idempotency_key: uuid(), ...extra };
      return (await native.query('select public.clued_user_record_mutate($1,$2) v', [input, await jsonSha(input)])).rows[0].v;
    };


    await allowTestIssuerCredentials(admin);
    const storageIssuer=hash();
    await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,'synthetic-client','https://proof.invalid/storage/google/callback',true)",[storageIssuer]);
    const target=await registeredRoot(), client=await approvedClient(target), caller=await connect();
    await setWorkerGatewayCaller(caller);
    const rpcErrors=[];
    const cloud=async input=>{try{return (await caller.query('select public.clued_storage_cloud_worker_router_v2($1,$2::jsonb) v',[storageIssuer,JSON.stringify(input)])).rows[0].v;}catch(error){rpcErrors.push({action:input.action,code:error.code,message:error.message,where:error.where});throw error;}};
    const reference={connection_id:target.connection,job_id:uuid()};
    const mutation={operation:'create',target_kind:'file',destination_path:target.location+'/'+target.track+'/actual-producer.json',content:'{"archived":"real producer"}'};
    const submitted=(await caller.query('select public.clued_storage_jobs_router_v2($1,$2::jsonb) v',[client.token,JSON.stringify({action:'submit',...reference,mutation})])).rows[0].v;
    assert.equal(submitted.status,'queued',JSON.stringify(submitted));
    const folder=(id,name,parent)=>({id,name,parents:parent?[parent]:[],version:'1',trashed:false,mimeType:'application/vnd.google-apps.folder'});
    const files=new Map([
      ['parent-'+project,folder('parent-'+project,target.location.split('/').at(-2))],
      ['root-'+project,folder('root-'+project,target.location.split('/').at(-1),'parent-'+project)],
      ['track-'+project,folder('track-'+project,target.track,'root-'+project)]
    ]);
    let posts=0, loaded; const actions=[];
    const fetch=async(url,init={})=>{
      const u=new URL(url); assert.equal(u.hostname,'www.googleapis.com');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-proof-access');
      if(init.method==='POST') {
        posts++;
        const raw=init.body, match=/\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw),metadata=JSON.parse(match?.[0]??raw);
        const attempt=(await admin.query('select provider_attempt from clued_private.resource_center_mutations_v1 where id=$1',[metadata.appProperties.clued_intent_id])).rows[0].provider_attempt;
        assert.equal(attempt.provider_file_id,metadata.id);
        const created={...metadata,version:'1',trashed:false,size:attempt.size,sha256Checksum:attempt.sha256};
        files.set(metadata.id,created);return Response.json(created);
      }
      assert.equal(init.method??'GET','GET');
      if(u.pathname.endsWith('/generateIds')) return Response.json({ids:['proof-object-'+uuid()]});
      const query=u.searchParams.get('q');
      if(query) {
        const parent=/'([^']+)' in parents/.exec(query)?.[1],name=/name = '([^']+)'/.exec(query)?.[1];
        return Response.json({files:[...files.values()].filter(f=>f.parents.includes(parent)&&(!name||name===f.name)),incompleteSearch:false});
      }
      const found=files.get(u.pathname.split('/').at(-1));return found?Response.json(found):new Response('',{status:404});
    };
    const executor=createResourceCenterCloudExecutor({
      verified_result_mode:true,
      load_job:async ref=>{loaded=await cloud({action:'load',...ref});const descriptor={...loaded};delete descriptor.credential_envelope;delete descriptor.oauth_client_id;return descriptor;},
      get_credential:async expected=>({...expected,access_token:'fixture-proof-access',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),
      drive_fetch:fetch,
      rpc:async input=>{const {connection_id,job_id,action,...body}=input;actions.push(action);return cloud({connection_id,job_id,action,...(action==='settle_verified'?{}:{credential_version:loaded.credential_version}),...(action==='finalize'?{finish:{action,...body}}:body)});}
    });
    const executed=await executor.run(reference);
    assert.equal(executed.status,'committed',JSON.stringify({executed,rpcErrors}));
    assert.equal(posts,1);assert.ok(actions.includes('verified_record'));assert.ok(actions.includes('settle_verified'));
    const intent=(await admin.query('select m.* from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.job_id=$1',[reference.job_id])).rows[0];
    assert.equal(intent.verified_result_v2.contract,'clued.storage-persisted-verification/3');
    assert.equal(intent.verified_result_v2.proof.contract,'clued.storage-create-verified/2');
    assert.equal(intent.state,'committed');
    const id=await put();await setGoal(id,goal({deliverables:[{id:'report',label:'Report',required:true,path:mutation.destination_path,sha256:sha(mutation.content)}]}));
    const linked=await bind(id,reference.job_id);assert.equal(linked.status,'committed',JSON.stringify(linked));
    // Read on the same transaction as each rollback-only corruption injection.
    // Successful Native read/bind/complete above use the real authenticated API.
    const projection=async()=>(await admin.query('select clued_private.task_goal_delivery_projection_v1($1,t) v from public.clued_memories t where id=$2',[owner,id])).rows[0].v;
    const delivery=async()=> (await projection()).deliveries[0];
    const evaluate=async()=> (await projection()).completion.eligible;
    await suite.test('actual issuer producer /3 + inner create/2 passes file integrity and Native completion',async()=>{
      assert.equal(linked.task_workflow.completion.eligible,true,JSON.stringify(linked.task_workflow));
      assert.deepEqual([linked.task_workflow.deliveries[0].status,linked.task_workflow.deliveries[0].path,linked.task_workflow.deliveries[0].sha256,linked.task_workflow.deliveries[0].size,linked.task_workflow.deliveries[0].mime_type],['verified',mutation.destination_path,sha(mutation.content),Buffer.byteLength(mutation.content),null]);
      const completionTask=await put();await setGoal(completionTask);const completionView=await bind(completionTask,reference.job_id);
      const finish=await call(completeInput(completionView));assert.equal(finish.status,'committed',JSON.stringify(finish));
    });
    await suite.test('old consumer rejects the actual producer envelope; forward preserves function OID and ACL',async()=>{
      const newDefinition=(await admin.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;
      await admin.query('begin');try {await admin.query(oldDefinition);assert.equal(await evaluate(),false);assert.equal((await delivery()).reason,'delivery_proof_invalid');}finally{await admin.query('rollback');}
      assert.equal((await admin.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d,newDefinition);
      assert.deepEqual((await admin.query('select oid,proowner,proacl::text,prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0],oldCatalog);
    });
    await suite.test('legacy /2 envelope stays eligible',async()=>{
      const legacy=await file(), task=await put();await setGoal(task);const view=await bind(task,legacy.job);assert.equal(view.task_workflow.completion.eligible,true,JSON.stringify(view));
    });
    const changedProof=async(change,expected='delivery_proof_invalid')=>{
      await admin.query('begin');try {
        // The normal immutable trigger is separately asserted below. This
        // transaction-only corruption model reaches the consumer's defence;
        // rollback restores both proof and trigger, never an online writer.
        await admin.query('alter table clued_private.resource_center_mutations_v1 disable trigger resource_center_verified_immutable_v2');
        const saved=structuredClone(intent.verified_result_v2);change(saved);
        await admin.query('update clued_private.resource_center_mutations_v1 set verified_result_v2=$2,verified_digest_v2=clued_private.m1_sha256($2::jsonb) where id=$1',[intent.id,saved]);
        assert.equal(await evaluate(),false);assert.equal((await delivery()).reason,expected);
      }finally{await admin.query('rollback');}
    };
    await suite.test('forged issuer kind, identity, OAuth app, generation and credential material fail closed',async()=>{
      await assert.rejects(admin.query('update clued_private.resource_center_mutations_v1 set verified_digest_v2=$2 where id=$1',[intent.id,hash()]),/storage_verified_immutable/);
      for(const change of [s=>s.issuer_kind='authorization',s=>s.issuer_id=uuid(),s=>s.credential_generation='999999',s=>s.issuer_hash=storageIssuer,s=>s.contract='clued.storage-persisted-verification/99'])await changedProof(change);
      await admin.query('begin');try{await admin.query("update clued_private.storage_connections_v1 set oauth_client_id='different-client' where id=$1",[target.connection]);assert.equal(await evaluate(),false);assert.equal((await delivery()).reason,'delivery_proof_invalid');}finally{await admin.query('rollback');}
    });
    await suite.test('payload digest and committed verified Receipt remain required',async()=>{
      await admin.query('begin');try {await admin.query('alter table clued_private.resource_center_mutations_v1 disable trigger resource_center_verified_immutable_v2');await admin.query("update clued_private.resource_center_mutations_v1 set verified_digest_v2=$2 where id=$1",[intent.id,hash()]);assert.equal(await evaluate(),false);assert.equal((await delivery()).reason,'delivery_proof_invalid');}finally{await admin.query('rollback');}
      await changedProof(s=>s.record_input_digest=hash(),'delivery_receipt_invalid');
      await admin.query('begin');try {await admin.query('alter table clued_private.resource_center_mutations_v1 disable trigger resource_center_verified_immutable_v2');await admin.query('update clued_private.resource_center_mutations_v1 set verified_receipt_id_v2=$2 where id=$1',[intent.id,submitted.receipt_id]);assert.equal(await evaluate(),false);assert.equal((await delivery()).reason,'delivery_receipt_invalid');}finally{await admin.query('rollback');}
    });
    await suite.test('retiring the producer credential preserves its archived proof without authorizing new issuer calls',async()=>{
      const issuerId=intent.verified_result_v2.issuer_id;
      await admin.query("update clued_private.issuer_credentials_v1 set state='retired',retired_at=clock_timestamp() where issuer_id=$1 and generation::text=$2",[issuerId,intent.verified_result_v2.credential_generation]);
      assert.equal(await evaluate(),true);assert.equal((await delivery()).status,'verified');
      await assert.rejects(cloud({action:'load',...reference}),/storage_oauth_denied/);
    });
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for(const client of clients.reverse())await client.end().catch(()=>{});
    await server.stop().catch(()=>{});
  }
});
