#!/usr/bin/env node
// Structural fail-closed regression only. It never invokes the verifier's gh path.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const file=new URL('./verify-root10-p2-and-assemble.mjs',import.meta.url);
const raw=fs.readFileSync(file,'utf8'),sha=v=>crypto.createHash('sha256').update(v).digest('hex'),need=(v,m)=>{if(!v)throw Error(m)};
execFileSync(process.execPath,['--check',file.pathname.replace(/^\/(.:)/,'$1')],{stdio:'pipe'});
need(raw.includes("rootP1.pr===190")&&raw.includes("root.signature_binding.owner_merge_commit===rootP1.merge_commit"),'ORIGINAL_ROOT_PR190_FIXED');
need(raw.includes("sourceP1.state==='ACTUAL_ROOT10_CORRECTIVE_SOURCE_OWNER_PUBLICATION_VERIFIED'")&&raw.includes("subject.expected_ga.source_ref.commit===sourceP1.merge_commit"),'CORRECTIVE_SOURCE_FIXED');
need(raw.includes("api('/compare/'+sourceP1.merge_commit+'...'+merge.sha)")&&raw.includes('CORRECTIVE_SOURCE_MUST_PRECEDE_P2'),'P2_LINEAGE_FROM_CORRECTIVE_SOURCE');
need(raw.includes("result_reviewer?.publication?.commitSha===rootP1.merge_commit")&&raw.includes("executor_applicability?.publication?.commitSha===sourceP1.merge_commit"),'SPLIT_RUNTIME_PUBLICATIONS');
need(raw.includes("names=['Root10P1Publication.verified.json','Root10CorrectiveSourcePublication.verified.json'")&&raw.includes('INDEPENDENT_REVIEW_DUAL_PUBLICATION_BINDING'),'P2_PUBLISHES_AND_REVIEWS_BOTH_PROOFS');
process.stdout.write(JSON.stringify({state:'DUAL_PUBLICATION_P2_VERIFIER_LOCAL_PASS',verifier_sha256:sha(raw),network:false,database:false,signature:false,ga:false})+'\n');
