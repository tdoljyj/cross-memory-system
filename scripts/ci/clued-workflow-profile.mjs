import {createHash} from 'node:crypto';
export const COMPONENT_VERSION = "1.0.3";

const digest=text=>createHash('sha256').update(text).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const roleDefinitionDigest=job=>digest(JSON.stringify(canonical(job)));
export const workflowBlob=text=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
export const FUTURE_WORKFLOW_PURPOSE='work_handover_consumer_qualification';
const FUTURE_CONSUMERS=new Set(['company-linux-01','company-linux-02','company-linux-03','company-linux-04',
  'home-linux-01','company-win-01','home-win-01']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const exactKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
  same(Object.keys(value).sort(),[...keys].sort());
// Only this bounded installation purpose is implemented. An acceptance binds
// all Source bytes and independently assigned roles, not a path-level permit.
export function futureWorkflowSubject(entry,roles) {
  return digest(JSON.stringify(canonical({file:entry.file,consumer_id:entry.consumer_id,purpose:entry.purpose,
    source_profile:entry.source_profile,workflow_definition:entry.workflow_definition,
    exact_source_acceptance_scope:entry.exact_source_acceptance_scope,roles})));
}

export function futureWorkflowCatalogue(registry,specs) {
  const bad=reason=>({passed:false,state:'unknown',reason});
  try {
    if(registry?.schema!=='clued.gated-proof-profiles/2' || specs?.schema!=='clued.gated-proof-role-specs/2')
      return bad('future catalogue schema missing');
    const entries=registry.future_workflows??[],roleEntries=specs.future_workflows??[];
    if(!Array.isArray(entries) || !Array.isArray(roleEntries) || entries.length>7 || roleEntries.length!==entries.length)
      return bad('future catalogue bounds differ');
    const files=new Set(),blobs=new Set();
    for(const entry of entries) {
      const blob=entry?.source_profile?.workflow_blob;
      if(!exactKeys(entry,['file','consumer_id','registration_status','purpose','source_profile','workflow_definition',
        'exact_source_acceptance_scope','source_acceptance']) || !FUTURE_CONSUMERS.has(entry.consumer_id) || entry.file!==
        `.github/workflows/clued-work-handover-qualification-${entry.consumer_id}.yml` ||
        entry.registration_status!=='accepted_not_installed' || !/^[a-f0-9]{40}$/.test(blob??'') ||
        files.has(entry.file) || blobs.has(blob) || Object.hasOwn(registry.workflows??{},entry.file) ||
        Object.hasOwn(specs.workflows??{},entry.file))
        return bad('future file/blob is invalid, duplicate or active');
      files.add(entry.file);blobs.add(blob);
      const matches=roleEntries.filter(role=>role?.file===entry.file && role.workflow_blob===blob);
      if(matches.length!==1 || !exactKeys(matches[0],['file','workflow_blob','roles']) || roleEntries.some(role=>!files.has(role?.file) &&
        !entries.some(value=>value.file===role?.file)))return bad('future independent role catalogue differs');
    }
    if(new Set(roleEntries.map(role=>role?.file)).size!==roleEntries.length)return bad('future roles duplicate');
    return {passed:true,state:'qualified',entries};
  } catch {return bad('future catalogue invalid');}
}

export function acceptedFutureWorkflowSource(registry,specs,file,blob,{repository}={}) {
  const bad=reason=>({passed:false,state:'unknown',reason});
  try {
    const catalogue=futureWorkflowCatalogue(registry,specs);
    if(!catalogue.passed)return catalogue;
    const entries=catalogue.entries.filter(entry=>entry.file===file && entry.source_profile.workflow_blob===blob);
    if(entries.length!==1)return bad('exact future source is not independently enrolled');
    const entry=entries[0],profile=entry.source_profile,acceptance=entry.source_acceptance,scope=entry.exact_source_acceptance_scope;
    const roles=specs.future_workflows.find(role=>role.file===file && role.workflow_blob===blob)?.roles;
    const picked=registeredWorkflowSource({schema:registry.schema,workflows:{[file]:profile}},file,blob);
    if(!picked.passed || profile.gated!==true || Object.hasOwn(profile,'accepted_sources') ||
      entry.purpose!==FUTURE_WORKFLOW_PURPOSE || !Array.isArray(roles) || roles.length!==profile.primary_ids.length ||
      rolesForSource({schema:specs.schema,workflows:{[file]:{sources:{[blob]:roles}}}},file,blob)===null ||
      roles.some(role=>!profile.primary_ids.includes(role.job_id)))return bad('future purpose/profile/roles invalid');
    // Registration binds the full parsed definition with the locked parser.
    // Runtime trusts that accepted default Source, but recompiles every role
    // restriction and command digest without loading any PR code or parser.
    if(!entry.workflow_definition || roles.some(role=>!exactKeys(role,['job_id','definition_sha256','definition']) || !role.definition ||
      roleDefinitionDigest(role.definition)!==role.definition_sha256 ||
      !same(role.definition,entry.workflow_definition.jobs?.[role.job_id])))return bad('future full role definition differs');
    const compiled=compileRegisteredWorkflow(profile.source_yaml,{primary_ids:profile.primary_ids,
      parseYaml:()=>entry.workflow_definition,accepted_roles:roles});
    if(!same(compiled,profile))return bad('future compiled Source differs');
    const expectedScope={repository,default_branch:'main',operation:'new_workflow_file_installation',file,
      purpose:FUTURE_WORKFLOW_PURPOSE,consumer_id:entry.consumer_id,workflow_blob:blob,source_sha256:profile.source_sha256,
      primary_ids:profile.primary_ids,roles:roles.map(role=>({job_id:role.job_id,definition_sha256:role.definition_sha256})),
      command_digests:profile.routes.map(route=>({job_id:route.job_id,
        command_digests:route.command_digests})),workflow_definition_sha256:roleDefinitionDigest(entry.workflow_definition),
      frozen_gate_sha256:scope?.frozen_gate_sha256};
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository??'') ||
      !/^[a-f0-9]{64}$/.test(scope?.frozen_gate_sha256??'') || !same(scope,expectedScope))
      return bad('future exact Source acceptance scope differs');
    if(!exactKeys(acceptance,['status','authority','decision_ref','receipt_id','subject_sha256']) ||
      acceptance.status!=='accepted' || acceptance.authority!=='owner' ||
      !/^clued:decision:[a-f0-9-]{36}@v[1-9][0-9]*$/.test(acceptance.decision_ref??'') ||
      !UUID.test(acceptance.decision_ref.slice(15).split('@')[0]) || !UUID.test(acceptance.receipt_id??'') ||
      acceptance.subject_sha256!==futureWorkflowSubject(entry,roles))return bad('future Source Owner acceptance missing or revoked');
    return {passed:true,state:'qualified',scope:'accepted_future_workflow_source',entry,profile,roles};
  } catch {return bad('future Source acceptance invalid');}
}
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

// Fixed External2 successor only. This never widens readonly-seven purpose.
export const EXTERNAL2_PURPOSE='work_handover_external2_disposable_qualification';
export const EXTERNAL2_FILES=Object.freeze({
  '.github/workflows/clued-handover-external-qualification.yml':{
    role:'external2_qualify',primary_id:'qualify',
    workflow_blob:'ac90bc2f7e34a94be3c50c4581ba49cc139b3980',
    source_sha256:'73de5152cf31f66cf2086994aac8343dc1b81664774966d0bb8c00430fa3f947',
    definition_sha256:'d95fe3e0a197a5bf7b9448733eafaa32a80be20f47b47b9cf734e60cb8f6e24e',
  },
  '.github/workflows/clued-handover-disposable-idle.yml':{
    role:'external2_disposable_idle',primary_id:'disposable-idle',
    workflow_blob:'3c94569a38f27ba34ac53ff3bb207d9ccd674f35',
    source_sha256:'f72524c1b5ab32a762aec59007bf85dc0ae1ddb9a9e74f38e768dbf712faaa0e',
    definition_sha256:'c26bfb67a0637206f3a26ad72bc9d9e45c039005e53602416df57871735d3647',
  },
});
const EXTERNAL2_MODULES=Object.freeze({
  'scripts/ci/clued-handover-external-driver.mjs':'fee8f18605f47f68ae53a8be8b290c98c901fbda073316a47f4ccc891a143055',
  'scripts/ci/clued-handover-external-provider.mjs':'47b65ad3f05a702d28481e74aaf5751eedf560bf54c49f7a35afc612ba433ae8',
  'scripts/ci/clued-handover-external-source-check.mjs':'5fc6bef118a2f468214597c5296ce03c6de0277da6f4de379b0493467b44daf1',
  'scripts/ci/clued-handover-external-catalog.mjs':'236474e4aacb20791501f5496f4f0322699a2c34f3a0b81d968c9aa72a0b50bc',
  'scripts/ci/clued-handover-external-catalog-identities.mjs':'09c54c0c7081687bbf0f254919385e76aa7781c208732403ce410a2caa585c78',
  'scripts/ci/clued-handover-external-journal.mjs':'2626698dc4ba857732ab5777306deea09357fefdb601990315533d7616f81bb7',
  'scripts/ci/clued-handover-external-bootstrap.mjs':'8af514b6a8a21e62cf4464672aa785d83bb17816edd5b72bcd885de243038d41',
  'scripts/ci/clued-handover-external-register.mjs':'b91f3d81d20a3126024ab89dc92943e5384942e02e5fa2cc041066a7bd096e09',
});
const EXTERNAL2_BOUNDARY=Object.freeze({
  readonly7_inheritance:false,source_only_is_actual_qualification:false,production_qualified:false,
  app_id:5164952,isolated_supabase_project_ref:'qhddedibkuqoiiwlonwe',
  pr_environment:'clued-handover-source-only',pr_app_pg_clued_secrets:false,
  actual_qualifier_environment:'clued-admission',idle_environment:'clued-handover-source-only',
  qualifier_dispatch_ref:'refs/heads/main',idle_dispatch_ref_prefix:'refs/heads/clued-handover-disposable-',
  qualifier_phases:['register','publish','revoke'],idle_dispatch_process_seconds:2400,
  actual_operator_acceptance:'separate_exact_independent_operator_catalog_and_execution_universe',
  actual_host_object_pin_required:true,actual_dispatch_admission_required:true,
  actual_effect_scope:'exact_disposable_repo_pr_head_run_check_and_continuous_isolated_pg_only',
  actual_auth_write:'one_dedicated_synthetic_isolated_auth_users_row_only_after_explicit_acceptance',
  production_auth_or_canonical_access:false,vendor_auth_function_or_role_replacement:false,
});
const EXTERNAL2_READONLY7_FLOOR=Object.freeze({
  'company-linux-01':'f1e02e5ebbfe582daf43e7b22a527914a4ab1218',
  'company-linux-02':'c4aee6b6a1dd789072906dd39ffba2d6a99a3988',
  'company-linux-03':'411f13aab6f5b1688ed4878a9a0802176e6b52de',
  'company-linux-04':'30f95c881e816cdbbe27aec150d30eae616744cc',
  'home-linux-01':'2ac1aba2a9fd236bcdedac39ac9a435248c8b02e',
  'company-win-01':'6e9cf8df20614d82d878ad95c3787659ed3cfb4b',
  'home-win-01':'0a6d9ec09e4d6a7e02aba6c40a96b3502a7b894c',
});
export function external2ExactAcceptanceScope(entry,roles) {
  return {repository:'tdoljyj/cross-memory-system',default_branch:'main',
    operation:'install_exact_external2_workflow_pair',file:entry.file,workflow_role:entry.workflow_role,
    purpose:EXTERNAL2_PURPOSE,workflow_blob:entry.source_profile.workflow_blob,
    source_sha256:entry.source_profile.source_sha256,primary_ids:entry.source_profile.primary_ids,
    roles:roles.map(({job_id,definition_sha256})=>({job_id,definition_sha256})),
    command_digests:entry.source_profile.routes.map(({job_id,command_digests})=>({job_id,command_digests})),
    workflow_definition_sha256:roleDefinitionDigest(entry.workflow_definition),
    frozen_gate_sha256:'d6d96a1eef2f756770304c25b1bf0aab3b8ec72408553ceb141edc0230a995c9',
    source_manifest_sha256:'8f1838f8924942ef8277a8adf909dcd509c89d43cc24204d66c879cb55834fa2',
    source_role_request_sha256:'0721501855ee326027d9ab240334967bb9a43bfd9bd41d5bc1b414c695f8fa4f',
    source_modules:{...EXTERNAL2_MODULES},receiver_boundary:{...EXTERNAL2_BOUNDARY}};
}
export function external2WorkflowSubject(entry,roles) {
  return digest(JSON.stringify(canonical({file:entry.file,workflow_role:entry.workflow_role,purpose:entry.purpose,
    source_profile:entry.source_profile,workflow_definition:entry.workflow_definition,
    exact_source_acceptance_scope:entry.exact_source_acceptance_scope,roles})));
}
export function external2FutureWorkflowCatalogue(registry,specs) {
  const bad=reason=>({passed:false,state:'unknown',reason});
  try {
    if(registry?.schema!=='clued.gated-proof-profiles/2'||specs?.schema!=='clued.gated-proof-role-specs/2')
      return bad('External2 default registry schema missing');
    const entries=Object.hasOwn(registry,'external2_future_workflows')?registry.external2_future_workflows:[],
      independent=Object.hasOwn(specs,'external2_future_workflows')?specs.external2_future_workflows:[];
    if(!Array.isArray(entries)||!Array.isArray(independent)||entries.length!==independent.length)
      return bad('External2 pair catalogue invalid');
    if(!entries.length)return {passed:true,state:'qualified',entries};
    if(entries.length!==2||Object.keys(registry.workflows??{}).length!==20||Object.keys(specs.workflows??{}).length!==20||
      (registry.future_workflows??[]).length!==0||(specs.future_workflows??[]).length!==0)
      return bad('External2 requires the accepted seven already promoted to active twenty');
    for(const [consumer,sourceBlob] of Object.entries(EXTERNAL2_READONLY7_FLOOR)) {
      const file=`.github/workflows/clued-work-handover-qualification-${consumer}.yml`;
      if(registry.workflows[file]?.workflow_blob!==sourceBlob||
        !registeredWorkflowSource(registry,file,sourceBlob).passed||!rolesForSource(specs,file,sourceBlob))
        return bad('External2 readonly seven Source floor is absent or drifted');
    }
    const files=new Set(),blobs=new Set();
    for(const entry of entries) {
      const fixed=EXTERNAL2_FILES[entry?.file],blob=entry?.source_profile?.workflow_blob;
      if(!exactKeys(entry,['file','workflow_role','registration_status','purpose','source_profile','workflow_definition',
        'exact_source_acceptance_scope','source_acceptance'])||!fixed||entry.workflow_role!==fixed.role||
        entry.registration_status!=='accepted_not_installed'||entry.purpose!==EXTERNAL2_PURPOSE||
        blob!==fixed.workflow_blob||files.has(entry.file)||blobs.has(blob)||
        Object.hasOwn(registry.workflows,entry.file)||Object.hasOwn(specs.workflows,entry.file))
        return bad('External2 exact path/purpose/blob missing, duplicate or active');
      const match=independent.filter(role=>role?.file===entry.file&&role.workflow_blob===blob);
      if(match.length!==1||!exactKeys(match[0],['file','workflow_blob','roles']))return bad('External2 independent pair roles missing');
      files.add(entry.file);blobs.add(blob);
    }
    if(files.size!==2||new Set(independent.map(role=>role.file)).size!==2)return bad('External2 pair incomplete');
    return {passed:true,state:'qualified',entries};
  } catch {return bad('External2 pair catalogue invalid');}
}
export function acceptedExternal2WorkflowSource(registry,specs,file,blob,{repository}={}) {
  const bad=reason=>({passed:false,state:'unknown',reason});
  try {
    const catalogue=external2FutureWorkflowCatalogue(registry,specs);if(!catalogue.passed)return catalogue;
    const entry=catalogue.entries.find(entry=>entry.file===file&&entry.source_profile.workflow_blob===blob),fixed=EXTERNAL2_FILES[file];
    if(!entry||!fixed||repository!=='tdoljyj/cross-memory-system')return bad('External2 exact default Source missing or wrong repository');
    const profile=entry.source_profile,roles=specs.external2_future_workflows.find(role=>role.file===file&&role.workflow_blob===blob)?.roles;
    const picked=registeredWorkflowSource({schema:registry.schema,workflows:{[file]:profile}},file,blob);
    if(!picked.passed||profile.gated!==true||Object.hasOwn(profile,'accepted_sources')||
      profile.source_sha256!==fixed.source_sha256||!same(profile.primary_ids,[fixed.primary_id])||
      !Array.isArray(roles)||roles.length!==1||!exactKeys(roles[0],['job_id','definition_sha256','definition'])||
      roles[0].job_id!==fixed.primary_id||roles[0].definition_sha256!==fixed.definition_sha256||
      roleDefinitionDigest(roles[0].definition)!==fixed.definition_sha256||
      !same(roles[0].definition,entry.workflow_definition?.jobs?.[fixed.primary_id]))return bad('External2 full accepted Source/Role differs');
    const compiled=compileRegisteredWorkflow(profile.source_yaml,{primary_ids:profile.primary_ids,
      parseYaml:()=>entry.workflow_definition,accepted_roles:roles});
    if(!same(compiled,profile)||!same(entry.exact_source_acceptance_scope,external2ExactAcceptanceScope(entry,roles)))
      return bad('External2 exact compiled definition/command/purpose/scope differs');
    const acceptance=entry.source_acceptance;
    if(!exactKeys(acceptance,['status','authority','decision_ref','receipt_id','subject_sha256'])||
      acceptance.status!=='accepted'||acceptance.authority!=='owner'||
      !/^clued:decision:[a-f0-9-]{36}@v[1-9][0-9]*$/.test(acceptance.decision_ref??'')||
      !UUID.test(acceptance.decision_ref.slice(15).split('@')[0])||!UUID.test(acceptance.receipt_id??'')||
      acceptance.decision_ref.slice(15).split('@')[0]==='83c6ee59-bb30-465b-a826-871021216bc4'||
      acceptance.receipt_id==='14b7829a-9496-41ff-aa51-2c6fdfc46a9a'||
      acceptance.subject_sha256!==external2WorkflowSubject(entry,roles))return bad('External2 specific Owner Source/Role acceptance missing or revoked');
    return {passed:true,state:'qualified',scope:'accepted_external2_source_role_only',entry,profile,roles,
      actual_effect_qualified:false,operator_accepted:false,production_qualified:false};
  } catch {return bad('External2 Source/Role acceptance invalid');}
}

// Exact candidate byte relation; this is never execution/Owner/Operator authority.
// Pinned definitions are authored with the locked registration parser. Runtime
// recompiles these data only; no PR parser, authority or acceptance is added.
const SOURCE3_EXPECTED = {"schema":"clued.external2-late-idle-source-byte-relation/1","status":"NOT_ACCEPTED","authority":"none","program_manifest_sha256":"454e13794f267ee9b7a6a942724e7a81ff8007a0386632203af0e5efe64c1dd6","source_role_request_sha256":"a0c067ccd64bdb7f859f38e1fc579986c21cc89e41aaf0bc640d3ba2d9d97204","modules":{"scripts/ci/clued-handover-external-driver.mjs":"8f50881bf81c513efa7154b1f824749c1312d5470d8194eb400a6e27d147e9d8","scripts/ci/clued-handover-external-provider.mjs":"47b65ad3f05a702d28481e74aaf5751eedf560bf54c49f7a35afc612ba433ae8","scripts/ci/clued-handover-external-source-check.mjs":"5751e7da5ebb7eb4b18e531ebbc90604036e9ff5b3a65c8dfc28421cb821acaa","scripts/ci/clued-handover-external-catalog.mjs":"236474e4aacb20791501f5496f4f0322699a2c34f3a0b81d968c9aa72a0b50bc","scripts/ci/clued-handover-external-catalog-identities.mjs":"09c54c0c7081687bbf0f254919385e76aa7781c208732403ce410a2caa585c78","scripts/ci/clued-handover-external-journal.mjs":"5b9a479341297a828f76a87b14020dc025afa93eb7322746c8a5337fbd03e3f6","scripts/ci/clued-handover-external-bootstrap.mjs":"8af514b6a8a21e62cf4464672aa785d83bb17816edd5b72bcd885de243038d41","scripts/ci/clued-handover-external-register.mjs":"f2bddb2a554c46f24c9fa2938cfa361526c71a0cb3020ec1dba13baf3d0dedf9","scripts/ci/clued-gated-proof-runtime.mjs":"1476430c7f4c13670f9d2dc9ef1e506424c0f1d2e5ec98d223a24516e4169e3d"},"workflows":{"clued-handover-external-qualification.yml":{"workflow_blob":"b8fee41077d854e906244b9fa2d374f058dbd4a3","source_sha256":"4f59187f16e4d2808a7816ac9f0c72efcbc7b9ebf2524902c8f08ace65063d19","primary_id":"qualify","full_role_sha256":"fab079be15c3b25abe44ff6bcc2af3ff86161db853b0017ae92cb3f5ececb074","workflow_definition_sha256":"96c059d737f392054496b0637ac9dc631117e8991c2861017c090f054a1786c6","registered_sources":[{"workflow_blob":"ac90bc2f7e34a94be3c50c4581ba49cc139b3980","source_sha256":"73de5152cf31f66cf2086994aac8343dc1b81664774966d0bb8c00430fa3f947","primary_id":"qualify","full_role_sha256":"d95fe3e0a197a5bf7b9448733eafaa32a80be20f47b47b9cf734e60cb8f6e24e","workflow_definition_sha256":"e9ff8687000a1c78b2e424d1bd357728231c2010c972239361e7b5956c2746b7","compiled_profile_sha256":"e0e30b2daf7dffdc2561ab400e24093a455d02502ad88b03f90f9fcc520328e8"},{"workflow_blob":"b8fee41077d854e906244b9fa2d374f058dbd4a3","source_sha256":"4f59187f16e4d2808a7816ac9f0c72efcbc7b9ebf2524902c8f08ace65063d19","primary_id":"qualify","full_role_sha256":"fab079be15c3b25abe44ff6bcc2af3ff86161db853b0017ae92cb3f5ececb074","workflow_definition_sha256":"96c059d737f392054496b0637ac9dc631117e8991c2861017c090f054a1786c6","compiled_profile_sha256":"e9d415baf5ff98b075b850dc04e4a09ae25726ad030c983e10245c42147ce9fc"}]},"clued-handover-disposable-idle.yml":{"workflow_blob":"3c94569a38f27ba34ac53ff3bb207d9ccd674f35","source_sha256":"f72524c1b5ab32a762aec59007bf85dc0ae1ddb9a9e74f38e768dbf712faaa0e","primary_id":"disposable-idle","full_role_sha256":"c26bfb67a0637206f3a26ad72bc9d9e45c039005e53602416df57871735d3647","workflow_definition_sha256":"f468f87a67a28b913d070d130b9b9653c3ab3917549bca9b22fb44ed684819fd","registered_sources":[{"workflow_blob":"3c94569a38f27ba34ac53ff3bb207d9ccd674f35","source_sha256":"f72524c1b5ab32a762aec59007bf85dc0ae1ddb9a9e74f38e768dbf712faaa0e","primary_id":"disposable-idle","full_role_sha256":"c26bfb67a0637206f3a26ad72bc9d9e45c039005e53602416df57871735d3647","workflow_definition_sha256":"f468f87a67a28b913d070d130b9b9653c3ab3917549bca9b22fb44ed684819fd","compiled_profile_sha256":"257eb691b337770c81889bf372b18c0118fb08cc4972f911dbd0b342d7a20196"}]}},"idle_unchanged":true,"default_registration_commit":null};
const SOURCE3_WORKFLOW_DEFINITIONS = {".github/workflows/clued-handover-external-qualification.yml":{"ac90bc2f7e34a94be3c50c4581ba49cc139b3980":{"name":"Clued disposable external handover qualification","on":{"pull_request":{"paths":[".github/workflows/clued-handover-external-qualification.yml",".github/workflows/clued-handover-disposable-idle.yml","scripts/ci/clued-handover-external-*","scripts/ci/fixtures/clued-handover-*","config/clued-handover-external-*"]},"workflow_dispatch":{"inputs":{"admission_run_id":{"description":"Existing exact workflow/ref dispatch admission","required":true,"type":"string"},"phase":{"description":"Registered External2 phase","required":true,"type":"choice","options":["register","publish","revoke"]},"publisher_run_id":{"description":"Exact completed successful original publisher, required for revoke","required":false,"type":"string"}}}},"permissions":{"contents":"read"},"concurrency":{"group":"clued-handover-disposable-external-qualification","cancel-in-progress":false},"jobs":{"admission-gate":{"name":"admission-gate","runs-on":["self-hosted","Linux","X64","clued","pool-general","trust-internal"],"timeout-minutes":10,"permissions":{"actions":"read","checks":"read","contents":"read","pull-requests":"read"},"outputs":{"admitted":"${{ steps.gate.outputs.admitted }}","enforced":"${{ steps.gate.outputs.enforced }}","verdict":"${{ steps.gate.outputs.verdict }}"},"steps":[{"uses":"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683","with":{"persist-credentials":false,"ref":"${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}"}},{"uses":"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020","with":{"node-version":"24.19.0"}},{"name":"Configure job temporary storage","uses":"./.github/actions/ci-temporary-storage"},{"id":"gate","env":{"GITHUB_TOKEN":"${{ github.token }}"},"run":"node scripts/ci/clued-work-admission.mjs --mode gate"}]},"qualify":{"name":"clued-handover-external2","needs":"admission-gate","if":"needs.admission-gate.outputs.admitted == 'true' && ((github.event_name == 'pull_request') ||\n (github.event_name == 'workflow_dispatch' &&\n  github.ref == format('refs/heads/{0}', github.event.repository.default_branch)))","runs-on":"ubuntu-24.04","timeout-minutes":25,"environment":"${{ github.event_name == 'workflow_dispatch' && 'clued-admission' || 'clued-handover-source-only' }}","env":{"QUALIFICATION_PHASE":"${{ inputs.phase }}","QUALIFICATION_OPERATOR_MODE":"${{ github.event_name == 'workflow_dispatch' && inputs.phase == 'register' && 'register-empty-disposable' || '' }}","QUALIFICATION_PUBLISHER_RUN_ID":"${{ inputs.publisher_run_id }}","CLUED_HANDOVER_ACCEPTANCE_SHA256":"${{ vars.CLUED_HANDOVER_ACCEPTANCE_SHA256 }}"},"permissions":{"contents":"read","actions":"write","checks":"read","pull-requests":"read"},"steps":[{"uses":"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683","with":{"ref":"${{ github.event.pull_request.head.sha || github.event.repository.default_branch }}","fetch-depth":0,"persist-credentials":false}},{"uses":"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020","with":{"node-version":"24.19.0"}},{"name":"Configure job temporary storage","uses":"./.github/actions/ci-temporary-storage"},{"name":"Verify declared Source path before dependencies","run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelif [ \"$GITHUB_EVENT_NAME\" = workflow_dispatch ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --accepted-check\nelse\n  exit 1\nfi\n"},{"name":"Prepare declared Source runtime","env":{"ONNXRUNTIME_NODE_INSTALL":"skip"},"run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelse\n  npm ci --prefix apps/clued-cloud\nfi\n"},{"name":"Revalidate exact Source after runtime preparation","run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelse\n  node scripts/ci/clued-handover-external-source-check.mjs --accepted-check\nfi\n"},{"name":"Execute declared source-only or actual External2 path","env":{"GITHUB_TOKEN":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && github.token || '' }}","CLUED_ADMISSION_APP_ID":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && secrets.CLUED_ADMISSION_APP_ID || '' }}","CLUED_ADMISSION_APP_PRIVATE_KEY":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && secrets.CLUED_ADMISSION_APP_KEY || '' }}","QUALIFICATION_DISPOSABLE_PG_URL":"${{ github.event_name == 'workflow_dispatch' && secrets.CLUED_HANDOVER_DISPOSABLE_PG_URL || '' }}","QUALIFICATION_TEST_CI_PROOF":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && secrets.CLUED_HANDOVER_TEST_CI_PROOF || '' }}"},"run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelif [ \"$QUALIFICATION_PHASE\" = register ]; then\n  node scripts/ci/clued-handover-external-register.mjs\nelse\n  node scripts/ci/clued-handover-external-driver.mjs --execute\nfi\n"},{"name":"Preserve secret-free actual qualification evidence","if":"${{ always() && github.event_name == 'workflow_dispatch' }}","uses":"actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02","with":{"name":"clued-disposable-handover-${{ github.run_id }}-${{ github.run_attempt }}","path":"${{ runner.temp }}/clued-handover-evidence/*.json","if-no-files-found":"error","retention-days":30}}]}}},"b8fee41077d854e906244b9fa2d374f058dbd4a3":{"name":"Clued disposable external handover qualification","on":{"pull_request":{"paths":[".github/workflows/clued-handover-external-qualification.yml",".github/workflows/clued-handover-disposable-idle.yml","scripts/ci/clued-handover-external-*","scripts/ci/fixtures/clued-handover-*","config/clued-handover-external-*"]},"workflow_dispatch":{"inputs":{"admission_run_id":{"description":"Existing exact workflow/ref dispatch admission","required":true,"type":"string"},"phase":{"description":"Registered External2 phase","required":true,"type":"choice","options":["register","publish","revoke"]},"idle_run_id":{"description":"Exact real idle run; publish only, permanently bound in original journal","required":false,"type":"string"},"publisher_run_id":{"description":"Exact completed successful original publisher, required for revoke","required":false,"type":"string"}}}},"permissions":{"contents":"read"},"concurrency":{"group":"clued-handover-disposable-external-qualification","cancel-in-progress":false},"jobs":{"admission-gate":{"name":"admission-gate","runs-on":["self-hosted","Linux","X64","clued","pool-general","trust-internal"],"timeout-minutes":10,"permissions":{"actions":"read","checks":"read","contents":"read","pull-requests":"read"},"outputs":{"admitted":"${{ steps.gate.outputs.admitted }}","enforced":"${{ steps.gate.outputs.enforced }}","verdict":"${{ steps.gate.outputs.verdict }}"},"steps":[{"uses":"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683","with":{"persist-credentials":false,"ref":"${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}"}},{"uses":"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020","with":{"node-version":"24.19.0"}},{"name":"Configure job temporary storage","uses":"./.github/actions/ci-temporary-storage"},{"id":"gate","env":{"GITHUB_TOKEN":"${{ github.token }}"},"run":"node scripts/ci/clued-work-admission.mjs --mode gate"}]},"qualify":{"name":"clued-handover-external2","needs":"admission-gate","if":"needs.admission-gate.outputs.admitted == 'true' && ((github.event_name == 'pull_request') ||\n (github.event_name == 'workflow_dispatch' &&\n  github.ref == format('refs/heads/{0}', github.event.repository.default_branch)))","runs-on":"ubuntu-24.04","timeout-minutes":25,"environment":"${{ github.event_name == 'workflow_dispatch' && 'clued-admission' || 'clued-handover-source-only' }}","env":{"QUALIFICATION_PHASE":"${{ inputs.phase }}","QUALIFICATION_IDLE_RUN_ID":"${{ inputs.idle_run_id }}","QUALIFICATION_OPERATOR_MODE":"${{ github.event_name == 'workflow_dispatch' && inputs.phase == 'register' && 'register-empty-disposable' || '' }}","QUALIFICATION_PUBLISHER_RUN_ID":"${{ inputs.publisher_run_id }}","CLUED_HANDOVER_ACCEPTANCE_SHA256":"${{ vars.CLUED_HANDOVER_ACCEPTANCE_SHA256 }}"},"permissions":{"contents":"read","actions":"write","checks":"read","pull-requests":"read"},"steps":[{"uses":"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683","with":{"ref":"${{ github.event.pull_request.head.sha || github.event.repository.default_branch }}","fetch-depth":0,"persist-credentials":false}},{"uses":"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020","with":{"node-version":"24.19.0"}},{"name":"Configure job temporary storage","uses":"./.github/actions/ci-temporary-storage"},{"name":"Verify declared Source path before dependencies","run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelif [ \"$GITHUB_EVENT_NAME\" = workflow_dispatch ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --accepted-check\nelse\n  exit 1\nfi\n"},{"name":"Prepare declared Source runtime","env":{"ONNXRUNTIME_NODE_INSTALL":"skip"},"run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelse\n  npm ci --prefix apps/clued-cloud\nfi\n"},{"name":"Revalidate exact Source after runtime preparation","run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelse\n  node scripts/ci/clued-handover-external-source-check.mjs --accepted-check\nfi\n"},{"name":"Execute declared source-only or actual External2 path","env":{"GITHUB_TOKEN":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && github.token || '' }}","CLUED_ADMISSION_APP_ID":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && secrets.CLUED_ADMISSION_APP_ID || '' }}","CLUED_ADMISSION_APP_PRIVATE_KEY":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && secrets.CLUED_ADMISSION_APP_KEY || '' }}","QUALIFICATION_DISPOSABLE_PG_URL":"${{ github.event_name == 'workflow_dispatch' && secrets.CLUED_HANDOVER_DISPOSABLE_PG_URL || '' }}","QUALIFICATION_TEST_CI_PROOF":"${{ github.event_name == 'workflow_dispatch' && inputs.phase != 'register' && secrets.CLUED_HANDOVER_TEST_CI_PROOF || '' }}"},"run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelif [ \"$QUALIFICATION_PHASE\" = register ]; then\n  node scripts/ci/clued-handover-external-register.mjs\nelse\n  node scripts/ci/clued-handover-external-driver.mjs --execute\nfi\n"},{"name":"Preserve secret-free actual qualification evidence","if":"${{ always() && github.event_name == 'workflow_dispatch' }}","uses":"actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02","with":{"name":"clued-disposable-handover-${{ github.run_id }}-${{ github.run_attempt }}","path":"${{ runner.temp }}/clued-handover-evidence/*.json","if-no-files-found":"error","retention-days":30}}]}}}},".github/workflows/clued-handover-disposable-idle.yml":{"3c94569a38f27ba34ac53ff3bb207d9ccd674f35":{"name":"Clued disposable cancellation fixture","on":{"pull_request":{"paths":[".github/workflows/clued-handover-disposable-idle.yml","scripts/ci/clued-handover-external-*"]},"workflow_dispatch":{"inputs":{"admission_run_id":{"description":"Existing exact workflow/ref dispatch admission","required":true,"type":"string"}}}},"permissions":{"contents":"read"},"concurrency":{"group":"clued-handover-idle-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}","cancel-in-progress":"${{ github.event_name == 'pull_request' }}"},"jobs":{"admission-gate":{"name":"admission-gate","runs-on":["self-hosted","Linux","X64","clued","pool-general","trust-internal"],"timeout-minutes":10,"permissions":{"actions":"read","checks":"read","contents":"read","pull-requests":"read"},"outputs":{"admitted":"${{ steps.gate.outputs.admitted }}","enforced":"${{ steps.gate.outputs.enforced }}","verdict":"${{ steps.gate.outputs.verdict }}"},"steps":[{"uses":"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683","with":{"persist-credentials":false,"ref":"${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}"}},{"uses":"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020","with":{"node-version":"24.19.0"}},{"name":"Configure job temporary storage","uses":"./.github/actions/ci-temporary-storage"},{"id":"gate","env":{"GITHUB_TOKEN":"${{ github.token }}"},"run":"node scripts/ci/clued-work-admission.mjs --mode gate"}]},"disposable-idle":{"name":"disposable-idle","needs":"admission-gate","if":"needs.admission-gate.outputs.admitted == 'true' && ((github.event_name == 'pull_request') ||\n (github.event_name == 'workflow_dispatch' &&\n  startsWith(github.ref, 'refs/heads/clued-handover-disposable-')))","runs-on":"ubuntu-24.04","timeout-minutes":45,"environment":"clued-handover-source-only","permissions":{"contents":"read"},"steps":[{"uses":"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683","with":{"ref":"${{ github.event.pull_request.head.sha || github.ref }}","persist-credentials":false}},{"uses":"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020","with":{"node-version":"24.19.0"}},{"name":"Configure job temporary storage","uses":"./.github/actions/ci-temporary-storage"},{"name":"Bounded idle process to prove real provider cancellation","run":"if [ \"$GITHUB_EVENT_NAME\" = pull_request ]; then\n  node scripts/ci/clued-handover-external-source-check.mjs --candidate-check\nelse\n  sleep 2400\nfi\n"}]}}}}};
export function verifyExternal2LateIdleSourceByteRelation({sourceBytes,programManifestBytes,requestBytes,registry,roleSpecs}) {
  const fail=reason=>({passed:false,state:'unknown',reason,authority:'none',actual_qualification:false});
  try {
    if(!(sourceBytes instanceof Map)||!Buffer.isBuffer(programManifestBytes)||!Buffer.isBuffer(requestBytes))return fail('Source3 raw byte inputs unavailable');
    if(digest(programManifestBytes)!==SOURCE3_EXPECTED.program_manifest_sha256||digest(requestBytes)!==SOURCE3_EXPECTED.source_role_request_sha256)return fail('Source3 complete program/request bytes differ');
    const expectedPaths=[...Object.keys(SOURCE3_EXPECTED.modules),...Object.keys(SOURCE3_EXPECTED.workflows).map(name=>'.github/workflows/'+name)].sort();
    if(!same([...sourceBytes.keys()].sort(),expectedPaths))return fail('Source3 exact byte input set differs');
    for(const [file,hash] of Object.entries(SOURCE3_EXPECTED.modules))if(!Buffer.isBuffer(sourceBytes.get(file))||digest(sourceBytes.get(file))!==hash)return fail('Source3 module bytes differ');
    for(const [name,expected] of Object.entries(SOURCE3_EXPECTED.workflows)){
      const file='.github/workflows/'+name,raw=sourceBytes.get(file),root=registry?.workflows?.[file];
      if(!Buffer.isBuffer(raw)||digest(raw)!==expected.source_sha256||workflowBlob(raw.toString('utf8'))!==expected.workflow_blob)return fail('Source3 workflow raw bytes differ');
      const choices=expected.registered_sources;
      if(!Array.isArray(choices)||!choices.length||root?.workflow_blob!==choices[0].workflow_blob||
        (choices.length>1?!Array.isArray(root?.accepted_sources):Object.hasOwn(root??{},'accepted_sources'))||
        !same([root,...(root.accepted_sources??[])].map(profile=>profile?.workflow_blob).sort(),choices.map(choice=>choice.workflow_blob).sort()))
        return fail('Source3 exact registered Source choices differ');
      for(const choice of choices){
        const picked=registeredWorkflowSource(registry,file,choice.workflow_blob),roles=rolesForSource(roleSpecs,file,choice.workflow_blob);
        const definition=SOURCE3_WORKFLOW_DEFINITIONS[file]?.[choice.workflow_blob];
        if(!picked.passed||!Array.isArray(roles)||roles.length!==1||
          !exactKeys(roles[0],['job_id','definition_sha256','definition'])||roles[0].job_id!==choice.primary_id||
          roles[0].definition_sha256!==choice.full_role_sha256||!definition||
          roleDefinitionDigest(definition)!==choice.workflow_definition_sha256||
          roleDefinitionDigest(roles[0].definition)!==choice.full_role_sha256||
          !same(roles[0].definition,definition.jobs?.[choice.primary_id]))return fail('Source3 complete definition/FullRole differs');
        // accepted_sources is the installed root's source-choice wrapper, not a
        // compiler output field. Only that exact root may carry this wrapper.
        const {accepted_sources,...profile}=picked.profile;
        if(picked.profile!==root&&accepted_sources!==undefined)return fail('Source3 nested Source choice wrapper differs');
        if(!exactKeys(profile,['registration_status','workflow_blob','source_sha256','source_yaml','primary_ids','pull_request','gated','routes'])||
          roleDefinitionDigest(profile)!==choice.compiled_profile_sha256||profile.source_sha256!==choice.source_sha256)
          return fail('Source3 complete compiled profile differs');
        const compiled=compileRegisteredWorkflow(profile.source_yaml,{primary_ids:[choice.primary_id],
          parseYaml:()=>definition,accepted_roles:roles});
        if(!same(compiled,profile))return fail('Source3 complete compiled definition/profile relation differs');
        if(choice.workflow_blob===expected.workflow_blob&&
          (choice.workflow_definition_sha256!==expected.workflow_definition_sha256||
          choice.full_role_sha256!==expected.full_role_sha256||profile.source_yaml!==raw.toString('utf8')))
          return fail('Source3 exact compiled source differs');
      }
    }
    return {passed:true,state:'candidate_byte_relation',authority:'none',actual_qualification:false,owner_accepted:false,operator_accepted:false,default_registered:false};
  }catch{return fail('Source3 byte relation unavailable or invalid');}
}

// Pending Source metadata is not an accepted Source or a Host qualification.
// Keep it outside active/accepted workflow maps until an actual registrar successor.
const NATIVE617_FILES=Object.freeze({
  '.github/workflows/clued-native617-admission-dispatch.yml':{job:'admit',route:'handover-native-control-once',jobs:['admission-gate','admit']},
  '.github/workflows/clued-handover-external-qualification.yml':{job:'qualify',route:'handover-native-task617-once',jobs:['admission-gate','qualify']},
  '.github/workflows/clued-handover-disposable-idle.yml':{job:'disposable-idle',route:'handover-native-task617-once',jobs:['admission-gate','disposable-idle']}
});
export function native617PendingWorkflowCatalogue(registry,specs){
  const bad=reason=>({passed:false,structurally_valid:false,state:'unknown',reason,
    authoritative:false,host_qualified:false,execution_permitted:false});
  try{
    if(registry?.schema!=='clued.gated-proof-profiles/2'||specs?.schema!=='clued.gated-proof-role-specs/2')
      return bad('native617 pending schema');
    const entries=registry.native617_pending_sources,roleEntries=specs.native617_pending_sources;
    if(!Array.isArray(entries)||entries.length!==3||!Array.isArray(roleEntries)||roleEntries.length!==3)
      return bad('native617 pending bounds');
    const seen=new Set();
    for(const entry of entries){
      const fixed=NATIVE617_FILES[entry?.file];
      if(!fixed||seen.has(entry.file)||!exactKeys(entry,['file','purpose','registration_status','source_yaml',
        'workflow_blob','source_sha256','workflow_definition','source_acceptance','host_qualification'])||
        entry.purpose!=='native617_free_entry_source_preparation'||
        entry.registration_status!=='PENDING_INDEPENDENT_SOURCE_REVIEW_HOST_NOT_QUALIFIED'||
        entry.source_acceptance!==null||entry.host_qualification!==null||
        typeof entry.source_yaml!=='string'||Buffer.byteLength(entry.source_yaml)>524288||
        workflowBlob(entry.source_yaml)!==entry.workflow_blob||digest(entry.source_yaml)!==entry.source_sha256)
        return bad('native617 pending source');
      seen.add(entry.file);
      const rows=roleEntries.filter(row=>row?.file===entry.file&&row.workflow_blob===entry.workflow_blob);
      if(rows.length!==1||!exactKeys(rows[0],['file','workflow_blob','roles'])||
        !Array.isArray(rows[0].roles)||rows[0].roles.length!==1)return bad('native617 pending roles');
      const role=rows[0].roles[0],definition=entry.workflow_definition;
      if(!exactKeys(role,['job_id','definition_sha256','definition'])||role.job_id!==fixed.job||
        !definition?.jobs||!same(Object.keys(definition.jobs).sort(),[...fixed.jobs].sort())||
        !same(role.definition,definition.jobs[fixed.job])||roleDefinitionDigest(role.definition)!==role.definition_sha256)
        return bad('native617 pending role definition');
      const job=role.definition,labels=['self-hosted','Linux','X64','clued','trust-internal',fixed.route];
      if(!same(job['runs-on'],labels)||job.uses||job.strategy||!Array.isArray(job.steps)||
        job.steps.filter(step=>step?.name==='Refuse until independent Native E1 qualification'&&
          step.run==='node scripts/ci/clued-handover-native-entry.mjs --check'&&step.env===undefined).length!==1)
        return bad('native617 pending route/guard');
      // These candidate bytes must not become another accepted source by being
      // copied into the active registry. Historical entries remain untouched.
      const active=registry.workflows?.[entry.file];
      if(active?.workflow_blob===entry.workflow_blob||
        (active?.accepted_sources??[]).some(source=>source.workflow_blob===entry.workflow_blob)||
        Object.hasOwn(specs.workflows?.[entry.file]?.sources??{},entry.workflow_blob))
        return bad('native617 candidate registered itself');
    }
    return {passed:false,structurally_valid:true,state:'pending_independent_source_and_host_review',
      authoritative:false,host_qualified:false,execution_permitted:false,entries:structuredClone(entries)};
  }catch{return bad('native617 pending invalid');}
}
