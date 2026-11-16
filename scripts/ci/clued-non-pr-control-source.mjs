// Exact non-PR directory classification only. This candidate is not an Owner
// acceptance, Host qualification, execution grant or permission to run a job.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';

export const COMPONENT_VERSION='1.0.4';
export const NON_PR_CONTROL_SOURCE_PATH='scripts/ci/clued-non-pr-control-sources.json';
export const NON_PR_CONTROL_SOURCE_SCHEMA='clued.non-pr-control-sources/1';
export const NON_PR_CONTROL_MAX_BYTES=524288;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
// Independently pinned complete workflow and every job, including the gate.
export const NON_PR_CONTROL_FILES=freeze({
  ".github/workflows/clued-compute-panel.yml": {
    "family": "compute_panel",
    "workflow_blob": "baa297ef49804984999afd5b05d51386aa84cac4",
    "source_sha256": "5a922a93e1b8b97d35103079ea19246238da319eadc86be9fe0d475d46111483",
    "workflow_definition_sha256": "0bac13a8f87320e17f74205826c98b78d4d2513133f51e628181538fc6f7869d",
    "triggers": [
      "schedule",
      "workflow_dispatch"
    ],
    "roles": {
      "admission-gate": "a38d818cac3e095f0747700e9d206a65a395c3af97728f3230743748b548a1bd",
      "probe-company-linux-01": "96794dc2c7b6e48f7fa7d7f62ff84b2c6f74dd3a8bed39c412f8ef2600de4c09",
      "probe-company-linux-02": "561b704bbd0b8066d54d0fa13d089ec105e45f320157289fea31d8a8c88b9769",
      "probe-company-linux-03": "52f75abb45e4a2cee0364ead371ec8955beb43278341c5fabdf4da8177ece149",
      "probe-company-linux-04": "50f64197a6c55061e23063a21f2f0f4d92ad7d3af8beecda76bd76167cc5db7c",
      "probe-company-win-01": "e9d3a88481e33b2fa7ab26fb4ccce67c87a95e70e47d4520eee3aab870e4c190",
      "probe-home-win-01": "1c8e63c417f3c139435bbbdc9eff3007d74b162c745f5cd0c6d88a00f50c6f8c",
      "panel": "f6dab50b88823d3dc0e6a7901024d73956582a7a422525084348f52d258b1150"
    }
  },
  ".github/workflows/clued-front-main-merge.yml": {
    "family": "front_main_merge_dispatch",
    "workflow_blob": "74a96c7ab1de73c64259f78f8072deee06ec8686",
    "source_sha256": "86cd1f4481defe3303ad627ff5808d16b5fc493b274b845c542e1d7abcd4a840",
    "workflow_definition_sha256": "8579bf1b7f0fece985d2c09ae70a37ec7286e8bfdeb2296ff1eb7b9cfe09c6d3",
    "triggers": [
      "workflow_dispatch"
    ],
    "roles": {
      "admission-gate": "2b609bfa2f0df5218d4f2db824737fb6066b54f132626a1470a49bc606743348",
      "merge-main": "0b93443b5f9ebfbaa14134ef74e33eede99446b4683a90105489415569f492df"
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
