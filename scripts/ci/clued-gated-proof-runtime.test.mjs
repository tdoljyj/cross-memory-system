import assert from 'node:assert/strict';
import test from 'node:test';
import {platformWorkflowSource,workflowSourceOf,githubGraphReader,observeCompletedSource,boundPullDiff} from './clued-gated-proof-runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileRegisteredWorkflow,roleDefinitionDigest,workflowBlob,rolesForSource} from './clued-workflow-profile.mjs';
import {reportMergeSlots} from './clued-merge-slot-ci.mjs';
const repository='o/r',headRepository='fork/r',file='.github/workflows/fixture.yml';
const sha='a'.repeat(40),head='b'.repeat(40);
const run={id:7,node_id:'WFR_fixture',run_attempt:2,event:'pull_request',head_sha:head,
  repository:{full_name:repository},head_repository:{full_name:headRepository}};
const payload=()=>({data:{node:{databaseId:7,runAttempt:2,event:'pull_request',file:{path:file,
  repositoryName:repository,repositoryFileUrl:`https://github.com/${repository}/blob/${sha}/${file}`,
  run:{databaseId:7,runAttempt:2}}}}});
const options={repository,headRepository,file,run};
test('platform executed file binds run, attempt, repository, path and immutable commit',()=>{
  assert.equal(platformWorkflowSource(payload(),options).source_sha,sha);
  const fork=payload();fork.data.node.file.repositoryName=headRepository;
  fork.data.node.file.repositoryFileUrl=`https://github.com/${headRepository}/blob/${sha}/${file}`;
  assert.equal(platformWorkflowSource(fork,options).passed,true);
  for(const edit of [p=>p.errors=[],p=>p.data.node.runAttempt=3,p=>p.data.node.databaseId=8,
    p=>p.data.node.event='push',p=>p.data.node.file=null,p=>p.data.node.file.run.runAttempt=1,
    p=>p.data.node.file.path='.github/workflows/other.yml',p=>p.data.node.file.repositoryName='other/r',
    p=>p.data.node.file.repositoryFileUrl=`https://evil.example/${repository}/blob/${sha}/${file}`,
    p=>p.data.node.file.repositoryFileUrl=`https://github.com/${repository}/blob/main/${file}`,
    p=>p.data.node.file.repositoryFileUrl+= '?source=fake',
    p=>p.data.node.file.repositoryFileUrl=`https://user@github.com/${repository}/blob/${sha}/${file}`]) {
    const value=payload();edit(value);assert.equal(platformWorkflowSource(value,options).state,'unknown');
  }
  assert.equal(platformWorkflowSource(payload(),{...options,run:{...run,head_repository:{full_name:'wrong/r'}}}).state,'unknown');
});
test('same workflow path selects independent roles by exact source blob',()=>{
  const parsed={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]}}};
  const newer=structuredClone(parsed);newer.jobs.main.steps[0].run='node newer-tests.mjs';
  const oldRoles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
  const newRoles=[{job_id:'main',definition_sha256:roleDefinitionDigest(newer.jobs.main)}];
  const text='old fixture',newText='new fixture';
  const specs={schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{
    [workflowBlob(text)]:oldRoles,[workflowBlob(newText)]:newRoles}}}};
  assert.deepEqual(rolesForSource(specs,file,workflowBlob(newText)),newRoles);
  assert.throws(()=>compileRegisteredWorkflow(newText,{primary_ids:['main'],parseYaml:()=>newer,accepted_roles:oldRoles}));
  assert.equal(rolesForSource(specs,file,'c'.repeat(40)),null);
});
test('executed source requires exact trusted registration and per-source roles',async()=>{
  const text='source fixture',parsed={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]}}};
  const roles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
  const profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:roles});
  const registry={schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}};
  const roleSpecs={schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:roles}}}};
  const content={type:'file',path:file,sha:profile.workflow_blob,size:Buffer.byteLength(text),encoding:'base64',content:Buffer.from(text).toString('base64')};
  const routes=[];const call=extra=>workflowSourceOf({...options,registry,roleSpecs,
    graphRead:async()=>payload(),read:async route=>{routes.push(route);return content;},...extra});
  assert.equal((await call()).passed,true);
  assert.ok(routes.every(route=>route.startsWith(`/repos/${repository}/contents/`)));
  for(const value of [{...content,path:'other'}, {...content,size:content.size+1},
    {...content,content:'!!!!'}, {...content,sha:'c'.repeat(40)}, {...content,type:'symlink'}])
    assert.equal((await call({read:async()=>value})).state,'unknown');
  assert.equal((await call({roleSpecs:{schema:'clued.gated-proof-role-specs/1',workflows:{[file]:roles}}})).state,'unknown');
  assert.equal((await call({registry:{...registry,workflows:{}}})).state,'unknown');
  assert.equal((await call({graphRead:async()=>{throw Error('unavailable');}})).state,'unknown');
});
test('GraphQL uses the existing token on a trusted POST endpoint only',async()=>{
  const calls=[];const fetchImpl=async(url,init)=>{calls.push({url,init});return {status:200,json:async()=>payload()};};
  const reader=githubGraphReader(fetchImpl,{GITHUB_TOKEN:'mock-token'});
  await reader('query fixture',{node:'WFR_fixture'});
  assert.equal(calls[0].url,'https://api.github.com/graphql');assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body),{query:'query fixture',variables:{node:'WFR_fixture'}});
  for(const extra of [{GITHUB_TOKEN:''},{GITHUB_GRAPHQL_URL:'https://evil.example/graphql'},
    {GITHUB_GRAPHQL_URL:'https://user@api.github.com/graphql'},{GITHUB_GRAPHQL_URL:'https://api.github.com/graphql?token=x'},
    {GITHUB_API_URL:'http://api.github.com'}]) {
    const before=calls.length;
    await assert.rejects(githubGraphReader(fetchImpl,{GITHUB_TOKEN:'mock-token',...extra})('query',{}));
    assert.equal(calls.length,before);
  }
  await assert.rejects(githubGraphReader(async()=>({status:403}),{GITHUB_TOKEN:'mock-token'})('query',{}));
});
test('shadow source observation reads the API rather than trusting event fields, and never grants execution',async()=>{
  const temporaryRoot=fs.realpathSync(os.tmpdir());
  const workspace=fs.mkdtempSync(path.join(temporaryRoot,'clued-source-observation-'));
  try {
    fs.mkdirSync(path.join(workspace,'scripts/ci'),{recursive:true});
    const text='shadow source',parsed={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]}}};
    const roles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
    const profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:roles});
    fs.writeFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-profiles.json'),JSON.stringify({
      schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}}));
    fs.writeFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-role-specs.json'),JSON.stringify({
      schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:roles}}}}));
    const completed={...run,path:file,status:'completed',conclusion:'success'};
    const content={type:'file',path:file,sha:profile.workflow_blob,size:Buffer.byteLength(text),encoding:'base64',content:Buffer.from(text).toString('base64')};
    const options={env:{GITHUB_REPOSITORY:repository},workspace,eventName:'workflow_run',
      event:{workflow_run:{id:run.id,head_sha:'forged',conclusion:'failure'}},workflows:new Map([[file,profile.workflow_blob]]),
      graphRead:async()=>payload(),read:async route=>route.includes('/contents/')?content:completed};
    const seen=await observeCompletedSource(options);
    assert.equal(seen.state,'qualified');assert.equal(seen.execution_qualified,false);assert.equal(seen.head,head);
    let reads=0;
    assert.equal((await observeCompletedSource({...options,read:async route=>route.includes('/contents/')?content:
      ++reads===1?completed:{...completed,run_attempt:3}})).state,'unknown');
    assert.equal((await observeCompletedSource({...options,read:async()=>({...completed,id:8})})).state,'not_observed');
    assert.equal((await observeCompletedSource({...options,graphRead:async()=>({errors:[{}]})})).state,'unknown');
    assert.equal((await observeCompletedSource({...options,eventName:'push',read:async()=>{throw Error('must not read');}})).state,'not_observed');
  } finally {
    const target=fs.realpathSync(workspace);
    assert.equal(path.dirname(target),temporaryRoot);
    assert.equal(target,path.resolve(workspace));
    assert.ok(path.basename(target).startsWith('clued-source-observation-'));
    fs.rmSync(target,{recursive:true,force:true});
  }
});
test('shadow budget cancels a hung read and forbids follow-up requests after expiry',async()=>{
  let resolveRead,signal,graphs=0;
  const completed={...run,path:file,status:'completed',conclusion:'success'};
  const pending=new Promise(resolve=>{resolveRead=resolve;});
  const options={env:{GITHUB_REPOSITORY:repository},eventName:'workflow_run',event:{workflow_run:{id:7}},
    workspace:fileURLToPath(new URL('../..',import.meta.url)),workflows:new Map([[file,'c'.repeat(40)]]),budgetMs:5,
    read:async(route,options)=>{signal=options.signal;return pending;},graphRead:async()=>{graphs++;return payload();}};
  const seen=await observeCompletedSource(options);
  assert.equal(seen.reason,'source observation budget exhausted');assert.equal(signal.aborted,true);
  resolveRead(completed);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(graphs,0);
  await observeCompletedSource({...options,budgetMs:1000,read:async()=>completed});
  assert.equal(graphs,1,'the valid registry path would reach GraphQL without a closed budget');
  assert.equal((await observeCompletedSource({...options,budgetMs:12001})).state,'unknown');
});
test('hung GraphQL response body is aborted within the independent shadow budget',async()=>{
  let signal;
  const graphRead=githubGraphReader(async(url,options)=>{signal=options.signal;return {
    status:200,json:async()=>new Promise(()=>{})};},{GITHUB_TOKEN:'mock-token'});
  const completed={...run,path:file,status:'completed',conclusion:'success'};
  const root=fs.realpathSync(os.tmpdir()),workspace=fs.mkdtempSync(path.join(root,'clued-source-budget-'));
  try {
    fs.mkdirSync(path.join(workspace,'scripts/ci'),{recursive:true});
    for(const name of ['profiles','role-specs'])fs.writeFileSync(path.join(workspace,`scripts/ci/clued-gated-proof-${name}.json`),'{}');
    const seen=await observeCompletedSource({env:{GITHUB_REPOSITORY:repository},eventName:'workflow_run',
      event:{workflow_run:{id:7}},workspace,workflows:new Map([[file,'c'.repeat(40)]]),budgetMs:5,
      read:async()=>completed,graphRead});
    assert.equal(seen.reason,'source observation budget exhausted');assert.equal(signal.aborted,true);
  } finally {
    const target=fs.realpathSync(workspace);assert.equal(path.dirname(target),root);
    assert.equal(target,path.resolve(workspace));assert.ok(path.basename(target).startsWith('clued-source-budget-'));
    fs.rmSync(target,{recursive:true,force:true});
  }
});
test('original slot report continues after a hanging shadow request',async()=>{
  let observedSignal,pulls=0;
  const fetchImpl=async(url,options)=>{
    if(url.endsWith('/actions/runs/7')){observedSignal=options.signal;return new Promise(()=>{});}
    if(url.includes('/pulls?')){pulls++;return {ok:true,status:200,headers:{get:()=>null},json:async()=>[]};}
    throw Error('unexpected request');
  };
  const result=await reportMergeSlots({env:{GITHUB_REPOSITORY:repository,GITHUB_TOKEN:'mock-token',
    CLUED_CONTEXT_READ_TOKEN:'mock-context-token'},workspace:fileURLToPath(new URL('../..',import.meta.url)),
    eventName:'workflow_run',event:{workflow_run:{id:7}},fetchImpl,sourceObservationBudgetMs:5});
  assert.equal(result.source_observation.reason,'source observation budget exhausted');
  assert.equal(observedSignal.aborted,true);assert.equal(pulls,1);assert.deepEqual(result.errors,[]);
});
test('complete three-dot PR diff binds head/base and both rename paths',async()=>{
  const pr={number:4,state:'open',draft:false,head:{sha:head,repo:{full_name:headRepository}},
    base:{sha,ref:'main',repo:{full_name:repository,default_branch:'main'}},changed_files:1,commits:1};
  const compare={base_commit:{sha},merge_base_commit:{sha:'c'.repeat(40)},total_commits:1,commits:[{sha:head}],
    files:[{filename:'docs/new.md',previous_filename:'scripts/old.mjs',status:'renamed'}]};
  const options={repository,prNumber:4,head,read:async route=>route.includes('/compare/')?compare:pr};
  const result=await boundPullDiff(options);
  assert.equal(result.passed,true);assert.deepEqual(result.changedFiles,['docs/new.md','scripts/old.mjs']);
  assert.equal(result.scope,'pull_diff');
  for(const edit of [p=>p.files=[],p=>delete p.files[0].previous_filename,p=>p.files[0].previous_filename='../old',
    p=>p.files[0].filename+='\n',p=>p.total_commits=2,p=>p.commits=[],p=>p.commits[0].sha=sha,p=>p.base_commit.sha=head]) {
    const altered=structuredClone(compare);edit(altered);
    assert.equal((await boundPullDiff({...options,read:async route=>route.includes('/compare/')?altered:pr})).state,'unknown');
  }
  let prReads=0;
  assert.equal((await boundPullDiff({...options,read:async route=>route.includes('/compare/')?compare:
    ++prReads===1?pr:{...pr,base:{...pr.base,sha:head}}})).state,'unknown');
  for(const edit of [p=>delete p.base.ref,p=>delete p.base.repo.default_branch,
    p=>{delete p.base.ref;delete p.base.repo.default_branch;},p=>{p.base.ref='';p.base.repo.default_branch='';}]) {
    const missing=structuredClone(pr);edit(missing);
    assert.equal((await boundPullDiff({...options,read:async route=>route.includes('/compare/')?compare:missing})).state,'unknown');
    let count=0;
    assert.equal((await boundPullDiff({...options,read:async route=>route.includes('/compare/')?compare:
      ++count===1?pr:missing})).state,'unknown');
  }
});
test('PR commit pagination must be complete and fixed across all pages',async()=>{
  const commits=Array.from({length:100},(_,i)=>({sha:(i+1).toString(16).padStart(40,'0')}));
  const pr={number:4,state:'open',draft:false,head:{sha:head,repo:{full_name:headRepository}},
    base:{sha,ref:'main',repo:{full_name:repository,default_branch:'main'}},changed_files:0,commits:101};
  const first={base_commit:{sha},merge_base_commit:{sha},total_commits:101,files:[],commits};
  const second={base_commit:{sha},merge_base_commit:{sha},total_commits:101,commits:[{sha:head}]};
  const options={repository,prNumber:4,head,read:async route=>route.includes('/compare/')?
    route.endsWith('page=1')?first:second:pr};
  assert.equal((await boundPullDiff(options)).passed,true);
  for(const alternate of [{...second,total_commits:100},{...second,commits:[]},
    {...second,merge_base_commit:{sha:head}},{...second,commits:[commits[0]]}])
    assert.equal((await boundPullDiff({...options,read:async route=>route.includes('/compare/')?
      route.endsWith('page=1')?first:alternate:pr})).state,'unknown');
});
