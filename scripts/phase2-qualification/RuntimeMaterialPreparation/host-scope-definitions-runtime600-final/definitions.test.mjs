import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {fixedWriteTargetRules} from '../../control-context-verifier-runtime600/write-targets.mjs';
const root=new URL('../../../../',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function checkRef(ref){const raw=fs.readFileSync(new URL(ref.path,root));assert.equal(hash(raw),ref.sha256);assert.equal(raw.length,ref.bytes);}
test('600-second closure and dependency successors bind exact bytes without changing authority',()=>{
 const host=read('HostRuntimeConfig.json'),scope=read('ExecutionScopeDefinition.json'),binding=read('ControlBindingDefinition.json');
 const changes=read('InputDefinitionSuccessor.json'),stop=read('StopPolicyDefinition.json');
 assert.equal(host.controller_manifest_bound,true);checkRef(host.controller_source_manifest);
 assert.deepEqual(host.controller_source_manifest,scope.controller_source_manifest);
 for(const ref of [scope.host_runtime_config,scope.evidence_sink,binding.execution_scope,...changes.successors])checkRef(ref);
 for(const object of [host,scope,binding]){assert.equal(object.authority_effect,'NONE');assert.equal(object.controller_qualified,false);assert.equal(object.ga_issued,false);}
 assert.equal(host.resources.max_execution_seconds,600);assert.equal(scope.budgets.per_allocation_seconds,600);assert.equal(stop.deadline_limit_seconds,600);
 assert.equal(stop.independent_guard_stop_reserve_seconds,30);assert.equal(stop.minimum_start_remaining_seconds,36);
 assert.equal(read('RecoveryBoundaryDefinition.json').stop_policy_ref.sha256,hash(fs.readFileSync(new URL('StopPolicyDefinition.json',import.meta.url))));
 assert.equal(read('ScopedRiskManifest.json').recovery_ref.sha256,hash(fs.readFileSync(new URL('RecoveryBoundaryDefinition.json',import.meta.url))));
 const ga=read('RuntimeAcceptedSubjectCandidate.json').accepted_subject_candidate.expected_ga;
 assert.equal(ga.stop_policy_digest,host.stop_policy.sha256);assert.equal(ga.profile_digest,host.profile.sha256);
 assert.equal(Object.hasOwn(scope,'runtime_acceptance_ref'),false);assert.equal(Object.hasOwn(host,'scope_digest'),false);
});
test('actual write interpretation and historical evidence remain exact and non-executable',()=>{
 const scope=read('ExecutionScopeDefinition.json'),host=read('HostRuntimeConfig.json');
 assert.deepEqual(scope.write_target_rules,fixedWriteTargetRules);assert.equal(scope.write_target_rules.caller_patterns_allowed,false);
 assert.equal(scope.write_target_rules.observation_interval,'COMPLETED_TEST_EFFECTS_THROUGH_ORIGINAL_STOPPED_EVENT');
 assert.equal(scope.historical_component_evidence.mode,'HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED');checkRef(scope.historical_component_evidence.index);
 assert.equal(scope.allowed_write_set.some(x=>/postgres|SQL_FIXTURE/i.test(x)),false);
 assert.equal(host.mounts.length,2);assert.equal(scope.dominant_role,'TEST_CONTROLLER');assert.deepEqual(scope.upstream_gate_result_receipt_refs,[]);
 checkRef(scope.gate.complete_test_and_gate_suite);const suite=JSON.parse(fs.readFileSync(new URL(scope.gate.complete_test_and_gate_suite.path,root)));
 assert.equal(Object.keys(suite.tests).length,19);
 for(const entry of Object.values(suite.tests)){assert.equal(entry.executor_artifact_ref.sha256,host.controller_source_manifest.sha256);assert.equal(entry.fixture_artifact_ref.sha256,scope.fixture_set.file.sha256);}
 const subject=read('RuntimeAcceptedSubjectCandidate.json').accepted_subject_candidate;
 assert.deepEqual(Object.keys(subject.late_bound_fields).sort(),['budget_reservation_ref','status_manifest_ref','target_revision']);
 assert.equal(subject.late_bound_fields.budget_reservation_ref.maximum_seconds,600);
});
test('final wrapper closure, current accounting and original component references stay exact',()=>{
 const scope=read('ExecutionScopeDefinition.json'),host=read('HostRuntimeConfig.json'),binding=read('ControlBindingDefinition.json');
 for(const ref of [host.controller_source_manifest,scope.host_runtime_config,scope.evidence_sink,binding.execution_scope,scope.gate.complete_test_and_gate_suite])checkRef(ref);
 const manifest=JSON.parse(fs.readFileSync(new URL(host.controller_source_manifest.path,root)));
 assert(manifest.files.some(x=>x.path.endsWith('/request-denials-packed.mjs')));
 const budget=scope.budgets.prior_engineering_observation;
 assert.equal(budget.charged_seconds_conservative,1506);assert.equal(budget.observed_storage_bytes,321498035);
 assert.equal(budget.initial_storage_accounting_bytes,budget.observed_storage_bytes+budget.metadata_storage_reserve_bytes);
 const subject=read('RuntimeAcceptedSubjectCandidate.json').accepted_subject_candidate;
 assert.equal(subject.expected_ga.controller_digest,host.controller_source_manifest.sha256);
 assert.equal(subject.expected_ga.scope_digest,binding.execution_scope.sha256);
 assert.equal(subject.expected_ga.stop_policy_digest,host.stop_policy.sha256);
 assert.equal(subject.historical_component_evidence.length,5);
 for(const c of subject.historical_component_evidence){
  assert.equal(c.original_subject_refs.length,4);assert.equal(c.current_source_refs.length,3);
  for(const ref of c.current_source_refs){assert(manifest.files.some(x=>x.path===ref.path&&x.sha256===ref.sha256));assert.equal(hash(fs.readFileSync(new URL(ref.path,root))),ref.sha256);}
  assert.equal(c.applicability_ref.sha256,'33f0e105811b9b8f85919cbedee823c4d29baa2b52131da34dbab85717d14a93');
 }
});
