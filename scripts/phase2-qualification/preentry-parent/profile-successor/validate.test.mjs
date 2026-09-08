import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
import {reviewSubjectDigest} from '../../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const require=createRequire(new URL('../../../../apps/clued-cloud/package.json',import.meta.url));
const Ajv=require('ajv'),ajv=new Ajv({allErrors:true,strictKeywords:true,format:'full'});
const bytes=name=>fs.readFileSync(new URL(name,import.meta.url));
const read=name=>JSON.parse(bytes(name));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const profile=read('ProfileDefinition.json'),profileCheck=ajv.compile(read('preentry-profile.candidate.schema.json'));
ajv.addSchema(read('revocation-epoch-vector.candidate.schema.json'),'revocation-epoch-vector.candidate.schema.json');
const vectorCheck=ajv.getSchema('revocation-epoch-vector.candidate.schema.json');
const vector={vector_schema_version:'clued.fixed-synthetic-skill-input/1',not_applicable_evidence:structuredClone(profile.not_applicable_layer_permissions)};
for(const layer of Object.keys(profile.not_applicable_layer_permissions)){
 vector[layer+'_scope_ref']='not_applicable';vector[layer+'_epoch']='not_applicable';
}
test('complete execution Profile shape and exact prepared Schema references without invented gates',()=>{
 assert.equal(profileCheck(profile),true,JSON.stringify(profileCheck.errors));
 assert.equal('gate_refs' in profile,false);assert.equal('gate_definition_set_digest' in profile,false);
 const raw=bytes('revocation-epoch-vector.candidate.schema.json');
 const blob=crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
 for(const value of Object.values(profile.not_applicable_layer_permissions)){
  assert.equal(value.accepted_schema_ref.sha256,sha(raw));assert.ok(value.accepted_schema_ref.uri.endsWith('/'+blob));
 }
 assert.equal(profileCheck({...profile,gate_refs:[]}),false);
});
test('exact four-layer NA specialization rejects missing pair or changed reason and business epoch substitution',()=>{
 assert.equal(vectorCheck(vector),true,JSON.stringify(vectorCheck.errors));
 for(const layer of Object.keys(profile.not_applicable_layer_permissions)){
  const missing=structuredClone(vector);delete missing[layer+'_scope_ref'];assert.equal(vectorCheck(missing),false);
  const changed=structuredClone(vector);changed.not_applicable_evidence[layer].reason='all isolated tests';assert.equal(vectorCheck(changed),false);
  const business=structuredClone(vector);business[layer+'_scope_ref']='real-scope';business[layer+'_epoch']=1;assert.equal(vectorCheck(business),false);
 }
});
test('GA original independent Gate and control obligations remain byte-identical',()=>{
 const ga=read('gate-authorization.candidate.schema.json');
 assert.equal(sha(bytes('gate-authorization.candidate.schema.json')),'f7f7e2a011f3f81a005e46f9cf7683edeb010dc7812eadfb4473f6ad5368a1ce');
 for(const key of ['gate_id','control_trust_root_generation','runner_generation','credential_generation','session_generation','controller_qualification_ref'])assert.ok(ga.required.includes(key));
 ajv.compile(ga);
});
test('review subject binds exact mechanism, input and schemas without acceptance/signature placeholders',()=>{
 const envelope=read('ProfileReviewSubject.json');
 assert.equal(reviewSubjectDigest(envelope.subject),envelope.review_subject_sha256);
 assert.deepEqual(envelope.subject.mechanism_boundaries.map(x=>x.id),['B01','B02','B03','B04','B05','B06']);
 assert.equal('signature_binding' in envelope.subject,false);assert.equal('independent_acceptance_ref' in envelope.subject,false);
 for(const [name,ref] of Object.entries(envelope.subject.schema_refs))assert.equal(ref.sha256,sha(bytes(name)));
});
