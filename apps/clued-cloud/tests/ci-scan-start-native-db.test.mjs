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
// 在校验网关完整授权清单的迁移套件里，同步验证新门的调用方和端到端行为。
import './work-claims-pr-merged-event-db.test.mjs';
import {workerGatewayRpc,setWorkerGatewayCaller,WORKER_SIGNATURES,CI_SIGNATURES,CI_NODE_GATEWAY_SIGNATURES,WORKER_DUE_SIGNATURE,CONNECTION_SELF_SIGNATURE,PR_MERGED_EVENT_SIGNATURE,PR_LIFECYCLE_REPORT_SIGNATURE,FLEET_ACCEPT_STATUS_SIGNATURE,RENEW_SIGNATURES} from './worker-gateway-caller-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
const digest=(s='fixture')=>crypto.createHash('sha256').update(s).digest('hex');
const sha=(s='fixture')=>crypto.createHash('sha1').update(s).digest('hex');
const migration='20261102151506_ci_scan_start_keys_v1.sql';
// 20261113090000 later removes the two principal clones and their source guard: the hosted path then calls the live
// Native verifier. What 20261102151506 itself did is therefore checked on the state right after it.
const cloneOf={'public.clued_work_verify_v1':'clued_private.ci_scan_start_verify_principal_v1',
  'clued_private.work_claim_verify_before_execution_v1':'clued_private.ci_scan_start_verify_core_principal_v1'};
const newGateway=['clued_ci_scan_start_hosted_v1(jsonb)','clued_ci_scan_start_policy_v1(jsonb)'];
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

// Same isolated embedded-Postgres/all-migrations/real-Binding harness pattern
// as the existing handover and scheduling tests. No Native verification stub.
test('physical scan-start Native K: real transactions, exact existing authority and permanent burns',{timeout:600000},async t=>{
  const parent=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(parent,'clued-scan-start-native-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:digest(uuid()),port:await freePort(),persistent:false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(String(m)+'\n');}});
  const clients=[];
  const connect=async(role)=>{const c=server.getPgClient();clients.push(c);await c.connect();if(role)await c.query('set role '+role);return c;};
  const json=async(c,q,args=[])=>(await c.query(q,args)).rows[0].v;
  let admin;
  try{
    await server.initialise();await server.start();admin=await connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;
      create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    let beforeCommands,afterCommands;const beforeNative={},afterNative={},afterClone={};
    for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
      if(name===migration){
        beforeCommands=await json(admin,"select pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure) v");
        for(const n of ['public.clued_work_verify_v1','clued_private.work_claim_verify_before_execution_v1'])
          beforeNative[n]=await json(admin,'select pg_get_functiondef($1::regprocedure) v',[n+'(text,jsonb)']);
      }
      try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}
      catch(e){throw new Error(`Migration ${name}: ${e.message}`,{cause:e});}
      if(name===migration){
        afterCommands=await json(admin,"select pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure) v");
        for(const n of Object.keys(beforeNative)){
          afterNative[n]=await json(admin,'select pg_get_functiondef($1::regprocedure) v',[n+'(text,jsonb)']);
          afterClone[n]=await json(admin,'select pg_get_functiondef($1::regprocedure) v',[cloneOf[n]+'(uuid,jsonb)']);
        }
      }
    }
    await allowRawTestBindings(admin);
    const gateway=await connect();await setWorkerGatewayCaller(gateway);
    const ci=await connect('anon'),user=uuid(),project=uuid(),holderToken=digest(uuid()),ciToken=digest(uuid());
    const scope='project:'+project,repository='fixture/scan-start',repoId=1334673495; // isolated DB: fixed wire identity for the real bridge codec
    await admin.query("insert into auth.users(id,email,email_confirmed_at)values($1,'scan-start@example.invalid',now())",[user]);
    await admin.query('begin');
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)
      values($1,$2,'scan-start-fixture','scan-start-fixture',$3,2,true)`,[project,user,scope]);
    await admin.query(`insert into clued_private.project_lifecycle_v2_dispositions(project_id,user_id,disposition,disposition_reason,recognition_confidence,recognition_source,basis,disposition_hash)
      values($1,$2,'recognized_project','Synthetic isolated Native test',1,'v2_explicit_create','{}',$3)`,[project,user,digest('project')]);
    await admin.query('commit');
    const binding=async(token,name,scopes)=>(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic',$2,$3,$4,array['*'])returning id`,[user,name,token,scopes])).rows[0].id;
    const holder=await binding(holderToken,'claim holder',['context:read','context:write']);
    const ciBinding=await binding(ciToken,'designated CI',['context:read']);
    const call=(name,input)=>workerGatewayRpc(gateway,name,holderToken,input);
    const made=await call('clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,lifecycle_status:'active',scope,idempotency_key:uuid(),
      authority:'observed',confidence_reason:'isolated physical scan reservation fixture',source_refs:[],source_unavailable_reason:'fixture',
      mutation:{title:'Physical scan fixture',content:'Synthetic test only',type_fields:{execution_bucket:'next'},relations:{}}});
    assert.equal(made.status,'committed',JSON.stringify(made));
    const claimed=await call('clued_work_claim_v1',{scope,task_id:made.target_refs[0].id,idempotency_key:uuid(),write_set:['fixture/**'],holder_session_ref:'scan-native-test'});
    assert.equal(claimed.status,'committed',JSON.stringify(claimed));
    const claim=claimed.claim,leaseKey=claimed.lease_key??'clued_lk_'+digest('fixture-private-lease');
    // Set the synthetic initial claim's private guard before execution activation;
    // the real authorize_head and Native fullVerify remain unmodified and tested.
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
      closure:[{path:`.github/workflows/${role}.yml`,mode:'100644',blob,sha256:hash},
        {path:`.github/actions/${role}/action.yml`,mode:'100644',blob:sha(role+' action'),sha256:digest(role+' action')},
        {path:'scripts/ci/shared-helper.mjs',mode:'100755',blob:sha('helper'),sha256:digest('helper')}],
      must_not_exist:[`.github/actions/${role}/action.yaml`],forbidden_change_prefixes:[`.github/actions/${role}/`,'scripts/ci/']});
    const roles={gitleaks:roleEntry('gitleaks',workflowBlob,workflowSha),trivy:roleEntry('trivy',sha('trivy'),digest('trivy'))};
    const policyId=(await admin.query(`insert into clued_private.ci_scan_start_policies_v1(repository_id,repository,user_id,project_id,scope,
      source_manifest_sha256,registry_sha256,roles,repository_owner_id)values($1,$2,$3,$4,$5,$6,$7,$8,98765)returning policy_id`,
      [repoId,repository,user,project,scope,source,registry,roles])).rows[0].policy_id;
    const authorize=async head=>{
      const r=await call('clued_work_renew_v1',{scope,action:'authorize_head',claim_id:claim.claim_id,fence:Number(claim.fence),lease_version:Number(claim.lease_version),
        lease_key:leaseKey,repository,head_sha:head,target_branch:'main',pr_ref:repository+'#7',idempotency_key:uuid()});
      assert.equal(r.status,'committed',JSON.stringify(r));
      // 20261108161615: the CI's discovery binds the PR to this Task before the Native verifier admits it.
      const resolved=await json(ci,'select public.clued_work_verify_v1($1,$2::jsonb) v',[ciToken,
        {action:'resolve_pr_claim',scope,pr_ref:repository+'#7',head_sha:head,base_sha:sha('base'),target_branch:'main'}]);
      assert.equal(resolved.binding_status,'bound',JSON.stringify(resolved));return r;
    };
    const input=(head=sha(uuid()),extra={})=>({execution_id:uuid(),claim_id:claim.claim_id,fence:Number(claim.fence),epoch,pr:7,head_sha:head,
      base_sha:sha('base'),changed_paths:['fixture/file'],source_manifest_sha256:source,registry_sha256:registry,...extra});
    const local=(data,client=ci,proof=ciToken)=>json(client,'select public.clued_work_verify_v1($1,$2::jsonb) v',[proof,{action:'scan_start_independent',scope,repository_id:repoId,repository,role:'gitleaks',...data}]);
    const verified=data=>({policy_id:policyId,...data,workflow_path:roles.gitleaks.workflow_path,workflow_blob:workflowBlob,workflow_sha256:workflowSha,
      run_id:'1234567',run_attempt:1,token_sha256:digest('ephemeral-jwt'),claims_sha256:digest('verified-claims'),
      verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString()});
    const hosted=(data,client=gateway)=>json(client,'select public.clued_ci_scan_start_hosted_v1($1::jsonb) v',[data]);
    const count=async()=>Number((await admin.query('select count(*) n from clued_private.ci_scan_start_keys_v1')).rows[0].n);

    await t.test('gateway surface expands by exactly two narrow RPCs; all existing command bytes preserved',async()=>{
      const names=async role=>(await admin.query(`select p.oid::regprocedure::text s from pg_proc p where p.pronamespace='public'::regnamespace
        and has_function_privilege($1,p.oid,'EXECUTE') order by 1`,[role])).rows.map(r=>r.s.replace(/^public\./,''));
      // 后续迁移各自显式登记新增的网关签名。
      assert.deepEqual(await names('clued_worker_gateway'),[...WORKER_SIGNATURES,...newGateway,...CI_NODE_GATEWAY_SIGNATURES,
        WORKER_DUE_SIGNATURE,PR_MERGED_EVENT_SIGNATURE,...RENEW_SIGNATURES].sort());
      const anon=(await admin.query(`select p.oid::regprocedure::text s from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef
        and has_function_privilege('anon',p.oid,'EXECUTE') order by 1`)).rows.map(r=>r.s.replace(/^public\./,''));
      assert.deepEqual(anon,[...CI_SIGNATURES, CONNECTION_SELF_SIGNATURE, PR_LIFECYCLE_REPORT_SIGNATURE, FLEET_ACCEPT_STATUS_SIGNATURE].sort());
      assert.equal(afterCommands.replace("  if op='scan_start_independent' then\n    return clued_private.ci_scan_start_local_v1(p_token_hash,p_input);\n  end if;\n",''),
        beforeCommands);
      for(const [original,copy] of Object.entries(cloneOf)){
        const restored=afterClone[original].replace('FUNCTION '+copy+'(p_binding_id uuid, p_input jsonb)','FUNCTION '+original+'(p_token_hash text, p_input jsonb)')
          .replaceAll('clued_private.ci_scan_start_resolve_principal_v1(p_binding_id,','clued_private.resolve_binding(p_token_hash,')
          .replaceAll('clued_private.ci_scan_start_verify_core_principal_v1(p_binding_id,p_input)','clued_private.work_claim_verify_before_execution_v1(p_token_hash,p_input)')
          .replaceAll('p_binding_id','p_token_hash');
        assert.equal(restored,beforeNative[original],'only exact credential resolution and delegated core entry differ');
        assert.equal(afterNative[original],beforeNative[original],'old Native full-verifier remains byte identical');
        assert.equal((await admin.query('select to_regprocedure($1) p',[copy+'(uuid,jsonb)'])).rows[0].p,null,'20261113090000 removed '+copy);
      }
      assert.equal((await admin.query("select to_regprocedure('clued_private.ci_scan_start_native_source_current_v1()') p")).rows[0].p,null);
      for(const role of ['anon','authenticated','service_role'])for(const name of newGateway)
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'EXECUTE\') b',[role,'public.'+name])).rows[0].b,false);
      for(const table of ['ci_scan_start_keys_v1','ci_scan_start_policies_v1']){
        const row=(await admin.query('select relrowsecurity from pg_class where oid=$1::regclass',['clued_private.'+table])).rows[0];assert.equal(row.relrowsecurity,true);
        assert.equal((await admin.query('select has_table_privilege(\'clued_worker_gateway\',$1,\'SELECT\') b',['clued_private.'+table])).rows[0].b,false);
      }
    });
    await t.test('server-owned frozen closure is closed, bounded, unique, safe and tied to workflow pins',async()=>{
      const valid=value=>json(admin,'select clued_private.ci_scan_start_roles_valid_v1($1::jsonb) v',[value]);
      assert.equal(await valid(roles),true);
      const patch=change=>{const x=structuredClone(roles);change(x.gitleaks);return x;};
      const invalid=[
        patch(r=>delete r.closure),patch(r=>delete r.must_not_exist),patch(r=>delete r.forbidden_change_prefixes),
        patch(r=>r.closure=[]),patch(r=>r.closure={}),patch(r=>r.closure=null),patch(r=>r.extra=true),
        patch(r=>r.closure.push({...r.closure[0]})),patch(r=>r.closure[0].sha256=digest('wrong')),
        patch(r=>r.closure[0].blob=sha('wrong')),patch(r=>r.closure[0].mode='100755'),
        patch(r=>r.closure[0].extra=true),patch(r=>r.closure[1].mode='120000'),patch(r=>r.closure[1].blob='A'.repeat(40)),
        patch(r=>r.closure[1].path='../escape'),patch(r=>r.closure[1].path='a//b'),patch(r=>r.closure[1].path='a/./b'),
        patch(r=>r.closure[1].path='/absolute'),patch(r=>r.closure[1].path='a\\b'),patch(r=>r.closure[1].path='x\u0001y'),
        patch(r=>r.closure[1].path='a'.repeat(501)),patch(r=>r.closure=Array.from({length:65},(_,i)=>({...r.closure[0],path:`f${i}`}))),
        patch(r=>r.must_not_exist={}),patch(r=>r.must_not_exist=[r.workflow_path]),patch(r=>r.must_not_exist=['a','a']),
        patch(r=>r.must_not_exist=['a/../b']),patch(r=>r.must_not_exist=[{}]),patch(r=>r.must_not_exist=Array.from({length:65},(_,i)=>`absent${i}`)),
        patch(r=>r.forbidden_change_prefixes=['scripts/ci']),patch(r=>r.forbidden_change_prefixes=['scripts/ci/','scripts/ci/']),
        patch(r=>r.forbidden_change_prefixes=['../']),patch(r=>r.forbidden_change_prefixes=[7]),
        patch(r=>r.forbidden_change_prefixes=Array.from({length:65},(_,i)=>`prefix${i}/`))
      ];
      for(const candidate of invalid)assert.equal(await valid(candidate),false,JSON.stringify(candidate));
      const allowed=structuredClone(roles);allowed.gitleaks.must_not_exist=[];allowed.gitleaks.forbidden_change_prefixes=[];
      assert.equal(await valid(allowed),true);
      // Prove the actual private table constraint also rejects unreviewed pins.
      await assert.rejects(()=>admin.query('update clued_private.ci_scan_start_policies_v1 set roles=$1 where policy_id=$2',[invalid[0],policyId]),/ci_scan_start_policy_roles_v1/);
      assert.equal(await count(),0);
    });
    await t.test('default policy inactive; activation itself never starts a scanner',async()=>{
      assert.equal((await json(gateway,'select public.clued_ci_scan_start_policy_v1($1) v',[{repository_id:repoId,repository}])).error_code,'ci_scan_start_policy_inactive');
      const d=input();await authorize(d.head_sha);assert.equal((await local(d)).launch_allowed,false);assert.equal(await count(),0);
      await admin.query('update clued_private.ci_scan_start_policies_v1 set activated_at=clock_timestamp() where policy_id=$1',[policyId]);
      const p=await json(gateway,'select public.clued_ci_scan_start_policy_v1($1) v',[{repository_id:repoId,repository}]);assert.equal(p.status,'ok');assert.deepEqual(p.roles,roles);assert.equal(p.hosted_head_sha,null);assert.equal('token_hash' in p,false);assert.equal(await count(),0);
    });
    await t.test('without the private exact head grant, no provider can burn a K',async()=>{
      const d=input();assert.equal((await local(d)).launch_allowed,false);assert.equal((await hosted(verified(d))).launch_allowed,false);assert.equal(await count(),0);
    });
    let won,first;
    await t.test('independent real connections race local and hosted on one global K; exactly one launch permission',async()=>{
      const d=input();await authorize(d.head_sha);first=d;
      const c1=await connect('anon'),c2=await connect();await setWorkerGatewayCaller(c2);
      const results=await Promise.all([local(d,c1),hosted(verified({...d,execution_id:uuid()}),c2)]);
      assert.equal(results.filter(r=>r.launch_allowed===true).length,1,JSON.stringify(results));assert.equal(results.filter(r=>r.launch_allowed===false).length,1);
      won=results.find(r=>r.launch_allowed);assert.equal(await count(),1);assert.ok(won.receipt_id);
      // 20261108090000 (Task dcc53013): only a caller naming S and attempt gets the /2 grant; this one names neither
      // (an old Source, or the hosted entry), so either winner keeps the exact /1 shape its consumer checks.
      assert.deepEqual(Object.keys(won).sort(),['status','contract','launch_allowed','execution_id','receipt_id','repository_id','head_sha','role','provider','start_requested_at'].sort());
      assert.equal(won.contract,'clued.ci-scan-start-grant/1');assert.match(won.start_requested_at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    });
    await t.test('same UUID, another provider/run/attempt or claim cannot regrant; lost response stays burned',async()=>{
      assert.equal((await local(first)).launch_allowed,false);
      assert.equal((await hosted(verified({...first,execution_id:uuid()}))).launch_allowed,false);
      assert.equal((await hosted({...verified({...first,execution_id:uuid()}),run_id:'999',run_attempt:2})).launch_allowed,false);
      assert.equal((await local({...first,claim_id:uuid()})).launch_allowed,false);
      assert.equal(await count(),1);
      const row=(await admin.query('select * from clued_private.ci_scan_start_keys_v1')).rows[0];assert.equal(row.state,'start_requested');
      assert.equal(JSON.stringify(row).includes('ephemeral-jwt'),false);assert.equal(JSON.stringify(row).includes(ciToken),false);
    });
    await t.test('new Source policy and registry do not create a new K',async()=>{
      const nextSource=digest('next-accepted-source'),nextRegistry=digest('next-registry');
      await admin.query('update clued_private.ci_scan_start_policies_v1 set source_manifest_sha256=$1,registry_sha256=$2 where policy_id=$3',[nextSource,nextRegistry,policyId]);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set source_manifest_sha256=$1',[nextSource]);
      assert.equal((await local({...first,execution_id:uuid(),source_manifest_sha256:nextSource,registry_sha256:nextRegistry})).launch_allowed,false);
      await admin.query('update clued_private.ci_scan_start_policies_v1 set source_manifest_sha256=$1,registry_sha256=$2 where policy_id=$3',[source,registry,policyId]);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set source_manifest_sha256=$1',[source]);
    });
    await t.test('closed Worker facts reject authority/provider/role injection and mismatched or stale pins',async()=>{
      const d=input();await authorize(d.head_sha);
      for(const injected of [{user_id:user},{scope},{role:'trivy'},{binding_id:ciBinding},{ci_principal_binding_id:ciBinding},{provider:'independent-controller'},{raw_jwt:'never-accepted'}])
        await assert.rejects(()=>hosted({...verified(d),...injected}),/CI_SCAN_START_INPUT_INVALID/);
      for(const changed of [{workflow_blob:sha('wrong')},{workflow_sha256:digest('wrong')},{workflow_path:'.github/workflows/unregistered.yml'},
        {source_manifest_sha256:digest('wrong')},{registry_sha256:digest('wrong')},{epoch:epoch+1},{fence:Number(claim.fence)+1},{changed_paths:['outside/path']},
        {verified_at:new Date(Date.now()-60000).toISOString()},{expires_at:new Date(Date.now()-1000).toISOString()}])
        assert.equal((await hosted({...verified(d),...changed})).launch_allowed,false,JSON.stringify(changed));
      assert.equal(await count(),1);
    });
    await t.test('Binding role/revocation, consumer Source and policy deactivation are rechecked at transaction',async()=>{
      const d=input();await authorize(d.head_sha);
      await admin.query('update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=$2 where binding_id=$1',[ciBinding,claimed.receipt_id]);
      assert.equal((await hosted(verified(d))).launch_allowed,false);
      await admin.query('update clued_private.binding_roles_v1 set revoked_at=null,revoked_receipt_id=null where binding_id=$1',[ciBinding]);
      await admin.query('update clued_private.ci_scan_start_policies_v1 set disabled_at=clock_timestamp() where policy_id=$1',[policyId]);
      assert.equal((await local(d)).launch_allowed,false);
      await admin.query('update clued_private.ci_scan_start_policies_v1 set disabled_at=null where policy_id=$1',[policyId]);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set source_manifest_sha256=$1',[digest('unqualified')]);
      assert.equal((await local(d)).launch_allowed,false);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set source_manifest_sha256=$1',[source]);
      await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[ciBinding]);
      await assert.rejects(()=>hosted(verified(d)),/revoked|authorized|binding/);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[ciBinding]);
      assert.equal(await count(),1);
    });
    await t.test('account suspension and expired/draining claims remain closed under the hosted principal sibling',async()=>{
      const d=input();await authorize(d.head_sha);
      await admin.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[user]);
      try{await assert.rejects(()=>hosted(verified(d)),/account|available|authorized/);}finally{await admin.query('update auth.users set banned_until=null where id=$1',[user]);}
      for(const change of ["status='DRAINING'","expires_at=clock_timestamp()+interval '50 milliseconds'"]){
        await admin.query('begin');
        try{
          await admin.query('update clued_private.work_claims_v1 set '+change+' where claim_id=$1',[claim.claim_id]);
          if(change.startsWith('expires_at'))await admin.query('select pg_sleep(0.08)');
          assert.equal((await hosted(verified(d),admin)).launch_allowed,false);
        }finally{await admin.query('rollback');}
      }
      assert.equal(await count(),1);
    });
    await t.test('a verified hosted request expiring while waiting for the owner lock cannot obtain a launch',async()=>{
      const d=input();await authorize(d.head_sha);const blocked=await connect();await setWorkerGatewayCaller(blocked);
      await admin.query('begin');await admin.query('select clued_private.work_claim_lock($1)',[user]);
      let pending;
      try{
        pending=hosted({...verified(d),expires_at:new Date(Date.now()+500).toISOString()},blocked);
        await new Promise(r=>setTimeout(r,700));
      }finally{await admin.query('commit');}
      const result=await pending;assert.equal(result.launch_allowed,false);assert.equal(result.error_code,'ci_scan_start_verification_expired');
      assert.equal(await count(),1);
    });
    await t.test('the hosted principal runs the live Native verifier: a later verifier change reaches it with nothing to re-derive',async()=>{
      const d=input();await authorize(d.head_sha);const before=await count();
      await admin.query('begin');
      try{
        // A stricter successor of the Native verifier (here: one that refuses everything), in this transaction only.
        await admin.query(`alter function public.clued_work_verify_v1(text,jsonb) rename to clued_work_verify_v1_isolated_saved;
          create function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb language sql as
            $$select jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false)$$;`);
        const result=await hosted(verified(d),admin);assert.equal(result.launch_allowed,false);assert.equal(result.error_code,'ci_scan_start_native_refused');
      }finally{await admin.query('rollback');}
      assert.equal(await count(),before,'the refused request burned nothing');
    });
    await t.test('the K itself is immutable and globally unique; there is no finish/reset/transfer door',async()=>{
      const key=(await admin.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid='clued_private.ci_scan_start_keys_v1'::regclass and contype='p'`)).rows[0].d;
      // 20261108090000 (Task dcc53013) names the batch: tested commit and attempt. Callers that name neither (this
      // test, the hosted entry) still get S = H, attempt 1, so the global (head, role) burn above is unchanged.
      assert.equal(key,'PRIMARY KEY (repository_id, head_sha, test_sha, attempt, role)');
      await assert.rejects(()=>admin.query("update clued_private.ci_scan_start_keys_v1 set state='start_requested'"),/CI_SCAN_START_IMMUTABLE/);
      await assert.rejects(()=>admin.query('delete from clued_private.ci_scan_start_keys_v1'),/CI_SCAN_START_IMMUTABLE/);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        assert.equal((await admin.query("select has_function_privilege($1,'clued_private.ci_scan_start_local_v1(text,jsonb)','EXECUTE') b",[role])).rows[0].b,false);
      }
      assert.equal((await local({...first,execution_id:uuid()})).launch_allowed,false);assert.equal(await count(),1);
    });
    await t.test('a fresh hosted-first K gets the same real Native grant, with no raw credential recovery',async()=>{
      const d=input();await authorize(d.head_sha);
      const r=await hosted(verified(d));assert.equal(r.launch_allowed,true,JSON.stringify(r));assert.equal(r.provider,'github-actions');
      assert.equal(r.execution_id,d.execution_id);assert.equal(r.head_sha,d.head_sha);assert.equal(r.role,'gitleaks');
      assert.match(r.start_requested_at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal((await local({...d,execution_id:uuid()})).launch_allowed,false);assert.equal(await count(),2);
      const localGrant=await local({...d,role:'trivy',execution_id:uuid()});
      assert.equal(localGrant.launch_allowed,true);assert.equal(localGrant.provider,'independent-controller');assert.equal(localGrant.role,'trivy');
      assert.equal(localGrant.head_sha,r.head_sha,'distinct roles on the same H have distinct physical keys');assert.equal(await count(),3);
      if(process.env.CLUED_SCAN_NATIVE_GRANT_OUT)await fs.writeFile(process.env.CLUED_SCAN_NATIVE_GRANT_OUT,
        JSON.stringify({kind:'synthetic-isolated-embedded-postgres-native-grant',production:false,migration,grant:r,local_grant:localGrant},null,2)+'\n',{flag:'wx'});
    });
    await t.test('exact-H server hosted policy cannot consume another head; Native other heads and permanent K remain intact',async()=>{
      const target=input(),other=input(),before=await count();
      await admin.query('update clued_private.ci_scan_start_policies_v1 set hosted_head_sha=$1 where policy_id=$2',[target.head_sha,policyId]);
      const policy=await json(gateway,'select public.clued_ci_scan_start_policy_v1($1) v',[{repository_id:repoId,repository}]);
      assert.equal(policy.hosted_head_sha,target.head_sha,'public lookup declares the same server-owned exact-H boundary');
      for(const bad of ['A'.repeat(40),'a'.repeat(39),'a'.repeat(41),'', 'not-a-head'])
        await assert.rejects(()=>admin.query('update clued_private.ci_scan_start_policies_v1 set hosted_head_sha=$1 where policy_id=$2',[bad,policyId]),
          e=>e.code==='23514' && /ci_scan_start_hosted_head_v1/.test(e.message));
      await authorize(target.head_sha);
      const exact=await hosted(verified(target));assert.equal(exact.launch_allowed,true,JSON.stringify(exact));assert.equal(exact.provider,'github-actions');
      assert.equal(await count(),before+1);
      await authorize(other.head_sha);
      assert.deepEqual(await hosted(verified(other)),{status:'rejected',error_code:'ci_scan_start_hosted_head_not_qualified',launch_allowed:false});
      assert.equal(await count(),before+1,'out-of-window hosted request never burns K');
      const native=await local(other);assert.equal(native.launch_allowed,true,JSON.stringify(native));assert.equal(native.provider,'independent-controller');
      assert.equal(await count(),before+2,'same other H can still obtain its first fully admitted Native permission');
      // Explicit isolated Owner-policy global mode. It changes no existing K.
      await admin.query('update clued_private.ci_scan_start_policies_v1 set hosted_head_sha=null where policy_id=$1',[policyId]);
      assert.equal((await json(gateway,'select public.clued_ci_scan_start_policy_v1($1) v',[{repository_id:repoId,repository}])).hosted_head_sha,null);
      await authorize(target.head_sha);
      const replay=await hosted(verified({...target,execution_id:uuid()}));assert.equal(replay.status,'consumed');assert.equal(replay.launch_allowed,false);
      await authorize(other.head_sha);
      assert.equal((await hosted(verified({...other,execution_id:uuid()}))).launch_allowed,false,'local-first K is still global across policy mode and provider');
      assert.equal(await count(),before+2);
    });
    await t.test('scan policy follows only the current qualified consumer after real Native role handover; no caller Binding or manual policy edit',async()=>{
      const secondToken=digest(uuid()),second=await binding(secondToken,'second qualified CI',['context:read']);
      const d=input();await authorize(d.head_sha);const before=await count();
      // A valid same-account read Binding is not a qualified CI consumer.
      assert.deepEqual(await local(d,ci,secondToken),{status:'rejected',error_code:'admission_binding_required'});
      const human=await connect('authenticated'),sessionId=uuid(),seconds=Math.floor(Date.now()/1000);
      await admin.query("insert into auth.sessions(id,user_id,not_after)values($1,$2,clock_timestamp()+interval '1 hour')",[sessionId,user]);
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify({sub:user,role:'authenticated',session_id:sessionId,aal:'aal1',amr:[{method:'password',timestamp:seconds}]})]);
      const owner=async(name,data)=>json(human,'select public.'+name+'($1::jsonb) v',[data]);
      // 20261114120000: a handover lands only on a node heard lately, reporting NORMAL and the Source the fleet runs.
      await admin.query(`insert into clued_private.ci_nodes_v1(user_id,project_id,binding_id,name,profile,profile_sha256,identity_public_jwk,
        encryption_public_jwk,identity_fingerprint,encryption_fingerprint,registration_digest,idempotency_key)
        values($1,$2,$3,'SECOND','{}'::jsonb,$4,'{}'::jsonb,'{}'::jsonb,$5,$6,$7,$8)`,[user,project,second,digest('p2'),digest('i2'),digest('e2'),digest('r2'),uuid()]);
      const heard=await json(ci,'select public.clued_work_verify_v1($1,$2::jsonb) v',[secondToken,{action:'ci_node_heartbeat',scope:'global',
        state:'NORMAL',mode:'STANDBY',probe:'not-held',ci_source_manifest_sha256:source,service_running:true,snapshot_age_seconds:5}]);
      assert.equal(heard.status,'ok',JSON.stringify(heard));
      const confirmation=await owner('clued_binding_role_handover_confirmation_issue_v1',{from_binding_id:ciBinding,to_binding_id:second});
      assert.equal(confirmation.status,'issued',JSON.stringify(confirmation));
      const moved=await owner('clued_binding_role_handover_v1',{confirmation_token:confirmation.confirmation_token,view_digest:confirmation.view_digest});
      assert.equal(moved.status,'committed',JSON.stringify(moved));
      assert.equal((await admin.query('select ci_principal_binding_id from clued_private.work_claim_independent_consumer_v1 where singleton')).rows[0].ci_principal_binding_id,ciBinding,
        'existing role handover does not activate a different independent consumer');
      assert.deepEqual(await local(d,ci,secondToken),{status:'rejected',error_code:'admission_binding_required'});
      assert.equal((await hosted(verified(d))).launch_allowed,false);
      // Simulate only the existing activation delay in the isolated fixture.
      await admin.query("update clued_private.binding_roles_v1 set granted_at=granted_at-interval '5 minutes',effective_at=effective_at-interval '5 minutes' where binding_id=$1 and revoked_at is null",[second]);
      assert.equal((await local(d,ci,secondToken)).launch_allowed,false,'current CI role alone is not consumer qualification');
      assert.equal(await count(),before);
      const policyBefore=(await admin.query('select to_jsonb(p) p from clued_private.ci_scan_start_policies_v1 p where policy_id=$1',[policyId])).rows[0].p;
      // Private qualification setup is intentionally separate from the real
      // role handover. This test does not add an activation/handover RPC.
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set ci_principal_binding_id=$1 where singleton',[second]);
      const firstB=await local(d,ci,secondToken);assert.equal(firstB.launch_allowed,true,JSON.stringify(firstB));
      assert.equal(firstB.provider,'independent-controller');assert.equal(firstB.execution_id,d.execution_id);
      assert.equal((await local({...d,execution_id:uuid()},ci,secondToken)).launch_allowed,false,'the same H/role stays burned for B');
      assert.equal((await hosted(verified({...d,execution_id:uuid()}))).launch_allowed,false,'hosted cannot regrant that same H/role');
      const next=input();await authorize(next.head_sha);
      assert.deepEqual(await local(next,ci,ciToken),{status:'rejected',error_code:'admission_binding_required'},'old A cannot follow B consumer qualification');
      const firstHostedB=await hosted(verified(next));assert.equal(firstHostedB.launch_allowed,true,JSON.stringify(firstHostedB));
      assert.equal(firstHostedB.provider,'github-actions');assert.equal(firstHostedB.execution_id,next.execution_id);
      assert.equal((await local({...next,execution_id:uuid()},ci,secondToken)).launch_allowed,false);
      const cold=input();await authorize(cold.head_sha);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set activated_at=null where singleton');
      assert.equal((await local(cold,ci,secondToken)).launch_allowed,false);assert.equal((await hosted(verified(cold))).launch_allowed,false);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set activated_at=clock_timestamp(),source_manifest_sha256=$1 where singleton',[digest('unqualified source')]);
      assert.equal((await local(cold,ci,secondToken)).launch_allowed,false);assert.equal((await hosted(verified(cold))).launch_allowed,false);
      await admin.query('update clued_private.work_claim_independent_consumer_v1 set source_manifest_sha256=$1 where singleton',[source]);
      assert.equal(await count(),before+2);
      assert.deepEqual((await admin.query('select to_jsonb(p) p from clued_private.ci_scan_start_policies_v1 p where policy_id=$1',[policyId])).rows[0].p,policyBefore,
        'same accepted owner/project/repo/Source/registry policy never needs a per-machine Binding rewrite');
    });
  }finally{
    for(const c of clients.reverse())await c.end().catch(()=>{});
    const actual=await fs.realpath(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(actual!==null){assert.equal(actual,dir);assert.equal(path.dirname(actual),parent);}
    await stopCluster(server);
    if(actual!==null)await removeTestDirectory(dir);
  }
});
