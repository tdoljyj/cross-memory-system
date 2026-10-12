import test from 'node:test';
import assert from 'node:assert/strict';
import {captureNativeAttempt,inspectNativePopulationStore} from './merge-admission-native-population.mjs';
const repository='tdoljyj/cross-memory-system',root='/repos/'+repository+'/actions/runs/38280673705';
function fixture({attemptCreated='2026-10-12T16:54:45Z',jobConclusion='cancelled',jobEnded='2026-10-12T16:55:27Z',skipSteps=[],mutateAfter=false}={}){
  const run={id:38280673705,run_attempt:1,workflow_id:123,head_sha:'a'.repeat(40),path:'.github/workflows/clued-merge-slot-ci.yml',event:'workflow_run',status:'completed',conclusion:'cancelled',created_at:'2026-10-12T16:54:44Z',run_started_at:'2026-10-12T16:54:44Z',updated_at:'2026-10-12T16:55:28Z',pull_requests:[]};
  const jobs=[{id:114916915569,run_id:run.id,run_attempt:1,name:'clued-merge-slot-ci',status:'completed',conclusion:jobConclusion,created_at:'2026-10-12T16:54:45Z',started_at:'2026-10-12T16:54:45Z',completed_at:jobEnded,labels:['ubuntu-slim'],steps:skipSteps}];
  let attempts=0;
  return {async request(route){if(route===root)return {ok:true,body:structuredClone(run)};
    if(route===root+'/attempts/1'){attempts++;return {ok:true,body:{...structuredClone(run),created_at:mutateAfter&&attempts>1?'2026-10-12T16:54:46Z':attemptCreated}};}
    if(route.startsWith(root+'/attempts/1/jobs?'))return {ok:true,body:{total_count:jobs.length,jobs:structuredClone(jobs)}};
    throw Error('unexpected diagnostic route');}};
}
test('actual attempt DTO creation does not replace original Native run identity',async()=>{
  const f=fixture(),r=await captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'COMPLETE');assert.equal(r.packet.run.created_at,'2026-10-12T16:54:44.000Z');
  assert.equal(r.packet.timing_basis.reported_attempt_created_at,'2026-10-12T16:54:45.000Z');
  assert.equal(r.packet.run.conclusion,'cancelled');assert.equal(inspectNativePopulationStore(r.store_raw).status,'VALID_DATA_STORE');
});
test('no-op skipped scheduler timestamps are retained as metadata, never execution',async()=>{
  const f=fixture({jobConclusion:'skipped',jobEnded:'2026-10-12T16:54:44Z'}),r=await captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'COMPLETE');assert.equal(r.packet.jobs[0].conclusion,'skipped');
  assert.equal(r.packet.jobs[0].completed_at,'2026-10-12T16:54:44.000Z');assert.deepEqual(r.packet.jobs[0].steps,[]);
});
test('cancelled or successful execution retains the original contradictory-time rejection',async()=>{
  for(const conclusion of ['cancelled','success']){
    const f=fixture({jobConclusion:conclusion,jobEnded:'2026-10-12T16:54:44Z'}),r=await captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
    assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'invalid_native_job_time');
  }
});
test('skipped label with execution steps cannot bypass execution chronology',async()=>{
  const f=fixture({jobConclusion:'skipped',jobEnded:'2026-10-12T16:54:44Z',skipSteps:[{number:1,name:'untrusted execution',status:'completed',conclusion:'success',started_at:'2026-10-12T16:54:45Z',completed_at:'2026-10-12T16:54:46Z'}]}),r=await captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'invalid_native_job_time');
});
test('attempt creation metadata changing between independent reads is rejected',async()=>{
  const f=fixture({mutateAfter:true}),r=await captureNativeAttempt({request:f.request,repository,runId:'38280673705',attempt:1});
  assert.equal(r.status,'PARTIAL');assert.equal(r.reason_code,'native_attempt_reported_creation_changed');
});
