// Deterministic local preparation only. No signing, API, registration or runtime.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {canonicalDigest,reviewSubjectDigest} from '../../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const repo=new URL('../../../../',import.meta.url),here=new URL('./',import.meta.url);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const read=path=>fs.readFileSync(new URL(path,repo));
const parse=path=>JSON.parse(read(path));
const write=(name,value)=>fs.writeFileSync(new URL(name,here),JSON.stringify(value,null,2)+'\n');
const ref=(raw)=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob(raw),sha256:sha(raw)});
const oldPath='scripts/phase2-qualification/preentry-parent/ProfileApplicabilityCandidate.json';
const oldRaw=read(oldPath),old=JSON.parse(oldRaw);
assert.equal(sha(oldRaw),'215fc1d0c6327cef514879faa60dad9cf4e727ec207d867e4fe2eb8f3c7d7f89');
const dir='scripts/phase2-qualification/contract-candidates/';
const profileSchema=parse(dir+'preentry-profile.candidate.schema.json');
assert.equal(sha(read(dir+'preentry-profile.candidate.schema.json')),'bad887a19c0c9f4f3ebcbc2ef38912869adc432ba7599bae63745b2ca48f4ee1');
for(const field of ['gate_refs','gate_definition_set_digest']){
 profileSchema.required=profileSchema.required.filter(x=>x!==field);delete profileSchema.properties[field];
}
profileSchema.$comment='Exact proposed DP-PREENTRY execution Profile successor. S06 L3435 Release Profile composition does not apply: gate_refs/set digest removed, not waived for actual GateAuthorization. Four-layer N/A only for exact fixed synthetic Skill-input scope accepted with this definition; external verified acceptance/current authority remains required.';
const vectorSchema=parse(dir+'revocation-epoch-vector.candidate.schema.json');
vectorSchema.$comment='Proposed exact fixed-synthetic-input Vector specialization under S06 L3010-3012. No business account/installation/context/binding exists in this accepted-scope proposal. Not general ISOLATED_TEST permission. All independent control/runner/credential/session generations remain applicable. Requires actual independent Schema/Profile acceptance before use.';
vectorSchema.properties.vector_schema_version={const:'clued.fixed-synthetic-skill-input/1'};
const profile=structuredClone(old.proposed_profile_fields);
delete profile.gate_refs;delete profile.gate_definition_set_digest;
profile.definition_version='fixed-synthetic-skill-input-20260908.v1';
for(const layer of ['account','integration_installation','context','binding']){
 const reason=profile.not_applicable_layer_permissions[layer].reason;
 vectorSchema.properties[layer+'_scope_ref']={const:'not_applicable'};
 vectorSchema.properties[layer+'_epoch']={const:'not_applicable'};
 vectorSchema.properties.not_applicable_evidence.properties[layer].properties.reason={const:reason};
 profileSchema.properties.not_applicable_layer_permissions.properties[layer].properties.reason={const:reason};
}
profileSchema.properties.not_applicable_layer_permissions.required=['account','integration_installation','context','binding'];
profileSchema.required.push('not_applicable_layer_permissions');
profileSchema.properties.definition_version={const:profile.definition_version};
profileSchema.properties.max_lifetime_seconds={const:90};
write('revocation-epoch-vector.candidate.schema.json',vectorSchema);
const vectorRaw=fs.readFileSync(new URL('revocation-epoch-vector.candidate.schema.json',here));
for(const permission of Object.values(profile.not_applicable_layer_permissions))permission.accepted_schema_ref=ref(vectorRaw);
write('preentry-profile.candidate.schema.json',profileSchema);
// GA contract is unchanged and retained separately: no Gate ID/version/digest obligation removed.
fs.writeFileSync(new URL('gate-authorization.candidate.schema.json',here),read(dir+'gate-authorization.candidate.schema.json'));
write('ProfileDefinition.json',profile);
const schemas={};
for(const name of ['preentry-profile.candidate.schema.json','revocation-epoch-vector.candidate.schema.json','gate-authorization.candidate.schema.json'])schemas[name]=ref(fs.readFileSync(new URL(name,here)));
const root='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/';
const sources={};
for(const name of ['R09MechanismCandidate.json','R09IndependentFreezeDecision.json','IndependentR07R09SignatureBinding.json','R10IndependentProjectionAcceptance.json','IndependentR10SignatureBinding.json','FixedFixturePrimitiveIndependentReview.json'])sources[name]=ref(read(root+name));
const mechanism=parse(root+'R09MechanismCandidate.json');
assert.deepEqual(mechanism.mechanism_boundaries.map(x=>x.id),['B01','B02','B03','B04','B05','B06']);
const subject={profile_definition:profile,schema_refs:schemas,source_refs:sources,
 mechanism_boundaries:mechanism.mechanism_boundaries,
 mechanism_boundary_type:'Existing B01-B06 mechanism definitions, NOT Gate IDs or new Gate registry entries',
 fixed_input_ref:{source_ref:ref(oldRaw),json_pointer:'/fixed_input'},
 retained_current_checks:old.retained_current_checks,
 applicability:{source:'S06',sha256:old.source_rule.sha256,lines:[3010,3011,3012,3435,3437,3439,3441],
  profile_type:'QualificationPhasePolicy PRE_ENTRY_SKILL_QUALIFICATION execution Profile; not Release Profile',
  actual_ga_atomic_gate_definition_still_required:true,
  na_permissions_apply_only_to_fixed_input:true},
 deadline:'2026-09-09T09:28:59Z',
 execution_boundary:'Definition/Schema acceptance and signing only. No GA/controller qualification/PQUAL execution; no model/production/paid scope.'};
write('ProfileReviewSubject.json',{state:'EXACT_PROFILE_SCHEMA_SUBJECT_READY_FOR_INDEPENDENT_REVIEW',review_subject_sha256:reviewSubjectDigest(subject),subject});
write('PreparationEvidence.json',{state:'READY_FOR_REVIEW_NOT_SIGNED',review_subject_sha256:reviewSubjectDigest(subject),
 predecessor:{path:oldPath,sha256:sha(oldRaw)},
 reference_boundary:'Computed exact Git blob references bind prepared bytes; new blobs must be published/read back and independently accepted before accepted_schema_ref can be relied upon. No claim of current remote existence from local hashing.',
 signature_payload_rule:'Reuse existing canonicalDigest/reviewSubjectDigest: omit independent_acceptance_ref and signature_binding only from review digest; actual signing payload includes independent acceptance and excludes only signature_binding. No signature placeholder is emitted.',
 files:['build.mjs','ProfileDefinition.json','ProfileReviewSubject.json',...Object.keys(schemas)].map(path=>{const raw=fs.readFileSync(new URL(path,here));return {path,sha256:sha(raw),bytes:raw.length};}),
 review_function_source:'scripts/phase2-qualification/nonproduction-control-store/protocol-successor/validate-successor.mjs',
 review_function_source_sha256:sha(read('scripts/phase2-qualification/nonproduction-control-store/protocol-successor/validate-successor.mjs')),
 signature_created:false,profile_accepted:false,controller_qualified:false,live_actions:0});
console.log(JSON.stringify({review_subject_sha256:canonicalDigest(subject),files:'prepared locally only'}));
