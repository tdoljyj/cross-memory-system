import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {compileRegisteredWorkflow,workflowBlob} from '../../../scripts/ci/clued-workflow-profile.mjs';
import {ciWorkflows} from '../../../scripts/ci/clued-merge-slot-ci.mjs';
const require=createRequire(import.meta.url);
const YAML=require('yaml');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const registry=JSON.parse(fs.readFileSync(path.join(root,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'));
const parseYaml=text=>{const doc=YAML.parseDocument(text);assert.deepEqual(doc.errors,[]);assert.deepEqual(doc.warnings,[]);return doc.toJS({maxAliasCount:0});};

test('registered definitions match full YAML bytes and complete explicit primary profiles',()=>{
  assert.equal(require('yaml/package.json').version,'2.9.0');
  assert.equal(registry.schema,'clued.gated-proof-profiles/2');
  const current=ciWorkflows(root);
  for(const [file,record] of Object.entries(registry.workflows)) {
    for(const entry of [record,...(record.accepted_sources??[])]) {
      assert.equal(entry.registration_status,'registered');
      const derived=compileRegisteredWorkflow(entry.source_yaml,{primary_ids:entry.primary_ids,parseYaml});
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
    assert.throws(()=>compileRegisteredWorkflow(source,{primary_ids:['main'],parseYaml}));
});
