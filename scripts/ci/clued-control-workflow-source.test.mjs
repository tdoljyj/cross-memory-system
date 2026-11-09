import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CONTROL_WORKFLOW_FILES,CONTROL_WORKFLOW_SOURCE_PATH,DISPATCHER_CHOICE_SOURCE,RETIRED_CONSUMER_OBSERVER_SOURCE,MERGE_RECONCILE_CONTROL_SOURCE,
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
  const full=load(),r=structuredClone(full);
  // The new no-predecessor family is tested separately. Keep this immutable
  // seven-file historical catalogue and its original digest unchanged.
  delete r.workflows[MERGE_RECONCILE_CONTROL_SOURCE.file];delete r.roles[MERGE_RECONCILE_CONTROL_SOURCE.file];
  const retirement=r.workflows[RETIRED_CONSUMER_OBSERVER_SOURCE.file];
  retirement.sources=retirement.sources.filter(s=>s.source_kind!=='retired_consumer_observer_successor');
  delete r.roles[RETIRED_CONSUMER_OBSERVER_SOURCE.file][RETIRED_CONSUMER_OBSERVER_SOURCE.workflow_blob];
  const row=r.workflows[file],added=row.sources.filter(s=>s.source_kind==='dispatcher_choice_successor');
  assert.equal(added.length,1);assert.equal(row.sources.length,3);assert.equal(Object.keys(r.workflows).length,7);
  row.sources=row.sources.filter(s=>s.source_kind!=='dispatcher_choice_successor');delete r.roles[file][DISPATCHER_CHOICE_SOURCE.workflow_blob];
  assert.equal(Object.values(r.workflows).reduce((n,row)=>n+row.sources.length,0),14);
  assert.equal(digest(r),'4024aa4110ad2051c5e3d3d0628b1a2c6583f588dd869b6be323d734387939c6');
  for(const [f,row] of Object.entries(r.workflows))for(const s of row.sources)assert.equal(sourceResult(full,s.source_yaml,f).passed,true,f);
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

test('fixed retirement snapshot keeps old consumer metadata while the explicit successor binds current bytes',()=>{
  const pins=RETIRED_CONSUMER_OBSERVER_SOURCE.implementation_blobs;
  assert.equal(Object.keys(pins).length,28);
  for(const name of ['.github/actions/ci-temporary-storage/check-workflows.mjs',
    '.github/actions/ci-temporary-storage/coverage.json','scripts/ci/clued-handover-native-entry.mjs',
    'config/clued-handover-native-entry-policy.json','scripts/ci/clued-scan-start.mjs'])assert.ok(pins[name],name);
  assert.ok(pins['scripts/ci/clued-work-admission.mjs']);
  assert.ok(pins['.github/workflows/clued-standard-runner-actor-qualification.yml']);
  assert.ok(pins['scripts/runner/qualify-standard-runner-actor.mjs']);
  assert.equal(pins[CONTROL_WORKFLOW_SOURCE_PATH],undefined);
  assert.equal(pins['scripts/ci/clued-control-workflow-source.mjs'],undefined);
  for(const [name,blob]of Object.entries(pins)){
    const current=fs.readFileSync(new URL(name,root),'utf8');
    const successors={
      'scripts/ci/clued-work-admission.mjs':['b6d65b5987aed5442ddb89087950c2c4369644f2','543c1ca9ea4d56cd4c517e9e45ab054bc2ee75795c1140b30161ead3744d5db5'],
      'scripts/ci/clued-merge-slot-ci.mjs':['b26a73bc6e05c4917d236a15e62b5ff01955f7b0','b0bd6da8c83353e74bd82ac8df471ee1f6ee16a2182888a8e5c702f43f5aa235'],
      'scripts/ci/merge-admission-source-producer.mjs':['2f428d400de4dbf0a9feca2bd27269c0dd353033','67667bf45a008c6580f29a2d90466e8fc96c54c75806d8422a2fc47d985c62a7'],
    };
    if(Object.hasOwn(successors,name)){
      // Authenticate each frozen historical object; bind its current successor
      // only in the separately reviewed initial Source. Never rewrite history.
      assert.equal(blob,successors[name][0]);
      const historical=execFileSync('git',['cat-file','blob',blob],{cwd:fileURLToPath(root)});
      assert.equal(workflowBlob(historical),blob,name);
      assert.equal(createHash('sha256').update(historical).digest('hex'),successors[name][1],name);
      assert.equal(workflowBlob(current),MERGE_RECONCILE_CONTROL_SOURCE.implementation_blobs[name],name);
      assert.notEqual(workflowBlob(current),blob,name);
    }else if(name==='.github/actions/ci-temporary-storage/coverage.json'){
      // New workflow lifecycle rows do not rewrite this retired snapshot.
      // Read and authenticate its exact old object, while the lifecycle suite
      // independently checks today's complete inventory against actual YAML.
      assert.equal(blob,'12f0ff5aca09df465aa0461d493485c3ed2c65b1');
      const historical=execFileSync('git',['cat-file','blob',blob],{cwd:fileURLToPath(root)});
      assert.equal(workflowBlob(historical),blob,name);
      assert.equal(createHash('sha256').update(historical).digest('hex'),
        '55a88fb58198f079d00c2467867b271d850ad198ee0eb1709db04ae2e109f9be');
    }else assert.equal(workflowBlob(current),blob,name);
  }
});


test('retirement removes only the retired live consumer while preserving the fifteen old Source records',()=>{
  const r=load(),f=RETIRED_CONSUMER_OBSERVER_SOURCE.file,rows=r.workflows[f].sources;
  const historical=structuredClone(r);delete historical.workflows[MERGE_RECONCILE_CONTROL_SOURCE.file];delete historical.roles[MERGE_RECONCILE_CONTROL_SOURCE.file];
  const head=rows.find(s=>s.source_kind==='retired_consumer_observer_successor');
  const previous=rows.find(s=>s.workflow_blob===RETIRED_CONSUMER_OBSERVER_SOURCE.retired_from_blob);
  assert.equal(Object.values(historical.workflows).reduce((n,x)=>n+x.sources.length,0),16);
  assert.equal(rows.length,4);assert.equal(head.source_yaml,fs.readFileSync(new URL(f,root),'utf8'));
  assert.equal(head.operation,'retire_completed_consumer_signal');
  const before=structuredClone(previous.workflow_definition),after=structuredClone(head.workflow_definition);
  const retired=RETIRED_CONSUMER_OBSERVER_SOURCE.removed_workflow;
  assert.equal(before.on.workflow_run.workflows.filter(x=>x===retired).length,1);
  assert.equal(after.on.workflow_run.workflows.includes(retired),false);
  before.on.workflow_run.workflows=before.on.workflow_run.workflows.filter(x=>x!==retired);
  assert.deepEqual(after,before);assert.deepEqual(head.role_digests,previous.role_digests);
  const current=sourceResult(r,head.source_yaml,f);assert.equal(current.passed,true);
  for(const key of ['execution_authority','dispatch_authority','production_authority','canonical_authority','runner_hook_exception'])assert.equal(current.authority_boundary[key],false);
  const removed='.github/workflows/clued-work-handover-qualification-home-linux-01.yml';
  assert.equal(fs.existsSync(new URL(removed,root)),false);
  for(const name of ['clued-gated-proof-profiles.json','clued-gated-proof-role-specs.json']){
    const active=JSON.parse(fs.readFileSync(new URL('scripts/ci/'+name,root)));
    assert.equal(active.workflows[removed],undefined);
  }
  const coverage=JSON.parse(fs.readFileSync(new URL('.github/actions/ci-temporary-storage/coverage.json',root)));
  assert.equal(coverage.workflows[removed.split('/').at(-1)],undefined);
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
