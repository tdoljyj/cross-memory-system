import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';

const keys = ['projection_refresh', 'storage_refresh', 'storage_recovery', 'storage_unattempted_release',
  'storage_queued_sweep', 'storage_access_digest_backfill', 'storage_staging', 'storage_onboard'];
const idle = Object.fromEntries(keys.map(key => [key, false]));
const sha = value => createHash('sha256').update(value).digest('hex');

const planNodes = node => [node,...(node.Plans ?? []).flatMap(planNodes)];
const probePlan = async (db, key) => (await db.query(
  `explain (analyze, buffers, format json) select ${key} from clued_private.worker_due_flags_v1(statement_timestamp())`
)).rows[0]['QUERY PLAN'][0].Plan;

// A quiet installation still has completed jobs, receipts, files and expired onboarding history.
// Exercise the optimizer's normal cost choices against those real tables and their installed indexes.
async function checkHistoryPlans(t, db, ids) {
  await db.query(`create temporary table due_fixture_ids as select $1::uuid owner,$2::uuid profile,$3::uuid decision,
    $4::uuid receipt,$5::uuid binding,$6::uuid connection,$7::text issuer,$8::text digest`, ids);
  const source = ' from due_fixture_ids cross join generate_series(1,4096) n';
  const seeds = [
    ['storage_jobs_v1', `(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,
      receipt_id,dispatch_outcome) select owner,gen_random_uuid(),connection,binding,receipt,1,digest,'{}',receipt,'{"status":"settled"}'`],
    ['resource_center_mutations_v1', `(user_id,profile_id,request_key,request_sha256,exact_request,authority_request,authority_result,
      authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
      select owner,profile,n::text,digest,'{}','{}','{}',digest,1,decision,'committed',now(),receipt`],
    ['resource_center_artifacts_v1', `(user_id,profile_id,path,provider_file_id,provider_file_version,target_kind,governance_class,source_decision_id,receipt_id)
      select owner,profile,'/due/'||n,'file_'||n,'1','file','ordinary',decision,receipt`],
    ['storage_refresh_attempts_v1', `(id,connection_id,issuer_hash,delegation_version,credential_version,state,expires_at)
      select gen_random_uuid(),connection,issuer,1,1,'committed',now()`],
    ['storage_staging_v1', `(id,owner_id,connection_id,binding_id,destination_path,mime_type,size,sha256,transport,state,reserved_bytes,expires_at)
      select gen_random_uuid(),owner,connection,binding,'/due/file','text/plain',1,digest,'url','expired',1,now()`],
    ['storage_onboard_attempts_v1', `(id,owner_id,session_id,issuer_hash,oauth_attempt_id,connection_id,root_mode,root_name,tracks,
      normal_use_requested,default_refresh_requested,disclosure_version,disclosure_text,disclosure_sha256,expires_at,state)
      select gen_random_uuid(),owner,gen_random_uuid(),issuer,gen_random_uuid(),gen_random_uuid(),'new','Due','["track"]',false,false,
        'clued.storage-onboard-disclosure/1','fixture',digest,now(),'expired'`],
  ];
  await db.query('insert into auth.users(id) select md5(n::text)::uuid from generate_series(1,4096) n');
  await db.query(`insert into clued_private.projection_refresh_jobs(user_id,target_scope,projection_key,target_invalidation_revision,status)
    select md5(n::text)::uuid,'global','global.priority_frontier',1,'completed' from generate_series(1,4096) n`);
  for (const [table, seed] of seeds) await db.query('insert into clued_private.'+table+seed+source);
  await db.query(`insert into public.clued_audit_receipts(user_id,operation,object_type,status,context_key)
    select owner,'other','fixture','committed','global'`+source);
  const large = new Set([...seeds.map(([name])=>name),'projection_refresh_jobs','clued_audit_receipts']);
  for (const table of large) await db.query('analyze '+(table==='clued_audit_receipts' ? 'public.' : 'clued_private.')+table);
  assert.equal((await db.query('show enable_seqscan')).rows[0].enable_seqscan, 'on');
  for (const key of keys) {
    const plan = await probePlan(db, key);
    const scans = planNodes(plan);
    assert.ok(!scans.some(n => n['Node Type']==='Seq Scan' && large.has(n['Relation Name'])), key+' '+JSON.stringify(plan));
    t.diagnostic(`${key}: ${plan['Shared Hit Blocks']} shared hits, ${plan['Shared Read Blocks']} shared reads; ${[...new Set(scans.map(n=>n['Index Name']).filter(Boolean))].join(', ')}`);
  }
}

export async function checkWorkerDue(t, db) {
  const token = randomUUID();
  const proof = sha(token);
  const value = async (sql, args = []) => (await db.query(sql, args)).rows[0].v;
  const gateway = async () => {
    await setWorkerGatewayCaller(db);
    await db.query("select set_config('request.headers',$1,false)", [JSON.stringify({authorization: 'Bearer ' + token})]);
  };
  const call = async () => value('select public.clued_worker_due_v1($1) v', [proof]);
  const writes = () => value(`select sum(n_tup_ins+n_tup_upd+n_tup_del)::text v from pg_stat_xact_user_tables`);
  await t.test('idle Worker gateway call returns exactly eight false flags in a read-only transaction', async () => {
    await db.query('begin read only');
    try {
      await gateway();
      const before = await writes();
      const answer = await call();
      assert.equal(answer.status, 'ok');
      assert.ok(Number.isFinite(Date.parse(answer.observed_at)));
      assert.deepEqual(answer.due, idle);
      assert.equal(await writes(), before);
      assert.equal(await value(`select count(*)::int v from pg_locks
        where pid=pg_backend_pid() and locktype='advisory'`), 0);
      assert.deepEqual((await db.query(`select provolatile,prosecdef from pg_proc
        where oid='public.clued_worker_due_v1(text)'::regprocedure`)).rows, [{provolatile:'s',prosecdef:true}]);
    } finally { await db.query('rollback'); }
  });
  await t.test('gateway-only due access binds the proof to the serving request', async () => {
    for (const role of ['anon','authenticated','service_role','clued_p5_gateway']) {
      assert.equal(await value("select has_function_privilege($1,'public.clued_worker_due_v1(text)','execute') v", [role]), false);
    }
    await gateway();
    try {
      await assert.rejects(value("select public.clued_worker_due_v1($1) v", [sha('other')]), {code:'42501'});
    } finally { await db.query('reset role'); }
  });
  await allowRawTestBindings(db);
  await allowTestIssuerCredentials(db);
  const user = randomUUID(), builder = randomUUID(), builderProof = sha(builder), issuer = sha(randomUUID());
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'worker-due@example.invalid',now())", [user]);
  await db.query(`insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,$2,'system','fixture builder',$3,array['context:read'],array['*'])`, [builder,user,builderProof]);
  await db.query(`insert into clued_private.projection_builder_grants(binding_id,user_id,target_scope,projection_key,granted_by)
    values($1,$2,'global','global.priority_frontier','fixture')`, [builder,user]);
  await db.query(`insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled)
    values($1,'worker-due-fixture','https://fixture.invalid/storage/google/callback',true)`, [issuer]);
  const checkIdleSweeps = async () => {
    await gateway();
    try {
      assert.deepEqual((await call()).due, idle);
      const cases = [
        ['clued_mcp_projection_refresh_claim', builderProof, {}, {status:'idle'}],
        ['clued_storage_refresh_worker_v1', issuer, {action:'due_demand'}, {connections:[],pending_expired:0}],
        ['clued_storage_scheduled_recovery_v2', issuer, {action:'due'}, {jobs:[]}],
        ['clued_storage_release_unattempted_v1', issuer, {action:'release'}, {released:0}],
        ['clued_storage_queued_sweep_v1', issuer, {action:'due',dispatch:true}, {jobs:[],settled:0,root_busy:0}],
        ['clued_storage_access_digest_backfill_v1', issuer, {action:'due'}, {directories:[]}],
        ['clued_storage_staging_v1', issuer, {action:'sweep'}, {expired:0,stalled:0,cancelled_jobs:0,purged:0,delete:[]}],
        ['clued_storage_onboard_sweep_v1', issuer, undefined, {expired:0}],
      ];
      for (const [name, credential, input, expected] of cases) {
        const args = input === undefined ? [credential] : name === 'clued_storage_staging_v1' ? [credential,null,input] : [credential,input];
        const result = await value(`select public.${name}(${args.map((_,i) => '$'+(i+1)).join(',')}) v`, args);
        assert.equal(result.status,expected.status ?? 'ok',name);
        for (const [field,expectedValue] of Object.entries(expected)) assert.deepEqual(result[field], expectedValue, name+'.'+field);
      }
    } finally { await db.query('reset role'); }
  };
  await t.test('each false flag implies its authenticated sweep returns zero work', checkIdleSweeps);
  await t.test('eight independent work queues turn on and clear on real rows', async t => {
    await db.query('begin');
    try {
      const project = randomUUID(), decision = randomUUID(), profile = randomUUID(), connection = randomUUID();
      await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
        values($1::uuid,$2,'Due','due','project:'||$1::uuid::text,'confirmed',now())`, [project,user]);
      await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason,content_hash)
        values($1,$2,'Due fixture','Due fixture','project',$3::uuid,'decision','active',1,'active','project:'||$3::uuid::text,
          '{"rationale":"fixture"}','{}','{}','user_explicit','fixture',$4)`, [decision,user,project,proof]);
      const receipt = await value(`insert into public.clued_audit_receipts(user_id,operation,object_type,status,context_key,created_at)
        values($1,'storage_provider_attempt','fixture','committed','global',now()-interval '1 minute') returning id v`, [user]);
      await db.query(`insert into clued_private.resource_center_profiles_v1(id,user_id,project_id,profile_version,policy_version,
        managed_root,root_folder_id,root_parent_id,source_decision_id,receipt_id)
        values($1,$2,$3,'1','clued.resource-center-mutation-policy/1','/due','due','parent',$4,$5)`, [profile,user,project,decision,receipt]);
      await db.query(`insert into clued_private.storage_connections_v1(id,owner_id,profile_id,profile_version,source_decision_id,
        decision_version,provider,provider_subject,oauth_client_id,state,auth_mode,credential_version,credential_envelope,receipt_id)
        values($1,$2,$3,1,$4,1,'google-drive','fixture','worker-due-fixture','active','account_policy',1,
          '{"contract":"clued.storage-credential/1","key_id":"test","nonce":"0123456789abcdef","ciphertext":"0123456789abcdefghijklmnop"}',$5)`,
      [connection,user,profile,decision,receipt]);
      const writer = await value(`with authority as (
        insert into clued_private.resource_center_bindings_v1(user_id,profile_id,token_hash,expires_at,source_decision_id,receipt_id)
        values($1,$2,$3,now()+interval '1 hour',$4,$5) returning id)
        insert into clued_private.resource_center_writer_bindings_v1(authority_binding_id,token_hash,expires_at,source_decision_id,receipt_id)
        select id,$6,now()+interval '1 hour',$4,$5 from authority returning id v`,
      [user,profile,sha(randomUUID()),decision,receipt,sha(randomUUID())]);
      await db.query('delete from clued_private.projection_refresh_jobs where user_id=$1', [user]);
      const projection = (status, lease = false) => db.query(`insert into clued_private.projection_refresh_jobs(user_id,target_scope,
        projection_key,target_invalidation_revision,status,lease_id,lease_expires_at)
        values($1,'global','global.priority_frontier',1,$2,$3,now()-interval '1 second')`, [user,status,lease ? randomUUID() : null]);
      const journal = async attempted => value(`insert into clued_private.resource_center_mutations_v1(user_id,profile_id,writer_binding_id,
        request_key,request_sha256,exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,
        state,expires_at,receipt_id,provider_attempt,provider_attempt_receipt_id)
        values($1,$2,$3,'fixture',$4,'{}','{}','{}',$4,1,$5,'started',now()-interval '2 minutes',$6,$7,$8) returning id v`,
      [user,profile,writer,proof,decision,receipt,attempted ? {} : null,attempted ? receipt : null]);
      const job = (intent = null, mutation = {operation:'create',target_kind:'file'}) => db.query(`insert into clued_private.storage_jobs_v1
        (owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,intent_id,receipt_id,
         cloud_writer_binding_id,authority_snapshot_v2,created_at) values($1,gen_random_uuid(),$2,$3,$4,1,$5,$6,$7,$4,$8,'{}',now()-interval '13 hours')`,
      [user,connection,builder,receipt,proof,mutation,intent,writer]);
      const cases = [
        ['projection_refresh', () => projection('queued')],
        ['projection_refresh', () => projection('retry_wait')],
        ['projection_refresh', () => projection('running', true)],
        ['storage_refresh', () => db.query(`insert into clued_private.storage_refresh_delegations_v1
          (connection_id,issuer_hash,enabled,receipt_id) values($1,$2,true,$3)`, [connection,issuer,receipt])],
        ['storage_recovery', async () => { await job(await journal(true)); }],
        ['storage_unattempted_release', async () => { await job(await journal(false)); }],
        ['storage_queued_sweep', () => job()],
        ['storage_access_digest_backfill', () => db.query(`insert into clued_private.resource_center_artifacts_v1
          (user_id,profile_id,path,provider_file_id,provider_file_version,target_kind,governance_class,source_decision_id,receipt_id)
          values($1,$2,'/due/child','child','1','directory','ordinary',$3,$4)`, [user,profile,decision,receipt])],
        ['storage_staging', () => db.query(`insert into clued_private.storage_staging_v1(id,owner_id,connection_id,binding_id,destination_path,
          mime_type,size,sha256,transport,reserved_bytes,expires_at)
          values(gen_random_uuid(),$1,$2,$3,'/due/file','text/plain',1,$4,'url',1,now())`, [user,connection,builder,proof])],
        ['storage_onboard', () => db.query(`insert into clued_private.storage_onboard_attempts_v1(id,owner_id,session_id,issuer_hash,
          oauth_attempt_id,connection_id,root_mode,root_name,tracks,normal_use_requested,default_refresh_requested,disclosure_version,
          disclosure_text,disclosure_sha256,expires_at) values(gen_random_uuid(),$1,gen_random_uuid(),$2,gen_random_uuid(),
          gen_random_uuid(),'new','Due','["fixture"]',false,false,'clued.storage-onboard-disclosure/1','fixture',$3,now())`, [user,issuer,proof])],
      ];
      const flags = async () => {
        await gateway();
        try { return (await call()).due; } finally { await db.query('reset role'); }
      };
      for (const [key,insert] of cases) {
        await t.test(key, async () => {
          await db.query('savepoint candidate');
          try {
            await insert();
            assert.deepEqual(await flags(), {...idle,[key]:true});
          } finally { await db.query('rollback to candidate'); }
          assert.deepEqual(await flags(), idle);
        });
      }
      await t.test('secondary queues can wake maintenance without a primary candidate', async () => {
        await db.query('savepoint secondary');
        try {
          await db.query(`insert into clued_private.storage_refresh_attempts_v1(id,connection_id,issuer_hash,delegation_version,
            credential_version,state,expires_at) values(gen_random_uuid(),$1,$2,1,1,'claimed',now())`, [connection,issuer]);
          assert.equal((await flags()).storage_refresh,true);
          await db.query('rollback to secondary');
          const intent = await journal(false);
          await db.query(`insert into clued_private.storage_conflict_isolations_v1(intent_id,user_id,profile_id,connection_id,job_id,
            root_folder_id,paths,subtree_paths,object_ids,ancestor_ids,slots,scope_complete,original_state,original_version,
            original_receipt_id,close_receipt_id,closed_version,next_recovery_at)
            values($1,$2,$3,$4,gen_random_uuid(),'due','{}','{}','{}','{}','[]',true,'started',1,$5,$5,2,now())`,
          [intent,user,profile,connection,receipt]);
          assert.equal((await flags()).storage_recovery,true);
          await db.query('rollback to secondary');
          await job(null, {operation:'create', content_ref:'synthetic'});
          assert.equal((await flags()).storage_staging,true, 'an abandoned binary job can be the only staging work');
        } finally { await db.query('rollback to secondary'); }
      });
      await t.test('observed credentials wait for keepalive or imminent demand from a recent job', async () => {
        await db.query('savepoint renewal');
        try {
          await db.query(`insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id)
            values($1,$2,true,$3)`, [connection,issuer,receipt]);
          await db.query(`insert into clued_private.storage_refresh_activity_v1(connection_id,credential_version,credential_expires_at)
            values($1,1,now()+interval '3 minutes')`, [connection]);
          assert.deepEqual(await flags(),idle);
          await db.query("update clued_private.storage_refresh_activity_v1 set keepalive_anchor_at=now()-interval '31 days'");
          assert.equal((await flags()).storage_refresh,true);
          await db.query('update clued_private.storage_refresh_activity_v1 set last_successful_exchange_at=now()');
          await job();
          assert.equal((await flags()).storage_refresh,false);
          await db.query('update clued_private.storage_jobs_v1 set created_at=now() where connection_id=$1', [connection]);
          assert.equal((await flags()).storage_refresh,true);
        } finally { await db.query('rollback to renewal'); }
      });
      await t.test('the optimizer avoids sequential scans of large queues at idle', async t => {
        await checkHistoryPlans(t, db, [user,profile,decision,receipt,builder,connection,issuer,proof]);
        await checkIdleSweeps();
      });
    } finally { await db.query('rollback'); }
  });
  await t.test('each due probe has a partial-index plan', async () => {
    await db.query('begin');
    try {
      // On an empty cluster the planner prefers scanning a single heap page. Check
      // index eligibility even for rare branches that have no rows in the fixture.
      await db.query('set local enable_seqscan=off; set local jit=off');
      for (const key of keys) {
        const plan = await probePlan(db, key);
        const scans = planNodes(plan);
        const indexes = scans.map(node => node['Index Name']).filter(Boolean);
        assert.ok(indexes.length > 0 && await value(`select exists(select from pg_index i join pg_class c on c.oid=i.indexrelid
          where c.relname=any($1) and i.indpred is not null) v`, [indexes]), key+' '+JSON.stringify(plan));
        assert.ok(!scans.some(node => node['Node Type']==='Seq Scan'), key+' '+JSON.stringify(plan));
      }
    } finally { await db.query('rollback'); }
  });
  await t.test('watchdog builder service follows the tenant and exact active grant with no heartbeat', async () => {
    await db.query(`insert into clued_private.projection_invalidation_heads(user_id,target_scope,projection_key,invalidation_revision)
      select $1,'global',k,1 from unnest(array['global.priority_frontier','global.__aggregate__']) k
      on conflict do nothing`, [user]);
    const served = async () => {
      const snapshot = await value('select clued_watchdog.projection_watchdog_snapshot() v');
      assert.equal(snapshot.heartbeat, null);
      return Object.fromEntries(snapshot.projections.filter(row => row.tenant_key===sha(user)).map(row => [row.projection_key,row.builder_served]));
    };
    assert.deepEqual(await served(), {'global.priority_frontier':true,'global.__aggregate__':false});
    await db.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [builder]);
    assert.deepEqual(await served(), {'global.priority_frontier':false,'global.__aggregate__':false});
  });
}
