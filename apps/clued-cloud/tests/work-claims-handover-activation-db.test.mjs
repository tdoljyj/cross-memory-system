import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {setWorkerGatewayCaller,workerGatewayRpc,assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';

const app = new URL('../', import.meta.url);
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
test('qualified activation drains legacy execution, preserves private holder and never completes later handover', {timeout:300000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'clued-activation-candidate-'));
  const server = newCluster({databaseDir:dir,user:'postgres',password:hash(),
    persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(message){process.stderr.write(message+'\n');}});
  const clients=[];
  try {
    await startCluster(server);
    const admin=server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create role authenticator nologin noinherit;create schema auth;create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for(const file of (await fs.readdir(new URL('supabase/migrations/',app))).filter(x=>x.endsWith('.sql')).sort())
      await admin.query(await fs.readFile(new URL('supabase/migrations/'+file,app),'utf8'));
    await allowRawTestBindings(admin); await assertGatewayCloseoutBoundary(admin);
    const user=uuid(), token=hash(), ciToken=hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'activation@example.invalid',now())",[user]);
    const binding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','holder',$2,array['context:read','context:write'],array['*']) returning id`,[user,token])).rows[0].id;
    const ciBinding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','CI',$2,array['context:read'],array['*']) returning id`,[user,ciToken])).rows[0].id;
    const receipt=(await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture','binding',$2,1,'{}','committed') returning id`,[user,ciBinding])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',clock_timestamp(),$3)`,[user,ciBinding,receipt]);
    const gw=server.getPgClient();clients.push(gw);await gw.connect();await setWorkerGatewayCaller(gw);
    const call=(name,input)=>workerGatewayRpc(gw,name,token,input);
    const createTask=async title=>(await call('clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,
      lifecycle_status:'active',scope:'global',idempotency_key:uuid(),authority:'observed',confidence_reason:'fixture',source_refs:[],
      source_unavailable_reason:'isolated synthetic fixture',mutation:{title,content:'fixture',type_fields:{execution_bucket:'next'}}})).target_refs[0].id;
    const task=await createTask('guarded lineage');
    const claim=async (taskId,resource)=>call('clued_work_claim_v1',{scope:'global',task_id:taskId,idempotency_key:uuid(),
      holder_label:'holder',holder_session_ref:'fixture',write_set:[resource]});
    const first=await claim(task,'fixture/**');assert.equal(first.status,'committed');
    const native=server.getPgClient();clients.push(native);await native.connect();await native.query('set role authenticated');
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [user,JSON.stringify({sub:user,role:'authenticated',session_id:'owner-fixture',aal:'aal1',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})]);
    const handover=async id=>{
      const p=(await native.query('select public.clued_work_claim_handover_confirmation_issue_v1($1::jsonb) v',[{claim_id:id}])).rows[0].v;
      const input={confirmation_token:p.confirmation_token,view_digest:p.view_digest};
      return {input,result:(await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',[input])).rows[0].v};
    };
    const moved=(await handover(first.claim.claim_id)).result;assert.equal(moved.status,'committed');
    const ci=server.getPgClient();clients.push(ci);await ci.connect();await ci.query('set role anon');
    const command=async input=>(await ci.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v',
      [ciToken,{scope:'global',...input}])).rows[0].v;
    const admit=async (c,pr,head)=>command({claim_id:c.claim_id,pr_ref:pr,head_sha:head,target_branch:'main',changed_paths:['fixture/file']});
    assert.equal((await admit(moved.claim,'owner/repository#7','a'.repeat(40))).verdict,'ADMITTED');
    assert.equal((await call('clued_work_release_v1',{scope:'global',claim_id:moved.claim.claim_id,fence:moved.claim.fence,
      lease_key:moved.lease_key,outcome:'completed',evidence_ref:'receipt:'+receipt})).status,'committed');
    const next=await claim(task,'fixture/**');assert.equal(next.status,'committed');assert.equal(next.claim.lease_key_required,false);
    assert.equal((await admit(next.claim,'owner/repository#8','b'.repeat(40))).verdict,'ADMITTED');
    const unrelated=await claim(await createTask('ordinary unrelated'),'ordinary/**');assert.equal(unrelated.status,'committed');
    const dispatchStart=await claim(await createTask('guarded dispatch'),'dispatch/**');assert.equal(dispatchStart.status,'committed');
    const dispatch=(await handover(dispatchStart.claim.claim_id)).result;assert.equal(dispatch.status,'committed');
    await admin.query('update clued_private.work_claims_v1 set admitted_heads=$2::text[] where claim_id=$1',
      [dispatch.claim.claim_id,['e'.repeat(40)]]);
    const before=(await admin.query(`select claim_id,fence,lease_version,lease_key_hash,bound_pr,admitted_heads,renewals,
      expires_at,hard_deadline_at,write_set,trigger_refs,copy_index from clued_private.work_claims_v1 order by claim_id`)).rows;
    // A metered historical head can predate the new admission table and no
    // longer appear in the current PR ancestry. It still needs explicit drain.
    await admin.query('update clued_private.work_claims_v1 set admitted_heads=admitted_heads||$2::text where claim_id=$1',
      [moved.claim.claim_id,'d'.repeat(40)]);
    before.find(row=>row.claim_id===moved.claim.claim_id).admitted_heads.push('d'.repeat(40));
    assert.equal((await admin.query('select activated_at from clued_private.work_claim_execution_policy_v1')).rows[0].activated_at,null);
    await assert.rejects(admin.query('select clued_private.work_claim_execution_activate_v1($1)', ['invalid']),/qualification_invalid/);
    const caller=server.getPgClient();clients.push(caller);await caller.connect();await caller.query('set role anon');
    await assert.rejects(caller.query('select clued_private.work_claim_execution_activate_v1($1)', ['f'.repeat(40)]),/permission denied/);
    await assert.rejects(admin.query('select clued_private.work_claim_execution_activate_v1($1)', ['f'.repeat(40)]),
      /legacy_target_unmapped/,'unbound historical heads cannot silently escape the drain');
    assert.equal((await admin.query('select activated_at from clued_private.work_claim_execution_policy_v1')).rows[0].activated_at,null);
    // The established CI principal supplies a real exact dispatch target while
    // rollout is staged. It does not invent a PR binding or change the key.
    assert.equal((await command({claim_id:dispatch.claim.claim_id,ci_dispatch:true,repository:'owner/repository',
      head_sha:'e'.repeat(40),target_branch:'main',workflow:'clued-g4-database.yml',changed_paths:['dispatch/file']})).verdict,'ADMITTED');
    // Only the isolated fixture's database owner calls this. Production needs
    // a separately approved exact migration bound to real consumer evidence.
    assert.equal((await admin.query('select clued_private.work_claim_execution_activate_v1($1) v',['f'.repeat(40)])).rows[0].v.status,'activated');
    assert.ok((await command({action:'revocations_list'})).revocations.some(row=>row.head_sha==='d'.repeat(40)),
      'historical metered head without a modern admission must be explicitly revoked');
    assert.ok((await command({action:'revocations_list'})).revocations.some(row=>row.head_sha==='e'.repeat(40)
      && row.pr_ref===null && row.workflow==='clued-g4-database.yml'),'unbound dispatch uses its actual target');
    assert.deepEqual((await admin.query(`select claim_id,fence,lease_version,lease_key_hash,bound_pr,admitted_heads,renewals,
      expires_at,hard_deadline_at,write_set,trigger_refs,copy_index from clued_private.work_claims_v1 order by claim_id`)).rows,before);
    const state=async id=>(await admin.query('select lease_key_required,execution_epoch,execution_handover_pending from clued_private.work_claims_v1 where claim_id=$1',[id])).rows[0];
    assert.equal((await state(next.claim.claim_id)).lease_key_required,true);
    assert.equal((await state(next.claim.claim_id)).execution_handover_pending,true);
    assert.equal((await state(unrelated.claim.claim_id)).lease_key_required,false);
    const authorize=()=>call('clued_work_renew_v1',{action:'authorize_head',scope:'global',claim_id:next.claim.claim_id,
      fence:next.claim.fence,lease_version:next.claim.lease_version,lease_key:next.lease_key,repository:'owner/repository',
      pr_ref:'owner/repository#8',head_sha:'b'.repeat(40),target_branch:'main',idempotency_key:uuid()});
    assert.equal((await authorize()).error_code,'work_claim_handover_pending');
    const acknowledge=async()=>{
      const outboxes=(await command({action:'revocations_list'})).revocations;
      assert.ok(outboxes.length);
      for(const outbox of outboxes) assert.equal((await command({action:'revocation_ack',outbox_id:outbox.outbox_id,
        execution_epoch:outbox.execution_epoch,evidence:{checks_revoked:true,auto_merge_disabled:true,dispatch_revoked:true}})).status,'committed');
    };
    await acknowledge();assert.equal((await state(next.claim.claim_id)).execution_handover_pending,false);
    assert.equal((await authorize()).status,'committed');
    assert.equal((await admit(next.claim,'owner/repository#8','b'.repeat(40))).verdict,'ADMITTED');
    const realHandover=await handover(next.claim.claim_id);assert.equal(realHandover.result.status,'pending');
    await acknowledge();
    assert.equal((await state(next.claim.claim_id)).execution_handover_pending,true,'activation ACK cannot collect a later receiving delivery');
    assert.deepEqual((await admin.query(`select
      (select count(*) from clued_private.work_claim_revocation_outbox_v1 where state='pending')::int pending_outboxes,
      (select count(*) from clued_private.work_claim_publications_v1 where state='open')::int open_publications`)).rows[0],
      {pending_outboxes:0,open_publications:0});
    const collected=(await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',
      [{action:'collect',delivery_id:realHandover.result.delivery_id}])).rows[0].v;
    assert.equal(collected.status,'committed');assert.ok(collected.lease_key);
    assert.equal((await call('clued_work_release_v1',{scope:'global',claim_id:collected.claim.claim_id,
      fence:collected.claim.fence,lease_key:collected.lease_key,outcome:'completed',evidence_ref:'receipt:'+collected.receipt_id})).status,'committed');
    const future=await claim(task,'fixture/**');assert.equal(future.status,'committed');assert.equal(future.claim.lease_key_required,true);
    assert.equal((await call('clued_work_release_v1',{scope:'global',claim_id:future.claim.claim_id,
      fence:future.claim.fence,outcome:'completed',evidence_ref:'receipt:'+collected.receipt_id})).error_code,'work_claim_lease_key_required');
    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for(const client of clients) await client.end().catch(()=>{});
    await stopCluster(server);await removeTestDirectory(dir);
  }
});
