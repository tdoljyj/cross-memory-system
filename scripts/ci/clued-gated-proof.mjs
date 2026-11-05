// Pure, typed execution proof. Callers supply authenticated, budgeted reads
// and source qualification. No slot/executor imports and no mutation here.
import {validDocumentationSkippedRoute,isExactAllRequiredPrimariesProfile,REQUIRED_TESTS_SOURCE} from './clued-workflow-profile.mjs';
import {inspectRequiredApplicability} from './clued-required-applicability.mjs';
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
    job.run_id!==run.id || job.run_attempt!==run.run_attempt || run.event!=='pull_request' ||
    run.head_sha!==head || run.repository?.full_name!==repository ||
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

// For audited ungated jobs, the pinned checkout action's attempt log binds
// a PR merge ref to a real merge commit; its two parents bind base and head.
export function checkoutIdentityWitness({sourceQualified,log,run,job,repository,head,prNumber,commit,base}) {
  if(sourceQualified!==true || !Number.isSafeInteger(job?.id) || job.id<1 ||
    !Number.isSafeInteger(run?.id) || run.id<1 || !Number.isSafeInteger(run?.run_attempt) || run.run_attempt<1 ||
    job.run_id!==run.id || job.run_attempt!==run.run_attempt || run.event!=='pull_request' ||
    run.head_sha!==head || run.repository?.full_name!==repository ||
    !Number.isSafeInteger(prNumber) || prNumber<1 || !/^[a-f0-9]{40}$/.test(head??'') ||
    !/^[a-f0-9]{40}$/.test(base??'') || log?.complete!==true || log.job_id!==job.id ||
    log.run_id!==run.id || log.run_attempt!==run.run_attempt || typeof log.text!=='string' ||
    log.text.length>524288 || !/^[a-f0-9]{40}$/.test(commit?.sha??'') ||
    !Array.isArray(commit.parents) || commit.parents.length!==2 || commit.parents[0]?.sha!==base ||
    commit.parents[1]?.sha!==head)return unknown('checkout identity source/attempt/merge parents missing');
  const lines=log.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').split(/\r?\n/)
    .map(line=>line.replace(/^\d{4}-\d\d-\d\dT\S+ /,''));
  const refs=lines.filter(line=>/^\[command\].*\/git checkout --progress --force refs\/remotes\/pull\/\d+\/merge$/.test(line));
  const commits=[];
  for(let i=0;i<lines.length-1;i++)if(/^\[command\].*\/git log -1 --format=%H$/.test(lines[i]))commits.push(lines[i+1]);
  if(refs.length!==1 || !refs[0].endsWith(`refs/remotes/pull/${prNumber}/merge`) ||
    commits.length!==1 || commits[0]!==commit.sha)return unknown('checkout ref/commit identity missing or ambiguous');
  return {passed:true,state:'qualified',scope:'pr_identity',head,pr_number:prNumber,run_id:run.id,
    run_attempt:run.run_attempt,job_id:job.id,checkout_sha:commit.sha};
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

function qualifyAllRequiredPrimaries(profile,jobs,file,requiredDiffContext) {
  try {
    if(!isExactAllRequiredPrimariesProfile(profile,file)||!Array.isArray(jobs)||jobs.length!==4)
      return unknown(`${file}: exact all-required Source/jobs missing`);
    const names=['admission-gate',...REQUIRED_TESTS_SOURCE.primary_ids];
    if(jobs.some(job=>!job||!names.includes(job.name))||
      names.some(name=>jobs.filter(job=>job.name===name).length!==1))
      return unknown(`${file}: required primary set missing or duplicate`);
    const nativeId=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):
      typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)?value:null;
    const gate=jobs.find(job=>job.name==='admission-gate'),run=nativeId(gate.run_id),attempt=gate.run_attempt;
    if(!run||!Number.isSafeInteger(attempt)||attempt<1||
      jobs.some(job=>!Number.isSafeInteger(job.id)||job.id<1||nativeId(job.run_id)!==run||job.run_attempt!==attempt)||
      new Set(jobs.map(job=>job.id)).size!==jobs.length)
      return unknown(`${file}: required jobs cross native run/attempt identity`);
    if(gate.status!=='completed'||gate.conclusion!=='success')return unknown(`${file}: gate did not complete successfully`);
    const ids=[],primaryScopes=[];
    for(const name of REQUIRED_TESTS_SOURCE.primary_ids) {
      const job=jobs.find(job=>job.name===name),route=profile.routes.find(route=>route.job_id===name);
      if(job.status==='completed'&&FAILED.has(job.conclusion))return failed(`${file}: required primary ${name} failed`);
      if(job.status!=='completed'||job.conclusion!=='success'||!Array.isArray(job.labels)||
        !job.labels.includes('self-hosted')||!Array.isArray(job.steps)||!route)
        return unknown(`${file}: required primary ${name} did not fully execute`);
      if(name==='migration-verify') {
        const verify=job.steps.filter(step=>step.name==='Verify migrations on the production schema');
        const unaffected=job.steps.filter(step=>step.name==='Not affected');
        if(verify.length===1&&verify[0].status==='completed'&&verify[0].conclusion==='skipped'&&
          unaffected.length===1&&unaffected[0].status==='completed'&&unaffected[0].conclusion==='success') {
          const expected=requiredDiffContext?.expected;
          const evidence=inspectRequiredApplicability(requiredDiffContext?.token,expected);
          const selected=job.steps.filter(step=>step.name==='Select suites'),install=job.steps.filter(step=>step.name==='Install from lockfile');
          if(!evidence||String(evidence.run_id)!==run||evidence.run_attempt!==attempt||
            evidence.gate_job_id!==gate.id||evidence.scope!=='migration-verify:not_applicable'||
            JSON.stringify(evidence.native_job_ids)!==JSON.stringify(jobs.map(j=>j.id).sort((a,b)=>a-b))||
            selected.length!==1||selected[0].status!=='completed'||selected[0].conclusion!=='success'||
            install.length!==1||install[0].status!=='completed'||install[0].conclusion!=='skipped')
            return {...unknown(`${file}: not_applicable_without_independent_diff`),code:'NOT_APPLICABLE_WITHOUT_INDEPENDENT_DIFF'};
          primaryScopes.push({job_id:name,native_job_id:job.id,scope:'not_applicable',
            evidence_scope:evidence.scope,evidence});
          ids.push(job.id);
          return {passed:true,state:'qualified',scope:'required_workflow_requirements_satisfied',
            execution_mode:'all_required_primaries',reason:`${file}: required execution and independent applicability observed`,
            job_ids:ids,primary_scopes:primaryScopes,scopes:[]};
        }
        // Full mode never treats the mutually exclusive no-op as migration
        // execution. It remains Source/FullRole/command-digest bound.
        if(unaffected.length!==1||unaffected[0].status!=='completed'||unaffected[0].conclusion!=='skipped')
          return unknown(`${file}: migration no-op cannot substitute for Full execution`);
      }
      for(const [stepName,count]of Object.entries(route.required_steps)) {
        const steps=job.steps.filter(step=>step.name===stepName);
        if(steps.length!==count||steps.some(step=>step.status!=='completed'))
          return unknown(`${file}: required primary step identity/count differs`);
        if(steps.some(step=>FAILED.has(step.conclusion)))return failed(`${file}: required primary execution step failed`);
        if(steps.some(step=>step.conclusion!=='success'))return unknown(`${file}: required primary execution step did not run`);
      }
      ids.push(job.id);
      primaryScopes.push({job_id:name,native_job_id:job.id,
        scope:name==='ci-suites'?'declared_selected_command':'actual_full'});
    }
    return {passed:true,state:'qualified',scope:'workflow_execution',execution_mode:'all_required_primaries',
      reason:`${file}: all three required primaries executed`,job_ids:ids,primary_scopes:primaryScopes,scopes:[]};
  }catch{return unknown('all-required primary proof unavailable');}
}

export function qualifyPrimary(profile, jobs, file,{requiredDiffContext}={}) {
  if(profile?.execution_eligible===false)return {...unknown('source_metadata_only_disabled'),
    code:'SOURCE_METADATA_ONLY_DISABLED',gate_only:false};
  if(profile&&(Object.hasOwn(profile,'execution_mode')||profile.workflow_blob===REQUIRED_TESTS_SOURCE.workflow_blob||
    file===REQUIRED_TESTS_SOURCE.file))
    return qualifyAllRequiredPrimaries(profile,jobs,file,requiredDiffContext);
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
  if(!validDocumentationSkippedRoute(file,routes[0]))return unknown(`${file}: documentation auxiliary route invalid`);
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
    if(docs && routes[0].documentation_skipped_steps?.includes(name) &&
      steps.every(x=>x.conclusion==='skipped')) continue;
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

export async function qualifiedCI({read,repository,head,base,prNumber,workflows,profiles,authorizeSource,revalidateSources,
  qualifyDocumentation,qualifyRunIdentity,qualifyRequiredApplicability}) {
  try {
    if(!/^[a-f0-9]{40}$/.test(head) || !Number.isInteger(prNumber) || prNumber<=0 ||
        !(workflows instanceof Map) || !profiles?.workflows || typeof authorizeSource!=='function' ||
        typeof revalidateSources!=='function')
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
    const witnessed=new Set(),sourceRuns=[];
    const sourceStillCurrent=async()=>await revalidateSources({repository,head,prNumber,
      runs:sourceRuns.map(({file,run})=>({file,run:{...run}}))})===true;
    const sameMembership=(a,b)=>Array.isArray(a?.pull_requests) && Array.isArray(b.pull_requests) &&
      a.pull_requests.length===b.pull_requests.length &&
      (a.pull_requests.length===1?a.pull_requests[0]?.number===prNumber:
        a.pull_requests.length===0 && witnessed.has(b.id));
    const sameRun=(a,b)=>a?.id===b.id && a.head_sha===head && a.event==='pull_request' &&
      String(a.path??'').replace(/@.*$/,'')===String(b.path??'').replace(/@.*$/,'') &&
      a.run_attempt===b.run_attempt && a.status===b.status && a.conclusion===b.conclusion &&
      sameMembership(a,b);
    const nativeBarrier=async()=>{
      for(const row of latest.values())if(!sameRun(await read(`/repos/${repository}/actions/runs/${row.id}`),row))return false;
      const rows=await completeList(read,`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request`,'workflow_runs');
      if(!rows)return false;
      const current=new Map();
      for(const row of rows) {
        const file=String(row.path??'').replace(/@.*$/,'');
        if(row.head_sha!==head || row.event!=='pull_request' || !workflows.has(file))continue;
        if(!current.has(file)||row.id>current.get(file).id)current.set(file,row);
      }
      if(current.size!==latest.size || [...latest].some(([file,row])=>!sameRun(current.get(file),row)))return false;
      return true;
    };
    const nativeRuns=()=>[...latest.values()].map(run=>({id:run.id,head_sha:run.head_sha,event:run.event,
      path:String(run.path??'').replace(/@.*$/,''),run_attempt:run.run_attempt,status:run.status,conclusion:run.conclusion,
      pull_requests:run.pull_requests.map(pr=>pr.number)}));
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
      if(!await sourceStillCurrent())return unknown('terminal source authority changed');
      if(!await nativeBarrier())return unknown('terminal native state changed during source recheck');
      return {...result,native_runs:nativeRuns()};
      } catch {return unknown('terminal proof recheck read failed');}
    };
    const scopes=[],proofs=[];
    for(const [file,run] of [...latest].sort(([a],[b])=>a.localeCompare(b))) {
      if(run.status!=='completed') return unknown(`${file}: CI active`);
      if(!['success',...FAILED].includes(run.conclusion) || !Number.isInteger(run.run_attempt) || run.run_attempt<1)
        return unknown(`${file}: workflow outcome/attempt unknown`);
      const jobs=await completeList(read,`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,'jobs');
      if(!jobs || jobs.some(job=>job.run_id!==run.id || job.run_attempt!==run.run_attempt))
        return unknown(`${file}: job history incomplete or crosses attempts`);
      if((await authorizeSource({file,run,jobs}))!==true) return unknown(`${file}: candidate source not qualified`);
      sourceRuns.push({file,run});
      // Empty native membership may be resolved only by an independently
      // source-qualified attempt witness. Wrong or multiple associations are
      // never overridden by the fallback.
      if(!Array.isArray(run.pull_requests) || run.pull_requests.length>1 ||
        (run.pull_requests.length===1 && run.pull_requests[0]?.number!==prNumber))
        return unknown(`${file}: PR run membership unavailable or ambiguous`);
      if(run.pull_requests.length===0) {
        if(typeof qualifyRunIdentity!=='function' || (await qualifyRunIdentity({file,run,jobs}))!==true)
          return unknown(`${file}: empty PR membership needs trusted attempt identity`);
        witnessed.add(run.id);
      }
      if(FAILED.has(run.conclusion)) return terminal(run,failed(`${file}: qualified workflow failed`));
      if(jobs.some(x=>x.status==='completed' && FAILED.has(x.conclusion))) return terminal(run,failed(`${file}: CI job failed`));
      if(jobs.some(x=>x.status!=='completed' || !['success','skipped','neutral'].includes(x.conclusion)))
        return unknown(`${file}: job outcome not terminal/valid`);
      let proof;
      proof=qualifyPrimary(profiles.workflows[file],jobs,file);
      if(proof.code==='NOT_APPLICABLE_WITHOUT_INDEPENDENT_DIFF'&&typeof qualifyRequiredApplicability==='function'&&
        /^[a-f0-9]{40}$/.test(base??'')&&isExactAllRequiredPrimariesProfile(profiles.workflows[file],file)) {
        const requestKey=Object.freeze({});
        const expected={repository,prNumber,head,base,runId:run.id,runAttempt:run.run_attempt,requestKey};
        const token=await qualifyRequiredApplicability({file,run,jobs,...expected});
        proof=qualifyPrimary(profiles.workflows[file],jobs,file,{requiredDiffContext:{token,expected}});
      }
      if(proof.gate_only) return run.run_attempt===1?
        terminal(run,{...proof,rerun:{id:run.id,run_attempt:run.run_attempt,path:file}}):
        unknown(`${file}: gate-only recovery already attempted`);
      if(proof.state==='documentation_candidate') {
        if(typeof qualifyDocumentation!=='function' || (await qualifyDocumentation({file,run,jobs}))!==true)
          return unknown(`${file}: documentation scope proof unavailable`);
        proof={...proof,passed:true,state:'qualified'};
      }
      if(!proof.passed) return proof.state==='failed'?terminal(run,proof):proof;
      scopes.push({file,scope:proof.scope,...(proof.primary_scopes?{primary_scopes:proof.primary_scopes}:{})});
      proofs.push({file,id:run.id,run_attempt:run.run_attempt});
    }
    // A queued or started retry, or a newer run, invalidates this observation.
    for(const proof of proofs) {
      const now=await read(`/repos/${repository}/actions/runs/${proof.id}`);
      if(now?.head_sha!==head || now.id!==proof.id || now.event!=='pull_request' ||
        String(now.path??'').replace(/@.*$/,'')!==proof.file ||
        !sameMembership(now,latest.get(proof.file)) ||
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
        !sameMembership(final,latest.get(proof.file)))
        return unknown(`${proof.file}: final latest run/attempt changed`);
    }
    if(!await sourceStillCurrent())return unknown('source authority changed while qualifying');
    if(!await nativeBarrier())return unknown('native state changed during source recheck');
    return {passed:true,state:'qualified',reason:`${proofs.length} qualified CI workflows`,scopes,proofs,native_runs:nativeRuns(),
      ...(scopes.some(s=>s.scope==='required_workflow_requirements_satisfied')?{scope:'required_workflow_requirements_satisfied'}:{})};
  } catch {return unknown('CI qualification read failed');}
}
