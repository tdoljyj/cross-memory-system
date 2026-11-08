// Task dcc53013: with Native scan-start required (NATIVE_SCAN_START_REQUIRED=true), every scanner batch of a head
// must get its own one-time launch permission. Before 20261108090000 the K was (repository, head, role), so a
// merge-train front batch (H, S) and an automatic attempt 2 found the K of an earlier batch of H already burned
// (scan_start_already_consumed) and could never start. End to end: the real controller port
// (scan-start-v1/native-port.mjs) asks the real Native command door of an isolated database with all migrations,
// and the adapter's own permission check (scanStartPermission in Native mode) accepts what comes back.
import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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
const uuid=()=>crypto.randomUUID();
const digest=(s='fixture')=>crypto.createHash('sha256').update(s).digest('hex');
const sha=(s='fixture')=>crypto.createHash('sha1').update(s).digest('hex');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
// The wire identity the real port sends (hosted-relay-v1/registry.mjs) and the scope the admitted-facts fixture names.
const repository='tdoljyj/cross-memory-system',repoId=1334673495,pr=888,project='00000000-0000-4000-8000-000000000000',scope='project:'+project;

test('Native scan-start K per batch: front batch and attempt 2 each get exactly their own permission',{timeout:600000},async t=>{
  const parent=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(parent,'clued-scan-batch-key-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:digest(uuid()),port:await freePort(),persistent:false,
    postgresFlags:['-c','io_method=sync'],onLog(){},onError(m){process.stderr.write(String(m)+'\n');}});
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
    for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
      try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}
      catch(e){throw new Error(`Migration ${name}: ${e.message}`,{cause:e});}
    }
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

    // The controller side exactly as installed (resident-v2/entry-runtime.mjs): the actual port, Native over the CI
    // command door with the designated CI Binding, and the adapter's Native-mode permission check.
    const verify=input=>json(ci,'select public.clued_work_verify_v1($1,$2::jsonb) v',[ciToken,input]);
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
        assert.equal(grant.head_sha,H,name);assert.equal(grant.role,j.role,name);
        assert.equal(permit(j,grant).execution_id,executionId,name+': the adapter accepts it in Native mode');
        granted.set(name,{job:j,executionId,grant});
      }
      for(const [name,{job:j,executionId}] of granted)
        assert.deepEqual(await keyOf(executionId),{head_sha:H,test_sha:j.testSha,attempt:j.attempt,role:j.role,provider:'independent-controller'},name);
      assert.equal(await count(),6);
    });

    await t.test('no batch gets a second launch or another batch\'s permission',async()=>{
      for(const [name,{job:j}] of granted){
        await assert.rejects(ask(j),{code:'SCAN_START_GRANT_REFUSED'},name+' asked again is consumed, never regranted');
      }
      assert.equal(await count(),6,'consumed answers burn nothing new');
      // A permission is bound to the issue it was asked for: one batch's grant never passes for another batch's issue.
      const a=granted.get('front'),b=granted.get('front attempt 2'),c=granted.get('plain');
      for(const [x,y] of [[a,b],[b,a],[a,c],[c,a]])
        assert.throws(()=>validateScanStartGrant(x.grant,{job:y.job,executionId:y.executionId}),{code:'SCAN_START_GRANT_REFUSED'});
    });

    await t.test('the batch identity is bounded: attempt 1 or 2, S is H or neither H nor the base, both named or neither',async()=>{
      const base={scope,repository_id:repoId,repository,role:'gitleaks',claim_id:claim.claim_id,fence:Number(claim.fence),epoch,pr,head_sha:H,base_sha:T,
        changed_paths:['fixture/file'],source_manifest_sha256:source,registry_sha256:registry};
      for(const extra of [{test_sha:S,attempt:3},{test_sha:S,attempt:0},{test_sha:S,attempt:1.5},{test_sha:S,attempt:'1'},{test_sha:T,attempt:1},
        {test_sha:'A'.repeat(40),attempt:1},{test_sha:S},{attempt:2}])
        await assert.rejects(verify({action:'scan_start_independent',...base,execution_id:uuid(),...extra}),/CI_SCAN_START_INPUT_INVALID/,JSON.stringify(extra));
      assert.equal(await count(),6);
    });

    await t.test('hosted runs still share the plain first K of H and can never name a merge or an attempt',async()=>{
      const verified=(data,head=H)=>({policy_id:policyId,execution_id:uuid(),claim_id:claim.claim_id,fence:Number(claim.fence),epoch,pr,head_sha:head,base_sha:T,
        changed_paths:['fixture/file'],source_manifest_sha256:source,registry_sha256:registry,workflow_path:roles.gitleaks.workflow_path,workflow_blob:workflowBlob,
        workflow_sha256:workflowSha,run_id:'1234567',run_attempt:2,token_sha256:digest('ephemeral-jwt'),claims_sha256:digest('verified-claims'),
        verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString(),...data});
      const hosted=data=>json(gateway,'select public.clued_ci_scan_start_hosted_v1($1::jsonb) v',[data]);
      const r=await hosted(verified({}));assert.equal(r.status,'consumed',JSON.stringify(r));assert.equal(r.launch_allowed,false);
      for(const extra of [{test_sha:S},{attempt:2},{test_sha:S,attempt:1}])
        await assert.rejects(hosted(verified(extra)),/CI_SCAN_START_INPUT_INVALID/);
      assert.equal(await count(),6);
      // A hosted-first head: hosted takes (H2, H2, 1); the controller's own front batch of H2 still launches.
      const H2=sha('head H2'),S3=sha('test merge S3 of T and H2');await authorize(H2);
      const first=await hosted(verified({},H2));assert.equal(first.launch_allowed,true,JSON.stringify(first));
      assert.deepEqual(await keyOf(first.execution_id),{head_sha:H2,test_sha:H2,attempt:1,role:'gitleaks',provider:'github-actions'});
      await assert.rejects(ask(job({head:H2,base:T,testSha:H2,attempt:1})),{code:'SCAN_START_GRANT_REFUSED'},'plain first K of H2 is the hosted one');
      const f=job({head:H2,base:T,testSha:S3,attempt:1}),{executionId,grant}=await ask(f);
      assert.equal(permit(f,grant).execution_id,executionId);
      assert.equal(await count(),8);
    });

    await t.test('the K is the batch identity and stays immutable',async()=>{
      const key=(await admin.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid='clued_private.ci_scan_start_keys_v1'::regclass and contype='p'`)).rows[0].d;
      assert.equal(key,'PRIMARY KEY (repository_id, head_sha, test_sha, attempt, role)');
      await assert.rejects(()=>admin.query('update clued_private.ci_scan_start_keys_v1 set attempt=2 where attempt=1'),/CI_SCAN_START_IMMUTABLE/);
      await assert.rejects(()=>admin.query('delete from clued_private.ci_scan_start_keys_v1'),/CI_SCAN_START_IMMUTABLE/);
      assert.equal(await count(),8);
    });
  }finally{
    for(const c of clients.reverse())await c.end().catch(()=>{});
    const actual=await fs.realpath(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(actual!==null){assert.equal(actual,dir);assert.equal(path.dirname(actual),parent);}
    await stopCluster(server);
    if(actual!==null)await removeTestDirectory(dir);
  }
});
