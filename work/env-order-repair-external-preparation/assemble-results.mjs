// Pure final evidence assembly; all original oracle and size checks retained.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {sha,moduleAt} from './dependencies.mjs';import {createWrap} from './wrap-observations.mjs';import {createResultTools} from './result-materials.mjs';
const {checkResultEvidenceStructure}=await moduleAt('scripts/phase2-qualification/result-evidence-resolution/resolve.mjs');
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),raw=x=>JSON.stringify(x)+'\n',need=(v,m)=>{if(!v)throw Error(m);},same=(a,b)=>raw(a)===raw(b),root='ctr_414bd3c724264a83894b0c55cf2ab878',prefix='urn:clued:execution-evidence:'+root+':';
// Original B evidence chain has its own historical controller identity.
const controller='edf31377656e1a9a473d0095df72231c058266007e4fd4046e0a9b8c2d6a60d9';
const fixed={compatibility:'e433f421b768c548d992cb490a5b5f266c133006b2aecaa9386899d6d1b9f0d6',installation:'400d614e804b899ea8617b7309933ced517db08f457d55653259f31e0329bfae'};
function restorationPin(){
 const p=JSON.parse(fs.readFileSync(path.join(workspace,'work/qualification-live-preparation/b-evidence-successor/ExactSources.json'),'utf8'));
 need(p.state==='ACTUAL_RESTORATION_REPORT_RECEIVED_EXACT_BYTES_BOUND'&&/^[0-9a-f]{64}$/.test(p.restoration?.sha256),'ACTUAL_INDEPENDENT_RESTORATION_REPORT_NOT_YET_BOUND');
 return p.restoration;
}
function compatibilityArtifacts(evidence){
 need(evidence&&Object.keys(evidence).sort().join(',')==='compatibility,installation,restoration','EXACT_THREE_COMPATIBILITY_SOURCES');
 for(const [name,h] of Object.entries(fixed))need(typeof evidence[name]?.raw==='string'&&evidence[name].sha256===h&&sha(evidence[name].raw)===h,'EXACT_ORIGINAL_'+name.toUpperCase()+'_BYTES');
 const restore=restorationPin(),expected={...fixed,restoration:restore.sha256};
 const artifacts=Object.keys(expected).map(name=>{
  const item=evidence[name];need(typeof item?.raw==='string'&&item.sha256===expected[name]&&sha(item.raw)===expected[name]&&Buffer.byteLength(item.raw)<=131072,'EXACT_ORIGINAL_'+name.toUpperCase()+'_BYTES');
  const value=JSON.parse(item.raw);need(value.independent_reviewer==='/root/project_list_auth_fix','ORIGINAL_INDEPENDENT_REVIEW_SOURCE');
  return {uri:prefix+item.sha256,sha256:item.sha256,raw:item.raw};
 });
 const c=JSON.parse(artifacts[0].raw),i=JSON.parse(artifacts[1].raw),r=JSON.parse(artifacts[2].raw);
 need(c.state==='ACCEPTED_EXACT_DEDICATED_INTENT_RESPONSE_DATABASE_COMPATIBILITY_SUCCESSOR'&&c.original_controller_digest===controller&&i.compatibility_acceptance_sha256===fixed.compatibility,'EXACT_ACCEPTED_B_COMPATIBILITY_CHAIN');
 need(r.state===restore.expected_state,'EXACT_RESTORATION_REPORT_STATE');
 // Exact received report bytes bind its full historical/installation applicability.
 // No current SQL claim or permission is derived from a caller boolean or this report.
 return artifacts;
}

export function createAssembler(material){
 const tools=createResultTools(material),{wrap}=createWrap(material),suite=tools.suite,suiteRaw=material.gate_suite.raw,suiteSha=sha(suiteRaw),reviewer=tools.subject.result_reviewer_ref,performanceArtifacts=tools.performanceArtifacts;
 const gaFrom=s=>{need(s===material.ga_raw,'SAME_COMPLETE_CURRENT_GA');return tools.ga;};
 function safe(v){if(typeof v==='number')need(Number.isSafeInteger(v),'UNSAFE_NUMBER');else if(v&&typeof v==='object')for(const x of Object.values(v))safe(x);}
 function exact(s,limit=131072){need(typeof s==='string'&&Buffer.byteLength(s)<=limit,'MISSING_OR_OVERSIZED_ORIGINAL_RAW');const x=JSON.parse(s);safe(x);need(raw(x)===s,'EXACT_COMPACT_LF_ORIGINAL_BYTES_REQUIRED');return x;}
 function artifact(s){need(Buffer.byteLength(s)<=131072,'ARTIFACT_EXCEEDS_131072');return {uri:prefix+sha(s),sha256:sha(s),raw:s};}
 const ref=x=>({uri:x.uri,sha256:x.sha256});
 function refsEqual(a,b){return same(a.map(x=>x.uri+'\0'+x.sha256).sort(),b.map(x=>x.uri+'\0'+x.sha256).sort());}
 function reference(x){need(x&&Object.keys(x).sort().join(',')==='sha256,uri'&&typeof x.uri==='string'&&x.uri.length>0&&/^[0-9a-f]{64}$/.test(x.sha256),'EXACT_NONEMPTY_REFERENCE');return x;}
 function missing(input,names){return names.filter(n=>input?.[n]===undefined||input[n]===null);}
 function blocked(fields){return {state:'BLOCKED_MISSING_REAL_INPUT',missing:fields,authority_effect:'NONE',signed:false,receipt_issued:false};}
 function assembleOriginal(input){
 const absent=missing(input,['observation_input','assessments','metadata']);if(absent.length)return blocked(absent);
 const bundle=wrap(input.observation_input);if(bundle.state.startsWith('BLOCKED'))return bundle;
 const meta=input.metadata,required=['requested_result','executor_ref','fixture_refs','input_artifact_digests','performance_slo_revision','executor_actor_ref','independent_reviewer_ref'];
 const missingMeta=missing(meta,required);if(missingMeta.length)return blocked(missingMeta.map(x=>'metadata.'+x));
 need(['PASS','FAIL','BLOCKED','STALE'].includes(meta.requested_result),'EXPLICIT_ORIGINAL_RESULT_ENUM_REQUIRED');
 reference(meta.executor_ref);reference(meta.executor_actor_ref);reference(meta.independent_reviewer_ref);
 need(same(meta.independent_reviewer_ref,reviewer)&&!same(meta.executor_actor_ref,reviewer),'EXACT_DISTINCT_ACCEPTED_REVIEWER');
 need(Array.isArray(input.assessments),'ACTUAL_ASSESSMENT_ARRAY');
 const assessments=input.assessments.map(item=>{need(sha(item.raw)===item.sha256,'EXACT_ASSESSMENT_RAW_HASH');const value=exact(item.raw);need(value.kind==='INDEPENDENT_TEST_ORACLE_ASSESSMENT'&&value.independent_reviewer==='/root/project_list_auth_fix'&&same(value.reviewer_ref,reviewer),'ACTUAL_NAMED_INDEPENDENT_ASSESSMENT_REQUIRED');return {value,item:artifact(item.raw)};});
 need(new Set(assessments.map(x=>x.value.test_id)).size===assessments.length,'ONE_ASSESSMENT_PER_ORIGINAL_CASE');
 const absentAssessments=bundle.tests.filter(t=>!assessments.some(x=>x.value.test_id===t.test_id));if(absentAssessments.length)return blocked(absentAssessments.map(x=>'actual_independent_assessment.'+x.test_id));
 need(assessments.length===bundle.tests.length,'NO_ASSESSMENT_WITHOUT_ACTUAL_OBSERVATION');
 const results=[],tests=[];
 for(const t of bundle.tests){const a=assessments.find(x=>x.value.test_id===t.test_id),v=a.value;need(v.ga_id===bundle.ga_id&&v.ga_sha256===bundle.ga_sha256&&v.test_definition_digest===t.test_definition_digest&&v.expected_outcome_digest===t.expected_outcome_digest,'EXACT_CASE_GA_ORACLE_ASSESSMENT');need(refsEqual(v.observation_refs,t.observation_refs)&&typeof v.reason==='string'&&v.reason.trim()&&['PASS','FAIL','BLOCKED','STALE'].includes(v.result),'EXACT_ALL_SUBCASE_COVERAGE_AND_REAL_REASON');results.push({...t,evidence_refs:t.observation_refs,result:v.result});delete results.at(-1).observation_refs;tests.push({test_id:t.test_id,observation_refs:t.observation_refs,oracle_assessment_ref:ref(a.item)});}
 if(meta.requested_result==='PASS')need(bundle.missing_cases.length===0&&results.length===19&&results.every(t=>t.result==='PASS'),'NINETEEN_ACTUAL_INDEPENDENT_PASS_REQUIRED');
 const ga=gaFrom(input.observation_input.ga_raw);need(meta.executor_ref?.sha256===ga.controller_digest,'EXACT_EXECUTOR_REF');
 need(Array.isArray(meta.fixture_refs)&&Object.values(suite.tests).every(t=>meta.fixture_refs.some(f=>f.sha256===t.fixture_artifact_ref.sha256)),'EXACT_FIXTURE_REFS');meta.fixture_refs.forEach(reference);need(new Set(meta.fixture_refs.map(f=>f.uri)).size===meta.fixture_refs.length,'UNIQUE_FIXTURE_REFS');
 need(Array.isArray(meta.input_artifact_digests)&&[ga.candidate_skill_digest,ga.controller_digest,suiteSha].every(h=>meta.input_artifact_digests.includes(h))&&meta.input_artifact_digests.every(h=>/^[0-9a-f]{64}$/.test(h))&&new Set(meta.input_artifact_digests).size===meta.input_artifact_digests.length,'ALL_ACTUAL_INPUT_DIGESTS');
 const performanceEvidence=[];
 if(meta.performance_slo_revision==='NOT_APPLICABLE_PREENTRY_NO_PERFORMANCE_QUALIFICATION'){
  performanceEvidence.push(...performanceArtifacts(meta,ga));
  need(performanceEvidence.every(a=>meta.input_artifact_digests.includes(a.sha256)),'ALL_EIGHT_ORIGINAL_AND_CURRENT_NONPERFORMANCE_DIGESTS');
 }else need(typeof meta.performance_slo_revision==='string'&&meta.performance_slo_revision.trim()&&!/NOT_|PLACEHOLDER|UNKNOWN/.test(meta.performance_slo_revision),'REAL_PERFORMANCE_SLO_REVISION');
 const artifacts=[...bundle.artifacts,...assessments.map(x=>x.item),...performanceEvidence];need(new Set(artifacts.map(a=>a.uri)).size===artifacts.length&&artifacts.length<=256,'UNIQUE_BOUNDED_ORIGINAL_ARTIFACT_INDEX');
 const version=suite.tests['PQUAL-01'].definition_version,index={format:'EXACT_ORIGINAL_EVIDENCE_INDEX_V1',ga_id:bundle.ga_id,ga_sha256:bundle.ga_sha256,executor_ref:meta.executor_ref,test_revision:version,performance_slo_revision:meta.performance_slo_revision,fixture_refs:meta.fixture_refs,input_artifact_digests:meta.input_artifact_digests,artifacts,tests};
 const indexRaw=raw(index);need(Buffer.byteLength(indexRaw)<=131072,'INDEX_EXCEEDS_131072_NO_TRUNCATION_OR_OMISSION_ALLOWED');
 const decisionRaw=raw({ga_id:bundle.ga_id,ga_sha256:bundle.ga_sha256,result:meta.requested_result,test_results:results});need(Buffer.byteLength(decisionRaw)<=131072,'DECISION_EXCEEDS_131072');
 return {state:'ORIGINAL_INDEX_DECISION_PREPARED_NOT_RESERVED_NOT_SIGNED',index:{raw:indexRaw,sha256:sha(indexRaw),bytes:Buffer.byteLength(indexRaw)},decision:{raw:decisionRaw,sha256:sha(decisionRaw)},receipt_evidence_fields:{gate_authorization_id:bundle.ga_id,gate_authorization_sha256:bundle.ga_sha256,result:meta.requested_result,decision_sha256:sha(decisionRaw),test_revision:version,fixture_refs:meta.fixture_refs,executor_ref:meta.executor_ref,performance_slo_revision:meta.performance_slo_revision,test_results:results,input_artifact_digests:meta.input_artifact_digests,evidence_index_ref:ref(artifact(indexRaw)),raw_evidence_refs:artifacts.map(ref),executor_actor_ref:meta.executor_actor_ref,independent_reviewer_ref:reviewer},missing_cases:bundle.missing_cases,requires_actual_reserved_readback_validation:true,requires_actual_full_grr_original_signature_and_fresh_terminal:true,original_raws_modified:false,receipt_created:false,authority_effect:'NONE'};
}
// Exact historical B reports remain unchanged; new runtime acceptance supplies current applicability.
function assemble(input){
 if(!input?.observation_input||!input?.metadata)return assembleOriginal(input);
 const additions=compatibilityArtifacts(input.b_compatibility_evidence);
 const old=input.metadata.input_artifact_digests;
 need(Array.isArray(old)&&additions.every(a=>!old.includes(a.sha256)),'EXACT_ONCE_B_INPUT_DIGESTS');
 const output=assembleOriginal({...input,metadata:{...input.metadata,input_artifact_digests:[...old,...additions.map(a=>a.sha256)]}});
 if(output.state.startsWith('BLOCKED'))return output;
 need(output.missing_cases.length===0&&output.receipt_evidence_fields.test_results.length===19&&input.assessments.length===19,'ALL_NINETEEN_REAL_ASSESSMENTS');
 const index=JSON.parse(output.index.raw);index.artifacts.push(...additions);
 need(new Set(index.artifacts.map(a=>a.uri)).size===index.artifacts.length&&index.artifacts.length<=256,'UNIQUE_FULL_ARTIFACT_INDEX');
 const indexRaw=raw(index);need(Buffer.byteLength(indexRaw)<=131072,'INDEX_EXCEEDS_131072_NO_OMISSION');
 return {...output,index:{raw:indexRaw,sha256:sha(indexRaw),bytes:Buffer.byteLength(indexRaw)},receipt_evidence_fields:{...output.receipt_evidence_fields,evidence_index_ref:ref(artifact(indexRaw)),raw_evidence_refs:index.artifacts.map(ref)},b_compatibility_evidence_refs:additions.map(ref),current_database_identity_claimed:false};
}
function checkReserved(input){
 const absent=missing(input,['ga_raw','receipt_raw','actual_readback_state']);if(absent.length)return blocked(absent);
 const ga=gaFrom(input.ga_raw),receipt=exact(input.receipt_raw),state=input.actual_readback_state;
 need(state.binding?.root_id===root,'EXACT_FIXED_READBACK_ROOT');
 const checked=checkResultEvidenceStructure({receipt,ga,state,acceptedSuiteRaw:suiteRaw,acceptedSuiteSha256:suiteSha});
 return {state:'ORIGINAL_RESOLVER_READBACK_LAYOUT_CHECKED_NOT_ADMISSION',checks:checked,readback_authenticity_requires_actual_coordinator_tool_fact:true,no_state_or_decision_fabricated:true,signature_verified:false,receipt_issued:false,authority_effect:'NONE'};
}

 return {assemble,checkReserved,staticMetadata:tools.staticMetadata};
}
