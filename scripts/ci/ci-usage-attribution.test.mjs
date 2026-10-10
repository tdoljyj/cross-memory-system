import assert from 'node:assert/strict';
import test from 'node:test';
import {admissionObservation,observationAt,collectAttribution,attributionMetrics} from './ci-usage-attribution.mjs';
import {computeMetrics,createBudget,isSelfHosted,durationMinutes,round} from './ci-usage-report.mjs';
const sha=n=>String(n).padStart(40,'0');
const check=(extra={})=>({id:1,name:'clued-admission-verified',app:{id:9},head_sha:sha(1),status:'completed',
  conclusion:'success',completed_at:'2026-10-05T10:00:00Z',output:{title:'ADMITTED [normal · protected · reruns 1]'},...extra});
const own=()=>[{id:1,head_sha:sha(1),event:'pull_request',head_branch:'feature',created_at:'2026-10-05T10:00:00Z'}];
test('bind observation to exact App, head, completed verdict and fixed title grammar',()=>{
  assert.equal(admissionObservation(check(),9,sha(1)).state,'normal');
  for(const delta of [{app:{id:10}},{head_sha:sha(2)},{status:'in_progress'},
    {completed_at:null},{output:{title:'ADMITTED [normal · anything · reruns 1]'}},
    {output:{title:'REJECTED: invented private failure reason'}}]) assert.equal(admissionObservation(check(delta),9,sha(1)),null);
});
test('later re-verification never rewrites earlier job state',()=>{
  const first=admissionObservation(check(),9,sha(1));
  const later=admissionObservation(check({id:2,completed_at:'2026-10-05T11:00:00Z',output:{title:'REJECTED [frozen · protected · reruns 0]'}}),9,sha(1));
  assert.equal(observationAt([later,first],'2026-10-05T10:30:00Z').state,'normal');
  assert.equal(observationAt([first,later],'2026-10-05T09:00:00Z'),null);
});
function github({mainRelation='ahead',firstRelation='diverged',finalParents=[{sha:sha(4)},{sha:sha(3)}],cap=false,foreign=false}={}){
  const calls=[];
  const request=async route=>{calls.push(route);if(cap && calls.length>2)return{ok:false,stopped:'request_cap'};
    let body;
    if(route==='/apps/clued-admission')body={slug:'clued-admission',id:9};
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
test('count main incorporation only with actual pre-merge DAG proof',async()=>{
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
  assert.equal(metrics.update_main_rounds.value,1);
  for(const name of ['queue_depth_p95','unclaimed_admitted','wasted_final_rounds','admission_failures_by_reason'])
    assert.equal(metrics[name].status,'not_measured');
});
