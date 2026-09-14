#!/usr/bin/env node
// Offline sealer for the two post-P3 immutable evidence blobs. It does not publish or write a DB.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const need=(v,m)=>{if(!v)throw Error(m);};
const read=n=>fs.readFileSync(path.resolve(n));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const p3Path=arg('--p3-publication-evidence'),reviewPath=arg('--independent-review'),outArg=arg('--out');
need(p3Path&&reviewPath&&outArg,'P3_EVIDENCE_REVIEW_AND_OUT_REQUIRED');
const p3Raw=read(p3Path),reviewRaw=read(reviewPath),p3=JSON.parse(p3Raw),review=JSON.parse(reviewRaw);
need(p3.state==='VERIFIED_POSTBUDGET_CAS_P3_OWNER_MERGE'&&p3.repository==='tdoljyj/cross-memory-system','P3_STATE');
need(p3.merge?.verification?.verified===true&&p3.merge.verification.reason==='valid'&&p3.merge.author_login==='tdoljyj'&&p3.merge.merged_by==='tdoljyj'&&p3.merge.committer_login==='web-flow','P3_OWNER_VERIFIED');
need(p3.merge.first_parent==='20d6ec1e62eebed26e56bc2e4f52eed87704e8ab'&&p3.merge.parents?.length===2&&p3.merge.parents[0]===p3.merge.first_parent&&p3.merge.parents[1]===p3.merge.source_parent&&p3.merge.tree===p3.merge.source_tree,'P3_EXACT_TWO_PARENT_TREE');
need(p3.status_signature_evidence_ref?.sha256==='54a8dfdeb553266ddc83842d523869ab65488d73f2356645a87a3a3ce26664e4'&&p3.status27_full_ref?.sha256==='186879980141db38eb14bd9ee5ced915c9ab37f91d290e822addd22288c5e485','P3_STATUS_ARTIFACTS');
const p3Sha=sha(p3Raw),p3Blob=blob(p3Raw);
need(review.state==='PASS_NO_BLOCKERS'&&review.independent_reviewer==='/root/postbudget_p1_review'&&review.fresh_context===true&&review.authority_effect==='NONE'&&review.live_writes===0,'REVIEW_IDENTITY');
need(review.blockers===0&&review.majors===0&&review.minors===0,'REVIEW_MUST_BE_B0_M0_m0');
need(review.reviewed_targets?.p3_publication_sha256===p3Sha&&review.reviewed_targets.status_sha256==='186879980141db38eb14bd9ee5ced915c9ab37f91d290e822addd22288c5e485','REVIEW_TARGETS');
const reviewSha=sha(reviewRaw),reviewBlob=blob(reviewRaw),base='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/';
const plan={state:'POSTMERGE_EVIDENCE_BLOBS_READY_NOT_PUBLISHED',branch_policy:'DEDICATED_EVIDENCE_BRANCH_NOT_MAIN',objects:[{name:'P3PublicationEvidence.verified.json',sha256:p3Sha,git_blob_sha1:p3Blob,expected_uri:base+p3Blob,github_create_blob_body:{encoding:'utf-8',content:p3Raw.toString('utf8')}},{name:'IndependentReview.json',sha256:reviewSha,git_blob_sha1:reviewBlob,expected_uri:base+reviewBlob,github_create_blob_body:{encoding:'utf-8',content:reviewRaw.toString('utf8')}}],required_readback:'GET_EACH_EXPECTED_URI_AND_RECOMPUTE_SHA256_BEFORE_CAS_SEAL',database_writes:0,main_branch_changes:0};
const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'PostMergeEvidenceBlobPlan.json'),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({state:plan.state,p3_evidence_sha256:p3Sha,p3_blob_sha1:p3Blob,review_sha256:reviewSha,review_blob_sha1:reviewBlob,database_writes:0},null,2));
