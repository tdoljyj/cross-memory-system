// Fixed permission interpretation: concrete observed targets, never caller globs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {project} from '../nonproduction-control-store/runtime-successor/commitment-signing/signing.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fixedNames=['ga.raw','host-intent.json','created-container.json','watchdog-launch.json','watchdog-ready.json','watchdog-unknown.json','main-stopped.json','watchdog-stopped.json',
 'driver/SKILL.md','driver/references/engineering.md','driver/references/memory-operations.md','driver/fixed_skill_fixture.py','allowed/fixture.json'];
for(const operation of ['create','start','stop','inspect'])for(const suffix of ['once.json','result.json'])fixedNames.push('bridge-'+operation+'-'+suffix);
for(const actor of ['main','watchdog'])for(const tag of ['create','created-inspect','before-start','start','bridge-running-inspect','bridge-inspect','before-stop','stop','wait','after-stop'])for(const suffix of ['-request.json','-response.json','.stdout','.stderr'])fixedNames.push(actor+'-'+tag+suffix);
export const fixedWriteTargetRules=Object.freeze({format:'EXACT_OBSERVED_PREENTRY_WRITE_TARGETS_V1',nonce_derivation:'SHA256_UTF8_clued-fixed-host-v1_NUL_GA_ID_FIRST32',
 local_root:'scripts/phase2-qualification/preentry-parent/work',local_relative_files:Object.freeze(fixedNames.sort()),
 docker_endpoint:'npipe:////./pipe/dockerDesktopLinuxEngine',docker_manifest_digest:'sha256:285a71327884a4d50efbea30104473b0fa43ecefa499458899670ca30dae76e5',docker_config_digest:'sha256:1148adc3b50891ee01e6add44be22d277dedeb8dcac2f7cc8b700dd710c75c4d',
 sql_project:project,sql_schema:'clued_control',sql_targets:Object.freeze(['execution_events:THIS_GA_SEQUENCE','gate_attempts:THIS_ROOT_GA','execution_current:THIS_ROOT']),
 observation_interval:'COMPLETED_TEST_EFFECTS_THROUGH_ORIGINAL_STOPPED_EVENT',
 evidence_transport_obligations:'Original GA admission signature and final GRR payload/signature/reservation/CAS/readback remain independently mandatory; they are not self-included as prior test effects.',
 historical_component_evidence_is_read_only:true,caller_patterns_allowed:false});
export function checkDockerWriteIdentity(observation,containerId,nonce){
 need(observation?.Id===containerId&&observation.Name==='/clued-synthetic-'+nonce&&observation.Image===fixedWriteTargetRules.docker_manifest_digest&&observation.Config?.Image==='docker.io/library/python@'+fixedWriteTargetRules.docker_manifest_digest,'EXACT_DOCKER_WRITE_ID_NAME_IMAGE');
}
export function collectActualWriteTargets({ga,state,receiptId}){
 need(/^ga_[A-Za-z0-9_-]{1,128}$/.test(ga.gate_authorization_id)&&/^grr_[A-Za-z0-9_-]{1,128}$/.test(receiptId),'EXACT_ORIGINAL_CONTROL_IDS');
 const nonce=sha('clued-fixed-host-v1\0'+ga.gate_authorization_id).slice(0,32),folder=path.join(repo,fixedWriteTargetRules.local_root,nonce);
 const attempts=state.attempts.filter(a=>a.ga_id===ga.gate_authorization_id);need(attempts.length===1,'ONE_ORIGINAL_WRITE_SUBJECT');const a=attempts[0];
 const files=[];
 function walk(directory){need(!fs.lstatSync(directory).isSymbolicLink(),'NO_LINKED_WRITE_INVENTORY');for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const filename=path.join(directory,entry.name);need(!entry.isSymbolicLink(),'NO_LINKED_WRITE_INVENTORY');
  if(entry.isDirectory()){const rel=path.relative(folder,filename).replaceAll('\\','/');need(['driver','driver/references','allowed','docker-config','temp'].includes(rel),'NO_UNACCEPTED_LOCAL_DIRECTORY');walk(filename);}
  else {const rel=path.relative(folder,filename).replaceAll('\\','/');need(entry.isFile()&&fixedNames.includes(rel),'NO_UNACCEPTED_LOCAL_WRITE_TARGET');const data=fs.readFileSync(filename);need(data.length<=131072,'BOUNDED_ORIGINAL_WRITE_FILE');files.push({target:filename.replaceAll('\\','/'),bytes:data.length,sha256:sha(data)});}
 }}
 walk(folder);need(files.some(e=>e.target.endsWith('/allowed/fixture.json')),'ACTUAL_FIXED_FIXTURE_WRITE_REQUIRED');
 const allEvents=state.events.filter(e=>e.request.ga_id===a.ga_id);need(allEvents.length>0,'ACTUAL_GA_WRITE_EVENTS_REQUIRED');
 const stops=allEvents.filter(e=>e.request.operation==='STOPPED');need(stops.length===1,'EXACT_STOP_WRITE_SOURCE');
 const events=allEvents.filter(e=>e.sequence<=stops[0].sequence);
 const stop=JSON.parse(stops[0].request.body.raw);checkDockerWriteIdentity(stop.observation,a.container_id,nonce);
 const targets=files.map(e=>e.target);
 targets.push('docker:'+fixedWriteTargetRules.docker_endpoint+'#'+a.container_id);
 for(const e of events){need(e.root_id===state.binding.root_id&&Number.isSafeInteger(e.sequence)&&e.sequence>0,'EXACT_SAME_ROOT_EVENT_WRITE');targets.push('urn:clued:control-evidence:'+project+':execution-events:'+e.sequence);}
 targets.push('urn:clued:sql:'+project+':clued_control:gate_attempts:'+state.binding.root_id+':'+a.ga_id,'urn:clued:sql:'+project+':clued_control:execution_current:'+state.binding.root_id);
 need(new Set(targets).size===targets.length,'UNIQUE_ACTUAL_TARGETS');
 return {targets:targets.sort(),local_file_observations:files.sort((x,y)=>x.target.localeCompare(y.target)),source_event_sequences:events.map(e=>e.sequence),boundary:fixedWriteTargetRules.evidence_transport_obligations};
}
export function checkActualWriteTargets({receipt,ga,state,scope}){
 need(same(scope.write_target_rules,fixedWriteTargetRules)&&same(scope.allowed_write_set,ga.allowed_write_set),'EXACT_ACCEPTED_SCOPE_WRITE_RULES');
 const observed=collectActualWriteTargets({ga,state,receiptId:receipt.gate_result_receipt_id});
 need(Array.isArray(receipt.actual_write_set)&&new Set(receipt.actual_write_set).size===receipt.actual_write_set.length&&same([...receipt.actual_write_set].sort(),observed.targets),'EXACT_COMPLETE_OBSERVED_WRITE_TARGETS');
 return {state:'ACTUAL_TARGETS_RESOLVED_NOT_AUTHORITY',...observed};
}
