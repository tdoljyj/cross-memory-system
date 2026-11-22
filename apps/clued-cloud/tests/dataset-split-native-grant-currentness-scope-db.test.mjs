import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceApp = path.resolve(process.env.CLUED_SYNTHETIC_SOURCE_APP ?? app);
const { allowRawTestBindings } = await import(pathToFileURL(path.join(sourceApp,'tests/raw-binding-grants-fixture.mjs')));

// Independent Global execution-intent currentness regression. Synthetic
// accounts and a temporary PostgreSQL only; no real grant or production.
const candidateFile = '20261011041300_dataset_split_native_grant_binding_successor_v1.sql';
const repo = path.resolve(app, '../..');
const sourceRepo = path.resolve(sourceApp,'../..');
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const PROJECT = '0597aa60-9b98-4da6-a4ab-63d7705b632f';
const REQUEST = 'af1cabdb-5259-4ca3-94d3-133f1af122c8';
const OLD = '4970e492-d26e-4974-adaa-757b2146b171';
const scope = 'project:' + PROJECT;
const successor = '20261010175022_dataset_split_native_grant_currentness_scope_v1.sql';
const uid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
async function freePort() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}

test('Native Owner validates a Project Task with a registered Global intent through real currentness',
  { timeout: 300000 }, async t => {
  const root = path.resolve(repo, 'work/host-harness/ngcs');
  await fs.mkdir(root, { recursive: true });
  assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
  const dir = await fs.mkdtemp(path.join(root, 'p-'));
  const ownership = { run_id: uid(), root, dir };
  await fs.writeFile(path.join(dir, 'Ownership.json'), JSON.stringify(ownership), { flag: 'wx' });
  const oldTemp = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(oldTemp)) process.env[k] = dir;
  const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'db'), user: 'postgres',
    password: hash(), port: await freePort(), persistent: true, createPostgresUser: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
  let db, proc;
  try {
    await server.initialise(); await server.start(); proc = server.process;
    assert.ok(proc?.pid); db = server.getPgClient('postgres', '127.0.0.1'); await db.connect();
    await db.query("set statement_timeout='10s'");
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrationDir = path.join(sourceApp, 'supabase/migrations');
    const names = (await fs.readdir(migrationDir)).filter(n => n.endsWith('.sql')).sort();
    for (const name of names.filter(n => n !== successor && n !== candidateFile)) {
      try { await db.query(await fs.readFile(path.join(migrationDir, name), 'utf8')); }
      catch (e) { throw new Error('Migration ' + name + ': ' + e.message, { cause: e }); }
    }
    await allowRawTestBindings(db);
    const owner = uid(), other = uid(), token = hash(), sourceId = uid(), intentId = uid();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'scope@example.invalid',now()),($2,'other-scope@example.invalid',now())", [owner, other]);
    const binding = (await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Scope correction fixture',$2,array['context:read','context:write','audit:read'],array['*']) returning id`, [owner, token])).rows[0].id;
    const claims = (sub, role) => ({ sub, role, session_id: 'scope-fixture', aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
    async function call(role, sql, values, sub = owner, inside = false) {
      if (!inside) await db.query('begin');
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify(claims(sub, role))]);
        await db.query('set local role ' + role);
        const v = (await db.query(sql, values)).rows[0].v;
        if (!inside) await db.query('commit'); else await db.query('reset role');
        return v;
      } catch (e) { if (!inside) await db.query('rollback'); throw e; }
    }
    const rpc = (name, input) => call('clued_worker_gateway', 'select public.' + name + '($1,$2) v', [token, input]);
    const native = (name, input, sub = owner, inside = false) => call('authenticated', 'select public.' + name + '($1) v', [input], sub, inside);
    assert.equal((await rpc('clued_project_mutate_v2', { operation: 'create', canonical_project_id: PROJECT,
      project_schema_version: 2, base_version: null, idempotency_key: uid(), mutation: {
        name: 'Synthetic scope fixture', progress_status: 'active', aliases: [] },
      recognition: { confidence: 1, reason: 'Synthetic isolated scope regression.',
        source: 'v2_agent_recognition', source_refs: [] } })).status, 'committed');
    await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Synthetic scope task','Isolated test','project',$3,'task','active',1,'active',$4,
      '{"execution_bucket":"next"}','{}','{}','observed','Synthetic fixture')`, [TASK, owner, PROJECT, scope]);
    const plan = JSON.parse(await fs.readFile(path.join(sourceRepo, 'development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json'), 'utf8'));
    const resources = [...Object.values(plan.targets).map(id => 'record:' + id),
      ...Object.values(plan.owner_anchor_refs).map(r => `record:${r.id}@${r.version}#${r.content_hash}`),
      'repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json'].sort();
    const req = await rpc('clued_owner_request_v1', { action: 'model.dataset_split.bootstrap', scope, task_id: TASK,
      resources, idempotency_key: plan.idempotency_key, suggested_grant: { expires_seconds: 3600, max_uses: 1 } });
    assert.equal(req.status, 'committed');
    await db.query('update clued_private.owner_requests_v1 set id=$1 where id=$2', [REQUEST, req.request.request_id]);
    const issued = await native('clued_owner_grant_confirmation_issue_v1', { request_id: REQUEST, choice: 'once', grantee: 'requester' });
    assert.equal(issued.status, 'issued');
    const old = await native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest });
    assert.equal(old.status, 'committed');
    await db.query('update clued_private.owner_requests_v1 set grant_id=null where id=$1', [REQUEST]);
    await db.query('update clued_private.owner_grants_v1 set id=$1 where id=$2', [OLD, old.grant.grant_id]);
    await db.query('update clued_private.owner_requests_v1 set grant_id=$1 where id=$2', [OLD, REQUEST]);
    // Genuine G6 claim and exact three target resources. This does not alter
    // the predecessor's Global-currentness rejection or grant evidence.
    const ownClaim=await rpc('clued_work_claim_v1',{scope,task_id:TASK,
      holder_label:'Synthetic registered-Global same-Binding holder',
      holder_client:'isolated Node test',holder_session_ref:'scope-correction-'+uid(),
      write_set:Object.values(plan.targets).map(id=>'record:'+id),idempotency_key:'scope-claim-'+uid()});
    assert.equal(ownClaim.status,'committed');


    await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Synthetic Global intent','Only test registration','global','decision','active',1,'active','global',
      $3,'{}','{}','user_explicit','Synthetic fixture')`, [sourceId, owner, {
        rationale: 'Synthetic registered intent', execution_intents: [{ id: intentId, completion_criteria: 'Synthetic scope regression' }] }]);
    await db.query(`update public.clued_memories set type_fields=type_fields || jsonb_build_object('execution_intent',$2::jsonb) where id=$1`,
      [TASK, { id: intentId, source_id: sourceId, source_version: 1, source_scope: 'global' }]);

    const view = () => native('clued_dataset_split_grant_correction_view_v1', { request_id: REQUEST });
    const fence = async scopes => (await db.query('select clued_private.record_currentness_fence($1,$2,$3) v', [owner, TASK, scopes])).rows[0].v;
    const original = (await db.query('select pg_get_functiondef($1::regprocedure) v', ['clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)'])).rows[0].v;
    const successorText = await fs.readFile(path.join(migrationDir, successor), 'utf8');
    await t.test('real predecessor reproduces valid Global intent false rejection', async () => {
      assert.equal((await db.query('select clued_private.execution_intent_error_v2($1,null,$2,type_fields) v from public.clued_memories where id=$2', [owner, TASK])).rows[0].v, null);
      assert.equal(await fence([scope]), 'UNKNOWN'); assert.equal(await fence(['global', scope]), 'CURRENT');
      await assert.rejects(view(), /dataset_split_correction_task_not_current/);
    });
    await t.test('trusted source patch fails closed and changes only Owner read scopes', async () => {
      await db.query('begin');
      try {
        await db.query(original.replace('for update;', 'for update; -- synthetic incompatible source'));
        await assert.rejects(db.query(successorText), /dataset_split_correction_context_source_changed/);
      } finally { await db.query('rollback'); }
      await db.query(successorText);
      const patched = (await db.query('select pg_get_functiondef($1::regprocedure) v', ['clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)'])).rows[0].v;
      assert.equal(patched, original.replace('clued_private.record_currentness_fence(p_owner,m.id,array[s])',
        "clued_private.record_currentness_fence(p_owner,m.id,array['global',s])"));
      await assert.rejects(db.query(successorText), /dataset_split_correction_context_source_changed/);
    });
    // Apply only after the exact 175022 scope-only regression has proved its
    // original source replacement. The new successor must not hide that case.
    await db.query(await fs.readFile(path.join(app,'supabase/migrations',candidateFile),'utf8'));
    await t.test('Native view and issue validate Global source without changing grant resources or usage', async () => {
      const v = await view(); assert.equal(v.status, 'eligible');
      assert.deepEqual(v.confirmation_view.resources, resources);
      assert.equal(v.confirmation_view.grantee.binding_id, binding);
      const issued = await native('clued_dataset_split_grant_correction_issue_v1', { request_id: REQUEST });
      assert.equal(issued.status, 'issued'); assert.equal(issued.confirmation_view.expires_seconds, 3600);
      assert.equal(issued.confirmation_view.max_uses, 1);
      const g = (await db.query('select uses,revoked_at from clued_private.owner_grants_v1 where id=$1', [OLD])).rows[0];
      assert.equal(g.uses, 0); assert.equal(g.revoked_at, null);
      assert.equal((await db.query('select count(*)::int v from clued_private.owner_grants_v1')).rows[0].v, 1);
    });
    await t.test('invalid Global intent sources still deny while original evidence remains intact', async () => {
      const faults = [
        ["update public.clued_memories set lifecycle_status='revoked' where id=$1", [sourceId]],
        ['update public.clued_memories set version=version+1 where id=$1', [sourceId]],
        ["update public.clued_memories set authority='observed' where id=$1", [sourceId]],
        ["update public.clued_memories set type_fields=jsonb_set(type_fields,'{execution_intents}','[]') where id=$1", [sourceId]],
        ['update public.clued_memories set user_id=$2 where id=$1', [sourceId, other]],
      ];
      for (const [sql, values] of faults) {
        await db.query('begin');
        try { await db.query(sql, values); await assert.rejects(native('clued_dataset_split_grant_correction_view_v1', { request_id: REQUEST }, owner, true), /dataset_split_correction_task_not_current/); }
        finally { await db.query('rollback'); }
      }
      await assert.rejects(native('clued_dataset_split_grant_correction_view_v1', { request_id: REQUEST }, other));
      await assert.rejects(call('authenticated', 'select clued_private.dataset_split_grant_correction_context_v1($1,$2) v', [owner, REQUEST]));
      assert.equal(await fence(['global', scope]), 'CURRENT');
      const g = (await db.query('select uses,revoked_at,request_id from clued_private.owner_grants_v1 where id=$1', [OLD])).rows[0];
      assert.equal(g.uses, 0); assert.equal(g.revoked_at, null); assert.equal(g.request_id, REQUEST);
    });
  } finally {
    if (db) await db.end(); await stopCluster(server);
    if (proc) assert.ok(proc.exitCode !== null || proc.signalCode !== null);
    assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
    assert.ok((await fs.realpath(dir)).startsWith(root + path.sep));
    assert.equal((await fs.lstat(dir)).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'Ownership.json'), 'utf8')), ownership);
    await removeTestDirectory(dir);
    for (const [k, v] of Object.entries(oldTemp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
