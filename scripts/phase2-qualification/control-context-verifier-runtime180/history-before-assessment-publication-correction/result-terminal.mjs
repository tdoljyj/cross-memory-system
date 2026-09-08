// Fixed result-only port; no container effect and no caller-selected query.
import {checkResultSemantics} from './grr.mjs';
import {checkResultEvidenceStructure} from '../result-evidence-resolution/resolve.mjs';
import {sha,readBlobRef,verifyOwnerMergeArtifact,verifyDynamicPayload} from './trusted-github.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function checkAuthorizationLifetime({operation,result,issued,deadline,expires,now}){
 const nonPass=operation==='GRR'&&['FAIL','BLOCKED','STALE'].includes(result);
 need([issued,deadline,expires,now].every(Number.isFinite)&&issued<=now&&issued<deadline&&deadline<=expires&&expires-issued<=180000&&(nonPass||now<deadline),'GA_WINDOW');
 return {historical_nonpass_only:nonPass,authority_effect:'NONE'};
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
  need(found?.length===1&&found[0].raw===item.raw,'EXACT_INDEPENDENT_ASSESSMENT_BYTES');
  need(JSON.parse(item.raw).independent_reviewer===delegation.scope.independent_assessor,'ACTUAL_NAMED_INDEPENDENT_ASSESSOR');
  verifyOwnerMergeArtifact({...found[0].publication,raw:item.raw});
 }
 need(material.oracle_assessments.length===resolution.required_signed_assessments.length,'NO_UNBOUND_ASSESSMENTS');
 verifyDynamicPayload(material.grr_raw,'GateResultReceipt',receipt.expires_at);
 return receipt;
}
export function resultCommitRequest(raw,receipt){
 need(typeof raw==='string'&&JSON.stringify(receipt)+'\n'===raw,'EXACT_TERMINAL_RECEIPT_BYTES');
 need(/^[a-f0-9]{64}$/.test(receipt.decision_sha256),'EXACT_RESERVED_DECISION_DIGEST');
 return {raw,sha256:sha(raw),decision_sha256:receipt.decision_sha256};
}
