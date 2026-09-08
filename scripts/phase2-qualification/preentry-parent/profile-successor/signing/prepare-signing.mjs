// Consume the actual independent decision. Prepare bytes; never sign or publish.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {reviewSubjectDigest,signaturePayloadDigest} from '../../../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const here=new URL('./',import.meta.url),repo=new URL('../../../../../',import.meta.url);
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const exact=(path,digest)=>{const raw=fs.readFileSync(new URL(path,repo));assert.equal(sha(raw),digest,path);return raw;};
const acceptancePath='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/FixedSyntheticProfileSchemaIndependentAcceptance.json';
const acceptanceRaw=exact(acceptancePath,'bc25963e3236a483b829bde92854f814aa71998b7d9ab5450d9707bfd3e98c6e');
const acceptance=JSON.parse(acceptanceRaw);
assert.equal(acceptance.state,'ACCEPTED_EXACT_PROFILE_DEFINITION_AND_LAYER_APPLICABILITY_FOR_SIGNING');
assert.equal(acceptance.independent_reviewer,'/root/project_list_auth_fix');
const reviewRaw=exact(acceptance.subject_file.path,acceptance.subject_file.sha256);
assert.equal(sha(reviewRaw),'9d56ebb0311938d050aa652c86f2369c729a1fd8232e376f52fb12f489f52e98');
const review=JSON.parse(reviewRaw),subject=structuredClone(review.subject);
assert.equal(review.review_subject_sha256,'e3e2b296c3fbe49fa2e0670a5e87be989a3bb0f10a65bc8e94c657db1d2ffbf7');
assert.equal(acceptance.review_subject_sha256,review.review_subject_sha256);
assert.equal(reviewSubjectDigest(subject),review.review_subject_sha256);
assert.deepEqual(subject.profile_definition,acceptance.accepted_profile_definition);
const evidence=JSON.parse(exact(acceptance.preparation_evidence.path,acceptance.preparation_evidence.sha256));
assert.equal(acceptance.preparation_evidence.sha256,'127eec25f7d47b8b9a8a13155487b69df7698bf76773f54fbc3808acc4a31073');
for(const file of evidence.files)exact('scripts/phase2-qualification/preentry-parent/profile-successor/'+file.path,file.sha256);
exact(evidence.review_function_source,evidence.review_function_source_sha256);
const blob=crypto.createHash('sha1').update('blob '+acceptanceRaw.length+'\0').update(acceptanceRaw).digest('hex');
subject.independent_acceptance_ref={uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob,sha256:sha(acceptanceRaw)};
assert.equal(reviewSubjectDigest(subject),review.review_subject_sha256,'No self-reference or subject drift');
assert.equal('signature_binding' in subject,false);
const raw=Buffer.from(JSON.stringify(subject,null,2)+'\n');
fs.writeFileSync(new URL('ProfileSigningPayload.json',here),raw,{flag:'wx'});
const result={state:'ACCEPTED_EXACT_PROFILE_PAYLOAD_READY_FOR_REAL_OWNER_PR_SIGNATURE',
 review_subject_sha256:review.review_subject_sha256,payload_sha256:signaturePayloadDigest(subject),file_sha256:sha(raw),
 acceptance:{path:acceptancePath,sha256:sha(acceptanceRaw),git_blob_sha:blob},
 preparation_source_sha256:sha(fs.readFileSync(new URL('prepare-signing.mjs',here))),
 signatures_created:0,signature_verified:false,ga_issued:false,controller_qualified:false,pqual_runs:0,
 publication_boundary:'Publish exact accepted Profile, specialized Schemas and this payload through existing Owner PR; actual verified signed merge/read-back remains required. No signature placeholder or current authority inference.'};
fs.writeFileSync(new URL('SigningPreparation.json',here),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
