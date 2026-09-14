#!/usr/bin/env node
// Offline deterministic verifier. It has no network, database, gate or dispatch path.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const repo=path.resolve(arg('--repo-root')??path.resolve(HERE,'../../..'));
const stage='work/recovery-root9/postbudget-cas-p3';
const at=p=>path.join(repo,p);
const read=p=>fs.readFileSync(at(p));
const json=p=>JSON.parse(read(p));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
const eq=(a,b,m)=>assert.deepEqual(a,b,m);
function canonical(v){
  if(typeof v==='number')need(Number.isSafeInteger(v),'UNSAFE_NUMBER');
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const digest=v=>sha(Buffer.from(canonical(v)+'\n'));

const C={
  root9:'ctrgen_308a1dfc185cff633892638581e0a34c',
  controller:'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  dynamic:'e067177cefb9311b4bce88242661bf6109f0ad78e75ae69b156adc1a8b3c9002',
  qualification:'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013',
  acceptance:'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552',
  statusRaw:'9701fd4512797f4a90b96a59e06f438422e84f8eb03038fd3ae947ec46fd5c95',
  statusS:'c3fd1848edbd0b186cb0ba259cb3e8d739bcb3f0dac25754985133de68813a06',
  ga:'998e92f41cbe8a04d7205606a0ca883e06a8fdf663457e35b4dc370b9e0ed322',
  budget:'51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a',
  p2Evidence:'dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887',
  statusSignature:'54a8dfdeb553266ddc83842d523869ab65488d73f2356645a87a3a3ce26664e4',
  statusFull:'186879980141db38eb14bd9ee5ced915c9ab37f91d290e822addd22288c5e485'
};
const P={
  evidence:`${stage}/P2PublicationEvidence.verified.json`,
  cas:`${stage}/postbudget_root9_cas.template.sql`,
  preflight:`${stage}/preflight_readonly.sql`,
  readback:`${stage}/readback_readonly.template.sql`,
  verifier:`${stage}/verify-stage-p3.mjs`,
  gatePreimage:`${stage}/reserve_gate.preimage.utf8.base64`,
  gateFragment:`${stage}/reserve_gate.seq102-inheritance.fragment.sql`,
  gateFull:`${stage}/reserve_gate.seq102-inheritance.full.template.sql`,
  gateWrapper:`${stage}/reserve_gate.seq102-inheritance.cas-wrapper.template.sql`,
  gateBuilder:`${stage}/build-full-reserve-gate.mjs`,
  gateVerifier:`${stage}/verify-full-reserve-gate.mjs`,
  gateBranchVerifier:`${stage}/verify-seq102-inheritance.mjs`,
  gateCatalogPreflight:`${stage}/reserve_gate.preflight-catalog-token.readonly.sql`,
  gateQualificationFixture:`${stage}/fixture.ControllerQualification.root9.postbudget.candidate.json`,
  gateAcceptanceFixture:`${stage}/fixture.RuntimeAcceptance.root9.postbudget.json`,
  signature:`${stage}/Status27SignatureEvidence.json`,
  statusFull:`${stage}/Status27Generation.json`,
  p3:`${stage}/P3PublicationEvidence.template.json`,
  review:`${stage}/IndependentReview.NO_AUTHORITY.template.json`,
  q:'work/recovery-root9/postbudget-stage2/ControllerQualification.root9.postbudget.candidate.json',
  acc:'work/recovery-root9/postbudget-stage2/RuntimeAcceptance.root9.postbudget.json',
  status:'work/recovery-root9/postbudget-stage2/Status27SigningPayload.json',
  ga:'work/ga-readiness/build-ga.mjs',
  manifest:'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/ControllerSourceManifest.candidate.json',
  dynamic:'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/dynamic-signing.mjs'
};

assert.equal(sha(read(P.evidence)),C.p2Evidence,'P2_EVIDENCE_BYTES');
const e=json(P.evidence),m=e.merge;
eq({state:e.state,repository:e.repository,pull_request:e.pull_request},
   {state:'VERIFIED_POSTBUDGET_STAGE2_OWNER_MERGE',repository:'tdoljyj/cross-memory-system',pull_request:177},'P2_HEADER');
eq({sha:m.sha,tree:m.tree,parents:m.parents,first_parent:m.first_parent,source_parent:m.source_parent,source_tree:m.source_tree},
   {sha:'20d6ec1e62eebed26e56bc2e4f52eed87704e8ab',tree:'54c448837711086bcf0e334de4c6acc97c1f338f',parents:['251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5','64e8dec1549af469cf4647df8a3aa3945b76a3e6'],first_parent:'251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5',source_parent:'64e8dec1549af469cf4647df8a3aa3945b76a3e6',source_tree:'54c448837711086bcf0e334de4c6acc97c1f338f'},'P2_COORDINATES');
eq({author_login:m.author_login,merged_by:m.merged_by,committer_login:m.committer_login,base_ref:m.base_ref,pull_request_count:m.pull_request_count,verification:m.verification,merged_at:m.merged_at},
   {author_login:'tdoljyj',merged_by:'tdoljyj',committer_login:'web-flow',base_ref:'main',pull_request_count:1,verification:{verified:true,reason:'valid',ui_detail:'This commit was created on GitHub.com and signed with GitHub’s verified signature.'},merged_at:'2026-09-14T09:42:42Z'},'P2_OWNER_VERIFIED');
assert.equal(e.controller.generation_id,C.root9);
assert.equal(e.controller.file_count,23);
assert.equal(e.controller.manifest_ref.sha256,C.controller);
assert.equal(e.controller.dynamic_signing_ref.sha256,C.dynamic);
const artifactChecks=[['controller_qualification',P.q,C.qualification],['runtime_acceptance',P.acc,C.acceptance],['status27_signing_payload',P.status,C.statusRaw],['build_ga',P.ga,C.ga]];
for(const [name,p,d] of artifactChecks){
  assert.equal(e.artifacts[name].path,p,`P2_PATH:${name}`);
  assert.equal(e.artifacts[name].ref.sha256,d,`P2_REF:${name}`);
  assert.equal(sha(read(p)),d,`P2_BYTES:${name}`);
}
assert.equal(sha(read(P.manifest)),C.controller,'CONTROLLER_BYTES');
assert.equal(sha(read(P.dynamic)),C.dynamic,'DYNAMIC_HELPER_BYTES');
assert.equal(e.artifacts.status27_signing_payload.signed_payload_sha256,C.statusS);

const budget={sequence:102,uri:'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',sha256:C.budget,seconds:600,evidence_bytes:134217728,automatic_refund:false,inherited:true,new_allocation:false,second_budget_allocation:false};
eq(e.budget_inheritance,budget,'P2_BUDGET_INHERITANCE');
eq({authority_effect:e.authority_effect,database_writes:e.database_writes,history_rewritten:e.history_rewritten,refund:e.refund,capacity_change:e.capacity_change,budget_allocations:e.budget_allocations},
   {authority_effect:'NONE',database_writes:0,history_rewritten:false,refund:false,capacity_change:false,budget_allocations:0},'P2_NO_EFFECT');

const q=json(P.q),acc=json(P.acc),status=json(P.status);
assert.equal(q.controller_digest,C.controller);
assert.equal(q.controller_source_manifest_ref.sha256,C.controller);
assert.equal(acc.controller_digest,C.controller);
assert.equal(acc.accepted_subject.expected_ga.controller_qualification_ref.sha256,C.qualification);
need(!Object.hasOwn(acc.accepted_subject.expected_ga,'budget_reservation_ref'),'EXPECTED_GA_BUDGET_MUST_BE_ABSENT_NOT_JSON_NULL');
eq(acc.accepted_subject.late_bound_fields.budget_reservation_ref,{resolver:'CURRENT_EXACT_EXECUTION_BUDGET_EVENT_V1',maximum_seconds:600,maximum_evidence_bytes:134217728},'LATE_BOUND_BUDGET_POLICY');
eq(acc.root9_binding.inherited_pending_budget,budget,'ACCEPTANCE_EXACT_SEQ102_INHERITANCE');
assert.equal(acc.root9_binding.status27_signing_payload_ref.sha256,C.statusRaw);
assert.equal(acc.root9_binding.status27_signed_payload_sha256,C.statusS);
assert.equal(digest(status),C.statusS,'STATUS_CANONICAL_S');

const sql=read(P.cas).toString('utf8');
const casBody=sql.split('do $postbudget_root9_cas$')[1]?.split('$postbudget_root9_cas$;')[0]??'';
need(casBody.length>0,'CAS_BLOCK_MISSING');
for(const token of [
  "VERIFIED_POSTBUDGET_STAGE2_OWNER_MERGE","54c448837711086bcf0e334de4c6acc97c1f338f",
  "status_signing_raw_sha","expected_ga'->'budget_reservation_ref' is not null",
  "acceptance->'root9_binding' is distinct from jsonb_build_object(","second_budget_allocation',false",
  "verification'->>'reason' is distinct from 'valid'","review->'minors'","fresh_context",
  "sig->'merge' is distinct from p2->'merge'","evidence_sha256',correction_sha",
  "status_manifest_ref',status_ref","reserve_gate_preimage_mismatch",
  "__PRE_CATALOG_JSONB_SHA256__","__POST_PG_GET_FUNCTIONDEF_SHA256__",
  "reserve_gate_acl_precondition_mismatch","no full status reverse hash".replaceAll(' ','_')
]){
  if(token==='no_full_status_reverse_hash')continue;
  need(sql.includes(token),`CAS_GUARD_MISSING:${token}`);
}
need(!sql.includes("sig->'bound_refs'->'status_manifest'"),'STATUS_SIGNATURE_HASH_LOOP');
need(sql.indexOf('do $reserve_gate_catalog_guard$')<sql.indexOf('do $postbudget_root9_cas$'),'RESERVE_GATE_REPLACEMENT_MUST_PRECEDE_CAS');
need(sql.includes("has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')"),'RESERVE_GATE_ANON_ACL_PIN');
need(sql.includes("has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')"),'RESERVE_GATE_AUTHENTICATED_ACL_PIN');
need(!/\b(update|delete)\s+clued_control\.(events|execution_events|control_objects|successor_binding|execution_binding|gate_attempts)\b/i.test(casBody),'HISTORY_MUTATION_FORBIDDEN');
need((casBody.match(/insert into clued_control\.execution_events/gi)||[]).length===1,'EXACT_ONE_EVENT_INSERT_STATEMENT');
need(casBody.includes('values(root,103,q_idem,q_req),(root,104,r_idem,r_req)'),'EXACT_SEQ103_104_APPEND');
need(casBody.includes('update clued_control.execution_current set sequence=104'),'EXACT_CURRENT_CAS_ONLY');
const currentUpdate=casBody.match(/update\s+clued_control\.execution_current\s+set\s+([\s\S]*?)\s+where\b/i);
need(currentUpdate&&/^sequence\s*=\s*104\s*$/i.test(currentUpdate[1].trim()),'ONLY_SEQUENCE_MAY_BE_UPDATED');

const sig=json(P.signature);
assert.equal(sha(read(P.signature)),C.statusSignature,'STATUS_SIGNATURE_BYTES');
assert.equal(sig.state,'P2_OWNER_MERGE_BOUND_VERIFIED');
eq(sig.merge,m,'STATUS_SIGNATURE_P2_MERGE');
assert.equal(sig.no_full_status_reverse_hash,true);
need(!Object.hasOwn(sig.bound_refs,'status_manifest'),'SIGNATURE_TEMPLATE_HASH_LOOP');
assert.equal(sig.payload.blob_sha1,'1816ca696f55bd8d4b182d1edd4d5e2d912f5705');
assert.equal(sig.payload.raw_sha256,C.statusRaw);
assert.equal(sig.payload.signed_object_sha256,C.statusS);
assert.equal(sig.bound_refs.controller_qualification.sha256,C.qualification);
assert.equal(sig.bound_refs.runtime_acceptance.sha256,C.acceptance);
const full=json(P.statusFull);
assert.equal(sha(read(P.statusFull)),C.statusFull,'STATUS27_FULL_BYTES');
assert.equal(full.generation,27);
assert.equal(full.signature_binding.owner_merge_commit,m.sha);
assert.equal(full.signature_binding.signed_object_sha256,C.statusS);
assert.equal(full.signature_binding.signature_evidence_ref.sha256,C.statusSignature);
const unsignedAgain=structuredClone(full);delete unsignedAgain.signature_binding;
eq(unsignedAgain,status,'STATUS27_UNSIGNED_ROUNDTRIP');
const p3=json(P.p3);
assert.equal(p3.status_signature_evidence_ref.sha256,C.statusSignature);
assert.equal(p3.status_signature_evidence_ref.blob_sha1,'023bc9a616e1454eefe374cc67412e2a3d15976d');
assert.equal(p3.status27_full_ref.sha256,C.statusFull);
assert.equal(p3.status27_full_ref.blob_sha1,'a4702980f8685a6d169a751c7fde6725a32613c3');
const casArtifactPaths={
  template:P.cas,preflight:P.preflight,readback:P.readback,verifier:P.verifier,
  reserve_gate_preimage:P.gatePreimage,reserve_gate_fragment:P.gateFragment,
  reserve_gate_full_template:P.gateFull,reserve_gate_cas_wrapper:P.gateWrapper,
  reserve_gate_builder:P.gateBuilder,reserve_gate_full_verifier:P.gateVerifier,
  reserve_gate_branch_verifier:P.gateBranchVerifier,
  reserve_gate_catalog_preflight:P.gateCatalogPreflight,
  reserve_gate_qualification_fixture:P.gateQualificationFixture,
  reserve_gate_acceptance_fixture:P.gateAcceptanceFixture
};
eq(Object.keys(p3.cas_artifacts).sort(),Object.keys(casArtifactPaths).sort(),'P3_CAS_ARTIFACT_KEYSET');
for(const [name,artifactPath] of Object.entries(casArtifactPaths)){
  assert.equal(p3.cas_artifacts[name].path,artifactPath,`P3_CAS_ARTIFACT_PATH:${name}`);
  assert.match(p3.cas_artifacts[name].sha256,/^[0-9a-f]{64}$/,`P3_CAS_ARTIFACT_SHA_SHAPE:${name}`);
  assert.equal(sha(read(artifactPath)),p3.cas_artifacts[name].sha256,`P3_CAS_ARTIFACT_BYTES:${name}`);
}
const review=json(P.review);
eq({template:review.template_state,state:review.state,reviewer:review.independent_reviewer,fresh:review.fresh_context,authority:review.authority_effect,writes:review.live_writes,b:review.blockers,M:review.majors,m:review.minors},
   {template:'NO_AUTHORITY_NOT_AN_INDEPENDENT_REVIEW',state:null,reviewer:null,fresh:null,authority:'NONE',writes:0,b:null,M:null,m:null},'NO_PRETENDED_INDEPENDENT_REVIEW');

const preflight=read(P.preflight).toString('utf8'),readback=read(P.readback).toString('utf8');
for(const token of ['repeatable read read only','PASS_EXACT_ROOT9_SEQ102_PENDING','required_repair_refs','jsonb_array_length(repair_refs)=8','status_after26=0','allocations=10','forwards=17','reserve_gate_sha256','61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5','reserve_gate_catalog','reserve_gate_acl_pass'])
  need(preflight.includes(token),`PREFLIGHT_GUARD_MISSING:${token}`);
need(!/\b(insert|update|delete|merge|truncate)\b\s+(into|clued_control)/i.test(preflight),'PREFLIGHT_NOT_READ_ONLY');
for(const token of ['repeatable read read only','PASS_EXACT_ROOT9_SEQ104_PENDING102_INHERITED','__EVENT103_REQUEST_JSONB_SHA256__','__EVENT104_REQUEST_JSONB_SHA256__','__NEW_BINDING_JSONB_SHA256__','__RESERVE_GATE_POST_PG_GET_FUNCTIONDEF_SHA256__','reserve_gate','acl_pass','status_after26=1','allocations=10','forwards=17'])
  need(readback.includes(token),`READBACK_GUARD_MISSING:${token}`);
need(!/\b(insert|update|delete|merge|truncate)\b\s+(into|clued_control)/i.test(readback),'READBACK_NOT_READ_ONLY');

const sumsPath=at(`${stage}/SHA256SUMS.txt`);
if(fs.existsSync(sumsPath))for(const line of fs.readFileSync(sumsPath,'utf8').trim().split('\n')){
  const match=line.match(/^([0-9a-f]{64})  (.+)$/); need(match,'BAD_SHA256SUMS_LINE');
  assert.equal(sha(read(match[2])),match[1],`SHA256SUMS:${match[2]}`);
}
console.log(JSON.stringify({state:'POSTBUDGET_CAS_P3_OFFLINE_VERIFY_PASS',p2_merge:m.sha,p2_tree:m.tree,p2_evidence_sha256:C.p2Evidence,controller_sha256:C.controller,qualification_sha256:C.qualification,runtime_acceptance_sha256:C.acceptance,status27_unsigned_raw_sha256:C.statusRaw,status27_canonical_signed_payload_sha256:C.statusS,budget_sequence:102,negative_guards_present:true,hash_loop:false,history_rewritten:false,refund:false,capacity_change:false,new_allocation:false,second_budget_allocation:false,database_writes:0},null,2));
