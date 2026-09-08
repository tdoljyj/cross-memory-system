import fs from 'node:fs';
const str={type:'string',minLength:1},digest={type:'string',pattern:'^[0-9a-f]{64}$'},date={type:'string',format:'date-time'};
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const ref=object({uri:str,sha256:digest}),refs={type:'array',items:ref},digests={type:'array',minItems:1,uniqueItems:true,items:digest};
const generation={const:'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12'};
const scope={const:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw'};
const gate=object({gate_id:{const:'G-PREENTRY-SKILL-QUALIFICATION'},definition_version:str,content_digest:digest});
const shared={schema_version:{const:'1.0'},schema_digest:digest,audience:scope,control_trust_root_generation:generation,issuer_ref:ref};
const status=object({object_type:{const:'StatusManifest'},...shared,status_manifest_id:{type:'string',pattern:'^sm_[A-Za-z0-9_-]{1,128}$'},issuer_purpose:{const:'STATUS'},
 as_of:date,expires_at:date,generation:{type:'integer',minimum:1,maximum:9007199254740991},source_digests:digests,source_refs:{...refs,minItems:1},
 observations:object({root_set_id:{const:'ctr_414bd3c724264a83894b0c55cf2ab878'},root_generation:generation,profile_digest:digest,gate_digest:digest,controller_digest:digest,scope_digest:digest,runner_generation:str,credential_generation:str,session_generation:str,stage_receipt_refs:{...refs,minItems:6,maxItems:6}}),
 signature_binding:object({owner_merge_commit:{type:'string',pattern:'^[0-9a-f]{40}$'},signed_object_sha256:digest,signature_evidence_ref:ref})});
const grr=object({object_type:{const:'GateResultReceipt'},...shared,gate_result_receipt_id:{type:'string',pattern:'^grr_[A-Za-z0-9_-]{1,128}$'},gate_authorization_id:{type:'string',pattern:'^ga_[A-Za-z0-9_-]{1,128}$'},gate_authorization_sha256:digest,gate_definition_ref:gate,
 issuer_purpose:{const:'GATE_RESULT'},result:{enum:['PASS','FAIL','BLOCKED','STALE']},decision_sha256:digest,
 test_revision:str,fixture_refs:{...refs,minItems:1},executor_ref:ref,performance_slo_revision:str,
 test_results:{type:'array',items:object({test_id:{type:'string',pattern:'^PQUAL-(0[1-9]|1[0-7]|19|20)$'},test_definition_digest:digest,expected_outcome_digest:digest,evidence_refs:{...refs,minItems:1},result:{enum:['PASS','FAIL','BLOCKED','STALE']}})},
 input_artifact_digests:digests,evidence_index_ref:ref,raw_evidence_refs:{...refs,minItems:1},actual_write_set:{type:'array',uniqueItems:true,items:str},
 started_at:date,ended_at:date,issued_at:date,expires_at:date,executor_actor_ref:ref,independent_reviewer_ref:ref,stop_evidence_ref:ref,signature:str});
for(const [name,value,comment] of [
 ['status-manifest.candidate.schema.json',status,'Original S06 L3878/L3885 StatusManifest only. Field encoding/source_refs/observations are this scoped successor proposal; generation is a real issued safe integer, never inferred from merge SHA. STATUS retains sorted canonical Owner PR merge excluding signature_binding. No authorization or PASS fields.'],
 ['gate-result-receipt.candidate.schema.json',grr,'Original S06 L3441/L3880/L3885/L3891-3894 GateResultReceipt only. Per-test object encoding, decision_sha256 and stop_evidence_ref map the existing reservation/STOP contract. Performance/SLO revision is required actual input, not fabricated N/A. One exact GA/GRR; UNKNOWN is not a result. Full raw signature includes every field.']
])fs.writeFileSync(new URL(name,import.meta.url),JSON.stringify({$schema:'http://json-schema.org/draft-07/schema#',title:name,$comment:'CANDIDATE_NOT_ACTIVATED; independent exact schema acceptance required. '+comment,...value},null,2)+'\n');
