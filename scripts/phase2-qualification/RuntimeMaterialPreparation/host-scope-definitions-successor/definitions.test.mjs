// Pure metadata consistency checks, no execution or acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
const root=new URL('../../../../',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
function checkRef(ref){const raw=fs.readFileSync(new URL(ref.path,root));assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),ref.sha256);assert.equal(raw.length,ref.bytes);}
test('scope has one-direction exact local dependencies and creates no qualification',()=>{
 const host=read('HostRuntimeConfig.json'),scope=read('ExecutionScopeDefinition.json'),binding=read('ControlBindingDefinition.json');
 assert.equal(host.controller_manifest_bound,true);assert.equal(scope.controller_manifest_bound,true);
 checkRef(host.controller_source_manifest);assert.deepEqual(host.controller_source_manifest,scope.controller_source_manifest);
 checkRef(scope.host_runtime_config);checkRef(scope.evidence_sink);checkRef(binding.execution_scope);checkRef(binding.host_runtime_config);
 for(const value of [host,scope,binding]){assert.equal(value.authority_effect,'NONE');assert.equal(value.controller_qualified,false);assert.equal(value.ga_issued,false);}
 assert.equal(Object.hasOwn(scope,'qualification_ref'),false);assert.equal(Object.hasOwn(scope,'runtime_acceptance_ref'),false);assert.equal(Object.hasOwn(host,'scope_digest'),false);
});
test('both isolated child and trusted host access are explicit while accepted role/upstream bounds remain fixed',()=>{
 const scope=read('ExecutionScopeDefinition.json'),host=read('HostRuntimeConfig.json');
 assert.equal(scope.dominant_role,'TEST_CONTROLLER');assert.deepEqual(scope.upstream_gate_result_receipt_refs,[]);
 assert(scope.allowed_read_set.includes('/proc/self/status'));assert(scope.allowed_read_set.includes('/sys/class/net'));
 assert(scope.allowed_write_set.includes('/allowed/fixture.json'));assert(scope.allowed_read_set.some(x=>x.startsWith('host:existing trusted Supabase')));
 assert.equal(host.mounts.length,2);assert.equal(host.mounts[0].access,'READ_ONLY');assert.equal(host.resources.max_execution_seconds,180);
 assert.equal(scope.nonce_placeholder_is_caller_wildcard,false);
 checkRef(scope.gate.complete_test_and_gate_suite);checkRef(scope.fixture_set.file);
 const suite=JSON.parse(fs.readFileSync(new URL(scope.gate.complete_test_and_gate_suite.path,root),'utf8'));
 assert.equal(Object.keys(suite.tests).length,19);
 for(const item of Object.values(suite.tests)){
  assert.equal(item.fixture_artifact_ref.sha256,scope.fixture_set.file.sha256);
  assert.equal(item.executor_artifact_ref.sha256,host.controller_source_manifest.sha256);
 }
});
