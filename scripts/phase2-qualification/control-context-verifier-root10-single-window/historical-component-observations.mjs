// Revalidates accepted original component Evidence. Never starts PG or rewrites original facts.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha,readBlobRef,verifyOwnerMergeArtifact} from './trusted-github.mjs';
import {checkGAShape,time} from './context.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const need=(v,m)=>{if(!v)throw Error(m);};
const cases=['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'];
export function revalidateHistoricalComponents({gaRaw,state,runtimeAcceptance}){
 const ga=checkGAShape(gaRaw);
 need(typeof runtimeAcceptance?.raw==='string'&&sha(runtimeAcceptance.raw)===state.binding.runtime_acceptance_sha256,'EXACT_CURRENT_ACCEPTED_RUNTIME_SOURCE');
 verifyOwnerMergeArtifact({...runtimeAcceptance.publication,raw:runtimeAcceptance.raw});
 const accepted=JSON.parse(runtimeAcceptance.raw);
 need(accepted.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&accepted.independent_reviewer==='/root','ACTUAL_INDEPENDENT_RUNTIME_ACCEPTANCE');
 const entries=accepted.accepted_subject.historical_component_evidence;
 need(Array.isArray(entries)&&entries.length===cases.length&&new Set(entries.map(e=>e.test_id)).size===cases.length&&cases.every(id=>entries.some(e=>e.test_id===id)),'EXACT_FIVE_COMPONENT_CASE_BINDINGS');
 const manifestRaw=fs.readFileSync(new URL('ControllerSourceManifest.candidate.json',import.meta.url),'utf8');need(sha(manifestRaw)===ga.controller_digest,'CURRENT_EXACT_CONTROLLER_SOURCE');
 const manifest=JSON.parse(manifestRaw),results=[];
 for(const binding of entries){
  need(time(binding.original_observed_at)<Date.now(),'ACTUAL_ORIGINAL_OBSERVATION_TIME');
  const originalRaw=readBlobRef(binding.original_ref),applicabilityRaw=readBlobRef(binding.applicability_ref);
  const original=JSON.parse(originalRaw);need(original.case_id===binding.test_id&&original.started_at===binding.original_observed_at,'EXACT_ORIGINAL_CASE_AND_TIME');
  need(Array.isArray(binding.original_subject_refs)&&binding.original_subject_refs.length>0&&Array.isArray(binding.current_source_refs)&&binding.current_source_refs.length>0,'EXACT_OLD_AND_CURRENT_SUBJECT_BINDINGS');
  const originalSubjects=binding.original_subject_refs.map(ref=>{const raw=readBlobRef(ref);return {ref,bytes:Buffer.byteLength(raw),sha256:sha(raw)};});
  for(const source of binding.current_source_refs){
   need(typeof source.path==='string'&&!source.path.includes('..')&&!path.isAbsolute(source.path),'FIXED_CURRENT_SOURCE_PATH');
   const matches=manifest.files.filter(e=>e.path===source.path);need(matches.length===1&&matches[0].sha256===source.sha256&&sha(fs.readFileSync(path.join(repo,source.path)))===source.sha256,'ACTUAL_CURRENT_COMPONENT_SOURCE_BYTES');
  }
  const value={kind:'HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED',test_id:binding.test_id,revalidated_at:new Date().toISOString(),current_ga_id:ga.gate_authorization_id,current_ga_sha256:sha(gaRaw),
   original_ref:binding.original_ref,original_observed_at:binding.original_observed_at,original_bytes:Buffer.byteLength(originalRaw),original_sha256:sha(originalRaw),original_subjects:originalSubjects,
   exact_600_applicability:{ref:binding.applicability_ref,bytes:Buffer.byteLength(applicabilityRaw),sha256:sha(applicabilityRaw)},current_source_refs:binding.current_source_refs,
   evidence_boundary:'Original raw is preserved at its exact immutable reference; identities and time are retained verbatim. This GA performed read-only exact-source revalidation; it did not run the historical PG fault, sign its oracle assessment or produce a new original result.',
   pg_started:false,authority_effect:'NONE',complete_case_pass:false};
  const raw=JSON.stringify(value)+'\n';results.push({test_id:binding.test_id,raw,sha256:sha(raw),complete_case_pass:false});
 }
 return {state:'FIVE_ACCEPTED_ORIGINAL_COMPONENT_EVIDENCE_BINDINGS_REVALIDATED',results,complete_pqual_pass:false,pg_started:false};
}

export function verifyHistoricalObservationChain({value,subject}){
 need(value?.kind==='HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED'&&cases.includes(value.test_id),'EXACT_HISTORICAL_COMPONENT_KIND');
 const entries=subject.historical_component_evidence?.filter(e=>e.test_id===value.test_id);need(entries?.length===1,'ONE_ACCEPTED_COMPONENT_BINDING');
 const binding=entries[0];need(JSON.stringify(value.original_ref)===JSON.stringify(binding.original_ref)&&value.original_observed_at===binding.original_observed_at,'ACCEPTED_ORIGINAL_COMPONENT_SOURCE');
 const originalRaw=readBlobRef(binding.original_ref),original=JSON.parse(originalRaw);
 need(value.original_sha256===sha(originalRaw)&&value.original_bytes===Buffer.byteLength(originalRaw)&&original.case_id===value.test_id&&original.started_at===value.original_observed_at,'ACTUAL_ORIGINAL_COMPONENT_BYTES_CASE_TIME');
 time(value.original_observed_at);time(value.revalidated_at);
 need(JSON.stringify(value.exact_600_applicability.ref)===JSON.stringify(binding.applicability_ref),'ACCEPTED_600_APPLICABILITY');
 const applicable=readBlobRef(binding.applicability_ref);need(value.exact_600_applicability.sha256===sha(applicable)&&value.exact_600_applicability.bytes===Buffer.byteLength(applicable),'ACTUAL_APPLICABILITY_BYTES');
 need(JSON.stringify(value.current_source_refs)===JSON.stringify(binding.current_source_refs)&&value.original_subjects.length===binding.original_subject_refs.length,'EXACT_COMPONENT_SOURCE_SET');
 const manifest=JSON.parse(fs.readFileSync(new URL('ControllerSourceManifest.candidate.json',import.meta.url),'utf8'));
 for(const source of binding.current_source_refs){need(manifest.files.some(e=>e.path===source.path&&e.sha256===source.sha256)&&sha(fs.readFileSync(path.join(repo,source.path)))===source.sha256,'ACTUAL_CURRENT_COMPONENT_BYTES');}
 for(let i=0;i<binding.original_subject_refs.length;i++){const ref=binding.original_subject_refs[i],actual=readBlobRef(ref),record=value.original_subjects[i];need(JSON.stringify(record.ref)===JSON.stringify(ref)&&record.sha256===sha(actual)&&record.bytes===Buffer.byteLength(actual),'ACTUAL_ORIGINAL_SUBJECT_BYTES');}
 need(value.pg_started===false&&value.authority_effect==='NONE'&&value.complete_case_pass===false,'HISTORICAL_READBACK_NOT_NEW_EXECUTION');
 return {state:'ORIGINAL_COMPONENT_BYTES_AND_APPLICABILITY_ACTUALLY_READ',test_id:value.test_id,authority_effect:'NONE'};
}

