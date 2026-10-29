import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJobV2 } from '../src/job-v2.mjs';
import { digest } from '../src/proof.mjs';
import { admittedFactsMatchJobV2, validateFormalAdmissionV2, FULL_ADMISSION_CONTRACT_V3, supportedNativeExecution } from '../src/admission-facts-v2.mjs';
import { admittedFacts, subject } from './resident-v2-fixtures.mjs';
const now=Date.parse('2026-10-29T05:00:00Z');
const job=makeJobV2({...subject(),testSha:subject().headSha,role:'gitleaks'});
const claim={claimId:'11111111-2222-4333-8444-555555555555',fence:4,epoch:3,expiresAt:new Date(now+3600000).toISOString()};
const packet={complete:true,pr:job.pr,headSha:job.headSha,baseSha:job.baseSha,paths:['scripts/ci/example.mjs']};
const sign=facts=>{const {observationSha256,...body}=facts;return {...body,observationSha256:digest(body)};};
const legacy=()=>admittedFacts(job,claim,packet,{batchClaim:claim,observedAt:now});
const active=guarded=>sign({...legacy(),contract:FULL_ADMISSION_CONTRACT_V3,executionPolicy:'active',guarded,publicationRequired:true,
 headAuthorizationId:guarded?'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee':null});
test('legacy staged facts keep their old contract and never accept a guarded claim',()=>{
 assert.equal(admittedFactsMatchJobV2(legacy(),job,now,{batchClaim:claim}),true);
 assert.equal(admittedFactsMatchJobV2(sign({...legacy(),guarded:true}),job,now,{batchClaim:claim}),false);
 assert.equal(supportedNativeExecution('staged',true),false);
});
test('active guarded facts require the separate contract, exact head authorization and a Native publication',()=>{
 for(const guarded of [false,true])assert.equal(validateFormalAdmissionV2(job,active(guarded),now,{batchClaim:claim}).publicationRequired,true);
 for(const change of [f=>f.contract='clued.independent-ci.full-admission/2',f=>f.headAuthorizationId=null,f=>f.publicationRequired=false,
  f=>f.executionPolicy='staged',f=>f.executionHandoverPending=true,f=>f.fence++,f=>f.epoch++]){
  const value=active(true);change(value);assert.equal(admittedFactsMatchJobV2(sign(value),job,now,{batchClaim:claim}),false);
 }
});
test('active bridge facts cannot drop or invent fields, or replay another job or generation',()=>{
 const missing=active(true);delete missing.headAuthorizationId;
 for(const f of [missing,{...active(true),extra:true},{...active(true),jobId:'f'.repeat(64)}])assert.throws(()=>validateFormalAdmissionV2(job,sign(f),now,{batchClaim:claim}));
 assert.throws(()=>validateFormalAdmissionV2(job,active(true),now,{batchClaim:{...claim,epoch:4}}));
});
