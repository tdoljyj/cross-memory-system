import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {compilePublisherSource,registeredPublisherSource,registeredPublisherTransition,
  PUBLISHER_SOURCE_SCHEMA,PUBLISHER_LABELS,PUBLISHER_JOB_CONDITION,PUBLISHER_PROBE_LABELS,PUBLISHER_PROBE_CONDITION,PUBLISHER_QUALIFY_CONDITION} from './clued-production-publisher-source.mjs';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
import {workflowJobs,gateFindings} from './clued-work-admission.mjs';
const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const parseYaml=text=>{const d=yaml.parseDocument(text,{uniqueKeys:true});if(d.errors.length)throw d.errors[0];return d.toJS({maxAliasCount:0});};
const file='.github/workflows/clued-cloud-production-release.yml';
const registry=()=>JSON.parse(fs.readFileSync(new URL('./clued-production-publisher-sources.json',import.meta.url),'utf8'));
const source=(kind='gated_successor')=>registry().workflows[file].sources.find(s=>s.source_kind===kind);
const roles=text=>{const value=parseYaml(text);return Object.keys(value.jobs).sort().map(job_id=>({job_id,definition_sha256:roleDefinitionDigest(value.jobs[job_id])}));};

test('publisher Source: locked YAML compilation reproduces full registered bytes and independent roles',()=>{
  const r=registry();
  for(const p of r.workflows[file].sources) {
    assert.deepEqual(compilePublisherSource(file,p.source_yaml,{parseYaml,accepted_roles:r.roles[file][p.workflow_blob],source_kind:p.source_kind,operation:p.operation}),p);
    assert.equal(registeredPublisherSource(r,file,p.source_yaml).passed,true);
  }
  const before=source('legacy_predecessor'),after=source();
  assert.deepEqual(before.workflow_definition.jobs.release.steps,after.workflow_definition.jobs.release.steps);
  assert.deepEqual(before.command_digests,after.command_digests,'existing production commands are retained');
  assert.deepEqual(gateFindings(after.source_yaml,before.source_yaml,{registeredPublisherTransition:true}),[]);
  assert.equal(registeredPublisherTransition(r,file,after.source_yaml,before.source_yaml).passed,true);
});

test('publisher Source: raw Git CRLF, whitespace, Unicode and unknown objects cannot borrow a registered LF identity',()=>{
  const r=registry(),p=source();
  for(const text of [p.source_yaml.replaceAll('\n','\r\n'),p.source_yaml+'\n',p.source_yaml+'# changed \u2603\n']) {
    assert.notEqual(workflowBlob(text),p.workflow_blob);
    assert.equal(registeredPublisherSource(r,file,text).passed,false);
  }
  assert.equal(registeredPublisherSource(r,'.github/workflows/unrelated.yml',p.source_yaml).passed,false);
  assert.equal(registeredPublisherSource(r,file,p.source_yaml,{repository:'other/repo'}).passed,false);
  assert.equal(registeredPublisherTransition(r,file,p.source_yaml,null).passed,false);
  assert.equal(registeredPublisherTransition(r,file,p.source_yaml,p.source_yaml).passed,false);
});

test('publisher Source: missing, duplicate, revoked, wrong digest and unrelated role registrations fail closed',()=>{
  const p=source();
  for(const mutate of [r=>r.schema='unrecognized',r=>r.default_branch='feature',r=>r.extra=true,
    r=>r.workflows[file].registration_status='revoked',r=>r.workflows[file].sources.push(structuredClone(p)),
    r=>r.workflows[file].sources.find(s=>s.gated).source_sha256='0'.repeat(64),
    r=>r.workflows[file].sources.find(s=>s.gated).source_yaml+='\n',
    r=>r.workflows[file].sources.find(s=>s.gated).purpose='unrelated',
    r=>r.workflows[file].sources.find(s=>s.gated).operation='install_workflow',
    r=>r.workflows[file].sources.find(s=>s.gated).workflow_definition.jobs.release.steps=[],
    r=>r.roles[file][p.workflow_blob][0].definition_sha256='0'.repeat(64),
    r=>r.roles[file][p.workflow_blob][0].job_id='other',r=>delete r.roles[file][p.workflow_blob],
    r=>r.roles[file][p.workflow_blob].push(structuredClone(r.roles[file][p.workflow_blob][0]))]) {
    const r=registry();mutate(r);assert.equal(registeredPublisherSource(r,file,p.source_yaml).passed,false);
  }
});

test('publisher compiler: dispatch-only, exact one-shot route, Owner/main gate and production environment are mandatory',()=>{
  const p=source(),original=p.workflow_definition;
  for(const mutate of [v=>v.on.pull_request={},v=>delete v.on.workflow_dispatch,
    v=>v.jobs.release['runs-on']=['self-hosted','Linux','X64'],v=>v.jobs.release['runs-on']='ubuntu-24.04',
    v=>v.jobs.release['runs-on'][4]="${{ inputs.runner }}",v=>v.jobs.release.if='true',
    v=>v.jobs.release.needs=[],v=>v.jobs.release.environment='unrestricted',
    v=>v.jobs.release.strategy={matrix:{os:['a','b']}},v=>v.jobs.release.uses='other.yml',
    v=>v.jobs.extra={steps:[]},v=>v.jobs.release['timeout-minutes']=46,
    v=>v.permissions.actions='write']) {
    const v=structuredClone(original);mutate(v);
    const accepted_roles=Object.keys(v.jobs).sort().map(job_id=>({job_id,definition_sha256:roleDefinitionDigest(v.jobs[job_id])}));
    assert.throws(()=>compilePublisherSource(file,p.source_yaml,{parseYaml:()=>v,accepted_roles}));
  }
  assert.throws(()=>compilePublisherSource(file,p.source_yaml,{parseYaml,accepted_roles:[]}));
  assert.throws(()=>compilePublisherSource('toString',p.source_yaml,{parseYaml,accepted_roles:roles(p.source_yaml)}));
});

test('publisher compiler: a synthetic qualification source cannot acquire an environment or Secrets',()=>{
  // Synthetic code-only fixture: no canary or production runner is registered.
  const qualifyFile='.github/workflows/clued-production-publisher-qualification.yml';
  const gate=workflowJobs(source().source_yaml).find(j=>j.name==='admission-gate').lines.join('\n');
  const text=`name: Qualification fixture\non:\n  workflow_dispatch:\n    inputs:\n      admission_run_id:\n        required: true\n        type: string\n      mode:\n        required: true\n        type: choice\n        options: [host-principal-probe, success, failure, cancel]\npermissions:\n  contents: read\njobs:\n${gate}\n  host-principal-probe:\n    needs: admission-gate\n    if: >-\n      ${PUBLISHER_PROBE_CONDITION}\n    runs-on: ${JSON.stringify(PUBLISHER_PROBE_LABELS)}\n    timeout-minutes: 5\n    steps:\n      - name: Synthetic Host probe\n        run: 'true'\n  qualify:\n    needs: admission-gate\n    if: >-\n      ${PUBLISHER_QUALIFY_CONDITION}\n    runs-on: ${JSON.stringify(PUBLISHER_LABELS)}\n    timeout-minutes: 12\n    steps:\n      - name: Synthetic canary\n        run: 'true'\n`;
  const qualificationRoles=roles;
  const accepted_roles=qualificationRoles(text),p=compilePublisherSource(qualifyFile,text,{parseYaml,accepted_roles});
  const r={schema:PUBLISHER_SOURCE_SCHEMA,repository:'tdoljyj/cross-memory-system',default_branch:'main',
    workflows:{[qualifyFile]:{registration_status:'registered',sources:[p]}},roles:{[qualifyFile]:{[p.workflow_blob]:accepted_roles}}};
  assert.equal(registeredPublisherTransition(r,qualifyFile,text,null).passed,true);
  assert.deepEqual(gateFindings(text,null),[]);
  for(const edit of [v=>v.replace('    timeout-minutes: 12\n    steps:', '    timeout-minutes: 12\n    environment: clued-release\n    steps:'),
    v=>v.replace("run: 'true'",'run: echo ${{ secrets.CLUED_RELEASE_TOKEN }}')]) {
    const altered=edit(text);assert.throws(()=>compilePublisherSource(qualifyFile,altered,{parseYaml,accepted_roles:qualificationRoles(altered)}));
  }
});
