// Accepted recovery source identity is separate from the historical qualified executor.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {isDeepStrictEqual as same} from 'node:util';
const directory=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(directory,'../../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
const oldDigest='edf31377656e1a9a473d0095df72231c058266007e4fd4046e0a9b8c2d6a60d9';
export function verifyRecoverySources({material,ga,receipt,state}){
 const manifestRaw=fs.readFileSync(path.join(directory,'RecoverySourceManifest.json')),manifest=JSON.parse(manifestRaw),a=state.attempts.find(x=>x.ga_id===ga.gate_authorization_id),index=JSON.parse(a.decision.evidence_index_raw);
 const proof=JSON.parse(index.artifacts.find(x=>x.uri===a.decision.not_started_evidence_ref.uri&&x.sha256===a.decision.not_started_evidence_ref.sha256).raw),ref=proof.recovery_source_acceptance_ref;
 const sources=index.artifacts.filter(x=>same({uri:x.uri,sha256:x.sha256},ref));need(sources.length===1&&sha(sources[0].raw)===ref.sha256&&same(material.recovery_source_acceptance?.ref,ref)&&material.recovery_source_acceptance.raw===sources[0].raw,'EXACT_INDEPENDENT_RECOVERY_SOURCE_ACCEPTANCE_BYTES');
 const review=JSON.parse(sources[0].raw);need(review.state==='ACCEPTED_EXACT_PREDISPATCH_NONPASS_RECOVERY_SOURCES'&&review.independent_reviewer==='/root/project_list_auth_fix'&&same(review.reviewer_ref,receipt.independent_reviewer_ref),'EXACT_EXISTING_INDEPENDENT_REVIEWER');
 need(review.recovery_source_manifest_sha256===sha(manifestRaw)&&review.original_controller_digest===oldDigest&&review.original_controller_digest===ga.controller_digest&&review.ga_id===ga.gate_authorization_id&&review.ga_sha256===sha(a.ga_raw)&&review.root_id===state.binding.root_id&&review.scope_digest===ga.scope_digest,'EXACT_RECOVERY_VERSUS_HISTORICAL_EXECUTOR_BINDING');
 need(review.old_qualification_extended===false&&review.new_action_authorized===false&&review.budget_refund===false&&same(review.allowed_results,['FAIL','BLOCKED','STALE']),'NO_QUALIFICATION_AUTHORITY_OR_BUDGET_EXPANSION');
 need(manifest.original_controller_digest===oldDigest&&same(manifest.files.map(x=>x.path).sort(),['OriginalSourceBindings.json','alter.candidate.sql','build.mjs','grr.mjs','not-started.mjs','recovery-sources.mjs','result-terminal.mjs','write-targets.mjs','recovery-context.mjs','recovery-cli.mjs','tool-entry.functions.js'].sort()),'EXACT_CLOSED_RECOVERY_SOURCE_SET');
 for(const f of manifest.files){const b=fs.readFileSync(path.join(directory,f.path));need(b.length===f.bytes&&sha(b)===f.sha256,'RECOVERY_SOURCE_BYTES_DRIFT');}
 const priorRaw=fs.readFileSync(path.join(repo,'scripts/phase2-qualification/control-context-verifier-runtime600/ControllerSourceManifest.candidate.json'));need(sha(priorRaw)===oldDigest,'ORIGINAL_CONTROLLER_MANIFEST');const prior=JSON.parse(priorRaw);need(prior.files.length===201,'ORIGINAL_201_CLOSURE');
 for(const f of prior.files){const b=fs.readFileSync(path.isAbsolute(f.path)?f.path:path.join(repo,f.path));need(b.length===f.bytes&&sha(b)===f.sha256,'ORIGINAL_EXECUTION_SOURCE_BYTES_DRIFT');}
 return {state:'EXACT_RECOVERY_AND_HISTORICAL_SOURCE_BYTES_CHECKED',old_qualification_extended:false,authority_effect:'NONE'};
}
