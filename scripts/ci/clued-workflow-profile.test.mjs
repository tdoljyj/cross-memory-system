import assert from 'node:assert/strict';

test('Native617 candidate Source catalogue is complete but never an accepted registration',async()=>{
  const {native617PendingWorkflowCatalogue}=await import('./clued-workflow-profile.mjs');
  const registry=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
  const specs=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)));
  const result=native617PendingWorkflowCatalogue(registry,specs);
  assert.equal(result.structurally_valid,true);assert.equal(result.passed,false);
  assert.equal(result.authoritative,false);assert.equal(result.host_qualified,false);
  assert.equal(result.execution_permitted,false);assert.equal(result.entries.length,3);
  for(const entry of result.entries){
    const actual=fs.readFileSync(new URL('../../'+entry.file,import.meta.url),'utf8');
    assert.equal(entry.source_yaml,actual);assert.equal(entry.workflow_blob,workflowBlob(actual));
    const role=specs.native617_pending_sources.find(x=>x.file===entry.file).roles[0];
    assert.deepEqual(role.definition,entry.workflow_definition.jobs[role.job_id]);
    assert.equal(roleDefinitionDigest(role.definition),role.definition_sha256);
    assert.equal(entry.source_acceptance,null);assert.equal(entry.host_qualification,null);
  }
});
test('pending Native617 data refuses invented receipts, partial roles, route mixing and self registration',async()=>{
  const {native617PendingWorkflowCatalogue}=await import('./clued-workflow-profile.mjs');
  const read=()=>({registry:JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))),
    specs:JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)))});
  for(const edit of [
    x=>x.registry.native617_pending_sources.pop(),
    x=>x.specs.native617_pending_sources.pop(),
    x=>x.registry.native617_pending_sources.push(x.registry.native617_pending_sources[0]),
    x=>x.registry.native617_pending_sources[0].source_acceptance={receipt_id:'invented'},
    x=>x.registry.native617_pending_sources[0].host_qualification={qualified:true},
    x=>x.registry.native617_pending_sources[0].source_yaml+='changed',
    x=>x.specs.native617_pending_sources[0].roles[0].definition_sha256='a'.repeat(64),
    x=>x.registry.native617_pending_sources[0].workflow_definition.jobs.admit['runs-on'].push('pool-general'),
    x=>{const e=x.registry.native617_pending_sources[0];x.registry.workflows[e.file]={workflow_blob:e.workflow_blob};},
    x=>{const e=x.registry.native617_pending_sources[0];x.specs.workflows[e.file]={sources:{[e.workflow_blob]:[]}};}
  ]){
    const x=read();edit(x);
    const result=native617PendingWorkflowCatalogue(x.registry,x.specs);
    assert.equal(result.structurally_valid,false);assert.equal(result.passed,false);
    assert.equal(result.execution_permitted,false);
  }
});
import test from 'node:test';
import {compileRegisteredWorkflow,selectRegisteredProfiles,roleDefinitionDigest,workflowBlob,futureWorkflowSubject,
  futureWorkflowCatalogue,acceptedFutureWorkflowSource} from './clued-workflow-profile.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {workflowJobs} from './clued-work-admission.mjs';
const SOURCE='name: fake-fixture\non: fixture\njobs: fixture\n';
const definition={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{name:'Actual tests',run:'node --test'}]}}};
const fixtureRoles=parsed=>[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
const compile=(source=SOURCE,parsed=definition)=>compileRegisteredWorkflow(source,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:fixtureRoles(parsed)});
test('registration binds full bytes, explicit primary roles and every command occurrence',()=>{
  const parsed=structuredClone(definition);parsed.jobs.main.steps.push({name:'Actual tests',run:'node other-tests.mjs'});
  const p=compile(SOURCE,parsed);assert.equal(p.routes[0].required_steps['Actual tests'],2);
  assert.equal(p.routes[0].command_digests['Actual tests'].length,2);
  assert.notEqual(compile(SOURCE+'# changed').workflow_blob,compile().workflow_blob);
  assert.throws(()=>compileRegisteredWorkflow(SOURCE,{primary_ids:[],parseYaml:()=>parsed}));
});
test('unsupported triggers, routes, reuse, matrix and empty execution never register',()=>{
  for(const edit of [p=>p.on.pull_request={types:['closed']},p=>p.on.pull_request={paths:['!docs/**']},
    p=>p.jobs.main.strategy={matrix:{node:[22]}},p=>p.jobs.main.uses='other.yml',
    p=>p.jobs.main['runs-on']='${{ matrix.runner }}',p=>p.jobs.main.steps=[],
    p=>p.jobs.other={...p.jobs.main}]) {
    const parsed=structuredClone(definition);edit(parsed);assert.throws(()=>compile(SOURCE,parsed));
  }
});
test('unregistered, altered, revoked, ambiguous or partial candidate sources stay unknown',()=>{
  const p=compile(),file='.github/workflows/fixture.yml';
  const registry={schema:'clued.gated-proof-profiles/2',workflows:{[file]:p}};
  const sources=new Map([[file,p.workflow_blob]]),options={sourceApproved:true,directoryComplete:true};
  assert.equal(selectRegisteredProfiles(registry,sources,options).passed,true);
  assert.equal(selectRegisteredProfiles(registry,sources,{...options,sourceApproved:false}).state,'unknown');
  assert.equal(selectRegisteredProfiles(registry,sources,{...options,directoryComplete:false}).state,'unknown');
  for(const mutation of [p=>p.registration_status='revoked',p=>p.source_yaml+='changed',
    p=>p.routes[0].required_steps['Actual tests']=0,p=>p.accepted_sources=[structuredClone(p)],
    p=>p.accepted_sources=[null],p=>p.accepted_sources=null,p=>p.routes=[null]]) {
    const altered=structuredClone(registry);mutation(altered.workflows[file]);
    assert.equal(selectRegisteredProfiles(altered,sources,options).state,'unknown');
  }
  assert.equal(selectRegisteredProfiles(registry,new Map([[file,compile(SOURCE+'new').workflow_blob]]),options).state,'unknown');
});
test('a future source uses only an independently preregistered default-branch entry',()=>{
  const p=compile(),future=compile(SOURCE+'# reviewed future'),file='.github/workflows/fixture.yml';
  p.accepted_sources=[future];const registry={schema:'clued.gated-proof-profiles/2',workflows:{[file]:p}};
  assert.equal(selectRegisteredProfiles(registry,new Map([[file,future.workflow_blob]]),{sourceApproved:true,directoryComplete:true}).passed,true);
});

function acceptedFutureFixture() {
  const source=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
  const roles=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)));
  const consumer_id='company-linux-01',file=`.github/workflows/clued-work-handover-qualification-${consumer_id}.yml`;
  const saved=source.future_workflows?.find(entry=>entry.file===file);
  const profile=structuredClone(saved?.source_profile??source.workflows[file]);
  const acceptedRoles=structuredClone(saved?roles.future_workflows.find(role=>role.file===file).roles:
    roles.workflows[file].sources[profile.workflow_blob]);
  const workflow_definition=structuredClone(saved?.workflow_definition??{on:{pull_request:profile.pull_request},jobs:{
    'admission-gate':{},...Object.fromEntries(acceptedRoles.map(role=>[role.job_id,role.definition]))}});
  const entry=saved?structuredClone(saved):{file,consumer_id,registration_status:'accepted_not_installed',
    purpose:'work_handover_consumer_qualification',source_profile:profile,workflow_definition,
    exact_source_acceptance_scope:{repository:'tdoljyj/cross-memory-system',default_branch:'main',operation:'new_workflow_file_installation',
      file,purpose:'work_handover_consumer_qualification',consumer_id,workflow_blob:profile.workflow_blob,source_sha256:profile.source_sha256,
      primary_ids:profile.primary_ids,roles:acceptedRoles.map(({job_id,definition_sha256})=>({job_id,definition_sha256})),
      command_digests:profile.routes.map(({job_id,command_digests})=>({job_id,command_digests})),
      workflow_definition_sha256:roleDefinitionDigest(workflow_definition),frozen_gate_sha256:createHash('sha256')
        .update(workflowJobs(profile.source_yaml).find(job=>job.name==='admission-gate').lines.join('\n')).digest('hex')}};
  const role={file,workflow_blob:profile.workflow_blob,roles:acceptedRoles};
  // Synthetic acceptance is a pure test fixture, never a service Receipt.
  entry.source_acceptance={status:'accepted',authority:'owner',
    decision_ref:'clued:decision:11111111-1111-4111-8111-111111111111@v1',
    receipt_id:'22222222-2222-4222-8222-222222222222',subject_sha256:futureWorkflowSubject(entry,role.roles)};
  return {registry:{schema:source.schema,workflows:{},future_workflows:[entry]},
    specs:{schema:roles.schema,workflows:{},future_workflows:[role]},entry,role};
}
test('future acceptance binds one bounded installation purpose and complete compiled roles',()=>{
  const fixture=acceptedFutureFixture(),{registry,specs,entry}=fixture;
  const options={repository:'tdoljyj/cross-memory-system'};
  assert.equal(acceptedFutureWorkflowSource(registry,specs,entry.file,entry.source_profile.workflow_blob,options).passed,true);
  for(const mutate of [x=>x.entry.source_acceptance.status='candidate',x=>x.entry.source_acceptance.status='revoked',
    x=>x.entry.source_acceptance.decision_ref=null,x=>x.entry.source_acceptance.receipt_id=null,
    x=>x.entry.source_acceptance.authority='agent',x=>x.entry.purpose='production_activation',
    x=>x.entry.source_acceptance.revoked=true,x=>x.entry.revoked=true,
    x=>x.entry.exact_source_acceptance_scope.repository='other/repo',x=>x.entry.exact_source_acceptance_scope.operation='modify_existing_workflow',
    x=>x.entry.exact_source_acceptance_scope.default_branch='feature',x=>delete x.entry.exact_source_acceptance_scope.roles,
    x=>x.role.roles=[],x=>delete x.role.roles[0].definition,x=>x.role.roles[0].definition_sha256='a'.repeat(64),
    x=>x.entry.source_profile.source_yaml+='changed',x=>x.entry.source_profile.source_sha256='a'.repeat(64),
    x=>x.entry.source_profile.routes[0].command_digests['Qualify installed handover consumer']=['a'.repeat(64)],
    x=>x.entry.source_profile.accepted_sources=[]]) {
    const altered=acceptedFutureFixture();mutate(altered);
    altered.entry.source_acceptance.subject_sha256=futureWorkflowSubject(altered.entry,altered.role.roles);
    assert.equal(acceptedFutureWorkflowSource(altered.registry,altered.specs,altered.entry.file,
      altered.entry.source_profile.workflow_blob,options).passed,false);
  }
  const pending=acceptedFutureFixture();pending.entry.source_acceptance.subject_sha256='a'.repeat(64);
  assert.equal(acceptedFutureWorkflowSource(pending.registry,pending.specs,pending.entry.file,
    pending.entry.source_profile.workflow_blob,options).passed,false);
});
test('future catalogue rejects duplicate file/blob, missing role records and active overlap',()=>{
  const good=acceptedFutureFixture();assert.equal(futureWorkflowCatalogue(good.registry,good.specs).passed,true);
  for(const mutate of [x=>x.registry.future_workflows.push(structuredClone(x.entry)),
    x=>x.specs.future_workflows.push(structuredClone(x.role)),x=>x.specs.future_workflows=[],
    x=>x.registry.workflows[x.entry.file]=x.entry.source_profile,
    x=>x.specs.workflows[x.entry.file]={sources:{[x.entry.source_profile.workflow_blob]:x.role.roles}},
    x=>{const duplicate=structuredClone(x.entry);duplicate.consumer_id='home-win-01';
      duplicate.file='.github/workflows/clued-work-handover-qualification-home-win-01.yml';x.registry.future_workflows.push(duplicate);
      x.specs.future_workflows.push({...structuredClone(x.role),file:duplicate.file});}]) {
    const bad=acceptedFutureFixture();mutate(bad);assert.equal(futureWorkflowCatalogue(bad.registry,bad.specs).passed,false);
  }
});
test('future compiled definitions cannot waive matrix, reusable jobs or route restrictions',()=>{
  for(const mutate of [job=>job.strategy={matrix:{runner:['a','b']}},job=>job.uses='other.yml',
    job=>job['runs-on']='${{ matrix.runner }}',job=>job.steps=[],job=>job.name='${{ arbitrary }}']) {
    const x=acceptedFutureFixture(),id=x.entry.source_profile.primary_ids[0];mutate(x.entry.workflow_definition.jobs[id]);
    x.role.roles[0].definition=x.entry.workflow_definition.jobs[id];
    x.role.roles[0].definition_sha256=roleDefinitionDigest(x.role.roles[0].definition);
    assert.throws(()=>compileRegisteredWorkflow(x.entry.source_profile.source_yaml,{primary_ids:[id],
      parseYaml:()=>x.entry.workflow_definition,accepted_roles:x.role.roles}));
    assert.equal(acceptedFutureWorkflowSource(x.registry,x.specs,x.entry.file,x.entry.source_profile.workflow_blob,
      {repository:'tdoljyj/cross-memory-system'}).passed,false);
  }
});
test('candidate future Sources retain exact full-byte profiles and frozen gate hash',()=>{
  const registry=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
  const specs=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)));
  assert.equal(futureWorkflowCatalogue(registry,specs).passed,true);
  for(const entry of registry.future_workflows??[]) {
    const roles=specs.future_workflows.find(role=>role.file===entry.file).roles;
    assert.equal(workflowBlob(entry.source_profile.source_yaml),entry.source_profile.workflow_blob);
    assert.equal(entry.source_acceptance.subject_sha256,futureWorkflowSubject(entry,roles));
    assert.deepEqual(compileRegisteredWorkflow(entry.source_profile.source_yaml,{primary_ids:entry.source_profile.primary_ids,
      parseYaml:()=>entry.workflow_definition,accepted_roles:roles}),entry.source_profile);
    const gate=workflowJobs(entry.source_profile.source_yaml).filter(job=>job.name==='admission-gate');assert.equal(gate.length,1);
    assert.equal(createHash('sha256').update(gate[0].lines.join('\n')).digest('hex'),entry.exact_source_acceptance_scope.frozen_gate_sha256);
  }
});
