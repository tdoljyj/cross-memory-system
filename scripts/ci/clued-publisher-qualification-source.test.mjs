import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {compilePublisherPrQualificationSource,registeredPublisherPrQualificationSource,registeredPublisherPrQualificationTransition,
  PUBLISHER_PR_QUALIFICATION_SCHEMA,PUBLISHER_PR_QUALIFICATION_FILES,PUBLISHER_PR_QUALIFICATION_CONDITION,
  PUBLISHER_PR_QUALIFICATION_PATH} from './clued-publisher-qualification-source.mjs';
import {roleDefinitionDigest,workflowBlob,compileRegisteredWorkflow} from './clued-workflow-profile.mjs';
import {workflowJobs,gateFindings} from './clued-work-admission.mjs';
import {ciWorkflows} from './clued-merge-slot-ci.mjs';
import {boundWorkflowCatalog} from './clued-gated-proof-runtime.mjs';
const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const parseYaml=text=>{const d=yaml.parseDocument(text,{uniqueKeys:true});if(d.errors.length)throw d.errors[0];return d.toJS({maxAliasCount:0});};
const prod=JSON.parse(fs.readFileSync(new URL('./clued-production-publisher-sources.json',import.meta.url),'utf8'));
const gate=workflowJobs(prod.workflows['.github/workflows/clued-cloud-production-release.yml'].sources.find(s=>s.gated).source_yaml)
  .find(j=>j.name==='admission-gate').lines.join('\n');
const roles=value=>Object.keys(value.jobs).sort().map(job_id=>({job_id,definition_sha256:roleDefinitionDigest(value.jobs[job_id])}));
const fixture=file=>{
  const d=PUBLISHER_PR_QUALIFICATION_FILES[file];
  const text=`name: Nonproduction PR qualification fixture\non:\n  pull_request:\n    branches: [main]\n    paths: [${file}]\npermissions:\n  contents: read\njobs:\n${gate}\n  ${d.primary}:\n    needs: admission-gate\n    if: >-\n      ${PUBLISHER_PR_QUALIFICATION_CONDITION}\n    runs-on: ${JSON.stringify(d.labels)}\n    timeout-minutes: ${d.minutes}\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          persist-credentials: false\n      - name: Synthetic qualification only\n        run: echo qualification\n`;
  const value=parseYaml(text),accepted_roles=roles(value),profile=compilePublisherPrQualificationSource(file,text,{parseYaml,accepted_roles});
  return {text,value,profile,accepted_roles,registry:{schema:PUBLISHER_PR_QUALIFICATION_SCHEMA,
    repository:'tdoljyj/cross-memory-system',default_branch:'main',
    workflows:{[file]:{registration_status:'registered',sources:[profile]}},roles:{[file]:{[profile.workflow_blob]:accepted_roles}}}};
};

test('PR qualification Source: each concrete role binds complete raw Source; it is qualification-only',()=>{
  for(const file of Object.keys(PUBLISHER_PR_QUALIFICATION_FILES)) {
    const f=fixture(file);
    assert.equal(f.profile.proof_classification,'qualification_only');
    assert.equal(registeredPublisherPrQualificationSource(f.registry,file,f.text).passed,true);
    assert.equal(registeredPublisherPrQualificationTransition(f.registry,file,f.text,null).passed,true);
    assert.deepEqual(gateFindings(f.text,null),[]);
    for(const text of [f.text+'\n',f.text.replaceAll('\n','\r\n'),f.text+'# other \u2603'])
      assert.equal(registeredPublisherPrQualificationSource(f.registry,file,text).passed,false);
    assert.equal(registeredPublisherPrQualificationTransition(f.registry,file,f.text,f.text+'\n').passed,false);
    assert.equal(registeredPublisherPrQualificationSource(f.registry,file,f.text,{repository:'other/repo'}).passed,false);
  }
});

test('PR qualification compiler refuses forks/dispatch/other branches, generic runners, Secrets and arbitrary checkout even with recompiled roles',()=>{
  for(const file of Object.keys(PUBLISHER_PR_QUALIFICATION_FILES)) {
    const f=fixture(file),id=f.profile.primary_ids[0];
    for(const mutate of [v=>v.on.workflow_dispatch={},v=>v.on.pull_request.branches=['other'],
      v=>v.on.pull_request.paths=['**'],v=>v.jobs[id].if="needs.admission-gate.outputs.admitted == 'true'",
      v=>v.jobs[id]['runs-on']=['self-hosted','Linux','X64'],v=>v.jobs[id]['runs-on']='ubuntu-24.04',
      v=>v.jobs[id].environment='clued-release',v=>v.jobs[id].strategy={matrix:{case:['success','failure']}},
      v=>v.jobs[id]['timeout-minutes']=30,v=>v.permissions.actions='write',
      v=>v.jobs[id].steps[0].with.ref='main',v=>v.jobs[id].steps[0].with['persist-credentials']=true,
      v=>v.jobs.extra={steps:[]},v=>v.jobs['admission-gate'].if='true']) {
      const value=structuredClone(f.value);mutate(value);
      assert.throws(()=>compilePublisherPrQualificationSource(file,f.text,{parseYaml:()=>value,accepted_roles:roles(value)}));
    }
    const secret=f.text.replace('echo qualification','echo ${{ secrets.CLUED_TOKEN }}');
    assert.throws(()=>compilePublisherPrQualificationSource(file,secret,{parseYaml,accepted_roles:roles(parseYaml(secret))}));
  }
});

test('PR qualification catalogue refuses missing/revoked/ambiguous Sources and roles',()=>{
  const file=Object.keys(PUBLISHER_PR_QUALIFICATION_FILES)[0],f=fixture(file);
  for(const edit of [r=>r.schema='other',r=>r.default_branch='other',r=>r.extra=true,
    r=>r.workflows[file].registration_status='revoked',r=>r.workflows[file].sources.push(structuredClone(f.profile)),
    r=>r.workflows[file].sources[0].purpose='work_handover_consumer_qualification',
    r=>r.workflows[file].sources[0].proof_classification='required_CI',
    r=>r.roles[file][f.profile.workflow_blob][0].definition_sha256='0'.repeat(64)]) {
    const registry=structuredClone(f.registry);edit(registry);
    assert.equal(registeredPublisherPrQualificationSource(registry,file,f.text).passed,false);
  }
});

test('default PR test enumeration excludes only exact independently registered qualification Sources',()=>{
  const file=Object.keys(PUBLISHER_PR_QUALIFICATION_FILES)[0],f=fixture(file),name=file.split('/').at(-1);
  const read=(p)=>Buffer.from(p.replaceAll('\\','/').endsWith(PUBLISHER_PR_QUALIFICATION_PATH)?JSON.stringify(f.registry):f.text);
  assert.equal(ciWorkflows('/trusted',()=>[name],read).size,0);
  assert.throws(()=>ciWorkflows('/trusted',()=>[name],p=>Buffer.from(p.replaceAll('\\','/').endsWith(PUBLISHER_PR_QUALIFICATION_PATH)?'{}':f.text)));
  assert.throws(()=>ciWorkflows('/trusted',()=>[name],p=>Buffer.from(p.replaceAll('\\','/').endsWith(PUBLISHER_PR_QUALIFICATION_PATH)?JSON.stringify(f.registry):f.text+'\n')));
});

test('complete catalogue keeps required application CI and separately admits exact qualification installation',async()=>{
  const qfile=Object.keys(PUBLISHER_PR_QUALIFICATION_FILES)[1],f=fixture(qfile),file='.github/workflows/application.yml';
  const text='name: App\non:\n  pull_request:\njobs:\n  main:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo application\n';
  const value=parseYaml(text),accepted_roles=roles(value),profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml,accepted_roles});
  const registry={schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}};
  const roleSpecs={schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:accepted_roles}}}};
  const tip='a'.repeat(40),head='b'.repeat(40),repository='tdoljyj/cross-memory-system';
  const call=async(qualificationRegistry=f.registry,candidate=f.text)=>{
    const read=async route=>route.includes('/contents/.github/workflows?')?
      [{type:'file',path:file,sha:profile.workflow_blob},...route.includes('ref='+head)?[{type:'file',path:qfile,sha:workflowBlob(candidate)}]:[]]:
      {type:'file',path:qfile,sha:workflowBlob(candidate),encoding:'base64',size:Buffer.byteLength(candidate),content:Buffer.from(candidate).toString('base64')};
    return boundWorkflowCatalog({read,repository,tip,head,defaultWorkflows:new Map([[file,profile.workflow_blob]]),registry,roleSpecs,
      qualificationRegistry,diff:{passed:true,diffComplete:true,commits:1,changedFiles:[qfile],descriptor:{repository,head,default_branch:'main'}}});
  };
  const accepted=await call();assert.equal(accepted.passed,true,accepted.reason);
  assert.deepEqual([...accepted.workflows.keys()],[file]);
  assert.deepEqual(accepted.qualification_transitions.map(x=>[x.file,x.proof_classification]),[[qfile,'qualification_only']]);
  assert.equal((await call(null)).passed,false);
  assert.equal((await call(f.registry,f.text+'\n')).passed,false);
});
