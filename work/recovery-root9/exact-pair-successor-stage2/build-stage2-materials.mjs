import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo='/tmp/root9-exact-pair-20260914b';
const sha=raw=>crypto.createHash('sha256').update(raw,'utf8').digest('hex');
const blob=raw=>crypto.createHash('sha1').update(Buffer.from('blob '+Buffer.byteLength(raw)+'\0')).update(raw,'utf8').digest('hex');
const ref=(blobSha,sha256)=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blobSha,sha256});
const need=(ok,why)=>{if(!ok)throw Error(why);};
const pretty=value=>JSON.stringify(value,null,2)+'\n';
const currentQualification=JSON.parse(fs.readFileSync(repo+'/work/recovery-root9/postbudget-stage2/ControllerQualification.root9.postbudget.candidate.json','utf8'));
const currentStatus=JSON.parse(fs.readFileSync(repo+'/work/recovery-root9/postbudget-stage2/Status27SigningPayload.json','utf8'));
const blockedGrrRaw=fs.readFileSync(here+'/BlockedGRR.raw.json','utf8');
const blockedGrrSha=sha(blockedGrrRaw);
need(blockedGrrSha==='fd1b884641e0752bdf3e5446dfdca5efe2d0f6d0ef27d3a9db201aeb174a772d','EXACT_BLOCKED_GRR_CANDIDATE');

const controllerDigest='9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1';
const controllerRef=ref('987f39a04834fa7253890f41737aee02fd8f21c8',controllerDigest);
const sourceMerge='461581e6a19af45c7091f58cf3fe7fcbb39a78e8';
const sourceCommit='53f4ef49d024b6f7b24f5695d40e1e59b0ff8a62';
const sourceTree='001fed3cbb2eb841929338f42d28887211cd1032';
const notStartedRef=ref('ce26b5130aa7cb5cd11fd5790747595312f7a349','ba0edadea01000daafd51fb8985870f6e6a946be3a3959102e998f800a2dcb20');
const selftestRef=ref('27adb2378a13da974a0bd0fa78b08cdb36f1162c','085e72d538e7823fbb56abe6f693bf9ec642779f3e98d126ebe3751180987455');
const intentRef=ref('cc0c5ceb8c56921e8100d384c1adc001b61e0ea9','0d5ad3c6ba602e0fb2d795906e7f03f4f4209600c449a100fe76a6ff45dfecd0');
const authorizationRef=ref('6eba5844c8ff6f3038a0c9425710a7bf3b94f06f','d0695a9c197e4c82dc1fb5fd33705f05c9aed2c3b8bdc83d6b34cf18425d3d65');

const qualification=structuredClone(currentQualification);
qualification.controller_digest=controllerDigest;
qualification.controller_source_manifest_ref=controllerRef;
qualification.test_evidence_refs=[...currentQualification.test_evidence_refs,selftestRef];
qualification.correction_evidence_refs=[...currentQualification.correction_evidence_refs,notStartedRef,intentRef,authorizationRef];
qualification.runtime_guard_candidate_sha256='0cd8e48c30a6d90bd153dcc3b7b5867a94c21b24f30744e95976de453fccfa72';
qualification.source_publication={owner_merge_commit:sourceMerge,source_commit:sourceCommit,source_tree:sourceTree,merge_tree:sourceTree,
 controller_manifest_entries:23,controller_directory_files_including_manifest:24,exact_published_files:28};
qualification.candidate_boundary='EXACT_PAIR_STAGE2_OWNER_PUBLICATION_REQUIRED_BEFORE_RUNTIME_USE';
qualification.postbudget_repair={
 scope:'ROOT9_EXACT_PREDISPATCH_BUDGET_INHERITANCE_ONLY',root_generation_changed:false,
 failed_ga_id:'ga_4a88b0436cf80beeb5e194c98bb0297e',
 failed_ga_sha256:'50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819',
 failed_receipt_sha256:blockedGrrSha,
 inherited_pending_budget:{sequence:102,uri:'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',
  sha256:'51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a',seconds:600,evidence_bytes:134217728,
  automatic_refund:false,inherited:true,new_allocation:false,second_budget_allocation:false},
 history_rewritten:false,refund:false,capacity_change:false,second_budget_allocation:false,budget_reassignment:false
};
const qualificationRaw=pretty(qualification),qualificationSha=sha(qualificationRaw),qualificationRef=ref(blob(qualificationRaw),qualificationSha);

const repair={
 state:'ACCEPTED_EXACT_ROOT9_PREDISPATCH_BUDGET_INHERITANCE_REPAIR',
 independent_reviewer:'/root/root9_recovery_review',
 failed_ga_id:'ga_4a88b0436cf80beeb5e194c98bb0297e',
 failed_ga_sha256:'50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819',
 failed_receipt_sha256:blockedGrrSha,
 root_id:'ctr_414bd3c724264a83894b0c55cf2ab878',budget_sequence:102,
 budget_reservation_sha256:'51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a',
 not_started_evidence_ref:notStartedRef,successor_controller_digest:controllerDigest,
 gate_id:'G-PREENTRY-SKILL-QUALIFICATION',profile_digest:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
 scope_digest:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
 runner_generation:'runnergen_a256855fec9441839105c69b746c5244',credential_generation:'credgen_bac92a11e7144a3fb9e67f40a6a07d11',
 session_generation:'sessiongen_ffb02a907d334b0da0b37bf457a758c2',
 root_unchanged:true,gate_unchanged:true,profile_unchanged:true,scope_unchanged:true,generations_unchanged:true,
 refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false,new_action_authorized:false,
 source_controller_owner_merge_commit:sourceMerge,authority_effect:'NONE'
};
const repairRaw=pretty(repair),repairSha=sha(repairRaw),repairRef=ref(blob(repairRaw),repairSha);

const status=structuredClone(currentStatus);
status.status_manifest_id='sm_root9_status28_exact_pair_recovery_v1';
status.as_of='2026-09-14T16:51:00Z';status.generation=28;
status.observations.controller_digest=controllerDigest;
const oldQualificationSha='a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013';
const oldControllerSha='c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a';
status.source_refs=status.source_refs.map(x=>x.sha256===oldQualificationSha?qualificationRef:x.sha256===oldControllerSha?controllerRef:x);
for(const x of [repairRef,notStartedRef,selftestRef,intentRef,authorizationRef])if(!status.source_refs.some(y=>y.uri===x.uri&&y.sha256===x.sha256))status.source_refs.push(x);
status.source_digests=[...new Set(status.source_refs.map(x=>x.sha256))];
for(const h of [status.observations.profile_digest,status.observations.gate_digest,status.observations.controller_digest,status.observations.scope_digest])
 if(!status.source_digests.includes(h))status.source_digests.push(h);
const statusRaw=pretty(status),statusSha=sha(statusRaw),statusRef=ref(blob(statusRaw),statusSha);

const manifest={object_type:'Root9ExactPairStage2BuildManifest',schema_version:'1.0',
 source_owner_merge_commit:sourceMerge,controller_digest:controllerDigest,blocked_grr_sha256:blockedGrrSha,
 artifacts:{
  controller_qualification:{ref:qualificationRef,bytes:Buffer.byteLength(qualificationRaw)},
  repair_acceptance:{ref:repairRef,bytes:Buffer.byteLength(repairRaw)},
  status28_signing_payload:{ref:statusRef,bytes:Buffer.byteLength(statusRaw)}
 },
 invariants:{root_unchanged:true,gate_unchanged:true,profile_unchanged:true,scope_unchanged:true,generations_unchanged:true,
  budget_sequence:102,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false},
 qualification_issued:false,activation:false,live_database_write:false,authority_effect:'NONE'};
const outputs={
 'ControllerQualification.root9.exact-pair.candidate.json':qualificationRaw,
 'Root9ExactPairRepairAcceptance.candidate.json':repairRaw,
 'Status28SigningPayload.json':statusRaw,
 'Stage2BuildManifest.json':pretty(manifest)
};
if(process.argv.includes('--write'))for(const [name,raw] of Object.entries(outputs))fs.writeFileSync(here+'/'+name,raw,{flag:'wx'});
process.stdout.write(JSON.stringify({state:'ROOT9_EXACT_PAIR_STAGE2_BUILT',artifacts:Object.fromEntries(Object.entries(outputs).map(([name,raw])=>[name,{sha256:sha(raw),blob_sha1:blob(raw),bytes:Buffer.byteLength(raw)}])),authority_effect:'NONE',live_database_write:false})+'\n');
