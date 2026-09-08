// One bounded forward Profile definition; no acceptance or signature is issued.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {reviewSubjectDigest} from '../../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const here=new URL('./',import.meta.url),old=new URL('../profile-runtime180/',import.meta.url);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const bytes=n=>fs.readFileSync(new URL(n,old));
const read=n=>JSON.parse(bytes(n));
const out=(n,v)=>{const raw=JSON.stringify(v,null,2)+'\n';fs.writeFileSync(new URL(n,here),raw);return Buffer.from(raw);};
const ref=b=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),sha256:hash(b)});
assert.equal(hash(bytes('ProfileDefinition.json')),'cce4d4966dddbdb9685c8fab9242ffde48ca6210c919bd2615cc9c0bfc011f51');
const profile=read('ProfileDefinition.json');
profile.definition_version='fixed-synthetic-skill-input-20260908.v3-runtime600';profile.max_lifetime_seconds=600;
const schema=read('preentry-profile.candidate.schema.json');
schema.properties.definition_version.const=profile.definition_version;schema.properties.max_lifetime_seconds.const=600;
const input=read('FixedInputScope.json');input.deadline_seconds=600;
input.parent_path='scripts/phase2-qualification/preentry-parent/runtime-successor/host-runtime600/parent600.py';
input.parent_sha256=hash(fs.readFileSync(new URL('../runtime-successor/host-runtime600/parent600.py',here)));
input.child_completion_policy='The fixed controller literal flushes the fixture report then waits at most600 seconds, with SIGTERM normal exit, so Running and actual STOP remain observable; independent host deadline/STOP reserve applies earlier. Skill and fixture source bytes are unchanged.';
const profileRaw=out('ProfileDefinition.json',profile),schemaRaw=out('preentry-profile.candidate.schema.json',schema),inputRaw=out('FixedInputScope.json',input);
const subject=read('ProfileReviewSubject.json').subject;
subject.profile_definition=profile;subject.schema_refs['preentry-profile.candidate.schema.json']=ref(schemaRaw);
subject.fixed_input_ref={source_ref:ref(inputRaw),json_pointer:''};
subject.execution_boundary='Prepared 600-second execution Profile within the existing Owner ceiling; not signed, active or qualified. Complete exact controller source-set binding remains mandatory before execution.';
out('ProfileReviewSubject.json',{state:'PREPARED_PROFILE_SUCCESSOR_NOT_ACCEPTED',review_subject_sha256:reviewSubjectDigest(subject),subject});
out('ChangeSet.json',{state:'PREPARED_NOT_ACTIVE',predecessor_profile_sha256:hash(bytes('ProfileDefinition.json')),
 changes:[{path:'/profile_definition/definition_version',before:'fixed-synthetic-skill-input-20260908.v2-runtime180',after:profile.definition_version},{path:'/profile_definition/max_lifetime_seconds',before:180,after:600},{path:'/FixedInputScope/deadline_seconds',before:180,after:600}],
 derived_changes:['Profile Schema exact version/lifetime constants and reference','Profile subject fixed input reference, descriptive boundary and review digest','Fixed parent dependency points to the600 literal flush/hold/STOP successor'],
 unchanged:['Profile ID/purpose/environment','All R05-R10 and N/A reasons','Original GA/vector schemas','Skill and fixture bytes; CPU0.5/memory128MiB/PID16/networknone/two mounts','Zero model/paid/business credentials/production actions','7200 aggregate seconds/1GiB aggregate evidence/one active reservation','Owner absolute expiry 2026-09-09T09:28:59Z','Actual prior budget 1500 seconds and 287700424 bytes remains charged'],
 applicability_source:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/QualificationExecutionWindowApplicabilityDecision.json',
 reason:'Use the already approved <=600-second per-GA ceiling for actual serial trusted-tool current reads and complete controlled qualification observations; no new authority or unapproved warmup protocol',
 authority_effect:'NONE'});
console.log(JSON.stringify({profile_sha256:hash(profileRaw),schema_sha256:hash(schemaRaw),review_subject_sha256:reviewSubjectDigest(subject),accepted:false}));
