import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {schedulingFixture,digest,sha} from './ci-scheduling-stage1-fixture.mjs';

// Unified scheduling 2A: ci_duty_holder_v1 / ci_duty_admits_v1 and the two phase moves,
// on a real PostgreSQL with the whole migration chain (DESIGN 5.1, PR 969).
// raw-binding-grants: every Binding inserted here is inserted after schedulingFixture(), which calls
// allowRawTestBindings; its trigger grants each later insert.

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MIGRATION='20261105160000_ci_duty_holder_v1.sql';
const MODES=['duty_role','duty_admits','duty_merge_slot','duty_merge_slot_sweep','duty_publisher','issuer_role','issuer_admits','admission_role'];

// The equivalence reference is the migration's own anchors: every rewrite of a yes/no expression is evaluated
// old text against new text. The anchor is the exact text the rewrite replaced in the previous definition (the
// migration fails when it is not), so the reference is the previous criterion itself, not a copy of it.
// Variables of the rewritten functions are bound to $1 (account), $2 (Binding id) and $3 (project).
const bind=text=>text
  .replaceAll('v_binding.user_id','$1::uuid').replaceAll('v_binding.id','$2::uuid')
  .replaceAll('(v_binding,','((select x from public.clued_agent_bindings x where x.id=$2::uuid),')
  .replaceAll('b.user_id','$1::uuid').replaceAll('b.id','$2::uuid')
  .replaceAll('c.user_id','$1::uuid').replaceAll('ci.id','$2::uuid').replaceAll('n.binding_id','$2::uuid')
  .replaceAll('j.project_id','$3::uuid').replace(/\bu\b/g,'$1::uuid').replace(/,p\)/g,',$3::uuid)');
async function anchorPairs(){
  const text=await fs.readFile(path.join(root,'supabase/migrations',MIGRATION),'utf8');
  // The previous merge_slot_admits_v1 body (20261031060000), for the two rewrites that stop calling it.
  const queue=await fs.readFile(path.join(root,'supabase/migrations/20261031060000_merge_train_queue_v1.sql'),'utf8');
  const head="create function clued_private.merge_slot_admits_v1(p_binding public.clued_agent_bindings) returns boolean\nlanguage sql stable security definer set search_path='' as $$";
  const start=queue.indexOf(head);assert.ok(start>0);
  const oldMergeSlot='('+queue.slice(start+head.length,queue.indexOf('$$;',start)).trim()
    .replaceAll('p_binding.user_id','$1::uuid').replaceAll('p_binding.id','$2::uuid')
    .replaceAll('(p_binding,','((select x from public.clued_agent_bindings x where x.id=$2::uuid),')+')';
  const pairs=[];
  for(const m of text.matchAll(/select clued_private\.ci_duty_patch_v1\('([^']+)',\n\$a\$([\s\S]*?)\$a\$,\n\$r\$([\s\S]*?)\$r\$\);/g)){
    let [,sig,before,after]=m;
    if(before.startsWith('if not clued_private.merge_slot_admits_v1(b) then')){
      pairs.push({sig,before:'not '+oldMergeSlot,after:bind(after.replace(/^if /,'').replace(/ then$/,''))});continue;}
    if(!/^(not )?(exists\(|clued_private\.)/.test(before))continue;   // statements, not yes/no expressions
    pairs.push({sig,before:bind(before),after:bind(after)});
  }
  // merge_slot_admits_v1 was replaced whole (touch, adopt, return, queue join, lease extend call it): old body
  // against the wrapper, which asks ci_duty_admits_v1 in mode duty_merge_slot.
  pairs.push({sig:'clued_private.merge_slot_admits_v1(public.clued_agent_bindings)',before:oldMergeSlot,
    after:'clued_private.merge_slot_admits_v1((select x from public.clued_agent_bindings x where x.id=$2::uuid))'});
  return pairs;
}

// Functions allowed to contain each kind of direct ci-admission determination, by exact name (DESIGN 5.1
// class A role management, class E failover watchdog, and the duty/phase functions themselves).
const ALLOWED={
  admits:['clued_private.ci_duty_admits_v1'],
  roleRead:['clued_private.binding_role_handover_check_v1','clued_private.binding_role_handover_core_v1','clued_private.binding_role_handover_view_v1',
    'clued_private.binding_role_resident_held_v1','clued_private.binding_role_view_v2','clued_private.ci_duty_admits_v1','clued_private.ci_duty_holder_v1',
    'clued_private.ci_phase_3_to_4_v1','clued_private.ci_phase_4_to_3_v1','public.clued_binding_roles_list_v1'],
  holders:['clued_private.binding_role_handover_view_v1','clued_private.ci_admission_failover_owner_v1','clued_private.ci_duty_admits_v1',
    'clued_private.ci_failover_candidates_v1','clued_private.ci_failover_change_view_v1','public.clued_resident_failover_v1'],
  mergeSlot:['clued_private.work_claim_ci_lease_extend_v1','clued_private.work_claim_ci_queue_join_v1','public.clued_work_claim_adopt_v1',
    'public.clued_work_merge_slot_return_v1','public.clued_work_merge_slot_touch_v1'],
};

test('unified scheduling 2A: duty holder, equivalence of every routed entry point, phase moves',{timeout:1200000},async t=>{
  const f=await schedulingFixture();const {admin,user,project,binding:A}=f;
  const q=async(text,args=[],c=admin)=>(await c.query(text,args)).rows;
  const one=async(text,args=[],c=admin)=>(await q(text,args,c))[0];
  const receipt=(await one('select id from public.clued_audit_receipts where user_id=$1 limit 1',[user])).id;
  const tokens=new Map([[A,f.token]]);
  const newBinding=async(name,owner=user)=>{const token=crypto.randomBytes(32).toString('hex');
    const id=(await one(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*'])returning id`,[owner,name,token])).id;tokens.set(id,token);return id;};
  const tokenOf=b=>{assert.ok(tokens.has(b),'raw token of '+b);return tokens.get(b);};
  const clearRoles=()=>admin.query(`update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=$2 where user_id=$1 and role='ci-admission' and revoked_at is null`,[user,receipt]);
  // parking rows never start: binding_roles_v1_parking_check requires effective_at = infinity
  const grant=(b,purpose='resident-node',startOffset='0 seconds')=>admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
    values($1,$2,'ci-admission',clock_timestamp(),$3,case when $4='parking' then 'infinity'::timestamptz else clock_timestamp()+$5::interval end,$4)`,[user,b,receipt,purpose,startOffset]);
  const duty=async(p=null)=>(await q('select * from clued_private.ci_duty_holder_v1($1,$2)',[user,p]));
  const admits=async(b,mode,p=null)=>(await one('select clued_private.ci_duty_admits_v1($1,$2,$3,$4)v',[user,b,mode,p])).v;
  const setPolicy=(phase,mode='resident_mirror',p=project)=>admin.query(`update clued_private.ci_quota_counters_v1 set policy=policy||jsonb_build_object('phase',$3::jsonb,'mode',$4::text)
    where user_id=$1 and project_id=$2 and row_kind='pool_policy'`,[user,p,JSON.stringify(phase),mode]);
  const pairs=await anchorPairs();
  try{
    const B=await newBinding('node-b'),C=await newBinding('node-c');
    const ci=await f.connect('anon');

    await t.test('static: the final definitions have no ci-admission determination outside their exact allowed functions',async()=>{
      const rows=await q(`select n.nspname||'.'||p.proname sig,p.prosrc src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','clued_private')`);
      const using=re=>rows.filter(r=>re.test(r.src)).map(r=>r.sig).sort();
      assert.deepEqual(using(/binding_role_admits_v1\s*\([^)]*'ci-admission'/),ALLOWED.admits);
      assert.deepEqual(using(/role\s*=\s*'ci-admission'/),ALLOWED.roleRead.sort());
      assert.deepEqual(using(/binding_role_holders_v1\s*\([^)]*'ci-admission'/),ALLOWED.holders.sort());
      assert.deepEqual(using(/merge_slot_admits_v1\s*\(/),ALLOWED.mergeSlot.sort());
      assert.match((await one("select prosrc from pg_proc where proname='merge_slot_admits_v1'")).prosrc,/ci_duty_admits_v1\(p_binding\.user_id,p_binding\.id,'duty_merge_slot'\)/);
      assert.equal((await q("select 1 from pg_proc where proname='ci_duty_patch_v1'")).length,0);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        const c=await f.connect(role);
        await assert.rejects(()=>c.query('select clued_private.ci_duty_holder_v1($1,null)',[user]),/permission denied/);
        await assert.rejects(()=>c.query("select clued_private.ci_duty_admits_v1($1,$1,'duty_role',null)",[user]),/permission denied/);
        await assert.rejects(()=>c.query('select clued_private.ci_phase_3_to_4_v1($1,$2,3,$3::jsonb)',[user,project,'{}']),/permission denied/);
        await assert.rejects(()=>c.query('select clued_private.ci_phase_4_to_3_v1($1,$2,4,false)',[user,project]),/permission denied/);
      }
      // 20261113090000 removed the server-principal clones of the two verify functions (20261102151506) and their
      // source guard: the hosted scan start calls the live verifier, so no copy of these rewrites can go stale.
      for(const gone of ['clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb)','clued_private.ci_scan_start_verify_core_principal_v1(uuid,jsonb)',
        'clued_private.ci_scan_start_native_source_current_v1()'])
        assert.equal((await one('select to_regprocedure($1) v',[gone])).v,null,gone);
      // every expression rewrite of the migration is in the equivalence matrix below
      assert.equal(pairs.length,19,JSON.stringify(pairs.map(p=>p.sig)));
    });

    await t.test('phase value is parsed like Stage 1; a missing or unreadable phase takes the closed phase-4 branch',async()=>{
      const v=async policy=>(await one('select clued_private.ci_duty_phase_value_v1($1::jsonb) v',[JSON.stringify(policy)])).v;
      assert.equal(await v({}),2147483647);assert.equal(await v({phase:3}),3);assert.equal(await v({phase:' 4'}),4);assert.equal(await v({phase:'100'}),100);
      assert.equal(await v({phase:'x'}),2147483647);assert.equal(await v({phase:'3.5'}),2147483647);
    });

    // ---- equivalence: each rewrite, old text against new text, in ten role-row states for three Bindings.
    const scenarios={
      'no role row at all':async()=>{},
      'A resident-node started':async()=>grant(A),
      'A unspecified started':async()=>grant(A,'unspecified'),
      'A parking (never starts)':async()=>grant(A,'parking'),
      'A other started':async()=>grant(A,'other'),
      'A not started yet':async()=>grant(A,'resident-node','10 minutes'),
      'A started, B started (two holders)':async()=>{await grant(A);await grant(B);},
      'A started, B parking':async()=>{await grant(A);await grant(B,'parking');},
      'handover window: A revoked, B not started':async()=>{await grant(B,'resident-node','5 minutes');},
      'handover done: B started, A revoked':async()=>{await grant(B);},
    };
    const expectedHolder={'no role row at all':null,'A resident-node started':A,'A unspecified started':A,'A parking (never starts)':null,'A other started':null,
      'A not started yet':null,'A started, B started (two holders)':null,'A started, B parking':A,'handover window: A revoked, B not started':null,'handover done: B started, A revoked':B};
    let compared=0;
    const runMatrix=async(label,p,phase)=>{
      for(const [name,setup] of Object.entries(scenarios)){
        await clearRoles();await setup();
        for(const b of [A,B,C]){
          for(const pair of pairs){
            const r=await one(`select (${pair.before}) o,(${pair.after}) n,$1::uuid u1,$2::uuid u2,$3::uuid u3`,[user,b,p]);
            assert.equal(r.n,r.o,`${label} / ${name} / ${pair.sig} / ${b===A?'A':b===B?'B':'C'}\n${pair.before}\n=> ${pair.after}`);compared++;
          }
        }
        const rows=await duty(p);
        assert.equal(rows.length,expectedHolder[name]?1:0,`${label} / ${name} / holder count`);
        if(expectedHolder[name]){assert.equal(rows[0].binding_id,expectedHolder[name]);assert.equal(rows[0].source,'ci-admission');assert.equal(rows[0].phase,phase);}
      }
    };
    await t.test('no CI project (legacy account; production has no pool_policy row): every rewrite equals its old text',async()=>{
      assert.equal((await one('select clued_private.ci_duty_project_v1($1)v',[user])).v,null);
      assert.equal((await one('select clued_private.ci_duty_account_phase_v1($1)v',[user])).v,1);
      await runMatrix('no CI project',null,1);
    });

    let nodeA,nodeB;
    const qualify=id=>admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=now(),qualification_expires_at=now()+interval '1 hour',
      eligible_until=now()+interval '1 hour',hardening_observed=true,qualification_receipt_ref='fixture-reviewed-qualification' where node_id=$1`,[id]).then(()=>f.live(id));
    await t.test('one CI project with TURING-like (A) and DESK-like (B) nodes: phases 1, 2 and 3 equal the old text, the project given or resolved',async()=>{
      const r=await f.register();nodeA=r.node_id;await f.approve(nodeA);await qualify(nodeA);
      const reg=f.registration();reg.binding_id=B;const rb=f.committed(await f.native('clued_ci_node_registration_v1',reg));nodeB=rb.node_id;await f.approve(nodeB);await qualify(nodeB);
      f.committed(await f.pool());
      const nodes=await q('select node_id,binding_id,publisher_approved,state from clued_private.ci_nodes_v1 where user_id=$1 order by created_at',[user]);
      assert.equal(nodes.length,2);assert.ok(nodes.every(n=>n.state==='active'&&n.publisher_approved),JSON.stringify(nodes));
      assert.equal((await one('select clued_private.ci_duty_project_v1($1)v',[user])).v,project);
      for(const phase of [1,2,3]){
        await f.modelMode(phase);
        assert.equal((await one('select clued_private.ci_duty_phase_v1($1,$2)v',[user,project])).v,phase);
        await runMatrix('phase '+phase+' project given',project,phase);
        await runMatrix('phase '+phase+' project resolved',null,phase);
      }
      await clearRoles();await grant(A);await f.modelMode(3);
      assert.equal((await duty())[0].node_id,nodeA);
      await clearRoles();await grant(B);
      assert.equal((await duty())[0].node_id,nodeB);
    });

    await t.test('a Binding id of another account is never admitted, whatever its rows',async()=>{
      const foreign=await newBinding('foreign',f.other);
      for(const mode of MODES)assert.equal(await admits(foreign,mode),false,mode);
    });

    await t.test('entry points keep their gate in phase 3: probe, touch, command door, #1000 actions, begin/abort; publication_begin open',async()=>{
      await f.modelMode(3);await clearRoles();await grant(A);
      const probe=async(b)=>(await one('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb)v',[tokenOf(b),{scope:'global',repository:'fixture/repository-12345'}],ci)).v;
      assert.equal((await probe(A)).reason,undefined);
      for(const b of [B,C])assert.equal((await probe(b)).reason,'admission_binding_required');
      const touch=(b)=>one('select public.clued_work_merge_slot_touch_v1($1,$2::jsonb)v',[tokenOf(b),{scope:'global',pr_ref:'x',head_sha:'1234567',ci_state:'running'}],ci);
      await assert.rejects(()=>touch(A),/work_claim_pr_ref_invalid/);
      for(const b of [B,C])assert.equal((await touch(b)).v.reason,'admission_binding_required');
      const cmd=async(b,input)=>(await one('select clued_private.work_claim_ci_command_v1($1,$2::jsonb)v',[tokenOf(b),input])).v;
      assert.equal((await cmd(B,{action:'ci_nodes_status',scope:'global'})).error_code,'admission_binding_required');
      assert.notEqual((await cmd(A,{action:'ci_nodes_status',scope:'global'})).error_code,'admission_binding_required');
      // the run-based publication_begin is open in phase 3 (input checks run, no phase refusal)
      await assert.rejects(()=>cmd(A,{action:'publication_begin',scope:'global'}),/work_claim_ci_command_invalid/);
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
        assert.equal((await one(`select clued_private.${fn}($1,$2::jsonb)v`,[tokenOf(B),{scope:'global',action:'x'}])).v.error_code,'admission_binding_required');
        await assert.rejects(()=>one(`select clued_private.${fn}($1,$2::jsonb)v`,[tokenOf(A),{scope:'global',action:'x'}]),/work_claim_ci_command_invalid/);
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
    await t.test('phase 4: duty is the lease holder; sweep_required allows only watermark/keepalive work; expired, silence, revoked Binding, unreadable phase do not',async()=>{
      await f.modelMode(4);await clearRoles();await grant(A);   // A still holds the old role row
      await setLease(nodeB,B,'active');
      let rows=await duty();assert.equal(rows.length,1);assert.deepEqual([rows[0].binding_id,rows[0].node_id,rows[0].source,rows[0].lease_state,rows[0].phase],[B,nodeB,'train-lease','active',4]);
      for(const mode of ['duty_role','duty_admits','duty_merge_slot','duty_merge_slot_sweep']){
        assert.equal(await admits(B,mode),true,mode);assert.equal(await admits(A,mode),false,mode+' old role holder');assert.equal(await admits(C,mode),false,mode);
      }
      for(const mode of ['issuer_role','issuer_admits','duty_publisher','admission_role']){
        assert.equal(await admits(A,mode),true,mode+' A');assert.equal(await admits(B,mode),true,mode+' B');assert.equal(await admits(C,mode),false,mode+' C');
      }
      await setLease(nodeB,B,'sweep_required');rows=await duty();assert.equal(rows[0].lease_state,'sweep_required');
      for(const mode of ['duty_role','duty_admits','duty_merge_slot_sweep'])assert.equal(await admits(B,mode),true,mode+' sweep_required');
      assert.equal(await admits(B,'duty_merge_slot'),false,'no merge-slot work while the sweep is owed');
      await setLease(nodeA,A,'active');rows=await duty();assert.equal(rows[0].binding_id,A);assert.equal(await admits(B,'duty_merge_slot'),false);
      await setLease(nodeA,A,'active',"clock_timestamp()-interval '1 second'");assert.equal((await duty()).length,0);assert.equal(await admits(A,'duty_role'),false);
      await setLease(null,null,'silence');assert.equal((await duty()).length,0);
      await setLease(nodeA,A,'active');await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[A]);
      assert.equal((await duty()).length,0,'revoked Binding');assert.equal(await admits(A,'duty_role'),false);assert.equal(await admits(A,'issuer_role'),false);
      assert.equal(await admits(A,'admission_role'),false);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[A]);
      // admission_role does not require a current qualification (an issued admission outlives a lapse), issuer_role does
      await admin.query("update clued_private.ci_nodes_v1 set qualification_expires_at=now()-interval '1 second' where node_id=$1",[nodeA]);
      assert.deepEqual([await admits(A,'admission_role'),await admits(A,'issuer_role')],[true,false]);
      await qualify(nodeA);
      // an unreadable phase closes the legacy role path: the role holder without the lease is not admitted
      await setLease(null,null,'unheld');await setPolicy('x');
      assert.equal(await admits(A,'duty_role'),false);assert.equal((await duty()).length,0);
      await f.modelMode(4);await setLease(nodeA,A,'active');assert.equal((await duty()).length,1);
    });

    await t.test('phase 4 entry points follow the lease; publication_begin is refused; the old role holder is refused',async()=>{
      await f.modelMode(4);await setLease(nodeB,B,'active');await clearRoles();await grant(A);
      const probe=async(b)=>(await one('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb)v',[tokenOf(b),{scope:'global',repository:'fixture/repository-12345'}],ci)).v;
      assert.equal((await probe(B)).reason,undefined);assert.equal((await probe(A)).reason,'admission_binding_required');
      const cmd=async(b,input)=>(await one('select clued_private.work_claim_ci_command_v1($1,$2::jsonb)v',[tokenOf(b),input])).v;
      assert.equal((await cmd(A,{action:'ci_nodes_status',scope:'global'})).error_code,'admission_binding_required');
      assert.notEqual((await cmd(B,{action:'ci_nodes_status',scope:'global'})).error_code,'admission_binding_required');
      assert.equal((await cmd(B,{action:'publication_begin',scope:'global'})).error_code,'phase_requires_reservation');
      for(const action of ['merge_queue_join','lease_extend']){
        const input={action,scope:'global',pr_ref:'fixture/repository-12345#99',head_sha:sha('assist'),...(action==='lease_extend'?{minutes:5}:{})};
        assert.notEqual((await cmd(B,input)).error_code,'admission_binding_required',action+' lease holder');
        assert.equal((await cmd(A,input)).error_code,'admission_binding_required',action+' old role holder');
      }
      // while the sweep is owed: watermark passes its gate, touch (merge-slot work) is refused
      await setLease(nodeB,B,'sweep_required');
      const watermark=await cmd(B,{action:'train_sweep_watermark',scope:'global',repository:'fixture/repository-12345',
        completed_at:new Date().toISOString(),updated_cursor:new Date(Date.now()-1000).toISOString(),main_sha:sha('main')});
      assert.notEqual(watermark.error_code,'admission_binding_required',JSON.stringify(watermark));
      assert.equal((await one('select public.clued_work_merge_slot_touch_v1($1,$2::jsonb)v',[tokenOf(B),{scope:'global',pr_ref:'x',head_sha:'1234567',ci_state:'running'}],ci)).v.reason,'admission_binding_required');
      await setLease(nodeA,A,'active');
      assert.equal((await probe(A)).reason,undefined);assert.equal((await probe(B)).reason,'admission_binding_required');
    });

    await t.test('pool apply keeps phase, mode, status and gateway flag from phase 2 on; a missing mode stays prepared, never null',async()=>{
      const policy=async()=>(await one("select policy from clued_private.ci_quota_counters_v1 where user_id=$1 and project_id=$2 and row_kind='pool_policy'",[user,project])).policy;
      await f.modelMode(4);
      await admin.query("update clued_private.ci_quota_counters_v1 set policy=policy||'{\"signature_gateway_active\":true}'::jsonb where user_id=$1 and project_id=$2 and row_kind='pool_policy'",[user,project]);
      const before=await policy();
      f.committed(await f.pool());
      let after=await policy();
      assert.deepEqual([after.phase,after.mode,after.status,after.signature_gateway_active],[before.phase,before.mode,before.status,true]);
      assert.equal((await duty()).length,1,'the lease stays the source of duty');
      // phase 2 without a mode key: the apply writes mode 'prepared' (Stage 1 compares mode='prepared' without coalesce)
      await admin.query("update clued_private.ci_quota_counters_v1 set policy=(policy-'mode'-'signature_gateway_active')||'{\"phase\":2}'::jsonb where user_id=$1 and project_id=$2 and row_kind='pool_policy'",[user,project]);
      f.committed(await f.pool());
      after=await policy();
      assert.deepEqual([after.phase,after.mode,after.signature_gateway_active],[2,'prepared',false]);
      // phase 1 is unchanged Stage 1 behaviour: the apply writes phase 1, mode prepared
      await f.modelMode(1);f.committed(await f.pool());after=await policy();
      assert.deepEqual([after.phase,after.mode],[1,'prepared']);
    });

    await t.test('mode names are validated',async()=>{
      await assert.rejects(()=>admits(A,'bogus'),/ci_duty_mode_invalid/);
      assert.equal(await admits(null,'duty_role'),false);
    });

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
      await admin.query('delete from clued_private.ci_jobs_v1 where job_id=$1',[id]);
      return {repository_id:Number(j.repository_id),kind:'maintenance',task_id:j.task_id,claim_id:j.claim_id,claim_fence:Number(j.claim_fence),execution_epoch:Number(j.execution_epoch),
        target_branch:j.target_branch,pr_ref:j.pr_ref,head_sha:j.head_sha,base_sha:j.base_sha,test_sha:j.test_sha,source_sha:j.source_sha,combination_sha256:j.combination_sha256,
        role:j.role,head_authorization_id:j.head_authorization_id,admission_id:j.admission_id};
    };
    const advance=(phase,request)=>one('select clued_private.ci_phase_3_to_4_v1($1,$2,$3,$4::jsonb)v',[user,project,phase,JSON.stringify(request)]);
    const retreat=(phase,settled=false)=>one('select clued_private.ci_phase_4_to_3_v1($1,$2,$3,$4)v',[user,project,phase,settled]);
    const snapshot=async()=>({policy:(await one("select policy from clued_private.ci_quota_counters_v1 where user_id=$1 and project_id=$2 and row_kind='pool_policy'",[user,project])).policy,
      lease:await q('select state,holder_node_id,generation,silence_until from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]),
      jobs:Number((await one("select count(*)n from clued_private.ci_jobs_v1 where user_id=$1 and kind='maintenance'",[user])).n),
      roles:await q("select binding_id,purpose,revoked_at is null live from clued_private.binding_roles_v1 where user_id=$1 and role='ci-admission' order by granted_at,id",[user])});
    const openExternal=()=>admin.query("create or replace function clued_private.ci_phase_external_prerequisites_v1(u uuid,p uuid) returns text[] language sql stable as $$select '{}'::text[]$$");
    const greens=n=>admin.query(`create or replace function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint language sql stable as $$select ${n}::bigint$$`);
    // A at phase 3 as the single started resident holder with a live node; no lease row.
    const readyPhase3=async()=>{await f.modelMode(3);await clearRoles();await grant(A);await heartbeat(nodeA,A);await qualify(nodeA);
      await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1',[user]);};

    await t.test('3 to 4 refuses (and writes nothing) while anything is outstanding: shipped list, CAS, holder, parking, liveness, eligibility, greens, lease, silence, mode',async()=>{
      await readyPhase3();
      const refuse=async(request,pattern,phase=3)=>{const was=await snapshot();await assert.rejects(()=>advance(phase,request),pattern);assert.deepEqual(await snapshot(),was);};
      const request=await maintenanceRequest();
      await refuse(request,/CI_PHASE_CAS_MISMATCH/,4);
      // as shipped: exactly the seven external items are outstanding (T2A-2 shipped G9 and G1's maintenance rule)
      await refuse(request,/CI_PHASE_PREREQUISITES_UNMET:green_mirror_writers_3d,resident_phase_routing_4e,reconciliation_days_q2,dedicated_maintenance_claim_t4,admission_meter_dedup_phase4,sweep_watermark_single_source,hosted_admission_publication_route$/);
      await openExternal();   // test-only: declare the external items shipped; the table-backed checks are real
      await clearRoles();await refuse(request,/holder_not_single_started_node/);
      await grant(A);await grant(B);await refuse(request,/holder_not_single_started_node/);
      await clearRoles();await grant(B,'resident-node','5 minutes');await refuse(request,/handover_in_progress,holder_not_single_started_node/);
      await clearRoles();await grant(A);await grant(C,'parking');
      await assert.rejects(()=>advance(3,{...request,kind:'combination_execution'}),/CI_PHASE_REQUEST_INVALID/);   // a parking row is not a handover
      await clearRoles();await grant(A);
      await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[A]);await refuse(request,/holder_binding_not_live/);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[A]);
      await admin.query('delete from clued_private.ci_node_liveness_v1 where node_id=$1',[nodeA]);await refuse(request,/holder_not_alive/);
      await heartbeat(nodeA,A,'21 minutes');await refuse(request,/holder_not_alive/);
      await heartbeat(nodeA,A);
      await admin.query("update clued_private.ci_nodes_v1 set eligible_until=now()-interval '1 minute' where node_id=$1",[nodeA]);await refuse(request,/holder_node_not_eligible/);
      await qualify(nodeA);
      await greens(1);await refuse(request,/open_green_in_ledger/);await greens(0);
      await setLease(nodeB,B,'active');await refuse(request,/lease_not_empty/);
      await setLease(null,null,'silence',"clock_timestamp()+interval '1 minute'");
      await admin.query("update clued_private.ci_train_lease_v1 set silence_until=clock_timestamp()+interval '4 minutes' where user_id=$1",[user]);
      await refuse(request,/lease_silence/);
      await admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1',[user]);
      await setPolicy(3,'prepared');await refuse(request,/pool_not_active/);await setPolicy(3,'resident_mirror');
      await assert.rejects(()=>advance(3,{...request,kind:'combination_execution'}),/CI_PHASE_REQUEST_INVALID/);
    });

    await t.test('3 to 4 in one transaction: failover off with the phase receipt, request aimed at the holder, first lease sweep_required, phase 4, mode untouched; first renewal and sweep work',async()=>{
      await readyPhase3();await grant(C,'parking');
      await admin.query(`insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)values($1,true,clock_timestamp(),3,clock_timestamp(),$2)
        on conflict (user_id) do update set enabled=true,enabled_at=clock_timestamp()`,[user,receipt]);
      const request=await maintenanceRequest();
      const out=(await advance(3,request)).v;
      assert.deepEqual([out.phase,out.state,out.holder_binding_id,out.holder_node_id],[4,'sweep_required',A,nodeA]);
      const s=await snapshot();assert.deepEqual([s.policy.phase,s.policy.mode],[4,'resident_mirror']);
      assert.deepEqual([s.lease[0].state,s.lease[0].holder_node_id,Number(s.lease[0].generation)],['sweep_required',nodeA,1]);
      const job=await one("select state,kind,requested_node_id from clued_private.ci_jobs_v1 where job_id=$1",[out.request_job_id]);
      assert.deepEqual([job.state,job.kind,job.requested_node_id],['queued','maintenance',nodeA]);
      const setting=await one('select enabled,receipt_id from clued_private.ci_failover_settings_v1 where user_id=$1',[user]);
      assert.deepEqual([setting.enabled,setting.receipt_id],[false,out.receipt_id]);
      const rows=await duty();assert.deepEqual([rows.length,rows[0].binding_id,rows[0].source,rows[0].lease_state],[1,A,'train-lease','sweep_required']);
      await assert.rejects(()=>advance(3,request),/CI_PHASE_CAS_MISMATCH/);
      assert.equal((await one('select clued_private.ci_train_renew_v1($1,$2,$3,1,1)v',[user,project,nodeA])).v.lease_version,2);
      await admin.query('select clued_private.ci_train_sweep_confirm_v1($1,$2,$3,1,$4)',[user,project,nodeA,digest('sweep')]);
      assert.equal((await duty())[0].lease_state,'active');
      assert.equal((await q("select 1 from clued_private.binding_roles_v1 where user_id=$1 and binding_id=$2 and role='ci-admission' and revoked_at is null",[user,A])).length,1);
    });

    await t.test('4 to 3, live holder: CAS; open green blocks unless settled; outcome kept; lease silenced; phase 3, mode untouched',async()=>{
      await assert.rejects(()=>retreat(3),/CI_PHASE_CAS_MISMATCH/);
      await greens(1);await assert.rejects(()=>retreat(4),/open_green_in_ledger/);
      assert.equal((await snapshot()).policy.phase,4);
      const out=(await retreat(4,true)).v;await greens(0);
      assert.deepEqual([out.phase,out.outcome,out.role_holder_kept,out.handover],[3,'kept',true,null]);
      const s=await snapshot();assert.deepEqual([s.policy.phase,s.policy.mode,s.lease[0].state,s.lease[0].holder_node_id],[3,'resident_mirror','silence',null]);
      const rows=await duty();assert.deepEqual([rows.length,rows[0].binding_id,rows[0].source],[1,A,'ci-admission']);
    });

    // From phase 4 with A as role holder and the lease moved to `holder` (a real train handover), A silent.
    const phase4WithLease=async(node,binding)=>{
      await readyPhase3();await advance(3,await maintenanceRequest());
      await admin.query("update clued_private.ci_train_lease_v1 set holder_node_id=$3,holder_binding_id=$4,generation=generation+1 where user_id=$1 and project_id=$2",[user,project,node,binding]);
      await heartbeat(nodeA,A,'25 minutes');
    };
    await t.test('4 to 3, dead holder: handed to the former lease holder; its parking row is revoked first; a third party parking row is untouched',async()=>{
      // P3: C holds parking, the lease is B's
      await phase4WithLease(nodeB,B);await grant(C,'parking');
      let out=(await retreat(4)).v;
      assert.deepEqual([out.outcome,out.handover.to_binding_id,out.handover.from_binding_id],['handed_over',B,A]);
      let roles=(await snapshot()).roles.filter(r=>r.live);
      assert.deepEqual(roles.map(r=>[r.binding_id,r.purpose]).sort(),[[B,'resident-node'],[C,'parking']].sort());
      assert.equal((await duty()).length,0,'inside the five minutes nobody is on duty');
      for(const mode of ['duty_role','duty_admits','duty_merge_slot'])assert.equal(await admits(B,mode),false);
      await admin.query("update clued_private.binding_roles_v1 set effective_at=granted_at where user_id=$1 and binding_id=$2 and role='ci-admission' and revoked_at is null",[user,B]);
      assert.deepEqual([(await duty())[0].binding_id,await admits(A,'duty_role'),await admits(B,'duty_role')],[B,false,true]);
      // P2: the lease holder B itself holds a parking row
      await phase4WithLease(nodeB,B);await grant(B,'parking');
      out=(await retreat(4)).v;
      assert.deepEqual([out.outcome,out.handover.to_binding_id],['handed_over',B]);
      roles=(await snapshot()).roles.filter(r=>r.live);
      assert.deepEqual(roles.map(r=>[r.binding_id,r.purpose]),[[B,'resident-node']]);
    });

    await t.test('4 to 3, lease emptied by a node revoke: the last holder (last_holder_node_id) receives the role',async()=>{
      await phase4WithLease(nodeB,B);
      await admin.query("update clued_private.ci_train_lease_v1 set state='silence',last_holder_node_id=holder_node_id,holder_node_id=null,holder_binding_id=null where user_id=$1",[user]);
      const out=(await retreat(4)).v;
      assert.deepEqual([out.outcome,out.handover.to_binding_id],['handed_over',B]);
    });

    await t.test('4 to 3 refuses as a whole (still phase 4, nothing written) when the role cannot be placed',async()=>{
      const refuse=async(pattern)=>{const was=await snapshot();await assert.rejects(()=>retreat(4),pattern);assert.deepEqual(await snapshot(),was);};
      // the handover core refuses a target that is not live
      await phase4WithLease(nodeB,B);
      await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[B]);
      await refuse(/binding_role_handover_target_invalid/);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[B]);
      // no single resident holder
      await grant(C);await refuse(/CI_PHASE_ROLLBACK_NO_SINGLE_HOLDER/);
      await admin.query("update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=$2 where binding_id=$1 and revoked_at is null",[C,receipt]);
      // no last lease holder to hand to
      await admin.query("update clued_private.ci_train_lease_v1 set holder_node_id=null,holder_binding_id=null,last_holder_node_id=null where user_id=$1",[user]);
      await refuse(/CI_PHASE_ROLLBACK_NO_LEASE_HOLDER/);
      // no resident holder at all: the last lease holder is granted the role (five-minute start), its parking row revoked first
      await admin.query("update clued_private.ci_train_lease_v1 set holder_node_id=$2,holder_binding_id=$3 where user_id=$1",[user,nodeB,B]);
      await clearRoles();await grant(B,'parking');
      const was=await snapshot();
      await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[B]);
      await assert.rejects(()=>retreat(4),/CI_PHASE_ROLLBACK_TARGET_INVALID/);assert.deepEqual(await snapshot(),was);
      await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[B]);
      const granted=(await retreat(4)).v;
      assert.deepEqual([granted.outcome,granted.handover.to_binding_id,granted.handover.from_binding_id],['granted',B,null]);
      const live=(await snapshot()).roles.filter(r=>r.live);
      assert.deepEqual(live.map(r=>[r.binding_id,r.purpose]),[[B,'resident-node']]);
      assert.equal((await duty()).length,0,'the grant starts after five minutes');
      const kinds=(await q(`select r.metadata->>'receipt_kind' k from clued_private.binding_roles_v1 x join public.clued_audit_receipts r on r.id in (x.granted_receipt_id,x.revoked_receipt_id)
        where x.user_id=$1 and x.binding_id=$2 and x.role='ci-admission' order by 1`,[user,B])).map(r=>r.k);
      assert.ok(kinds.includes('CI_ADMISSION_PHASE_ROLLBACK_GRANTED')&&kinds.includes('CI_ADMISSION_PHASE_ROLLBACK_PARKING_REVOKED'),JSON.stringify(kinds));
      // the dead holder was the lease holder itself: nobody better, it stays
      await phase4WithLease(nodeB,B);
      await admin.query("update clued_private.ci_train_lease_v1 set holder_node_id=$2,holder_binding_id=$3 where user_id=$1",[user,nodeA,A]);
      assert.equal((await retreat(4)).v.outcome,'holder_is_former_lease_holder');
    });

    await t.test('G9 (T2A-2): an admission issued on duty survives the handover; one issued before the migration keeps the old rule',async()=>{
      await readyPhase3();const request=await maintenanceRequest();
      assert.equal((await one('select issuer_on_duty x from clued_private.work_claim_execution_admissions_v1 where admission_id=$1',[request.admission_id])).x,true);
      await clearRoles();await grant(B);await heartbeat(nodeB,B);await qualify(nodeB);
      const enqueued=await one('select clued_private.ci_job_enqueue_v1($1,$2,$3::jsonb) id',[user,project,
        JSON.stringify({...request,kind:'combination_execution',role:'batch',combination_sha256:'c'.repeat(64)})]).catch(e=>e);
      assert.ok(!(enqueued instanceof Error),String(enqueued));
      const job=await one('select * from clued_private.ci_jobs_v1 where job_id=$1',[enqueued.id]);
      // legacy row (no recorded fact): the issuer must hold the role now, as before
      await admin.query('alter table clued_private.work_claim_execution_admissions_v1 disable trigger work_claim_execution_admissions_issue_fact_v1');
      await admin.query('update clued_private.work_claim_execution_admissions_v1 set issuer_on_duty=null where admission_id=$1',[request.admission_id]);
      await admin.query('alter table clued_private.work_claim_execution_admissions_v1 enable trigger work_claim_execution_admissions_issue_fact_v1');
      await assert.rejects(()=>one('select clued_private.ci_claim_current_v1($1,j) from clued_private.ci_jobs_v1 j where job_id=$2',[user,job.job_id]),/CI_ADMISSION_BINDING_NOT_CURRENT/);
      await assert.rejects(()=>admin.query('update clued_private.work_claim_execution_admissions_v1 set issuer_on_duty=true where admission_id=$1',[request.admission_id]),/CI_IMMUTABLE_FACT/);
    });

    await t.test('three and five nodes: only the lease holder is on duty, every approved publisher may issue',async()=>{
      await f.modelMode(4);
      const extra=[];for(let i=0;i<3;i++)extra.push(await f.trustedNode());
      const bindings=[A,B,...(await q('select binding_id from clued_private.ci_nodes_v1 where node_id=any($1) order by array_position($1,node_id)',[extra])).map(r=>r.binding_id)];
      const nodes=[nodeA,nodeB,...extra];
      for(const count of [3,5])for(let i=0;i<count;i++){
        await setLease(nodes[i],bindings[i],'active');
        const rows=await duty();assert.equal(rows.length,1);assert.equal(rows[0].binding_id,bindings[i]);
        for(let k=0;k<count;k++){
          assert.equal(await admits(bindings[k],'duty_merge_slot'),k===i,`${count} nodes: holder ${i} asks ${k}`);
          assert.equal(await admits(bindings[k],'issuer_role'),true);
        }
      }
    });

    await t.test('4 to 3 never hands the role to a node the Owner revoked (Native revoke empties the lease into last_holder_node_id)',async()=>{
      await phase4WithLease(nodeB,B);await clearRoles();
      const version=Number((await one('select version from clued_private.ci_nodes_v1 where node_id=$1',[nodeB])).version);
      const issue=await f.native('clued_ci_node_confirmation_issue_v1',{project_id:project,node_id:nodeB,base_version:version,action:'revoke',accepted_ref:'fixture-owner-revoke'});
      f.committed(await f.native('clued_ci_node_apply_v1',{confirmation_token:issue.confirmation_token,view_digest:issue.view_digest}));
      const lease=await one('select state,holder_node_id,last_holder_node_id from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2',[user,project]);
      assert.deepEqual([lease.state,lease.holder_node_id,lease.last_holder_node_id],['silence',null,nodeB]);
      const was=await snapshot();
      await assert.rejects(()=>retreat(4),/CI_PHASE_ROLLBACK_NO_LEASE_HOLDER/);
      assert.deepEqual(await snapshot(),was);
      // a lease still naming the revoked node (no sweep yet) is refused the same way
      await admin.query("update clued_private.ci_train_lease_v1 set state='active',holder_node_id=$2,holder_binding_id=$3,expires_at=clock_timestamp()+interval '5 minutes' where user_id=$1",[user,nodeB,B]);
      await assert.rejects(()=>retreat(4),/CI_PHASE_ROLLBACK_NO_LEASE_HOLDER/);
      await admin.query("update clued_private.ci_train_lease_v1 set state='silence',holder_node_id=null,holder_binding_id=null where user_id=$1",[user]);
      assert.equal((await q("select 1 from clued_private.binding_roles_v1 where user_id=$1 and binding_id=$2 and role='ci-admission' and revoked_at is null",[user,B])).length,0);
    });

    await t.test('two CI projects (run last: pool policy rows are permanent): at phase <= 3 every rewrite still equals its old text; one project at 4 closes the unresolved account',async()=>{
      await f.modelMode(3);await setLease(null,null,'unheld');
      f.committed(await f.pool(f.project2,23456));
      assert.equal((await one('select clued_private.ci_duty_ambiguous_v1($1)v',[user])).v,true);
      await runMatrix('two projects, unresolved',null,3);
      await clearRoles();await grant(A);
      await f.modelMode(4);
      assert.equal((await duty()).length,0);
      for(const mode of MODES)assert.equal(await admits(A,mode),false,mode);
      await setLease(nodeA,A,'active');
      assert.equal((await duty(project)).length,1,'with the project named, the answer is that project\'s');
      assert.equal(await admits(A,'duty_role',project),true);
    });

    await t.test('compared: every rewrite x 10 role-row states x 3 Bindings x 8 contexts',()=>{assert.equal(compared,pairs.length*10*3*8);});
  }finally{await f.close();}
});
