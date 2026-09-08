import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {reviewSubjectDigest} from '../../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const here=new URL('./',import.meta.url),old=new URL('../profile-successor/',import.meta.url);
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const ref=raw=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex'),sha256:sha(raw)});
const write=(name,value)=>fs.writeFileSync(new URL(name,here),JSON.stringify(value,null,2)+'\n');
const profileRaw=fs.readFileSync(new URL('ProfileDefinition.json',old));assert.equal(sha(profileRaw),'45a7d602297f95c0ffd939da63534a6069de17ec197404bd657e160503c209f4');
const profile=JSON.parse(profileRaw);profile.definition_version='fixed-synthetic-skill-input-20260908.v2-runtime180';profile.max_lifetime_seconds=180;
const schema=JSON.parse(fs.readFileSync(new URL('preentry-profile.candidate.schema.json',old)));
schema.properties.definition_version.const=profile.definition_version;schema.properties.max_lifetime_seconds.const=180;
write('ProfileDefinition.json',profile);write('preentry-profile.candidate.schema.json',schema);
const originalInput=JSON.parse(fs.readFileSync(new URL('../ProfileApplicabilityCandidate.json',old))).fixed_input;
const input=structuredClone(originalInput);input.deadline_seconds=180;
input.parent_role='Immutable fixed argv/prestart dependency, not the complete runtime executor';
input.complete_executor_binding={required:'same independently accepted exact controller source-set manifest in Profile inputs, Gate and TestManifest before execution',state:'NOT_YET_BOUND',accepted_ref:null};
write('FixedInputScope.json',input);
const subject=JSON.parse(fs.readFileSync(new URL('ProfileReviewSubject.json',old))).subject;
subject.profile_definition=profile;subject.schema_refs['preentry-profile.candidate.schema.json']=ref(fs.readFileSync(new URL('preentry-profile.candidate.schema.json',here)));
subject.fixed_input_ref={source_ref:ref(fs.readFileSync(new URL('FixedInputScope.json',here))),json_pointer:''};
subject.execution_boundary='Prepared 180-second execution Profile and explicit complete-controller identity correction; not signed/active/qualified. Full exact controller input binding is mandatory before execution.';
write('ProfileReviewSubject.json',{state:'PREPARED_PROFILE_SUCCESSOR_NOT_ACCEPTED',review_subject_sha256:reviewSubjectDigest(subject),subject});
write('ChangeSet.json',{state:'PREPARED_NOT_ACTIVE',predecessor_profile_sha256:sha(profileRaw),changes:[
 {path:'/profile_definition/definition_version',before:'fixed-synthetic-skill-input-20260908.v1',after:profile.definition_version},
 {path:'/profile_definition/max_lifetime_seconds',before:90,after:180},
 {path:'/FixedInputScope/deadline_seconds',before:90,after:180},
 {path:'/FixedInputScope/parent_role',before:'implicit/ambiguous executor identity',after:input.parent_role},
 {path:'/FixedInputScope/complete_executor_binding',before:'absent',after:input.complete_executor_binding}],
 derived_changes:['Profile Schema constants/version and their exact hash/ref','Profile subject fixed-input ref and review digest'],
 unchanged:['profile ID/purpose','R05-R10 and circular-stage exclusions','all four N/A reasons and vector schema bytes','child/Skill bytes and business read/write scope','CPU/memory/PID/network/credentials/model/paid limits','7200-second aggregate budget and 1GiB evidence bound','Owner absolute expiry 2026-09-09T09:28:59Z','original <=600-second per-GA upper bound'],
 cause:{observed_transport:'root actual Supabase calls approximately 11-12 seconds each',stop_reserve_seconds:30,start_cli_allowance_seconds:6,old_profile_latest_start_seconds:54,choice:'explicit conservative 180-second successor, no automatic renewal or scope increase'},authority_effect:'NONE'});
console.log(JSON.stringify({review_subject_sha256:reviewSubjectDigest(subject),profile_sha256:sha(fs.readFileSync(new URL('ProfileDefinition.json',here))),accepted:false}));
