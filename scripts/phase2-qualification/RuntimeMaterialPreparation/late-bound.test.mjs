import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareLate,lateFields} from './prepare-late-bound.mjs';
test('exactly three explicit resolvers replace fixed values without granting authority',()=>{
 const p=prepareLate();assert.equal(Object.keys(p.expected_ga).length,38);assert.deepEqual(Object.keys(p.late_bound_fields),lateFields);
 for(const field of lateFields)assert.equal(Object.hasOwn(p.expected_ga,field),false);
 assert.equal(p.late_bound_fields.budget_reservation_ref.maximum_seconds,180);assert.equal(p.late_bound_fields.status_manifest_ref.signed_payload_sha256,null);
 assert.equal(p.accepted,false);assert.equal(p.executable,false);assert.equal(p.ga_issued,false);
});
test('arbitrary late instances and malformed Status digests are rejected, valid shape remains unaccepted',()=>{
 for(const field of lateFields)assert.throws(()=>prepareLate({[field]:{value:'fake'}}),/actual fixed resolver/);
 assert.throws(()=>prepareLate({},'not-an-actual-hash'),/Status signing-payload/);
 const p=prepareLate({},'a'.repeat(64));assert.equal(p.final_review_required_even_if_all_fields_supplied,true);
});
