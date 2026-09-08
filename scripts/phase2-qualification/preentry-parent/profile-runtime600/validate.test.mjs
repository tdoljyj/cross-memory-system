import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(new URL('../../../../apps/clued-cloud/package.json',import.meta.url)),Ajv=require('ajv');
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url)));
test('600 Profile changes only version/lifetime and rejects 601 through its exact Schema',()=>{
 const profile=read('ProfileDefinition.json'),prior=read('../profile-runtime180/ProfileDefinition.json');
 const restored={...profile,definition_version:prior.definition_version,max_lifetime_seconds:prior.max_lifetime_seconds};
 assert.deepEqual(restored,prior);assert.equal(profile.max_lifetime_seconds,600);
 const check=new Ajv({allErrors:true}).compile(read('preentry-profile.candidate.schema.json'));
 assert(check(profile));assert.equal(check({...profile,max_lifetime_seconds:601}),false);assert.equal(check(prior),false);
 const input=read('FixedInputScope.json'),old=read('../profile-runtime180/FixedInputScope.json');
 const restoredInput={...input,deadline_seconds:old.deadline_seconds,parent_path:old.parent_path,parent_sha256:old.parent_sha256};
 delete restoredInput.child_completion_policy;
 assert.deepEqual(restoredInput,old);assert.equal(input.deadline_seconds,600);
 assert.equal(Object.hasOwn(input,'host_control_fixture'),false);
 assert.equal(read('ProfileReviewSubject.json').subject.deadline,read('../profile-runtime180/ProfileReviewSubject.json').subject.deadline);
});
