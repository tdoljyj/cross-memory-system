// Non-issuing assembly only. No database, network, signatures or runtime actions.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../../apps/clued-cloud/package.json',import.meta.url));
const Ajv=require('ajv');
const base=new URL('../../',import.meta.url),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=relative=>{const bytes=fs.readFileSync(new URL(relative,base));return {relative,sha256:sha(bytes),bytes:bytes.length,value:JSON.parse(bytes)};};
const schema=read('preentry-parent/profile-successor/gate-authorization.candidate.schema.json');
const profile=read('preentry-parent/profile-runtime600/ProfileDefinition.json');
const vector=read('preentry-parent/profile-successor/revocation-epoch-vector.candidate.schema.json');
const ajv=new Ajv({allErrors:true,strictKeywords:true,format:'full'});
ajv.addSchema(vector.value,'revocation-epoch-vector.candidate.schema.json');
const validators=Object.fromEntries(Object.entries(schema.value.properties).map(([field,definition])=>[field,ajv.compile(definition)]));
const rootPayload=read('nonproduction-control-store/generation2/RootSigningPayload.json');
const profilePayload=read('preentry-parent/profile-runtime600/signing/ProfileSigningPayload.json');
const stages=read('RuntimeMaterialPreparation/StageSourceMapping.json');
for(const item of stages.value.stages){
 const bytes=fs.readFileSync(new URL('../../'+item.path,base));
 if(sha(bytes)!==item.sha256)throw Error('Exact historical stage bytes changed: '+item.stage);
}
export const dynamicFields=['gate_authorization_id','authorization_status','issued_at','expires_at','deadline','idempotency_key','signature','runner_generation','credential_generation','session_generation'];
const descriptions={
 gate_id:['Registered exact Gate definition and accepted forward input binding','preentry-parent/gate-successor/GateDefinitionCandidate.json; current 600/controller Gate successor from agent3'],
 profile_ref:['Actual signed Profile600 definition plus its exact independent acceptance reference','preentry-parent/profile-runtime600/ProfileDefinition.json; bootstrap/FixedSyntheticProfile600IndependentAcceptance.json; actual publication proof'],
 purpose:['Existing qualification purpose','QualificationPhasePolicy.json / approved Profile'],
 environment:['Existing isolated environment scope','approved Profile allowed_environments'],
 repository_ref:['Exact fixed private repository identity source; URI and digest must describe the same declared object','tdoljyj/cross-memory-system; actual signed repository/host scope metadata, not a fabricated URL digest'],
 source_ref:['Actual final publication commit, tree and every referenced immutable source blob','Final complete SourceManifest and actual GitHub publication readback; do not insert a future commit'],
 artifact_refs:['Precise Gate/fixture/Skill/controller artifacts consumed by this accepted runtime','Final accepted Gate/Test input successor and closed SourceManifest; include actual Gate definition digest'],
 host_runtime_config_digest:['Complete accepted fixed host configuration bytes including exact executables/image/limits/entry source closure','PythonImageBinding.json; Profile600 FixedInputScope; final host/controller SourceManifest'],
 upstream_gate_result_receipt_refs:['Only actual applicable upstream original GRRs; empty requires explicit no-upstream applicability decision','Original Gate definition/prerequisites; no stage engineering decision relabeled as GRR'],
 status_manifest_ref:['Complete original StatusManifest raw digest and original typed URI from same-domain immutable store','control://status-manifests/sm_<actual-id>; full original STATUS Owner-merge proof; control_objects actual readback'],
 release_risk_manifest_digest:['Actual applicable risk manifest or accepted exact applicability successor','Original S06 GA field. No current dedicated accepted manifest located; do not substitute Profile/schema digest'],
 actor_ref:['Actual control actor identity and its scoped delegation provenance','OwnerDelegation_20260908.json + actual Owner signature; Root issuer tdoljyj/web-flow; exact role mapping needed'],
 subject_ref:['Exact quarantined prospective unified Clued three-file subject','R10IndependentProjectionAcceptance.json /subject/files; final accepted Skill input manifest'],
 binding_ref:['Exact accepted runtime binding metadata; never a nonexistent business Binding','Same-domain execution_binding immutable accepted metadata and final subject; actual reference encoding must be accepted'],
 scope_ref:['Complete accepted run read/write/deny and applicable control scope, not the old parent alone','Profile600 + final closed executor + Gate/Test manifest input successor'],
 issuer_ref:['Actual current Root2 GATE_AUTHORIZATION issuer qualification_ref','Real read_root current generation body issuer_bindings, then exact remote immutable metadata resolution'],
 authority_source_ref:['Actual current complete RootSet canonical digest and existing RootSet URI','Fresh private read_root; original accepted Root canonicalDigest algorithm; never main HEAD or local control.json'],
 audience:['Exact existing audience','Root/Profile fixed nonproduction project audience'],
 issuer_purpose:['Distinct original GA issuing purpose','Root2 GATE_AUTHORIZATION purpose qualification'],
 schema_digest:['Exact accepted full original-field GA schema bytes','preentry-parent/profile-successor/gate-authorization.candidate.schema.json'],
 control_trust_root_generation:['Actual independently verified and registered Root2 generation','Root current live store; fixed candidate value still requires fresh live confirmation'],
 allowed_read_set:['Actual accepted child and supervising host read allowlist','Final accepted Gate/Profile full scope; old child /driver-only list cannot omit control-plane evidence reads'],
 allowed_write_set:['Actual accepted synthetic and control-evidence write allowlist','Final accepted Gate/Profile scope, exact single same-domain event paths and per-attempt synthetic directory'],
 forbidden_actions:['Exact accepted prohibitions','Owner scope + Profile required_false + Gate deny boundary; no model, production, arbitrary command or PQUAL18 positive'],
 credential_scope:['Accepted actual credential boundary, including trusted parent channels and no child credentials','Profile four-layer N/A + fixed host environment + trusted Supabase/GitHub tool caller; not business credential issuance'],
 stop_policy_digest:['Exact accepted deadline/STOP/UNKNOWN policy object','host430445 watchdog reserve30/START6 + accepted parent-loss actual evidence + supervisor fixed UNKNOWN policy'],
 rollback_point_ref:['Actual recoverable pre-action state/reference','Empty new attempt plus existing immutable Intent/idempotency and container reconciliation; no invented checkpoint'],
 budget_reservation_ref:['Actual pre-GA independent budget allocation/reservation object and reference','Owner7200sec/1GiB + current conservative charged history. reserve_gate contains complete GA, so cannot self-reference its raw digest from GA'],
 evidence_sink_ref:['Exact existing same-domain immutable event sink binding','Accepted/deployed control-objects successor SQL, execution_events exact raw/sha/readback. Local fsync and Git history are not current authority'],
 controller_digest:['Digest of complete accepted executable source closure, not only matching caller/SQL fields','Agent3 final SourceManifest excludes itself and acceptance metadata; every entry checked before process start'],
 controller_qualification_ref:['Actual independent scoped controller qualification record after its required engineering checks','Final independent reviewer decision and actual signed publication; no fabricated ACCEPTED or Receipt'],
 candidate_skill_digest:['Digest of the exact accepted three-file Skill subject under explicit accepted byte-set algorithm','R10 subject/files + final Skill input manifest. fixed_skill_fixture.py is not the Skill digest'],
 mechanism_digest:['Exact currently accepted R09 mechanism definition','bootstrap/R09MechanismCandidate.json ac7d4a13… and signed R09 independent freeze'],
 plan_digest:['Exact accepted fixed applicable PQUAL execution plan','TestControllerQualificationPlan.json plus final TestManifest/driver scope successor; not an old model-only harness'],
 fixtures_digest:['Exact accepted synthetic fixture set and oracle inputs','FixedFixturePreparation + final TestManifest fixture bindings; no private Gold access before Entry'],
 stage_receipt_refs:['Six actual R05–R10 prerequisite source references with accepted type/applicability mapping','Agent3 exact R05–R10 signed source mapping; do not label engineering acceptance as an absent Kernel wire receipt'],
 target_revision:['Actual fixed final target revision used by accepted Gate/Test/controller inputs','Actual final source publication; no speculative commit or mutable main name'],
 revocation_epoch_vector:['Exact accepted business-layer N/A reasons/schema; preserves independent applicable control generations','Profile600 not_applicable_layer_permissions and accepted vector schema'],
 scope_digest:['Digest of same complete accepted scope object as scope_ref','Must equal scope_ref.sha256 and actual immutable binding; no arbitrary hash substitution'],
 profile_digest:['Exact independently accepted Profile600 bytes','preentry-parent/profile-runtime600/ProfileDefinition.json'],
 dominant_role:['Actually accepted dominant control role for this fixed operation','QualificationPhasePolicy identity_binding_fields; final actor/subject scope mapping, not assumed Owner identity role']
};
const known={gate_id:'G-PREENTRY-SKILL-QUALIFICATION',purpose:profile.value.purpose,
 environment:'ISOLATED_TEST',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',
 issuer_purpose:'GATE_AUTHORIZATION',schema_digest:schema.sha256,
 control_trust_root_generation:'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12',
 profile_digest:profile.sha256,mechanism_digest:'ac7d4a13c069dddd7acd8fa5258052e61e28108844701e5988c0d5105470f70f'};
const revocation={vector_schema_version:vector.value.properties.vector_schema_version.const,
 not_applicable_evidence:profile.value.not_applicable_layer_permissions};
for(const field of vector.value.required)if(field!=='vector_schema_version')revocation[field]=vector.value.properties[field].const;
known.revocation_epoch_vector=revocation;
known.profile_ref={profile_id:profile.value.profile_id,definition_version:profile.value.definition_version,
 content_digest:profile.sha256,accepted_ref:profilePayload.value.independent_acceptance_ref};
known.issuer_ref=rootPayload.value.issuer_bindings.find(x=>x.purpose==='GATE_AUTHORIZATION').qualification_ref;
known.stage_receipt_refs=stages.value.stages.map(x=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+x.blob,sha256:x.sha256}));

export function assemble(supplied={}){
 if(!supplied||typeof supplied!=='object'||Array.isArray(supplied))throw Error('Explicit assembly bindings required');
 const fields=schema.value.required.filter(x=>!dynamicFields.includes(x));
 if(Object.keys(descriptions).sort().join()!==fields.toSorted().join())throw Error('GA required fields changed: explicit source mapping must be updated');
 for(const field of Object.keys(supplied))if(!fields.includes(field)||Object.hasOwn(known,field))throw Error('Unknown, dynamic, or fixed field cannot be overridden: '+field);
 const values={},mapping=[];
 for(const field of fields){
  let value=null,state='REQUIRES_EXACT_SOURCE_AND_INDEPENDENT_BINDING',provenance=null;
  if(Object.hasOwn(known,field)){value=structuredClone(known[field]);state='EXACT_EXISTING_DEFINITION_VALUE_REQUIRES_FINAL_CURRENT_BINDING';}
  else if(Object.hasOwn(supplied,field)){
   const item=supplied[field];
   if(!item||typeof item!=='object'||Object.keys(item).sort().join()!=='provenance,value'
    ||!item.provenance||typeof item.provenance.source!=='string'||!item.provenance.source.trim()
    ||typeof item.provenance.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.provenance.sha256)||item.value===null)
    throw Error('Exact source provenance required for '+field);
   value=structuredClone(item.value);provenance=structuredClone(item.provenance);state='SUPPLIED_PREPARATION_NOT_INDEPENDENTLY_VERIFIED';
  }
  if(value!==null&&!validators[field](value))throw Error('Original GA field encoding rejected: '+field);
  values[field]=value;mapping.push({field,state,source_requirement:descriptions[field][0],existing_location_or_minimum_input:descriptions[field][1],supplied_provenance:provenance});
 }
 return {state:'NON_ISSUING_RUNTIME_MATERIAL_PREPARATION',authority_effect:'NONE',
  executable:false,accepted:false,signature_issued:false,ga_issued:false,
  definition_sources:[schema,profile,vector,rootPayload,profilePayload,stages].map(({relative,sha256,bytes})=>({relative,sha256,bytes})),
  expected_ga:values,dynamic_fields_deliberately_absent:dynamicFields,
  unresolved_fields:fields.filter(f=>values[f]===null),field_source_map:mapping,
  final_review_required_even_if_all_fields_supplied:true};
}
