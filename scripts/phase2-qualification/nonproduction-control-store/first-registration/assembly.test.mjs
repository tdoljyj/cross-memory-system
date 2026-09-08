import assert from 'node:assert/strict';
import test from 'node:test';
import {artifact,checkAcceptance,signingPayload,assemble} from './assembly-common.mjs';
import {signaturePayloadDigest} from '../protocol-successor/validate-successor.mjs';
const base='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/';
const acceptance=artifact(base+'FirstControlRootRegistrationIndependentAcceptance.v2.json','b3d4422ba8d4150bd2988fc713217b3f310b7bf1c34c058e17a221f435afc49b');
const payload=artifact('scripts/phase2-qualification/nonproduction-control-store/first-registration/signing-v2/RootSigningPayload.json','de24b30379045bdf5d141ca8cc5f1dc3eed947f4f553e2323a1df5296918919d');
test('actual v2 acceptance assembles exact unsigned payload; original acceptance cannot authorize changed subject',()=>{
 assert.deepEqual(signingPayload(acceptance),payload.value);
 assert.equal(signaturePayloadDigest(payload.value),'8487344cdcf4e976d5f7db0514a25aea7b447875cbd74c4780d5ba6c9d5113be');
 assert.equal(payload.value.signature_binding,undefined);
 assert.throws(()=>checkAcceptance(artifact(base+'FirstControlRootRegistrationIndependentAcceptance.json')));
});
test('actual acceptance mutations in purpose, Audience, scope, algorithm and accepted SQL input are rejected',()=>{
 const mutations=[a=>a.accepted_issuer_purposes.pop(),a=>a.accepted_issuer_purposes[0].accepted=false,a=>a.accepted_issuer_purposes[0].audience+='other',a=>a.accepted_scope.environment='PRODUCTION',a=>a.accepted_algorithm_config.digest_algorithm='OTHER',a=>a.accepted_binding.known_values.subject_sha256=a.review_subject_sha256];
 for(const mutate of mutations){const bad={...acceptance,value:structuredClone(acceptance.value)};mutate(bad.value);assert.throws(()=>checkAcceptance(bad));}
});
test('missing signature evidence and real PR25 identity evidence cannot assemble signed root',()=>{
 assert.throws(()=>assemble(payload,acceptance,{value:{}}));
 assert.throws(()=>assemble(payload,acceptance,artifact(base+'IndependentControlRootOwnerSignatureBinding.json')));
});
