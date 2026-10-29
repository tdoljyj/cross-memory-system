import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assembleRecord,validateRecordInputs} from '../src/resident-v2/prepare-record.mjs';
import {validateRecordV2} from '../src/resident-v2/record.mjs';
import {revocationQualification} from '../src/resident-v2/revocation-run.mjs';
import {recordInputs,sourceFiles} from './resident-v2-fixtures.mjs';
const docs=result=>Object.fromEntries(Object.entries(result.files).map(([name,text])=>[name,Buffer.from(text)]));
test('ordinary records stay unqualified for the new maintenance role',()=>{
 const result=assembleRecord(recordInputs(),sourceFiles()),record=validateRecordV2(docs(result));
 assert.equal(Object.hasOwn(record.accepted,'revocationMaintenanceQualification'),false);
 assert.equal(revocationQualification(record),null);
});
test('an existing exact Source qualification reference is hash-bound into the accepted record without issuing a new one',()=>{
 const inputs=recordInputs(),files=sourceFiles(),ordinary=validateRecordV2(docs(assembleRecord(inputs,files)));
 const q={contract:'clued.independent-ci.revocation-maintenance-qualification/1',qualificationRef:'receipt:'+randomUUID(),
  sourceManifestSha256:ordinary.config.sourceManifestSha256,allowWhileHalted:false,validUntil:null};
 const result=assembleRecord({...inputs,revocationMaintenanceQualification:q},files),record=validateRecordV2(docs(result));
 assert.deepEqual(revocationQualification(record),q);assert.notEqual(record.hashes.acceptanceSha256,ordinary.hashes.acceptanceSha256);
 assert.equal(record.config.sourceManifestSha256,ordinary.config.sourceManifestSha256);
});
test('malformed, expired, extra-field or another Source qualification does not produce a maintenance-qualified record',()=>{
 const inputs=recordInputs(),files=sourceFiles(),ordinary=validateRecordV2(docs(assembleRecord(inputs,files)));
 const base={contract:'clued.independent-ci.revocation-maintenance-qualification/1',qualificationRef:'receipt:'+randomUUID(),
  sourceManifestSha256:ordinary.config.sourceManifestSha256,allowWhileHalted:false,validUntil:null};
 for(const edit of [q=>q.qualificationRef='unverified-label',q=>q.validUntil='2020-01-01T00:00:00.000Z',q=>q.extra=true]){
  const q=structuredClone(base);edit(q);assert.throws(()=>validateRecordInputs({...inputs,revocationMaintenanceQualification:q}));
 }
 assert.throws(()=>assembleRecord({...inputs,revocationMaintenanceQualification:{...base,sourceManifestSha256:'f'.repeat(64)}},files),/QUALIFICATION_SOURCE_CHANGED/);
});
