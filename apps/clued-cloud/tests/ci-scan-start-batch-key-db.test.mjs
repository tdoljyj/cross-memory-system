// Task dcc53013: with Native scan-start required (NATIVE_SCAN_START_REQUIRED=true), every scanner batch of a head
// must get its own one-time launch permission. Before 20261108090000 the K was (repository, head, role), so a
// merge-train front batch (H, S) and an automatic attempt 2 found the K of an earlier batch of H already burned
// (scan_start_already_consumed) and could never start. End to end: the real controller port
// (scan-start-v1/native-port.mjs) asks the real Native command door of an isolated database through this Source,
// and the adapter's own permission check (scanStartPermission in Native mode) accepts what comes back.
// Review of the fix: S is not a fact Native can verify, so the distinct tested commits per (head, role) are capped;
// the grant names S and attempt and the controller compares both; legacy K rows are carried over as S = H, attempt 1.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {workerGatewayRpc,setWorkerGatewayCaller} from './worker-gateway-caller-fixture.mjs';
import {makeJobV2} from '../../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import {createIndependentScanStartPort} from '../../../work/actions-hosted-migration/independent-ci-v1/src/scan-start-v1/native-port.mjs';
import {validateScanStartGrant,noteScanStartResponseWindow,scanStartPermission} from '../../../work/actions-hosted-migration/independent-ci-v1/src/scan-start-v1/grant.mjs';
import {admittedFacts} from '../../../work/actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MIGRATION='20261108090000_ci_scan_start_batch_key_v1.sql';
const FRONT_LIMIT=16; // distinct tested commits S != H per (repository, head, role), as in MIGRATION
const ORIGINAL_SQL_SHA256='04d17351c8dca3f2d83acd193c21de23f4caff214c3d013bfa014363caad18b2';
const BODY_TAG='$ci_scan_batch_key_sql_20261108090000$';
const uuid=()=>crypto.randomUUID();
const digest=(s='fixture')=>crypto.createHash('sha256').update(s).digest('hex');
const sha=(s='fixture')=>crypto.createHash('sha1').update(s).digest('hex');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
// The wire identity the real port sends (scan-start-v1/registry.mjs) and the scope the admitted-facts fixture names.
const repository='tdoljyj/cross-memory-system',repoId=1334673495,pr=888,project='00000000-0000-4000-8000-000000000000',scope='project:'+project;

// One isolated cluster. migrate(filter) applies the sorted migrations the filter accepts.
async function withCluster(prefix,body){
  const parent=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(parent,prefix));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:digest(uuid()),port:await freePort(),persistent:false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(String(m)+'\n');}});
  const clients=[];
  const connect=async(role)=>{const c=server.getPgClient();clients.push(c);await c.connect();if(role)await c.query('set role '+role);return c;};
  const json=async(c,q,args=[])=>(await c.query(q,args)).rows[0].v;
  try{
    await server.initialise();await server.start();const admin=await connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;
      create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort();
    assert.ok(names.includes(MIGRATION));
    const migrate=async filter=>{for(const name of names.filter(filter)){
      try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}
      catch(e){throw new Error(`Migration ${name}: ${e.message}`,{cause:e});}}};
    await body({admin,connect,json,migrate});
  }finally{
    for(const c of clients.reverse())await c.end().catch(()=>{});
    const actual=await fs.realpath(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(actual!==null){assert.equal(actual,dir);assert.equal(path.dirname(actual),parent);}
    await stopCluster(server);
    if(actual!==null)await removeTestDirectory(dir);
  }
}

// Covers every object the migration changes, its temporary patch function, and
// the real pre-existing K rows. No receipt or authority is issued by this read.
async function migrationState(admin){
  const rows=async sql=>(await admin.query(sql)).rows;
  return {
    columns:await rows(`select column_name,data_type,is_nullable,column_default from information_schema.columns
      where table_schema='clued_private' and table_name='ci_scan_start_keys_v1' order by ordinal_position`),
    constraints:await rows(`select conname,pg_get_constraintdef(oid) definition from pg_constraint
      where conrelid='clued_private.ci_scan_start_keys_v1'::regclass order by conname`),
    indexes:await rows(`select indexname,indexdef from pg_indexes where schemaname='clued_private'
      and tablename='ci_scan_start_keys_v1' order by indexname`),
    triggers:await rows(`select tgname,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger
      where tgrelid='clued_private.ci_scan_start_keys_v1'::regclass order by tgname`),
    functions:await rows(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private'
      and (p.proname like 'ci_scan_start_%' or p.proname='ci_scan_batch_key_patch_v1') order by signature`),
    keys:await rows('select to_jsonb(k) k from clued_private.ci_scan_start_keys_v1 k order by execution_id'),
  };
}

async function verifyAtomicEntrypoints(ctx,t){
  const text=await fs.readFile(path.join(root,'supabase/migrations',MIGRATION),'utf8');
  const start=text.indexOf(`execute ${BODY_TAG}\n`)+`execute ${BODY_TAG}\n`.length;
  assert.ok(start>`execute ${BODY_TAG}\n`.length);
  assert.equal(text.split(BODY_TAG).length,3,'one complete inner dollar literal');
  const end=text.indexOf(BODY_TAG,start),original=text.slice(start,end);
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'),ORIGINAL_SQL_SHA256,
    'the complete original pending SQL remains contiguous and unchanged');
  t.diagnostic('actual local PostgreSQL '+(await ctx.admin.query('show server_version')).rows[0].server_version);
  const before=await migrationState(ctx.admin);
  await ctx.admin.query('begin');
  let expected;
  try{await ctx.admin.query(original);expected=await migrationState(ctx.admin);}
  finally{await ctx.admin.query('rollback');}

  await t.test('the original production nested EXECUTE reaches identical DDL, functions, trigger state and K rows',async()=>{
    await ctx.admin.query('begin');
    try{
      await ctx.admin.query("select set_config('clued.migration_text',$1,true)",[text]);
      // Same nested execution boundary as production-schema-drift.mjs and the
      // production release workflow; the migration contains no SQL COMMIT.
      await ctx.admin.query("do $apply$ begin execute current_setting('clued.migration_text'); end $apply$");
      assert.deepEqual(await migrationState(ctx.admin),expected);
    }finally{await ctx.admin.query('rollback');}
  });
  await t.test('an error after carry-over or function patches rolls back all DDL, data and trigger changes',async()=>{
    for(const anchor of [
      'alter table clued_private.ci_scan_start_keys_v1 enable trigger ci_scan_start_no_update_delete_v1;',
      'drop function clued_private.ci_scan_batch_key_patch_v1(text,text,text);',
    ]){
      assert.equal(original.split(anchor).length,2,'one exact failure boundary');
      const injected=original.replace(anchor,
        "do $atomicity_failure$ begin raise exception 'ci_scan_batch_key_atomicity_fixture'; end $atomicity_failure$;\n"+anchor);
      const broken=text.slice(0,start)+injected+text.slice(end);
      await assert.rejects(()=>ctx.admin.query({text:broken,queryMode:'extended'}),
        {code:'P0001',message:'ci_scan_batch_key_atomicity_fixture'});
      assert.deepEqual(await migrationState(ctx.admin),before,'nothing from the failed migration remains');
    }
  });
  await t.test('one extended-protocol statement outside an explicit transaction applies the complete migration',async()=>{
    const client=await ctx.connect();
    // The same Parse/Bind/Execute boundary as CLI 2.115.0. An old bare LOCK
    // fails with 25P01 here; splitting this envelope also fails preparation.
    await assert.rejects(()=>client.query({text:'lock table clued_private.ci_scan_start_keys_v1 in access exclusive mode',
      queryMode:'extended'}),{code:'25P01'});
    await client.query({text,queryMode:'extended'});
    assert.deepEqual(await migrationState(ctx.admin),expected);
  });
}

// Account, project, claim holder, designated CI Binding with the ci-admission role, qualified consumer and an
// active scan-start policy, all through the real doors where one exists.
async function fixture({admin,connect,json}){
  await allowRawTestBindings(admin);
  const gateway=await connect();await setWorkerGatewayCaller(gateway);
  const ci=await connect('anon'),user=uuid(),holderToken=digest(uuid()),ciToken=digest(uuid());
  await admin.query("insert into auth.users(id,email,email_confirmed_at)values($1,'scan-batch-key@example.invalid',now())",[user]);
  await admin.query('begin');
  await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)
    values($1,$2,'scan-batch-key-fixture','scan-batch-key-fixture',$3,2,true)`,[project,user,scope]);
  await admin.query(`insert into clued_private.project_lifecycle_v2_dispositions(project_id,user_id,disposition,disposition_reason,recognition_confidence,recognition_source,basis,disposition_hash)
    values($1,$2,'recognized_project','Synthetic isolated Native test',1,'v2_explicit_create','{}',$3)`,[project,user,digest('project')]);
  await admin.query('commit');
  const binding=async(token,name,scopes)=>(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,'synthetic',$2,$3,$4,array['*'])returning id`,[user,name,token,scopes])).rows[0].id;
  await binding(holderToken,'claim holder',['context:read','context:write']);
  const ciBinding=await binding(ciToken,'designated CI',['context:read']);
  const call=(name,input)=>workerGatewayRpc(gateway,name,holderToken,input);
  const made=await call('clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,lifecycle_status:'active',scope,idempotency_key:uuid(),
    authority:'observed',confidence_reason:'isolated scan batch key fixture',source_refs:[],source_unavailable_reason:'fixture',
    mutation:{title:'Scan batch key fixture',content:'Synthetic test only',type_fields:{execution_bucket:'next'},relations:{}}});
  assert.equal(made.status,'committed',JSON.stringify(made));
  const claimed=await call('clued_work_claim_v1',{scope,task_id:made.target_refs[0].id,idempotency_key:uuid(),write_set:['fixture/**'],holder_session_ref:'scan-batch-key-test'});
  assert.equal(claimed.status,'committed',JSON.stringify(claimed));
  const claim=claimed.claim,leaseKey=claimed.lease_key??'clued_lk_'+digest('fixture-private-lease');
  await admin.query(`update clued_private.work_claims_v1 set lease_key_required=true,
    lease_key_hash=clued_private.work_claim_lease_key_hash_v1($2) where claim_id=$1`,[claim.claim_id,leaseKey]);
  const epoch=Number((await admin.query('select execution_epoch from clued_private.work_claims_v1 where claim_id=$1',[claim.claim_id])).rows[0].execution_epoch);
  await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
    values($1,$2,'ci-admission',clock_timestamp(),$3,clock_timestamp(),'resident-node')`,[user,ciBinding,claimed.receipt_id]);
  await admin.query("update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),qualification_commit=$1",['f'.repeat(40)]);
  const source=digest('accepted-source'),registry=digest('registry'),workflowSha=digest('workflow'),workflowBlob=sha('workflow');
  await admin.query(`update clued_private.work_claim_independent_consumer_v1 set activated_at=clock_timestamp(),qualification_commit=$1,
    source_manifest_sha256=$2,ci_principal_binding_id=$3`,['f'.repeat(40),source,ciBinding]);
  const roleEntry=(role,blob,hash)=>({workflow_path:`.github/workflows/${role}.yml`,workflow_blob:blob,workflow_sha256:hash,check_name:`${role}-hosted-executor`,hosted_allowed:true,
    closure:[{path:`.github/workflows/${role}.yml`,mode:'100644',blob,sha256:hash}],must_not_exist:[],forbidden_change_prefixes:['scripts/ci/']});
  const roles={gitleaks:roleEntry('gitleaks',workflowBlob,workflowSha),trivy:roleEntry('trivy',sha('trivy'),digest('trivy'))};
  const policyId=(await admin.query(`insert into clued_private.ci_scan_start_policies_v1(repository_id,repository,user_id,project_id,scope,
    source_manifest_sha256,registry_sha256,roles,repository_owner_id,activated_at)values($1,$2,$3,$4,$5,$6,$7,$8,98765,clock_timestamp())returning policy_id`,
    [repoId,repository,user,project,scope,source,registry,roles])).rows[0].policy_id;
  const authorize=async head=>{
    const r=await call('clued_work_renew_v1',{scope,action:'authorize_head',claim_id:claim.claim_id,fence:Number(claim.fence),lease_version:Number(claim.lease_version),
      lease_key:leaseKey,repository,head_sha:head,target_branch:'main',pr_ref:`${repository}#${pr}`,idempotency_key:uuid()});
    assert.equal(r.status,'committed',JSON.stringify(r));
  };
  const count=async()=>Number((await admin.query('select count(*) n from clued_private.ci_scan_start_keys_v1')).rows[0].n);
  const keyOf=async executionId=>{const k=(await admin.query('select to_jsonb(k) k from clued_private.ci_scan_start_keys_v1 k where execution_id=$1',[executionId])).rows[0]?.k;
    return k&&{head_sha:k.head_sha,test_sha:k.test_sha,attempt:k.attempt,role:k.role,provider:k.provider};};
  // The CI command door with the designated CI Binding, exactly as resident-v2/entry-runtime.mjs calls it.
  const verify=input=>json(ci,'select public.clued_work_verify_v1($1,$2::jsonb) v',[ciToken,input]);
  // One raw scan-start command (what native-port.mjs sends), for boundary cases the port itself refuses to build.
  const local=(head,base,extra={})=>verify({action:'scan_start_independent',scope,repository_id:repoId,repository,role:'gitleaks',execution_id:uuid(),
    claim_id:claim.claim_id,fence:Number(claim.fence),epoch,pr,head_sha:head,base_sha:base,changed_paths:['fixture/file'],
    source_manifest_sha256:source,registry_sha256:registry,...extra});
  const verified=(head,base,data={})=>({policy_id:policyId,execution_id:uuid(),claim_id:claim.claim_id,fence:Number(claim.fence),epoch,pr,head_sha:head,base_sha:base,
    changed_paths:['fixture/file'],source_manifest_sha256:source,registry_sha256:registry,workflow_path:roles.gitleaks.workflow_path,workflow_blob:workflowBlob,
    workflow_sha256:workflowSha,run_id:'1234567',run_attempt:2,token_sha256:digest('ephemeral-jwt'),claims_sha256:digest('verified-claims'),
    verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString(),...data});
  const hosted=data=>json(gateway,'select public.clued_ci_scan_start_hosted_v1($1::jsonb) v',[data]);
  // The controller side as installed: the actual port, Native over the command door, the adapter's Native-mode check.
  const native={command:input=>verify(input),
    async current(identity,m){const b=await verify({scope:m.scope,claim_id:identity.claim.claim_id,head_sha:identity.job.headSha,base_sha:identity.job.baseSha,changed_paths:m.paths});
      return b?.status==='ok'&&b.verdict==='ADMITTED'&&b.claim?.claim_id===identity.claim.claim_id;}};
  const github={async readChangedPaths(job){return {complete:true,pr:job.pr,headSha:job.headSha,baseSha:job.baseSha,paths:['fixture/file']};}};
  const port=createIndependentScanStartPort({native,github,registrySha256:registry,scope});
  const observed={claimId:claim.claim_id,fence:Number(claim.fence),epoch,expiresAt:new Date(Date.now()+3600000).toISOString()};
  const job=({head,base,testSha,attempt,role='gitleaks'})=>makeJobV2({repo:repository,pr,headSha:head,baseSha:base,testSha,role,sourceManifestSha256:source,
    createdAt:new Date(Date.now()-1000).toISOString(),attempt});
  const ask=async j=>{const executionId=uuid();
    const facts=admittedFacts(j,observed,{complete:true,paths:['fixture/file']},{batchClaim:observed,observedAt:Date.now()});
    return {executionId,grant:await port({job:j,facts,executionId})};};
  const permit=(j,grant)=>{const now=Date.now();
    const windowed=noteScanStartResponseWindow(grant,{issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()});
    return scanStartPermission(j,windowed,true,now);};
  return {authorize,count,keyOf,verify,local,verified,hosted,ask,permit,job};
}

test('Native scan-start K per batch under its qualified Source: front batch and attempt 2 each get their own permission',{timeout:600000},async t=>{
  await withCluster('clued-scan-batch-key-',async ctx=>{
    // The launch fixture qualifies this migration's exact Native predecessor.
    // Later Native rewrites intentionally invalidate its frozen source guard;
    // the final test below applies those rewrites and checks that refusal.
    await ctx.migrate(name=>name<=MIGRATION);
    const {authorize,count,keyOf,local,verified,hosted,ask,permit,job}=await fixture(ctx);
    const H=sha('head H'),T=sha('main T'),S=sha('test merge S of T and H'),T2=sha('main T2'),S2=sha('test merge S2 of T2 and H');
    const plain=job({head:H,base:T,testSha:H,attempt:1});
    const front=job({head:H,base:T,testSha:S,attempt:1});
    const front2=job({head:H,base:T,testSha:S,attempt:2});
    const plain2=job({head:H,base:T,testSha:H,attempt:2});
    const nextFront=job({head:H,base:T2,testSha:S2,attempt:1});
    const frontTrivy=job({head:H,base:T,testSha:S,attempt:1,role:'trivy'});
    const granted=new Map();
    await authorize(H);

    await t.test('the plain batch of H, its train front batch, both attempt 2s and the next front batch each launch once',async()=>{
      for(const [name,j] of [['plain',plain],['front',front],['front attempt 2',front2],['plain attempt 2',plain2],['next front',nextFront],['front trivy',frontTrivy]]){
        // Before the fix the front batch already stopped here: Native answered scan_start_already_consumed for H.
        const {executionId,grant}=await ask(j);
        assert.equal(grant.launch_allowed,true,name);assert.equal(grant.execution_id,executionId,name);
        assert.equal(grant.contract,'clued.ci-scan-start-grant/2',name);
        assert.equal(grant.head_sha,H,name);assert.equal(grant.test_sha,j.testSha,name);assert.equal(grant.attempt,j.attempt,name);assert.equal(grant.role,j.role,name);
        assert.equal(permit(j,grant).execution_id,executionId,name+': the adapter accepts it in Native mode');
        granted.set(name,{job:j,executionId,grant});
      }
      for(const [name,{job:j,executionId}] of granted)
        assert.deepEqual(await keyOf(executionId),{head_sha:H,test_sha:j.testSha,attempt:j.attempt,role:j.role,provider:'independent-controller'},name);
      assert.equal(await count(),6);
    });

    await t.test('no batch gets a second launch, and one batch\'s grant never passes as another batch\'s, even under the same issue id',async()=>{
      for(const [name,{job:j}] of granted){
        await assert.rejects(ask(j),{code:'SCAN_START_GRANT_REFUSED'},name+' asked again is consumed, never regranted');
      }
      assert.equal(await count(),6,'consumed answers burn nothing new');
      // Same head, role and execution id; only the tested commit or the attempt differs. Before the grant named S and
      // attempt, these passed: the controller compared only head and role.
      const g=name=>granted.get(name);
      for(const [x,y] of [['front','front attempt 2'],['front attempt 2','front'],['front','plain'],['plain','plain attempt 2'],['front','next front']]){
        assert.equal(validateScanStartGrant(g(x).grant,{job:g(x).job,executionId:g(x).executionId}).execution_id,g(x).executionId);
        assert.throws(()=>validateScanStartGrant(g(x).grant,{job:g(y).job,executionId:g(x).executionId}),{code:'SCAN_START_GRANT_REFUSED'},`${x} as ${y}`);
      }
    });

    await t.test('the batch identity is bounded: attempt 1 or 2, S is H or neither H nor the base, both named or neither',async()=>{
      for(const extra of [{test_sha:S,attempt:3},{test_sha:S,attempt:0},{test_sha:S,attempt:1.5},{test_sha:S,attempt:'1'},{test_sha:T,attempt:1},
        {test_sha:'A'.repeat(40),attempt:1},{test_sha:S},{attempt:2}])
        await assert.rejects(local(H,T,extra),/CI_SCAN_START_INPUT_INVALID/,JSON.stringify(extra));
      assert.equal(await count(),6);
    });

    await t.test('hosted runs still share the plain first K of H, keep their grant shape and can never name a merge or an attempt',async()=>{
      const r=await hosted(verified(H,T));assert.equal(r.status,'consumed',JSON.stringify(r));assert.equal(r.launch_allowed,false);
      for(const extra of [{test_sha:S},{attempt:2},{test_sha:S,attempt:1}])
        await assert.rejects(hosted(verified(H,T,extra)),/CI_SCAN_START_INPUT_INVALID/);
      assert.equal(await count(),6);
      // A hosted-first head: hosted takes (H2, H2, 1); the controller's own front batch of H2 still launches.
      const H2=sha('head H2'),S3=sha('test merge S3 of T and H2');await authorize(H2);
      const first=await hosted(verified(H2,T));assert.equal(first.launch_allowed,true,JSON.stringify(first));
      assert.deepEqual(Object.keys(first).sort(),['status','contract','launch_allowed','execution_id','receipt_id','repository_id','head_sha','role','provider','start_requested_at'].sort(),
        'the serving Worker checks this exact /1 shape');
      assert.equal(first.contract,'clued.ci-scan-start-grant/1');
      assert.deepEqual(await keyOf(first.execution_id),{head_sha:H2,test_sha:H2,attempt:1,role:'gitleaks',provider:'github-actions'});
      await assert.rejects(ask(job({head:H2,base:T,testSha:H2,attempt:1})),{code:'SCAN_START_GRANT_REFUSED'},'plain first K of H2 is the hosted one');
      const f=job({head:H2,base:T,testSha:S3,attempt:1}),{executionId,grant}=await ask(f);
      assert.equal(permit(f,grant).execution_id,executionId);
      assert.equal(await count(),8);
    });

    await t.test('a command naming neither S nor attempt and one naming (H, H, 1) share one K, in either order',async()=>{
      const before=await count(),H3=sha('head H3'),H4=sha('head H4');
      await authorize(H3);
      const legacy=await local(H3,T);assert.equal(legacy.launch_allowed,true,JSON.stringify(legacy));
      // A caller that names neither is an old Source: its grant.mjs knows only /1, so it still gets exactly /1
      // (the K is burned either way; a /2 answer would only stop its launch after the burn).
      assert.equal(legacy.contract,'clued.ci-scan-start-grant/1');
      assert.deepEqual(Object.keys(legacy).sort(),['status','contract','launch_allowed','execution_id','receipt_id','repository_id','head_sha','role','provider','start_requested_at'].sort());
      assert.deepEqual(await keyOf(legacy.execution_id),{head_sha:H3,test_sha:H3,attempt:1,role:'gitleaks',provider:'independent-controller'});
      const explicit=await local(H3,T,{test_sha:H3,attempt:1});assert.equal(explicit.status,'consumed',JSON.stringify(explicit));assert.equal(explicit.execution_id,legacy.execution_id);
      await authorize(H4);
      const first=await local(H4,T,{test_sha:H4,attempt:1});assert.equal(first.launch_allowed,true,JSON.stringify(first));
      assert.equal(first.contract,'clued.ci-scan-start-grant/2');assert.equal(first.test_sha,H4);assert.equal(first.attempt,1);
      const second=await local(H4,T);assert.equal(second.status,'consumed',JSON.stringify(second));assert.equal(second.execution_id,first.execution_id);
      assert.equal(await count(),before+2);
    });

    await t.test(`invented tested commits stop at ${FRONT_LIMIT} per head and role; each launches at most twice`,async()=>{
      // Native cannot verify S (or the base it was built on). Before the cap every invented S was a new K: one admitted
      // head could take any number of launches (review MAJOR-1: 5 forged S x 2 attempts gave 10).
      const H5=sha('head H5'),forged=i=>sha('forged S '+i),before=await count();
      await authorize(H5);
      for(let i=0;i<FRONT_LIMIT;i++){
        const r=await local(H5,T,{test_sha:forged(i),attempt:1});assert.equal(r.launch_allowed,true,`S ${i}: ${JSON.stringify(r)}`);
      }
      const refused={status:'rejected',error_code:'ci_scan_start_front_batch_limit',launch_allowed:false};
      for(const [base,attempt] of [[T,1],[T,2],[T2,1]])
        assert.deepEqual(await local(H5,base,{test_sha:forged(FRONT_LIMIT),attempt}),refused,`a new S over the limit (base ${base===T?'T':'T2'}, attempt ${attempt})`);
      assert.equal((await local(H5,T,{test_sha:forged(0),attempt:1})).status,'consumed','a known S stays consumed, not refused');
      assert.equal((await local(H5,T,{test_sha:forged(0),attempt:2})).launch_allowed,true,'attempt 2 of a known S');
      assert.equal((await local(H5,T,{test_sha:forged(0),attempt:2})).status,'consumed');
      assert.equal((await local(H5,T)).launch_allowed,true,'the plain batch of H5 is not a front batch');
      assert.equal((await local(H5,T,{role:'trivy',test_sha:forged(FRONT_LIMIT),attempt:1})).launch_allowed,true,'the limit is per role');
      assert.equal(await count(),before+FRONT_LIMIT+3);
    });

    await t.test('the K is the batch identity and stays immutable',async()=>{
      const key=(await ctx.admin.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid='clued_private.ci_scan_start_keys_v1'::regclass and contype='p'`)).rows[0].d;
      assert.equal(key,'PRIMARY KEY (repository_id, head_sha, test_sha, attempt, role)');
      const n=await count();
      await assert.rejects(()=>ctx.admin.query('update clued_private.ci_scan_start_keys_v1 set attempt=2 where attempt=1'),/CI_SCAN_START_IMMUTABLE/);
      await assert.rejects(()=>ctx.admin.query('delete from clued_private.ci_scan_start_keys_v1'),/CI_SCAN_START_IMMUTABLE/);
      assert.equal(await count(),n);
    });
  });
});

test('K rows taken before the migration are carried over as S = H, attempt 1 and keep burning exactly that batch',{timeout:600000},async t=>{
  await withCluster('clued-scan-batch-key-legacy-',async ctx=>{
    await ctx.migrate(name=>name<MIGRATION);
    const f=await fixture(ctx);
    const H=sha('legacy head'),H2=sha('legacy hosted head'),T=sha('legacy main'),S=sha('test merge of legacy main and head');
    await f.authorize(H2);
    const hostedOld=await f.hosted(f.verified(H2,T));assert.equal(hostedOld.launch_allowed,true,JSON.stringify(hostedOld));
    await f.authorize(H);
    const localOld=await f.local(H,T);assert.equal(localOld.launch_allowed,true,JSON.stringify(localOld));
    assert.equal(localOld.contract,'clued.ci-scan-start-grant/1');assert.equal('test_sha' in localOld,false);
    const rows=async()=>(await ctx.admin.query('select to_jsonb(k) k from clued_private.ci_scan_start_keys_v1 k order by execution_id')).rows.map(r=>r.k);
    const before=await rows();assert.equal(before.length,2);assert.equal('test_sha' in before[0],false);

    await verifyAtomicEntrypoints(ctx,t);
    const after=await rows();assert.equal(after.length,2);
    for(const [i,row] of after.entries()){
      const {test_sha,attempt,...rest}=row;
      assert.deepEqual(rest,before[i],'every recorded fact of the old K is unchanged');
      assert.equal(test_sha,row.head_sha);assert.equal(attempt,1);
    }
    await t.test('the carried-over K still burns its plain first batch and nothing else',async()=>{
      assert.equal((await f.local(H,T)).status,'consumed');
      assert.equal((await f.local(H,T,{test_sha:H,attempt:1})).status,'consumed');
      assert.equal((await f.local(H,T,{test_sha:H,attempt:2})).launch_allowed,true,'its attempt 2 is a batch of its own');
      assert.equal((await f.local(H,T,{test_sha:S,attempt:1})).launch_allowed,true,'its front batch is a batch of its own');
      await f.authorize(H2);
      assert.equal((await f.hosted(f.verified(H2,T))).status,'consumed','the hosted K carried over the same way');
      assert.equal(await f.count(),4);
    });
    await t.test('after every later Native rewrite, both providers verify with the live Native verifier: old K rows keep burning, new heads launch',async()=>{
      await ctx.migrate(name=>name>MIGRATION);
      // 20261113090000: no clone of the Native verifier and no source-hash pin remain that a later rewrite could leave stale.
      for(const gone of ['clued_private.ci_scan_start_native_source_current_v1()','clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb)',
        'clued_private.ci_scan_start_verify_core_principal_v1(uuid,jsonb)'])
        assert.equal((await ctx.admin.query('select to_regprocedure($1) p',[gone])).rows[0].p,null,gone);
      // 20261108161615: the Native verifier admits a PR only for the Task the CI's discovery bound to it (the backfilled
      // relation of this pre-existing claim is 'unknown'); the CI resolves it, as scripts/ci/clued-pr-task-binding.mjs does.
      const resolved=await f.verify({action:'resolve_pr_claim',scope,pr_ref:`${repository}#${pr}`,head_sha:H,base_sha:T,target_branch:'main'});
      assert.equal(resolved.binding_status,'bound',JSON.stringify(resolved));
      const beforeLater=await rows();
      assert.equal((await f.local(H,T)).status,'consumed');assert.equal((await f.hosted(f.verified(H2,T))).status,'consumed');
      assert.deepEqual(await rows(),beforeLater);
      const H3=sha('head after later rewrites'),H4=sha('hosted head after later rewrites');
      await f.authorize(H3);await f.authorize(H4);
      const localNew=await f.local(H3,T);assert.equal(localNew.launch_allowed,true,JSON.stringify(localNew));
      const hostedNew=await f.hosted(f.verified(H4,T));assert.equal(hostedNew.launch_allowed,true,JSON.stringify(hostedNew));
      assert.equal(hostedNew.provider,'github-actions');assert.equal(await f.count(),beforeLater.length+2);
    });
  });
});
