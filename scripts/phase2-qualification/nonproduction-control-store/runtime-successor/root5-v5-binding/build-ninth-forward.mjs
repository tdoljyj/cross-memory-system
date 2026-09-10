import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {buildForward,captureQuery} from './ninth-forward.candidate.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const work=path.resolve(here,'../..');
const repo='C:/Users/Windows/Documents/Codex/2026-09-10/kernel-phase2-final-admin';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const encode=o=>Buffer.from(JSON.stringify(o,null,2)+'\n','utf8');
const line=await new Promise((resolve,reject)=>{
  const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  rl.once('line',resolve);rl.once('error',reject);
});
const envelope=process.argv.includes('--json')?JSON.parse(line):JSON.parse(Buffer.from(line,'base64').toString('utf8'));
if(!envelope.row||typeof envelope.getter_definition_base64!=='string')throw Error('capture envelope required');
const getterRaw=Buffer.from(envelope.getter_definition_base64.replace(/\s/g,''),'base64').toString('utf8');
const observation={query:captureQuery,observation_ref:{path:'work/env-order-repair-approved-execution/ninth-forward-20260911/ActualNinthForwardObservation.json',sha256:sha(JSON.stringify(envelope.row))},row:envelope.row};
const eighth=JSON.parse(fs.readFileSync(path.join(work,'env-order-repair-approved-execution/eighth-forward-20260910/ActualEighthForwardInput.json'),'utf8'));
const material=(relative,publication)=>{
  const b=fs.readFileSync(path.join(repo,...relative.split('/')));
  const raw=b.toString('utf8');
  return {raw,ref:{uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${blob(b)}`,sha256:sha(b)},publication};
};
const sourceMaterials={
  controller_manifest:material('scripts/phase2-qualification/control-context-verifier-root5-final-successor/ControllerSourceManifest.candidate.json',{commitSha:'a8c0d6bd13fa9fe88da29d10091410d412b6b3f8',artifactPath:'scripts/phase2-qualification/control-context-verifier-root5-final-successor/ControllerSourceManifest.candidate.json'}),
  gate_suite:eighth.source_materials.gate_suite,
  independent_acceptance:material('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-repair/Root5BudgetSequenceBindingRepairAcceptance.json',{commitSha:'a8c0d6bd13fa9fe88da29d10091410d412b6b3f8',artifactPath:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-repair/Root5BudgetSequenceBindingRepairAcceptance.json'}),
  qualification:material('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v5/ScopedRoot5FinalControllerQualification.json',{commitSha:'0ce184e9214985e2a21a4d1353d3c9f9282bdd23',artifactPath:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v5/ScopedRoot5FinalControllerQualification.json'}),
  runtime_acceptance:material('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v5/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json',{commitSha:'0ce184e9214985e2a21a4d1353d3c9f9282bdd23',artifactPath:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v5/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json'}),
  scope:eighth.source_materials.scope,
};
const input={actual_preimage:observation,gate_definition_raw:eighth.gate_definition_raw,idempotency_key:'root5-v5-binding-20260911',previous_getter_definition_raw:getterRaw,source_materials:sourceMaterials};
const candidate=buildForward(input);
fs.writeFileSync(path.join(here,'ActualNinthForwardObservation.json'),encode(observation),{flag:'wx'});
fs.writeFileSync(path.join(here,'ActualNinthForwardInput.json'),encode(input),{flag:'wx'});
fs.writeFileSync(path.join(here,'ActualNinthForward.sql'),candidate.sql,{flag:'wx'});
const preparation={...candidate,sql:undefined,sql_path:'work/env-order-repair-approved-execution/ninth-forward-20260911/ActualNinthForward.sql',candidate_source_sha256:sha(fs.readFileSync(path.join(here,'ninth-forward.candidate.mjs'))),getter_source_sha256:sha(fs.readFileSync(path.join(here,'exact-getter-root5-final.candidate.mjs'))),input_sha256:sha(encode(input))};
fs.writeFileSync(path.join(here,'ActualNinthForwardPreparation.json'),encode(preparation),{flag:'wx'});
console.log(JSON.stringify(preparation,null,2));
