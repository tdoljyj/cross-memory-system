// Shared read-only bridge. Platform source metadata is independent of job
// stdout; a candidate cannot assert which workflow file GitHub executed.
import {workflowBlob,registeredWorkflowSource,rolesForSource,futureWorkflowCatalogue,acceptedFutureWorkflowSource,external2FutureWorkflowCatalogue,acceptedExternal2WorkflowSource,EXTERNAL2_FILES,parseWorkflowProfiles,decodeWorkflowProfiles} from './clued-workflow-profile.mjs';
import {createCatalogueSourceReader} from './clued-source-only-workflow.mjs';
import {readRequiredApplicability} from './clued-required-applicability.mjs';
import {PUBLISHER_FILES,PUBLISHER_SOURCE_PATH,registeredPublisherTransition} from './clued-production-publisher-source.mjs';
import {PUBLISHER_PR_QUALIFICATION_FILES,PUBLISHER_PR_QUALIFICATION_PATH,registeredPublisherPrQualificationTransition} from './clued-publisher-qualification-source.mjs';
export const COMPONENT_VERSION = "1.0.4";
import {applicableCI,qualifiedCI,gateIdentityWitness,checkoutIdentityWitness,DOCUMENTATION_STEPS,QUALITY} from './clued-gated-proof.mjs';
import {workflowIsGated,workflowFormFindings,gateFindings,workflowJobs,githubJson} from './clued-work-admission.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const unknown=reason=>({passed:false,state:'unknown',reason});
const safePath=name=>typeof name==='string' && name.length>0 && name.length<=4096 &&
  !/[\u0000-\u001f\u007f\u0085\u2028\u2029\\]/.test(name) && !name.startsWith('/') &&
  !name.split('/').some(part=>!part || part==='.' || part==='..');

const PUBLISHER_SNAPSHOT_FILES=Object.freeze({
  publisherRegistry:PUBLISHER_SOURCE_PATH,publisherCompiler:'scripts/ci/clued-production-publisher-source.mjs',
  qualificationRegistry:PUBLISHER_PR_QUALIFICATION_PATH,qualificationCompiler:'scripts/ci/clued-publisher-qualification-source.mjs',
});
const SNAPSHOT_FILES=['scripts/ci/clued-gated-proof-profiles.json','scripts/ci/clued-gated-proof-role-specs.json',
  'scripts/ci/clued-work-admission.mjs','scripts/ci/clued-docs-only.py','scripts/ci/test_clued_docs_only.py',
  'config/merge-admission-policy.json',...Object.values(PUBLISHER_SNAPSHOT_FILES)];
const trustedSourceByteLimit=file=>file===SNAPSHOT_FILES[0]?1048576:524288;
export const PUBLISHER_SNAPSHOT_QUERY=`query CluedPublisherSnapshot($owner:String!,$name:String!,$publisherRegistry:String!,$publisherCompiler:String!,$qualificationRegistry:String!,$qualificationCompiler:String!) {
  repository(owner:$owner,name:$name) { nameWithOwner
    publisherRegistry:object(expression:$publisherRegistry) { ...CluedPublisherBlob }
    publisherCompiler:object(expression:$publisherCompiler) { ...CluedPublisherBlob }
    qualificationRegistry:object(expression:$qualificationRegistry) { ...CluedPublisherBlob }
    qualificationCompiler:object(expression:$qualificationCompiler) { ...CluedPublisherBlob }
  }
}
fragment CluedPublisherBlob on Blob { __typename oid byteSize text isBinary isTruncated }`;

// Fetch the same four immutable path/commit identities together. Each initial
// and final barrier still reads fresh bytes and validates every Blob, keeping
// the original 160-callback and 90-second whole-observation limits unchanged.
export async function readPublisherSourceSnapshot({graphRead,repository,tip,files}) {
  if(typeof graphRead!=='function'||!REPO.test(repository??'')||!SHA.test(tip??''))return null;
  const [owner,name]=repository.split('/');
  try {
    const result=await graphRead(PUBLISHER_SNAPSHOT_QUERY,{owner,name,
      ...Object.fromEntries(Object.entries(PUBLISHER_SNAPSHOT_FILES).map(([alias,file])=>[alias,`${tip}:${file}`]))});
    if(result?.errors!==undefined&&(!Array.isArray(result.errors)||result.errors.length))return null;
    const repo=result?.data?.repository;if(repo?.nameWithOwner!==repository)return null;
    const texts={};
    for(const [alias,file] of Object.entries(PUBLISHER_SNAPSHOT_FILES)) {
      const node=repo[alias],limit=trustedSourceByteLimit(file);
      if(node?.__typename!=='Blob'||node.isBinary!==false||node.isTruncated!==false||
        !SHA.test(files?.[file]??'')||node.oid!==files[file]||!Number.isSafeInteger(node.byteSize)||
        node.byteSize<1||node.byteSize>limit||typeof node.text!=='string'||node.text.length>limit)return null;
      const bytes=Buffer.from(node.text,'utf8');
      if(bytes.length!==node.byteSize||bytes.toString('utf8')!==node.text)return null;
      const text=decodedWorkflow({type:'file',path:file,sha:node.oid,size:node.byteSize,
        encoding:'base64',content:bytes.toString('base64')},file,files[file]);
      if(text===null)return null;texts[file]=text;
    }
    return texts;
  } catch {return null;}
}
export function loadProofSnapshot(workspace,tip,workflows) {
  const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8',maxBuffer:1024}).trim();
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:workspace,encoding:'utf8',maxBuffer:65536});
  if(!SHA.test(tip??'') || checkout!==tip || dirty.trim() || !(workflows instanceof Map))throw Error('trusted default checkout unavailable');
  const files={},texts={};
  for(const file of SNAPSHOT_FILES) {
    const bytes=fs.readFileSync(path.join(workspace,file)),text=bytes.toString('utf8');
    // Complete registered workflow sources retain their historical choices.
    // Only that registry may grow to 1 MiB; every other snapshot input keeps
    // its 512 KiB limit. Source identity, UTF-8 and checkout checks are unchanged.
    if(bytes.length>trustedSourceByteLimit(file) || !Buffer.from(text,'utf8').equals(bytes))throw Error('trusted snapshot file exceeds bounds');
    files[file]=workflowBlob(text);texts[file]=text;
  }
  return {tip,checkout,files,profiles:parseWorkflowProfiles(texts[SNAPSHOT_FILES[0]]),roleSpecs:JSON.parse(texts[SNAPSHOT_FILES[1]]),publisherSources:JSON.parse(texts[PUBLISHER_SOURCE_PATH]),qualificationSources:JSON.parse(texts[PUBLISHER_PR_QUALIFICATION_PATH]),
    workflows:new Map(workflows)};
}

export const EXECUTION_PROOF_BUDGET_MS=90000;
export function createExecutionQualifier({env,fetchImpl,workspace,workflows}) {
  return async(pr,expectedTip)=>{
    try {
      const branch=pr?.base?.repo?.default_branch;
      if(!branch || pr.base.ref!==branch || pr.base.repo.full_name!==env.GITHUB_REPOSITORY)
        return unknown('qualification PR default branch missing');
      const initialSignal=AbortSignal.timeout(12000);
      const current=await githubJson((url,init)=>fetchImpl(url,{...init,signal:initialSignal,redirect:'error'}),env,
        `/repos/${env.GITHUB_REPOSITORY}/branches/${encodeURIComponent(branch)}`);
      const tip=current?.commit?.sha;
      if(expectedTip && tip!==expectedTip)return unknown('default tip changed before qualification');
      const snapshot=loadProofSnapshot(workspace,tip,workflows);
      return await qualifyPrExecution({repository:env.GITHUB_REPOSITORY,prNumber:pr.number,head:pr.head.sha,snapshot,
        serverURL:env.GITHUB_SERVER_URL,
        read:(route,{signal})=>githubJson((url,init)=>fetchImpl(url,{...init,signal,redirect:'error'}),env,route),
        graphRead:githubGraphReader(fetchImpl,env),readLog:githubAttemptLogReader(fetchImpl,env)});
    } catch {return unknown('default-branch execution qualification unavailable');}
  };
}
// The budget covers every request and response body, including final checks.
// A late response cannot resume issuing requests after the observation closes.
export async function qualifyPrExecution(options={}) {
  if(!options || typeof options!=='object')return unknown('execution proof options missing');
  const budgetMs=options.budgetMs??EXECUTION_PROOF_BUDGET_MS;
  if(!Number.isSafeInteger(budgetMs) || budgetMs<1 || budgetMs>EXECUTION_PROOF_BUDGET_MS)
    return unknown('invalid execution proof budget');
  if(['read','graphRead','readLog'].some(key=>typeof options[key]!=='function'))return unknown('authenticated proof readers missing');
  const controller=new AbortController();let closed=false,timer,requests=0;
  const guarded=fn=>async(...args)=>{
    if(closed || controller.signal.aborted || ++requests>160)throw Error('execution proof read budget exhausted');
    return fn(...args,{signal:controller.signal});
  };
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>{
    closed=true;resolve(unknown('execution proof budget exhausted'));controller.abort();
  },budgetMs);});
  try {
    return await Promise.race([executionWithinBudget({...options,read:guarded(options.read),
      graphRead:guarded(options.graphRead),readLog:guarded(options.readLog)}),timeout]);
  } finally {closed=true;clearTimeout(timer);controller.abort();}
}

// One observation's raw Source facts, never Source/Role or execution authority.
// The complete identity is repository + immutable commit + safe file path.
// Mutable PR/main/directory/run/attempt and platform identities remain fresh.
export function createImmutableWorkflowSourceReader({read,repository,enabled=false}) {
  const immutableSources=new Map();
  return async route=>{
    const match=/^\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)\?ref=([a-f0-9]{40})$/.exec(route);
    const active=typeof enabled==='function'?enabled():enabled===true;
    const cacheable=active && match?.[1]===repository && safePath(match[2]);
    if(cacheable && immutableSources.has(route))return structuredClone(immutableSources.get(route));
    const content=await read(route);
    if(cacheable && immutableSources.size<64 && decodedWorkflow(content,match[2],content?.sha)!==null)
      immutableSources.set(route,structuredClone(content));
    return content;
  };
}

async function executionWithinBudget({read,graphRead,readLog,repository,prNumber,head,snapshot,serverURL}) {
  try {
    if(!REPO.test(repository??'') || !SHA.test(head??'') || !SHA.test(snapshot?.tip??'') || snapshot.checkout!==snapshot.tip ||
      !(snapshot.workflows instanceof Map) || SNAPSHOT_FILES.some(file=>!SHA.test(snapshot.files?.[file]??'')))
      return unknown('trusted execution snapshot missing');
    const diff=await boundPullDiff({read,repository,prNumber,head});
    if(!diff.passed)return diff;
    const tipRoute=`/repos/${repository}/branches/${encodeURIComponent(diff.descriptor.default_branch)}`;
    const snapshotCurrent=async()=>{
      if((await read(tipRoute))?.commit?.sha!==snapshot.tip)return false;
      const publisherTexts=await readPublisherSourceSnapshot({graphRead,repository,tip:snapshot.tip,files:snapshot.files});
      if(!publisherTexts)return false;
      for(const file of SNAPSHOT_FILES) {
        if(Object.hasOwn(publisherTexts,file)) {
          const text=publisherTexts[file];
          if(file===PUBLISHER_SOURCE_PATH&&JSON.stringify(JSON.parse(text))!==JSON.stringify(snapshot.publisherSources))return false;
          if(file===PUBLISHER_PR_QUALIFICATION_PATH&&JSON.stringify(JSON.parse(text))!==JSON.stringify(snapshot.qualificationSources))return false;
          continue;
        }
        const content=await read(`/repos/${repository}/contents/${file}?ref=${snapshot.tip}`);
        const text=decodedWorkflow(content,file,snapshot.files[file]);
        if(text===null)return false;
        if(file===SNAPSHOT_FILES[0] && JSON.stringify(parseWorkflowProfiles(text))!==JSON.stringify(snapshot.profiles))return false;
        if(file===SNAPSHOT_FILES[1] && JSON.stringify(JSON.parse(text))!==JSON.stringify(snapshot.roleSpecs))return false;
      }
      return true;
    };
    if(!await snapshotCurrent())return unknown('trusted snapshot/default tip differs');
    // These are trusted default registration data, already verified above.
    // The cache binds immutable bytes only; catalogue validation still decides
    // whether any pending Source can be installed or used for qualification.
    let cacheEnabled=[snapshot.profiles.future_workflows,snapshot.profiles.external2_future_workflows]
      .some(entries=>Array.isArray(entries) && entries.length>0);
    const sourceRead=createImmutableWorkflowSourceReader({read,repository,enabled:()=>cacheEnabled});
    const catalog=await boundWorkflowCatalog({read:sourceRead,repository,tip:snapshot.tip,head,
      defaultWorkflows:snapshot.workflows,registry:snapshot.profiles,roleSpecs:snapshot.roleSpecs,publisherRegistry:snapshot.publisherSources,qualificationRegistry:snapshot.qualificationSources,diff});
    if(!catalog.passed)return catalog;
    cacheEnabled=catalog.future_installations.length>0 || catalog.external2_applicable===true;
    const sources=new Map();
    const sourceFor=async(file,run)=>workflowSourceOf({read:sourceRead,graphRead,repository,
      headRepository:diff.descriptor.head_repository,file,run,registry:catalog.source_registry,
      roleSpecs:catalog.source_roles,serverURL});
    const proof=await qualifiedCI({read,repository,head,base:diff.descriptor.base,prNumber,workflows:catalog.workflows,profiles:catalog.profiles,
      authorizeSource:async({file,run})=>{
        const source=await sourceFor(file,run);
        if(!source.passed || source.workflow_blob!==catalog.workflows.get(file))return false;
        sources.set(run.id,source);return true;
      },
      qualifyRunIdentity:async({run,jobs})=>(await boundRunIdentity({read:sourceRead,readLog,source:sources.get(run.id),run,jobs,
        repository,head,prNumber,trustedGateBlob:snapshot.files['scripts/ci/clued-work-admission.mjs']})).passed===true,
      qualifyDocumentation:async({run,jobs})=>(await boundDocumentationAttempt({read:sourceRead,readLog,source:sources.get(run.id),run,jobs,
        repository,head,prNumber,trustedSources:Object.fromEntries(DOC_SOURCES.map(file=>[file,snapshot.files[file]]))})).passed===true,
      qualifyRequiredApplicability:async({repository,prNumber,head,base,runId,runAttempt,requestKey})=>
        readRequiredApplicability({read:sourceRead,readLog,repository,prNumber,head,base,runId,runAttempt,requestKey,
          trustedGateBlob:snapshot.files['scripts/ci/clued-work-admission.mjs']}),
      revalidateSources:async({runs})=>{
        if(!await snapshotCurrent())return false;
        const finalDiff=await boundPullDiff({read,repository,prNumber,head});
        if(!finalDiff.passed || JSON.stringify(finalDiff)!==JSON.stringify(diff))return false;
        const finalCatalog=await boundWorkflowCatalog({read:sourceRead,repository,tip:snapshot.tip,head,
          defaultWorkflows:snapshot.workflows,registry:snapshot.profiles,roleSpecs:snapshot.roleSpecs,publisherRegistry:snapshot.publisherSources,qualificationRegistry:snapshot.qualificationSources,diff:finalDiff});
        if(!finalCatalog.passed || JSON.stringify(finalCatalog.default_directory)!==JSON.stringify(catalog.default_directory) ||
          JSON.stringify(finalCatalog.head_directory)!==JSON.stringify(catalog.head_directory))return false;
        for(const {file,run} of runs) {
          const current=await sourceFor(file,run),before=sources.get(run.id);
          if(!current.passed || current.workflow_blob!==before?.workflow_blob || current.source_sha!==before.source_sha ||
            current.source_repository!==before.source_repository)return false;
        }
        // The source walk itself is asynchronous. Re-read mutable PR/main
        // after it; the pure framework then barriers the native run set.
        const finalPr=pullDescriptor(await read(`/repos/${repository}/pulls/${prNumber}`),repository,prNumber,head);
        if(!finalPr || JSON.stringify(finalPr)!==JSON.stringify(diff.descriptor))return false;
        return (await read(tipRoute))?.commit?.sha===snapshot.tip;
      }});
    return {...proof,tip:snapshot.tip,default_branch:diff.descriptor.default_branch,pr_number:prNumber,head,
      observation_context:{changed_files:[...diff.changedFiles],commits:diff.commits,default_branch:diff.descriptor.default_branch,
        workflow_files:[...catalog.workflows.keys()],registry_source_checkout:snapshot.checkout}};
  } catch {return unknown('execution proof read failed');}
}

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

// Contents directory arrays have no completeness count. Future enrollment
// additionally binds the exact directory through three non-recursive Git
// trees; a truncated listing cannot hide an installed or extra workflow.
async function completeWorkflowDirectory({read,repository,commit}) {
  const descriptor=await read(`/repos/${repository}/git/commits/${commit}`);
  if(descriptor?.sha!==commit || !SHA.test(descriptor.tree?.sha??''))return null;
  let treeSha=descriptor.tree.sha;
  for(const part of ['.github','workflows',null]) {
    const body=await read(`/repos/${repository}/git/trees/${treeSha}`);
    if(body?.sha!==treeSha || body.truncated!==false || !Array.isArray(body.tree) || body.tree.length>=1000 ||
      body.tree.some(entry=>!safePath(entry?.path) || entry.path.includes('/') || !SHA.test(entry.sha??'')) ||
      new Set(body.tree.map(entry=>entry.path)).size!==body.tree.length)return null;
    if(part!==null) {
      const entry=body.tree.find(entry=>entry.path===part);
      if(entry?.type!=='tree' || entry.mode!=='040000')return null;
      treeSha=entry.sha;
    } else {
      if(body.tree.some(entry=>entry.type!=='blob' || !['100644','100755'].includes(entry.mode)))return null;
      return new Map(body.tree.map(entry=>[`.github/workflows/${entry.path}`,entry.sha]));
    }
  }
  return null;
}
const sameDirectory=(a,b)=>a instanceof Map && b instanceof Map && a.size===b.size &&
  [...a].every(([file,blob])=>b.get(file)===blob);

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
    !Number.isSafeInteger(content.size) || content.size<1 || content.size>trustedSourceByteLimit(file))return null;
  const bytes=Buffer.from(content.content.replace(/[\r\n]/g,''),'base64'),text=bytes.toString('utf8');
  return bytes.length===content.size && Buffer.from(text,'utf8').equals(bytes) && workflowBlob(text)===blob?text:null;
}

const CHECKOUT='actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
function pinnedJobCheckout(profile,jobId,gate) {
  const jobs=workflowJobs(profile?.source_yaml),matches=jobs.filter(job=>job.name===jobId);
  if(matches.length!==1)return false;
  const lines=matches[0].lines.map(line=>line.replace(/\s+#.*$/,''));
  const indices=lines.flatMap((line,index)=>/^      - uses: actions\/checkout@/.test(line)?[index]:[]);
  if(indices.length!==1 || lines[indices[0]].trim()!==`- uses: ${CHECKOUT}`)return false;
  const block=[];
  for(const line of lines.slice(indices[0]+1)) {
    if(/^      - /.test(line))break;
    block.push(line);
  }
  if(block.some(line=>/^          (repository|path):/.test(line)))return false;
  const refs=block.filter(line=>/^          ref:/.test(line));
  return gate?refs.length===1 && refs[0].trim()==='ref: ${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}':
    refs.length===0;
}

function logLines(log,run,job) {
  if(log?.complete!==true || log.job_id!==job?.id || log.run_id!==run?.id || log.run_attempt!==run?.run_attempt ||
    job?.run_id!==run?.id || job?.run_attempt!==run?.run_attempt ||
    typeof log.text!=='string' || Buffer.byteLength(log.text)>524288)return null;
  return log.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').split(/\r?\n/)
    .map(line=>line.replace(/^\d{4}-\d\d-\d\dT\S+ /,''));
}
function uniqueLogCommit(lines) {
  if(!lines)return null;
  const values=[];
  for(let i=0;i<lines.length-1;i++)if(/^\[command\].*\/git log -1 --format=%H$/.test(lines[i]))values.push(lines[i+1]);
  return values.length===1 && SHA.test(values[0])?values[0]:null;
}
function resultObjects(lines,predicate) {
  const values=[];let chunk=[];
  for(const line of lines??[]) {
    if(chunk.length) {
      chunk.push(line);
      if(line==='}') {try{const value=JSON.parse(chunk.join('\n'));if(predicate(value))values.push(value);}catch{}chunk=[];}
    } else if(line.trim()==='{')chunk=[line];
    else {try{const value=JSON.parse(line);if(predicate(value))values.push(value);}catch{}}
  }
  return chunk.length?[]:values;
}
function sourcePrimary(source,jobs) {
  const matches=[];
  for(const job of jobs??[]) {
    if(job?.status!=='completed' || job.conclusion!=='success' || !Array.isArray(job.labels))continue;
    const routes=source?.profile?.routes?.filter(route=>route.name===job.name && route.self_hosted===job.labels.includes('self-hosted'))??[];
    if(routes.length===1)matches.push({job,route:routes[0]});
  }
  return matches.length===1?matches[0]:null;
}

// Empty native membership gets no guessed PR association. A gate witness
// uses the actual pinned base checkout and trusted gate-script bytes; an
// ungated witness uses the actual pinned merge checkout and both parents.
export async function boundRunIdentity({read,readLog,source,run,jobs,repository,head,prNumber,trustedGateBlob}) {
  try {
    if(source?.passed!==true || source.repository!==repository || source.file!==String(run?.path??'').replace(/@.*$/,'') ||
      source.run_id!==run?.id || source.run_attempt!==run?.run_attempt ||
      typeof read!=='function' || typeof readLog!=='function')return unknown('attempt source/log reader missing');
    if(source.profile.gated) {
      const gates=jobs.filter(job=>job.name==='admission-gate');
      if(gates.length!==1 || gates[0].status!=='completed' || gates[0].conclusion!=='success' ||
        !pinnedJobCheckout(source.profile,'admission-gate',true) || !SHA.test(trustedGateBlob??''))
        return unknown('trusted gate checkout missing');
      const job=gates[0],log=await readLog(job,run),lines=logLines(log,run,job),checkout=uniqueLogCommit(lines);
      const results=resultObjects(lines,value=>value?.mode==='gate');
      if(results.length!==1 || checkout!==results[0].base_sha)return unknown('gate event base/actual checkout differ');
      const file='scripts/ci/clued-work-admission.mjs';
      const text=decodedWorkflow(await read(`/repos/${repository}/contents/${file}?ref=${checkout}`),file,trustedGateBlob);
      if(text===null)return unknown('gate script has no current trusted source');
      return gateIdentityWitness({sourceQualified:true,log,run,job,repository,head,prNumber,gateSource:checkout});
    }
    const primary=sourcePrimary(source,jobs);
    if(!primary || !pinnedJobCheckout(source.profile,primary.route.job_id,false))return unknown('pinned primary checkout missing');
    const log=await readLog(primary.job,run),checkout=uniqueLogCommit(logLines(log,run,primary.job));
    if(!checkout)return unknown('primary checkout commit ambiguous');
    const commit=await read(`/repos/${repository}/git/commits/${checkout}`);
    return checkoutIdentityWitness({sourceQualified:true,log,run,job:primary.job,repository,head,prNumber,
      commit,base:commit?.parents?.[0]?.sha});
  } catch {return unknown('attempt identity read failed');}
}

export async function boundDocumentationAttempt({read,readLog,source,run,jobs,repository,head,prNumber,trustedSources}) {
  try {
    if(source?.passed!==true || source.repository!==repository || source.file!==QUALITY ||
      source.file!==String(run?.path??'').replace(/@.*$/,'') || source.run_id!==run?.id || source.run_attempt!==run?.run_attempt ||
      typeof read!=='function' || typeof readLog!=='function')return unknown('documentation source/log reader missing');
    const primary=sourcePrimary(source,jobs);
    if(!primary || !pinnedJobCheckout(source.profile,primary.route.job_id,false))return unknown('documentation primary ambiguous');
    const job=primary.job;
    const actualStep=(name,conclusion)=>{
      if(!Array.isArray(job.steps))return false;
      const steps=job.steps.filter(step=>step.name===name);
      return steps.length===1 && steps[0].status==='completed' && steps[0].conclusion===conclusion;
    };
    if(DOCUMENTATION_STEPS.some(name=>!actualStep(name,'skipped')) ||
      !actualStep('Qualify ordinary documentation changes','success'))
      return unknown('documentation classifier/skip sequence differs');
    const log=await readLog(job,run),lines=logLines(log,run,job),checkout=uniqueLogCommit(lines);
    const results=resultObjects(lines,value=>value?.qualification==='DOCUMENTATION_ONLY');
    if(results.length!==1 || !checkout || results[0].checkout_sha!==checkout || results[0].repository!==repository ||
      results[0].run_full!==false || results[0].full_app_tests!==false)return unknown('documentation result/checkout differs');
    const result=results[0],commit=await read(`/repos/${repository}/git/commits/${checkout}`);
    const identity=checkoutIdentityWitness({sourceQualified:true,log,run,job,repository,head,prNumber,
      commit,base:commit?.parents?.[0]?.sha});
    const range=await boundDocumentationRange({read,repository,head,eventBase:result.base_sha,checkout,
      checkoutQualified:identity.passed===true,trustedSources});
    if(!range.passed || range.changed_count!==result.changed_count)return unknown('documentation actual range/count differs');
    return range;
  } catch {return unknown('documentation attempt read failed');}
}

// Default-branch counted workflows stay in the set even if the PR deletes
// their gate. New/changed non-CI workflows retain their original admission
// boundaries; they are not registered as tests merely because they changed.
export async function boundWorkflowCatalog({read,repository,tip,head,defaultWorkflows,registry,roleSpecs,publisherRegistry,qualificationRegistry,diff}) {
  try {
    registry=decodeWorkflowProfiles(registry);
    if(typeof read!=='function' || !REPO.test(repository??'') || !SHA.test(tip??'') || !SHA.test(head??'') ||
      !(defaultWorkflows instanceof Map) || !defaultWorkflows.size || diff?.passed!==true || diff.diffComplete!==true ||
      diff.descriptor?.repository!==repository || diff.descriptor.head!==head ||
      registry?.schema!=='clued.gated-proof-profiles/2' || !registry.workflows ||
      defaultWorkflows.size!==Object.keys(registry.workflows).length)return unknown('workflow catalogue descriptor missing');
    const atDefault=workflowDirectory(await read(`/repos/${repository}/contents/.github/workflows?ref=${tip}`));
    const atHead=workflowDirectory(await read(`/repos/${repository}/contents/.github/workflows?ref=${head}`));
    if(!atDefault || !atHead)return unknown('workflow directory incomplete');
    const future=futureWorkflowCatalogue(registry,roleSpecs);
    if(!future.passed)return future;
    const external2=external2FutureWorkflowCatalogue(registry,roleSpecs);
    if(!external2.passed)return external2;
    const enrolled=[...future.entries,...external2.entries];
    const externalPair=external2.entries.filter(entry=>atHead.has(entry.file));
    if(externalPair.length && externalPair.length!==2)return unknown('External2 pair must install atomically');
    if(enrolled.some(entry=>atDefault.has(entry.file)))return unknown('future Source is already installed without active promotion');
    const futureInstalls=enrolled.filter(entry=>atHead.has(entry.file));
    const futureChanged=enrolled.some(entry=>diff.changedFiles?.includes(entry.file));
    if((futureInstalls.length || futureChanged) && (!sameDirectory(atDefault,await completeWorkflowDirectory({read,repository,commit:tip})) ||
      !sameDirectory(atHead,await completeWorkflowDirectory({read,repository,commit:head}))))
      return unknown('future workflow Git tree/directory incomplete or differs');
    const publisherTransitions=[],qualificationTransitions=[];
    const sources=new Map(),selected={schema:registry.schema,workflows:{}};
    const sourceRegistry={...registry,workflows:{...registry.workflows}},sourceRoles={...roleSpecs,workflows:{...roleSpecs.workflows}};
    const readCatalogueSource=createCatalogueSourceReader({registry,roleSpecs});
    for(const [file,blob] of defaultWorkflows) {
      if(atDefault.get(file)!==blob)return unknown('trusted checkout/default catalogue differs');
      const headBlob=atHead.get(file),source=readCatalogueSource({file,blob:headBlob});
      if(!source.source_identified)return unknown('counted CI removed or unregistered at PR head');
      const roles=source.roles;
      if(!roles || roles.length!==source.profile.primary_ids.length ||
        roles.some(role=>!source.profile.primary_ids.includes(role.job_id)))return unknown('counted source roles missing');
      sources.set(file,headBlob);selected.workflows[file]=source.profile;
    }
    for(const [file,blob] of atHead) {
      if(!/\.ya?ml$/.test(file) || defaultWorkflows.has(file) || atDefault.get(file)===blob)continue;
      const text=decodedWorkflow(await read(`/repos/${repository}/contents/${file}?ref=${head}`),file,blob);
      if(!atDefault.has(file) && enrolled.some(entry=>entry.file===file)) {
        const enrollment=Object.hasOwn(EXTERNAL2_FILES,file)?
          acceptedExternal2WorkflowSource(registry,roleSpecs,file,blob,{repository}):
          acceptedFutureWorkflowSource(registry,roleSpecs,file,blob,{repository});
        if(!enrollment.passed)return enrollment;
        if(diff.descriptor.default_branch!==enrollment.entry.exact_source_acceptance_scope.default_branch)
          return unknown('future installation default branch is outside accepted scope');
        const gates=workflowJobs(text).filter(job=>job.name==='admission-gate');
        if(text!==enrollment.profile.source_yaml || workflowFormFindings(text).length || !workflowIsGated(text) ||
          gateFindings(text,null).length || gates.length!==1 || createHash('sha256').update(gates[0].lines.join('\n')).digest('hex')!==
          enrollment.entry.exact_source_acceptance_scope.frozen_gate_sha256)
          return unknown('future workflow bytes/form/FrozenGate differ');
        sources.set(file,blob);selected.workflows[file]=enrollment.profile;
        sourceRegistry.workflows[file]=enrollment.profile;sourceRoles.workflows[file]={sources:{[blob]:enrollment.roles}};
        continue;
      }
      if(Object.hasOwn(PUBLISHER_FILES,file)) {
        const before=atDefault.has(file)?decodedWorkflow(await read(`/repos/${repository}/contents/${file}?ref=${tip}`),file,atDefault.get(file)):null;
        const accepted=registeredPublisherTransition(publisherRegistry,file,text,before,{repository});
        if(text===null || atDefault.has(file)&&before===null || !accepted.passed ||
          workflowFormFindings(text).length || !explicitNonPrWorkflow(text) ||
          gateFindings(text,before,{registeredPublisherTransition:true}).length)
          return unknown('exact dispatch publisher Source/Role/gate missing');
        publisherTransitions.push({file,workflow_blob:accepted.profile.workflow_blob,source_sha256:accepted.profile.source_sha256});
        // This Source admission never turns a dispatch into a required PR run.
        continue;
      }
      if(Object.hasOwn(PUBLISHER_PR_QUALIFICATION_FILES,file)) {
        const before=atDefault.has(file)?decodedWorkflow(await read(`/repos/${repository}/contents/${file}?ref=${tip}`),file,atDefault.get(file)):null;
        const accepted=registeredPublisherPrQualificationTransition(qualificationRegistry,file,text,before,{repository});
        if(text===null||atDefault.has(file)&&before===null||!accepted.passed||
          workflowFormFindings(text).length||gateFindings(text,before).length)
          return unknown('exact nonproduction PR qualification Source/Role/gate missing');
        qualificationTransitions.push({file,workflow_blob:accepted.profile.workflow_blob,
          source_sha256:accepted.profile.source_sha256,proof_classification:'qualification_only'});
        // Expected failure/cancellation are qualification evidence, never
        // successful required application-CI proofs. Full Source checks remain.
        continue;
      }
      if(text===null || workflowFormFindings(text).length || workflowIsGated(text))
        return unknown('non-CI workflow became gated or has ambiguous source');
      if(atDefault.has(file)) {
        const before=decodedWorkflow(await read(`/repos/${repository}/contents/${file}?ref=${tip}`),file,atDefault.get(file));
        // Existing short ungated PR checks retain the accepted gateFindings
        // exception. Their exact authenticated base, not their PR assertion,
        // establishes that class; no new registration of them as tests.
        if(before===null || workflowIsGated(before) || gateFindings(text,before).length)
          return unknown('existing non-CI admission boundary changed');
      } else if(!explicitNonPrWorkflow(text) || gateFindings(text,null).length)
        return unknown('new unregistered CI trigger');
    }
    const targets=applicableCI({workflows:sources,profiles:selected,changedFiles:diff.changedFiles,
      commits:diff.commits,diffComplete:true,sourceQualified:true});
    if(!targets.passed)return targets;
    return {passed:true,state:'qualified',scope:'applicable_workflow_catalogue',workflows:targets.workflows,
      profiles:selected,source_registry:sourceRegistry,source_roles:sourceRoles,
      publisher_transitions:publisherTransitions,
      qualification_transitions:qualificationTransitions,
      future_installations:futureInstalls.map(entry=>entry.file),
      external2_applicable:[...targets.workflows.keys()].some(file=>Object.hasOwn(EXTERNAL2_FILES,file)),
      default_directory:[...atDefault],head_directory:[...atHead]};
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

async function completeLogText(response,signal) {
  if(response.status!==200 || !response.body || typeof response.body.getReader!=='function')throw Error('complete log body unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    for(;;) {
      if(signal?.aborted)throw Error('log observation aborted');
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array) || (size+=value.byteLength)>524288)throw Error('log exceeds observation bounds');
      chunks.push(value);
    }
    if(signal?.aborted)throw Error('log observation aborted');
    const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');
    if(!Buffer.from(text,'utf8').equals(bytes))throw Error('log encoding differs');
    return text;
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Logs stay in memory. Authenticate only requests to GitHub's API; its signed
// storage redirect is followed without the repository credential. Completion
// is set only after EOF, not after reading a prefix or receiving HTTP headers.
export function githubAttemptLogReader(fetchImpl,env) {
  return async(job,run,{signal}={})=>{
    const repository=env.GITHUB_REPOSITORY,api=new URL(env.GITHUB_API_URL||'https://api.github.com');
    if(!env.GITHUB_TOKEN || !REPO.test(repository??'') || api.protocol!=='https:' || api.username || api.password || api.search || api.hash ||
      run?.repository?.full_name!==repository || !Number.isSafeInteger(run.id) || run.id<1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt<1 || !Number.isSafeInteger(job?.id) || job.id<1 ||
      job.run_id!==run.id || job.run_attempt!==run.run_attempt)throw Error('attempt log identity missing');
    const request=async(url,authenticated)=>{
      if(signal?.aborted)throw Error('log observation aborted');
      return fetchImpl(url,{method:'GET',signal,redirect:'manual',headers:authenticated?{
        Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'}:{}});
    };
    const route=api.href.replace(/\/$/,'')+`/repos/${repository}/actions/jobs/${job.id}`;
    const detailResponse=await request(route,true);
    if(detailResponse.status!==200)throw Error('attempt log job unavailable');
    const current=await detailResponse.json();
    if(current?.id!==job.id || current.run_id!==run.id || current.run_attempt!==run.run_attempt ||
      current.status!=='completed' || current.conclusion!==job.conclusion)throw Error('attempt log job changed');
    let response=await request(route+'/logs',true);
    if(response.status===302) {
      const target=new URL(response.headers.get('location'));
      const server=new URL(env.GITHUB_SERVER_URL||'https://github.com');
      const trusted=target.origin===api.origin || target.origin===server.origin ||
        /\.blob\.core\.windows\.net$/.test(target.hostname) || /\.actions\.githubusercontent\.com$/.test(target.hostname);
      if(target.protocol!=='https:' || target.username || target.password || target.hash || !trusted)
        throw Error('log storage origin outside trusted provider');
      response=await request(target.href,false);
    }
    const text=await completeLogText(response,signal);
    return {complete:true,text,job_id:job.id,run_id:run.id,run_attempt:run.run_attempt};
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
      read:guarded(options.read),graphRead:guarded(options.graphRead),
      readLog:typeof options.readLog==='function'?guarded(options.readLog):undefined}),budget]);
  } finally {closed=true;clearTimeout(timer);controller.abort();}
}

async function observeSourceWithinBudget({env,event,eventName,workspace,workflows,read,graphRead,readLog}) {
  if(eventName!=='workflow_run' || !Number.isSafeInteger(event?.workflow_run?.id) || event.workflow_run.id<1)
    return {state:'not_observed',reason:'no workflow-run signal'};
  try {
    const repository=env.GITHUB_REPOSITORY;
    if(!REPO.test(repository??''))return unknown('repository unavailable');
    const run=await read(`/repos/${repository}/actions/runs/${event.workflow_run.id}`);
    const file=String(run?.path??'').replace(/@.*$/,'');
    if(run?.id!==event.workflow_run.id || run.event!=='pull_request' || run.status!=='completed' || !workflows.has(file))
      return {state:'not_observed',reason:'not a completed counted PR workflow'};
    const registry=parseWorkflowProfiles(fs.readFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-profiles.json')));
    const roleSpecs=JSON.parse(fs.readFileSync(path.join(workspace,'scripts/ci/clued-gated-proof-role-specs.json'),'utf8'));
    const source=await workflowSourceOf({read,graphRead,repository,headRepository:run.head_repository?.full_name,
      file,run,registry,roleSpecs,serverURL:env.GITHUB_SERVER_URL});
    // This uses the same bounded attempt-log reader as execution qualification,
    // but proves only this run's PR identity. It never qualifies heavy tests.
    let identity={state:'not_observed',scope:'pr_identity',reason:'qualified source, unique native PR and log reader required'};
    if(source.passed===true && typeof readLog==='function' && Array.isArray(run.pull_requests) &&
      run.pull_requests.length===1 && Number.isSafeInteger(run.pull_requests[0]?.number) && run.pull_requests[0].number>0) {
      try {
        const jobs=await read(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
        if(!Array.isArray(jobs?.jobs) || !Number.isSafeInteger(jobs.total_count) || jobs.total_count!==jobs.jobs.length ||
          jobs.jobs.length>100 || new Set(jobs.jobs.map(job=>job.id)).size!==jobs.jobs.length ||
          jobs.jobs.some(job=>!Number.isSafeInteger(job.id) || job.id<1 || job.run_id!==run.id || job.run_attempt!==run.run_attempt))
          identity={state:'unknown',scope:'pr_identity',reason:'attempt job list incomplete or differs'};
        else {
          const gateFile=path.join(workspace,'scripts/ci/clued-work-admission.mjs');
          const bytes=fs.readFileSync(gateFile),text=bytes.toString('utf8');
          if(bytes.length>524288 || !Buffer.from(text).equals(bytes))throw Error('trusted gate file unavailable');
          identity=await boundRunIdentity({read,readLog,source,run,jobs:jobs.jobs,repository,head:run.head_sha,
            prNumber:run.pull_requests[0].number,trustedGateBlob:workflowBlob(text)});
          // Keep only the fixed diagnostic envelope; never retain log text or
          // storage URLs returned by a reader, even on an unknown result.
          identity={state:identity.passed===true?'qualified':'unknown',scope:'pr_identity',
            reason:identity.reason??null,run_id:run.id,run_attempt:run.run_attempt,
            pr_number:run.pull_requests[0].number,job_id:identity.job_id??null};
        }
      } catch {identity={state:'unknown',scope:'pr_identity',reason:'bounded identity log observation unavailable'};}
    }
    // A started retry invalidates even this read-only observation.
    const latest=await read(`/repos/${repository}/actions/runs/${run.id}`);
    if(latest?.id!==run.id || latest.run_attempt!==run.run_attempt || latest.head_sha!==run.head_sha ||
      latest.event!==run.event || latest.status!==run.status || latest.conclusion!==run.conclusion ||
      JSON.stringify(latest.pull_requests)!==JSON.stringify(run.pull_requests))
      return unknown('source observation attempt changed');
    return {state:source.state,scope:'source_observation_only',run_id:run.id,run_attempt:run.run_attempt,
      head:run.head_sha,file,source_sha:source.source_sha??null,workflow_blob:source.workflow_blob??null,
      reason:source.reason??null,identity_observation:identity,execution_qualified:false};
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
