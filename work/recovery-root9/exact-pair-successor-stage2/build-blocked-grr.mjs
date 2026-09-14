import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const sha=raw=>crypto.createHash('sha256').update(raw,'utf8').digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const read=name=>{
 let raw=fs.readFileSync(path.join(here,name),'utf8').replaceAll('\r\n','\n');
 while(raw.endsWith('\n\n'))raw=raw.slice(0,-1);
 return raw;
};
const exactRef=(uri,sha256)=>({uri,sha256});

const gaRaw=read('OldGateAuthorization.json');
const ga=JSON.parse(gaRaw);
need(sha(gaRaw)==='50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819','EXACT_OLD_GA_RAW');
need(ga.gate_authorization_id==='ga_4a88b0436cf80beeb5e194c98bb0297e','EXACT_OLD_GA_ID');
const evidenceRaw=read('DockerNotStartedObservation.json');
const evidenceRef=exactRef('https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/ce26b5130aa7cb5cd11fd5790747595312f7a349','ba0edadea01000daafd51fb8985870f6e6a946be3a3959102e998f800a2dcb20');
need(sha(evidenceRaw)===evidenceRef.sha256,'EXACT_OWNER_NOT_STARTED_EVIDENCE');
const evidence=JSON.parse(evidenceRaw);
need(evidence.not_started===true&&evidence.container_id===null&&evidence.execution_sequence===104,'EXACT_NEVER_STARTED_SUBJECT');

const decision={
 object_type:'Root9PredispatchBlockedDecision',schema_version:'1.0',
 ga_id:ga.gate_authorization_id,ga_sha256:sha(gaRaw),result:'BLOCKED',
 termination_mode:'EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9',
 not_started_evidence_ref:evidenceRef,test_results:[],authority_effect:'NONE'
};
const decisionRaw=JSON.stringify(decision)+'\n',decisionSha=sha(decisionRaw);
const evidenceIndex={
 object_type:'Root9PredispatchBlockedEvidenceIndex',schema_version:'1.0',
 ga_id:ga.gate_authorization_id,ga_sha256:sha(gaRaw),tests:[],
 artifacts:[{...evidenceRef,raw:evidenceRaw}],authority_effect:'NONE'
};
const evidenceIndexRaw=JSON.stringify(evidenceIndex)+'\n',evidenceIndexSha=sha(evidenceIndexRaw);
const fixtureRef=ga.artifact_refs.find(r=>r.sha256===ga.fixtures_digest);
const executorRef=ga.artifact_refs.find(r=>r.sha256===ga.controller_digest);
need(fixtureRef&&executorRef,'EXACT_OLD_GA_FIXTURE_AND_CONTROLLER_REFS');
const id='grr_root9_exact_pair_old_ga_blocked_20260915';
const receipt={
 object_type:'GateResultReceipt',schema_version:'1.0',
 schema_digest:'292da87d05b1bb00337a2045e3d26f6df0be70aaf520aa519572fa3dec395252',
 audience:ga.audience,control_trust_root_generation:ga.control_trust_root_generation,
 issuer_ref:exactRef('https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/4996089908b1f2c0bad36234c54271d350062f55','ffafc9eb63a2148176dca0e66d5a22bf07ee9f0a5462c966d42a79d247f0088c'),
 gate_result_receipt_id:id,gate_authorization_id:ga.gate_authorization_id,
 gate_authorization_sha256:sha(gaRaw),
 gate_definition_ref:{gate_id:'G-PREENTRY-SKILL-QUALIFICATION',definition_version:'fixed-synthetic-20260910.v10-env-order-repair',content_digest:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a'},
 issuer_purpose:'GATE_RESULT',result:'BLOCKED',decision_sha256:decisionSha,
 test_revision:'fixed-synthetic-20260910.v10-env-order-repair',fixture_refs:[fixtureRef],
 executor_ref:executorRef,performance_slo_revision:'NOT_APPLICABLE_PREDISPATCH_NOT_STARTED',
 test_results:[],input_artifact_digests:[sha(gaRaw),evidenceRef.sha256,decisionSha,evidenceIndexSha],
 evidence_index_ref:exactRef('urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:'+evidenceIndexSha,evidenceIndexSha),
 raw_evidence_refs:[evidenceRef],actual_write_set:[],
 started_at:ga.issued_at,ended_at:evidence.observed_at,issued_at:'2026-09-14T16:51:00.000Z',expires_at:'2026-09-15T03:00:00.000Z',
 executor_actor_ref:ga.actor_ref,
 independent_reviewer_ref:exactRef('https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/1b0f0c21cba8c8b7e887e739f502ce7410727c5b','9ca45136f864beee04f9074a752070e95ff45f827e7b7a3489df4d0cdc6ec99d'),
 stop_evidence_ref:evidenceRef,
 signature:'urn:clued:gate-result-receipt:uscrdifznmlvczcekqpw:'+id+'#signature'
};
const receiptRaw=JSON.stringify(receipt)+'\n',receiptSha=sha(receiptRaw);
need(new Set(receipt.input_artifact_digests).size===receipt.input_artifact_digests.length,'UNIQUE_INPUT_DIGESTS');
need(receipt.ended_at<=receipt.issued_at&&receipt.issued_at<receipt.expires_at,'GRR_TIME_ORDER');
const result={state:'ROOT9_PREDISPATCH_BLOCKED_GRR_BUILT',authority_effect:'NONE',live_database_write:false,
 artifacts:{
  'BlockedDecision.raw.json':{raw:decisionRaw,sha256:decisionSha},
  'BlockedEvidenceIndex.raw.json':{raw:evidenceIndexRaw,sha256:evidenceIndexSha},
  'BlockedGRR.raw.json':{raw:receiptRaw,sha256:receiptSha}
 }};
if(process.argv.includes('--write')){
 for(const [name,item] of Object.entries(result.artifacts))fs.writeFileSync(path.join(here,name),item.raw,{flag:'wx'});
}
process.stdout.write(JSON.stringify(result)+'\n');
