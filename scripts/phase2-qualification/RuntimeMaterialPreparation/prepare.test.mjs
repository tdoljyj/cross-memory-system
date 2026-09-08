import assert from 'node:assert/strict';
import test from 'node:test';
import {assemble,dynamicFields} from './prepare.mjs';
test('covers every fixed required field while withholding actual issuance',()=>{
 const p=assemble();assert.equal(Object.keys(p.expected_ga).length,41);assert.equal(p.field_source_map.length,41);
 assert.equal(p.unresolved_fields.length,28);assert.equal(p.accepted,false);assert.equal(p.ga_issued,false);assert.equal(p.executable,false);
 for(const key of dynamicFields)assert.equal(Object.hasOwn(p.expected_ga,key),false);
});
test('real ordered stage identities preserve combined R07/R08 and original types',()=>{
 const p=assemble(),refs=p.expected_ga.stage_receipt_refs;assert.equal(refs.length,6);assert.deepEqual(refs[2],refs[3]);
 assert.equal(refs[0].sha256,'f2ec1d6cf3afbd80d415c65c7bc0f71d86d606bda9031a174d92517e421ac246');
 assert.equal(refs[1].sha256,'f40c8af253f811f820e4b3eccc144d63ca3548663810aba10bebb22331661b36');
});
test('dynamic or fixed-field overrides cannot create an authorization object',()=>{
 for(const key of ['signature','authorization_status','runner_generation','profile_digest','issuer_ref','unknown'])
  assert.throws(()=>assemble({[key]:{value:'fake',provenance:{source:'synthetic-test-only',sha256:'a'.repeat(64)}}}),/cannot be overridden/);
});
test('late material requires provenance and original field shape, remains unverified',()=>{
 assert.throws(()=>assemble({repository_ref:{value:{uri:'synthetic-only',sha256:'a'.repeat(64)}}}),/provenance required/);
 assert.throws(()=>assemble({repository_ref:{value:1,provenance:{source:'synthetic-test-only',sha256:'a'.repeat(64)}}}),/encoding rejected/);
 const p=assemble({repository_ref:{value:{uri:'synthetic-only',sha256:'a'.repeat(64)},provenance:{source:'synthetic-test-only',sha256:'a'.repeat(64)}}});
 assert.equal(p.field_source_map.find(x=>x.field==='repository_ref').state,'SUPPLIED_PREPARATION_NOT_INDEPENDENTLY_VERIFIED');
 assert.equal(p.final_review_required_even_if_all_fields_supplied,true);
});
