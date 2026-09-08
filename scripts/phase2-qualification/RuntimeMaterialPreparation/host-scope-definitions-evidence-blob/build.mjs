// Prepare immutable scope descriptions in one direction; never issue authority.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {prepareLate} from './prepare-late600.mjs';
import {fixedWriteTargetRules} from '../../control-context-verifier-runtime600/write-targets.mjs';
const root=new URL('../../../../',import.meta.url),q='scripts/phase2-qualification/';
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const read=path=>{const bytes=fs.readFileSync(new URL(path,root));return {path,sha256:hash(bytes),bytes:bytes.length,value:JSON.parse(bytes)};};
const metadata=path=>{const bytes=fs.readFileSync(new URL(path,root));return {path,sha256:hash(bytes),bytes:bytes.length};};
const out=(name,value)=>{const raw=JSON.stringify(value,null,2)+'\n';fs.writeFileSync(new URL(name,import.meta.url),raw);return {path:q+'RuntimeMaterialPreparation/host-scope-definitions-evidence-blob/'+name,sha256:hash(raw),bytes:Buffer.byteLength(raw)};};
const old=q+'RuntimeMaterialPreparation/input-definitions/';
const owner=read(old+'ControlActorDefinition.json'),credentials=read(old+'CredentialScopeDefinition.json');
const subject=read(old+'SkillSubjectManifest.json');
const own=q+'RuntimeMaterialPreparation/host-scope-definitions-evidence-blob/';
const prospectiveDefinitionRef=ref=>{const raw=fs.readFileSync(new URL(ref.path,root));return {uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+crypto.createHash('sha1').update(Buffer.from('blob '+raw.length+'\0')).update(raw).digest('hex'),sha256:ref.sha256};};
const stopOriginal=read(old+'StopPolicyDefinition.json');
const stopRef=out('StopPolicyDefinition.json',{...stopOriginal.value,deadline_limit_seconds:600,source_path:q+'preentry-parent/runtime-successor/host-runtime600/fixed_host.py',source_sha256:metadata(q+'preentry-parent/runtime-successor/host-runtime600/fixed_host.py').sha256});
const recoveryOriginal=read(old+'RecoveryBoundaryDefinition.json');
const recoveryRef=out('RecoveryBoundaryDefinition.json',{...recoveryOriginal.value,stop_policy_ref:prospectiveDefinitionRef(stopRef)});
const riskOriginal=read(old+'ScopedRiskManifest.json');
const riskRef=out('ScopedRiskManifest.json',{...riskOriginal.value,recovery_ref:prospectiveDefinitionRef(recoveryRef),
 risks:[...riskOriginal.value.risks,{finding:'Complete control history exceeds the former inline evidence envelope or terminal input consumption exceeds freshness',control:'Complete original input remains capped at 1MiB and is preserved; exact immutable private Git blob readback replaces only inline storage. Fixed pipe input transmits original bytes with length/SHA and ordered notices. Actual 15-second currentness remains unchanged; failed transport retains UNKNOWN without dispatch or refund.'}],
 predecessor:metadata(q+'RuntimeMaterialPreparation/host-scope-definitions-runtime600-final/ScopedRiskManifest.json')});
const stop=read(stopRef.path);
const image=read('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/PythonImageBinding.json');
const profile=read(q+'preentry-parent/profile-runtime600/ProfileDefinition.json');
const manifestPath=q+'control-context-verifier-evidence-blob-successor/ControllerSourceManifest.candidate.json';
let controller=null;
if(fs.existsSync(new URL(manifestPath,root))){
 const m=read(manifestPath);
 if(m.value.object_type!=='ControllerSourceManifest'||m.value.authority_effect!=='NONE'||!Array.isArray(m.value.files)||m.value.files.length<1)throw Error('Exact controller byte-set manifest required');
 controller={path:manifestPath,sha256:m.sha256,bytes:m.bytes};
}
const planPath=q+'control-context-verifier-evidence-blob-successor/preentry-skill-qualification.json';
const plan=fs.existsSync(new URL(planPath,root))?metadata(planPath):null;
const fixture=metadata(q+'qualification-runtime/fixed_skill_fixture.py');
if(plan){
 const value=read(planPath).value,tests=Object.values(value.tests??{});
 if(!controller||tests.length!==19||value.gates?.['G-PREENTRY-SKILL-QUALIFICATION']?.definition_version!=='fixed-synthetic-20260909.v4-evidence-blob')throw Error('Final nineteen-case Gate/controller input required');
 for(const test of tests){
  if(test.fixture_artifact_ref?.path!==fixture.path||test.fixture_artifact_ref?.sha256!==fixture.sha256||test.fixture_artifact_ref?.bytes!==fixture.bytes)throw Error('Single-file fixture-set identity changed; independent successor required');
  if(test.executor_artifact_ref?.sha256!==controller.sha256||test.executor_artifact_ref?.path!==controller.path)throw Error('Test executor differs from full controller source manifest');
 }
}
const boundary={definition_state:'PREPARED_FOR_EXACT_INDEPENDENT_SCOPE_ACCEPTANCE',authority_effect:'NONE',
 controller_manifest_bound:controller!==null,controller_qualified:false,ga_issued:false};
const host={...boundary,kind:'FIXED_HOST_RUNTIME_CONFIG',controller_source_manifest:controller,
 endpoint:'Codex@DESK-W-591',host_platform:'Windows',docker_endpoint:'npipe:////./pipe/dockerDesktopLinuxEngine',
 runtime_binaries:'Exact Node/Python/GitHub CLI/Docker executable and loaded dependencies are in controller_source_manifest; recheck every byte before launch',
 docker_engine:{version:'29.7.2',os:'linux',architecture:'amd64'},
 image:{reference:image.value.requested_reference,manifest_digest:image.value.digest_domains.manifest_digest,
  config_digest:image.value.digest_domains.config_digest,public_environment:image.value.actual_image_inspect.Config.Env},
 profile:{profile_id:profile.value.profile_id,definition_version:profile.value.definition_version,sha256:profile.sha256},
 resources:{max_execution_seconds:600,cpu_millicores:500,memory_bytes:134217728,pids_limit:16,nonroot_uid:10001,
  network:'none',read_only_rootfs:true,cap_drop:['ALL'],no_new_privileges:true},
 mounts:[{destination:'/driver',access:'READ_ONLY',content:'Exactly accepted three Skill files and fixed_skill_fixture.py'},
  {destination:'/allowed',access:'READ_WRITE',content:'One attempt-specific synthetic directory'}],
 child_program:'Exact literal parent.CMD in the closed source manifest; Skill text is input data, never code',
 trusted_python_bridge_environment:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows',TEMP:'C:/Users/Windows/AppData/Local/Temp',TMP:'C:/Users/Windows/AppData/Local/Temp',HOMEDRIVE:'',HOMEPATH:'',LOGONSERVER:'',PATH:'',SYSTEMDRIVE:'',USERDOMAIN:'',USERNAME:'',USERPROFILE:''},
 trusted_python_bridge_environment_rule:'Exactly four fixed nonempty public infrastructure values and eight explicitly empty Windows variables prevent Node/libuv automatic inheritance; no caller process.env values are copied. The final source manifest must bind the enforcing launcher.',
 process_environment_boundary:'Docker/watchdog use the exact source-level public allowlist. The trusted bridge launcher must be separately checked in the final closed entry; no inherited credentials are permitted into the isolated child.',
 host_control_transports:credentials.value.host_transports,credential_scope:metadata(old+'CredentialScopeDefinition.json'),
 stop_policy:stopRef,image_observation:metadata('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/PythonImageBinding.json'),
 independent_control_generations:['runner_generation','credential_generation','session_generation'],
 source_freshness:'Actual current Root and execution state through the fixed trusted Supabase tool, then same-process fixed-source verifier; no local snapshot authority'};
host.byte_transport={source:metadata(q+'control-context-verifier-evidence-blob-successor/tool-entry.functions.js'),controller_manifest:controller,external_transport_manifest_requirement:'All seven fixed normal600-pipe-evidence-blob execution sources are exact entries of the controller manifest',
 directory:'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/qualification-live/<actual-ga-id>.<CREATE|START|GRR>.blob-pipe600',message_sequences:[1,2],maximum_json_bytes_including_lf:2097153,maximum_notice_characters:160,
 rules:'CreateNew exclusive attempt directory and raw archives; one exact compact JSON+LF message per sequence, exact SHA/UTF8/length; no arbitrary command/path/environment or timestamp substitution; startup READY precedes actual fresh SQL; CREATE/START record/dispatch carry actual timestamps unchanged; original final CAS remains bounded by 15 seconds.'};
const hostRef=out('HostRuntimeConfig.json',host);
const sink={...boundary,kind:'EXISTING_PRIVATE_CONTROL_EVIDENCE_SINK_BINDING',project_ref:'uscrdifznmlvczcekqpw',schema:'clued_control',
 installed_sql:metadata(q+'nonproduction-control-store/runtime-successor/budget-reservation-successor/install.candidate.sql'),
 installed_successor_sql:metadata(q+'nonproduction-control-store/runtime-successor/runtime600-successor/alter.candidate.sql'),
 table_roles:{execution_events:'immutable full raw Intent/Result/budget evidence, exact SHA and sequence',gate_attempts:'complete live GA/one unique terminal GRR and immutable decision/index',
  control_objects:'complete original immutable StatusManifest; unique original typed URI',execution_current:'current sequence, independent generations, pending/active reservation and conservative counters'},
 durability:'Existing PostgreSQL transaction commit followed by fresh actual typed readback; pre-dispatch prior transaction required',
 authority_boundary:'Existing same-domain evidence storage is not a new Canon/issuer. Root currentness comes only from the existing Root control tables.',
 unknown:'Retain original event, pending/active capacity and budget; no automatic redispatch/refund/deletion',
 ga_grr_signatures:'Full live payload remains private SQL; accepted fixed GitHub commitment signature channel binds complete payload digest',
 status_signature:'Original STATUS Owner-merge algorithm; complete live Status raw stays private SQL'};
sink.intent_response_compatibility_sql=metadata(q+'nonproduction-control-store/runtime-successor/intent-response-successor/alter.candidate.sql');
sink.binding_projection_successor_sql=metadata(q+'nonproduction-control-store/runtime-successor/binding-evidence-successor/alter.candidate.sql');
sink.original_input_transport={publisher:metadata(q+'control-context-verifier-evidence-blob-successor/original_input_publisher.py'),decoder:metadata(q+'control-context-verifier-evidence-blob-successor/original-inputs-blob.mjs'),
 repository:'tdoljyj/cross-memory-system',private_required:true,branch:'codex/phase2-qualification-evidence-20260908',
 path:'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/original-inputs-<actual-ga-id-without-ga_>/result.json',maximum_original_bytes:1048576,maximum_blob_envelope_bytes:4096,
 python_invocation:{executable:'C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe',flags:['-I','-S','-B','-X','utf8'],source_check:'Exact Python, publisher, verifier, GitHub CLI and all loaded dependencies from ControllerSourceManifest checked before import; no site or pyc write',github_executable:'C:/Program Files/GitHub CLI/gh.exe',environment:'Existing trusted host GitHub credential context; never inherited by Docker child; no new credential export',call:'GitHubEvidence(); publish_once(api, original-inputs-actual_ga_suffix, result, complete_original_raw_bytes, actual_fixed_branch_head)',ticket_directory:'scripts/phase2-qualification/control-context-verifier-evidence-blob-successor/work/original-inputs-<actual-ga-suffix>',ticket_files:['result-publication.json','result-blob.json','result-tree.json','result-commit.json']},
 sequence:'During PENDING preserve the complete actual original input locally; after actual STOPPED the trusted root publishes once with exact head/CAS, then reads back complete immutable commit/tree/blob bytes before producing the envelope.',
 authority:'Historical Evidence only; never live Root/current/Status/GA/GRR storage, never child credential or publication permission',
 completeness:'Original raw and 28 fault observations remain intact. The signed result chain covers original ref, blob publication observation, per-fault reconstruction and actual immutable byte verification. Original 128KiB SQL/index limits and 1MiB original-input bound remain unchanged.',
 actual_write_set_boundary:'Post-STOP Evidence transmission is distinct from completed test effects; no future GRR or blob publication target is falsely reported as a prior child/test write.'};
const sinkRef=out('EvidenceSinkDefinition.json',sink);
const readSet=[
 '/driver/SKILL.md','/driver/references/engineering.md','/driver/references/memory-operations.md','/driver/fixed_skill_fixture.py',
 '/proc/self/status','/sys/class/net',
 'host:exact ControllerSourceManifest files and accepted immutable input/ref bytes',
 'host:exact accepted historical component raw evidence and original source/time; read-only revalidation without restarting PostgreSQL',
 'host:existing fixed authenticated GitHub source/signature read interface for tdoljyj/cross-memory-system',
 'host:existing trusted Supabase fixed clued_control current/read_execution/read_execution_event interfaces for uscrdifznmlvczcekqpw',
 'host:exact Docker image and this attempt container inspection',
 'host:preentry-parent/work/<nonce>/ exact retained local evidence and fixed empty Docker config'
];
const writeSet=[
 '/allowed/fixture.json',
 'host:preentry-parent/work/<nonce>/ fixed source staging and CreateNew local Intent/output/STOP evidence',
 'host:Docker create/start/stop/wait for the one fixed synthetic container; mutation always uses exact observed ID after create',
 'host:clued_control immutable execution_events and exact current/gate_attempts transitions through accepted fixed functions only',
 'host:fixed private auxiliary signature commitment path for this exact GA/GRR through accepted Owner channel'
];
const forbidden=[
 'production or business Canon mutation','business credential/token issuance or export','real user payload or private Gold read',
 'real model or paid action','arbitrary command, executable, environment, mount or target','candidate Skill self-qualification or authority assertion',
 'PQUAL-18 post-Entry positive or any Entry/RC/production grant','Root/Owner/issuer purpose expansion or old pins rewrite',
 'automatic UNKNOWN redispatch, capacity release or budget refund','container/image/volume removal or evidence deletion'
];
const scope={...boundary,kind:'FIXED_PREENTRY_EXECUTION_SCOPE',purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',
 dominant_role:'TEST_CONTROLLER',dominant_role_meaning:'This scope label denotes the root-operated fixed host supervising the isolated test subject; it creates no new authorized identity and never transfers Owner/independent-assessor authority.',
 controller_source_manifest:controller,host_runtime_config:hostRef,evidence_sink:sinkRef,
 gate:{gate_id:'G-PREENTRY-SKILL-QUALIFICATION',definition_version:'fixed-synthetic-20260909.v4-evidence-blob',complete_test_and_gate_suite:plan},
 plan_digest_rule:'SHA256 of the complete exact final nineteen-TestManifest/Gate suite bytes; each case setup and oracle remains in this plan, not in the fixture identity',
 fixture_set:{encoding:'SINGLE_EXACT_FILE_SHA256_ONLY_WHILE_ALL_19_TEST_FIXTURE_REFS_ARE_IDENTICAL',file:fixture,
  scope:'The unique fixed primitive contains the exact synthetic fixture literal. This does not assert it executes nineteen cases or proves Skill behavior.',
  invalidation:'Any added or changed fixture requires a forward exact fixture-set definition/digest and independent applicability review'},
 actor:metadata(old+'ControlActorDefinition.json'),subject:metadata(old+'SkillSubjectManifest.json'),credential_scope:metadata(old+'CredentialScopeDefinition.json'),
 risk:riskRef,recovery:recoveryRef,
 nonce_rule:'lowercase first 32 hex characters of SHA256(UTF8("clued-fixed-host-v1\\0" + actual signed gate_authorization_id)); the source uses a NUL separator, never arbitrary caller paths',
 nonce_placeholder_is_caller_wildcard:false,
 allowed_read_set:readSet,allowed_write_set:writeSet,write_target_rules:fixedWriteTargetRules,forbidden_actions:forbidden,
 historical_component_evidence:{index:metadata('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime600-component-observation/EvidenceIndex.json'),mode:'HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED',side_effects:'NONE; no formal PostgreSQL fixture execution or write target'},
 upstream_gate_result_receipt_refs:[],upstream_applicability:'This atomic pre-entry Gate declares no upstream GRR dependency; R05-R10 remain exact stage source refs, never renamed GRRs.',
 required_stages:['R05','R06','R07','R08','R09','R10'],excluded_circular_stages:['R11','R12','R13','R14'],
 business_layers:'Only the exact accepted Profile reasons and N/A vector; independent Root/runner/credential/session generations remain mandatory',
 budgets:{aggregate_seconds_max:7200,aggregate_evidence_bytes_max:1073741824,per_allocation_seconds:600,per_allocation_evidence_bytes:134217728,
  prior_engineering_observation:{charged_seconds_conservative:1506,observed_storage_bytes:321498035,metadata_storage_reserve_bytes:1048576,initial_storage_accounting_bytes:322546611,
   source:'Root coordinator actual prior accounting plus this agent no-follow metadata count of the two exact PG work directories and preserved raw copies; 6 seconds conservatively charged for the completed 5663ms and pre-start failure.',
   boundary:'The 1MiB is a conservative new metadata reserve, not a claim of actual measured use. These are preparation inputs for actual same-domain counters; current live counter readings remain mandatory and no previous charge is refunded.'},
  reservation:'Actual prior-committed same-domain BUDGET_RESERVED event, consumed only by this exact GA; no allocation is issued by this definition'},
 no_future_hash_dependencies:['qualification metadata','Status full object or signature','runtime acceptance','future source commit'],
 qualification_boundary:'The fixed file action is a primitive only; this Scope makes no test-result or full Skill-behavior assertion'};
scope.evidence_transport={host:host.byte_transport,original_inputs:sink.original_input_transport,child_permissions_changed:false,test_write_target_rules_changed:false};
scope.budgets.registration_preparation_observation={observed_at:'2026-09-08T21:50:45.88834+00',charged_seconds:2706,charged_evidence_bytes:590982067,source:'Root actual restored terminal snapshot and independent verification 0e6ff1f1ca9ed8a5801479ed99e3ff5a1f3902bf1197d7b053cb8336d3d56a81',meaning:'Historical observed actual cumulative counters, distinct from immutable binding seed floors 1506/322546611. Registration and every allocation require actual current counters and preserve all previous charges.'};
scope.forward_binding_boundary='One independently accepted and signed same-scope binding event projects the new exact controller/Scope/Gate/runtime; original binding, terminal attempts, Root and all counters remain. No arbitrary binding API or new authority is introduced.';
const scopeRef=out('ExecutionScopeDefinition.json',scope);
const binding={...boundary,kind:'FIXED_CONTROL_BINDING_DEFINITION_NOT_BUSINESS_BINDING_RECEIPT',root_set_id:'ctr_414bd3c724264a83894b0c55cf2ab878',
 control_root_generation:'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12',delegation_ref:owner.value.delegation_ref,
 actor:metadata(old+'ControlActorDefinition.json'),subject:metadata(old+'SkillSubjectManifest.json'),
 controller_source_manifest:controller,host_runtime_config:hostRef,execution_scope:scopeRef,
 control_generation_rules:'Actual independently issued runner/credential/session values are freshly read and compared; no business Binding or epoch is created here',
 business_binding_layer:'NOT_APPLICABLE_ONLY_UNDER_ACCEPTED_FIXED_PROFILE',
 immutable_direction:'controller -> host config -> execution scope -> this control binding; no future qualification/Status/runtime hash is referenced'};
const bindingRef=out('ControlBindingDefinition.json',binding);
const authority={kind:'ROOT_REFERENCE_OBSERVATION_NOT_LIVE_AUTHORITY',
 authority_source_ref:{uri:'urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:ctr_414bd3c724264a83894b0c55cf2ab878',sha256:'fa58df2b1a7572848c288dc862767a4a9983d42696d50dbc4064af7275cec328'},
 root_generation:'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12',sequence:2,
 observation_provenance:{observed_at:'2026-09-08T16:08:51Z',channel:'Root coordinator actual private Supabase readback, canonicalDigest recomputed from complete body',independent_check:'Root reported independent 16:11 UTC deepEqual; this description is provenance, not a replacement for the original independent report'},
 digest_domain:'Existing accepted Root canonicalDigest(body), not the hash of this observation file',
 use_rule:'The actual current Root must be freshly read, canonicalDigest recomputed and reference/generation/revocation checked by the fixed verifier before each applicable action. This historical reference does not itself establish currentness.',authority_effect:'NONE'};
const authorityRef=out('AuthorityReferenceObservation.json',authority);
const readiness={state:controller&&plan?'EXACT_LOCAL_CLOSURE_BOUND_PENDING_INDEPENDENT_REVIEW':'WAITING_FOR_FINAL_CONTROLLER_MANIFEST_AND_STATIC_PLAN_BYTES',
 definitions:{host_runtime_config:hostRef,evidence_sink:sinkRef,scope:scopeRef,binding:bindingRef},
 field_values:{host_runtime_config_digest:hostRef.sha256,allowed_read_set:readSet,allowed_write_set:writeSet,forbidden_actions:forbidden,
  scope_digest:scopeRef.sha256,dominant_role:'TEST_CONTROLLER',upstream_gate_result_receipt_refs:[],authority_source_ref:authority.authority_source_ref},
 authority_reference_observation:authorityRef,
 fixed_controller_digest:controller?.sha256??null,reference_fields_require_actual_publication:['scope_ref','binding_ref','evidence_sink_ref'],
 authority_effect:'NONE',accepted:false,executable:false};
out('HostScopePreparation.json',readiness);
const candidateBindings={};
for(const [field,value] of Object.entries(readiness.field_values)){
 const source=field==='host_runtime_config_digest'?hostRef:field==='authority_source_ref'?authorityRef:scopeRef;
 candidateBindings[field]={value,provenance:{source:source.path,sha256:source.sha256}};
}
if(controller)candidateBindings.controller_digest={value:controller.sha256,provenance:{source:controller.path,sha256:controller.sha256}};
if(plan)candidateBindings.plan_digest={value:plan.sha256,provenance:{source:plan.path,sha256:plan.sha256}};
candidateBindings.fixtures_digest={value:fixture.sha256,provenance:{source:fixture.path,sha256:fixture.sha256}};
const prospectiveBlobRef=ref=>{
 const raw=fs.readFileSync(new URL(ref.path,root));
 const oid=crypto.createHash('sha1').update(Buffer.from('blob '+raw.length+'\0')).update(raw).digest('hex');
 return {uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+oid,sha256:ref.sha256};
};
for(const [field,ref] of [['scope_ref',scopeRef],['binding_ref',bindingRef],['evidence_sink_ref',sinkRef]])
 candidateBindings[field]={value:prospectiveBlobRef(ref),provenance:{source:ref.path,sha256:ref.sha256}};
const artifactSources=[metadata(old+'SkillSubjectManifest.json'),fixture,hostRef,scopeRef,sinkRef,bindingRef,stopRef,recoveryRef,riskRef];
if(controller)artifactSources.push(controller);
if(plan)artifactSources.push(plan,metadata(q+'control-context-verifier-evidence-blob-successor/GateDefinitionCandidate.json'));
const artifactIndex=out('ArtifactReferencesCandidate.json',{state:readiness.state,
 artifacts:artifactSources.map(ref=>({...ref,prospective_ref:prospectiveBlobRef(ref)})),
 ga_artifact_refs:artifactSources.map(prospectiveBlobRef),
 publication_verified:false,authority_effect:'NONE'});
if(controller&&plan)candidateBindings.artifact_refs={value:artifactSources.map(prospectiveBlobRef),provenance:{source:artifactIndex.path,sha256:artifactIndex.sha256}};
const controlSchemas={};
for(const [type,name] of [['StatusManifest','status-manifest.candidate.schema.json'],['GateResultReceipt','gate-result-receipt.candidate.schema.json']]){
 const file=q+'control-context-verifier-runtime180/'+name;
 if(fs.existsSync(new URL(file,root))){const ref=metadata(file);controlSchemas[type]={source:ref,prospective_ref:prospectiveBlobRef(ref)};}
}
const runtimeInputs={result_reviewer_ref:{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/e7f738ae3c247e41733872ab95387440205c736a',sha256:'e09ef634712ce1206600402552073bae91e7296f2b4e2d3f99855bd760c944bd'},
 result_reviewer_semantics:{role_pointer:'/scope/independent_assessor',expected:'/root/project_list_auth_fix',independence_pointer:'/independence',source:'Actual Owner delegation exact original bytes, not a new identity Registry'},
 gate_suite_ref:plan?prospectiveBlobRef(plan):null,control_schema_sources:controlSchemas,
 control_schema_refs:Object.fromEntries(Object.entries(controlSchemas).map(([type,item])=>[type,item.prospective_ref]))};
out('HostScopeBindingsCandidate.json',{state:readiness.state,bindings:candidateBindings,
 runtime_subject_additional_inputs:runtimeInputs,
 publication_boundary:'Prospective Git blob identifiers are computed from exact local bytes only. They MUST be published through the existing reviewed source workflow and independently read back before actual use. This file proves neither publication nor acceptance.',
 remaining_inputs:['source_ref actual immutable source commit/tree/blob readback','artifact_refs final exact Gate/Test/controller/subject/fixture published objects','controller_qualification_ref actual independent qualification',...(!plan?['plan_digest final exact applicable plan source']:[]),...(!controller?['controller_digest final closed executable source manifest']:[])],
 authority_effect:'NONE',accepted:false,executable:false});
const originalBindings=read(old+'PreparedBindings.json').value.bindings;
for(const item of Object.values(originalBindings)){
 if(!item.provenance.source.startsWith(old)||metadata(item.provenance.source).sha256!==item.provenance.sha256)throw Error('Coordinator input definition drift');
}
const overrides={
 stop_policy_digest:{value:stopRef.sha256,provenance:{source:stopRef.path,sha256:stopRef.sha256}},
 rollback_point_ref:{value:prospectiveDefinitionRef(recoveryRef),provenance:{source:recoveryRef.path,sha256:recoveryRef.sha256}},
 release_risk_manifest_digest:{value:riskRef.sha256,provenance:{source:riskRef.path,sha256:riskRef.sha256}}
};
out('InputDefinitionSuccessor.json',{authority_effect:'NONE',reason:'Same 600-second child/Profile/STOP/recovery bytes; new exact controller, pipe and historical-blob Evidence transport, forward effective binding and explicit transport risk. Original runtime600 metadata is preserved.',originals:[stopOriginal,recoveryOriginal,riskOriginal].map(({path,sha256,bytes})=>({path,sha256,bytes})),successors:[stopRef,recoveryRef,riskRef],bindings:overrides});
const assembled=prepareLate({...originalBindings,...overrides,...candidateBindings},null);
assembled.host_scope_state=readiness.state;
assembled.runtime_subject_additional_inputs=runtimeInputs;
assembled.publication_verified=false;
out('AssembledHostScopeCandidate.json',assembled);
const gateDefinition=plan?metadata(q+'control-context-verifier-evidence-blob-successor/GateDefinitionCandidate.json'):null;
const profilePayload=metadata(q+'preentry-parent/profile-runtime600/signing/ProfileSigningPayload.json');
const componentIndex=read('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime600-component-observation/EvidenceIndex.json');
const applicability=metadata('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/Runtime600ComponentEvidenceIndependentApplicability.json');
if(applicability.sha256!=='33f0e105811b9b8f85919cbedee823c4d29baa2b52131da34dbab85717d14a93')throw Error('Exact historical component applicability changed');
const sourceMetadata=componentIndex.value.exact_sources.map(item=>{
 const path=item.path.replaceAll('\\','/').split('/kernel-phase2-repo/')[1];
 if(!path)throw Error('Exact repository component source required');
 const actual=metadata(path);if(actual.sha256!==item.sha256||actual.bytes!==item.bytes)throw Error('Original component source changed');return actual;
});
const historicalBindings=['PQUAL-11','PQUAL-13','PQUAL-15','PQUAL-16','PQUAL-17'].map(test_id=>{
 const entries=componentIndex.value.raw_files.filter(x=>x.path.endsWith('/'+test_id+'.json'));
 if(entries.length!==1)throw Error('One exact original case source required');
 const file=read(entries[0].path);if(file.sha256!==entries[0].sha256||file.value.case_id!==test_id)throw Error('Original component bytes or identity changed');
 return {test_id,original_observed_at:file.value.started_at,original_ref:prospectiveBlobRef(file),
  original_subject_refs:sourceMetadata.map(prospectiveBlobRef),current_source_refs:sourceMetadata.filter(x=>x.path.endsWith('.sql')).map(({path,sha256})=>({path,sha256})),applicability_ref:prospectiveBlobRef(applicability)};
});
out('HistoricalComponentBindingsCandidate.json',{authority_effect:'NONE',publication_verified:false,bindings:historicalBindings,
 boundary:'Preserves exact original actual engineering observations. Actual immutable blobs must be published/read before runtime acceptance; no historical facts are reissued or called current-GA execution.'});
out('RuntimeAcceptedSubjectCandidate.json',{state:'NON_ISSUING_COMPLETE_RUNTIME_SUBJECT_PREPARATION',
 accepted_subject_candidate:{root_id:'ctr_414bd3c724264a83894b0c55cf2ab878',project_ref:'uscrdifznmlvczcekqpw',
  gate:{gate_id:'G-PREENTRY-SKILL-QUALIFICATION',definition_version:'fixed-synthetic-20260909.v4-evidence-blob',content_digest:gateDefinition?.sha256??null},
  expected_ga:assembled.expected_ga,late_bound_fields:assembled.late_bound_fields,required_stages:assembled.required_stages,
  profile_signing_payload_ref:prospectiveBlobRef(profilePayload),gate_suite_ref:runtimeInputs.gate_suite_ref,
  control_schema_refs:runtimeInputs.control_schema_refs,result_reviewer_ref:runtimeInputs.result_reviewer_ref,historical_component_evidence:historicalBindings},
 remaining_actual_inputs:[...assembled.unresolved_fields,'actual original Status canonical signing-payload digest'],
 assembly_order:'Freeze controller/host/scope -> independent exact qualification -> root actual first source commit/tree/blob readback -> root Status payload -> fill fixed source_ref/controller_qualification_ref and exact Status policy digest -> independent final runtime decision -> existing Owner signing workflow',
 late_binding_boundary:'source_ref and controller_qualification_ref are missing assembly inputs only; they MUST be fixed in the final accepted expected_ga. They are not additional runtime late-bound fields. Only the existing three exact resolver policies remain.',
 publication_verified:false,accepted:false,authority_effect:'NONE',ga_issued:false,executable:false});
console.log(JSON.stringify({state:readiness.state,controller_digest:readiness.fixed_controller_digest,definitions:4,authority_effect:'NONE'}));
