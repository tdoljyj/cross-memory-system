// Writes review inputs only. No network, database, Root registration or Gate issuance.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {canonicalDigest,reviewSubjectDigest} from '../protocol-successor/validate-successor.mjs';
const repo=new URL('../../../../',import.meta.url),here=new URL('./',import.meta.url);
const base='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/';
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
function source(path,expected){const raw=fs.readFileSync(new URL(path,repo));assert.equal(sha(raw),expected,path+' exact bytes');const blob=crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');return {path,sha256:expected,git_blob:blob,ref:{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob,sha256:expected}};}
const sources={
 owner:source(base+'ControlRootRegistrationOwnerApproval.json','3d9c4c9e06217c7c2ef0d32dba77bb5aa66bd745a8f92f0ea255b19a95127aea'),
 identity:source(base+'IndependentControlRootOwnerSignatureBinding.json','78c1cea433053edb9233976615f4f22f43f318078eed0f505b48d641a5f6aae9'),
 protocol_acceptance:source(base+'ProtocolSuccessorIndependentReview.json','988cdf823eb63806dc3385aa1840e812c1cb1df5ed06e72ca2adf56244b88d20'),
 store_acceptance:source(base+'NonproductionControlStoreIndependentReview.json','4c05a0ffcba4724aa36ea4a41003176e33dd140b73b370ee477fee4c5b5e4350'),
 store_deployment:source(base+'NonproductionControlStoreDeploymentSuccessor.json','58643a21e69cda0e06dbc70fc71724f75cd6bca930e17e6723287228e12daa99'),
 schema:source('protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json','87f094fa079034aa886d6c568730370a3264e106529b4bfd79bc3369f30b79e5'),
 manifest:source('protocol/continuity/v1/manifest.json','d13b17d873004e97fe45400d715b5becef8fa6bb0a004011921344bd0c9441ec'),
 mapping:source('scripts/phase2-qualification/nonproduction-control-store/protocol-successor/ControlUriMapping.json',sha(fs.readFileSync(new URL('../protocol-successor/ControlUriMapping.json',import.meta.url))))
};
assert.equal(canonicalDigest(JSON.parse(fs.readFileSync(new URL(sources.mapping.path,repo),'utf8'))),canonicalDigest(JSON.parse(fs.readFileSync(new URL(sources.manifest.path,repo),'utf8')).control_uri_templates.ControlTrustRootSet),'Mapping exact applied manifest object');
const observed=JSON.parse(fs.readFileSync(new URL('SourceReadback.json',here),'utf8'));
assert.deepEqual(observed.observation.control_counts,{events:0,current_head:0,accepted_binding:0});
const rootId='ctr_414bd3c724264a83894b0c55cf2ab878',generation='ctrgen_352785779b64458a889d571360e2d2d5';
const audience='urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw';
const rootUri='urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:'+rootId;
const observedAt=observed.observation.observed_at_utc.replace('+00:00','Z');
const expiry='2026-09-09T09:28:59Z';
const subject={schema_version:'1.0',object_type:'ControlTrustRootSet',root_set_id:rootId,control_trust_root_generation:generation,
 generation_ordinal:1,predecessor:null,purpose:'SKILL_COEXISTENCE_QUALIFICATION',
 scope:{project_ref:'uscrdifznmlvczcekqpw',repository:'tdoljyj/cross-memory-system',profile_id:'DP-PREENTRY-SKILL-QUALIFICATION',environment:'ISOLATED_TEST',model_budget:0,paid_budget:0},
 issuer_bindings:['STATUS','GATE_AUTHORIZATION','GATE_RESULT'].map(purpose=>({subject_id:'tdoljyj',signing_service:'web-flow',purpose,audience,qualification_ref:sources.identity.ref})),
 audience,schema_digest:sources.schema.sha256,
 algorithm_config:{canonicalization_id:'SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE',digest_algorithm:'SHA-256',signed_payload_excluded_fields:['signature_binding'],signature_verification:'GITHUB_API_VERIFIED_OWNER_MERGE',accepted_config_ref:sources.protocol_acceptance.ref},
 not_before:observedAt,expires_at:expiry,
 history:{index_uri:rootUri+'#history',prefix_digest:canonicalDigest([]),prefix_sequence:0,minimum_accepted_generation:generation},
 revocation:{events_uri:rootUri+'#revocations',event_set_digest:canonicalDigest([]),as_of:observedAt,expires_at:expiry},
 owner_approval_ref:sources.owner.ref,status:'REGISTERED'};
const subjectDigest=reviewSubjectDigest(subject);
function write(name,value){fs.writeFileSync(new URL(name,here),JSON.stringify(value,null,2)+'\n','utf8');}
write('RootReviewSubject.json',{state:'UNISSUED_FIRST_ROOT_REVIEW_SUBJECT',intended_registration_status:'REGISTERED_ONLY_AFTER_ACTUAL_ACCEPTANCE_SIGNATURE_AND_DB_APPEND',review_subject_sha256:subjectDigest,subject,
 admission_boundary:{identity_ref_contribution:'Actual Owner/signing identity and approved limited purpose source only; not GA/GRR issuer qualification by itself',required_independent_decision:'Must explicitly accept each proposed purpose/Audience/algorithm and this exact review_subject_sha256; no active GA capability follows',independent_acceptance_ref_excluded_from_subject:true,signature_binding_excluded_from_subject:true,profile_business_vector_obligations:'UNCHANGED_NOT_APPLICABLE_TO_ROOTSET_OBJECT_NO_NA_SUBSTITUTION'}});
write('AcceptedBindingInputs.json',{state:'EXACT_KNOWN_VALUES_PENDING_TWO_ACTUAL_POST_REVIEW_BINDINGS',known_values:{root_id:rootId,project_ref:'uscrdifznmlvczcekqpw',purpose:subject.purpose,environment:subject.scope.environment,subject_sha256:'e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f',owner_approval_commit:'4d7f93c17cf7d126e771cf8aca6299c868cba0a9',not_before:observedAt,expires_at:expiry,issuer:'tdoljyj',audience,algorithm_config:'SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE;SHA-256;GITHUB_API_VERIFIED_OWNER_MERGE',schema_sha256:sources.schema.sha256,store_acceptance_sha256:sources.store_acceptance.sha256,protocol_mapping_sha256:sources.mapping.sha256},
 required_actual_future_values:['registration_acceptance_sha256','signature_evidence_sha256'],
 subject_digest_distinction:{accepted_binding_subject_sha256:'Original independently accepted limited registration subject e4ab... fixed by deployed SQL; unchanged',first_root_payload_review_subject_sha256:subjectDigest},
 activation_preconditions:['Exact independent Root/purpose/Audience/config acceptance','Actual new GitHub Owner signature covers final signature payload; PR25 does not sign it','Fresh read confirms same empty prefix/current unrevoked Owner/window','Insert config and first generation event in one transaction; rollback if either fails'],authority_effect:'NONE'});
write('SourceBindings.json',{state:'SOURCE_BYTES_BOUND_NO_ISSUANCE',sources,review_subject_sha256:subjectDigest,
 reference_resolution:'Git blob URIs are exact content identities; local accepted artifacts not yet persisted remotely must be published and actually read before registration. This preparation does not assert remote availability.',
 time_selection:'not_before/as_of are actual PostgreSQL observation time; expiry inherits original actual Owner deadline. Re-read immediately before the side effect.',
 empty_prefix:'Observed count zero in newly deployed immutable Store gives actual empty prefix, not an invented epoch or history.',
 signature_boundary:'No signature bytes or claimed signature for the new Root payload are created.'});
console.log(JSON.stringify({state:'REVIEW_INPUTS_PREPARED_NOT_ISSUED',review_subject_sha256:subjectDigest,source_count:Object.keys(sources).length}));
