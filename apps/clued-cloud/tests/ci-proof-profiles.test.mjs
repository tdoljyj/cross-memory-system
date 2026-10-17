import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {compileRegisteredWorkflow,workflowBlob,roleDefinitionDigest,rolesForSource,registeredWorkflowSource} from '../../../scripts/ci/clued-workflow-profile.mjs';
import {ciWorkflows} from '../../../scripts/ci/clued-merge-slot-ci.mjs';
import {compilePublisherPrQualificationSource,registeredPublisherPrQualificationSource,
  PUBLISHER_PR_QUALIFICATION_PATH,PUBLISHER_PR_QUALIFICATION_FILES} from '../../../scripts/ci/clued-publisher-qualification-source.mjs';
// These critical negative cases run through the existing quality unit entry.
import '../../../scripts/ci/clued-gated-proof.test.mjs';
import '../../../scripts/ci/clued-workflow-profile.test.mjs';
import '../../../scripts/ci/clued-gated-proof-runtime.test.mjs';
import '../../../scripts/ci/clued-reader-budget-cache.test.mjs';
// Consumer regressions execute on the actual PR's quality unit entry too.
import '../../../scripts/ci/clued-merge-executor.test.mjs';
import '../../../scripts/ci/npm-cache-observation.test.mjs';
const require=createRequire(import.meta.url);
const YAML=require('yaml');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const registry=JSON.parse(fs.readFileSync(path.join(root,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'));
const roleSpecs=JSON.parse(fs.readFileSync(path.join(root,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'));
const parseYaml=text=>{const doc=YAML.parseDocument(text);assert.deepEqual(doc.errors,[]);assert.deepEqual(doc.warnings,[]);return doc.toJS({maxAliasCount:0});};

test('registered definitions match full YAML bytes and complete explicit primary profiles',()=>{
  assert.equal(require('yaml/package.json').version,'2.9.0');
  assert.equal(registry.schema,'clued.gated-proof-profiles/2');
  assert.equal(roleSpecs.schema,'clued.gated-proof-role-specs/2');
  const current=ciWorkflows(root);
  for(const [file,record] of Object.entries(registry.workflows)) {
    for(const entry of [record,...(record.accepted_sources??[])]) {
      assert.equal(entry.registration_status,'registered');
      const derived=compileRegisteredWorkflow(entry.source_yaml,{primary_ids:entry.primary_ids,parseYaml,
        accepted_roles:rolesForSource(roleSpecs,file,entry.workflow_blob)});
      const {accepted_sources,...fields}=entry;
      assert.deepEqual(fields,derived,`${file}: profile omitted or changed source facts`);
    }
    assert.deepEqual(Object.keys(roleSpecs.workflows[file].sources).sort(),
      [record,...(record.accepted_sources??[])].map(entry=>entry.workflow_blob).sort(),`${file}: orphan source roles`);
  }
  for(const [file,blob] of current) {
    const record=registry.workflows[file];assert.ok(record,`${file}: missing source registration`);
    assert.ok([record,...(record.accepted_sources??[])].some(entry=>entry.workflow_blob===blob),`${file}: no registered current source`);
    assert.equal(workflowBlob(fs.readFileSync(path.join(root,file),'utf8')),blob);
    const committed=execFileSync('git',['show',`HEAD:${file}`],{cwd:root,encoding:'utf8',maxBuffer:524288,windowsHide:true});
    assert.ok([record,...(record.accepted_sources??[])].some(entry=>entry.workflow_blob===workflowBlob(committed)),
      `${file}: committed Git bytes have no registration`);
  }
});

test('publisher qualification catalogue binds every complete Source and independent role to actual worktree and committed Git bytes',()=>{
  assert.equal(require('yaml/package.json').version,'2.9.0');
  const files=[
    '.github/workflows/clued-production-publisher-host-qualification.yml',
    '.github/workflows/clued-production-publisher-guest-qualification.yml',
  ].sort();
  const catalogue=JSON.parse(fs.readFileSync(path.join(root,PUBLISHER_PR_QUALIFICATION_PATH),'utf8'));
  assert.deepEqual(Object.keys(PUBLISHER_PR_QUALIFICATION_FILES).sort(),files);
  assert.deepEqual(Object.keys(catalogue.workflows).sort(),files);
  assert.deepEqual(Object.keys(catalogue.roles).sort(),files);
  for(const file of files) {
    const record=catalogue.workflows[file];
    assert.equal(record.registration_status,'registered',file);
    assert.ok(Array.isArray(record.sources)&&record.sources.length>=1&&record.sources.length<=3,
      `${file}: exact bounded current and accepted Source history required`);
    assert.deepEqual(Object.keys(catalogue.roles[file]).sort(),record.sources.map(entry=>entry.workflow_blob).sort(),
      `${file}: missing or orphan independent Source roles`);
    for(const entry of record.sources) {
      const derived=compilePublisherPrQualificationSource(file,entry.source_yaml,{parseYaml,
        accepted_roles:catalogue.roles[file][entry.workflow_blob],operation:entry.operation});
      assert.deepEqual(entry,derived,`${file}: qualification catalogue omitted or changed raw Source facts`);
      assert.equal(entry.proof_classification,'qualification_only',`${file}: qualification must not become required success`);
      assert.equal(registeredPublisherPrQualificationSource(catalogue,file,entry.source_yaml).passed,true,
        `${file}: historical or current Source is not actually registered`);
    }
    const worktree=fs.readFileSync(path.join(root,file),'utf8');
    const committed=execFileSync('git',['show',`HEAD:${file}`],{cwd:root,encoding:'utf8',maxBuffer:524288,windowsHide:true});
    for(const [origin,text] of [['worktree',worktree],['committed HEAD',committed]]) {
      const result=registeredPublisherPrQualificationSource(catalogue,file,text);
      assert.equal(result.passed,true,`${file}: ${origin} exact Git bytes lack qualification registration (${result.reason??result.state})`);
      assert.equal(result.state,'qualified',`${file}: ${origin}`);
      assert.equal(result.scope,'registered_nonproduction_PR_qualification_source_only',`${file}: ${origin}`);
      assert.equal(result.profile.source_yaml,text,`${file}: ${origin} raw bytes changed`);
      assert.equal(result.profile.workflow_blob,workflowBlob(text),`${file}: ${origin} blob changed`);
    }
  }
});

test('YAML aliases and duplicate fields cannot hide an execution role or trigger',()=>{
  for(const source of [
    'on:\n  pull_request:\n  pull_request:\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps: []\n',
    'on:\n  pull_request:\nx: &steps [{run: node --test}]\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps: *steps\n'])
    {
      let called=false;
      const accepted_roles=[{job_id:'main',definition_sha256:roleDefinitionDigest({'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]})}];
      assert.throws(()=>compileRegisteredWorkflow(source,{primary_ids:['main'],accepted_roles,
        parseYaml:text=>{called=true;return parseYaml(text);}}));
      assert.equal(called,true,'negative case must reach the real locked YAML parser');
    }
});

test('docs telemetry skip is derived only from the exact reviewed Self command and condition',()=>{
  const file='.github/workflows/clued-cloud-quality-gate.yml',record=registry.workflows[file];
  const parsed=parseYaml(record.source_yaml);
  for(const edit of [step=>step.if='always()',step=>step.run='echo helper',
    step=>step.env.NPM_INSTALL_OUTCOME='success',step=>step['continue-on-error']=true]) {
    const changed=structuredClone(parsed),job=changed.jobs['trusted-self-hosted'];
    edit(job.steps.find(step=>step.name==='Observe npm HTTP cache events'));
    const derived=compileRegisteredWorkflow(record.source_yaml,{primary_ids:record.primary_ids,parseYaml:()=>changed,
      accepted_roles:record.primary_ids.map(job_id=>({job_id,definition_sha256:roleDefinitionDigest(changed.jobs[job_id])}))});
    assert.equal(derived.routes[0].documentation_skipped_steps,undefined);
  }
  for(const edit of [route=>route.documentation_skipped_steps=['Run npm run test:unit'],
    route=>route.documentation_skipped_steps=['Observe npm HTTP cache events','Unreviewed helper'],
    route=>route.command_digests['Observe npm HTTP cache events']=['a'.repeat(64)]]) {
    const changed=structuredClone(registry);edit(changed.workflows[file].routes[0]);
    assert.equal(registeredWorkflowSource(changed,file,record.workflow_blob).state,'unknown');
  }
});

test('real YAML cannot omit a heavy role or replace it with a successful helper',()=>{
  const source='on:\n  pull_request:\njobs:\n  heavy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n  helper:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo helper\n';
  const parsed=parseYaml(source);
  for(const primary_ids of [['heavy'],['helper'],['heavy','helper']]) {
    const accepted_roles=primary_ids.map(job_id=>({job_id,definition_sha256:roleDefinitionDigest(parsed.jobs[job_id])}));
    assert.throws(()=>compileRegisteredWorkflow(source,{primary_ids,parseYaml,accepted_roles}),
      primary_ids.length===1?/unassigned job roles/:/multiple logical primaries or duplicate routes/);
  }
});

test('Self heavy and Hosted helper are not implicitly accepted as one logical primary',()=>{
  const source='on:\n  pull_request:\njobs:\n  heavy:\n    runs-on: [self-hosted, Linux]\n    steps:\n      - run: node --test\n  alternate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo helper\n';
  const parsed=parseYaml(source);
  const accepted_roles=[{job_id:'heavy',definition_sha256:roleDefinitionDigest(parsed.jobs.heavy)},
    {job_id:'alternate',definition_sha256:roleDefinitionDigest({...parsed.jobs.alternate,steps:[{run:'node --test'}]})}];
  assert.throws(()=>compileRegisteredWorkflow(source,{primary_ids:['heavy','alternate'],parseYaml,accepted_roles}));
});
