// Local review preparation only. Never registers, signs, changes pins or contacts a service.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {canonicalDigest,reviewSubjectDigest,readControlUri,rootUri} from '../protocol-successor/validate-successor.mjs';
export const generation='ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12';
const previous='ctrgen_352785779b64458a889d571360e2d2d5';
const previousDigest='df0544694243768a473a7d45b50aa612937755aee9bf6b785ce8165363f2325a';
const binding='793aa13a245153c36a2806eb78dc9c3f677ddb8ad678b3afe5fe2f63a0c2e4fb';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export async function prepare(source,qualificationRaw,statusRaw){
 const r=source.root_read;
 assert.equal(r.sequence,1);assert.equal(r.events.length,1);assert.equal(r.generation_id,previous);
 assert.equal(r.metadata_binding_sha256,binding);assert.equal(r.authority_effect,'NONE');
 const read=await readControlUri(rootUri,{read:async()=>r}),old=read.data;
 assert.equal(canonicalDigest(old),previousDigest);
 const metadata=JSON.parse(qualificationRaw),status=JSON.parse(statusRaw);
 assert.equal(sha(qualificationRaw),'9f475e2c2eedc02e50a5438c80d89f625ed5aa0ef2465a0581e349a1e8caa16d');
 assert.equal(sha(statusRaw),'23ca2fe807dd454d8037168531a1d05890be6fbb5575cd18e8e6482f2ef47b80');
 for(const m of [metadata,status]){assert.equal(m.state,'ACCEPTED_LIMITED_ISSUER_PURPOSE_METADATA');assert.equal(m.subject_id,'tdoljyj');assert.equal(m.signing_service,'web-flow');}
 const ref=raw=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex'),sha256:sha(raw)});
 assert.equal(metadata.independent_reviewer,'/root/project_list_auth_fix');
 assert.equal(metadata.root_set_id,old.root_set_id);
 assert.equal(metadata.control_trust_root_generation,generation);
 assert.deepEqual(metadata.accepted_scope,old.scope);assert.equal(metadata.accepted_audience,old.audience);
 assert.equal(metadata.expires_at,old.expires_at);
 assert.deepEqual(metadata.accepted_issuer_purposes.map(p=>p.purpose).sort(),['GATE_AUTHORIZATION','GATE_RESULT']);
 assert.ok(metadata.accepted_issuer_purposes.every(p=>p.accepted===true&&p.audience===old.audience));
 assert.equal(metadata.accepted_algorithm_config.signature_verification,'GITHUB_API_VERIFIED_OWNER_SINGLE_PARENT_COMMITMENT_V1_CANDIDATE');
 assert.equal(metadata.root_review_subject_sha256_included,false);
 assert.equal(status.independent_reviewer,metadata.independent_reviewer);
 assert.equal(status.root_set_id,old.root_set_id);assert.equal(status.control_trust_root_generation,generation);
 assert.deepEqual(status.accepted_scope,old.scope);assert.equal(status.accepted_audience,old.audience);
 assert.equal(status.expires_at,old.expires_at);assert.equal(status.not_before,metadata.not_before);
 assert.deepEqual(status.accepted_issuer_purposes.map(p=>p.purpose),['STATUS']);
 assert.ok(status.accepted_issuer_purposes.every(p=>p.accepted===true&&p.audience===old.audience));
 assert.deepEqual(status.accepted_algorithm_config,old.algorithm_config);assert.equal(status.root_review_subject_sha256_included,false);
 const next=structuredClone(old);delete next.independent_acceptance_ref;delete next.signature_binding;
 next.control_trust_root_generation=generation;next.generation_ordinal=2;
 next.predecessor={generation_id:previous,sha256:previousDigest};
 for(const issuer of next.issuer_bindings)issuer.qualification_ref=ref(issuer.purpose==='STATUS'?statusRaw:qualificationRaw);
 next.not_before=metadata.not_before;
 assert.ok(Date.parse(next.not_before)>=Date.parse(source.observed_at_utc)&&Date.parse(next.not_before)<Date.parse(next.expires_at));
 next.history.prefix_sequence=1;next.history.prefix_digest=canonicalDigest(r.events);
 next.history.minimum_accepted_generation=generation;
 const revocations=r.events.filter(e=>['ROOT_REVOKED','GENERATION_REVOKED'].includes(e.request.kind));
 assert.equal(revocations.length,0);next.revocation.event_set_digest=canonicalDigest(revocations);next.revocation.as_of=next.not_before;
 assert.deepEqual(next.algorithm_config,old.algorithm_config);assert.deepEqual(next.scope,old.scope);assert.deepEqual(next.owner_approval_ref,old.owner_approval_ref);
 return {state:'PREPARED_NOT_REGISTERED_FORWARD_ROOT_REVIEW_SUBJECT',review_subject_sha256:reviewSubjectDigest(next),subject:next,
 source:{observed_at_utc:source.observed_at_utc,current_sequence:1,current_generation:previous,current_root_canonical_sha256:previousDigest,history_prefix_canonical_sha256:canonicalDigest(r.events),metadata_binding_sha256:binding},
 admission_boundary:{actual_root_acceptance_required:true,actual_owner_pr_signature_required:true,actual_append_cas_required:true,accepted_binding_changed:false,old_root_changed:false,ga_issued:false,root_registered:false}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [sourcePath,metadataPath,statusPath,outputPath]=process.argv.slice(2);assert.ok(sourcePath&&metadataPath&&statusPath&&outputPath,'four explicit paths required');
 const raw=fs.readFileSync(sourcePath);const result=await prepare(JSON.parse(raw),fs.readFileSync(metadataPath),fs.readFileSync(statusPath));
 result.source.source_readback_file_sha256=sha(raw);
 fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({state:result.state,generation,review_subject_sha256:result.review_subject_sha256,history_prefix_sha256:result.source.history_prefix_canonical_sha256}));
}
