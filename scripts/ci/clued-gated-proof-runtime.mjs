// Shared read-only bridge. Platform source metadata is independent of job
// stdout; a candidate cannot assert which workflow file GitHub executed.
import {workflowBlob,registeredWorkflowSource,rolesForSource} from './clued-workflow-profile.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const unknown=reason=>({passed:false,state:'unknown',reason});
const safePath=name=>typeof name==='string' && name.length>0 && name.length<=4096 &&
  !/[\u0000-\u001f\u007f\u0085\u2028\u2029\\]/.test(name) && !name.startsWith('/') &&
  !name.split('/').some(part=>!part || part==='.' || part==='..');

function pullDescriptor(pr,repository,prNumber,head) {
  if(pr?.number!==prNumber || pr.state!=='open' || pr.draft!==false || pr.head?.sha!==head ||
    pr.base?.repo?.full_name!==repository || typeof pr.base.ref!=='string' || !pr.base.ref ||
    typeof pr.base.repo.default_branch!=='string' || !pr.base.repo.default_branch ||
    /[\u0000-\u0020\u007f]/.test(pr.base.ref) || pr.base.ref!==pr.base.repo.default_branch ||
    !SHA.test(pr.base.sha??'') || !REPO.test(pr.head.repo?.full_name??'') ||
    !Number.isSafeInteger(pr.changed_files) || pr.changed_files<0 || pr.changed_files>300 ||
    !Number.isSafeInteger(pr.commits) || pr.commits<1 || pr.commits>1000)return null;
  return {repository,pr_number:prNumber,head,head_repository:pr.head.repo.full_name,
    base:pr.base.sha,default_branch:pr.base.ref,changed_files:pr.changed_files,commits:pr.commits};
}

// A complete native three-dot PR diff determines workflow path filters. It is
// not the classifier's base-to-merge-checkout documentation comparison.
export async function boundPullDiff({read,repository,prNumber,head}) {
  try {
    if(typeof read!=='function' || !REPO.test(repository??'') || !SHA.test(head??'') ||
      !Number.isSafeInteger(prNumber) || prNumber<1)return unknown('PR diff identity missing');
    const route=`/repos/${repository}/pulls/${prNumber}`;
    const descriptor=pullDescriptor(await read(route),repository,prNumber,head);
    if(!descriptor)return unknown('open PR diff descriptor unavailable or outside bounds');
    const commits=[],seen=new Set();let base=null,files=null;
    for(let page=1;page<=10;page++) {
      const body=await read(`/repos/${repository}/compare/${descriptor.base}...${head}?per_page=100&page=${page}`);
      if(body?.base_commit?.sha!==descriptor.base || !SHA.test(body.merge_base_commit?.sha??'') ||
        (base!==null && base!==body.merge_base_commit.sha) || body.total_commits!==descriptor.commits ||
        !Array.isArray(body.commits) || body.commits.length>100)
        return unknown('PR compare pagination inconsistent');
      base=body.merge_base_commit.sha;
      if(page===1) {
        if(!Array.isArray(body.files) || body.files.length!==descriptor.changed_files)
          return unknown('PR changed-file list incomplete');
        files=body.files;
      }
      for(const commit of body.commits) {
        if(!SHA.test(commit?.sha??'') || seen.has(commit.sha))return unknown('PR commits ambiguous');
        seen.add(commit.sha);commits.push(commit.sha);
      }
      if(commits.length===descriptor.commits)break;
      if(commits.length>descriptor.commits || body.commits.length!==100)
        return unknown('PR commits incomplete');
    }
    if(commits.length!==descriptor.commits || commits.at(-1)!==head)return unknown('PR head/commit list differs');
    const names=new Set(),fileNames=new Set();
    for(const file of files) {
      if(!safePath(file?.filename) || fileNames.has(file.filename) ||
        !['added','removed','modified','renamed','copied','changed','unchanged'].includes(file.status))
        return unknown('PR changed-file identity invalid');
      fileNames.add(file.filename);names.add(file.filename);
      if(file.status==='renamed') {
        if(!safePath(file.previous_filename) || file.previous_filename===file.filename)
          return unknown('PR rename origin unavailable');
        names.add(file.previous_filename);
      } else if(file.previous_filename!==undefined)return unknown('PR previous path is not a rename');
    }
    const latest=pullDescriptor(await read(route),repository,prNumber,head);
    if(!latest || JSON.stringify(latest)!==JSON.stringify(descriptor))return unknown('PR diff descriptor changed');
    return {passed:true,state:'qualified',scope:'pull_diff',descriptor,merge_base:base,
      changedFiles:[...names].sort(),commits:commits.length,diffComplete:true};
  } catch {return unknown('PR diff read failed');}
}
export const RUN_FILE_QUERY=`query($node:ID!){node(id:$node){...on WorkflowRun{
  databaseId runAttempt event file{path repositoryName repositoryFileUrl
  run{databaseId runAttempt}}}}}`;

export function githubGraphReader(fetchImpl,env) {
  return async(query,variables,{signal}={})=>{
    const api=new URL(env.GITHUB_API_URL||'https://api.github.com');
    const target=new URL(env.GITHUB_GRAPHQL_URL||
      (api.pathname.startsWith('/api/v3')?'/api/graphql':'/graphql'),api);
    if(!env.GITHUB_TOKEN || api.protocol!=='https:' || api.username || api.password ||
      target.protocol!=='https:' || target.origin!==api.origin || target.username || target.password ||
      target.search || target.hash || !['/graphql','/api/graphql'].includes(target.pathname))
      throw Error('trusted GitHub GraphQL endpoint/token unavailable');
    const response=await fetchImpl(target.href,{method:'POST',signal,redirect:'error',headers:{
      Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},
      body:JSON.stringify({query,variables})});
    if(response.status!==200)throw Error('platform source metadata unavailable');
    return response.json();
  };
}

// A bounded shadow observation exercises the existing CI token's read access.
// It never qualifies tests, touches a slot, or changes admission/merge behavior.
export const SOURCE_OBSERVATION_BUDGET_MS=12000;
export async function observeCompletedSource(options) {
  if(options.eventName!=='workflow_run' || !Number.isSafeInteger(options.event?.workflow_run?.id) || options.event.workflow_run.id<1)
    return {state:'not_observed',reason:'no workflow-run signal'};
  const budgetMs=options.budgetMs??SOURCE_OBSERVATION_BUDGET_MS;
  if(!Number.isSafeInteger(budgetMs) || budgetMs<1 || budgetMs>SOURCE_OBSERVATION_BUDGET_MS)
    return unknown('invalid bounded source observation budget');
  const controller=new AbortController();let closed=false,timer;
  const guarded=fn=>async(...args)=>{
    if(closed || controller.signal.aborted)throw Error('source observation closed');
    return fn(...args,{signal:controller.signal});
  };
  const budget=new Promise(resolve=>{timer=setTimeout(()=>{
    closed=true;
    resolve({state:'unknown',scope:'source_observation_only',execution_qualified:false,
      reason:'source observation budget exhausted'});
    controller.abort();
  },budgetMs);});
  try {
    return await Promise.race([observeSourceWithinBudget({...options,
      read:guarded(options.read),graphRead:guarded(options.graphRead)}),budget]);
  } finally {closed=true;clearTimeout(timer);controller.abort();}
}

async function observeSourceWithinBudget({env,event,eventName,workspace,workflows,read,graphRead}) {
  if(eventName!=='workflow_run' || !Number.isSafeInteger(event?.workflow_run?.id) || event.workflow_run.id<1)
    return {state:'not_observed',reason:'no workflow-run signal'};
  try {
    const repository=env.GITHUB_REPOSITORY;
    if(!REPO.test(repository??''))return unknown('repository unavailable');
    const run=await read(`/repos/${repository}/actions/runs/${event.workflow_run.id}`);
    const file=String(run?.path??'').replace(/@.*$/,'');
    if(run?.id!==event.workflow_run.id || run.event!=='pull_request' || run.status!=='completed' || !workflows.has(file))
      return {state:'not_observed',reason:'not a completed counted PR workflow'};
    const registry=JSON.parse(fs.readFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'));
    const roleSpecs=JSON.parse(fs.readFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'));
    const source=await workflowSourceOf({read,graphRead,repository,headRepository:run.head_repository?.full_name,
      file,run,registry,roleSpecs,serverURL:env.GITHUB_SERVER_URL});
    // A started retry invalidates even this read-only observation.
    const latest=await read(`/repos/${repository}/actions/runs/${run.id}`);
    if(latest?.id!==run.id || latest.run_attempt!==run.run_attempt || latest.head_sha!==run.head_sha ||
      latest.event!==run.event || latest.status!==run.status || latest.conclusion!==run.conclusion)
      return unknown('source observation attempt changed');
    return {state:source.state,scope:'source_observation_only',run_id:run.id,run_attempt:run.run_attempt,
      head:run.head_sha,file,source_sha:source.source_sha??null,workflow_blob:source.workflow_blob??null,
      reason:source.reason??null,execution_qualified:false};
  } catch {return unknown('source observation unavailable');}
}

export function platformWorkflowSource(body,{repository,headRepository,file,run,serverURL='https://github.com'}) {
  try {
    if(!REPO.test(repository??'') || !REPO.test(headRepository??'') ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file??'') ||
      !Number.isSafeInteger(run?.id) || run.id<1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt<1 ||
      run.event!=='pull_request' || run.repository?.full_name!==repository ||
      run.head_repository?.full_name!==headRepository || !SHA.test(run.head_sha??'') ||
      !body || Object.hasOwn(body,'errors'))return unknown('platform source identity missing');
    const node=body.data?.node,source=node?.file;
    if(node?.databaseId!==run.id || node.runAttempt!==run.run_attempt || node.event!==run.event ||
      source?.run?.databaseId!==run.id || source.run.runAttempt!==run.run_attempt || source.path!==file ||
      ![repository,headRepository].includes(source.repositoryName))return unknown('platform run/file identity differs');
    const server=new URL(serverURL),url=new URL(source.repositoryFileUrl);
    if(server.protocol!=='https:' || server.username || server.password || server.search || server.hash ||
      server.pathname!=='/' || url.origin!==server.origin || url.username || url.password || url.search || url.hash)
      return unknown('platform source URL outside trusted server');
    const prefix=`/${source.repositoryName}/blob/`,suffix=`/${file}`;
    if(!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix))return unknown('platform source URL path differs');
    const sha=url.pathname.slice(prefix.length,-suffix.length);
    if(!SHA.test(sha))return unknown('platform source is not an immutable commit');
    return {passed:true,state:'qualified',scope:'workflow_source_identity',repository,file,run_id:run.id,
      run_attempt:run.run_attempt,source_repository:source.repositoryName,source_sha:sha};
  } catch {return unknown('platform source schema invalid');}
}

export async function workflowSourceOf({read,graphRead,repository,headRepository,file,run,registry,roleSpecs,serverURL}) {
  try {
    if(typeof read!=='function' || typeof graphRead!=='function' || typeof run?.node_id!=='string' || !run.node_id)
      return unknown('authenticated platform readers missing');
    const identity=platformWorkflowSource(await graphRead(RUN_FILE_QUERY,{node:run.node_id}),
      {repository,headRepository,file,run,serverURL});
    if(!identity.passed)return identity;
    // PR commit objects are read through the authorized base repository. Do not
    // follow the source URL or send a repository token to an arbitrary host.
    const content=await read(`/repos/${repository}/contents/${file}?ref=${identity.source_sha}`);
    if(content?.type!=='file' || content.path!==file || !SHA.test(content.sha??'') ||
      content.encoding!=='base64' || typeof content.content!=='string' ||
      !/^[A-Za-z0-9+/=\r\n]*$/.test(content.content) ||
      !Number.isSafeInteger(content.size) || content.size<1 || content.size>524288)
      return unknown('executed workflow source content unavailable');
    const bytes=Buffer.from(content.content.replace(/[\r\n]/g,''),'base64'),text=bytes.toString('utf8');
    if(bytes.length!==content.size || !Buffer.from(text,'utf8').equals(bytes) || workflowBlob(text)!==content.sha)
      return unknown('executed workflow source bytes differ');
    // This proves one executed source, not a complete applicable CI directory.
    const picked=registeredWorkflowSource(registry,file,content.sha);
    if(!picked.passed)return picked;
    const profile=picked.profile,roles=rolesForSource(roleSpecs,file,content.sha);
    if(!roles || roles.length!==profile.primary_ids.length ||
      roles.some(role=>!profile.primary_ids.includes(role.job_id)))return unknown('exact executed source roles missing');
    return {...identity,scope:'workflow_source',workflow_blob:content.sha,profile};
  } catch {return unknown('executed workflow source read failed');}
}
