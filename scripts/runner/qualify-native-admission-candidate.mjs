#!/usr/bin/env node
// An isolated source-candidate probe, never an accepted/installed/live proof.
// All GitHub/service reads and token-file reads below are synthetic fixtures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const source=new URL('./clued-runner-job-started.work-handover-native-admission-v1.mjs',import.meta.url);
const CANDIDATE_SHA='548866b17f9bfec27113d88858982a9233b4ad41c207dfdc948d6e2a2403fd83';
const digest=()=>createHash('sha256').update(fs.readFileSync(source)).digest('hex');
export async function qualifyNativeCandidate(){
  assert.equal(digest(),CANDIDATE_SHA,'Candidate bytes differ; this pin grants no Source acceptance');
  const hook=await import(source.href);
  assert.equal(hook.COMPONENT_VERSION,'1.0.1');
  const api='https://api.github.com/repos/o/r',head='b'.repeat(40),created='2026-11-02T00:00:00Z';
  const rpc='https://fixture.supabase.co/rest/v1/rpc/clued_work_verify_v1';
  const environment={CLUED_RUNNER_HOOK_REPOSITORY:'o/r',CLUED_RUNNER_HOOK_TOKEN_FILE:'/fixture-token',
    CLUED_RUNNER_HOOK_ENFORCE:'true',CLUED_RUNNER_HOOK_WAIT_SECONDS:'0',GITHUB_REPOSITORY:'o/r',
    GITHUB_WORKFLOW_REF:'o/r/.github/workflows/clued-required-tests.yml@refs/pull/9/merge',
    GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/9/merge',GITHUB_SHA:'a'.repeat(40),
    GITHUB_EVENT_PATH:'/fixture-event',GITHUB_RUN_ID:'555',GITHUB_RUN_ATTEMPT:'1'};
  const check={id:80,name:'kooyumi-work-admission',app:{id:5368905},head_sha:head,status:'completed',
    conclusion:'success',started_at:created,completed_at:created,
    external_id:`independent-ci:native-work-admission:v2:${'c'.repeat(64)}:a1:c1234abcd:f1:e1`,output:{summary:'o/r#9'}};
  const cases=[];
  for(const [name,alter,observation,expected] of [
    ['native-current',{}, {status:'ok',guard_required:true,epoch_current:true},true],
    ['native-stale-epoch',{}, {status:'ok',guard_required:true,epoch_current:false},false],
    ['native-unavailable-epoch',{}, {status:'unavailable'},false],
    ['native-invalid-epoch',{}, {status:'ok',guard_required:true,epoch_current:null},false],
    ['native-wrong-app',{app:{id:1}},null,false],
    ['native-wrong-head',{head_sha:'d'.repeat(40)},null,false],
    ['native-wrong-pr',{output:{summary:'o/r#90'}},null,false],
    ['native-unbound',{external_id:'unbound'},null,false],
    ['native-pending',{status:'in_progress',conclusion:null},null,false],
    ['native-failure',{conclusion:'failure'},null,false],
    ['native-old-event',{started_at:'2026-11-01T23:59:44Z'},null,false],
  ]){
    const calls=[];
    const fetchImpl=async(url,init)=>{
      calls.push(String(url));let body;
      if(url===`${api}/actions/runs/555`)body={id:555,run_attempt:1,created_at:created};
      else if(url===`${api}/compare/main...${head}`)body={files:[{filename:'.github/workflows/gitleaks.yml'}]};
      else if(url===`${api}/actions/workflows/clued-work-admission.yml`)body={path:'.github/workflows/clued-work-admission.yml',state:'disabled_manually'};
      else if(String(url).startsWith(`${api}/commits/${head}/check-runs?`))body={total_count:1,check_runs:[{...check,...alter}]};
      else if(url===`${api}/pulls/9`)body={state:'open',base:{ref:'main',repo:{full_name:'o/r'}},head:{sha:head}};
      else if(url===`${api}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`)
        body={type:'file',encoding:'base64',content:Buffer.from('return { url: "https://fixture.supabase.co", key: "sb_publishable_fixture" };').toString('base64')};
      else if(url===rpc){assert.equal(init.method,'POST');body=observation;}
      else throw new Error('Unexpected network target in isolated probe');
      return {status:200,json:async()=>body};
    };
    let allowed=false,error=false;
    try{
      const result=await hook.decideWithCurrentEpoch({env:environment,fetchImpl,now:()=>Date.parse(created),sleep:async()=>{},readFile:p=>{
        if(p==='/fixture-token')return 'synthetic-read-only-token';
        assert.equal(p,'/fixture-event','Unexpected file read in isolated probe');
        return JSON.stringify({pull_request:{number:9,base:{ref:'main'},head:{sha:head}}});
      }});
      allowed=result.allow;
    }catch(e){
      assert.ok(['native-unavailable-epoch','native-invalid-epoch'].includes(name),e.message);error=true;
    }
    assert.equal(allowed,expected,name);
    assert.ok(calls.some(url=>url.includes('/check-runs?')),name+' did not exercise Native admission');
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
  console.log(JSON.stringify(await qualifyNativeCandidate(),null,2));
}
