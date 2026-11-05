import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {CONTROL_WORKFLOW_FILES,CONTROL_WORKFLOW_SOURCE_PATH,DISPATCHER_CHOICE_SOURCE,
  compileControlWorkflowSource,registeredControlWorkflowSource,registeredControlWorkflowTransition} from './clued-control-workflow-source.mjs';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';

const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const root=new URL('../../',import.meta.url),file=DISPATCHER_CHOICE_SOURCE.file;
const load=()=>JSON.parse(fs.readFileSync(new URL('../../'+CONTROL_WORKFLOW_SOURCE_PATH,import.meta.url)));
const text=()=>fs.readFileSync(new URL(file,root),'utf8');
const predecessor=r=>r.workflows[file].sources.find(s=>s.source_kind==='legacy_predecessor');
const roleList=definition=>Object.entries(definition.jobs).map(([job_id,definition])=>({job_id,definition_sha256:roleDefinitionDigest(definition),definition}));
const compile=(value=text(),opts={})=>{const r=load();return compileControlWorkflowSource(file,value,{parseYaml:s=>yaml.parse(s),
  accepted_roles:roleList(yaml.parse(value)),source_kind:'dispatcher_choice_successor',predecessor:predecessor(r),...opts});};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const sourceResult=(r,s=text(),f=file)=>registeredControlWorkflowSource(r,f,s);
const change={status:'modified',filename:file};

test('exact dispatcher Source adds only the final fixed actor choice and retains its complete original job',()=>{
  const r=load(),old=predecessor(r),head=compile(),before=structuredClone(old.workflow_definition),after=structuredClone(head.workflow_definition);
  const choices=after.on.workflow_dispatch.inputs.workflow.options;
  assert.deepEqual(choices,[...before.on.workflow_dispatch.inputs.workflow.options,DISPATCHER_CHOICE_SOURCE.choice]);
  after.on.workflow_dispatch.inputs.workflow.options=before.on.workflow_dispatch.inputs.workflow.options;
  assert.deepEqual(after,before);
  assert.deepEqual(head.role_digests,old.role_digests);
  assert.deepEqual(head.command_digests,old.command_digests);
  assert.equal(head.workflow_blob,DISPATCHER_CHOICE_SOURCE.workflow_blob);
  assert.equal(head.source_sha256,DISPATCHER_CHOICE_SOURCE.source_sha256);
  assert.equal(head.operation,'extend_dispatcher_choice');
  assert.equal(head.predecessor_blob,'797efcd6218b04b347e0cd55d3352ac70cca2167');
  for(const key of ['execution_authority','dispatch_authority','production_authority','canonical_authority','runner_hook_exception'])assert.equal(head.authority_boundary[key],false);
});

test('the concrete Source, complete role and unchanged route cannot be substituted by structural equivalence',()=>{
  const original=text(),definition=yaml.parse(original);
  const mutations=[
    v=>v.on.workflow_dispatch.inputs.workflow.options.pop(),
    v=>v.on.workflow_dispatch.inputs.workflow.options.push(DISPATCHER_CHOICE_SOURCE.choice),
    v=>v.on.workflow_dispatch.inputs.workflow.options.push('unreviewed-actor.yml'),
    v=>v.on.workflow_dispatch.inputs.workflow.options.reverse(),
    v=>v.on.workflow_dispatch.inputs.workflow.options.splice(0,1),
    v=>v.on.workflow_dispatch.inputs.workflow.options.splice(0,0,v.on.workflow_dispatch.inputs.workflow.options.pop()),
    v=>v.on.workflow_dispatch.inputs.scope.default='project:unreviewed',
    v=>v.on.pull_request={},
    v=>v.jobs.admit['runs-on']=['self-hosted','Windows','X64','clued-controller-windows-v1'],
    v=>v.jobs.admit.permissions={contents:'write'},
    v=>v.jobs.admit.environment='another-environment',
    v=>v.jobs.admit.if='always()',
    v=>v.jobs.admit['timeout-minutes']=6,
    v=>v.jobs.admit.steps.find(s=>s.run?.includes('--mode dispatch-admit')).run+='\nnode arbitrary.mjs',
  ];
  for(const mutate of mutations){const altered=structuredClone(definition);mutate(altered);
    assert.throws(()=>compile(original,{parseYaml:()=>altered,accepted_roles:roleList(altered)}));
  }
  assert.throws(()=>compile(original+'\n'));
  assert.throws(()=>compile(original,{accepted_roles:[]}));
  assert.throws(()=>compile(original,{accepted_roles:[...roleList(definition),...roleList(definition)]}));
  const role=roleList(definition);role[0].definition_sha256='0'.repeat(64);
  assert.throws(()=>compile(original,{accepted_roles:role}));
  assert.throws(()=>compile(original,{source_kind:'controller_successor'}));
});

test('dispatcher choice kind is scoped to its one file and exact legacy predecessor',()=>{
  const r=load(),old=predecessor(r);
  for(const other of Object.keys(CONTROL_WORKFLOW_FILES).filter(f=>f!==file)){
    const entry=r.workflows[other].sources[0];
    assert.throws(()=>compileControlWorkflowSource(other,entry.source_yaml,{parseYaml:()=>entry.workflow_definition,
      accepted_roles:r.roles[other][entry.workflow_blob],source_kind:'dispatcher_choice_successor',predecessor:entry}));
  }
  for(const changed of [null,{...old,workflow_blob:'a'.repeat(40)},{...old,source_kind:'controller_successor'}])assert.throws(()=>compile(text(),{predecessor:changed}));
});

test('catalogue retains all fourteen old Sources, complete FullRoles and every old dependency verbatim',()=>{
  const r=load(),row=r.workflows[file],added=row.sources.filter(s=>s.source_kind==='dispatcher_choice_successor');
  assert.equal(added.length,1);assert.equal(row.sources.length,3);assert.equal(Object.keys(CONTROL_WORKFLOW_FILES).length,7);
  row.sources=row.sources.filter(s=>s.source_kind!=='dispatcher_choice_successor');delete r.roles[file][DISPATCHER_CHOICE_SOURCE.workflow_blob];
  assert.equal(Object.values(r.workflows).reduce((n,row)=>n+row.sources.length,0),14);
  assert.equal(digest(r),'4024aa4110ad2051c5e3d3d0628b1a2c6583f588dd869b6be323d734387939c6');
  for(const [f,row] of Object.entries(r.workflows))for(const s of row.sources)assert.equal(sourceResult(r,s.source_yaml,f).passed,true,f);
});

test('registered new Source needs exact complete catalogue integrity and never returns execution authority',()=>{
  const r=load(),s=sourceResult(r);assert.equal(s.passed,true);assert.equal(s.profile.source_kind,'dispatcher_choice_successor');
  assert.equal(s.scope,'registered_control_source_only');assert.equal(s.authority_boundary.execution_authority,false);
  for(const mutate of [
    v=>v.workflows[file].sources.find(s=>s.source_kind==='dispatcher_choice_successor').implementation_blobs['scripts/ci/clued-work-admission.mjs']='0'.repeat(40),
    v=>delete v.roles[file][DISPATCHER_CHOICE_SOURCE.workflow_blob],
    v=>v.roles[file][DISPATCHER_CHOICE_SOURCE.workflow_blob][0].definition.steps.reverse(),
    v=>v.workflows[file].sources.push(v.workflows[file].sources[0]),
  ]){const changed=load();mutate(changed);assert.equal(sourceResult(changed).passed,false);}
  assert.equal(sourceResult(r,text()+'\n').passed,false);
});

test('only modified exact legacy to choice successor is a registered transition',()=>{
  const r=load(),old=predecessor(r),head=text();
  assert.equal(registeredControlWorkflowTransition(r,file,head,old.source_yaml,{change}).passed,true);
  for(const mutation of [{...change,status:'added'},{...change,status:'renamed'},
    {...change,filename:'.github/workflows/other.yml'},{...change,previous_filename:'.github/workflows/other.yml'}])
    assert.equal(registeredControlWorkflowTransition(r,file,head,old.source_yaml,{change:mutation}).passed,false);
  for(const [a,b]of [[head,head],[old.source_yaml,head],[head,r.workflows[file].sources.find(s=>s.source_kind==='controller_successor').source_yaml]])
    assert.equal(registeredControlWorkflowTransition(r,file,a,b,{change}).passed,false);
});

test('new dependency snapshot binds actual implementation Git bytes without self-referential authority',()=>{
  const pins=DISPATCHER_CHOICE_SOURCE.implementation_blobs;
  assert.equal(Object.keys(pins).length,28);
  for(const name of ['.github/actions/ci-temporary-storage/check-workflows.mjs',
    '.github/actions/ci-temporary-storage/coverage.json','scripts/ci/clued-handover-native-entry.mjs',
    'config/clued-handover-native-entry-policy.json','scripts/ci/clued-scan-start.mjs'])assert.ok(pins[name],name);
  assert.ok(pins['scripts/ci/clued-work-admission.mjs']);
  assert.ok(pins['.github/workflows/clued-standard-runner-actor-qualification.yml']);
  assert.ok(pins['scripts/runner/qualify-standard-runner-actor.mjs']);
  assert.equal(pins[CONTROL_WORKFLOW_SOURCE_PATH],undefined);
  assert.equal(pins['scripts/ci/clued-control-workflow-source.mjs'],undefined);
  for(const [name,blob]of Object.entries(pins))assert.equal(workflowBlob(fs.readFileSync(new URL(name,root),'utf8')),blob,name);
});
