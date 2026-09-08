import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(directory,'../../../..');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function reference(relative,external=false){const file=path.resolve(repo,relative),bytes=fs.readFileSync(file);return {path:relative,sha256:digest(bytes),bytes:bytes.length,source_location:external?'PRESERVED_LOCAL_CONTRACT_INPUT':'REPOSITORY_FILE'};}
const sources={policy:reference('../slice-a-contracts/QualificationPhasePolicy.json',true),cases:reference('../slice-a-contracts/QualificationRegressionSpecifications.json',true),plan:reference('../slice-a-contracts/TestControllerQualificationPlan.json',true),profile:reference('scripts/phase2-qualification/preentry-parent/profile-successor/ProfileDefinition.json'),profile_signature:reference('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/IndependentFixedSyntheticProfileSignatureBinding.json'),applicability:reference('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/PreentryGateAndSignatureWiringApplicability.md'),fixture:reference('scripts/phase2-qualification/qualification-runtime/fixed_skill_fixture.py'),image:reference('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/PythonImageBinding.json'),os_stop:reference('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/DockerEngineeringObservationIndependentResult.json')};
const gate={object_type:'AtomicGateDefinitionCandidate',gate_id:'G-PREENTRY-SKILL-QUALIFICATION',definition_version:'fixed-synthetic-20260908.v1',state:'PROPOSED_UNREGISTERED',authority_effect:'NONE',
 purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',profile_ref:sources.profile,
 source_alias:{value:'PRE_ENTRY_QUALIFICATION_GATE_AUTHORIZATION',source:sources.policy,was_registered_gate_id:false},
 source_basis:{s06_sha256:'f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec',sections:['29 static Gate definition / Registry','32 execution GA / GRR'],source_map:sources},
 prerequisites:{stage_receipts:['R05','R06','R07','R08','R09','R10'],excluded_circular_stage_dependencies:['R11','R12','R13','R14'],accepted_controller_independent_of_skill:true,accepted_exact_execution_profile:true,registered_atomic_gate:true,actual_owner_root_issuer_current:true,per_action_ga_required:true},
 inputs:['exact GA and its accepted Schema/signature/purpose/Audience/current Root generation','exact controller, Skill trilogy, fixture and installation bytes','exact target revision, host/image digest, configuration and two fixed mounts','accepted layer-specific revocation applicability and separate runner/credential/session generations','pre-registered case/expected outcome, bounded budget reservation and durable sink','independent stop channel and exact container identity'],
 test_requirements:{source_ref:sources.cases,case_ids:Array.from({length:20},(_,i)=>'PQUAL-'+String(i+1).padStart(2,'0')).filter(id=>id!=='PQUAL-18'),post_entry_positive:{id:'PQUAL-18',state:'OUTSIDE_THIS_GATE_SCOPE_NOT_EXECUTED_NOT_PASSED',reason:'Requires DP-ISOLATED-E2E and separate Entry/implementation authority; no pre-entry substitution'},primitive_boundary:'fixed_skill_fixture.py is an action primitive; reading Skill bytes is not Skill behavior qualification or coverage of all cases'},
 target_scope:{child_read:['/driver exact four fixed files'],child_write:['/allowed dedicated synthetic fixture only'],child_network:'none',child_credentials:'none',host_control:'existing private clued_control typed operations and reviewed fixed Git auxiliary sink only',forbidden:['production','real user payload','model calls','paid operations','arbitrary host commands','public distribution','Entry or Slice A implementation']},
 execution:{executor:'independently accepted fixed parent/controller; exact implementation digest must be supplied in each GA',source_primitive_ref:sources.fixture,host_image_ref:sources.image,prior_os_stop_evidence_ref:sources.os_stop,maximum_seconds:90,memory_mib:128,cpu_millicores:500,pids:16,model_calls:0,paid_calls:0},
 evidence_and_result:{before_each_effect:'fresh typed current checks and exact remote durable Intent readback; recheck after publication',unknown:'no redispatch or capacity release; exact target reconciliation then only authorized safe stop',decision:'after independently verified STOP, one immutable DECISION_RESERVED and one signed GRR per GA',results:['PASS','FAIL','BLOCKED','STALE'],output_authority:'qualification test evidence only; no ACTIVE/Entry/model/production authority'},
 invalidation:['any accepted definition/input byte or target revision changes','required stage/Profile/controller/issuer acceptance revoked or replaced','Root or applicable independent generation/vector changes','window or budget exhausted','durable sink/STOP/required verifier unavailable','unresolved partial operation or evidence ambiguity'],
 roles:{executor:'fixed accepted controller',reviewer:'independent accepted assessor',issuer:'actual Owner/delegate via accepted current purpose binding; not the candidate author'},
 acceptance_required:['independent exact static definition and single Registry addition acceptance','normal signed static publication and immutable readback through existing authority chain','accepted runtime binding to this exact version and content digest'],
 no_execution_claim:true};
const encode=o=>JSON.stringify(o,null,2)+'\n';
const profile=JSON.parse(fs.readFileSync(path.resolve(repo,sources.profile.path),'utf8'));
const profilePayload=reference('scripts/phase2-qualification/preentry-parent/profile-successor/signing/ProfileSigningPayload.json');
const payload=JSON.parse(fs.readFileSync(path.resolve(repo,profilePayload.path),'utf8'));
const signature=JSON.parse(fs.readFileSync(path.resolve(repo,sources.profile_signature.path),'utf8'));
const fixedSource=reference('scripts/phase2-qualification/preentry-parent/ProfileApplicabilityCandidate.json');
const fixed=JSON.parse(fs.readFileSync(path.resolve(repo,fixedSource.path),'utf8')).fixed_input;
if(signature.status!=='VERIFIED'||signature.merge.sha!=='2a2c902fff6d1e68c40faf4f3695849c1b88ca6d'||signature.payload.file_sha256!==profilePayload.sha256||encode(payload.profile_definition)!==encode(profile)||payload.fixed_input_ref.source_ref.sha256!==fixedSource.sha256||fixed.child_sha256!==sources.fixture.sha256)throw Error('SIGNED_PROFILE_OR_FIXED_INPUT_DRIFT');
if(sources.policy.sha256!=='154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22'||sources.cases.sha256!=='8d35a391a728703a527cfef3137867bb80c70a0a78bd869051fe47406192dafe')throw Error('ORIGINAL_SOURCE_DRIFT');
const suitePath='evals/kernel-next/preentry-skill-qualification.json';
const registryPath='evals/kernel-next/preentry-skill-qualification.registry.json';
const reqSource=reference('protocol/continuity/v1/requirements.yaml');
const reqs=JSON.parse(fs.readFileSync(path.resolve(repo,reqSource.path),'utf8')).requirements;
const requiredIDs=['APPROVAL-LEASE-01','BIND-GRANULARITY-01','REV-MATRIX-01','RCT-APPEND-01','RECONCILE-TASK-01'];
const requirementRefs=requiredIDs.map(id=>{const r=reqs.find(x=>x.requirement_id===id);if(!r)throw Error('UNKNOWN_REQUIREMENT');return {requirement_id:id,typed_uri:r.typed_uri,definition_version:r.definition_version,content_digest:r.content_digest,registry_ref:reqSource};});
const tests={};
const scenarios=JSON.parse(fs.readFileSync(path.resolve(repo,sources.cases.path),'utf8')).scenarios;
for(const [i,c] of scenarios.entries())if(c.id!=='PQUAL-18')tests[c.id]={object_type:'TestManifest',test_id:c.id,typed_uri:'urn:clued:test:'+c.id,definition_version:gate.definition_version,
 requirement_refs:requirementRefs,source_case:{...sources.cases,json_pointer:'/scenarios/'+i},setup_or_fault:c.setup_or_fault,
 oracle:{expected:c.expected,source_oracle_sha256:digest(Buffer.from(c.expected,'utf8')),evaluation:'Use actual observed effects/refusals and independent review; matching fixture strings or source text is not behavioral evidence.'},
 executor_artifact_ref:{path:fixed.parent_path,sha256:fixed.parent_sha256,source_ref:fixedSource,json_pointer:'/fixed_input/parent_sha256'},fixture_artifact_ref:sources.fixture,
 subject_input_ref:{source_ref:profilePayload,json_pointer:'/fixed_input_ref'},data_classification:'FIXED_SYNTHETIC_ONLY',
 evidence_required:['exact case/fixture/executor/Skill/input digest index','actual pre-action admission/refusal observations','actual effects and independently verified STOP when child ran','raw immutable Evidence digests and independent oracle assessment'],
 retention_and_access_policy:'Private authorized append-only Evidence sink; no credentials or Gold; retain failure history; cleanup only as actually authorized',
 coverage_boundary:'Manifest fixes the expected behavior, not its implementation. The fixed child is one primitive; missing real case execution/evidence remains BLOCKED.'};
gate.object_type='GateManifest';gate.typed_uri='urn:clued:gate:'+gate.gate_id;
delete gate.state;delete gate.authority_effect;delete gate.no_execution_claim;
// Static definitions do not carry any real GA instance, target identity, write set or credential.
delete gate.inputs;delete gate.target_scope;delete gate.acceptance_required;
gate.source_basis={source_contract_uri:'urn:clued:contract:kernel-next:v3.3',sha256:'f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec',line_spans:[[3435,3444],[3876,3887],[4316,4346]]};
gate.profile_ref={profile_id:profile.profile_id,definition_version:profile.definition_version,content_digest:'sha256:'+sources.profile.sha256,definition_ref:sources.profile,signed_payload_ref:profilePayload,signature_observation_ref:sources.profile_signature};
gate.test_refs=Object.values(tests).map(t=>({test_id:t.test_id,typed_uri:t.typed_uri,definition_version:t.definition_version,content_digest:'sha256:'+digest(encode(t)),definition_path:suitePath,canonical_pointer:'#/tests/'+t.test_id}));
gate.target_scope_class='Fixed synthetic Skill coexistence inputs only under the signed PRE_ENTRY Profile; actual targets, input digests, allowed/forbidden writes, credentials, deadlines and stop/rollback bindings belong in each actual GA.';
gate.execution={environment_class:'ISOLATED_TEST',maximum_seconds:90,memory_bytes:134217728,cpu_millicores:500,pids:16,network:'none',model_calls:0,paid_calls:0};
gate.evidence_and_result.success='All 19 applicable tests require sufficient real evidence for the identical exact inputs and independent oracle review; a single fixture read/write is never 19-case PASS.';
gate.evidence_and_result.decision='PENDING -> RUNNING -> DECISION_RESERVED; reserve all immutable Test/Evidence digests once; controlled signing Outbox; fresh final authorization/revocation/expiry/drift recheck before terminal CAS; one GA has one signed GRR.';
const suite={schema_role:'STATIC_PREENTRY_SUCCESSOR_CANDIDATE',tests,gates:{[gate.gate_id]:gate}};
const suiteEncoded=encode(suite);fs.writeFileSync(path.join(directory,'preentry-skill-qualification.json'),suiteEncoded);
const encoded=encode(gate);fs.writeFileSync(path.join(directory,'GateDefinitionCandidate.json'),encoded);
const delta={state:'PROPOSED_NOT_APPLIED',authority_effect:'NONE',registry_source:'S06 frozen atomic Gate enumeration, extended only by accepted signed forward source; no second registry',operation:'ADD_EXACT_ATOMIC_GATE',addition:{gate_id:gate.gate_id,definition_version:gate.definition_version,definition_path:'GateDefinitionCandidate.json',definition_sha256:digest(encoded)},existing_gate_ids_and_definitions_unchanged:true,original_frozen_registry_and_pins_unchanged:true,not_a_redefinition_of:['G0a','G0b','G1','G7A','B01','PQUAL-01'],runtime_enumeration_update:'Only after acceptance, append this exact ID in the same control-domain binding constraint; current SQL candidate deliberately still rejects it'};
delta.object_type='TypedGateRegistrySuccessorCandidate';delta.predecessor_source=gate.source_basis;delta.canonical_target=registryPath;
delta.addition={object_type:'GateManifest',gate_id:gate.gate_id,typed_uri:gate.typed_uri,definition_version:gate.definition_version,content_digest:'sha256:'+digest(encoded),definition_source:{path:suitePath,sha256:digest(suiteEncoded),canonical_pointer:'#/gates/'+gate.gate_id}};
delta.typed_namespace_rule='PQUAL IDs are TestManifest, B01-B06 are mechanism boundaries, and this one Gate is neither a stage alias nor a Promotion/RC Gate.';
delta.activation_rule='Exact independent acceptance, signed immutable static publication/readback, then current Registry composition and runtime allowlist binding; candidate bytes alone never register a Gate or authorize a GA.';
fs.writeFileSync(path.join(directory,'RegistrySuccessorCandidate.json'),encode(delta));
fs.writeFileSync(path.join(directory,'SourceBindings.json'),encode({state:'PREPARATION_ONLY',sources:{...sources,profile_payload:profilePayload,fixed_input:fixedSource,requirement_registry:reqSource},definition_set_digest:'sha256:'+digest(encode([delta.addition])),static_targets:[suitePath,registryPath],schema_applicability:'Existing gate-manifest.schema.json is V15 local-RC and requires Release Profile. It is not silently applied or changed for this signed PRE_ENTRY execution Profile; static successor format is the exact independent acceptance subject.',runtime_not_executed:true}));
console.log(JSON.stringify({definition_sha256:digest(encoded),registered:false,authority_effect:'NONE'}));
