// Exact affected-source successor only. No service calls, activation, signing or qualification.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyWiring} from './wire-runtime.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),prior=path.resolve(here,'../control-context-verifier');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
if(hash(fs.readFileSync(path.join(prior,'CandidateEvidence.json')))!=='7c3d760da1a6ea3e77f367d7a637b69b6f490cb676d8628b783b411a7872b96e')throw Error('FROZEN_PREDECESSOR_DRIFT');
const bindings=JSON.parse(fs.readFileSync(path.join(prior,'SourceBindings.json'),'utf8'));
const repo=path.resolve(here,'../../..');
for(const source of bindings.files)if(hash(fs.readFileSync(path.resolve(repo,source.path)))!==source.sha256)throw Error('PREDECESSOR_SOURCE_DRIFT:'+source.path);
const changed=[];
function replace(text,before,after){if(text.split(before).length!==2)throw Error('EXACT_SUCCESSOR_PATCH_NOT_UNIQUE');return text.replace(before,after);}
for(const name of ['context.mjs','trusted-github.mjs','grr.mjs','cli.mjs','tool-entry.functions.js','status-manifest.candidate.schema.json','gate-result-receipt.candidate.schema.json']){
 const old=fs.readFileSync(path.join(prior,name),'utf8');let value=old;
 if(name==='context.mjs'){
  value=replace(value,"const bytes=n=>fs.readFileSync(new URL(n,profileBase));","const bytes=n=>fs.readFileSync(n==='ProfileDefinition.json'?new URL('../preentry-parent/profile-runtime180/ProfileDefinition.json',import.meta.url):new URL(n,profileBase));");
  value=replace(value,'expires-issued<=90000','expires-issued<=180000&&profile.max_lifetime_seconds===180');
  const begin=value.indexOf(' const profileProof=JSON.parse(fs.readFileSync('),end=value.indexOf(" verifyDynamicPayload(material.ga_raw",begin);
  if(begin<0||end<0)throw Error('PROFILE_PAYLOAD_PATCH_NOT_FOUND');
  value=value.slice(0,begin)+" const profileInput=material.profile_signing_payload;\n check(profileInput?.raw&&sha(profileInput.raw)===result.accepted_subject.profile_signing_payload_ref?.sha256,'EXACT_ACCEPTED_PROFILE_PAYLOAD_INPUT');\n const profileProof=JSON.parse(profileInput.raw);check(same(profileProof.profile_definition,profile),'PROFILE_SOURCE');\n verifyOwnerMergeArtifact({...profileInput.publication,raw:profileInput.raw});\n"+value.slice(end);
 }
 if(name==='cli.mjs')value=replace(value,'},90000);','},180000);');
 if(name==='tool-entry.functions.js')value=replace(value,'control-context-verifier/cli.mjs','control-context-verifier-runtime180/cli.mjs');
 fs.writeFileSync(path.join(here,name),value);
 changed.push({path:name,predecessor_sha256:hash(old),successor_sha256:hash(value),changed:value!==old});
}
applyWiring(here);
for(const entry of changed){entry.successor_sha256=hash(fs.readFileSync(path.join(here,entry.path)));entry.changed=entry.successor_sha256!==entry.predecessor_sha256;}
fs.writeFileSync(path.join(here,'VerifierChangeSet.json'),JSON.stringify({state:'PREPARED_NOT_ACTIVATED',predecessor_evidence_sha256:'7c3d760da1a6ea3e77f367d7a637b69b6f490cb676d8628b783b411a7872b96e',files:changed,changes:['Exact independently accepted Profile180 definition plus its 180-second cap','Actual Profile signing payload is a separately accepted runtime input verified against actual Owner merge, not a future merge SHA embedded into code','Explicit preflight versus once-only committed-dispatch phases; same-process direct fixed Python bridge','Actual MCP JSON wrapper and unique paired line-boundary parser; old7c3 entry not accepted','PTY process watchdog180 and exact successor entry path; schemas and signing algorithms unchanged'],signature_or_qualification_created:false},null,2)+'\n');
process.stdout.write(JSON.stringify({state:'PREPARED_NOT_ACTIVATED',changed:changed.filter(x=>x.changed).map(x=>x.path)})+'\n');
