// Unexecuted candidate. Integrate only behind the reviewed default-branch
// workflow/registered disposable PG fixture. This module owns no credentials.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {acceptedSourceCheck,acceptedGateSourcePins} from './clued-handover-external-source-check.mjs';
import {readCanonicalGate,createEvidenceReaders} from './clued-handover-external-gate-evidence.mjs';
import {assertCanonicalClaimMatch,fixtureClaimDomains,registrationCompletion} from './clued-handover-external-journal.mjs';
import {assertFixturePull,fixturePublicationInput} from './clued-handover-external-fixture-locator.mjs';
// Planned reviewed integration location: scripts/ci/. These resolve only in
// the integrated exact Source tree, never from the scratch candidate folder.
import {postAppCheckCore} from './clued-work-admission.mjs';
import {revokeHandover} from './clued-work-claim-handover.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const appNames = new Set(['clued-admission-verified', 'clued-merge-slot']);
const syntheticOrigin = 'https://clued-handover-fixture.invalid';
const numeric = value => /^[0-9]{1,20}$/.test(String(value));
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
const response = body => new Response(JSON.stringify(body), {
  status:200, headers:{'content-type':'application/json'},
});

export function fixtureEnvironment(hostEnv, syntheticCiProof) {
  assert.equal(typeof syntheticCiProof,'string');
  assert.ok(syntheticCiProof.length >= 32);
  // Never forward the actual production Binding configuration.
  const env = Object.fromEntries(['GITHUB_REPOSITORY','GITHUB_TOKEN','GITHUB_RUN_ID',
    'GITHUB_WORKSPACE','CLUED_ADMISSION_APP_ID','CLUED_ADMISSION_APP_PRIVATE_KEY']
    .map(key => [key,hostEnv[key]]));
  return {...env, GITHUB_API_URL:'https://api.github.com',
    GITHUB_GRAPHQL_URL:'https://api.github.com/graphql',
    CLUED_SUPABASE_URL:syntheticOrigin,
    CLUED_SUPABASE_PUBLISHABLE_KEY:'isolated-fixture-only',
    CLUED_CONTEXT_READ_TOKEN:syntheticCiProof};
}

// The registered fixture driver supplies ciClient only AFTER validating its
// independent Host/operator PG registration, TLS peer, current_database(),
// exact Source migration hash set and empty-before-bootstrap proof. A plain
// caller-supplied URL/profile cannot establish those facts.
export function projectRegisteredRuntimeProfile(profile,{registrationRows,run,jobs}) {
  assert.equal(profile.qualified,true,'unqualified operator profile');
  assert.equal(profile.runtime_authority,'exact-owner-source-approval');
  assert.equal(profile.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  assert.ok(['PROJECT_CREATED_NOT_REGISTERED_OR_HOSTED_QUALIFIED','REGISTERED_DISPOSABLE'].includes(profile.provisioning_state),'UNSUPPORTED_PROVISIONING_STATE');
  assert.ok(Array.isArray(registrationRows));assert.equal(registrationRows.length,1);
  const row=registrationRows[0];assert.equal(row.realm,'clued-handover-disposable');assert.equal(row.synthetic_only,true);
  assert.equal(row.registration,profile.disposable_pg_registration);assert.equal(row.database_name,profile.database_name);
  assert.equal(row.registered_host,profile.database_host);assert.equal(row.profile_sha256,profile.profile_hash);
  assert.equal(row.operator_authority_receipt,profile.operator_authority_receipt);
  assert.equal(row.source_baseline,profile.source_baseline);assert.equal(row.source_pins_sha256,profile.source_pins_sha256);
  assert.equal(row.registered_run_id,profile.registration_run_id);
  registrationCompletion(profile,{run,jobs});
  // Runtime observation only: accepted Source bytes/hash and qualification
  // are preserved. The original on-disk profile is never rewritten.
  return {...profile,provisioning_state:'REGISTERED_DISPOSABLE'};
}
export async function guardedProvider({env,profile,fixture,ciClient,realFetch=fetch,
  loseNextCheckPostResponse=false, trace=[],journal,sourceCache}) {
  assert.ok(journal?.read&&journal?.beginExactOnce&&journal?.rememberCompleted,'persistent cancellation journal required');
  assert.equal(profile.qualified,true,'unqualified operator profile');
  assert.equal(profile.provisioning_state,'REGISTERED_DISPOSABLE');
  const actualAcceptance=acceptedSourceCheck(env.GITHUB_WORKSPACE,process.env);
  assert.equal(profile.acceptance_sha256,actualAcceptance.acceptance_sha256);
  assert.equal(profile.accepted_source_commit,actualAcceptance.accepted_source_commit);
  assert.equal(profile.profile_hash,actualAcceptance.profile_sha256);
  for(const field of ['fixture_selection_policy','idle_selection_policy','fixture_paths','fixture_claim_id'])
    assert.deepEqual(profile[field],actualAcceptance.profile[field],'ACCEPTED_FIXED_POLICY_CHANGED:'+field);
  assert.deepEqual(profile.gate_source_pins,acceptedGateSourcePins(actualAcceptance),'ACCEPTED_GATE_SOURCE_PINS_CHANGED');
  assert.equal(profile.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  assert.ok(profile.operator_authority_receipt);
  assert.equal(profile.repository,'tdoljyj/cross-memory-system');
  assert.equal(env.GITHUB_REPOSITORY,profile.repository);
  assert.equal(Number(env.CLUED_ADMISSION_APP_ID),5164952);
  assert.equal(profile.required_app_id,5164952);
  assert.match(profile.head_sha,/^[0-9a-f]{40}$/);
  assert.ok(numeric(profile.pr_number) && numeric(profile.idle_run_id));
  assert.notEqual(String(profile.idle_run_id),String(env.GITHUB_RUN_ID),'cannot cancel this qualifier');
  // The driver must install this independently registered observation view
  // in its empty test realm; payload booleans cannot replace this DB read.
  const identity=(await ciClient.query('select * from qualification_guard.runtime_identity_v1')).rows;
  assert.equal(identity.length,1,'test realm identity unavailable');
  const observedIdentity=identity[0];
  assert.equal(observedIdentity.synthetic_only,true);
  assert.equal(observedIdentity.realm,'clued-handover-disposable');
  assert.equal(observedIdentity.database_name,profile.database_name);
  assert.equal(observedIdentity.registered_host,profile.database_host);
  assert.equal(observedIdentity.registration,profile.disposable_pg_registration);
  assert.equal(observedIdentity.operator_authority_receipt,profile.operator_authority_receipt);
  assert.equal(observedIdentity.source_baseline,profile.source_baseline);
  const pinsBytes=fs.readFileSync(path.join(env.GITHUB_WORKSPACE,
    'scripts/ci/clued-handover-external-source-pins.json'));
  assert.equal(sha(pinsBytes),profile.source_pins_sha256);
  assert.equal(sha(pinsBytes),observedIdentity.source_pins_sha256);
  assert.ok(numeric(fixture.publisher_run_id));
  const repo=profile.repository, root='/repos/'+repo, number=String(profile.pr_number);
  const domains=fixtureClaimDomains(profile,fixture);
  const expectedCanonicalClaim=domains.canonical_claim_id,expectedCanonicalScope=domains.canonical_scope;
  const expectedSyntheticClaim=domains.synthetic_claim_id,expectedSyntheticScope=domains.synthetic_scope;
  assert.match(expectedSyntheticClaim,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(expectedSyntheticScope,/^(global|project:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  // Read a fresh, native main gate for this invocation. Parsed caller facts and
  // historical idle TTL never substitute for present Canonical admission.
  const readers=createEvidenceReaders({repository:repo,token:env.GITHUB_TOKEN,realFetch,sourceCache});
  const currentGate=await readCanonicalGate({profile,runId:String(env.GITHUB_RUN_ID),
    targetWorkflow:profile.qualifier_workflow,targetRef:'main',targetHead:profile.runtime_source_commit,
    ...readers,realFetch});
  assertCanonicalClaimMatch(profile,profile.fixture_locator.canonical_gate_fact,currentGate);
  const originalBinding=await journal.read();assert.ok(originalBinding?.binding_fact,'ORIGINAL_IDLE_BINDING_MISSING');
  assert.deepEqual(originalBinding.binding_fact.fixture_locator,profile.fixture_locator,'ORIGINAL_LOCATOR_CHANGED');
  assert.ok(Array.isArray(profile.fixture_paths) && profile.fixture_paths.length>0);
  assert.ok(profile.fixture_paths.every(p=>/^work\/handover-protection\/disposable-fixture\/[A-Za-z0-9_.-]+$/.test(p)));
  const checkIds=new Map(), runFacts=new Map(), headChecks=new Map(), allowedHeads=new Set();
  let cancelledIdleJobs=null;
  const provider = async (method,route,body) => {
    const r=await realFetch('https://api.github.com'+route,{
      method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{
        accept:'application/vnd.github+json',authorization:'Bearer '+env.GITHUB_TOKEN,
        'x-github-api-version':'2022-11-28','user-agent':'clued-disposable-qualification',
        ...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    assert.ok(r.ok,`GitHub preflight ${method} ${route} returned ${r.status}`);
    return r.status===204?null:r.json();
  };
  const preflight=await provider('GET',root+'/pulls/'+number);
  assert.equal(preflight.state,'open'); assert.equal(preflight.draft,true);
  assert.equal(preflight.auto_merge,null); assert.equal(preflight.head.sha,profile.head_sha);
  assert.equal(preflight.head.ref,profile.disposable_branch);
  assert.equal(preflight.head.repo.full_name,repo); assert.equal(preflight.base.repo.full_name,repo);
  assert.equal(preflight.base.ref,profile.target_branch);
  assertFixturePull(profile,preflight,profile.fixture_locator);
  assert.equal(expectedCanonicalClaim,currentGate.canonical_claim_id);
  assert.equal(expectedCanonicalScope,currentGate.scope);
  assert.ok(Number.isSafeInteger(preflight.commits) && preflight.commits>0 && preflight.commits<=250);
  let commits=[];
  for(let page=1;page<=3;page++){
    const rows=await provider('GET',root+'/pulls/'+number+'/commits?per_page=100&page='+page);
    assert.ok(Array.isArray(rows)); commits.push(...rows); if(rows.length<100)break;
  }
  assert.equal(commits.length,preflight.commits,'incomplete disposable PR ancestry');
  for(const row of commits){assert.match(row.sha,/^[0-9a-f]{40}$/);allowedHeads.add(row.sha);}
  assert.ok(allowedHeads.has(profile.head_sha));
  const files=await provider('GET',root+'/pulls/'+number+'/files?per_page=100&page=1');
  assert.ok(Array.isArray(files) && files.length<100);
  assert.equal(files.length,preflight.changed_files,'incomplete disposable PR paths');
  assert.deepEqual(files.map(f=>f.filename).sort(),[...profile.fixture_paths].sort());
  // Scan the complete explicitly bounded fixture head set before the first
  // POST/PATCH, so an unrelated live run/check fails before external effects.
  for(const head of allowedHeads){
    const checks=await provider('GET',root+'/commits/'+head+'/check-runs?filter=all&per_page=100&page=1');
    assert.ok(Array.isArray(checks.check_runs) && checks.check_runs.length<100);
    assert.equal(checks.total_count,checks.check_runs.length,'incomplete fixture checks');
    for(const c of checks.check_runs){
      if(appNames.has(c.name)){
        assert.equal(Number(c.app?.id),5164952);assert.equal(c.head_sha,head);
        checkIds.set(String(c.id),c);
      }
    }
    headChecks.set(head,checks.check_runs);
    const runs=await provider('GET',root+'/actions/runs?head_sha='+head+'&per_page=100&page=1');
    assert.ok(Array.isArray(runs.workflow_runs) && runs.workflow_runs.length<100);
    assert.equal(runs.total_count,runs.workflow_runs.length,'incomplete fixture run set');
    for(const r of runs.workflow_runs){
      if(r.status!=='completed'){
        assert.equal(String(r.id),String(profile.idle_run_id),'unrelated active head run');
        assert.equal(r.path,'.github/workflows/'+profile.fixture_idle_workflow);
      }
      runFacts.set(String(r.id),r);
    }
  }
  const idle=await provider('GET',root+'/actions/runs/'+profile.idle_run_id);
  assert.equal(idle.repository.full_name,repo); assert.equal(idle.head_sha,profile.head_sha);
  assert.equal(idle.event,'workflow_dispatch');
  assert.equal(idle.path,'.github/workflows/'+profile.fixture_idle_workflow);
  assert.equal(idle.run_attempt,1);
  const idleJobs=await provider('GET',root+'/actions/runs/'+profile.idle_run_id+'/jobs?per_page=100&page=1');
  assert.ok(Array.isArray(idleJobs.jobs)&&idleJobs.total_count===idleJobs.jobs.length&&idleJobs.jobs.length<100);
  const gate=idleJobs.jobs.filter(j=>j.name==='admission-gate');
  const runningIdle=idleJobs.jobs.filter(j=>j.name==='disposable-idle');
  assert.equal(gate.length,1);assert.equal(gate[0].status,'completed');assert.equal(gate[0].conclusion,'success');
  assert.equal(runningIdle.length,1);
  assert.ok(runningIdle[0].started_at&&Date.parse(runningIdle[0].started_at)<=Date.now());
  const processStep=runningIdle[0].steps?.filter(s=>s.name==='Bounded idle process to prove real provider cancellation');
  assert.equal(processStep?.length,1);
  assert.ok(processStep[0].started_at);
  const startedFact={run_id:String(idle.id),run_status:'in_progress',run_conclusion:null,
    gate_job_id:String(gate[0].id),gate_conclusion:'success',idle_job_id:String(runningIdle[0].id),
    idle_started_at:runningIdle[0].started_at,idle_completed_at:null,idle_conclusion:null};
  let priorCancellation=await journal.read();
  if(idle.status==='in_progress'){
    assert.equal(runningIdle[0].status,'in_progress');assert.equal(processStep[0].status,'in_progress');
    if(!priorCancellation)priorCancellation=await journal.rememberStarted(startedFact);
    assert.equal(priorCancellation.started_fact.idle_job_id,startedFact.idle_job_id);
    assert.equal(priorCancellation.started_fact.gate_job_id,startedFact.gate_job_id);
    assert.equal(priorCancellation.started_fact.idle_started_at,startedFact.idle_started_at);
  }else{
    assert.equal(idle.status,'completed');assert.equal(idle.conclusion,'cancelled');
    assert.equal(runningIdle[0].status,'completed');assert.equal(runningIdle[0].conclusion,'cancelled');
    assert.ok(priorCancellation?.attempted_at,'completed idle lacks original attempt');
    cancelledIdleJobs={...startedFact,run_status:'completed',run_conclusion:'cancelled',
      idle_completed_at:runningIdle[0].completed_at,idle_conclusion:'cancelled'};
    await journal.rememberCompleted(cancelledIdleJobs);
  }
  runFacts.set(String(idle.id),idle);
  const record=async(kind,data)=>{trace.push({sequence:trace.length+1,kind,...data});await journal.recordEvidence(kind,data);};
  await record('canonical_gate',currentGate);
  await record('preflight',{pr_number:profile.pr_number,head_sha:profile.head_sha,
    ancestry_count:commits.length,provider_pr_digest:sha(JSON.stringify(preflight)),
    idle_run_id:String(idle.id),idle_status:idle.status,fixture_only:true});
  await record('idle_started',{run_id:String(idle.id),gate_job_id:String(gate[0].id),
    idle_job_id:String(runningIdle[0].id),idle_started_at:runningIdle[0].started_at,
    gate_status:gate[0].status,gate_conclusion:gate[0].conclusion,idle_status:runningIdle[0].status,
    run_status:idle.status,original_journal_started_fact:priorCancellation.started_fact});

  async function pgRpc(body) {
    assert.equal(body.p_token_hash,sha(env.CLUED_CONTEXT_READ_TOKEN));
    const input=body.p_input;
    assert.equal(input.scope,input.action==='revocations_contexts'?'global':expectedSyntheticScope);
    if(input.claim_id)assert.equal(input.claim_id,expectedSyntheticClaim);
    const allowed=new Set(['publication_begin','publication_finish','publication_abort',
      'publication_reconcile','revocation_ack','revocations_contexts','revocations_list']);
    assert.ok(allowed.has(input.action),'unexpected fixture CI action');
    if(input.action==='publication_begin'){
      assert.equal(input.run_id,String(env.GITHUB_RUN_ID));
      assert.equal(input.pr_ref,repo+'#'+number); assert.equal(input.head_sha,profile.head_sha);
      assert.equal(input.target_branch,profile.target_branch);
    }
    if(input.action==='publication_reconcile'){
      const ticket=(await ciClient.query(`select run_id,head_sha,check_run_id from
        qualification_guard.publication_observation_v1 where publication_id=$1`,[input.publication_id])).rows[0];
      // The view is fixture-owner-installed over its isolated private table.
      assert.ok(ticket,'publication missing from registered fixture');
      assert.equal(runFacts.get(String(ticket.run_id))?.status,'completed','publisher is still alive');
      const check=checkIds.get(String(input.check_run_id));
      assert.ok(check && check.head_sha===ticket.head_sha && check.status==='completed'
        && check.conclusion==='failure','exact external effect is unconfirmed');
      assert.equal(input.publisher_stopped,true); assert.equal(input.checks_revoked,true);
    }
    if(input.action==='revocation_ack'){
      assert.equal(runFacts.get(String(profile.idle_run_id))?.status,'completed');
      assert.equal(runFacts.get(String(profile.idle_run_id))?.conclusion,'cancelled','idle completed naturally');
      assert.ok(cancelledIdleJobs,'actual cancelled idle job proof missing');
      for(const head of allowedHeads)
        assert.ok(headChecks.has(head) && headChecks.get(head).every(c=>
          !appNames.has(c.name) || c.conclusion!=='success'),'old required green remains');
      assert.deepEqual(input.evidence,{checks_revoked:true,auto_merge_disabled:true,dispatch_revoked:true});
    }
    // CI stays the actual Source CI caller (anon + dedicated synthetic Binding).
    // No production transport, owner, holder lease key or gateway token enters.
    const value=(await ciClient.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v',
      [body.p_token_hash,input])).rows[0].v;
    if(input.action==='revocations_contexts')
      assert.ok(value.context_keys?.every(scope=>scope===expectedSyntheticScope),'fixture context leakage');
    await record('fixture_rpc',{action:input.action,status:value?.status,verdict:value?.verdict,
      receipt_id:value?.receipt_id??null,publication_id:value?.publication_id??input.publication_id??null,
      outbox_id:value?.outbox_id??input.outbox_id??null,error_code:value?.error_code??null});
    return response(value);
  }

  async function fetchImpl(url,init={}) {
    const u=new URL(String(url)), method=init.method??'GET';
    const body=init.body?JSON.parse(init.body):null;
    if(u.origin===syntheticOrigin){
      assert.equal(u.pathname,'/rest/v1/rpc/clued_work_verify_v1');assert.equal(method,'POST');
      const projected=body.p_input?.action==='publication_begin'
        ? {...body,p_input:fixturePublicationInput(profile,fixture,body.p_input)} : body;
      return pgRpc(projected);
    }
    assert.equal(u.origin,'https://api.github.com','external origin unavailable');
    assert.equal(u.username+u.password,'');
    const p=u.pathname;
    let allowed=false;
    if(method==='GET' && p===root+'/installation')allowed=true;
    if(method==='POST' && /^\/app\/installations\/[0-9]+\/access_tokens$/.test(p)){
      assert.deepEqual(body,{repositories:[repo.split('/')[1]],permissions:{checks:'write'}});allowed=true;
    }
    if(method==='GET' && [root+'/pulls/'+number,root+'/pulls/'+number+'/commits',
      root+'/pulls/'+number+'/files'].includes(p))allowed=true;
    const list=/\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p);
    if(method==='GET' && list && p.startsWith(root+'/')){
      assert.ok(allowedHeads.has(list[1]));allowed=true;
    }
    const check=/\/check-runs\/([0-9]+)$/.exec(p);
    if(check && p.startsWith(root+'/') && ['GET','PATCH'].includes(method)){
      assert.ok(checkIds.has(check[1]),'cannot mutate an unobserved external check');
      if(method==='PATCH'){
        assert.equal(body.status,'completed');assert.equal(body.conclusion,'failure');
        assert.ok(appNames.has(checkIds.get(check[1]).name));
      }
      allowed=true;
    }
    if(method==='POST' && p===root+'/check-runs'){
      assert.ok(appNames.has(body.name));assert.equal(body.head_sha,profile.head_sha);
      assert.equal(body.status,'completed');
      assert.ok(['success','failure'].includes(body.conclusion));allowed=true;
    }
    const run=/\/actions\/runs\/([0-9]+)(\/cancel)?$/.exec(p);
    if(run && p.startsWith(root+'/')){
      assert.ok([String(profile.idle_run_id),String(fixture.publisher_run_id)].includes(run[1]));
      assert.ok(method==='GET'||(method==='POST'&&run[2]==='/cancel'));
      if(method==='POST'){
        assert.equal(run[1],String(profile.idle_run_id));
        assert.notEqual(run[1],String(env.GITHUB_RUN_ID));
        if(!await journal.beginExactOnce()){
          const error=new Error('CANCELLATION_ALREADY_SENT_READ_ONLY');
          error.code='CANCELLATION_ALREADY_SENT_READ_ONLY';throw error;
        }
      }
      allowed=true;
    }
    if(method==='GET' && p===root+'/actions/runs'){
      assert.ok(allowedHeads.has(u.searchParams.get('head_sha')));allowed=true;
    }
    assert.ok(allowed,`unavailable GitHub operation ${method} ${p}`);
    const result=await realFetch(u,{...init,redirect:'error',signal:AbortSignal.timeout(20000)});
    if(run&&run[2]&&method==='POST'&&result.status===202)await journal.rememberResponse(202);
    const observed=result.status===204?null:await result.clone().json().catch(()=>null);
    // Preserve provider status/order with public object IDs; never headers,
    // token responses, private SQL rows, caller proof or complete request body.
    await record('github',{method,path:p,status:result.status,
      ...(observed?.id&&check?{check_run_id:String(observed.id)}:{}),
      ...(run&&!run[2]?{run_id:run[1],run_status:observed?.status??null}:{}),
      ...(observed?.conclusion&&check?{conclusion:observed.conclusion}: {})});
    if(result.ok && method==='GET' && p===root+'/pulls/'+number){
      assert.equal(observed.head.sha,profile.head_sha,'moving disposable head');
      assert.equal(observed.auto_merge,null,'disposable PR has auto-merge');
    }
    if(result.ok && method==='GET' && list){
      assert.ok(Array.isArray(observed.check_runs));
      assert.ok(observed.check_runs.length<100 && observed.total_count===observed.check_runs.length,
        'fixture check page incomplete');
      for(const c of observed.check_runs){
        if(appNames.has(c.name)){
          assert.equal(Number(c.app?.id),5164952,'unexpected required App identity');
          assert.equal(c.head_sha,list[1]);checkIds.set(String(c.id),c);
        }
      }
      headChecks.set(list[1],observed.check_runs);
    }
    if(result.ok && check)checkIds.set(check[1],{...checkIds.get(check[1]),...observed});
    if(result.ok && method==='POST' && p===root+'/check-runs'){
      assert.equal(Number(observed.app?.id),5164952);assert.equal(observed.head_sha,profile.head_sha);
      checkIds.set(String(observed.id),observed);
      if(loseNextCheckPostResponse){
        loseNextCheckPostResponse=false;
        await record('controlled_response_loss',{check_run_id:String(observed.id),
          provider_accepted:true,retry_post_allowed:false});
        throw new Error('controlled reply loss after real disposable check POST');
      }
    }
    if(result.ok && run&&!run[2]){
      runFacts.set(run[1],observed);
      if(run[1]===String(profile.idle_run_id)&&observed.status==='completed'){
        assert.equal(observed.conclusion,'cancelled','idle ended without cancellation');
        const jobs=await provider('GET',root+'/actions/runs/'+profile.idle_run_id+'/jobs?per_page=100&page=1');
        assert.ok(Array.isArray(jobs.jobs)&&jobs.total_count===jobs.jobs.length&&jobs.jobs.length<100);
        const ended=jobs.jobs.filter(j=>String(j.id)===String(runningIdle[0].id));
        const oldGate=jobs.jobs.filter(j=>String(j.id)===String(gate[0].id));
        assert.equal(oldGate.length,1);assert.equal(oldGate[0].conclusion,'success');
        assert.equal(ended.length,1);assert.equal(ended[0].status,'completed');
        assert.equal(ended[0].conclusion,'cancelled');
        assert.equal(ended[0].started_at,runningIdle[0].started_at);
        const durableAttempt=await journal.read();assert.ok(durableAttempt?.attempted_at);
        cancelledIdleJobs={run_id:String(profile.idle_run_id),gate_job_id:String(gate[0].id),
          idle_job_id:String(ended[0].id),started_at:ended[0].started_at,completed_at:ended[0].completed_at,
          conclusion:'cancelled'};
        await journal.rememberCompleted({run_id:String(profile.idle_run_id),run_status:'completed',run_conclusion:'cancelled',
          gate_job_id:String(gate[0].id),gate_conclusion:'success',idle_job_id:String(ended[0].id),
          idle_started_at:ended[0].started_at,idle_completed_at:ended[0].completed_at,idle_conclusion:'cancelled'});
        await record('idle_cancelled',cancelledIdleJobs);
      }
    }
    if(result.ok && method==='GET' && p===root+'/actions/runs'){
      assert.ok(Array.isArray(observed.workflow_runs));
      for(const r of observed.workflow_runs){
        if(r.status!=='completed'){
          assert.equal(String(r.id),String(profile.idle_run_id),'another active disposable-head run');
          assert.equal(r.path,'.github/workflows/'+profile.fixture_idle_workflow);
        }
        runFacts.set(String(r.id),r);
      }
    }
    return result;
  }
  return {fetchImpl,trace,publicFacts:()=>({
    fixture_only:true,heads:[...allowedHeads],
    checks:[...checkIds.values()].map(c=>({id:String(c.id),head_sha:c.head_sha,
      app_id:c.app?.id,name:c.name,status:c.status,conclusion:c.conclusion,external_id:c.external_id})),
    runs:[...runFacts.values()].map(r=>({id:String(r.id),status:r.status,conclusion:r.conclusion,head_sha:r.head_sha,path:r.path})),
  })};
}

// Integration calls these with imports taken from its verified exact Source.
// No provider request is mocked; the only interception is Clued -> real
// isolated PG and one controlled loss AFTER an actual approved check POST.
export async function publishWithSource({env,profile,boundary,title}) {
  assert.match(title,/^QUALIFICATION:/);
  return postAppCheckCore({env,fetchImpl:boundary.fetchImpl,headSha:profile.head_sha,
    prNumber:profile.pr_number,success:true,title,summary:'Disposable isolated-PG qualification only; no production acceptance.'});
}
export async function revokeWithSource({env,boundary}) {
  return revokeHandover({env,workspace:env.GITHUB_WORKSPACE,fetchImpl:boundary.fetchImpl});
}
