// Pure, typed execution proof. Callers supply authenticated, budgeted reads
// and source qualification. No slot/executor imports and no mutation here.
export const QUALITY = '.github/workflows/clued-cloud-quality-gate.yml';
export const DOCUMENTATION_STEPS = Object.freeze(['Install from lockfile', 'Run npm run lint',
  'Run npm run ledger:verify', 'Run npm run typecheck', 'Run npm run build', 'Run npm run test:unit']);
const FAILED = new Set(['failure','timed_out','action_required','startup_failure']);
const unknown = reason => ({passed:false,state:'unknown',reason,scopes:[]});
const failed = reason => ({passed:false,state:'failed',reason,scopes:[]});

// The authenticated reader binds an attempt-specific job log to its job/run.
// This is an identity witness only; it does not qualify the heavy execution.
export function gateIdentityWitness({sourceQualified,log,run,job,repository,head,prNumber,gateSource}) {
  if(sourceQualified!==true || job?.name!=='admission-gate' ||
    !Number.isSafeInteger(job?.id) || job.id<1 || !Number.isSafeInteger(run?.id) || run.id<1 ||
    !Number.isSafeInteger(run?.run_attempt) || run.run_attempt<1 ||
    !Number.isSafeInteger(prNumber) || prNumber<1 || !/^[a-f0-9]{40}$/.test(head??'') ||
    typeof repository!=='string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    log?.complete!==true || log.job_id!==job.id || log.run_id!==run?.id || log.run_attempt!==run.run_attempt ||
    typeof log.text!=='string' || log.text.length>524288 || !/^[a-f0-9]{40}$/.test(gateSource??''))
    return unknown('gate identity log/source descriptor missing');
  const lines=log.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').split(/\r?\n/)
    .map(line=>line.replace(/^\d{4}-\d\d-\d\dT\S+ /,''));
  const objects=[];let chunk=[];
  for(const line of lines) {
    if(!chunk.length && line.trim()==='{')chunk=[line];
    else if(chunk.length){chunk.push(line);if(line==='}'){
      try {const object=JSON.parse(chunk.join('\n'));if(object.mode==='gate')objects.push(object);}catch{}
      chunk=[];
    }}
  }
  if(chunk.length || objects.length!==1)return unknown('gate identity result missing or ambiguous');
  const witness=objects[0];
  if(witness.event!=='pull_request' || witness.head_sha!==head || witness.base_sha!==gateSource ||
    witness.pr_ref!==`${repository}#${prNumber}` || witness.enforced!==true ||
    typeof witness.admitted!=='boolean' || typeof witness.verdict!=='string' || witness.error)
    return unknown('gate identity result differs from qualified source/PR');
  return {passed:true,state:'qualified',scope:'pr_identity',head,pr_number:prNumber,run_id:run.id,
    run_attempt:run.run_attempt,job_id:job.id,gate_source:gateSource};
}

// A source-qualified descriptor supplies the PR's complete three-dot diff.
// Only the literal/*/trailing-/** patterns in the audited workflows are
// supported. New trigger syntax must receive a reviewed implementation.
export function applicableCI({workflows,profiles,changedFiles,commits,diffComplete,sourceQualified}) {
  if(sourceQualified!==true || diffComplete!==true || !(workflows instanceof Map) ||
    !profiles?.workflows || workflows.size!==Object.keys(profiles.workflows).length ||
    !Array.isArray(changedFiles) || changedFiles.length>300 ||
    !Number.isSafeInteger(commits) || commits<1 || commits>1000 ||
    changedFiles.some(file=>typeof file!=='string' || !file.length || /[\u0000-\u001f\u007f\u2028\u2029]/.test(file) || file.startsWith('/') ||
      file.split('/').some(part=>part==='..' || part==='.' || !part)))
    return unknown('applicable CI source/diff is incomplete or exceeds audited trigger boundary');
  const targets=new Map();
  for(const [file,blob] of workflows) {
    const p=profiles?.workflows?.[file];
    if(!p || !/^[a-f0-9]{40}$/.test(p.workflow_blob??'') || p.workflow_blob!==blob ||
      !Object.hasOwn(p,'pull_request'))return unknown(`${file}: workflow/profile source differs`);
    const trigger=p.pull_request;
    if(trigger===null){targets.set(file,blob);continue;}
    if(!trigger || Object.keys(trigger).some(key=>key!=='paths') || !Array.isArray(trigger.paths) || !trigger.paths.length)
      return unknown(`${file}: unsupported PR trigger`);
    const patterns=[];
    for(const pattern of trigger.paths) {
      if(typeof pattern!=='string' || !/^[A-Za-z0-9._/*-]+$/.test(pattern) ||
        pattern.includes('***') || pattern.replace(/\/\*\*$/,'').includes('**') ||
        pattern.split('/').some(part=>part==='..' || part==='.' || !part))
        return unknown(`${file}: unsupported PR path pattern`);
      const deep=pattern.endsWith('/**');const prefix=deep?pattern.slice(0,-3):pattern;
      const expression=prefix.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*');
      patterns.push(new RegExp(`^${expression}${deep?'/(?:.*)':''}$`));
    }
    if(changedFiles.some(path=>patterns.some(pattern=>pattern.test(path))))targets.set(file,blob);
  }
  return targets.size?{passed:true,state:'qualified',workflows:targets}:unknown('no applicable CI target');
}

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
  if(Object.values(required).some(count=>!Number.isSafeInteger(count) || count<1))
    return unknown(`${file}: invalid execution profile count`);
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
      if(!workflows.has(file)) continue;
      const old=latest.get(file);
      if(!old || run.id>old.id) latest.set(file,run);
    }
    if(!latest.size || latest.size!==workflows.size) return unknown('required CI workflow set incomplete');
    // Failures and recovery metadata can drive writes too. Never return a
    // stale terminal result just because only successful proofs reach the end.
    const sameRun=(a,b)=>a?.id===b.id && a.head_sha===head && a.event==='pull_request' &&
      String(a.path??'').replace(/@.*$/,'')===String(b.path??'').replace(/@.*$/,'') &&
      a.run_attempt===b.run_attempt && a.status===b.status && a.conclusion===b.conclusion &&
      Array.isArray(a.pull_requests) && a.pull_requests.length===1 && a.pull_requests[0]?.number===prNumber;
    const terminal=async(run,result)=>{
      try {
      if(!sameRun(await read(`/repos/${repository}/actions/runs/${run.id}`),run))
        return unknown('terminal proof attempt changed');
      const final=await completeList(read,`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request`,'workflow_runs');
      if(!final)return unknown('terminal latest run recheck incomplete');
      const finalLatest=new Map();
      for(const row of final) {
        const file=String(row.path??'').replace(/@.*$/,'');
        if(row.head_sha!==head || row.event!=='pull_request' || !workflows.has(file))continue;
        if(!finalLatest.has(file)||row.id>finalLatest.get(file).id)finalLatest.set(file,row);
      }
      if(finalLatest.size!==latest.size || [...latest].some(([file,row])=>!sameRun(finalLatest.get(file),row)))
        return unknown('terminal latest workflow set changed');
      return result;
      } catch {return unknown('terminal proof recheck read failed');}
    };
    const scopes=[],proofs=[];
    for(const [file,run] of [...latest].sort(([a],[b])=>a.localeCompare(b))) {
      if(run.status!=='completed') return unknown(`${file}: CI active`);
      if(!['success',...FAILED].includes(run.conclusion) || !Number.isInteger(run.run_attempt) || run.run_attempt<1)
        return unknown(`${file}: workflow outcome/attempt unknown`);
      // Ambiguous same-SHA PR membership is not a source binding.
      if(!Array.isArray(run.pull_requests) || run.pull_requests.length!==1 || run.pull_requests[0]?.number!==prNumber)
        return unknown(`${file}: PR run membership unavailable or ambiguous`);
      const jobs=await completeList(read,`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,'jobs');
      if(!jobs) return unknown(`${file}: job history incomplete`);
      if((await authorizeSource({file,run,jobs}))!==true) return unknown(`${file}: candidate source not qualified`);
      if(FAILED.has(run.conclusion)) return terminal(run,failed(`${file}: qualified workflow failed`));
      if(jobs.some(x=>x.status==='completed' && FAILED.has(x.conclusion))) return terminal(run,failed(`${file}: CI job failed`));
      if(jobs.some(x=>x.status!=='completed' || !['success','skipped','neutral'].includes(x.conclusion)))
        return unknown(`${file}: job outcome not terminal/valid`);
      let proof;
      proof=qualifyPrimary(profiles.workflows[file],jobs,file);
      if(proof.gate_only) return run.run_attempt===1?
        terminal(run,{...proof,rerun:{id:run.id,run_attempt:run.run_attempt,path:file}}):
        unknown(`${file}: gate-only recovery already attempted`);
      if(proof.state==='documentation_candidate') {
        if(typeof qualifyDocumentation!=='function' || (await qualifyDocumentation({file,run,jobs}))!==true)
          return unknown(`${file}: documentation scope proof unavailable`);
        proof={...proof,passed:true,state:'qualified'};
      }
      if(!proof.passed) return proof.state==='failed'?terminal(run,proof):proof;
      scopes.push({file,scope:proof.scope});
      proofs.push({file,id:run.id,run_attempt:run.run_attempt});
    }
    // A queued or started retry, or a newer run, invalidates this observation.
    for(const proof of proofs) {
      const now=await read(`/repos/${repository}/actions/runs/${proof.id}`);
      if(now?.head_sha!==head || now.id!==proof.id || now.event!=='pull_request' ||
        String(now.path??'').replace(/@.*$/,'')!==proof.file ||
        !Array.isArray(now.pull_requests) || now.pull_requests.length!==1 || now.pull_requests[0]?.number!==prNumber ||
        now.run_attempt!==proof.run_attempt || now.status!=='completed' || now.conclusion!=='success')
        return unknown(`${proof.file}: attempt changed while qualifying`);
    }
    const after=await completeList(read,`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request`,'workflow_runs');
    if(!after) return unknown('latest run recheck incomplete');
    const afterLatest=new Map();
    for(const run of after) if(run.head_sha===head && run.event==='pull_request') {
      const file=String(run.path??'').replace(/@.*$/,'');
      if(!workflows.has(file)) continue;
      if(!afterLatest.has(file) || run.id>afterLatest.get(file).id) afterLatest.set(file,run);
    }
    if(afterLatest.size!==proofs.length) return unknown('CI workflow set changed while qualifying');
    for(const proof of proofs) {
      const final=afterLatest.get(proof.file);
      if(!final || final.id!==proof.id || final.run_attempt!==proof.run_attempt ||
        final.status!=='completed' || final.conclusion!=='success' ||
        !Array.isArray(final.pull_requests) || final.pull_requests.length!==1 || final.pull_requests[0]?.number!==prNumber)
        return unknown(`${proof.file}: final latest run/attempt changed`);
    }
    return {passed:true,state:'qualified',reason:`${proofs.length} qualified CI workflows`,scopes,proofs};
  } catch {return unknown('CI qualification read failed');}
}
