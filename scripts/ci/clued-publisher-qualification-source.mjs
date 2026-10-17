// Exact, non-production PR qualification Sources. They are never required
// application-CI success proofs, dispatch admission or production authority.
import {createHash} from 'node:crypto';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
import {PUBLISHER_LABELS,PUBLISHER_PROBE_LABELS} from './clued-production-publisher-source.mjs';
export const COMPONENT_VERSION='1.0.0';
export const PUBLISHER_PR_QUALIFICATION_PATH='scripts/ci/clued-publisher-qualification-sources.json';
export const PUBLISHER_PR_QUALIFICATION_SCHEMA='clued.publisher-pr-qualification-sources/1';
export const PUBLISHER_PR_QUALIFICATION_PURPOSE='production_publisher_nonproduction_PR_qualification';
export const PUBLISHER_PR_QUALIFICATION_FILES=Object.freeze({
  '.github/workflows/clued-production-publisher-host-qualification.yml':{primary:'host-principal-probe',labels:PUBLISHER_PROBE_LABELS,minutes:5},
  '.github/workflows/clued-production-publisher-guest-qualification.yml':{primary:'qualify',labels:PUBLISHER_LABELS,minutes:12},
});
export const PUBLISHER_PR_QUALIFICATION_CONDITION="needs.admission-gate.outputs.admitted == 'true' && (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository && github.actor == github.repository_owner && github.triggering_actor == github.repository_owner)";
const GATE_ROLE='a38d818cac3e095f0747700e9d206a65a395c3af97728f3230743748b548a1bd';
const QUALIFICATION_PATHS=new Set([
  ...Object.keys(PUBLISHER_PR_QUALIFICATION_FILES),
  'scripts/ci/self-hosted/qualify-publisher-host-principal.ps1',
  'scripts/ci/self-hosted/production-publisher-qualification-case.json',
  'scripts/ci/self-hosted/production-publisher-profile.json',
  'scripts/runner/clued-production-vm.ps1','scripts/runner/clued-production-guest-init.sh',
]);
const hash=text=>createHash('sha256').update(text).digest('hex');
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const keys=(x,list)=>plain(x)&&same(Object.keys(x).sort(),[...list].sort());
const condition=x=>String(x??'').replace(/^\$\{\{\s*|\s*\}\}$/g,'').replace(/\s+/g,' ').trim();
const unknown=reason=>({passed:false,state:'unknown',reason});
const bad=reason=>{throw Error('unregistered publisher PR qualification Source: '+reason);};

// Registration uses the locked parser and independently reviewed complete roles.
// Runtime recompiles trusted default data without evaluating a PR's parser/code.
export function compilePublisherPrQualificationSource(file,text,{parseYaml,accepted_roles,operation='install_workflow'}={}) {
  const d=Object.hasOwn(PUBLISHER_PR_QUALIFICATION_FILES,file)?PUBLISHER_PR_QUALIFICATION_FILES[file]:null;
  if(!d||typeof text!=='string'||!text||Buffer.byteLength(text)>65536||
    Buffer.from(text,'utf8').toString('utf8')!==text||typeof parseYaml!=='function'||
    /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text)||
    !['install_workflow','modify_workflow'].includes(operation))bad('identity/parser/operation');
  const value=parseYaml(text),trigger=value?.on?.pull_request;
  if(!plain(value)||!keys(value.on,['pull_request'])||!keys(trigger,['branches','paths'])||
    !same(trigger.branches,['main'])||!Array.isArray(trigger.paths)||!trigger.paths.includes(file)||
    new Set(trigger.paths).size!==trigger.paths.length||trigger.paths.some(p=>!QUALIFICATION_PATHS.has(p))||
    !keys(value.jobs,['admission-gate',d.primary])||
    !keys(value.permissions,['contents'])||value.permissions.contents!=='read')bad('exact PR qualification form');
  if(Object.values(value.jobs).some(j=>!plain(j)||j.environment!==undefined)||/\bsecrets\s*(?:\.|\[)/i.test(text))
    bad('qualification has no environment or Secrets');
  const ids=['admission-gate',d.primary].sort();
  if(!Array.isArray(accepted_roles)||accepted_roles.length!==2||new Set(accepted_roles.map(r=>r?.job_id)).size!==2||
    accepted_roles.some(r=>!keys(r,['job_id','definition_sha256'])||!ids.includes(r.job_id)||
      !/^[a-f0-9]{64}$/.test(r.definition_sha256??'')||r.definition_sha256!==roleDefinitionDigest(value.jobs[r.job_id]))||
    roleDefinitionDigest(value.jobs['admission-gate'])!==GATE_ROLE)bad('complete independent roles/canonical gate');
  const job=value.jobs[d.primary];
  if(!same(job['runs-on'],d.labels)||job.needs!=='admission-gate'||
    condition(job.if)!==PUBLISHER_PR_QUALIFICATION_CONDITION||job.uses!==undefined||job.strategy!==undefined||
    !Number.isInteger(job['timeout-minutes'])||job['timeout-minutes']<1||job['timeout-minutes']>d.minutes||
    !Array.isArray(job.steps)||!job.steps.length||job.permissions!==undefined&&
      (!keys(job.permissions,['contents'])||job.permissions.contents!=='read'))bad('one primary/route/PR condition');
  const commands={},checkouts=[];
  for(const step of job.steps) {
    if(!plain(step)||(step.run===undefined)===(step.uses===undefined))bad('concrete step');
    if(step.uses!==undefined) {
      if(!/^actions\/checkout@(?:v4|[a-f0-9]{40})$/.test(step.uses)||!plain(step.with)||
        Object.keys(step.with).some(k=>!['ref','persist-credentials','fetch-depth'].includes(k))||
        step.with.ref!=="${{ github.event.pull_request.head.sha }}"||step.with['persist-credentials']!==false||
        step.with['fetch-depth']!==undefined&&step.with['fetch-depth']!==1)bad('exact PR checkout');
      checkouts.push(step);continue;
    }
    const name=step.name??('Run '+String(step.run).split('\n')[0]);
    if(typeof step.run!=='string'||!step.run.trim()||typeof name!=='string'||!name||name.includes('${{'))bad('primary command');
    (commands[name]??=[]).push(hash(step.run.replace(/\r\n/g,'\n').trimEnd()));
  }
  if(checkouts.length!==1||!Object.keys(commands).length)bad('checkout and executed qualification command required');
  return {registration_status:'registered',purpose:PUBLISHER_PR_QUALIFICATION_PURPOSE,
    proof_classification:'qualification_only',operation,workflow_blob:workflowBlob(text),source_sha256:hash(text),
    source_yaml:text,workflow_definition:value,primary_ids:[d.primary],gated:true,
    role_digests:Object.fromEntries(ids.map(id=>[id,accepted_roles.find(r=>r.job_id===id).definition_sha256])),
    command_digests:{[d.primary]:commands}};
}

export function registeredPublisherPrQualificationSource(registry,file,text,{repository='tdoljyj/cross-memory-system'}={}) {
  try {
    if(!keys(registry,['schema','repository','default_branch','workflows','roles'])||
      registry.schema!==PUBLISHER_PR_QUALIFICATION_SCHEMA||registry.repository!==repository||registry.default_branch!=='main'||
      !plain(registry.workflows)||!plain(registry.roles)||
      Object.keys(registry.workflows).some(p=>!Object.hasOwn(PUBLISHER_PR_QUALIFICATION_FILES,p))||
      !same(Object.keys(registry.workflows).sort(),Object.keys(registry.roles).sort()))return unknown('qualification catalogue identity');
    const root=registry.workflows[file],roles=registry.roles[file];
    if(!Object.hasOwn(PUBLISHER_PR_QUALIFICATION_FILES,file)||!keys(root,['registration_status','sources'])||
      root.registration_status!=='registered'||!Array.isArray(root.sources)||root.sources.length<1||root.sources.length>3||
      !plain(roles)||typeof text!=='string'||root.sources.some(s=>!plain(s)||!/^[a-f0-9]{40}$/.test(s.workflow_blob??''))||
      new Set(root.sources.map(s=>s.workflow_blob)).size!==root.sources.length||
      !same(Object.keys(roles).sort(),root.sources.map(s=>s.workflow_blob).sort()))return unknown('qualification catalogue bounds');
    const matches=root.sources.filter(s=>s.workflow_blob===workflowBlob(text));
    if(matches.length!==1||matches[0].source_yaml!==text||matches[0].source_sha256!==hash(text))return unknown('exact qualification Git bytes absent');
    const entry=matches[0],compiled=compilePublisherPrQualificationSource(file,text,{
      parseYaml:()=>entry.workflow_definition,accepted_roles:roles[entry.workflow_blob],operation:entry.operation});
    if(!same(compiled,entry))return unknown('qualification compiled Source/Role differs');
    return {passed:true,state:'qualified',scope:'registered_nonproduction_PR_qualification_source_only',profile:entry};
  }catch{return unknown('qualification Source integrity');}
}

export function registeredPublisherPrQualificationTransition(registry,file,text,before,options={}) {
  if(text===before)return unknown('not a qualification transition');
  const head=registeredPublisherPrQualificationSource(registry,file,text,options);
  if(!head.passed||head.profile.operation!==(before===null?'install_workflow':'modify_workflow'))return unknown('qualification operation absent');
  if(before!==null&&!registeredPublisherPrQualificationSource(registry,file,before,options).passed)return unknown('qualification predecessor absent');
  return head;
}
