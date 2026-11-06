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
import {setWorkerGatewayCaller,workerGatewayRpc,assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';
import {testAccountCloud} from './resource-center-account-cloud-db.fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID();
const hash=()=>crypto.randomBytes(32).toString('hex');
async function freePort(){
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  return port;
}

test('handed-over claim: exact head authorization requires the new private key, even on the same Binding',
  {timeout:300000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-handover-execution-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await freePort(),
    persistent:false,postgresFlags:['-c','io_method=sync'],onLog(){},onError(message){process.stderr.write(message+'\n');}});
  const clients=[];
  try{
    await server.initialise(); await server.start();
    const admin=server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
      try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}
      catch(error){throw new Error('Migration '+name+': '+error.message,{cause:error});}
    }
    await allowRawTestBindings(admin);
    await assertGatewayCloseoutBoundary(admin);
    const user=uuid(),token=hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'handover-execution@example.invalid',now())",[user]);
    const binding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','same Binding two sessions',$2,array['context:read','context:write'],array['*']) returning id`,[user,token])).rows[0].id;
    const gateway=server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const call=(name,input)=>workerGatewayRpc(gateway,name,token,input);
    const made=await call('clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,lifecycle_status:'active',
      scope:'global',idempotency_key:uuid(),authority:'observed',confidence_reason:'isolated execution fixture',source_refs:[],
      source_unavailable_reason:'fixture',mutation:{title:'exact head fixture',content:'fixture',type_fields:{execution_bucket:'next'}}});
    assert.equal(made.status,'committed');
    const started=await call('clued_work_claim_v1',{scope:'global',task_id:made.target_refs[0].id,idempotency_key:uuid(),
      holder_label:'execution fixture',holder_session_ref:'first-session',write_set:['fixture/**']});
    assert.equal(started.status,'committed');
    const oldKey=started.lease_key,claim=started.claim;
    const authorize=(key,extra={})=>call('clued_work_renew_v1',{action:'authorize_head',scope:'global',claim_id:claim.claim_id,
      fence:claim.fence,lease_version:claim.lease_version,progress_ref:'head:'+ 'a'.repeat(40),
      repository:'owner/repository',head_sha:'a'.repeat(40),target_branch:'main',idempotency_key:uuid(),
      ...(key===undefined?{}:{lease_key:key}),...extra});
    const before=await authorize(oldKey); assert.equal(before.status,'committed');
    assert.equal((await admin.query('select count(*)::int n from clued_private.work_claim_head_authorizations_v1 where claim_id=$1 and revoked_at is null',[claim.claim_id])).rows[0].n,1);

    const native=server.getPgClient(); clients.push(native); await native.connect(); await native.query('set role authenticated');
    const jwt={sub:user,role:'authenticated',session_id:'owner-session',aal:'aal1',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]};
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify(jwt)]);
    const preview=(await native.query('select public.clued_work_claim_handover_confirmation_issue_v1($1::jsonb) v',[{claim_id:claim.claim_id}])).rows[0].v;
    assert.equal(preview.status,'issued');
    const moved=(await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',[
      {confirmation_token:preview.confirmation_token,view_digest:preview.view_digest}])).rows[0].v;
    assert.equal(moved.status,'committed');
    const current={fence:moved.claim.fence,lease_version:moved.claim.lease_version};
    assert.equal((await authorize(undefined,{...current,holder_session_ref:'forged-new-session'})).error_code,'work_claim_lease_key_required');
    assert.equal((await authorize(oldKey,current)).error_code,'work_claim_lease_key_invalid');
    const fresh=await authorize(moved.lease_key,current); assert.equal(fresh.status,'committed'); assert.equal(fresh.execution_epoch,2);
    assert.equal((await admin.query('select count(*)::int n from clued_private.work_claim_head_authorizations_v1 where claim_id=$1 and revoked_at is null',[claim.claim_id])).rows[0].n,1);
    const receipts=(await admin.query("select metadata from public.clued_audit_receipts where user_id=$1 and operation='work_claim_authorize_head'",[user])).rows;
    const rows=(await admin.query('select to_jsonb(a) v from clued_private.work_claim_head_authorizations_v1 a where claim_id=$1',[claim.claim_id])).rows;
    for(const secret of [oldKey,moved.lease_key,crypto.createHash('sha256').update(moved.lease_key).digest('hex')]){
      assert.equal(JSON.stringify([receipts,rows,fresh]).includes(secret),false,'no private key or key hash in authorization data');
    }
    const replayId=uuid();
    const one=await authorize(moved.lease_key,{...current,idempotency_key:replayId});
    const two=await authorize(moved.lease_key,{...current,idempotency_key:replayId});
    assert.equal(one.authorization_id,two.authorization_id); assert.equal(two.replayed,true);
    const different=await authorize(moved.lease_key,{...current,idempotency_key:replayId,head_sha:'b'.repeat(40)});
    assert.equal(different.error_code,'work_claim_authorization_idempotency_conflict');
    // The CI transport gets no key. It consumes the exact server grant, and
    // read-only verify never claims to authorize an execution.
    const ciToken=hash();
    const ciBinding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','dedicated CI',$2,array['context:read'],array['*']) returning id`,[user,ciToken])).rows[0].id;
    const grantReceipt=(await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`,[user,ciBinding])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',clock_timestamp(),$3)`,[user,ciBinding,grantReceipt]);
    const ci=server.getPgClient();clients.push(ci);await ci.connect();await ci.query('set role anon');
    const verify=async(input)=>(await ci.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v',
      [ciToken,{scope:'global',claim_id:claim.claim_id,...input}])).rows[0].v;
    await admin.query("update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),qualification_commit=$1",['f'.repeat(40)]);
    const read=await verify({});assert.equal(read.verdict,'ADMITTED');assert.equal(read.execution_authorized,false);
    const wanted={pr_ref:'owner/repository#7',head_sha:'a'.repeat(40),target_branch:'main',changed_paths:['fixture/file']};
    const admitted=await verify(wanted);assert.equal(admitted.verdict,'ADMITTED');assert.equal(admitted.execution_authorized,true);
    const observe=async(extra={})=>(await ci.query('select public.clued_work_verify_v1(null,$1::jsonb) v',
      [{action:'execution_current',repository:'owner/repository',head_sha:wanted.head_sha,pr_ref:wanted.pr_ref,target_branch:'main',...extra}])).rows[0].v;
    assert.deepEqual(await observe(),{status:'ok',guard_required:true,epoch_current:true});
    assert.equal((await observe({target_branch:'other'})).epoch_current,false);
    assert.deepEqual(await observe({repository:'unknown/repo',pr_ref:'unknown/repo#7'}),
      {status:'ok',guard_required:false,epoch_current:null});
    const storageGate=async(ref)=>(await admin.query(`select clued_private.work_claim_gate_v1($1,$2,'clued-storage',
      'storage_submit','collision_only','{}'::text[],$3::jsonb) v`,[user,binding,ref])).rows[0].v;
    assert.equal((await storageGate({claim_id:claim.claim_id,fence:current.fence})).error_code,'work_claim_lease_key_required');
    assert.equal((await storageGate({claim_id:claim.claim_id,fence:current.fence,lease_key:oldKey})).error_code,'work_claim_lease_key_invalid');
    assert.equal(await storageGate({claim_id:claim.claim_id,fence:current.fence,lease_key:moved.lease_key}),null);
    assert.equal((await storageGate({claim_id:uuid(),fence:1})).error_code,'work_claim_not_found');
    assert.equal((await verify({...wanted,head_sha:'b'.repeat(40)})).verdict,'REJECTED');
    assert.equal((await verify({...wanted,target_branch:'other'})).verdict,'REJECTED');
    assert.equal((await verify({...wanted,pr_ref:'another/repository#7'})).verdict,'REJECTED');
    assert.equal((await verify({...wanted,pr_ref:'owner/repository#8'})).verdict,'REJECTED');
    assert.equal((await verify({...wanted,changed_paths:['outside/file']})).verdict,'REJECTED');
    // Every historical head is captured, and an in-flight publication must
    // be settled before the trusted external revoker can acknowledge it.
    assert.equal((await authorize(moved.lease_key,{...current,head_sha:'b'.repeat(40),pr_ref:wanted.pr_ref})).status,'committed');
    assert.equal((await verify({...wanted,head_sha:'b'.repeat(40)})).verdict,'ADMITTED');
    const command=async input=>(await ci.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v',
      [ciToken,{scope:'global',...input}])).rows[0].v;
    const ticket=await command({action:'publication_begin',claim_id:claim.claim_id,...wanted,run_id:'42',publication_key:uuid()});
    assert.equal(ticket.publication_required,true);assert.ok(ticket.publication_id);
    assert.ok(ticket.receipt_id);
    const againPreview=(await native.query('select public.clued_work_claim_handover_confirmation_issue_v1($1::jsonb) v',
      [{claim_id:claim.claim_id}])).rows[0].v;
    const handoverInput={confirmation_token:againPreview.confirmation_token,view_digest:againPreview.view_digest};
    const pending=(await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',[handoverInput])).rows[0].v;
    assert.equal(pending.status,'pending');assert.equal('lease_key' in pending,false);
    assert.equal(pending.execution_epoch,3);assert.equal(pending.claim.fence,current.fence+1);
    assert.equal((await observe()).epoch_current,false);
    const batch=await command({action:'revocations_list'});
    assert.deepEqual([...new Set(batch.revocations.map(x=>x.head_sha).filter(Boolean))].sort(),['a'.repeat(40),'b'.repeat(40)]);
    assert.equal(batch.publications[0].publication_id,ticket.publication_id);
    assert.deepEqual((await command({action:'revocations_contexts'})).context_keys,['global']);
    // Discovery comes from durable pending work, even without a live claim.
    await admin.query('update clued_private.work_claims_v1 set issued_at=least(issued_at,clock_timestamp()-interval \'2 seconds\'),expires_at=clock_timestamp()-interval \'1 second\' where claim_id=$1',[claim.claim_id]);
    assert.deepEqual((await command({action:'revocations_contexts'})).context_keys,['global']);
    assert.equal((await command({action:'revocations_list'})).publications[0].publication_id,ticket.publication_id);
    await admin.query('update clued_private.work_claims_v1 set expires_at=clock_timestamp()+interval \'1 hour\' where claim_id=$1',[claim.claim_id]);
    // More than 100 durable rows must not disappear behind a truncated page.
    const syntheticOutboxes=[];
    for(let n=0;n<105;n++){
      const id=uuid();syntheticOutboxes.push(id);
      await admin.query(`insert into clued_private.work_claim_revocation_outbox_v1
        (outbox_id,user_id,claim_id,context_key,execution_epoch,repository,head_sha)
        values($1,$2,$3,'global',3,'pagination/repo',$4)`,[id,user,claim.claim_id,n.toString(16).padStart(40,'0')]);
    }
    let cursor;const allOutboxes=[];
    do{
      const page=await command({action:'revocations_list',...(cursor?{outbox_cursor:cursor}:{})});
      assert.ok(page.revocations.length<=100);allOutboxes.push(...page.revocations.map(x=>x.outbox_id));cursor=page.next_outbox_cursor;
    }while(cursor);
    assert.equal(new Set(allOutboxes).size,batch.revocations.length+105);
    await admin.query('delete from clued_private.work_claim_revocation_outbox_v1 where outbox_id=any($1::uuid[])',[syntheticOutboxes]);
    const syntheticPublications=[];
    for(let n=0;n<105;n++){
      const id=uuid();syntheticPublications.push(id);
      await admin.query(`insert into clued_private.work_claim_publications_v1
        (publication_id,user_id,claim_id,execution_epoch,repository,head_sha,pr_ref,run_id,publication_key)
        values($1,$2,$3,2,'owner/repository',$4,'owner/repository#7','123',$5)`,[id,user,claim.claim_id,'a'.repeat(40),uuid()]);
    }
    cursor=undefined;const allPublications=[];
    do{
      const page=await command({action:'revocations_list',...(cursor?{publication_cursor:cursor}:{})});
      assert.ok(page.publications.length<=100);allPublications.push(...page.publications.map(x=>x.publication_id));cursor=page.next_publication_cursor;
    }while(cursor);
    assert.equal(new Set(allPublications).size,106);
    await admin.query('delete from clued_private.work_claim_publications_v1 where publication_id=any($1::uuid[])',[syntheticPublications]);
    assert.equal((await call('clued_work_verify_v1',{scope:'global',action:'revocations_list'})).error_code,'admission_binding_required');
    const acknowledgment={action:'revocation_ack',outbox_id:batch.revocations[0].outbox_id,execution_epoch:3,
      evidence:{checks_revoked:true,auto_merge_disabled:true,dispatch_revoked:true}};
    assert.equal((await command(acknowledgment)).error_code,'work_claim_publications_unresolved');
    const collect=async()=> (await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',
      [{action:'collect',delivery_id:pending.delivery_id}])).rows[0].v;
    assert.equal((await collect()).status,'pending');
    const ownerList=async()=>(await native.query('select public.clued_work_claims_owner_list_v1($1::jsonb) v',[{}])).rows[0].v;
    assert.equal((await ownerList()).claims.find(x=>x.claim_id===claim.claim_id).handover_pending_delivery_id,pending.delivery_id);
    await native.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({...jwt,session_id:'other-owner-session'})]);
    assert.equal((await ownerList()).claims.find(x=>x.claim_id===claim.claim_id).handover_pending_delivery_id,null);
    assert.equal((await collect()).error_code,'work_claim_handover_stale');
    await native.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(jwt)]);
    const late=await command({action:'publication_finish',publication_id:ticket.publication_id,check_run_id:'99'});
    assert.equal(late.must_revoke,true,'a late green publisher must revoke its own check');
    assert.equal((await command(acknowledgment)).error_code,'work_claim_publications_unresolved');
    assert.equal((await command({action:'publication_reconcile',publication_id:ticket.publication_id,
      publisher_stopped:true,checks_revoked:true})).error_code,'work_claim_publication_unresolved');
    const reconciled=await command({action:'publication_reconcile',publication_id:ticket.publication_id,
      check_run_id:'99',publisher_stopped:true,checks_revoked:true});
    assert.equal(reconciled.status,'committed');assert.ok(reconciled.receipt_id);
    assert.equal((await command({action:'publication_reconcile',publication_id:ticket.publication_id,
      check_run_id:'99',publisher_stopped:true,checks_revoked:true})).receipt_id,reconciled.receipt_id);
    assert.equal((await command({...acknowledgment,evidence:{checks_revoked:true}})).error_code,'work_claim_revocation_incomplete');
    for(const item of batch.revocations){
      const ack=await command({...acknowledgment,outbox_id:item.outbox_id});
      assert.equal(ack.status,'committed');assert.ok(ack.receipt_id);
      assert.equal((await command({...acknowledgment,outbox_id:item.outbox_id})).receipt_id,ack.receipt_id);
    }
    const replayPending=(await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',[handoverInput])).rows[0].v;
    assert.equal(replayPending.status,'pending');assert.equal('lease_key' in replayPending,false);
    const completed=await collect();assert.equal(completed.status,'committed');assert.match(completed.lease_key,/^clued_lk_/);
    assert.equal((await observe()).epoch_current,false,'previous CI admission never follows the new fence');
    assert.equal((await collect()).error_code,'work_claim_handover_text_already_delivered');
    assert.equal((await native.query('select public.clued_work_claim_handover_v1($1::jsonb) v',[handoverInput])).rows[0].v.error_code,
      'work_claim_handover_text_already_delivered');
    const oldAttempt=await call('clued_work_renew_v1',{scope:'global',claim_id:claim.claim_id,fence:completed.claim.fence,
      lease_version:completed.claim.lease_version,progress_ref:uuid(),lease_key:moved.lease_key});
    assert.equal(oldAttempt.error_code,'work_claim_lease_key_invalid');
    const ordinary=await call('clued_work_renew_v1',{scope:'global',claim_id:claim.claim_id,fence:completed.claim.fence,
      lease_version:completed.claim.lease_version,progress_ref:uuid(),lease_key:completed.lease_key});
    assert.equal(ordinary.status,'committed');
    assert.equal((await admin.query('select execution_epoch from clued_private.work_claims_v1 where claim_id=$1',[claim.claim_id])).rows[0].execution_epoch,'3');
    assert.equal((await authorize(completed.lease_key,{fence:ordinary.claim.fence,lease_version:ordinary.claim.lease_version,
      pr_ref:wanted.pr_ref})).status,'committed');
    assert.equal((await verify(wanted)).verdict,'ADMITTED');
    assert.equal((await observe()).epoch_current,true,'fresh private authorization and fresh CI admission qualify the new epoch');
    // Pending always denies new execution, including same-Binding renewal.
    await admin.query('update clued_private.work_claims_v1 set execution_handover_pending=true where claim_id=$1',[claim.claim_id]);
    assert.equal((await verify(wanted)).reasons.includes('work_claim_handover_pending'),true);
    const pendingRenew=await call('clued_work_renew_v1',{scope:'global',claim_id:claim.claim_id,
      fence:ordinary.claim.fence,lease_version:ordinary.claim.lease_version,progress_ref:uuid(),lease_key:completed.lease_key});
    assert.equal(pendingRenew.error_code,'work_claim_handover_pending');
    const pendingRelease=await call('clued_work_release_v1',{scope:'global',claim_id:claim.claim_id,
      fence:ordinary.claim.fence,outcome:'completed',lease_key:completed.lease_key});
    assert.equal(pendingRelease.error_code,'work_claim_handover_pending');
    await assert.rejects(admin.query('update clued_private.work_claim_execution_policy_v1 set activated_at=null'),
      /work_claim_execution_cannot_restore_legacy_access/);
    assert.equal((await admin.query('select holder_binding_id from clued_private.work_claims_v1 where claim_id=$1',[claim.claim_id])).rows[0].holder_binding_id,binding);
    await assertGatewayCloseoutBoundary(admin);
  }finally{
    for(const client of clients)await client.end().catch(()=>{});
    await stopCluster(server); await removeTestDirectory(dir);
  }
});

test('no-page handover: private receiving proof, default On, Off enforced, no identity-by-session',
  {timeout:300000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-free-handover-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await freePort(),
    persistent:false,postgresFlags:['-c','io_method=sync'],onLog(){},onError(message){process.stderr.write(message+'\n');}});
  const clients=[];
  try{
    await server.initialise();await server.start();
    const admin=server.getPgClient();clients.push(admin);await admin.connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;
      create role service_role nologin bypassrls;create role authenticator nologin noinherit;
      create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort())
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
    await allowRawTestBindings(admin);
    const owner=uuid(),token=hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'free-handover@example.invalid',now())",[owner]);
    const binding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','shared Binding',$2,array['context:read','context:write'],array['*']) returning id`,[owner,token])).rows[0].id;
    const gw=server.getPgClient();clients.push(gw);await gw.connect();await setWorkerGatewayCaller(gw);
    const call=(name,input)=>workerGatewayRpc(gw,name,token,input);
    const create=async()=>{
      const task=await call('clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,
        lifecycle_status:'active',scope:'global',idempotency_key:uuid(),authority:'observed',confidence_reason:'isolated handover',
        source_refs:[],source_unavailable_reason:'fixture',mutation:{title:'voluntary handover',content:'fixture',type_fields:{execution_bucket:'next'}}});
      return call('clued_work_claim_v1',{scope:'global',task_id:task.target_refs[0].id,idempotency_key:uuid(),
        holder_label:'sender',holder_session_ref:'sender',write_set:['fixture/**']});
    };
    const started=await create(),claim=started.claim;
    const renew=input=>call('clued_work_renew_v1',{scope:'global',claim_id:claim.claim_id,fence:claim.fence,
      lease_version:claim.lease_version,progress_ref:uuid(),...input});
    const native=server.getPgClient();clients.push(native);await native.connect();await native.query('set role authenticated');
    const jwt={sub:owner,role:'authenticated',session_id:'owner-setting',aal:'aal1',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]};
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify(jwt)]);
    const setting=(await native.query('select public.clued_work_free_handover_setting_v1($1::jsonb) v',[{}])).rows[0].v;
    assert.equal(setting.enabled,true);assert.equal(setting.version,0);assert.equal(setting.default,true);
    await assert.rejects(gw.query('select public.clued_work_free_handover_setting_set_v1($1::jsonb)',[{enabled:false,base_version:0}]),/permission denied/);
    assert.equal((await renew({action:'prepare_handover',idempotency_key:uuid(),holder_label:'receiver'})).error_code,'work_claim_handover_not_ready');
    await admin.query("update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),qualification_commit=$1",['f'.repeat(40)]);
    const restrictedToken=hash();
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','read only receiver',$2,array['context:read'],array['*'])`,[owner,restrictedToken]);
    await assert.rejects(workerGatewayRpc(gw,'clued_work_renew_v1',restrictedToken,
      {scope:'global',action:'prepare_handover',claim_id:claim.claim_id,fence:claim.fence,holder_label:'readonly',idempotency_key:uuid()}),
      /authorized|scope|permission|binding/);
    const expired=await renew({action:'prepare_handover',idempotency_key:uuid(),holder_label:'expired request'});
    await admin.query("update clued_private.work_claim_handover_requests_v1 set expires_at=clock_timestamp()-interval '1 second' where request_id=$1",
      [expired.request_id]);
    assert.equal((await renew({action:'offer_handover',request_id:expired.request_id,lease_key:started.lease_key})).error_code,
      'work_claim_handover_stale');
    const revokedToken=hash();
    const revokedBinding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','revoked receiver',$2,array['context:read','context:write'],array['*']) returning id`,[owner,revokedToken])).rows[0].id;
    const revocable=await workerGatewayRpc(gw,'clued_work_renew_v1',revokedToken,
      {scope:'global',action:'prepare_handover',claim_id:claim.claim_id,fence:claim.fence,holder_label:'revocable',idempotency_key:uuid()});
    await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[revokedBinding]);
    await assert.rejects(renew({action:'offer_handover',request_id:revocable.request_id,lease_key:started.lease_key}),
      /revoked|authorized|binding/);
    const prepareKey=uuid();
    const prepared=await renew({action:'prepare_handover',idempotency_key:prepareKey,holder_label:'receiver',holder_session_ref:'receiver'});
    assert.equal(prepared.status,'committed');assert.match(prepared.receiver_key,/^clued_lk_[0-9a-f]{64}$/);
    const replay=await renew({action:'prepare_handover',idempotency_key:prepareKey,holder_label:'receiver',holder_session_ref:'receiver'});
    assert.equal(replay.request_id,prepared.request_id);assert.equal(replay.receiver_key_unavailable,true);assert.equal('receiver_key' in replay,false);
    assert.equal((await renew({action:'accept_handover',request_id:prepared.request_id,receiver_key:prepared.receiver_key})).error_code,'work_claim_handover_not_offered');
    assert.equal((await renew({action:'offer_handover',request_id:prepared.request_id,holder_session_ref:'sender'})).error_code,'work_claim_lease_key_required');
    assert.equal((await renew({action:'offer_handover',request_id:prepared.request_id,lease_key:'clued_lk_'+hash()})).error_code,'work_claim_lease_key_invalid');
    assert.equal((await renew({action:'offer_handover',request_id:prepared.request_id,lease_key:started.lease_key})).status,'committed');
    assert.equal((await renew({action:'accept_handover',request_id:prepared.request_id,holder_session_ref:'receiver'})).error_code,'work_claim_handover_receiver_invalid');
    const accepted=await renew({action:'accept_handover',request_id:prepared.request_id,receiver_key:prepared.receiver_key});
    assert.equal(accepted.status,'committed');assert.match(accepted.lease_key,/^clued_lk_[0-9a-f]{64}$/);
    assert.equal(accepted.claim.claim_id,claim.claim_id);assert.equal(accepted.claim.fence,claim.fence+1);
    assert.equal(accepted.claim.holder_session_ref,'receiver');assert.equal(accepted.execution_epoch,2);
    assert.equal((await renew({fence:accepted.claim.fence,lease_version:accepted.claim.lease_version,lease_key:started.lease_key})).error_code,'work_claim_lease_key_invalid');
    const publicView=(await admin.query('select clued_private.work_claim_view(w) v from clued_private.work_claims_v1 w where claim_id=$1',[claim.claim_id])).rows[0].v;
    const audit=(await admin.query('select metadata from public.clued_audit_receipts where user_id=$1',[owner])).rows;
    for(const secret of [started.lease_key,prepared.receiver_key,accepted.lease_key,
      crypto.createHash('sha256').update(prepared.receiver_key).digest('hex')])
      assert.equal(JSON.stringify([publicView,audit]).includes(secret),false,'no key or capability hash in public data');
    const off=(await native.query('select public.clued_work_free_handover_setting_set_v1($1::jsonb) v',[{enabled:false,base_version:0}])).rows[0].v;
    assert.equal(off.enabled,false);assert.equal(off.version,1);
    const blocked=await renew({action:'prepare_handover',idempotency_key:uuid(),holder_label:'another',fence:accepted.claim.fence});
    assert.equal(blocked.error_code,'work_claim_free_handover_disabled');
    const stale=(await native.query('select public.clued_work_free_handover_setting_set_v1($1::jsonb) v',[{enabled:true,base_version:0}])).rows[0].v;
    assert.equal(stale.error_code,'work_claim_handover_setting_version_conflict');
    // A previous receiving capability remains bound to that accepted operation;
    // recovering its uncertain response rotates the key, without another page.
    const recovered=await renew({action:'accept_handover',request_id:prepared.request_id,receiver_key:prepared.receiver_key});
    assert.equal(recovered.status,'committed');assert.notEqual(recovered.lease_key,accepted.lease_key);
    const on=(await native.query('select public.clued_work_free_handover_setting_set_v1($1::jsonb) v',
      [{enabled:true,base_version:1}])).rows[0].v;
    assert.equal(on.enabled,true);assert.equal(on.available,true);
    const receiverToken=hash();
    const receiverBinding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','cross Binding receiver',$2,array['context:read','context:write'],array['*']) returning id`,[owner,receiverToken])).rows[0].id;
    const receiving=input=>workerGatewayRpc(gw,'clued_work_renew_v1',receiverToken,
      {scope:'global',claim_id:claim.claim_id,fence:recovered.claim.fence,...input});
    const cross=await receiving({action:'prepare_handover',idempotency_key:uuid(),holder_label:'cross receiver',holder_session_ref:'cross-session'});
    assert.equal(cross.status,'committed');
    const offered=await renew({action:'offer_handover',request_id:cross.request_id,fence:recovered.claim.fence,lease_key:recovered.lease_key});
    assert.equal(offered.status,'committed');
    assert.equal((await renew({action:'accept_handover',request_id:cross.request_id,fence:recovered.claim.fence,receiver_key:cross.receiver_key})).error_code,
      'work_claim_handover_receiver_invalid','even a private receiving capability is bound to its exact receiver Binding');
    assert.equal((await receiving({action:'accept_handover',request_id:cross.request_id,holder_session_ref:'cross-session'})).error_code,
      'work_claim_handover_receiver_invalid');
    const otherOwner=uuid(),otherToken=hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'other-owner@example.invalid',now())",[otherOwner]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','other owner',$2,array['context:read','context:write'],array['*'])`,[otherOwner,otherToken]);
    assert.equal((await workerGatewayRpc(gw,'clued_work_renew_v1',otherToken,
      {action:'accept_handover',scope:'global',request_id:cross.request_id,receiver_key:cross.receiver_key})).error_code,
      'work_claim_handover_request_not_found');
    const fillers=[];
    for(let i=0;i<3;i++){
      const task=(await call('clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,
        lifecycle_status:'active',scope:'global',idempotency_key:uuid(),authority:'observed',confidence_reason:'quota fixture',
        source_refs:[],source_unavailable_reason:'fixture',mutation:{title:'quota '+i,content:'fixture',type_fields:{execution_bucket:'next'}}})).target_refs[0].id;
      const filler=(await admin.query(`insert into clued_private.work_claims_v1(user_id,task_id,context_key,holder_binding_id,
        holder_session_ref,write_set,fence,issued_at,expires_at,hard_deadline_at,status,idempotency_key)
        values($1,$2,'global',$3,'cross-session',$4,1,clock_timestamp(),clock_timestamp()+interval '1 hour',
        clock_timestamp()+interval '1 day','ACTIVE',$5) returning claim_id`,[owner,task,receiverBinding,['quota/'+i],uuid()])).rows[0].claim_id;
      fillers.push(filler);
    }
    assert.equal((await receiving({action:'accept_handover',request_id:cross.request_id,receiver_key:cross.receiver_key})).error_code,
      'work_claim_budget_exhausted');
    await admin.query("update clued_private.work_claims_v1 set status='RELEASED',released_outcome='abandoned' where claim_id=any($1::uuid[])",[fillers]);
    const movedAcross=await receiving({action:'accept_handover',request_id:cross.request_id,receiver_key:cross.receiver_key});
    assert.equal(movedAcross.status,'committed');assert.equal(movedAcross.claim.fence,recovered.claim.fence+1);
    assert.equal(movedAcross.claim.task_id,claim.task_id);assert.equal(movedAcross.execution_epoch,3);
    assert.equal((await admin.query('select holder_binding_id from clued_private.work_claims_v1 where claim_id=$1',[claim.claim_id])).rows[0].holder_binding_id,
      receiverBinding);
    assert.notEqual((await renew({fence:movedAcross.claim.fence,lease_version:movedAcross.claim.lease_version,
      lease_key:recovered.lease_key})).status,'committed','old holder cannot act on the new private key generation');
    const contenders=[];
    for(const name of ['a','b']){
      const proof=hash();
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*'])`,[owner,'concurrent '+name,proof]);
      const client=server.getPgClient();clients.push(client);await client.connect();await setWorkerGatewayCaller(client);
      const command=input=>workerGatewayRpc(client,'clued_work_renew_v1',proof,{scope:'global',...input});
      const request=await command({action:'prepare_handover',claim_id:claim.claim_id,fence:movedAcross.claim.fence,
        holder_label:'candidate '+name,holder_session_ref:'candidate-'+name,idempotency_key:uuid()});
      assert.equal(request.status,'committed');
      assert.equal((await receiving({action:'offer_handover',request_id:request.request_id,fence:movedAcross.claim.fence,
        lease_key:movedAcross.lease_key})).status,'committed');
      contenders.push({command,request});
    }
    const raced=await Promise.all(contenders.map(({command,request})=>command({action:'accept_handover',
      request_id:request.request_id,receiver_key:request.receiver_key})));
    assert.equal(raced.filter(x=>x.status==='committed').length,1);
    assert.equal(raced.filter(x=>x.error_code==='work_claim_handover_stale').length,1);
    assert.equal(raced.find(x=>x.status==='committed').claim.fence,movedAcross.claim.fence+1);
    assert.equal((await admin.query('select execution_epoch from clued_private.work_claims_v1 where claim_id=$1',[claim.claim_id])).rows[0].execution_epoch,'4');
    await assertGatewayCloseoutBoundary(admin);
    assert.notEqual(receiverBinding,binding);
  }finally{for(const c of clients)await c.end().catch(()=>{});await stopCluster(server);await removeTestDirectory(dir);}
});

test('async storage handover uses the actual cloud executor and original recovery journal',{timeout:300000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-storage-handover-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await freePort(),persistent:false,
    postgresFlags:['-c','io_method=sync'],onLog(){},onError(message){process.stderr.write(message+'\n');}});
  let admin;
  try{
    await server.initialise();await server.start();admin=server.getPgClient();await admin.connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort())
      await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
    await allowRawTestBindings(admin);
    const user=uuid(),project=uuid(),decision=uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'storage-handover@example.invalid',now())",[user]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,'Handover storage fixture','handover storage fixture',$3,'confirmed',now())`,[project,user,'project:'+project]);
    await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Owner test approval','isolated fixture','project',$3,'decision','active',1,'active',$4,
      '{"rationale":"fixture only"}','{}','{}','user_explicit','fixture')`,[decision,user,project,'project:'+project]);
    await testAccountCloud(t,admin,server,user,decision,{handoverOnly:true});
    await assertGatewayCloseoutBoundary(admin);
  }finally{await admin?.end().catch(()=>{});await stopCluster(server);await removeTestDirectory(dir);}
});
