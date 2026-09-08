// Fixed result-only port; no container effect and no caller-selected query.
import {checkResultSemantics} from '../control-context-verifier-runtime600/grr.mjs';
import {checkResultEvidenceStructure} from '../result-evidence-resolution/resolve.mjs';
import {sha,readBlobRef,verifyOwnerMergeArtifact,verifyDynamicPayload} from '../control-context-verifier-runtime600/trusted-github.mjs';
import {checkActualWriteTargets} from '../control-context-verifier-runtime600/write-targets.mjs';
import {verifyHistoricalObservationChain} from '../control-context-verifier-runtime600/historical-component-observations.mjs';
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
 const {receipt}=checkResultSemantics({raw:material.grr_raw,gaRaw:material.ga_raw,state,acceptedSchemaSha256:accepted.sha256});
 const issuer=root.issuer_bindings.filter(i=>i.purpose==='GATE_RESULT');
 need(issuer.length===1&&same(receipt.issuer_ref,issuer[0].qualification_ref),'ACTUAL_ROOT_RESULT_ISSUER');
 const suite=material.gate_suite,ref=subject.gate_suite_ref;
 need(ref&&suite?.raw&&sha(suite.raw)===ref.sha256,'EXACT_RUNTIME_ACCEPTED_SUITE');
 const actualSuite=verifyOwnerMergeArtifact({...suite.publication,raw:suite.raw});
 need(same(actualSuite.blob_ref,ref),'EXACT_ACCEPTED_SUITE_SOURCE');
 const resolution=checkResultEvidenceStructure({receipt,ga,state,acceptedSuiteRaw:suite.raw,acceptedSuiteSha256:ref.sha256});
 const attempt=state.attempts.find(a=>a.ga_id===ga.gate_authorization_id),index=JSON.parse(attempt.decision.evidence_index_raw);
 checkPackedObservationChains(index,sha(material.ga_raw));
 for(const test of index.tests.filter(t=>['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'].includes(t.test_id))){
  const wrappers=test.observation_refs.map(r=>JSON.parse(index.artifacts.find(a=>a.uri===r.uri).raw)).map(o=>JSON.parse(o.source.raw)).filter(v=>v.kind==='HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED');
  need(wrappers.length===1&&wrappers[0].test_id===test.test_id&&wrappers[0].current_ga_id===ga.gate_authorization_id&&wrappers[0].current_ga_sha256===sha(material.ga_raw),'EXACT_THIS_GA_HISTORICAL_REVALIDATION');
  verifyHistoricalObservationChain({value:wrappers[0],subject});
 }
 need(subject.result_reviewer_ref&&same(receipt.independent_reviewer_ref,subject.result_reviewer_ref),'RUNTIME_ACCEPTED_INDEPENDENT_REVIEWER');
 // This ref is an actual accepted identity/delegation source, not the reviewer's name alone.
 const reviewer=material.result_reviewer;
 need(same(subject.result_reviewer_ref,{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/e7f738ae3c247e41733872ab95387440205c736a',sha256:'e09ef634712ce1206600402552073bae91e7296f2b4e2d3f99855bd760c944bd'}),'EXACT_EXISTING_OWNER_DELEGATION');
 need(reviewer?.raw&&sha(reviewer.raw)===subject.result_reviewer_ref.sha256,'ACTUAL_REVIEWER_DELEGATION_BYTES');
 const delegation=JSON.parse(reviewer.raw);
 need(delegation.status==='GRANTED_BY_EXPLICIT_USER_INSTRUCTION'&&delegation.scope?.independent_assessor==='/root/project_list_auth_fix'&&delegation.scope.environment==='ISOLATED_TEST'&&delegation.scope.purpose===ga.purpose,'EXACT_DELEGATED_ASSESSOR_SCOPE');
 const reviewed=verifyOwnerMergeArtifact({...reviewer.publication,raw:reviewer.raw});
 need(same(reviewed.blob_ref,subject.result_reviewer_ref),'ACTUAL_ACCEPTED_REVIEWER_SOURCE');
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
 const packed=index.artifacts.map(a=>({raw:a.raw,value:JSON.parse(a.raw)})).filter(a=>['EXACT_ORIGINAL_VERIFIER_INPUTS_DEFLATE_V1','EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V1'].includes(a.value.kind));
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
