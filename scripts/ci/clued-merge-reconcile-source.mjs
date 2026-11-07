import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertControllerIdentity} from './clued-merge-reconcile-host.mjs';
import {readReconcileActivation} from './clued-merge-reconcile-gate.mjs';

export const SOURCE_FILE='scripts/ci/clued-merge-reconcile-source.json';
export const WORKFLOW_FILE='.github/workflows/clued-merge-reconcile.yml';
export const SOURCE_SCHEMA='clued.merge-reconcile-source/1';
export const FIXED_WORKFLOW_SHA256='11d4b72a9f330801bdb44d3bd8a5b6c411cd328b02a6946ab9ada7485ec7dbf3';
export const FIXED_ROLE_SHA256='66f0ab7a81fb3e6c6465d19434dde50474f30907a34593f3f0a2ed45121a2a9f';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw Error('MERGE_RECONCILE_SOURCE_UNQUALIFIED');};
export const canonical=x=>Array.isArray(x)?x.map(canonical):x!==null&&typeof x==='object'?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export function sourceClosure(workspace){
  const files=[];
  const walk=dir=>{for(const item of fs.readdirSync(path.join(workspace,dir),{withFileTypes:true})){
    const name=dir+'/'+item.name;
    if(item.isSymbolicLink())fail();
    if(item.isDirectory())walk(name);
    else if(/\.(?:mjs|json|py|ps1|yml|yaml|sh|cmd)$/.test(name)&&name!==SOURCE_FILE)files.push(name);
  }};
  for(const dir of ['scripts/ci','scripts/runner','.github/workflows','.github/actions/ci-temporary-storage'])walk(dir);
  files.push('config/merge-admission-policy.json','apps/clued-cloud/app/supabase-public-config.ts',
    'apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json');
  return files.sort();
}
const required=[WORKFLOW_FILE,'scripts/ci/clued-merge-reconcile.mjs','scripts/ci/clued-merge-reconcile-source.mjs',
  'scripts/ci/clued-merge-executor.mjs','scripts/ci/clued-merge-slot-ci.mjs','scripts/ci/clued-work-admission.mjs',
  'scripts/ci/clued-gated-proof-runtime.mjs','scripts/ci/clued-managed-auto-merge.mjs',
  'scripts/ci/merge-admission-policy.mjs','config/merge-admission-policy.json'];

// A reviewed default-branch integrity registry, never an Owner Grant, Host
// qualification, secret permission or exception to the installed runner hook.
export function verifyReconcileSource(workspace,read=fs.readFileSync){
  const source=JSON.parse(read(path.join(workspace,SOURCE_FILE),'utf8'));
  if(source.schema!==SOURCE_SCHEMA||source.repository!=='tdoljyj/cross-memory-system'||source.defaultBranch!=='main'
    ||source.executionAuthority!==false||source.hostQualification!=='separate_required'
    ||source.workflow?.path!==WORKFLOW_FILE||!source.files||Array.isArray(source.files)
    ||source.runnerHookException!==false||source.dispatchAuthority!==false||source.productionAuthority!==false
    ||!source.role||source.role.id!=='reconcile'||!source.role.definition||!Array.isArray(source.role.definition['runs-on'])
    ||JSON.stringify(source.role.definition['runs-on'])!==JSON.stringify(['self-hosted','Windows','X64','clued-controller-windows-v1','trust-internal'])
    ||Object.keys(source.files).length<10||Object.keys(source.files).length>2000
    ||required.some(name=>!Object.hasOwn(source.files,name)))fail();
  if(JSON.stringify(Object.keys(source.files).sort())!==JSON.stringify(sourceClosure(workspace))
    ||source.role.sha256!==hash(JSON.stringify(canonical(source.role.definition))))fail();
  for(const [name,sha] of Object.entries(source.files)){
    if(!/^[a-f0-9]{64}$/.test(sha)||name.startsWith('/')||name.includes('\\')||name.split('/').some(x=>!x||x==='.'||x==='..')
      ||hash(read(path.join(workspace,name)))!==sha)fail();
  }
  if(source.files[WORKFLOW_FILE]!==FIXED_WORKFLOW_SHA256||source.workflow.sha256!==FIXED_WORKFLOW_SHA256
    ||source.role.sha256!==FIXED_ROLE_SHA256)fail();
  return source;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{verifyReconcileSource(process.env.GITHUB_WORKSPACE??path.resolve('.'));assertControllerIdentity();
    if(!readReconcileActivation().enabled)throw Error('RECONCILE_NOT_ACTIVATED');
    console.log('MERGE_RECONCILE_SOURCE_AND_CONTROLLER_IDENTITY_ONLY');}
  catch{console.error('MERGE_RECONCILE_SOURCE_UNQUALIFIED');process.exitCode=1;}
}
