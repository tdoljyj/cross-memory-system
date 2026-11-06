import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {CONTROL_WORKFLOW_FILES,CONTROL_WORKFLOW_SOURCE_PATH,DISPATCHER_CHOICE_SOURCE,RETIRED_CONSUMER_OBSERVER_SOURCE,
  compileControlWorkflowSource,registeredControlWorkflowSource,registeredControlWorkflowTransition} from './clued-control-workflow-source.mjs';
import {parseWorkflowProfiles,roleDefinitionDigest,serializeWorkflowProfiles,workflowBlob} from './clued-workflow-profile.mjs';

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
  const r=load();
  const retirement=r.workflows[RETIRED_CONSUMER_OBSERVER_SOURCE.file];
  retirement.sources=retirement.sources.filter(s=>s.source_kind!=='retired_consumer_observer_successor');
  delete r.roles[RETIRED_CONSUMER_OBSERVER_SOURCE.file][RETIRED_CONSUMER_OBSERVER_SOURCE.workflow_blob];
  const row=r.workflows[file],added=row.sources.filter(s=>s.source_kind==='dispatcher_choice_successor');
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

// Step 1 of the home-linux-01 retirement registers the successor Source while
// main still runs the old merge-slot workflow. The three files step 2 changes
// are pinned at exactly the bytes that removing the retired workflow's entries
// gives; every other pin is the actual file.
const RETIRED_WORKFLOW='.github/workflows/clued-work-handover-qualification-home-linux-01.yml';
const retiredStepTwoBytes=()=>{
  const read=name=>fs.readFileSync(new URL(name,root),'utf8');
  const coverage=JSON.parse(read('.github/actions/ci-temporary-storage/coverage.json'));
  assert.ok(Object.hasOwn(coverage.workflows,RETIRED_WORKFLOW.split('/').at(-1)));
  delete coverage.workflows[RETIRED_WORKFLOW.split('/').at(-1)];
  const profiles=parseWorkflowProfiles(fs.readFileSync(new URL('scripts/ci/clued-gated-proof-profiles.json',root)));
  assert.ok(Object.hasOwn(profiles.workflows,RETIRED_WORKFLOW));delete profiles.workflows[RETIRED_WORKFLOW];
  const specs=JSON.parse(read('scripts/ci/clued-gated-proof-role-specs.json'));
  assert.ok(Object.hasOwn(specs.workflows,RETIRED_WORKFLOW));delete specs.workflows[RETIRED_WORKFLOW];
  return {'.github/actions/ci-temporary-storage/coverage.json':JSON.stringify(coverage,null,2)+'\n',
    'scripts/ci/clued-gated-proof-profiles.json':serializeWorkflowProfiles(profiles),
    'scripts/ci/clued-gated-proof-role-specs.json':JSON.stringify(specs,null,2)+'\n'};
};

test('retirement dependency snapshot binds actual implementation Git bytes and the exact pending retirement bytes',()=>{
  const pins=RETIRED_CONSUMER_OBSERVER_SOURCE.implementation_blobs,pending=retiredStepTwoBytes();
  assert.equal(Object.keys(pins).length,28);
  for(const name of ['.github/actions/ci-temporary-storage/check-workflows.mjs',
    '.github/actions/ci-temporary-storage/coverage.json','scripts/ci/clued-handover-native-entry.mjs',
    'config/clued-handover-native-entry-policy.json','scripts/ci/clued-scan-start.mjs'])assert.ok(pins[name],name);
  assert.ok(pins['scripts/ci/clued-work-admission.mjs']);
  assert.ok(pins['.github/workflows/clued-standard-runner-actor-qualification.yml']);
  assert.ok(pins['scripts/runner/qualify-standard-runner-actor.mjs']);
  assert.equal(pins[CONTROL_WORKFLOW_SOURCE_PATH],undefined);
  assert.equal(pins['scripts/ci/clued-control-workflow-source.mjs'],undefined);
  for(const name of Object.keys(pending))assert.ok(Object.hasOwn(pins,name),name);
  for(const [name,blob]of Object.entries(pins)){
    const actual=workflowBlob(fs.readFileSync(new URL(name,root),'utf8'));
    if(Object.hasOwn(pending,name)){assert.equal(workflowBlob(pending[name]),blob,name);assert.notEqual(actual,blob,name);}
    else assert.equal(actual,blob,name);
  }
});

test('pending retirement Source is the actual main merge-slot Source minus only the retired consumer signal',()=>{
  const r=load(),f=RETIRED_CONSUMER_OBSERVER_SOURCE.file,rows=r.workflows[f].sources;
  const head=rows.find(s=>s.source_kind==='retired_consumer_observer_successor');
  const previous=rows.find(s=>s.workflow_blob===RETIRED_CONSUMER_OBSERVER_SOURCE.retired_from_blob);
  const actual=fs.readFileSync(new URL(f,root),'utf8'),retired=RETIRED_CONSUMER_OBSERVER_SOURCE.removed_workflow;
  assert.equal(Object.values(r.workflows).reduce((n,x)=>n+x.sources.length,0),16);
  assert.equal(rows.length,4);assert.equal(head.operation,'retire_completed_consumer_signal');
  assert.equal(workflowBlob(actual),RETIRED_CONSUMER_OBSERVER_SOURCE.retired_from_blob);
  assert.equal(previous.source_kind,'completion_observer_successor');assert.equal(previous.source_yaml,actual);
  const line=`      - ${retired}\n`;
  assert.equal(actual.split(line).length,2);assert.equal(head.source_yaml,actual.replace(line,''));
  assert.equal(workflowBlob(head.source_yaml),RETIRED_CONSUMER_OBSERVER_SOURCE.workflow_blob);
  const before=structuredClone(previous.workflow_definition),after=structuredClone(head.workflow_definition);
  assert.equal(before.on.workflow_run.workflows.filter(x=>x===retired).length,1);
  assert.equal(after.on.workflow_run.workflows.includes(retired),false);
  before.on.workflow_run.workflows=before.on.workflow_run.workflows.filter(x=>x!==retired);
  assert.deepEqual(after,before);assert.deepEqual(head.role_digests,previous.role_digests);
  for(const text of [actual,head.source_yaml]){
    const current=sourceResult(r,text,f);assert.equal(current.passed,true);
    for(const key of ['execution_authority','dispatch_authority','production_authority','canonical_authority','runner_hook_exception'])assert.equal(current.authority_boundary[key],false);
  }
  assert.equal(registeredControlWorkflowTransition(r,f,head.source_yaml,actual,{change:{filename:f,status:'modified'}}).passed,true);
  // The retired consumer still runs until step 2 removes it with its signal.
  assert.equal(fs.readFileSync(new URL(RETIRED_WORKFLOW,root),'utf8').split('\n')[0],`name: ${retired}`);
});

test('retirement transition requires exact actual-main legacy or completion predecessor, modified path and complete unchanged Role',()=>{
  const r=load(),f=RETIRED_CONSUMER_OBSERVER_SOURCE.file,rows=r.workflows[f].sources;
  const head=rows.find(s=>s.source_kind==='retired_consumer_observer_successor');
  const previous=rows.find(s=>s.workflow_blob===RETIRED_CONSUMER_OBSERVER_SOURCE.retired_from_blob);
  const changed={filename:f,status:'modified'};
  const check=(a=head.source_yaml,b=previous.source_yaml,c=changed)=>registeredControlWorkflowTransition(r,f,a,b,{change:c}).passed;
  assert.equal(check(),true);
  const legacy=rows.find(s=>s.source_kind==='legacy_predecessor');
  assert.equal(workflowBlob(legacy.source_yaml),RETIRED_CONSUMER_OBSERVER_SOURCE.legacy_from_blob);
  assert.equal(RETIRED_CONSUMER_OBSERVER_SOURCE.legacy_from_blob,'662dbc3e846311379efa5f081b3cca518a881f74');
  assert.equal(check(head.source_yaml,legacy.source_yaml),true);
  for(const old of rows.filter(s=>s!==previous&&s!==legacy))assert.equal(check(head.source_yaml,old.source_yaml),false);
  assert.equal(check(head.source_yaml,legacy.source_yaml+'\n'),false);
  for(const c of [{...changed,status:'added'},{...changed,status:'renamed'},{...changed,previous_filename:'other.yml'},{...changed,filename:'other.yml'}])assert.equal(check(head.source_yaml,previous.source_yaml,c),false);
  assert.equal(check(head.source_yaml+'\n'),false);
  const base=rows.find(s=>s.source_kind==='legacy_predecessor');
  const compileRetired=(text,definition,roles=roleList(definition))=>compileControlWorkflowSource(f,text,{source_kind:'retired_consumer_observer_successor',predecessor:base,parseYaml:()=>definition,accepted_roles:roles});
  assert.deepEqual(compileRetired(head.source_yaml,head.workflow_definition),head);
  for(const edit of [v=>v.on.workflow_run.workflows.pop(),v=>v.on.workflow_run.workflows.push('other'),v=>v.on.workflow_run.workflows.reverse(),v=>v.on.workflow_run.workflows.push(RETIRED_CONSUMER_OBSERVER_SOURCE.removed_workflow),v=>v.jobs.report.permissions={contents:'write'},v=>v.jobs.report['runs-on']=['self-hosted'],v=>v.jobs.report.steps[0].run='arbitrary',v=>v.on.workflow_dispatch={unreviewed:true}]){
    const definition=structuredClone(head.workflow_definition);edit(definition);
    assert.throws(()=>compileRetired(head.source_yaml,definition));
  }
  assert.throws(()=>compileRetired(head.source_yaml,head.workflow_definition,[]));
  for(const edit of [v=>delete v.roles[f][head.workflow_blob],v=>v.workflows[f].sources.push(head),v=>v.workflows[f].sources.find(x=>x.source_kind==='retired_consumer_observer_successor').implementation_blobs['scripts/ci/clued-work-admission.mjs']='0'.repeat(40)]){
    const altered=structuredClone(r);edit(altered);assert.equal(sourceResult(altered,head.source_yaml,f).passed,false);
  }
});
