import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {verifyReconcileSource,SOURCE_FILE,WORKFLOW_FILE,canonical,hash} from './clued-merge-reconcile-source.mjs';
import {validateMergeReconcileConfig,MERGE_RECONCILE_WORKFLOW_SHA256} from '../../work/independent-ci-resident-v1/src/merge-reconcile-config.mjs';

const root=path.resolve(new URL('../../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const raw=()=>fs.readFileSync(path.join(root,WORKFLOW_FILE),'utf8');

test('registered complete Source and Role match the fixed self-owned default-branch controller',()=>{
  const source=verifyReconcileSource(root),workflow=yaml.parse(raw());
  assert.deepEqual(workflow.jobs.reconcile,source.role.definition);
  assert.equal(source.role.sha256,hash(JSON.stringify(canonical(workflow.jobs.reconcile))));
  assert.equal(source.workflow.sha256,MERGE_RECONCILE_WORKFLOW_SHA256);
  assert.equal(source.executionAuthority,false);assert.equal(source.hostQualification,'separate_required');
  assert.deepEqual(workflow.on,{workflow_dispatch:{inputs:{reconcile_request_id:{description:'Wake-up identity only; never a PR, head or permission',type:'string',required:true}}}});
  assert.equal(workflow.jobs.reconcile.if,"github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.reconcile.environment,'clued-admission');
  assert.deepEqual(workflow.jobs.reconcile.concurrency,{group:'clued-merge-executor','cancel-in-progress':false});
  assert.equal(workflow.jobs.reconcile.steps[0].with.ref,'main');
  assert.equal(workflow.jobs.reconcile.steps[0].with['persist-credentials'],false);
  assert.equal(workflow.jobs.reconcile.steps.findIndex(x=>x.run==='node scripts/ci/clued-merge-reconcile-source.mjs'),3);
  assert.equal(workflow.jobs.reconcile.steps.findIndex(x=>x.env?.CLUED_ADMISSION_APP_PRIVATE_KEY),4);
  assert.equal(raw().includes('actions/upload-artifact@'),false);
  assert.equal(raw().includes('actions/cache@'),false);
});

test('changed byte/Role, omitted dependency and claimed authority cannot become registered Source',()=>{
  const manifest=fs.readFileSync(path.join(root,SOURCE_FILE),'utf8');
  const alterations=[s=>{s.executionAuthority=true;},s=>{s.hostQualification='qualified';},
    s=>{s.runnerHookException=true;},s=>{s.role.definition['runs-on']='ubuntu-slim';},
    s=>{s.role.definition.permissions={contents:'write'};s.role.sha256=hash(JSON.stringify(canonical(s.role.definition)));},
    s=>{delete s.files['scripts/ci/clued-work-admission.mjs'];},
    s=>{s.files['scripts/ci/clued-merge-executor.mjs']='0'.repeat(64);}];
  for(const alter of alterations){const changed=JSON.parse(manifest);alter(changed);
    assert.throws(()=>verifyReconcileSource(root,(name,encoding)=>name===path.join(root,SOURCE_FILE)?JSON.stringify(changed):fs.readFileSync(name,encoding)),/UNQUALIFIED/);}
  assert.throws(()=>verifyReconcileSource(root,(name,encoding)=>name===path.join(root,WORKFLOW_FILE)?raw()+'\n':fs.readFileSync(name,encoding)),/UNQUALIFIED/);
});

test('existing package config has no new dispatch lane; enablement cannot inject Source or routing',()=>{
  assert.deepEqual(validateMergeReconcileConfig(undefined),{enabled:false});
  assert.deepEqual(validateMergeReconcileConfig({enabled:false}),{enabled:false});
  assert.deepEqual(validateMergeReconcileConfig({enabled:true}),{enabled:true});
  for(const bad of [true,[],{}, {enabled:1},{enabled:true,workflow:'other.yml'},{enabled:true,pinnedSource:'0'.repeat(64)}])
    assert.throws(()=>validateMergeReconcileConfig(bad),/CONFIG_INVALID/);
});
