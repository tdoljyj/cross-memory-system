// The R9 collector self-test (merge-admission-r9-collector.test.mjs) in the two shapes it runs in (board line 241):
// a checkout, as CI runs it, and the private mode (a test file outside the tree, the tree named by
// CLUED_R9_TEST_REPO_ROOT). A file the pull request adds, imported or read, must not turn either red.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const ROOTS=['scripts/ci','scripts/runner','.github/workflows','config'];
const SELF_TEST='merge-admission-r9-collector.test.mjs';
function scratch(t,prefix){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  t.after(()=>{if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('TEMP_SCOPE_REFUSED');fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function checkout(t){
  const tree=scratch(t,'clued-r9-tree-');
  for(const root of ROOTS)fs.cpSync(path.join(repo,root),path.join(tree,root),{recursive:true});
  return tree;
}
function run(file,cwd,extra={}){
  const env={...process.env,...extra};
  for(const name of ['CLUED_R9_TEST_DEPENDENCY_ROOT','NODE_TEST_CONTEXT'])delete env[name];
  if(!extra.CLUED_R9_TEST_REPO_ROOT)delete env.CLUED_R9_TEST_REPO_ROOT;
  return spawnSync(process.execPath,['--test','--test-reporter=tap',file],{cwd,env,encoding:'utf8'});
}
const output=r=>(r.stdout??'')+(r.stderr??'');

test('a checkout whose self-test imports a module the pull request adds passes without any override',t=>{
  const tree=checkout(t),file=path.join(tree,'scripts/ci',SELF_TEST);
  fs.writeFileSync(path.join(tree,'scripts/ci/zz-probe.mjs'),'export const probe=1;\n');
  fs.appendFileSync(file,"\nawait import('./zz-probe.mjs');\n");
  const r=run(path.join('scripts/ci',SELF_TEST),tree);
  assert.equal(r.status,0,output(r));assert.match(r.stdout,/# fail 0/);
  assert.doesNotMatch(output(r),/MODULE_NOT_FOUND/);
});

test('the private mode still proves the default self-test, also when it reads a data file the pull request adds',t=>{
  const tree=checkout(t),own=scratch(t,'clued-r9-private-');
  // The test file and the modules the private mode keeps beside it (its overrides and the two under test) move out of the tree.
  for(const name of [SELF_TEST,'merge-admission-native-population.mjs','merge-admission-four-sources.mjs',
    'merge-admission-r9-collector.mjs','ci-usage-report.mjs'])
    fs.copyFileSync(path.join(tree,'scripts/ci',name),path.join(own,name));
  fs.rmSync(path.join(tree,'scripts/ci',SELF_TEST));
  fs.writeFileSync(path.join(tree,'config/zz-probe.json'),'{"probe":1}\n');
  fs.appendFileSync(path.join(own,SELF_TEST),"\nJSON.parse(fs.readFileSync(path.join(repo,'config/zz-probe.json'),'utf8'));\n");
  const r=run(path.join(own,SELF_TEST),tree,{CLUED_R9_TEST_REPO_ROOT:tree});
  assert.equal(r.status,0,output(r));assert.match(r.stdout,/# fail 0/);
  assert.match(r.stdout,/^ok \d+ - M4: /m,'M4 is registered in the private mode and passes');
});
