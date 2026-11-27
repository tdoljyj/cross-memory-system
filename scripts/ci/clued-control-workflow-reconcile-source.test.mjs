// Phase A runs without the future workflow or runtime files. Exact YAML and
// FullRole below come from the registered trusted-main source document, not a
// future B checkout, PR-provided catalogue or self-reported Host qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyReconcileSource} from './clued-merge-reconcile-source.mjs';
import {CONTROL_WORKFLOW_FILES,CONTROL_WORKFLOW_SOURCE_PATH,MERGE_RECONCILE_CONTROL_SOURCE,
  compileControlWorkflowSource,registeredControlWorkflowSource,registeredControlWorkflowTransition} from './clued-control-workflow-source.mjs';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
import {gateFindings,workflowFindings} from './clued-work-admission.mjs';

const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const root=fileURLToPath(new URL('../../',import.meta.url));
const historical=(blob,sha)=>{
  const bytes=execFileSync('git',['cat-file','blob',blob],{cwd:root,maxBuffer:4*1024*1024});
  assert.equal(workflowBlob(bytes),blob);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);
  return bytes;
};
const catalogueUrl=new URL('./clued-control-workflow-sources.json',import.meta.url);
const load=()=>JSON.parse(fs.readFileSync(catalogueUrl,'utf8'));
const FILE=MERGE_RECONCILE_CONTROL_SOURCE.file,REPO='tdoljyj/cross-memory-system';
const HEAD='a'.repeat(40),BASE='b'.repeat(40),change={filename:FILE,status:'added'};
const sourceOf=r=>r.workflows[FILE].sources[0];
const rolesOf=(r,s=sourceOf(r))=>r.roles[FILE][s.workflow_blob];
const roleList=d=>Object.entries(d.jobs).map(([job_id,definition])=>({job_id,definition_sha256:roleDefinitionDigest(definition),definition}));
const compile=(raw,definition,roles=roleList(definition),options={})=>compileControlWorkflowSource(FILE,raw,{
  parseYaml:()=>definition,accepted_roles:roles,source_kind:'merge_reconcile_initial',...options});
const transition=(r,raw=sourceOf(r).source_yaml,c=change,base=null,repository=REPO)=>
  registeredControlWorkflowTransition(r,FILE,raw,base,{repository,change:c});

test('one initial Source and full concrete Role are registered without inventing a predecessor',()=>{
  const r=load(),source=sourceOf(r),pin=MERGE_RECONCILE_CONTROL_SOURCE;
  assert.equal(Object.keys(CONTROL_WORKFLOW_FILES).length,8);
  assert.equal(r.workflows[FILE].sources.length,1);assert.equal(source.source_kind,'merge_reconcile_initial');
  assert.equal(source.family,'trusted_main_secret_reconcile_controller');assert.equal(source.predecessor_blob,null);
  assert.equal(source.operation,'register_initial_reconciliation_controller');
  assert.equal(source.source_sha256,'11d4b72a9f330801bdb44d3bd8a5b6c411cd328b02a6946ab9ada7485ec7dbf3');
  assert.equal(source.workflow_blob,'499c88f35012124bdcec316d9f0b17737867550a');
  assert.equal(roleDefinitionDigest(source.workflow_definition),'bc320b63b09ede8a615d1efa7298771543f350fa74974a475624f814dcaffd18');
  assert.equal(source.role_digests.reconcile,'66f0ab7a81fb3e6c6465d19434dde50474f30907a34593f3f0a2ed45121a2a9f');
  assert.equal(workflowBlob(source.source_yaml),pin.workflow_blob);
  assert.equal(createHash('sha256').update(source.source_yaml).digest('hex'),pin.source_sha256);
  assert.deepEqual(yaml.parse(source.source_yaml),source.workflow_definition);
  assert.deepEqual(compile(source.source_yaml,source.workflow_definition,rolesOf(r)),source);
  assert.deepEqual(source.primary_ids,['reconcile']);assert.equal(rolesOf(r).length,1);
  assert.deepEqual(rolesOf(r)[0].definition,source.workflow_definition.jobs.reconcile);
  assert.equal(Object.keys(pin.implementation_blobs).length,384);
  for(const name of ['scripts/ci/clued-merge-reconcile.mjs',
    'scripts/ci/clued-pr-task-binding.mjs','scripts/ci/clued-pr-task-binding.test.mjs',
    'scripts/ci/clued-pr-write-set.mjs','scripts/ci/clued-pr-write-set.test.mjs'])
    assert.equal(pin.implementation_blobs[name],workflowBlob(fs.readFileSync(new URL('../../'+name,import.meta.url))),name);
  for(const excluded of ['scripts/ci/clued-control-workflow-source.mjs',CONTROL_WORKFLOW_SOURCE_PATH,
    'scripts/ci/clued-merge-reconcile-source.json'])assert.equal(pin.implementation_blobs[excluded],undefined);
  for(const name of ['scripts/ci/clued-merge-reconcile.mjs','scripts/ci/clued-merge-reconcile-host.mjs',
    'scripts/ci/clued-merge-reconcile-gate.mjs','scripts/ci/clued-merge-reconcile-activation.json',
    'scripts/ci/clued-merge-executor.mjs','scripts/ci/clued-merge-slot-ci.mjs','scripts/ci/clued-work-admission.mjs'])
    assert.match(pin.implementation_blobs[name],/^[a-f0-9]{40}$/);
  // This initial Source is immutable historical metadata, not today's execution
  // integrity registry. Authenticate its actual Git objects rather than repin it.
  for(const [name,blob,sha] of [
    ['scripts/ci/clued-merge-reconcile-source.mjs','c3660096b818e8b432ac641f84526c7a4e0d0664','5abcc1cd5031cc20588027234d511a23a5998dd7c5dfc87816ee80a9a7f79c91'],
    ['scripts/ci/clued-merge-reconcile-source.test.mjs','68801654aa3adab6cb971a0f56c9fdc8b7159bc5','8fb5a8590c101b66602905da885496bc68fa430de723b0f7dd51d752b2ce36f7'],
    ['scripts/ci/merge-admission-r9-collector.test.mjs','1053a17adfaecf5df9e6510bbdecb1c0b2ba93bf','6223ac697944d99a0ee2b5c9500cb6123498fbf33854445f9b04211525c4603b'],
    ['scripts/ci/clued-work-admission.mjs','62ebce7bcaeb2402c5a92caa025f44e0c07c0735','61d070f4d1e3e733eddc22c1e7dcf32f4eb16ec2123bd61c4e2212dc869a6be5'],
    // The single generated-file list and its reader change with the generators;
    // the current integrity registry below binds their current bytes.
    ['scripts/ci/component-version-integration-policy.mjs','f64fadb108c552dbd2dec19d191720fbb236da06','92c876f373226ff0f1a9230317d8112bd829a9c8ab49a82cdc6b2e569de64cff'],
    ['config/clued-mechanical-files.json','ca52cf896a0c6fda896ef2341f79d9fa86c5da13','cc0e84cc388962fbea0f476374f17128bf109cb4652a8615178bcc7628399f82'],
  ]) {assert.equal(pin.implementation_blobs[name],blob,name);historical(blob,sha);}
});

test('the separate current integrity registry binds every current file without granting authority',()=>{
  const current=verifyReconcileSource(root);
  for(const key of ['executionAuthority','dispatchAuthority','productionAuthority','runnerHookException'])assert.equal(current[key],false,key);
  assert.equal(current.hostQualification,'separate_required');
  for(const name of ['scripts/ci/clued-work-admission.mjs','scripts/ci/merge-admission-r9-collector.test.mjs','config/clued-mechanical-files.json',
    'scripts/ci/component-version-integration-policy.mjs'])
    assert.equal(current.files[name],createHash('sha256').update(fs.readFileSync(new URL('../../'+name,import.meta.url))).digest('hex'));
});

test('historical object substitutions and current consumer byte mutations both refuse',()=>{
  assert.throws(()=>historical('1053a17adfaecf5df9e6510bbdecb1c0b2ba93bf','0'.repeat(64)));
  assert.throws(()=>historical('62ebce7bcaeb2402c5a92caa025f44e0c07c0735','6223ac697944d99a0ee2b5c9500cb6123498fbf33854445f9b04211525c4603b'));
  for(const name of ['scripts/ci/clued-work-admission.mjs','scripts/ci/merge-admission-r9-collector.test.mjs']) {
    let mutated=false;
    assert.throws(()=>verifyReconcileSource(root,(filename,...options)=>{
      const bytes=fs.readFileSync(filename,...options);
      if(filename.replaceAll('\\','/').endsWith('/'+name)){mutated=true;return Buffer.concat([Buffer.from(bytes),Buffer.from('\n// unregistered mutation\n')]);}
      return bytes;
    }),/MERGE_RECONCILE_SOURCE_UNQUALIFIED/);
    assert.equal(mutated,true,'the verifier must reach and reject the changed current file');
  }
});

test('exact initial registration remains source-only and does not grant Host, dispatch or execution authority',()=>{
  const r=load(),s=sourceOf(r),result=registeredControlWorkflowSource(r,FILE,s.source_yaml,{repository:REPO});
  assert.equal(result.passed,true);assert.equal(result.scope,'registered_control_source_only');
  for(const key of ['execution_authority','dispatch_authority','production_authority','canonical_authority','runner_hook_exception'])
    assert.equal(result.authority_boundary[key],false,key);
  assert.equal(result.authority_boundary.host_qualification,'separate_required');
  assert.equal(result.authority_boundary.credentials,'existing_clued_admission_environment_and_native_job_token');
  assert.equal(result.authority_boundary.stored_secrets,true);
  assert.equal(transition(r).passed,true);assert.equal(transition(r).scope,'registered_control_transition_source_only');
});

test('new source is added-only at the exact path with absent base, never a fake migration or copy',()=>{
  const r=load(),s=sourceOf(r);
  for(const c of [{...change,status:'modified'},{...change,status:'renamed'},{...change,status:'copied'},
    {...change,filename:'.github/workflows/other.yml'},{...change,previous_filename:FILE}])assert.equal(transition(r,s.source_yaml,c).passed,false);
  for(const base of ['',s.source_yaml,undefined]){
    const result=registeredControlWorkflowTransition(r,FILE,s.source_yaml,base,{repository:REPO,change});
    assert.equal(result.passed,false);
  }
  assert.equal(transition(r,s.source_yaml,change,null,'someone/else').passed,false);
  assert.throws(()=>compile(s.source_yaml,s.workflow_definition,rolesOf(r),{predecessor:{source_kind:'legacy_predecessor'}}));
  for(const kind of ['legacy_predecessor','controller_successor','completion_observer_successor'])
    assert.throws(()=>compile(s.source_yaml,s.workflow_definition,rolesOf(r),{source_kind:kind}));
});

test('trigger, permissions, secret, route, step, FullRole and raw-byte substitutions all refuse',()=>{
  const r=load(),s=sourceOf(r);
  const edits=[v=>v.on.push={branches:['main']},v=>v.on.workflow_dispatch.inputs.reconcile_request_id.required=false,
    v=>v.permissions.contents='write',v=>v.jobs.reconcile.environment='other',
    v=>v.jobs.reconcile['runs-on']=['ubuntu-latest'],v=>v.jobs.reconcile['runs-on'].pop(),
    v=>v.jobs.reconcile.steps.at(-1).env.CLUED_ADMISSION_APP_PRIVATE_KEY='${{ secrets.OTHER }}',
    v=>v.jobs.reconcile.steps.at(-1).run+='\nnode arbitrary.mjs',v=>v.jobs.reconcile.concurrency['cancel-in-progress']=true,
    v=>v.jobs.reconcile.if='always()',v=>v.jobs.other=structuredClone(v.jobs.reconcile)];
  for(const edit of edits){const definition=structuredClone(s.workflow_definition);edit(definition);
    assert.throws(()=>compile(s.source_yaml,definition));
    assert.equal(transition(r,yaml.stringify(definition)).passed,false);
  }
  assert.throws(()=>compile(s.source_yaml+'\n',s.workflow_definition));
  assert.equal(transition(r,s.source_yaml+'\n').passed,false);
  for(const roles of [[],[...rolesOf(r),...rolesOf(r)],rolesOf(r).map(x=>({...x,definition_sha256:'0'.repeat(64)}))])
    assert.throws(()=>compile(s.source_yaml,s.workflow_definition,roles));
});

test('missing or mutated trusted Source/FullRole/closure/authority cannot classify the new addition',()=>{
  const edits=[r=>delete r.roles[FILE],r=>r.default_branch='other',r=>r.repository='other/repository',
    r=>r.workflows[FILE].sources.push(sourceOf(r)),r=>sourceOf(r).predecessor_blob='0'.repeat(40),
    r=>sourceOf(r).implementation_blobs['scripts/ci/clued-merge-reconcile.mjs']='0'.repeat(40),
    r=>sourceOf(r).authority_boundary.execution_authority=true,
    r=>r.roles[FILE][sourceOf(r).workflow_blob][0].definition.steps.reverse()];
  for(const edit of edits){const r=load(),raw=sourceOf(r).source_yaml;edit(r);assert.equal(transition(r,raw).passed,false);}
});

const headFetch=(raw,registry=load())=>{
  const bytes=Buffer.from(JSON.stringify(registry)),blob=workflowBlob(bytes);
  const [tree,scripts,ci]=['1','2','3'].map(c=>c.repeat(40));
  const directory=(sha,path,child)=>({sha,truncated:false,tree:[{path,type:'tree',mode:'040000',sha:child}]});
  const routes={
    '/git/ref/heads/main':{ref:'refs/heads/main',object:{type:'commit',sha:BASE}},
    [`/git/commits/${BASE}`]:{sha:BASE,tree:{sha:tree}},
    [`/git/trees/${tree}`]:directory(tree,'scripts',scripts),
    [`/git/trees/${scripts}`]:directory(scripts,'ci',ci),
    [`/git/trees/${ci}`]:{sha:ci,truncated:false,tree:[{
      path:'clued-control-workflow-sources.json',type:'blob',mode:'100644',sha:blob,size:bytes.length,
    }]},
    [`/git/blobs/${blob}`]:{sha:blob,size:bytes.length,encoding:'base64',content:bytes.toString('base64')},
  };
  return async url=>{
    const actual=new URL(url);
    const prefix=`/repos/${REPO}`;
    assert.equal(actual.origin,'https://api.github.com');
    assert.ok(actual.pathname.startsWith(prefix+'/'));
    const route=actual.pathname.slice(prefix.length);
    if(Object.hasOwn(routes,route))return Response.json(routes[route]);
    assert.equal(route,`/contents/${FILE}`);
    assert.equal(actual.searchParams.get('ref'),HEAD);
    return Response.json({content:Buffer.from(raw).toString('base64')});
  };
};

test('actual workflowFindings admits the exact registered added pair while retaining normal Owner gates',async()=>{
  const s=sourceOf(load());
  assert.deepEqual(gateFindings(s.source_yaml,null),['admission_gate_missing']);
  const result=await workflowFindings(headFetch(s.source_yaml),{GITHUB_WORKSPACE:'untrusted-candidate-catalogue'},REPO,[change],HEAD,BASE);
  assert.deepEqual(result.gate,[]);assert.ok(result.owner.length>0,'privileged environment still needs ordinary Owner review');
});

test('actual workflowFindings refuses an old trusted catalogue rather than trusting PR data',async()=>{
  const r=load(),raw=sourceOf(r).source_yaml;delete r.workflows[FILE];delete r.roles[FILE];
  const result=await workflowFindings(headFetch(raw,r),{GITHUB_WORKSPACE:'candidate-catalogue',REGISTERED_CONTROL_ADDITION:'true'},REPO,[change],HEAD,BASE);
  assert.ok(result.gate.includes(`workflow_gate:${FILE}:control_Source_not_registered`));
  assert.ok(result.gate.includes(`workflow_gate:${FILE}:admission_gate_missing`));
});

test('actual workflowFindings does not excuse mutated Source bytes or a copied workflow name',async()=>{
  const raw=sourceOf(load()).source_yaml;
  const changed=await workflowFindings(headFetch(raw+'\n'),{},REPO,[change],HEAD,BASE);
  assert.ok(changed.gate.includes(`workflow_gate:${FILE}:control_Source_not_registered`));
  assert.ok(changed.gate.includes(`workflow_gate:${FILE}:admission_gate_missing`));
  const other='.github/workflows/not-registered.yml';
  const copied=await workflowFindings(async()=>new Response(JSON.stringify({content:Buffer.from(raw).toString('base64')}),{status:200}),{},REPO,
    [{filename:other,status:'added'}],HEAD,BASE);
  assert.ok(copied.gate.includes(`workflow_gate:${other}:admission_gate_missing`));
  assert.ok(gateFindings(raw+'\n',null,{registeredControlTransition:true,registeredControlAddition:true}).length>0);
});
