import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';

// Independent claim-helper regression, using real authorization, intent and
// work-claim functions in a temporary database. No fixed Owner-chain substitute,
// production data, Native approval, or successful full Bootstrap is claimed.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(app, '../..');
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const PROJECT = '0597aa60-9b98-4da6-a4ab-63d7705b632f';
const scope = 'project:' + PROJECT;
const successor = '20261011005439_model_domain_bootstrap_claim_currentness_scope_v1.sql';
const signature = 'clued_private.model_domain_bootstrap_claim_candidate(text,public.clued_agent_bindings,uuid[])';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Bootstrap claim admits a Global intent only with the same Binding actual Global read authority',
  { timeout: 300000 }, async t => {
  const root = path.resolve(repo, 'work/host-harness/model-bootstrap-claim-currentness-scope');
  await fs.mkdir(root, { recursive: true });
  assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
  const directory = await fs.mkdtemp(path.join(root, 'claim-scope-'));
  const ownership = { run_id: uuid(), root, directory };
  await fs.writeFile(path.join(directory, 'Ownership.json'), JSON.stringify(ownership), { flag: 'wx' });
  const oldTemp = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(oldTemp)) process.env[key] = directory;
  const server = new EmbeddedPostgres({ databaseDir: path.join(directory, 'database'), user: 'postgres',
    password: hash(), port: await freePort(), persistent: true, createPostgresUser: false,
    postgresFlags: ['-c', 'io_method=sync', '-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
  let db, child;
  try {
    await server.initialise(); await server.start(); child = server.process;
    assert.ok(child?.pid);
    db = server.getPgClient('postgres', '127.0.0.1'); await db.connect();
    await db.query("set statement_timeout='10s'");
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrationDir = path.join(app, 'supabase/migrations');
    const names = (await fs.readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
    assert.ok(names.includes(successor));
    for (const name of names.filter(name => name !== successor)) {
      try { await db.query(await fs.readFile(path.join(migrationDir, name), 'utf8')); }
      catch (error) { throw new Error('Migration ' + name + ': ' + error.message, { cause: error }); }
    }
    await allowRawTestBindings(db);
    await allowTestIssuerCredentials(db);
    const owner = uuid(), foreignOwner = uuid(), token = hash(), otherToken = hash(), foreignToken = hash();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'claim-scope@example.invalid',now()),($2,'foreign-claim-scope@example.invalid',now())", [owner, foreignOwner]);
    async function bindingFor(user, credential) {
      return (await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','Independent claim-scope fixture',$2,array['context:read','context:write','audit:read'],array['*']) returning id`, [user, credential])).rows[0].id;
    }
    const binding = await bindingFor(owner, token);
    const otherBinding = await bindingFor(owner, otherToken);
    const foreignBinding = await bindingFor(foreignOwner, foreignToken);
    async function rpc(name, input, credential = token) {
      await db.query('begin');
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
          [owner, JSON.stringify({ sub: owner, role: 'clued_worker_gateway' })]);
        await db.query('set local role clued_worker_gateway');
        const result = (await db.query('select public.' + name + '($1,$2) v', [credential, input])).rows[0].v;
        await db.query('commit'); return result;
      } catch (error) { await db.query('rollback'); throw error; }
    }
    assert.equal((await rpc('clued_project_mutate_v2', { operation: 'create', canonical_project_id: PROJECT,
      project_schema_version: 2, base_version: null, idempotency_key: uuid(), mutation: {
        name: 'Independent synthetic claim-scope fixture', progress_status: 'active', aliases: [] },
      recognition: { confidence: 1, reason: 'Synthetic isolated regression.',
        source: 'v2_agent_recognition', source_refs: [] } })).status, 'committed');
    await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Synthetic Bootstrap claim task','Isolated helper regression','project',$3,'task','active',1,'active',$4,
      '{"execution_bucket":"next"}','{}','{}','observed','Synthetic isolated fixture')`, [TASK, owner, PROJECT, scope]);
    const plan = JSON.parse(await fs.readFile(path.join(repo, 'development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json'), 'utf8'));
    const targets = Object.values(plan.targets);
    const ownClaim = await rpc('clued_work_claim_v1', { scope, task_id: TASK,
      holder_label: 'Independent synthetic claim-scope regression', holder_client: 'isolated Node test',
      holder_session_ref: 'claim-scope-' + uuid(), write_set: targets.map(id => 'record:' + id),
      idempotency_key: 'claim-scope-' + uuid() });
    assert.equal(ownClaim.status, 'committed', JSON.stringify(ownClaim));
    const claimId = ownClaim.claim.claim_id;

    // Actual v12 rows are synthetic fixture inputs, not mocked authorization.
    // Keeping Project read/write independently lets Global-entry denials reach
    // the new Global guard after the real work verifier admits the same claim.
    const issuer = hash(), requestId = uuid();
    await db.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
      values($1,'https://synthetic.example.invalid','Independent synthetic fixture')`, [issuer]);
    await db.query(`insert into clued_private.authorization_requests_v12(id,owner_id,issuer_hash,request_digest,
      client_id,client_name,redirect_uri,resource,requested_scopes,eligible,status,binding_id)
      values($1,$2,$3,$4,'synthetic-claim-scope','Synthetic fixture','https://synthetic.example.invalid/callback',
        'https://synthetic.example.invalid',array['context:read','context:write'],'{}','approved',$5)`, [requestId, owner, issuer, hash(), binding]);
    await db.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
      values($1,$2,$3,'synthetic-claim-scope','Synthetic fixture','https://synthetic.example.invalid',now()+interval '2 hours')`, [binding, requestId, owner]);
    await db.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope',$2,'canonical',array['read','write']),($1,'scope','global','canonical',array['read'])`, [binding, scope]);
    await db.query('delete from clued_private.raw_binding_grants_v1 where binding_id=$1', [binding]);
    const globalSource = uuid(), globalIntent = uuid(), projectSource = uuid(), projectIntent = uuid();
    async function intentSource(id, intent, sourceScope) {
      await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
        values($1,$2,'Synthetic registered intent','Only isolated currentness regression',$3,$4,'decision','active',1,'active',$5,
          $6,'{}','{}','user_explicit','Synthetic isolated fixture')`,
      [id, owner, sourceScope === 'global' ? 'global' : 'project', sourceScope === 'global' ? null : PROJECT, sourceScope,
        { rationale: 'Synthetic registered execution intent', execution_intents: [{ id: intent, completion_criteria: 'Independent claim-scope regression' }] }]);
    }
    await intentSource(globalSource, globalIntent, 'global');
    await intentSource(projectSource, projectIntent, scope);
    const globalRef = { id: globalIntent, source_id: globalSource, source_version: 1, source_scope: 'global' };
    const projectRef = { id: projectIntent, source_id: projectSource, source_version: 1, source_scope: scope };
    async function taskIntent(value) {
      await db.query("update public.clued_memories set type_fields=(type_fields-'execution_intent') || jsonb_build_object('execution_intent',$2::jsonb) where id=$1", [TASK, value]);
    }
    const helper = async (credential = token, bindingId = binding, ids = targets) =>
      (await db.query(`select clued_private.model_domain_bootstrap_claim_candidate($1,b,$3::uuid[]) v
        from public.clued_agent_bindings b where b.id=$2`, [credential, bindingId, ids])).rows[0].v;
    const verify = async () => (await db.query('select public.clued_work_verify_v1($1,$2) v',
      [token, { scope, claim_id: claimId, changed_paths: targets.map(id => 'record:' + id) }])).rows[0].v;
    const fence = async scopes => (await db.query('select clued_private.record_currentness_fence($1,$2,$3) v', [owner, TASK, scopes])).rows[0].v;
    const definition = async sig => (await db.query('select pg_get_functiondef($1::regprocedure) v', [sig])).rows[0].v;
    const acl = async () => (await db.query(`select proowner::text owner,proacl::text acl,prosecdef security_definer,proconfig
      from pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
    const original = await definition(signature), originalAcl = await acl();
    const originalCommit = await definition('public.clued_model_dataset_split_bootstrap_commit_candidate(text,jsonb)');
    const successorText = await fs.readFile(path.join(migrationDir, successor), 'utf8');
    const noEffects = async () => {
      assert.equal((await db.query('select count(*)::int n from public.clued_memories where id=any($1::uuid[])', [targets])).rows[0].n, 0);
      assert.equal((await db.query('select count(*)::int n from clued_private.owner_grants_v1')).rows[0].n, 0);
    };
    async function fault(name, setup, operation, pattern) {
      await t.test(name, async () => {
        await db.query('begin');
        try { await setup(); await assert.rejects(operation(), pattern); }
        finally { await db.query('rollback'); }
        await noEffects();
      });
    }
    // An intent ID is immutable once assigned. Exercise these valid initial
    // states before registering the Global intent, applying the real patch
    // inside each rolled-back transaction rather than disabling that guard.
    for (const [name, value] of [['Project intent', projectRef], ['no Global intent', null]]) {
      await t.test(name + ' keeps original Project-only behavior without Global read', async () => {
        await db.query('begin');
        try {
          await db.query("delete from clued_private.authorization_entries_v12 where binding_id=$1 and resource_id='global'", [binding]);
          if (value) await taskIntent(value);
          assert.equal(await fence([scope]), 'CURRENT');
          const expected = { claim_id: claimId, fence: ownClaim.claim.fence };
          assert.deepEqual(await helper(), expected);
          await db.query(successorText);
          assert.deepEqual(await helper(), expected);
        } finally { await db.query('rollback'); }
      });
    }
    await taskIntent(globalRef);
    await t.test('real registered Global intent and admitted claim reproduce predecessor rejection', async () => {
      assert.equal(digest(original), '7d3f10d850da7288ee206acbd3363507321be00ce9ccb508e0c4a0280d802603');
      assert.equal((await db.query('select clued_private.execution_intent_error_v2($1,null,$2,type_fields) v from public.clued_memories where id=$2', [owner, TASK])).rows[0].v, null);
      assert.equal((await verify()).verdict, 'ADMITTED');
      assert.equal(await fence([scope]), 'UNKNOWN');
      assert.equal(await fence(['global', scope]), 'CURRENT');
      await assert.rejects(helper(), /BOOTSTRAP_TASK_NOT_CURRENT_ACTIVE/);
    });
    await fault('trusted complete helper digest refuses source drift',
      () => db.query(original.replace('paths jsonb;', 'paths jsonb; -- synthetic incompatible source')),
      () => db.query(successorText), /BOOTSTRAP_CLAIM_CONTEXT_SOURCE_CHANGED/);
    await t.test('successor admits actual Global read and preserves private ACL and atomic writer', async () => {
      await db.query(successorText);
      assert.deepEqual(await helper(), { claim_id: claimId, fence: ownClaim.claim.fence });
      assert.deepEqual(await acl(), originalAcl);
      assert.equal(await definition('public.clued_model_dataset_split_bootstrap_commit_candidate(text,jsonb)'), originalCommit);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, signature])).rows[0].v, false);
      }
      await assert.rejects(db.query(successorText), /BOOTSTRAP_CLAIM_CONTEXT_SOURCE_CHANGED/);
      await noEffects();
    });
    await fault('withdrawn Global read is denied after Project work verification still admits', async () => {
      await db.query("delete from clued_private.authorization_entries_v12 where binding_id=$1 and resource_id='global'", [binding]);
      assert.equal((await verify()).verdict, 'ADMITTED');
    }, helper, /resource_action_not_authorized/);
    await fault('Global write without Global read grants no authority to read intent', async () => {
      await db.query("update clued_private.authorization_entries_v12 set actions=array['write'] where binding_id=$1 and resource_id='global'", [binding]);
      assert.equal((await verify()).verdict, 'ADMITTED');
    }, helper, /resource_action_not_authorized/);
    await fault('wildcard context key plus Project-only raw grant does not authorize Global', async () => {
      await db.query('delete from clued_private.authorizations_v12 where binding_id=$1', [binding]);
      await db.query(`insert into clued_private.raw_binding_grants_v1(binding_id,context_key,actions,reason)
        values($1,$2,array['read','write'],'Narrow synthetic Project-only grant')`, [binding, scope]);
      assert.equal((await verify()).verdict, 'ADMITTED');
    }, helper, /resource_action_not_authorized/);
    await fault('revoked connection authorization remains denied',
      () => db.query('update clued_private.authorizations_v12 set revoked_at=clock_timestamp() where binding_id=$1', [binding]),
      helper, /authorization_revoked_or_expired/);
    await fault('expired connection authorization remains denied',
      () => db.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [binding]),
      helper, /authorization_revoked_or_expired/);
    await fault('missing coarse context read remains denied',
      () => db.query("update public.clued_agent_bindings set scopes=array['context:write'] where id=$1", [binding]),
      helper, /binding_not_authorized/);
    await t.test('same Owner other token cannot stand in for the claim holder Binding', async () => {
      await assert.rejects(helper(otherToken), /BOOTSTRAP_GLOBAL_READ_BINDING_MISMATCH/);
      await assert.rejects(helper(token, otherBinding), /BOOTSTRAP_CURRENT_OWN_TASK_CLAIM_REQUIRED/);
      await assert.rejects(helper(foreignToken), /BOOTSTRAP_TASK_FENCE_OR_WRITE_SET_NOT_ADMITTED/);
      await assert.rejects(helper(foreignToken, foreignBinding), /BOOTSTRAP_CURRENT_OWN_TASK_CLAIM_REQUIRED/);
      await noEffects();
    });
    for (const [name, sql, values] of [
      ['revoked source', "update public.clued_memories set lifecycle_status='revoked' where id=$1", [globalSource]],
      ['stale source version', 'update public.clued_memories set version=version+1 where id=$1', [globalSource]],
      ['nonexplicit source', "update public.clued_memories set authority='observed' where id=$1", [globalSource]],
      ['unregistered intent', "update public.clued_memories set type_fields=jsonb_set(type_fields,'{execution_intents}','[]') where id=$1", [globalSource]],
      ['foreign Owner source', 'update public.clued_memories set user_id=$2 where id=$1', [globalSource, foreignOwner]],
    ]) await fault(name + ' remains rejected by real currentness', () => db.query(sql, values), helper, /BOOTSTRAP_TASK_NOT_CURRENT_ACTIVE/);
    await fault('unknown intent scope never enters permitted scopes',
      () => taskIntent({ ...globalRef, source_scope: 'project:' + uuid() }), helper, /BOOTSTRAP_TASK_NOT_CURRENT_ACTIVE/);
    for (const [name, sql, values] of [
      ['expired claim', "update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where claim_id=$1", [claimId]],
      ['draining claim', "update clued_private.work_claims_v1 set status='DRAINING' where claim_id=$1", [claimId]],
      ['wrong claim holder', 'update clued_private.work_claims_v1 set holder_binding_id=$2 where claim_id=$1', [claimId, otherBinding]],
      ['expired hard deadline', "update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '3 hours',expires_at=clock_timestamp()-interval '2 hours',hard_deadline_at=clock_timestamp()-interval '1 hour' where claim_id=$1", [claimId]],
    ]) await fault(name + ' is rejected before scope repair', () => db.query(sql, values), helper, /BOOTSTRAP_CURRENT_OWN_TASK_CLAIM_REQUIRED/);
    await fault('missing any one of the three record write paths remains inadmissible',
      () => db.query('update clued_private.work_claims_v1 set write_set=$2::text[] where claim_id=$1', [claimId, targets.slice(0, 2).map(id => 'record:' + id)]),
      helper, /BOOTSTRAP_TASK_FENCE_OR_WRITE_SET_NOT_ADMITTED/);
    await t.test('three-target and existing write-set requirements are preserved', async () => {
      await assert.rejects(helper(token, binding, targets.slice(0, 2)), /BOOTSTRAP_THREE_TARGETS_REQUIRED/);
      await assert.rejects(helper(token, binding, [targets[0], targets[1], uuid()]), /BOOTSTRAP_TASK_FENCE_OR_WRITE_SET_NOT_ADMITTED/);
      assert.deepEqual(await helper(), { claim_id: claimId, fence: ownClaim.claim.fence });
      await noEffects();
    });
  } finally {
    if (db) await db.end(); await stopCluster(server);
    child ??= server.process;
    if (child) assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
    assert.ok((await fs.realpath(directory)).startsWith(root + path.sep));
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'Ownership.json'), 'utf8')), ownership);
    await removeTestDirectory(directory);
    for (const [key, value] of Object.entries(oldTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
