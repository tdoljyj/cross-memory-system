import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {checkNotStarted} from '../not-started.mjs';
import {checkStoppedObservation} from '../grr.mjs';
import {fixture,sha} from './fixture.mjs';
test('synthetic in-memory nonPASS baseline checks exact reconciliation without claiming a formal result',()=>{assert.equal(checkNotStarted(fixture()).authority_effect,'NONE');});
test('failure provenance rejects missing or falsely labelled capture origin',()=>{for(const origin of [undefined,'USER_ASSERTED','ACTUAL_HOST_STDOUT'])assert.throws(()=>checkNotStarted(fixture(p=>{p.failure.original_output_origin=origin;})));assert.equal(checkNotStarted(fixture(p=>{p.failure.original_output_origin='ACTUAL_CAPTURED_PROCESS_OUTPUT';})).authority_effect,'NONE');});
const cases=[
 ['PASS',p=>p.receipt.result='PASS'],['nonempty tests',p=>p.receipt.test_results=[{test_id:'PQUAL-01',result:'PASS'}]],
 ['container bound',p=>p.state.attempts[0].container_id='a'.repeat(64)],['wrong active GA',p=>p.state.current.active_ga_id='ga_OTHER'],['nonunique GA',p=>p.state.attempts.push({...p.state.attempts[0]})],
 ['wrong root',p=>p.state.root.root_set_id='OTHER'],['old generation',p=>p.state.root.generation_id='ctrgen_OLD'],['wrong controller',p=>p.state.binding.controller_sha256='d'.repeat(64)],
 ['GA raw drift',p=>p.state.attempts[0].ga_raw+=' '],['not revoked',p=>p.state.attempts[0].revoked=false],
 ...['INTENT_RECORDED','CREATE_SENT','CREATED','START_SENT','RUNNING','STOP_SENT','STOPPED','RECONCILED_CONTAINER'].map(operation=>[operation+' history',p=>{const event={root_id:p.state.binding.root_id,sequence:1,request:{ga_id:p.ga.gate_authorization_id,operation},recorded_at:'2026-09-08T12:00:01Z'};p.state.events.unshift(event);p.sql.execution.events.unshift(structuredClone(event));}]),
 ['wrong host GA',p=>p.docker.ga_id='ga_OTHER'],['host wrong hash',p=>p.docker.ga_sha256='d'.repeat(64)],['wrong nonce',p=>p.docker.nonce='0'.repeat(32)],['wrong CLI',p=>p.docker.cli_sha256='0'.repeat(64)],['wrong endpoint',p=>p.docker.arguments[1]='tcp://elsewhere'],['unanchored name filter',p=>p.docker.arguments[6]='name=clued'],
 ['host failed',p=>p.docker.exit_code=1],['host error',p=>p.docker.error='failure'],['host signal',p=>p.docker.signal='TERM'],['container output',p=>p.docker.stdout='{}'],['directory exists',p=>p.docker.directory_exists=true],['host mutated',p=>p.docker.host_mutations=1],['fake stop',p=>p.proof.stop_action_performed=true],
 ['host before GA',p=>p.docker.started_at='2026-09-08T11:59:00Z'],['host after proof',p=>p.docker.ended_at='2026-09-08T12:00:08Z'],
 ['wrong failure original hash',p=>p.failure.original_output_sha256='d'.repeat(64)],['wrong failure GA',p=>p.failure.ga_id='ga_OTHER'],['wrong reviewer',p=>p.review.independent_reviewer='/root'],['no reason',p=>p.review.reason=''],
 ['refund seconds',p=>p.state.current.charged_seconds--],['refund bytes',p=>p.state.current.charged_evidence_bytes--],['new budget',p=>p.state.current.pending_budget_sequence=5],
 ['old snapshot root',p=>p.sql.execution.root.generation_id='ctrgen_OLD'],['old snapshot controller',p=>p.sql.execution.binding.controller_sha256='d'.repeat(64)]
];
for(const [name,change]of cases)test('reject '+name+' with recomputed transport hashes',()=>assert.throws(()=>checkNotStarted(fixture(change))));
test('original recorded complete STOP remains valid; absence inventory is not STOP',()=>{
 const bytes=fs.readFileSync(new URL('../../docker-engineering-observation/work/observation/main-after-stop.stdout',import.meta.url));assert.equal(sha(bytes),'2481ef1f263a714083f51cfa4f213bf43f0df0a071ce54bf7de5b3c56b781f82');const [actual]=JSON.parse(bytes);assert.equal(checkStoppedObservation(actual,actual.Id).state,'EXACT_STOP_FIELDS_CHECKED_NOT_AUTHORITY');assert.throws(()=>checkStoppedObservation({directory_exists:false},actual.Id));
});
