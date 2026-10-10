// Pure, typed execution proof. Callers supply authenticated, budgeted reads
// and source qualification. No slot/executor imports and no mutation here.
export const QUALITY = '.github/workflows/clued-cloud-quality-gate.yml';
export const DOCUMENTATION_STEPS = Object.freeze(['Install from lockfile', 'Run npm run lint',
  'Run npm run ledger:verify', 'Run npm run typecheck', 'Run npm run build', 'Run npm run test:unit']);
const FAILED = new Set(['failure','timed_out','action_required','startup_failure']);
const unknown = reason => ({passed:false,state:'unknown',reason,scopes:[]});
const failed = reason => ({passed:false,state:'failed',reason,scopes:[]});

export function qualifyPrimary(profile, jobs, file) {
  if(!profile || !Array.isArray(profile.routes) || !Array.isArray(jobs)) return unknown(`${file}: missing profile/jobs`);
  const gates=jobs.filter(x=>x.name==='admission-gate');
  if(profile.gated && (gates.length!==1 || gates[0].status!=='completed' || gates[0].conclusion!=='success'))
    return unknown(`${file}: gate did not complete successfully`);
  const named=jobs.filter(job=>profile.routes.some(route=>route.name===job.name));
  const primary=named.filter(job=>job.status==='completed' && job.conclusion==='success');
  if(primary.length!==1) {
    const bad=named.find(x=>x.status==='completed' && FAILED.has(x.conclusion));
    if(bad) return failed(`${file}: primary job ${bad.name} failed`);
    const gateOnly=profile.gated && named.length>0 && named.every(x=>x.status==='completed'&&x.conclusion==='skipped') &&
      jobs.filter(x=>x.name!=='admission-gate').every(x=>x.status==='completed'&&x.conclusion==='skipped');
    return {...unknown(`${file}: no unique successful primary job`),gate_only:gateOnly};
  }
  const job=primary[0];
  if(!Array.isArray(job.labels) || !Array.isArray(job.steps)) return unknown(`${file}: missing route/steps`);
  const self=job.labels.includes('self-hosted');
  const routes=profile.routes.filter(x=>x.name===job.name && x.self_hosted===self);
  if(routes.length!==1) return unknown(`${file}: ambiguous primary route`);
  const required=routes[0].required_steps;
  if(!required || !Object.keys(required).length) return unknown(`${file}: empty execution profile`);
  const resultFor=(name)=>job.steps.filter(x=>x.name===name);
  const docs=file===QUALITY && DOCUMENTATION_STEPS.every(name=>resultFor(name).length===1 &&
    resultFor(name)[0].status==='completed' && resultFor(name)[0].conclusion==='skipped') &&
    resultFor('Qualify ordinary documentation changes').length===1 &&
    resultFor('Qualify ordinary documentation changes')[0].conclusion==='success';
  for(const [name,count] of Object.entries(required)) {
    const steps=resultFor(name);
    if(steps.length!==count || steps.some(x=>x.status!=='completed')) return unknown(`${file}: execution step identity/count ${name}`);
    if(docs && DOCUMENTATION_STEPS.includes(name)) continue;
    // The classifier is auxiliary on the Full path: continue-on-error is
    // explicitly coupled to running all six real application steps.
    if(file===QUALITY && name==='Qualify ordinary documentation changes' && !docs) continue;
    if(steps.some(x=>FAILED.has(x.conclusion))) return failed(`${file}: execution step failed ${name}`);
    if(steps.some(x=>x.conclusion!=='success')) return unknown(`${file}: execution step did not run ${name}`);
  }
  return {passed:!docs,state:docs?'documentation_candidate':'qualified',scope:docs?'documentation':'workflow_execution',
    reason:`${file}: primary execution observed`,job_id:job.id,scopes:[]};
}

async function completeList(read, route, key) {
  const items=[],seen=new Set();let expected=null;
  for(let page=1;page<=20;page++) {
    const body=await read(`${route}${route.includes('?')?'&':'?'}per_page=100&page=${page}`);
    if(!Array.isArray(body?.[key]) || !Number.isInteger(body.total_count) || body.total_count<0 ||
        (expected!==null && expected!==body.total_count)) return null;
    expected=body.total_count;
    for(const row of body[key]) {
      if(!row || !Number.isInteger(row.id) || seen.has(row.id)) return null;
      seen.add(row.id);items.push(row);
    }
    if(items.length>=expected) return items.length===expected?items:null;
    if(body[key].length<100) return null;
  }
  return null;
}

export async function qualifiedCI({read,repository,head,prNumber,workflows,profiles,authorizeSource,qualifyDocumentation}) {
  try {
    if(!/^[a-f0-9]{40}$/.test(head) || !Number.isInteger(prNumber) || prNumber<=0 ||
        !(workflows instanceof Map) || !profiles?.workflows || typeof authorizeSource!=='function')
      return unknown('qualification identity/source descriptor missing');
    for(const file of workflows.keys()) if(!profiles.workflows[file]) return unknown(`unrecognized CI profile: ${file}`);
    const list=await completeList(read,`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request`,'workflow_runs');
    if(!list) return unknown('CI run history incomplete');
    const latest=new Map();
    for(const run of list) {
      if(run.head_sha!==head || run.event!=='pull_request') continue;
      const file=String(run.path??'').replace(/@.*$/,'');
      const old=latest.get(file);
      if(!old || run.id>old.id) latest.set(file,run);
    }
    if(!latest.size) return unknown('no CI workflow observed on this head');
    const scopes=[],proofs=[];
    for(const [file,run] of [...latest].sort(([a],[b])=>a.localeCompare(b))) {
      if(run.status!=='completed') return unknown(`${file}: CI active`);
      if(FAILED.has(run.conclusion)) return failed(`${file}: workflow failed`);
      if(run.conclusion!=='success' || !Number.isInteger(run.run_attempt) || run.run_attempt<1)
        return unknown(`${file}: workflow outcome/attempt unknown`);
      // Ambiguous same-SHA PR membership is not a source binding.
      if(!Array.isArray(run.pull_requests) || run.pull_requests.length!==1 || run.pull_requests[0]?.number!==prNumber)
        return unknown(`${file}: PR run membership unavailable or ambiguous`);
      const jobs=await completeList(read,`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,'jobs');
      if(!jobs) return unknown(`${file}: job history incomplete`);
      if(!(await authorizeSource({file,run,jobs}))) return unknown(`${file}: candidate source not qualified`);
      if(jobs.some(x=>x.status==='completed' && FAILED.has(x.conclusion))) return failed(`${file}: CI job failed`);
      if(jobs.some(x=>x.status!=='completed' || !['success','skipped','neutral'].includes(x.conclusion)))
        return unknown(`${file}: job outcome not terminal/valid`);
      let proof;
      if(profiles.workflows[file]) proof=qualifyPrimary(profiles.workflows[file],jobs,file);
      else if(jobs.some(x=>x.name==='admission-gate')) return unknown(`${file}: unknown gated workflow`);
      else proof=jobs.some(x=>x.conclusion==='success')?{passed:true,state:'qualified',scope:'ungated_workflow_execution'}:unknown(`${file}: no ungated execution`);
      if(proof.gate_only) return {...proof,rerun:{id:run.id,run_attempt:run.run_attempt,path:file}};
      if(proof.state==='documentation_candidate') {
        if(typeof qualifyDocumentation!=='function' || !(await qualifyDocumentation({file,run,jobs})))
          return unknown(`${file}: documentation scope proof unavailable`);
        proof={...proof,passed:true,state:'qualified'};
      }
      if(!proof.passed) return proof;
      scopes.push({file,scope:proof.scope});
      proofs.push({file,id:run.id,run_attempt:run.run_attempt});
    }
    // A queued or started retry, or a newer run, invalidates this observation.
    for(const proof of proofs) {
      const now=await read(`/repos/${repository}/actions/runs/${proof.id}`);
      if(now?.head_sha!==head || now.run_attempt!==proof.run_attempt || now.status!=='completed' || now.conclusion!=='success')
        return unknown(`${proof.file}: attempt changed while qualifying`);
    }
    const after=await completeList(read,`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request`,'workflow_runs');
    if(!after) return unknown('latest run recheck incomplete');
    const afterLatest=new Map();
    for(const run of after) if(run.head_sha===head && run.event==='pull_request') {
      const file=String(run.path??'').replace(/@.*$/,'');
      if(!afterLatest.has(file) || run.id>afterLatest.get(file).id) afterLatest.set(file,run);
    }
    if(afterLatest.size!==proofs.length) return unknown('CI workflow set changed while qualifying');
    for(const proof of proofs) if(after.some(x=>x.head_sha===head && x.event==='pull_request' &&
      String(x.path??'').replace(/@.*$/,'')===proof.file && x.id>proof.id)) return unknown(`${proof.file}: newer run appeared`);
    return {passed:true,state:'qualified',reason:`${proofs.length} qualified CI workflows`,scopes,proofs};
  } catch {return unknown('CI qualification read failed');}
}
