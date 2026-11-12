import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planControlSourcePins,checkControlSourcePins,writeControlSourcePins,CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY,controlSourceMechanicalFiles} from './clued-control-source-pins.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const BASE='93940d4f6c06179e319c81173269d48cdc8e6420';
const OPTIONS={base:BASE};
const baseText=name=>execFileSync('git',['show',`${BASE}:${name}`],{cwd:ROOT}).toString('utf8');
const baseBlobs=(()=>{const t=baseText(CONTROL_SOURCE_MODULE),e='export const MERGE_RECONCILE_CONTROL_SOURCE=freeze(',a=t.indexOf(e)+e.length;return JSON.parse(t.slice(a,t.indexOf('\n});',a)+2)).implementation_blobs;})();
const CONTROL_SOURCE_MECHANICAL_FILES=controlSourceMechanicalFiles(JSON.parse(baseText('config/clued-mechanical-files.json')),baseBlobs);
const files=[CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY,'config/clued-components.json',...CONTROL_SOURCE_MECHANICAL_FILES,'scripts/ci/clued-workflow-profile.mjs','scripts/ci/component-version-integration-policy.mjs'];
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'control-source-pins-'));
  execFileSync('git',['clone','--shared','--no-checkout','--quiet',ROOT,dir],{stdio:'pipe'});
  execFileSync('git',['read-tree','HEAD'],{cwd:dir,stdio:'pipe'});
  for(const name of files){const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.copyFileSync(path.join(ROOT,name),f);}
  // The checked-in descriptor is a frozen base snapshot. Make every case
  // independent from whether another successful test already materialised it.
  for(const name of [CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY]){
    let bytes=execFileSync('git',['show',`${BASE}:${name}`],{cwd:ROOT}).toString('utf8');
    if(name===CONTROL_SOURCE_MODULE){const marker=fs.readFileSync(path.join(ROOT,name),'utf8').match(/^export const COMPONENT_VERSION[^\r\n]+/m)[0];bytes=bytes.replace(/^export const COMPONENT_VERSION[^\r\n]+/m,marker);}
    fs.writeFileSync(path.join(dir,name),bytes);
  }
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(dir).startsWith('control-source-pins-'));fs.rmSync(dir,{recursive:true,force:true,maxRetries:3});});
  return dir;
}
const read=(root,name)=>fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n');
const edit=(root,name,fn)=>fs.writeFileSync(path.join(root,name),fn(read(root,name)));
const pair=root=>[CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY].map(n=>read(root,n));
async function refusesWithoutWrites(root,match){const before=pair(root);await assert.rejects(writeControlSourcePins(root,OPTIONS),match);assert.deepEqual(pair(root),before);}

test('actual version materialisation is reported, deterministically generated and idempotent without changing historical pins',async t=>{
  const root=fixture(t),before=JSON.parse(read(root,CONTROL_SOURCE_REGISTRY));
  const planned=await planControlSourcePins(root,OPTIONS);
  assert.deepEqual(planned.changes.map(c=>c.file),CONTROL_SOURCE_MECHANICAL_FILES);
  assert.equal((await checkControlSourcePins(root,OPTIONS)).status,'stale');
  const written=await writeControlSourcePins(root,OPTIONS);assert.equal(written.changed,true);
  assert.equal((await checkControlSourcePins(root,OPTIONS)).status,'ok');
  const after=pair(root);assert.equal((await writeControlSourcePins(root,OPTIONS)).changed,false);assert.deepEqual(pair(root),after);
  const now=JSON.parse(read(root,CONTROL_SOURCE_REGISTRY)),file='.github/workflows/clued-merge-reconcile.yml';
  const a=before.workflows[file].sources[0],b=now.workflows[file].sources[0];
  assert.equal(Object.keys(a.implementation_blobs).length,384);assert.equal(Object.keys(b.implementation_blobs).length,384);
  for(const [name,pin]of Object.entries(a.implementation_blobs))if(!CONTROL_SOURCE_MECHANICAL_FILES.includes(name))assert.equal(b.implementation_blobs[name],pin,name);
  assert.equal(b.source_yaml,a.source_yaml);assert.deepEqual(b.workflow_definition,a.workflow_definition);assert.deepEqual(b.authority_boundary,a.authority_boundary);
});
test('missing, invalid or unavailable trusted base refuses before writes',async t=>{
  const root=fixture(t),before=pair(root);
  for(const base of [undefined,'HEAD','0'.repeat(40)]){const result=await checkControlSourcePins(root,{base});assert.notEqual(result.status,'ok');await assert.rejects(writeControlSourcePins(root,{base}));assert.deepEqual(pair(root),before);}
  const cli=path.join(ROOT,'scripts/ci/clued-control-source-pins.mjs');const p=spawnSync(process.execPath,[cli,'--root',root,'--base',BASE],{encoding:'utf8'});assert.equal(p.status,1);assert.equal(JSON.parse(p.stdout).status,'stale');assert.deepEqual(pair(root),before);
});
test('implementation logic changes cannot be converted to registry metadata',async t=>{
  const root=fixture(t);edit(root,CONTROL_SOURCE_MECHANICAL_FILES[0],x=>x+'\nthrow new Error("not metadata");\n');await refusesWithoutWrites(root,/non-mechanical implementation change/);
});
test('duplicate version markers and manifest mismatches refuse without any registry write',async t=>{
  const root=fixture(t);edit(root,CONTROL_SOURCE_MECHANICAL_FILES[0],x=>x+"\nexport const COMPONENT_VERSION = '9.9.9';\n");await refusesWithoutWrites(root,/one component version marker/);
});
test('candidate cannot rewrite a pinned old object to an invented missing object',async t=>{
  const root=fixture(t);for(const name of [CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY])edit(root,name,x=>x.replaceAll('d925cfe3d1bbd05a532c8b825cab01a0063df21b','0'.repeat(40)));await refusesWithoutWrites(root,/neither trusted nor derived/);
});
test('one-sided descriptor or catalogue mutation refuses',async t=>{
  const root=fixture(t);edit(root,CONTROL_SOURCE_MODULE,x=>x.replace('d925cfe3d1bbd05a532c8b825cab01a0063df21b','0'.repeat(40)));await refusesWithoutWrites(root,/pins disagree/);
});
test('two-sided frozen workflow or Role edits cannot self-authenticate against candidate HEAD',async t=>{
  const root=fixture(t);edit(root,CONTROL_SOURCE_REGISTRY,x=>x.replace('trusted_main_secret_reconcile_controller','untrusted_other_family'));await refusesWithoutWrites(root,/frozen catalogue/);
});
test('a two-sided non-mechanical historical pin substitution is rejected',async t=>{
  const root=fixture(t),pin='12f0ff5aca09df465aa0461d493485c3ed2c65b1';for(const name of [CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY])edit(root,name,x=>x.replaceAll(pin,'0'.repeat(40)));await refusesWithoutWrites(root,/frozen descriptor/);
});
test('Source code outside the descriptor is not a generated metadata field',async t=>{
  const root=fixture(t);edit(root,CONTROL_SOURCE_MODULE,x=>x+'\nthrow new Error("source change");\n');await refusesWithoutWrites(root,/Source implementation changed/);
});
test('a linked ancestor directory is refused before materialisation',async t=>{
  const root=fixture(t),dir=path.join(root,'scripts','ci'),outside=path.join(root,'ci-target');fs.renameSync(dir,outside);
  fs.symlinkSync(outside,dir,'junction');await refusesWithoutWrites(root,/not a plain path/);
});
test('a manifest version mismatch refuses rather than registering inconsistent code',async t=>{
  const root=fixture(t);
  edit(root,'config/clued-components.json',x=>{
    const manifest=JSON.parse(x),components=manifest.components.filter(c=>c.id==='script.independent-native-publication');
    assert.equal(components.length,1,'the target component must exist exactly once');
    const component=components[0],before=component.version;
    assert.equal(typeof before,'string');
    component.version=before==='99.0.0'?'98.0.0':'99.0.0';
    assert.notEqual(component.version,before,'the fixture must change the target version');
    return JSON.stringify(manifest,null,2)+'\n';
  });
  await refusesWithoutWrites(root,/version\/manifest mismatch/);
});
test('committing both descriptor and catalogue tampering cannot replace the explicit trusted base',async t=>{
  const root=fixture(t),pin='11d4b72a9f330801bdb44d3bd8a5b6c411cd328b02a6946ab9ada7485ec7dbf3';
  for(const name of [CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY])edit(root,name,x=>x.replaceAll(pin,'0'.repeat(64)));
  execFileSync('git',['add','--',CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY],{cwd:root,stdio:'pipe'});
  execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','untrusted candidate'],{cwd:root,stdio:'pipe'});
  await refusesWithoutWrites(root,/frozen descriptor/);
});
test('an unavailable historical object is a refusal and never a new baseline',async t=>{
  const root=fixture(t),pin='d925cfe3d1bbd05a532c8b825cab01a0063df21b';
  for(const name of [CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY])edit(root,name,x=>x.replaceAll(pin,'0'.repeat(40)));
  execFileSync('git',['add','--',CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY],{cwd:root,stdio:'pipe'});
  execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','missing historical object fixture'],{cwd:root,stdio:'pipe'});
  const base=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),before=pair(root);
  await assert.rejects(writeControlSourcePins(root,{base}));assert.deepEqual(pair(root),before);
});
test('a candidate comparison policy is never evaluated',async t=>{
  const root=fixture(t);edit(root,'scripts/ci/component-version-integration-policy.mjs',()=>"throw new Error('CANDIDATE_POLICY_EXECUTED');\n");
  assert.equal((await writeControlSourcePins(root,OPTIONS)).changed,true);
});
test('historical metadata uses the trusted-base compiler without evaluating a candidate successor',async t=>{
  const root=fixture(t),expected=await planControlSourcePins(root,OPTIONS);
  const candidate="throw new Error('CANDIDATE_PROFILE_EXECUTED');\n";
  edit(root,'scripts/ci/clued-workflow-profile.mjs',()=>candidate);
  assert.deepEqual(await planControlSourcePins(root,OPTIONS),expected);
  assert.equal((await writeControlSourcePins(root,OPTIONS)).changed,true);
  assert.equal((await checkControlSourcePins(root,OPTIONS)).status,'ok');
  assert.equal(read(root,'scripts/ci/clued-workflow-profile.mjs'),candidate);
});
test('a compiler successor must still occupy a plain file path',async t=>{
  const root=fixture(t),name=path.join(root,'scripts/ci/clued-workflow-profile.mjs');
  fs.renameSync(name,name+'.saved');fs.mkdirSync(name);
  await refusesWithoutWrites(root,/not a plain path|working file mode differs/);
});
test('a Git executable-mode substitution is refused even when all bytes are unchanged',async t=>{
  const root=fixture(t);execFileSync('git',['update-index','--chmod=+x','--',CONTROL_SOURCE_MECHANICAL_FILES[0]],{cwd:root,stdio:'pipe'});
  await refusesWithoutWrites(root,/file mode differs from trusted base/);
});
test('refreshable pins come only from the single mechanical-file policy',()=>{
  const policy=JSON.parse(fs.readFileSync(path.join(ROOT,'config/clued-mechanical-files.json'),'utf8'));
  const derived=controlSourceMechanicalFiles(policy,baseBlobs);
  // Only declared, descriptor-pinned version modules; a declared generated registry keeps its historical pin.
  assert.ok(derived.length&&derived.every(n=>n.endsWith('.mjs')&&[...policy.mechanical_paths,...(policy.marker_paths??[])].includes(n)&&Object.hasOwn(baseBlobs,n)));
  const extra=Object.keys(baseBlobs).find(n=>n.endsWith('.mjs')&&!derived.includes(n));
  assert.deepEqual(controlSourceMechanicalFiles({...policy,marker_paths:[...(policy.marker_paths??[]),extra]},baseBlobs),[...derived,extra].sort());
  for(const bad of [null,{...policy,schema:2},{...policy,mechanical_paths:'x'},{...policy,mechanical_paths:['config/other.json'],marker_paths:[]}])
    assert.throws(()=>controlSourceMechanicalFiles(bad,baseBlobs),/mechanical/);
});
