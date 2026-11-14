import assert from 'node:assert/strict';
import {retiredCatalogue} from './fixtures/retired-gated-proof-catalogue.mjs';
import test from 'node:test';
import {platformWorkflowSource,workflowSourceOf,githubGraphReader,observeCompletedSource,boundPullDiff,boundDocumentationRange,
  explicitNonPrWorkflow,boundWorkflowCatalog,boundRunIdentity,boundDocumentationAttempt,qualifyPrExecution,githubAttemptLogReader,
  loadProofSnapshot,readPublisherSourceSnapshot,PUBLISHER_SNAPSHOT_QUERY} from './clued-gated-proof-runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileRegisteredWorkflow,roleDefinitionDigest,workflowBlob,rolesForSource,registeredWorkflowSource,futureWorkflowSubject,external2FutureWorkflowCatalogue,parseWorkflowProfiles} from './clued-workflow-profile.mjs';
import {reportMergeSlots} from './clued-merge-slot-ci.mjs';
import {createHash} from 'node:crypto';
import {workflowJobs} from './clued-work-admission.mjs';
import {applicableCI} from './clued-gated-proof.mjs';
import {execFileSync} from 'node:child_process';
import {loadHistoricalWorkflowProfiles69e} from './fixtures/workflow-profiles-69e30b6/fixture.mjs';
const repository='o/r',headRepository='fork/r',file='.github/workflows/fixture.yml';
const sha='a'.repeat(40),head='b'.repeat(40);
const run={id:7,node_id:'WFR_fixture',run_attempt:2,event:'pull_request',head_sha:head,path:file,
  repository:{full_name:repository},head_repository:{full_name:headRepository}};
const payload=()=>({data:{node:{databaseId:7,runAttempt:2,event:'pull_request',file:{path:file,
  repositoryName:repository,repositoryFileUrl:`https://github.com/${repository}/blob/${sha}/${file}`,
  run:{databaseId:7,runAttempt:2}}}}});
const options={repository,headRepository,file,run};
const pinned='actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';

const snapshotProfile='scripts/ci/clued-gated-proof-profiles.json';
const publisherPath='scripts/ci/clued-production-publisher-sources.json';
const emptyPublisherSources={schema:'clued.production-publisher-sources/1',repository,default_branch:'main',workflows:{},roles:{}};
const qualificationPath='scripts/ci/clued-publisher-qualification-sources.json';
const emptyQualificationSources={schema:'clued.publisher-pr-qualification-sources/1',repository,default_branch:'main',workflows:{},roles:{}};
const publisherFixtureTexts={[publisherPath]:JSON.stringify(emptyPublisherSources),'scripts/ci/clued-production-publisher-source.mjs':'trusted publisher compiler',
  [qualificationPath]:JSON.stringify(emptyQualificationSources),'scripts/ci/clued-publisher-qualification-source.mjs':'trusted PR qualification compiler'};
const publisherFixtureAliases={publisherRegistry:publisherPath,publisherCompiler:'scripts/ci/clued-production-publisher-source.mjs',
  qualificationRegistry:qualificationPath,qualificationCompiler:'scripts/ci/clued-publisher-qualification-source.mjs'};
function publisherGraphFixture(query,variables,tip,texts=publisherFixtureTexts) {
  assert.equal(query,PUBLISHER_SNAPSHOT_QUERY);
  assert.deepEqual(variables,{owner:'o',name:'r',
    ...Object.fromEntries(Object.entries(publisherFixtureAliases).map(([alias,file])=>[alias,`${tip}:${file}`]))});
  return {data:{repository:{nameWithOwner:repository,...Object.fromEntries(Object.entries(publisherFixtureAliases).map(([alias,file])=>[alias,
    {__typename:'Blob',oid:workflowBlob(texts[file]),byteSize:Buffer.byteLength(texts[file]),text:texts[file],isBinary:false,isTruncated:false}]))}}};
}
const snapshotFixtureFiles={
  [snapshotProfile]:JSON.stringify({schema:'clued.gated-proof-profiles/2',workflows:{}}),
  'scripts/ci/clued-gated-proof-role-specs.json':JSON.stringify({schema:'clued.gated-proof-role-specs/2',workflows:{}}),
  'scripts/ci/clued-work-admission.mjs':'trusted gate',
  'scripts/ci/clued-docs-only.py':'trusted classifier',
  'scripts/ci/test_clued_docs_only.py':'trusted classifier tests',
  'config/merge-admission-policy.json':'trusted policy',...publisherFixtureTexts,
};
function withSnapshotFixture(overrides,check) {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'clued-proof-snapshot-bound-'));
  const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',windowsHide:true});
  try {
    for(const [file,content] of Object.entries({...snapshotFixtureFiles,...overrides})) {
      fs.mkdirSync(path.dirname(path.join(workspace,file)),{recursive:true});
      fs.writeFileSync(path.join(workspace,file),content);
    }
    git('init','--quiet');git('config','core.autocrlf','false');git('add','.');
    git('-c','user.name=CI fixture','-c','user.email=ci-fixture@example.invalid','commit','--quiet','-m','snapshot fixture');
    const tip=git('rev-parse','HEAD').trim();
    return check({workspace,tip,workflows:new Map([[file,'f'.repeat(40)]])});
  } finally {fs.rmSync(workspace,{recursive:true,force:true});}
}
const paddedSnapshot=(file,bytes)=>snapshotFixtureFiles[file]+' '.repeat(bytes-Buffer.byteLength(snapshotFixtureFiles[file]));

test('publisher snapshot batches only four fixed immutable identities and verifies all original UTF-8 bytes',async()=>{
  const tip='c'.repeat(40),texts={...publisherFixtureTexts,[publisherFixtureAliases.publisherCompiler]:'compiler: 中文\r\n'};
  const files=Object.fromEntries(Object.entries(texts).map(([file,text])=>[file,workflowBlob(text)]));
  const calls=[];
  const graphRead=async(query,variables)=>{calls.push({query,variables});return publisherGraphFixture(query,variables,tip,texts);};
  for(let n=0;n<2;n++)assert.deepEqual(await readPublisherSourceSnapshot({graphRead,repository,tip,files}),texts);
  assert.equal(calls.length,2,'a new invocation always fetches all four bytes afresh');
  assert.deepEqual(calls[0],calls[1]);
});

test('publisher snapshot rejects every partial, binary, truncated, malformed or differently bound Blob',async()=>{
  const tip='c'.repeat(40),files=Object.fromEntries(Object.entries(publisherFixtureTexts).map(([file,text])=>[file,workflowBlob(text)]));
  const response=()=>publisherGraphFixture(PUBLISHER_SNAPSHOT_QUERY,{owner:'o',name:'r',
    ...Object.fromEntries(Object.entries(publisherFixtureAliases).map(([alias,file])=>[alias,`${tip}:${file}`]))},tip);
  const call=graphRead=>readPublisherSourceSnapshot({graphRead,repository,tip,files});
  for(const alias of Object.keys(publisherFixtureAliases))for(const change of [
    node=>node.__typename='Tree',node=>node.oid='f'.repeat(40),node=>node.byteSize++,node=>node.byteSize=0,
    node=>node.byteSize=1.5,node=>node.byteSize=Number.MAX_SAFE_INTEGER+1,node=>node.byteSize=524289,
    node=>node.isBinary=true,node=>node.isBinary=null,node=>node.isTruncated=true,node=>delete node.isTruncated,
    node=>node.text=null,node=>node.text='x'.repeat(node.byteSize),node=>node.text+='\ud800']){
    const body=response();change(body.data.repository[alias]);
    assert.equal(await call(async()=>body),null,alias+': exact independently pinned bytes are required');
  }
  for(const change of [b=>b.errors=[{message:'provider unavailable'}],b=>b.errors={},b=>delete b.data,
    b=>b.data.repository=null,b=>b.data.repository.nameWithOwner='other/r',
    ...Object.keys(publisherFixtureAliases).map(alias=>b=>delete b.data.repository[alias])]){
    const body=response();change(body);assert.equal(await call(async()=>body),null);
  }
  assert.equal(await call(async()=>{throw Error('provider unavailable');}),null);
  let calls=0;const graphRead=async()=>{calls++;return response();};
  for(const extra of [{repository:'https://outside.invalid/r'},{tip:'main'},{tip:'A'.repeat(40)}])
    assert.equal(await readPublisherSourceSnapshot({graphRead,repository,tip,files,...extra}),null);
  assert.equal(calls,0,'invalid selectors cannot cause a provider call');
});

test('publisher snapshot preserves the 512 KiB per-source bound with no REST fallback',async()=>{
  const tip='c'.repeat(40),file=publisherFixtureAliases.publisherCompiler;
  for(const size of [524288,524289]){
    const texts={...publisherFixtureTexts,[file]:'a'.repeat(size)};
    const files=Object.fromEntries(Object.entries(texts).map(([name,text])=>[name,workflowBlob(text)]));
    const out=await readPublisherSourceSnapshot({repository,tip,files,
      graphRead:async(query,variables)=>publisherGraphFixture(query,variables,tip,texts)});
    assert.equal(out!==null,size===524288);
  }
});

test('whole execution refuses catalogue assertion and every initial or final publisher source drift',async()=>{
  for(const phase of [1,2])for(const alias of Object.keys(publisherFixtureAliases)){
    const world=executionWorld(),original=world.graphRead;let calls=0;
    world.graphRead=async(query,variables)=>{
      const body=await original(query,variables);
      if(query===PUBLISHER_SNAPSHOT_QUERY&&++calls===phase)body.data.repository[alias].text+='\n';
      return body;
    };
    const result=await qualifyPrExecution(world);
    assert.equal(result.state,'unknown');assert.equal(calls,phase,`fresh ${alias} barrier ${phase} was actually reached`);
  }
  const mismatch=executionWorld();mismatch.snapshot.qualificationSources={...emptyQualificationSources,schema:'caller assertion'};
  assert.equal((await qualifyPrExecution(mismatch)).state,'unknown');
});

test('exact registered dispatch publisher remains outside the PR test catalogue; unknown bytes or registry stay refused',async()=>{
  const registry=JSON.parse(fs.readFileSync(new URL('./clued-production-publisher-sources.json',import.meta.url),'utf8'));
  registry.repository=repository;
  const publisher='.github/workflows/clued-cloud-production-release.yml';
  const before=registry.workflows[publisher].sources.find(s=>!s.gated).source_yaml;
  const after=registry.workflows[publisher].sources.find(s=>s.gated).source_yaml;
  const text='catalogue fixture',parsed={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]}}};
  const roles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
  const profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:roles});
  const profiles={schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}};
  const roleSpecs={schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:roles}}}};
  const tip='c'.repeat(40),content=(p,t)=>({type:'file',path:p,sha:workflowBlob(t),encoding:'base64',size:Buffer.byteLength(t),content:Buffer.from(t).toString('base64')});
  const call=async({candidate=after,publisherRegistry=registry}={})=>{
    const read=async route=>route.includes('/contents/.github/workflows?')?
      [{type:'file',path:file,sha:profile.workflow_blob},{type:'file',path:publisher,sha:workflowBlob(route.includes('ref='+tip)?before:candidate)}]:
      content(publisher,route.includes('ref='+tip)?before:candidate);
    return boundWorkflowCatalog({read,repository,tip,head,defaultWorkflows:new Map([[file,profile.workflow_blob]]),registry:profiles,roleSpecs,publisherRegistry,
      diff:{passed:true,diffComplete:true,commits:1,changedFiles:[publisher],descriptor:{repository,head}}});
  };
  const accepted=await call();assert.equal(accepted.passed,true);
  assert.deepEqual([...accepted.workflows.keys()],[file]);
  assert.deepEqual(accepted.publisher_transitions.map(t=>t.file),[publisher]);
  for(const options of [{publisherRegistry:null},{publisherRegistry:{...registry,default_branch:'feature'}},
    {candidate:after+'\n'},{candidate:after.replaceAll('\n','\r\n')},
    {candidate:after.replace('  workflow_dispatch:','  pull_request:')},
    {candidate:after.replace('node-version: 24.19.0','node-version: 24')}])assert.equal((await call(options)).passed,false);
});

test('trusted snapshot admits the complete profile registry through 2 MiB without changing its raw source binding',()=>{
  for(const bytes of [524289,1048576,2097152]) {
    const text=paddedSnapshot(snapshotProfile,bytes);
    withSnapshotFixture({[snapshotProfile]:text},({workspace,tip,workflows})=>{
      const snapshot=loadProofSnapshot(workspace,tip,workflows);
      assert.equal(snapshot.profiles.schema,'clued.gated-proof-profiles/2');
      assert.equal(snapshot.files[snapshotProfile],workflowBlob(text));
      assert.equal(snapshot.tip,tip);
    });
  }
  withSnapshotFixture({[snapshotProfile]:paddedSnapshot(snapshotProfile,2097153)},({workspace,tip,workflows})=>{
    assert.throws(()=>loadProofSnapshot(workspace,tip,workflows),/trusted snapshot file exceeds bounds/);
  });
});

test('profile capacity successor leaves every other snapshot input bounded at 512 KiB',()=>{
  for(const file of Object.keys(snapshotFixtureFiles).filter(file=>file!==snapshotProfile)) {
    withSnapshotFixture({[file]:paddedSnapshot(file,524288)},({workspace,tip,workflows})=>{
      assert.equal(loadProofSnapshot(workspace,tip,workflows).files[file],workflowBlob(paddedSnapshot(file,524288)),file);
    });
    withSnapshotFixture({[file]:paddedSnapshot(file,524289)},({workspace,tip,workflows})=>{
      assert.throws(()=>loadProofSnapshot(workspace,tip,workflows),/trusted snapshot file exceeds bounds/,file);
    });
  }
});

test('larger profile allowance does not admit invalid UTF-8, a dirty checkout or another main tip',()=>{
  withSnapshotFixture({[snapshotProfile]:Buffer.from([0xff])},({workspace,tip,workflows})=>{
    assert.throws(()=>loadProofSnapshot(workspace,tip,workflows),/trusted snapshot file exceeds bounds/);
  });
  withSnapshotFixture({},({workspace,tip,workflows})=>{
    assert.throws(()=>loadProofSnapshot(workspace,'0'.repeat(40),workflows),/trusted default checkout unavailable/);
    fs.appendFileSync(path.join(workspace,snapshotProfile),' ');
    assert.throws(()=>loadProofSnapshot(workspace,tip,workflows),/trusted default checkout unavailable/);
  });
});

function executionWorld({conclusion='success',moveTip=false,moveSource=false,changedPR=false,lateSourceChange=null}={}) {
  const tip='c'.repeat(40),base='d'.repeat(40),sourceSha='a'.repeat(40);
  const text='name: fixture\non:\n  pull_request:\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Real primary\n        run: node actual-tests.mjs\n';
  const parsed={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{name:'Real primary',run:'node actual-tests.mjs'}]}}};
  const roles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
  const profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:roles});
  const profiles={schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}};
  const roleSpecs={schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:roles}}}};
  const texts={'scripts/ci/clued-gated-proof-profiles.json':JSON.stringify(profiles),
    'scripts/ci/clued-gated-proof-role-specs.json':JSON.stringify(roleSpecs),
    'scripts/ci/clued-work-admission.mjs':'trusted gate',
    'scripts/ci/clued-docs-only.py':'trusted classifier',
    'scripts/ci/test_clued_docs_only.py':'trusted classifier tests',
    'config/merge-admission-policy.json':'trusted policy',...publisherFixtureTexts};
  const snapshot={tip,checkout:tip,profiles,roleSpecs,publisherSources:structuredClone(emptyPublisherSources),qualificationSources:structuredClone(emptyQualificationSources),workflows:new Map([[file,profile.workflow_blob]]),
    files:Object.fromEntries(Object.entries(texts).map(([file,text])=>[file,workflowBlob(text)]))};
  const native={...run,status:'completed',conclusion,pull_requests:[{number:5}]};
  const pr={number:5,state:'open',draft:false,head:{sha:head,repo:{full_name:headRepository}},
    base:{sha:base,ref:'main',repo:{full_name:repository,default_branch:'main'}},changed_files:1,commits:1};
  const calls=[];let branches=0,pulls=0,graphs=0,late=false;
  const content=(path,text)=>({path,sha:workflowBlob(text),type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')});
  const read=async route=>{
    calls.push(route);
    if(route.endsWith('/pulls/5'))return (++pulls>2&&changedPR || late&&lateSourceChange==='pr')?{...pr,draft:true}:pr;
    if(route.includes('/branches/main'))return {commit:{sha:(++branches>1&&moveTip || late&&lateSourceChange==='main')?base:tip}};
    if(route.includes('/compare/'))return {base_commit:{sha:base},merge_base_commit:{sha:base},total_commits:1,
      commits:[{sha:head}],files:[{filename:'docs/guide.md',status:'modified'}]};
    if(route.includes('/contents/.github/workflows?'))return [{path:file,sha:profile.workflow_blob,type:'file'}];
    if(route.includes('/contents/')) {
      const path=route.split('/contents/')[1].split('?')[0];
      return content(path,path===file?text:texts[path]);
    }
    if(route.includes('/actions/runs?'))return late&&lateSourceChange==='new_run'?
      {total_count:2,workflow_runs:[native,{...native,id:9,status:'queued',conclusion:null}]}:{total_count:1,workflow_runs:[native]};
    if(route.includes('/attempts/'))return {total_count:1,jobs:[{id:8,run_id:native.id,run_attempt:native.run_attempt,
      name:'main',labels:['ubuntu-latest'],status:'completed',conclusion:'success',
      steps:[{name:'Real primary',status:'completed',conclusion:'success'}]}]};
    if(route.endsWith('/actions/runs/7'))return native;
    throw Error('unexpected read');
  };
  const graphRead=async(query,variables)=>{
    if(query===PUBLISHER_SNAPSHOT_QUERY)return publisherGraphFixture(query,variables,tip);
    const p=payload();graphs++;if(graphs>1)late=true;
    p.data.node.file.repositoryFileUrl=`https://github.com/${repository}/blob/${graphs>1&&moveSource?base:sourceSha}/${file}`;return p;
  };
  return {repository,head,prNumber:5,snapshot,read,graphRead,readLog:async()=>{throw Error('native association requires no log');},calls,pr};
}
test('shared execution bridge binds native full execution to one trusted snapshot and final source authority',async()=>{
  const good=executionWorld();assert.equal((await qualifyPrExecution(good)).passed,true);
  assert.equal((await qualifyPrExecution(executionWorld({conclusion:'failure'}))).state,'failed');
  for(const changes of [{moveTip:true},{moveSource:true},{changedPR:true},
    {conclusion:'failure',moveTip:true},{conclusion:'failure',moveSource:true},{conclusion:'failure',changedPR:true}])
    assert.equal((await qualifyPrExecution(executionWorld(changes))).state,'unknown');
  for(const lateSourceChange of ['new_run','main','pr'])for(const conclusion of ['success','failure'])
    assert.equal((await qualifyPrExecution(executionWorld({lateSourceChange,conclusion}))).state,'unknown');
  const missing=executionWorld();delete missing.snapshot.files['config/merge-admission-policy.json'];
  assert.equal((await qualifyPrExecution(missing)).state,'unknown');
  const mismatch=executionWorld();mismatch.snapshot.profiles={...mismatch.snapshot.profiles,extra:'candidate assertion'};
  assert.equal((await qualifyPrExecution(mismatch)).state,'unknown');
  const publisherMismatch=executionWorld();publisherMismatch.snapshot.publisherSources={...publisherMismatch.snapshot.publisherSources,schema:'caller asserted catalogue'};
  assert.equal((await qualifyPrExecution(publisherMismatch)).state,'unknown','publisher catalogue must match authenticated snapshot bytes');
  for(const path of [publisherPath,'scripts/ci/clued-production-publisher-source.mjs',qualificationPath,'scripts/ci/clued-publisher-qualification-source.mjs']) {
    const missing=executionWorld();delete missing.snapshot.files[path];
    assert.equal((await qualifyPrExecution(missing)).state,'unknown',path+': compiler and catalogue identity are required');
  }
});
test('authenticated snapshot revalidation uses real large-file Contents metadata and immutable Git blob bytes',async()=>{
  async function proofWithSizedSource(file,bytes,change=()=>{}) {
    const world=executionWorld(),read=world.read,original=await read(`/repos/${repository}/contents/${file}?ref=${world.snapshot.tip}`),
      source=Buffer.from(original.content,'base64').toString('utf8'),text=source+' '.repeat(bytes-Buffer.byteLength(source)),oid=workflowBlob(text),routes=[];
    world.snapshot.files[file]=oid;
    const graphRead=world.graphRead;
    world.graphRead=async(query,variables)=>query===PUBLISHER_SNAPSHOT_QUERY?
      publisherGraphFixture(query,variables,world.snapshot.tip,{...publisherFixtureTexts,[file]:text}):graphRead(query,variables);
    const large=file===snapshotProfile&&bytes>1048576,
      facts={content:{...original,sha:oid,size:bytes,encoding:large?'none':'base64',content:large?'':Buffer.from(text).toString('base64')},
        tree:{sha:'9'.repeat(40),truncated:false,tree:[{path:file,type:'blob',mode:'100644',sha:oid,size:bytes}]},
        blob:{sha:oid,size:bytes,encoding:'base64',content:Buffer.from(text).toString('base64')}};
    change(facts);
    world.read=async route=>{
      if(route===`/repos/${repository}/git/trees/${world.snapshot.tip}?recursive=1`){routes.push(route);return facts.tree;}
      if(route===`/repos/${repository}/git/blobs/${oid}`){routes.push(route);return facts.blob;}
      return route.includes(`/contents/${file}?`)?facts.content:read(route);
    };
    return {proof:await qualifyPrExecution(world),routes};
  }
  for(const bytes of [524289,1048576,1048577,2097152]) {
    const result=await proofWithSizedSource(snapshotProfile,bytes);assert.equal(result.proof.passed,true,`profile ${bytes}`);
    assert.equal(result.routes.length,bytes>1048576?4:0,'initial and final barriers keep using the same bounded reads');
  }
  assert.equal((await proofWithSizedSource(snapshotProfile,2097153)).proof.state,'unknown');
  for(const file of Object.keys(snapshotFixtureFiles).filter(file=>file!==snapshotProfile))
    assert.equal((await proofWithSizedSource(file,524289)).proof.state,'unknown',file);
  for(const change of [f=>f.content.path='scripts/ci/other.json',f=>f.content.sha='a'.repeat(40),
    f=>f.content.size++,f=>f.tree.truncated=true,f=>f.tree.tree[0].mode='120000',f=>f.tree.tree[0].sha='a'.repeat(40),
    f=>f.blob.sha='a'.repeat(40),f=>f.blob.size++,f=>delete f.blob.content,
    f=>f.blob.content=Buffer.concat([Buffer.alloc(1048576,120),Buffer.from([255])]).toString('base64')])
    assert.equal((await proofWithSizedSource(snapshotProfile,1048577,change)).proof.state,'unknown');
});

test('attempt log reader binds native job and follows only provider storage without credential forwarding',async()=>{
  const job={id:8,run_id:7,run_attempt:2,conclusion:'success'};
  const env={GITHUB_REPOSITORY:repository,GITHUB_TOKEN:'mock-private-token'};
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/jobs/8'))return new Response(JSON.stringify({...job,status:'completed'}));
    if(url.endsWith('/logs'))return new Response(null,{status:302,headers:{location:'https://productionresultssa1.blob.core.windows.net/log?signature=fixture'}});
    return new Response('complete private log\n');
  };
  const value=await githubAttemptLogReader(fetchImpl,env)(job,run);
  assert.equal(value.complete,true);assert.equal(value.job_id,8);assert.equal(value.run_attempt,2);
  assert.equal(value.text,'complete private log\n');assert.equal(calls.length,3);
  assert.equal(calls[0].init.headers.Authorization,'Bearer mock-private-token');
  assert.deepEqual(calls[2].init.headers,{});
  for(const target of ['https://evil.example/log','http://productionresultssa1.blob.core.windows.net/log',
    'https://u:p@productionresultssa1.blob.core.windows.net/log']) {
    let count=0;
    await assert.rejects(githubAttemptLogReader(async(url)=>{
      count++;return url.endsWith('/jobs/8')?new Response(JSON.stringify({...job,status:'completed'})):
        new Response(null,{status:302,headers:{location:target}});
    },env)(job,run));assert.equal(count,2);
  }
  for(const current of [{...job,status:'completed',run_attempt:1},{...job,status:'in_progress'},
    {...job,status:'completed',run_id:9},{...job,status:'completed',conclusion:'failure'}])
    await assert.rejects(githubAttemptLogReader(async()=>new Response(JSON.stringify(current)),env)(job,run));
});
test('log EOF, byte bound, interrupted body and late abort are never declared complete',async()=>{
  const job={id:8,run_id:7,run_attempt:2,conclusion:'success'},env={GITHUB_REPOSITORY:repository,GITHUB_TOKEN:'mock-token'};
  for(const body of [()=>new Response('x'.repeat(524289)),()=>new Response(new Uint8Array([0xff])),
    ()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('partial'));controller.error(Error('interrupted'));}}))]) {
    await assert.rejects(githubAttemptLogReader(async url=>url.endsWith('/jobs/8')?
      new Response(JSON.stringify({...job,status:'completed'})):body(),env)(job,run));
  }
  const controller=new AbortController();let calls=0;
  await assert.rejects(githubAttemptLogReader(async()=>{
    calls++;controller.abort();return new Response(JSON.stringify({...job,status:'completed'}));
  },env)(job,run,{signal:controller.signal}));assert.equal(calls,1);
});
test('execution bridge aborts the whole read budget and forbids late continuation requests',async()=>{
  const w=executionWorld();let resolve,calls=0,signal;
  const pending=new Promise(r=>{resolve=r;});
  const read=async(route,options)=>{calls++;signal=options.signal;return pending;};
  const result=await qualifyPrExecution({...w,read,budgetMs:5});
  assert.equal(result.state,'unknown');assert.equal(signal.aborted,true);assert.equal(calls,1);
  resolve(w.pr);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
  for(const budgetMs of [0,-1,90001,1.5])assert.equal((await qualifyPrExecution({...w,budgetMs})).state,'unknown');
});
test('empty membership gate identity requires pinned actual base checkout and current gate script bytes',async()=>{
  const base='1'.repeat(40),code='trusted gate script',blob=workflowBlob(code);
  const profile={gated:true,source_yaml:`jobs:\n  admission-gate:\n    steps:\n      - uses: ${pinned}\n        with:\n          ref: \${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}\n      - run: node scripts/ci/clued-work-admission.mjs`};
  const source={passed:true,repository,file,run_id:run.id,run_attempt:run.run_attempt,profile};
  const job={id:8,run_id:run.id,run_attempt:run.run_attempt,name:'admission-gate',status:'completed',conclusion:'success'};
  const result={mode:'gate',event:'pull_request',head_sha:head,base_sha:base,pr_ref:repository+'#5',
    enforced:true,admitted:false,verdict:'NO_ADMISSION_RUN'};
  const text=`[command]/usr/bin/git log -1 --format=%H\n${base}\n${JSON.stringify(result,null,2)}`;
  const log={complete:true,text,job_id:job.id,run_id:run.id,run_attempt:run.run_attempt};
  const content={type:'file',path:'scripts/ci/clued-work-admission.mjs',sha:blob,encoding:'base64',size:Buffer.byteLength(code),content:Buffer.from(code).toString('base64')};
  const opts={read:async()=>content,readLog:async()=>log,source,run,jobs:[job],repository,head,prNumber:5,trustedGateBlob:blob};
  assert.equal((await boundRunIdentity(opts)).scope,'pr_identity');
  for(const extra of [{trustedGateBlob:'2'.repeat(40)},{source:{...source,passed:false}},
    {source:{...source,run_attempt:1}},{prNumber:6},{jobs:[job,job]},
    {jobs:[{...job,run_attempt:1}]},{readLog:async()=>({...log,job_id:99})},
    {readLog:async()=>({...log,text:text+'\n'+JSON.stringify(result,null,2)})},
    {readLog:async()=>({...log,text:text.replace(base,'2'.repeat(40))})},
    {source:{...source,profile:{...profile,source_yaml:profile.source_yaml.replace(pinned,'actions/checkout@untrusted')}}},
    {source:{...source,profile:{...profile,source_yaml:profile.source_yaml.replace('        with:','        with:\n          path: foreign')}}}])
    assert.equal((await boundRunIdentity({...opts,...extra})).state,'unknown');
});
test('ungated source identity binds one pinned primary and the actual merge checkout parents',async()=>{
  const base='1'.repeat(40),merge='2'.repeat(40);
  const profile={gated:false,source_yaml:`jobs:\n  scan:\n    steps:\n      - uses: ${pinned}\n      - run: scan`,
    routes:[{job_id:'scan',name:'scan',self_hosted:false}]};
  const source={passed:true,repository,file,run_id:run.id,run_attempt:run.run_attempt,profile};
  const job={id:8,run_id:run.id,run_attempt:run.run_attempt,name:'scan',status:'completed',conclusion:'success',labels:['ubuntu-latest']};
  const text=`[command]/usr/bin/git checkout --progress --force refs/remotes/pull/5/merge\n[command]/usr/bin/git log -1 --format=%H\n${merge}`;
  const log={complete:true,text,job_id:job.id,run_id:run.id,run_attempt:run.run_attempt};
  const commit={sha:merge,parents:[{sha:base},{sha:head}]};
  const opts={read:async()=>commit,readLog:async()=>log,source,run,jobs:[job],repository,head,prNumber:5};
  assert.equal((await boundRunIdentity(opts)).scope,'pr_identity');
  for(const extra of [{jobs:[job,job]},{read:async()=>({...commit,parents:[{sha:head},{sha:base}]})},
    {readLog:async()=>({...log,complete:false})},{prNumber:6},
    {source:{...source,profile:{...profile,source_yaml:profile.source_yaml.replace('      - run: scan','        with:\n          ref: other\n      - run: scan')}}}])
    assert.equal((await boundRunIdentity({...opts,...extra})).state,'unknown');
});
test('documentation attempt cannot infer scope from skipped tests or an unbound result log',async()=>{
  const profile={source_yaml:`jobs:\n  quality:\n    steps:\n      - uses: ${pinned}\n      - run: app`,routes:[{job_id:'quality',name:'quality',self_hosted:true}]};
  const quality='.github/workflows/clued-cloud-quality-gate.yml';
  const source={passed:true,repository,file:quality,run_id:run.id,run_attempt:run.run_attempt,profile};
  const job={id:8,run_id:run.id,run_attempt:run.run_attempt,name:'quality',status:'completed',conclusion:'success',labels:['self-hosted'],
    steps:[...['Install from lockfile','Run npm run lint','Run npm run ledger:verify','Run npm run typecheck','Run npm run build','Run npm run test:unit']
      .map(name=>({name,status:'completed',conclusion:'skipped'})),{name:'Qualify ordinary documentation changes',status:'completed',conclusion:'success'}]};
  let reads=0;
  const opts={read:async()=>{reads++;throw Error('unexpected');},readLog:async()=>({complete:true,text:'unbound result',job_id:8,run_id:7,run_attempt:2}),
    source,run:{...run,path:quality},jobs:[job],repository,head,prNumber:5};
  assert.equal((await boundDocumentationAttempt(opts)).state,'unknown');assert.equal(reads,0);
  const failed=structuredClone(job);failed.steps.at(-1).conclusion='failure';
  assert.equal((await boundDocumentationAttempt({...opts,jobs:[failed]})).state,'unknown');
  const partial=structuredClone(job);partial.steps[0].conclusion='success';
  assert.equal((await boundDocumentationAttempt({...opts,jobs:[partial]})).state,'unknown');
});
test('unregistered workflow classification admits explicit non-PR events, but no hidden or new CI trigger',()=>{
  for(const text of ['on: workflow_dispatch\njobs:\n  work: {}',
    "name: housekeeping\non:\n  schedule:\n    - cron: '17 */6 * * *'\n  workflow_dispatch:\njobs:\n  work: {}",
    'on: [push, workflow_dispatch]\njobs: {}','on:\n  workflow_run:\n    types: [completed]\njobs: {}'])
    assert.equal(explicitNonPrWorkflow(text),true);
  for(const text of ['on: pull_request','on: [push, pull_request]',
    'on:\n  pull_request:\n  push:',"'on': [pull_request]",'on: *events',
    'on:\n  <<: *events\n  push:', 'on: {pull_request: null}',
    'on:\n  push:\n"on": [pull_request]', 'on:\n  merge_group:', 'on:\n\t pull_request:',
    'on:\n  workflow_dispatch:\n  workflow_dispatch:', 'on: [unknown_event]', 'on:\n  "pull_request":'])
    assert.equal(explicitNonPrWorkflow(text),false);
  for(const key of ['"\\u006fn"','!!str on','<<'])
    assert.equal(explicitNonPrWorkflow(`on: push\n${key}: [pull_request]\njobs: {}`),false);
});
test('complete catalogue retains counted CI when a PR deletes its gate; non-CI edits do not self-register as tests',async()=>{
  const text='catalogue source',parsed={on:{pull_request:null},jobs:{main:{'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]}}};
  const roles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
  const profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:roles});
  const registry={schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}};
  const roleSpecs={schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:roles}}}};
  const tip='c'.repeat(40),other='.github/workflows/maintenance.yml';
  const body='\njobs:\n  short:\n    runs-on: ubuntu-slim\n    timeout-minutes: 5\n    steps:\n      - run: echo short';
  const old='on: workflow_dispatch'+body,newText='on: workflow_dispatch\n# changed comment'+body;
  const content=(path,text)=>({type:'file',path,sha:workflowBlob(text),encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')});
  const directory=(otherText,primaryBlob=profile.workflow_blob)=>[{type:'file',path:file,sha:primaryBlob},
    {type:'file',path:other,sha:workflowBlob(otherText)}];
  const opts={repository,tip,head,registry,roleSpecs,defaultWorkflows:new Map([[file,profile.workflow_blob]]),
    diff:{passed:true,diffComplete:true,commits:1,changedFiles:[other],descriptor:{repository,head}}};
  const read=async route=>route.includes('/contents/.github/workflows?')?
    directory(route.includes('ref='+tip)?old:newText):content(other,route.includes('ref='+tip)?old:newText);
  const call=extra=>boundWorkflowCatalog({...opts,read,...extra});
  const good=await call();assert.equal(good.passed,true);assert.equal(good.workflows.size,1);
  assert.deepEqual([...good.workflows.keys()],[file]);
  for(const text of ['on: pull_request\njobs: {}',
    'on: workflow_dispatch\njobs:\n  admission-gate:\n    runs-on: ubuntu-slim\n    steps:\n      - run: echo gate',
    'on: workflow_dispatch\njobs:\n  short:\n    runs-on: [self-hosted, Linux]\n    timeout-minutes: 5\n    steps:\n      - run: echo short']) {
    const r=async route=>route.includes('/contents/.github/workflows?')?
      directory(route.includes('ref='+tip)?old:text):content(other,route.includes('ref='+tip)?old:text);
    assert.equal((await call({read:r})).state,'unknown');
  }
  // Removing the gate/CI source cannot shrink the independently counted set.
  assert.equal((await call({read:async route=>route.includes('ref='+tip)?directory(old):directory(newText,'d'.repeat(40))})).state,'unknown');
  assert.equal((await call({read:async route=>route.includes('ref='+tip)?directory(old):directory(newText).slice(1)})).state,'unknown');
  assert.equal((await call({read:async()=>({message:'unavailable'})})).state,'unknown');
  assert.equal((await call({diff:{...opts.diff,diffComplete:false}})).state,'unknown');
  assert.equal((await call({read:async route=>route.includes('ref='+tip)?[...directory(old),...directory(old)]:directory(newText)})).state,'unknown');
  assert.equal((await call({defaultWorkflows:new Map([[file,'e'.repeat(40)]])})).state,'unknown');
  assert.equal((await call({roleSpecs:{...roleSpecs,workflows:{}}})).state,'unknown');
  const newWorkflow=async route=>route.includes('/contents/.github/workflows?')?
    route.includes('ref='+tip)?directory(old).slice(0,1):directory(newText):content(other,newText);
  assert.equal((await call({read:newWorkflow})).passed,true);
  for(const text of ['on: pull_request'+body,'on: workflow_dispatch\njobs:\n  admission-gate:\n    runs-on: ubuntu-slim\n    steps:\n      - run: echo gate']) {
    assert.equal((await call({read:async route=>route.includes('/contents/.github/workflows?')?
      route.includes('ref='+tip)?directory(old).slice(0,1):directory(text):content(other,text)})).state,'unknown');
  }
  const oldShort='on: pull_request'+body,newShort='on: pull_request\n# changed documentation comment'+body;
  const existingShort=async route=>route.includes('/contents/.github/workflows?')?
    directory(route.includes('ref='+tip)?oldShort:newShort):content(other,route.includes('ref='+tip)?oldShort:newShort);
  assert.equal((await call({read:existingShort})).passed,true);
});

function futureExecutionWorld({trustedFuture=true,acceptance='accepted',critical='success',primary='success',
  staleAttempt=false,moveMain=false,truncateHead=false,truncateDefault=false,treeTruncated=false,
  actualSourceDiffers=false,alreadyInstalled=false,gateHashDiffers=false,defaultBranch='main',sourceRegistries=null}={}) {
  // The handover qualification Sources are retired; the last catalogue that registered them supplies the future entry.
  const retired=sourceRegistries?null:retiredCatalogue();
  const w=executionWorld(),saved=sourceRegistries?structuredClone(sourceRegistries.profiles):retired.registry;
  const savedRoles=sourceRegistries?structuredClone(sourceRegistries.roleSpecs):retired.specs;
  const consumer_id='company-linux-01',futureFile=`.github/workflows/clued-work-handover-qualification-${consumer_id}.yml`;
  const registered=saved.future_workflows?.find(entry=>entry.file===futureFile),profile=structuredClone(
    registered?.source_profile??saved.workflows[futureFile]);
  const independent=structuredClone(registered?savedRoles.future_workflows.find(role=>role.file===futureFile).roles:
    savedRoles.workflows[futureFile].sources[profile.workflow_blob]);
  const definition=structuredClone(registered?.workflow_definition??{on:{pull_request:profile.pull_request},jobs:{'admission-gate':{},
    ...Object.fromEntries(independent.map(role=>[role.job_id,role.definition]))}});
  const entry=registered?structuredClone(registered):{file:futureFile,consumer_id,registration_status:'accepted_not_installed',
    purpose:'work_handover_consumer_qualification',source_profile:profile,workflow_definition:definition,
    exact_source_acceptance_scope:{repository,default_branch:'main',operation:'new_workflow_file_installation',file:futureFile,
      purpose:'work_handover_consumer_qualification',consumer_id,workflow_blob:profile.workflow_blob,source_sha256:profile.source_sha256,
      primary_ids:profile.primary_ids,roles:independent.map(({job_id,definition_sha256})=>({job_id,definition_sha256})),
      command_digests:profile.routes.map(({job_id,command_digests})=>({job_id,command_digests})),
      workflow_definition_sha256:roleDefinitionDigest(definition),frozen_gate_sha256:createHash('sha256')
        .update(workflowJobs(profile.source_yaml).find(job=>job.name==='admission-gate').lines.join('\n')).digest('hex')}};
  const roles={file:futureFile,workflow_blob:profile.workflow_blob,roles:independent};
  entry.exact_source_acceptance_scope.repository=repository;
  if(gateHashDiffers)entry.exact_source_acceptance_scope.frozen_gate_sha256='a'.repeat(64);
  entry.source_acceptance={status:acceptance,authority:'owner',
    decision_ref:'clued:decision:11111111-1111-4111-8111-111111111111@v1',
    receipt_id:'22222222-2222-4222-8222-222222222222',subject_sha256:futureWorkflowSubject(entry,roles.roles)};
  const profiles=w.snapshot.profiles,roleSpecs=w.snapshot.roleSpecs;
  profiles.future_workflows=trustedFuture?[entry]:[];roleSpecs.future_workflows=trustedFuture?[roles]:[];
  const texts={'scripts/ci/clued-gated-proof-profiles.json':JSON.stringify(profiles),
    'scripts/ci/clued-gated-proof-role-specs.json':JSON.stringify(roleSpecs),
    'scripts/ci/clued-work-admission.mjs':'trusted gate','scripts/ci/clued-docs-only.py':'trusted classifier',
    'scripts/ci/test_clued_docs_only.py':'trusted classifier tests','config/merge-admission-policy.json':'trusted policy',...publisherFixtureTexts};
  w.snapshot.files=Object.fromEntries(Object.entries(texts).map(([name,text])=>[name,workflowBlob(text)]));
  const futureText=entry.source_profile.source_yaml+(actualSourceDiffers?'\n# unaccepted bytes\n':''),futureBlob=workflowBlob(futureText);
  const originalProfile=profiles.workflows[file],activeEntry={path:file,sha:originalProfile.workflow_blob,type:'file'};
  const futureEntry={path:entry.file,sha:futureBlob,type:'file'};
  const defaultDirectory=[activeEntry,...(alreadyInstalled?[futureEntry]:[])],headDirectory=[activeEntry,futureEntry];
  const directoryBody=values=>values.map(value=>({...value}));
  const native={...run,status:'completed',conclusion:'success',pull_requests:[{number:5}]};
  const futureRun={...native,id:17,node_id:'WFR_future',path:entry.file};
  const content=(name,text)=>({path:name,sha:workflowBlob(text),type:'file',encoding:'base64',
    size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')});
  const trees=new Map();
  const treeBody=(sha,tree)=>({sha,truncated:treeTruncated,tree});
  for(const [commit,directory,offset] of [[w.snapshot.tip,defaultDirectory,3],[head,headDirectory,6]]) {
    const ids=[offset,offset+1,offset+2].map(n=>String(n).repeat(40));
    trees.set('commit:'+commit,{sha:commit,tree:{sha:ids[0]}});
    trees.set(ids[0],treeBody(ids[0],[{path:'.github',type:'tree',mode:'040000',sha:ids[1]}]));
    trees.set(ids[1],treeBody(ids[1],[{path:'workflows',type:'tree',mode:'040000',sha:ids[2]}]));
    trees.set(ids[2],treeBody(ids[2],directory.map(value=>({path:value.path.split('/').at(-1),type:'blob',mode:'100644',sha:value.sha}))));
  }
  const baseRead=w.read;let branches=0;
  w.read=async route=>{
    w.calls.push(route);
    if(route.includes('/branches/'+defaultBranch))return {commit:{sha:++branches>1&&moveMain?'d'.repeat(40):w.snapshot.tip}};
    if(route.endsWith('/pulls/5'))return {...w.pr,changed_files:1,base:{...w.pr.base,ref:defaultBranch,
      repo:{...w.pr.base.repo,default_branch:defaultBranch}}};
    if(route.includes('/compare/'))return {base_commit:{sha:w.pr.base.sha},merge_base_commit:{sha:w.pr.base.sha},total_commits:1,
      commits:[{sha:head}],files:[{filename:entry.file,status:'added'}]};
    if(route.includes('/contents/.github/workflows?')) {
      const atDefault=route.includes('ref='+w.snapshot.tip),values=atDefault?defaultDirectory:headDirectory;
      return directoryBody(atDefault&&truncateDefault?values.slice(1):!atDefault&&truncateHead?values.slice(0,1):values);
    }
    if(route.includes('/git/commits/'))return trees.get('commit:'+route.split('/').at(-1));
    if(route.includes('/git/trees/'))return trees.get(route.split('/').at(-1));
    if(route.includes('/contents/')) {
      const name=route.split('/contents/')[1].split('?')[0];
      if(name===entry.file)return content(name,futureText);
      if(Object.hasOwn(texts,name))return content(name,texts[name]);
      return baseRead(route);
    }
    if(route.includes('/actions/runs?'))return {total_count:2,workflow_runs:[native,futureRun]};
    if(route.includes(`/actions/runs/${futureRun.id}/attempts/`))return {total_count:2,jobs:[
      {id:18,run_id:17,run_attempt:2,name:'admission-gate',status:'completed',conclusion:'success',labels:['self-hosted']},
      {id:19,run_id:17,run_attempt:2,name:entry.source_profile.routes[0].name,status:'completed',conclusion:primary,
        labels:['self-hosted'],steps:Object.entries(entry.source_profile.routes[0].required_steps)
          .flatMap(([name,count])=>Array.from({length:count},()=>({name,status:'completed',conclusion:critical})))}]};
    if(route.endsWith('/actions/runs/17'))return staleAttempt?{...futureRun,run_attempt:3}:futureRun;
    if(route.endsWith('/actions/runs/7'))return native;
    return baseRead(route);
  };
  w.graphRead=async(query,variables)=>{
    if(query===PUBLISHER_SNAPSHOT_QUERY)return publisherGraphFixture(query,variables,w.snapshot.tip);
    const {node}=variables;
    if(node!=='WFR_future')return payload();
    return {data:{node:{databaseId:17,runAttempt:2,event:'pull_request',file:{path:entry.file,repositoryName:repository,
      repositoryFileUrl:`https://github.com/${repository}/blob/${head}/${entry.file}`,run:{databaseId:17,runAttempt:2}}}}};
  };
  return {...w,entry,roleEntry:roles,trees};
}
test('accepted not-installed default Source qualifies a new exact workflow through the existing full execution proof',async()=>{
  const w=futureExecutionWorld(),proof=await qualifyPrExecution(w);
  assert.equal(proof.passed,true);assert.equal(proof.observation_context.workflow_files.length,2);
  assert.ok(proof.observation_context.workflow_files.includes(w.entry.file));
  assert.equal(w.snapshot.workflows.size,1,'future enrollment does not change the active default CI count');
  assert.ok(w.calls.some(route=>route.includes('/git/trees/')));
  assert.equal(w.calls.some(route=>route.endsWith('/contents/scripts/ci/clued-gated-proof-profiles.json?ref='+head)),false,
    'head registry cannot provide Source trust');
});
test('head self-enrollment, missing/revoked acceptance, existing files and non-exact future bytes remain unknown',async()=>{
  for(const settings of [{trustedFuture:false},{acceptance:'candidate'},{acceptance:'revoked'},
    {actualSourceDiffers:true},{alreadyInstalled:true},{gateHashDiffers:true},{defaultBranch:'trunk'}])
    assert.equal((await qualifyPrExecution(futureExecutionWorld(settings))).state,'unknown');
});
test('future directory proof rejects contents omission, truncated trees and hidden additional workflow files',async()=>{
  for(const settings of [{truncateHead:true},{truncateDefault:true},{treeTruncated:true}])
    assert.equal((await qualifyPrExecution(futureExecutionWorld(settings))).state,'unknown');
  const hidden=futureExecutionWorld(),tree=hidden.trees.get('8'.repeat(40));
  tree.tree.push({path:'hidden.yml',type:'blob',mode:'100644',sha:'f'.repeat(40)});
  assert.equal((await qualifyPrExecution(hidden)).state,'unknown');
});
test('future enrollment never qualifies skipped execution, an old attempt or a changed final default tip',async()=>{
  for(const settings of [{critical:'skipped'},{critical:'neutral'},{primary:'skipped'},
    {staleAttempt:true},{moveMain:true}])assert.equal((await qualifyPrExecution(futureExecutionWorld(settings))).passed,false);
});

function sevenConsumerExecutionWorld({moveMain=false,sourceRegistries=null}={}) {
  const historical=sourceRegistries?null:loadHistoricalWorkflowProfiles69e();
  const profiles=sourceRegistries?structuredClone(sourceRegistries.profiles):parseWorkflowProfiles(historical.profilesRaw);
  const roleSpecs=sourceRegistries?structuredClone(sourceRegistries.roleSpecs):JSON.parse(historical.rolesRaw);
  // This fixture reconstructs the predecessor seven-only installation.
  // Current default External2 futures do not belong to its old 13+future7 Source.
  delete profiles.external2_future_workflows;delete roleSpecs.external2_future_workflows;
  // A current active22 catalogue must not leak its later External2 Sources
  // into the independently reconstructed predecessor13 + readonly future7.
  for(const file of ['.github/workflows/clued-handover-external-qualification.yml',
    '.github/workflows/clued-handover-disposable-idle.yml']){
    delete profiles.workflows[file];delete roleSpecs.workflows[file];
  }
  const tip='c'.repeat(40),base='d'.repeat(40),merge='e'.repeat(40);
  const promoted=!(profiles.future_workflows?.length);
  if(promoted) {
    // Preserve the same fixture after the separately governed active promotion.
    const one=futureExecutionWorld({sourceRegistries:{profiles,roleSpecs}}).entry;
    profiles.future_workflows=[];roleSpecs.future_workflows=[];
    for(const consumer_id of ['company-linux-01','company-linux-02','company-linux-03','company-linux-04',
      'home-linux-01','company-win-01','home-win-01']) {
      const name=`.github/workflows/clued-work-handover-qualification-${consumer_id}.yml`,p=profiles.workflows[name];
      const roles=roleSpecs.workflows[name].sources[p.workflow_blob];
      const definition={on:{pull_request:p.pull_request},jobs:{'admission-gate':{},...Object.fromEntries(roles.map(role=>[role.job_id,role.definition]))}};
      const entry={...structuredClone(one),file:name,consumer_id,source_profile:p,workflow_definition:definition,
        exact_source_acceptance_scope:{...structuredClone(one.exact_source_acceptance_scope),file:name,consumer_id,
          workflow_blob:p.workflow_blob,source_sha256:p.source_sha256,primary_ids:p.primary_ids,
          roles:roles.map(({job_id,definition_sha256})=>({job_id,definition_sha256})),
          command_digests:p.routes.map(({job_id,command_digests})=>({job_id,command_digests})),
          workflow_definition_sha256:roleDefinitionDigest(definition)}};
      profiles.future_workflows.push(entry);roleSpecs.future_workflows.push({file:name,workflow_blob:p.workflow_blob,roles});
      delete profiles.workflows[name];delete roleSpecs.workflows[name];
    }
  }
  for(const entry of profiles.future_workflows) {
    const roles=roleSpecs.future_workflows.find(role=>role.file===entry.file).roles;
    entry.exact_source_acceptance_scope.repository=repository;
    entry.source_acceptance={status:'accepted',authority:'owner',
      decision_ref:'clued:decision:11111111-1111-4111-8111-111111111111@v1',
      receipt_id:'22222222-2222-4222-8222-222222222222',subject_sha256:futureWorkflowSubject(entry,roles)};
  }
  const workflows=new Map(Object.entries(profiles.workflows).map(([name,p])=>[name,p.workflow_blob]));
  const texts={'scripts/ci/clued-gated-proof-profiles.json':JSON.stringify(profiles),
    'scripts/ci/clued-gated-proof-role-specs.json':JSON.stringify(roleSpecs),'scripts/ci/clued-work-admission.mjs':'trusted gate',
    'scripts/ci/clued-docs-only.py':'trusted classifier','scripts/ci/test_clued_docs_only.py':'trusted classifier tests',
    'config/merge-admission-policy.json':'trusted policy',...publisherFixtureTexts};
  const snapshot={tip,checkout:tip,profiles,roleSpecs,publisherSources:structuredClone(emptyPublisherSources),qualificationSources:structuredClone(emptyQualificationSources),workflows,
    files:Object.fromEntries(Object.entries(texts).map(([name,text])=>[name,workflowBlob(text)]))};
  const all={...profiles.workflows,...Object.fromEntries(profiles.future_workflows.map(entry=>[entry.file,entry.source_profile]))};
  const changedFiles=[...profiles.future_workflows.map(entry=>entry.file),'scripts/ci/clued-gated-proof-profiles.json',
    'scripts/ci/clued-gated-proof-role-specs.json','.github/workflows/clued-merge-slot-ci.yml','.github/actions/ci-temporary-storage/coverage.json'];
  const targets=applicableCI({workflows:new Map(Object.entries(all).map(([name,p])=>[name,p.workflow_blob])),
    profiles:{workflows:all},changedFiles,commits:1,diffComplete:true,sourceQualified:true}).workflows;
  assert.equal(workflows.size,13);assert.equal(targets.size,12);
  const runs=[...targets].map(([name],i)=>({...run,id:100+i,node_id:'WFR_'+i,path:name,status:'completed',conclusion:'success',pull_requests:[]}));
  const jobs=new Map(runs.map(native=>{
    const profile=all[native.path],entries=profile.routes.map((route,i)=>({id:native.id*10+i+1,run_id:native.id,run_attempt:2,
      name:route.name,labels:route.self_hosted?['self-hosted']:['ubuntu-latest'],status:'completed',conclusion:i?'skipped':'success',
      steps:i?[]:Object.entries(route.required_steps).flatMap(([name,count])=>Array.from({length:count},()=>({name,status:'completed',conclusion:'success'})))}));
    if(profile.gated)entries.push({id:native.id*10,run_id:native.id,run_attempt:2,name:'admission-gate',status:'completed',
      conclusion:'success',labels:['self-hosted']});
    return [native.id,entries];
  }));
  const defaultDirectory=[...workflows].map(([path,sha])=>({path,sha,type:'file'}));
  const headDirectory=Object.entries(all).map(([path,p])=>({path,sha:p.workflow_blob,type:'file'}));
  const trees=new Map();
  for(const [commit,directory,offset] of [[tip,defaultDirectory,3],[head,headDirectory,6]]) {
    const ids=[offset,offset+1,offset+2].map(n=>String(n).repeat(40));trees.set('commit:'+commit,{sha:commit,tree:{sha:ids[0]}});
    trees.set(ids[0],{sha:ids[0],truncated:false,tree:[{path:'.github',type:'tree',mode:'040000',sha:ids[1]}]});
    trees.set(ids[1],{sha:ids[1],truncated:false,tree:[{path:'workflows',type:'tree',mode:'040000',sha:ids[2]}]});
    trees.set(ids[2],{sha:ids[2],truncated:false,tree:directory.map(value=>({path:value.path.split('/').at(-1),sha:value.sha,type:'blob',mode:'100644'}))});
  }
  const content=(name,text)=>({path:name,sha:workflowBlob(text),type:'file',encoding:'base64',size:Buffer.byteLength(text),
    content:Buffer.from(text).toString('base64')});
  const pr={number:5,state:'open',draft:false,head:{sha:head,repo:{full_name:headRepository}},
    base:{sha:base,ref:'main',repo:{full_name:repository,default_branch:'main'}},changed_files:changedFiles.length,commits:1};
  let reads=0,graphs=0,publisherGraphs=0,logs=0,branches=0;const sourceContentReads=new Map();
  const read=async route=>{
    reads++;
    if(route.endsWith('/pulls/5'))return pr;
    if(route.includes('/branches/main'))return {commit:{sha:++branches>1&&moveMain?base:tip}};
    if(route.includes('/compare/'))return {base_commit:{sha:base},merge_base_commit:{sha:base},total_commits:1,
      commits:[{sha:head}],files:changedFiles.map(filename=>({filename,status:filename.endsWith('.yml')?'added':'modified'}))};
    if(route.includes('/contents/.github/workflows?'))return route.includes('ref='+tip)?defaultDirectory:headDirectory;
    if(route.includes('/git/commits/'))return route.endsWith(merge)?{sha:merge,parents:[{sha:base},{sha:head}]}:trees.get('commit:'+route.split('/').at(-1));
    if(route.includes('/git/trees/'))return trees.get(route.split('/').at(-1));
    if(route.includes('/contents/')) {
      const name=route.split('/contents/')[1].split('?')[0];
      sourceContentReads.set(route,(sourceContentReads.get(route)??0)+1);
      return content(name,Object.hasOwn(texts,name)?texts[name]:all[name].source_yaml);
    }
    if(route.includes('/actions/runs?'))return {total_count:runs.length,workflow_runs:runs};
    const id=Number(/\/actions\/runs\/(\d+)/.exec(route)?.[1]);
    if(route.includes('/attempts/'))return {total_count:jobs.get(id).length,jobs:jobs.get(id)};
    return runs.find(native=>native.id===id);
  };
  const graphRead=async(query,variables)=>{
    if(query===PUBLISHER_SNAPSHOT_QUERY){publisherGraphs++;return publisherGraphFixture(query,variables,tip);}
    const {node}=variables;
    graphs++;const native=runs.find(value=>value.node_id===node);
    return {data:{node:{databaseId:native.id,runAttempt:2,event:'pull_request',file:{path:native.path,repositoryName:repository,
      repositoryFileUrl:`https://github.com/${repository}/blob/${head}/${native.path}`,run:{databaseId:native.id,runAttempt:2}}}}};
  };
  const readLog=async(job,native)=>{
    logs++;let text;
    if(job.name==='admission-gate')text=`[command]/usr/bin/git log -1 --format=%H\n${base}\n${JSON.stringify({mode:'gate',event:'pull_request',
      head_sha:head,base_sha:base,pr_ref:repository+'#5',enforced:true,admitted:true,verdict:'ADMITTED'},null,2)}`;
    else text=`[command]/usr/bin/git checkout --progress --force refs/remotes/pull/5/merge\n[command]/usr/bin/git log -1 --format=%H\n${merge}`;
    return {complete:true,text,job_id:job.id,run_id:native.id,run_attempt:2};
  };
  return {repository,head,prNumber:5,snapshot,read,graphRead,readLog,sourceContentReads,counts:()=>({reads,graphs,publisherGraphs,logs,total:reads+graphs+publisherGraphs+logs})};
}

test('inactive External2 arrays preserve predecessor-only worlds; malformed or mixed enrollment still refuses',()=>{
  const root=()=>({schema:'clued.gated-proof-profiles/2',workflows:{},future_workflows:Array(7).fill({})});
  const roles=()=>({schema:'clued.gated-proof-role-specs/2',workflows:{},future_workflows:Array(7).fill({})});
  assert.equal(external2FutureWorkflowCatalogue(root(),roles()).passed,true,'absent External2 is inactive');
  const emptyRoot=root(),emptyRoles=roles();emptyRoot.external2_future_workflows=[];emptyRoles.external2_future_workflows=[];
  assert.equal(external2FutureWorkflowCatalogue(emptyRoot,emptyRoles).passed,true,'explicit empty External2 is inactive');
  for(const wrong of [null,undefined,false,0,{},'[]']){
    const badRoot=root();badRoot.external2_future_workflows=wrong;
    assert.equal(external2FutureWorkflowCatalogue(badRoot,roles()).passed,false,'wrong profile array type must refuse');
    const badRoles=roles();badRoles.external2_future_workflows=wrong;
    assert.equal(external2FutureWorkflowCatalogue(root(),badRoles).passed,false,'wrong role array type must refuse');
  }
  const mismatched=root();mismatched.external2_future_workflows=[{}];
  assert.equal(external2FutureWorkflowCatalogue(mismatched,roles()).passed,false,'one-sided nonempty pair refuses');
  const mixed=root(),mixedRoles=roles();
  mixed.workflows=Object.fromEntries(Array.from({length:13},(_,i)=>['old-'+i,{}]));
  mixedRoles.workflows=structuredClone(mixed.workflows);
  mixed.external2_future_workflows=[{},{}];mixedRoles.external2_future_workflows=[{},{}];
  const rejected=external2FutureWorkflowCatalogue(mixed,mixedRoles);
  assert.equal(rejected.passed,false,'genuine nonempty External2 cannot coexist with predecessor13/future7');
  assert.equal(rejected.reason,'External2 requires the accepted seven already promoted to active twenty');
});


test('active22 is preserved while the predecessor fixture reconstructs exactly thirteen plus readonly seven',()=>{
  const historical=loadHistoricalWorkflowProfiles69e(),profiles=parseWorkflowProfiles(historical.profilesRaw);
  const roleSpecs=JSON.parse(historical.rolesRaw);
  const exactFiles=['.github/workflows/clued-handover-external-qualification.yml','.github/workflows/clued-handover-disposable-idle.yml'];
  if(Object.keys(profiles.workflows).length===20){
    assert.deepEqual(profiles.external2_future_workflows.map(entry=>entry.file).sort(),[...exactFiles].sort());
    for(const entry of profiles.external2_future_workflows){
      profiles.workflows[entry.file]=structuredClone(entry.source_profile);
      const fullRoles=roleSpecs.external2_future_workflows.find(role=>role.file===entry.file&&role.workflow_blob===entry.source_profile.workflow_blob).roles;
      roleSpecs.workflows[entry.file]={sources:{[entry.source_profile.workflow_blob]:structuredClone(fullRoles)}};
    }
    profiles.external2_future_workflows=[];roleSpecs.external2_future_workflows=[];
  }
  assert.equal(Object.keys(profiles.workflows).length,22);assert.equal(Object.keys(roleSpecs.workflows).length,22);
  const original=structuredClone({profiles,roleSpecs});
  const world=sevenConsumerExecutionWorld({sourceRegistries:{profiles,roleSpecs}});
  assert.deepEqual({profiles,roleSpecs},original,'fixture reconstruction never mutates the actual22 catalogue');
  assert.equal(world.snapshot.workflows.size,13);
  assert.equal(Object.keys(world.snapshot.profiles.workflows).length,13);assert.equal(Object.keys(world.snapshot.roleSpecs.workflows).length,13);
  assert.equal(world.snapshot.profiles.future_workflows.length,7);assert.equal(world.snapshot.roleSpecs.future_workflows.length,7);
  for(const file of exactFiles){assert.equal(Object.hasOwn(world.snapshot.profiles.workflows,file),false);assert.equal(Object.hasOwn(world.snapshot.roleSpecs.workflows,file),false);}
  assert.equal(external2FutureWorkflowCatalogue(profiles,roleSpecs).passed,true,'actual22 inactive-future catalogue remains valid');
  for(const wrong of [null,undefined,false,0,{},'[]']){
    const bad=structuredClone(profiles);bad.external2_future_workflows=wrong;
    assert.equal(external2FutureWorkflowCatalogue(bad,roleSpecs).passed,false,'actual22 wrong profile array type still refuses');
    const badRoles=structuredClone(roleSpecs);badRoles.external2_future_workflows=wrong;
    assert.equal(external2FutureWorkflowCatalogue(profiles,badRoles).passed,false,'actual22 wrong role array type still refuses');
  }
});

test('all seven future consumers and five existing workflows fit the unchanged request budget with empty native membership',async t=>{
  const w=sevenConsumerExecutionWorld(),proof=await qualifyPrExecution(w);
  assert.equal(proof.passed,true,JSON.stringify({proof,counts:w.counts()}));
  assert.equal(proof.observation_context.workflow_files.length,12);
  assert.equal(w.counts().logs,12);assert.equal(w.counts().graphs,24,'platform Source identity is re-read for every final run');
  assert.equal(w.counts().publisherGraphs,2,'publisher bytes are fetched freshly at both barriers');
  assert.ok(w.counts().total<=160);
  t.diagnostic(JSON.stringify({guarded_reads:w.counts(),applicable_workflows:12,empty_memberships:12}));
  const gateReads=[...w.sourceContentReads].filter(([route])=>route.endsWith('/contents/scripts/ci/clued-work-admission.mjs?ref='+'d'.repeat(40)));
  assert.equal(gateReads[0][1],1,'only one immutable verified checkout Source read is shared within this observation');
  assert.equal((await qualifyPrExecution(sevenConsumerExecutionWorld({moveMain:true}))).state,'unknown');
});
test('documentation independently reconstructs old event-base to actual merge checkout and regular file modes',async()=>{
  const eventBase='1'.repeat(40),firstParent='2'.repeat(40),checkout='3'.repeat(40);
  const baseTree='4'.repeat(40),mergeTree='5'.repeat(40),blob='6'.repeat(40);
  const trustedSources={'scripts/ci/clued-docs-only.py':'7'.repeat(40),'scripts/ci/test_clued_docs_only.py':'8'.repeat(40)};
  const sourceEntries=Object.entries(trustedSources).map(([path,sha])=>({path,sha,type:'blob',mode:'100644'}));
  const normal={path:'docs/guide.md',sha:blob,type:'blob',mode:'100644'};
  const replies={
    [`/repos/${repository}/git/commits/${checkout}`]:{sha:checkout,parents:[{sha:firstParent},{sha:head}],tree:{sha:mergeTree}},
    [`/repos/${repository}/git/commits/${eventBase}`]:{sha:eventBase,tree:{sha:baseTree}},
    [`/repos/${repository}/compare/${eventBase}...${firstParent}?per_page=1`]:{base_commit:{sha:eventBase},merge_base_commit:{sha:eventBase}},
    [`/repos/${repository}/compare/${eventBase}...${checkout}?per_page=1`]:{base_commit:{sha:eventBase},merge_base_commit:{sha:eventBase},total_commits:2,
      files:[{filename:normal.path,status:'modified'}]},
    [`/repos/${repository}/git/trees/${baseTree}?recursive=1`]:{sha:baseTree,truncated:false,tree:[normal,...sourceEntries]},
    [`/repos/${repository}/git/trees/${mergeTree}?recursive=1`]:{sha:mergeTree,truncated:false,tree:[normal,...sourceEntries]}
  };
  const opts={repository,head,eventBase,checkout,checkoutQualified:true,trustedSources};
  const call=extra=>boundDocumentationRange({...opts,read:async route=>structuredClone(replies[route]),...extra});
  assert.equal((await call()).passed,true);
  const quality='.github/workflows/clued-cloud-quality-gate.yml';
  const docRun={...run,path:quality},docProfile={source_yaml:`jobs:\n  quality:\n    steps:\n      - uses: ${pinned}\n      - run: app`,
    routes:[{job_id:'quality',name:'quality',self_hosted:true}]};
  const docSource={passed:true,repository,file:quality,run_id:run.id,run_attempt:run.run_attempt,profile:docProfile};
  const docJob={id:8,run_id:run.id,run_attempt:run.run_attempt,name:'quality',status:'completed',conclusion:'success',labels:['self-hosted'],
    steps:['Install from lockfile','Run npm run lint','Run npm run ledger:verify','Run npm run typecheck','Run npm run build','Run npm run test:unit']
      .map(name=>({name,status:'completed',conclusion:'skipped'})).concat({name:'Qualify ordinary documentation changes',status:'completed',conclusion:'success'})};
  const docResult={qualification:'DOCUMENTATION_ONLY',run_full:false,full_app_tests:false,repository,base_sha:eventBase,checkout_sha:checkout,changed_count:1};
  const docLog={complete:true,job_id:8,run_id:run.id,run_attempt:run.run_attempt,
    text:`[command]/usr/bin/git checkout --progress --force refs/remotes/pull/5/merge\n[command]/usr/bin/git log -1 --format=%H\n${checkout}\n${JSON.stringify(docResult)}`};
  const attempt={read:async route=>structuredClone(replies[route]),readLog:async()=>docLog,source:docSource,run:docRun,jobs:[docJob],
    repository,head,prNumber:5,trustedSources};
  assert.equal((await boundDocumentationAttempt(attempt)).scope,'documentation');
  for(const edit of [r=>r.changed_count=2,r=>r.full_app_tests=true,r=>r.repository='other/repo',r=>r.checkout_sha=head]) {
    const result=structuredClone(docResult);edit(result);
    assert.equal((await boundDocumentationAttempt({...attempt,readLog:async()=>({...docLog,
      text:docLog.text.replace(JSON.stringify(docResult),JSON.stringify(result))})})).state,'unknown');
  }
  const duplicate=structuredClone(docJob);duplicate.steps.push({...duplicate.steps[0],conclusion:'success'});
  assert.equal((await boundDocumentationAttempt({...attempt,jobs:[duplicate]})).state,'unknown');
  assert.equal((await boundDocumentationAttempt({...attempt,readLog:async()=>({...docLog,run_attempt:1})})).state,'unknown');
  assert.equal((await boundDocumentationAttempt({...attempt,readLog:async()=>({...docLog,
    text:docLog.text+'\n'+JSON.stringify(docResult)})})).state,'unknown');
  assert.equal((await call({checkoutQualified:false})).state,'unknown');
  assert.equal((await call({trustedSources:{}})).state,'unknown');
  const treeRoute=`/repos/${repository}/git/trees/${mergeTree}?recursive=1`;
  const compareRoute=`/repos/${repository}/compare/${eventBase}...${checkout}?per_page=1`;
  for(const edit of [r=>r[treeRoute].truncated=true,r=>r[treeRoute].tree[0].mode='100755',
    r=>r[treeRoute].tree[0].mode='120000',r=>r[treeRoute].tree[1].sha=blob,
    r=>r[treeRoute].tree.push(normal),r=>r[compareRoute].files=[],
    r=>r[compareRoute].files[0].filename='docs/contracts/authority.md',
    r=>r[compareRoute].files[0]={filename:normal.path,status:'renamed',previous_filename:'src/secret.js'},
    r=>r[`/repos/${repository}/compare/${eventBase}...${firstParent}?per_page=1`].merge_base_commit.sha=firstParent,
    r=>r[`/repos/${repository}/git/commits/${checkout}`].parents[1].sha=firstParent]) {
    const changed=structuredClone(replies);edit(changed);
    assert.equal((await call({read:async route=>changed[route]})).state,'unknown');
  }
  for(const absentSide of [baseTree,mergeTree]) {
    const changed=structuredClone(replies);
    changed[`/repos/${repository}/git/trees/${absentSide}?recursive=1`].tree=sourceEntries;
    assert.equal((await call({read:async route=>changed[route]})).passed,true);
  }
  const renamed=structuredClone(replies);
  renamed[compareRoute].files[0]={filename:normal.path,status:'renamed',previous_filename:'docs/old.md'};
  renamed[`/repos/${repository}/git/trees/${baseTree}?recursive=1`].tree[0]={...normal,path:'docs/old.md'};
  assert.equal((await call({read:async route=>renamed[route]})).changed_count,2);
});
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
test('source shadow observes a bounded identity log without granting execution or disclosing source text',async()=>{
  const temporaryRoot=fs.realpathSync(os.tmpdir()),workspace=fs.mkdtempSync(path.join(temporaryRoot,'clued-identity-observation-'));
  try {
    fs.mkdirSync(path.join(workspace,'scripts/ci'),{recursive:true});
    const code='trusted gate script',blob=workflowBlob(code),base='1'.repeat(40);
    fs.writeFileSync(path.join(workspace,'scripts/ci/clued-work-admission.mjs'),code);
    const text=`on:\n  pull_request:\njobs:\n  admission-gate:\n    steps:\n      - uses: ${pinned}\n        with:\n          ref: \${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}\n      - run: node scripts/ci/clued-work-admission.mjs\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n`;
    const parsed={on:{pull_request:null},jobs:{'admission-gate':{steps:[]},main:{'runs-on':'ubuntu-latest',steps:[{run:'node --test'}]}}};
    const roles=[{job_id:'main',definition_sha256:roleDefinitionDigest(parsed.jobs.main)}];
    const profile=compileRegisteredWorkflow(text,{primary_ids:['main'],parseYaml:()=>parsed,accepted_roles:roles});
    fs.writeFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-profiles.json'),JSON.stringify({schema:'clued.gated-proof-profiles/2',workflows:{[file]:profile}}));
    fs.writeFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-role-specs.json'),JSON.stringify({schema:'clued.gated-proof-role-specs/2',workflows:{[file]:{sources:{[profile.workflow_blob]:roles}}}}));
    const completed={...run,path:file,status:'completed',conclusion:'success',pull_requests:[{number:5}]};
    const job={id:8,run_id:run.id,run_attempt:run.run_attempt,name:'admission-gate',status:'completed',conclusion:'success'};
    const result={mode:'gate',event:'pull_request',head_sha:head,base_sha:base,pr_ref:repository+'#5',enforced:true,admitted:true,verdict:'ADMITTED'};
    const log={complete:true,text:`synthetic-private-log\n[command]/usr/bin/git log -1 --format=%H\n${base}\n${JSON.stringify(result,null,2)}`,job_id:job.id,run_id:run.id,run_attempt:run.run_attempt};
    const content=(file,text,sha)=>({type:'file',path:file,sha,size:Buffer.byteLength(text),encoding:'base64',content:Buffer.from(text).toString('base64')});
    const read=async route=>route.includes('/attempts/')?{total_count:1,jobs:[job]}:
      route.includes('/contents/scripts/ci/clued-work-admission.mjs')?content('scripts/ci/clued-work-admission.mjs',code,blob):
      route.includes('/contents/')?content(file,text,profile.workflow_blob):structuredClone(completed);
    const options={env:{GITHUB_REPOSITORY:repository},workspace,eventName:'workflow_run',event:{workflow_run:{id:run.id}},
      workflows:new Map([[file,profile.workflow_blob]]),graphRead:async()=>payload(),read,readLog:async()=>log};
    const seen=await observeCompletedSource(options);
    assert.equal(seen.state,'qualified');assert.equal(seen.identity_observation.state,'qualified');
    assert.equal(seen.identity_observation.scope,'pr_identity');assert.equal(seen.execution_qualified,false);
    assert.doesNotMatch(JSON.stringify(seen),/synthetic-private-log|trusted gate script|repositoryFileUrl/);
    for(const readLog of [async()=>({...log,complete:false}),async()=>({...log,job_id:99}),
      async()=>({...log,text:log.text.replace(repository+'#5',repository+'#6')}),
      async()=>{throw Error('https://storage.invalid/private?sig=synthetic-private-log');}]) {
      const value=await observeCompletedSource({...options,readLog});
      assert.equal(value.state,'qualified');assert.equal(value.identity_observation.state,'unknown');
      assert.equal(value.execution_qualified,false);assert.doesNotMatch(JSON.stringify(value),/storage.invalid|synthetic-private-log/);
    }
    let logReads=0;
    for(const pull_requests of [[],[{number:5},{number:6}]]) {
      const value=await observeCompletedSource({...options,read:async route=>route.includes('/actions/runs/')?{...completed,pull_requests}:read(route),
        readLog:async()=>{logReads++;return log;}});
      assert.equal(value.identity_observation.state,'not_observed');assert.equal(logReads,0);
    }
    const incomplete=await observeCompletedSource({...options,read:async route=>route.includes('/attempts/')?{total_count:2,jobs:[job]}:read(route)});
    assert.equal(incomplete.identity_observation.state,'unknown');
    for(const changedMembership of [[],[{number:5},{number:6}],[{number:6}]]) {
      const value=await observeCompletedSource({...options,readLog:async()=>{completed.pull_requests=changedMembership;return log;}});
      assert.equal(value.state,'unknown');assert.notEqual(value.identity_observation?.state,'qualified');
      completed.pull_requests=[{number:5}];
    }
    const changed=await observeCompletedSource({...options,readLog:async()=>{completed.run_attempt=3;return log;}});
    assert.equal(changed.state,'unknown');assert.equal(changed.reason,'source observation attempt changed');
    completed.run_attempt=2;
    let finishLog,logSignal,calls=0;
    const pendingLog=new Promise(resolve=>{finishLog=resolve;});
    const expired=await observeCompletedSource({...options,budgetMs:10,
      read:async route=>{calls++;return read(route);},
      readLog:async(job,run,{signal})=>{logSignal=signal;return pendingLog;}});
    assert.equal(expired.reason,'source observation budget exhausted');assert.equal(logSignal.aborted,true);
    const atExpiry=calls;finishLog(log);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,atExpiry,'late log cannot issue a trusted-script or native revalidation request');
  } finally {
    const target=fs.realpathSync(workspace);assert.equal(path.dirname(target),temporaryRoot);
    assert.equal(target,path.resolve(workspace));assert.ok(path.basename(target).startsWith('clued-identity-observation-'));
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
    for(const name of ['profiles','role-specs'])fs.writeFileSync(path.join(workspace,`scripts/ci/clued-gated-proof-${name}.json`),
      snapshotFixtureFiles[`scripts/ci/clued-gated-proof-${name}.json`]);
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


test('runtime accepts the G4 successor only after trusted registration and never from an old catalogue or partial roles',async()=>{
  const g4='.github/workflows/clued-g4-database.yml',blob='d7876890a4df616fddae675c4d66737a70eb7045',
    registry=parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json',import.meta.url))),
    roleSpecs=JSON.parse(fs.readFileSync(new URL('./clued-gated-proof-role-specs.json',import.meta.url))),
    source=registeredWorkflowSource(registry,g4,blob).profile,text=source.source_yaml,
    executedRun={...run,path:g4},record=payload();
  record.data.node.file.path=g4;record.data.node.file.repositoryFileUrl=`https://github.com/${repository}/blob/${sha}/${g4}`;
  const content={type:'file',path:g4,sha:blob,size:Buffer.byteLength(text),encoding:'base64',content:Buffer.from(text).toString('base64')};
  const call=(extra={})=>workflowSourceOf({repository,headRepository,file:g4,run:executedRun,registry,roleSpecs,
    graphRead:async()=>record,read:async()=>content,...extra});
  assert.equal((await call()).passed,true);
  const oldMain=structuredClone(registry);oldMain.workflows[g4].accepted_sources=oldMain.workflows[g4].accepted_sources.filter(p=>p.workflow_blob!==blob);
  assert.equal((await call({registry:oldMain})).state,'unknown');
  const partial=structuredClone(roleSpecs);delete partial.workflows[g4].sources[blob];
  assert.equal((await call({roleSpecs:partial})).state,'unknown');
  for(const changed of [{...content,sha:'f'.repeat(40)},{...content,path:'.github/workflows/other.yml'},
    {...content,content:Buffer.from(text+'# altered\n').toString('base64')}])
    assert.equal((await call({read:async()=>changed})).state,'unknown');
});
