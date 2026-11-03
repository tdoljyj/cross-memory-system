// Exact non-PR Source/complete roles only. This never grants an actor effect.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
// Classification never imports an executable actor/provider from a workflow.
export const ACTOR_WORKFLOW='.github/workflows/clued-standard-runner-actor-qualification.yml';
const WORKFLOW=ACTOR_WORKFLOW;
export const COMPONENT_VERSION='1.0.0';
export const ACTOR_SOURCE_PATH='scripts/ci/clued-standard-runner-actor-sources.json';
export const ACTOR_SOURCE_SCHEMA='clued.standard-runner-actor-sources/1';
export const MAX_ACTOR_WORKFLOW_BYTES=262144;
const CHECKOUT='actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>hash(typeof v==='string'?v:JSON.stringify(canonical(v)));
const blob=b=>createHash('sha1').update(`blob ${Buffer.byteLength(b)}\0`).update(b).digest('hex');
const need=(v,c)=>{if(!v)throw Error(c);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
function validateRows(rows){
 need(Array.isArray(rows)&&rows.length>=1&&rows.length<=128,'ACTOR_ROWS_BOUND');
 const seen=new Set(),jobs=new Set(),runners=new Set(),subjects=new Set();
 for(const r of rows){
  need(exact(r,['node_id','host','sid','runner_id','runner_name','site','job','request_sha256','predecessor_sha256']),'ACTOR_ROW_FIELDS');
  need(typeof r.node_id==='string'&&/^[a-z0-9][a-z0-9-]{1,79}$/.test(r.node_id)&&typeof r.host==='string'&&/^[A-Z0-9][A-Z0-9-]{0,62}$/.test(r.host)&&typeof r.sid==='string'&&/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(r.sid),'ACTOR_ROW_IDENTITY');
  need(Number.isSafeInteger(r.runner_id)&&r.runner_id>0&&typeof r.runner_name==='string'&&/^clued-ci-[a-z0-9-]{1,80}$/.test(r.runner_name)&&typeof r.site==='string'&&/^site-[a-z0-9-]{1,32}$/.test(r.site)&&typeof r.job==='string'&&/^qualify-[a-z0-9-]{1,64}$/.test(r.job),'ACTOR_ROW_ROUTE');
  need([r.request_sha256,r.predecessor_sha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)),'ACTOR_ROW_HISTORY');
  for(const [set,value] of [[seen,r.node_id],[jobs,r.job],[runners,r.runner_id],[subjects,r.host+'/'+r.sid]]){need(!set.has(value),'ACTOR_ROW_DUPLICATE');set.add(value);}
 }
 return rows;
}
const temporary={name:'Configure job temporary storage',uses:'./.github/actions/ci-temporary-storage'};
export function expectedActorDefinition(rows){
 rows=validateRows(rows);
 const jobs={'admission-gate':{name:'admission-gate','runs-on':['self-hosted','Linux','X64','clued','pool-general','trust-internal'],'timeout-minutes':10,permissions:{actions:'read',checks:'read',contents:'read','pull-requests':'read'},outputs:{admitted:'${{ steps.gate.outputs.admitted }}'},steps:[{uses:CHECKOUT,with:{'persist-credentials':false,ref:'${{ github.event.repository.default_branch }}'}},temporary,{id:'gate',env:{GITHUB_TOKEN:'${{ github.token }}'},run:'node scripts/ci/clued-work-admission.mjs --mode gate'}]}};
 for(const row of rows)jobs[row.job]={name:'standard-runner-actor-'+row.job.slice(8),needs:'admission-gate',if:`needs.admission-gate.outputs.admitted == 'true' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor_id == '52366662' && github.triggering_actor == github.repository_owner && inputs.node_id == '${row.node_id}'`,'runs-on':['self-hosted','Windows','X64','clued','pool-general','trust-internal','cap-node24','cap-python312',row.site],'timeout-minutes':15,permissions:{contents:'read','id-token':'write'},steps:[{uses:CHECKOUT,with:{'persist-credentials':false,ref:'${{ github.sha }}'}},temporary,{name:'Run the exact admitted standard-runner actor adapter',shell:'powershell',run:"$ErrorActionPreference = 'Stop'\n& node scripts/runner/qualify-standard-runner-actor.mjs --execute\nexit $LASTEXITCODE\n"}]};
 return {name:'Clued standard runner qualification and maintenance installation',on:{workflow_dispatch:{inputs:{admission_run_id:{description:'Exact existing dispatch admission for this Source/ref/claim',required:true,type:'string'},node_id:{description:'Closed requested row selector; never execution authority',required:true,type:'choice',options:rows.map(r=>r.node_id)}}}},permissions:{contents:'read'},concurrency:{group:'clued-standard-runner-actor-once','cancel-in-progress':false},jobs};
}
export function compileActorSource(file,raw,{parseYaml,roles,rows}={}){
 need(file===WORKFLOW&&typeof raw==='string'&&Buffer.byteLength(raw)<=MAX_ACTOR_WORKFLOW_BYTES&&typeof parseYaml==='function','ACTOR_SOURCE_INPUT');
 need(!/\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(raw),'ACTOR_SOURCE_CHARACTER_DOMAIN');
 const definition=parseYaml(raw),expected=expectedActorDefinition(rows);
 need(isDeepStrictEqual(definition,expected),'ACTOR_COMPLETE_DEFINITION_DIFFERS');
 const ids=Object.keys(definition.jobs);
 need(Array.isArray(roles)&&roles.length===ids.length&&new Set(roles.map(r=>r?.job_id)).size===ids.length,'ACTOR_COMPLETE_ROLES_REQUIRED');
 for(const id of ids){const r=roles.find(x=>x.job_id===id);need(exact(r,['job_id','definition_sha256','definition'])&&r.definition_sha256===digest(definition.jobs[id])&&isDeepStrictEqual(r.definition,definition.jobs[id]),'ACTOR_FULL_ROLE_DIFFERS');}
 return {schema:'clued.standard-runner-actor-source-profile/1',registration_status:'registered',purpose:'standard_runner_self_s4u_qualification_then_install_once',effect_purposes:['standard_runner_self_s4u_qualification_once','standard_runner_self_s4u_maintenance_install_once'],file,workflow_blob:blob(raw),source_sha256:hash(raw),workflow_definition_sha256:digest(definition),row_data_sha256:digest(validateRows(rows)),primary_ids:ids,pull_request_ci:false,execution_authority:false};
}
export function classifyActorSource(registry,file,raw,{repository='tdoljyj/cross-memory-system'}={}){
 try{
  need(exact(registry,['schema','repository','default_branch','source','roles','adapter','tool_epoch']),'ACTOR_CATALOGUE_SHAPE');
  need(registry.schema===ACTOR_SOURCE_SCHEMA&&registry.repository===repository&&repository==='tdoljyj/cross-memory-system'&&registry.default_branch==='main','ACTOR_CATALOGUE_IDENTITY');
  const s=registry.source;
  need(exact(s,['file','source_yaml','definition','rows','profile'])&&file===WORKFLOW&&s.file===file&&raw===s.source_yaml,'ACTOR_EXACT_SOURCE_REQUIRED');
  const profile=compileActorSource(file,raw,{parseYaml:()=>s.definition,roles:registry.roles,rows:s.rows});
  need(isDeepStrictEqual(profile,s.profile),'ACTOR_SOURCE_PROFILE_DIFFERS');
  need(exact(registry.adapter,['path','sha256'])&&registry.adapter.path==='scripts/runner/qualify-standard-runner-actor.mjs'&&/^[0-9a-f]{64}$/.test(registry.adapter.sha256),'ACTOR_ADAPTER_SOURCE_REQUIRED');
  need(exact(registry.tool_epoch,['delivery_manifest_sha256','subject_sha256','pins_sha256'])&&Object.values(registry.tool_epoch).every(v=>/^[0-9a-f]{64}$/.test(v)),'ACTOR_TOOL_EPOCH_REQUIRED');
  return {passed:true,kind:'registered_non_pr_actor_source_only',profile,roles:registry.roles,execution_authority:false,host_qualified:false,operator_accepted:false};
 }catch{return {passed:false,kind:'unknown',execution_authority:false};}
}
export function trustedActorCatalogue(){
 try{const u=new URL('./clued-standard-runner-actor-sources.json',import.meta.url),s=fs.lstatSync(u);if(!s.isFile()||s.isSymbolicLink()||s.size>524288)return null;const b=fs.readFileSync(u),t=b.toString('utf8');if(b.length>524288||!Buffer.from(t,'utf8').equals(b))return null;return JSON.parse(t);}catch{return null;}
}
export function registeredActorTransition(file,text){return classifyActorSource(trustedActorCatalogue(),file,text);}
