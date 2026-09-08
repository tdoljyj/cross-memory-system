// Assemble the exact independently accepted Profile600 signing payload; no signing or activation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {reviewSubjectDigest,signaturePayloadDigest} from '../../../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const here=new URL('./',import.meta.url),repo=new URL('../../../../../',import.meta.url);
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const exact=(path,digest)=>{const raw=fs.readFileSync(new URL(path,repo));assert.equal(sha(raw),digest,path);return raw;};
const acceptancePath='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/FixedSyntheticProfile600IndependentAcceptance.json';
const acceptanceRaw=exact(acceptancePath,'266ae65aba7faec0af6b4c257a6c289d6bdf3cd3719a74bca145cae00ce99177');
const acceptance=JSON.parse(acceptanceRaw);
assert.equal(acceptance.state,'ACCEPTED_EXACT_PROFILE_DEFINITION_AND_LAYER_APPLICABILITY_FOR_SIGNING');
assert.equal(acceptance.independent_reviewer,'/root/project_list_auth_fix');
const review=JSON.parse(exact(acceptance.subject_file.path,acceptance.subject_file.sha256));
assert.equal(acceptance.subject_file.sha256,'e6013425f51671fa9fa301a7201254f56211963df1d3c3c6ce003528c48956dc');
const subject=structuredClone(review.subject);
assert.equal(review.review_subject_sha256,'44da35f244fb36b25b41c6aa14bc26fe6ca2450815630d2931bf3e88a7eac1c3');
assert.equal(reviewSubjectDigest(subject),review.review_subject_sha256);
assert.equal(acceptance.review_subject_sha256,review.review_subject_sha256);
assert.deepEqual(subject.profile_definition,acceptance.accepted_profile_definition);
const evidence=JSON.parse(exact(acceptance.preparation_evidence.path,acceptance.preparation_evidence.sha256));
assert.equal(acceptance.preparation_evidence.sha256,'5b8bd26f24856f861fa027944cacbc3d50abdf97b355f3c0b57f0262f09483f5');
for(const entry of evidence.files)exact(entry.path,entry.sha256);
const blob=crypto.createHash('sha1').update('blob '+acceptanceRaw.length+'\0').update(acceptanceRaw).digest('hex');
subject.independent_acceptance_ref={uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob,sha256:sha(acceptanceRaw)};
assert.equal(reviewSubjectDigest(subject),review.review_subject_sha256);
assert.equal('signature_binding' in subject,false);
const payload=JSON.stringify(subject,null,2)+'\n';
fs.writeFileSync(new URL('ProfileSigningPayload.json',here),payload,{flag:'wx'});
const result={state:'ACCEPTED_EXACT_PROFILE_PAYLOAD_READY_FOR_REAL_OWNER_PR_SIGNATURE',
 review_subject_sha256:review.review_subject_sha256,payload_sha256:signaturePayloadDigest(subject),file_sha256:sha(payload),
 acceptance:{path:acceptancePath,sha256:sha(acceptanceRaw),git_blob_sha:blob},
 preparation_source_sha256:sha(fs.readFileSync(new URL('prepare-signing.mjs',here))),
 signatures_created:0,signature_verified:false,ga_issued:false,controller_qualified:false,pqual_runs:0};
fs.writeFileSync(new URL('SigningPreparation.json',here),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify(result)+'\n');
