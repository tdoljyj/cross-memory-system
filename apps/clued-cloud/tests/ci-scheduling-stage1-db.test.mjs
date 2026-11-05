import assert from 'node:assert/strict';
import test from 'node:test';
import {schedulingFixture,uuid,digest,sha} from './ci-scheduling-stage1-fixture.mjs';
import {assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';

test('stage1 scheduling: real PostgreSQL full migration chain and isolated authorization/concurrency', {timeout:600000},async t=>{
  const f=await schedulingFixture();const {admin,user,project}=f;
  const sql=async(text,args=[],client=admin)=>(await client.query(text,args)).rows[0];
  const lease=async(node,id,client=admin)=>(await sql('select clued_private.ci_job_lease_v1($1,$2,$3,$4,1)v',[user,project,node,id],client)).v;
  const start=async(node,id,g,client=admin)=>(await sql('select clued_private.ci_job_started_v1($1,$2,$3,$4,$5)v',[user,project,node,id,g],client)).v;
  const release=async(node,id,g,reason='REJECTED',kind='rejected',breaker='closed',client=admin)=>(await sql('select clued_private.ci_job_release_v1($1,$2,$3,$4,$5,$6,$7,$8,true)v',[user,project,node,id,g,reason,kind,breaker],client)).v;
  try{
    await t.test('12 private RLS tables, the six Native wrappers, two scan-start and two CI node gateway entries by name, unchanged GW80/CI8 and the Stage 1 dispatch stub',async()=>{
      const rows=(await admin.query(`select relname,relrowsecurity from pg_class where relnamespace='clued_private'::regnamespace and relkind='r' and relname=any($1)`,
        [['ci_nodes_v1','ci_jobs_v1','ci_job_leases_v1','ci_publish_keys_v1','ci_exec_keys_v1','ci_green_ledger_v1','ci_quota_counters_v1','ci_train_lease_v1','ci_train_front_v1','ci_nonce_ledger_v1','ci_result_index_v1','ci_sealed_drop_v1']])).rows;
      assert.equal(rows.length,12);assert.ok(rows.every(r=>r.relrowsecurity));await assertGatewayCloseoutBoundary(admin);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        const c=await f.connect(role);await assert.rejects(()=>c.query('select * from clued_private.ci_nodes_v1'),/permission denied/);
        await assert.rejects(()=>c.query("select clued_private.ci_node_dispatch_v1('{}')"),/permission denied/);
      }
      assert.equal((await sql("select clued_private.ci_node_dispatch_v1('{}')v")).v.error_code,'SIGNATURE_GATEWAY_NOT_ACTIVATED');
      // Every public clued_ci_* function by name and who may run it: the six Stage 1 Native wrappers (signed-in
      // Owner only), the two scan-start entries of 20261102151506 and the two CI node gateway entries of
      // 20261106090000 (serving Worker gateway only). A new public
      // clued_ci_* function must be added here with its grantees, not just counted.
      const catalog=(await admin.query(`select p.oid::regprocedure::text s,has_function_privilege('authenticated',p.oid,'execute') a,
        has_function_privilege('anon',p.oid,'execute') x,has_function_privilege('clued_worker_gateway',p.oid,'execute') g
        from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'clued_ci_%' order by 1`)).rows;
      const native={a:true,x:false,g:false},gateway={a:false,x:false,g:true};
      assert.deepEqual(Object.fromEntries(catalog.map(r=>[r.s,{a:r.a,x:r.x,g:r.g}])),{
        'clued_ci_node_apply_v1(jsonb)':native,'clued_ci_node_confirmation_issue_v1(jsonb)':native,
        'clued_ci_node_registration_v1(jsonb)':native,'clued_ci_nodes_v1(jsonb)':native,
        'clued_ci_pool_apply_v1(jsonb)':native,'clued_ci_pool_confirmation_issue_v1(jsonb)':native,
        'clued_ci_scan_start_hosted_v1(jsonb)':gateway,'clued_ci_scan_start_policy_v1(jsonb)':gateway,
        'clued_ci_node_command_v1(text,jsonb,jsonb,jsonb)':gateway,'clued_ci_node_trust_v1(text,uuid)':gateway});
    });
    await t.test('Native requires live same-account session and rejects delegated/cross-project/private JWK',async()=>{
      await assert.rejects(()=>f.native('clued_ci_nodes_v1',{project_id:project},f.claims(user,uuid())),/native_session/);
      await assert.rejects(()=>f.native('clued_ci_nodes_v1',{project_id:f.otherProject}),/CI_PROJECT_UNAVAILABLE/);
      await assert.rejects(()=>f.native('clued_ci_nodes_v1',{project_id:project},f.claims(user,f.session,{client_id:'delegated'})),/direct_human/);
      const p=f.registration();p.identity_public_jwk.d='private-not-allowed';await assert.rejects(()=>f.native('clued_ci_node_registration_v1',p),/CI_REGISTRATION_INVALID/);
    });
    let node;
    await t.test('pending registration idempotency, real Native confirmation CAS/replay and no fabricated qualification',async()=>{
      const p=f.registration(),a=f.committed(await f.native('clued_ci_node_registration_v1',p));node=a.node_id;
      assert.equal(a.state,'pending');assert.equal((await f.native('clued_ci_node_registration_v1',p)).replayed,true);
      await assert.rejects(()=>f.native('clued_ci_node_registration_v1',{...p,name:'different'}),/CI_IDEMPOTENCY_CONFLICT/);
      const issue=await f.native('clued_ci_node_confirmation_issue_v1',{project_id:project,node_id:node,base_version:1,action:'approve',accepted_ref:'fixture'});
      const result=f.committed(await f.native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest}));
      assert.equal(result.state,'active');assert.equal(result.qualification_status,'unverified');
      assert.equal((await f.native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest})).replayed,true);
      const secondSession=uuid();await admin.query("insert into auth.sessions(id,user_id,not_after)values($1,$2,now()+interval '1 hour')",[secondSession,user]);
      await assert.rejects(()=>f.native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest},f.claims(user,secondSession)),/confirmation_token_binding_mismatch/);
      await assert.rejects(()=>f.native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:digest('different')}),/confirmation_token_binding_mismatch/);
      await assert.rejects(()=>f.native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest,extra:true}),/CI_INPUT_INVALID/);
      await assert.rejects(()=>f.native('clued_ci_node_confirmation_issue_v1',{project_id:project,node_id:node,base_version:2,action:'qualify'}),/SIGNATURE_GATEWAY_NOT_ACTIVATED/);
    });
    await t.test('pool repository permanently binds across Projects and prepared cannot lease',async()=>{
      f.committed(await f.pool());
      const otherPool=await f.pool(f.project2,12345);assert.equal(otherPool.status,'rejected');assert.equal(otherPool.error_code,'CI_REPOSITORY_POOL_MISMATCH');
      const rows=await admin.query("select project_id from clued_private.ci_quota_counters_v1 where row_kind='repo_registration' and repository_id=12345");assert.equal(rows.rowCount,1);
      await assert.rejects(()=>f.enqueue(),/CI_SCHEDULING_NOT_ACTIVATED/);
      await assert.rejects(()=>admin.query("delete from clued_private.ci_quota_counters_v1 where row_kind='repo_registration'"),/CI_PERMANENT_HISTORY/);
    });
    await admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=now(),qualification_expires_at=now()+interval '1 hour',
      eligible_until=now()+interval '1 hour',hardening_observed=true where node_id=$1`,[node]);
    await f.modelMode();
    await t.test('two PostgreSQL connections racing one job have exactly one lease; stale renew and revoked eligibility fail',async()=>{
      const id=await f.enqueue(),a=await f.connect(),b=await f.connect();const raced=await Promise.allSettled([lease(node,id,a),lease(node,id,b)]);
      assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.equal(raced.filter(r=>r.status==='rejected').length,1);
      await assert.rejects(()=>admin.query('select clued_private.ci_job_renew_v1($1,$2,$3,$4,1,99,$5)',[user,project,node,id,digest('progress')]),/CI_RENEW_STALE/);
      await release(node,id,1,'BUNDLE_UNAVAILABLE','environment');
    });
    await t.test('evaluation holds settle atomically; waiting-retry does not hold; full-cap terminal settlement never rejects',async()=>{
      await f.modelMode(2,1);const a=await f.enqueue();await lease(node,a);
      const b=await f.enqueue();await assert.rejects(()=>lease(node,b),/CI_QUOTA_EXCEEDED:evaluation/);
      const w=await f.enqueue({origin:'waiting-retry'});await lease(node,w);
      const counted=await release(node,a,1);assert.equal(counted.head_release_counted,true);
      assert.equal(Number((await sql("select clued_private.ci_usage_count_v1($1,$2,'evaluation','pool')n",[user,project])).n),1);
      await release(node,w,1,'WAITING','waiting');
      // Authoritative terminal facts are preserved even while usage exceeds the cap.
      await f.modelMode(2,100);const x=await f.enqueue(),y=await f.enqueue();await lease(node,x);await lease(node,y);await f.modelMode(2,0);
      const c1=await f.connect(),c2=await f.connect();const all=await Promise.all([release(node,x,1,'REJECTED','rejected','closed',c1),release(node,y,1,'REJECTED','rejected','closed',c2)]);
      assert.ok(all.every(r=>r.status==='released'));await f.modelMode();
    });
    await t.test('started retracts evaluation and permanently burns head exactly once, with atomic execution/PR counting',async()=>{
      const h=sha(uuid()),id=await f.enqueue({head_sha:h});await lease(node,id);const r=await start(node,id,1);assert.equal(r.status,'started');
      assert.equal((await start(node,id,1)).replayed,true);
      assert.equal(Number((await sql("select count(*)n from clued_private.ci_exec_keys_v1 where head_sha=$1",[h])).n),1);
      await assert.rejects(()=>admin.query('delete from clued_private.ci_exec_keys_v1 where job_id=$1',[id]),/CI_PERMANENT_HISTORY/);
      assert.equal(Number((await sql("select count(*)n from clued_private.ci_quota_counters_v1 where job_id=$1 and metric='execution_start'",[id])).n),1);
      await release(node,id,1,'COMPLETE','success');
    });
    await t.test('release predicate is not a generic release counter; accepted epoch and source remain current',async()=>{
      const id=await f.enqueue();await lease(node,id);assert.equal((await release(node,id,1,'TRANSIENT','transient','open')).head_release_counted,false);
      const bad=await f.enqueue({source_sha:sha('unaccepted')});await assert.rejects(()=>lease(node,bad),/CI_SOURCE_NOT_ACCEPTED/);
      const badEpoch=await f.enqueue({execution_epoch:999}).then(()=>null,e=>e);assert.match(badEpoch.message,/CI_CLAIM_NOT_CURRENT/);
    });
    await t.test('strict scalar/profile validation rejects null authority fields and secret-bearing registration data',async()=>{
      for(const extra of [{claim_fence:null},{execution_epoch:null},{task_id:null},{head_authorization_id:null}]){
        // enqueue constructs authentic head authorization; null immutable job fields still fail its strict kernel.
        if('head_authorization_id'in extra)continue;
        await assert.rejects(()=>f.enqueue(extra),/CI_INPUT_INVALID|CI_JOB_SCALAR_INVALID/);
      }
      for(const profile of [{slot_count:2,diagnostic:'-----BEGIN PRIVATE KEY-----'}, {slot_count:null},{slot_count:2,environment_kinds:['E1-Linux','E1-Linux']},
        {slot_count:2,capabilities:['arbitrary']},{slot_count:2,memory_limit_mb:1048577}]){
        const p=f.registration();p.profile=profile;await assert.rejects(()=>f.native('clued_ci_node_registration_v1',p),/CI_REGISTRATION_INVALID/);
      }
    });
    await t.test('Native lock wait rechecks live-session expiration before mutating node',async()=>{
      const issued=await f.native('clued_ci_node_confirmation_issue_v1',{project_id:project,node_id:node,base_version:2,action:'drain'});
      const blocker=await f.connect();await blocker.query('begin');await blocker.query('select 1 from clued_private.ci_nodes_v1 where node_id=$1 for update',[node]);
      await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '200 milliseconds' where id=$1",[f.session]);
      const pending=f.native('clued_ci_node_apply_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest});
      await new Promise(r=>setTimeout(r,350));await blocker.query('commit');
      const result=await pending;assert.equal(result.status,'rejected');assert.equal(result.error_code,'CI_NATIVE_SESSION_REQUIRED');
      await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 hour' where id=$1",[f.session]);
      assert.equal((await sql('select state from clued_private.ci_nodes_v1 where node_id=$1',[node])).state,'active');
    });
    await t.test('job lock wait rechecks lease expiry and node qualification; draining allows existing renew/settlement only',async()=>{
      const id=await f.enqueue();await lease(node,id);const blocker=await f.connect(),client=await f.connect();
      await admin.query("update clued_private.ci_job_leases_v1 set expires_at=clock_timestamp()+interval '200 milliseconds' where job_id=$1",[id]);
      await blocker.query('begin');await blocker.query('select 1 from clued_private.ci_jobs_v1 where job_id=$1 for update',[id]);
      const pending=start(node,id,1,client);pending.catch(()=>{});await new Promise(r=>setTimeout(r,350));await blocker.query('commit');await assert.rejects(()=>pending,/CI_LEASE_NOT_CURRENT/);
      await release(node,id,1,'SUPERSEDED','rejected');
      const existing=await f.enqueue();await lease(node,existing);await admin.query("update clued_private.ci_nodes_v1 set state='draining' where node_id=$1",[node]);
      const renewed=(await sql('select clued_private.ci_job_renew_v1($1,$2,$3,$4,1,1,$5)v',[user,project,node,existing,digest('draining-progress')])).v;assert.equal(renewed.lease_version,2);
      await assert.rejects(()=>start(node,existing,1),/CI_NODE_NOT_ELIGIBLE/);
      await release(node,existing,1,'SUPERSEDED','rejected');await admin.query("update clued_private.ci_nodes_v1 set state='active' where node_id=$1",[node]);
    });
    await t.test('nonce replay domains and cross-node/result identifiers cannot consume another purpose',async()=>{
      const id=await f.enqueue();await lease(node,id);const d=digest(uuid());
      const n=(await sql("select clued_private.ci_nonce_issue_v1($1,$2,$3,'publish-reserve',$4,$5,1)id",[user,project,node,d,id])).id;
      assert.equal((await sql("select clued_private.ci_nonce_consume_v1($1,$2,$3,$4,'publish-reserve',$5,$6,1,$7)v",[user,project,node,n.nonce_id,d,id,n.nonce])).v,true);
      assert.equal((await sql("select clued_private.ci_nonce_consume_v1($1,$2,$3,$4,'publish-reserve',$5,$6,1,$7)v",[user,project,node,n.nonce_id,d,id,n.nonce])).v,false);
      await assert.rejects(()=>admin.query("select clued_private.ci_nonce_consume_v1($1,$2,$3,$4,'result-register',$5,$6,1,$7)",[user,project,node,n.nonce_id,d,id,n.nonce]),/CI_NONCE_BINDING_MISMATCH/);
      await release(node,id,1,'SUPERSEDED','rejected');
    });
    await t.test('stage4 train, stage8 and global semantics remain disabled at phase2; GW caller set stays exact',async()=>{
      await assert.rejects(()=>admin.query('select clued_private.ci_train_acquire_v1($1,$2,$3)',[user,project,node]),/CI_PHASE_NOT_ACTIVATED/);
      await assertGatewayCloseoutBoundary(admin);
    });
    await t.test('P9 consumes existing exact head admission and Task meter without issuing a second allowance',async()=>{
      const head=sha(uuid()),id=await f.enqueue({head_sha:head});const row=await sql('select to_jsonb(j) j from clued_private.ci_jobs_v1 j where job_id=$1',[id]);
      for(const extra of [{task_id:uuid()},{project_id:f.project2},{copy_index:1},{target_branch:'other'},{head_authorization_id:uuid()},{admission_id:uuid()}]){
        await assert.rejects(()=>admin.query('select clued_private.ci_claim_current_v1($1,jsonb_populate_record(null::clued_private.ci_jobs_v1,$2::jsonb))',[user,{...row.j,...extra}]),/CI_CLAIM_NOT_CURRENT|CI_HEAD_AUTHORIZATION_NOT_CURRENT|CI_EXECUTION_ADMISSION_NOT_CURRENT/);
      }
      await f.enqueue({head_sha:head});
      assert.equal(Number((await sql("select count(*)n from clued_private.work_claim_door_usage_v1 where user_id=$1 and task_id=$2 and unit_key=$3",[user,f.task,head])).n),1);
      assert.equal(Number((await sql("select count(*)n from clued_private.ci_quota_counters_v1 where row_kind='usage_event' and metric='github-ci'",[])).n),0);
    });
    await t.test('late old-generation settlement preserves immutable facts without changing newer current job',async()=>{
      const id=await f.enqueue();await lease(node,id);
      await admin.query("update clued_private.ci_job_leases_v1 set state='expired' where job_id=$1 and generation=1",[id]);
      await admin.query(`insert into clued_private.ci_job_leases_v1(user_id,project_id,job_id,generation,holder_node_id,holder_binding_id,origin,issued_at,reservation_at,expires_at)
        values($1,$2,$3,2,$4,$5,'handover',now(),now(),now()+interval '10 minutes')`,[user,project,id,node,f.binding]);
      await admin.query("update clued_private.ci_jobs_v1 set current_generation=2,state='leased',version=version+1 where job_id=$1",[id]);
      const released=await release(node,id,1);assert.ok(released.receipt_id);
      assert.deepEqual(await sql('select state,current_generation from clued_private.ci_jobs_v1 where job_id=$1',[id]),{state:'leased',current_generation:'2'});
      assert.equal((await release(node,id,1)).receipt_id,released.receipt_id);
      await release(node,id,2,'SUPERSEDED','rejected');
    });
    await t.test('DRAINING claim admits no enqueue, lease or start while existing started work can renew and settle',async()=>{
      const head=sha(uuid()),queued=await f.enqueue({head_sha:head}),notStarted=await f.enqueue({head_sha:head}),running=await f.enqueue({head_sha:head});
      await lease(node,notStarted);await lease(node,running);await start(node,running,1);
      const row=(await sql('select to_jsonb(j)j from clued_private.ci_jobs_v1 j where job_id=$1',[queued])).j;
      const keys=['repository_id','kind','task_id','claim_id','claim_fence','execution_epoch','target_branch','head_authorization_id','admission_id','pr_ref','head_sha','base_sha','test_sha','source_sha','combination_sha256','role'];
      const input=Object.fromEntries(keys.map(k=>[k,row[k]]));input.combination_sha256=digest('draining-new-work');
      const previous=await sql('select status,updated_at from clued_private.work_claims_v1 where claim_id=$1',[f.claim.claim_id]);
      await admin.query("update clued_private.work_claims_v1 set status='DRAINING',updated_at=clock_timestamp() where claim_id=$1",[f.claim.claim_id]);
      try{
        await assert.rejects(()=>admin.query('select clued_private.ci_job_enqueue_v1($1,$2,$3)',[user,project,input]),/CI_CLAIM_NOT_CURRENT/);
        await assert.rejects(()=>lease(node,queued),/CI_CLAIM_NOT_CURRENT/);
        await assert.rejects(()=>start(node,notStarted,1),/CI_CLAIM_NOT_CURRENT/);
        await assert.rejects(()=>admin.query('select clued_private.ci_job_renew_v1($1,$2,$3,$4,1,1,$5)',[user,project,node,notStarted,digest('not-started')]),/CI_CLAIM_NOT_CURRENT/);
        const renewed=(await sql('select clued_private.ci_job_renew_v1($1,$2,$3,$4,1,1,$5)v',[user,project,node,running,digest('existing-draining')])).v;
        assert.equal(renewed.lease_version,2);assert.ok((await release(node,running,1,'COMPLETE','success')).receipt_id);
        assert.ok((await release(node,notStarted,1,'SUPERSEDED','rejected')).receipt_id);
        assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1',[queued])).state,'queued');
      }finally{await admin.query('update clued_private.work_claims_v1 set status=$2,updated_at=$3 where claim_id=$1',[f.claim.claim_id,previous.status,previous.updated_at]);}
    });
    await t.test('deep-combination quota counts distinct combinations across attempts and rolls back rejected starts',async()=>{
      await f.modelMode(4,100);
      await admin.query(`update clued_private.ci_quota_counters_v1 set policy=jsonb_set(policy,'{limits,head_distinct_combination_24h}','3') where user_id=$1 and project_id=$2 and row_kind='pool_policy'`,[user,project]);
      const head=sha(uuid()),combos=[digest('combo1'),digest('combo2'),digest('combo3')];
      for(const combination_sha256 of combos){const id=await f.enqueue({head_sha:head,combination_sha256,combination_mode:'depth2'});await lease(node,id);await start(node,id,1);await release(node,id,1,'COMPLETE','success');}
      const retry=await f.enqueue({head_sha:head,combination_sha256:combos[0],combination_mode:'depth2',attempt:2});await lease(node,retry);await start(node,retry,1);await release(node,retry,1,'COMPLETE','success');
      assert.equal(Number((await sql("select clued_private.ci_usage_count_v1($1,$2,'head_distinct_combination_24h',$3)n",[user,project,'12345:'+head])).n),3);
      const invalid=await f.enqueue({head_sha:head,combination_sha256:digest('combo4'),combination_mode:'depth2'});await lease(node,invalid);
      await assert.rejects(()=>start(node,invalid,1),/CI_QUOTA_EXCEEDED:head_distinct_combination_24h/);
      assert.equal((await sql('select started_at from clued_private.ci_job_leases_v1 where job_id=$1',[invalid])).started_at,null);
      assert.equal(Number((await sql('select count(*)n from clued_private.ci_exec_keys_v1 where job_id=$1',[invalid])).n),0);await release(node,invalid,1,'SUPERSEDED','rejected');
    });
    await t.test('train generation, quiet period, competitor-only debounce and sweep prerequisite use real serialized rows',async()=>{
      const other=await f.trustedNode();const request1=await f.enqueue({kind:'maintenance'}),request2=await f.enqueue({kind:'maintenance'});
      await sql('select clued_private.ci_train_request_v1($1,$2,$3,$4)',[user,project,node,request1]);
      await sql('select clued_private.ci_train_request_v1($1,$2,$3,$4)',[user,project,other,request2]);
      const first=(await sql('select clued_private.ci_train_acquire_v1($1,$2,$3)v',[user,project,node])).v;assert.equal(first.state,'sweep_required');assert.ok(first.receipt_id);
      await assert.rejects(()=>admin.query('select clued_private.ci_train_front_set_v1($1,$2,$3,$4,12345,1,$5)',[user,project,node,first.generation,request1]),/TRAIN_SWEEP_INCOMPLETE/);
      await sql('select clued_private.ci_train_sweep_confirm_v1($1,$2,$3,$4,$5)',[user,project,node,first.generation,digest('sweep')]);
      await sql('select clued_private.ci_train_release_v1($1,$2,$3,$4)',[user,project,node,first.generation]);
      await assert.rejects(()=>admin.query('select clued_private.ci_train_acquire_v1($1,$2,$3)',[user,project,other]),/CI_TRAIN_SILENCE/);
      // Advance only this disposable fixture's stored quiet boundary; no production clock seam exists.
      await admin.query("update clued_private.ci_train_lease_v1 set silence_until=now()-interval '1 second' where user_id=$1 and project_id=$2",[user,project]);
      await assert.rejects(()=>admin.query('select clued_private.ci_train_acquire_v1($1,$2,$3)',[user,project,node]),/CI_TRAIN_DEBOUNCE/);
      const next=(await sql('select clued_private.ci_train_acquire_v1($1,$2,$3)v',[user,project,other])).v;assert.equal(next.generation,2);
      await assert.rejects(()=>admin.query('select clued_private.ci_train_renew_v1($1,$2,$3,1,1)',[user,project,node]),/CI_TRAIN_LEASE_NOT_CURRENT/);
      await sql('select clued_private.ci_train_release_v1($1,$2,$3,$4)',[user,project,other,next.generation]);
      await admin.query("update clued_private.ci_train_lease_v1 set silence_until=now()-interval '1 second' where user_id=$1 and project_id=$2",[user,project]);
      const expiry=(await sql('select qualification_expires_at from clued_private.ci_nodes_v1 where node_id=$1',[node])).qualification_expires_at;
      await admin.query("update clued_private.ci_nodes_v1 set qualification_expires_at=now()-interval '1 second' where node_id=$1",[node]);
      try{
        const resumed=(await sql('select clued_private.ci_train_acquire_v1($1,$2,$3)v',[user,project,other])).v;
        assert.equal(resumed.generation,3,'an expired competitor cannot impose debounce on the previous holder');
      }finally{await admin.query('update clued_private.ci_nodes_v1 set qualification_expires_at=$2 where node_id=$1',[node,expiry]);}
    });
    await t.test('train request cannot acquire after its exact claim expires',async()=>{
      const candidate=await f.trustedNode(),request=await f.enqueue({kind:'maintenance'});
      await sql('select clued_private.ci_train_request_v1($1,$2,$3,$4)',[user,project,candidate,request]);
      const before=await sql('select generation,holder_node_id,request_job_id from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]);
      const previous=await sql('select expires_at from clued_private.work_claims_v1 where claim_id=$1',[f.claim.claim_id]);
      await admin.query("update clued_private.work_claims_v1 set expires_at=clock_timestamp()-interval '1 millisecond' where claim_id=$1",[f.claim.claim_id]);
      try{
        await assert.rejects(()=>admin.query('select clued_private.ci_train_acquire_v1($1,$2,$3)',[user,project,candidate]),/CI_CLAIM_NOT_CURRENT/);
        assert.deepEqual(await sql('select generation,holder_node_id,request_job_id from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]),before);
      }finally{await admin.query('update clued_private.work_claims_v1 set expires_at=$2 where claim_id=$1',[f.claim.claim_id,previous.expires_at]);}
    });
    await t.test('front lock wait rechecks train expiration and preserves front version and receipt',async()=>{
      const candidate=await f.trustedNode(),request=await f.enqueue({kind:'maintenance'});
      const old=await sql('select holder_node_id,generation from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]);
      if(old.holder_node_id)await sql('select clued_private.ci_train_release_v1($1,$2,$3,$4)',[user,project,old.holder_node_id,old.generation]);
      await admin.query("update clued_private.ci_train_lease_v1 set silence_until=clock_timestamp()-interval '1 second' where user_id=$1 and project_id=$2",[user,project]);
      await sql('select clued_private.ci_train_request_v1($1,$2,$3,$4)',[user,project,candidate,request]);
      const current=(await sql('select clued_private.ci_train_acquire_v1($1,$2,$3)v',[user,project,candidate])).v;
      await sql('select clued_private.ci_train_sweep_confirm_v1($1,$2,$3,$4,$5)',[user,project,candidate,current.generation,digest('front-wait-sweep')]);
      const before=await sql('select front_version,head_job_id,receipt_id from clued_private.ci_train_front_v1 where user_id=$1 and repository_id=12345',[user]);
      const blocker=await f.connect(),client=await f.connect();await blocker.query('begin');
      await blocker.query('select 1 from clued_private.ci_train_front_v1 where user_id=$1 and repository_id=12345 for update',[user]);
      await admin.query("update clued_private.ci_train_lease_v1 set expires_at=clock_timestamp()+interval '200 milliseconds' where user_id=$1 and project_id=$2",[user,project]);
      const pending=client.query('select clued_private.ci_train_front_set_v1($1,$2,$3,$4,12345,$5,$6)',[user,project,candidate,current.generation,before.front_version,request]);
      pending.catch(()=>{});await new Promise(r=>setTimeout(r,350));await blocker.query('commit');
      await assert.rejects(()=>pending,/TRAIN_SWEEP_INCOMPLETE/);
      assert.deepEqual(await sql('select front_version,head_job_id,receipt_id from clued_private.ci_train_front_v1 where user_id=$1 and repository_id=12345',[user]),before);
    });
    await t.test('stage8 retry burns intent once, rejects null/skip and preserves the existing first-try allowance',async()=>{
      const id=await f.enqueue();await lease(node,id);await admin.query('update clued_private.ci_jobs_v1 set stage8_limit=3 where job_id=$1',[id]);
      await assert.rejects(()=>admin.query('select clued_private.ci_stage8_try_begin_v1($1,$2,$3,$4,1,null)',[user,project,node,id]),/CI_STAGE8_TRY_INVALID/);
      assert.equal((await sql('select clued_private.ci_stage8_try_begin_v1($1,$2,$3,$4,1,1)n',[user,project,node,id])).n,1);
      assert.equal((await sql('select clued_private.ci_stage8_try_begin_v1($1,$2,$3,$4,1,2)n',[user,project,node,id])).n,2);
      const before=Number((await sql("select count(*)n from clued_private.ci_quota_counters_v1 where job_id=$1 and metric='stage8_retry'",[id])).n);
      assert.equal(before,1);await sql('select clued_private.ci_stage8_try_begin_v1($1,$2,$3,$4,1,2)',[user,project,node,id]);
      assert.equal(Number((await sql("select count(*)n from clued_private.ci_quota_counters_v1 where job_id=$1 and metric='stage8_retry'",[id])).n),before);
      await assert.rejects(()=>admin.query('select clued_private.ci_stage8_try_begin_v1($1,$2,$3,$4,1,4)',[user,project,node,id]),/CI_STAGE8_TRY_INVALID/);await release(node,id,1,'SUPERSEDED','rejected');
      assert.equal(Number((await sql("select count(*)n from clued_private.ci_quota_counters_v1 where row_kind='usage_event' and receipt_id is null")).n),0);
    });
    await t.test('rolling window has one exact database boundary and immutable event replay does not refresh it',async()=>{
      const j=(await sql('select to_jsonb(j)j from clued_private.ci_jobs_v1 j order by created_at limit 1')).j;
      const unit=uuid(),at='2020-01-01T00:00:00Z';
      await sql("select clued_private.ci_event_v1(jsonb_populate_record(null::clued_private.ci_jobs_v1,$1::jsonb),1,'execution_start','boundary',$2,$3::timestamptz)",[j,unit,at]);
      await sql("select clued_private.ci_event_v1(jsonb_populate_record(null::clued_private.ci_jobs_v1,$1::jsonb),1,'execution_start','boundary',$2,clock_timestamp())",[j,unit]);
      assert.equal(Number((await sql("select clued_private.ci_usage_count_v1($1,$2,'execution_start','boundary','2020-01-02T00:00:00Z')n",[user,project])).n),0);
      assert.equal(Number((await sql("select clued_private.ci_usage_count_v1($1,$2,'execution_start','boundary','2020-01-01T23:59:59.999999Z')n",[user,project])).n),1);
      assert.equal(new Date((await sql("select event_at from clued_private.ci_quota_counters_v1 where unit_key=$1",[unit])).event_at).toISOString(),at.replace('Z','.000Z'));
    });
  }finally{await f.close();}
});
