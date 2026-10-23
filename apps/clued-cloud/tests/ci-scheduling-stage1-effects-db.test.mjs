import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {schedulingFixture,uuid,digest} from './ci-scheduling-stage1-fixture.mjs';
import {assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';

test('stage1 effects: exact signed intent, publication recovery and single-consumer delivery in PostgreSQL', {timeout:600000},async t=>{
  const f=await schedulingFixture();const {admin,user,project}=f;
  const sql=async(text,args=[],client=admin)=>(await client.query(text,args)).rows[0];
  const json=async(text,args=[],client=admin)=>(await sql(text,args,client)).v;
  const domain=(operation,node,id,g,payload)=>({operation,user_id:user,project_id:project,node_id:node,job_id:id,generation:g,payload});
  const hash=async(value)=>(await sql('select clued_private.m1_sha256($1::jsonb)d',[JSON.stringify(value)])).d;
  const nonce=async(operation,node,id,g,payload)=>json('select clued_private.ci_nonce_issue_v1($1,$2,$3,$4,$5,$6,$7)v',[user,project,node,operation,await hash(domain(operation,node,id,g,payload)),id,g]);
  const lease=async(node,id,client=admin)=>json('select clued_private.ci_job_lease_v1($1,$2,$3,$4,1)v',[user,project,node,id],client);
  const start=async(node,id)=>json('select clued_private.ci_job_started_v1($1,$2,$3,$4,1)v',[user,project,node,id]);
  const job=async(node,extra={})=>{const id=await f.enqueue(extra);await lease(node,id);await start(node,id);return id;};
  const resultBody=kind=>({result_kind:kind,result_digest:digest(uuid()),certificate_digest:digest('certificate'),signature_envelope:{protocol:'synthetic-signed-proof'},qualification_ref:'fixture-reviewed-qualification',scanner_digest:digest('scanner'),rules_digest:digest('rules'),...(kind==='trivy'?{vulnerability_db_digest:digest('db'),db_updated_at:new Date(Date.now()-10000).toISOString(),db_next_update:new Date(Date.now()+3600000).toISOString()}: {})});
  const register=async(node,id,data,client=admin)=>(await sql('select clued_private.ci_result_register_v1($1,$2,$3,$4,1,$5::jsonb)id',[user,project,node,id,JSON.stringify(data)],client)).id;
  const publication=async(node,id,body)=>{const request_digest=await hash(domain('publish-reserve',node,id,1,body));const n=await nonce('publish-reserve',node,id,1,body);return {...body,request_digest,nonce_id:n.nonce_id,nonce:n.nonce};};
  const prepare=async(node,id,data,client=admin)=>json('select clued_private.ci_publish_prepare_v1($1,$2,$3,$4,1,$5::jsonb)v',[user,project,node,id,JSON.stringify(data)],client);
  const observe=async(node,key,observation,checkid=null,evidence=digest(uuid()),client=admin)=>{
    const k=await sql('select * from clued_private.ci_publish_keys_v1 where key_id=$1',[key]);
    const n=await nonce('publish-observe',node,k.job_id,Number(k.execution_generation),{key_id:key,external_id:k.external_id,observation,check_run_id:checkid,evidence_digest:evidence});
    const args=[user,project,node,key,observation,checkid,evidence,n.nonce_id,n.nonce];
    return {n,args,result:await json('select clued_private.ci_publish_observe_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)v',args,client)};
  };
  const green=async(node,entry,action,ancestor=false)=>{
    const e=await sql('select e.*,k.execution_generation from clued_private.ci_green_ledger_v1 e join clued_private.ci_publish_keys_v1 k on k.key_id=e.publish_key_id where e.entry_id=$1',[entry]);
    const evidence=digest(uuid()),version=Number(e.state_version);
    const n=await nonce('green-transition',node,e.job_id,Number(e.execution_generation),{entry_id:entry,state_version:version,action,evidence_digest:evidence,ancestor});
    const args=[user,project,node,entry,version,action,evidence,ancestor,n.nonce_id,n.nonce];
    return {args,result:await json('select to_jsonb(clued_private.ci_green_transition_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10))v',args)};
  };
  const seededGreen=async(node,id,state='proposed',firstObservation=false)=>{
    const k=uuid(),external='fixture:'+k;
    const j=await sql('select * from clued_private.ci_jobs_v1 where job_id=$1',[id]);
    await admin.query(`insert into clued_private.ci_publish_keys_v1(key_id,user_id,project_id,registration_ref,repository_id,head_sha,check_name,app_id,job_id,publisher_node_id,execution_generation,request_digest,external_id,state,reserved_at,landing_deadline_at,observation_1_at)
      values($1,$2,$3,$4,$5,$6,'kooyumi-merge-slot',5368905,$7,$8,1,$9,$10,$11,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes',case when $12 then clock_timestamp()-interval '31 seconds' end)`,[k,user,project,j.registration_ref,j.repository_id,j.head_sha,id,node,digest('seeded-original-intent'),external,state==='unknown'?'unknown':'reserved',firstObservation]);
    const e=(await sql(`insert into clued_private.ci_green_ledger_v1(user_id,project_id,repository_id,head_sha,publish_key_id,job_id,publisher_node_id,state,external_id,landing_deadline_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()-interval '5 minutes')returning entry_id`,[user,project,j.repository_id,j.head_sha,k,id,node,state,external])).entry_id;
    return {key:k,entry:e};
  };
  try{
    f.committed(await f.pool());await f.modelMode(4);
    const a=f.committed(await f.register());await f.approve(a.node_id);const node=a.node_id;
    await admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=now(),qualification_expires_at=now()+interval '1 hour',eligible_until=now()+interval '1 hour',hardening_observed=true,qualification_receipt_ref='fixture-reviewed-qualification' where node_id=$1`,[node]);
    const second=await f.trustedNode(),third=await f.trustedNode();
    let id,resultId,resultData,key;
    await t.test('nonce is 256 random bits, raw value is hash-only in storage, and wrong possession/domain has zero effect',async()=>{
      id=await job(node);const body=resultBody('gitleaks');const n=await nonce('result-register',node,id,1,body);
      assert.equal(Buffer.from(n.nonce,'base64url').length,32);assert.match(n.nonce,/^[A-Za-z0-9_-]{43}$/);
      const row=await sql('select * from clued_private.ci_nonce_ledger_v1 where nonce_id=$1',[n.nonce_id]);
      assert.equal(row.nonce_hash,digest(n.nonce));assert.equal(JSON.stringify(row).includes(n.nonce),false);assert.equal(row.consumed_at,null);
      const data={...body,nonce_id:n.nonce_id,nonce:n.nonce};
      await assert.rejects(()=>register(node,id,{...data,nonce:crypto.randomBytes(32).toString('base64url')}),/CI_NONCE_BINDING_MISMATCH/);
      assert.equal((await sql('select consumed_at from clued_private.ci_nonce_ledger_v1 where nonce_id=$1',[n.nonce_id])).consumed_at,null);
      resultData=data;resultId=await register(node,id,data);
    });
    await t.test('result replay preserves its receipt; changing any same-family field cannot reuse the nonce',async()=>{
      const before=await sql('select receipt_id from clued_private.ci_result_index_v1 where result_id=$1',[resultId]);
      assert.equal(await register(node,id,resultData),resultId);
      assert.equal((await sql('select receipt_id from clued_private.ci_result_index_v1 where result_id=$1',[resultId])).receipt_id,before.receipt_id);
      for(const changed of [{result_kind:'trivy'},{certificate_digest:digest('other')},{signature_envelope:{protocol:'different'}}])
        await assert.rejects(()=>register(node,id,{...resultData,...changed}),/CI_NONCE_BINDING_MISMATCH/);
      assert.equal(Number((await sql('select count(*)n from clued_private.ci_result_index_v1 where job_id=$1',[id])).n),1);
    });
    await t.test('a current delegated child result is adoptable only by its exact current parent; foreign results and lost signer qualification fail',async()=>{
      const parent=await job(node),pj=await sql('select * from clued_private.ci_jobs_v1 where job_id=$1',[parent]);
      const child=await job(second,{kind:'delegated_scan',role:'gitleaks',parent_job_id:parent,parent_lease_generation:1,head_sha:pj.head_sha,base_sha:pj.base_sha,test_sha:pj.test_sha,source_sha:pj.source_sha,combination_sha256:pj.combination_sha256});
      const body=resultBody('gitleaks'),n=await nonce('result-register',second,child,1,body);
      const r=await register(second,child,{...body,nonce_id:n.nonce_id,nonce:n.nonce});
      const data=await publication(node,parent,{check_name:'gitleaks',result_id:r,landing_window_seconds:151,external_facts_digest:digest('read')});
      await admin.query('update clued_private.ci_nodes_v1 set scan_signing_approved=false where node_id=$1',[second]);
      await assert.rejects(()=>prepare(node,parent,data),/CI_RESULT_NOT_CURRENT/);
      await admin.query('update clued_private.ci_nodes_v1 set scan_signing_approved=true where node_id=$1',[second]);
      assert.ok((await prepare(node,parent,data)).key_id);
      const foreign=await job(node,{combination_sha256:pj.combination_sha256});
      await assert.rejects(()=>publication(node,foreign,{check_name:'gitleaks',result_id:r,landing_window_seconds:151,external_facts_digest:digest('read')}).then(x=>prepare(node,foreign,x)),/CI_RESULT_NOT_CURRENT/);
    });
    await t.test('two real connections reserve one permanent publication key; loser nonce and all rejected side effects roll back',async()=>{
      const body={check_name:'gitleaks',result_id:resultId,landing_window_seconds:151,external_facts_digest:digest('read')};
      const one=await publication(node,id,body),two=await publication(node,id,body),c1=await f.connect(),c2=await f.connect();
      const raced=await Promise.allSettled([prepare(node,id,one,c1),prepare(node,id,two,c2)]);
      assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.filter(x=>x.status==='rejected').length,1);
      key=raced.find(x=>x.status==='fulfilled').value.key_id;
      assert.equal(Number((await sql('select count(*)n from clued_private.ci_publish_keys_v1 where job_id=$1',[id])).n),1);
      assert.equal(Number((await sql('select count(*)n from clued_private.ci_nonce_ledger_v1 where nonce_id=any($1::uuid[]) and consumed_at is not null',[[one.nonce_id,two.nonce_id]])).n),1);
      await assert.rejects(()=>admin.query('delete from clued_private.ci_publish_keys_v1 where key_id=$1',[key]),/CI_PERMANENT_HISTORY/);
    });
    await t.test('UNKNOWN remains a permanent key; error is never absence and a second valid absent read abandons only the green',async()=>{
      const pending=await seededGreen(node,await job(node));
      const error=await observe(node,pending.key,'error');assert.equal(error.result.state,'unknown');assert.equal(error.result.green_state,'unknown');
      assert.equal((await sql('select observation_1_at from clued_private.ci_publish_keys_v1 where key_id=$1',[pending.key])).observation_1_at,null);
      const r=await json('select clued_private.ci_publish_observe_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)v',error.args);
      assert.equal(r.receipt_id,error.result.receipt_id);assert.equal(r.replayed,true);
      const prior=await seededGreen(node,await job(node),'unknown',true),absent=await observe(node,prior.key,'absent');
      assert.equal(absent.result.state,'unknown');assert.equal(absent.result.green_state,'abandoned');assert.equal(absent.result.retry_post_allowed,false);
    });
    await t.test('green transitions preserve state CAS, signed intent, thirty-second proof and terminal non-resurrection',async()=>{
      const g=await seededGreen(node,await job(node));await observe(node,g.key,'present',101);
      const revoke=await green(node,g.entry,'revoke');assert.equal(revoke.result,'revoke_requested');
      assert.equal(await json('select to_jsonb(clued_private.ci_green_transition_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10))v',revoke.args),'revoke_requested');
      await assert.rejects(()=>green(node,g.entry,'confirm_failure'),/CI_GREEN_TRANSITION_INVALID/);
      await admin.query("update clued_private.ci_green_ledger_v1 set revoke_requested_at=clock_timestamp()-interval '31 seconds' where entry_id=$1",[g.entry]);
      assert.equal((await green(node,g.entry,'confirm_failure')).result,'revoke_confirmed');
      await observe(node,g.key,'present',101);assert.equal((await sql('select state from clued_private.ci_green_ledger_v1 where entry_id=$1',[g.entry])).state,'revoke_confirmed');
    });
    await t.test('sealed group binds its sender, complete per-copy intent, all recipients and exactly one take',async()=>{
      const deliveryJob=await job(node),group=uuid(),common={request_group_id:group,request_digest:digest('logical-message'),purpose:'publish-request',crypto_envelope_version:'fixture-opaque/1',ttl_seconds:3600};
      const packet=async(receiver,cipher='sealed fixture')=>{const fp=(await sql('select encryption_fingerprint from clued_private.ci_nodes_v1 where node_id=$1',[receiver])).encryption_fingerprint;
        const bytes=Buffer.from(cipher);return {...common,recipient_node_id:receiver,recipient_fingerprint:fp,ciphertext_base64:bytes.toString('base64'),ciphertext_sha256:digest(bytes)};};
      const send=async(sender,body)=>{const n=await nonce('drop-send',sender,deliveryJob,1,body);return {data:{...body,nonce_id:n.nonce_id,nonce:n.nonce},n};};
      const post=async(sender,data)=>json('select to_jsonb(clued_private.ci_sealed_drop_send_v1($1,$2,$3,$4,1,$5::jsonb))v',[user,project,sender,deliveryJob,JSON.stringify(data)]);
      const bad=await send(third,await packet(node));await assert.rejects(()=>post(third,bad.data),/CI_LEASE_NOT_CURRENT/);
      const first=await send(node,await packet(node));assert.equal(await post(node,first.data),group);assert.equal(await post(node,first.data),group);
      const altered=await packet(node,'altered');
      await assert.rejects(()=>post(node,{...first.data,...altered}),/CI_NONCE_BINDING_MISMATCH/);
      const conflict=await send(node,await packet(node,'altered'));await assert.rejects(()=>post(node,conflict.data),/CI_DROP_GROUP_CLOSED_OR_CONFLICT/);
      assert.equal((await sql('select consumed_at from clued_private.ci_nonce_ledger_v1 where nonce_id=$1',[conflict.n.nonce_id])).consumed_at,null);
      await post(node,(await send(node,await packet(second))).data);
      const takeArgs=async(receiver)=>{const fp=(await sql('select recipient_fingerprint from clued_private.ci_sealed_drop_v1 where request_group_id=$1 and recipient_node_id=$2',[group,receiver])).recipient_fingerprint;
        const n=await nonce('drop-take',receiver,deliveryJob,1,{request_group_id:group,request_digest:common.request_digest,recipient_fingerprint:fp});return [user,project,receiver,group,n.nonce_id,n.nonce];};
      const x=await takeArgs(node),y=await takeArgs(second),c1=await f.connect(),c2=await f.connect();
      const takes=await Promise.allSettled([json('select clued_private.ci_sealed_drop_take_v1($1,$2,$3,$4,$5,$6)v',x,c1),json('select clued_private.ci_sealed_drop_take_v1($1,$2,$3,$4,$5,$6)v',y,c2)]);
      assert.equal(takes.filter(x=>x.status==='fulfilled').length,1);assert.equal(takes.filter(x=>x.status==='rejected').length,1);
      const rows=(await admin.query('select state,ciphertext,claimed_by from clued_private.ci_sealed_drop_v1 where request_group_id=$1',[group])).rows;
      assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='consumed'&&r.ciphertext===null));assert.equal(new Set(rows.map(r=>r.claimed_by)).size,1);
      const replay=await json('select clued_private.ci_sealed_drop_take_v1($1,$2,$3,$4,$5,$6)v',takes[0].status==='fulfilled'?x:y);
      assert.equal(replay.replayed,true);assert.equal(Object.hasOwn(replay,'ciphertext_base64'),false);
      const replacement={...await packet(node),request_group_id:uuid()};
      await assert.rejects(()=>send(node,replacement).then(x=>post(node,x.data)),/CI_DROP_REQUEST_ALREADY_BOUND/);
      assert.equal(Number((await sql('select count(*)n from clued_private.ci_sealed_drop_v1 where job_id=$1',[deliveryJob])).n),2);
    });
    await t.test('waiting behind a job lock rechecks signer expiry and refuses before nonce/result mutation',async()=>{
      const late=await job(second),body=resultBody('gitleaks'),n=await nonce('result-register',second,late,1,body);
      const holder=await f.connect(),waiter=await f.connect();await holder.query('begin');await holder.query('select 1 from clued_private.ci_jobs_v1 where job_id=$1 for update',[late]);
      await admin.query("update clued_private.ci_nodes_v1 set qualification_expires_at=clock_timestamp()+interval '250 milliseconds' where node_id=$1",[second]);
      const running=register(second,late,{...body,nonce_id:n.nonce_id,nonce:n.nonce},waiter).then(value=>({value}),error=>({error}));
      await new Promise(r=>setTimeout(r,350));await holder.query('commit');const outcome=await running;assert.match(outcome.error.message,/CI_NODE_NOT_ELIGIBLE/);
      assert.equal(Number((await sql('select count(*)n from clued_private.ci_result_index_v1 where job_id=$1',[late])).n),0);
      assert.equal((await sql('select consumed_at from clued_private.ci_nonce_ledger_v1 where nonce_id=$1',[n.nonce_id])).consumed_at,null);
      await admin.query("update clued_private.ci_nodes_v1 set qualification_expires_at=clock_timestamp()+interval '1 hour' where node_id=$1",[second]);
    });
    await t.test('waiting on the nonce lock takes the final authority snapshot afterwards and rolls back every effect',async()=>{
      const late=await job(second),body=resultBody('gitleaks'),n=await nonce('result-register',second,late,1,body);
      const holder=await f.connect(),waiter=await f.connect();
      await holder.query('begin');
      try{
        await holder.query('select 1 from clued_private.ci_nonce_ledger_v1 where nonce_id=$1 for update',[n.nonce_id]);
        await admin.query("update clued_private.ci_nodes_v1 set qualification_expires_at=clock_timestamp()+interval '200 milliseconds' where node_id=$1",[second]);
        const before=Number((await sql('select count(*)n from public.clued_audit_receipts')).n);
        const running=register(second,late,{...body,nonce_id:n.nonce_id,nonce:n.nonce},waiter).then(value=>({value}),error=>({error}));
        let blocked=false;
        for(let i=0;i<100;i++){
          const state=await sql('select wait_event_type from pg_stat_activity where pid=$1',[waiter.processID]);
          if(state?.wait_event_type==='Lock'){blocked=true;break;}
          await new Promise(r=>setTimeout(r,5));
        }
        assert.equal(blocked,true,'result call must actually wait on the held nonce row');
        await new Promise(r=>setTimeout(r,350));await holder.query('commit');
        const outcome=await running;assert.match(outcome.error?.message??'',/CI_NODE_NOT_ELIGIBLE/);
        assert.equal(Number((await sql('select count(*)n from clued_private.ci_result_index_v1 where job_id=$1',[late])).n),0);
        const unchanged=await sql('select consumed_at,consume_receipt_id from clued_private.ci_nonce_ledger_v1 where nonce_id=$1',[n.nonce_id]);
        assert.equal(unchanged.consumed_at,null);assert.equal(unchanged.consume_receipt_id,null);
        assert.equal(Number((await sql('select count(*)n from public.clued_audit_receipts')).n),before);
      }finally{
        await holder.query('rollback');
        await admin.query("update clued_private.ci_nodes_v1 set qualification_expires_at=clock_timestamp()+interval '1 hour' where node_id=$1",[second]);
      }
    });
    await t.test('recovery of an original key remains available after its claim expires; no transport caller is opened',async()=>{
      await admin.query("update clued_private.work_claims_v1 set expires_at=issued_at+interval '1 millisecond' where claim_id=$1",[f.claim.claim_id]);
      assert.equal((await observe(node,key,'present',202)).result.state,'posted');
      await assertGatewayCloseoutBoundary(admin);
      assert.equal((await json("select clued_private.ci_node_dispatch_v1('{}')v")).error_code,'SIGNATURE_GATEWAY_NOT_ACTIVATED');
    });
  }finally{await f.close();}
});
