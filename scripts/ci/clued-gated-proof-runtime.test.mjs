import assert from 'node:assert/strict';
import test from 'node:test';
import {platformWorkflowSource,workflowSourceOf} from './clued-gated-proof-runtime.mjs';
import {compileRegisteredWorkflow,roleDefinitionDigest,workflowBlob,rolesForSource} from './clued-workflow-profile.mjs';
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
