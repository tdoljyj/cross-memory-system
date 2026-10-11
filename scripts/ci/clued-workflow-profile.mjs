import {createHash} from 'node:crypto';

const digest=text=>createHash('sha256').update(text).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const roleDefinitionDigest=job=>digest(JSON.stringify(canonical(job)));
export const workflowBlob=text=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const CACHE_OBSERVER='Observe npm HTTP cache events';
const CACHE_COMMAND='node "$GITHUB_WORKSPACE/scripts/ci/npm-cache-observation.mjs"';
const CACHE_CONDITION="${{ !cancelled() && (steps.classify.outcome != 'success' || steps.classify.outputs.run_full != 'false') }}";
const CACHE_DIRECTORY='${{ runner.temp }}/clued-npm-debug-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}';
export function validDocumentationSkippedRoute(file,route) {
  if(!Object.hasOwn(route,'documentation_skipped_steps'))return true;
  return file==='.github/workflows/clued-cloud-quality-gate.yml' && route.job_id==='trusted-self-hosted' &&
    route.self_hosted===true && route.name==='clued-cloud-quality' &&
    Array.isArray(route.documentation_skipped_steps) && route.documentation_skipped_steps.length===1 &&
    route.documentation_skipped_steps[0]===CACHE_OBSERVER && route.required_steps?.[CACHE_OBSERVER]===1 &&
    route.command_digests?.[CACHE_OBSERVER]?.[0]===digest(CACHE_COMMAND);
}
// This exception belongs only to the reviewed Self source/role and docs path.
// It never qualifies telemetry as application execution or changes older routes.
function documentationSkippedSteps(value,id,job,name) {
  if(value.name!=='clued-cloud-quality' || id!=='trusted-self-hosted' || name!=='clued-cloud-quality' ||
    !Array.isArray(job['runs-on']) || !job['runs-on'].includes('self-hosted'))return [];
  const steps=job.steps.filter(step=>step.name===CACHE_OBSERVER);
  const step=steps[0];
  if(steps.length!==1 || step.run!==CACHE_COMMAND || step.if!==CACHE_CONDITION ||
    step['continue-on-error']!==undefined || step.env?.npm_config_logs_dir!==CACHE_DIRECTORY ||
    step.env?.NPM_INSTALL_OUTCOME!=='${{ steps.install.outcome }}')return [];
  return [CACHE_OBSERVER];
}
const reject=reason=>{throw new Error(`unregistered workflow definition: ${reason}`);};

// Independent roles are keyed by the exact source blob. A future source must
// never inherit the current source's job definitions merely by sharing a path.
export function rolesForSource(specs,file,blob) {
  if(specs?.schema!=='clued.gated-proof-role-specs/2' || !/^[a-f0-9]{40}$/.test(blob??''))return null;
  const sources=specs.workflows?.[file]?.sources;
  if(!sources || !Object.hasOwn(sources,blob))return null;
  const roles=sources[blob];
  if(!Array.isArray(roles) || !roles.length || roles.some(role=>!role ||
    typeof role.job_id!=='string' || !role.job_id || !/^[a-f0-9]{64}$/.test(role.definition_sha256??'')) ||
    new Set(roles.map(role=>role.job_id)).size!==roles.length)return null;
  return roles;
}

// Registration-time compiler only. parseYaml must be the locked, independently
// checked YAML parser. Consumers use default-branch registered data, never a
// pull request's asserted profile or executable parser.
export function compileRegisteredWorkflow(text,{primary_ids,parseYaml,accepted_roles}={}) {
  if(typeof text!=='string' || text.length>524288 || typeof parseYaml!=='function' ||
    !Array.isArray(primary_ids) || !primary_ids.length || new Set(primary_ids).size!==primary_ids.length ||
    !Array.isArray(accepted_roles) || accepted_roles.length!==primary_ids.length ||
    new Set(accepted_roles.map(role=>role?.job_id)).size!==accepted_roles.length ||
    accepted_roles.some(role=>!role || !primary_ids.includes(role.job_id) || !/^[a-f0-9]{64}$/.test(role.definition_sha256??'')))
    reject('source/parser/primary roles missing');
  if(/\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text))reject('source character domain');
  const value=parseYaml(text);
  if(!value?.jobs || !value.on || !Object.hasOwn(value.on,'pull_request'))reject('PR jobs missing');
  const trigger=value.on.pull_request??null;
  if(trigger!==null && (typeof trigger!=='object' || Array.isArray(trigger) ||
    Object.keys(trigger).some(key=>key!=='paths') || !Array.isArray(trigger.paths) || !trigger.paths.length))
    reject('unsupported trigger');
  if(trigger?.paths.some(pattern=>typeof pattern!=='string' || !/^[A-Za-z0-9._/*-]+$/.test(pattern) ||
    pattern.includes('***') || pattern.replace(/\/\*\*$/,'').includes('**') ||
    pattern.split('/').some(part=>part==='.' || part==='..' || !part)))reject('unsupported path filter');
  const routes=[];
  const undeclared=Object.keys(value.jobs).filter(id=>!['admission-gate','push-reuse'].includes(id)&&!primary_ids.includes(id));
  if(undeclared.length)reject('unassigned job roles: '+undeclared.join(','));
  for(const id of primary_ids) {
    if(typeof id!=='string' || !Object.hasOwn(value.jobs,id) || ['admission-gate','push-reuse'].includes(id))reject('primary role not a concrete job');
    const job=value.jobs[id];
    if(accepted_roles.find(role=>role.job_id===id)?.definition_sha256!==roleDefinitionDigest(job))
      reject('primary definition has no independent accepted role');
    if(!job || job.uses || job.strategy || !Array.isArray(job.steps))reject('reusable/matrix/missing steps');
    const labels=job['runs-on'];
    if(!(typeof labels==='string' && /^(ubuntu|windows|macos)-[A-Za-z0-9.-]+$/.test(labels)) &&
      !(Array.isArray(labels) && labels.every(x=>typeof x==='string' && /^[A-Za-z0-9.-]+$/.test(x)) && labels.includes('self-hosted')))
      reject('runner route is not literal');
    const raw=job.name??id;let name;
    if(typeof raw!=='string')reject('job name type');
    if(raw.startsWith('${{')) {
      const match=/&&\s*'([A-Za-z0-9_.-]+)'\s*\|\|\s*'([A-Za-z0-9_.-]+-skipped)'\s*\}\}$/.exec(raw);
      if(!match || !match[2].startsWith(match[1]+'-'))reject('dynamic job name');
      name=match[1];
    } else {if(!raw || raw.length>2000 || /[\u0000-\u001f\u007f\u0085\u2028\u2029]|\$\{\{/.test(raw))reject('job name domain');name=raw;}
    const commands=Object.create(null);
    for(const step of job.steps) {
      if(!step || typeof step!=='object' || Array.isArray(step))reject('step type');
      if(step.run===undefined || step.if==='failure()')continue;
      if(typeof step.run!=='string' || !step.run.trim())reject('empty command');
      const stepName=step.name??('Run '+step.run.split('\n')[0]);
      if(typeof stepName!=='string' || !stepName || stepName.includes('${{'))reject('step name domain');
      (commands[stepName]??=[]).push(digest(step.run.replace(/\r\n/g,'\n').trimEnd()));
    }
    if(!Object.keys(commands).length)reject('primary has no execution command');
    const docsSkipped=documentationSkippedSteps(value,id,job,name);
    routes.push({job_id:id,name,self_hosted:Array.isArray(labels)&&labels.includes('self-hosted'),
      required_steps:Object.fromEntries(Object.entries(commands).map(([name,values])=>[name,values.length])),
      command_digests:Object.fromEntries(Object.entries(commands)),
      ...(docsSkipped.length?{documentation_skipped_steps:docsSkipped}:{})});
  }
  if(routes.length>2 || new Set(routes.map(route=>route.self_hosted)).size!==routes.length)
    reject('unsupported multiple logical primaries or duplicate routes');
  return {registration_status:'registered',workflow_blob:workflowBlob(text),source_sha256:digest(text),
    source_yaml:text,primary_ids:[...primary_ids],pull_request:trigger,gated:Object.hasOwn(value.jobs,'admission-gate'),routes};
}

// Map contains the complete, authenticated set of CI sources on this head.
// Registry comes only from the trusted default-branch checkout. A new head
// cannot register itself by sending a profile in its own JSON.
export function registeredWorkflowSource(registry,file,blob) {
  const unknown=reason=>({passed:false,state:'unknown',reason});
  try {
    if(registry?.schema!=='clued.gated-proof-profiles/2')return unknown('source registry schema missing');
    if(!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || !/^[a-f0-9]{40}$/.test(blob))
      return unknown('CI source identity invalid');
    const root=registry.workflows?.[file];
    if(root && Object.hasOwn(root,'accepted_sources') && !Array.isArray(root.accepted_sources))
      return unknown(`${file}: accepted source list invalid`);
    const entries=root?[root,...(Array.isArray(root.accepted_sources)?root.accepted_sources:[])]:[];
    const matching=entries.filter(entry=>entry.registration_status==='registered' && entry.workflow_blob===blob);
    if(matching.length!==1)return unknown(`${file}: exact source has no unique current registration`);
    const entry=matching[0];
    if(typeof entry.source_yaml!=='string' || workflowBlob(entry.source_yaml)!==blob ||
      digest(entry.source_yaml)!==entry.source_sha256 || !Array.isArray(entry.primary_ids) ||
      !entry.primary_ids.length || new Set(entry.primary_ids).size!==entry.primary_ids.length ||
      !Array.isArray(entry.routes) || entry.routes.length!==entry.primary_ids.length ||
      new Set(entry.routes.map(route=>route.job_id)).size!==entry.routes.length ||
      typeof entry.gated!=='boolean' ||
      entry.routes.some(route=>!entry.primary_ids.includes(route.job_id) || !Object.keys(route.required_steps??{}).length ||
        typeof route.self_hosted!=='boolean' || typeof route.name!=='string' || !route.name ||
        !validDocumentationSkippedRoute(file,route) ||
        Object.entries(route.required_steps).some(([name,count])=>!Number.isSafeInteger(count) || count<1 ||
          !Array.isArray(route.command_digests?.[name]) || route.command_digests[name].length!==count ||
          route.command_digests[name].some(hash=>!/^[a-f0-9]{64}$/.test(hash)))))
      return unknown(`${file}: registered source/profile integrity invalid`);
    return {passed:true,state:'qualified',profile:entry};
  } catch {return unknown('registered source/profile schema invalid');}
}

export function selectRegisteredProfiles(registry,sources,{sourceApproved,directoryComplete}={}) {
  if(registry?.schema!=='clued.gated-proof-profiles/2' || !(sources instanceof Map) ||
    directoryComplete!==true || sourceApproved!==true || !sources.size)
    return {passed:false,state:'unknown',reason:'source approval/directory/registry missing'};
  const selected={schema:registry.schema,workflows:{}};
  for(const [file,blob] of sources) {
    const result=registeredWorkflowSource(registry,file,blob);
    if(!result.passed)return result;
    selected.workflows[file]=result.profile;
  }
  return {passed:true,state:'qualified',profiles:selected};
}
