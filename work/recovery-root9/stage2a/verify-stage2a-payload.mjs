#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
// The same verifier runs both from the local preparation directory and after it
// is published inside work/recovery-root9/stage2a/.
const nested=path.join(HERE,'payload/work/recovery-root9/stage2a');
const OUT=fs.existsSync(path.join(HERE,'RESULT.json'))?HERE:nested;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>sha(Buffer.from(canonical(v)+'\n'));
const read=n=>fs.readFileSync(path.join(OUT,n));
const json=n=>JSON.parse(read(n));
const ref=n=>{const b=read(n);return {uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${blob(b)}`,sha256:sha(b)};};
const same=(a,b)=>assert.deepEqual(a,b);

const result=json('RESULT.json');
assert.equal(result.state,'STAGE2A_PREPUBLICATION_CANDIDATE_PASS');
assert.equal(result.authority_effect,'NONE');
assert.equal(result.controller_digest,'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b');

const approval=json('Root9OwnerApproval.candidate.json');
const independent=json('Root9IndependentAcceptance.json');
const subject=json('Root9ReviewSubject.json');
const signing=json('Root9SigningPayload.json');
same(result.root9_owner_approval_ref,ref('Root9OwnerApproval.candidate.json'));
same(result.root9_independent_acceptance_ref,ref('Root9IndependentAcceptance.json'));
same(result.root9_signing_payload_ref,ref('Root9SigningPayload.json'));
assert.equal(independent.review_subject_sha256,digest(subject));
assert.equal(result.root9_review_subject_sha256,digest(subject));
assert.equal(signing.owner_approval_ref.sha256,ref('Root9OwnerApproval.candidate.json').sha256);
assert.equal(signing.independent_acceptance_ref.sha256,ref('Root9IndependentAcceptance.json').sha256);
assert.equal(Object.hasOwn(signing,'signature_binding'),false);
assert.equal(approval.explicit_prohibitions.includes('reserve or consume the unique remaining budget'),true);

const q=json('ControllerQualification.root9.candidate.json');
same(result.controller_qualification_ref,ref('ControllerQualification.root9.candidate.json'));
assert.equal(q.state,'ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION');
assert.equal(q.independent_reviewer,'/root');
assert.equal(q.test_evidence_refs.length>=2,true);
assert.equal(q.correction_evidence_refs.length>=1,true);
const evidenceFiles=[
  'qualification-evidence/Stage1SourceCoordinates.verified.json',
  'qualification-evidence/CapacityReviewerVerification.json',
  'qualification-evidence/RuntimeGuardModelTests.json'
];
same(q.test_evidence_refs,evidenceFiles.map(ref));
same(q.correction_evidence_refs,[
  ref('qualification-evidence/SchemaPinCorrection.json'),
  ref('qualification-evidence/Status26DependencyCorrection.json')
]);
assert.equal(q.ga_schema_ref.sha256,'f7f7e2a011f3f81a005e46f9cf7683edeb010dc7812eadfb4473f6ad5368a1ce');
assert.equal(q.status_schema_ref.sha256,'6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e');
assert.equal(q.gate_result_receipt_schema_ref.sha256,'292da87d05b1bb00337a2045e3d26f6df0be70aaf520aa519572fa3dec395252');

const capApproval=json('capacity/Root9CurrentController4000000CapacityApproval20260914.candidate.json');
const capApplicability=json('capacity/Root9CurrentController4000000CapacityApplicability20260914.candidate.json');
const repair=json('capacity/Root9Current043CapacityRepairAcceptance20260914.candidate.json');
same(capApplicability.approval_ref,ref('capacity/Root9CurrentController4000000CapacityApproval20260914.candidate.json'));
same(repair.capacity_applicability_ref,ref('capacity/Root9CurrentController4000000CapacityApplicability20260914.candidate.json'));
same(repair.capacity_approval_ref,ref('capacity/Root9CurrentController4000000CapacityApproval20260914.candidate.json'));
assert.equal(capApproval.capacity_delta.source_refs_maximum,160);
assert.equal(capApproval.capacity_delta.refund,false);
assert.equal(capApproval.owner_instruction_scope.capacity_value_change,false);
assert.equal(capApproval.owner_instruction_scope.unique_budget_operation,false);
assert.equal(Date.parse(capApproval.approved_at)>=Date.parse(signing.not_before),true);
assert.equal(capApplicability.changed_source_refs.length,23);
same(capApplicability.changed_source_refs,repair.changed_source_refs);

const historical=json('HistoricalMaterialDescriptors.verified.json');
assert.equal(historical.series.repairs.length,8);
const sql=read('runtime-function-patch.UNSEALED.sql').toString('utf8');
assert.match(sql,/ROOT9_RUNTIME_FUNCTION_PATCH_UNSEALED_DO_NOT_APPLY/);
assert.match(sql,/ctrgen_308a1dfc185cff633892638581e0a34c/);
assert.equal((sql.match(/CREATE OR REPLACE FUNCTION clued_control\.(?:reserve_execution_budget|reserve_gate)/g)||[]).length,2);

const sums=read('SHA256SUMS.txt').toString('utf8').trim().split('\n');
for(const line of sums){const [want,repoPath]=line.split(/\s{2}/);const rel=repoPath.replace(/^work\/recovery-root9\/stage2a\//,'');assert.equal(sha(read(rel)),want,'SHA256:'+rel);}
console.log(JSON.stringify({state:'STAGE2A_PREPUBLICATION_VERIFY_PASS',files:sums.length,test_evidence:q.test_evidence_refs.length,correction_evidence:q.correction_evidence_refs.length,capacity_changed:false,refund:false,database_writes:0,budget_reservations:0,ga_dispatches:0,authority_effect:'NONE'},null,2));
