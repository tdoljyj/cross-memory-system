import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {compileRegisteredWorkflow,workflowBlob,roleDefinitionDigest} from '../../../scripts/ci/clued-workflow-profile.mjs';
import {ciWorkflows} from '../../../scripts/ci/clued-merge-slot-ci.mjs';
// These critical negative cases run through the existing quality unit entry.
import '../../../scripts/ci/clued-gated-proof.test.mjs';
import '../../../scripts/ci/clued-workflow-profile.test.mjs';
const require=createRequire(import.meta.url);
const YAML=require('yaml');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const registry=JSON.parse(fs.readFileSync(path.join(root,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'));
const roleSpecs=JSON.parse(fs.readFileSync(path.join(root,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'));
const parseYaml=text=>{const doc=YAML.parseDocument(text);assert.deepEqual(doc.errors,[]);assert.deepEqual(doc.warnings,[]);return doc.toJS({maxAliasCount:0});};

test('registered definitions match full YAML bytes and complete explicit primary profiles',()=>{
  assert.equal(require('yaml/package.json').version,'2.9.0');
  assert.equal(registry.schema,'clued.gated-proof-profiles/2');
  const current=ciWorkflows(root);
  for(const [file,record] of Object.entries(registry.workflows)) {
    for(const entry of [record,...(record.accepted_sources??[])]) {
      assert.equal(entry.registration_status,'registered');
      const derived=compileRegisteredWorkflow(entry.source_yaml,{primary_ids:entry.primary_ids,parseYaml,accepted_roles:roleSpecs.workflows[file]});
      const {accepted_sources,...fields}=entry;
      assert.deepEqual(fields,derived,`${file}: profile omitted or changed source facts`);
    }
  }
  for(const [file,blob] of current) {
    const record=registry.workflows[file];assert.ok(record,`${file}: missing source registration`);
    assert.ok([record,...(record.accepted_sources??[])].some(entry=>entry.workflow_blob===blob),`${file}: no registered current source`);
    assert.equal(workflowBlob(fs.readFileSync(path.join(root,file),'utf8')),blob);
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
