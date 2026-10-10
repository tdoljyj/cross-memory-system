import {createHash} from 'node:crypto';

const digest=text=>createHash('sha256').update(text).digest('hex');
export const workflowBlob=text=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const reject=reason=>{throw new Error(`unregistered workflow definition: ${reason}`);};

// Registration-time compiler only. parseYaml must be the locked, independently
// checked YAML parser. Consumers use default-branch registered data, never a
// pull request's asserted profile or executable parser.
export function compileRegisteredWorkflow(text,{primary_ids,parseYaml}={}) {
  if(typeof text!=='string' || text.length>524288 || typeof parseYaml!=='function' ||
    !Array.isArray(primary_ids) || !primary_ids.length || new Set(primary_ids).size!==primary_ids.length)
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
    routes.push({job_id:id,name,self_hosted:Array.isArray(labels)&&labels.includes('self-hosted'),
      required_steps:Object.fromEntries(Object.entries(commands).map(([name,values])=>[name,values.length])),
      command_digests:Object.fromEntries(Object.entries(commands))});
  }
  if(routes.length>2 || new Set(routes.map(route=>route.self_hosted)).size!==routes.length)
    reject('unsupported multiple logical primaries or duplicate routes');
  return {registration_status:'registered',workflow_blob:workflowBlob(text),source_sha256:digest(text),
    source_yaml:text,primary_ids:[...primary_ids],pull_request:trigger,gated:Object.hasOwn(value.jobs,'admission-gate'),routes};
}

// Map contains the complete, authenticated set of CI sources on this head.
// Registry comes only from the trusted default-branch checkout. A new head
// cannot register itself by sending a profile in its own JSON.
export function selectRegisteredProfiles(registry,sources,{sourceApproved,directoryComplete}={}) {
  const unknown=reason=>({passed:false,state:'unknown',reason});
  try {
  if(registry?.schema!=='clued.gated-proof-profiles/2' || !(sources instanceof Map) ||
    directoryComplete!==true || sourceApproved!==true || !sources.size)return unknown('source approval/directory/registry missing');
  const selected={schema:registry.schema,workflows:{}};
  for(const [file,blob] of sources) {
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
        Object.entries(route.required_steps).some(([name,count])=>!Number.isSafeInteger(count) || count<1 ||
          !Array.isArray(route.command_digests?.[name]) || route.command_digests[name].length!==count ||
          route.command_digests[name].some(hash=>!/^[a-f0-9]{64}$/.test(hash)))))
      return unknown(`${file}: registered source/profile integrity invalid`);
    selected.workflows[file]=entry;
  }
  return {passed:true,state:'qualified',profiles:selected};
  } catch {return unknown('registered source/profile schema invalid');}
}
