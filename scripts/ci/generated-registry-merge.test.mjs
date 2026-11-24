import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {REQUIRED_TESTS_SOURCE} from './clued-workflow-profile.mjs';
import {readRequiredApplicability} from './clued-required-applicability.mjs';
import {verifyReconcileSource} from './clued-merge-reconcile-source.mjs';
import {GENERATED} from './check-pinned-registries.mjs';
import {appDependencyGap} from './ci-required-selection.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
// The pinned generators run here need the application's dependencies (check-pinned-registries.mjs's needs). When one is
// missing: a failure if the job provided them (the selection's marker), otherwise every test is skipped, saying why
// (Clued Task 10399304).
const gap=appDependencyGap(root,GENERATED.flatMap(g=>g.needs));
if(gap)console.log('generated-registry-merge: '+gap.reason+(gap.fail?'':'; skipped'));
if(gap?.fail)nodeTest('作业提供的应用依赖确实在场',()=>assert.fail(gap.reason));
const test=gap?Object.assign(name=>nodeTest(name,{skip:gap.reason},()=>{}),{before(){},after(){}}):nodeTest;
const selector='scripts/ci/ci-required-selection.mjs';
const firstHelper='scripts/ci/clued-push-reuse.mjs',secondHelper='scripts/ci/clued-merge-reconcile-source-build.mjs';
const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Registry test','-c','user.email=test@invalid',
  '-c','commit.gpgSign=false','-c','core.hooksPath=',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

let temp,tree,base,modules;
test.before(()=>{
  base=git(root,'rev-parse','HEAD');
  temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'reg-'));
  tree=path.join(temp,'w');
  git(root,'worktree','add','--quiet','--detach',tree,base);
  modules=path.join(tree,'apps/clued-cloud/node_modules');
  fs.symlinkSync(fs.realpathSync(path.join(root,'apps/clued-cloud/node_modules')),modules,'junction');
});
test.after(()=>{
  if(modules&&fs.lstatSync(modules,{throwIfNoEntry:false})?.isSymbolicLink())fs.unlinkSync(modules);
  if(tree&&fs.existsSync(path.join(tree,'.git')))git(root,'worktree','remove','--force',tree);
  if(temp)fs.rmdirSync(temp);
});

// Detached branch tips keep fixtures out of the caller's branch namespace.
const checkout=ref=>git(tree,'checkout','--quiet','--detach',ref);
const head=()=>git(tree,'rev-parse','HEAD');
function edit(parent,file,label,atStart=false){
  checkout(parent);
  const target=path.join(tree,file),text=fs.readFileSync(target,'utf8'),comment='// '+label+'\n';
  fs.writeFileSync(target,atStart?comment+text:text+'\n'+comment);
  git(tree,'commit','-qm',label,'--',file);
  return head();
}
function merge(ref){
  git(tree,'merge','--no-ff','--no-edit',ref);
}
const verifyScript="import {verifyReconcileSource} from './scripts/ci/clued-merge-reconcile-source.mjs'; verifyReconcileSource('.');";
function node(...args){
  const result=spawnSync(process.execPath,args,{cwd:tree,encoding:'utf8'});
  if(result.error)throw result.error;
  return result;
}
function check(label){
  const pins=node('scripts/ci/check-pinned-registries.mjs','--base',base);
  const source=node('--input-type=module','-e',verifyScript);
  const errors=[];
  if(pins.status!==0)errors.push(pins.stdout.trim()+'\n'+pins.stderr.trim());
  if(source.status!==0)errors.push(source.stderr.trim());
  assert.equal(errors.length,0,label+'\n'+errors.join('\n'));
  const pin=node('--input-type=module','-e',
    "import {REQUIRED_SELECTOR_SOURCE as pin} from './scripts/ci/clued-required-applicability.mjs'; console.log(JSON.stringify(pin));");
  assert.equal(pin.status,0,pin.stderr);
  const identity=JSON.parse(pin.stdout);
  assert.equal(identity.path,selector);
  assert.equal(identity.blob,git(tree,'rev-parse','HEAD:'+selector));
  assert.equal(identity.sha256,createHash('sha256').update(fs.readFileSync(path.join(tree,selector))).digest('hex'));
}

test('两个分支分别修改选择器首尾，分支和合并结果都直接通过',()=>{
  const a=edit(base,selector,'branch A',true);
  check('分支 A');
  const b=edit(base,selector,'branch B');
  check('分支 B');
  merge(a);
  assert.deepEqual(git(tree,'show','-s','--format=%P','HEAD').split(' '),[b,a]);
  check('合并 A 与 B');
});

test('撤回闭包修改后合入 main 的另一项修改（#1163）',()=>{
  const feature=edit(base,firstHelper,'shared change');
  const main=edit(feature,selector,'independent main change');
  checkout(feature);
  git(tree,'revert','--no-edit',feature);
  merge(main);
  assert.equal(git(tree,'rev-parse','HEAD:'+firstHelper),git(tree,'rev-parse',base+':'+firstHelper));
  assert.equal(git(tree,'rev-parse','HEAD:'+selector),git(tree,'rev-parse',main+':'+selector));
  check('撤回后合入 main');
});

test('三个分支的改动合成单一提交 S',()=>{
  const tips=[[selector,'S selector'],[firstHelper,'S helper'],[secondHelper,'S builder']]
    .map(([file,label])=>[file,edit(base,file,label)]);
  checkout(base);
  git(tree,'merge','--squash',...tips.map(([,tip])=>tip));
  git(tree,'commit','-qm','Batch S');
  assert.equal(git(tree,'show','-s','--format=%P','HEAD'),base);
  for(const [file,tip] of tips)assert.equal(git(tree,'rev-parse','HEAD:'+file),git(tree,'rev-parse',tip+':'+file));
  check('批量提交 S');
});

test('套件实际检出的闭包也与其 HEAD 一致',()=>{
  verifyReconcileSource(root);
});

test('闭包成员的未提交修改、额外文件、缺失文件分别被拒绝',async t=>{
  checkout(base);
  const {verifyReconcileSource}=await import(pathToFileURL(path.join(tree,'scripts/ci/clued-merge-reconcile-source.mjs')));
  const file=path.join(tree,firstHelper),bytes=fs.readFileSync(file);
  await t.test('未提交修改',()=>{
    try{
      fs.appendFileSync(file,'\n');
      assert.throws(()=>verifyReconcileSource(tree),/bytes differ from HEAD: scripts\/ci\/clued-push-reuse\.mjs/);
    }finally{fs.writeFileSync(file,bytes);}
  });
  await t.test('未入库的 .mjs',()=>{
    const extra=path.join(tree,'scripts/ci/extra-fixture.mjs');
    try{
      fs.writeFileSync(extra,'export {};\n',{flag:'wx'});
      assert.throws(()=>verifyReconcileSource(tree),/not in HEAD: scripts\/ci\/extra-fixture\.mjs/);
    }finally{fs.unlinkSync(extra);}
  });
  await t.test('缺少已入库的文件',()=>{
    try{
      fs.unlinkSync(file);
      assert.throws(()=>verifyReconcileSource(tree),/missing from checkout: scripts\/ci\/clued-push-reuse\.mjs/);
    }finally{fs.writeFileSync(file,bytes);}
  });
});

test('登记带 files 或工作流多一个字节仍被拒绝',async()=>{
  const {SOURCE_FILE,WORKFLOW_FILE,verifyReconcileSource}=await import(pathToFileURL(path.join(tree,'scripts/ci/clued-merge-reconcile-source.mjs')));
  const registry=path.join(tree,SOURCE_FILE),original=fs.readFileSync(registry);
  try{
    fs.writeFileSync(registry,JSON.stringify({...JSON.parse(original),files:{}}));
    assert.throws(()=>verifyReconcileSource(tree),/invalid registration/);
  }finally{fs.writeFileSync(registry,original);}

  // Model a committed workflow change without writing the protected workflow on disk.
  const workflow=path.join(tree,WORKFLOW_FILE),changed=Buffer.concat([fs.readFileSync(workflow),Buffer.from('\n')]);
  const blob=execFileSync('git',['hash-object','-w','--stdin'],{cwd:tree,input:changed,encoding:'utf8'}).trim();
  git(tree,'update-index','--cacheinfo','100644',blob,WORKFLOW_FILE);
  git(tree,'commit','-qm','One extra workflow byte');
  assert.equal(git(tree,'rev-parse','HEAD:'+WORKFLOW_FILE),blob);
  try{
    const read=(file,...args)=>file===workflow?changed:fs.readFileSync(file,...args);
    assert.throws(()=>verifyReconcileSource(tree,read),/UNQUALIFIED: \.github\/workflows\/clued-merge-reconcile\.yml/);
  }finally{
    git(tree,'restore','--source='+base,'--staged','--',WORKFLOW_FILE);
    checkout(base);
  }
});

test('缺少检出的 .git 时拒绝，即使上级目录也是工作树',async()=>{
  const {verifyReconcileSource}=await import(pathToFileURL(path.join(tree,'scripts/ci/clued-merge-reconcile-source.mjs')));
  const gitfile=path.join(tree,'.git'),saved=path.join(temp,'gitfile');
  fs.renameSync(gitfile,saved);
  try{assert.throws(()=>verifyReconcileSource(tree));}finally{fs.renameSync(saved,gitfile);}
});

test('找不到 Git 时拒绝校验',()=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',verifyScript],
    {cwd:tree,env:{...process.env,PATH:''},encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/spawnSync git ENOENT/);
});

test('缺少本地选择器时仍能加载准入模块，适用性返回 null',()=>{
  const file=path.join(tree,selector),bytes=fs.readFileSync(file);
  fs.unlinkSync(file);
  try{
    const result=node('--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import './scripts/ci/clued-gated-proof-runtime.mjs';
      import {readRequiredApplicability,REQUIRED_SELECTOR_SOURCE as pin} from './scripts/ci/clued-required-applicability.mjs';
      assert.equal(pin.blob,null);
      assert.equal(pin.sha256,null);
      assert.equal(await readRequiredApplicability({}),null);
    `);
    assert.equal(result.status,0,result.stderr);
  }finally{fs.writeFileSync(file,bytes);}
});

// 选择器文件在、加载就抛：运行时照常加载，适用性只是不签（辅助功能出错只能“不做”，看板第 251 行补充裁定）。
test('本地选择器加载即抛时仍能加载准入模块，适用性返回 null 且不发起读取',()=>{
  const file=path.join(tree,selector),bytes=fs.readFileSync(file);
  fs.writeFileSync(file,"throw new Error('broken selector');\n");
  try{
    const result=node('--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import './scripts/ci/clued-gated-proof-runtime.mjs';
      import {readRequiredApplicability,REQUIRED_SELECTOR_SOURCE as pin} from './scripts/ci/clued-required-applicability.mjs';
      assert.notEqual(pin.blob,null);
      let calls=0;const count=async()=>{calls++;return null;};
      assert.equal(await readRequiredApplicability({read:count,readLog:count,repository:'o/r',prNumber:17,head:'a'.repeat(40),
        base:'b'.repeat(40),runId:777,runAttempt:2,requestKey:{},trustedGateBlob:'c'.repeat(40)}),null);
      assert.equal(calls,0);
    `);
    assert.equal(result.status,0,result.stderr);
  }finally{fs.writeFileSync(file,bytes);}
});

test('同一份基线证据在选择器相同时有效，换用另一提交的选择器后返回 null',async()=>{
  const prHead=edit(base,firstHelper,'PR change');
  edit(base,selector,'different local selector');
  const local=await import(pathToFileURL(path.join(tree,'scripts/ci/clued-required-applicability.mjs')));
  const repository='fixture/repo',prefix='/repos/'+repository,gate='scripts/ci/clued-work-admission.mjs';
  const content=name=>{
    const bytes=execFileSync('git',['show',base+':'+name],{cwd:tree});
    return {type:'file',path:name,sha:git(tree,'rev-parse',base+':'+name),size:bytes.length,
      encoding:'base64',content:bytes.toString('base64')};
  };
  const jobs=['admission-gate',...REQUIRED_TESTS_SOURCE.primary_ids].map((name,i)=>({
    name,id:i+1,run_id:1,run_attempt:1,status:'completed',conclusion:'success'}));
  const responses=new Map([
    [prefix+'/pulls/1',{number:1,state:'open',head:{sha:prHead,repo:{full_name:repository}},
      base:{sha:base,ref:'main',repo:{full_name:repository,default_branch:'main'}},commits:1,changed_files:1}],
    [prefix+'/actions/runs/1',{id:1,run_attempt:1,event:'pull_request',path:REQUIRED_TESTS_SOURCE.file,head_sha:prHead,
      repository:{full_name:repository},status:'completed',conclusion:'success',pull_requests:[]}],
    [prefix+'/compare/'+base+'...'+prHead+'?per_page=100&page=1',{base_commit:{sha:base},merge_base_commit:{sha:base},
      total_commits:1,commits:[{sha:prHead}],files:[{filename:firstHelper,status:'modified'}]}],
    [prefix+'/actions/runs/1/attempts/1/jobs?per_page=100&page=1',{total_count:jobs.length,jobs}],
    [prefix+'/contents/'+selector+'?ref='+base,content(selector)],
    [prefix+'/contents/'+gate+'?ref='+base,content(gate)],
  ]);
  const witness={mode:'gate',event:'pull_request',base_sha:base,head_sha:prHead,pr_ref:repository+'#1',
    enforced:true,admitted:true,verdict:'ADMITTED'};
  const calls=[];
  const options={repository,prNumber:1,head:prHead,base,runId:1,runAttempt:1,requestKey:{},
    trustedGateBlob:git(tree,'rev-parse',base+':'+gate),read:async route=>{calls.push(route);return responses.get(route);},
    readLog:async()=>({complete:true,job_id:1,run_id:1,run_attempt:1,
      text:'[command]/usr/bin/git log -1 --format=%H\n'+base+'\n'+JSON.stringify(witness)+'\n'})};
  assert.ok(await readRequiredApplicability(options));
  calls.length=0;
  assert.equal(await local.readRequiredApplicability(options),null);
  assert.equal(calls.at(-1),prefix+'/contents/'+selector+'?ref='+base);
});
