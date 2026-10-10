// Shared read-only bridge. Platform source metadata is independent of job
// stdout; a candidate cannot assert which workflow file GitHub executed.
import {workflowBlob,registeredWorkflowSource,rolesForSource} from './clued-workflow-profile.mjs';

const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const unknown=reason=>({passed:false,state:'unknown',reason});
export const RUN_FILE_QUERY=`query($node:ID!){node(id:$node){...on WorkflowRun{
  databaseId runAttempt event file{path repositoryName repositoryFileUrl
  run{databaseId runAttempt}}}}}`;

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
