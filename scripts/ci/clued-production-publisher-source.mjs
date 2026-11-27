// Dispatch publication sources have their own bounded catalogue. They are not
// pull-request test proofs, VM qualification, production grants or credentials.
import {createHash} from 'node:crypto';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
export const COMPONENT_VERSION = "1.0.0";
export const PUBLISHER_SOURCE_PATH='scripts/ci/clued-production-publisher-sources.json';
export const PUBLISHER_SOURCE_SCHEMA='clued.production-publisher-sources/1';
export const PUBLISHER_FILES=Object.freeze({
  '.github/workflows/clued-cloud-production-release.yml':{purpose:'production_publisher',primary_ids:['release']},
  '.github/workflows/clued-production-publisher-qualification.yml':{purpose:'production_publisher_qualification',primary_ids:['host-principal-probe','qualify']},
});
export const PUBLISHER_RUN_LABEL="${{ format('clued-publisher-{0}-{1}', github.run_id, github.run_attempt) }}";
export const PUBLISHER_LABELS=Object.freeze(['self-hosted','Linux','X64','clued-production-publisher-v1',PUBLISHER_RUN_LABEL]);
export const PUBLISHER_OWNER_CONDITION="github.ref == 'refs/heads/main' && github.actor == github.repository_owner && github.triggering_actor == github.repository_owner";
export const PUBLISHER_JOB_CONDITION=`needs.admission-gate.outputs.admitted == 'true' && (${PUBLISHER_OWNER_CONDITION})`;
export const PUBLISHER_PROBE_LABELS=Object.freeze(['self-hosted','Windows','X64','clued','pool-general','trust-internal','cap-python312','cap-node24','site-company']);
export const PUBLISHER_PROBE_CONDITION=`needs.admission-gate.outputs.admitted == 'true' && (${PUBLISHER_OWNER_CONDITION} && inputs.mode == 'host-principal-probe')`;
export const PUBLISHER_QUALIFY_CONDITION=`needs.admission-gate.outputs.admitted == 'true' && (${PUBLISHER_OWNER_CONDITION} && (inputs.mode == 'success' || inputs.mode == 'failure' || inputs.mode == 'cancel'))`;
const FLEET_REPLAY_KIND='fleet_replay_successor';
const FLEET_REPLAY_LABELS=['self-hosted','Windows','X64','clued','pool-general','trust-internal','cap-node24','cap-python312'];
const FLEET_CONFIRM="inputs.mode == 'fleet-accept' && inputs.fleet_operation == 'confirm'";
const FLEET_REPLAY_CONDITION=`${PUBLISHER_OWNER_CONDITION} && ${FLEET_CONFIRM}`;
const FLEET_RELEASE_CONDITION=`!cancelled() && ${PUBLISHER_OWNER_CONDITION} && (inputs.mode != 'fleet-accept' || inputs.fleet_operation != 'confirm' || (needs.fleet-interface-check.result == 'success' && needs.fleet-interface-check.outputs.evidence != ''))`;
const FLEET_RELEASE_TIMEOUT="${{ (inputs.mode == 'deploy' || inputs.mode == 'release') && 165 || inputs.mode == 'fleet-accept' && 10 || 45 }}";
const hash=text=>createHash('sha256').update(text).digest('hex');
const sha=/^[a-f0-9]{40}$/,digest=/^[a-f0-9]{64}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const keys=(x,list)=>plain(x)&&same(Object.keys(x).sort(),[...list].sort());
const condition=x=>String(x??'').replace(/^\$\{\{\s*|\s*\}\}$/g,'').replace(/\s+/g,' ').trim();
const bad=reason=>{throw Error('unregistered publisher Source: '+reason);};
const unknown=reason=>({passed:false,state:'unknown',reason});

// Registration only: parseYaml is the locked YAML parser. accepted_roles are
// separately reviewed full job-definition digests, never inferred by runtime.
export function compilePublisherSource(file,text,{parseYaml,accepted_roles,source_kind='gated_successor',operation}={}) {
  const descriptor=Object.hasOwn(PUBLISHER_FILES,file)?PUBLISHER_FILES[file]:null;
  if(!descriptor||typeof text!=='string'||!text.length||Buffer.byteLength(text)>131072||
    Buffer.from(text,'utf8').toString('utf8')!==text||typeof parseYaml!=='function'||
    /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text))bad('file/source/parser');
  const legacy=source_kind==='legacy_predecessor',fleet=source_kind===FLEET_REPLAY_KIND;
  const primary_ids=fleet?['fleet-interface-check',...descriptor.primary_ids]:descriptor.primary_ids;
  operation??=legacy?'predecessor':descriptor.purpose==='production_publisher'?'modify_workflow':'install_workflow';
  if(legacy?operation!=='predecessor':!['modify_workflow','install_workflow'].includes(operation)||
    descriptor.purpose==='production_publisher'&&operation!=='modify_workflow')bad('exact Source operation');
  if((legacy||fleet)?descriptor.purpose!=='production_publisher':source_kind!=='gated_successor')bad('source kind');
  const value=parseYaml(text),production=descriptor.purpose==='production_publisher';
  if(!plain(value)||!keys(value.on,['workflow_dispatch'])||!plain(value.jobs)||
    !same(Object.keys(value.jobs).sort(),[...primary_ids,...legacy||fleet?[]:['admission-gate']].sort()))bad('dispatch-only concrete jobs');
  const inputs=value.on.workflow_dispatch?.inputs;
  if(!legacy&&!fleet&&(!plain(inputs)||inputs.admission_run_id?.type!=='string'||inputs.admission_run_id?.required!==true))bad('exact dispatch admission input');
  if(!production&&(!same(inputs.mode?.options,['host-principal-probe','success','failure','cancel'])||
    inputs.mode?.type!=='choice'||inputs.mode?.required!==true))bad('qualification modes');
  const job_ids=Object.keys(value.jobs).sort();
  if(!Array.isArray(accepted_roles)||accepted_roles.length!==job_ids.length||
    new Set(accepted_roles.map(r=>r?.job_id)).size!==job_ids.length||
    accepted_roles.some(r=>!keys(r,['job_id','definition_sha256'])||!job_ids.includes(r.job_id)||
      !digest.test(r.definition_sha256)||r.definition_sha256!==roleDefinitionDigest(value.jobs[r.job_id])))bad('independent primary roles');
  if(!same(value.permissions,fleet?{contents:'read',checks:'read','pull-requests':'read'}:{contents:'read'}))bad('workflow permissions');
  if(!production&&(Object.values(value.jobs).some(j=>j.environment!==undefined)||/\bsecrets\s*(?:\.|\[)/i.test(text)))
    bad('qualification must have no environment or Secrets');
  const commands={};
  for(const id of primary_ids) {
    const job=value.jobs[id],probe=id==='host-principal-probe',replay=id==='fleet-interface-check';
    if(!plain(job)||job.uses!==undefined||job.strategy!==undefined||!Array.isArray(job.steps)||!job.steps.length||
      job.permissions!==undefined&&(!keys(job.permissions,['contents'])||job.permissions.contents!=='read'))bad('primary job');
    if(fleet) {
      if(replay ? !same(job['runs-on'],FLEET_REPLAY_LABELS)||job['timeout-minutes']!==22|| job.environment!==undefined||
        job.needs!==undefined||condition(job.if)!==FLEET_REPLAY_CONDITION||
        !same(job.outputs,{evidence:'${{ steps.replay.outputs.evidence }}'})||/\bsecrets\s*(?:\.|\[)/i.test(JSON.stringify(job))
        : job['runs-on']!=='ubuntu-24.04'||job['timeout-minutes']!==FLEET_RELEASE_TIMEOUT||
          job.needs!=='fleet-interface-check'||condition(job.if)!==FLEET_RELEASE_CONDITION)bad('exact fleet replay and release jobs');
    } else if(!Number.isInteger(job['timeout-minutes'])||job['timeout-minutes']<1||
      job['timeout-minutes']>(production?45:probe?5:12))bad('primary job timeout');
    if(!legacy&&!fleet&&(!same(job['runs-on'],probe?PUBLISHER_PROBE_LABELS:PUBLISHER_LABELS)||job.needs!=='admission-gate'||
      condition(job.if)!==(production?PUBLISHER_JOB_CONDITION:probe?PUBLISHER_PROBE_CONDITION:PUBLISHER_QUALIFY_CONDITION)))
      bad('exact one-shot route/gate/main/Owner/mode condition');
    if(production&&!replay&&job.environment!=='clued-release')bad('production environment');
    const digests={};
    for(const step of job.steps) {
      if(!plain(step)||step.uses!==undefined&&step.run!==undefined)bad('step form');
      if(step.run===undefined)continue;
      if(typeof step.run!=='string'||!step.run.trim())bad('empty command');
      const name=step.name??('Run '+step.run.split('\n')[0]);
      if(typeof name!=='string'||!name||name.includes('${{'))bad('command name');
      (digests[name]??=[]).push(hash(step.run.replace(/\r\n/g,'\n').trimEnd()));
    }
    if(!Object.keys(digests).length)bad('no actual primary command');
    commands[id]=digests;
  }
  // Source hashes are raw UTF-8 Git bytes, including CRLF when present. No
  // normalized-content equivalence can authorize a different Git object.
  return {registration_status:'registered',purpose:descriptor.purpose,operation,source_kind,
    workflow_blob:workflowBlob(text),source_sha256:hash(text),source_yaml:text,workflow_definition:value,
    primary_ids:[...primary_ids],role_digests:Object.fromEntries(job_ids.map(id=>[id,accepted_roles.find(r=>r.job_id===id).definition_sha256])),
    command_digests:commands,gated:!legacy&&!fleet};
}

export function registeredPublisherSource(registry,file,text,{repository='tdoljyj/cross-memory-system'}={}) {
  try {
    if(!keys(registry,['schema','repository','default_branch','workflows','roles'])||
      registry.schema!==PUBLISHER_SOURCE_SCHEMA||registry.repository!==repository||registry.default_branch!=='main'||
      !plain(registry.workflows)||!plain(registry.roles)||
      Object.keys(registry.workflows).some(p=>!Object.hasOwn(PUBLISHER_FILES,p))||
      !same(Object.keys(registry.roles).sort(),Object.keys(registry.workflows).sort()))return unknown('publisher catalogue identity');
    const root=registry.workflows[file],roles=registry.roles[file];
    if(!PUBLISHER_FILES[file]||!keys(root,['registration_status','sources'])||root.registration_status!=='registered'||
      !Array.isArray(root.sources)||root.sources.length<1||root.sources.length>3||!plain(roles)||typeof text!=='string')
      return unknown('publisher catalogue bounds');
    if(root.sources.some(s=>!plain(s)||!sha.test(s.workflow_blob??'')||!digest.test(s.source_sha256??''))||
      new Set(root.sources.map(s=>s.workflow_blob)).size!==root.sources.length||
      !same(Object.keys(roles).sort(),root.sources.map(s=>s.workflow_blob).sort()))return unknown('publisher source/role set');
    const blob=workflowBlob(text),matches=root.sources.filter(s=>s.workflow_blob===blob);
    if(matches.length!==1)return unknown('exact publisher source absent');
    const entry=matches[0];
    if(entry.source_yaml!==text||entry.source_sha256!==hash(text))return unknown('publisher Git bytes differ');
    const compiled=compilePublisherSource(file,text,{parseYaml:()=>entry.workflow_definition,
      accepted_roles:roles[blob],source_kind:entry.source_kind,operation:entry.operation});
    if(!same(compiled,entry))return unknown('publisher compiled Source/Role differs');
    return {passed:true,state:'qualified',scope:'registered_dispatch_source_only',profile:entry};
  } catch {return unknown('publisher source integrity');}
}

// This permission is only to retain a previously registered dispatch source in
// the complete PR directory walk, without counting it as a pull-request test.
export function registeredPublisherTransition(registry,file,headText,baseText,options={}) {
  if(!PUBLISHER_FILES[file]||headText===baseText)return unknown('not a publisher transition');
  const head=registeredPublisherSource(registry,file,headText,options);
  if(!head.passed||head.profile.source_kind!=='gated_successor')return unknown('publisher successor absent');
  if(baseText===null) {
    if(file!=='.github/workflows/clued-production-publisher-qualification.yml'||head.profile.operation!=='install_workflow')return unknown('exact qualification installation required');
  } else {
    if(head.profile.operation!=='modify_workflow')return unknown('exact modification Source operation required');
    const base=registeredPublisherSource(registry,file,baseText,options);
    if(!base.passed)return unknown('publisher predecessor absent');
  }
  return head;
}
