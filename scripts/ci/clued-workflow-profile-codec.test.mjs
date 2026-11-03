import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
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

test('all original 67 sources and the exact compound draft roundtrip without losing bytes, roles or metadata',()=>{
  const semantic=read(),wire=encodeWorkflowProfiles(semantic),text=serializeWorkflowProfiles(semantic);
  const decoded=parseWorkflowProfiles(Buffer.from(text));
  assert.deepEqual(decoded,semantic);
  assert.equal(wire.schema,'clued.gated-proof-profiles/3');
  assert.equal(decoded.schema,'clued.gated-proof-profiles/2');
  assert.equal(sources(decoded).length,68);
  const original=structuredClone(decoded);delete original.workflows[REQUIRED_TESTS_SOURCE.file];
  assert.equal(sources(original).length,67);
  assert.equal(roleDefinitionDigest(original),'1ab232292f79359f99c1de58eaf47076bb968593f5ffd46fd54aaafda086554c');
  const oldRoles=structuredClone(specs);delete oldRoles.workflows[REQUIRED_TESTS_SOURCE.file];
  assert.equal(roleDefinitionDigest(oldRoles),'04eb96fb6640801a7bd1e41eca7e746e61afb829da95e81a633445d1c6852d41');
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
