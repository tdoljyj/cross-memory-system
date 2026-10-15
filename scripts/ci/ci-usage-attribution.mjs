// Read-only attribution of merged-PR samples. Unknown evidence stays unknown;
// a later head or a cancelled run is not proof of why GitHub cancelled it.
import {ADMISSION_APP_ID} from './clued-work-admission.mjs';
const SHA = /^[a-f0-9]{40}$/;
const time = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
// Read-only history spans the check-name cutover; this never admits work.
const admissionNames=new Set(['kooyumi-admission-verified','clued-admission-verified']);

export function admissionObservation(check, appId, head) {
  if (!admissionNames.has(check?.name) || check.app?.id !== appId ||
      check.head_sha !== head || check.status !== 'completed') return null;
  const match = /^(?:RE-VERIFIED(?: \(state change\))?: )?(ADMITTED|REJECTED|NOT ADMITTED) \[(normal|efficiency|frozen) · (protected|code|docs) · reruns (\d+)\]$/.exec(check.output?.title ?? '');
  const identity = /^pr:([1-9][0-9]{0,9}):run:([0-9]{1,20})$/.exec(check.external_id ?? '');
  const at = time(check.completed_at);
  // Keep malformed/unknown titles as barriers. Dropping them would attribute
  // a later job to an older mode that might already have been revoked.
  return {id:check.id, at, pr:identity?Number(identity[1]):null,
    verdict:match?.[1]??null, state:match?.[2]??null, layer:match?.[3]??null,
    conclusion:check.conclusion, reruns:match?Number(match[4]):null};
}

export function observationAt(observations, startedAt, prNumber) {
  const at = time(startedAt);
  if (at === null || !Number.isInteger(prNumber)) return null;
  const own=observations.filter(x=>x.pr===prNumber || x.pr===null);
  if(own.some(x=>x.at===null || !Number.isInteger(x.id))) return null;
  const latest=own.filter(x=>x.at <= at).sort((a,b)=>b.at-a.at || b.id-a.id)[0]??null;
  return latest?.pr===prNumber?latest:null;
}

async function pages(request, route, key, max=1000) {
  const items=[],seen=new Set();let total=null;
  for(let page=1;items.length<max;page++) {
    const result=await request(`${route}${route.includes('?')?'&':'?'}per_page=100&page=${page}`);
    if(!result.ok) return {items,complete:false};
    const rows=key?result.body?.[key]:result.body;
    if(!Array.isArray(rows)) throw new Error('attribution_list_schema');
    if(key) {
      const current=result.body.total_count;
      if(!Number.isInteger(current) || current<0 || (total!==null && current!==total)) return {items,complete:false};
      total=current;
    }
    for(const row of rows) {
      const identity=key?row?.id:row?.sha;
      if((key?!Number.isInteger(identity):!SHA.test(identity)) || seen.has(identity)) return {items,complete:false};
      seen.add(identity);
    }
    items.push(...rows);
    if(key && items.length>=total) return {items,complete:items.length===total};
    if(rows.length<100) return {items,complete:!key};
  }
  return {items,complete:false};
}

export async function collectAttribution({request,repository,runs,pulls,runsOfPull}) {
  const relevant=new Map();
  for(const pr of pulls) for(const run of runsOfPull(pr,runs)) if(SHA.test(run.head_sha)) relevant.set(run.head_sha,run);
  const heads=new Map(), updates=[];
  const coverage={scope:'runs associated with pull requests merged in this report window',heads_requested:relevant.size,
    heads_complete:0,pulls_requested:pulls.length,pulls_complete:0,errors:0};
  if(!relevant.size) return {heads,updates,coverage};
  const app=await request('/apps/clued-admission');
  const appId=app.ok && app.body?.slug==='clued-admission' && app.body.id===ADMISSION_APP_ID?app.body.id:null;
  if(!appId) return {heads,updates,coverage};
  for(const head of relevant.keys()) {
    try {
      const listed=await pages(request,`/repos/${repository}/commits/${head}/check-runs?filter=all`,'check_runs');
      if(!listed.complete) continue;
      heads.set(head,listed.items.map(x=>admissionObservation(x,appId,head)).filter(Boolean));
      coverage.heads_complete++;
    } catch {coverage.errors++;}
  }
  // Commit parents prove actual DAG relationships. Message text and a two-parent
  // commit alone do not prove that a PR incorporated the main branch.
  for(const pr of pulls) {
    if(!runsOfPull(pr,runs).length) continue;
    try {
      const detail=await request(`/repos/${repository}/pulls/${pr.number}`);
      if(!detail.ok || detail.body?.number!==pr.number || !detail.body?.merged_at || !SHA.test(detail.body.merge_commit_sha) ||
          !SHA.test(detail.body.head?.sha) || !Number.isInteger(detail.body.commits)) continue;
      const commits=await pages(request,`/repos/${repository}/pulls/${pr.number}/commits`,null,300);
      if(!commits.complete || commits.items.length!==detail.body.commits ||
          !commits.items.some(x=>x.sha===detail.body.head.sha)) continue;
      const final=await request(`/repos/${repository}/git/commits/${detail.body.merge_commit_sha}`);
      if(!final.ok || final.body?.sha!==detail.body.merge_commit_sha || final.body?.parents?.length!==2 ||
          final.body.parents[1]?.sha!==detail.body.head.sha || !SHA.test(final.body.parents[0]?.sha)) continue;
      const mainBeforeMerge=final.body.parents[0].sha;
      let count=0,complete=true;
      for(const commit of commits.items) {
        if(commit.parents?.length!==2) continue;
        const [first,second]=commit.parents.map(x=>x.sha);
        if(!SHA.test(first) || !SHA.test(second)) {complete=false;break;}
        const comparison=second===mainBeforeMerge?{ok:true,body:{status:'identical'}}:
          await request(`/repos/${repository}/compare/${second}...${mainBeforeMerge}`);
        if(!comparison.ok || !['ahead','identical','behind','diverged'].includes(comparison.body?.status)) {complete=false;break;}
        if(!['ahead','identical'].includes(comparison.body.status)) continue;
        // Exclude merging two branches that were both already on main.
        const firstComparison=await request(`/repos/${repository}/compare/${first}...${mainBeforeMerge}`);
        if(!firstComparison.ok || !['ahead','identical','behind','diverged'].includes(firstComparison.body?.status)) {complete=false;break;}
        if(!['ahead','identical'].includes(firstComparison.body.status)) count++;
      }
      if(complete) {updates.push({pr:pr.number,count,head_sha:detail.body.head.sha,main_before_merge:mainBeforeMerge});coverage.pulls_complete++;}
    } catch {coverage.errors++;}
  }
  return {heads,updates,coverage};
}

export function attributionMetrics({runs,pulls,jobsByRun,attribution,isSelfHosted,durationMinutes,round}) {
  const byLayer={},byState={},failureTitles={};
  let observedJobs=0,unknownJobs=0,cancelled=0,laterHeadSeen=0;
  const runMap=new Map(runs.map(x=>[x.id,x]));
  for(const [runId,jobs] of jobsByRun) {
    const run=runMap.get(runId);
    for(const job of jobs) {
      const minutes=durationMinutes(job.started_at,job.completed_at);
      if(job.status!=='completed' || minutes===null || !isSelfHosted(job)) continue;
      const named=run?.pull_requests??[];
      const matches=run?.event==='pull_request'?(named.length?named:pulls.filter(pr=>pr.head_ref===run?.head_branch &&
        run?.created_at>=pr.created_at && run?.created_at<=pr.merged_at).map(pr=>pr.number)):[];
      const pr=matches.length===1 && pulls.some(x=>x.number===matches[0])?matches[0]:null;
      const observed=observationAt(attribution.heads.get(run?.head_sha)??[],job.started_at,pr);
      const layer=observed?.layer??'unknown',state=observed?.state??'unknown';
      byLayer[layer]=(byLayer[layer]??0)+minutes;byState[state]=(byState[state]??0)+minutes;
      if(observed?.state && observed?.layer) observedJobs++;else unknownJobs++;
      if(job.conclusion==='cancelled') {
        cancelled++;
        // This is a correlation, not a timeout/queue-return/supersession cause.
        if(runs.some(x=>x.event==='pull_request' && x.head_branch===run?.head_branch &&
          x.head_sha!==run?.head_sha && x.created_at>run?.created_at && x.created_at<=job.completed_at)) laterHeadSeen++;
      }
    }
  }
  for(const checks of attribution.heads.values()) for(const check of checks) if(check.conclusion==='failure')
    failureTitles[check.verdict??'unknown']=(failureTitles[check.verdict??'unknown']??0)+1;
  const rounded=(value)=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,round(v)]));
  return {scope:attribution.coverage.scope,coverage:attribution.coverage,
    self_hosted_minutes:{by_layer:rounded(byLayer),by_state:rounded(byState),observed_jobs:observedJobs,unknown_jobs:unknownJobs,
      note:'Latest exact-App completed admission observation no later than each job start; non-associated and unobserved jobs stay unknown. Runtime minutes, not billing.'},
    main_parent_merge_candidates:{status:'partial',
      value:attribution.updates.length?attribution.updates.reduce((n,x)=>n+x.count,0):null,per_pr:attribution.updates,
      note:'Source merge candidates whose second parent is on main before final PR merge. This does NOT prove it was main at the historical merge time: another feature may have reached main later. Not update_main_rounds, wasted work or a savings lower bound.'},
    cancellation_observations:{cancelled_self_hosted_jobs:cancelled,later_different_head_seen:laterHeadSeen,
      cause_counts:null,note:'A later head is correlation only; API job conclusion does not identify actor or cancellation cause.'},
    admission_failure_verdicts:{value:failureTitles,note:'Exact-App verdict titles, not failure reasons or Clued claim receipts.'}};
}
