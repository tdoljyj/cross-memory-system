import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {checkIndependentAssessmentSource} from './result-terminal.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('synthetic in-memory assessment requires exact resolved raw/hash/ref and accepted assessor, and grants no unsigned receipt admission',()=>{
 const acceptedReviewerRef={uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/e7f738ae3c247e41733872ab95387440205c736a',sha256:'e09ef634712ce1206600402552073bae91e7296f2b4e2d3f99855bd760c944bd'};
 const independentReviewer='/root/project_list_auth_fix';
 const raw=JSON.stringify({kind:'SYNTHETIC_ENGINEERING_ONLY_NOT_ACTUAL_PQUAL_ASSESSMENT',independent_reviewer:independentReviewer})+'\n',ref={uri:'urn:synthetic:assessment:'+sha(raw),sha256:sha(raw)};
 const args={resolved:{raw,ref,required_reviewer_ref:acceptedReviewerRef},supplied:{raw,ref},acceptedReviewerRef,independentReviewer};
 assert.equal(checkIndependentAssessmentSource(args).state,'ASSESSMENT_BYTES_AND_ROLE_ONLY_REQUIRES_REAL_GRR_SIGNATURE');
 for(const mutate of [x=>x.supplied.raw+=' ',x=>x.supplied.ref.uri+='changed',x=>x.supplied.ref.sha256='a'.repeat(64),x=>x.independentReviewer='/root',x=>x.acceptedReviewerRef.sha256='b'.repeat(64)]){
  const changed=JSON.parse(JSON.stringify(args));mutate(changed);assert.throws(()=>checkIndependentAssessmentSource(changed));
 }
});
