import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const dir=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(dir,'../../../..');
const enc=x=>JSON.stringify(x,null,2)+'\n',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(x,m)=>{if(!x)throw Error(m);};
export function readBundle(){return Object.fromEntries(['GateDefinitionCandidate.json','RegistrySuccessorCandidate.json','preentry-skill-qualification.json','SourceBindings.json'].map(n=>[n,JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))]));}
export function validate(b){
 const g=b['GateDefinitionCandidate.json'],r=b['RegistrySuccessorCandidate.json'],suite=b['preentry-skill-qualification.json'],s=b['SourceBindings.json'];
 const id='G-PREENTRY-SKILL-QUALIFICATION',ver='fixed-synthetic-20260908.v1';
 check(g.object_type==='GateManifest'&&g.gate_id===id&&g.typed_uri==='urn:clued:gate:'+id&&g.definition_version===ver,'GATE_ID_TYPE_VERSION');
 check(r.state==='PROPOSED_NOT_APPLIED'&&r.authority_effect==='NONE'&&r.original_frozen_registry_and_pins_unchanged===true,'NOT_REGISTERED');
 check(Object.keys(suite.gates).length===1&&enc(suite.gates[id])===enc(g),'EXACT_GATE_SOURCE');
 check(r.addition.object_type===g.object_type&&r.addition.gate_id===id&&r.addition.typed_uri===g.typed_uri&&r.addition.definition_version===ver,'REGISTRY_TYPE_BINDING');
 check(r.addition.content_digest==='sha256:'+hash(enc(g))&&r.addition.definition_source.sha256===hash(enc(suite))&&r.addition.definition_source.canonical_pointer==='#/gates/'+id,'REGISTRY_DIGEST');
 check(s.definition_set_digest==='sha256:'+hash(enc([r.addition])),'DEFINITION_SET_DIGEST');
 check(g.purpose==='SKILL_COEXISTENCE_QUALIFICATION'&&g.environment==='ISOLATED_TEST'&&g.profile_ref.profile_id==='DP-PREENTRY-SKILL-QUALIFICATION','SCOPE');
 check(enc(g.execution)===enc({environment_class:'ISOLATED_TEST',maximum_seconds:90,memory_bytes:134217728,cpu_millicores:500,pids:16,network:'none',model_calls:0,paid_calls:0}),'EXACT_LIMITS');
 check(enc(g.prerequisites.stage_receipts)===enc(['R05','R06','R07','R08','R09','R10'])&&enc(g.prerequisites.excluded_circular_stage_dependencies)===enc(['R11','R12','R13','R14']),'STAGE_BOUNDARY');
 for(const k of ['accepted_controller_independent_of_skill','accepted_exact_execution_profile','registered_atomic_gate','actual_owner_root_issuer_current','per_action_ga_required'])check(g.prerequisites[k]===true,'PREREQUISITE_REMOVED');
 for(const k of ['gate_authorization_id','allowed_write_set','credential_scope','issued_at','expires_at','target_scope','inputs'])check(!(k in g),'DYNAMIC_FIELD_IN_STATIC_GATE');
 for(const ref of Object.values(s.sources)){const bytes=fs.readFileSync(path.resolve(repo,ref.path));check(hash(bytes)===ref.sha256&&bytes.length===ref.bytes,'SOURCE_DRIFT');}
 const cases=JSON.parse(fs.readFileSync(path.resolve(repo,s.sources.cases.path),'utf8')).scenarios.filter(c=>c.id!=='PQUAL-18');
 check(Object.keys(suite.tests).length===19&&g.test_refs.length===19&&!suite.tests['PQUAL-18'],'CASE_APPLICABILITY');
 check(g.test_requirements.post_entry_positive.id==='PQUAL-18'&&g.test_requirements.post_entry_positive.state==='OUTSIDE_THIS_GATE_SCOPE_NOT_EXECUTED_NOT_PASSED','POST_ENTRY_EXCLUSION');
 for(const c of cases){
  const t=suite.tests[c.id],refs=g.test_refs.filter(x=>x.test_id===c.id);
  check(t?.object_type==='TestManifest'&&t.typed_uri==='urn:clued:test:'+c.id&&t.definition_version===ver&&t.setup_or_fault===c.setup_or_fault&&t.oracle.expected===c.expected&&t.oracle.source_oracle_sha256===hash(Buffer.from(c.expected,'utf8')),'EXACT_TEST_ORACLE');
  check(refs.length===1&&refs[0].content_digest==='sha256:'+hash(enc(t))&&refs[0].canonical_pointer==='#/tests/'+c.id,'TEST_REFERENCE');
  check(t.data_classification==='FIXED_SYNTHETIC_ONLY'&&t.fixture_artifact_ref.sha256===s.sources.fixture.sha256&&t.requirement_refs.length===5,'TEST_INPUT_BINDING');
 }
 return {state:'LOCAL_STATIC_CANDIDATE_CHECKED',gate_registered:false,ga_issued:false,tests_executed:0,applicable_test_definitions:19};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(validate(readBundle())));
