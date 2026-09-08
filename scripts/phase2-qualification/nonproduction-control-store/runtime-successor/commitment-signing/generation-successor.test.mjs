import assert from 'node:assert/strict';
import test from 'node:test';
import {makeCommitment,rootGeneration,project,audience} from './signing.mjs';
function raw(generation){return JSON.stringify({gate_authorization_id:'ga_generation_test',issuer_purpose:'GATE_AUTHORIZATION',audience,control_trust_root_generation:generation,schema_digest:'a'.repeat(64),signature:`urn:clued:gate-authorization:${project}:ga_generation_test#signature`})+'\n';}
test('prior generation cannot construct new-channel commitment',()=>{assert.throws(()=>makeCommitment(raw('ctrgen_352785779b64458a889d571360e2d2d5'),'GateAuthorization'),/purpose_audience_generation_mismatch/);});
test('exact proposed successor generation constructs only historical commitment data',()=>{assert.equal(rootGeneration,'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12');const value=makeCommitment(raw(rootGeneration),'GateAuthorization');assert.equal(value.root_generation,rootGeneration);assert.equal(value.authority_effect,'NONE');});
