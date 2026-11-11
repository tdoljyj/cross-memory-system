import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {schedulingFixture,uuid,digest,sha} from './ci-scheduling-stage1-fixture.mjs';
import {makeJobV2} from '../../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import {makeIndependentPublicationIdentity} from '../../../scripts/ci/clued-independent-publication-identity.mjs';

const MIGRATION=new URL('../supabase/migrations/20261111064000_ci_database_lint_type_fixes_v1.sql',import.meta.url);
const PRINCIPAL='clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb)';
const ABORT='clued_private.work_claim_independent_abort_v1(text,jsonb)';
const OLD_COMMAND='    return clued_private.work_claim_ci_command_v1(p_binding_id,p_input);';
const NEW_COMMAND="    raise exception 'ci_scan_start_verify_action_forbidden' using errcode='22023';";
const OLD_RECEIPT='r.object_id=p.claim_id and r.metadata';
const NEW_RECEIPT='r.object_id=p.claim_id::text and r.metadata';
const GUARDED=['public.clued_work_verify_v1(text,jsonb)',
  'clued_private.work_claim_verify_before_execution_v1(text,jsonb)',
  'clued_private.ci_scan_start_native_source_current_v1()'];
const changedOnce=(text,before,after)=>{
  assert.equal(text.split(before).length,2,'one exact source anchor');
  return text.replace(before,after);
};

test('G4 type repairs preserve ordinary verification, abort replay and all authority boundaries',{timeout:600000},async t=>{
  const f=await schedulingFixture();
  const {admin,binding,token,user,project,claim}=f;
  const scope='project:'+project;
  const one=async(sql,args=[])=>(await admin.query(sql,args)).rows[0];
  const definition=async signature=>(await one('select pg_get_functiondef($1::regprocedure) v',[signature])).v;
  const metadata=async signature=>one(`select proowner::regrole::text owner,proacl::text acl,prosecdef,provolatile,proconfig
    from pg_proc where oid=$1::regprocedure`,[signature]);
  const receipts=async()=>Number((await one('select count(*) n from public.clued_audit_receipts where user_id=$1',[user])).n);
  const verify=input=>one('select clued_private.ci_scan_start_verify_principal_v1($1,$2::jsonb) v',[binding,input]).then(r=>r.v);
  const abort=input=>one('select clued_private.work_claim_independent_abort_v1($1,$2::jsonb) v',[token,input]).then(r=>r.v);
  const repair=await fs.readFile(MIGRATION,'utf8');
  const input={scope,claim_id:claim.claim_id,changed_paths:['work/ci-scheduling-fixture/lint.mjs']};
  try{
    t.diagnostic('actual local PostgreSQL '+(await one('show server_version')).server_version);
    const guarded=[];
    for(const signature of GUARDED)guarded.push([signature,await definition(signature),await metadata(signature)]);
    const principal=await definition(PRINCIPAL),abortDefinition=await definition(ABORT);
    const principalMetadata=await metadata(PRINCIPAL),abortMetadata=await metadata(ABORT);
    const oldPrincipal=changedOnce(principal,NEW_COMMAND,OLD_COMMAND);
    const oldAbort=changedOnce(abortDefinition,NEW_RECEIPT,OLD_RECEIPT);
    const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:888,headSha:sha('lint-head'),baseSha:sha('lint-base'),
      testSha:sha('lint-head'),sourceManifestSha256:digest('lint-source'),role:'gitleaks',attempt:1,createdAt:new Date().toISOString()});
    const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:claim.claim_id,fence:Number(claim.fence),
      execution_epoch:Number(claim.execution_epoch)},controller_id:uuid()});
    assert.equal((await one('select clued_private.work_claim_independent_identity_valid_v1($1::jsonb) valid',[identity])).valid,true);
    const publication=(await one(`insert into clued_private.work_claim_publications_v1
      (user_id,claim_id,execution_epoch,repository,head_sha,pr_ref,run_id,publication_key,independent_identity)
      values($1,$2,$3,$4,$5,$6,null,$7,$8) returning publication_id`,
      [user,claim.claim_id,claim.execution_epoch,job.repo,job.headSha,job.repo+'#888',identity.publication_key,identity])).publication_id;
    const request={action:'publication_abort_independent',scope,publication_id:publication,independent_identity:identity,
      not_sent:true,publisher_stopped:true};
    let ordinaryBefore;
    await t.test('both original broken expressions reproduce SQLSTATE 42883 before applying the repair',async()=>{
      await admin.query('begin');
      try{
        // Reverse only the two exact repaired lines to recreate the observed
        // predecessors; every other function byte and real database type stays.
        await admin.query(oldPrincipal);await admin.query(oldAbort);
        ordinaryBefore=await verify(input);assert.equal(ordinaryBefore.verdict,'ADMITTED',JSON.stringify(ordinaryBefore));
        await admin.query('savepoint old_command');
        await assert.rejects(()=>verify({...input,action:'ci_nodes_status'}),{code:'42883'});
        await admin.query('rollback to savepoint old_command');
        await admin.query('savepoint old_receipt');
        await assert.rejects(()=>abort(request),{code:'42883'});
        await admin.query('rollback to savepoint old_receipt');
        await admin.query(repair);
        assert.equal(await definition(PRINCIPAL),principal);
        assert.equal(await definition(ABORT),abortDefinition);
        assert.deepEqual(await metadata(PRINCIPAL),principalMetadata);
        assert.deepEqual(await metadata(ABORT),abortMetadata);
      }finally{await admin.query('rollback');}
    });
    await t.test('ordinary UUID-principal verification stays admitted and every action is explicitly refused without effects',async()=>{
      const before=await receipts(),ordinary=await verify(input);
      for(const field of ['status','verdict','claim_id','current_fence','execution_authorized','execution_policy'])
        assert.deepEqual(ordinary[field],ordinaryBefore[field],field);
      for(const action of [null,'','ci_nodes_status','publication_abort_independent','scan_start_independent','unknown'])
        await assert.rejects(()=>verify({...input,action}),{code:'22023',message:'ci_scan_start_verify_action_forbidden'});
      assert.equal(await receipts(),before);
      assert.equal((await one("select to_regprocedure('clued_private.work_claim_ci_command_v1(uuid,jsonb)') v")).v,null);
    });
    await t.test('abort uses actual text receipt ids, and a lost response replays the same receipt exactly once',async()=>{
      const before=await receipts(),first=await abort(request);
      assert.equal(first.status,'committed');assert.equal(first.replayed,false);
      const second=await abort(request);
      assert.equal(second.status,'committed');assert.equal(second.replayed,true);assert.equal(second.receipt_id,first.receipt_id);
      assert.equal(await receipts(),before+1);
      const receipt=await one('select object_id,operation,metadata from public.clued_audit_receipts where id=$1',[first.receipt_id]);
      assert.equal(receipt.object_id,claim.claim_id);assert.equal(receipt.operation,'work_claim_publication_abort_independent');
      assert.equal(receipt.metadata.publication_id,publication);
      await assert.rejects(()=>abort({...request,publisher_stopped:false}),{code:'22023'});
      assert.equal((await abort({...request,independent_identity:{...identity,controller_id:uuid()}})).error_code,'work_claim_publication_unresolved');
      assert.equal(await receipts(),before+1);
    });
    await t.test('a missing second source anchor rolls back the first function patch too',async()=>{
      const driftedAbort=changedOnce(abortDefinition,NEW_RECEIPT,'r.object_id = p.claim_id::text and r.metadata');
      await admin.query('begin');
      try{
        await admin.query(oldPrincipal);await admin.query(driftedAbort);
        await admin.query('savepoint before_repair');
        await assert.rejects(()=>admin.query(repair),{code:'55000'});
        await admin.query('rollback to savepoint before_repair');
        assert.equal(await definition(PRINCIPAL),oldPrincipal,'first patch left no partial change');
        assert.equal(await definition(ABORT),driftedAbort,'unexpected successor was not overwritten');
      }finally{await admin.query('rollback');}
    });
    await t.test('owners, ACLs, SECURITY DEFINER, search_path, public/core verification and Source guard remain identical',async()=>{
      assert.deepEqual(await metadata(PRINCIPAL),principalMetadata);assert.deepEqual(await metadata(ABORT),abortMetadata);
      for(const [signature,body,meta] of guarded){assert.equal(await definition(signature),body);assert.deepEqual(await metadata(signature),meta);}
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        const client=await f.connect(role);
        await assert.rejects(()=>client.query('select clued_private.ci_scan_start_verify_principal_v1($1,$2::jsonb)',[binding,input]),{code:'42501'});
        await assert.rejects(()=>client.query('select clued_private.work_claim_independent_abort_v1($1,$2::jsonb)',[token,request]),{code:'42501'});
      }
      await assert.rejects(()=>admin.query(repair),{code:'55000'});
      assert.equal(await definition(PRINCIPAL),principal);assert.equal(await definition(ABORT),abortDefinition);
    });
  }finally{await f.close();}
});
