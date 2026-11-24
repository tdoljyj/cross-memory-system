import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { newCluster } from './pg-cluster-fixture.mjs';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {workerGatewayRpc, assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const uuid=()=>crypto.randomUUID();
export const digest=(value='fixture')=>crypto.createHash('sha256').update(value).digest('hex');
export const sha=(value='fixture')=>crypto.createHash('sha1').update(value).digest('hex');
export const limits=(cap=100)=>Object.fromEntries(['execution_start','evaluation','PR_batch','head_release','stage8_retry','head_distinct_combination_24h'].map(k=>[k,cap]));

// through: the last migration file to apply (a test of an earlier migration's repair that a later one supersedes);
// every migration by default.
export async function schedulingFixture({through}={}){
  const parent=await fs.realpath(os.tmpdir());
  const directory=await fs.mkdtemp(path.join(parent,'clued-ci-stage1-'));
  const server=newCluster({databaseDir:directory,user:'postgres',password:crypto.randomBytes(32).toString('hex'),persistent:false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(message){process.stderr.write(String(message)+'\n');}});
  const clients=[];
  const connect=async(role)=>{const c=server.getPgClient();clients.push(c);await c.connect();if(role)await c.query(`set role ${role}`);return c;};
  const close=async()=>{for(const c of clients.reverse())await c.end().catch(()=>{});
    const actual=await fs.realpath(directory).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(actual!==null){assert.equal(path.dirname(actual),parent);assert.equal(actual,directory);}
    await server.stop().catch(()=>{}); // persistent:false may itself remove this owned cluster.
    // Windows may hold the stopped cluster's files for a moment (EBUSY); fs.rm retries those.
    if(actual!==null)await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});};
  try{
    await startCluster(server);const admin=await connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;
      create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(through===undefined||n<=through)).sort();
    if(through!==undefined)assert.equal(names.at(-1),through,'the named migration exists');
    for(const name of names){try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}
      catch(error){throw new Error(`Migration ${name}: ${error.message}`,{cause:error});}}
    await allowRawTestBindings(admin);await assertGatewayCloseoutBoundary(admin);
    const user=uuid(),other=uuid(),project=uuid(),project2=uuid(),otherProject=uuid(),session=uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)values($1,'ci-stage1@example.invalid',now()),($2,'ci-stage1-other@example.invalid',now());`,[user,other]);
    for(const [id,u] of [[project,user],[project2,user],[otherProject,other]]){
      await admin.query('begin');
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)values($1,$2,$3,$3,$4,2,true)`,[id,u,'test-'+id,'project:'+id]);
      await admin.query(`insert into clued_private.project_lifecycle_v2_dispositions(project_id,user_id,disposition,disposition_reason,recognition_confidence,recognition_source,basis,disposition_hash)
        values($1,$2,'recognized_project','Synthetic isolated database fixture',1,'v2_explicit_create','{}',$3)`,[id,u,digest('project')]);
      await admin.query('commit');
    }
    await admin.query(`insert into auth.sessions(id,user_id,not_after)values($1,$2,now()+interval '1 hour')`,[session,user]);
    const token=crypto.randomBytes(32).toString('hex');
    const binding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','ci-stage1-fixture',$2,array['context:read','context:write'],array['*'])returning id`,[user,token])).rows[0].id;
    const human=await connect('authenticated'),gateway=await connect();
    const claims=(u=user,s=session,extra={})=>({sub:u,role:'authenticated',session_id:s,amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}],...extra});
    const native=async(name,input,c=claims(),client=human)=>{await client.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[c.sub,JSON.stringify(c)]);
      return(await client.query(`select public.${name}($1::jsonb)v`,[JSON.stringify(input)])).rows[0].v;};
    const committed=r=>{assert.equal(r.status,'committed',JSON.stringify(r));return r;};
    const scope='project:'+project;
    const taskResult=await workerGatewayRpc(gateway,'clued_record_mutate',token,{operation:'create',record_type:'task',record_schema_version:1,lifecycle_status:'active',scope,
      idempotency_key:uuid(),authority:'observed',confidence_reason:'synthetic scheduling database fixture',source_refs:[],source_unavailable_reason:'fixture',
      mutation:{title:'CI scheduling fixture',content:'Synthetic database fixture only.',type_fields:{execution_bucket:'next'},relations:{}}});
    const task=committed(taskResult).target_refs[0].id;
    const claimResult=committed(await workerGatewayRpc(gateway,'clued_work_claim_v1',token,{scope,idempotency_key:uuid(),task_id:task,
      write_set:['work/ci-scheduling-fixture/**'],holder_session_ref:'ci-stage1-fixture'}));
    const claim=claimResult.claim;
    claim.execution_epoch=(await admin.query('select execution_epoch from clued_private.work_claims_v1 where claim_id=$1',[claim.claim_id])).rows[0].execution_epoch;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values($1,$2,'ci-admission',clock_timestamp(),$3,clock_timestamp(),'resident-node')`,[user,binding,claimResult.receipt_id]);
    const ci=await connect('anon');
    const jwk=()=>{const {publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});const k=publicKey.export({format:'jwk'});return {crv:k.crv,kty:k.kty,x:k.x,y:k.y};};
    const registration=(p=project)=>({project_id:p,binding_id:binding,name:'Synthetic node',profile:{site_id:'fixture',slot_count:8,environment_kinds:['E1-Linux']},profile_sha256:digest('profile'),identity_public_jwk:jwk(),encryption_public_jwk:jwk(),
      qualification_digest:digest('qualification'),qualification_source:sha('source'),publisher_requested:true,scan_signing_requested:true,idempotency_key:uuid()});
    const register=async(p=project)=>committed(await native('clued_ci_node_registration_v1',registration(p)));
    const approve=async(id,v=1)=>{const issue=await native('clued_ci_node_confirmation_issue_v1',{project_id:project,node_id:id,base_version:v,action:'approve',accepted_ref:'fixture-owner-acceptance'});
      assert.equal(issue.status,'issued');return committed(await native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest}));};
    const pool=async(p=project,repo=12345,cap=100)=>{const view=await native('clued_ci_nodes_v1',{project_id:p});const issue=await native('clued_ci_pool_confirmation_issue_v1',{
      project_id:p,base_version:view.pool.version,repository:{id:repo,name:'fixture/repository-'+repo},limits:limits(cap),accepted_ref:'fixture-pool-acceptance'});
      return native('clued_ci_pool_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest});};
    // G5 (T2A-2): ci_node_current_v1 requires a heartbeat in ci_node_liveness_v1 within 20 minutes.
    const live=async(node,age='0 seconds')=>{const b=(await admin.query('select binding_id from clued_private.ci_nodes_v1 where node_id=$1',[node])).rows[0].binding_id;
      await admin.query(`insert into clued_private.ci_node_liveness_v1(node_id,user_id,last_heartbeat_at,last_sender_binding_id,heartbeat_sequence,reported_state,reported_service_running)
        select $1,user_id,clock_timestamp()-$3::interval,$2,1,'NORMAL',true from clued_private.ci_nodes_v1 where node_id=$1
        on conflict (node_id) do update set last_heartbeat_at=excluded.last_heartbeat_at`,[node,b,age]);};
    const trustedNode=async()=>{const p=registration();p.binding_id=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','ci-stage1-extra-node',$2,array['context:read','context:write'],array['*'])returning id`,[user,crypto.randomBytes(32).toString('hex')])).rows[0].id;
      const r=committed(await native('clued_ci_node_registration_v1',p));await approve(r.node_id);await admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=now(),
      qualification_expires_at=now()+interval '1 hour',eligible_until=now()+interval '1 hour',hardening_observed=true,qualification_receipt_ref='fixture-reviewed-qualification' where node_id=$1`,[r.node_id]);await live(r.node_id);return r.node_id;};
    const modelMode=async(phase=2,cap=100)=>{await admin.query(`update clued_private.ci_quota_counters_v1 set policy=$3 where user_id=$1 and project_id=$2 and row_kind='pool_policy'`,
      [user,project,{mode:phase>=4?'pool_enforced':'resident_mirror',phase,limits:limits(cap),status:'FIXTURE_ONLY'}]);};
    const enqueue=async(extra={},client=admin)=>{const data={repository_id:12345,kind:'combination_execution',task_id:task,claim_id:claim.claim_id,claim_fence:Number(claim.fence),execution_epoch:Number(claim.execution_epoch),target_branch:'main',
      pr_ref:'fixture/repository-12345#1',head_sha:sha(uuid()),base_sha:sha('base'),test_sha:sha('test'),source_sha:sha('source'),combination_sha256:digest(uuid()),role:'batch',...extra};
      const auth=committed(await workerGatewayRpc(gateway,'clued_work_renew_v1',token,{scope,action:'authorize_head',claim_id:claim.claim_id,fence:Number(claim.fence),lease_version:Number(claim.lease_version),
        ...(claimResult.lease_key?{lease_key:claimResult.lease_key}:{}),repository:'fixture/repository-12345',head_sha:data.head_sha,target_branch:data.target_branch,pr_ref:data.pr_ref,idempotency_key:uuid()}));
      const verified=(await ci.query('select public.clued_work_verify_v1($1,$2)v',[token,{scope,claim_id:claim.claim_id,pr_ref:data.pr_ref,head_sha:data.head_sha,target_branch:data.target_branch}])).rows[0].v;
      assert.equal(verified.verdict,'ADMITTED',JSON.stringify(verified));
      data.head_authorization_id=auth.authorization_id;
      data.admission_id=(await admin.query(`select admission_id from clued_private.work_claim_execution_admissions_v1 where claim_id=$1 and head_sha=$2 order by created_at desc limit 1`,[claim.claim_id,data.head_sha])).rows[0].admission_id;
      return(await client.query('select clued_private.ci_job_enqueue_v1($1,$2,$3::jsonb)id',[user,project,JSON.stringify(data)])).rows[0].id;};
    return{admin,human,gateway,connect,close,user,other,project,project2,otherProject,session,binding,token,claims,native,committed,registration,register,approve,pool,trustedNode,live,modelMode,enqueue,claim,task,server};
  }catch(error){await close().catch(()=>{});throw error;}
}
