import assert from 'node:assert/strict';
import test from 'node:test';
import {compileRegisteredWorkflow,selectRegisteredProfiles} from './clued-workflow-profile.mjs';
const SOURCE='name: fake-fixture\non: fixture\njobs: fixture\n';
const definition={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{name:'Actual tests',run:'node --test'}]}}};
const compile=(source=SOURCE,parsed=definition)=>compileRegisteredWorkflow(source,{primary_ids:['main'],parseYaml:()=>parsed});
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
    p=>p.jobs.main['runs-on']='${{ matrix.runner }}',p=>p.jobs.main.steps=[]]) {
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
    p=>p.routes[0].required_steps['Actual tests']=0,p=>p.accepted_sources=[structuredClone(p)]]) {
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
