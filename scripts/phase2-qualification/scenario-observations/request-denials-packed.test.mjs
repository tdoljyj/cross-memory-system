import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {packOriginalInputs,decodeOriginalInputs,validatePackedDenialSource} from './request-denials-packed.mjs';
const raw=x=>JSON.stringify(x)+'\n',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
// Synthetic serialization inputs only. No actual GA, SQL observation, or PQUAL result is created here.
function fixture(){
 const ga={synthetic_format_test:true,field:'original'},runtime={fixture:'unqualified'},qualification={fixture:'unqualified'};
 const original=raw({kind:'ACTUAL_VERIFIER_ORIGINAL_INPUTS',ga_raw:raw(ga),observation_raw:raw({synthetic:true}),runtime_acceptance_raw:raw(runtime),qualification_raw:raw(qualification)});
 const ref={uri:'urn:clued:execution-evidence:synthetic-format-fixture:'+sha(original),sha256:sha(original)};
 const changed={...ga,field:'changed'};
 const source={kind:'ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION',test_id:'PQUAL-12',original_inputs_ref:ref,
  fault_input_changes:[{op:'replace',path:'/ga/field',value:'changed'}],
  called_input_digests:{ga_raw:sha(raw(changed)),runtime_acceptance_raw:sha(raw(runtime)),qualification_raw:sha(raw(qualification))},
  actual_entry:'control-context-verifier-runtime600/context.mjs#checkCurrentSemantics',actual_current_observation_sha256:sha(raw({synthetic:true})),baseline_ga_sha256:sha(raw(ga))};
 return {original,ref,source,packed:packOriginalInputs({...ref,raw:original})};
}
test('lossless original source and deterministic measured input reconstruction',()=>{
 const x=fixture();assert.equal(raw(decodeOriginalInputs(x.packed.raw,x.ref)),x.original);
 assert.equal(validatePackedDenialSource({packedRaw:x.packed.raw,sourceRaw:raw(x.source)}).state,'ORIGINAL_MEASURED_INPUT_BYTES_RESTORED');
 assert.equal(validatePackedDenialSource({packedRaw:x.packed.raw,sourceRaw:raw(x.source)}).oracle_pass_claimed,false);
});
test('changed original bytes or recorded mutation never retain valid source binding',()=>{
 const x=fixture(),p=JSON.parse(x.packed.raw);p.original_bytes++;
 assert.throws(()=>decodeOriginalInputs(raw(p),x.ref),/EXACT_ORIGINAL_BYTE_RESTORATION/);
 x.source.fault_input_changes[0].value='unobserved';
 assert.throws(()=>validatePackedDenialSource({packedRaw:x.packed.raw,sourceRaw:raw(x.source)}),/EXACT_ACTUALLY_CALLED_INPUTS/);
});
test('resource bounds and prototype writes reject before decoding or reconstruction',()=>{
 const x=fixture(),p=JSON.parse(x.packed.raw);p.original_bytes=1048577;
 assert.throws(()=>decodeOriginalInputs(raw(p),x.ref),/BOUNDED_ORIGINAL_LENGTH/);
 x.source.fault_input_changes=[{op:'add',path:'/__proto__/unexpected',value:true}];
 assert.throws(()=>validatePackedDenialSource({packedRaw:x.packed.raw,sourceRaw:raw(x.source)}),/NO_PROTOTYPE_PATH/);
 assert.equal({}.unexpected,undefined);
});
