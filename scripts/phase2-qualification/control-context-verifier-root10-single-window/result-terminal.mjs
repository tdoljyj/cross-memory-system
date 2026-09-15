// Fixed result-only port; no container effect and no caller-selected query.
import {checkResultSemantics} from './grr.mjs';
import {checkRoot10ResultEvidenceStructure} from './result-evidence-root10.mjs';
import {sha,readBlobRef,verifyOwnerMergeArtifact,verifyDynamicPayload} from './trusted-github.mjs';
import {checkActualWriteTargets} from '../control-context-verifier-runtime600/write-targets.mjs';
import {verifyHistoricalObservationChain} from './historical-component-observations.mjs';
import {validatePackedDenialSource,beginOriginalInputVerification} from './original-inputs-blob.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function checkAuthorizationLifetime({operation,result,issued,deadline,expires,now}){
 const nonPass=operation==='GRR'&&['FAIL','BLOCKED','STALE'].includes(result);
 need([issued,deadline,expires,now].every(Number.isFinite)&&issued<=now&&issued<deadline&&deadline<=expires&&expires-issued<=600000&&(nonPass||now<deadline),'GA_WINDOW');
 return {historical_nonpass_only:nonPass,authority_effect:'NONE'};
}
export function checkIndependentAssessmentSource({resolved,supplied,acceptedReviewerRef,independentReviewer}){
 need(same(resolved.required_reviewer_ref,acceptedReviewerRef),'EXACT_ACCEPTED_ASSESSOR_MAPPING');
 need(same(supplied?.ref,resolved.ref)&&supplied.raw===resolved.raw&&sha(supplied.raw)===resolved.ref.sha256,'EXACT_INDEPENDENT_ASSESSMENT_BYTES');
 need(JSON.parse(supplied.raw).independent_reviewer===independentReviewer,'ACTUAL_NAMED_INDEPENDENT_ASSESSOR');
 return {state:'ASSESSMENT_BYTES_AND_ROLE_ONLY_REQUIRES_REAL_GRR_SIGNATURE',authority_effect:'NONE'};
}
export function verifyResultMaterials({material,subject,root,state,ga}){
 const accepted=subject.control_schema_refs?.GateResultReceipt;
 need(accepted&&sha(readBlobRef(accepted))===accepted.sha256,'ACCEPTED_GRR_SCHEMA_SOURCE');
 const {receipt}=checkResultSemantics({raw:material.grr_raw,gaRaw:material.ga_raw,state,acceptedSchemaSha256:accepted.sha256,temporalDescriptor:subject.temporal_continuation??null,runtimeClockDescriptor:subject.runtime_clock??null});
 const issuer=root.issuer_bindings.filter(i=>i.purpose==='GATE_RESULT');
 need(issuer.length===1&&same(receipt.issuer_ref,issuer[0].qualification_ref),'ACTUAL_ROOT_RESULT_ISSUER');
 const suite=material.gate_suite,ref=subject.gate_suite_ref;
 need(ref&&suite?.raw&&sha(suite.raw)===ref.sha256,'EXACT_RUNTIME_ACCEPTED_SUITE');
 const actualSuite=verifyOwnerMergeArtifact({...suite.publication,raw:suite.raw});
 need(same(actualSuite.blob_ref,ref),'EXACT_ACCEPTED_SUITE_SOURCE');
 const attempt=state.attempts.find(a=>a.ga_id===ga.gate_authorization_id),index=JSON.parse(attempt.decision.evidence_index_raw);
 checkPackedObservationChains(index,sha(material.ga_raw));
 for(const test of index.tests.filter(t=>['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'].includes(t.test_id))){
  const wrappers=test.observation_refs.map(r=>JSON.parse(index.artifacts.find(a=>a.uri===r.uri).raw)).map(o=>JSON.parse(o.source.raw)).filter(v=>v.kind==='HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED');
  need(wrappers.length===1&&wrappers[0].test_id===test.test_id&&wrappers[0].current_ga_id===ga.gate_authorization_id&&wrappers[0].current_ga_sha256===sha(material.ga_raw),'EXACT_THIS_GA_HISTORICAL_REVALIDATION');
  verifyHistoricalObservationChain({value:wrappers[0],subject});
 }
 const root10=subject.root10_single_window;
 need(root10&&subject.result_reviewer_ref&&same(subject.result_reviewer_ref,root10.result_reviewer?.ref)&&same(receipt.independent_reviewer_ref,subject.result_reviewer_ref),'RUNTIME_ACCEPTED_ROOT10_INDEPENDENT_REVIEWER');
 // This ref is the Root10 user-authorized identity/delegation source, not a reused historical name.
 const reviewer=material.result_reviewer;
 need(reviewer?.raw&&sha(reviewer.raw)===subject.result_reviewer_ref.sha256,'ACTUAL_REVIEWER_DELEGATION_BYTES');
 const delegation=JSON.parse(reviewer.raw);
 need(delegation.status==='GRANTED_BY_EXPLICIT_USER_INSTRUCTION'&&delegation.root_set_id===state.binding.root_id&&delegation.control_trust_root_generation===ga.control_trust_root_generation&&delegation.scope?.independent_assessor==='/root/root9_recovery_review'&&delegation.scope.environment==='ISOLATED_TEST'&&delegation.scope.purpose===ga.purpose&&delegation.scope.gate_id===ga.gate_id&&delegation.scope.maximum_ga===1&&delegation.production===false&&delegation.model_budget===0&&delegation.paid_budget===0,'EXACT_ROOT10_DELEGATED_ASSESSOR_SCOPE');
 const reviewed=verifyOwnerMergeArtifact({...reviewer.publication,raw:reviewer.raw});
 need(same(reviewed.blob_ref,subject.result_reviewer_ref),'ACTUAL_ACCEPTED_REVIEWER_SOURCE');
 const executorDescriptor=root10.executor_applicability,executorMaterial=material.result_executor_applicability;
 need(executorDescriptor&&executorMaterial?.raw&&same(executorMaterial.ref,executorDescriptor.ref)&&sha(executorMaterial.raw)===executorDescriptor.ref.sha256,'ACTUAL_ROOT10_EXECUTOR_APPLICABILITY_BYTES');
 const mapped=verifyOwnerMergeArtifact({...executorDescriptor.publication,raw:executorMaterial.raw});need(same(mapped.blob_ref,executorDescriptor.ref),'ACTUAL_ROOT10_EXECUTOR_APPLICABILITY_SOURCE');
 const executorApplicability=JSON.parse(executorMaterial.raw);
 const resolution=checkRoot10ResultEvidenceStructure({receipt,ga,state,acceptedSuiteRaw:suite.raw,acceptedSuiteSha256:ref.sha256,executorApplicability,independentReviewer:delegation.scope.independent_assessor,temporalDescriptor:subject.runtime_clock??subject.temporal_continuation??null});
 for(const item of resolution.required_signed_assessments){
  need(same(item.required_reviewer_ref,subject.result_reviewer_ref),'EXACT_ACCEPTED_ASSESSOR_MAPPING');
  const found=material.oracle_assessments?.filter(x=>same(x.ref,item.ref));
  need(found?.length===1,'EXACT_INDEPENDENT_ASSESSMENT_BYTES');
  checkIndependentAssessmentSource({resolved:item,supplied:found[0],acceptedReviewerRef:subject.result_reviewer_ref,independentReviewer:delegation.scope.independent_assessor});
  // Original Evidence, not another control object: the genuine GATE_RESULT
  // signature below commits the exact decision/index/hash chain adopting it.
 }
 need(material.oracle_assessments.length===resolution.required_signed_assessments.length,'NO_UNBOUND_ASSESSMENTS');
 verifyDynamicPayload(material.grr_raw,'GateResultReceipt',receipt.expires_at);
 const scopeInput=material.execution_scope;
 need(scopeInput?.raw&&sha(scopeInput.raw)===ga.scope_digest&&ga.scope_ref.sha256===ga.scope_digest,'ACTUAL_ACCEPTED_EXECUTION_SCOPE_BYTES');
 const scoped=verifyOwnerMergeArtifact({...scopeInput.publication,raw:scopeInput.raw});need(same(scoped.blob_ref,ga.scope_ref),'EXACT_SIGNED_SCOPE_SOURCE');
 checkActualWriteTargets({receipt,ga,state,scope:JSON.parse(scopeInput.raw)});
 return receipt;
}
export function resultCommitRequest(raw,receipt){
 need(typeof raw==='string'&&JSON.stringify(receipt)+'\n'===raw,'EXACT_TERMINAL_RECEIPT_BYTES');
 need(/^[a-f0-9]{64}$/.test(receipt.decision_sha256),'EXACT_RESERVED_DECISION_DIGEST');
 return {raw,sha256:sha(raw),decision_sha256:receipt.decision_sha256};
}

export function checkPackedObservationChains(index,gaSha){
 const packed=index.artifacts.map(a=>({raw:a.raw,value:JSON.parse(a.raw)})).filter(a=>['EXACT_ORIGINAL_VERIFIER_INPUTS_DEFLATE_V1','EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V1','EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V2_2MIB','EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V3_3000000','EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V4_3200000','EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V6_4000000'].includes(a.value.kind));
 const verificationSession=beginOriginalInputVerification();
 let checked=0;
 for(const test of index.tests)for(const ref of test.observation_refs){
  const matches=index.artifacts.filter(a=>a.uri===ref.uri&&a.sha256===ref.sha256);need(matches.length===1,'EXACT_INDEX_OBSERVATION_SOURCE');
  const original=JSON.parse(matches[0].raw),source=JSON.parse(original.source.raw);
  if(source.kind!=='ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION')continue;
  need(source.test_id===test.test_id&&source.baseline_ga_sha256===gaSha,'EXACT_THIS_TEST_GA_DENIAL_BASELINE');
  const inputs=packed.filter(a=>same(a.value.original_ref,source.original_inputs_ref));need(inputs.length===1,'ONE_EXACT_SHARED_PACKED_ORIGINAL');
  const result=validatePackedDenialSource({packedRaw:inputs[0].raw,sourceRaw:original.source.raw,verificationSession});
  need(result.test_id===test.test_id&&result.state==='ORIGINAL_MEASURED_INPUT_BYTES_RESTORED','ACTUAL_PACKED_CHAIN_RECONSTRUCTED');checked++;
 }
 return {state:'PACKED_DENIAL_ORIGINAL_CHAINS_CHECKED',checked,authority_effect:'NONE'};
}
