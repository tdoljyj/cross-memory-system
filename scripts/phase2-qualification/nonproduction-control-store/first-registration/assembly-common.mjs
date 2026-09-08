// Pure local assembly. Caller supplies independently verified, hash-pinned evidence.
// No network/DB access and no claim that local Git identities are remotely persisted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonicalDigest,reviewSubjectDigest,signaturePayloadDigest,validateRootShape} from '../protocol-successor/validate-successor.mjs';
export const repo=fileURLToPath(new URL('../../../../',import.meta.url));
export const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
export function artifact(name,expected){
 const full=path.resolve(repo,name),relative=path.relative(repo,full).replaceAll('\\','/');
 assert.ok(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative),'repository artifact only');
 const raw=fs.readFileSync(full),digest=sha(raw);
 if(expected!==undefined){assert.match(expected,/^[a-f0-9]{64}$/);assert.equal(digest,expected,'independently pinned artifact bytes');}
 const blob=crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
 return {path:relative,raw,value:JSON.parse(raw),sha256:digest,blob,ref:{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob,sha256:digest}};
}
const subjectPath='scripts/phase2-qualification/nonproduction-control-store/first-registration/purpose-successor/RootReviewSubject.json';
export function loadSubject(){return artifact(subjectPath,'dd669911912ab74893e06531e9186d4fb31d373c0e8c086989026fe547ac5845');}
export function checkAcceptance(acceptance){
 const loaded=loadSubject(),envelope=loaded.value,s=envelope.subject,a=acceptance.value;
 assert.equal(a.state,'ACCEPTED_EXACT_FIRST_ROOT_REGISTRATION_SUBJECT_AND_PURPOSE_BINDINGS');
 assert.equal(a.independent_reviewer,'/root/project_list_auth_fix');
 assert.equal(a.review_subject_sha256,reviewSubjectDigest(s));
 assert.equal(a.root_set_id,s.root_set_id);assert.equal(a.control_trust_root_generation,s.control_trust_root_generation);
 assert.equal(a.subject_file.path,loaded.path);assert.equal(a.subject_file.sha256,loaded.sha256);
 assert.deepEqual(a.accepted_scope,s.scope);assert.equal(a.accepted_audience,s.audience);
 assert.deepEqual(a.accepted_algorithm_config,s.algorithm_config);assert.equal(a.schema_sha256,s.schema_digest);
 assert.equal(a.accepted_issuer_purposes.length,s.issuer_bindings.length);
 for(const i of s.issuer_bindings){const x=a.accepted_issuer_purposes.filter(p=>p.purpose===i.purpose);assert.equal(x.length,1);assert.equal(x[0].accepted,true);assert.equal(x[0].audience,i.audience);assert.equal(x[0].subject_id,i.subject_id);assert.equal(x[0].signing_service,i.signing_service);}
 const inputs=artifact('scripts/phase2-qualification/nonproduction-control-store/first-registration/purpose-successor/AcceptedBindingInputs.json','bdb6744fe0b384976f870983caab1f8a64afa813fddebacd092fa8a04fd77f16');
 assert.deepEqual(a.accepted_binding.known_values,inputs.value.known_values);
 assert.equal(a.accepted_protocol_mapping_sha256,inputs.value.known_values.protocol_mapping_sha256);
 assert.ok(Date.now()>=Date.parse(s.not_before)&&Date.now()<Date.parse(s.expires_at),'Owner window expired/not yet valid');
 return {subject:s,known:inputs.value.known_values};
}
export function signingPayload(acceptance){const {subject}=checkAcceptance(acceptance);return {...structuredClone(subject),independent_acceptance_ref:acceptance.ref};}
export function assemble(payload,acceptance,report){
 const expected=signingPayload(acceptance),p=payload.value,r=report.value;
 assert.equal(canonicalDigest(p),canonicalDigest(expected),'exact accepted signing payload');
 assert.equal(p.signature_binding,undefined);
 assert.equal(r.kind,'ROOT_SIGNING_PAYLOAD_SIGNATURE_BINDING');assert.equal(r.status,'VERIFIED');
 assert.deepEqual(r.repository,{full_name:'tdoljyj/cross-memory-system',private:true});
 assert.equal(r.pr.state,'MERGED');assert.equal(r.pr.merged_by,'tdoljyj');assert.ok(Number.isSafeInteger(r.pr.number)&&r.pr.number>0&&r.pr.number!==25);
 assert.equal(r.pr.url,'https://github.com/tdoljyj/cross-memory-system/pull/'+r.pr.number);
 assert.match(r.merge.sha,/^[a-f0-9]{40}$/);assert.equal(r.pr.merge_commit_sha,r.merge.sha);
 assert.notEqual(r.merge.sha,'4d7f93c17cf7d126e771cf8aca6299c868cba0a9','PR25 does not sign this payload');
 assert.equal(r.merge.verification.verified,true);assert.equal(r.merge.verification.reason,'valid');assert.equal(r.merge.committer_login,'web-flow');
 assert.equal(r.merge.parents.length,2);for(const parent of r.merge.parents)assert.match(parent,/^[a-f0-9]{40}$/);assert.notEqual(r.merge.parents[0],r.merge.parents[1]);assert.match(r.merge.tree,/^[a-f0-9]{40}$/);
 assert.equal(r.payload.artifact_path,payload.path);assert.equal(r.payload.blob_sha,payload.blob);assert.equal(r.payload.file_sha256,payload.sha256);
 assert.equal(r.payload.payload_sha256,signaturePayloadDigest(p));assert.equal(r.payload.review_subject_sha256,reviewSubjectDigest(p));
 assert.equal(r.acceptance.artifact_path,acceptance.path);assert.equal(r.acceptance.sha256,acceptance.sha256);
 const root={...p,signature_binding:{owner_merge_commit:r.merge.sha,signed_object_sha256:signaturePayloadDigest(p),signature_evidence_ref:report.ref}};
 const shape=validateRootShape(root),{known}=checkAcceptance(acceptance);
 return {root,binding:{...known,registration_acceptance_sha256:acceptance.sha256,signature_evidence_sha256:report.sha256},shape};
}
export function writeNew(directory,objects){
 fs.mkdirSync(directory,{recursive:false});
 for(const [name,value] of Object.entries(objects))fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
}
