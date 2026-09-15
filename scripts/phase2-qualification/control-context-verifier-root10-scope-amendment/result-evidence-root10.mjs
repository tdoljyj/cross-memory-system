// Original Evidence index concretization. Integrity diagnostics never issue a GRR.
import crypto from 'node:crypto';
const sha=raw=>crypto.createHash('sha256').update(raw,'utf8').digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function safe(value){if(typeof value==='number')need(Number.isSafeInteger(value),'UNSAFE_NUMBER');else if(value&&typeof value==='object')for(const v of Object.values(value))safe(v);}
function exact(raw){need(typeof raw==='string'&&Buffer.byteLength(raw)<=131072,'BOUNDED_RAW');const v=JSON.parse(raw);safe(v);need(JSON.stringify(v)+'\n'===raw,'EXACT_UNIQUE_JSON');return v;}
function refs(value){need(Array.isArray(value),'REF_ARRAY');const keys=new Set();for(const r of value){need(r&&Object.keys(r).sort().join()==='sha256,uri'&&typeof r.uri==='string'&&r.uri.length>0&&/^[a-f0-9]{64}$/.test(r.sha256),'EXACT_REF');need(!keys.has(r.uri),'DUPLICATE_REF');keys.add(r.uri);}return value;}
function refSet(value){return refs(value).map(r=>r.uri+'\0'+r.sha256).sort();}
function realTimestamp(value){
 if(typeof value!=='string')return false;
 const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);
 if(!m)return false;
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(year<1||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return false;
 if(m[7]!=='Z'&&(Number(m[7].slice(1,3))>23||Number(m[7].slice(4,6))>59))return false;
 return Number.isFinite(Date.parse(value));
}
export function validateRoot10ExecutorApplicability({executorApplicability,suite,acceptedSuiteSha256,state,ga,independentReviewer,temporalDescriptor=null}){
 const mappingKeys=['state','independent_reviewer','root_id','control_trust_root_generation','suite_ref','suite_executor_sha256','current_controller_sha256','formal_test_ids','pqual18_disposition','oracle_bytes_unchanged','fixture_refs_unchanged','test_definitions_unchanged','controller_executes_same_oracles','new_authority','authority_effect'];
 need(executorApplicability&&Object.keys(executorApplicability).sort().join(',')===mappingKeys.sort().join(','),'EXACT_ROOT10_EXECUTOR_APPLICABILITY_FIELDS');
 const formal=Object.keys(suite.tests).sort();
 need(executorApplicability.state==='ACCEPTED_EXACT_ROOT10_EXECUTOR_APPLICABILITY'&&executorApplicability.independent_reviewer===independentReviewer&&executorApplicability.root_id===state.binding.root_id&&executorApplicability.control_trust_root_generation===ga.control_trust_root_generation,'EXACT_ROOT10_EXECUTOR_APPLICABILITY_IDENTITY');
 const currentController=temporalDescriptor?temporalDescriptor.continuation_controller_sha256:ga.controller_digest;
 if(temporalDescriptor)need(currentController===state.binding.controller_sha256,'EXACT_ACTUAL_EXECUTING_CONTROLLER');
 need(same(executorApplicability.suite_ref,{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/5a8ea176137f0f601488a0cbfa5ab69430a57744',sha256:acceptedSuiteSha256})&&executorApplicability.suite_executor_sha256==='27ede0fc0ff6afc4d5abf2f5c9f256fe22776165746dddc19aa2693c47bbc97c'&&executorApplicability.current_controller_sha256===currentController,'EXACT_OLD_SUITE_TO_CURRENT_CONTROLLER_MAPPING');
 need(formal.length===5&&!formal.includes('PQUAL-18')&&same(executorApplicability.formal_test_ids,formal)&&executorApplicability.pqual18_disposition==='NEGATIVE_ADMISSION_CHECK_NOT_FORMAL_RESULT','EXACT_5_FORMAL_PLUS_PQUAL18_NEGATIVE_GUARD');
 need(executorApplicability.oracle_bytes_unchanged===true&&executorApplicability.fixture_refs_unchanged===true&&executorApplicability.test_definitions_unchanged===true&&executorApplicability.controller_executes_same_oracles===true&&executorApplicability.new_authority===false&&executorApplicability.authority_effect==='NONE','NO_ORACLE_COVERAGE_OR_AUTHORITY_CHANGE');
 return {state:'ROOT10_EXECUTOR_APPLICABILITY_CHECKED',formal_test_ids:formal,pqual18_disposition:executorApplicability.pqual18_disposition,authority_effect:'NONE'};
}
export function checkRoot10ResultEvidenceStructure({receipt,ga,state,acceptedSuiteRaw,acceptedSuiteSha256,executorApplicability,independentReviewer,temporalDescriptor=null}){
 need(typeof acceptedSuiteRaw==='string'&&sha(acceptedSuiteRaw)===acceptedSuiteSha256,'EXACT_ACCEPTED_SUITE_BYTES');
 const suite=JSON.parse(acceptedSuiteRaw);safe(suite);need(suite.tests&&typeof suite.tests==='object','STATIC_TESTS_REQUIRED');
 validateRoot10ExecutorApplicability({executorApplicability,suite,acceptedSuiteSha256,state,ga,independentReviewer,temporalDescriptor});
 const gaRaw=JSON.stringify(ga)+'\n',gaSha=sha(gaRaw);
 need(receipt.gate_authorization_id===ga.gate_authorization_id&&receipt.gate_authorization_sha256===gaSha,'EXACT_GA');
 const attempts=state.attempts.filter(a=>a.ga_id===ga.gate_authorization_id);
 need(attempts.length===1&&attempts[0].ga_raw===gaRaw&&attempts[0].ga_sha256===gaSha,'ACTUAL_ORIGINAL_GA_RAW');
 const a=attempts[0],reserved=a.decision;
 need(reserved&&sha(reserved.decision_raw)===reserved.decision_sha256&&reserved.decision_sha256===receipt.decision_sha256,'ACTUAL_RESERVED_DECISION_RAW');
 need(sha(reserved.evidence_index_raw)===reserved.evidence_index_sha256&&reserved.evidence_index_sha256===receipt.evidence_index_ref.sha256,'ACTUAL_RESERVED_INDEX_RAW');
 const decision=exact(reserved.decision_raw),index=exact(reserved.evidence_index_raw);
 for(const v of [decision,index])need(v.ga_id===a.ga_id&&v.ga_sha256===gaSha,'SAME_GA_INDEX_AND_DECISION');
 need(index.format==='EXACT_ORIGINAL_EVIDENCE_INDEX_V1','ACCEPTED_INDEX_ENCODING');
 const prefix='urn:clued:execution-evidence:'+state.binding.root_id+':';
 need(receipt.evidence_index_ref.uri===prefix+reserved.evidence_index_sha256,'EXACT_INDEX_LOCATOR');
 need(decision.result===receipt.result&&same(decision.test_results,receipt.test_results),'RESERVED_RESULT_AND_TESTS');
 need(same(index.executor_ref,receipt.executor_ref)&&receipt.executor_ref.sha256===(temporalDescriptor?temporalDescriptor.continuation_controller_sha256:ga.controller_digest),'EXACT_EXECUTOR');
 need(index.test_revision===receipt.test_revision&&index.performance_slo_revision===receipt.performance_slo_revision,'EXACT_REVISIONS');
 need(same(refSet(index.fixture_refs),refSet(receipt.fixture_refs)),'EXACT_FIXTURES');
 need(Array.isArray(index.input_artifact_digests)&&same([...index.input_artifact_digests].sort(),[...receipt.input_artifact_digests].sort()),'EXACT_INPUT_ARTIFACTS');
 need(receipt.input_artifact_digests.includes(ga.candidate_skill_digest)&&receipt.input_artifact_digests.includes(ga.controller_digest)&&receipt.input_artifact_digests.includes(acceptedSuiteSha256),'REQUIRED_ACTUAL_INPUT_DIGESTS');
 if(temporalDescriptor)need([temporalDescriptor.continuation_controller_sha256,temporalDescriptor.amendment_ref.sha256].every(d=>receipt.input_artifact_digests.includes(d)),'EXACT_ADDITIONAL_TEMPORAL_AUTHORITY_INPUTS');
 need(Array.isArray(index.artifacts)&&index.artifacts.length<=256,'BOUNDED_ARTIFACT_INDEX');
 const artifacts=new Map();
 for(const item of index.artifacts){
  refs([{uri:item.uri,sha256:item.sha256}]);need(!artifacts.has(item.uri),'CONFLICTING_ARTIFACT_URI');
  need(typeof item.raw==='string'&&sha(item.raw)===item.sha256&&item.uri===prefix+item.sha256,'EXACT_ORIGINAL_ARTIFACT_BYTES');
  artifacts.set(item.uri,item);
 }
 const resolve=r=>{refs([r]);const found=artifacts.get(r.uri);need(found&&found.sha256===r.sha256,'UNRESOLVED_OR_CHANGED_ORIGINAL_EVIDENCE');return found;};
 const rawRefs=refs(receipt.raw_evidence_refs);for(const ref of rawRefs)resolve(ref);
 need(rawRefs.length===artifacts.size,'NO_UNDECLARED_INDEX_ARTIFACTS');
 need(Array.isArray(index.tests)&&index.tests.length===receipt.test_results.length,'EXACT_INDEX_TEST_COVERAGE');
 const tests=new Map();for(const t of index.tests){need(!tests.has(t.test_id),'DUPLICATE_INDEX_TEST');tests.set(t.test_id,t);}
 need(new Set(receipt.test_results.map(t=>t.test_id)).size===receipt.test_results.length&&same([...tests.keys()].sort(),receipt.test_results.map(t=>t.test_id).sort()),'UNIQUE_EXACT_RESULT_TEST_SET');
 const requiredSigned=[];
 for(const result of receipt.test_results){
  const def=suite.tests[result.test_id],entry=tests.get(result.test_id);
  need(def&&entry&&def.definition_version===receipt.test_revision,'ACTUAL_STATIC_TEST_REVISION');
  need(result.test_definition_digest===sha(JSON.stringify(def,null,2)+'\n'),'EXACT_TEST_DEFINITION_DIGEST');
  need(result.expected_outcome_digest===def.oracle.source_oracle_sha256&&sha(def.oracle.expected)===def.oracle.source_oracle_sha256,'EXACT_ORIGINAL_ORACLE');
  need(def.executor_artifact_ref.sha256===executorApplicability.suite_executor_sha256,'STATIC_SUITE_EXECUTOR_BINDING');
  need(receipt.fixture_refs.some(r=>r.sha256===def.fixture_artifact_ref.sha256),'STATIC_FIXTURE_BINDING');
  need(same(refSet(result.evidence_refs),refSet(entry.observation_refs))&&entry.observation_refs.length>0,'EXACT_NONEMPTY_TEST_OBSERVATIONS');
  for(const ref of entry.observation_refs){
   const original=resolve(ref),value=exact(original.raw);
   need(value.ga_id===a.ga_id&&value.ga_sha256===gaSha&&value.test_id===result.test_id,'SAME_TEST_ACTUAL_OBSERVATION');
   need(value.kind==='ACTUAL_TEST_OBSERVATION'&&realTimestamp(value.observed_at),'OBSERVATION_FORMAT');
   need(value.source&&typeof value.source==='object'&&typeof value.source.raw==='string'&&sha(value.source.raw)===value.source.sha256,'ORIGINAL_OBSERVATION_SOURCE_BYTES');
  }
  const original=resolve(entry.oracle_assessment_ref),assessment=exact(original.raw);
  need(assessment.kind==='INDEPENDENT_TEST_ORACLE_ASSESSMENT'&&assessment.ga_id===a.ga_id&&assessment.ga_sha256===gaSha&&assessment.test_id===result.test_id,'SAME_TEST_ORACLE_ASSESSMENT');
  need(assessment.test_definition_digest===result.test_definition_digest&&assessment.expected_outcome_digest===result.expected_outcome_digest&&assessment.result===result.result,'EXACT_ORACLE_ASSESSMENT_OUTCOME');
  need(same(refSet(assessment.observation_refs),refSet(entry.observation_refs)),'ORACLE_COVERS_EXACT_OBSERVATIONS');
  need(same(assessment.reviewer_ref,receipt.independent_reviewer_ref)&&!same(assessment.reviewer_ref,receipt.executor_actor_ref),'DISTINCT_REVIEWER_REFERENCE');
  need(typeof assessment.reason==='string'&&assessment.reason.trim().length>0,'INDEPENDENT_REASON_REQUIRED');
  requiredSigned.push({ref:entry.oracle_assessment_ref,raw:original.raw,required_reviewer_ref:assessment.reviewer_ref});
 }
 if(receipt.result==='PASS'){
  const all=Object.keys(suite.tests).sort();need(all.length===5&&!all.includes('PQUAL-18'),'EXACT_APPLICABLE_TEST_SET');
  need(same(receipt.test_results.map(t=>t.test_id).sort(),all)&&receipt.test_results.every(t=>t.result==='PASS'),'NO_PARTIAL_OR_FAILED_PASS');
 }
 return {state:'EXACT_RESULT_EVIDENCE_AND_ORACLE_BINDINGS_CHECKED',required_signed_assessments:requiredSigned,independent_assessment_authenticity_verified:false,actual_source_authenticity_requires_independent_assessment:true,not_final_receipt_admission:true,authority_effect:'NONE'};
}
