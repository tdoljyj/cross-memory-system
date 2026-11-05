import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {schedulingFixture,uuid,digest,sha} from './ci-scheduling-stage1-fixture.mjs';

// Unified scheduling 2A: ci_duty_holder_v1 / ci_duty_admits_v1 and the two phase moves,
// on a real PostgreSQL with the whole migration chain (DESIGN 5.1, PR 969).

const MODES=['duty_role','duty_admits','duty_merge_slot','duty_publisher','issuer_role','issuer_admits','admission_role'];

// The criteria the entry points used before 20261105160000, kept here verbatim as the reference.
const LEGACY={
  role:(u,b)=>`exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=${u} and r.binding_id=${b} and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp())`,
  publisher:(u,b)=>`exists(select 1 from clued_private.binding_roles_v1 where user_id=${u} and binding_id=${b} and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp() and purpose<>'parking')`,
  admits:(u,b)=>`clued_private.binding_role_admits_v1((select x from public.clued_agent_bindings x where x.id=${b}),'ci-admission')`,
  mergeSlot:(u,b)=>`(clued_private.binding_role_admits_v1((select x from public.clued_agent_bindings x where x.id=${b}),'ci-admission')
    and not exists(select 1 from jsonb_array_elements(clued_private.binding_role_holders_v1(${u},'ci-admission','{}'::uuid[])) h
      where h->>'binding_id'=${b}::text and (h->>'effective_at')::timestamptz<=pg_catalog.clock_timestamp() and h->>'purpose' not in ('resident-node','unspecified')))`,
};
const LEGACY_FOR_MODE={duty_role:LEGACY.role,issuer_role:LEGACY.role,admission_role:LEGACY.role,duty_admits:LEGACY.admits,issuer_admits:LEGACY.admits,
  duty_merge_slot:LEGACY.mergeSlot,duty_publisher:LEGACY.publisher};

// Functions that may read a ci-admission row or name the role themselves: role management, the failover
// watchdog (retired in phase 4 by 5.1 step 5), the Owner Grant labels, and the duty/phase functions.
const MAY_NAME_ROLE=/^(clued_private\.binding_role_|public\.clued_binding_role|public\.clued_headless_binding|clued_private\.ci_admission_failover_owner_v1|clued_private\.ci_failover_|public\.clued_resident_failover_v1|clued_private\.owner_grant_|public\.clued_owner_grant_|clued_private\.ci_duty_|clued_private\.ci_phase_)/;
const DETERMINATION=[/binding_role_admits_v1\s*\([^)]*'ci-admission'/,/role\s*=\s*'ci-admission'/];

test('unified scheduling 2A: duty holder, equivalence of every routed entry point, phase moves',{timeout:900000},async t=>{
  const f=await schedulingFixture();const {admin,user,project,binding:A}=f;
  const q=async(text,args=[],c=admin)=>(await c.query(text,args)).rows;
  const one=async(text,args=[],c=admin)=>(await q(text,args,c))[0];
  const receipt=(await one('select id from public.clued_audit_receipts where user_id=$1 limit 1',[user])).id;
  const tokens=new Map([[A,f.token]]);
  const extraBinding=async(name)=>{const token=crypto.randomBytes(32).toString('hex');
    const id=(await one(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*'])returning id`,[user,name,token])).id;tokens.set(id,token);return id;};
  const tokenOf=async(b)=>{if(!tokens.has(b)){const id=b;/* nodes made by trustedNode: no raw token known */throw new Error('no token for '+id);}return tokens.get(b);};
  const clearRoles=()=>admin.query(`update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=$2 where user_id=$1 and role='ci-admission' and revoked_at is null`,[user,receipt]);
  const grant=(b,purpose='resident-node',startOffset='0 seconds')=>admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
    values($1,$2,'ci-admission',clock_timestamp(),$3,case when $4='parking' then 'infinity'::timestamptz else clock_timestamp()+$5::interval end,$4)`,[user,b,receipt,purpose,startOffset]);
  const duty=async(p=null)=>(await q('select * from clued_private.ci_duty_holder_v1($1,$2)',[user,p]));
  const admits=async(b,mode,p=null)=>(await one('select clued_private.ci_duty_admits_v1($1,$2,$3,$4)v',[user,b,mode,p])).v;
  try{
    const B=await extraBinding('node-b'),C=await extraBinding('node-c');
    const ci=await f.connect('anon');

    await t.test('static: the final definitions have no ci-admission determination outside role management and the duty functions',async()=>{
      const rows=await q(`select n.nspname||'.'||p.proname sig,p.prosrc src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','clued_private')`);
      const offenders=rows.filter(r=>!MAY_NAME_ROLE.test(r.sig)&&DETERMINATION.some(d=>d.test(r.src))).map(r=>r.sig);
      assert.deepEqual(offenders,[]);
      // the old primitive is called for 'ci-admission' by ci_duty_admits_v1 only (release-door callers pass another role)
      const callers=rows.filter(r=>/binding_role_admits_v1\s*\([^)]*'ci-admission'/.test(r.src)).map(r=>r.sig);
      assert.deepEqual(callers,['clued_private.ci_duty_admits_v1']);
      // merge_slot_admits_v1 is only a wrapper now
      assert.match((await one("select prosrc from pg_proc where proname='merge_slot_admits_v1'")).prosrc,/ci_duty_admits_v1/);
      // the helper used for the rewrites is gone, and the new functions are closed to every API role
      assert.equal((await q("select 1 from pg_proc where proname='ci_duty_patch_v1'")).length,0);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        const c=await f.connect(role);
        await assert.rejects(()=>c.query('select clued_private.ci_duty_holder_v1($1,null)',[user]),/permission denied/);
        await assert.rejects(()=>c.query('select clued_private.ci_phase_3_to_4_v1($1,$2,3,$3::jsonb)',[user,project,'{}']),/permission denied/);
        await assert.rejects(()=>c.query('select clued_private.ci_phase_4_to_3_v1($1,$2,4,false)',[user,project]),/permission denied/);
      }
      // N1 guard present in the 2a begin command
      assert.match((await one("select prosrc from pg_proc where proname='work_claim_independent_begin_v1'")).prosrc,/phase_requires_reservation/);
      // 20261102151506: the server-principal clones are still exactly their originals with only the credential entry
      // changed (the transform of that migration applied to today's originals), and the source guard is re-pinned.
      for(const [original,copy] of [['public.clued_work_verify_v1','clued_private.ci_scan_start_verify_principal_v1'],
        ['clued_private.work_claim_verify_before_execution_v1','clued_private.ci_scan_start_verify_core_principal_v1']]){
        let body=(await one('select pg_get_functiondef($1::regprocedure) v',[original+'(text,jsonb)'])).v;
        body=body.replace('FUNCTION '+original+'(p_token_hash text, p_input jsonb)','FUNCTION '+copy+'(p_binding_id uuid, p_input jsonb)')
          .replace('clued_private.resolve_binding(p_token_hash,','clued_private.ci_scan_start_resolve_principal_v1(p_binding_id,')
          .replaceAll('clued_private.work_claim_verify_before_execution_v1(p_token_hash,p_input)','clued_private.ci_scan_start_verify_core_principal_v1(p_binding_id,p_input)')
          .replaceAll('p_token_hash','p_binding_id');
        assert.equal((await one('select pg_get_functiondef($1::regprocedure) v',[copy+'(uuid,jsonb)'])).v,body,copy);
      }
      assert.equal((await one('select clued_private.ci_scan_start_native_source_current_v1() v')).v,true);
      assert.ok((await one("select prosrc from pg_proc where proname='ci_scan_start_begin_v1'")).prosrc.includes("not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_role')"));
    });

    // ---- phase <= 3 and the account without a CI project: every mode equals its previous criterion, every row state.
    const scenarios={
      'no role row at all':async()=>{},
      'A resident-node started':async()=>grant(A),
      'A unspecified started':async()=>grant(A,'unspecified'),
      'A parking started':async()=>grant(A,'parking'),
      'A other started':async()=>grant(A,'other'),
      'A not started yet':async()=>grant(A,'resident-node','10 minutes'),
      'A started, B started (two holders)':async()=>{await grant(A);await grant(B);},
      'A started, B parking':async()=>{await grant(A);await grant(B,'parking');},
      'handover window: A revoked, B not started':async()=>{await grant(B,'resident-node','5 minutes');},
      'handover done: B started, A revoked':async()=>{await grant(B);},
    };
    const expectedHolder={'no role row at all':null,'A resident-node started':A,'A unspecified started':A,'A parking started':null,'A other started':null,
      'A not started yet':null,'A started, B started (two holders)':null,'A started, B parking':A,'handover window: A revoked, B not started':null,'handover done: B started, A revoked':B};
    let compared=0;
    const runMatrix=async(label,p,phase=1)=>{
      for(const [name,setup] of Object.entries(scenarios)){
        await clearRoles();await setup();
        for(const b of [A,B,C]){
          for(const mode of MODES){
            const got=await admits(b,mode,p);
            const want=(await one(`select ($1::uuid is not null and ${LEGACY_FOR_MODE[mode]("$1::uuid","$2::uuid")})v`,[user,b])).v;
            assert.equal(got,want,`${label} / ${name} / ${mode} / ${b===A?'A':b===B?'B':'C'}`);compared++;
          }
          assert.equal((await one('select clued_private.merge_slot_admits_v1((select x from public.clued_agent_bindings x where x.id=$1))v',[b])).v,
            (await one(`select ($1::uuid is not null and ${LEGACY.mergeSlot("$1::uuid","$2::uuid")})v`,[user,b])).v,`${label} / ${name} / merge_slot_admits_v1`);compared++;
        }
        const rows=await duty(p);
        assert.equal(rows.length,expectedHolder[name]?1:0,`${label} / ${name} / holder count`);
        if(expectedHolder[name]){assert.equal(rows[0].binding_id,expectedHolder[name]);assert.equal(rows[0].source,'ci-admission');assert.equal(rows[0].phase,phase);}
      }
    };
    await t.test('no CI project (legacy account, phase 1): all modes equal the previous criteria in 10 role-row states x 3 bindings',async()=>{
      assert.equal((await one('select clued_private.ci_duty_project_v1($1)v',[user])).v,null);
      assert.equal((await one('select clued_private.ci_duty_phase_v1($1,null)v',[user])).v,1);
      await runMatrix('legacy',null);
    });

    // CI project with a pool policy; every phase 1..3 gives the same answers.
    let nodeA,nodeB;
    const qualify=id=>admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=now(),qualification_expires_at=now()+interval '1 hour',
      eligible_until=now()+interval '1 hour',hardening_observed=true,qualification_receipt_ref='fixture-reviewed-qualification' where node_id=$1`,[id]);
    await t.test('node registration for TURING-like (A) and DESK-like (B) nodes, then phases 1..3 keep the same answers',async()=>{
      const r=await f.register();nodeA=r.node_id;await f.approve(nodeA);await qualify(nodeA);
      const reg=f.registration();reg.binding_id=B;const rb=f.committed(await f.native('clued_ci_node_registration_v1',reg));nodeB=rb.node_id;await f.approve(nodeB);await qualify(nodeB);
      f.committed(await f.pool());
      const nodes=await q('select node_id,binding_id,publisher_approved,state from clued_private.ci_nodes_v1 where user_id=$1 order by created_at',[user]);
      assert.equal(nodes.length,2);assert.ok(nodes.every(n=>n.state==='active'&&n.publisher_approved),JSON.stringify(nodes));
      assert.equal((await one('select clued_private.ci_duty_project_v1($1)v',[user])).v,project);
      for(const phase of [1,2,3]){
        await f.modelMode(phase);
        assert.equal((await one('select clued_private.ci_duty_phase_v1($1,null)v',[user])).v,phase);
        await runMatrix('phase '+phase,project,phase);
      }
      // the holder row names the node of the Binding (TURING-like node for A, DESK-like node for B)
      await clearRoles();await grant(A);await f.modelMode(3);
      assert.equal((await duty())[0].node_id,nodeA);
      await clearRoles();await grant(B);
      assert.equal((await duty())[0].node_id,nodeB);
    });
    await t.test('compared count is large enough to mean something',()=>{assert.ok(compared>=4*(10*3*8)-0,String(compared));});

    await t.test('entry points keep their gate in phase 3: probe, touch, watermark path, command door, begin/abort: holder passes, others are refused',async()=>{
      await f.modelMode(3);await clearRoles();await grant(A);
      const probe=async(b)=>(await one('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb)v',[await tokenOf(b),{scope:'global',repository:'fixture/repository-12345'}],ci)).v;
      assert.equal((await probe(A)).reason,undefined);
      for(const b of [B,C])assert.equal((await probe(b)).reason,'admission_binding_required');
      const touch=async(b)=>one('select public.clued_work_merge_slot_touch_v1($1,$2::jsonb)v',[await tokenOf(b),{scope:'global',pr_ref:'x',head_sha:'1234567',ci_state:'running'}],ci);
      await assert.rejects(()=>touch(A),/work_claim_pr_ref_invalid/);
      for(const b of [B,C])assert.equal((await touch(b)).v.reason,'admission_binding_required');
      const cmd=async(b,input)=>(await one('select clued_private.work_claim_ci_command_v1($1,$2::jsonb)v',[await tokenOf(b),input])).v;
      assert.equal((await cmd(B,{action:'ci_nodes_status',scope:'global'})).error_code,'admission_binding_required');
      assert.notEqual((await cmd(A,{action:'ci_nodes_status',scope:'global'})).error_code,'admission_binding_required');
      // 20261105120000 (#1000): merge_queue_join and lease_extend sit behind the door and merge_slot_admits_v1.
      // A holder whose row is for 'other' passes the door's role check but not the resident-node rule.
      const assist=action=>({action,scope:'global',pr_ref:'fixture/repository-12345#99',head_sha:sha('assist'),...(action==='lease_extend'?{minutes:5}:{})});
      for(const action of ['merge_queue_join','lease_extend']){
        assert.equal((await cmd(B,assist(action))).error_code,'admission_binding_required',action+' B');
        const passed=await cmd(A,assist(action));
        assert.notEqual(passed.error_code,'admission_binding_required',action+' A '+JSON.stringify(passed));
        await clearRoles();await grant(A,'other');
        assert.equal((await cmd(A,assist(action))).error_code,'admission_binding_required',action+' A other');
        await clearRoles();await grant(A);
      }
      for(const fn of ['work_claim_independent_begin_v1','work_claim_independent_abort_v1']){
        const r=(await one(`select clued_private.${fn}($1,$2::jsonb)v`,[await tokenOf(B),{scope:'global',action:'x'}])).v;
        assert.equal(r.error_code,'admission_binding_required');
        const tokenA=await tokenOf(A);
        await assert.rejects(()=>one(`select clued_private.${fn}($1,$2::jsonb)v`,[tokenA,{scope:'global',action:'x'}]),/work_claim_ci_command_invalid/);
      }
    });

    await t.test('ci_publisher_current_v1 in phase 3: only a started, non-parking holder; phase 4 does not read the role',async()=>{
      await f.modelMode(3);
      const pub=(node,phase)=>one('select (clued_private.ci_publisher_current_v1($1,$2,$3,$4)).node_id n',[user,project,node,phase]);
      await clearRoles();await grant(A);assert.equal((await pub(nodeA,3)).n,nodeA);
      await assert.rejects(()=>pub(nodeB,3),/CI_ACTIVE_PUBLISHER_REQUIRED/);
      await clearRoles();await grant(A,'parking');await assert.rejects(()=>pub(nodeA,3),/CI_ACTIVE_PUBLISHER_REQUIRED/);
      await clearRoles();await grant(A,'resident-node','5 minutes');await assert.rejects(()=>pub(nodeA,3),/CI_ACTIVE_PUBLISHER_REQUIRED/);
      await f.modelMode(4);await clearRoles();
      assert.equal((await pub(nodeB,4)).n,nodeB);
    });

    // ---- phase 4: the lease is the only source of duty.
    const setLease=async(node,binding,state,expiresSql="clock_timestamp()+interval '10 minutes'")=>{
      await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]);
      await admin.query(`insert into clued_private.ci_train_lease_v1(user_id,project_id,generation,holder_node_id,holder_binding_id,state,issued_at,expires_at)
        values($1,$2,1,$3,$4,$5,clock_timestamp(),${expiresSql})`,[user,project,node,binding,state]);};
    await t.test('phase 4: duty is the lease holder (TURING-like A, DESK-like B); sweep_required counts; expired, silence, dead binding do not; old role holder loses duty',async()=>{
      await f.modelMode(4);await clearRoles();await grant(A);   // A still holds the old role row
      await setLease(nodeB,B,'active');
      let rows=await duty();assert.equal(rows.length,1);assert.deepEqual([rows[0].binding_id,rows[0].node_id,rows[0].source,rows[0].lease_state,rows[0].phase],[B,nodeB,'train-lease','active',4]);
      for(const mode of ['duty_role','duty_admits','duty_merge_slot']){
        assert.equal(await admits(B,mode),true,mode);assert.equal(await admits(A,mode),false,mode+' old role holder');assert.equal(await admits(C,mode),false,mode);
      }
      // issuer / publisher / admission modes: any approved eligible publisher node (A and B), not C
      for(const mode of ['issuer_role','issuer_admits','duty_publisher','admission_role']){
        assert.equal(await admits(A,mode),true,mode+' A');assert.equal(await admits(B,mode),true,mode+' B');assert.equal(await admits(C,mode),false,mode+' C');
      }
      await setLease(nodeB,B,'sweep_required');rows=await duty();assert.equal(rows[0].lease_state,'sweep_required');assert.equal(await admits(B,'duty_role'),true);
      await setLease(nodeA,A,'active');rows=await duty();assert.equal(rows[0].binding_id,A);assert.equal(await admits(B,'duty_merge_slot'),false);
      await setLease(nodeA,A,'active',"clock_timestamp()-interval '1 second'");assert.equal((await duty()).length,0);assert.equal(await admits(A,'duty_role'),false);
      await setLease(null,null,'silence');assert.equal((await duty()).length,0);
      await setLease(nodeA,A,'active');await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[A]);
      assert.equal((await duty()).length,0,'revoked Binding');assert.equal(await admits(A,'duty_role'),false);assert.equal(await admits(A,'issuer_role'),false);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[A]);
      // exactly one holder at all times, whatever the row states
      await setLease(nodeA,A,'active');assert.equal((await duty()).length,1);
    });

    await t.test('phase 4 entry points follow the lease: probe, touch gate, command door; the old role holder is refused',async()=>{
      await f.modelMode(4);await setLease(nodeB,B,'active');await clearRoles();await grant(A);
      const probe=async(b)=>(await one('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb)v',[await tokenOf(b),{scope:'global',repository:'fixture/repository-12345'}],ci)).v;
      assert.equal((await probe(B)).reason,undefined);assert.equal((await probe(A)).reason,'admission_binding_required');
      const cmd=async(b)=>(await one('select clued_private.work_claim_ci_command_v1($1,$2::jsonb)v',[await tokenOf(b),{action:'ci_nodes_status',scope:'global'}])).v;
      assert.equal((await cmd(A)).error_code,'admission_binding_required');assert.notEqual((await cmd(B)).error_code,'admission_binding_required');
      for(const action of ['merge_queue_join','lease_extend']){
        const input={action,scope:'global',pr_ref:'fixture/repository-12345#99',head_sha:sha('assist'),...(action==='lease_extend'?{minutes:5}:{})};
        const holder=(await one('select clued_private.work_claim_ci_command_v1($1,$2::jsonb)v',[await tokenOf(B),input])).v;
        assert.notEqual(holder.error_code,'admission_binding_required',action+' lease holder '+JSON.stringify(holder));
        assert.equal((await one('select clued_private.work_claim_ci_command_v1($1,$2::jsonb)v',[await tokenOf(A),input])).v.error_code,'admission_binding_required',action+' old role holder');
      }
      // hand the lease over: the answers move with it at once
      await setLease(nodeA,A,'active');
      assert.equal((await probe(A)).reason,undefined);assert.equal((await probe(B)).reason,'admission_binding_required');
    });

    await t.test('mode names are validated',async()=>{
      await assert.rejects(()=>admits(A,'bogus'),/ci_duty_mode_invalid/);
      assert.equal(await admits(null,'duty_role'),false);
    });

    // ---- the failover watchdog and switch from phase 4
    await t.test('phase 4 retires the 2b watchdog and refuses to switch it on; phase 3 still allows it',async()=>{
      await f.modelMode(3);
      const view=(enabled)=>one('select clued_private.ci_failover_change_view_v1($1,$2::jsonb)v',[user,{base_version:0,change:'switch',enabled}]);
      assert.equal((await view(true)).v.enabled,true);
      await f.modelMode(4);
      await assert.rejects(()=>view(true),/resident_failover_phase4_retired/);
      assert.equal((await one('select clued_private.ci_admission_failover_owner_v1($1)v',[user])).v.outcome,'phase4_retired');
      await f.modelMode(3);
      assert.notEqual((await one('select clued_private.ci_admission_failover_owner_v1($1)v',[user])).v.outcome,'phase4_retired');
    });

    // ---- the two moves
    const heartbeat=(node,b,ageSql='0 seconds')=>admin.query(`insert into clued_private.ci_node_liveness_v1(node_id,user_id,last_heartbeat_at,last_sender_binding_id,heartbeat_sequence,reported_state,reported_service_running)
      values($1,$2,clock_timestamp()-$4::interval,$3,1,'NORMAL',true) on conflict (node_id) do update set last_heartbeat_at=excluded.last_heartbeat_at`,[node,user,b,ageSql]);
    const maintenanceRequest=async()=>{
      const id=await f.enqueue({kind:'maintenance',role:'train-maintenance'});
      const j=await one('select * from clued_private.ci_jobs_v1 where job_id=$1',[id]);
      await admin.query('delete from clued_private.ci_jobs_v1 where job_id=$1',[id]).catch(()=>{});
      return {repository_id:Number(j.repository_id),kind:'maintenance',task_id:j.task_id,claim_id:j.claim_id,claim_fence:Number(j.claim_fence),execution_epoch:Number(j.execution_epoch),
        target_branch:j.target_branch,pr_ref:j.pr_ref,head_sha:j.head_sha,base_sha:j.base_sha,test_sha:j.test_sha,source_sha:j.source_sha,combination_sha256:j.combination_sha256,
        role:j.role,head_authorization_id:j.head_authorization_id,admission_id:j.admission_id};
    };
    const advance=(phase,request)=>one('select clued_private.ci_phase_3_to_4_v1($1,$2,$3,$4::jsonb)v',[user,project,phase,JSON.stringify(request)]);
    const snapshot=async()=>({phase:(await one("select policy->>'phase' ph from clued_private.ci_quota_counters_v1 where user_id=$1 and project_id=$2 and row_kind='pool_policy'",[user,project])).ph,
      lease:await q('select state,holder_node_id,generation from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]),
      jobs:Number((await one("select count(*)n from clued_private.ci_jobs_v1 where user_id=$1 and kind='maintenance'",[user])).n)});

    await t.test('3 to 4 refuses (and changes nothing) while any prerequisite is outstanding; CAS; no holder; handover window',async()=>{
      await f.modelMode(3);await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1',[user]);
      await clearRoles();await grant(A);await heartbeat(nodeA,A);
      const before=await snapshot();
      const refuse=async(request,pattern,phase=3)=>{const was=await snapshot();await assert.rejects(()=>advance(phase,request),pattern);assert.deepEqual(await snapshot(),was);};
      const request=await maintenanceRequest();
      await refuse(request,/CI_PHASE_CAS_MISMATCH/,4);
      // the shipped state: the four external items are outstanding, and they are the only thing reported
      await assert.rejects(()=>advance(3,request),e=>{assert.match(e.message,/CI_PHASE_PREREQUISITES_UNMET:green_mirror_2b,admission_issue_fact_g9,resident_phase_routing_4e,reconciliation_days_q2$/);return true;});
      assert.deepEqual(await snapshot(),before);
      // from here the external items are declared shipped (test-only replacement), the table-backed ones are real
      await admin.query("create or replace function clued_private.ci_phase_external_prerequisites_v1(u uuid,p uuid) returns text[] language sql stable as $$select '{}'::text[]$$");
      await clearRoles();await refuse(request,/holder_not_single_started_node/);
      await grant(A);await grant(B);await refuse(request,/holder_not_single_started_node/);
      await clearRoles();await grant(B,'resident-node','5 minutes');await refuse(request,/handover_in_progress,holder_not_single_started_node/);
      await clearRoles();await grant(A);
      await admin.query('delete from clued_private.ci_node_liveness_v1 where node_id=$1',[nodeA]);await refuse(request,/holder_not_alive/);
      await heartbeat(nodeA,A,'21 minutes');await refuse(request,/holder_not_alive/);
      await heartbeat(nodeA,A);
      await admin.query("update clued_private.ci_nodes_v1 set eligible_until=now()-interval '1 minute' where node_id=$1",[nodeA]);await refuse(request,/holder_node_not_eligible/);
      await qualify(nodeA);
      await admin.query("create or replace function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint language sql stable as $$select 1::bigint$$");
      await refuse(request,/open_green_in_ledger/);
      await admin.query("create or replace function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint language sql stable as $$select 0::bigint$$");
      await setLease(nodeB,B,'active');await refuse(request,/lease_not_empty/);
      await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1',[user]);
      await assert.rejects(()=>advance(3,{...request,kind:'combination_execution'}),/CI_PHASE_REQUEST_INVALID/);
      assert.deepEqual(await snapshot(),before);
    });

    let leaseAfter;
    await t.test('3 to 4 in one transaction: failover off, request created, first lease (sweep_required) held by the old duty holder, phase 4, duty follows; first renewal works',async()=>{
      await f.modelMode(3);await clearRoles();await grant(A);await heartbeat(nodeA,A);
      await admin.query(`insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)values($1,true,clock_timestamp(),3,clock_timestamp(),$2)
        on conflict (user_id) do update set enabled=true,enabled_at=clock_timestamp()`,[user,receipt]);
      const request=await maintenanceRequest();
      const out=(await advance(3,request)).v;
      assert.equal(out.phase,4);assert.equal(out.state,'sweep_required');assert.equal(out.holder_binding_id,A);assert.equal(out.holder_node_id,nodeA);
      const s=await snapshot();assert.equal(s.phase,'4');assert.equal(s.lease[0].state,'sweep_required');assert.equal(s.lease[0].holder_node_id,nodeA);assert.equal(Number(s.lease[0].generation),1);
      assert.equal((await one('select policy->>$3 m from clued_private.ci_quota_counters_v1 where user_id=$1 and project_id=$2 and row_kind=$4',[user,project,'mode','pool_policy'])).m,'pool_enforced');
      const job=await one("select state,kind,requested_node_id from clued_private.ci_jobs_v1 where job_id=$1",[out.request_job_id]);
      assert.deepEqual([job.state,job.kind,job.requested_node_id],['queued','maintenance',nodeA]);
      assert.equal((await one('select enabled from clued_private.ci_failover_settings_v1 where user_id=$1',[user])).enabled,false);
      const rows=await duty();assert.equal(rows.length,1);assert.deepEqual([rows[0].binding_id,rows[0].source,rows[0].lease_state],[A,'train-lease','sweep_required']);
      // the second advance is refused (CAS), and the first renewal on the new lease succeeds
      await assert.rejects(()=>advance(3,request),/CI_PHASE_CAS_MISMATCH/);
      const renew=(await one('select clued_private.ci_train_renew_v1($1,$2,$3,1,1)v',[user,project,nodeA])).v;assert.equal(renew.lease_version,2);
      leaseAfter=await one('select * from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]);
      // sweep confirmation moves it to active and keeps the same holder on duty
      await admin.query('select clued_private.ci_train_sweep_confirm_v1($1,$2,$3,1,$4)',[user,project,nodeA,digest('sweep')]);
      assert.equal((await duty())[0].lease_state,'active');
      // the old role row is untouched by the move (it is only no longer the source of duty)
      assert.equal((await q("select 1 from clued_private.binding_roles_v1 where user_id=$1 and binding_id=$2 and role='ci-admission' and revoked_at is null",[user,A])).length,1);
    });

    const retreat=(phase,settled=false)=>one('select clued_private.ci_phase_4_to_3_v1($1,$2,$3,$4)v',[user,project,phase,settled]);
    await t.test('4 to 3: CAS; open green blocks unless settled by readback; live holder keeps duty; lease emptied; phase 3 and the role is the source again',async()=>{
      await assert.rejects(()=>retreat(3),/CI_PHASE_CAS_MISMATCH/);
      await admin.query("create or replace function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint language sql stable as $$select 1::bigint$$");
      await assert.rejects(()=>retreat(4),/open_green_in_ledger/);
      assert.equal((await snapshot()).phase,'4');
      const out=(await retreat(4,true)).v;
      await admin.query("create or replace function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint language sql stable as $$select 0::bigint$$");
      assert.equal(out.phase,3);assert.equal(out.role_holder_kept,true);assert.equal(out.handover,null);
      const s=await snapshot();assert.equal(s.phase,'3');assert.equal(s.lease[0].state,'silence');assert.equal(s.lease[0].holder_node_id,null);
      assert.equal((await one('select policy->>$3 m from clued_private.ci_quota_counters_v1 where user_id=$1 and project_id=$2 and row_kind=$4',[user,project,'mode','pool_policy'])).m,'resident_mirror');
      const rows=await duty();assert.equal(rows.length,1);assert.deepEqual([rows[0].binding_id,rows[0].source],[A,'ci-admission']);
      assert.equal(await admits(A,'duty_role'),true);
    });

    await t.test('4 to 3 with a dead role holder: the duty is handed to the former lease holder (five minutes of nobody on duty, fail closed); and the admission-validity limit that G9 will lift is pinned',async()=>{
      await f.modelMode(3);await clearRoles();await grant(A);await heartbeat(nodeA,A);await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1',[user]);
      const request=await maintenanceRequest();
      await advance(3,request);
      // a real train handover happened meanwhile: the DESK-like node holds the lease
      await admin.query("update clued_private.ci_train_lease_v1 set holder_node_id=$3,holder_binding_id=$4,generation=generation+1 where user_id=$1 and project_id=$2",[user,project,nodeB,B]);
      assert.equal((await duty())[0].binding_id,B);assert.equal(await admits(A,'duty_role'),false);
      await heartbeat(nodeA,A,'25 minutes');   // the old role holder is silent
      const out=(await retreat(4)).v;
      assert.equal(out.role_holder_kept,false);assert.ok(out.handover.receipt_id);assert.equal(out.handover.to_binding_id,B);
      assert.equal((await duty()).length,0,'inside the five minutes nobody is on duty');
      for(const mode of ['duty_role','duty_admits','duty_merge_slot'])assert.equal(await admits(B,mode),false);
      await admin.query("update clued_private.binding_roles_v1 set effective_at=granted_at where user_id=$1 and binding_id=$2 and role='ci-admission' and revoked_at is null",[user,B]);
      assert.deepEqual([(await duty())[0].binding_id,await admits(A,'duty_role'),await admits(B,'duty_role')],[B,false,true]);
      // Documented, pre-existing limit (G9, not part of this migration): an admission is only valid while its issuer
      // holds the role, so the request built on A's admission is refused for the new duty holder B in phase 3.
      await heartbeat(nodeB,B);await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1',[user]);
      await assert.rejects(()=>advance(3,request),/CI_ADMISSION_BINDING_NOT_CURRENT/);
      assert.equal((await snapshot()).phase,'3');
    });

    await t.test('three and five nodes: only the lease holder is on duty, the others are approved publishers but not on duty (design: any number of nodes)',async()=>{
      await f.modelMode(4);
      const extra=[];for(let i=0;i<3;i++)extra.push(await f.trustedNode());
      const bindings=[A,B,...(await q('select binding_id from clued_private.ci_nodes_v1 where node_id=any($1)',[extra])).map(r=>r.binding_id)];
      const nodes=[nodeA,nodeB,...extra];
      for(let i=0;i<nodes.length;i++){
        await setLease(nodes[i],bindings[i],'active');
        const rows=await duty();assert.equal(rows.length,1);assert.equal(rows[0].binding_id,bindings[i]);
        for(let k=0;k<bindings.length;k++){
          assert.equal(await admits(bindings[k],'duty_merge_slot'),k===i,`${nodes.length} nodes: holder ${i} asks ${k}`);
          assert.equal(await admits(bindings[k],'issuer_role'),true);
        }
      }
    });
    await t.test('account with two CI projects (run last: pool policy rows are permanent history): nobody is on duty and every mode closes',async()=>{
      await f.modelMode(3);await clearRoles();await grant(A);
      await admin.query(`insert into clued_private.ci_quota_counters_v1(user_id,project_id,row_kind,metric,subject_key,unit_key,amount,policy)
        values($1,$2,'pool_policy','policy','pool','policy',0,'{"mode":"prepared","status":"UNCONFIGURED","phase":1,"limits":null,"signature_gateway_active":false}'::jsonb)`,[user,f.project2]);
      assert.equal((await duty()).length,0);
      for(const mode of MODES)assert.equal(await admits(A,mode),false,mode);
      assert.equal((await duty(project)).length,1,'with the project named, the answer is that project’s');
      assert.equal(await admits(A,'duty_role',project),true);
    });

  }finally{await f.close();}
});
