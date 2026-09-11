// Proposed forward signature carrier, NOT the accepted Owner PR-merge algorithm.
// Pure construction/verification; no network, mutation, key, or authority issuance.
import crypto from 'node:crypto';
export const repository='tdoljyj/cross-memory-system';
export const branch='codex/phase2-qualification-evidence-20260908';
export const prefix='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/dynamic-signature-commitments/';
export const algorithm='GITHUB_API_VERIFIED_OWNER_SINGLE_PARENT_COMMITMENT_V1_CANDIDATE';
export const project='uscrdifznmlvczcekqpw';
export const rootGeneration='ctrgen_2e778ca66244459f974b081edca8c04e';
export const root5Generation='ctrgen_e5df432221344996afc04b5638121d96';
export const root6Generation='ctrgen_e8b3f4154c3875d3c2214aa0464bc810';
export const audience='urn:clued:audience:skill-coexistence-qualification:'+project;
const sha=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const hex=(s,n)=>typeof s==='string'&&new RegExp('^[0-9a-f]{'+n+'}$').test(s);
const constructed=new WeakSet();
const plans=new WeakMap();
const freezeDeep=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}return value;};
export function makeCommitment(raw,type){
 need(typeof raw==='string'&&Buffer.byteLength(raw)<=131072,'bounded_exact_payload_required');
 const payload=JSON.parse(raw);
 // This narrow encoding rejects duplicate keys, whitespace ambiguities and
 // non-finite numeric spellings by exact roundtrip. No signature field excluded.
 need(JSON.stringify(payload)+'\n'===raw,'exact_compact_unique_json_required');
 const ga=type==='GateAuthorization';need(ga||type==='GateResultReceipt','unsupported_live_object_type');
 const id=payload[ga?'gate_authorization_id':'gate_result_receipt_id'];
 need(typeof id==='string'&&new RegExp('^'+(ga?'ga':'grr')+'_[A-Za-z0-9_-]{1,128}$').test(id),'fixed_typed_id_required');
 const purpose=ga?'GATE_AUTHORIZATION':'GATE_RESULT';
 const uri='urn:clued:'+(ga?'gate-authorization:':'gate-result-receipt:')+project+':'+id;
 const boundRootGeneration=payload.control_trust_root_generation;
 need(payload.issuer_purpose===purpose&&payload.audience===audience&&[rootGeneration,root5Generation,root6Generation].includes(boundRootGeneration),'purpose_audience_generation_mismatch');
 need(hex(payload.schema_digest,64),'exact_schema_digest_required');
 // A stable same-domain proof URI breaks no hash by exclusion: it is itself
 // inside the complete signed payload. Actual proof storage/mapping is pending.
 need(payload.signature===uri+'#signature','fixed_detached_proof_uri_required');
 const result=Object.freeze({kind:'HISTORICAL_SIGNATURE_COMMITMENT',algorithm,repository,branch,object_type:type,object_id:id,
  store_uri:uri,payload_sha256:sha(raw),schema_digest:payload.schema_digest,audience,root_generation:boundRootGeneration,
  issuer_purpose:purpose,issuer:'tdoljyj',executor_provenance:'Codex@DESK-W-591',authority_effect:'NONE'});
 constructed.add(result);return result;
}
export function prepareMutation({commitment,privateRepository,head,existingPath}){
 need(privateRepository?.full_name===repository&&privateRepository.private===true,'fixed_private_repository_required');
 need(hex(head,40)&&existingPath===null,'exact_existing_head_and_absent_target_required');
 need(constructed.has(commitment),'exact_constructed_commitment_required');
 const filename=prefix+commitment.object_type+'/'+commitment.object_id+'.json';
 need(['GateAuthorization','GateResultReceipt'].includes(commitment.object_type)&&/^(ga|grr)_[A-Za-z0-9_-]{1,128}$/.test(commitment.object_id),'invalid_fixed_target');
 const raw=JSON.stringify(commitment)+'\n';
 const plan={query:'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}',
  variables:{input:{branch:{repositoryNameWithOwner:repository,refName:branch},expectedHeadOid:head,
   message:{headline:'Record isolated qualification signature commitment '+commitment.object_id},
   fileChanges:{additions:[{path:filename,contents:Buffer.from(raw,'utf8').toString('base64')}]}}},
  expectation:{parent:head,path:filename,raw,commitment_sha256:sha(raw)}};
 plans.set(plan,sha(JSON.stringify(plan)));return freezeDeep(plan);
}
export function verifyObservedCommit({plan,commit,comparison,tree,blobRaw,now,expiresAt}){
 need(plans.has(plan)&&plans.get(plan)===sha(JSON.stringify(plan)),'unrecognized_or_modified_plan');
 need(typeof now==='number'&&Number.isFinite(now)&&Number.isFinite(Date.parse(expiresAt))&&now<Date.parse(expiresAt),'expired_signature_attempt');
 need(hex(commit?.sha,40)&&commit.parents?.length===1&&commit.parents[0].sha===plan.expectation.parent,'single_exact_parent_required');
 need(commit.author?.login==='tdoljyj'&&commit.committer?.login==='web-flow','observed_owner_web_identity_required');
 need(commit.commit?.verification?.verified===true&&commit.commit.verification.reason==='valid','actual_valid_github_signature_required');
 need(typeof commit.commit.verification.signature==='string'&&commit.commit.verification.signature.length>0
  &&typeof commit.commit.verification.payload==='string'&&commit.commit.verification.payload.length>0,'raw_verification_material_required');
 need(comparison?.base_commit?.sha===plan.expectation.parent&&comparison.commits?.length===1&&comparison.commits[0].sha===commit.sha,'exact_parent_comparison_required');
 need(comparison.files?.length===1&&comparison.files[0].filename===plan.expectation.path&&comparison.files[0].status==='added','single_new_path_only');
 need(hex(commit.commit?.tree?.sha,40)&&tree?.sha===commit.commit.tree.sha&&tree.truncated===false&&Array.isArray(tree.tree),'exact_complete_commit_tree_required');
 const entries=tree.tree.filter(entry=>entry.path===plan.expectation.path);
 need(entries.length===1&&entries[0].type==='blob'&&entries[0].mode==='100644'&&hex(entries[0].sha,40),'exact_regular_blob_required');
 const bytes=Buffer.from(blobRaw,'utf8');
 const blobSha=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0','utf8')).update(bytes).digest('hex');
 need(blobSha===entries[0].sha&&comparison.files[0].sha===blobSha,'signed_tree_blob_digest_mismatch');
 need(blobRaw===plan.expectation.raw,'exact_immutable_blob_readback_required');
 return {state:'HISTORICAL_SIGNATURE_OBSERVED_ONLY',algorithm,commit_sha:commit.sha,commitment_sha256:plan.expectation.commitment_sha256,authority_effect:'NONE'};
}
// The host must CreateNew-persist one attempt ticket before mutation. Any lost
// response, changed head, failed verification or timeout stays UNKNOWN: inspect
// immutable objects by exact references, never automatically re-sign or overwrite.
// Current root/issuer/GA/epochs and one-reservation/one-GRR remain SQL obligations.
