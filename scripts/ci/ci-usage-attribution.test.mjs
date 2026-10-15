import assert from 'node:assert/strict';
import test from 'node:test';
import {admissionObservation,observationAt,collectAttribution,attributionMetrics} from './ci-usage-attribution.mjs';
import {computeMetrics,createBudget,isSelfHosted,durationMinutes,round} from './ci-usage-report.mjs';
import {ADMISSION_APP_ID as APP} from './clued-work-admission.mjs';
const sha=n=>String(n).padStart(40,'0');
const check=(extra={})=>({id:1,name:'clued-admission-verified',app:{id:APP},head_sha:sha(1),status:'completed',
  external_id:'pr:1:run:123',
  conclusion:'success',completed_at:'2026-10-05T10:00:00Z',output:{title:'ADMITTED [normal · protected · reruns 1]'},...extra});
const own=()=>[{id:1,head_sha:sha(1),event:'pull_request',pull_requests:[1],head_branch:'feature',created_at:'2026-10-05T10:00:00Z'}];
test('bind observation to exact App, head, completed verdict and fixed title grammar',()=>{
  assert.equal(admissionObservation(check(),APP,sha(1)).state,'normal');
  for(const delta of [{app:{id:10}},{head_sha:sha(2)},{status:'in_progress'}])
    assert.equal(admissionObservation(check(delta),APP,sha(1)),null);
  for(const delta of [{output:{title:'ADMITTED [normal · anything · reruns 1]'}},
    {output:{title:'REJECTED: invented private failure reason'}}]) assert.equal(admissionObservation(check(delta),APP,sha(1)).state,null);
});
test('read-only history accepts both check-name generations with the same App/head boundary',async()=>{
  for(const name of ['clued-admission-verified','kooyumi-admission-verified']){
    assert.equal(admissionObservation(check({name}),APP,sha(1)).state,'normal');
    assert.equal(admissionObservation(check({name,app:{id:15368}}),APP,sha(1)),null);
  }
  assert.equal(admissionObservation(check({name:'kooyumi-merge-slot'}),APP,sha(1)),null);
  const g=github(),request=g.request;
  g.request=route=>route.includes('/check-runs?')?{ok:true,body:{total_count:2,check_runs:[check(),check({id:2,name:'kooyumi-admission-verified'})]}}:request(route);
  const data=await collect(g);assert.equal(data.heads.get(sha(1)).length,2);
  assert.equal(g.calls.some(route=>route.includes('check_name=')),false);
});
test('later re-verification never rewrites earlier job state',()=>{
  const first=admissionObservation(check(),APP,sha(1));
  const later=admissionObservation(check({id:2,completed_at:'2026-10-05T11:00:00Z',output:{title:'RE-VERIFIED (state change): REJECTED [frozen · protected · reruns 0]'}}),APP,sha(1));
  assert.equal(observationAt([later,first],'2026-10-05T10:30:00Z',1).state,'normal');
  assert.equal(observationAt([first,later],'2026-10-05T11:01:00Z',1).state,'frozen');
  assert.equal(observationAt([first,later],'2026-10-05T09:00:00Z',1),null);
});
test('unknown newer title, identity or timestamp blocks an older mode; other PRs never assign it',()=>{
  const first=admissionObservation(check(),APP,sha(1));
  const later=extra=>admissionObservation(check({id:2,completed_at:'2026-10-05T11:00:00Z',...extra}),APP,sha(1));
  assert.equal(observationAt([first,later({output:{title:'NEW FORMAT'}})],'2026-10-05T11:01:00Z',1).state,null);
  for(const extra of [{external_id:''},{completed_at:null}])
    assert.equal(observationAt([first,later(extra)],'2026-10-05T11:01:00Z',1),null);
  assert.equal(observationAt([first],'2026-10-05T11:01:00Z',2),null);
});
function github({mainRelation='ahead',firstRelation='diverged',finalParents=[{sha:sha(4)},{sha:sha(3)}],cap=false,foreign=false}={}){
  const calls=[];
  const request=async route=>{calls.push(route);if(cap && calls.length>2)return{ok:false,stopped:'request_cap'};
    let body;
    if(route==='/apps/clued-admission')body={slug:'clued-admission',id:APP};
    else if(route.includes('/check-runs?'))body={total_count:1,check_runs:[check(foreign?{app:{id:99}}:{})]};
    else if(route.endsWith('/pulls/1'))body={number:1,merged_at:'2026-10-05T12:00:00Z',merge_commit_sha:sha(5),head:{sha:sha(3)},commits:2};
    else if(route.includes('/pulls/1/commits?'))body=[{sha:sha(1),parents:[{sha:sha(6)}]},{sha:sha(3),parents:[{sha:sha(1)},{sha:sha(2)}]}];
    else if(route.endsWith(`/git/commits/${sha(5)}`))body={sha:sha(5),parents:finalParents};
    else if(route.endsWith(`/compare/${sha(2)}...${sha(4)}`))body={status:mainRelation};
    else if(route.endsWith(`/compare/${sha(1)}...${sha(4)}`))body={status:firstRelation};
    else throw new Error('unexpected route');
    return{ok:true,body};};
  return{request,calls};
}
const collect=g=>collectAttribution({request:g.request,repository:'o/r',runs:own(),pulls:[{number:1}],runsOfPull:own});
test('count source merge candidates with pre-merge main ancestry, not historical update rounds',async()=>{
  const data=await collect(github());assert.equal(data.updates[0].count,1);assert.equal(data.coverage.pulls_complete,1);
  assert.equal((await collect(github({mainRelation:'diverged'}))).updates[0].count,0);
  assert.equal((await collect(github({firstRelation:'ahead'}))).updates[0].count,0);
});
test('squash, mismatched final source, incomplete pages and stopped budget stay unknown',async()=>{
  for(const opts of [{finalParents:[{sha:sha(4)}]},{finalParents:[{sha:sha(4)},{sha:sha(99)}]},{cap:true}]){
    const data=await collect(github(opts));assert.equal(data.updates.length,0);assert.equal(data.coverage.pulls_complete,0);
  }
  const g=github();const request=g.request;g.request=async route=>route.includes('/commits?')?{ok:true,body:[]} : request(route);
  assert.equal((await collect(g)).updates.length,0);
});
test('a missing App binding or foreign check cannot establish historical state',async()=>{
  const g=github();const request=g.request;g.request=route=>route==='/apps/clued-admission'?{ok:true,body:{id:9,slug:'other'}}:request(route);
  assert.equal((await collect(g)).heads.size,0);
  assert.deepEqual((await collect(github({foreign:true}))).heads.get(sha(1)),[]);
});
test('check history truncation invalidates the whole head sample',async()=>{
  const g=github();const request=g.request;g.request=route=>route.includes('/check-runs?')?
    {ok:true,body:{total_count:2,check_runs:[check()]}}:request(route);
  const data=await collect(g);assert.equal(data.heads.size,0);assert.equal(data.coverage.heads_complete,0);
});
test('missing totals, duplicate check IDs and duplicate commits never establish completeness',async()=>{
  for(const body of [{check_runs:[check()]},{total_count:2,check_runs:[check(),check()]},
    {total_count:0,check_runs:[check()]}]) {
    const g=github(),request=g.request;g.request=route=>route.includes('/check-runs?')?{ok:true,body}:request(route);
    assert.equal((await collect(g)).heads.size,0);
  }
  const g=github(),request=g.request;g.request=route=>route.includes('/commits?')?
    {ok:true,body:[{sha:sha(3),parents:[]},{sha:sha(3),parents:[]}]}:request(route);
  assert.equal((await collect(g)).updates.length,0);
});
test('a changing total between pages is not complete history',async()=>{
  const g=github(),request=g.request;g.request=route=>route.includes('/check-runs?')?
    {ok:true,body:route.endsWith('page=1')?{total_count:101,check_runs:Array.from({length:100},(_,i)=>check({id:i+1}))}:
      {total_count:102,check_runs:[check({id:101})]}}:request(route);
  assert.equal((await collect(g)).heads.size,0);
});
test('failed metadata read preserves unknown instead of reporting zero full coverage',async()=>{
  const g=github();const request=g.request;g.request=route=>route.includes('/check-runs?')?Promise.reject(new Error('unavailable')):request(route);
  const data=await collect(g);assert.equal(data.coverage.errors,1);assert.equal(data.heads.size,0);
});
test('all requests, including pages and compare, use the supplied budgeted reader',async()=>{
  const g=github();await collect(g);assert.equal(g.calls.length,7);assert.ok(g.calls.every(x=>x==='/apps/clued-admission'||x.startsWith('/repos/o/r/')));
});
test('partition runtime with an explicit unknown bucket and noncausal cancellation evidence',async()=>{
  const data=await collect(github());const runs=[...own(),{...own()[0],id:2,head_sha:sha(7),created_at:'2026-10-05T10:05:00Z'}];
  const job={status:'completed',labels:['self-hosted'],conclusion:'cancelled',started_at:'2026-10-05T10:01:00Z',completed_at:'2026-10-05T10:10:00Z'};
  const jobsByRun=new Map([[1,[job]],[2,[{...job,started_at:'2026-10-05T10:06:00Z'}]]]);
  const metric=attributionMetrics({runs,pulls:[{number:1}],jobsByRun,attribution:data,isSelfHosted,durationMinutes,round});
  assert.deepEqual(metric.self_hosted_minutes.by_state,{normal:9,unknown:4});
  assert.equal(metric.cancellation_observations.later_different_head_seen,1);assert.equal(metric.cancellation_observations.cause_counts,null);
});
test('report integration exposes attribution without fabricating unavailable Clued metrics',async()=>{
  const attribution=await collect(github());
  const metrics=computeMetrics({runs:own(),pulls:[],jobsByRun:new Map(),coverage:{run_list_complete:true,pull_list_complete:true,runs_with_jobs:0,runs_completed:0},
    window:{start:'2026-10-01'},budget:createBudget(),attribution});
  assert.equal(metrics.attribution.main_parent_merge_candidates.value,1);
  for(const name of ['update_main_rounds','queue_depth_p95','unclaimed_admitted','wasted_final_rounds','admission_failures_by_reason'])
    assert.equal(metrics[name].status,'not_measured');
});
test('zero metadata coverage remains null rather than a measured zero',()=>{
  const metric=attributionMetrics({runs:[],pulls:[{number:1}],jobsByRun:new Map(),
    attribution:{heads:new Map(),updates:[],coverage:{pulls_complete:0}},isSelfHosted,durationMinutes,round});
  assert.equal(metric.main_parent_merge_candidates.value,null);
});
test('same-head dispatch and push jobs do not borrow a PR admission observation',async()=>{
  const attribution=await collect(github());
  const runs=['workflow_dispatch','push'].map((event,i)=>({...own()[0],event,id:i+1}));
  const job={status:'completed',labels:['self-hosted'],conclusion:'success',started_at:'2026-10-05T10:01:00Z',completed_at:'2026-10-05T10:10:00Z'};
  const metric=attributionMetrics({runs,pulls:[{number:1,head_ref:'feature',created_at:'2026-10-05T00:00:00Z',merged_at:'2026-10-05T12:00:00Z'}],
    jobsByRun:new Map([[1,[job]],[2,[job]]]),attribution,isSelfHosted,durationMinutes,round});
  assert.deepEqual(metric.self_hosted_minutes.by_state,{unknown:18});
  assert.equal(metric.self_hosted_minutes.observed_jobs,0);
});
test('unsampled and multiply-associated PRs remain unknown on a sampled SHA',()=>{
  const checks=[admissionObservation(check(),APP,sha(1)),admissionObservation(check({id:2,external_id:'pr:999:run:123'}),APP,sha(1))];
  const attribution={heads:new Map([[sha(1),checks]]),updates:[],coverage:{pulls_complete:0}};
  const runs=[[999],[1,999]].map((pull_requests,i)=>({...own()[0],id:i+1,pull_requests}));
  const job={status:'completed',labels:['self-hosted'],conclusion:'success',started_at:'2026-10-05T10:01:00Z',completed_at:'2026-10-05T10:10:00Z'};
  const metric=attributionMetrics({runs,pulls:[{number:1}],jobsByRun:new Map([[1,[job]],[2,[job]]]),attribution,isSelfHosted,durationMinutes,round});
  assert.deepEqual(metric.self_hosted_minutes.by_state,{unknown:18});
});
