import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertControllerIdentity} from './clued-merge-reconcile-host.mjs';
import {readReconcileActivation} from './clued-merge-reconcile-gate.mjs';

export const SOURCE_FILE='scripts/ci/clued-merge-reconcile-source.json';
export const WORKFLOW_FILE='.github/workflows/clued-merge-reconcile.yml';
export const SOURCE_SCHEMA='clued.merge-reconcile-source/1';
export const FIXED_WORKFLOW_SHA256='11d4b72a9f330801bdb44d3bd8a5b6c411cd328b02a6946ab9ada7485ec7dbf3';
export const FIXED_ROLE_SHA256='66f0ab7a81fb3e6c6465d19434dde50474f30907a34593f3f0a2ed45121a2a9f';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(reason='invalid registration')=>{throw Error('MERGE_RECONCILE_SOURCE_UNQUALIFIED: '+reason);};
export const canonical=x=>Array.isArray(x)?x.map(canonical):x!==null&&typeof x==='object'?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const directories=['scripts/ci','scripts/runner','.github/workflows','.github/actions/ci-temporary-storage'];
const individualFiles=['config/merge-admission-policy.json','config/clued-mechanical-files.json',
  'apps/clued-cloud/app/supabase-public-config.ts','apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json'];
const included=name=>name!==SOURCE_FILE&&/\.(?:mjs|json|py|ps1|yml|yaml|sh|cmd)$/.test(name);

export function sourceClosure(workspace){
  const files=[];
  const walk=dir=>{for(const item of fs.readdirSync(path.join(workspace,dir),{withFileTypes:true})){
    const name=dir+'/'+item.name;
    if(item.isSymbolicLink())fail();
    if(item.isDirectory())walk(name);
    else if(included(name)){
      if(!item.isFile())fail(name);
      files.push(name);
    }
  }};
  // Check the fixed path components too: readdir only sees links below a walked directory.
  for(const name of [...directories,...individualFiles]){
    const parts=name.split('/');
    let filename=workspace;
    for(const part of parts){
      filename=path.join(filename,part);
      if(fs.lstatSync(filename).isSymbolicLink())fail(name);
    }
  }
  for(const dir of directories)walk(dir);
  for(const name of individualFiles){
    if(!fs.lstatSync(path.join(workspace,name)).isFile())fail(name);
    files.push(name);
  }
  return files.sort();
}
function committedClosure(workspace){
  // An explicit gitdir also accepts linked worktrees, without discovering a parent checkout.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
  const tree=execFileSync('git',['--no-replace-objects','--git-dir=.git','--work-tree=.','ls-tree','-r','-z','HEAD',
    '--',...directories,...individualFiles],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
  const entries=new Map();
  for(const row of new TextDecoder('utf-8',{fatal:true}).decode(tree).split('\0')){
    if(!row)continue;
    const tab=row.indexOf('\t'),name=row.slice(tab+1);
    if(!included(name)&&!individualFiles.includes(name))continue;
    const entry=/^100(?:644|755) blob ([a-f0-9]{40})$/.exec(row.slice(0,tab));
    if(!entry)fail(name);
    entries.set(name,entry[1]);
  }
  return entries;
}
const required=[WORKFLOW_FILE,'scripts/ci/clued-merge-reconcile.mjs','scripts/ci/clued-merge-reconcile-source.mjs',
  'scripts/ci/clued-merge-executor.mjs','scripts/ci/clued-merge-slot-ci.mjs','scripts/ci/clued-work-admission.mjs',
  'scripts/ci/clued-gated-proof-runtime.mjs','scripts/ci/clued-managed-auto-merge.mjs',
  'scripts/ci/merge-admission-policy.mjs','config/merge-admission-policy.json'];

// A reviewed default-branch integrity registry, never an Owner Grant, Host
// qualification, secret permission or exception to the installed runner hook.
function readRegistration(workspace,read){
  const source=JSON.parse(read(path.join(workspace,SOURCE_FILE),'utf8'));
  if(source.schema!==SOURCE_SCHEMA||source.repository!=='tdoljyj/cross-memory-system'||source.defaultBranch!=='main'
    ||source.executionAuthority!==false||source.hostQualification!=='separate_required'
    ||source.workflow?.path!==WORKFLOW_FILE||Object.hasOwn(source,'files')
    ||source.runnerHookException!==false||source.dispatchAuthority!==false||source.productionAuthority!==false
    ||!source.role||source.role.id!=='reconcile'||!source.role.definition||!Array.isArray(source.role.definition['runs-on'])
    ||JSON.stringify(source.role.definition['runs-on'])!==JSON.stringify(['self-hosted','Windows','X64','clued-controller-windows-v1','trust-internal'])
    ||source.workflow.sha256!==FIXED_WORKFLOW_SHA256||source.role.sha256!==FIXED_ROLE_SHA256
    ||source.role.sha256!==hash(JSON.stringify(canonical(source.role.definition))))fail();
  return source;
}
export function verifyReconcileRegistration(workspace,read=fs.readFileSync){
  const source=readRegistration(workspace,read);
  if(hash(read(path.join(workspace,WORKFLOW_FILE)))!==FIXED_WORKFLOW_SHA256)fail(WORKFLOW_FILE);
  return source;
}
export function verifyReconcileSource(workspace,read=fs.readFileSync){
  const source=readRegistration(workspace,read);
  const tree=committedClosure(workspace),disk=sourceClosure(workspace);
  if(tree.size<10||tree.size>2000||required.some(name=>!tree.has(name)))fail('incomplete HEAD closure');
  const files={};
  for(const name of disk){
    if(!tree.has(name))fail('not in HEAD: '+name);
    const bytes=read(path.join(workspace,name));
    const blob=createHash('sha1').update('blob '+Buffer.byteLength(bytes)+'\0').update(bytes).digest('hex');
    if(blob!==tree.get(name))fail('bytes differ from HEAD: '+name);
    files[name]=hash(bytes);
  }
  if(disk.length!==tree.size)fail('missing from checkout: '+[...tree.keys()].find(name=>!Object.hasOwn(files,name)));
  if(files[WORKFLOW_FILE]!==FIXED_WORKFLOW_SHA256)fail(WORKFLOW_FILE);
  return {...source,files};
}

if(import.meta.main){
  try{verifyReconcileSource(process.env.GITHUB_WORKSPACE??path.resolve('.'));assertControllerIdentity();
    if(!readReconcileActivation().enabled)throw Error('RECONCILE_NOT_ACTIVATED');
    console.log('MERGE_RECONCILE_SOURCE_AND_CONTROLLER_IDENTITY_ONLY');}
  catch{console.error('MERGE_RECONCILE_SOURCE_UNQUALIFIED');process.exitCode=1;}
}
