import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {executionPaths,candidateCheck,REQUIRED_FILES,EXECUTION_FLOOR,RUNTIME_SOURCE_ROOTS}
  from './clued-handover-external-source-check.mjs';
const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
const historical=JSON.parse(fs.readFileSync(path.join(repositoryRoot,'config/clued-handover-external-acceptance.json'),'utf8'));
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native617-source-rules-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const git=args=>execFileSync('git',args,{cwd:root,stdio:['pipe','pipe','pipe']}).toString().trim();
 git(['init','-q']);git(['config','user.name','Source fixture']);git(['config','user.email','source-fixture@invalid']);git(['config','core.autocrlf','false']);
 const write=(file,body='// local source fixture\n')=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),body);};
 for(const file of new Set([...Object.keys(historical.files),...REQUIRED_FILES,...EXECUTION_FLOOR]))write(file);
 for(const prefix of RUNTIME_SOURCE_ROOTS){write(prefix+'src/runtime.mjs','export const value=1;\n');write(prefix+'windows/runtime.cs','// fixture\n');}
 write('config/clued-handover-external-profile.json',fs.readFileSync(path.join(repositoryRoot,'config/clued-handover-external-profile.json')));
 // Excluded C is deliberately invalid: candidate validation must neither read
 // its historical approval nor treat it as a new one.
 write('config/clued-handover-external-acceptance.json','not a current acceptance\n');
 const commit=()=>{git(['add','--all']);git(['-c','commit.gpgsign=false','-c','core.hooksPath='+path.join(root,'.git','hooks'),'commit','-qm','source fixture']);return git(['rev-parse','HEAD']);};
 const head=commit();return {root,git,write,commit,head};
}

test('successor Source retains the entire historical A and pins both complete runtime roots without admitting old C',t=>{
 const f=fixture(t),files=executionPaths(f.root,f.head);
 for(const old of Object.keys(historical.files))assert.ok(files.includes(old),old);
 for(const prefix of RUNTIME_SOURCE_ROOTS){assert.ok(files.includes(prefix+'src/runtime.mjs'));assert.ok(files.includes(prefix+'windows/runtime.cs'));}
 assert.equal(files.includes('config/clued-handover-external-acceptance.json'),false);
 assert.equal(candidateCheck(f.root).status,'CANDIDATE_SOURCE_ONLY');
 assert.equal(candidateCheck(f.root).accepted,false);
});

test('new runtime files enter the immutable subject and a later deletion changes that exact member set',t=>{
 const f=fixture(t),file=RUNTIME_SOURCE_ROOTS[0]+'runtime/new-entry.mjs';f.write(file,'export const next=1;\n');const added=f.commit();
 assert.ok(executionPaths(f.root,added).includes(file));assert.equal(executionPaths(f.root,f.head).includes(file),false);
 fs.unlinkSync(path.join(f.root,file));const removed=f.commit();assert.equal(executionPaths(f.root,removed).includes(file),false);
});

test('runtime modules, cross-root helpers and configuration assets belong to one committed candidate subject',t=>{
 const f=fixture(t),consumer=RUNTIME_SOURCE_ROOTS[0]+'src/consumer.mjs';
 f.write(consumer,"import value from '../../../../scripts/ci/runtime-helper.mjs';\nexport {value};\n");
 f.write('scripts/ci/runtime-helper.mjs','export default 1;\n');f.write('config/runtime-helper.json','{"fixture":true}\n');
 assert.equal(executionPaths(f.root,f.head).includes(consumer),false,'uncommitted files cannot be part of an immutable subject');
 const head=f.commit(),files=executionPaths(f.root,head);
 for(const file of [consumer,'scripts/ci/runtime-helper.mjs','config/runtime-helper.json'])assert.ok(files.includes(file),file);
});

test('immutable subject enumeration uses Git blobs rather than mixed or dirty working-tree text',t=>{
 const f=fixture(t),file=RUNTIME_SOURCE_ROOTS[0]+'src/runtime.mjs',before=executionPaths(f.root,f.head);
 f.write(file,"import '../../../apps/not-in-git.mjs';\r\n");
 assert.deepEqual(executionPaths(f.root,f.head),before);
 assert.throws(()=>candidateCheck(f.root),/DIRTY_EXECUTABLE/);
});

