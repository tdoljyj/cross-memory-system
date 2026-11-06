import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ACTOR_WORKFLOW,compileActorSource,classifyActorSource,trustedActorCatalogue} from './clued-standard-runner-actor-source.mjs';
import {ciWorkflows} from './clued-merge-slot-ci.mjs';
const require=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url)),YAML=require('yaml');
const registry=trustedActorCatalogue(),raw=registry.source.source_yaml;
const compile=(text,r=registry)=>compileActorSource(ACTOR_WORKFLOW,text,{parseYaml:s=>YAML.parse(s,{uniqueKeys:true}),roles:r.roles,rows:r.source.rows});
test('actor exact real YAML, all three complete independent roles; no OS authority',()=>{
 assert.deepEqual(compile(raw),registry.source.profile);
 assert.deepEqual(classifyActorSource(registry,ACTOR_WORKFLOW,raw).profile,registry.source.profile);
 assert.equal(classifyActorSource(registry,ACTOR_WORKFLOW,raw).execution_authority,false);
 assert.equal(classifyActorSource(registry,ACTOR_WORKFLOW,raw).host_qualified,false);
 assert.equal(registry.source.profile.pull_request_ci,false);
});
for(const [name,change] of [
 ['Owner filter',s=>s.replace("github.actor_id == '52366662'","github.actor_id != '52366662'")],
 ['main filter',s=>s.replace("github.ref == 'refs/heads/main'","true")],
 ['command',s=>s.replace('--execute','--plan')],
 ['route',s=>s.replace('site-company','site-home')],
 ['gate',s=>s.replace('needs: admission-gate','needs: other')],
 ['permission',s=>s.replace('contents: read','contents: write')],
 ['extra trigger',s=>s.replace('on:\n','on:\n  pull_request:\n')],
 ['row selector',s=>s.replace("inputs.node_id == 'desk-w-591-windows-runner-caches'","true")],
 ['unknown input',s=>s.replace('    inputs:\n','    inputs:\n      command: {type: string}\n')]
])test('actor rejects changed '+name,()=>assert.throws(()=>compile(change(raw))));
test('actor missing, changed or extra full roles never register',()=>{
 for(const mutation of [r=>r.roles.pop(),r=>{r.roles[0].definition.permissions.actions='write';},r=>r.roles.push(r.roles[0]),r=>{r.roles[1].definition_sha256='a'.repeat(64);}]){
  const r=structuredClone(registry);mutation(r);assert.equal(classifyActorSource(r,ACTOR_WORKFLOW,raw).passed,false);
 }
});
test('actor exact Source cannot be self-promoted by flags/unknown catalog fields',()=>{
 for(const mutate of [r=>{r.source.profile.execution_authority=true;},r=>{r.source.profile.pull_request_ci=true;},r=>{r.qualified=true;},r=>{r.default_branch='feature';}]){
  const r=structuredClone(registry);mutate(r);assert.equal(classifyActorSource(r,ACTOR_WORKFLOW,raw).passed,false);
 }
 assert.equal(classifyActorSource(registry,'.github/workflows/other.yml',raw).passed,false);
});
test('actor Source bytes bound before parser, 256KiB remains a real cap',()=>{
 let calls=0;assert.throws(()=>compileActorSource(ACTOR_WORKFLOW,'x'.repeat(262145),{parseYaml:()=>{calls++;},roles:registry.roles,rows:registry.source.rows}));assert.equal(calls,0);
 assert.equal(classifyActorSource(registry,ACTOR_WORKFLOW,raw+'\n').passed,false);
});
test('typed actor excluded from PR count only on exact complete Source; mutated/unknown remain count1',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const read=(p)=>p.endsWith('clued-standard-runner-actor-sources.json')?Buffer.from(JSON.stringify(registry)):fs.readFileSync(p);
 assert.equal(ciWorkflows(root,()=>['clued-standard-runner-actor-qualification.yml'],read).size,0);
 const changed=(p)=>p.endsWith('clued-standard-runner-actor-qualification.yml')?Buffer.from(raw.replace('--execute','--plan')):read(p);
 assert.equal(ciWorkflows(root,()=>['clued-standard-runner-actor-qualification.yml'],changed).size,1);
});
