import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(new URL('../../../../apps/clued-cloud/package.json',import.meta.url)),Ajv=require('ajv');
const read=(name)=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url)));
const profile=read('ProfileDefinition.json'),prior=read('../profile-successor/ProfileDefinition.json');
test('exact Profile difference is definition version and explicit 180-second window',()=>{
 const restored=structuredClone(profile);restored.definition_version=prior.definition_version;restored.max_lifetime_seconds=prior.max_lifetime_seconds;
 assert.deepEqual(restored,prior);assert.equal(profile.max_lifetime_seconds,180);assert.ok(profile.max_lifetime_seconds<=600);
 const check=new Ajv({allErrors:true}).compile(read('preentry-profile.candidate.schema.json'));
 assert.ok(check(profile));assert.equal(check({...profile,max_lifetime_seconds:181}),false);assert.equal(check(prior),false);
});
test('resource/child scope retains every old field except deadline and explicit executor-role correction',()=>{
 const previous=read('../ProfileApplicabilityCandidate.json').fixed_input,newer=read('FixedInputScope.json');
 const restored=structuredClone(newer);delete restored.parent_role;delete restored.complete_executor_binding;restored.deadline_seconds=previous.deadline_seconds;
 assert.deepEqual(restored,previous);assert.equal(newer.complete_executor_binding.state,'NOT_YET_BOUND');
 assert.equal(read('ProfileReviewSubject.json').subject.deadline,read('../profile-successor/ProfileReviewSubject.json').subject.deadline);
});
