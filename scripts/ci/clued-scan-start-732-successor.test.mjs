import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {parseWorkflowProfiles,registeredWorkflowSource,compileRegisteredWorkflow,roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
import {registeredBootstrapOrdinarySuccessor,gateFindings,sha256Hex} from './clued-work-admission.mjs';
const root=new URL('../../',import.meta.url),fixture='work/actions-hosted-migration/independent-ci-v1/test/fixtures/scan-start-prereg/';
const yaml=createRequire(new URL('apps/clued-cloud/package.json',root))('yaml');
const info=JSON.parse(fs.readFileSync(new URL(fixture+'gitleaks-732-source.json',root))),row=info.row;
const text=fs.readFileSync(new URL(fixture+'gitleaks-732.yml',root),'utf8');
const profiles=parseWorkflowProfiles(fs.readFileSync(new URL('scripts/ci/clued-gated-proof-profiles.json',root)));
const roleSpecs=JSON.parse(fs.readFileSync(new URL('scripts/ci/clued-gated-proof-role-specs.json',root)));
const before=registeredWorkflowSource(profiles,row.file,row.predecessor_blob).profile.source_yaml;
const check=(baseText=before,headText=text,extra={})=>registeredBootstrapOrdinarySuccessor({file:{filename:row.file,status:'modified'},baseText,headText,profiles,roleSpecs,...extra});
test('732 successor is full-byte registered with complete role and unchanged physical gate',()=>{
  assert.equal(info.ownerSourceAccepted,false);
  assert.equal(workflowBlob(text),row.candidate_blob);assert.equal(sha256Hex(text),row.candidate_sha256);
  assert.equal(text,fs.readFileSync(new URL(row.file,root),'utf8'));
  const definition=yaml.parse(text),roles=roleSpecs.workflows[row.file].sources[row.candidate_blob];
  assert.deepEqual(roles.map(({job_id,definition_sha256})=>({job_id,definition_sha256})),row.roles);
  assert.equal(roleDefinitionDigest(definition.jobs[roles[0].job_id]),row.roles[0].definition_sha256);
  const compiled=compileRegisteredWorkflow(text,{primary_ids:roles.map(r=>r.job_id),parseYaml:yaml.parse,accepted_roles:roles});
  assert.deepEqual(compiled,registeredWorkflowSource(profiles,row.file,row.candidate_blob).profile);
  assert.deepEqual(gateFindings(text,text),[]);
  const positive=check();assert.equal(positive.passed,true);assert.equal(positive.execution_authority,false);
  assert.equal(positive.host_qualification,'separate_required');assert.equal(check(text,text).passed,true);
  assert.equal(check(text,before).passed,false);
  const earlier=registeredWorkflowSource(profiles,row.file,'e6fafbb0a40ce37795f1e50bbda03cd33fbf40e0').profile.source_yaml;
  assert.equal(check(earlier,text).passed,false,'a generation cannot be skipped');
});
test('732 exact pin, gate, role and public helper mutations are not granted by caller catalogues',()=>{
  for(const changed of [text+'# unregistered\n',text.replace('f21a46cb2a0c','a21a46cb2a0c'),
    text.replace('d395d46b18aa','a395d46b18aa'),text.replace("needs.admission-gate.outputs.admitted == 'true' &&",'always() &&'),
    text.replace('Acquire one-time scan permission','Skip scan permission')])assert.equal(check(before,changed).passed,false);
  const p=structuredClone(profiles);p.workflows[row.file].accepted_sources=p.workflows[row.file].accepted_sources.filter(s=>s.workflow_blob!==row.candidate_blob);
  assert.equal(check(before,text,{profiles:p}).passed,false);
  const r=structuredClone(roleSpecs);r.workflows[row.file].sources[row.candidate_blob][0].definition.steps.push({run:'echo unregistered'});
  assert.equal(check(before,text,{roleSpecs:r}).passed,false);
});
