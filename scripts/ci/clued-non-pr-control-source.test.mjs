import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {NON_PR_CONTROL_FILES,NON_PR_CONTROL_SOURCE_PATH,NON_PR_CONTROL_SOURCE_SCHEMA,
  parseNonPrControlCatalogue,classifyNonPrControlWorkflowSource} from './clued-non-pr-control-source.mjs';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
import {CONTROL_WORKFLOW_FILES,CONTROL_WORKFLOW_SOURCE_PATH,registeredControlWorkflowSource} from './clued-control-workflow-source.mjs';

const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const root=new URL('../../',import.meta.url),raw=fs.readFileSync(new URL('../../'+NON_PR_CONTROL_SOURCE_PATH,import.meta.url));
const load=()=>parseNonPrControlCatalogue(raw),hash=x=>createHash('sha256').update(x).digest('hex');
const files=Object.keys(NON_PR_CONTROL_FILES),source=file=>fs.readFileSync(new URL(file,root),'utf8');
const classify=(r,file=files[0],text=source(file),options)=>classifyNonPrControlWorkflowSource(r,file,text,options);
const refused=result=>{assert.equal(result.passed,false);assert.equal(result.execution_authority,false);assert.equal(result.host_qualified,false);};

test('three exact non-PR Sources independently parse their entire YAML and all twelve FullRoles',()=>{
  const r=load();assert.equal(r.schema,NON_PR_CONTROL_SOURCE_SCHEMA);assert.equal(files.length,3);
  assert.deepEqual([...files].sort(),['.github/workflows/clued-compute-panel.yml','.github/workflows/clued-front-main-merge.yml',
    '.github/workflows/clued-native617-admission-dispatch.yml']);
  for(const file of files){
    const text=source(file),definition=yaml.parse(text),entry=r.workflows[file],roles=r.roles[file],pin=NON_PR_CONTROL_FILES[file];
    assert.equal(workflowBlob(text),pin.workflow_blob);assert.equal(hash(text),pin.source_sha256);
    assert.equal(roleDefinitionDigest(definition),pin.workflow_definition_sha256);
    assert.deepEqual(definition,entry.workflow_definition);
    assert.equal(roles.length,file.endsWith('clued-compute-panel.yml')?8:2);
    assert.deepEqual(roles.map(role=>role.job_id).sort(),Object.keys(definition.jobs).sort());
    for(const role of roles){assert.deepEqual(role.definition,definition.jobs[role.job_id]);assert.equal(roleDefinitionDigest(role.definition),pin.roles[role.job_id]);}
    const result=classify(r,file,text);assert.equal(result.passed,true);assert.equal(result.pull_request_ci,false);
    assert.equal(result.execution_authority,false);assert.equal(result.host_qualified,false);
  }
});

test('classification neither accepts another family/path/repository nor manufactures Owner or runtime authority',()=>{
  const r=load();refused(classify(r,'.github/workflows/arbitrary-dispatch.yml',source(files[0])));
  refused(classify(r,files[0],source(files[0]),{repository:'other/repository'}));
  for(const edit of [x=>x.schema='other',x=>x.default_branch='feature',x=>x.purpose='run_jobs',
    x=>x.source_acceptance={receipt_id:'11111111-1111-4111-8111-111111111111'},x=>x.execution_authority=true,
    x=>x.workflows['.github/workflows/renamed.yml']=x.workflows[files[0]],x=>delete x.roles[files[1]]]){
    const changed=load();edit(changed);refused(classify(changed));
  }
});

test('the seven pre-existing controller families keep their separate exact Source contract',()=>{
  const old=JSON.parse(fs.readFileSync(new URL('../../'+CONTROL_WORKFLOW_SOURCE_PATH,import.meta.url)));
  const historical=Object.keys(CONTROL_WORKFLOW_FILES).filter(file=>file!=='.github/workflows/clued-merge-reconcile.yml');
  assert.equal(historical.length,7);
  for(const file of historical)for(const entry of old.workflows[file].sources){
    assert.equal(registeredControlWorkflowSource(old,file,entry.source_yaml).passed,true,file);
    refused(classify(load(),file,entry.source_yaml));
  }
});

test('whole Git bytes, gate, trigger and every other workflow byte remain exactly pinned',()=>{
  for(const file of files){const r=load(),text=source(file);
    for(const changed of [text+'\n',text.replace('admission-gate:','unknown-gate:'),text.replace('workflow_dispatch:','pull_request:'),
      text.replace(/timeout-minutes: (\d+)/,(_,minutes)=>`timeout-minutes: ${Number(minutes)+1}`)]){
      assert.notEqual(changed,text);refused(classify(r,file,changed));
    }
  }
});

test('a changed or partial entire family cannot borrow the still-valid requested row',()=>{
  for(const file of files)for(const edit of [
    x=>x.workflows[file].source_yaml_lines.push('altered'),x=>x.workflows[file].workflow_blob='a'.repeat(40),
    x=>x.workflows[file].source_sha256='a'.repeat(64),x=>x.workflows[file].workflow_definition_sha256='a'.repeat(64),
    x=>x.roles[file].pop(),x=>x.roles[file].push(x.roles[file][0]),x=>x.roles[file][0].job_id='invented',
    x=>x.workflows[file].workflow_definition.on.pull_request=null,
    x=>x.workflows[file].workflow_definition.jobs.invented={steps:[]},
  ]){const r=load();edit(r);refused(classify(r));}
});

test('each of the twelve FullRole definitions is independently pinned even after attacker-supplied hashes change',()=>{
  for(const file of files)for(let index=0;index<load().roles[file].length;index++){
    for(const kind of ['timeout','steps']){
      const r=load(),role=r.roles[file][index];
      if(kind==='timeout')role.definition['timeout-minutes']++;
      else role.definition.steps.reverse();
      role.definition_sha256=roleDefinitionDigest(role.definition);
      r.workflows[file].workflow_definition.jobs[role.job_id]=role.definition;
      r.workflows[file].workflow_definition_sha256=roleDefinitionDigest(r.workflows[file].workflow_definition);
      refused(classify(r,file));
    }
  }
});

test('role execution-step arrays retain order while JSON object member ordering has no authority',()=>{
  const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
  const r=reverse(load());for(const file of files)assert.equal(classify(r,file).passed,true);
});

test('malformed, duplicated, hidden, noncanonical and over-bound raw catalogues fail closed',()=>{
  for(const changed of [Buffer.from([0xff]),Buffer.alloc(524289),'{bad',JSON.stringify(load()),
    raw.toString().replace('"schema":','"schema":"wrong",\n"schema":'),raw.toString().replace('admission-gate','\\u0061dmission-gate')])
    assert.throws(()=>parseNonPrControlCatalogue(changed),/NON_PR_CONTROL_CATALOGUE_INVALID/);
});

test('foreign thrown errors never become returned diagnostics or execution grants',()=>{
  const secret={get message(){throw Error('DO_NOT_READ');},toString(){throw Error('DO_NOT_COERCE');}};
  const proxy=new Proxy(load(),{get(){throw secret;}});const r=classify(proxy);
  refused(r);assert.equal(r.reason,'non-PR Source integrity');
});
