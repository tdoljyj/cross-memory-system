// Shared read-only bridge. Platform source metadata is independent of job
// stdout; a candidate cannot assert which workflow file GitHub executed.
import {workflowBlob,registeredWorkflowSource,rolesForSource} from './clued-workflow-profile.mjs';
import {applicableCI} from './clued-gated-proof.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const unknown=reason=>({passed:false,state:'unknown',reason});
const safePath=name=>typeof name==='string' && name.length>0 && name.length<=4096 &&
  !/[\u0000-\u001f\u007f\u0085\u2028\u2029\\]/.test(name) && !name.startsWith('/') &&
  !name.split('/').some(part=>!part || part==='.' || part==='..');

function workflowDirectory(body) {
  if(!Array.isArray(body) || !body.length || body.length>=1000)return null;
  const entries=new Map();
  for(const entry of body) {
    if(entry?.type!=='file' || !/^\.github\/workflows\/[^/]+$/.test(entry.path??'') ||
      !SHA.test(entry.sha??'') || entries.has(entry.path))return null;
    entries.set(entry.path,entry.sha);
  }
  return entries;
}

// This is a bounded negative trigger classifier, not a general YAML parser.
// It only accepts explicit event keys. Alias/merge/quoted/flow ambiguity in
// the event stanza is unknown; a new PR workflow needs an accepted profile.
export function explicitNonPrWorkflow(text) {
  if(typeof text!=='string' || Buffer.byteLength(text)>524288 ||
    /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text))return false;
  const lines=text.split(/\r?\n/).filter(line=>line.trim()&&!line.trimStart().startsWith('#'));
  const rootKeys=[];
  for(const line of lines.filter(line=>!/^\s/.test(line))) {
    const key=/^([A-Za-z0-9_-]+):/.exec(line);
    if(!key || rootKeys.includes(key[1]))return false;
    rootKeys.push(key[1]);
  }
  const top=lines.filter(line=>/^['"]?on['"]?:/.test(line));
  if(top.length!==1 || !top[0].startsWith('on:'))return false;
  const index=lines.indexOf(top[0]),inline=top[0].slice(3).replace(/\s+#.*$/,'').trim();
  const events=new Set(['push','schedule','workflow_dispatch','workflow_run','repository_dispatch','release',
    'issues','issue_comment','create','delete','check_run','check_suite','deployment','deployment_status',
    'discussion','discussion_comment','fork','gollum','label','merge_group','milestone','page_build','public',
    'pull_request','pull_request_target','registry_package','status','watch','workflow_call']);
  let keys=[];
  if(inline) {
    if(events.has(inline))keys=[inline];
    else if(/^\[[a-z_, ]+\]$/.test(inline))keys=inline.slice(1,-1).split(',').map(key=>key.trim());
    else return false;
  } else {
    for(const line of lines.slice(index+1)) {
      if(!/^\s/.test(line))break;
      if(/^ {2}\S/.test(line)) {
        const match=/^ {2}([a-z_]+):\s*(.*)$/.exec(line);
        if(!match)return false;
        keys.push(match[1]);
      } else if(!/^ {4,}\S/.test(line) && !/^ {4,}/.test(line))return false;
    }
  }
  return keys.length>0 && keys.every(key=>events.has(key)&&!['pull_request','pull_request_target','merge_group'].includes(key)) &&
    new Set(keys).size===keys.length;
}

function decodedWorkflow(content,file,blob) {
  if(content?.type!=='file' || content.path!==file || content.sha!==blob || content.encoding!=='base64' ||
    typeof content.content!=='string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(content.content) ||
    !Number.isSafeInteger(content.size) || content.size<1 || content.size>524288)return null;
  const bytes=Buffer.from(content.content.replace(/[\r\n]/g,''),'base64'),text=bytes.toString('utf8');
  return bytes.length===content.size && Buffer.from(text,'utf8').equals(bytes) && workflowBlob(text)===blob?text:null;
}

// Default-branch counted workflows stay in the set even if the PR deletes
// their gate. New/changed non-CI workflows retain their original admission
// boundaries; they are not registered as tests merely because they changed.
export async function boundWorkflowCatalog({read,repository,tip,head,defaultWorkflows,registry,roleSpecs,diff}) {
  try {
    if(typeof read!=='function' || !REPO.test(repository??'') || !SHA.test(tip??'') || !SHA.test(head??'') ||
      !(defaultWorkflows instanceof Map) || !defaultWorkflows.size || diff?.passed!==true || diff.diffComplete!==true ||
      diff.descriptor?.repository!==repository || diff.descriptor.head!==head ||
      registry?.schema!=='clued.gated-proof-profiles/2' || !registry.workflows ||
      defaultWorkflows.size!==Object.keys(registry.workflows).length)return unknown('workflow catalogue descriptor missing');
    const atDefault=workflowDirectory(await read(`/repos/${repository}/contents/.github/workflows?ref=${tip}`));
    const atHead=workflowDirectory(await read(`/repos/${repository}/contents/.github/workflows?ref=${head}`));
    if(!atDefault || !atHead)return unknown('workflow directory incomplete');
    const sources=new Map(),selected={schema:registry.schema,workflows:{}};
    for(const [file,blob] of defaultWorkflows) {
      if(atDefault.get(file)!==blob)return unknown('trusted checkout/default catalogue differs');
      const headBlob=atHead.get(file),source=registeredWorkflowSource(registry,file,headBlob);
      if(!source.passed)return unknown('counted CI removed or unregistered at PR head');
      const roles=rolesForSource(roleSpecs,file,headBlob);
      if(!roles || roles.length!==source.profile.primary_ids.length ||
        roles.some(role=>!source.profile.primary_ids.includes(role.job_id)))return unknown('counted source roles missing');
      sources.set(file,headBlob);selected.workflows[file]=source.profile;
    }
    for(const [file,blob] of atHead) {
      if(!/\.ya?ml$/.test(file) || defaultWorkflows.has(file) || atDefault.get(file)===blob)continue;
      const text=decodedWorkflow(await read(`/repos/${repository}/contents/${file}?ref=${head}`),file,blob);
      if(!explicitNonPrWorkflow(text))return unknown('new/changed unregistered CI trigger');
    }
    const targets=applicableCI({workflows:sources,profiles:selected,changedFiles:diff.changedFiles,
      commits:diff.commits,diffComplete:true,sourceQualified:true});
    if(!targets.passed)return targets;
    return {passed:true,state:'qualified',scope:'applicable_workflow_catalogue',workflows:targets.workflows,
      profiles:selected,default_directory:[...atDefault],head_directory:[...atHead]};
  } catch {return unknown('workflow catalogue read failed');}
}

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

const documentationPath=name=>safePath(name) && (name==='README.md' ||
  name==='scripts/ci/self-hosted/README.md' || name.startsWith('docs/') && name.endsWith('.md') &&
  !['docs/execution-plans/','docs/clued-','docs/contracts/'].some(prefix=>name.startsWith(prefix)) &&
  !['docs/maintenance/database-security.md','docs/maintenance/migration-ledger.md'].includes(name));
const DOC_SOURCES=['scripts/ci/clued-docs-only.py','scripts/ci/test_clued_docs_only.py'];

// Reconstruct the classifier's event-base to actual merge-checkout comparison.
// The independently observed, source-qualified checkout/log witness is supplied
// by the caller. Three-dot target selection is a separate proof.
export async function boundDocumentationRange({read,repository,head,eventBase,checkout,
  checkoutQualified,trustedSources}) {
  try {
    if(typeof read!=='function' || !REPO.test(repository??'') ||
      ![head,eventBase,checkout].every(value=>SHA.test(value??'')) || checkoutQualified!==true ||
      DOC_SOURCES.some(file=>!SHA.test(trustedSources?.[file]??'')))
      return unknown('documentation checkout/source witness missing');
    const merge=await read(`/repos/${repository}/git/commits/${checkout}`);
    if(merge?.sha!==checkout || !Array.isArray(merge.parents) || merge.parents.length!==2 ||
      !SHA.test(merge.parents[0]?.sha??'') || merge.parents[1]?.sha!==head || !SHA.test(merge.tree?.sha??''))
      return unknown('documentation checkout is not the bound PR merge');
    // A recorded event base may precede the first parent after main advances.
    const ancestor=await read(`/repos/${repository}/compare/${eventBase}...${merge.parents[0].sha}?per_page=1`);
    if(ancestor?.base_commit?.sha!==eventBase || ancestor.merge_base_commit?.sha!==eventBase)
      return unknown('documentation event base is not a merge-parent ancestor');
    const diff=await read(`/repos/${repository}/compare/${eventBase}...${checkout}?per_page=1`);
    if(diff?.base_commit?.sha!==eventBase || diff.merge_base_commit?.sha!==eventBase ||
      !Number.isSafeInteger(diff.total_commits) || diff.total_commits<1 || diff.total_commits>1000 ||
      !Array.isArray(diff.files) || !diff.files.length || diff.files.length>200)
      return unknown('documentation comparison incomplete or outside bounds');
    const names=new Set(),seen=new Set();
    for(const file of diff.files) {
      if(!documentationPath(file?.filename) || seen.has(file.filename) ||
        !['added','removed','modified','renamed'].includes(file.status))return unknown('non-documentation change');
      seen.add(file.filename);names.add(file.filename);
      if(file.status==='renamed') {
        if(!documentationPath(file.previous_filename) || file.previous_filename===file.filename)
          return unknown('documentation rename origin differs');
        names.add(file.previous_filename);
      } else if(file.previous_filename!==undefined)return unknown('unexpected documentation rename metadata');
    }
    if(names.size>200)return unknown('documentation no-rename comparison exceeds bounds');
    const base=await read(`/repos/${repository}/git/commits/${eventBase}`);
    if(base?.sha!==eventBase || !SHA.test(base.tree?.sha??''))return unknown('documentation base tree missing');
    const trees=[];
    for(const treeSha of [base.tree.sha,merge.tree.sha]) {
      const tree=await read(`/repos/${repository}/git/trees/${treeSha}?recursive=1`);
      if(tree?.sha!==treeSha || tree.truncated!==false || !Array.isArray(tree.tree) || tree.tree.length>100000)
        return unknown('documentation tree incomplete');
      const entries=new Map();
      for(const entry of tree.tree) {
        if(!safePath(entry?.path) || entries.has(entry.path) || !SHA.test(entry.sha??''))
          return unknown('documentation tree identity invalid');
        entries.set(entry.path,entry);
      }
      trees.push(entries);
    }
    for(const name of names) {
      const entries=trees.map(tree=>tree.get(name));
      if(entries.every(entry=>!entry) || entries.some(entry=>entry &&
        (entry.mode!=='100644' || entry.type!=='blob')))return unknown('nonregular documentation');
    }
    // The actual checkout executes these bytes; a changed classifier or its
    // tests cannot qualify itself by emitting a DOCUMENTATION_ONLY result.
    if(DOC_SOURCES.some(file=>trees[1].get(file)?.type!=='blob' ||
      trees[1].get(file)?.mode!=='100644' || trees[1].get(file)?.sha!==trustedSources[file]))
      return unknown('documentation classifier/test source differs');
    return {passed:true,state:'qualified',scope:'documentation',event_base:eventBase,
      checkout,head,changedFiles:[...names].sort(),changed_count:names.size};
  } catch {return unknown('documentation comparison read failed');}
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
