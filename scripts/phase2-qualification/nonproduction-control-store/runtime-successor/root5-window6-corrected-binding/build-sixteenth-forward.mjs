import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {buildForward,captureQuery} from './sixteenth-forward.candidate.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const work='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work';
const repo='C:/Users/Windows/Documents/Codex/2026-09-10/kernel-phase2-final-admin';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const encode=o=>Buffer.from(JSON.stringify(o,null,2)+'\n','utf8');
const line=await new Promise((resolve,reject)=>{
  const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  rl.once('line',resolve);rl.once('error',reject);
});
const writeOptions=process.argv.includes('--replace')?undefined:{flag:'wx'};
const envelope=process.argv.includes('--json')?JSON.parse(line):JSON.parse(Buffer.from(line,'base64').toString('utf8'));
if(!envelope.row||typeof envelope.getter_definition_base64!=='string')throw Error('capture envelope required');
const getterRaw=Buffer.from(envelope.getter_definition_base64.replace(/\s/g,''),'base64').toString('utf8');
const observation={query:captureQuery,observation_ref:{path:'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window6-corrected-binding/ActualSixteenthForwardObservation.json',sha256:sha(JSON.stringify(envelope.row))},row:envelope.row};
const eighth=JSON.parse(fs.readFileSync(path.join(work,'env-order-repair-approved-execution/eighth-forward-20260910/ActualEighthForwardInput.json'),'utf8'));
const material=(relative,publication)=>{
  const b=fs.readFileSync(path.join(repo,...relative.split('/')));
  const raw=b.toString('utf8');
  return {raw,ref:{uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${blob(b)}`,sha256:sha(b)},publication};
};
const sourceMaterials={
  controller_manifest:material('scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor/ControllerSourceManifest.candidate.json',{commitSha:'2354e266a28b4891d7f1395717cd7d310404d471',artifactPath:'scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor/ControllerSourceManifest.candidate.json'}),
  gate_suite:eighth.source_materials.gate_suite,
  independent_acceptance:material('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v13/Status20Acceptance.json',{commitSha:'6b99e778674f812f74596a3ae1f08d4f1b350453',artifactPath:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v13/Status20Acceptance.json'}),
  qualification:material('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v12/ScopedRoot5FinalControllerQualification.json',{commitSha:'187faa40695c1b318226838832439fbd188febdb',artifactPath:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v12/ScopedRoot5FinalControllerQualification.json'}),
  runtime_acceptance:material('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v13/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json',{commitSha:'6b99e778674f812f74596a3ae1f08d4f1b350453',artifactPath:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v13/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json'}),
  scope:eighth.source_materials.scope,
};
const input={actual_preimage:observation,gate_definition_raw:eighth.gate_definition_raw,idempotency_key:'root5-window6-corrected-binding-20260911',previous_getter_definition_raw:getterRaw,source_materials:sourceMaterials};
const candidate=buildForward(input);
fs.writeFileSync(path.join(here,'ActualSixteenthForwardObservation.json'),encode(observation),writeOptions);
fs.writeFileSync(path.join(here,'ActualSixteenthForwardInput.json'),encode(input),writeOptions);
fs.writeFileSync(path.join(here,'ActualSixteenthForward.sql'),candidate.sql,writeOptions);
const preparation={...candidate,sql:undefined,sql_path:'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window6-corrected-binding/ActualSixteenthForward.sql',candidate_source_sha256:sha(fs.readFileSync(path.join(here,'sixteenth-forward.candidate.mjs'))),getter_source_sha256:sha(fs.readFileSync(path.join(here,'exact-getter-root5-window6.candidate.mjs'))),input_sha256:sha(encode(input))};
fs.writeFileSync(path.join(here,'ActualSixteenthForwardPreparation.json'),encode(preparation),writeOptions);
console.log(JSON.stringify(preparation,null,2));
