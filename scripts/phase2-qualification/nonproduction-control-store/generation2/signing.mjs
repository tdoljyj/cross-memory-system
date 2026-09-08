// Pure assembly of an independently accepted forward subject. No network/DB/signing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {canonicalDigest,reviewSubjectDigest,signaturePayloadDigest,validateRootShape} from '../protocol-successor/validate-successor.mjs';
import {generation} from './prepare.mjs';
export const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export function contentRef(raw){return {uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex'),sha256:sha(raw)};}
export function signingPayload(subjectRaw,acceptanceRaw){
 const envelope=JSON.parse(subjectRaw),a=JSON.parse(acceptanceRaw),s=envelope.subject;
 assert.equal(envelope.state,'PREPARED_NOT_REGISTERED_FORWARD_ROOT_REVIEW_SUBJECT');
 assert.equal(a.state,'ACCEPTED_EXACT_FORWARD_ROOT_GENERATION_SUBJECT');
 assert.equal(a.independent_reviewer,'/root/project_list_auth_fix');
 assert.equal(a.subject_file.sha256,sha(subjectRaw));assert.equal(a.review_subject_sha256,reviewSubjectDigest(s));
 assert.equal(envelope.review_subject_sha256,a.review_subject_sha256);
 assert.equal(a.root_set_id,s.root_set_id);assert.equal(a.control_trust_root_generation,generation);
 assert.equal(s.control_trust_root_generation,generation);assert.equal(s.generation_ordinal,2);
 assert.deepEqual(a.accepted_scope,s.scope);assert.equal(a.accepted_audience,s.audience);
 assert.equal(a.schema_sha256,s.schema_digest);assert.deepEqual(a.accepted_algorithm_config,s.algorithm_config);
 assert.equal(a.metadata_binding_sha256,envelope.source.metadata_binding_sha256);
 assert.equal(a.accepted_binding_changed,false);assert.deepEqual(a.accepted_predecessor,s.predecessor);
 assert.equal(a.accepted_history_prefix_sha256,s.history.prefix_digest);
 assert.equal(a.accepted_history_prefix_sequence,s.history.prefix_sequence);
 assert.ok(Date.now()>=Date.parse(s.not_before)&&Date.now()<Date.parse(s.expires_at),'Owner window');
 assert.equal(s.signature_binding,undefined);assert.equal(s.independent_acceptance_ref,undefined);
 return {...structuredClone(s),independent_acceptance_ref:contentRef(acceptanceRaw)};
}
export function assemble({subjectRaw,acceptanceRaw,payloadRaw,independentReportRaw}){
 const expected=signingPayload(subjectRaw,acceptanceRaw),p=JSON.parse(payloadRaw),r=JSON.parse(independentReportRaw);
 assert.deepEqual(p,expected,'exact accepted payload');
 assert.equal(r.kind,'ROOT_SIGNING_PAYLOAD_SIGNATURE_BINDING');assert.equal(r.status,'VERIFIED');
 assert.equal(r.independent_reviewer,'/root/project_list_auth_fix');
 assert.deepEqual(r.repository,{full_name:'tdoljyj/cross-memory-system',private:true});
 assert.equal(r.pr.state,'MERGED');assert.equal(r.pr.merged_by,'tdoljyj');
 assert.equal(r.merge.sha,r.pr.merge_commit_sha);assert.match(r.merge.sha,/^[a-f0-9]{40}$/);
 assert.equal(r.merge.verification.verified,true);assert.equal(r.merge.verification.reason,'valid');assert.equal(r.merge.committer_login,'web-flow');
 assert.equal(r.merge.parents.length,2);assert.notEqual(r.merge.parents[0],r.merge.parents[1]);
 for(const x of [...r.merge.parents,r.merge.tree])assert.match(x,/^[a-f0-9]{40}$/);
 assert.equal(r.payload.file_sha256,sha(payloadRaw));assert.equal(r.payload.payload_sha256,canonicalDigest(p));
 assert.equal(r.payload.blob_sha,contentRef(payloadRaw).uri.split('/').at(-1));
 assert.equal(r.payload.review_subject_sha256,reviewSubjectDigest(p));assert.equal(r.acceptance.sha256,sha(acceptanceRaw));
 const root={...p,signature_binding:{owner_merge_commit:r.merge.sha,signed_object_sha256:signaturePayloadDigest(p),signature_evidence_ref:contentRef(independentReportRaw)}};
 validateRootShape(root);
 const envelope=JSON.parse(subjectRaw);
 return {root,append_request:{body:root,expected_sequence:envelope.source.current_sequence,generation_id:generation,idempotency_key:'forward-root-generation2-20260908',kind:'GENERATION_REGISTERED',metadata_binding_sha256:envelope.source.metadata_binding_sha256,predecessor_generation_id:root.predecessor.generation_id,root_set_id:root.root_set_id},authority_effect:'NONE',registered:false};
}
