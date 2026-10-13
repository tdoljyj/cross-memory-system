// Persistent PG journal for this exact approved disposable cancellation only.
import assert from 'node:assert/strict';
export const COMPONENT_VERSION = "1.0.0";
import crypto from 'node:crypto';
export function validateStarted(fact,runId){
  assert.equal(fact.run_id,String(runId));assert.equal(fact.gate_conclusion,'success');
  assert.ok(fact.gate_job_id&&fact.idle_job_id&&fact.idle_started_at);
  assert.equal(fact.run_status,'in_progress');return fact;
}
export function validateCompleted(fact,started,runId){
  assert.equal(fact.run_id,String(runId));assert.equal(fact.run_status,'completed');
  assert.equal(fact.run_conclusion,'cancelled');assert.equal(fact.idle_conclusion,'cancelled');
  assert.equal(fact.gate_conclusion,'success');assert.equal(fact.gate_job_id,started.gate_job_id);
  assert.equal(fact.idle_job_id,started.idle_job_id);assert.equal(fact.idle_started_at,started.idle_started_at);
  assert.ok(fact.idle_completed_at);return fact;
}
export function cancellationPlan(row,current){
  assert.ok(row?.started_fact,'missing original provider started fact');
  if(current.run_status==='completed'){
    assert.ok(row.attempted_at,'no original cancellation attempt');
    validateCompleted(current,row.started_fact,row.run_id);
    return 'READ_CONFIRM_AND_SETTLE';
  }
  assert.equal(current.run_status,'in_progress');
  if(row.attempted_at)return 'READ_ONLY_WAIT'; // uncertain POST is never resent
  return 'BEGIN_EXACT_ONCE';
}
export async function cancellationJournal(db,profile){
  await db.query("create table if not exists qualification_guard.provider_cancellation_journal_v1("+
    "profile_sha256 text not null,run_id text not null,started_fact jsonb not null,binding_fact jsonb not null,"+
    "attempted_at timestamptz,response_status integer,completed_fact jsonb,updated_at timestamptz not null default clock_timestamp(),"+
    "primary key(profile_sha256));"+
    "revoke all on qualification_guard.provider_cancellation_journal_v1 from public,anon,authenticated,service_role;");
  await db.query("create table if not exists qualification_guard.provider_evidence_journal_v1("+
    "sequence bigint generated always as identity primary key,profile_sha256 text not null,kind text not null,"+
    "fact jsonb not null,observed_at timestamptz not null default clock_timestamp());"+
    "revoke all on qualification_guard.provider_evidence_journal_v1 from public,anon,authenticated,service_role;");
  bindingIdentity(profile);
  const key=[profile.profile_hash];
  const read=async()=>{
    const row=(await db.query('select * from qualification_guard.provider_cancellation_journal_v1 '+
      'where profile_sha256=$1',key)).rows[0]??null;
    if(row){assertIdleBinding(profile,row.binding_fact);assert.equal(row.run_id,row.binding_fact.started_fact.run_id);
      assert.deepEqual(row.started_fact,row.binding_fact.started_fact);}
    return row;
  };
  return {
    read,
    async recordEvidence(kind,fact){
      const encoded=JSON.stringify(fact);
      assert.ok(!/clued_(lk|wch|bnd|rk)_|PRIVATE KEY|github_pat_/.test(encoded));
      await db.query('insert into qualification_guard.provider_evidence_journal_v1(profile_sha256,kind,fact) values($1,$2,$3::jsonb)',
        [profile.profile_hash,kind,encoded]);
    },
    async evidence(){return (await db.query('select sequence,kind,fact,observed_at from qualification_guard.provider_evidence_journal_v1 '+
      'where profile_sha256=$1 order by sequence',[profile.profile_hash])).rows.map(r=>({sequence:String(r.sequence),kind:r.kind,...r.fact}));},
    async bindIdle(binding){
      assertIdleBinding(profile,binding);
      const prior=await read();
      if(prior){assert.deepEqual(prior.binding_fact,binding,'IDLE_ALREADY_BOUND_TO_OTHER_FACT');return prior;}
      // One autocommitted CAS under the single profile primary key. Once sent,
      // an uncertain response is followed only by a read, never another insert.
      try{await db.query('insert into qualification_guard.provider_cancellation_journal_v1 '+
        '(profile_sha256,run_id,started_fact,binding_fact) values($1,$2,$3::jsonb,$4::jsonb) '+
        'on conflict (profile_sha256) do nothing',
        [profile.profile_hash,binding.started_fact.run_id,JSON.stringify(binding.started_fact),JSON.stringify(binding)]);
      }catch(error){
        let existing;
        try{existing=await read();}catch(readError){const uncertain=new Error('IDLE_BINDING_RESPONSE_UNCERTAIN');
          uncertain.code='IDLE_BINDING_RESPONSE_UNCERTAIN';throw uncertain;}
        if(!existing)throw error;
        assert.deepEqual(existing.binding_fact,binding,'IDLE_ALREADY_BOUND_TO_OTHER_FACT');return existing;
      }
      const existing=await read();assert.ok(existing,'IDLE_BINDING_READBACK_MISSING');
      assert.deepEqual(existing.binding_fact,binding,'IDLE_ALREADY_BOUND_TO_OTHER_FACT');return existing;
    },
    async rememberStarted(fact){
      const prior=await read();assert.ok(prior,'ORIGINAL_IDLE_BINDING_MISSING');
      validateStarted(fact,prior.run_id);assert.deepEqual(prior.started_fact,fact);return prior;
    },
    async beginExactOnce(){
      // Transaction is committed before the actual POST. NULL response remains
      // an uncertain sent attempt; another run may only GET and settle it.
      const claimed=await db.query('update qualification_guard.provider_cancellation_journal_v1 '+
        'set attempted_at=clock_timestamp(),updated_at=clock_timestamp() '+
        'where profile_sha256=$1 and run_id=$2 and attempted_at is null returning run_id',
        [profile.profile_hash,(await read()).run_id]);
      return claimed.rowCount===1;
    },
    async rememberResponse(status){
      assert.equal(status,202);
      await db.query('update qualification_guard.provider_cancellation_journal_v1 '+
        'set response_status=$3,updated_at=clock_timestamp() where profile_sha256=$1 and run_id=$2 and attempted_at is not null',
        [profile.profile_hash,(await read()).run_id,status]);
    },
    async rememberCompleted(fact){
      const prior=await read();assert.ok(prior?.attempted_at);
      validateCompleted(fact,prior.started_fact,prior.run_id);
      await db.query('update qualification_guard.provider_cancellation_journal_v1 '+
        'set completed_fact=$3::jsonb,updated_at=clock_timestamp() where profile_sha256=$1 and run_id=$2',
        [profile.profile_hash,prior.run_id,JSON.stringify(fact)]);
      return fact;
    }
  };
}

// NOT_ACCEPTED candidate additions to the existing journal module.
const numericId=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
const publicId=value=>{
  assert.ok(typeof value==='string'||(typeof value==='number'&&Number.isSafeInteger(value)),'UNSAFE_PROVIDER_ID');
  const id=String(value);assert.ok(numericId(id),'INVALID_PROVIDER_ID');return id;
};
const dateMs=value=>{assert.equal(typeof value,'string');assert.match(value,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,'INVALID_PROVIDER_TIME');const ms=Date.parse(value);assert.ok(Number.isFinite(ms),'INVALID_PROVIDER_TIME');return ms;};
const hash64=value=>assert.match(value,/^[0-9a-f]{64}$/);
const hash40=value=>assert.match(value,/^[0-9a-f]{40}$/);
const POLICY_KEYS=['mode','workflow','workflow_blob','source_sha256','primary_definition_sha256',
  'qualifier_actor_id','qualifier_triggering_actor_id','idle_actor_id','idle_triggering_actor_id'];
export function assertIdleSelectionPolicy(profile){
  const policy=profile.idle_selection_policy;
  assert.ok(policy&&typeof policy==='object'&&!Array.isArray(policy),'IDLE_SELECTION_POLICY_MISSING');
  assert.deepEqual(Object.keys(policy).sort(),[...POLICY_KEYS].sort(),'IDLE_SELECTION_POLICY_FIELDS');
  assert.equal(policy.mode,'late-bound-single-original-journal');
  assert.equal(policy.workflow,'clued-handover-disposable-idle.yml');
  assert.equal(profile.fixture_idle_workflow,policy.workflow);
  assert.equal(policy.workflow_blob,'3c94569a38f27ba34ac53ff3bb207d9ccd674f35');
  assert.equal(policy.source_sha256,'f72524c1b5ab32a762aec59007bf85dc0ae1ddb9a9e74f38e768dbf712faaa0e');
  assert.equal(policy.primary_definition_sha256,'c26bfb67a0637206f3a26ad72bc9d9e45c039005e53602416df57871735d3647');
  for(const field of POLICY_KEYS.filter(k=>k.endsWith('_actor_id')))assert.ok(numericId(policy[field]),'ACTUAL_ACTOR_ACCEPTANCE_REQUIRED:'+field);
  assert.equal(profile.repository,'tdoljyj/cross-memory-system');
  assert.equal(profile.qualifier_workflow,'clued-handover-external-qualification.yml');
  assert.match(profile.disposable_branch,/^clued-handover-disposable-[A-Za-z0-9_.-]+$/);
  hash40(profile.head_sha);assert.ok(dateMs(profile.valid_until)>Date.now(),'IDLE_SELECTION_EXPIRED');
  return policy;
}
export function assertQualifierRun(profile,run,{id,completed=false}={}){
  const policy=assertIdleSelectionPolicy(profile);
  assert.equal(publicId(run.id),publicId(id));
  assert.equal(run.repository?.full_name,profile.repository);assert.equal(run.head_repository?.full_name,profile.repository);
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.run_attempt,1);
  assert.equal(run.path,'.github/workflows/'+profile.qualifier_workflow);
  assert.equal(run.head_sha,profile.runtime_source_commit);
  assert.equal(publicId(run.actor?.id),policy.qualifier_actor_id);
  assert.equal(publicId(run.triggering_actor?.id),policy.qualifier_triggering_actor_id);
  assert.equal(run.head_branch,profile.target_branch);
  if(completed){assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');}
  return run;
}
export function registrationCompletion(profile,{run,jobs}){
  assertQualifierRun(profile,run,{id:profile.registration_run_id,completed:true});
  assert.ok(Array.isArray(jobs.jobs)&&jobs.total_count===jobs.jobs.length&&jobs.jobs.length===2,'INCOMPLETE_REGISTER_JOBS');
  const primary=jobs.jobs.filter(j=>j.name==='clued-handover-external2');
  const gate=jobs.jobs.filter(j=>j.name==='admission-gate');
  assert.equal(primary.length,1);assert.equal(gate.length,1);
  assert.notEqual(publicId(primary[0].id),publicId(gate[0].id));
  for(const job of [primary[0],gate[0]]){
    publicId(job.id);assert.equal(publicId(job.run_id),profile.registration_run_id);
    assert.equal(job.run_attempt,1);assert.equal(job.head_sha,profile.runtime_source_commit);
    assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
    assert.ok(dateMs(job.completed_at)>=dateMs(job.started_at));
  }
  const execute=primary[0].steps?.filter(s=>s.name==='Execute declared source-only or actual External2 path');
  assert.equal(execute?.length,1);assert.equal(execute[0].status,'completed');assert.equal(execute[0].conclusion,'success');
  assert.ok(dateMs(execute[0].completed_at)>=dateMs(execute[0].started_at));
  assert.ok(dateMs(primary[0].completed_at)>=dateMs(execute[0].completed_at));
  assert.ok(dateMs(execute[0].started_at)>=dateMs(primary[0].started_at));
  assert.ok(dateMs(primary[0].started_at)>=dateMs(gate[0].completed_at));
  assert.ok(dateMs(primary[0].completed_at)<=Date.now());
  return {run_id:profile.registration_run_id,job_id:publicId(primary[0].id),
    completed_at:primary[0].completed_at,execute_step_completed_at:execute[0].completed_at};
}
export function bindingIdentity(profile){
  assertIdleSelectionPolicy(profile);
  hash64(profile.profile_hash);hash64(profile.acceptance_sha256);
  hash40(profile.accepted_source_commit);hash40(profile.runtime_source_commit);
  assert.match(profile.operator_authority_receipt,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.ok(numericId(profile.registration_run_id),'ACTUAL_REGISTRATION_RUN_REQUIRED');
  return {profile_sha256:profile.profile_hash,acceptance_sha256:profile.acceptance_sha256,
    accepted_source_commit:profile.accepted_source_commit,runtime_source_commit:profile.runtime_source_commit,
    repository:profile.repository,fixture_head_sha:profile.head_sha,fixture_branch:profile.disposable_branch,
    qualifier_workflow:profile.qualifier_workflow,operator_authority_receipt:profile.operator_authority_receipt,
    registration:profile.disposable_pg_registration,registration_run_id:profile.registration_run_id,
    idle_selection_policy:structuredClone(profile.idle_selection_policy)};
}
export function makeIdleBinding(profile,{run,jobs,content,registrationRun,registrationJobs}){
  const policy=assertIdleSelectionPolicy(profile);
  const registered=registrationCompletion(profile,{run:registrationRun,jobs:registrationJobs});
  const runId=publicId(run.id);assert.equal(runId,publicId(profile.idle_run_id));
  assert.notEqual(runId,profile.registration_run_id);
  assert.equal(run.repository?.full_name,profile.repository);assert.equal(run.head_repository?.full_name,profile.repository);
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.run_attempt,1);
  assert.equal(run.path,'.github/workflows/'+policy.workflow);assert.equal(run.head_sha,profile.head_sha);
  assert.equal(run.head_branch,profile.disposable_branch);
  assert.equal(publicId(run.actor?.id),policy.idle_actor_id);assert.equal(publicId(run.triggering_actor?.id),policy.idle_triggering_actor_id);
  assert.equal(run.status,'in_progress');assert.equal(run.conclusion,null);
  assert.ok(dateMs(run.created_at)>=dateMs(registered.completed_at),'IDLE_DISPATCH_BEFORE_REGISTRATION_COMPLETED');
  assert.ok(dateMs(run.created_at)<=Date.now(),'FUTURE_IDLE_CREATION');
  assert.equal(content.type,'file');assert.equal(content.path,'.github/workflows/'+policy.workflow);
  assert.equal(content.sha,policy.workflow_blob);assert.equal(content.encoding,'base64');
  const bytes=Buffer.from(content.content,'base64');assert.equal(bytes.length,content.size);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),policy.source_sha256,'IDLE_SOURCE_BYTES_CHANGED');
  assert.equal(crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),policy.workflow_blob);
  assert.ok(Array.isArray(jobs.jobs)&&jobs.total_count===jobs.jobs.length&&jobs.jobs.length===2,'INCOMPLETE_IDLE_JOBS');
  const gate=jobs.jobs.filter(j=>j.name==='admission-gate'),idle=jobs.jobs.filter(j=>j.name==='disposable-idle');
  assert.equal(gate.length,1);assert.equal(idle.length,1);
  for(const job of [gate[0],idle[0]]){
    publicId(job.id);assert.equal(publicId(job.run_id),runId);assert.equal(job.run_attempt,1);assert.equal(job.head_sha,profile.head_sha);
  }
  assert.equal(gate[0].status,'completed');assert.equal(gate[0].conclusion,'success');
  assert.ok(dateMs(gate[0].started_at)>=dateMs(run.created_at));
  assert.ok(dateMs(gate[0].completed_at)>=dateMs(gate[0].started_at));
  assert.equal(idle[0].status,'in_progress');assert.equal(idle[0].conclusion,null);
  assert.equal(idle[0].completed_at,null);
  assert.ok(dateMs(idle[0].started_at)>=dateMs(gate[0].completed_at));
  const steps=idle[0].steps?.filter(s=>s.name==='Bounded idle process to prove real provider cancellation');
  assert.equal(steps?.length,1);assert.equal(steps[0].status,'in_progress');assert.equal(steps[0].conclusion,null);
  assert.ok(dateMs(steps[0].started_at)>=dateMs(idle[0].started_at));
  assert.ok(dateMs(steps[0].started_at)<=Date.now());
  const started={run_id:runId,run_status:'in_progress',run_conclusion:null,
    gate_job_id:publicId(gate[0].id),gate_conclusion:'success',idle_job_id:publicId(idle[0].id),
    idle_started_at:idle[0].started_at,idle_completed_at:null,idle_conclusion:null};
  const binding={schema:'clued.external2-idle-binding/1',identity:bindingIdentity(profile),started_fact:started,
    idle_created_at:run.created_at,idle_process_started_at:steps[0].started_at,
    registration_completed_at:registered.completed_at,registration_job_id:registered.job_id};
  assertIdleBinding(profile,binding);return binding;
}
export function assertIdleBinding(profile,binding){
  assert.equal(binding.schema,'clued.external2-idle-binding/1');
  assert.deepEqual(Object.keys(binding).sort(),['schema','identity','started_fact','idle_created_at','idle_process_started_at','registration_completed_at','registration_job_id'].sort());
  publicId(binding.registration_job_id);
  assert.deepEqual(binding.identity,bindingIdentity(profile),'ORIGINAL_IDLE_BINDING_CONTEXT_CHANGED');
  assert.deepEqual(Object.keys(binding.started_fact).sort(),['run_id','run_status','run_conclusion','gate_job_id','gate_conclusion','idle_job_id','idle_started_at','idle_completed_at','idle_conclusion'].sort());
  validateStarted(binding.started_fact,binding.started_fact.run_id);publicId(binding.started_fact.run_id);
  assert.notEqual(binding.started_fact.run_id,profile.registration_run_id);
  if(profile.idle_run_id!==null)assert.equal(binding.started_fact.run_id,publicId(profile.idle_run_id),'ORIGINAL_IDLE_RUN_REPLACEMENT');
  assert.equal(binding.started_fact.run_conclusion,null);assert.equal(binding.started_fact.idle_completed_at,null);
  assert.equal(binding.started_fact.idle_conclusion,null);
  publicId(binding.started_fact.gate_job_id);publicId(binding.started_fact.idle_job_id);
  assert.notEqual(binding.started_fact.gate_job_id,binding.started_fact.idle_job_id);
  assert.ok(dateMs(binding.idle_created_at)>=dateMs(binding.registration_completed_at));
  assert.ok(dateMs(binding.started_fact.idle_started_at)>=dateMs(binding.idle_created_at));
  assert.ok(dateMs(binding.idle_process_started_at)>=dateMs(binding.started_fact.idle_started_at));
  assert.ok(dateMs(binding.idle_process_started_at)<=Date.now());
  return binding;
}
export function assertBoundIdleObservation(profile,{run,jobs},binding){
  assertIdleBinding(profile,binding);const policy=profile.idle_selection_policy,original=binding.started_fact;
  assert.equal(publicId(run.id),original.run_id,'ORIGINAL_IDLE_RUN_REPLACEMENT');
  assert.equal(run.repository?.full_name,profile.repository);assert.equal(run.head_repository?.full_name,profile.repository);
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.run_attempt,1);
  assert.equal(run.path,'.github/workflows/'+policy.workflow);assert.equal(run.head_sha,profile.head_sha);
  assert.equal(run.head_branch,profile.disposable_branch);assert.equal(run.created_at,binding.idle_created_at);
  assert.equal(publicId(run.actor?.id),policy.idle_actor_id);assert.equal(publicId(run.triggering_actor?.id),policy.idle_triggering_actor_id);
  assert.ok(Array.isArray(jobs.jobs)&&jobs.total_count===jobs.jobs.length&&jobs.jobs.length===2,'INCOMPLETE_IDLE_JOBS');
  const gate=jobs.jobs.filter(j=>j.name==='admission-gate'),idle=jobs.jobs.filter(j=>j.name==='disposable-idle');
  assert.equal(gate.length,1);assert.equal(idle.length,1);
  for(const job of [gate[0],idle[0]]){assert.equal(publicId(job.run_id),original.run_id);assert.equal(job.run_attempt,1);assert.equal(job.head_sha,profile.head_sha);}
  assert.equal(publicId(gate[0].id),original.gate_job_id);assert.equal(gate[0].status,'completed');assert.equal(gate[0].conclusion,'success');
  assert.equal(publicId(idle[0].id),original.idle_job_id);assert.equal(idle[0].started_at,original.idle_started_at);
  const process=idle[0].steps?.filter(s=>s.name==='Bounded idle process to prove real provider cancellation');
  assert.equal(process?.length,1);assert.equal(process[0].started_at,binding.idle_process_started_at);
  if(run.status==='in_progress'){
    assert.equal(run.conclusion,null);assert.equal(idle[0].status,'in_progress');assert.equal(idle[0].conclusion,null);assert.equal(idle[0].completed_at,null);
    assert.equal(process[0].status,'in_progress');assert.equal(process[0].conclusion,null);
  }else{
    assert.equal(run.status,'completed');assert.equal(run.conclusion,'cancelled');assert.equal(idle[0].status,'completed');assert.equal(idle[0].conclusion,'cancelled');
    assert.ok(dateMs(idle[0].completed_at)>=dateMs(binding.idle_process_started_at));assert.ok(dateMs(idle[0].completed_at)<=Date.now());
  }
  const fact={...original,run_status:run.status,run_conclusion:run.conclusion,idle_completed_at:idle[0].completed_at,idle_conclusion:idle[0].conclusion};
  if(run.status==='completed')validateCompleted(fact,original,original.run_id);return fact;
}
export function providerGetBudget(){
  let reads=0;
  return {take(){assert.ok(reads<160,'PROVIDER_GET_BUDGET_EXCEEDED');reads++;},get count(){return reads;}};
}
