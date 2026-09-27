import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
const hash = value => createHash("sha256").update(value).digest("hex");
export async function testAccountRefresh(t, admin, server, user, decision) {
  const session = randomUUID(), issuer = hash(randomUUID());
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session,user]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1 values($1,'refresh-fixture-client','https://clued.invalid/storage/google/callback',null)", [issuer]);
  const native=server.getPgClient(), background=server.getPgClient(); await native.connect(); await background.connect();
  await native.query("set role authenticated"); await background.query("set role anon");
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user,JSON.stringify({sub:user,session_id:session})]);
  const project=(await admin.query("select project_id from public.clued_memories where id=$1",[decision])).rows[0].project_id;
  const envelope={contract:"clued.storage-credential/1",key_id:"fixture",nonce:"A".repeat(16),ciphertext:"B".repeat(24)};
  const owner = async input => (await native.query("select public.clued_storage_refresh_manage_v1($1::jsonb) value",[JSON.stringify(input)])).rows[0].value;
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value",[JSON.stringify(input)])).rows[0].value;
  const worker = async (input, token=issuer, db=background) => (await db.query("select public.clued_storage_refresh_worker_v1($1,$2::jsonb) value",[token,JSON.stringify(input)])).rows[0].value;
  const oauth = async input => (await native.query("select public.clued_storage_oauth_v1($1,$2::jsonb) value",[issuer,JSON.stringify(input)])).rows[0].value;
  const authenticate = async connection => {
    const d=await oauth({action:"describe",connection_id:connection}), state_hash=hash(randomUUID());
    await oauth({action:"prepare",connection_id:connection,connection_version:d.connection_version,attempt_id:randomUUID(),state_hash,verifier_envelope:envelope});
    await oauth({action:"claim",state_hash}); return oauth({action:"complete",state_hash,provider_subject:"fixture-subject",credential_envelope:envelope});
  };
  const setup = async () => {
    const suffix=randomUUID();
    const result=(await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value",[user,JSON.stringify({action:"profile_register",project_id:project,
      profile_version:suffix,managed_root:"/refresh/"+suffix+"/Clued_资料中心",root_folder_id:"refresh-"+suffix,root_parent_id:"refresh-parent",root_folder_version:"1",source_decision_id:decision,idempotency_key:randomUUID()})])).rows[0].value;
    const profile=result.target_refs.find(r=>r.role==="primary").id;
    const registered=await account({action:"register",profile_id:profile,source_decision_id:decision,idempotency_key:randomUUID()});
    const connection=registered.target_refs[0].id; await authenticate(connection);
    return {connection,profile,receipt:registered.receipt_id};
  };
  const manage = async (connection,action) => {
    const status=await owner({action:"status",connection_id:connection});
    return owner({action,connection_id:connection,base_version:status.connection_version,delegation_version:status.version,idempotency_key:randomUUID(),...(action==="enable"?{until_revoked:true}:{})});
  };
  const claim=connection=>({action:"claim",connection_id:connection,attempt_id:randomUUID()});
  const commit=req=>({action:"commit",connection_id:req.connection_id,attempt_id:req.attempt_id,credential_envelope:envelope,expires_at:new Date(Date.now()+3600000).toISOString()});
  const mutation = async (f,state="prepared") => admin.query("insert into clued_private.resource_center_mutations_v1(user_id,profile_id,request_key,request_sha256,exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id) values($1,$2,$3,$4,'{}','{}','{}',$4,1,$5,$6,clock_timestamp()+interval '1 minute',$7) returning id",[user,f.profile,randomUUID(),hash(randomUUID()),decision,state,f.receipt]);
  try {
    await t.test("refresh is explicit account delegation, not a device session or context write grant",async()=>{
      const f=await setup(), req=claim(f.connection);
      await assert.rejects(worker(req),/storage_refresh_denied/);
      await assert.rejects(worker(req,hash("wrong")),/storage_refresh_denied/);
      await assert.rejects(background.query("select public.clued_storage_refresh_manage_v1('{}')"),/permission denied/);
      await manage(f.connection,"enable");
      await admin.query("delete from auth.sessions where id=$1",[session]);
      const acquired=await worker(req); assert.equal(acquired.status,"acquired");
      assert.ok(acquired.credential_envelope); assert.equal((await worker(req)).credential_envelope,undefined);
      await assert.rejects(worker(claim(f.connection)),/storage_refresh_not_due/);
      const input=commit(req), result=await worker(input); assert.equal(result.status,"committed");
      assert.deepEqual(await worker(input),result);
      await assert.rejects(worker({...input,expires_at:new Date(Date.now()+2000000).toISOString()}),/storage_refresh_denied/);
      assert.equal((await admin.query("select credential_version from clued_private.storage_connections_v1 where id=$1",[f.connection])).rows[0].credential_version,"2");
      assert.equal(JSON.stringify(result).includes("ciphertext"),false);
      await admin.query("insert into auth.sessions(id,user_id) values($1,$2)",[session,user]);
    });
    await t.test("disable rejects in-flight refresh commit; re-enable cannot erase uncertain attempt; new consent can recover",async()=>{
      const f=await setup(); await manage(f.connection,"enable"); const req=claim(f.connection); await worker(req);
      await manage(f.connection,"disable"); await assert.rejects(worker(commit(req)),/storage_refresh_denied/);
      await assert.rejects(manage(f.connection,"enable"),/storage_refresh_pending/);
      await authenticate(f.connection);
      const status=await owner({action:"status",connection_id:f.connection}); assert.equal(status.enabled,false); assert.equal(status.pending,false);
      assert.equal((await admin.query("select state from clued_private.storage_refresh_attempts_v1 where id=$1",[req.attempt_id])).rows[0].state,"superseded");
      await manage(f.connection,"enable"); assert.equal((await worker(claim(f.connection))).status,"acquired");
    });
    await t.test("same provider-root journal and refresh block one another without erasing either fence",async()=>{
      const f=await setup(); await manage(f.connection,"enable"); const req=claim(f.connection);
      const row=await mutation(f,"uncertain"); await assert.rejects(worker(req),/storage_root_has_unresolved_mutation/);
      await assert.rejects(authenticate(f.connection),/storage_root_has_unresolved_mutation/);
      await admin.query("update clued_private.resource_center_mutations_v1 set state='cancelled' where id=$1",[row.rows[0].id]);
      await worker(req); await assert.rejects(mutation(f),/storage_refresh_pending/);
      await admin.query("update clued_private.storage_refresh_attempts_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1",[req.attempt_id]);
      await assert.rejects(worker(commit(req)),/storage_refresh_denied/); await assert.rejects(mutation(f),/storage_refresh_pending/);
    });
    await t.test("provider failures use bounded retry; invalid grant requires consent; private rows inaccessible",async()=>{
      const f=await setup(); await manage(f.connection,"enable");
      for(let i=0;i<3;i++) {
        await admin.query("update clued_private.storage_refresh_delegations_v1 set next_refresh_at=clock_timestamp() where connection_id=$1",[f.connection]);
        const req=claim(f.connection); await worker(req);
        const failure={action:"fail",connection_id:f.connection,attempt_id:req.attempt_id,reason:"provider_unavailable"};
        const result=await worker(failure); assert.equal(result.status,"failed"); assert.deepEqual(await worker(failure),result);
      }
      const status=await owner({action:"status",connection_id:f.connection}); assert.equal(status.enabled,false); assert.equal(status.failures,3);
      await assert.rejects(worker(claim(f.connection)),/storage_refresh_denied/);
      await manage(f.connection,"enable"); const req=claim(f.connection); await worker(req);
      const failure={action:"fail",connection_id:f.connection,attempt_id:req.attempt_id,reason:"provider_rejected"};
      const failed=await worker(failure); assert.deepEqual(await worker(failure),failed);
      assert.equal((await admin.query("select state from clued_private.storage_connections_v1 where id=$1",[f.connection])).rows[0].state,"reauthorization_required");
      await assert.rejects(manage(f.connection,"enable"),/storage_connection_unavailable/);
      await assert.rejects(native.query("select * from clued_private.storage_refresh_attempts_v1"),/permission denied/);
      await assert.rejects(background.query("select * from clued_private.storage_refresh_delegations_v1"),/permission denied/);
    });
    await t.test("connection revoke winning a real lock wait prevents the waiting refresh claim",async()=>{
      const f=await setup(); await manage(f.connection,"enable");
      const pid=(await background.query("select pg_backend_pid() pid")).rows[0].pid;
      await native.query("begin"); let pending;
      try {
        await account({action:"revoke_connection",connection_id:f.connection,base_version:2,idempotency_key:randomUUID()});
        pending=worker(claim(f.connection)).then(value=>({value}),error=>({error}));
        let waiting=false;
        for(let i=0;i<100;i++){waiting=(await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10));}
        assert.ok(waiting); await native.query("commit"); assert.match((await pending).error?.message??"",/storage_connection_unavailable/);
      }finally{await native.query("rollback");if(pending)await pending;}
    });
    await t.test("fresh native consent on a replacement connection resolves only old credential attempts for the exact root",async()=>{
      const f=await setup(); await manage(f.connection,"enable"); const req=claim(f.connection); await worker(req);
      await account({action:"revoke_connection",connection_id:f.connection,base_version:2,idempotency_key:randomUUID()});
      const registered=await account({action:"register",profile_id:f.profile,source_decision_id:decision,idempotency_key:randomUUID()});
      const next=registered.target_refs[0].id; await authenticate(next);
      const old=(await admin.query("select state,receipt_id from clued_private.storage_refresh_attempts_v1 where id=$1",[req.attempt_id])).rows[0];
      assert.equal(old.state,"superseded"); assert.ok(old.receipt_id);
      assert.equal((await owner({action:"status",connection_id:next})).enabled,false);
      const created=await mutation(f); assert.ok(created.rows[0].id);
      await admin.query("update clued_private.resource_center_mutations_v1 set state='cancelled' where id=$1",[created.rows[0].id]);
      await assert.rejects(worker(commit(req)),/storage_refresh_denied/);
    });
    await t.test("credential refresh invalidates a pending OAuth completion before stale AAD can be stored",async()=>{
      const f=await setup(); await manage(f.connection,"enable");
      const d=await oauth({action:"describe",connection_id:f.connection}), state_hash=hash(randomUUID());
      await oauth({action:"prepare",connection_id:f.connection,connection_version:d.connection_version,attempt_id:randomUUID(),state_hash,verifier_envelope:envelope});
      await oauth({action:"claim",state_hash});
      const req=claim(f.connection); await worker(req); await worker(commit(req));
      await assert.rejects(oauth({action:"complete",state_hash,provider_subject:"fixture-subject",credential_envelope:envelope}),/storage_oauth_denied/);
      assert.equal((await admin.query("select credential_version from clued_private.storage_connections_v1 where id=$1",[f.connection])).rows[0].credential_version,"2");
    });
    await t.test("OAuth expiry while waiting on a final delegation lock rolls back credentials, supersede and receipt",async()=>{
      for(const expiryKind of ["attempt","session"]){
        const f=await setup(); await manage(f.connection,"enable"); const req=claim(f.connection); await worker(req);
        const d=await oauth({action:"describe",connection_id:f.connection}), state_hash=hash(randomUUID());
        await oauth({action:"prepare",connection_id:f.connection,connection_version:d.connection_version,attempt_id:randomUUID(),state_hash,verifier_envelope:envelope});
        await oauth({action:"claim",state_hash});
        const before=(await admin.query("select count(*) n from public.clued_audit_receipts")).rows[0].n;
        const lock=server.getPgClient(); await lock.connect(); const pid=(await native.query("select pg_backend_pid() pid")).rows[0].pid;
        let pending;
        try {
          await lock.query("begin"); await lock.query("select 1 from clued_private.storage_refresh_delegations_v1 where connection_id=$1 for update",[f.connection]);
          if(expiryKind==="attempt") await admin.query("update clued_private.storage_oauth_attempts_v1 set expires_at=clock_timestamp()+interval '2 seconds' where state_hash=$1",[state_hash]);
          else await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id=$1",[session]);
          pending=oauth({action:"complete",state_hash,provider_subject:"fixture-subject",credential_envelope:envelope}).then(value=>({value}),error=>({error}));
          let waiting=false;
          for(let i=0;i<100;i++){waiting=(await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10));}
          assert.ok(waiting); await lock.query("select pg_sleep(2.1)"); await lock.query("commit");
          assert.ok((await pending).error,"expired completion must roll back");
          assert.equal((await admin.query("select credential_version from clued_private.storage_connections_v1 where id=$1",[f.connection])).rows[0].credential_version,"1");
          assert.equal((await admin.query("select state from clued_private.storage_refresh_attempts_v1 where id=$1",[req.attempt_id])).rows[0].state,"claimed");
          assert.equal((await admin.query("select status from clued_private.storage_oauth_attempts_v1 where state_hash=$1",[state_hash])).rows[0].status,"claimed");
          assert.equal((await admin.query("select count(*) n from public.clued_audit_receipts")).rows[0].n,before);
        } finally {await lock.query("rollback");if(pending)await pending;await lock.end();await admin.query("update auth.sessions set not_after=null where id=$1",[session]);}
      }
    });
    await t.test("fair polling gets past ten blocked roots to an eleventh healthy connection",async()=>{
      const blocked=[];
      for(let i=0;i<10;i++){const f=await setup(); await manage(f.connection,"enable"); await mutation(f,"uncertain"); blocked.push(f.connection);}
      const healthy=await setup(); await manage(healthy.connection,"enable");
      const first=await worker({action:"due"}); assert.equal(first.connections.length,10);
      assert.equal(first.connections.includes(healthy.connection),false);
      for(const connection of first.connections) await assert.rejects(worker(claim(connection)),/storage_root_has_unresolved_mutation/);
      const next=await worker({action:"due"}); assert.ok(next.connections.includes(healthy.connection));
      assert.equal((await worker(claim(healthy.connection))).status,"acquired");
    });
  }finally{await native.end();await background.end();}
}
