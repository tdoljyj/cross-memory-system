import assert from 'node:assert/strict';
import {restoreRetiredEntries} from './fixtures/retired-gated-proof-catalogue.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scannerMatches,assertRegistryScannerClean,REGISTRY_FILES,MAX_LINE_CHARS} from './clued-registry-scan-guard.mjs';
import {decodeWorkflowProfiles,encodeWorkflowProfiles,parseWorkflowProfiles,serializeWorkflowProfiles,
  registeredWorkflowSource,rolesForSource,roleDefinitionDigest,workflowBlob,
  REQUIRED_TESTS_SOURCE,
  WORKFLOW_PROFILES_MAX_BYTES,WORKFLOW_SOURCE_MAX_BYTES,WORKFLOW_SOURCE_MAX_LINES,
  WORKFLOW_SOURCE_MAX_LINE_BYTES} from './clued-workflow-profile.mjs';

const require=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url));
const yaml=require('yaml');
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=()=>parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url)));
const specs=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url)));
const fixture=(text='name: codec-fixture\n')=>({schema:'clued.gated-proof-profiles/2',workflows:{
  '.github/workflows/fixture.yml':{source_yaml:text,workflow_blob:workflowBlob(text),source_sha256:hash(text)}}});
const root=r=>r.workflows['.github/workflows/fixture.yml'];
const bad=fn=>assert.throws(fn,e=>e?.message==='WORKFLOW_PROFILES_CODEC_INVALID'&&e.code==='WORKFLOW_PROFILES_CODEC_INVALID');
function sources(v,path=[],out=[]) {
  if(Array.isArray(v))v.forEach((x,i)=>sources(x,[...path,i],out));
  else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)) {
    if(k==='source_yaml')out.push({path,row:v,text:x});else sources(x,[...path,k],out);
  }
  return out;
}

test('all original sources and complete successors roundtrip without losing bytes, roles or metadata',()=>{
  const semantic=read(),wire=encodeWorkflowProfiles(semantic),text=serializeWorkflowProfiles(semantic);
  const decoded=parseWorkflowProfiles(Buffer.from(text));
  assert.deepEqual(decoded,semantic);
  assert.equal(wire.schema,'clued.gated-proof-profiles/3');
  assert.equal(decoded.schema,'clued.gated-proof-profiles/2');
  assert.equal(sources(decoded).length,55);
  // The original catalogue still registered the ten workflows deleted later; restore them before comparing it.
  const original=structuredClone(decoded),oldRoles=structuredClone(specs);
  assert.equal(restoreRetiredEntries(original,oldRoles).length,10);
  assert.equal(sources(original).length,75);
  delete original.workflows[REQUIRED_TESTS_SOURCE.file];
  // Resident ADR 0032 step 2: the Windows side of the required tests is a later, additive Source with one primary.
  // The current Source exports the trusted base from the local candidate object store (Task 04f9b91b).
  const WINDOWS='.github/workflows/clued-required-tests-windows.yml';
  const WINDOWS_BLOB=workflowBlob(fs.readFileSync(new URL('../../'+WINDOWS,import.meta.url),'utf8'));
  assert.equal(original.workflows[WINDOWS].workflow_blob,WINDOWS_BLOB);assert.deepEqual(original.workflows[WINDOWS].primary_ids,['ci-suites-windows']);
  assert.equal(Object.hasOwn(original.workflows[WINDOWS],'execution_mode'),false);delete original.workflows[WINDOWS];
  const G4='.github/workflows/clued-g4-database.yml',G4_BLOB='d7876890a4df616fddae675c4d66737a70eb7045';
  assert.equal(original.workflows[G4].accepted_sources.filter(source=>source.workflow_blob===G4_BLOB).length,1);
  original.workflows[G4].accepted_sources=original.workflows[G4].accepted_sources.filter(source=>source.workflow_blob!==G4_BLOB);
  // Native automation adds exactly one complete successor, preserving the
  // immutable original catalogue and its role digest after removing it here.
  const G4_AUTOMATION='9d81933776a2646bdf0ff77f6ee2621cda551ec2';
  const automation=original.workflows[G4].accepted_sources.filter(source=>source.workflow_blob===G4_AUTOMATION);
  assert.equal(automation.length,1);
  const automationRoles=oldRoles.workflows[G4].sources[G4_AUTOMATION];
  assert.equal(automationRoles.length,2);
  const automationDefinition=yaml.parse(automation[0].source_yaml);
  assert.equal(workflowBlob(automation[0].source_yaml),G4_AUTOMATION);
  for(const role of automationRoles)assert.equal(roleDefinitionDigest(automationDefinition.jobs[role.job_id]),role.definition_sha256);
  original.workflows[G4].accepted_sources=original.workflows[G4].accepted_sources.filter(source=>source.workflow_blob!==G4_AUTOMATION);
  delete oldRoles.workflows[G4].sources[G4_AUTOMATION];
  const successor=original.workflows['.github/workflows/gitleaks.yml'].accepted_sources
    .filter(source=>source.workflow_blob==='6441fc32b084002de697415ea8343af07816c929');
  assert.equal(successor.length,1);
  assert.equal(successor[0].source_sha256,'116e6b201e30251b0f702ff4416dcfd015d2b311cbd2f000cdcd3e81e6d29966');
  original.workflows['.github/workflows/gitleaks.yml'].accepted_sources=original.workflows['.github/workflows/gitleaks.yml'].accepted_sources
    .filter(source=>source.workflow_blob!=='6441fc32b084002de697415ea8343af07816c929');
  // #988: the Linux managed-cache successor of the Node 22 install workflow is a later accepted source, not an original one.
  const NODE22='.github/workflows/clued-cloud-node22-install.yml',NODE22_BLOB='30e783feb7ab54a578b5ed3b692fa664e00207d1';
  assert.equal(original.workflows[NODE22].accepted_sources.filter(source=>source.workflow_blob===NODE22_BLOB).length,1);
  original.workflows[NODE22].accepted_sources=original.workflows[NODE22].accepted_sources.filter(source=>source.workflow_blob!==NODE22_BLOB);
  // #1217 R2b: three gated workflows lost their main push trigger; each new byte form is a later additive Source with the
  // roles of the entry it follows, and is the workflow on disk; strip it like the other later successors.
  const NO_PUSH=[['.github/workflows/clued-cloud-node22-install.yml','a07a290c763654a7aaa749a1c2088d484afc4eed'],
    ['.github/workflows/design-refs.yml','0d5575fdabf9f2e811b893d6a09eb4b36d2e7600'],
    ['.github/workflows/model-program-m2-scoped-consumer.yml','da6c77d5758f8f3e7a124fc3ab667fceebe235f8']];
  for(const [file,blob] of NO_PUSH) {
    const added=original.workflows[file].accepted_sources.filter(source=>source.workflow_blob===blob);
    assert.equal(added.length,1,file);
    assert.equal(workflowBlob(fs.readFileSync(new URL(`../../${file}`,import.meta.url),'utf8')),blob,file);
    original.workflows[file].accepted_sources=original.workflows[file].accepted_sources.filter(source=>source.workflow_blob!==blob);
  }
  assert.equal(sources(original).length,66);
  assert.equal(roleDefinitionDigest(original),'9d6b910708b3d447bde534d883d0d6ca27a3a62ee42c9bc422abaa0951487a42');
  delete oldRoles.workflows[REQUIRED_TESTS_SOURCE.file];
  assert.deepEqual(oldRoles.workflows[WINDOWS].sources[WINDOWS_BLOB].map(role=>[role.job_id,role.definition_sha256]),
    [['ci-suites-windows','c8bc308ea776a71fa3be756725ab530c4db2d37c25ffd0af5f5acefcb726f7c1']]);
  delete oldRoles.workflows[WINDOWS];
  assert.ok(oldRoles.workflows[G4].sources[G4_BLOB]);
  delete oldRoles.workflows[G4].sources[G4_BLOB];
  assert.equal(oldRoles.workflows['.github/workflows/gitleaks.yml'].sources['6441fc32b084002de697415ea8343af07816c929'][0]
    .definition_sha256,'9dd1c58aa9a60dce0a079158bd0ce3ac47b93626854c85672e9c217f5a623caf');
  delete oldRoles.workflows['.github/workflows/gitleaks.yml'].sources['6441fc32b084002de697415ea8343af07816c929'];
  assert.equal(oldRoles.workflows[NODE22].sources[NODE22_BLOB].length,2);
  delete oldRoles.workflows[NODE22].sources[NODE22_BLOB];
  for(const [file,blob] of NO_PUSH) {
    assert.ok(Array.isArray(oldRoles.workflows[file].sources[blob])&&oldRoles.workflows[file].sources[blob].length>0,file);
    delete oldRoles.workflows[file].sources[blob];
  }
  assert.equal(roleDefinitionDigest(oldRoles),'4e8f58e671141c58eb28184f477aa7d3639556eef35b9c340ccde6b76a16aa29');
  assert.ok(Buffer.byteLength(text)<=WORKFLOW_PROFILES_MAX_BYTES);
  assert.notEqual(hash(text),hash(JSON.stringify(semantic,null,2)+'\n'),'disk Source identity changes');
  for(const {path,row,text:source} of sources(decoded)) {
    assert.equal(workflowBlob(source),row.workflow_blob);
    assert.equal(hash(source),row.source_sha256);
    const file=path[0]==='workflows'?path[1]:row.file;
    const roles=path[0]==='native617_pending_sources'
      ?specs.native617_pending_sources.find(x=>x.file===file&&x.workflow_blob===row.workflow_blob)?.roles
      :rolesForSource(specs,file,row.workflow_blob);
    assert.ok(Array.isArray(roles)&&roles.length>0);
    const definition=yaml.parse(source);
    for(const role of roles)assert.equal(roleDefinitionDigest(definition.jobs[role.job_id]),role.definition_sha256);
  }
});

test('deterministic /3 disk form keeps blank lines, leading/trailing whitespace and terminal empty string',()=>{
  for(const source of ['', '\n', '  leading\ntrailing  \n\n', 'a\tb\nlast']) {
    const semantic=fixture(source),wire=encodeWorkflowProfiles(semantic);
    assert.deepEqual(root(wire).source_yaml_lines,source.split('\n'));
    assert.equal(root(parseWorkflowProfiles(serializeWorkflowProfiles(semantic))).source_yaml,source);
    assert.equal(decodeWorkflowProfiles(semantic),semantic,'historical semantic identity stays reference-stable');
    const reversed=Object.fromEntries(Object.entries(semantic).reverse());
    assert.equal(serializeWorkflowProfiles(reversed),serializeWorkflowProfiles(semantic));
  }
  const disk=serializeWorkflowProfiles(fixture('first\nsecond\n'));
  assert.ok(disk.includes('\n"first",\n"second",\n""\n'));
  assert.ok(disk.endsWith('\n'));
});

test('historical /2 remains readable and runtime boundaries decode /3 before original blob/SHA checks',()=>{
  const semantic=read(),wire=encodeWorkflowProfiles(semantic);
  assert.deepEqual(parseWorkflowProfiles(JSON.stringify(semantic)),semantic);
  const file='.github/workflows/gitleaks.yml',blob=semantic.workflows[file].accepted_sources[5].workflow_blob;
  assert.equal(registeredWorkflowSource(wire,file,blob).passed,true);
  const altered=structuredClone(wire);altered.workflows[file].accepted_sources[5].source_yaml_lines[0]+=' changed';
  assert.equal(registeredWorkflowSource(altered,file,blob).passed,false);
});

test('/3 rejects mixed, omitted, unknown, noncanonical and malformed source representations',()=>{
  for(const edit of [
    x=>{root(x).source_yaml='conflict';},x=>{delete root(x).source_yaml_lines;},
    x=>{root(x).source_yaml_lines='not-an-array';},x=>{root(x).source_yaml_lines=[];},
    x=>{root(x).source_yaml_lines=[null];},x=>{root(x).source_yaml_lines=['a\nb'];},
    x=>{root(x).source_yaml_lines=['a\rb'];},x=>{root(x).source_yaml_lines=['a\0b'];},
    x=>{root(x).source_yaml_lines=Array(2);},x=>{root(x).source_yaml_lines.extra='not-a-line';},
    x=>{x.extra='unknown';},x=>{x.schema='clued.gated-proof-profiles/4';},
    x=>{root(x).extra='unknown-profile-field';},x=>{x.future_workflows={};},
    x=>{root(x).accepted_sources={};},x=>{x.audit_source='not-a-source-commit';},
    x=>{x.untrusted={source_yaml_lines:['hidden']};}
  ]) {const wire=encodeWorkflowProfiles(fixture());edit(wire);bad(()=>decodeWorkflowProfiles(wire));}
  const legacy=fixture();root(legacy).source_yaml_lines=['mixed'];bad(()=>decodeWorkflowProfiles(legacy));
  const canonical=serializeWorkflowProfiles(fixture('curl fixture\n'));
  bad(()=>parseWorkflowProfiles(JSON.stringify(JSON.parse(canonical))));
  bad(()=>parseWorkflowProfiles(canonical.replace('curl fixture','\\u0063url fixture')));
  bad(()=>parseWorkflowProfiles(canonical.replace('"schema":','"schema":"clued.gated-proof-profiles/3",\n"schema":')));
  bad(()=>parseWorkflowProfiles(Buffer.from([0xff])));
  bad(()=>parseWorkflowProfiles('{malformed'));
});

test('the new mode field is admitted only for the full exact required-tests Source projection',()=>{
  const semantic=read(),wire=encodeWorkflowProfiles(semantic);
  assert.equal(registeredWorkflowSource(wire,REQUIRED_TESTS_SOURCE.file,REQUIRED_TESTS_SOURCE.workflow_blob).passed,true);
  for(const edit of [
    p=>p.execution_mode='alternative',p=>p.workflow_blob='a'.repeat(40),p=>p.source_sha256='b'.repeat(64),
    p=>p.routes[0].command_digests['Select suites'][0]='c'.repeat(64),p=>p.primary_ids.pop(),
    p=>p.source_yaml_lines[0]+=' changed'
  ]){const altered=structuredClone(wire);edit(altered.workflows[REQUIRED_TESTS_SOURCE.file]);bad(()=>decodeWorkflowProfiles(altered));}
  const moved=structuredClone(wire);moved.workflows['.github/workflows/other.yml']=moved.workflows[REQUIRED_TESTS_SOURCE.file];
  delete moved.workflows[REQUIRED_TESTS_SOURCE.file];bad(()=>decodeWorkflowProfiles(moved));
  const ordinary=fixture();root(ordinary).execution_mode='all_required_primaries';bad(()=>encodeWorkflowProfiles(ordinary));
});

test('source line/count/aggregate bounds and disk byte ceiling are fail-closed',()=>{
  bad(()=>encodeWorkflowProfiles(fixture('x'.repeat(WORKFLOW_SOURCE_MAX_LINE_BYTES+1))));
  bad(()=>encodeWorkflowProfiles(fixture('\n'.repeat(WORKFLOW_SOURCE_MAX_LINES))));
  bad(()=>encodeWorkflowProfiles(fixture(('x'.repeat(65535)+'\n').repeat(9))));
  assert.ok(WORKFLOW_SOURCE_MAX_BYTES===524288);
  bad(()=>parseWorkflowProfiles(Buffer.alloc(WORKFLOW_PROFILES_MAX_BYTES+1,32)));
  const huge=fixture();huge.audit_source='x'.repeat(WORKFLOW_PROFILES_MAX_BYTES);bad(()=>serializeWorkflowProfiles(huge));
});

test('foreign accessors, proxies and thrown values cannot expose errors or execute a field getter',()=>{
  let getters=0,coercions=0;
  const foreign={get code(){getters++;return 'FOREIGN_SECRET';},toString(){coercions++;return 'FOREIGN_SECRET';}};
  const getter=fixture();Object.defineProperty(root(getter),'source_yaml',{get(){getters++;throw foreign;},enumerable:true});
  bad(()=>decodeWorkflowProfiles(getter));
  for(const trap of ['getOwnPropertyDescriptor','getPrototypeOf','ownKeys']) {
    const proxy=new Proxy(fixture(),{[trap](){throw foreign;}});bad(()=>decodeWorkflowProfiles(proxy));
  }
  assert.equal(getters,0);assert.equal(coercions,0);
});

// Public upstream v8.30.1 rule, unchanged. JS terminal $ is used only for this
// bounded offline regex experiment (no scanner, rule change or live evidence).
const CURL_AUTH_USER=/\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)(?:=|[ \t]{0,5})("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${}@.-]+)))(?:\s|$)/g;
const detections=text=>[...text.matchAll(new RegExp(CURL_AUTH_USER.source,'g'))];
test('two escaped-long-line false positives disappear only in the transparent current disk form',()=>{
  const semantic=read();
  for(const [file,index] of [['gitleaks',5],['trivy',3]]) {
    const row=semantic.workflows['.github/workflows/'+file+'.yml'].accepted_sources[index];
    const oldLine=JSON.stringify({source_yaml:row.source_yaml});
    const legacy=detections(oldLine);
    assert.equal(legacy.length,1);assert.equal(/^\d+:\d+$/.test(legacy[0][1]),true);
    assert.equal(detections(row.source_yaml).length,0);
  }
  assert.equal(detections(serializeWorkflowProfiles(semantic)).length,0);
});

test('literal credential structure remains visible and detectable in /3 plaintext lines',()=>{
  // Fabricated input, never an account or a real secret. Assemble it as test
  // data to avoid registering this adversarial fixture as an actual credential.
  const synthetic=['curl','-u',['fixture-identity','fixture-auth-value'].join(':'),'https://invalid.example'].join(' ');
  assert.equal(detections(synthetic).length,1);
  const disk=serializeWorkflowProfiles(fixture(synthetic+'\n'));
  assert.equal(detections(disk).length,1);
  assert.equal(root(parseWorkflowProfiles(disk)).source_yaml,synthetic+'\n');
});

// Task b7765949: registering a gitleaks.yml Source must not add a gitleaks finding. The upstream
// rules are run over the exact bytes of both registries (clued-registry-scan-guard.mjs), never
// relaxed, never allow-listed; a registration that would loop is refused before it is committed.
// This file is itself scanned: the download command's name is assembled from parts so that no
// fixture here puts it within reach of a user option (the guard's own rule would flag this file).
const CMD=['cur','l'].join('');
const RULE_USER=CMD+'-auth-user',RULE_HEADER=CMD+'-auth-header';
const GITLEAKS_YML='.github/workflows/gitleaks.yml';
const DOCKER_USER='docker run --user=65532:65532 image';
const registryText=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
const REPIN=/\b[0-9a-f]{64}\b/g;
const repin=(text,tag)=>text.replace(REPIN,h=>hash(tag+h));
// The newest registered gitleaks.yml Source and its Roles are the template of the next registration, so
// this keeps working after the next successor is registered.
function template() {
  const rows=read().workflows[GITLEAKS_YML].accepted_sources;
  const live=workflowBlob(fs.readFileSync(new URL('../../.github/workflows/gitleaks.yml',import.meta.url),'utf8').replace(/\r\n/g,'\n'));
  // The registered form of the workflow as it is on disk; before its registration lands, the newest registered one.
  const row=rows.find(source=>source.workflow_blob===live)??rows.at(-1);
  assert.equal(row.registration_status,'registered');
  assert.ok(Array.isArray(specs.workflows[GITLEAKS_YML].sources[row.workflow_blob]));
  return row;
}
// The registration commit's two registry files with `successorText` registered as a new accepted Source of
// gitleaks.yml, built the way the registrations are: the semantic profile re-serialized (/3), the role
// specs re-written as JSON with two-space indent.
function registerSuccessor(successorText,tag='repin') {
  const semantic=read(),entry=semantic.workflows[GITLEAKS_YML];
  const last=template();
  const blob=workflowBlob(successorText);
  entry.accepted_sources.push({...structuredClone(last),source_yaml:successorText,workflow_blob:blob,
    source_sha256:hash(successorText)});
  const roles=structuredClone(specs),sources=roles.workflows[GITLEAKS_YML].sources;
  sources[blob]=structuredClone(sources[last.workflow_blob]).map(role=>{
    const definition=JSON.parse(repin(JSON.stringify(role.definition),tag));
    return {...role,definition,definition_sha256:roleDefinitionDigest(definition)};
  });
  return {profiles:serializeWorkflowProfiles(semantic),roleSpecs:JSON.stringify(roles,null,2)+'\n',blob};
}
const withGap=(gap,option=DOCKER_USER)=>[CMD+' -fsS https://invalid.example -o /dev/null',...Array(gap).fill('x'),option].join('\n');

test('the committed registries carry no upstream download-command auth match',()=>{
  const profiles=registryText('./clued-gated-proof-profiles.json'),roleSpecs=registryText('./clued-gated-proof-role-specs.json');
  assert.deepEqual(scannerMatches(profiles),[]);
  assert.deepEqual(scannerMatches(roleSpecs),[]);
  assertRegistryScannerClean({profiles,roleSpecs});
  assert.deepEqual(REGISTRY_FILES,['scripts/ci/clued-gated-proof-profiles.json','scripts/ci/clued-gated-proof-role-specs.json']);
});

test('registering the hosted gitleaks.yml successor (repinned scan inputs) leaves both registries gitleaks-clean',()=>{
  const last=template();
  const successor=repin(last.source_yaml,'repin');
  assert.ok(last.source_yaml.match(REPIN).length>=5,'the repin changes the scan input pins');
  assert.notEqual(successor,last.source_yaml);
  const registered=registerSuccessor(successor);
  assert.notEqual(registered.blob,last.workflow_blob);
  // The workflow's own shape: the download command and the docker user option are in the Source, only the
  // registered form decides whether they match.
  assert.match(successor,new RegExp('\\b'+CMD+'\\b'));assert.match(successor,/--user=65532:65532/);
  assert.deepEqual(scannerMatches(registered.profiles),[]);
  assert.deepEqual(scannerMatches(registered.roleSpecs),[]);
  assertRegistryScannerClean({profiles:registered.profiles,roleSpecs:registered.roleSpecs});
  // The registered form round-trips: what is committed is what the readers decode.
  const source=registeredWorkflowSource(parseWorkflowProfiles(registered.profiles),GITLEAKS_YML,registered.blob);
  assert.equal(source.passed,true);assert.equal(source.profile.source_yaml,successor);
  assert.equal(rolesForSource(JSON.parse(registered.roleSpecs),GITLEAKS_YML,registered.blob).length,last.primary_ids.length);
});

test('the same Source embedded as one escaped JSON line is exactly what looped before /3, and the guard reports it',()=>{
  const successor=repin(template().source_yaml,'repin');
  const oneLine=JSON.stringify({source_yaml:successor});
  assert.ok(scannerMatches(oneLine).length>=1,'legacy single-line form matches an upstream rule');
  assert.throws(()=>assertRegistryScannerClean({'legacy.json':oneLine}),e=>e.code==='REGISTRY_SCANNER_MATCH'&&
    e.findings.every(f=>f.file==='legacy.json'&&Number.isSafeInteger(f.line))&&!e.message.includes('65532'));
});

test('the user rule reaches exactly five lines after the command: 5 newlines match, 6 do not',()=>{
  // Boundary measured against the pinned scanner image (v8.30.1) as well, see the registration notes.
  assert.deepEqual(scannerMatches(withGap(0)),[{rule:RULE_USER,line:1}]);
  assert.deepEqual(scannerMatches(withGap(4)),[{rule:RULE_USER,line:1}]);
  assert.deepEqual(scannerMatches(withGap(5)),[]);
  assert.deepEqual(scannerMatches(withGap(8)),[]);
  // Same line, either spelling of the option, and the short form.
  for(const option of ['--user=65532:65532','--user 65532:65532','-u 65532:65532'])
    assert.deepEqual(scannerMatches(`${CMD} -fsS https://invalid.example ${option} `).map(m=>m.rule),[RULE_USER]);
  // Go's `.` takes every character but LF, JS's also stops at CR and U+2028.
  assert.deepEqual(scannerMatches(`${CMD} x\u2028 ${DOCKER_USER}`).map(m=>m.rule),[RULE_USER]);
  assert.deepEqual(scannerMatches(`${CMD} x\r ${DOCKER_USER}`).map(m=>m.rule),[RULE_USER]);
});

test('the header rule is part of the guard',()=>{
  const bearer=`${CMD} -fsS -H 'Authorization: Bearer abcdefgh12345678' https://invalid.example\n`;
  assert.deepEqual(scannerMatches(bearer),[{rule:RULE_HEADER,line:1}]);
  assert.deepEqual(scannerMatches(`${CMD} -fsS \\\n  -H 'Authorization: Bearer abcdefgh12345678' \\\n  https://invalid.example\n`),[{rule:RULE_HEADER,line:1}]);
  assert.deepEqual(scannerMatches(`${CMD} -fsS -H "authorization: bearer abcdefgh12345678" https://invalid.example
`),[{rule:RULE_HEADER,line:1}]);
  // Variable references are not values: the registered Sources' own header lines stay clean.
  assert.deepEqual(scannerMatches(`${CMD} -fsS -H "Authorization: Bearer $TOKEN" https://invalid.example\n`),[]);
  assert.throws(()=>assertRegistryScannerClean({'h.json':bearer}),e=>e.findings[0].rule===RULE_HEADER);
  assert.throws(()=>assertRegistryScannerClean({'long.json':(CMD+' ').repeat(70000)}),e=>/scan limit/.test(e.message)&&!/registration loop/.test(e.message));
});

test('a Source whose download command and --user option are within five lines is refused, not registered by ignore',()=>{
  // Fabricated, non-credential text. The pair is a numeric docker uid:gid.
  const base=template().source_yaml;
  const near=registerSuccessor(base+'\n# near\n'+withGap(2)+'\n','near');
  assert.ok(scannerMatches(near.profiles).some(m=>m.rule===RULE_USER));
  assert.throws(()=>assertRegistryScannerClean({profiles:near.profiles}),e=>e instanceof Error&&e.code==='REGISTRY_SCANNER_MATCH');
  // The same pair six lines apart in /3 profile lines is not a match.
  assert.deepEqual(scannerMatches(registerSuccessor(base+'\n# far\n'+withGap(5)+'\n','far').profiles),[]);
});

test('role specs keep one escaped line per run step, so the pair in one step is refused whatever the distance',()=>{
  const roles=structuredClone(specs),sources=roles.workflows[GITLEAKS_YML].sources;
  const job=structuredClone(sources[template().workflow_blob][0]);
  const step=job.definition.steps.find(s=>typeof s.run==='string');
  // An escaped `\n` + name has no word boundary before the name, so the command follows `&&` as scripts write it.
  step.run=step.run+'\ntrue && '+withGap(20)+'\n';
  sources['0000000000000000000000000000000000000001']=[job];
  const text=JSON.stringify(roles,null,2)+'\n';
  assert.ok(scannerMatches(text).some(m=>m.rule===RULE_USER),'one-line run text is within the rule reach');
  assert.throws(()=>assertRegistryScannerClean({roleSpecs:text}),e=>e.code==='REGISTRY_SCANNER_MATCH');
  // The same two commands in different run steps are separate JSON lines, more than five apart.
  const split=structuredClone(roles);
  const parts=split.workflows[GITLEAKS_YML].sources['0000000000000000000000000000000000000001'][0];
  const target=parts.definition.steps.find(s=>typeof s.run==='string');
  const cut=target.run.indexOf(DOCKER_USER);
  const tail=target.run.slice(cut);
  target.run=target.run.slice(0,cut);
  parts.definition.steps.push({name:'a'},{name:'b'},{name:'c'},{name:'d'},{name:'e'},{name:'second',run:tail});
  assert.deepEqual(scannerMatches(JSON.stringify(split,null,2)+'\n').filter(m=>m.rule===RULE_USER),[]);
});

test('a line too long to scan in bounded time is refused outright',()=>{
  const line=(CMD+' ').repeat(70000);
  assert.ok(line.length>MAX_LINE_CHARS);
  assert.deepEqual(scannerMatches('ok\n'+line+'\n'),[{rule:'line-too-long',line:2}]);
});

test('no reviewed fingerprint or ignore entry covers a registry file except the three historical /2 findings',()=>{
  const toml=fs.readFileSync(new URL('../../.gitleaks.toml',import.meta.url),'utf8');
  const entries=[...toml.matchAll(/^# clued-reviewed-finding: (\{.*\})$/gm)].map(m=>JSON.parse(m[1]).fingerprint)
    .filter(fp=>/clued-gated-proof-(profiles|role-specs)\.json/.test(fp)).sort();
  const registry='scripts/ci/clued-gated-proof-profiles.json';
  assert.deepEqual(entries,[
    `cc353e29a32b991696df95d5fc3f9b9d107e8d1c:${registry}:${RULE_USER}:3829`,
    `cc353e29a32b991696df95d5fc3f9b9d107e8d1c:${registry}:${RULE_USER}:5538`,
    `d94cd486e29a7362888fc32cd807ceb38890acb6:${registry}:${RULE_USER}:3829`]);
  const ignore=fs.readFileSync(new URL('../../.gitleaksignore',import.meta.url),'utf8');
  assert.doesNotMatch(ignore,/clued-gated-proof-(profiles|role-specs)/);
  // The rules themselves stay the default set: no allowlist may name the registries or the rules.
  assert.doesNotMatch(toml.replace(/^#.*$/gm,''),new RegExp('clued-gated-proof|'+CMD+'-auth'));
});

test('the guard command exits 1 with the rule and line for a looping file and 0 for the registries',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scan-guard-'));
  try {
    const bad=path.join(dir,'bad.json');
    fs.writeFileSync(bad,JSON.stringify({source_yaml:`${CMD} -fsS https://invalid.example && ${DOCKER_USER}\n`},null,1));
    const guard=fileURLToPath(new URL('./clued-registry-scan-guard.mjs',import.meta.url));
    const failed=spawnSync(process.execPath,[guard,bad],{encoding:'utf8'});
    assert.equal(failed.status,1);assert.match(failed.stderr,new RegExp('REGISTRY_SCANNER_MATCH: .*bad\\.json:\\d+ '+RULE_USER));
    const passed=spawnSync(process.execPath,[guard],{encoding:'utf8'});
    assert.equal(passed.status,0,passed.stderr);assert.match(passed.stdout,/no \S+-auth match/);
    // Reached through a differently spelled path (a relative one) the command still runs.
    const relative=spawnSync(process.execPath,[path.relative(process.cwd(),guard),bad],{encoding:'utf8'});
    assert.equal(relative.status,1,relative.stderr);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('profile-only 2 MiB capacity decodes old and new bounded wire bytes, then refuses the next byte',()=>{
  assert.equal(WORKFLOW_PROFILES_MAX_BYTES,2097152);
  assert.equal(WORKFLOW_SOURCE_MAX_BYTES,524288);
  const value=fixture(),text=JSON.stringify(value)+'\n';
  for(const size of [1048576,1048577,2097152]) {
    const raw=text+' '.repeat(size-Buffer.byteLength(text));
    assert.equal(Buffer.byteLength(raw),size);
    assert.deepEqual(parseWorkflowProfiles(raw),value);
  }
  bad(()=>parseWorkflowProfiles(text+' '.repeat(2097153-Buffer.byteLength(text))));
});
