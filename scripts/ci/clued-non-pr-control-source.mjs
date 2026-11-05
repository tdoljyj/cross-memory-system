// Exact non-PR directory classification only. This candidate is not an Owner
// acceptance, Host qualification, execution grant or permission to run a job.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';

export const COMPONENT_VERSION='1.0.1';
export const NON_PR_CONTROL_SOURCE_PATH='scripts/ci/clued-non-pr-control-sources.json';
export const NON_PR_CONTROL_SOURCE_SCHEMA='clued.non-pr-control-sources/1';
export const NON_PR_CONTROL_MAX_BYTES=524288;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
// Independently pinned complete workflow and every job, including the gate.
export const NON_PR_CONTROL_FILES=freeze({
  ".github/workflows/clued-compute-panel.yml": {
    "family": "compute_panel",
    "workflow_blob": "055480696e936490b230f858f5844091068ece89",
    "source_sha256": "33d6f862228da76ce85e71caf83a65f5096df152a1fbee62aefa844a0d5e270a",
    "workflow_definition_sha256": "491b4b75a4c9030ee8b7d3a5015aefdf6270eadd65336e7f773711f8fd7a0112",
    "triggers": [
      "schedule",
      "workflow_dispatch"
    ],
    "roles": {
      "admission-gate": "a38d818cac3e095f0747700e9d206a65a395c3af97728f3230743748b548a1bd",
      "probe-company-linux-01": "bfe99c0c76e3e3b8d3571200eb58a3e4a74a7d8f423cd3d675e09869685051c1",
      "probe-company-linux-02": "b3c9ddc2e6d4bff310e11fa53bc52234ec3b349b7b0d4c1762cb97629d40fe3e",
      "probe-company-linux-03": "4abff93a2856e8b1ef004daa507c34127ec1a0468b1ce80a808ae10e71d337a5",
      "probe-company-linux-04": "2889c0581442422edd9901e83fee231d819281748add922af1d22d59627331a0",
      "probe-company-win-01": "4cc4f1e6c8c9a114cd81c11e1591ed3fa3312131d4a602b4bf39439eadbbf187",
      "probe-home-win-01": "4453ef9a9af1b2e3f705af656e5bbd8a84f789c4b571d369c015c175723c696b",
      "panel": "f6dab50b88823d3dc0e6a7901024d73956582a7a422525084348f52d258b1150"
    }
  },
  ".github/workflows/clued-native617-admission-dispatch.yml": {
    "family": "disabled_native617_dispatch",
    "workflow_blob": "b3bac281913f30e0a30ad2adba28e1c9e822e5a5",
    "source_sha256": "03528c7c651114476d596e16944643108743681024bc32a54760f8ad93dbe460",
    "workflow_definition_sha256": "6feee13f778e83c15457e15d31c613bdd16d56c1c4d93f03a7b4368a55ca18d4",
    "triggers": [
      "workflow_dispatch"
    ],
    "roles": {
      "admission-gate": "a38d818cac3e095f0747700e9d206a65a395c3af97728f3230743748b548a1bd",
      "admit": "9cfb9fb59855803c42ba4f554be031265e86425eadc1d2ecdbda74fb1e5c2467"
    }
  }
});
const hash=text=>createHash('sha256').update(text).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,expected)=>plain(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...expected].sort());
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const invalid=()=>{throw Error('NON_PR_CONTROL_CATALOGUE_INVALID');};
export function parseNonPrControlCatalogue(raw){
  try{
    if(typeof raw!=='string'&&!Buffer.isBuffer(raw)||typeof raw==='string'&&!raw.isWellFormed())invalid();
    const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw,'utf8');
    if(bytes.length>NON_PR_CONTROL_MAX_BYTES)invalid();
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),value=JSON.parse(text);
    if(JSON.stringify(canonical(value),null,2)+'\n'!==text)invalid();
    return value;
  }catch{invalid();}
}
const unknown=reason=>({passed:false,state:'unknown',reason,pull_request_ci:false,
  execution_authority:false,host_qualified:false});
export function classifyNonPrControlWorkflowSource(registry,file,text,{repository='tdoljyj/cross-memory-system'}={}){
  try{
    const fixed=NON_PR_CONTROL_FILES[file];
    if(!fixed||!keys(registry,['schema','repository','default_branch','purpose','source_acceptance','execution_authority','workflows','roles'])||
      registry.schema!==NON_PR_CONTROL_SOURCE_SCHEMA||registry.repository!=='tdoljyj/cross-memory-system'||
      registry.repository!==repository||registry.default_branch!=='main'||
      registry.purpose!=='exact_non_pr_source_classification_only'||registry.source_acceptance!==null||registry.execution_authority!==false||
      !keys(registry.workflows,Object.keys(NON_PR_CONTROL_FILES))||!keys(registry.roles,Object.keys(NON_PR_CONTROL_FILES)))
      return unknown('non-PR catalogue identity');
    // Validate the complete fixed family, not merely the requested row.
    for(const [name,pin]of Object.entries(NON_PR_CONTROL_FILES)){
      const source=registry.workflows[name],roles=registry.roles[name];
      if(!keys(source,['family','workflow_blob','source_sha256','workflow_definition_sha256','source_yaml_lines','workflow_definition'])||
        source.family!==pin.family||source.workflow_blob!==pin.workflow_blob||source.source_sha256!==pin.source_sha256||
        source.workflow_definition_sha256!==pin.workflow_definition_sha256||
        !Array.isArray(source.source_yaml_lines)||!source.source_yaml_lines.length||source.source_yaml_lines.length>8192||
        Object.keys(source.source_yaml_lines).length!==source.source_yaml_lines.length||
        source.source_yaml_lines.some(line=>typeof line!=='string'||!line.isWellFormed()||/[\r\n\u0000]/.test(line)))
        return unknown('non-PR exact Source shape');
      const yaml=source.source_yaml_lines.join('\n'),definition=source.workflow_definition;
      if(Buffer.byteLength(yaml)>NON_PR_CONTROL_MAX_BYTES||workflowBlob(yaml)!==pin.workflow_blob||hash(yaml)!==pin.source_sha256||
        !plain(definition)||roleDefinitionDigest(definition)!==pin.workflow_definition_sha256||
        !keys(definition.on,pin.triggers)||Object.hasOwn(definition.on,'pull_request')||Object.hasOwn(definition.on,'pull_request_target')||
        !keys(definition.jobs,Object.keys(pin.roles))||!Array.isArray(roles)||roles.length!==Object.keys(pin.roles).length||
        new Set(roles.map(role=>role?.job_id)).size!==roles.length)
        return unknown('non-PR complete workflow definition');
      for(const role of roles)if(!keys(role,['job_id','definition_sha256','definition'])||
        !Object.hasOwn(pin.roles,role.job_id)||role.definition_sha256!==pin.roles[role.job_id]||
        roleDefinitionDigest(role.definition)!==pin.roles[role.job_id]||
        !isDeepStrictEqual(role.definition,definition.jobs[role.job_id]))
        return unknown('non-PR complete independent roles');
    }
    const selected=registry.workflows[file];
    if(typeof text!=='string'||!text.isWellFormed()||Buffer.byteLength(text)>NON_PR_CONTROL_MAX_BYTES||
      workflowBlob(text)!==fixed.workflow_blob||hash(text)!==fixed.source_sha256||selected.source_yaml_lines.join('\n')!==text)
      return unknown('non-PR current Git bytes differ');
    return {passed:true,state:'source_classified',scope:'exact_non_pr_control_source_only',family:fixed.family,
      workflow_blob:fixed.workflow_blob,pull_request_ci:false,execution_authority:false,host_qualified:false};
  }catch{return unknown('non-PR Source integrity');}
}
