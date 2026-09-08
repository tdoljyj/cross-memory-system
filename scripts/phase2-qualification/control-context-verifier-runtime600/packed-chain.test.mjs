import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {packOriginalInputs} from '../scenario-observations/request-denials-packed.mjs';
import {checkPackedObservationChains} from './result-terminal.mjs';
const raw=x=>JSON.stringify(x)+'\n',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('synthetic shared input is actually decoded at terminal; missing/cross-GA/cross-test/original-byte drift rejects',()=>{
 const gaRaw=raw({synthetic:true,value:'baseline'}),changedRaw=raw({synthetic:true}),observationRaw=raw({synthetic:true});
 const originalRaw=raw({kind:'ACTUAL_VERIFIER_ORIGINAL_INPUTS',ga_raw:gaRaw,observation_raw:observationRaw,runtime_acceptance_raw:raw({synthetic:true}),qualification_raw:raw({synthetic:true})});
 const ref={uri:'urn:synthetic:'+sha(originalRaw),sha256:sha(originalRaw)},packed=packOriginalInputs({...ref,raw:originalRaw});
 const source=raw({kind:'ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION',test_id:'PQUAL-02',original_inputs_ref:ref,fault_input_changes:[{op:'remove',path:'/ga/value'}],called_input_digests:{ga_raw:sha(changedRaw),runtime_acceptance_raw:sha(raw({synthetic:true})),qualification_raw:sha(raw({synthetic:true}))},actual_entry:'control-context-verifier-runtime600/context.mjs#checkCurrentSemantics',actual_current_observation_sha256:sha(observationRaw),baseline_ga_sha256:sha(gaRaw)});
 const observation=raw({kind:'ACTUAL_TEST_OBSERVATION',source:{raw:source}}),item={uri:'urn:synthetic:'+sha(observation),sha256:sha(observation),raw:observation};
 const index={artifacts:[packed,item],tests:[{test_id:'PQUAL-02',observation_refs:[{uri:item.uri,sha256:item.sha256}]}]};
 assert.equal(checkPackedObservationChains(index,sha(gaRaw)).checked,1);
 assert.throws(()=>checkPackedObservationChains(index,'0'.repeat(64)));
 for(const change of [x=>x.artifacts.shift(),x=>x.tests[0].test_id='PQUAL-03',x=>{const p=JSON.parse(x.artifacts[0].raw);p.original_bytes++;x.artifacts[0].raw=raw(p);}]){const x=structuredClone(index);change(x);assert.throws(()=>checkPackedObservationChains(x,sha(gaRaw)));}
});
