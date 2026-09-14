import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';

const REPOSITORY='tdoljyj/cross-memory-system';
const GH=`https://api.github.com/repos/${REPOSITORY}/git/blobs/`;
const repo='/tmp/root9-exact-pair-20260914b';
const stage2='/tmp/root9-exact-pair-stage2-20260915a';
const out='/tmp/root9-exact-pair-stage3-20260915a';
const sourceCommit='53f4ef49d024b6f7b24f5695d40e1e59b0ff8a62';
const sourceTree='001fed3cbb2eb841929338f42d28887211cd1032';
const sourceOwnerMerge='461581e6a19af45c7091f58cf3fe7fcbb39a78e8';
const stage2Head='44c5638c5e717bdd1e296a84b9d1a1dd44cea106';
const stage2Merge='ec6e3df1cc36d4ef8dbd2bfb91555aa5a604f5b6';
const stage2Tree='69c39c39c4dbca762ad889236637000a2fa7f944';
const controller='9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1';
const oldController='c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a';
const qualificationSha='3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa';
const qualificationBlob='45e4519e7cf8acd5261f339913758797f5eae2ef';
const repairSha='21eb0391fb2de19789441eca3ae8915fa9741ed0aad56994ec469f52fe7ec10a';
const repairBlob='87571bfd9ae43c8652c1a4f182abb431c0b964f2';
const statusRawSha='4eef9d9a49e7958417b4c76e543462dca4c4abcd10d78d563701d77261f04c19';
const statusBlob='b970c2c45c4de0089e9677a680783a97dccb39a2';
const statusS='a765cc9a6506c8486cb46087cbfa0c9f81f0ff03df23cb0dd421ea83f877a154';
const manifestBlob='987f39a04834fa7253890f41737aee02fd8f21c8';
const manifestPath='scripts/phase2-qualification/control-context-verifier-recovery-successor-root9-exact-pair/ControllerSourceManifest.candidate.json';
const qPath='work/recovery-root9/exact-pair-successor-stage2/ControllerQualification.root9.exact-pair.candidate.json';
const repairPath='work/recovery-root9/exact-pair-successor-stage2/Root9ExactPairRepairAcceptance.candidate.json';
const statusPath='work/recovery-root9/exact-pair-successor-stage2/Status28SigningPayload.json';
const evidencePath='work/recovery-root9/exact-pair-successor-stage1/DockerNotStartedObservation.json';

const need=(v,m)=>{if(!v)throw Error(m);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const ref=(b,s)=>({uri:GH+b,sha256:s});
const jsonBytes=v=>Buffer.from(JSON.stringify(v,null,2)+'\n','utf8');
function canonical(v){
 if(typeof v==='number')need(Number.isSafeInteger(v),'UNSAFE_NUMBER');
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 return JSON.stringify(v);
}
const canonicalDigest=v=>sha(Buffer.from(canonical(v)+'\n','utf8'));
const api=e=>JSON.parse(execFileSync('/usr/local/bin/gh',['api','--hostname','github.com',e],{encoding:'utf8',timeout:10000,maxBuffer:32*1024*1024}));
function writeExact(name,bytes){const p=out+'/'+name;if(fs.existsSync(p))need(fs.readFileSync(p).equals(bytes),'REFUSE_OVERWRITE:'+name);else fs.writeFileSync(p,bytes);}

fs.mkdirSync(out,{recursive:true});
const pr=api(`repos/${REPOSITORY}/pulls/180`),commit=api(`repos/${REPOSITORY}/commits/${stage2Merge}`);
need(pr.merged===true&&pr.merged_by?.login==='tdoljyj'&&pr.merge_commit_sha===stage2Merge,'ACTUAL_STAGE2_OWNER_MERGE');
need(commit.commit?.verification?.verified===true&&commit.commit.verification.reason==='valid'&&commit.committer?.login==='web-flow','STAGE2_GITHUB_VERIFIED');
need(JSON.stringify(commit.parents.map(x=>x.sha))===JSON.stringify([sourceOwnerMerge,stage2Head])&&commit.commit.tree.sha===stage2Tree,'STAGE2_EXACT_PARENTS_TREE');
const tree=api(`repos/${REPOSITORY}/git/trees/${stage2Tree}?recursive=1`);
need(tree.truncated===false&&tree.sha===stage2Tree,'FULL_STAGE2_TREE');
const stage2Files=[qPath,repairPath,statusPath,'work/recovery-root9/exact-pair-successor-stage2/Stage2BuildManifest.json'];
const stage2Artifacts={};
for(const p of stage2Files){const x=tree.tree.filter(e=>e.path===p&&e.type==='blob');need(x.length===1,'STAGE2_ARTIFACT:'+p);const b=api(`repos/${REPOSITORY}/git/blobs/${x[0].sha}`),raw=Buffer.from(b.content,'base64');stage2Artifacts[p]={ref:ref(x[0].sha,sha(raw)),bytes:raw.length};}
need(stage2Artifacts[qPath].ref.sha256===qualificationSha&&stage2Artifacts[qPath].ref.uri.endsWith('/'+qualificationBlob),'Q_IDENTITY');
need(stage2Artifacts[repairPath].ref.sha256===repairSha&&stage2Artifacts[repairPath].ref.uri.endsWith('/'+repairBlob),'REPAIR_IDENTITY');
need(stage2Artifacts[statusPath].ref.sha256===statusRawSha&&stage2Artifacts[statusPath].ref.uri.endsWith('/'+statusBlob),'STATUS_IDENTITY');

const publication={
 object_type:'Root9ExactPairStage2OwnerPublicationEvidence',schema_version:'1.0',state:'VERIFIED_STAGE2_EXACT_PAIR_OWNER_MERGE',repository:REPOSITORY,pull_request:180,
 merge:{sha:stage2Merge,tree:stage2Tree,parents:[sourceOwnerMerge,stage2Head],first_parent:sourceOwnerMerge,source_parent:stage2Head,author_login:'tdoljyj',merged_by:'tdoljyj',committer_login:'web-flow',base_ref:'main',verification:{verified:true,reason:'valid'},merged_at:pr.merged_at},
 independent_review:{reviewer:'/root/root9_recovery_review',decision:'STAGE2_PUBLICATION_GO',artifact_count:12,git_blob_sha_and_bytes_checked:12,github_blob_refs_checked:29,missing_refs:0,sha_mismatches:0},
 artifacts:{controller_qualification:{path:qPath,...stage2Artifacts[qPath]},repair_acceptance:{path:repairPath,...stage2Artifacts[repairPath]},status28_signing_payload:{path:statusPath,...stage2Artifacts[statusPath],signed_payload_sha256:statusS},stage2_build_manifest:{path:stage2Files[3],...stage2Artifacts[stage2Files[3]]}},
 boundary:{database_writes:0,signature_mutations:0,activation:false,expected_current_cas:false,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false},authority_effect:'NONE'
};
const publicationRaw=jsonBytes(publication),publicationRef=ref(blob(publicationRaw),sha(publicationRaw));

const unsignedRaw=fs.readFileSync(stage2+'/Status28SigningPayload.json');
need(sha(unsignedRaw)===statusRawSha&&blob(unsignedRaw)===statusBlob,'STATUS28_EXACT_RAW');
const unsigned=JSON.parse(unsignedRaw);need(!Object.hasOwn(unsigned,'signature_binding')&&canonicalDigest(unsigned)===statusS,'STATUS28_EXACT_S');
const signatureEvidence={
 schema_version:1,object_type:'StatusOwnerMergeSignatureEvidence',state:'STAGE2_OWNER_MERGE_BOUND_VERIFIED',authority_effect:'NONE',repository:REPOSITORY,issuer_purpose:'STATUS',status_manifest_id:unsigned.status_manifest_id,control_trust_root_generation:'ctrgen_308a1dfc185cff633892638581e0a34c',
 merge:{sha:stage2Merge,tree:stage2Tree,parents:[sourceOwnerMerge,stage2Head],required_verification:{verified:true,verification_reason:'valid',two_parents:true,committer:'web-flow',merged_by:'tdoljyj',base_branch:'main',exact_merged_pr:180},merged_at:pr.merged_at},
 payload:{artifact_path:statusPath,blob_sha:statusBlob,file_sha256:statusRawSha,signed_object_sha256:statusS,canonicalization_id:'SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE',excluded_fields:['signature_binding']},
 bound_refs:{controller_manifest:ref(manifestBlob,controller),controller_qualification:ref(qualificationBlob,qualificationSha),repair_acceptance:ref(repairBlob,repairSha)},
 verification_boundary:{stage2_verified_as_unique_owner_merge_into_main:true,exact_stage2_artifacts_verified:true,database_write:false,budget_reservation:false,capacity_value_change:false,refund:false,ga_dispatch:false},no_full_status_reverse_hash:true
};
const signatureRaw=jsonBytes(signatureEvidence),signatureRef=ref(blob(signatureRaw),sha(signatureRaw));
const full=structuredClone(unsigned);full.signature_binding={owner_merge_commit:stage2Merge,signed_object_sha256:statusS,signature_evidence_ref:signatureRef};
const unsignedAgain=structuredClone(full);delete unsignedAgain.signature_binding;
need(jsonBytes(unsignedAgain).equals(unsignedRaw)&&canonicalDigest(unsignedAgain)===statusS,'STATUS28_UNSIGNED_ROUNDTRIP');
const require=createRequire(repo+'/apps/clued-cloud/package.json'),Ajv=require('ajv');
const statusSchema=JSON.parse(fs.readFileSync(repo+'/scripts/phase2-qualification/control-context-verifier-recovery-successor-root9-exact-pair/status-manifest.root5.schema.json'));
const validate=new Ajv({allErrors:true,strict:false,validateFormats:false}).compile(statusSchema);need(validate(full),'STATUS28_SCHEMA:'+JSON.stringify(validate.errors));
const fullRaw=jsonBytes(full),fullRef=ref(blob(fullRaw),sha(fullRaw));

const runtime=JSON.parse(fs.readFileSync(repo+'/work/recovery-root9/postbudget-stage2/RuntimeAcceptance.root9.postbudget.json','utf8'));
runtime.authority_effect='NONE_UNTIL_EXACT_PAIR_STAGE3_OWNER_PUBLICATION_AND_EXPECTED_CURRENT_CAS';
runtime.accepted_at='2026-09-14T17:14:31Z';runtime.controller_digest=controller;
const subject=runtime.accepted_subject,ga=subject.expected_ga;
ga.controller_digest=controller;ga.controller_qualification_ref=ref(qualificationBlob,qualificationSha);
ga.artifact_refs=ga.artifact_refs.map(x=>x.sha256===oldController?ref(manifestBlob,controller):x);
need(ga.artifact_refs.some(x=>x.sha256===controller),'RUNTIME_MANIFEST_ARTIFACT');
const sourceManifest=JSON.parse(fs.readFileSync(repo+'/'+manifestPath,'utf8'));
const sourceTreeValue=api(`repos/${REPOSITORY}/git/trees/${sourceTree}?recursive=1`);need(sourceTreeValue.truncated===false,'FULL_SOURCE_TREE');
const sourceWanted=[{path:manifestPath,sha256:controller},...sourceManifest.files.map(x=>({path:x.path,sha256:x.sha256}))];
ga.source_ref={commit:sourceCommit,tree:sourceTree,blobs:sourceWanted.map(x=>{const m=sourceTreeValue.tree.filter(e=>e.path===x.path&&e.type==='blob');need(m.length===1,'SOURCE_PATH:'+x.path);return ref(m[0].sha,x.sha256);})};
need(ga.source_ref.blobs.length===24,'EXACT_24_SOURCE_BLOBS');
subject.late_bound_fields.status_manifest_ref={resolver:'STORED_STATUS_FROM_EXACT_OWNER_SIGNED_PAYLOAD_V1',signed_payload_sha256:statusS};
subject.bounded_series_materials.repairs.push({ref:ref(repairBlob,repairSha),publication:{commitSha:stage2Merge,artifactPath:repairPath}});
need(subject.bounded_series_materials.repairs.length===9,'EXACT_NINE_REPAIR_DESCRIPTORS');
subject.exact_pair_recovery={kind:'ROOT9_EXACT_PREDISPATCH_BUDGET_INHERITANCE',root_id:'ctr_414bd3c724264a83894b0c55cf2ab878',failed_ga_id:'ga_4a88b0436cf80beeb5e194c98bb0297e',failed_ga_sha256:'50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819',failed_controller_sha256:oldController,budget_sequence:102,budget_reservation_sha256:'51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a',successor_controller_digest:controller,not_started_evidence:{ref:ref('ce26b5130aa7cb5cd11fd5790747595312f7a349','ba0edadea01000daafd51fb8985870f6e6a946be3a3959102e998f800a2dcb20'),publication:{commitSha:sourceOwnerMerge,artifactPath:evidencePath}},root_unchanged:true,gate_unchanged:true,profile_unchanged:true,scope_unchanged:true,generations_unchanged:true,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false};
runtime.root9_binding.controller_qualification={ref:ref(qualificationBlob,qualificationSha),publication:{state:'OWNER_PUBLISHED_STAGE2',commitSha:stage2Merge,artifactPath:qPath}};
runtime.root9_binding.status28_signing_payload_ref=ref(statusBlob,statusRawSha);runtime.root9_binding.status28_signed_payload_sha256=statusS;
runtime.root9_binding.exact_pair_recovery={repair_acceptance_ref:ref(repairBlob,repairSha),stage2_publication_evidence_ref:publicationRef,inherited_budget_sequence:102,root_unchanged:true,gate_unchanged:true,profile_unchanged:true,scope_unchanged:true,generations_unchanged:true,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false};
const runtimeRaw=Buffer.from(JSON.stringify(runtime)+'\n','utf8'),runtimeRef=ref(blob(runtimeRaw),sha(runtimeRaw));

const result={state:'ROOT9_EXACT_PAIR_STAGE3_MATERIALS_BUILT',stage2_owner_merge:stage2Merge,stage2_publication_evidence_ref:publicationRef,status28_signature_evidence_ref:signatureRef,status28_generation_ref:fullRef,status28_signed_object_sha256:statusS,runtime_acceptance_ref:runtimeRef,controller_digest:controller,controller_qualification_ref:ref(qualificationBlob,qualificationSha),repair_acceptance_ref:ref(repairBlob,repairSha),source_blob_count:ga.source_ref.blobs.length,repair_descriptor_count:subject.bounded_series_materials.repairs.length,status_schema_valid:true,database_writes:0,signature_mutations:0,activation:false,expected_current_cas:false,budget_sequence:102,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false};
writeExact('Stage2PublicationEvidence.verified.json',publicationRaw);
writeExact('Status28SignatureEvidence.json',signatureRaw);
writeExact('Status28Generation.json',fullRaw);
writeExact('RuntimeAcceptance.root9.exact-pair.json',runtimeRaw);
writeExact('STAGE3_RESULT.json',jsonBytes(result));
process.stdout.write(JSON.stringify(result,null,2)+'\n');
