import { stopCluster } from './cluster-cleanup.mjs';
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

test('Task goal/file completion uses exact M1 admission, persisted Storage proof and Native acceptance',
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
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((n) => n.endsWith('.sql')).sort()) {
      try {
        const bytes = await fs.readFile(path.join(root, 'supabase/migrations', name));
        if (name === '20261014132753_task_goal_delivery_v1.sql') {
          await suite.test('migration accepts an absent optional gateway role without manufacturing privileges', async () => {
            // Disposable transaction only: replay the same migration with the
            // optional gateway absent, then restore its real grants on rollback.
            await admin.query('begin');
            try {
              await admin.query('drop owned by clued_worker_gateway; drop role clued_worker_gateway');
              await admin.query(bytes.toString('utf8'));
              assert.equal((await admin.query("select exists(select 1 from pg_roles where rolname='clued_worker_gateway') v")).rows[0].v, false);
              for (const table of ['task_goal_delivery_acceptances_v1', 'task_goal_delivery_completion_admissions_v1']) {
                assert.equal((await admin.query('select relrowsecurity from pg_class where oid=$1::regclass', ['clued_private.' + table])).rows[0].relrowsecurity, true);
                for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') v", [role, 'clued_private.' + table])).rows[0].v, false);
              }
              for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await admin.query("select has_function_privilege($1,'public.clued_task_goal_delivery_owner_v1(jsonb)','EXECUTE') v", [role])).rows[0].v, role === 'authenticated');
              const helpers = (await admin.query("select oid::regprocedure::text signature from pg_proc where pronamespace='clued_private'::regnamespace and proname like 'task_goal_delivery_%'")).rows;
              for (const { signature } of helpers) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await admin.query("select has_function_privilege($1,$2::regprocedure,'EXECUTE') v", [role, signature])).rows[0].v, false);
            } finally { await admin.query('rollback'); }
            await assertGatewayCloseoutBoundary(admin);
          });
          await applyProductionWrappedMigration(admin, name, bytes);
        }
        else if (name === '20261117102000_task_goal_delivery_reconnect_v1.sql') {
          await suite.test('reconnect forward migration rejects altered source and function authority', async () => {
            for (const signature of ['clued_private.task_goal_delivery_storage_read_v1(uuid,uuid,uuid,uuid)',
              'clued_private.task_goal_delivery_file_v1(uuid,text,uuid,jsonb,jsonb,text,boolean)']) {
              const definition = (await admin.query('select pg_get_functiondef($1::regprocedure) d', [signature])).rows[0].d;
              for (const tamper of [
                'alter function ' + signature + ' owner to authenticated',
                'alter function ' + signature + ' security invoker',
                'alter function ' + signature + ' set search_path=public',
                'grant execute on function ' + signature + ' to anon',
                definition.replace('\nbegin\n', '\nbegin\n-- unexpected source drift\n'),
              ]) {
                await admin.query('begin');
                try { await admin.query(tamper); await assert.rejects(() => admin.query(bytes.toString('utf8')), /task_goal_reconnect_(read|file)_source_mismatch/); }
                finally { await admin.query('rollback'); }
                assert.equal((await admin.query("select to_regprocedure('clued_private.task_goal_delivery_connection_v1(uuid,uuid,boolean)') is null absent")).rows[0].absent, true);
              }
            }
          });
          await applyProductionWrappedMigration(admin, name, bytes);
        }
        else if (name === '20261117113000_storage_refresh_intent_v1.sql') await applyProductionWrappedMigration(admin, name, bytes);
        else await admin.query(bytes.toString('utf8'));
      }
      catch (error) { throw new Error('Migration ' + name + ': ' + error.message, { cause: error }); }
    }
    await assertGatewayCloseoutBoundary(admin);
    const owner = uuid(), stranger = uuid(), project = uuid(), otherProject = uuid(), foreignProject = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'goal-owner@example.invalid',now()),($2,'goal-stranger@example.invalid',now())", [owner, stranger]);
    for (const [id, user] of [[project, owner], [otherProject, owner], [foreignProject, stranger]]) {
      const create = { operation: 'create', canonical_project_id: id, project_schema_version: 2, authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Isolated recognized Project fixture', source_refs: [],
        source_unavailable_reason: 'Synthetic disposable Project', idempotency_key: uuid(),
        mutation: { name: 'goal-project-' + id, progress_status: 'active', aliases: [] } };
      // The current private core requires the same early Owner/fanout lock
      // order as the Native entrance, including disposable admin seed data.
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [user]);
        await admin.query('select clued_private.authorization_writer_lock_fanout_v2($1)', [user]);
        const recognized = (await admin.query('select clued_private.project_mutation_core_v2($1,null,$2,clued_private.m1_sha256($2)) v',
          [user, create])).rows[0].v;
        assert.equal(recognized.status, 'committed', JSON.stringify(recognized));
        await admin.query('commit');
      } catch (error) {
        await admin.query('rollback');
        throw error;
      }
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
      const location = '/task-goal-delivery-' + p, decision = decisions.get(p);
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

    await suite.test('legacy Task close unchanged; new loop has exact files and linked M1 receipts', async () => {
      const legacy = await put();
      assert.equal((await read(legacy)).task_workflow, null);
      const legacyClosed = await nativeM1(legacy, { closure_summary: 'Legacy close' }, { operation: 'close', lifecycle_status: 'completed' });
      assert.equal(legacyClosed.status, 'committed', JSON.stringify(legacyClosed));
      const id = await put(), output = await file();
      assert.equal((await setGoal(id)).status, 'committed');
      const linked = await bind(id, output.job); assert.equal(linked.status, 'committed', JSON.stringify(linked));
      assert.equal(linked.task_workflow.completion.eligible, true, JSON.stringify(linked.task_workflow));
      const delivery = linked.task_workflow.deliveries[0];
      assert.deepEqual([delivery.status, delivery.path, delivery.sha256, delivery.provider_file_version, delivery.mime_type],
        ['verified', output.filePath, output.digest, '1', null]);
      assert.equal(delivery.verification_scope, 'persisted_storage_and_current_registry');
      for (const secret of ['issuer_hash', 'authority_token_hash', 'credential_envelope', 'provider_attempt', 'mutation']) {
        assert.equal(JSON.stringify(linked.task_workflow).includes(secret), false, secret);
      }
      const request = completeInput(linked);
      const finished = await call(request); assert.equal(finished.status, 'committed', JSON.stringify(finished));
      assert.equal((await stored(id)).lifecycle_status, 'completed');
      const adapterReceipt = (await admin.query('select * from public.clued_audit_receipts where id=$1', [finished.receipt_id])).rows[0];
      assert.equal(adapterReceipt.operation_family, 'task_goal_delivery_owner');
      const recordReceiptId = adapterReceipt.target_refs.find((r) => r.kind === 'system' && r.role === 'source').id;
      const admitted = (await admin.query('select * from clued_private.task_goal_delivery_completion_admissions_v1 where receipt_id=$1', [recordReceiptId])).rows[0];
      assert.equal(admitted.task_id, id); assert.equal(Number(admitted.base_record_version), linked.record_version);
      const actual = (await admin.query('select * from public.clued_audit_receipts where id=$1', [recordReceiptId])).rows[0];
      assert.deepEqual([actual.status, actual.operation_family, actual.committed_versions[id]], ['committed', 'record_mutation', linked.record_version + 1]);
      assert.equal(actual.event_ids.length, 1);
      const replay = await call(request); assert.deepEqual([replay.status, replay.replayed, replay.receipt_id], ['committed', true, finished.receipt_id]);
      rejected(await call({ ...request, closure_summary: 'Changed under reused idempotency key' }), 'IDEMPOTENCY_KEY_CONFLICT');
    });
    await suite.test('owner review only actual Native acceptance; body/file changes invalidate it', async () => {
      const id = await put(), output = await file();
      await setGoal(id, goal({ acceptance_mode: 'owner', input_versions: [{ label: 'External report source', kind: 'declared', version: 'user-declared-v1' }],
        conditions: [{ id: 'quality', kind: 'owner_review', text: 'I reviewed the report quality and the declared-input limitation' }] }));
      const linked = await bind(id, output.job);
      assert.equal(linked.task_workflow.completion.ready_for_acceptance, true);
      assert.equal(linked.task_workflow.completion.eligible, false);
      assert.deepEqual(linked.task_workflow.completion.limitations, ['input_declared_unverified:External report source']);
      rejected(await call(completeInput(linked)), 'task_owner_acceptance_required');
      const acceptRequest = { action: 'accept', id, base_record_version: linked.record_version, goal_version: linked.task_workflow.goal_version,
        completion_digest: linked.task_workflow.completion.completion_digest, idempotency_key: uuid() };
      const accepted = await call(acceptRequest); assert.equal(accepted.status, 'committed', JSON.stringify(accepted));
      assert.equal(accepted.record_version, linked.record_version, 'acceptance does not mutate the Task version');
      assert.equal(accepted.task_workflow.completion.owner_accepted, true);
      assert.ok(!Object.hasOwn(accepted.committed_versions, id));
      const replay = await call(acceptRequest); assert.equal(replay.receipt_id, accepted.receipt_id);
      const acceptanceRow = (await admin.query('select * from clued_private.task_goal_delivery_acceptances_v1 where receipt_id=$1', [accepted.receipt_id])).rows[0];
      await assert.rejects(() => admin.query("update clued_private.task_goal_delivery_acceptances_v1 set goal_version=$2 where id=$1", [acceptanceRow.id, hash()]), /audit_immutable/);
      await nativeM1(id, { content: 'New report scope and execution body' });
      const changed = await read(id); assert.notEqual(changed.task_workflow.goal_version, linked.task_workflow.goal_version);
      assert.deepEqual([changed.task_workflow.completion.owner_accepted, changed.task_workflow.deliveries[0].status], [false, 'stale']);
      rejected(await call({ ...completeInput(changed), goal_version: linked.task_workflow.goal_version }), 'task_goal_version_conflict');
      await bind(id, output.job);
      const rebound = await read(id); assert.equal(rebound.task_workflow.completion.owner_accepted, false);
      const acceptedAgain = await call({ ...acceptRequest, base_record_version: rebound.record_version, goal_version: rebound.task_workflow.goal_version,
        completion_digest: rebound.task_workflow.completion.completion_digest, idempotency_key: uuid() });
      assert.equal(acceptedAgain.status, 'committed');
      assert.equal((await call(completeInput(acceptedAgain))).status, 'committed');
    });
    await suite.test('sticky metadata and generic/direct-table completion cannot bypass the checks', async () => {
      const id = await put(); await setGoal(id);
      for (const [mutation, extra] of [[{ type_fields: { task_workflow: null } }, {}],
        [{ type_fields: { execution_bucket: 'next' } }, { field_mode: 'replace' }]]) {
        rejected(await nativeM1(id, mutation, extra), 'task_workflow_marker_immutable');
      }
      rejected(await nativeM1(id, { closure_summary: 'Caller says success' }, { operation: 'close', lifecycle_status: 'completed' }), 'task_completion_checks_failed');
      await assert.rejects(() => admin.query("update public.clued_memories set lifecycle_status='completed',version=version+1 where id=$1", [id]), /task_completion_requires_m1_receipt/);
      await assert.rejects(() => admin.query("update public.clued_memories set type_fields=type_fields-'task_workflow' where id=$1", [id]), /marker_immutable/);
      const foreignPending = (await admin.query("select (clued_private.m1_begin_receipt($1,null,'record_mutation',$2::jsonb,clued_private.m1_sha256($2::jsonb))).id id",
        [owner, { idempotency_key: uuid(), operation: 'close', id: uuid(), base_version: 1, lifecycle_status: 'completed', scope }])).rows[0].id;
      await assert.rejects(() => admin.query("update public.clued_memories set lifecycle_status='completed',version=version+1,receipt_id=$2 where id=$1", [id, foreignPending]), /task_completion_requires_m1_receipt/);
      await admin.query("update public.clued_memories set type_fields=type_fields||'{\"projection_key\":\"unbound-goal-projection\"}' where id=$1", [id]);
      rejected(await nativeM1(id, { closure_summary: 'Unknown currentness' }, { operation: 'close', lifecycle_status: 'completed' }), 'task_not_current');
      assert.equal((await stored(id)).lifecycle_status, 'active');
      assert.equal(Number((await admin.query('select count(*) n from clued_private.task_goal_delivery_completion_admissions_v1 where task_id=$1', [id])).rows[0].n), 0,
        'failed M1 close rolls admission back');
    });
    await suite.test('queued/adopt/missing proof, MIME, file version and business result stay incomplete', async () => {
      for (const config of [{ pending: true }, { contract: 'clued.storage-adopt-verified/1' }, { missingProof: true }, { state: 'cancelled' }]) {
        const id = await put(), output = await file(config); await setGoal(id);
        const linked = await bind(id, output.job);
        assert.equal(linked.task_workflow.completion.eligible, false);
        rejected(await call(completeInput(linked)), 'task_completion_checks_failed');
      }
      const id = await put(), output = await file(); await setGoal(id, goal({ deliverables: [{ id: 'report', label: 'Report', required: true, mime_type: 'text/plain' }] }));
      const linked = await bind(id, output.job);
      assert.equal(linked.task_workflow.deliveries[0].reason, 'delivery_mime_unknown');
      const binId = await put(), binary = await file({ binary: true }); await setGoal(binId, goal({ deliverables: [{ id: 'report', label: 'PDF', required: true, mime_type: 'application/pdf' }] }));
      const binLinked = await bind(binId, binary.job); assert.equal(binLinked.task_workflow.completion.eligible, true, JSON.stringify(binLinked));
      await admin.query("update clued_private.resource_center_artifacts_v1 set provider_file_version='2',version=version+1 where id=$1", [binary.artifact]);
      const stale = await read(binId); assert.equal(stale.task_workflow.deliveries[0].status, 'stale');
      rejected(await call({ ...completeInput(stale), completion_digest: binLinked.task_workflow.completion.completion_digest }), 'task_completion_digest_conflict');
      const unsupported = await put(), report = await file(); await setGoal(unsupported, goal({ completion_level: 'business_effect' }));
      const draft = await bind(unsupported, report.job); assert.equal(draft.task_workflow.completion.eligible, false);
      assert.ok(draft.task_workflow.completion.reasons.includes('completion_level_unsupported'));
      rejected(await call(completeInput(draft)), 'task_completion_checks_failed');
      const corruptId = await put(), corrupt = await file(); await setGoal(corruptId); await bind(corruptId, corrupt.job);
      await admin.query("update public.clued_audit_receipts set response_hash=$2 where id=$1", [corrupt.verified, hash()]);
      assert.equal((await read(corruptId)).task_workflow.deliveries[0].reason, 'delivery_receipt_invalid');
      const mismatchId = await put(), mismatch = await file({ binary: true });
      await setGoal(mismatchId, goal({ deliverables: [{ id: 'report', label: 'Expected ZIP', required: true, mime_type: 'application/zip' }] }));
      assert.equal((await bind(mismatchId, mismatch.job)).task_workflow.deliveries[0].reason, 'delivery_mime_mismatch');
      await setGoal(mismatchId, goal({ deliverables: [{ id: 'report', label: 'Expected hash', required: true, sha256: hash() }] }));
      assert.equal((await bind(mismatchId, mismatch.job)).task_workflow.deliveries[0].reason, 'delivery_expectation_mismatch');
      const changedIds = await setGoal(mismatchId, goal({ deliverables: [{ id: 'new_report', label: 'Changed required output', required: true }],
        conditions: [{ id: 'archived', kind: 'file_integrity', text: 'New report version', deliverable_id: 'new_report' }] }));
      assert.equal(changedIds.status, 'committed', JSON.stringify(changedIds));
      assert.equal(changedIds.task_workflow.completion.eligible, false, 'changed deliverable ID preserves old refs only as historical metadata');
    });
    await suite.test('inputs are version-bound; scope isolation, strict shape, Native identity and candidate cap', async () => {
      const inputId = await put(), id = await put(), output = await file();
      await setGoal(id, goal({ input_versions: [{ label: 'Source', kind: 'record', id: inputId, scope, version: 1 }] }));
      const linked = await bind(id, output.job); assert.equal(linked.task_workflow.completion.eligible, true);
      await nativeM1(inputId, { content: 'Changed source version' });
      assert.equal((await read(id)).task_workflow.completion.eligible, false);
      const crossProject = await file({ p: otherProject }), foreign = await file({ p: foreignProject, user: stranger });
      rejected(await bind(id, crossProject.job), 'task_delivery_reference_unavailable');
      rejected(await bind(id, foreign.job), 'task_delivery_reference_unavailable');
      const beforeVersion = (await read(id)).record_version;
      rejected(await call({ action: 'set_goal', id, base_record_version: beforeVersion, workflow: goal({ acceptance_mode: 'machine',
        input_versions: [{ label: 'External', kind: 'declared', version: 'v1' }] }), idempotency_key: uuid() }), 'task_workflow_declared_input_requires_owner');
      for (const malformed of [goal({ deliverables: [{ id: 1, label: 'Report', required: true }] }),
        goal({ owner_accepted: true }), goal({ conditions: [] }), goal({ input_versions: null })]) {
        const result = await setGoal(id, malformed); assert.equal(result.status, 'rejected', JSON.stringify(result));
      }
      rejected(await call({ action: 'read', id, expected_owner_id: stranger }), 'task_owner_changed');
      rejected(await call({ action: 'read', id, owner_accepted: true }), 'task_goal_delivery_input_invalid');
      await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [stranger, JSON.stringify(fresh(stranger))]);
      rejected(await call({ action: 'read', id, expected_owner_id: stranger }), 'task_unavailable');
      await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [owner, JSON.stringify({ ...claims, client_id: 'delegated-client' })]);
      await assert.rejects(() => call({ action: 'read', id }), /direct_human_session_required/);
      await native.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
      for (let i = 0; i < 31; i++) await file({ pending: true });
      const candidates = (await read(id)).delivery_candidates;
      assert.equal(candidates.length, 30);
      assert.ok(!candidates.some((x) => [foreign.job, crossProject.job].includes(x.job_id)));
      assert.deepEqual(Object.keys(candidates[0]).sort(), ['job_id', 'label', 'path', 'state']);
      for (const role of ['anon', 'service_role', 'clued_worker_gateway']) {
        const denied = await connect(role);
        await assert.rejects(() => call({ action: 'read', id }, denied), /permission denied/);
      }
    });
    await suite.test('Agent uses existing authorized reads and M1 metadata; cannot forge Native acceptance', async () => {
      const { token } = await approvedClient(await registeredRoot());
      const gateway = await connect(); await setWorkerGatewayCaller(gateway);
      const id = await put(), output = await file();
      await setGoal(id, goal({ acceptance_mode: 'owner', conditions: [{ id: 'quality', kind: 'owner_review', text: 'Actual Owner review' }] }));
      const listing = (await gateway.query('select public.clued_record_list($1,$2::jsonb) v', [token, { level: 'project', project_id: project, record_type: 'task', limit: 200 }])).rows[0].v;
      const found = listing.records.find((r) => r.id === id);
      assert.ok(found?.task_workflow?.goal_version, JSON.stringify(listing));
      assert.deepEqual(Object.keys(found.task_workflow).sort(), ['definition', 'deliveries', 'delivery_refs', 'goal_version']);
      assert.equal(JSON.stringify(found.task_workflow).includes('acceptance_receipt_id'), false);
      const workflow = { ...found.task_workflow.definition, delivery_refs: [{ deliverable_id: 'report', job_id: output.job, goal_version: found.task_workflow.goal_version }] };
      const agentMutate = async (mutation, extra = {}) => {
        const t = await stored(id);
        return (await gateway.query('select public.clued_record_mutate($1,$2::jsonb) v', [token, {
          operation: 'update', id, base_version: t.version, scope, record_type: 'task', record_schema_version: 1,
          lifecycle_status: 'active', authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Synthetic actual-Owner words',
          mutation, idempotency_key: uuid(), ...extra
        }])).rows[0].v;
      };
      const bound = await agentMutate({ type_fields: { task_workflow: workflow } });
      assert.equal(bound.status, 'committed', JSON.stringify(bound));
      assert.equal(bound.supplemental.record.task_workflow.goal_version, found.task_workflow.goal_version);
      assert.deepEqual([bound.supplemental.record.task_workflow.deliveries[0].connection_id,
        bound.supplemental.record.task_workflow.deliveries[0].path,
        bound.supplemental.record.task_workflow.deliveries[0].artifact_id], [output.connection, output.filePath, output.artifact]);
      assert.ok(bound.supplemental.record.task_workflow.deliveries[0].registration_receipt_id);
      rejected(await agentMutate({ type_fields: { task_workflow: { ...workflow, owner_accepted: true } } }), 'task_workflow_invalid');
      rejected(await agentMutate({ closure_summary: 'Agent user_confirmed is not Native acceptance' },
        { operation: 'close', lifecycle_status: 'completed' }), 'task_completion_checks_failed');
      const cross = await file({ p: otherProject });
      rejected(await agentMutate({ type_fields: { task_workflow: { ...workflow, delivery_refs: [
        { deliverable_id: 'report', job_id: cross.job, goal_version: found.task_workflow.goal_version }] } } }), 'task_delivery_reference_unavailable');
    });
    await suite.test('search finds an exact Task locator, fresh registry state and no denied-project file leakage', async () => {
      const { token } = await approvedClient(await registeredRoot());
      const { token: globalToken } = await approvedClient(await registeredRoot(), ['global']);
      const gateway = await connect(); await setWorkerGatewayCaller(gateway);
      const marker = 'ExactLocator' + crypto.randomBytes(8).toString('hex');
      const id = await put({ content: marker }), output = await file(); await setGoal(id); await bind(id, output.job);
      const resumed = (await gateway.query('select public.clued_mcp_restore($1,$2) v', [token, { context_key: scope }])).rows[0].v;
      assert.ok(resumed.session_token, JSON.stringify(resumed));
      const search = async () => (await gateway.query('select public.clued_mcp_search_context($1,$2) v', [token,
        { session_token: resumed.session_token, context_key: scope, query: marker, limit: 5, max_bytes: 4096 }])).rows[0].v;
      const found = (await search()).results.find((x) => x.kind === 'record' && x.id === id);
      assert.ok(found?.task_workflow, JSON.stringify(found));
      assert.deepEqual([found.task_workflow.deliveries[0].path, found.task_workflow.deliveries[0].sha256,
        found.task_workflow.deliveries[0].connection_id], [output.filePath, output.digest, output.connection]);
      const version = found.version;
      await admin.query("update clued_private.resource_center_artifacts_v1 set provider_file_version='2',version=version+1 where id=$1", [output.artifact]);
      const changed = (await search()).results.find((x) => x.kind === 'record' && x.id === id);
      assert.equal(changed.version, version, 'Artifact change does not alter the Task text-cache signature');
      assert.equal(changed.task_workflow.deliveries[0].status, 'stale', 'locator qualification is freshly derived after authorized cached text lookup');
      const global = await put({ scope: 'global' }), privateFile = await file(); await setGoal(global); await bind(global, privateFile.job);
      const globalList = (await gateway.query('select public.clued_record_list($1,$2) v', [globalToken, { level: 'global', record_type: 'task' }])).rows[0].v;
      const masked = globalList.records.find((x) => x.id === global).task_workflow.deliveries[0];
      assert.deepEqual(masked, { deliverable_id: 'report', status: 'unknown', reason: 'delivery_unavailable' });
      assert.equal(JSON.stringify(masked).includes(privateFile.filePath), false);
    });
    await suite.test('two clients: busy registry refuses promptly; changed version never completes old proof', async () => {
      const id = await put(), output = await file(); await setGoal(id); const linked = await bind(id, output.job);
      const locker = await connect(); await locker.query('begin');
      try {
        await locker.query('select id from clued_private.resource_center_artifacts_v1 where id=$1 for update', [output.artifact]);
        const started = Date.now();
        rejected(await call(completeInput(linked)), 'task_completion_digest_conflict');
        assert.ok(Date.now() - started < 5000, 'NOWAIT source qualification cannot invert blocking Storage locks');
        await locker.query("update clued_private.resource_center_artifacts_v1 set provider_file_version='2',version=version+1 where id=$1", [output.artifact]);
        await locker.query('commit');
      } catch (error) { await locker.query('rollback'); throw error; }
      assert.equal((await stored(id)).lifecycle_status, 'active');
      const changed = await read(id); assert.equal(changed.task_workflow.deliveries[0].status, 'stale');
      rejected(await call(completeInput(changed)), 'task_completion_checks_failed');
    });
    await suite.test('Artifact input versions and actual registration receipts invalidate qualifications', async () => {
      const input = await file(), output = await file(), id = await put();
      await setGoal(id, goal({ acceptance_mode: 'owner',
        input_versions: [{ label: 'Exact input artifact', kind: 'artifact', id: input.artifact, version: 1 }] }));
      const linked = await bind(id, output.job);
      const accepted = await call({ action: 'accept', id, base_record_version: linked.record_version, goal_version: linked.task_workflow.goal_version,
        completion_digest: linked.task_workflow.completion.completion_digest, idempotency_key: uuid() });
      assert.equal(accepted.task_workflow.completion.owner_accepted, true);
      const another = await file();
      const otherArtifactReceipt = (await admin.query('select receipt_id from clued_private.resource_center_artifacts_v1 where id=$1', [another.artifact])).rows[0].receipt_id;
      await admin.query('update clued_private.resource_center_artifacts_v1 set receipt_id=$2 where id=$1', [output.artifact, otherArtifactReceipt]);
      const registrationChanged = await read(id);
      assert.equal(registrationChanged.task_workflow.completion.owner_accepted, false);
      assert.equal(registrationChanged.task_workflow.deliveries[0].status, 'stale');
      await admin.query('update clued_private.resource_center_artifacts_v1 set version=version+1 where id=$1', [input.artifact]);
      assert.equal((await read(id)).task_workflow.inputs[0].qualification, 'unknown');
      const revokedId = await put(), revoked = await file(); await setGoal(revokedId); await bind(revokedId, revoked.job);
      await admin.query("update clued_private.resource_center_artifacts_v1 set state='revoked' where id=$1", [revoked.artifact]);
      assert.equal((await read(revokedId)).task_workflow.deliveries[0].status, 'stale');
    });
    await suite.test('Storage read revocation and every deny mask Agent locators without blocking Task updates', async () => {
      const target = await registeredRoot(), client = await approvedClient(target), gateway = await connect();
      await setWorkerGatewayCaller(gateway);
      const marker = 'StorageDenyLocator' + crypto.randomBytes(8).toString('hex');
      const id = await put({ content: marker }), output = await file(); await setGoal(id); await bind(id, output.job);
      const resumed = (await gateway.query('select public.clued_mcp_restore($1,$2) v', [client.token, { context_key: scope }])).rows[0].v;
      const listing = async () => (await gateway.query('select public.clued_record_list($1,$2) v', [client.token,
        { level: 'project', project_id: project, record_type: 'task', limit: 200 }])).rows[0].v.records.find((r) => r.id === id);
      const search = async () => (await gateway.query('select public.clued_mcp_search_context($1,$2) v', [client.token,
        { session_token: resumed.session_token, context_key: scope, query: marker }])).rows[0].v.results.find((r) => r.kind === 'record' && r.id === id);
      const masked = { deliverable_id: 'report', status: 'unknown', reason: 'delivery_unavailable' };
      assert.equal((await listing()).task_workflow.deliveries[0].status, 'verified');
      const mutation = async () => {
        const t = await stored(id);
        return (await gateway.query('select public.clued_record_mutate($1,$2) v', [client.token, {
          operation: 'update', id, base_version: t.version, scope, record_type: 'task', record_schema_version: 1,
          lifecycle_status: 'active', authority: 'observed', confidence_reason: 'Storage denial does not revoke Canonical Task update',
          mutation: { type_fields: { execution_bucket: 'next' } }, idempotency_key: uuid()
        }])).rows[0].v;
      };
      const assertMasked = async () => {
        assert.deepEqual((await listing()).task_workflow.deliveries[0], masked);
        assert.deepEqual((await search()).task_workflow.deliveries[0], masked);
        const changed = await mutation(); assert.equal(changed.status, 'committed', JSON.stringify(changed));
        assert.deepEqual(changed.supplemental.record.task_workflow.deliveries[0], masked);
      };
      const fixtureReceipt = async () => receipt(owner, 'task_storage_deny_fixture', { idempotency_key: uuid() }, scope);
      await admin.query("update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1 and state='active'",
        [target.connection, await fixtureReceipt()]);
      await assertMasked();
      const oldGeneration = Number((await admin.query('select max(read_generation) g from clued_private.storage_read_access_v1 where connection_id=$1', [target.connection])).rows[0].g);
      await admin.query("insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id) values($1,$2,$3,array['read'],$4,'isolated-restored-read-fixture',$5)",
        [owner, target.connection, target.policy, oldGeneration + 1, await fixtureReceipt()]);
      assert.equal((await listing()).task_workflow.deliveries[0].status, 'verified');
      for (const kind of ['class', 'client', 'root']) {
        const deniedReceipt = await fixtureReceipt();
        if (kind === 'class') await admin.query("insert into clued_private.storage_read_client_denies_v1(owner_id,lineage_id,class,receipt_id) values($1,$2,'read',$3)", [owner, client.lineage, deniedReceipt]);
        if (kind === 'client') await admin.query('insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)', [owner, client.lineage, deniedReceipt]);
        if (kind === 'root') await admin.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','synthetic-provider',$2,$3,$4)", [owner, 'root-' + project, client.lineage, deniedReceipt]);
        await assertMasked();
        const clearReceipt = await fixtureReceipt();
        if (kind === 'class') await admin.query("update clued_private.storage_read_client_denies_v1 set denied=false,generation=generation+1,receipt_id=$3 where owner_id=$1 and lineage_id=$2 and class='read'", [owner, client.lineage, clearReceipt]);
        if (kind === 'client') await admin.query('update clued_private.storage_client_denies_v2 set denied=false,generation=generation+1,receipt_id=$3 where owner_id=$1 and lineage_id=$2', [owner, client.lineage, clearReceipt]);
        if (kind === 'root') await admin.query('update clued_private.storage_root_denies_v2 set denied=false,generation=generation+1,receipt_id=$3 where owner_id=$1 and lineage_id=$2', [owner, client.lineage, clearReceipt]);
        assert.equal((await listing()).task_workflow.deliveries[0].status, 'verified');
      }
      // Capability withdrawal removes inspect, regardless of Canonical read.
      await admin.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where lineage_id=$1 and state='active'", [client.lineage, await fixtureReceipt()]);
      await assertMasked();
      // A direct Native Owner still sees their own registered file metadata.
      assert.equal((await read(id)).task_workflow.deliveries[0].status, 'verified');
    });
    await suite.test('sixteen retired delivery IDs reclaim capacity without dropping current-goal bindings', async () => {
      const id = await put(), output = await file();
      const definition = (prefix) => goal({
        deliverables: Array.from({ length: 16 }, (_, i) => ({ id: prefix + i, label: 'Archived output ' + i, required: true })),
        conditions: [{ id: 'archived', kind: 'file_integrity', text: 'Exact persisted report version', deliverable_id: prefix + '0' }]
      });
      await setGoal(id, definition('old_'));
      const bindOne = async (deliverable) => {
        const view = await read(id);
        return call({ action: 'bind_delivery', id, base_record_version: view.record_version,
          goal_version: view.task_workflow.goal_version, deliverable_id: deliverable,
          job_id: output.job, idempotency_key: uuid() });
      };
      for (let i = 0; i < 16; i++) assert.equal((await bindOne('old_' + i)).status, 'committed');
      const before = await stored(id), changed = await setGoal(id, definition('new_'));
      assert.equal(changed.status, 'committed', JSON.stringify(changed));
      assert.equal(changed.task_workflow.delivery_refs.length, 16, 'set_goal retains historical refs');
      assert.equal(changed.task_workflow.completion.eligible, false);
      const rebound = await bindOne('new_0');
      assert.equal(rebound.status, 'committed', JSON.stringify(rebound));
      assert.deepEqual(rebound.task_workflow.delivery_refs.map((r) => r.deliverable_id), ['new_0']);
      const firstRef = rebound.task_workflow.delivery_refs[0];
      for (let i = 1; i < 16; i++) {
        const next = await bindOne('new_' + i);
        assert.equal(next.status, 'committed', JSON.stringify(next));
        assert.equal(next.task_workflow.delivery_refs.length, i + 1);
        assert.deepEqual(next.task_workflow.delivery_refs.find((r) => r.deliverable_id === 'new_0'), firstRef);
      }
      const final = await read(id);
      assert.equal(final.task_workflow.delivery_refs.length, 16);
      assert.equal(final.task_workflow.completion.eligible, true, JSON.stringify(final.task_workflow));
      assert.equal((await call(completeInput(final))).status, 'committed');
      // Reclamation modifies the current definition only, keeping immutable M1
      // Event/Receipt evidence of all prior bindings and their exact Task CAS.
      const historical = (await admin.query('select * from public.clued_audit_receipts where id=$1', [before.receipt_id])).rows[0];
      assert.equal(historical.status, 'committed');
      assert.equal(historical.committed_versions[id], Number(before.version));
      assert.equal(historical.event_ids.length, 1);
    });
    await suite.test('an unavailable old-goal optional attachment cannot block a fresh required Global delivery', async () => {
      const sourceScope = 'project:' + otherProject, target = await registeredRoot();
      const client = await approvedClient(target, ['global', scope, sourceScope]), gateway = await connect();
      await setWorkerGatewayCaller(gateway);
      const required = await file(), optional = await file({ p: otherProject });
      const readyId = await put({ scope: 'global' }), blockedId = await put({ scope: 'global' });
      const definition = (needsAttachment, revised = false) => goal({
        goal: revised ? 'Deliver the revised report; prior attachment is historical' : 'Deliver the report with an optional attachment',
        deliverables: [{ id: 'report', label: 'Required report', required: true },
          { id: 'attachment', label: 'Optional attachment', required: false }],
        conditions: [{ id: 'report_version', kind: 'file_integrity', text: 'Exact required report version', deliverable_id: 'report' },
          ...(needsAttachment ? [{ id: 'attachment_version', kind: 'file_integrity', text: 'Attachment is an explicit condition', deliverable_id: 'attachment' }] : [])]
      });
      for (const [id, needsAttachment] of [[readyId, false], [blockedId, true]]) {
        await setGoal(id, definition(needsAttachment));
        await bind(id, required.job);
        const original = await read(id);
        assert.equal((await call({ action: 'bind_delivery', id, base_record_version: original.record_version,
          goal_version: original.task_workflow.goal_version, deliverable_id: 'attachment', job_id: optional.job,
          idempotency_key: uuid() })).status, 'committed');
        assert.equal((await setGoal(id, definition(needsAttachment, true))).status, 'committed');
        assert.equal((await bind(id, required.job)).status, 'committed');
      }
      await admin.query("delete from clued_private.authorization_entries_v12 where binding_id=$1 and resource_kind='scope' and resource_id=$2", [client.id, sourceScope]);
      await admin.query("update public.clued_projects set lifecycle_status='completed',progress_status='completed' where id=$1", [otherProject]);
      const ready = await read(readyId);
      assert.equal(ready.task_workflow.completion.eligible, true, JSON.stringify(ready.task_workflow));
      const attachment = ready.task_workflow.deliveries.find((d) => d.deliverable_id === 'attachment');
      assert.deepEqual(attachment, { deliverable_id: 'attachment', status: 'unknown', reason: 'delivery_unavailable' });
      assert.notEqual(ready.task_workflow.delivery_refs.find((r) => r.deliverable_id === 'attachment').goal_version,
        ready.task_workflow.goal_version);
      assert.equal((await read(blockedId)).task_workflow.completion.eligible, false,
        'an optional item tied to a file_integrity condition remains mandatory');
      const close = async (id) => {
        const t = await stored(id);
        return (await gateway.query('select public.clued_record_mutate($1,$2) v', [client.token, {
          operation: 'close', id, base_version: t.version, scope: 'global', record_type: 'task', record_schema_version: 1,
          lifecycle_status: 'completed', authority: 'observed', confidence_reason: 'Current required delivery has exact persisted proof',
          mutation: { closure_summary: 'Required report completed; unavailable historical optional attachment is not a condition' },
          idempotency_key: uuid()
        }])).rows[0].v;
      };
      rejected(await close(blockedId), 'task_completion_checks_failed');
      const finished = await close(readyId);
      assert.equal(finished.status, 'committed', JSON.stringify(finished));
      assert.equal((await stored(readyId)).lifecycle_status, 'completed');
      assert.equal((await stored(blockedId)).lifecycle_status, 'active');
      assert.equal((await stored(readyId)).type_fields.task_workflow.delivery_refs.length, 2, 'historical optional ref is retained');
    });
    await suite.test('Global Task cancellation/archive preserve historical refs after source access disappears', async () => {
      const target = await registeredRoot(), client = await approvedClient(target, ['global', scope]), gateway = await connect();
      await setWorkerGatewayCaller(gateway);
      const first = await put({ scope: 'global' }), second = await put({ scope: 'global' }), third = await put({ scope: 'global' });
      const output = await file();
      for (const id of [first, second, third]) { await setGoal(id); await bind(id, output.job); }
      // Existing actual authorization retains Global rights and removes the
      // Project read. No new grant is manufactured by the product code.
      await admin.query("delete from clued_private.authorization_entries_v12 where binding_id=$1 and resource_kind='scope' and resource_id=$2", [client.id, scope]);
      const close = async (id, status) => {
        const t = await stored(id);
        return (await gateway.query('select public.clued_record_mutate($1,$2) v', [client.token, {
          operation: 'close', id, base_version: t.version, scope: 'global', record_type: 'task', record_schema_version: 1,
          lifecycle_status: status, authority: 'observed', confidence_reason: 'Global lifecycle fixture',
          mutation: { closure_summary: 'Close without claiming completed file delivery' }, idempotency_key: uuid()
        }])).rows[0].v;
      };
      assert.equal((await close(first, 'cancelled')).status, 'committed');
      assert.equal((await close(second, 'archived')).status, 'committed');
      rejected(await close(third, 'completed'), 'task_completion_checks_failed');
      const updatedGoal = await setGoal(third, goal({ goal: 'Revised goal retains prior file refs as history' }));
      assert.equal(updatedGoal.status, 'committed', JSON.stringify(updatedGoal));
      // Project closure also makes the file's source unavailable to completion.
      await admin.query("update public.clued_projects set lifecycle_status='completed',progress_status='completed' where id=$1", [project]);
      assert.equal((await close(third, 'cancelled')).status, 'committed', 'source Project closure cannot trap the existing Global Task');
    });
    await suite.test('a proven Native reconnect preserves the original archived Job and rechecks current access', async () => {
      const rp = uuid(), rs = 'project:' + rp;
      const create = { operation: 'create', canonical_project_id: rp, project_schema_version: 2, authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Disposable reconnect Project', source_refs: [],
        source_unavailable_reason: 'Synthetic fixture', idempotency_key: uuid(), mutation: { name: 'Reconnect fixture', progress_status: 'active', aliases: [] } };
      await admin.query('begin');
      try {
        await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
        await admin.query('select clued_private.authorization_writer_lock_fanout_v2($1)', [owner]);
        assert.equal((await admin.query('select clued_private.project_mutation_core_v2($1,null,$2,clued_private.m1_sha256($2)) v', [owner, create])).rows[0].v.status, 'committed');
        await admin.query('commit');
      } catch (error) { await admin.query('rollback'); throw error; }
      decisions.set(rp, await put({ scope: rs, kind: 'decision' }));
      const target = await registeredRoot(rp), output = await file({ p: rp });
      const id = await put({ scope: rs }); await setGoal(id); await bind(id, output.job);
      const client = await approvedClient(target, [rs]), gateway = await connect(); await setWorkerGatewayCaller(gateway);
      const source = (await admin.query('select connection_id,mutation,authority_snapshot_v2 from clued_private.storage_jobs_v1 where job_id=$1', [output.job])).rows[0];
      const saved = (await admin.query('select verified_result_v2,verified_digest_v2,receipt_id from clued_private.resource_center_mutations_v1 where id=$1', [output.intent])).rows[0];
      const next = uuid(), lifecycle = uuid(), requestKey = uuid(), requestDigest = hash(), issuer = hash(), oauth = uuid();
      await allowTestIssuerCredentials(admin);
      await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled,execution_enabled) values($1,$2,'https://reconnect.invalid/storage/google/callback',true,true)", [issuer, 'reconnect-' + next]);
      const refs = [{ kind: 'system', role: 'primary', id: next }];
      const prepare = await receipt(owner, 'storage_owner_reconnect', { idempotency_key: 'storage-owner:' + requestKey,
        request_digest: requestDigest, connection_id: target.connection }, rs, refs);
      const oauthReceipt = await receipt(owner, 'storage_oauth_activate', { idempotency_key: uuid() }, rs, refs);
      const activation = await receipt(owner, 'storage_owner_reconnect_activate', { idempotency_key: 'storage-reconnect-activate:' + lifecycle,
        attempt_id: lifecycle, oauth_receipt_id: oauthReceipt }, rs, refs);
      const decision = await put({ scope: rs, kind: 'decision' }), policy = uuid();
      await admin.query('begin');
      try {
      await admin.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1", [target.policy, activation]);
      await admin.query("update clued_private.storage_connections_v1 set state='revoked',auth_mode='revoked',auth_generation=auth_generation+1,revoked_at=clock_timestamp(),version=version+1 where id=$1", [target.connection]);
      await admin.query("insert into clued_private.storage_connections_v1(id,owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,provider_subject,oauth_client_id,state,credential_version,credential_envelope,receipt_id) values($1,$2,$3,1,$4,1,'google-drive','synthetic-provider',$5,'active',1,'{}',$6)",
        [next, owner, target.profile, decision, 'reconnect-' + next, prepare]);
      await admin.query("insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,activation_receipt_id,state) select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'explicit_restore','reconnect-fixture/1',$3,$4,'active' from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2", [policy, next, prepare, activation]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [next, policy]);
      await admin.query("insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id) values($1,$2,$3,array['read'],1,'reconnect-read-fixture/1',$4)", [owner, next, policy, prepare]);
      await admin.query('commit');
      } catch (error) { await admin.query('rollback'); throw error; }
      await admin.query("insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,state_hash,verifier_envelope,expires_at,status,receipt_id,purpose) values($1,$2,$3,$4,$5,1,$6,'{}',now()+interval '1 hour','completed',$7,'connection')",
        [oauth, next, owner, claims.session_id, issuer, hash(), oauthReceipt]);
      const result = { status: 'completed', receipt_id: activation, connection_id: next, old_connection_id: target.connection, profile_id: target.profile, project_id: rp };
      // Merely sharing the root/profile is insufficient.
      const resolve = async () => (await admin.query('select clued_private.task_goal_delivery_connection_v1($1,$2,false) v', [owner, target.connection])).rows[0].v;
      assert.equal(await resolve(), null);
      await admin.query("insert into clued_private.storage_owner_lifecycle_v1(id,owner_id,session_id,issuer_hash,operation,connection_id,connection_version,profile_id,profile_version,root_folder_id,confirmation,request_key,request_digest,new_connection_id,state,expires_at,receipt_id,result) values($1,$2,$3,$4,'reconnect',$5,1,$6,1,$7,'{}',$8,$9,$10,'completed',now()+interval '1 hour',$11,$12)",
        [lifecycle, owner, claims.session_id, issuer, target.connection, target.profile, 'root-' + rp, requestKey, requestDigest, next, prepare, result]);
      await admin.query('insert into clued_private.storage_owner_connection_hidden_v1(connection_id,owner_id,receipt_id) values($1,$2,$3)', [target.connection, owner, activation]);
      assert.equal(await resolve(), next);
      const view = await read(id), delivery = view.task_workflow.deliveries[0];
      assert.equal(view.task_workflow.completion.eligible, true, JSON.stringify(view));
      assert.deepEqual([delivery.job_id, delivery.connection_id, delivery.source_connection_id, delivery.path, delivery.sha256, delivery.receipt_id],
        [output.job, next, target.connection, output.filePath, output.digest, output.settled]);
      const agentRead = async () => {
        const listing = (await gateway.query('select public.clued_record_list($1,$2::jsonb) v', [client.token, { level: 'project', project_id: rp, record_type: 'task', limit: 200 }])).rows[0].v;
        return listing.records.find(row => row.id === id);
      };
      assert.deepEqual((await agentRead()).task_workflow.deliveries, view.task_workflow.deliveries);
      // A current reconnect endpoint still obeys account-wide stops and policy
      // expiry. Constructing rows here is confined to the disposable database.
      const expirePolicy = async () => {
        const expired = uuid();
        await admin.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1", [policy, activation]);
        await admin.query("insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,activation_receipt_id,state,expires_at) select $2,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation+1,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,activation_receipt_id,'active',clock_timestamp()-interval '1 second' from clued_private.storage_account_policies_v2 where id=$1", [policy, expired]);
        await admin.query('update clued_private.storage_connections_v1 set account_policy_id=$2,auth_generation=auth_generation+1 where id=$1', [next, expired]);
      };
      const cases = [
        ['expired endpoint policy', expirePolicy],
        ['endpoint source decision revoked', "update public.clued_memories set lifecycle_status='revoked',version=version+1 where id=$1", [decision]],
        ['account-wide root stopped', "insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','synthetic-provider',$2,null,$3)", [owner, 'root-' + rp, activation]],
        ['incomplete reconnect', "update clued_private.storage_owner_lifecycle_v1 set state='uncertain' where id=$1", [lifecycle]],
        ['cancelled reconnect', "update clued_private.storage_owner_lifecycle_v1 set result=result||'{\"status\":\"cancelled\"}'::jsonb where id=$1", [lifecycle]],
        ['wrong owner', 'update clued_private.storage_owner_lifecycle_v1 set owner_id=$2 where id=$1', [lifecycle, stranger]],
        ['wrong profile', 'update clued_private.storage_owner_lifecycle_v1 set profile_id=$2 where id=$1', [lifecycle, (await registeredRoot(foreignProject, stranger)).profile]],
        ['wrong root', "update clued_private.storage_owner_lifecycle_v1 set root_folder_id='other-root' where id=$1", [lifecycle]],
        ['wrong profile version', 'update clued_private.storage_owner_lifecycle_v1 set profile_version=profile_version+1 where id=$1', [lifecycle]],
        ['wrong provider subject', "update clued_private.storage_connections_v1 set provider_subject='different-account' where id=$1", [next]],
        ['wrong result identity', "update clued_private.storage_owner_lifecycle_v1 set result=result||jsonb_build_object('old_connection_id',$2::text) where id=$1", [lifecycle, next]],
        ['cycle', "update clued_private.storage_owner_lifecycle_v1 set new_connection_id=connection_id,result=result||jsonb_build_object('connection_id',connection_id) where id=$1", [lifecycle]],
        ['revoked endpoint', "update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),version=version+1 where id=$1", [next]],
        ['hidden endpoint', 'insert into clued_private.storage_owner_connection_hidden_v1(connection_id,owner_id,receipt_id) values($1,$2,$3)', [next, owner, activation]],
        ['revoked current policy', "update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1", [policy, activation]],
        ['corrupt activation receipt', 'update public.clued_audit_receipts set response_hash=$2 where id=$1', [activation, hash()]],
        ['corrupt prepare receipt', 'update public.clued_audit_receipts set response_hash=$2 where id=$1', [prepare, hash()]],
        ['unfinished OAuth', "update clued_private.storage_oauth_attempts_v1 set status='claimed' where id=$1", [oauth]],
        ['corrupt OAuth receipt', 'update public.clued_audit_receipts set response_hash=$2 where id=$1', [oauthReceipt, hash()]],
        ['branch', "insert into clued_private.storage_owner_lifecycle_v1(id,owner_id,session_id,issuer_hash,operation,connection_id,connection_version,profile_id,profile_version,root_folder_id,confirmation,request_key,request_digest,new_connection_id,state,expires_at,receipt_id,result) select $2,owner_id,session_id,issuer_hash,operation,connection_id,connection_version,profile_id,profile_version,root_folder_id,confirmation,$3,request_digest,new_connection_id,state,expires_at,receipt_id,result from clued_private.storage_owner_lifecycle_v1 where id=$1", [lifecycle, uuid(), uuid()]],
      ];
      for (const [label, sql, params] of cases) {
        await admin.query('begin');
        try { if (typeof sql === 'function') await sql(); else await admin.query(sql, params); assert.equal(await resolve(), null, label); }
        finally { await admin.query('rollback'); }
      }
      const access = async () => (await admin.query('select clued_private.task_goal_delivery_storage_read_v1($1,$2,$3,$4) v', [owner, client.id, target.connection, output.job])).rows[0].v;
      assert.equal(await access(), true);
      for (const [label, sql, params] of [
        ['Binding revoked', 'update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1', [client.id]],
        ['read revoked', "update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1", [next, activation]],
        ['explicit client deny', 'insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)', [owner, client.lineage, activation]],
        ['explicit read deny', "insert into clued_private.storage_read_client_denies_v1(owner_id,lineage_id,class,receipt_id) values($1,$2,'read',$3)", [owner, client.lineage, activation]],
        ['explicit root deny', "insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','synthetic-provider',$2,$3,$4)", [owner, 'root-' + rp, client.lineage, activation]],
      ]) {
        await admin.query('begin');
        try { await admin.query(sql, params); assert.equal(await access(), false, label); }
        finally { await admin.query('rollback'); }
      }
      // Reconnect changes no historical bytes, proof, original connection or Receipt.
      assert.deepEqual((await admin.query('select connection_id,mutation,authority_snapshot_v2 from clued_private.storage_jobs_v1 where job_id=$1', [output.job])).rows[0], source);
      assert.deepEqual((await admin.query('select verified_result_v2,verified_digest_v2,receipt_id from clued_private.resource_center_mutations_v1 where id=$1', [output.intent])).rows[0], saved);
      const agentComplete = async () => (await gateway.query('select public.clued_record_mutate($1,$2::jsonb) v', [client.token, {
        operation: 'close', id, base_version: (await stored(id)).version, scope: rs, record_type: 'task', record_schema_version: 1,
        lifecycle_status: 'completed', authority: 'observed', confidence_reason: 'Disposable original proof with current reconnect authorization',
        mutation: { closure_summary: 'Same archived bytes, current reconnect and permissions.' }, idempotency_key: uuid(),
      }])).rows[0].v;
      await admin.query('begin');
      try {
        await admin.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner + ':root-' + rp]);
        const started = Date.now();
        rejected(await agentComplete(), 'task_completion_checks_failed');
        assert.ok(Date.now() - started < 2500, 'busy reconnect root fails closed without an unbounded wait');
      } finally { await admin.query('rollback'); }
      assert.equal((await read(id)).task_workflow.completion.eligible, true, 'a refused completion keeps the original active Task');
      const closed = await agentComplete();
      assert.equal(closed.status, 'committed', JSON.stringify(closed));
    });
    await suite.test('new private state and helpers have RLS/revokes; gateway fixed surface unchanged', async () => {
      for (const table of ['task_goal_delivery_acceptances_v1', 'task_goal_delivery_completion_admissions_v1']) {
        const row = (await admin.query("select relrowsecurity from pg_class where oid=$1::regclass", ['clued_private.' + table])).rows[0];
        assert.equal(row.relrowsecurity, true);
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
          assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') v", [role, 'clued_private.' + table])).rows[0].v, false);
        }
      }
      const functions = (await admin.query("select oid::regprocedure::text signature from pg_proc where pronamespace='clued_private'::regnamespace and proname like 'task_goal_delivery_%'")).rows;
      for (const { signature } of functions) for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_function_privilege($1,$2::regprocedure,'EXECUTE') v", [role, signature])).rows[0].v, false, role + ' ' + signature);
      }
      const definition = (await admin.query("select pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure) d")).rows[0].d;
      assert.ok(definition.indexOf('task_goal_delivery_admit_v1') > definition.indexOf("if v_record.version<>v_base"));
      await assertGatewayCloseoutBoundary(admin);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
