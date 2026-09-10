// Pure current-material binding. No signature verification or remote acceptance is claimed.
import {isDeepStrictEqual as same} from 'node:util';
import fs from 'node:fs';
import {sha,controller,moduleAt,successor} from './dependencies.mjs';
const {checkGAShape}=await moduleAt(successor+'context.mjs');
const need=(v,m)=>{if(!v)throw Error(m);},prefix='urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:';
export const historicalPerformanceHashes=['98a502fdf43a1f0f9e4d01956c829826006c8cd1e8d2146fbc0540c10dc3e4b8','5ed0f7fd18cd156d51d2d96242d0bb7f3aab6882c5515005db77c3af9903d4c3','470db88dfe46e23a5f5ae183b590d191bfc8158b120a4c9194492c5c810faa87','3de507c22d88914e208b75d8a735364508c6db317f6e1063214701c179a7421c','634601592a2849cf8af6e6a128dcee9ce9d807f5b322be1ec98ce57cfff4bd3b','05f65c452153b201a57c0195bb27efe418dbb2f8f9a9c824cfec5985ae46e27d','c75f25044be55ebf8530b312b5d229b20ecb4b31e64ccb8516f445b360aaf523','c57afadaed6123e49d0e2d8e43dc97e5e6932fcb4df8564c1dfa6df0eab6c844'];
const artifact=raw=>({uri:prefix+sha(raw),sha256:sha(raw),raw});
const contract=JSON.parse(fs.readFileSync(new URL('../ordinary-bounded-approved-execution/admin-review/BoundedNonPerformanceApplicability.contract.json',import.meta.url),'utf8'));
function exact(item,ref,label){need(typeof item?.raw==='string'&&item.ref&&same(item.ref,ref)&&sha(item.raw)===ref.sha256,'EXACT_'+label+'_RAW_REF');return item;}
export function createResultTools(material){
 need(typeof material?.runtime_acceptance?.raw==='string','ACTUAL_RUNTIME_MATERIAL_REQUIRED');
 const runtime=JSON.parse(material.runtime_acceptance.raw),subject=runtime.accepted_subject,g=subject?.expected_ga,ga=checkGAShape(material.ga_raw);
 need(runtime.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&runtime.independent_reviewer==='/root/project_list_auth_fix'&&g?.controller_digest===controller,'CURRENT_ACCEPTED_RUNTIME');
 for(const [k,v] of Object.entries(g))need(same(ga[k],v),'EXACT_CURRENT_GA_FIXED_FIELD:'+k);
 const gate_suite=exact(material.gate_suite,subject.gate_suite_ref,'CURRENT_SUITE'),execution_scope=exact(material.execution_scope,ga.scope_ref,'CURRENT_SCOPE'),result_reviewer=exact(material.result_reviewer,subject.result_reviewer_ref,'ORIGINAL_REVIEWER'),result_issuer=material.result_issuer;
 need(result_reviewer.ref.sha256==='9ca45136f864beee04f9074a752070e95ff45f827e7b7a3489df4d0cdc6ec99d','ORIGINAL_REVIEWER_9CA451');
 need(result_issuer?.ref&&typeof result_issuer.raw==='string'&&sha(result_issuer.raw)===result_issuer.ref.sha256,'ACTUAL_RESULT_ISSUER_BYTES');
 for(const item of [gate_suite,execution_scope])need(item.publication?.commitSha===ga.target_revision&&typeof item.publication.artifactPath==='string'&&item.publication.artifactPath.length>0,'CURRENT_OWNER_PUBLICATION_DESCRIPTOR');
 const suite=JSON.parse(gate_suite.raw),scope=JSON.parse(execution_scope.raw);
 need(sha(gate_suite.raw)===ga.plan_digest&&scope.controller_source_manifest?.sha256===controller&&Object.keys(suite.tests).length===19,'CURRENT_SUITE_SCOPE_CONTROLLER');
 function performanceArtifacts(metadata,actualGa){
  need(same(actualGa,ga)&&metadata.performance_slo_revision==='NOT_APPLICABLE_PREENTRY_NO_PERFORMANCE_QUALIFICATION','EXACT_NONPERFORMANCE_CURRENT_GA');
  need(Array.isArray(material.nonperformance_sources)&&material.nonperformance_sources.length===8,'ALL_EIGHT_ORIGINAL_NONPERFORMANCE_SOURCES');
  const sources=material.nonperformance_sources.map((item,i)=>{need(typeof item?.raw==='string'&&sha(item.raw)===historicalPerformanceHashes[i]&&item.sha256===historicalPerformanceHashes[i],'ORIGINAL_NONPERFORMANCE_BYTES_ORDER:'+i);return artifact(item.raw);});
  const item=material.current_nonperformance_applicability;need(typeof item?.raw==='string'&&item.ref?.sha256===sha(item.raw),'ACTUAL_CURRENT_NONPERFORMANCE_ADDENDUM_BYTES');
  const a=JSON.parse(item.raw);need(a.state==='ACCEPTED_PARALLEL_SOURCE_NONPERFORMANCE_APPLICABILITY'&&a.independent_reviewer==='/root/project_list_auth_fix'&&a.controller_digest===controller&&a.scope_digest===ga.scope_digest&&a.root_generation===ga.control_trust_root_generation&&a.runtime_acceptance_sha256===sha(material.runtime_acceptance.raw)&&a.runtime_acceptance?.sha256===sha(material.runtime_acceptance.raw)&&a.runtime_acceptance.bytes===Buffer.byteLength(material.runtime_acceptance.raw)&&a.gate_suite_sha256===sha(gate_suite.raw)&&a.profile_applicability_sha256===subject.profile_window_applicability_ref.sha256&&a.historical_component_applicability_sha256===subject.historical_component_applicability_ref.sha256,'CURRENT_NONPERFORMANCE_EXACT_RUNTIME_SCOPE');
  need(a.performance_slo_revision===metadata.performance_slo_revision&&a.expires_at===runtime.expires_at&&Number.isFinite(Date.parse(a.issued_at))&&Date.parse(a.issued_at)<=Date.now()&&Date.now()<Date.parse(a.expires_at)&&a.entry_or_performance_qualification_granted===false&&a.case_verdicts_created===false&&a.authority_effect==='NONE','NONPERFORMANCE_ONLY_ORIGINAL_WINDOW');
  need(Array.isArray(a.original_applicability_sources)&&a.original_applicability_sources.length===8&&a.original_applicability_sources.every((r,i)=>r.sha256===historicalPerformanceHashes[i]&&r.bytes===Buffer.byteLength(sources[i].raw)&&typeof r.path==='string'&&r.path.length>0),'CURRENT_ADDENDUM_ALL_EIGHT_ORIGINALS');
  if(metadata.performance_slo_applicability!==undefined)need(metadata.performance_slo_applicability.raw===sources[0].raw&&metadata.performance_slo_applicability.sha256===sources[0].sha256,'UNCHANGED_OLD_PERFORMANCE_EVIDENCE');
  need(same(Object.keys(a).sort(),[...contract.required_keys,'supersedes','capacity_approval_ref','capacity_applicability_ref'].sort())&&same(a.capacity_approval_ref,subject.capacity_materials.approval.ref)&&same(a.capacity_applicability_ref,subject.capacity_materials.applicability.ref)&&same(a.supersedes,{path:'work/original-input-capacity-approved-execution/admin-review/CapacityNonPerformanceApplicability20260910.json',sha256:'8b8746ec26655a259e8de42746f66176459930f22f349acb5c0334c22d77ef6e',bytes:5235})&&same(a.original_applicability_sources,contract.original_applicability_sources),'EXACT_ACCEPTED_ADDENDUM_CONTRACT_AND_ORIGINAL_PATHS');
  return [...sources,artifact(item.raw)];
 }
 function staticMetadata(){const fixtureHashes=[...new Set(Object.values(suite.tests).map(t=>t.fixture_artifact_ref.sha256))],byHash=h=>{const matches=g.source_ref.blobs.filter(r=>r.sha256===h);need(matches.length===1,'ONE_EXACT_SOURCE_REF');return matches[0];};const base={executor_ref:byHash(controller),executor_actor_ref:g.actor_ref,independent_reviewer_ref:subject.result_reviewer_ref,fixture_refs:fixtureHashes.map(byHash),performance_slo_revision:'NOT_APPLICABLE_PREENTRY_NO_PERFORMANCE_QUALIFICATION'};const evidence=performanceArtifacts(base,ga);return {...base,input_artifact_digests:[g.candidate_skill_digest,controller,sha(gate_suite.raw),...fixtureHashes,...evidence.map(x=>x.sha256)],performance_slo_applicability:{raw:evidence[0].raw,sha256:evidence[0].sha256}};}
 return {runtime,subject,ga,suite,scope,performanceArtifacts,staticMetadata,resultMaterials:()=>({gate_suite,execution_scope,result_reviewer,result_issuer})};
}
