import assert from 'node:assert/strict';
import {retiredCatalogue} from './fixtures/retired-gated-proof-catalogue.mjs';

test('Native617 candidate Source catalogue is complete but never an accepted registration',async()=>{
  const {native617PendingWorkflowCatalogue}=await import('./clued-workflow-profile.mjs');
  const registry=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
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
  const read=()=>({registry:parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))),
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
  futureWorkflowCatalogue,acceptedFutureWorkflowSource,parseWorkflowProfiles,REQUIRED_TESTS_SOURCE,
  isExactAllRequiredPrimariesProfile,registeredWorkflowSource,rolesForSource,completeLargeWorkflowProfile} from './clued-workflow-profile.mjs';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {workflowJobs,AUTOMATION_BOT} from './clued-work-admission.mjs';
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

test('only the exact required-tests Source and its six complete independent roles compile compound mode',()=>{
  const require=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url)),yaml=require('yaml');
  const raw=fs.readFileSync(new URL('../../'+REQUIRED_TESTS_SOURCE.file,import.meta.url),'utf8'),value=yaml.parse(raw);
  const primary_ids=[...REQUIRED_TESTS_SOURCE.primary_ids],roles=primary_ids.map(job_id=>({job_id,
    definition_sha256:roleDefinitionDigest(value.jobs[job_id]),definition:value.jobs[job_id]}));
  const options={primary_ids,parseYaml:yaml.parse,accepted_roles:roles},compiled=compileRegisteredWorkflow(raw,options);
  assert.equal(isExactAllRequiredPrimariesProfile(compiled,REQUIRED_TESTS_SOURCE.file),true);
  assert.equal(compiled.execution_mode,'all_required_primaries');assert.equal(compiled.routes.length,primary_ids.length);assert.equal(primary_ids.length,6);
  assert.equal(compiled.routes.every(route=>route.self_hosted),true);
  assert.equal(compiled.routes[2].required_steps['Not affected'],undefined);
  assert.equal(compiled.routes[2].command_digests['Not affected'].length,1,'the auxiliary command is not removed from Source');
  assert.equal(compiled.routes[2].required_steps['Verify migrations on the production schema'],1);
  for(const text of [raw+'# different Source\n',raw.replace('node','echo')])assert.throws(()=>compileRegisteredWorkflow(text,options));
  const reordered={...options,accepted_roles:[...roles].reverse()};
  assert.deepEqual(compileRegisteredWorkflow(raw,reordered),compiled,'independent role array order is not authority');
  for(const edit of [o=>o.primary_ids.pop(),o=>o.accepted_roles.pop(),
    o=>delete o.accepted_roles[0].definition,o=>o.accepted_roles[1].definition_sha256='a'.repeat(64),
    o=>o.accepted_roles[2].definition.name='changed']){
    const changed={primary_ids:structuredClone(primary_ids),accepted_roles:structuredClone(roles),parseYaml:yaml.parse};edit(changed);
    assert.throws(()=>compileRegisteredWorkflow(raw,changed));
  }
  assert.equal(compile().execution_mode,undefined,'old alternative compiler behavior is unchanged');
});
// G3 changed the bytes of clued-required-tests.yml (lost-run workflow_dispatch). The compound pin, the root registry
// entry and the three independent roles must all name the committed bytes; the compound mode admits exactly one Source,
// so replaced bytes are not kept as accepted_sources (the compiler would no longer compile them in compound mode).
test('the compound pin, its registered entry and its three roles are the committed required-tests bytes',()=>{
  const require=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url)),yaml=require('yaml');
  const file=REQUIRED_TESTS_SOURCE.file,ids=[...REQUIRED_TESTS_SOURCE.primary_ids];
  const raw=fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8'),value=yaml.parse(raw);
  const blob=workflowBlob(raw),sha=createHash('sha256').update(raw).digest('hex');
  const registry=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
  const specs=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)));
  const {accepted_sources,...entry}=registry.workflows[file];
  const actual={workflow_blob:blob,source_sha256:sha,workflow_definition_sha256:roleDefinitionDigest(value),
    profile_sha256:roleDefinitionDigest({...entry,workflow_blob:blob,source_sha256:sha,source_yaml:raw}),
    role_sha256:Object.fromEntries(ids.map(id=>[id,roleDefinitionDigest(value.jobs[id])]))};
  const pinned={workflow_blob:REQUIRED_TESTS_SOURCE.workflow_blob,source_sha256:REQUIRED_TESTS_SOURCE.source_sha256,
    workflow_definition_sha256:REQUIRED_TESTS_SOURCE.workflow_definition_sha256,profile_sha256:REQUIRED_TESTS_SOURCE.profile_sha256,
    role_sha256:{...REQUIRED_TESTS_SOURCE.role_sha256}};
  assert.deepEqual(pinned,actual,'REQUIRED_TESTS_SOURCE must pin the committed bytes: '+JSON.stringify(actual));
  assert.equal(accepted_sources,undefined,'the compound mode registers exactly one Source');
  assert.deepEqual(Object.keys(specs.workflows[file].sources),[blob],`${file}: roles are keyed by the committed blob only`);
  const roles=rolesForSource(specs,file,blob);
  assert.deepEqual(roles,ids.map(job_id=>({job_id,definition_sha256:actual.role_sha256[job_id],definition:value.jobs[job_id]})));
  assert.deepEqual(compileRegisteredWorkflow(raw,{primary_ids:ids,parseYaml:yaml.parse,accepted_roles:roles}),entry);
});
// Retired generations remain Git objects at their exact commits.
// Each must decode and compile only as its own exact bytes and roles, never as a second current Source.
test('the earlier exact compound Source still decodes from its catalogue and compiles only as its own bytes',async()=>{
  const {REQUIRED_TESTS_PREVIOUS_SOURCES:previous}=await import('./clued-workflow-profile.mjs');
  const require=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url)),yaml=require('yaml');
  const generations=[
    {commit:'4a3e048579e766d66285246b7fa93cd545514fb3',blob:'8a22de3a97425d9f85bc9f605dbdbf748b8e0946'},
    {commit:'20edb51c585beb6c31f97798983b2a5065899fca',blob:'2570781ab5a29d2fa9d09ac72f0ed6118f9e5686'},
    {commit:'7b0b1e2485dec24229212b3bc1eba4405c4a259b',blob:'5470897712b63448447b45c86d233b782163960d'},
    {commit:'0bfafe959f106f94078735728bcaaab6f639c177',blob:'90018809f94ceb6ba6ffcea8dcfac94a5d23b1e8'},
    {commit:'f45ef3e02bf8c3ef9c4e64ad5a549ce9ad0496ac',blob:'e600d8b2223e897008a2e07020b6c4d7731f2285'},
    {commit:'912c7aba9eff96e0957be311443c3d6339d310d2',blob:'2e14516b6813ce3024d42ab5ffde63fb399fb20b'},
    {commit:'709e474e83bae54f5985ad24b04ecc90bd6c11d5',blob:'00a9b5d1b1a0eaed1cc0d82d05753bfe984743ae'},
    {commit:'304f48f466bac8d15d4289358f617699179b27de',blob:'d05ee2b2e7779cb2b8dda780b9203ad9a9e4e789'},
    {commit:'777edf3a49e21ac9811a1534f4708d7b75e1b4e2',blob:'095d75173b66e6f10fd733a00edbd251a14ca819'},
    {commit:'b404f735a0d1118d9da66e99e54a7bff54752aa0',blob:'a39bec437446a92a670fb3ef09f1a31f7f785e7b'},
    {commit:'01cd8ecb8421e9ec64164a26eeca9b8a5276bd31',blob:'9066264ff4b0f07274ee67f07e16ca86a6db60f6'},
  ],file=REQUIRED_TESTS_SOURCE.file;
  assert.deepEqual(previous.map(pin=>pin.workflow_blob),generations.map(generation=>generation.blob));
  for(const {commit,blob} of generations){
    const {registry,specs}=retiredCatalogue(commit),old=registry.workflows[file];
    assert.equal(old.workflow_blob,blob,`retired catalogue ${commit} holds its own bytes`);
    assert.notEqual(old.workflow_blob,REQUIRED_TESTS_SOURCE.workflow_blob,'the retired catalogue holds the predecessor bytes');
    assert.equal(isExactAllRequiredPrimariesProfile(old,file),true);
    assert.equal(registeredWorkflowSource(registry,file,old.workflow_blob).passed,true);
    const value=yaml.parse(old.source_yaml),roles=rolesForSource(specs,file,old.workflow_blob).map(({job_id,definition_sha256})=>
      ({job_id,definition_sha256,definition:value.jobs[job_id]}));
    assert.deepEqual(compileRegisteredWorkflow(old.source_yaml,{primary_ids:old.primary_ids,parseYaml:yaml.parse,accepted_roles:roles}),old);
    assert.throws(()=>compileRegisteredWorkflow(old.source_yaml+'# changed\n',
      {primary_ids:old.primary_ids,parseYaml:yaml.parse,accepted_roles:roles}));
    for(const edit of [p=>p.source_yaml+='# changed\n',p=>p.routes[0].required_steps['Select suites']=2,
      p=>p.workflow_blob=REQUIRED_TESTS_SOURCE.workflow_blob,p=>p.source_sha256=REQUIRED_TESTS_SOURCE.source_sha256]) {
      const p=structuredClone(old);edit(p);assert.equal(isExactAllRequiredPrimariesProfile(p,file),false);
    }
    assert.equal(isExactAllRequiredPrimariesProfile(old,'.github/workflows/borrowed.yml'),false);
  }
  const current=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))).workflows[file];
  assert.equal(current.workflow_blob,REQUIRED_TESTS_SOURCE.workflow_blob,'the live catalogue registers the current bytes');
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
  // The handover qualification Sources are retired; the last catalogue that registered them supplies the fixture.
  const {registry:source,specs:roles}=retiredCatalogue();
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
  const registry=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
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


test('G4 consumer cutover uses the exact preregistered full YAML and unchanged independent roles',()=>{
  const file='.github/workflows/clued-g4-database.yml',beforeBlob='a09cfc44e506a9672e5221a7fa6737747ddcb787',afterBlob='d7876890a4df616fddae675c4d66737a70eb7045',
    profiles=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))),
    roles=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url))),
    before=registeredWorkflowSource(profiles,file,beforeBlob).profile,after=registeredWorkflowSource(profiles,file,afterBlob).profile,
    accepted=rolesForSource(roles,file,afterBlob),yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
  const actual=fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8'),
    picked=registeredWorkflowSource(profiles,file,workflowBlob(actual));
  assert.equal(workflowBlob(actual),afterBlob,'PR-B consumes exactly the preregistered successor');
  assert.equal(picked.passed,true);assert.deepEqual(picked.profile,after);
  assert.equal(actual,after.source_yaml,'the consumed YAML is the complete registered byte string');
  assert.equal(after.source_sha256,'570cfb6e8b9b13c562de6cd690e01c8ef68b525b79206d937950bedf954d8c3d');
  assert.deepEqual(accepted,rolesForSource(roles,file,beforeBlob));
  const definition=yaml.parse(after.source_yaml),oldDefinition=yaml.parse(before.source_yaml);
  for(const role of accepted) {
    assert.deepEqual(definition.jobs[role.job_id],oldDefinition.jobs[role.job_id]);
    assert.equal(roleDefinitionDigest(definition.jobs[role.job_id]),role.definition_sha256);
  }
  assert.deepEqual(compileRegisteredWorkflow(actual,{primary_ids:after.primary_ids,accepted_roles:accepted,parseYaml:yaml.parse}),picked.profile);
  assert.deepEqual(after.pull_request,before.pull_request);
  assert.ok(after.pull_request.paths.includes('apps/clued-cloud/supabase/**'));
  const oldMain=structuredClone(profiles);oldMain.workflows[file].accepted_sources=oldMain.workflows[file].accepted_sources.filter(x=>x.workflow_blob!==afterBlob);
  assert.equal(registeredWorkflowSource(oldMain,file,afterBlob).passed,false);
  for(const source of [oldMain.workflows[file],...oldMain.workflows[file].accepted_sources])
    assert.equal(registeredWorkflowSource(profiles,file,source.workflow_blob).passed,true);
  assert.equal(registeredWorkflowSource(profiles,file,workflowBlob(after.source_yaml+'# changed\n')).passed,false);
});


test('large profile transport uses immutable tree and blob facts only, with every binding and byte boundary enforced',async()=>{
  const repository='o/r',commit='1'.repeat(40),file='scripts/ci/clued-gated-proof-profiles.json';
  const fixture=(bytes=Buffer.alloc(1048577,120))=>{
    const oid=workflowBlob(bytes),calls=[],content={type:'file',path:file,sha:oid,size:bytes.length,encoding:'none',content:'',download_url:'https://untrusted.invalid/private'},
      tree={sha:'2'.repeat(40),truncated:false,tree:[{path:file,type:'blob',mode:'100644',sha:oid,size:bytes.length}]},
      blob={sha:oid,size:bytes.length,encoding:'base64',content:bytes.toString('base64')},
      read=async route=>{calls.push(route);if(route===`/repos/${repository}/git/trees/${commit}?recursive=1`)return tree;
        if(route===`/repos/${repository}/git/blobs/${oid}`)return blob;throw Error('UNEXPECTED_FIXED_ROUTE');};
    return {bytes,oid,calls,content,tree,blob,read};
  };
  for(const size of [1048577,2097152]) {
    const f=fixture(Buffer.alloc(size,120)),result=await completeLargeWorkflowProfile({repository,commit,content:f.content,expectedBlob:f.oid,read:f.read});
    assert.equal(Buffer.from(result.content,'base64').compare(f.bytes),0);assert.equal(result.sha,f.oid);assert.equal(f.calls.length,2);
    assert.equal(result.download_url,undefined);
  }
  for(const edit of [f=>f.content.path='scripts/ci/other.json',f=>f.content.type='symlink',f=>f.content.sha='3'.repeat(40),
    f=>f.content.size=1048576,f=>f.content.size=2097153,f=>f.content.size=1048577.5,f=>f.content.content='not empty',
    f=>f.tree.truncated=true,f=>f.tree.sha=null,f=>f.tree.tree.push({...f.tree.tree[0]}),f=>f.tree.tree[0].path='other',
    f=>f.tree.tree[0].type='tree',f=>f.tree.tree[0].mode='120000',f=>f.tree.tree[0].mode='100755',
    f=>f.tree.tree[0].sha='3'.repeat(40),f=>f.tree.tree[0].size++,f=>f.blob.sha='3'.repeat(40),
    f=>f.blob.size++,f=>f.blob.encoding='none',f=>delete f.blob.content,f=>f.blob.content+='!',
    f=>f.blob.content=Buffer.alloc(f.bytes.length,121).toString('base64')]) {
    const f=fixture();edit(f);
    await assert.rejects(completeLargeWorkflowProfile({repository,commit,content:f.content,expectedBlob:f.oid,read:f.read}),/WORKFLOW_PROFILE_BLOB_UNAVAILABLE/);
  }
  const badUtf8=fixture(Buffer.concat([Buffer.alloc(1048576,120),Buffer.from([255])]));
  await assert.rejects(completeLargeWorkflowProfile({repository,commit,content:badUtf8.content,read:badUtf8.read}),/WORKFLOW_PROFILE_BLOB_UNAVAILABLE/);
  for(const extra of [{commit:'main'},{commit:'1'.repeat(39)},{repository:'o/r?escape'},{expectedBlob:'3'.repeat(40)}]) {
    const f=fixture();await assert.rejects(completeLargeWorkflowProfile({repository,commit,content:f.content,read:f.read,...extra}),/WORKFLOW_PROFILE_BLOB_UNAVAILABLE/);assert.equal(f.calls.length,0);
  }
  const foreign=fixture();await assert.rejects(completeLargeWorkflowProfile({repository:'other/r',commit,content:foreign.content,read:foreign.read}),/WORKFLOW_PROFILE_BLOB_UNAVAILABLE/);
  const small={type:'file',path:file,sha:workflowBlob('old small'),size:9,encoding:'base64',content:Buffer.from('old small').toString('base64')};
  assert.equal(await completeLargeWorkflowProfile({content:small,read:()=>{throw Error('NO_NEW_SMALL_FILE_READ');}}),small);
});


test('preregistered complete G4 YAML keeps Owner, proven bot, unknown bot, fork and admission routes exclusive',()=>{
 const bot=AUTOMATION_BOT;
 const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
 const workflow=yaml.parse(parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))).workflows['.github/workflows/clued-g4-database.yml'].accepted_sources.find(source=>source.workflow_blob==='9d81933776a2646bdf0ff77f6ee2621cda551ec2').source_yaml);
 const trusted=workflow.jobs['database-gate-trusted-self-hosted'];
 const hosted=workflow.jobs['database-gate-untrusted-hosted'];
 const evaluate=(job,github,needs)=>Function('github','needs','cancelled',`return (${job.if.replaceAll('needs.admission-gate',"needs['admission-gate']").replaceAll('needs.push-reuse',"needs['push-reuse']")});`)(github,needs,()=>false);
 const expected=[
  ['owner PR','pull_request','o','o/r',true,false,[true,false]],
  ['qualified bot PR','pull_request',bot.login,'o/r',true,true,[true,false]],
  ['unqualified bot PR','pull_request',bot.login,'o/r',false,false,[false,false]],
  ['stranger proof cannot admit fork','pull_request',bot.login,'fork/r',true,true,[false,true]],
  ['fork owner name','pull_request','o','fork/r',true,false,[false,true]],
  ['Owner dispatch','workflow_dispatch','o','o/r',true,false,[true,false]],
  ['unknown dispatch','workflow_dispatch','other','o/r',true,true,[false,true]],
  ['Owner main push','push','o','o/r',true,false,[true,false]],
  ['nonOwner push cannot borrow PR proof','push',bot.login,'o/r',true,true,[false,true]],
  ['not admitted Owner','pull_request','o','o/r',false,false,[false,false]],
 ];
 for(const [label,event_name,actor,repo,admitted,proof,want]of expected){
  const github={event_name,actor,repository_owner:'o',repository:'o/r',event:{pull_request:{head:{repo:{full_name:repo}}}}};
  const needs={'admission-gate':{result:'success',outputs:{admitted:String(admitted),automation_self_hosted:String(proof)}},'push-reuse':{result:'skipped',outputs:{}}};
  assert.deepEqual([evaluate(trusted,github,needs),evaluate(hosted,github,needs)],want,label);
 }
 assert.deepEqual(trusted['runs-on'],['self-hosted','Linux','X64','clued','pool-general','trust-internal','cap-docker-linux']);
 assert.equal(hosted['runs-on'],'ubuntu-24.04');
});
