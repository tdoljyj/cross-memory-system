import assert from 'node:assert/strict';
import {retiredCatalogue} from './fixtures/retired-gated-proof-catalogue.mjs';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {parseWorkflowProfiles,registeredWorkflowSource,roleDefinitionDigest,workflowBlob,
  native617PendingWorkflowCatalogue,compileRegisteredWorkflow} from './clued-workflow-profile.mjs';
import {COMPONENT_VERSION,recognizeCatalogueWorkflow,createCatalogueSourceReader,REGISTERED_SOURCE,SOURCE_METADATA_ONLY_DISABLED,
  SOURCE_ONLY_METADATA_PINS} from './clued-source-only-workflow.mjs';
const require=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url));
const YAML=require('yaml');
const load=()=>({registry:parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))),
  roleSpecs:JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)))});
// Ordinary registered Source fixtures (clued-components, deleted with its entries) come from the last catalogue that had them.
const loadRetired=()=>{const {registry,specs}=retiredCatalogue();return {registry,roleSpecs:specs};};
const names=Object.keys(SOURCE_ONLY_METADATA_PINS);
const input=(name=names[0],world=load())=>({...world,file:name,blob:SOURCE_ONLY_METADATA_PINS[name]?.blob});
const entry=(world,name=names[0])=>world.registry.native617_pending_sources.find(row=>row.file===name);
const role=(world,name=names[0])=>world.roleSpecs.native617_pending_sources.find(row=>row.file===name).roles[0];
function denied(args){const r=recognizeCatalogueWorkflow(args);assert.equal(r.source_identified,false);assert.equal(r.execution_eligible,false);
  assert.equal(r.kind,null);assert.equal(r.reason,'CATALOGUE_SOURCE_NOT_IDENTIFIED');assert.equal(Object.hasOwn(r,'passed'),false);}

test('ordinary registered Source retains independent legacy roles and input is not mutated',()=>{
  const world=loadRetired(),file='.github/workflows/clued-components.yml',blob=world.registry.workflows[file].workflow_blob;
  const before=JSON.stringify(world),r=recognizeCatalogueWorkflow({...world,file,blob});
  assert.equal(COMPONENT_VERSION,'1.0.0');assert.equal(r.source_identified,true);assert.equal(r.kind,REGISTERED_SOURCE);
  assert.equal(r.execution_eligible,true);assert.ok(r.roles.length>0);
  assert.equal(Object.hasOwn(r,'passed'),false);assert.equal(Object.hasOwn(r,'NativeProof'),false);
  assert.equal(JSON.stringify(world),before);assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.profile)&&Object.isFrozen(r.roles));
  assert.notEqual(r.profile,world.registry.workflows[file]);
});

test('both exact External bytes identify only disabled path/command metadata; ordinary registration still refuses',()=>{
  const world=load(),before=JSON.stringify(world);
  assert.equal(native617PendingWorkflowCatalogue(world.registry,world.roleSpecs).structurally_valid,true);
  for(const file of names){
    const pin=SOURCE_ONLY_METADATA_PINS[file],r=recognizeCatalogueWorkflow(input(file,world));
    assert.equal(r.source_identified,true);assert.equal(r.kind,SOURCE_METADATA_ONLY_DISABLED);
    assert.equal(r.execution_eligible,false);assert.equal(r.host_qualified,false);assert.equal(r.operator_accepted,false);assert.equal(r.runtime_authorized,false);
    assert.equal(r.profile.registration_status,'source_metadata_only_disabled');assert.equal(r.profile.execution_eligible,false);
    assert.equal(r.profile.workflow_blob,pin.blob);assert.equal(r.profile.source_sha256,pin.source_sha256);
    assert.deepEqual(r.profile.primary_ids,[pin.job_id]);assert.ok(r.profile.pull_request.paths.length>0);
    assert.equal(r.profile.routes.length,1);assert.equal(r.profile.routes[0].execution_eligible,false);
    assert.ok(Object.keys(r.profile.routes[0].command_digests).length>0);
    assert.equal(Object.hasOwn(r,'passed'),false);assert.equal(Object.hasOwn(r.profile,'source_yaml'),false);
    assert.equal(registeredWorkflowSource(world.registry,file,pin.blob).passed,false);
    assert.ok(Object.isFrozen(r.roles[0].definition.steps));
  }
  assert.equal(JSON.stringify(world),before);
});

test('fixed whole workflow and role digests independently match actual full YAML with locked parser',()=>{
  assert.equal(require('yaml/package.json').version,'2.9.0');
  for(const file of names){
    const text=fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8'),pin=SOURCE_ONLY_METADATA_PINS[file];
    const parsed=YAML.parseDocument(text,{version:'1.2',strict:true,uniqueKeys:true,merge:false});
    assert.equal(parsed.errors.length,0);assert.equal(parsed.warnings.length,0);
    const definition=parsed.toJS({maxAliasCount:0});
    assert.equal(workflowBlob(text),pin.blob);assert.equal(roleDefinitionDigest(definition),pin.workflow_definition_sha256);
    assert.equal(roleDefinitionDigest(definition.jobs[pin.job_id]),pin.full_role_sha256);
  }
});

test('wrong source bytes, identity, full definition or full role cannot inherit metadata',()=>{
  for(const file of names)for(const edit of [
    w=>{entry(w,file).source_yaml+='\n';},w=>{entry(w,file).source_sha256='0'.repeat(64);},
    w=>{entry(w,file).workflow_blob='0'.repeat(40);},
    w=>{entry(w,file).workflow_definition.on.pull_request.paths.push('unreviewed/**');},
    w=>{entry(w,file).workflow_definition.name+=' changed';},
    w=>{const r=role(w,file);r.definition.steps.reverse();r.definition_sha256=roleDefinitionDigest(r.definition);
      entry(w,file).workflow_definition.jobs[r.job_id]=structuredClone(r.definition);},
    w=>{role(w,file).definition_sha256='0'.repeat(64);}
  ]){const world=load();edit(world);denied(input(file,world));}
});

test('qualification guard edits refuse even with recomputed caller Role hash and unchanged source string',()=>{
  for(const file of names){
    const world=load(),r=role(world,file),guard=r.definition.steps.find(s=>s.name==='Refuse until independent Native E1 qualification');
    guard.run='node scripts/ci/clued-handover-native-entry.mjs --execute';r.definition_sha256=roleDefinitionDigest(r.definition);
    entry(world,file).workflow_definition.jobs[r.job_id]=structuredClone(r.definition);
    denied(input(file,world));
  }
});

test('all three pending entries are required but third control and arbitrary files never gain this classification',()=>{
  const world=load(),third=world.registry.native617_pending_sources.find(row=>!names.includes(row.file));
  denied({...world,file:third.file,blob:third.workflow_blob});
  denied({...world,file:'.github/workflows/unrelated.yml',blob:SOURCE_ONLY_METADATA_PINS[names[0]].blob});
  for(const edit of [w=>w.registry.native617_pending_sources.pop(),w=>w.roleSpecs.native617_pending_sources.pop(),
    w=>{const e=w.registry.native617_pending_sources.find(row=>!names.includes(row.file));e.host_qualification={status:'qualified'};},
    w=>{const row=w.roleSpecs.native617_pending_sources.find(row=>!names.includes(row.file));row.roles[0].definition.steps=[];}]){
    const changed=load();edit(changed);denied(input(names[0],changed));
  }
});

test('active self-registration cannot promote either exact disabled subject even with complete recompiled profile',()=>{
  for(const file of names){
    const world=load(),e=entry(world,file),r=role(world,file),blob=e.workflow_blob;
    const profile=compileRegisteredWorkflow(e.source_yaml,{primary_ids:[r.job_id],accepted_roles:[r],parseYaml:()=>e.workflow_definition});
    (world.registry.workflows[file].accepted_sources??=[]).push(profile);
    world.roleSpecs.workflows[file].sources[blob]=[structuredClone(r)];
    assert.equal(registeredWorkflowSource(world.registry,file,blob).passed,true,'counterexample really enters the ordinary path');
    denied(input(file,world));
  }
});

test('invented acceptance, Host flags, caller overrides and unknown inputs never authorize metadata',()=>{
  for(const edit of [w=>{entry(w).source_acceptance={status:'accepted'};},w=>{entry(w).host_qualification={status:'qualified'};},
    w=>{entry(w).host_qualified=true;},w=>{entry(w).execution_eligible=true;}]){
    const world=load();edit(world);denied(input(names[0],world));
  }
  for(const extra of [{host_qualified:true},{execution_eligible:true},{operator_accepted:true}])denied({...input(),...extra});
  for(const missing of ['registry','roleSpecs','file','blob']){const args=input();delete args[missing];denied(args);}
  denied(undefined);denied(null);denied({});denied({...input(),blob:'UNKNOWN'});
});

test('accessors, proxies, functions, cycles and foreign errors are refused without reading error details',()=>{
  let getters=0,strings=0;const foreign={get code(){getters++;return 'FOREIGN_VALUE';},toString(){strings++;return 'FOREIGN_VALUE';}};
  const args=input();Object.defineProperty(args,'registry',{enumerable:true,get(){getters++;throw foreign;}});denied(args);
  for(const trap of ['ownKeys','getPrototypeOf','getOwnPropertyDescriptor'])denied(new Proxy(input(),{[trap](){throw foreign;}}));
  const cyclic=input();cyclic.registry.cycle=cyclic;denied(cyclic);
  const fn=input();fn.roleSpecs.extra=()=>true;denied(fn);
  assert.equal(getters,0);assert.equal(strings,0);
});

test('ordinary Source recognition still rejects missing, partial or altered independent roles',()=>{
  const file='.github/workflows/clued-components.yml';
  for(const edit of [w=>{delete w.roleSpecs.workflows[file];},w=>{const b=w.registry.workflows[file].workflow_blob;w.roleSpecs.workflows[file].sources[b]=[];},
    w=>{const b=w.registry.workflows[file].workflow_blob;w.roleSpecs.workflows[file].sources[b][0].definition={steps:[]};}]){
    const world=loadRetired(),blob=world.registry.workflows[file].workflow_blob;edit(world);denied({...world,file,blob});
  }
});

test('every existing ordinary registered profile keeps its ordinary classification',()=>{
  const world=load();let count=0;
  for(const [file,row] of Object.entries(world.registry.workflows))for(const profile of [row,...(row.accepted_sources??[])]){
    const r=recognizeCatalogueWorkflow({...world,file,blob:profile.workflow_blob});
    assert.equal(r.source_identified,true,file);assert.equal(r.kind,REGISTERED_SOURCE,file);
    assert.equal(r.execution_eligible,true,file);count++;
  }
  assert.ok(count>0);
});

test('disk/3 input remains metadata-only and cannot mutate or qualify its wire catalogue',()=>{
  const world=load(),wire=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))),before=JSON.stringify(wire);
  assert.equal(wire.schema,'clued.gated-proof-profiles/3');
  for(const file of names){
    const r=recognizeCatalogueWorkflow({...world,registry:wire,file,blob:SOURCE_ONLY_METADATA_PINS[file].blob});
    assert.equal(r.source_identified,true);assert.equal(r.execution_eligible,false);
    assert.equal(registeredWorkflowSource(wire,file,r.blob).passed,false);
  }
  assert.equal(JSON.stringify(wire),before);
});

test('request factory snapshots data once; later caller mutation cannot alter an unread disabled subject',()=>{
  const world=load(),reader=createCatalogueSourceReader(world),file=names[0],blob=SOURCE_ONLY_METADATA_PINS[file].blob;
  assert.ok(Object.isFrozen(reader));assert.deepEqual(Object.keys(reader),[]);
  entry(world,file).source_yaml+='\n';role(world,file).definition.steps.reverse();
  const old=reader({file,blob});
  assert.equal(old.source_identified,true);assert.equal(old.execution_eligible,false);
  assert.equal(createCatalogueSourceReader(world)({file,blob}).source_identified,false);
  assert.equal(recognizeCatalogueWorkflow({...world,file,blob}).source_identified,false);
});

test('factory ordinary cache is immutable static data and a fresh factory validates changed source anew',()=>{
  const world=loadRetired(),file='.github/workflows/clued-components.yml',blob=world.registry.workflows[file].workflow_blob,
    reader=createCatalogueSourceReader(world),first=reader({file,blob});
  assert.equal(first.source_identified,true);assert.equal(reader({file,blob}),first);
  world.registry.workflows[file].source_yaml+=' changed';
  assert.equal(reader({file,blob}),first,'private snapshot must not refer to mutable caller data');
  assert.equal(createCatalogueSourceReader(world)({file,blob}).source_identified,false);
  assert.throws(()=>{first.profile.execution_eligible=false;},TypeError);
  assert.equal(reader({file,blob}).execution_eligible,true);
});

test('returned metadata profiles, roles and routes cannot be mutated or used to enable later reads',()=>{
  const world=load(),reader=createCatalogueSourceReader(world),file=names[0],blob=SOURCE_ONLY_METADATA_PINS[file].blob;
  const first=reader({file,blob});
  for(const mutate of [()=>{first.execution_eligible=true;},()=>{first.profile.execution_eligible=true;},
    ()=>{first.profile.routes[0].execution_eligible=true;},()=>{first.roles[0].definition.steps.length=0;},
    ()=>{first.profile.pull_request.paths.push('unreviewed/**');}])assert.throws(mutate,TypeError);
  assert.equal(reader({file,blob}),first);assert.equal(first.execution_eligible,false);
  const second=createCatalogueSourceReader(world)({file,blob});
  assert.notEqual(second,first);assert.notEqual(second.profile,first.profile);assert.notEqual(second.roles,first.roles);
  assert.ok(JSON.stringify(second)===JSON.stringify(first),'factories share no object/cache state');
});

test('factory and per-read getter/proxy inputs refuse without foreign error inspection',()=>{
  let getters=0,strings=0;const foreign={get code(){getters++;return 'FOREIGN_VALUE';},toString(){strings++;return 'FOREIGN_VALUE';}};
  const world=load(),request={file:names[0],blob:SOURCE_ONLY_METADATA_PINS[names[0]].blob};
  const getter={roleSpecs:world.roleSpecs};Object.defineProperty(getter,'registry',{enumerable:true,get(){getters++;throw foreign;}});
  assert.equal(createCatalogueSourceReader(getter)(request).source_identified,false);
  for(const trap of ['ownKeys','getPrototypeOf','getOwnPropertyDescriptor']){
    assert.equal(createCatalogueSourceReader(new Proxy(world,{[trap](){throw foreign;}}))(request).source_identified,false);
    assert.equal(createCatalogueSourceReader(world)(new Proxy(request,{[trap](){throw foreign;}})).source_identified,false);
  }
  const readGetter={blob:request.blob};Object.defineProperty(readGetter,'file',{enumerable:true,get(){getters++;throw foreign;}});
  assert.equal(createCatalogueSourceReader(world)(readGetter).source_identified,false);
  assert.equal(getters,0);assert.equal(strings,0);
});

test('all pending active-map boundaries are checked before a fixed disabled lookup',()=>{
  for(const sibling of [names[1],'.github/workflows/clued-native617-admission-dispatch.yml']){
    const world=load(),e=entry(world,sibling);
    world.registry.workflows[sibling]={workflow_blob:e.workflow_blob};
    const reader=createCatalogueSourceReader(world),r=reader({file:names[0],blob:SOURCE_ONLY_METADATA_PINS[names[0]].blob});
    assert.equal(r.source_identified,false);assert.equal(r.execution_eligible,false);
  }
});

test('one request reader retains every registered profile while repeated lookups reuse private descriptors',()=>{
  const world=load(),reader=createCatalogueSourceReader(world);
  for(const [file,row] of Object.entries(world.registry.workflows))for(const profile of [row,...(row.accepted_sources??[])]){
    const request={file,blob:profile.workflow_blob},first=reader(request);
    assert.equal(first.source_identified,true,file);assert.equal(first.kind,REGISTERED_SOURCE,file);
    assert.equal(reader(request),first);
  }
});
