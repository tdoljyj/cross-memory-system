import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {checkResultEvidenceStructure as check} from './resolve.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),encode=x=>JSON.stringify(x)+'\n';
function fixture(){
 const root='test-root',prefix='urn:clued:execution-evidence:'+root+':';
 const controller=hash('controller'),skill=hash('skill'),fix=hash('fixture');
 const reference=value=>({uri:prefix+hash(value),sha256:hash(value)});
 const reviewer=reference('actual-reviewer-definition'),executorActor=reference('executor-definition');
 const ga={gate_authorization_id:'ga_pure_component_fixture',controller_digest:controller,candidate_skill_digest:skill};
 const gaRaw=encode(ga),gaSha=hash(gaRaw),executor={uri:prefix+controller,sha256:controller};
 const suite={tests:{}},artifacts=[],tests=[],results=[];
 const add=value=>{const raw=encode(value),ref=reference(raw);artifacts.push({...ref,raw});return ref;};
 for(let n=1;n<=20;n++){
  if(n===18)continue;const id='PQUAL-'+String(n).padStart(2,'0');
  const expected='Pure component expected outcome '+id;
  const def={test_id:id,definition_version:'component-fixture-v1',oracle:{expected,source_oracle_sha256:hash(expected)},executor_artifact_ref:{sha256:controller},fixture_artifact_ref:{sha256:fix}};
  suite.tests[id]=def;const defSha=hash(JSON.stringify(def,null,2)+'\n');
  const observed=add({kind:'ACTUAL_TEST_OBSERVATION',ga_id:ga.gate_authorization_id,ga_sha256:gaSha,test_id:id,observed_at:'2026-09-08T15:00:00Z',source:{raw:'synthetic component fixture only',sha256:hash('synthetic component fixture only')}});
  const assessment=add({kind:'INDEPENDENT_TEST_ORACLE_ASSESSMENT',ga_id:ga.gate_authorization_id,ga_sha256:gaSha,test_id:id,test_definition_digest:defSha,expected_outcome_digest:hash(expected),observation_refs:[observed],result:'PASS',reviewer_ref:reviewer,reason:'Synthetic component fixture, not an actual independent acceptance'});
  tests.push({test_id:id,observation_refs:[observed],oracle_assessment_ref:assessment});
  results.push({test_id:id,test_definition_digest:defSha,expected_outcome_digest:hash(expected),evidence_refs:[observed],result:'PASS'});
 }
 const suiteRaw=JSON.stringify(suite,null,2)+'\n';
 const index={format:'EXACT_ORIGINAL_EVIDENCE_INDEX_V1',ga_id:ga.gate_authorization_id,ga_sha256:gaSha,executor_ref:executor,test_revision:'component-fixture-v1',performance_slo_revision:'component-fixture-v1',fixture_refs:[{uri:prefix+fix,sha256:fix}],input_artifact_digests:[skill,controller,hash(suiteRaw)],artifacts,tests};
 const decision={ga_id:ga.gate_authorization_id,ga_sha256:gaSha,result:'PASS',test_results:results};
 const reservation={decision_raw:encode(decision),decision_sha256:hash(encode(decision)),evidence_index_raw:encode(index),evidence_index_sha256:hash(encode(index))};
 const receipt={gate_authorization_id:ga.gate_authorization_id,gate_authorization_sha256:gaSha,result:'PASS',decision_sha256:reservation.decision_sha256,evidence_index_ref:reference(encode(index)),executor_ref:executor,test_revision:index.test_revision,performance_slo_revision:index.performance_slo_revision,fixture_refs:index.fixture_refs,input_artifact_digests:index.input_artifact_digests,test_results:results,raw_evidence_refs:artifacts.map(({uri,sha256})=>({uri,sha256})),independent_reviewer_ref:reviewer,executor_actor_ref:executorActor};
 const state={binding:{root_id:root},attempts:[{ga_id:ga.gate_authorization_id,ga_raw:gaRaw,ga_sha256:gaSha,decision:reservation}]};
 return {receipt,ga,state,acceptedSuiteRaw:suiteRaw,acceptedSuiteSha256:hash(suiteRaw)};
}
function rewriteIndex(input,fn){const reserved=input.state.attempts[0].decision,index=JSON.parse(reserved.evidence_index_raw);fn(index);reserved.evidence_index_raw=encode(index);reserved.evidence_index_sha256=hash(reserved.evidence_index_raw);input.receipt.evidence_index_ref={uri:'urn:clued:execution-evidence:test-root:'+reserved.evidence_index_sha256,sha256:reserved.evidence_index_sha256};}
test('complete synthetic 19-test integrity fixture requires real signature verification and issues nothing',()=>{const x=check(fixture());assert.equal(x.required_signed_assessments.length,19);assert.equal(x.independent_assessment_authenticity_verified,false);assert.equal(x.not_final_receipt_admission,true);});
test('raw data changed inside a newly hashed index still fails original artifact digest',()=>{const f=fixture();rewriteIndex(f,x=>x.artifacts[0].raw+=' ');assert.throws(()=>check(f),/EXACT_ORIGINAL_ARTIFACT_BYTES/);});
test('removing an original observation cannot be hidden by rehashing the index',()=>{const f=fixture();rewriteIndex(f,x=>x.artifacts.shift());assert.throws(()=>check(f),/UNRESOLVED/);});
test('duplicated index test cannot replace a required case',()=>{const f=fixture();rewriteIndex(f,x=>x.tests[1]=x.tests[0]);assert.throws(()=>check(f),/DUPLICATE_INDEX_TEST/);});
test('matching an altered oracle sentence cannot preserve accepted expected digest',()=>{const f=fixture(),s=JSON.parse(f.acceptedSuiteRaw);s.tests['PQUAL-01'].oracle.expected='forged expected';f.acceptedSuiteRaw=JSON.stringify(s,null,2)+'\n';f.acceptedSuiteSha256=hash(f.acceptedSuiteRaw);f.receipt.input_artifact_digests[2]=f.acceptedSuiteSha256;rewriteIndex(f,x=>x.input_artifact_digests=f.receipt.input_artifact_digests);assert.throws(()=>check(f),/EXACT_TEST_DEFINITION_DIGEST/);});
test('declaring the executor to be its own reviewer is rejected',()=>{const f=fixture();f.receipt.executor_actor_ref=f.receipt.independent_reviewer_ref;assert.throws(()=>check(f),/DISTINCT_REVIEWER_REFERENCE/);});
test('a bare PASS string cannot replace the actual reserved result/test list',()=>{const f=fixture();f.receipt.test_results=[];assert.throws(()=>check(f),/RESERVED_RESULT_AND_TESTS/);});
test('a raw decision from another GA is rejected even with recomputed local hashes',()=>{const f=fixture(),r=f.state.attempts[0].decision,d=JSON.parse(r.decision_raw);d.ga_id='ga_another';r.decision_raw=encode(d);r.decision_sha256=hash(r.decision_raw);f.receipt.decision_sha256=r.decision_sha256;assert.throws(()=>check(f),/SAME_GA_INDEX_AND_DECISION/);});
