import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {NATIVE617_POLICY,validateNative617Policy,validateNative617Context,
  validateNative617PublicBinding,assertNative617ExecutionEnabled,native617Main} from './clued-handover-native-entry.mjs';

const now=Date.parse('2026-10-25T12:00:00.000Z');
function context(phase='publish'){
  const kind=phase==='control'?'control':phase==='idle'?'idle':phase==='source-only'?'source-only':'native';
  return {schema:'clued.native617-job-context/1',task_id:NATIVE617_POLICY.task_id,
    repository:NATIVE617_POLICY.repository,repository_id:'1334673495',actor_id:'52366662',
    triggering_actor_id:'52366662',event_name:kind==='source-only'?'pull_request':'workflow_dispatch',
    workflow_path:'.github/workflows/'+(kind==='control'?'clued-work-admission-dispatch.yml':
      kind==='idle'?'clued-handover-disposable-idle.yml':'clued-handover-external-qualification.yml'),
    workflow_sha:'a'.repeat(40),head_sha:'a'.repeat(40),ref:kind==='source-only'?'refs/pull/123/merge':
      kind==='idle'?'refs/heads/clued-handover-disposable-fixture':'refs/heads/main',
    job_key:kind==='control'?'admit':kind==='idle'?'disposable-idle':'qualify',
    run_id:'123',run_attempt:1,phase,input_class:phase};
}
function binding(c=context()){
  const inputs={'source-only':['job-token'],idle:['job-token'],control:['job-token','clued-admission-token'],
    register:['pg-url'],publish:['job-token','app516','pg-url','fixture-proof'],revoke:['job-token','app516','pg-url','fixture-proof']};
  return {schema:'clued.native617-public-job-binding/1',context:structuredClone(c),github_job_id:'456',
    runner_id:7,runner_name:'clued-native617-synthetic-fixture',runner_group_id:8,
    runner_labels:[...NATIVE617_POLICY.routes[c.phase==='control'?'control':'native']],
    host_id:'synthetic-host',guest_instance_id:'11111111-1111-4111-8111-111111111111',
    image_sha256:'b'.repeat(64),host_qualification_ref:'receipt:22222222-2222-4222-8222-222222222222',
    source_acceptance_ref:'receipt:33333333-3333-4333-8333-333333333333',
    prior_cleanup_proof_sha256:'c'.repeat(64),issued_at:'2026-10-25T11:59:00.000Z',
    expires_at:'2026-10-25T12:01:00.000Z',private_input_classes:inputs[c.phase]};
}
test('authored Source policy stays disabled with all actual Host selectors null',()=>{
  const p=JSON.parse(fs.readFileSync(new URL('../../config/clued-handover-native-entry-policy.json',import.meta.url)));
  assert.deepEqual(validateNative617Policy(p),NATIVE617_POLICY);
  assert.equal(p.execution_enabled,false);
  for(const key of ['host_id','image_sha256','runner_group_id','host_qualification_ref'])assert.equal(p[key],null);
  for(const edit of [p=>p.execution_enabled=true,p=>p.host_id='synthetic-host',p=>p.required_app_id=5368905,
    p=>p.routes.native.push('pool-general'),p=>p.lease_key='synthetic-private-canary']){
    const bad=structuredClone(p);edit(bad);assert.throws(()=>validateNative617Policy(bad));
  }
});
test('six finite contexts validate only public binding syntax, never qualify or authorize',()=>{
  for(const phase of ['source-only','idle','control','register','publish','revoke']){
    const c=context(phase),p=binding(c),r=validateNative617PublicBinding(p,c,{now});
    assert.equal(r.syntax_valid,true);assert.equal(r.execution_permitted,false);
    assert.equal(r.authority,'none');assert.equal(r.host_qualified,false);assert.equal(r.source_accepted,false);
    assert.ok(Object.isFrozen(r));assert.throws(()=>assertNative617ExecutionEnabled(NATIVE617_POLICY));
  }
});
test('context identity, same Source, phase/ref and job domains cannot be substituted',()=>{
  for(const edit of [c=>c.task_id='other',c=>c.repository='other/repo',c=>c.repository_id=1334673495,
    c=>c.actor_id='1',c=>c.triggering_actor_id='1',c=>c.event_name='push',c=>c.ref='refs/heads/other',
    c=>c.workflow_path='.github/workflows/gitleaks.yml',c=>c.job_key='admission-gate',
    c=>c.workflow_sha='d'.repeat(40),c=>c.head_sha+='\n',c=>c.run_attempt=true,c=>c.run_attempt=2,
    c=>c.run_id=123,c=>c.input_class='control',c=>c.phase='register',c=>c.leaseKey='synthetic-canary']){
    const c=context();edit(c);assert.throws(()=>validateNative617Context(c));
  }
  const c=context('source-only');c.workflow_path='.github/workflows/clued-work-admission-dispatch.yml';
  c.job_key='admit';assert.throws(()=>validateNative617Context(c));
});
test('real numeric job and runner IDs, immutable context and exact private class sets are strict',()=>{
  for(const edit of [p=>p.github_job_id=456,p=>p.github_job_id='0',p=>p.runner_id=true,p=>p.runner_id='7',
    p=>p.runner_id=7.1,p=>p.runner_group_id=null,p=>p.runner_group_id=0,p=>p.runner_labels.push('pool-general'),
    p=>p.context.run_id='124',p=>p.context.run_attempt=2,p=>p.private_input_classes.push('clued-admission-token'),
    p=>p.private_input_classes=['app536'],p=>p.private_input_classes=['pg-url'],
    p=>p.image_sha256+='\n',p=>p.host_qualification_ref=null,p=>p.guest_instance_id='arbitrary',
    p=>p.source_acceptance_ref={receipt:'synthetic'},p=>p.lease_key='synthetic-private-canary']){
    const c=context(),p=binding(c);edit(p);assert.throws(()=>validateNative617PublicBinding(p,c,{now}));
  }
});
test('each role refuses secret family crossover and control cannot inherit a longer job deadline',()=>{
  for(const phase of ['source-only','idle','control','register']){
    const c=context(phase),p=binding(c);p.private_input_classes=['job-token','app516','pg-url','fixture-proof'];
    assert.throws(()=>validateNative617PublicBinding(p,c,{now}));
  }
  const c=context('control'),p=binding(c);p.expires_at='2026-10-25T12:05:00.000Z';
  assert.throws(()=>validateNative617PublicBinding(p,c,{now}));
});
test('time bounds preserve original fixed Source ceiling and reject clock or format ambiguity',()=>{
  for(const edit of [p=>p.issued_at='2026-10-25T12:00:00.001Z',p=>p.expires_at='2026-10-25T12:00:00.000Z',
    p=>p.expires_at='2026-10-25T12:25:00.001Z',p=>p.expires_at='2026-10-26T04:00:00.000Z',
    p=>p.issued_at='2026-10-25T11:59:00Z',p=>p.issued_at+='\n']){
    const c=context(),p=binding(c);edit(p);assert.throws(()=>validateNative617PublicBinding(p,c,{now}));
  }
  assert.throws(()=>validateNative617PublicBinding(binding(),context(),{now:NaN}));
});
test('default CLI and refused production CLI do not consume ambient authority or private values',()=>{
  assert.deepEqual(native617Main([]),{status:'DISABLED_NO_HOST_READ',execution_permitted:false,authority:'none'});
  assert.throws(()=>native617Main(['--check','--proof','arbitrary']));
  const file=fileURLToPath(new URL('./clued-handover-native-entry.mjs',import.meta.url));
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,
    GITHUB_WORKSPACE:'unread-nonexistent',CLUED_CONTEXT_READ_TOKEN:'UNREAD_SYNTHETIC_PRIVATE_CANARY'};
  const disabled=spawnSync(process.execPath,[file],{encoding:'utf8',env});
  assert.equal(disabled.status,0);assert.equal(JSON.parse(disabled.stdout).status,'DISABLED_NO_HOST_READ');
  const refused=spawnSync(process.execPath,[file,'--check'],{encoding:'utf8',env});
  assert.equal(refused.status,1);assert.equal(JSON.parse(refused.stderr).execution_permitted,false);
  assert.ok(!refused.stderr.includes('UNREAD_SYNTHETIC_PRIVATE_CANARY'));
});
