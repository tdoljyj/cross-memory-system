// Persistent PG journal for this exact approved disposable cancellation only.
import assert from 'node:assert/strict';
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
    "profile_sha256 text not null,run_id text not null,started_fact jsonb not null,"+
    "attempted_at timestamptz,response_status integer,completed_fact jsonb,updated_at timestamptz not null default clock_timestamp(),"+
    "primary key(profile_sha256,run_id));"+
    "revoke all on qualification_guard.provider_cancellation_journal_v1 from public,anon,authenticated,service_role;");
  await db.query("create table if not exists qualification_guard.provider_evidence_journal_v1("+
    "sequence bigint generated always as identity primary key,profile_sha256 text not null,kind text not null,"+
    "fact jsonb not null,observed_at timestamptz not null default clock_timestamp());"+
    "revoke all on qualification_guard.provider_evidence_journal_v1 from public,anon,authenticated,service_role;");
  const key=[profile.profile_hash,String(profile.idle_run_id)];
  const read=async()=> (await db.query('select * from qualification_guard.provider_cancellation_journal_v1 '+
    'where profile_sha256=$1 and run_id=$2',key)).rows[0]??null;
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
    async rememberStarted(fact){
      validateStarted(fact,profile.idle_run_id);
      await db.query('insert into qualification_guard.provider_cancellation_journal_v1(profile_sha256,run_id,started_fact) '+
        'values($1,$2,$3::jsonb) on conflict do nothing',[...key,JSON.stringify(fact)]);
      const prior=await read();assert.deepEqual(prior.started_fact,fact);return prior;
    },
    async beginExactOnce(){
      // Transaction is committed before the actual POST. NULL response remains
      // an uncertain sent attempt; another run may only GET and settle it.
      const claimed=await db.query('update qualification_guard.provider_cancellation_journal_v1 '+
        'set attempted_at=clock_timestamp(),updated_at=clock_timestamp() '+
        'where profile_sha256=$1 and run_id=$2 and attempted_at is null returning run_id',key);
      return claimed.rowCount===1;
    },
    async rememberResponse(status){
      assert.equal(status,202);
      await db.query('update qualification_guard.provider_cancellation_journal_v1 '+
        'set response_status=$3,updated_at=clock_timestamp() where profile_sha256=$1 and run_id=$2 and attempted_at is not null',
        [...key,status]);
    },
    async rememberCompleted(fact){
      const prior=await read();assert.ok(prior?.attempted_at);
      validateCompleted(fact,prior.started_fact,profile.idle_run_id);
      await db.query('update qualification_guard.provider_cancellation_journal_v1 '+
        'set completed_fact=$3::jsonb,updated_at=clock_timestamp() where profile_sha256=$1 and run_id=$2',
        [...key,JSON.stringify(fact)]);
      return fact;
    }
  };
}
