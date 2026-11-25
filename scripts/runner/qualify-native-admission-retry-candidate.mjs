#!/usr/bin/env node
// An isolated source-candidate probe, never an accepted/installed/live proof.
// All GitHub/service reads and token-file reads below are synthetic fixtures.
// native-admission-no-wait-v1: a missing or incomplete Native check refuses
// on the first read. Synthetic network cuts exercise the bounded retries of
// the Native read and the execution_current observation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const source=new URL('./clued-runner-job-started.native-admission-no-wait-v1.mjs',import.meta.url);
const CANDIDATE_SHA='58613a531cc45d4e583aa447ea9517574d235d424ca01dd4a93dc69b0ed2c3f5';
const digest=()=>createHash('sha256').update(fs.readFileSync(source)).digest('hex');
export async function qualifyNativeRetryCandidate(){
  assert.equal(digest(),CANDIDATE_SHA,'Candidate bytes differ; this pin grants no Source acceptance');
  const hook=await import(source.href);
  assert.equal(hook.HOOK_VERSION,'native-admission-no-wait-v1');
  assert.equal(hook.COMPONENT_VERSION,'1.0.9');
  const api='https://api.github.com/repos/o/r',head='b'.repeat(40),created='2026-11-02T00:00:00Z';
  const rpc='https://fixture.supabase.co/rest/v1/rpc/clued_work_verify_v1';
  const environment={CLUED_RUNNER_HOOK_REPOSITORY:'o/r',CLUED_RUNNER_HOOK_TOKEN_FILE:'/fixture-token',
    CLUED_RUNNER_HOOK_ENFORCE:'true',GITHUB_REPOSITORY:'o/r',
    GITHUB_WORKFLOW_REF:'o/r/.github/workflows/clued-required-tests.yml@refs/pull/9/merge',
    GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/9/merge',GITHUB_SHA:'a'.repeat(40),
    GITHUB_EVENT_PATH:'/fixture-event',GITHUB_RUN_ID:'555',GITHUB_RUN_ATTEMPT:'1'};
  const check={id:80,name:'kooyumi-work-admission',app:{id:5368905},head_sha:head,status:'completed',
    conclusion:'success',started_at:created,completed_at:created,
    external_id:`independent-ci:native-work-admission:v2:${'c'.repeat(64)}:a1:c1234abcd:f1:e1`,output:{summary:'o/r#9'}};
  const cases=[];
  for(const [name,alter,observation,expected,faults={}] of [
    ['native-current',{}, {status:'ok',guard_required:true,epoch_current:true},true],
    ['native-stale-epoch',{}, {status:'ok',guard_required:true,epoch_current:false},false],
    ['native-unavailable-epoch',{}, {status:'unavailable'},false],
    ['native-invalid-epoch',{}, {status:'ok',guard_required:true,epoch_current:null},false],
    ['native-wrong-app',{app:{id:1}},null,false],
    ['native-wrong-head',{head_sha:'d'.repeat(40)},null,false],
    ['native-wrong-pr',{output:{summary:'o/r#90'}},null,false],
    ['native-unbound',{external_id:'unbound'},null,false],
    ['native-absent',null,null,false],
    ['native-pending',{status:'in_progress',conclusion:null},null,false],
    ['native-failure',{conclusion:'failure'},null,false],
    ['native-old-event',{started_at:'2026-11-01T23:59:44Z'},null,false],
    // synthetic network cuts: a rejected fetch, or a gateway 503
    ['native-cut-then-admitted',{}, {status:'ok',guard_required:true,epoch_current:true},true,{checks:2}],
    ['native-503-outlasts-attempts',{}, null,false,{checks:Infinity,status:503}],
    ['epoch-cut-then-current',{}, {status:'ok',guard_required:true,epoch_current:true},true,{rpc:1}],
    ['epoch-cut-outlasts-attempts',{}, {status:'ok',guard_required:true,epoch_current:true},false,{rpc:Infinity}],
  ]){
    const calls=[],sleeps=[],cuts={checks:0,rpc:0};
    const fault=(kind)=>{cuts[kind]+=1;if(cuts[kind]>(faults[kind]??0))return null;
      if(faults.status)return {status:faults.status,json:async()=>null};throw new TypeError('fetch failed (synthetic cut)');};
    const fetchImpl=async(url,init)=>{
      calls.push(String(url));let body;
      if(String(url).startsWith(`${api}/commits/${head}/check-runs?`)){const f=fault('checks');if(f)return f;}
      if(url===rpc){const f=fault('rpc');if(f)return f;}
      if(url===`${api}/actions/runs/555`)body={id:555,run_attempt:1,created_at:created};
      else if(url===`${api}/compare/main...${head}`)body={files:[{filename:'.github/workflows/gitleaks.yml'}]};
      else if(url===`${api}/actions/workflows/clued-work-admission.yml`)body={path:'.github/workflows/clued-work-admission.yml',state:'disabled_manually'};
      else if(String(url).startsWith(`${api}/commits/${head}/check-runs?`)){
        const checks=alter===null?[]:[{...check,...alter}];
        body={total_count:checks.length,check_runs:checks};
      }
      else if(url===`${api}/pulls/9`)body={state:'open',base:{ref:'main',repo:{full_name:'o/r'}},head:{sha:head}};
      else if(url===`${api}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`)
        body={type:'file',encoding:'base64',content:Buffer.from('return { url: "https://fixture.supabase.co", key: "sb_publishable_fixture" };').toString('base64')};
      else if(url===rpc){assert.equal(init.method,'POST');body=observation;}
      else throw new Error('Unexpected network target in isolated probe');
      return new Response(JSON.stringify(body),{status:200});
    };
    let allowed=false,error=false;
    try{
      const result=await hook.decideWithCurrentEpoch({env:environment,fetchImpl,now:()=>Date.parse(created),sleep:async ms=>{sleeps.push(ms);},readFile:p=>{
        if(p==='/fixture-token')return 'synthetic-read-only-token';
        assert.equal(p,'/fixture-event','Unexpected file read in isolated probe');
        const repo={full_name:'o/r'};
        return JSON.stringify({pull_request:{number:9,base:{ref:'main',repo},head:{sha:head,repo}}});
      }});
      allowed=result.allow;
    }catch(e){
      // only these cases end in an exception, each with its own failure
      const expectedError={'native-unavailable-epoch':/execution epoch observation is invalid/,'native-invalid-epoch':/execution epoch observation is invalid/,
        'native-503-outlasts-attempts':/check-runs\?check_name=kooyumi-work-admission.* returned 503$/,'epoch-cut-outlasts-attempts':/synthetic cut/}[name];
      assert.ok(expectedError,name+': '+e.message);assert.match(e.message,expectedError,name);error=true;
    }
    assert.equal(allowed,expected,name);
    const checkAttempts=Math.min((faults.checks??0)+1,hook.READ_ATTEMPTS);
    assert.equal(cuts.checks,checkAttempts,name+' Native request count');
    if(!faults.rpc)assert.deepEqual(sleeps,hook.READ_RETRY_DELAYS_MS.slice(0,checkAttempts-1),name+' Native retry delays');
    if(expected)assert.ok(calls.includes(rpc),'The Native success must still observe the epoch');
    cases.push({name,outcome:'pass',expected:expected?'allow':'deny',exception:error});
  }
  assert.equal(digest(),CANDIDATE_SHA,'Candidate changed during qualification');
  return {schema:'clued.native-hook-candidate-qualification/1',boundary:'source_candidate',source_sha256:CANDIDATE_SHA,
    hook_version:hook.HOOK_VERSION,component_version:hook.COMPONENT_VERSION,cases,network:'synthetic-only',
    accepted_source:false,installed_protection_verified:false,app_permissions_verified:false,live_pr_qualified:false,
    live_dispatch_qualified:false,external_revocation_qualified:false,activation_authorized:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--candidate'],'Only --candidate is supported; this tool never accepts or deploys a Source');
  console.log(JSON.stringify(await qualifyNativeRetryCandidate(),null,2));
}
