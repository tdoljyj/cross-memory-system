#!/usr/bin/env node
// Trusted default-branch revoker. The CI Binding and the GitHub App remain
// in clued-admission; no lease/receiving credential ever reaches this job.
import {fileURLToPath} from 'node:url';
import {appJwt,cluedRpc,ADMISSION_APP_ID} from './clued-work-admission.mjs';

const names=new Set(['clued-admission-verified','clued-merge-slot']);
const repositoryPattern=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
async function api(fetchImpl,env,token,method,route,body) {
  const response=await fetchImpl((env.GITHUB_API_URL??'https://api.github.com').replace(/\/$/,'')+route,{
    method,headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,
      'x-github-api-version':'2022-11-28','content-type':'application/json','user-agent':'clued-handover-revoker'},
    ...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error(`GitHub ${method} ${route} returned ${response.status}`);
  return response.status===204?null:response.json();
}
async function pageAll(fetchImpl,env,token,route,key) {
  const result=[];
  for(let page=1;page<=50;page++){
    const body=await api(fetchImpl,env,token,'GET',route+(route.includes('?')?'&':'?')+'per_page=100&page='+page);
    const items=key?body[key]:body;
    if(!Array.isArray(items))throw new Error('GitHub listing is unavailable');
    result.push(...items);
    if(items.length<100){if(key&&Number.isSafeInteger(body.total_count)&&result.length<body.total_count)throw new Error('GitHub listing is truncated');return result;}
  }
  throw new Error('GitHub listing exceeded its bound');
}
async function command(fetchImpl,env,workspace,input) {
  const reply=await cluedRpc(fetchImpl,env,workspace,'clued_work_verify_v1',input);
  if(reply.status!==200||!reply.body||!['ok','committed'].includes(reply.body.status))throw new Error('Clued revocation admission unavailable: '+reply.detail);
  return reply.body;
}

async function pendingScopes(fetchImpl,env,workspace){
  const scopes=new Set();let cursor;
  for(let page=0;page<50;page++){
    const reply=await command(fetchImpl,env,workspace,{action:'revocations_contexts',scope:'global',...(cursor?{cursor}:{})});
    if(!Array.isArray(reply.context_keys)||reply.context_keys.length>100||!Object.hasOwn(reply,'next_cursor'))throw new Error('Revocation context page unavailable');
    for(const scope of reply.context_keys){
      if(!/^(global|project:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(scope))throw new Error('Invalid revocation context');
      scopes.add(scope);
    }
    const next=reply.next_cursor;
    if(next==null)return scopes;
    if(typeof next!=='string'||(cursor&&next<=cursor)||!/^(global|project:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(next))
      throw new Error('Revocation context cursor unavailable');
    cursor=next;
  }
  throw new Error('Revocation context listing exceeded its bound');
}

async function pendingBatch(fetchImpl,env,workspace,scope){
  const revocations=new Map(),publications=new Map();let outboxCursor,publicationCursor;
  for(let page=0;page<50;page++){
    const reply=await command(fetchImpl,env,workspace,{action:'revocations_list',scope,
      ...(outboxCursor?{outbox_cursor:outboxCursor}:{}),...(publicationCursor?{publication_cursor:publicationCursor}:{})});
    if(!Array.isArray(reply.revocations)||!Array.isArray(reply.publications)
      ||reply.revocations.length>100||reply.publications.length>100
      ||!Object.hasOwn(reply,'next_outbox_cursor')||!Object.hasOwn(reply,'next_publication_cursor'))throw new Error('Revocation page unavailable');
    for(const item of reply.revocations)revocations.set(item.outbox_id,item);
    for(const item of reply.publications)publications.set(item.publication_id,item);
    const nextOutbox=reply.next_outbox_cursor,nextPublication=reply.next_publication_cursor;
    if(nextOutbox==null&&nextPublication==null)return {revocations:[...revocations.values()],publications:[...publications.values()]};
    for(const [next,previous] of [[nextOutbox,outboxCursor],[nextPublication,publicationCursor]]){
      if(next!=null&&(typeof next!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(next)||(previous&&next<=previous)))
        throw new Error('Revocation cursor unavailable');
    }
    outboxCursor=nextOutbox??outboxCursor;publicationCursor=nextPublication??publicationCursor;
  }
  throw new Error('Revocation listing exceeded its bound');
}

export async function revokeHandover({env,fetchImpl=fetch,workspace=env.GITHUB_WORKSPACE}) {
  const repository=env.GITHUB_REPOSITORY;
  if(!repositoryPattern.test(repository??'')||!env.GITHUB_TOKEN||!env.CLUED_CONTEXT_READ_TOKEN)
    throw new Error('Revoker identity/configuration is incomplete');
  if(!env.CLUED_ADMISSION_APP_ID||!env.CLUED_ADMISSION_APP_PRIVATE_KEY)throw new Error('The admission App is unavailable');
  if(Number(env.CLUED_ADMISSION_APP_ID)!==ADMISSION_APP_ID)throw new Error('The configured App is not the required admission App');
  const jwt=appJwt(env.CLUED_ADMISSION_APP_ID,env.CLUED_ADMISSION_APP_PRIVATE_KEY,Math.floor(Date.now()/1000));
  const installation=await api(fetchImpl,env,jwt,'GET',`/repos/${repository}/installation`);
  const minted=await api(fetchImpl,env,jwt,'POST',`/app/installations/${installation.id}/access_tokens`,
    {repositories:[repository.split('/')[1]],permissions:{checks:'write'}});
  const appToken=minted.token;
  // Durable unresolved work must remain discoverable after its claim expires.
  // The service filters each returned context by this CI Binding's live grant.
  const scopes=await pendingScopes(fetchImpl,env,workspace);
  const result={acknowledged:0,pending:0};
  for(const scope of scopes){
    if(!/^(global|project:[0-9a-f-]{36})$/.test(scope))throw new Error('Invalid revocation context');
    const batch=await pendingBatch(fetchImpl,env,workspace,scope);
    for(const publication of batch.publications??[]){
      if(publication.repository.toLowerCase()!==repository.toLowerCase())continue;
      let run=await api(fetchImpl,env,env.GITHUB_TOKEN,'GET',`/repos/${repository}/actions/runs/${publication.run_id}`);
      if(run.status!=='completed'){
        await api(fetchImpl,env,env.GITHUB_TOKEN,'POST',`/repos/${repository}/actions/runs/${publication.run_id}/cancel`);
        run=await api(fetchImpl,env,env.GITHUB_TOKEN,'GET',`/repos/${repository}/actions/runs/${publication.run_id}`);
      }
      // A cancellation request is not a stopped publisher. Leave its ticket
      // open until GitHub confirms completion, even across another sweep.
      if(run.status!=='completed'){result.pending++;continue;}
      const checks=await pageAll(fetchImpl,env,appToken,`/repos/${repository}/commits/${publication.head_sha}/check-runs?filter=all`,'check_runs');
      const exact=checks.filter(c=>names.has(c.name)&&Number(c.app?.id)===ADMISSION_APP_ID&&
        (publication.check_run_id ? String(c.id)===publication.check_run_id :
          c.external_id?.endsWith(`:publication:${publication.publication_id}`)));
      // A stopped process is not proof that an uncertain POST had no effect.
      // Resolve the exact publication, or retain the open ticket.
      if(exact.length!==1){result.pending++;continue;}
      for(const check of checks.filter(c=>names.has(c.name)&&Number(c.app?.id)===Number(env.CLUED_ADMISSION_APP_ID??ADMISSION_APP_ID))){
        await api(fetchImpl,env,appToken,'PATCH',`/repos/${repository}/check-runs/${check.id}`,
          {status:'completed',conclusion:'failure',output:{title:'REVOKED: work handed over',summary:'The old execution epoch is no longer authorized.'}});
      }
      const observed=await api(fetchImpl,env,appToken,'GET',`/repos/${repository}/check-runs/${exact[0].id}`);
      if(observed.status!=='completed'||observed.conclusion!=='failure'){result.pending++;continue;}
      await command(fetchImpl,env,workspace,{action:'publication_reconcile',scope,
        publication_id:publication.publication_id,check_run_id:String(exact[0].id),publisher_stopped:true,checks_revoked:true});
    }
    for(const item of batch.revocations??[]){
      if(item.repository.toLowerCase()!==repository.toLowerCase())continue;
      const heads=new Set(item.head_sha?[item.head_sha]:[]);
      if(item.pr_ref){
        const match=/^([^#]+)#([0-9]{1,10})$/.exec(item.pr_ref);
        if(!match||match[1].toLowerCase()!==repository.toLowerCase())throw new Error('Revocation PR identity mismatch');
        let pr=await api(fetchImpl,env,env.GITHUB_TOKEN,'GET',`/repos/${repository}/pulls/${match[2]}`);
        if(pr.auto_merge){
          const response=await fetchImpl(env.GITHUB_GRAPHQL_URL??'https://api.github.com/graphql',{
            method:'POST',headers:{authorization:'Bearer '+env.GITHUB_TOKEN,'content-type':'application/json'},
            body:JSON.stringify({query:'mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}',variables:{id:pr.node_id}})});
          const value=await response.json();
          if(!response.ok||value.errors?.length||!value.data?.disablePullRequestAutoMerge)throw new Error('Auto-merge revocation is unconfirmed');
          pr=await api(fetchImpl,env,env.GITHUB_TOKEN,'GET',`/repos/${repository}/pulls/${match[2]}`);
        }
        if(pr.auto_merge)throw new Error('Auto-merge remains enabled');
        if(pr.head?.sha)heads.add(pr.head.sha);
        // A legacy bound PR can predate the admission table. Include its
        // complete current ancestry as well as every durable admitted head;
        // failure or truncated history cannot acknowledge the revocation.
        const commits=await pageAll(fetchImpl,env,env.GITHUB_TOKEN,`/repos/${repository}/pulls/${match[2]}/commits`);
        if(!Number.isSafeInteger(pr.commits)||pr.commits<1||commits.length!==pr.commits)
          throw new Error('Revocation PR history is incomplete');
        for(const commit of commits){
          if(typeof commit.sha!=='string'||!/^[0-9a-f]{40}$/.test(commit.sha))throw new Error('Revocation PR history is invalid');
          heads.add(commit.sha);
        }
      }
      let stopped=true;
      for(const head of heads){
        const checks=await pageAll(fetchImpl,env,appToken,`/repos/${repository}/commits/${head}/check-runs?filter=all`,'check_runs');
        for(const check of checks.filter(c=>names.has(c.name)&&Number(c.app?.id)===Number(env.CLUED_ADMISSION_APP_ID))){
          await api(fetchImpl,env,appToken,'PATCH',`/repos/${repository}/check-runs/${check.id}`,
            {status:'completed',conclusion:'failure',output:{title:'REVOKED: work handed over',summary:'All heads of the previous execution epoch require new private authorization.'}});
        }
        {
          // The old epoch may already have passed a runner's pre-job probe.
          // Drain all of its PR jobs as well as manually dispatched jobs.
          // A later rerun must pass the independent current-epoch probe.
          const runs=await pageAll(fetchImpl,env,env.GITHUB_TOKEN,`/repos/${repository}/actions/runs?head_sha=${head}`,'workflow_runs');
          for(const run of runs.filter(r=>r.status!=='completed' && (r.event==='pull_request'
              || (r.event==='workflow_dispatch' && (!item.workflow || r.path===`.github/workflows/${item.workflow}`))))){
            await api(fetchImpl,env,env.GITHUB_TOKEN,'POST',`/repos/${repository}/actions/runs/${run.id}/cancel`);
            const current=await api(fetchImpl,env,env.GITHUB_TOKEN,'GET',`/repos/${repository}/actions/runs/${run.id}`);
            if(current.status!=='completed')stopped=false;
          }
        }
        const after=await pageAll(fetchImpl,env,appToken,`/repos/${repository}/commits/${head}/check-runs?filter=all`,'check_runs');
        if(after.some(c=>names.has(c.name)&&Number(c.app?.id)===Number(env.CLUED_ADMISSION_APP_ID)&&c.conclusion==='success'))stopped=false;
      }
      if(item.pr_ref){
        const number=item.pr_ref.split('#')[1];
        const current=await api(fetchImpl,env,env.GITHUB_TOKEN,'GET',`/repos/${repository}/pulls/${number}`);
        if(current.auto_merge||!heads.has(current.head?.sha))stopped=false;
      }
      if(!stopped){result.pending++;continue;}
      try{
        await command(fetchImpl,env,workspace,{action:'revocation_ack',scope,outbox_id:item.outbox_id,
          execution_epoch:item.execution_epoch,evidence:{checks_revoked:true,auto_merge_disabled:true,dispatch_revoked:true}});
        result.acknowledged++;
      }catch(error){result.pending++;}
    }
  }
  return result;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  revokeHandover({env:process.env}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
