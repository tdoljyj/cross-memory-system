// Exact static successor after the concrete controller source manifest exists; no registration.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../..'),q='scripts/phase2-qualification/';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),encode=v=>JSON.stringify(v,null,2)+'\n';
const reference=p=>{const raw=fs.readFileSync(path.resolve(repo,p));return {path:p,sha256:hash(raw),bytes:raw.length};};
const prior=q+'preentry-parent/gate-successor/';
const oldSuite=reference(prior+'preentry-skill-qualification.json');
if(oldSuite.sha256!=='cf4a57d0d367ea9946d663ce177bbe228c8399d8398e33dced4e5a3bb099db28')throw Error('FROZEN_STATIC_SUITE_DRIFT');
const profileRef=reference(q+'preentry-parent/profile-runtime180/ProfileDefinition.json');
const payloadRef=reference(q+'preentry-parent/profile-runtime180/signing/ProfileSigningPayload.json');
if(payloadRef.sha256!=='f0fb2615f47995841791a0b131c427c4727daacdfb211e2f99c551c1f61109af')throw Error('EXACT_180_PAYLOAD_DRIFT');
const acceptanceRef=reference('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/FixedSyntheticProfile180IndependentAcceptance.json');
const manifestRef=reference(q+'control-context-verifier-runtime180/ControllerSourceManifest.candidate.json');
const manifest=JSON.parse(fs.readFileSync(path.resolve(repo,manifestRef.path),'utf8'));
if(manifest.object_type!=='ControllerSourceManifest'||manifest.qualification_issued!==false||!Array.isArray(manifest.files)||manifest.files.length<30)throw Error('CONCRETE_CONTROLLER_SOURCE_SET_REQUIRED');
const profile=JSON.parse(fs.readFileSync(path.resolve(repo,profileRef.path),'utf8'));
const suite=JSON.parse(fs.readFileSync(path.resolve(repo,oldSuite.path),'utf8'));
const gate=suite.gates['G-PREENTRY-SKILL-QUALIFICATION'],version='fixed-synthetic-20260908.v2-runtime180';
gate.definition_version=version;gate.execution.maximum_seconds=180;
gate.profile_ref={profile_id:profile.profile_id,definition_version:profile.definition_version,content_digest:'sha256:'+profileRef.sha256,definition_ref:profileRef,signed_payload_ref:payloadRef,independent_acceptance_ref:acceptanceRef};
for(const test of Object.values(suite.tests)){
 test.definition_version=version;
 test.executor_artifact_ref={path:manifestRef.path,sha256:manifestRef.sha256,source_ref:manifestRef,complete_controller_source_set:true,qualification_claimed:false};
 test.subject_input_ref={source_ref:payloadRef,json_pointer:'/fixed_input_ref'};
}
gate.test_refs=Object.values(suite.tests).map(t=>({test_id:t.test_id,typed_uri:t.typed_uri,definition_version:t.definition_version,content_digest:'sha256:'+hash(encode(t)),definition_path:'evals/kernel-next/preentry-skill-qualification.json',canonical_pointer:'#/tests/'+t.test_id}));
const suiteRaw=encode(suite),gateRaw=encode(gate),registry=JSON.parse(fs.readFileSync(path.resolve(repo,prior+'RegistrySuccessorCandidate.json'),'utf8'));
registry.operation='FORWARD_EXACT_ATOMIC_GATE_VERSION';registry.addition.definition_version=version;registry.addition.content_digest='sha256:'+hash(gateRaw);registry.addition.definition_source.sha256=hash(suiteRaw);
registry.existing_gate_ids_and_definitions_unchanged=false;
registry.forward_version_boundary='Earlier version retained as immutable history; only this exact Gate forward version is proposed. Other Gate IDs and meanings are unchanged.';
for(const [name,raw] of [['preentry-skill-qualification.json',suiteRaw],['GateDefinitionCandidate.json',gateRaw],['RegistrySuccessorCandidate.json',encode(registry)]])fs.writeFileSync(path.join(here,name),raw,{flag:'wx'});
fs.writeFileSync(path.join(here,'StaticInputChangeSet.json'),encode({state:'PREPARED_NOT_REGISTERED',source_refs:{oldSuite,profileRef,payloadRef,acceptanceRef,manifestRef},changes:['Profile180 exact version/payload/independent acceptance reference; actual signature still required at runtime','Same Gate forward version and180 cap','Every original applicable Test binds the same full controller source manifest, not old parent-only digest','Only affected Test and Gate/Registry digests recomputed; all original case/expected-oracle/requirement/fixture fields preserved'],gate_sha256:hash(gateRaw),suite_sha256:hash(suiteRaw),controller_qualified:false,actual_profile_signature_claimed:false}),{flag:'wx'});
process.stdout.write(JSON.stringify({state:'PREPARED_NOT_REGISTERED',gate_sha256:hash(gateRaw),suite_sha256:hash(suiteRaw),controller_manifest_sha256:manifestRef.sha256})+'\n');
